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
  Baseline is **264 passed, 1 xfailed** (173 before phase 8; the "89" recorded here through phase 3
  had gone stale well before that).
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

**The main LLM call always returns the same thing regardless of mode: 3 chunks, all target-language.

Explanations can mix both voices: the lesson prompt marks target words `[[like this]]`,
`split_language_runs` cuts the line into per-language runs, and `synthesize_mixed` speaks each in its
own voice and stitches the clips with Azure's padding trimmed. Several `<voice>` blocks in ONE SSML
request was tried and rejected — it works and keeps word boundaries, but Azure pads each block as a
separate utterance: 4.24s vs 2.66s stitched vs 2.69s single-voice on the same sentence.**
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

### [x] 3.9 — Cap sentence length in v1/v2 🟡 Sonnet

**Problem:** the eyes-free block caps its target sentence at **12 words maximum**
(`messenger_prompt.py`, EYES-FREE FORMAT). v1 and v2 have **no length cap at all** — only "Keep each
chunk to ONE spoken sentence". So the default mode is *three target-language sentences, unbounded
length, back to back*, which is easily 6–9 clauses of unbroken Spanish per turn.

Reported symptom is "sentences feel too fast and have too many clauses". **Do this before touching
audio speed:** the likely cause is volume, not rate. Before task 3.8 a turn was 2 UI-language
sentences + 1 target sentence; it is now 3 target sentences with no ceiling. That is a much bigger
change to listening load than anything about articulation.

**Fix, in two parts — ship them together and judge the result as one:**
1. **A word cap on v1/v2 chunks.** Start around 12–14 words to match eyes-free, then tune.
2. **A level-adaptive clause cap** driven by the `level` already in the student model — roughly
   1 clause for beginner, 2 for intermediate, 3 for advanced. A flat cap forever means no growth, and
   the goal is difficulty that moves.

**Also try, as the cheap experiment:** drop the v1/v2 default from 3 chunks to **2**. One line, and it
isolates "too much" from "too complex" better than any amount of prompt wording. If 2 chunks fixes the
feeling, the clause cap matters less than the chunk count does.

**Files:** `backend/prompts/messenger_prompt.py` (the reminders block and both version blocks).

**⚠️ Cache invariant:** all of this lives in the static prefix, so it re-baselines every golden across
all three versions. Expected — follow the procedure in `tests/test_prompt_snapshot.py`.

**Watch for:** the clause cap must not fight the existing "ONE spoken sentence per chunk" rule. One
sentence, N clauses — say that explicitly or the model will read the two rules as contradictory and
pick one.

**Shipped as:** all three changes together, in `reminders_section` (shared by v1/v2), the v2 challenge
chunk's inline format, and `generate_turn_instruction`'s regular-turn line (dynamic tail):
- **Word cap:** 14 words maximum per chunk, matching eyes-free's existing 12-word cap on the same
  order of magnitude.
- **Level-adaptive clause cap:** "beginner = 1 clause, intermediate = 2 clauses, advanced = 3 clauses,"
  stated as a rule referencing "the learner's current level (stated further down in this prompt)"
  rather than embedding a level value — the level itself is dynamic-tail content
  (`Current learner level: {level}` in the turn instruction), so the static prefix states the mapping
  generically instead of a specific level, keeping the cache invariant intact. Explicitly phrased as
  "limits clauses within the one sentence; never a second sentence or chunk" per the watch-for above.
- **Chunk count 3→2** (the "cheap experiment"): default dropped in `reminders_section`, the v2 section
  (now "2 chunks", "the reaction-opener chunk" singular, "the opener" instead of "earlier chunks"), and
  the regular-turn instruction text. Not benchmarked against 3 chunks in this pass — shipped per the
  task's framing that it isolates volume from complexity better than prompt wording alone; revert to 3
  in `reminders_section`/`v2_section`/`generate_turn_instruction` if it turns out chunk count wasn't
  the issue.

**⚠️ Cache invariant:** all edits confined to `reminders_section` and `v2_section` (static prefix) plus
`generate_turn_instruction`'s regular-turn string (dynamic tail, already per-turn) — no new dynamic
content leaked into the prefix. Goldens re-baselined (`tests/goldens/` deleted and regenerated, 18
files). **141 passed, 1 xfailed** — same test count as before, just re-baselined content.

**Not verified by listening** — same caveat as most of Phase 3/4: word/clause caps are reasoned from
the spec, not tuned by ear. Task 3.10 depends on this being judged first.

---

### [x] 3.10 — Pauses between clauses (SSML `<break>`) 🟡 Sonnet

**Why this and not just slowing the audio down.** When slowed speech helps L2 comprehension, most of
the benefit comes from the **added pause time, not the slower articulation** — and slowing carries a
real cost, because it distorts the connected-speech features (elision, reduction, liaison — all heavy
in Mexican Spanish) that the learner specifically needs to learn to parse. Training on 0.75× builds
skill at a signal that does not exist outside this app.

So: **slow playback stays a repair strategy, not an input strategy.** It is already scoped that way —
task 4.2's Y button, on demand — and should stay there. This task fixes the input itself.

The failure mode it targets is the cascade: the learner is still parsing clause 1 when clause 2
arrives, misses clause 2 entirely, and is then behind for the rest of the sentence. ~300ms of silence
at the clause boundary breaks that chain without making anything sound unnatural.

Note this is a **different bottleneck from 3.9**, not a substitute: clause count is working memory,
pauses are processing time. Pausing inside a 3-clause sentence still leaves 3 clauses to integrate.

**Fix:** insert `<break time="..."/>` at clause boundaries inside the SSML that `tts_helpers.py`
already builds, within the existing `<prosody>` block.

**Use SSML breaks, NOT separate audio clips per clause.** One TTS call, one cache entry, and — the
part that matters — prosody stays continuous across the sentence. Splitting a sentence into fragments
and scheduling them client-side resets intonation at every fragment, which sounds robotic and makes
parsing *harder*, defeating the point.

**Clause detection:** punctuation plus a small set of target-language cues (`que`, `porque`, `pero`,
`cuando`, `si`, `y`) as a pure backend transform. Zero LLM cost and zero output tokens, which matters
given how much of Phase 1 went into getting those down. Only add an LLM-marked segmentation later if
the heuristic demonstrably fails.

**Files:** `backend/tts_helpers.py` (SSML assembly), `backend/audio_utils.py` (cache key),
`backend/routers/audio.py` (parameter passthrough).

---

**⚠️ TRAP 1 — the audio cache will serve you the wrong file, silently and stickily.**

The cache names files by hashing their content: currently `text | locale | rate` (task 2.1 added
`rate`). Add a pause setting without adding it to that key and:

1. Play a sentence with 300ms pauses → hash misses → generates **paused** audio, saves as `abc123`.
2. Turn pauses off to compare → **same hash**, because pauses aren't in the key → serves the paused
   file back.

You hear pauses with pauses disabled, conclude the SSML is broken, and debug the wrong thing. And it
**persists**: the wrong bytes are on disk, so fixing the code later does not fix already-cached
sentences — the cache has to be wiped.

**Add pause length to the key in the same commit as the feature**, and reuse 2.1's trick so nothing is
orphaned:

```python
key = f"{text}|{locale}" if rate == 0 else f"{text}|{locale}|{rate}"
```

