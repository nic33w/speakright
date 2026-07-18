"""Shared endpoints: /api/config, /api/usage*, /api/greetings/random."""
import json
import random
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from settings import (
    AZURE_REGION,
    AZURE_SPEECH_KEY,
    GREETING_AUDIO_DIR,
    I18N_DIR,
    MOCK_MODE,
)
from usage_tracker import get_summary, start_new_session

router = APIRouter()


class UsageSessionStartReq(BaseModel):
    mode: str


class GreetingSuggestion(BaseModel):
    id: str
    text_native: str  # English translation (for display)
    text_target: str  # Target language text
    audio_file: Optional[str] = None  # URL path to pre-generated audio


@router.get("/api/config")
def get_config():
    """Return configuration info including mock mode status"""
    return {
        "mock_mode": MOCK_MODE,
        "has_azure_tts": bool(AZURE_SPEECH_KEY and AZURE_REGION)
    }


@router.post("/api/usage/session/start")
def api_usage_session_start(req: UsageSessionStartReq):
    start_new_session(req.mode)
    return {"ok": True}


@router.get("/api/usage")
def api_usage():
    return get_summary()


@router.get("/api/greetings/random")
def get_random_greetings(
    target_lang: str = "es",
    ui_lang: str = "en",
    count: int = 3
):
    """
    Get random greeting suggestions for the target language.
    Returns greetings with pre-generated audio file paths if available.
    """
    # Load greetings for target language
    greetings_file = I18N_DIR / f"{target_lang}.json"
    if not greetings_file.exists():
        return {"greetings": []}

    with open(greetings_file, 'r', encoding='utf-8') as f:
        all_greetings = json.load(f)

    # Weighted random selection WITHOUT replacement (no duplicates)
    # We pick one at a time, removing selected items from the pool
    selected = []
    available = list(all_greetings)  # Copy to avoid modifying original
    pick_count = min(count, len(available))

    for _ in range(pick_count):
        if not available:
            break
        weights = [g.get("weight", 1.0) for g in available]
        chosen = random.choices(available, weights=weights, k=1)[0]
        selected.append(chosen)
        available.remove(chosen)  # Remove to prevent duplicates

    # Build response with audio file paths
    result = []
    for g in selected:
        greeting_id = g.get("id")
        audio_path = GREETING_AUDIO_DIR / target_lang / f"{greeting_id}.wav"

        audio_url = None
        if audio_path.exists():
            audio_url = f"/api/audio_file/greetings/{target_lang}/{greeting_id}.wav"

        result.append(GreetingSuggestion(
            id=greeting_id,
            text_native=g.get("translation_en", g.get("text")),  # Show English translation
            text_target=g.get("text"),  # Target language text
            audio_file=audio_url
        ))

    return {"greetings": result}
