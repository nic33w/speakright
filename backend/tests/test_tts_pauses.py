"""Task 3.10: clause-boundary SSML <break> insertion and its cache-key trap.

insert_clause_breaks is a pure text transform (no Azure call, no mock-mode
branching), so it's tested directly rather than through the audio endpoint.
The cache-key tests guard TRAP 1 from TASKS.md: pause_ms must be part of the
hash, and pause_ms=0 must reuse the exact pre-3.10 key so every file cached
before this change stays valid.
"""
from audio_utils import get_cached_audio_path
from tts_helpers import DEFAULT_CLAUSE_PAUSE_MS, insert_clause_breaks


def test_no_op_when_pause_ms_is_zero():
    text = "Ayer fui al mercado, pero se me olvidó comprar leche."
    assert insert_clause_breaks(text, 0) == text


def test_no_op_on_a_single_clause():
    text = "Voy al mercado."
    assert insert_clause_breaks(text, 250) == text


def test_break_inserted_after_comma():
    out = insert_clause_breaks("Fui al mercado, y compré pan.", 250)
    assert '<break time="250ms"/>' in out
    assert "mercado," in out  # punctuation preserved
    assert "compré pan." in out  # rest of the sentence intact


def test_break_inserted_before_cue_word_without_punctuation():
    out = insert_clause_breaks("Quiero ir pero no tengo tiempo", 250)
    assert out == 'Quiero ir<break time="250ms"/> pero no tengo tiempo'


def test_no_double_break_when_cue_word_follows_punctuation():
    """', pero' must get exactly one break, not one from the comma rule and
    another from the cue-word rule firing on the same whitespace."""
    out = insert_clause_breaks("Fui a la tienda, pero no compré nada.", 250)
    assert out.count("<break") == 1


def test_cue_word_substring_is_not_matched():
    """'y' must not fire inside 'yo', 'si' must not fire inside 'siempre'."""
    out = insert_clause_breaks("Yo siempre voy solo.", 250)
    assert "<break" not in out


def test_pause_length_is_configurable():
    out = insert_clause_breaks("Como pan, y bebo agua.", 500)
    assert '<break time="500ms"/>' in out


def test_cache_key_unaffected_when_pause_ms_is_zero():
    """pause_ms=0 must reuse the exact pre-3.10 key (TRAP 1)."""
    with_arg = get_cached_audio_path("hola mundo", "es-MX", pause_ms=0)
    without_arg = get_cached_audio_path("hola mundo", "es-MX")
    assert with_arg[0] == without_arg[0]


def test_cache_key_changes_with_pause_ms():
    plain = get_cached_audio_path("hola mundo", "es-MX")
    paused = get_cached_audio_path("hola mundo", "es-MX", pause_ms=DEFAULT_CLAUSE_PAUSE_MS)
    assert plain[0] != paused[0]


def test_cache_key_independent_axes_for_rate_and_pause():
    """rate and pause_ms must vary the key independently, not collide."""
    base = get_cached_audio_path("hola mundo", "es-MX")
    rate_only = get_cached_audio_path("hola mundo", "es-MX", rate=-25)
    pause_only = get_cached_audio_path("hola mundo", "es-MX", pause_ms=250)
    both = get_cached_audio_path("hola mundo", "es-MX", rate=-25, pause_ms=250)
    urls = {base[0], rate_only[0], pause_only[0], both[0]}
    assert len(urls) == 4, "each rate/pause_ms combination must hash to a distinct file"
