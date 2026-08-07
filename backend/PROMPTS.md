# Prompt architecture

## The rule

**Cross-feature prompt rules live in `prompt_fragments.py` — edit there, never
inline.** If you're asked to change a rule that should hold across modes
("don't penalize accents in trivia", "be more casual in Indonesian"), change
the fragment; every consumer picks it up.

## Fragment map (`prompt_fragments.py`)

| Fragment | What it says | Used by |
|---|---|---|
| `language_style_instruction(lang_code)` | Casual register per language (Latin-American/Mexican Spanish; everyday Indonesian) | Story cards `_make_prompt`, `check_trivia_answer` |
| `NEVER_PENALIZE_ACCENTS_RULE` | Never mention/penalize accents, punctuation, capitalization | `check_trivia_answer` (trivia/battle/worddrill/quiz checks) |
| `STT_TOLERANCE_RULE` | Wispr speech-to-text mishearing patterns → `asr_error`, full credit | `check_trivia_answer` |
| `UNNATURAL_PHRASING_RULE` | When `unnatural_phrasing` may (and may not) be flagged | `check_trivia_answer` |
| `quiz_candidate_rules(ui, target)` | What counts as a quiz-worthy error (no accents/typos/punctuation) | Messenger prompt (only when `ENABLE_QUIZZING=1`) |
| `STORY_CARDS_RULES` | Story-cards output rules (one sentence, natural translation, audio chunk order) | Story cards `_make_prompt` |
| `CHAT_LOG_REVIEWER_INSTRUCTIONS` | Header of `chat_log_{lang}.md` telling a human reviewer what to check | `chat_log.get_log_file` |

The messenger naturalness rule (false cognates, "gaseoso") is stated once,
inline in the `had_errors` schema comment in `prompts/messenger_prompt.py` —
deliberately not duplicated as a reminder bullet.

## Messenger prompt layout (`prompts/messenger_prompt.py`)

One `responses.create` call per turn; wire string = `static_prefix + "\n\n" +
dynamic_tail`. OpenAI automatically discounts a repeated prefix ≥1024 tokens,
so the split is the cost model:

**STATIC PREFIX** — byte-identical across turns for a fixed run config
(persona + language pair + `ENABLE_QUIZZING` + `prompt_version`):
1. `prompts/chat_system_prompt.txt` (with language names filled)
2. Persona block (from `prompts/persona/sombongo.json`)
3. Full OUTPUT SCHEMA — `level_assessment` is always *described* here but
   annotated "include ONLY when the turn instruction asks"; `quiz_candidates`
   present only when `ENABLE_QUIZZING=1` (process-constant, so still static)
4. CRITICAL REMINDERS
5. QUIZ CANDIDATE RULES (env-conditional)
6. SUGGESTION GENERATION RULES (version-conditional: eyes-free replaces the
   whole section with "emit `[]`" rather than contradicting it later)
7. V2 CHALLENGE FORMAT (version-conditional; v1/v2 share 1–6)
8. EYES-FREE FORMAT (version-conditional; last, so it overrides everything)

**Prompt profiles** (`PROMPT_VERSIONS` in `prompts/messenger_prompt.py`) —
`v1` standard, `v2` challenge-last-sentence (the UI default), `eyesfree`
screen-off. Each gets its own static prefix and therefore its own prompt-cache
entry; `normalize_prompt_version()` maps anything else onto `v1` so a typo in a
request can't mint a fourth entry. `eyesfree` exists because the turn becomes a
strictly serial audio stream — voicing v1/v2 output is ~40s per turn, so the
profile caps the reply at one reaction opener plus one ≤12-word target sentence,
suppresses `suggested_replies` entirely, and requires `error_explanation` to be
one short *spoken* sentence. Keeping chunk 0 the pre-generated reaction opener
also keeps English TTS out of the loop (~4–5× the Azure characters).

**DYNAMIC TAIL** — everything that changes per turn:
8. Student model (level, comfortable/weak/avoid lists — mutable)
9. `CURRENT SCENE` (task 5.1; `prompts/templates/scene.txt`) — omitted entirely
   when no scene is active, so a sceneless profile produces the pre-5.1 tail
10. Conversation context (last 3 turns)
11. Turn instruction (regular vs every-5th-turn assessment; v2 adds a one-line
    challenge-format reminder — without it the model drops the v2 format)
12. `SCENE PACING` — "turn N of M" plus what to do about it (open / push /
    set up the ending / resolve now). Deliberately the *last* directive before
    the input: the final-turn "resolve now" is the one line that must not get
    buried. Omitted with the scene block.
13. `CURRENT USER INPUT`
14. "Return ONLY valid JSON"

**The scene never touches the static prefix.** It reads like setup, which is
exactly why it's tempting to put it there — but a new scene every 5–10 turns
would mint a new cache prefix every 5–10 turns. Scene *length* is likewise
decided by the router's turn budget rather than a `scene_complete` field, so the
output schema stays static too. `test_prompt_snapshot.py` asserts both
directions: scene content appears in the tail and appears nowhere in the prefix.

**Invariant: never insert per-turn content before the student-model section.**
`tests/test_prompt_snapshot.py` enforces prefix stability (identical static
prefix across profiles/turn-counts, v2 extends v1, prefix > 5000 chars) plus
golden-file snapshots of the full wire string. If you deliberately change the
prompt, delete `tests/goldens/` and re-run pytest twice to re-baseline — and
say so in the commit message.

The messenger router (`routers/messenger.py`) defensively drops
`level_assessment` on non-assessment turns and `quiz_candidates` when quizzing
is off, since the schema now always describes them.
