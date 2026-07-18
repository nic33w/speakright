"""Messenger chat mode: profile init/get, premade scripted conversations, and
the main /api/messenger/turn endpoint.
"""
import random
import re
import time
from typing import Dict, Optional

from fastapi import APIRouter, HTTPException
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
    load_profile,
    save_profile,
    update_profile_from_assessment,
)
from prompts.messenger_prompt import build_layered_prompt
from quiz_store import add_quiz_item, get_pending_quiz
from settings import API_ROOT, MOCK_MODE
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
    prompt_version: Optional[str] = "v1"  # "v1" = standard, "v2" = challenge last sentence


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
    # Load profile
    profile = load_profile()

    # Build layered prompt
    system_prompt, user_message = build_layered_prompt(req.user_input, profile, req.prompt_version or "v1")

    if MOCK_MODE:
        # Mock response with sample quiz candidate for testing
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
        llm_response = {
            "corrected_input": req.user_input,
            "had_errors": False,
            "error_explanation": "",
            "response_chunks": mock_chunks_v2 if (req.prompt_version or "v1") == "v2" else mock_chunks_v1,
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
    else:
        # Real LLM call
        llm_response = call_llm_for_messenger(system_prompt, user_message)

    # Process response chunks (generate TTS for audio modality)
    processed_chunks = []
    for chunk in llm_response.get("response_chunks", []):
        chunk_dict = chunk if isinstance(chunk, dict) else chunk.dict()

        if chunk_dict["modality"] == "audio":
            # Never generate TTS for ui-language chunks — downgrade to text
            if chunk_dict.get("language") != "target":
                chunk_dict["modality"] = "text"
                processed_chunks.append(ResponseChunk(**chunk_dict))
                continue

            locale = chunk_dict.get("locale", "es-MX")
            text = chunk_dict["text"]

            # Strip English intro phrases that the LLM sometimes prepends (e.g. "Try this: ¿...")
            english_intro = re.match(r'^[A-Za-z][^¿¡\n]*?:\s*', text)
            if english_intro:
                stripped = text[english_intro.end():]
                if stripped.strip():
                    print(f"[TTS] Stripped English intro '{english_intro.group()}' from audio chunk")
                    text = stripped.strip()
                    chunk_dict["text"] = text

            # Check content-hash cache before generating fresh TTS (chunks repeat: greetings,
            # suggested replies, common challenge sentences)
            cache_url, cache_hit, cache_disk_path = get_cached_audio_path(text, locale)

            if cache_hit:
                chunk_dict["audio_file"] = cache_url
            else:
                try:
                    wav_bytes = tts_bytes_for_chunk(text, locale)
                except Exception as e:
                    print(f"TTS failed for chunk, using silence: {e}")
                    wav_bytes = generate_silent_wav(duration_secs=min(3.0, 0.25 * len(text.split())))

                with open(cache_disk_path, "wb") as f:
                    f.write(wav_bytes)

                chunk_dict["audio_file"] = cache_url

        processed_chunks.append(ResponseChunk(**chunk_dict))

    # Update profile
    profile["turn_count"] += 1
    if llm_response.get("had_errors", False):
        profile["corrections_needed"] += 1

    # Add to recent turns (rolling window of 10)
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

    # Level assessment
    assessment = llm_response.get("level_assessment", {})
    profile, profile_updated = update_profile_from_assessment(profile, assessment)

    # Save profile
    save_profile(profile)

    # Extract suggested replies
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

    # Extract token usage
    token_usage_data = llm_response.get("token_usage")
    token_usage = None
    if token_usage_data:
        token_usage = TokenUsage(
            prompt_tokens=token_usage_data.get("prompt_tokens", 0),
            completion_tokens=token_usage_data.get("completion_tokens", 0),
            total_tokens=token_usage_data.get("total_tokens", 0),
            cost_cents=token_usage_data.get("cost_cents", 0.0)
        )

    # Extract and store quiz candidates
    quiz_candidates = llm_response.get("quiz_candidates", [])
    for candidate in quiz_candidates:
        if candidate and candidate.get("prompt_target"):
            add_quiz_item(candidate, profile["turn_count"])

    # Check for pending quiz to show
    pending_quiz = get_pending_quiz(profile["turn_count"])

    # Build response
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
        error_explanation=llm_response.get("error_explanation", ""),
        input_intent=llm_response.get("input_intent", "spanish"),
        response_chunks=processed_chunks,
        suggested_replies=suggested_replies,
        profile_updated=profile_updated,
        new_level=profile["level"] if profile_updated else None,
        token_usage=token_usage,
        pending_quiz=pending_quiz
    )
