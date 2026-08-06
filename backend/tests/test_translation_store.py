"""Unit tests for the chunk-translation cache (task 3.8).

The cache is what makes re-listening free and keeps `pairs` mode from paying the
LLM twice for the same sentence — reaction openers are a closed set, and
conversations circle back to the same phrasings.
"""
import json

import pytest

import translation_store


@pytest.fixture
def store(tmp_path, monkeypatch):
    """Point the store at a temp file and clear its in-memory copy."""
    path = tmp_path / "translation_cache.json"
    monkeypatch.setattr(translation_store, "TRANSLATION_CACHE_PATH", path)
    translation_store.reset_for_tests()
    yield path
    translation_store.reset_for_tests()


def test_roundtrip(store):
    assert translation_store.get("¿Qué tal?", "Spanish", "English") is None

    translation_store.put_many([("¿Qué tal?", "Spanish", "English", "How's it going?")])

    assert translation_store.get("¿Qué tal?", "Spanish", "English") == "How's it going?"
    assert store.exists(), "put_many must persist to disk"


def test_key_includes_both_languages(store):
    translation_store.put_many([("hola", "Spanish", "English", "hi")])

    assert translation_store.get("hola", "Spanish", "English") == "hi"
    # Same text, different language pair — must not collide
    assert translation_store.get("hola", "Spanish", "Indonesian") is None
    assert translation_store.get("hola", "Indonesian", "English") is None


def test_whitespace_insensitive_key(store):
    translation_store.put_many([("  hola  ", "Spanish", "English", "hi")])
    assert translation_store.get("hola", "Spanish", "English") == "hi"


def test_survives_a_reload(store):
    translation_store.put_many([("gracias", "Spanish", "English", "thanks")])
    translation_store.reset_for_tests()  # forget in-memory, force a disk read
    assert translation_store.get("gracias", "Spanish", "English") == "thanks"


def test_blank_entries_are_ignored(store):
    translation_store.put_many([
        ("", "Spanish", "English", "nope"),
        ("   ", "Spanish", "English", "nope"),
        ("hola", "Spanish", "English", ""),
    ])
    assert translation_store.get("", "Spanish", "English") is None
    assert translation_store.get("hola", "Spanish", "English") is None


def test_corrupt_cache_does_not_raise(store):
    store.write_text("{not json at all", encoding="utf-8")
    translation_store.reset_for_tests()
    # A bad cache file must never be able to fail a turn
    assert translation_store.get("hola", "Spanish", "English") is None
    translation_store.put_many([("hola", "Spanish", "English", "hi")])
    assert translation_store.get("hola", "Spanish", "English") == "hi"


def test_batch_write_keeps_existing_entries(store):
    translation_store.put_many([("uno", "Spanish", "English", "one")])
    translation_store.put_many([("dos", "Spanish", "English", "two")])

    assert translation_store.get("uno", "Spanish", "English") == "one"
    assert translation_store.get("dos", "Spanish", "English") == "two"
    on_disk = json.loads(store.read_text(encoding="utf-8"))
    assert len(on_disk) == 2
