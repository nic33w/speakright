# tts_helpers.py — Azure TTS wrapper
import io
import re
import wave
from datetime import timedelta
from typing import Optional

import requests

from settings import (
    AZURE_REGION,
    AZURE_SPEECH_KEY,
    MOCK_MODE,
    TEST_AUDIO_PATH,
    VOICE_MAP,
)

try:
    from usage_tracker import add_azure_chars as _add_azure_chars
except ImportError:
    _add_azure_chars = None

# task 3.10: SSML <break> at clause boundaries inside a sentence, so a learner
# finishes parsing clause 1 before clause 2 starts — the pause carries the
# processing-time benefit that slowed articulation is usually credited with,
# without distorting connected-speech features. Kept ~2x below
# WITHIN_PAIR_GAP_MS (500ms, task 3.8) so the pause ladder still tells clause
# boundary / language switch / sentence end apart (see TASKS.md task 3.10).
DEFAULT_CLAUSE_PAUSE_MS = 250

# Punctuation and Spanish clause-introducing cue words. Pure heuristic, zero
# LLM cost — only escalate to model-marked segmentation if this demonstrably
# fails (see task 3.10).
_CLAUSE_CUE_WORDS = ("que", "porque", "pero", "cuando", "si", "y")
_CLAUSE_BOUNDARY_RE = re.compile(
    r"([,;])\s+|\s+(?=(?:" + "|".join(_CLAUSE_CUE_WORDS) + r")\b)",
    re.IGNORECASE,
)


def insert_clause_breaks(text: str, pause_ms: int = 0) -> str:
    """Insert SSML <break> tags at clause boundaries in `text`.

    pause_ms=0 (the default) is a no-op — returns `text` unchanged, which is
    what keeps the audio cache key backward-compatible (see
    audio_utils.get_cached_audio_path). Only a single clause (no detected
    boundary) also returns `text` unchanged even when pause_ms is set.
    """
    if pause_ms <= 0 or not text:
        return text
    break_tag = f'<break time="{pause_ms}ms"/> '

    def _replace(match: "re.Match") -> str:
        punct = match.group(1)
        return (punct + break_tag) if punct else break_tag

    return _CLAUSE_BOUNDARY_RE.sub(_replace, text)

# Text that already carries SSML markup (LingoPause wraps target-language spans in
# <lang xml:lang="..."> so a multilingual voice switches accent mid-utterance).
# Such text must NOT be XML-escaped and must NOT have clause breaks regex'd into
# it -- _CLAUSE_BOUNDARY_RE would happily fire inside a tag and produce invalid SSML.
_SSML_TAG_RE = re.compile(r"<\s*(lang|break|emphasis|phoneme|prosody|say-as|sub|voice)\b", re.IGNORECASE)


def looks_like_ssml(text: str) -> bool:
    return bool(_SSML_TAG_RE.search(text or ""))


