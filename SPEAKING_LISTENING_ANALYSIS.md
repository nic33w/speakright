# SpeakRight — Speaking/Listening Focus & Project Structure Analysis

*Analysis date: 2026-07-11. Read-only review; no app source files were modified.*
*Addendum 2026-07-12: §11 (adaptive comprehension load — the "don't overwhelm the user" problem) and §12 (distribution, monetization & marketing).*

This document covers two goals: (A) whether the app is actually building **speaking/listening fluency** for intermediate Spanish/Indonesian learners, or drifting toward reading/writing practice; and (B) why the same instructions keep needing to be re-specified across modes, and how to fix that structurally.

---

## 0. Ground truth: what the app actually is today

Established by reading the code (this differs substantially from CLAUDE.md — see §6):

- **One backend**: `backend/game_backend.py` (FastAPI, port 8000) serves *every* mode: story cards, trivia, messenger, guessing, battle, quiz, word drill, plus TTS/audio/usage endpoints. `backend/fastapi_wispr_pipeline.py` is **legacy** — its only client is `ChatWithWispr.tsx`, which is no longer imported by `App.tsx` and is unreachable from the UI.
- **Nine reachable modes** via `HomeScreen.tsx` → `App.tsx`: `worddrill`, `trivia2`, `battle`, `story`, `trivia`, `messenger`, `guessing`, `pronounblitz`, `numbers`. Active/main: **messenger, trivia, worddrill**.
- **LLM calls** (`backend/llm_call.py`, default model `gpt-4.1-mini` via env `OPENAI_MODEL`):
  - `call_llm_for_messenger` — messenger turn (prompt built in `game_backend.build_layered_prompt`)
  - `check_trivia_answer` — shared judge for trivia, battle, word drill, and quiz checks (with a local fuzzy-match fast path that skips the LLM entirely)
  - `call_llm_for_turn` — story cards
  - `call_llm_for_grammar_chat`, `call_llm_for_freeform_correction` — word drill extras
  - `call_llm_to_pick_secret`, `call_llm_for_guessing_turn` — guessing game
- **TTS**: Azure via `tts_helpers.py`. Two delivery patterns: (1) live per-turn generation saved under `audio_files/session_*` / `audio_files/messenger_*` (no dedup), and (2) a **content-hash cache** (`get_cached_audio_path`, `audio_files/cache/cached_{lang}_{hash}.wav`) used by `/api/trivia/audio` and premade conversations. Three pre-generation scripts exist (`scripts/generate_battle_audio.py`, `generate_greeting_audio.py`, `generate_worddrill_audio.py`).
- **Usage tracking**: `usage_tracker.py` + `UsageDiagnostics.tsx` battery bars (500k Azure chars/month, $10 OpenAI budget).
- **Shared frontend layer**: `sharedGameUtils.ts` + `sharedGameComponents.tsx`, documented in `frontend/src/SHARED_COMPONENTS.md` — but adoption is uneven (see §7).

### Verification of the messenger single-call claim

Confirmed, with two clarifications. `messenger_chat_turn` (`game_backend.py:1244`) builds a 5-layer prompt in `build_layered_prompt` (`game_backend.py:899`) — system prompt file, persona JSON (`sombongo`), student-model template, last-3-turn context, turn instruction — and `call_llm_for_messenger` (`llm_call.py:559`) executes it as **one** `responses.create` call returning one JSON object with the reply chunks, corrections (`corrected_input`/`had_errors`/`error_explanation`/`user_translation`), `input_intent`, and `suggested_replies`. Clarifications:

1. **Quiz candidates are only requested when `ENABLE_QUIZZING=1`** (`game_backend.py:1014`), and that env var **defaults to False** (`game_backend.py:32`). By default the schema section is omitted entirely.
2. **Level assessment is only requested every 5th turn** (`game_backend.py:1028`), not every turn.

**Single-call tradeoffs (evaluation):**

- *For keeping one call*: the persona/system/student layers are the bulk of the prompt; splitting into two calls would pay that input cost twice (or force a much thinner correction prompt). One call is also one round-trip — messenger already has theatrical delays, so latency is masked.
- *Against*: the prompt asks one model at temperature 0.2 to be simultaneously a creative persona, a precise grammar judge, a level assessor, and a suggestion writer. The commit history (`1acf79b`, `28e6b2a`, `456db1c`, `dcb5a93`, `5871c37`) is a record of whack-a-mole patches for exactly the failure modes you'd expect: the correction field getting contaminated by the conversational role, English leaking into audio chunks, repetition between chunks. Each patch adds "CRITICAL" reminders, growing the prompt further (the naturalness/gaseoso rules now appear twice per turn). Also: `max_output_tokens=800` caps a response that must contain chunks + translations + suggestions + corrections; one truncation → `_extract_json` throws → the *entire* turn (including the correction) is replaced by the generic error fallback.
- *Recommendation*: keep the single call for now — it's cheaper and the quality issues have been mostly tamed — but (a) deduplicate the repeated reminder text in `build_layered_prompt` (the naturalness rule is stated in both the schema comment and CRITICAL REMINDERS), (b) raise `max_output_tokens` or drop `suggested_replies` to a separate cheap call, and (c) if correction quality regresses again, the natural split is **correction+quiz-candidate extraction** (small, deterministic, cacheable, could run on `gpt-4.1-nano`) vs **persona reply** (creative, could stream) — not a three-way split.

---

## 1. Gaps — where the app drifts toward reading/writing instead of speaking/listening

### 1.1 Messenger is structurally an English-reading experience
`prompts/chat_system_prompt.txt` mandates **70–80% of the character's output in the UI language (English)**, 15–25% target text, and only **5–10% target audio**. For an intermediate learner, each turn is: read English paragraph(s) → optionally hear one Spanish sentence. The learner produces target language, but *receives* mostly English.

