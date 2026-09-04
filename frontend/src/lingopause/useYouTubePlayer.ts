// useYouTubePlayer.ts
// Minimal YouTube IFrame Player API wrapper for LingoPause phase 4.
//
// Only what the lesson viewer needs: seek to a phrase's timestamp and play from
// there. Deliberately not a full player abstraction — phase 7 (chapter-based
// interruptions during a full watch-through) will need more, and guessing at its
// shape now would be inventing requirements.
//
// Playback stays inside the YouTube player, per LingoPause's terms posture: the
// video is never downloaded, only controlled.
import { useCallback, useEffect, useRef, useState } from "react";

const API_SRC = "https://www.youtube.com/iframe_api";

// How long to keep playing past the end of the phrase before pausing. Enough to
// hear the line finish and settle rather than being cut off mid-breath.
const TAIL_SECS = 1.6;

// How far to rewind before the phrase. Caption timings are approximate even after
// interpolating within the cue, and landing slightly early is recoverable while
// landing late means missing the thing you came to hear.
const LEAD_SECS = 3;

// The IFrame API is a global singleton with a single global ready callback, so
// loading is tracked module-wide rather than per hook instance — two players on
// one page must not each install their own onYouTubeIframeAPIReady.
let apiPromise: Promise<void> | null = null;

declare global {
  interface Window {
    YT?: {
      Player: new (el: HTMLElement | string, opts: Record<string, unknown>) => YTPlayer;
      PlayerState: { PLAYING: number; PAUSED: number; ENDED: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

type YTPlayer = {
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  getCurrentTime: () => number;
  destroy: () => void;
};

function loadApi(): Promise<void> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<void>((resolve) => {
    if (window.YT?.Player) {
      resolve();
      return;
    }
    // The API calls this global exactly once when it finishes loading.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    if (!document.querySelector(`script[src="${API_SRC}"]`)) {
      const script = document.createElement("script");
      script.src = API_SRC;
      document.head.appendChild(script);
    }
  });
  return apiPromise;
}

export type YouTubeControl = {
  ready: boolean;
  /** Seek to `seconds` (clamped at 0) and play. `lead` backs up a little first, so
   *  the phrase is not already half over when playback starts. When `until` is
   *  given, playback pauses itself shortly after that point. */
  playAt: (seconds: number, until?: number | null, lead?: number) => void;
  pause: () => void;
  mountRef: (el: HTMLDivElement | null) => void;
};

export function useYouTubePlayer(videoId: string | null, onStateChange?: (playing: boolean) => void): YouTubeControl {
  const playerRef = useRef<YTPlayer | null>(null);
  // Interval that watches playback position so the clip can pause itself at the
  // end of the line.
  const watchRef = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  // The mount element is STATE, not a ref, on purpose. The host renders loading and
  // empty states before the player container exists, so an effect keyed only on
  // videoId would run once against a null container, bail, and never re-run —
  // leaving the player silently uninitialized forever. Keying on the element makes
  // the effect fire the moment it actually mounts.
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  // Kept in a ref so re-creating the player does not need the callback in deps.
  const stateChangeRef = useRef(onStateChange);
  stateChangeRef.current = onStateChange;

  const mountRef = useCallback((el: HTMLDivElement | null) => {
    setContainer(el);
  }, []);

  useEffect(() => {
    if (!videoId || !container) return;
    let cancelled = false;

    // The IFrame API REPLACES the element it is handed with an <iframe>. Handing it
    // the React-managed node would destroy a node React still thinks it owns, so it
    // gets a throwaway child instead: React keeps `container`, YouTube consumes the
    // child, and destroy/recreate stays safe.
    const host = document.createElement("div");
    host.style.width = "100%";
    host.style.height = "100%";
    container.appendChild(host);

    void loadApi().then(() => {
      if (cancelled || !window.YT) return;
      playerRef.current = new window.YT.Player(host, {
        videoId,
        playerVars: { rel: 0, modestbranding: 1, playsinline: 1, origin: window.location.origin },
        events: {
          onReady: () => { if (!cancelled) setReady(true); },
          onStateChange: (e: { data: number }) => {
            stateChangeRef.current?.(e.data === window.YT?.PlayerState.PLAYING);
          },
        },
      });
    });

    return () => {
      cancelled = true;
      if (watchRef.current !== null) {
        window.clearInterval(watchRef.current);
        watchRef.current = null;
      }
      setReady(false);
      try {
        playerRef.current?.destroy();
      } catch {
        // The API throws if the iframe is already gone; nothing to recover.
      }
      playerRef.current = null;
      host.remove();
    };
  }, [videoId, container]);

  const playAt = useCallback((seconds: number, until: number | null = null, lead = LEAD_SECS) => {
    const player = playerRef.current;
    if (!player) return;
    if (watchRef.current !== null) {
      window.clearInterval(watchRef.current);
      watchRef.current = null;
    }
    player.seekTo(Math.max(0, seconds - lead), true);
    player.playVideo();

    if (typeof until === "number") {
      // Stop just past the line rather than running on into the rest of the clip.
      // Polled rather than timed from `now`: seeking and buffering mean wall-clock
      // elapsed is not the same as video position.
      const stopAt = until + TAIL_SECS;
      watchRef.current = window.setInterval(() => {
        const player = playerRef.current;
        if (!player) return;
        let at = 0;
        try {
          at = player.getCurrentTime();
        } catch {
          return;
        }
        if (at >= stopAt) {
          player.pauseVideo();
          if (watchRef.current !== null) {
            window.clearInterval(watchRef.current);
            watchRef.current = null;
          }
        }
      }, 120);
    }
  }, []);

  const pause = useCallback(() => {
    if (watchRef.current !== null) {
      window.clearInterval(watchRef.current);
      watchRef.current = null;
    }
    try {
      playerRef.current?.pauseVideo();
    } catch {
      // Player not ready yet — nothing is playing, so nothing to pause.
    }
  }, []);

  return { ready, playAt, pause, mountRef };
}
