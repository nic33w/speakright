from dotenv import load_dotenv
import os
import time
import re
import hashlib
from typing import List, Dict, Any, Optional
from pathlib import Path
from fastapi.responses import FileResponse
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from difflib import SequenceMatcher

# Optional fast fuzzy matching
try:
    from rapidfuzz import fuzz
except Exception:
    fuzz = None

load_dotenv()

# Helpers
def parse_bool_env(varname: str, default: bool = True) -> bool:
    val = os.getenv(varname)
    if val is None:
        return default
    return str(val).strip().lower() in ("1", "true", "yes", "on")

MOCK_MODE = parse_bool_env("MOCK_MODE", default=True)
AZURE_SPEECH_KEY = os.getenv("AZURE_SPEECH_KEY")
AZURE_REGION = os.getenv("AZURE_REGION")

API_ROOT = Path(__file__).resolve().parent
AUDIO_ROOT = API_ROOT / "audio_files"
AUDIO_ROOT.mkdir(exist_ok=True)

# Messenger-specific paths
PROFILE_DIR = API_ROOT / "profiles"
PROFILE_DIR.mkdir(exist_ok=True, parents=True)

PROMPTS_DIR = API_ROOT / "prompts"

CONV_ROOT = API_ROOT / "conversations"
CONV_ROOT.mkdir(exist_ok=True, parents=True)

QUIZ_DIR = API_ROOT / "quiz_items"
QUIZ_DIR.mkdir(exist_ok=True, parents=True)
DEFAULT_QUIZ_PATH = QUIZ_DIR / "default_quiz.json"

DEFAULT_PROFILE_PATH = PROFILE_DIR / "default_profile.json"
PERSONA = "sombongo"  # Current character

# Quiz scheduling: show quiz after N turns
QUIZ_TURNS_DELAY = 3

app = FastAPI(title="Story Cards Game Backend")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# --- Models ---
class LangSpec(BaseModel):
    code: str
    name: str

class Card(BaseModel):
    id: str
    type: str
    value: str
    display_text: Optional[str] = None
    image_url: Optional[str] = None
    points: Optional[int] = 5

class StartReq(BaseModel):
    story_title: Optional[str] = None
    fluent: Optional[LangSpec] = None
    learning: Optional[LangSpec] = None

class TurnReq(BaseModel):
    session_id: Optional[str]
    story_title: str
    active_cards: List[Card]
    transcript: str
    wispr_alternatives: Optional[List[Dict[str, Any]]] = None
    fluent: Optional[LangSpec]
    learning: Optional[LangSpec]

# small helper - naive silent wav generator
import wave, io

def generate_silent_wav(duration_secs: float = 0.6, sample_rate: int = 22050):
    n_frames = int(duration_secs * sample_rate)
    nchannels = 1
    sampwidth = 2
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(nchannels)
        wf.setsampwidth(sampwidth)
        wf.setframerate(sample_rate)
        silence = (0).to_bytes(2, byteorder='little', signed=True)
        wf.writeframes(silence * n_frames)
    return buf.getvalue()

# save file
def save_wav(session_id: str, turn_id: str, lang_code: str, idx: int, wav_bytes: bytes) -> str:
    safe = re.sub(r'[^a-zA-Z0-9_\-]', '_', str(session_id or 'anon'))
    folder = AUDIO_ROOT / f"session_{safe}"
    folder.mkdir(parents=True, exist_ok=True)
    filename = f"{turn_id}_{lang_code}_{idx}_{int(time.time()*1000)}.wav"
    path = folder / filename
    with open(path, 'wb') as f:
        f.write(wav_bytes)
    return f"/api/audio_file/{safe}/{filename}"

def get_cached_audio_path(text: str, locale: str) -> tuple[str, bool, Path]:
    """
    Check if audio for this text+locale already exists.
    Returns: (url_path, exists, disk_path)
    """
    # Create deterministic hash from text + locale
    hash_input = f"{text}|{locale}".encode('utf-8')
    text_hash = hashlib.md5(hash_input).hexdigest()[:12]  # First 12 chars

    # Simplified filename: cached_{locale}_{hash}.wav
    lang_short = locale.split("-")[0]
    filename = f"cached_{lang_short}_{text_hash}.wav"

    # Store in dedicated cache directory
    cache_folder = AUDIO_ROOT / "cache"
    cache_folder.mkdir(parents=True, exist_ok=True)

    disk_path = cache_folder / filename
    exists = disk_path.exists()

    # Return URL path format
    url_path = f"/api/audio_file/cache/{filename}"
    return url_path, exists, disk_path

# fuzzy detection of card usage
def fuzzy_card_detect(transcript: str, cards: List[Card], threshold: int = 75):
    used = []
    lower = transcript.lower()
    for c in cards:
        target = (c.value or c.display_text or '').lower()
        if not target:
            continue
        if target in lower:
            used.append(c.id)
            continue
        if fuzz:
            score = fuzz.partial_ratio(target, lower)
            if score >= threshold:
                used.append(c.id)
                continue
        else:
            sm = SequenceMatcher(a=target, b=lower)
            if sm.ratio() > 0.7:
                used.append(c.id)
    return list(set(used))

