"""Messenger chat mode: profile init/get, premade scripted conversations, and
the main /api/messenger/turn endpoint.
"""
import json
import random
import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from audio_utils import generate_silent_wav, get_cached_audio_path
from chat_log import append_chat_log
from models import (
    LangSpec,
    MessengerTurnResponse,
    ResponseChunk,
    SuggestedReply,
    TokenUsage,
)
from profile_store import (
    advance_scene,
    check_secret_guess,
    init_default_profile,
    load_persona_json,
    load_profile,
    new_scene,
    pick_scene_dimensions,
    save_profile,
    update_profile_from_assessment,
)
from prompts.messenger_prompt import build_layered_prompt, get_persona_tuning, normalize_prompt_version
from quiz_store import add_quiz_item, get_pending_quiz
from settings import API_ROOT, ENABLE_QUIZZING, MOCK_MODE, PERSONA, REACTIONS_AUDIO_DIR
from tts_helpers import DEFAULT_CLAUSE_PAUSE_MS, tts_bytes_for_chunk

router = APIRouter()

# --- Premade Conversations ---
# In-memory state tracking for premade scripted conversations
premade_sessions: Dict[str, Dict] = {}
# Key: session_id, Value: { "conversation": <conv_data>, "turn_index": int }


def load_premade_conversations() -> list:
    """Load premade conversations from JSON file."""
    import json
    path = API_ROOT / "premade_conversations.json"
    if not path.exists():
        return []
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def normalize_for_match(text: str) -> str:
    """Normalize text for fuzzy matching: lowercase, strip punctuation."""
    import unicodedata
    text = unicodedata.normalize('NFC', text)
    text = text.lower().strip()
    text = re.sub(r'[^\w\s]', '', text)
    text = re.sub(r'\s+', ' ', text)
    return text


def get_premade_display_and_audio(turn_data: dict) -> tuple:
    """
    Get display_text and audio_parts for a premade turn.
    For turns with multiple options (display_text_options), randomly pick one.
    Returns: (display_text, audio_parts)
    """
    if "display_text_options" in turn_data:
        option = random.choice(turn_data["display_text_options"])
        return option["display_text"], option.get("audio_parts", [])
    return turn_data.get("display_text", ""), turn_data.get("audio_parts", [])


def build_premade_response_chunks(display_text: str, audio_parts: list, session_id: str, turn_id: str) -> list:
    """
    Build response chunks from premade turn data.
    Returns a list of ResponseChunk-compatible dicts:
    - One text chunk with the full bracketed display text
    - Audio-only chunks (empty text) for TTS playback
    """
    chunks = []

    # 1. Display text chunk
    chunks.append({
        "text": display_text,
        "language": "ui",
        "modality": "text"
    })

    # 2. Audio-only chunks for each audio_part
    for part in audio_parts:
        text = part["text"]
        locale = part.get("locale", "es-MX")

        # Generate/cache TTS
        url_path, exists, disk_path = get_cached_audio_path(text, locale, pause_ms=DEFAULT_CLAUSE_PAUSE_MS)
        if not exists:
            try:
                wav_bytes = tts_bytes_for_chunk(text, locale, pause_ms=DEFAULT_CLAUSE_PAUSE_MS)
            except Exception as e:
                print(f"TTS failed for premade chunk, using silence: {e}")
                wav_bytes = generate_silent_wav(duration_secs=min(3.0, 0.25 * len(text.split())))
            with open(disk_path, 'wb') as f:
                f.write(wav_bytes)

        chunks.append({
            "text": "",
            "language": "target",
            "modality": "audio",
            "locale": locale,
            "audio_file": url_path
        })

    return chunks


# --- Request models ---

class ProfileInitRequest(BaseModel):
    ui_language: Optional[LangSpec] = LangSpec(code="en", name="English")
    target_language: Optional[LangSpec] = LangSpec(code="es", name="Spanish")


class MessengerTurnRequest(BaseModel):
    user_input: str
    session_id: str
    # "v1" = standard, "v2" = challenge last sentence, "eyesfree" = short spoken-only
    # turn (see PROMPT_VERSIONS in prompts/messenger_prompt.py). Unknown values fall
    # back to v1 rather than minting a new prompt-cache prefix.
    prompt_version: Optional[str] = "v1"


class PremadeStartRequest(BaseModel):
    session_id: str


# --- Endpoints ---

