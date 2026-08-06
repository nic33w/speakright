# SpeakRight — Task Queue

Ordered backlog from the 2026-08-05 brainstorm. Work top to bottom; dependencies are noted where
order actually matters — everything else can be reordered freely.

## How to use this file

**Starting a task in a fresh session:** check the model tag, `/model` to switch, then say
**"do task 1.1 from TASKS.md"**. Naming the file matters — a new session gets `CLAUDE.md`
automatically but not this one.

**If you are an agent picking up a task from this file:**

1. Read the **Ground rules** below before touching anything — they apply to every task.
2. Do only the numbered task asked for. Adjacent tasks are deliberately scoped separately; if you
   spot work that belongs to another one, note it and leave it alone.
3. **Line numbers in this file drift.** They were accurate when written and earlier tasks move them.
   Treat them as hints — every task also describes *what* to look for, so grep to confirm before
   editing, and never edit by line number alone.
4. Check the task's **Depends on** line against the checkboxes. If a dependency is still `[ ]`, say
   so before starting rather than working around it.
5. When the task is done and its tests pass, tick its checkbox (`### [ ]` → `### [x]`) and fix any
   line numbers in *other* tasks that your change invalidated.

## Model legend

| Tag | Model | Use for |
|---|---|---|
| 🔴 **Opus** | `claude-opus-5` | Architecture, prompt redesign, anything touching the prompt-cache invariant, new subsystems, calls where the right answer is genuinely ambiguous |
| 🟡 **Sonnet** | `claude-sonnet-5` | Well-specified implementation inside 1–3 known files |
| 🟢 **Haiku** | `claude-haiku-4-5-20251001` | Mechanical edits, config, one-liners, batch scripts |

Switch with `/model` before starting a task.

## Ground rules for every task

- Backend python is the venv: **`backend/venv/Scripts/python.exe`** — the system `python` on PATH
  lacks fastapi and will fail at conftest import.
- Run `venv/Scripts/python.exe -m pytest tests/ -q` from `backend/` after any backend change.
  Baseline is **62 passed, 1 xfailed**.
- **Never break the messenger prompt-cache invariant** — the static prefix must stay byte-identical
  across turns. `tests/test_prompt_snapshot.py` enforces it; if it fails, the fix is to move the new
  content into the dynamic tail, not to update the golden.
- Shared behavior goes in the shared layer (`sharedGameHooks.ts` / `sharedGameUtils.ts` /
  `config.ts` / `prompt_fragments.py`), never inline in one mode. See CLAUDE.md.
- Check `/api/usage` before anything that generates audio in bulk.

## Done

- ✅ **Jorge persona — now the default.** `backend/prompts/persona/jorge.json`. Funny, spicy,
  permanently scheming; pranks are victimless and backfire on him. `settings.py:PERSONA` defaults to
  `jorge`; set `MESSENGER_PERSONA=sombongo` in `backend/.env` to switch back. The UI name comes from
  `/api/config` → `persona_display_name`, so it follows the setting — **never hardcode a character
  name in `MessengerChat.tsx`.** Prompt goldens pin `GOLDEN_PERSONA = "sombongo"` on purpose
  (`tests/test_prompt_snapshot.py`) so switching persona doesn't re-baseline the snapshot suite.
  **See task 5.0 first — Jorge will feel flat until persona tuning is actually wired up:** his
  `meta.temperature: 0.9` is still ignored and the call runs at the `0.2` default.

---

# Phase 1 — Latency (do this first)

The response doesn't just *feel* slow, it *is* slow, and then ~6.6s of deliberate fake delay is
added on top. Phase 1 is mostly deletion and reordering. Highest payoff per hour in the whole file.

### [x] 1.1 — Make the fake reaction delays absorb real latency instead of adding to it 🟡 Sonnet

**Problem:** `MessengerChat.tsx:625-700` does `await fetch` → *then* `await` the reading/thinking/
typing animation (900ms + 700–2200 + 400–700 + 800–2800 = up to ~6.6s). Real latency and simulated
latency stack.

