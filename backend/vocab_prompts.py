"""Copy-paste prompt assembly for LingoPause, and tolerant parsing of what comes back.

LingoPause runs its two LLM steps **by hand**: the learner copies one assembled
block into browser ChatGPT/Claude and pastes the JSON answer back. So there is no
`llm_call.py` function for vocab extraction or lesson generation, and no API spend
for either -- this module is the whole of that half of the pipeline.

Two halves:
  - `build_extraction_block` / `build_lesson_block` fill the hand-authored prompt
    templates in `prompts/templates/` with the video's own material.
  - `parse_pasted_json` reads whatever comes back, which is chat output rather than
    an API response: fenced, prefaced with "Sure! Here's the JSON:", occasionally
    both.

**Substitution, not `str.format`.** Both templates contain literal JSON braces in
their output specs (`array of {target, english}`), which `.format()` would try to
read as fields and die on. `_render` only replaces the known placeholder names and
leaves every other brace alone.

A missing or placeholder-free template still works: the video material is appended
as labelled sections instead, so the block is usable with the prompt pasted above
it by hand.
"""
import json
import re
import unicodedata
from typing import Any, Dict, List, Optional

from settings import PROMPTS_DIR
from tts_helpers import wrap_lang

EXTRACTION_TEMPLATE = "vocab_extraction.txt"
LESSON_TEMPLATE = "vocab_lesson.txt"

_TEMPLATE_DIR = PROMPTS_DIR / "templates"

# Rough characters-per-token for a Latin-script transcript. Only used to warn that
# a very long video may not fit in one paste -- never for billing.
_CHARS_PER_TOKEN = 3.7

_FENCE_RE = re.compile(r"```(?:json)?", re.IGNORECASE)

# The only braces treated as placeholders. Anything else in a template -- notably
# the `{target, english}` shapes in the output specs -- passes through untouched.
_PLACEHOLDERS = ("language", "user_notes", "description", "transcript", "confirmed_vocab_list")
_PLACEHOLDER_RE = re.compile(r"\{(" + "|".join(_PLACEHOLDERS) + r")\}")

_NO_NOTES = "(none given)"


def _block(value: str) -> str:
    """Multi-line values start on their own line: the placeholders sit inline after
    a label ("Transcript: {transcript}"), and a block running on from one is much
    harder to read -- for the model and for anyone checking the paste."""
    return ("\n" + value + "\n") if "\n" in value else value


def load_template(name: str) -> str:
    """Read a prompt template, or return "" when it has not been written yet."""
    path = _TEMPLATE_DIR / name
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8").strip()


def _render(template: str, values: Dict[str, str]) -> str:
    return _PLACEHOLDER_RE.sub(lambda m: values.get(m.group(1), m.group(0)), template)


def _has_placeholders(template: str) -> bool:
    return bool(_PLACEHOLDER_RE.search(template))


def _section(title: str, body: str) -> str:
    return f"### {title}\n{body.strip()}\n" if (body or "").strip() else ""


def _fallback_context(session: Dict[str, Any], values: Dict[str, str], extra_title: str, extra: str) -> str:
    """Labelled sections, used when the template has no placeholders to fill."""
    duration = int(session.get("duration") or 0)
    meta = [
        f"Title: {session.get('title', '')}",
        f"Channel: {session.get('uploader', '')}",
        f"Length: {duration // 60}m{duration % 60:02d}s",
        f"Language being learned: {values['language']}",
    ]
    return (
        _section("VIDEO", "\n".join(m for m in meta if m.split(": ", 1)[-1].strip()))
        + _section("DESCRIPTION (from YouTube)", session.get("description", ""))
        + _section("WHAT THE LEARNER SAID ABOUT THIS VIDEO", session.get("notes", ""))
        + _section(extra_title, extra)
    )


def _base_values(session: Dict[str, Any]) -> Dict[str, str]:
    return {
        "language": (session.get("target_language") or {}).get("name", "the target language"),
        "description": _block((session.get("description") or "").strip()) or "(none)",
        "user_notes": (session.get("notes") or "").strip() or _NO_NOTES,
    }


