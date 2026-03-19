// BattleGame.tsx
// Battle mode: conversational battle with translation challenges
import React, { useEffect, useState, useRef } from "react";
import BATTLE_CONV_CAFE from './battle_conversations_es.json';
import BATTLE_CONV_MARKET from './battle_conversations_es_2.json';
import BATTLE_CONV_NEIGHBOR from './battle_conversations_es_3.json';

type LangSpec = { code: string; name: string };

type HintItem = { native: string; learning: string };

type DifficultyOption = {
  native: string;
  accepted_translations: string[];
  hints: HintItem[];
};

type PlayerRound = {
  id: number;
  speaker: "player";
  options: {
    easy: DifficultyOption;
    medium: DifficultyOption;
    hard: DifficultyOption;
  };
};

type EnemyRound = {
  id: number;
  speaker: "enemy";
  enemy_line_native: string;
  enemy_line_learning: string;
};

type Round = PlayerRound | EnemyRound;

type ConversationData = {
  conversation_id: string;
  title: string;
  enemy_name: string;
  enemy_emoji: string;
  player_emoji: string;
  rounds: Round[];
};

const ALL_CONVERSATIONS: ConversationData[] = [
  BATTLE_CONV_CAFE as any,
  BATTLE_CONV_MARKET as any,
  BATTLE_CONV_NEIGHBOR as any,
];

type Difficulty = "easy" | "medium" | "hard";

type CompletedRound = {
  id: number;
  speaker: "player" | "enemy";
  textNative: string;
  textLearning?: string;
  difficulty?: Difficulty;
  damageDealt?: number;
  hintsUsed?: number;
  usedHintPairs?: { native: string; learning: string }[];
  allHints?: { native: string; learning: string }[];
  acceptedTranslations?: string[];
  skipped?: boolean;
};

type BattleGameProps = {
  apiBase?: string;
  fluent?: LangSpec;
  learning?: LangSpec;
  onBack?: () => void;
};

const TIMER_DURATION = 30;
const MIN_AUTO_SEND_LENGTH = 8;
const AUTO_SEND_DELAY_MS = 1200;
const BASE_DAMAGE: Record<Difficulty, number> = { easy: 10, medium: 20, hard: 30 };
const HINT_PENALTY = 2;
const MIN_DAMAGE = 5;
const ENEMY_DAMAGE = 15;
const PLAYER_MAX_HP = 100;
const ENEMY_MAX_HP = 100;
const PLAYER_PET_EMOJIS = ["🐺", "🦊", "🦅"];
const ENEMY_PET_EMOJIS = ["🐍", "🦂", "🦇"];
const PET_MAX_HP = 20;
const PET_DAMAGE = 5;