@router.post("/api/messenger/profile/init")
def messenger_init_profile(req: ProfileInitRequest):
    """Initialize a new default profile."""
    profile = init_default_profile(req.ui_language, req.target_language)
    save_profile(profile)
    return {"profile": profile}


@router.get("/api/messenger/profile")
def messenger_get_profile():
    """Get the default profile (creates if not exists)."""
    profile = load_profile()
    return {"profile": profile}


@router.post("/api/messenger/premade-start")
def messenger_premade_start(req: PremadeStartRequest):
    """Start a premade conversation. Randomly picks one of the scripted conversations."""
    conversations = load_premade_conversations()
    if not conversations:
        raise HTTPException(status_code=500, detail="No premade conversations available")

    # Pick a random conversation
    conv = random.choice(conversations)
    turn_id = f"turn_{int(time.time() * 1000)}"

    # Store session state
    premade_sessions[req.session_id] = {
        "conversation": conv,
        "turn_index": 0  # We're about to return turn 0
    }

    # Get first Sombongo turn
    first_turn = conv["sombongo_turns"][0]
    display_text, audio_parts = get_premade_display_and_audio(first_turn)

    # Build response chunks (display text + audio)
    chunk_dicts = build_premade_response_chunks(display_text, audio_parts, req.session_id, turn_id)
    response_chunks = [ResponseChunk(**c) for c in chunk_dicts]
    suggested_replies = [
        SuggestedReply(id=s["id"], text_native=s["text_native"], text_target=s["text_target"])
        for s in first_turn.get("suggested_replies", [])
    ]

    print(f"[PREMADE] Started conversation '{conv['id']}' for session {req.session_id}")

    return MessengerTurnResponse(
        turn_id=turn_id,
        corrected_input="",
        had_errors=False,
        error_explanation="",
        response_chunks=response_chunks,
        suggested_replies=suggested_replies,
        profile_updated=False,
        new_level=None,
        token_usage=None,
        pending_quiz=None
    )


@router.post("/api/messenger/turn")
def messenger_chat_turn(req: MessengerTurnRequest):
    """Main chat endpoint. Processes user input and returns Mateo's response."""
    from llm_call import call_llm_for_messenger

    turn_id = f"turn_{int(time.time() * 1000)}"

    # --- Check for active premade conversation ---
    if req.session_id in premade_sessions:
        session_state = premade_sessions[req.session_id]
        conv = session_state["conversation"]
        current_turn_idx = session_state["turn_index"]
        current_sombongo_turn = conv["sombongo_turns"][current_turn_idx]

        # Normalize user input and check against suggested replies
        user_normalized = normalize_for_match(req.user_input)
        matched = False
        for reply in current_sombongo_turn.get("suggested_replies", []):
            if normalize_for_match(reply["text_target"]) == user_normalized:
                matched = True
                break

        if matched:
            next_turn_idx = current_turn_idx + 1

            if next_turn_idx < len(conv["sombongo_turns"]):
                next_turn = conv["sombongo_turns"][next_turn_idx]
                display_text, audio_parts = get_premade_display_and_audio(next_turn)
                chunk_dicts = build_premade_response_chunks(display_text, audio_parts, req.session_id, turn_id)
                response_chunks = [ResponseChunk(**c) for c in chunk_dicts]

                next_replies = next_turn.get("suggested_replies", [])
                suggested_replies = [
                    SuggestedReply(id=s["id"], text_native=s["text_native"], text_target=s["text_target"])
                    for s in next_replies
                ]

                if next_replies:
                    # More premade turns to go
                    session_state["turn_index"] = next_turn_idx
                    print(f"[PREMADE] Advancing to turn {next_turn_idx} in '{conv['id']}'")
                else:
                    # This is the last Sombongo turn (no more suggested replies)
                    # Remove from premade sessions - next user message will use LLM
                    del premade_sessions[req.session_id]
                    print(f"[PREMADE] Completed conversation '{conv['id']}' for session {req.session_id}")

                return MessengerTurnResponse(
                    turn_id=turn_id,
                    corrected_input=req.user_input,
                    had_errors=False,
                    error_explanation="",
                    response_chunks=response_chunks,
                    suggested_replies=suggested_replies,
                    profile_updated=False,
                    new_level=None,
                    token_usage=None,
                    pending_quiz=None
                )

        # No match - fall through to LLM
        del premade_sessions[req.session_id]
        print(f"[PREMADE] User typed custom input, falling back to LLM for session {req.session_id}")

    # --- Normal LLM path ---
    profile = load_profile()
    _ensure_scene(profile)
    _check_secret(profile, req.user_input)
    is_assessment_turn = _is_assessment_turn(profile)
    version = normalize_prompt_version(req.prompt_version)
    system_prompt, user_message = build_layered_prompt(req.user_input, profile, version)

    if MOCK_MODE:
        llm_response = _mock_llm_response(req, profile, version)
    else:
        tuning = get_persona_tuning()
        llm_response = call_llm_for_messenger(system_prompt, user_message, **tuning)

    _apply_output_gates(llm_response, is_assessment_turn, version)

    chunk_dicts, pending = _prepare_chunks(llm_response.get("response_chunks", []), _target_code(profile))
    _run_tts(pending)

    return _finalize_turn(req, profile, llm_response, chunk_dicts, turn_id)


