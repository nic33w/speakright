"""LingoPause pipeline, mock mode (no network, no spend).

Covers all of steps 1-5. Steps 3 and 5 run by hand in a browser chat, so what is
tested there is the copy-out block and the tolerant parsing of what gets pasted
back -- there is no LLM call in this mode to mock.

`video_source` and `transcribe` both short-circuit under MOCK_MODE, so these
tests exercise the real router, store, and parser code paths without ever
reaching YouTube.
"""
import json

import pytest

import video_store
import vocab_store
from video_source import _dedupe_rolling_captions, _parse_vtt, parse_video_id, transcript_text
from vocab_prompts import normalize_candidates, normalize_lessons, parse_pasted_json

MOCK_URL = "https://www.youtube.com/watch?v=mockVideo01"
MOCK_ID = "mockVideo01"


@pytest.fixture(autouse=True)
def clean_session():
    """Every test starts and ends with no session file for the mock video and the
    vocab bank exactly as it was, so the suite leaves the user's own
    video_sessions/ and vocab_lessons/ untouched."""
    from settings import VOCAB_LESSON_DIR

    bank = VOCAB_LESSON_DIR / "es.json"
    saved = bank.read_bytes() if bank.exists() else None

    video_store.delete_session(MOCK_ID)
    yield
    video_store.delete_session(MOCK_ID)

    if saved is None:
        if bank.exists():
            bank.unlink()
    else:
        bank.write_bytes(saved)


# --- URL parsing ---

@pytest.mark.parametrize("url", [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/watch?list=PL123&v=dQw4w9WgXcQ&t=42s",
    "dQw4w9WgXcQ",
])
def test_parse_video_id_forms(url):
    assert parse_video_id(url) == "dQw4w9WgXcQ"


@pytest.mark.parametrize("bad", ["", "   ", "https://example.com/video", "not a url"])
def test_parse_video_id_rejects_junk(bad):
    with pytest.raises(ValueError):
        parse_video_id(bad)


# --- Caption parsing ---

def test_parse_vtt_extracts_timed_cues():
    vtt = (
        "WEBVTT\n\n"
        "00:00:01.000 --> 00:00:03.500\n"
        "Hola a <c>todos</c>\n\n"
        "00:00:03.500 --> 00:00:06.000\n"
        "bienvenidos al canal\n"
    )
    segments = _parse_vtt(vtt)
    assert len(segments) == 2
    assert segments[0]["start"] == 1.0
    assert segments[0]["end"] == 3.5
    assert segments[0]["text"] == "Hola a todos"  # inline tags stripped
    assert segments[1]["start"] == 3.5


def test_dedupe_rolling_captions_collapses_scroll_in():
    """Auto-captions repeat and extend the previous line; a raw parse would count
    the same words several times over."""
    raw = [
        {"start": 0.0, "end": 1.0, "text": "lo primero"},
        {"start": 1.0, "end": 2.0, "text": "lo primero es no decir"},
        {"start": 2.0, "end": 3.0, "text": "lo primero es no decir quiero"},
        {"start": 3.0, "end": 4.0, "text": "suena grosero"},
    ]
    out = _dedupe_rolling_captions(raw)
    assert [s["text"] for s in out] == ["lo primero es no decir quiero", "suena grosero"]
    assert out[0]["start"] == 0.0 and out[0]["end"] == 3.0


def test_transcript_text_carries_timestamps():
    text = transcript_text([{"start": 95.0, "end": 101.0, "text": "Mejor di 'me da'."}])
    assert text == "[01:35] Mejor di 'me da'."
    assert transcript_text([], with_timestamps=True) == ""


# --- Ingest (steps 1-2) ---

def test_ingest_returns_metadata_chapters_and_transcript(client):
    res = client.post("/api/lingopause/ingest", json={"url": MOCK_URL, "notes": "friend's channel"})
    assert res.status_code == 200
    body = res.json()
    assert body["reused"] is False

    session = body["session"]
    assert session["video_id"] == MOCK_ID
    assert session["stage"] == "ingested"
    assert session["notes"] == "friend's channel"
    assert session["transcript_source"] == "captions"
    assert session["segment_count"] > 0
    # Chapter markers come free from the same metadata call.
    assert len(session["chapters"]) == 3
    assert session["chapters"][0]["source"] == "youtube"
    assert session["chapters"][0]["index"] == 0


def test_ingest_rejects_a_non_youtube_url(client):
    res = client.post("/api/lingopause/ingest", json={"url": "https://example.com/clip"})
    assert res.status_code == 400


def test_ingest_reuses_an_existing_session_unless_forced(client):
    first = client.post("/api/lingopause/ingest", json={"url": MOCK_URL, "notes": "original"})
    assert first.json()["reused"] is False

    second = client.post("/api/lingopause/ingest", json={"url": MOCK_URL, "notes": "ignored"})
    assert second.json()["reused"] is True
    assert second.json()["session"]["notes"] == "original"

    forced = client.post("/api/lingopause/ingest", json={"url": MOCK_URL, "notes": "redone", "force": True})
    assert forced.json()["reused"] is False
    assert forced.json()["session"]["notes"] == "redone"


def test_forced_reingest_keeps_the_confirmed_checklist(client):
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    session = video_store.load_session(MOCK_ID)
    session["candidates"] = [{"id": "c1", "term": "me regala"}, {"id": "c2", "term": "la cuenta"}]
    video_store.save_session(session)
    client.post("/api/lingopause/confirm", json={"video_id": MOCK_ID, "keep": ["c1"]})

    client.post("/api/lingopause/ingest", json={"url": MOCK_URL, "force": True})
    assert video_store.load_session(MOCK_ID)["confirmed"] == ["c1"]


# --- Session reads ---

def test_session_omits_the_transcript_unless_asked(client):
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})

    res = client.get(f"/api/lingopause/session/{MOCK_ID}")
    assert res.status_code == 200
    assert "transcript" not in res.json()

    with_transcript = client.get(f"/api/lingopause/session/{MOCK_ID}?include_transcript=true")
    assert with_transcript.json()["transcript"]["segments"]


