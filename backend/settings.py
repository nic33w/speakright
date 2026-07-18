"""Central configuration for the SpeakRight backend.

This module is the single owner of import-time side effects (dotenv loading,
state-directory creation) and of every cross-feature constant: env flags, API
keys, paths, locale/voice maps, and model pricing. Import order rule: any module
that needs configuration imports from here; nothing here imports app code.
"""
from dotenv import load_dotenv
import os
from pathlib import Path

load_dotenv()


def parse_bool_env(varname: str, default: bool = True) -> bool:
    val = os.getenv(varname)
    if val is None:
        return default
    return str(val).strip().lower() in ("1", "true", "yes", "on")


# --- Flags ---
MOCK_MODE = parse_bool_env("MOCK_MODE", default=True)
ENABLE_QUIZZING = parse_bool_env("ENABLE_QUIZZING", default=False)
DEBUG = parse_bool_env("DEBUG", default=False)

# --- API keys / endpoints ---
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
AZURE_OPENAI_API_KEY = os.getenv("AZURE_OPENAI_API_KEY")
AZURE_OPENAI_BASE_URL = os.getenv("AZURE_OPENAI_BASE_URL")
AZURE_SPEECH_KEY = os.getenv("AZURE_SPEECH_KEY")
AZURE_REGION = os.getenv("AZURE_REGION")

DEFAULT_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")

# --- Paths (directories are created here, on first import) ---
API_ROOT = Path(__file__).resolve().parent

AUDIO_ROOT = API_ROOT / "audio_files"
AUDIO_ROOT.mkdir(exist_ok=True)

PROFILE_DIR = API_ROOT / "profiles"
PROFILE_DIR.mkdir(exist_ok=True, parents=True)

PROMPTS_DIR = API_ROOT / "prompts"

CONV_ROOT = API_ROOT / "conversations"
CONV_ROOT.mkdir(exist_ok=True, parents=True)

QUIZ_DIR = API_ROOT / "quiz_items"
QUIZ_DIR.mkdir(exist_ok=True, parents=True)

DEFAULT_QUIZ_PATH = QUIZ_DIR / "default_quiz.json"
DEFAULT_PROFILE_PATH = PROFILE_DIR / "default_profile.json"

I18N_DIR = API_ROOT / "i18n" / "greetings"
GREETING_AUDIO_DIR = AUDIO_ROOT / "greetings"

USER_PROFILE_PATH = API_ROOT / "user_profile.json"  # battle-mode mistake log
TEST_AUDIO_PATH = API_ROOT / "test_audio.wav"       # mock-mode TTS stand-in

# --- Messenger / quiz constants ---
PERSONA = "sombongo"  # Current character

# Quiz scheduling: show quiz after N turns
QUIZ_TURNS_DELAY = 3

# Profile weak_points list: cap size (keep most recent) and reject items that
# contradict the app's own STT-tolerance rules (accents/punctuation are never penalized).
MAX_WEAK_POINTS = 8
DISALLOWED_WEAK_POINTS = {"punctuation", "capitalization", "accents", "accent marks", "accent"}

# --- Locale map (mirror of frontend/src/config.ts — keep the two in sync) ---
LOCALE_MAP = {"es": "es-MX", "id": "id-ID", "en": "en-US"}
DEFAULT_LOCALE = "en-US"


def locale_for(lang_code: str) -> str:
    """Map a language code (or locale) to the TTS locale used app-wide."""
    return LOCALE_MAP.get((lang_code or "")[:2], DEFAULT_LOCALE)


# --- Azure TTS voice defaults (env-overridable) ---
VOICE_MAP = {
    "es-MX": os.getenv("AZURE_VOICE_ES", "es-MX-JorgeNeural"),
    "en-US": os.getenv("AZURE_VOICE_EN", "en-US-JennyNeural"),
    "id-ID": os.getenv("AZURE_VOICE_ID", "id-ID-GadisNeural"),
}

# --- OpenAI pricing: model -> (input $/token, output $/token) ---
# Real published rates; used by llm_call for the usage tracker / battery bar.
MODEL_PRICING = {
    "gpt-4.1-mini": (0.00000040, 0.00000160),  # $0.40 / $1.60 per 1M
    "gpt-4.1-nano": (0.00000010, 0.00000040),  # $0.10 / $0.40 per 1M
    "gpt-4o-mini": (0.00000015, 0.00000060),   # $0.15 / $0.60 per 1M
}
DEFAULT_PRICING = MODEL_PRICING["gpt-4.1-mini"]
