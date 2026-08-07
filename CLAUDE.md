# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Planned work lives in `TASKS.md`** (repo root) — an ordered, numbered backlog with per-task file
lists, dependencies, and a recommended model. If the user refers to a task by number ("do task 1.1",
"start 3.4"), read `TASKS.md` first and follow its "How to use this file" section. Do not invent a
task number that isn't in there.

## What this app is

SpeakRight is a personal Spanish/Indonesian speaking-and-listening practice app: the user speaks or types via Wispr (desktop dictation) or typing, an LLM reviews/corrects the sentence and replies, and Azure TTS speaks the target-language text back. Nine playable modes share one FastAPI backend and a common React frontend component layer.

## Running it

**Frontend** (`frontend/`):
```bash
npm install
npm run dev      # http://localhost:5173
npm run build
npm run lint
```

**Backend** (`backend/`) — **one backend, entry point `main.py`** (assembles routers from `routers/`; `game_backend.py` is now a thin compat shim so `uvicorn game_backend:app` still works). `fastapi_wispr_pipeline.py` also exists but is legacy/unreachable — see Mode Inventory.
```bash
pip install -r requirements.txt
python main.py             # port 8000 (or: uvicorn main:app --reload --port 8000)
python -m pytest tests/    # mock-mode smoke suite over every route + prompt goldens
```

`backend/.env` (git-ignored, real keys already present locally — never print or commit its contents):
```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini         # settings.py defaults to gpt-4.1-mini if unset; local .env currently runs gpt-4o-mini
AZURE_SPEECH_KEY=...
AZURE_REGION=...
AZURE_VOICE_ES=...
AZURE_VOICE_EN=...
AZURE_VOICE_ID=...
MOCK_MODE=0                       # 1 = no API keys needed, silent audio, mock LLM replies
ENABLE_QUIZZING=0                 # 1 = messenger requests quiz candidates each turn (see Data Files)
```
CORS is wide open (`allow_origins=["*"]` in `game_backend.py`) — there is no origin allowlist to edit when deploying elsewhere.

## Mode inventory

All modes render from `App.tsx`'s router, selected via `HomeScreen.tsx`. Status reflects what's actually wired into the UI, not what's most-developed.

| Mode key | Component | Status | Backend endpoints | LLM function(s) | Audio pattern |
|---|---|---|---|---|---|
| `messenger` | `MessengerChat.tsx` | **Active / main** | `/api/messenger/turn`, `/api/messenger/turn/stream`, `/api/messenger/profile*`, `/api/messenger/premade-start`, `/api/quiz/check`, `/api/quiz/pending`, `/api/quiz/stats` | `call_llm_for_messenger`, `stream_llm_for_messenger` | Content-hash cache (`audio_files/cache/`); streaming path starts TTS per chunk as it arrives |
| `trivia` | `TriviaGame.tsx` | **Active / main** | `/api/trivia/check`, `/api/trivia/audio` | `check_trivia_answer` (with local fuzzy-match fast path) | Content-hash cache (`audio_files/cache/`) |
| `worddrill` | `WordDrillGame.tsx` | **Active / main** | `/api/worddrill/*` (words, sentence, sentences/{word}, usecases/{word}, check, chat, freeform) | `check_trivia_answer`, `call_llm_for_grammar_chat`, `call_llm_for_freeform_correction` | Content-hash cache + pre-generated (`scripts/generate_worddrill_audio.py`) |
| `battle` | `BattleGame.tsx` | Experimental | `/api/battle/check` | `check_trivia_answer` | Pre-generated (`scripts/generate_battle_audio.py`) |
| `trivia2` (Word Showdown) | `trivia2/TriviaGame2.tsx` | Experimental | `/api/worddrill/*`, `/api/battle/check`, `/api/trivia/audio` | `check_trivia_answer` | Same as worddrill/battle (no dedicated backend route) |
| `story` | `StoryCardsGame.tsx` | Experimental | `/api/game/start`, `/api/game/turn`, `/api/audio_file/{session}/{filename}` | `call_llm_for_turn` | Live TTS per turn, saved to `audio_files/session_*` (no cache) |
| `guessing` | `GuessingGame.tsx` | Experimental | `/api/guessing/turn`, `/api/guessing/giveup` | `call_llm_to_pick_secret`, `call_llm_for_guessing_turn` | None currently |
| `pronounblitz` | `PronounBlitz.tsx` | Experimental | None (no backend calls found) | — | — |
| `numbers` | `NumberRush.tsx` | **Broken — no audio.** Expects static files at `frontend/public/number_audio/{lang}/{voice}/number_{n}.mp3`; that directory does not exist and no generation script exists. As shipped it silently falls back to a visual digit-matching game. | — | — | Static files (missing) |

