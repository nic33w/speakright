"""Scene layer (task 5.1): dimension draw, lifecycle, and the turn endpoints.
Secret scenes (task 5.3) are at the bottom.

The point of the scene layer is that a scene *ends*, so most of what is worth
testing is the clock: turns are counted, the budget runs out, the scene is marked
complete, and the next turn draws a different one.
"""
import pytest

import profile_store
from profile_store import (
    SCENE_DIMENSION_KEYS,
    advance_scene,
    check_secret_guess,
    load_profile,
    new_scene,
    pick_scene_dimensions,
    update_character_state,
)
from settings import SCENE_MAX_TURNS, SCENE_MIN_TURNS


def standard_draw(previous=None):
    """A draw guaranteed NOT to be a secret scene (task 5.3).

    Secret scenes never come twice in a row, so declaring the previous scene a
    secret pins the next draw to the standard pool — otherwise every test
    touching the draw would be flaky at SECRET_SCENE_CHANCE. Pass `previous` to
    also get the normal no-repeat exclusion on setting and goal.
    """
    return pick_scene_dimensions({**(previous or {}), "type": "secret"})


def secret_draw(monkeypatch):
    """The other half: force the draw into the secret pool."""
    monkeypatch.setattr(profile_store, "SECRET_SCENE_CHANCE", 1.0)
    return pick_scene_dimensions()


def test_dimension_draw_is_complete_and_playable():
    dims = pick_scene_dimensions()
    assert dims, "scene_dimensions.json failed to load"
    for key in SCENE_DIMENSION_KEYS:
        assert dims.get(key), f"draw is missing {key}"
    assert dims["type"] in ("standard", "secret")


def test_draw_avoids_repeating_the_previous_scene():
    """Two scenes in a row that open the same way is the failure mode the draw
    exists to prevent — so the exclusion is checked, not assumed."""
    previous = new_scene(standard_draw())
    for _ in range(20):
        dims = pick_scene_dimensions(previous)
        assert dims["setting"] != previous["setting"]
        assert dims["character_goal"] != previous["character_goal"]


def test_new_scene_starts_active_with_a_bounded_budget():
    scene = new_scene(standard_draw())
    assert scene["status"] == "active"
    assert scene["turns_elapsed"] == 0
    assert SCENE_MIN_TURNS <= scene["turn_budget"] <= SCENE_MAX_TURNS
    assert scene["source"] == "dimensions"
    assert scene["id"].startswith("scene_")


def test_dimension_draw_carries_mood_and_energy(monkeypatch):
    """Task 5.2: every character_goal in scene_dimensions.json declares
    mood_after/energy_after, and the draw (not just the concretized scene)
    must surface them — new_scene reads them straight off the draw."""
    dims = standard_draw()
    assert dims.get("mood_after")
    assert dims.get("energy_after")
    scene = new_scene(dims)
    assert scene["mood_after"] == dims["mood_after"]
    assert scene["energy_after"] == dims["energy_after"]


def test_concretization_never_overwrites_mood_or_energy():
    """mood_after/energy_after are not in SCENE_DIMENSION_KEYS, so an LLM
    concretization result — even one that happens to carry those keys — must
    not be able to touch them."""
    dims = standard_draw()
    concretized = {k: f"generated {k}" for k in SCENE_DIMENSION_KEYS}
    concretized["mood_after"] = "should never appear"
    scene = new_scene(dims, concretized)
    assert scene["mood_after"] == dims["mood_after"]


def test_generated_fields_override_the_draw_and_blanks_do_not():
    dims = standard_draw()
    scene = new_scene(dims, {"setting": "  a specific rooftop  ", "character_goal": "   "})
    assert scene["setting"] == "a specific rooftop"
    assert scene["source"] == "llm"
    # A blank from the model must not erase a perfectly usable drawn dimension.
    assert scene["character_goal"] == dims["character_goal"]


def test_scene_completes_exactly_when_the_budget_runs_out():
    profile = {"scene": new_scene(standard_draw())}
    budget = profile["scene"]["turn_budget"]

    for turn in range(1, budget):
        advance_scene(profile)
        assert profile["scene"]["status"] == "active", f"ended early at turn {turn}"

    advance_scene(profile)
    assert profile["scene"]["status"] == "complete"
    assert profile["scene"]["turns_elapsed"] == budget
    assert profile["scene"]["completed_at"]

    # A completed scene stops counting — the next scene owns the clock now.
    advance_scene(profile)
    assert profile["scene"]["turns_elapsed"] == budget


