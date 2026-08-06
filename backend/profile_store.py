"""Messenger learner-profile persistence (profiles/default_profile.json),
persona/helper JSON loaders, and the level-assessment profile update.
Shared by the messenger and quiz routers.
"""
import json
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
        "recent_turns": []
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
