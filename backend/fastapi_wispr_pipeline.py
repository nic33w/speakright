# fastapi_wispr_pipeline.py
import os
import json
import base64
import io
import wave
import logging
from typing import Optional, List, Dict, Any
import time
import re

import requests
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from pathlib import Path

# load .env if present
from dotenv import load_dotenv

env_path = Path(__file__).resolve().parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

# --- basic paths ---
AUDIO_ROOT = Path(__file__).resolve().parent / "audio_files"
AUDIO_ROOT.mkdir(exist_ok=True, parents=True)

CONV_ROOT = Path(__file__).resolve().parent / "conversations"
CONV_ROOT.mkdir(exist_ok=True, parents=True)

# --- defaults / voices ---
DEFAULT_VOICE_BY_LANG = {
    "es": os.getenv("AZURE_VOICE_ES", "es-MX-LucianoNeural"),
    "en": os.getenv("AZURE_VOICE_EN", "en-US-RyanMultilingualNeural"),
    "id": os.getenv("AZURE_VOICE_ID", "id-ID-ArdiNeural"),
}

# Logging early
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- OpenAI client compatibility / migration ---
try:
    from openai import OpenAI as OpenAIClientClass  # modern client
except Exception:
    OpenAIClientClass = None

MOCK_MODE = os.getenv("MOCK_MODE", "1") == "1"

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
AZURE_SPEECH_KEY = os.getenv("AZURE_SPEECH_KEY")
AZURE_REGION = os.getenv("AZURE_REGION")

if not OPENAI_API_KEY:
    if not MOCK_MODE:
        raise RuntimeError("Please set OPENAI_API_KEY or enable MOCK_MODE for local testing.")
    else:
        logger.info("OPENAI_API_KEY not set; running in MOCK_MODE.")

# create OpenAI client if possible
openai_client = None
if OPENAI_API_KEY and not MOCK_MODE:
    if OpenAIClientClass is not None:
        try:
            openai_client = OpenAIClientClass(api_key=OPENAI_API_KEY)
            logger.info("Created OpenAI client (modern SDK).")
        except Exception as e:
            logger.warning("Failed to create OpenAI client: %s", e)
            openai_client = None
    else:
        logger.warning(
            "OpenAI client class not found. If you have openai>=1.0 installed, ensure it exposes 'OpenAI'. "
            "Alternatively pin openai==0.28.0 to use legacy API."
        )

app = FastAPI(title="Wispr pipeline multi-sentence example")

# CORS: add your dev origins
allow_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

AUDIO_CACHE: Dict[str, bytes] = {}

# --- Request models ---
class LangSpec(BaseModel):
    code: str
    name: str

class TranscriptRequest(BaseModel):
    session_id: Optional[str] = None
    fluent_language: Optional[LangSpec] = None
    learning_language: Optional[LangSpec] = None
    input_language: Optional[LangSpec] = None
    text: str
    source: Optional[str] = "wispr_desktop"

class ConfirmRequest(BaseModel):
    session_id: Optional[str] = None
    fluent_language: Optional[LangSpec] = None
    learning_language: Optional[LangSpec] = None
    original_pairs: Optional[List[Dict[str, str]]] = None
    confirmed_native_joined: Optional[str] = None
    original_spanish: Optional[str] = None
    confirmed_english: Optional[str] = None

# --- utilities ---
_sentence_splitter = re.compile(r'(?<=[.!?])\s+')

def simple_split_sentences(text: str) -> List[str]:
    text = text.strip()
    if not text:
        return []
    return [p.strip() for p in _sentence_splitter.split(text) if p.strip()]

def generate_silent_wav(duration_secs: float = 0.8, sample_rate: int = 22050) -> bytes:
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

def azure_tts_bytes(text: str, use_mock: bool = True) -> bytes:
    if not use_mock and AZURE_SPEECH_KEY and AZURE_REGION:
        # implement real Azure TTS call if desired
        pass
    words = max(1, len(text.split()))
    duration = min(6.0, 0.25 * words)
    return generate_silent_wav(duration_secs=duration)

def azure_tts_bytes_real(text: str, lang_code: str = "es", voice: Optional[str] = None) -> bytes:
    if not AZURE_SPEECH_KEY or not AZURE_REGION:
        raise RuntimeError("Azure TTS credentials not configured")
    voice_name = voice or DEFAULT_VOICE_BY_LANG.get(lang_code, DEFAULT_VOICE_BY_LANG["en"])
    ssml = f"""
    <speak version='1.0' xml:lang='{lang_code}'>
      <voice name='{voice_name}'>
        <prosody rate='0%' pitch='0%'>{text}</prosody>
      </voice>
    </speak>
    """.strip()
    url = f"https://{AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1"
    headers = {
        "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "riff-16khz-16bit-mono-pcm",
        "User-Agent": "wispr-sample",
    }
    resp = requests.post(url, headers=headers, data=ssml.encode("utf-8"), timeout=20)
    if resp.status_code != 200:
        raise RuntimeError(f"Azure TTS failed: {resp.status_code} {resp.text}")
    return resp.content

