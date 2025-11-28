from dotenv import load_dotenv
import os
import time
import re
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
    path = AUDIO_ROOT / f"session_{session}" / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="audio not found")
    return FileResponse(path, media_type="audio/wav", filename=filename)
