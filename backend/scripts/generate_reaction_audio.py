"""
Script to generate TTS audio files for persona reaction-opener phrases
(prompts/persona/<persona>.json -> "reactions"). Run this once (and again after
editing a persona's reaction bank) to pre-generate audio files that the messenger
prompt constrains response_chunks[0] to be picked from verbatim, so that first
audio can be served from disk with zero latency/cost instead of live TTS.

Usage:
    cd backend
    python scripts/generate_reaction_audio.py [persona_id ...]

With no arguments, generates for every persona/*.json that has a "reactions" key.
"""

import json
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import os

from settings import LOCALE_MAP, REACTIONS_AUDIO_DIR
from tts_helpers import tts_bytes_for_chunk

SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
PERSONA_DIR = BACKEND_DIR / "prompts" / "persona"

# Reactions are spoken in the TARGET language (task 3.8): the character speaks only
# the target language now, so response_chunks[0] is a target-language clip. Override
# with REACTION_LANG=id to build a bank for another target language.
REACTION_LANG_CODE = os.getenv("REACTION_LANG", "es")
REACTION_LOCALE = LOCALE_MAP.get(REACTION_LANG_CODE, "es-MX")


def generate_for_persona(persona_id: str) -> None:
    persona_file = PERSONA_DIR / f"{persona_id}.json"
    if not persona_file.exists():
        print(f"[SKIP] No persona file found for '{persona_id}'")
        return

    with open(persona_file, "r", encoding="utf-8") as f:
        persona_data = json.load(f)

    reactions = persona_data.get("reactions", {}).get(REACTION_LANG_CODE, [])
    if not reactions:
        print(f"[SKIP] '{persona_id}' has no '{REACTION_LANG_CODE}' reactions")
        return

    output_dir = REACTIONS_AUDIO_DIR / persona_id
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n[{persona_id.upper()}] Generating audio for {len(reactions)} reactions...")
    print(f"    Locale: {REACTION_LOCALE}")
    print(f"    Output: {output_dir}")

    generated = 0
    skipped = 0

    for reaction in reactions:
        reaction_id = reaction.get("id")
        text = reaction.get("text")

        if not reaction_id or not text:
            continue

        output_file = output_dir / f"{reaction_id}.wav"

        if output_file.exists():
            print(f"    [SKIP] {reaction_id} - already exists")
            skipped += 1
            continue

        try:
            print(f"    [GEN] {reaction_id}: {text[:40]}")
            wav_bytes = tts_bytes_for_chunk(text, REACTION_LOCALE)
            with open(output_file, "wb") as f:
                f.write(wav_bytes)
            generated += 1
        except Exception as e:
            print(f"    [ERROR] {reaction_id}: {e}")

    print(f"    Done: {generated} generated, {skipped} skipped")


def main():
    print("=" * 60)
    print("Reaction Audio Generator")
    print("=" * 60)

    azure_key = os.getenv("AZURE_SPEECH_KEY")
    azure_region = os.getenv("AZURE_REGION")

    if not azure_key or not azure_region:
        print("\n[ERROR] Azure TTS credentials not configured!")
        print("Please set AZURE_SPEECH_KEY and AZURE_REGION in backend/.env")
        sys.exit(1)

    print(f"\nAzure Region: {azure_region}")
    print(f"Output Directory: {REACTIONS_AUDIO_DIR}")

    persona_ids = sys.argv[1:]
    if not persona_ids:
        persona_ids = sorted(p.stem for p in PERSONA_DIR.glob("*.json"))

    for persona_id in persona_ids:
        generate_for_persona(persona_id)

    print("\n" + "=" * 60)
    print("Done! Audio files saved to:", REACTIONS_AUDIO_DIR)
    print("=" * 60)


if __name__ == "__main__":
    main()
