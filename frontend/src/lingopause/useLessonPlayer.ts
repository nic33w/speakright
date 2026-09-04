// useLessonPlayer.ts
// Drives one lesson item's playback sequence for LingoPause phase 4.
//
// A lesson is flattened server-side (backend/lesson_audio.py) into an ordered list
// of BEATS — one thing the learner hears, plus the text that goes with it. This
// hook plays them in order and owns the three pieces of state the viewer renders
// from: which beat is sounding, which beats have been revealed, and (on replay
// only) which word is currently being spoken.
//
// Two rules from the spec drive the design:
//
//   NOTHING PLAYS BY ITSELF past the current block. The learner steps with the
//   keyboard; each step plays one block's beats in order. Guided auto-advance
//   through a whole item was tried and was too fast and too much at once.
//
//   WORDS HIGHLIGHT in sync while a clip plays, from Azure WordBoundary timings
//   captured server-side during synthesis and cached next to the clip. Replays are
//   free — the audio and its timings are both content-hash cached.
//
// Highlighting is driven by requestAnimationFrame against the audio element's own
// currentTime, NOT by the shared player's `onProgress` — that rides on `timeupdate`,
// which fires ~4x/second and is visibly behind at word granularity.
import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "../config";
import { apiFetch } from "./apiFetch";

export type WordTiming = { text: string; offsetMs: number; durationMs: number };

export type LanguageRun = { text: string; locale: string; voice: string };

export type Beat = {
  id: string;
  role: string;
  text: string;
  locale: string;
  voice: string;
  // Present on a mixed-language explanation: one entry per language stretch, each
  // spoken by its own voice and stitched server-side.
  runs?: LanguageRun[];
  is_target: boolean;
  target_locale?: string;
  derived?: boolean;
  timestamp_seconds?: number;
};

// Gap between beats inside a block. These are separate thoughts rather than clauses
// of one sentence, so the pause is longer than the 250ms clause break used inside a
// sentence elsewhere in the app. Raised from 700ms after "feels too fast": a note
// needs to land before the next one starts.
const SEGMENT_PAUSE_MS = 1100;

type AudioPayload = { audio_file: string | null; words: WordTiming[] };

export function useLessonPlayer(apiBase: string = API_BASE) {
  const [activeBeatId, setActiveBeatId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<{ beatId: string; wordIndex: number } | null>(null);
  const [playing, setPlaying] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  // Bumped on every stop so an in-flight sequence knows it has been superseded and
  // aborts instead of racing the next one.
  const runRef = useRef(0);
  const cacheRef = useRef<Map<string, AudioPayload>>(new Map());

  const stop = useCallback(() => {
    runRef.current += 1;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setActiveBeatId(null);
    setHighlight(null);
    setPlaying(false);
  }, []);

  useEffect(() => stop, [stop]);

  const fetchBeatAudio = useCallback(async (beat: Beat, withTimings: boolean): Promise<AudioPayload> => {
    // A stitched beat always comes back with timings, so both variants are the
    // same clip — one cache entry, not two.
    const key = `${beat.id}:${beat.runs?.length ? "mixed" : withTimings}`;
    const cached = cacheRef.current.get(key);
    if (cached) return cached;
    try {
      const res = await apiFetch(`${apiBase}/api/lingopause/audio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: beat.text,
          locale: beat.locale,
          voice: beat.voice,
          runs: beat.runs || [],
          with_timings: withTimings,
        }),
      });
      if (!res.ok) return { audio_file: null, words: [] };
      const data = await res.json();
      const payload: AudioPayload = {
        audio_file: data.audio_file ? (String(data.audio_file).startsWith("http") ? data.audio_file : `${apiBase}${data.audio_file}`) : null,
        words: data.words || [],
      };
      cacheRef.current.set(key, payload);
      return payload;
    } catch {
      return { audio_file: null, words: [] };
    }
  }, [apiBase]);

  /** Play one clip to completion. Resolves false if it was stopped or failed. */
  const playClip = useCallback((url: string, beatId: string, words: WordTiming[]): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      const audio = new Audio(url);
      audioRef.current = audio;

      const cleanup = () => {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      };

      audio.onended = () => {
        cleanup();
        setHighlight(null);
        resolve(true);
      };
      audio.onerror = () => {
        cleanup();
        resolve(false);
      };

      if (words.length > 0) {
        // rAF rather than timeupdate: word-level sync needs frame granularity.
        const tick = () => {
          const ms = audio.currentTime * 1000;
          let index = -1;
          for (let i = 0; i < words.length; i++) {
            if (words[i].offsetMs <= ms) index = i;
            else break;
          }
          setHighlight(index >= 0 ? { beatId, wordIndex: index } : null);
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      }

      void audio.play().catch(() => {
        cleanup();
        resolve(false);
      });
    });
  }, []);

  /** Play one beat on its own — a hover preview, or a single button. */
  const playBeat = useCallback(async (beat: Beat) => {
    stop();
    const run = runRef.current;
    setPlaying(true);
    setActiveBeatId(beat.id);
    const { audio_file, words } = await fetchBeatAudio(beat, true);
    if (run !== runRef.current) return;
    if (audio_file) await playClip(audio_file, beat.id, words);
    if (run !== runRef.current) return;
    setActiveBeatId(null);
    setPlaying(false);
  }, [fetchBeatAudio, playClip, stop]);

  /** Play a block's beats in order, with a pause between them. */
  const playBeats = useCallback(async (list: Beat[]) => {
    stop();
    const run = runRef.current;
    if (!list.length) return;
    setPlaying(true);

    for (let i = 0; i < list.length; i++) {
      if (run !== runRef.current) return;
      const beat = list[i];
      setActiveBeatId(beat.id);
      const { audio_file, words } = await fetchBeatAudio(beat, true);
      if (run !== runRef.current) return;
      if (audio_file) await playClip(audio_file, beat.id, words);
      if (run !== runRef.current) return;
      if (i < list.length - 1) {
        await new Promise((r) => setTimeout(r, SEGMENT_PAUSE_MS));
        if (run !== runRef.current) return;
      }
    }

    setActiveBeatId(null);
    setPlaying(false);
  }, [fetchBeatAudio, playClip, stop]);

  return { activeBeatId, highlight, playing, playBeat, playBeats, stop };
}