# --- Turn helpers (shared by the buffered and streaming endpoints) -------------


def _check_secret(profile: dict, user_input: str) -> None:
    """Did this input name the active scene's secret? (task 5.3)

    Runs before the prompt is built, so a hit is visible to the turn that
    answers it: the SCENE PACING block flips to "they just named it, confirm and
    close", and advance_scene ends the scene at the end of this same turn. Free —
    local matching only, no LLM check (see profile_store.check_secret_guess).
    """
    scene = profile.get("scene")
    if check_secret_guess(scene, user_input):
        print(f"[SCENE] secret named on turn {scene.get('solved_at_turn')} "
              f"of {scene.get('turn_budget')}: {scene.get('secret')}")


def _ensure_scene(profile: dict) -> None:
    """Make sure the profile has an active scene before the prompt is built (task 5.1).

    No-op while a scene is running, so the cost is one cheap LLM call every 5-10
    turns. The usual caller is _finalize_turn, the moment a scene's budget runs
    out; the calls at the top of both turn endpoints are the cold-start path
    (first turn ever, a pre-5.1 profile, or a rotation that failed last turn).

    Mutates `profile` in place — the turn's own save_profile persists it. If this
    turn then fails, the scene is simply redrawn next turn; nothing downstream
    requires a scene to exist.
    """
    from llm_call import generate_scene

    previous = profile.get("scene")
    if previous and previous.get("status") == "active":
        return

    dimensions = pick_scene_dimensions(previous)
    if not dimensions:
        print("[SCENE] no dimensions available — running this turn without a scene")
        return

    concretized = None
    try:
        persona_data = load_persona_json(PERSONA) or {}
        ui_code = profile.get("ui_language", {}).get("code", "en")
        concretized = generate_scene(
            dimensions,
            character_name=persona_data.get("meta", {}).get("display_name", "the character"),
            character_bio=persona_data.get("short_bio", {}).get(ui_code, ""),
            target_language=profile.get("target_language", {}).get("name", "Spanish"),
        )
    except Exception as e:
        # The drawn dimensions are already a playable scene; a failed call costs
        # specificity, not the feature.
        print(f"[SCENE] generation failed, using raw dimensions: {e}")

    scene = new_scene(dimensions, concretized)
    profile["scene"] = scene
    print(f"[SCENE] new {scene.get('type', 'standard')} scene {scene['id']} "
          f"({scene['source']}, {scene['turn_budget']} turns): {scene['character_goal']}")


def _is_assessment_turn(profile: dict) -> bool:
    """Same every-5th-turn gate the prompt's TURN INSTRUCTION uses (pre-increment)."""
    turn_count = profile.get("turn_count", 0)
    return turn_count > 0 and turn_count % 5 == 0


def _apply_output_gates(llm_response: dict, is_assessment_turn: bool,
                        prompt_version: str = "v1") -> None:
    """Drop fields the schema always describes but this turn didn't ask for.

    The schema text is static (it has to be, for prompt caching), so inclusion is
    gated by the turn instruction — and the model sometimes emits them anyway.
    """
    if not is_assessment_turn:
        llm_response["level_assessment"] = {}
    if not ENABLE_QUIZZING:
        llm_response["quiz_candidates"] = []
    if prompt_version == "eyesfree":
        # Nothing reads suggestions aloud with the screen off, and speaking them
        # would add ~15s to a turn budgeted at ~10s. The prompt asks for an empty
        # array; enforce it here so a drifting model can't reintroduce them.
        llm_response["suggested_replies"] = []


