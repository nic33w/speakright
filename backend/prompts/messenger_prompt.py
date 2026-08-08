"""Messenger prompt assembly — lives in prompts/ next to the template files it
loads (chat_system_prompt.txt, templates/student_model.txt, persona/*.json).

build_layered_prompt returns (system_prompt, user_message); llm_call joins them
with a blank line into the single wire string sent to OpenAI.
"""
from typing import Any, Dict, List

from profile_store import load_helper_json, load_persona_json
from prompt_fragments import quiz_candidate_rules
from settings import ENABLE_QUIZZING, PERSONA, PROMPTS_DIR

# Prompt profiles. Each one gets its own static prefix (and therefore its own
# OpenAI prompt-cache entry); the prefix must stay byte-identical across turns
# *within* a version. See PROMPTS.md.
#   v1       — standard 70/30 language-mix reply
#   v2       — reply + hover-reveal target-language challenge sentence (UI default)
#   eyesfree — screen off: the whole turn is a serial audio stream, so it is cut
#              down to one reaction + one short target sentence, no suggestions
PROMPT_VERSIONS = ("v1", "v2", "eyesfree")
DEFAULT_PROMPT_VERSION = "v1"


# The whole-turn JSON budget. A turn is not just the character's reply: it also
# carries corrected_input, user_translation, error_explanation, two suggested
# replies, and on every 5th turn a level_assessment. 800 is the pre-5.0 value
# that this is known to fit in.
MIN_TURN_OUTPUT_TOKENS = 800


def get_persona_tuning() -> Dict[str, Any]:
    """Sampling params for the active persona (task 5.0).

    Reads meta.temperature and tuning.max_tokens from the persona JSON, falling
    back to the pre-5.0 defaults (temperature 0.2, MIN_TURN_OUTPUT_TOKENS) when a
    persona doesn't declare them.

    A persona's `tuning.max_tokens` can only ever RAISE the output cap, never
    lower it. It describes how long the character talks — Jorge declares 140 —
    whereas max_output_tokens caps the entire JSON envelope. 5.0 wired the two
    together, and the result was that every real turn got truncated mid-JSON:
    the reply bubbles still rendered (response_chunks is the first field, so the
    stream scanner had them before the cutoff) and then the final parse failed,
    which surfaced as "Failed to send message" with no audio. Reply length is a
    prompt concern, not a token-limit concern.
    """
    persona_data = load_persona_json(PERSONA) or {}
    meta = persona_data.get("meta", {})
    tuning = persona_data.get("tuning", {})
    declared = tuning.get("max_tokens") or 0
    return {
        "temperature": meta.get("temperature", 0.2),
        "max_output_tokens": max(int(declared), MIN_TURN_OUTPUT_TOKENS),
    }


def normalize_prompt_version(version: Any) -> str:
    """Map anything unrecognized onto v1.

    Guards the cache invariant from the other direction: an unknown version must
    reuse an existing prefix rather than silently minting a fourth variant.
    """
    return version if version in PROMPT_VERSIONS else DEFAULT_PROMPT_VERSION


def build_conversation_context(recent_turns: List[Dict[str, Any]]) -> str:
    """Build conversation context from recent turns (last 3)."""
    if not recent_turns:
        return "CONVERSATION CONTEXT: (This is the first turn)"

    lines = ["CONVERSATION CONTEXT (recent turns):"]
    for turn in recent_turns[-3:]:
        lines.append(f"  User: {turn['user_input']}")
        if turn.get('corrected_input') and turn['user_input'] != turn['corrected_input']:
            lines.append(f"  Corrected: {turn['corrected_input']}")

    return "\n".join(lines)


def active_scene(profile: Dict[str, Any]) -> Dict[str, Any]:
    """The profile's scene if it is running and usable, else {}.

    One gate for both the scene block and its pacing line: a scene missing its
    goal or its ending is dropped entirely rather than half-rendered, since a
    premise that can never resolve is worse than plain conversation.
    """
    scene = profile.get("scene") or {}
    if scene.get("status") != "active":
        return {}
    if not scene.get("character_goal") or not scene.get("completion_condition"):
        return {}
    return scene