**Fix:** Start the reaction animation the instant the user hits send, concurrently with the fetch.
When the response lands, cut short whatever animation remains. Same perceived character behavior,
but the animation now hides 3–4s of real latency.

**Files:** `frontend/src/MessengerChat.tsx` (the `sendMessage` flow, ~line 600–800).

**Timing rules (settled — get these right or it reads as an animation, not a person):**

- **Start the phase machine at send time, but not the `reading` indicator at t=0.** `typing` at t=0
  is implausible — nobody starts typing the instant a message lands. Use the existing
  `processingMsgId` (already set at line 605, before the fetch) as the pre-reading beat for
  ~200–400ms, then hand off to `reading`. No dead air, no invented delay.
- **Jitter the handoff** (~150–400ms randomized). Identical timing every turn is what makes a
  simulation feel like one.
- **Ceiling:** the animation never extends past the response arriving — cut it short. That's the point.
- **Floor:** ~800ms–1s minimum total, so a fast response doesn't flicker through all three phases in
  a few frames. This is the one place you deliberately *add* delay, and it's justified.
- **On cut-short, never hard-cut to the bubble.** If the response lands before `typing` is reached,
  jump to `typing` and hold ~300ms first. A typing indicator immediately preceding the message is the
  load-bearing piece of the illusion; a bubble appearing while the indicator still says "reading"
  breaks it worse than a slightly longer wait.
- **Drop the `delay(900)` entirely.** Its comment says it's there so the user can read their
  correction — that only worked because the correction rendered before it. Concurrently, the
  correction now arrives mid-animation, which is better: you read it while the character visibly
  composes. Don't relocate the 900ms, delete it.

**Watch for:** `firstChunkLen` drives the typing-phase length and isn't known until the response
arrives — needs a sensible default that gets corrected on arrival.

---

### [x] 1.2 — Stop awaiting the `corrected_input` TTS before updating the UI 🟢 Haiku

**Problem:** `MessengerChat.tsx:641` awaits `fetchAudioUrl(data.corrected_input, locale)` before the
user's own message bubble updates. That string is almost always novel → always a cache miss → a full
Azure roundtrip blocking the render.

**Fix:** Fire it without awaiting; attach `userAudioFile` to the message when it resolves. Keep the
`input_intent === "english"` auto-play, just move it into the `.then`.

**Files:** `frontend/src/MessengerChat.tsx`. **Do with 1.1** — same function, same test pass.

---

### [x] 1.3 — Parallelize per-chunk TTS in the messenger turn 🟡 Sonnet

**Problem:** `routers/messenger.py:314-356` loops chunks and generates TTS serially, after the LLM
finishes. Three audio chunks = three sequential Azure roundtrips at `timeout=20` each.

