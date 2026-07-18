"""Guessing game: LLM picks a secret, user asks yes/no questions to guess."""
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

# In-memory session storage for guessing games
guessing_sessions = {}


class GuessingTurnRequest(BaseModel):
    session_id: str
    theme: str  # "animals", "mythical", etc.
    user_input: str
    guess_count: int


class GuessingGiveUpRequest(BaseModel):
    session_id: str
    theme: str


class GuessingTurnResponse(BaseModel):
    response: str
    is_correct_guess: bool
    answer: Optional[str] = None
    audio_file: Optional[str] = None
    corrected_input: Optional[str] = None
    had_errors: Optional[bool] = False
    error_explanation: Optional[str] = None


class GuessingGiveUpResponse(BaseModel):
    reveal_message: str
    answer: str


@router.post("/api/guessing/turn")
def guessing_game_turn(req: GuessingTurnRequest):
    """
    Process user's question or guess in the guessing game.
    On first turn: LLM picks a secret answer.
    Returns: { response: str, is_correct_guess: bool, answer: str | null }
    """
    from llm_call import call_llm_for_guessing_turn

    session_id = req.session_id

    # Initialize session if new
    if session_id not in guessing_sessions:
        # First turn - LLM picks the secret answer
        from llm_call import call_llm_to_pick_secret

        secret = call_llm_to_pick_secret(req.theme)
        guessing_sessions[session_id] = {
            "theme": req.theme,
            "secret": secret,
            "history": []
        }

    session = guessing_sessions[session_id]
    secret = session["secret"]

    # Call LLM to respond to user's question
    llm_response = call_llm_for_guessing_turn(
        user_input=req.user_input,
        secret=secret,
        theme=req.theme,
        history=session["history"]
    )

    # Add to history
    session["history"].append({
        "user": req.user_input,
        "response": llm_response["response"]
    })

    response_text = llm_response["response"]
    is_correct = llm_response.get("is_correct_guess", False)

    return GuessingTurnResponse(
        response=response_text,
        is_correct_guess=is_correct,
        answer=secret if is_correct else None,
        audio_file=None,  # TODO: Add TTS if needed
        corrected_input=llm_response.get("corrected_input"),
        had_errors=llm_response.get("had_errors", False),
        error_explanation=llm_response.get("error_explanation")
    )


@router.post("/api/guessing/giveup")
def guessing_game_giveup(req: GuessingGiveUpRequest):
    """
    Reveal the answer when user gives up.
    Returns: { reveal_message: str, answer: str }
    """
    session_id = req.session_id

    if session_id not in guessing_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = guessing_sessions[session_id]
    secret = session["secret"]

    # Clean up session
    del guessing_sessions[session_id]

    return GuessingGiveUpResponse(
        reveal_message=f"Nice try! The answer was:",
        answer=secret
    )