**Legacy — do not extend:** `ChatWithWispr.tsx` and `backend/fastapi_wispr_pipeline.py`. `ChatWithWispr` is not imported by `App.tsx` and is unreachable from the UI; the pipeline backend's only client was `ChatWithWispr`. If you're asked to "switch to chat mode" or similar, confirm with the user first — that mode isn't wired up.

Shared backend endpoints used by multiple modes: `/api/config` (mock-mode flag for `HomeScreen`), `/api/usage`, `/api/usage/session/start`, `/api/greetings/random`, `/api/audio_file/greetings/{lang}/{filename}`, `/api/audio_file/{session}/{filename}`.

## Architecture

**Backend layout (split into modules as of plan 4; entry point `main.py`):**

| Module | Owns |
|---|---|
| `main.py` | App assembly: FastAPI instance, CORS, startup event, `include_router` for all 8 routers. `game_backend.py` is a compat shim (`from main import app`) |
| `settings.py` | **The single owner of config + import-time side effects**: dotenv load, state-dir creation, `MOCK_MODE`/`ENABLE_QUIZZING`/`DEBUG` flags, API keys, all paths, `PERSONA`, quiz constants, `LOCALE_MAP`/`locale_for()`, `VOICE_MAP`, `MODEL_PRICING` |
| `routers/story.py`, `audio.py`, `misc.py`, `checks.py` (trivia+battle), `messenger.py`, `quiz.py`, `worddrill.py`, `guessing.py` | One router per feature area; bare `APIRouter()` with full literal paths (no `prefix=`), per-router request models. See Mode Inventory for the endpoint map |
| `models.py` | Cross-router pydantic models only (`LangSpec`, messenger response models, quiz models) |
| `audio_utils.py` | `generate_silent_wav`, `save_wav`, `get_cached_audio_path` (the content-hash cache) |
| `profile_store.py` / `quiz_store.py` / `chat_log.py` | Messenger profile CRUD + assessment update / spaced-repetition quiz storage + local answer check / correction-transcript writer |
| `prompt_fragments.py` | **Cross-feature prompt rules — edit here, never inline** (see `backend/PROMPTS.md`) |
| `prompts/messenger_prompt.py` | `build_layered_prompt()` — lives next to its template/persona data files |