def test_session_404s_for_an_unknown_video(client):
    assert client.get("/api/lingopause/session/neverSeen1").status_code == 404


def test_sessions_lists_the_ingested_video(client):
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    listed = client.get("/api/lingopause/sessions").json()["sessions"]
    assert any(s["video_id"] == MOCK_ID for s in listed)


# --- Confirm (step 4) ---

def test_confirm_persists_kept_ids_and_ignores_unknown_ones(client):
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    session = video_store.load_session(MOCK_ID)
    session["candidates"] = [{"id": "c1"}, {"id": "c2"}, {"id": "c3"}]
    video_store.save_session(session)

    res = client.post("/api/lingopause/confirm", json={"video_id": MOCK_ID, "keep": ["c1", "c3", "stale"]})
    assert res.status_code == 200
    body = res.json()
    assert body["confirmed"] == ["c1", "c3"]
    assert body["ignored"] == ["stale"]
    assert body["session"]["stage"] == "confirmed"
    assert video_store.load_session(MOCK_ID)["confirmed"] == ["c1", "c3"]


def test_confirm_404s_for_an_unknown_video(client):
    res = client.post("/api/lingopause/confirm", json={"video_id": "neverSeen1", "keep": []})
    assert res.status_code == 404


def test_delete_session(client):
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    assert client.delete(f"/api/lingopause/session/{MOCK_ID}").json()["deleted"] is True
    assert client.delete(f"/api/lingopause/session/{MOCK_ID}").json()["deleted"] is False


# --- Parsing what a browser chat pastes back ---

@pytest.mark.parametrize("payload", [
    '{"candidates": [{"id": "c1", "term": "me regala"}]}',
    '```json\n{"candidates": [{"id": "c1", "term": "me regala"}]}\n```',
    'Sure! Here is the JSON:\n\n```json\n{"candidates": [{"id": "c1", "term": "me regala"}]}\n```\n\nLet me know if you want more.',
])
def test_parse_pasted_json_survives_chat_wrapping(payload):
    assert parse_pasted_json(payload)["candidates"][0]["term"] == "me regala"


def test_parse_pasted_json_reads_a_bare_array():
    assert parse_pasted_json('[{"term": "la cuenta"}]')[0]["term"] == "la cuenta"


@pytest.mark.parametrize("payload", ["", "   ", "no json at all here"])
def test_parse_pasted_json_rejects_junk(payload):
    with pytest.raises(ValueError):
        parse_pasted_json(payload)


def test_parse_pasted_json_rejects_a_truncated_paste():
    with pytest.raises(ValueError):
        parse_pasted_json('{"candidates": [{"term": "me rega')


def test_normalize_candidates_maps_the_extraction_prompt_schema():
    """The prompt asks for {term, timestamp_seconds, short_gloss}; the checklist
    renders first_ts / gloss_ui."""
    out = normalize_candidates([
        {"term": "me regala", "timestamp_seconds": 95, "short_gloss": "could you give me"},
    ])
    assert out[0]["first_ts"] == 95
    assert out[0]["gloss_ui"] == "could you give me"
    assert out[0]["id"] == "c1"  # filled in — the checklist addresses terms by id


def test_kind_is_read_from_the_item_and_inferred_otherwise():
    """A construction is never inferred -- only the prompt can know that every word
    in a chunk is already familiar and it is the pattern that defeats listening."""
    out = normalize_candidates([
        {"term": "quedar"},                                        # one word -> word
        {"term": "me vale gorro"},                                 # multi-word -> phrase
        {"term": "vamos a estar subiendo", "kind": "construction"},
        {"term": "de plano", "type": "idiom"},                     # alias
    ])
    assert [c["kind"] for c in out] == ["word", "phrase", "construction", "phrase"]


def test_lesson_block_labels_non_word_items(client):
    """The lesson prompt teaches a construction differently from a word, so it has
    to be told which it is looking at."""
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    client.post("/api/lingopause/import/candidates", json={
        "video_id": MOCK_ID,
        "payload": json.dumps([
            {"term": "vamos a estar subiendo", "kind": "construction", "short_gloss": "we'll be uploading"},
            {"term": "quedar", "short_gloss": "to stay"},
        ]),
    })
    client.post("/api/lingopause/confirm", json={"video_id": MOCK_ID, "keep": ["c1", "c2"]})
    text = client.get(f"/api/lingopause/export/{MOCK_ID}?kind=lessons").json()["text"]
    assert "vamos a estar subiendo [construction]" in text
    assert "quedar [" not in text  # plain words carry no label


def test_normalize_candidates_accepts_a_timestamp_written_as_a_stamp():
    """The prompt asks for seconds, but models stamp anyway."""
    assert normalize_candidates([{"term": "x", "timestamp_seconds": "01:35"}])[0]["first_ts"] == 95
    assert normalize_candidates([{"term": "y", "timestamp_seconds": "95"}])[0]["first_ts"] == 95


def test_normalize_candidates_accepts_the_shapes_a_prompt_might_yield():
    """The prompt is hand-authored, so the wrapper key and the item shape are not
    guaranteed -- only that terms come back."""
    assert normalize_candidates(["quedar", "la cuenta"])[0]["term"] == "quedar"
    assert normalize_candidates({"vocabulary": [{"word": "quedar"}]})[0]["term"] == "quedar"
    assert normalize_candidates([{"term": "quedar"}])[0]["id"] == "c1"  # id filled in


def test_normalize_candidates_drops_duplicates_and_blanks():
    out = normalize_candidates([{"term": "quedar"}, {"term": "Quedar"}, {"term": "  "}, {"term": "listo"}])
    assert [c["term"] for c in out] == ["quedar", "listo"]


def test_normalize_candidates_rejects_a_list_with_no_terms():
    with pytest.raises(ValueError):
        normalize_candidates({"candidates": [{"gloss_ui": "to stay"}]})