# simple fixer routine for ASR alternatives
def pick_asr_fixes(wispr_alts: Optional[List[Dict[str, Any]]]):
    fixes = []
    if not wispr_alts:
        return fixes
    for token_info in wispr_alts:
        token = token_info.get('token')
        alts = token_info.get('alts') or []
        confs = token_info.get('confidences') or []
        if not alts:
            continue
        best = alts[0]
        conf = confs[0] if confs else None
        if best != token:
            fixes.append({'original': token, 'guess': best, 'confidence': conf})
    return fixes

# LLM and TTS helpers (expected to exist)
from llm_call import call_llm_for_turn
from tts_helpers import tts_bytes_for_chunk

# --- Endpoints ---
@app.post("/api/game/start")
def api_start(req: StartReq):
    title = req.story_title or "A Strange Tale"
    session_id = f"sess_{int(time.time()*1000)}"
    cards = [
        {'id': 'c_camino', 'type': 'spanish_word', 'value': 'camino', 'display_text': 'camino', 'points': 5},
        {'id': 'c_cesta', 'type': 'image', 'value': 'basket', 'display_text': 'basket', 'points': 4},
        {'id': 'c_lobo', 'type': 'spanish_word', 'value': 'lobo', 'display_text': 'lobo', 'points': 6},
        {'id': 'c_noche', 'type': 'phrase', 'value': 'por la noche', 'display_text': 'por la noche', 'points': 5},
        {'id': 'c_subj', 'type': 'grammar', 'value': 'subjunctive', 'display_text': 'use subjunctive', 'points': 8},
        {'id': 'c_arbol', 'type': 'spanish_word', 'value': 'árbol', 'display_text': 'árbol', 'points': 4},
        {'id': 'c_flor', 'type': 'spanish_word', 'value': 'flor', 'display_text': 'flor', 'points': 3},
        {'id': 'c_neg', 'type': 'constraint', 'value': 'negative', 'display_text': 'make sentence negative', 'points': 7},
        {'id': 'c_llama', 'type': 'spanish_word', 'value': 'llama', 'display_text': 'llama', 'points': 3},
    ]
    from random import shuffle
    shuffle(cards)
    active = cards[:7]
    return {'session_id': session_id, 'story_title': title, 'active_cards': active}


@app.post("/api/game/turn")
def api_turn(req: TurnReq):
    # Basic validation
    transcript = (req.transcript or "").strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="transcript required")

    fluent = req.fluent or LangSpec(code='en', name='English')
    learning = req.learning or LangSpec(code='es', name='Spanish')

    # Normalize active cards to plain dicts
    active_cards_plain = []
    for c in req.active_cards or []:
        try:
            if hasattr(c, "dict"):
                active_cards_plain.append(c.dict())
            else:
                active_cards_plain.append(c)
        except Exception:
            active_cards_plain.append(c)

    # Call LLM wrapper
    try:
        llm_out = call_llm_for_turn(
            transcript=transcript,
            active_cards=active_cards_plain,
            fluent={"code": fluent.code, "name": fluent.name},
            learning={"code": learning.code, "name": learning.name},
            wispr_alternatives=getattr(req, "wispr_alternatives", None),
        ) or {}
    except Exception as e:
        print("LLM call failed:", e)
        llm_out = {}

    corrected = llm_out.get("corrected_sentence") or transcript
    native_translation = llm_out.get("native_translation") or llm_out.get("english") or f"(translation) {transcript}"
    used_card_ids = llm_out.get("used_card_ids", llm_out.get("used_cards", []))
    asr_fixes = llm_out.get("asr_fixes", pick_asr_fixes(getattr(req, "wispr_alternatives", None)))
    brief_explanation_native = llm_out.get("brief_explanation_native") or llm_out.get("explanation", "")

    # Normalize audio_chunks
    audio_chunks = llm_out.get("audio_chunks")
    if not audio_chunks or not isinstance(audio_chunks, list) or len(audio_chunks) == 0:
        lang_tag = "es-MX" if learning.code.startswith("es") else ("id-ID" if learning.code.startswith("id") else "en-US")
        audio_chunks = [
            {"text": corrected or transcript, "lang": lang_tag, "purpose": "corrected_sentence"},
            {"text": native_translation, "lang": "en-US", "purpose": "native_translation"},
        ]

    turn_id = f"turn_{int(time.time()*1000)}"
    session_safe = req.session_id or f"sess_{int(time.time()*1000)}"

    audio_files = []
    for idx, chunk in enumerate(audio_chunks):
        try:
            text = str(chunk.get("text", "") or "")
            lang = str(chunk.get("lang", "en-US") or "en-US")
            purpose = chunk.get("purpose")
            try:
                wav_bytes = tts_bytes_for_chunk(text, lang)
            except Exception as e:
                print("TTS generation failed for chunk (falling back to silence):", e)
                wav_bytes = generate_silent_wav(duration_secs=min(3.5, 0.25 * max(1, len(text.split()))))
            lang_short = (lang.split("-")[0] if isinstance(lang, str) else "en")
            file_path = save_wav(session_safe, turn_id, lang_short, idx, wav_bytes)
            audio_files.append({"purpose": purpose, "audio_file": file_path, "lang": lang})
        except Exception as e:
            print("Failed to create audio chunk:", e)
            continue

    audio_file_en = None
    audio_file_learning = None
    for af in audio_files:
        try:
            lang = (af.get("lang") or "").lower()
            purpose = af.get("purpose") or ""
            if (not audio_file_en) and (purpose == "native_translation" or lang.startswith("en")):
                audio_file_en = af.get("audio_file")
            if (not audio_file_learning) and (purpose == "corrected_sentence" or (learning and lang.startswith(learning.code[:2]))):
                audio_file_learning = af.get("audio_file")
        except Exception:
            continue

    response = {
        "turn_id": turn_id,
        "corrected_sentence": corrected,
        "native_translation": native_translation,
        "used_card_ids": used_card_ids,
        "asr_fixes": asr_fixes,
        "brief_explanation_native": brief_explanation_native,
        "notes": llm_out.get("notes", ""),
        "audio_files": audio_files,
        "audio_file_en": audio_file_en,
        "audio_file_learning": audio_file_learning,
        "new_cards": llm_out.get("new_cards", []),
    }

    return response


