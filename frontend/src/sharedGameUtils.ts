// sharedGameUtils.ts
// Shared constants, types, and utility functions used across game modes.
import { normalizeNumberTokens } from "./numUtils";

// ── Shared types ─────────────────────────────────────────────────────────────

export type HintItem = { native: string; learning: string; note?: string };

export type CorrectionToken = { text: string; status: "ok" | "remove" | "add" };

export type FeedbackIssue = {
  feedbackKey: string;
  correctedSnippet?: string | null;
  feedbackExplanation?: string | null;
};

// Normalized entry shape used by HistoryLogEntry. Both WordDrillGame and
// TriviaGame2 map their internal entry types to this before rendering.
export type SharedHistoryEntry = {
  entryId: string;
  isWrongAttempt: boolean;
  skipped: boolean;
  qualityScore?: number;
  llmUsed?: boolean;
  allHints: HintItem[];
  hintsUsed: number;
  hintsRevealedIndices?: number[];
  promptText: string;
  userAnswer: string;
  correctAnswer: string;
  acceptedTranslations?: string[];
  correctionTokens?: CorrectionToken[] | null;
  feedbackIssues?: FeedbackIssue[] | null;
  feedbackKey?: string | null;
  correctedSnippet?: string | null;
  feedbackExplanation?: string | null;
  extraLabel?: string;
};

// ── Feedback constants ────────────────────────────────────────────────────────

export const FEEDBACK_MAP: Record<string, string> = {
  perfect: "Sounds natural — perfect answer!",
  asr_error: "Looks like a speech-to-text mishearing — full credit given.",
  missing_minor_words: "Almost perfect — just missing a small word or particle.",
  missing_content: "Part of the meaning from the prompt was left out.",
  gender_agreement: "Check the gender agreement — the article or adjective should match the noun.",
  register_too_formal: "Grammatically correct, but a bit too formal for this situation. Aim for a more casual, everyday tone.",
  register_too_informal: "Grammatically correct, but a bit too casual for this situation. Aim for a slightly more neutral tone.",
  subtle_meaning_shift: "The meaning is slightly different from what was asked — close, but not quite.",
  wrong_mood: "The meaning is clear, but this calls for the subjunctive or conditional mood.",
  word_order: "The words are in an unusual order — the meaning comes through but it sounds a bit off.",
  unnatural_phrasing: "This is understandable but sounds unnatural to a native speaker.",
  wrong_conjugation: "The verb is conjugated incorrectly.",
  wrong_tense: "The tense used changes or contradicts the intended meaning.",
  wrong_meaning: "The answer doesn't match what was asked.",
  missing_target_word: "Your answer is correct, but you need to use the required word for this exercise.",
};

export const FEEDBACK_COLORS: Record<string, string> = {
  perfect: "#4ade80",
  asr_error: "#60a5fa",
  missing_minor_words: "#fbbf24",
  missing_content: "#f97316",
  gender_agreement: "#fb923c",
  register_too_formal: "#a78bfa",
  register_too_informal: "#c084fc",
  subtle_meaning_shift: "#fb923c",
  wrong_mood: "#f97316",
  word_order: "#fbbf24",
  unnatural_phrasing: "#f97316",
  wrong_conjugation: "#f87171",
  wrong_tense: "#f87171",
  wrong_meaning: "#ef4444",
  missing_target_word: "#a78bfa",
};

export const FEEDBACK_LABELS: Record<string, string> = {
  perfect: "Perfect",
  asr_error: "STT Error",
  missing_minor_words: "Minor Word",
  missing_content: "Missing Content",
  gender_agreement: "Gender",
  register_too_formal: "Too Formal",
  register_too_informal: "Too Informal",
  subtle_meaning_shift: "Meaning Shift",
  wrong_mood: "Wrong Mood",
  word_order: "Word Order",
  unnatural_phrasing: "Unnatural",
  wrong_conjugation: "Conjugation",
  wrong_tense: "Wrong Tense",
  wrong_meaning: "Wrong Meaning",
  missing_target_word: "Wrong Word",
};

// Standard hint card colors (cycling by index)
export const HINT_COLORS = ["#fbbf24", "#67e8f9", "#86efac", "#c4b5fd", "#f9a8d4", "#fdba74"];

// ── Match normalization ───────────────────────────────────────────────────────

