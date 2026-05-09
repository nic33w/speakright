// WordDrillGame.tsx
// Practice specific words/phrases with LLM feedback — follows Common Mode Features spec
import { useEffect, useRef, useState } from "react";

type LangSpec = { code: string; name: string };

type HintItem = { native: string; learning: string; note?: string };

type FeedbackIssue = {
  feedbackKey: string;
  correctedSnippet?: string | null;
  feedbackExplanation?: string | null;
};

type CheckResult = {
  multiplier: number;
  feedbackIssues: FeedbackIssue[] | null;
  feedbackKey: string | null;
  correctedSnippet: string | null;
  feedbackExplanation: string | null;
  correctionTokens: Array<{ text: string; status: "ok" | "remove" | "add" }> | null;
};

type Sentence = {
  id: number;
  category: string;
  context: string;
  english: string;
  spanish: string;
  accepted_translations: string[];
  hints?: HintItem[];
};

type HistoryEntry = {
  entryId: string;
  sentenceId: number;
  category: string;
  context: string;
  english: string;
  userAnswer: string;
  correctAnswer: string;
  acceptedTranslations: string[];
  allHints: HintItem[];
  hintsUsed: number;
  isWrongAttempt: boolean;
  skipped: boolean;
  feedbackIssues?: FeedbackIssue[] | null;
  feedbackKey?: string | null;
  correctedSnippet?: string | null;
  feedbackExplanation?: string | null;
  correctionTokens?: Array<{ text: string; status: "ok" | "remove" | "add" }> | null;
  qualityScore?: number;
  llmUsed: boolean;
};

type WordInfo = {
  key: string;
  display: string;
  description: string;
};

// ── Shared constants (from BattleGame.tsx) ───────────────────────────────────

const HINT_COLORS = ["#fbbf24", "#67e8f9", "#86efac", "#c4b5fd", "#f9a8d4", "#fdba74"];

const FEEDBACK_MAP: Record<string, string> = {
  perfect: "Sounds natural — perfect answer!",
  asr_error: "Looks like a speech-to-text mishearing — full credit given.",
  missing_minor_words: "Almost perfect — just missing a small word or particle.",
  missing_content: "Part of the meaning from the prompt was left out.",
  gender_agreement: "Check the gender agreement — the article or adjective should match the noun.",
  register_too_formal: "Grammatically correct, but a bit too formal for this situation.",
  register_too_informal: "Grammatically correct, but a bit too casual for this situation.",
  subtle_meaning_shift: "The meaning is slightly different from what was asked.",
  wrong_mood: "The meaning is clear, but this calls for the subjunctive or conditional mood.",
  word_order: "The words are in an unusual order — sounds a bit off.",
  unnatural_phrasing: "This is understandable but sounds unnatural to a native speaker.",
  wrong_conjugation: "The verb is conjugated incorrectly.",
  wrong_tense: "The tense used changes or contradicts the intended meaning.",
  wrong_meaning: "The answer doesn't match what was asked.",
};

const FEEDBACK_COLORS: Record<string, string> = {
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
};

const FEEDBACK_LABELS: Record<string, string> = {
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
};

const LEARNING_LOCALE: Record<string, string> = { es: "es-MX", id: "id-ID", en: "en-US" };