The default value hashes to the *existing* key exactly, so every file cached before this change stays
valid. Same class of bug as the still-open task 7.4 (voice isn't in the key either).

**⚠️ TRAP 2 — pauses of similar length stop carrying information.**

Silence duration is how a listener tells structure apart: short gap = "still going", long gap = "that
thought is finished". If two *different* kinds of boundary use similar durations, the signal stops
meaning anything. In pairs mode the learner would hear:

```
English sentence [300ms] second clause  [500ms]  Spanish sentence [300ms] second clause
                   ^ clause boundary       ^ language switch
```

300 vs 500ms is only 1.7× — too close to categorize instantly.

The worse failure is at the top end: if clause pauses drift toward the between-sentence gap, a
3-clause sentence starts sounding like **three separate sentences**. The learner tries to interpret
each clause as a complete thought, fails to connect them, and understands *less* than with no pauses
at all — a comprehension aid that reduces comprehension.

**Keep the ladder roughly 2× apart at each step:**

| Boundary | Duration | Owner |
|---|---|---|
| Between clauses | ~250ms | this task |
| Within a pair (EN→ES) | 500ms | `WITHIN_PAIR_GAP_MS`, task 3.8 |
| Between sentences | 1200–2200ms | `betweenSentenceGap()`, task 3.8 |

**These two numbers interact — do not tune one in isolation.** Either drop clause pauses to ~250ms or
widen the within-pair gap to ~700ms; final call by ear once it can actually be heard.

**Depends on:** 3.9. Ship the length cap first and listen to the result — if shorter sentences alone
fix the complaint, this task gets tuned against a much clearer baseline instead of compensating for a
volume problem it was never meant to solve.

**Shipped as:**
- **`insert_clause_breaks(text, pause_ms)`** (`tts_helpers.py`) — the pure backend transform: one regex
  alternation, `([,;])\s+` or `\s+(?=cue\b)` for `que|porque|pero|cuando|si|y` (case-insensitive),
  substituted in a single left-to-right pass so a cue word right after a comma (`", pero"`) gets exactly
  one `<break>`, not two (the whitespace is already consumed by the punctuation branch by the time the
  cue branch would look at it). `pause_ms=0` is a hard no-op — returns `text` unchanged, byte-for-byte —
  and a single-clause sentence is also a no-op even with `pause_ms` set, since no boundary regex fires.
  `DEFAULT_CLAUSE_PAUSE_MS = 250`, matching the ladder table.
- **`azure_tts_bytes_real` / `tts_bytes_for_chunk`** (`tts_helpers.py`) both gained a `pause_ms: int = 0`
  parameter; the SSML text goes through `insert_clause_breaks` before being wrapped in the existing
  `<prosody>` block — one TTS call, continuous prosody, per the "not separate clips" requirement above.
- **TRAP 1, applied exactly as written:** `get_cached_audio_path` (`audio_utils.py`) now takes
  `pause_ms: int = 0` and appends `|p{pause_ms}` to the hash key only when non-zero — `rate` and
  `pause_ms` are independent axes (a rate-only call, a pause-only call, and a call with both each hash
  to a distinct file; tested in `test_cache_key_independent_axes_for_rate_and_pause`). `pause_ms=0`
  reproduces the exact pre-3.10 (and pre-2.1, when `rate` is also 0) key, so nothing already on disk is
  orphaned.
- **`/api/trivia/audio`** (`routers/audio.py`) gained a passthrough `pause_ms` field on `TriviaAudioReq`,
  same pattern as 2.1's `rate` — this is what the Files list scoped the task to, and it's enough for any
  client-driven playback (drills, repeat-slower) to opt in later.
- **The actual fix, beyond the three listed files:** `routers/messenger.py`'s own three internal TTS
  call sites (`build_premade_response_chunks`, `_prepare_chunk`, `_generate_and_save`) now pass
  `pause_ms=DEFAULT_CLAUSE_PAUSE_MS` explicitly. Without this the feature would sit unused — the
  character's actual per-turn speech (the thing "sentences feel too fast" is about) is generated
  server-side in `routers/messenger.py`, not through `/api/trivia/audio`, so wiring only the three listed
  files would have shipped dead code. Called out here since it wasn't in the task's file list.
- **New `tests/test_tts_pauses.py`** (10 cases): the no-op paths (pause_ms=0, single clause), comma vs.
  cue-word insertion, the no-double-break case at a punctuation+cue boundary, the substring false-positive
  guard (`y` inside `yo`, `si` inside `siempre`), configurable duration, and the three cache-key
  invariants above. **151 passed, 1 xfailed** (up from 141 — no prompt goldens touched, this task is
  runtime TTS code, not the static prefix).
- **Not touched:** `WITHIN_PAIR_GAP_MS` / `betweenSentenceGap()` (task 3.8) — the ladder in the table
  above (250 / 500 / 1200–2200) already sits ~2× apart at each step with no change needed. Also not
  touched: `scripts/generate_reaction_audio.py`'s pre-generated bank (short, typically single-clause,
  and out of this task's file list) and `story.py`'s live per-turn TTS (out of scope — this task is
  messenger-specific per the pacing-ladder framing above).

**Not verified by ear** — same caveat as 3.9 and most of Phase 3/4: the transform is reasoned from the
spec and unit-tested as a pure function, but no real Azure call has been heard with breaks inserted.

### [x] 3.11 — Split chunks into one sentence each, server-side 🟡 Sonnet

**Problem:** the prompt already says "Keep each chunk to ONE spoken sentence" and the model does not
reliably obey — the content chunk regularly arrives holding two or three sentences. Since it is one
chunk it is also one audio file, so the learner cannot replay a single sentence; the only replay unit
is the whole run.

**Prompting harder is the wrong fix** — the rule exists and is being ignored. Split deterministically
in the backend, before TTS, so the guarantee holds regardless of what the model emits.

**Fix:** in `_prepare_chunks`, split each chunk's text on sentence boundaries and emit one chunk per
sentence, each with its own audio. Merge any fragment under ~4 words into its neighbour — otherwise
`"¿En serio?"` gets its own bubble and its own 1.2–2.2s gap, which reads as a stall rather than a beat.

**Three things this buys beyond the ask:**
- **Per-sentence replay**, which is the actual request (and feeds 4.3's LB/RB navigation).
- **A better cache hit rate** — short sentences recur across turns far more than long ones do.
- **Composes with 3.10's clause pauses** instead of competing: `<break>` handles boundaries *within* a
  sentence, this handles boundaries *between* them.

**Files:** `backend/routers/messenger.py` (`_prepare_chunks` / `_prepare_chunk`), `backend/models.py`
if the challenge flag needs to move.

---

**⚠️ TRAP 1 — do not split `response_chunks[0]`.**

The reaction opener is matched **verbatim** against the closed reaction bank
(`_reaction_audio_lookup`) to hit its pre-generated audio. Split it, or alter its text in any way, and
the match fails and every reaction falls through to live TTS — silently losing the thing that makes
chunk 0 free and instant. Skip index 0 entirely; it is one sentence by construction anyway.

**⚠️ TRAP 2 — `native_text` and `is_challenge` do not survive a split.**

In v2 the last chunk carries `native_text`, a translation of **the whole chunk**. Split that chunk into
three sentences and the translation no longer corresponds to any one of them.

Resolution, and it is a real trade rather than a detail: split first, put `is_challenge` on the **last**
piece, and drop `native_text` in favour of per-sentence translations from 3.8's
`/api/messenger/translate`. More consistent — every sentence is then translated the same way — but it
gives up the property 3.8 deliberately preserved, that the challenge sentence always has a translation
available with **no roundtrip**, which is what backs the hover-reveal in `targetOnly` mode. Decide
knowingly:
- *Per-sentence translate* (recommended): consistent, works with 3.12's visual reveal, costs one cached
  roundtrip the first time each sentence is seen.
- *Keep `native_text` on the last piece*: preserves the no-roundtrip guarantee, but the translation
  covers text the learner is no longer being shown as one unit.

**Watch for:** Spanish sentence boundaries are not just `.` — `¿…?` and `¡…!` are the common cases here,
and an abbreviation or a decimal must not split. Keep the splitter narrow and test it directly rather
than trusting a general-purpose regex.

**Shipped as:**
- **`_split_into_sentences`** (`routers/messenger.py`) — one regex, `([.?!]+)(\s+|$)`, treating a
  `.`/`?`/`!` run as a boundary only when followed by whitespace or end-of-string. Decimals ("3.50")
  need no special case: there's no whitespace after the period, so the regex never matches there. A
  small abbreviation set (`sr, sra, srta, dr, dra, ud, uds, etc`) additionally guards the one case
  that *does* have trailing whitespace but isn't a real sentence end.
- **`_merge_short_fragments`** — folds any piece under `MIN_SENTENCE_WORDS` (4) into a neighbour: the
  previous piece normally, or the next piece if it's the very first one with nothing before it.
  Re-checks after each merge so a run of several short fragments collapses in one pass rather than
  leaving a still-short remainder.
- **`_split_chunk_into_sentences`** — the two above plus TRAP 2's resolution: only eligible for
  `modality="audio", language="target"` chunks; a chunk that comes out to one sentence is returned
  as the *same object*, untouched, so nothing downstream (native_text, is_challenge) is disturbed
  when there's nothing to split. When it does split, `native_text` is dropped from every piece
  (chose the recommended "per-sentence translate later, via 3.8's endpoint" resolution — this task
  doesn't add the fetch, that's 3.12's job) and `is_challenge` moves to the last piece only.
- **Wired into both endpoints:** `_prepare_chunks` (buffered) splits every chunk except index 0 before
  calling `_prepare_chunk`; the streaming endpoint does the same per raw chunk as it arrives, tracked
  by a separate `raw_index` counter (distinct from the emitted/split index) so only the *first raw LLM
  chunk* is exempt — TRAP 1, the reaction opener must never be split or altered, since it's matched
  verbatim against the pre-generated bank. `_prepare_chunks`' recovery path (used when the streaming
  scanner couldn't reach a chunk incrementally) reuses the same updated function, so both routes to a
  "final" response go through identical splitting logic.
- **`build_premade_response_chunks`** intentionally untouched — premade audio parts are already
  hand-scripted one clip per line, and that whole path is separately known-broken (xfail, missing
  `input_intent`).
- **New `tests/test_sentence_split.py`** (22 cases): the splitter directly (boundaries, decimals,
  abbreviations, ellipsis), the merge logic (leading/trailing/cascading short fragments), the
  chunk-level wrapper (non-audio passthrough, challenge-flag migration, native_text drop,
  single-sentence identity-preservation), the index-0 exemption, and two end-to-end tests against the
  live buffered and streaming endpoints with a mocked multi-sentence LLM reply. **173 passed, 1
  xfailed** (up from 151 — no prompt goldens touched, this is turn-processing code, not the prompt).
- **Verified against a real LLM call** (not just mocked): a real turn returned
  `"La última vez cambié el aceite de un coche por gelatina. ¡Desastre total!"` as one raw chunk —
  exactly the bug this task targets. The splitter found both sentences; the merge step correctly
  folded the 2-word `"¡Desastre total!"` back into its neighbour (the same rule as the `"¿En serio?"`
  example above), matching the spec rather than producing a stray micro-bubble.

**Not done here, deferred to 3.12 on purpose:** nothing in the frontend fetches a per-sentence
translation to replace the `native_text` that a split challenge chunk no longer carries — until 3.12
lands, the hover-reveal for a challenge sentence that happened to need splitting has no translation to
show. Single-sentence challenge chunks (the common case) are unaffected, since they never lose
`native_text` in the first place.

---

### [x] 3.12 — Sequential per-sentence reveal 🟡 Sonnet

**⚠️ Presentation superseded by 3.13** — the flash moves out of the message card and becomes the
default for every sentence, not a `pairs`-only bubble zone. The plumbing this task factored out
(`needsTranslationAt`, `playTargetClip`, `flashDurationMs`, `revealTurnChunk`, the `is_challenge`
hover backfill) is all still in use.

**Problem:** every bubble renders three grey placeholder strips — "Show English", "Show Spanish",
"🔊 hover to replay" (`MessengerChat.tsx`, the three zones of the chunk bubble) — and **all of them
appear before any audio plays**. The learner gets a dead visual moment: a set of controls for content
they have not heard yet, with nothing in them.

The underlying design (listen first, reveal on demand) is right. The *timing* is what is wrong:
everything materialises at once, up front, instead of arriving when it is relevant.

**Fix:** drive the reveal per sentence, in step with playback, rather than rendering the whole turn and
then starting audio. For each sentence: reaction icons (looking → thinking → writing) → briefly show
the UI-language sentence → hide it → play the target audio → settle into the existing replay-able
bubble. Then the next sentence.

**`response_chunks[0]` gets no translation** — it is the reaction opener, it is short, and it is
carried by tone. This matches the rule already settled in 3.8.

**Files:** `frontend/src/MessengerChat.tsx` (the chunk bubble component and `playResponseAudio`).

**Depends on:** 3.11 — per-sentence reveal needs per-sentence units, or the "brief English" step is
showing a translation of two sentences at once.

---

**Visual English should REPLACE spoken English when the screen is on.**

Reading a short UI-language sentence takes ~1s; hearing it takes ~3s, and costs Azure characters —
that is the 2× TTS cost flagged when 3.8 shipped. So pairing becomes **modality-aware**: screen on →
visual flash, screen off (eyes-free) → spoken English. Same crutch, delivered through whichever channel
the learner actually has. This makes `pairs` mode both faster and free in the common case, and it means
`playResponseAudio`'s `pairs` branch should stop speaking `native_text` whenever eyes-free is off.

**The before/after fork — decide it, don't default into it.**

*When* the translation appears changes what the activity is:

| English shows | What it becomes | Difficulty |
|---|---|---|
| **Before** the audio | Scaffolding — meaning first, then hear it | easier |
| **After** the audio | Self-check — try, then find out | harder, better retention |

"Before" is the right default while the app feels overwhelming, and is what was asked for. But "after"
is the stronger learning activity, and the existing mode names already give it a home:

- `pairs` → English **before** (scaffolded)
- `alternating` → English **after** (self-check)
- `targetOnly` → no English unless hovered

That reuses the ladder from 3.6/3.8 in the visual channel rather than inventing a fourth setting.
Ship "before" first; treat the ladder as the follow-up once it can be felt.

**Watch for:**
- **Flash duration must scale with length** and hold a floor (~1.5s) — a 3-word gloss and a 12-word one
  cannot get the same window.
- **Auto-hide must not strand the learner.** The existing click-to-pin/hover-to-reveal zones stay, so a
  missed flash is recoverable — verify that still works after the timing change.
- **This is the third pass over `playResponseAudio`** (3.6, then 3.8, now this). If the mode branching
  is getting hard to follow, factor the per-chunk decision out before adding to it.

**Shipped as:**
- **Factored out, per the "Watch for" above:** `needsTranslationAt(index)` (replaces the old
  `chunksNeedingTranslation`'s inline logic — that function now just filters by it), `playTargetClip(chunk)`
  (the old `playResponseAudio`'s local `playTarget`, promoted to component scope), and `flashDurationMs(text)`.
  Both the untouched whole-turn player and the new per-sentence path agree on one definition of "does this
  chunk need a translation" instead of drifting into a second copy.
- **The flash reuses the existing bubble instead of a new overlay.** `<MessengerChallengePair>` gained
  `forceRevealNative?: boolean`, which forces its native-language zone open (with a distinct indigo tint so
  it reads as automatic, not hover) without a real hover. `flashChunk` state (`{messageId, index} | null`)
  drives it. "Settle into the existing replay-able bubble" is then literal — it's the same card, same zone,
  reverting to idle hover/pin behavior the instant the flash ends (`nativeVisible = hovered || pinned ||
  forceRevealNative`).
- **`revealTurnChunk(chunk, index)`** (new, in `sendMessage`'s closure next to `revealChunk`): reveals the
  bubble (via the unchanged `revealChunk`), then — `pairs` mode only, and only for chunks that mode needs
  translated — flashes the zone open for `flashDurationMs`, hides it, then plays the chunk's own audio.
  `alternating` is untouched (still substitutes spoken English for the chunk's own audio, unchanged from the
  old `playResponseAudio`) — the task scoped the visual-flash change to `pairs` only. The resolved
  translation is written onto the chunk `native_text` field before reveal (not just flashed), so the
  "Watch for" requirement holds structurally: a missed flash is still recoverable by hovering, because the
  zone reads from the same field either way.
- **Closes a gap 3.11 flagged as deferred here:** a v2/eyes-free challenge chunk that task 3.11's
  sentence-splitter divides into multiple pieces loses `native_text` on all but the tagged `is_challenge`
  piece, and even that piece's `native_text` is dropped by 3.11's design (see 3.11 Trap 2). Task 3.8's
  original guarantee was "the challenge sentence's translation needs no roundtrip, in every mode" —
  `revealTurnChunk` restores that specifically: an `is_challenge` chunk with no `native_text` always fetches
  one via `/api/messenger/translate`, even in `targetOnly` mode where `needsTranslationAt` would otherwise
  say no. This is purely a hover-reveal backfill — it never drives a flash or an audio substitution; only
  `pairingMode` does that.
- **⚠️ Real constraint that reshaped the "per sentence, in step with playback" ask:** the streaming
  endpoint's `"audio"` confirmation events (task 1.6) are emitted *after every chunk has already streamed*
  (`routers/messenger.py` awaits all TTS futures, then emits them, only once the model has finished writing
  the whole turn) — never interleaved live per chunk. Playing a chunk's audio the instant its text arrives
  would race a cache-miss chunk's TTS generation and could 404. Resolved by keeping the *live* per-chunk
  reveal (`revealChunk` alone, no audio) for eyes-free only, and — for screen-on turns — not revealing
  *anything* during the raw NDJSON stream at all: chunks are accumulated silently, and the whole
  reveal-flash-play sequence runs as one paced loop only once the turn (streaming or buffered) fully resolves
  and every chunk's audio is guaranteed on disk. The reaction-icon indicator (task 1.1, unchanged) simply
  covers the whole wait instead of being cut short at chunk 1 — real latency is still hidden, just no
  longer as a bubble-by-bubble reveal during generation for screen-on turns specifically. Eyes-free's
  existing live reveal + deferred-audio-for-drills path (task 3.4) is completely untouched.
- **Call-site branching, all in `sendMessage`:** the streaming NDJSON handler now only calls `revealChunk`
  live `if (eyesFree)`; the buffered-path loop only runs immediately `if (usePremadeEndpoint || eyesFree)`
  (premade scripts never went through pairing/translation logic, so they keep the old immediate reveal
  regardless of `eyesFree`); the final drill/play block is now a three-way branch — drill (unchanged),
  `eyesFree || usePremadeEndpoint` → the old whole-turn `playResponseAudio`, else → the new per-chunk
  `revealTurnChunk` loop.
- **Ladder reassignment (alternating=after, targetOnly=hover-only) not done** — the task explicitly scoped
  this to follow-up ("ship 'before' first; treat the ladder as the follow-up once it can be felt").
- **Translation fetches are now per-chunk, not batched for the whole turn** — simpler to reason about
  alongside the per-sentence loop, at the cost of a few more `/api/messenger/translate` round trips per
  turn; each is still content-hash-cached (3.8), so a repeated sentence is still free the second time.

**Not verified in a browser** — no `chromium-cli`, Playwright, or `claude-in-chrome` tooling available in
this environment (checked all three). `npx tsc --noEmit` and `npm run lint` are clean on every touched
line (same 2 pre-existing, unrelated errors elsewhere in the file as before this task). Noticed the user
already had a live dev session running (frontend on :5173, backend on :8000, `mock_mode: false`) — did not
touch, restart, or interact with it, and shut down the separate throwaway instance (:5174) started to check
that `npm run dev` at least boots. **Please click through `pairs` mode yourself** — timings
(`flashDurationMs`, the reaction-indicator-covers-the-whole-wait trade-off) are reasoned, not tuned by ear
or eye, same caveat as most of Phase 3.

### [x] 3.13 — Translation as the character's thought, not a bubble zone 🟡 Sonnet

**Supersedes 3.12's flash *presentation*.** 3.12 shipped the reveal as `forceRevealNative` opening the
native-language zone **inside** the message card (indigo tint), in `pairs` mode only, for the chunks
that mode needs translated. Everything underneath it stays — `needsTranslationAt`, `flashDurationMs`,
`playTargetClip`, `revealTurnChunk`, and the `is_challenge` hover-reveal backfill are all reused. What
changes is where the translation appears, what it looks like, when it appears, and how often.

**The problem with a bubble zone:** a translation rendered *inside* the message card implicitly claims
to be part of the message — it competes with the target sentence for being "the content". The learner
should never be in doubt that the Spanish **is** the message.

**The conceit that fixes it:** the translation is the character's **pre-verbal thought**; the target
sentence is what they actually say. Thought is fleeting and quiet, speech is the artifact that stays
in the bubble. That framing is what the styling below is expressing — it is not decoration.

---

**Four changes:**

1. **Move it out of the message card.** Render the translation as an ephemeral line in the message
   flow where the reaction-phase indicator already lives (`reactionPhase`: reading → thinking →
   typing), sequenced **between `thinking` and `typing`**. Narratively: the character thinks the
   meaning, then writes it in the target language. Then it disappears and the bubble arrives.

2. **Every sentence except `response_chunks[0]`.** Currently only the chunks `pairs` mode asks for.
   Chunk 0 stays untranslated — it is the reaction opener, it is short, it is carried by tone, and
   that rule was settled in 3.8.

3. **Muted, ignorable styling.** Low contrast, small, visually subordinate to everything around it.
   The requirement is that the learner can **choose to look away and simply not read it** — which is
   what makes it optional scaffolding rather than a crutch that is impossible to avoid. If it draws
   the eye, it has failed.

4. **Show it on replay too.** When the learner replays a sentence's audio, show the same thought text
   again alongside it. Ephemeral text creates a real anxiety — "I missed it and it's gone" — and
   replay is the answer. The asymmetry is deliberate: the first pass is a listening test, replay is a
   repair action, so repair gets more support.

**Keep "hide, then play" — do not overlap the text with the audio.** With the text still up, the
learner reads and listens at once, which in practice means they read. Hiding it first forces them to
hold the meaning in memory and map the target audio onto it. That is the version that trains
listening, and it is the whole reason this is worth building.

**The thinking icons are free cover for the translate call.** The character is visibly "thinking"
while `/api/messenger/translate` is in flight, so the latency lands inside the fiction instead of
behind a spinner — the same trick as task 1.1. Sequence the fetch to start as early as possible and
let the `thinking` phase absorb it.

---

**This becomes the default when the screen is on, regardless of `pairingMode`.**

- **Keep the three modes in the code.** They are cheap to keep and expensive to rebuild if this
  doesn't survive contact with real use. This is a change of default, not a deletion.
- **Eyes-free is unaffected and must stay that way.** A muted visual thought does nothing with the
  screen off, so eyes-free keeps its spoken-English path. Gate on eyes-free, not on `pairingMode`.
- `alternating`'s audio substitution is untouched.

**Files:** `frontend/src/MessengerChat.tsx` (`revealTurnChunk`, the reaction-phase indicator, the
replay handler, and `MessengerChallengePair`'s `forceRevealNative` — which may become unused for the
flash but is still wanted for the `is_challenge` hover backfill).

---

**⚠️ The translate endpoint becomes load-bearing for the default experience.**

It was opt-in (pairs mode only); now every turn depends on it. Two consequences:
- **Volume roughly doubles** — ~2 translations per turn instead of only what `pairs` asked for. Still
  the cheapest model and still cached (`translation_store.py`), so this is a note, not a blocker.
- **Its failure mode now matters more.** Task 3.8 made `/api/messenger/translate` return `ok:false`
  with nulls rather than raising, so a failure means the thought text simply doesn't appear and the
  audio plays as normal. **Verify that still holds** — a translate outage must degrade to
  target-only, never stall the turn or block the bubble.

**⚠️ Don't lose the recovery path.** 3.12 deliberately writes the resolved translation onto the
chunk's `native_text` before revealing, so a missed flash is still recoverable by hovering the bubble
zone. Moving the flash out of the card must **not** stop that write — the hover zone stays as the
"I looked away and want it back" path, alongside replay.

**Watch for:**
- **Flash duration must scale with length** and hold a floor — `flashDurationMs` already exists, reuse
  it rather than inventing a second timing rule.
- **There must be a beat between hiding the text and starting the audio**, but not a dead one. If it
  reads as a stall, shorten the gap rather than overlapping the text back into the audio.
- **This is the fourth pass over the reveal/playback path** (3.6, 3.8, 3.12, now this). 3.12 already
  factored out `needsTranslationAt` / `playTargetClip` / `flashDurationMs` — build on those rather
  than adding a fifth branch beside them.

### [x] 3.14 — Bubble arrives after the audio; empty bubble is the playback indicator 🟡 Sonnet

**⚠️ Indicator superseded by 3.15** (canned equalizer, not a progress sweep) and **the auto-reveal
was reverted** in `6046d14` — target text stays hover-gated forever. The empty-bubble-reserves-layout
part of this task stands.

**⚠️ Amended after shipping:** this spec's target sequence has the target-language zone auto-reveal
("target text appears inside the bubble it just filled") once the clip finishes. Built that way first,
then explicitly reverted on user feedback — **both zones stay hover-gated forever, with no auto-reveal
after listening.** Only the pending→empty-progress-card behavior (Problem 1/2 below) shipped as
specified.

**Two problems, one fix.**

**Problem 1 — you can still read along, just in the target language.** Task 3.13 hides the translation
before the audio plays, deliberately: the point is training listening, not reading. But the target
sentence's bubble is on screen *during* playback, so the learner can read along in the target language
instead. Same hole, other side of it.

**This is the completion of 3.13's principle, not a layout preference.** Say so in the code, or a
later pass will "helpfully" restore the text during playback and quietly undo both tasks.

**Problem 2 — hovering resizes the card.** `MessengerChallengePair` has no width constraint
(`MessengerChat.tsx`, the card's outer `div`), and its zones swap a short placeholder ("Show English")
for a full sentence. Revealing therefore changes the card's width dramatically, which moves both its
edges. Horizontal movement is the jarring axis.

---

**Target sequence, per sentence:**

```
thinking icon → ephemeral translation (3.13) → hidden
  → bubble appears EMPTY, already at final size, progress sweep fills as the clip plays
  → audio ends → target text appears inside the bubble it just filled
```

**Make the empty bubble itself the playback indicator.** It is doing three jobs at once, which is why
it is worth speccing tightly rather than adding a separate widget:

1. **Reserves the layout** from the first frame, so nothing jumps when the text lands.
2. **Shows duration** — with no text on screen the learner otherwise has no sense of how long the
   sentence is or where they are in it.
3. **Binds the sound to the bubble** it belongs to, rather than floating somewhere else in the flow.

**Progress, not amplitude.** An animated waveform or bouncing equalizer signals "sound is happening",
which the learner already knows — they can hear it. A progress sweep tells them something they cannot
otherwise know. A real amplitude meter also needs a Web Audio `AnalyserNode` wired into the player,
and a *fake* one that isn't tied to the actual signal looks subtly wrong. Drive the sweep from clip
duration and elapsed time.

**Fallback:** if duration isn't known when playback starts (a cache miss still resolving), use an
indeterminate shimmer rather than a stalled-looking 0% bar, and switch to real progress once known.

---

**The width fix — two separate causes, fix both:**

1. **Constrain the card**, e.g. `max-width: min(60ch, 85%)`, so a long sentence *wraps* instead of
   stretching the box. Width then never changes at all.
2. **Ghost sizer for the reveal.** Render the longest variant invisibly (`visibility: hidden`, or an
   opacity-0 copy in the same grid cell) and toggle visibility rather than mounting/unmounting the
   text. The card is then always sized for its widest and tallest state, so hovering changes
   appearance and nothing else.

Size each box to **its own** longest state (its translation vs its target text, whichever is bigger)
rather than measuring the longest sentence in the turn — exact, simpler, and with a fixed max-width
the boxes already look consistent.

---

**Decide: what replay looks like.** By replay time the bubble exists and has text in it. The playback
visual should **not** hide that text again — a sweep across the existing bubble is right. Replay is a
repair action; taking the sentence away from the learner at the moment they asked to hear it again is
the opposite of what repair should do. (The translation *does* show on replay — that is 3.13 point 4,
already shipped.)

**Files:** `frontend/src/MessengerChat.tsx` — `MessengerChallengePair` (card sizing, zones, the new
progress state) and `revealTurnChunk` (the reveal/playback ordering).

**Watch for:**
- **Eyes-free is unaffected.** No visual channel; it keeps the whole-turn `playResponseAudio` path.
  Gate on eyes-free, exactly as 3.13 does.
- **An empty bubble for ~3s is the main risk.** A progress sweep should read as "playing", but if it
  reads as "broken" the fix is to bring the bubble in slightly later or soften its border while empty
  — not to put the text back during the audio, which would undo the point.
- **Fifth pass over the reveal/playback path** (3.6, 3.8, 3.12, 3.13, now this). Build on the helpers
  3.12 factored out (`needsTranslationAt`, `playTargetClip`, `flashDurationMs`) rather than adding
  another branch beside them.

### [x] 3.15 — Replace the progress sweep with a canned audio-wave animation 🟢 Haiku

**Revises 3.14's playback indicator only.** Everything else 3.14 shipped stays: the bubble still
arrives empty at final size before the clip, still reserves the layout, and its text still stays
hover-gated forever (per the revert in `6046d14` — see the hover-gated-text preference in memory).

**Change:** swap the duration-driven progress sweep for a **canned equalizer animation** — a small row
of bars that animate whenever audio is playing and are identical every time. Not tied to the real
signal, not tied to clip duration.

**Why, since 3.14 argued the other way and was wrong:** a progress bar reads as *"the app is loading
something."* Bouncing bars read as *"someone is speaking."* The whole conceit of task 3.13 is that
this is a character thinking and talking, not a UI fetching content — and a loading bar breaks that
fiction at precisely the moment it should be strongest. That outweighs the duration argument 3.14
made, especially now that 3.9 caps sentences short enough that "how much longer" isn't a real
question, and 3.14's revert means no text arrives at the end to anticipate anyway.

**Implementation — deliberately the cheap version:**
- 4–5 bars, pure CSS `@keyframes` scaling height, staggered `animation-delay` so they look
  independent. No Web Audio, no `AnalyserNode`, no rAF loop, no duration tracking.
- **Pause, don't unmount.** Use `animation-play-state: paused` when idle so the bars freeze in place
  rather than disappearing — no layout shift, and a frozen equalizer reads as "paused" rather than
  "gone".
- **Respect `prefers-reduced-motion`** — fall back to a static or slowly-pulsing form. Cheap to add,
  and this animation runs on every single sentence.

**Sizing:** this is the *only* thing on screen during playback, so unlike 3.13's deliberately
ignorable thought text it can be plainly visible. Still small and calm — it marks that someone is
speaking, it is not the focus.

**What is given up:** the duration cue. Accepted. The empty bubble still does the layout-reservation
job, which was the most valuable of 3.14's three, and the bars still answer "is it playing". If
"where am I in this sentence" ever turns out to matter, it can come back as a subtle border fill
without touching the bars.

**Files:** `frontend/src/MessengerChat.tsx` (`MessengerChallengePair`'s playback indicator).

**Watch for:** the bars must stop when audio stops for *any* reason — clip end, B-button stop-audio
(task 4.2), or a failed fetch. A permanently animating equalizer with no sound is worse than no
indicator at all, because it claims audio is playing when it isn't.

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
**➜ Real-hardware status:** the mic side is **working**, via the user's own mapper rather than
`tools/controller/f13_mapper.py` (which was written blind and is still unverified). Their mapper sends
**Ctrl+F13**, which the in-app listener accepts unchanged — `e.key` is `"F13"` regardless of
modifiers, and the listener deliberately does not inspect them. Keep `f13_mapper.py` only as a
fallback for a machine without that setup.

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

**⚠️ Largely superseded by 4.6** — the flick becomes directional (left cancel+clear / right
send-now), and A/X/Y/LB/RB/LT are unbound. L3/R3 recording and the 0.8/0.3 flick hysteresis carry over.

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

**⚠️ Superseded by 4.7** — traversal moves from LB/RB to the D-pad, and the cursor becomes visible.

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

**⚠️ Superseded by 4.7** — the D-pad becomes message traversal. The eyes-free and pairing-mode
toggles need a new home (see 4.7's last "Watch for").

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

### [x] 4.6 — Directional stick flick, longer auto-send, unbind the rest 🟡 Sonnet

**Supersedes the flick half of 4.2 and most of its button map.** Recording stays on L3/R3 via the
F13 mapper (4.1) — unchanged.

**Stick flick becomes directional:**

| Gesture | Action |
|---|---|
| **Flick left** (either stick, past 0.8) | Cancel the pending auto-send **and clear the textarea** |
| **Flick right** (either stick, past 0.8) | Send now — skip the rest of the countdown |
| Flick up / down | Nothing (reserved) |

**Right-flick is scoped to a pending Wispr auto-send, and only that.** It fires **only** when Wispr
has pasted text and the countdown is already running; outside that window it does nothing. It is not
"send the textarea" — a user who *typed* their message gets no flick-send, by design.

**Why that scoping matters (keep it):** it makes right-flick non-destructive. It never sends anything
that wasn't already going to send — it only declines to wait. Without the scope, a stray flick fires
a half-formed message at the LLM, which costs money and pollutes the conversation, and unlike cancel
there is no undo. Cancel is recoverable, send is not; that asymmetry is the whole reason for the
restriction.

**Left-flick also clears the textarea**, matching what Escape already does in the shared auto-send
spec — cancelling a dictation you didn't want should not leave its text sitting there.

**Direction needs a dominant-axis rule.** Today the flick is magnitude-only (`Math.hypot`, task 4.2),
so any direction counts. With direction meaningful, require the horizontal component to clearly
dominate — `Math.abs(x) > 1.5 * Math.abs(y)` — or a diagonal flick decides for itself which way it
went. Keep 4.2's existing hysteresis exactly as-is: fires once past 0.8, re-arms below 0.3.

---

**Auto-send timer gets longer** — 1.5s → ~2.5–3s.

Right-flick is what makes this free: a longer countdown costs nothing when you can always skip it, so
prefer generous over timid. Pick the value with the flick in hand, not before.

**⚠️ This lives in the shared `useWisprAutoSend` hook and therefore changes all seven modes**, not
just messenger. That is the right place for it (the reasoning generalises, and CLAUDE.md's shared-
conventions rule says timing belongs in the hook) — but it should be a deliberate choice, not a
surprise discovered later in trivia.

---

**Unbind the rest.** A, X, Y, LB, RB and LT come off the controller for now; new uses will be assigned
later. Delete the `case` arms in `MessengerChat.tsx`'s `onButtonChange` / `onFrame`, but **keep the
underlying functions** — they are cheap to re-bind and several are still reachable elsewhere.

**Two exceptions to check before deleting:**
1. **Keep `B` = stop audio.** With the screen off there is otherwise no way to kill a clip mid-play,
   and it costs one line to retain. Worth overriding the "unbind everything" instinct for.
2. **`Y` (repeat slower) has no keyboard equivalent.** A → `repeatLastAudio` and X → `explainDrill`
   survive via Alt+R / Alt+E, but `repeatLastAudioSlow` is controller-only. Unbinding Y makes
   slow-replay unreachable from any input. Fine if intended — just don't lose it by accident. Give it
   an Alt binding if you want to keep it available.

**Files:** `frontend/src/MessengerChat.tsx` (the `useGamepad` handler),
`frontend/src/sharedGameHooks.ts` (`useWisprAutoSend`'s delay constant).

**Watch for:** LT's release handler currently calls `audioPlayer.stop()`. If LT is unbound, make sure
that stop isn't the only thing halting a stuck clip — see the `B` note above.

**Shipped as:**
- **Directional flick** (`MessengerChat.tsx`'s `useGamepad` `onFrame`): the two sticks' magnitudes
  (`Math.hypot`) are compared and the larger one's `x`/`y` is used for direction, so the dominant-axis
  test (`|x| > 1.5|y|`) is evaluated against whichever stick actually moved, not an average of both.
  Hysteresis is unchanged from 4.2 — the 0.8-fire/0.3-rearm edge still disarms on *any* direction
  (including up/down and ambiguous diagonals), so a reserved-direction flick still consumes the arm
  and doesn't double-fire; it just produces no action. Both left and right are additionally gated on
  `autoSendStateRef.current?.pending` — left cancels + earcons `sendCancelled` + `setTranscript("")`
  (mirrors what Escape already does via `GameTextarea`'s `clearInput`, done directly here since
  `transcript` is owned by `MessengerChat`, not the shared component); right calls the auto-send
  hook's own `submit()`, which sends whatever's currently in the box and needs no new earcon — it
  flows straight into `sendMessage`'s existing "sent" haptic/earcon.
- **`autoSendStateRef`/`onAutoSendChange`** (`sharedGameComponents.tsx`'s `GameTextarea`) extended
  from `{pending, cancel}` to also carry `submit` — `useWisprAutoSend` already exposed a `submit()`
  that pre-empts the pending window exactly like Enter does, so right-flick needed no new send path,
  just a wire to an existing one. Purely additive; every other `GameTextarea` caller is unaffected by
  the wider state shape since they don't read `onAutoSendChange` at all.
- **`AUTO_SEND_WINDOW_MS`** (`sharedGameHooks.ts`) raised from 1500 to **3000** — the top of the task's
  2.5-3s range, per "prefer generous over timid" now that right-flick makes waiting the whole window
  costless. This is the shared constant every mode's `useWisprAutoSend` call reads, so all seven modes
  now wait 3s before an unattended dictation auto-sends, not just messenger.
- **Unbound A/X/Y/LB/RB/LT** — their `case`/`onFrame` handling deleted from `MessengerChat.tsx`'s
  `useGamepad` call; `B` kept verbatim (backup cancel + `audioPlayer.stop()`), satisfying the LT
  watch-for note without a code change since B's stop was already unconditional. D-pad (4.5) is
  untouched here — 4.7 is what replaces it, not this task.
- **Functions kept but no longer controller-reachable:** `repeatLastAudio`/`explainDrill` stay reachable
  via the existing Alt+R/Alt+E hotkeys. `repeatLastAudioSlow` (Y) and `speakLastChallengeTranslation`
  (LT) had no other caller left after unbinding — TypeScript's `noUnusedLocals` (on in this repo) would
  have failed the build on a truly dead local function, so both got new hotkeys in the same eyes-free
  listener: **Alt+S** (repeat slower) and **Alt+T** (hear the translation). This goes slightly beyond
  what the task named (it only flagged Y explicitly) but follows the same reasoning it gave for Y, and
  keeping LT's translation reachable seemed better than deleting a working feature to satisfy the
  linter. `replayStack.stepBack`/`stepForward` needed no such treatment — they're methods on a hook
  object still used elsewhere (`.items`, `.current()`), not standalone local declarations, so an unused
  method reference isn't a lint/type error the way an unused function is.
- Toolbar badge tooltip (4.1/4.2/4.5) rewritten to describe the new map: B, directional flick, D-pad,
  and a pointer to the Alt+R/E/S/T keyboard fallbacks for what's now unbound.

**Not verified:** no physical controller in this environment, same caveat as the rest of Phase 4 — the
0.8/0.3 hysteresis and 1.5-multiplier dominant-axis threshold are reasoned, not felt. Typecheck
(`npx tsc --noEmit -p .`) and lint are clean on every touched line — lint shows the same two
pre-existing `MessengerChat.tsx` errors as before (an `any` and an unused `msgIndex`, both
unrelated/unmoved) plus the same pre-existing errors in other files. Backend untouched; suite is
**173 passed, 1 xfailed** (grown from 89 via other sessions' unrelated work landed on `main` since 4.5;
confirmed via `git status --short` that no backend files were touched this task).

---

### [x] 4.7 — D-pad message traversal with a visible cursor 🟡 Sonnet

**Replaces 4.3's LB/RB navigation and 4.5's D-pad mode toggles.** All traversal moves onto the D-pad,
so browsing the conversation is one thumb in one place.

| Control | Action |
|---|---|
| **D-pad ←** | Play previous message's audio |
| **D-pad →** | Play next message's audio |
| **D-pad ↑** | Play current message's audio |
| **D-pad ↓** | Cycle the current message's text: hidden → translation → translation + target → hidden |

**⚠️ Remapped after initial ship, per direct follow-up feedback** — the table above is what was
originally speced; what's actually live is:

| Control | Action |
|---|---|
| **D-pad ↑** | Previous message (moves the cursor only — silent) |
| **D-pad ↓** | Next message (moves the cursor only — silent) |
| **D-pad ←** | Play the current message's audio |
| **D-pad →** | Cycle the current message's text: hidden → translation → translation + target → hidden |

Same four actions, reassigned so up/down is purely "move" and left/right is purely "act" — traversal
and playback no longer happen on the same press. See the 4.7 shipped-as note below for what actually
changed in code.

**Show which message is current** while traversing — a bolded/coloured border on that bubble.
Prefer a **border** over a background colour: the card already uses indigo and blue tints for the
hover/pin/flash states (`MessengerChallengePair`), and another colour there will collide.

---

**⚠️ D-pad ↓ does NOT violate the hover-gated-text rule.** That rule (see the messenger hover-gated
text preference in memory, and the revert in `6046d14`) forbids text *auto*-revealing after playback.
A D-pad press is a deliberate request — the controller's equivalent of hovering the zone. State that
in the code, or a future session will correctly flag it against the preference and stall.

**⚠️ Two pieces of plumbing this needs that don't exist yet:**

1. **`ReplayItem` has no link back to a bubble.** It is
   `{ text, locale, source, audioUrl, nativeText }` (`sharedGameHooks.ts`) — nothing identifies which
   message or chunk it came from, so there is nothing to highlight. Add `messageId` + `chunkIndex` at
   push time.

2. **The cursor is a `ref`, and deliberately so.** From the hook: *"A ref, not state: nothing renders
   off it today, and re-rendering the whole chat on every shoulder-button tap would be wasted work."*
   A visible cursor reverses that. The stated cost is real — do it knowingly: promote the cursor to
   state **and** memoize the bubble component so a D-pad tap re-renders two bubbles (old current, new
   current), not the entire conversation.

**Files:** `frontend/src/sharedGameHooks.ts` (`ReplayItem`, `useReplayStack`'s cursor),
`frontend/src/MessengerChat.tsx` (the `useGamepad` D-pad arms, `MessengerChallengePair`'s cursor
styling, every `replayStack.push` call site).

**Watch for:**
- **`push()` resets the cursor to `-1` ("track latest")** on every new turn's audio. Keep that — but
  now it is visible, so make sure a new turn arriving while browsing doesn't silently move the
  highlight without explanation.
- **What happens at the ends of the list** — clamp, or wrap? Clamp is safer eyes-free: wrapping from
  the newest message to the oldest with no visual is disorienting.
- **The eyes-free case has no highlight at all**, so the audio itself has to carry position. Consider
  reusing an earcon (2.3) at the list boundary rather than silently doing nothing.
- **4.5's mode toggles lose their home.** Eyes-free toggle and pairing-mode cycle were on D-pad ↑/↓.
  Decide where they go — an on-screen control is fine, since both are session-level settings — or
  they become unreachable from the controller.

**Shipped as:**
- **`ReplayItem`** (`sharedGameHooks.ts`) gained required `messageId`/`chunkIndex` fields — the missing
  plumbing the task called out. All three `replayStack.push` call sites updated: the pivot flow
  (`charMsgId2`, index 0 — a pivot is always a single-chunk message), the main per-chunk reveal inside
  `sendMessage` (`characterMsgId`, and the `index`/`shownCount` already tracked there — this is also
  the eyes-free and premade path, since everything funnels through the same `revealChunk`), and the
  user's own corrected-sentence audio (`userMsgId`, index 0).
- **`useReplayStack`'s cursor** promoted from `cursorRef` to `useState`, exactly as flagged. `stepBack`/
  `stepForward` changed from `void` to returning the `ReplayItem` they land on (`| null`) — needed
  because `setCursor` is async, so a caller that steps and then wants to act on "wherever we landed"
  (D-pad left/right playing that item's audio) can't reliably do it through a follow-up `current()`
  call the way the old ref version could; both now clamp at the ends (`Math.max(0, …)`/`Math.min(len-1,
  …)`) rather than wrap, per the watch-for. No other caller of `stepBack`/`stepForward` existed after
  4.6 unbound LB/RB, so the signature change was free.
- **D-pad remap** (`MessengerChat.tsx`'s `useGamepad` `onButtonChange`, replacing 4.5's up/down toggles
  entirely) — **as first shipped:** Up → `repeatLastAudio()`, Down → `cycleCurrentReveal()`, Left/Right
  → `stepReplayCursor(-1|1)` (moved the cursor *and* played what it landed on). **Revised immediately
  after, per direct follow-up feedback** to the mapping in the "what's actually live" table above: Up/Down
  now call `stepReplayCursor` with no playback (traversal and playback split into separate presses),
  Left calls `repeatLastAudio()` (same function Alt+R and the old A button used — "current message"
  during a drill is still the drill target, matching that existing special case), Right calls
  `cycleCurrentReveal()`. Same four building blocks, different buttons; nothing about *what* Up/Down/
  Left/Right each do changed, only *which one* does which.
- **`stepReplayCursor`** moves the cursor; after the remap it is synchronous and silent (`void`
  removed from its return type) rather than also awaiting playback — Left now owns playing what the
  cursor landed on, via the existing `repeatLastAudio()`. Boundary feedback still reuses the existing
  `sendCancelled` thud rather than adding a new `EarconType`: if stepping returns the same
  `(messageId, chunkIndex, source)` as before the step, the cursor didn't move, so the thud plays
  immediately — audio-only proof that this is the end of the list, not a swallowed button press. (This
  thud no longer has a repeated *audio clip* riding along with it the way the original version did,
  since stepping itself is silent now — the thud alone carries the "you're at the edge" signal.)
- **`cycleCurrentReveal`** cycles a `Map<string, 0|1|2>` (`dpadRevealLevels` state, keyed
  `${messageId}-${chunkIndex}` — the same key format `pendingChunkKeys` already uses) 0→1→2→0 for
  whatever `replayStack.current()` points at. No-ops on user-sourced items, which have no
  hidden/translation zones to cycle. `MessengerChallengePair` takes a new `revealLevel?: 0|1|2` prop
  and ORs it into the existing `nativeVisible`/`learningVisible` checks (level ≥1 shows the
  translation, ≥2 also shows the target) — additive to hover/pinned/`forceRevealNative`, not a
  replacement, so a D-pad-revealed zone and a mouse-pinned zone coexist normally. Documented inline
  as *not* a hover-gated-text violation, per the task's explicit warning: the rule only bars
  *automatic* reveal after playback, and a D-pad press is a deliberate request, same as a click.
- **Visible cursor.** `MessengerChallengePair` gained a `current?: boolean` prop drawn as a 2px amber
  (`#f59e0b`) border replacing its default indigo one — a border, not a background tint, since the
  card already uses indigo (its own border) and blue (learning-zone/pinned tints) and another color
  there would collide, exactly as flagged. Wrapped in `React.memo` per the plumbing note, so a D-pad
  tap (now real state — `dpadRevealLevels`, and the replay cursor) only re-renders the bubbles whose
  props actually changed. `currentReplayKey` is computed once per render from `replayStack.current()`
  and compared against each chunk's existing `chunkKey`; gated on `gamepad.connected` so a mouse-only
  session never grows a border on its latest bubble — the cursor is genuinely meaningless without a
  controller to move it. Scoped to `MessengerChallengePair` only (character chunks), matching the
  task's own Files note; user bubbles don't grow a matching border.
- **Push resetting the cursor to `-1`** ("track latest") is unchanged and now visibly relevant: a new
  turn's audio arriving while browsing snaps the border to the new latest bubble. Left as-is rather
  than adding an explicit callout — the border jumping *is* the visible explanation the watch-for
  asked for; only the (separately handled) eyes-free case has no visual to carry that.
- **4.5's toggles.** Eyes-free and pairing-mode both already had on-screen controls (the 🙈 checkbox
  and the pairing-mode `<select>`) before this task touched anything, so losing the D-pad shortcut
  leaves both reachable — no new UI needed, matching the "on-screen control is fine" option.
- Toolbar badge tooltip rewritten again to describe D-pad traversal and point out where eyes-free/
  pairing-mode moved.

**Not verified:** no physical controller in this environment, same caveat as the rest of Phase 4 — the
boundary-thud logic and the amber cursor border are reasoned, not seen. Typecheck and lint are clean
(same two pre-existing `MessengerChat.tsx` errors as 4.6, unmoved in kind, only shifted a few lines by
the insertions; same 45/10 repo-wide lint totals as before, none new). Backend untouched — confirmed via
`git status --short` — but its suite is flaky independent of this task: `test_scene.py::
test_turn_endpoints_create_and_advance_a_scene[/api/messenger/turn]` passed on one run this session
(173 passed, 1 xfailed) and failed on the next (172 passed, 1 failed, 1 xfailed) with zero code changes
between them, which points at shared runtime-state files (`backend/profiles/default_profile.json` is
mutated by test runs and not fully reset) rather than anything in this task.

---

# Phase 5 — Engagement

`generate_turn_instruction` (`messenger_prompt.py:28`) returns an identical instruction every turn
except the every-5th assessment — no arc, no stakes, nothing that can resolve. A conversation that
*can't end* is structurally boring regardless of content.

### [x] 5.0 — Wire persona tuning through to the LLM call 🟡 Sonnet

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

**Shipped as:** a new `get_persona_tuning()` in `prompts/messenger_prompt.py` — reads
`meta.temperature` and `tuning.max_tokens` off the active persona JSON (already loaded via
`load_persona_json(PERSONA)`), falling back to the old hardcoded values (temperature 0.2, 800 output
tokens) if a persona omits them, so an untuned persona is unaffected. `build_layered_prompt`'s
signature/return shape is untouched — the many `system, user = build_layered_prompt(...)` call sites
in `tests/test_prompt_snapshot.py` didn't need updating.

`routers/messenger.py` calls `get_persona_tuning()` at both LLM call sites (buffered
`/api/messenger/turn` and the streaming `/api/messenger/turn/stream`, which is what the frontend
actually prefers — patching only the buffered path would have left the primary experience still
running at the 0.2 default) and spreads it into `call_llm_for_messenger(**tuning)` /
`stream_llm_for_messenger(**tuning)`. `call_llm_for_messenger` gained a `max_output_tokens` param
(previously hardcoded to 800 inside the function) so it can accept the persona's value the same way
`stream_llm_for_messenger` already did.

Verified: `get_persona_tuning()` returns `{"temperature": 0.9, "max_output_tokens": 140}` for Jorge
and reads Sombongo's `0.8`/`120` correctly too. **89 passed, 1 xfailed** — same baseline, no re-golden
needed since this never touches the prompt text itself. Not verified against a real API call (no
budget spent this session) — the malformed-JSON/language-mixing risk called out above is still open
to watch for in a live session.

> **⚠️ Half of this was wrong, and unverified is why (fixed 2026-08-08).** Passing the persona's
> `tuning.max_tokens` through as `max_output_tokens` **broke every real messenger turn.** 140 is how
> long Jorge *talks*; `max_output_tokens` caps the whole JSON envelope — reply + `corrected_input` +
> `user_translation` + `error_explanation` + 2 suggested replies + (every 5th turn) `level_assessment`.
> A real turn measures **397 completion tokens**, so the model was cut off mid-JSON every single time.
> The failure was near-invisible: `response_chunks` is the first field, so the stream scanner had all
> three bubbles *before* the cutoff and they rendered with working audio — only the final `json.loads`
> failed, which surfaced in the UI as "Failed to send message. Please try again." with no autoplay.
> `get_persona_tuning()` now treats `tuning.max_tokens` as a floor-guarded hint: it can only ever
> **raise** the cap above `MIN_TURN_OUTPUT_TOKENS` (800, the pre-5.0 value), never lower it. The
> temperature half of 5.0 was right and is untouched. Reply length is a prompt concern, not a
> token-limit concern. Regression-tested in `test_prompt_snapshot.py`; `stream_llm_for_messenger` now
> names the token cap in its parse error instead of surfacing a bare `JSONDecodeError`.

**Out of scope, left alone on purpose:** `presence_penalty` (both personas declare
`meta.presence_penalty`, but the task only asked for temperature/max_tokens, and OpenAI's Responses
API support for it wasn't checked — a separate call if wanted).

---

### [x] 5.1 — Scene layer with an explicit ending condition 🔴 Opus

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

**Shipped as:** scene state in the profile under `scene` (`profile_store.py`: `pick_scene_dimensions`
/ `new_scene` / `advance_scene`), drawn from a new `prompts/helpers/scene_dimensions.json` — 12
settings × 12 character goals × 8 user goals × 8 complications, each character goal carrying its own
completion condition. `llm_call.generate_scene()` concretizes one draw ("a favor" → "the scooter you
lent him on Tuesday") in a single ~250-token call on `settings.SCENE_MODEL` (gpt-4.1-nano), once per
scene rather than per turn. Prompt side: `build_scene_context()` renders
`prompts/templates/scene.txt` and `scene_progress_instruction()` emits the `SCENE PACING — turn N of
M` line, **both in the dynamic tail**, with pacing last so the final-turn "resolve now" isn't buried.

**Three decisions worth knowing about:**
- **Scene end is a turn budget (`SCENE_MIN_TURNS`..`SCENE_MAX_TURNS` = 5–10, drawn per scene), not a
  model flag.** A `scene_complete` field would have gone in the OUTPUT SCHEMA — i.e. the static
  prefix — and let the model postpone endings indefinitely, which is the exact failure this task
  exists to fix. The completion *condition* is what the character plays toward; the budget is what
  makes it land.
- **The draw happens in Python, the LLM only makes it specific.** Asking a model for "a scene"
  repeatedly converges on the same three scenes. `pick_scene_dimensions` also excludes the previous
  scene's setting and character goal, so consecutive scenes never open the same way.
- **Rotation happens in `_finalize_turn`, not at turn start.** `_ensure_scene` is called at the top
  of both endpoints too, but that's the cold-start path; the normal case draws the next scene the
  moment a budget runs out, so the ~1s setup call lands while the learner is still hearing the reply
  instead of in front of the first audio chunk.

A failed or skipped `generate_scene` falls back to the raw draw, which is already playable — and
mock mode *is* that fallback path, so the tests exercise it for real.

**Tests: 109 passed, 1 xfailed** (was 89/1). New `tests/test_scene.py` (draw, no-repeat, budget
lifecycle, rotation through both endpoints, stubbed `generate_scene`) plus 9 scene cases in
`test_prompt_snapshot.py`, including "scene content appears nowhere in the static prefix" and "two
different scenes produce byte-identical prefixes". **Goldens did not move** — a sceneless profile
produces exactly the pre-5.1 tail (empty sections are dropped, not left as blank gaps).

**Verified live** on gpt-4.1-nano — two real calls, **0.0221 cents total** (spend 34.833 → 34.855).
Valid JSON, exactly the five keys, all non-empty, first try both times; ~410–560 in / ~150 out, so a
scene costs ~0.012 cents every 5–10 turns.

The first live call exposed a real defect the stub tests could never have caught: **nano inverted the
perspective**, writing `character_goal` from the learner's side — *"You need Jorge to stall them so
you can slip away"* — which is nonsense once it lands in the prompt under `Your goal (Jorge):`. It
also ended the scene on an external event ("the door swings open"), which no amount of talking can
cause. Three fixes, then re-verified with the second call:
1. An explicit PERSPECTIVE section in the generation prompt (second person = the character in
   `character_goal`/`complication`, third person "the learner" in `user_goal`, never the character's
   own name in their own goal).
2. A "reachable through what they SAY — never an external event" rule on the completion condition.
3. A deterministic guard in `generate_scene`: if `character_goal` or `complication` contains the
   character's name, that field is blanked and `new_scene` falls back to the drawn dimension, which
   cannot be inverted. One bad field never sinks the scene.

Two dimension entries whose own completion conditions invited an external ending were reworded at the
same time (the "keep them here" and "borrow something" goals).

**Still slightly loose:** the second call let the completion condition drift toward the *user's* goal
("you finally admit you were wrong" instead of "you got the answer"). Both branches are still things
the character does in dialogue, so it plays — worth watching, not worth another prompt round.

**Out of scope, left alone on purpose:** nothing is exposed to the frontend — no scene banner, no
"scene complete" beat in the UI; the ending is meant to be felt through dialogue. Completed scenes
are not retained anywhere (5.2's job), so the generator has no memory beyond "don't repeat the last
setting/goal".

---

### [x] 5.2 — Persistent character state 🟡 Sonnet

**Fix:** Give the character mood, energy, and an ongoing situation that persists across sessions,
stored next to `level_history` in the profile. Continuity — "last time you mentioned X" — is what
makes a chat partner feel alive. Right now `recent_turns` is a rolling 10 and everything else
evaporates.

For Jorge specifically: track the *consequences* of his last scheme. A prankster with memory is
funnier than one without.

**Files:** `backend/profile_store.py`, `backend/prompts/messenger_prompt.py` (dynamic tail).

**Depends on:** 5.1.

**Shipped as:** `profile["character_state"]` — `{situation, mood, energy, updated_at}`, `None` until a
scene has completed at least once (mirrors `scene: None`'s lazy-init pattern, so pre-5.2 profiles stay
valid). Deliberately **no new LLM call** — a scene ends on a turn budget, not a model verdict, so there
is no real "how it went" to ask about; the state is folded in deterministically from the scene that
just finished.

`profile_store.update_character_state(profile, completed_scene)` builds `situation` from the scene's
own `character_goal` + `completion_condition` ("...never actually found out how it went" — honest
about the ambiguity rather than inventing an outcome), and `mood`/`energy` from two new fields on each
`character_goals` entry in `scene_dimensions.json`: `mood_after`/`energy_after`, written to read right
either way a scheme could have gone (e.g. "smug if you got it, sulking if you did not"). `pick_scene_dimensions`
carries them into the draw and `new_scene` copies them onto the scene object — kept **outside**
`SCENE_DIMENSION_KEYS` so `generate_scene`'s LLM concretization (which knows nothing about mood) can
never overwrite them. The wiring point is `advance_scene` itself: the moment it flips a scene to
`"complete"` it calls `update_character_state` right there, so **`routers/messenger.py` needed zero
changes** — the router already calls `advance_scene` at the right time for both endpoints.

Prompt side: new `build_character_state_context()` in `messenger_prompt.py`, same shape as 5.1's
`build_scene_context` (reads `prompts/templates/character_state.txt`, falls back to an inline block if
the file is missing), returns `""` when `character_state` is `None` so a fresh profile renders exactly
the pre-5.2 tail. Rendered in the **dynamic tail only**, positioned before the scene block ("here's how
the character feels walking in" then "here's what's happening now") — verified not to leak into the
static prefix the same way 5.1's scene tests do.

**State is overwritten, not accumulated** — only the most recent scheme is kept, matching
`level_history`'s "current level" model rather than a growing log. Simpler than a capped list, and
avoids the prompt slowly filling up with old schemes the way `weak_points` did before 1.4.

**Tests: 119 passed, 1 xfailed** (was 109/1) — `pick_scene_dimensions`/`new_scene` carry mood/energy
correctly and concretization can't touch them, `update_character_state` builds/overwrites state
correctly, `advance_scene` fires it exactly on completion (not before), and 5 new
`test_prompt_snapshot.py` cases mirror 5.1's scene coverage (dynamic-tail-only, prefix survives a
character-state change, no-state produces the pre-5.2 tail, renders alongside an active scene in the
right order). One existing scene test needed a one-line fix:
`test_generate_scene_passes_the_draw_through_to_the_prompt` was asserting every value in the *draw*
appears in the generation prompt, which broke once the draw grew `mood_after`/`energy_after` — updated
to check only `SCENE_DIMENSION_KEYS`, which is what the prompt actually contains. **Goldens did not
move**, same as 5.1 — none of the existing golden fixtures have a `character_state`, so the block
renders empty for all of them.

**Verified live** via the mock-mode buffered endpoint: forced a scene one turn from its budget, ran a
turn, confirmed `character_state` landed correctly in the saved profile with the right situation/mood/
energy, then confirmed the *next* `build_layered_prompt()` call rendered the "CHARACTER CONTINUITY"
block with that exact content. **Caveat — this accidentally hit the real API**, not mock mode (the
verification script didn't check `MOCK_MODE` first): cost **~1.17 cents** and ~2062 Azure characters,
against the existing ~$10/500k budgets. Small, but a mistake — should have gone through mock mode or
checked `/api/usage` first, per the ground rules.

---

### [x] 5.3 — Port the secret/information-asymmetry mechanic into messenger 🔴 Opus

**Fix:** The strongest conversation engine is the character knowing something the user has to extract.
You already built it — `GuessingGame.tsx` + `call_llm_to_pick_secret` in `llm_call.py`. This is a
merge into the scene system, not new invention.

**Files:** `backend/llm_call.py`, `backend/prompts/messenger_prompt.py`,
`frontend/src/GuessingGame.tsx` (read for the mechanic, don't modify).

**Depends on:** 5.1 — the secret is a scene type.

**Shipped as:** a scene *type*, exactly as the task framed it — no new mode, no new endpoint, no
frontend. `scene_dimensions.json` gains `secret_goals` (8 entries, each with a `secret_kind` telling
the generator what class of thing to invent), drawn instead of `character_goals` at
`settings.SECRET_SCENE_CHANCE` (0.34) and **never twice in a row** — back to back they stop being a
change of gear and turn into a quiz. `generate_scene` returns two extra fields for them: the concrete
`secret` and 4–6 **target-language** `secret_aliases`.

**The mechanic's core is free.** `profile_store.check_secret_guess` matches the learner's input
against the aliases locally — normalized, accent/punctuation-tolerant, whole-word-sequence only (bare
substring would fire "la fiesta" inside "manifiesta", and a scene ended by a false positive is worse
than one that runs a turn long). No LLM check, per the app's own fuzzy-match-first rule. The router
calls it in `_check_secret` **before** the prompt is built, so the same turn that receives the guess
answers it, and `advance_scene` closes the scene at the end of that turn — the learner *earns* the
ending, which is the only early exit 5.1's turn budget has ever allowed.

Prompt side: `build_secret_context` (new `prompts/templates/secret.txt`) plus a secret variant of the
pacing block, `_secret_pacing`, with four phases — make it obvious you're holding out → leak exactly
one new detail per turn → all but name it → **final turn, say it yourself** (an unsolved secret still
gets told, or the learner can't tell the scene finished). A fifth branch fires on the solved turn.
Both dynamic-tail only; a test asserts the secret appears nowhere in the cached prefix.

**Three things a secret scene deliberately withholds from the LLM:**
- Its **completion condition** stays the drawn one. Seen live: nano invented an *object* as the secret
  while rewriting the ending to "the learner names the person who told you" — two different targets.
  The drawn condition already agrees with `secret_kind` by construction.
- Its **user_goal** is overwritten with `work out {secret_kind}`. The shared `user_goals` pool is drawn
  independently, and a stray "make a plan with you for later" pulls against the only thing the scene
  is about.
- Its **mood/energy**, as in 5.2 — but this is the one scene type whose outcome we actually know, so it
  carries `mood_after_solved` / `mood_after_unsolved` and `update_character_state` states what happened
  ("They worked it out — it was X, and they said it to your face") instead of 5.2's honest hedge.

**Without a generated secret the scene demotes to a standard one.** Unlike every other part of a
scene there is no language-neutral fallback — aliases have to be in the learner's target language, so
only the LLM can produce them. Mock mode therefore carries a canned secret (the one place mock is not
simply the fallback path), which is what makes the whole mechanic testable with no keys and no spend.

**Verified live** on gpt-4.1-nano — two calls, **0.030 cents**. The first exposed two real defects,
both fatal to the mechanic and both invisible to stub tests:
1. **Aliases came back in English** (`["the bike lock", "the lock key"]`) while the learner types
   Spanish — `check_secret_guess` could never have fired. Fixed by calling out that this is the one
   non-English field in the JSON, saying why (matched literally against learner input), and showing
   the shape.
2. **The secret didn't match its own `secret_kind`** — kind "who told you" (a person), secret "the bike
   lock key" (an object). Fixed by making the field spec read the kind literally ("if it asks WHO, the
   secret is a person"), plus the pinned completion condition above.

Re-verified clean: secret "the nightclub" for kind "where you actually were last night", aliases
`["el club nocturno", "el nightclub", "la discoteca", "la sala de baile"]`, all four matching a
realistic learner sentence, unrelated input not matching. The second call also showed a milder slip —
`character_goal` ending "…and you won't tell **me** where" — so **5.1's perspective guard now also
blanks any I/me/my** in the two second-person fields (nobody speaks in the first person there, so it
is always a slip), falling back to the drawn dimension as before.

**Tests: 139 passed, 1 xfailed** (was 119/1). 20 new across `test_scene.py` (draw shape, no-two-in-a-row,
demotion, guess detection incl. the accent and false-positive cases, early close, budget close,
outcome-aware character state, the generate_scene secret contract, mock playability, and an end-to-end
solve through the endpoint) and `test_prompt_snapshot.py` (secret in the tail and nowhere in the
prefix, all five pacing phases, standard and demoted scenes rendering no secret block). Existing scene
tests needed deterministic draws — `standard_draw()` / `secret_draw()` helpers pin the pool instead of
leaving 5.1's tests flaky at `SECRET_SCENE_CHANCE`. **Goldens did not move.**

**Out of scope, left alone on purpose:** `GuessingGame.tsx` and `/api/guessing/*` are untouched, as
the task specified — the standalone mode still runs its own LLM-per-turn loop. Nothing is exposed to
the frontend: no "you solved it" banner, no guess counter, no give-up button. The character reacting
to being caught *is* the feedback, and adding UI would make it a quiz again.

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

### [x] 7.4 — Add voice to the audio cache key 🟡 Sonnet  *(done as a prerequisite of 8.11)*

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

---

# Phase 8 — LingoPause (video-vocab primer)

Pre-learn a YouTube video's vocabulary before watching it, then pause for mini-lessons during
playback. Nine-step design; the numbered tasks below follow it. **Read the LingoPause bullet in
`CLAUDE.md` (Architecture) before starting any of these** — it carries the two rules that are easy
to get wrong (no parallel LLM calling layer; batch the lesson call).

Design decisions already made, so they are not re-litigated per task:
- Playback is the **YouTube IFrame Player API**, never a downloaded copy. The only path that touches
  the media itself is the caption-miss transcription fallback (8.2).
- Lesson content is **not** projected into the spaced-repetition deck yet (8.6). The two stores answer
  different questions: `vocab_lessons/` holds what a term means, `quiz_items/` holds when it is due.
- The two LLM steps (8.3, 8.4) are **run by hand in a browser chat**, not called from the app. They
  are one-off and per-video, and the prompts are hand-authored — so there is no API spend in this
  mode at all. Do not add an `llm_call.py` function for them without checking first.
- Word/example audio needs **no new endpoint** — `useAudioPlayer` → `POST /api/trivia/audio` already
  does cached Azure TTS. Only a *composed* lesson clip (8.8) needs anything new.

### [x] 8.1 — Ingest: URL, notes, metadata, chapters, captions 🔴 Opus

Steps 1–2 and 4 of the pipeline. `video_source.py` (the only module that knows about YouTube),
`video_store.py` (per-video session files), `routers/lingopause.py` (`/ingest`, `/sessions`,
`/session/{id}`, `/confirm`, DELETE), `vocab_store.py` (lesson bank CRUD), `transcribe.py` and
`lesson_audio.py` (stubs), plus the frontend shell at `frontend/src/lingopause/LingoPauseMode.tsx`
and the mode key in the three hand-synced places.

`yt-dlp` added to `requirements.txt`, unpinned on purpose. Chapter markers come back from the same
metadata call, so 8.5's "use YouTube's own chapters" path is already banked at ingest.

**Tests:** `tests/test_lingopause.py` (89 cases through 8.11), all mock-mode (no network).

### [ ] 8.2 — Choose and wire the transcription fallback 🔴 Opus

**Currently a stub.** `transcribe.py` raises with a clear message and `is_available()` is False
outside mock mode, so a video with no captions reports 422 rather than failing obscurely.

**The decision** (see the module docstring for the full tradeoffs):
- OpenAI `whisper-1` — the only OpenAI transcription model that returns timestamps
  (`gpt-4o-*-transcribe` do not support `timestamp_granularities`). ~$0.006/min. Needs a
  duration-derived cost recorded into `usage_tracker`, which today counts tokens and Azure chars,
  neither of which describes an audio minute. 25MB upload cap → long videos need chunking.
- Local faster-whisper / whisper.cpp — $0 per video, heavy Windows install.
- Azure batch transcription — reuses the Speech key, but is a different API surface than
  `tts_helpers` (async job + blob upload), so it is new integration work, not reuse.

**Whichever wins:** implement `transcribe_segments` and nothing else changes — the router already
handles `TranscriptionUnavailable`, and every consumer reads the same `{start, end, text}` shape.
Gate the audio download to the caption-miss path and delete the file once segments are in hand.

**Files:** `backend/transcribe.py`, `backend/settings.py`, `backend/usage_tracker.py`,
`backend/requirements.txt`.

### [x] 8.3 — Copy-out / paste-back plumbing for extraction 🔴 Opus

Step 3, **run by hand.** The learner copies one assembled block into browser ChatGPT/Claude and
pastes the JSON back — the app makes no LLM call, so this mode costs nothing to run.

`vocab_prompts.build_extraction_block` glues the prompt template to the video's own material
(title/channel/length, YouTube description, the learner's notes, timestamped transcript).
`GET /api/lingopause/export/{id}` serves it with a token estimate;
`GET /api/lingopause/transcript/{id}.txt` serves the bare subtitles.
`POST /api/lingopause/import/candidates` reads the paste back — `parse_pasted_json` tolerates fences,
preambles and trailing chatter, and `normalize_candidates` accepts a bare array, several wrapper
keys, and bare strings, filling in any missing `id`. Re-importing clears `confirmed`, since those ids
addressed the old list.

Template written: `backend/prompts/templates/vocab_extraction.txt`, filled by `{language}`,
`{user_notes}`, `{description}`, `{transcript}`. **Substitution, never `str.format`** — the output
spec contains literal JSON braces. `normalize_candidates` maps the prompt's `timestamp_seconds` /
`short_gloss` onto the `first_ts` / `gloss_ui` the checklist renders, and tolerates a stamp
("01:35") where the prompt asked for seconds.

### [x] 8.4 — Copy-out / paste-back plumbing for lessons 🔴 Opus

Step 5, same mechanism. `GET /api/lingopause/export/{id}?kind=lessons` builds a block from the
**confirmed** terms and the line each was used in — deliberately **not** the transcript again, which
would burn most of the paste budget on context the lesson does not need. 409s before anything is
confirmed. `POST /api/lingopause/import/lessons` writes through `vocab_store.upsert_lessons` into
`vocab_lessons/<lang>.json`, tagged with the source video.

A term already in the bank keeps its existing content and only gains the new source — the same word
in a second video is evidence it matters, not a reason to overwrite an explanation already read.

Template written: `backend/prompts/templates/vocab_lesson.txt`, filled by `{language}`,
`{description}`, `{user_notes}`, `{confirmed_vocab_list}`.

**The gap this closes:** the prompt asks for "the exact sentence from the transcript" but is not sent
the transcript. So `quote_for_timestamp` looks that line up locally at candidate-import time and it
travels with the term in the vocab list — cheaper than re-pasting the transcript, and more accurate
than asking the model to recall a sentence it can no longer see.

`normalize_lessons` keeps the prompt's fields (`definition`, `colloquial_notes`,
`example_sentences`, `video_usage`) verbatim and copies `definition`→`description` so the bank's
top-level shape stays `word_practice_sentences.json`-compatible. A Word Drill adapter would build
`usecases` from `example_sentences`.

### [x] 8.9 — Three-tab flow, thumbnails, lesson view, `kind` 🔴 Opus

Restructure from one long scrolling page into three tabs, one per hand-off: **Video** (paste a link →
auto-ingest, thumbnail, context notes) → **Vocabulary** (paste JSON → grouped checklist) →
**Lessons** (paste JSON → rendered lesson cards with audio). Each tab ends in a button that copies
the next prompt and advances; tabs stay clickable backwards, plus a Start over.

Also landed: `POST /api/lingopause/notes` (notes stay editable after ingest — both prompts read
them, and the learner usually only works out what they want from a video after seeing what is in it),
`GET /api/lingopause/lessons/{id}` (tab 3 renders from here — without it the pipeline ended in a JSON
file nothing displayed), thumbnails via the deterministic `i.ytimg.com/vi/{id}/hqdefault.jpg`, and
`kind` on candidates.

**`kind` is the important part.** `word` / `phrase` / `construction`, grouped in the checklist and
labelled in the lesson prompt. See 8.10 for the half of this that is still open.

### [ ] 8.10 — Make constructions actually practisable 🔴 Opus

**The gap the user named:** "even tho i know the words vamos and estar, i would of like to have
*vamos a estar subiendo cada semana el video porque yo mando*. its not rly a vocab, but if i were to
hear that i most likely would not have been able to understand it."

Two halves, and 8.9 only did the first:

1. **Extraction has to look for them.** The current prompt filters on words the learner "would likely
   NOT already know" — which by construction excludes chunks built entirely from known words. The
   data model now carries `kind`, but nothing asks the model to populate it. **The prompt is
   user-authored: propose the amendment, do not rewrite it unilaterally.**
2. **There has to be somewhere to practise them.** Reading a lesson card is study, not practice. The
   obvious host is Word Drill — it already does sentence-level production with hints, and the vocab
   bank is deliberately shaped like `word_practice_sentences.json`. The adapter would build
   `usecases` from `example_sentences`, and `target` maps onto that bank's hardcoded `spanish` key.
   Decide with the user whether this is a Word Drill adapter or a new drill inside LingoPause.

**Depends on:** 8.9.

### [x] 8.11 — Lesson viewer (phase 4) 🔴 Opus

Tab 4: guided playback of each confirmed phrase before watching the video.

**Data model reconciliation** (audited against the 134 real bank entries first; nothing had been
hand-edited): added `written_explanation`, `spoken_explanation` (array of segments), `target_ssml`
and `target_sentence_ssml`. Three inconsistencies found and fixed:
- `kind` was on only 49/134 entries because it lived on the candidate and was never carried across —
  lessons only had one when the model happened to echo it. Now stamped authoritatively from the
  confirmed candidate at import (`_stamp_from_candidates`), along with `first_ts` and `quote`.
- `description` duplicated `definition` byte for byte on all 134; `usecases` was `[]` on all 134.
  Both were Word-Drill shims. No longer written; existing ones are harmless.
- SSML is filled **mechanically** at import, not asked of the model — it is a pure function of text
  plus locale, so asking costs output tokens and invites malformed XML in a field that goes straight
  into a TTS request. It also means all 134 pre-phase-4 entries gained working SSML with no rewrite.

**Prerequisite landed with it — task 7.4 (voice in the audio cache key).** Not optional: the moment
`en-US-AndrewMultilingualNeural` and the locale default synthesize the same sentence they collide.
The default voice hashes identically to the pre-voice key, so no cached file was orphaned.

**Playback:** `lesson_audio.build_beats` flattens a lesson into ordered beats. Voices come per beat
from `VOICE_MAP` (English framing in the en-US voice; target phrase AND explanations in the target
voice — explanations quote target words inside English prose, and those are the part that must sound
right). A single multilingual voice was tried first and rejected as not good enough on either
language. First listen blurs the text (layout fixed,
nothing to read along with) and fades it legible when that beat's audio ends; replay highlights words
in sync using Speech-SDK WordBoundary timings, cached in a `.words.json` sidecar. Highlighting runs
on rAF against `audio.currentTime` — `useAudioPlayer`'s `onProgress` rides on `timeupdate` (~4 Hz)
and lags visibly per word. `useYouTubePlayer` gives seek+play; audio and video are mutually exclusive
and that coordination lives in `LessonViewer`, not in either hook.

**Also:** `/api/lingopause/ask` is the one LLM call this mode makes (`answer_lesson_question`) — a
question asked mid-lesson cannot be a copy-paste round trip. Progress marking via
`/api/lingopause/progress`.

**Pre-phase-4 lessons still play**: a missing `spoken_explanation` is sentence-split out of the
written one, marked `derived` and surfaced in the UI so a lower-quality reading is not mistaken for
the real thing. Regenerate a video's lessons to upgrade it.

**Fixed in passing:** plain text went into SSML unescaped, so an `&` in any sentence produced invalid
XML and a silent fall-through to silence — app-wide, not just LingoPause.

### [x] 8.13 — Controller + split play controls in the lesson viewer 🟡 Sonnet

`Play all` became two: **From top** (⏮, restarts the slide) and **Play** (▶, resumes from the last
clip you heard — hovering a line moves that cursor, so "where you left off" means what you expect).

Controller, standard-mapping indices, mirroring messenger where they overlap so muscle memory
carries:

| Input | Index | Action |
|---|---|---|
| A | 0 | Play from here |
| X | 2 | Play from the top of the slide |
| LB / RB | 4 / 5 | Previous / next **slide** |
| LT / RT | 6 / 7 | Previous / next **phrase** |
| D-pad ↑ / ↓ | 12 / 13 | Previous / next **clip** in the slide |
| D-pad ← | 14 | Repeat the current clip |
| D-pad → | 15 | Show / hide the Spanish |
| Stick flick | axes | Cancel — stop everything |
| L3 / R3 | 10 / 11 | **Unbound here**; see below |

Shoulder layout is "nearer button, smaller move": bumpers step within a phrase, triggers step
between phrases.

**L3/R3 are deliberately not bound in-page.** The stick click is turned into an **F13** keypress by
`tools/controller/f13_mapper.py` and consumed by Wispr — the browser cannot synthesize an OS
keystroke, which is the whole reason that mapper exists (task 4.1). It becomes meaningful in 8.14.

### [ ] 8.14 — Repeat-back drill: say it back, checked leniently 🔴 Opus

Toggle per phrase: after hearing the Spanish, say it back and have it checked.

**Scoring is word COVERAGE, accumulated across attempts — not string similarity.** Wispr emits
cleaned-up fluent text, so exact matching largely measures Wispr rather than the learner (the same
trap task 6.1 documents for pronunciation). So: normalize both sides with `normalizeForMatch`
(accent- and punctuation-insensitive — the app-wide rule), reduce the target to its word list, and
mark each word covered as it is said. A second attempt adds to the first, so leaving out a word and
then saying it passes. **Do not strip function words**: `se`, `ya`, `lo` are exactly what the
constructions turn on.

Open questions to settle first (do not guess):
- Does a pass auto-advance, or go green and wait? The learner has pushed back on auto-advance
  repeatedly, so green-and-wait is the likely answer — but it is the opposite of a normal drill.
- Word order: ignored entirely, or must the covered words appear in order? Ignoring it is more
  lenient and simpler; requiring order catches "said the right words in the wrong shape".
- Repeats: does saying a word twice cover two occurrences of it, or one?

**Reuse, do not rebuild:** `useWisprAutoSend` (paste-detection + the ~1.5s send window),
`GameTextarea` (auto-focus, Enter/Escape), `normalizeForMatch` + `checkFuzzyMatch`
(`sharedGameUtils.ts`), and the messenger's repeat-after-me drill (tasks 3.4/3.5) as the working
precedent for the whole interaction.

**Controller:** L3/R3 already produce F13 via the existing mapper; the page listens for the F13
keydown the way `MessengerChat.tsx` does. Stick flick cancels a pending send, matching messenger.
No mapper changes needed.

**Files:** `frontend/src/lingopause/LessonViewer.tsx`, a new `RepeatBack.tsx`,
`frontend/src/sharedGameUtils.ts` (a `coveredWords` helper if it is worth sharing).

**Depends on:** 8.13.

### [ ] 8.15 — Score the repeat-back attempt properly 🟡 Sonnet

Only once 8.14's interaction works. Surface which words are still missing (dim the covered ones in
the target as they land), keep a per-phrase attempt count, and decide whether a passed phrase counts
as `viewed` or needs its own `practised` flag in the session.

**Depends on:** 8.14.

### [ ] 8.12 — Spoken answers for follow-up questions 🟡 Sonnet

v1 of `/api/lingopause/ask` returns text. Speaking the answer needs the same multilingual-voice
treatment as a lesson beat — likely reusing `/api/lingopause/audio` with the answer as one beat.

**Depends on:** 8.11.

### [ ] 8.5 — Chapter segmentation fallback 🟡 Sonnet

Step 6. YouTube's own markers are already stored at ingest with `source: "youtube"`. This task adds
the fallback for videos without them: fixed-interval splits, or LLM-proposed topic breaks over the
transcript. Keep writing `source` so the three origins stay distinguishable downstream.

**Files:** `backend/video_source.py` or a new `chapters.py`, `backend/routers/lingopause.py`.

**Depends on:** 8.1.

### [ ] 8.6 — Feed video vocab into the spaced-repetition deck 🟡 Sonnet

Deliberately deferred from 8.4. Project confirmed terms into `quiz_items/default_quiz.json` via
`quiz_store.add_quiz_item`, tagged `source: {"kind": "video", "video_id": ...}`.

**Two things to know before starting:**
- `add_quiz_item` dedupes on `corrected` (case-insensitive), so a word already learned in
  conversation will not be duplicated by a video. That is the integration working, not a bug.
- Scheduling is **turn-count based** (`show_after_turn` vs the messenger profile's `turn_count`), so
  20 words added at once all come due on the same turn. Stagger them (`+ i*2`), or add a time-based
  due date — but that second option changes `get_pending_quiz`, which today only understands turns.

**Files:** `backend/vocab_store.py`, `backend/quiz_store.py`, `backend/routers/lingopause.py`.

**Depends on:** 8.4.

### [ ] 8.7 — Video playback with chapter interruptions 🔴 Opus

Step 7. YouTube IFrame Player API in the frontend — `play`/`pause`/`seek`/`getCurrentTime` — so
playback can be interrupted at chapter boundaries for a mini-lesson. No downloaded copy.

**Files:** `frontend/src/lingopause/`, `frontend/index.html` (IFrame API script).

**Depends on:** 8.5.

### [ ] 8.8 — Audio lesson delivery 🔴 Opus

Step 8, currently a stub at `backend/lesson_audio.py`. **The mechanism is undesigned** — one narrated
clip per term, an interleaved target/UI pair, or messenger-style per-sentence chunking with its own
pauses. That choice determines the text being synthesized, so there is nothing to build until it is
made.

Needs no new TTS dependency: `tts_helpers.tts_bytes_for_chunk` + `audio_utils.get_cached_audio_path`
are exactly right for it, and fixed lesson text replayed many times is the best case the content-hash
cache has. **Caveat:** the cache key excludes voice (task 7.4), so lesson audio generated under one
`VOICE_MAP` default and replayed after it changes will silently mix speakers.

**Depends on:** 8.4.

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
