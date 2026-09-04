// LingoPauseMode.tsx
// Pre-learn a YouTube video's vocabulary before watching it.
//
// Four tabs, one per hand-off: read the video → get the vocabulary → get the
// lessons → learn them. Each of the first three ends with a button that copies a
// prompt and advances, so the learner never has to remember which copy button
// they are up to. Tabs stay clickable backwards: re-reading, re-pasting, and
// re-listing are all cheap and all things you want to redo.
//
// **The two big LLM steps run by hand.** Extraction and lesson content are copied
// into a browser chat and pasted back as JSON, which is why each is a copy button
// and a paste box rather than a "generate" button. The one exception is the
// follow-up question box inside the Learn tab (see LessonViewer) — that has to
// answer in place to be worth anything.
//
// Tab 4 is where the learning happens (LessonViewer): guided playback of each
// phrase, blur-then-reveal on the first listen, word-synced highlighting on
// replay, and a jump into the YouTube player at the phrase's own timestamp.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE, localeFor, SLOW_TTS_RATE } from "../config";
import { useAudioPlayer } from "../sharedGameHooks";
import LessonViewer from "./LessonViewer";
import { apiFetch } from "./apiFetch";

type LangSpec = { code: string; name: string };

type Chapter = {
  index: number;
  title: string;
  start: number;
  end: number;
  source: "youtube" | "interval" | "llm";
};

type SessionSummary = {
  video_id: string;
  url: string;
  title: string;
  uploader?: string;
  thumbnail?: string;
  description?: string;
  duration: number;
  chapters?: Chapter[];
  notes?: string;
  stage: string;
  transcript_source?: string;
  transcript_lang?: string | null;
  transcript_is_automatic?: boolean;
  segment_count?: number;
  candidate_count?: number;
  confirmed_count?: number;
};

// `kind` separates a word you don't know from a construction whose words you all
// know but which defeats you at speed ("vamos a estar subiendo"). Provisional
// beyond id/term/kind — the extraction prompt is hand-authored.
type Kind = "word" | "phrase" | "construction";

type Candidate = {
  id: string;
  term: string;
  kind?: Kind;
  gloss_ui?: string;
  first_ts?: number;
  quote?: string;
};

type Lesson = {
  term: string;
  display?: string;
  description?: string;
  definition?: string;
  colloquial_notes?: string;
  example_sentences?: { target: string; english: string }[];
  video_usage?: { target_sentence?: string; english_translation?: string; timestamp_seconds?: number };
};

type TabKey = "video" | "vocab" | "lessons" | "learn";

type Props = {
  fluent: LangSpec;
  learning: LangSpec;
  onBack: () => void;
  apiBase?: string;
};

const TABS: { key: TabKey; label: string; n: number }[] = [
  { key: "video", label: "Video", n: 1 },
  { key: "vocab", label: "Vocabulary", n: 2 },
  { key: "lessons", label: "Lessons", n: 3 },
  { key: "learn", label: "Learn", n: 4 },
];

const KIND_LABEL: Record<Kind, string> = {
  word: "Words",
  phrase: "Phrases & idioms",
  construction: "Constructions",
};

const KIND_HINT: Record<Kind, string> = {
  word: "single words you likely don't know",
  phrase: "set phrases, idioms, collocations",
  construction: "you know every word, but not at speed",
};

const KIND_ORDER: Kind[] = ["construction", "phrase", "word"];

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) {
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

const PANEL: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 12,
  padding: 20,
};

const FIELD: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  fontSize: 15,
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.2)",
  background: "rgba(0,0,0,0.3)",
  color: "#e2e8f0",
  boxSizing: "border-box",
  fontFamily: "inherit",
};

const BTN_SECONDARY: React.CSSProperties = {
  padding: "10px 16px",
  fontSize: 14,
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.2)",
  background: "rgba(255,255,255,0.06)",
  color: "#e2e8f0",
  cursor: "pointer",
};