export function normalizeForMatch(text: string, langCode: string): string {
  return normalizeNumberTokens(text, langCode)
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[¿¡.,!?;:"""'']/g, "")
    .replace(/\s/g, "");
}

export function checkFuzzyMatch(userAnswer: string, accepted: string[], langCode: string): string | null {
  const n = normalizeForMatch(userAnswer, langCode);
  return accepted.find(a => normalizeForMatch(a, langCode) === n) ?? null;
}

// Restores accent marks stripped by the LLM in correction tokens, using canonical accepted translations.
export function restoreAccentsInTokens(
  tokens: CorrectionToken[],
  acceptedTranslations: string[],
  langCode: string
): CorrectionToken[] {
  const accentMap = new Map<string, string>();
  for (const t of acceptedTranslations) {
    for (const w of t.split(/\s+/)) {
      const key = normalizeForMatch(w, langCode);
      if (key && !accentMap.has(key)) accentMap.set(key, w);
    }
  }
  return tokens.map(tok => {
    if (tok.status === "remove") return tok;
    const restored = tok.text.replace(/\S+/g, w => accentMap.get(normalizeForMatch(w, langCode)) ?? w);
    return restored !== tok.text ? { ...tok, text: restored } : tok;
  });
}

// ── Hint tokenization ─────────────────────────────────────────────────────────

// Splits a sentence string into segments, tagging each word span that matches a hint's native text.
export function tokenizeWithHints(
  text: string,
  hints: HintItem[]
): Array<{ text: string; hintIndex: number | null }> {
  if (!hints.length) return [{ text, hintIndex: null }];
  type Span = { start: number; end: number; hintIndex: number };
  const spans: Span[] = [];
  hints.forEach((hint, hi) => {
    const terms = hint.native.split("/").map(t => t.trim()).filter(Boolean);
    for (const term of terms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        spans.push({ start: m.index, end: m.index + m[0].length, hintIndex: hi });
      }
    }
  });
  spans.sort((a, b) => a.start !== b.start ? a.start - b.start : (b.end - b.start) - (a.end - a.start));
  const kept: Span[] = [];
  let cursor = 0;
  for (const sp of spans) {
    if (sp.start >= cursor) { kept.push(sp); cursor = sp.end; }
  }
  const result: Array<{ text: string; hintIndex: number | null }> = [];
  let pos = 0;
  for (const sp of kept) {
    if (pos < sp.start) result.push({ text: text.slice(pos, sp.start), hintIndex: null });
    result.push({ text: text.slice(sp.start, sp.end), hintIndex: sp.hintIndex });
    pos = sp.end;
  }
  if (pos < text.length) result.push({ text: text.slice(pos), hintIndex: null });
  return result.length ? result : [{ text, hintIndex: null }];
}

// ── Diff utilities ────────────────────────────────────────────────────────────

// Word-level LCS diff between user's answer and an accepted example translation.
export function diffExampleVsUser(userText: string, exampleText: string): Array<{ word: string; matched: boolean }> {
  const normalize = (w: string) => w.toLowerCase().replace(/[.,!?;:¿¡"""'']/g, "");
  const aWords = userText.trim().split(/\s+/).map(normalize);
  const bWords = exampleText.trim().split(/\s+/);
  const bNorm = bWords.map(normalize);
  const mLen = aWords.length, nLen = bWords.length;
  const dp: number[][] = Array.from({ length: mLen + 1 }, () => new Array(nLen + 1).fill(0));
  for (let i = 1; i <= mLen; i++)
    for (let j = 1; j <= nLen; j++)
      dp[i][j] = aWords[i - 1] === bNorm[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const result: Array<{ word: string; matched: boolean }> = [];
  let i = mLen, j = nLen;
  while (j > 0) {
    if (i > 0 && aWords[i - 1] === bNorm[j - 1]) { result.unshift({ word: bWords[j - 1], matched: true }); i--; j--; }
    else if (i === 0 || dp[i - 1][j] < dp[i][j - 1]) { result.unshift({ word: bWords[j - 1], matched: false }); j--; }
    else { i--; }
  }
  return result;
}

// ── Hint proximity ────────────────────────────────────────────────────────────

// Euclidean distance from cursor to nearest edge of an element.
export function calculateDistance(cursorX: number, cursorY: number, el: HTMLDivElement): number {
  const rect = el.getBoundingClientRect();
  const dx = Math.max(rect.left - cursorX, 0, cursorX - rect.right);
  const dy = Math.max(rect.top - cursorY, 0, cursorY - rect.bottom);
  return Math.sqrt(dx * dx + dy * dy);
}

// Maps distance (0–300px) to opacity (1.0–0.0).
export function distanceToOpacity(distance: number): number {
  const MAX_DISTANCE = 300;
  if (distance >= MAX_DISTANCE) return 0;
  if (distance <= 0) return 1;
  return 1 - distance / MAX_DISTANCE;
}
