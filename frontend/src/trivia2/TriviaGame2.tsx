// TriviaGame2.tsx — Multiplayer vs Bots game mode
import React, { useEffect, useRef, useState, useCallback } from "react";
import { normalizeNumberTokens } from "../numUtils";
import {
  FEEDBACK_MAP, FEEDBACK_COLORS, FEEDBACK_LABELS,
  HintItem, FeedbackIssue,
  tokenizeWithHints, diffExampleVsUser, calculateDistance, distanceToOpacity,
} from "../sharedGameUtils";
import { FeedbackBadges, CorrectionTokens, HintCards } from "../sharedGameComponents";

type LangSpec = { code: string; name: string };

type Sentence = {
  id: string;
  category: string;
  context: string;
  english: string;
  spanish: string;
  accepted_translations: string[];
  hints: HintItem[];
};

type GamePhase = "lobby" | "vote" | "question" | "resolution" | "scoreboard" | "end";
type RoundType = "spotlight" | "free" | "blitz";
type Difficulty = "easy" | "medium" | "hard";

type Player = {
  id: string;
  name: string;
  isHuman: boolean;
  accuracy: number;
  responseRange: [number, number];
  score: number;
  initials: string;
  color: string;
  image?: string;
};

type TriviaQuestion = {
  sentence: Sentence;
  wordTag: string;
  difficulty: Difficulty;
};

type BotState = {
  playerId: string;
  responseTime: number;
  isCorrect: boolean;
  damageMultiplier: number;
  resolved: boolean;
  pointsAwarded: number;
};

type PlayerResult = {
  accepted: boolean;
  damageMultiplier: number;
  pointsAwarded: number;
  claimedSpeedBonus: boolean;
  hintsUsed: number;
  attempts: number;
  correctionTokens: Array<{ text: string; status: "ok" | "remove" | "add" }> | null;
  feedbackIssues: FeedbackIssue[] | null;
  feedbackKey: string | null;
  correctedSnippet: string | null;
};

type WrongAttempt = {
  correctionTokens: Array<{ text: string; status: "ok" | "remove" | "add" }> | null;
  feedbackIssues: FeedbackIssue[] | null;
};

type QuestionHistoryEntry = {
  entryId: string;
  question: TriviaQuestion;
  roundType: RoundType;
  spotlightWord: string | null;
  playerResult: PlayerResult | null;
  botStates: BotState[];
  hintsRevealed: number[];
  wrongAttempts: WrongAttempt[];
};

type QuestionState = {
  playerResult: PlayerResult | null;
  botStates: BotState[];
  hintsRevealed: number[];
  ended: boolean;
  attemptCount: number;
  wrongAttempts: WrongAttempt[];
};

type TriviaGame2Props = {
  fluent: LangSpec;
  learning: LangSpec;
  apiBase?: string;
  onBack: () => void;
};

const BOTS: Omit<Player, "score">[] = [
  { id: "bot1_Rápida", name: "Darácula",     isHuman: false, accuracy: 0.60, responseRange: [2,  5],  initials: "R", color: "#f87171", image: "/bots/rapida.png"     },
  { id: "bot2_Equilibrio", name: "Professor Ratus", isHuman: false, accuracy: 0.80, responseRange: [5,  9],  initials: "E", color: "#60a5fa", image: "/bots/equilibrio.png" },
  { id: "bot3_Preciso", name: "Tigasaur",    isHuman: false, accuracy: 0.92, responseRange: [10, 16], initials: "P", color: "#34d399", image: "/bots/preciso.png"    },
];

const HUMAN_PLAYER: Omit<Player, "score"> = {
  id: "human", name: "You", isHuman: true, accuracy: 0, responseRange: [0, 0], initials: ":P", color: "#ffd500ff",
};


const HINT_COLORS = ["#f472b6", "#fb923c", "#a78bfa", "#34d399", "#60a5fa", "#fbbf24"];

