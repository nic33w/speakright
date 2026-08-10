"""Task 3.11: split messenger response chunks into one sentence each, server-side.

The prompt already says "Keep each chunk to ONE spoken sentence" and the model
doesn't reliably obey, so this is enforced deterministically in
routers/messenger.py before TTS. Tested directly per the task's own "Watch
for": trust a narrow, tested splitter over a general-purpose regex.
"""
import json

from routers.messenger import (
    MIN_SENTENCE_WORDS,
    _merge_short_fragments,
    _split_chunk_into_sentences,
    _split_into_sentences,
    _prepare_chunks,
)


# --- _split_into_sentences ---------------------------------------------------

def test_splits_on_period_question_and_exclamation():
    assert _split_into_sentences("Fui al mercado. ¿Qué compraste? ¡Qué bien!") == [
        "Fui al mercado.", "¿Qué compraste?", "¡Qué bien!",
    ]


def test_single_sentence_is_not_split():
    assert _split_into_sentences("Vamos al parque mañana.") == ["Vamos al parque mañana."]


def test_decimal_is_not_split():
    """No whitespace after the period in a decimal, so the boundary regex
    never matches there — no special-casing needed."""
    assert _split_into_sentences("Cuesta 3.50 pesos.") == ["Cuesta 3.50 pesos."]


def test_abbreviation_is_not_split():
    out = _split_into_sentences("El Sr. García llegó tarde.")
    assert out == ["El Sr. García llegó tarde."]


def test_ellipsis_still_splits():
    out = _split_into_sentences("Espera... ya voy.")
    assert len(out) == 2


def test_empty_text():
    assert _split_into_sentences("") == []


# --- _merge_short_fragments ---------------------------------------------------

def test_short_trailing_fragment_merges_into_previous():
    out = _merge_short_fragments(["Fui al mercado ayer.", "¿En serio?"])
    assert out == ["Fui al mercado ayer. ¿En serio?"]


def test_short_leading_fragment_merges_into_next():
    out = _merge_short_fragments(["¿En serio?", "Yo también fui al mercado ayer."])
    assert out == ["¿En serio? Yo también fui al mercado ayer."]


def test_long_fragments_are_left_alone():
    sentences = ["Fui al mercado y compré fruta.", "¿Qué compraste tú esta vez?"]
    assert _merge_short_fragments(sentences) == sentences


def test_run_of_short_fragments_collapses_fully():
    out = _merge_short_fragments(["Vale.", "Ya sé.", "¿En serio, de verdad?"])
    assert len(out) == 1
    assert all(len(s.split()) for s in out)


def test_single_short_sentence_has_no_neighbour_to_merge_into():
    assert _merge_short_fragments(["Vale."]) == ["Vale."]


def test_min_sentence_words_is_four():
    assert MIN_SENTENCE_WORDS == 4


# --- _split_chunk_into_sentences ---------------------------------------------

def _chunk(text, **overrides):
    base = {"text": text, "language": "target", "modality": "audio", "locale": "es-MX"}
    base.update(overrides)
    return base


def test_non_audio_chunk_is_untouched():
    chunk = _chunk("Fui al mercado. ¿Qué compraste?", modality="text", language="ui")
    assert _split_chunk_into_sentences(chunk) == [chunk]


def test_ui_language_audio_chunk_is_untouched():
    chunk = _chunk("Fui al mercado. ¿Qué compraste?", language="ui")
    assert _split_chunk_into_sentences(chunk) == [chunk]


def test_target_audio_chunk_splits_into_sentences():
    chunk = _chunk("Fui al mercado ayer. ¿Qué compraste tú esta vez?")
    pieces = _split_chunk_into_sentences(chunk)
    assert len(pieces) == 2
    assert pieces[0]["text"] == "Fui al mercado ayer."
    assert pieces[1]["text"] == "¿Qué compraste tú esta vez?"
    # locale/language/modality carry over onto every piece
    for piece in pieces:
        assert piece["language"] == "target"
        assert piece["modality"] == "audio"
        assert piece["locale"] == "es-MX"


def test_single_sentence_chunk_is_returned_unchanged_object():
    chunk = _chunk("Vamos al parque mañana.")
    pieces = _split_chunk_into_sentences(chunk)
    assert pieces == [chunk]
    assert pieces[0] is chunk


def test_challenge_flag_moves_to_last_piece_and_native_text_is_dropped():
    chunk = _chunk(
        "Fui al mercado ayer. ¿Qué compraste tú esta vez?",
        native_text="I went to the market yesterday. What did you buy this time?",
        is_challenge=True,
    )
    pieces = _split_chunk_into_sentences(chunk)
    assert len(pieces) == 2
    assert "native_text" not in pieces[0]
    assert "native_text" not in pieces[1]
    assert not pieces[0].get("is_challenge")
    assert pieces[1]["is_challenge"] is True


