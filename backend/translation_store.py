"""Content-hash cache for chunk translations (task 3.8).

The messenger character speaks only the target language; UI-language translations
are fetched on demand by whichever pairing mode the learner has on. The same target
sentence recurs across turns (reaction openers are a closed set, and conversations
circle back), so a hit here makes a re-listen free — the same reasoning as the audio
cache in audio_utils, one level up.

Deliberately a single JSON file rather than one file per entry: translations are a
few dozen bytes each, and the whole cache is read once per process.
"""
import hashlib
import json
import threading
from typing import Dict, Optional

from settings import TRANSLATION_CACHE_PATH

# Writes are read-modify-write on one file, and the translate endpoint fans out
# across threads for a batch — same hazard usage_tracker hit in task 1.3.
_lock = threading.Lock()
_cache: Optional[Dict[str, str]] = None


def _key(text: str, source_lang: str, target_lang: str) -> str:
    raw = f"{text.strip()}|{source_lang}|{target_lang}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:24]


def _load() -> Dict[str, str]:
    global _cache
    if _cache is None:
        if TRANSLATION_CACHE_PATH.exists():
            try:
                with open(TRANSLATION_CACHE_PATH, "r", encoding="utf-8") as f:
                    _cache = json.load(f)
            except (json.JSONDecodeError, OSError) as e:
                # A corrupt cache is never worth failing a turn over.
                print(f"[TRANSLATE] cache unreadable, starting empty: {e}")
                _cache = {}
        else:
            _cache = {}
    return _cache


def get(text: str, source_lang: str, target_lang: str) -> Optional[str]:
    """Cached translation, or None."""
    if not text or not text.strip():
        return None
    with _lock:
        return _load().get(_key(text, source_lang, target_lang))


def put_many(entries) -> None:
    """Store (text, source_lang, target_lang, translation) tuples in one write."""
    entries = [e for e in entries if e[0] and e[0].strip() and e[3] and e[3].strip()]
    if not entries:
        return
    with _lock:
        cache = _load()
        for text, source_lang, target_lang, translation in entries:
            cache[_key(text, source_lang, target_lang)] = translation
        try:
            tmp = TRANSLATION_CACHE_PATH.with_suffix(".json.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(cache, f, ensure_ascii=False, indent=0)
            tmp.replace(TRANSLATION_CACHE_PATH)
        except OSError as e:
            # In-memory cache still holds the entries for this process.
            print(f"[TRANSLATE] cache write failed: {e}")


def reset_for_tests() -> None:
    """Drop the in-memory cache so a test can start from the file on disk."""
    global _cache
    with _lock:
        _cache = None