def test_advance_scene_tolerates_a_profile_without_one():
    """Profiles written before 5.1 have no scene key at all."""
    profile = {}
    advance_scene(profile)
    assert profile == {}


# --- Persistent character state (task 5.2) ---


def test_update_character_state_carries_the_scene_forward():
    scene = new_scene(standard_draw())
    profile = {}
    update_character_state(profile, scene)

    state = profile["character_state"]
    assert scene["character_goal"] in state["situation"]
    assert scene["completion_condition"] in state["situation"]
    assert state["mood"] == scene["mood_after"]
    assert state["energy"] == scene["energy_after"]
    assert state["updated_at"]


def test_update_character_state_overwrites_rather_than_accumulates():
    """Only the most recent scheme is kept — like level_history's 'current
    level', not an accumulating log."""
    profile = {}
    first = new_scene(standard_draw())
    update_character_state(profile, first)
    second = new_scene(standard_draw(first))  # a different goal, deterministically
    update_character_state(profile, second)

    assert second["character_goal"] in profile["character_state"]["situation"]
    assert first["character_goal"] not in profile["character_state"]["situation"]


def test_advance_scene_sets_character_state_on_completion():
    """The wiring point: advance_scene, not the router, owns the transition
    into persistent state — so the router needs no changes to pick this up."""
    profile = {"scene": new_scene(standard_draw())}
    budget = profile["scene"]["turn_budget"]
    for _ in range(budget - 1):
        advance_scene(profile)
        assert "character_state" not in profile, "must not fire before the scene actually ends"

    advance_scene(profile)
    assert profile["scene"]["status"] == "complete"
    assert profile["character_state"]["situation"]


# --- generate_scene (the LLM leg, stubbed — no keys, no spend) ---


def _generate_with(monkeypatch, parsed):
    """Run generate_scene against a canned model response."""
    import llm_call

    captured = {}

    def fake_call(prompt, **kwargs):
        captured["prompt"] = prompt
        captured["kwargs"] = kwargs
        return llm_call.LLMCallResult(parsed=parsed, raw_text="", token_usage={})

    monkeypatch.setattr(llm_call, "MOCK_MODE", False)
    monkeypatch.setattr(llm_call, "_call_openai_json", fake_call)
    dims = standard_draw()
    result = llm_call.generate_scene(dims, "Jorge", "Jorge is a troublemaker.", "Spanish")
    return result, captured, dims


def test_generate_scene_passes_the_draw_through_to_the_prompt(monkeypatch):
    """The draw is the variety mechanism — a generation call that ignores it
    would quietly collapse back to whatever premise the model likes best."""
    canned = {k: f"generated {k}" for k in SCENE_DIMENSION_KEYS}
    result, captured, dims = _generate_with(monkeypatch, canned)

    assert result == canned
    # Only the SCENE_DIMENSION_KEYS fields go into the generation prompt —
    # mood_after/energy_after (task 5.2) are carried straight through to the
    # scene without ever involving the model.
    for key in SCENE_DIMENSION_KEYS:
        assert dims[key] in captured["prompt"]
    assert "Jorge" in captured["prompt"]
    assert captured["kwargs"]["model"] == "gpt-4.1-nano", "scene setup must stay on the cheap model"


def test_generate_scene_drops_an_inverted_goal(monkeypatch):
    """Observed live on nano: the model writes character_goal from the learner's
    side ("you need Jorge to stall them"), which inverts the scene, since that
    text is injected under "Your goal (Jorge)". Naming the character inside their
    own second-person goal is the tell — drop the field, keep the scene."""
    canned = {k: f"generated {k}" for k in SCENE_DIMENSION_KEYS}
    canned["character_goal"] = "You need Jorge to stall them so you can slip away."
    result, _, dims = _generate_with(monkeypatch, canned)

    assert result["character_goal"] == "", "an inverted goal must not reach the prompt"
    assert result["setting"] == "generated setting", "one bad field must not sink the scene"
    # ...and new_scene fills the hole from the draw, which cannot be inverted.
    assert new_scene(dims, result)["character_goal"] == dims["character_goal"]