def build_scene_context(profile: Dict[str, Any], character_name: str) -> str:
    """Render the active scene into a prompt block (task 5.1).

    Returns "" when there is no active scene — pre-5.1 profiles, a dimensions
    file that failed to load, or the gap after a scene completes but before the
    router has built the next one. The rest of the prompt has to read correctly
    without this block, so it is a clean omission rather than a placeholder.

    DYNAMIC TAIL ONLY. The static prefix must never learn about a specific
    scene, or every scene change mints a new prompt-cache prefix.
    """
    scene = active_scene(profile)
    if not scene:
        return ""

    fields = {
        "character_name": character_name,
        "setting": scene.get("setting", ""),
        "character_goal": scene.get("character_goal", ""),
        "user_goal": scene.get("user_goal", ""),
        "complication": scene.get("complication", ""),
        "completion_condition": scene.get("completion_condition", ""),
    }

    scene_file = PROMPTS_DIR / "templates" / "scene.txt"
    if scene_file.exists():
        block = scene_file.read_text(encoding="utf-8")
    else:
        block = """CURRENT SCENE — this conversation is a scene with an ending, not an open-ended chat:
- Where you are: {{setting}}
- What {{character_name}} wants: {{character_goal}}
- What the learner is after: {{user_goal}}
- Complication: {{complication}}
- The scene is over once: {{completion_condition}}
Play it in character and never narrate or explain the scene to the learner."""

    for key, value in fields.items():
        block = block.replace("{{" + key + "}}", value)
    return block.rstrip()


def build_secret_context(profile: Dict[str, Any], character_name: str) -> str:
    """Render the secret block for an information-asymmetry scene (task 5.3).

    Returns "" for any scene that isn't a secret scene, or one that lost its
    secret and got demoted (see profile_store.new_scene) — same clean-omission
    rule as the scene and character-state blocks.

    DYNAMIC TAIL ONLY, like everything else about a specific scene.
    """
    scene = active_scene(profile)
    if scene.get("type") != "secret" or not scene.get("secret"):
        return ""

    fields = {"character_name": character_name, "secret": scene["secret"]}

    template_file = PROMPTS_DIR / "templates" / "secret.txt"
    if template_file.exists():
        block = template_file.read_text(encoding="utf-8")
    else:
        block = """THE SECRET — this scene runs on what only you know:
- What you know: {{secret}}
- The learner does not know it. Getting you to say it is the whole scene.
Never state it outright until the SCENE PACING block says to, never lie about it, and react like
you got caught the moment they name it."""

    for key, value in fields.items():
        block = block.replace("{{" + key + "}}", value)
    return block.rstrip()


def _secret_pacing(scene: Dict[str, Any], current: int, budget: int) -> str:
    """Pacing body for a secret scene (task 5.3).

    A different clock from a standard scene: the learner can end this one early
    by naming the secret, so the budget is a *deadline* for the character to give
    it up rather than a schedule for resolving a situation. Clues escalate toward
    that deadline so the scene can't end with the learner having learned nothing.
    """
    if scene.get("secret_solved"):
        return (
            "- THEY JUST NAMED IT. The scene ends here, this turn.\n"
            f"- Confirm it — it really is \"{scene.get('secret', '')}\" — and react like someone "
            "who has just been caught out. Do not deny it, do not stall, do not make them say it "
            "twice.\n"
            "- Then let it land: no new hook, no next scheme, nothing to extract."
        )
    if current >= budget:
        return (
            "- FINAL turn: they have run out of chances, so YOU say it. Out loud, plainly, in this "
            "reply.\n"
            f"- Tell them it was \"{scene.get('secret', '')}\" — grudgingly, dramatically, however "
            "fits you, but actually tell them.\n"
            "- A secret you never give up is a scene the learner cannot tell they finished. End it."
        )
    if current >= budget - 1:
        return (
            "- One turn left after this. Give them a clue that all but names it — the most specific "
            "thing you can say without saying the thing.\n"
            "- Make it obvious you are on the edge of telling them."
        )
    if current == 1:
        return (
            "- Open by making it unmistakable that you are holding something back, without hinting "
            "at what it is yet.\n"
            "- Invite the questions: say something they will want to pull on."
        )
    return (
        "- Middle of the scene: leak exactly ONE new concrete detail this turn, and only if they "
        "asked something worth answering.\n"
        "- Never repeat a clue you have already given — repeating one is the same as stalling, and "
        "they cannot narrow anything down with it.\n"
        "- Keep dodging the thing itself. They have to name it; you do not hand it over."
    )