def _stamp(seconds: Any) -> str:
    if not isinstance(seconds, (int, float)):
        return ""
    total = int(seconds)
    return f"[{total // 60:02d}:{total % 60:02d}] "


# What an item actually is. The distinction matters because a "construction" is
# made entirely of words the learner already knows -- "vamos a estar subiendo"
# needs a pattern explanation, not a gloss, and it is invisible to any filter that
# asks "which words don't they know?".
KINDS = ("word", "phrase", "construction")
_KIND_ALIASES = {
    "word": "word", "vocab": "word", "vocabulary": "word", "lexical": "word", "term": "word",
    "phrase": "phrase", "set phrase": "phrase", "idiom": "phrase", "idiomatic": "phrase",
    "expression": "phrase", "collocation": "phrase", "slang": "phrase",
    "construction": "construction", "grammar": "construction", "structure": "construction",
    "pattern": "construction", "chunk": "construction", "grammatical": "construction",
}


def _normalize_kind(item: Dict[str, Any], term: str) -> str:
    """Read the item's declared kind, or fall back to word count.

    Inference is deliberately crude: one word is a "word", more is a "phrase". A
    "construction" is never inferred -- only the prompt can know that every word in
    a chunk is already familiar and it is the pattern that defeats comprehension.
    """
    raw = item.get("kind") or item.get("type") or item.get("category") or ""
    mapped = _KIND_ALIASES.get(str(raw).strip().lower())
    if mapped:
        return mapped
    return "word" if len(term.split()) == 1 else "phrase"


_QUOTE_RADIUS_WORDS = 10

# Rough speaking rate, used only to estimate where a phrase stops when the caption
# timings cannot say (overlapping cues make the next word's stamp unreliable).
_SPOKEN_SECS_PER_WORD = 0.42
_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)


def _norm_word(word: str) -> str:
    """Accent- and punctuation-insensitive form, for matching only."""
    stripped = unicodedata.normalize("NFD", word or "")
    stripped = "".join(c for c in stripped if unicodedata.category(c) != "Mn")
    return _PUNCT_RE.sub("", stripped).lower()


