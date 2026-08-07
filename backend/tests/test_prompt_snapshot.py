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

VERSIONS = ("v1", "v2", "eyesfree")

CASES = [
    (profile_key, version, quizzing)
    for profile_key in PROFILES
    for version in VERSIONS
    for quizzing in (True, False)
]


# Goldens pin prompt *assembly*, not which character happens to be configured.
# Without this the whole snapshot suite re-baselines every time MESSENGER_PERSONA
# changes, which says nothing about whether assembly regressed.
GOLDEN_PERSONA = "sombongo"


@pytest.mark.parametrize("profile_key,version,quizzing", CASES)
def test_prompt_golden(profile_key, version, quizzing, monkeypatch):
    monkeypatch.setattr(PROMPT_MODULE, "ENABLE_QUIZZING", quizzing)
    monkeypatch.setattr(PROMPT_MODULE, "PERSONA", GOLDEN_PERSONA)

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


# --- Prompt-cache prefix stability (the Stage 4 invariant) ---
# The wire string is system + "\n\n" + user_message; OpenAI's automatic prompt
# caching discounts a repeated prefix (>=1024 tokens), so the system prompt
# (static prefix) must be byte-identical across turns for a fixed run config.

def _wire(system, user):
    return system + "\n\n" + user


def test_static_prefix_identical_across_turns_and_profiles():
    """Different turn counts, recent_turns, weak_points, and user input must
    not change a single byte of the static prefix."""
    for version in VERSIONS:
        prefixes = []
        for key, profile in PROFILES.items():
            system, user = build_layered_prompt(USER_INPUT, profile, version)
            assert _wire(system, user).startswith(system + "\n\n")
            prefixes.append((key, system))
        baseline_key, baseline = prefixes[0]
        for key, system in prefixes[1:]:
            assert system == baseline, (
                f"static prefix differs between profiles '{baseline_key}' and "
                f"'{key}' ({version}) — dynamic content leaked into the prefix"
            )


def test_static_prefix_identical_regular_vs_assessment_turn():
    regular = _profile(turn_count=7, level="intermediate")
    assessment = _profile(turn_count=10, level="intermediate")
    sys_r, _ = build_layered_prompt("hola", regular, "v1")
    sys_a, _ = build_layered_prompt("adios", assessment, "v1")
    assert sys_r == sys_a, "assessment turns must not mutate the static prefix"


def test_v1_and_v2_share_common_prefix():
    """v2 only appends its challenge block — everything before it is shared."""
    profile = _profile(turn_count=3)
    sys_v1, _ = build_layered_prompt("hola", profile, "v1")
    sys_v2, _ = build_layered_prompt("hola", profile, "v2")
    assert sys_v2.startswith(sys_v1), "v2 must extend the v1 prefix, not alter it"


def test_static_prefix_exceeds_cache_minimum():
    """OpenAI automatic caching needs a >=1024-token prefix; >5000 chars is a
    conservative proxy. Every version pays for its own cache entry, so every
    version has to clear the bar."""
    for version in VERSIONS:
        system, _ = build_layered_prompt("hola", PROFILES["fresh"], version)
        assert len(system) > 5000, f"{version} static prefix only {len(system)} chars"


# --- Eyes-free profile (task 3.3) ---
# A third prompt_version, not a tweak of v2: with the screen off the turn is a
# serial audio stream, so the prefix trades the language-mix/suggestion rules for
# a hard 2-chunk budget and a listenable error_explanation.

def test_eyesfree_is_a_distinct_prefix():
    profile = _profile(turn_count=3)
    sys_v1, _ = build_layered_prompt("hola", profile, "v1")
    sys_v2, _ = build_layered_prompt("hola", profile, "v2")
    sys_ef, user_ef = build_layered_prompt("hola", profile, "eyesfree")

    assert "EYES-FREE FORMAT" in sys_ef
    assert sys_ef not in (sys_v1, sys_v2)
    for other in (sys_v1, sys_v2):
        assert "EYES-FREE FORMAT" not in other
    assert "V2 CHALLENGE FORMAT" not in sys_ef, "eyes-free must not stack on the v2 block"
    # The end-of-prompt reminder lives in the dynamic tail, like v2's
    assert "FOLLOW THE EYES-FREE FORMAT" in user_ef
    assert "FOLLOW THE EYES-FREE FORMAT" not in sys_ef


def test_eyesfree_replaces_rather_than_contradicts_suggestion_rules():
    """Suggestions are suppressed at the source: the eyes-free prefix must not
    also carry the 'generate N suggestions' rules it overrides."""
    profile = _profile(turn_count=3)
    sys_ef, _ = build_layered_prompt("hola", profile, "eyesfree")
    assert '"suggested_replies": []' in sys_ef
    assert "Generate 2 short replies" not in sys_ef
    assert "Keep suggestions brief" not in sys_ef


# --- Scene layer (task 5.1) ---
# The scene is the one piece of per-turn content most likely to be written into
# the static prefix by accident (it reads like setup), and doing so would mint a
# new prompt-cache prefix every 5-10 turns. These tests exist to catch that.