SEVERITY_VALUES = ("none", "minor", "major")


def _normalize_severity(llm_response: dict) -> str:
    """Reconcile error_severity with had_errors.

    The field gates the eyes-free drill (task 3.4), so only "major" interrupts —
    "minor" is left for the deferred quiz. Two ways the model can contradict
    itself, handled differently on purpose:

    * severity missing or not one of the three values, but had_errors=true — no
      signal at all, so fall back to "major". An error definitely happened, and a
      spurious drill is visible and skippable, whereas silently swallowing every
      correction would look like the feature is broken.
    * severity="none" while had_errors=true — that *is* a signal: the model judged
      it negligible. Demote to "minor" so it goes to the quiz instead of
      interrupting.
    """
    had_errors = bool(llm_response.get("had_errors", False))
    severity = llm_response.get("error_severity")
    if not had_errors:
        return "none"
    if severity == "none":
        return "minor"
    if severity in SEVERITY_VALUES:
        return severity
    return "major"


def _mock_llm_response(req, profile: dict, version: str = "v1") -> dict:
    """Mock-mode stand-in for call_llm_for_messenger (no API keys needed)."""
    has_english = any(c.isalpha() and ord(c) < 128 for c in req.user_input.lower())
    mock_quiz = []
    if has_english and "store" in req.user_input.lower():
        mock_quiz = [{
            "type": "translation",
            "original": "the store",
            "corrected": "la tienda",  # THIS IS THE ANSWER
            "error_type": "vocabulary",
            "quiz_prompt": "How do you say 'the store' in Spanish?"
        }]

    # Every chunk is target-language audio since task 3.8 — the character speaks
    # only the target language, and UI-language translations are fetched separately
    # via /api/messenger/translate. Chunk 0 is a verbatim reaction-bank opener, so
    # these mocks exercise both the bank lookup and the TTS path in _prepare_chunk.
    mock_chunks_v1 = [
        {"text": "¡Ah, qué bien!", "language": "target", "modality": "audio", "locale": "es-MX", "purpose": "reaction"},
        {"text": "Oye, cuéntame más de eso.", "language": "target", "modality": "audio", "locale": "es-MX", "purpose": "question"},
        {"text": "¿Y qué hiciste después?", "language": "target", "modality": "audio", "locale": "es-MX", "purpose": "question"},
    ]
    mock_chunks_v2 = [
        {"text": "¡Ah, qué bien!", "language": "target", "modality": "audio", "locale": "es-MX", "purpose": "reaction"},
        {"text": "Oye, eso suena divertido.", "language": "target", "modality": "audio", "locale": "es-MX", "purpose": "feedback"},
        {"text": "¿Cuándo empezaste a aprender español?", "language": "target", "modality": "audio", "locale": "es-MX", "native_text": "When did you start learning Spanish?", "is_challenge": True},
    ]
    # Eyes-free is the shape the real prompt asks for: exactly one reaction opener
    # plus one short target-language sentence.
    mock_chunks_eyesfree = [
        {"text": "¡Ah, qué bien!", "language": "target", "modality": "audio", "locale": "es-MX", "purpose": "reaction"},
        {"text": "¿Y qué hiciste después?", "language": "target", "modality": "audio", "locale": "es-MX", "native_text": "And what did you do afterwards?", "is_challenge": True},
    ]
    chunks_by_version = {"v2": mock_chunks_v2, "eyesfree": mock_chunks_eyesfree}

    # The prompt's own canonical false-cognate example, wired into the mock so the
    # eyes-free repeat-after-me drill (task 3.4) can be exercised without API keys:
    # saying anything containing "gaseoso" comes back as a substantive correction.
    # Everything else stays clean, as before.
    had_errors = "gaseoso" in req.user_input.lower()
    return {
        "corrected_input": "Eso me va a dar gases." if had_errors else req.user_input,
        "had_errors": had_errors,
        "error_severity": "major" if had_errors else "none",
        "error_explanation": (
            "Natives say me da gases there, because gaseoso means fizzy like a soda."
            if had_errors else ""
        ),
        "response_chunks": chunks_by_version.get(version, mock_chunks_v1),
        "quiz_candidates": mock_quiz,
        "level_assessment": {
            "current_level": profile["level"],
            "confidence": 0.6,
            "should_update": False,
            "reasoning": "Mock mode - no real assessment",
            "add_comfortable": [],
            "add_weak": [],
            "remove_weak": []
        }
    }


