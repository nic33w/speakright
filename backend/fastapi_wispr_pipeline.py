# venv\Scripts\activate
# uvicorn fastapi_wispr_pipeline:app --reload --host 127.0.0.1 --port 8000

"""
FastAPI example backend for Wispr-flow desktop integration.

Features:
- POST /api/transcript : accept Spanish transcript, call OpenAI to produce an English "meaning".
- POST /api/confirm : accept original Spanish + confirmed English, call OpenAI to produce corrected Spanish,
  correction explanation, and a reply; synthesize (mock) TTS audio for corrected + reply, return base64 audio.
- Uses OpenAI python client. Azure TTS integration is provided as a commented example; by default a small
  silent WAV is generated as mock audio so you can test without Azure credentials.

Instructions:
- Save this file and run: `uvicorn fastapi_wispr_pipeline:app --reload --port 8000`
- Required env vars: OPENAI_API_KEY. Optional: OPENAI_MODEL, AZURE_SPEECH_KEY, AZURE_REGION.

This file intentionally uses a mock TTS generator unless AZURE_SPEECH_KEY and AZURE_REGION are set and you
uncomment the Azure call block.
"""

import os
import json
import base64
import io
import wave
import struct
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import openai

# --- Logging must be set before usage ---
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MOCK_MODE = True

# --- Configuration ---
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")  # change as preferred
AZURE_SPEECH_KEY = os.getenv("AZURE_SPEECH_KEY")  # optional
AZURE_REGION = os.getenv("AZURE_REGION")  # optional, e.g. 'eastus'

if not OPENAI_API_KEY:
    if not MOCK_MODE:
        raise RuntimeError("Please set the OPENAI_API_KEY environment variable before running this server.")
    else:
        logger.info("OPENAI_API_KEY not set, running in MOCK_MODE.")

if OPENAI_API_KEY and not MOCK_MODE:
    openai.api_key = OPENAI_API_KEY

# --- FastAPI app ---
app = FastAPI(title="Wispr Desktop -> OpenAI -> Azure TTS pipeline (example)")

# Allow local dev from React (localhost:3000). Adjust origins for production.
app.add_middleware(
    CORSMiddleware,
#    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_origins=["http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Simple in-memory cache for TTS audio (not persisted) for demo purposes
AUDIO_CACHE = {}

# --- Request models ---
class TranscriptRequest(BaseModel):
    session_id: Optional[str]
    spanish_text: str
    source: Optional[str] = "wispr_desktop"


class ConfirmRequest(BaseModel):
    session_id: Optional[str]
    original_spanish: str
    confirmed_english: str


# --- Helper: OpenAI calls ---
async def call_openai_translate(spanish_text: str) -> str:
    """Translate Spanish -> short English meaning for confirmation."""
    system = (
        "You are a concise translator. Translate the user's Spanish sentence into a clear, literal English "
        "meaning suitable for confirming intent. Do not add corrections or extra suggestions. Respond with only "
        "the English text."
    )
    try:
        resp = openai.ChatCompletion.create(
            model=OPENAI_MODEL,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": spanish_text},
            ],
            max_tokens=200,
            temperature=0.0,
        )
        content = resp.choices[0].message["content"].strip()
        return content
    except Exception as e:
        logger.exception("OpenAI translate call failed")
        raise


async def call_openai_correction(original_spanish: str, confirmed_english: str) -> dict:
    """Ask OpenAI to return a JSON object with corrected_spanish, correction_explanation, reply_spanish."""
    system = (
        "You are a helpful Spanish teacher and natural speaker. Given the original Spanish sentence and the "
        "confirmed English meaning, return a JSON object with the following fields:\n"
        "- corrected_spanish: a natural, native-sounding Spanish sentence (same meaning).\n"
        "- correction_explanation: a one-sentence explanation in English about what changed and why.\n"
        "- reply_spanish: a natural reply a native speaker would say next.\n"
        "- reply_english: a translation of reply in English.\n"
        "Respond with ONLY valid JSON."
    )

    user_msg = (
        f"original_spanish: \"{original_spanish}\"\n"
        f"confirmed_english: \"{confirmed_english}\""
    )

    try:
        resp = openai.ChatCompletion.create(
            model=OPENAI_MODEL,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_msg},
            ],
            max_tokens=300,
            temperature=0.2,
        )
        content = resp.choices[0].message["content"].strip()
        # Try to parse JSON directly; if it fails, attempt to extract JSON substring.
        try:
            parsed = json.loads(content)
        except Exception:
            # attempt to find the first { ... } block
            start = content.find('{')
            end = content.rfind('}')
            if start != -1 and end != -1 and end > start:
                substring = content[start:end+1]
                parsed = json.loads(substring)
            else:
                raise ValueError("Could not parse OpenAI JSON response")
        return parsed
    except Exception as e:
        logger.exception("OpenAI correction call failed")
        raise

