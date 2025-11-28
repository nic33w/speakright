# tts_helpers.py (or paste into game_backend.py)
import os
import io
import base64
import requests
import wave
import re
from pathlib import Path
from typing import Optional


AZURE_SPEECH_KEY = os.getenv("AZURE_SPEECH_KEY")
AZURE_REGION = os.getenv("AZURE_REGION")
MOCK_MODE = os.getenv("MOCK_MODE", "0") == "1"
TEST_AUDIO_PATH = Path(__file__).resolve().parent / "test_audio.wav"

def generate_silent_wav(duration_secs: float = 0.6, sample_rate: int = 22050) -> bytes:
    n_frames = int(duration_secs * sample_rate)
    nchannels = 1
    sampwidth = 2
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(nchannels)
        wf.setsampwidth(sampwidth)
        wf.setframerate(sample_rate)
        silence = (0).to_bytes(2, byteorder='little', signed=True)
        wf.writeframes(silence * n_frames)
    return buf.getvalue()

def azure_tts_bytes_real(text: str, locale: str = "es-MX", voice: Optional[str] = None, max_duration: float = 6.0) -> bytes:
    """
    Returns WAV bytes from Azure TTS. Requires AZURE_SPEECH_KEY and AZURE_REGION to be set.
    locale: es-MX, id-ID, en-US
    voice: optional voice name; if None we pick a default per locale
    """
    if not AZURE_SPEECH_KEY or not AZURE_REGION:
        raise RuntimeError("Azure TTS credentials not configured")

    # default voice map (you can change env var overrides if you like)
    default_voice = {
        "es-MX": os.getenv("AZURE_VOICE_ES", "es-MX-JorgeNeural"),
        "en-US": os.getenv("AZURE_VOICE_EN", "en-US-JennyNeural"),
        "id-ID": os.getenv("AZURE_VOICE_ID", "id-ID-GadisNeural"),
    }
    voice_name = voice or default_voice.get(locale, list(default_voice.values())[0])
    # limit length roughly by words -> duration
    words = len(str(text).split())
    duration = min(max_duration, max(0.5, 0.25 * words))

    ssml = f"""
    <speak version='1.0' xml:lang='{locale}'>
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
        "User-Agent": "speakright",
    }
    resp = requests.post(url, headers=headers, data=ssml.encode("utf-8"), timeout=20)
    if resp.status_code != 200:
        raise RuntimeError(f"Azure TTS failed: {resp.status_code} {resp.text[:400]}")
    return resp.content

def tts_bytes_for_chunk(text: str, lang_tag: str) -> bytes:
    """
    Convenience wrapper: tries Azure TTS if configured, else returns test audio in mock mode,
    or falls back to silent wav.

    In MOCK_MODE: Never uses Azure TTS (saves money, works offline)
    """
    # If mock mode, try test audio first, then fall back to silence (NEVER use Azure in mock mode)
    if MOCK_MODE:
        if TEST_AUDIO_PATH.exists():
            try:
                with open(TEST_AUDIO_PATH, "rb") as f:
                    return f.read()
            except Exception as e:
                print(f"Failed to read test audio file: {e}")
        # Fallback to silence in mock mode
        words = max(1, len(str(text).split()))
        duration = min(4.0, 0.25 * words)
        return generate_silent_wav(duration_secs=duration)

    # Not in mock mode - use real Azure TTS
    try:
        if AZURE_SPEECH_KEY and AZURE_REGION:
            return azure_tts_bytes_real(text, locale=lang_tag)
    except Exception as e:
        print("Azure TTS failed:", e)
    # fallback to silence if Azure fails
    words = max(1, len(str(text).split()))
    duration = min(4.0, 0.25 * words)
    return generate_silent_wav(duration_secs=duration)