_REACTION_AUDIO_LOOKUP: Optional[Dict[str, str]] = None


def _target_code(profile: dict) -> str:
    """The learner's target-language code — what the character speaks (task 3.8)."""
    return profile.get("target_language", {}).get("code", "es")


def _reaction_audio_lookup(lang_code: str) -> Dict[str, str]:
    """text -> pre-generated static audio URL, for exact REACTION OPENERS matches.

    Keyed on the TARGET language since task 3.8: the character speaks only the
    target language, so response_chunks[0] is a target-language clip (see
    messenger_prompt.py's reaction_bank_section and
    scripts/generate_reaction_audio.py, which produces the files this maps to).

    Only entries whose .wav actually exists are included. The bank is worthless
    until the generator script has run, and chunk 0 is the first thing the learner
    hears — a missing file has to fall through to live TTS, not play silence.
    """
    global _REACTION_AUDIO_LOOKUP
    if _REACTION_AUDIO_LOOKUP is None:
        _REACTION_AUDIO_LOOKUP = {}
    if lang_code not in _REACTION_AUDIO_LOOKUP:
        persona_data = load_persona_json(PERSONA) or {}
        reactions = persona_data.get("reactions", {}).get(lang_code, [])
        lookup = {}
        for r in reactions:
            rid, text = r.get("id"), r.get("text")
            if not rid or not text:
                continue
            if (REACTIONS_AUDIO_DIR / PERSONA / f"{rid}.wav").exists():
                lookup[text] = f"/api/audio_file/reactions/{PERSONA}/{rid}.wav"
        _REACTION_AUDIO_LOOKUP[lang_code] = lookup
    return _REACTION_AUDIO_LOOKUP[lang_code]


# task 3.11: split a chunk's text into one sentence per chunk, server-side,
# instead of trusting the prompt's "ONE spoken sentence" rule (which the model
# does not reliably obey). Narrow on purpose — see TASKS.md task 3.11 "Watch
# for": general-purpose sentence-boundary regexes over-split on abbreviations
# and decimals.
MIN_SENTENCE_WORDS = 4
_SENTENCE_ABBREVIATIONS = {"sr", "sra", "srta", "dr", "dra", "ud", "uds", "etc"}
_SENTENCE_END_RE = re.compile(r'([.?!]+)(\s+|$)')


def _split_into_sentences(text: str) -> list:
    """Split on ., ?, ! boundaries.

    Only a boundary punctuation mark followed by whitespace or end-of-string
    counts — "3.50" has no following whitespace, so decimals are excluded with
    no extra logic. A single period preceded by a known abbreviation ("Sr.",
    "etc.") is the one case that DOES have trailing whitespace but isn't a
    real sentence end, so that's checked explicitly.
    """
    if not text:
        return []
    sentences = []
    start = 0
    for m in _SENTENCE_END_RE.finditer(text):
        punct, boundary_end = m.group(1), m.end()
        if punct == ".":
            preceding = re.search(r'(\w+)$', text[start:m.start()])
            if preceding and preceding.group(1).lower() in _SENTENCE_ABBREVIATIONS:
                continue
        piece = text[start:boundary_end].strip()
        if piece:
            sentences.append(piece)
        start = boundary_end
    remainder = text[start:].strip()
    if remainder:
        sentences.append(remainder)
    return sentences


def _merge_short_fragments(sentences: list, min_words: int = MIN_SENTENCE_WORDS) -> list:
    """Fold any fragment under `min_words` into a neighbour.

    Without this, "¿En serio?" gets its own bubble and its own inter-sentence
    pacing gap, which reads as a stall rather than a beat. Merges into the
    previous piece; the first piece (no previous) merges forward instead.
    Re-checks the merged result so a run of several short fragments collapses
    all the way down rather than leaving a still-short remainder.
    """
    merged = list(sentences)
    i = 0
    while len(merged) > 1 and i < len(merged):
        if len(merged[i].split()) < min_words:
            if i == 0:
                merged[0:2] = [merged[0] + " " + merged[1]]
            else:
                merged[i - 1:i + 1] = [merged[i - 1] + " " + merged[i]]
                i -= 1
        else:
            i += 1
    return merged