- **Messenger turn has two endpoints sharing one code path.** `/api/messenger/turn` returns a buffered `MessengerTurnResponse`; `/api/messenger/turn/stream` returns NDJSON (`{"type":"chunk"|"audio"|"final"|"fallback"|"error"}`, one object per line) so reply bubbles render while the model is still writing corrections and suggestions. Both share `_prepare_chunk` / `_run_tts` / `_finalize_turn` in `routers/messenger.py` — **put new turn logic in those helpers, not in one endpoint.** The frontend prefers the stream and falls back to the buffered endpoint automatically (premade conversations always use buffered; the stream emits `fallback` for them). Incremental parsing is `StreamingArrayScanner` in `llm_call.py`, which depends on **`response_chunks` being the first field in the output schema** — reordering the schema silently disables streaming's benefit.
- **The messenger character speaks ONLY the target language** (task 3.8). Every `response_chunk` is `language:"target"`, `modality:"audio"` — there are no UI-language chunks in any prompt version. UI-language renderings are fetched on demand from **`POST /api/messenger/translate`** (`routers/translate.py`, cached in `translation_store.py`, runs `settings.TRANSLATE_MODEL` = the cheapest model), and only for the chunks the active `pairingMode` needs: `targetOnly` 0, `alternating` 1, `pairs` 2 — `response_chunks[0]` never gets one. That endpoint never raises; on failure it returns `ok:false` with nulls and the client plays target-only. **Don't move translation back into the messenger turn** — keeping it out is what stops mode changes from multiplying prompt-cache prefixes and lets a mode switch apply retroactively.
- **`response_chunks[0]` is a verbatim target-language reaction opener** from the persona's `reactions.<target_code>` closed set, served from pre-generated static audio (`scripts/generate_reaction_audio.py` → `audio_files/reactions/<persona>/`). `_reaction_audio_lookup` only returns entries whose `.wav` exists, so an ungenerated bank degrades to live TTS rather than silence. Adding a persona or a target language means adding its reaction bank **and running the script**.
- Messenger prompt assembly: `build_layered_prompt()` returns `(static_prefix, dynamic_tail)`, joined with one blank line into **one** `responses.create` call via `call_llm_for_messenger` (or `stream_llm_for_messenger` for the streaming path). **Cache invariant: the static prefix (system file + persona + full output schema + reminders + suggestion rules + v2 block) must stay byte-identical across turns** so OpenAI automatic prompt caching discounts it (verified: ~2.3k of ~2.5k input tokens served from cache per turn). All per-turn content — student model, last-3-turn context, turn instruction, user input — goes in the dynamic tail. `tests/test_prompt_snapshot.py` enforces this; never insert dynamic content before the student-model section. `prompt_version` is `"v1"` (standard), `"v2"` (adds a hover-reveal "challenge" sentence — the default in `MessengerChat.tsx`), or `"eyesfree"` (screen-off profile: exactly 2 chunks, no suggested replies, listenable one-sentence `error_explanation`). The full list is `PROMPT_VERSIONS` in `prompts/messenger_prompt.py`; each version has its own static prefix (and its own cache entry), and `normalize_prompt_version()` maps unknown values onto `v1`. The 🙈 Eyes-free toggle in `MessengerChat.tsx` selects `eyesfree` and overrides the v1/v2 checkbox while it's on.
- **Eyes-free repeat-after-me drill** (`MessengerChat.tsx`): when eyes-free is on and a turn comes back with `had_errors` + `error_severity === "major"`, the correction is spoken as *"Try saying: X"* (target sentence at `SLOW_TTS_RATE`) instead of drawn as a diff, and the character's reply is held in `pendingReplyChunksRef` until the attempt lands — audio is serial with the screen off, so the reply would otherwise talk over the correction. `error_severity` (`"none" | "minor" | "major"`) is emitted by the LLM and reconciled against `had_errors` by `_normalize_severity` in `routers/messenger.py`; only `"major"` interrupts, `"minor"` is left for the deferred quiz. Hotkeys: `Alt+R` hear it again, `Alt+E` speak the explanation (never automatic — it doubles the interruption).
- **Scene layer (task 5.1).** Messenger conversations run as scenes that end: setting × character goal × user goal × complication + an explicit completion condition, lasting `SCENE_MIN_TURNS`–`SCENE_MAX_TURNS` (5–10, drawn per scene). State lives in the profile under `scene` (`profile_store.py`: `pick_scene_dimensions` / `new_scene` / `advance_scene`); the premise is drawn from `prompts/helpers/scene_dimensions.json` and concretized by one cheap call (`llm_call.generate_scene`, on `settings.SCENE_MODEL`) — **never hand-author a catalog of finished scenes**, the combinatorics are what stop it repeating. A failed or skipped generation falls back to the raw draw, which is already playable, and `generate_scene` blanks any `character_goal`/`complication` that names the character (the tell for a perspective inversion, seen live on nano) so that one field falls back on its own — **if you edit that prompt, keep its PERSPECTIVE section**. `routers/messenger.py` drives the lifecycle: `_ensure_scene` at turn start (cold start only) and again in `_finalize_turn` the moment a budget runs out, so the ~1s setup call never sits in front of the first audio chunk. **The scene and its pacing line go in the dynamic tail** (`build_scene_context` / `scene_progress_instruction` in `messenger_prompt.py`, template `prompts/templates/scene.txt`) — the static prefix must never learn about a specific scene, or every scene change mints a new cache prefix. Scene end is decided by the turn budget, not by a model flag, precisely so the output schema stays static.
- **Secret scenes (task 5.3)** — the information-asymmetry mechanic from `GuessingGame.tsx`, merged into the scene layer as a scene *type* rather than a separate mode. `SECRET_SCENE_CHANCE` (~1 in 3, never twice in a row) draws from `secret_goals` in `scene_dimensions.json`; `generate_scene` additionally invents the concrete `secret` and 4–6 **target-language** `secret_aliases`. Naming the secret is detected locally by `profile_store.check_secret_guess` (normalized, accent-tolerant, whole-word-sequence only) — **no LLM check, ever**; it runs in `_check_secret` before the prompt is built, so the same turn answers it, and `advance_scene` then closes the scene early. That early exit is the only way a scene ends other than the turn budget. Two things a secret scene deliberately does *not* let the LLM touch: its drawn `completion_condition` (a rewritten one drifts into naming a different kind of thing than the secret is) and its mood/energy. Without a generated secret the scene **demotes to a standard one** — there is no language-neutral fallback secret, so mock mode carries a canned one to keep the path testable. Because this is the one scene type whose outcome is actually known, `character_state` records which way it went (`mood_after_solved`/`mood_after_unsolved`) instead of 5.2's hedge.
- The output schema always *describes* `level_assessment`; inclusion is gated by the turn instruction (every 5th turn), and the messenger router drops it if emitted unrequested. Quiz candidates are requested only when `ENABLE_QUIZZING=1` (default off).
- Premade scripted conversations: `premade_conversations.json` + `premade_sessions` in-memory dict in `routers/messenger.py`. **Known bug:** both premade paths build `MessengerTurnResponse` without the required `input_intent` field, so premade conversations currently 500 (xfail-documented in `tests/test_smoke.py`).
- Chat-log-for-review files: `chat_log.append_chat_log()` writes `chat_log_{lang}.md` per learning language — a running transcript for manual accuracy review, not consumed by the app.

