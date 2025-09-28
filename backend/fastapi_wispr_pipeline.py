# venv\Scripts\activate
# uvicorn fastapi_wispr_pipeline:app --reload --host 127.0.0.1 --port 8000
# fastapi_wispr_pipeline.py
import os
import json
import base64
import io
import wave
import logging
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# optional openai import; if MOCK_MODE you do not need to have OpenAI installed.
try:
    import openai
except Exception:
    openai = None  # used only in REAL mode

# Logging early
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Toggle mock mode via env var; default to True for local testing
MOCK_MODE = os.getenv("MOCK_MODE", "1") == "1"

# --- Configuration ---
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
AZURE_SPEECH_KEY = os.getenv("AZURE_SPEECH_KEY")
AZURE_REGION = os.getenv("AZURE_REGION")

if not OPENAI_API_KEY:
    if not MOCK_MODE:
        raise RuntimeError("Please set OPENAI_API_KEY or enable MOCK_MODE for local testing.")
    else:
        logger.info("OPENAI_API_KEY not set; running in MOCK_MODE.")

if OPENAI_API_KEY and not MOCK_MODE and openai is not None:
    openai.api_key = OPENAI_API_KEY

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
    # Optional original pairs (from transcript) to help alignment/editing
    original_pairs: Optional[List[Dict[str, str]]] = None
    # joined native-language text the user confirmed/edited (multi-sentence)
    confirmed_native_joined: Optional[str] = None
    # alternative legacy fields for backwards compatibility:
    original_spanish: Optional[str] = None
    confirmed_english: Optional[str] = None

# --- Simple sentence split helper (fallback for MOCK) ---
import re
_sentence_splitter = re.compile(r'(?<=[.!?])\s+')

def simple_split_sentences(text: str) -> List[str]:
    text = text.strip()
    if not text:
        return []
    parts = [p.strip() for p in _sentence_splitter.split(text) if p.strip()]
    return parts

# --- Mock TTS generator (short silence WAV) ---
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
    """
    Returns WAV bytes. In MOCK_MODE this returns silent WAV sized roughly to the text.
    Replace with a real Azure call if you have AZURE_SPEECH_KEY and AZURE_REGION.
    """
    if not use_mock and AZURE_SPEECH_KEY and AZURE_REGION:
        # implement real Azure TTS call if desired (requests.post with SSML etc.)
        # For example, call azure_tts_bytes_real(text, voice=...) if you implement it.
        pass
    words = max(1, len(text.split()))
    duration = min(6.0, 0.25 * words)
    return generate_silent_wav(duration_secs=duration)

