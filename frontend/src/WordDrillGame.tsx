// WordDrillGame.tsx
// Practice specific words/phrases with LLM feedback — follows Common Mode Features spec
import { useEffect, useRef, useState } from "react";
import { HINT_COLORS, checkFuzzyMatch, restoreAccentsInTokens, tokenizeWithHints } from "./sharedGameUtils";
import type { HintItem, CorrectionToken, FeedbackIssue, SharedHistoryEntry } from "./sharedGameUtils";
import { FeedbackBadges, CorrectionTokens, HintCards, HistoryLogEntry } from "./sharedGameComponents";

type LangSpec = { code: string; name: string };


type CheckResult = {
  multiplier: number;
  feedbackIssues: FeedbackIssue[] | null;
  feedbackKey: string | null;
  correctedSnippet: string | null;
  feedbackExplanation: string | null;
  correctionTokens: CorrectionToken[] | null;
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
  hintsRevealedIndices?: number[];
  isWrongAttempt: boolean;
  skipped: boolean;
  feedbackIssues?: FeedbackIssue[] | null;
  feedbackKey?: string | null;
  correctedSnippet?: string | null;
  feedbackExplanation?: string | null;
  correctionTokens?: CorrectionToken[] | null;
  qualityScore?: number;
  llmUsed: boolean;
  isFreeform?: boolean;
};

type WordInfo = {
  key: string;
  display: string;
  description: string;
};

type GrammarTag = { type: string; label: string };
type BulletItem = string | { text: string; audio?: string; literal?: string };

type Conjugations = {
  present: [string, string, string];
  preterite: [string, string, string];
  esta: string;
  ha: string;
};

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


