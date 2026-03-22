// NumberRush.tsx
// Listening comprehension game: hear a number, find and tap it on the grid.
import React, { useState, useEffect, useRef, useCallback } from "react";

type LangSpec = { code: string; name: string };

type NumberRushProps = {
  fluent: LangSpec;
  learning: LangSpec;
  onBack: () => void;
};

type Difficulty = "beginner" | "intermediate" | "advanced";

type DifficultyConfig = {
  label: string;
  range: number;       // 0..range (inclusive)
  cols: number;
  rows: number;
  squareSize: number;
  timerSeconds: number;
  colorCode: boolean;
  basePoints: number;
  speedBonusMax: number;
};

const DIFFICULTY_CONFIG: Record<Difficulty, DifficultyConfig> = {
  beginner: {
    label: "Beginner",
    range: 20,
    cols: 4,
    rows: 6,
    squareSize: 80,
    timerSeconds: 6,
    colorCode: true,
    basePoints: 100,
    speedBonusMax: 150,
  },
  intermediate: {
    label: "Intermediate",
    range: 50,
    cols: 6,
    rows: 9,
    squareSize: 60,
    timerSeconds: 4,
    colorCode: true,
    basePoints: 150,
    speedBonusMax: 200,
  },
  advanced: {
    label: "Advanced",
    range: 99,
    cols: 8,
    rows: 13,
    squareSize: 46,
    timerSeconds: 3,
    colorCode: false,
    basePoints: 200,
    speedBonusMax: 300,
  },
};

// Voices available per language. Drop audio files in:
//   /public/number_audio/{langCode}/{voice}/number_{n}.mp3
const VOICES: Record<string, string[]> = {
  es: ["voice1", "voice2"],
  id: ["voice1", "voice2"],
  en: ["voice1"],
};

function getAudioPath(n: number, langCode: string, voice: string): string {
  return `/number_audio/${langCode}/${voice}/number_${n}.mp3`;
}

// Colour-coding for number ranges (beginner/intermediate)
function getSquareColor(n: number, range: number, colorCode: boolean): string {
  if (!colorCode) return "rgba(255,255,255,0.12)";
  const ratio = n / range;
  if (ratio < 0.25) return "rgba(96,165,250,0.35)";   // blue  0–25%
  if (ratio < 0.5)  return "rgba(52,211,153,0.35)";   // green 25–50%
  if (ratio < 0.75) return "rgba(251,191,36,0.35)";   // amber 50–75%
  return "rgba(248,113,113,0.35)";                     // red   75–100%
}