**`llm_call.py`** — all OpenAI calls, one function per feature (see Mode Inventory), each delegating to the shared **`_call_openai_json()`** helper (text extraction, JSON parse, token/cost accounting from `settings.MODEL_PRICING`, per-call `model` override, usage-tracker recording). **Every LLM call records cost** to the usage tracker. Mock short-circuits and error fallbacks stay per-function. Register/STT rules imported from `prompt_fragments.py`.

**`tts_helpers.py`** — Azure TTS wrapper. Default voices come from `settings.VOICE_MAP` (env `AZURE_VOICE_ES`/`EN`/`ID`), but `scripts/generate_worddrill_audio.py` / `generate_battle_audio.py` still hardcode their own (`id-ID-ArdiNeural` vs the `VOICE_MAP` default `id-ID-GadisNeural`) — check both before assuming which voice is in play for Indonesian audio, especially cached files. The audio cache key is `text|locale` and does **not** include voice, so regenerating with a different default voice silently mixes speakers in the cache.

**`tests/`** — mock-mode smoke suite covering every route (`test_smoke.py`) + prompt goldens and prefix-stability tests (`test_prompt_snapshot.py`). Run `python -m pytest tests/` from `backend/` after any backend change; it needs no API keys and restores all state files it touches.

**Two audio delivery patterns, used inconsistently by mode:**
1. **Live per-turn generation** — a fresh timestamped file every call, even for repeated text. Used by messenger chunks and story-cards turns. No dedup.
2. **Content-hash cache** — `get_cached_audio_path()`, files at `audio_files/cache/cached_{lang}_{hash}.wav`. Used by `/api/trivia/audio` (trivia, worddrill, battle, trivia2, premade chunks). Prefer this pattern for anything reused.
3. **Static pre-generated files** — one-time batch scripts in `backend/scripts/` (`generate_battle_audio.py`, `generate_greeting_audio.py`, `generate_worddrill_audio.py`) writing to `frontend/public/`. Number Rush expects this pattern but its script/files don't exist yet.

