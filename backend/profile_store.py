"""Messenger learner-profile persistence (profiles/default_profile.json),
persona/helper JSON loaders, scene state, and the level-assessment profile update.
Shared by the messenger and quiz routers.
"""
import json
import random
import re
import time
from typing import Any, Dict, Optional

from models import LangSpec
from settings import (
    DEFAULT_PROFILE_PATH,
    DISALLOWED_WEAK_POINTS,
    MAX_COMFORTABLE_WITH,
    MAX_WEAK_POINTS,
    PROMPTS_DIR,
    SCENE_MAX_TURNS,
    SCENE_MIN_TURNS,
)


# --- Persona Loading Functions ---

def load_persona_json(persona_id: str) -> Optional[Dict[str, Any]]:
    """Load persona from JSON file."""
    persona_file = PROMPTS_DIR / "persona" / f"{persona_id}.json"
    if persona_file.exists():
        with open(persona_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    return None


def load_helper_json(helper_id: str) -> Optional[Dict[str, Any]]:
    """Load helper configuration from JSON file."""
    helper_file = PROMPTS_DIR / "helpers" / f"{helper_id}.json"
    if helper_file.exists():
        with open(helper_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    return None


# --- Profile CRUD Functions ---

def init_default_profile(ui_lang: LangSpec, target_lang: LangSpec) -> Dict[str, Any]:
    """Create a fresh default profile."""
    now = int(time.time())
    return {
        "created_at": now,
        "last_updated": now,
        "ui_language": ui_lang.dict(),
        "target_language": target_lang.dict(),
        "level": "beginner",
        "level_confidence": 0.5,
        "level_history": [
            {"timestamp": now, "level": "beginner", "reason": "Initial profile creation"}
        ],
        "comfortable_with": [],
        "weak_points": [],
        "avoid_topics": [],
        "turn_count": 0,
        "corrections_needed": 0,
        "last_assessment_turn": 0,
        "recent_turns": [],
        # Task 5.1. None until the first turn creates one; every reader uses
        # .get("scene"), so profiles written before 5.1 stay valid.
        "scene": None
    }


def load_profile() -> Dict[str, Any]:
    """Load profile from default_profile.json. Create if not exists."""
    if not DEFAULT_PROFILE_PATH.exists():
        # Create default profile
        profile = init_default_profile(
            LangSpec(code="en", name="English"),
            LangSpec(code="es", name="Spanish")
        )
        save_profile(profile)
        return profile

    with open(DEFAULT_PROFILE_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_profile(profile: Dict[str, Any]) -> None:
    """Save profile to default_profile.json."""
    profile["last_updated"] = int(time.time())
    with open(DEFAULT_PROFILE_PATH, 'w', encoding='utf-8') as f:
        json.dump(profile, f, ensure_ascii=False, indent=2)


# --- Scene state (task 5.1) ---
#
# A scene is a setting + a goal for each side + a complication + an explicit
# completion condition, and it lasts a fixed handful of turns before it ends for
# real. The state lives in the profile next to level_history; the prompt side
# reads it in prompts/messenger_prompt.py, and routers/messenger.py drives the
# lifecycle (create -> advance -> complete -> create the next one).
#
# The dimensions are sampled here rather than left to the model: asking an LLM
# for "a scene" repeatedly converges on the same three scenes, whereas one draw
# per list does not. The LLM's job (llm_call.generate_scene) is only to turn the
# draw into something concrete.

SCENE_DIMENSION_KEYS = (
    "setting", "character_goal", "user_goal", "complication", "completion_condition",
)


def pick_scene_dimensions(previous: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    """Draw one item per dimension from prompts/helpers/scene_dimensions.json.

    `previous` is the scene that just ended, if any: its setting and character
    goal are excluded from the draw so two scenes in a row never open the same
    way. Returns {} when the dimensions file is missing or malformed — the caller
    treats that as "run without a scene" rather than inventing one.
    """
    dims = load_helper_json("scene_dimensions") or {}
    settings_list = [s for s in dims.get("settings", []) if s]
    goals = [g for g in dims.get("character_goals", []) if g.get("goal")]
    user_goals = [u for u in dims.get("user_goals", []) if u]
    complications = [c for c in dims.get("complications", []) if c]
    if not (settings_list and goals and user_goals and complications):
        return {}

    prev = previous or {}
    # Only apply the exclusion while it still leaves something to pick from.
    fresh_settings = [s for s in settings_list if s != prev.get("setting")] or settings_list
    fresh_goals = [g for g in goals if g["goal"] != prev.get("character_goal")] or goals

    goal = random.choice(fresh_goals)
    return {
        "setting": random.choice(fresh_settings),
        "character_goal": goal["goal"],
        "user_goal": random.choice(user_goals),
        "complication": random.choice(complications),
        "completion_condition": goal.get("completion", "the goal is settled one way or the other"),
    }


def new_scene(dimensions: Dict[str, str], concretized: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Build a fresh active scene from a dimension draw.

    `concretized` is llm_call.generate_scene's output when it succeeded; each of
    its non-empty fields overrides the raw dimension of the same name. A failed
    or skipped generation therefore degrades to the drawn dimensions verbatim,
    which are already playable — the scene layer never depends on that call.
    """
    scene = {
        "id": f"scene_{int(time.time() * 1000)}",
        "created_at": int(time.time()),
        "turn_budget": random.randint(SCENE_MIN_TURNS, SCENE_MAX_TURNS),
        "turns_elapsed": 0,
        "status": "active",
        "source": "dimensions",
    }
    for key in SCENE_DIMENSION_KEYS:
        scene[key] = dimensions.get(key, "")
    if concretized:
        for key in SCENE_DIMENSION_KEYS:
            value = concretized.get(key)
            if isinstance(value, str) and value.strip():
                scene[key] = value.strip()
                scene["source"] = "llm"
    return scene


def advance_scene(profile: Dict[str, Any]) -> None:
    """Count the turn that just finished against the active scene's budget.

    Completion is the turn budget running out, not a flag from the model: the
    completion condition is what the *character* is playing toward, and the
    prompt's final-turn instruction is what makes it land. Deciding it here keeps
    scene length predictable and keeps the output schema (static prefix) untouched.
    """
    scene = profile.get("scene")
    if not scene or scene.get("status") != "active":
        return
    scene["turns_elapsed"] = scene.get("turns_elapsed", 0) + 1
    if scene["turns_elapsed"] >= scene.get("turn_budget", SCENE_MAX_TURNS):
        scene["status"] = "complete"
        scene["completed_at"] = int(time.time())


# --- Level Assessment Logic ---

def _normalize_tag(item: str) -> list:
    """Normalize a weak_points/comfortable_with entry to a word list for comparison."""
    return re.sub(r"\s+", " ", item.strip().lower()).split(" ")


def _is_near_duplicate(a: str, b: str) -> bool:
    """True if `a` and `b` are the same tag, or one is a whole-word prefix of the other.

    Short freeform LLM-generated phrases drift turn to turn ("grammar" vs "grammar
    structure"), and exact-string dedup alone lets the same underlying issue pile up under
    several spellings. Word-prefix (not raw substring) matching avoids false positives like
    "issue-1" vs "issue-12", which share characters but aren't the same tag at all.
    """
    wa, wb = _normalize_tag(a), _normalize_tag(b)
    shorter, longer = (wa, wb) if len(wa) <= len(wb) else (wb, wa)
    return bool(shorter) and longer[: len(shorter)] == shorter


def _upsert_tag(items: list, candidate: str, cap: int) -> None:
    """Add `candidate` to `items`, merging near-duplicates and capping to the most recent `cap`.

    On a merge, the more specific (longer) phrasing wins, and the entry moves to the end of
    the list either way — so a tag that keeps getting reaffirmed survives eviction, while
    eviction drops whichever entries nobody has re-flagged in a while first (the front).
    """
    for i, existing in enumerate(items):
        if _is_near_duplicate(existing, candidate):
            items.pop(i)
            candidate = candidate if len(candidate) > len(existing) else existing
            break
    items.append(candidate)
    if len(items) > cap:
        del items[: len(items) - cap]


def update_profile_from_assessment(
    profile: Dict[str, Any],
    assessment: Dict[str, Any]
) -> tuple:
    """Update profile based on LLM assessment. Returns (profile, profile_updated)."""
    current_level = profile.get("level", "beginner")
    new_level = assessment.get("current_level", current_level)
    confidence = assessment.get("confidence", 0.5)
    should_update = assessment.get("should_update", False)

    # Update comfortable_with
    for item in assessment.get("add_comfortable", []):
        _upsert_tag(profile["comfortable_with"], item, MAX_COMFORTABLE_WITH)
    # Defensive: also trim if the list was already over cap before this call (e.g. legacy
    # profiles saved before comfortable_with had a cap at all).
    if len(profile["comfortable_with"]) > MAX_COMFORTABLE_WITH:
        del profile["comfortable_with"][: len(profile["comfortable_with"]) - MAX_COMFORTABLE_WITH]

    # Update weak_points
    for item in assessment.get("add_weak", []):
        if item.strip().lower() in DISALLOWED_WEAK_POINTS:
            continue
        _upsert_tag(profile["weak_points"], item, MAX_WEAK_POINTS)

    for item in assessment.get("remove_weak", []):
        if item in profile["weak_points"]:
            profile["weak_points"].remove(item)

    if len(profile["weak_points"]) > MAX_WEAK_POINTS:
        del profile["weak_points"][: len(profile["weak_points"]) - MAX_WEAK_POINTS]

    # Update level if assessment says so and confidence is high
    if should_update and confidence >= 0.7 and new_level != current_level:
        profile["level"] = new_level
        profile["level_confidence"] = confidence
        profile["level_history"].append({
            "timestamp": int(time.time()),
            "level": new_level,
            "reason": assessment.get("reasoning", "LLM assessment")
        })
        return profile, True  # profile_updated flag

    # Just update confidence even if not changing level
    profile["level_confidence"] = confidence
    return profile, False
