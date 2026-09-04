"""Audio file helpers shared by the story, audio, and messenger routers:
silent-WAV generation, per-session WAV saving, and the content-hash audio cache.
"""
import hashlib
import io
import re
import time
import wave
from pathlib import Path

from settings import AUDIO_ROOT, VOICE_MAP


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


def get_cached_audio_path(
    text: str,
    locale: str,
    rate: int = 0,
    pause_ms: int = 0,
    voice: str | None = None,
) -> tuple[str, bool, Path]:
    """
    Check if audio for this text+locale(+rate)(+pause_ms)(+voice) already exists.
    rate: SSML prosody rate percent offset (0 = normal speed). rate=0 hashes identically to the
    pre-rate cache key so existing files stay valid as the normal-speed variant.
    pause_ms: SSML <break> length at clause boundaries (task 3.10). pause_ms=0 hashes identically
    to the pre-3.10 key so existing files stay valid as the no-pause variant — see TASKS.md task
    3.10 "TRAP 1" for why this has to land in the same commit as the SSML change.
    voice: Azure voice name (task 7.4). None, or the locale's own VOICE_MAP default, hashes
    identically to the pre-voice key — so every file cached before voices were selectable stays
    valid as that locale's default-voice rendering. Only a NON-default voice forks the key.
    Without this, LingoPause's multilingual voice and the per-locale default would collide on
    identical text and serve whichever was synthesized first.
    Returns: (url_path, exists, disk_path)
    """
    # Create deterministic hash from text + locale (+ rate, + pause_ms, + voice, only when non-default)
    key = f"{text}|{locale}"
    if rate != 0:
        key += f"|{rate}"
    if pause_ms != 0:
        key += f"|p{pause_ms}"
    if voice and voice != VOICE_MAP.get(locale):
        key += f"|v{voice}"
    hash_input = key.encode('utf-8')
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


def _wav_parts(wav_bytes: bytes) -> tuple:
    """(params, frames) from a WAV blob."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        return wf.getparams(), wf.readframes(wf.getnframes())


def trim_silence(wav_bytes: bytes, threshold: float = 0.01, keep_ms: int = 30) -> bytes:
    """Strip leading and trailing near-silence from a 16-bit mono WAV.

    Azure pads every synthesis with a little silence at each end. That is
    unnoticeable on a standalone clip, but when several clips are stitched into one
    sentence it compounds into an audible stall at each voice change (~775ms per
    switch, measured). `keep_ms` leaves a short margin so a word's attack is never
    clipped.
    """
    params, frames = _wav_parts(wav_bytes)
    if params.sampwidth != 2 or not frames:
        return wav_bytes

    import array

    samples = array.array("h")
    samples.frombytes(frames)
    if params.nchannels > 1:
        samples = samples[::params.nchannels]

    limit = int(32767 * threshold)
    first, last = 0, len(samples) - 1
    while first < len(samples) and abs(samples[first]) < limit:
        first += 1
    while last > first and abs(samples[last]) < limit:
        last -= 1
    if first >= last:
        return wav_bytes  # all silence: leave it alone rather than produce nothing

    margin = int(params.framerate * keep_ms / 1000)
    first = max(0, first - margin)
    last = min(len(samples) - 1, last + margin)

    out = io.BytesIO()
    with wave.open(out, "wb") as wf:
        wf.setnchannels(params.nchannels)
        wf.setsampwidth(params.sampwidth)
        wf.setframerate(params.framerate)
        start = first * params.nchannels * params.sampwidth
        end = (last + 1) * params.nchannels * params.sampwidth
        wf.writeframes(frames[start:end])
    return out.getvalue()


def wav_duration_ms(wav_bytes: bytes) -> int:
    params, _ = _wav_parts(wav_bytes)
    if not params.framerate:
        return 0
    return int(params.nframes * 1000 / params.framerate)


def concat_wavs(clips: list, gap_ms: int = 0) -> bytes:
    """Join WAV clips into one, optionally with a short gap between them.

    All clips must share a format, which they do here — every one comes from the
    same Azure output format.
    """
    clips = [c for c in clips if c]
    if not clips:
        return generate_silent_wav(0.1)
    if len(clips) == 1 and gap_ms <= 0:
        return clips[0]

    params, _ = _wav_parts(clips[0])
    gap_frames = b"\x00" * int(params.framerate * params.nchannels * params.sampwidth * gap_ms / 1000)

    out = io.BytesIO()
    with wave.open(out, "wb") as wf:
        wf.setnchannels(params.nchannels)
        wf.setsampwidth(params.sampwidth)
        wf.setframerate(params.framerate)
        for index, clip in enumerate(clips):
            if index and gap_frames:
                wf.writeframes(gap_frames)
            wf.writeframes(_wav_parts(clip)[1])
    return out.getvalue()


def timings_path_for(audio_disk_path: Path) -> Path:
    """Sidecar file holding word timings for a cached clip.

    Kept beside the .wav and keyed by the same hash, so a cache hit on the audio is
    automatically a cache hit on its timings — word boundaries are captured during
    synthesis, and re-deriving them would mean re-synthesizing and re-billing.
    """
    return audio_disk_path.with_suffix(".words.json")