**`usage_tracker.py`** — tracks spend against `MAX_AZURE_CHARS = 500_000` chars/month and `MAX_OPENAI_BUDGET_CENTS = 1000.0` ($10), surfaced via `/api/usage` and the `UsageDiagnostics.tsx` battery bars shown on every screen. OpenAI cost is computed per model from `settings.MODEL_PRICING` (real published rates) and recorded by **every** LLM call. Note: the local `.env` currently sets `OPENAI_MODEL=gpt-4o-mini` (not gpt-4.1-mini); add a `MODEL_PRICING` row before switching to a model not in the table, or it bills at the gpt-4.1-mini fallback rate.

**Frontend shared layer** — `config.ts` (`API_BASE`, `LOCALE_MAP`/`localeFor`), `sharedGameUtils.ts` (types + pure functions), `sharedGameHooks.ts` (`useAudioPlayer`, `useWisprAutoSend`), and `sharedGameComponents.tsx` (React components), documented in `frontend/src/SHARED_COMPONENTS.md`. **Import from these — do not copy.** Hooks are a separate file from components because Fast Refresh requires component files to export only components. Every active mode now imports the shared versions of auto-send, audio, fuzzy matching, apiBase, and locales — there are no per-mode duplicates left to migrate, so a new duplicate is a regression.

## Data files

| Path | Contents | State or content? |
|---|---|---|
| `backend/prompts/helpers/scene_dimensions.json` | Scene dimensions (settings / character goals + completion conditions / user goals / complications) sampled by `pick_scene_dimensions` | Content |
| `backend/prompts/templates/scene.txt`, `secret.txt` | Scene and secret-scene prompt blocks (dynamic tail) | Content |
| `backend/profiles/default_profile.json` | Messenger learner profile: level, weak_points, level_history, active `scene` | Runtime state (grows unbounded; `weak_points` currently has no pruning — expect junk entries) |
| `backend/quiz_items/default_quiz.json` | Spaced-repetition quiz items | Runtime state |
| `backend/conversations/session_*.json` | Saved messenger conversations | Runtime state |
| `backend/user_profile.json` | Battle-mode mistake log | Runtime state |
| `backend/chat_log_{lang}.md` | Human-readable correction transcript per language | Runtime state (append-only log, not read by the app) |
| `backend/usage_data.json` | Usage-tracker running totals | Runtime state |
| `backend/premade_conversations.json` | Scripted messenger openers (3 Spanish scripts; none for Indonesian) | Content |
| `backend/word_practice_sentences.json`, `_id.json` | Word-drill sentence banks | Content |
| `frontend/src/*trivia_game.json`, `battle_conversations_*.json`, `cards_deck_150.json` | Trivia/battle/story-cards content banks | Content |
| `frontend/src/data/sombongo_pivots.ts` | Messenger topic-changer scripts (Spanish-flavored) | Content |
| `backend/prompts/chat_system_prompt.txt` | Messenger persona system prompt | Content |
| `backend/audio_files/session_*/`, `messenger_*/` | Per-session live-generated audio | Runtime state (grows unbounded, never cleaned up) |
| `backend/audio_files/cache/` | Content-hash cached audio | Runtime state (grows unbounded, never evicted) |

## Shared conventions

**The rule: cross-mode requirements belong in the shared module, not inline in one mode.** If you're asked to change behavior that should hold "for every mode" (accent handling, auto-send timing, audio caching, register rules), implement it in the shared file below and add/update its row here — don't inline it in whichever mode prompted the request. Modes below marked "not migrated" still have their own local copy; if you're touching one of them, prefer migrating to the shared version over patching the duplicate.

