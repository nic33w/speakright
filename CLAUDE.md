# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SpeakRight is a language learning application focused on Spanish/Indonesian conversational practice with instant structured feedback. The app features two main modes:

1. **ChatWithWispr** - Conversational practice with sentence-by-sentence translation and audio playback
2. **StoryCardsGame** - Interactive storytelling using vocabulary/grammar cards

Tech stack:
- Frontend: React + TypeScript (Vite)
- Backend: FastAPI (Python)
- STT: Wispr desktop integration (via clipboard/textarea)
- TTS: Azure Speech Services
- LLM: OpenAI API (gpt-4o-mini default)

## Development Commands

### Frontend (in `frontend/` directory)
```bash
npm install              # Install dependencies
npm run dev              # Start dev server (http://localhost:5173)
npm run build            # Build for production
npm run lint             # Run ESLint
```

### Backend (in `backend/` directory)
```bash
pip install -r requirements.txt   # Install dependencies
python fastapi_wispr_pipeline.py  # Run chat/conversation backend (port 8000)
python game_backend.py             # Run story cards game backend (port 8000)
```

Note: Only run ONE backend server at a time (they use the same port).

### Environment Setup

Create `backend/.env` with:
```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
AZURE_SPEECH_KEY=...
AZURE_REGION=...
AZURE_VOICE_ES=es-MX-JorgeNeural
AZURE_VOICE_EN=en-US-JennyNeural
AZURE_VOICE_ID=id-ID-GadisNeural
MOCK_MODE=0
```

Set `MOCK_MODE=1` for local testing without API keys (uses mock responses and silent audio).

## Architecture

### Backend Structure

**Two separate FastAPI backends** (run only one at a time):

1. **`fastapi_wispr_pipeline.py`** - Powers ChatWithWispr conversation UI
   - `/api/transcript` - Splits and translates user input (learning → native language)
   - `/api/confirm` - Generates corrected pairs + LLM reply with TTS audio
   - `/api/conversations` - Save/load conversation history
   - `/api/audio_file/{session_id}/{filename}` - Serves generated audio files

2. **`game_backend.py`** - Powers StoryCardsGame
   - `/api/game/start` - Initialize session with random cards
   - `/api/game/turn` - Process user transcript, detect card usage, generate corrections + TTS
   - `/api/audio_file/{session}/{filename}` - Serves audio files

**Shared backend modules:**
- `llm_call.py` - OpenAI integration with structured prompt for card game
- `tts_helpers.py` - Azure TTS wrapper functions

Audio files are saved to `backend/audio_files/session_{id}/` and served via FastAPI FileResponse.

### Frontend Structure

**Main entry point:** `frontend/src/App.tsx`
- Currently renders `<StoryCardsGame />` (switch to `<ChatWithWispr />` for conversation mode)

**Key components:**

1. **`ChatWithWispr.tsx`** (~900 lines)
   - Dual-language sentence pairs (native on top, learning below)
   - Language detection heuristics (Spanish/Indonesian/English)
   - Translation-check flow: user types in learning language → backend translates → user confirms/edits → LLM generates reply
   - Audio caching (avoids re-fetching) and sequential playback
   - Conversation save/load sidebar
   - Toggle controls: show/hide native, show/hide learning text, show/hide spaces

2. **`StoryCardsGame.tsx`** (~680 lines)
   - Card deck management (7 visible cards at a time)
   - Auto-send on typing pause (1200ms debounce after 8 chars)
   - Card replacement with highlight animation when cards are used
   - History sidebar with hover-to-preview audio
   - Manual card swap functionality

### Data Flow

**Chat mode:**
1. User types/pastes text (Spanish/Indonesian or English)
2. Language detection determines if input is learning language
3. If learning language: `/api/transcript` splits sentences and translates to native
4. User confirms/edits translation
5. `/api/confirm` generates corrected target-language version + LLM reply + TTS audio
6. Sequential audio playback (corrected first, then reply)

**Game mode:**
1. User speaks (Wispr fills textarea via clipboard) or types
2. Auto-send triggers `/api/game/turn` with active cards
3. Backend calls LLM to correct sentence, detect card usage, generate audio
4. Frontend replaces used cards with new draws (no duplicates)
5. Audio files played sequentially