@app.get("/api/audio_file/{session}/{filename}")
def serve_audio(session: str, filename: str):
    # Handle both session_X and messenger_X formats
    if session.startswith("messenger_"):
        path = AUDIO_ROOT / session / filename
    else:
        path = AUDIO_ROOT / f"session_{session}" / filename

    if not path.exists():
        raise HTTPException(status_code=404, detail="audio not found")
    return FileResponse(path, media_type="audio/wav", filename=filename)

@app.get("/api/config")
def get_config():
    """Return configuration info including mock mode status"""
    return {
        "mock_mode": MOCK_MODE,
        "has_azure_tts": bool(AZURE_SPEECH_KEY and AZURE_REGION)
    }


# --- Greeting Suggestions Endpoint ---

import random

I18N_DIR = API_ROOT / "i18n" / "greetings"
GREETING_AUDIO_DIR = AUDIO_ROOT / "greetings"

class GreetingSuggestion(BaseModel):
    id: str
    text_native: str  # English translation (for display)
    text_target: str  # Target language text
    audio_file: Optional[str] = None  # URL path to pre-generated audio

@app.get("/api/greetings/random")
def get_random_greetings(
    target_lang: str = "es",
    ui_lang: str = "en",
    count: int = 3
):
    """
    Get random greeting suggestions for the target language.
    Returns greetings with pre-generated audio file paths if available.
    """
    # Load greetings for target language
    greetings_file = I18N_DIR / f"{target_lang}.json"
    if not greetings_file.exists():
        return {"greetings": []}

    with open(greetings_file, 'r', encoding='utf-8') as f:
        all_greetings = json.load(f)

    # Weighted random selection WITHOUT replacement (no duplicates)
    # We pick one at a time, removing selected items from the pool
    selected = []
    available = list(all_greetings)  # Copy to avoid modifying original
    pick_count = min(count, len(available))

    for _ in range(pick_count):
        if not available:
            break
        weights = [g.get("weight", 1.0) for g in available]
        chosen = random.choices(available, weights=weights, k=1)[0]
        selected.append(chosen)
        available.remove(chosen)  # Remove to prevent duplicates

    # Build response with audio file paths
    result = []
    for g in selected:
        greeting_id = g.get("id")
        audio_path = GREETING_AUDIO_DIR / target_lang / f"{greeting_id}.wav"

        audio_url = None
        if audio_path.exists():
            audio_url = f"/api/audio_file/greetings/{target_lang}/{greeting_id}.wav"

        result.append(GreetingSuggestion(
            id=greeting_id,
            text_native=g.get("translation_en", g.get("text")),  # Show English translation
            text_target=g.get("text"),  # Target language text
            audio_file=audio_url
        ))

    return {"greetings": result}


@app.get("/api/audio_file/greetings/{lang}/{filename}")
def serve_greeting_audio(lang: str, filename: str):
    """Serve pre-generated greeting audio files."""
    path = GREETING_AUDIO_DIR / lang / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="greeting audio not found")
    return FileResponse(path, media_type="audio/wav", filename=filename)


# --- Trivia Game Endpoints ---

class TriviaCheckReq(BaseModel):
    session_id: str
    user_answer: str
    correct_answer: str  # The correct answer in the learning language
    prompt_text: str  # The prompt text in the fluent language
    learning: Optional[LangSpec] = None
    fluent: Optional[LangSpec] = None


class TriviaAudioReq(BaseModel):
    text: str
    locale: str  # es-MX, en-US, id-ID


@app.post("/api/trivia/check")
def api_trivia_check(req: TriviaCheckReq):
    """
    Validate user's answer against correct answer using LLM.
    Works for any language pair (English-Spanish, Indonesian-English, English-Indonesian).
    Returns: { is_correct: bool, feedback: str, corrected_answer: str }
    """
    from llm_call import check_trivia_answer

    fluent = req.fluent or LangSpec(code='en', name='English')
    learning = req.learning or LangSpec(code='es', name='Spanish')

    try:
        result = check_trivia_answer(
            user_answer=req.user_answer,
            correct_answer=req.correct_answer,
            english_prompt=req.prompt_text,
            fluent=fluent.dict(),
            learning=learning.dict(),
        )

        return {
            "is_correct": result.get("is_correct", False),
            "feedback": result.get("feedback", ""),
            "corrected_answer": result.get("corrected_answer", req.correct_answer),
        }
    except Exception as e:
        print("Trivia check failed:", e)
        import traceback
        traceback.print_exc()
        return {
            "is_correct": False,
            "feedback": "Unable to check answer. Please try again.",
            "corrected_answer": req.correct_answer,
        }


