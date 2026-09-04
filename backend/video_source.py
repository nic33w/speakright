"""YouTube ingestion for LingoPause mode: metadata, chapter markers, and captions.

This is the only module that knows what YouTube is. Routers ask it for a
`VideoInfo` and a list of transcript segments; everything downstream (vocab
extraction, lesson generation) works on plain text plus timestamps and never
imports yt-dlp.

Network access is confined here and to `transcribe.py`. Under MOCK_MODE the whole
module short-circuits to a canned Spanish video, so the test suite exercises the
real ingest path -- id parsing, chapter normalization, segment shaping -- without
touching the network.
"""
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import requests

from settings import CAPTION_LANG_PREFS, MOCK_MODE

# Give up on a stalled YouTube connection rather than hanging the ingest request
# forever. A healthy metadata extraction takes a few seconds.
METADATA_TIMEOUT_SECS = 30
CAPTION_TIMEOUT_SECS = 30

# Caption formats we can parse, best first. json3 is YouTube's own timed-text
# JSON (millisecond timings, no cue-merging guesswork); vtt is the fallback.
_CAPTION_FORMATS = ("json3", "vtt")

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_URL_ID_PATTERNS = (
    re.compile(r"[?&]v=([A-Za-z0-9_-]{11})"),
    re.compile(r"youtu\.be/([A-Za-z0-9_-]{11})"),
    re.compile(r"/shorts/([A-Za-z0-9_-]{11})"),
    re.compile(r"/embed/([A-Za-z0-9_-]{11})"),
    re.compile(r"/live/([A-Za-z0-9_-]{11})"),
)


def thumbnail_url(video_id: str) -> str:
    """The stable poster-frame URL for a video id.

    hqdefault exists for every video (maxresdefault does not), so this never 404s
    into a broken image in the UI.
    """
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg" if video_id else ""


class VideoUnavailable(Exception):
    """yt-dlp could not read the video (private, removed, geo-blocked, bad URL)."""


