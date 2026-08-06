"""Audio serving + cached TTS generation: /api/audio_file/* and /api/trivia/audio.

/api/trivia/audio is the shared content-hash-cached TTS endpoint used by trivia,
worddrill, battle, trivia2, and premade messenger chunks.
"""
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from audio_utils import generate_silent_wav, get_cached_audio_path, save_wav
from settings import AUDIO_ROOT, GREETING_AUDIO_DIR

router = APIRouter()


class TriviaAudioReq(BaseModel):
    text: str
    locale: str  # es-MX, en-US, id-ID
    rate: int = 0  # SSML prosody rate percent offset (e.g. -25 for 0.75x/slower); 0 = normal speed


@router.get("/api/audio_file/{session}/{filename}")
def serve_audio(session: str, filename: str):
    # Handle both session_X and messenger_X formats
    if session == "cache":
        path = AUDIO_ROOT / "cache" / filename
    elif session.startswith("messenger_"):
        path = AUDIO_ROOT / session / filename
    else:
        path = AUDIO_ROOT / f"session_{session}" / filename

    if not path.exists():
        raise HTTPException(status_code=404, detail="audio not found")
    return FileResponse(path, media_type="audio/wav", filename=filename)


@router.get("/api/audio_file/greetings/{lang}/{filename}")
def serve_greeting_audio(lang: str, filename: str):
    """Serve pre-generated greeting audio files."""
    path = GREETING_AUDIO_DIR / lang / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="greeting audio not found")
    return FileResponse(path, media_type="audio/wav", filename=filename)


@router.post("/api/trivia/audio")
def api_trivia_audio(req: TriviaAudioReq):
    """
    Generate TTS audio for given text and locale (with caching).
    Returns: { audio_file: str (URL path) }
    """
    from tts_helpers import tts_bytes_for_chunk

    try:
        # Check cache first
        url_path, exists, disk_path = get_cached_audio_path(req.text, req.locale, req.rate)

        if exists:
            # Cache hit - return existing audio URL
            print(f"[CACHE HIT] Returning cached audio for: {req.text[:30]}...")
            return {"audio_file": url_path}

        # Cache miss - generate new audio
        print(f"[CACHE MISS] Generating audio for: {req.text[:30]}...")
        wav_bytes = tts_bytes_for_chunk(req.text, req.locale, req.rate)

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