@app.post("/api/trivia/audio")
def api_trivia_audio(req: TriviaAudioReq):
    """
    Generate TTS audio for given text and locale (with caching).
    Returns: { audio_file: str (URL path) }
    """
    from tts_helpers import tts_bytes_for_chunk

    try:
        # Check cache first
        url_path, exists, disk_path = get_cached_audio_path(req.text, req.locale)

        if exists:
            # Cache hit - return existing audio URL
            print(f"[CACHE HIT] Returning cached audio for: {req.text[:30]}...")
            return {"audio_file": url_path}

        # Cache miss - generate new audio
        print(f"[CACHE MISS] Generating audio for: {req.text[:30]}...")
        wav_bytes = tts_bytes_for_chunk(req.text, req.locale)

        # Save to cache location
        with open(disk_path, 'wb') as f:
            f.write(wav_bytes)

        return {"audio_file": url_path}
    except Exception as e:
        print("TTS generation failed:", e)
        import traceback
        traceback.print_exc()
        # Return silent audio as fallback (don't cache fallback audio)
        wav_bytes = generate_silent_wav(duration_secs=1.0)
        file_path = save_wav("trivia", f"silent_{int(time.time()*1000)}", "en", 0, wav_bytes)
        return {"audio_file": file_path}


# ===== MESSENGER CHAT SYSTEM =====
# Persona-based adaptive language learning chat (single user, single persona)

import json

# --- Premade Conversations ---
# In-memory state tracking for premade scripted conversations
premade_sessions: Dict[str, Dict] = {}
# Key: session_id, Value: { "conversation": <conv_data>, "turn_index": int }

def load_premade_conversations() -> list:
    """Load premade conversations from JSON file."""
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

# --- Messenger Pydantic Models ---

class ProfileInitRequest(BaseModel):
    ui_language: Optional[LangSpec] = LangSpec(code="en", name="English")
    target_language: Optional[LangSpec] = LangSpec(code="es", name="Spanish")

class MessengerTurnRequest(BaseModel):
    user_input: str
    session_id: str

class ResponseChunk(BaseModel):
    text: str
    language: str  # "ui" | "target"
    modality: str  # "text" | "audio"
    audio_file: Optional[str] = None
    locale: Optional[str] = None
    purpose: Optional[str] = None

class SuggestedReply(BaseModel):
    id: str  # e.g. "r1", "r2", "r3"
    text_native: str  # Text in user's native/UI language
    text_target: str  # Text in target language