# Add this helper near your other OpenAI helpers
async def call_openai_from_english(confirmed_english: str) -> dict:
    """
    Given only an English meaning, return a JSON-like dict:
    { corrected_spanish, correction_explanation, reply_spanish }
    """
    system = (
        "You are a Spanish teacher and natural speaker. Given a short English meaning, "
        "return a JSON object with fields: corrected_spanish (a native-sounding Spanish sentence), "
        "correction_explanation (one-sentence English explanation), and reply_spanish (a natural reply). "
        "Respond with ONLY valid JSON."
    )
    user_msg = f"confirmed_english: \"{confirmed_english}\""
    resp = openai.ChatCompletion.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_msg}
        ],
        max_tokens=300,
        temperature=0.2,
    )
    content = resp.choices[0].message["content"].strip()
    try:
        return json.loads(content)
    except Exception:
        # fallback: try to extract JSON substring
        start = content.find("{")
        end = content.rfind("}")
        if start != -1 and end != -1:
            return json.loads(content[start:end+1])
        raise

# --- Helper: Mock Azure TTS (generate a short silent WAV) ---
def generate_silent_wav(duration_secs: float = 1.0, sample_rate: int = 22050) -> bytes:
    """Return a WAV file bytes containing silence. Useful as a mock TTS output for testing."""
    n_frames = int(duration_secs * sample_rate)
    nchannels = 1
    sampwidth = 2  # 2 bytes = 16-bit
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(nchannels)
        wf.setsampwidth(sampwidth)
        wf.setframerate(sample_rate)
        # 16-bit silence -> zero samples
        silence = (0).to_bytes(2, byteorder='little', signed=True)
        frames = silence * n_frames
        wf.writeframes(frames)
    return buf.getvalue()


# --- Helper: Azure TTS (commented example) ---
# If you want to enable real Azure TTS, uncomment & configure the block below and install 'requests'.
# def azure_tts_bytes_real(text: str, voice: str = "es-MX-DaliaNeural") -> bytes:
#     import requests
#     if not AZURE_SPEECH_KEY or not AZURE_REGION:
#         raise RuntimeError("AZURE_SPEECH_KEY and AZURE_REGION must be set to use real Azure TTS")
#     url = f"https://{AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1"
#     ssml = f"""<speak version='1.0' xml:lang='es-MX'>
#     <voice name='{voice}'>{text}</voice>
#     </speak>"""
#     headers = {
#         'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
#         'Content-Type': 'application/ssml+xml',
#         'X-Microsoft-OutputFormat': 'audio-16khz-32kbitrate-mono-mp3'
#     }
#     resp = requests.post(url, headers=headers, data=ssml)
#     if resp.status_code != 200:
#         raise RuntimeError(f"Azure TTS failed: {resp.status_code} {resp.text}")
#     return resp.content


def azure_tts_bytes(text: str, use_mock: bool = True) -> bytes:
    """Return audio bytes. By default returns mock silent WAV. If you enable real Azure creds and code,
    replace the implementation with a real call (see azure_tts_bytes_real example above)."""
    if not use_mock and AZURE_SPEECH_KEY and AZURE_REGION:
        # If you set use_mock=False and provided AZURE keys, you can implement a real call here.
        # For safety in this example we keep returning mock audio.
        pass
    # Provide ~1 second silence per ~8 words (very rough), so audio length scales with text length
    words = max(1, len(text.split()))
    duration = min(5.0, 0.25 * words)
    return generate_silent_wav(duration_secs=duration)


