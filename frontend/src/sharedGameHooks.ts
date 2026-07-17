// sharedGameHooks.ts
// Shared React hooks used across game modes. Separate from sharedGameComponents
// so that file stays components-only (Fast Refresh requires it).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "./config";

// ── useAudioPlayer ────────────────────────────────────────────────────────────
// Fetch → cache → play → stop for TTS audio. One player per component instance:
// each instance stops only its own audio, so a hover-preview player and a
// turn-playback player can coexist without cutting each other off.
//
//   play(text, locale)  fetches (cached by `locale:text`) and plays.
//   playUrl(url)        plays an already-known URL (e.g. a backend-generated file).
//   prefetch(text, ...) warms the cache so the first play is instant.
//   stop()              halts playback and releases any promise awaiting it.
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

  const fetchUrl = useCallback(async (text: string, locale: string): Promise<string | null> => {
    const key = `${locale}:${text}`;
    const cached = cacheRef.current.get(key);
    if (cached) return cached;
    try {
      const resp = await fetch(`${apiBase}/api/trivia/audio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, locale }),
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

  const prefetch = useCallback((text: string, locale: string) => {
    if (text) void fetchUrl(text, locale);
  }, [fetchUrl]);

  const play = useCallback(async (text: string, locale: string): Promise<boolean> => {
    if (!text) return false;
    const url = await fetchUrl(text, locale);
    if (!url) return false;
    return playUrl(url);
  }, [fetchUrl, playUrl]);

  useEffect(() => stop, [stop]);

  return useMemo(() => ({ play, playUrl, prefetch, stop }), [play, playUrl, prefetch, stop]);
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
