"""Spaced-repetition quiz review endpoints: /api/quiz/check, /pending, /stats."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from profile_store import load_profile
from quiz_store import (
    check_answer_locally,
    get_pending_quiz,
    load_quiz_items,
    update_quiz_item,
)

router = APIRouter()


class QuizAnswerRequest(BaseModel):
    quiz_id: str
    user_answer: str


class QuizAnswerResponse(BaseModel):
    is_correct: bool
    feedback: str
    correct_answer: str
    mastery_level: int


@router.post("/api/quiz/check")
def check_quiz_answer(req: QuizAnswerRequest):
    """
    Check user's quiz answer. First tries local matching, then LLM if needed.
    """
    from llm_call import check_trivia_answer

    # Load the quiz item
    items = load_quiz_items()
    quiz_item = None
    for item in items:
        if item.get("id") == req.quiz_id:
            quiz_item = item
            break

    if not quiz_item:
        raise HTTPException(status_code=404, detail="Quiz item not found")

    # The answer is the "corrected" field
    correct_answer = quiz_item.get("corrected", "")

    # Try local matching first
    is_correct, confidence = check_answer_locally(req.user_answer, correct_answer)

    if confidence >= 0.85:
        # High confidence local match
        feedback = "Correct! Great job!" if is_correct else f"Not quite. The answer is: {correct_answer}"
    elif confidence >= 0.5:
        # Medium confidence - use LLM to verify
        profile = load_profile()
        quiz_prompt = quiz_item.get("quiz_prompt", "")
        llm_result = check_trivia_answer(
            user_answer=req.user_answer,
            correct_answer=correct_answer,
            english_prompt=quiz_prompt,
            fluent=profile.get("ui_language", {"code": "en", "name": "English"}),
            learning=profile.get("target_language", {"code": "es", "name": "Spanish"})
        )
        is_correct = llm_result.get("is_correct", False)
        feedback = llm_result.get("feedback", "")
    else:
        # Low confidence - wrong answer
        is_correct = False
        feedback = f"Not quite. The answer is: {correct_answer}"

    # Update quiz item
    updated_item = update_quiz_item(req.quiz_id, is_correct)

    return QuizAnswerResponse(
        is_correct=is_correct,
        feedback=feedback,
        correct_answer=correct_answer,
        mastery_level=updated_item.get("mastery_level", 0) if updated_item else 0
    )


@router.get("/api/quiz/pending")
def get_quiz_pending():
    """Get the next pending quiz item."""
    profile = load_profile()
    turn_count = profile.get("turn_count", 0)
    pending = get_pending_quiz(turn_count)
    return {"quiz": pending}


@router.get("/api/quiz/stats")
def get_quiz_stats():
    """Get quiz statistics."""
    items = load_quiz_items()

    total = len(items)
    mastered = len([i for i in items if i.get("mastery_level", 0) >= 3])
    learning = len([i for i in items if 0 < i.get("mastery_level", 0) < 3])
    new = len([i for i in items if i.get("mastery_level", 0) == 0])

    return {
        "total": total,
        "mastered": mastered,
        "learning": learning,
        "new": new
    }
