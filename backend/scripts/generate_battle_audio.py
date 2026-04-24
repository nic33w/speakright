"""
Generate TTS audio for battle conversations:
  1. Enemy lines (learning language) — female voices
  2. Player hint phrases (learning language) — male voices

Output structure:
  frontend/public/battle_audio/{conversation_id}/round_{id}.wav
  frontend/public/battle_audio/{conversation_id}/hints/round_{id}_{difficulty}_hint_{index}_v{variant}.wav

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
FRONTEND_SRC = BACKEND_DIR.parent / "frontend" / "src"

CONVERSATIONS = [
    {
        "json_path": FRONTEND_SRC / "battle_conversations_es.json",
        "output_dir": FRONTEND_PUBLIC / "battle_audio" / "cafe_encounter",
        "enemy_voice": "es-MX-JorgeNeural",
        "enemy_locale": "es-MX",
        "hint_voice": "es-MX-JorgeNeural",
        "hint_locale": "es-MX",
    },
    {
        "json_path": FRONTEND_SRC / "battle_conversations_es_2.json",
        "output_dir": FRONTEND_PUBLIC / "battle_audio" / "market_haggle",
        "enemy_voice": "es-MX-DaliaNeural",
        "enemy_locale": "es-MX",
        "hint_voice": "es-MX-JorgeNeural",
        "hint_locale": "es-MX",
    },
    {
        "json_path": FRONTEND_SRC / "battle_conversations_es_3.json",
        "output_dir": FRONTEND_PUBLIC / "battle_audio" / "new_neighbor",
        "enemy_voice": "es-MX-DaliaNeural",
        "enemy_locale": "es-MX",
        "hint_voice": "es-MX-JorgeNeural",
        "hint_locale": "es-MX",
    },
    {
        "json_path": FRONTEND_SRC / "battle_conversations_id.json",
        "output_dir": FRONTEND_PUBLIC / "battle_audio" / "warung_order",
        "enemy_voice": "id-ID-GadisNeural",
        "enemy_locale": "id-ID",
        "hint_voice": "id-ID-ArdiNeural",
        "hint_locale": "id-ID",
    },
    {
        "json_path": FRONTEND_SRC / "battle_conversations_id_2.json",
        "output_dir": FRONTEND_PUBLIC / "battle_audio" / "batik_bargain",
        "enemy_voice": "id-ID-ArdiNeural",
        "enemy_locale": "id-ID",
        "hint_voice": "id-ID-ArdiNeural",
        "hint_locale": "id-ID",
    },
    {
        "json_path": FRONTEND_SRC / "battle_conversations_es_4.json",
        "output_dir": FRONTEND_PUBLIC / "battle_audio" / "quinceanera_drama",
        "enemy_voice": "es-MX-DaliaNeural",
        "enemy_locale": "es-MX",
        "hint_voice": "es-MX-JorgeNeural",
        "hint_locale": "es-MX",
    },
]


def generate_enemy_lines(json_path, output_dir, voice, locale, conv):
    enemy_rounds = [r for r in conv["rounds"] if r["speaker"] == "enemy"]
    print(f"  Enemy lines: {len(enemy_rounds)} rounds, voice={voice}")
    generated = skipped = 0
    for r in enemy_rounds:
        rid = r["id"]
        variants = r.get("variants")
        if variants:
            for vi, variant in enumerate(variants):
                out_file = output_dir / f"round_{rid}_v{vi}.wav"
                if out_file.exists():
                    print(f"    [SKIP] round_{rid}_v{vi}")
                    skipped += 1
                    continue
                text = variant["enemy_line_learning"]
                print(f"    [GEN]  round_{rid}_v{vi}: {text[:55]}...")
                try:
                    wav = azure_tts_bytes_real(text, locale=locale, voice=voice)
                    out_file.write_bytes(wav)
                    print(f"           saved ({len(wav):,} bytes)")
                    generated += 1
                except Exception as e:
                    print(f"    [ERROR] round_{rid}_v{vi}: {e}")
        else:
            out_file = output_dir / f"round_{rid}.wav"
            if out_file.exists():
                print(f"    [SKIP] round_{rid}")
                skipped += 1
                continue
            text = r["enemy_line_learning"]
            print(f"    [GEN]  round_{rid}: {text[:55]}...")
            try:
                wav = azure_tts_bytes_real(text, locale=locale, voice=voice)
                out_file.write_bytes(wav)
                print(f"           saved ({len(wav):,} bytes)")
                generated += 1
            except Exception as e:
                print(f"    [ERROR] round_{rid}: {e}")
    print(f"  Enemy lines done: {generated} generated, {skipped} skipped")


def generate_hints(output_dir, voice, locale, conv):
    hints_dir = output_dir / "hints"
    hints_dir.mkdir(parents=True, exist_ok=True)

    player_rounds = [r for r in conv["rounds"] if r["speaker"] == "player"]
    difficulties = ["easy", "medium", "hard"]
    print(f"  Hints: {len(player_rounds)} player rounds x {len(difficulties)} difficulties, voice={voice}")
    generated = skipped = 0

    for r in player_rounds:
        rid = r["id"]
        for diff in difficulties:
            opts = r.get("options", {}).get(diff)
            if not opts:
                continue
            hints = opts.get("hints", [])
            for hi, hint in enumerate(hints):
                # Split on " / " to get variants
                variants = [v.strip() for v in hint["learning"].split(" / ") if v.strip()]
                for vi, variant_text in enumerate(variants):
                    out_file = hints_dir / f"round_{rid}_{diff}_hint_{hi}_v{vi}.wav"
                    if out_file.exists():
                        skipped += 1
                        continue
                    print(f"    [GEN]  round_{rid} {diff} hint_{hi} v{vi}: {variant_text[:50]}...")
                    try:
                        wav = azure_tts_bytes_real(variant_text, locale=locale, voice=voice)
                        out_file.write_bytes(wav)
                        print(f"           saved ({len(wav):,} bytes)")
                        generated += 1
                    except Exception as e:
                        print(f"    [ERROR] round_{rid} {diff} hint_{hi} v{vi}: {e}")

    print(f"  Hints done: {generated} generated, {skipped} skipped")


def process_conversation(json_path, output_dir, enemy_voice, enemy_locale, hint_voice, hint_locale):
    print(f"\nLoading: {json_path.name}")
    with open(json_path, "r", encoding="utf-8") as f:
        conv = json.load(f)
    output_dir.mkdir(parents=True, exist_ok=True)

    generate_enemy_lines(json_path, output_dir, enemy_voice, enemy_locale, conv)
    generate_hints(output_dir, hint_voice, hint_locale, conv)


def main():
    print("=" * 60)
    print("Battle Audio Generator")
    print("=" * 60)

    if not os.getenv("AZURE_SPEECH_KEY") or not os.getenv("AZURE_REGION"):
        print("\n[ERROR] Azure credentials missing — set AZURE_SPEECH_KEY and AZURE_REGION in backend/.env")
        sys.exit(1)

    print(f"Azure Region: {os.getenv('AZURE_REGION')}")

    for conv in CONVERSATIONS:
        process_conversation(
            conv["json_path"],
            conv["output_dir"],
            conv["enemy_voice"],
            conv["enemy_locale"],
            conv["hint_voice"],
            conv["hint_locale"],
        )

    print("\n" + "=" * 60)
    print("Done!")
    print("=" * 60)


if __name__ == "__main__":
    main()