# --- Endpoints ---
@app.post("/api/transcript")
async def receive_transcript(req: TranscriptRequest):
    spanish = req.spanish_text.strip()
    if not spanish:
        raise HTTPException(status_code=400, detail="spanish_text is required")
    # === MOCK MODE: return a canned English meaning immediately ===
    if MOCK_MODE:
        mock_english = f"(mock) English meaning for: {spanish}"
        return JSONResponse({"english_meaning": mock_english})

    # === REAL MODE: call OpenAI ===
    try:
        english = await call_openai_translate(spanish)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return JSONResponse({"english_meaning": english})


@app.post("/api/confirm")
async def receive_confirm(req: ConfirmRequest):
    original = (req.original_spanish or "").strip()
    confirmed = req.confirmed_english.strip()
    if not confirmed:
        raise HTTPException(status_code=400, detail="confirmed_english is required")
    # === MOCK MODE: short-circuit and return canned corrected/reply + silent WAV base64 ===
    if MOCK_MODE:
        corrected = f"(mock) Natural Spanish for: {original or confirmed}"
        explanation = "Mock: uses a polite phrasing."
        reply = "(mock) Reply: Claro, ¿a qué hora te gustaría venir?"
        replyEnglish = "English translation"

        audio_corrected = azure_tts_bytes(corrected)  # will generate a silent wav in current code
        audio_reply = azure_tts_bytes(reply)

        id_corrected = f"audio_{len(AUDIO_CACHE)+1}"
        AUDIO_CACHE[id_corrected] = audio_corrected
        id_reply = f"audio_{len(AUDIO_CACHE)+1}"
        AUDIO_CACHE[id_reply] = audio_reply

        return JSONResponse({
            "corrected_spanish": corrected,
            "correction_explanation": explanation,
            "reply_spanish": reply,
            "reply_english": replyEnglish,
            "audio_corrected_base64": base64.b64encode(audio_corrected).decode('ascii'),
            "audio_reply_base64": base64.b64encode(audio_reply).decode('ascii'),
            "audio_ids": {"corrected": id_corrected, "reply": id_reply},
        })

    # === REAL MODE: existing logic continues below ===
    try:
        if original:
            parsed = await call_openai_correction(original, confirmed)
        else:
            parsed = await call_openai_from_english(confirmed)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OpenAI correction failed: {e}")

    corrected = parsed.get("corrected_spanish") or parsed.get("corrected") or ""
    explanation = parsed.get("correction_explanation") or parsed.get("explanation") or ""
    reply = parsed.get("reply_spanish") or parsed.get("reply") or ""
    replyEnglish = parsed.get("reply_english")

    # Generate (mock) audio for corrected + reply
    try:
        audio_corrected = azure_tts_bytes(corrected)
        audio_reply = azure_tts_bytes(reply)
    except Exception as e:
        logger.exception("TTS generation failed")
        raise HTTPException(status_code=500, detail=f"TTS generation failed: {e}")

    # Cache audio and return base64 to the client for quick demo
    id_corrected = f"audio_{len(AUDIO_CACHE)+1}"
    AUDIO_CACHE[id_corrected] = audio_corrected
    id_reply = f"audio_{len(AUDIO_CACHE)+1}"
    AUDIO_CACHE[id_reply] = audio_reply

    resp = {
        "corrected_spanish": corrected,
        "correction_explanation": explanation,
        "reply_spanish": reply,
        "reply_enlgish": replyEnglish,
        "audio_corrected_base64": base64.b64encode(audio_corrected).decode('ascii'),
        "audio_reply_base64": base64.b64encode(audio_reply).decode('ascii'),
        "audio_ids": {"corrected": id_corrected, "reply": id_reply},
    }
    return JSONResponse(resp)


@app.get("/api/audio/{audio_id}")
async def get_audio(audio_id: str):
    """Return raw audio bytes for a cached audio blob. Useful for serving as an audio URL."""
    data = AUDIO_CACHE.get(audio_id)
    if not data:
        raise HTTPException(status_code=404, detail="audio not found")
    return JSONResponse({"audio_base64": base64.b64encode(data).decode('ascii')})


# --- Health check ---
@app.get("/api/health")
async def health():
    return {"status": "ok"}