*(Design note: this ratio is an intentional anti-overwhelm scaffold — the user is already producing Spanish, so the character's English keeps receptive load manageable. The problem isn't the scaffold; it's that the ratio is **static**: hardcoded in the prompt file and in `generate_turn_instruction` (`game_backend.py:894`) with no per-user or per-turn adjustment — and the level never advances (see 1.5), so it never would adjust even if it did. §11 proposes an adaptive, fluctuating version of the same design.)*

The **v2 challenge format** (default in `MessengerChat.tsx:262`) is the best listening feature in the app — audio-first challenge sentence, text hidden behind the 3-zone hover-reveal card (`MessengerChallengePair`). But it's one sentence per turn inside an otherwise English-text exchange.

### 1.2 Audio is off by default in the main mode
`MessengerChat.tsx:270`: `audioEnabled` defaults to `false`. That flag gates the one genuinely speech-centric feature — TTS of the learner's own **corrected** sentence (`sendMessage`, `MessengerChat.tsx:662`), which auto-plays when the user spoke English (translation modeling). With the default off, corrections arrive purely as red/green text diffs (`CorrectionTokens`) — a reading exercise about writing.

### 1.3 The correction/feedback loop is entirely visual
Everywhere — messenger diffs, trivia/battle/word drill `correction_tokens`, quiz feedback strings — corrections are rendered as text. The learner never *hears* the corrected version unless they hover a history entry (shared `HistoryLogEntry` does pre-warm and play answer audio on hover — good) or has `audioEnabled` on. There is no "now say it correctly" re-production step in any mode: after a correction, the flow moves on. For speaking fluency, re-producing the fixed sentence aloud is the highest-value rep in the whole loop, and no mode asks for it.

### 1.4 Number Rush — the flagship listening mode — currently has no audio
`NumberRush.tsx:65-73` expects static files at `/public/number_audio/{lang}/{voice}/number_{n}.mp3`. **That directory does not exist** (`frontend/public/` contains only `battle_audio/`, `bots/`, images), and there is no `generate_number_audio.py` in `backend/scripts/` (battle/greetings/worddrill have one). The error handler silently skips to the tap phase, and the HUD then prints the target **as a digit** — `Find: ${targetNumber}` (`NumberRush.tsx:583`) — so as shipped it's a visual number-spotting game with zero listening content. Also note the digit fallback would defeat the purpose even *with* audio present; it should only appear when audio actually failed.

### 1.5 The adaptive-level system is inert, so difficulty never rises to "intermediate"
`profiles/default_profile.json` after **372 turns**: `level: "beginner"`, `level_history` contains only the creation entry, `comfortable_with: []`, and `weak_points` polluted with junk (`"tisco"`, `"punctuation"` — the latter contradicting the app's own ignore-punctuation rule) that is never pruned. Consequences chain: the student-model layer tells the persona the learner is a beginner with 13 weak points → target-language text stays at "beginner i+1" → the 5–10% audio budget stays trivially easy. The every-5th-turn assessment (`generate_turn_instruction`) plus the `confidence >= 0.7 && should_update` gate (`update_profile_from_assessment`, `game_backend.py:1141`) has fired zero level changes in 372 turns. This one dead loop quietly caps the difficulty of the entire messenger experience.

### 1.6 Spaced-repetition quiz system is dead in practice
Three compounding causes:
- `ENABLE_QUIZZING` defaults **False** (`game_backend.py:32`) — quiz candidates aren't even requested from the LLM.
- Even when enabled, storage is gated on the wrong field: `if candidate and candidate.get("prompt_target")` (`game_backend.py:1452`) — but the schema the LLM is told to emit uses `quiz_prompt` (`game_backend.py:1015`), and `add_quiz_item` reads `quiz_prompt` too. New-format candidates are **silently dropped**; the only items on disk (`quiz_items/default_quiz.json`) are 3 old-format entries from February, all at mastery 3, so `get_pending_quiz` always returns `None`.
- Minor: `update_quiz_item` sets `is_answered = True` then immediately `False` (`game_backend.py:771,790`), making that field meaningless.

Additionally, the quizzes that did exist are text-recall ("How do you say 'sunscreen' in Spanish?" → type answer): recognition of orthography, not spoken production or listening (see §4).

### 1.7 Wispr confidence data is plumbed but unused
`wispr_alternatives` / `pick_asr_fixes` exist in the story-cards path (`game_backend.py:179`), but nothing in the three main modes consumes ASR alternatives or confidence. There is no pronunciation signal anywhere — understandable given Wispr outputs text only, but worth noting: the `asr_error` feedback key in `check_trivia_answer` is the app's only acknowledgment that the user *spoke*.

### 1.8 What's already right (patterns to build on)
- `HistoryLogEntry`'s **"🔇 Audio only"** toggle (`hideTargetText`) — history entries play audio, hide text.
- Word drill learn mode's reveal order: context → English → **audio plays with target text hidden** → text reveals (`WordDrillGame.tsx:213`).
- Messenger v2 challenge card (audio + hover-to-reveal both languages).
- Greeting suggestions with **pre-generated audio** that plays on hover.
- These all embody the right principle — *ear first, eyes on demand* — but each was built ad hoc per mode (see §7).

---

## 2. New mode/feature ideas (prioritizing reuse of existing infrastructure)

### Idea A — "Echo" drill: hear it, say it (repeat-after / shadowing)
Pure listening+speaking rep. Play a target-language sentence (audio only, text hidden), the learner repeats it via Wispr, backend verifies. On miss, replay and retry; on success, next sentence.
- **Why it fits**: converts *every existing sentence bank* (trivia JSONs, `word_practice_sentences*.json`, battle conversation lines) into listening material with no new content authoring. STT-tolerance already exists (`asr_error` handling, accent stripping).
- **Variant**: "delayed echo" — play 2 sentences, learner repeats both, to stretch auditory working memory (the actual bottleneck for conversational listening).

### Idea B — Messenger "immersion dial" + spoken correction echo
Three changes inside the existing mode, no new mode:
1. A 3-position UI toggle (Gentle / Mixed / Immersed) that swaps the language-mix percentages injected into `chat_system_prompt.txt` — replacing the hardcoded 70–80% English rule and decoupling difficulty from the broken level loop.
2. Default `audioEnabled` to `true`, and always auto-play the corrected sentence after a correction (currently only for `input_intent === "english"`).
3. A "say it back" micro-step: when `had_errors=true`, the send button becomes "🎤 repeat the fix" for one turn; verify with local fuzzy match against `corrected_input` (zero LLM cost via the existing fast path).

### Idea C — Listening trivia ("what did they say?")
Inverse of current trivia: play the *target-language* sentence (cached TTS), learner types/says the **English meaning** (comprehension) or transcribes it (dictation) — two sub-modes. Reuses: trivia sentence banks, `/api/trivia/audio` cache, `check_trivia_answer` with reversed language roles, the whole shared history/feedback layer. This is the cheapest way to get a true listening-comprehension mode, and the sentence banks are finite so audio can be 100% pre-generated (§9).

### Idea D — Finish Number Rush, then generalize the static-audio pattern
1. Write `scripts/generate_number_audio.py` (clone of `generate_battle_audio.py`): 0–99 × es/id × 2 voices ≈ 400 short clips, a one-time ~2k-char Azure spend per voice.
2. Suppress the `Find: N` digit fallback when audio played successfully.
3. Then clone the mode for **times, dates, and prices** ("¿A qué hora?" / "Berapa harganya?") — the highest-frequency real-world listening panic moments, still a closed vocabulary, still zero marginal API cost.

---

## 3. Technical requirements per idea

| Idea | Backend | Frontend | Data | Conflicts / notes |
|---|---|---|---|---|
| A: Echo | None new — `/api/trivia/audio` (cached TTS) + `/api/trivia/check` or local fuzzy match | New mode component (~small if built on `GameTextarea` + `HistoryLogEntry` with `hideTargetText`) | Reuse existing sentence JSONs; a `sources.ts` mapping bank→locale | None. Add mode key to `App.tsx`/`HomeScreen.tsx` union types (3 places — see §7 on why that's annoying) |
| B: Immersion dial | Template placeholders in `chat_system_prompt.txt` (e.g. `{{mix_ui}}/{{mix_target}}`); accept a `mix` param on `/api/messenger/turn`; pass through `build_layered_prompt` | Toggle UI; change `audioEnabled` default; "repeat the fix" state in `sendMessage` flow | None | Interacts with prompt_version v1/v2 branch; keep dial orthogonal to v2. Prompt change → re-test correction quality (the prompt is fragile per commit history) |
| C: Listening trivia | Optionally a reversed-role wrapper around `check_trivia_answer` (English answers judged against English meaning) | New mode or a toggle inside `TriviaGame.tsx` (toggle preferred — same data/flow) | Existing trivia JSONs already have both languages per sentence | `check_trivia_answer`'s prompt assumes learner answers in learning language; comprehension sub-mode needs `fluent`/`learning` swapped in the call — verify feedback keys still make sense |
| D: Number Rush audio | `scripts/generate_number_audio.py` using `azure_tts_bytes_real` | Remove/condition digit fallback; optionally an "entering" replay button | ~400 mp3/wav files in `frontend/public/number_audio/` | Pick voices deliberately (see §5 voice-consistency issue). Files in `public/` ship with the build — fine for local app |

---

## 4. Spaced repetition: from text recall to spoken production

Current design (`quiz_items` + `QUIZ_TURNS_DELAY` turn-based scheduling with exponential backoff 3/6/12 turns, mastery 0–3, reset on miss) is a reasonable skeleton. To make it serve speaking/listening once the §1.6 bugs are fixed:

1. **Audio-first prompts.** Instead of rendering `quiz_prompt` text, play TTS of the English prompt (or show it) and require the answer to be *spoken* via Wispr — the checking path (`check_answer_locally` → `check_trivia_answer`) is already STT-tolerant, so this is mostly a frontend change in the quiz bubble UI (`MessengerChat.tsx` quiz section).
2. **Listening-side reviews.** For each item, alternate direction on successive reviews: (a) hear the corrected Spanish (`/api/trivia/audio` on `item.corrected` — cacheable, and quiz items are finite so pre-generatable), answer "what does it mean?"; (b) see/hear English, produce Spanish. Gate mastery 3 on passing *both* directions.
3. **In-context re-testing** is the unique advantage of quizzes living inside messenger: a quiz item's `corrected` phrase could be handed to the persona prompt as a "try to elicit this" hint on the turn it comes due, testing production in conversation instead of flashcard isolation. (Bigger change; do after basics work.)
4. **Scheduling**: turn-count scheduling is fine while all activity happens in messenger, but items become unreachable if you play other modes. Since `created_at`/`last_reviewed` timestamps already exist, a wall-clock fallback (`show_after_turn OR older than N days`) makes items due across sessions.
5. **Quality gate on candidates**: weak_points-style pollution (§1.5) will recur here. On `add_quiz_item`, reject candidates whose `corrected` is not in the target language or is a single stopword; cap total unmastered items.

---

## 5. Language-specific notes

**Voice inconsistency (affects both languages, worth fixing first):** default voices differ per code path — `tts_helpers.py` uses `es-MX-JorgeNeural` / `id-ID-GadisNeural`; `scripts/generate_worddrill_audio.py` and battle scripts use `id-ID-ArdiNeural`; legacy `fastapi_wispr_pipeline.py` names `es-MX-LucianoNeural` / `en-US-RyanMultilingualNeural`. So pre-generated cache files and live TTS can be *different speakers* for Indonesian, and the audio cache key (`text|locale`) doesn't include the voice — regenerating with a different default silently mixes voices within one mode. Define one `VOICE_MAP` in one module (see §7) and include voice in the cache key. Multi-voice is *good* for listening (Number Rush rotates voices deliberately) — but it should be a choice, not drift.

**Spanish (es-MX):**
- Style enforcement ("Latin American, lean Mexican, colloquial") is duplicated in `llm_call._language_style_instruction` and the legacy pipeline — one more §7 item.
- The naturalness rules in the messenger prompt (false cognates, body sensations, "gaseoso") are Spanish-specific examples baked into a language-agnostic prompt; when the target is Indonesian these examples are noise. Move language-specific naturalness examples into per-language prompt fragments.
- Spanish content is richer everywhere: 4 battle conversation files + 5 word-drill verbs vs Indonesian's 2 + 4. Fine given Spanish is primary, but listening-mode ideas (§2) inherit the imbalance automatically since they reuse the banks.
- Spanish-specific listening priority: numbers 11–15/60–90 confusions, rapid connected speech — Number Rush and Echo target these directly.

**Indonesian (id-ID):**
- The word-drill Indonesian set (`deh`, `sih`, `pas`, `lagi`) is exactly right for the speaking/listening goal — discourse particles are learned by ear, not by reading. Expand this set (dong, kok, kan, nih) before adding more Spanish verbs.
- Casual register is enforced in `check_trivia_answer` (`register_too_formal` for `-kah`, `aja` vs `saja`) and in `_language_style_instruction` — good, and this is the kind of rule that must live in exactly one place.
- STT reality: Wispr on Indonesian mishears more; the prompt's asr-patterns list already includes Indonesian examples (`'dise'→'di sini'`), and the hyphen-stripping for `-nya` (`llm_call.py:426`) is a nice touch. For Echo/dictation modes, expect to loosen fuzzy-match thresholds for id.
- No premade messenger conversations exist for Indonesian (`premade_conversations.json` has 3 Spanish scripts, and `PIVOTS` are Sombongo/Spanish-flavored) — messenger for Indonesian falls straight to LLM with Spanish-tuned prompt examples.

---

## 6. CLAUDE.md audit

CLAUDE.md describes an app that no longer exists. Specifics:

**Wrong (actively misleading):**
- "Two main modes: ChatWithWispr and StoryCardsGame" — ChatWithWispr is **unreachable** (not imported in `App.tsx`); there are 9 reachable modes and the active ones are messenger/trivia/worddrill.
- "Two separate FastAPI backends (run only one at a time)" and "`fastapi_wispr_pipeline.py` powers ChatWithWispr conversation UI" — `MessengerChat.tsx` calls `game_backend.py` endpoints (`/api/messenger/*`, `/api/quiz/*`, `/api/trivia/audio`, `/api/greetings/*`). `game_backend.py` is the only backend that matters; the pipeline file is dead code in practice.
- "App.tsx currently renders `<StoryCardsGame />` (switch to `<ChatWithWispr />`)" — App.tsx renders a home screen + mode router.
- CORS section lists 4 specific origins — `game_backend.py:76` uses `allow_origins=["*"]`.
- `OPENAI_MODEL=gpt-4o-mini` in the env example — `llm_call.py` defaults to `gpt-4.1-mini`; pricing constants assume 4o-mini/4.1-mini rates.
- "Game mode: no persistence (ephemeral gameplay)" — messenger persists profile, quiz items, chat logs; battle logs mistakes to `user_profile.json`.
- The "Common Mode Features" section says **"copy these constants from BattleGame.tsx"** — they were since extracted to `sharedGameUtils.ts`/`sharedGameComponents.tsx`, and `SHARED_COMPONENTS.md` correctly says to *import* them. CLAUDE.md directly contradicts the newer doc and instructs an agent to re-duplicate. This is a root cause of §7.
- The audio API in "Common Mode Features" is described correctly (`/api/trivia/audio`) but the hint/audio snippets duplicate SHARED_COMPONENTS.md content at an older revision.

**Missing entirely:**
- The messenger system (persona architecture, `prompts/` layering, profile/level assessment, premade conversations, pivots, v1/v2 prompt versions, quiz candidates).
- Trivia, word drill (both its practice and learn phases), battle, Number Rush, Pronoun Blitz, trivia2/bots, guessing.
- The shared component layer and `SHARED_COMPONENTS.md` (never referenced!).
- Usage tracking / budget bars; audio caching; the pre-generation scripts pattern; chat-log-for-review files (`chat_log_es.md`); `ENABLE_QUIZZING`.
- Per-mode LLM call map (which endpoint → which `llm_call` function).

**Proposed CLAUDE.md structure** (rewrite, don't patch):

```
# CLAUDE.md
1. What this app is (speaking/listening goal, Wispr STT → LLM review → Azure TTS, 1 sentence)
2. Run it (frontend dev server; backend = game_backend.py ONLY; MOCK_MODE; env vars incl. ENABLE_QUIZZING)
3. Mode inventory table: mode key | component | status (active/experimental/legacy) | backend endpoints | LLM function | audio pattern (live TTS / cached TTS / static files)
   — mark ChatWithWispr + fastapi_wispr_pipeline.py as LEGACY, do-not-extend
4. Architecture: game_backend.py sections, llm_call.py functions, tts_helpers + the two audio patterns + cache, usage_tracker, prompts/ layering for messenger
5. Shared conventions (THE section that kills repeated instructions — see §7):
   - "Import, never copy" rule + pointer to SHARED_COMPONENTS.md as the authoritative frontend reference
   - The invariant rules that apply to every mode (accents/punctuation never penalized; STT tolerance; Wispr auto-send behavior; audio-first/hover-to-reveal principle; casual register per language; locale/voice map)
   - Where each invariant is implemented (file/function), so changes happen there
   - Rule for agents: "if a requirement should hold across modes, implement it in the shared module and record it here — never inline it in one mode"
6. Data files map (sentence banks, personas, profiles, quiz items, logs — and which are gitignored state vs content)
7. Cost rules (prefer cached/static audio; fuzzy-match before LLM; budget bars)
8. Adding a new mode: checklist (App.tsx + HomeScreen type unions, shared components to use, usage session start, audio pattern decision)
9. Existing "do not implement undiscussed features" rule
```

Keep `SHARED_COMPONENTS.md` as the detailed frontend API reference; CLAUDE.md links to it rather than duplicating. Add a matching short `backend/PROMPTS.md` (or section) documenting the shared prompt fragments once they exist (§7).

---

## 7. Root cause of the repeated-instruction problem

### The instructions you've likely been repeating (reconstructed from copy-pasted code)

1. **Wispr auto-send behavior** ("if pasted text grows by ≥3 chars treat as Wispr, send after 100ms; typed → 1200ms debounce; guard 700ms since last send") — implemented **6 separate times**: `BattleGame.tsx:583`, `GuessingGame.tsx:146`, `StoryCardsGame.tsx:220`, `TriviaGame.tsx:214`, `WordDrillGame.tsx:368`, `trivia2/TriviaGame2.tsx:446`. A shared `GameTextarea` encapsulating exactly this exists (`sharedGameComponents.tsx:186`) — but **only MessengerChat imports it**, and it's not documented in SHARED_COMPONENTS.md.
2. **"Never penalize accents/punctuation/capitalization"** — stated in at least 4 places: the `check_trivia_answer` system prompt (twice within it), the chat-log reviewer header (`game_backend.py:62`), quiz-candidate rules (`game_backend.py:1020`), plus normalization helpers duplicated frontend (`normalizeForMatch`) and backend (`_normalize_for_llm`, `normalize_for_match`, `normalize_answer` — three near-identical functions in the backend alone).
3. **Fuzzy-match-before-LLM** — `checkFuzzyMatch` exists in `sharedGameUtils.ts` yet is re-implemented locally in `BattleGame.tsx:862`, `TriviaGame.tsx:280`, and `trivia2/TriviaGame2.tsx:119`.
4. **Audio fetch/cache/play** — SHARED_COMPONENTS.md literally instructs "maintain your own cache" and provides a snippet to paste; `WordDrillGame.tsx:731`, `TriviaGame.tsx:418`, `MessengerChat.tsx:836`, `StoryCardsGame.tsx:477` each have a variant.
5. **`apiBase` default** (`import.meta.env.VITE_API_BASE_URL || "http://localhost:8000"`) — 9 copies; `UsageDiagnostics.tsx` hardcodes its own. **Locale map** (`es→es-MX` etc.) — repeated in `MessengerChat.tsx:99`, inline in `game_backend.py:271`, `llm_call.py:224`, voice maps in 3+ files (§5).
6. **Global paste-handler** — duplicated in `MessengerChat.tsx:422` and `TriviaGame.tsx:237` (and others) with slightly different input-guard rules.
7. **Backend LLM boilerplate** — the ~30-line "extract text robustly from responses API" block is copy-pasted **5×** in `llm_call.py`; token-usage extraction + hardcoded pricing twice; `_language_style_instruction` duplicated across `llm_call.py` and the legacy pipeline.
8. **Mode registration** — every new mode requires editing the same string-union in 3 places (`App.tsx` twice, `HomeScreen.tsx` once) plus a render block; nothing documents this, so it's re-derived every time.

### Why it happens

- **The authoritative doc teaches duplication.** CLAUDE.md's "Common Mode Features" — the section an agent reads before building any mode — says *copy constants from BattleGame.tsx*. It predates the shared-module extraction and was never updated, so every agent following instructions faithfully reproduces the problem.
- **The shared layer is incomplete and undocumented at the edges.** The two highest-churn behaviors (Wispr auto-send, audio playback) were left as copy-paste snippets in SHARED_COMPONENTS.md instead of exports; `GameTextarea` was later built but never documented, so nothing adopted it.
- **No backend equivalent exists at all.** There is no shared prompt-fragment module — every prompt restates the STT/accent rules from scratch, so any refinement to those rules (which you've clearly iterated on, given how detailed they are) must be re-specified per prompt.
- **No convention says where cross-mode rules live.** When you tell Claude "in trivia, don't penalize accents," there is no designated home for that rule, so it lands inline in trivia. Next mode, same conversation again.

### The fix (specific)

**Frontend (mechanical extraction, then doc):**
1. Promote `GameTextarea` (or extract a `useWisprAutoSend` hook for modes with custom textarea UI) and migrate the 6 duplicates.
2. Add `useAudioPlayer(apiBase)` hook to `sharedGameComponents.tsx` wrapping fetch-cache-play-stop; replace the per-mode copies; delete the copy-paste snippet from SHARED_COMPONENTS.md in favor of the hook.
3. New `frontend/src/config.ts`: `API_BASE`, `LOCALE_MAP`, voice notes. One import everywhere.
4. Delete the local re-implementations of `checkFuzzyMatch`/`normalizeForMatch`/`calculateDistance` in BattleGame/TriviaGame/TriviaGame2 in favor of the shared exports.
5. Document all of the above in SHARED_COMPONENTS.md (it's already the right doc — it just needs `GameTextarea` + `useAudioPlayer` sections and removal of the paste-snippets).

**Backend:**
6. Create `backend/prompt_fragments.py` (or `prompts/fragments/`): `STT_TOLERANCE_RULES`, `ACCENT_PUNCTUATION_RULES`, `LANGUAGE_STYLE[lang]`, `NATURALNESS_EXAMPLES[lang]`. Compose prompts from fragments; a rule refined once applies everywhere.
7. Add `_call_openai_json(prompt, max_tokens, ...)` helper in `llm_call.py` encapsulating client call + text extraction + JSON parse + usage/cost accounting; collapse the 5 copies.

**Docs/process:**
8. Rewrite CLAUDE.md per §6, with the "Shared conventions" section listing each invariant → its single implementation site, and the standing rule: *cross-mode requirements go in the shared module + get one line in the conventions list; never inline them per mode.* That converts "re-specify every time" into "reference once."

---

## 8. Recommended priority order (impact vs effort)

| # | Item | Impact | Effort | Rationale |
|---|---|---|---|---|
| 1 | Fix quiz pipeline (§1.6: `prompt_target`→`quiz_prompt` gate, `ENABLE_QUIZZING` default/env, `is_answered`) | High | **Tiny** | Three-line-scale fixes revive a whole built system |
| 2 | Rewrite CLAUDE.md (+ SHARED_COMPONENTS.md additions) (§6, §7.5/8) | High | Low | Docs-only; immediately stops the repeated-instruction bleed and stops agents copying from BattleGame |
| 3 | Messenger audio defaults + corrected-sentence echo (§2B items 2–3) | High | Low | Biggest listening gain in the most-used mode; mostly flipping flags + one small flow |
| 4 | Number Rush audio generation script + fallback fix (§2D-1/2) | Med-High | Low | Turns a finished mode from placebo into a real listening drill; one-time cost |
| 5 | Frontend dedup: `useAudioPlayer`, `GameTextarea` migration, `config.ts` (§7.1–5) | Med (compounding) | Medium | Prevents future repetition; do before building new modes so they inherit it |
| 6 | Level/profile repair: prune junk weak_points, loosen or manualize level updates, or replace with the immersion dial (§1.5, §2B-1) | High | Medium | Unblocks difficulty for an intermediate learner; dial is the pragmatic path |
| 7 | Audio-first quiz reviews (§4.1–2) | Med-High | Medium | Depends on #1; converts SRS to speaking/listening |
| 8 | Echo mode (§2A) | High | Medium | New mode, but thin if #5 is done first |
| 9 | Listening trivia toggle (§2C) | Med | Medium | Reuses trivia wholesale |
| 10 | Backend prompt fragments + `_call_openai_json` (§7.6–7) | Med | Medium | Quality-of-life; schedule with any backend feature work |
| 11 | Messenger prompt trim / caching order (§9) | Med (cost) | Low-Med | Do alongside any prompt edit |
| 12 | Archive `ChatWithWispr.tsx` + `fastapi_wispr_pipeline.py`; delete or gate experimental modes' claims in docs | Low-Med | Tiny | Reduces confusion for every future session |
| 13 | Indonesian content parity (particles, premade convos) (§5) | Med | Content work | Ongoing |
| 14 | In-conversation quiz elicitation, time-based SRS (§4.3–4) | Med | High | After 7 proves out |

---

## 9. Cost optimization

**Azure TTS (500k chars/month budget, tracked):**
- **Route all TTS through the content-hash cache.** `/api/trivia/audio` and premade chunks use `get_cached_audio_path`; but messenger live audio chunks (`game_backend.py:1379`) and story-cards turns (`save_wav`) generate a *fresh timestamped file per turn* even for identical text. Suggested replies, greetings-style phrases, and short challenge sentences repeat more than you'd think. One change: in the messenger chunk loop, check `get_cached_audio_path(text, locale)` before calling `tts_bytes_for_chunk`.
- **Pre-generate finite banks** (the Number Rush / `generate_battle_audio.py` / `generate_worddrill_audio.py` pattern is exactly right — extend it): trivia sentence banks, quiz item `corrected` phrases, hint texts, and the Echo/listening-trivia content from §2 are all closed sets. Pre-generation shifts cost to a one-time batch you control and makes runtime latency zero. Note the cache-key/voice caveat from §5 before batch-generating.
- **Cache never evicts** — `audio_files/cache/` grows unbounded. Not urgent locally; note it.
- The per-session `audio_files/session_*` / `messenger_*` folders also grow forever and are pure disk waste after playback.

**OpenAI ($10 budget, tracked):**
- **The fuzzy-match fast path is the best pattern in the app** (`check_trivia_answer` top, `check_answer_locally` in quiz) — a correct answer costs $0. Keep pushing checks behind local matching (Echo mode can be ~90% LLM-free).
- **Messenger prompt size is the main spend.** Every turn resends: full system prompt + persona bio/examples/few-shots + student model + schema with long inline comments + CRITICAL reminders (with the naturalness rules stated twice) + v2 block. At 372 turns this dominates. Fixes: (a) deduplicate reminder text; (b) cap `weak_points` (13 junk entries are being resent every turn); (c) exploit **OpenAI automatic prompt caching** — it discounts a repeated prefix ≥1024 tokens, so keep the static layers (system/persona/schema) first and byte-identical across turns, and move *everything* dynamic (context, turn instruction, user input) to the end. Currently the turn instruction and assessment-schema toggling mutate the middle of the message on every 5th turn, which breaks prefix stability at that point — restructure so conditional sections come after all static text.
- **Model tiering**: trivia/word-drill checks and `call_llm_to_pick_secret` are strong candidates for `gpt-4.1-nano`; keep `-mini` for messenger. Model is already env-configurable but global — make per-call-site overrides possible in the `_call_openai_json` helper (§7.7).
- **Truncation waste**: messenger `max_output_tokens=800` → a truncated JSON is a fully-paid, fully-discarded call. Either raise it or shrink required output (drop `user_translation` when `input_intent="spanish"`, move suggestions out).
- **Pricing constants** are hardcoded in two places (`llm_call.py:532,687`) and assume mini rates regardless of `OPENAI_MODEL` — centralize next to the model config so the battery bar stays honest if you switch models.

---

## 10. Reorganization plans (drafts to hand to Sonnet / Opus / Fable)

Ordered so each plan is independently shippable; sized by model tier.

### Plan 1 — Documentation truth pass (Sonnet-sized, no code changes)
Rewrite CLAUDE.md per the §6 outline (mode inventory table, single-backend reality, shared-conventions section with the "import, never copy" rule and invariant→implementation-site list, new-mode checklist, cost rules). Update SHARED_COMPONENTS.md: add `GameTextarea` docs, mark the audio snippet as "to be replaced by useAudioPlayer", remove the BattleGame-copy contradiction. Add `LEGACY` header comments are *not* allowed (analysis-only rule applies to me, not to the plan) — the plan should mark `ChatWithWispr.tsx`/`fastapi_wispr_pipeline.py` as legacy in CLAUDE.md's inventory. Acceptance: a fresh agent reading only CLAUDE.md can name the active modes, the one backend, and where every cross-mode rule lives.

### Plan 2 — Quick correctness fixes (Sonnet-sized)
(1) `game_backend.py:1452` gate → `candidate.get("quiz_prompt") or candidate.get("prompt_target")`; (2) decide and set `ENABLE_QUIZZING` explicitly in `.env`; (3) remove the `is_answered` flip-flop; (4) prune/cap `weak_points` on write in `update_profile_from_assessment`; (5) messenger TTS chunks → cache path. Each verified by driving a messenger turn in MOCK_MODE=0-with-test-keys or via targeted unit checks.

### Plan 3 — Frontend shared-layer consolidation (Opus-sized, mechanical but wide)
Create `config.ts`; add `useAudioPlayer` + (if needed) `useWisprAutoSend`; migrate all 6 auto-send duplicates and 4+ audio duplicates; delete local `checkFuzzyMatch`/`normalizeForMatch`/`calculateDistance` re-implementations; consider a `MODES` registry object consumed by both `App.tsx` and `HomeScreen.tsx` to collapse the 3-place union-type edit. High file-count, low ambiguity; needs careful per-mode behavior preservation (each duplicate has small drift — diff before deleting). Verify each mode's send/audio behavior manually after migration.

### Plan 4 — Backend modularization (Opus/Fable-sized)
Split `game_backend.py` (1990 lines) into routers: `routers/messenger.py`, `routers/quiz.py`, `routers/checks.py` (trivia/battle/worddrill), `routers/audio.py`, `routers/misc.py`, with `main.py` assembling the app. Extract `prompt_fragments.py` and `_call_openai_json` (§7.6–7); move messenger prompt assembly into `prompts/` alongside its templates; centralize `VOICE_MAP`/pricing/locale constants in `settings.py`. Restructure the messenger prompt for cache-friendly static-prefix ordering (§9) in the same pass since it touches the same code. Riskiest plan — needs regression passes over every mode; do after Plans 1–3 so the docs and conventions exist to guide it.

### Plan 5 — Speaking/listening feature wave (Fable-sized, feature design + build)
The §2/§4 items in priority order: messenger audio defaults + say-it-back → Number Rush audio script → audio-first quiz → Echo mode → listening trivia. Each reuses infrastructure hardened in Plans 2–4. This plan should *start* from the shared-conventions section of the rewritten CLAUDE.md — which is the whole point of the reorganization.

---

## 11. Adaptive comprehension load — solving "don't overwhelm the user" *(added 2026-07-12)*

This section refines §1.1 and §2B (the immersion dial). The messenger's English-majority responses are a deliberate scaffold: the learner is already producing Spanish, so keeping the character's output mostly English caps total cognitive load, with one Spanish challenge sentence as the stretch. That's sound. The weakness is that the scaffold is **frozen** — same ratio on turn 1 and turn 372, for a beginner and for you. The goal is to make the *same design* breathe: assess comprehension continuously and let the English↔Spanish ratio fluctuate around the learner's edge.

### 11.1 Reframe: overwhelm = density × difficulty − safety nets

A Spanish sentence only "overwhelms" when not understanding it is costly (lost thread, embarrassment, dead end). The app already has safety nets that bound that cost to a hover: the v2 challenge card reveals the English on demand, audio replays on hover, and suggested replies rescue a stuck turn. **Every additional safety net buys headroom to raise the Spanish ratio.** So the strategy has two dials, not one: (a) raise recovery affordances (make *every* Spanish chunk hover-revealable, not just the challenge), then (b) push density adaptively. A learner who can always bail out cheaply tolerates far more target language than a fixed "safe" ratio assumes.

### 11.2 Assessment signals — how to know if the user is coping

Ranked by cost and reliability. The key principle: **measure comprehension behaviorally, don't ask the LLM to guess it.** The current every-5th-turn `level_assessment` failed (§1.5) partly because it asks the model to infer level from text alone. The signals below are mostly free and mostly deterministic.

**Tier 1 — free, piggybacks on the existing LLM call (add fields to the messenger schema):**
- **`challenge_understood`** — the v2 challenge is usually a question; on the *next* turn, the LLM already sees the last 3 turns of context, so ask it one extra boolean: "did the user's reply coherently address the previous Spanish challenge?" This is the single best signal in the app — answering a Spanish question proves the Spanish was understood — and it costs ~zero tokens.
- `had_errors` rate and `input_intent` mix over a rolling window (already stored in `recent_turns`): a user attempting Spanish on most turns with a falling error rate is under-challenged; a user retreating to English (`input_intent: "english"` streaks) is over-challenged.
- User output complexity — words per message, presence of subordinate clauses — computable locally or as one more cheap LLM field.

**Tier 2 — free, behavioral, frontend-only (currently generated but thrown away — start sending them with the next `/api/messenger/turn` request):**
- **Native-text reveals**: did the user hover "Show English" on the challenge card, and how fast? `MessengerChallengePair` already tracks this state (`pinned`/`hovered`) — it just never reports it. Revealing English within ~2s of the bubble appearing ≈ "didn't even try"; never revealing + replying on-topic ≈ full comprehension. This is the behavioral ground truth for receptive load.
- **Audio replay count** on the challenge card (the hover-loop already counts plays internally via `playOnce`) — 1 play = comfortable, 4+ = at the edge (which is *fine* — that's productive struggle — but 4+ *plus* a reveal *plus* an off-topic reply = overwhelmed).
- **Response latency** (time from last chunk revealed → user starts typing) and **suggested-reply crutch rate** (clicked chip vs free-typed; `pendingSuggestionRef` already distinguishes these).

**Tier 3 — explicit but ultra-cheap:**
- A tiny **😕 reaction** on Spanish bubbles ("didn't catch that") — one tap, in-fiction (messengers have reactions), and doubles as a UX affordance: tapping it could make the character naturally rephrase easier ("jaja sorry, I mean...") *in character*, which is itself great comprehensible input.
- Occasional micro-checks: once every ~10 turns the character's English chunk asks a casual comprehension question about its own previous Spanish ("wait, did you get what I said about the market? 😏").

### 11.3 The mechanism: a comprehension meter + deliberate fluctuation

**Meter (deterministic, backend, not LLM):** add `comprehension_meter: 0–100` to the profile. Each turn, update it with a small weighted step from the signals above (e.g. challenge understood & no reveal: +4; understood after reveal: +1; reveal within 2s: −3; 😕 reaction: −5; English-retreat streak: −4), clamped, with slow decay toward 50 during inactivity. Rolling and incremental, so one bad turn never cliff-drops the experience. This replaces the inert `level` field as the thing that actually drives difficulty (keep `level` as a coarse label derived *from* the meter for display).

**Ratio ladder:** map meter bands to concrete chunk recipes — this drops straight into `generate_turn_instruction` as the per-turn mix line, expressed in the `response_chunks` schema the LLM already follows:

| Rung | Meter | Character's turn looks like |
|---|---|---|
| 1 | 0–25 | All English + 1 short Spanish audio challenge with English lead-in context (current v2, easier) |
| 2 | 25–45 | English reaction + 1 Spanish challenge (current v2 default) |
| 3 | 45–65 | English reaction + **2** Spanish chunks (a statement *and* the question), both hover-revealable |
| 4 | 65–85 | Spanish-majority: Spanish statement(s) + Spanish question; **one** short English aside for flavor/glue |
| 5 | 85–100 | Full Spanish; English exists only behind hover-reveals |

**Fluctuation, not a fixed setpoint — your instinct here is right, and there's a principled version of it.** Instead of always emitting the rung the meter points at, sample each turn from a band around it: mostly the current rung, ~25% one rung easier, ~15% one rung harder ("surge turns"), never two hard turns in a row. Why this beats a constant ratio:

1. **Contextual bootstrapping** — an easy turn establishes topic and vocabulary that make the following hard turn comprehensible from context alone. A hard sentence about a topic scaffolded 2 turns ago in English is dramatically easier than the same sentence cold. The wave *is* the scaffolding.
2. **Recovery keeps affect positive** — a tough turn followed by a comfortable one reads as "that was a hard moment" rather than "this got too hard," which is the difference between challenge and overwhelm.
3. **Surge turns are the probe** — the harder-than-usual turns are exactly where Tier-2 signals are most informative; the system learns the ceiling by occasionally touching it, without living there.
4. It prevents habituation to a fixed format (the current always-2-chunks v2 shape is very predictable — the user learns to skim the English and wait for the pattern).

**Guardrails:** hard floor/ceiling per user; the §2B manual dial becomes an *override* on top of auto mode (auto by default, user can pin a rung — respect it and keep metering silently); dial-downs are never announced (no "let's make this easier for you" — the character just naturally uses more English); and per-message, keep the shape "comprehensible frame first, stretch content last," which is exactly the structure the current design already has — the ladder just moves the boundary.

**Implementation cost:** small, and it reuses the broken plumbing rather than adding parallel systems — the meter lives where `level` lives, the recipe line replaces the static language-mix paragraph in `chat_system_prompt.txt`/`generate_turn_instruction`, the frontend adds ~4 fields to the turn request body, and `challenge_understood` is one schema field. The one genuinely new frontend task is instrumenting reveal/replay events in `MessengerChallengePair` and generalizing the hover-reveal card to all Spanish chunks (prerequisite for rungs 3–5). Sequencing: this slots in as priority item **6** in §8 (replacing/absorbing the manual-only immersion dial).

---

## 12. Distribution, monetization & marketing *(added 2026-07-12)*

### 12.0 Honest prerequisites — what must be true before anyone else can use this

Right now the app is architecturally single-user and locally hosted. Before any strategy below applies:

1. **Multi-tenancy** — one global `default_profile.json`, one quiz file, in-memory session dicts, and world-writable chat logs. Needs accounts + per-user storage (SQLite/Postgres) and a hosted backend. This is the biggest single chunk of work on the list.
2. **Replace the Wispr dependency with in-app STT.** "Install a third-party desktop dictation tool, then paste into my textarea" is a near-total adoption blocker — and it doesn't exist on mobile at all. The good news: this is *also* the biggest UX upgrade available. Browser `SpeechRecognition` (Web Speech API) is free and works well for es/id on Chrome/Android; native iOS/Android speech APIs are free in a wrapped app; OpenAI/Azure STT (~$0.3–0.6/hr of audio) as fallback. The clipboard auto-send heuristics (§7.1) get replaced by a mic button — genuinely simpler than what exists.
3. **Per-user cost controls.** Rough unit economics at current usage patterns: a messenger turn ≈ 0.1–0.3¢ LLM + ~0.1–0.3¢ TTS (uncached). A heavy user (50 turns/day) ≈ **$3–6/month in API costs**; a typical active user well under $2. The Azure 500k-chars free tier doesn't extend to your users — budget paid tiers, which makes the §9 caching/pre-generation work directly margin-relevant. These numbers mean: subscriptions work, one-time purchases and ads don't.
4. Basic table stakes: rate limiting, content moderation on LLM output, privacy policy (you're storing learner conversations), key security (keys move fully server-side — already true).

### 12.1 Distribution: web vs mobile

Your instinct that mobile has bigger reach is right for *this* product specifically — language practice is a phone activity (commutes, queues, couches), speaking practice needs a mic in hand, and SRS/streak mechanics need push notifications. But "mobile app" isn't one choice:

| Path | What it is | Pros | Cons |
|---|---|---|---|
| **A. Web app / PWA** (current + installable) | Keep React web, add auth, make it responsive, PWA manifest | Zero new codebase; no store fees or review; ship fixes hourly; mic + push both work on modern Android and iOS (16.4+, when installed); links are shareable = marketing-friendly | Discoverability (no store presence); iOS PWA install flow is obscure; Web Speech API quality varies by browser; "install from browser" loses mainstream users |
| **B. Hybrid wrapper** (Capacitor around the existing React app) | Same codebase shipped to App Store/Play Store | ~90% code reuse; real store presence + reliable push + native STT plugins; the realistic "mobile app" for a solo dev | Store fees (15% small-biz tier) and review friction; some native plumbing (STT, audio session handling); app-store subscription rules |
| **C. Native / React Native rebuild** | New mobile codebase | Best mic/audio UX and latency | Full rewrite of 20k+ lines of UI; not justified before product-market fit |

**Recommendation: A → B, in that order.** Ship the multi-user web/PWA version first — it's the cheapest way to learn whether strangers retain — then wrap with Capacitor once retention looks real. Skip C unless the app takes off. Note the interaction model needs a mobile pass regardless: the hover-to-reveal pattern that's central to the UX (challenge cards, hint cards, history entries) **has no hover on touch screens** — everything hover-based needs a tap-to-toggle equivalent. That's a real, non-trivial design task hiding inside "make it mobile."

### 12.2 Monetization models, ranked

1. **Freemium subscription** — free tier capped by usage (e.g. 15 messenger turns/day + unlimited zero-API-cost modes — Number Rush and anything pre-generated/static is *free for you to serve*, a genuinely useful quirk of your architecture); premium ~$6–10/mo for unlimited conversation, all personas, audio-first quiz, both languages.
   *Pros:* matches your marginal-cost structure; the free tier is a real product (static-audio modes) not a crippled demo; standard, understood model.
   *Cons:* needs payment infra + entitlement logic; subscription fatigue; must continuously justify renewal.
   **Best fit — this is the model the economics force.**
2. **Bring-your-own-API-key tier** — free (or one-time ~$15) app where power users paste their own OpenAI/Azure keys; paid subscription = "we handle the keys + sync + polish."
   *Pros:* zero cost risk while validating; the language-learning-nerd early-adopter crowd (exactly who's on r/languagelearning) loves BYO-key; converts naturally into tier 1 later.
   *Cons:* tiny mainstream appeal; key UX is fiddly; caps revenue.
   **Good as the *bridge* model during beta, not the destination.**
3. **B2B: tutors and small schools** — tutors assign SpeakRight practice between lessons; dashboard shows the chat logs/correction history (which you already generate for self-review — `chat_log_es.md` is accidentally a tutor-facing artifact).
   *Pros:* one sale = many seats; tutors solve your marketing; willingness to pay is higher and churn lower.
   *Cons:* needs dashboards/seat management; sales takes founder time; premature before the consumer product is stable.
   **Strong phase-3 option; keep it in mind when designing accounts.**
4. **One-time purchase / lifetime deal** — *Pros:* simple, appeals to subscription-haters; AppSumo-style lifetime deals can fund development. *Cons:* you pay their API costs forever; only viable paired with BYO-key or harsh caps. Use, at most, as a limited early-supporter offer.
5. **Ads** — *Cons dominate:* low CPMs, destroys the conversational immersion that is the product, and ad SDKs are the opposite of the calm UX. **Avoid.**

### 12.3 Marketing strategies, ranked

1. **Demo-video content + build-in-public** (TikTok/Reels/Shorts, X, r/SideProject). The product is unusually *visual* for a language app: the red/green correction diff appearing on your own sentence, the persona chat with a Spanish audio bubble, hover-revealing the translation — 15-second clips sell themselves. Cost: time only. This also compounds: the audience arrives pre-warmed for launch.
2. **Own the Indonesian niche.** Spanish-learning is a red ocean (Duolingo, Pimsleur, and the AI-convo apps — TalkPal, Langua, Speak — are your real competitors). **Casual Indonesian is nearly empty**: almost nothing teaches `deh/sih/kok/dong` register, and the learner community (r/indonesian, expat/Bali forums, partners of Indonesians) is underserved and concentrated. Being *the* speaking app for casual Indonesian is achievable in months; being noticed for Spanish is not. Lead marketing with Indonesian, let Spanish be the "also supports" upsell — even though Spanish is your personal primary.
3. **Community seeding in comprehensible-input circles** — Dreaming Spanish's community, CI-method subreddits and Discords. §11's fluctuating-input design *is* a CI story ("input that adapts to your edge, sentence by sentence") and that community evangelizes tools that match their ideology. Honest participation, not spam: share the approach, ask for beta testers.
4. **SEO from your own data** — the correction logs are a content mine: "Why 'me hace sentir gaseoso' is wrong and what natives say instead" is a page type you can produce dozens of (from anonymized/own logs), each targeting long-tail "how do you actually say X in Spanish/Indonesian" queries that convert perfectly to this product. Slow burn, high fit.
5. **Launch moments** — Product Hunt / Hacker News (the BYO-key + build-in-public angle plays well on HN) once onboarding survives strangers. One-day spikes; useful for backlinks and first cohort, not a strategy.
6. **Paid ads** — only after retention is proven (D7/D30 known), else you're buying churn. Last.

### 12.4 Recommended sequence

1. **Now → validation (free):** keep daily-driving it yourself; instrument the §11 signals (they double as retention analytics later); do the §8 fixes so the product you eventually show is the good one. Start posting build-in-public clips *now* — the audience takes longest to grow.
2. **Phase 1 — hosted web beta:** multi-tenancy + in-app STT (Web Speech API) + usage caps; invite 20–50 users from the communities above, BYO-key or free-capped. The only question this phase answers: *do strangers come back in week 2?*
3. **Phase 2 — freemium PWA launch:** Stripe, free tier = capped turns + static-audio modes, premium ~$8/mo. Indonesian-led marketing push (strategies 1–3).
4. **Phase 3 — Capacitor mobile app** on Play Store first (cheaper review, better Web Speech support, Indonesian-learner demographics skew Android), then iOS. Add push-driven SRS reviews — the quiz system (§4) finally becomes the retention engine it's designed to be.
5. **Phase 4 — tutor/B2B tier** if consumer retention is proven.

The through-line: **every phase reuses the cost discipline you've already built** (usage tracker, fuzzy-match fast paths, audio caching, static-audio modes). Those aren't just savings — they're what makes a free tier affordable, and the free tier is the marketing.

---

## Appendix: notable bugs found along the way (not fixed, per instructions)

| Location | Issue |
|---|---|
| `game_backend.py:1452` | Quiz candidates gated on `prompt_target`, schema emits `quiz_prompt` → candidates never stored |
| `game_backend.py:32` | `ENABLE_QUIZZING` defaults False — quiz schema never requested by default |
| `game_backend.py:771,790` | `is_answered` set True then immediately False |
| `NumberRush.tsx:65` + `frontend/public/` | Required `number_audio/` static files absent; no generation script; digit fallback (`NumberRush.tsx:583`) makes it a visual game |
| `profiles/default_profile.json` | Level never updated in 372 turns; `weak_points` accumulates junk incl. `"punctuation"` (contradicts app rules) with no pruning |
| `tts_helpers.py` vs `scripts/generate_*.py` | Conflicting default voices (Gadis vs Ardi for id-ID); voice not part of audio cache key |
| `llm_call.py:532,687` | Pricing constants hardcoded twice, not tied to actual model |
| CLAUDE.md | Multiple factually wrong statements (two-backend model, reachable modes, CORS, model name, "copy from BattleGame") — see §6 |
