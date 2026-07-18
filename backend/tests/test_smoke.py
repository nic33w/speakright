"""Mock-mode smoke test hitting every HTTP route in the backend (27 routes).

Asserts status codes and the top-level response keys the frontend actually
reads. This is the regression gate for the router split: it must stay green,
unchanged, through every mechanical refactor stage.
"""
import json
import time
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent

FLUENT = {"code": "en", "name": "English"}
LEARNING = {"code": "es", "name": "Spanish"}


# --- Story cards -------------------------------------------------------------

def test_game_start(client):
    r = client.post("/api/game/start", json={"story_title": "Test Tale"})
    assert r.status_code == 200
    body = r.json()
    assert body["story_title"] == "Test Tale"
    assert body["session_id"]
    assert isinstance(body["active_cards"], list) and len(body["active_cards"]) == 7


def test_game_turn(client):
    r = client.post("/api/game/turn", json={
        "session_id": "pytest_story",
        "story_title": "Test Tale",
        "active_cards": [],
        "transcript": "el lobo camina por la noche",
        "fluent": FLUENT,
        "learning": LEARNING,
    })
    assert r.status_code == 200
    body = r.json()
    for key in ("turn_id", "corrected_sentence", "native_translation", "used_card_ids",
                "asr_fixes", "brief_explanation_native", "audio_files",
                "audio_file_en", "audio_file_learning", "new_cards"):
        assert key in body
    assert body["corrected_sentence"] == "el lobo camina por la noche"
    assert len(body["audio_files"]) == 2


def test_game_turn_empty_transcript_rejected(client):
    r = client.post("/api/game/turn", json={
        "session_id": "pytest_story",
        "story_title": "Test Tale",
        "active_cards": [],
        "transcript": "   ",
        "fluent": FLUENT,
        "learning": LEARNING,
    })
    assert r.status_code == 400


# --- Audio -------------------------------------------------------------------

def test_trivia_audio_and_serve_cached_file(client):
    r = client.post("/api/trivia/audio", json={"text": "hola prueba pytest", "locale": "es-MX"})
    assert r.status_code == 200
    audio_url = r.json()["audio_file"]
    assert audio_url.startswith("/api/audio_file/")

    # Second call must be a cache hit returning the identical URL
    r2 = client.post("/api/trivia/audio", json={"text": "hola prueba pytest", "locale": "es-MX"})
    assert r2.json()["audio_file"] == audio_url

    # Serve the file through the audio route
    r3 = client.get(audio_url)
    assert r3.status_code == 200
    assert r3.headers["content-type"].startswith("audio/")


def test_serve_audio_missing_404(client):
    r = client.get("/api/audio_file/cache/definitely_not_there.wav")
    assert r.status_code == 404


def test_serve_greeting_audio(client):
    # If any real greeting audio exists, it must serve; a bogus name must 404.
    r = client.get("/api/greetings/random", params={"target_lang": "es"})
    assert r.status_code == 200
    greetings = r.json()["greetings"]
    with_audio = [g for g in greetings if g.get("audio_file")]
    if with_audio:
        r2 = client.get(with_audio[0]["audio_file"])
        assert r2.status_code == 200
        assert r2.headers["content-type"].startswith("audio/")
    r3 = client.get("/api/audio_file/greetings/es/definitely_not_there.wav")
    assert r3.status_code == 404


# --- Config / usage / greetings ----------------------------------------------

def test_config(client):
    r = client.get("/api/config")
    assert r.status_code == 200
    body = r.json()
    assert body["mock_mode"] is True
    assert "has_azure_tts" in body


def test_usage_session_start(client):
    r = client.post("/api/usage/session/start", json={"mode": "pytest"})
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_usage_summary(client):
    r = client.get("/api/usage")
    assert r.status_code == 200
    assert isinstance(r.json(), dict)


def test_greetings_random(client):
    r = client.get("/api/greetings/random", params={"target_lang": "es", "count": 3})
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body["greetings"], list)
    for g in body["greetings"]:
        assert "text_target" in g and "text_native" in g


# --- Trivia ------------------------------------------------------------------