| Invariant | Implementation | Adopted by |
|---|---|---|
| Wispr auto-send timing (paste of ≥3 chars → send after ~1.5s cancelable window; typing never auto-sends; guard 700ms since last send) | `useWisprAutoSend` hook, `sharedGameHooks.ts`; `AutoSendBar` renders the countdown; `GameTextarea` wraps both | **All 7 modes.** `MessengerChat.tsx` via `GameTextarea`; `BattleGame.tsx`, `GuessingGame.tsx`, `StoryCardsGame.tsx`, `TriviaGame.tsx`, `WordDrillGame.tsx`, `trivia2/TriviaGame2.tsx` call the hook directly and keep only their own textarea markup |
| Never penalize accents/punctuation/capitalization | `NEVER_PENALIZE_ACCENTS_RULE` in `prompt_fragments.py` (used by `check_trivia_answer`); quiz-candidate rules also in `prompt_fragments.py`; normalization helper `normalizeForMatch` (frontend, `sharedGameUtils.ts`) | Frontend consolidated; prompt text consolidated. Backend still has 3 near-identical normalize functions (`_normalize_for_llm` in `llm_call.py`, `normalize_for_match` in `routers/messenger.py`, `normalize_answer` in `quiz_store.py`) — not yet consolidated |
| Fuzzy-match before calling the LLM | `checkFuzzyMatch`, `sharedGameUtils.ts` | **All 4 checking modes**: `BattleGame.tsx`, `TriviaGame.tsx`, `trivia2/TriviaGame2.tsx`, `WordDrillGame.tsx` |
| Audio fetch/cache/play | `useAudioPlayer(apiBase)` hook, `sharedGameHooks.ts` — client-side cache keyed `locale:rate:text` (`play(text, locale, rate?)`; `SLOW_TTS_RATE` in `config.ts` is the 0.75× repeat-after-me speed), one player per component instance | **All audio modes**: `WordDrillGame.tsx`, `TriviaGame.tsx`, `MessengerChat.tsx`, `StoryCardsGame.tsx`, and `HistoryLogEntry` |
| `apiBase` default (`VITE_API_BASE_URL` env or `http://localhost:8000`) | `API_BASE`, `frontend/src/config.ts` | Every mode + `UsageDiagnostics.tsx` + `HomeScreen.tsx`. Only legacy `ChatWithWispr.tsx` still has its own copy |
| Locale map (`es`→`es-MX`, `id`→`id-ID`, `en`→`en-US`) | Frontend: `LOCALE_MAP` / `localeFor()`, `frontend/src/config.ts`. Backend: `LOCALE_MAP` / `locale_for()`, `settings.py` | All frontend modes + all backend call sites. Keep the two files in sync |
| Casual register per language (Indonesian `-kah`/`aja` vs `saja`, Spanish Latin American/Mexican lean) | `language_style_instruction()`, `prompt_fragments.py`; also checked in `check_trivia_answer`'s `register_too_formal` feedback key | Backend-only, single source — good, keep it that way |
| STT/ASR tolerance rules | `STT_TOLERANCE_RULE` + `UNNATURAL_PHRASING_RULE`, `prompt_fragments.py` (see `backend/PROMPTS.md`) | `check_trivia_answer` (trivia/battle/worddrill/quiz checks) |
| Messenger prompt-cache prefix stability (static prefix byte-identical across turns) | `prompts/messenger_prompt.py` static-prefix/dynamic-tail split; enforced by `tests/test_prompt_snapshot.py` | Messenger. Never insert per-turn content before the student-model section |

**"Import, never copy" applies to `config.ts` / `sharedGameUtils.ts` / `sharedGameHooks.ts` / `sharedGameComponents.tsx`.** When building a new mode, check `SHARED_COMPONENTS.md` first for an existing component/hook/util before writing one. Do not tell a future agent to "copy constants from BattleGame.tsx" — that instruction is outdated; `FEEDBACK_MAP`, `FEEDBACK_COLORS`, `FEEDBACK_LABELS`, `HINT_COLORS`, `checkFuzzyMatch`, `normalizeForMatch`, `calculateDistance`, `distanceToOpacity`, `tokenizeWithHints`, `diffExampleVsUser` all live in `sharedGameUtils.ts`; `useAudioPlayer` and `useWisprAutoSend` in `sharedGameHooks.ts`; `API_BASE` and `localeFor` in `config.ts` — import them.

See `frontend/src/SHARED_COMPONENTS.md` for full component/util API reference (props, types, request/response shapes for `/api/worddrill/check`, `/api/battle/check`, `/api/trivia/audio`).

## Cost rules

