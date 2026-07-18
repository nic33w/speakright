"""Messenger learner-profile persistence (profiles/default_profile.json),
persona/helper JSON loaders, and the level-assessment profile update.
Shared by the messenger and quiz routers.
"""
import json
import time
from typing import Any, Dict, Optional

from models import LangSpec
from settings import (
    DEFAULT_PROFILE_PATH,
    DISALLOWED_WEAK_POINTS,
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
        if item not in profile["comfortable_with"]:
            profile["comfortable_with"].append(item)

    # Update weak_points
    for item in assessment.get("add_weak", []):
        if item.strip().lower() in DISALLOWED_WEAK_POINTS:
            continue
        if item not in profile["weak_points"]:
            profile["weak_points"].append(item)

    for item in assessment.get("remove_weak", []):
        if item in profile["weak_points"]:
            profile["weak_points"].remove(item)

    # Cap size, keeping the most recently added entries
    if len(profile["weak_points"]) > MAX_WEAK_POINTS:
        profile["weak_points"] = profile["weak_points"][-MAX_WEAK_POINTS:]

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