// ── Utility: normalize for fuzzy match ──
function normalizeForMatch(text: string, langCode: string): string {
  return normalizeNumberTokens(text, langCode)
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[—–—–]/g, " ")
    .replace(/[¡¿!?.,:;"""''()[\]{}\-]/g, " ")
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function checkFuzzyMatch(userAnswer: string, acceptedList: string[], langCode: string): string | null {
  const normUser = normalizeForMatch(userAnswer, langCode).replace(/\s/g, "");
  for (const accepted of acceptedList) {
    const normAccepted = normalizeForMatch(accepted, langCode).replace(/\s/g, "");
    if (normUser === normAccepted) return accepted;
  }
  return null;
}


// ── Sentence selection ──
function selectQuestions(allSentences: Sentence[], wordTag: string): TriviaQuestion[] {
  const n = allSentences.length;
  const third = Math.max(1, Math.floor(n / 3));
  const easy = allSentences.slice(0, third);
  const medium = allSentences.slice(third, 2 * third);
  const hard = allSentences.slice(2 * third);
  const pick = (arr: Sentence[], count: number) =>
    [...arr].sort(() => Math.random() - 0.5).slice(0, Math.min(count, arr.length));
  const selected = [...pick(easy, 2), ...pick(medium, 2), ...pick(hard, 1)];
  const difficulties: Difficulty[] = ["easy", "easy", "medium", "medium", "hard"];
  return selected.map((s, i) => ({ sentence: s, wordTag, difficulty: difficulties[i] }));
}

// ── Bot state sampling ──
function sampleBotStates(roundType: RoundType, bots: Player[]): BotState[] {
  return bots.filter(p => !p.isHuman).map(bot => {
    const acc = roundType === "blitz" ? Math.min(1, bot.accuracy + 0.10) : bot.accuracy;
    const isCorrect = Math.random() < acc;
    const [lo, hi] = bot.responseRange;
    const responseTime = lo + Math.random() * (hi - lo);
    const damageMultiplier = isCorrect ? (0.85 + Math.random() * 0.15) : 0;
    return { playerId: bot.id, responseTime, isCorrect, damageMultiplier, resolved: false, pointsAwarded: 0 };
  });
}

// ── Scoring ──
function calcScore(multiplier: number, hintsUsed: number, isFirstCorrect: boolean, isBlitz: boolean): number {
  if (multiplier === 0) return 0;
  let pts = 100 * multiplier;
  pts -= hintsUsed * 25;
  if (isFirstCorrect) pts += 50;
  pts = Math.max(0, pts);
  if (isBlitz) pts *= 2;
  return Math.round(pts);
}

function initPlayers(): Player[] {
  return [
    { ...HUMAN_PLAYER, score: 0 },
    ...BOTS.map(b => ({ ...b, score: 0 })),
  ];
}

// ── Avatar ──
function Avatar({ player, size = 40 }: { player: Pick<Player, "initials" | "color" | "name" | "image">; size?: number }) {
  if (player.image) {
    return (
      <img
        src={player.image}
        alt={player.name}
        style={{ width: size * 2, height: size * 2, borderRadius: "50%", objectFit: "cover", flexShrink: 0, border: `3px solid ${player.color}` }}
      />
    );
  }
  return (
    <div style={{
      width: size * 2, height: size * 2, borderRadius: "50%",
      background: player.color, display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.64, fontWeight: 700, color: "#fff", flexShrink: 0,
      border: `3px solid ${player.color}`,
    }}>
      {player.initials}
    </div>
  );
}

// ── History entry ──
function HistoryEntry({
  entry, players, apiBase, locale,
}: {
  entry: QuestionHistoryEntry;
  players: Player[];
  apiBase: string;
  locale: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [hoverTimer, setHoverTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [previewExIdx, setPreviewExIdx] = useState<number | null>(null);
  const [hoverAudio, setHoverAudio] = useState<HTMLAudioElement | null>(null);
  const audioCacheRef = useRef<Map<string, string>>(new Map());

  const pr = entry.playerResult;
  const isCorrect = pr?.accepted === true;
  const isExpired = pr === null;

  const bgColor = isCorrect
    ? "rgba(59,130,246,0.2)"
    : isExpired
    ? "rgba(148,163,184,0.15)"
    : "rgba(239,68,68,0.15)";

  const qualityScore = pr ? Math.round(pr.damageMultiplier * 100) : 0;
  const hue = (qualityScore / 100) * 217;
  const hints = entry.question.sentence.hints ?? [];

  async function playHoverAudio() {
    const text = entry.question.sentence.spanish || entry.question.sentence.english;
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
    if (hoverAudio) { hoverAudio.pause(); }
    const audio = new Audio(url);
    setHoverAudio(audio);
    audio.play().catch(() => {});
  }

  function stopHoverAudio() {
    if (hoverAudio) { hoverAudio.pause(); setHoverAudio(null); }
  }

  const isOpen = pinned || expanded;

  const tokens = tokenizeWithHints(entry.question.sentence.english, hints);
  const examples = entry.question.sentence.accepted_translations ?? [];

  const displayText = previewExIdx !== null ? (examples[previewExIdx] ?? "") : null;
  const previewDiff = displayText && pr?.correctionTokens
    ? diffExampleVsUser(pr.correctionTokens.filter(t => t.status !== "remove").map(t => t.text).join(""), displayText)
    : null;

  return (
    <div
      style={{
        background: bgColor,
        borderRadius: 8,
        padding: "8px 10px",
        cursor: "pointer",
        transition: "background 0.15s",
        marginBottom: 4,
        fontSize: 12,
      }}
      onClick={() => setPinned(p => !p)}
      onMouseEnter={() => {
        playHoverAudio();
        const t = setTimeout(() => setExpanded(true), 250);
        setHoverTimer(t);
      }}
      onMouseLeave={() => {
        stopHoverAudio();
        if (hoverTimer) { clearTimeout(hoverTimer); setHoverTimer(null); }
        if (!pinned) setExpanded(false);
      }}
    >
      {/* Collapsed view */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 14 }}>{isCorrect ? "✓" : isExpired ? "—" : "✗"}</span>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "rgba(255,255,255,0.8)" }}>
          {pr?.correctionTokens
            ? pr.correctionTokens.filter(t => t.status !== "remove").map(t => t.text).join("")
            : isExpired ? "— time expired" : entry.question.sentence.english}
        </span>
        {isCorrect && (
          <div style={{ width: 56, height: 5, borderRadius: 3, background: "rgba(255,255,255,0.1)", flexShrink: 0 }}>
            <div style={{ width: `${qualityScore}%`, height: "100%", borderRadius: 3, background: `hsl(${hue},80%,58%)` }} />
          </div>
        )}
        {hints.length > 0 && (
          <div style={{ width: 56, height: 5, borderRadius: 3, background: "rgba(255,255,255,0.1)", flexShrink: 0 }}>
            <div style={{
              width: `${((hints.length - entry.hintsRevealed.length) / hints.length) * 100}%`,
              height: "100%", borderRadius: 3, background: "#fbbf24",
            }} />
          </div>
        )}
      </div>

      {/* Expanded view */}
      {isOpen && (
        <div style={{ marginTop: 10, borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 8 }}>
          {/* English sentence */}
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", marginBottom: 2 }}>
            {entry.question.difficulty === "easy" ? "🟢" : entry.question.difficulty === "medium" ? "🟡" : "🔴"}{" "}
            {entry.roundType !== "free" && entry.spotlightWord && (
              <span style={{ color: "#fbbf24", fontWeight: 600 }}>[{entry.spotlightWord}] </span>
            )}
          </div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.85)", marginBottom: 8, lineHeight: 1.5 }}>
            {tokens.map((tok, i) => {
              if (tok.hintIndex === null) return <span key={i}>{tok.text}</span>;
              const revealed = entry.hintsRevealed.includes(tok.hintIndex);
              return (
                <span
                  key={i}
                  style={{
                    color: revealed ? HINT_COLORS[tok.hintIndex % HINT_COLORS.length] : "inherit",
                    borderBottom: revealed ? "none" : "1px dashed #fbbf24",
                  }}
                >
                  {tok.text}
                </span>
              );
            })}
          </div>

          {/* You said */}
          {pr && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.06em" }}>You said</div>
                {examples.length > 0 && (
                  <div style={{ display: "flex", gap: 4 }} onMouseLeave={() => setPreviewExIdx(null)}>
                    {examples.slice(0, 2).map((_, ei) => (
                      <div
                        key={ei}
                        onMouseEnter={() => setPreviewExIdx(ei)}
                        style={{
                          width: 20, height: 20, borderRadius: 4, fontSize: 10, fontWeight: 700,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          cursor: "default", userSelect: "none",
                          background: previewExIdx === ei ? "rgba(147,197,253,0.2)" : "rgba(255,255,255,0.07)",
                          border: `1px solid ${previewExIdx === ei ? "rgba(147,197,253,0.5)" : "rgba(255,255,255,0.15)"}`,
                          color: previewExIdx === ei ? "#93c5fd" : "rgba(255,255,255,0.4)",
                        }}
                      >
                        {ei + 1}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {previewExIdx !== null && displayText ? (
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                  {(previewDiff ?? diffExampleVsUser("", displayText)).map((tok, i) => (
                    <span key={i} style={{ color: tok.matched ? "rgba(255,255,255,0.5)" : "#fbbf24" }}>
                      {tok.word}{" "}
                    </span>
                  ))}
                </div>
              ) : pr.correctionTokens ? (
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                  <CorrectionTokens tokens={pr.correctionTokens} wrapped={false} />
                </div>
              ) : (
                <div style={{ fontSize: 13, color: pr.accepted ? "#86efac" : "#fca5a5" }}>
                  {pr.accepted ? "✓ Correct" : "✗ Incorrect"}
                </div>
              )}
            </div>
          )}

          {/* Feedback */}
          {pr?.feedbackIssues && pr.feedbackIssues.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Feedback</div>
              <FeedbackBadges issues={pr.feedbackIssues} small />
            </div>
          )}

          {/* Previous attempts */}
          {entry.wrongAttempts.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Previous attempts</div>
              {entry.wrongAttempts.map((attempt, i) => (
                <div key={i} style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 6, padding: "6px 8px", marginBottom: 4 }}>
                  {attempt.correctionTokens && (
                    <div style={{ fontSize: 12, marginBottom: 3, lineHeight: 1.4 }}>
                      <CorrectionTokens tokens={attempt.correctionTokens} wrapped={false} />
                    </div>
                  )}
                  {attempt.feedbackIssues?.length ? <FeedbackBadges issues={attempt.feedbackIssues} small /> : null}
                </div>
              ))}
            </div>
          )}

          {/* Bot results */}
          <div style={{ display: "flex", gap: 6 }}>
            {entry.botStates.map(bs => {
              const bot = players.find(p => p.id === bs.playerId);
              if (!bot) return null;
              return (
                <div key={bs.playerId} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
                  <Avatar player={bot} size={18} />
                  <span style={{ color: bs.isCorrect ? "#86efac" : "#fca5a5" }}>{bs.isCorrect ? "✓" : "✗"}</span>
                  {bs.pointsAwarded > 0 && <span>+{bs.pointsAwarded}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ──
export default function TriviaGame2({
  fluent,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  learning: _learning,
  apiBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000",
  onBack,
}: TriviaGame2Props) {
  const sessionId = useRef(
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  );

  // Language selection (chosen in lobby before game starts)
  const [drillLang, setDrillLang] = useState<"es" | "id" | null>(null);
  const activeLearning: LangSpec = drillLang === "id"
    ? { code: "id", name: "Indonesian" }
    : { code: "es", name: "Spanish" };

  // Game state
  const [phase, setPhase] = useState<GamePhase>("lobby");
  const [players, setPlayers] = useState<Player[]>(initPlayers);
  const [roundIndex, setRoundIndex] = useState(0); // 0,1,2
  const roundTypes: RoundType[] = ["spotlight", "free", "blitz"];
  const [spotlightWords, setSpotlightWords] = useState<string[]>([]); // winner of each spotlight round
  const [availableWords, setAvailableWords] = useState<string[]>([]);
  const [voteWords, setVoteWords] = useState<string[]>([]);
  const [botVotes, setBotVotes] = useState<Record<string, string>>({});
  const [userVote, setUserVote] = useState<string | null>(null);
  const [voteWinner, setVoteWinner] = useState<string | null>(null);
  const [questions, setQuestions] = useState<TriviaQuestion[]>([]);
  const [qIdx, setQIdx] = useState(0);
  const [history, setHistory] = useState<QuestionHistoryEntry[]>([]);
  const [roundScoreDeltas, setRoundScoreDeltas] = useState<Record<string, number>>({});

  // Question-phase state
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(30);
  const [timerActive, setTimerActive] = useState(false);
  const [liveResult, setLiveResult] = useState<PlayerResult | null>(null);
  const [liveRejected, setLiveRejected] = useState(false);
  const [pendingAutoSend, setPendingAutoSend] = useState(false);
  const [pendingProgress, setPendingProgress] = useState<number | null>(null);

  // Hint state
  const [viewedHints, setViewedHints] = useState<Set<number>>(new Set());
  const [hintAudio, setHintAudio] = useState<HTMLAudioElement | null>(null);
  const hintAudioCache = useRef<Map<string, string>>(new Map());

  // Refs for stale-closure avoidance
  const questionStateRef = useRef<QuestionState>({
    playerResult: null, botStates: [], hintsRevealed: [], ended: false, attemptCount: 0,
  });
  const questionsRef = useRef<TriviaQuestion[]>([]);
  const qIdxRef = useRef(0);
  const roundIndexRef = useRef(0);
  const spotlightWordsRef = useRef<string[]>([]);
  const playersRef = useRef<Player[]>(players);
  const botTimerRefs = useRef<ReturnType<typeof setTimeout>[]>([]);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerValueRef = useRef(30);
  const firstCorrectTimeRef = useRef<number | null>(null);

  // UI refs
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyColumnRef = useRef<HTMLDivElement>(null);
  const previousLengthRef = useRef(0);
  const lastSentRef = useRef(0);
  const pendingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentRoundType = roundTypes[roundIndex] ?? "spotlight";
  const currentQuestion = questions[qIdx] ?? null;
  const locale = activeLearning.code === "id" ? "id-ID" : "es-MX";

  // Sync refs
  useEffect(() => { playersRef.current = players; }, [players]);
  useEffect(() => { questionsRef.current = questions; }, [questions]);
  useEffect(() => { qIdxRef.current = qIdx; }, [qIdx]);
  useEffect(() => { roundIndexRef.current = roundIndex; }, [roundIndex]);
  useEffect(() => { spotlightWordsRef.current = spotlightWords; }, [spotlightWords]);

  // Scroll history column (not the page)
  useEffect(() => {
    if (historyColumnRef.current) {
      historyColumnRef.current.scrollTop = historyColumnRef.current.scrollHeight;
    }
  }, [history.length]);

  // Scroll page to top on every phase change
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [phase]);

  // Enter key advances resolution/scoreboard screens
  // Delay activation so the Enter that submitted the answer doesn't immediately advance
  useEffect(() => {
    if (phase !== "resolution" && phase !== "scoreboard") return;
    let ready = false;
    const arm = setTimeout(() => { ready = true; }, 400);
    const handler = (e: KeyboardEvent) => {
      if (!ready || e.key !== "Enter") return;
      e.preventDefault();
      if (phase === "resolution") handleNextQuestion();
      else handleNextRound();
    };
    window.addEventListener("keydown", handler);
    return () => { clearTimeout(arm); window.removeEventListener("keydown", handler); };
  }, [phase]);

  // Autofocus textarea
  useEffect(() => {
    if (phase === "question" && currentQuestion && !busy && !questionStateRef.current.ended) {
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [phase, qIdx, busy]);

  // Timer countdown — uses timerValueRef so handleTimerExpire runs outside setState
  useEffect(() => {
    if (!timerActive) return;
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    timerValueRef.current = 30;
    timerIntervalRef.current = setInterval(() => {
      timerValueRef.current -= 1;
      setTimerSeconds(timerValueRef.current);
      if (timerValueRef.current <= 0) {
        clearInterval(timerIntervalRef.current!);
        timerIntervalRef.current = null;
        handleTimerExpire();
      }
    }, 1000);
    return () => { if (timerIntervalRef.current) clearInterval(timerIntervalRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timerActive, qIdx]);

  function cancelPendingAutoSend(clearText = false) {
    if (pendingTimerRef.current) { clearInterval(pendingTimerRef.current); pendingTimerRef.current = null; }
    setPendingAutoSend(false);
    setPendingProgress(null);
    if (clearText) { setTranscript(""); previousLengthRef.current = 0; setTimeout(() => textareaRef.current?.focus(), 50); }
  }

  function startPendingAutoSend(currentTranscript: string, duration = 2000) {
    cancelPendingAutoSend();
    const startTime = Date.now();
    setPendingAutoSend(true);
    setPendingProgress(1.0);
    pendingTimerRef.current = setInterval(() => {
      const remaining = Math.max(0, 1 - (Date.now() - startTime) / duration);
      setPendingProgress(remaining);
      if (remaining <= 0) {
        clearInterval(pendingTimerRef.current!);
        pendingTimerRef.current = null;
        setPendingAutoSend(false);
        setPendingProgress(null);
        if (currentTranscript.trim()) submitAnswer(currentTranscript);
      }
    }, 30);
  }

  // Wispr auto-send
  useEffect(() => {
    cancelPendingAutoSend();
    if (phase !== "question" || busy || questionStateRef.current.ended) return;
    const delta = transcript.length - previousLengthRef.current;
    if (delta >= 3 && transcript.length > 2 && Date.now() - lastSentRef.current > 700) {
      const q = questionsRef.current[qIdxRef.current];
      const isMatch = q ? checkFuzzyMatch(transcript.trim(), q.sentence.accepted_translations, activeLearning.code) !== null : false;
      startPendingAutoSend(transcript, isMatch ? 1000 : 2000);
    }
    previousLengthRef.current = transcript.length;
    return () => cancelPendingAutoSend();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcript]);

  // ── Fetch words ──
  async function fetchWords(): Promise<string[]> {
    const resp = await fetch(`${apiBase}/api/worddrill/words?lang=${drillLang ?? "es"}`);
    const data = await resp.json();
    const words = data.words as Array<{ key: string } | string>;
    return words.map(w => (typeof w === "string" ? w : w.key));
  }

  async function fetchSentences(word: string): Promise<Sentence[]> {
    const resp = await fetch(`${apiBase}/api/worddrill/sentences/${encodeURIComponent(word)}?lang=${drillLang ?? "es"}`);
    const data = await resp.json();
    return data.sentences as Sentence[];
  }

  // ── Lobby → Vote ──
  async function handleStart() {
    const words = await fetchWords();
    setAvailableWords(words);
    // Round 1 vote: 4 words
    const shuffled = [...words].sort(() => Math.random() - 0.5);
    setVoteWords(shuffled.slice(0, Math.min(4, shuffled.length)));
    setBotVotes({});
    setUserVote(null);
    setVoteWinner(null);
    setRoundIndex(0);
    setHistory([]);
    setRoundScoreDeltas({});
    setPlayers(initPlayers());
    setPhase("vote");
  }

  // ── Vote → Question ──
  async function handleUserVote(word: string) {
    setUserVote(word);

    // Animate bot votes
    const allBots = BOTS;
    const newBotVotes: Record<string, string> = {};
    for (let i = 0; i < allBots.length; i++) {
      await new Promise<void>(res => setTimeout(res, 300));
      const botWord = voteWords[Math.floor(Math.random() * voteWords.length)];
      newBotVotes[allBots[i].id] = botWord;
      setBotVotes({ ...newBotVotes });
    }

    // Compute winner
    await new Promise<void>(res => setTimeout(res, 200));
    const tally: Record<string, number> = {};
    tally[word] = (tally[word] ?? 0) + 1;
    Object.values(newBotVotes).forEach(v => { tally[v] = (tally[v] ?? 0) + 1; });
    const maxVotes = Math.max(...Object.values(tally));
    const tied = Object.keys(tally).filter(k => tally[k] === maxVotes);
    const winner = tied[Math.floor(Math.random() * tied.length)];
    setVoteWinner(winner);

    const newSpotlightWords = [...spotlightWordsRef.current, winner];
    setSpotlightWords(newSpotlightWords);
    spotlightWordsRef.current = newSpotlightWords;

    await new Promise<void>(res => setTimeout(res, 2500));
    await startRound(0, winner, availableWords);
  }

  async function startRound(rIdx: number, spotlightWord: string | null, words: string[]) {
    setRoundIndex(rIdx);
    roundIndexRef.current = rIdx;
    const rt = roundTypes[rIdx];
    let word = spotlightWord;

    if (rt === "free") {
      // Auto-pick a non-spotlight word
      const used = spotlightWordsRef.current;
      const candidates = words.filter(w => !used.includes(w));
      word = candidates[Math.floor(Math.random() * candidates.length)] ?? words[0];
    } else if (rt === "blitz") {
      // Use remaining words not yet spotlit
      const used = spotlightWordsRef.current;
      const candidates = words.filter(w => !used.includes(w));
      // For blitz vote we show candidates (handled separately)
      word = spotlightWord ?? candidates[0];
    }

    const sentences = await fetchSentences(word!);
    const qs = selectQuestions(sentences, word!);
    setQuestions(qs);
    questionsRef.current = qs;
    setQIdx(0);
    qIdxRef.current = 0;
    setRoundScoreDeltas({});
    startQuestion(qs, 0, rt);
  }

  function startQuestion(qs: TriviaQuestion[], idx: number, rt: RoundType) {
    const q = qs[idx];
    if (!q) return;

    // Reset question state
    const initialBotStates = sampleBotStates(rt, playersRef.current);
    questionStateRef.current = {
      playerResult: null,
      botStates: initialBotStates,
      hintsRevealed: [],
      ended: false,
      attemptCount: 0,
      wrongAttempts: [],
    };
    firstCorrectTimeRef.current = null;

    setTranscript("");
    previousLengthRef.current = 0;
    setBusy(false);
    setLiveResult(null);
    setLiveRejected(false);
    setViewedHints(new Set());
    timerValueRef.current = 30;
    setTimerSeconds(30);
    setTimerActive(true);
    setPhase("question");

    // Clear old bot timers
    botTimerRefs.current.forEach(t => clearTimeout(t));
    botTimerRefs.current = [];

    // Schedule bot responses
    initialBotStates.forEach(bs => {
      const t = setTimeout(() => resolveBotAnswer(bs.playerId), bs.responseTime * 1000);
      botTimerRefs.current.push(t);
    });
  }

  function resolveBotAnswer(botId: string) {
    const qState = questionStateRef.current;
    if (qState.ended) return;

    const botState = qState.botStates.find(b => b.playerId === botId);
    if (!botState || botState.resolved) return;

    const rt = roundTypes[roundIndexRef.current] ?? "spotlight";
    const isBlitz = rt === "blitz";
    const now = Date.now();

    let isFirstCorrect = false;
    if (botState.isCorrect && firstCorrectTimeRef.current === null) {
      firstCorrectTimeRef.current = now;
      isFirstCorrect = true;
    }

    const pts = calcScore(botState.damageMultiplier, 0, isFirstCorrect, isBlitz);
    const updatedBot = { ...botState, resolved: true, pointsAwarded: pts };
    const newBotStates = qState.botStates.map(b => b.playerId === botId ? updatedBot : b);
    questionStateRef.current = { ...qState, botStates: newBotStates };

    // Update player score
    setPlayers(prev => prev.map(p =>
      p.id === botId ? { ...p, score: p.score + pts } : p
    ));
    setRoundScoreDeltas(prev => ({ ...prev, [botId]: (prev[botId] ?? 0) + pts }));

    // Force re-render to show bot result
    setPhase(p => p);
  }

  function handleTimerExpire() {
    const qState = questionStateRef.current;
    if (qState.ended) return;
    questionStateRef.current = { ...qState, ended: true };
    setTimerActive(false);
    setBusy(false);
    finalizeQuestion(null);
  }

  function handleSkip() {
    const qState = questionStateRef.current;
    if (qState.ended) return;
    questionStateRef.current = { ...qState, ended: true };
    if (timerIntervalRef.current) { clearInterval(timerIntervalRef.current); timerIntervalRef.current = null; }
    setTimerActive(false);
    setBusy(false);
    botTimerRefs.current.forEach(t => clearTimeout(t));
    botTimerRefs.current = [];
    finalizeQuestion(null);
  }

  function finalizeQuestion(playerResult: PlayerResult | null) {
    const qState = questionStateRef.current;
    const qs = questionsRef.current;
    const idx = qIdxRef.current;
    const q = qs[idx];
    if (!q) return;

    const rt = roundTypes[roundIndexRef.current] ?? "spotlight";
    const sw = rt !== "free" ? (spotlightWordsRef.current[roundIndexRef.current === 2 ? spotlightWordsRef.current.length - 1 : 0] ?? null) : null;

    const entry: QuestionHistoryEntry = {
      entryId: Math.random().toString(36).slice(2) + Date.now().toString(36),
      question: q,
      roundType: rt,
      spotlightWord: sw,
      playerResult,
      botStates: qState.botStates,
      hintsRevealed: [...qState.hintsRevealed],
      wrongAttempts: [...qState.wrongAttempts],
    };
    setHistory(prev => [...prev, entry]);

    // Clear bot timers
    botTimerRefs.current.forEach(t => clearTimeout(t));
    botTimerRefs.current = [];

    setLiveResult(playerResult);
    setTimerActive(false);
    setPhase("resolution");
  }

  async function submitAnswer(answer: string) {
    if (busy || questionStateRef.current.ended) return;
    const q = questionsRef.current[qIdxRef.current];
    if (!q) return;

    lastSentRef.current = Date.now();
    setBusy(true);
    setLiveRejected(false);

    const qState = questionStateRef.current;
    const newAttemptCount = qState.attemptCount + 1;
    questionStateRef.current = { ...qState, attemptCount: newAttemptCount };

    // Step 1: fuzzy match
    const fuzzy = checkFuzzyMatch(answer, q.sentence.accepted_translations, activeLearning.code);
    if (fuzzy !== null) {
      await handleAccepted(answer, 1.0, null, null, null);
      return;
    }

    // Step 2: LLM check
    const rt = roundTypes[roundIndexRef.current] ?? "spotlight";
    const sw = rt !== "free" ? (spotlightWordsRef.current[rt === "blitz" ? spotlightWordsRef.current.length - 1 : 0] ?? null) : null;
    const promptText = rt !== "free" && sw
      ? `Translate using the word '${sw}': ${q.sentence.english}`
      : q.sentence.english;

    try {
      const resp = await fetch(`${apiBase}/api/battle/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId.current,
          user_answer: answer,
          correct_answer: q.sentence.spanish,
          accepted_translations: q.sentence.accepted_translations,
          prompt_text: promptText,
          required_word: rt !== "free" ? sw ?? q.wordTag : undefined,
          learning: activeLearning,
          fluent,
          conversation_id: `trivia2_${rt}_${q.wordTag}`,
          difficulty: q.difficulty,
          hints_used_count: questionStateRef.current.hintsRevealed.length,
          hints_used_phrases: questionStateRef.current.hintsRevealed.map(i => q.sentence.hints[i]?.learning ?? ""),
        }),
      });
      const data = await resp.json();

      const parseIssues = (rawIssues: unknown[]): FeedbackIssue[] =>
        rawIssues.map(item => {
          if (typeof item === "string") {
            return { feedbackKey: item, correctedSnippet: data.corrected_snippet ?? null, feedbackExplanation: data.feedback_explanation ?? null };
          }
          const obj = item as Record<string, unknown>;
          return {
            feedbackKey: (obj.feedback_key as string) ?? "unknown",
            correctedSnippet: (obj.corrected_snippet as string) ?? data.corrected_snippet ?? null,
            feedbackExplanation: (obj.feedback_explanation as string) ?? data.feedback_explanation ?? null,
          };
        });

      if (data.accepted) {
        const issues = parseIssues(data.issues ?? []);
        await handleAccepted(answer, data.damage_multiplier ?? 1.0, data.correction_tokens ?? null, issues, data.corrected_snippet ?? null);
      } else {
        // Rejected
        const issues = parseIssues(data.issues ?? []);
        const rejResult: PlayerResult = {
          accepted: false, damageMultiplier: 0, pointsAwarded: 0, claimedSpeedBonus: false,
          hintsUsed: questionStateRef.current.hintsRevealed.length, attempts: newAttemptCount,
          correctionTokens: data.correction_tokens ?? null,
          feedbackIssues: issues,
          feedbackKey: issues[0]?.feedbackKey ?? null,
          correctedSnippet: data.corrected_snippet ?? null,
        };
        const newWrongAttempts = [...questionStateRef.current.wrongAttempts, {
          correctionTokens: data.correction_tokens ?? null,
          feedbackIssues: issues,
        }];
        questionStateRef.current = { ...questionStateRef.current, wrongAttempts: newWrongAttempts };
        setLiveResult(rejResult);
        setLiveRejected(true);
        setBusy(false);
        setTranscript("");
        previousLengthRef.current = 0;
        setTimeout(() => textareaRef.current?.focus(), 50);
      }
    } catch {
      setBusy(false);
    }
  }

  async function handleAccepted(
    _answer: string,
    multiplier: number,
    correctionTokens: Array<{ text: string; status: "ok" | "remove" | "add" }> | null,
    issues: FeedbackIssue[] | null,
    correctedSnippet: string | null,
  ) {
    const qState = questionStateRef.current;
    if (qState.ended) { setBusy(false); return; }

    const now = Date.now();
    let isFirstCorrect = false;
    if (firstCorrectTimeRef.current === null) {
      firstCorrectTimeRef.current = now;
      isFirstCorrect = true;
    }

    const rt = roundTypes[roundIndexRef.current] ?? "spotlight";
    const isBlitz = rt === "blitz";
    const pts = calcScore(multiplier, qState.hintsRevealed.length, isFirstCorrect, isBlitz);

    const playerResult: PlayerResult = {
      accepted: true, damageMultiplier: multiplier, pointsAwarded: pts,
      claimedSpeedBonus: isFirstCorrect, hintsUsed: qState.hintsRevealed.length,
      attempts: qState.attemptCount, correctionTokens, feedbackIssues: issues,
      feedbackKey: issues?.[0]?.feedbackKey ?? null, correctedSnippet,
    };

    questionStateRef.current = { ...qState, playerResult, ended: true };

    setPlayers(prev => prev.map(p =>
      p.isHuman ? { ...p, score: p.score + pts } : p
    ));
    setRoundScoreDeltas(prev => ({ ...prev, human: (prev.human ?? 0) + pts }));

    // Stop timer
    if (timerIntervalRef.current) { clearInterval(timerIntervalRef.current); timerIntervalRef.current = null; }
    setTimerActive(false);
    setBusy(false);

    finalizeQuestion(playerResult);
  }

  function handleNextQuestion() {
    const nextIdx = qIdxRef.current + 1;
    const rt = roundTypes[roundIndexRef.current] ?? "spotlight";
    if (nextIdx >= questionsRef.current.length) {
      // End of round
      setPhase("scoreboard");
    } else {
      setQIdx(nextIdx);
      qIdxRef.current = nextIdx;
      startQuestion(questionsRef.current, nextIdx, rt);
    }
  }

  async function handleNextRound() {
    const nextRound = roundIndexRef.current + 1;
    if (nextRound >= 3) {
      setPhase("end");
      return;
    }
    setRoundIndex(nextRound);
    roundIndexRef.current = nextRound;

    const rt = roundTypes[nextRound];
    if (rt === "blitz") {
      // Vote phase for blitz: show remaining non-spotlight words
      const used = spotlightWordsRef.current;
      const candidates = availableWords.filter(w => !used.includes(w));
      setVoteWords(candidates.slice(0, Math.min(3, candidates.length)));
      setBotVotes({});
      setUserVote(null);
      setVoteWinner(null);
      setPhase("vote");
    } else {
      // Free round: auto-start
      await startRound(nextRound, null, availableWords);
    }
  }

  async function handleBlitzVote(word: string) {
    setUserVote(word);
    const allBots = BOTS;
    const newBotVotes: Record<string, string> = {};
    for (let i = 0; i < allBots.length; i++) {
      await new Promise<void>(res => setTimeout(res, 300));
      const botWord = voteWords[Math.floor(Math.random() * voteWords.length)];
      newBotVotes[allBots[i].id] = botWord;
      setBotVotes({ ...newBotVotes });
    }
    await new Promise<void>(res => setTimeout(res, 200));
    const tally: Record<string, number> = {};
    tally[word] = (tally[word] ?? 0) + 1;
    Object.values(newBotVotes).forEach(v => { tally[v] = (tally[v] ?? 0) + 1; });
    const maxVotes = Math.max(...Object.values(tally));
    const tied = Object.keys(tally).filter(k => tally[k] === maxVotes);
    const winner = tied[Math.floor(Math.random() * tied.length)];
    setVoteWinner(winner);
    const newSpotlightWords = [...spotlightWordsRef.current, winner];
    setSpotlightWords(newSpotlightWords);
    spotlightWordsRef.current = newSpotlightWords;
    await new Promise<void>(res => setTimeout(res, 2500));
    await startRound(roundIndexRef.current, winner, availableWords);
  }

  function handlePlayAgain() {
    setPhase("lobby");
    setPlayers(initPlayers());
    setHistory([]);
    setSpotlightWords([]);
    spotlightWordsRef.current = [];
  }

  // ── Hint handlers ──
  function revealHint(idx: number) {
    const qState = questionStateRef.current;
    if (!qState.hintsRevealed.includes(idx)) {
      const newRevealed = [...qState.hintsRevealed, idx];
      questionStateRef.current = { ...qState, hintsRevealed: newRevealed };
      setViewedHints(prev => new Set([...prev, idx]));
    }
  }

  async function playHintAudio(hint: HintItem) {
    const text = hint.learning.split("/")[0].trim();
    const key = `${locale}:${text}`;
    let url = hintAudioCache.current.get(key);
    if (!url) {
      try {
        const resp = await fetch(`${apiBase}/api/trivia/audio`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, locale }),
        });
        const data = await resp.json();
        url = `${apiBase}${data.audio_file}`;
        hintAudioCache.current.set(key, url);
      } catch { return; }
    }
    if (hintAudio) { hintAudio.pause(); }
    const audio = new Audio(url);
    setHintAudio(audio);
    audio.play().catch(() => {});
  }

  async function playHintText(text: string) {
    await playHintAudio({ native: "", learning: text });
  }

  function stopHintAudio() {
    if (hintAudio) { hintAudio.pause(); setHintAudio(null); }
  }

  // Sorted players for display
  const sortedPlayers = [...players].sort((a, b) => b.score - a.score);

  const isBlitzPhase = currentRoundType === "blitz";

  // ── Render helpers ──
  function renderLiveResult() {
    if (!liveResult) return null;
    const color = liveResult.accepted
      ? liveResult.damageMultiplier >= 0.95 ? "#86efac" : liveResult.damageMultiplier >= 0.7 ? "#fbbf24" : "#f97316"
      : "#f87171";
    return (
      <div style={{ marginTop: 10 }}>
        {liveResult.accepted && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 18, color }}>✓</span>
            <span style={{ color, fontWeight: 600 }}>
              {liveResult.damageMultiplier >= 0.95 ? "Perfect!" : liveResult.damageMultiplier >= 0.7 ? "Close!" : "Accepted"}
              {" "}+{liveResult.pointsAwarded} pts
            </span>
            {liveResult.claimedSpeedBonus && (
              <span style={{ color: "#fbbf24", fontSize: 12 }}>⚡ Speed Bonus</span>
            )}
          </div>
        )}
        {liveResult.feedbackIssues?.length ? <FeedbackBadges issues={liveResult.feedbackIssues} /> : null}
        {liveResult.correctionTokens && liveResult.accepted && (
          <div style={{ marginTop: 4 }}>
            <CorrectionTokens tokens={liveResult.correctionTokens} wrapped={false} />
          </div>
        )}
        {liveRejected && (
          <div style={{ color: "#fbbf24", fontSize: 13, marginTop: 4 }}>Try again ↩</div>
        )}
      </div>
    );
  }

  function renderBotCards(botStates: BotState[]) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {botStates.map(bs => {
          const bot = players.find(p => p.id === bs.playerId);
          if (!bot) return null;
          return (
            <div key={bs.playerId} style={{
              background: "rgba(255,255,255,0.05)",
              border: `1px solid ${bot.color}33`,
              borderRadius: 10, padding: "10px 14px",
              display: "flex", alignItems: "center", gap: 10,
            }}>
              <Avatar player={bot} size={36} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{bot.name}</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>{bot.score} pts total</div>
              </div>
              <div style={{ textAlign: "right", fontSize: 13 }}>
                {!bs.resolved ? (
                  <span style={{ color: "rgba(255,255,255,0.4)" }}>Thinking…</span>
                ) : bs.isCorrect ? (
                  <span style={{ color: "#86efac" }}>✓ +{bs.pointsAwarded}</span>
                ) : (
                  <span style={{ color: "#fca5a5" }}>✗</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // ── Phase renders ──
  if (phase === "lobby") {
    return (
      <div style={containerStyle}>
        <div style={{ maxWidth: 720, margin: "0 auto", textAlign: "center" }}>
          <button onClick={onBack} style={backBtnStyle}>← Back</button>
          <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Word Showdown</h1>
          <p style={{ color: "rgba(255,255,255,0.6)", marginBottom: 32 }}>vs Bots — 3 Rounds · 15 Questions</p>

          <div style={{ display: "flex", justifyContent: "center", gap: 24, marginBottom: 32, flexWrap: "nowrap" }}>
            {[{ ...HUMAN_PLAYER, score: 0 }, ...BOTS.map(b => ({ ...b, score: 0 }))].map(p => (
              <div key={p.id} style={{ textAlign: "center", minWidth: 0, flex: "0 0 auto" }}>
                <Avatar player={p} size={52} />
                <div style={{ fontSize: 12, marginTop: 6, color: "rgba(255,255,255,0.8)", maxWidth: 120, margin: "6px auto 0" }}>{p.name}</div>
                {!p.isHuman && (
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
                    {Math.round((p as any).accuracy * 100)}% acc
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, marginBottom: 28 }}>
            Round 1: Word Spotlight · Round 2: Free Translation · Round 3: Final Blitz (2×)
          </div>

          {/* Language picker */}
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
              Language
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              {([["es", "🇲🇽", "Spanish"], ["id", "🇮🇩", "Indonesian"]] as const).map(([code, flag, label]) => (
                <button
                  key={code}
                  onClick={() => setDrillLang(code)}
                  style={{
                    padding: "10px 20px", borderRadius: 10, fontSize: 14, fontWeight: 600,
                    border: `2px solid ${drillLang === code ? "#a78bfa" : "rgba(255,255,255,0.18)"}`,
                    background: drillLang === code ? "rgba(167,139,250,0.2)" : "rgba(255,255,255,0.05)",
                    color: "white", cursor: "pointer", transition: "all 0.15s",
                  }}
                >
                  {flag} {label}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleStart}
            disabled={!drillLang}
            style={{ ...primaryBtnStyle, opacity: drillLang ? 1 : 0.4, cursor: drillLang ? "pointer" : "not-allowed" }}
          >
            Start Game
          </button>
        </div>
      </div>
    );
  }

  if (phase === "vote") {
    const isBlitzVote = roundIndex === 2;
    return (
      <div style={containerStyle}>
        <div style={{ maxWidth: 480, margin: "0 auto", textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", marginBottom: 8 }}>
            {isBlitzVote ? "Final Blitz — Vote for the word!" : "Round 1 — Choose the spotlight word"}
          </div>
          <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 24 }}>
            {isBlitzVote ? "🔥 Final Blitz Word Vote" : "Word Vote"}
          </h2>

          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", marginBottom: 28 }}>
            {voteWords.map(word => (
              <button
                key={word}
                onClick={() => !userVote && (isBlitzVote ? handleBlitzVote(word) : handleUserVote(word))}
                style={{
                  padding: "12px 22px", borderRadius: 8, fontSize: 15, fontWeight: 600,
                  border: `2px solid ${userVote === word ? "#a78bfa" : "rgba(255,255,255,0.2)"}`,
                  background: userVote === word ? "rgba(167,139,250,0.2)" : "rgba(255,255,255,0.05)",
                  color: "white", cursor: userVote ? "default" : "pointer",
                  transition: "all 0.15s",
                }}
              >
                {word}
              </button>
            ))}
          </div>

          {/* Bot votes */}
          {Object.keys(botVotes).length > 0 && (
            <div style={{ display: "flex", gap: 12, justifyContent: "center", marginBottom: 20 }}>
              {BOTS.map(bot => (
                <div key={bot.id} style={{ textAlign: "center" }}>
                  <Avatar player={bot} size={32} />
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", marginTop: 4 }}>
                    {botVotes[bot.id] ?? "…"}
                  </div>
                </div>
              ))}
            </div>
          )}

          {voteWinner && (
            <div style={{
              padding: "12px 20px", borderRadius: 8,
              background: "rgba(167,139,250,0.15)", border: "1px solid rgba(167,139,250,0.4)",
              fontSize: 15, fontWeight: 600, color: "#a78bfa",
            }}>
              "{voteWinner}" wins the vote! Starting…
            </div>
          )}
        </div>
      </div>
    );
  }

  if (phase === "question" && currentQuestion) {
    const hints = currentQuestion.sentence.hints ?? [];
    const rt = currentRoundType;

    return (
      <div style={{ ...containerStyle, padding: "16px 20px" }}>
        {isBlitzPhase && (
          <div style={{
            background: "linear-gradient(90deg, #f97316, #dc2626)",
            padding: "6px 16px", borderRadius: 6, textAlign: "center",
            fontSize: 13, fontWeight: 700, marginBottom: 12, letterSpacing: "0.05em",
          }}>
            🔥 FINAL BLITZ — 2× POINTS
          </div>
        )}

        <div style={{ display: "flex", gap: 16, height: "calc(100vh - 80px)" }}>
          {/* Left: question + input */}
          <div style={{ flex: "0 0 66%", display: "flex", flexDirection: "column", overflowY: "auto" }}>
            {/* Header: round / question info */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <button onClick={onBack} style={{ ...backBtnStyle, marginBottom: 0 }}>←</button>
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
                Round {roundIndex + 1}/3 · Q{qIdx + 1}/5
              </span>
              <span style={{
                fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999,
                background: currentQuestion.difficulty === "easy" ? "rgba(74,222,128,0.15)" : currentQuestion.difficulty === "medium" ? "rgba(251,191,36,0.15)" : "rgba(248,113,113,0.15)",
                border: `1px solid ${currentQuestion.difficulty === "easy" ? "#4ade8066" : currentQuestion.difficulty === "medium" ? "#fbbf2466" : "#f8717166"}`,
                color: currentQuestion.difficulty === "easy" ? "#4ade80" : currentQuestion.difficulty === "medium" ? "#fbbf24" : "#f87171",
              }}>
                {currentQuestion.difficulty.charAt(0).toUpperCase() + currentQuestion.difficulty.slice(1)}
              </span>
              <div style={{ flex: 1 }} />
              {/* Timer bar */}
              <div style={{ width: 120, height: 6, background: "rgba(255,255,255,0.1)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{
                  height: "100%", borderRadius: 3, transition: "width 1s linear",
                  width: `${(timerSeconds / 30) * 100}%`,
                  background: timerSeconds > 10 ? "#4ade80" : timerSeconds > 5 ? "#fbbf24" : "#f87171",
                }} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: timerSeconds <= 5 ? "#f87171" : "rgba(255,255,255,0.7)", minWidth: 28, textAlign: "right" }}>
                {timerSeconds}s
              </span>
            </div>

            {/* Context */}
            {currentQuestion.sentence.context && (
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 6, fontStyle: "italic" }}>
                {currentQuestion.sentence.context}
              </div>
            )}

            {/* Required word banner */}
            {rt !== "free" && (
              <div style={{
                marginBottom: 10,
                padding: "10px 16px",
                borderRadius: 10,
                background: "rgba(167,139,250,0.12)",
                border: "1px solid rgba(167,139,250,0.45)",
                display: "flex", alignItems: "center", gap: 10,
              }}>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "rgba(167,139,250,0.7)" }}>
                  Required word
                </span>
                <span style={{
                  fontSize: 18, fontWeight: 800, color: "#c4b5fd",
                  letterSpacing: "0.02em",
                }}>
                  {spotlightWords[rt === "blitz" ? spotlightWords.length - 1 : 0] ?? currentQuestion.wordTag}
                </span>
                <span style={{ fontSize: 12, color: "rgba(167,139,250,0.55)", marginLeft: "auto" }}>
                  must appear in your answer
                </span>
              </div>
            )}

            {/* English sentence */}
            <div style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: "16px 20px", marginBottom: 12 }}>
              <div style={{ fontSize: 12, opacity: 0.4, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
                Translate to {activeLearning.name}
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.5, color: "rgba(255,255,255,0.95)" }}>
                {hints.length > 0
                  ? tokenizeWithHints(currentQuestion.sentence.english, hints).map((tok, i) => {
                      if (tok.hintIndex === null) return <span key={i}>{tok.text}</span>;
                      const revealed = viewedHints.has(tok.hintIndex);
                      return (
                        <span key={i} style={{
                          color: revealed ? HINT_COLORS[tok.hintIndex % HINT_COLORS.length] : "inherit",
                          borderBottom: revealed ? "none" : "2px dashed #fbbf24",
                          cursor: "default",
                        }}>{tok.text}</span>
                      );
                    })
                  : currentQuestion.sentence.english}
              </div>
            </div>

            {/* Hints */}
            {hints.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <HintCards
                  key={currentQuestion?.sentence.id}
                  hints={hints}
                  viewedHints={viewedHints}
                  onReveal={revealHint}
                  onPlayAudio={text => void playHintText(text)}
                  onStopAudio={stopHintAudio}
                />
              </div>
            )}

            {/* Textarea + buttons */}
            <div style={{ marginBottom: 12 }}>
              <textarea
                ref={textareaRef}
                value={transcript}
                onChange={e => setTranscript(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Escape") { cancelPendingAutoSend(true); return; }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (!busy && !questionStateRef.current.ended && transcript.trim()) submitAnswer(transcript);
                  }
                }}
                onMouseEnter={() => { if (!busy && !questionStateRef.current.ended) textareaRef.current?.focus(); }}
                disabled={busy || questionStateRef.current.ended}
                placeholder="Type your translation…"
                rows={2}
                style={{
                  width: "100%", padding: "10px 12px", borderRadius: 8,
                  background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.15)",
                  color: "white", fontSize: 15, resize: "none", boxSizing: "border-box",
                  outline: "none",
                }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <button
                  onClick={() => { if (!busy && !questionStateRef.current.ended && transcript.trim()) submitAnswer(transcript); }}
                  disabled={busy || questionStateRef.current.ended || !transcript.trim()}
                  style={{ ...primaryBtnStyle, padding: "8px 20px", fontSize: 13 }}
                >
                  {busy ? "Checking…" : "Check"}
                </button>
                <button
                  onClick={() => { setTranscript(""); previousLengthRef.current = 0; textareaRef.current?.focus(); }}
                  style={{ ...ghostBtnStyle, padding: "8px 14px", fontSize: 13 }}
                >
                  Clear
                </button>
                <button
                  onClick={handleSkip}
                  disabled={questionStateRef.current.ended}
                  style={{ ...ghostBtnStyle, padding: "8px 14px", fontSize: 13, color: "rgba(255,255,255,0.45)", marginLeft: "auto" }}
                >
                  Skip →
                </button>
              </div>
              {pendingAutoSend && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                  <div style={{ flex: 1, height: 3, background: "rgba(255,255,255,0.1)", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ width: `${(pendingProgress ?? 0) * 100}%`, height: "100%", background: "#a78bfa", borderRadius: 2 }} />
                  </div>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", whiteSpace: "nowrap" }}>
                    Sending… <kbd style={{ fontSize: 10, background: "rgba(255,255,255,0.1)", padding: "1px 5px", borderRadius: 3, border: "1px solid rgba(255,255,255,0.2)" }}>Esc</kbd> to cancel
                  </span>
                </div>
              )}
            </div>

            {/* Live feedback */}
            {renderLiveResult()}
          </div>

          {/* Right: bot cards + history */}
          <div style={{ flex: "0 0 34%", display: "flex", flexDirection: "column", gap: 12, overflow: "hidden" }}>
            {renderBotCards(questionStateRef.current.botStates)}
            <div ref={historyColumnRef} style={{ flex: 1, overflowY: "auto", marginTop: 8 }}>
              {history.map(entry => (
                <HistoryEntry key={entry.entryId} entry={entry} players={players} apiBase={apiBase} locale={locale} />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "resolution" && currentQuestion) {
    const pr = liveResult;
    const qState = questionStateRef.current;
    const isExpired = pr === null;

    return (
      <div style={{ ...containerStyle, padding: "16px 20px" }}>
        {isBlitzPhase && (
          <div style={{
            background: "linear-gradient(90deg, #f97316, #dc2626)",
            padding: "6px 16px", borderRadius: 6, textAlign: "center",
            fontSize: 13, fontWeight: 700, marginBottom: 12,
          }}>
            🔥 FINAL BLITZ — 2× POINTS
          </div>
        )}

        <div style={{ display: "flex", gap: 16, height: "calc(100vh - 80px)" }}>
          <div style={{ flex: "0 0 66%", overflowY: "auto" }}>
            {/* Sentence */}
            <div style={{ fontSize: 15, color: "rgba(255,255,255,0.5)", marginBottom: 6 }}>{currentQuestion.sentence.english}</div>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.3)", fontStyle: "italic", marginBottom: 16 }}>{currentQuestion.sentence.context}</div>

            {/* All 4 results */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
              {/* Human */}
              {(() => {
                const humanPlayer = players.find(p => p.isHuman)!;
                const color = pr?.accepted ? "#86efac" : "#f87171";
                return (
                  <div style={{
                    background: "rgba(255,255,255,0.07)", border: `1px solid ${color}44`, borderRadius: 10, padding: 14,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <Avatar player={humanPlayer} size={32} />
                      <span style={{ fontWeight: 600 }}>{humanPlayer.name}</span>
                      <span style={{ marginLeft: "auto", fontSize: 20 }}>{isExpired ? "—" : pr?.accepted ? "✓" : "✗"}</span>
                    </div>
                    {pr?.accepted && (
                      <div style={{ fontSize: 13, color: "#86efac" }}>+{pr.pointsAwarded} pts{pr.claimedSpeedBonus ? " ⚡" : ""}</div>
                    )}
                    {isExpired && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Time expired</div>}
                    {pr && !pr.accepted && <div style={{ fontSize: 12, color: "#f87171" }}>No points</div>}
                  </div>
                );
              })()}
              {/* Bots */}
              {qState.botStates.map(bs => {
                const bot = players.find(p => p.id === bs.playerId)!;
                return (
                  <div key={bs.playerId} style={{
                    background: "rgba(255,255,255,0.07)",
                    border: `1px solid ${bs.isCorrect ? "#86efac44" : "#f8717144"}`, borderRadius: 10, padding: 14,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <Avatar player={bot} size={32} />
                      <span style={{ fontWeight: 600 }}>{bot.name}</span>
                      <span style={{ marginLeft: "auto", fontSize: 20 }}>{bs.isCorrect ? "✓" : "✗"}</span>
                    </div>
                    {bs.isCorrect
                      ? <div style={{ fontSize: 13, color: "#86efac" }}>+{bs.pointsAwarded} pts</div>
                      : <div style={{ fontSize: 12, color: "#f87171" }}>No points</div>}
                  </div>
                );
              })}
            </div>

            {/* Correction diff */}
            {pr?.correctionTokens && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 4, textTransform: "uppercase" }}>Your answer</div>
                <div style={{ fontSize: 14 }}>
                  <CorrectionTokens tokens={pr.correctionTokens} wrapped={false} />
                </div>
              </div>
            )}

            {/* Correct answer when skipped/expired */}
            {!pr && (
              <div style={{ marginBottom: 14, padding: "10px 14px", background: "rgba(134,239,172,0.07)", border: "1px solid rgba(134,239,172,0.2)", borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 6, textTransform: "uppercase" }}>Correct answer</div>
                <div style={{ fontSize: 15, color: "#86efac", marginBottom: 4 }}>{currentQuestion.sentence.spanish}</div>
                {currentQuestion.sentence.accepted_translations.filter(t => t !== currentQuestion.sentence.spanish).slice(0, 2).map((t, i) => (
                  <div key={i} style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", marginTop: 3 }}>{t}</div>
                ))}
              </div>
            )}

            {/* Next button */}
            <button onClick={handleNextQuestion} style={{ ...primaryBtnStyle, marginTop: 8 }}>
              {qIdx + 1 >= questions.length ? "End Round →" : "Next →"}
            </button>
          </div>

          {/* History */}
          <div ref={historyColumnRef} style={{ flex: "0 0 34%", overflowY: "auto" }}>
            {history.map(entry => (
              <HistoryEntry key={entry.entryId} entry={entry} players={players} apiBase={apiBase} locale={locale} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (phase === "scoreboard") {
    return (
      <div style={{ ...containerStyle, padding: 24 }}>
        <div style={{ maxWidth: 420, margin: "0 auto", textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>
            Round {roundIndex + 1} of 3 complete
          </div>
          <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 24 }}>Scoreboard</h2>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 28 }}>
            {sortedPlayers.map((p, rank) => (
              <div key={p.id} style={{
                display: "flex", alignItems: "center", gap: 12,
                background: "rgba(255,255,255,0.07)", borderRadius: 10, padding: "12px 16px",
                border: p.isHuman ? "1px solid rgba(167,139,250,0.4)" : "1px solid rgba(255,255,255,0.1)",
              }}>
                <span style={{ fontSize: 16, width: 24, textAlign: "center" }}>
                  {rank === 0 ? "👑" : `#${rank + 1}`}
                </span>
                <Avatar player={p} size={36} />
                <span style={{ flex: 1, fontWeight: 600 }}>{p.name}</span>
                <span style={{ fontSize: 18, fontWeight: 700 }}>{p.score}</span>
                {roundScoreDeltas[p.id] != null && roundScoreDeltas[p.id] > 0 && (
                  <span style={{ fontSize: 12, color: "#86efac" }}>+{roundScoreDeltas[p.id]}</span>
                )}
              </div>
            ))}
          </div>

          <button onClick={handleNextRound} style={primaryBtnStyle}>
            {roundIndex >= 2 ? "See Final Results" : roundIndex === 1 ? "Final Blitz! 🔥" : "Next Round →"}
          </button>
        </div>
      </div>
    );
  }

  if (phase === "end") {
    const winner = sortedPlayers[0];
    const humanRank = sortedPlayers.findIndex(p => p.isHuman);
    return (
      <div style={{ ...containerStyle, padding: 24 }}>
        <div style={{ maxWidth: 420, margin: "0 auto", textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>
            {humanRank === 0 ? "🏆" : "🎮"}
          </div>
          <h2 style={{ fontSize: 26, fontWeight: 700, marginBottom: 6 }}>
            {humanRank === 0 ? "You won!" : `${winner.name} wins!`}
          </h2>
          <p style={{ color: "rgba(255,255,255,0.5)", marginBottom: 28 }}>
            {humanRank === 0 ? "Great job beating the bots!" : `You finished #${humanRank + 1}`}
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 28 }}>
            {sortedPlayers.map((p, rank) => (
              <div key={p.id} style={{
                display: "flex", alignItems: "center", gap: 12,
                background: "rgba(255,255,255,0.07)", borderRadius: 10, padding: "12px 16px",
                border: rank === 0 ? "1px solid rgba(251,191,36,0.4)" : "1px solid rgba(255,255,255,0.1)",
              }}>
                <span style={{ fontSize: 16, width: 24, textAlign: "center" }}>
                  {rank === 0 ? "👑" : `#${rank + 1}`}
                </span>
                <Avatar player={p} size={36} />
                <span style={{ flex: 1, fontWeight: 600 }}>{p.name}</span>
                <span style={{ fontSize: 18, fontWeight: 700 }}>{p.score}</span>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button onClick={handlePlayAgain} style={primaryBtnStyle}>Play Again</button>
            <button onClick={onBack} style={ghostBtnStyle}>Back to Menu</button>
          </div>
        </div>
      </div>
    );
  }

  // Loading / transitional state
  return (
    <div style={containerStyle}>
      <div style={{ textAlign: "center", color: "rgba(255,255,255,0.5)" }}>Loading…</div>
    </div>
  );
}

// ── Shared styles ──
const containerStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #1e1b4b 100%)",
  color: "white",
  fontFamily: "system-ui, -apple-system, sans-serif",
  padding: 20,
};

const primaryBtnStyle: React.CSSProperties = {
  padding: "12px 28px",
  background: "linear-gradient(135deg, #7c3aed, #4f46e5)",
  border: "none",
  borderRadius: 8,
  color: "white",
  fontWeight: 600,
  fontSize: 15,
  cursor: "pointer",
};

const ghostBtnStyle: React.CSSProperties = {
  padding: "12px 20px",
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 8,
  color: "white",
  fontWeight: 600,
  fontSize: 15,
  cursor: "pointer",
};

const backBtnStyle: React.CSSProperties = {
  marginBottom: 16,
  padding: "6px 14px",
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 6,
  color: "rgba(255,255,255,0.7)",
  fontSize: 13,
  cursor: "pointer",
  display: "inline-block",
};
