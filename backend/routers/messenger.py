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
    init_default_profile,
    load_persona_json,
    load_profile,
    save_profile,
    update_profile_from_assessment,
)
from prompts.messenger_prompt import build_layered_prompt, normalize_prompt_version
from quiz_store import add_quiz_item, get_pending_quiz
from settings import API_ROOT, ENABLE_QUIZZING, MOCK_MODE, PERSONA
from tts_helpers import tts_bytes_for_chunk

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
        url_path, exists, disk_path = get_cached_audio_path(text, locale)
        if not exists:
            try:
                wav_bytes = tts_bytes_for_chunk(text, locale)
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
    is_assessment_turn = _is_assessment_turn(profile)
    version = normalize_prompt_version(req.prompt_version)
    system_prompt, user_message = build_layered_prompt(req.user_input, profile, version)

    if MOCK_MODE:
        llm_response = _mock_llm_response(req, profile, version)
    else:
        llm_response = call_llm_for_messenger(system_prompt, user_message)

    _apply_output_gates(llm_response, is_assessment_turn, version)

    chunk_dicts, pending = _prepare_chunks(llm_response.get("response_chunks", []))
    _run_tts(pending)

    return _finalize_turn(req, profile, llm_response, chunk_dicts, turn_id)


# --- Turn helpers (shared by the buffered and streaming endpoints) -------------


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

    mock_chunks_v1 = [{"text": "¡Hola! How can I help you today?", "language": "ui", "modality": "text", "purpose": "greeting"}]
    mock_chunks_v2 = [
        {"text": "Oh, interesting! Tell me more.", "language": "ui", "modality": "text", "purpose": "reaction"},
        {"text": "¿Cuándo empezaste a aprender español?", "language": "target", "modality": "text", "locale": "es-MX", "native_text": "When did you start learning Spanish?", "is_challenge": True},
    ]
    # Eyes-free is the shape the real prompt asks for: one reaction, one short
    # target-language sentence, and it really is audio (the only messenger mock
    # that exercises _prepare_chunk's TTS path).
    mock_chunks_eyesfree = [
        {"text": "Oh, interesting! Tell me more.", "language": "ui", "modality": "text", "purpose": "reaction"},
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


def _reaction_audio_lookup() -> Dict[str, str]:
    """text -> pre-generated static audio URL, for exact REACTION OPENERS matches.
    Built once from the active persona's `reactions.en` (see messenger_prompt.py's
    reaction_bank_section and scripts/generate_reaction_audio.py, which produces the
    files this maps to)."""
    global _REACTION_AUDIO_LOOKUP
    if _REACTION_AUDIO_LOOKUP is None:
        persona_data = load_persona_json(PERSONA) or {}
        reactions = persona_data.get("reactions", {}).get("en", [])
        _REACTION_AUDIO_LOOKUP = {
            r["text"]: f"/api/audio_file/reactions/{PERSONA}/{r['id']}.wav"
            for r in reactions if r.get("id") and r.get("text")
        }
    return _REACTION_AUDIO_LOOKUP


def _prepare_chunk(chunk) -> tuple:
    """Normalize one response chunk and resolve its audio URL.

    Returns ``(chunk_dict, pending)`` where pending is ``(text, locale, disk_path)``
    for a cache-miss audio chunk that still needs generating, else None. The dict's
    ``audio_file`` is set either way, so callers can emit the chunk before the TTS
    bytes exist on disk.
    """
    chunk_dict = chunk if isinstance(chunk, dict) else chunk.dict()
    if chunk_dict.get("modality") != "audio":
        if chunk_dict.get("language") == "ui":
            reaction_audio = _reaction_audio_lookup().get(chunk_dict.get("text", ""))
            if reaction_audio:
                chunk_dict["reaction_audio_file"] = reaction_audio
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
    cache_url, cache_hit, cache_disk_path = get_cached_audio_path(text, locale)
    chunk_dict["audio_file"] = cache_url
    return chunk_dict, (None if cache_hit else (text, locale, cache_disk_path))


def _prepare_chunks(chunks) -> tuple:
    """_prepare_chunk over a whole list. Order is preserved throughout."""
    chunk_dicts, pending = [], []
    for chunk in chunks:
        chunk_dict, work = _prepare_chunk(chunk)
        chunk_dicts.append(chunk_dict)
        if work:
            pending.append(work)
    return chunk_dicts, pending


def _generate_and_save(item) -> None:
    text, locale, disk_path = item
    try:
        wav_bytes = tts_bytes_for_chunk(text, locale)
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
        is_assessment_turn = _is_assessment_turn(profile)
        version = normalize_prompt_version(req.prompt_version)
        system_prompt, user_message = build_layered_prompt(req.user_input, profile, version)

        chunk_dicts: list = []
        emitted = 0
        pool = ThreadPoolExecutor(max_workers=4)
        futures: dict = {}
        try:
            if MOCK_MODE:
                mock = _mock_llm_response(req, profile, version)
                stream = [("chunk", c) for c in mock.get("response_chunks", [])]
                stream.append(("done", mock))
            else:
                stream = stream_llm_for_messenger(system_prompt, user_message)

            llm_response = None
            for kind, payload in stream:
                if kind == "chunk":
                    chunk_dict, work = _prepare_chunk(payload)
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
                chunk_dicts, pending = _prepare_chunks(llm_response.get("response_chunks", []))
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