def _split_chunk_into_sentences(chunk_dict: dict) -> list:
    """One response chunk -> one chunk per sentence (task 3.11).

    Only eligible for audio, target-language chunks — ui/text chunks and any
    chunk that only contains one sentence pass through unchanged. TRAP 2
    (TASKS.md task 3.11): a chunk carrying is_challenge/native_text can't keep
    native_text once split, since it translated the whole original chunk, not
    any single sentence of it — dropped in favour of 3.8's
    /api/messenger/translate fetching per-sentence translations on demand
    (wired up by 3.12). is_challenge moves to the LAST piece.
    """
    if chunk_dict.get("modality") != "audio" or chunk_dict.get("language") != "target":
        return [chunk_dict]

    sentences = _merge_short_fragments(_split_into_sentences(chunk_dict.get("text", "")))
    if len(sentences) <= 1:
        return [chunk_dict]

    pieces = []
    for sentence in sentences:
        piece = dict(chunk_dict)
        piece["text"] = sentence
        piece.pop("native_text", None)
        piece.pop("is_challenge", None)
        pieces.append(piece)
    if chunk_dict.get("is_challenge"):
        pieces[-1]["is_challenge"] = True
    return pieces


def _prepare_chunk(chunk, target_code: str = "es") -> tuple:
    """Normalize one response chunk and resolve its audio URL.

    Returns ``(chunk_dict, pending)`` where pending is ``(text, locale, disk_path)``
    for a cache-miss audio chunk that still needs generating, else None. The dict's
    ``audio_file`` is set either way, so callers can emit the chunk before the TTS
    bytes exist on disk.
    """
    chunk_dict = chunk if isinstance(chunk, dict) else chunk.dict()

    # Reaction openers come from the pre-generated bank: free, instant, and no
    # Azure roundtrip on the one clip the learner is waiting for. Checked before
    # the TTS path so a bank hit skips generation entirely.
    reaction_audio = _reaction_audio_lookup(target_code).get(chunk_dict.get("text", ""))
    if reaction_audio:
        chunk_dict["reaction_audio_file"] = reaction_audio
        return chunk_dict, None

    if chunk_dict.get("modality") != "audio":
        return chunk_dict, None

    # Never generate TTS for ui-language chunks — downgrade to text
    if chunk_dict.get("language") != "target":
        chunk_dict["modality"] = "text"
        return chunk_dict, None

    locale = chunk_dict.get("locale", "es-MX")
    text = chunk_dict.get("text", "")

    # Strip English intro phrases that the LLM sometimes prepends (e.g. "Try this: ...")
    english_intro = re.match(r'^[A-Za-z][^¿¡\n]*?:\s*', text)
    if english_intro:
        stripped = text[english_intro.end():]
        if stripped.strip():
            print(f"[TTS] Stripped English intro '{english_intro.group()}' from audio chunk")
            text = stripped.strip()
            chunk_dict["text"] = text

    # Content-hash cache before generating fresh TTS (chunks repeat: greetings,
    # suggested replies, common challenge sentences)
    cache_url, cache_hit, cache_disk_path = get_cached_audio_path(
        text, locale, pause_ms=DEFAULT_CLAUSE_PAUSE_MS)
    chunk_dict["audio_file"] = cache_url
    return chunk_dict, (None if cache_hit else (text, locale, cache_disk_path))


def _prepare_chunks(chunks, target_code: str = "es") -> tuple:
    """_prepare_chunk over a whole list. Order is preserved throughout.

    Every chunk except index 0 is split into one sentence per chunk first
    (task 3.11). Index 0 is never split — it's the reaction opener, matched
    verbatim against the pre-generated bank (TRAP 1 in TASKS.md task 3.11).
    """
    chunk_dicts, pending = [], []
    for i, chunk in enumerate(chunks):
        raw = chunk if isinstance(chunk, dict) else chunk.dict()
        pieces = [raw] if i == 0 else _split_chunk_into_sentences(raw)
        for piece in pieces:
            chunk_dict, work = _prepare_chunk(piece, target_code)
            chunk_dicts.append(chunk_dict)
            if work:
                pending.append(work)
    return chunk_dicts, pending


def _generate_and_save(item) -> None:
    text, locale, disk_path = item
    try:
        wav_bytes = tts_bytes_for_chunk(text, locale, pause_ms=DEFAULT_CLAUSE_PAUSE_MS)
    except Exception as e:
        print(f"TTS failed for chunk, using silence: {e}")
        wav_bytes = generate_silent_wav(duration_secs=min(3.0, 0.25 * len(text.split())))
    with open(disk_path, "wb") as f:
        f.write(wav_bytes)


