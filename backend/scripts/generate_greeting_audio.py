"""
Script to generate TTS audio files for greeting phrases.
Run this once to pre-generate audio files that can be reused.

Usage:
    cd backend
    python scripts/generate_greeting_audio.py
"""

import os
import sys
import json
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from tts_helpers import tts_bytes_for_chunk

# Paths
SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
I18N_DIR = BACKEND_DIR / "i18n" / "greetings"
AUDIO_OUTPUT_DIR = BACKEND_DIR / "audio_files" / "greetings"

# Voice configurations (matching the main app)
VOICE_CONFIG = {
    "es": "es-MX",  # Mexican Spanish
    "id": "id-ID",  # Indonesian
    "en": "en-US",  # US English
}


def generate_audio_for_language(lang_code: str):
    """Generate audio files for all greetings in a language."""
    json_path = I18N_DIR / f"{lang_code}.json"
    if not json_path.exists():
        print(f"[SKIP] No greetings file found for {lang_code}")
        return

    # Create output directory
    output_dir = AUDIO_OUTPUT_DIR / lang_code
    output_dir.mkdir(parents=True, exist_ok=True)

    # Load greetings
    with open(json_path, 'r', encoding='utf-8') as f:
        greetings = json.load(f)

    locale = VOICE_CONFIG.get(lang_code, "en-US")

    print(f"\n[{lang_code.upper()}] Generating audio for {len(greetings)} greetings...")
    print(f"    Locale: {locale}")
    print(f"    Output: {output_dir}")

    generated = 0
    skipped = 0

    for greeting in greetings:
        greeting_id = greeting.get("id")
        text = greeting.get("text")

        if not greeting_id or not text:
            continue

        output_file = output_dir / f"{greeting_id}.wav"

        # Skip if already exists
        if output_file.exists():
            print(f"    [SKIP] {greeting_id} - already exists")
            skipped += 1
            continue

        try:
            print(f"    [GEN] {greeting_id}: {text[:40]}...")
            wav_bytes = tts_bytes_for_chunk(text, locale)

            with open(output_file, 'wb') as f:
                f.write(wav_bytes)

            generated += 1
        except Exception as e:
            print(f"    [ERROR] {greeting_id}: {e}")

    print(f"    Done: {generated} generated, {skipped} skipped")


def main():
    print("=" * 60)
    print("Greeting Audio Generator")
    print("=" * 60)

    # Check Azure credentials
    azure_key = os.getenv("AZURE_SPEECH_KEY")
    azure_region = os.getenv("AZURE_REGION")

    if not azure_key or not azure_region:
        print("\n[ERROR] Azure TTS credentials not configured!")
        print("Please set AZURE_SPEECH_KEY and AZURE_REGION in backend/.env")
        sys.exit(1)

    print(f"\nAzure Region: {azure_region}")
    print(f"Output Directory: {AUDIO_OUTPUT_DIR}")

    # Generate for each language (only es for now as requested)
    generate_audio_for_language("es")

    # Uncomment to generate for other languages too:
    # generate_audio_for_language("id")
    # generate_audio_for_language("en")

    print("\n" + "=" * 60)
    print("Done! Audio files saved to:", AUDIO_OUTPUT_DIR)
    print("=" * 60)


if __name__ == "__main__":
    main()
