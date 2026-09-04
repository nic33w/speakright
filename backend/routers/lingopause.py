"""LingoPause mode: pre-learn a video's vocabulary before watching it.

Pipeline (steps 1-5 of the design; playback and audio lessons come later):
  1-2. POST /api/lingopause/ingest             URL + notes -> metadata, chapters, transcript
  3a.  GET  /api/lingopause/export/{id}        one block to paste into browser ChatGPT/Claude
  3b.  POST /api/lingopause/import/candidates  the JSON that comes back
  4.   POST /api/lingopause/confirm            the learner's checklist of what to learn
  5a.  GET  /api/lingopause/export/{id}?kind=lessons
  5b.  POST /api/lingopause/import/lessons

Phase 4 (the lesson viewer):
  GET  /api/lingopause/beats/{id}     confirmed items flattened into playable beats
  POST /api/lingopause/audio          TTS for one beat, with optional word timings
  POST /api/lingopause/progress       mark an item viewed
  POST /api/lingopause/ask            follow-up question about one item

**The two big LLM steps run by hand, in a browser chat.** That is a deliberate
design choice, not a gap waiting to be filled: steps 3 and 5 are one-off, per-video,
and the learner is already sitting there, so there is nothing to gain from spending
API budget on them. If you are asked to "wire up extraction", check that is really
wanted before adding an `llm_call.py` function.

The **one** exception is `/api/lingopause/ask` (phase 4): a follow-up question asked
mid-lesson cannot be a copy-paste round trip, because the entire value is that it
answers here and now. It is the only endpoint here that calls a model.

Session state lives in `video_store` (one JSON file per video), generated lesson
content in `vocab_store`, and prompt assembly / paste parsing in `vocab_prompts`.
YouTube itself is only known to `video_source`.

Word and example audio needs nothing from this router: the frontend plays it
through the existing cached-TTS endpoint (POST /api/trivia/audio) via
`useAudioPlayer`, the same as every other mode.
"""
import json
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

import video_store
import vocab_store
from audio_utils import get_cached_audio_path
from lesson_audio import build_blocks, notes_of, prose_of
from tts_helpers import strip_span_markers
from settings import UI_LOCALE, locale_for
from models import LangSpec
from transcribe import TranscriptionUnavailable, is_available as transcription_available, transcribe_segments
from video_source import VideoUnavailable, fetch_captions, fetch_video_info, parse_video_id, transcript_text
from vocab_prompts import (
    attach_quotes,
    build_extraction_block,
    build_lesson_block,
    normalize_candidates,
    normalize_lessons,
    find_term_window,
    parse_pasted_json,
)

router = APIRouter()


class IngestReq(BaseModel):
    url: str
    notes: str = ""
    target_language: Optional[LangSpec] = None
    # Re-ingest a video already on disk. Off by default so reopening a video the
    # learner has already worked through does not silently discard their
    # checklist along with the transcript.
    force: bool = False


class ConfirmReq(BaseModel):
    video_id: str
    # Candidate ids the learner kept, i.e. the words they do NOT already know.
    keep: List[str]


