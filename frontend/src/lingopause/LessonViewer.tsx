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
//   YOU SET THE PACE. Nothing auto-advances unless you ask it to. ← → move
//   between slides, ↑ ↓ step clip by clip within one, shift + ← → jump between
//   phrases, Enter is "just keep going", and space runs the whole phrase
//   straight through, advancing slides on its own with a visible countdown
//   between clips. Any slide can also be clicked, and hovering a line plays it.
//
//   NOTES, NOT PROSE. The explanation is 2–4 things to notice, spoken one at a
//   time with a real pause between them.
//
// Audio and video are mutually exclusive: stepping onto a block pauses the
// YouTube player, and playing the clip stops the lesson audio. That coordination
// lives here rather than in either hook, so neither needs to know the other exists.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "../config";
import { useGamepad } from "../sharedGameHooks";
import {
  useLessonPlayer, DEFAULT_PAUSE_MS, MIN_PAUSE_MS, MAX_PAUSE_MS, type Beat,
} from "./useLessonPlayer";
import { useYouTubePlayer } from "./useYouTubePlayer";
import { apiFetch } from "./apiFetch";
import RepeatBack from "./RepeatBack";

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

type Gap = { elapsed: number; total: number; afterBeatId: string | null };

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

// A slide change is a bigger step than the next sentence, so its pause scales up
// with the learner's chosen one rather than being a separate setting to tune.
const SLIDE_GAP_FACTOR = 1.45;

const PAUSE_KEY = "lingopause.pauseMs";

