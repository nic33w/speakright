// sharedGameHooks.ts
// Shared React hooks used across game modes. Separate from sharedGameComponents
// so that file stays components-only (Fast Refresh requires it).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "./config";
import { playEarcon, type EarconType } from "./audio/earcons";
import { playHaptic, type HapticPattern } from "./gamepad/haptics";

// ── useAudioPlayer ────────────────────────────────────────────────────────────
// Fetch → cache → play → stop for TTS audio. One player per component instance:
// each instance stops only its own audio, so a hover-preview player and a
// turn-playback player can coexist without cutting each other off.
//
//   play(text, locale, rate?)  fetches (cached by `locale:rate:text`) and plays.
//   playUrl(url)               plays an already-known URL (e.g. a backend-generated file).
//   prefetch(text, ...)        warms the cache so the first play is instant.
//   stop()                     halts playback and releases any promise awaiting it.
//
// `rate` is an SSML prosody percent offset (SLOW_TTS_RATE = -25 is 0.75x, the
// repeat-after-me speed). It is part of both this cache key and the backend's, so
// asking for a sentence slowly never serves the normal-speed rendering.
//
// play/playUrl resolve true when the clip ran to completion (or failed outright),
// and false when stop() cut it short or the fetch failed — so `if (await play(…))`
// is the safe way to chain follow-on state, and a stop never fires it.
//
// Both play() and playUrl() stop this player's current audio first. Audio stops
// automatically on unmount.
export function useAudioPlayer(apiBase: string = API_BASE) {
  const cacheRef = useRef<Map<string, string>>(new Map());
  const currentRef = useRef<HTMLAudioElement | null>(null);
  const pendingResolveRef = useRef<((completed: boolean) => void) | null>(null);

  const stop = useCallback(() => {
    if (currentRef.current) {
      currentRef.current.pause();
      currentRef.current.currentTime = 0;
      currentRef.current = null;
    }
    // Release any awaiter, reporting the clip as interrupted rather than finished.
    if (pendingResolveRef.current) {
      pendingResolveRef.current(false);
      pendingResolveRef.current = null;
    }
  }, []);

  const playUrl = useCallback((url: string): Promise<boolean> => {
    return new Promise<boolean>(resolve => {
      stop();
      const audio = new Audio(url);
      currentRef.current = audio;
      pendingResolveRef.current = resolve;
      const done = () => {
        if (currentRef.current === audio) currentRef.current = null;
        if (pendingResolveRef.current === resolve) pendingResolveRef.current = null;
        resolve(true);
      };
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
    });
  }, [stop]);

  const fetchUrl = useCallback(async (text: string, locale: string, rate: number = 0): Promise<string | null> => {
    const key = `${locale}:${rate}:${text}`;
    const cached = cacheRef.current.get(key);
    if (cached) return cached;
    try {
      const resp = await fetch(`${apiBase}/api/trivia/audio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, locale, rate }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data?.audio_file) return null;
      const url = String(data.audio_file).startsWith("http")
        ? data.audio_file
        : `${apiBase}${data.audio_file}`;
      cacheRef.current.set(key, url);
      return url;
    } catch {
      return null;
    }
  }, [apiBase]);

  const prefetch = useCallback((text: string, locale: string, rate: number = 0) => {
    if (text) void fetchUrl(text, locale, rate);
  }, [fetchUrl]);

  const play = useCallback(async (text: string, locale: string, rate: number = 0): Promise<boolean> => {
    if (!text) return false;
    const url = await fetchUrl(text, locale, rate);
    if (!url) return false;
    return playUrl(url);
  }, [fetchUrl, playUrl]);

  useEffect(() => stop, [stop]);

  return useMemo(() => ({ play, playUrl, prefetch, stop }), [play, playUrl, prefetch, stop]);
}

// ── useReplayStack ────────────────────────────────────────────────────────────
// A flat, ordered list of every audio-bearing item in the session (character
// reply chunks and the user's own corrected sentences), for eyes-free / controller
// history navigation (stepping back through what was just said without looking at
// the screen). Items are pushed once, as audio becomes available — callers must
// not rebuild this by re-scanning message state on every button press, since that
// would re-derive the whole session's audio list on every navigation keypress.
export type ReplayItem = {
  text: string;
  locale: string;
  source: "character" | "user";
  audioUrl: string;
};

// A cursor into `items`, for task 4.3's shoulder-button history navigation
// (LB/RB move the cursor, a separate "play current" action speaks it — the
// simpler of the two designs TASKS.md offered, chosen over the iPod-style
// playback-position split to avoid tracking in-flight playback progress here).
// A ref, not state: nothing renders off it today, and re-rendering the whole
// chat on every shoulder-button tap would be wasted work. `-1` means "track
// the latest item" — the common case, and what push() resets to whenever a
// new turn's audio arrives, so browsing back doesn't silently keep the
// controller's A/Y repeat buttons pinned to a stale sentence once the
// conversation has moved on.
export function useReplayStack() {
  const [items, setItems] = useState<ReplayItem[]>([]);
  const cursorRef = useRef(-1);
  const lengthRef = useRef(0);

  const push = useCallback((item: ReplayItem) => {
    setItems(prev => {
      const next = [...prev, item];
      lengthRef.current = next.length;
      cursorRef.current = -1;
      return next;
    });
  }, []);

  const resolvedIndex = useCallback(() => (cursorRef.current < 0 ? lengthRef.current - 1 : cursorRef.current), []);

  // Silent — per the design notes, LB/RB only move the cursor. Nothing plays
  // until the caller's own "repeat current" action reads current(). Neither
  // touches React state, so tapping a shoulder button doesn't re-render the chat.
  const stepBack = useCallback(() => {
    if (lengthRef.current === 0) return;
    cursorRef.current = Math.max(0, resolvedIndex() - 1);
  }, [resolvedIndex]);

  const stepForward = useCallback(() => {
    if (lengthRef.current === 0) return;
    cursorRef.current = Math.min(lengthRef.current - 1, resolvedIndex() + 1);
  }, [resolvedIndex]);

  const current = useCallback((): ReplayItem | null => {
    if (items.length === 0) return null;
    return items[resolvedIndex()] ?? null;
  }, [items, resolvedIndex]);

  return { items, push, stepBack, stepForward, current };
}

// ── useWisprAutoSend ──────────────────────────────────────────────────────────
// The one implementation of Wispr auto-send (CLAUDE.md "Shared conventions").
//
// Wispr dictation lands as a paste, so a value growth of >= 3 chars in a single
// update is treated as dictation and opens a ~1.5s window before sending, which
// the user can cancel (Esc) — that window is the whole point, and typing never
// auto-sends. A 700ms guard after any send swallows the echo of the send itself.
//
// GameTextarea wraps this with a standard textarea. Modes with their own textarea
// UI call the hook directly and render <AutoSendBar progress={progress} />.
export const AUTO_SEND_WINDOW_MS = 1500;
const AUTO_SEND_MIN_DELTA = 3;
const SEND_GUARD_MS = 700;

export function useWisprAutoSend({
  value,
  onSubmit,
  disabled = false,
  windowMs = AUTO_SEND_WINDOW_MS,
}: {
  value: string;
  onSubmit: (val: string) => void;
  disabled?: boolean;
  // Length of the cancel window. Pass a function to vary it by what was dictated —
  // WordDrill shortens it when the answer already matches, so a correct answer
  // isn't left waiting. Leave it alone unless you have that kind of reason.
  windowMs?: number | ((val: string) => number);
}) {
  const prevLenRef = useRef(0);
  const lastSentRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setPending(false);
    setProgress(null);
  }, []);

  // Records a send that happened outside this hook, so the guard still applies.
  const notifySent = useCallback(() => {
    lastSentRef.current = Date.now();
  }, []);

  const startPending = useCallback((text: string) => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    const duration = typeof windowMs === "function" ? windowMs(text) : windowMs;
    const t0 = Date.now();
    setPending(true);
    setProgress(1.0);
    timerRef.current = setInterval(() => {
      const rem = Math.max(0, 1 - (Date.now() - t0) / duration);
      setProgress(rem);
      if (rem <= 0) {
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        setPending(false);
        setProgress(null);
        if (text.trim()) { lastSentRef.current = Date.now(); onSubmit(text); }
      }
    }, 30);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSubmit]);

  const looksLikeWispr = (val: string) =>
    val.length - prevLenRef.current >= AUTO_SEND_MIN_DELTA &&
    val.length > 2 &&
    Date.now() - lastSentRef.current > SEND_GUARD_MS;

  useEffect(() => {
    cancel();
    if (disabled) return;
    if (looksLikeWispr(value)) startPending(value);
    prevLenRef.current = value.length;
    return cancel;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (disabled) return;
    // Text pasted while disabled left prevLenRef stale — re-check on re-enable.
    if (looksLikeWispr(value)) startPending(value);
    prevLenRef.current = value.length;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  // Manual send (Enter / button): pre-empts any pending window.
  const submit = useCallback(() => {
    if (disabled || !value.trim()) return;
    cancel();
    lastSentRef.current = Date.now();
    onSubmit(value);
  }, [disabled, value, cancel, onSubmit]);

  // Call after clearing the input so the next paste isn't measured against stale length.
  const resetLength = useCallback(() => { prevLenRef.current = 0; }, []);

  return { pending, progress, cancel, submit, notifySent, resetLength };
}

// ── useEarcons ────────────────────────────────────────────────────────────────
// Non-speech audio feedback for game events: recording started/stopped,
// corrections, pass/fail. Wraps earcons.ts playEarcon().
//
// Returns a play() function that accepts an EarconType. Safe to call even if
// Web Audio context creation fails (earcons.ts catches errors silently).
//
// Memoized (useMemo) rather than a fresh object per render: callers use this
// as an effect dependency (e.g. the F13 recording-toggle listener), and an
// unmemoized object would re-subscribe that listener on every render.
export function useEarcons() {
  const play = useCallback((type: EarconType) => {
    void playEarcon(type);
  }, []);

  return useMemo(() => ({ play }), [play]);
}

// ── useHaptics ───────────────────────────────────────────────────────────────
// Controller rumble feedback (task 4.4): recording started, sent, correction
// incoming. Wraps gamepad/haptics.ts playHaptic() — a no-op when no controller
// is connected or it has no rumble motor, so callers never need to check
// `gamepad.connected` first. Memoized for the same reason as useEarcons.
export function useHaptics() {
  const play = useCallback((pattern: HapticPattern) => {
    void playHaptic(pattern);
  }, []);

  return useMemo(() => ({ play }), [play]);
}

// ── useGamepad ────────────────────────────────────────────────────────────────
// Foundation for the Xbox controller work (task 4.1+): polls the Gamepad API
// via requestAnimationFrame (the only way to read live state — there is no
// gamepad "input" event) and reports connection status plus edge-triggered
// button change events (standard-mapping button index, per
// https://w3c.github.io/gamepad/#remapping).
//
// Task 4.1 itself doesn't map any button through this hook — L3/R3 recording
// toggle goes through the native F13 mapper instead, precisely because
// getGamepads() only reports while the document is focused (see TASKS.md
// 4.1). Task 4.2 is the first real consumer: `onButtonChange` drives the
// discrete face buttons (A/B/X/Y — fire once on press), and `onFrame` carries
// the continuous analog state (`axes`, and each button's `value` — not just
// `pressed`) that the stick-flick cancel gesture and the LT hold-to-translate
// gesture need, since both require magnitude/threshold logic across frames
// rather than a single edge. Both callbacks share this one polling loop
// rather than each gesture rolling its own rAF.
export type GamepadButtonChange = { index: number; pressed: boolean };
export type GamepadFrame = {
  buttons: readonly { pressed: boolean; value: number }[];
  axes: readonly number[];
};

export function useGamepad({
  onButtonChange,
  onFrame,
}: {
  onButtonChange?: (e: GamepadButtonChange) => void;
  onFrame?: (frame: GamepadFrame) => void;
} = {}) {
  const [connected, setConnected] = useState(false);
  const prevButtonsRef = useRef<boolean[]>([]);
  const onButtonChangeRef = useRef(onButtonChange);
  const onFrameRef = useRef(onFrame);
  onButtonChangeRef.current = onButtonChange;
  onFrameRef.current = onFrame;

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.getGamepads) return;
    let rafId: number;

    function poll() {
      const pads = navigator.getGamepads();
      const pad = Array.from(pads).find(p => p && p.connected) ?? null;
      setConnected(!!pad);
      if (pad) {
        pad.buttons.forEach((button, index) => {
          if (prevButtonsRef.current[index] !== button.pressed) {
            onButtonChangeRef.current?.({ index, pressed: button.pressed });
          }
          prevButtonsRef.current[index] = button.pressed;
        });
        onFrameRef.current?.({
          buttons: pad.buttons.map(b => ({ pressed: b.pressed, value: b.value })),
          axes: pad.axes,
        });
      } else {
        prevButtonsRef.current = [];
      }
      rafId = requestAnimationFrame(poll);
    }
    rafId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return { connected };
}
