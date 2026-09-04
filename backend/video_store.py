"""Per-video LingoPause session persistence (video_sessions/video_<id>.json).

One file per video, holding everything the pipeline has learned about it:
metadata and chapters from YouTube, the transcript, the extracted vocab
candidates, and which of them the learner kept. Rebuildable from the URL, so it
is runtime state rather than content -- the same status as conversations/.

Every stage of the pipeline reads and rewrites the same file, so a session can be
resumed at whatever step it reached: ingest -> extract -> confirm -> lessons.
"""
import json
import re
import time
from typing import Any, Dict, List, Optional

from settings import VIDEO_SESSION_DIR
from video_source import thumbnail_url

# Session files are named from the video id, which comes off a URL, so it is
# sanitized before it ever reaches the filesystem.
_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_-]")

SESSION_STAGES = ("ingested", "extracted", "confirmed", "lessons_ready")


def _safe_id(video_id: str) -> str:
    safe = _SAFE_ID_RE.sub("_", (video_id or "").strip())
    if not safe:
        raise ValueError("Empty video id")
    return safe[:64]


def session_path(video_id: str):
    return VIDEO_SESSION_DIR / f"video_{_safe_id(video_id)}.json"


def new_session(
    info: Dict[str, Any],
    transcript: Dict[str, Any],
    notes: str = "",
    target_lang: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Build a fresh session dict from ingested metadata + transcript.

    `info` is `video_source.VideoInfo.to_dict()`; `transcript` carries
    `{"source", "lang", "is_automatic", "segments"}`.
    """
    now = int(time.time())
    return {
        "created_at": now,
        "last_updated": now,
        "stage": "ingested",
        **info,
        # The learner's own framing of the video (speaker, topic, why they care).
        # Feeds the extraction prompt -- it is the only signal about what matters
        # in this video that is not derivable from the transcript itself.
        "notes": notes or "",
        "target_language": target_lang or {"code": "es", "name": "Spanish"},
        "transcript": transcript,
        "candidates": [],
        # Ids of the candidates the learner did NOT already know, i.e. what the
        # lesson step generates content for.
        "confirmed": [],
        "lessons_generated_at": None,
    }


def save_session(session: Dict[str, Any]) -> Dict[str, Any]:
    session["last_updated"] = int(time.time())
    path = session_path(session["video_id"])
    with open(path, "w", encoding="utf-8") as f:
        json.dump(session, f, ensure_ascii=False, indent=2)
    return session


def load_session(video_id: str) -> Optional[Dict[str, Any]]:
    path = session_path(video_id)
    if not path.exists():
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def delete_session(video_id: str) -> bool:
    path = session_path(video_id)
    if not path.exists():
        return False
    path.unlink()
    return True


def list_sessions() -> List[Dict[str, Any]]:
    """Summaries for the mode's landing list -- never the transcripts, which are
    the bulk of a session file and useless to a picker."""
    summaries = []
    for path in VIDEO_SESSION_DIR.glob("video_*.json"):
        try:
            with open(path, "r", encoding="utf-8") as f:
                session = json.load(f)
        except (json.JSONDecodeError, OSError) as exc:
            print(f"[LINGOPAUSE] skipping unreadable session {path.name}: {exc}")
            continue
        summaries.append({
            "video_id": session.get("video_id", ""),
            "url": session.get("url", ""),
            "title": session.get("title", ""),
            "thumbnail": thumbnail_url(session.get("video_id", "")),
            "duration": session.get("duration", 0),
            "stage": session.get("stage", "ingested"),
            "candidate_count": len(session.get("candidates") or []),
            "confirmed_count": len(session.get("confirmed") or []),
            "created_at": session.get("created_at", 0),
            "last_updated": session.get("last_updated", 0),
        })
    summaries.sort(key=lambda s: s.get("last_updated", 0), reverse=True)
    return summaries


def session_summary(session: Dict[str, Any]) -> Dict[str, Any]:
    """The ingest response: everything the frontend needs to render the video
    header and the transcript-source notice, minus the transcript body."""
    transcript = session.get("transcript") or {}
    segments = transcript.get("segments") or []
    return {
        "video_id": session.get("video_id", ""),
        "url": session.get("url", ""),
        "title": session.get("title", ""),
        "uploader": session.get("uploader", ""),
        "thumbnail": thumbnail_url(session.get("video_id", "")),
        "description": session.get("description", ""),
        "duration": session.get("duration", 0),
        "chapters": session.get("chapters") or [],
        "notes": session.get("notes", ""),
        "stage": session.get("stage", "ingested"),
        "transcript_source": transcript.get("source", "none"),
        "transcript_lang": transcript.get("lang"),
        "transcript_is_automatic": transcript.get("is_automatic", False),
        "segment_count": len(segments),
        "candidate_count": len(session.get("candidates") or []),
        "confirmed_count": len(session.get("confirmed") or []),
    }