// ── Shared helper functions (from BattleGame.tsx) ────────────────────────────

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[¿¡.,!?;:"""'']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function checkFuzzyMatch(userAnswer: string, accepted: string[]): boolean {
  const n = normalizeForMatch(userAnswer);
  return accepted.some(a => normalizeForMatch(a) === n);
}

function tokenizeWithHints(
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

function diffExampleVsUser(userText: string, exampleText: string): Array<{ word: string; matched: boolean }> {
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

function calculateDistance(cursorX: number, cursorY: number, el: HTMLDivElement): number {
  const rect = el.getBoundingClientRect();
  const dx = Math.max(rect.left - cursorX, 0, cursorX - rect.right);
  const dy = Math.max(rect.top - cursorY, 0, cursorY - rect.bottom);
  return Math.sqrt(dx * dx + dy * dy);
}

function distanceToOpacity(distance: number): number {
  const MAX_DISTANCE = 300;
  if (distance >= MAX_DISTANCE) return 0;
  if (distance <= 0) return 1;
  return 1 - distance / MAX_DISTANCE;
}

// ── Component ────────────────────────────────────────────────────────────────

type WordDrillGameProps = {
  apiBase?: string;
  fluent?: LangSpec;
  learning?: LangSpec;
  onBack?: () => void;
};

export default function WordDrillGame({
  apiBase = (import.meta as any).env?.VITE_API_BASE_URL || "http://localhost:8000",
  fluent = { code: "en", name: "English" },
  learning = { code: "es", name: "Spanish" },
  onBack,
}: WordDrillGameProps) {
  const learningLocale = LEARNING_LOCALE[learning.code] ?? "es-MX";

  // ── State ────────────────────────────────────────────────────────────────
  const [selectedWord, setSelectedWord] = useState<string | null>(null);
  const [wordList, setWordList] = useState<WordInfo[]>([]);
  const [currentSentence, setCurrentSentence] = useState<Sentence | null>(null);
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);
  const [answerStatus, setAnswerStatus] = useState<"idle" | "checking" | "correct" | "skipped">("idle");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [lastCheckResult, setLastCheckResult] = useState<CheckResult | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [usedSentenceIds, setUsedSentenceIds] = useState<number[]>([]);
  const [loadingSentence, setLoadingSentence] = useState(false);
  const [correctCount, setCorrectCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  // Hints state
  const [viewedHints, setViewedHints] = useState<Set<number>>(new Set());
  const [closestHintIndex, setClosestHintIndex] = useState<number | null>(null);
  const [closestHintOpacity, setClosestHintOpacity] = useState<number>(0);

  // History log state
  const [expandedLogEntry, setExpandedLogEntry] = useState<number | null>(null);
  const [pinnedLogEntries, setPinnedLogEntries] = useState<Set<number>>(new Set());
  const [previewExampleIndex, setPreviewExampleIndex] = useState<number | null>(null);

  // Auto-advance countdown after correct answer (1.0 → 0.0 over 1s)
  const [autoNextProgress, setAutoNextProgress] = useState<number | null>(null);

  const [totalCostCents, setTotalCostCents] = useState(0);

  // Pending auto-send countdown (1.0 → 0.0 over 1s, shown after Wispr paste)
  const [pendingAutoSend, setPendingAutoSend] = useState(false);
  const [pendingProgress, setPendingProgress] = useState<number | null>(null);

  // ── Refs ─────────────────────────────────────────────────────────────────
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const lastSentRef = useRef<number>(0);
  const previousLengthRef = useRef<number>(0);
  const entryIdCounter = useRef<number>(0);
  const historyEndRef = useRef<HTMLDivElement>(null);
  const hintCardsRefs = useRef<(HTMLDivElement | null)[]>([]);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioCacheRef = useRef<Map<string, string>>(new Map());
  const expandTimerRef = useRef<number | null>(null);
  const autoNextTimerRef = useRef<number | null>(null);

  // ── Effects ──────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch(`${apiBase}/api/worddrill/words`)
      .then(r => r.json())
      .then(data => setWordList(data.words ?? []))
      .catch(() => setWordList([{ key: "quedar", display: "quedar", description: "to stay, meet up, fit, be left" }]));
  }, [apiBase]);

  useEffect(() => {
    if (currentSentence && answerStatus === "idle" && !busy) {
      textareaRef.current?.focus();
    }
  }, [currentSentence, answerStatus, busy]);

  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history.length]);

  // Auto-advance to next sentence 1s after a correct answer
  useEffect(() => {
    if (answerStatus === "correct") {
      const startTime = Date.now();
      const DURATION = 1000;
      setAutoNextProgress(1.0);
      autoNextTimerRef.current = window.setInterval(() => {
        const remaining = Math.max(0, 1 - (Date.now() - startTime) / DURATION);
        setAutoNextProgress(remaining);
        if (remaining <= 0) {
          window.clearInterval(autoNextTimerRef.current!);
          autoNextTimerRef.current = null;
          handleNext();
        }
      }, 30);
    } else {
      if (autoNextTimerRef.current) { window.clearInterval(autoNextTimerRef.current); autoNextTimerRef.current = null; }
      setAutoNextProgress(null);
    }
    return () => { if (autoNextTimerRef.current) { window.clearInterval(autoNextTimerRef.current); autoNextTimerRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answerStatus]);

  function cancelPendingAutoSend(clearText = false) {
    if (pendingTimerRef.current) { window.clearInterval(pendingTimerRef.current); pendingTimerRef.current = null; }
    setPendingAutoSend(false);
    setPendingProgress(null);
    if (clearText) { setTranscript(""); textareaRef.current?.focus(); }
  }

  function startPendingAutoSend() {
    cancelPendingAutoSend();
    const DURATION = 2000;
    const startTime = Date.now();
    setPendingAutoSend(true);
    setPendingProgress(1.0);
    pendingTimerRef.current = window.setInterval(() => {
      const remaining = Math.max(0, 1 - (Date.now() - startTime) / DURATION);
      setPendingProgress(remaining);
      if (remaining <= 0) {
        window.clearInterval(pendingTimerRef.current!);
        pendingTimerRef.current = null;
        setPendingAutoSend(false);
        setPendingProgress(null);
        void submitAnswer();
      }
    }, 30);
  }

  // Wispr auto-send
  useEffect(() => {
    cancelPendingAutoSend();

    if (transcript.length > 2 && answerStatus === "idle" && !busy) {
      const increase = transcript.length - previousLengthRef.current;
      if (increase >= 3 && Date.now() - lastSentRef.current > 700) {
        startPendingAutoSend();
      }
    }
    previousLengthRef.current = transcript.length;
    return () => cancelPendingAutoSend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcript]);

  // ── Audio helpers ─────────────────────────────────────────────────────────

  function stopAudio() {
    if (currentAudioRef.current) { currentAudioRef.current.pause(); currentAudioRef.current = null; }
  }

  async function fetchAndPlayAudio(text: string, locale: string) {
    const key = `${locale}:${text}`;
    let url = audioCacheRef.current.get(key);
    if (!url) {
      try {
        const resp = await fetch(`${apiBase}/api/trivia/audio`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, locale }),
        });
        const data = await resp.json();
        url = `${apiBase}${data.audio_file}`;
        audioCacheRef.current.set(key, url);
      } catch { return; }
    }
    stopAudio();
    const audio = new Audio(url);
    currentAudioRef.current = audio;
    audio.play().catch(() => {});
  }

  // ── Hint proximity ────────────────────────────────────────────────────────

  function handleHintsMouseMove(e: React.MouseEvent) {
    const hints = currentSentence?.hints ?? [];
    if (!hints.length) return;
    let minDist = Infinity;
    let minIdx: number | null = null;
    hintCardsRefs.current.forEach((el, i) => {
      if (!el || viewedHints.has(i)) return;
      const d = calculateDistance(e.clientX, e.clientY, el);
      if (d < minDist) { minDist = d; minIdx = i; }
    });
    setClosestHintIndex(minIdx);
    setClosestHintOpacity(minIdx !== null ? distanceToOpacity(minDist) : 0);
  }

  // ── Data fetching ─────────────────────────────────────────────────────────

  async function fetchNextSentence(word: string, excludeIds: number[]) {
    setLoadingSentence(true);
    setBusy(true);
    try {
      const resp = await fetch(`${apiBase}/api/worddrill/sentence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word, exclude_ids: excludeIds }),
      });
      if (!resp.ok) throw new Error("Failed");
      const data = await resp.json();
      setCurrentSentence(data.sentence);
      setUsedSentenceIds(prev => [...prev, data.sentence.id]);
      setTranscript("");
      setAnswerStatus("idle");
      setFeedbackMessage("");
      setLastCheckResult(null);
      setViewedHints(new Set());
      setClosestHintIndex(null);
      setClosestHintOpacity(0);
      previousLengthRef.current = 0;
      hintCardsRefs.current = new Array((data.sentence.hints ?? []).length).fill(null);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingSentence(false);
      setBusy(false);
    }
  }

  function handleSelectWord(wordKey: string) {
    setSelectedWord(wordKey);
    setHistory([]);
    setUsedSentenceIds([]);
    setCorrectCount(0);
    setTotalCount(0);
    setPinnedLogEntries(new Set());
    fetchNextSentence(wordKey, []);
  }

  // ── Answer logic ──────────────────────────────────────────────────────────

  async function submitAnswer() {
    if (!currentSentence || busy || answerStatus !== "idle") return;
    const userAnswer = transcript.trim();
    if (!userAnswer) return;

    lastSentRef.current = Date.now();
    setBusy(true);
    setAnswerStatus("checking");

    if (checkFuzzyMatch(userAnswer, currentSentence.accepted_translations)) {
      resolveCorrect(userAnswer, 1.0, null, null, null, null, null, false);
      setBusy(false);
      return;
    }

    try {
      const resp = await fetch(`${apiBase}/api/worddrill/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_answer: userAnswer,
          correct_answer: currentSentence.accepted_translations[0],
          accepted_translations: currentSentence.accepted_translations,
          prompt_text: currentSentence.english,
          context: currentSentence.context,
          learning,
          fluent,
        }),
      });
      if (!resp.ok) throw new Error("Check failed");
      const data = await resp.json();

      const issues: FeedbackIssue[] = ((data.issues ?? []) as Array<{ feedback_key: string; corrected_snippet: string | null; feedback_explanation: string | null }>)
        .map(i => ({ feedbackKey: i.feedback_key, correctedSnippet: i.corrected_snippet ?? null, feedbackExplanation: i.feedback_explanation ?? null }));
      const feedbackIssues = issues.length ? issues : null;

      const costCents: number = data.token_usage?.cost_cents ?? 0;
      if (costCents > 0) setTotalCostCents(prev => prev + costCents);

      if (data.accepted) {
        resolveCorrect(userAnswer, data.damage_multiplier ?? 1.0, data.feedback_key ?? null, data.corrected_snippet ?? null, data.feedback_explanation ?? null, data.correction_tokens ?? null, feedbackIssues, true);
      } else {
        const result: CheckResult = { multiplier: 0, feedbackIssues, feedbackKey: data.feedback_key ?? null, correctedSnippet: data.corrected_snippet ?? null, feedbackExplanation: data.feedback_explanation ?? null, correctionTokens: data.correction_tokens ?? null };
        setLastCheckResult(result);
        setFeedbackMessage("Not quite — try again!");
        setTranscript("");
        setAnswerStatus("idle");

        setHistory(prev => [...prev, {
          entryId: `${++entryIdCounter.current}`,
          sentenceId: currentSentence.id,
          category: currentSentence.category,
          context: currentSentence.context,
          english: currentSentence.english,
          userAnswer,
          correctAnswer: currentSentence.accepted_translations[0],
          acceptedTranslations: currentSentence.accepted_translations,
          allHints: currentSentence.hints ?? [],
          hintsUsed: viewedHints.size,
          isWrongAttempt: true,
          skipped: false,
          ...result,
          qualityScore: 0,
          llmUsed: true,
        }]);
      }
    } catch (e) {
      console.error(e);
      setAnswerStatus("idle");
      setFeedbackMessage("Check failed — try again!");
    } finally {
      setBusy(false);
    }
  }

  function resolveCorrect(
    userAnswer: string, multiplier: number,
    feedbackKey: string | null, correctedSnippet: string | null,
    feedbackExplanation: string | null,
    correctionTokens: Array<{ text: string; status: "ok" | "remove" | "add" }> | null,
    feedbackIssues: FeedbackIssue[] | null,
    llmUsed: boolean,
  ) {
    const isPerfect = multiplier >= 1.0 && (!feedbackKey || feedbackKey === "perfect" || feedbackKey === "asr_error");
    const result: CheckResult = { multiplier, feedbackIssues, feedbackKey, correctedSnippet, feedbackExplanation, correctionTokens };
    setLastCheckResult(result);
    setAnswerStatus("correct");
    setFeedbackMessage(isPerfect ? "Perfect!" : "Close enough!");
    setCorrectCount(c => c + 1);
    setTotalCount(t => t + 1);

    setHistory(prev => [...prev, {
      entryId: `${++entryIdCounter.current}`,
      sentenceId: currentSentence!.id,
      category: currentSentence!.category,
      context: currentSentence!.context,
      english: currentSentence!.english,
      userAnswer,
      correctAnswer: currentSentence!.accepted_translations[0],
      acceptedTranslations: currentSentence!.accepted_translations,
      allHints: currentSentence!.hints ?? [],
      hintsUsed: viewedHints.size,
      isWrongAttempt: false,
      skipped: false,
      feedbackIssues, feedbackKey, correctedSnippet, feedbackExplanation, correctionTokens,
      qualityScore: Math.round(multiplier * 100),
      llmUsed,
    }]);
  }

  function handleSkip() {
    if (!currentSentence || busy || answerStatus === "correct" || answerStatus === "skipped") return;
    setBusy(true);
    setAnswerStatus("skipped");
    setFeedbackMessage(currentSentence.accepted_translations[0]);
    setTranscript("");
    setLastCheckResult(null);
    setTotalCount(t => t + 1);

    setHistory(prev => [...prev, {
      entryId: `${++entryIdCounter.current}`,
      sentenceId: currentSentence.id,
      category: currentSentence.category,
      context: currentSentence.context,
      english: currentSentence.english,
      userAnswer: "",
      correctAnswer: currentSentence.accepted_translations[0],
      acceptedTranslations: currentSentence.accepted_translations,
      allHints: currentSentence.hints ?? [],
      hintsUsed: viewedHints.size,
      isWrongAttempt: false,
      skipped: true,
      qualityScore: 0,
      llmUsed: false,
    }]);
    setBusy(false);
  }

  function handleNext() {
    if (!selectedWord) return;
    stopAudio();
    fetchNextSentence(selectedWord, usedSentenceIds);
  }

  // ── Sub-renderers ─────────────────────────────────────────────────────────

  function renderFeedbackBadges(issues: FeedbackIssue[], small = false) {
    return issues.map((issue, i) => {
      const catColor = FEEDBACK_COLORS[issue.feedbackKey] ?? "#94a3b8";
      const catLabel = FEEDBACK_LABELS[issue.feedbackKey] ?? issue.feedbackKey;
      const tip = issue.feedbackExplanation ?? FEEDBACK_MAP[issue.feedbackKey];
      return (
        <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 6, flexWrap: "wrap" }}>
          <span style={{
            fontSize: small ? 10 : 11, fontWeight: 600, padding: small ? "1px 6px" : "2px 8px", borderRadius: 999,
            background: `${catColor}22`, border: `1px solid ${catColor}66`, color: catColor,
            whiteSpace: "nowrap", flexShrink: 0,
          }}>
            {catLabel}
          </span>
          {tip && (
            <span style={{ fontSize: small ? 11 : 12, color: catColor, lineHeight: 1.4, opacity: 0.9 }}>
              {tip}{issue.correctedSnippet ? <span style={{ fontWeight: 600 }}> → {issue.correctedSnippet}</span> : null}
            </span>
          )}
        </div>
      );
    });
  }

  function renderCorrectionTokens(tokens: Array<{ text: string; status: "ok" | "remove" | "add" }>, small = false) {
    return (
      <div style={{ fontSize: small ? 12 : 13, lineHeight: 1.7, wordBreak: "break-word", padding: "5px 10px", background: "rgba(255,255,255,0.04)", borderRadius: 6 }}>
        {tokens.map((tok, ti) => {
          if (tok.status === "remove") return <span key={ti} style={{ color: "#fca5a5", textDecoration: "line-through" }}>{tok.text}</span>;
          if (tok.status === "add") return <span key={ti} style={{ color: "#86efac", fontWeight: 600 }}>{tok.text}</span>;
          return <span key={ti} style={{ color: "rgba(255,255,255,0.8)" }}>{tok.text}</span>;
        })}
      </div>
    );
  }

  function renderExpandedHistoryEntry(entry: HistoryEntry, wrongAttempts: HistoryEntry[]) {
    const tokens = tokenizeWithHints(entry.english, entry.allHints);
    const entryIssues: FeedbackIssue[] = entry.feedbackIssues?.length
      ? entry.feedbackIssues
      : entry.feedbackKey ? [{ feedbackKey: entry.feedbackKey, correctedSnippet: entry.correctedSnippet, feedbackExplanation: entry.feedbackExplanation }]
      : [];

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
        {/* Section 1: Sentence with hint highlighting */}
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.4, marginBottom: 4 }}>Sentence</div>
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            {tokens.map((seg, si) => {
              if (seg.hintIndex === null) return <span key={si} style={{ color: "rgba(255,255,255,0.75)" }}>{seg.text}</span>;
              const isRevealed = entry.allHints.length > 0 && viewedHints.has(seg.hintIndex);
              const color = isRevealed ? HINT_COLORS[seg.hintIndex % HINT_COLORS.length] : "#fbbf24";
              return (
                <span key={si}
                  style={{
                    color: isRevealed ? color : "rgba(255,255,255,0.85)",
                    textDecoration: isRevealed ? "none" : "underline",
                    textDecorationStyle: isRevealed ? undefined : "dashed",
                    textDecorationColor: isRevealed ? undefined : "rgba(251,191,36,0.6)",
                    cursor: "pointer",
                  }}
                  onMouseEnter={() => fetchAndPlayAudio(entry.allHints[seg.hintIndex!].learning, learningLocale)}
                  onMouseLeave={() => stopAudio()}
                >
                  {seg.text}
                </span>
              );
            })}
          </div>
        </div>

        {/* Section 2: You Said */}
        {!entry.skipped && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.4 }}>You Said</div>
              {entry.acceptedTranslations.slice(0, 2).map((_, n) => (
                <button key={n}
                  onMouseEnter={() => setPreviewExampleIndex(n)}
                  onMouseLeave={() => setPreviewExampleIndex(null)}
                  style={{
                    fontSize: 10, padding: "1px 7px", borderRadius: 4, cursor: "pointer",
                    background: previewExampleIndex === n ? "rgba(147,197,253,0.2)" : "rgba(255,255,255,0.07)",
                    border: `1px solid ${previewExampleIndex === n ? "rgba(147,197,253,0.5)" : "rgba(255,255,255,0.15)"}`,
                    color: previewExampleIndex === n ? "#93c5fd" : "rgba(255,255,255,0.5)",
                    transition: "all 0.15s",
                  }}
                >[{n + 1}]</button>
              ))}
            </div>
            {previewExampleIndex !== null ? (
              <div style={{ fontSize: 13, lineHeight: 1.7, wordBreak: "break-word" }}>
                {diffExampleVsUser(entry.userAnswer, entry.acceptedTranslations[previewExampleIndex]).map((tok, ti) => (
                  <span key={ti} style={{ color: tok.matched ? "rgba(255,255,255,0.45)" : "#fbbf24", fontWeight: tok.matched ? 400 : 600 }}>
                    {tok.word}{" "}
                  </span>
                ))}
              </div>
            ) : entry.correctionTokens?.length ? (
              renderCorrectionTokens(entry.correctionTokens)
            ) : (
              <div style={{ fontSize: 13, color: entry.isWrongAttempt ? "#fca5a5" : "#86efac" }}>{entry.userAnswer}</div>
            )}
          </div>
        )}

        {/* Section 3: Feedback */}
        {entryIssues.length > 0 && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.4, marginBottom: 4 }}>Feedback</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {renderFeedbackBadges(entryIssues)}
            </div>
          </div>
        )}

        {/* Section 4: Previous attempts */}
        {wrongAttempts.length > 0 && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.4, marginBottom: 6 }}>
              Previous attempts ({wrongAttempts.length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {wrongAttempts.map(wa => {
                const waIssues: FeedbackIssue[] = wa.feedbackIssues?.length
                  ? wa.feedbackIssues
                  : wa.feedbackKey ? [{ feedbackKey: wa.feedbackKey, correctedSnippet: wa.correctedSnippet, feedbackExplanation: wa.feedbackExplanation }]
                  : [];
                return (
                  <div key={wa.entryId} style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.2)" }}>
                    <div style={{ fontSize: 12, color: "#fca5a5", marginBottom: waIssues.length ? 4 : 0 }}>{wa.userAnswer}</div>
                    {wa.correctionTokens?.length ? renderCorrectionTokens(wa.correctionTokens, true) : null}
                    {waIssues.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
                        {renderFeedbackBadges(waIssues, true)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Word selection screen ─────────────────────────────────────────────────
  if (!selectedWord) {
    return (
      <div style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%)",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: 40, fontFamily: "system-ui, sans-serif", color: "white",
      }}>
        {onBack && (
          <button onClick={onBack} style={{
            position: "absolute", top: 20, left: 20,
            padding: "8px 16px", fontSize: 14,
            background: "rgba(255,255,255,0.15)", color: "white",
            border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, cursor: "pointer",
          }}>← Back</button>
        )}
        <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 8, textAlign: "center" }}>Word Drill</h1>
        <p style={{ fontSize: 16, opacity: 0.6, marginBottom: 48, textAlign: "center" }}>Choose a word to practice</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, justifyContent: "center", maxWidth: 900 }}>
          {wordList.map(word => (
            <button key={word.key} onClick={() => handleSelectWord(word.key)}
              style={{
                padding: "28px 36px", background: "rgba(255,255,255,0.06)",
                border: "2px solid rgba(139,92,246,0.35)", borderRadius: 16,
                color: "white", cursor: "pointer", textAlign: "center", minWidth: 180,
                transition: "transform 0.2s, background 0.2s, border-color 0.2s, box-shadow 0.2s",
              }}
              onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-4px)"; e.currentTarget.style.background = "rgba(139,92,246,0.2)"; e.currentTarget.style.borderColor = "rgba(139,92,246,0.7)"; e.currentTarget.style.boxShadow = "0 8px 30px rgba(139,92,246,0.25)"; }}
              onMouseLeave={e => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.borderColor = "rgba(139,92,246,0.35)"; e.currentTarget.style.boxShadow = "none"; }}
            >
              <div style={{ fontSize: 30, fontWeight: 800, marginBottom: 10, color: "#c4b5fd" }}>{word.display}</div>
              <div style={{ fontSize: 13, opacity: 0.65, lineHeight: 1.5 }}>{word.description}</div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Drill screen ──────────────────────────────────────────────────────────

  const resolvedSentenceIds = new Set(history.filter(e => !e.isWrongAttempt).map(e => e.sentenceId));

  const mainColor = answerStatus === "correct"
    ? ((lastCheckResult?.multiplier ?? 1.0) >= 1.0 ? "#86efac" : (lastCheckResult?.multiplier ?? 0) >= 0.7 ? "#fbbf24" : "#f97316")
    : answerStatus === "skipped" ? "#94a3b8" : "#fca5a5";

  const liveIssues: FeedbackIssue[] = lastCheckResult?.feedbackIssues?.length
    ? lastCheckResult.feedbackIssues
    : lastCheckResult?.feedbackKey
      ? [{ feedbackKey: lastCheckResult.feedbackKey, correctedSnippet: lastCheckResult.correctedSnippet, feedbackExplanation: lastCheckResult.feedbackExplanation }]
      : [];

  const hints = currentSentence?.hints ?? [];
  const hasHints = hints.length > 0;

  return (
    <div style={{
      height: "100vh",
      background: "linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%)",
      display: "flex", flexDirection: "column",
      fontFamily: "system-ui, sans-serif", color: "white", overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        flexShrink: 0, background: "rgba(255,255,255,0.07)",
        padding: "10px 20px", display: "flex", justifyContent: "space-between", alignItems: "center",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => { stopAudio(); setSelectedWord(null); setCurrentSentence(null); setHistory([]); }}
            style={{ padding: "6px 14px", fontSize: 14, background: "rgba(255,255,255,0.12)", color: "white", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, cursor: "pointer" }}>
            ← Words
          </button>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
            Word Drill: <span style={{ color: "#c4b5fd" }}>{wordList.find(w => w.key === selectedWord)?.display ?? selectedWord}</span>
          </h2>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {totalCount > 0 && <div style={{ fontSize: 13, opacity: 0.65 }}>{correctCount}/{totalCount} correct</div>}
          {totalCostCents > 0 && <div style={{ fontSize: 12, opacity: 0.45, fontVariantNumeric: "tabular-nums" }}>{totalCostCents.toFixed(2)}¢</div>}
          {onBack && (
            <button onClick={() => { stopAudio(); onBack(); }}
              style={{ padding: "6px 14px", fontSize: 14, background: "rgba(255,255,255,0.08)", color: "white", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, cursor: "pointer" }}>
              Home
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* LEFT — prompt + hints + input */}
        <div style={{ flex: "0 0 66%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ flex: 1, overflowY: "auto", padding: "20px 28px 0", display: "flex", flexDirection: "column", gap: 14 }}>
            {loadingSentence ? (
              <div style={{ textAlign: "center", opacity: 0.5, paddingTop: 60, fontSize: 16 }}>Loading sentence…</div>
            ) : currentSentence ? (
              <>
                {/* Category */}
                <div>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 999,
                    background: "rgba(139,92,246,0.2)", border: "1px solid rgba(139,92,246,0.4)",
                    color: "#c4b5fd", textTransform: "uppercase", letterSpacing: "0.06em",
                  }}>
                    {currentSentence.category}
                  </span>
                </div>

                {/* Context */}
                <div style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "12px 16px" }}>
                  <div style={{ fontSize: 12, opacity: 0.45, marginBottom: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Context</div>
                  <div style={{ fontSize: 15, opacity: 0.8, lineHeight: 1.5, fontStyle: "italic" }}>{currentSentence.context}</div>
                </div>

                {/* English sentence */}
                <div style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 12, padding: "20px 24px", textAlign: "center" }}>
                  <div style={{ fontSize: 12, opacity: 0.45, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
                    Translate to {learning.name}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.4 }}>
                    {tokenizeWithHints(currentSentence.english, hints).map((tok, ti) => {
                      if (tok.hintIndex === null) return <span key={ti}>{tok.text}</span>;
                      const isRevealed = viewedHints.has(tok.hintIndex);
                      return (
                        <span key={ti} style={{
                          color: isRevealed ? HINT_COLORS[tok.hintIndex % HINT_COLORS.length] : "inherit",
                          borderBottom: isRevealed ? "none" : "2px dashed #fbbf24",
                          cursor: "default",
                        }}>{tok.text}</span>
                      );
                    })}
                  </div>
                </div>

                {/* Hints (shown only when present) */}
                {hasHints && (
                  <div
                    onMouseMove={handleHintsMouseMove}
                    onMouseLeave={() => { setClosestHintIndex(null); setClosestHintOpacity(0); stopAudio(); }}
                  >
                    <div style={{ fontSize: 11, opacity: 0.4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Hints</div>
                    <div style={{ display: "flex", gap: 10, overflowX: "auto", padding: "4px 0" }}>
                      {hints.map((hint, idx) => {
                        const isRevealed = viewedHints.has(idx);
                        const isClosest = closestHintIndex === idx && !isRevealed;
                        const proximityBorder = isClosest ? `2px solid rgba(0,212,255,${Math.max(0.3, closestHintOpacity)})` : undefined;
                        const proximityBg = isClosest ? `rgba(0,212,255,${0.15 * closestHintOpacity})` : undefined;
                        const learningParts = hint.learning.split("/").map(p => p.trim()).filter(Boolean);
                        return (
                          <div key={idx} ref={el => { hintCardsRefs.current[idx] = el; }}
                            style={{
                              flexShrink: 0, width: 130, display: "flex", flexDirection: "column",
                              border: isRevealed ? "2px solid rgba(255,255,255,0.3)" : proximityBorder || "2px solid #FFD700",
                              borderRadius: 8, padding: "8px 12px 6px",
                              background: isRevealed ? "rgba(255,255,255,0.1)" : proximityBg || "rgba(255,215,0,0.1)",
                              transition: "all 0.3s ease",
                              boxShadow: isRevealed ? "none" : "0 2px 8px rgba(255,215,0,0.2)",
                            }}
                          >
                            <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 14, color: isRevealed ? "#9ca3af" : "white" }}>
                              {hint.native}
                            </div>
                            {isRevealed ? (
                              <div style={{ marginBottom: 6, flex: 1 }}>
                                {learningParts.length > 1
                                  ? <ol style={{ margin: 0, padding: "0 0 0 16px", color: "#93c5fd", fontSize: 12, fontWeight: 500 }}>{learningParts.map((p, pi) => <li key={pi}>{p}</li>)}</ol>
                                  : <div style={{ color: "#93c5fd", fontSize: 12, fontWeight: 500 }}>{hint.learning}</div>}
                                {hint.note && <div style={{ fontSize: 10, fontStyle: "italic", color: "rgba(255,255,255,0.45)", marginTop: 4 }}>{hint.note}</div>}
                              </div>
                            ) : (
                              <button
                                onMouseEnter={() => setViewedHints(prev => new Set([...prev, idx]))}
                                style={{
                                  width: "100%", padding: "6px 8px", fontSize: 12, borderRadius: 6, cursor: "pointer",
                                  textAlign: "center", fontWeight: 600, marginBottom: 6, flex: 1, minHeight: 44,
                                  background: "rgba(147,197,253,0.08)", border: "1px dashed rgba(147,197,253,0.3)",
                                  color: "rgba(147,197,253,0.5)",
                                }}
                              >Aa</button>
                            )}
                            <button
                              onMouseEnter={() => fetchAndPlayAudio(hint.learning.split("/")[0].trim(), learningLocale)}
                              onMouseLeave={() => stopAudio()}
                              style={{
                                width: "100%", padding: "5px 8px", fontSize: 13, borderRadius: 6, cursor: "pointer",
                                textAlign: "center", background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.15)",
                                color: "rgba(255,255,255,0.55)", transition: "all 0.15s",
                              }}
                            >🔊</button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            ) : null}
          </div>

          {/* Sticky bottom — feedback + textarea */}
          {currentSentence && (
            <div style={{
              flexShrink: 0, padding: "14px 28px 20px",
              borderTop: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(0,0,0,0.3)",
              display: "flex", flexDirection: "column", gap: 10,
            }}>
              {/* Live feedback */}
              {(feedbackMessage || liveIssues.length > 0 || lastCheckResult?.correctionTokens) && (
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {feedbackMessage && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {answerStatus === "correct" && <span style={{ fontSize: 18, color: mainColor }}>✓</span>}
                      {answerStatus === "skipped" && <span style={{ fontSize: 16, opacity: 0.6 }}>→</span>}
                      <span style={{ fontSize: 14, fontWeight: 600, color: mainColor }}>{feedbackMessage}</span>
                    </div>
                  )}
                  {liveIssues.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {renderFeedbackBadges(liveIssues)}
                    </div>
                  )}
                  {lastCheckResult?.correctionTokens?.length ? renderCorrectionTokens(lastCheckResult.correctionTokens) : null}
                </div>
              )}

              {/* Textarea */}
              <textarea
                ref={textareaRef}
                value={transcript}
                onChange={e => setTranscript(e.target.value)}
                onMouseEnter={() => { if (answerStatus === "idle" && !busy) textareaRef.current?.focus(); }}
                onKeyDown={e => { if (e.key === "Escape") { cancelPendingAutoSend(true); return; } if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitAnswer(); } }}
                placeholder={`Say or type the ${learning.name} translation…`}
                disabled={busy || answerStatus === "correct" || answerStatus === "skipped"}
                autoFocus
                style={{
                  width: "100%", minHeight: 60, padding: 12, fontSize: 16,
                  border: "2px solid rgba(255,255,255,0.18)", borderRadius: 8,
                  resize: "none", fontFamily: "system-ui, sans-serif",
                  boxSizing: "border-box", background: "rgba(0,0,0,0.4)", color: "white", outline: "none",
                  opacity: (busy || answerStatus === "correct" || answerStatus === "skipped") ? 0.5 : 1,
                }}
              />

              {/* Buttons */}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => { setTranscript(""); textareaRef.current?.focus(); }}
                  disabled={!transcript || busy}
                  style={{ padding: "8px 16px", fontSize: 14, background: "rgba(255,255,255,0.1)", color: "white", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 6, cursor: transcript && !busy ? "pointer" : "not-allowed", opacity: transcript && !busy ? 1 : 0.4 }}>
                  Clear
                </button>
                {(answerStatus === "correct" || answerStatus === "skipped") ? (
                  <button
                    onClick={() => {
                      if (autoNextTimerRef.current) { window.clearInterval(autoNextTimerRef.current); autoNextTimerRef.current = null; }
                      setAutoNextProgress(null);
                      handleNext();
                    }}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 20px", fontSize: 14, fontWeight: 700, background: "linear-gradient(135deg, #8b5cf6, #6d28d9)", color: "white", border: "none", borderRadius: 6, cursor: "pointer" }}
                  >
                    {autoNextProgress !== null && (() => {
                      const r = 10, circ = 2 * Math.PI * r;
                      return (
                        <svg width={26} height={26} style={{ transform: "rotate(-90deg)", flexShrink: 0 }}>
                          <circle cx={13} cy={13} r={r} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth={2.5} />
                          <circle cx={13} cy={13} r={r} fill="none" stroke="white" strokeWidth={2.5}
                            strokeDasharray={circ} strokeDashoffset={circ * (1 - autoNextProgress)}
                            strokeLinecap="round" />
                        </svg>
                      );
                    })()}
                    Next →
                  </button>
                ) : (
                  <>
                    <button onClick={handleSkip} disabled={busy}
                      style={{ padding: "8px 16px", fontSize: 14, background: "rgba(255,255,255,0.06)", color: "#94a3b8", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, cursor: !busy ? "pointer" : "not-allowed", opacity: !busy ? 1 : 0.35 }}>
                      Skip
                    </button>
                    {pendingAutoSend ? (
                      <button onClick={() => cancelPendingAutoSend(true)}
                        style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 22px", fontSize: 14, fontWeight: 600, background: "linear-gradient(135deg, #d97706, #b45309)", color: "white", border: "none", borderRadius: 6, cursor: "pointer" }}>
                        {pendingProgress !== null && (() => {
                          const r = 10, circ = 2 * Math.PI * r;
                          return (
                            <svg width={26} height={26} style={{ transform: "rotate(-90deg)", flexShrink: 0 }}>
                              <circle cx={13} cy={13} r={r} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth={2.5} />
                              <circle cx={13} cy={13} r={r} fill="none" stroke="white" strokeWidth={2.5}
                                strokeDasharray={circ} strokeDashoffset={circ * (1 - pendingProgress)}
                                strokeLinecap="round" />
                            </svg>
                          );
                        })()}
                        Cancel
                      </button>
                    ) : (
                      <button onClick={() => void submitAnswer()} disabled={!transcript || busy}
                        style={{ padding: "8px 22px", fontSize: 14, fontWeight: 600, background: transcript && !busy ? "linear-gradient(135deg, #3b82f6, #2563eb)" : "rgba(255,255,255,0.1)", color: "white", border: "none", borderRadius: 6, cursor: transcript && !busy ? "pointer" : "not-allowed", opacity: transcript && !busy ? 1 : 0.4 }}>
                        {busy ? "Checking…" : "Send"}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT — History log */}
        <div style={{ flex: "0 0 34%", display: "flex", flexDirection: "column", borderLeft: "1px solid rgba(255,255,255,0.08)", overflow: "hidden" }}>
          <div style={{ flexShrink: 0, padding: "10px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)", fontSize: 11, fontWeight: 600, opacity: 0.5, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            History
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px 40px", display: "flex", flexDirection: "column", gap: 8 }}>
            {history.map((entry, i) => {
              if (entry.isWrongAttempt && resolvedSentenceIds.has(entry.sentenceId)) return null;

              const wrongAttempts = !entry.isWrongAttempt
                ? history.filter(e => e.sentenceId === entry.sentenceId && e.isWrongAttempt)
                : [];

              const isPinned = pinnedLogEntries.has(i);
              const isExpanded = expandedLogEntry === i || isPinned;

              const entryBg = entry.skipped ? "rgba(148,163,184,0.15)" : entry.isWrongAttempt ? "rgba(239,68,68,0.15)" : "rgba(59,130,246,0.2)";
              const entryBorder = isPinned ? "1px solid rgba(59,130,246,0.6)" : entry.skipped ? "1px solid rgba(148,163,184,0.2)" : entry.isWrongAttempt ? "1px solid rgba(239,68,68,0.25)" : "1px solid rgba(59,130,246,0.3)";

              const qualityHue = entry.qualityScore != null ? Math.round((entry.qualityScore / 100) * 217) : 0;
              const qualityFill = `hsl(${qualityHue},80%,58%)`;
              const totalHints = entry.allHints.length;
              const hintsUnusedPct = totalHints > 0 ? Math.round(((totalHints - (entry.hintsUsed ?? 0)) / totalHints) * 100) : 0;

              return (
                <div key={entry.entryId}
                  style={{
                    padding: "8px 12px", borderRadius: 10,
                    background: entryBg, border: entryBorder,
                    fontSize: 13, lineHeight: 1.4, wordBreak: "break-word",
                    cursor: "pointer", transition: "max-width 0.2s, width 0.2s",
                    maxWidth: isExpanded ? "92%" : "75%",
                    width: isExpanded ? "92%" : undefined,
                  }}
                  onMouseEnter={() => {
                    void fetchAndPlayAudio(entry.correctAnswer, learningLocale);
                    if (expandTimerRef.current) clearTimeout(expandTimerRef.current);
                    expandTimerRef.current = window.setTimeout(() => setExpandedLogEntry(i), 250);
                  }}
                  onMouseLeave={() => {
                    stopAudio();
                    if (expandTimerRef.current) clearTimeout(expandTimerRef.current);
                    if (!isPinned) setExpandedLogEntry(null);
                  }}
                  onClick={() => {
                    setPinnedLogEntries(prev => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i); else next.add(i);
                      return next;
                    });
                  }}
                >
                  {/* Line 1: status icon + bars + category */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {entry.skipped ? (
                      <span style={{ fontSize: 12, color: "#94a3b8" }}>→</span>
                    ) : (
                      <>
                        <span style={{ fontSize: 13, color: entry.isWrongAttempt ? "#fca5a5" : "#86efac" }}>
                          {entry.isWrongAttempt ? "✗" : "✓"}
                        </span>
                        {!entry.isWrongAttempt && entry.qualityScore != null && (
                          <div style={{ width: 56, height: 5, borderRadius: 3, background: "rgba(255,255,255,0.2)", overflow: "hidden", border: `1px solid ${qualityFill}66` }}>
                            <div style={{ height: "100%", width: `${entry.qualityScore}%`, background: qualityFill, transition: "width 0.3s" }} />
                          </div>
                        )}
                        {totalHints > 0 && (
                          <div style={{ width: 56, height: 5, borderRadius: 3, background: "rgba(255,255,255,0.2)", overflow: "hidden", border: "1px solid rgba(251,191,36,0.4)" }}>
                            <div style={{ height: "100%", width: `${hintsUnusedPct}%`, background: "#fbbf24", transition: "width 0.3s" }} />
                          </div>
                        )}
                        {entry.llmUsed && <span style={{ fontSize: 11, opacity: 0.5 }}>🤖</span>}
                      </>
                    )}
                    <span style={{ marginLeft: "auto", fontSize: 10, opacity: 0.35, fontWeight: 600, textAlign: "right" }}>{entry.category}</span>
                  </div>

                  {/* Line 2: English prompt */}
                  <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4, fontStyle: "italic" }}>{entry.english}</div>

                  {/* Line 3: Answer with correction tokens (or plain if no diff) */}
                  <div style={{ marginTop: 3, fontWeight: 500, lineHeight: 1.4, fontSize: 13 }}>
                    {entry.skipped ? (
                      <span style={{ color: "#94a3b8" }}>{entry.correctAnswer}</span>
                    ) : entry.correctionTokens?.length ? (
                      entry.correctionTokens.map((tok, ti) => (
                        <span key={ti} style={{
                          color: tok.status === "remove" ? "#fca5a5" : tok.status === "add" ? "#86efac" : "rgba(255,255,255,0.85)",
                          textDecoration: tok.status === "remove" ? "line-through" : "none",
                          fontWeight: tok.status === "add" ? 700 : 400,
                        }}>{tok.text}{" "}</span>
                      ))
                    ) : (
                      <span style={{ color: entry.isWrongAttempt ? "#fca5a5" : "rgba(255,255,255,0.9)" }}>
                        {entry.userAnswer || "—"}
                      </span>
                    )}
                  </div>

                  {/* Expanded content */}
                  {isExpanded && renderExpandedHistoryEntry(entry, wrongAttempts)}
                </div>
              );
            })}
            <div ref={historyEndRef} />
          </div>
        </div>

      </div>
    </div>
  );
}