### Language Configuration

The app supports 3 languages via `LangSpec` type:
```typescript
{ code: "en", name: "English" }
{ code: "es", name: "Spanish" }
{ code: "id", name: "Indonesian" }
```

Backend prompts enforce Latin American Spanish (Mexican preference) and casual Indonesian register.

### Audio System

**TTS Generation:**
- Azure Speech Services for production (configured via env vars)
- Silent WAV fallback when MOCK_MODE=1
- Audio chunks tagged with locale (es-MX, id-ID, en-US)

**Frontend playback:**
- Base64-encoded WAV (inline in JSON response)
- FileResponse URLs (`/api/audio_file/{session}/{filename}`)
- Prefer file URLs to reduce payload size
- Object URL caching to avoid refetching

### Session Management

**Chat mode:**
- Sessions identified by `session_id` (generated client-side)
- Conversations saved to `backend/conversations/session_{id}.json`
- Audio stored separately in `backend/audio_files/session_{id}/`
- Frontend sanitizes messages before save (removes audio_base64 to keep JSON small)

**Game mode:**
- Session created on `/api/game/start`
- No persistence (ephemeral gameplay)

## Important Patterns

### Card Replacement (Game Mode)

When cards are used:
1. Backend returns `used_card_ids` array
2. Frontend filters visible cards by id/value/display_text (case-insensitive)
3. Draws replacements from CARD_DECK excluding currently visible cards
4. Triggers highlight animation + floating +points badge
5. Cleanup timer removes highlights after 1200ms

### LLM Prompts

**Chat mode (`fastapi_wispr_pipeline.py`):**
- System message specifies language styles (Latin American Spanish, casual Indonesian)
- Returns JSON with `corrected_pairs`, `reply_pairs`, `correction_explanation`
- Explanation MUST be in fluent/native language (enforced in system prompt)

**Game mode (`llm_call.py`):**
- Structured output with corrected sentence, used card IDs, ASR fixes, audio chunks
- Temperature=0.15 for consistency
- Fallback to mock response on API failure

### Error Handling

- Backend catches LLM/TTS failures gracefully, returns mock data when necessary
- Frontend alerts user on network failures but continues functioning
- Auto-send timer cleared properly to avoid duplicate submissions

## Common Development Scenarios

### Adding a new language

1. Add to LANG_OPTIONS in both `ChatWithWispr.tsx` and `StoryCardsGame.tsx`
2. Update language_style_instruction() in `fastapi_wispr_pipeline.py` and `llm_call.py`
3. Add Azure voice to DEFAULT_VOICE_BY_LANG
4. Update language detection heuristics in `ChatWithWispr.tsx` isProbablyLearning()

### Switching between modes

Edit `frontend/src/App.tsx`:
```tsx
// For chat mode:
return <ChatWithWispr />

// For game mode:
return <StoryCardsGame />
```

### Debugging audio issues

- Check backend logs for TTS API failures
- Verify Azure credentials in `.env`
- Test with MOCK_MODE=1 (silent audio should play)
- Check browser console for fetch errors on audio file URLs
- Inspect `backend/audio_files/session_{id}/` directory

### Running tests

No test suite currently exists. Manual testing workflow:
1. Start backend server
2. Start frontend dev server
3. Test with MOCK_MODE=1 first (no API keys needed)
4. Test with real API keys and verify TTS audio quality

## Backend CORS Configuration

Both backends allow these origins:
- http://localhost:3000
- http://127.0.0.1:3000
- http://localhost:5173
- http://127.0.0.1:5173

Add new origins to `allow_origins` list if deploying elsewhere.

## Common Mode Features

All game modes should implement these standard features. Check this section before building any new mode.

