"""LingoPause lesson playback: turning a lesson entry into on-screen BLOCKS.

The viewer shows one page per item, deliberately sparse:

    Example 1   The star's going to fall right there.     <- the video's own line
                [hear it in Spanish] [show Spanish]
    Things to note
                - Putting "ahi" at the front emphasises the place.
                - The "se" says it falls by itself.
    Example 2   Careful, the glass is going to fall there.
                [hear it in Spanish] [show Spanish]
    Example 3   ...
    Video       the clip, cued to the line

A **block** is one of those rows: what is shown together and what plays when
you step onto it. A **beat** is one clip inside a block, with the text that goes
with it. Blocks are the layout and the keyboard unit; beats are the audio unit.

Example 1 is always the line from the video itself -- you meet the phrase where
you will actually hear it -- and examples 2 and 3 are fresh sentences showing the
pattern is general.

**Voices are picked per beat, from the app's own VOICE_MAP** -- the same voices
every other mode uses:

  - English framing -> the en-US voice
  - Target language -> the target voice
  - Notes -> mixed, per language span (see below)

A note is English prose quoting target-language words, and those quoted words are
the part that has to sound right. The lesson prompt marks them `[[like this]]`;
`tts_helpers.split_language_runs` cuts the line into per-language runs and
`synthesize_mixed` speaks each in its own voice, stitching the clips with Azure's
inter-utterance padding trimmed. Measured on one sentence: stitched 2.66s versus
4.24s for the same content as several `<voice>` blocks in one SSML request, against
2.69s for a single voice. Unmarked text falls back to the target voice for the
whole line, which is what lessons written before the marking existed get.

Lessons written before the notes format (`written_explanation`/`definition` prose)
still play: `derive_notes` sentence-splits whatever prose they have. That is a real
downgrade -- it reads grammar jargon aloud, which is exactly what the notes format
exists to avoid -- so those blocks are flagged `derived` and the UI says so.
"""
import re
import unicodedata
from typing import Any, Dict, List, Optional

from settings import UI_LOCALE, VOICE_MAP, locale_for
from tts_helpers import has_span_markers, split_language_runs, strip_span_markers

# Roles whose text IS the target language -- what the learner is listening to
# rather than reading.
TARGET_ROLES = frozenset({"example_target"})

# Roles spoken by the target-language voice when they carry no language markers.
TARGET_VOICE_ROLES = TARGET_ROLES | {"note"}

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")

# A note that is really a paragraph defeats the point of the format.
MAX_DERIVED_NOTES = 4


def prose_of(lesson: Dict[str, Any]) -> str:
    """Whatever explanatory prose a pre-notes lesson has."""
    written = (lesson.get("written_explanation") or "").strip()
    if written:
        return written
    parts = [
        (lesson.get("definition") or lesson.get("description") or "").strip(),
        (lesson.get("colloquial_notes") or "").strip(),
    ]
    return "\n\n".join(p for p in parts if p)


def derive_notes(lesson: Dict[str, Any]) -> List[str]:
    """Bullets for a lesson that predates the notes format.

    Sentence-splitting its prose, capped so a long explanation does not become
    eight bullets. Strictly a fallback: the sentences were written to be read as
    prose, so they carry the jargon and the padding that real notes avoid.
    """
    text = prose_of(lesson)
    if not text:
        return []
    notes = []
    for paragraph in text.split("\n"):
        for sentence in _SENTENCE_SPLIT_RE.split(paragraph):
            sentence = sentence.strip()
            if sentence:
                notes.append(sentence)
    return notes[:MAX_DERIVED_NOTES]


def notes_of(lesson: Dict[str, Any]) -> tuple:
    """(notes, derived). Authored bullets win; otherwise they are derived."""
    authored = lesson.get("notes")
    if isinstance(authored, str):
        authored = [authored]
    if isinstance(authored, list):
        notes = [str(n).strip() for n in authored if str(n).strip()]
        if notes:
            return notes, False
    # `spoken_explanation` was the previous format's segmented field; it is closer
    # to a note than the written prose is, so prefer it when present.
    spoken = lesson.get("spoken_explanation")
    if isinstance(spoken, list):
        notes = [str(n).strip() for n in spoken if str(n).strip()]
        if notes:
            return notes[:MAX_DERIVED_NOTES], True
    return derive_notes(lesson), True


