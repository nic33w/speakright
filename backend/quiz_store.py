"""Spaced-repetition quiz item storage (quiz_items/default_quiz.json) and the
local answer-checking helpers. Shared by the messenger router (candidate intake,
pending-quiz lookup) and the quiz router.
"""
import json
import re
import time
import unicodedata
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional

from profile_store import load_profile
from settings import DEFAULT_QUIZ_PATH, QUIZ_TURNS_DELAY


# --- Quiz Storage Functions ---

def load_quiz_items() -> List[Dict[str, Any]]:
    """Load quiz items from JSON file."""
    if not DEFAULT_QUIZ_PATH.exists():
        return []
    with open(DEFAULT_QUIZ_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_quiz_items(items: List[Dict[str, Any]]) -> None:
    """Save quiz items to JSON file."""
    with open(DEFAULT_QUIZ_PATH, 'w', encoding='utf-8') as f:
        json.dump(items, f, ensure_ascii=False, indent=2)


def add_quiz_item(candidate: Dict[str, Any], turn_count: int) -> Dict[str, Any]:
    """Add a new quiz item from a quiz candidate."""
    items = load_quiz_items()

    # The answer IS the "corrected" field
    corrected = candidate.get("corrected", "")
    quiz_prompt = candidate.get("quiz_prompt", "") or candidate.get("quiz_question", "") or candidate.get("prompt_native", "")

    if not corrected:
        return None

    # Check for duplicates (same corrected answer)
    for item in items:
        existing_answer = item.get("corrected", "")
        if existing_answer.lower() == corrected.lower():
            # Already exists, skip
            return None

    new_item = {
        "id": f"quiz_{int(time.time() * 1000)}_{len(items)}",
        "type": candidate.get("type", "correction"),
        "original": candidate.get("original", ""),
        "corrected": corrected,  # THIS IS THE ANSWER
        "error_type": candidate.get("error_type", "unknown"),
        "quiz_prompt": quiz_prompt,
        "created_at": int(time.time()),
        "created_at_turn": turn_count,
        "show_after_turn": turn_count + QUIZ_TURNS_DELAY,
        "times_reviewed": 0,
        "last_reviewed": None,
        "mastery_level": 0,
        "is_answered": False
    }

    items.append(new_item)
    save_quiz_items(items)
    return new_item


def get_pending_quiz(turn_count: int) -> Optional[Dict[str, Any]]:
    """Get a quiz item that's ready to be shown (based on turn count)."""
    items = load_quiz_items()

    # Filter items that are ready and not yet mastered
    pending = [
        item for item in items
        if item.get("show_after_turn", 0) <= turn_count
        and item.get("mastery_level", 0) < 3
        and not item.get("is_answered", False)
    ]

    if not pending:
        return None

    # Sort by: mastery_level ASC, times_reviewed ASC, created_at ASC
    pending.sort(key=lambda x: (
        x.get("mastery_level", 0),
        x.get("times_reviewed", 0),
        x.get("created_at", 0)
    ))

    return pending[0]


def update_quiz_item(quiz_id: str, is_correct: bool) -> Dict[str, Any]:
    """Update a quiz item after user answers."""
    items = load_quiz_items()

    for item in items:
        if item.get("id") == quiz_id:
            item["times_reviewed"] = item.get("times_reviewed", 0) + 1
            item["last_reviewed"] = int(time.time())
            item["is_answered"] = True

            if is_correct:
                # Increase mastery
                item["mastery_level"] = min(3, item.get("mastery_level", 0) + 1)
                # Schedule next review further out
                profile = load_profile()
                turn_count = profile.get("turn_count", 0)
                # Exponential backoff: 3, 6, 12 turns
                delay = QUIZ_TURNS_DELAY * (2 ** item["mastery_level"])
                item["show_after_turn"] = turn_count + delay
            else:
                # Reset mastery on wrong answer
                item["mastery_level"] = 0
                # Show again soon
                profile = load_profile()
                turn_count = profile.get("turn_count", 0)
                item["show_after_turn"] = turn_count + 1

            item["is_answered"] = False  # Allow it to be shown again
            save_quiz_items(items)
            return item

    return None


# --- Local answer checking ---

def normalize_answer(text: str) -> str:
    """Normalize answer for comparison (lowercase, strip, remove extra spaces)."""
    if not text:
        return ""
    # Normalize unicode
    text = unicodedata.normalize('NFC', text)
    # Lowercase and strip
    text = text.lower().strip()
    # Remove punctuation except apostrophes
    text = re.sub(r'[^\w\s\']', '', text)
    # Normalize whitespace
    text = re.sub(r'\s+', ' ', text)
    return text


def check_answer_locally(user_answer: str, correct_answer: str) -> tuple:
    """
    Check if user answer matches correct answer locally.
    Returns (is_match, confidence).
    """
    norm_user = normalize_answer(user_answer)
    norm_correct = normalize_answer(correct_answer)

    # Exact match
    if norm_user == norm_correct:
        return True, 1.0

    # Check with SequenceMatcher
    ratio = SequenceMatcher(None, norm_user, norm_correct).ratio()
    if ratio >= 0.85:  # Very close match
        return True, ratio

    return False, ratio