# --- OpenAI helpers (if using REAL mode, prefer robust split+translate prompts) ---
def call_openai_split_and_translate(text: str, input_lang: LangSpec, out_lang: LangSpec) -> List[Dict[str, str]]:
    """
    Example approach for real mode: ask OpenAI to split and align into JSON array:
    [
      {"native": "...", "learning": "..."},
      ...
    ]
    Must parse the JSON response. Temperature=0 recommended.
    """
    if openai is None:
        raise RuntimeError("openai package is required for real mode")
    system = (
        f"You are a translator and precise sentence aligner. Input language: {input_lang.name} ({input_lang.code}). "
        f"Target language: {out_lang.name} ({out_lang.code}).\n"
        "Split the input into sentences, and for each sentence return a JSON array of objects with fields "
        "\"native\" (text in the native/fluent language) and \"learning\" (text in the learning/target language). "
        "Return ONLY valid JSON."
    )
    user = f"Text: \"{text.strip()}\""
    resp = openai.ChatCompletion.create(
        model=OPENAI_MODEL,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=0.0,
        max_tokens=1500,
    )
    content = resp.choices[0].message["content"].strip()
    # parse JSON safely
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
    This returns a dict with:
      corrected_pairs: [{native, learning}, ...]
      reply_pairs: [{native, learning}, ...]
      correction_explanation: "...".
    """
    if openai is None:
        raise RuntimeError("openai package is required for real mode")
    system = (
        f"You are a helpful teacher and native speaker. The session fluent/native language is {fluent.name} ({fluent.code}), "
        f"the learning language is {learning.name} ({learning.code}).\n"
        "Given the user's confirmed native-language text (possibly multi-sentence), return a JSON object with:"
        "corrected_pairs (an array of {native, learning} pairs for the user's corrected phrasing), "
        "reply_pairs (an array of {native, learning} pairs that are natural replies), "
        "and correction_explanation (one-sentence in native language). Respond with only valid JSON."
    )
    # include original_pairs for context if available
    user_msg = f"confirmed_native_joined: \"{confirmed_native_joined}\""
    if original_pairs:
        user_msg += f"\noriginal_pairs: {json.dumps(original_pairs)}"
    resp = openai.ChatCompletion.create(
        model=OPENAI_MODEL,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user_msg}],
        temperature=0.2,
        max_tokens=1200,
    )
    content = resp.choices[0].message["content"].strip()
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
    input_lang = req.input_language or learning  # assume learning by default

    if MOCK_MODE:
        # very basic split and mock translation
        sentences = simple_split_sentences(text)
        pairs = []
        count = 1
        for s in sentences:
            native = f"(mock {fluent.code}) {s[:200]}".strip()  # fake translation
            native = f"English sentence {count} for {s[:200]}".strip()
            count = count + 1
            pairs.append({"native": native, "learning": s})
        return JSONResponse({"turn_id": f"turn_{generate_id()}", "user_pairs": pairs})

    # REAL MODE: call OpenAI to split + translate + align
    try:
        pairs = call_openai_split_and_translate(text, input_lang, fluent)
        # pairs expected: [{"native": "...", "learning": "..."}, ...]
        return JSONResponse({"turn_id": f"turn_{generate_id()}", "user_pairs": pairs})
    except Exception as e:
        logger.exception("transcript real mode failed")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/confirm")
async def receive_confirm(req: ConfirmRequest):
    # Accept both new-style and legacy fields
    fluent = req.fluent_language or LangSpec(code="en", name="English")
    learning = req.learning_language or LangSpec(code="es", name="Spanish")

    # Prefer confirmed_native_joined; fallback to confirmed_english legacy
    confirmed_native_joined = req.confirmed_native_joined
    if not confirmed_native_joined and req.confirmed_english:
        # legacy: confirmed_english is in fluent/native language; assign to confirmed_native_joined
        confirmed_native_joined = req.confirmed_english

    original_pairs = req.original_pairs or []
    # If MOCK_MODE: return canned corrected & reply pairs + per-sentence mock audio
    if MOCK_MODE:
        # create simple corrected pairs (simulate corrections) by uppercasing leaning text slightly
        # If confirmed_native_joined provided, we pretend it's the native text and generate mock learning translations
        corrected_pairs = []
        reply_pairs = []
        if confirmed_native_joined:
            native_sentences = simple_split_sentences(confirmed_native_joined)
            for s in native_sentences:
                learning_text = f"(mock {learning.code}) {s[:180]}".strip()
                corrected_pairs.append({"native": s, "learning": learning_text})
        elif original_pairs:
            # fallback: invert original pairs
            for p in original_pairs:
                corrected_pairs.append({"native": p.get("native", ""), "learning": p.get("learning", "")})
        else:
            corrected_pairs = [{"native": "(mock) OK", "learning": "(mock) OK"}]

        # generate a mock reply (one or two sentences)
        reply_sentences = ["(mock) Sure — that works.", "¿Cuántas personas?"]
        for r in reply_sentences:
            # decide native vs learning based on session: native is fluent language
            native = r if fluent.code == "en" else f"(mock {fluent.code}) {r}"
            learning_text = f"(mock {learning.code}) reply for: {r}"
            reply_pairs.append({"native": native, "learning": learning_text})

        # produce per-sentence mock audio base64
        def attach_audio(pairs):
            out = []
            for p in pairs:
                wav = azure_tts_bytes(p.get("learning", p.get("native", "")), use_mock=True)
                b64 = base64.b64encode(wav).decode("ascii")
                out.append({**p, "audio_base64": b64})
            return out

        corrected_pairs = [{"native": "I would like to reserve a table.", "learning": "Quisiera reservar una mesa."}, {"native": "Is 8 OK?", "learning": "¿A las 8 está bien?"}]
        reply_pairs = [{"native": "Yes, 8 is perfect.", "learning": "Sí, a las 8 está perfecto."}, {"native": "How many people will you be?", "learning": "¿Cuántas personas serán?"}]
        corrected_with_audio = attach_audio(corrected_pairs)
        reply_with_audio = attach_audio(reply_pairs)

        return JSONResponse({
            "turn_id": f"turn_{generate_id()}",
            "corrected_pairs": corrected_with_audio,
            "reply_pairs": reply_with_audio,
            "correction_explanation": "Mock: minor wording adjusted for politeness."
        })

    # REAL mode: call OpenAI to generate corrected_pairs + reply_pairs
    try:
        result = call_openai_confirm_from_native(confirmed_native_joined or "", fluent, learning, original_pairs)
        corrected = result.get("corrected_pairs", [])
        reply = result.get("reply_pairs", [])
        explanation = result.get("correction_explanation", "")

        # generate TTS per sentence (you should do this async/concurrently in production)
        corrected_with_audio = []
        for p in corrected:
            text_to_speak = p.get("learning") or p.get("native")
            wav = azure_tts_bytes(text_to_speak, use_mock=True)
            corrected_with_audio.append({**p, "audio_base64": base64.b64encode(wav).decode("ascii")})

        reply_with_audio = []
        for p in reply:
            text_to_speak = p.get("learning") or p.get("native")
            wav = azure_tts_bytes(text_to_speak, use_mock=True)
            reply_with_audio.append({**p, "audio_base64": base64.b64encode(wav).decode("ascii")})

        return JSONResponse({
            "turn_id": f"turn_{generate_id()}",
            "corrected_pairs": corrected_with_audio,
            "reply_pairs": reply_with_audio,
            "correction_explanation": explanation,
        })
    except Exception as e:
        logger.exception("confirm real mode failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/audio/{audio_id}")
async def get_audio(audio_id: str):
    data = AUDIO_CACHE.get(audio_id)
    if not data:
        raise HTTPException(status_code=404, detail="audio not found")
    return JSONResponse({"audio_base64": base64.b64encode(data).decode("ascii")})


@app.get("/api/health")
async def health():
    return {"status": "ok"}

# small helper for simple IDs
def generate_id():
    return str(abs(hash(str(os.urandom(8)))))[0:8]