def voice_for_role(role: str, target_locale: str) -> tuple:
    """(locale, voice) for a beat role, from the app's own VOICE_MAP."""
    if role in TARGET_VOICE_ROLES:
        return target_locale, VOICE_MAP.get(target_locale, "")
    return UI_LOCALE, VOICE_MAP.get(UI_LOCALE, "")


def mark_term_occurrences(text: str, term: str) -> str:
    """Mark occurrences of the lesson's own term in otherwise unmarked prose.

    A narrow, always-safe heuristic for lessons written before the prompt marked
    target-language spans: whatever else is in a note, the term itself is
    definitely the target language.

    It does NOT catch other target-language fragments ("'ir a' + infinitive"),
    because there is no reliable way to tell those from a quoted English gloss --
    explanations quote both ("'Somos una riata' means 'we're a bunch of amateurs'").
    Regenerating a video's lessons is what fixes those properly.
    """
    term = (term or "").strip()
    if not text or not term or has_span_markers(text):
        return text
    pattern = re.compile(r"(?<![\w\[])" + re.escape(term) + r"(?![\w\]])", re.IGNORECASE)
    return pattern.sub(lambda m: f"[[{m.group(0)}]]", text)


def make_beat(
    beat_id: str,
    role: str,
    text: str,
    target_locale: str,
    derived: bool = False,
) -> Dict[str, Any]:
    """One clip: the text on screen, and how to speak it.

    Marked text is split into per-language runs so each language gets its own
    voice; markers never reach `text`, which is what the learner sees.
    """
    locale, voice = voice_for_role(role, target_locale)
    beat = {
        "id": beat_id,
        "role": role,
        "text": strip_span_markers(text),
        "is_target": role in TARGET_ROLES,
        "locale": locale,
        "voice": voice,
    }
    if has_span_markers(text):
        runs = split_language_runs(text, target_locale, UI_LOCALE)
        if runs:
            beat["runs"] = runs
            # A client that ignores `runs` still plays something sensible.
            beat["locale"], beat["voice"] = runs[0]["locale"], runs[0]["voice"]
    if derived:
        beat["derived"] = True
    return beat


def _norm_text(text: str) -> str:
    """Accent/punctuation-insensitive form, for locating the taught phrase."""
    stripped = unicodedata.normalize("NFD", text or "")
    stripped = "".join(c for c in stripped if unicodedata.category(c) != "Mn")
    return re.sub(r"[^\w\s]", "", stripped).lower()


def split_sentences(text: str) -> List[str]:
    return [s.strip() for s in _SENTENCE_SPLIT_RE.split((text or "").strip()) if s.strip()]


def pair_sentences(english: str, target: str) -> List[Dict[str, str]]:
    """Line up an English translation with its target sentences, one pair each.

    The video's line is often several sentences ("I won. The star's going to fall
    right there. Hey, you already know the drill."), and hearing it as one long
    blob is much harder than hearing it sentence by sentence with its translation.

    Pairing only when the two sides split into the SAME number of sentences: an
    unequal split means the translation merged or divided something, and guessing
    an alignment would put the wrong English against the wrong Spanish. In that
    case the whole thing stays one pair, which is what it was before.
    """
    en, tg = split_sentences(english), split_sentences(target)
    if len(en) == len(tg) and len(en) > 1:
        return [{"english": e, "target": t} for e, t in zip(en, tg)]
    return [{"english": (english or "").strip(), "target": (target or "").strip()}]


def _focus_index(pairs: List[Dict[str, str]], term: str) -> int:
    """Which pair actually contains the phrase being taught.

    That one is the point of the slide; the others are the run-up and the run-off,
    shown quietly for context.
    """
    needle = " ".join(_norm_text(term).split())
    if not needle:
        return 0
    for i, pair in enumerate(pairs):
        if needle in _norm_text(pair.get("target", "")):
            return i
    return len(pairs) - 1