def test_generate_scene_drops_a_first_person_slip(monkeypatch):
    """The same swap wearing a different hat, also seen live: "you won't tell me
    where" is the learner talking. Nobody speaks in the first person in a field
    addressed to the character, so any I/me/my is a slip."""
    canned = {k: f"generated {k}" for k in SCENE_DIMENSION_KEYS}
    canned["character_goal"] = "You were out somewhere and you won't tell me where."
    canned["complication"] = "My whole evening depends on it."
    result, _, _ = _generate_with(monkeypatch, canned)

    assert result["character_goal"] == ""
    assert result["complication"] == ""
    assert result["user_goal"] == "generated user_goal", "user_goal is not second person; leave it"


def test_generate_scene_rejects_a_partial_response(monkeypatch):
    """A half-filled scene must raise so the caller falls back to the full draw,
    rather than silently playing a scene with no ending."""
    partial = {k: "x" for k in SCENE_DIMENSION_KEYS}
    partial["completion_condition"] = ""
    with pytest.raises(ValueError):
        _generate_with(monkeypatch, partial)


def test_generate_scene_is_free_in_mock_mode():
    """Mock mode returns the draw itself — the fallback path, exercised for real."""
    from llm_call import generate_scene

    dims = standard_draw()
    assert generate_scene(dims, "Jorge", "bio", "Spanish") == \
           {k: dims[k] for k in SCENE_DIMENSION_KEYS}


# --- Endpoint lifecycle (mock mode: generate_scene returns the raw draw) ---


@pytest.mark.parametrize("path", ["/api/messenger/turn", "/api/messenger/turn/stream"])
def test_turn_endpoints_create_and_advance_a_scene(client, path):
    """Both endpoints run the same lifecycle — patching only the buffered one
    would leave the streaming path (which the frontend prefers) sceneless."""
    r = client.post(path, json={
        "user_input": "hola",
        "session_id": f"pytest_scene_{path.rsplit('/', 1)[-1]}",
        "prompt_version": "v1",
    })
    assert r.status_code == 200

    scene = load_profile().get("scene")
    assert scene, "a turn must leave an active scene behind"
    assert scene["status"] in ("active", "complete")
    assert scene["turns_elapsed"] >= 1, "the turn that just ran was not counted"
    for key in SCENE_DIMENSION_KEYS:
        assert scene.get(key)


def test_scene_rotates_the_turn_it_ends(client):
    """The whole feature: a scene runs out and is replaced — and the replacement
    is drawn on the turn that ended it, not in front of the next turn's audio."""
    from profile_store import save_profile

    profile = load_profile()
    scene = new_scene(standard_draw())
    scene["turns_elapsed"] = scene["turn_budget"] - 1  # one turn left
    profile["scene"] = scene
    save_profile(profile)

    client.post("/api/messenger/turn", json={
        "user_input": "esta bien",
        "session_id": "pytest_scene_rotate",
        "prompt_version": "v1",
    })
    fresh = load_profile()["scene"]
    assert fresh["id"] != scene["id"], "a completed scene must be replaced, not reused"
    assert fresh["status"] == "active"
    assert fresh["turns_elapsed"] == 0, "the new scene starts with its full budget"
    assert fresh["setting"] != scene["setting"]

    client.post("/api/messenger/turn", json={
        "user_input": "y ahora que",
        "session_id": "pytest_scene_rotate",
        "prompt_version": "v1",
    })
    running = load_profile()["scene"]
    assert running["id"] == fresh["id"]
    assert running["turns_elapsed"] == 1


# --- Secret scenes (task 5.3) ---
#
# The information-asymmetry scene ported from GuessingGame: the character knows
# one thing, the learner extracts it, and naming it ends the scene early. That
# early exit is the only way a scene can end other than the turn budget, so most
# of what matters here is that the guess is detected correctly — a false positive
# ends a scene that was going fine, a false negative makes the mechanic unwinnable.


def _secret_scene(aliases=("la licuadora rota", "la licuadora"), **overrides):
    """A concretized secret scene, the way the router would have built it."""
    dims = dict(
        setting="a shared kitchen at midnight",
        character_goal="you know what happened to their blender and you are not saying",
        user_goal="find out what you are actually up to",
        complication="you owe them something and neither of you has mentioned it yet",
        completion_condition="the learner has named what happened to it",
        type="secret",
        secret_kind="what happened to a small thing of theirs",
        mood_after="quietly pleased",
        mood_after_solved="caught out, and weirdly relieved",
        mood_after_unsolved="quietly pleased that they still have no idea",
        energy_after="watchful",
    )
    scene = new_scene(dims, {"secret": "you broke their blender", "secret_aliases": list(aliases)})
    scene.update(overrides)
    return scene