@dataclass
class VideoInfo:
    video_id: str
    url: str
    title: str
    description: str
    duration: int  # seconds; 0 when yt-dlp does not report one
    uploader: str
    # Poster frame. yt-dlp reports one, but its URL can be a signed/expiring form,
    # so `thumbnail_url()` prefers the deterministic i.ytimg.com path that stays
    # valid for as long as the video does.
    thumbnail: str = ""
    chapters: List[Dict[str, Any]] = field(default_factory=list)
    # lang -> [{ext, url}], straight from yt-dlp. Kept so caption selection is a
    # pure function over already-fetched metadata rather than a second lookup.
    subtitles: Dict[str, Any] = field(default_factory=dict)
    automatic_captions: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Persistable form -- the subtitle maps are dropped, since they hold
        short-lived signed URLs that are useless by the time a session reloads."""
        return {
            "video_id": self.video_id,
            "url": self.url,
            "title": self.title,
            "description": self.description,
            "duration": self.duration,
            "uploader": self.uploader,
            "thumbnail": self.thumbnail or thumbnail_url(self.video_id),
            "chapters": self.chapters,
        }


# --- Mock fixtures (MOCK_MODE) ---

_MOCK_DESCRIPTION = (
    "En este video te enseno a pedir comida sin sonar como un turista.\n\n"
    "00:00 Introduccion\n"
    "01:30 Frases basicas\n"
    "04:00 Errores comunes\n"
)

_MOCK_SEGMENTS = [
    {"start": 0.0, "end": 4.0, "text": "Hola, que onda? Bienvenidos a otro video."},
    {"start": 4.0, "end": 9.5, "text": "Hoy vamos a platicar de como pedir en un restaurante."},
    {"start": 90.0, "end": 95.0, "text": "Lo primero es no decir 'quiero', suena medio grosero."},
    {"start": 95.0, "end": 101.0, "text": "Mejor di 'me da' o 'me regala', asi de facil."},
    {"start": 240.0, "end": 246.5, "text": "El error mas comun es pedir la cuenta desde lejos."},
]

_MOCK_CHAPTERS = [
    {"start_time": 0, "end_time": 90, "title": "Introduccion"},
    {"start_time": 90, "end_time": 240, "title": "Frases basicas"},
    {"start_time": 240, "end_time": 360, "title": "Errores comunes"},
]


def parse_video_id(url_or_id: str) -> str:
    """Extract the 11-character video id from any common YouTube URL form.

    Accepts a bare id too, so a session can be reopened by id. Raises ValueError
    rather than guessing -- a wrong id silently ingests someone else's video.
    """
    text = (url_or_id or "").strip()
    if not text:
        raise ValueError("No YouTube URL provided")
    if _ID_RE.match(text):
        return text
    for pattern in _URL_ID_PATTERNS:
        match = pattern.search(text)
        if match:
            return match.group(1)
    raise ValueError(f"Could not find a YouTube video id in: {url_or_id!r}")


def _normalize_chapters(raw: Optional[List[Dict[str, Any]]], duration: int) -> List[Dict[str, Any]]:
    """Shape yt-dlp's chapter list into the app's own form.

    yt-dlp parses YouTube's description-based chapter markers for us, so step 6's
    "use the video's own chapters if present" path costs nothing at ingest time.
    `source` records where the boundaries came from, so a later interval/LLM
    fallback can be told apart from real markers by anything that reads them.
    """
    if not raw:
        return []
    chapters = []
    for index, chapter in enumerate(raw):
        start = float(chapter.get("start_time") or 0.0)
        end = chapter.get("end_time")
        chapters.append({
            "index": index,
            "title": (chapter.get("title") or f"Chapter {index + 1}").strip(),
            "start": start,
            "end": float(end) if end is not None else float(duration or 0),
            "source": "youtube",
        })
    return chapters


def fetch_video_info(url: str) -> VideoInfo:
    """Read video metadata (title, description, duration, chapters, caption tracks).

    No media is downloaded -- this is yt-dlp's metadata extraction only.
    """
    video_id = parse_video_id(url)

    if MOCK_MODE:
        return VideoInfo(
            video_id=video_id,
            url=url,
            title="[mock] Como pedir en un restaurante en Mexico",
            description=_MOCK_DESCRIPTION,
            duration=360,
            uploader="[mock] Canal de Espanol",
            thumbnail=thumbnail_url(video_id),
            chapters=_normalize_chapters(_MOCK_CHAPTERS, 360),
        )

    try:
        from yt_dlp import YoutubeDL
    except ImportError as exc:  # pragma: no cover - dependency is in requirements.txt
        raise VideoUnavailable("yt-dlp is not installed (pip install -r requirements.txt)") from exc

    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "extract_flat": False,
        # Without these yt-dlp will wait on a stalled YouTube connection
        # indefinitely, and the ingest request hangs with it -- the caller has no
        # way to tell "slow video" from "never coming back". A healthy extraction
        # takes a few seconds.
        "socket_timeout": METADATA_TIMEOUT_SECS,
        "retries": 2,
    }
    try:
        with YoutubeDL(options) as ydl:
            raw = ydl.extract_info(url, download=False)
    except Exception as exc:
        raise VideoUnavailable(f"Could not read that video: {exc}") from exc

    if not raw:
        raise VideoUnavailable("yt-dlp returned no information for that URL")

    duration = int(raw.get("duration") or 0)
    return VideoInfo(
        video_id=raw.get("id") or video_id,
        url=raw.get("webpage_url") or url,
        title=raw.get("title") or "",
        description=raw.get("description") or "",
        duration=duration,
        uploader=raw.get("uploader") or raw.get("channel") or "",
        thumbnail=thumbnail_url(raw.get("id") or video_id),
        chapters=_normalize_chapters(raw.get("chapters"), duration),
        subtitles=raw.get("subtitles") or {},
        automatic_captions=raw.get("automatic_captions") or {},
    )


def _select_caption_track(info: VideoInfo, lang_prefs=CAPTION_LANG_PREFS):
    """Pick the best caption track: manual subtitles beat auto-generated ones at
    every language, and within a track json3 beats vtt.

    Returns (url, ext, lang, is_automatic) or None.
    """
    for source, is_automatic in ((info.subtitles, False), (info.automatic_captions, True)):
        if not source:
            continue
        for lang in lang_prefs:
            # YouTube labels tracks "es", "es-MX", "es-419", and auto-generated
            # ones sometimes "es-orig" -- match the prefix rather than the exact tag.
            for track_lang, tracks in source.items():
                if not track_lang.startswith(lang):
                    continue
                by_ext = {t.get("ext"): t for t in tracks if t.get("url")}
                for ext in _CAPTION_FORMATS:
                    if ext in by_ext:
                        return by_ext[ext]["url"], ext, track_lang, is_automatic
    return None


def _parse_json3(payload: str) -> List[Dict[str, Any]]:
    import json

    data = json.loads(payload)
    segments = []
    for event in data.get("events") or []:
        segs = event.get("segs") or []
        text = "".join(s.get("utf8", "") for s in segs).strip()
        if not text:
            continue
        start = float(event.get("tStartMs", 0)) / 1000.0
        duration = float(event.get("dDurationMs", 0)) / 1000.0
        segments.append({"start": start, "end": start + duration, "text": text})
    return segments


_VTT_TIME_RE = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})"
)
_VTT_TAG_RE = re.compile(r"<[^>]+>")


def _vtt_seconds(hours: str, minutes: str, seconds: str, millis: str) -> float:
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(millis) / 1000.0


def _parse_vtt(payload: str) -> List[Dict[str, Any]]:
    segments = []
    lines = payload.splitlines()
    i = 0
    while i < len(lines):
        match = _VTT_TIME_RE.search(lines[i])
        if not match:
            i += 1
            continue
        groups = match.groups()
        start = _vtt_seconds(*groups[:4])
        end = _vtt_seconds(*groups[4:])
        i += 1
        text_lines = []
        while i < len(lines) and lines[i].strip():
            # Strip the inline karaoke/position tags YouTube puts in auto-captions.
            text_lines.append(_VTT_TAG_RE.sub("", lines[i]).strip())
            i += 1
        text = " ".join(t for t in text_lines if t).strip()
        if text:
            segments.append({"start": start, "end": end, "text": text})
    return segments


def _dedupe_rolling_captions(segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Auto-captions repeat the previous line as a scroll-in effect, so a raw
    parse yields the same words two or three times over -- which would badly skew
    any frequency signal the extraction prompt reads. Collapse a cue that only
    extends or repeats the one before it."""
    out: List[Dict[str, Any]] = []
    for segment in segments:
        text = segment["text"].strip()
        if not text:
            continue
        if out and (text == out[-1]["text"] or out[-1]["text"].endswith(text)):
            continue
        if out and text.startswith(out[-1]["text"]):
            # The new cue is the old one plus more words: keep the longer form.
            out[-1] = {"start": out[-1]["start"], "end": segment["end"], "text": text}
            continue
        out.append({"start": segment["start"], "end": segment["end"], "text": text})
    return out