def _example_block(
    block_id: str,
    label: str,
    english: str,
    target: str,
    target_locale: str,
    term: str,
    from_video: bool = False,
    timestamp_seconds: Optional[float] = None,
) -> Dict[str, Any]:
    """One slide: sentence pairs, English on screen, target behind a button.

    A multi-sentence line becomes one pair per sentence so it is heard in
    digestible pieces rather than as one blob, and the pair containing the taught
    phrase is marked as the focus -- the others are context around it.
    """
    pairs = pair_sentences(english, target)
    focus = _focus_index(pairs, term)

    beats = []
    for i, pair in enumerate(pairs):
        if pair["english"]:
            beats.append(make_beat(f"{block_id}en{i}", "example_en",
                                   mark_term_occurrences(pair["english"], term), target_locale))
        if pair["target"]:
            beats.append(make_beat(f"{block_id}tg{i}", "example_target",
                                   pair["target"], target_locale))
        pair["is_focus"] = i == focus
        pair["en_beat"] = f"{block_id}en{i}" if pair["english"] else None
        pair["tg_beat"] = f"{block_id}tg{i}" if pair["target"] else None

    return {
        "id": block_id,
        "kind": "example",
        "label": label,
        "pairs": pairs,
        "from_video": from_video,
        "timestamp_seconds": timestamp_seconds,
        "beats": beats,
    }


def build_blocks(lesson: Dict[str, Any], target_lang: str = "es") -> List[Dict[str, Any]]:
    """Flatten one lesson into the blocks the viewer renders and steps through."""
    target_locale = locale_for(target_lang)
    term = str(lesson.get("display") or lesson.get("term") or "").strip()
    blocks: List[Dict[str, Any]] = []

    # 1. The video's own line, first: meet the phrase where you will hear it.
    usage = lesson.get("video_usage") or {}
    timestamp = usage.get("timestamp_seconds") if isinstance(usage, dict) else None
    if isinstance(usage, dict) and (usage.get("target_sentence") or usage.get("english_translation")):
        blocks.append(_example_block(
            "ex1", "Example 1",
            str(usage.get("english_translation") or "").strip(),
            str(usage.get("target_sentence") or "").strip(),
            target_locale, term,
            from_video=True,
            timestamp_seconds=timestamp if isinstance(timestamp, (int, float)) else None,
        ))

    # 2. Things to note — the only explanation there is.
    notes, derived = notes_of(lesson)
    if notes:
        blocks.append({
            "id": "notes",
            "kind": "notes",
            "label": "Things to note",
            "notes": [strip_span_markers(mark_term_occurrences(n, term)) for n in notes],
            "derived": derived,
            "beats": [
                make_beat(f"note{i}", "note", mark_term_occurrences(n, term),
                          target_locale, derived=derived)
                for i, n in enumerate(notes)
            ],
        })

    # 3. Fresh examples, showing the pattern is not tied to the video's sentence.
    for index, example in enumerate(lesson.get("example_sentences") or []):
        if not isinstance(example, dict):
            continue
        english = str(example.get("english") or "").strip()
        target = str(example.get("target") or "").strip()
        if not (english or target):
            continue
        number = sum(1 for b in blocks if b["kind"] == "example") + 1
        blocks.append(_example_block(
            f"ex{index + 2}", f"Example {number}",
            english, target, target_locale, term,
        ))

    # 4. The clip itself, cued to the line.
    if isinstance(timestamp, (int, float)):
        blocks.append({
            "id": "video",
            "kind": "video",
            "label": "In the video",
            "timestamp_seconds": timestamp,
            # Where to stop. Set by the router from the transcript when known, so
            # playback pauses itself just after the line instead of running on.
            "end_seconds": lesson.get("video_end_seconds"),
            "beats": [],
        })
    return blocks
