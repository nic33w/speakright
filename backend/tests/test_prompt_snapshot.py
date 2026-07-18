"""Golden-file snapshots of the assembled messenger prompt.

Purpose: prove that refactor stages which are supposed to be mechanical
(moving `build_layered_prompt` to another module, extracting prompt fragments)
produce byte-identical prompts. On first run the goldens are written; on later
runs any byte difference fails.

The golden content is the exact wire string sent to OpenAI:
``system_prompt + "\\n\\n" + user_message`` (see call_llm_for_messenger).

When Stage 4 deliberately restructures the prompt, delete tests/goldens/ and
re-run once to re-baseline (say so in the commit message).
"""
import sys
from pathlib import Path

import pytest

# Works both before the split (game_backend) and after (prompts.messenger_prompt)
try:
    from prompts.messenger_prompt import build_layered_prompt
except ImportError:
    from game_backend import build_layered_prompt

PROMPT_MODULE = sys.modules[build_layered_prompt.__module__]
GOLDEN_DIR = Path(__file__).resolve().parent / "goldens"

USER_INPUT = "ayer fui al tienda para comprar leche"


def _profile(turn_count, level="beginner", corrections_needed=0,
             comfortable=(), weak=(), avoid=(), recent_turns=()):
    return {
        "created_at": 1700000000,
        "last_updated": 1700000000,
        "ui_language": {"code": "en", "name": "English"},
        "target_language": {"code": "es", "name": "Spanish"},
        "level": level,
        "level_confidence": 0.5,
        "level_history": [],
        "comfortable_with": list(comfortable),
        "weak_points": list(weak),
        "avoid_topics": list(avoid),
        "turn_count": turn_count,
        "corrections_needed": corrections_needed,
        "last_assessment_turn": 0,
        "recent_turns": list(recent_turns),
    }


PROFILES = {
    "fresh": _profile(turn_count=0),
    "mid": _profile(
        turn_count=7,
        level="intermediate",
        corrections_needed=3,
        comfortable=["present tense", "basic questions"],
        weak=["ser vs estar", "por vs para"],
        recent_turns=[
            {"user_input": "hola como estas", "corrected_input": "hola como estas",
             "had_errors": False, "input_intent": "spanish", "timestamp": 1700000001},
            {"user_input": "yo fui a la tienda ayer", "corrected_input": "fui a la tienda ayer",
             "had_errors": True, "input_intent": "spanish", "timestamp": 1700000002},
            {"user_input": "compre leche y pan", "corrected_input": "compre leche y pan",
             "had_errors": False, "input_intent": "spanish", "timestamp": 1700000003},
        ],
    ),
    "assessment": _profile(
        turn_count=10,
        level="intermediate",
        corrections_needed=4,
        weak=["subjunctive"],
        recent_turns=[
            {"user_input": "espero que tu estas bien", "corrected_input": "espero que estés bien",
             "had_errors": True, "input_intent": "spanish", "timestamp": 1700000004},
        ],
    ),
}

CASES = [
    (profile_key, version, quizzing)
    for profile_key in PROFILES
    for version in ("v1", "v2")
    for quizzing in (True, False)
]


@pytest.mark.parametrize("profile_key,version,quizzing", CASES)
def test_prompt_golden(profile_key, version, quizzing, monkeypatch):
    monkeypatch.setattr(PROMPT_MODULE, "ENABLE_QUIZZING", quizzing)

    system_prompt, user_message = build_layered_prompt(
        USER_INPUT, PROFILES[profile_key], version
    )
    wire = system_prompt + "\n\n" + user_message

    GOLDEN_DIR.mkdir(exist_ok=True)
    golden = GOLDEN_DIR / f"{profile_key}_{version}_quiz{'on' if quizzing else 'off'}.txt"

    if not golden.exists():
        golden.write_text(wire, encoding="utf-8", newline="\n")
        pytest.skip(f"golden created: {golden.name} (review it, then re-run)")

    expected = golden.read_text(encoding="utf-8")
    assert wire == expected, (
        f"Assembled prompt differs from golden {golden.name}. "
        "If this change is deliberate (Stage 4 restructure), delete tests/goldens/ "
        "and re-run to re-baseline."
    )