def test_secret_draw_carries_everything_a_secret_scene_needs(monkeypatch):
    dims = secret_draw(monkeypatch)
    assert dims["type"] == "secret"
    assert dims["secret_kind"], "the generator needs to know what class of thing to invent"
    assert dims["mood_after_solved"] and dims["mood_after_unsolved"]
    # mood_after stays populated for anything reading it without knowing about secrets
    assert dims["mood_after"] == dims["mood_after_unsolved"]
    for key in SCENE_DIMENSION_KEYS:
        assert dims.get(key), f"secret draw is missing {key}"
    # The learner's goal is the secret itself, not an unrelated draw from the
    # shared pool — otherwise the scene pulls in two directions at once.
    assert dims["secret_kind"] in dims["user_goal"]


def test_secret_scenes_never_come_twice_in_a_row(monkeypatch):
    """Back to back they stop being a change of gear and turn into a quiz."""
    monkeypatch.setattr(profile_store, "SECRET_SCENE_CHANCE", 1.0)
    for _ in range(10):
        assert pick_scene_dimensions({"type": "secret"})["type"] == "standard"


def test_secret_scene_demotes_without_a_generated_secret(monkeypatch):
    """There is no language-neutral fallback secret, so a failed generation has
    to demote rather than play a secret nobody can name."""
    dims = secret_draw(monkeypatch)
    assert new_scene(dims)["type"] == "standard"
    assert new_scene(dims, {"secret": "something", "secret_aliases": []})["type"] == "standard"

    full = new_scene(dims, {"secret": "the thing", "secret_aliases": ["la cosa"]})
    assert full["type"] == "secret"
    assert full["secret_solved"] is False


def test_secret_scene_keeps_its_drawn_completion_condition(monkeypatch):
    """Seen live: the model rewrote the ending to name a *person* while the
    secret it invented was an object, leaving the scene with two different
    targets. The drawn condition already agrees with secret_kind, so it wins."""
    dims = secret_draw(monkeypatch)
    scene = new_scene(dims, {
        "setting": "generated setting",
        "completion_condition": "the learner names the person who told you",
        "secret": "the thing", "secret_aliases": ["la cosa"],
    })
    assert scene["completion_condition"] == dims["completion_condition"]
    assert scene["setting"] == "generated setting", "only the ending is pinned"

    # Standard scenes are unaffected — theirs is still concretized.
    plain = new_scene(standard_draw(), {"completion_condition": "a sharper ending"})
    assert plain["completion_condition"] == "a sharper ending"


def test_guess_detection_is_accent_and_punctuation_tolerant():
    """Same promise the rest of the app makes — a missing tilde must not be the
    difference between solving a scene and not."""
    for guess in ("¿Fue la licuadora rota?", "LA LICUADORA ROTA!!", "la  licuadora   rota",
                  "creo que fue la licuadora, ¿no?"):
        scene = _secret_scene()
        assert check_secret_guess(scene, guess) is True, guess
        assert scene["secret_solved"] is True
        assert scene["solved_at_turn"] == 1


def test_guess_detection_requires_a_whole_word_sequence():
    """Bare substring matching would fire "la fiesta" inside "manifiesta" — a
    scene ended by a false positive is worse than one that runs a turn long."""
    scene = _secret_scene(aliases=("la fiesta",))
    assert check_secret_guess(scene, "eso se manifiesta de otra forma") is False
    assert scene.get("secret_solved") is False
    assert check_secret_guess(scene, "fue en la fiesta") is True


def test_guess_detection_ignores_non_secret_and_already_solved_scenes():
    assert check_secret_guess(new_scene(standard_draw()), "la licuadora rota") is False
    assert check_secret_guess({}, "la licuadora rota") is False
    solved = _secret_scene(secret_solved=True, solved_at_turn=2)
    assert check_secret_guess(solved, "la licuadora rota") is False
    assert solved["solved_at_turn"] == 2, "a second guess must not rewrite the record"


