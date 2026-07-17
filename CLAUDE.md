# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

**Backend** (`backend/`) — **one backend, `game_backend.py`**. `fastapi_wispr_pipeline.py` also exists but is legacy/unreachable — see Mode Inventory.
```bash
pip install -r requirements.txt
python game_backend.py     # port 8000 (or: uvicorn game_backend:app --reload --port 8000)
```

`backend/.env` (git-ignored, real keys already present locally — never print or commit its contents):
```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini        # llm_call.py default if unset; NOT gpt-4o-mini
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
| `messenger` | `MessengerChat.tsx` | **Active / main** | `/api/messenger/turn`, `/api/messenger/profile*`, `/api/messenger/premade-start`, `/api/quiz/check`, `/api/quiz/pending`, `/api/quiz/stats` | `call_llm_for_messenger` | Live TTS per chunk, saved to `audio_files/messenger_*` (no cache) |
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

**Backend (`game_backend.py`, ~2000 lines, single file — not yet split into routers):**
- FastAPI app, all routes defined top-level (see Mode Inventory table for the endpoint map)
- Persona/messenger prompt assembly: `build_layered_prompt()` — 5 layers (system prompt file `prompts/chat_system_prompt.txt`, persona JSON `sombongo` in `PERSONA`, student-model template, last-3-turn context, turn instruction), composed per turn and sent as **one** `responses.create` call via `call_llm_for_messenger`. `prompt_version` is `"v1"` (standard) or `"v2"` (adds a hover-reveal "challenge" sentence — the default in `MessengerChat.tsx`).
- Quiz candidates are requested from the LLM only when `ENABLE_QUIZZING=1` (default off). Level/profile assessment runs only every 5th turn.
- Premade scripted conversations: `premade_conversations.json` + `premade_sessions` in-memory dict, served via `/api/messenger/premade-start`.
- Chat-log-for-review files: `append_chat_log()` writes `chat_log_{lang}.md` per learning language — a running transcript of user input / corrections, meant for manual accuracy review, not consumed by the app.

**`llm_call.py`** — all OpenAI calls, one function per feature (see Mode Inventory). `DEFAULT_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")`. Each function independently extracts response text, parses JSON, and computes token-usage cost — this boilerplate is duplicated per function (candidate for a shared `_call_openai_json` helper, not yet built). `_language_style_instruction(lang_code)` is the one authoritative place for Spanish/Indonesian register rules — also duplicated (older, unused) in `fastapi_wispr_pipeline.py`.

**`tts_helpers.py`** — Azure TTS wrapper. Default voices come from env (`AZURE_VOICE_ES`/`EN`/`ID`), independently defaulted again in `scripts/generate_worddrill_audio.py` / `generate_battle_audio.py` (which hardcode `id-ID-ArdiNeural` instead of the `tts_helpers.py` default `id-ID-GadisNeural`) — check both before assuming which voice is in play for Indonesian audio, especially cached files. The audio cache key is `text|locale` and does **not** include voice, so regenerating with a different default voice silently mixes speakers in the cache.

**Two audio delivery patterns, used inconsistently by mode:**
1. **Live per-turn generation** — a fresh timestamped file every call, even for repeated text. Used by messenger chunks and story-cards turns. No dedup.
2. **Content-hash cache** — `get_cached_audio_path()`, files at `audio_files/cache/cached_{lang}_{hash}.wav`. Used by `/api/trivia/audio` (trivia, worddrill, battle, trivia2, premade chunks). Prefer this pattern for anything reused.
3. **Static pre-generated files** — one-time batch scripts in `backend/scripts/` (`generate_battle_audio.py`, `generate_greeting_audio.py`, `generate_worddrill_audio.py`) writing to `frontend/public/`. Number Rush expects this pattern but its script/files don't exist yet.

**`usage_tracker.py`** — tracks spend against `MAX_AZURE_CHARS = 500_000` chars/month and `MAX_OPENAI_BUDGET_CENTS = 1000.0` ($10), surfaced via `/api/usage` and the `UsageDiagnostics.tsx` battery bars shown on every screen.

**Frontend shared layer** — `sharedGameUtils.ts` (types + pure functions) and `sharedGameComponents.tsx` (React components), documented in `frontend/src/SHARED_COMPONENTS.md`. **Import from these — do not copy.** Adoption is uneven today (see Shared Conventions below); new code should use the shared exports, and if you touch a mode still using a local copy, prefer migrating it over patching the duplicate.

## Data files

