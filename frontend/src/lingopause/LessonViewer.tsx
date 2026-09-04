// LessonViewer.tsx
// LingoPause phase 4 — where the learner actually learns a phrase before watching.
//
// One item, presented as a SLIDE DECK — one block per slide, like stepping through
// a presentation. Slides are:
//
//     1. the video's own line, sentence by sentence, the taught one in focus
//     2. things to note (folded away until hovered)
//     3+ one fresh example per slide
//     last. the clip, cued to the line and pausing just after it
//
// A multi-sentence video line is split into English/target sentence PAIRS, played
// one pair at a time — "I won." / "Yo gané." then "The star's going to fall
// there." / "Ahí se va a caer la estrella." — rather than as one long blob. The
// pair that actually contains the phrase is the focus and is set large; the others
// are the run-up and run-off, shown small and dim.
//
// Three rules, all from direct feedback on the first version:
//
//   LESS ON SCREEN. English is visible; the target sentence is behind a button.
//   The previous version showed every line of every beat at once and read a prose
//   explanation aloud, which was "too fast and too much".
//
//   YOU SET THE PACE. Nothing auto-advances past the slide you are on. Two
//   keyboard axes: ← → move between slides within a phrase, shift + ← → jump
//   between phrases, and Enter is "just keep going" (next slide, then the next
//   phrase off the end). Any slide can also be clicked directly, and hovering a
//   line plays just that line.
//
//   NOTES, NOT PROSE. The explanation is 2–4 things to notice, spoken one at a
//   time with a real pause between them.
//
// Audio and video are mutually exclusive: stepping onto a block pauses the
// YouTube player, and playing the clip stops the lesson audio. That coordination
// lives here rather than in either hook, so neither needs to know the other exists.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "../config";
import { useLessonPlayer, type Beat } from "./useLessonPlayer";
import { useYouTubePlayer } from "./useYouTubePlayer";
import { apiFetch } from "./apiFetch";

type Pair = {
  english: string;
  target: string;
  is_focus: boolean;
  en_beat: string | null;
  tg_beat: string | null;
};

type Block = {
  id: string;
  kind: "example" | "notes" | "video";
  label: string;
  pairs?: Pair[];
  from_video?: boolean;
  timestamp_seconds?: number | null;
  end_seconds?: number | null;
  notes?: string[];
  derived?: boolean;
  beats: Beat[];
};

export type LessonItem = {
  id: string;
  term: string;
  kind: "word" | "phrase" | "construction";
  gloss_ui?: string;
  first_ts?: number;
  viewed: boolean;
  has_lesson: boolean;
  derived_audio: boolean;
  blocks: Block[];
};

type Props = {
  videoId: string;
  apiBase?: string;
  onProgress?: () => void;
};

const KIND_BADGE: Record<string, { bg: string; fg: string }> = {
  word: { bg: "rgba(148,163,184,0.15)", fg: "#cbd5e1" },
  phrase: { bg: "rgba(56,189,248,0.15)", fg: "#7dd3fc" },
  construction: { bg: "rgba(239,68,68,0.16)", fg: "#fca5a5" },
};

const PANEL: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 12,
  padding: 20,
};

const BTN: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  borderRadius: 7,
  border: "1px solid rgba(255,255,255,0.2)",
  background: "rgba(255,255,255,0.06)",
  color: "#e2e8f0",
  cursor: "pointer",
};

