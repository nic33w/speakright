"""Pydantic models shared by more than one router.

Per-router request models live in their routers; only cross-feature models
belong here (LangSpec is embedded in nearly every request model; the messenger
response models are shared by the live-LLM and premade paths; the quiz models
are shared by messenger candidate intake and the quiz router).
"""
from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class LangSpec(BaseModel):
    code: str
    name: str


class ResponseChunk(BaseModel):
    text: str
    language: str  # "ui" | "target"
    modality: str  # "text" | "audio"
    audio_file: Optional[str] = None
    reaction_audio_file: Optional[str] = None  # pre-generated static audio for a REACTION OPENERS match (chunk 0)
    locale: Optional[str] = None
    purpose: Optional[str] = None
    native_text: Optional[str] = None   # v2: translation of challenge chunk
    is_challenge: Optional[bool] = None  # v2: marks the last chunk as a learning challenge


class SuggestedReply(BaseModel):
    id: str  # e.g. "r1", "r2", "r3"
    text_native: str  # Text in user's native/UI language
    text_target: str  # Text in target language


class TokenUsage(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cost_cents: float


class MessengerTurnResponse(BaseModel):
    turn_id: str
    corrected_input: str
    user_translation: Optional[str] = None
    had_errors: bool
    error_explanation: str
    input_intent: str  # "english" | "spanish"
    response_chunks: List[ResponseChunk]
    suggested_replies: Optional[List[SuggestedReply]] = []
    profile_updated: bool
    new_level: Optional[str] = None
    token_usage: Optional[TokenUsage] = None
    pending_quiz: Optional[Dict[str, Any]] = None  # Quiz item to show user


class QuizCandidate(BaseModel):
    type: str  # "correction" or "translation"
    original: str  # What user said (wrong or in native language)
    corrected: str  # The correct target language - THIS IS THE ANSWER
    error_type: str
    quiz_prompt: str  # Question in UI language


class QuizItem(BaseModel):
    id: str
    type: str  # "correction" or "translation"
    original: str  # What user said
    corrected: str  # Correct target language - THIS IS THE ANSWER
    error_type: str
    quiz_prompt: str  # Question in UI language (e.g., "How do you say 'store' in Spanish?")
    created_at: int
    created_at_turn: int  # Turn number when created
    show_after_turn: int  # Show quiz after this turn number
    times_reviewed: int = 0
    last_reviewed: Optional[int] = None
    mastery_level: int = 0  # 0=new, 1=learning, 2=familiar, 3=mastered
    is_answered: bool = False