def save_audio_file(session_id: str, turn_id: str, idx: int, text_lang: str, wav_bytes: bytes) -> str:
    safe_session = re.sub(r'[^a-zA-Z0-9_\-]', '_', str(session_id))
    session_dir = AUDIO_ROOT / f"session_{safe_session}"
    session_dir.mkdir(parents=True, exist_ok=True)
    ts = int(time.time() * 1000)
    filename = f"{turn_id}_{idx}_{text_lang}_{ts}.wav"
    filepath = session_dir / filename
    with open(filepath, "wb") as f:
        f.write(wav_bytes)
    AUDIO_CACHE[str(filename)] = wav_bytes
    return str(filename)

@app.get("/api/audio_file/{session_id}/{filename}")
async def get_audio_file(session_id: str, filename: str):
    safe_session = re.sub(r'[^a-zA-Z0-9_\-]', '_', str(session_id))
    path = AUDIO_ROOT / f"session_{safe_session}" / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="audio not found")
    return FileResponse(path, media_type="audio/wav", filename=filename)

def language_style_instruction(learning: LangSpec):
    if learning.code == "es":
        return "Prefer Latin American Spanish (neutral, conversational — lean Mexican/Latin American phrasing rather than Spain/Castilian). Use natural, colloquial phrasing where appropriate."
    if learning.code == "id":
        return "Use a casual, conversational Indonesian register (not overly formal)."
    return ""

# --- OpenAI helpers (modern client) ---
def _ensure_openai_client():
    if MOCK_MODE:
        raise RuntimeError("OpenAI not required in MOCK_MODE")
    if openai_client is None:
        raise RuntimeError(
            "OpenAI client not configured. Ensure you have openai>=1.0 installed and OPENI_API_KEY set, "
            "or pin openai==0.28.0 and adapt code accordingly."
        )

def call_openai_split_and_translate(text: str, input_lang: LangSpec, out_lang: LangSpec) -> List[Dict[str, str]]:
    """
    Use the modern OpenAI client (openai_client.chat.completions.create(...)).
    Returns a list of {"native": "...", "learning": "..."} objects.
    The system message makes the mapping explicit so 'native' is the translated/out language
    and 'learning' is the original input sentence.
    """
    _ensure_openai_client()
    system = f"""
You are a translator and sentence aligner.
- INPUT (original text): {input_lang.name} (code: {input_lang.code})
- OUTPUT / NATIVE (translated text): {out_lang.name} (code: {out_lang.code})
Task: split the input into sentences and return ONLY a JSON array:
[{{"native":"<translated into OUTPUT/NATIVE>", "learning":"<original INPUT sentence>"}}, ...]
If input_lang == out_lang, you may copy text into both fields.
""".strip()
    user = f"Text: \"{text.strip()}\""

    resp = openai_client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=0.0,
        max_tokens=1500,
    )

    # resp structure differs depending on SDK version; try to extract text robustly
    try:
        content = resp.choices[0].message["content"].strip()
    except Exception:
        try:
            content = resp.choices[0].message.content.strip()
        except Exception:
            content = str(resp)

    try:
        return json.loads(content)
    except Exception:
        start = content.find("[")
        end = content.rfind("]")
        if start != -1 and end != -1:
            return json.loads(content[start:end+1])
        raise

def call_openai_confirm_from_native(confirmed_native_joined: str, fluent: LangSpec, learning: LangSpec, original_pairs=None) -> Dict[str, Any]:
    """
    Ask OpenAI to return 'corrected_pairs' and 'reply_pairs' arrays (aligned), plus an explanation.
    IMPORTANT: correction_explanation must be returned in the fluent/native language only.
    """
    _ensure_openai_client()
    system = (
        f"You are a helpful teacher and native speaker. The session fluent/native language is {fluent.name} ({fluent.code}), "
        f"the learning language is {learning.name} ({learning.code}).\n"
        + language_style_instruction(learning) +
        "\nGiven the user's confirmed native-language text (possibly multi-sentence), return a JSON object with the following fields:\n"
        "  - corrected_pairs: an array of objects {native, learning} (native = fluent language text, learning = target/learning language)\n"
        "  - reply_pairs: an array of objects {native, learning} for a natural follow-up reply\n"
        "  - correction_explanation: a single-sentence explanation written IN THE FLUENT/NATIVE LANGUAGE (not the learning language)\n"
        "Respond with ONLY valid JSON."
    )
    user_msg = f"confirmed_native_joined: \"{confirmed_native_joined}\""
    if original_pairs:
        user_msg += f"\noriginal_pairs: {json.dumps(original_pairs)}"

    resp = openai_client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user_msg}],
        temperature=0.2,
        max_tokens=1200,
    )

    try:
        content = resp.choices[0].message["content"].strip()
    except Exception:
        try:
            content = resp.choices[0].message.content.strip()
        except Exception:
            content = str(resp)

    try:
        return json.loads(content)
    except Exception:
        start = content.find("{")
        end = content.rfind("}")
        if start != -1 and end != -1:
            return json.loads(content[start:end+1])
        raise