def _escape_xml(text: str) -> str:
    """Escape plain text for inclusion in SSML.

    Previously absent: plain text went into the SSML template raw, so an ampersand
    or angle bracket in a learner sentence produced invalid XML and a failed
    synthesis that fell through to silence.
    """
    return (
        (text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def prepare_ssml_body(text: str, pause_ms: int = 0) -> str:
    """The inner SSML for `text`: passed through if already marked up, escaped and
    clause-broken if it is plain."""
    if looks_like_ssml(text):
        return text
    return insert_clause_breaks(_escape_xml(text), pause_ms)


def wrap_lang(text: str, locale: str) -> str:
    """Wrap plain text in <lang> so a multilingual voice speaks it with the right
    accent. Idempotent: text that is already marked up is returned unchanged."""
    if not text or looks_like_ssml(text):
        return text or ""
    return f'<lang xml:lang="{locale}">{_escape_xml(text)}</lang>'


def build_ssml(text: str, locale: str, voice_name: str, rate: int = 0, pause_ms: int = 0) -> str:
    """The full SSML document sent to Azure, by either the REST or SDK path.

    Shared so word timings are measured against byte-identical markup to the audio
    that gets cached — a highlight synced to a different rendering drifts.
    """
    return (
        f"<speak version='1.0' xml:lang='{locale}'>"
        f"<voice name='{voice_name}'>"
        f"<prosody rate='{rate}%' pitch='0%'>{prepare_ssml_body(text, pause_ms)}</prosody>"
        f"</voice></speak>"
    )


def generate_silent_wav(duration_secs: float = 0.6, sample_rate: int = 22050) -> bytes:
    n_frames = int(duration_secs * sample_rate)
    nchannels = 1
    sampwidth = 2
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(nchannels)
        wf.setsampwidth(sampwidth)
        wf.setframerate(sample_rate)
        silence = (0).to_bytes(2, byteorder='little', signed=True)
        wf.writeframes(silence * n_frames)
    return buf.getvalue()

def azure_tts_bytes_real(text: str, locale: str = "es-MX", voice: Optional[str] = None, max_duration: float = 6.0, rate: int = 0, pause_ms: int = 0) -> bytes:
    """
    Returns WAV bytes from Azure TTS. Requires AZURE_SPEECH_KEY and AZURE_REGION to be set.
    locale: es-MX, id-ID, en-US
    voice: optional voice name; if None we pick a default per locale
    rate: SSML prosody rate as a percent offset from normal speed (e.g. -25 for 0.75x/slower, 0 = normal)
    pause_ms: SSML <break> length inserted at detected clause boundaries; 0 = no breaks (task 3.10)
    """
    if not AZURE_SPEECH_KEY or not AZURE_REGION:
        raise RuntimeError("Azure TTS credentials not configured")

    # default voice map lives in settings.VOICE_MAP (env-overridable)
    voice_name = voice or VOICE_MAP.get(locale, list(VOICE_MAP.values())[0])
    # limit length roughly by words -> duration
    words = len(str(text).split())
    duration = min(max_duration, max(0.5, 0.25 * words))

    ssml = build_ssml(text, locale, voice_name, rate, pause_ms)
    url = f"https://{AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1"
    headers = {
        "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "riff-16khz-16bit-mono-pcm",
        "User-Agent": "speakright",
    }
    resp = requests.post(url, headers=headers, data=ssml.encode("utf-8"), timeout=20)
    if resp.status_code != 200:
        raise RuntimeError(f"Azure TTS failed: {resp.status_code} {resp.text[:400]}")
    return resp.content

def synthesize_with_timings(
    text: str,
    locale: str = "es-MX",
    voice: Optional[str] = None,
    rate: int = 0,
    pause_ms: int = 0,
) -> tuple:
    """Synthesize and also return per-word timings: (wav_bytes, words).

    `words` is [{"text", "offsetMs", "durationMs"}] in playback order, which is what
    drives LingoPause's replay word-highlighting.

    This needs the Speech **SDK**, not the REST endpoint the rest of this module
    uses: /cognitiveservices/v1 returns audio bytes and nothing else, so word
    boundaries are simply not available there. The SDK emits them as events during
    synthesis at no extra cost — same audio, same billing.

    Timings are only meaningful against the exact markup that produced the audio,
    so this builds its SSML with the shared `build_ssml` rather than its own.

    Raises on failure; callers fall back to plain audio with no timings, which
    degrades the highlight rather than the lesson.
    """
    if MOCK_MODE:
        # Even spacing over the silent clip: enough for the highlight loop to be
        # exercised end to end without keys or spend.
        plain = re.sub(r"<[^>]+>", "", text or "")
        tokens = [w for w in plain.split() if w]
        per_word = 400
        words = [
            {"text": w, "offsetMs": i * per_word, "durationMs": per_word}
            for i, w in enumerate(tokens)
        ]
        duration = max(0.5, len(tokens) * per_word / 1000.0)
        return generate_silent_wav(duration_secs=duration), words

    if not AZURE_SPEECH_KEY or not AZURE_REGION:
        raise RuntimeError("Azure TTS credentials not configured")

    import azure.cognitiveservices.speech as speechsdk

    voice_name = voice or VOICE_MAP.get(locale, list(VOICE_MAP.values())[0])
    ssml = build_ssml(text, locale, voice_name, rate, pause_ms)

    config = speechsdk.SpeechConfig(subscription=AZURE_SPEECH_KEY, region=AZURE_REGION)
    config.set_speech_synthesis_output_format(
        speechsdk.SpeechSynthesisOutputFormat.Riff16Khz16BitMonoPcm
    )
    # audio_config=None keeps the audio in memory instead of playing it on the
    # server's default speaker, which is the SDK's default behaviour.
    synthesizer = speechsdk.SpeechSynthesizer(speech_config=config, audio_config=None)

    words: list = []

    def _on_word_boundary(evt):
        # Punctuation and sentence boundaries come through the same event; only
        # word boundaries map onto something highlightable.
        if getattr(evt, "boundary_type", None) == speechsdk.SpeechSynthesisBoundaryType.Word:
            words.append({
                "text": evt.text,
                # audio_offset is in 100-nanosecond ticks.
                "offsetMs": int(evt.audio_offset / 10_000),
                "durationMs": int(getattr(evt, "duration", timedelta()).total_seconds() * 1000),
            })

    synthesizer.synthesis_word_boundary.connect(_on_word_boundary)
    result = synthesizer.speak_ssml_async(ssml).get()

    if result.reason != speechsdk.ResultReason.SynthesizingAudioCompleted:
        detail = getattr(result, "cancellation_details", None)
        raise RuntimeError(f"Azure TTS (SDK) failed: {result.reason} {getattr(detail, 'error_details', '')}")

    if _add_azure_chars:
        try:
            # Billed on spoken characters, so measure the text without markup.
            _add_azure_chars(len(re.sub(r"<[^>]+>", "", text or "")))
        except Exception:
            pass

    words.sort(key=lambda w: w["offsetMs"])
    return bytes(result.audio_data), words


# LingoPause: the lesson prompt marks target-language words inside an otherwise
# English explanation, so each can be spoken by the right voice. `[[...]]` is used
# rather than quotes because explanations quote the English gloss just as often as
# the target phrase ("'Somos una riata' means 'we're a bunch of amateurs'"), so
# quote-detection mis-tags roughly half of them.
# Gap inserted at each language seam when stitching. Small on purpose: the point of
# stitching is to REMOVE Azure's ~775ms inter-utterance padding, not to re-add it.
RUN_GAP_MS = 60

TARGET_SPAN_OPEN = "[["
TARGET_SPAN_CLOSE = "]]"
_TARGET_SPAN_RE = re.compile(r"\[\[(.+?)\]\]", re.DOTALL)


def strip_span_markers(text: str) -> str:
    """The on-screen form: markers removed, words kept."""
    return _TARGET_SPAN_RE.sub(r"\1", text or "")


def has_span_markers(text: str) -> bool:
    return bool(_TARGET_SPAN_RE.search(text or ""))


def split_language_runs(text: str, target_locale: str, ui_locale: str = "en-US") -> list:
    """Split marked text into consecutive single-language runs.

    Returns [{"text", "locale", "voice"}]. Adjacent runs of the same language are
    merged, because every extra run is one more synthesis request and one more
    seam to stitch.
    """
    if not text:
        return []
    runs = []
    position = 0
    for match in _TARGET_SPAN_RE.finditer(text):
        if match.start() > position:
            runs.append((text[position:match.start()], ui_locale))
        runs.append((match.group(1), target_locale))
        position = match.end()
    if position < len(text):
        runs.append((text[position:], ui_locale))

    merged: list = []
    for chunk, locale in runs:
        if not chunk.strip():
            # Whitespace between runs belongs to whichever side already exists, so
            # it is never synthesized as a run of its own.
            if merged:
                merged[-1]["text"] += chunk
            continue
        if merged and merged[-1]["locale"] == locale:
            merged[-1]["text"] += chunk
        else:
            merged.append({"text": chunk, "locale": locale})

    for run in merged:
        run["text"] = run["text"].strip()
        run["voice"] = VOICE_MAP.get(run["locale"], "")
    return [r for r in merged if r["text"]]


def synthesize_mixed(runs: list, rate: int = 0) -> tuple:
    """Speak a mixed-language sentence with a different voice per language.

    Returns (wav_bytes, words) exactly like `synthesize_with_timings`.

    Each run is synthesized on its own, trimmed of Azure's leading/trailing padding,
    and concatenated. The alternative -- several `<voice>` blocks in one SSML
    document -- does work and does keep its word boundaries, but Azure treats each
    block as a separate utterance and pads it: measured at ~775ms of dead air per
    switch, which turns a two-second explanation into four seconds of stalling.
    Stitching costs one request per run instead of one per sentence, but those are
    cached forever and the result actually sounds like a sentence.

    Word offsets are rebased onto the concatenated timeline as it is built, so the
    replay highlight stays in sync across voice changes.
    """
    from audio_utils import concat_wavs, trim_silence, wav_duration_ms

    if not runs:
        raise ValueError("no runs to speak")

    clips: list = []
    words: list = []
    elapsed = 0
    for index, run in enumerate(runs):
        clip, run_words = synthesize_with_timings(
            run["text"], run["locale"], run.get("voice"), rate
        )
        clip = trim_silence(clip)
        # A hair of space at each seam: without it the languages run together, with
        # much more it reads as a hesitation. Well under the 250ms clause pause.
        gap = RUN_GAP_MS if index else 0
        elapsed += gap
        for word in run_words:
            words.append({**word, "offsetMs": word["offsetMs"] + elapsed})
        elapsed += wav_duration_ms(clip)
        clips.append(clip)

    return concat_wavs(clips, gap_ms=RUN_GAP_MS), words


def tts_bytes_for_chunk(text: str, lang_tag: str, rate: int = 0, pause_ms: int = 0, voice: Optional[str] = None) -> bytes:
    """
    Convenience wrapper: tries Azure TTS if configured, else returns test audio in mock mode,
    or falls back to silent wav.

    In MOCK_MODE: Never uses Azure TTS (saves money, works offline)
    rate: SSML prosody rate as a percent offset from normal speed (e.g. -25 for 0.75x/slower, 0 = normal)
    pause_ms: SSML <break> length inserted at detected clause boundaries; 0 = no breaks (task 3.10)
    """
    # If mock mode, try test audio first, then fall back to silence (NEVER use Azure in mock mode)
    if MOCK_MODE:
        if TEST_AUDIO_PATH.exists():
            try:
                with open(TEST_AUDIO_PATH, "rb") as f:
                    return f.read()
            except Exception as e:
                print(f"Failed to read test audio file: {e}")
        # Fallback to silence in mock mode
        words = max(1, len(str(text).split()))
        duration = min(4.0, 0.25 * words)
        return generate_silent_wav(duration_secs=duration)

    # Not in mock mode - use real Azure TTS
    try:
        if AZURE_SPEECH_KEY and AZURE_REGION:
            result = azure_tts_bytes_real(text, locale=lang_tag, voice=voice, rate=rate, pause_ms=pause_ms)
            if _add_azure_chars:
                try:
                    _add_azure_chars(len(re.sub(r'<[^>]+>', '', text or '')))
                except Exception:
                    pass
            return result
    except Exception as e:
        print("Azure TTS failed:", e)
    # fallback to silence if Azure fails
    words = max(1, len(str(text).split()))
    duration = min(4.0, 0.25 * words)
    return generate_silent_wav(duration_secs=duration)