function getSquareBorder(n: number, range: number, colorCode: boolean): string {
  if (!colorCode) return "1px solid rgba(255,255,255,0.18)";
  const ratio = n / range;
  if (ratio < 0.25) return "1px solid rgba(96,165,250,0.6)";
  if (ratio < 0.5)  return "1px solid rgba(52,211,153,0.6)";
  if (ratio < 0.75) return "1px solid rgba(251,191,36,0.6)";
  return "1px solid rgba(248,113,113,0.6)";
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Build a grid of random numbers from 0..range.
// Grid cells may repeat numbers (total cells > range+1 for intermediate/advanced).
function buildGrid(cols: number, rows: number, range: number): number[] {
  const total = cols * rows;
  // Ensure every number in 0..range appears at least once, then fill rest randomly
  const base = Array.from({ length: range + 1 }, (_, i) => i);
  const extra = Array.from({ length: Math.max(0, total - base.length) }, () =>
    randomInt(0, range)
  );
  return shuffle([...base, ...extra]).slice(0, total);
}

type CellState = {
  id: number;       // unique key (increments on replacement)
  value: number;
  state: "idle" | "correct" | "wrong" | "entering";
};

type GamePhase = "intro" | "playing" | "results";

export default function NumberRush({ learning, onBack }: NumberRushProps) {
  const [phase, setPhase] = useState<GamePhase>("intro");
  const [difficulty, setDifficulty] = useState<Difficulty>("beginner");

  // Grid
  const [cells, setCells] = useState<CellState[]>([]);
  const cellIdCounter = useRef(0);

  // Round state
  const [targetNumber, setTargetNumber] = useState<number | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [timerActive, setTimerActive] = useState(false);
  const [timerRemaining, setTimerRemaining] = useState(0);
  const [roundPhase, setRoundPhase] = useState<"waiting" | "listening" | "tapping" | "feedback">("waiting");
  const tapStartTimeRef = useRef<number>(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerIntervalRef = useRef<number | null>(null);

  // Scoring
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [totalRounds, setTotalRounds] = useState(0);
  const [reactionTimes, setReactionTimes] = useState<number[]>([]);

  // Voice rotation
  const voiceIndexRef = useRef(0);
  const currentVoiceRef = useRef("voice1");

  // Feedback overlay
  const [flashCell, setFlashCell] = useState<{ id: number; correct: boolean } | null>(null);
  const [pointsPopup, setPointsPopup] = useState<{ pts: number; x: number; y: number } | null>(null);

  const cfg = DIFFICULTY_CONFIG[difficulty];
  const langCode = learning.code;

  // ── helpers ──────────────────────────────────────────────────────────────

  function nextVoice(): string {
    const voices = VOICES[langCode] ?? ["voice1"];
    const v = voices[voiceIndexRef.current % voices.length];
    voiceIndexRef.current++;
    currentVoiceRef.current = v;
    return v;
  }

  function pickTarget(currentCells: CellState[]): number {
    const available = [...new Set(currentCells.filter(c => c.state === "idle").map(c => c.value))];
    return available[Math.floor(Math.random() * available.length)];
  }

  function makeCell(value: number, state: CellState["state"] = "idle"): CellState {
    return { id: cellIdCounter.current++, value, state };
  }

  // ── game start ────────────────────────────────────────────────────────────

  function startGame() {
    const values = buildGrid(cfg.cols, cfg.rows, cfg.range);
    const initial = values.map(v => makeCell(v));
    setCells(initial);
    setScore(0);
    setStreak(0);
    setBestStreak(0);
    setCorrectCount(0);
    setTotalRounds(0);
    setReactionTimes([]);
    voiceIndexRef.current = 0;
    setPhase("playing");
    setRoundPhase("waiting");
    // Start first round shortly after mount
    setTimeout(() => startRound(initial), 400);
  }

  // ── round lifecycle ───────────────────────────────────────────────────────

  const startRound = useCallback((currentCells: CellState[]) => {
    const target = pickTarget(currentCells);
    setTargetNumber(target);
    setRoundPhase("listening");
    setAudioPlaying(true);

    const voice = nextVoice();
    const src = getAudioPath(target, langCode, voice);
    const audio = new Audio(src);
    audioRef.current = audio;

    audio.addEventListener("ended", () => {
      setAudioPlaying(false);
      beginTapPhase();
    }, { once: true });

    audio.addEventListener("error", () => {
      // Audio file not found — skip straight to tapping (stub mode)
      setAudioPlaying(false);
      beginTapPhase();
    }, { once: true });

    audio.play().catch(() => {
      setAudioPlaying(false);
      beginTapPhase();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [langCode]);

  function beginTapPhase() {
    tapStartTimeRef.current = Date.now();
    setTimerRemaining(cfg.timerSeconds * 1000);
    setTimerActive(true);
    setRoundPhase("tapping");
  }

  // Timer countdown
  useEffect(() => {
    if (!timerActive) return;
    timerIntervalRef.current = window.setInterval(() => {
      setTimerRemaining(prev => {
        if (prev <= 50) {
          clearInterval(timerIntervalRef.current!);
          setTimerActive(false);
          handleTimeout();
          return 0;
        }
        return prev - 50;
      });
    }, 50);
    return () => clearInterval(timerIntervalRef.current!);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timerActive]);

  function handleTimeout() {
    setStreak(0);
    setTotalRounds(r => r + 1);
    setRoundPhase("feedback");
    setTimeout(() => {
      setCells(prev => {
        const next = advanceAfterRound(prev, null);
        startRound(next);
        return next;
      });
      setRoundPhase("waiting");
    }, 800);
  }

  // ── tap handler ───────────────────────────────────────────────────────────

  function handleTap(cell: CellState, e: React.MouseEvent) {
    if (roundPhase !== "tapping" || cell.state !== "idle") return;

    clearInterval(timerIntervalRef.current!);
    setTimerActive(false);

    const reactionMs = Date.now() - tapStartTimeRef.current;
    const correct = cell.value === targetNumber;

    setFlashCell({ id: cell.id, correct });
    setTimeout(() => setFlashCell(null), 500);

    if (correct) {
      const newStreak = streak + 1;
      const multiplier = newStreak >= 10 ? 3 : newStreak >= 5 ? 2 : newStreak >= 3 ? 1.5 : 1;
      const speedBonus = Math.round(
        cfg.speedBonusMax * Math.max(0, 1 - reactionMs / (cfg.timerSeconds * 1000))
      );
      const pts = Math.round((cfg.basePoints + speedBonus) * multiplier);

      setScore(s => s + pts);
      setStreak(newStreak);
      setBestStreak(b => Math.max(b, newStreak));
      setCorrectCount(c => c + 1);
      setReactionTimes(r => [...r, reactionMs]);
      setTotalRounds(r => r + 1);

      // Show floating points
      const rect = e.currentTarget.getBoundingClientRect();
      setPointsPopup({ pts, x: rect.left + rect.width / 2, y: rect.top });
      setTimeout(() => setPointsPopup(null), 900);

      setRoundPhase("feedback");
      setTimeout(() => {
        setCells(prev => {
          const next = advanceAfterRound(prev, cell.id);
          startRound(next);
          return next;
        });
        setRoundPhase("waiting");
      }, 600);
    } else {
      // Wrong tap — flash red, no streak break, timer resumes
      setStreak(0);
      setCells(prev => prev.map(c => c.id === cell.id ? { ...c, state: "wrong" } : c));
      setTimeout(() => {
        setCells(prev => prev.map(c => c.id === cell.id ? { ...c, state: "idle" } : c));
        // Resume timer
        tapStartTimeRef.current = Date.now() - reactionMs; // keep elapsed time
        setTimerRemaining(prev => prev);
        setTimerActive(true);
      }, 400);
    }
  }

  // Replace the tapped correct cell with a new number that doesn't match target
  function advanceAfterRound(prev: CellState[], tappedId: number | null): CellState[] {
    const currentTarget = targetNumber;
    return prev.map(c => {
      if (c.id !== tappedId) return { ...c, state: "idle" };
      // New value: any number in range, preferably not same as current target
      let newVal: number;
      let attempts = 0;
      do {
        newVal = randomInt(0, cfg.range);
        attempts++;
      } while (newVal === currentTarget && attempts < 10);
      return { ...makeCell(newVal, "entering") };
    });
  }

  // Clear "entering" animation state after it plays
  useEffect(() => {
    const entering = cells.some(c => c.state === "entering");
    if (!entering) return;
    const t = setTimeout(() => {
      setCells(prev => prev.map(c => c.state === "entering" ? { ...c, state: "idle" } : c));
    }, 400);
    return () => clearTimeout(t);
  }, [cells]);

  // ── end game ──────────────────────────────────────────────────────────────

  function endGame() {
    clearInterval(timerIntervalRef.current!);
    audioRef.current?.pause();
    setPhase("results");
  }

  // ── cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      clearInterval(timerIntervalRef.current!);
      audioRef.current?.pause();
    };
  }, []);

  // ── render ────────────────────────────────────────────────────────────────

  const timerFraction = timerRemaining / (cfg.timerSeconds * 1000);
  const timerColor = timerFraction > 0.5 ? "#22c55e" : timerFraction > 0.25 ? "#fbbf24" : "#ef4444";
  const avgReaction = reactionTimes.length > 0
    ? Math.round(reactionTimes.reduce((a, b) => a + b, 0) / reactionTimes.length)
    : 0;

  // ── INTRO ─────────────────────────────────────────────────────────────────
  if (phase === "intro") {
    return (
      <div style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%)",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        fontFamily: "system-ui, -apple-system, sans-serif", padding: 24, color: "white",
      }}>
        <button onClick={onBack} style={{
          position: "fixed", top: 20, left: 20,
          background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)",
          color: "white", borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 14,
        }}>
          ← Back
        </button>

        <div style={{ fontSize: 64, marginBottom: 16 }}>🔢</div>
        <h1 style={{ fontSize: 40, fontWeight: 800, marginBottom: 8, textAlign: "center",
          background: "linear-gradient(135deg, #fbbf24, #f97316)", WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
        }}>
          Number Rush
        </h1>
        <p style={{ fontSize: 16, opacity: 0.7, marginBottom: 40, textAlign: "center", maxWidth: 360 }}>
          Listen to the number in <strong style={{ color: "#fbbf24", opacity: 1 }}>{learning.name}</strong>,
          then find and tap it on the grid as fast as you can!
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 14, width: "100%", maxWidth: 380 }}>
          {(["beginner", "intermediate", "advanced"] as Difficulty[]).map(d => {
            const c = DIFFICULTY_CONFIG[d];
            const selected = difficulty === d;
            return (
              <button
                key={d}
                onClick={() => setDifficulty(d)}
                style={{
                  padding: "18px 24px", borderRadius: 12, border: "none", cursor: "pointer",
                  background: selected
                    ? "linear-gradient(135deg, #f97316 0%, #ea580c 100%)"
                    : "rgba(255,255,255,0.07)",
                  color: "white",
                  boxShadow: selected ? "0 4px 20px rgba(249,115,22,0.4)" : "none",
                  transform: selected ? "scale(1.02)" : "scale(1)",
                  transition: "all 0.15s",
                  textAlign: "left",
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 4 }}>{c.label}</div>
                <div style={{ fontSize: 13, opacity: 0.75 }}>
                  Numbers 0–{c.range} · {c.cols}×{c.rows} grid · {c.timerSeconds}s timer
                  {c.colorCode ? " · color-coded" : ""}
                </div>
              </button>
            );
          })}
        </div>

        <button
          onClick={startGame}
          style={{
            marginTop: 36, padding: "16px 56px", fontSize: 20, fontWeight: 700,
            background: "linear-gradient(135deg, #fbbf24 0%, #f97316 100%)",
            color: "white", border: "none", borderRadius: 12, cursor: "pointer",
            boxShadow: "0 4px 20px rgba(249,115,22,0.4)",
            transition: "transform 0.15s",
          }}
          onMouseEnter={e => e.currentTarget.style.transform = "scale(1.04)"}
          onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}
        >
          Play
        </button>
      </div>
    );
  }

  // ── RESULTS ───────────────────────────────────────────────────────────────
  if (phase === "results") {
    const accuracy = totalRounds > 0 ? Math.round((correctCount / totalRounds) * 100) : 0;
    return (
      <div style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%)",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        fontFamily: "system-ui, -apple-system, sans-serif", padding: 24, color: "white",
      }}>
        <div style={{ fontSize: 64, marginBottom: 12 }}>🏁</div>
        <h2 style={{ fontSize: 32, fontWeight: 800, marginBottom: 32,
          background: "linear-gradient(135deg, #fbbf24, #f97316)", WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
        }}>
          Round Over!
        </h2>

        <div style={{
          background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 16, padding: "32px 40px", marginBottom: 32, minWidth: 280, textAlign: "center",
        }}>
          {[
            ["Score", score.toLocaleString(), "#fbbf24"],
            ["Correct", `${correctCount} / ${totalRounds}`, "#86efac"],
            ["Accuracy", `${accuracy}%`, "#67e8f9"],
            ["Best Streak", `×${bestStreak}`, "#c4b5fd"],
            ["Avg Reaction", avgReaction > 0 ? `${avgReaction}ms` : "—", "#f9a8d4"],
          ].map(([label, value, color]) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 40, marginBottom: 14, fontSize: 17 }}>
              <span style={{ opacity: 0.6 }}>{label}</span>
              <span style={{ fontWeight: 700, color: color as string }}>{value}</span>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <button
            onClick={startGame}
            style={{
              padding: "14px 32px", fontSize: 16, fontWeight: 700,
              background: "linear-gradient(135deg, #fbbf24 0%, #f97316 100%)",
              color: "white", border: "none", borderRadius: 10, cursor: "pointer",
              boxShadow: "0 4px 16px rgba(249,115,22,0.35)",
            }}
          >
            Play Again
          </button>
          <button
            onClick={() => setPhase("intro")}
            style={{
              padding: "14px 32px", fontSize: 16, fontWeight: 700,
              background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)",
              color: "white", borderRadius: 10, cursor: "pointer",
            }}
          >
            Change Difficulty
          </button>
          <button
            onClick={onBack}
            style={{
              padding: "14px 32px", fontSize: 16, fontWeight: 700,
              background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)",
              color: "white", borderRadius: 10, cursor: "pointer",
            }}
          >
            Home
          </button>
        </div>
      </div>
    );
  }

  // ── PLAYING ───────────────────────────────────────────────────────────────
  const streakMultiplier = streak >= 10 ? 3 : streak >= 5 ? 2 : streak >= 3 ? 1.5 : 1;

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%)",
      display: "flex", flexDirection: "column",
      fontFamily: "system-ui, -apple-system, sans-serif", color: "white",
      userSelect: "none",
    }}>
      {/* ── HUD ── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 16px", background: "rgba(0,0,0,0.35)", borderBottom: "1px solid rgba(255,255,255,0.08)",
        flexShrink: 0, flexWrap: "wrap", gap: 8,
      }}>
        <button onClick={endGame} style={{
          background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)",
          color: "white", borderRadius: 7, padding: "6px 14px", cursor: "pointer", fontSize: 13,
        }}>
          ← End
        </button>

        {/* Score */}
        <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 11, opacity: 0.5, textTransform: "uppercase", letterSpacing: 1 }}>Score</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#fbbf24" }}>{score.toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 11, opacity: 0.5, textTransform: "uppercase", letterSpacing: 1 }}>Streak</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: streak >= 3 ? "#c4b5fd" : "white" }}>
              {streak > 0 ? `×${streakMultiplier} 🔥` : streak}
            </div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 11, opacity: 0.5, textTransform: "uppercase", letterSpacing: 1 }}>Correct</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#86efac" }}>{correctCount}</div>
          </div>
        </div>

        <div style={{ fontSize: 13, opacity: 0.5 }}>{DIFFICULTY_CONFIG[difficulty].label}</div>
      </div>

      {/* ── Audio status + timer bar ── */}
      <div style={{ flexShrink: 0, padding: "10px 16px 0" }}>
        {/* Status text */}
        <div style={{
          textAlign: "center", fontSize: 15, fontWeight: 600, marginBottom: 8, minHeight: 22,
          color: roundPhase === "listening" ? "#67e8f9" : roundPhase === "tapping" ? "#fbbf24" : "rgba(255,255,255,0.4)",
          transition: "color 0.2s",
        }}>
          {roundPhase === "listening" && (audioPlaying ? "🔊 Listen..." : "🔊 ...")}
          {roundPhase === "tapping" && targetNumber !== null && `Find: ${targetNumber}`}
          {roundPhase === "feedback" && "✓"}
          {roundPhase === "waiting" && ""}
        </div>

        {/* Timer bar */}
        <div style={{
          height: 6, borderRadius: 3, background: "rgba(255,255,255,0.1)",
          overflow: "hidden", transition: "opacity 0.2s",
          opacity: timerActive ? 1 : 0.2,
        }}>
          <div style={{
            height: "100%", borderRadius: 3,
            width: `${timerFraction * 100}%`,
            background: timerColor,
            transition: "width 0.05s linear, background 0.3s",
          }} />
        </div>
      </div>

      {/* ── Grid ── */}
      <div style={{
        flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
        padding: 12, overflow: "hidden",
      }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cfg.cols}, ${cfg.squareSize}px)`,
          gridTemplateRows: `repeat(${cfg.rows}, ${cfg.squareSize}px)`,
          gap: 4,
        }}>
          {cells.map(cell => {
            const isFlashing = flashCell?.id === cell.id;
            const flashCorrect = flashCell?.correct;
            const isEntering = cell.state === "entering";
            const isWrong = cell.state === "wrong";

            let bg = getSquareColor(cell.value, cfg.range, cfg.colorCode);
            let border = getSquareBorder(cell.value, cfg.range, cfg.colorCode);
            let extraStyle: React.CSSProperties = {};

            if (isFlashing && flashCorrect) {
              bg = "rgba(34,197,94,0.6)";
              border = "2px solid #22c55e";
              extraStyle = { transform: "scale(1.15)", boxShadow: "0 0 20px rgba(34,197,94,0.7)" };
            } else if (isWrong || (isFlashing && !flashCorrect)) {
              bg = "rgba(239,68,68,0.45)";
              border = "2px solid #ef4444";
              extraStyle = { transform: "scale(0.93)" };
            } else if (isEntering) {
              extraStyle = { transform: "translateY(-20px) scale(0.8)", opacity: 0 };
            }

            return (
              <div
                key={cell.id}
                onClick={e => handleTap(cell, e)}
                style={{
                  width: cfg.squareSize, height: cfg.squareSize,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: bg, border, borderRadius: 8,
                  fontSize: cfg.squareSize >= 70 ? 26 : cfg.squareSize >= 55 ? 20 : 15,
                  fontWeight: 700, color: "white",
                  cursor: roundPhase === "tapping" ? "pointer" : "default",
                  transition: "transform 0.15s, background 0.15s, box-shadow 0.15s, opacity 0.3s",
                  ...extraStyle,
                }}
              >
                {cell.value}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Floating points popup ── */}
      {pointsPopup && (
        <div style={{
          position: "fixed",
          left: pointsPopup.x,
          top: pointsPopup.y,
          transform: "translate(-50%, -100%)",
          fontSize: 22, fontWeight: 800, color: "#fbbf24",
          pointerEvents: "none",
          animation: "floatUp 0.9s ease-out forwards",
          textShadow: "0 2px 8px rgba(0,0,0,0.5)",
          zIndex: 100,
        }}>
          +{pointsPopup.pts}
        </div>
      )}

      <style>{`
        @keyframes floatUp {
          0%   { opacity: 1; transform: translate(-50%, -100%); }
          100% { opacity: 0; transform: translate(-50%, -220%); }
        }
      `}</style>
    </div>
  );
}