### 1. Textarea Input
- **Auto-focus**: `useEffect` focuses textarea when sentence exists, not busy, answer not yet accepted
- **Hover-focus**: `onMouseEnter` focuses textarea if not busy/done
- **Wispr auto-send**: in `useEffect([transcript])`, if `transcript.length - previousLengthRef.current >= 3` AND `transcript.length > 2`, wait 100ms then submit (guard: >700ms since last send)
- **Manual send**: Enter submits, Shift+Enter inserts newline
- **Clear button**: clears transcript, re-focuses
- **Skip button**: shows correct answer, adds to history as skipped, enables Next
- **Disabled**: when busy OR answerStatus is "correct" or "skipped"
- **"Checking…" label**: show on submit button while busy=true

### 2. Live Feedback Area (below textarea)
After each submission:
- Status icon: ✓ correct (green `#86efac` / gold `#fbbf24` / orange `#f97316` by quality), → skipped (gray), no icon for wrong
- Feedback message text in matching color
- **Issue badges**: colored pill spans using `FEEDBACK_COLORS`, `FEEDBACK_LABELS`, `FEEDBACK_MAP` — copy these constants from `BattleGame.tsx`
- **Correction tokens**: inline diff — removed words in red `#fca5a5` with line-through, added words in bold green `#86efac`, unchanged in `rgba(255,255,255,0.8)`
- Wrong answers: show feedback then clear textarea and reset to idle so user can retry

### 3. History Log (right column, 34%)
**Collapsed entry:**
- Blue bg for correct `rgba(59,130,246,0.25)`, red for wrong attempt `rgba(239,68,68,0.15)`, gray for skipped
- ✓/✗ status badge + user's answer text (or "→ answer" for skipped)
- **Blue quality bar**: 5px tall, 56px wide; fill HSL where `hue = (qualityScore/100)*217`, sat 80%, light 58%
- **Gold hints bar**: shows % of hints NOT used; only display when `allHints?.length > 0`
- **Hover audio**: on mouseEnter, fetch TTS for the correct answer via `POST /api/trivia/audio {text, locale}` and play it; stop on mouseLeave

**Expanded entry** (250ms hover delay OR click to pin; pinned entries stay expanded):
1. **Sentence section**: the English prompt; when hints present use `tokenizeWithHints()` to highlight hint-matched words (unrevealed = dashed gold underline, revealed = colored from `HINT_COLORS`)
2. **You Said**: correction tokens diff (red strikethrough / bold green); numbered buttons [1] [2] for accepted translations — hover a button to preview word-level diff via `diffExampleVsUser()` (unmatched words in gold `#fbbf24`)
3. **Feedback**: issue badges + explanations (same format as live feedback area)
4. **Previous attempts** (only on resolved entries): each prior wrong attempt in a red-tinted sub-box with its correction tokens + feedback badges

Wrong attempts are hidden from the main log once the same sentence is resolved (correct/skip) — visible only in the resolved entry's "Previous attempts" section. Auto-scroll history to bottom on new entry.

### 4. Hints System (optional — build capability; show only when hints present)
Include the hint section only when `currentSentence.hints` is a non-empty array. Omit entirely otherwise.

`HintItem` type: `{ native: string; learning: string; note?: string }`

- Horizontal scrollable row of hint cards (130px wide)
- Card layout: native text (top), Aa reveal button OR learning text (middle), 🔊 audio button (bottom)
- **Hover text**: reveals learning text and stays revealed (add index to `viewedHints` Set)
- **Hover audio**: fetch TTS via `/api/trivia/audio` and play it
- **Proximity scaling**: `calculateDistance()` + `distanceToOpacity()` (MAX 300px) — closest unrevealed hint gets cyan border + bg glow
- **Hint highlighting in sentence**: `tokenizeWithHints()` — unrevealed = dashed gold underline, revealed = colored text cycling `HINT_COLORS`

### Constants / functions to copy from BattleGame.tsx into any new mode
- `FEEDBACK_MAP`, `FEEDBACK_COLORS`, `FEEDBACK_LABELS`
- `HINT_COLORS` array
- `normalizeForMatch()`, `checkFuzzyMatch()`
- `calculateDistance()`, `distanceToOpacity()`
- `tokenizeWithHints()` (when hints are used)
- `diffExampleVsUser()` (for "You Said" preview diffs)

---
- Do no implement new features that I didn't tell you to do. If you'd like to add something we haven't discussed, you must confirm the plan with me.