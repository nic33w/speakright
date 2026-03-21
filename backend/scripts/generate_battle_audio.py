"""
Generate TTS audio for battle conversation enemy lines (learning language).
Saves WAV files to frontend/public/battle_audio/<conversation_id>/

Usage (run from backend/):
    python scripts/generate_battle_audio.py
"""

import os
import sys
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from tts_helpers import azure_tts_bytes_real

BACKEND_DIR = Path(__file__).resolve().parent.parent
FRONTEND_PUBLIC = BACKEND_DIR.parent / "frontend" / "public"

# Female voice for Sofía (new_neighbor conversation)
SOFIA_VOICE = "es-MX-DaliaNeural"
LOCALE = "es-MX"

CONVERSATIONS = [
    {
        "json_path": BACKEND_DIR.parent / "frontend" / "src" / "battle_conversations_es_3.json",
        "output_dir": FRONTEND_PUBLIC / "battle_audio" / "new_neighbor",
        "voice": SOFIA_VOICE,
        "locale": LOCALE,
    }
]


def generate_for_conversation(json_path: Path, output_dir: Path, voice: str, locale: str):
    print(f"\nLoading: {json_path.name}")
    with open(json_path, "r", encoding="utf-8") as f:
        conv = json.load(f)

    output_dir.mkdir(parents=True, exist_ok=True)
    print(f"Output dir: {output_dir}")
    print(f"Voice: {voice} ({locale})")

    enemy_rounds = [r for r in conv["rounds"] if r["speaker"] == "enemy"]
    print(f"Found {len(enemy_rounds)} enemy rounds\n")

    generated = 0
    skipped = 0

    for round_data in enemy_rounds:
        rid = round_data["id"]
        text = round_data["enemy_line_learning"]
        out_file = output_dir / f"round_{rid}.wav"

        if out_file.exists():
            print(f"  [SKIP] round_{rid} — already exists")
            skipped += 1
            continue

        print(f"  [GEN] round_{rid}: {text[:60]}...")
        try:
            wav_bytes = azure_tts_bytes_real(text, locale=locale, voice=voice)
            out_file.write_bytes(wav_bytes)
            print(f"         → saved ({len(wav_bytes):,} bytes)")
            generated += 1
        except Exception as e:
            print(f"  [ERROR] round_{rid}: {e}")

    print(f"\n  Done: {generated} generated, {skipped} skipped")


def main():
    print("=" * 60)
    print("Battle Audio Generator")
    print("=" * 60)

    azure_key = os.getenv("AZURE_SPEECH_KEY")
    azure_region = os.getenv("AZURE_REGION")

    if not azure_key or not azure_region:
        print("\n[ERROR] Azure credentials missing! Set AZURE_SPEECH_KEY and AZURE_REGION in backend/.env")
        sys.exit(1)

    print(f"Azure Region: {azure_region}")

    for conv in CONVERSATIONS:
        generate_for_conversation(**conv)

    print("\n" + "=" * 60)
    print("Done!")
    print("=" * 60)


if __name__ == "__main__":
    main()
