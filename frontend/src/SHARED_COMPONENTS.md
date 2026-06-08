# Shared Game Components

Reference for building new game modes. Import everything from these two files.

```ts
import { /* components */ } from "./sharedGameComponents";
import type { /* types */ } from "./sharedGameUtils";
import { /* utils/constants */ } from "./sharedGameUtils";
```

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

### `<HintCards hints={...} viewedHints={...} onReveal={...} onPlayAudio={...} onStopAudio={...} />`

Scrollable row of 130px hint cards. Proximity glow on the nearest unrevealed card as the mouse approaches. Hover the "Aa" button to reveal the learning text. Hover the 🔊 button to play audio.

```tsx
<HintCards
  key={currentSentence.id}       // reset on sentence change
  hints={currentSentence.hints ?? []}
  viewedHints={viewedHints}      // Set<number> of revealed indices
  onReveal={idx => setViewedHints(prev => new Set([...prev, idx]))}
  onPlayAudio={text => fetchAndPlayAudio(text, learningLocale)}
  onStopAudio={stopAudio}
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
  apiBase={apiBase}                    // defaults to "http://localhost:8000"
  locale={learningLocale}              // e.g. "es-MX", "id-ID"
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
Fast local check before calling the LLM. Strips accents, punctuation, and whitespace, then compares. Returns the matched accepted translation or `null`. Always try this first — if it matches, skip the API call entirely.

### `normalizeForMatch(text, langCode)`
Strips accents, punctuation, whitespace. Used internally by `checkFuzzyMatch`.

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

Backend caches generated files — the same text/locale pair is only generated once. `HistoryLogEntry` calls this automatically. For live playback, maintain your own cache:

```ts
const audioCacheRef = useRef<Map<string, string>>(new Map());

async function fetchAndPlayAudio(text: string, locale: string) {
  const key = `${locale}:${text}`;
  let url = audioCacheRef.current.get(key);
  if (!url) {
    const data = await fetch(`${apiBase}/api/trivia/audio`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, locale }),
    }).then(r => r.json());
    url = `${apiBase}${data.audio_file}`;
    audioCacheRef.current.set(key, url);
  }
  currentAudioRef.current?.pause();
  const audio = new Audio(url);
  currentAudioRef.current = audio;
  audio.play().catch(() => {});
}
```

Locale strings: `"es-MX"` for Spanish, `"id-ID"` for Indonesian, `"en-US"` for English.
