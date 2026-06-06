// sharedGameComponents.tsx
// Shared React components used across game modes.
import React, { useRef, useState } from "react";
import { FEEDBACK_MAP, FEEDBACK_COLORS, FEEDBACK_LABELS, FeedbackIssue, CorrectionToken, HintItem, HINT_COLORS, calculateDistance, distanceToOpacity, tokenizeWithHints, diffExampleVsUser, SharedHistoryEntry } from "./sharedGameUtils";

// ── FeedbackBadges ────────────────────────────────────────────────────────────
// Renders a list of feedback issue pills with explanations.
// small=true uses compact sizing (for history log sub-sections).
export function FeedbackBadges({ issues, small = false }: { issues: FeedbackIssue[]; small?: boolean }) {
  return (
    <>
      {issues.map((issue, i) => {
        const catColor = FEEDBACK_COLORS[issue.feedbackKey] ?? "#94a3b8";
        const catLabel = FEEDBACK_LABELS[issue.feedbackKey] ?? issue.feedbackKey;
        const tip = issue.feedbackExplanation ?? FEEDBACK_MAP[issue.feedbackKey];
        return (
          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 6, flexWrap: "wrap" }}>
            <span style={{
              fontSize: small ? 10 : 11, fontWeight: 600,
              padding: small ? "1px 6px" : "2px 8px", borderRadius: 999,
              background: `${catColor}22`, border: `1px solid ${catColor}66`, color: catColor,
              whiteSpace: "nowrap", flexShrink: 0,
            }}>
              {catLabel}
            </span>
            {tip && (
              <span style={{ fontSize: small ? 11 : 12, color: catColor, lineHeight: 1.4, opacity: 0.9 }}>
                {tip}{issue.correctedSnippet
                  ? <span style={{ fontWeight: 600 }}> → {issue.correctedSnippet}</span>
                  : null}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

// ── CorrectionTokens ──────────────────────────────────────────────────────────
// Renders a correction diff (red strikethrough removals, bold green additions).
// wrapped=true (default) adds a padded background container.
// wrapped=false renders tokens inline, useful inside an existing container.
export function CorrectionTokens({
  tokens,
  small = false,
  wrapped = true,
}: {
  tokens: CorrectionToken[];
  small?: boolean;
  wrapped?: boolean;
}) {
  const spans = tokens.map((tok, ti) => {
    if (tok.status === "remove")
      return <span key={ti} style={{ color: "#fca5a5", textDecoration: "line-through", textDecorationColor: "#fca5a5" }}>{tok.text}</span>;
    if (tok.status === "add")
      return <span key={ti} style={{ color: "#86efac", fontWeight: 600 }}>{tok.text}</span>;
    return <span key={ti} style={{ color: "rgba(255,255,255,0.8)" }}>{tok.text}</span>;
  });

  if (!wrapped) return <>{spans}</>;

  return (
    <div style={{
      fontSize: small ? 12 : 13, lineHeight: 1.7, wordBreak: "break-word",
      padding: "5px 10px", background: "rgba(255,255,255,0.04)", borderRadius: 6,
    }}>
      {spans}
    </div>
  );
}

// ── HintCards ─────────────────────────────────────────────────────────────────
// Scrollable row of hint cards with proximity glow, hover-to-reveal text, and
// hover-to-play audio. Manages its own proximity state internally.
// Use a changing `key` prop to reset state when the sentence changes.
export function HintCards({
  hints,
  viewedHints,
  onReveal,
  onPlayAudio,
  onStopAudio,
}: {
  hints: HintItem[];
  viewedHints: Set<number>;
  onReveal: (idx: number) => void;
  onPlayAudio: (text: string) => void;
  onStopAudio: () => void;
}) {
  const hintCardsRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [closestIdx, setClosestIdx] = useState<number | null>(null);
  const [closestOpacity, setClosestOpacity] = useState(0);

  if (!hints.length) return null;

  function handleMouseMove(e: React.MouseEvent) {
    let minDist = Infinity;
    let minIdx: number | null = null;
    hintCardsRefs.current.forEach((el, i) => {
      if (!el || viewedHints.has(i)) return;
      const d = calculateDistance(e.clientX, e.clientY, el);
      if (d < minDist) { minDist = d; minIdx = i; }
    });
    setClosestIdx(minIdx);
    setClosestOpacity(minIdx !== null ? distanceToOpacity(minDist) : 0);
  }

  return (
    <div
      onMouseMove={handleMouseMove}
      onMouseLeave={() => { setClosestIdx(null); setClosestOpacity(0); onStopAudio(); }}
    >
      <div style={{ fontSize: 11, opacity: 0.4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Hints</div>
      <div style={{ display: "flex", gap: 10, overflowX: "auto", padding: "4px 0" }}>
        {hints.map((hint, idx) => {
          const isRevealed = viewedHints.has(idx);
          const isClosest = closestIdx === idx && !isRevealed;
          const learningParts = hint.learning.split("/").map(p => p.trim()).filter(Boolean);
          const firstVariant = learningParts[0] ?? hint.learning;
          return (
            <div
              key={idx}
              ref={el => { hintCardsRefs.current[idx] = el; }}
              style={{
                flexShrink: 0, width: 130, display: "flex", flexDirection: "column",
                border: isRevealed
                  ? "2px solid rgba(255,255,255,0.3)"
                  : isClosest
                  ? `2px solid rgba(0,212,255,${Math.max(0.3, closestOpacity)})`
                  : "2px solid #FFD700",
                borderRadius: 8, padding: "8px 12px 6px",
                background: isRevealed
                  ? "rgba(255,255,255,0.1)"
                  : isClosest
                  ? `rgba(0,212,255,${0.15 * closestOpacity})`
                  : "rgba(255,215,0,0.1)",
                boxShadow: isRevealed || isClosest ? "none" : "0 2px 8px rgba(255,215,0,0.2)",
                transition: "all 0.3s ease",
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 14, color: isRevealed ? "#9ca3af" : "white" }}>
                {hint.native}
              </div>
              {isRevealed ? (
                <div style={{ marginBottom: 6, flex: 1 }}>
                  {learningParts.length > 1
                    ? <ol style={{ margin: 0, padding: "0 0 0 16px", color: "#93c5fd", fontSize: 12, fontWeight: 500 }}>
                        {learningParts.map((p, pi) => <li key={pi}>{p}</li>)}
                      </ol>
                    : <div style={{ color: "#93c5fd", fontSize: 12, fontWeight: 500 }}>{hint.learning}</div>}
                  {hint.note && <div style={{ fontSize: 10, fontStyle: "italic", color: "rgba(255,255,255,0.45)", marginTop: 4 }}>{hint.note}</div>}
                </div>
              ) : (
                <button
                  onMouseEnter={() => onReveal(idx)}
                  style={{
                    width: "100%", padding: "6px 8px", fontSize: 12, borderRadius: 6, cursor: "pointer",
                    textAlign: "center", fontWeight: 600, marginBottom: 6, flex: 1, minHeight: 44,
                    background: "rgba(147,197,253,0.08)", border: "1px dashed rgba(147,197,253,0.3)",
                    color: "rgba(147,197,253,0.5)",
                  }}
                >Aa</button>
              )}
              <button
                onMouseEnter={() => onPlayAudio(firstVariant)}
                onMouseLeave={onStopAudio}
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

// ── HistoryLogEntry ───────────────────────────────────────────────────────────
// Self-contained history log entry used by WordDrillGame and TriviaGame2.
// Manages its own expand/pin/audio/hint-hover/preview state.
// Pass a changing `key` prop (e.g. entry.entryId) — do not reuse instances.
//
// wrongAttempts: wrong entries for the same sentence (WordDrill passes these
//   externally; TriviaGame2 embeds them in the entry and maps them before passing).
// promptLabel: optional node rendered above the sentence in expanded view
//   (e.g. TriviaGame2's difficulty dot + spotlight word).
// extraBottom: rendered after "Previous Attempts" (e.g. TriviaGame2 bot results).
export function HistoryLogEntry({
  entry,
  wrongAttempts = [],
  apiBase = "http://localhost:8000",
  locale = "es-MX",
  promptLabel,
  extraBottom,
}: {
  entry: SharedHistoryEntry;
  wrongAttempts?: SharedHistoryEntry[];
  apiBase?: string;
  locale?: string;
  promptLabel?: React.ReactNode;
  extraBottom?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [hoverTimer, setHoverTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [hoveredHintIdx, setHoveredHintIdx] = useState<number | null>(null);
  const [previewExIdx, setPreviewExIdx] = useState<number | null>(null);
  const [hoverAudio, setHoverAudio] = useState<HTMLAudioElement | null>(null);
  const audioCacheRef = useRef<Map<string, string>>(new Map());

  const isOpen = expanded || pinned;
  const qualityHue = entry.qualityScore != null ? Math.round((entry.qualityScore / 100) * 217) : 0;
  const qualityFill = `hsl(${qualityHue},80%,58%)`;
  const totalHints = entry.allHints.length;
  const hintsUnusedPct = totalHints > 0 ? Math.round(((totalHints - entry.hintsUsed) / totalHints) * 100) : 0;
  const revealed = new Set(entry.hintsRevealedIndices ?? []);

  async function playAudio(text: string) {
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

  function stopAudio() {
    if (hoverAudio) { hoverAudio.pause(); setHoverAudio(null); }
  }

  const entryBg = entry.skipped
    ? "rgba(148,163,184,0.15)"
    : entry.isWrongAttempt ? "rgba(239,68,68,0.15)" : "rgba(59,130,246,0.2)";
  const entryBorder = pinned
    ? "1px solid rgba(59,130,246,0.6)"
    : entry.skipped ? "1px solid rgba(148,163,184,0.2)"
    : entry.isWrongAttempt ? "1px solid rgba(239,68,68,0.25)" : "1px solid rgba(59,130,246,0.3)";

  return (
    <div
      style={{
        padding: "8px 12px", borderRadius: 10, fontSize: 13, lineHeight: 1.4,
        wordBreak: "break-word", cursor: "pointer",
        background: entryBg, border: entryBorder,
        maxWidth: isOpen ? "92%" : "75%",
        width: isOpen ? "92%" : undefined,
        transition: "max-width 0.2s, width 0.2s",
      }}
      onMouseEnter={() => {
        void playAudio(entry.correctAnswer);
        const t = setTimeout(() => setExpanded(true), 250);
        setHoverTimer(t);
      }}
      onMouseLeave={() => {
        stopAudio();
        if (hoverTimer) { clearTimeout(hoverTimer); setHoverTimer(null); }
        if (!pinned) setExpanded(false);
      }}
      onClick={() => setPinned(p => !p)}
    >
      {/* ── Collapsed header ── */}
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
            {totalHints > 0 && !entry.isWrongAttempt && (
              <div style={{ width: 56, height: 5, borderRadius: 3, background: "rgba(255,255,255,0.2)", overflow: "hidden", border: "1px solid rgba(251,191,36,0.4)" }}>
                <div style={{ height: "100%", width: `${hintsUnusedPct}%`, background: "#fbbf24", transition: "width 0.3s" }} />
              </div>
            )}
            {entry.llmUsed && <span style={{ fontSize: 11, opacity: 0.5 }}>🤖</span>}
          </>
        )}
        {entry.extraLabel && (
          <span style={{ marginLeft: "auto", fontSize: 10, opacity: 0.35, fontWeight: 600, textAlign: "right" }}>{entry.extraLabel}</span>
        )}
      </div>

      {/* English prompt subtitle */}
      {entry.promptText && (
        <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4, fontStyle: "italic" }}>{entry.promptText}</div>
      )}

      {/* Answer row */}
      <div style={{ marginTop: 3, fontWeight: 500, lineHeight: 1.4, fontSize: 13 }}>
        {entry.skipped ? (
          <span style={{ color: "#94a3b8" }}>{entry.correctAnswer}</span>
        ) : entry.correctionTokens?.length ? (
          <CorrectionTokens tokens={entry.correctionTokens} wrapped={false} />
        ) : (
          <span style={{ color: entry.isWrongAttempt ? "#fca5a5" : "rgba(255,255,255,0.9)" }}>
            {entry.userAnswer || "—"}
          </span>
        )}
      </div>

      {/* ── Expanded view ── */}
      {isOpen && (() => {
        const tokens = tokenizeWithHints(entry.promptText, entry.allHints);
        const examples = entry.acceptedTranslations ?? [];
        const effectiveIssues: FeedbackIssue[] = entry.feedbackIssues?.length
          ? entry.feedbackIssues
          : entry.feedbackKey
            ? [{ feedbackKey: entry.feedbackKey, correctedSnippet: entry.correctedSnippet, feedbackExplanation: entry.feedbackExplanation }]
            : (!entry.llmUsed && entry.qualityScore === 100 ? [{ feedbackKey: "perfect" }] : []);

        return (
          <div style={{ marginTop: 10, borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 10 }}>

            {/* 1. Sentence with hint highlighting */}
            <div>
              {promptLabel && (
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", marginBottom: 4 }}>{promptLabel}</div>
              )}
              <div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Sentence</div>
              <div
                style={{ fontSize: 13, lineHeight: 1.6 }}
                onMouseLeave={() => { setHoveredHintIdx(null); stopAudio(); }}
              >
                {tokens.map((tok, i) => {
                  if (tok.hintIndex === null) return (
                    <span key={i} onMouseEnter={() => setHoveredHintIdx(null)}>{tok.text}</span>
                  );
                  const isRev = revealed.has(tok.hintIndex);
                  const isHov = hoveredHintIdx === tok.hintIndex;
                  return (
                    <span
                      key={i}
                      onMouseEnter={() => {
                        setHoveredHintIdx(tok.hintIndex!);
                        const first = entry.allHints[tok.hintIndex!].learning.split("/")[0].trim();
                        void playAudio(first);
                      }}
                      style={{
                        color: isRev ? HINT_COLORS[tok.hintIndex % HINT_COLORS.length] : isHov ? "#93c5fd" : "inherit",
                        borderBottom: isHov ? "1px solid #93c5fd" : isRev ? "none" : "1px dashed rgba(251,191,36,0.6)",
                        cursor: "default", transition: "color 0.1s",
                      }}
                    >{tok.text}</span>
                  );
                })}
              </div>

              {/* Contextual hint pill display (BattleGame-style) */}
              {hoveredHintIdx !== null && entry.allHints[hoveredHintIdx] && (() => {
                const hint = entry.allHints[hoveredHintIdx];
                const variants = hint.learning.split("/").map(v => v.trim()).filter(Boolean);
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    {variants.map((v, vi) => (
                      <span key={vi} style={{
                        display: "inline-flex", alignItems: "center", gap: 4,
                        padding: "2px 9px", borderRadius: 20, fontSize: 12,
                        border: "1px solid rgba(147,197,253,0.3)", background: "rgba(147,197,253,0.07)",
                        color: "#93c5fd",
                      }}>
                        <span style={{ width: 5, height: 5, borderRadius: "50%", display: "inline-block", flexShrink: 0, background: "rgba(147,197,253,0.4)" }} />
                        {v}
                      </span>
                    ))}
                    {hint.note && (
                      <span style={{ fontSize: 11, fontStyle: "italic", color: "rgba(255,255,255,0.45)" }}>{hint.note}</span>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* 2. You Said */}
            {!entry.skipped && (
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    {previewExIdx !== null ? `Example ${previewExIdx + 1}` : "You Said"}
                  </div>
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
                            transition: "all 0.15s",
                          }}
                        >{ei + 1}</div>
                      ))}
                    </div>
                  )}
                </div>
                {previewExIdx !== null ? (
                  <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                    {diffExampleVsUser(entry.userAnswer, examples[previewExIdx]).map((tok, i) => (
                      <span key={i} style={{ color: tok.matched ? "rgba(255,255,255,0.45)" : "#fbbf24" }}>
                        {tok.word}{" "}
                      </span>
                    ))}
                  </div>
                ) : entry.correctionTokens?.length ? (
                  <CorrectionTokens tokens={entry.correctionTokens} wrapped={false} />
                ) : (
                  <span style={{ fontSize: 13, color: "#86efac" }}>{entry.userAnswer}</span>
                )}
              </div>
            )}

            {/* 3. Feedback */}
            {effectiveIssues.length > 0 && (
              <div>
                <div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Feedback</div>
                <FeedbackBadges issues={effectiveIssues} />
              </div>
            )}

            {/* 4. Previous attempts */}
            {wrongAttempts.length > 0 && (
              <div>
                <div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
                  Previous attempts ({wrongAttempts.length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {wrongAttempts.map((wa, wi) => {
                    const waIssues: FeedbackIssue[] = wa.feedbackIssues?.length
                      ? wa.feedbackIssues
                      : wa.feedbackKey ? [{ feedbackKey: wa.feedbackKey, correctedSnippet: wa.correctedSnippet, feedbackExplanation: wa.feedbackExplanation }]
                      : [];
                    return (
                      <div key={wi} style={{ background: "rgba(239,68,68,0.1)", borderRadius: 6, padding: "5px 8px" }}>
                        {wa.correctionTokens?.length ? (
                          <div style={{ fontSize: 12, lineHeight: 1.6, marginBottom: waIssues.length ? 4 : 0 }}>
                            <CorrectionTokens tokens={wa.correctionTokens} wrapped={false} />
                          </div>
                        ) : (
                          <div style={{ fontSize: 12, color: "#fca5a5", marginBottom: waIssues.length ? 3 : 0 }}>{wa.userAnswer}</div>
                        )}
                        {waIssues.length > 0 && <FeedbackBadges issues={waIssues} small />}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {extraBottom}
          </div>
        );
      })()}
    </div>
  );
}
