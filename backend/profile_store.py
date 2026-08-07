"""Messenger learner-profile persistence (profiles/default_profile.json),
persona/helper JSON loaders, scene state, and the level-assessment profile update.
Shared by the messenger and quiz routers.
"""
import json
import random
import re
import time
import unicodedata
from typing import Any, Dict, Optional

from models import LangSpec
from settings import (
    DEFAULT_PROFILE_PATH,
    DISALLOWED_WEAK_POINTS,
    MAX_COMFORTABLE_WITH,
    MAX_WEAK_POINTS,
    PROMPTS_DIR,
    SCENE_MAX_TURNS,
    SCENE_MIN_TURNS,
    SECRET_SCENE_CHANCE,
)


# --- Persona Loading Functions ---

def load_persona_json(persona_id: str) -> Optional[Dict[str, Any]]:
    """Load persona from JSON file."""
    persona_file = PROMPTS_DIR / "persona" / f"{persona_id}.json"
    if persona_file.exists():
        with open(persona_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    return None


def load_helper_json(helper_id: str) -> Optional[Dict[str, Any]]:
    """Load helper configuration from JSON file."""
    helper_file = PROMPTS_DIR / "helpers" / f"{helper_id}.json"
    if helper_file.exists():
        with open(helper_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    return None


# --- Profile CRUD Functions ---

def init_default_profile(ui_lang: LangSpec, target_lang: LangSpec) -> Dict[str, Any]:
    """Create a fresh default profile."""
    now = int(time.time())
    return {
        "created_at": now,
        "last_updated": now,
        "ui_language": ui_lang.dict(),
        "target_language": target_lang.dict(),
        "level": "beginner",
        "level_confidence": 0.5,
        "level_history": [
            {"timestamp": now, "level": "beginner", "reason": "Initial profile creation"}
        ],
        "comfortable_with": [],
        "weak_points": [],
        "avoid_topics": [],
        "turn_count": 0,
        "corrections_needed": 0,
        "last_assessment_turn": 0,
        "recent_turns": [],
        # Task 5.1. None until the first turn creates one; every reader uses
        # .get("scene"), so profiles written before 5.1 stay valid.
        "scene": None,
        # Task 5.2. None until a scene has completed at least once; every
        # reader uses .get("character_state"), so pre-5.2 profiles stay valid.
        "character_state": None,
    }


def load_profile() -> Dict[str, Any]:
    """Load profile from default_profile.json. Create if not exists."""
    if not DEFAULT_PROFILE_PATH.exists():
        # Create default profile
        profile = init_default_profile(
            LangSpec(code="en", name="English"),
            LangSpec(code="es", name="Spanish")
        )
        save_profile(profile)
        return profile

    with open(DEFAULT_PROFILE_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_profile(profile: Dict[str, Any]) -> None:
    """Save profile to default_profile.json."""
    profile["last_updated"] = int(time.time())
    with open(DEFAULT_PROFILE_PATH, 'w', encoding='utf-8') as f:
        json.dump(profile, f, ensure_ascii=False, indent=2)


# --- Scene state (task 5.1) ---
#
# A scene is a setting + a goal for each side + a complication + an explicit
# completion condition, and it lasts a fixed handful of turns before it ends for
# real. The state lives in the profile next to level_history; the prompt side
# reads it in prompts/messenger_prompt.py, and routers/messenger.py drives the
# lifecycle (create -> advance -> complete -> create the next one).
#
# The dimensions are sampled here rather than left to the model: asking an LLM
# for "a scene" repeatedly converges on the same three scenes, whereas one draw
# per list does not. The LLM's job (llm_call.generate_scene) is only to turn the
# draw into something concrete.

SCENE_DIMENSION_KEYS = (
    "setting", "character_goal", "user_goal", "complication", "completion_condition",
)


def pick_scene_dimensions(previous: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    """Draw one item per dimension from prompts/helpers/scene_dimensions.json.

    `previous` is the scene that just ended, if any: its setting and character
    goal are excluded from the draw so two scenes in a row never open the same
    way. Returns {} when the dimensions file is missing or malformed — the caller
    treats that as "run without a scene" rather than inventing one.
    """
    dims = load_helper_json("scene_dimensions") or {}
    settings_list = [s for s in dims.get("settings", []) if s]
    goals = [g for g in dims.get("character_goals", []) if g.get("goal")]
    secret_goals = [g for g in dims.get("secret_goals", []) if g.get("goal")]
    user_goals = [u for u in dims.get("user_goals", []) if u]
    complications = [c for c in dims.get("complications", []) if c]
    if not (settings_list and goals and user_goals and complications):
        return {}

    # Task 5.3: a secret scene is drawn from its own goal list. Never twice in a
    # row — back to back they stop being a change of gear and turn into a quiz.
    want_secret = (
        bool(secret_goals)
        and (previous or {}).get("type") != "secret"
        and random.random() < SECRET_SCENE_CHANCE
    )
    pool = secret_goals if want_secret else goals

    prev = previous or {}
    # Only apply the exclusion while it still leaves something to pick from.
    fresh_settings = [s for s in settings_list if s != prev.get("setting")] or settings_list
    fresh_goals = [g for g in pool if g["goal"] != prev.get("character_goal")] or pool

    goal = random.choice(fresh_goals)
    draw = {
        "setting": random.choice(fresh_settings),
        "character_goal": goal["goal"],
        "user_goal": random.choice(user_goals),
        "complication": random.choice(complications),
        "completion_condition": goal.get("completion", "the goal is settled one way or the other"),
        # Task 5.2: how the character carries this scheme forward once its turn
        # budget runs out. Tied to the goal (not the draw as a whole) so it
        # stays coherent with what actually happened, and not part of
        # SCENE_DIMENSION_KEYS — generate_scene never rewrites these.
        "mood_after": goal.get("mood_after", ""),
        "energy_after": goal.get("energy_after", ""),
        "type": "secret" if want_secret else "standard",
    }
    if want_secret:
        # A secret scene is the one type whose outcome we actually learn, so it
        # carries a mood for each ending instead of 5.2's hedged single line.
        # mood_after stays populated as the fallback for anything that reads it
        # without knowing about secrets.
        draw["secret_kind"] = goal.get("secret_kind", "")
        draw["mood_after_solved"] = goal.get("mood_after_solved", "")
        draw["mood_after_unsolved"] = goal.get("mood_after_unsolved", "")
        draw["mood_after"] = goal.get("mood_after_unsolved", "")
        # The shared user_goals pool is drawn independently, which is fine for a
        # standard scene and wrong for this one: in a secret scene the learner's
        # goal IS the secret, and a stray "make a plan with you for later" would
        # be pulling against the only thing the scene is about.
        if draw["secret_kind"]:
            draw["user_goal"] = f"work out {draw['secret_kind']}"
    return draw


def new_scene(dimensions: Dict[str, str], concretized: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Build a fresh active scene from a dimension draw.

    `concretized` is llm_call.generate_scene's output when it succeeded; each of
    its non-empty fields overrides the raw dimension of the same name. A failed
    or skipped generation therefore degrades to the drawn dimensions verbatim,
    which are already playable — the scene layer never depends on that call.

    Task 5.3 is the one exception: a secret scene needs a concrete secret and
    target-language phrasings to match guesses against, and neither exists in the
    language-neutral dimension data. Without them the scene demotes to a standard
    one rather than playing a secret nobody can name.
    """
    scene = {
        "id": f"scene_{int(time.time() * 1000)}",
        "created_at": int(time.time()),
        "turn_budget": random.randint(SCENE_MIN_TURNS, SCENE_MAX_TURNS),
        "turns_elapsed": 0,
        "status": "active",
        "source": "dimensions",
    }
    for key in SCENE_DIMENSION_KEYS:
        scene[key] = dimensions.get(key, "")
    # Task 5.2's mood/energy carry-forward. Drawn, not generated — kept outside
    # SCENE_DIMENSION_KEYS so the concretization merge below never touches them.
    scene["mood_after"] = dimensions.get("mood_after", "")
    scene["energy_after"] = dimensions.get("energy_after", "")
    # A secret scene keeps its DRAWN completion condition. The drawn one already
    # says exactly the right thing ("the learner has named who told you") and is
    # guaranteed to agree with secret_kind; a rewritten one is free to drift into
    # naming a different kind of thing than the secret actually is, and then the
    # scene's ending and its secret are two different targets. Observed live.
    mergeable = [k for k in SCENE_DIMENSION_KEYS
                 if not (dimensions.get("type") == "secret" and k == "completion_condition")]
    if concretized:
        for key in mergeable:
            value = concretized.get(key)
            if isinstance(value, str) and value.strip():
                scene[key] = value.strip()
                scene["source"] = "llm"

    # --- Task 5.3: secret scenes ---
    scene["type"] = dimensions.get("type", "standard")
    if scene["type"] == "secret":
        secret = (concretized or {}).get("secret", "")
        aliases = [
            a.strip() for a in (concretized or {}).get("secret_aliases", [])
            if isinstance(a, str) and a.strip()
        ]
        if secret and aliases:
            scene["secret"] = secret.strip()
            scene["secret_aliases"] = aliases
            scene["secret_solved"] = False
            scene["mood_after_solved"] = dimensions.get("mood_after_solved", "")
            scene["mood_after_unsolved"] = dimensions.get("mood_after_unsolved", "")
        else:
            print("[SCENE] no secret generated — demoting to a standard scene")
            scene["type"] = "standard"
    return scene


def _normalize_guess(text: str) -> str:
    """Lowercase, strip accents and punctuation, collapse whitespace.

    Same shape as the guessing game's `_normalize_for_matching` (llm_call.py) —
    the accent/punctuation tolerance the whole app promises applies to naming a
    secret too, or the learner gets told "no" for a missing tilde.
    """
    text = unicodedata.normalize("NFD", (text or "").lower())
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    text = re.sub(r"[^\w\s]", " ", text)
    collapsed = re.sub(r"[_\s]+", " ", text).strip()
    # Padded with spaces so callers can test whole word-sequence containment.
    return f" {collapsed} "


def check_secret_guess(scene: Dict[str, Any], user_input: str) -> bool:
    """Did the learner just NAME the secret? Records it on the scene and returns it.

    Local matching, no LLM call — the app's own rule is to try a free match
    before paying for one (see checkFuzzyMatch), and the guessing game this is
    ported from already worked this way. An alias must appear as a whole
    word-sequence: bare substring matching would fire "la fiesta" inside
    "manifiesta", and a scene that ends on a false positive is worse than one
    that runs a turn long.
    """
    if not scene or scene.get("type") != "secret" or scene.get("secret_solved"):
        return False
    haystack = _normalize_guess(user_input)
    for alias in scene.get("secret_aliases", []):
        needle = _normalize_guess(alias)
        if len(needle.strip()) >= 3 and needle in haystack:
            scene["secret_solved"] = True
            scene["solved_at_turn"] = scene.get("turns_elapsed", 0) + 1
            return True
    return False


def advance_scene(profile: Dict[str, Any]) -> None:
    """Count the turn that just finished against the active scene's budget.

    Completion is normally the turn budget running out, not a flag from the
    model: the completion condition is what the *character* is playing toward,
    and the prompt's final-turn instruction is what makes it land. Deciding it
    here keeps scene length predictable and keeps the output schema (static
    prefix) untouched.

    A solved secret scene (task 5.3) is the one early exit, and it is the point
    of the mechanic: the learner earns the ending by extracting the secret, so it
    closes on the turn they name it however much budget was left.
    """
    scene = profile.get("scene")
    if not scene or scene.get("status") != "active":
        return
    scene["turns_elapsed"] = scene.get("turns_elapsed", 0) + 1
    budget_spent = scene["turns_elapsed"] >= scene.get("turn_budget", SCENE_MAX_TURNS)
    if budget_spent or scene.get("secret_solved"):
        scene["status"] = "complete"
        scene["completed_at"] = int(time.time())
        update_character_state(profile, scene)


# --- Persistent character state (task 5.2) ---
#
# recent_turns is a rolling window of 10 and a scene resets to a brand new
# premise every 5-10 turns, so nothing about the character survives a session
# on its own. update_character_state folds a just-completed scene into a small
# persistent object next to level_history: the open thread the scheme left
# behind, plus a mood/energy carried forward from it. Deliberately no LLM call
# here — the scene ends on a turn budget, not a model verdict, so there is no
# real "how it went" to ask for; the situation line is written to work as a
# callback either way (see scene_dimensions.json's mood_after/energy_after).

def update_character_state(profile: Dict[str, Any], completed_scene: Dict[str, Any]) -> None:
    """Carry a just-completed scene's premise into the character's persistent state.

    Overwrites any previous character_state — only the most recent scheme is
    kept, matching level_history's "current level" rather than an accumulating
    log. Mutates `profile` in place, same as advance_scene/new_scene; the
    caller's save_profile persists it.
    """
    situation = completed_scene.get("character_goal", "").strip()
    completion = completed_scene.get("completion_condition", "").strip()
    mood = completed_scene.get("mood_after", "")

    if completed_scene.get("type") == "secret":
        # The one scene type whose outcome we actually know (task 5.3): the
        # learner either named the secret or ran out of turns, so the callback
        # can state what happened instead of 5.2's honest hedge.
        solved = bool(completed_scene.get("secret_solved"))
        secret = completed_scene.get("secret", "").strip()
        if situation:
            if solved:
                situation = f"{situation} They worked it out — it was {secret}, and they said it to your face."
            else:
                situation = f"{situation} They never worked out that it was {secret}, and you never told them."
        mood = completed_scene.get(
            "mood_after_solved" if solved else "mood_after_unsolved", ""
        ) or mood
    elif situation and completion:
        situation = f"{situation} It was supposed to end when {completion} — never actually found out how it went."

    profile["character_state"] = {
        "situation": situation,
        "mood": mood,
        "energy": completed_scene.get("energy_after", ""),
        "updated_at": int(time.time()),
    }


# --- Level Assessment Logic ---

def _normalize_tag(item: str) -> list:
    """Normalize a weak_points/comfortable_with entry to a word list for comparison."""
    return re.sub(r"\s+", " ", item.strip().lower()).split(" ")


def _is_near_duplicate(a: str, b: str) -> bool:
    """True if `a` and `b` are the same tag, or one is a whole-word prefix of the other.

    Short freeform LLM-generated phrases drift turn to turn ("grammar" vs "grammar
    structure"), and exact-string dedup alone lets the same underlying issue pile up under
    several spellings. Word-prefix (not raw substring) matching avoids false positives like
    "issue-1" vs "issue-12", which share characters but aren't the same tag at all.
    """
    wa, wb = _normalize_tag(a), _normalize_tag(b)
    shorter, longer = (wa, wb) if len(wa) <= len(wb) else (wb, wa)
    return bool(shorter) and longer[: len(shorter)] == shorter


def _upsert_tag(items: list, candidate: str, cap: int) -> None:
    """Add `candidate` to `items`, merging near-duplicates and capping to the most recent `cap`.

    On a merge, the more specific (longer) phrasing wins, and the entry moves to the end of
    the list either way — so a tag that keeps getting reaffirmed survives eviction, while
    eviction drops whichever entries nobody has re-flagged in a while first (the front).
    """
    for i, existing in enumerate(items):
        if _is_near_duplicate(existing, candidate):
            items.pop(i)
            candidate = candidate if len(candidate) > len(existing) else existing
            break
    items.append(candidate)
    if len(items) > cap:
        del items[: len(items) - cap]


def update_profile_from_assessment(
    profile: Dict[str, Any],
    assessment: Dict[str, Any]
) -> tuple:
    """Update profile based on LLM assessment. Returns (profile, profile_updated)."""
    current_level = profile.get("level", "beginner")
    new_level = assessment.get("current_level", current_level)
    confidence = assessment.get("confidence", 0.5)
    should_update = assessment.get("should_update", False)

    # Update comfortable_with
    for item in assessment.get("add_comfortable", []):
        _upsert_tag(profile["comfortable_with"], item, MAX_COMFORTABLE_WITH)
    # Defensive: also trim if the list was already over cap before this call (e.g. legacy
    # profiles saved before comfortable_with had a cap at all).
    if len(profile["comfortable_with"]) > MAX_COMFORTABLE_WITH:
        del profile["comfortable_with"][: len(profile["comfortable_with"]) - MAX_COMFORTABLE_WITH]

    # Update weak_points
    for item in assessment.get("add_weak", []):
        if item.strip().lower() in DISALLOWED_WEAK_POINTS:
            continue
        _upsert_tag(profile["weak_points"], item, MAX_WEAK_POINTS)

    for item in assessment.get("remove_weak", []):
        if item in profile["weak_points"]:
            profile["weak_points"].remove(item)

    if len(profile["weak_points"]) > MAX_WEAK_POINTS:
        del profile["weak_points"][: len(profile["weak_points"]) - MAX_WEAK_POINTS]

    # Update level if assessment says so and confidence is high
    if should_update and confidence >= 0.7 and new_level != current_level:
        profile["level"] = new_level
        profile["level_confidence"] = confidence
        profile["level_history"].append({
            "timestamp": int(time.time()),
            "level": new_level,
            "reason": assessment.get("reasoning", "LLM assessment")
        })
        return profile, True  # profile_updated flag

    # Just update confidence even if not changing level
    profile["level_confidence"] = confidence
    return profile, False
