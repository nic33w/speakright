# Shared Game Components

Reference for building new game modes. Import everything from these files.

```ts
import { /* components */ } from "./sharedGameComponents";
import { /* hooks */ }      from "./sharedGameHooks";
import type { /* types */ } from "./sharedGameUtils";
import { /* utils/constants */ } from "./sharedGameUtils";
import { API_BASE, LOCALE_MAP, localeFor } from "./config";
```

Hooks live in `sharedGameHooks.ts` rather than alongside the components because
Fast Refresh requires a component file to export only components.

---

## Components — `sharedGameComponents.tsx`

### `<FeedbackBadges issues={...} small? />`

Renders a row of colored feedback pills with explanations. Use in both the live feedback area (after submit) and inside history entries.

```tsx
<FeedbackBadges issues={feedbackIssues} />
<FeedbackBadges issues={feedbackIssues} small />  // compact, for sub-sections
```

`issues` is `FeedbackIssue[]`. Each issue has `feedbackKey`, optional `correctedSnippet`, optional `feedbackExplanation`. The component looks up color/label/fallback text from the shared constants automatically.

---

### `<CorrectionTokens tokens={...} small? wrapped? />`

Renders a correction diff. Removed words in red strikethrough, added words in bold green, unchanged in dim white.

```tsx
<CorrectionTokens tokens={correctionTokens} />             // with background container
<CorrectionTokens tokens={correctionTokens} wrapped={false} />  // inline, no container
<CorrectionTokens tokens={correctionTokens} small wrapped={false} />
```

`tokens` is `CorrectionToken[]` — each token has `text` and `status: "ok" | "remove" | "add"`.

The backend returns `correction_tokens` from `/api/worddrill/check` and `/api/battle/check`. After receiving them, call `restoreAccentsInTokens(tokens, acceptedTranslations, langCode)` before passing to this component (the LLM strips accents; this restores them from the accepted translations list).

---

### `<GameTextarea value={...} onChange={...} onSubmit={...} ... />`

The standard input control: Wispr auto-send timing, Enter-to-submit, Escape-to-cancel, focus management. Use this instead of a bare `<textarea>` for any new mode, and migrate a mode's hand-rolled version to this when you touch it.

```tsx
<GameTextarea
  value={input}
  onChange={setInput}
  onSubmit={handleSubmit}
  busy={busy}                    // disables input, shows busyLabel
  disabled={answerStatus === "correct" || answerStatus === "skipped"}
  placeholder="Type your answer…"
  submitLabel="Send"
  busyLabel="Checking…"
  theme="dark"                   // or "light"
  autoFocus
/>
```

**Auto-send behavior:** delegated to `useWisprAutoSend` (see Hooks below) — a ≥3-char paste opens a ~1.5s cancelable window, then submits; typing never auto-sends. Enter (without Shift) submits immediately; Shift+Enter inserts a newline; Escape cancels a pending auto-send and clears the text.

`MessengerChat.tsx` uses this component. The other modes keep their own textarea markup (timers, skip buttons, custom countdowns) but all call `useWisprAutoSend` — so the timing lives in exactly one place. Use `GameTextarea` for a new mode unless you need custom chrome; if you do, call the hook rather than re-deriving the timing.

---

### `<HintCards hints={...} viewedHints={...} onReveal={...} onPlayAudio={...} onStopAudio={...} />`

Scrollable row of 130px hint cards. Proximity glow on the nearest unrevealed card as the mouse approaches. Hover the "Aa" button to reveal the learning text. Hover the 🔊 button to play audio.

```tsx
<HintCards
  key={currentSentence.id}       // reset on sentence change
  hints={currentSentence.hints ?? []}
  viewedHints={viewedHints}      // Set<number> of revealed indices
  onReveal={idx => setViewedHints(prev => new Set([...prev, idx]))}
  onPlayAudio={text => void audio.play(text, learningLocale)}
  onStopAudio={audio.stop}
/>
```

Returns `null` when `hints` is empty — safe to always render.

Pass hints as `valid_phrases` when calling the check API so the LLM doesn't flag hint words as wrong:

