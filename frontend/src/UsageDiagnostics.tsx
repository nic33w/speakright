import { useEffect, useRef, useState } from "react";

const API_BASE = "http://localhost:8000";
const MAX_CHARS = 500_000;
const SESSION_COLORS = ["#0e7490", "#0891b2", "#06b6d4", "#22d3ee"];

interface UsageSession {
  mode: string;
  chars: number;
  started_at: string;
}

interface AzureUsage {
  monthly_chars: number;
  month_key: string;
  pending_sessions: UsageSession[];
  current_session: UsageSession | null;
  max_chars: number;
}

interface OpenAIUsage {
  total_cost_cents: number;
  budget_cents: number;
  remaining_cents: number;
}

interface UsageSummary {
  azure: AzureUsage;
  openai?: OpenAIUsage;
}

interface Props {
  currentMode: string;
}

function formatChars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function UsageDiagnostics({ currentMode }: Props) {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const prevModeRef = useRef<string>('home');

  async function fetchUsage() {
    try {
      const res = await fetch(`${API_BASE}/api/usage`);
      if (res.ok) setUsage(await res.json());
    } catch {
      // backend not running yet — stay silent
    }
  }

  // On mode change: notify backend to start a new session
  useEffect(() => {
    if (currentMode !== 'home' && prevModeRef.current !== currentMode) {
      fetch(`${API_BASE}/api/usage/session/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: currentMode }),
      }).then(() => fetchUsage()).catch(() => {});
    }
    prevModeRef.current = currentMode;
  }, [currentMode]);

  // Initial fetch + 30s poll
  useEffect(() => {
    fetchUsage();
    const id = setInterval(fetchUsage, 30_000);
    return () => clearInterval(id);
  }, []);

  const azure = usage?.azure;
  const totalUsed = azure
    ? azure.monthly_chars +
      azure.pending_sessions.reduce((sum, s) => sum + s.chars, 0) +
      (azure.current_session?.chars ?? 0)
    : 0;
  const pct = azure ? ((totalUsed / MAX_CHARS) * 100).toFixed(1) : "0.0";

  return (
    <div style={{
      background: "rgba(0,0,0,0.6)",
      borderBottom: "1px solid rgba(255,255,255,0.08)",
      padding: "6px 14px 8px",
      fontFamily: "monospace",
      fontSize: "11px",
    }}>
      {/* Azure row */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <span style={{ color: "#94a3b8", width: 68, flexShrink: 0 }}>AZURE TTS</span>
        <span style={{ color: "#e2e8f0", flex: "0 0 auto" }}>
          {formatChars(totalUsed)} / {formatChars(MAX_CHARS)} chars ({pct}%)
        </span>
        {azure && (
          <span style={{ color: "#64748b", fontSize: 10 }}>
            resets {azure.month_key}-01 → next month
          </span>
        )}
      </div>

      {/* Segmented bar */}
      <div style={{
        display: "flex",
        height: 10,
        borderRadius: 4,
        overflow: "hidden",
        background: "rgba(255,255,255,0.06)",
      }}>
        {azure && azure.monthly_chars > 0 && (
          <div
            title={`Monthly committed: ${azure.monthly_chars.toLocaleString()} chars`}
            style={{
              width: `${(azure.monthly_chars / MAX_CHARS) * 100}%`,
              background: "#1e40af",
              minWidth: 2,
            }}
          />
        )}
        {azure && azure.pending_sessions.map((s, i) => s.chars > 0 && (
          <div
            key={i}
            title={`${s.mode}: ${s.chars.toLocaleString()} chars`}
            style={{
              width: `${(s.chars / MAX_CHARS) * 100}%`,
              background: SESSION_COLORS[i % SESSION_COLORS.length],
              minWidth: 2,
            }}
          />
        ))}
        {azure?.current_session && azure.current_session.chars > 0 && (
          <div
            title={`Current (${azure.current_session.mode}): ${azure.current_session.chars.toLocaleString()} chars`}
            style={{
              width: `${(azure.current_session.chars / MAX_CHARS) * 100}%`,
              background: "#14b8a6",
              minWidth: 2,
              animation: "diagnostics-pulse 2s ease-in-out infinite",
            }}
          />
        )}
      </div>

      {/* Legend row */}
      {azure && (azure.pending_sessions.length > 0 || azure.current_session) && (
        <div style={{ display: "flex", gap: 10, marginTop: 4, flexWrap: "wrap" }}>
          {azure.monthly_chars > 0 && (
            <span style={{ color: "#93c5fd", fontSize: 10 }}>
              ■ monthly: {formatChars(azure.monthly_chars)}
            </span>
          )}
          {azure.pending_sessions.map((s, i) => s.chars > 0 && (
            <span key={i} style={{ color: SESSION_COLORS[i % SESSION_COLORS.length], fontSize: 10 }}>
              ■ {s.mode}: {formatChars(s.chars)}
            </span>
          ))}
          {azure.current_session && azure.current_session.chars > 0 && (
            <span style={{ color: "#5eead4", fontSize: 10 }}>
              ■ now ({azure.current_session.mode}): {formatChars(azure.current_session.chars)}
            </span>
          )}
        </div>
      )}

      {/* OpenAI row */}
      {(() => {
        const oai = usage?.openai;
        const spentPct = oai ? (oai.total_cost_cents / oai.budget_cents) * 100 : 0;
        const remainingPct = 100 - spentPct;
        const barColor = remainingPct < 10 ? "#ef4444" : remainingPct < 30 ? "#f59e0b" : "#10b981";
        return (
          <div style={{ marginTop: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <span style={{ color: "#94a3b8", width: 68, flexShrink: 0 }}>OPENAI</span>
              <span style={{ color: "#e2e8f0", flex: "0 0 auto" }}>
                {oai ? formatDollars(oai.total_cost_cents) : "$0.00"} used ({oai ? spentPct.toFixed(1) : "0.0"}%)
              </span>
              <span style={{ color: "#64748b", fontSize: 10 }}>
                / {oai ? formatDollars(oai.budget_cents) : "$10.00"} · no reset
              </span>
            </div>
            <div style={{
              display: "flex",
              height: 10,
              borderRadius: 4,
              overflow: "hidden",
              background: "rgba(255,255,255,0.06)",
            }}>
              {oai && oai.total_cost_cents > 0 && (
                <div
                  title={`Spent: ${formatDollars(oai.total_cost_cents)}`}
                  style={{
                    width: `${Math.min(spentPct, 100)}%`,
                    background: barColor,
                    minWidth: 2,
                    opacity: 0.5,
                  }}
                />
              )}
            </div>
          </div>
        );
      })()}

      <style>{`
        @keyframes diagnostics-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
    </div>
  );
}