# --- Endpoints ---

@app.post("/api/transcript")
async def receive_transcript(req: TranscriptRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    fluent = req.fluent_language or LangSpec(code="en", name="English")
    learning = req.learning_language or LangSpec(code="es", name="Spanish")
    input_lang = req.input_language or learning

    if MOCK_MODE:
        sentences = simple_split_sentences(text)
        pairs = []
        count = 1
        for s in sentences:
            native = f"English sentence {count} for {s[:200]}".strip()
            count += 1
            pairs.append({"native": native, "learning": s})
        return JSONResponse({"turn_id": f"turn_{generate_id()}", "user_pairs": pairs})

    try:
        pairs = call_openai_split_and_translate(text, input_lang, fluent)
        return JSONResponse({"turn_id": f"turn_{generate_id()}", "user_pairs": pairs})
    except Exception as e:
        logger.exception("transcript real mode failed")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/confirm")
async def receive_confirm(req: ConfirmRequest, background_tasks: BackgroundTasks):
    fluent = req.fluent_language or LangSpec(code="en", name="English")
    learning = req.learning_language or LangSpec(code="es", name="Spanish")

    confirmed_native_joined = req.confirmed_native_joined
    if not confirmed_native_joined and req.confirmed_english:
        confirmed_native_joined = req.confirmed_english

    original_pairs = req.original_pairs or []

    if MOCK_MODE:
        # same mock behavior as before
        corrected_pairs = []
        reply_pairs = []
        if confirmed_native_joined:
            native_sentences = simple_split_sentences(confirmed_native_joined)
            for s in native_sentences:
                learning_text = f"(mock {learning.code}) {s[:180]}".strip()
                corrected_pairs.append({"native": s, "learning": learning_text})
        elif original_pairs:
            for p in original_pairs:
                corrected_pairs.append({"native": p.get("native", ""), "learning": p.get("learning", "")})
        else:
            corrected_pairs = [{"native": "(mock) OK", "learning": "(mock) OK"}]

        reply_sentences = ["(mock) Sure — that works.", "¿Cuántas personas?"]
        for r in reply_sentences:
            native = r if fluent.code == "en" else f"(mock {fluent.code}) {r}"
            learning_text = f"(mock {learning.code}) reply for: {r}"
            reply_pairs.append({"native": native, "learning": learning_text})

        def attach_audio(pairs):
            out = []
            for p in pairs:
                wav = azure_tts_bytes(p.get("learning", p.get("native", "")), use_mock=True)
                b64 = base64.b64encode(wav).decode("ascii")
                out.append({**p, "audio_base64": b64})
            return out

        corrected_pairs = [{"native": "I would like to reserve a table.", "learning": "Quisiera reservar una mesa."},
                           {"native": "Is 8 OK?", "learning": "¿A las 8 está bien?"}]
        reply_pairs = [{"native": "Yes, 8 is perfect.", "learning": "Sí, a las 8 está perfecto."},
                       {"native": "How many people will you be?", "learning": "¿Cuántas personas serán?"}]
        corrected_with_audio = attach_audio(corrected_pairs)
        reply_with_audio = attach_audio(reply_pairs)

        return JSONResponse({
            "turn_id": f"turn_{generate_id()}",
            "corrected_pairs": corrected_with_audio,
            "reply_pairs": reply_with_audio,
            "correction_explanation": "Mock: minor wording adjusted for politeness."
        })

    # REAL mode
    try:
        result = call_openai_confirm_from_native(confirmed_native_joined or "", fluent, learning, original_pairs)
        corrected = result.get("corrected_pairs", [])
        reply = result.get("reply_pairs", [])
        explanation = result.get("correction_explanation", "")

        # generate TTS per sentence (synchronously write audio files so frontend can fetch it immediately)
        corrected_with_audio = []
        for idx, p in enumerate(corrected):
            text_to_speak = p.get("learning") or p.get("native")
            wav = azure_tts_bytes_real(text_to_speak, lang_code=learning.code)
            b64 = base64.b64encode(wav).decode("ascii")
            safe_session = req.session_id or f"session_{int(time.time())}"
            filename = save_audio_file(safe_session, f"turn_{int(time.time()*1000)}", idx, learning.code, wav)
            audio_file_url = f"/api/audio_file/{safe_session}/{filename}"
            corrected_with_audio.append({**p, "audio_base64": b64, "audio_file": audio_file_url, "audio_filename": filename})

        reply_with_audio = []
        for idx, p in enumerate(reply):
            text_to_speak = p.get("learning") or p.get("native")
            wav = azure_tts_bytes_real(text_to_speak, lang_code=learning.code)
            b64 = base64.b64encode(wav).decode("ascii")
            safe_session = req.session_id or f"session_{int(time.time())}"
            filename = save_audio_file(safe_session, f"turn_{int(time.time()*1000)}", idx, learning.code, wav)
            audio_file_url = f"/api/audio_file/{safe_session}/{filename}"
            reply_with_audio.append({**p, "audio_base64": b64, "audio_file": audio_file_url, "audio_filename": filename})

        # Return corrected pairs, reply pairs, and the correction explanation (explicitly in native language per prompt)
        return JSONResponse({
            "turn_id": f"turn_{generate_id()}",
            "corrected_pairs": corrected_with_audio,
            "reply_pairs": reply_with_audio,
            "correction_explanation": explanation,
        })
    except Exception as e:
        logger.exception("confirm real mode failed")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/conversations/{session_id}")
async def save_conversation(session_id: str, payload: Dict[str, Any], background_tasks: BackgroundTasks):
    if MOCK_MODE:
        return JSONResponse(status_code=204, content={"detail": "mock mode — not saving conversations"})

    messages = payload.get("messages")
    if messages is None:
        raise HTTPException(status_code=400, detail="messages field required")

    def sanitize(msgs):
        out = []
        for m in msgs:
            try:
                kind = m.get("kind")
            except Exception:
                out.append(m)
                continue
            if kind == "pair":
                pair = dict(m.get("pair", {}))
                if "audio_base64" in pair:
                    pair.pop("audio_base64", None)
                out.append({**m, "pair": pair})
            elif kind == "translation_check":
                user_pairs = []
                for p in (m.get("userPairs") or []):
                    pp = dict(p)
                    if "audio_base64" in pp:
                        pp.pop("audio_base64", None)
                    user_pairs.append(pp)
                out.append({**m, "userPairs": user_pairs})
            else:
                out.append(m)
        return out

    def _write():
        try:
            safe_session = re.sub(r'[^a-zA-Z0-9_\-]', '_', session_id)
            path = CONV_ROOT / f"session_{safe_session}.json"
            with open(path, "w", encoding="utf-8") as f:
                json.dump({
                    "session_id": session_id,
                    "messages": sanitize(messages),
                    "fluent_language": payload.get("fluent_language"),
                    "learning_language": payload.get("learning_language"),
                    "saved_at": int(time.time())
                }, f, ensure_ascii=False)
            logger.info("Saved conversation %s", path)
        except Exception:
            logger.exception("Failed to write conversation file")

    background_tasks.add_task(_write)
    return JSONResponse(status_code=200, content={"detail": "saving scheduled", "session_id": session_id})

@app.get("/api/conversations")
async def list_conversations():
    out = []
    for p in CONV_ROOT.glob("session_*.json"):
        stat = p.stat()
        try:
            with open(p, "r", encoding="utf-8") as f:
                j = json.load(f)
            session_id = j.get("session_id") or p.stem.replace("session_", "")
            saved_at = j.get("saved_at") or int(stat.st_mtime)
        except Exception:
            session_id = p.stem.replace("session_", "")
            saved_at = int(p.stat().st_mtime)
        out.append({"session_id": session_id, "filename": p.name, "saved_at": saved_at})
    out.sort(key=lambda x: x["saved_at"], reverse=True)
    return JSONResponse(out)

@app.get("/api/conversations/{session_id}")
async def load_conversation(session_id: str):
    if MOCK_MODE:
        raise HTTPException(status_code=404, detail="no saved conversations in mock mode")
    safe_session = re.sub(r'[^a-zA-Z0-9_\-]', '_', session_id)
    path = CONV_ROOT / f"session_{safe_session}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="conversation not found")
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return JSONResponse(data)

@app.get("/api/audio/{audio_id}")
async def get_audio(audio_id: str):
    data = AUDIO_CACHE.get(audio_id)
    if not data:
        raise HTTPException(status_code=404, detail="audio not found")
    return JSONResponse({"audio_base64": base64.b64encode(data).decode("ascii")})

@app.get("/api/health")
async def health():
    return {"status": "ok"}

def generate_id():
    return str(abs(hash(str(os.urandom(8)))))[0:8]