def test_trivia_check(client):
    r = client.post("/api/trivia/check", json={
        "session_id": "pytest_trivia",
        "user_answer": "el gato",
        "correct_answer": "el gato",
        "prompt_text": "the cat",
        "learning": LEARNING,
        "fluent": FLUENT,
    })
    assert r.status_code == 200
    body = r.json()
    for key in ("is_correct", "feedback", "corrected_answer"):
        assert key in body
    assert body["corrected_answer"] == "el gato"


# --- Messenger ---------------------------------------------------------------

def test_messenger_profile_init_and_get(client):
    r = client.post("/api/messenger/profile/init", json={})
    assert r.status_code == 200
    profile = r.json()["profile"]
    assert profile["level"] == "beginner"
    assert profile["turn_count"] == 0

    r2 = client.get("/api/messenger/profile")
    assert r2.status_code == 200
    assert "profile" in r2.json()


import pytest


@pytest.mark.xfail(
    reason="Pre-existing bug on main: premade paths build MessengerTurnResponse "
    "without the required input_intent field, so /api/messenger/premade-start "
    "(and premade continuations in /api/messenger/turn) crash with a "
    "ValidationError. Remove this marker when the bug is fixed.",
    strict=True,
)
def test_messenger_premade_start(client):
    r = client.post("/api/messenger/premade-start", json={"session_id": "pytest_premade"})
    assert r.status_code == 200
    body = r.json()
    assert body["turn_id"]
    assert len(body["response_chunks"]) >= 1
    assert body["response_chunks"][0]["modality"] == "text"
    assert isinstance(body["suggested_replies"], list)


def test_messenger_turn_v1(client):
    r = client.post("/api/messenger/turn", json={
        "user_input": "hola como estas",
        "session_id": "pytest_llm_v1",
        "prompt_version": "v1",
    })
    assert r.status_code == 200
    body = r.json()
    for key in ("turn_id", "corrected_input", "had_errors", "error_explanation",
                "input_intent", "response_chunks", "suggested_replies",
                "profile_updated", "pending_quiz"):
        assert key in body
    assert len(body["response_chunks"]) >= 1


def test_messenger_turn_v2_challenge(client):
    r = client.post("/api/messenger/turn", json={
        "user_input": "hola otra vez",
        "session_id": "pytest_llm_v2",
        "prompt_version": "v2",
    })
    assert r.status_code == 200
    chunks = r.json()["response_chunks"]
    assert len(chunks) >= 2
    last = chunks[-1]
    assert last["is_challenge"] is True
    assert last["native_text"]


# --- Guessing ----------------------------------------------------------------

def test_guessing_turn_and_giveup(client):
    r = client.post("/api/guessing/turn", json={
        "session_id": "pytest_guess",
        "theme": "animals",
        "user_input": "is it big?",
        "guess_count": 1,
    })
    assert r.status_code == 200
    body = r.json()
    assert "response" in body
    assert body["is_correct_guess"] is False

    # Mock secret for the "animals" theme is deterministic: elephant
    r2 = client.post("/api/guessing/turn", json={
        "session_id": "pytest_guess",
        "theme": "animals",
        "user_input": "is it an elephant?",
        "guess_count": 2,
    })
    assert r2.status_code == 200
    assert r2.json()["is_correct_guess"] is True
    assert r2.json()["answer"] == "elephant"

    r3 = client.post("/api/guessing/giveup", json={
        "session_id": "pytest_guess",
        "theme": "animals",
    })
    assert r3.status_code == 200
    assert r3.json()["answer"] == "elephant"

    # Session was cleaned up: a second giveup is a 404
    r4 = client.post("/api/guessing/giveup", json={
        "session_id": "pytest_guess",
        "theme": "animals",
    })
    assert r4.status_code == 404


# --- Quiz --------------------------------------------------------------------

