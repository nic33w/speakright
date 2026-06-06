// sharedGameComponents.tsx
// Shared React components used across game modes.
import { FEEDBACK_MAP, FEEDBACK_COLORS, FEEDBACK_LABELS, FeedbackIssue, CorrectionToken } from "./sharedGameUtils";

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
