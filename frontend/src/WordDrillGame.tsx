// WordDrillGame.tsx
// Practice specific words/phrases with LLM feedback — follows Common Mode Features spec
import { useEffect, useRef, useState } from "react";
import { normalizeNumberTokens } from "./numUtils";

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
  userAnswer?: string;
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

type GrammarTag = { type: string; label: string };
type BulletItem = string | { text: string; audio?: string };

type UseCase = {
  id: number;
  name: string;
  english?: string;
  explanation: string;
  brief?: string;
  explanation_bullets?: BulletItem[];
  grammar_tags?: GrammarTag[];
  demo: { context: string; native: string; spanish: string };
  practice: {
    context: string;
    english: string;
    spanish: string;
    accepted_translations: string[];
    hints: HintItem[];
  };
};

type UseCaseStatus = "pending" | "correct" | "close" | "skipped";
type GameMode = "practice" | "learn";

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

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Shared helper functions (from BattleGame.tsx) ────────────────────────────

function normalizeForMatch(text: string, langCode: string): string {
  return normalizeNumberTokens(text, langCode)
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[¿¡.,!?;:"""'']/g, "")
    .replace(/\s/g, "");
}

function checkFuzzyMatch(userAnswer: string, accepted: string[], langCode: string): string | null {
  const n = normalizeForMatch(userAnswer, langCode);
  return accepted.find(a => normalizeForMatch(a, langCode) === n) ?? null;
}

// Restores accent marks in LLM correction tokens using the canonical accepted translations.
function restoreAccentsInTokens(
  tokens: Array<{ text: string; status: "ok" | "remove" | "add" }>,
  acceptedTranslations: string[],
  langCode: string
): Array<{ text: string; status: "ok" | "remove" | "add" }> {
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

function findUsecaseForCategory(category: string, usecases: UseCase[]): number {
  const norm = (s: string) =>
    s.toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
  const sig = (s: string) => norm(s).split(" ").filter(w => w.length > 2);
  const normCat = norm(category);
  const catWords = new Set(sig(category));
  let bestIdx = -1, bestScore = 0;
  usecases.forEach((uc, i) => {
    const normUC = norm(uc.name);
    const direct = normCat.includes(normUC);
    const overlap = sig(uc.name).filter(w => catWords.has(w)).length;
    const score = direct ? overlap + 10 : overlap;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  });
  return bestScore >= 2 ? bestIdx : -1;
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
  // Language picker — null means not yet chosen
  const [drillLang, setDrillLang] = useState<"es" | "id" | null>(null);
  const activeLearning: LangSpec = drillLang === "id"
    ? { code: "id", name: "Indonesian" }
    : drillLang === "es"
    ? { code: "es", name: "Spanish" }
    : learning;
  const learningLocale = LEARNING_LOCALE[activeLearning.code] ?? "es-MX";

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
  const sentenceQueueRef = useRef<Sentence[]>([]);
  const [loadingSentence, setLoadingSentence] = useState(false);
  const [correctCount, setCorrectCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [totalSentences, setTotalSentences] = useState(0);
  const [roundSentencesShown, setRoundSentencesShown] = useState(0);
  const [hasCompletedRound, setHasCompletedRound] = useState(false);

  // Hints state
  const [viewedHints, setViewedHints] = useState<Set<number>>(new Set());
  const [closestHintIndex, setClosestHintIndex] = useState<number | null>(null);
  const [closestHintOpacity, setClosestHintOpacity] = useState<number>(0);

  // Grammar chat state
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<{ role: "user" | "ai"; text: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

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

  // Learn mode state
  const [gameMode, setGameMode] = useState<GameMode | null>(null);
  const [learnUsecases, setLearnUsecases] = useState<UseCase[]>([]);
  const [currentUsecaseIdx, setCurrentUsecaseIdx] = useState(0);
  const [usecaseStatuses, setUsecaseStatuses] = useState<UseCaseStatus[]>([]);
  const [hoveredNavIdx, setHoveredNavIdx] = useState<number | null>(null);
  const [learnComplete, setLearnComplete] = useState(false);
  const [learnPhase, setLearnPhase] = useState<"explanation" | "demo" | "practice">("explanation");
  const [showAllPhases, setShowAllPhases] = useState(false);
  const [canReturnToPractice, setCanReturnToPractice] = useState(false);
  // Demo animation step: 0=hidden, 1=context, 2=EN, 3=audio playing (ES hidden), 4=ES revealed
  const [demoAnimStep, setDemoAnimStep] = useState(0);
  // Bullet-by-bullet reveal: how many bullets are visible
  const [bulletRevealIdx, setBulletRevealIdx] = useState(0);
  // Audio state for the most recently revealed bullet with audio: 0=pending, 1=playing, 2=text shown
  const [bulletAudioStep, setBulletAudioStep] = useState<0|1|2>(0);
  // Whether to display the target language text after audio (can be toggled off by user)
  const [showTargetText, setShowTargetText] = useState(true);
  // Whether the ES reveal area is currently hovered (when showTargetText=false)
  const [esHovered, setEsHovered] = useState(false);

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
  const autoNextDurationRef = useRef(1000);

  // Refs for stale-closure safety in timers
  const gameModeRef = useRef<GameMode | null>(null);
  const learnUsecasesRef = useRef<UseCase[]>([]);
  const currentUsecaseIdxRef = useRef(0);
  const learnPhaseRef = useRef<"explanation" | "demo" | "practice">("explanation");
  const showAllPhasesRef = useRef(false);
  const usecaseStatusesRef = useRef<UseCaseStatus[]>([]);
  const learnPracticeEndRef = useRef<HTMLDivElement>(null);
  const returnToPracticeRef = useRef<{ sentence: Sentence; queue: Sentence[] } | null>(null);
  const demoAnimStepRef = useRef(0);
  const bulletRevealIdxRef = useRef(0);
  const bulletAudioTimerRef = useRef<number | null>(null);

  // ── Effects ──────────────────────────────────────────────────────────────

  // Keep refs in sync with state
  useEffect(() => { gameModeRef.current = gameMode; }, [gameMode]);
  useEffect(() => { learnUsecasesRef.current = learnUsecases; }, [learnUsecases]);
  useEffect(() => { currentUsecaseIdxRef.current = currentUsecaseIdx; }, [currentUsecaseIdx]);
  useEffect(() => { learnPhaseRef.current = learnPhase; }, [learnPhase]);
  useEffect(() => { showAllPhasesRef.current = showAllPhases; }, [showAllPhases]);
  useEffect(() => { usecaseStatusesRef.current = usecaseStatuses; }, [usecaseStatuses]);

  useEffect(() => {
    if (!drillLang) return;
    fetch(`${apiBase}/api/worddrill/words?lang=${drillLang}`)
      .then(r => r.json())
      .then(data => setWordList(data.words ?? []))
      .catch(() => setWordList([]));
  }, [apiBase, drillLang]);

  useEffect(() => {
    if (currentSentence && answerStatus === "idle" && !busy) {
      textareaRef.current?.focus();
    }
  }, [currentSentence, answerStatus, busy]);

  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history.length]);

  // Auto-advance to next sentence/use-case after a correct answer (disabled in learn mode)
  useEffect(() => {
    if (answerStatus === "correct" && gameModeRef.current !== "learn") {
      const startTime = Date.now();
      const DURATION = autoNextDurationRef.current;
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

  function startPendingAutoSend(duration = 2000) {
    cancelPendingAutoSend();
    const DURATION = duration;
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
        const isMatch = currentSentence
          ? checkFuzzyMatch(transcript.trim(), currentSentence.accepted_translations, activeLearning.code) !== null
          : false;
        startPendingAutoSend(isMatch ? 1000 : 2000);
      }
    }
    previousLengthRef.current = transcript.length;
    return () => cancelPendingAutoSend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcript]);

  // Demo phase animation: reveal context → EN → play audio → reveal ES text
  useEffect(() => {
    if (gameMode !== "learn" || learnPhase !== "demo") return;

    let alive = true;
    demoAnimStepRef.current = 1;
    setDemoAnimStep(1);

    const advance = (step: number) => {
      if (!alive || demoAnimStepRef.current >= step) return;
      demoAnimStepRef.current = step;
      setDemoAnimStep(step);
    };

    const t2 = window.setTimeout(() => advance(2), 1700);
    const t3 = window.setTimeout(() => {
      advance(3);
      const uc = learnUsecasesRef.current[currentUsecaseIdxRef.current];
      if (uc && alive) {
        void fetchAndPlayAudio(uc.demo.spanish, learningLocale, () => {
          window.setTimeout(() => advance(4), 400);
        });
      }
    }, 3000);
    const t4 = window.setTimeout(() => advance(4), 11000); // fallback if onEnded never fires

    return () => {
      alive = false;
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      window.clearTimeout(t4);
      stopAudio();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [learnPhase, gameMode]);

  // Bullet audio: when a new bullet is revealed, auto-play its audio after a short delay
  useEffect(() => {
    if (gameMode !== "learn" || learnPhase !== "explanation" || bulletRevealIdx === 0) return;
    const bullets = learnUsecasesRef.current[currentUsecaseIdxRef.current]?.explanation_bullets ?? [];
    const bullet = bullets[bulletRevealIdx - 1];
    const audioText = typeof bullet === "object" && bullet.audio ? bullet.audio : null;
    if (!audioText) { setBulletAudioStep(0); return; }

    setBulletAudioStep(0);
    if (bulletAudioTimerRef.current) window.clearTimeout(bulletAudioTimerRef.current);
    bulletAudioTimerRef.current = window.setTimeout(() => {
      setBulletAudioStep(1);
      void fetchAndPlayAudio(audioText, learningLocale, () => {
        setBulletAudioStep(showTargetText ? 2 : 1);
      });
    }, 500);

    return () => {
      if (bulletAudioTimerRef.current) { window.clearTimeout(bulletAudioTimerRef.current); bulletAudioTimerRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulletRevealIdx, learnPhase, gameMode]);

  // Space/Enter advances learn phases (disabled in "practice" so textarea works normally)
  useEffect(() => {
    if (gameMode !== "learn" || learnPhase === "practice") return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      if (learnPhaseRef.current === "explanation") {
        const bullets = learnUsecasesRef.current[currentUsecaseIdxRef.current]?.explanation_bullets ?? [];
        // Cancel pending bullet audio timer and stop audio
        if (bulletAudioTimerRef.current) { window.clearTimeout(bulletAudioTimerRef.current); bulletAudioTimerRef.current = null; }
        stopAudio();
        if (bulletRevealIdxRef.current < bullets.length) {
          bulletRevealIdxRef.current++;
          setBulletRevealIdx(bulletRevealIdxRef.current);
        } else {
          learnPhaseRef.current = "demo";
          setLearnPhase("demo");
        }
      } else if (learnPhaseRef.current === "demo") {
        if (demoAnimStepRef.current < 4) {
          // Skip animation — show everything instantly
          stopAudio();
          demoAnimStepRef.current = 4;
          setDemoAnimStep(4);
        } else {
          // Fully revealed — advance to practice
          learnPhaseRef.current = "practice";
          setLearnPhase("practice");
        }
      } else if (showAllPhasesRef.current) {
        learnPhaseRef.current = "practice";
        setLearnPhase("practice");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gameMode, learnPhase]);

  // Space/Enter advances to next use case after a correct/skipped answer in learn mode
  useEffect(() => {
    if (gameMode !== "learn" || learnPhase !== "practice") return;
    if (answerStatus !== "correct" && answerStatus !== "skipped") return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      handleNext();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameMode, learnPhase, answerStatus]);

  // Scroll to the practice input when entering the practice phase
  useEffect(() => {
    if (gameMode === "learn" && learnPhase === "practice") {
      requestAnimationFrame(() => {
        learnPracticeEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      });
    }
  }, [learnPhase, gameMode]);

  // When "Show all" is toggled on, jump to practice phase immediately
  useEffect(() => {
    if (showAllPhases && gameMode === "learn" && learnPhaseRef.current !== "practice") {
      learnPhaseRef.current = "practice";
      setLearnPhase("practice");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAllPhases]);

  // Arrow keys navigate between use cases in learn mode
  useEffect(() => {
    if (gameMode !== "learn") return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // Don't steal from an active, enabled textarea
      if (document.activeElement === textareaRef.current && !textareaRef.current?.disabled) return;
      const delta = e.key === "ArrowRight" ? 1 : -1;
      const nextIdx = currentUsecaseIdxRef.current + delta;
      if (nextIdx < 0 || nextIdx >= learnUsecasesRef.current.length) return;
      e.preventDefault();
      const alreadyDone = usecaseStatusesRef.current[nextIdx] !== "pending";
      setLearnComplete(false);
      navigateToUsecase(nextIdx, alreadyDone || showAllPhasesRef.current);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameMode]);

  // ── Grammar chat ──────────────────────────────────────────────────────────

  async function sendChat() {
    if (!chatInput.trim() || chatBusy) return;
    const userMsg = chatInput.trim();
    setChatInput("");
    const nextMessages = [...chatMessages, { role: "user" as const, text: userMsg }];
    setChatMessages(nextMessages);
    setChatBusy(true);
    setTimeout(() => chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    try {
      const resp = await fetch(`${apiBase}/api/worddrill/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.map(m => ({ role: m.role === "ai" ? "assistant" : "user", content: m.text })),
          context: {
            english: currentSentence?.english ?? "",
            correct_answer: currentSentence?.accepted_translations?.[0] ?? "",
            user_answer: lastCheckResult?.userAnswer ?? "",
            feedback_key: lastCheckResult?.feedbackKey ?? "",
            feedback_explanation: lastCheckResult?.feedbackExplanation ?? "",
            word_key: selectedWord ?? "",
            learning_lang: learning.name,
            fluent_lang: fluent.name,
          },
        }),
      });
      const data = await resp.json();
      setChatMessages(prev => [...prev, { role: "ai", text: data.reply ?? "" }]);
      setTimeout(() => chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    } catch {
      setChatMessages(prev => [...prev, { role: "ai", text: "Sorry, something went wrong. Please try again." }]);
    } finally {
      setChatBusy(false);
      setTimeout(() => chatInputRef.current?.focus(), 50);
    }
  }

  // ── Audio helpers ─────────────────────────────────────────────────────────

  function stopAudio() {
    if (currentAudioRef.current) { currentAudioRef.current.pause(); currentAudioRef.current = null; }
  }

  async function fetchAndPlayAudio(text: string, locale: string, onEnded?: () => void) {
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
    if (onEnded) {
      audio.onended = onEnded;
      audio.onerror = onEnded;
    }
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

  function advanceToNextSentence() {
    if (sentenceQueueRef.current.length === 0) return;
    const sentence = sentenceQueueRef.current.shift()!;
    setRoundSentencesShown(n => n + 1);
    setCurrentSentence(sentence);
    setTranscript("");
    setAnswerStatus("idle");
    setFeedbackMessage("");
    setLastCheckResult(null);
    setViewedHints(new Set());
    setClosestHintIndex(null);
    setClosestHintOpacity(0);
    setChatMessages([]);
    setChatOpen(false);
    previousLengthRef.current = 0;
    hintCardsRefs.current = new Array((sentence.hints ?? []).length).fill(null);
  }

  async function loadSentencesForWord(word: string) {
    setLoadingSentence(true);
    setBusy(true);
    try {
      const resp = await fetch(`${apiBase}/api/worddrill/sentences/${encodeURIComponent(word)}?lang=${drillLang ?? "es"}`);
      if (!resp.ok) throw new Error("Failed");
      const data = await resp.json();
      sentenceQueueRef.current = shuffle([...data.sentences]);
      if (totalSentences > 0) setHasCompletedRound(true);
      setTotalSentences(data.sentences.length);
      setRoundSentencesShown(0);
      advanceToNextSentence();
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingSentence(false);
      setBusy(false);
    }
  }

  async function loadLearnData(word: string, jumpToCategory?: string) {
    setBusy(true);
    try {
      const resp = await fetch(`${apiBase}/api/worddrill/usecases/${encodeURIComponent(word)}?lang=${drillLang ?? "es"}`);
      if (!resp.ok) throw new Error("Failed");
      const data = await resp.json();
      const usecases: UseCase[] = data.usecases ?? [];
      learnUsecasesRef.current = usecases;
      setLearnUsecases(usecases);
      setUsecaseStatuses(new Array(usecases.length).fill("pending"));
      setLearnComplete(false);
      if (usecases.length > 0) {
        let targetIdx = 0;
        if (jumpToCategory) {
          const found = findUsecaseForCategory(jumpToCategory, usecases);
          if (found !== -1) targetIdx = found;
        }
        currentUsecaseIdxRef.current = targetIdx;
        setCurrentUsecaseIdx(targetIdx);
        enterUsecase(usecases, targetIdx);
        if (jumpToCategory) {
          learnPhaseRef.current = "practice";
          setLearnPhase("practice");
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  }

  function enterUsecase(usecases: UseCase[], idx: number) {
    const uc = usecases[idx];
    setCurrentSentence({
      id: uc.id,
      category: uc.name,
      context: uc.practice.context,
      english: uc.practice.english,
      spanish: uc.practice.spanish,
      accepted_translations: uc.practice.accepted_translations,
      hints: uc.practice.hints ?? [],
    });
    setTranscript("");
    setAnswerStatus("idle");
    setFeedbackMessage("");
    setLastCheckResult(null);
    setViewedHints(new Set());
    setClosestHintIndex(null);
    setClosestHintOpacity(0);
    previousLengthRef.current = 0;
    hintCardsRefs.current = new Array((uc.practice.hints ?? []).length).fill(null);
    learnPhaseRef.current = "explanation";
    setLearnPhase("explanation");
    demoAnimStepRef.current = 0;
    setDemoAnimStep(0);
    bulletRevealIdxRef.current = 0;
    setBulletRevealIdx(0);
    setBulletAudioStep(0);
    if (bulletAudioTimerRef.current) { window.clearTimeout(bulletAudioTimerRef.current); bulletAudioTimerRef.current = null; }
    setEsHovered(false);
    stopAudio();
  }

  function navigateToUsecase(idx: number, jumpToAll = false) {
    currentUsecaseIdxRef.current = idx;
    setCurrentUsecaseIdx(idx);
    enterUsecase(learnUsecasesRef.current, idx);
    if (jumpToAll) {
      learnPhaseRef.current = "practice";
      setLearnPhase("practice");
    }
  }

  function handleSelectWord(wordKey: string) {
    setSelectedWord(wordKey);
    setGameMode(null);
    gameModeRef.current = null;
    setHistory([]);
    setCorrectCount(0);
    setTotalCount(0);
    setTotalSentences(0);
    setRoundSentencesShown(0);
    setHasCompletedRound(false);
    setPinnedLogEntries(new Set());
    sentenceQueueRef.current = [];
    setCurrentSentence(null);
    setLearnComplete(false);
    returnToPracticeRef.current = null;
    setCanReturnToPractice(false);
    stopAudio();
  }

  function handleLearnThis() {
    if (!currentSentence || !selectedWord) return;
    returnToPracticeRef.current = {
      sentence: currentSentence,
      queue: [...sentenceQueueRef.current],
    };
    setCanReturnToPractice(true);
    stopAudio();

    const category = currentSentence.category;
    gameModeRef.current = "learn";
    setGameMode("learn");

    if (learnUsecasesRef.current.length > 0) {
      const idx = findUsecaseForCategory(category, learnUsecasesRef.current);
      const targetIdx = idx !== -1 ? idx : 0;
      navigateToUsecase(targetIdx, true);
    } else {
      void loadLearnData(selectedWord, category);
    }
  }

  function handleReturnToPractice() {
    const saved = returnToPracticeRef.current;
    if (!saved) return;
    returnToPracticeRef.current = null;
    setCanReturnToPractice(false);

    gameModeRef.current = "practice";
    setGameMode("practice");
    setCurrentSentence(saved.sentence);
    sentenceQueueRef.current = saved.queue;
    setTranscript("");
    setAnswerStatus("idle");
    setFeedbackMessage("");
    setLastCheckResult(null);
    setViewedHints(new Set());
    setClosestHintIndex(null);
    setClosestHintOpacity(0);
    previousLengthRef.current = 0;
    hintCardsRefs.current = new Array((saved.sentence.hints ?? []).length).fill(null);
    stopAudio();
  }

  // ── Answer logic ──────────────────────────────────────────────────────────

  async function submitAnswer() {
    if (!currentSentence || busy || answerStatus !== "idle") return;
    const userAnswer = transcript.trim();
    if (!userAnswer) return;

    lastSentRef.current = Date.now();
    setBusy(true);
    setAnswerStatus("checking");

    const fuzzyMatched = checkFuzzyMatch(userAnswer, currentSentence.accepted_translations, activeLearning.code);
    if (fuzzyMatched !== null) {
      resolveCorrect(fuzzyMatched, 1.0, null, null, null, null, null, false);
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
          learning: activeLearning,
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

      const rawTokens = data.correction_tokens ?? null;
      const corrTokens = rawTokens
        ? restoreAccentsInTokens(rawTokens, currentSentence.accepted_translations, activeLearning.code)
        : null;

      if (data.accepted) {
        resolveCorrect(userAnswer, data.damage_multiplier ?? 1.0, data.feedback_key ?? null, data.corrected_snippet ?? null, data.feedback_explanation ?? null, corrTokens, feedbackIssues, true);
      } else {
        const result: CheckResult = { multiplier: 0, feedbackIssues, feedbackKey: data.feedback_key ?? null, correctedSnippet: data.corrected_snippet ?? null, feedbackExplanation: data.feedback_explanation ?? null, correctionTokens: corrTokens, userAnswer };
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
    autoNextDurationRef.current = isPerfect ? 1000 : 3000;
    void fetchAndPlayAudio(currentSentence!.accepted_translations[0], learningLocale);
    const result: CheckResult = { multiplier, feedbackIssues, feedbackKey, correctedSnippet, feedbackExplanation, correctionTokens, userAnswer };
    setLastCheckResult(result);
    setAnswerStatus("correct");
    setFeedbackMessage(isPerfect ? "Perfect!" : "Close enough!");
    setCorrectCount(c => c + 1);
    setTotalCount(t => t + 1);

    // Update use case status in learn mode
    if (gameModeRef.current === "learn") {
      const ucStatus: UseCaseStatus = isPerfect ? "correct" : "close";
      setUsecaseStatuses(prev => {
        const next = [...prev];
        next[currentUsecaseIdxRef.current] = ucStatus;
        return next;
      });
    }

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

    // Update use case status in learn mode
    if (gameModeRef.current === "learn") {
      setUsecaseStatuses(prev => {
        const next = [...prev];
        next[currentUsecaseIdxRef.current] = "skipped";
        return next;
      });
    }

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
    if (gameModeRef.current === "learn") {
      const nextIdx = currentUsecaseIdxRef.current + 1;
      if (nextIdx >= learnUsecasesRef.current.length) {
        setLearnComplete(true);
        setAnswerStatus("idle");
      } else {
        navigateToUsecase(nextIdx);
      }
      return;
    }
    if (!selectedWord) return;
    if (sentenceQueueRef.current.length === 0) {
      void loadSentencesForWord(selectedWord);
    } else {
      advanceToNextSentence();
    }
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

        {entryIssues.length > 0 && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.4, marginBottom: 4 }}>Feedback</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {renderFeedbackBadges(entryIssues)}
            </div>
          </div>
        )}

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

  // ── Floating grammar chat (Messenger style) ──────────────────────────────

  function renderChat() {
    if (!currentSentence) return null;
    return (
      <>
        {/* Floating chat bubble */}
        <button
          onClick={() => { setChatOpen(o => !o); if (!chatOpen) setTimeout(() => chatInputRef.current?.focus(), 80); }}
          style={{
            position: "fixed", bottom: 88, right: 24, zIndex: 101,
            width: 52, height: 52, borderRadius: "50%",
            background: chatOpen ? "#4c1d95" : "linear-gradient(135deg, #7c3aed, #5b21b6)",
            border: "none", cursor: "pointer", color: "white",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: chatOpen ? 18 : 22,
            boxShadow: "0 4px 16px rgba(124,58,237,0.5)",
            transition: "all 0.2s",
          }}
        >
          {chatOpen ? "✕" : "💬"}
        </button>

        {/* Chat panel — floating above the button */}
        {chatOpen && (
          <div style={{
            position: "fixed", bottom: 152, right: 24, zIndex: 100,
            width: 340, height: 500,
            background: "#1e293b",
            borderRadius: 16, border: "1px solid rgba(255,255,255,0.12)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            display: "flex", flexDirection: "column",
            fontFamily: "system-ui, sans-serif", overflow: "hidden",
          }}>
            {/* Header */}
            <div style={{
              flexShrink: 0, padding: "12px 16px",
              borderBottom: "1px solid rgba(255,255,255,0.1)",
              background: "rgba(0,0,0,0.2)",
            }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: "#a78bfa" }}>💬 Grammar Chat</span>
            </div>

            {/* Context summary */}
            <div style={{
              flexShrink: 0, padding: "8px 14px",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(0,0,0,0.15)",
            }}>
              <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "rgba(255,255,255,0.3)", marginBottom: 3 }}>
                Current exercise
              </div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", lineHeight: 1.5 }}>
                <span style={{ color: "rgba(255,255,255,0.4)" }}>EN </span>{currentSentence.english}
              </div>
              <div style={{ fontSize: 12, color: "#86efac", lineHeight: 1.5, marginTop: 1 }}>
                <span style={{ color: "rgba(134,239,172,0.5)" }}>ES </span>{currentSentence.accepted_translations[0]}
              </div>
              {lastCheckResult?.userAnswer && (
                <div style={{ fontSize: 12, color: "#fca5a5", lineHeight: 1.5, marginTop: 1 }}>
                  <span style={{ color: "rgba(252,165,165,0.5)" }}>You </span>{lastCheckResult.userAnswer}
                </div>
              )}
            </div>

            {/* Message list */}
            <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
              {chatMessages.length === 0 && (
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.3)", textAlign: "center", marginTop: 20, lineHeight: 1.7 }}>
                  Ask why an answer is correct,<br />how a grammar rule works,<br />or for more examples.
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} style={{
                  alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "90%",
                  background: msg.role === "user" ? "rgba(139,92,246,0.25)" : "rgba(255,255,255,0.08)",
                  border: msg.role === "user" ? "1px solid rgba(139,92,246,0.4)" : "1px solid rgba(255,255,255,0.1)",
                  borderRadius: msg.role === "user" ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
                  padding: "8px 12px", fontSize: 13, lineHeight: 1.5,
                  color: msg.role === "user" ? "#c4b5fd" : "rgba(255,255,255,0.88)",
                  wordBreak: "break-word",
                }}>
                  {msg.text}
                </div>
              ))}
              {chatBusy && (
                <div style={{
                  alignSelf: "flex-start",
                  background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "12px 12px 12px 4px",
                  padding: "8px 14px", fontSize: 13, color: "rgba(255,255,255,0.4)",
                }}>…</div>
              )}
              <div ref={chatBottomRef} />
            </div>

            {/* Input row */}
            <div style={{
              flexShrink: 0, padding: "10px 14px",
              borderTop: "1px solid rgba(255,255,255,0.1)",
              display: "flex", gap: 8, alignItems: "flex-end",
            }}>
              <textarea
                ref={chatInputRef}
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendChat(); } }}
                placeholder="Ask a grammar question…"
                disabled={chatBusy}
                rows={2}
                style={{
                  flex: 1, padding: "8px 12px", fontSize: 13,
                  background: "rgba(255,255,255,0.07)", color: "white",
                  border: "1px solid rgba(255,255,255,0.15)", borderRadius: 20,
                  resize: "none", fontFamily: "system-ui, sans-serif",
                  outline: "none", boxSizing: "border-box",
                  opacity: chatBusy ? 0.5 : 1,
                }}
              />
              <button
                onClick={() => void sendChat()}
                disabled={chatBusy || !chatInput.trim()}
                style={{
                  width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
                  background: chatInput.trim() && !chatBusy ? "linear-gradient(135deg, #7c3aed, #5b21b6)" : "rgba(255,255,255,0.1)",
                  color: "white", border: "none",
                  cursor: chatInput.trim() && !chatBusy ? "pointer" : "not-allowed",
                  opacity: chatInput.trim() && !chatBusy ? 1 : 0.45,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 16,
                }}
              >➤</button>
            </div>
          </div>
        )}
      </>
    );
  }

  // ── Shared input/feedback block (used in both practice and learn) ──────────

  function renderPracticeBottom() {
    const mainColor = answerStatus === "correct"
      ? ((lastCheckResult?.multiplier ?? 1.0) >= 1.0 ? "#86efac" : (lastCheckResult?.multiplier ?? 0) >= 0.7 ? "#fbbf24" : "#f97316")
      : answerStatus === "skipped" ? "#94a3b8" : "#fca5a5";

    const liveIssues: FeedbackIssue[] = lastCheckResult?.feedbackIssues?.length
      ? lastCheckResult.feedbackIssues
      : lastCheckResult?.feedbackKey
        ? [{ feedbackKey: lastCheckResult.feedbackKey, correctedSnippet: lastCheckResult.correctedSnippet, feedbackExplanation: lastCheckResult.feedbackExplanation }]
        : [];

    return (
      <div style={{
        flexShrink: 0, padding: "14px 28px 20px",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(0,0,0,0.3)",
        display: "flex", flexDirection: "column", gap: 10,
      }}>
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

        <textarea
          ref={textareaRef}
          value={transcript}
          onChange={e => setTranscript(e.target.value)}
          onMouseEnter={() => { if (answerStatus === "idle" && !busy) textareaRef.current?.focus(); }}
          onKeyDown={e => { if (e.key === "Escape") { cancelPendingAutoSend(true); return; } if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitAnswer(); } }}
          placeholder={`Hold CTRL + WIN to say the ${learning.name} translation…`}
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
              {gameModeRef.current === "learn" ? "Next use case →" : "Next →"}
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
    );
  }

  function renderHints() {
    const hints = currentSentence?.hints ?? [];
    if (!hints.length) return null;
    return (
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
    );
  }

  // ── Language picker screen ────────────────────────────────────────────────
  if (!drillLang) {
    const langOptions: { code: "es" | "id"; label: string; sub: string; flag: string }[] = [
      { code: "es", label: "Spanish", sub: "verbs · phrases · particles", flag: "🇲🇽" },
      { code: "id", label: "Indonesian", sub: "deh · sih · pas · lagi", flag: "🇮🇩" },
    ];
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
        <p style={{ fontSize: 16, opacity: 0.6, marginBottom: 40, textAlign: "center" }}>Choose a language</p>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center" }}>
          {langOptions.map(opt => (
            <button key={opt.code} onClick={() => setDrillLang(opt.code)}
              style={{
                padding: "28px 36px", background: "rgba(255,255,255,0.06)",
                border: "2px solid rgba(139,92,246,0.35)", borderRadius: 18,
                color: "white", cursor: "pointer", textAlign: "center", minWidth: 160,
                transition: "background 0.2s, border-color 0.2s, box-shadow 0.2s",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(139,92,246,0.2)"; e.currentTarget.style.borderColor = "rgba(139,92,246,0.7)"; e.currentTarget.style.boxShadow = "0 4px 20px rgba(139,92,246,0.2)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.borderColor = "rgba(139,92,246,0.35)"; e.currentTarget.style.boxShadow = "none"; }}
            >
              <div style={{ fontSize: 40, marginBottom: 10 }}>{opt.flag}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#c4b5fd", marginBottom: 6 }}>{opt.label}</div>
              <div style={{ fontSize: 12, opacity: 0.5, lineHeight: 1.4 }}>{opt.sub}</div>
            </button>
          ))}
        </div>
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
        <button onClick={() => setDrillLang(null)} style={{
          position: "absolute", top: 20, left: 20,
          padding: "8px 16px", fontSize: 14,
          background: "rgba(255,255,255,0.15)", color: "white",
          border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, cursor: "pointer",
        }}>← Language</button>
        <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 8, textAlign: "center" }}>Word Drill</h1>
        <p style={{ fontSize: 16, opacity: 0.6, marginBottom: 8, textAlign: "center" }}>
          {drillLang === "id" ? "🇮🇩 Indonesian" : "🇲🇽 Spanish"}
        </p>
        <p style={{ fontSize: 14, opacity: 0.45, marginBottom: 32, textAlign: "center" }}>Choose a word to practice</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 380 }}>
          {wordList.map(word => (
            <button key={word.key} onClick={() => handleSelectWord(word.key)}
              style={{
                padding: "16px 24px", background: "rgba(255,255,255,0.06)",
                border: "2px solid rgba(139,92,246,0.35)", borderRadius: 14,
                color: "white", cursor: "pointer", textAlign: "left", width: "100%",
                display: "flex", alignItems: "center", gap: 16,
                transition: "background 0.2s, border-color 0.2s, box-shadow 0.2s",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(139,92,246,0.2)"; e.currentTarget.style.borderColor = "rgba(139,92,246,0.7)"; e.currentTarget.style.boxShadow = "0 4px 20px rgba(139,92,246,0.2)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.borderColor = "rgba(139,92,246,0.35)"; e.currentTarget.style.boxShadow = "none"; }}
            >
              <div style={{ fontSize: 22, fontWeight: 800, color: "#c4b5fd", minWidth: 80 }}>{word.display}</div>
              <div style={{ fontSize: 13, opacity: 0.55, lineHeight: 1.4 }}>{word.description}</div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const wordInfo = wordList.find(w => w.key === selectedWord);

  // ── Mode selection screen ─────────────────────────────────────────────────
  if (!gameMode) {
    return (
      <div style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%)",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: 40, fontFamily: "system-ui, sans-serif", color: "white",
      }}>
        <button onClick={() => setSelectedWord(null)} style={{
          position: "absolute", top: 20, left: 20,
          padding: "8px 16px", fontSize: 14,
          background: "rgba(255,255,255,0.15)", color: "white",
          border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, cursor: "pointer",
        }}>← Words</button>

        <div style={{
          background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 20, padding: "48px 56px", textAlign: "center", maxWidth: 480,
        }}>
          <div style={{ fontSize: 44, fontWeight: 800, color: "#c4b5fd", marginBottom: 10 }}>
            {wordInfo?.display ?? selectedWord}
          </div>
          <div style={{ fontSize: 15, opacity: 0.55, marginBottom: 40, lineHeight: 1.5 }}>
            {wordInfo?.description}
          </div>

          <div style={{ display: "flex", gap: 16, justifyContent: "center" }}>
            <button
              onClick={() => {
                gameModeRef.current = "learn";
                setGameMode("learn");
                void loadLearnData(selectedWord!);
              }}
              style={{
                padding: "18px 32px", fontSize: 16, fontWeight: 700, borderRadius: 12, cursor: "pointer",
                background: "linear-gradient(135deg, #7c3aed, #5b21b6)",
                color: "white", border: "2px solid rgba(139,92,246,0.5)",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 6, minWidth: 140,
                transition: "transform 0.15s, box-shadow 0.15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 8px 24px rgba(124,58,237,0.4)"; }}
              onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = ""; }}
            >
              <span style={{ fontSize: 22 }}>📖</span>
              Learn
              <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.7 }}>Explanations + guided practice</span>
            </button>

            <button
              onClick={() => {
                gameModeRef.current = "practice";
                setGameMode("practice");
                void loadSentencesForWord(selectedWord!);
              }}
              style={{
                padding: "18px 32px", fontSize: 16, fontWeight: 700, borderRadius: 12, cursor: "pointer",
                background: "linear-gradient(135deg, #1d4ed8, #1e40af)",
                color: "white", border: "2px solid rgba(59,130,246,0.5)",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 6, minWidth: 140,
                transition: "transform 0.15s, box-shadow 0.15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 8px 24px rgba(29,78,216,0.4)"; }}
              onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = ""; }}
            >
              <span style={{ fontSize: 22 }}>🎯</span>
              Practice
              <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.7 }}>Drill sentences freely</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Learn mode screen ─────────────────────────────────────────────────────
  if (gameMode === "learn") {
    const currentUC = learnUsecases[currentUsecaseIdx];
    const doneCount = usecaseStatuses.filter(s => s !== "pending").length;
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
            <button onClick={() => { stopAudio(); gameModeRef.current = null; setGameMode(null); setLearnComplete(false); returnToPracticeRef.current = null; setCanReturnToPractice(false); }}
              style={{ padding: "6px 14px", fontSize: 14, background: "rgba(255,255,255,0.12)", color: "white", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, cursor: "pointer" }}>
              ← Back
            </button>
            {canReturnToPractice && (
              <button onClick={handleReturnToPractice}
                style={{ padding: "6px 14px", fontSize: 13, fontWeight: 600, background: "rgba(59,130,246,0.2)", color: "#93c5fd", border: "1px solid rgba(59,130,246,0.4)", borderRadius: 6, cursor: "pointer" }}>
                ← Back to practice
              </button>
            )}
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
              Word Drill: <span style={{ color: "#c4b5fd" }}>{wordInfo?.display ?? selectedWord}</span>
              <span style={{ fontSize: 14, fontWeight: 400, opacity: 0.5, marginLeft: 10 }}>— Learn</span>
            </h2>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <label style={{
              display: "flex", alignItems: "center", gap: 6,
              fontSize: 12, color: "rgba(255,255,255,0.5)", cursor: "pointer", userSelect: "none",
            }}>
              <input
                type="checkbox"
                checked={showTargetText}
                onChange={e => setShowTargetText(e.target.checked)}
                style={{ accentColor: "#a78bfa", cursor: "pointer" }}
              />
              Show {activeLearning.name} text
            </label>
            <div style={{ fontSize: 13, opacity: 0.55 }}>{doneCount}/{learnUsecases.length} done</div>
            {onBack && (
              <button onClick={() => { stopAudio(); onBack(); }}
                style={{ padding: "6px 14px", fontSize: 14, background: "rgba(255,255,255,0.08)", color: "white", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, cursor: "pointer" }}>
                Home
              </button>
            )}
          </div>
        </div>

        {/* Navigator */}
        <div style={{
          flexShrink: 0, padding: "10px 20px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(0,0,0,0.15)",
        }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {learnUsecases.map((uc, idx) => {
              const status = usecaseStatuses[idx] ?? "pending";
              const isCurrent = idx === currentUsecaseIdx && !learnComplete;
              const chipColor = status === "correct" ? "#86efac"
                : status === "close" ? "#fbbf24"
                : status === "skipped" ? "#94a3b8"
                : null;
              return (
                <div key={idx} style={{ position: "relative" }}>
                  <button
                    onClick={() => { const alreadyDone = status !== "pending"; setLearnComplete(false); navigateToUsecase(idx, alreadyDone || showAllPhases); }}
                    onMouseEnter={() => setHoveredNavIdx(idx)}
                    onMouseLeave={() => setHoveredNavIdx(null)}
                    style={{
                      width: 34, height: 34, borderRadius: "50%",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 13, fontWeight: 700, cursor: "pointer",
                      background: chipColor ? `${chipColor}22` : "rgba(255,255,255,0.08)",
                      border: isCurrent
                        ? `2px solid ${chipColor ?? "rgba(139,92,246,0.9)"}`
                        : `1px solid ${chipColor ? `${chipColor}55` : "rgba(255,255,255,0.2)"}`,
                      color: chipColor ?? "rgba(255,255,255,0.45)",
                      boxShadow: isCurrent ? `0 0 12px ${chipColor ? `${chipColor}44` : "rgba(139,92,246,0.3)"}` : "none",
                      transition: "all 0.2s",
                    }}
                  >
                    {idx + 1}
                  </button>
                  {hoveredNavIdx === idx && (
                    <div style={{
                      position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
                      background: "#1e293b", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6,
                      padding: "5px 10px", fontSize: 11, whiteSpace: "nowrap",
                      color: "rgba(255,255,255,0.85)", zIndex: 20, pointerEvents: "none",
                    }}>
                      {uc.name}
                    </div>
                  )}
                </div>
              );
            })}
            <label style={{
              marginLeft: "auto", display: "flex", alignItems: "center", gap: 6,
              fontSize: 12, color: "rgba(255,255,255,0.45)", cursor: "pointer", userSelect: "none",
            }}>
              <input
                type="checkbox"
                checked={showAllPhases}
                onChange={e => setShowAllPhases(e.target.checked)}
                style={{ accentColor: "#a78bfa", cursor: "pointer" }}
              />
              Show all
            </label>
          </div>
        </div>

        {/* Shared keyframes for learn mode animations */}
        <style>{`
          @keyframes enAudioPulse {
            0%, 100% { color: rgba(255,255,255,0.88); }
            50%       { color: #c4b5fd; }
          }
          @keyframes esFadeSlideUp {
            from { opacity: 0; transform: translateY(6px); }
            to   { opacity: 1; transform: translateY(0); }
          }
        `}</style>

        {/* Content */}
        {learnComplete ? (
          /* Completion screen */
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24, padding: 40 }}>
            <div style={{ fontSize: 36, fontWeight: 800 }}>All use cases complete!</div>
            <div style={{ display: "flex", gap: 20 }}>
              {[
                { label: "Correct", count: usecaseStatuses.filter(s => s === "correct").length, color: "#86efac" },
                { label: "Close", count: usecaseStatuses.filter(s => s === "close").length, color: "#fbbf24" },
                { label: "Skipped", count: usecaseStatuses.filter(s => s === "skipped").length, color: "#94a3b8" },
              ].map(({ label, count, color }) => (
                <div key={label} style={{
                  textAlign: "center", padding: "16px 24px",
                  background: `${color}18`, border: `1px solid ${color}44`, borderRadius: 12,
                  minWidth: 90,
                }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color }}>{count}</div>
                  <div style={{ fontSize: 12, color, opacity: 0.7 }}>{label}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
              <button
                onClick={() => {
                  gameModeRef.current = "practice";
                  setGameMode("practice");
                  setLearnComplete(false);
                  void loadSentencesForWord(selectedWord!);
                }}
                style={{ padding: "14px 28px", fontSize: 15, fontWeight: 700, borderRadius: 10, cursor: "pointer", background: "linear-gradient(135deg, #1d4ed8, #1e40af)", color: "white", border: "none" }}
              >
                Practice this word
              </button>
              <button
                onClick={() => { stopAudio(); setSelectedWord(null); gameModeRef.current = null; setGameMode(null); setLearnComplete(false); }}
                style={{ padding: "14px 28px", fontSize: 15, fontWeight: 600, borderRadius: 10, cursor: "pointer", background: "rgba(255,255,255,0.1)", color: "white", border: "1px solid rgba(255,255,255,0.2)" }}
              >
                Back to word list
              </button>
            </div>
          </div>
        ) : busy && !currentUC ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.5, fontSize: 16 }}>
            Loading…
          </div>
        ) : currentUC ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

            {/* ── Phase: explanation ── */}
            {learnPhase === "explanation" && (() => {
              const TAG_COLORS: Record<string, string> = {
                reflexive: "#67e8f9", connector: "#fbbf24", direct_object: "#c4b5fd",
                fixed: "#fdba74", person: "#86efac",
              };
              const bullets = currentUC.explanation_bullets ?? [];
              const hasBullets = bullets.length > 0;
              const allRevealed = bulletRevealIdx >= bullets.length;

              return (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 32px", overflowY: "auto" }}>
                  <div style={{ maxWidth: 620, width: "100%", display: "flex", flexDirection: "column", gap: 18 }}>

                    {/* Ordinal */}
                    <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#a78bfa", opacity: 0.8 }}>
                      Use case {currentUsecaseIdx + 1} of {learnUsecases.length}
                    </div>

                    {/* Title: Spanish phrase + English meaning */}
                    <div>
                      <h3 style={{ margin: 0, fontSize: 24, fontWeight: 700, lineHeight: 1.3 }}>{currentUC.name}</h3>
                      {currentUC.english && (
                        <div style={{ fontSize: 15, color: "rgba(255,255,255,0.45)", marginTop: 4, fontStyle: "italic" }}>
                          ({currentUC.english})
                        </div>
                      )}
                    </div>

                    {/* Grammar tags */}
                    {currentUC.grammar_tags && currentUC.grammar_tags.length > 0 && (
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {currentUC.grammar_tags.map((tag, i) => {
                          const color = TAG_COLORS[tag.type] ?? "#94a3b8";
                          return (
                            <span key={i} style={{
                              fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 999,
                              background: `${color}18`, border: `1px solid ${color}55`, color, letterSpacing: "0.03em",
                            }}>{tag.label}</span>
                          );
                        })}
                      </div>
                    )}

                    {/* Bullets — revealed one at a time */}
                    {hasBullets ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                        {bullets.slice(0, bulletRevealIdx).map((bullet, i) => {
                          const isObj = typeof bullet === "object";
                          const text = isObj ? bullet.text : bullet;
                          const audioText = isObj && bullet.audio ? bullet.audio : null;
                          const isCurrent = i === bulletRevealIdx - 1;
                          const isOlder = i < bulletRevealIdx - 1;
                          const showAudioText = audioText && showTargetText && (isOlder || (isCurrent && bulletAudioStep >= 2));
                          const isPulsing = isCurrent && audioText !== null && bulletAudioStep === 1;

                          return (
                            <div key={i} style={{
                              display: "flex", gap: 12, alignItems: "flex-start",
                              padding: "10px 0",
                              borderBottom: i < bulletRevealIdx - 1 ? "1px solid rgba(255,255,255,0.06)" : "none",
                              opacity: 1,
                              animation: isCurrent ? "esFadeSlideUp 0.4s ease" : "none",
                            }}>
                              <span style={{ color: "#a78bfa", fontWeight: 700, fontSize: 16, lineHeight: 1.6, flexShrink: 0, marginTop: 1 }}>•</span>
                              <div style={{ flex: 1 }}>
                                <span style={{
                                  fontSize: 16, lineHeight: 1.6, color: "rgba(255,255,255,0.85)",
                                  animation: isPulsing ? "enAudioPulse 2.8s ease-in-out infinite" : "none",
                                }}>
                                  {text.split(/("(?:[^"\\]|\\.)*")/).map((part, pi) =>
                                    part.startsWith('"') && part.endsWith('"')
                                      ? <span key={pi}
                                          style={{ fontWeight: 600, color: "#fbbf24", cursor: audioText ? "pointer" : "default" }}
                                          onMouseEnter={() => { if (audioText) void fetchAndPlayAudio(audioText, learningLocale); }}
                                          onMouseLeave={() => { if (audioText) stopAudio(); }}
                                        >{part}</span>
                                      : <span key={pi}>{part}</span>
                                  )}
                                </span>
                                {showAudioText && (
                                  <span style={{ fontSize: 16, fontWeight: 600, color: "#c4b5fd", marginLeft: 8, display: "inline-block", animation: "esFadeSlideUp 0.4s ease" }}>
                                    — {audioText}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      /* Fallback: prose explanation for words without bullets */
                      <div style={{
                        fontSize: 16, lineHeight: 1.8, color: "rgba(255,255,255,0.7)",
                        background: "rgba(255,255,255,0.04)", borderRadius: 12, padding: "20px 24px",
                        border: "1px solid rgba(255,255,255,0.08)",
                      }}>
                        {currentUC.explanation}
                      </div>
                    )}

                    {/* Hint */}
                    <div style={{ textAlign: "center", fontSize: 13, color: "rgba(255,255,255,0.3)", marginTop: 4 }}>
                      {hasBullets && !allRevealed ? (
                        <>Press <kbd style={{ padding: "2px 8px", background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, fontSize: 12 }}>Space</kbd> {bulletRevealIdx === 0 ? "to begin →" : "to continue →"}</>
                      ) : (
                        <>Press <kbd style={{ padding: "2px 8px", background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, fontSize: 12 }}>Space</kbd> to see example →</>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* ── Phase: demo ── */}
            {learnPhase === "demo" && (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 32px" }}>
                <div style={{ maxWidth: 620, width: "100%", display: "flex", flexDirection: "column", gap: 20 }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#a78bfa", opacity: 0.8, marginBottom: 6 }}>
                      Use case {currentUsecaseIdx + 1} of {learnUsecases.length}
                    </div>
                    <h3 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{currentUC.name}</h3>
                  </div>
                  <div style={{
                    fontSize: 14, lineHeight: 1.7, color: "rgba(255,255,255,0.35)",
                    background: "rgba(255,255,255,0.02)", borderRadius: 12, padding: "14px 18px",
                    border: "1px solid rgba(255,255,255,0.05)",
                  }}>
                    {currentUC.english
                      ? <><span style={{ fontStyle: "normal" }}>{currentUC.name}</span> <span style={{ opacity: 0.7 }}>({currentUC.english})</span></>
                      : (currentUC.brief ?? currentUC.explanation)}
                  </div>
                  <div style={{
                    background: "rgba(139,92,246,0.1)", border: "1px solid rgba(139,92,246,0.3)",
                    borderRadius: 14, padding: "20px 24px",
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: "#a78bfa", marginBottom: 14 }}>
                      Example
                    </div>
                    {currentUC.demo.context && (
                      <div style={{
                        marginBottom: 12,
                        fontSize: demoAnimStep <= 1 ? 17 : 13,
                        fontWeight: demoAnimStep <= 1 ? 700 : 400,
                        fontStyle: demoAnimStep <= 1 ? "normal" : "italic",
                        color: demoAnimStep <= 1 ? "rgba(255,255,255,0.88)" : "rgba(255,255,255,0.45)",
                        opacity: demoAnimStep >= 1 ? 1 : 0,
                        transform: demoAnimStep >= 1 ? "translateY(0)" : "translateY(6px)",
                        transition: "opacity 0.5s ease, transform 0.5s ease, font-size 0.45s ease, color 0.45s ease",
                      }}>
                        {currentUC.demo.context}
                      </div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {/* EN sentence — hover plays audio when showTargetText is off */}
                      <div
                        onMouseEnter={() => { if (!showTargetText && demoAnimStep >= 4) void fetchAndPlayAudio(currentUC.demo.spanish, learningLocale); }}
                        onMouseLeave={() => { if (!showTargetText) stopAudio(); }}
                        style={{
                          fontSize: 17, fontWeight: 700,
                          animation: demoAnimStep === 3 ? "enAudioPulse 2.8s ease-in-out infinite" : "none",
                          color: "rgba(255,255,255,0.88)",
                          opacity: demoAnimStep >= 2 ? 1 : 0,
                          transform: demoAnimStep >= 2 ? "translateY(0)" : "translateY(6px)",
                          transition: "opacity 0.5s ease, transform 0.5s ease",
                          cursor: !showTargetText && demoAnimStep >= 4 ? "pointer" : "default",
                        }}
                      >
                        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", marginRight: 10, color: "rgba(255,255,255,0.4)" }}>EN</span>
                        {currentUC.demo.native}
                      </div>
                      {/* ES row — hover reveals text only (audio separate via EN hover) */}
                      {demoAnimStep >= 4 && (
                        <div
                          style={{ display: "flex", alignItems: "center", gap: 12, animation: "esFadeSlideUp 0.5s ease" }}
                          onMouseEnter={() => setEsHovered(true)}
                          onMouseLeave={() => setEsHovered(false)}
                        >
                          {showTargetText || esHovered ? (
                            <>
                              <div
                                onMouseEnter={() => showTargetText && void fetchAndPlayAudio(currentUC.demo.spanish, learningLocale)}
                                onMouseLeave={() => showTargetText && stopAudio()}
                                style={{ fontSize: 20, fontWeight: 700, color: "#c4b5fd", cursor: showTargetText ? "pointer" : "default", lineHeight: 1.4 }}
                              >
                                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", marginRight: 10, color: "rgba(255,255,255,0.35)" }}>ES</span>
                                {currentUC.demo.spanish}
                              </div>
                              <button
                                onClick={() => void fetchAndPlayAudio(currentUC.demo.spanish, learningLocale)}
                                style={{
                                  padding: "5px 12px", fontSize: 15, background: "rgba(255,255,255,0.08)",
                                  border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, cursor: "pointer", color: "white",
                                  flexShrink: 0,
                                }}
                              >🔊</button>
                            </>
                          ) : (
                            <div style={{
                              fontSize: 15, color: "rgba(167,139,250,0.4)", fontStyle: "italic",
                              border: "1px dashed rgba(167,139,250,0.25)", borderRadius: 8,
                              padding: "6px 16px", cursor: "default",
                            }}>
                              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", marginRight: 8, color: "rgba(255,255,255,0.2)" }}>ES</span>
                              hover to reveal
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ textAlign: "center", fontSize: 13, color: "rgba(255,255,255,0.3)", marginTop: 8 }}>
                    {demoAnimStep < 4 ? (
                      <>Press <kbd style={{ padding: "2px 8px", background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, fontSize: 12 }}>Space</kbd> to skip →</>
                    ) : (
                      <>Press <kbd style={{ padding: "2px 8px", background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, fontSize: 12 }}>Space</kbd> to try it →</>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ── Phase: practice ── */}
            {learnPhase === "practice" && currentSentence && (
              <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

                {/* LEFT — prompt + hints + input */}
                <div style={{ flex: "0 0 66%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                  <div style={{ flex: 1, overflowY: "auto", padding: "20px 0 0" }}>
                    <div style={{ maxWidth: 680, margin: "0 auto", padding: "0 32px", display: "flex", flexDirection: "column", gap: 16 }}>

                      {/* Explanation (dimmed) */}
                      <div style={{
                        fontSize: 14, lineHeight: 1.7, color: "rgba(255,255,255,0.3)",
                        background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: "14px 18px",
                        border: "1px solid rgba(255,255,255,0.05)",
                      }}>
                        {currentUC.brief ?? currentUC.explanation}
                      </div>

                      {/* Demo (dimmed) */}
                      <div style={{
                        background: "rgba(139,92,246,0.05)", border: "1px solid rgba(139,92,246,0.15)",
                        borderRadius: 12, padding: "14px 18px",
                      }}>
                        <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: "rgba(167,139,250,0.5)", marginBottom: 10 }}>
                          Example
                        </div>
                        {currentUC.demo.context && (
                          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", fontStyle: "italic", marginBottom: 8 }}>
                            {currentUC.demo.context}
                          </div>
                        )}
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <div style={{ fontSize: 14, color: "rgba(255,255,255,0.4)" }}>
                            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", marginRight: 8, color: "rgba(255,255,255,0.25)" }}>EN</span>
                            {currentUC.demo.native}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <div
                              onMouseEnter={() => void fetchAndPlayAudio(currentUC.demo.spanish, learningLocale)}
                              onMouseLeave={() => stopAudio()}
                              style={{ fontSize: 15, fontWeight: 600, color: "rgba(196,181,253,0.5)", cursor: "pointer" }}
                            >
                              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", marginRight: 8, color: "rgba(255,255,255,0.2)" }}>ES</span>
                              {currentUC.demo.spanish}
                            </div>
                            <button
                              onClick={() => void fetchAndPlayAudio(currentUC.demo.spanish, learningLocale)}
                              style={{
                                padding: "3px 8px", fontSize: 12, background: "rgba(255,255,255,0.05)",
                                border: "1px solid rgba(255,255,255,0.1)", borderRadius: 5, cursor: "pointer",
                                color: "rgba(255,255,255,0.4)", flexShrink: 0,
                              }}
                            >🔊</button>
                          </div>
                        </div>
                      </div>

                      {/* Divider */}
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.1)" }} />
                        <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", opacity: 0.4 }}>Your turn</div>
                        <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.1)" }} />
                      </div>

                      {/* Context */}
                      <div style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "12px 16px" }}>
                        <div style={{ fontSize: 12, opacity: 0.45, marginBottom: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Context</div>
                        <div style={{ fontSize: 15, opacity: 0.8, lineHeight: 1.5, fontStyle: "italic" }}>{currentSentence.context}</div>
                      </div>

                      {/* English prompt */}
                      <div style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 12, padding: "20px 24px", textAlign: "center" }}>
                        <div style={{ fontSize: 12, opacity: 0.45, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
                          Translate to {activeLearning.name}
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

                      {/* Hints */}
                      {hasHints && renderHints()}

                      <div ref={learnPracticeEndRef} style={{ height: 8 }} />
                    </div>
                  </div>

                  {renderPracticeBottom()}
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
                          <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4, fontStyle: "italic" }}>{entry.english}</div>
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
                          {isExpanded && renderExpandedHistoryEntry(entry, wrongAttempts)}
                        </div>
                      );
                    })}
                    <div ref={historyEndRef} />
                  </div>
                </div>

              </div>
            )}

          </div>
        ) : null}
      {renderChat()}
    </div>
    );
  }

  // ── Practice drill screen ─────────────────────────────────────────────────

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
          <button onClick={() => { stopAudio(); gameModeRef.current = null; setGameMode(null); setCurrentSentence(null); setHistory([]); }}
            style={{ padding: "6px 14px", fontSize: 14, background: "rgba(255,255,255,0.12)", color: "white", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, cursor: "pointer" }}>
            ← Back
          </button>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
            Word Drill: <span style={{ color: "#c4b5fd" }}>{wordInfo?.display ?? selectedWord}</span>
            <span style={{ fontSize: 14, fontWeight: 400, opacity: 0.5, marginLeft: 10 }}>— Practice</span>
          </h2>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {totalSentences > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
                <span style={{ fontWeight: 700, color: "#c4b5fd" }}>{roundSentencesShown}</span>
                <span style={{ opacity: 0.4 }}> / {totalSentences}</span>
              </div>
              {hasCompletedRound && (
                <span style={{
                  fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999,
                  background: "rgba(134,239,172,0.12)", border: "1px solid rgba(134,239,172,0.3)",
                  color: "#86efac",
                }}>
                  ✓ seen all
                </span>
              )}
            </div>
          )}
          {totalCount > 0 && <div style={{ fontSize: 13, opacity: 0.55 }}>{correctCount}/{totalCount} correct</div>}
          {totalCostCents > 0 && <div style={{ fontSize: 12, opacity: 0.45, fontVariantNumeric: "tabular-nums" }}>{totalCostCents.toFixed(2)}¢</div>}
          {onBack && (
            <button onClick={() => { stopAudio(); onBack(); }}
              style={{ padding: "6px 14px", fontSize: 14, background: "rgba(255,255,255,0.08)", color: "white", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, cursor: "pointer" }}>
              Home
            </button>
          )}
        </div>
      </div>

      {/* Round progress bar */}
      {totalSentences > 0 && (
        <div style={{ height: 4, background: "rgba(255,255,255,0.07)", flexShrink: 0 }}>
          <div style={{
            height: "100%",
            width: `${(roundSentencesShown / totalSentences) * 100}%`,
            background: "rgba(167,139,250,0.7)",
            transition: "width 0.4s ease",
          }} />
        </div>
      )}

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
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 999,
                    background: "rgba(139,92,246,0.2)", border: "1px solid rgba(139,92,246,0.4)",
                    color: "#c4b5fd", textTransform: "uppercase", letterSpacing: "0.06em",
                  }}>
                    {currentSentence.category}
                  </span>
                  <button
                    onClick={handleLearnThis}
                    style={{
                      fontSize: 11, padding: "3px 10px", borderRadius: 999,
                      background: "rgba(167,139,250,0.15)", border: "1px solid rgba(167,139,250,0.4)",
                      color: "#c4b5fd", cursor: "pointer", fontWeight: 600,
                    }}
                  >
                    📖 Learn this
                  </button>
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

                {/* Hints */}
                {hasHints && renderHints()}
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
                placeholder={`Hold CTRL + WIN to say the ${learning.name} translation…`}
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

                  <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4, fontStyle: "italic" }}>{entry.english}</div>

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

                  {isExpanded && renderExpandedHistoryEntry(entry, wrongAttempts)}
                </div>
              );
            })}
            <div ref={historyEndRef} />
          </div>
        </div>

      </div>

      {renderChat()}
    </div>
  );
}
