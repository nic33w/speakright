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

# --- LingoPause (video-vocab primer) ---
# Per-video working state: metadata, chapters, transcript, vocab candidates, and
# the user's checklist. One file per video, mirroring conversations/ — these are
# runtime state, not content, and they are rebuildable from the URL.
VIDEO_SESSION_DIR = API_ROOT / "video_sessions"
VIDEO_SESSION_DIR.mkdir(exist_ok=True, parents=True)

# Generated lesson content, keyed by term, one file per target language. Shaped to
# match word_practice_sentences.json so Word Drill can eventually read it (the one
# deliberate difference: the demo/practice key is "target", not "spanish").
VOCAB_LESSON_DIR = API_ROOT / "vocab_lessons"
VOCAB_LESSON_DIR.mkdir(exist_ok=True, parents=True)

# Vocab extraction reads a whole transcript (~9k tokens for a 40-minute video) and
# lesson generation writes learner-facing explanations, so neither is a nano job the
# way TRANSLATE_MODEL and SCENE_MODEL are. Defaults to DEFAULT_MODEL.
VOCAB_MODEL = os.getenv("VOCAB_MODEL", DEFAULT_MODEL)

# Caption languages tried in order when pulling subtitles for a video. Manually
# authored subtitles are always preferred over YouTube's auto-generated ones.
CAPTION_LANG_PREFS = ("es", "es-MX", "es-419", "id", "en")

# Lesson viewer (phase 4). Voices come from VOICE_MAP per beat -- the same speakers
# every other mode uses -- rather than one multilingual voice: English framing in
# the UI voice, the target phrase AND the explanations in the target voice. The
# explanations go to the target voice because they quote target-language words
# inside English prose, and those quoted words are the part that must sound right.
# A single multilingual voice was tried first and was not good enough on either
# language.
UI_LOCALE = "en-US"

# Gap inserted between spoken_explanation segments during playback, client-side.
# Longer than the 250ms clause pause (task 3.10): these are separate thoughts, not
# clauses of one sentence, and the learner needs time to finish each before the
# next starts.
LESSON_SEGMENT_PAUSE_MS = 700

# Cached chunk translations (task 3.8). Small JSON, content-hash keyed — the same
# target sentence recurs across turns and a hit makes a re-listen free.
TRANSLATION_CACHE_PATH = API_ROOT / "translation_cache.json"

# Translation is a mechanical, context-free job: no persona, no schema, no student
# model, ~100 input tokens against the messenger call's ~2.5k. Runs on the cheapest
# model in MODEL_PRICING rather than DEFAULT_MODEL.
TRANSLATE_MODEL = os.getenv("TRANSLATE_MODEL", "gpt-4.1-nano")

DEFAULT_QUIZ_PATH = QUIZ_DIR / "default_quiz.json"
DEFAULT_PROFILE_PATH = PROFILE_DIR / "default_profile.json"

I18N_DIR = API_ROOT / "i18n" / "greetings"
GREETING_AUDIO_DIR = AUDIO_ROOT / "greetings"
REACTIONS_AUDIO_DIR = AUDIO_ROOT / "reactions"  # pre-generated persona reaction-opener audio

USER_PROFILE_PATH = API_ROOT / "user_profile.json"  # battle-mode mistake log
TEST_AUDIO_PATH = API_ROOT / "test_audio.wav"       # mock-mode TTS stand-in

# --- Messenger / quiz constants ---
# Current character — matches a file in prompts/persona/<id>.json ("sombongo", "jorge").
# Fixed per run: the persona text lives in the messenger prompt's STATIC PREFIX, so it must
# not change between turns or prompt caching breaks.
PERSONA = os.getenv("MESSENGER_PERSONA", "jorge")

# Quiz scheduling: show quiz after N turns
QUIZ_TURNS_DELAY = 3

# Scene layer (task 5.1): how long a scene runs before it genuinely ends. Each
# scene draws its own budget from this range, so scene length is not a constant
# the learner can feel coming. Under ~5 there is no room for a complication to
# bite; over ~10 the ending stops feeling like one.
SCENE_MIN_TURNS = 5
SCENE_MAX_TURNS = 10

# Scene generation is a small, one-off call every 5-10 turns (~250 in / ~150 out
# tokens) and its output is a premise, not learner-facing language — so it runs
# on the cheapest model, same reasoning as TRANSLATE_MODEL.
SCENE_MODEL = os.getenv("SCENE_MODEL", "gpt-4.1-nano")

# Task 5.3: how often a scene is drawn from `secret_goals` instead of
# `character_goals` — the character knows one specific thing and the learner has
# to extract it. Roughly one scene in three: it is the strongest engine here, but
# it is also the most demanding turn for the learner (they have to drive), so it
# earns its place as a change of gear rather than the default mode.
SECRET_SCENE_CHANCE = 0.34

# Profile weak_points/comfortable_with lists: cap size (keep most recently reaffirmed,
# near-duplicates merged — see profile_store._upsert_tag) and reject weak_points items that
# contradict the app's own STT-tolerance rules (accents/punctuation are never penalized).
MAX_WEAK_POINTS = 12
MAX_COMFORTABLE_WITH = 12
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
