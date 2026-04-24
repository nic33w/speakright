#!/usr/bin/env python3
"""
Generate a new battle conversation JSON file using the LLM,
targeting the user's weak areas from user_profile.json.

Usage:
    python scripts/generate_conversation.py --language es --theme "at the pharmacy"
    python scripts/generate_conversation.py --language id --focus "past tense"
    python scripts/generate_conversation.py --language es --theme "job interview" --focus "formal register"

After running, generate audio with:
    python scripts/generate_battle_audio.py
"""

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_SRC = ROOT.parent / "frontend" / "src"
USER_PROFILE_PATH = ROOT / "user_profile.json"
RECENCY_WINDOW = 30  # number of recent rounds to use for weakness analysis

# Default enemy characters per language
DEFAULT_ENEMIES = {
    "es": [
        {"name": "El Capitán", "emoji": "🏴‍☠️"},
        {"name": "La Bruja", "emoji": "🧙‍♀️"},
        {"name": "El Fantasma", "emoji": "👻"},
    ],
    "id": [
        {"name": "Nenek Sihir", "emoji": "🧙‍♀️"},
        {"name": "Pak Hantu", "emoji": "👻"},
        {"name": "Si Penyihir", "emoji": "🔮"},
    ],
}

SCHEMA_EXAMPLE = """
{
  "conversation_id": "unique_snake_case_id",
  "title": "Short Display Title",
  "enemy_name": "Enemy Character Name",
  "enemy_emoji": "🧛",
  "player_emoji": "🥷",
  "rounds": [
    {
      "id": 1,
      "speaker": "enemy",
      "enemy_line_native": "English version of enemy's line.",
      "enemy_line_learning": "Target language version of enemy's line.",
      "defend_question": {
        "audio_url": "/battle_audio/{conversation_id}/round_1.wav",
        "question": "Comprehension question in English?",
        "choices": ["Correct answer", "Wrong answer 1", "Wrong answer 2"],
        "correct_index": 0
      }
    },
    {
      "id": 2,
      "speaker": "player",
      "options": {
        "easy": {
          "scenario": "Short English instruction of what to say (e.g. 'Ask if they have coffee')",
          "native": "The canonical English sentence the player would say.",
          "accepted_translations": [
            "Primary target language translation.",
            "Alternative valid translation."
          ],
          "hints": [
            { "native": "English phrase", "learning": "Target language phrase / Alternative" },
            { "native": "another phrase", "learning": "otra frase" }
          ]
        },
        "medium": { "...same structure, more complex..." },
        "hard": { "...same structure, most complex..." }
      }
    }
  ]
}
"""


def load_profile() -> dict:
    if USER_PROFILE_PATH.exists():
        with open(USER_PROFILE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"mistake_log": [], "topics_to_practice": []}


def compute_weaknesses(profile: dict) -> dict[str, int]:
    """Count feedback_keys in the last RECENCY_WINDOW rounds."""
    recent = profile.get("mistake_log", [])[-RECENCY_WINDOW:]
    counts: Counter = Counter()
    for entry in recent:
        # New format: issues array with full detail
        for issue in entry.get("issues", []):
            key = issue.get("feedback_key")
            if key:
                counts[key] += 1
        # Legacy format fallback: flat feedback_keys list
        for key in entry.get("feedback_keys", []):
            counts[key] += 1
    return dict(counts.most_common(5))


def next_conversation_filename(language: str) -> tuple[str, int]:
    """Find the next available conversation filename for the language."""
    existing = list(FRONTEND_SRC.glob(f"battle_conversations_{language}_*.json"))
    # Also check the base file
    base = FRONTEND_SRC / f"battle_conversations_{language}.json"
    if not base.exists():
        return f"battle_conversations_{language}.json", 1
    indices = []
    for f in existing:
        stem = f.stem  # e.g. battle_conversations_es_2
        parts = stem.split("_")
        if parts[-1].isdigit():
            indices.append(int(parts[-1]))
    next_n = max(indices, default=1) + 1
    return f"battle_conversations_{language}_{next_n}.json", next_n


