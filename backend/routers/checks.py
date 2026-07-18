"""LLM answer-checking endpoints shared by the checking modes:
/api/trivia/check and /api/battle/check (battle also logs mistakes to
user_profile.json).
"""
import json
from datetime import datetime
from typing import Dict, List, Optional

from fastapi import APIRouter
from pydantic import BaseModel

from models import LangSpec
from settings import USER_PROFILE_PATH

router = APIRouter()


class TriviaCheckReq(BaseModel):
    session_id: str
    user_answer: str
    correct_answer: str  # The correct answer in the learning language
    prompt_text: str  # The prompt text in the fluent language
    learning: Optional[LangSpec] = None
    fluent: Optional[LangSpec] = None


class BattleCheckReq(BaseModel):
    session_id: str
    user_answer: str
    correct_answer: str
    accepted_translations: Optional[List[str]] = None
    valid_phrases: Optional[List[str]] = None
    required_word: Optional[str] = None
    prompt_text: str
    learning: Optional[LangSpec] = None
    fluent: Optional[LangSpec] = None
    conversation_id: Optional[str] = None
    difficulty: Optional[str] = None
    hints_used_count: int = 0
    hints_used_phrases: List[Dict[str, str]] = []


# --- Battle mistake log (user_profile.json) ---

def _load_user_profile() -> dict:
    if not USER_PROFILE_PATH.exists():
        return {"mistake_log": [], "topics_to_practice": []}
    with open(USER_PROFILE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_user_profile(profile: dict):
    with open(USER_PROFILE_PATH, "w", encoding="utf-8") as f:
        json.dump(profile, f, ensure_ascii=False, indent=2)


def _log_battle_mistake(issues, conversation_id, difficulty, native, user_answer, damage_multiplier, hints_used_count, hints_used_phrases):
    profile = _load_user_profile()
    feedback_keys = [issue.get("feedback_key") for issue in issues if issue.get("feedback_key")]
    entry = {
        "timestamp": datetime.utcnow().isoformat(),
        "conversation_id": conversation_id,
        "difficulty": difficulty,
        "native": native,
        "user_answer": user_answer,
        "feedback_keys": feedback_keys,
        "issues": issues,
        "damage_multiplier": damage_multiplier,
        "hints_used_count": hints_used_count,
        "hints_used_phrases": hints_used_phrases,
    }
    profile["mistake_log"].append(entry)
    _save_user_profile(profile)


@router.post("/api/trivia/check")
def api_trivia_check(req: TriviaCheckReq):
    """
    Validate user's answer against correct answer using LLM.
    Works for any language pair (English-Spanish, Indonesian-English, English-Indonesian).
    Returns: { is_correct: bool, feedback: str, corrected_answer: str }
    """
    from llm_call import check_trivia_answer

    fluent = req.fluent or LangSpec(code='en', name='English')
    learning = req.learning or LangSpec(code='es', name='Spanish')

    try:
        result = check_trivia_answer(
            user_answer=req.user_answer,
            correct_answer=req.correct_answer,
            english_prompt=req.prompt_text,
            fluent=fluent.dict(),
            learning=learning.dict(),
        )

        return {
            "is_correct": result.get("is_correct", False),
            "feedback": result.get("feedback", ""),
            "corrected_answer": result.get("corrected_answer", req.correct_answer),
        }
    except Exception as e:
        print("Trivia check failed:", e)
        import traceback
        traceback.print_exc()
        return {
            "is_correct": False,
            "feedback": "Unable to check answer. Please try again.",
            "corrected_answer": req.correct_answer,
        }


@router.post("/api/battle/check")
def api_battle_check(req: BattleCheckReq):
    """
    Check battle answer - reuses trivia check logic.
    Fuzzy match first, then LLM semantic fallback.
    """
    from llm_call import check_trivia_answer

    fluent = req.fluent or LangSpec(code='en', name='English')
    learning = req.learning or LangSpec(code='es', name='Spanish')

    try:
        result = check_trivia_answer(
            user_answer=req.user_answer,
            correct_answer=req.correct_answer,
            english_prompt=req.prompt_text,
            fluent=fluent.dict(),
            learning=learning.dict(),
            accepted_translations=req.accepted_translations,
            valid_phrases=req.valid_phrases,
            required_vocab=req.required_word,
        )

        issues = result.get("issues", [])

        # Log mistakes (skip perfect scores and ASR errors)
        loggable_issues = [i for i in issues if i.get("feedback_key") and i.get("feedback_key") != "asr_error"]
        if loggable_issues:
            try:
                _log_battle_mistake(
                    issues=issues,
                    conversation_id=req.conversation_id,
                    difficulty=req.difficulty,
                    native=req.prompt_text,
                    user_answer=req.user_answer,
                    damage_multiplier=result.get("damage_multiplier", 0.0),
                    hints_used_count=req.hints_used_count,
                    hints_used_phrases=req.hints_used_phrases,
                )
            except Exception as log_err:
                print(f"Warning: failed to log battle mistake: {log_err}")

        return {
            "accepted": result.get("accepted", False),
            "damage_multiplier": result.get("damage_multiplier", 0.0),
            "issues": issues,
            "feedback_key": result.get("feedback_key", None),
            "corrected_snippet": result.get("corrected_snippet", None),
            "feedback_explanation": result.get("feedback_explanation", None),
            "correction_tokens": result.get("correction_tokens", None),
            "fast_path": result.get("fast_path", False),
            "token_usage": result.get("token_usage"),
        }
    except Exception as e:
        print("Battle check failed:", e)
        import traceback
        traceback.print_exc()
        return {
            "accepted": False,
            "damage_multiplier": 0.0,
            "feedback_key": None,
            "corrected_snippet": None,
            "token_usage": None,
        }
