"""Unit tests for StreamingArrayScanner (llm_call).

The scanner pulls complete `response_chunks` objects out of a JSON document that
is still streaming, so bubble 1 can render before the model has written the
corrections and suggestions that follow it. Network deltas split at arbitrary
byte offsets, so the invariant under test is: the objects recovered must not
depend on where the chunk boundaries fall.
"""
import json

import pytest

from llm_call import StreamingArrayScanner

# Deliberately awkward: escaped quotes, braces and brackets inside strings,
# non-ASCII, and a nested object after the array.
DOC = {
    "response_chunks": [
        {"text": "Oh no, that's rough.", "language": "ui", "modality": "text"},
        {
            "text": 'Dijo "hola" y {se fue} [rapido]',
            "language": "target",
            "modality": "audio",
            "locale": "es-MX",
            "native_text": "He said \"hi\" and left",
            "is_challenge": True,
        },
    ],
    "corrected_input": "Fui a la tienda",
    "had_errors": True,
    "error_explanation": "Brackets ] and braces } inside a string",
    "input_intent": "spanish",
    "suggested_replies": [{"id": "r1", "text_target": "No sé", "text_native": "I don't know"}],
    "level_assessment": {},
}
TEXT = json.dumps(DOC, ensure_ascii=False)


@pytest.mark.parametrize("size", [1, 2, 3, 5, 13, 64, 512, len(TEXT)])
def test_recovers_chunks_at_any_delta_boundary(size):
    scanner = StreamingArrayScanner("response_chunks")
    got = []
    for i in range(0, len(TEXT), size):
        got.extend(scanner.feed(TEXT[i:i + size]))

    assert got == DOC["response_chunks"]
    assert scanner.done, "array close was not detected"
    assert scanner.text == TEXT, "scanner must retain the full document for final parse"


def test_chunks_arrive_before_the_document_completes():
    """The whole point: bubble 1 is usable well before the last token."""
    scanner = StreamingArrayScanner("response_chunks")
    first_at = None
    for i, ch in enumerate(TEXT):
        if scanner.feed(ch) and first_at is None:
            first_at = i
    assert first_at is not None
    assert first_at < len(TEXT) // 2, (
        f"first chunk only available at {first_at}/{len(TEXT)} chars — "
        "is response_chunks still first in the output schema?"
    )


def test_ignores_arrays_before_the_target_key():
    scanner = StreamingArrayScanner("response_chunks")
    payload = '{"other": [{"text": "decoy"}], "response_chunks": [{"text": "real"}]}'
    got = []
    for ch in payload:
        got.extend(scanner.feed(ch))
    assert got == [{"text": "real"}]


def test_stops_at_array_close_and_ignores_later_objects():
    scanner = StreamingArrayScanner("response_chunks")
    payload = '{"response_chunks": [{"text": "a"}], "suggested_replies": [{"id": "r1"}]}'
    got = []
    for ch in payload:
        got.extend(scanner.feed(ch))
    assert got == [{"text": "a"}]
    assert scanner.done


def test_missing_key_yields_nothing_but_keeps_text():
    scanner = StreamingArrayScanner("response_chunks")
    payload = '{"corrected_input": "hola"}'
    got = []
    for ch in payload:
        got.extend(scanner.feed(ch))
    assert got == []
    assert not scanner.done
    assert scanner.text == payload


# --- stream_llm_for_messenger against a fake OpenAI client --------------------
# MOCK_MODE short-circuits before the real streaming call, so without this the
# integration with the Responses API event shapes would be untested.


class _Event:
    def __init__(self, type, delta=None, response=None):
        self.type = type
        self.delta = delta
        self.response = response


class _Usage:
    input_tokens = 2500
    output_tokens = 300
    total_tokens = 2800


class _FinalResponse:
    usage = _Usage()


class _FakeResponses:
    def __init__(self, text, delta_size):
        self._text = text
        self._delta_size = delta_size
        self.kwargs = None

    def create(self, **kwargs):
        self.kwargs = kwargs
        assert kwargs.get("stream") is True

        def gen():
            for i in range(0, len(self._text), self._delta_size):
                yield _Event("response.output_text.delta",
                             delta=self._text[i:i + self._delta_size])
            yield _Event("response.completed", response=_FinalResponse())
        return gen()


class _FakeClient:
    def __init__(self, text, delta_size):
        self.responses = _FakeResponses(text, delta_size)


@pytest.mark.parametrize("delta_size", [1, 7, 100])
def test_stream_llm_for_messenger_end_to_end(monkeypatch, delta_size):
    import llm_call

    fake = _FakeClient(TEXT, delta_size)
    monkeypatch.setattr(llm_call, "_init_client", lambda: fake)
    monkeypatch.setattr(llm_call, "_add_openai_cost", None)

    events = list(llm_call.stream_llm_for_messenger("SYSTEM", "USER"))

    kinds = [k for k, _ in events]
    assert kinds[-1] == "done"
    assert kinds[:-1] == ["chunk"] * len(DOC["response_chunks"])
    assert [payload for k, payload in events if k == "chunk"] == DOC["response_chunks"]

    _, final = events[-1]
    assert final["corrected_input"] == DOC["corrected_input"]
    assert final["suggested_replies"] == DOC["suggested_replies"]
    usage = final["token_usage"]
    assert usage["prompt_tokens"] == 2500
    assert usage["completion_tokens"] == 300
    assert usage["cost_cents"] > 0, "every LLM call must record cost"

    # The prompt is sent as one wire string, matching call_llm_for_messenger
    assert fake.responses.kwargs["input"] == "SYSTEM\n\nUSER"


def test_stream_llm_raises_when_output_is_not_json(monkeypatch):
    """Caller falls back to the buffered endpoint on a parse failure."""
    import llm_call

    monkeypatch.setattr(llm_call, "_init_client", lambda: _FakeClient("not json at all", 4))
    monkeypatch.setattr(llm_call, "_add_openai_cost", None)

    with pytest.raises(Exception):
        list(llm_call.stream_llm_for_messenger("SYSTEM", "USER"))
