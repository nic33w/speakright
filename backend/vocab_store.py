"""Generated vocabulary lesson bank (vocab_lessons/<lang>.json).

The teaching content -- definitions, colloquial and idiomatic notes, examples,
and where the term was used in the video it came from. Keyed by term, one file
per target language.

Shape mirrors `word_practice_sentences.json` (the Word Drill bank) on purpose, so
video vocab can eventually be drilled by that mode: `term -> {display,
description, usecases: [...]}`. One deliberate difference: inside a usecase's
`demo`/`practice` the target-language field is called `target`, not `spanish`.
The Word Drill bank hardcodes the language name as a key, which does not survive
contact with a second target language; a ~5-line adapter can bridge the two if
Word Drill ever loads this bank.

Not connected to the spaced-repetition deck (`quiz_store.py`) yet -- that
projection is deliberately a later task. The two stores answer different
questions: this one holds what a term *means*, the quiz deck holds when it is
next *due*.
"""
import json
import time
from typing import Any, Dict, List, Optional

from settings import VOCAB_LESSON_DIR


def _bank_path(lang_code: str):
    safe = (lang_code or "es")[:5].replace("/", "_").replace("\\", "_")
    return VOCAB_LESSON_DIR / f"{safe}.json"


def normalize_term(term: str) -> str:
    """Bank key for a term. Case- and whitespace-insensitive, so 'Me Regala' and
    'me regala' are the same entry -- but accents are preserved, because unlike
    an answer check this is a dictionary key, and 'ano' is not 'anio'."""
    return " ".join((term or "").strip().lower().split())


def load_bank(lang_code: str) -> Dict[str, Any]:
    path = _bank_path(lang_code)
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        print(f"[LINGOPAUSE] vocab bank unreadable ({path.name}): {exc}")
        return {}


def save_bank(lang_code: str, bank: Dict[str, Any]) -> None:
    with open(_bank_path(lang_code), "w", encoding="utf-8") as f:
        json.dump(bank, f, ensure_ascii=False, indent=2)


def get_lesson(lang_code: str, term: str) -> Optional[Dict[str, Any]]:
    return load_bank(lang_code).get(normalize_term(term))


# Fields that only a phase-4 lesson has. An incoming lesson carrying one of these
# for an entry that lacks it is strictly better content, not a duplicate.
_UPGRADE_FIELDS = ("written_explanation", "spoken_explanation")


def is_upgrade(incoming: Dict[str, Any], existing: Dict[str, Any]) -> bool:
    """Whether `incoming` should replace `existing` rather than be discarded.

    True when it carries an explanation field the stored entry does not have. This
    is what lets a bank full of pre-phase-4 lessons be upgraded by re-running the
    lesson prompt, without a `replace` flag and without overwriting anything that is
    already at the newer standard.
    """
    return any(
        incoming.get(field) and not existing.get(field)
        for field in _UPGRADE_FIELDS
    )


def upsert_lessons(
    lang_code: str,
    lessons: List[Dict[str, Any]],
    source: Optional[Dict[str, Any]] = None,
    replace: bool = False,
) -> Dict[str, int]:
    """Merge generated lessons into the bank. Returns {"added", "upgraded", "kept"}.

    A term already in the bank normally keeps its existing content and only gains
    the new `source` -- the same word turning up in a second video is evidence it is
    worth knowing, not a reason to regenerate an explanation that was already
    reviewed.

    **Two exceptions**, both of which overwrite the content fields while preserving
    `sources` and `created_at`:
      - the incoming lesson is richer (see `is_upgrade`) -- how a pre-phase-4 bank
        gets upgraded to written/spoken explanations by re-running the prompt;
      - `replace=True`, an explicit "regenerate this properly" from the caller.

    `source` identifies where these came from, e.g.
    `{"kind": "video", "video_id": ..., "title": ...}`.
    """
    bank = load_bank(lang_code)
    added = upgraded = kept = 0
    now = int(time.time())

    for lesson in lessons:
        term = normalize_term(lesson.get("term") or lesson.get("display") or "")
        if not term:
            continue
        entry = bank.get(term)

        if entry is not None and (replace or is_upgrade(lesson, entry)):
            # Replace the content, keep the history.
            refreshed = dict(lesson)
            refreshed.setdefault("display", lesson.get("display") or term)
            refreshed["sources"] = entry.get("sources", [])
            refreshed["created_at"] = entry.get("created_at", now)
            bank[term] = entry = refreshed
            upgraded += 1
        elif entry is None:
            entry = dict(lesson)
            entry.setdefault("display", lesson.get("display") or lesson.get("term") or term)
            # `description` and `usecases` are deliberately no longer written. Both
            # were Word-Drill-shape shims: description duplicated definition byte for
            # byte, and usecases was an empty list on every entry that ever had it.
            # Existing entries keep theirs; nothing reads either field.
            entry["sources"] = []
            entry["created_at"] = now
            bank[term] = entry
            added += 1
        else:
            kept += 1
        entry["last_updated"] = now
        if source:
            existing = entry.setdefault("sources", [])
            key = (source.get("kind"), source.get("video_id"))
            if not any((s.get("kind"), s.get("video_id")) == key for s in existing):
                existing.append(source)

    save_bank(lang_code, bank)
    return {"added": added, "upgraded": upgraded, "kept": kept}


def bank_stats(lang_code: str) -> Dict[str, int]:
    bank = load_bank(lang_code)
    from_video = sum(
        1 for entry in bank.values()
        if any(s.get("kind") == "video" for s in entry.get("sources", []))
    )
    return {"total": len(bank), "from_video": from_video}
