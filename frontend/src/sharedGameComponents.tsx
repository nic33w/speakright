// sharedGameComponents.tsx
// Shared React components used across game modes.
import { useRef, useState } from "react";
import { FEEDBACK_MAP, FEEDBACK_COLORS, FEEDBACK_LABELS, FeedbackIssue, CorrectionToken, HintItem, calculateDistance, distanceToOpacity } from "./sharedGameUtils";

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