def test_normalize_lessons_accepts_a_dict_keyed_by_term():
    out = normalize_lessons({"quedar": {"description": "to stay"}})
    assert out[0]["term"] == "quedar"
    assert out[0]["display"] == "quedar"


def test_normalize_lessons_keeps_the_prompt_schema_verbatim():
    """The prompt's own fields are the lesson; only `display` and mechanical SSML
    are added. `description`/`usecases` are no longer written — both were shims
    (description duplicated definition byte for byte)."""
    out = normalize_lessons([{
        "term": "me regala",
        "definition": "polite way to ask for something",
        "colloquial_notes": "very Mexican; softer than 'quiero'",
        "example_sentences": [{"target": "Me regala un cafe?", "english": "Can I get a coffee?"}],
        "video_usage": {"target_sentence": "Mejor di 'me da' o 'me regala'.",
                        "english_translation": "Better say...", "timestamp_seconds": 95},
    }])[0]
    assert out["display"] == "me regala"
    assert out["colloquial_notes"].startswith("very Mexican")
    assert out["example_sentences"][0]["target"] == "Me regala un cafe?"
    assert out["video_usage"]["timestamp_seconds"] == 95
    assert "description" not in out and "usecases" not in out


def test_normalize_lessons_fills_ssml_mechanically():
    """SSML wrapping is a pure function of text + locale, so it is done here rather
    than asked of the model — which is also what makes every pre-phase-4 lesson
    work without regeneration."""
    out = normalize_lessons([{
        "term": "me regala",
        "example_sentences": [{"target": "Me regala un cafe?", "english": "Can I get a coffee?"}],
        "video_usage": {"target_sentence": "Mejor di 'me regala'.", "timestamp_seconds": 95},
    }], target_locale="es-MX")[0]
    assert out["example_sentences"][0]["target_ssml"] == '<lang xml:lang="es-MX">Me regala un cafe?</lang>'
    assert out["video_usage"]["target_sentence_ssml"] == '<lang xml:lang="es-MX">Mejor di \'me regala\'.</lang>'


def test_normalize_lessons_never_overwrites_authored_ssml():
    out = normalize_lessons([{
        "term": "x",
        "example_sentences": [{"target": "hola", "target_ssml": "<lang xml:lang='es-ES'>hola</lang>"}],
    }])[0]
    assert out["example_sentences"][0]["target_ssml"] == "<lang xml:lang='es-ES'>hola</lang>"


def test_normalize_lessons_coerces_spoken_explanation_to_segments():
    """The player puts a pause between segments, so a single string still has to
    arrive as a list."""
    assert normalize_lessons([{"term": "x", "spoken_explanation": "One thought."}])[0]["spoken_explanation"] == ["One thought."]
    assert normalize_lessons([{"term": "x", "spoken_explanation": ["A.", " ", "B."]}])[0]["spoken_explanation"] == ["A.", "B."]


# --- Prompt template filling ---

def test_extraction_template_placeholders_are_filled(client):
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL, "notes": "food slang only"})
    text = client.get(f"/api/lingopause/export/{MOCK_ID}").json()["text"]

    assert "{transcript}" not in text and "{description}" not in text
    assert "{user_notes}" not in text and "{language}" not in text
    assert "intermediate-level learner of Spanish" in text   # {language}
    assert "food slang only" in text                          # {user_notes}
    assert "Frases basicas" in text                           # {description}
    assert "[01:35] Mejor di 'me da'" in text                 # {transcript}


def test_output_spec_braces_are_not_treated_as_placeholders(client):
    """Both templates contain literal JSON braces — `.format()` would die on them."""
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    client.post("/api/lingopause/import/candidates", json={
        "video_id": MOCK_ID, "payload": '[{"term": "me regala", "timestamp_seconds": 95}]',
    })
    client.post("/api/lingopause/confirm", json={"video_id": MOCK_ID, "keep": ["c1"]})

    text = client.get(f"/api/lingopause/export/{MOCK_ID}?kind=lessons").json()["text"]
    assert "{target, english}" in text
    assert "{target_sentence, english_translation, timestamp_seconds}" in text


def test_missing_notes_render_as_an_explicit_none(client):
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    text = client.get(f"/api/lingopause/export/{MOCK_ID}").json()["text"]
    assert "Additional context from user: (none given)" in text


def test_a_template_without_placeholders_falls_back_to_sections():
    """Keeps a hand-pasted or half-written template usable."""
    from vocab_prompts import build_extraction_block

    session = {
        "title": "T", "uploader": "U", "duration": 60, "description": "D", "notes": "N",
        "target_language": {"code": "es", "name": "Spanish"},
        "transcript": {"segments": [{"start": 0, "end": 2, "text": "hola"}]},
    }
    text = build_extraction_block(session, template="Just do the thing.")["text"]
    assert "Just do the thing." in text
    assert "### TRANSCRIPT" in text and "hola" in text
    assert "### DESCRIPTION (from YouTube)" in text


# --- Export (steps 3a / 5a) ---

def test_export_block_carries_the_video_context_and_transcript(client):
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL, "notes": "food slang only"})
    body = client.get(f"/api/lingopause/export/{MOCK_ID}").json()

    assert body["segment_count"] > 0
    assert body["approx_tokens"] > 0
    assert body["has_template"] is True
    text = body["text"]
    assert "food slang only" in text          # the learner's notes
    assert "Frases basicas" in text           # the YouTube description
    assert "[01:35]" in text                  # timestamped transcript
    assert "me regala" in text


def test_export_can_drop_timestamps(client):
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    body = client.get(f"/api/lingopause/export/{MOCK_ID}?timestamps=false").json()
    assert "[01:35]" not in body["text"]
    assert "me regala" in body["text"]


def test_lesson_export_409s_before_anything_is_confirmed(client):
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    assert client.get(f"/api/lingopause/export/{MOCK_ID}?kind=lessons").status_code == 409


