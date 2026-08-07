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
  Baseline is **89 passed, 1 xfailed** (74 before task 3.8).
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

### [x] 2.1 — Parameterize TTS rate and add it to the cache key 🟡 Sonnet

**Fix:** `tts_helpers.py:52` already emits `<prosody rate='0%'>` — expose rate as a parameter so
"say it slower" (0.75×) becomes possible. Add a rate param to the audio endpoint.

**Files:** `backend/tts_helpers.py`, `backend/audio_utils.py`, `backend/routers/audio.py`.

**⚠️ Critical:** the cache key is currently `text|locale` and does **not** include rate. Add rate to
the key *in the same commit*, or slow audio will be served at normal speed forever from a poisoned
cache. Existing cached files stay valid as the rate-0 variant.

**Unblocks:** 3.4 (spoken corrections — a repeat-after-me sentence should be slower), 4.2.

---

### [x] 2.2 — Build an explicit replay stack 🟡 Sonnet

**Fix:** A flat, ordered list of `(text, locale, source, audioUrl)` covering every audio-bearing item
in the session — character chunks *and* the user's own corrected sentences. Needed for eyes-free and
controller history navigation. Derive it once into state; don't recompute from `messages` on every
button press.

**Files:** `frontend/src/MessengerChat.tsx`, likely a new hook in `frontend/src/sharedGameHooks.ts`.

**Unblocks:** 3.3, 4.3.

---

### [x] 2.3 — Earcon grammar 🟢 Haiku

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

### [x] 3.1 — Budget check + English voice config 🟢 Haiku

**Fix:** Voicing English roughly **4–5×'s** Azure character consumption against a 500k/month cap.
Check `/api/usage` headroom and confirm `AZURE_VOICE_EN` is actually set in `.env` — `VOICE_MAP`
needs a real English entry or it silently falls back to whatever's first in the dict.

**Files:** `backend/settings.py`, `backend/.env` (report only — never print or commit contents).

**Do this before 3.2 or 3.3.**

---

### [x] 3.2 — Pre-generated English reaction bank 🟡 Sonnet

**Fix:** Pre-generate ~50 common English persona reactions as static files (follow the
`scripts/generate_greeting_audio.py` pattern) and constrain the prompt to pick chunk 1 from that
fixed set. Zero marginal cost, zero latency, and the *first* thing you hear becomes instant.

Doubles as a Phase 1 task — it attacks perceived slowness too.

**Files:** new `backend/scripts/generate_reaction_audio.py`, `backend/prompts/messenger_prompt.py`,
`frontend/public/`.

**Depends on:** 3.1. **Note:** bank must be regenerated per persona — Jorge and Sombongo don't share
reactions.

**Shipped as:** backend infra only, no playback wiring yet — nothing in the current visual UI voices
`language="ui"` chunks, so there's nothing for 3.2 to make "instant" until 3.3/3.4 turn on eyes-free
audio. What's built: a `reactions.en` bank in each `prompts/persona/*.json` (50 lines for Jorge, 30
for Sombongo), `scripts/generate_reaction_audio.py` (run manually — needs real Azure credentials, not
run yet) writing to `backend/audio_files/reactions/{persona}/{id}.wav`, a new
`GET /api/audio_file/reactions/{persona}/{filename}` route, and a static "REACTION OPENERS" block
added to the prompt's persona-scoped static prefix that constrains `response_chunks[0]` to be copied
verbatim from the bank (`purpose="reaction"`, new enum value). `_prepare_chunk` in
`routers/messenger.py` resolves an exact-text match to the pre-generated URL and attaches it as the
new `ResponseChunk.reaction_audio_file` field — populated now, unused by the frontend until eyes-free
needs it. Prompt goldens re-baselined (`tests/goldens/` deleted and regenerated); full suite still 62
passed, 1 xfailed.

---

### [x] 3.3 — Eyes-free prompt profile 🔴 Opus

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

