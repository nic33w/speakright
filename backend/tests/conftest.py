"""Test fixtures for the SpeakRight backend.

Forces MOCK_MODE on (no API keys / no spend) and ENABLE_QUIZZING on (so the
quiz-related prompt sections are exercised) BEFORE the app modules are imported,
because game_backend / llm_call / tts_helpers all read these env vars at import
time. Explicit env vars win over .env since load_dotenv() does not override
existing variables.

Tests run against the real state dirs (profiles/, quiz_items/, ...), which are
gitignored runtime state. Every file a mock-mode request can mutate is backed up
before the session and restored afterwards, so test runs leave no trace in the
user's own profile, quiz deck, chat logs, or usage totals.
"""
import os
import sys
from pathlib import Path

os.environ["MOCK_MODE"] = "1"
os.environ["ENABLE_QUIZZING"] = "1"

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

import pytest
from fastapi.testclient import TestClient

# Files that mock-mode requests mutate (profile/quiz/log/usage state).
MUTABLE_STATE_FILES = [
    BACKEND_DIR / "profiles" / "default_profile.json",
    BACKEND_DIR / "quiz_items" / "default_quiz.json",
    BACKEND_DIR / "user_profile.json",
    BACKEND_DIR / "usage_data.json",
    BACKEND_DIR / "chat_log_es.md",
    BACKEND_DIR / "chat_log_id.md",
]


@pytest.fixture(scope="session", autouse=True)
def preserve_state_files():
    saved = {}
    for path in MUTABLE_STATE_FILES:
        saved[path] = path.read_bytes() if path.exists() else None
    yield
    for path, content in saved.items():
        if content is None:
            if path.exists():
                path.unlink()
        else:
            path.write_bytes(content)


@pytest.fixture(scope="session")
def client():
    from game_backend import app

    with TestClient(app) as c:
        yield c