```ts
body: JSON.stringify({
  ...
  valid_phrases: (currentSentence.hints ?? []).map(h => h.learning).filter(Boolean),
})
```

---

### `<HistoryLogEntry entry={...} ... />`

Self-contained history log entry. Manages expand/pin/audio/preview state internally. Always pass a unique `key` — do not reuse instances across entries.

**Behavior:**
- Hover → plays audio of `entry.correctAnswer` (pre-warmed on mount), expands after 250ms
- Click → toggles pin (stays expanded when mouse leaves)
- Collapsed: status icon + quality bar + hints bar + optional label + English prompt + answer
- Expanded: Sentence (with hint highlighting) → You Said (with example diffs) → Feedback → Previous Attempts

**Props:**
```tsx
<HistoryLogEntry
  key={entry.entryId}
  entry={sharedEntry}                  // SharedHistoryEntry — see type below
  wrongAttempts={wrongAttempts}        // SharedHistoryEntry[] of prior wrong attempts
  apiBase={apiBase}                    // defaults to API_BASE from config.ts
  locale={learningLocale}              // localeFor(activeLearning.code)
  hideTargetText={!showTargetText}     // hides answer text; user hears audio only
  promptLabel={<>🟢 [word]</>}        // optional JSX shown above sentence when expanded
  extraBottom={<BotResults />}        // optional JSX after Previous Attempts
/>
```

**Mapping your entry type to `SharedHistoryEntry`:**

```ts
function toSharedEntry(e: YourEntry): SharedHistoryEntry {
  return {
    entryId: e.id,
    isWrongAttempt: e.isWrongAttempt,
    skipped: e.skipped,
    qualityScore: Math.round(e.multiplier * 100),  // 0–100
    llmUsed: e.llmUsed,
    allHints: e.hints ?? [],
    hintsUsed: viewedHints.size,
    hintsRevealedIndices: Array.from(viewedHints),  // store when creating entry
    promptText: e.english,           // the English sentence
    userAnswer: e.userAnswer,
    correctAnswer: e.accepted_translations[0],
    acceptedTranslations: e.accepted_translations,
    correctionTokens: e.correctionTokens,
    feedbackIssues: e.feedbackIssues,
    feedbackKey: e.feedbackKey,
    correctedSnippet: e.correctedSnippet,
    feedbackExplanation: e.feedbackExplanation,
    extraLabel: e.category,          // optional right-aligned label in collapsed header
  };
}
```

**History panel wiring (standard pattern):**

```tsx
// State
const [history, setHistory] = useState<YourEntry[]>([]);
const historyEndRef = useRef<HTMLDivElement>(null);
const [showTargetText, setShowTargetText] = useState(false);

// Auto-scroll
useEffect(() => {
  historyEndRef.current?.scrollIntoView({ behavior: "smooth" });
}, [history.length]);

// Filter resolved wrong attempts
const resolvedIds = new Set(history.filter(e => !e.isWrongAttempt).map(e => e.sentenceId));

// Panel header — include this toggle button
<button onClick={() => setShowTargetText(s => !s)} style={{
  padding: "4px 10px", fontSize: 12, fontWeight: 600, borderRadius: 6,
  cursor: "pointer", border: "1px solid",
  background: !showTargetText ? "rgba(251,191,36,0.2)" : "rgba(255,255,255,0.08)",
  borderColor: !showTargetText ? "rgba(251,191,36,0.5)" : "rgba(255,255,255,0.2)",
  color: !showTargetText ? "#fbbf24" : "rgba(255,255,255,0.6)",
}}>
  {!showTargetText ? "🔇 Audio only" : "👁 Show text"}
</button>

// Render
{history.map(entry => {
  if (entry.isWrongAttempt && resolvedIds.has(entry.sentenceId)) return null;
  const wrongAttempts = !entry.isWrongAttempt
    ? history.filter(e => e.sentenceId === entry.sentenceId && e.isWrongAttempt).map(toSharedEntry)
    : [];
  return (
    <HistoryLogEntry
      key={entry.entryId}
      entry={toSharedEntry(entry)}
      wrongAttempts={wrongAttempts}
      apiBase={apiBase}
      locale={learningLocale}
      hideTargetText={!showTargetText}
    />
  );
})}
<div ref={historyEndRef} />
```