def test_lesson_export_lists_confirmed_terms_with_their_video_line(client):
    """The lesson prompt asks for "the exact sentence from the transcript" but is
    not sent the transcript — the line is looked up locally at import and travels
    with the term."""
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    client.post("/api/lingopause/import/candidates", json={
        "video_id": MOCK_ID,
        "payload": json.dumps([
            {"term": "me regala", "short_gloss": "could you give me", "timestamp_seconds": 97},
            {"term": "la cuenta", "short_gloss": "the bill", "timestamp_seconds": 243},
        ]),
    })
    client.post("/api/lingopause/confirm", json={"video_id": MOCK_ID, "keep": ["c1"]})

    body = client.get(f"/api/lingopause/export/{MOCK_ID}?kind=lessons").json()
    assert body["term_count"] == 1
    text = body["text"]
    assert "me regala" in text
    assert "could you give me" in text
    assert "Mejor di 'me da' o 'me regala'" in text  # the transcript line, found by timestamp
    assert "la cuenta" not in text                    # unchecked terms are not taught
    # The whole transcript is deliberately NOT re-sent for the second prompt.
    assert "Bienvenidos a otro video" not in text


def test_import_attaches_the_surrounding_speech_to_each_candidate(client):
    """The quote is a window around where the term is actually SAID, found by
    searching the transcript — not the cue that happens to span the model's
    estimated timestamp."""
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    body = client.post("/api/lingopause/import/candidates", json={
        "video_id": MOCK_ID,
        "payload": '[{"term": "me regala", "timestamp_seconds": 97}]',
    }).json()
    quote = body["candidates"][0]["quote"]
    assert "me regala" in quote
    assert "Mejor di" in quote  # context before it survives


def test_a_term_split_across_caption_cues_is_still_found():
    """YouTube auto-captions are rolling windows: consecutive cues overlap and a
    phrase routinely straddles a boundary, so it exists in no single line."""
    from vocab_prompts import find_term_window

    segments = [
        {"start": 8.96, "end": 14.36, "text": "Vamos a jugar Mario Party Superstars, de"},
        {"start": 12.16, "end": 16.96, "text": "los mejores juegos de Switch, gey. La"},
        {"start": 14.36, "end": 19.56, "text": "neta, gey, tiene nuevo"},
    ]
    found = find_term_window(segments, "la neta")
    assert found is not None, "a phrase split across cues must still be found"
    assert "La neta" in found["quote"]
    # The timestamp is interpolated to where the word actually falls INSIDE its
    # cue, not stamped with the cue's start — a rolling cue spans ~5s, so its
    # start can be seconds before the phrase is said.
    cue = segments[1]
    assert cue["start"] < found["start"] < cue["end"]
    # And it ends after it starts, which naive next-word lookup does not guarantee
    # when cues overlap.
    assert found["end"] > found["start"]


def test_term_search_is_accent_and_punctuation_tolerant():
    from vocab_prompts import find_term_window

    segments = [{"start": 0.0, "end": 5.0, "text": "Oye, ¿cómo ves? Cállate."}]
    assert find_term_window(segments, "como ves") is not None
    assert find_term_window(segments, "¿Cómo ves?") is not None
    assert find_term_window(segments, "nunca dicho") is None


def test_quote_falls_back_to_a_timestamp_window_when_the_term_is_absent():
    """A paraphrased term, or one the captions spell differently, still gets
    context — just centred on the model's timestamp instead."""
    from vocab_prompts import quote_for_timestamp

    segments = [
        {"start": 0.0, "end": 5.0, "text": "uno dos tres cuatro cinco"},
        {"start": 5.0, "end": 10.0, "text": "seis siete ocho nueve diez"},
    ]
    quote = quote_for_timestamp(segments, 6, "no aparece")
    assert quote and "siete" in quote


def test_transcript_txt_returns_the_bare_subs(client):
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    res = client.get(f"/api/lingopause/transcript/{MOCK_ID}.txt")
    assert res.status_code == 200
    assert "me regala" in res.text
    assert res.text.startswith("[00:00]")


def test_export_404s_for_an_unknown_video(client):
    assert client.get("/api/lingopause/export/neverSeen1").status_code == 404


# --- Import (steps 3b / 5b) ---

def test_import_candidates_stores_them_and_advances_the_stage(client):
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    res = client.post("/api/lingopause/import/candidates", json={
        "video_id": MOCK_ID,
        "payload": '```json\n{"candidates": [{"term": "me regala"}, {"term": "la cuenta"}]}\n```',
    })
    assert res.status_code == 200
    body = res.json()
    assert body["count"] == 2
    assert body["session"]["stage"] == "extracted"
    assert video_store.load_session(MOCK_ID)["candidates"][0]["term"] == "me regala"


def test_reimporting_candidates_clears_a_stale_confirmed_list(client):
    """Old ids referred to the old list, so keeping them would silently select the
    wrong terms."""
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    client.post("/api/lingopause/import/candidates", json={
        "video_id": MOCK_ID, "payload": '[{"id": "c1", "term": "quedar"}]',
    })
    client.post("/api/lingopause/confirm", json={"video_id": MOCK_ID, "keep": ["c1"]})
    assert video_store.load_session(MOCK_ID)["confirmed"] == ["c1"]

    client.post("/api/lingopause/import/candidates", json={
        "video_id": MOCK_ID, "payload": '[{"id": "c1", "term": "la cuenta"}]',
    })
    assert video_store.load_session(MOCK_ID)["confirmed"] == []


def test_import_candidates_422s_on_an_unusable_paste(client):
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    res = client.post("/api/lingopause/import/candidates", json={
        "video_id": MOCK_ID, "payload": "the model just replied in prose",
    })
    assert res.status_code == 422
    assert "JSON" in res.json()["detail"]