| Path | Contents | State or content? |
|---|---|---|
| `backend/profiles/default_profile.json` | Messenger learner profile: level, weak_points, level_history | Runtime state (grows unbounded; `weak_points` currently has no pruning — expect junk entries) |
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
| Wispr auto-send timing (paste of ≥3 chars → send after ~1.5s pending window; guard 700ms since last send) | `GameTextarea` component, `sharedGameComponents.tsx` | `MessengerChat.tsx` only. **Not migrated**: `BattleGame.tsx`, `GuessingGame.tsx`, `StoryCardsGame.tsx`, `TriviaGame.tsx`, `WordDrillGame.tsx`, `trivia2/TriviaGame2.tsx` each have their own copy |
| Never penalize accents/punctuation/capitalization | Stated in the `check_trivia_answer` prompt (`llm_call.py`) and quiz-candidate rules (`game_backend.py`); normalization helpers `normalizeForMatch` (frontend, `sharedGameUtils.ts`) | Backend has 3 near-identical normalize functions (`_normalize_for_llm`, `normalize_for_match`, `normalize_answer`) — not yet consolidated |
| Fuzzy-match before calling the LLM | `checkFuzzyMatch`, `sharedGameUtils.ts` | Re-implemented locally in `BattleGame.tsx`, `TriviaGame.tsx`, `trivia2/TriviaGame2.tsx` — **not migrated** |
| Audio fetch/cache/play | Manual pattern documented in `SHARED_COMPONENTS.md` (no hook yet — `useAudioPlayer` does not exist) | Each of `WordDrillGame.tsx`, `TriviaGame.tsx`, `MessengerChat.tsx`, `StoryCardsGame.tsx` has its own cache `Map` |
| `apiBase` default (`VITE_API_BASE_URL` env or `http://localhost:8000`) | No shared config module yet — repeated inline in ~9 files | `UsageDiagnostics.tsx` hardcodes its own copy instead |
| Locale map (`es`→`es-MX`, `id`→`id-ID`, `en`→`en-US`) | No shared module yet | Repeated inline in `MessengerChat.tsx`, `game_backend.py`, `llm_call.py` |
| Casual register per language (Indonesian `-kah`/`aja` vs `saja`, Spanish Latin American/Mexican lean) | `_language_style_instruction()`, `llm_call.py`; also checked in `check_trivia_answer`'s `register_too_formal` feedback key | Backend-only, single source — good, keep it that way |
| STT/ASR tolerance rules | Inline in relevant LLM prompts (`llm_call.py`) | No shared prompt-fragment module yet |

**"Import, never copy" applies to `sharedGameComponents.tsx` / `sharedGameUtils.ts`.** When building a new mode, check `SHARED_COMPONENTS.md` first for an existing component/util before writing one. Do not tell a future agent to "copy constants from BattleGame.tsx" — that instruction is outdated; `FEEDBACK_MAP`, `FEEDBACK_COLORS`, `FEEDBACK_LABELS`, `HINT_COLORS`, `checkFuzzyMatch`, `normalizeForMatch`, `calculateDistance`, `distanceToOpacity`, `tokenizeWithHints`, `diffExampleVsUser` all live in `sharedGameUtils.ts` — import them.

See `frontend/src/SHARED_COMPONENTS.md` for full component/util API reference (props, types, request/response shapes for `/api/worddrill/check`, `/api/battle/check`, `/api/trivia/audio`).

## Cost rules

- Prefer the content-hash audio cache (`get_cached_audio_path`) or static pre-generated files over live per-turn TTS generation for any text that repeats.
- Always try `checkFuzzyMatch`/local matching before calling an LLM check endpoint — a correct fuzzy match costs $0.
- Both budgets are tracked and shown in the UI (`UsageDiagnostics.tsx`) — 500k Azure chars/month, $10 OpenAI budget. Check `/api/usage` before assuming headroom for bulk operations (e.g., batch audio pre-generation).

## Adding a new mode

1. Add the mode key to the union type in **3 places**: `App.tsx` (state type + `handleSelectMode` param type) and `HomeScreen.tsx` (`onSelectMode` prop type). There is no shared registry yet — all three must be edited by hand and kept in sync.
2. Add a card to `HomeScreen.tsx` and a render block to `App.tsx`.
3. Use `sharedGameComponents.tsx`/`sharedGameUtils.ts` for textarea input, feedback badges, correction diffs, hints, and history log — see `SHARED_COMPONENTS.md`. Don't hand-roll auto-send timing or fuzzy matching; use `GameTextarea` and `checkFuzzyMatch`.
4. Decide the audio pattern up front (live/cached/static — see Architecture above) based on whether the content is a closed, reusable set.
5. If the mode should track usage, call `/api/usage/session/start`.

## Common mode features (reference spec)

The following is the intended UX spec for a fully-built mode (textarea behavior, feedback area, history log, hints). It describes the target design, not every mode's current state — `pronounblitz` and `numbers` in particular are far from this. When building or extending a mode, use `sharedGameComponents.tsx`/`sharedGameUtils.ts` (per Shared Conventions above) to implement it — do not hand-write these behaviors from scratch, and do not copy from `BattleGame.tsx`.

### 1. Textarea Input
- **Auto-focus**: focuses textarea when a sentence/prompt exists, not busy, answer not yet accepted
- **Hover-focus**: `onMouseEnter` focuses textarea if not busy/disabled
- **Wispr auto-send**: on a growth of ≥3 chars in one update (paste), start a ~1.5s pending-send window (visually indicated); guard against double-send within 700ms of the last send — this is exactly what `GameTextarea` implements
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