---

## Hooks — `sharedGameHooks.ts`

### `useAudioPlayer(apiBase?)`

Fetch → cache → play → stop for TTS audio. Replaces the per-mode audio cache every mode used to hand-roll.

```tsx
const audio = useAudioPlayer(apiBase);

await audio.play(text, locale);   // fetch (cached by `locale:text`) + play
await audio.playUrl(url);         // play a URL the backend already gave you
audio.prefetch(text, locale);     // warm the cache so first play is instant
audio.stop();                     // halt playback
```

- `play`/`playUrl` resolve **`true`** when the clip ran to completion and **`false`** when `stop()` cut it short (or the fetch failed). Chain follow-on state off the boolean — `if (await audio.play(t, l)) advance()` — so a stop never fires it. Awaiting them in a loop plays clips in sequence.
- Both stop this player's current audio first.
- **One player per component instance.** Each instance only stops its own audio, so a hover-preview player and a turn-playback player coexist without cutting each other off (this is why `MessengerChallengePair` has its own).
- Audio stops automatically on unmount.

### `useWisprAutoSend({ value, onSubmit, disabled?, windowMs? })`

The single implementation of Wispr auto-send. `GameTextarea` wraps it; modes with their own textarea UI call it directly.

```tsx
const autoSend = useWisprAutoSend({
  value: transcript,
  onSubmit: () => void submitAnswer(),
  disabled: busy || answerStatus !== "idle",
});

<textarea
  value={transcript}
  onChange={e => setTranscript(e.target.value)}
  onKeyDown={e => {
    if (e.key === "Escape") { autoSend.cancel(); setTranscript(""); autoSend.resetLength(); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); autoSend.submit(); }
  }}
/>
{autoSend.pending && <AutoSendBar progress={autoSend.progress} />}
```

Returns `{ pending, progress, cancel, submit, notifySent, resetLength }`:

| Member | Use |
|---|---|
| `pending` / `progress` | Drive `<AutoSendBar>` (or your own countdown). `progress` runs 1 → 0. |
| `submit()` | Manual send (Enter / button). Pre-empts a pending window and records the guard. |
| `cancel()` | Drop a pending send (Esc, timer expiry, question ended). Does not clear text. |
| `notifySent()` | Call when a send happens outside the hook, so the 700ms guard still applies. |
| `resetLength()` | Call after clearing the input, so the next paste isn't measured against a stale length. |

**Behavior:** a `value` growth of ≥3 chars in one update (a paste — i.e. Wispr dictation) opens a ~1.5s cancelable window, then calls `onSubmit(value)`. Typing never auto-sends. A send within the last 700ms suppresses the next auto-send. `windowMs` accepts a number or `(value) => number` to vary the window — `WordDrillGame` and `TriviaGame2` shorten it to 1000ms when the answer already fuzzy-matches. Don't pass it without that kind of reason.

### `<AutoSendBar progress={...} theme? />` *(in `sharedGameComponents.tsx`)*

The countdown bar + "Esc to cancel" hint. Render only while `autoSend.pending`. `theme="light"` for white UIs.

---

## Config — `config.ts`

```ts
API_BASE              // VITE_API_BASE_URL or http://localhost:8000
LOCALE_MAP            // { es: "es-MX", id: "id-ID", en: "en-US" }
DEFAULT_LOCALE        // "es-MX"
localeFor(langCode)   // code → locale, falling back to Spanish
```

Use `apiBase = API_BASE` as the prop default and `localeFor(code)` for locales. Don't re-declare either inline — that duplication is what this module exists to end.

---

## Types — `sharedGameUtils.ts`