const LEARNING_LOCALE: Record<string, string> = { es: "es-MX", id: "id-ID", en: "en-US" };

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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
  const [wordListEs, setWordListEs] = useState<WordInfo[]>([]);
  const [wordListId, setWordListId] = useState<WordInfo[]>([]);
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

  // Learn mode conjugations (word-level, may be null if not a verb)
  const [conjugations, setConjugations] = useState<Conjugations | null>(null);

  // Freeform "Try your own sentence" state (learn mode only)
  const [freeformText, setFreeformText] = useState("");
  const [freeformResult, setFreeformResult] = useState<{ correction_tokens: { text: string; status: "ok" | "remove" | "add" }[]; feedback_message: string } | null>(null);
  const [freeformBusy, setFreeformBusy] = useState(false);
  const [pasteTarget, setPasteTarget] = useState<"main" | "freeform" | null>(null);
  const pasteTargetRef = useRef<"main" | "freeform" | null>(null);
  const [freeformPendingAutoSend, setFreeformPendingAutoSend] = useState(false);
  const [freeformPendingProgress, setFreeformPendingProgress] = useState<number | null>(null);
  const freeformRef = useRef<HTMLTextAreaElement>(null);
  const freeformPendingTimerRef = useRef<number | null>(null);
  const freeformPreviousLengthRef = useRef<number>(0);

  // Grammar chat state
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<{ role: "user" | "ai"; text: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

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
  // Practice phase reveal: 0=hidden, 1=context, 2=English prompt, 3=hints, 4=textarea
  const [practiceRevealStep, setPracticeRevealStep] = useState(0);
  const practiceRevealTimerRefs = useRef<number[]>([]);
  // Whether to display the target language text after audio (can be toggled off by user)
  const [showTargetText, setShowTargetText] = useState(false);
  // Whether the ES reveal area is currently hovered (when showTargetText=false)
  const [esHovered, setEsHovered] = useState(false);
  // Right panel mode: history log or info panel
  const [rightPanelMode, setRightPanelMode] = useState<"history" | "info">("history");
  // Which bullet index is currently hovered (for brightness highlight)
  const [hoveredBulletIdx, setHoveredBulletIdx] = useState<number | null>(null);
  // Which bullet's "hover to reveal" badge is hovered (for Spanish text reveal only)
  const [revealBulletIdx, setRevealBulletIdx] = useState<number | null>(null);

  // ── Refs ─────────────────────────────────────────────────────────────────
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const lastSentRef = useRef<number>(0);
  const previousLengthRef = useRef<number>(0);
  const entryIdCounter = useRef<number>(0);
  const historyEndRef = useRef<HTMLDivElement>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioCacheRef = useRef<Map<string, string>>(new Map());
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
  const lastPlayedAudioRef = useRef<{ text: string; locale: string } | null>(null);
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

  // Load both word lists on mount for the combined home screen
  useEffect(() => {
    fetch(`${apiBase}/api/worddrill/words?lang=es`).then(r => r.json()).then(d => setWordListEs(d.words ?? [])).catch(() => {});
    fetch(`${apiBase}/api/worddrill/words?lang=id`).then(r => r.json()).then(d => setWordListId(d.words ?? [])).catch(() => {});
  }, [apiBase]);

  // Textarea is focused only on hover — no auto-focus

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

  function cancelFreeformPendingAutoSend(clearText = false) {
    if (freeformPendingTimerRef.current) { window.clearInterval(freeformPendingTimerRef.current); freeformPendingTimerRef.current = null; }
    setFreeformPendingAutoSend(false);
    setFreeformPendingProgress(null);
    if (clearText) { setFreeformText(""); freeformRef.current?.focus(); }
  }

  function startFreeformPendingAutoSend(duration = 2000) {
    cancelFreeformPendingAutoSend();
    const startTime = Date.now();
    setFreeformPendingAutoSend(true);
    setFreeformPendingProgress(1.0);
    freeformPendingTimerRef.current = window.setInterval(() => {
      const remaining = Math.max(0, 1 - (Date.now() - startTime) / duration);
      setFreeformPendingProgress(remaining);
      if (remaining <= 0) {
        window.clearInterval(freeformPendingTimerRef.current!);
        freeformPendingTimerRef.current = null;
        setFreeformPendingAutoSend(false);
        setFreeformPendingProgress(null);
        void submitFreeform();
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

  // Freeform Wispr auto-send
  useEffect(() => {
    cancelFreeformPendingAutoSend();
    const isShown = gameModeRef.current === "learn" && (answerStatus === "correct" || answerStatus === "skipped");
    if (isShown && freeformText.length > 2 && !freeformBusy) {
      const increase = freeformText.length - freeformPreviousLengthRef.current;
      if (increase >= 3) startFreeformPendingAutoSend(2000);
    }
    freeformPreviousLengthRef.current = freeformText.length;
    return () => cancelFreeformPendingAutoSend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freeformText]);

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
      // Don't steal keypresses from focused text inputs
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
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

  // Global learn-mode hotkeys: R, S, A, 0, I, 1-9
  useEffect(() => {
    if (gameMode !== "learn") return;
    function onKey(e: KeyboardEvent) {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      switch (e.key) {
        case "r": case "R":
          if (lastPlayedAudioRef.current) {
            void fetchAndPlayAudio(lastPlayedAudioRef.current.text, lastPlayedAudioRef.current.locale);
          }
          break;
        case "s": case "S":
          setShowTargetText(prev => !prev);
          break;
        case "a": case "A":
          setShowAllPhases(true);
          break;
        case "0":
          navigateToUsecase(currentUsecaseIdxRef.current, false);
          break;
        case "i": case "I":
          setRightPanelMode(prev => prev === "history" ? "info" : "history");
          break;
        default:
          if (e.key >= "1" && e.key <= "9") {
            const idx = parseInt(e.key) - 1;
            if (idx < learnUsecasesRef.current.length) {
              const alreadyDone = usecaseStatusesRef.current[idx] !== "pending";
              setLearnComplete(false);
              navigateToUsecase(idx, alreadyDone || showAllPhasesRef.current);
            }
          }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameMode]);

  // Practice mode hotkey: I to toggle info panel
  useEffect(() => {
    if (gameMode !== "practice") return;
    function onKey(e: KeyboardEvent) {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      if (e.key === "i" || e.key === "I") setRightPanelMode(prev => prev === "history" ? "info" : "history");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gameMode]);

  // Wispr paste routing — routes to hovered textarea, or falls back to main textarea
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return; // already going to focused element
      const text = e.clipboardData?.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      if (pasteTargetRef.current === "freeform") {
        setFreeformText(prev => prev + text);
        freeformRef.current?.focus();
      } else {
        setTranscript(prev => prev + text);
        textareaRef.current?.focus();
      }
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

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

  // Practice phase sequential reveal: context → English → hints → textarea
  useEffect(() => {
    if (gameMode !== "learn" || learnPhase !== "practice") return;
    practiceRevealTimerRefs.current.forEach(id => window.clearTimeout(id));
    practiceRevealTimerRefs.current = [];
    setPracticeRevealStep(0);
    const add = (ms: number, step: number) => {
      const id = window.setTimeout(() => setPracticeRevealStep(step), ms);
      practiceRevealTimerRefs.current.push(id);
    };
    add(0, 1);     // context
    add(700, 2);   // English prompt
    add(1300, 3);  // hints
    add(1800, 4);  // textarea
    return () => {
      practiceRevealTimerRefs.current.forEach(id => window.clearTimeout(id));
      practiceRevealTimerRefs.current = [];
    };
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

  async function submitFreeform() {
    const currentUC = learnUsecasesRef.current[currentUsecaseIdxRef.current];
    if (!freeformText.trim() || freeformBusy || !currentUC || !currentSentence) return;
    cancelFreeformPendingAutoSend();
    setFreeformBusy(true);
    const sentText = freeformText.trim();
    try {
      const resp = await fetch(`${apiBase}/api/worddrill/freeform`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_sentence: sentText,
          word_key: selectedWord ?? "",
          usecase_name: currentUC.name,
          learning_lang: learning.name,
          fluent_lang: fluent.name,
        }),
      });
      const data = await resp.json();
      setFreeformText("");
      freeformPreviousLengthRef.current = 0;
      setFreeformResult(data);
      setHistory(prev => [...prev, {
        entryId: `${++entryIdCounter.current}`,
        sentenceId: currentSentence.id + 100000,
        category: currentUC.name,
        context: currentSentence.context,
        english: `✍ ${sentText}`,
        userAnswer: sentText,
        correctAnswer: sentText,
        acceptedTranslations: [],
        allHints: [],
        hintsUsed: 0,
        isWrongAttempt: false,
        skipped: false,
        correctionTokens: data.correction_tokens ?? null,
        feedbackExplanation: data.feedback_message ?? null,
        llmUsed: true,
        isFreeform: true,
      }]);
      setTimeout(() => historyEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    } catch {
      setFreeformResult({ correction_tokens: [], feedback_message: "Error getting correction." });
    } finally {
      setFreeformBusy(false);
    }
  }

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
    lastPlayedAudioRef.current = { text, locale };
    const audio = new Audio(url);
    currentAudioRef.current = audio;
    if (onEnded) {
      audio.onended = onEnded;
      audio.onerror = onEnded;
    }
    audio.play().catch(() => {});
  }

  // ── Hint proximity ────────────────────────────────────────────────────────

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
    setChatMessages([]);
    setChatOpen(false);
    setFreeformText("");
    setFreeformResult(null);
    setFreeformBusy(false);
    cancelFreeformPendingAutoSend();
    freeformPreviousLengthRef.current = 0;
    previousLengthRef.current = 0;
  }

  async function loadSentencesForWord(word: string, langOverride?: "es" | "id") {
    setLoadingSentence(true);
    setBusy(true);
    try {
      const resp = await fetch(`${apiBase}/api/worddrill/sentences/${encodeURIComponent(word)}?lang=${langOverride ?? drillLang ?? "es"}`);
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

  async function loadLearnData(word: string, jumpToCategory?: string, langOverride?: "es" | "id") {
    setBusy(true);
    try {
      const resp = await fetch(`${apiBase}/api/worddrill/usecases/${encodeURIComponent(word)}?lang=${langOverride ?? drillLang ?? "es"}`);
      if (!resp.ok) throw new Error("Failed");
      const data = await resp.json();
      const usecases: UseCase[] = data.usecases ?? [];
      learnUsecasesRef.current = usecases;
      setLearnUsecases(usecases);
      setConjugations(data.conjugations ?? null);
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
    setFreeformText("");
    setFreeformResult(null);
    setFreeformBusy(false);
    cancelFreeformPendingAutoSend();
    freeformPreviousLengthRef.current = 0;
    previousLengthRef.current = 0;
    learnPhaseRef.current = "explanation";
    setLearnPhase("explanation");
    demoAnimStepRef.current = 0;
    setDemoAnimStep(0);
    bulletRevealIdxRef.current = 0;
    setBulletRevealIdx(0);
    setBulletAudioStep(0);
    if (bulletAudioTimerRef.current) { window.clearTimeout(bulletAudioTimerRef.current); bulletAudioTimerRef.current = null; }
    setEsHovered(false);
    setHoveredBulletIdx(null);
    setRevealBulletIdx(null);
    setPracticeRevealStep(0);
    practiceRevealTimerRefs.current.forEach(id => window.clearTimeout(id));
    practiceRevealTimerRefs.current = [];
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
    sentenceQueueRef.current = [];
    setCurrentSentence(null);
    setLearnComplete(false);
    returnToPracticeRef.current = null;
    setCanReturnToPractice(false);
    stopAudio();
  }

  function handleDirectLaunch(wordKey: string, lang: "es" | "id", mode: GameMode) {
    setDrillLang(lang);
    setSelectedWord(wordKey);
    gameModeRef.current = mode;
    setGameMode(mode);
    setHistory([]);
    setCorrectCount(0);
    setTotalCount(0);
    setTotalSentences(0);
    setRoundSentencesShown(0);
    setHasCompletedRound(false);
    sentenceQueueRef.current = [];
    setCurrentSentence(null);
    setLearnComplete(false);
    returnToPracticeRef.current = null;
    setCanReturnToPractice(false);
    stopAudio();
    if (mode === "learn") void loadLearnData(wordKey, undefined, lang);
    else void loadSentencesForWord(wordKey, lang);
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
    previousLengthRef.current = 0;
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
          valid_phrases: (currentSentence.hints ?? []).map(h => h.learning).filter(Boolean),
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
          hintsRevealedIndices: Array.from(viewedHints),
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
      hintsRevealedIndices: Array.from(viewedHints),
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
      hintsRevealedIndices: Array.from(viewedHints),
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

  function toSharedEntry(e: HistoryEntry): SharedHistoryEntry {
    return {
      entryId: e.entryId,
      isWrongAttempt: e.isWrongAttempt,
      skipped: e.skipped,
      qualityScore: e.qualityScore,
      llmUsed: e.llmUsed,
      allHints: e.allHints,
      hintsUsed: e.hintsUsed,
      hintsRevealedIndices: e.hintsRevealedIndices,
      promptText: e.english,
      userAnswer: e.userAnswer,
      correctAnswer: e.correctAnswer,
      acceptedTranslations: e.acceptedTranslations,
      correctionTokens: e.correctionTokens,
      feedbackIssues: e.feedbackIssues,
      feedbackKey: e.feedbackKey,
      correctedSnippet: e.correctedSnippet,
      feedbackExplanation: e.feedbackExplanation,
      extraLabel: e.category,
    };
  }

  // ── Floating grammar chat (Messenger style) ──────────────────────────────

  function renderChat() {
    if (!currentSentence || gameMode === "learn" || gameMode === "practice") return null;
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
                <FeedbackBadges issues={liveIssues} />
              </div>
            )}
            {lastCheckResult?.correctionTokens?.length ? <CorrectionTokens tokens={lastCheckResult.correctionTokens} /> : null}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={transcript}
          onChange={e => setTranscript(e.target.value)}
          onMouseEnter={() => { if (answerStatus === "idle" && !busy) textareaRef.current?.focus(); pasteTargetRef.current = "main"; setPasteTarget("main"); }}
          onMouseLeave={() => { pasteTargetRef.current = null; setPasteTarget(null); }}
          onKeyDown={e => { if (e.key === "Escape") { cancelPendingAutoSend(true); return; } if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitAnswer(); } }}
          placeholder={`Hold CTRL + WIN to say the ${learning.name} translation…`}
          disabled={busy || answerStatus === "correct" || answerStatus === "skipped"}
          style={{
            width: "100%", minHeight: 60, padding: 12, fontSize: 16,
            border: pasteTarget === "main" ? "2px solid rgba(139,92,246,0.6)" : "2px solid rgba(255,255,255,0.18)",
            borderRadius: 8, resize: "none", fontFamily: "system-ui, sans-serif",
            boxSizing: "border-box", background: "rgba(0,0,0,0.4)", color: "white", outline: "none",
            opacity: (busy || answerStatus === "correct" || answerStatus === "skipped") ? 0.5 : 1,
            boxShadow: pasteTarget === "main" ? "0 0 0 3px rgba(139,92,246,0.15)" : "none",
            transition: "border-color 0.15s ease, box-shadow 0.15s ease",
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

        {/* Try Your Own Sentence — learn mode only, shown after answer */}
        {gameModeRef.current === "learn" && (answerStatus === "correct" || answerStatus === "skipped") && (
          <div style={{ paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.06)", marginTop: 2 }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", opacity: 0.35, marginBottom: 6 }}>
              Try your own sentence (optional — Enter to skip)
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <textarea
                ref={freeformRef}
                value={freeformText}
                onChange={e => setFreeformText(e.target.value)}
                onMouseEnter={() => { freeformRef.current?.focus(); pasteTargetRef.current = "freeform"; setPasteTarget("freeform"); }}
                onMouseLeave={() => { pasteTargetRef.current = null; setPasteTarget(null); }}
                onKeyDown={e => {
                  if (e.key === "Escape") { cancelFreeformPendingAutoSend(true); return; }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (freeformPendingAutoSend) { cancelFreeformPendingAutoSend(false); void submitFreeform(); return; }
                    if (freeformText.trim()) void submitFreeform();
                    else handleNext();
                  }
                }}
                placeholder="Write your own example…"
                disabled={freeformBusy}
                rows={2}
                style={{
                  flex: 1, padding: "8px 12px", fontSize: 14,
                  background: "rgba(0,0,0,0.3)", color: "white",
                  border: pasteTarget === "freeform" ? "1px solid rgba(139,92,246,0.6)" : "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 6, resize: "none", fontFamily: "system-ui, sans-serif", outline: "none",
                  opacity: freeformBusy ? 0.5 : 1, boxSizing: "border-box",
                  boxShadow: pasteTarget === "freeform" ? "0 0 0 3px rgba(139,92,246,0.15)" : "none",
                  transition: "border-color 0.15s ease, box-shadow 0.15s ease",
                }}
              />
              {freeformPendingAutoSend ? (
                <button onClick={() => cancelFreeformPendingAutoSend(true)}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", fontSize: 14, fontWeight: 600, flexShrink: 0, background: "linear-gradient(135deg, #d97706, #b45309)", color: "white", border: "none", borderRadius: 6, cursor: "pointer" }}>
                  {freeformPendingProgress !== null && (() => {
                    const r = 9, circ = 2 * Math.PI * r;
                    return (
                      <svg width={22} height={22} style={{ transform: "rotate(-90deg)", flexShrink: 0 }}>
                        <circle cx={11} cy={11} r={r} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth={2.5} />
                        <circle cx={11} cy={11} r={r} fill="none" stroke="white" strokeWidth={2.5}
                          strokeDasharray={circ} strokeDashoffset={circ * (1 - freeformPendingProgress)}
                          strokeLinecap="round" />
                      </svg>
                    );
                  })()}
                  Cancel
                </button>
              ) : (
                <button
                  onClick={() => freeformText.trim() ? void submitFreeform() : handleNext()}
                  disabled={freeformBusy}
                  style={{
                    padding: "8px 14px", fontSize: 14, fontWeight: 600, flexShrink: 0,
                    background: freeformText.trim() ? "linear-gradient(135deg, #7c3aed, #5b21b6)" : "rgba(255,255,255,0.08)",
                    color: "white", border: "none", borderRadius: 6,
                    cursor: freeformBusy ? "not-allowed" : "pointer",
                    opacity: freeformBusy ? 0.5 : 1,
                  }}
                >{freeformBusy ? "…" : freeformText.trim() ? "Check" : "Skip →"}</button>
              )}
            </div>
            {freeformResult && (
              <div style={{ marginTop: 8 }}>
                {freeformResult.correction_tokens.length > 0 && <CorrectionTokens tokens={freeformResult.correction_tokens} />}
                {freeformResult.feedback_message && (
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", marginTop: 4, lineHeight: 1.5 }}>
                    {freeformResult.feedback_message}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }


  // ── Language picker screen ────────────────────────────────────────────────
  const wordInfo = (drillLang === "id" ? wordListId : wordListEs).find(w => w.key === selectedWord)
    ?? wordList.find(w => w.key === selectedWord);

  // ── Combined home screen ──────────────────────────────────────────────────
  if (!gameMode) {
    const renderWordColumn = (list: WordInfo[], lang: "es" | "id", flag: string, label: string) => (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", borderRight: lang === "es" ? "1px solid rgba(255,255,255,0.08)" : "none" }}>
        <div style={{ flexShrink: 0, padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 18 }}>{flag}</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#c4b5fd" }}>{label}</span>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
          {list.length === 0 && (
            <div style={{ fontSize: 13, opacity: 0.3, padding: "20px 0", textAlign: "center" }}>Loading…</div>
          )}
          {list.map(word => (
            <div key={word.key} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 14px", borderRadius: 10,
              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)",
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#c4b5fd" }}>{word.display}</div>
                <div style={{ fontSize: 12, opacity: 0.45, marginTop: 1, lineHeight: 1.3 }}>{word.description}</div>
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <button
                  onClick={() => handleDirectLaunch(word.key, lang, "learn")}
                  style={{
                    padding: "10px 34px", fontSize: 14, fontWeight: 700, borderRadius: 8, cursor: "pointer",
                    background: "linear-gradient(135deg, #7c3aed, #5b21b6)", color: "white", border: "none",
                  }}
                >Learn</button>
                <button
                  onClick={() => handleDirectLaunch(word.key, lang, "practice")}
                  style={{
                    padding: "10px 34px", fontSize: 14, fontWeight: 700, borderRadius: 8, cursor: "pointer",
                    background: "linear-gradient(135deg, #1d4ed8, #1e40af)", color: "white", border: "none",
                  }}
                >Practice</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );

    return (
      <div style={{
        height: "100vh",
        background: "linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%)",
        display: "flex", flexDirection: "column",
        fontFamily: "system-ui, sans-serif", color: "white", overflow: "hidden",
      }}>
        <div style={{ flexShrink: 0, padding: "14px 24px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", gap: 14 }}>
          {onBack && <button onClick={onBack} style={{ padding: "6px 14px", fontSize: 13, background: "rgba(255,255,255,0.1)", color: "white", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 6, cursor: "pointer" }}>← Back</button>}
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Word Drill</h1>
        </div>
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          {renderWordColumn(wordListEs, "es", "🇲🇽", "Spanish")}
          {renderWordColumn(wordListId, "id", "🇮🇩", "Indonesian")}
        </div>
      </div>
    );
  }

  const resolvedSentenceIds = new Set(history.filter(e => !e.isWrongAttempt).map(e => e.sentenceId));

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
                      {uc.name}{uc.english ? ` (${uc.english})` : ""}
                    </div>
                  )}
                </div>
              );
            })}
            {/* Summary nav button */}
            <button
              onClick={() => setLearnComplete(true)}
              title="Summary"
              style={{
                width: 34, height: 34, borderRadius: "50%",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 14, cursor: "pointer",
                background: learnComplete ? "rgba(167,139,250,0.22)" : "rgba(255,255,255,0.08)",
                border: learnComplete
                  ? "2px solid rgba(167,139,250,0.9)"
                  : "1px solid rgba(255,255,255,0.2)",
                color: learnComplete ? "#a78bfa" : "rgba(255,255,255,0.45)",
                boxShadow: learnComplete ? "0 0 12px rgba(139,92,246,0.3)" : "none",
                transition: "all 0.2s",
              }}
            >≡</button>
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
          .summary-row { transition: filter 0.15s ease; }
          .summary-row:hover { filter: brightness(1.4); }
        `}</style>

        {/* Content */}
        {learnComplete ? (() => {
          const TAG_COLORS: Record<string, string> = { reflexive: "#67e8f9", connector: "#fbbf24", direct_object: "#c4b5fd", fixed: "#fdba74", person: "#86efac" };
          const counts = [
            { label: "correct", count: usecaseStatuses.filter(s => s === "correct").length, color: "#86efac" },
            { label: "close", count: usecaseStatuses.filter(s => s === "close").length, color: "#fbbf24" },
            { label: "skipped", count: usecaseStatuses.filter(s => s === "skipped").length, color: "#94a3b8" },
          ].filter(s => s.count > 0);
          return (
            /* Summary — two-column layout matching learn mode */
            <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

              {/* LEFT — use case index */}
              <div style={{ flex: "0 0 66%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <div style={{ flexShrink: 0, padding: "16px 22px 12px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                  <div style={{ fontSize: 18, fontWeight: 800 }}>Summary</div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>
                    {counts.map(({ label, count, color }, i) => (
                      <span key={label}>
                        <span style={{ color, fontWeight: 600 }}>{count}</span> {label}
                        {i < counts.length - 1 && <span style={{ margin: "0 6px", opacity: 0.5 }}>·</span>}
                      </span>
                    ))}
                  </div>
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "10px 16px" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {learnUsecases.map((uc, i) => {
                      const status = usecaseStatuses[i] ?? "pending";
                      const statusColor = status === "correct" ? "#86efac" : status === "close" ? "#fbbf24" : status === "skipped" ? "#94a3b8" : "rgba(255,255,255,0.15)";
                      const statusIcon = status === "correct" ? "✓" : status === "close" ? "≈" : status === "skipped" ? "→" : "○";
                      return (
                        <div key={i}
                          className="summary-row"
                          onClick={() => { setLearnComplete(false); navigateToUsecase(i, true); }}
                          style={{
                            padding: "10px 12px", borderRadius: 10, cursor: "pointer",
                            background: `${statusColor}0a`, border: `1px solid ${statusColor}22`,
                          }}
                        >
                          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                            {/* LEFT — title, english, tags, status */}
                            <div style={{ flex: "0 0 36%", minWidth: 0, paddingRight: 12, borderRight: "1px solid rgba(255,255,255,0.07)" }}>
                              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 6 }}>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.3 }}>{i + 1}. {uc.name}</div>
                                  {uc.english && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.38)", fontStyle: "italic", marginTop: 2 }}>{uc.english}</div>}
                                </div>
                                <div style={{ fontSize: 12, fontWeight: 700, color: statusColor, flexShrink: 0, paddingTop: 1 }}>{statusIcon}</div>
                              </div>
                              {uc.grammar_tags && uc.grammar_tags.length > 0 && (
                                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
                                  {uc.grammar_tags.map((tag, ti) => {
                                    const color = TAG_COLORS[tag.type] ?? "#94a3b8";
                                    return <span key={ti} style={{ fontSize: 10, fontWeight: 600, padding: "1px 7px", borderRadius: 999, background: `${color}15`, border: `1px solid ${color}40`, color, letterSpacing: "0.03em" }}>{tag.label}</span>;
                                  })}
                                </div>
                              )}
                            </div>
                            {/* RIGHT — bullet points */}
                            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                              {(uc.explanation_bullets ?? []).map((bullet, bi) => {
                                const text = typeof bullet === "object" ? bullet.text : bullet;
                                const audioText = typeof bullet === "object" ? bullet.audio ?? null : null;
                                const literal = typeof bullet === "object" ? bullet.literal ?? null : null;
                                return (
                                  <div key={bi} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                                    <span style={{ color: `${statusColor}55`, fontSize: 11, flexShrink: 0, marginTop: 2 }}>•</span>
                                    <div>
                                      <span
                                        onMouseEnter={() => { if (audioText) void fetchAndPlayAudio(audioText, learningLocale); }}
                                        onMouseLeave={() => { if (audioText) stopAudio(); }}
                                        style={{ fontSize: 12, lineHeight: 1.5, color: "rgba(255,255,255,0.55)", cursor: audioText ? "pointer" : "default" }}
                                      >
                                        {text.split(/("(?:[^"\\]|\\.)*")/).map((part, pi) =>
                                          part.startsWith('"') && part.endsWith('"')
                                            ? <span key={pi} style={{ color: "#fbbf24", fontWeight: 600 }}>{part}</span>
                                            : <span key={pi}>{part}</span>
                                        )}
                                      </span>
                                      {literal && (
                                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.28)", fontStyle: "italic", marginTop: 1 }}>
                                          <span style={{ fontStyle: "normal", fontSize: 10, fontWeight: 700, color: "rgba(251,191,36,0.4)", marginRight: 4 }}>lit.</span>
                                          "{literal}"
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div style={{ flexShrink: 0, padding: "12px 16px 20px", display: "flex", gap: 10, borderTop: "1px solid rgba(255,255,255,0.07)" }}>
                  <button
                    onClick={() => {
                      gameModeRef.current = "practice";
                      setGameMode("practice");
                      setLearnComplete(false);
                      void loadSentencesForWord(selectedWord!);
                    }}
                    style={{ padding: "11px 22px", fontSize: 14, fontWeight: 700, borderRadius: 10, cursor: "pointer", background: "linear-gradient(135deg, #1d4ed8, #1e40af)", color: "white", border: "none" }}
                  >
                    Practice this word
                  </button>
                  <button
                    onClick={() => { stopAudio(); setSelectedWord(null); gameModeRef.current = null; setGameMode(null); setLearnComplete(false); }}
                    style={{ padding: "11px 22px", fontSize: 14, fontWeight: 600, borderRadius: 10, cursor: "pointer", background: "rgba(255,255,255,0.1)", color: "white", border: "1px solid rgba(255,255,255,0.2)" }}
                  >
                    Back to word list
                  </button>
                </div>
              </div>

              {/* RIGHT — Info panel (always shown on summary) */}
              <div style={{ flex: "0 0 34%", display: "flex", flexDirection: "column", borderLeft: "1px solid rgba(255,255,255,0.08)", overflow: "hidden" }}>
                <div style={{ flexShrink: 0, padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.15)" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#a78bfa", opacity: 0.8 }}>Info</span>
                </div>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                  <div style={{ flexShrink: 0, overflowY: "auto", maxHeight: "48%", padding: "10px 12px", display: "flex", gap: 10, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                    <div style={{ flex: "0 0 auto" }}>
                      <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#a78bfa", opacity: 0.8, marginBottom: 7 }}>Hotkeys</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        {[["Space", "Advance"], ["← →", "Use case"], ["1–9", "Jump to N"], ["R", "Replay audio"], ["S", "Toggle ES"], ["A", "Skip to practice"], ["0", "Reset"], ["I", "Info panel"], ["Esc", "Cancel send"]].map(([key, desc]) => (
                          <div key={key} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                            <kbd style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, flexShrink: 0, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.18)", color: "rgba(255,255,255,0.7)", fontFamily: "monospace", minWidth: 40, textAlign: "center" }}>{key}</kbd>
                            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.38)" }}>{desc}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    {conjugations && (
                      <div style={{ flex: "0 0 auto" }}>
                        <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#a78bfa", opacity: 0.8, marginBottom: 7 }}>Conjugations</div>
                        <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
                          <thead>
                            <tr>
                              <th style={{ width: "30%", padding: "2px 3px" }} />
                              {["Present", "Preterite"].map(h => (
                                <th key={h} style={{ textAlign: "center", padding: "2px 3px", color: "rgba(255,255,255,0.35)", fontWeight: 600, fontSize: 9 }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {(["yo", "tú", "él/ella"] as const).map((person, pi) => (
                              <tr key={person}>
                                <td style={{ padding: "3px 3px", color: "rgba(255,255,255,0.38)", fontSize: 9, fontWeight: 600 }}>{person}</td>
                                {[conjugations.present[pi], conjugations.preterite[pi]].map((f, fi) => (
                                  <td key={fi} style={{ textAlign: "center", padding: "3px 3px", color: "#c4b5fd", fontWeight: 500, cursor: "pointer", fontSize: 11 }}
                                    onMouseEnter={() => void fetchAndPlayAudio(f, learningLocale)}
                                    onMouseLeave={() => stopAudio()}
                                  >{f}</td>
                                ))}
                              </tr>
                            ))}
                            <tr>
                              <td style={{ padding: "3px 3px", color: "rgba(255,255,255,0.3)", fontSize: 9, fontWeight: 600 }}>está…</td>
                              <td colSpan={2} style={{ textAlign: "center", padding: "3px 3px", color: "rgba(196,181,253,0.7)", fontStyle: "italic", fontSize: 11, cursor: "pointer" }}
                                onMouseEnter={() => void fetchAndPlayAudio(`está ${conjugations.esta}`, learningLocale)}
                                onMouseLeave={() => stopAudio()}
                              >está {conjugations.esta}</td>
                            </tr>
                            <tr>
                              <td style={{ padding: "3px 3px", color: "rgba(255,255,255,0.3)", fontSize: 9, fontWeight: 600 }}>ha…</td>
                              <td colSpan={2} style={{ textAlign: "center", padding: "3px 3px", color: "rgba(196,181,253,0.7)", fontStyle: "italic", fontSize: 11, cursor: "pointer" }}
                                onMouseEnter={() => void fetchAndPlayAudio(`ha ${conjugations.ha}`, learningLocale)}
                                onMouseLeave={() => stopAudio()}
                              >ha {conjugations.ha}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                    <div style={{ flexShrink: 0, padding: "8px 14px", borderBottom: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.1)" }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "#a78bfa" }}>💬 Grammar Chat</span>
                    </div>
                    <div style={{ flex: 1, overflowY: "auto", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                      {chatMessages.map((msg, mi) => (
                        <div key={mi} style={{
                          maxWidth: "90%", alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
                          padding: "7px 11px", borderRadius: msg.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                          background: msg.role === "user" ? "rgba(139,92,246,0.25)" : "rgba(255,255,255,0.06)",
                          border: msg.role === "user" ? "1px solid rgba(139,92,246,0.4)" : "1px solid rgba(255,255,255,0.1)",
                          fontSize: 12, lineHeight: 1.5, color: "rgba(255,255,255,0.85)",
                        }}>{msg.text}</div>
                      ))}
                      <div ref={chatBottomRef} />
                    </div>
                    <div style={{ flexShrink: 0, padding: "8px 10px", borderTop: "1px solid rgba(255,255,255,0.07)", display: "flex", gap: 6 }}>
                      <textarea
                        ref={chatInputRef}
                        value={chatInput}
                        onChange={e => setChatInput(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendChat(); } }}
                        placeholder="Ask about grammar…"
                        rows={1}
                        style={{ flex: 1, resize: "none", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, padding: "6px 10px", fontSize: 12, color: "white", outline: "none", lineHeight: 1.5 }}
                      />
                      <button onClick={() => void sendChat()} disabled={chatBusy || !chatInput.trim()} style={{ padding: "6px 12px", fontSize: 12, fontWeight: 600, borderRadius: 8, cursor: "pointer", background: "rgba(139,92,246,0.4)", color: "white", border: "1px solid rgba(139,92,246,0.5)" }}>
                        {chatBusy ? "…" : "↑"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

            </div>
          );
        })() : busy && !currentUC ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.5, fontSize: 16 }}>
            Loading…
          </div>
        ) : currentUC ? (
          <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
            {/* LEFT — phase content */}
            <div style={{ flex: "0 0 66%", display: "flex", flexDirection: "column", overflow: "hidden" }}>

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

                    {/* Title: Spanish phrase + English meaning on same line */}
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                      <h3 style={{ margin: 0, fontSize: 24, fontWeight: 700, lineHeight: 1.3 }}>{currentUC.name}</h3>
                      {currentUC.english && (
                        <span style={{ fontSize: 24, color: "rgba(255,255,255,0.82)", fontWeight: 400, fontStyle: "italic", whiteSpace: "nowrap" }}>
                          ({currentUC.english})
                        </span>
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
                          const isHovered = hoveredBulletIdx === i;
                          const isRevealing = revealBulletIdx === i;
                          // Audio text visible: showTargetText on → show after audio plays; off → show only when badge hovered
                          const audioHasPlayed = isOlder || (isCurrent && bulletAudioStep >= 1);
                          const showAudioText = audioText && showTargetText && (isOlder || (isCurrent && bulletAudioStep >= 2));
                          const showAudioPlaceholder = audioText && !showTargetText && audioHasPlayed;
                          const isPulsing = isCurrent && audioText !== null && bulletAudioStep === 1;

                          return (
                            <div key={i}
                              onMouseEnter={() => setHoveredBulletIdx(i)}
                              onMouseLeave={() => setHoveredBulletIdx(null)}
                              style={{
                                display: "flex", gap: 12, alignItems: "flex-start",
                                padding: "10px 0",
                                borderBottom: isOlder ? "1px solid rgba(255,255,255,0.06)" : "none",
                                opacity: isHovered || (hoveredBulletIdx === null && isCurrent) ? 1 : 0.35,
                                transition: "opacity 0.3s ease",
                                animation: isCurrent ? "esFadeSlideUp 0.4s ease" : "none",
                                cursor: "default",
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
                                {/* Spanish text: show inline when toggle on */}
                                {showAudioText && (
                                  <span style={{ fontSize: 16, fontWeight: 600, color: "#c4b5fd", marginLeft: 8, display: "inline-block", animation: "esFadeSlideUp 0.4s ease" }}>
                                    — {audioText}
                                  </span>
                                )}
                                {/* Placeholder when toggle off: hover the badge to reveal */}
                                {showAudioPlaceholder && (
                                  <span
                                    onMouseEnter={() => setRevealBulletIdx(i)}
                                    onMouseLeave={() => setRevealBulletIdx(null)}
                                    style={{
                                      display: "inline-block", marginLeft: 10,
                                      fontSize: 13,
                                      color: isRevealing ? "#c4b5fd" : "rgba(167,139,250,0.35)",
                                      fontStyle: isRevealing ? "normal" : "italic",
                                      fontWeight: isRevealing ? 600 : 400,
                                      border: `1px dashed ${isRevealing ? "rgba(196,181,253,0.5)" : "rgba(167,139,250,0.2)"}`,
                                      borderRadius: 6, padding: "1px 10px",
                                      cursor: "default",
                                      transition: "color 0.2s, border-color 0.2s",
                                    }}>
                                    {isRevealing ? audioText : "hover to reveal"}
                                  </span>
                                )}
                                {typeof bullet === "object" && bullet.literal && (
                                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.32)", fontStyle: "italic", marginTop: 4 }}>
                                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", color: "#fbbf24", opacity: 0.55, marginRight: 5, fontStyle: "normal" }}>lit.</span>
                                    "{bullet.literal}"
                                  </div>
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
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#a78bfa", opacity: 0.8 }}>
                      Use case {currentUsecaseIdx + 1} of {learnUsecases.length}
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                      <h3 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{currentUC.name}</h3>
                      {currentUC.english && (
                        <span style={{ fontSize: 22, color: "rgba(255,255,255,0.82)", fontWeight: 400, fontStyle: "italic" }}>
                          ({currentUC.english})
                        </span>
                      )}
                    </div>
                    {currentUC.grammar_tags && currentUC.grammar_tags.length > 0 && (() => {
                      const TAG_COLORS: Record<string, string> = { reflexive: "#67e8f9", connector: "#fbbf24", direct_object: "#c4b5fd", fixed: "#fdba74", person: "#86efac" };
                      return (
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {currentUC.grammar_tags.map((tag, i) => {
                            const color = TAG_COLORS[tag.type] ?? "#94a3b8";
                            return <span key={i} style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 999, background: `${color}18`, border: `1px solid ${color}55`, color, letterSpacing: "0.03em" }}>{tag.label}</span>;
                          })}
                        </div>
                      );
                    })()}
                  </div>
                  <div style={{
                    background: "rgba(255,255,255,0.02)", borderRadius: 12, padding: "12px 16px",
                    border: "1px solid rgba(255,255,255,0.05)",
                  }}>
                    {currentUC.explanation_bullets?.length ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {currentUC.explanation_bullets.map((bullet, i) => {
                          const text = typeof bullet === "object" ? bullet.text : bullet;
                          const literal = typeof bullet === "object" ? bullet.literal : undefined;
                          return (
                            <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                              <span style={{ color: "rgba(167,139,250,0.4)", fontSize: 13, flexShrink: 0, marginTop: 1 }}>•</span>
                              <div>
                                <span style={{ fontSize: 13, lineHeight: 1.6, color: "rgba(255,255,255,0.35)" }}>
                                  {text.split(/("(?:[^"\\]|\\.)*")/).map((part, pi) =>
                                    part.startsWith('"') && part.endsWith('"')
                                      ? <span key={pi} style={{ color: "rgba(251,191,36,0.45)" }}>{part}</span>
                                      : <span key={pi}>{part}</span>
                                  )}
                                </span>
                                {literal && (
                                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.2)", fontStyle: "italic", marginTop: 1 }}>
                                    <span style={{ fontSize: 10, fontWeight: 700, color: "rgba(251,191,36,0.3)", fontStyle: "normal", marginRight: 4 }}>lit.</span>
                                    "{literal}"
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <span style={{ fontSize: 14, lineHeight: 1.7, color: "rgba(255,255,255,0.35)" }}>
                        {currentUC.english
                          ? <>{currentUC.name} <span style={{ opacity: 0.7 }}>({currentUC.english})</span></>
                          : (currentUC.brief ?? currentUC.explanation)}
                      </span>
                    )}
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
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                  <div style={{ flex: 1, overflowY: "auto", padding: "20px 0 0" }}>
                    <div style={{ maxWidth: 680, margin: "0 auto", padding: "0 32px", display: "flex", flexDirection: "column", gap: 16 }}>

                      {/* Title + tags (dimmed) */}
                      <div>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 18, fontWeight: 700, color: "rgba(255,255,255,0.6)" }}>{currentUC.name}</span>
                          {currentUC.english && (
                            <span style={{ fontSize: 18, color: "rgba(255,255,255,0.35)", fontStyle: "italic" }}>({currentUC.english})</span>
                          )}
                        </div>
                        {currentUC.grammar_tags && currentUC.grammar_tags.length > 0 && (() => {
                          const TAG_COLORS: Record<string, string> = { reflexive: "#67e8f9", connector: "#fbbf24", direct_object: "#c4b5fd", fixed: "#fdba74", person: "#86efac" };
                          return (
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                              {currentUC.grammar_tags.map((tag, i) => {
                                const color = TAG_COLORS[tag.type] ?? "#94a3b8";
                                return <span key={i} style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 999, background: `${color}12`, border: `1px solid ${color}33`, color: `${color}99`, letterSpacing: "0.03em" }}>{tag.label}</span>;
                              })}
                            </div>
                          );
                        })()}
                      </div>

                      {/* Explanation (dimmed) */}
                      <div style={{
                        background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: "10px 14px",
                        border: "1px solid rgba(255,255,255,0.05)",
                      }}>
                        {currentUC.explanation_bullets?.length ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                            {currentUC.explanation_bullets.map((bullet, i) => {
                              const text = typeof bullet === "object" ? bullet.text : bullet;
                              const literal = typeof bullet === "object" ? bullet.literal : undefined;
                              return (
                                <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                                  <span style={{ color: "rgba(167,139,250,0.35)", fontSize: 12, flexShrink: 0, marginTop: 1 }}>•</span>
                                  <div>
                                    <span style={{ fontSize: 12, lineHeight: 1.6, color: "rgba(255,255,255,0.3)" }}>
                                      {text.split(/("(?:[^"\\]|\\.)*")/).map((part, pi) =>
                                        part.startsWith('"') && part.endsWith('"')
                                          ? <span key={pi} style={{ color: "rgba(251,191,36,0.4)" }}>{part}</span>
                                          : <span key={pi}>{part}</span>
                                      )}
                                    </span>
                                    {literal && (
                                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.18)", fontStyle: "italic", marginTop: 1 }}>
                                        <span style={{ fontSize: 9, fontWeight: 700, color: "rgba(251,191,36,0.25)", fontStyle: "normal", marginRight: 4 }}>lit.</span>
                                        "{literal}"
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <span style={{ fontSize: 13, lineHeight: 1.7, color: "rgba(255,255,255,0.3)" }}>
                            {currentUC.brief ?? currentUC.explanation}
                          </span>
                        )}
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
                      <div style={{
                        background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "12px 16px",
                        opacity: practiceRevealStep >= 1 ? 1 : 0,
                        transform: practiceRevealStep >= 1 ? "translateY(0)" : "translateY(8px)",
                        transition: "opacity 0.5s ease, transform 0.5s ease",
                      }}>
                        <div style={{ fontSize: 12, opacity: 0.45, marginBottom: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Context</div>
                        <div style={{ fontSize: 15, opacity: 0.8, lineHeight: 1.5, fontStyle: "italic" }}>{currentSentence.context}</div>
                      </div>

                      {/* English prompt */}
                      <div style={{
                        background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 12, padding: "20px 24px", textAlign: "center",
                        opacity: practiceRevealStep >= 2 ? 1 : 0,
                        transform: practiceRevealStep >= 2 ? "translateY(0)" : "translateY(8px)",
                        transition: "opacity 0.5s ease, transform 0.5s ease",
                      }}>
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
                      <div style={{
                        opacity: practiceRevealStep >= 3 ? 1 : 0,
                        transform: practiceRevealStep >= 3 ? "translateY(0)" : "translateY(8px)",
                        transition: "opacity 0.5s ease, transform 0.5s ease",
                        pointerEvents: practiceRevealStep >= 3 ? "auto" : "none",
                      }}>
                        {hasHints && <HintCards key={currentSentence?.id} hints={currentSentence?.hints ?? []} viewedHints={viewedHints} onReveal={idx => setViewedHints(prev => new Set([...prev, idx]))} onPlayAudio={text => void fetchAndPlayAudio(text, learningLocale)} onStopAudio={stopAudio} />}
                      </div>

                      <div ref={learnPracticeEndRef} style={{ height: 8 }} />
                    </div>
                  </div>

                  <div style={{
                    opacity: practiceRevealStep >= 4 ? 1 : 0,
                    transform: practiceRevealStep >= 4 ? "translateY(0)" : "translateY(8px)",
                    transition: "opacity 0.5s ease, transform 0.5s ease",
                    pointerEvents: practiceRevealStep >= 4 ? "auto" : "none",
                    flexShrink: 0,
                  }}>
                    {renderPracticeBottom()}
                  </div>
              </div>
            )}
          </div>

            {/* RIGHT — History / Info panel */}
            <div style={{ flex: "0 0 34%", display: "flex", flexDirection: "column", borderLeft: "1px solid rgba(255,255,255,0.08)", overflow: "hidden" }}>
              {/* Tab header */}
              <div style={{ flexShrink: 0, display: "flex", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                    {(["history", "info"] as const).map(mode => (
                      <button key={mode} onClick={() => setRightPanelMode(mode)} style={{
                        flex: 1, padding: "10px 0", fontSize: 11, fontWeight: 600,
                        textTransform: "uppercase", letterSpacing: "0.08em", cursor: "pointer",
                        background: "none", border: "none", color: "white",
                        opacity: rightPanelMode === mode ? 0.85 : 0.3,
                        borderBottom: rightPanelMode === mode ? "2px solid #a78bfa" : "2px solid transparent",
                        transition: "opacity 0.2s",
                      }}>{mode === "history" ? "History" : "Info (I)"}</button>
                    ))}
                    {rightPanelMode === "history" && (
                      <button onClick={() => setShowTargetText(s => !s)} title={showTargetText ? "Audio only — hide Spanish text" : "Show Spanish text"} style={{
                        flexShrink: 0, padding: "4px 10px", marginRight: 8, fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: "pointer",
                        border: "1px solid",
                        background: !showTargetText ? "rgba(251,191,36,0.2)" : "rgba(255,255,255,0.08)",
                        borderColor: !showTargetText ? "rgba(251,191,36,0.5)" : "rgba(255,255,255,0.2)",
                        color: !showTargetText ? "#fbbf24" : "rgba(255,255,255,0.6)",
                        transition: "all 0.15s",
                      }}>{!showTargetText ? "🔇 Audio only" : "👁 Show text"}</button>
                    )}
                  </div>

                  {/* History content */}
                  {rightPanelMode === "history" && (
                  <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px 40px", display: "flex", flexDirection: "column", gap: 8 }}>
                    {history.map(entry => {
                      if (entry.isWrongAttempt && resolvedSentenceIds.has(entry.sentenceId)) return null;

                      // Freeform entries get a compact distinct look
                      if (entry.isFreeform) {
                        const allKeep = !entry.correctionTokens?.some(t => t.status !== "ok");
                        return (
                          <div key={entry.entryId} style={{
                            padding: "7px 11px", borderRadius: 8,
                            background: "rgba(139,92,246,0.1)", border: "1px solid rgba(139,92,246,0.25)",
                            fontSize: 12, lineHeight: 1.4, wordBreak: "break-word",
                            maxWidth: "92%",
                          }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
                              <span style={{ fontSize: 11, color: "#a78bfa" }}>✍</span>
                              <span style={{ fontSize: 10, color: "rgba(167,139,250,0.6)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Your sentence</span>
                            </div>
                            <div style={{ fontWeight: 500 }}>
                              {entry.correctionTokens?.length ? (
                                <CorrectionTokens tokens={entry.correctionTokens} wrapped={false} />
                              ) : (
                                <span style={{ color: "rgba(255,255,255,0.8)" }}>{entry.userAnswer}</span>
                              )}
                            </div>
                            {entry.feedbackExplanation && !allKeep && (
                              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginTop: 4, lineHeight: 1.4 }}>
                                {entry.feedbackExplanation}
                              </div>
                            )}
                            {allKeep && (
                              <div style={{ fontSize: 11, color: "#86efac", marginTop: 3 }}>✓ Looks good!</div>
                            )}
                          </div>
                        );
                      }

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
                  </div>
                  )}

                  {/* Info panel content */}
                  {rightPanelMode === "info" && (
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

                      {/* Reference section: hotkeys (left) + conjugations (right) */}
                      <div style={{ flexShrink: 0, overflowY: "auto", maxHeight: "48%", padding: "10px 12px", display: "flex", gap: 10, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>

                        {/* LEFT — Hotkeys */}
                        <div style={{ flex: "0 0 auto" }}>
                          <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#a78bfa", opacity: 0.8, marginBottom: 7 }}>Hotkeys</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                            {[
                              ["Space", "Advance"],
                              ["← →", "Use case"],
                              ["1–9", "Jump to N"],
                              ["R", "Replay audio"],
                              ["S", "Toggle ES"],
                              ["A", "Skip to practice"],
                              ["0", "Reset"],
                              ["I", "Info panel"],
                              ["Esc", "Cancel send"],
                            ].map(([key, desc]) => (
                              <div key={key} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                                <kbd style={{
                                  fontSize: 9, padding: "1px 5px", borderRadius: 3, flexShrink: 0,
                                  background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.18)",
                                  color: "rgba(255,255,255,0.7)", fontFamily: "monospace", minWidth: 40, textAlign: "center",
                                }}>{key}</kbd>
                                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.38)" }}>{desc}</span>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* RIGHT — Conjugation table (rows = person, cols = tense) */}
                        {conjugations && (
                          <div style={{ flex: "0 0 auto" }}>
                            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#a78bfa", opacity: 0.8, marginBottom: 7 }}>Conjugations</div>
                            <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
                              <thead>
                                <tr>
                                  <th style={{ width: "30%", padding: "2px 3px" }} />
                                  {["Present", "Preterite"].map(h => (
                                    <th key={h} style={{ textAlign: "center", padding: "2px 3px", color: "rgba(255,255,255,0.35)", fontWeight: 600, fontSize: 9 }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {(["yo", "tú", "él/ella"] as const).map((person, pi) => (
                                  <tr key={person}>
                                    <td style={{ padding: "3px 3px", color: "rgba(255,255,255,0.38)", fontSize: 9, fontWeight: 600 }}>{person}</td>
                                    {[conjugations.present[pi], conjugations.preterite[pi]].map((f, fi) => (
                                      <td key={fi} style={{ textAlign: "center", padding: "3px 3px", color: "#c4b5fd", fontWeight: 500, cursor: "pointer", fontSize: 11 }}
                                        onMouseEnter={() => void fetchAndPlayAudio(f, learningLocale)}
                                        onMouseLeave={() => stopAudio()}
                                      >{f}</td>
                                    ))}
                                  </tr>
                                ))}
                                <tr>
                                  <td style={{ padding: "3px 3px", color: "rgba(255,255,255,0.3)", fontSize: 9, fontWeight: 600 }}>está…</td>
                                  <td colSpan={2} style={{ textAlign: "center", padding: "3px 3px", color: "rgba(196,181,253,0.7)", fontStyle: "italic", fontSize: 11, cursor: "pointer" }}
                                    onMouseEnter={() => void fetchAndPlayAudio(`está ${conjugations.esta}`, learningLocale)}
                                    onMouseLeave={() => stopAudio()}
                                  >está {conjugations.esta}</td>
                                </tr>
                                <tr>
                                  <td style={{ padding: "3px 3px", color: "rgba(255,255,255,0.3)", fontSize: 9, fontWeight: 600 }}>ha…</td>
                                  <td colSpan={2} style={{ textAlign: "center", padding: "3px 3px", color: "rgba(196,181,253,0.7)", fontStyle: "italic", fontSize: 11, cursor: "pointer" }}
                                    onMouseEnter={() => void fetchAndPlayAudio(`ha ${conjugations.ha}`, learningLocale)}
                                    onMouseLeave={() => stopAudio()}
                                  >ha {conjugations.ha}</td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>

                      {/* Grammar Chat — takes remaining space */}
                      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                        <div style={{ flexShrink: 0, padding: "8px 14px", borderBottom: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.1)" }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: "#a78bfa" }}>💬 Grammar Chat</span>
                        </div>
                        {currentSentence && (
                          <div style={{ flexShrink: 0, padding: "6px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(0,0,0,0.1)" }}>
                            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", lineHeight: 1.4 }}>
                              <span style={{ color: "rgba(255,255,255,0.3)" }}>EN </span>{currentSentence.english}
                            </div>
                            <div style={{ fontSize: 11, color: "#86efac", lineHeight: 1.4, marginTop: 1 }}>
                              <span style={{ color: "rgba(134,239,172,0.4)" }}>ES </span>{currentSentence.accepted_translations[0]}
                            </div>
                          </div>
                        )}
                        <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                          {chatMessages.length === 0 && (
                            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.25)", textAlign: "center", marginTop: 16, lineHeight: 1.7 }}>
                              Ask about grammar,<br />rules, or examples.
                            </div>
                          )}
                          {chatMessages.map((msg, i) => (
                            <div key={i} style={{
                              alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
                              maxWidth: "92%",
                              background: msg.role === "user" ? "rgba(139,92,246,0.2)" : "rgba(255,255,255,0.07)",
                              border: msg.role === "user" ? "1px solid rgba(139,92,246,0.35)" : "1px solid rgba(255,255,255,0.1)",
                              borderRadius: msg.role === "user" ? "10px 10px 3px 10px" : "10px 10px 10px 3px",
                              padding: "6px 10px", fontSize: 12, lineHeight: 1.5,
                              color: msg.role === "user" ? "#c4b5fd" : "rgba(255,255,255,0.85)",
                              wordBreak: "break-word",
                            }}>{msg.text}</div>
                          ))}
                          {chatBusy && (
                            <div style={{ alignSelf: "flex-start", background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "10px 10px 10px 3px", padding: "6px 10px", fontSize: 12, color: "rgba(255,255,255,0.4)" }}>…</div>
                          )}
                          <div ref={chatBottomRef} />
                        </div>
                        <div style={{ flexShrink: 0, padding: "8px 10px", borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", gap: 6, alignItems: "flex-end" }}>
                          <textarea
                            ref={chatInputRef}
                            value={chatInput}
                            onChange={e => setChatInput(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendChat(); } }}
                            placeholder="Ask a grammar question…"
                            disabled={chatBusy}
                            rows={2}
                            style={{
                              flex: 1, padding: "6px 10px", fontSize: 12,
                              background: "rgba(255,255,255,0.07)", color: "white",
                              border: "1px solid rgba(255,255,255,0.12)", borderRadius: 16,
                              resize: "none", fontFamily: "system-ui, sans-serif",
                              outline: "none", boxSizing: "border-box",
                              opacity: chatBusy ? 0.5 : 1,
                            }}
                          />
                          <button
                            onClick={() => void sendChat()}
                            disabled={chatBusy || !chatInput.trim()}
                            style={{
                              width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
                              background: chatInput.trim() && !chatBusy ? "linear-gradient(135deg, #7c3aed, #5b21b6)" : "rgba(255,255,255,0.1)",
                              color: "white", border: "none",
                              cursor: chatInput.trim() && !chatBusy ? "pointer" : "not-allowed",
                              opacity: chatInput.trim() && !chatBusy ? 1 : 0.4,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 14,
                            }}
                          >→</button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

          </div>
        ) : null}
      {renderChat()}
    </div>
    );
  }

  // ── Practice drill screen ─────────────────────────────────────────────────


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
                {hasHints && <HintCards key={currentSentence?.id} hints={currentSentence?.hints ?? []} viewedHints={viewedHints} onReveal={idx => setViewedHints(prev => new Set([...prev, idx]))} onPlayAudio={text => void fetchAndPlayAudio(text, learningLocale)} onStopAudio={stopAudio} />}
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
                      <FeedbackBadges issues={liveIssues} />
                    </div>
                  )}
                  {lastCheckResult?.correctionTokens?.length ? <CorrectionTokens tokens={lastCheckResult.correctionTokens} /> : null}
                </div>
              )}

              {/* Textarea */}
              <textarea
                ref={textareaRef}
                value={transcript}
                onChange={e => setTranscript(e.target.value)}
                onMouseEnter={() => { if (answerStatus === "idle" && !busy) textareaRef.current?.focus(); pasteTargetRef.current = "main"; setPasteTarget("main"); }}
                onMouseLeave={() => { pasteTargetRef.current = null; setPasteTarget(null); }}
                onKeyDown={e => { if (e.key === "Escape") { cancelPendingAutoSend(true); return; } if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitAnswer(); } }}
                placeholder={`Hold CTRL + WIN to say the ${learning.name} translation…`}
                disabled={busy || answerStatus === "correct" || answerStatus === "skipped"}
                style={{
                  width: "100%", minHeight: 60, padding: 12, fontSize: 16,
                  border: pasteTarget === "main" ? "2px solid rgba(139,92,246,0.6)" : "2px solid rgba(255,255,255,0.18)",
                  borderRadius: 8, resize: "none", fontFamily: "system-ui, sans-serif",
                  boxSizing: "border-box", background: "rgba(0,0,0,0.4)", color: "white", outline: "none",
                  opacity: (busy || answerStatus === "correct" || answerStatus === "skipped") ? 0.5 : 1,
                  boxShadow: pasteTarget === "main" ? "0 0 0 3px rgba(139,92,246,0.15)" : "none",
                  transition: "border-color 0.15s ease, box-shadow 0.15s ease",
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

        {/* RIGHT — History / Info panel */}
        <div style={{ flex: "0 0 34%", display: "flex", flexDirection: "column", borderLeft: "1px solid rgba(255,255,255,0.08)", overflow: "hidden" }}>
          {/* Tab header */}
          <div style={{ flexShrink: 0, display: "flex", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            {(["history", "info"] as const).map(mode => (
              <button key={mode} onClick={() => setRightPanelMode(mode)} style={{
                flex: 1, padding: "10px 0", fontSize: 11, fontWeight: 600,
                textTransform: "uppercase", letterSpacing: "0.08em", cursor: "pointer",
                background: "none", border: "none", color: "white",
                opacity: rightPanelMode === mode ? 0.85 : 0.3,
                borderBottom: rightPanelMode === mode ? "2px solid #a78bfa" : "2px solid transparent",
                transition: "opacity 0.2s",
              }}>{mode === "history" ? "History" : "Info (I)"}</button>
            ))}
            {rightPanelMode === "history" && (
              <button onClick={() => setShowTargetText(s => !s)} title={showTargetText ? "Audio only — hide Spanish text" : "Show Spanish text"} style={{
                flexShrink: 0, padding: "4px 10px", marginRight: 8, fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: "pointer",
                border: "1px solid",
                background: !showTargetText ? "rgba(251,191,36,0.2)" : "rgba(255,255,255,0.08)",
                borderColor: !showTargetText ? "rgba(251,191,36,0.5)" : "rgba(255,255,255,0.2)",
                color: !showTargetText ? "#fbbf24" : "rgba(255,255,255,0.6)",
                transition: "all 0.15s",
              }}>{!showTargetText ? "🔇 Audio only" : "👁 Show text"}</button>
            )}
          </div>

          {/* Info panel */}
          {rightPanelMode === "info" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ flexShrink: 0, overflowY: "auto", maxHeight: "48%", padding: "10px 12px", display: "flex", gap: 10, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                <div style={{ flex: "0 0 auto" }}>
                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#a78bfa", opacity: 0.8, marginBottom: 7 }}>Hotkeys</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {[["Enter", "Submit"], ["R", "Replay audio"], ["I", "Info panel"], ["Esc", "Cancel send"]].map(([key, desc]) => (
                      <div key={key} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <kbd style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, flexShrink: 0, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.18)", color: "rgba(255,255,255,0.7)", fontFamily: "monospace", minWidth: 40, textAlign: "center" }}>{key}</kbd>
                        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.38)" }}>{desc}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {conjugations && (
                  <div style={{ flex: "0 0 auto" }}>
                    <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#a78bfa", opacity: 0.8, marginBottom: 7 }}>Conjugations</div>
                    <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
                      <thead>
                        <tr>
                          <th style={{ width: "30%", padding: "2px 3px" }} />
                          {["Present", "Preterite"].map(h => (
                            <th key={h} style={{ textAlign: "center", padding: "2px 3px", color: "rgba(255,255,255,0.35)", fontWeight: 600, fontSize: 9 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(["yo", "tú", "él/ella"] as const).map((person, pi) => (
                          <tr key={person}>
                            <td style={{ padding: "3px 3px", color: "rgba(255,255,255,0.38)", fontSize: 9, fontWeight: 600 }}>{person}</td>
                            {[conjugations.present[pi], conjugations.preterite[pi]].map((f, fi) => (
                              <td key={fi} style={{ textAlign: "center", padding: "3px 3px", color: "#c4b5fd", fontWeight: 500, cursor: "pointer", fontSize: 11 }}
                                onMouseEnter={() => void fetchAndPlayAudio(f, learningLocale)}
                                onMouseLeave={() => stopAudio()}
                              >{f}</td>
                            ))}
                          </tr>
                        ))}
                        <tr>
                          <td style={{ padding: "3px 3px", color: "rgba(255,255,255,0.3)", fontSize: 9, fontWeight: 600 }}>está…</td>
                          <td colSpan={2} style={{ textAlign: "center", padding: "3px 3px", color: "rgba(196,181,253,0.7)", fontStyle: "italic", fontSize: 11, cursor: "pointer" }}
                            onMouseEnter={() => void fetchAndPlayAudio(`está ${conjugations.esta}`, learningLocale)}
                            onMouseLeave={() => stopAudio()}
                          >está {conjugations.esta}</td>
                        </tr>
                        <tr>
                          <td style={{ padding: "3px 3px", color: "rgba(255,255,255,0.3)", fontSize: 9, fontWeight: 600 }}>ha…</td>
                          <td colSpan={2} style={{ textAlign: "center", padding: "3px 3px", color: "rgba(196,181,253,0.7)", fontStyle: "italic", fontSize: 11, cursor: "pointer" }}
                            onMouseEnter={() => void fetchAndPlayAudio(`ha ${conjugations.ha}`, learningLocale)}
                            onMouseLeave={() => stopAudio()}
                          >ha {conjugations.ha}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <div style={{ flexShrink: 0, padding: "8px 14px", borderBottom: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.1)" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#a78bfa" }}>💬 Grammar Chat</span>
                </div>
                {currentSentence && (
                  <div style={{ flexShrink: 0, padding: "6px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(0,0,0,0.1)" }}>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", lineHeight: 1.4 }}>
                      <span style={{ color: "rgba(255,255,255,0.3)" }}>EN </span>{currentSentence.english}
                    </div>
                    <div style={{ fontSize: 11, color: "#86efac", lineHeight: 1.4, marginTop: 1 }}>
                      <span style={{ color: "rgba(134,239,172,0.4)" }}>ES </span>{currentSentence.accepted_translations[0]}
                    </div>
                    {lastCheckResult?.userAnswer && (
                      <div style={{ fontSize: 11, color: "#fca5a5", lineHeight: 1.4, marginTop: 1 }}>
                        <span style={{ color: "rgba(252,165,165,0.4)" }}>You </span>{lastCheckResult.userAnswer}
                      </div>
                    )}
                  </div>
                )}
                <div style={{ flex: 1, overflowY: "auto", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                  {chatMessages.length === 0 && (
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", textAlign: "center", marginTop: 20, lineHeight: 1.7 }}>
                      Ask why an answer is correct,<br />how a grammar rule works,<br />or for more examples.
                    </div>
                  )}
                  {chatMessages.map((msg, mi) => (
                    <div key={mi} style={{
                      maxWidth: "90%", alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
                      padding: "7px 11px", borderRadius: msg.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                      background: msg.role === "user" ? "rgba(139,92,246,0.25)" : "rgba(255,255,255,0.06)",
                      border: msg.role === "user" ? "1px solid rgba(139,92,246,0.4)" : "1px solid rgba(255,255,255,0.1)",
                      fontSize: 12, lineHeight: 1.5, color: "rgba(255,255,255,0.85)",
                    }}>{msg.text}</div>
                  ))}
                  <div ref={chatBottomRef} />
                </div>
                <div style={{ flexShrink: 0, padding: "8px 10px", borderTop: "1px solid rgba(255,255,255,0.07)", display: "flex", gap: 6 }}>
                  <textarea
                    ref={chatInputRef}
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendChat(); } }}
                    placeholder="Ask about grammar…"
                    rows={1}
                    style={{ flex: 1, resize: "none", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, padding: "6px 10px", fontSize: 12, color: "white", outline: "none", lineHeight: 1.5 }}
                  />
                  <button onClick={() => void sendChat()} disabled={chatBusy || !chatInput.trim()} style={{ padding: "6px 12px", fontSize: 12, fontWeight: 600, borderRadius: 8, cursor: "pointer", background: "rgba(139,92,246,0.4)", color: "white", border: "1px solid rgba(139,92,246,0.5)" }}>
                    {chatBusy ? "…" : "↑"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* History content */}
          {rightPanelMode === "history" && (
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px 40px", display: "flex", flexDirection: "column", gap: 8 }}>
            {history.map(entry => {
              if (entry.isWrongAttempt && resolvedSentenceIds.has(entry.sentenceId)) return null;
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
                />
              );
            })}
            <div ref={historyEndRef} />
          </div>
          )}
        </div>

      </div>
    </div>
  );
}