@router.post("/api/lingopause/ingest")
def api_lingopause_ingest(req: IngestReq):
    """Steps 1-2: read the video and get a transcript.

    Captions first (free, already timed, and usually the speaker's own wording);
    audio transcription only when there are none. Chapter markers come back from
    the same yt-dlp metadata call, so they are stored now even though nothing
    reads them until the playback step.
    """
    try:
        video_id = parse_video_id(req.url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    existing = video_store.load_session(video_id)
    if existing and not req.force:
        return {"session": video_store.session_summary(existing), "reused": True}

    try:
        info = fetch_video_info(req.url)
    except VideoUnavailable as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    captions = fetch_captions(info)
    if captions:
        transcript = {
            "source": "captions",
            "lang": captions["lang"],
            "is_automatic": captions["is_automatic"],
            "segments": captions["segments"],
        }
    elif transcription_available():
        try:
            segments = transcribe_segments(info.url, info.duration)
        except TranscriptionUnavailable as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        transcript = {"source": "whisper", "lang": None, "is_automatic": True, "segments": segments}
    else:
        # The stub path. 422 rather than 500: nothing failed, this video just
        # cannot be used until a transcription backend is chosen.
        raise HTTPException(
            status_code=422,
            detail=(
                "This video has no usable captions, and audio transcription is not set up yet. "
                "Try a video with subtitles for now."
            ),
        )

    session = video_store.new_session(
        info=info.to_dict(),
        transcript=transcript,
        notes=req.notes,
        target_lang=req.target_language.dict() if req.target_language else None,
    )
    # Preserve work already done if this was a forced re-ingest: the transcript is
    # replaced, but the learner's checklist is theirs.
    if existing:
        session["created_at"] = existing.get("created_at", session["created_at"])
        session["confirmed"] = existing.get("confirmed", [])
    video_store.save_session(session)

    return {"session": video_store.session_summary(session), "reused": False}


@router.get("/api/lingopause/sessions")
def api_lingopause_sessions():
    """Every video ingested so far, newest first (summaries only)."""
    return {"sessions": video_store.list_sessions()}


@router.get("/api/lingopause/session/{video_id}")
def api_lingopause_session(video_id: str, include_transcript: bool = False):
    """One session. The transcript is opt-in -- it is by far the largest field and
    the review UI never needs it."""
    session = video_store.load_session(video_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"No LingoPause session for video {video_id}")

    payload: Dict[str, Any] = {
        "session": video_store.session_summary(session),
        "candidates": session.get("candidates") or [],
        "confirmed": session.get("confirmed") or [],
    }
    if include_transcript:
        payload["transcript"] = session.get("transcript") or {}
    return payload


@router.post("/api/lingopause/confirm")
def api_lingopause_confirm(req: ConfirmReq):
    """Step 4: persist which candidates survived the learner's checklist.

    Unknown ids are dropped rather than rejected -- a stale tab holding candidate
    ids from before a re-extraction should not fail the whole save.
    """
    session = video_store.load_session(req.video_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"No LingoPause session for video {req.video_id}")

    known = {c.get("id") for c in (session.get("candidates") or [])}
    kept = [cid for cid in req.keep if cid in known]
    dropped = [cid for cid in req.keep if cid not in known]
    if dropped:
        print(f"[LINGOPAUSE] confirm ignored {len(dropped)} unknown candidate id(s)")

    session["confirmed"] = kept
    session["stage"] = "confirmed"
    video_store.save_session(session)

    return {"confirmed": kept, "ignored": dropped, "session": video_store.session_summary(session)}


class NotesReq(BaseModel):
    video_id: str
    notes: str = ""


@router.post("/api/lingopause/notes")
def api_lingopause_notes(req: NotesReq):
    """Update the learner's context notes without re-ingesting.

    Both prompts read the notes, so they stay editable after the video is read --
    the learner often only works out what they want from a video once they can see
    what is in it.
    """
    session = video_store.load_session(req.video_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"No LingoPause session for video {req.video_id}")
    session["notes"] = req.notes
    video_store.save_session(session)
    return {"session": video_store.session_summary(session)}


@router.get("/api/lingopause/lessons/{video_id}")
def api_lingopause_lessons(video_id: str):
    """The lessons generated for this video, read back out of the vocab bank.

    The bank is keyed by term and shared across videos, so this filters to the
    entries this video contributed — a term first learned elsewhere and reinforced
    here still shows, which is correct: it is in this video's vocabulary either way.
    """
    session = video_store.load_session(video_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"No LingoPause session for video {video_id}")

    lang = (session.get("target_language") or {}).get("code", "es")
    bank = vocab_store.load_bank(lang)
    lessons = [
        entry for entry in bank.values()
        if any(s.get("video_id") == video_id for s in entry.get("sources", []))
    ]
    lessons.sort(key=lambda e: str(e.get("display") or e.get("term") or "").lower())
    return {"lessons": lessons, "count": len(lessons), "bank_stats": vocab_store.bank_stats(lang)}


# --- Phase 4: the lesson viewer ---

class LessonAudioReq(BaseModel):
    # What to synthesize. `ssml` (a fragment, e.g. <lang xml:lang="es-MX">...</lang>)
    # wins over `text` when both are given.
    text: str = ""
    ssml: str = ""
    locale: str = UI_LOCALE
    # Empty means "the locale's own VOICE_MAP default". Beats always send an
    # explicit voice; this default only covers ad-hoc callers.
    voice: str = ""
    rate: int = 0
    # Word timings cost nothing extra but need the SDK path, so they are opt-in:
    # only a replay needs them, and a first listen should not wait on the SDK.
    with_timings: bool = False
    # A mixed-language line: one entry per language stretch, each with its own
    # voice. Set on explanation beats whose target-language words the lesson prompt
    # marked. Wins over text/ssml when present.
    runs: List[Dict[str, str]] = []


@router.post("/api/lingopause/audio")
def api_lingopause_audio(req: LessonAudioReq):
    """TTS for one lesson beat, with optional word-level timings.

    Timings drive the replay word-highlight. They come from the Speech **SDK**,
    which the plain `/api/trivia/audio` path cannot provide — the REST endpoint
    returns audio bytes and nothing else. Both audio and timings are cached under
    the same content hash (which now includes voice), so a replay is free.

    Never raises: a synthesis failure degrades to the ordinary cached-TTS path, and
    a timings failure degrades to audio with no highlight.
    """
    from audio_utils import timings_path_for
    from tts_helpers import synthesize_mixed, synthesize_with_timings, tts_bytes_for_chunk

    runs = [r for r in (req.runs or []) if (r.get("text") or "").strip()]
    body = req.ssml or req.text
    if not runs and not body.strip():
        raise HTTPException(status_code=400, detail="Nothing to speak")

    # A stitched line is cached under a key describing every run, so changing one
    # voice or one word produces a different entry rather than serving a stale mix.
    cache_text = (
        "MIX::" + "||".join(f"{r.get('voice', '')}:{r.get('locale', '')}:{r['text']}" for r in runs)
        if runs else body
    )
    url_path, exists, disk_path = get_cached_audio_path(cache_text, req.locale, req.rate, 0, req.voice)
    words_path = timings_path_for(disk_path)

    # A stitched line always has timings — the per-run synthesis goes through the
    # SDK either way — so they are served on every hit, not only when asked for.
    # Gating this on `with_timings` meant the first (unasked) listen cached the clip
    # and every later request returned no timings, silently killing replay
    # highlighting for mixed explanations.
    wants_timings = req.with_timings or bool(runs)

    if exists:
        words = []
        if wants_timings and words_path.exists():
            try:
                words = json.loads(words_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                words = []
        # A clip cached before timings were wanted has audio but no sidecar. Fall
        # through to re-synthesis only if the caller actually needs the timings.
        if words or not wants_timings:
            return {"audio_file": url_path, "words": words, "cached": True}

    try:
        if runs:
            # Stitched: each language stretch in its own voice, Azure's
            # inter-utterance padding trimmed at every seam. Always produces
            # timings — the per-run synthesis has to go through the SDK anyway, so
            # withholding them on a first listen would save nothing.
            wav_bytes, words = synthesize_mixed(runs, req.rate)
        elif req.with_timings:
            wav_bytes, words = synthesize_with_timings(body, req.locale, req.voice, req.rate)
        else:
            wav_bytes, words = tts_bytes_for_chunk(body, req.locale, req.rate, voice=req.voice), []
        disk_path.write_bytes(wav_bytes)
        if words:
            words_path.write_text(json.dumps(words, ensure_ascii=False), encoding="utf-8")
        return {"audio_file": url_path, "words": words, "cached": False}
    except Exception as exc:
        print(f"[LINGOPAUSE] lesson TTS failed: {exc}")
        return {"audio_file": None, "words": [], "cached": False, "error": str(exc)}


@router.get("/api/lingopause/beats/{video_id}")
def api_lingopause_beats(video_id: str):
    """Every confirmed item for this video, flattened into playable beats.

    This is what the lesson viewer renders and plays. Items with no lesson content
    yet are returned with an empty beat list rather than dropped, so the viewer can
    say which ones still need generating instead of silently skipping them.
    """
    session = video_store.load_session(video_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"No LingoPause session for video {video_id}")

    lang = (session.get("target_language") or {}).get("code", "es")
    bank = vocab_store.load_bank(lang)
    confirmed = set(session.get("confirmed") or [])
    candidates = [c for c in (session.get("candidates") or []) if c.get("id") in confirmed]
    viewed = set(session.get("viewed") or [])

    segments = ((session.get("transcript") or {}).get("segments")) or []

    items = []
    for candidate in candidates:
        lesson = bank.get(vocab_store.normalize_term(candidate.get("term", "")))
        blocks = []
        if lesson:
            # Where the phrase stops being said, so the video block can pause
            # itself just past the line rather than playing on.
            found = find_term_window(segments, candidate.get("term", ""))
            lesson = {**lesson, "video_end_seconds": (found or {}).get("end")}
            blocks = build_blocks(lesson, lang)
        items.append({
            "id": candidate.get("id"),
            "term": candidate.get("term"),
            "kind": candidate.get("kind", "word"),
            "gloss_ui": candidate.get("gloss_ui"),
            "first_ts": candidate.get("first_ts"),
            "quote": candidate.get("quote"),
            "viewed": candidate.get("id") in viewed,
            "has_lesson": lesson is not None,
            # `derived` says the notes were sentence-split out of older prose
            # rather than authored as bullets — the viewer surfaces that so a
            # lower-quality reading is not mistaken for the real thing.
            "derived_audio": bool(lesson) and notes_of(lesson)[1],
            "blocks": blocks,
        })

    return {
        "items": items,
        "count": len(items),
        "viewed_count": len([i for i in items if i["viewed"]]),
        "target_language": session.get("target_language") or {"code": "es", "name": "Spanish"},
        "video_id": video_id,
        "url": session.get("url", ""),
    }


class ProgressReq(BaseModel):
    video_id: str
    candidate_id: str
    viewed: bool = True


@router.post("/api/lingopause/progress")
def api_lingopause_progress(req: ProgressReq):
    """Mark one item viewed (or un-viewed) once its lesson completes."""
    session = video_store.load_session(req.video_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"No LingoPause session for video {req.video_id}")

    viewed = list(session.get("viewed") or [])
    if req.viewed and req.candidate_id not in viewed:
        viewed.append(req.candidate_id)
    elif not req.viewed and req.candidate_id in viewed:
        viewed.remove(req.candidate_id)
    session["viewed"] = viewed
    video_store.save_session(session)
    return {"viewed": viewed, "viewed_count": len(viewed)}


class AskReq(BaseModel):
    video_id: str
    term: str
    question: str


@router.post("/api/lingopause/ask")
def api_lingopause_ask(req: AskReq):
    """A follow-up question about one lesson item ("why is there a se here?").

    **This is the one LLM call LingoPause makes.** Extraction and lesson generation
    run by hand in a browser chat; a follow-up question cannot, because the learner
    is mid-lesson and the whole value is that it answers here and now. Cost is
    recorded like every other call.

    The model gets the term, its explanation, and a window of surrounding transcript
    — the question is nearly always about why the line reads the way it does, and
    that is unanswerable without the line.
    """
    from llm_call import answer_lesson_question

    session = video_store.load_session(req.video_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"No LingoPause session for video {req.video_id}")
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="No question asked")

    lang = session.get("target_language") or {"code": "es", "name": "Spanish"}
    lesson = vocab_store.get_lesson(lang.get("code", "es"), req.term) or {}
    segments = ((session.get("transcript") or {}).get("segments")) or []

    # A window around the term's own line: enough for "why is it phrased this way"
    # to be answerable, small enough to stay cheap.
    first_ts = None
    for candidate in session.get("candidates") or []:
        if candidate.get("term") == req.term:
            first_ts = candidate.get("first_ts")
            break
    context = _transcript_window(segments, first_ts)

    try:
        answer = answer_lesson_question(
            term=req.term,
            explanation=" ".join(notes_of(lesson)[0]) or prose_of(lesson),
            question=req.question.strip(),
            transcript_context=context,
            target_language=lang.get("name", "Spanish"),
        )
        return {"answer": answer, "ok": True}
    except Exception as exc:
        print(f"[LINGOPAUSE] ask failed: {exc}")
        return {"answer": "", "ok": False, "error": "Couldn't get an answer just now — try again."}


def _stamp_from_candidates(session: Dict[str, Any], lessons: List[Dict[str, Any]]) -> None:
    """Copy `kind`, `first_ts` and `quote` from the confirmed candidate onto each
    lesson, in place.

    These belong to the candidate, which is the authoritative record: `kind` in
    particular was set by the extraction prompt and validated by
    `_normalize_kind`. Before this, lessons only carried a kind when the lesson
    model happened to echo one back unprompted — which it did for 49 of the 134
    entries that existed when phase 4 landed, and that inconsistency is exactly
    what made constructions unreliable to filter on.
    """
    by_term = {
        vocab_store.normalize_term(c.get("term", "")): c
        for c in (session.get("candidates") or [])
    }
    for lesson in lessons:
        candidate = by_term.get(vocab_store.normalize_term(lesson.get("term", "")))
        if not candidate:
            continue
        lesson["kind"] = candidate.get("kind", "word")
        if isinstance(candidate.get("first_ts"), (int, float)):
            lesson.setdefault("first_ts", candidate["first_ts"])
        if candidate.get("quote"):
            lesson.setdefault("quote", candidate["quote"])


def _transcript_window(segments: List[Dict[str, Any]], seconds: Any, radius: int = 3) -> str:
    """The transcript lines around a timestamp, as plain text."""
    if not segments:
        return ""
    if not isinstance(seconds, (int, float)):
        window = segments[:radius * 2 + 1]
    else:
        index = min(
            range(len(segments)),
            key=lambda i: abs(float(segments[i].get("start") or 0) - float(seconds)),
        )
        window = segments[max(0, index - radius): index + radius + 1]
    return " ".join(str(s.get("text") or "").strip() for s in window).strip()


@router.delete("/api/lingopause/session/{video_id}")
def api_lingopause_delete(video_id: str):
    return {"deleted": video_store.delete_session(video_id)}


# --- Steps 3 and 5: copy out, paste back ---

@router.get("/api/lingopause/export/{video_id}")
def api_lingopause_export(
    video_id: str,
    kind: str = Query("extraction", pattern="^(extraction|lessons)$"),
    timestamps: bool = True,
    offset: int = 0,
    limit: Optional[int] = None,
):
    """One block to copy into a browser chat.

    `extraction` (step 3) carries the video context plus the whole transcript;
    `lessons` (step 5) carries the confirmed terms with the line each was used in,
    and deliberately not the transcript again. A lessons block is **batched**
    (`offset` / `limit`, default 25): the input would fit in one go, but the OUTPUT
    would not -- 100+ full lessons in one chat reply truncates mid-JSON.

    The prompt itself comes from `prompts/templates/` and is authored by hand. When
    a template is missing, `has_template` is false and the block is just the video
    material -- still the useful half, with the prompt to be pasted above it.
    """
    session = video_store.load_session(video_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"No LingoPause session for video {video_id}")

    if kind == "extraction":
        return build_extraction_block(session, with_timestamps=timestamps)

    confirmed = set(session.get("confirmed") or [])
    candidates = session.get("candidates") or []
    terms = [c for c in candidates if c.get("id") in confirmed] if confirmed else candidates
    if not terms:
        raise HTTPException(
            status_code=409,
            detail="No terms to write lessons for yet — import candidates and save your list first.",
        )
    return build_lesson_block(session, terms, offset=offset, limit=limit)


@router.get("/api/lingopause/transcript/{video_id}.txt", response_class=PlainTextResponse)
def api_lingopause_transcript_txt(video_id: str, timestamps: bool = True):
    """The bare subtitles as plain text, for saving or pasting on their own."""
    session = video_store.load_session(video_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"No LingoPause session for video {video_id}")
    segments = ((session.get("transcript") or {}).get("segments")) or []
    return transcript_text(segments, with_timestamps=timestamps)


class ImportReq(BaseModel):
    video_id: str
    # Raw paste from the browser chat. Fences, a preamble, and trailing chatter are
    # all tolerated (see vocab_prompts.parse_pasted_json).
    payload: str
    # Overwrite bank entries that already exist, even when the incoming lesson is
    # not obviously richer. Not needed to upgrade a pre-phase-4 bank -- that happens
    # on its own via vocab_store.is_upgrade -- only to force a full regeneration.
    replace: bool = False


@router.post("/api/lingopause/import/candidates")
def api_lingopause_import_candidates(req: ImportReq):
    """Step 3's other half: store the vocabulary JSON pasted back from the chat.

    Replaces any previous candidate list, and clears `confirmed` with it — those ids
    referred to the old list and would silently select the wrong terms.
    """
    session = video_store.load_session(req.video_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"No LingoPause session for video {req.video_id}")

    try:
        candidates = normalize_candidates(parse_pasted_json(req.payload))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # The extraction prompt returns a timestamp but not the line it came from, so
    # the line is looked up locally — it shows in the checklist, and it is what
    # lets the lesson prompt answer `video_usage` without the transcript.
    attach_quotes(candidates, ((session.get("transcript") or {}).get("segments")) or [])

    session["candidates"] = candidates
    session["confirmed"] = []
    session["stage"] = "extracted"
    video_store.save_session(session)

    return {
        "candidates": candidates,
        "count": len(candidates),
        "session": video_store.session_summary(session),
    }


@router.post("/api/lingopause/import/lessons")
def api_lingopause_import_lessons(req: ImportReq):
    """Step 5's other half: store the lesson JSON pasted back from the chat.

    Lessons go into the per-language vocab bank (`vocab_lessons/<lang>.json`), tagged
    with the video they came from. Nothing is written to the spaced-repetition deck —
    that projection is a separate task (TASKS.md 8.6).
    """
    session = video_store.load_session(req.video_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"No LingoPause session for video {req.video_id}")

    lang = (session.get("target_language") or {}).get("code", "es")

    try:
        lessons = normalize_lessons(parse_pasted_json(req.payload), locale_for(lang))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    _stamp_from_candidates(session, lessons)

    result = vocab_store.upsert_lessons(
        lang,
        lessons,
        source={"kind": "video", "video_id": session.get("video_id"), "title": session.get("title", "")},
        replace=req.replace,
    )

    session["stage"] = "lessons_ready"
    session["lessons_generated_at"] = int(time.time())
    video_store.save_session(session)

    return {
        "lessons": lessons,
        "count": len(lessons),
        "bank": result,
        "session": video_store.session_summary(session),
    }
