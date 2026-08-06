"""Messenger prompt assembly — lives in prompts/ next to the template files it
loads (chat_system_prompt.txt, templates/student_model.txt, persona/*.json).

build_layered_prompt returns (system_prompt, user_message); llm_call joins them
with a blank line into the single wire string sent to OpenAI.
"""
from typing import Any, Dict, List

from profile_store import load_helper_json, load_persona_json
from prompt_fragments import quiz_candidate_rules
from settings import ENABLE_QUIZZING, PERSONA, PROMPTS_DIR


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
- Provide natural persona response following language mix rules (70-80% UI, 15-25% target text, 5-10% target audio)
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
Provide responses following language mix rules: 70-80% UI language, 15-25% target language text, 5-10% target language audio.
Correct errors gently and adapt to learner's level."""

    # Layer 2: Persona Prompt (from JSON)
    persona_bio = persona_data.get("short_bio", {}).get(ui_code, "")
    persona_voice_notes = persona_data.get("voice_notes", {})

    persona_prompt = f"""CHARACTER: {persona_data['meta']['display_name']}
{persona_bio}

PERSONALITY RULES (CRITICAL - YOU MUST FOLLOW THESE):
- Express your personality IN {ui_lang}. Your snark, humor, and reactions should be in the UI language.
- Only use {target_lang} for teaching vocabulary, giving examples, or light flavor (not for your main conversational voice).
- DO: {', '.join(persona_voice_notes.get('do_en', []))}
- DON'T: {', '.join(persona_voice_notes.get('dont_en', []))}
- {persona_voice_notes.get('language_guidance', '')}

EXAMPLE GREETINGS (in {ui_lang}):
"""
    # Add example greetings - prefer UI language examples
    greetings = persona_data.get("example_greetings", {}).get(ui_code, []) or persona_data.get("example_greetings", {}).get(target_code, [])
    for greeting in greetings[:2]:
        persona_prompt += f"- {greeting}\n"

    # Add examples from persona - prefer UI language versions
    if persona_data.get("examples"):
        persona_prompt += f"\nEXAMPLE INTERACTION STYLE (show personality IN {ui_lang}):\n"
        for ex in persona_data["examples"][:2]:
            # Prefer UI language persona lines
            persona_line = ex.get("persona_line", {}).get(ui_code, "") or ex.get("persona_line", {}).get(target_code, "")
            if persona_line:
                persona_prompt += f"- \"{persona_line}\"\n"

    # Add few-shot examples if available
    if persona_data.get("few_shot_examples"):
        persona_prompt += f"\nFEW-SHOT DIALOGUE EXAMPLES:\n"
        for fs in persona_data["few_shot_examples"][:2]:
            scenario = fs.get("scenario", "")
            if scenario:
                persona_prompt += f"Scenario: {scenario}\n"
            for turn in fs.get("dialogue", []):
                who = turn.get("who", "")
                text = turn.get("text", "")
                lang = turn.get("lang", ui_code)
                if who and text:
                    persona_prompt += f"  {who}: \"{text}\" (in {lang})\n"

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

    # Layer 4: Conversation Context (dynamic)
    context_str = build_conversation_context(profile.get("recent_turns", []))

    # Layer 5: Turn Instruction (dynamic)
    turn_instruction = generate_turn_instruction(profile)
    if prompt_version == "v2":
        # The V2 block lives in the static prefix (for prompt caching); this
        # end-of-prompt reminder keeps it salient — without it the model tends
        # to fall back to the regular language-mix format.
        turn_instruction += "\n- FOLLOW THE V2 CHALLENGE FORMAT defined above: all chunks except the last are {ui} text; the LAST chunk is the {target} audio challenge sentence with \"native_text\" and \"is_challenge\": true".format(
            ui=ui_lang, target=target_lang)

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
{{
  "corrected_input": "...",  // The corrected or naturalized version of what the user said. CRITICAL: If had_errors=true, corrected_input MUST be different from the user's input — it must contain the natural/correct {target_lang} version. NEVER leave corrected_input the same as the user's input when had_errors=true. Rules: (1) Fix grammar errors. (2) If phrasing is unnatural, replace the whole phrase with what a native speaker would actually say — even completely different words, same meaning. (3) NEVER make it a response or answer to a question. (4) Copy exactly only when had_errors=false.
  "user_translation": "...",  // {ui_lang} translation of corrected_input. Always provide.
  "had_errors": true/false,  // true if grammar is wrong OR phrasing is not how a native speaker would say it. STRICT RULE: if you had to change corrected_input at all, had_errors must be true. Cases that MUST be flagged: false cognates (e.g. "gaseoso" does NOT mean feeling gassy — it means carbonated/fizzy; correct: "me va a dar gases"), word-for-word translations of English body sensations/idioms/emotions (almost never translate literally), invented words from English roots. CONCRETE EXAMPLE: user says "eso me hará sentir gaseoso" → had_errors=true, corrected_input="Eso me va a dar gases." false ONLY when a native speaker would say it exactly as written.
  "error_explanation": "...",  // Brief explanation in {ui_lang}. Only needed if had_errors=true. For naturalness/false-cognate issues, give the natural native expression and briefly explain why (e.g. "'Gaseoso' means carbonated/fizzy — natives say 'me da gases' for feeling gassy"). When the correction involves a verb, include the infinitive in parentheses after the conjugated form.
  "input_intent": "english" | "spanish",  // "english" = user was primarily speaking {ui_lang} (even with some {target_lang} mixed in). "spanish" = user was primarily attempting {target_lang} (even if they dropped in {ui_lang} words they didn't know). Judge by INTENT, not word count.
  "response_chunks": [
    {{
      "text": "...",  // MOST chunks should have language="ui" (speak in {ui_lang}). Only use "target" for teaching vocabulary/phrases.
      "language": "ui" | "target",  // "ui" = {ui_lang}, "target" = {target_lang}
      "modality": "text" | "audio",  // audio ONLY for language="target" chunks — NEVER audio for language="ui"
      "locale": "{target_code}-XX",  // only set when modality=="audio"; always target locale, never ui locale
      "purpose": "greeting" | "question" | "feedback" | "encouragement"
    }}
  ],
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
- Your response_chunks should be MOSTLY in {ui_lang} (language="ui", modality="text"). Only use "target" sparingly for teaching.
- NEVER set modality="audio" for a language="ui" chunk. Audio is ONLY for pure {target_lang} text.
- A chunk with modality="audio" must have its "text" field contain ONLY {target_lang} — no {ui_lang} words, no mixed phrases.
- NEVER use target-language audio to repeat, paraphrase, or demonstrate the corrected version of what the user said. Audio must be an organic part of your character's own response — not a correction or teaching moment about the user's mistake.
- Stay in character! Your personality should come through IN {ui_lang}.
- NEVER mention corrections or errors in your response_chunks. Respond as if the user spoke perfectly.
- Pico handles corrections separately via corrected_input/had_errors/error_explanation — fill those fields accurately but keep them out of your conversational response.
- input_intent: "english" if the user was primarily speaking {ui_lang} (even with some {target_lang} thrown in); "spanish" if the user was clearly attempting {target_lang} (even if they got stuck on words and used {ui_lang} for those). Example: "I went to the store today, gracias!" = "english". "Fui al store porque no tenía food" = "spanish"."""

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
        v2_section = f"""V2 CHALLENGE FORMAT — OVERRIDES response_chunks rules above:
- Default to exactly 2 response_chunks: one {ui_lang} text chunk, then the {target_lang} audio challenge. Only use more than 2 when the reply genuinely requires it (e.g. a multi-part reaction that truly can't fit in one sentence). Keep extra chunks rare — 2 is the norm.
- ALL chunks except the LAST: language="ui", modality="text" (speak in {ui_lang})
- The LAST chunk MUST be a challenge sentence in {target_lang}:
  {{
    "text": "<natural {target_lang} sentence — PURE {target_lang} ONLY, absolutely zero {ui_lang} words>",
    "language": "target",
    "modality": "audio",
    "locale": "<appropriate locale for {target_lang}>",
    "native_text": "<{ui_lang} translation of the challenge sentence>",
    "is_challenge": true
  }}
- The "text" field must be ONLY the {target_lang} sentence itself — absolutely NO intro phrases, labels, or preamble in ANY language (e.g. not "Try this:", "¡Intenta decir esto!", "How about:", "Let's try:", etc.)
- Difficulty: slightly above the learner's current level — comprehensible input that stretches them a little
- The challenge sentence should flow naturally as the conclusion of the reply
- CRITICAL — avoid repetition: The {ui_lang} text chunk should ONLY react/acknowledge what the user said (a short natural response). Do NOT include a follow-up question or prompt in the {ui_lang} chunk — the {target_lang} challenge is the ONLY forward-moving piece. The two chunks should complement each other, not say the same thing twice in different languages."""

    # Assemble the static prefix (system prompt)
    full_system = "\n\n".join(section for section in [
        system_filled,
        persona_prompt,
        schema_section,
        reminders_section,
        quiz_rules_section,
        suggestion_section,
        v2_section,
    ] if section)

    # ------------------------------------------------------------------
    # DYNAMIC TAIL (user message): everything that changes per turn —
    # student model (mutable profile lists), conversation context, turn
    # instruction, and the user's input.
    # ------------------------------------------------------------------
    user_message = f"""{student_context}

{context_str}

{turn_instruction}

CURRENT USER INPUT: {user_input}

Return ONLY valid JSON (no markdown, no commentary)."""

    return full_system, user_message