type Pet = { id: string; emoji: string; hp: number; maxHp: number };

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default function BattleGame({
  apiBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000",
  fluent: initialFluent = { code: "en", name: "English" },
  learning: initialLearning = { code: "es", name: "Spanish" },
  onBack,
}: BattleGameProps) {
  // Game state
  const [gamePhase, setGamePhase] = useState<"intro" | "playing" | "victory" | "defeat">("intro");
  const [playerHealth, setPlayerHealth] = useState(PLAYER_MAX_HP);
  const [enemyHealth, setEnemyHealth] = useState(ENEMY_MAX_HP);
  const [currentRoundIndex, setCurrentRoundIndex] = useState(0);
  const [selectedDifficulty, setSelectedDifficulty] = useState<Difficulty | null>(null);
  const [transcript, setTranscript] = useState("");
  const [viewedHints, setViewedHints] = useState<Set<number>>(new Set());
  const [answerStatus, setAnswerStatus] = useState<"idle" | "checking" | "correct" | "incorrect" | "skipped">("idle");
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [conversationHistory, setConversationHistory] = useState<CompletedRound[]>([]);
  const [hoveredLogEntry, setHoveredLogEntry] = useState<number | null>(null);
  const [revealingHintIndex, setRevealingHintIndex] = useState<number | null>(null);
  const [showPowerUpBanner, setShowPowerUpBanner] = useState(false);
  const [previewAnswer, setPreviewAnswer] = useState<{ entryIndex: number; transIndex: number } | null>(null);
  const [showEnemyTurn, setShowEnemyTurn] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(TIMER_DURATION);
  const [timerActive, setTimerActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [damageFlash, setDamageFlash] = useState<string | null>(null);
  const [lastDamage, setLastDamage] = useState<number | null>(null);
  const [lastPlayerDamage, setLastPlayerDamage] = useState<number | null>(null);
  const [sessionId] = useState<string>(`battle_${Date.now()}`);
  const [totalCostCents, setTotalCostCents] = useState(0);
  const [timerEnabled, setTimerEnabled] = useState(false);
  const [freeformMode, setFreeformMode] = useState(false);
  const [colorHints, setColorHints] = useState(true);
  const [petsEnabled, setPetsEnabled] = useState(false);
  const [animationsEnabled, setAnimationsEnabled] = useState(false);
  const [playerPets, setPlayerPets] = useState<Pet[]>([]);
  const [enemyPets, setEnemyPets] = useState<Pet[]>([]);
  const [attackingId, setAttackingId] = useState<string | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<ConversationData | null>(null);

  // Proximity-based hint scaling/color
  const [closestHintIndex, setClosestHintIndex] = useState<number | null>(null);
  const [closestHintScale, setClosestHintScale] = useState<number>(14);
  const [closestHintOpacity, setClosestHintOpacity] = useState<number>(0);
  const hintCardsRefs = useRef<(HTMLDivElement | null)[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const timerExpiredRef = useRef(false);
  const historyEndRef = useRef<HTMLDivElement | null>(null);
  const autoSendTimer = useRef<number | null>(null);
  const lastSentRef = useRef<number>(0);
  const previousTranscriptLengthRef = useRef<number>(0);

  // Active conversation (set after selection)
  const conversation = selectedConversation;
  const rounds = conversation?.rounds ?? [];

  // Current round helper
  const currentRound = currentRoundIndex < rounds.length ? rounds[currentRoundIndex] : null;

  // Auto-scroll history
  useEffect(() => {
    if (historyEndRef.current) {
      historyEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [conversationHistory.length, showEnemyTurn]);

  // Timer countdown (only when timer is enabled)
  useEffect(() => {
    if (!timerEnabled || !timerActive || timerSeconds <= 0) return;
    const interval = setInterval(() => {
      setTimerSeconds(prev => {
        if (prev <= 1) {
          setTimerActive(false);
          void handleTimerExpired();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timerEnabled, timerActive, timerSeconds]);

  // Focus textarea when ready for input
  useEffect(() => {
    const ready = (selectedDifficulty || freeformMode) && (!timerEnabled || timerActive) && !busy;
    if (ready && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [selectedDifficulty, freeformMode, timerEnabled, timerActive, busy, answerStatus]);

  // Hotkeys 1/2/3 for difficulty selection (standard mode only)
  useEffect(() => {
    if (freeformMode || selectedDifficulty || gamePhase !== "playing") return;
    const playerRound = currentRound?.speaker === "player" ? currentRound : null;
    if (!playerRound) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "1") { e.preventDefault(); selectDifficulty("easy"); }
      else if (e.key === "2") { e.preventDefault(); selectDifficulty("medium"); }
      else if (e.key === "3") { e.preventDefault(); selectDifficulty("hard"); }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freeformMode, selectedDifficulty, gamePhase, currentRoundIndex]);

  // Auto-send logic (immediate for Wispr bulk input, debounced for typing)
  useEffect(() => {
    if (autoSendTimer.current) {
      window.clearTimeout(autoSendTimer.current);
      autoSendTimer.current = null;
    }

    if (transcript.length >= MIN_AUTO_SEND_LENGTH && timerActive && (selectedDifficulty || freeformMode)) {
      const lengthIncrease = transcript.length - previousTranscriptLengthRef.current;
      const isWisprInput = lengthIncrease >= 10;
      const delayMs = isWisprInput ? 100 : AUTO_SEND_DELAY_MS;

      autoSendTimer.current = window.setTimeout(() => {
        const now = Date.now();
        if (now - lastSentRef.current > 700) {
          void submitAnswer();
        }
      }, delayMs);
    }

    previousTranscriptLengthRef.current = transcript.length;

    return () => {
      if (autoSendTimer.current) {
        window.clearTimeout(autoSendTimer.current);
        autoSendTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcript]);

  // Init hint refs when difficulty changes
  useEffect(() => {
    if (selectedDifficulty && currentRound?.speaker === "player") {
      const opts = (currentRound as PlayerRound).options[selectedDifficulty];
      hintCardsRefs.current = new Array(opts.hints.length).fill(null);
    }
    setClosestHintIndex(null);
    setClosestHintScale(14);
  }, [selectedDifficulty, currentRoundIndex]);

  // Process enemy turns automatically, and auto-start timer in freeform mode
  useEffect(() => {
    if (gamePhase !== "playing") return;
    if (!currentRound) {
      // No more rounds, game ends
      setGamePhase(enemyHealth <= 0 ? "victory" : playerHealth <= 0 ? "defeat" : "victory");
      return;
    }
    if (currentRound.speaker === "enemy") {
      void processEnemyTurn();
    } else if (freeformMode) {
      // In freeform mode, start timer immediately for player rounds
      setTimerSeconds(TIMER_DURATION);
      setTimerActive(true);
      timerExpiredRef.current = false;
      // Init hint refs for all combined hints
      const pr = currentRound as PlayerRound;
      const allHints = [
        ...pr.options.easy.hints,
        ...pr.options.medium.hints,
        ...pr.options.hard.hints,
      ];
      hintCardsRefs.current = new Array(allHints.length).fill(null);
      setTimeout(() => {
        if (textareaRef.current) textareaRef.current.focus();
      }, 100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRoundIndex, gamePhase]);

  function startGame(conv?: ConversationData) {
    if (conv) setSelectedConversation(conv);
    setGamePhase("playing");
    setPlayerHealth(PLAYER_MAX_HP);
    setEnemyHealth(ENEMY_MAX_HP);
    setCurrentRoundIndex(0);
    setConversationHistory([]);
    setSelectedDifficulty(null);
    setTranscript("");
    setViewedHints(new Set());
    setAnswerStatus("idle");
    setFeedbackMessage("");
    setTimerActive(false);
    setTotalCostCents(0);
    if (petsEnabled) {
      setPlayerPets(PLAYER_PET_EMOJIS.map((emoji, i) => ({ id: `pp${i}`, emoji, hp: PET_MAX_HP, maxHp: PET_MAX_HP })));
      setEnemyPets(ENEMY_PET_EMOJIS.map((emoji, i) => ({ id: `ep${i}`, emoji, hp: PET_MAX_HP, maxHp: PET_MAX_HP })));
    } else {
      setPlayerPets([]);
      setEnemyPets([]);
    }
  }

  async function processEnemyTurn() {
    if (!currentRound || currentRound.speaker !== "enemy") return;
    const enemy = currentRound as EnemyRound;

    setShowEnemyTurn(true);
    await delay(1500);

    setConversationHistory(prev => [...prev, {
      id: enemy.id,
      speaker: "enemy",
      textNative: enemy.enemy_line_native,
      textLearning: enemy.enemy_line_learning,
    }]);

    setShowEnemyTurn(false);
    advanceRound();
  }

  function advanceRound() {
    const nextIdx = currentRoundIndex + 1;
    if (nextIdx >= rounds.length) {
      // Conversation over
      if (enemyHealth <= 0) setGamePhase("victory");
      else if (playerHealth <= 0) setGamePhase("defeat");
      else setGamePhase("victory"); // survived the convo
      return;
    }
    setCurrentRoundIndex(nextIdx);
    setSelectedDifficulty(null);
    setTranscript("");
    setViewedHints(new Set());
    setAnswerStatus("idle");
    setFeedbackMessage("");
    setTimerActive(false);
    timerExpiredRef.current = false;
  }

  function selectDifficulty(diff: Difficulty) {
    setSelectedDifficulty(diff);
    setViewedHints(new Set());
    setTranscript("");
    setAnswerStatus("idle");
    setFeedbackMessage("");
    setTimerSeconds(TIMER_DURATION);
    setTimerActive(true);
    timerExpiredRef.current = false;
    setTimeout(() => {
      if (textareaRef.current) textareaRef.current.focus();
    }, 100);
  }

  function checkFuzzyMatch(userAnswer: string, acceptedList: string[]): boolean {
    const normalize = (text: string) =>
      text.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip accents
        .replace(/[—–\u2014\u2013]/g, " ")               // em/en dashes → space
        .replace(/[¡¿!?.,:;"""''()\[\]{}\-]/g, " ")      // common punctuation → space
        .replace(/[^\x00-\x7f]/g, "")                    // remove any remaining non-ASCII
        .replace(/\s+/g, " ")
        .trim();

    const userNorm = normalize(userAnswer);
    return acceptedList.some(acc => normalize(acc) === userNorm);
  }

  const HINT_COLORS = ["#fbbf24", "#67e8f9", "#86efac", "#c4b5fd", "#f9a8d4", "#fdba74"];

  function highlightHintWords(
    text: string,
    pairs: { native: string; learning: string }[],
    field: "native" | "learning",
  ): React.ReactNode {
    // Build [start, end, colorIndex] ranges
    const ranges: [number, number, number][] = [];
    const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const stripPunct = (s: string) => s.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "");
    const normText = normalize(text);
    pairs.forEach((pair, colorIdx) => {
      const src = field === "native" ? pair.native : pair.learning;
      const terms = src.split("/").map(p => stripPunct(p.trim())).filter(Boolean);
      for (const term of terms) {
        const t = normalize(term);
        let pos = 0;
        while (pos < normText.length) {
          const idx = normText.indexOf(t, pos);
          if (idx === -1) break;
          ranges.push([idx, idx + t.length, colorIdx]);
          pos = idx + t.length;
        }
      }
    });
    if (ranges.length === 0) return text;

    // Sort by start, keep first match when overlapping
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: [number, number, number][] = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
      const last = merged[merged.length - 1];
      if (ranges[i][0] < last[1]) continue; // skip overlapping
      merged.push(ranges[i]);
    }

    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    for (const [start, end, colorIdx] of merged) {
      if (cursor < start) nodes.push(text.slice(cursor, start));
      nodes.push(
        <span key={start} style={{ color: HINT_COLORS[colorIdx % HINT_COLORS.length] }}>
          {text.slice(start, end)}
        </span>
      );
      cursor = end;
    }
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return <>{nodes}</>;
  }

  function renderSentenceWithHints(
    text: string,
    hints: { native: string; learning: string }[],
    revealed: Set<number>,
  ): React.ReactNode {
    const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const stripPunct = (s: string) => s.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "");
    const normText = normalize(text);

    // Build [start, end, hintIndex] ranges
    const ranges: [number, number, number][] = [];
    hints.forEach((hint, hintIdx) => {
      const terms = hint.native.split("/").map(p => stripPunct(p.trim())).filter(Boolean);
      for (const term of terms) {
        const t = normalize(term);
        let pos = 0;
        while (pos < normText.length) {
          const idx = normText.indexOf(t, pos);
          if (idx === -1) break;
          ranges.push([idx, idx + t.length, hintIdx]);
          pos = idx + t.length;
        }
      }
    });
    if (ranges.length === 0) return text;

    ranges.sort((a, b) => a[0] - b[0]);
    const merged: [number, number, number][] = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i][0] < merged[merged.length - 1][1]) continue;
      merged.push(ranges[i]);
    }

    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    for (const [start, end, hintIdx] of merged) {
      if (cursor < start) nodes.push(text.slice(cursor, start));
      const isRevealed = revealed.has(hintIdx);
      nodes.push(
        <span key={start} style={isRevealed
          ? { color: HINT_COLORS[hintIdx % HINT_COLORS.length], transition: "color 0.2s" }
          : { textDecoration: "underline dotted rgba(255,215,0,0.6)", textUnderlineOffset: "3px" }
        }>
          {text.slice(start, end)}
        </span>
      );
      cursor = end;
    }
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return <>{nodes}</>;
  }

  function calculateDamage(diff: Difficulty, hintsUsed: number): number {
    const base = BASE_DAMAGE[diff];
    const penalty = hintsUsed * HINT_PENALTY;
    return Math.max(MIN_DAMAGE, base - penalty);
  }

  async function submitAnswer() {
    if (!currentRound || currentRound.speaker !== "player") return;
    if (!freeformMode && !selectedDifficulty) return;
    const userAnswer = transcript.trim();
    if (!userAnswer || busy || answerStatus === "checking") return;

    lastSentRef.current = Date.now();
    const pr = currentRound as PlayerRound;
    setBusy(true);
    setAnswerStatus("checking");

    if (freeformMode) {
      // Check against all 3 difficulties, try hardest first for best damage
      const diffOrder: Difficulty[] = ["hard", "medium", "easy"];

      // Step 1: fuzzy match across all difficulties
      for (const diff of diffOrder) {
        const opts = pr.options[diff];
        if (checkFuzzyMatch(userAnswer, opts.accepted_translations)) {
          setSelectedDifficulty(diff);
          await handleCorrectAnswer(opts, diff);
          setBusy(false);
          return;
        }
      }

      // Step 2: LLM semantic check - try each difficulty (hardest first)
      for (const diff of diffOrder) {
        const opts = pr.options[diff];
        try {
          const response = await fetch(`${apiBase}/api/battle/check`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              session_id: sessionId,
              user_answer: userAnswer,
              correct_answer: opts.accepted_translations[0],
              prompt_text: opts.native,
              learning: initialLearning,
              fluent: initialFluent,
            }),
          });

          if (!response.ok) continue;
          const data = await response.json();

          if (data.token_usage?.cost_cents) {
            setTotalCostCents(prev => prev + data.token_usage.cost_cents);
          }

          if (data.is_correct) {
            setSelectedDifficulty(diff);
            await handleCorrectAnswer(opts, diff);
            setBusy(false);
            return;
          }
        } catch (e) {
          console.error(e);
        }
      }

      // No match in any difficulty
      handleIncorrectAnswer("Try again!");
      setBusy(false);
      return;
    }

    // Standard mode: check only selected difficulty
    const opts = pr.options[selectedDifficulty!];

    // Step 1: fuzzy match
    if (checkFuzzyMatch(userAnswer, opts.accepted_translations)) {
      await handleCorrectAnswer(opts);
      setBusy(false);
      return;
    }

    // Step 2: LLM semantic check
    try {
      const response = await fetch(`${apiBase}/api/battle/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          user_answer: userAnswer,
          correct_answer: opts.accepted_translations[0],
          prompt_text: opts.native,
          learning: initialLearning,
          fluent: initialFluent,
        }),
      });

      if (!response.ok) throw new Error("Check failed");
      const data = await response.json();

      // Accumulate cost
      if (data.token_usage?.cost_cents) {
        setTotalCostCents(prev => prev + data.token_usage.cost_cents);
      }

      if (data.is_correct) {
        await handleCorrectAnswer(opts);
      } else {
        handleIncorrectAnswer(data.feedback);
      }
    } catch (e) {
      console.error(e);
      handleIncorrectAnswer("Check failed. Try again!");
    } finally {
      setBusy(false);
    }
  }

  async function handleCorrectAnswer(opts: DifficultyOption, diffOverride?: Difficulty) {
    const diff = diffOverride ?? selectedDifficulty;
    if (!diff) return;
    const damage = calculateDamage(diff, viewedHints.size);

    setAnswerStatus("correct");
    setFeedbackMessage(`Correct! ${damage} damage!`);
    setTimerActive(false);

    // Local mutable snapshots so async sequence stays consistent
    let localEnemyHp = enemyHealth;
    const localEnemyPets = enemyPets.map(p => ({ ...p }));

    const getLivingEnemyTargets = () => {
      const t: string[] = [];
      if (localEnemyHp > 0) t.push("enemy");
      localEnemyPets.forEach(p => { if (p.hp > 0) t.push(p.id); });
      return t;
    };

    const attackEnemy = async (attackerId: string, dmg: number) => {
      const targets = getLivingEnemyTargets();
      if (targets.length === 0) return;
      const targetId = targets[Math.floor(Math.random() * targets.length)];

      if (animationsEnabled) {
        setAttackingId(attackerId);
        await delay(220);
      }

      setDamageFlash(targetId);
      if (targetId === "enemy") {
        setLastDamage(dmg);
        localEnemyHp = Math.max(0, localEnemyHp - dmg);
      } else {
        const pi = localEnemyPets.findIndex(p => p.id === targetId);
        if (pi !== -1) localEnemyPets[pi] = { ...localEnemyPets[pi], hp: Math.max(0, localEnemyPets[pi].hp - dmg) };
      }

      await delay(300);
      if (targetId === "enemy") setEnemyHealth(localEnemyHp);
      else setEnemyPets([...localEnemyPets]);
      await delay(500);
      if (animationsEnabled) setAttackingId(null);
      setDamageFlash(null);
      setLastDamage(null);
      await delay(80);
    };

    // Player attacks
    await attackEnemy("player", damage);

    // Player pets attack sequentially
    if (petsEnabled) {
      for (const pet of playerPets.filter(p => p.hp > 0)) {
        if (getLivingEnemyTargets().length === 0) break;
        await attackEnemy(pet.id, PET_DAMAGE);
      }
    }

    // Add to history
    setConversationHistory(prev => [...prev, {
      id: currentRound!.id,
      speaker: "player",
      textNative: opts.native,
      textLearning: transcript.trim(),
      difficulty: diff,
      damageDealt: damage,
      hintsUsed: viewedHints.size,
      usedHintPairs: Array.from(viewedHints).map(idx => ({
        native: currentOptions!.hints[idx].native,
        learning: currentOptions!.hints[idx].learning,
      })),
      allHints: opts.hints,
      acceptedTranslations: opts.accepted_translations,
    }]);

    // Reveal unused hints one at a time before advancing
    const unusedIndices = opts.hints.map((_, i) => i).filter(i => !viewedHints.has(i));
    if (unusedIndices.length > 0) {
      setShowPowerUpBanner(true);
      await delay(350);
      for (const idx of unusedIndices) {
        setRevealingHintIndex(idx);
        await delay(300);
        setViewedHints(prev => new Set([...prev, idx]));
        await delay(520);
        setRevealingHintIndex(null);
        await delay(80);
      }
      await delay(480);
      setShowPowerUpBanner(false);
    } else {
      await delay(800);
    }

    if (localEnemyHp <= 0) {
      setGamePhase("victory");
      return;
    }

    advanceRound();
  }

  function handleIncorrectAnswer(feedback: string) {
    setAnswerStatus("incorrect");
    setFeedbackMessage(feedback || "Try again!");
    setTranscript("");

    setTimeout(() => {
      if (timerActive || timerSeconds > 0) {
        setAnswerStatus("idle");
        setFeedbackMessage("");
        if (textareaRef.current) textareaRef.current.focus();
      }
    }, 1500);
  }

  async function handleTimerExpired() {
    if (!currentRound || currentRound.speaker !== "player" || timerExpiredRef.current) return;
    timerExpiredRef.current = true;

    if (autoSendTimer.current) {
      window.clearTimeout(autoSendTimer.current);
      autoSendTimer.current = null;
    }

    setBusy(true);
    setTranscript("");
    setAnswerStatus("idle");

    // Local mutable snapshots
    let localPlayerHp = playerHealth;
    const localPlayerPets = playerPets.map(p => ({ ...p }));

    const getLivingPlayerTargets = () => {
      const t: string[] = [];
      if (localPlayerHp > 0) t.push("player");
      localPlayerPets.forEach(p => { if (p.hp > 0) t.push(p.id); });
      return t;
    };

    const attackPlayer = async (attackerId: string, dmg: number) => {
      const targets = getLivingPlayerTargets();
      if (targets.length === 0) return;
      const targetId = targets[Math.floor(Math.random() * targets.length)];

      if (animationsEnabled) {
        setAttackingId(attackerId);
        await delay(220);
      }

      setDamageFlash(targetId);
      if (targetId === "player") {
        setLastPlayerDamage(dmg);
        localPlayerHp = Math.max(0, localPlayerHp - dmg);
      } else {
        const pi = localPlayerPets.findIndex(p => p.id === targetId);
        if (pi !== -1) localPlayerPets[pi] = { ...localPlayerPets[pi], hp: Math.max(0, localPlayerPets[pi].hp - dmg) };
      }

      await delay(300);
      if (targetId === "player") setPlayerHealth(localPlayerHp);
      else setPlayerPets([...localPlayerPets]);
      await delay(500);
      if (animationsEnabled) setAttackingId(null);
      setDamageFlash(null);
      setLastPlayerDamage(null);
      await delay(80);
    };

    setFeedbackMessage(`Time's up! ${conversation?.enemy_name ?? "Enemy"} attacks!`);

    // Enemy attacks
    await attackPlayer("enemy", ENEMY_DAMAGE);

    // Enemy pets attack sequentially
    if (petsEnabled) {
      for (const pet of enemyPets.filter(p => p.hp > 0)) {
        if (getLivingPlayerTargets().length === 0) break;
        await attackPlayer(pet.id, PET_DAMAGE);
      }
    }

    setBusy(false);

    if (localPlayerHp <= 0) {
      setGamePhase("defeat");
      return;
    }

    await handleSkip({ fromTimer: true });
  }

  async function handleSkip({ fromTimer = false }: { fromTimer?: boolean } = {}) {
    if (!currentRound || currentRound.speaker !== "player") return;
    if (busy && !fromTimer) return;

    const pr = currentRound as PlayerRound;
    const diff = selectedDifficulty ?? "easy";
    const opts = pr.options[diff];

    if (!fromTimer) {
      setBusy(true);
      setTimerActive(false);
      setTranscript("");
    }

    setAnswerStatus("skipped");
    setFeedbackMessage(opts.accepted_translations[0]);

    // Reveal unused hints one at a time
    const unusedIndices = opts.hints.map((_, i) => i).filter(i => !viewedHints.has(i));
    if (unusedIndices.length > 0) {
      setShowPowerUpBanner(true);
      await delay(300);
      for (const idx of unusedIndices) {
        setRevealingHintIndex(idx);
        await delay(300);
        setViewedHints(prev => new Set([...prev, idx]));
        await delay(520);
        setRevealingHintIndex(null);
        await delay(80);
      }
    }

    await delay(600);
    setShowPowerUpBanner(false);

    setConversationHistory(prev => [...prev, {
      id: pr.id,
      speaker: "player",
      textNative: opts.native,
      textLearning: opts.accepted_translations[0],
      difficulty: diff,
      damageDealt: 0,
      hintsUsed: viewedHints.size,
      usedHintPairs: Array.from(viewedHints).map(idx => ({
        native: opts.hints[idx].native,
        learning: opts.hints[idx].learning,
      })),
      allHints: opts.hints,
      acceptedTranslations: opts.accepted_translations,
      skipped: true,
    }]);

    await delay(400);
    setBusy(false);
    advanceRound();
  }

  function handleHintView(index: number) {
    setViewedHints(prev => new Set([...prev, index]));
  }

  // Proximity-based scaling for hints
  function calculateDistance(cursorX: number, cursorY: number, el: HTMLDivElement): number {
    const rect = el.getBoundingClientRect();
    const dx = Math.max(rect.left - cursorX, 0, cursorX - rect.right);
    const dy = Math.max(rect.top - cursorY, 0, cursorY - rect.bottom);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function distanceToFontSize(distance: number): number {
    const MAX_DISTANCE = 300;
    if (distance >= MAX_DISTANCE) return 14;
    if (distance <= 0) return 24;
    return 14 + 10 * (1 - distance / MAX_DISTANCE);
  }

  function distanceToOpacity(distance: number): number {
    const MAX_DISTANCE = 300;
    if (distance >= MAX_DISTANCE) return 0;
    if (distance <= 0) return 1;
    return 1 - distance / MAX_DISTANCE;
  }

  // Get the active hints list based on mode
  function getActiveHints(): HintItem[] {
    if (!currentRound || currentRound.speaker !== "player") return [];
    const pr = currentRound as PlayerRound;
    if (freeformMode) {
      return [
        ...pr.options.easy.hints,
        ...pr.options.medium.hints,
        ...pr.options.hard.hints,
      ];
    }
    if (selectedDifficulty) return pr.options[selectedDifficulty].hints;
    return [];
  }

  const handleHintsMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const hints = getActiveHints();
    if (hints.length === 0) return;
    const cursorX = e.clientX;
    const cursorY = e.clientY;

    let closest: number | null = null;
    let minDist = Infinity;

    hints.forEach((_, index) => {
      if (viewedHints.has(index)) return;
      const el = hintCardsRefs.current[index];
      if (!el) return;
      const dist = calculateDistance(cursorX, cursorY, el);
      if (dist < minDist) { minDist = dist; closest = index; }
    });

    setClosestHintIndex(closest);
    setClosestHintScale(closest !== null ? distanceToFontSize(minDist) : 14);
    setClosestHintOpacity(closest !== null ? distanceToOpacity(minDist) : 0);
  };

  const handleHintsMouseLeave = () => {
    setClosestHintIndex(null);
    setClosestHintScale(14);
    setClosestHintOpacity(0);
  };

  // Health bar component
  function HealthBar({ current, max, color }: { current: number; max: number; color: string }) {
    const pct = Math.max(0, (current / max) * 100);
    return (
      <div style={{
        width: "100%",
        height: 16,
        background: "#374151",
        borderRadius: 8,
        overflow: "hidden",
        border: "2px solid #1f2937",
      }}>
        <div style={{
          width: `${pct}%`,
          height: "100%",
          background: pct > 50 ? color : pct > 25 ? "#f59e0b" : "#ef4444",
          transition: "width 0.5s ease",
          borderRadius: 6,
        }} />
      </div>
    );
  }

  // --- INTRO SCREEN ---
  if (gamePhase === "intro") {
    const playerRoundsCount = (c: ConversationData) =>
      c.rounds.filter(r => r.speaker === "player").length;

    return (
      <div style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #dc2626 0%, #7c2d12 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, sans-serif",
        padding: 20,
      }}>
        <div style={{
          background: "white",
          borderRadius: 16,
          padding: 40,
          textAlign: "center",
          maxWidth: 600,
          width: "100%",
          boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
        }}>
          <h1 style={{ fontSize: 32, marginBottom: 8, color: "#1f2937" }}>Battle Mode</h1>
          <p style={{ fontSize: 15, color: "#9ca3af", marginBottom: 24, lineHeight: 1.5 }}>
            Choose a conversation, then translate sentences to deal damage!
            <br />Pick easy, medium, or hard for more damage. Hints reduce your damage.
          </p>

          {/* Conversation cards */}
          <div style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            marginBottom: 24,
          }}>
            {ALL_CONVERSATIONS.map(conv => (
              <button
                key={conv.conversation_id}
                onClick={() => startGame(conv)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  padding: "16px 20px",
                  background: "linear-gradient(135deg, #1e1b4b 0%, #312e81 100%)",
                  border: "none",
                  borderRadius: 12,
                  color: "white",
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "transform 0.2s, box-shadow 0.2s",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.transform = "translateY(-3px)";
                  e.currentTarget.style.boxShadow = "0 8px 24px rgba(0,0,0,0.25)";
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.transform = "translateY(0)";
                  e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)";
                }}
              >
                <div style={{ fontSize: 40, flexShrink: 0 }}>
                  {conv.enemy_emoji}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
                    {conv.title}
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.7 }}>
                    vs {conv.enemy_name} &middot; {playerRoundsCount(conv)} rounds
                  </div>
                </div>
                <div style={{ fontSize: 24, opacity: 0.5 }}>&#8250;</div>
              </button>
            ))}
          </div>

          {/* Timer checkbox */}
          <label style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            marginBottom: 20,
            fontSize: 16,
            color: "#374151",
            cursor: "pointer",
            userSelect: "none",
          }}>
            <input
              type="checkbox"
              checked={timerEnabled}
              onChange={e => setTimerEnabled(e.target.checked)}
              style={{ width: 18, height: 18, cursor: "pointer" }}
            />
            30s timer per round
          </label>
          <label style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            marginBottom: 20,
            fontSize: 16,
            color: "#374151",
            cursor: "pointer",
            userSelect: "none",
          }}>
            <input
              type="checkbox"
              checked={freeformMode}
              onChange={e => setFreeformMode(e.target.checked)}
              style={{ width: 18, height: 18, cursor: "pointer" }}
            />
            Freeform mode (all sentences visible)
          </label>
          <label style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            marginBottom: 20,
            fontSize: 16,
            color: "#374151",
            cursor: "pointer",
            userSelect: "none",
          }}>
            <input
              type="checkbox"
              checked={colorHints}
              onChange={e => setColorHints(e.target.checked)}
              style={{ width: 18, height: 18, cursor: "pointer" }}
            />
            Color hints (no resize)
          </label>
          <label style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            marginBottom: 20,
            fontSize: 16,
            color: "#374151",
            cursor: "pointer",
            userSelect: "none",
          }}>
            <input
              type="checkbox"
              checked={petsEnabled}
              onChange={e => setPetsEnabled(e.target.checked)}
              style={{ width: 18, height: 18, cursor: "pointer" }}
            />
            Pets 🐺🦊🦅 vs 🐍🦂🦇 (sequential attacks, random targets)
          </label>
          <label style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            marginBottom: 20,
            fontSize: 16,
            color: "#374151",
            cursor: "pointer",
            userSelect: "none",
          }}>
            <input
              type="checkbox"
              checked={animationsEnabled}
              onChange={e => setAnimationsEnabled(e.target.checked)}
              style={{ width: 18, height: 18, cursor: "pointer" }}
            />
            Attack animations (lunge toward target)
          </label>

          {/* Back button */}
          {onBack && (
            <button onClick={onBack} style={{
              padding: "10px 24px",
              fontSize: 15,
              background: "#6b7280",
              color: "white",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
            }}>
              &#8592; Back to Home
            </button>
          )}
        </div>
      </div>
    );
  }

  // --- MAIN BATTLE UI ---
  const playerRound = currentRound?.speaker === "player" ? (currentRound as PlayerRound) : null;
  const currentOptions = playerRound && selectedDifficulty ? playerRound.options[selectedDifficulty] : null;

  // Count player rounds for "Round X" display
  const playerRoundCount = rounds.filter((r, i) => r.speaker === "player" && i <= currentRoundIndex).length;
  const totalPlayerRounds = rounds.filter(r => r.speaker === "player").length;

  return (
    <>
      <style>{`
        @keyframes fadeInScale {
          0% { opacity: 0; transform: scale(0.5); }
          50% { opacity: 1; transform: scale(1.1); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-8px); }
          40% { transform: translateX(8px); }
          60% { transform: translateX(-6px); }
          80% { transform: translateX(6px); }
        }
        @keyframes floatUp {
          0% { opacity: 1; transform: translateY(0); }
          100% { opacity: 0; transform: translateY(-40px); }
        }
        @keyframes hintGlow {
          0%   { box-shadow: 0 0 0 rgba(255,215,0,0); transform: scale(1); }
          35%  { box-shadow: 0 0 22px rgba(255,215,0,0.85), 0 0 44px rgba(255,215,0,0.35); transform: scale(1.07); }
          100% { box-shadow: 0 0 8px rgba(255,215,0,0.25); transform: scale(1); }
        }
        @keyframes powerUpIn {
          0%   { opacity: 0; transform: translateY(6px) scale(0.9); }
          60%  { opacity: 1; transform: translateY(-1px) scale(1.04); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes lungeRight {
          0%   { transform: translateX(0); }
          40%  { transform: translateX(28px); }
          100% { transform: translateX(0); }
        }
        @keyframes lungeLeft {
          0%   { transform: translateX(0); }
          40%  { transform: translateX(-28px); }
          100% { transform: translateX(0); }
        }
        .hint-revealing { animation: hintGlow 0.55s ease-out; }
        .power-up-banner { animation: powerUpIn 0.3s ease-out forwards; }
        .damage-shake { animation: shake 0.4s ease; }
        .lunge-right { animation: lungeRight 0.38s ease-in-out; }
        .lunge-left  { animation: lungeLeft 0.38s ease-in-out; }
        .damage-float {
          animation: floatUp 1s ease-out forwards;
          position: absolute;
          top: -20px;
          font-size: 24px;
          font-weight: 700;
          color: #ef4444;
          pointer-events: none;
        }
        .status-icon {
          font-size: 60px;
          animation: fadeInScale 0.5s ease-out;
        }
        .battle-log::-webkit-scrollbar { width: 4px; }
        .battle-log::-webkit-scrollbar-track { background: transparent; }
        .battle-log::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }
      `}</style>

      <div style={{
        height: "100vh",
        background: "linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%)",
        display: "flex",
        flexDirection: "column",
        fontFamily: "system-ui, sans-serif",
        color: "white",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          flexShrink: 0,
          background: "rgba(255,255,255,0.1)",
          padding: "10px 20px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          backdropFilter: "blur(10px)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {onBack && (
              <button onClick={onBack} style={{
                padding: "6px 14px",
                fontSize: 14,
                background: "rgba(255,255,255,0.15)",
                color: "white",
                border: "1px solid rgba(255,255,255,0.2)",
                borderRadius: 6,
                cursor: "pointer",
              }}>
                ← Back
              </button>
            )}
            <h2 style={{ margin: 0, fontSize: 18 }}>Battle: {conversation!.title}</h2>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {totalCostCents > 0 && (
              <div style={{ fontSize: 11, opacity: 0.5, fontFamily: "monospace" }}>
                {totalCostCents < 0.01 ? "<0.01" : totalCostCents.toFixed(2)}&#162;
              </div>
            )}
            <div style={{ fontSize: 14, opacity: 0.7 }}>
              Round {playerRoundCount}/{totalPlayerRounds}
            </div>
          </div>
        </div>

        {/* Two-column body */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

          {/* LEFT COLUMN — arena + active play area */}
          <div style={{
            flex: "0 0 66%",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}>
            {/* Scrollable top content */}
            <div style={{
              flexShrink: 0,
              overflowY: "auto",
              padding: "16px 20px 0",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}>

              {/* Compressed Arena */}
              <div style={{
                flexShrink: 0,
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: "12px 20px",
                background: "rgba(255,255,255,0.05)",
                borderRadius: 12,
              }}>
                {/* Main fighters row */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  {/* Player */}
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 10 }}
                    className={[
                      damageFlash === "player" ? "damage-shake" : "",
                      animationsEnabled && attackingId === "player" ? "lunge-right" : "",
                    ].filter(Boolean).join(" ")}
                  >
                    <div style={{ fontSize: 40, position: "relative", lineHeight: 1 }}>
                      {conversation!.player_emoji}
                      {damageFlash === "player" && lastPlayerDamage !== null && <span className="damage-float">-{lastPlayerDamage}</span>}
                    </div>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#93c5fd", marginBottom: 4 }}>You</div>
                      <div style={{ width: 120 }}>
                        <HealthBar current={playerHealth} max={PLAYER_MAX_HP} color="#3b82f6" />
                      </div>
                      <div style={{ fontSize: 11, marginTop: 2, opacity: 0.7 }}>{playerHealth}/{PLAYER_MAX_HP}</div>
                    </div>
                  </div>

                  <div style={{ fontSize: 20, fontWeight: 800, color: "#fbbf24", textShadow: "0 2px 8px rgba(251,191,36,0.4)" }}>VS</div>

                  {/* Enemy */}
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 10, flexDirection: "row-reverse" }}
                    className={[
                      damageFlash === "enemy" ? "damage-shake" : "",
                      animationsEnabled && attackingId === "enemy" ? "lunge-left" : "",
                    ].filter(Boolean).join(" ")}
                  >
                    <div style={{ fontSize: 40, position: "relative", lineHeight: 1 }}>
                      {conversation!.enemy_emoji}
                      {damageFlash === "enemy" && lastDamage !== null && <span className="damage-float">-{lastDamage}</span>}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#fca5a5", marginBottom: 4 }}>{conversation!.enemy_name}</div>
                      <div style={{ width: 120 }}>
                        <HealthBar current={enemyHealth} max={ENEMY_MAX_HP} color="#ef4444" />
                      </div>
                      <div style={{ fontSize: 11, marginTop: 2, opacity: 0.7 }}>{enemyHealth}/{ENEMY_MAX_HP}</div>
                    </div>
                  </div>
                </div>

                {/* Pets row */}
                {petsEnabled && (playerPets.length > 0 || enemyPets.length > 0) && (
                  <div style={{
                    display: "flex", justifyContent: "space-between",
                    paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.06)",
                  }}>
                    {/* Player pets */}
                    <div style={{ display: "flex", gap: 10 }}>
                      {playerPets.map(pet => (
                        <div key={pet.id}
                          style={{
                            display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                            opacity: pet.hp <= 0 ? 0.3 : 1,
                            filter: pet.hp <= 0 ? "grayscale(1)" : "none",
                            transition: "opacity 0.5s, filter 0.5s",
                          }}
                          className={[
                            damageFlash === pet.id ? "damage-shake" : "",
                            animationsEnabled && attackingId === pet.id ? "lunge-right" : "",
                          ].filter(Boolean).join(" ")}
                        >
                          <div style={{ fontSize: 22, lineHeight: 1 }}>{pet.emoji}</div>
                          <div style={{ width: 36 }}>
                            <HealthBar current={pet.hp} max={pet.maxHp} color="#60a5fa" />
                          </div>
                          <div style={{ fontSize: 9, opacity: 0.6 }}>{pet.hp}</div>
                        </div>
                      ))}
                    </div>
                    {/* Enemy pets */}
                    <div style={{ display: "flex", gap: 10 }}>
                      {enemyPets.map(pet => (
                        <div key={pet.id}
                          style={{
                            display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                            opacity: pet.hp <= 0 ? 0.3 : 1,
                            filter: pet.hp <= 0 ? "grayscale(1)" : "none",
                            transition: "opacity 0.5s, filter 0.5s",
                          }}
                          className={[
                            damageFlash === pet.id ? "damage-shake" : "",
                            animationsEnabled && attackingId === pet.id ? "lunge-left" : "",
                          ].filter(Boolean).join(" ")}
                        >
                          <div style={{ fontSize: 22, lineHeight: 1 }}>{pet.emoji}</div>
                          <div style={{ width: 36 }}>
                            <HealthBar current={pet.hp} max={pet.maxHp} color="#f87171" />
                          </div>
                          <div style={{ fontSize: 9, opacity: 0.6 }}>{pet.hp}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>


              {/* Player Turn UI (no textarea here) */}
              {playerRound && !showEnemyTurn && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

                  {/* Timer bar */}
                  {timerEnabled && timerActive && (
                    <div style={{ width: "100%", height: 8, background: "rgba(255,255,255,0.1)", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{
                        width: `${(timerSeconds / TIMER_DURATION) * 100}%`,
                        height: "100%",
                        background: timerSeconds <= 5 ? "#ef4444" : timerSeconds <= 10 ? "#f59e0b" : "#3b82f6",
                        transition: "width 1s linear, background 0.5s",
                        borderRadius: 4,
                      }} />
                    </div>
                  )}
                  {timerEnabled && timerActive && (
                    <div style={{ textAlign: "center", fontSize: 14, opacity: 0.7 }}>{timerSeconds}s remaining</div>
                  )}

                  {/* === FREEFORM MODE — sentences + hints only === */}
                  {freeformMode && playerRound && (() => {
                    const diffColors: Record<Difficulty, string> = { easy: "#22c55e", medium: "#f59e0b", hard: "#ef4444" };
                    const diffBg: Record<Difficulty, string> = { easy: "rgba(34,197,94,0.12)", medium: "rgba(245,158,11,0.12)", hard: "rgba(239,68,68,0.12)" };
                    const diffs: Difficulty[] = ["easy", "medium", "hard"];
                    let hintOffset = 0;
                    const diffHintRanges: { diff: Difficulty; startIdx: number; hints: HintItem[] }[] = diffs.map(d => {
                      const hints = playerRound.options[d].hints;
                      const range = { diff: d, startIdx: hintOffset, hints };
                      hintOffset += hints.length;
                      return range;
                    });

                    return (
                      <div
                        onMouseMove={handleHintsMouseMove}
                        onMouseLeave={handleHintsMouseLeave}
                        style={{ display: "flex", flexDirection: "column", gap: 10 }}
                      >
                        {diffHintRanges.map(({ diff, startIdx, hints }) => (
                          <div key={diff} style={{
                            background: diffBg[diff],
                            border: `1px solid ${diffColors[diff]}40`,
                            borderRadius: 10,
                            padding: "10px 14px",
                          }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: hints.length > 0 ? 8 : 0 }}>
                              <span style={{
                                fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                                color: diffColors[diff], minWidth: 48, flexShrink: 0,
                              }}>
                                {diff} ({BASE_DAMAGE[diff]})
                              </span>
                              <span style={{ fontSize: 14, lineHeight: 1.3 }}>{playerRound.options[diff].native}</span>
                            </div>
                            <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2 }}>
                              {hints.map((hint, i) => {
                                const globalIdx = startIdx + i;
                                const isRevealed = viewedHints.has(globalIdx);
                                const isClosest = closestHintIndex === globalIdx;
                                const dynamicFontSize = colorHints ? 11 : (isClosest && !isRevealed ? closestHintScale : 11);
                                const fProximityBorder = isClosest && !isRevealed && colorHints
                                  ? `1px solid rgba(0, 212, 255, ${Math.max(0.3, closestHintOpacity)})` : undefined;
                                const fProximityBg = isClosest && !isRevealed && colorHints
                                  ? `rgba(0, 212, 255, ${0.15 * closestHintOpacity})` : undefined;
                                const learningParts = hint.learning.split("/").map(p => p.trim()).filter(Boolean);
                                return (
                                  <div
                                    key={globalIdx}
                                    ref={el => { hintCardsRefs.current[globalIdx] = el; }}
                                    onMouseEnter={() => handleHintView(globalIdx)}
                                    style={{
                                      flexShrink: 0,
                                      padding: "6px 10px",
                                      border: isRevealed ? "1px solid rgba(255,255,255,0.2)"
                                        : fProximityBorder || `1px solid ${diffColors[diff]}80`,
                                      borderRadius: 6,
                                      background: isRevealed ? "rgba(255,255,255,0.08)" : (fProximityBg || "rgba(0,0,0,0.15)"),
                                      cursor: "pointer", transition: "all 0.3s ease",
                                    }}
                                  >
                                    <div style={{
                                      fontWeight: 600, fontSize: dynamicFontSize,
                                      color: isRevealed ? "#9ca3af" : "white",
                                      transition: colorHints ? "color 0.15s ease-out" : "font-size 0.15s ease-out",
                                    }}>
                                      {hint.native}
                                    </div>
                                    <div style={{ visibility: isRevealed ? "visible" : "hidden", marginTop: 3 }}>
                                      {learningParts.length > 1
                                        ? <ol style={{ margin: 0, padding: "0 0 0 14px", color: "#93c5fd", fontSize: 10, fontWeight: 500 }}>
                                            {learningParts.map((p, pi) => <li key={pi}>{p}</li>)}
                                          </ol>
                                        : <div style={{ color: "#93c5fd", fontSize: 10, fontWeight: 500 }}>{hint.learning}</div>
                                      }
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                </div>
              )}
            </div>

            {/* Victory / Defeat panel — replaces game UI, keeps battle log visible */}
            {(gamePhase === "victory" || gamePhase === "defeat") && (() => {
              const isVictory = gamePhase === "victory";
              return (
                <div style={{
                  flex: 1, display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center",
                  padding: "0 24px", gap: 16, textAlign: "center",
                }}>
                  <div style={{ fontSize: 64 }}>{isVictory ? "🏆" : "💀"}</div>
                  <div style={{ fontSize: 28, fontWeight: 700 }}>
                    {isVictory ? "Victory!" : "Defeat!"}
                  </div>
                  <div style={{ fontSize: 15, opacity: 0.7 }}>
                    {isVictory
                      ? `You defeated ${conversation?.enemy_name ?? "the enemy"}!`
                      : `${conversation?.enemy_name ?? "The enemy"} defeated you!`}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.45 }}>
                    Your HP: {playerHealth}/{PLAYER_MAX_HP} · Enemy HP: {enemyHealth}/{ENEMY_MAX_HP}
                  </div>
                  <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                    <button
                      onClick={() => setGamePhase("intro")}
                      style={{
                        padding: "10px 22px", fontSize: 14, fontWeight: 600,
                        background: isVictory ? "#22c55e" : "#ef4444",
                        color: "white", border: "none", borderRadius: 8, cursor: "pointer",
                      }}
                    >
                      Play Again
                    </button>
                    {onBack && (
                      <button onClick={onBack} style={{
                        padding: "10px 22px", fontSize: 14,
                        background: "rgba(255,255,255,0.15)", color: "white",
                        border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8, cursor: "pointer",
                      }}>
                        Back to Home
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Unified content zone — shown during enemy turn AND player turn */}
            {!freeformMode && (showEnemyTurn || playerRound) && (() => {
              // Enemy text source: currentRound during animation, history once added
              const lastHistory = conversationHistory.length > 0 ? conversationHistory[conversationHistory.length - 1] : null;
              const enemyText = showEnemyTurn && currentRound?.speaker === "enemy"
                ? (currentRound as EnemyRound).enemy_line_native
                : (lastHistory?.speaker === "enemy" ? lastHistory.textNative : null);

              return (
              <div
                onMouseMove={selectedDifficulty && currentOptions ? handleHintsMouseMove : undefined}
                onMouseLeave={selectedDifficulty && currentOptions ? handleHintsMouseLeave : undefined}
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  padding: "0 20px",
                  gap: 14,
                }}
              >
                <>
                    {/* Top slot — grid overlay so enemy says and hints share the same cell height */}
                    <div style={{ display: "grid", width: "100%" }}>
                      {/* Enemy says — screen 1 + during enemy turn animation */}
                      <div style={{
                        gridRow: 1, gridColumn: 1,
                        visibility: !selectedDifficulty ? "visible" : "hidden",
                        display: "flex", alignItems: "center",
                      }}>
                        {enemyText && (
                          <div style={{
                            width: "100%", padding: "12px 18px",
                            background: "rgba(239,68,68,0.12)", borderRadius: 10, borderLeft: "3px solid #ef4444",
                          }}>
                            <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 3 }}>{conversation!.enemy_name} says:</div>
                            <div style={{ fontSize: 15, lineHeight: 1.4 }}>{enemyText}</div>
                          </div>
                        )}
                      </div>
                      {/* Hints — screen 2 */}
                      <div style={{
                        gridRow: 1, gridColumn: 1,
                        visibility: selectedDifficulty && currentOptions ? "visible" : "hidden",
                        display: "flex", flexDirection: "column", gap: 6, alignItems: "center",
                      }}>
                        {currentOptions && (
                          <>
                            {showPowerUpBanner && (
                              <div className="power-up-banner" style={{
                                fontSize: 12, fontWeight: 600, letterSpacing: "0.06em",
                                color: "#fde68a", opacity: 0.9,
                                display: "flex", alignItems: "center", gap: 5,
                              }}>
                                ✨ REVIEW UNUSED HINTS
                              </div>
                            )}
                            <div style={{ display: "flex", gap: 10, overflowX: "auto", padding: "4px 0", justifyContent: "center", width: "100%" }}>
                              {currentOptions.hints.map((hint, index) => {
                                const isRevealed = viewedHints.has(index);
                                const isRevealing = revealingHintIndex === index;
                                const isClosest = closestHintIndex === index;
                                const dynamicFontSize = colorHints ? 14 : (isClosest && !isRevealed ? closestHintScale : 14);
                                const proximityBorder = isClosest && !isRevealed && colorHints
                                  ? `2px solid rgba(0, 212, 255, ${Math.max(0.3, closestHintOpacity)})` : undefined;
                                const proximityBg = isClosest && !isRevealed && colorHints
                                  ? `rgba(0, 212, 255, ${0.15 * closestHintOpacity})` : undefined;
                                const learningParts = hint.learning.split("/").map(p => p.trim()).filter(Boolean);
                                return (
                                  <div
                                    key={index}
                                    ref={el => { hintCardsRefs.current[index] = el; }}
                                    onMouseEnter={() => handleHintView(index)}
                                    className={isRevealing ? "hint-revealing" : undefined}
                                    style={{
                                      flexShrink: 0, minWidth: 100,
                                      border: isRevealing
                                        ? "2px solid #FFD700"
                                        : isRevealed ? "2px solid rgba(255,255,255,0.3)" : proximityBorder || "2px solid #FFD700",
                                      borderRadius: 8, padding: "8px 12px",
                                      background: isRevealed ? "rgba(255,255,255,0.1)" : (proximityBg || "rgba(255,215,0,0.1)"),
                                      cursor: "pointer", transition: "all 0.3s ease",
                                      boxShadow: isRevealing
                                        ? "0 0 20px rgba(255,215,0,0.75), 0 0 40px rgba(255,215,0,0.3)"
                                        : isRevealed ? "none" : "0 2px 8px rgba(255,215,0,0.2)",
                                    }}
                                  >
                                    <div style={{
                                      fontWeight: 600, marginBottom: 4, fontSize: dynamicFontSize,
                                      color: isRevealed ? "#9ca3af" : "white",
                                      transition: colorHints ? "color 0.15s ease-out" : "font-size 0.15s ease-out",
                                    }}>
                                      {hint.native}
                                    </div>
                                    <div style={{ visibility: isRevealed ? "visible" : "hidden" }}>
                                      {learningParts.length > 1
                                        ? <ol style={{ margin: 0, padding: "0 0 0 16px", color: "#93c5fd", fontSize: 12, fontWeight: 500 }}>
                                            {learningParts.map((p, pi) => <li key={pi}>{p}</li>)}
                                          </ol>
                                        : <div style={{ color: "#93c5fd", fontSize: 12, fontWeight: 500 }}>{hint.learning}</div>
                                      }
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            {viewedHints.size > 0 && (
                              <div style={{ fontSize: 12, opacity: 0.5 }}>
                                Hints used: {viewedHints.size} (-{viewedHints.size * HINT_PENALTY} dmg)
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {/* Bottom slot — grid overlay so buttons and sentence share the same cell height */}
                    <div style={{ display: "grid", width: "100%" }}>
                      {/* Difficulty buttons — screen 1 */}
                      <div style={{
                        gridRow: 1, gridColumn: 1,
                        visibility: !showEnemyTurn && !selectedDifficulty ? "visible" : "hidden",
                        display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap",
                      }}>
                        {(["easy", "medium", "hard"] as Difficulty[]).map(diff => {
                          const opt = playerRound?.options[diff];
                          const borderColor = diff === "easy" ? "#22c55e" : diff === "medium" ? "#f59e0b" : "#ef4444";
                          const bgColor = diff === "easy" ? "rgba(34,197,94,0.15)" : diff === "medium" ? "rgba(245,158,11,0.15)" : "rgba(239,68,68,0.15)";
                          return (
                            <button
                              key={diff}
                              onClick={() => playerRound && selectDifficulty(diff)}
                              style={{
                                flex: "1 1 160px", maxWidth: 220, padding: "14px",
                                background: bgColor, border: `2px solid ${borderColor}`,
                                borderRadius: 12, cursor: "pointer", color: "white",
                                textAlign: "left", transition: "transform 0.2s, box-shadow 0.2s",
                              }}
                              onMouseEnter={e => {
                                e.currentTarget.style.transform = "translateY(-3px)";
                                e.currentTarget.style.boxShadow = `0 6px 20px ${borderColor}40`;
                              }}
                              onMouseLeave={e => {
                                e.currentTarget.style.transform = "translateY(0)";
                                e.currentTarget.style.boxShadow = "none";
                              }}
                            >
                              <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: borderColor, marginBottom: 6 }}>
                                [{diff === "easy" ? 1 : diff === "medium" ? 2 : 3}] {diff} ({BASE_DAMAGE[diff]} dmg)
                              </div>
                              <div style={{ fontSize: 14, lineHeight: 1.4 }}>{opt?.native}</div>
                            </button>
                          );
                        })}
                      </div>
                      {/* Sentence — screen 2 */}
                      <div style={{
                        gridRow: 1, gridColumn: 1,
                        visibility: selectedDifficulty && currentOptions ? "visible" : "hidden",
                        display: "flex", alignItems: "center",
                      }}>
                        {currentOptions && (
                          <div style={{
                            width: "100%", background: "rgba(255,255,255,0.1)", borderRadius: 12,
                            padding: "14px 18px", textAlign: "center",
                          }}>
                            <div style={{ fontSize: 12, opacity: 0.5, marginBottom: 4 }}>
                              Translate this ({selectedDifficulty}):
                            </div>
                            <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.4 }}>
                              {renderSentenceWithHints(currentOptions.native, currentOptions.hints, viewedHints)}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
              </div>
              );
            })()}

            {/* Sticky bottom — textarea (shown when ready for input) */}
            {playerRound && !showEnemyTurn && (freeformMode || selectedDifficulty) && (
              <div style={{
                flexShrink: 0,
                padding: "12px 20px 16px",
                borderTop: "1px solid rgba(255,255,255,0.08)",
                background: "rgba(0,0,0,0.25)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}>
                {/* Status indicator */}
                {(answerStatus === "correct" || answerStatus === "incorrect" || answerStatus === "skipped" || feedbackMessage) && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {answerStatus === "correct" && <span style={{ fontSize: 20, color: "#22c55e" }}>&#10003;</span>}
                    {answerStatus === "incorrect" && <span style={{ fontSize: 20, color: "#ef4444" }}>&#10007;</span>}
                    {answerStatus === "skipped" && <span style={{ fontSize: 16, opacity: 0.6 }}>→</span>}
                    {feedbackMessage && (
                      <span style={{
                        fontSize: 14, fontWeight: 600,
                        color: answerStatus === "correct" ? "#86efac" : answerStatus === "incorrect" ? "#fca5a5" : answerStatus === "skipped" ? "#94a3b8" : "#fbbf24",
                      }}>
                        {feedbackMessage}
                      </span>
                    )}
                  </div>
                )}
                {/* Textarea + buttons */}
                <textarea
                  ref={textareaRef}
                  value={transcript}
                  onChange={e => setTranscript(e.target.value)}
                  onMouseEnter={() => textareaRef.current?.focus()}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitAnswer(); } }}
                  placeholder={freeformMode
                    ? `Translate any sentence in ${initialLearning.name}...`
                    : `Type your translation in ${initialLearning.name}...`}
                  disabled={(!timerActive && timerEnabled) || busy || answerStatus === "correct"}
                  autoFocus
                  style={{
                    width: "100%", minHeight: 56, padding: 12, fontSize: 16,
                    border: "2px solid rgba(255,255,255,0.2)", borderRadius: 8,
                    resize: "none", fontFamily: "system-ui, sans-serif",
                    boxSizing: "border-box", background: "rgba(0,0,0,0.4)", color: "white",
                  }}
                />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button onClick={() => setTranscript("")} disabled={!transcript || busy} style={{
                    padding: "8px 16px", fontSize: 14, background: "rgba(255,255,255,0.15)", color: "white",
                    border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6,
                    cursor: transcript && !busy ? "pointer" : "not-allowed", opacity: transcript && !busy ? 1 : 0.4,
                  }}>Clear</button>
                  <button onClick={() => void handleSkip()} disabled={busy || answerStatus === "correct"} style={{
                    padding: "8px 16px", fontSize: 14, background: "rgba(255,255,255,0.08)", color: "#94a3b8",
                    border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6,
                    cursor: !busy && answerStatus !== "correct" ? "pointer" : "not-allowed",
                    opacity: !busy && answerStatus !== "correct" ? 1 : 0.35,
                  }}>Skip</button>
                  <button
                    onClick={() => void submitAnswer()}
                    disabled={!transcript || (!timerActive && timerEnabled) || busy}
                    style={{
                      padding: "8px 20px", fontSize: 14, fontWeight: 600,
                      background: transcript && (!timerEnabled || timerActive) && !busy
                        ? "linear-gradient(135deg, #3b82f6, #2563eb)" : "rgba(255,255,255,0.1)",
                      color: "white", border: "none", borderRadius: 6,
                      cursor: transcript && (!timerEnabled || timerActive) && !busy ? "pointer" : "not-allowed",
                      opacity: transcript && (!timerEnabled || timerActive) && !busy ? 1 : 0.4,
                    }}
                  >{busy ? "Checking..." : "Send"}</button>
                </div>
              </div>
            )}
          </div>

          {/* RIGHT COLUMN — Battle Log */}
          <div style={{
            flex: "0 0 34%",
            display: "flex",
            flexDirection: "column",
            borderLeft: "1px solid rgba(255,255,255,0.08)",
            overflow: "hidden",
          }}>
            <div style={{
              flexShrink: 0,
              padding: "10px 16px",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
              fontSize: 11,
              fontWeight: 600,
              opacity: 0.5,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}>
              Battle Log
            </div>
            <div
              className="battle-log"
              style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}
            >
              {conversationHistory.map((entry, i) => {
                const isPlayer = entry.speaker === "player";
                const usedHints = isPlayer && (entry.hintsUsed ?? 0) > 0;
                const isHovered = hoveredLogEntry === i;
                const showLearning = isPlayer && (usedHints || entry.skipped || isHovered);
                // On hover show all hints colored; otherwise only used hints
                const highlightPairs = isHovered ? entry.allHints : entry.usedHintPairs;
                return (
                  <div key={i} style={{ display: "flex", justifyContent: isPlayer ? "flex-start" : "flex-end" }}
                    onMouseEnter={() => isPlayer && setHoveredLogEntry(i)}
                    onMouseLeave={() => setHoveredLogEntry(null)}
                  >
                    <div style={{
                      maxWidth: "60%", width: "fit-content", padding: "8px 12px", borderRadius: 12,
                      background: isPlayer ? "rgba(59,130,246,0.25)" : "rgba(239,68,68,0.25)",
                      fontSize: 13, lineHeight: 1.4, wordBreak: "break-word", overflowWrap: "break-word",
                      cursor: isPlayer && !usedHints ? "default" : undefined,
                    }}>
                      <div style={{ opacity: 0.6, fontSize: 11, marginBottom: 2 }}>
                        {isPlayer ? "You" : conversation!.enemy_name}
                        {entry.skipped ? " · skipped" : entry.damageDealt ? ` · ${entry.damageDealt} dmg` : ""}
                        {highlightPairs && highlightPairs.length > 0 && (
                          <span style={{ marginLeft: 6 }}>
                            {highlightPairs.map((_, ci) => (
                              <span key={ci} style={{ color: HINT_COLORS[ci % HINT_COLORS.length] }}>●</span>
                            ))}
                          </span>
                        )}
                      </div>
                      {highlightPairs
                        ? highlightHintWords(entry.textNative, highlightPairs, "native")
                        : entry.textNative}
                      {showLearning && entry.textLearning && (() => {
                        const isPreviewing = previewAnswer?.entryIndex === i;
                        return (
                          <div style={{ marginTop: 5, paddingTop: 5, borderTop: "1px solid rgba(255,255,255,0.12)" }}>
                            {/* Grid overlay so switching texts never resizes the bubble */}
                            <div style={{ display: "grid", color: "rgba(255,255,255,0.55)", fontSize: 12 }}>
                              {[entry.textLearning, ...(entry.acceptedTranslations?.slice(0, 2) ?? [])].map((t, ti) => {
                                const isVisible = ti === 0
                                  ? !isPreviewing
                                  : isPreviewing && previewAnswer!.transIndex === ti - 1;
                                return (
                                  <div key={ti} style={{ gridRow: 1, gridColumn: 1, visibility: isVisible ? "visible" : "hidden" }}>
                                    {highlightPairs ? highlightHintWords(t!, highlightPairs, "learning") : t}
                                  </div>
                                );
                              })}
                            </div>
                            {entry.acceptedTranslations && entry.acceptedTranslations.length > 0 && (
                              <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, marginTop: 5 }}>
                                {entry.acceptedTranslations.slice(0, 2).map((_, ti) => {
                                  const isActive = isPreviewing && previewAnswer!.transIndex === ti;
                                  return (
                                    <div
                                      key={ti}
                                      onMouseEnter={() => setPreviewAnswer({ entryIndex: i, transIndex: ti })}
                                      onMouseLeave={() => setPreviewAnswer(null)}
                                      style={{
                                        width: 16, height: 16, borderRadius: 3, fontSize: 9, fontWeight: 700,
                                        display: "flex", alignItems: "center", justifyContent: "center",
                                        cursor: "pointer",
                                        background: isActive ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.08)",
                                        border: `1px solid ${isActive ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.15)"}`,
                                        color: isActive ? "white" : "rgba(255,255,255,0.4)",
                                        transition: "all 0.15s",
                                        userSelect: "none",
                                      }}
                                    >
                                      {ti + 1}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              })}

              {/* Enemy turn mirrored in log */}
              {showEnemyTurn && currentRound?.speaker === "enemy" && (
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <div style={{
                    maxWidth: "60%", width: "fit-content", padding: "8px 12px", borderRadius: 12,
                    background: "rgba(239,68,68,0.25)", fontSize: 13, lineHeight: 1.4,
                    wordBreak: "break-word", overflowWrap: "break-word",
                    animation: "fadeInScale 0.3s ease-out",
                  }}>
                    <div style={{ opacity: 0.6, fontSize: 11, marginBottom: 2 }}>{conversation!.enemy_name}</div>
                    {(currentRound as EnemyRound).enemy_line_native}
                  </div>
                </div>
              )}

              <div ref={historyEndRef} />
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