class TokenUsage(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cost_cents: float

class MessengerTurnResponse(BaseModel):
    turn_id: str
    corrected_input: str
    had_errors: bool
    error_explanation: str
    response_chunks: List[ResponseChunk]
    suggested_replies: Optional[List[SuggestedReply]] = []
    profile_updated: bool
    new_level: Optional[str] = None
    token_usage: Optional[TokenUsage] = None
    pending_quiz: Optional[Dict[str, Any]] = None  # Quiz item to show user


# --- Quiz Item Models ---

class QuizCandidate(BaseModel):
    type: str  # "correction" or "translation"
    original: str  # What user said (wrong or in native language)
    corrected: str  # The correct target language - THIS IS THE ANSWER
    error_type: str
    quiz_prompt: str  # Question in UI language

class QuizItem(BaseModel):
    id: str
    type: str  # "correction" or "translation"
    original: str  # What user said
    corrected: str  # Correct target language - THIS IS THE ANSWER
    error_type: str
    quiz_prompt: str  # Question in UI language (e.g., "How do you say 'store' in Spanish?")
    created_at: int
    created_at_turn: int  # Turn number when created
    show_after_turn: int  # Show quiz after this turn number
    times_reviewed: int = 0
    last_reviewed: Optional[int] = None
    mastery_level: int = 0  # 0=new, 1=learning, 2=familiar, 3=mastered
    is_answered: bool = False

class QuizAnswerRequest(BaseModel):
    quiz_id: str
    user_answer: str

class QuizAnswerResponse(BaseModel):
    is_correct: bool
    feedback: str
    correct_answer: str
    mastery_level: int


# --- Quiz Storage Functions ---

def load_quiz_items() -> List[Dict[str, Any]]:
    """Load quiz items from JSON file."""
    if not DEFAULT_QUIZ_PATH.exists():
        return []
    with open(DEFAULT_QUIZ_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)

def save_quiz_items(items: List[Dict[str, Any]]) -> None:
    """Save quiz items to JSON file."""
    with open(DEFAULT_QUIZ_PATH, 'w', encoding='utf-8') as f:
        json.dump(items, f, ensure_ascii=False, indent=2)

def add_quiz_item(candidate: Dict[str, Any], turn_count: int) -> Dict[str, Any]:
    """Add a new quiz item from a quiz candidate."""
    items = load_quiz_items()

    # The answer IS the "corrected" field
    corrected = candidate.get("corrected", "")
    quiz_prompt = candidate.get("quiz_prompt", "") or candidate.get("quiz_question", "") or candidate.get("prompt_native", "")

    if not corrected:
        return None

    # Check for duplicates (same corrected answer)
    for item in items:
        existing_answer = item.get("corrected", "")
        if existing_answer.lower() == corrected.lower():
            # Already exists, skip
            return None

    new_item = {
        "id": f"quiz_{int(time.time() * 1000)}_{len(items)}",
        "type": candidate.get("type", "correction"),
        "original": candidate.get("original", ""),
        "corrected": corrected,  # THIS IS THE ANSWER
        "error_type": candidate.get("error_type", "unknown"),
        "quiz_prompt": quiz_prompt,
        "created_at": int(time.time()),
        "created_at_turn": turn_count,
        "show_after_turn": turn_count + QUIZ_TURNS_DELAY,
        "times_reviewed": 0,
        "last_reviewed": None,
        "mastery_level": 0,
        "is_answered": False
    }

    items.append(new_item)
    save_quiz_items(items)
    return new_item

def get_pending_quiz(turn_count: int) -> Optional[Dict[str, Any]]:
    """Get a quiz item that's ready to be shown (based on turn count)."""
    items = load_quiz_items()

    # Filter items that are ready and not yet mastered
    pending = [
        item for item in items
        if item.get("show_after_turn", 0) <= turn_count
        and item.get("mastery_level", 0) < 3
        and not item.get("is_answered", False)
    ]

    if not pending:
        return None

    # Sort by: mastery_level ASC, times_reviewed ASC, created_at ASC
    pending.sort(key=lambda x: (
        x.get("mastery_level", 0),
        x.get("times_reviewed", 0),
        x.get("created_at", 0)
    ))

    return pending[0]

def update_quiz_item(quiz_id: str, is_correct: bool) -> Dict[str, Any]:
    """Update a quiz item after user answers."""
    items = load_quiz_items()

    for item in items:
        if item.get("id") == quiz_id:
            item["times_reviewed"] = item.get("times_reviewed", 0) + 1
            item["last_reviewed"] = int(time.time())
            item["is_answered"] = True

            if is_correct:
                # Increase mastery
                item["mastery_level"] = min(3, item.get("mastery_level", 0) + 1)
                # Schedule next review further out
                profile = load_profile()
                turn_count = profile.get("turn_count", 0)
                # Exponential backoff: 3, 6, 12 turns
                delay = QUIZ_TURNS_DELAY * (2 ** item["mastery_level"])
                item["show_after_turn"] = turn_count + delay
            else:
                # Reset mastery on wrong answer
                item["mastery_level"] = 0
                # Show again soon
                profile = load_profile()
                turn_count = profile.get("turn_count", 0)
                item["show_after_turn"] = turn_count + 1

            item["is_answered"] = False  # Allow it to be shown again
            save_quiz_items(items)
            return item

    return None


# --- Persona Loading Functions ---

def load_persona_json(persona_id: str) -> Optional[Dict[str, Any]]:
    """Load persona from JSON file."""
    persona_file = PROMPTS_DIR / "persona" / f"{persona_id}.json"
    if persona_file.exists():
        with open(persona_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    return None

def load_helper_json(helper_id: str) -> Optional[Dict[str, Any]]:
    """Load helper configuration from JSON file."""
    helper_file = PROMPTS_DIR / "helpers" / f"{helper_id}.json"
    if helper_file.exists():
        with open(helper_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    return None


# --- Profile CRUD Functions ---

def init_default_profile(ui_lang: LangSpec, target_lang: LangSpec) -> Dict[str, Any]:
    """Create a fresh default profile."""
    now = int(time.time())
    return {
        "created_at": now,
        "last_updated": now,
        "ui_language": ui_lang.dict(),
        "target_language": target_lang.dict(),
        "level": "beginner",
        "level_confidence": 0.5,
        "level_history": [
            {"timestamp": now, "level": "beginner", "reason": "Initial profile creation"}
        ],
        "comfortable_with": [],
        "weak_points": [],
        "avoid_topics": [],
        "turn_count": 0,
        "corrections_needed": 0,
        "last_assessment_turn": 0,
        "recent_turns": []
    }

def load_profile() -> Dict[str, Any]:
    """Load profile from default_profile.json. Create if not exists."""
    if not DEFAULT_PROFILE_PATH.exists():
        # Create default profile
        profile = init_default_profile(
            LangSpec(code="en", name="English"),
            LangSpec(code="es", name="Spanish")
        )
        save_profile(profile)
        return profile

    with open(DEFAULT_PROFILE_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)

def save_profile(profile: Dict[str, Any]) -> None:
    """Save profile to default_profile.json."""
    profile["last_updated"] = int(time.time())
    with open(DEFAULT_PROFILE_PATH, 'w', encoding='utf-8') as f:
        json.dump(profile, f, ensure_ascii=False, indent=2)


# --- Prompt Construction Functions ---

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
- Set should_update=true if confident about level change (confidence >= 0.7)
- Update comfortable_with and weak_points based on observed patterns"""

    # Regular turn: light assessment + adaptive response
    return f"""Current learner level: {level}
- Provide natural persona response following language mix rules (70-80% UI, 15-25% target text, 5-10% target audio)
- Correct at most 1-2 high-priority errors gently
- Show corrected version and explain briefly in UI language
- Assess if this turn shows level change signals (set confidence accordingly)
- Decide response mode per chunk: use target audio for new vocab/patterns appropriate to level"""

def build_layered_prompt(user_input: str, profile: Dict[str, Any]) -> tuple:
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

    # Load helper configurations
    suggestion_config = load_helper_json("suggestion_system") or {}
    pico_config = load_helper_json("pico_grammar_robot") or {}

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

    # Combine system layers
    full_system = "\n\n".join([
        system_filled,
        persona_prompt,
        student_context
    ])

    # Layer 4: Conversation Context
    context_str = build_conversation_context(profile.get("recent_turns", []))

    # Layer 5: Turn Instruction
    turn_instruction = generate_turn_instruction(profile)

    # Build user message
    max_suggestions = suggestion_config.get("max_suggestions", 3)

    user_message = f"""{context_str}

CURRENT USER INPUT: {user_input}

{turn_instruction}

OUTPUT SCHEMA (return exactly one JSON object):
{{
  "corrected_input": "...",  // The corrected version of user's input in {target_lang}. If no correction needed, copy user input exactly.
  "had_errors": true/false,  // ONLY true if corrected_input is DIFFERENT from user input. If they're the same, set false.
  "error_explanation": "...",  // Brief explanation in {ui_lang}. Only needed if had_errors=true.
  "response_chunks": [
    {{
      "text": "...",  // MOST chunks should have language="ui" (speak in {ui_lang}). Only use "target" for teaching vocabulary/phrases.
      "language": "ui" | "target",  // "ui" = {ui_lang}, "target" = {target_lang}
      "modality": "text" | "audio",
      "locale": "{target_code}-XX" | "{ui_code}-XX",  // if modality=="audio"
      "purpose": "greeting" | "question" | "feedback" | "encouragement"
    }}
  ],
  "suggested_replies": [
    {{
      "id": "r1",
      "text_native": "...",  // Short suggestion in {ui_lang}
      "text_target": "..."   // Translation in {target_lang}
    }}
  ],  // Generate {max_suggestions} varied suggestions (mix of: question, followup, empathy)
  "quiz_candidates": [
    {{
      "type": "correction" | "translation",
      "original": "sunscreen",
      "corrected": "bloqueador solar",
      "error_type": "vocabulary",
      "quiz_prompt": "How do you say 'sunscreen' in Spanish?"
    }}
  ],
  // NOTE: "corrected" field IS the answer. "quiz_prompt" is the question in {ui_lang}.
  // The user will see quiz_prompt and must answer with "corrected".
  "level_assessment": {{
    "current_level": "beginner" | "intermediate" | "advanced",
    "confidence": 0.0-1.0,
    "should_update": true/false,
    "reasoning": "...",
    "add_comfortable": [],
    "add_weak": [],
    "remove_weak": []
  }}
}}

CRITICAL REMINDERS:
- Your response_chunks should be MOSTLY in {ui_lang} (language="ui"). Only use "target" sparingly for teaching.
- If the user's sentence has no errors, set had_errors=false and copy user input to corrected_input verbatim.
- Stay in character! Your personality should come through IN {ui_lang}.
- If user writes in {ui_lang} or mixes languages, provide the full {target_lang} translation in corrected_input.

QUIZ CANDIDATE RULES:
- ONLY tag SIGNIFICANT errors (verb conjugation, gender, prepositions, vocabulary gaps, grammar structure, ser/estar, por/para)
- DO NOT tag minor errors (accents, punctuation, typos, capitalization)
- For vocabulary gaps (user used {ui_lang}), type="translation"
- For grammar/conjugation errors, type="correction"
- "original": what the user said (wrong or in native language)
- "corrected": the correct {target_lang} word/phrase (THIS IS THE QUIZ ANSWER)
- "quiz_prompt": question in {ui_lang} like "How do you say 'X' in {target_lang}?"

SUGGESTION GENERATION RULES:
- Generate {max_suggestions} short, natural replies the user might want to say
- Show suggestions in {ui_lang} (text_native) with translations in {target_lang} (text_target)
- Vary the types: one question, one empathetic response, one playful/challenge
- Keep suggestions brief (5-10 words max)
- Match the character's personality and context

Return ONLY valid JSON (no markdown, no commentary)."""

    return full_system, user_message


# --- Level Assessment Logic ---

def update_profile_from_assessment(
    profile: Dict[str, Any],
    assessment: Dict[str, Any]
) -> tuple:
    """Update profile based on LLM assessment. Returns (profile, profile_updated)."""
    current_level = profile.get("level", "beginner")
    new_level = assessment.get("current_level", current_level)
    confidence = assessment.get("confidence", 0.5)
    should_update = assessment.get("should_update", False)

    # Update comfortable_with
    for item in assessment.get("add_comfortable", []):
        if item not in profile["comfortable_with"]:
            profile["comfortable_with"].append(item)

    # Update weak_points
    for item in assessment.get("add_weak", []):
        if item not in profile["weak_points"]:
            profile["weak_points"].append(item)

    for item in assessment.get("remove_weak", []):
        if item in profile["weak_points"]:
            profile["weak_points"].remove(item)

    # Update level if assessment says so and confidence is high
    if should_update and confidence >= 0.7 and new_level != current_level:
        profile["level"] = new_level
        profile["level_confidence"] = confidence
        profile["level_history"].append({
            "timestamp": int(time.time()),
            "level": new_level,
            "reason": assessment.get("reasoning", "LLM assessment")
        })
        return profile, True  # profile_updated flag

    # Just update confidence even if not changing level
    profile["level_confidence"] = confidence
    return profile, False


# --- Messenger Endpoints ---

@app.post("/api/messenger/profile/init")
def messenger_init_profile(req: ProfileInitRequest):
    """Initialize a new default profile."""
    profile = init_default_profile(req.ui_language, req.target_language)
    save_profile(profile)
    return {"profile": profile}

@app.get("/api/messenger/profile")
def messenger_get_profile():
    """Get the default profile (creates if not exists)."""
    profile = load_profile()
    return {"profile": profile}

class PremadeStartRequest(BaseModel):
    session_id: str

@app.post("/api/messenger/premade-start")
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


@app.post("/api/messenger/turn")
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
    system_prompt, user_message = build_layered_prompt(req.user_input, profile)

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

        llm_response = {
            "corrected_input": req.user_input,
            "had_errors": False,
            "error_explanation": "",
            "response_chunks": [
                {
                    "text": "¡Hola! How can I help you today?",
                    "language": "ui",
                    "modality": "text",
                    "purpose": "greeting"
                }
            ],
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
            locale = chunk_dict.get("locale", "es-MX")
            text = chunk_dict["text"]

            # Generate TTS
            try:
                wav_bytes = tts_bytes_for_chunk(text, locale)
            except Exception as e:
                print(f"TTS failed for chunk, using silence: {e}")
                wav_bytes = generate_silent_wav(duration_secs=min(3.0, 0.25 * len(text.split())))

            # Save audio file
            safe_session = re.sub(r'[^a-zA-Z0-9_\-]', '_', str(req.session_id))
            session_dir = AUDIO_ROOT / f"messenger_{safe_session}"
            session_dir.mkdir(parents=True, exist_ok=True)

            ts = int(time.time() * 1000)
            lang_code = locale.split('-')[0] if locale else "unknown"
            filename = f"{turn_id}_{lang_code}_{ts}.wav"
            filepath = session_dir / filename

            with open(filepath, "wb") as f:
                f.write(wav_bytes)

            chunk_dict["audio_file"] = f"/api/audio_file/messenger_{safe_session}/{filename}"

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
    return MessengerTurnResponse(
        turn_id=turn_id,
        corrected_input=llm_response.get("corrected_input", req.user_input),
        had_errors=llm_response.get("had_errors", False),
        error_explanation=llm_response.get("error_explanation", ""),
        response_chunks=processed_chunks,
        suggested_replies=suggested_replies,
        profile_updated=profile_updated,
        new_level=profile["level"] if profile_updated else None,
        token_usage=token_usage,
        pending_quiz=pending_quiz
    )


# ===== GUESSING GAME SYSTEM =====
# LLM picks a secret (e.g., animal), user asks yes/no questions to guess

# In-memory session storage for guessing games
guessing_sessions = {}

class GuessingTurnRequest(BaseModel):
    session_id: str
    theme: str  # "animals", "mythical", etc.
    user_input: str
    guess_count: int

class GuessingGiveUpRequest(BaseModel):
    session_id: str
    theme: str

class GuessingTurnResponse(BaseModel):
    response: str
    is_correct_guess: bool
    answer: Optional[str] = None
    audio_file: Optional[str] = None
    corrected_input: Optional[str] = None
    had_errors: Optional[bool] = False
    error_explanation: Optional[str] = None

class GuessingGiveUpResponse(BaseModel):
    reveal_message: str
    answer: str


@app.post("/api/guessing/turn")
def guessing_game_turn(req: GuessingTurnRequest):
    """
    Process user's question or guess in the guessing game.
    On first turn: LLM picks a secret answer.
    Returns: { response: str, is_correct_guess: bool, answer: str | null }
    """
    from llm_call import call_llm_for_guessing_turn

    session_id = req.session_id

    # Initialize session if new
    if session_id not in guessing_sessions:
        # First turn - LLM picks the secret answer
        from llm_call import call_llm_to_pick_secret

        secret = call_llm_to_pick_secret(req.theme)
        guessing_sessions[session_id] = {
            "theme": req.theme,
            "secret": secret,
            "history": []
        }

    session = guessing_sessions[session_id]
    secret = session["secret"]

    # Call LLM to respond to user's question
    llm_response = call_llm_for_guessing_turn(
        user_input=req.user_input,
        secret=secret,
        theme=req.theme,
        history=session["history"]
    )

    # Add to history
    session["history"].append({
        "user": req.user_input,
        "response": llm_response["response"]
    })

    response_text = llm_response["response"]
    is_correct = llm_response.get("is_correct_guess", False)

    return GuessingTurnResponse(
        response=response_text,
        is_correct_guess=is_correct,
        answer=secret if is_correct else None,
        audio_file=None,  # TODO: Add TTS if needed
        corrected_input=llm_response.get("corrected_input"),
        had_errors=llm_response.get("had_errors", False),
        error_explanation=llm_response.get("error_explanation")
    )


@app.post("/api/guessing/giveup")
def guessing_game_giveup(req: GuessingGiveUpRequest):
    """
    Reveal the answer when user gives up.
    Returns: { reveal_message: str, answer: str }
    """
    session_id = req.session_id

    if session_id not in guessing_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = guessing_sessions[session_id]
    secret = session["secret"]

    # Clean up session
    del guessing_sessions[session_id]

    return GuessingGiveUpResponse(
        reveal_message=f"Nice try! The answer was:",
        answer=secret
    )


# ===== QUIZ REVIEW SYSTEM =====
# Spaced repetition quizzes based on corrections made during chat

def normalize_answer(text: str) -> str:
    """Normalize answer for comparison (lowercase, strip, remove extra spaces)."""
    import unicodedata
    if not text:
        return ""
    # Normalize unicode
    text = unicodedata.normalize('NFC', text)
    # Lowercase and strip
    text = text.lower().strip()
    # Remove punctuation except apostrophes
    text = re.sub(r'[^\w\s\']', '', text)
    # Normalize whitespace
    text = re.sub(r'\s+', ' ', text)
    return text

def check_answer_locally(user_answer: str, correct_answer: str) -> tuple:
    """
    Check if user answer matches correct answer locally.
    Returns (is_match, confidence).
    """
    norm_user = normalize_answer(user_answer)
    norm_correct = normalize_answer(correct_answer)

    # Exact match
    if norm_user == norm_correct:
        return True, 1.0

    # Check with SequenceMatcher
    ratio = SequenceMatcher(None, norm_user, norm_correct).ratio()
    if ratio >= 0.85:  # Very close match
        return True, ratio

    return False, ratio


@app.post("/api/quiz/check")
def check_quiz_answer(req: QuizAnswerRequest):
    """
    Check user's quiz answer. First tries local matching, then LLM if needed.
    """
    from llm_call import check_trivia_answer

    # Load the quiz item
    items = load_quiz_items()
    quiz_item = None
    for item in items:
        if item.get("id") == req.quiz_id:
            quiz_item = item
            break

    if not quiz_item:
        raise HTTPException(status_code=404, detail="Quiz item not found")

    # The answer is the "corrected" field
    correct_answer = quiz_item.get("corrected", "")

    # Try local matching first
    is_correct, confidence = check_answer_locally(req.user_answer, correct_answer)

    if confidence >= 0.85:
        # High confidence local match
        feedback = "Correct! Great job!" if is_correct else f"Not quite. The answer is: {correct_answer}"
    elif confidence >= 0.5:
        # Medium confidence - use LLM to verify
        profile = load_profile()
        quiz_prompt = quiz_item.get("quiz_prompt", "")
        llm_result = check_trivia_answer(
            user_answer=req.user_answer,
            correct_answer=correct_answer,
            english_prompt=quiz_prompt,
            fluent=profile.get("ui_language", {"code": "en", "name": "English"}),
            learning=profile.get("target_language", {"code": "es", "name": "Spanish"})
        )
        is_correct = llm_result.get("is_correct", False)
        feedback = llm_result.get("feedback", "")
    else:
        # Low confidence - wrong answer
        is_correct = False
        feedback = f"Not quite. The answer is: {correct_answer}"

    # Update quiz item
    updated_item = update_quiz_item(req.quiz_id, is_correct)

    return QuizAnswerResponse(
        is_correct=is_correct,
        feedback=feedback,
        correct_answer=correct_answer,
        mastery_level=updated_item.get("mastery_level", 0) if updated_item else 0
    )


@app.get("/api/quiz/pending")
def get_quiz_pending():
    """Get the next pending quiz item."""
    profile = load_profile()
    turn_count = profile.get("turn_count", 0)
    pending = get_pending_quiz(turn_count)
    return {"quiz": pending}


# --- Battle Mode Endpoint ---

class BattleCheckReq(BaseModel):
    session_id: str
    user_answer: str
    correct_answer: str
    accepted_translations: Optional[List[str]] = None
    valid_phrases: Optional[List[str]] = None
    prompt_text: str
    learning: Optional[LangSpec] = None
    fluent: Optional[LangSpec] = None


@app.post("/api/battle/check")
def api_battle_check(req: BattleCheckReq):
    """
    Check battle answer - reuses trivia check logic.
    Fuzzy match first, then LLM semantic fallback.
    """
    from llm_call import check_trivia_answer

    fluent = req.fluent or LangSpec(code='en', name='English')
    learning = req.learning or LangSpec(code='es', name='Spanish')

    try:
        result = check_trivia_answer(
            user_answer=req.user_answer,
            correct_answer=req.correct_answer,
            english_prompt=req.prompt_text,
            fluent=fluent.dict(),
            learning=learning.dict(),
            accepted_translations=req.accepted_translations,
            valid_phrases=req.valid_phrases,
        )

        return {
            "accepted": result.get("accepted", False),
            "damage_multiplier": result.get("damage_multiplier", 0.0),
            "issues": result.get("issues", []),
            "feedback_key": result.get("feedback_key", None),
            "corrected_snippet": result.get("corrected_snippet", None),
            "feedback_explanation": result.get("feedback_explanation", None),
            "correction_tokens": result.get("correction_tokens", None),
            "fast_path": result.get("fast_path", False),
            "token_usage": result.get("token_usage"),
        }
    except Exception as e:
        print("Battle check failed:", e)
        import traceback
        traceback.print_exc()
        return {
            "accepted": False,
            "damage_multiplier": 0.0,
            "feedback_key": None,
            "corrected_snippet": None,
            "token_usage": None,
        }


@app.get("/api/quiz/stats")
def get_quiz_stats():
    """Get quiz statistics."""
    items = load_quiz_items()

    total = len(items)
    mastered = len([i for i in items if i.get("mastery_level", 0) >= 3])
    learning = len([i for i in items if 0 < i.get("mastery_level", 0) < 3])
    new = len([i for i in items if i.get("mastery_level", 0) == 0])

    return {
        "total": total,
        "mastered": mastered,
        "learning": learning,
        "new": new
    }