**Fix:** Collect the cache-miss chunks, generate them concurrently (`ThreadPoolExecutor` — the
endpoint is a sync `def` running in FastAPI's threadpool, so threads are fine), then reassemble in
original order.

**Files:** `backend/routers/messenger.py`, possibly `backend/audio_utils.py`.

**Watch for:** chunk order must be preserved exactly — playback depends on it. Cache-hit chunks
should skip the pool. Keep the per-chunk silence fallback on failure.

---

### [x] 1.4 — Prune `weak_points` 🟡 Sonnet

**Problem:** CLAUDE.md flags `profiles/default_profile.json` → `weak_points` as unbounded with junk
entries. A bloated list makes the student model noisy, which makes responses blander and more
remedial — and it inflates the dynamic tail on every single turn.

**Fix:** Cap the list (~10–15), evict by staleness/recency, dedupe near-identical entries. Same for
`comfortable_with`. Note `settings.MAX_WEAK_POINTS = 8` already exists — check whether it's actually
enforced anywhere before adding a second mechanism.

**Files:** `backend/profile_store.py` (`update_profile_from_assessment`).

**Filed under latency** because it shrinks every prompt, but the real win is response *quality* —
it's a prerequisite for Phase 5 feeling like an improvement.

---

### [x] 1.5 — Trim suggested replies 🟡 Sonnet

**Problem:** 3 suggestions × 2 strings ≈ 70 output tokens ≈ most of a second of latency, for the
last thing rendered on screen.

**Fix:** Drop to 2 suggestions, or generate them only on alternating turns.

**Files:** `backend/prompts/messenger_prompt.py` (`max_suggestions`, `suggestion_section`),
`backend/prompts/helpers/suggestion_system.json`.

**⚠️ Cache invariant:** `suggestion_section` lives in the **static prefix**. Changing the count
permanently is fine (still byte-identical turn to turn). "Every other turn" is **not** — that must be
driven from the turn instruction in the dynamic tail, with the schema section left untouched.

---

### [x] 1.6 — Stream the response + reorder the output schema 🔴 Opus

**Problem:** `llm_call.py:320` is one blocking `responses.create` with no streaming. The entire JSON —
corrections, translation, 3 suggestions, sometimes a level assessment — is generated before a single
bubble renders. Output tokens dominate latency and most of them aren't needed for bubble 1.

**Fix:** Reorder the schema in `messenger_prompt.py:182` so `response_chunks` comes **first**, then
correction fields, then `suggested_replies`, then `level_assessment`. Turn on `stream=True` and parse
partial JSON so bubble 1 renders while suggestions are still generating. One call, no extra cost.

**Files:** `backend/llm_call.py`, `backend/prompts/messenger_prompt.py`,
`backend/routers/messenger.py` (becomes a streaming response), `frontend/src/MessengerChat.tsx`.

**Depends on:** 1.1 (otherwise the fake delays swallow the gain anyway).

**Shipped as:** a second endpoint, `POST /api/messenger/turn/stream` (NDJSON), rather than converting
`/api/messenger/turn` in place. The buffered endpoint is byte-for-byte unchanged and still serves
premade conversations, the test suite, and the frontend's automatic fallback. Both paths share
`_prepare_chunk` / `_run_tts` / `_finalize_turn` in `routers/messenger.py`, so there is one source of
truth for turn logic. Incremental parsing is `StreamingArrayScanner` in `llm_call.py`.

**⚠️ UX change to watch:** corrections now land on your own bubble *after* the reply starts
rendering, because `response_chunks` is generated first. This is the peripheral-vision model from
Phase 3 arriving early. If it reads badly, the fix is in `applyFinal` (MessengerChat.tsx), not in the
schema order.

**⚠️ Still unverified:** the correction-quality A/B. The concern was that the model may correct
better when it processes input *before* composing a reply. Mitigated in-prompt ("silently work out
what the user meant … before you write" in the reminders), but **not measured against real API
calls** — mock mode can't test it. Watch `chat_log_es.md` for a few real sessions and compare
against pre-`583fe25` entries.

---

# Phase 2 — Foundations (small, unblocks Phases 3 & 4)

### [ ] 2.1 — Parameterize TTS rate and add it to the cache key 🟡 Sonnet

**Fix:** `tts_helpers.py:52` already emits `<prosody rate='0%'>` — expose rate as a parameter so
"say it slower" (0.75×) becomes possible. Add a rate param to the audio endpoint.

**Files:** `backend/tts_helpers.py`, `backend/audio_utils.py`, `backend/routers/audio.py`.

**⚠️ Critical:** the cache key is currently `text|locale` and does **not** include rate. Add rate to
the key *in the same commit*, or slow audio will be served at normal speed forever from a poisoned
cache. Existing cached files stay valid as the rate-0 variant.

**Unblocks:** 3.4 (spoken corrections — a repeat-after-me sentence should be slower), 4.2.

---

### [ ] 2.2 — Build an explicit replay stack 🟡 Sonnet

**Fix:** A flat, ordered list of `(text, locale, source, audioUrl)` covering every audio-bearing item
in the session — character chunks *and* the user's own corrected sentences. Needed for eyes-free and
controller history navigation. Derive it once into state; don't recompute from `messages` on every
button press.

**Files:** `frontend/src/MessengerChat.tsx`, likely a new hook in `frontend/src/sharedGameHooks.ts`.

**Unblocks:** 3.3, 4.3.

---

### [ ] 2.3 — Earcon grammar 🟢 Haiku

**Fix:** Distinct short tones for a fixed vocabulary of events. A handful of tiny WAVs or a WebAudio
oscillator. Non-speech audio parses far faster than spoken labels and is essential once the screen is
off.

| Event | Suggested tone |
|---|---|
| **Recording started** | short rising two-note blip |
| **Recording stopped** | short falling two-note blip (deliberately the inverse — unmistakable as a pair) |
| Send cancelled | single low thud |
| Correction incoming | soft double tick |
| Attempt passed / failed | bright chime / muted buzz |

**Recording start/stop are the highest-priority pair** — they're what make press-to-toggle recording
(4.1) viable without looking at the screen. Make them obvious inverses of each other so the state is
never ambiguous, and keep both under ~200ms so they don't eat into speech.

**Files:** new `frontend/src/audio/earcons.ts`, `frontend/src/sharedGameHooks.ts`.

**Unblocks:** Phase 3, and 4.1's toggle-record design.

---

# Phase 3 — Eyes-free mode + spoken corrections

**Reframed after your clarification:** eyes-free isn't "read the screen aloud." It's *"I don't want
to look at corrections."* That makes correction delivery **the** eyes-free problem, not a separate
feature — so the old Phase 5 (eyes-free) and Phase 6 (feedback ladder) are merged here and moved up.

**Revision to my earlier "never interrupt" advice:** that was right for the *visual* app, where a
correction can sit in your peripheral vision while the conversation continues. Eyes-free has no
peripheral channel — audio is strictly serial, so a correction that isn't spoken is a correction that
doesn't exist. The question therefore changes from *"should it interrupt?"* to *"which corrections
are worth interrupting for?"* Answer: gate on severity (3.4). Minor naturalness nits get deferred to
the quiz (3.7); real errors interrupt with "try saying X."

Build this **keyboard-first** (a couple of hotkeys) so it's fully usable before the controller exists.

### [ ] 3.1 — Budget check + English voice config 🟢 Haiku

**Fix:** Voicing English roughly **4–5×'s** Azure character consumption against a 500k/month cap.
Check `/api/usage` headroom and confirm `AZURE_VOICE_EN` is actually set in `.env` — `VOICE_MAP`
needs a real English entry or it silently falls back to whatever's first in the dict.

**Files:** `backend/settings.py`, `backend/.env` (report only — never print or commit contents).

**Do this before 3.2 or 3.3.**

---

### [ ] 3.2 — Pre-generated English reaction bank 🟡 Sonnet

**Fix:** Pre-generate ~50 common English persona reactions as static files (follow the
`scripts/generate_greeting_audio.py` pattern) and constrain the prompt to pick chunk 1 from that
fixed set. Zero marginal cost, zero latency, and the *first* thing you hear becomes instant.

Doubles as a Phase 1 task — it attacks perceived slowness too.

**Files:** new `backend/scripts/generate_reaction_audio.py`, `backend/prompts/messenger_prompt.py`,
`frontend/public/`.

**Depends on:** 3.1. **Note:** bank must be regenerated per persona — Jorge and Sombongo don't share
reactions.

---

### [ ] 3.3 — Eyes-free prompt profile 🔴 Opus

**Fix:** Eyes-free needs a *different prompt profile*, not TTS bolted onto the existing one. Naively
voicing the current 70–80%-English output yields a ~40-second serial blob per turn. Required changes:
fewer and shorter chunks, `suggested_replies` **not** read aloud (that alone is ~15 seconds), and
`error_explanation` rewritten to be *listenable* — one spoken sentence, not a written note.

**Files:** `backend/prompts/messenger_prompt.py`, `backend/routers/messenger.py`,
`backend/models.py`.

**⚠️ Cache invariant:** eyes-free is a third `prompt_version` alongside v1/v2. Version-conditional
static sections are fine (see how `v2_section` is handled) as long as each version's prefix is
byte-identical *within* a run. Add a golden to `tests/test_prompt_snapshot.py`.

**Depends on:** 3.1, 2.3.

---

### [ ] 3.4 — Spoken correction: "try saying [sentence]" 🔴 Opus

**The core eyes-free feature.** When you say something wrong, the app speaks the correction as a
repeat-after-me prompt instead of drawing a diff you'd have to look at.

**Flow:** error detected → earcon → *"Try saying: «[corrected sentence]»"* (target sentence spoken at
0.75× via 2.1) → mic opens → you attempt it → pass/fail earcon → conversation resumes.

**Severity gate (the important design call):** only interrupt when `had_errors` is true **and** the
error is substantive. Minor naturalness nits and accent/punctuation issues must never interrupt —
they go to the deferred quiz (3.7). The gate needs a severity field the LLM emits; add it to the
schema alongside `had_errors`.

**Optional audio explanation:** on demand only — one hotkey/button replays the *why* (a spoken
one-sentence version of `error_explanation`). Never automatic; it doubles the interruption length.

**Files:** `backend/prompts/messenger_prompt.py` (severity field), `backend/models.py`,
`backend/routers/messenger.py`, `frontend/src/MessengerChat.tsx`.

**Depends on:** 2.1, 2.3, 3.3.

---

### [ ] 3.5 — Retry check for the repeat-after-me attempt 🟡 Sonnet

**Fix:** Score the attempt from 3.4. **Start with the cheap version:** compare Wispr's text output to
the reference sentence with the existing `checkFuzzyMatch` / `normalizeForMatch` from
`sharedGameUtils.ts`. Costs $0 and reuses machinery you already have.

**Known limitation, accept it for now:** this checks *word production*, not pronunciation — Wispr
emits cleaned-up fluent text, so it will silently fix some errors. Good enough to answer "did I
produce the right sentence." Real pronunciation scoring is task 6.1.

**Files:** `frontend/src/MessengerChat.tsx`, `frontend/src/sharedGameUtils.ts`.

**Depends on:** 3.4.

---

### [ ] 3.6 — Audio pairing modes 🟡 Sonnet

**Fix:** Three playback modes — target-only / EN→ES pairs (English first, then Spanish) / alternating
(chunks alternate languages with *no* paired translation, forcing unaided comprehension).

**Files:** `frontend/src/MessengerChat.tsx` (`playResponseAudio`, ~line 805).

**Depends on:** 3.1, 2.2.

---

### [ ] 3.7 — Deferred quiz drills for sub-threshold errors 🟡 Sonnet

**Fix:** Flip `ENABLE_QUIZZING=1`. Everything the 3.4 severity gate declines to interrupt for becomes
a quiz item, resurfacing 3–5 turns later as a "try saying X" mini-challenge — same UX as 3.4, just
scheduled instead of immediate.

**Files:** `backend/.env`, `backend/quiz_store.py`, `backend/prompt_fragments.py`
(`quiz_candidate_rules`), `frontend/src/MessengerChat.tsx`.

**⚠️ Cache invariant:** `ENABLE_QUIZZING` changes the static prefix (adds `quiz_candidates_schema`
and `quiz_rules_section`). Fine — it's constant within a run — but the first turn after flipping it
misses the prompt cache, and the snapshot goldens need updating.

**Depends on:** 3.4.

---

# Phase 4 — Xbox controller

### [ ] 4.1 — Controller → F13 mapper 🟡 Sonnet

**Corrected from the first draft — your F13 idea is right and it removes the WebSocket relay
entirely.** Map a controller button to **F13** (a real keycode no application claims), set F13 as
Wispr's hotkey, and let the browser Gamepad API handle everything else in-page. No IPC, no backend
router, no custom protocol.

To be precise about the original objection: the constraint is only that *the browser* can't
synthesize an OS-level keystroke. A tiny native mapper still has to exist — but it's a dumb key
sender, not an architecture.

**Mapper options:**
- **Steam Input** — add your browser as a non-Steam game, map buttons to keys. Zero code, handles
  XInput correctly.
- **Python + `XInput-Python` + `keyboard`** — ~20 lines, full control, easy to version alongside the
  repo. Recommended if you want it in-repo.
- **JoyToKey / reWASD** — GUI mappers, also fine.

**⚠️ Avoid AutoHotkey for this.** AHK's joystick support uses the legacy WinMM API, which **combines
LT and RT onto a single shared axis** — so "hold RT to talk" and "hold LT for translation" can't be
told apart cleanly, and holding both cancels out. That directly breaks the 4.2 mapping. Use an
XInput-aware mapper instead.

**Free bonus worth designing around:** when the browser is focused it *also* receives the F13 keydown.
Use that as the in-app "recording started" signal — the recording indicator and earcon sync for free,
with zero IPC. Just make sure F13 is handled deliberately rather than ignored.

**Real caveat to know:** `navigator.getGamepads()` only reports while the document is focused, and
needs a user gesture before gamepads are exposed. Fine in practice — the app is what you're looking
at — but if you background the window during eyes-free, in-page buttons go dead while F13/Wispr keeps
working. If that turns out to bite, *then* revisit the WebSocket relay.

**Files:** new `tools/controller/` (mapper script), `frontend/src/sharedGameHooks.ts` (new
`useGamepad` hook), `frontend/src/MessengerChat.tsx`.

**Recording is press-to-toggle, not hold** (settled): click a stick (L3 *or* R3) to start recording,
click again to stop → auto-send window opens. Earcons from 2.3 announce start and stop, which is what
makes this safe with the screen off.

Three things this requires:
1. **Wispr must be in tap/toggle mode for F13**, not hold-to-talk — otherwise a single tap starts and
   immediately ends dictation. Check Wispr's hotkey settings before writing any code.
2. **Mapper sends a clean F13 tap on the press edge only** — no auto-repeat while the stick stays
   clicked, or you'll toggle Wispr dozens of times per second.
3. **Desync guard.** The app infers recording state by counting F13 events; Wispr holds the real
   state. A dropped keypress desyncs them, so the earcon would lie. Mitigate by re-syncing whenever
   transcript text actually arrives (text arriving ⇒ recording ended), and keep the stop earcon
   driven by that signal rather than by the keypress alone where possible.

Also check whether Wispr plays its own start/stop sound — if so, disable one side so you don't get
doubled cues.

---

### [ ] 4.2 — Map the per-turn action buttons 🟡 Sonnet

| Control | Action |
|---|---|
| **L3 / R3** (click either stick) | Toggle recording on/off (via F13) — earcon on each edge |
| **B** (East) | Cancel pending send / stop audio |
| **A** (South) | Repeat last target sentence |
| **Y** (North) | Repeat **slower** (0.75×) — needs 2.1 |
| **X** (West) | Explain that — spoken `error_explanation` (3.4) |
| LT (hold) | Hold to hear the English translation |

**Design notes:**
- **Cancel is B**, not a stick flick — thumbs rest on sticks and accidental cancels will be common.
  Optionally *also* accept a hard deflection past a large deadzone (>0.7) as a deliberate flick.
  Redundant cancel is fine; redundant confirm is not.
- Drive the existing `useWisprAutoSend` hook — do **not** spin up a parallel cancel timer.
- **LT translation is free** in v2: the challenge chunk already carries `native_text`, so revealing or
  speaking it costs zero LLM calls. It's the controller version of the hover-reveal you already built.
- **RT is unassigned** now that recording moved to the stick click — leave it open until a real need
  shows up rather than inventing one.

**Files:** `frontend/src/MessengerChat.tsx`, `frontend/src/sharedGameHooks.ts`, `tools/controller/`.

**Depends on:** 4.1, 2.1, 3.4.

---

### [ ] 4.3 — Shoulder-button replay navigation 🟡 Sonnet

**Fix:** LB steps back through the replay stack, RB steps forward. Keep the iPod semantic if you like
the feel — LB within the first 50% of playback goes back one, after 50% restarts current. (Simpler
alternative: LB/RB purely move a cursor and A replays current. Either is fine.)

**Files:** `frontend/src/MessengerChat.tsx`, `frontend/src/sharedGameHooks.ts`.

**Depends on:** 2.2, 4.1.

---

### [ ] 4.4 — Haptics 🟡 Sonnet

**Fix:** Short pulse = recording on. Double pulse = sent. Long buzz = correction incoming.

With the screen off, rumble is the *only* non-audio feedback channel — it tells you what happened
without interrupting the audio stream. This is what makes eyes-free actually usable rather than
merely possible.

**Files:** frontend `gamepad.vibrationActuator`, or `tools/controller/` for XInput rumble.

**Depends on:** 4.1.

---

### [ ] 4.5 — D-pad mode toggles 🟡 Sonnet

| Control | Action |
|---|---|
| D-pad ↑ | Toggle eyes-free mode |
| D-pad ↓ | Cycle pairing mode (target-only / EN→ES pair / alternating) |
| D-pad ← → | Change topic (pivot, `sombongo_pivots.ts`) / skip |

**Rationale:** mode toggles are session-level settings, not per-turn actions — they shouldn't consume
face buttons you press constantly. The D-pad is exactly right for infrequent settings.

**Depends on:** 4.1, 3.3, 3.6.

---

# Phase 5 — Engagement

`generate_turn_instruction` (`messenger_prompt.py:28`) returns an identical instruction every turn
except the every-5th assessment — no arc, no stakes, nothing that can resolve. A conversation that
*can't end* is structurally boring regardless of content.

### [ ] 5.0 — Wire persona tuning through to the LLM call 🟡 Sonnet

**Do this before judging Jorge.** `jorge.json` declares `meta.temperature: 0.9` and
`tuning.max_tokens: 140`, and **nothing reads either one.** `build_layered_prompt` only consumes
`display_name` / `short_bio` / `voice_notes` / greetings / examples, and `messenger.py:304` calls
`call_llm_for_messenger` with no temperature — so it uses the `0.2` default in `llm_call.py:639`.

**0.2 is very low for comedy.** A prankster persona at 0.2 will produce the same three jokes forever.
This single change probably matters more to how Jorge feels than any prompt wording.

**Fix:** return persona tuning from `build_layered_prompt` (or load it in the router) and pass
`temperature` / `max_output_tokens` through to `call_llm_for_messenger`.

**Files:** `backend/prompts/messenger_prompt.py`, `backend/routers/messenger.py`,
`backend/llm_call.py`.

**Watch for:** higher temperature raises schema-violation risk — keep an eye on malformed JSON and
on chunks that mix languages. If it gets flaky, 0.7 is a reasonable compromise.

---

### [ ] 5.1 — Scene layer with an explicit ending condition 🔴 Opus

**Fix:** Add a `scenario` object to the prompt — setting, character goal, user goal, completion
condition — plus "turns elapsed in scene: N, move toward resolution" in the turn instruction. Scenes
run **5–10 turns and then genuinely end.** The ending matters more than the premise does.

Generate scenes from dimensions (setting × character goal × user goal × complication) in one cheap
call at scene start, cached for the scene's life. Do **not** hand-author a static catalog — you'll
exhaust it and it'll feel more repetitive than what you have now.

**Jorge fits this unusually well** — a schemer *is* a character goal, so his personality and the scene
engine reinforce each other. "Jorge needs an alibi by the end of this conversation" is a scene with a
built-in ending.

**Files:** `backend/prompts/messenger_prompt.py`, `backend/profile_store.py` (scene state),
`backend/routers/messenger.py`, new `backend/prompts/templates/scene.txt`.

**⚠️ Cache invariant:** the scene goes in the **dynamic tail**. The static prefix must not learn about
specific scenes.

---

### [ ] 5.2 — Persistent character state 🟡 Sonnet

**Fix:** Give the character mood, energy, and an ongoing situation that persists across sessions,
stored next to `level_history` in the profile. Continuity — "last time you mentioned X" — is what
makes a chat partner feel alive. Right now `recent_turns` is a rolling 10 and everything else
evaporates.

For Jorge specifically: track the *consequences* of his last scheme. A prankster with memory is
funnier than one without.

**Files:** `backend/profile_store.py`, `backend/prompts/messenger_prompt.py` (dynamic tail).

**Depends on:** 5.1.

---

### [ ] 5.3 — Port the secret/information-asymmetry mechanic into messenger 🔴 Opus

**Fix:** The strongest conversation engine is the character knowing something the user has to extract.
You already built it — `GuessingGame.tsx` + `call_llm_to_pick_secret` in `llm_call.py`. This is a
merge into the scene system, not new invention.

**Files:** `backend/llm_call.py`, `backend/prompts/messenger_prompt.py`,
`frontend/src/GuessingGame.tsx` (read for the mechanic, don't modify).

**Depends on:** 5.1 — the secret is a scene type.

---

### [x] 5.4 — Make the frontend persona-aware 🟢 Haiku (partial — pivots still Sombongo-flavored)

**Fix:** `MessengerChat.tsx` hardcodes "Sombongo" in 4 places (lines 1291, 1534, 1727, 1728), and
`data/sombongo_pivots.ts` is Sombongo-flavored. Serve `display_name` from the profile/config endpoint
and drive the UI from it, so `MESSENGER_PERSONA=jorge` renames the header and typing indicator too.

**Files:** `frontend/src/MessengerChat.tsx`, `backend/routers/misc.py` (`/api/config`),
`frontend/src/data/sombongo_pivots.ts`.

**Note:** pivots are persona-flavored content. Either make them generic or add a Jorge set — don't
have Jorge speaking Sombongo's lines.

---

# Phase 6 — Pronunciation

### [ ] 6.1 — Azure Pronunciation Assessment 🔴 Opus

**Upgrade path for 3.5.** Fuzzy text matching checks *word production*; this checks pronunciation.

**The key insight:** **Wispr actively defeats text-based pronunciation checking.** It's designed to
emit fluent, cleaned-up text, so it silently fixes errors and matching tells you nothing about how
you actually sounded.

**Fix:** Azure Speech has **Pronunciation Assessment** built in, on the same Speech resource
`AZURE_SPEECH_KEY` already pays for. Give it a reference sentence, get back per-word accuracy,
fluency, and completeness scores.

**Caveat:** needs raw mic audio via the browser Speech SDK
(`microsoft-cognitiveservices-speech-sdk`), **not** Wispr's text output. Separate input path — wire
it for the repeat-after-me drill only, never for conversation.

**Files:** `frontend/src/MessengerChat.tsx`, new `backend/routers/pronunciation.py`,
`frontend/package.json`, `backend/settings.py`.

**Depends on:** 3.5. Budget-check first — assessment is billed separately from TTS.

---

## Deliberately not scheduled

- **Automatic English-vs-target detection** — already exists. `input_intent` is in the schema and
  flows through to the UI. The X button (4.2) is an *override* for when detection is wrong, not a
  replacement for detection.
- **Fixing the premade-conversation 500** (`input_intent` missing from `MessengerTurnResponse`,
  xfail-documented in `tests/test_smoke.py`) — real bug, one-line fix, unrelated to everything above.
  Grab it any time.
- **Number Rush audio** — the mode is broken and unscheduled; not worth fixing until it's clear the
  mode is worth keeping.