**Shipped as:** `prompt_version="eyesfree"`, a third profile alongside v1/v2 —
`PROMPT_VERSIONS` + `normalize_prompt_version()` in `prompts/messenger_prompt.py` (unknown versions
fall back to v1 so a typo can't mint a fourth cache entry). The eyes-free prefix caps the turn at
**exactly 2 chunks** — the verbatim reaction opener from 3.2 (free pre-generated audio, which also
keeps live English TTS and its 4–5× Azure cost out of the loop) plus one ≤12-word target sentence
carrying `native_text` and `is_challenge` (v2's shape, so 3.6's pairing modes and 4.2's LT-translate
get it for free) — replaces the SUGGESTION GENERATION RULES section outright with "emit `[]`" rather
than contradicting it, and requires `error_explanation` to be one ≤15-word spoken sentence with no
quotes/parens/lists. `_apply_output_gates` takes the version and force-empties `suggested_replies`
for eyes-free so a drifting model can't smuggle ~15s of unusable audio into the turn. Goldens
extended to 3 versions (18 files, 6 new); new prompt tests cover prefix distinctness, the
suggestion-suppression, and unknown-version fallback; new smoke test covers the eyes-free route
(the only messenger test that exercises `_prepare_chunk`'s audio path). **72 passed, 1 xfailed** —
that's the new baseline, up from 62.

**Backend-only, like 3.2** — nothing in the UI requests `eyesfree` yet (`MessengerChat.tsx` still
sends `v2`). Task 3.4 is what turns it on. Note for whoever does 3.4: with eyes-free active the
suggestion chips will be empty, so the mode toggle needs to hide that row rather than render a gap.

---

### [x] 3.4 — Spoken correction: "try saying [sentence]" 🔴 Opus

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

**Shipped as:** the 🙈 Eyes-free toggle in `MessengerChat.tsx` (which is what finally selects 3.3's
`eyesfree` prompt version — it overrides the v1/v2 checkbox while on).

*Severity gate:* new `error_severity` field (`"none" | "minor" | "major"`) in the output schema next
to `had_errors`, on `MessengerTurnResponse`, reconciled server-side by `_normalize_severity`
(`routers/messenger.py`). Two contradictions handled differently on purpose: *missing/junk* severity
with `had_errors=true` → `"major"` (no signal at all; fail loud rather than silently swallow every
correction), *explicit* `"none"` with `had_errors=true` → `"minor"` (that's a judgement — send it to
the quiz). The prompt's own tie-break is the opposite direction: when torn, emit `"minor"`, because a
wrongly skipped drill is cheap and a wrong interruption is not. Goldens re-baselined (one added line
each).

*Drill flow:* `earcon → "Try saying:" (UI language, fixed string so it's a one-time Azure cost then
cache-served) → the corrected sentence at SLOW_TTS_RATE → busy drops, textarea re-focuses (the "mic
opens") → your attempt is swallowed by `finishDrill` instead of reaching the LLM → the character's
reply plays.* The reply is held in `pendingReplyChunksRef` for exactly that reason: with the screen
off audio is serial, and the reply ends in a question, so letting it play over the correction makes
both useless. The drill also fires *before* the reply, not after, so the correction stays attached to
the sentence it belongs to. Gate also refuses to drill when `input_intent === "english"` or when
`corrected_input` came back unchanged — being told to repeat your own mistake is worse than silence.

*Also:* `useAudioPlayer` finally passes 2.1's `rate` through (`play(text, locale, rate?)`, cache key
now `locale:rate:text`) — it was parameterized on the backend but unreachable from the client;
`SLOW_TTS_RATE = -25` lives in `config.ts`. Eyes-free playback now also plays 3.2's pre-generated
reaction openers (`reaction_audio_file`), which nothing consumed before — they no-op silently until
`scripts/generate_reaction_audio.py` is actually run. Hotkeys `Alt+R` (hear it again) / `Alt+E`
(spoken explanation, never automatic) — 4.2 maps its Y and X buttons onto the same two functions.
Mock mode now returns a substantive correction for any input containing "gaseoso" (the prompt's own
false-cognate example), so the whole gate is exercisable without API keys. **74 passed, 1 xfailed.**

**Not verified in a browser** — typecheck and lint are clean and the backend gate is tested, but the
drill state machine has not been clicked through with real audio. `npm run build` is red repo-wide on
pre-existing errors in BattleGame/TriviaGame/WordDrill/trivia2, unrelated to this change.

---

### [x] 3.5 — Retry check for the repeat-after-me attempt 🟡 Sonnet

**Fix:** Score the attempt from 3.4. **Start with the cheap version:** compare Wispr's text output to
the reference sentence with the existing `checkFuzzyMatch` / `normalizeForMatch` from
`sharedGameUtils.ts`. Costs $0 and reuses machinery you already have.

**Known limitation, accept it for now:** this checks *word production*, not pronunciation — Wispr
emits cleaned-up fluent text, so it will silently fix some errors. Good enough to answer "did I
produce the right sentence." Real pronunciation scoring is task 6.1.

**Files:** `frontend/src/MessengerChat.tsx`, `frontend/src/sharedGameUtils.ts`.

**Depends on:** 3.4. **The seam is already there:** `finishDrill(attempt?)` in `MessengerChat.tsx`
carries a `TODO(task 3.5)` at the exact point where the score and the `attemptPassed`/`attemptFailed`
earcon belong. `attempt === undefined` means the drill was skipped, not failed — don't score that.

**Shipped as:** the exact seam described above, filled in. `finishDrill` now calls
`checkFuzzyMatch(attempt, [d.target], learning.code)` (existing `sharedGameUtils.ts` machinery,
unchanged) and plays `attemptPassed`/`attemptFailed` via `earcons.play()` — only when `attempt !==
undefined`; a skipped drill plays neither and stores no score. Result stored as a new `passed?:
boolean` field on `CorrectionDrill`, surfaced in the drill card's "You said: ..." line with a ✓ and
green text on a pass. No backend changes — this is entirely a `MessengerChat.tsx` change;
`sharedGameUtils.ts` already had everything needed. Typecheck and lint clean on the touched lines (two
pre-existing lint errors elsewhere in the file are unrelated). **Not clicked through with real audio**
— same caveat as 3.4's shipped note.

---

### [x] 3.6 — Audio pairing modes 🟡 Sonnet

**Fix:** Three playback modes — target-only / EN→ES pairs (English first, then Spanish) / alternating
(chunks alternate languages with *no* paired translation, forcing unaided comprehension).

**Files:** `frontend/src/MessengerChat.tsx` (`playResponseAudio`, ~line 805).

**Depends on:** 3.1, 2.2.

**Shipped as:** a `pairingMode` state (`"targetOnly" | "pairs" | "alternating"`, default `targetOnly` —
today's behavior, unchanged unless the user opts in) with a new "🎧 Pairing" dropdown next to the
existing 🔊 Audio toggle. `playResponseAudio` branches on it:
- **targetOnly** — identical to the old function body: only `modality==="audio" && language==="target"`
  chunks play.
- **pairs** — before playing a target-audio chunk, speaks `chunk.native_text` (live TTS, UI locale)
  first if present. Only the v2/eyes-free challenge chunk carries `native_text` today, so plain v1
  turns with no challenge sentence behave like target-only — known limitation, not worth a backend
  change just for this.

**⚠️ The spec above was wrong — see 3.8.** It assumed each chunk is inherently one language and only
the last one has a translation. The actual intent is that **every chunk is a bilingual pair**, and the
mode chooses how the pair is voiced. The implementer correctly flagged the `native_text` gap and
declined to fix it because this task didn't ask for it; 3.8 is that backend change. The mode plumbing,
the dropdown, and `targetOnly` shipped here are all still correct and get reused.
- **alternating** — voices every remaining chunk (including `language="ui"` text chunks, via live TTS)
  in whichever language it's actually written in, with no translation lead-in. Reuses 3.2's free
  `reaction_audio_file` for an exact-match chunk (e.g. the opener) even outside eyes-free before
  falling back to live TTS, so it doesn't waste an Azure roundtrip on something already pre-generated.

`opts.withReactions` (still caller-controlled, `{ withReactions: eyesFree }`) is unchanged for the
other two modes. Typecheck and lint clean on the touched lines (same two pre-existing errors elsewhere
in the file). **Not clicked through with real audio** — same caveat as 3.4/3.5.

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

### [x] 3.8 — Spanish-only chunks + on-demand translation + playback pacing (corrects 3.6) 🔴 Opus

**What 3.6 got wrong:** it treated each chunk as inherently one language, with a translation only on
the final challenge sentence, and it assumed the fix would be "make the model emit both languages for
every chunk". Both are wrong. The settled design:

**The main LLM call always returns the same thing regardless of mode: 3 chunks, all target-language.**
Sentence 1 never gets a translation. Translations for sentences 2–3 come from a separate cheap call,
requested by the client only when the active mode needs them.

| Mode (`pairingMode`) | Playback | Translations needed | Difficulty |
|---|---|---|---|
| `targetOnly` | ES1, ES2, ES3 | **none** | hardest |
| `alternating` | ES1, **EN2**, ES3 | 1 | medium |
| `pairs` | ES1, EN2→ES2, EN3→ES3 | 2 | easiest |

Note this **inverts the difficulty ordering in 3.6's description.** `alternating` is the middle rung,
not the hardest — the English sentence is a comprehension anchor dropped into the middle, not a
withheld crutch.

**Why this beats "emit both languages in the main call":**
- **No prompt-cache prefix multiplication.** One prompt shape. The always-emit-vs-request-gated
  decision that the previous draft called "the real design call" disappears entirely — mode is a
  *client* concern resolved after the chunks arrive.
- **Modes switch retroactively.** Flip to `pairs` on a message you already received; just fetch the
  translations you're missing.
- **`targetOnly` costs nothing extra** — no second call at all.
- **Time-to-first-bubble is identical in all three modes**, because chunk 1 is target-only and its
  JSON object closes fast. This is the property that matters: emitting both languages inside chunk 1
  would have roughly doubled the wait for bubble 1 and quietly undone task 1.6.

**⚠️ Decided, and it's the biggest behavioral change in this file:** the character's language mix goes
from **70–80% UI language to 100% target language.** The anti-overwhelm ratio is deliberately
reversed, with the pairing modes as the new difficulty dial. English scaffolding that survives:
corrections, `error_explanation`, and suggested-reply translations — those are Pico's fields, not the
character's voice. So this is immersion in the character's *speech*, not in the whole UI.

---

**Part A — prompt.** All three version blocks emit target-language `response_chunks`. Drop the
70/20/10 language-mix rules; they no longer describe anything.

**Keep `native_text` on the v2 challenge chunk exactly as-is** — it's one sentence, already working
and tested, and it's the one translation that must be present even in `targetOnly` for the
hover-reveal. Everything else routes through Part B.

**Files:** `backend/prompts/messenger_prompt.py`, `backend/prompt_fragments.py`.
**⚠️ Cache invariant:** static-prefix change → re-baselines every golden across all three versions.

---

**Part B — translation endpoint.** New `POST /api/messenger/translate`: takes chunk texts + source and
target locales, returns translations. Cheap model, no persona, no schema, no student model — ~100
input tokens against the main call's ~2.5k.

**Content-hash cache it** the way audio is cached (`audio_utils.get_cached_audio_path` is the pattern).
The same target sentence recurs across turns, and a cache hit makes a re-listen free.

**Fallback is required:** if the call fails or times out, that chunk degrades to target-only playback
rather than stalling the queue. Pairs mode must never be able to hang the conversation.

**Files:** new `backend/routers/translate.py` (register in `main.py`), `backend/llm_call.py`
(`translate_chunks`), `frontend/src/MessengerChat.tsx`.

---

**Part C — playback pacing.** `playResponseAudio` currently plays everything back-to-back with zero
gap (sequential `await`, `MessengerChat.tsx:1114`). Add deliberate pauses. This is an anti-overwhelm
requirement first — three target-language sentences with no breathing room is a wall — and it happens
to also hide the translate→TTS latency, which is why it belongs in this task rather than its own.

**Two different gap sizes, and the distinction is what makes pairs *sound* like pairs:**
- **within a pair (EN→ES): short, ~400–600ms.** Same sentence, twice — they belong together.
- **between sentences: longer, ~1–2s**, scaled to the length of the clip just played (reuse
  `readingDelay()`'s shape).

Without that asymmetry, `pairs` mode is just six unrelated clips in a row.

**Make the gap a floor, not a fixed delay:** `await Promise.all([delay(minGap), audioReady])` — take
whichever is longer. Fast translation still gets the full pause; slow translation stretches it instead
of producing a stall. Same floor-and-ceiling thinking as task 1.1, inverted.

**Consequence worth checking:** a ~1.5s inter-sentence gap likely *fully covers* a ~1s translate+TTS
chain, so `pairs` mode may not feel slower to respond at all — only longer overall, because there are
five clips instead of three.

**Latency budget for `pairs`, stated explicitly:** extra latency here is *permitted, not wanted.*
Spend it if the translate→TTS chain genuinely needs it; do not manufacture it. If the pacing gaps
already absorb the chain and the mode comes out just as fast, that is the good outcome — don't add
delay to make pairs mode "feel" like the slower, more deliberate mode. The gaps in Part C are sized
for comprehension, and that is the only thing that should determine them.

**Files:** `frontend/src/MessengerChat.tsx` (`playResponseAudio`).

**Composes with task 2.1** — speech rate and inter-clip gap are the two pacing dials; tune them
together, and consider exposing gap length as a setting if the fixed values don't fit.

---

**Depends on:** 3.6 (reuses its `pairingMode` state and dropdown — those shipped correct).

**Deferred, not scheduled:** back-filling translations for chunks the active mode didn't need, so any
sentence can be revealed on demand (hover, or the "explain" button from 3.4). Nearly free once Part B
exists — it's the same endpoint — but not needed for the mode to work.

**Shipped as:**
- **Part A** — `chat_system_prompt.txt` rewritten (the 70/20/10 rules lived there, not just in
  `messenger_prompt.py`); persona block, schema, reminders and all three version blocks now specify
  target-language audio for every chunk. Persona greetings/examples/few-shots are filtered to the
  target language rather than falling back to UI-language ones, since a UI-language example is a
  worked demonstration of exactly what the prompt forbids.
- **Part B** — `POST /api/messenger/translate` (`routers/translate.py`), `llm_call.translate_texts`
  on `gpt-4.1-nano` (`settings.TRANSLATE_MODEL`), cached in `translation_store.py`. Never raises:
  a failure returns `ok:false` with nulls and the client plays target-only.
- **Part C** — `playResponseAudio` rewritten around `pauseAtLeast(gap, work)`. `WITHIN_PAIR_GAP_MS`
  500, `betweenSentenceGap()` 1200–2200ms scaled by clip length. Translations are requested before
  the first clip plays, so chunk 0's playback covers the chain.

**⚠️ Collision this task did not anticipate — resolved, but worth knowing:** 3.2/3.3 made
`response_chunks[0]` a verbatim **English** reaction precisely so its audio could be pre-generated and
free. All-target chunks break that. Resolved by moving the bank to the target language:
`reactions.es` added to both personas (50 for Jorge, 6 for Sombongo so the goldens keep covering the
code path), `_reaction_audio_lookup` re-keyed on target language, and the lookup now only returns
entries whose `.wav` actually exists so a missing file falls through to live TTS instead of playing
silence at the top of every turn.

**➜ ACTION REQUIRED before this feels right:** run
`venv/Scripts/python.exe scripts/generate_reaction_audio.py` (needs Azure keys, ~1k characters). Until
then chunk 0 pays a live TTS roundtrip every turn — correct, but not free.

**⚠️ Azure cost went up and was not budgeted here:** a turn was 1 spoken sentence, it is now 3. With
the bank generated that is 2 live + 1 free; `pairs` mode adds 2 more English clips. Roughly 2–5× the
previous per-turn characters against the 500k/month cap. Check `/api/usage` after a real session.

**Not verified:** no real-API run and no click-through with audio. The gap constants are reasoned, not
tuned by ear — expect to adjust `WITHIN_PAIR_GAP_MS` / `betweenSentenceGap` once heard.

---

# Phase 4 — Xbox controller

### [x] 4.1 — Controller → F13 mapper 🟡 Sonnet

**Recording is press-to-toggle, not hold** (settled): click a stick (L3 *or* R3) to start recording,
click again to stop → auto-send window opens. Earcons from 2.3 announce start and stop, which is what
makes this safe with the screen off.

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
LT and RT onto a single shared axis**, so the two triggers can't be told apart cleanly and holding
both cancels out. Recording doesn't depend on a trigger (it's the stick click), but 4.2's
"LT hold = hear the translation" does, and stick clicks are only reliably readable through XInput
anyway. Use an XInput-aware mapper.

**Free bonus worth designing around:** when the browser is focused it *also* receives the F13 keydown.
Use that as the in-app "recording started" signal — the recording indicator and earcon sync for free,
with zero IPC. Just make sure F13 is handled deliberately rather than ignored.

**Real caveat to know:** `navigator.getGamepads()` only reports while the document is focused, and
needs a user gesture before gamepads are exposed. Fine in practice — the app is what you're looking
at — but if you background the window during eyes-free, in-page buttons go dead while F13/Wispr keeps
working. If that turns out to bite, *then* revisit the WebSocket relay.

**Files:** new `tools/controller/` (mapper script), `frontend/src/sharedGameHooks.ts` (new
`useGamepad` hook), `frontend/src/MessengerChat.tsx`.

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

**Shipped as:**
- **Mapper** — `tools/controller/f13_mapper.py` (~40 lines incl. docstring), the recommended
  Python + `XInput-Python` + `keyboard` option. Polls player 0 at 125Hz, edge-triggers on
  `LEFT_THUMB or RIGHT_THUMB` going from unpressed→pressed, sends one `keyboard.send("f13")` per
  edge (no auto-repeat while held). `tools/controller/requirements.txt` has its two deps —
  intentionally not folded into `backend/requirements.txt`, this runs standalone, not through the
  app's venv. **Not run against real hardware** — no controller in this environment; reasoned from
  the XInput-Python/`keyboard` APIs, not verified end-to-end.
- **In-app recording signal** — new F13 `keydown` listener in `MessengerChat.tsx` (window-level,
  same pattern as the existing Alt+R/Alt+E listener), not eyes-free-gated since it's useful with the
  screen on too. Toggles a new `recording` state and plays `earcons.play("recordingStarted" |
  "recordingStopped")` from 2.3 on each edge. Rendered as a small pulsing-dot "Recording (F13)"
  indicator above the textarea.
- **Desync guard** — a second effect watches `transcript` (the Wispr-populated textarea state) and
  treats *any* growth while `recording` is still `true` as proof recording already ended (Wispr only
  ever pastes a finished transcript in one shot), forcing `recording` false and firing the stop
  earcon itself. Covers exactly the dropped-stop-tap case called out in the task; a dropped
  *start*-tap needs no special handling since `recording` was already `false`.
- **`useGamepad` hook** — new in `sharedGameHooks.ts`, an rAF poll loop over `navigator.getGamepads()`
  reporting `connected` plus edge-triggered `{index, pressed}` button-change callbacks (standard
  gamepad mapping). Task 4.1 doesn't map any button through it — L3/R3 goes through the native mapper
  precisely because `getGamepads()` only reports while the document is focused — but it's the shared
  polling loop 4.2/4.3/4.5 build their button maps on, and it drives a small "🎮 connected / no
  controller" status badge in the toolbar here so the in-app signal is visible without a controller
  plugged in yet.
- **Side fix:** `useEarcons()` now wraps its return in `useMemo` (previously a fresh `{ play }`
  object every render) — needed so the new F13 listener effect, which depends on it, doesn't
  resubscribe on every render. Matches `useAudioPlayer`'s existing pattern.

**Not verified:** no physical Xbox controller available in this environment. Typecheck
(`npx tsc --noEmit`) and lint are clean on every touched line (repo-wide lint has ~45 pre-existing
errors in other files, documented in CLAUDE.md's "not verified" notes on 3.4/3.6 — none are new).
Backend untouched; suite still **89 passed, 1 xfailed.**

---

### [x] 4.2 — Map the per-turn action buttons 🟡 Sonnet

| Control | Action |
|---|---|
| **L3 / R3** (click either stick) | Toggle recording on/off (via F13) — earcon on each edge |
| **Stick deflection** (either, any direction, past a large deadzone) | **Cancel the pending auto-send** — earcon on cancel |
| **B** (East) | Backup cancel + stop audio |
| **A** (South) | Repeat last target sentence |
| **Y** (North) | Repeat **slower** (0.75×) — needs 2.1 |
| **X** (West) | Explain that — spoken `error_explanation` (3.4) |
| LT (hold) | Hold to hear the English translation |

**Design notes:**
- **Cancel is a stick flick** (settled): push either stick past a large deadzone, any direction,
  during the ~1.5s pending-send window. The threshold is what makes this safe — a resting thumb sits
  near 0.0, so **0.8** magnitude (`Math.hypot(x, y) > 0.8`) cannot happen by accident. It also means
  the cancel gesture lives on the same stick you just clicked to stop recording: click, then flick if
  you didn't mean it. No hand repositioning.
- **Four rules for the flick, or it misfires:**
  1. **Only armed while a send is pending.** Outside that window, stick movement does nothing —
     otherwise idle fidgeting cancels things that aren't happening.
  2. **Edge-triggered, not level.** Fire once on crossing the threshold; don't re-fire while held out,
     and require a return below ~0.3 before it can arm again.
  3. **Magnitude, not direction** — any direction counts, as you specified. Don't special-case axes.
  4. **Earcon on cancel** (2.3's low thud). With the screen off it's the only confirmation that the
     flick registered, and a silent cancel is indistinguishable from a missed one.
- **B stays as a backup cancel, and keeps stop-audio.** Two different jobs: the flick is for the
  time-critical auto-send window, B is the general "stop / back" that also kills playback mid-clip.
  Redundant cancel is fine; redundant confirm is not.
- Drive the existing `useWisprAutoSend` hook — do **not** spin up a parallel cancel timer.
- **LT translation is free** in v2: the challenge chunk already carries `native_text`, so revealing or
  speaking it costs zero LLM calls. It's the controller version of the hover-reveal you already built.
- **RT is unassigned** now that recording moved to the stick click — leave it open until a real need
  shows up rather than inventing one.

**Files:** `frontend/src/MessengerChat.tsx`, `frontend/src/sharedGameHooks.ts`, `tools/controller/`.

**Depends on:** 4.1, 2.1, 3.4.

**Shipped as:**
- **`useGamepad`** (`sharedGameHooks.ts`) extended from 4.1's edge-only callback to an options object
  `{ onButtonChange, onFrame }`. `onFrame` carries the continuous state — `axes` and each button's
  analog `value`, not just `pressed` — that the flick and LT-hold gestures need, since both are
  threshold/magnitude logic across frames rather than a single edge. One rAF loop still drives both.
- **A/B/X/Y** wired via `onButtonChange` (fires on press only) straight onto the functions the
  eyes-free keyboard hotkeys already used: A → `repeatLastAudio()`, X → `explainDrill()`. Y is new —
  `repeatLastAudioSlow()`, identical to `repeatLastAudio()` for a drill (already spoken at
  `SLOW_TTS_RATE`) but re-fetches the replay-stack item at `SLOW_TTS_RATE` instead of replaying the
  cached normal-speed clip. B cancels a pending send (if any) and unconditionally calls
  `audioPlayer.stop()`.
- **Stick flick** — read every frame in `onFrame`: `Math.max(Math.hypot(lx,ly), Math.hypot(rx,ry))`
  against the two thresholds from the design notes (arm-fires past 0.8, re-arms below 0.3,
  `flickArmedRef` gates re-firing while held out). The cancel + earcon only actually happen if
  `autoSendStateRef.current?.pending` is true at the moment of the edge — outside the window the
  hysteresis bookkeeping still runs but nothing observable happens, satisfying "stick movement does
  nothing" outside the pending window without special-casing the polling loop itself.
- **`autoSendStateRef`** — the seam that lets the controller drive `useWisprAutoSend` without a second
  timer. `GameTextarea` (`sharedGameComponents.tsx`) gained an optional `onAutoSendChange?: (state:
  {pending, cancel}) => void` prop, called from a new effect whenever `autoSend.pending` changes;
  MessengerChat mirrors it into the ref via a `useCallback`. Purely additive — every other
  `GameTextarea` caller is unaffected, no default behavior changed.
- **LT hold** — `frame.buttons[6].value` (standard mapping) thresholded at 0.5 rather than trusting
  the browser's `pressed` boolean, which is too sensitive for a deliberate hold gesture. Press edge
  calls the new `speakLastChallengeTranslation()`; release calls `audioPlayer.stop()`, cutting the
  clip off exactly like letting go of a walkie-talkie button. Speaks `lastChallengeChunkRef.current
  .native_text` — a new ref, populated in `revealChunk` and the pivot flow wherever a chunk carrying
  `native_text` is revealed, so it survives past the per-message `<MessengerChallengePair>` component
  it mirrors (hover triggers the same reveal with the mouse; this is the same data, controller-driven).
- **Toolbar badge** (from 4.1) tooltip updated to list the live button map now that one exists.
- **`tools/controller/f13_mapper.py`** — docstring note only, clarifying L3/R3 stay the only buttons
  routed through the native mapper; everything in this task reads the in-page Gamepad API directly
  and needed no mapper changes.

**Not verified:** no physical controller in this environment, same caveat as 4.1. Typecheck and lint
are clean on every touched line (same pre-existing repo-wide lint errors as before, none new).
Backend untouched; suite still **89 passed, 1 xfailed.**

---

### [x] 4.3 — Shoulder-button replay navigation 🟡 Sonnet

**Fix:** LB steps back through the replay stack, RB steps forward. Keep the iPod semantic if you like
the feel — LB within the first 50% of playback goes back one, after 50% restarts current. (Simpler
alternative: LB/RB purely move a cursor and A replays current. Either is fine.)

**Files:** `frontend/src/MessengerChat.tsx`, `frontend/src/sharedGameHooks.ts`.

**Depends on:** 2.2, 4.1.

**Shipped as:** the simpler alternative — LB/RB move a cursor, A (already mapped in 4.2) replays
whatever it points at. Chosen over the iPod split because that variant needs to track how far into
the *current* clip playback has gotten, which nothing here does today; the cursor gets the same "step
back through history" feel without inventing a progress tracker for it.

`useReplayStack` (`sharedGameHooks.ts`) grew `cursorRef` (a ref, not state — LB/RB now touch zero
React state, so a shoulder-button tap doesn't re-render the chat) plus `stepBack()` / `stepForward()`
/ `current()`. `-1` means "track the latest item"; `push()` resets to `-1` on every new item, so
browsing back with LB doesn't leave the controller's A/Y repeat buttons pinned to a stale sentence
once the conversation has moved on — you have to deliberately still be parked there. `items`/`push`
are unchanged, so this is additive to 2.2's original API.

`repeatLastAudio()`/`repeatLastAudioSlow()` (task 4.2's A/Y handlers, and the Alt+R hotkey) switched
their non-drill branch from `replayStack.items[items.length - 1]` to `replayStack.current()` — this
is the one line that turns cursor movement into audible navigation, matching "A replays current" from
the simpler design. LB/RB themselves are silent per the design notes; the drill branch (speaking the
correction target) is untouched.

**Not verified:** no physical controller in this environment, same caveat as 4.1/4.2. Typecheck and
lint clean (same pre-existing repo-wide lint errors as before, none new). Backend untouched; suite
still **89 passed, 1 xfailed.**

---

### [x] 4.4 — Haptics 🟡 Sonnet

**Fix:** Short pulse = recording on. Double pulse = sent. Long buzz = correction incoming.

With the screen off, rumble is the *only* non-audio feedback channel — it tells you what happened
without interrupting the audio stream. This is what makes eyes-free actually usable rather than
merely possible.

**Files:** frontend `gamepad.vibrationActuator`, or `tools/controller/` for XInput rumble.

**Depends on:** 4.1.

**Shipped as:** the browser `gamepad.vibrationActuator` path (no native mapper changes) — new
`frontend/src/gamepad/haptics.ts`, structured as the rumble mirror of `audio/earcons.ts`: a
`playHaptic(pattern)` that grabs whatever `Gamepad` `navigator.getGamepads()` currently reports,
best-effort no-ops (silent catch) if there's no controller or no `vibrationActuator`, so no caller
ever needs to check `gamepad.connected` first. `useHaptics()` in `sharedGameHooks.ts` wraps it the
same way `useEarcons()` wraps `playEarcon`, memoized for the same reason.

Only the three patterns TASKS.md names — not full parity with earcons' six — wired at the exact spots
their earcon counterparts already fire, so audio and rumble land together: `"recordingStarted"` in
the F13 toggle listener (on the *on* edge only — no stop rumble was asked for), `"sent"` right after
`sendMessage`'s drill/busy/empty guards clear (drill-attempt submissions go through `finishDrill`
instead, so they don't double up with the pass/fail earcon), `"correctionIncoming"` in
`startCorrectionDrill` alongside its earcon.

**Not verified:** no physical controller in this environment, same caveat as 4.1–4.3 — rumble in
particular is unverifiable without real hardware; the magnitudes/durations in `haptics.ts` are
reasoned, not felt. Typecheck and lint clean (same pre-existing repo-wide lint errors as before, none
new). Backend untouched; suite still **89 passed, 1 xfailed.**

---

### [x] 4.5 — D-pad mode toggles 🟡 Sonnet

| Control | Action |
|---|---|
| D-pad ↑ | Toggle eyes-free mode |
| D-pad ↓ | Cycle pairing mode (target-only / EN→ES pair / alternating) |
| D-pad ← → | Change topic (pivot, `sombongo_pivots.ts`) / skip |

**Rationale:** mode toggles are session-level settings, not per-turn actions — they shouldn't consume
face buttons you press constantly. The D-pad is exactly right for infrequent settings.

**Depends on:** 4.1, 3.3, 3.6.

**Shipped as:** four more `onButtonChange` cases in the same `useGamepad` call from 4.2/4.3 (standard
mapping 12–15 = D-pad up/down/left/right) — no new hook plumbing needed, this task is pure wiring
onto state and functions that already existed. Up flips `setEyesFree`; down cycles `pairingMode`
targetOnly → pairs → alternating → targetOnly (3.6/3.8's existing three modes, in the order the table
lists them); left and right both call the existing `handlePivot()` — the function already backing the
🔀 "Change topic" button — since the pivot queue (`getNextPivot()`) is a forward-only shuffle with no
backward step to give left and right distinct behavior, and the task's own row groups both arrows
under one action ("change topic / skip") rather than describing two.

Toolbar tooltip (4.1/4.2's "🎮 connected" badge) extended to list the D-pad mappings.

**Not verified:** no physical controller in this environment, same caveat as the rest of Phase 4.
Typecheck and lint clean (same pre-existing repo-wide lint errors as before, none new). Backend
untouched; suite still **89 passed, 1 xfailed.**

---

**Phase 4 complete.** Every button on the controller now does something: L3/R3 record, A/B/X/Y/LT
handle the turn, LB/RB browse replay history, D-pad handles session settings, and rumble confirms the
three highest-stakes moments. RT stays intentionally unassigned (4.2). None of it has been touched by
a physical controller — every task from 4.1 on carries that same caveat, and it's the one thing left
before this phase can be called actually done rather than just implemented.

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

# Phase 7 — Indonesian

Numbered last to keep existing task numbers stable, **not** because it's lowest priority — **7.1 is a
small blocker and should be done before any Indonesian practice session.** Everything built through
Phase 2 (streaming, TTS rate, prompt-cache split, Jorge) is language-agnostic and already works for
Indonesian; what's broken is that messenger never actually switches languages.

### [ ] 7.1 — Fix target-language selection (blocker) 🟡 Sonnet

**Problem:** Picking Indonesian on the HomeScreen has **no effect on messenger.** `MessengerChat.tsx`
only sends the chosen languages to the backend inside an `else if (res.status === 404)` branch — but
`/api/messenger/profile` can never return 404, because `load_profile()` (`profile_store.py:65-74`)
creates a missing profile itself, hardcoded to `{code: "es", name: "Spanish"}`. The branch is dead
code, so `default_profile.json` stays Spanish forever and the prompt keeps saying "the learner is
learning Spanish" no matter what the UI shows.

**Fix:** Send `ui_language`/`target_language` on every profile load and update the stored profile when
they differ from what's on disk. Decide what a language switch means for accumulated state — that's
the real design call in this task, not the plumbing.

**Files:** `frontend/src/MessengerChat.tsx` (~line 295-320), `backend/routers/messenger.py`
(profile endpoints), `backend/profile_store.py`.

**⚠️ The state question:** `level`, `weak_points`, `comfortable_with`, `corrections_needed` and
`recent_turns` are all language-specific — "ser vs estar" is meaningless for Indonesian. A single
`default_profile.json` can't hold two languages honestly. Options, cheapest first:
1. Per-language profile files (`profiles/default_es.json`, `default_id.json`) — recommended; the
   store already takes a path, and it keeps both languages' histories intact.
2. One profile with per-language sub-objects — more churn in `profile_store.py`.
3. Reset assessment state on switch — simplest, but throws away real learning history. Don't.

Whichever you pick, `chat_log_{lang}.md` is already per-language, so that part is fine.

---

### [ ] 7.2 — Indonesian premade openers + pivots 🟡 Sonnet

**Problem:** All 3 conversations in `premade_conversations.json` are Spanish (`es-MX` audio, Spanish
text) and carry **no language field**, and `messenger.py` picks with a blind `random.choice`. Since
the frontend routes the *first* message through the premade path, an Indonesian session would open in
Spanish. `frontend/src/data/sombongo_pivots.ts` has the same problem — `text_target` and
`audio_message` are Spanish-only, so the change-topic button emits Spanish mid-conversation.

**Fix:** Add a `language` field to each premade conversation, filter by the profile's target language,
and write an Indonesian set. Same for pivots. If no script exists for the active language, skip the
premade path entirely and go straight to the LLM rather than serving the wrong language.

**Files:** `backend/premade_conversations.json`, `backend/routers/messenger.py`
(`load_premade_conversations`, `messenger_premade_start`), `frontend/src/data/sombongo_pivots.ts`.

**Depends on:** 7.1 (there's no correct language to filter by until the profile tracks one).

**Note:** the pivots are also still Sombongo-flavored — see 5.4. Writing Jorge's Indonesian set is
the same piece of work as writing Jorge's Spanish set; do them together.

**Related:** premade currently 500s anyway (missing `input_intent`, xfail in `tests/test_smoke.py`).
Fix that first or this task can't be tested.

---

### [ ] 7.3 — Rename the `input_intent` values 🟢 Haiku

**Problem:** The field is a binary "was the user attempting the target language?", but its values are
hardcoded `"english" | "spanish"` — in the output schema (`messenger_prompt.py:200`), the reminders
(line 229), the router's defaults, and the frontend's `data.input_intent !== "english"` checks. For an
Indonesian learner the prompt literally asks the model to answer `"spanish"`.

**Fix:** Rename to `"ui" | "target"` (matching the `language` field on response chunks, which already
uses that vocabulary). Functionally a no-op today — it's cosmetic until someone reads the prompt and
gets confused, which is exactly what happens with a second language in play.

**Files:** `backend/prompts/messenger_prompt.py`, `backend/models.py`,
`backend/routers/messenger.py`, `backend/chat_log.py`, `frontend/src/MessengerChat.tsx`.

**⚠️ Cache invariant:** the schema is in the static prefix, so this re-baselines the prompt goldens.
Expected — re-baseline per the procedure in `tests/test_prompt_snapshot.py`.

**Watch for:** `recent_turns` entries already on disk carry `"spanish"`. Migrate on load or accept
both spellings for a while.

---

### [ ] 7.4 — Add voice to the audio cache key 🟡 Sonnet

**Problem:** The cache key is `text|locale` (+`rate` since 2.1) and still excludes **voice**. Indonesian
is where this bites: `scripts/generate_worddrill_audio.py` and `generate_battle_audio.py` hardcode
`id-ID-ArdiNeural` while `VOICE_MAP` defaults to `id-ID-GadisNeural`, so the same Indonesian sentence
can be cached by either speaker and served under the other — one conversation, two voices, silently.

**Fix:** Add voice to the key, the same way 2.1 added rate. Use the same trick: hash the default voice
identically to the current key so existing cached files stay valid rather than being orphaned.

**Files:** `backend/audio_utils.py` (`get_cached_audio_path`), `backend/tts_helpers.py`,
`backend/routers/audio.py`, both scripts in `backend/scripts/`.

**Also settle:** whether the batch scripts should keep their own hardcoded voices at all, or read
`VOICE_MAP` like everything else. They should read `VOICE_MAP` — the duplication is the root cause.

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