const BTN_PRIMARY: React.CSSProperties = {
  padding: "12px 22px",
  fontSize: 15,
  fontWeight: 600,
  borderRadius: 8,
  border: "none",
  background: "linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)",
  color: "white",
  cursor: "pointer",
};

export default function LingoPauseMode({ fluent, learning, onBack, apiBase = API_BASE }: Props) {
  const [tab, setTab] = useState<TabKey>("video");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [paste, setPaste] = useState("");
  const [recent, setRecent] = useState<SessionSummary[]>([]);
  // Lesson generation is batched: 100+ full lessons will not fit in one chat reply.
  const [batch, setBatch] = useState<{ offset: number; index: number; count: number; next: number | null } | null>(null);

  const { play, stop } = useAudioPlayer(apiBase);
  const targetLocale = localeFor(learning.code);
  // Ingest is fired from a paste as well as a button, so it has to be safe to call
  // twice for the same URL in quick succession.
  const ingestingRef = useRef<string | null>(null);

  function flash(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 6000);
  }

  const loadRecent = useCallback(async () => {
    try {
      const res = await apiFetch(`${apiBase}/api/lingopause/sessions`);
      if (res.ok) setRecent((await res.json()).sessions || []);
    } catch {
      // A failed list is not worth surfacing — the form still works without it.
    }
  }, [apiBase]);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  const loadLessons = useCallback(async (videoId: string) => {
    try {
      const res = await apiFetch(`${apiBase}/api/lingopause/lessons/${videoId}`);
      if (res.ok) setLessons((await res.json()).lessons || []);
    } catch {
      setLessons([]);
    }
  }, [apiBase]);

  const openSession = useCallback(async (videoId: string, goTo?: TabKey) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`${apiBase}/api/lingopause/session/${videoId}`);
      if (!res.ok) throw new Error((await res.json()).detail || "Could not open that session");
      const body = await res.json();
      setSession(body.session);
      setUrl(body.session.url || "");
      setNotes(body.session.notes || "");
      setCandidates(body.candidates || []);
      // Everything is checked by default: the learner unchecks what they know,
      // which is the smaller job on a list they mostly do not know yet.
      const confirmed: string[] = body.confirmed || [];
      setKept(new Set(confirmed.length ? confirmed : (body.candidates || []).map((c: Candidate) => c.id)));
      await loadLessons(videoId);
      if (goTo) setTab(goTo);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [apiBase, loadLessons]);

  const ingest = useCallback(async (rawUrl: string, force = false) => {
    const target = rawUrl.trim();
    if (!target || (!force && ingestingRef.current === target)) return;
    ingestingRef.current = target;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`${apiBase}/api/lingopause/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target, notes, target_language: learning, force }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || "Could not read that video");
      await openSession(body.session.video_id);
      void loadRecent();
    } catch (e) {
      ingestingRef.current = null;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [apiBase, notes, learning, openSession, loadRecent]);

  async function saveNotes() {
    if (!session || notes === (session.notes || "")) return;
    try {
      const res = await apiFetch(`${apiBase}/api/lingopause/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id: session.video_id, notes }),
      });
      if (res.ok) setSession((await res.json()).session);
    } catch {
      // Notes are re-sent with the next action; a failed save is not worth a modal.
    }
  }

  async function copyBlock(kind: "extraction" | "lessons", advanceTo: TabKey, offset = 0) {
    if (!session) return;
    setError(null);
    await saveNotes();
    try {
      const query = kind === "lessons" ? `&offset=${offset}` : "";
      const res = await apiFetch(`${apiBase}/api/lingopause/export/${session.video_id}?kind=${kind}${query}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || "Could not build that block");
      await navigator.clipboard.writeText(body.text);
      setPaste("");
      setTab(advanceTo);
      if (kind === "lessons") {
        setBatch({ offset, index: body.batch_index, count: body.batch_count, next: body.next_offset });
        flash(
          `Batch ${body.batch_index} of ${body.batch_count} copied (${body.term_count} terms) — ` +
          `run it, paste the JSON back, then copy the next batch`
        );
      } else {
        flash(`Prompt copied (~${body.approx_tokens.toLocaleString()} tokens) — paste it into ChatGPT or Claude`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function importPaste(kind: "candidates" | "lessons") {
    if (!session || !paste.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`${apiBase}/api/lingopause/import/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id: session.video_id, payload: paste }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || "Could not read that paste");
      setPaste("");
      setSession(body.session);
      if (kind === "candidates") {
        setCandidates(body.candidates);
        setKept(new Set(body.candidates.map((c: Candidate) => c.id)));
        flash(`Imported ${body.count} items — uncheck what you already know`);
      } else {
        await loadLessons(session.video_id);
        const { added, upgraded, kept } = body.bank;
        const parts = [
          added ? `${added} new` : "",
          upgraded ? `${upgraded} upgraded` : "",
          kept ? `${kept} already current` : "",
        ].filter(Boolean).join(", ");
        if (batch?.next != null) {
          // More batches to go — stay put and copy the next one rather than
          // sending the learner off to a half-generated lesson set.
          flash(`Batch ${batch.index} of ${batch.count} imported (${parts}) — copying the next batch…`);
          await copyBlock("lessons", "lessons", batch.next);
        } else {
          setBatch(null);
          setTab("learn");
          flash(`Saved ${body.count} lessons (${parts}) — time to learn them`);
        }
      }
      void loadRecent();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmList() {
    if (!session || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`${apiBase}/api/lingopause/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id: session.video_id, keep: Array.from(kept) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || "Could not save your list");
      setSession(body.session);
      void loadRecent();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveAndCopyLessonPrompt() {
    if (await confirmList()) await copyBlock("lessons", "lessons");
  }

  function startOver() {
    stop();
    setSession(null);
    setCandidates([]);
    setKept(new Set());
    setLessons([]);
    setPaste("");
    setBatch(null);
    setUrl("");
    setNotes("");
    setError(null);
    ingestingRef.current = null;
    setTab("video");
  }

  function toggle(id: string) {
    setKept((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const grouped = KIND_ORDER
    .map((kind) => ({ kind, items: candidates.filter((c) => (c.kind || "word") === kind) }))
    .filter((g) => g.items.length > 0);

  const tabEnabled: Record<TabKey, boolean> = {
    video: true,
    vocab: !!session,
    lessons: !!session,
    // Phase 4 needs something to teach, which means a confirmed list.
    learn: !!session && (session.confirmed_count || 0) > 0,
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
      color: "#e2e8f0",
      fontFamily: "system-ui, -apple-system, sans-serif",
      padding: "24px 20px 60px",
    }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
          <button
            onClick={() => (tab === "learn" ? setTab("lessons") : onBack())}
            style={{ ...BTN_SECONDARY, padding: "8px 16px" }}
          >
            ← Back
          </button>
          <div style={{ flex: 1 }}>
            <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0 }}>LingoPause</h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "#94a3b8" }}>
              Learn a video's language before you watch it · {fluent.name} → {learning.name}
            </p>
          </div>
          {session && (
            <button onClick={startOver} style={{ ...BTN_SECONDARY, padding: "8px 14px", fontSize: 13 }}>
              Start over
            </button>
          )}
        </div>

        {/* Stepper — hidden once learning starts; Back steps out of it instead,
            so the whole width belongs to the lesson. */}
        {tab !== "learn" && (
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          {TABS.map((t) => {
            const active = tab === t.key;
            const enabled = tabEnabled[t.key];
            return (
              <button
                key={t.key}
                onClick={() => enabled && setTab(t.key)}
                disabled={!enabled}
                style={{
                  flex: 1,
                  padding: "11px 14px",
                  fontSize: 14,
                  fontWeight: active ? 700 : 500,
                  borderRadius: 10,
                  border: `1px solid ${active ? "rgba(239,68,68,0.6)" : "rgba(255,255,255,0.12)"}`,
                  background: active ? "rgba(239,68,68,0.16)" : "rgba(255,255,255,0.04)",
                  color: enabled ? "#e2e8f0" : "#475569",
                  cursor: enabled ? "pointer" : "default",
                  textAlign: "left",
                }}
              >
                <span style={{ opacity: 0.6, marginRight: 8 }}>{t.n}</span>{t.label}
              </button>
            );
          })}
        </div>
        )}

        {error && (
          <div style={{
            marginBottom: 16, padding: "10px 14px", borderRadius: 8, fontSize: 14,
            background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.4)", color: "#fca5a5",
          }}>
            {error}
          </div>
        )}
        {toast && (
          <div style={{
            marginBottom: 16, padding: "10px 14px", borderRadius: 8, fontSize: 14,
            background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.4)", color: "#6ee7b7",
          }}>
            {toast}
          </div>
        )}

        {/* ---- Tab 1: the video ---- */}
        {tab === "video" && (
          <>
            <div style={{ ...PANEL, marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 8 }}>
                YouTube URL
              </label>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                // Pasting a link is the whole of step 1, so it reads the video by
                // itself rather than making the learner paste and then click.
                onPaste={(e) => {
                  const pasted = e.clipboardData.getData("text");
                  if (pasted.trim()) window.setTimeout(() => void ingest(pasted), 0);
                }}
                onKeyDown={(e) => { if (e.key === "Enter") void ingest(url); }}
                onBlur={() => { if (url.trim() && !session) void ingest(url); }}
                placeholder="Paste a link — it reads the video automatically"
                disabled={busy}
                style={FIELD}
              />

              {busy && !session && (
                <p style={{ fontSize: 13, color: "#94a3b8", margin: "12px 0 0" }}>Reading the video…</p>
              )}

              {session && (
                <div style={{ display: "flex", gap: 16, marginTop: 18, flexWrap: "wrap" }}>
                  {session.thumbnail && (
                    <img
                      src={session.thumbnail}
                      alt=""
                      style={{ width: 200, borderRadius: 8, display: "block", background: "rgba(0,0,0,0.3)" }}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <h2 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 4px" }}>{session.title}</h2>
                    <p style={{ margin: "0 0 12px", fontSize: 13, color: "#94a3b8" }}>
                      {session.uploader}{session.uploader && session.duration ? " · " : ""}
                      {session.duration ? formatTime(session.duration) : ""}
                    </p>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <Tag
                        label={
                          session.transcript_source === "captions"
                            ? `${session.transcript_is_automatic ? "Auto" : "Manual"} captions${session.transcript_lang ? ` (${session.transcript_lang})` : ""}`
                            : session.transcript_source === "whisper"
                              ? "Transcribed from audio"
                              : "No transcript"
                        }
                        tone={session.transcript_source === "none" ? "warn" : "ok"}
                      />
                      <Tag label={`${session.segment_count || 0} lines`} />
                      <Tag label={`${(session.chapters || []).length} chapters`} />
                    </div>
                  </div>
                </div>
              )}

              {session && (session.chapters || []).length > 0 && (
                <details style={{ marginTop: 16 }}>
                  <summary style={{ cursor: "pointer", fontSize: 13, color: "#94a3b8" }}>Chapters</summary>
                  <ol style={{ margin: "10px 0 0", paddingLeft: 20, fontSize: 14, lineHeight: 1.8 }}>
                    {(session.chapters || []).map((c) => (
                      <li key={c.index}>
                        <span style={{ color: "#64748b", marginRight: 8 }}>{formatTime(c.start)}</span>
                        {c.title}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </div>

            {session && (
              <div style={{ ...PANEL, marginBottom: 20 }}>
                <NotesField notes={notes} setNotes={setNotes} onBlur={() => void saveNotes()} disabled={busy} />
                <div style={{ display: "flex", gap: 12, marginTop: 16, alignItems: "center", flexWrap: "wrap" }}>
                  <button onClick={() => void copyBlock("extraction", "vocab")} disabled={busy} style={BTN_PRIMARY}>
                    Copy prompt & continue →
                  </button>
                  <a
                    href={`${apiBase}/api/lingopause/transcript/${session.video_id}.txt`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ ...BTN_SECONDARY, textDecoration: "none", display: "inline-block" }}
                  >
                    Subtitles only
                  </a>
                  <button onClick={() => void ingest(url, true)} disabled={busy} style={BTN_SECONDARY}>
                    Re-read transcript
                  </button>
                </div>
              </div>
            )}

            {recent.length > 0 && (
              <div style={PANEL}>
                <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px", color: "#94a3b8" }}>Recent videos</h3>
                {recent.map((s) => (
                  <div
                    key={s.video_id}
                    style={{
                      display: "flex", gap: 12, alignItems: "center",
                      padding: 8, marginBottom: 6,
                      background: s.video_id === session?.video_id ? "rgba(255,255,255,0.1)" : "transparent",
                      border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8,
                    }}
                  >
                    {/* The row opens straight into the lesson — that is what a
                        finished video is for. Setup stays reachable via Edit. */}
                    <button
                      onClick={() => void openSession(s.video_id, (s.confirmed_count || 0) > 0 ? "learn" : "vocab")}
                      style={{
                        display: "flex", gap: 12, alignItems: "center", flex: 1, minWidth: 0,
                        background: "transparent", border: "none", color: "#e2e8f0",
                        cursor: "pointer", textAlign: "left", padding: 0,
                      }}
                    >
                      {s.thumbnail && <img src={s.thumbnail} alt="" style={{ width: 72, borderRadius: 4, flexShrink: 0 }} />}
                      <span style={{ minWidth: 0 }}>
                        <span style={{ fontSize: 14, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {s.title || s.video_id}
                        </span>
                        <span style={{ display: "block", fontSize: 12, color: "#64748b", marginTop: 2 }}>
                          {(s.confirmed_count || 0) > 0
                            ? `${s.confirmed_count} to learn`
                            : `${s.stage} · ${s.candidate_count || 0} items`}
                        </span>
                      </span>
                    </button>

                    <button
                      onClick={() => void openSession(s.video_id, "video")}
                      title="Edit this video's vocabulary and lessons"
                      style={{ ...BTN_SECONDARY, padding: "6px 12px", fontSize: 12, flexShrink: 0 }}
                    >
                      Edit
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ---- Tab 2: vocabulary ---- */}
        {tab === "vocab" && session && (
          <>
            <div style={{ ...PANEL, marginBottom: 20 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 6px" }}>Paste the result</h3>
              <p style={{ fontSize: 13, color: "#94a3b8", margin: "0 0 14px", lineHeight: 1.6 }}>
                The prompt is on your clipboard. Run it in ChatGPT or Claude, then paste the JSON below.
              </p>
              <textarea
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                rows={4}
                placeholder="Paste the JSON here…"
                style={{ ...FIELD, fontSize: 13, resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
              />
              <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
                <button
                  onClick={() => void importPaste("candidates")}
                  disabled={busy || !paste.trim()}
                  style={{ ...BTN_PRIMARY, opacity: busy || !paste.trim() ? 0.5 : 1 }}
                >
                  Import list
                </button>
                <button onClick={() => void copyBlock("extraction", "vocab")} disabled={busy} style={BTN_SECONDARY}>
                  Copy the prompt again
                </button>
              </div>
            </div>

            {candidates.length > 0 && (
              <div style={{ ...PANEL, marginBottom: 20 }}>
                <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>
                  Uncheck what you already know
                </h3>
                <p style={{ fontSize: 13, color: "#94a3b8", margin: "0 0 16px" }}>
                  {kept.size} of {candidates.length} kept
                </p>

                {grouped.map((group) => (
                  <div key={group.kind} style={{ marginBottom: 20 }}>
                    <div style={{ marginBottom: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#cbd5e1" }}>
                        {KIND_LABEL[group.kind]}
                      </span>
                      <span style={{ fontSize: 12, color: "#64748b", marginLeft: 8 }}>
                        {KIND_HINT[group.kind]}
                      </span>
                    </div>
                    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                      {group.items.map((c) => (
                        <li key={c.id} style={{ padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                            <input
                              type="checkbox"
                              checked={kept.has(c.id)}
                              onChange={() => toggle(c.id)}
                              style={{ marginTop: 4, width: 16, height: 16, cursor: "pointer" }}
                            />
                            <div style={{ flex: 1 }}>
                              <strong style={{ fontSize: 15 }}>{c.term}</strong>
                              {c.gloss_ui && <span style={{ color: "#94a3b8", fontSize: 14 }}> — {c.gloss_ui}</span>}
                              {c.quote && (
                                <span style={{ display: "block", fontSize: 13, color: "#64748b", marginTop: 3 }}>
                                  {typeof c.first_ts === "number" ? `[${formatTime(c.first_ts)}] ` : ""}{c.quote}
                                </span>
                              )}
                            </div>
                            <button
                              onClick={() => void play(c.quote || c.term, targetLocale)}
                              title="Hear it"
                              style={{ ...BTN_SECONDARY, padding: "4px 10px", fontSize: 13 }}
                            >
                              ▶
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}

                <button onClick={() => void saveAndCopyLessonPrompt()} disabled={busy || kept.size === 0} style={BTN_PRIMARY}>
                  Save {kept.size} & copy lesson prompt →
                </button>
              </div>
            )}
          </>
        )}

        {/* ---- Tab 3: lessons ---- */}
        {tab === "lessons" && session && (
          <>
            <div style={{ ...PANEL, marginBottom: 20 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 6px" }}>
                Paste the lessons{batch ? ` · batch ${batch.index} of ${batch.count}` : ""}
              </h3>
              <p style={{ fontSize: 13, color: "#94a3b8", margin: "0 0 14px", lineHeight: 1.6 }}>
                {batch && batch.count > 1
                  ? "Lessons are generated in batches — one chat reply cannot hold them all. Run the copied prompt, paste the JSON, and the next batch copies itself."
                  : "Run the copied prompt in a fresh chat, then paste the JSON below."}
              </p>
              <textarea
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                rows={4}
                placeholder="Paste the JSON here…"
                style={{ ...FIELD, fontSize: 13, resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
              />
              <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
                <button
                  onClick={() => void importPaste("lessons")}
                  disabled={busy || !paste.trim()}
                  style={{ ...BTN_PRIMARY, opacity: busy || !paste.trim() ? 0.5 : 1 }}
                >
                  Import lessons
                </button>
                <button onClick={() => void copyBlock("lessons", "lessons", batch?.offset ?? 0)} disabled={busy} style={BTN_SECONDARY}>
                  Copy {batch && batch.count > 1 ? `batch ${batch.index}` : "the prompt"} again
                </button>
              </div>
            </div>

            {lessons.length > 0 && (
              <div style={{ ...PANEL }}>
                <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 16px" }}>
                  {lessons.length} lesson{lessons.length === 1 ? "" : "s"} for this video
                </h3>
                {lessons.map((lesson) => (
                  <LessonCard
                    key={lesson.term}
                    lesson={lesson}
                    locale={targetLocale}
                    onPlay={(text, slow) => void play(text, targetLocale, slow ? SLOW_TTS_RATE : 0)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ---- Tab 4: learn ---- */}
        {tab === "learn" && session && (
          <LessonViewer videoId={session.video_id} apiBase={apiBase} onProgress={loadRecent} />
        )}
      </div>
    </div>
  );
}

function NotesField({
  notes, setNotes, onBlur, disabled,
}: { notes: string; setNotes: (v: string) => void; onBlur: () => void; disabled?: boolean }) {
  return (
    <>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 8 }}>
        Context notes{" "}
        <span style={{ fontWeight: 400 }}>
          (who's speaking, what it's about, what you want out of it — both prompts read this)
        </span>
      </label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={onBlur}
        rows={3}
        disabled={disabled}
        placeholder="A Mexican chef explaining street food slang. I care about the food words, not the cooking technique."
        style={{ ...FIELD, fontSize: 14, resize: "vertical" }}
      />
    </>
  );
}

function LessonCard({
  lesson, onPlay,
}: { lesson: Lesson; locale: string; onPlay: (text: string, slow?: boolean) => void }) {
  const usage = lesson.video_usage;
  return (
    <div style={{
      padding: "16px 0",
      borderBottom: "1px solid rgba(255,255,255,0.08)",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
        <strong style={{ fontSize: 17 }}>{lesson.display || lesson.term}</strong>
        <button
          onClick={() => onPlay(lesson.display || lesson.term)}
          style={{ ...BTN_SECONDARY, padding: "2px 9px", fontSize: 12 }}
        >
          ▶
        </button>
      </div>

      {(lesson.definition || lesson.description) && (
        <p style={{ margin: "0 0 10px", fontSize: 14, lineHeight: 1.6 }}>
          {lesson.definition || lesson.description}
        </p>
      )}

      {lesson.colloquial_notes && (
        <p style={{
          margin: "0 0 10px", fontSize: 13, lineHeight: 1.6, color: "#fcd34d",
          background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.2)",
          borderRadius: 8, padding: "8px 12px",
        }}>
          {lesson.colloquial_notes}
        </p>
      )}

      {(lesson.example_sentences || []).map((ex, i) => (
        <div key={i} style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span style={{ fontSize: 14 }}>{ex.target}</span>
            <button
              onClick={() => onPlay(ex.target)}
              style={{ ...BTN_SECONDARY, padding: "1px 8px", fontSize: 11 }}
            >
              ▶
            </button>
            <button
              onClick={() => onPlay(ex.target, true)}
              title="Slower"
              style={{ ...BTN_SECONDARY, padding: "1px 8px", fontSize: 11 }}
            >
              🐢
            </button>
          </div>
          <div style={{ fontSize: 13, color: "#94a3b8" }}>{ex.english}</div>
        </div>
      ))}

      {usage?.target_sentence && (
        <div style={{ marginTop: 10, paddingLeft: 12, borderLeft: "2px solid rgba(239,68,68,0.5)" }}>
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 3 }}>
            In the video{typeof usage.timestamp_seconds === "number" ? ` · ${formatTime(usage.timestamp_seconds)}` : ""}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span style={{ fontSize: 14 }}>{usage.target_sentence}</span>
            <button
              onClick={() => onPlay(usage.target_sentence || "")}
              style={{ ...BTN_SECONDARY, padding: "1px 8px", fontSize: 11 }}
            >
              ▶
            </button>
          </div>
          {usage.english_translation && (
            <div style={{ fontSize: 13, color: "#94a3b8" }}>{usage.english_translation}</div>
          )}
        </div>
      )}
    </div>
  );
}

function Tag({ label, tone = "neutral" }: { label: string; tone?: "ok" | "warn" | "neutral" }) {
  const colors = {
    ok: { bg: "rgba(16,185,129,0.15)", fg: "#6ee7b7", border: "rgba(16,185,129,0.4)" },
    warn: { bg: "rgba(251,191,36,0.15)", fg: "#fcd34d", border: "rgba(251,191,36,0.4)" },
    neutral: { bg: "rgba(255,255,255,0.08)", fg: "#94a3b8", border: "rgba(255,255,255,0.15)" },
  }[tone];
  return (
    <span style={{
      padding: "4px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
      background: colors.bg, color: colors.fg, border: `1px solid ${colors.border}`,
    }}>
      {label}
    </span>
  );
}