def test_import_lessons_writes_the_vocab_bank(client):
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    payload = json.dumps({"lessons": [{
        "term": "me regala",
        "description": "polite way to ask for something",
        "usecases": [{"name": "Ordering", "demo": {"context": "at a taqueria", "native": "Can I get a coffee?", "target": "Me regala un cafe?"}}],
    }]})
    res = client.post("/api/lingopause/import/lessons", json={"video_id": MOCK_ID, "payload": payload})
    assert res.status_code == 200
    body = res.json()
    assert body["count"] == 1
    assert body["bank"]["added"] == 1
    assert body["session"]["stage"] == "lessons_ready"

    lesson = vocab_store.get_lesson("es", "Me Regala")  # bank key is case-insensitive
    assert lesson["description"] == "polite way to ask for something"
    assert lesson["sources"][0] == {
        "kind": "video", "video_id": MOCK_ID, "title": "[mock] Como pedir en un restaurante en Mexico",
    }


def test_lessons_endpoint_reads_back_what_this_video_contributed(client):
    """Tab 3 renders from here — without it the pipeline ends in a JSON file
    nothing displays."""
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    client.post("/api/lingopause/import/lessons", json={
        "video_id": MOCK_ID,
        "payload": json.dumps([
            {"term": "la cuenta", "definition": "the bill"},
            {"term": "me regala", "definition": "polite ask",
             "example_sentences": [{"target": "Me regala un cafe?", "english": "Can I get a coffee?"}]},
        ]),
    })

    body = client.get(f"/api/lingopause/lessons/{MOCK_ID}").json()
    assert body["count"] == 2
    assert [l["term"] for l in body["lessons"]] == ["la cuenta", "me regala"]  # sorted
    assert body["lessons"][1]["example_sentences"][0]["target"] == "Me regala un cafe?"
    # bank_stats counts the whole per-language bank, which in a real run already
    # holds terms from other videos -- so this is a floor, not an equality.
    assert body["bank_stats"]["from_video"] >= 2


def test_lessons_endpoint_excludes_terms_from_other_videos(client):
    """The bank is shared across videos; this view is per-video."""
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    vocab_store.upsert_lessons("es", [{"term": "from elsewhere", "definition": "x"}],
                               source={"kind": "video", "video_id": "otherVideo1"})
    client.post("/api/lingopause/import/lessons", json={
        "video_id": MOCK_ID, "payload": '[{"term": "me regala", "definition": "polite ask"}]',
    })
    terms = [l["term"] for l in client.get(f"/api/lingopause/lessons/{MOCK_ID}").json()["lessons"]]
    assert terms == ["me regala"]


# --- Context notes stay editable ---

def test_notes_can_be_updated_without_reingesting(client):
    """Both prompts read the notes, and the learner usually only works out what
    they want from a video after seeing what is in it."""
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL, "notes": "first pass"})
    res = client.post("/api/lingopause/notes", json={"video_id": MOCK_ID, "notes": "actually, just the slang"})
    assert res.status_code == 200
    assert res.json()["session"]["notes"] == "actually, just the slang"
    # And it reaches the prompt.
    assert "actually, just the slang" in client.get(f"/api/lingopause/export/{MOCK_ID}").json()["text"]
    # Without discarding the transcript.
    assert res.json()["session"]["segment_count"] > 0


def test_notes_404s_for_an_unknown_video(client):
    assert client.post("/api/lingopause/notes", json={"video_id": "neverSeen1", "notes": "x"}).status_code == 404


def test_ingest_reports_a_thumbnail(client):
    body = client.post("/api/lingopause/ingest", json={"url": MOCK_URL}).json()
    assert body["session"]["thumbnail"] == f"https://i.ytimg.com/vi/{MOCK_ID}/hqdefault.jpg"


# --- Phase 4: the lesson viewer ---

def _seed_lesson(client, kind="construction"):
    """A confirmed item with lesson content, ready for the viewer."""
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    client.post("/api/lingopause/import/candidates", json={
        "video_id": MOCK_ID,
        "payload": json.dumps([{
            "term": "vamos a estar subiendo", "kind": kind,
            "short_gloss": "we'll be uploading", "timestamp_seconds": 97,
        }]),
    })
    client.post("/api/lingopause/confirm", json={"video_id": MOCK_ID, "keep": ["c1"]})
    client.post("/api/lingopause/import/lessons", json={
        "video_id": MOCK_ID,
        "payload": json.dumps([{
            "term": "vamos a estar subiendo",
            "notes": ["Listen for three verbs in a row.", "The last one ends in -ndo."],
            "example_sentences": [{"target": "Vamos a estar comiendo.", "english": "We'll be eating."}],
            "video_usage": {"target_sentence": "vamos a estar subiendo cada semana",
                            "english_translation": "we'll be uploading every week",
                            "timestamp_seconds": 97},
        }]),
    })


def test_import_lessons_stamps_kind_from_the_confirmed_candidate(client):
    """kind belongs to the candidate, where the extraction prompt set it. Leaving it
    to the lesson model to echo back is why only 49 of 134 entries had one."""
    _seed_lesson(client, kind="construction")
    lesson = vocab_store.get_lesson("es", "vamos a estar subiendo")
    assert lesson["kind"] == "construction"
    assert lesson["first_ts"] == 97
    assert lesson["quote"]  # the transcript line came across too






def test_term_occurrences_are_marked_in_unmarked_prose():
    """A narrow, always-safe fallback for pre-marking lessons: the term itself is
    definitely the target language wherever it is quoted."""
    from lesson_audio import mark_term_occurrences

    assert mark_term_occurrences("You say la neta a lot.", "la neta") == "You say [[la neta]] a lot."
    # Case-insensitive, but never doubles up on already-marked text.
    assert mark_term_occurrences("La Neta means honestly.", "la neta") == "[[La Neta]] means honestly."
    assert mark_term_occurrences("Already [[la neta]] here.", "la neta") == "Already [[la neta]] here."
    # Substrings of longer words are left alone.
    assert mark_term_occurrences("unnetalike", "neta") == "unnetalike"
    assert mark_term_occurrences("text", "") == "text"