function loadPause(): number {
  try {
    const raw = Number(window.localStorage.getItem(PAUSE_KEY));
    if (Number.isFinite(raw) && raw >= MIN_PAUSE_MS && raw <= MAX_PAUSE_MS) return raw;
  } catch {
    // Private windows and blocked site data both throw here; the default is fine.
  }
  return DEFAULT_PAUSE_MS;
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export default function LessonViewer({ videoId, apiBase = API_BASE, onProgress }: Props) {
  const [items, setItems] = useState<LessonItem[]>([]);
  const [targetLang, setTargetLang] = useState("es");
  const [index, setIndex] = useState(0);
  const [blockIndex, setBlockIndex] = useState(0);
  const [shown, setShown] = useState<Set<string>>(new Set());
  // Which clip within the current slide ↑/↓ are pointing at.
  const [beatIndex, setBeatIndex] = useState(0);
  const [autoPlaying, setAutoPlaying] = useState(false);
  // Bumped to abort a continuous run; the per-clip abort lives in the player hook,
  // but walking from slide to slide is this component's loop.
  const autoRef = useRef(0);
  // How long to wait between clips. Remembered per browser — it is a comfort
  // setting, and re-choosing it every session would be its own annoyance.
  const [pauseMs, setPauseMs] = useState(loadPause);
  // Say-it-back drill (8.14). Off by default: it turns a listening pass into a
  // speaking one, which is a different session.
  const [drill, setDrill] = useState(false);
  // The clip that most recently finished. The drill takes focus off the back of
  // its own sentence rather than on a timer.
  const [lastPlayed, setLastPlayed] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const item = items[index];
  const allBlocks = useMemo(() => item?.blocks || [], [item]);
  // The notes are reference material now, living in the side panel rather than
  // occupying a step of their own — walking through them was more explanation in
  // the main flow than wanted.
  const blocks = useMemo(() => allBlocks.filter((b) => b.kind !== "notes"), [allBlocks]);
  const notesBlock = useMemo(() => allBlocks.find((b) => b.kind === "notes"), [allBlocks]);

  const player = useLessonPlayer(apiBase, pauseMs);
  const yt = useYouTubePlayer(videoId);
  const { stop: stopLesson, playBeats, playBeat, waitWithProgress } = player;
  const { pause: pauseVideo, playAt, cueFrame } = yt;
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`${apiBase}/api/lingopause/beats/${videoId}`);
      if (!res.ok) throw new Error((await res.json()).detail || "Could not load lessons");
      const body = await res.json();
      setItems(body.items || []);
      setTargetLang(body.target_language?.code || "es");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiBase, videoId]);

  useEffect(() => { void load(); }, [load]);

  // A new phrase starts clean: nothing playing, nothing revealed, back at slide 1.
  useEffect(() => {
    stopLesson();
    pauseVideo();
    setBlockIndex(0);
    setBeatIndex(0);
    setShown(new Set());
    setLastPlayed(null);
  }, [index, stopLesson, pauseVideo]);

  // activeBeatId going from a clip back to null means that clip just finished.
  const prevActiveRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevActiveRef.current && !player.activeBeatId) setLastPlayed(prevActiveRef.current);
    prevActiveRef.current = player.activeBeatId;
  }, [player.activeBeatId]);

  // Park the clip on the frame where this phrase is said, whenever such a slide is
  // on screen. Separate from `activate` on purpose: activate also PLAYS, and
  // arriving at a phrase should show the still without anything speaking. Landing
  // does not call activate at all, which is why the frame never appeared before.
  const currentBlock = blocks[blockIndex];
  useEffect(() => {
    if (
      currentBlock &&
      currentBlock.kind === "example" &&
      currentBlock.from_video &&
      typeof currentBlock.timestamp_seconds === "number"
    ) {
      cueFrame(currentBlock.timestamp_seconds);
    }
  }, [currentBlock, cueFrame]);

  /** Step onto a block and play it. The video pauses — never two sources at once. */
  const activate = useCallback((i: number) => {
    const block = blocks[i];
    if (!block) return;
    setBlockIndex(i);
    setBeatIndex(0);
    pauseVideo();
    if (block.kind === "video") {
      stopLesson();
      if (typeof block.timestamp_seconds === "number") {
        playAt(block.timestamp_seconds, block.end_seconds ?? null);
      }
      return;
    }
    // The still is handled by an effect on the current slide; activate only
    // starts audio, so stepping onto a slide does not re-cue a frame already shown.
    void playBeats(block.beats);
  }, [blocks, pauseVideo, playAt, playBeats, stopLesson]);

  const stopEverything = useCallback(() => {
    autoRef.current += 1;
    setAutoPlaying(false);
    stopLesson();
    pauseVideo();
  }, [stopLesson, pauseVideo]);

  /** Play the whole phrase straight through: every clip on every slide, advancing
   *  slides on its own, with a visible pause between clips.
   *
   *  Walks `allBlocks`, not the slides — the notes are not a slide but are still
   *  part of the phrase, and are played in their original position (after the
   *  video's line) whether or not their tab happens to be showing. */
  const playAll = useCallback(async (fromBeat = 0) => {
    autoRef.current += 1;
    const run = autoRef.current;
    setAutoPlaying(true);
    pauseVideo();

    // Start from the slide you are on, so Play resumes rather than restarting.
    const from = allBlocks.findIndex((b) => b.id === blocks[blockIndex]?.id);
    const startAt = from < 0 ? 0 : from;

    for (let i = startAt; i < allBlocks.length; i++) {
      if (run !== autoRef.current) return;
      const block = allBlocks[i];

      if (block.kind !== "notes") {
        const slideAt = blocks.findIndex((b) => b.id === block.id);
        if (slideAt >= 0) setBlockIndex(slideAt);
        setBeatIndex(0);
      }

      if (block.kind === "video") {
        // The clip pauses itself at the end of the line; wait roughly that long
        // rather than leaving the run hanging on an event that may never come.
        if (typeof block.timestamp_seconds === "number") {
          playAt(block.timestamp_seconds, block.end_seconds ?? null);
          const span = (block.end_seconds ?? block.timestamp_seconds + 4) - block.timestamp_seconds;
          if (!(await waitWithProgress((span + 5) * 1000, player.currentRun()))) return;
        }
        continue;
      }

      // Only the slide you start on resumes mid-way; everything after it plays
      // from its own beginning.
      await playBeats(i === startAt ? block.beats.slice(fromBeat) : block.beats);
      if (run !== autoRef.current) return;

      // With the drill on, a slide that has something to say back ends the run
      // there: the box takes focus and waits for you. Carrying on would talk over
      // the answer. Passing it advances; so does stepping on yourself.
      if (drill && block.kind === "example" && (block.pairs || []).some((pr) => pr.is_focus && pr.target)) {
        setAutoPlaying(false);
        return;
      }
      if (i < allBlocks.length - 1) {
        // Between blocks the countdown belongs at the bottom, not beside a line.
        if (!(await waitWithProgress(pauseMs * SLIDE_GAP_FACTOR, player.currentRun()))) return;
      }
    }
    if (run === autoRef.current) setAutoPlaying(false);
  }, [allBlocks, blockIndex, blocks, drill, pauseMs, pauseVideo, playAt, playBeats, waitWithProgress, player]);

  /** Hover-to-hear. Ignored while a continuous run is going, so moving the mouse
   *  does not derail it. */
  const previewBeat = useCallback((beat: Beat) => {
    if (autoPlaying) return;
    // Remember where you were: "Play" resumes from the last thing you heard, not
    // from the top of the slide.
    const at = (blocks[blockIndex]?.beats || []).findIndex((b) => b.id === beat.id);
    if (at >= 0) setBeatIndex(at);
    pauseVideo();
    void playBeat(beat);
  }, [autoPlaying, blockIndex, blocks, pauseVideo, playBeat]);

  /** Leaving a line stops its preview — but only its own, so ending a hover never
   *  cuts off something else that started playing since. */
  const endPreview = useCallback((beat: Beat) => {
    if (autoPlaying) return;
    if (player.activeBeatId === beat.id) stopLesson();
  }, [autoPlaying, player.activeBeatId, stopLesson]);

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
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // Within a slide, step clip by clip — the finest grain of the lesson.
        e.preventDefault();
        const beats = blocks[blockIndex]?.beats || [];
        if (!beats.length) return;
        const next = Math.min(
          beats.length - 1,
          Math.max(0, beatIndex + (e.key === "ArrowDown" ? 1 : -1)),
        );
        setBeatIndex(next);
        pauseVideo();
        void playBeat(beats[next]);
      } else if (e.key === " ") {
        e.preventDefault();
        if (autoPlaying) stopEverything();
        else void playAll(beatIndex);
      } else if (e.key === "Escape") {
        stopEverything();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activate, autoPlaying, beatIndex, blockIndex, blocks, nextItem, playAll, playBeat,
      prevItem, stopEverything, pauseVideo]);

  // --- Controller (standard mapping indices) --------------------------------
  // Mirrors messenger's layout where the two overlap, so muscle memory carries:
  // stick click is still recording, a stick flick is still cancel. Playback is on
  // the face buttons, and the four shoulder inputs are the two navigation axes —
  // bumpers step within a phrase, triggers step between phrases, which matches
  // "nearer button, smaller move".
  const flickArmedRef = useRef(true);
  useGamepad({
    onButtonChange: (e) => {
      if (!e.pressed) return;
      const beats = blocks[blockIndex]?.beats || [];
      const stepBeat = (delta: number) => {
        if (!beats.length) return;
        const next = Math.min(beats.length - 1, Math.max(0, beatIndex + delta));
        setBeatIndex(next);
        previewBeat(beats[next]);
      };
      switch (e.index) {
        // A — play from here, or pause if something is already running.
        case 0:
          if (autoPlaying || player.playing) stopEverything();
          else void playAll(beatIndex);
          break;
        case 2: setBeatIndex(0); void playAll(0); break;     // X — play from the top
        case 4: activate(Math.max(0, blockIndex - 1)); break;             // LB — previous slide
        case 5: activate(Math.min(blocks.length - 1, blockIndex + 1)); break; // RB — next slide
        case 6: prevItem(); break;                           // LT — previous phrase
        case 7: void nextItem(); break;                      // RT — next phrase
        case 12: stepBeat(-1); break;                        // D-pad up — previous clip
        case 13: stepBeat(1); break;                         // D-pad down — next clip
        case 14:                                             // D-pad left — repeat this clip
          if (beats[beatIndex]) previewBeat(beats[beatIndex]);
          break;
        case 15: {                                           // D-pad right — show/hide Spanish
          const block = blocks[blockIndex];
          const focus = (block?.pairs || []).findIndex((pr) => pr.is_focus);
          if (block && focus >= 0) {
            const key = `${block.id}:${focus}`;
            setShown((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            });
          }
          break;
        }
        // L3/R3 (10/11) are deliberately unbound here: the stick click is turned
        // into an F13 keypress by tools/controller/f13_mapper.py and consumed by
        // Wispr, not by this page. It becomes meaningful once the repeat-back
        // drill lands (TASKS.md 8.13).
        default: break;
      }
    },
    onFrame: (frame) => {
      // Stick flick — cancel, with the same hysteresis as messenger: fires once on
      // crossing 0.8 and rearms only below 0.3, or holding the stick out floods.
      const x = Math.max(Math.abs(frame.axes[0] ?? 0), Math.abs(frame.axes[2] ?? 0));
      if (x > 0.8 && flickArmedRef.current) {
        flickArmedRef.current = false;
        stopEverything();
      } else if (x < 0.3) {
        flickArmedRef.current = true;
      }
    },
  });

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
      {/* Where you are in the set — and which phrase, in the space to the right */}
      <div style={{ ...PANEL, marginBottom: 12, padding: "12px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "#94a3b8", whiteSpace: "nowrap", flexShrink: 0 }}>
            {index + 1} of {items.length} · {viewedCount} learned
          </span>

          <span style={{
            fontSize: 17, fontWeight: 700, color: "#e2e8f0",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0,
          }}>
            {item.term}
          </span>
          <span style={{
            padding: "2px 7px", borderRadius: 999, fontSize: 10, fontWeight: 700, flexShrink: 0,
            background: badge.bg, color: badge.fg, textTransform: "uppercase", letterSpacing: 0.4,
          }}>
            {item.kind}
          </span>
          {item.viewed && <span style={{ fontSize: 12, color: "#6ee7b7", flexShrink: 0 }}>✓</span>}
          {item.derived_audio && (
            <span title="Notes were split out of an older prose explanation — regenerate this video's lessons for purpose-written ones"
                  style={{ fontSize: 11, color: "#fcd34d", flexShrink: 0 }}>
              derived
            </span>
          )}

          {/* Shortcuts ride the same line, pushed right; they wrap to their own
              line only when the phrase is long enough to need the room. */}
          <span style={{ flex: 1, minWidth: 0 }} />
          <span style={{ fontSize: 11, color: "#64748b", whiteSpace: "nowrap", flexShrink: 0 }}>
            ← → slide · ↑↓ clip · ⇧← → phrase · space play · esc stop
          </span>
        </div>

        {/* Timeline across the whole set: one tick per phrase, green once learned. */}
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
          </div>

          {/* The current slide, with the clip beside it rather than under it */}
          {(() => {
            const current = blocks[blockIndex];
            const wantsPlayer = !!current && (current.kind === "video" || current.from_video === true);
            return (
              <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 280px", minWidth: 0 }}>
                  {current && (
                    <Slide
                      block={current}
                      shown={shown}
                      activeBeatId={player.activeBeatId}
                      highlight={player.highlight}
                      onReplay={() => activate(blockIndex)}
                      onToggleShown={(key) =>
                        setShown((prev) => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                      onPlayBeat={previewBeat}
                      onEndPreview={endPreview}
                      gap={player.gap}
                      drill={drill}
                      langCode={targetLang}
                      lastPlayed={lastPlayed}
                      onDrillPass={() => {
                        if (blockIndex < blocks.length - 1) activate(blockIndex + 1);
                        else void nextItem();
                      }}
                      videoReady={yt.ready}
                    />
                  )}

                  {/* Navigation sits under the sentences, in their column: slides
                      left, phrases right, mirroring the keyboard (← → versus
                      shift ← →). Rendered even with no slides -- a phrase whose
                      lesson is not generated must still be steppable with the
                      mouse -- and both slide buttons disable themselves then. */}
                  <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <button
                      onClick={() => { setBeatIndex(0); void playAll(0); }}
                      title="Play from the top of this slide (X on a controller)"
                      style={{ ...BTN, padding: "5px 11px", fontSize: 12 }}>
                      ⏮ From top
                    </button>
                    <button
                      onClick={() => (autoPlaying ? stopEverything() : void playAll(beatIndex))}
                      title="Play from where you left off (space, or A on a controller)"
                      style={{ ...BTN, padding: "5px 11px", fontSize: 12,
                               borderColor: autoPlaying ? "rgba(239,68,68,0.6)" : "rgba(255,255,255,0.2)",
                               background: autoPlaying ? "rgba(239,68,68,0.16)" : "rgba(255,255,255,0.06)" }}>
                      {autoPlaying ? "■ Stop" : "▶ Play"}
                    </button>
                    {/* Only the between-block pause lands here; a pause that
                        follows a specific clip is drawn beside that clip instead. */}
                    <GapMeter gap={player.gap?.afterBeatId ? null : player.gap} />
                    <button onClick={() => activate(Math.max(0, blockIndex - 1))}
                            disabled={blockIndex === 0}
                            style={{ ...BTN, padding: "5px 10px", fontSize: 12, opacity: blockIndex === 0 ? 0.4 : 1 }}>←</button>
                    <button onClick={() => activate(blockIndex + 1)}
                            disabled={blockIndex >= blocks.length - 1}
                            style={{ ...BTN, padding: "5px 10px", fontSize: 12, opacity: blockIndex >= blocks.length - 1 ? 0.4 : 1 }}>Next slide →</button>

                    <label
                      title="Say each sentence back and have it checked"
                      style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: drill ? "#6ee7b7" : "#64748b", cursor: "pointer" }}
                    >
                      <input type="checkbox" checked={drill} onChange={(e) => setDrill(e.target.checked)}
                             style={{ accentColor: "#10b981", cursor: "pointer" }} />
                      say it back
                    </label>

                    <PauseSlider
                      value={pauseMs}
                      onChange={(ms) => {
                        setPauseMs(ms);
                        try {
                          window.localStorage.setItem(PAUSE_KEY, String(ms));
                        } catch {
                          // Not persisting is survivable; the session still honours it.
                        }
                      }}
                    />

                    <div style={{ flex: 1 }} />

                    <button onClick={prevItem} disabled={index === 0}
                            style={{ ...BTN, padding: "5px 10px", fontSize: 12, opacity: index === 0 ? 0.4 : 1 }}>⇧←</button>
                    <button onClick={() => void nextItem()}
                            style={{ ...BTN_PRIMARY, padding: "6px 14px", fontSize: 13 }}>
                      {index < items.length - 1 ? "Next phrase ⇧→" : "Finish"}
                    </button>
                  </div>
                </div>

                {/* Right column: the clip, then the tutor / notes panel. The
                    player is mounted exactly once and never unmounted — the IFrame
                    API replaces the element it is given, so remounting per slide
                    would rebuild it every step and lose the parked frame. */}
                <div style={{ flex: "0 0 520px", maxWidth: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{
                    height: wantsPlayer ? undefined : 0,
                    opacity: wantsPlayer ? 1 : 0,
                    overflow: "hidden",
                    transition: "opacity 0.2s",
                  }}>
                    <div style={{ position: "relative", paddingTop: "56.25%", borderRadius: 10, overflow: "hidden", background: "#000" }}>
                      <div ref={yt.mountRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
                    </div>
                  </div>

                  <SidePanel
                    videoId={videoId}
                    term={item.term}
                    apiBase={apiBase}
                    notes={notesBlock}
                    activeBeatId={player.activeBeatId}
                    highlight={player.highlight}
                    onPlayBeat={previewBeat}
                    onEndPreview={endPreview}
                    gap={player.gap}
                    notesPlaying={!!notesBlock?.beats.some((b) => b.id === player.activeBeatId)}
                    onPlayNotes={() => { pauseVideo(); void playBeats(notesBlock?.beats || []); }}
                  />
                </div>
              </div>
            );
          })()}

        </>
      )}

    </div>
  );
}

