"""
Pre-generate TTS audio for word drill sentences and hints.
Writes files into backend/audio_files/cache/ using the same
MD5 hash naming as get_cached_audio_path() so the backend
serves them as cache hits with zero latency.

Usage (run from backend/):
    python scripts/generate_worddrill_audio.py
"""

import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from tts_helpers import azure_tts_bytes_real

BACKEND_DIR = Path(__file__).resolve().parent.parent
AUDIO_CACHE = BACKEND_DIR / "audio_files" / "cache"
DATA_PATH = BACKEND_DIR / "word_practice_sentences.json"

# Locale → voice mapping (same voices used in battle mode)
VOICE_MAP = {
    "es-MX": "es-MX-JorgeNeural",
    "id-ID": "id-ID-ArdiNeural",
    "en-US": "en-US-JennyNeural",
}


def cache_path(text: str, locale: str) -> tuple[str, Path]:
    h = hashlib.md5(f"{text}|{locale}".encode()).hexdigest()[:12]
    lang = locale.split("-")[0]
    filename = f"cached_{lang}_{h}.wav"
    return filename, AUDIO_CACHE / filename


def generate(text: str, locale: str, label: str) -> bool:
    filename, path = cache_path(text, locale)
    if path.exists():
        print(f"  [SKIP] {label}: {text[:50]}")
        return False
    voice = VOICE_MAP.get(locale, "es-MX-JorgeNeural")
    print(f"  [GEN]  {label}: {text[:50]}")
    try:
        wav = azure_tts_bytes_real(text, locale=locale, voice=voice)
        path.write_bytes(wav)
        print(f"         saved {len(wav):,} bytes → {filename}")
        return True
    except Exception as e:
        print(f"  [ERROR] {label}: {e}")
        return False


def main():
    print("=" * 60)
    print("Word Drill Audio Generator")
    print("=" * 60)

    if not os.getenv("AZURE_SPEECH_KEY") or not os.getenv("AZURE_REGION"):
        print("\n[ERROR] Azure credentials missing — set AZURE_SPEECH_KEY and AZURE_REGION in backend/.env")
        sys.exit(1)

    AUDIO_CACHE.mkdir(parents=True, exist_ok=True)

    with open(DATA_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    generated = skipped = errors = 0

    for word_key, word_data in data.items():
        locale = "es-MX"  # expand when other languages are added
        print(f"\n[{word_key}]  locale={locale}")

        for sentence in word_data["sentences"]:
            sid = sentence["id"]

            # Correct answer audio (used on history-entry hover)
            correct = sentence["accepted_translations"][0]
            ok = generate(correct, locale, f"sentence {sid} answer")
            if ok: generated += 1
            else: skipped += 1

            # Hint learning audio (used on hint card 🔊 hover)
            for hi, hint in enumerate(sentence.get("hints", [])):
                # Take first variant before "/" (mirrors frontend fetchAndPlayAudio)
                learning_text = hint["learning"].split("/")[0].strip()
                ok = generate(learning_text, locale, f"sentence {sid} hint {hi}")
                if ok: generated += 1
                else: skipped += 1

    print(f"\n{'=' * 60}")
    print(f"Done — {generated} generated, {skipped} already cached, {errors} errors")
    print("=" * 60)


if __name__ == "__main__":
    main()