const BTN_PRIMARY: React.CSSProperties = {
  ...BTN,
  padding: "11px 20px",
  fontSize: 15,
  fontWeight: 600,
  border: "none",
  background: "linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)",
  color: "white",
};

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export default function LessonViewer({ videoId, apiBase = API_BASE, onProgress }: Props) {
  const [items, setItems] = useState<LessonItem[]>([]);
  const [index, setIndex] = useState(0);
  const [blockIndex, setBlockIndex] = useState(0);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const item = items[index];
  const blocks = useMemo(() => item?.blocks || [], [item]);

  const player = useLessonPlayer(apiBase);
  const yt = useYouTubePlayer(videoId);
  const { stop: stopLesson, playBeats, playBeat } = player;
  const { pause: pauseVideo, playAt, cueFrame } = yt;
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`${apiBase}/api/lingopause/beats/${videoId}`);
      if (!res.ok) throw new Error((await res.json()).detail || "Could not load lessons");
      setItems((await res.json()).items || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiBase, videoId]);

  useEffect(() => { void load(); }, [load]);

  // A new phrase starts clean: nothing playing, nothing revealed, back at block 1.
  useEffect(() => {
    stopLesson();
    pauseVideo();
    setBlockIndex(0);
    setShown(new Set());
  }, [index, stopLesson, pauseVideo]);

  /** Step onto a block and play it. The video pauses — never two sources at once. */
  const activate = useCallback((i: number) => {
    const block = blocks[i];
    if (!block) return;
    setBlockIndex(i);
    pauseVideo();
    if (block.kind === "video") {
      stopLesson();
      if (typeof block.timestamp_seconds === "number") {
        playAt(block.timestamp_seconds, block.end_seconds ?? null);
      }
      return;
    }
    // On the video's own line, park the clip on the exact frame where it is said.
    if (block.from_video && typeof block.timestamp_seconds === "number") {
      cueFrame(block.timestamp_seconds);
    }
    void playBeats(block.beats);
  }, [blocks, cueFrame, pauseVideo, playAt, playBeats, stopLesson]);

  async function markViewed() {
    if (!item) return;
    try {
      await apiFetch(`${apiBase}/api/lingopause/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id: videoId, candidate_id: item.id, viewed: true }),
      });
      setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, viewed: true } : it)));
      onProgress?.();
    } catch {
      // Progress is a convenience, not the lesson — not worth interrupting over.
    }
  }

  const nextItem = useCallback(async () => {
    await markViewed();
    setIndex((i) => Math.min(items.length - 1, i + 1));
  }, [items.length, item]); // eslint-disable-line react-hooks/exhaustive-deps

  // Going backwards does not mark anything learned — you are re-checking, not
  // finishing.
  const prevItem = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  // Keyboard. Two axes, deliberately: ← → moves within the phrase you are on,
  // Shift + ← → jumps between phrases. Enter is the "just keep going" key — next
  // slide, and off the end of the last one, on to the next phrase.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;

      if (e.key === "ArrowRight" && e.shiftKey) {
        e.preventDefault();
        void nextItem();
      } else if (e.key === "ArrowLeft" && e.shiftKey) {
        e.preventDefault();
        prevItem();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (blockIndex < blocks.length - 1) activate(blockIndex + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (blockIndex > 0) activate(blockIndex - 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (blockIndex < blocks.length - 1) activate(blockIndex + 1);
        else void nextItem();
      } else if (e.key === "Escape") {
        stopLesson();
        pauseVideo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activate, blockIndex, blocks.length, nextItem, prevItem, stopLesson, pauseVideo]);

  if (loading) return <div style={PANEL}>Loading lessons…</div>;
  if (error) {
    return <div style={{ ...PANEL, borderColor: "rgba(239,68,68,0.4)", color: "#fca5a5" }}>{error}</div>;
  }
  if (items.length === 0) {
    return (
      <div style={PANEL}>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "#94a3b8" }}>
          Nothing to learn yet — confirm a vocabulary list and import its lessons first.
        </p>
      </div>
    );
  }

  const viewedCount = items.filter((i) => i.viewed).length;
  const badge = KIND_BADGE[item?.kind] || KIND_BADGE.word;

  return (
    <div ref={rootRef}>
      {/* Where you are in the set */}
      <div style={{ ...PANEL, marginBottom: 14, padding: "12px 20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 9 }}>
          <span style={{ fontSize: 13, color: "#94a3b8" }}>
            {index + 1} of {items.length} · {viewedCount} learned
          </span>
          <span style={{ fontSize: 12, color: "#64748b" }}>
            ← → slides · shift ← → phrases · enter next · esc stop
          </span>
        </div>
        <div style={{ display: "flex", gap: 3 }}>
          {items.map((it, i) => (
            <button
              key={it.id}
              onClick={() => setIndex(i)}
              title={it.term}
              style={{
                flex: 1, height: 5, borderRadius: 3, border: "none", padding: 0, cursor: "pointer",
                background: i === index ? "#ef4444" : it.viewed ? "rgba(16,185,129,0.7)" : "rgba(255,255,255,0.14)",
              }}
            />
          ))}
        </div>
      </div>

      {/* The phrase */}
      <div style={{ ...PANEL, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ fontSize: 23, fontWeight: 700, margin: 0 }}>{item.term}</h2>
          <span style={{
            padding: "3px 9px", borderRadius: 999, fontSize: 11, fontWeight: 700,
            background: badge.bg, color: badge.fg, textTransform: "uppercase", letterSpacing: 0.4,
          }}>
            {item.kind}
          </span>
          {item.viewed && <span style={{ fontSize: 12, color: "#6ee7b7" }}>✓ learned</span>}
          {item.derived_audio && (
            <span title="Notes were split out of an older prose explanation — regenerate this video's lessons for purpose-written ones"
                  style={{ fontSize: 11, color: "#fcd34d" }}>
              derived notes
            </span>
          )}
        </div>
      </div>

      {!item.has_lesson ? (
        <div style={{ ...PANEL, color: "#fcd34d", fontSize: 14 }}>
          No lesson content for this one yet — generate lessons on the previous tab.
        </div>
      ) : (
        <>
          {/* Slide position */}
          <div style={{ display: "flex", gap: 6, marginBottom: 12, alignItems: "center" }}>
            {blocks.map((b, i) => (
              <button
                key={b.id}
                onClick={() => activate(i)}
                title={b.label}
                style={{
                  width: i === blockIndex ? 22 : 8, height: 8, borderRadius: 4, padding: 0,
                  border: "none", cursor: "pointer", transition: "width 0.2s, background 0.2s",
                  background: i === blockIndex ? "#ef4444" : "rgba(255,255,255,0.2)",
                }}
              />
            ))}
            <span style={{ marginLeft: 8, fontSize: 12, color: "#64748b" }}>
              {blocks[blockIndex]?.label}
            </span>
          </div>

          {/* The current slide */}
          {blocks[blockIndex] && (
            <Slide
              block={blocks[blockIndex]}
              shown={shown.has(blocks[blockIndex].id)}
              activeBeatId={player.activeBeatId}
              highlight={player.highlight}
              onReplay={() => activate(blockIndex)}
              onToggleShown={() =>
                setShown((prev) => {
                  const next = new Set(prev);
                  const id = blocks[blockIndex].id;
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onPlayBeat={(beat) => { pauseVideo(); void playBeat(beat); }}
              videoReady={yt.ready}
            />
          )}

          {(() => {
            const current = blocks[blockIndex];
            const wantsPlayer =
              current && (current.kind === "video" || current.from_video === true);
            return (
              <div style={{
                marginTop: wantsPlayer ? 12 : 0,
                height: wantsPlayer ? undefined : 0,
                overflow: "hidden",
                opacity: wantsPlayer ? 1 : 0,
                transition: "opacity 0.2s",
              }}>
                <div style={{ position: "relative", paddingTop: "56.25%", borderRadius: 8, overflow: "hidden", background: "#000" }}>
                  <div ref={yt.mountRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
                </div>
              </div>
            );
          })()}

          <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
            <button onClick={() => activate(Math.max(0, blockIndex - 1))}
                    disabled={blockIndex === 0}
                    style={{ ...BTN, opacity: blockIndex === 0 ? 0.4 : 1 }}>← Back</button>
            <button onClick={() => activate(blockIndex + 1)}
                    disabled={blockIndex >= blocks.length - 1}
                    style={{ ...BTN, opacity: blockIndex >= blocks.length - 1 ? 0.4 : 1 }}>Next slide →</button>
          </div>
        </>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 14, justifyContent: "flex-end" }}>
        <button onClick={prevItem} disabled={index === 0}
                style={{ ...BTN, opacity: index === 0 ? 0.4 : 1 }}>
          ⇧← Previous phrase
        </button>
        <button onClick={() => void nextItem()} style={BTN_PRIMARY}>
          {index < items.length - 1 ? "Next phrase ⇧→" : "Finish"}
        </button>
      </div>

      <div style={{ marginTop: 14 }}>
        <AskBox videoId={videoId} term={item.term} apiBase={apiBase} />
      </div>
    </div>
  );
}

function Slide({
  block, shown, activeBeatId, highlight, onReplay, onToggleShown, onPlayBeat, videoReady,
}: {
  block: Block;
  shown: boolean;
  activeBeatId: string | null;
  highlight: { beatId: string; wordIndex: number } | null;
  onReplay: () => void;
  onToggleShown: () => void;
  onPlayBeat: (beat: Beat) => void;
  videoReady: boolean;
}) {
  const beatById = useMemo(
    () => Object.fromEntries(block.beats.map((b) => [b.id, b])),
    [block.beats],
  );

  const stage: React.CSSProperties = {
    ...PANEL,
    minHeight: 260,
    padding: "32px 28px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
  };

  if (block.kind === "video") {
    // The player itself is mounted by the viewer and shown just below this slide —
    // it cannot live in here, because switching slides would unmount and destroy it.
    return (
      <div style={{ ...stage, minHeight: 0, padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "#94a3b8" }}>
            {typeof block.timestamp_seconds === "number"
              ? `Rewinds to ${formatTime(Math.max(0, block.timestamp_seconds - 3))} and pauses just after the line`
              : "No timestamp for this phrase"}
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {!videoReady && <span style={{ fontSize: 12, color: "#64748b" }}>player loading…</span>}
            <button onClick={onReplay} style={BTN}>▶ Play the line</button>
          </div>
        </div>
      </div>
    );
  }

  if (block.kind === "notes") {
    // Folded away until hovered: the notes are support, not the thing being
    // learned, and having them permanently open put explanation back on screen.
    return (
      <div style={stage}>
        <NotesCard
          notes={block.notes || []}
          beats={block.beats}
          activeBeatId={activeBeatId}
          highlight={highlight}
          onPlayBeat={onPlayBeat}
          derived={!!block.derived}
        />
      </div>
    );
  }

  const pairs = block.pairs || [];
  return (
    <div style={stage}>
      {pairs.map((pair, i) => {
        const enBeat = pair.en_beat ? beatById[pair.en_beat] : undefined;
        const tgBeat = pair.tg_beat ? beatById[pair.tg_beat] : undefined;
        const focus = pair.is_focus;
        return (
          <div key={i} style={{ marginBottom: i === pairs.length - 1 ? 0 : focus ? 20 : 10 }}>
            <div
              onMouseEnter={() => enBeat && onPlayBeat(enBeat)}
              style={{
                // The taught sentence is the point of the slide; the rest is the
                // run-up and run-off, present for context but visibly secondary.
                fontSize: focus ? 26 : 15,
                fontWeight: focus ? 600 : 400,
                lineHeight: 1.4,
                color: focus
                  ? (enBeat && enBeat.id === activeBeatId ? "#fff" : "#e2e8f0")
                  : "#64748b",
                cursor: "pointer",
              }}
            >
              {enBeat && highlight?.beatId === enBeat.id
                ? <Highlighted text={pair.english} wordIndex={highlight.wordIndex} />
                : pair.english}
            </div>

            {focus && (
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 14 }}>
                <button
                  onMouseEnter={() => tgBeat && onPlayBeat(tgBeat)}
                  onClick={() => tgBeat && onPlayBeat(tgBeat)}
                  style={BTN}
                  disabled={!tgBeat}
                >
                  ▶ Hear it in Spanish
                </button>
                <button onMouseEnter={onToggleShown} onClick={onToggleShown} style={BTN}>
                  {shown ? "Hide Spanish" : "Show Spanish"}
                </button>
              </div>
            )}

            {shown && pair.target && (
              <div
                onMouseEnter={() => tgBeat && onPlayBeat(tgBeat)}
                style={{
                  marginTop: focus ? 14 : 4,
                  fontSize: focus ? 24 : 14,
                  lineHeight: 1.4,
                  color: focus ? "#7dd3fc" : "#475569",
                  cursor: "pointer",
                }}
              >
                {tgBeat && highlight?.beatId === tgBeat.id
                  ? <Highlighted text={pair.target} wordIndex={highlight.wordIndex} />
                  : pair.target}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function NotesCard({
  notes, beats, activeBeatId, highlight, onPlayBeat, derived,
}: {
  notes: string[];
  beats: Beat[];
  activeBeatId: string | null;
  highlight: { beatId: string; wordIndex: number } | null;
  onPlayBeat: (beat: Beat) => void;
  derived: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div
        onMouseEnter={() => setOpen(true)}
        onClick={() => setOpen(true)}
        style={{
          textAlign: "center", padding: "34px 20px", borderRadius: 10, cursor: "pointer",
          border: "1px dashed rgba(255,255,255,0.25)", color: "#94a3b8", fontSize: 15,
        }}
      >
        Things to note — hover to reveal
        <div style={{ fontSize: 12, marginTop: 6, color: "#64748b" }}>
          {notes.length} point{notes.length === 1 ? "" : "s"}
        </div>
      </div>
    );
  }

  return (
    <div onMouseLeave={() => setOpen(false)}>
      <div style={{ fontSize: 11, color: "#fca5a5", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 12 }}>
        Things to note
        {derived && (
          <span title="Split out of an older prose explanation — regenerate this video's lessons for purpose-written notes"
                style={{ marginLeft: 8, color: "#fcd34d", textTransform: "none", letterSpacing: 0 }}>
            derived
          </span>
        )}
      </div>
      <ul style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        {notes.map((note, i) => {
          const beat = beats[i];
          const isActive = beat && beat.id === activeBeatId;
          return (
            <li
              key={i}
              onMouseEnter={() => beat && onPlayBeat(beat)}
              onClick={() => beat && onPlayBeat(beat)}
              style={{
                fontSize: 17, lineHeight: 1.5,
                color: isActive ? "#fff" : "#cbd5e1",
                background: isActive ? "rgba(239,68,68,0.14)" : "transparent",
                borderRadius: 6, padding: "3px 8px", margin: "0 -8px", cursor: "pointer",
              }}
            >
              {beat && highlight?.beatId === beat.id
                ? <Highlighted text={note} wordIndex={highlight.wordIndex} />
                : note}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The word currently being spoken, lit up. Whitespace tokens are kept for spacing
 *  but must not consume a word index, or the highlight drifts right at every gap. */
function Highlighted({ text, wordIndex }: { text: string; wordIndex: number }) {
  const tokens = useMemo(() => text.split(/(\s+)/), [text]);
  let counter = -1;
  return (
    <>
      {tokens.map((token, i) => {
        if (/^\s+$/.test(token)) return <span key={i}>{token}</span>;
        counter += 1;
        return (
          <span
            key={i}
            style={{
              background: counter === wordIndex ? "rgba(239,68,68,0.35)" : "transparent",
              borderRadius: 3,
              transition: "background 0.1s linear",
            }}
          >
            {token}
          </span>
        );
      })}
    </>
  );
}

function AskBox({ videoId, term, apiBase }: { videoId: string; term: string; apiBase: string }) {
  const [thread, setThread] = useState<{ role: "you" | "tutor"; text: string }[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const lastTerm = useRef(term);

  // A new phrase is a new subject; carrying the thread over would attach answers
  // to the wrong term.
  if (lastTerm.current !== term) {
    lastTerm.current = term;
    if (thread.length) setThread([]);
    if (question) setQuestion("");
  }

  async function ask() {
    const asked = question.trim();
    if (!asked || busy) return;
    setBusy(true);
    setQuestion("");
    setThread((t) => [...t, { role: "you", text: asked }]);
    try {
      const res = await apiFetch(`${apiBase}/api/lingopause/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id: videoId, term, question: asked }),
      });
      const body = await res.json();
      setThread((t) => [...t, {
        role: "tutor",
        text: body.ok ? body.answer : (body.error || "Couldn't get an answer just now."),
      }]);
    } catch (e) {
      setThread((t) => [...t, {
        role: "tutor",
        text: e instanceof Error ? e.message : "Couldn't reach the server.",
      }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={PANEL}>
      <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>
        Ask the tutor
      </div>

      {thread.map((turn, i) => (
        <div
          key={i}
          style={{
            marginBottom: 10,
            display: "flex",
            justifyContent: turn.role === "you" ? "flex-end" : "flex-start",
          }}
        >
          <div style={{
            maxWidth: "82%", padding: "10px 13px", borderRadius: 10, fontSize: 14, lineHeight: 1.6,
            background: turn.role === "you" ? "rgba(239,68,68,0.16)" : "rgba(255,255,255,0.05)",
            color: "#e2e8f0",
          }}>
            {turn.text}
          </div>
        </div>
      ))}
      {busy && <div style={{ fontSize: 13, color: "#64748b", marginBottom: 10 }}>thinking…</div>}

      <div style={{ display: "flex", gap: 10 }}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); void ask(); } }}
          placeholder={thread.length ? "Ask another…" : "why is there a se here?"}
          disabled={busy}
          style={{
            flex: 1, padding: "10px 14px", fontSize: 14, borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.2)", background: "rgba(0,0,0,0.3)",
            color: "#e2e8f0", fontFamily: "inherit",
          }}
        />
        <button onClick={() => void ask()} disabled={busy || !question.trim()}
                style={{ ...BTN, opacity: busy || !question.trim() ? 0.5 : 1 }}>
          {busy ? "…" : "Ask"}
        </button>
      </div>
    </div>
  );
}