/** The right column below the clip: ask the tutor, or read the notes.
 *
 *  Tabbed rather than stacked so neither pushes the other off screen. The tutor is
 *  the default because the notes are there to be glanced at, not worked through —
 *  hovering their tab is enough to switch, no click needed. */
function SidePanel({
  videoId, term, apiBase, notes, activeBeatId, highlight, onPlayBeat, onEndPreview, gap, notesPlaying, onPlayNotes,
}: {
  videoId: string;
  term: string;
  apiBase: string;
  notes?: Block;
  activeBeatId: string | null;
  highlight: { beatId: string; wordIndex: number } | null;
  onPlayBeat: (beat: Beat) => void;
  onEndPreview: (beat: Beat) => void;
  gap: Gap | null;
  notesPlaying: boolean;
  onPlayNotes: () => void;
}) {
  const [tab, setTab] = useState<"tutor" | "notes">("tutor");
  const hasNotes = !!notes && (notes.notes || []).length > 0;
  // The notes play as part of a continuous run whether or not their tab is open,
  // so the countdown between them belongs on the tab itself.
  const noteIds = new Set((notes?.beats || []).map((b) => b.id));
  const notesGap = gap && gap.afterBeatId && noteIds.has(gap.afterBeatId) ? gap : null;

  return (
    <div style={{ ...PANEL, padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
        {(["tutor", "notes"] as const).map((key) => {
          if (key === "notes" && !hasNotes) return null;
          const active = tab === key;
          return (
            <button
              key={key}
              onMouseEnter={() => setTab(key)}
              onClick={() => setTab(key)}
              style={{
                flex: 1, padding: "8px 12px", fontSize: 11, fontWeight: active ? 700 : 500,
                border: "none", cursor: "pointer",
                borderBottom: `2px solid ${active ? "#ef4444" : "transparent"}`,
                background: active ? "rgba(239,68,68,0.08)" : "transparent",
                color: active ? "#e2e8f0" : "#64748b",
                textTransform: "uppercase", letterSpacing: 0.4,
                transition: "color 0.15s, background 0.15s",
              }}
            >
              {key === "tutor" ? "Ask the tutor" : "Things to note"}
              {key === "notes" && (notesPlaying || notesGap) && (
                <span style={{ position: "relative", display: "inline-block", width: 0 }}>
                  <GapMeter anchored gap={notesGap} />
                  {notesPlaying && !notesGap && (
                    <span style={{ position: "absolute", left: 8, top: -7, color: "#ef4444", fontSize: 12 }}>♪</span>
                  )}
                </span>
              )}
              {key === "notes" && notes?.derived && (
                <span title="Split out of an older prose explanation — regenerate this video's lessons for purpose-written notes"
                      style={{ marginLeft: 6, color: "#fcd34d", textTransform: "none", letterSpacing: 0 }}>
                  ·
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ padding: 14 }}>
        {tab === "tutor" ? (
          <AskBox videoId={videoId} term={term} apiBase={apiBase} />
        ) : (
          <NotesPanel
            notes={notes?.notes || []}
            beats={notes?.beats || []}
            activeBeatId={activeBeatId}
            highlight={highlight}
            onPlayBeat={onPlayBeat}
            onEndPreview={onEndPreview}
            onPlayAll={onPlayNotes}
          />
        )}
      </div>
    </div>
  );
}

function NotesPanel({
  notes, beats, activeBeatId, highlight, onPlayBeat, onEndPreview, onPlayAll,
}: {
  notes: string[];
  beats: Beat[];
  activeBeatId: string | null;
  highlight: { beatId: string; wordIndex: number } | null;
  onPlayBeat: (beat: Beat) => void;
  onEndPreview: (beat: Beat) => void;
  onPlayAll: () => void;
}) {
  return (
    <div>
      <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 9 }}>
        {notes.map((note, i) => {
          const beat = beats[i];
          const isActive = beat && beat.id === activeBeatId;
          return (
            <li
              key={i}
              onMouseEnter={() => beat && onPlayBeat(beat)}
              onMouseLeave={() => beat && onEndPreview(beat)}
              onClick={() => beat && onPlayBeat(beat)}
              style={{
                fontSize: 14, lineHeight: 1.5,
                color: isActive ? "#fff" : "#cbd5e1",
                background: isActive ? "rgba(239,68,68,0.14)" : "transparent",
                borderRadius: 6, padding: "3px 7px", margin: "0 -7px", cursor: "pointer",
              }}
            >
              {beat && highlight?.beatId === beat.id
                ? <Highlighted text={note} wordIndex={highlight.wordIndex} />
                : note}
            </li>
          );
        })}
      </ul>
      <button onClick={onPlayAll} style={{ ...BTN, marginTop: 10, fontSize: 12 }}>▶ Play all</button>
    </div>
  );
}

function Slide({
  block, shown, activeBeatId, highlight, onReplay, onToggleShown, onPlayBeat, onEndPreview, gap,
  drill, langCode, onDrillPass, lastPlayed, videoReady,
}: {
  block: Block;
  shown: Set<string>;
  activeBeatId: string | null;
  highlight: { beatId: string; wordIndex: number } | null;
  onReplay: () => void;
  onToggleShown: (key: string) => void;
  onPlayBeat: (beat: Beat) => void;
  onEndPreview: (beat: Beat) => void;
  gap: Gap | null;
  drill: boolean;
  langCode: string;
  onDrillPass: () => void;
  lastPlayed: string | null;
  videoReady: boolean;
}) {
  const beatById = useMemo(
    () => Object.fromEntries(block.beats.map((b) => [b.id, b])),
    [block.beats],
  );

  const stage: React.CSSProperties = {
    ...PANEL,
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    // The slide label sits in a corner of this box rather than on a line of its
    // own — it is orientation, not content.
    position: "relative",
  };

  if (block.kind === "video") {
    // The player itself is mounted by the viewer and shown just below this slide —
    // it cannot live in here, because switching slides would unmount and destroy it.
    return (
      <div style={{ ...stage }}>
        <SlideLabel text={block.label} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", paddingRight: 70 }}>
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

  const pairs = block.pairs || [];
  return (
    <div style={{ ...stage, gap: 6, justifyContent: "flex-start" }}>
      <SlideLabel text={block.label} />
      {pairs.map((pair, i) => (
        <SentenceCard
          key={i}
          pair={pair}
          shown={shown.has(`${block.id}:${i}`)}
          onToggleShown={() => onToggleShown(`${block.id}:${i}`)}
          enBeat={pair.en_beat ? beatById[pair.en_beat] : undefined}
          tgBeat={pair.tg_beat ? beatById[pair.tg_beat] : undefined}
          activeBeatId={activeBeatId}
          highlight={highlight}
          onPlayBeat={onPlayBeat}
          onEndPreview={onEndPreview}
          gap={gap}
          drill={drill}
          langCode={langCode}
          onDrillPass={onDrillPass}
          lastPlayed={lastPlayed}
        />
      ))}
    </div>
  );
}

/** One sentence: English, then its own audio and reveal controls.
 *
 *  Every sentence gets these, not just the taught one — the run-up and run-off are
 *  worth hearing in Spanish too, they are simply not what the slide is about. The
 *  focus sentence is set larger; the others are smaller and dimmer until hovered. */
function SentenceCard({
  pair, shown, onToggleShown, enBeat, tgBeat, activeBeatId, highlight, onPlayBeat, onEndPreview, gap,
  drill, langCode, onDrillPass, lastPlayed,
}: {
  pair: Pair;
  shown: boolean;
  onToggleShown: () => void;
  enBeat?: Beat;
  tgBeat?: Beat;
  activeBeatId: string | null;
  highlight: { beatId: string; wordIndex: number } | null;
  onPlayBeat: (beat: Beat) => void;
  onEndPreview: (beat: Beat) => void;
  gap: Gap | null;
  drill: boolean;
  langCode: string;
  onDrillPass: () => void;
  lastPlayed: string | null;
}) {
  const [hover, setHover] = useState(false);
  // Hovering "Show Spanish" reveals it for as long as you are there; clicking pins
  // it so it survives the pointer leaving.
  const [peek, setPeek] = useState(false);
  const focus = pair.is_focus;
  const revealed = shown || peek;
  const speaking = (enBeat && enBeat.id === activeBeatId) || (tgBeat && tgBeat.id === activeBeatId);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        border: `1px solid ${speaking ? "rgba(239,68,68,0.6)" : hover ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.12)"}`,
        background: speaking ? "rgba(239,68,68,0.09)" : hover ? "rgba(255,255,255,0.05)" : "transparent",
        borderRadius: 10,
        padding: focus ? "11px 13px" : "6px 10px",
        transition: "border-color 0.15s, background 0.15s",
      }}
    >
      {/* The card FLIPS rather than growing: revealing the Spanish replaces the
          English in place, so nothing below it moves. Colour carries which side is
          showing — English light, Spanish blue. */}
      <div
        onMouseEnter={() => {
          const beat = revealed ? tgBeat : enBeat;
          if (beat) onPlayBeat(beat);
        }}
        onMouseLeave={() => {
          const beat = revealed ? tgBeat : enBeat;
          if (beat) onEndPreview(beat);
        }}
        style={{
          // Hugs the sentence rather than stretching across the card, so the blank
          // space to its right is not a hover target. Relative so the countdown can
          // sit beside it without being in the flow.
          display: "inline-block",
          position: "relative",
          width: "fit-content",
          maxWidth: "100%",
          fontSize: focus ? 21 : 12,
          fontWeight: focus ? 600 : 400,
          lineHeight: focus ? 1.35 : 1.3,
          color: revealed
            ? (focus ? "#7dd3fc" : "#5b8aa6")
            : (focus ? "#e2e8f0" : hover ? "#cbd5e1" : "#64748b"),
          cursor: "pointer",
          transition: "color 0.15s",
        }}
      >
        {(() => {
          const beat = revealed ? tgBeat : enBeat;
          const text = revealed ? pair.target : pair.english;
          return beat && highlight?.beatId === beat.id
            ? <Highlighted text={text} wordIndex={highlight.wordIndex} />
            : text;
        })()}
        <GapMeter anchored gap={gap?.afterBeatId === (revealed ? tgBeat?.id : enBeat?.id) ? gap : null} />
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: focus ? 9 : 5, flexWrap: "wrap",
                    position: "relative", width: "fit-content" }}>
        <HoverButton
          small={!focus}
          onActivate={() => tgBeat && onPlayBeat(tgBeat)}
          disabled={!tgBeat}
          label="▶ Spanish"
          triggerOnHover
        />
        {/* Hovering peeks at the Spanish; clicking pins it. A plain hover-toggle
            would flip the sentence on and off every time the pointer crossed it. */}
        <HoverButton
          small={!focus}
          onActivate={onToggleShown}
          onHoverChange={setPeek}
          label={shown ? "Show English" : "Show Spanish"}
        />
        {drill && focus && pair.target && (
          <RepeatBack
            target={pair.target}
            langCode={langCode}
            ready={!!tgBeat && lastPlayed === tgBeat.id}
            onPass={onDrillPass}
          />
        )}
        <GapMeter anchored gap={gap?.afterBeatId === tgBeat?.id ? gap : null} />
      </div>
    </div>
  );
}

/** How long to wait between clips. */
function PauseSlider({ value, onChange }: { value: number; onChange: (ms: number) => void }) {
  return (
    <label
      title="Pause between clips"
      style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#64748b" }}
    >
      <span>pause</span>
      <input
        type="range"
        min={MIN_PAUSE_MS}
        max={MAX_PAUSE_MS}
        step={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: 90, accentColor: "#ef4444", cursor: "pointer" }}
      />
      <span style={{ width: 30, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {(value / 1000).toFixed(1)}s
      </span>
    </label>
  );
}

/** The pause between clips, drawn as a draining ring so a silent gap reads as
 *  "wait" rather than "it stopped". */
function GapMeter({ gap, anchored }: { gap: Gap | null; anchored?: boolean }) {
  const size = 18;
  const r = (size - 3) / 2;
  const circumference = 2 * Math.PI * r;
  const left = gap ? Math.max(0, 1 - gap.elapsed / gap.total) : 0;
  if (anchored && !gap) return null;
  return (
    <span style={anchored ? {
      // Out of flow entirely: the countdown appears beside whatever just played
      // without that element changing size or anything around it moving.
      position: "absolute", left: "100%", top: "50%",
      transform: "translateY(-50%)", marginLeft: 8,
      width: size, height: size, pointerEvents: "none",
    } : { width: size, height: size, display: "inline-block", opacity: gap ? 1 : 0, transition: "opacity 0.15s" }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={2} />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke="#ef4444" strokeWidth={2} strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - left)}
        />
      </svg>
    </span>
  );
}

/** The slide's name, tucked into the top-right corner of its box so it costs no
 *  vertical space. */
function SlideLabel({ text }: { text: string }) {
  return (
    <span style={{
      position: "absolute", top: 6, right: 10,
      fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 0.5,
      pointerEvents: "none",
    }}>
      {text}
    </span>
  );
}

/** A button that highlights on hover, and for playback also fires on hover —
 *  hovering is a first-class way to hear something here, not just a visual state.
 *  Anything that toggles must NOT fire on hover. */
function HoverButton({
  label, onActivate, disabled, small, triggerOnHover, onHoverChange,
}: {
  label: string;
  onActivate: () => void;
  disabled?: boolean;
  small?: boolean;
  triggerOnHover?: boolean;
  onHoverChange?: (hovering: boolean) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onMouseEnter={() => {
        setHover(true);
        onHoverChange?.(true);
        if (triggerOnHover && !disabled) onActivate();
      }}
      onMouseLeave={() => { setHover(false); onHoverChange?.(false); }}
      onClick={onActivate}
      disabled={disabled}
      style={{
        ...BTN,
        padding: small ? "3px 9px" : "6px 12px",
        fontSize: small ? 11 : 13,
        opacity: disabled ? 0.4 : 1,
        borderColor: hover && !disabled ? "rgba(239,68,68,0.6)" : "rgba(255,255,255,0.2)",
        background: hover && !disabled ? "rgba(239,68,68,0.14)" : "rgba(255,255,255,0.06)",
        transition: "border-color 0.15s, background 0.15s",
      }}
    >
      {label}
    </button>
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