def build_generation_prompt(language: str, theme: str, focus: str | None, weaknesses: dict, topics: list) -> str:
    lang_name = "Spanish" if language == "es" else "Indonesian"

    weakness_lines = ""
    if weaknesses:
        weakness_lines = "\nUser's current weak areas (from recent play, most frequent first):\n"
        for key, count in weaknesses.items():
            weakness_lines += f"  - {key} ({count} recent occurrences)\n"

    topic_lines = ""
    if topics:
        topic_lines = f"\nTopics/grammar the user specifically wants to practice: {', '.join(topics)}\n"

    focus_line = f"\nAdditional focus for this conversation: {focus}" if focus else ""

    return f"""Generate a complete battle conversation JSON for the SpeakRight language learning app.

Language: {lang_name} ({language})
Conversation theme/setting: {theme}
{focus_line}
{weakness_lines}
{topic_lines}

IMPORTANT REQUIREMENTS:
1. Generate exactly 5-6 player rounds and 5-6 enemy rounds (alternating, enemy first).
2. Each player round must have all three difficulties: easy, medium, hard.
3. Incorporate the user's weak areas into the grammar/vocabulary of the player rounds where natural.
4. Each difficulty option needs:
   - "scenario": a short English instruction of what the player should express (e.g. "Ask if they have oat milk")
   - "native": the canonical English sentence (what the hints are based on)
   - "accepted_translations": 2-3 valid {lang_name} translations (including natural variants)
   - "hints": 2-6 word/phrase pairs mapping English chunks to {lang_name}. Hints may use " / " to show variants (e.g. "quiero / quisiera").
5. Enemy lines must be 1-2 sentences MAXIMUM. Short punchy reactions, a single exclamation + one question, or one dramatic statement work best. Do NOT write multi-sentence explanations, chains of questions, or dramatic fragments ("Un CACHORRO. En una CAJA."). Every word gets spoken aloud — the listener must process it in real time.
6. The "scenario" field must describe the SOCIAL SITUATION and COMMUNICATIVE GOAL — never dictate the exact sentence to produce.
   - BAD: "Say that you told him not to bring his dog to the party" (this is just a translation directive)
   - GOOD: "Carlos brought his dog anyway — explain to your aunt what you specifically told him beforehand"
   The student must figure out the content from context, not decode a translation prompt.
   For easy difficulty, guidance can be more direct (e.g., "Confirm that Roberto brought flowers"), but never "Say that X verb Y."
   For medium/hard, describe the dramatic situation and let the student decide how to express it.
7. Defend questions (comprehension) should have 3 choices with one correct answer.
8. The conversation_id should be a unique snake_case identifier for this theme.
9. Audio URLs follow the pattern: /battle_audio/{{conversation_id}}/round_{{id}}.wav

For {lang_name}:
{"Use Latin American Spanish (Mexican preference). Avoid vosotros. Use casual register unless context requires formal." if language == "es" else "Use casual conversational Indonesian (Bahasa Indonesia). Prefer everyday spoken forms over formal written ones."}

Return ONLY the complete valid JSON. No explanation, no markdown, no code fences.

JSON schema and example:
{SCHEMA_EXAMPLE}
"""


def call_openai(prompt: str) -> str:
    try:
        from openai import OpenAI
    except ImportError:
        print("ERROR: openai package not installed. Run: pip install openai")
        sys.exit(1)

    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("ERROR: OPENAI_API_KEY not set in backend/.env")
        sys.exit(1)

    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    client = OpenAI(api_key=api_key)

    print(f"Calling {model} to generate conversation...")
    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.7,
        max_tokens=4000,
    )
    return response.choices[0].message.content or ""


def extract_json(raw: str) -> dict:
    """Extract JSON from LLM response (handles markdown fences)."""
    raw = raw.strip()
    if raw.startswith("```"):
        lines = raw.split("\n")
        start = next((i for i, l in enumerate(lines) if l.strip().startswith("{")), 1)
        end = next((i for i in range(len(lines) - 1, -1, -1) if lines[i].strip() == "```"), len(lines))
        raw = "\n".join(lines[start:end])
    return json.loads(raw)


def main():
    parser = argparse.ArgumentParser(description="Generate a new battle conversation targeting user weaknesses.")
    parser.add_argument("--language", choices=["es", "id"], default="es", help="Target language (es or id)")
    parser.add_argument("--theme", default="a casual street conversation", help="Conversation theme/setting")
    parser.add_argument("--focus", default=None, help="Extra grammar/topic focus (e.g. 'subjunctive mood')")
    parser.add_argument("--dry-run", action="store_true", help="Print the prompt without calling the API")
    args = parser.parse_args()

    profile = load_profile()
    weaknesses = compute_weaknesses(profile)
    topics = profile.get("topics_to_practice", [])

    print(f"Language: {args.language}")
    print(f"Theme: {args.theme}")
    if args.focus:
        print(f"Focus: {args.focus}")
    if weaknesses:
        print(f"Weak areas (recent): {weaknesses}")
    if topics:
        print(f"Topics to practice: {topics}")

    prompt = build_generation_prompt(args.language, args.theme, args.focus, weaknesses, topics)

    if args.dry_run:
        print("\n--- PROMPT ---")
        print(prompt)
        return

    raw = call_openai(prompt)

    try:
        data = extract_json(raw)
    except json.JSONDecodeError as e:
        print(f"ERROR: Could not parse LLM response as JSON: {e}")
        print("Raw response saved to generated_conversation_raw.txt")
        with open("generated_conversation_raw.txt", "w", encoding="utf-8") as f:
            f.write(raw)
        sys.exit(1)

    filename, _ = next_conversation_filename(args.language)
    output_path = FRONTEND_SRC / filename

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\nConversation saved to: {output_path}")
    print(f"Conversation ID: {data.get('conversation_id', '?')}")
    print(f"Rounds generated: {len(data.get('rounds', []))}")
    print("\nNext step: generate audio with:")
    print("  python scripts/generate_battle_audio.py")
    print("\nNOTE: You may need to add the new conversation to the CONVERSATIONS list in generate_battle_audio.py")


if __name__ == "__main__":
    main()