def flatten_words(segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Every transcript word in order, each tagged with its cue's start time.

    Captions cannot be treated as a list of independent lines. YouTube's
    auto-captions are ROLLING: consecutive cues overlap by several seconds, and a
    phrase routinely straddles a cue boundary --

        [ 8.96-14.36] Vamos a jugar Mario Party Superstars, de
        [12.16-16.96] los mejores juegos de Switch, gey. La
        [14.36-19.56] neta, [risas] gey, tiene nuevo

    "la neta" exists in neither line alone, and three different cues contain t=14.
    Flattening to a word stream makes the transcript searchable as continuous
    speech, which is what it actually is.
    """
    words = []
    for segment in segments or []:
        start = segment.get("start")
        end = segment.get("end")
        tokens = str(segment.get("text") or "").split()
        # Interpolate each word's time across its cue rather than stamping them all
        # with the cue's start. Rolling cues span ~5 seconds, so a word near the end
        # of one is seconds later than its cue begins -- and seeking the video to the
        # cue start lands well before the phrase is actually said.
        span = (
            float(end) - float(start)
            if isinstance(start, (int, float)) and isinstance(end, (int, float)) and end > start
            else 0.0
        )
        for i, raw in enumerate(tokens):
            at = None
            if isinstance(start, (int, float)):
                at = float(start) + (span * i / len(tokens) if span and tokens else 0.0)
            words.append({"raw": raw, "norm": _norm_word(raw), "start": at})
    return words


def find_term_window(
    segments: List[Dict[str, Any]],
    term: str,
    radius: int = _QUOTE_RADIUS_WORDS,
) -> Optional[Dict[str, Any]]:
    """Locate `term` in the transcript and return the speech around it.

    Returns {"quote", "start"} or None. Matching is on the flattened word stream,
    so a phrase split across cues is still found.
    """
    needle = [w for w in (_norm_word(t) for t in (term or "").split()) if w]
    if not needle:
        return None
    words = flatten_words(segments)
    if len(words) < len(needle):
        return None

    for i in range(len(words) - len(needle) + 1):
        if all(words[i + j]["norm"] == needle[j] for j in range(len(needle))):
            lo = max(0, i - radius)
            hi = min(len(words), i + len(needle) + radius)
            start = next((w["start"] for w in words[i:hi] if w["start"] is not None), None)
            # Where the phrase stops being said. Taken from the words after it, but
            # word times are NOT monotonic across rolling cues -- the next cue can
            # begin before the previous one ends, so the very next word is sometimes
            # stamped earlier than the phrase itself. Take the largest of the next
            # few, and fall back to a spoken-duration estimate if that is still not
            # after the start.
            after = i + len(needle)
            following = [w["start"] for w in words[after:after + 5] if w["start"] is not None]
            end = max(following) if following else None
            if start is not None and (end is None or end <= start):
                end = start + _SPOKEN_SECS_PER_WORD * len(needle) + 0.4
            return {
                "quote": " ".join(w["raw"] for w in words[lo:hi]),
                "start": start,
                "end": end,
            }
    return None


def quote_for_timestamp(
    segments: List[Dict[str, Any]],
    seconds: Any,
    term: str = "",
) -> str:
    """The speech a term was used in, found locally.

    The lesson prompt asks for "the exact sentence from the transcript", but the
    lesson block deliberately does not re-send the transcript -- so it is looked up
    here and handed over with the term. That is cheaper than re-pasting a transcript
    and more accurate than asking the model to recall a line it can no longer see.

    Searching for the TERM comes first and the timestamp is only a fallback: the
    extraction model's `timestamp_seconds` is approximate, and with overlapping
    rolling cues "the segment containing t" is ambiguous and usually wrong.
    """
    if not segments:
        return ""
    found = find_term_window(segments, term)
    if found:
        return found["quote"]

    if not isinstance(seconds, (int, float)):
        return ""
    # Fall back to the speech around that moment -- still a window over the word
    # stream rather than one cue, since a single overlapping cue is a poor sample.
    words = flatten_words(segments)
    timed = [i for i, w in enumerate(words) if w["start"] is not None]
    if not timed:
        return ""
    centre = min(timed, key=lambda i: abs(words[i]["start"] - float(seconds)))
    lo = max(0, centre - _QUOTE_RADIUS_WORDS)
    hi = min(len(words), centre + _QUOTE_RADIUS_WORDS)
    return " ".join(w["raw"] for w in words[lo:hi])


def build_extraction_block(
    session: Dict[str, Any],
    with_timestamps: bool = True,
    template: Optional[str] = None,
) -> Dict[str, Any]:
    """Assemble the step-3 block: the extraction prompt, filled in.

    Returns {"text", "chars", "approx_tokens", "has_template", "segment_count"}.
    """
    from video_source import transcript_text

    segments = ((session.get("transcript") or {}).get("segments")) or []
    values = _base_values(session)
    values["transcript"] = _block(transcript_text(segments, with_timestamps=with_timestamps)) or "(empty)"

    tmpl = template if template is not None else load_template(EXTRACTION_TEMPLATE)
    if tmpl and _has_placeholders(tmpl):
        text = _render(tmpl, values)
    else:
        body = _fallback_context(session, values, "TRANSCRIPT", values["transcript"])
        text = "\n\n".join(p for p in (tmpl, body) if p.strip())

    text = text.strip() + "\n"
    return {
        "text": text,
        "chars": len(text),
        "approx_tokens": int(len(text) / _CHARS_PER_TOKEN),
        "has_template": bool(tmpl),
        "segment_count": len(segments),
    }


def format_vocab_list(terms: List[Dict[str, Any]], segments: Optional[List[Dict[str, Any]]] = None) -> str:
    """Render confirmed terms for the lesson prompt, each with its transcript line.

    The transcript line is what lets the prompt's `video_usage` field be answered
    accurately without re-sending the whole transcript.
    """
    lines = []
    for index, term in enumerate(terms, start=1):
        label = str(term.get("term") or term.get("display") or "").strip()
        if not label:
            continue
        line = f"{index}. {label}"
        kind = term.get("kind")
        if kind and kind != "word":
            # The lesson prompt teaches a construction differently from a word, so
            # it has to be told which it is looking at.
            line += f" [{kind}]"
        gloss = term.get("gloss_ui") or term.get("short_gloss")
        if gloss:
            line += f" — {gloss}"
        first_ts = term.get("first_ts", term.get("timestamp_seconds"))
        # Search the transcript before trusting a stored quote: a session written
        # before term-search existed carries quotes picked by timestamp alone, which
        # on rolling captions is usually the wrong line. Sending those to the lesson
        # prompt would produce a wrong `video_usage` for most items.
        found = find_term_window(segments or [], label)
        if found:
            quote = found["quote"]
            if found["start"] is not None:
                first_ts = found["start"]
        else:
            quote = term.get("quote") or quote_for_timestamp(segments or [], first_ts, label)
        if quote:
            line += f'\n   used in the video: {_stamp(first_ts)}"{quote}"'
        elif isinstance(first_ts, (int, float)):
            line += f"\n   first used at {_stamp(first_ts).strip()}"
        lines.append(line)
    return "\n".join(lines)


# How many terms go in one lesson block. The input is small either way; the OUTPUT
# is the constraint -- a phase-4 lesson runs ~170 tokens (written explanation,
# spoken segments, two examples, video usage), so 116 terms in one request asks for
# ~20k tokens and truncates mid-JSON in a single chat turn. 25 keeps a batch to
# ~4k out, comfortably inside one reply.
LESSON_BATCH_SIZE = 25


def build_lesson_block(
    session: Dict[str, Any],
    terms: List[Dict[str, Any]],
    template: Optional[str] = None,
    offset: int = 0,
    limit: Optional[int] = None,
) -> Dict[str, Any]:
    """Assemble the step-5 block: the lesson prompt, filled in.

    The transcript is deliberately not re-sent in full -- each term arrives with the
    line it was used in (see `quote_for_timestamp`), which is the context the lesson
    needs, and re-pasting a whole transcript for the second call would spend most of
    the paste budget on material the prompt does not ask for.
    """
    segments = ((session.get("transcript") or {}).get("segments")) or []
    usable = [t for t in terms if (t.get("term") or t.get("display"))]

    # Batching is about the response, not the request: one chat reply cannot hold
    # 100+ full lessons without truncating mid-JSON.
    total = len(usable)
    size = LESSON_BATCH_SIZE if limit is None else max(1, limit)
    offset = max(0, min(offset, total))
    batch = usable[offset:offset + size]

    values = _base_values(session)
    values["confirmed_vocab_list"] = _block(format_vocab_list(batch, segments)) or "(none)"

    tmpl = template if template is not None else load_template(LESSON_TEMPLATE)
    if tmpl and _has_placeholders(tmpl):
        text = _render(tmpl, values)
    else:
        body = _fallback_context(session, values, "TERMS TO WRITE LESSONS FOR", values["confirmed_vocab_list"])
        text = "\n\n".join(p for p in (tmpl, body) if p.strip())

    text = text.strip() + "\n"
    batch_count = max(1, (total + size - 1) // size) if total else 0
    return {
        "text": text,
        "chars": len(text),
        "approx_tokens": int(len(text) / _CHARS_PER_TOKEN),
        "has_template": bool(tmpl),
        "term_count": len(batch),
        # Batch position, so the UI can say "3 of 5" and advance without tracking
        # the maths itself.
        "offset": offset,
        "limit": size,
        "total_terms": total,
        "batch_index": (offset // size) + 1 if total else 0,
        "batch_count": batch_count,
        "next_offset": offset + size if offset + size < total else None,
    }


def parse_pasted_json(text: str) -> Any:
    """Pull a JSON object or array out of chat output.

    More forgiving than `llm_call._extract_json`, which only handles objects and only
    the API's own output: browser chat wraps JSON in fences, prefaces it with a
    sentence, and follows it with an offer to explain. Raises ValueError with
    something a person can act on.
    """
    if not (text or "").strip():
        raise ValueError("Nothing pasted.")

    cleaned = _FENCE_RE.sub("", text).strip()

    # Try the whole thing first: a clean paste needs no salvage.
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # Otherwise take the outermost bracketed span, preferring whichever of { or [
    # opens first -- both prompts ask for a bare array, but a model may wrap it.
    candidates = []
    for opener, closer in (("{", "}"), ("[", "]")):
        start = cleaned.find(opener)
        end = cleaned.rfind(closer)
        if start != -1 and end > start:
            candidates.append((start, cleaned[start:end + 1]))
    if not candidates:
        raise ValueError("Couldn't find any JSON in that paste — copy the whole JSON block.")

    candidates.sort(key=lambda c: c[0])
    for _, span in candidates:
        try:
            return json.loads(span)
        except json.JSONDecodeError:
            continue
    raise ValueError(
        "Found something JSON-shaped but couldn't parse it — it may have been cut off. "
        "Check the paste is complete."
    )


def _unwrap(parsed: Any, keys, what: str) -> List[Any]:
    """Both prompts ask for a bare array; models wrap it in an object anyway."""
    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, dict):
        for key in keys:
            if isinstance(parsed.get(key), list):
                return parsed[key]
    raise ValueError(f"That JSON has no list of {what} in it.")


def normalize_candidates(parsed: Any) -> List[Dict[str, Any]]:
    """Coerce a pasted extraction result into the candidate list the app stores.

    The prompt asks for `{term, timestamp_seconds, short_gloss}`; those are mapped
    onto the `first_ts` / `gloss_ui` names the checklist renders, with the originals
    kept alongside. Accepts a wrapped array or bare strings too -- the prompt is
    hand-authored and hand-tuned, so its exact output shape is not a contract.

    Every candidate is given an `id` if it lacks one: the checklist and the confirm
    endpoint address candidates by id, so one without it can never be kept.
    """
    items = _unwrap(parsed, ("candidates", "vocabulary", "vocab", "terms", "words", "items"), "terms")

    out: List[Dict[str, Any]] = []
    seen = set()
    for index, raw in enumerate(items):
        # A bare list of strings is a legitimate answer to "give me the words".
        item = {"term": raw} if isinstance(raw, str) else dict(raw) if isinstance(raw, dict) else None
        if item is None:
            continue
        term = str(item.get("term") or item.get("word") or item.get("display") or "").strip()
        if not term:
            continue
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)

        item["term"] = term
        item["id"] = str(item.get("id") or f"c{index + 1}")
        item["kind"] = _normalize_kind(item, term)
        gloss = item.get("gloss_ui") or item.get("short_gloss") or item.get("gloss")
        if gloss:
            item["gloss_ui"] = str(gloss).strip()
        ts = item.get("first_ts", item.get("timestamp_seconds", item.get("timestamp")))
        if isinstance(ts, (int, float)):
            item["first_ts"] = ts
        elif isinstance(ts, str):
            # "01:35" or "95" — the prompt asks for seconds, models sometimes stamp.
            parts = ts.strip().split(":")
            try:
                item["first_ts"] = sum(int(p) * 60 ** i for i, p in enumerate(reversed(parts)))
            except ValueError:
                pass
        out.append(item)

    if not out:
        raise ValueError("No usable terms in that paste — each one needs a 'term' field.")
    return out


def attach_quotes(candidates: List[Dict[str, Any]], segments: List[Dict[str, Any]]) -> None:
    """Fill each candidate's `quote` from the transcript, in place, and correct
    `first_ts` when the term is actually found.

    Done at import rather than at lesson time so the checklist can show a term in
    context -- the extraction prompt returns a timestamp but not the line.

    Locating the term also gives a better timestamp than the model's estimate, and
    that timestamp is what "Hear it in the video" seeks to, so it is worth taking.
    The model's value is kept only when the term cannot be found (a paraphrase, or
    a term the captions spell differently).
    """
    for candidate in candidates:
        found = find_term_window(segments, candidate.get("term", ""))
        if found:
            candidate["quote"] = found["quote"]
            if found["start"] is not None:
                candidate["first_ts"] = found["start"]
            continue
        if not candidate.get("quote"):
            quote = quote_for_timestamp(segments, candidate.get("first_ts"))
            if quote:
                candidate["quote"] = quote


def _fill_ssml(lesson: Dict[str, Any], target_locale: str) -> None:
    """Populate `target_ssml` / `target_sentence_ssml` in place where absent.

    Wrapping target text in `<lang xml:lang="...">` is a pure function of the text
    and the locale, so it is done here rather than asked of the model: it costs no
    output tokens, cannot come back malformed, and it means every lesson written
    before phase 4 gains working multilingual SSML with no regeneration. An
    authored value is never overwritten.
    """
    for example in lesson.get("example_sentences") or []:
        if isinstance(example, dict) and example.get("target") and not example.get("target_ssml"):
            example["target_ssml"] = wrap_lang(str(example["target"]), target_locale)

    usage = lesson.get("video_usage")
    if isinstance(usage, dict) and usage.get("target_sentence") and not usage.get("target_sentence_ssml"):
        usage["target_sentence_ssml"] = wrap_lang(str(usage["target_sentence"]), target_locale)


def normalize_lessons(parsed: Any, target_locale: str = "es-MX") -> List[Dict[str, Any]]:
    """Coerce a pasted lesson result into the list `vocab_store.upsert_lessons` takes.

    The prompt's own fields are kept verbatim -- they are the lesson. On top of that:

    - `written_explanation` is the single on-screen prose field from phase 4 onward.
      `definition` / `colloquial_notes` are still accepted and still readable (the
      viewer falls back to them via `lesson_audio.written_explanation_of`), so the
      lessons generated before phase 4 keep working without being rewritten. When
      only the old pair is present, they are NOT merged into a synthetic
      `written_explanation` here -- the fallback happens at read time, so the stored
      entry stays an honest record of what the model actually produced.
    - `spoken_explanation` is coerced to a list of segments; a single string becomes
      a one-segment list.
    - SSML is filled in mechanically (see `_fill_ssml`).
    - `description` and `usecases` are no longer written. Both were Word-Drill
      compatibility shims: `description` duplicated `definition` byte for byte, and
      `usecases` was an empty list on all 134 entries that existed when phase 4
      landed. An adapter can build `usecases` from `example_sentences` if Word Drill
      ever reads this bank.
    """
    items = parsed
    if isinstance(parsed, dict):
        try:
            items = _unwrap(parsed, ("lessons", "vocabulary", "vocab", "terms", "words", "items"), "lessons")
        except ValueError:
            # A dict keyed by term is the other natural shape a lesson prompt yields.
            if parsed and all(isinstance(v, dict) for v in parsed.values()):
                items = [{"term": k, **v} for k, v in parsed.items()]
            else:
                raise
    if not isinstance(items, list):
        raise ValueError("Expected a list of lessons.")

    out = []
    for raw in items:
        if not isinstance(raw, dict):
            continue
        lesson = dict(raw)
        term = str(lesson.get("term") or lesson.get("display") or "").strip()
        if not term:
            continue
        lesson["term"] = term
        lesson.setdefault("display", term)

        # spoken_explanation is an array of short segments so the player can put a
        # pause between them; a model that returns one string still works.
        spoken = lesson.get("spoken_explanation")
        if isinstance(spoken, str):
            spoken = [spoken]
        if isinstance(spoken, list):
            lesson["spoken_explanation"] = [str(s).strip() for s in spoken if str(s).strip()]
        elif spoken is not None:
            lesson.pop("spoken_explanation", None)

        _fill_ssml(lesson, target_locale)
        out.append(lesson)

    if not out:
        raise ValueError("No usable lessons in that paste — each one needs a 'term' field.")
    return out