def fetch_captions(info: VideoInfo, lang_prefs=CAPTION_LANG_PREFS) -> Optional[Dict[str, Any]]:
    """Download and parse the best available caption track.

    Returns {"lang", "is_automatic", "segments": [{start, end, text}]}, or None
    when the video has no usable captions -- which is the signal for the caller to
    fall back to transcription.
    """
    if MOCK_MODE:
        return {"lang": "es", "is_automatic": False, "segments": list(_MOCK_SEGMENTS)}

    selected = _select_caption_track(info, lang_prefs)
    if not selected:
        return None
    url, ext, lang, is_automatic = selected

    try:
        response = requests.get(url, timeout=CAPTION_TIMEOUT_SECS)
        response.raise_for_status()
        payload = response.text
    except Exception as exc:
        print(f"[LINGOPAUSE] caption download failed ({lang}/{ext}): {exc}")
        return None

    try:
        segments = _parse_json3(payload) if ext == "json3" else _parse_vtt(payload)
    except Exception as exc:
        print(f"[LINGOPAUSE] caption parse failed ({lang}/{ext}): {exc}")
        return None

    if is_automatic:
        segments = _dedupe_rolling_captions(segments)
    if not segments:
        return None
    return {"lang": lang, "is_automatic": is_automatic, "segments": segments}


def transcript_text(segments: List[Dict[str, Any]], with_timestamps: bool = True) -> str:
    """Flatten segments into the text an LLM prompt gets.

    Timestamps are included by default: the extraction prompt has to be able to
    report where in the video a term first appears, and that is only recoverable
    if the timing survives into the prompt.
    """
    if not segments:
        return ""
    if not with_timestamps:
        return " ".join(s["text"] for s in segments)
    lines = []
    for segment in segments:
        total = int(segment.get("start") or 0)
        lines.append(f"[{total // 60:02d}:{total % 60:02d}] {segment['text']}")
    return "\n".join(lines)
