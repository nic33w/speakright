"""Scene layer (task 5.1): dimension draw, lifecycle, and the turn endpoints.

The point of the scene layer is that a scene *ends*, so most of what is worth
testing is the clock: turns are counted, the budget runs out, the scene is marked
complete, and the next turn draws a different one.
"""
import pytest

from profile_store import (
    SCENE_DIMENSION_KEYS,
    advance_scene,
    load_profile,
    new_scene,
    pick_scene_dimensions,
)
from settings import SCENE_MAX_TURNS, SCENE_MIN_TURNS


def test_dimension_draw_is_complete_and_playable():
    dims = pick_scene_dimensions()
    assert dims, "scene_dimensions.json failed to load"
    for key in SCENE_DIMENSION_KEYS:
        assert dims.get(key), f"draw is missing {key}"


def test_draw_avoids_repeating_the_previous_scene():
    """Two scenes in a row that open the same way is the failure mode the draw
    exists to prevent — so the exclusion is checked, not assumed."""
    previous = new_scene(pick_scene_dimensions())
    for _ in range(20):
        dims = pick_scene_dimensions(previous)
        assert dims["setting"] != previous["setting"]
        assert dims["character_goal"] != previous["character_goal"]


def test_new_scene_starts_active_with_a_bounded_budget():
    scene = new_scene(pick_scene_dimensions())
    assert scene["status"] == "active"
    assert scene["turns_elapsed"] == 0
    assert SCENE_MIN_TURNS <= scene["turn_budget"] <= SCENE_MAX_TURNS
    assert scene["source"] == "dimensions"
    assert scene["id"].startswith("scene_")


def test_generated_fields_override_the_draw_and_blanks_do_not():
    dims = pick_scene_dimensions()
    scene = new_scene(dims, {"setting": "  a specific rooftop  ", "character_goal": "   "})
    assert scene["setting"] == "a specific rooftop"
    assert scene["source"] == "llm"
    # A blank from the model must not erase a perfectly usable drawn dimension.
    assert scene["character_goal"] == dims["character_goal"]


def test_scene_completes_exactly_when_the_budget_runs_out():
    profile = {"scene": new_scene(pick_scene_dimensions())}
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
    dims = pick_scene_dimensions()
    result = llm_call.generate_scene(dims, "Jorge", "Jorge is a troublemaker.", "Spanish")
    return result, captured, dims


def test_generate_scene_passes_the_draw_through_to_the_prompt(monkeypatch):
    """The draw is the variety mechanism — a generation call that ignores it
    would quietly collapse back to whatever premise the model likes best."""
    canned = {k: f"generated {k}" for k in SCENE_DIMENSION_KEYS}
    result, captured, dims = _generate_with(monkeypatch, canned)

    assert result == canned
    for value in dims.values():
        assert value in captured["prompt"]
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

    dims = pick_scene_dimensions()
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
    scene = new_scene(pick_scene_dimensions())
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