def scene_progress_instruction(profile: Dict[str, Any]) -> str:
    """The pacing line for this turn: where the scene is, and what to do about it.

    An arc the model can't see the clock on is just a premise, so the turn number
    and the budget are stated outright. Note turns_elapsed counts *completed*
    turns (routers.messenger advances it in _finalize_turn), so the turn being
    written right now is turns_elapsed + 1.
    """
    scene = active_scene(profile)
    if not scene:
        return ""

    budget = scene.get("turn_budget", 7)
    current = scene.get("turns_elapsed", 0) + 1
    header = f"SCENE PACING — turn {min(current, budget)} of {budget} in this scene:"

    if scene.get("type") == "secret" and scene.get("secret"):
        return f"{header}\n{_secret_pacing(scene, current, budget)}"

    if current >= budget:
        body = (
            "- This is the FINAL turn of the scene. End it here.\n"
            f"- \"{scene.get('completion_condition', '')}\" must actually happen in THIS reply — "
            "state it, do it, land it.\n"
            "- No cliffhanger, no new hook, no \"we'll talk later\". A scene that gets postponed "
            "never happened.\n"
            "- Your last chunk still gives the learner something to say back, but it closes this "
            "situation rather than opening another one."
        )
    elif current >= budget - 1:
        body = (
            "- One turn left after this one. Everything now points at the ending.\n"
            f"- Set up \"{scene.get('completion_condition', '')}\" so it can land next turn: force "
            "the question, make the ask, drop the pretense.\n"
            "- Do not introduce anything new."
        )
    elif current == 1:
        body = (
            "- The scene has just started. Open it by playing it, not by describing it — walk in "
            "mid-situation.\n"
            "- Show the learner what you want without stating the goal outright, and give them an "
            "obvious way in."
        )
    else:
        body = (
            "- Middle of the scene: push it forward. Pursue your goal harder than last turn and let "
            "the complication get in the way.\n"
            "- Do not stall, repeat the setup, or reset the situation — something must be different "
            "at the end of this reply than at the start of it."
        )
    return f"{header}\n{body}"


def build_character_state_context(profile: Dict[str, Any], character_name: str) -> str:
    """Render persistent character state into a prompt block (task 5.2).

    Returns "" when no scene has completed yet — a fresh profile has nothing to
    carry forward, and that has to render as a clean omission, not a blank
    gap (same rule as build_scene_context).

    DYNAMIC TAIL ONLY. The static prefix must never learn about a specific
    character state, or every scene completion mints a new prompt-cache prefix.
    """
    state = profile.get("character_state") or {}
    situation = state.get("situation", "")
    if not situation:
        return ""

    fields = {
        "character_name": character_name,
        "situation": situation,
        "mood": state.get("mood") or "",
        "energy": state.get("energy") or "",
    }

    template_file = PROMPTS_DIR / "templates" / "character_state.txt"
    if template_file.exists():
        block = template_file.read_text(encoding="utf-8")
    else:
        block = """CHARACTER CONTINUITY — carried over from your last scene:
- What was going on: {{situation}}
- Your mood since then: {{mood}}
- Your energy right now: {{energy}}
If it fits naturally, drop in a callback — you remember this, the learner might not."""

    for key, value in fields.items():
        block = block.replace("{{" + key + "}}", value)
    return block.rstrip()


def generate_turn_instruction(profile: Dict[str, Any]) -> str:
    """Generate turn instruction based on turn count and level."""
    turn_count = profile.get("turn_count", 0)
    level = profile.get("level", "beginner")
    corrections_needed = profile.get("corrections_needed", 0)

    # Every 5th turn: deep assessment
    if turn_count > 0 and turn_count % 5 == 0:
        return f"""ASSESSMENT TURN (turn #{turn_count}):
- Carefully evaluate user's target language proficiency based on recent turns
- Current level: {level}
- Recent performance: {corrections_needed}/{turn_count} turns needed correction
- Look for: grammar accuracy, vocabulary range, fluency, complexity
- INCLUDE the "level_assessment" field defined in the OUTPUT SCHEMA in your JSON response this turn
- Set should_update=true if confident about level change (confidence >= 0.7)
- Update comfortable_with and weak_points based on observed patterns"""

    # Regular turn: light assessment + adaptive response
    return f"""Current learner level: {level}
- Provide a natural persona response: 3 chunks, every one pure target-language audio, one sentence each
- Respond to the user's intended meaning — do NOT correct or mention errors in your response_chunks
- Do NOT include the "level_assessment" field this turn
- Decide response mode per chunk: use target audio for new vocab/patterns appropriate to level"""