```ts
type HintItem       = { native: string; learning: string; note?: string }
type CorrectionToken = { text: string; status: "ok" | "remove" | "add" }
type FeedbackIssue  = { feedbackKey: string; correctedSnippet?: string | null; feedbackExplanation?: string | null }

type SharedHistoryEntry = {
  entryId: string
  isWrongAttempt: boolean
  skipped: boolean
  qualityScore?: number          // 0–100
  llmUsed?: boolean
  allHints: HintItem[]
  hintsUsed: number              // count of revealed hints
  hintsRevealedIndices?: number[] // indices of revealed hints (store when creating entry)
  promptText: string             // English sentence
  userAnswer: string
  correctAnswer: string
  acceptedTranslations?: string[]
  correctionTokens?: CorrectionToken[] | null
  feedbackIssues?: FeedbackIssue[] | null
  feedbackKey?: string | null
  correctedSnippet?: string | null
  feedbackExplanation?: string | null
  extraLabel?: string            // optional right-aligned label in collapsed header
}
```

---

## Utility Functions — `sharedGameUtils.ts`

### `checkFuzzyMatch(userAnswer, accepted[], langCode)`
Fast local check before calling the LLM. Returns the matched accepted translation or `null`. Always try this first — if it matches, skip the API call entirely. Used by `BattleGame`, `TriviaGame`, `TriviaGame2`, and `WordDrillGame`; it is the only fuzzy matcher — don't write another.

### `normalizeForMatch(text, langCode)`
Lowercases, strips accents, turns dashes and punctuation into spaces, drops anything left that isn't printable ASCII, then removes all whitespace. Used internally by `checkFuzzyMatch`. Deliberately aggressive: a match must never hinge on accents, punctuation, or spacing.

### `restoreAccentsInTokens(tokens, acceptedTranslations, langCode)`
Call this on correction tokens returned by the LLM before rendering. The LLM strips accents; this restores them by matching against the accepted translations list.

### `tokenizeWithHints(text, hints[])`
Splits a sentence into `{ text, hintIndex }` segments, tagging words that match a hint's native text. Used by `HistoryLogEntry` internally, but also useful for live sentence display.

### `diffExampleVsUser(userText, exampleText)`
Word-level LCS diff. Returns `{ word, matched }[]` where unmatched words are shown in gold. Used by `HistoryLogEntry` for the [1] [2] example preview buttons.

### `calculateDistance(cursorX, cursorY, el)` / `distanceToOpacity(distance)`
Used by `HintCards` for proximity glow. You shouldn't need these directly.

---

## Constants — `sharedGameUtils.ts`

```ts
FEEDBACK_MAP    // feedbackKey → default explanation string
FEEDBACK_COLORS // feedbackKey → hex color
FEEDBACK_LABELS // feedbackKey → short display label
HINT_COLORS     // string[] of 6 colors cycling by hint index
```

---

## Backend Check API

Both `/api/worddrill/check` and `/api/battle/check` accept the same shape and return the same shape. Pass hints as `valid_phrases` so the LLM doesn't flag them as wrong.

**Request:**
```json
{
  "user_answer": "...",
  "correct_answer": "...",
  "accepted_translations": ["...", "..."],
  "prompt_text": "The English sentence",
  "valid_phrases": ["usar", "utilizar"],
  "learning": { "code": "es", "name": "Spanish" },
  "fluent":   { "code": "en", "name": "English" }
}
```

**Response:**
```json
{
  "accepted": true,
  "damage_multiplier": 0.85,
  "issues": [{ "feedback_key": "missing_minor_words", "corrected_snippet": "...", "feedback_explanation": "..." }],
  "correction_tokens": [{ "text": "word", "status": "ok" }],
  "fast_path": false,
  "token_usage": { "cost_cents": 0.4 }
}
```

After receiving `correction_tokens`, call `restoreAccentsInTokens` before storing or rendering.

## Audio API

```ts
POST /api/trivia/audio
{ text: "sentence to speak", locale: "es-MX" }
→ { audio_file: "/battle_audio/..." }
```

Backend caches generated files — the same text/locale pair is only generated once. Use `useAudioPlayer` (above) rather than calling this endpoint by hand; it adds a client-side cache on top, so a repeat play costs no request at all.

Locale strings come from `config.ts` — call `localeFor(langCode)` instead of writing `"es-MX"` inline.