def test_unsplit_challenge_chunk_keeps_native_text():
    """One sentence == the whole chunk, so nothing is lost by keeping it."""
    chunk = _chunk(
        "¿Cuándo empezaste a aprender español?",
        native_text="When did you start learning Spanish?",
        is_challenge=True,
    )
    pieces = _split_chunk_into_sentences(chunk)
    assert pieces == [chunk]


# --- _prepare_chunks (index-0 exemption, TRAP 1) -----------------------------

def test_chunk_zero_is_never_split_even_with_multiple_sentences():
    """The reaction opener is matched verbatim against the pre-generated bank —
    splitting or altering it breaks that match (TASKS.md task 3.11 TRAP 1)."""
    chunks = [
        _chunk("¡Ah, qué bien! ¡Qué emoción!", purpose="reaction"),
        _chunk("Fui al mercado ayer. ¿Qué compraste tú esta vez?"),
    ]
    chunk_dicts, _ = _prepare_chunks(chunks, "es")
    assert chunk_dicts[0]["text"] == "¡Ah, qué bien! ¡Qué emoción!"
    # chunk 1 still gets split into its two sentences
    assert [c["text"] for c in chunk_dicts[1:]] == [
        "Fui al mercado ayer.", "¿Qué compraste tú esta vez?",
    ]


def test_prepare_chunks_order_is_preserved_across_a_split():
    chunks = [
        _chunk("¡Ah, qué bien!", purpose="reaction"),
        _chunk("Oye, escúchame bien ahora. ¿Qué pasó después de eso? ¿Y luego qué hiciste tú?"),
    ]
    chunk_dicts, _ = _prepare_chunks(chunks, "es")
    assert [c["text"] for c in chunk_dicts] == [
        "¡Ah, qué bien!",
        "Oye, escúchame bien ahora.",
        "¿Qué pasó después de eso?",
        "¿Y luego qué hiciste tú?",
    ]


# --- End-to-end through the live endpoints (mock LLM, real split/TTS wiring) --

MULTI_SENTENCE_MOCK = {
    "corrected_input": "hola",
    "had_errors": False,
    "error_severity": "none",
    "error_explanation": "",
    "input_intent": "spanish",
    "response_chunks": [
        {"text": "¡Ah, qué bien!", "language": "target", "modality": "audio",
         "locale": "es-MX", "purpose": "reaction"},
        {"text": "Oye, escúchame bien ahora. ¿Qué pasó después de eso?",
         "language": "target", "modality": "audio", "locale": "es-MX", "purpose": "question"},
    ],
    "quiz_candidates": [],
    "level_assessment": {},
}


def test_turn_endpoint_splits_a_multi_sentence_mock_reply(client, monkeypatch):
    from routers import messenger as messenger_router

    monkeypatch.setattr(messenger_router, "_mock_llm_response",
                         lambda req, profile, version="v1": MULTI_SENTENCE_MOCK)
    r = client.post("/api/messenger/turn", json={
        "user_input": "hola",
        "session_id": "pytest_split_buffered",
        "prompt_version": "v1",
    })
    assert r.status_code == 200
    texts = [c["text"] for c in r.json()["response_chunks"]]
    assert texts == [
        "¡Ah, qué bien!",  # chunk 0 never splits (TRAP 1)
        "Oye, escúchame bien ahora.",
        "¿Qué pasó después de eso?",
    ]


def test_stream_endpoint_splits_a_multi_sentence_mock_reply(client, monkeypatch):
    from routers import messenger as messenger_router

    monkeypatch.setattr(messenger_router, "_mock_llm_response",
                         lambda req, profile, version="v1": MULTI_SENTENCE_MOCK)
    r = client.post("/api/messenger/turn/stream", json={
        "user_input": "hola",
        "session_id": "pytest_split_stream",
        "prompt_version": "v1",
    })
    assert r.status_code == 200
    events = [json.loads(line) for line in r.text.splitlines() if line.strip()]
    chunk_events = [e for e in events if e["type"] == "chunk"]
    assert [e["chunk"]["text"] for e in chunk_events] == [
        "¡Ah, qué bien!",
        "Oye, escúchame bien ahora.",
        "¿Qué pasó después de eso?",
    ]
    # indices stay contiguous across the split, matching the final payload
    assert [e["index"] for e in chunk_events] == [0, 1, 2]
    final = events[-1]
    assert final["type"] == "final"
    assert [c["text"] for c in final["response_chunks"]] == \
           [e["chunk"]["text"] for e in chunk_events]