def build_layered_prompt(user_input: str, profile: Dict[str, Any], prompt_version: str = "v1") -> tuple:
    """
    Build layered prompt following user's design:
    1. System Prompt (chat_system_prompt.txt)
    2. Persona Prompt (persona/[name].json)
    3. Student Model (templates/student_model.txt)
    4. Conversation Context (recent turns)
    5. Turn Instruction

    Returns: (system_prompt, user_message)
    """
    prompt_version = normalize_prompt_version(prompt_version)
    ui_lang = profile.get("ui_language", {}).get("name", "English")
    ui_code = profile.get("ui_language", {}).get("code", "en")
    target_lang = profile.get("target_language", {}).get("name", "Spanish")
    target_code = profile.get("target_language", {}).get("code", "es")

    # Load persona JSON
    persona_data = load_persona_json(PERSONA)
    if not persona_data:
        raise ValueError(f"Persona '{PERSONA}' not found")
    character_name = persona_data["meta"]["display_name"]

    # Load helper configurations
    suggestion_config = load_helper_json("suggestion_system") or {}

    # Layer 1: System Prompt
    system_file = PROMPTS_DIR / "chat_system_prompt.txt"
    if system_file.exists():
        system_base = system_file.read_text(encoding='utf-8')
        system_filled = system_base.replace("{{ui_language}}", ui_lang)
        system_filled = system_filled.replace("{{target_language}}", target_lang)
    else:
        # Fallback if prompt file missing
        system_filled = f"""You are a conversational language-learning partner.
The learner's UI language is {ui_lang} and they are learning {target_lang}.
Every response_chunk is pure {target_lang}, spoken aloud — the learner gets {ui_lang} translations separately, on request.
Correct errors gently and adapt to learner's level."""

    # Layer 2: Persona Prompt (from JSON)
    persona_bio = persona_data.get("short_bio", {}).get(ui_code, "")
    persona_voice_notes = persona_data.get("voice_notes", {})

    persona_prompt = f"""CHARACTER: {persona_data['meta']['display_name']}
{persona_bio}

PERSONALITY RULES (CRITICAL - YOU MUST FOLLOW THESE):
- You speak ONLY {target_lang}. Every response_chunk is {target_lang} — your snark, humor and reactions all come through in {target_lang}, never in {ui_lang}.
- Write casual, natural {target_lang} that a native would actually say. Not textbook {target_lang}, and not simplified to death.
- The learner gets {ui_lang} translations separately, on request. NEVER put {ui_lang} in a response_chunk to help them — that is handled outside your reply.
- DO: {', '.join(persona_voice_notes.get('do_en', []))}
- DON'T: {', '.join(persona_voice_notes.get('dont_en', []))}
- {persona_voice_notes.get('language_guidance', '')}

EXAMPLE GREETINGS (in {target_lang}):
"""
    # Persona examples are target-language only now. Falling back to the UI-language
    # variants would show the character speaking {ui_lang}, contradicting the rule
    # above — better to omit a section than to demonstrate the wrong thing.
    greetings = persona_data.get("example_greetings", {}).get(target_code, [])
    for greeting in greetings[:2]:
        persona_prompt += f"- {greeting}\n"

    if persona_data.get("examples"):
        example_lines = [
            ex.get("persona_line", {}).get(target_code, "")
            for ex in persona_data["examples"][:2]
        ]
        example_lines = [line for line in example_lines if line]
        if example_lines:
            persona_prompt += f"\nEXAMPLE INTERACTION STYLE (show personality IN {target_lang}):\n"
            for line in example_lines:
                persona_prompt += f"- \"{line}\"\n"

    # Few-shot dialogue: only turns already written in the target language. A turn
    # labelled (in en) would be a worked example of exactly what we just forbade.
    if persona_data.get("few_shot_examples"):
        shots = []
        for fs in persona_data["few_shot_examples"][:2]:
            turns = [t for t in fs.get("dialogue", [])
                     if t.get("who") and t.get("text") and t.get("lang") == target_code]
            if turns:
                shots.append((fs.get("scenario", ""), turns))
        if shots:
            persona_prompt += f"\nFEW-SHOT DIALOGUE EXAMPLES:\n"
            for scenario, turns in shots:
                if scenario:
                    persona_prompt += f"Scenario: {scenario}\n"
                for turn in turns:
                    persona_prompt += f"  {turn['who']}: \"{turn['text']}\"\n"

    # Reaction bank (persona-specific, static within a run): forces response_chunks[0]
    # to be picked verbatim from a closed set so it can be served from pre-generated
    # audio with zero latency/cost instead of live TTS. See scripts/generate_reaction_audio.py.
    reaction_bank_section = ''
    reactions = persona_data.get("reactions", {}).get(target_code, [])
    if reactions:
        reaction_lines = "\n".join(f'- "{r["text"]}"' for r in reactions if r.get("text"))
        reaction_bank_section = f"""REACTION OPENERS — CLOSED SET:
response_chunks[0] MUST be chosen verbatim, word-for-word, from the list below (language="target", modality="audio", purpose="reaction"). Pick whichever line best matches how {character_name} would react to what the user just said. Do not alter, translate, paraphrase, or invent a new line — copy one exactly as written, including punctuation. Continue your actual reply normally starting at response_chunks[1].
{reaction_lines}"""

    # Layer 3: Student Model
    student_file = PROMPTS_DIR / "templates" / "student_model.txt"
    if student_file.exists():
        student_template = student_file.read_text(encoding='utf-8')
        comfortable_str = "\n".join([f"  - {p}" for p in profile.get("comfortable_with", [])])
        weak_str = "\n".join([f"  - {p}" for p in profile.get("weak_points", [])])
        avoid_str = "\n".join([f"  - {p}" for p in profile.get("avoid_topics", [])])

        student_context = student_template.replace("{{ui_language}}", ui_lang)
        student_context = student_context.replace("{{target_language}}", target_lang)
        student_context = student_context.replace("{{comfortable_points}}", comfortable_str or "  (none yet)")
        student_context = student_context.replace("{{weak_points}}", weak_str or "  (none yet)")
        student_context = student_context.replace("{{avoid_points}}", avoid_str or "  (none yet)")
    else:
        student_context = f"Learner level: {profile.get('level', 'beginner')}"

    # Layer 4: Persistent character state (dynamic — task 5.2; empty until a
    # scene has completed at least once)
    character_state_context = build_character_state_context(profile, character_name)

    # Layer 5: Scene (dynamic — task 5.1; empty when no scene is active) plus
    # its secret, for information-asymmetry scenes (task 5.3)
    scene_context = build_scene_context(profile, character_name)
    secret_context = build_secret_context(profile, character_name)
    scene_pacing = scene_progress_instruction(profile)

    # Layer 6: Conversation Context (dynamic)
    context_str = build_conversation_context(profile.get("recent_turns", []))

    # Layer 7: Turn Instruction (dynamic)
    turn_instruction = generate_turn_instruction(profile)
    if prompt_version == "v2":
        # The V2 block lives in the static prefix (for prompt caching); this
        # end-of-prompt reminder keeps it salient — without it the model tends
        # to drift back toward writing {ui_lang} chunks.
        turn_instruction += "\n- FOLLOW THE V2 CHALLENGE FORMAT defined above: every chunk is pure {target} audio; the LAST chunk is the challenge sentence and carries \"native_text\" and \"is_challenge\": true".format(
            target=target_lang)
    elif prompt_version == "eyesfree":
        # Same reason as v2: the format block is in the static prefix, and without
        # an end-of-prompt reminder the model drifts back to the language-mix format.
        turn_instruction += "\n- FOLLOW THE EYES-FREE FORMAT defined above: EXACTLY 2 chunks (the verbatim reaction opener, then the {target} audio sentence with \"native_text\" and \"is_challenge\": true), \"suggested_replies\": [], and \"error_explanation\" as one short spoken sentence".format(
            target=target_lang)

    max_suggestions = suggestion_config.get("max_suggestions", 2)

    # ------------------------------------------------------------------
    # STATIC PREFIX (system prompt): everything here must stay byte-identical
    # across turns for a fixed run config (persona + language pair +
    # ENABLE_QUIZZING + prompt_version) so OpenAI's automatic prompt caching
    # discounts it. NEVER insert per-turn content before the dynamic tail —
    # the prompt-prefix test in tests/test_prompt_snapshot.py enforces this.
    # ------------------------------------------------------------------

    if ENABLE_QUIZZING:
        quiz_candidates_schema = '  "quiz_candidates": [\n    {\n      "type": "correction" | "translation" | "naturalness",\n      "original": "...",\n      "corrected": "...",\n      "error_type": "...",\n      "quiz_prompt": "..."\n    }\n  ],'
        quiz_rules_section = quiz_candidate_rules(ui_lang, target_lang).lstrip("\n")
    else:
        quiz_candidates_schema = ''
        quiz_rules_section = ''

    # level_assessment is always described in the schema; inclusion is gated by
    # the TURN INSTRUCTION (every 5th turn), keeping the schema text static.
    schema_section = f"""OUTPUT SCHEMA (return exactly one JSON object):
EMIT THE FIELDS IN EXACTLY THE ORDER SHOWN BELOW. "response_chunks" MUST come first — the app
streams your reply to the learner as you write it, so any field placed before it delays the whole
conversation. Do not reorder, and do not repeat a field later in the object.
{{
  "response_chunks": [
    {{
      "text": "...",  // PURE {target_lang}, always. Every chunk. Zero {ui_lang} words.
      "language": "target",  // ALWAYS "target" — you no longer write {ui_lang} chunks at all
      "modality": "audio",   // ALWAYS "audio" — every chunk is spoken
      "locale": "{target_code}-XX",  // always the target locale
      "purpose": "reaction" | "greeting" | "question" | "feedback" | "encouragement"  // "reaction" is REQUIRED for response_chunks[0] — see REACTION OPENERS above
    }}
  ],
  "corrected_input": "...",  // The corrected or naturalized version of what the user said. CRITICAL: If had_errors=true, corrected_input MUST be different from the user's input — it must contain the natural/correct {target_lang} version. NEVER leave corrected_input the same as the user's input when had_errors=true. Rules: (1) Fix grammar errors. (2) If phrasing is unnatural, replace the whole phrase with what a native speaker would actually say — even completely different words, same meaning. (3) NEVER make it a response or answer to a question. (4) Copy exactly only when had_errors=false.
  "user_translation": "...",  // {ui_lang} translation of corrected_input. Always provide.
  "had_errors": true/false,  // true if grammar is wrong OR phrasing is not how a native speaker would say it. STRICT RULE: if you had to change corrected_input at all, had_errors must be true. Cases that MUST be flagged: false cognates (e.g. "gaseoso" does NOT mean feeling gassy — it means carbonated/fizzy; correct: "me va a dar gases"), word-for-word translations of English body sensations/idioms/emotions (almost never translate literally), invented words from English roots. CONCRETE EXAMPLE: user says "eso me hará sentir gaseoso" → had_errors=true, corrected_input="Eso me va a dar gases." false ONLY when a native speaker would say it exactly as written.
  "error_severity": "none" | "minor" | "major",  // How much the error actually costs the learner — this decides whether the app interrupts them to practise it out loud, so be strict. "none" whenever had_errors=false. "major" = it would confuse a native speaker or cement a wrong pattern: wrong verb form/tense/mood, wrong word or false cognate, an invented word, a missing or wrong preposition that changes the meaning, or English word order a native would never use. "minor" = a native understands instantly and it is only polish: a more idiomatic option exists, slightly odd but grammatical word order, a mild register mismatch. Accents, punctuation, capitalization and obvious speech-to-text artifacts are NEVER "major". When torn between minor and major, choose "minor" — a wrongly skipped drill is cheap, a wrong interruption is not.
  "error_explanation": "...",  // Brief explanation in {ui_lang}. Only needed if had_errors=true. For naturalness/false-cognate issues, give the natural native expression and briefly explain why (e.g. "'Gaseoso' means carbonated/fizzy — natives say 'me da gases' for feeling gassy"). When the correction involves a verb, include the infinitive in parentheses after the conjugated form.
  "input_intent": "english" | "spanish",  // "english" = user was primarily speaking {ui_lang} (even with some {target_lang} mixed in). "spanish" = user was primarily attempting {target_lang} (even if they dropped in {ui_lang} words they didn't know). Judge by INTENT, not word count.
  "suggested_replies": [
    {{
      "id": "r1",
      "text_target": "...",  // Natural {target_lang} phrasing — write this first
      "text_native": "..."   // {ui_lang} translation of text_target
    }}
  ],
{quiz_candidates_schema}
  "level_assessment": {{  // INCLUDE this field ONLY when the TURN INSTRUCTION (near the end of this prompt) explicitly asks for a level assessment — omit it entirely on all other turns
    "current_level": "beginner" | "intermediate" | "advanced",
    "confidence": 0.0-1.0,
    "should_update": true/false,
    "reasoning": "1 short phrase — only required when should_update=true",
    "add_comfortable": [],
    "add_weak": [],
    "remove_weak": []
  }}
}}"""

    reminders_section = f"""CRITICAL REMINDERS:
- response_chunks[0] MUST be copied verbatim from the REACTION OPENERS list above (purpose="reaction") when that list is non-empty. Never write a custom line for chunk 0.
- FIELD ORDER IS LOAD-BEARING: emit "response_chunks" first, exactly as laid out in the OUTPUT SCHEMA. Before you write it, silently work out what the user actually meant and how their {target_lang} should be corrected — then write the reply first and record that correction in the later fields. Getting the reply out first is what keeps the conversation fast; it must not make the correction sloppier.
- EVERY response_chunk is language="target", modality="audio", and PURE {target_lang}. There are no {ui_lang} chunks any more — not for reactions, not for asides, not to help the learner.
- Default to exactly 3 chunks: the reaction opener, then two more sentences that carry the conversation. Fewer only if the reply genuinely fits in fewer.
- Keep each chunk to ONE spoken sentence. They are played as separate audio clips with a pause between them, so a chunk holding two sentences reads as a run-on.
- NEVER use target-language audio to repeat, paraphrase, or demonstrate the corrected version of what the user said. Audio must be an organic part of your character's own response — not a correction or teaching moment about the user's mistake.
- Stay in character! Your personality should come through IN {target_lang}.
- NEVER mention corrections or errors in your response_chunks. Respond as if the user spoke perfectly.
- Pico handles corrections separately via corrected_input/had_errors/error_explanation — fill those fields accurately but keep them out of your conversational response.
- input_intent: "english" if the user was primarily speaking {ui_lang} (even with some {target_lang} thrown in); "spanish" if the user was clearly attempting {target_lang} (even if they got stuck on words and used {ui_lang} for those). Example: "I went to the store today, gracias!" = "english". "Fui al store porque no tenía food" = "spanish"."""

    # Eyes-free never renders suggestions, so it replaces this section outright
    # rather than contradicting it further down — a prompt that says "generate 2"
    # and "generate none" gets the worst of both.
    if prompt_version == "eyesfree":
        suggestion_section = """SUGGESTION GENERATION RULES:
- Do not write suggestions in this mode. Emit "suggested_replies": [] — an empty array. See EYES-FREE FORMAT below."""
    else:
        suggestion_section = f"""SUGGESTION GENERATION RULES:
- Generate {max_suggestions} short replies THE USER would say TO {character_name} — phrased in first person, NOT things the character would say
- Write each suggestion naturally in {target_lang} first (text_target) — use phrasing a native {target_lang} speaker would actually say
- text_native is the {ui_lang} translation of text_target — translate naturally, not word-for-word
- Include exactly one of each type, in this fixed order:
    1. question — something the user asks {character_name} about the topic
    2. playful — something funny or teasing the user says to {character_name}
- Keep suggestions brief (5-10 words max)
- Sound like the user talking TO {character_name}, never like {character_name} talking"""

    # V2 override: challenge-last-sentence instructions (version-conditional but
    # static within a run; last in the prefix so v1/v2 share everything above it)
    v2_section = ''
    if prompt_version == "v2":
        v2_section = f"""V2 CHALLENGE FORMAT — REFINES the response_chunks rules above:
- Chunk count and language are unchanged: 3 chunks, all language="target", modality="audio", pure {target_lang}.
- The LAST chunk is additionally marked as the challenge — the sentence the learner is meant to answer:
  {{
    "text": "<natural {target_lang} sentence — PURE {target_lang} ONLY, absolutely zero {ui_lang} words>",
    "language": "target",
    "modality": "audio",
    "locale": "<appropriate locale for {target_lang}>",
    "native_text": "<{ui_lang} translation of the challenge sentence>",
    "is_challenge": true
  }}
- "native_text" is required on the challenge chunk ONLY. It backs the learner's hover-to-reveal, so it must always be there even though the other chunks have no translation.
- The "text" field must be ONLY the {target_lang} sentence itself — absolutely NO intro phrases, labels, or preamble in ANY language (e.g. not "Try this:", "¡Intenta decir esto!", "How about:", "Let's try:", etc.)
- Difficulty: the challenge sits slightly above the learner's current level — comprehensible input that stretches them a little. The earlier chunks stay comfortably at their level.
- The challenge should flow naturally as the conclusion of the reply, and it is the ONLY forward-moving piece: earlier chunks react and add colour, they do not ask their own follow-up question. Do not say the same thing twice in different words."""

    # Eyes-free override (version-conditional, static within a run; last in the
    # prefix so it has the final word over the language-mix and v2 rules).
    #
    # Why this is a separate profile and not "v2 + TTS": with the screen off the
    # turn becomes a strictly serial audio stream, so every field is a cost in
    # seconds. The v1/v2 output — three target-language sentences, an
    # explanation written to be read, plus 2 suggested replies — is ~40s of speech
    # per turn. Capping it at one reaction + one short target sentence gets that
    # under ~10s. Keeping chunk 0 the pre-generated reaction opener also keeps it
    # free and instant (see scripts/generate_reaction_audio.py) — a free-form
    # opener would cost a live Azure roundtrip on the one clip the learner is
    # waiting on before anything else can play.
    eyesfree_section = ''
    if prompt_version == "eyesfree":
        eyesfree_section = f"""EYES-FREE FORMAT — OVERRIDES the response_chunks, error_explanation and suggestion rules above:
The learner is listening with the screen off. Everything you write is spoken aloud, one field after another, and they cannot skim it, re-read it, or glance back at it. Length is the enemy — a long reply buries the one sentence they are supposed to answer.
- Emit EXACTLY 2 response_chunks. Never 1, never 3.
- Chunk 1 is the reaction opener: copied verbatim from the REACTION OPENERS list above when that list is present, otherwise one short {target_lang} reaction of 8 words or fewer. language="target", modality="audio", purpose="reaction". No setup, no second sentence, no follow-up question.
- Chunk 2 is the {target_lang} sentence the learner will hear and answer:
  {{
    "text": "<natural {target_lang} sentence — PURE {target_lang} ONLY, absolutely zero {ui_lang} words, 12 words maximum>",
    "language": "target",
    "modality": "audio",
    "locale": "{target_code}-XX",
    "native_text": "<{ui_lang} translation of that sentence — spoken only if the learner asks for it>",
    "is_challenge": true
  }}
- Chunk 2 is the ONLY thing carrying the conversation forward: it must both respond to what the learner said and give them something to answer. Its "text" is the sentence alone — no intro phrase, label, or preamble in ANY language (not "Try this:", not "¡A ver!", not "How about:").
- Difficulty: slightly above the learner's current level, but keep it short. Spoken language has no scrollback.
- "suggested_replies" MUST be [] — an empty array. They are never spoken in this mode, so writing them only delays the audio.
- "error_explanation" MUST be ONE sentence in {ui_lang}, 15 words or fewer, written to be HEARD rather than read: no quotation marks, no parentheses, no infinitive-in-parentheses, no lists, no abbreviations, no formatting of any kind. Give the natural version and the reason in a single breath — e.g. "Natives say me da gases there, because gaseoso means fizzy like a soda."
- "corrected_input" and "user_translation" are unchanged: fill them accurately. They are spoken on demand, not automatically, so they do not count against the length budget."""

    # Assemble the static prefix (system prompt)
    full_system = "\n\n".join(section for section in [
        system_filled,
        persona_prompt,
        reaction_bank_section,
        schema_section,
        reminders_section,
        quiz_rules_section,
        suggestion_section,
        v2_section,
        eyesfree_section,
    ] if section)

    # ------------------------------------------------------------------
    # DYNAMIC TAIL (user message): everything that changes per turn —
    # student model (mutable profile lists), persistent character state, the
    # active scene and its pacing, conversation context, turn instruction, and
    # the user's input. Empty sections are dropped rather than left as blank
    # gaps, so a profile with no scene/character state produces exactly the
    # pre-5.1 tail.
    # ------------------------------------------------------------------
    user_message = "\n\n".join(section for section in [
        student_context,
        character_state_context,
        scene_context,
        secret_context,
        context_str,
        turn_instruction,
        scene_pacing,  # last directive before the input: "resolve now" has to be loud
        f"CURRENT USER INPUT: {user_input}",
        "Return ONLY valid JSON (no markdown, no commentary).",
    ] if section)

    return full_system, user_message
