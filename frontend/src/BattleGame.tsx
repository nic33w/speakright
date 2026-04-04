// BattleGame.tsx
// Battle mode: conversational battle with translation challenges
import React, { useEffect, useState, useRef } from "react";
import BATTLE_CONV_CAFE from './battle_conversations_es.json';
import BATTLE_CONV_MARKET from './battle_conversations_es_2.json';
import BATTLE_CONV_NEIGHBOR from './battle_conversations_es_3.json';
import BATTLE_CONV_WARUNG from './battle_conversations_id.json';
import BATTLE_CONV_BATIK from './battle_conversations_id_2.json';

type LangSpec = { code: string; name: string };

type HintItem = { native: string; learning: string; note?: string };

type DifficultyOption = {
  native: string;
  accepted_translations: string[];
  hints: HintItem[];
  leads_to_branch?: string;
};

type PlayerRound = {
  id: number | string;
  speaker: "player";
  branch_point?: boolean;
  branch?: string;
  options: {
    easy: DifficultyOption;
    medium: DifficultyOption;
    hard: DifficultyOption;
  };
};

type DefendQuestion = {
  audio_url: string;
  question: string;
  choices: string[];
  correct_index: number;
};

type EnemyVariant = {
  enemy_line_native: string;
  enemy_line_learning: string;
  defend_question?: DefendQuestion;
};

type EnemyRound = {
  id: number | string;
  speaker: "enemy";
  branch?: string;
  enemy_line_native?: string;
  enemy_line_learning?: string;
  defend_question?: DefendQuestion;
  variants?: EnemyVariant[];
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
  BATTLE_CONV_WARUNG as any,
  BATTLE_CONV_BATIK as any,
];

const CONV_LANGUAGE: Record<string, LangSpec> = {
  cafe_encounter: { code: "es", name: "Spanish" },
  market_haggle:  { code: "es", name: "Spanish" },
  new_neighbor:   { code: "es", name: "Spanish" },
  warung_order:   { code: "id", name: "Indonesian" },
  batik_bargain:  { code: "id", name: "Indonesian" },
};

type Difficulty = "easy" | "medium" | "hard";

type CompletedRound = {
  id: number | string;
  speaker: "player" | "enemy";
  textNative: string;
  textLearning?: string;
  difficulty?: Difficulty;
  damageDealt?: number;
  llmCalled?: boolean;
  hintsUsed?: number;
  usedHintPairs?: { native: string; learning: string }[];
  allHints?: { native: string; learning: string }[];
  acceptedTranslations?: string[];
  skipped?: boolean;
  isWrongAttempt?: boolean;
  feedbackKey?: string | null;
  correctedSnippet?: string | null;
  feedbackExplanation?: string | null;
  correctionTokens?: Array<{ text: string; status: "ok" | "remove" | "add" }> | null;
  qualityScore?: number | null; // 0–100 derived from damage_multiplier
};

type BattleGameProps = {
  apiBase?: string;
  fluent?: LangSpec;
  learning?: LangSpec;
  onBack?: () => void;
};

const TIMER_DURATION = 30;
const MIN_AUTO_SEND_LENGTH = 2;
const BASE_DAMAGE: Record<Difficulty, number> = { easy: 10, medium: 20, hard: 30 };
const HINT_PENALTY = 2;
const MIN_DAMAGE = 5;
const ENEMY_DAMAGE = 15;
const DEFEND_COUNTER_DAMAGE = 10;

const FEEDBACK_MAP: Record<string, string> = {
  asr_error: "Looks like a speech-to-text mishearing — full credit given.",
  missing_minor_words: "Almost perfect — just missing a small word or particle.",
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
};
const PLAYER_MAX_HP = 100;
const ENEMY_MAX_HP = 200;
const PLAYER_PET_EMOJIS = ["🐺", "🦊", "🦅"];
const ENEMY_PET_EMOJIS = ["🐍", "🦂", "🦇"];
const PET_MAX_HP = 20;
const PET_DAMAGE = 5;

type Pet = { id: string; emoji: string; hp: number; maxHp: number };


// ── Tokenizes native sentence text into hint-mapped segments ──
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

// ── Expanded player log entry: 4-section hover layout ──
type PlayerLogEntryExpandedProps = {
  entry: CompletedRound;
  hideLearnText: boolean;
  conversationId: string;
  wrongAttempts?: CompletedRound[];
};