def test_stitched_audio_rebases_word_timings_across_the_seams(client):
    """Offsets must stay monotonic across voice changes or the replay highlight
    jumps backwards mid-sentence."""
    res = client.post("/api/lingopause/audio", json={
        "runs": [
            {"text": "There's a little", "locale": "en-US", "voice": "en-US-RyanMultilingualNeural"},
            {"text": "se", "locale": "es-MX", "voice": "es-MX-LucianoNeural"},
            {"text": "in front.", "locale": "en-US", "voice": "en-US-RyanMultilingualNeural"},
        ],
    })
    assert res.status_code == 200
    words = res.json()["words"]
    assert [w["text"] for w in words] == ["There's", "a", "little", "se", "in", "front."]
    offsets = [w["offsetMs"] for w in words]
    assert offsets == sorted(offsets), "word offsets must not go backwards at a seam"
    assert offsets[3] > offsets[2], "the run boundary must advance the timeline"


def test_stitched_audio_caches_per_run_set(client):
    """The cache key describes every run, so changing one voice or one word is a
    different entry rather than a stale mix."""
    runs = [
        {"text": "hello", "locale": "en-US", "voice": "en-US-RyanMultilingualNeural"},
        {"text": "hola", "locale": "es-MX", "voice": "es-MX-LucianoNeural"},
    ]
    first = client.post("/api/lingopause/audio", json={"runs": runs}).json()
    second = client.post("/api/lingopause/audio", json={"runs": runs}).json()
    assert second["cached"] is True and second["audio_file"] == first["audio_file"]

    changed = client.post("/api/lingopause/audio", json={
        "runs": [runs[0], {**runs[1], "voice": "es-MX-DaliaNeural"}],
    }).json()
    assert changed["audio_file"] != first["audio_file"]


def test_split_language_runs_merges_and_trims():
    from tts_helpers import has_span_markers, split_language_runs, strip_span_markers

    assert has_span_markers("a [[b]] c") is True
    assert has_span_markers("no markers") is False
    assert strip_span_markers("a [[b]] c") == "a b c"
    # Adjacent same-language stretches merge — every extra run is another request
    # and another seam.
    runs = split_language_runs("[[uno]] [[dos]] then English", "es-MX")
    assert [(r["locale"], r["text"]) for r in runs] == [
        ("es-MX", "uno dos"), ("en-US", "then English"),
    ]
    assert split_language_runs("", "es-MX") == []





def test_blocks_are_laid_out_as_the_viewer_renders_them(client):
    """Example 1 is the video's own line, then the notes, then fresh examples,
    then the clip — the learner meets the phrase where they will actually hear it."""
    _seed_lesson(client)
    item = client.get(f"/api/lingopause/beats/{MOCK_ID}").json()["items"][0]
    blocks = item["blocks"]

    assert [b["kind"] for b in blocks] == ["example", "notes", "example", "video"]
    assert [b["label"] for b in blocks if b["kind"] == "example"] == ["Example 1", "Example 2"]

    first = blocks[0]
    assert first["from_video"] is True
    assert first["pairs"][0]["english"] == "we'll be uploading every week"
    assert first["pairs"][0]["target"] == "vamos a estar subiendo cada semana"
    # Fresh examples are not from the video.
    assert blocks[2]["from_video"] is False
    assert blocks[-1]["timestamp_seconds"] == 97


def test_a_multi_sentence_video_line_is_paired_sentence_by_sentence():
    """Heard as one blob, a three-sentence line is much harder than hearing each
    sentence against its own translation."""
    from lesson_audio import pair_sentences

    pairs = pair_sentences(
        "I won. The star is going to fall there. Hey, you already know the drill.",
        "Yo gane. Ahi se va a caer la estrella. Oigan, ya se la saben.",
    )
    assert [p["english"] for p in pairs] == [
        "I won.", "The star is going to fall there.", "Hey, you already know the drill.",
    ]
    assert pairs[2]["target"] == "Oigan, ya se la saben."


def test_uneven_sentence_counts_are_left_as_one_pair():
    """A translation that merged or split a sentence cannot be aligned, and
    guessing would put the wrong English against the wrong Spanish."""
    from lesson_audio import pair_sentences

    pairs = pair_sentences("One sentence only.", "Dos. Frases aqui.")
    assert len(pairs) == 1
    assert pairs[0]["english"] == "One sentence only."


def test_the_focus_pair_is_the_one_containing_the_phrase(client):
    """The taught sentence is the point of the slide; the rest is context."""
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    client.post("/api/lingopause/import/candidates", json={
        "video_id": MOCK_ID, "payload": '[{"term": "ya se la saben", "timestamp_seconds": 97}]',
    })
    client.post("/api/lingopause/confirm", json={"video_id": MOCK_ID, "keep": ["c1"]})
    client.post("/api/lingopause/import/lessons", json={
        "video_id": MOCK_ID,
        "payload": json.dumps([{
            "term": "ya se la saben",
            "notes": ["Filler emphasis."],
            "video_usage": {
                "english_translation": "I won. The star falls there. Hey, you already know the drill.",
                "target_sentence": "Yo gane. Ahi se cae la estrella. Oigan, ya se la saben.",
                "timestamp_seconds": 97,
            },
        }]),
    })
    pairs = client.get(f"/api/lingopause/beats/{MOCK_ID}").json()["items"][0]["blocks"][0]["pairs"]
    assert [p["is_focus"] for p in pairs] == [False, False, True]
    # Every pair still gets both beats — context is heard, just not emphasised.
    assert all(p["en_beat"] and p["tg_beat"] for p in pairs)


def test_notes_are_the_only_explanation(client):
    """Bullets, one beat each, spoken with a pause between — not prose read aloud."""
    _seed_lesson(client)
    notes = next(b for b in client.get(f"/api/lingopause/beats/{MOCK_ID}").json()["items"][0]["blocks"]
                 if b["kind"] == "notes")
    assert notes["notes"] == ["Listen for three verbs in a row.", "The last one ends in -ndo."]
    assert [b["role"] for b in notes["beats"]] == ["note", "note"]
    assert notes["derived"] is False