def test_naming_the_secret_ends_the_scene_early():
    """The point of the mechanic: the learner earns the ending."""
    profile = {"scene": _secret_scene()}
    profile["scene"]["turn_budget"] = 9

    advance_scene(profile)  # turn 1, no guess
    assert profile["scene"]["status"] == "active"

    check_secret_guess(profile["scene"], "fue la licuadora rota")
    advance_scene(profile)
    assert profile["scene"]["status"] == "complete"
    assert profile["scene"]["turns_elapsed"] == 2, "closed far short of its 9-turn budget"


def test_unsolved_secret_scene_still_ends_on_the_budget():
    profile = {"scene": _secret_scene()}
    for _ in range(profile["scene"]["turn_budget"]):
        advance_scene(profile)
    assert profile["scene"]["status"] == "complete"
    assert profile["scene"]["secret_solved"] is False


def test_character_state_records_which_way_the_secret_went():
    """A secret scene is the one type whose outcome is actually known, so the
    5.2 callback states it instead of hedging."""
    solved = {"scene": _secret_scene(secret_solved=True)}
    update_character_state(solved, solved["scene"])
    assert "They worked it out" in solved["character_state"]["situation"]
    assert "you broke their blender" in solved["character_state"]["situation"]
    assert solved["character_state"]["mood"] == "caught out, and weirdly relieved"
    assert "never actually found out" not in solved["character_state"]["situation"]

    kept = {"scene": _secret_scene()}
    update_character_state(kept, kept["scene"])
    assert "never worked out" in kept["character_state"]["situation"]
    assert kept["character_state"]["mood"] == "quietly pleased that they still have no idea"


def test_generate_scene_asks_for_and_validates_the_secret(monkeypatch):
    import llm_call

    canned = {k: f"generated {k}" for k in SCENE_DIMENSION_KEYS}
    canned["secret"] = "the blender you broke"
    canned["secret_aliases"] = [
        "la licuadora",
        "  la licuadora rota  ",
        "you broke the blender that they lent you last week and never mentioned it",  # too long
    ]
    captured = {}

    def fake_call(prompt, **kwargs):
        captured["prompt"] = prompt
        return llm_call.LLMCallResult(parsed=canned, raw_text="", token_usage={})

    monkeypatch.setattr(llm_call, "MOCK_MODE", False)
    monkeypatch.setattr(llm_call, "_call_openai_json", fake_call)
    dims = secret_draw(monkeypatch)
    result = llm_call.generate_scene(dims, "Jorge", "bio", "Spanish")

    assert dims["secret_kind"] in captured["prompt"]
    assert "SECRET SCENE" in captured["prompt"]
    assert result["secret"] == "the blender you broke"
    # Whole sentences masquerading as aliases never match anything; dropping them
    # keeps a scene from looking solvable when it is not.
    assert result["secret_aliases"] == ["la licuadora", "la licuadora rota"]

    for broken in ({**canned, "secret": ""}, {**canned, "secret_aliases": []}):
        monkeypatch.setattr(
            llm_call, "_call_openai_json",
            lambda prompt, _b=broken, **kw: llm_call.LLMCallResult(
                parsed=_b, raw_text="", token_usage={}),
        )
        with pytest.raises(ValueError):
            llm_call.generate_scene(dims, "Jorge", "bio", "Spanish")


def test_mock_mode_can_play_a_whole_secret_scene(monkeypatch):
    """Mock mode has to carry a secret, or the entire mechanic is untestable
    without API keys — it is the one part of a scene with no free fallback."""
    from llm_call import generate_scene

    dims = secret_draw(monkeypatch)
    mock = generate_scene(dims, "Jorge", "bio", "Spanish")
    assert mock["secret"] and mock["secret_aliases"]
    assert new_scene(dims, mock)["type"] == "secret"


def test_secret_scene_solved_through_the_endpoint(client):
    """End to end: a guess in the user's input closes the scene on that turn and
    the character remembers being caught."""
    from profile_store import save_profile

    profile = load_profile()
    profile["scene"] = _secret_scene()
    profile["scene"]["turn_budget"] = 9
    save_profile(profile)

    r = client.post("/api/messenger/turn", json={
        "user_input": "¡Ya sé! Fue la licuadora rota, ¿verdad?",
        "session_id": "pytest_secret_solved",
        "prompt_version": "v1",
    })
    assert r.status_code == 200

    after = load_profile()
    # Solved scenes complete immediately, so the router has already rotated to
    # the next scene — the outcome lives in character_state.
    assert after["scene"]["id"] != profile["scene"]["id"]
    assert "They worked it out" in after["character_state"]["situation"]