def _run_tts(pending: list) -> None:
    """Generate cache-miss chunk audio concurrently (the Azure roundtrip is the slow
    part; cache lookups already happened in _prepare_chunk). Sync endpoint running in
    FastAPI's threadpool, so blocking threads here are fine."""
    if not pending:
        return
    with ThreadPoolExecutor(max_workers=len(pending)) as pool:
        list(pool.map(_generate_and_save, pending))


def _finalize_turn(req, profile: dict, llm_response: dict, chunk_dicts: list,
                   turn_id: str) -> MessengerTurnResponse:
    """Profile update, level assessment, suggestions, quiz, chat log, response build.

    Everything that happens once the model's output is complete — identical for the
    buffered and streaming endpoints.
    """
    processed_chunks = [ResponseChunk(**chunk_dict) for chunk_dict in chunk_dicts]

    profile["turn_count"] += 1
    if llm_response.get("had_errors", False):
        profile["corrections_needed"] += 1

    # Rolling window of 10 recent turns
    profile["recent_turns"].append({
        "turn_id": turn_id,
        "user_input": req.user_input,
        "corrected_input": llm_response.get("corrected_input", req.user_input),
        "had_errors": llm_response.get("had_errors", False),
        "input_intent": llm_response.get("input_intent", "spanish"),
        "timestamp": int(time.time())
    })
    if len(profile["recent_turns"]) > 10:
        profile["recent_turns"] = profile["recent_turns"][-10:]

    # Count this turn against the scene's budget, and if that ended the scene,
    # draw the next one now rather than at the start of the next turn. The
    # generation call costs ~1s: here the learner is still listening to the reply
    # audio, whereas at turn start it would sit in front of the first chunk.
    advance_scene(profile)
    if (profile.get("scene") or {}).get("status") == "complete":
        _ensure_scene(profile)

    assessment = llm_response.get("level_assessment", {})
    profile, profile_updated = update_profile_from_assessment(profile, assessment)
    save_profile(profile)

    suggested_replies = []
    for suggestion in llm_response.get("suggested_replies", []):
        try:
            suggested_replies.append(SuggestedReply(
                id=suggestion.get("id", f"r{len(suggested_replies)+1}"),
                text_native=suggestion.get("text_native", ""),
                text_target=suggestion.get("text_target", "")
            ))
        except Exception as e:
            print(f"Failed to parse suggestion: {e}")
            continue

    token_usage_data = llm_response.get("token_usage")
    token_usage = None
    if token_usage_data:
        token_usage = TokenUsage(
            prompt_tokens=token_usage_data.get("prompt_tokens", 0),
            completion_tokens=token_usage_data.get("completion_tokens", 0),
            total_tokens=token_usage_data.get("total_tokens", 0),
            cost_cents=token_usage_data.get("cost_cents", 0.0)
        )

    for candidate in llm_response.get("quiz_candidates", []):
        if candidate and candidate.get("prompt_target"):
            add_quiz_item(candidate, profile["turn_count"])

    pending_quiz = get_pending_quiz(profile["turn_count"])

    append_chat_log(
        session_id=req.session_id or "unknown",
        user_input=req.user_input,
        corrected_input=llm_response.get("corrected_input", req.user_input),
        had_errors=llm_response.get("had_errors", False),
        error_explanation=llm_response.get("error_explanation", ""),
        input_intent=llm_response.get("input_intent", "spanish"),
        lang_code=profile.get("target_language", {}).get("code", "es"),
    )
    return MessengerTurnResponse(
        turn_id=turn_id,
        corrected_input=llm_response.get("corrected_input", req.user_input),
        user_translation=llm_response.get("user_translation") or None,
        had_errors=llm_response.get("had_errors", False),
        error_severity=_normalize_severity(llm_response),
        error_explanation=llm_response.get("error_explanation", ""),
        input_intent=llm_response.get("input_intent", "spanish"),
        response_chunks=processed_chunks,
        suggested_replies=suggested_replies,
        profile_updated=profile_updated,
        new_level=profile["level"] if profile_updated else None,
        token_usage=token_usage,
        pending_quiz=pending_quiz
    )