def _install_test_quiz_item():
    quiz_path = BACKEND_DIR / "quiz_items" / "default_quiz.json"
    items = json.loads(quiz_path.read_text(encoding="utf-8")) if quiz_path.exists() else []
    item = {
        "id": "pytest_quiz_1",
        "type": "translation",
        "original": "the store",
        "corrected": "la tienda",
        "error_type": "vocabulary",
        "quiz_prompt": "How do you say 'the store' in Spanish?",
        "created_at": int(time.time()),
        "created_at_turn": 1,
        "show_after_turn": 0,
        "times_reviewed": 0,
        "last_reviewed": None,
        "mastery_level": 0,
        "is_answered": False,
    }
    items = [i for i in items if i.get("id") != "pytest_quiz_1"] + [item]
    quiz_path.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def test_quiz_check_local_match(client):
    _install_test_quiz_item()
    r = client.post("/api/quiz/check", json={
        "quiz_id": "pytest_quiz_1",
        "user_answer": "la tienda",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["is_correct"] is True
    assert body["correct_answer"] == "la tienda"
    assert body["mastery_level"] >= 1


def test_quiz_check_wrong_answer(client):
    _install_test_quiz_item()
    r = client.post("/api/quiz/check", json={
        "quiz_id": "pytest_quiz_1",
        "user_answer": "el perro grande",
    })
    assert r.status_code == 200
    assert r.json()["is_correct"] is False


def test_quiz_pending(client):
    r = client.get("/api/quiz/pending")
    assert r.status_code == 200
    assert "quiz" in r.json()


def test_quiz_stats(client):
    r = client.get("/api/quiz/stats")
    assert r.status_code == 200
    body = r.json()
    for key in ("total", "mastered", "learning", "new"):
        assert key in body


# --- Battle ------------------------------------------------------------------

def test_battle_check(client):
    r = client.post("/api/battle/check", json={
        "session_id": "pytest_battle",
        "user_answer": "no me gusta",
        "correct_answer": "no me gusta",
        "prompt_text": "I don't like it",
        "learning": LEARNING,
        "fluent": FLUENT,
    })
    assert r.status_code == 200
    body = r.json()
    for key in ("accepted", "damage_multiplier"):
        assert key in body
    # Identical answer hits the normalization fast path
    assert body["accepted"] is True
    assert body["fast_path"] is True


# --- Word drill --------------------------------------------------------------

def _first_word_key(client, lang="es"):
    r = client.get("/api/worddrill/words", params={"lang": lang})
    assert r.status_code == 200
    words = r.json()["words"]
    assert len(words) > 0
    return words[0]["key"]


def test_worddrill_words(client):
    key = _first_word_key(client)
    assert isinstance(key, str) and key


def test_worddrill_sentence(client):
    word = _first_word_key(client)
    r = client.post("/api/worddrill/sentence", json={"word": word, "exclude_ids": [], "lang": "es"})
    assert r.status_code == 200
    assert "sentence" in r.json()


def test_worddrill_sentence_unknown_word_404(client):
    r = client.post("/api/worddrill/sentence", json={"word": "zz_not_a_word", "lang": "es"})
    assert r.status_code == 404


def test_worddrill_sentences_list(client):
    word = _first_word_key(client)
    r = client.get(f"/api/worddrill/sentences/{word}", params={"lang": "es"})
    assert r.status_code == 200
    assert isinstance(r.json()["sentences"], list)


def test_worddrill_usecases(client):
    word = _first_word_key(client)
    r = client.get(f"/api/worddrill/usecases/{word}", params={"lang": "es"})
    assert r.status_code == 200
    body = r.json()
    assert "usecases" in body and "conjugations" in body


def test_worddrill_check(client):
    r = client.post("/api/worddrill/check", json={
        "user_answer": "me da miedo",
        "correct_answer": "me da miedo",
        "accepted_translations": [],
        "prompt_text": "it scares me",
        "learning": LEARNING,
        "fluent": FLUENT,
    })
    assert r.status_code == 200
    body = r.json()
    for key in ("accepted", "damage_multiplier", "feedback_key"):
        assert key in body
    assert body["accepted"] is True


def test_worddrill_chat(client):
    r = client.post("/api/worddrill/chat", json={
        "messages": [{"role": "user", "content": "why is it 'me gusta' and not 'yo gusto'?"}],
        "context": {"learning_lang": "Spanish", "fluent_lang": "English"},
    })
    assert r.status_code == 200
    assert isinstance(r.json()["reply"], str) and r.json()["reply"]


def test_worddrill_freeform(client):
    r = client.post("/api/worddrill/freeform", json={
        "user_sentence": "yo soy muy feliz hoy",
        "word_key": "ser",
        "usecase_name": "states",
    })
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body["correction_tokens"], list)
    assert "feedback_message" in body