def test_each_beat_uses_the_app_voice_for_its_own_language(client):
    """Voices come from VOICE_MAP, so a lesson sounds like every other mode."""
    from settings import UI_LOCALE, VOICE_MAP

    _seed_lesson(client)
    blocks = client.get(f"/api/lingopause/beats/{MOCK_ID}").json()["items"][0]["blocks"]
    beats = {b["role"]: b for blk in blocks for b in blk["beats"]}

    assert beats["example_target"]["locale"] == "es-MX"
    assert beats["example_target"]["voice"] == VOICE_MAP["es-MX"]
    assert beats["example_en"]["locale"] == UI_LOCALE
    assert beats["example_en"]["voice"] == VOICE_MAP[UI_LOCALE]
    # An unmarked note is English prose with unfindable target words in it, so the
    # whole line takes the target voice rather than mangling the words being taught.
    assert beats["note"]["voice"] == VOICE_MAP["es-MX"]


def test_marked_notes_split_into_per_language_runs(client):
    """Target words marked [[like this]] take the target voice; the English around
    them keeps the English voice, and the clips are stitched."""
    from settings import UI_LOCALE, VOICE_MAP

    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    client.post("/api/lingopause/import/candidates", json={
        "video_id": MOCK_ID, "payload": '[{"term": "se me olvido", "timestamp_seconds": 97}]',
    })
    client.post("/api/lingopause/confirm", json={"video_id": MOCK_ID, "keep": ["c1"]})
    client.post("/api/lingopause/import/lessons", json={
        "video_id": MOCK_ID,
        "payload": json.dumps([{
            "term": "se me olvido",
            "notes": ["The [[se]] says it happened by itself."],
            "video_usage": {"target_sentence": "se me olvido", "english_translation": "I forgot",
                            "timestamp_seconds": 97},
        }]),
    })

    notes = next(b for b in client.get(f"/api/lingopause/beats/{MOCK_ID}").json()["items"][0]["blocks"]
                 if b["kind"] == "notes")
    # Markers never reach the screen.
    assert notes["notes"] == ["The se says it happened by itself."]
    beat = notes["beats"][0]
    assert "[[" not in beat["text"]
    assert [(r["locale"], r["text"]) for r in beat["runs"]] == [
        (UI_LOCALE, "The"), ("es-MX", "se"), (UI_LOCALE, "says it happened by itself."),
    ]
    assert beat["runs"][1]["voice"] == VOICE_MAP["es-MX"]


def test_notes_fall_back_for_lessons_written_before_the_notes_format(client):
    """The bank predates bullets; those lessons still have to play."""
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    client.post("/api/lingopause/import/candidates", json={
        "video_id": MOCK_ID, "payload": '[{"term": "riata", "timestamp_seconds": 51}]',
    })
    client.post("/api/lingopause/confirm", json={"video_id": MOCK_ID, "keep": ["c1"]})
    client.post("/api/lingopause/import/lessons", json={
        "video_id": MOCK_ID,
        "payload": json.dumps([{
            "term": "riata",
            "definition": "Rope. Colloquially, a bunch of amateurs.",
            "colloquial_notes": "Mexican slang. Often self-deprecating.",
            "video_usage": {"target_sentence": "somos una riata", "english_translation": "we're amateurs",
                            "timestamp_seconds": 51},
        }]),
    })
    item = client.get(f"/api/lingopause/beats/{MOCK_ID}").json()["items"][0]
    assert item["derived_audio"] is True
    notes = next(b for b in item["blocks"] if b["kind"] == "notes")
    assert notes["derived"] is True
    assert any("amateurs" in n for n in notes["notes"])
    assert any("Mexican slang" in n for n in notes["notes"])  # both old fields are used
    assert len(notes["notes"]) <= 4  # capped, or a long explanation becomes eight bullets


def test_no_markup_reaches_the_learner(client):
    _seed_lesson(client)
    blocks = client.get(f"/api/lingopause/beats/{MOCK_ID}").json()["items"][0]["blocks"]
    for block in blocks:
        texts = [*(block.get("notes") or [])]
        for pair in block.get("pairs") or []:
            texts += [pair["english"], pair["target"]]
        for text in texts:
            assert "[[" not in (text or "")
        for beat in block["beats"]:
            assert "[[" not in beat["text"] and "<lang" not in beat["text"]

def test_lesson_audio_returns_word_timings(client):
    _seed_lesson(client)
    blocks = client.get(f"/api/lingopause/beats/{MOCK_ID}").json()["items"][0]["blocks"]
    beat = next(b for blk in blocks for b in blk["beats"] if b["role"] == "example_target")
    res = client.post("/api/lingopause/audio", json={
        "text": beat["text"], "locale": beat["locale"], "voice": beat["voice"], "with_timings": True,
    })
    assert res.status_code == 200
    body = res.json()
    assert body["audio_file"]
    assert len(body["words"]) == len(beat["text"].split())
    assert body["words"][0]["offsetMs"] == 0
    assert all("text" in w and "durationMs" in w for w in body["words"])


def test_lesson_audio_caches_and_rejects_empty(client):
    first = client.post("/api/lingopause/audio", json={"text": "hola mundo", "with_timings": True}).json()
    second = client.post("/api/lingopause/audio", json={"text": "hola mundo", "with_timings": True}).json()
    assert second["cached"] is True
    assert second["audio_file"] == first["audio_file"]
    assert second["words"] == first["words"]
    assert client.post("/api/lingopause/audio", json={"text": "   "}).status_code == 400