SCENE = {
    "id": "scene_test",
    "created_at": 1700000000,
    "setting": "a corner café ten minutes before it closes",
    "character_goal": "you need the learner to agree to be your alibi for last night",
    "user_goal": "find out what you are actually up to",
    "complication": "you have about five minutes before you have to go",
    "completion_condition": "the learner has clearly agreed to cover for you, or clearly refused",
    "turn_budget": 6,
    "turns_elapsed": 0,
    "status": "active",
    "source": "dimensions",
}


def _scene_profile(turns_elapsed=0, status="active", turn_count=3, **scene_overrides):
    profile = _profile(turn_count=turn_count)
    profile["scene"] = {**SCENE, "turns_elapsed": turns_elapsed, "status": status,
                        **scene_overrides}
    return profile


def test_scene_goes_in_the_dynamic_tail_only():
    profile = _scene_profile()
    system, user = build_layered_prompt(USER_INPUT, profile, "v1")
    assert SCENE["character_goal"] in user
    assert SCENE["completion_condition"] in user
    assert "CURRENT SCENE" in user
    for text in (SCENE["setting"], SCENE["character_goal"], SCENE["complication"],
                 SCENE["completion_condition"], "CURRENT SCENE", "SCENE PACING"):
        assert text not in system, "scene content leaked into the cached static prefix"


def test_static_prefix_survives_a_scene_change():
    """Two different scenes, same run config → the prefix must not move a byte."""
    for version in VERSIONS:
        sys_a, _ = build_layered_prompt("hola", _scene_profile(), version)
        sys_b, _ = build_layered_prompt("hola", _scene_profile(
            turns_elapsed=4,
            setting="a rooftop at night",
            character_goal="you broke something of theirs",
            completion_condition="you have actually admitted it out loud",
        ), version)
        sys_none, _ = build_layered_prompt("hola", _profile(turn_count=3), version)
        assert sys_a == sys_b == sys_none, f"scene state changed the {version} prefix"


def test_no_scene_produces_the_pre_scene_tail():
    """A profile with no scene (pre-5.1, or a failed draw) must produce exactly
    the tail it produced before the scene layer existed — no blank gaps."""
    profile = _profile(turn_count=3)
    _, user = build_layered_prompt(USER_INPUT, profile, "v1")
    assert "CURRENT SCENE" not in user and "SCENE PACING" not in user
    assert "\n\n\n" not in user


def test_completed_scene_is_not_rendered():
    _, user = build_layered_prompt(USER_INPUT, _scene_profile(turns_elapsed=6, status="complete"), "v1")
    assert "CURRENT SCENE" not in user and "SCENE PACING" not in user


# The scene block references the pacing block by name, so tests match the header
# itself rather than the bare words.
PACING_HEADER = "SCENE PACING —"


def test_scene_pacing_tracks_the_clock():
    """turns_elapsed counts completed turns, so the turn being written is +1."""
    def pacing(turns_elapsed):
        _, user = build_layered_prompt(USER_INPUT, _scene_profile(turns_elapsed), "v1")
        return user.split(PACING_HEADER)[1]

    assert "turn 1 of 6" in pacing(0)
    assert "just started" in pacing(0)

    middle = pacing(2)
    assert "turn 3 of 6" in middle
    assert "push it forward" in middle

    penultimate = pacing(4)
    assert "One turn left" in penultimate

    final = pacing(5)
    assert "turn 6 of 6" in final
    assert "FINAL turn" in final
    # The ending has to be named, not gestured at
    assert SCENE["completion_condition"] in final


def test_scene_pacing_is_the_last_directive_before_the_input():
    _, user = build_layered_prompt(USER_INPUT, _scene_profile(turns_elapsed=5), "v1")
    assert user.index(PACING_HEADER) > user.index("Current learner level")
    assert user.index(PACING_HEADER) < user.index("CURRENT USER INPUT")


def test_scene_pacing_survives_an_assessment_turn():
    """Every 5th turn replaces the turn instruction wholesale — the scene clock
    must not disappear with it."""
    profile = _scene_profile(turns_elapsed=4, turn_count=10)
    _, user = build_layered_prompt(USER_INPUT, profile, "v1")
    assert "ASSESSMENT TURN" in user
    assert "SCENE PACING" in user


def test_scene_without_an_ending_is_dropped():
    """A scene whose completion condition went missing is worse than no scene:
    it is a premise that can never resolve."""
    _, user = build_layered_prompt(USER_INPUT, _scene_profile(completion_condition=""), "v1")
    assert "CURRENT SCENE" not in user and "SCENE PACING" not in user


def test_unknown_prompt_version_falls_back_to_v1():
    """An unrecognized version must reuse v1's prefix, not mint a fourth
    cache entry."""
    profile = _profile(turn_count=3)
    assert build_layered_prompt("hola", profile, "v3") == \
           build_layered_prompt("hola", profile, "v1")
    assert build_layered_prompt("hola", profile, None) == \
           build_layered_prompt("hola", profile, "v1")