- Prefer the content-hash audio cache (`get_cached_audio_path`) or static pre-generated files over live per-turn TTS generation for any text that repeats.
- Always try `checkFuzzyMatch`/local matching before calling an LLM check endpoint — a correct fuzzy match costs $0.
- Both budgets are tracked and shown in the UI (`UsageDiagnostics.tsx`) — 500k Azure chars/month, $10 OpenAI budget. Check `/api/usage` before assuming headroom for bulk operations (e.g., batch audio pre-generation).

## Adding a new mode

1. Add the mode key to the union type in **3 places**: `App.tsx` (state type + `handleSelectMode` param type) and `HomeScreen.tsx` (`onSelectMode` prop type). There is no shared registry yet — all three must be edited by hand and kept in sync.
2. Add a card to `HomeScreen.tsx` and a render block to `App.tsx`.
3. Use the shared layer for textarea input, feedback badges, correction diffs, hints, and history log — see `SHARED_COMPONENTS.md`. Don't hand-roll auto-send timing, audio caching, fuzzy matching, apiBase, or locales; use `GameTextarea` (or `useWisprAutoSend` + `AutoSendBar` if you need custom chrome), `useAudioPlayer`, `checkFuzzyMatch`, and `config.ts`.
4. Decide the audio pattern up front (live/cached/static — see Architecture above) based on whether the content is a closed, reusable set.
5. If the mode should track usage, call `/api/usage/session/start`.

## Common mode features (reference spec)

The following is the intended UX spec for a fully-built mode (textarea behavior, feedback area, history log, hints). It describes the target design, not every mode's current state — `pronounblitz` and `numbers` in particular are far from this. When building or extending a mode, use the shared layer (per Shared Conventions above) to implement it — do not hand-write these behaviors from scratch, and do not copy from `BattleGame.tsx`.

### 1. Textarea Input
- **Auto-focus**: focuses textarea when a sentence/prompt exists, not busy, answer not yet accepted
- **Hover-focus**: `onMouseEnter` focuses textarea if not busy/disabled
- **Wispr auto-send**: on a growth of ≥3 chars in one update (paste), start a ~1.5s pending-send window (visually indicated); typing does not auto-send; guard against double-send within 700ms of the last send — this is exactly what `useWisprAutoSend` implements (and `GameTextarea` wraps)
- **Manual send**: Enter submits, Shift+Enter inserts newline, Escape cancels a pending auto-send and clears
- **Clear button**: clears input, re-focuses
- **Skip button**: shows correct answer, adds to history as skipped, enables Next
- **Disabled**: when busy OR answer already accepted/skipped
- **"Checking…" label**: show on submit control while busy

### 2. Live Feedback Area (below textarea)
- Status icon: ✓ correct (green `#86efac` / gold `#fbbf24` / orange `#f97316` by quality), → skipped (gray), no icon for wrong
- Feedback message text in matching color
- **Issue badges**: `<FeedbackBadges>` — uses `FEEDBACK_COLORS`, `FEEDBACK_LABELS`, `FEEDBACK_MAP` from `sharedGameUtils.ts`
- **Correction tokens**: `<CorrectionTokens>` — inline diff, removed words red/strikethrough, added bold green, unchanged dim white
- Wrong answers: show feedback then clear textarea and reset to idle so user can retry

### 3. History Log (right column, ~34% width)
- `<HistoryLogEntry>` — self-contained; see `SHARED_COMPONENTS.md` for full prop/behavior reference (collapsed/expanded states, quality bar, hints bar, hover-audio, pin-on-click, previous-attempts sub-section)
- Wrong attempts hidden from the main log once the sentence resolves — visible only inside the resolved entry's "Previous attempts" section
- Auto-scroll to bottom on new entry

### 4. Hints System (optional — include only when `currentSentence.hints` is non-empty)
- `<HintCards>` — horizontal scrollable row, proximity-glow on the nearest unrevealed card, hover-to-reveal text and audio
- `tokenizeWithHints()` for hint-highlighting inside the displayed sentence

All constants/functions referenced above live in `sharedGameUtils.ts` / `sharedGameComponents.tsx` — see `SHARED_COMPONENTS.md`.

---

- Do not implement new features that weren't requested. If you'd like to add something not already discussed, confirm the plan with the user first.
