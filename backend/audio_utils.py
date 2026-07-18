"""Audio file helpers shared by the story, audio, and messenger routers:
silent-WAV generation, per-session WAV saving, and the content-hash audio cache.
"""
import hashlib
import io
import re
import time
import wave
from pathlib import Path

from settings import AUDIO_ROOT


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