function PlayerLogEntryExpanded({ entry, hideLearnText, conversationId, wrongAttempts }: PlayerLogEntryExpandedProps) {
  const [hoveredHintIdx, setHoveredHintIdx] = useState<number | null>(null);
  const [playingVariant, setPlayingVariant] = useState<number | null>(null);
  const [previewExIdx, setPreviewExIdx] = useState<number | null>(null);
  const [peekText, setPeekText] = useState(false);
  const hintAudioRef = useRef<HTMLAudioElement | null>(null);

  const hints = entry.allHints ?? [];
  const tokens = tokenizeWithHints(entry.textNative, hints);
  const examples = entry.acceptedTranslations ?? [];

  function stopHintAudio() {
    if (hintAudioRef.current) { hintAudioRef.current.pause(); hintAudioRef.current = null; }
    setPlayingVariant(null);
  }

  function playHintAudio(hintIdx: number) {
    const variants = hints[hintIdx].learning.split(" / ").map(v => v.trim()).filter(Boolean);
    stopHintAudio();
    setPlayingVariant(0);
    const audio0 = new Audio(`/battle_audio/${conversationId}/hints/round_${entry.id}_${entry.difficulty}_hint_${hintIdx}_v0.wav`);
    hintAudioRef.current = audio0;
    audio0.onended = () => {
      if (variants.length > 1) {
        setPlayingVariant(1);
        const audio1 = new Audio(`/battle_audio/${conversationId}/hints/round_${entry.id}_${entry.difficulty}_hint_${hintIdx}_v1.wav`);
        hintAudioRef.current = audio1;
        audio1.onended = () => setPlayingVariant(null);
        audio1.play().catch(() => setPlayingVariant(null));
      } else {
        setPlayingVariant(null);
      }
    };
    audio0.play().catch(() => setPlayingVariant(null));
  }

  const hoveredHint = hoveredHintIdx !== null ? hints[hoveredHintIdx] : null;
  const hoveredVariants = hoveredHint ? hoveredHint.learning.split(" / ").map(v => v.trim()).filter(Boolean) : [];

  const isPreview = previewExIdx !== null;
  const displayedText = isPreview ? (examples[previewExIdx!] ?? entry.textLearning ?? "") : (entry.textLearning ?? "");
  const feedbackText = entry.skipped ? "Skipped" : entry.damageDealt ? `+${entry.damageDealt} damage` : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>

      {/* Sections 1+2: hint hover zone — leaving this area stops audio */}
      <div onMouseLeave={() => { setHoveredHintIdx(null); stopHintAudio(); setPeekText(false); }}>

      {/* 1. Native sentence with hoverable hint-matched spans */}
      <div style={{ lineHeight: 1.6, fontSize: 13 }}>
        {tokens.map((tok, ti) => {
          if (tok.hintIndex === null) return (
            <span key={ti} onMouseEnter={() => { setHoveredHintIdx(null); stopHintAudio(); }}>{tok.text}</span>
          );
          const hint = hints[tok.hintIndex];
          const wasUsed = entry.usedHintPairs?.some(u => u.native === hint.native) ?? false;
          const isHov = hoveredHintIdx === tok.hintIndex;
          return (
            <span
              key={ti}
              onMouseEnter={() => { setHoveredHintIdx(tok.hintIndex!); playHintAudio(tok.hintIndex!); }}
              style={{
                borderBottom: `1px ${isHov ? "solid" : "dashed"} ${wasUsed ? "rgba(251,191,36,0.6)" : "rgba(147,197,253,0.45)"}`,
                color: isHov ? (wasUsed ? "#fbbf24" : "#93c5fd") : "inherit",
                cursor: "default",
                transition: "color 0.1s",
                paddingBottom: 1,
              }}
            >
              {tok.text}
            </span>
          );
        })}
      </div>

      {/* 2. Contextual hint display — hover here to reveal text in audio-only mode */}
      <div
        style={{ minHeight: 26, display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 4 }}
        onMouseEnter={() => { if (hideLearnText) setPeekText(true); }}
        onMouseLeave={() => setPeekText(false)}
      >
        {hoveredHint ? (
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, flexWrap: "wrap" }}>
            {hoveredVariants.map((v, vi) => {
              const isPlaying = playingVariant === vi;
              const showText = !hideLearnText || peekText;
              return (
                <span
                  key={vi}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    padding: showText ? "2px 9px" : "2px 10px", borderRadius: 20,
                    border: `1px solid ${isPlaying ? "rgba(251,191,36,0.6)" : "rgba(147,197,253,0.3)"}`,
                    background: isPlaying ? "rgba(251,191,36,0.1)" : "rgba(147,197,253,0.07)",
                    transition: "border-color 0.2s, background 0.2s",
                  }}
                >
                  <span className={isPlaying ? "hint-playing-dot" : undefined} style={{
                    width: 5, height: 5, borderRadius: "50%", display: "inline-block", flexShrink: 0,
                    background: isPlaying ? "#fbbf24" : "rgba(147,197,253,0.4)",
                    transition: "background 0.2s",
                  }} />
                  {showText && (
                    <span style={{
                      color: isPlaying ? "#fbbf24" : "#93c5fd",
                      fontWeight: isPlaying ? 600 : 400,
                      transition: "color 0.2s",
                    }}>
                      {v}
                    </span>
                  )}
                </span>
              );
            })}
            {hoveredHint?.note && (!hideLearnText || peekText) && (
              <span style={{ fontSize: 11, fontStyle: "italic", color: "rgba(255,255,255,0.45)", marginLeft: 2 }}>
                {hoveredHint.note}
              </span>
            )}
          </div>
        ) : <div />}
      </div>
      </div>{/* end hint hover zone */}

      {/* 3. You said — inline diff if correction_tokens, else plain / example preview */}
      {entry.correctionTokens && entry.correctionTokens.length > 0 && !isPreview ? (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 7, paddingBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.06em" }}>You said</div>
            {examples.length > 0 && (
              <div style={{ display: "flex", gap: 4 }}>
                {examples.slice(0, 2).map((_, ei) => (
                  <div
                    key={ei}
                    onMouseEnter={() => setPreviewExIdx(ei)}
                    onMouseLeave={() => setPreviewExIdx(null)}
                    style={{
                      width: 20, height: 20, borderRadius: 4, fontSize: 10, fontWeight: 700,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      cursor: "default", userSelect: "none",
                      background: previewExIdx === ei ? "rgba(147,197,253,0.2)" : "rgba(255,255,255,0.07)",
                      border: `1px solid ${previewExIdx === ei ? "rgba(147,197,253,0.5)" : "rgba(255,255,255,0.15)"}`,
                      color: previewExIdx === ei ? "#93c5fd" : "rgba(255,255,255,0.4)",
                      transition: "all 0.15s",
                    }}
                  >
                    {ei + 1}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.6, wordBreak: "break-word" }}>
            {entry.correctionTokens.map((tok, ti) => {
              if (tok.status === "remove") return (
                <span key={ti} style={{ color: "#fca5a5", textDecoration: "line-through", textDecorationColor: "#fca5a5" }}>{tok.text}</span>
              );
              if (tok.status === "add") return (
                <span key={ti} style={{ color: "#86efac", fontWeight: 500 }}>{tok.text}</span>
              );
              return <span key={ti} style={{ color: "rgba(255,255,255,0.85)" }}>{tok.text}</span>;
            })}
          </div>
        </div>
      ) : (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 7, paddingBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {isPreview ? `Example ${previewExIdx! + 1}` : "You said"}
            </div>
            {examples.length > 0 && (
              <div style={{ display: "flex", gap: 4 }}>
                {examples.slice(0, 2).map((_, ei) => (
                  <div
                    key={ei}
                    onMouseEnter={() => setPreviewExIdx(ei)}
                    onMouseLeave={() => setPreviewExIdx(null)}
                    style={{
                      width: 20, height: 20, borderRadius: 4, fontSize: 10, fontWeight: 700,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      cursor: "default", userSelect: "none",
                      background: previewExIdx === ei ? "rgba(147,197,253,0.2)" : "rgba(255,255,255,0.07)",
                      border: `1px solid ${previewExIdx === ei ? "rgba(147,197,253,0.5)" : "rgba(255,255,255,0.15)"}`,
                      color: previewExIdx === ei ? "#93c5fd" : "rgba(255,255,255,0.4)",
                      transition: "all 0.15s",
                    }}
                  >
                    {ei + 1}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{
            color: isPreview ? "#93c5fd" : (entry.skipped ? "#fbbf24" : "#86efac"),
            fontSize: 13, fontStyle: isPreview ? "italic" : "normal",
            transition: "color 0.15s",
          }}>
            {displayedText}
          </div>
        </div>
      )}

      {/* 4. Feedback */}
      {(feedbackText || entry.feedbackExplanation || entry.feedbackKey) && (() => {
        const tip = entry.feedbackExplanation ?? (entry.feedbackKey ? FEEDBACK_MAP[entry.feedbackKey] : null);
        return (
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 7 }}>
            <div style={{ fontSize: 10, opacity: 0.45, marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.06em" }}>Feedback</div>
            {feedbackText && (
              <div style={{ fontSize: 12, color: entry.skipped ? "#94a3b8" : "#86efac" }}>
                {feedbackText}
              </div>
            )}
            {tip && (
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", lineHeight: 1.4, marginTop: feedbackText ? 4 : 0 }}>
                {tip}
              </div>
            )}
          </div>
        );
      })()}

      {/* 5. Previous wrong attempts */}
      {wrongAttempts && wrongAttempts.length > 0 && (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 7 }}>
          <div style={{ fontSize: 10, opacity: 0.45, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.06em" }}>Previous attempts</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {wrongAttempts.map((wa, wi) => {
              const waTip = wa.feedbackExplanation ?? (wa.feedbackKey ? FEEDBACK_MAP[wa.feedbackKey] : null);
              return (
                <div key={wi} style={{ background: "rgba(239,68,68,0.1)", borderRadius: 6, padding: "5px 8px" }}>
                  {wa.correctionTokens && wa.correctionTokens.length > 0 ? (
                    <div style={{ fontSize: 12, lineHeight: 1.6, wordBreak: "break-word", marginBottom: waTip ? 4 : 0 }}>
                      {wa.correctionTokens.map((tok, ti) => {
                        if (tok.status === "remove") return (
                          <span key={ti} style={{ color: "#fca5a5", textDecoration: "line-through", textDecorationColor: "#fca5a5" }}>{tok.text}</span>
                        );
                        if (tok.status === "add") return (
                          <span key={ti} style={{ color: "#86efac", fontWeight: 500 }}>{tok.text}</span>
                        );
                        return <span key={ti} style={{ color: "rgba(255,255,255,0.7)" }}>{tok.text}</span>;
                      })}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: "#fca5a5", marginBottom: waTip ? 3 : 0 }}>{wa.textLearning}</div>
                  )}
                  {waTip && (
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", lineHeight: 1.4 }}>
                      {waTip}
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
  const [lastCheckResult, setLastCheckResult] = useState<{ multiplier: number; feedbackKey: string | null; correctedSnippet: string | null; feedbackExplanation: string | null } | null>(null);
  const [conversationHistory, setConversationHistory] = useState<CompletedRound[]>([]);
  const [expandedLogEntry, setExpandedLogEntry] = useState<number | null>(null);
  const [pinnedLogEntries, setPinnedLogEntries] = useState<Set<number>>(new Set());
  const [revealingHintIndex, setRevealingHintIndex] = useState<number | null>(null);
  const [showPowerUpBanner, setShowPowerUpBanner] = useState(false);
  const [hideLearnText, setHideLearnText] = useState(false);
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
  const [petsEnabled, setPetsEnabled] = useState(false);
  const [animationsEnabled, setAnimationsEnabled] = useState(true);
  const [playerPets, setPlayerPets] = useState<Pet[]>([]);
  const [enemyPets, setEnemyPets] = useState<Pet[]>([]);
  const [attackingId, setAttackingId] = useState<string | null>(null);
  const [defendEnabled, setDefendEnabled] = useState(true);
  const [showDefendPhase, setShowDefendPhase] = useState(false);
  const [currentDefendQuestion, setCurrentDefendQuestion] = useState<DefendQuestion | null>(null);
  const [defendResult, setDefendResult] = useState<"correct" | "incorrect" | null>(null);
  const [defendAudioDone, setDefendAudioDone] = useState(false);
  const [defendSeenOnce, setDefendSeenOnce] = useState(false);
  const [defendAudioPlayCount, setDefendAudioPlayCount] = useState(0);
  const [defendCounterDealt, setDefendCounterDealt] = useState<number | null>(null);
  const [defendShuffledChoices, setDefendShuffledChoices] = useState<{ text: string; isCorrect: boolean }[]>([]);
  const [defendSelectedIndex, setDefendSelectedIndex] = useState<number | null>(null);
  const [defendCountdownMs, setDefendCountdownMs] = useState<number | null>(null);
  const [defendCountdownPaused, setDefendCountdownPaused] = useState(false);
  const defendCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [peekLogIdx, setPeekLogIdx] = useState<number | null>(null);
  const [pinnedHintKeys, setPinnedHintKeys] = useState<Set<string>>(new Set());
  const [activeBranch, setActiveBranch] = useState<string | null>(null);
  const [variantSelections, setVariantSelections] = useState<Record<string, number>>({});
  const [revealLearnAfterRound, setRevealLearnAfterRound] = useState(false);
  const [selectedConversation, setSelectedConversation] = useState<ConversationData | null>(null);

  // Proximity-based hint color
  const [closestHintIndex, setClosestHintIndex] = useState<number | null>(null);
  const [closestHintOpacity, setClosestHintOpacity] = useState<number>(0);
  const hintCardsRefs = useRef<(HTMLDivElement | null)[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const timerExpiredRef = useRef(false);
  const historyEndRef = useRef<HTMLDivElement | null>(null);
  const expandTimerRef = useRef<number | null>(null);
  const autoSendTimer = useRef<number | null>(null);
  const lastSentRef = useRef<number>(0);
  const previousTranscriptLengthRef = useRef<number>(0);
  const defendResolveRef = useRef<((correct: boolean) => void) | null>(null);
  const playerHealthRef = useRef(PLAYER_MAX_HP);
  const defendAudioRef = useRef<HTMLAudioElement | null>(null);
  const enemyLogAudioRef = useRef<HTMLAudioElement | null>(null);
  const [arenaPlayingHint, setArenaPlayingHint] = useState<{ key: string; variant: number } | null>(null);
  const arenaAudioRef = useRef<HTMLAudioElement | null>(null);

  // Active conversation (set after selection)
  const conversation = selectedConversation;
  const rounds = conversation?.rounds ?? [];

  // Current round helper
  const currentRound = currentRoundIndex < rounds.length ? rounds[currentRoundIndex] : null;

  // Keep playerHealthRef in sync for async defend phase checks
  useEffect(() => { playerHealthRef.current = playerHealth; }, [playerHealth]);

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

  // Defend phase countdown timer
  useEffect(() => {
    if (defendCountdownMs === null || defendCountdownPaused) {
      if (defendCountdownRef.current) { clearInterval(defendCountdownRef.current); defendCountdownRef.current = null; }
      return;
    }
    defendCountdownRef.current = setInterval(() => {
      setDefendCountdownMs(prev => {
        if (prev === null) return null;
        const next = prev - 50;
        if (next <= 0) {
          clearInterval(defendCountdownRef.current!);
          defendCountdownRef.current = null;
          // Play audio
          if (defendAudioRef.current) {
            defendAudioRef.current.addEventListener("ended", () => { setDefendAudioDone(true); setDefendSeenOnce(true); }, { once: true });
            defendAudioRef.current.play().catch(() => { setDefendAudioDone(true); setDefendSeenOnce(true); });
          }
          return null;
        }
        return next;
      });
    }, 50);
    return () => { if (defendCountdownRef.current) { clearInterval(defendCountdownRef.current); defendCountdownRef.current = null; } };
  }, [defendCountdownMs === null, defendCountdownPaused]);

  // Focus textarea when ready for input
  useEffect(() => {
    const ready = (selectedDifficulty || freeformMode) && (!timerEnabled || timerActive) && !busy;
    if (ready && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [selectedDifficulty, freeformMode, timerEnabled, timerActive, busy, answerStatus]);

  // Hotkeys 1/2/3 for defend phase answer selection
  useEffect(() => {
    if (!showDefendPhase || !defendAudioDone || defendResult !== null) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "1") { e.preventDefault(); handleDefendAnswer(0); }
      else if (e.key === "2") { e.preventDefault(); handleDefendAnswer(1); }
      else if (e.key === "3") { e.preventDefault(); handleDefendAnswer(2); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDefendPhase, defendAudioDone, defendResult, defendShuffledChoices]);

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

  // Auto-send logic (Wispr bulk input only — typing requires Enter)
  useEffect(() => {
    if (autoSendTimer.current) {
      window.clearTimeout(autoSendTimer.current);
      autoSendTimer.current = null;
    }

    if (transcript.length >= MIN_AUTO_SEND_LENGTH && timerActive && (selectedDifficulty || freeformMode)) {
      const lengthIncrease = transcript.length - previousTranscriptLengthRef.current;
      const isWisprInput = lengthIncrease >= 10;

      if (isWisprInput) {
        autoSendTimer.current = window.setTimeout(() => {
          const now = Date.now();
          if (now - lastSentRef.current > 700) {
            void submitAnswer();
          }
        }, 100);
      }
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
    setClosestHintOpacity(0);
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
    setActiveBranch(null);
    setVariantSelections({});
    if (petsEnabled) {
      setPlayerPets(PLAYER_PET_EMOJIS.map((emoji, i) => ({ id: `pp${i}`, emoji, hp: PET_MAX_HP, maxHp: PET_MAX_HP })));
      setEnemyPets(ENEMY_PET_EMOJIS.map((emoji, i) => ({ id: `ep${i}`, emoji, hp: PET_MAX_HP, maxHp: PET_MAX_HP })));
    } else {
      setPlayerPets([]);
      setEnemyPets([]);
    }
  }

  function runDefendPhase(question: DefendQuestion): Promise<boolean> {
    return new Promise(resolve => {
      setCurrentDefendQuestion(question);
      setShowDefendPhase(true);
      setDefendResult(null);
      setDefendAudioDone(false);
      setDefendSeenOnce(false);
      setDefendAudioPlayCount(1);
      setDefendCounterDealt(null);
      setDefendSelectedIndex(null);
      // Shuffle choices, preserving which one is correct
      const shuffled = question.choices
        .map((text, i) => ({ text, isCorrect: i === question.correct_index }))
        .sort(() => Math.random() - 0.5);
      setDefendShuffledChoices(shuffled);
      const audio = new Audio(question.audio_url);
      defendAudioRef.current = audio;
      // Don't play yet — countdown will trigger playback
      setDefendCountdownMs(3000);
      setDefendCountdownPaused(false);
      defendResolveRef.current = resolve;
    });
  }

  function handleDefendAnswer(choiceIndex: number) {
    if (!currentDefendQuestion || defendResult !== null) return;
    const correct = defendShuffledChoices[choiceIndex]?.isCorrect ?? false;
    setDefendSelectedIndex(choiceIndex);
    setDefendResult(correct ? "correct" : "incorrect");

    if (!correct) {
      const newHp = Math.max(0, playerHealthRef.current - ENEMY_DAMAGE);
      playerHealthRef.current = newHp;
      setPlayerHealth(newHp);
      setDamageFlash("player");
      setLastPlayerDamage(ENEMY_DAMAGE);
      setTimeout(() => { setDamageFlash(null); setLastPlayerDamage(null); }, 900);
    } else if (defendAudioPlayCount === 1) {
      // First-listen bonus: counter-attack the enemy
      setDefendCounterDealt(DEFEND_COUNTER_DAMAGE);
      setEnemyHealth(prev => Math.max(0, prev - DEFEND_COUNTER_DAMAGE));
      setDamageFlash("enemy");
      setLastDamage(DEFEND_COUNTER_DAMAGE);
      setTimeout(() => { setDamageFlash(null); setLastDamage(null); }, 900);
    }

    setTimeout(() => {
      setShowDefendPhase(false);
      setCurrentDefendQuestion(null);
      defendAudioRef.current = null;
      const resolve = defendResolveRef.current;
      defendResolveRef.current = null;
      resolve?.(correct);
    }, 1600);
  }

  function handleDefendSkip() {
    if (!currentDefendQuestion || defendResult !== null) return;
    setDefendCountdownMs(null);
    if (defendAudioRef.current) { defendAudioRef.current.pause(); }
    setDefendResult("incorrect");
    const newHp = Math.max(0, playerHealthRef.current - ENEMY_DAMAGE);
    playerHealthRef.current = newHp;
    setPlayerHealth(newHp);
    setDamageFlash("player");
    setLastPlayerDamage(ENEMY_DAMAGE);
    setTimeout(() => { setDamageFlash(null); setLastPlayerDamage(null); }, 900);
    setTimeout(() => {
      setShowDefendPhase(false);
      setCurrentDefendQuestion(null);
      defendAudioRef.current = null;
      const resolve = defendResolveRef.current;
      defendResolveRef.current = null;
      resolve?.(false);
    }, 1600);
  }

  function resolveEnemyRound(enemy: EnemyRound): EnemyVariant {
    if (enemy.variants && enemy.variants.length > 0) {
      const key = String(enemy.id);
      const idx = variantSelections[key] ?? 0;
      return enemy.variants[idx];
    }
    return {
      enemy_line_native: enemy.enemy_line_native!,
      enemy_line_learning: enemy.enemy_line_learning!,
      defend_question: enemy.defend_question,
    };
  }

  async function processEnemyTurn() {
    if (!currentRound || currentRound.speaker !== "enemy") return;
    const enemy = currentRound as EnemyRound;

    // Randomly select variant once, before anything is shown
    let resolvedVariantIdx = 0;
    if (enemy.variants && enemy.variants.length > 0) {
      const key = String(enemy.id);
      if (variantSelections[key] === undefined) {
        resolvedVariantIdx = Math.floor(Math.random() * enemy.variants.length);
        setVariantSelections(prev => ({ ...prev, [key]: resolvedVariantIdx }));
      } else {
        resolvedVariantIdx = variantSelections[key];
      }
    }

    setShowEnemyTurn(true);
    await delay(1500);
    setShowEnemyTurn(false);

    const resolved = resolveEnemyRound(enemy);

    // Defend phase: test listening comprehension before revealing the text in the log
    if (defendEnabled && resolved.defend_question) {
      const wasCorrect = await runDefendPhase(resolved.defend_question);
      if (!wasCorrect && playerHealthRef.current <= 0) {
        setGamePhase("defeat");
        return;
      }
    }

    // Add to battle log only after defend phase (so the translation can't be read as a cheat)
    setConversationHistory(prev => [...prev, {
      id: enemy.id,
      speaker: "enemy",
      textNative: resolved.enemy_line_native,
      textLearning: resolved.enemy_line_learning,
    }]);

    advanceRound();
  }

  function advanceRound(branchOverride?: string) {
    const branch = branchOverride ?? activeBranch;
    let nextIdx = currentRoundIndex + 1;
    // Skip rounds that belong to a different branch
    while (nextIdx < rounds.length) {
      const r = rounds[nextIdx] as any;
      if (r.branch && r.branch !== branch) nextIdx++;
      else break;
    }
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
    setRevealLearnAfterRound(false);
    setPinnedHintKeys(new Set());
    setLastCheckResult(null);
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
      let lastRejectedData: Record<string, unknown> | null = null;
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
              accepted_translations: opts.accepted_translations,
              prompt_text: opts.native,
              learning: CONV_LANGUAGE[conversation?.conversation_id ?? ""] ?? initialLearning,
              fluent: initialFluent,
            }),
          });

          if (!response.ok) continue;
          const data = await response.json();
          if (data.token_usage?.cost_cents) setTotalCostCents(prev => prev + data.token_usage.cost_cents);

          if (data.accepted) {
            setSelectedDifficulty(diff);
            await handleCorrectAnswer(opts, diff, data.damage_multiplier ?? 1.0, data.feedback_key ?? null, data.corrected_snippet ?? null, data.feedback_explanation ?? null, !data.fast_path, data.correction_tokens ?? null);
            setBusy(false);
            return;
          }
          lastRejectedData = data;
        } catch (e) {
          console.error(e);
        }
      }

      // No match in any difficulty — log wrong attempt and show feedback
      setConversationHistory(prev => [...prev, {
        id: pr.id,
        speaker: "player",
        textNative: pr.options.easy.native,
        textLearning: userAnswer,
        isWrongAttempt: true,
        feedbackKey: (lastRejectedData?.feedback_key as string | null) ?? null,
        correctedSnippet: (lastRejectedData?.corrected_snippet as string | null) ?? null,
        feedbackExplanation: (lastRejectedData?.feedback_explanation as string | null) ?? null,
        correctionTokens: (lastRejectedData?.correction_tokens as Array<{ text: string; status: "ok" | "remove" | "add" }> | null) ?? null,
        qualityScore: 0,
      }]);
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
          accepted_translations: opts.accepted_translations,
          prompt_text: opts.native,
          learning: CONV_LANGUAGE[conversation?.conversation_id ?? ""] ?? initialLearning,
          fluent: initialFluent,
        }),
      });

      if (!response.ok) throw new Error("Check failed");
      const data = await response.json();
      if (data.token_usage?.cost_cents) setTotalCostCents(prev => prev + data.token_usage.cost_cents);

      if (data.accepted) {
        await handleCorrectAnswer(opts, undefined, data.damage_multiplier ?? 1.0, data.feedback_key ?? null, data.corrected_snippet ?? null, data.feedback_explanation ?? null, !data.fast_path, data.correction_tokens ?? null);
      } else {
        setLastCheckResult({ multiplier: 0, feedbackKey: data.feedback_key ?? null, correctedSnippet: data.corrected_snippet ?? null, feedbackExplanation: data.feedback_explanation ?? null });
        setConversationHistory(prev => [...prev, {
          id: pr.id,
          speaker: "player",
          textNative: opts.native,
          textLearning: userAnswer,
          isWrongAttempt: true,
          feedbackKey: data.feedback_key ?? null,
          correctedSnippet: data.corrected_snippet ?? null,
          feedbackExplanation: data.feedback_explanation ?? null,
          correctionTokens: data.correction_tokens ?? null,
          qualityScore: 0,
        }]);
        handleIncorrectAnswer("Try again!");
      }
    } catch (e) {
      console.error(e);
      handleIncorrectAnswer("Check failed. Try again!");
    } finally {
      setBusy(false);
    }
  }

  async function handleCorrectAnswer(
    opts: DifficultyOption,
    diffOverride?: Difficulty,
    damageMultiplier = 1.0,
    feedbackKey: string | null = null,
    correctedSnippet: string | null = null,
    feedbackExplanation: string | null = null,
    llmCalled = false,
    correctionTokens: Array<{ text: string; status: "ok" | "remove" | "add" }> | null = null,
  ) {
    const diff = diffOverride ?? selectedDifficulty;
    if (!diff) return;
    const rawDamage = calculateDamage(diff, viewedHints.size);
    const damage = Math.max(1, Math.round(rawDamage * damageMultiplier));

    setLastCheckResult({ multiplier: damageMultiplier, feedbackKey, correctedSnippet, feedbackExplanation });
    setAnswerStatus("correct");
    const label = damageMultiplier >= 1.0 ? "Perfect!" : "Close enough!";
    setFeedbackMessage(`${label} ${damage} damage!`);
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
      llmCalled,
      feedbackKey,
      correctedSnippet,
      feedbackExplanation,
      correctionTokens,
      qualityScore: Math.round(damageMultiplier * 100),
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
    setRevealLearnAfterRound(true);
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

    // If this was a branch point, set the active branch before advancing
    const pr = currentRound as PlayerRound;
    const newBranch = pr.branch_point ? (opts.leads_to_branch ?? activeBranch) : activeBranch;
    if (newBranch !== activeBranch) setActiveBranch(newBranch);
    advanceRound(newBranch ?? undefined);
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
    setRevealLearnAfterRound(true);
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
    // Mirror branch logic from the normal answer path so branch-point skips don't skip the enemy round
    const newBranch = pr.branch_point ? (opts.leads_to_branch ?? activeBranch) : activeBranch;
    if (newBranch !== activeBranch) setActiveBranch(newBranch);
    advanceRound(newBranch ?? undefined);
  }

  function handleHintView(index: number) {
    setViewedHints(prev => new Set([...prev, index]));
  }

  function stopAllAudio() {
    if (defendAudioRef.current) { defendAudioRef.current.pause(); defendAudioRef.current = null; }
    if (arenaAudioRef.current) { arenaAudioRef.current.pause(); arenaAudioRef.current = null; }
    if (enemyLogAudioRef.current) { enemyLogAudioRef.current.pause(); enemyLogAudioRef.current = null; }
    setArenaPlayingHint(null);
  }

  function playArenaHint(key: string, roundId: number, diff: string, hintLocalIdx: number, variants: string[]) {
    if (arenaAudioRef.current) { arenaAudioRef.current.pause(); arenaAudioRef.current = null; }
    setArenaPlayingHint({ key, variant: 0 });
    const audio0 = new Audio(`/battle_audio/${conversation!.conversation_id}/hints/round_${roundId}_${diff}_hint_${hintLocalIdx}_v0.wav`);
    arenaAudioRef.current = audio0;
    audio0.onended = () => {
      if (variants.length > 1) {
        setArenaPlayingHint({ key, variant: 1 });
        const audio1 = new Audio(`/battle_audio/${conversation!.conversation_id}/hints/round_${roundId}_${diff}_hint_${hintLocalIdx}_v1.wav`);
        arenaAudioRef.current = audio1;
        audio1.onended = () => setArenaPlayingHint(null);
        audio1.play().catch(() => setArenaPlayingHint(null));
      } else {
        setArenaPlayingHint(null);
      }
    };
    audio0.play().catch(() => setArenaPlayingHint(null));
  }

  // Proximity-based scaling for hints
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
    setClosestHintOpacity(closest !== null ? distanceToOpacity(minDist) : 0);
  };

  const handleHintsMouseLeave = () => {
    setClosestHintIndex(null);
    setClosestHintOpacity(0);
    if (arenaAudioRef.current) { arenaAudioRef.current.pause(); arenaAudioRef.current = null; }
    setArenaPlayingHint(null);
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
              checked={defendEnabled}
              onChange={e => setDefendEnabled(e.target.checked)}
              style={{ width: 18, height: 18, cursor: "pointer" }}
            />
            Defend phase 🛡️ — listen &amp; answer to block damage (The New Neighbor only)
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
          <label style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            gap: 8, marginBottom: 20, fontSize: 16, color: "#374151",
            cursor: "pointer", userSelect: "none",
          }}>
            <input
              type="checkbox"
              checked={hideLearnText}
              onChange={e => setHideLearnText(e.target.checked)}
              style={{ width: 18, height: 18, cursor: "pointer" }}
            />
            🔇 Audio only — hide hint translations (listen, don't read)
          </label>

          {/* Back button */}
          {onBack && (
            <button onClick={() => { stopAllAudio(); onBack(); }} style={{
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
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.7); }
        }
        .hint-playing-dot { animation: pulse 0.6s ease-in-out infinite; }
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
              <button onClick={() => { stopAllAudio(); onBack(); }} style={{
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
            <button
              onClick={() => setHideLearnText(h => !h)}
              title={hideLearnText ? "Show hint translations" : "Audio only — hide hint translations"}
              style={{
                padding: "4px 10px", fontSize: 12, fontWeight: 600, borderRadius: 6,
                cursor: "pointer", border: "1px solid",
                background: hideLearnText ? "rgba(251,191,36,0.2)" : "rgba(255,255,255,0.08)",
                borderColor: hideLearnText ? "rgba(251,191,36,0.5)" : "rgba(255,255,255,0.2)",
                color: hideLearnText ? "#fbbf24" : "rgba(255,255,255,0.6)",
                transition: "all 0.15s",
              }}
            >
              {hideLearnText ? "🔇 Audio only" : "👁 Show text"}
            </button>
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
              {!showDefendPhase && playerRound && !showEnemyTurn && (
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
                            <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2, alignItems: "stretch" }}>
                              {hints.map((hint, i) => {
                                const globalIdx = startIdx + i;
                                const isRevealed = viewedHints.has(globalIdx);
                                const isClosest = closestHintIndex === globalIdx;
                                const fProximityBorder = isClosest && !isRevealed
                                  ? `1px solid rgba(0, 212, 255, ${Math.max(0.3, closestHintOpacity)})` : undefined;
                                const fProximityBg = isClosest && !isRevealed
                                  ? `rgba(0, 212, 255, ${0.15 * closestHintOpacity})` : undefined;
                                const learningParts = hint.learning.split("/").map(p => p.trim()).filter(Boolean);
                                const hintKey = `free_${globalIdx}`;
                                const playingVariant = arenaPlayingHint?.key === hintKey ? arenaPlayingHint.variant : null;
                                return (
                                  <div
                                    key={globalIdx}
                                    ref={el => { hintCardsRefs.current[globalIdx] = el; }}
                                    style={{
                                      flexShrink: 0, position: "relative", display: "flex", flexDirection: "column",
                                      padding: "6px 10px 5px",
                                      border: isRevealed ? "1px solid rgba(255,255,255,0.2)"
                                        : fProximityBorder || `1px solid ${diffColors[diff]}80`,
                                      borderRadius: 6,
                                      background: isRevealed ? "rgba(255,255,255,0.08)" : (fProximityBg || "rgba(0,0,0,0.15)"),
                                      cursor: "default", transition: "all 0.3s ease",
                                    }}
                                  >
                                    <div style={{
                                      fontWeight: 600, fontSize: 11, marginBottom: 5,
                                      color: isRevealed ? "#9ca3af" : "white",
                                      transition: "color 0.15s ease-out",
                                    }}>
                                      {hint.native}
                                    </div>
                                    {/* Middle zone: Aa reveal button OR target-language text */}
                                    {!isRevealed && !revealLearnAfterRound ? (
                                      <button
                                        onMouseEnter={e => { e.stopPropagation(); handleHintView(globalIdx); }}
                                        style={{
                                          width: "100%", padding: "4px 6px", fontSize: 10, borderRadius: 5,
                                          cursor: "pointer", textAlign: "center", fontWeight: 600,
                                          background: "rgba(147,197,253,0.08)",
                                          border: "1px dashed rgba(147,197,253,0.3)",
                                          color: "rgba(147,197,253,0.5)",
                                          transition: "all 0.15s",
                                          marginBottom: 5, flex: 1,
                                        }}
                                      >
                                        Aa
                                      </button>
                                    ) : (
                                      <div style={{ marginBottom: 5, flex: 1 }}>
                                        {learningParts.length > 1
                                          ? <ol style={{ margin: 0, padding: "0 0 0 14px", color: "#93c5fd", fontSize: 10, fontWeight: 500 }}>
                                              {learningParts.map((p, pi) => <li key={pi}>{p}</li>)}
                                            </ol>
                                          : <div style={{ color: "#93c5fd", fontSize: 10, fontWeight: 500 }}>{hint.learning}</div>
                                        }
                                        {hint.note && (
                                          <div style={{ fontSize: 9, fontStyle: "italic", color: "rgba(255,255,255,0.45)", marginTop: 3 }}>
                                            {hint.note}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                    {/* Bottom: audio button always present */}
                                    {!revealLearnAfterRound && (
                                      <button
                                        onMouseEnter={e => { e.stopPropagation(); playArenaHint(hintKey, currentRound!.id, diff, i, learningParts); }}
                                        style={{
                                          width: "100%", padding: "4px 6px", fontSize: 11, borderRadius: 5,
                                          cursor: "pointer", textAlign: "center",
                                          background: playingVariant !== null ? "rgba(251,191,36,0.2)" : "rgba(255,255,255,0.07)",
                                          border: `1px solid ${playingVariant !== null ? "rgba(251,191,36,0.5)" : "rgba(255,255,255,0.15)"}`,
                                          color: playingVariant !== null ? "#fbbf24" : "rgba(255,255,255,0.55)",
                                          transition: "all 0.15s",
                                          display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                                        }}
                                      >
                                        🔊
                                        {learningParts.length > 1 && playingVariant !== null && (
                                          <div style={{ display: "flex", gap: 3 }}>
                                            {learningParts.map((_, pi) => (
                                              <span key={pi} className={playingVariant === pi ? "hint-playing-dot" : undefined} style={{
                                                width: 3, height: 3, borderRadius: "50%", display: "inline-block",
                                                background: playingVariant === pi ? "#fbbf24" : "rgba(255,255,255,0.3)",
                                                transition: "background 0.2s",
                                              }} />
                                            ))}
                                          </div>
                                        )}
                                      </button>
                                    )}
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
                      <button onClick={() => { stopAllAudio(); onBack(); }} style={{
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

            {/* Defend Phase panel */}
            {showDefendPhase && currentDefendQuestion && (() => {
              const q = currentDefendQuestion;
              return (
                <div style={{
                  flex: 1, display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center",
                  padding: "0 24px", gap: 18, textAlign: "center",
                }}>
                  {/* Header */}
                  {(!defendSeenOnce && defendCountdownMs === null) ? (
                    /* Audio is playing: show listening icon instead of shield/defend text */
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                      <div style={{
                        fontSize: 72,
                        animation: "pulse 1.2s ease-in-out infinite",
                        filter: "drop-shadow(0 0 12px rgba(251,191,36,0.6))",
                      }}>🎧</div>
                      <style>{`@keyframes pulse { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.08);opacity:0.8} }`}</style>
                    </div>
                  ) : (
                    defendCountdownMs !== null && (
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                        <div style={{ fontSize: 20, fontWeight: 700, color: "#fbbf24" }}>Defend!</div>
                        <div style={{ fontSize: 13, opacity: 0.6 }}>
                          {defendCountdownPaused ? "Paused" : `Listen to what ${conversation!.enemy_name} says...`}
                        </div>
                      </div>
                    )
                  )}

                  {/* Countdown ring */}
                  {defendCountdownMs !== null && (() => {
                    const TOTAL = 3000;
                    const R = 24;
                    const CIRC = 2 * Math.PI * R;
                    const progress = defendCountdownMs / TOTAL; // 1→0
                    const offset = CIRC * (1 - progress);
                    return (
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                        <div
                          onClick={() => {
                            setDefendCountdownMs(null);
                            if (defendAudioRef.current) {
                              defendAudioRef.current.addEventListener("ended", () => { setDefendAudioDone(true); setDefendSeenOnce(true); }, { once: true });
                              defendAudioRef.current.play().catch(() => { setDefendAudioDone(true); setDefendSeenOnce(true); });
                            }
                          }}
                          style={{ position: "relative", width: 64, height: 64, cursor: "pointer" }}
                        >
                          <svg width={64} height={64} style={{ transform: "rotate(-90deg)" }}>
                            <circle cx={32} cy={32} r={R} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={5} />
                            <circle
                              cx={32} cy={32} r={R} fill="none"
                              stroke={defendCountdownPaused ? "rgba(251,191,36,0.5)" : "#fbbf24"}
                              strokeWidth={5}
                              strokeDasharray={CIRC}
                              strokeDashoffset={offset}
                              strokeLinecap="round"
                              style={{ transition: "stroke-dashoffset 0.05s linear, stroke 0.2s" }}
                            />
                          </svg>
                          <div style={{
                            position: "absolute", inset: 0,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.7)",
                          }}>
                            Start
                          </div>
                        </div>
                        <div style={{ fontSize: 11, opacity: 0.45, letterSpacing: "0.05em" }}>
                          {defendCountdownPaused ? "hover back to resume" : "hover battle log to pause"}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Skip button — only during initial audio playback (not during countdown) */}
                  {!defendSeenOnce && defendCountdownMs === null && (
                    <button
                      onClick={() => {
                        setDefendCountdownMs(null);
                        if (defendAudioRef.current) { defendAudioRef.current.pause(); }
                        setDefendAudioDone(true);
                        setDefendSeenOnce(true);
                      }}
                      style={{
                        padding: "5px 14px", fontSize: 12, fontWeight: 500,
                        background: "transparent", color: "rgba(255,255,255,0.4)",
                        border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6,
                        cursor: "pointer",
                      }}
                    >
                      Skip →
                    </button>
                  )}

                  {/* Hover-to-replay audio button — only after first listen */}
                  {defendSeenOnce && <div
                    onMouseEnter={() => {
                      setDefendAudioPlayCount(prev => prev + 1);
                      setDefendAudioDone(false);
                      if (defendAudioRef.current) {
                        defendAudioRef.current.currentTime = 0;
                        defendAudioRef.current.addEventListener("ended", () => setDefendAudioDone(true), { once: true });
                        defendAudioRef.current.play().catch(() => setDefendAudioDone(true));
                      } else {
                        const audio = new Audio(q.audio_url);
                        defendAudioRef.current = audio;
                        audio.addEventListener("ended", () => setDefendAudioDone(true), { once: true });
                        audio.play().catch(() => setDefendAudioDone(true));
                      }
                    }}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "8px 20px", fontSize: 14, fontWeight: 600,
                      background: "rgba(251,191,36,0.15)", color: "#fbbf24",
                      border: "1px solid rgba(251,191,36,0.4)", borderRadius: 8, cursor: "default",
                      userSelect: "none",
                    }}
                  >
                    🔊 Hover to replay
                  </div>}

                  {/* Question and choices — shown after first listen; stays visible during replays */}
                  {(defendAudioDone || defendSeenOnce) && <>
                  {/* Question */}
                  <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.4, maxWidth: 380 }}>
                    {q.question}
                  </div>

                  {/* Choices */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 340 }}>
                    {defendShuffledChoices.map((choice, ci) => {
                      const isSelected = ci === defendSelectedIndex;
                      const isWrongSelection = isSelected && !choice.isCorrect;
                      const answered = defendResult !== null;
                      const bg = answered
                        ? choice.isCorrect
                          ? "rgba(34,197,94,0.25)"
                          : isWrongSelection
                            ? "rgba(239,68,68,0.25)"
                            : "rgba(255,255,255,0.05)"
                        : "rgba(255,255,255,0.08)";
                      const border = answered
                        ? choice.isCorrect
                          ? "#22c55e"
                          : isWrongSelection
                            ? "#ef4444"
                            : "rgba(255,255,255,0.15)"
                        : "rgba(255,255,255,0.2)";
                      return (
                        <button
                          key={ci}
                          onClick={answered ? undefined : () => handleDefendAnswer(ci)}
                          style={{
                            width: "100%", padding: "12px 16px", fontSize: 15, fontWeight: 500,
                            background: bg, color: "white",
                            border: `2px solid ${border}`, borderRadius: 10,
                            cursor: answered ? "default" : "pointer",
                            textAlign: "left", transition: "background 0.15s, border-color 0.15s",
                            boxSizing: "border-box",
                          }}
                          onMouseEnter={e => {
                            if (answered) return;
                            e.currentTarget.style.background = "rgba(255,255,255,0.16)";
                            e.currentTarget.style.borderColor = "rgba(255,255,255,0.4)";
                          }}
                          onMouseLeave={e => {
                            if (answered) return;
                            e.currentTarget.style.background = "rgba(255,255,255,0.08)";
                            e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)";
                          }}
                        >
                          {ci + 1}. {choice.text}
                        </button>
                      );
                    })}
                    {/* Skip button before answer / result message after — same space to prevent layout shift */}
                    {defendResult === null ? (
                      <button
                        onClick={handleDefendSkip}
                        style={{
                          width: "100%", padding: "8px 16px", fontSize: 13, fontWeight: 500,
                          background: "transparent", color: "rgba(255,255,255,0.35)",
                          border: "1px solid rgba(255,255,255,0.15)", borderRadius: 10,
                          cursor: "pointer", marginTop: 4, transition: "color 0.15s, border-color 0.15s",
                          boxSizing: "border-box",
                        }}
                        onMouseEnter={e => {
                          e.currentTarget.style.color = "rgba(255,255,255,0.6)";
                          e.currentTarget.style.borderColor = "rgba(255,255,255,0.3)";
                        }}
                        onMouseLeave={e => {
                          e.currentTarget.style.color = "rgba(255,255,255,0.35)";
                          e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)";
                        }}
                      >
                        Skip (take damage)
                      </button>
                    ) : (
                      <div style={{
                        width: "100%", padding: "8px 16px", fontSize: 13, fontWeight: 600,
                        borderRadius: 10, marginTop: 4, textAlign: "center", boxSizing: "border-box",
                        color: defendResult === "correct" ? "#86efac" : "#fca5a5",
                      }}>
                        {defendResult === "correct"
                          ? defendCounterDealt
                            ? `✓ Blocked! Counter-attacked for ${defendCounterDealt} damage ⚡`
                            : "✓ Blocked! No damage taken."
                          : `✗ Wrong. ${conversation!.enemy_name} deals ${ENEMY_DAMAGE} damage!`}
                      </div>
                    )}
                  </div>
                  </>}
                </div>
              );
            })()}

            {/* Unified content zone — shown during enemy turn AND player turn */}
            {!showDefendPhase && !freeformMode && (showEnemyTurn || playerRound) && (() => {
              // Enemy text source: currentRound during animation, history once added
              const lastHistory = conversationHistory.length > 0 ? conversationHistory[conversationHistory.length - 1] : null;
              const enemyText = showEnemyTurn && currentRound?.speaker === "enemy"
                ? (defendEnabled ? null : resolveEnemyRound(currentRound as EnemyRound).enemy_line_native)
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
                            <div style={{ display: "flex", gap: 10, overflowX: "auto", padding: "4px 0", justifyContent: "center", width: "100%", alignItems: "stretch" }}>
                              {currentOptions.hints.map((hint, index) => {
                                const isRevealed = viewedHints.has(index);
                                const isRevealing = revealingHintIndex === index;
                                const isClosest = closestHintIndex === index;
                                const proximityBorder = isClosest && !isRevealed
                                  ? `2px solid rgba(0, 212, 255, ${Math.max(0.3, closestHintOpacity)})` : undefined;
                                const proximityBg = isClosest && !isRevealed
                                  ? `rgba(0, 212, 255, ${0.15 * closestHintOpacity})` : undefined;
                                const learningParts = hint.learning.split("/").map(p => p.trim()).filter(Boolean);
                                const hintKey = `sel_${index}`;
                                const playingVariant = arenaPlayingHint?.key === hintKey ? arenaPlayingHint.variant : null;
                                return (
                                  <div
                                    key={index}
                                    ref={el => { hintCardsRefs.current[index] = el; }}
                                    className={isRevealing ? "hint-revealing" : undefined}
                                    style={{
                                      flexShrink: 0, width: 130, position: "relative", display: "flex", flexDirection: "column",
                                      border: isRevealing
                                        ? "2px solid #FFD700"
                                        : isRevealed ? "2px solid rgba(255,255,255,0.3)" : proximityBorder || "2px solid #FFD700",
                                      borderRadius: 8, padding: "8px 12px 6px",
                                      background: isRevealed ? "rgba(255,255,255,0.1)" : (proximityBg || "rgba(255,215,0,0.1)"),
                                      cursor: "default", transition: "all 0.3s ease",
                                      boxShadow: isRevealing
                                        ? "0 0 20px rgba(255,215,0,0.75), 0 0 40px rgba(255,215,0,0.3)"
                                        : isRevealed ? "none" : "0 2px 8px rgba(255,215,0,0.2)",
                                    }}
                                  >
                                    <div style={{
                                      fontWeight: 600, marginBottom: 6, fontSize: 14,
                                      color: isRevealed ? "#9ca3af" : "white",
                                      transition: "color 0.15s ease-out",
                                    }}>
                                      {hint.native}
                                    </div>
                                    {/* Middle zone: Aa reveal button OR target-language text */}
                                    {!isRevealed && !revealLearnAfterRound ? (
                                      <button
                                        onMouseEnter={e => { e.stopPropagation(); handleHintView(index); }}
                                        style={{
                                          width: "100%", padding: "6px 8px", fontSize: 12, borderRadius: 6,
                                          cursor: "pointer", textAlign: "center", fontWeight: 600,
                                          background: "rgba(147,197,253,0.08)",
                                          border: "1px dashed rgba(147,197,253,0.3)",
                                          color: "rgba(147,197,253,0.5)",
                                          transition: "all 0.15s",
                                          marginBottom: 6, flex: 1, minHeight: 44,
                                        }}
                                      >
                                        Aa
                                      </button>
                                    ) : (
                                      <div style={{ marginBottom: 6, flex: 1, minHeight: 44 }}>
                                        {learningParts.length > 1
                                          ? <ol style={{ margin: 0, padding: "0 0 0 16px", color: "#93c5fd", fontSize: 12, fontWeight: 500 }}>
                                              {learningParts.map((p, pi) => <li key={pi}>{p}</li>)}
                                            </ol>
                                          : <div style={{ color: "#93c5fd", fontSize: 12, fontWeight: 500 }}>{hint.learning}</div>
                                        }
                                        {hint.note && (
                                          <div style={{ fontSize: 10, fontStyle: "italic", color: "rgba(255,255,255,0.45)", marginTop: 4 }}>
                                            {hint.note}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                    {/* Bottom: audio button always present */}
                                    {!revealLearnAfterRound && (
                                      <button
                                        onMouseEnter={e => { e.stopPropagation(); playArenaHint(hintKey, currentRound!.id, selectedDifficulty!, index, learningParts); }}
                                        style={{
                                          width: "100%", padding: "5px 8px", fontSize: 13, borderRadius: 6,
                                          cursor: "pointer", textAlign: "center",
                                          background: playingVariant !== null ? "rgba(251,191,36,0.2)" : "rgba(255,255,255,0.07)",
                                          border: `1px solid ${playingVariant !== null ? "rgba(251,191,36,0.5)" : "rgba(255,255,255,0.15)"}`,
                                          color: playingVariant !== null ? "#fbbf24" : "rgba(255,255,255,0.55)",
                                          transition: "all 0.15s",
                                          display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                                        }}
                                      >
                                        🔊
                                        {learningParts.length > 1 && playingVariant !== null && (
                                          <div style={{ display: "flex", gap: 3 }}>
                                            {learningParts.map((_, pi) => (
                                              <span key={pi} className={playingVariant === pi ? "hint-playing-dot" : undefined} style={{
                                                width: 4, height: 4, borderRadius: "50%", display: "inline-block",
                                                background: playingVariant === pi ? "#fbbf24" : "rgba(255,255,255,0.3)",
                                                transition: "background 0.2s",
                                              }} />
                                            ))}
                                          </div>
                                        )}
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
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
            {!showDefendPhase && playerRound && !showEnemyTurn && (freeformMode || selectedDifficulty) && (
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
                {(answerStatus === "correct" || answerStatus === "incorrect" || answerStatus === "skipped" || feedbackMessage) && (() => {
                  const m = lastCheckResult?.multiplier ?? 1.0;
                  const mainColor = answerStatus === "correct"
                    ? (m >= 1.0 ? "#86efac" : m >= 0.7 ? "#fbbf24" : "#f97316")
                    : answerStatus === "incorrect" ? "#fca5a5"
                    : "#94a3b8";
                  const tip = lastCheckResult?.feedbackExplanation
                    ?? (lastCheckResult?.feedbackKey ? FEEDBACK_MAP[lastCheckResult.feedbackKey] : null);
                  const snippet = lastCheckResult?.correctedSnippet;
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        {answerStatus === "correct" && <span style={{ fontSize: 20, color: mainColor }}>&#10003;</span>}
                        {answerStatus === "incorrect" && <span style={{ fontSize: 20, color: mainColor }}>&#10007;</span>}
                        {answerStatus === "skipped" && <span style={{ fontSize: 16, opacity: 0.6 }}>→</span>}
                        {feedbackMessage && (
                          <span style={{ fontSize: 14, fontWeight: 600, color: mainColor }}>
                            {feedbackMessage}
                          </span>
                        )}
                      </div>
                      {tip && (
                        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", lineHeight: 1.4 }}>
                          {tip}{snippet ? <span style={{ color: mainColor, fontWeight: 500 }}> Try: {snippet}</span> : null}
                        </div>
                      )}
                    </div>
                  );
                })()}
                {/* Textarea + buttons */}
                <textarea
                  ref={textareaRef}
                  value={transcript}
                  onChange={e => setTranscript(e.target.value)}
                  onMouseEnter={() => textareaRef.current?.focus()}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitAnswer(); } }}
                  placeholder={freeformMode
                    ? `Translate any sentence in ${initialLearning.name}...`
                    : `Hold CTRL + Win and wait for beep to speak or type your translation in ${initialLearning.name}...`}
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
          <div
            onMouseEnter={() => { if (defendCountdownMs !== null) setDefendCountdownPaused(true); }}
            onMouseLeave={() => { if (defendCountdownMs !== null) setDefendCountdownPaused(false); }}
            style={{
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
              style={{ flex: 1, overflowY: "auto", padding: "12px 16px 80px", display: "flex", flexDirection: "column", gap: 8 }}
            >
              {(() => {
                // Build lookup: wrongAttempts by round id, and which round ids are resolved (correct/skipped)
                const wrongAttemptsByRound = new Map<number, CompletedRound[]>();
                const resolvedRoundIds = new Set<number>();
                for (const e of conversationHistory) {
                  if (e.speaker === "player") {
                    if (e.isWrongAttempt) {
                      if (!wrongAttemptsByRound.has(e.id)) wrongAttemptsByRound.set(e.id, []);
                      wrongAttemptsByRound.get(e.id)!.push(e);
                    } else {
                      resolvedRoundIds.add(e.id);
                    }
                  }
                }
                return conversationHistory.map((entry, i) => {
                // Hide wrong attempts that have been folded into a correct/skipped entry
                if (entry.isWrongAttempt && resolvedRoundIds.has(entry.id)) return null;

                const isPlayer = entry.speaker === "player";
                const isPinned = pinnedLogEntries.has(i);
                const isExpanded = expandedLogEntry === i || isPinned;
                return (
                  <div
                    key={i}
                    style={{ display: "flex", justifyContent: isPlayer ? "flex-start" : "flex-end" }}
                  >
                    <div
                      style={{
                        maxWidth: isExpanded ? "85%" : "60%",
                        width: isExpanded ? "85%" : "fit-content",
                        padding: "8px 12px", borderRadius: 12,
                        background: entry.isWrongAttempt ? "rgba(239,68,68,0.15)" : isPlayer ? "rgba(59,130,246,0.25)" : "rgba(239,68,68,0.25)",
                        border: isPinned ? "1px solid rgba(59,130,246,0.6)" : "1px solid transparent",
                        fontSize: 13, lineHeight: 1.4, wordBreak: "break-word", overflowWrap: "break-word",
                        transition: "max-width 0.2s, width 0.2s",
                        cursor: isPlayer ? "pointer" : "default",
                      }}
                      onMouseEnter={() => {
                        if (!isPlayer) {
                          if (enemyLogAudioRef.current) { enemyLogAudioRef.current.pause(); enemyLogAudioRef.current = null; }
                          const audio = new Audio(`/battle_audio/${conversation!.conversation_id}/round_${entry.id}.wav`);
                          enemyLogAudioRef.current = audio;
                          audio.play().catch(() => {});
                          return;
                        }
                        if (expandTimerRef.current) clearTimeout(expandTimerRef.current);
                        expandTimerRef.current = window.setTimeout(() => setExpandedLogEntry(i), 250);
                      }}
                      onMouseLeave={() => {
                        if (!isPlayer) {
                          if (enemyLogAudioRef.current) { enemyLogAudioRef.current.pause(); enemyLogAudioRef.current = null; }
                          return;
                        }
                        if (expandTimerRef.current) clearTimeout(expandTimerRef.current);
                        if (!isPinned) setExpandedLogEntry(null);
                      }}
                      onClick={() => {
                        if (!isPlayer) return;
                        setPinnedLogEntries(prev => {
                          const next = new Set(prev);
                          if (next.has(i)) next.delete(i);
                          else next.add(i);
                          return next;
                        });
                      }}
                    >
                      {/* Header */}
                      <div style={{ display: "flex", alignItems: "center", gap: 5, opacity: 0.6, fontSize: 11, marginBottom: 3 }}>
                        <span>{isPlayer ? "You" : conversation!.enemy_name}</span>
                        {isPlayer && entry.isWrongAttempt && (
                          <span style={{ color: "#fca5a5", fontSize: 11 }}>✗ wrong</span>
                        )}
                        {isPlayer && !entry.isWrongAttempt && (
                          <span style={{
                            width: 7, height: 7, borderRadius: "50%", display: "inline-block", flexShrink: 0,
                            background: entry.skipped ? "#fbbf24" : "#22c55e",
                          }} />
                        )}
                        {isPlayer && entry.damageDealt && !entry.skipped && !entry.isWrongAttempt && (
                          <span style={{ color: "#86efac" }}>
                            +{entry.damageDealt} dmg{entry.llmCalled && <span title="Judged by AI" style={{ marginLeft: 4, opacity: 0.6, fontSize: 11 }}>🤖</span>}
                          </span>
                        )}
                        {isPlayer && !entry.skipped && entry.qualityScore != null && (() => {
                          const q = entry.qualityScore;
                          const hue = Math.round((q / 100) * 217);
                          const fillColor = `hsl(${hue}, 80%, 58%)`;
                          const totalHints = entry.allHints?.length ?? 0;
                          const hintsUsed = entry.hintsUsed ?? 0;
                          const hintPct = totalHints > 0 ? Math.round(((totalHints - hintsUsed) / totalHints) * 100) : null;
                          return (
                            <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 3, marginLeft: 2 }}>
                              {/* Blue→red quality bar */}
                              <div style={{ width: 56, height: 5, borderRadius: 3, background: "rgba(255,255,255,0.2)", overflow: "hidden" }}>
                                <div style={{ width: `${q}%`, height: "100%", background: fillColor, borderRadius: 3, transition: "width 0.3s" }} />
                              </div>
                              {/* Gold hints bar */}
                              {hintPct !== null && (
                                <div style={{ width: 14, height: 5, borderRadius: 3, background: "rgba(255,255,255,0.2)", overflow: "hidden" }}>
                                  <div style={{ width: `${hintPct}%`, height: "100%", background: "#fbbf24", borderRadius: 3, transition: "width 0.3s" }} />
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>

                      {/* Wrong attempt: show attempt text + inline feedback instead of native sentence */}
                      {isPlayer && entry.isWrongAttempt && (
                        <div>
                          <div style={{ fontSize: 13 }}>{entry.textLearning}</div>
                          {(() => {
                            const tip = entry.feedbackExplanation ?? (entry.feedbackKey ? FEEDBACK_MAP[entry.feedbackKey] : null);
                            return tip ? (
                              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", lineHeight: 1.4, marginTop: 3 }}>
                                {tip}{entry.correctedSnippet && <span style={{ color: "#fbbf24", fontWeight: 500 }}> Try: {entry.correctedSnippet}</span>}
                              </div>
                            ) : null;
                          })()}
                        </div>
                      )}

                      {/* Native sentence — hidden when expanded (section 1 of expanded view handles it) */}
                      {(!isPlayer || !isExpanded) && !entry.isWrongAttempt && (
                        <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
                          <span>{entry.textNative}</span>
                          {!isPlayer && hideLearnText && entry.textLearning && (
                            <span
                              onMouseEnter={() => setPeekLogIdx(i)}
                              onMouseLeave={() => setPeekLogIdx(null)}
                              style={{
                                fontSize: 11, cursor: "default", userSelect: "none", flexShrink: 0,
                                opacity: peekLogIdx === i ? 0.8 : 0.28, transition: "opacity 0.15s",
                              }}
                            >
                              👁
                            </span>
                          )}
                        </div>
                      )}

                      {/* Enemy learning text */}
                      {!isPlayer && entry.textLearning && (!hideLearnText || peekLogIdx === i) && (
                        <div style={{ color: "#fca5a5", fontSize: 12, marginTop: 3, opacity: 0.75 }}>
                          {entry.textLearning}
                        </div>
                      )}

                      {/* Expanded player details */}
                      {isPlayer && isExpanded && !entry.isWrongAttempt && (
                        <PlayerLogEntryExpanded
                          entry={entry}
                          hideLearnText={hideLearnText}
                          conversationId={conversation!.conversation_id}
                          wrongAttempts={wrongAttemptsByRound.get(entry.id)}
                        />
                      )}
                    </div>
                  </div>
                );
              });
              })()}

              {/* Enemy turn mirrored in log */}
              {showEnemyTurn && !defendEnabled && currentRound?.speaker === "enemy" && (
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <div style={{
                    maxWidth: "60%", width: "fit-content", padding: "8px 12px", borderRadius: 12,
                    background: "rgba(239,68,68,0.25)", fontSize: 13, lineHeight: 1.4,
                    wordBreak: "break-word", overflowWrap: "break-word",
                    animation: "fadeInScale 0.3s ease-out",
                  }}>
                    <div style={{ opacity: 0.6, fontSize: 11, marginBottom: 2 }}>{conversation!.enemy_name}</div>
                    {resolveEnemyRound(currentRound as EnemyRound).enemy_line_native}
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