@router.post("/api/messenger/turn/stream")
def messenger_chat_turn_stream(req: MessengerTurnRequest):
    """Streaming twin of /api/messenger/turn (NDJSON, one JSON object per line).

    The schema puts response_chunks first, so each reply bubble can be sent as soon
    as the model finishes writing it — the learner sees the reply while corrections
    and suggested replies are still being generated. TTS for a cache-miss audio chunk
    starts the moment that chunk arrives, overlapping Azure with the tail of the LLM
    call instead of following it.

    Event types (one JSON object per line):
      {"type":"chunk","index":N,"chunk":{...}}   a reply bubble; audio_file 404s until "audio"
      {"type":"audio","index":N}                 that chunk's TTS is now on disk
      {"type":"final", ...MessengerTurnResponse} everything else
      {"type":"fallback"}                        caller should retry /api/messenger/turn
      {"type":"error","chunks_emitted":N}        failed; safe to retry only if N == 0
    """
    from llm_call import stream_llm_for_messenger

    def events():
        turn_id = f"turn_{int(time.time() * 1000)}"

        # Premade scripted conversations stay single-sourced in the buffered endpoint.
        if req.session_id in premade_sessions:
            yield json.dumps({"type": "fallback"}) + "\n"
            return

        profile = load_profile()
        _ensure_scene(profile)
        _check_secret(profile, req.user_input)
        is_assessment_turn = _is_assessment_turn(profile)
        version = normalize_prompt_version(req.prompt_version)
        system_prompt, user_message = build_layered_prompt(req.user_input, profile, version)

        chunk_dicts: list = []
        emitted = 0
        raw_index = 0  # counts raw LLM-emitted chunks, before task 3.11's split
        pool = ThreadPoolExecutor(max_workers=4)
        futures: dict = {}
        try:
            if MOCK_MODE:
                mock = _mock_llm_response(req, profile, version)
                stream = [("chunk", c) for c in mock.get("response_chunks", [])]
                stream.append(("done", mock))
            else:
                tuning = get_persona_tuning()
                stream = stream_llm_for_messenger(system_prompt, user_message, **tuning)

            llm_response = None
            for kind, payload in stream:
                if kind == "chunk":
                    # task 3.11: every raw chunk except the first (the reaction
                    # opener, TRAP 1) is split into one sentence per chunk before
                    # TTS, same as the buffered path's _prepare_chunks.
                    pieces = [payload] if raw_index == 0 else _split_chunk_into_sentences(payload)
                    raw_index += 1
                    for piece in pieces:
                        chunk_dict, work = _prepare_chunk(piece, _target_code(profile))
                        index = len(chunk_dicts)
                        chunk_dicts.append(chunk_dict)
                        if work:
                            futures[index] = pool.submit(_generate_and_save, work)
                        yield json.dumps({
                            "type": "chunk", "index": index, "chunk": chunk_dict
                        }, ensure_ascii=False) + "\n"
                        emitted += 1
                elif kind == "done":
                    llm_response = payload

            if llm_response is None:
                raise RuntimeError("stream ended without a completed response")

            # Recovery: if the model emitted response_chunks somewhere the incremental
            # scanner couldn't reach it, fall back to the completed document.
            if not chunk_dicts:
                chunk_dicts, pending = _prepare_chunks(llm_response.get("response_chunks", []), _target_code(profile))
                _run_tts(pending)
                for index, chunk_dict in enumerate(chunk_dicts):
                    yield json.dumps({
                        "type": "chunk", "index": index, "chunk": chunk_dict
                    }, ensure_ascii=False) + "\n"
                    emitted += 1

            for index, future in futures.items():
                try:
                    future.result()
                except Exception as e:
                    print(f"TTS future failed for chunk {index}: {e}")
                yield json.dumps({"type": "audio", "index": index}) + "\n"

            _apply_output_gates(llm_response, is_assessment_turn, version)
            final = _finalize_turn(req, profile, llm_response, chunk_dicts, turn_id)
            payload = final.dict()
            payload["type"] = "final"
            yield json.dumps(payload, ensure_ascii=False, default=str) + "\n"

        except Exception as e:
            print(f"[STREAM] messenger turn failed after {emitted} chunk(s): {e}")
            yield json.dumps({"type": "error", "chunks_emitted": emitted}) + "\n"
        finally:
            pool.shutdown(wait=True)

    return StreamingResponse(
        events(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