def test_progress_marks_an_item_viewed(client):
    _seed_lesson(client)
    res = client.post("/api/lingopause/progress", json={"video_id": MOCK_ID, "candidate_id": "c1"})
    assert res.json() == {"viewed": ["c1"], "viewed_count": 1}
    assert client.get(f"/api/lingopause/beats/{MOCK_ID}").json()["items"][0]["viewed"] is True

    # Idempotent, and reversible.
    client.post("/api/lingopause/progress", json={"video_id": MOCK_ID, "candidate_id": "c1"})
    assert video_store.load_session(MOCK_ID)["viewed"] == ["c1"]
    client.post("/api/lingopause/progress", json={"video_id": MOCK_ID, "candidate_id": "c1", "viewed": False})
    assert video_store.load_session(MOCK_ID)["viewed"] == []


def test_ask_answers_with_transcript_context(client):
    _seed_lesson(client)
    res = client.post("/api/lingopause/ask", json={
        "video_id": MOCK_ID, "term": "vamos a estar subiendo", "question": "why three verbs?",
    })
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert "vamos a estar subiendo" in body["answer"]  # mock echoes the term


def test_ask_validates_its_inputs(client):
    _seed_lesson(client)
    assert client.post("/api/lingopause/ask", json={"video_id": MOCK_ID, "term": "x", "question": "  "}).status_code == 400
    assert client.post("/api/lingopause/ask", json={"video_id": "neverSeen1", "term": "x", "question": "y"}).status_code == 404


def test_phase_4_endpoints_404_for_an_unknown_video(client):
    assert client.get("/api/lingopause/beats/neverSeen1").status_code == 404
    assert client.post("/api/lingopause/progress", json={"video_id": "neverSeen1", "candidate_id": "c1"}).status_code == 404


def test_reimporting_an_equivalent_lesson_keeps_the_reviewed_content(client):
    """A term reappearing in a second video is evidence it matters, not a reason to
    overwrite an explanation that was already read."""
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    client.post("/api/lingopause/import/lessons", json={
        "video_id": MOCK_ID, "payload": '[{"term": "me regala", "definition": "original"}]',
    })
    res = client.post("/api/lingopause/import/lessons", json={
        "video_id": MOCK_ID, "payload": '[{"term": "me regala", "definition": "rewritten"}]',
    })
    assert res.json()["bank"] == {"added": 0, "upgraded": 0, "kept": 1}
    assert vocab_store.get_lesson("es", "me regala")["definition"] == "original"


def test_a_richer_lesson_upgrades_a_pre_phase_4_entry(client):
    """How a bank full of pre-phase-4 lessons gets upgraded: re-run the prompt and
    re-import. An incoming lesson carrying written/spoken explanations replaces one
    that has neither — no flag needed."""
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    client.post("/api/lingopause/import/lessons", json={
        "video_id": MOCK_ID,
        "payload": '[{"term": "me regala", "definition": "old style", "colloquial_notes": "n"}]',
    })
    res = client.post("/api/lingopause/import/lessons", json={
        "video_id": MOCK_ID,
        "payload": json.dumps([{
            "term": "me regala",
            "written_explanation": "New style breakdown.",
            "spoken_explanation": ["Listen for the me."],
        }]),
    })
    assert res.json()["bank"] == {"added": 0, "upgraded": 1, "kept": 0}

    lesson = vocab_store.get_lesson("es", "me regala")
    assert lesson["written_explanation"] == "New style breakdown."
    assert lesson["spoken_explanation"] == ["Listen for the me."]
    assert "definition" not in lesson          # replaced, not merged
    assert lesson["sources"][0]["video_id"] == MOCK_ID  # history preserved
    assert lesson["created_at"]


def test_upgrade_never_downgrades(client):
    """An older-style lesson must not clobber one already at the newer standard."""
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    client.post("/api/lingopause/import/lessons", json={
        "video_id": MOCK_ID,
        "payload": '[{"term": "me regala", "written_explanation": "good", "spoken_explanation": ["a"]}]',
    })
    res = client.post("/api/lingopause/import/lessons", json={
        "video_id": MOCK_ID, "payload": '[{"term": "me regala", "definition": "old"}]',
    })
    assert res.json()["bank"]["kept"] == 1
    assert vocab_store.get_lesson("es", "me regala")["written_explanation"] == "good"


def test_replace_forces_an_overwrite(client):
    """The explicit escape hatch, for regenerating content that is not obviously
    richer."""
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    client.post("/api/lingopause/import/lessons", json={
        "video_id": MOCK_ID, "payload": '[{"term": "me regala", "definition": "first"}]',
    })
    res = client.post("/api/lingopause/import/lessons", json={
        "video_id": MOCK_ID, "payload": '[{"term": "me regala", "definition": "second"}]',
        "replace": True,
    })
    assert res.json()["bank"]["upgraded"] == 1
    assert vocab_store.get_lesson("es", "me regala")["definition"] == "second"


# --- Lesson-block batching ---

def test_lesson_block_is_batched(client):
    """The input would fit in one go; the OUTPUT would not — 100+ full lessons
    truncate mid-JSON in a single chat reply."""
    client.post("/api/lingopause/ingest", json={"url": MOCK_URL})
    payload = json.dumps([{"term": f"term {i}", "timestamp_seconds": i} for i in range(60)])
    client.post("/api/lingopause/import/candidates", json={"video_id": MOCK_ID, "payload": payload})
    client.post("/api/lingopause/confirm", json={
        "video_id": MOCK_ID, "keep": [f"c{i}" for i in range(1, 61)],
    })

    first = client.get(f"/api/lingopause/export/{MOCK_ID}?kind=lessons").json()
    assert first["total_terms"] == 60
    assert first["term_count"] == 25
    assert (first["batch_index"], first["batch_count"]) == (1, 3)
    assert first["next_offset"] == 25
    assert "term 0" in first["text"] and "term 30" not in first["text"]

    last = client.get(f"/api/lingopause/export/{MOCK_ID}?kind=lessons&offset=50").json()
    assert (last["batch_index"], last["term_count"]) == (3, 10)
    assert last["next_offset"] is None

    custom = client.get(f"/api/lingopause/export/{MOCK_ID}?kind=lessons&limit=10").json()
    assert custom["batch_count"] == 6 and custom["term_count"] == 10
