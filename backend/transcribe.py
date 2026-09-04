"""Transcription fallback for videos with no usable captions -- STUB.

Deliberately not implemented yet. The provider decision is open (OpenAI
`whisper-1`, a local faster-whisper/whisper.cpp install, or Azure batch
transcription), and each one drags in something the app does not have today:

- OpenAI `whisper-1` is the only OpenAI transcription model that returns
  timestamps -- the `gpt-4o-*-transcribe` models do not support
  `timestamp_granularities` -- so it is the one to pick if the API route wins.
  ~$0.006/min, and it would need a duration-derived cost recorded into
  `usage_tracker` (which today counts OpenAI *tokens* and Azure *chars*, neither
  of which describes an audio minute). Also a 25MB upload cap, so long videos
  need chunking.
- A local model costs nothing per video but is a heavy Windows install.
- Azure batch transcription reuses the Speech key already in `.env`, but it is a
  different API surface than `tts_helpers` (async job + blob upload), so it is
  new integration work rather than reuse.

Whichever wins, it implements `transcribe_segments` below and nothing else
changes: the router already treats a raised `TranscriptionUnavailable` as "this
video cannot be ingested yet" and reports it to the user, and every consumer
downstream reads the same `{start, end, text}` segment shape that
`video_source.fetch_captions` produces.

Note for whoever implements it: the audio download that feeds this is the one
place LingoPause would touch the media itself rather than the IFrame player.
Gate it to the caption-miss path only, and delete the file once the segments are
in hand.
"""
from typing import Any, Dict, List

from settings import MOCK_MODE


class TranscriptionUnavailable(Exception):
    """No transcript could be produced for this video."""


def is_available() -> bool:
    """Whether a transcription backend is wired up.

    True in mock mode so the test suite can exercise the fallback branch; False
    in real runs until a provider is chosen.
    """
    return bool(MOCK_MODE)


def transcribe_segments(url: str, duration: int = 0) -> List[Dict[str, Any]]:
    """Produce timestamped transcript segments for a video with no captions.

    Returns the same shape as `video_source.fetch_captions`'s `segments`:
    `[{"start": float, "end": float, "text": str}]`.
    """
    if MOCK_MODE:
        return [
            {"start": 0.0, "end": 5.0, "text": "[mock transcription] Hola, bienvenidos."},
            {"start": 5.0, "end": 11.0, "text": "[mock transcription] Hoy vamos a platicar."},
        ]

    raise TranscriptionUnavailable(
        "This video has no usable captions, and audio transcription is not set up yet. "
        "Try a video with subtitles for now."
    )
