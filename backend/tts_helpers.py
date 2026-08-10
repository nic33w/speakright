# tts_helpers.py — Azure TTS wrapper
import io
import re
import wave
from typing import Optional

import requests

from settings import (
    AZURE_REGION,
    AZURE_SPEECH_KEY,
    MOCK_MODE,
    TEST_AUDIO_PATH,
    VOICE_MAP,
)

try:
    from usage_tracker import add_azure_chars as _add_azure_chars
except ImportError:
    _add_azure_chars = None

# task 3.10: SSML <break> at clause boundaries inside a sentence, so a learner
# finishes parsing clause 1 before clause 2 starts — the pause carries the
# processing-time benefit that slowed articulation is usually credited with,
# without distorting connected-speech features. Kept ~2x below
# WITHIN_PAIR_GAP_MS (500ms, task 3.8) so the pause ladder still tells clause
# boundary / language switch / sentence end apart (see TASKS.md task 3.10).
DEFAULT_CLAUSE_PAUSE_MS = 250

# Punctuation and Spanish clause-introducing cue words. Pure heuristic, zero
# LLM cost — only escalate to model-marked segmentation if this demonstrably
# fails (see task 3.10).
_CLAUSE_CUE_WORDS = ("que", "porque", "pero", "cuando", "si", "y")
_CLAUSE_BOUNDARY_RE = re.compile(
    r"([,;])\s+|\s+(?=(?:" + "|".join(_CLAUSE_CUE_WORDS) + r")\b)",
    re.IGNORECASE,
)


def insert_clause_breaks(text: str, pause_ms: int = 0) -> str:
    """Insert SSML <break> tags at clause boundaries in `text`.

    pause_ms=0 (the default) is a no-op — returns `text` unchanged, which is
    what keeps the audio cache key backward-compatible (see
    audio_utils.get_cached_audio_path). Only a single clause (no detected
    boundary) also returns `text` unchanged even when pause_ms is set.
    """
    if pause_ms <= 0 or not text:
        return text
    break_tag = f'<break time="{pause_ms}ms"/> '

    def _replace(match: "re.Match") -> str:
        punct = match.group(1)
        return (punct + break_tag) if punct else break_tag

    return _CLAUSE_BOUNDARY_RE.sub(_replace, text)

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

def azure_tts_bytes_real(text: str, locale: str = "es-MX", voice: Optional[str] = None, max_duration: float = 6.0, rate: int = 0, pause_ms: int = 0) -> bytes:
    """
    Returns WAV bytes from Azure TTS. Requires AZURE_SPEECH_KEY and AZURE_REGION to be set.
    locale: es-MX, id-ID, en-US
    voice: optional voice name; if None we pick a default per locale
    rate: SSML prosody rate as a percent offset from normal speed (e.g. -25 for 0.75x/slower, 0 = normal)
    pause_ms: SSML <break> length inserted at detected clause boundaries; 0 = no breaks (task 3.10)
    """
    if not AZURE_SPEECH_KEY or not AZURE_REGION:
        raise RuntimeError("Azure TTS credentials not configured")

    # default voice map lives in settings.VOICE_MAP (env-overridable)
    voice_name = voice or VOICE_MAP.get(locale, list(VOICE_MAP.values())[0])
    # limit length roughly by words -> duration
    words = len(str(text).split())
    duration = min(max_duration, max(0.5, 0.25 * words))

    spoken_text = insert_clause_breaks(text, pause_ms)
    ssml = f"""
    <speak version='1.0' xml:lang='{locale}'>
      <voice name='{voice_name}'>
        <prosody rate='{rate}%' pitch='0%'>{spoken_text}</prosody>
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

def tts_bytes_for_chunk(text: str, lang_tag: str, rate: int = 0, pause_ms: int = 0) -> bytes:
    """
    Convenience wrapper: tries Azure TTS if configured, else returns test audio in mock mode,
    or falls back to silent wav.

    In MOCK_MODE: Never uses Azure TTS (saves money, works offline)
    rate: SSML prosody rate as a percent offset from normal speed (e.g. -25 for 0.75x/slower, 0 = normal)
    pause_ms: SSML <break> length inserted at detected clause boundaries; 0 = no breaks (task 3.10)
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
            result = azure_tts_bytes_real(text, locale=lang_tag, rate=rate, pause_ms=pause_ms)
            if _add_azure_chars:
                try:
                    _add_azure_chars(len(text))
                except Exception:
                    pass
            return result
    except Exception as e:
        print("Azure TTS failed:", e)
    # fallback to silence if Azure fails
    words = max(1, len(str(text).split()))
    duration = min(4.0, 0.25 * words)
    return generate_silent_wav(duration_secs=duration)
