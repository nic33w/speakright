// MessengerChat.tsx
// Persona-based adaptive language learning chat with Mateo
import React, { useEffect, useState, useRef, useCallback } from "react";
import { GameTextarea, CorrectionTokens } from "./sharedGameComponents";
import { useAudioPlayer, useReplayStack, useEarcons, useHaptics, useGamepad } from "./sharedGameHooks";
import type { ReplayItem, AudioProgress } from "./sharedGameHooks";
import { API_BASE, localeFor, SLOW_TTS_RATE } from "./config";
import { buildCorrectionTokens, checkFuzzyMatch } from "./sharedGameUtils";
import type { CorrectionToken } from "./sharedGameUtils";
import { PIVOTS } from "./data/sombongo_pivots";
import type { Pivot } from "./data/sombongo_pivots";

type LangSpec = { code: string; name: string };

type UserProfile = {
  level: string;
  level_confidence: number;
  comfortable_with: string[];
  weak_points: string[];
  turn_count: number;
};

type TokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_cents: number;
};

type ResponseChunk = {
  text: string;
  language: "ui" | "target";
  modality: "text" | "audio";
  audio_file?: string;
  reaction_audio_file?: string; // pre-generated persona opener (task 3.2)
  locale?: string;
  purpose?: string;
  native_text?: string;   // v2: translation of challenge chunk
  is_challenge?: boolean; // v2: marks last chunk as learning challenge
};

type SuggestedReply = {
  id: string;
  text_native: string;  // In user's native language
  text_target: string;  // In target language
  audio_file?: string;  // Optional pre-generated audio file path
};

type QuizItem = {
  id: string;
  type: string;
  original: string;
  corrected: string;  // THIS IS THE ANSWER
  error_type: string;
  quiz_prompt: string;  // Question in UI language
  // Support old field names for backwards compatibility
  quiz_question?: string;
  quiz_answer?: string;
  prompt_native?: string;
  prompt_target?: string;
  mastery_level: number;
};

type QuizMessage = {
  id: number;
  quiz: QuizItem;
  userAnswer?: string;
  isCorrect?: boolean;
  feedback?: string;
  isAnswered: boolean;
  answeredAt?: Date;
};

type MessengerMessage = {
  id: number;
  timestamp: Date;
  side: "user" | "character";  // Changed from "mateo" to "character"

  // User side
  userInput?: string;
  correctedInput?: string;
  correctionTokens?: CorrectionToken[];
  hadErrors?: boolean;
  errorExplanation?: string;
  suggestedNative?: string;
  userAudioFile?: string;
  inputIntent?: "english" | "spanish";
  userTranslation?: string;

  // Character's side
  responseChunks?: ResponseChunk[];
  suggestedReplies?: SuggestedReply[];
};

type MessengerChatProps = {
  apiBase?: string;
  fluent?: LangSpec;
  learning?: LangSpec;
  onBack?: () => void;
};

const SESSION_ID = `sess_${Date.now()}`;

const drillButtonStyle: React.CSSProperties = {
  background: 'white',
  border: '1px solid #cbd5e1',
  borderRadius: 10,
  padding: '5px 10px',
  fontSize: 12,
  color: '#0f172a',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

function loadPivotSet(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]); } catch { return new Set(); }
}
function savePivotSet(key: string, s: Set<string>) {
  localStorage.setItem(key, JSON.stringify([...s]));
}

// --- V2 Challenge Pair: 3-zone hover-reveal card (light theme for messenger) ---
// Task 3.14: fixed max-width + a ghost-sizer per zone (an invisible copy of the
// zone's own longest state, stacked in the same grid cell) so toggling a zone's
// reveal changes its content, never its footprint — the previous version had no
// width constraint and swapped a short placeholder for a full sentence, which
// moved both edges of the card. `pending` is new: while true, the zones stay
// mounted (with their ghost sizers, so the card is already at its final size)
// but hidden under a playback-indicator overlay, so there is nothing to read
// along with during a chunk's first listen. Both language zones stay
// hover-gated forever once the overlay lifts — text only shows on request,
// never automatically, even after the clip has played.
function MessengerChallengePair({
  chunk, fluentName, learningName, audioUrl, forceRevealNative, pending,
}: {
  chunk: ResponseChunk;
  fluentName: string;
  learningName: string;
  audioUrl: string | undefined;
  // Task 3.12's post-reveal auto-flash; superseded by 3.13's ephemeral
  // thought line, which no caller wires this to anymore. Left in place —
  // cheap to keep, and the zone it opens (below) is still real, hover-driven
  // UI independent of this prop.
  forceRevealNative?: boolean;
  // Task 3.14: see the block comment above.
  pending?: boolean;
}) {
  const [pinned, setPinned] = useState<Set<"native" | "learning">>(new Set());
  const [hovered, setHovered] = useState<"native" | "learning" | "audio" | null>(null);
  const isHoveringAudio = useRef(false);
  const isLoopRunning = useRef(false);
  // Own player instance: this card's hover-loop must not cut off the turn's chunk playback.
  const audioPlayer = useAudioPlayer();
  // Task 3.14 "what replay looks like": a sweep across the existing, already-
  // text-bearing card rather than hiding it again — this card's own replay
  // loop feeds it, independent of the first-listen `progress` prop below.
  const [replayProgress, setReplayProgress] = useState<AudioProgress | null>(null);

  async function startAudioLoop() {
    if (isLoopRunning.current) return;
    isLoopRunning.current = true;
    await new Promise(r => setTimeout(r, 500));
    while (isHoveringAudio.current) {
      if (!audioUrl) break;
      await audioPlayer.playUrl(audioUrl, setReplayProgress);
      if (!isHoveringAudio.current) break;
      await new Promise(r => setTimeout(r, 700));
    }
    setReplayProgress(null);
    isLoopRunning.current = false;
  }

  function onAudioEnter() {
    setHovered("audio");
    isHoveringAudio.current = true;
    void startAudioLoop();
  }
  function onAudioLeave() {
    setHovered(null);
    isHoveringAudio.current = false;
    audioPlayer.stop();
    setReplayProgress(null);
  }

  function togglePin(zone: "native" | "learning") {
    setPinned(prev => {
      const next = new Set(prev);
      if (next.has(zone)) next.delete(zone); else next.add(zone);
      return next;
    });
  }

  const zoneBase: React.CSSProperties = { padding: "3px 10px", borderRadius: 6, cursor: "pointer", transition: "background 0.15s", display: "flex", alignItems: "center", justifyContent: "space-between", border: "1px solid rgba(0,0,0,0.08)", minHeight: 26 };
  // Ghost-sizer: two children in the same grid cell, one real (visible or not)
  // and one an always-rendered, always-invisible copy of the zone's longest
  // possible content. The cell sizes to the taller/wider of the two, so
  // toggling which one is "the real one" being shown never resizes the zone.
  // gridTemplateColumns: '1fr' pins the track to the zone's own available
  // width (grid's default auto-column would otherwise size to whichever
  // child's unwrapped content is widest) — both children then wrap
  // identically against that same width, which is what keeps the invisible
  // ghost's height a true match for its visible counterpart.
  const ghostStack: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr", width: "100%" };
  const ghostCell: React.CSSProperties = { gridArea: "1 / 1", minWidth: 0, wordBreak: "break-word", overflowWrap: "break-word" };

  // Task 3.13 point 4: replaying a sentence's audio (hovering zone 3) also
  // shows its translation, the settled-bubble equivalent of "show it again"
  // for whoever missed the ephemeral thought the first time.
  const nativeVisible = hovered === "native" || hovered === "audio" || pinned.has("native") || !!forceRevealNative;
  const learningVisible = hovered === "learning" || pinned.has("learning");
  const replayPct = replayProgress?.durationMs ? Math.min(100, (replayProgress.elapsedMs / replayProgress.durationMs) * 100) : null;

  return (
    // position:relative + the pending overlay below: the zones stay mounted
    // underneath (visibility:hidden, not unmounted) so their ghost sizers keep
    // establishing the card's final size even before anything has played —
    // "already at final size" from 3.14's target sequence.
    <div style={{ position: "relative" }}>
      <div style={{ background: "white", borderRadius: 18, padding: "8px 14px", boxShadow: "0 2px 8px rgba(0,0,0,0.15)", border: "2px solid rgba(99,102,241,0.2)", display: "flex", flexDirection: "column", gap: 0, maxWidth: "min(60ch, 85%)", visibility: pending ? "hidden" : "visible" }}>
      {/* Zone 1: native */}
      <div
        style={{
          ...zoneBase,
          background: forceRevealNative
            ? "rgba(99,102,241,0.14)"
            : pinned.has("native") ? "rgba(0,0,0,0.07)" : hovered === "native" ? "rgba(0,0,0,0.05)" : "rgba(0,0,0,0.03)",
          transition: "background 0.3s",
        }}
        onMouseEnter={() => setHovered("native")}
        onMouseLeave={() => setHovered(null)}
        onClick={() => togglePin("native")}
      >
        <div style={ghostStack}>
          <span style={{ ...ghostCell, fontSize: 13, visibility: "hidden" }}>{chunk.native_text || " "}</span>
          <span style={{ ...ghostCell, fontSize: 13, color: "#374151", wordBreak: "break-word" }}>
            {nativeVisible
              ? chunk.native_text
              : <span style={{ fontSize: 12, color: "#9ca3af", fontStyle: "italic" }}>Show {fluentName}</span>
            }
          </span>
        </div>
        {pinned.has("native") && <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 6, flexShrink: 0 }}>📌</span>}
      </div>

      {/* Zone 2: learning */}
      <div
        style={{ ...zoneBase, background: pinned.has("learning") ? "rgba(59,130,246,0.1)" : hovered === "learning" ? "rgba(59,130,246,0.08)" : "rgba(59,130,246,0.04)" }}
        onMouseEnter={() => setHovered("learning")}
        onMouseLeave={() => setHovered(null)}
        onClick={() => togglePin("learning")}
      >
        <div style={ghostStack}>
          <span style={{ ...ghostCell, fontSize: 13, fontWeight: 600, visibility: "hidden" }}>{chunk.text || " "}</span>
          <span style={{ ...ghostCell, fontSize: 13, fontWeight: 600, color: "#3b82f6", wordBreak: "break-word" }}>
            {learningVisible
              ? chunk.text
              : <span style={{ fontSize: 12, color: "#93c5fd", fontStyle: "italic", fontWeight: 400 }}>Show {learningName}</span>
            }
          </span>
        </div>
        {pinned.has("learning") && <span style={{ fontSize: 11, color: "#93c5fd", marginLeft: 6, flexShrink: 0 }}>📌</span>}
      </div>

      {/* Zone 3: audio replay — loops while hovering, sweeping a progress bar */}
      <div
        style={{
          ...zoneBase,
          flexDirection: "column",
          gap: 3,
          background: hovered === "audio" ? "rgba(59,130,246,0.1)" : "rgba(0,0,0,0.03)",
          fontSize: 12,
          color: hovered === "audio" ? "#3b82f6" : "#9ca3af",
          transition: "background 0.2s, color 0.2s",
          userSelect: "none",
        }}
        onMouseEnter={onAudioEnter}
        onMouseLeave={onAudioLeave}
      >
        <span>🔊 {hovered === "audio" ? "replaying…" : "hover to replay"}</span>
        {hovered === "audio" && (
          <div style={{ width: "100%", height: 3, borderRadius: 1.5, overflow: "hidden", background: "rgba(59,130,246,0.15)" }}>
            {replayPct !== null
              ? <div style={{ height: "100%", width: `${replayPct}%`, background: "#3b82f6", transition: "width 120ms linear" }} />
              : <div className="progress-shimmer" style={{ height: "100%", width: "100%" }} />
            }
          </div>
        )}
      </div>
      </div>

      {/* Task 3.15 (revises 3.14's progress sweep): the "still playing" state —
          an opaque overlay over the (already correctly sized, just hidden)
          card above, so there is nothing to read along with during the first
          listen. A canned equalizer, not a duration-driven sweep: a progress
          bar reads as "the app is loading something"; bouncing bars read as
          "someone is speaking" — the conceit is a character talking, not a UI
          fetching content, and that fiction should be strongest right here.
          No Web Audio, no duration tracking — just staggered CSS keyframes,
          identical every time. */}
      {pending && (
        <div style={{ position: "absolute", inset: 0, background: "white", borderRadius: 18, boxShadow: "0 2px 8px rgba(0,0,0,0.15)", border: "2px solid rgba(99,102,241,0.2)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="equalizer-bars">
            <span className="equalizer-bar" style={{ animationDelay: "0s" }} />
            <span className="equalizer-bar" style={{ animationDelay: "0.15s" }} />
            <span className="equalizer-bar" style={{ animationDelay: "0.3s" }} />
            <span className="equalizer-bar" style={{ animationDelay: "0.1s" }} />
            <span className="equalizer-bar" style={{ animationDelay: "0.25s" }} />
          </div>
        </div>
      )}
    </div>
  );
}

export default function MessengerChat({
  apiBase = API_BASE,
  fluent = { code: "en", name: "English" },
  learning = { code: "es", name: "Spanish" },
  onBack,
}: MessengerChatProps) {
  const audioPlayer = useAudioPlayer(apiBase);
  const replayStack = useReplayStack();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [messages, setMessages] = useState<MessengerMessage[]>([]);
  const [transcript, setTranscript] = useState<string>("");
  const [isMockMode, setIsMockMode] = useState<boolean>(false);
  // Active persona's display name, served by /api/config (MESSENGER_PERSONA picks it)
  const [characterName, setCharacterName] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [showLevelUp, setShowLevelUp] = useState<boolean>(false);
  const [newLevel, setNewLevel] = useState<string>("");
  const [currentSuggestions, setCurrentSuggestions] = useState<SuggestedReply[]>([]);
  // Track which suggestions have been revealed (stays visible after hover)
  const [revealedSuggestionIds, setRevealedSuggestionIds] = useState<Set<string>>(new Set());
  // Token usage tracking for the session
  const [sessionTokens, setSessionTokens] = useState<TokenUsage>({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cost_cents: 0
  });
  const [lastTurnTokens, setLastTurnTokens] = useState<TokenUsage | null>(null);

  // Prompt version toggle
  const [promptVersion, setPromptVersion] = useState<"v1" | "v2">("v2");
  const [showUserTranslation, setShowUserTranslation] = useState<boolean>(true);

  // --- Eyes-free mode (screen off: the turn is a serial audio stream) ----------
  // The toggle overrides prompt_version for the turn — see PROMPT_VERSIONS in
  // backend/prompts/messenger_prompt.py. v1/v2 stays remembered underneath, so
  // turning eyes-free off restores whichever the user had.
  const [eyesFree, setEyesFree] = useState<boolean>(false);
  const activeVersion = eyesFree ? "eyesfree" : promptVersion;
  const earcons = useEarcons();
  const haptics = useHaptics();

  // --- Controller → F13 recording toggle (task 4.1) ---------------------------
  // A press-to-toggle click on a controller thumbstick is turned into an F13 tap
  // by the native mapper in tools/controller/ (F13 is a real keycode no app
  // claims, set as Wispr's hotkey). The browser can't send that keystroke itself,
  // but it *does* receive the F13 keydown for free when it has focus — that's the
  // only signal used here, no IPC. `gamepad.connected` is separate: it's the
  // in-page Gamepad API purely for a "controller seen by the browser" status
  // badge, since getGamepads() goes dark exactly when the window loses focus —
  // which is when the F13 signal below matters most.
  const [recording, setRecording] = useState(false);
  const prevTranscriptLenRef = useRef(0);

  // --- Controller per-turn action buttons (task 4.2) ---------------------------
  // A/B/X/Y map onto the same functions the eyes-free keyboard hotkeys already
  // drive (repeatLastAudio/explainDrill — see the Alt+R/Alt+E listener below),
  // plus a slow-repeat and an LT-hold translation. Refs, not state: these are
  // read from rAF-driven gamepad callbacks, not render output, so there's
  // nothing to re-render on and state would just add stale-closure risk.
  //
  // Mirrors GameTextarea's internal useWisprAutoSend state (via the
  // onAutoSendChange prop below) so the stick-flick/B cancel gesture can drive
  // the *existing* pending-send timer instead of running a second one.
  const autoSendStateRef = useRef<{ pending: boolean; cancel: () => void } | null>(null);
  const handleAutoSendChange = useCallback((state: { pending: boolean; cancel: () => void }) => {
    autoSendStateRef.current = state;
  }, []);
  // The most recent v2/eyes-free challenge chunk (the one with `native_text`) —
  // LT-hold speaks its translation, the controller equivalent of hovering the
  // native-language zone of <MessengerChallengePair>. Updated wherever a
  // challenge chunk is revealed (revealChunk, and the pivot flow).
  const lastChallengeChunkRef = useRef<ResponseChunk | null>(null);
  // Stick-flick cancel hysteresis: fires once on crossing the 0.8 deadzone, and
  // won't fire again until the stick has returned below 0.3 — otherwise holding
  // the stick out floods repeat cancels instead of firing once per flick.
  const flickArmedRef = useRef(true);
  // LT hold state, so the translation is spoken once on press and cut off on
  // release rather than replayed every frame the trigger stays down.
  const ltHeldRef = useRef(false);

  const gamepad = useGamepad({
    onButtonChange: (e) => {
      if (!e.pressed) return; // face/shoulder buttons fire on press only
      switch (e.index) {
        case 0: void repeatLastAudio(); break;          // A — repeat last target sentence
        case 1:                                          // B — backup cancel + stop audio
          if (autoSendStateRef.current?.pending) {
            autoSendStateRef.current.cancel();
            earcons.play("sendCancelled");
          }
          audioPlayer.stop();
          break;
        case 2: void explainDrill(); break;               // X — explain that
        case 3: void repeatLastAudioSlow(); break;        // Y — repeat slower (0.75x)
        case 4: replayStack.stepBack(); break;             // LB — replay stack: older
        case 5: replayStack.stepForward(); break;          // RB — replay stack: newer
        // D-pad (task 4.5): session-level settings, not per-turn actions — kept
        // off the face buttons deliberately (see TASKS.md's rationale).
        case 12: setEyesFree(prev => !prev); break;         // D-pad Up — toggle eyes-free
        case 13:                                            // D-pad Down — cycle pairing mode
          setPairingMode(prev =>
            prev === "targetOnly" ? "pairs" : prev === "pairs" ? "alternating" : "targetOnly");
          break;
        case 14:                                            // D-pad Left — change topic / skip
        case 15:                                            // D-pad Right — change topic / skip
          void handlePivot();
          break;
        default: break;
      }
    },
    onFrame: (frame) => {
      // Stick flick: either stick, any direction, past a large deadzone,
      // cancels a pending auto-send. Only does anything while a send is
      // actually pending — outside that window a flick is a no-op, so idle
      // stick movement can't cancel something that isn't happening.
      const [lx = 0, ly = 0, rx = 0, ry = 0] = frame.axes;
      const magnitude = Math.max(Math.hypot(lx, ly), Math.hypot(rx, ry));
      if (magnitude > 0.8 && flickArmedRef.current) {
        flickArmedRef.current = false;
        if (autoSendStateRef.current?.pending) {
          autoSendStateRef.current.cancel();
          earcons.play("sendCancelled");
        }
      } else if (magnitude < 0.3) {
        flickArmedRef.current = true;
      }

      // LT hold: standard-mapping button 6, analog. `pressed` is too sensitive
      // for a deliberate hold gesture, so this thresholds `value` instead.
      const ltValue = frame.buttons[6]?.value ?? 0;
      const ltHeld = ltValue > 0.5;
      if (ltHeld && !ltHeldRef.current) {
        void speakLastChallengeTranslation();
      } else if (!ltHeld && ltHeldRef.current) {
        audioPlayer.stop();
      }
      ltHeldRef.current = ltHeld;
    },
  });

  // A repeat-after-me drill: the correction spoken as "try saying X" instead of
  // drawn as a diff. Only a substantive (severity "major") error opens one.
  type CorrectionDrill = {
    target: string;        // the corrected sentence to say back
    locale: string;
    explanation?: string;  // spoken on demand only — never automatically
    attempt?: string;      // what the user said; set once the drill closes
    skipped?: boolean;
    passed?: boolean;      // scored attempt vs. target (task 3.5); undefined when skipped
  };
  const [drill, setDrill] = useState<CorrectionDrill | null>(null);
  // sendMessage and the hotkey handler both need the drill synchronously, before
  // React has re-rendered with it.
  const drillRef = useRef<CorrectionDrill | null>(null);
  // The character's reply waits here while a drill is open: with the screen off,
  // audio is strictly serial, so the reply would otherwise talk over the
  // correction. Played when the attempt lands.
  const pendingReplyChunksRef = useRef<ResponseChunk[] | null>(null);


  // Feature toggles for realistic chat simulation
  const [streamLetters, setStreamLetters] = useState<boolean>(false);
  // Per-message chunk reveal counts (for progressive bubble-by-bubble appearance)
  const [visibleChunkCounts, setVisibleChunkCounts] = useState<Map<number, number>>(new Map());
  // Task 3.13: the character's pre-verbal "thought" — an ephemeral translation
  // line shown in the message flow (next to the reaction-phase indicator)
  // before a bubble arrives, and again during replay. Supersedes 3.12's
  // in-bubble flash (`flashChunk`/`forceRevealNative`), which is gone: this is
  // the default for every sentence but chunk 0, regardless of `pairingMode`,
  // whenever the screen is on.
  const [thoughtText, setThoughtText] = useState<string | null>(null);
  // Task 3.14: which chunks (keyed `${messageId}-${index}`) are still on their
  // first listen — <MessengerChallengePair> renders those as the empty
  // playback-indicator placeholder (task 3.15: a canned equalizer, not a
  // duration-driven sweep) instead of its normal hover-reveal zones, so
  // there's nothing to read along with. Only the screen-on real-turn path
  // (`revealTurnChunk`) ever populates this — eyes-free and premade chunks
  // never appear in it, so they keep rendering with the plain pre-3.14
  // behavior (see revealChunk).
  const [pendingChunkKeys, setPendingChunkKeys] = useState<Set<string>>(new Set());
  const [audioEnabled, setAudioEnabled] = useState<boolean>(false);
  const [liveReactions, setLiveReactions] = useState<boolean>(true);

  // Audio pairing mode (task 3.6) — how playResponseAudio narrates a turn's chunks:
  //   targetOnly  — only chunks that already carry target-language audio play (today's behavior)
  //   pairs       — target-audio chunks that carry a translation (native_text) speak it first, EN then target
  //   alternating — every chunk gets voiced in whatever language it's actually written in
  //                 (live TTS for ui-language text chunks), with no translation pairing —
  //                 forces unaided comprehension of the target-language parts
  type PairingMode = "targetOnly" | "pairs" | "alternating";
  const [pairingMode, setPairingMode] = useState<PairingMode>("targetOnly");

  // Current reaction phase shown in the typing indicator
  const [reactionPhase, setReactionPhase] = useState<'reading' | 'thinking' | 'typing' | null>(null);
  // Which user message is currently being analyzed (shows pulsing dots while API is in-flight)
  const [processingMsgId, setProcessingMsgId] = useState<number | null>(null);

  // For streaming effect: track which message is currently streaming and its displayed text
  const [streamingMessageId, setStreamingMessageId] = useState<number | null>(null);
  const [streamedText, setStreamedText] = useState<Map<string, string>>(new Map());
  // Typing indicator
  const [isTyping, setIsTyping] = useState<boolean>(false);

  // Quiz system
  const [quizMessages, setQuizMessages] = useState<QuizMessage[]>([]);
  const [quizInputs, setQuizInputs] = useState<Map<string, string>>(new Map());
  const [checkingQuiz, setCheckingQuiz] = useState<string | null>(null);  // quiz id being checked
  const quizAutoSendTimers = useRef<Map<string, number>>(new Map());
  const [quizHistory, setQuizHistory] = useState<QuizMessage[]>([]);  // Answered quizzes
  const [showQuizHistory, setShowQuizHistory] = useState<boolean>(false);

  // Track audio repeat for greeting suggestions - track by suggestion ID to avoid conflicts
  const audioRepeatTimeoutRef = useRef<number | null>(null);
  const currentlyPlayingSuggestionRef = useRef<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const pendingSuggestionRef = useRef<SuggestedReply | null>(null);
  const lastSuggestionsRef = useRef<SuggestedReply[]>([]);
  const suggestionAudioCacheRef = useRef<Map<string, string>>(new Map());
  const busyRef = useRef(false);

  // Pivot shuffle state — cycle through all pivots before repeating
  const pivotShuffleRef = useRef<string[]>([]);
  const pivotCursorRef = useRef<number>(0);

  // Pivot editor state (persisted in localStorage)
  const [showPivotEditor, setShowPivotEditor] = useState(false);
  const [starredPivots, setStarredPivots] = useState<Set<string>>(() => loadPivotSet('pivot_starred'));
  const [dislikedPivots, setDislikedPivots] = useState<Set<string>>(() => loadPivotSet('pivot_disliked'));
  const [deletedPivots, setDeletedPivots] = useState<Set<string>>(() => loadPivotSet('pivot_deleted'));
  const [shownPivots, setShownPivots] = useState<Set<string>>(() => loadPivotSet('pivot_shown'));

  // Initialize profile and fetch greeting suggestions on mount
  useEffect(() => {
    async function initProfile() {
      try {
        const res = await fetch(`${apiBase}/api/messenger/profile`);
        if (res.ok) {
          const data = await res.json();
          setProfile(data.profile);
        } else if (res.status === 404) {
          // Profile doesn't exist, initialize
          const initRes = await fetch(`${apiBase}/api/messenger/profile/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ui_language: fluent,
              target_language: learning
            })
          });
          if (initRes.ok) {
            const data = await initRes.json();
            setProfile(data.profile);
          }
        }
      } catch (e) {
        console.error("Failed to load profile:", e);
      }
    }

    async function fetchGreetingSuggestions() {
      try {
        const res = await fetch(
          `${apiBase}/api/greetings/random?target_lang=${learning.code}&ui_lang=${fluent.code}&count=3`
        );
        if (res.ok) {
          const data = await res.json();
          // Convert greeting format to suggestion format
          const greetings: SuggestedReply[] = (data.greetings || []).map((g: any) => ({
            id: g.id,
            text_native: g.text_native,
            text_target: g.text_target,
            audio_file: g.audio_file  // Include audio file path
          }));
          setCurrentSuggestions(greetings);
        }
      } catch (e) {
        console.error("Failed to fetch greeting suggestions:", e);
      }
    }

    void initProfile();
    void fetchGreetingSuggestions();
  }, [apiBase, fluent, learning]);

  // Fetch config from backend to detect mock mode
  useEffect(() => {
    async function fetchConfig() {
      try {
        const res = await fetch(`${apiBase}/api/config`);
        if (res.ok) {
          const data = await res.json();
          setIsMockMode(data.mock_mode === true);
          // Whoever MESSENGER_PERSONA selects — never hardcode a character name here
          if (data.persona_display_name) setCharacterName(data.persona_display_name);
        }
      } catch (e) {
        console.error("Failed to fetch config:", e);
      }
    }
    void fetchConfig();
  }, [apiBase]);

  // Keep busyRef in sync so the paste handler (closed over once) always sees current state
  useEffect(() => { busyRef.current = busy; }, [busy]);

  // Auto-focus textarea on mount
  useEffect(() => {
    if (textareaRef.current && !busy) {
      textareaRef.current.focus();
    }
  }, [busy]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Auto-scroll when reaction indicator appears so emoji isn't cut off
  useEffect(() => {
    if (reactionPhase !== null && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [reactionPhase]);

  // Auto-scroll when new chunks are revealed or typing indicator toggles
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [visibleChunkCounts, isTyping]);


  // Keep lastSuggestionsRef synced so typed attempts can be matched
  useEffect(() => {
    if (currentSuggestions.length > 0) {
      lastSuggestionsRef.current = currentSuggestions;
    }
  }, [currentSuggestions]);

  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const el = document.activeElement;
      // Let main textarea handle it natively only when it's focused and not disabled
      if (el === textareaRef.current && !busyRef.current) return;
      // Let other inputs (quiz answer fields etc.) handle their own paste
      const tag = (el as HTMLElement)?.tagName;
      if (tag === "INPUT") return;
      const text = e.clipboardData?.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      setTranscript(prev => prev + text);
      // Focus the textarea only if it's currently enabled; otherwise it'll focus when busy clears
      if (!busyRef.current) setTimeout(() => textareaRef.current?.focus(), 0);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  // Eyes-free hotkeys. Alt-modified because dictation lands in the focused
  // textarea — a bare letter key would just be typed. The controller mapping in
  // task 4.2 drives the same two functions.
  //   Alt+R  hear it again (the drill sentence, or the last thing spoken)
  //   Alt+E  explain that (spoken error_explanation; never automatic)
  useEffect(() => {
    if (!eyesFree) return;
    function onKeyDown(e: KeyboardEvent) {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      if (key === "r") { e.preventDefault(); void repeatLastAudio(); }
      else if (key === "e") { e.preventDefault(); void explainDrill(); }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eyesFree, drill, replayStack.items]);

  // Leaving eyes-free mid-drill closes it, or the character's held-back reply
  // would never play.
  useEffect(() => {
    if (!eyesFree && drillRef.current) void finishDrill();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eyesFree]);

  // Wispr itself takes a beat to actually spin up the mic after the hotkey —
  // observed ~1s on the real setup. Firing the indicator/earcon/haptic on the
  // keydown edge made them lie about what the mic was doing, so the *start*
  // side is delayed to match. Stop isn't delayed: Wispr's stop is prompt, and
  // the "real" stop signal (the transcript landing) is already handled by the
  // desync guard below.
  const F13_START_DELAY_MS = 1000;
  // Raw toggle parity from F13 presses — flips synchronously on every press,
  // independent of the delayed `recording` state, so a second press arriving
  // before the delayed start lands still toggles correctly instead of reading
  // a stale `recording` value that hasn't caught up yet.
  const desiredRecordingRef = useRef(false);
  const startTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPendingStart = useCallback(() => {
    if (startTimerRef.current) { clearTimeout(startTimerRef.current); startTimerRef.current = null; }
  }, []);

  // F13 recording toggle (task 4.1). Not eyes-free-gated — it's the general
  // press-to-toggle recording signal from the controller mapper, useful with the
  // screen on too. `e.repeat` guard: the mapper sends a single clean tap per
  // click, but this stays safe if a hold ever leaks through.
  //
  // MODIFIERS ARE DELIBERATELY IGNORED. Real mappers send F13 with modifiers
  // attached — the working local setup sends Ctrl+F13 — and `e.key` is "F13"
  // either way. Do NOT add `!e.ctrlKey` / `!e.altKey` guards here "for
  // correctness": it silently breaks controller recording, and the failure looks
  // like a dead button rather than a code change.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "F13" || e.repeat) return;
      e.preventDefault();
      const next = !desiredRecordingRef.current;
      desiredRecordingRef.current = next;
      clearPendingStart();
      if (next) {
        startTimerRef.current = setTimeout(() => {
          startTimerRef.current = null;
          setRecording(true);
          earcons.play("recordingStarted");
          haptics.play("recordingStarted"); // task 4.4 — only the "on" edge
        }, F13_START_DELAY_MS);
      } else {
        setRecording(false);
        earcons.play("recordingStopped");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearPendingStart();
    };
  }, [earcons, haptics, clearPendingStart]);

  // Desync guard (task 4.1): the app infers recording state purely by counting
  // F13 edges, but Wispr holds the real state — a dropped keypress (e.g. the
  // stop-tap landing while the window was unfocused) leaves `recording` stuck
  // true forever otherwise. Wispr only ever pastes a finished transcript in one
  // shot, so any growth in `transcript` while F13 still thinks it's mid-toggle
  // means recording has in fact already ended; resync (cancelling a pending
  // start too, in case the drop happened inside that window) and fire the stop
  // earcon now, since the edge that should have triggered it never arrived.
  // Gated on `desiredRecordingRef` so plain typing — unrelated to F13 — never
  // touches this; without that gate, normal keystrokes growing `transcript`
  // one character at a time would cancel an in-flight start.
  useEffect(() => {
    const grew = transcript.length > prevTranscriptLenRef.current;
    prevTranscriptLenRef.current = transcript.length;
    if (!grew || !desiredRecordingRef.current) return;
    clearPendingStart();
    desiredRecordingRef.current = false;
    setRecording(prev => {
      if (!prev) return prev;
      earcons.play("recordingStopped");
      return false;
    });
  }, [transcript, earcons, clearPendingStart]);

  // Helper function for delays
  function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function jitter(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  // --- Reaction animation ---------------------------------------------------
  // The reading/thinking/typing beats run *concurrently* with the turn request so
  // they hide real latency instead of stacking on top of it. The moment the response
  // lands the remaining animation is cut short.

  const REACTION_MIN_TOTAL_MS = 900;   // floor, so a fast turn doesn't flicker through three phases
  const REACTION_TYPING_HOLD_MS = 300; // typing must precede the bubble, even when cut short

  type ReactionState = {
    arrived: boolean;
    firstChunkLen: number | null;
    wait: Promise<void>;
    arrive: (firstChunkLen: number) => void;
  };

  function createReactionState(): ReactionState {
    let done!: () => void;
    const wait = new Promise<void>(resolve => { done = resolve; });
    const state: ReactionState = {
      arrived: false,
      firstChunkLen: null,
      wait,
      arrive(firstChunkLen: number) {
        if (state.arrived) return;
        state.arrived = true;
        state.firstChunkLen = firstChunkLen;
        done();
      },
    };
    return state;
  }

  // Sleep that ends early when the response lands.
  function delayOrArrival(ms: number, state: ReactionState): Promise<void> {
    if (state.arrived) return Promise.resolve();
    return Promise.race([delay(ms), state.wait]);
  }

  // Leaves the phase on 'typing' so the indicator stays up while a slow request is
  // still in flight; the caller clears it when the first bubble renders.
  async function runReactionSequence(wordCount: number, state: ReactionState): Promise<void> {
    const started = Date.now();

    // Pre-reading beat: the shimmer on the user's own bubble stands in for "message
    // just landed" — nobody starts reading, let alone typing, at t=0.
    await delay(jitter(200, 400));

    setReactionPhase('reading');
    await delayOrArrival(Math.min(2200, Math.max(700, wordCount * 220)), state);

    if (!state.arrived) {
      // Jittered handoff — identical timing every turn is what reads as a simulation
      await delay(jitter(150, 400));
      setReactionPhase('thinking');
      await delayOrArrival(400 + Math.random() * 300, state);
    }

    setReactionPhase('typing');
    const typingStarted = Date.now();
    // firstChunkLen isn't known until the response arrives — assume a mid-length chunk
    // and let arrival correct it by cutting the wait short.
    const typingMs = Math.min(2800, Math.max(800, (state.firstChunkLen ?? 60) * 38));
    await delayOrArrival(typingMs, state);

    // Never hard-cut from an indicator straight to the bubble: hold 'typing' briefly...
    const heldTyping = Date.now() - typingStarted;
    if (heldTyping < REACTION_TYPING_HOLD_MS) await delay(REACTION_TYPING_HOLD_MS - heldTyping);
    // ...and keep a floor on the whole sequence.
    const total = Date.now() - started;
    if (total < REACTION_MIN_TOTAL_MS) await delay(REACTION_MIN_TOTAL_MS - total);
  }

  function getNextPivot(): Pivot {
    const available = PIVOTS.filter(p => !deletedPivots.has(p.id));
    if (available.length === 0) return PIVOTS[0];
    // Drop any since-deleted IDs from the current queue
    pivotShuffleRef.current = pivotShuffleRef.current.filter(id => !deletedPivots.has(id));
    if (pivotCursorRef.current >= pivotShuffleRef.current.length) {
      const ids = available.map(p => p.id);
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      pivotShuffleRef.current = ids;
      pivotCursorRef.current = 0;
    }
    const nextId = pivotShuffleRef.current[pivotCursorRef.current++];
    return PIVOTS.find(p => p.id === nextId) ?? available[0];
  }

  function toggleStar(id: string) {
    setStarredPivots(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      savePivotSet('pivot_starred', next);
      return next;
    });
  }

  function toggleDislike(id: string) {
    setDislikedPivots(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      savePivotSet('pivot_disliked', next);
      return next;
    });
  }

  function deletePivot(id: string) {
    setDeletedPivots(prev => {
      const next = new Set(prev);
      next.add(id);
      savePivotSet('pivot_deleted', next);
      return next;
    });
  }

  async function handlePivot() {
    if (busy) return;
    const pivot = getNextPivot();
    setShownPivots(prev => {
      const next = new Set(prev);
      next.add(pivot.id);
      savePivotSet('pivot_shown', next);
      return next;
    });
    setBusy(true);
    setIsTyping(true);

    await delay(1500);
    setIsTyping(false);

    const charMsgId1 = Date.now();
    setMessages(prev => [...prev, {
      id: charMsgId1,
      timestamp: new Date(),
      side: "character",
      responseChunks: [{ text: pivot.opening_message, language: "ui" as const, modality: "text" as const }],
    }]);

    await delay(800);
    setIsTyping(true);

    const locale = localeFor(learning.code);
    const audioPath = await fetchAudioUrl(pivot.audio_message, locale);

    await delay(700);
    setIsTyping(false);

    const charMsgId2 = Date.now();
    const pivotChunk: ResponseChunk = {
      text: pivot.audio_message,
      language: "target" as const,
      modality: "audio" as const,
      audio_file: audioPath ?? undefined,
      locale,
      native_text: pivot.audio_message_translation,
    };
    if (pivotChunk.native_text) lastChallengeChunkRef.current = pivotChunk;
    setMessages(prev => [...prev, {
      id: charMsgId2,
      timestamp: new Date(),
      side: "character",
      responseChunks: [pivotChunk],
    }]);

    if (audioPath) {
      replayStack.push({ text: pivot.audio_message, locale, source: "character", audioUrl: `${apiBase}${audioPath}` });
      await audioPlayer.playUrl(`${apiBase}${audioPath}`);
    }

    setCurrentSuggestions(pivot.quick_replies);
    setRevealedSuggestionIds(new Set());

    setBusy(false);
  }

  // Delay before revealing the next chunk — proportional to text length, simulating typing time
  function chunkRevealDelay(text: string): number {
    return Math.min(3500, Math.max(900, text.length * 55));
  }

  // Pause after a chunk appears so user can read it before the writing icon shows
  function readingDelay(text: string): number {
    return Math.min(2500, Math.max(600, text.length * 35));
  }

  async function fetchAudioUrl(text: string, locale: string): Promise<string | null> {
    try {
      const res = await fetch(`${apiBase}/api/trivia/audio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, locale }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.audio_file as string;
    } catch {
      return null;
    }
  }

  // Helper function to stream text letter by letter
  async function streamText(messageId: number, chunkIndex: number, fullText: string): Promise<void> {
    const key = `${messageId}-${chunkIndex}`;
    for (let i = 0; i <= fullText.length; i++) {
      setStreamedText(prev => new Map(prev).set(key, fullText.slice(0, i)));
      await delay(25); // 25ms per character
    }
  }

  // Shape of /api/messenger/turn (and the "final" event of its streaming twin).
  type TurnPayload = {
    turn_id?: string;
    corrected_input?: string;
    user_translation?: string | null;
    had_errors?: boolean;
    error_severity?: "none" | "minor" | "major";
    error_explanation?: string;
    input_intent?: "english" | "spanish";
    response_chunks?: ResponseChunk[];
    suggested_replies?: SuggestedReply[];
    profile_updated?: boolean;
    new_level?: string | null;
    token_usage?: TokenUsage | null;
    pending_quiz?: QuizItem | null;
  };

  // NDJSON events from /api/messenger/turn/stream.
  type StreamEvent =
    | { type: "chunk"; index: number; chunk: ResponseChunk }
    | { type: "audio"; index: number }
    | { type: "fallback" }
    | { type: "error"; chunks_emitted: number }
    | ({ type: "final" } & TurnPayload);

  // Reads an NDJSON stream, invoking onEvent once per complete line. onEvent is
  // awaited, so a slow handler (revealing a bubble takes seconds) applies
  // backpressure rather than dropping events.
  async function readNdjson(res: Response, onEvent: (e: StreamEvent) => Promise<void> | void): Promise<void> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("response has no readable body");
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) await onEvent(JSON.parse(line));
      }
    }
    const tail = buf.trim();
    if (tail) await onEvent(JSON.parse(tail));
  }

  function isCasualGreeting(text: string): boolean {
    const norm = text
      .toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[¿¡.,!?;:"""'']/g, "")
      .replace(/\s+/g, " ").trim();
    const casuals = [
      "hola", "hey", "hi", "hello", "sup", "yo", "ey", "howdy",
      "buenas", "buenos dias", "buenas tardes", "buenas noches",
      "que tal", "como estas", "como te va", "como estan",
      "que hay", "que pasa", "que onda",
      "whats up", "what up", "how are you", "how are you doing",
      "hola como estas", "hola que tal",
    ];
    return casuals.includes(norm);
  }

  async function sendMessage(textOverride?: string) {
    const text = (textOverride ?? transcript).trim();
    if (!text || busy) return;

    // An open drill swallows the next thing you say: it's a repeat-after-me rep,
    // not a conversational turn, so it never reaches the LLM.
    if (drillRef.current) {
      await finishDrill(text);
      return;
    }
    setDrill(null);  // clear the finished drill's banner

    setBusy(true);
    haptics.play("sent"); // task 4.4 — drill attempts go through finishDrill above, not here
    const userMsgId = Date.now();

    // Detect if text matches a suggested reply (click path or typed-match path)
    let matchedNative: string | undefined;
    if (pendingSuggestionRef.current) {
      matchedNative = pendingSuggestionRef.current.text_native;
      pendingSuggestionRef.current = null;
    } else {
      const norm = (s: string) =>
        s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
         .replace(/[¿¡.,!?;:"""'']/g, "").replace(/\s+/g, " ").trim();
      const normText = norm(text);
      const match = lastSuggestionsRef.current.find(s => norm(s.text_target) === normText);
      if (match) matchedNative = match.text_native;
    }

    // IMMEDIATELY show user's message (before API call)
    const pendingUserMsg: MessengerMessage = {
      id: userMsgId,
      timestamp: new Date(),
      side: "user",
      userInput: text,
      hadErrors: false, // Will update after API response
      suggestedNative: matchedNative,
    };
    setMessages((prev) => [...prev, pendingUserMsg]);
    setProcessingMsgId(userMsgId);

    // Clear textarea right away
    setTranscript("");

    try {
      // Determine endpoint: use premade-start only when user picked a suggestion or typed a casual greeting
      const hasCharacterMessages = messages.some(m => m.side === "character");
      const isFirstMessage = !hasCharacterMessages;
      const usedSuggestion = matchedNative !== undefined;
      const usePremade = !isFirstMessage || usedSuggestion || isCasualGreeting(text);

      const usePremadeEndpoint = isFirstMessage && usePremade;

      // Start the reaction animation concurrently with the request so real latency
      // is hidden behind it instead of stacking after it (firstChunkLen is corrected on arrival).
      const wordCount = text.trim().split(/\s+/).length;
      const reactionState = liveReactions ? createReactionState() : null;
      const reactionPromise = reactionState ? runReactionSequence(wordCount, reactionState) : null;

      const characterMsgId = Date.now() + 1;
      let characterCreated = false;
      let shownCount = 0;
      let lastChunkText = '';
      let userAudioFile: string | undefined;
      let userAudioPromise: Promise<void> = Promise.resolve();

      // Reveal one reply bubble. The first call closes out the reaction animation;
      // later calls keep the original read-then-type gap between bubbles. Chunks are
      // appended as they arrive so the streaming path can render bubble 1 while the
      // model is still writing corrections and suggestions.
      // `skipPacing` (task 3.13): revealTurnChunk already ran its own
      // reading/thinking/typing sequence (with the translation "thought" shown
      // mid-sequence) before calling this — don't double up the read-then-type
      // gap here. Callers that reveal chunks directly (eyes-free, premade) leave
      // it unset and keep the pacing this function has always done.
      const revealChunk = async (chunk: ResponseChunk, opts?: { skipPacing?: boolean }) => {
        if (chunk.native_text) lastChallengeChunkRef.current = chunk;
        const index = shownCount;
        if (!characterCreated) {
          setProcessingMsgId(null);
          if (reactionState) reactionState.arrive((chunk.text || '').length);
          if (reactionPromise) await reactionPromise;
          setReactionPhase(null);
          setVisibleChunkCounts(prev => new Map(prev).set(characterMsgId, 0));
          setMessages(prev => [...prev, {
            id: characterMsgId,
            timestamp: new Date(),
            side: "character",
            responseChunks: [],
            suggestedReplies: [],
          }]);
          characterCreated = true;
        } else if (!opts?.skipPacing) {
          await delay(readingDelay(lastChunkText));
          setIsTyping(true);
          await delay(chunkRevealDelay(lastChunkText));
          setIsTyping(false);
        }

        setMessages(prev => prev.map(msg =>
          msg.id === characterMsgId
            ? { ...msg, responseChunks: [...(msg.responseChunks || []), chunk] }
            : msg
        ));
        setVisibleChunkCounts(prev => new Map(prev).set(characterMsgId, index + 1));

        if (chunk.modality === "audio" && chunk.audio_file) {
          replayStack.push({
            text: chunk.text,
            locale: chunk.locale ?? localeFor(learning.code),
            source: "character",
            audioUrl: `${apiBase}${chunk.audio_file}`,
            nativeText: chunk.native_text,
          });
        }

        if (streamLetters) {
          setStreamingMessageId(characterMsgId);
          await streamText(characterMsgId, index, chunk.text || '');
          setStreamingMessageId(null);
        }

        lastChunkText = chunk.text || '';
        shownCount = index + 1;
      };

      // Screen-on per-sentence reveal (task 3.12, presentation superseded by
      // 3.13). Every chunk but the first (the reaction opener, never
      // translated — task 3.8) gets its translation shown as an ephemeral
      // "thought" — the character thinking the meaning before writing it in
      // the target language — sequenced between the reading and typing beats,
      // then hidden before the bubble and its audio arrive ("hide, then
      // play": the whole point is training listening, not reading along).
      // That's now the default regardless of `pairingMode`; `pairingMode`
      // still separately governs whether the turn's *audio* pairs/substitutes
      // a spoken translation (untouched below).
      //
      // Only called once the whole turn is available (after the stream or
      // buffered fetch resolves), never chunk-by-chunk as the model is still
      // writing: a cache-miss chunk's audio isn't confirmed on disk until the
      // "audio" events at the END of the stream, so playing inline while more
      // chunks are still arriving isn't safe. Eyes-free never calls this — it
      // has no visual channel to show a thought on, and a pending correction
      // drill needs this turn's audio held back entirely (task 3.4), which
      // this doesn't support; it keeps the old revealChunk-then-
      // playResponseAudio path unchanged.
      const revealTurnChunk = async (chunk: ResponseChunk, index: number) => {
        if (chunk.modality !== "audio") {
          await revealChunk(chunk);
          return;
        }

        const needsPlaybackTranslation = needsTranslationAt(index);
        // The v2/eyes-free challenge sentence is guaranteed a working hover-
        // reveal regardless of pairing mode — task 3.8's original guarantee.
        // Task 3.11 can strip native_text off it when the sentence gets split
        // into multiple pieces, so back-fill it here too.
        const needsHoverFallback = !!chunk.is_challenge && !chunk.native_text;
        // Task 3.13: every sentence but chunk 0 gets a thought, independent
        // of pairingMode/needsPlaybackTranslation.
        const needsThought = index !== 0;
        const needsTranslation = needsPlaybackTranslation || needsHoverFallback || needsThought;

        // Fire the translate call immediately so its latency lands inside the
        // reading/thinking beats below instead of stalling after them — the
        // thinking icon is free cover for it, same trick as task 1.1.
        const englishPromise: Promise<string | null> = chunk.native_text
          ? Promise.resolve(chunk.native_text)
          : needsTranslation
            ? fetchTranslations([chunk.text || ""]).then(([t]) => t ?? null)
            : Promise.resolve(null);

        let english: string | null;
        if (index === 0) {
          english = await englishPromise;
        } else {
          setReactionPhase('reading');
          await delay(readingDelay(lastChunkText));

          setReactionPhase('thinking');
          // A translate outage degrades to no thought shown, never a stall —
          // task 3.8's ok:false/nulls contract, re-verified for this default path.
          english = await englishPromise;
          if (english) {
            setThoughtText(english);
            await delay(flashDurationMs(english));
            setThoughtText(null);
            // The beat that keeps "hide, then play" from reading as a dead
            // stall while stopping the text and audio from overlapping.
            await delay(200);
          }

          setReactionPhase('typing');
          await delay(chunkRevealDelay(lastChunkText));
          setReactionPhase(null);
        }

        // Persisted onto the revealed chunk (not just the ephemeral thought)
        // so the settled bubble's hover-to-reveal zone still works if the
        // thought is missed — task 3.12 "Watch for": auto-hide must not
        // strand the learner. skipPacing: the reading/thinking/typing beats
        // above already ran, so revealChunk shouldn't run its own too.
        const chunkToReveal = english ? { ...chunk, native_text: english } : chunk;

        // Task 3.14: mark this chunk pending *before* it's revealed, so the
        // very first frame it appears on is already the empty playback-
        // indicator card — never a flash of the interactive one.
        // `characterMsgId`/`index` are the same key the render below looks up.
        const key = `${characterMsgId}-${index}`;
        setPendingChunkKeys(prev => new Set(prev).add(key));
        await revealChunk(chunkToReveal, { skipPacing: true });

        // Lifts the overlay once, whichever branch below actually plays this
        // chunk's clip — the card underneath goes back to its normal,
        // hover-gated self (never auto-revealed; see the component comment).
        // This also covers "stop for any reason" (task 3.15's watch-for): a
        // B-button stop-audio or a failed fetch both still resolve the
        // awaited play call below, so this always runs.
        const settlePending = () => {
          setPendingChunkKeys(prev => {
            if (!prev.has(key)) return prev;
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        };

        if (needsPlaybackTranslation && english && pairingMode === "pairs") {
          await audioPlayer.play(english, localeFor(fluent.code));
          await delay(WITHIN_PAIR_GAP_MS);
        }

        if (needsPlaybackTranslation && english && pairingMode === "alternating") {
          // This chunk is heard in the UI language INSTEAD of the target —
          // unchanged from the old playResponseAudio behaviour for this mode.
          await audioPlayer.play(english, localeFor(fluent.code));
          settlePending();
          return;
        }
        await playTargetClip(chunkToReveal);
        settlePending();
      };

      // Everything that isn't a reply bubble: the correction on the user's own message,
      // suggestions, usage, quiz, level-up. With response_chunks first in the output
      // schema these now land *after* the reply has started rendering.
      const applyFinal = async (data: TurnPayload) => {
        // Generate user sentence audio if enabled — fire-and-forget so it doesn't block the
        // correction UI update below. corrected_input is almost always novel text, so this
        // is reliably a cache miss and a full Azure roundtrip; patch it onto the message (and
        // autoplay for translation mode) whenever it resolves.
        userAudioPromise = (audioEnabled && data.corrected_input)
          ? fetchAudioUrl(data.corrected_input, localeFor(learning.code)).then(audioPath => {
              if (!audioPath) return;
              userAudioFile = audioPath;
              setMessages(prev => prev.map(msg =>
                msg.id === userMsgId ? { ...msg, userAudioFile: audioPath } : msg
              ));
              replayStack.push({
                text: data.corrected_input!,
                locale: localeFor(learning.code),
                source: "user",
                audioUrl: `${apiBase}${audioPath}`,
              });
              // Auto-play for translation mode — user spoke English, play how it sounds in Spanish
              if (data.input_intent === "english") {
                void audioPlayer.playUrl(`${apiBase}${audioPath}`);
              }
            })
          : Promise.resolve();

        // UPDATE user's message with correction info (if any)
        setMessages((prev) => prev.map(msg => {
          if (msg.id !== userMsgId) return msg;
          // Build correction diff for any Spanish-intent message with errors
          const tokens = data.had_errors && data.input_intent !== "english" && msg.userInput && data.corrected_input
            ? buildCorrectionTokens(msg.userInput, data.corrected_input)
            : undefined;
          // Fallback: if had_errors but tokens are empty/all-ok (LLM didn't change corrected_input),
          // force a diff showing the original as removed and the corrected as added
          const effectiveTokens = (() => {
            if (!tokens || !data.had_errors) return tokens;
            const hasChange = tokens.some(t => t.status !== "ok");
            if (hasChange) return tokens;
            if (msg.userInput && data.corrected_input && msg.userInput.trim() !== data.corrected_input.trim()) {
              return [
                { text: msg.userInput, status: "remove" as const },
                { text: " " + data.corrected_input, status: "add" as const },
              ];
            }
            return tokens;
          })();
          return {
            ...msg,
            correctedInput: data.corrected_input,
            correctionTokens: effectiveTokens,
            hadErrors: data.had_errors,
            errorExplanation: data.error_explanation,
            inputIntent: (data.input_intent as "english" | "spanish") ?? "spanish",
            userTranslation: data.user_translation ?? undefined,
          };
        }));
        setProcessingMsgId(null);

        // Attach suggestions to the character bubble now that they exist
        setMessages(prev => prev.map(msg =>
          msg.id === characterMsgId
            ? { ...msg, suggestedReplies: data.suggested_replies || [] }
            : msg
        ));
        setCurrentSuggestions(data.suggested_replies || []);
        setRevealedSuggestionIds(new Set());
        // Pre-seed audio cache for any suggestions that already have audio_file paths
        for (const s of (data.suggested_replies || []) as SuggestedReply[]) {
          if (s.audio_file) suggestionAudioCacheRef.current.set(s.id, s.audio_file);
        }
        // Stop any ongoing audio repeat
        currentlyPlayingSuggestionRef.current = null;
        if (audioRepeatTimeoutRef.current) {
          window.clearTimeout(audioRepeatTimeoutRef.current);
          audioRepeatTimeoutRef.current = null;
        }

        // Update token usage tracking
        if (data.token_usage) {
          const usage = data.token_usage as TokenUsage;
          setLastTurnTokens(usage);
          setSessionTokens(prev => ({
            prompt_tokens: prev.prompt_tokens + usage.prompt_tokens,
            completion_tokens: prev.completion_tokens + usage.completion_tokens,
            total_tokens: prev.total_tokens + usage.total_tokens,
            cost_cents: prev.cost_cents + usage.cost_cents
          }));
        }

        // Handle pending quiz from response
        if (data.pending_quiz) {
          const quiz = data.pending_quiz as QuizItem;
          // Check if we already have this quiz displayed
          const alreadyDisplayed = quizMessages.some(qm => qm.quiz.id === quiz.id);
          if (!alreadyDisplayed) {
            setQuizMessages(prev => [...prev, {
              id: Date.now(),
              quiz,
              isAnswered: false
            }]);
          }
        }

        // Update profile if level changed
        if (data.profile_updated && data.new_level) {
          setNewLevel(data.new_level);
          setShowLevelUp(true);
          setTimeout(() => setShowLevelUp(false), 3000);

          // Refresh profile
          const profileRes = await fetch(`${apiBase}/api/messenger/profile`);
          if (profileRes.ok) {
            const profileData = await profileRes.json();
            setProfile(profileData.profile);
          }
        }
      };

      let data: TurnPayload | null = null;

      // --- Streaming path -----------------------------------------------------
      // Bubbles render as the model writes them instead of after the whole JSON
      // (including suggestions and the level assessment) is complete.
      if (!usePremadeEndpoint) {
        try {
          const res = await fetch(`${apiBase}/api/messenger/turn/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_input: text, session_id: SESSION_ID, prompt_version: activeVersion }),
          });
          if (!res.ok || !res.body) throw new Error(`stream endpoint returned ${res.status}`);

          await readNdjson(res, async (evt) => {
            if (evt.type === 'chunk') {
              // Screen-on turns defer reveal+play to the unified pass below
              // (task 3.12) — a cache-miss chunk's audio isn't confirmed
              // ready until the stream's trailing "audio" events, so nothing
              // here is safe to play yet. Eyes-free still reveals live.
              if (eyesFree) await revealChunk(evt.chunk);
            } else if (evt.type === 'final') {
              data = evt;
              await applyFinal(evt);
            } else if (evt.type === 'error' && shownCount > 0) {
              // Half-rendered: retrying would duplicate bubbles.
              throw new Error('stream failed after emitting chunks');
            }
            // 'audio' events just confirm TTS hit disk; playback happens below, by
            // which point every future has been awaited server-side.
            // 'fallback' leaves data null so the buffered path below runs.
          });
        } catch (e) {
          if (shownCount > 0) throw e;
          console.warn('Streaming turn unavailable, falling back to buffered endpoint:', e);
          data = null;
        }
      }

      // --- Buffered path ------------------------------------------------------
      // Premade openers, and any streaming turn that failed before rendering.
      if (!data) {
        const res = await fetch(
          usePremadeEndpoint ? `${apiBase}/api/messenger/premade-start` : `${apiBase}/api/messenger/turn`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: usePremadeEndpoint
              ? JSON.stringify({ session_id: SESSION_ID })
              : JSON.stringify({ user_input: text, session_id: SESSION_ID, prompt_version: activeVersion }),
          }
        );
        if (!res.ok) throw new Error('Turn API failed');
        const buffered: TurnPayload = await res.json();
        data = buffered;
        // Buffered order matches the pre-streaming behaviour: correction first,
        // then the reply bubbles. Premade scripts always reveal immediately here
        // (they never went through pairing/translation logic); a non-eyes-free
        // LLM turn that fell back to buffered defers to the unified reveal+play
        // pass below instead (task 3.12).
        await applyFinal(buffered);
        if (usePremadeEndpoint || eyesFree) {
          for (const chunk of (buffered.response_chunks || [])) {
            await revealChunk(chunk);
          }
        }
      }

      // Play user sentence audio first (if generated), then response audio. By this point
      // the TTS fetch has had the whole reaction animation + chunk reveal to complete, so
      // this rarely blocks — but await it to preserve the play order either way.
      await userAudioPromise;

      // Eyes-free: a substantive error interrupts here, before the character
      // answers. The correction belongs to the sentence you just said, so it has
      // to land first — and the reply, which ends in a question you're meant to
      // answer, waits until the drill closes rather than competing with it.
      const pendingDrill = eyesFree ? drillFor(data, text) : null;

      // Skipped before a drill: it would play the corrected sentence at normal
      // speed immediately before the drill says the same thing slowly.
      if (userAudioFile && !pendingDrill) {
        await audioPlayer.playUrl(`${apiBase}${userAudioFile}`);
      }

      if (pendingDrill) {
        pendingReplyChunksRef.current = data?.response_chunks || [];
        await startCorrectionDrill(pendingDrill);
      } else if (eyesFree || usePremadeEndpoint) {
        // Eyes-free: no visual channel to flash a translation on, and this is
        // the unchanged path (see revealTurnChunk's comment above). Premade:
        // its chunks were already revealed above; this just plays their audio,
        // exactly as it did before task 3.12.
        await playResponseAudio(data?.response_chunks || []);
      } else {
        // Screen-on, real LLM turn (task 3.12, presentation per 3.13): show
        // the thought, reveal, and play one sentence at a time, instead of
        // every bubble for the whole turn rendering before any audio starts.
        for (const [index, chunk] of (data?.response_chunks || []).entries()) {
          await revealTurnChunk(chunk, index);
        }
      }

    } catch (e) {
      console.error("Failed to send message:", e);
      alert("Failed to send message. Please try again.");
    } finally {
      setBusy(false);
      setIsTyping(false);
      setReactionPhase(null);
      setThoughtText(null);
      setProcessingMsgId(null);
      setStreamingMessageId(null);
      // Task 3.14 safety net: if a turn errors out mid-reveal, don't strand a
      // bubble on the empty playback-indicator card forever — falling back
      // to `pending:false` still renders the normal hover-reveal card.
      setPendingChunkKeys(new Set());
    }
  }

  // --- Playback pacing (task 3.8) --------------------------------------------
  // The character speaks only the target language now, so a reply is three
  // target-language clips in a row. Gaps are an anti-overwhelm requirement first:
  // back-to-back sentences with no breathing room are a wall. They also happen to
  // hide the translate->TTS chain, which is why pairing and pacing landed together.
  //
  // The asymmetry between the two gaps is what makes `pairs` sound like pairs
  // rather than six unrelated clips: EN and ES of the SAME sentence sit close
  // together, and the gap between sentences is much longer.
  const WITHIN_PAIR_GAP_MS = 500;   // EN -> ES of one sentence: they belong together
  const BETWEEN_SENTENCE_GAP_MS = 1200;  // floor; scaled up by clip length below

  function betweenSentenceGap(text: string): number {
    return Math.min(2200, Math.max(BETWEEN_SENTENCE_GAP_MS, text.length * 30));
  }

  // Gaps are a FLOOR, not a fixed delay: whichever of (pause, audio-ready) takes
  // longer wins. Fast translation still gets its full pause; slow translation
  // stretches the pause instead of producing a stall. Extra latency in `pairs` is
  // permitted, never manufactured — see task 3.8.
  async function pauseAtLeast<T>(ms: number, work: Promise<T>): Promise<T> {
    const [result] = await Promise.all([work, delay(ms)]);
    return result;
  }

  // Fetch UI-language translations for the chunks the active mode actually needs.
  // Never throws: a null entry means "no translation available", and playback
  // degrades to the target clip alone rather than hanging the conversation.
  async function fetchTranslations(texts: string[]): Promise<(string | null)[]> {
    if (texts.length === 0) return [];
    try {
      const res = await fetch(`${apiBase}/api/messenger/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          texts,
          source_lang: learning.name,
          target_lang: fluent.name,
        }),
      });
      if (!res.ok) return texts.map(() => null);
      const data = await res.json();
      return (data.translations || texts.map(() => null)) as (string | null)[];
    } catch (e) {
      console.warn("Translation unavailable, playing target-only:", e);
      return texts.map(() => null);
    }
  }

  // Does chunk `index` need its translation spoken (pairs) or substituted
  // (alternating) in the *audio*, given the mode? Chunk 0 is the reaction
  // opener and never gets one — it's short, carried by tone, and it's the
  // clip the learner is waiting on before anything else can play. This no
  // longer governs the visual "thought" text (task 3.13 shows that for every
  // sentence but chunk 0 regardless of pairingMode) — only whether the audio
  // itself pairs/substitutes a spoken translation. Factored out (task 3.12)
  // so both the whole-turn player below and the per-sentence screen-on reveal
  // (`revealTurnChunk`, in sendMessage) agree on the same audio rule instead
  // of drifting apart across a third pass over this file.
  function needsTranslationAt(index: number): boolean {
    if (pairingMode === "targetOnly" || index === 0) return false;
    if (pairingMode === "pairs") return true;
    // alternating: every other chunk after the opener is heard in the UI language
    // instead of the target — a comprehension anchor, not a withheld crutch.
    return (index - 1) % 2 === 0;
  }

  function chunksNeedingTranslation(chunks: ResponseChunk[]): number[] {
    return chunks.map((_, i) => i).filter(needsTranslationAt);
  }

  // Task 3.12: how long a translation flash stays up before hiding — reading
  // takes longer than listening for the same short phrase, hence the higher
  // floor than betweenSentenceGap's.
  function flashDurationMs(text: string): number {
    return Math.max(1500, Math.min(3500, text.length * 60));
  }

  // Play one chunk's own clip (never a translation). Prefer the pre-generated
  // reaction clip (task 3.2): free, no Azure roundtrip. Silently absent until
  // backend/scripts/generate_reaction_audio.py has run. Factored out (task
  // 3.12) so the whole-turn player and the per-sentence reveal share it.
  async function playTargetClip(chunk: ResponseChunk) {
    if (chunk.reaction_audio_file) {
      await audioPlayer.playUrl(`${apiBase}${chunk.reaction_audio_file}`);
    } else if (chunk.audio_file) {
      await audioPlayer.playUrl(`${apiBase}${chunk.audio_file}`);
    } else if (chunk.text) {
      await audioPlayer.play(chunk.text, chunk.locale || localeFor(learning.code));
    }
  }

  // `withReactions` is gone: chunk 0 is always the target-language reaction opener
  // now, so the pre-generated clip is preferred in every mode, not just eyes-free.
  //
  // Used only by eyes-free turns since task 3.12 — screen-on turns play each
  // chunk inline as it's revealed (see `revealTurnChunk` in sendMessage) instead
  // of rendering every bubble for the whole turn before any audio starts. Eyes-
  // free keeps this whole-turn version because a pending correction drill needs
  // audio held back entirely (task 3.4), which the inline path doesn't support,
  // and because there is no visual channel to flash a translation on anyway.
  async function playResponseAudio(chunks: ResponseChunk[]) {
    const playable = chunks.filter(c => c.text || c.audio_file || c.reaction_audio_file);
    if (playable.length === 0) return;

    const needed = new Set(chunksNeedingTranslation(playable));
    // Kicked off before the first clip plays, so chunk 0's playback covers it.
    const pending = fetchTranslations(
      playable.map((c, i) => (needed.has(i) ? (c.native_text || c.text || "") : ""))
        .filter((_, i) => needed.has(i))
    );
    const neededIdx = [...needed].sort((a, b) => a - b);

    let translations: (string | null)[] = [];
    const translationFor = async (i: number): Promise<string | null> => {
      if (!needed.has(i)) return null;
      // The v2/eyes-free challenge already carries its translation from the main
      // call — no roundtrip needed, and it's guaranteed present for hover-reveal.
      if (playable[i].native_text) return playable[i].native_text!;
      if (translations.length === 0) translations = await pending;
      const slot = neededIdx.indexOf(i);
      return slot >= 0 ? (translations[slot] ?? null) : null;
    };

    const playTarget = playTargetClip;

    for (let i = 0; i < playable.length; i++) {
      const chunk = playable[i];

      if (i > 0) {
        // Between sentences: the long gap, floored, absorbing the next
        // translate->TTS chain if it hasn't finished yet.
        await pauseAtLeast(
          betweenSentenceGap(playable[i - 1].text || ""),
          translationFor(i),
        );
      }

      const english = await translationFor(i);

      if (pairingMode === "alternating" && english) {
        // This chunk is heard in the UI language INSTEAD of the target.
        await audioPlayer.play(english, localeFor(fluent.code));
        continue;
      }

      if (pairingMode === "pairs" && english) {
        await audioPlayer.play(english, localeFor(fluent.code));
        await delay(WITHIN_PAIR_GAP_MS);
      }

      await playTarget(chunk);
    }

  }

  // --- Repeat-after-me correction drill (eyes-free) ---------------------------
  // Spoken in the UI language, so it costs one Azure roundtrip ever: the string is
  // fixed, and the backend's content-hash cache serves every later drill for free.
  // (English TTS runs ~4-5x the characters of the sentence it introduces — task 3.1.)
  const TRY_SAYING_PREFIX = "Try saying:";

  // The severity gate. Interrupting is expensive with the screen off, so it takes
  // a substantive error: minor naturalness nits ride along to the deferred quiz
  // (task 3.7) instead. `error_severity` is reconciled with had_errors server-side
  // in _normalize_severity.
  function drillFor(data: TurnPayload | null, userText: string): CorrectionDrill | null {
    if (!data?.had_errors || data.error_severity !== "major") return null;
    // Nothing to repeat if they weren't attempting the target language at all.
    if (data.input_intent === "english") return null;
    const target = (data.corrected_input || "").trim();
    // The model sometimes flags an error but returns the input unchanged; drilling
    // "say exactly what you just said" is worse than staying quiet.
    if (!target || target === userText.trim()) return null;
    return { target, locale: localeFor(learning.code), explanation: data.error_explanation };
  }

  // Earcon and haptic first (they land before any speech does), then the
  // prompt, then the sentence at 0.75x. Leaves the drill open: the caller's
  // `finally` drops `busy`, which re-enables the textarea — that is the "mic
  // opens" step.
  async function startCorrectionDrill(next: CorrectionDrill) {
    drillRef.current = next;
    setDrill(next);
    earcons.play("correctionIncoming");
    haptics.play("correctionIncoming"); // task 4.4 — the long buzz, screen-off's only cue an interrupt is coming
    await speakDrillTarget(next, { withPrefix: true });
    textareaRef.current?.focus();
  }

  async function speakDrillTarget(d: CorrectionDrill, opts?: { withPrefix?: boolean }) {
    if (opts?.withPrefix) await audioPlayer.play(TRY_SAYING_PREFIX, localeFor(fluent.code));
    await audioPlayer.play(d.target, d.locale, SLOW_TTS_RATE);
  }

  // The "why", on demand only — automatic playback would double the interruption.
  async function explainDrill() {
    const d = drillRef.current ?? drill;
    if (!d?.explanation) return;
    await audioPlayer.play(d.explanation, localeFor(fluent.code));
  }

  // Task 3.13 point 4, revised: preview a replayed item's translation with
  // the same "hide, then play" beat as the first pass — show it, hide, then
  // a short gap before the audio starts — rather than showing it alongside
  // the clip. Held for half of flashDurationMs: on replay the learner has
  // already heard the sentence once, so the preview only needs to jog memory,
  // not carry a full first read. eyesFree has no visual channel to show it on.
  async function withReplayThought<T>(item: ReplayItem, play: () => Promise<T>): Promise<T> {
    if (eyesFree || !item.nativeText) return play();
    setThoughtText(item.nativeText);
    await delay(flashDurationMs(item.nativeText) / 2);
    setThoughtText(null);
    await delay(200);
    return play();
  }

  // Alt+R / controller A: hear it again. During a drill that is the sentence to
  // repeat; otherwise whatever the replay stack's cursor currently points at
  // (task 2.2's stack, task 4.3's cursor over it — LB/RB move it, this reads it).
  // Defaults to the latest item until something steps the cursor back.
  async function repeatLastAudio() {
    const d = drillRef.current;
    if (d) { await speakDrillTarget(d); return; }
    const item = replayStack.current();
    if (item) await withReplayThought(item, () => audioPlayer.playUrl(item.audioUrl));
  }

  // Controller Y (task 4.2): same target as repeatLastAudio, always at 0.75x. A
  // drill target is already spoken slow by speakDrillTarget, so that path is
  // identical; the replay-stack path re-fetches at SLOW_TTS_RATE instead of
  // replaying the cached (normal-speed) clip.
  async function repeatLastAudioSlow() {
    const d = drillRef.current;
    if (d) { await speakDrillTarget(d); return; }
    const item = replayStack.current();
    if (item) await withReplayThought(item, () => audioPlayer.play(item.text, item.locale, SLOW_TTS_RATE));
  }

  // Controller LT hold (task 4.2): speaks the native-language translation of the
  // most recent v2/eyes-free challenge sentence — the controller equivalent of
  // hovering <MessengerChallengePair>'s native zone. Free: native_text already
  // came back with the main call, no translate roundtrip. No-op if there's been
  // no challenge chunk yet this session.
  async function speakLastChallengeTranslation() {
    const chunk = lastChallengeChunkRef.current;
    if (!chunk?.native_text) return;
    await audioPlayer.play(chunk.native_text, localeFor(fluent.code));
  }

  // Closes the drill and resumes the conversation. `attempt` is undefined when the
  // drill was skipped rather than answered.
  async function finishDrill(attempt?: string) {
    const d = drillRef.current;
    if (!d) return;
    drillRef.current = null;
    // Cheap version (task 3.5): this checks word production via Wispr's cleaned-up
    // text, not pronunciation — real pronunciation scoring is task 6.1. Skipped
    // attempts (attempt === undefined) aren't scored at all, just closed.
    let passed: boolean | undefined;
    if (attempt !== undefined) {
      passed = checkFuzzyMatch(attempt, [d.target], learning.code) !== null;
      earcons.play(passed ? "attemptPassed" : "attemptFailed");
    }
    setDrill({ ...d, attempt, skipped: attempt === undefined, passed });
    setTranscript("");
    const chunks = pendingReplyChunksRef.current;
    pendingReplyChunksRef.current = null;
    if (!chunks?.length) return;
    setBusy(true);
    try {
      await playResponseAudio(chunks);
    } finally {
      setBusy(false);
    }
  }

  function handleSuggestionClick(suggestion: SuggestedReply) {
    pendingSuggestionRef.current = suggestion;
    // Stop any ongoing audio repeat
    currentlyPlayingSuggestionRef.current = null;
    if (audioRepeatTimeoutRef.current) {
      window.clearTimeout(audioRepeatTimeoutRef.current);
      audioRepeatTimeoutRef.current = null;
    }
    // Fill textarea with target language version
    setTranscript(suggestion.text_target);
    // Focus textarea
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }

  // Quiz answer handling
  async function checkQuizAnswer(quizId: string, userAnswer: string) {
    if (!userAnswer.trim() || checkingQuiz) return;

    setCheckingQuiz(quizId);

    try {
      const res = await fetch(`${apiBase}/api/quiz/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quiz_id: quizId,
          user_answer: userAnswer.trim()
        })
      });

      if (!res.ok) throw new Error('Quiz check failed');

      const data = await res.json();

      // Create the answered quiz entry
      const answeredQuiz: QuizMessage = {
        ...quizMessages.find(qm => qm.quiz.id === quizId)!,
        userAnswer: userAnswer.trim(),
        isCorrect: data.is_correct,
        feedback: data.feedback,
        isAnswered: true,
        answeredAt: new Date()
      };

      // Add to history
      setQuizHistory(prev => [answeredQuiz, ...prev]);

      // Show result briefly, then remove from active quizzes
      setQuizMessages(prev => prev.map(qm =>
        qm.quiz.id === quizId
          ? { ...qm, userAnswer: userAnswer.trim(), isCorrect: data.is_correct, feedback: data.feedback, isAnswered: true }
          : qm
      ));

      // Remove from active quizzes after showing result
      setTimeout(() => {
        setQuizMessages(prev => prev.filter(qm => qm.quiz.id !== quizId));
      }, 2000);  // Show result for 2 seconds

      // Clear the input
      setQuizInputs(prev => {
        const newMap = new Map(prev);
        newMap.delete(quizId);
        return newMap;
      });

    } catch (e) {
      console.error("Failed to check quiz answer:", e);
    } finally {
      setCheckingQuiz(null);
    }
  }

  function handleQuizInputChange(quizId: string, value: string) {
    setQuizInputs(prev => new Map(prev).set(quizId, value));

    // Clear existing timer
    const existingTimer = quizAutoSendTimers.current.get(quizId);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }

    // Auto-send after delay
    if (value.trim().length >= 2) {
      const timer = window.setTimeout(() => {
        void checkQuizAnswer(quizId, value);
      }, 1500);  // 1.5s delay for quiz auto-send
      quizAutoSendTimers.current.set(quizId, timer);
    }
  }

  function handleQuizKeyDown(e: React.KeyboardEvent<HTMLInputElement>, quizId: string) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const value = quizInputs.get(quizId) || "";
      void checkQuizAnswer(quizId, value);
    }
  }

  const pivotEditorList = PIVOTS
    .filter(p => !deletedPivots.has(p.id))
    .sort((a, b) => {
      const score = (id: string) => starredPivots.has(id) ? 0 : dislikedPivots.has(id) ? 2 : 1;
      return score(a.id) - score(b.id);
    });

  return (
    <>
      {isMockMode && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 9999,
          background: '#fbbf24',
          color: '#78350f',
          padding: '8px',
          textAlign: 'center',
          fontWeight: 600,
          fontSize: 14,
        }}>
          ⚠️ MOCK MODE - Using test data
        </div>
      )}

      {/* Level Up Celebration */}
      {showLevelUp && (
        <div style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'white',
          padding: '40px',
          borderRadius: '16px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          zIndex: 10000,
          textAlign: 'center',
          animation: 'fadeInScale 0.5s ease-out',
        }}>
          <div style={{ fontSize: '64px', marginBottom: '16px' }}>🎉</div>
          <h2 style={{ fontSize: '28px', marginBottom: '8px', color: '#22c55e' }}>
            Level Up!
          </h2>
          <p style={{ fontSize: '18px', color: '#6b7280' }}>
            You're now <strong>{newLevel}</strong>!
          </p>
        </div>
      )}

      <div style={{
        minHeight: '100vh',
        paddingTop: isMockMode ? 40 : 0,
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'system-ui, sans-serif',
        position: 'relative',
      }}>
        {/* Header - Sticky at top */}
        <div style={{
          position: 'sticky',
          top: isMockMode ? 40 : 0,
          zIndex: 100,
          background: 'white',
          padding: '16px 24px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {onBack && (
              <button
                onClick={onBack}
                style={{
                  padding: '8px 16px',
                  fontSize: 14,
                  background: '#6b7280',
                  color: 'white',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                }}
              >
                ← Back
              </button>
            )}
            <h2 style={{ margin: 0, fontSize: '24px' }}>Chat with Mateo</h2>

            {/* Feature toggles */}
            <div style={{ display: 'flex', gap: 12, marginLeft: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6b7280', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={streamLetters}
                  onChange={(e) => setStreamLetters(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                Stream text
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6b7280', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={audioEnabled}
                  onChange={(e) => setAudioEnabled(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                🔊 Audio
              </label>
              <label
                title="How the character's target-language audio is narrated: target-only plays just the target sentence; pairs speaks the English translation first when one exists; alternating voices every chunk in its own language with no translation, for unaided comprehension"
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6b7280' }}
              >
                🎧 Pairing
                <select
                  value={pairingMode}
                  onChange={(e) => setPairingMode(e.target.value as PairingMode)}
                  style={{ fontSize: 12, cursor: 'pointer', border: '1px solid #d1d5db', borderRadius: 4, padding: '1px 4px' }}
                >
                  <option value="targetOnly">target-only</option>
                  <option value="pairs">EN → target pairs</option>
                  <option value="alternating">alternating</option>
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6b7280', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={liveReactions}
                  onChange={(e) => setLiveReactions(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                💬 Reactions
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6b7280', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={showUserTranslation}
                  onChange={(e) => setShowUserTranslation(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                🌐 Translation
              </label>
              <label
                title={eyesFree ? "Eyes-free overrides this while it's on" : undefined}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6366f1', cursor: eyesFree ? 'not-allowed' : 'pointer', opacity: eyesFree ? 0.45 : 1, fontWeight: promptVersion === "v2" ? 700 : 400 }}
              >
                <input
                  type="checkbox"
                  checked={promptVersion === "v2"}
                  disabled={eyesFree}
                  onChange={() => setPromptVersion(v => v === "v1" ? "v2" : "v1")}
                  style={{ cursor: eyesFree ? 'not-allowed' : 'pointer' }}
                />
                ✨ v2: last sentence in Spanish
              </label>
              <label
                title="Screen off: short spoken turns, no suggestions, and substantive mistakes come back as 'try saying…' — Alt+R hear again, Alt+E why"
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#0d9488', cursor: 'pointer', fontWeight: eyesFree ? 700 : 400 }}
              >
                <input
                  type="checkbox"
                  checked={eyesFree}
                  onChange={(e) => setEyesFree(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                🙈 Eyes-free
              </label>
              <span
                title={gamepad.connected
                  ? "Controller seen by the browser — A repeat, B cancel/stop, X explain, Y repeat slow, LB/RB step through replay history, stick flick cancels a pending send, LT-hold plays the translation, D-pad up/down toggle eyes-free/cycle pairing mode, D-pad left/right change topic"
                  : "No controller seen by the browser. Recording (F13) still works via the native mapper regardless — this only affects in-page buttons, and it also goes dark whenever the window loses focus"}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: gamepad.connected ? '#16a34a' : '#9ca3af' }}
              >
                🎮 {gamepad.connected ? 'connected' : 'no controller'}
              </span>
              {/* Quiz History Button */}
              <button
                onClick={() => setShowQuizHistory(!showQuizHistory)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 10px',
                  fontSize: 12,
                  background: showQuizHistory ? '#6366f1' : '#e5e7eb',
                  color: showQuizHistory ? 'white' : '#4b5563',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                🤖 Quiz ({quizHistory.length})
              </button>
            </div>
          </div>

          {/* Level Badge and Token Usage */}
          {profile && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}>
              <div style={{
                fontSize: '14px',
                color: '#6b7280',
              }}>
                {fluent.name} → {learning.name}
              </div>
              <div style={{
                padding: '6px 12px',
                background: '#3b82f6',
                color: 'white',
                borderRadius: 16,
                fontSize: '14px',
                fontWeight: 600,
              }}>
                Level: {profile.level.charAt(0).toUpperCase() + profile.level.slice(1)} ({Math.round(profile.level_confidence * 100)}%)
              </div>
              {/* Token Usage Display - always show after first message */}
              {messages.length > 0 && (
                <div style={{
                  padding: '6px 12px',
                  background: '#10b981',
                  color: 'white',
                  borderRadius: 16,
                  fontSize: '12px',
                  fontWeight: 500,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  lineHeight: 1.2,
                }}
                title={`Session: ${sessionTokens.prompt_tokens} in / ${sessionTokens.completion_tokens} out\nLast turn: ${lastTurnTokens?.total_tokens || 0} tokens`}
                >
                  <span>{sessionTokens.total_tokens.toLocaleString()} tokens</span>
                  <span style={{ fontSize: '10px', opacity: 0.85 }}>
                    {sessionTokens.cost_cents < 0.01
                      ? `$${(sessionTokens.cost_cents / 100).toFixed(6)}`
                      : sessionTokens.cost_cents < 1
                        ? `${sessionTokens.cost_cents.toFixed(3)}¢`
                        : `${sessionTokens.cost_cents.toFixed(2)}¢`
                    }
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Quiz History Panel */}
        {showQuizHistory && (
          <div style={{
            position: 'fixed',
            top: isMockMode ? 40 : 0,
            right: 0,
            bottom: 0,
            width: '350px',
            background: 'white',
            boxShadow: '-4px 0 20px rgba(0,0,0,0.15)',
            zIndex: 200,
            display: 'flex',
            flexDirection: 'column',
            animation: 'slideIn 0.2s ease-out',
          }}>
            {/* Panel Header */}
            <div style={{
              padding: '16px 20px',
              borderBottom: '1px solid #e5e7eb',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
              color: 'white',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 20 }}>🤖</span>
                <span style={{ fontWeight: 600, fontSize: 16 }}>Quiz History</span>
              </div>
              <button
                onClick={() => setShowQuizHistory(false)}
                style={{
                  background: 'rgba(255,255,255,0.2)',
                  border: 'none',
                  color: 'white',
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 16,
                }}
              >
                ✕
              </button>
            </div>

            {/* Quiz Stats */}
            <div style={{
              padding: '12px 20px',
              background: '#f9fafb',
              borderBottom: '1px solid #e5e7eb',
              display: 'flex',
              gap: 16,
              fontSize: 13,
            }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontWeight: 600, color: '#10b981' }}>
                  {quizHistory.filter(q => q.isCorrect).length}
                </div>
                <div style={{ color: '#6b7280', fontSize: 11 }}>Correct</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontWeight: 600, color: '#f59e0b' }}>
                  {quizHistory.filter(q => !q.isCorrect).length}
                </div>
                <div style={{ color: '#6b7280', fontSize: 11 }}>To Review</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontWeight: 600, color: '#6366f1' }}>
                  {quizHistory.length}
                </div>
                <div style={{ color: '#6b7280', fontSize: 11 }}>Total</div>
              </div>
            </div>

            {/* Quiz List */}
            <div style={{
              flex: 1,
              overflowY: 'auto',
              padding: '12px',
            }}>
              {quizHistory.length === 0 ? (
                <div style={{
                  textAlign: 'center',
                  color: '#9ca3af',
                  padding: '40px 20px',
                  fontSize: 14,
                }}>
                  No quizzes answered yet.<br />
                  Keep chatting to generate quiz questions!
                </div>
              ) : (
                quizHistory.map((qm, idx) => (
                  <div
                    key={`history-${qm.id}-${idx}`}
                    style={{
                      padding: '12px',
                      marginBottom: '8px',
                      borderRadius: '12px',
                      background: qm.isCorrect ? '#ecfdf5' : '#fef3c7',
                      border: `1px solid ${qm.isCorrect ? '#a7f3d0' : '#fde68a'}`,
                    }}
                  >
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      marginBottom: 6,
                    }}>
                      <span style={{ fontSize: 14 }}>{qm.isCorrect ? '✅' : '📝'}</span>
                      <span style={{
                        fontSize: 10,
                        background: qm.isCorrect ? '#10b981' : '#f59e0b',
                        color: 'white',
                        padding: '2px 6px',
                        borderRadius: 4,
                        fontWeight: 500,
                      }}>
                        {qm.quiz.error_type?.replace('_', ' ') || 'vocab'}
                      </span>
                      {qm.answeredAt && (
                        <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 'auto' }}>
                          {qm.answeredAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 13, color: '#374151', marginBottom: 4 }}>
                      {qm.quiz.quiz_prompt || qm.quiz.quiz_question || qm.quiz.prompt_native}
                    </div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>
                      <span style={{ fontWeight: 500 }}>You said:</span> {qm.userAnswer}
                    </div>
                    {!qm.isCorrect && (
                      <div style={{ fontSize: 12, color: '#059669', marginTop: 4 }}>
                        <span style={{ fontWeight: 500 }}>Answer:</span> {qm.quiz.corrected}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Messages area - Scrollable between header and chatbox */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          minHeight: 0, // Important for flex scrolling
        }}>
          {messages.length === 0 && (
            <div style={{
              textAlign: 'center',
              color: 'white',
              fontSize: '18px',
              marginTop: '40px',
              opacity: 0.8,
            }}>
              Start chatting with {characterName || "your partner"} in {learning.name}...
            </div>
          )}

          {messages.map((message, msgIndex) => (
            <div
              key={message.id}
              style={{
                alignSelf: message.side === "user" ? 'flex-end' : 'flex-start',
                maxWidth: '70%',
              }}
            >
              {message.side === "user" ? (
                // User message
                <div>
                  {message.suggestedNative && (
                    <div style={{
                      fontSize: 11,
                      color: 'rgba(255,255,255,0.45)',
                      textAlign: 'right',
                      marginBottom: 3,
                      paddingRight: 4,
                    }}>
                      {message.suggestedNative}
                    </div>
                  )}
                  {showUserTranslation && message.userTranslation && message.inputIntent === "spanish" && (
                    <div style={{
                      fontSize: 11,
                      color: 'rgba(255,255,255,0.5)',
                      textAlign: 'right',
                      marginBottom: 4,
                      paddingRight: 4,
                      fontStyle: 'italic',
                      animation: 'fadeIn 0.35s ease-out',
                    }}>
                      {message.userTranslation}
                    </div>
                  )}
                  {message.inputIntent === "english" ? (
                    // Translation mode: user spoke English — show clean bubble + Spanish card below
                    <>
                      <div style={{
                        background: '#3b82f6',
                        color: 'white',
                        padding: '12px 16px',
                        borderRadius: '18px',
                        fontSize: '16px',
                        lineHeight: '1.4',
                        wordWrap: 'break-word',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                      }}>
                        {message.userInput}
                      </div>
                      {message.correctedInput && (
                        <div style={{
                          marginTop: 6,
                          background: 'rgba(255,255,255,0.12)',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: 12,
                          padding: '8px 12px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 14,
                          animation: 'fadeIn 0.35s ease-out',
                        }}>
                          <span style={{ opacity: 0.5, fontSize: 12 }}>🇲🇽</span>
                          <span style={{ color: 'rgba(255,255,255,0.95)', fontStyle: 'italic', flex: 1 }}>
                            {message.correctedInput}
                          </span>
                          {message.userAudioFile && (
                            <button
                              onMouseEnter={() => message.userAudioFile && void audioPlayer.playUrl(`${apiBase}${message.userAudioFile}`)}
                              title="Hear it in Spanish"
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                fontSize: 14,
                                opacity: 0.8,
                                padding: '0 2px',
                                color: 'white',
                                flexShrink: 0,
                              }}
                            >
                              🔊
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  ) : message.hadErrors ? (
                    // Correction mode: user attempted Spanish but made errors
                    <>
                      <div style={{
                        background: 'rgba(251,191,36,0.15)',
                        border: '1px solid rgba(251,191,36,0.35)',
                        padding: '10px 14px',
                        borderRadius: '18px',
                        fontSize: '15px',
                        lineHeight: '1.6',
                        wordWrap: 'break-word',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                        marginBottom: '8px',
                        animation: 'fadeIn 0.35s ease-out',
                      }}>
                        {message.correctionTokens
                          ? <CorrectionTokens tokens={message.correctionTokens} wrapped={false} />
                          : <span style={{ color: 'rgba(255,255,255,0.8)' }}>{message.correctedInput}</span>
                        }
                      </div>
                      {message.errorExplanation && (
                        <div style={{
                          fontSize: '12px',
                          color: 'rgba(255,255,255,0.9)',
                          marginTop: '4px',
                          padding: '8px',
                          background: 'rgba(255,255,255,0.2)',
                          borderRadius: '8px',
                        }}>
                          {message.errorExplanation}
                        </div>
                      )}
                    </>
                  ) : (
                    // Clean bubble: perfect Spanish (also the pending state while API is in-flight)
                    <div
                      style={{
                        background: '#3b82f6',
                        color: 'white',
                        padding: '12px 16px',
                        borderRadius: '18px',
                        fontSize: '16px',
                        lineHeight: '1.4',
                        wordWrap: 'break-word',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                      }}
                    >
                      <span className={processingMsgId === message.id ? 'text-wave' : ''}>
                        {message.userInput}
                      </span>
                    </div>
                  )}
                  <div style={{
                    fontSize: '12px',
                    color: 'rgba(255,255,255,0.7)',
                    marginTop: '4px',
                    textAlign: 'right',
                    display: 'flex',
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    gap: 6,
                  }}>
                    {message.inputIntent === "spanish" && !message.hadErrors && (
                      <span style={{ fontSize: 11, color: 'rgba(134,239,172,0.85)' }}>
                        ✓ sounds natural
                      </span>
                    )}
                    {message.userAudioFile && message.inputIntent !== "english" && (
                      <button
                        onMouseEnter={() => message.userAudioFile && void audioPlayer.playUrl(`${apiBase}${message.userAudioFile}`)}
                        title="Replay your sentence"
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          fontSize: 13,
                          opacity: 0.7,
                          padding: '0 2px',
                          color: 'white',
                        }}
                      >
                        🔊
                      </button>
                    )}
                    {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              ) : (
                // Character's message — each chunk is its own bubble, revealed progressively
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {(() => {
                    const visibleCount = visibleChunkCounts.get(message.id) ?? (message.responseChunks?.length ?? 0);
                    return (message.responseChunks || []).slice(0, visibleCount).map((chunk, idx) => {
                      if (chunk.language === "target" && chunk.modality === "audio" && chunk.text) {
                        // Task 3.14: only revealTurnChunk's screen-on real-turn
                        // path ever adds to pendingChunkKeys — eyes-free and
                        // premade chunks are never keyed into it, so they fall
                        // through to pending:false (the pre-3.14 hover-gated card).
                        const chunkKey = `${message.id}-${idx}`;
                        return (
                          <MessengerChallengePair
                            key={`challenge-${message.id}-${idx}`}
                            chunk={chunk}
                            fluentName={fluent.name}
                            learningName={learning.name}
                            audioUrl={chunk.audio_file ? `${apiBase}${chunk.audio_file}` : undefined}
                            pending={pendingChunkKeys.has(chunkKey)}
                          />
                        );
                      }
                      if (chunk.modality === "audio" && !chunk.text) return null;
                      const streamKey = `${message.id}-${idx}`;
                      const isStreaming = streamingMessageId === message.id && streamedText.has(streamKey);
                      const displayText = isStreaming ? (streamedText.get(streamKey) || "") : chunk.text;
                      return (
                        <div key={idx} style={{
                          background: 'white',
                          padding: '12px 16px',
                          borderRadius: '18px',
                          fontSize: '16px',
                          lineHeight: '1.4',
                          wordWrap: 'break-word',
                          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                        }}>
                          <span style={{
                            color: chunk.language === "target" ? '#3b82f6' : '#1f2937',
                            fontWeight: chunk.language === "target" ? 600 : 400,
                          }}>
                            {displayText}
                            {isStreaming && <span style={{ opacity: 0.5 }}>▌</span>}
                          </span>
                          {chunk.modality === "audio" && !isStreaming && (
                            <button
                              onClick={() => chunk.audio_file && audioPlayer.playUrl(`${apiBase}${chunk.audio_file}`)}
                              style={{
                                marginLeft: '8px',
                                padding: '4px 8px',
                                fontSize: '12px',
                                background: '#3b82f6',
                                color: 'white',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer',
                              }}
                            >
                              🔊
                            </button>
                          )}
                        </div>
                      );
                    });
                  })()}
                  <div style={{
                    fontSize: '12px',
                    color: 'rgba(255,255,255,0.7)',
                    marginTop: '4px',
                  }}>
                    {characterName} · {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Quiz Messages - Robot Pico asks quiz questions */}
          {quizMessages.filter(qm => !qm.isAnswered).map((quizMsg) => (
            <div
              key={quizMsg.id}
              style={{
                alignSelf: 'flex-start',
                maxWidth: '80%',
                marginTop: 8,
                marginBottom: 8,
              }}
            >
              <div style={{
                background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                padding: '14px 18px',
                borderRadius: '18px',
                boxShadow: '0 4px 12px rgba(99, 102, 241, 0.3)',
              }}>
                {/* Robot header */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 10,
                }}>
                  <span style={{ fontSize: 20 }}>🤖</span>
                  <span style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'rgba(255,255,255,0.9)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}>
                    Pico Quiz
                  </span>
                  <span style={{
                    fontSize: 10,
                    background: 'rgba(255,255,255,0.2)',
                    padding: '2px 6px',
                    borderRadius: 4,
                    color: 'white',
                  }}>
                    {quizMsg.quiz.error_type.replace('_', ' ')}
                  </span>
                </div>

                {/* Question */}
                <div style={{
                  color: 'white',
                  fontSize: 15,
                  lineHeight: 1.4,
                  marginBottom: 12,
                }}>
                  {quizMsg.quiz.quiz_prompt || quizMsg.quiz.quiz_question || quizMsg.quiz.prompt_native}
                </div>

                {/* Mini answer input */}
                <div style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                }}>
                  <input
                    type="text"
                    value={quizInputs.get(quizMsg.quiz.id) || ""}
                    onChange={(e) => handleQuizInputChange(quizMsg.quiz.id, e.target.value)}
                    onKeyDown={(e) => handleQuizKeyDown(e, quizMsg.quiz.id)}
                    onMouseEnter={(e) => e.currentTarget.focus()}
                    placeholder={`Type your answer in ${learning.name}...`}
                    disabled={checkingQuiz === quizMsg.quiz.id}
                    style={{
                      flex: 1,
                      padding: '10px 14px',
                      fontSize: 14,
                      border: 'none',
                      borderRadius: 12,
                      background: 'rgba(255,255,255,0.95)',
                      color: '#1f2937',
                      outline: 'none',
                      boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.1)',
                      caretColor: '#6366f1',
                    }}
                  />
                  {checkingQuiz === quizMsg.quiz.id && (
                    <span style={{ color: 'white', fontSize: 14 }}>⏳</span>
                  )}
                </div>

                <div style={{
                  fontSize: 10,
                  color: 'rgba(255,255,255,0.6)',
                  marginTop: 6,
                }}>
                  Hover to focus • Auto-submits after typing
                </div>
              </div>
            </div>
          ))}

          {/* Answered Quiz Messages */}
          {quizMessages.filter(qm => qm.isAnswered).map((quizMsg) => (
            <div
              key={`answered-${quizMsg.id}`}
              style={{
                alignSelf: 'flex-start',
                maxWidth: '80%',
                marginTop: 4,
                marginBottom: 4,
              }}
            >
              <div style={{
                background: quizMsg.isCorrect
                  ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
                  : 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                padding: '12px 16px',
                borderRadius: '18px',
                boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 6,
                }}>
                  <span style={{ fontSize: 18 }}>{quizMsg.isCorrect ? '✅' : '📝'}</span>
                  <span style={{ color: 'white', fontSize: 13, fontWeight: 600 }}>
                    {quizMsg.isCorrect ? 'Correct!' : 'Keep practicing!'}
                  </span>
                </div>
                <div style={{ color: 'white', fontSize: 13, opacity: 0.9 }}>
                  {quizMsg.quiz.quiz_prompt || quizMsg.quiz.quiz_question || quizMsg.quiz.prompt_native}
                </div>
                <div style={{
                  color: 'white',
                  fontSize: 14,
                  fontWeight: 600,
                  marginTop: 4,
                }}>
                  Your answer: {quizMsg.userAnswer}
                </div>
                {!quizMsg.isCorrect && (
                  <div style={{
                    color: 'rgba(255,255,255,0.9)',
                    fontSize: 13,
                    marginTop: 4,
                  }}>
                    {quizMsg.feedback}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Task 3.13: the character's ephemeral "thought" — the translation of
              the sentence about to be spoken (or just replayed), shown once and
              gone. Deliberately muted/small: the learner should be able to look
              away and simply not read it, which is what makes it optional
              scaffolding instead of a crutch. Decoupled from reactionPhase so it
              also shows during replay, when no reaction sequence is running. */}
          {thoughtText && (
            <div style={{ alignSelf: 'flex-start', maxWidth: '70%', padding: '0 4px' }}>
              <span style={{
                fontSize: 12,
                fontStyle: 'italic',
                color: 'rgba(255,255,255,0.5)',
              }}>
                {thoughtText}
              </span>
            </div>
          )}

          {/* Typing indicator */}
          {(isTyping || reactionPhase !== null) && (
            <div style={{
              alignSelf: 'flex-start',
              maxWidth: '70%',
            }}>
              <div style={{
                background: 'white',
                padding: '12px 16px',
                borderRadius: '18px',
                fontSize: '16px',
                boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
              }}>
                {reactionPhase && (
                  <span style={{ fontSize: 26, lineHeight: 1 }}>
                    {reactionPhase === 'reading' ? '👀' : reactionPhase === 'thinking' ? '🤔' : '✍️'}
                  </span>
                )}
                <div style={{ display: 'flex', gap: 4 }}>
                  <span className="typing-dot" style={{ animationDelay: '0ms' }}>•</span>
                  <span className="typing-dot" style={{ animationDelay: '150ms' }}>•</span>
                  <span className="typing-dot" style={{ animationDelay: '300ms' }}>•</span>
                </div>
              </div>
              <div style={{
                fontSize: '12px',
                color: 'rgba(255,255,255,0.7)',
                marginTop: '4px',
              }}>
                {reactionPhase
                  ? `${characterName} is ${reactionPhase}...`
                  : `${characterName} is typing...`
                }
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Suggestions Bar - Sticky above chatbox */}
        {!busy && (
          <div style={{
            position: 'sticky',
            bottom: 'calc(100px)',  // Above chatbox
            zIndex: 99,
            background: 'rgba(255,255,255,0.95)',
            backdropFilter: 'blur(8px)',
            padding: '12px 20px',
            boxShadow: '0 -2px 12px rgba(0,0,0,0.1)',
            borderTop: '2px solid #e5e7eb',
          }}>
            <div style={{
              maxWidth: '800px',
              margin: '0 auto',
            }}>
              {currentSuggestions.length > 0 && (
                <div style={{
                  fontSize: '12px',
                  color: '#6b7280',
                  marginBottom: '8px',
                  fontWeight: 600,
                }}>
                  💬 Quick replies (hover to see {learning.name}):
                </div>
              )}
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '8px',
                alignItems: 'flex-start',
              }}>
                {/* Pivot button — always first */}
                <button
                  onClick={() => void handlePivot()}
                  title={messages.length === 0 ? "Start conversation" : "Change topic"}
                  style={{
                    background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                    border: 'none',
                    borderRadius: 14,
                    padding: '10px 14px',
                    fontSize: 20,
                    cursor: 'pointer',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                    transition: 'opacity 0.15s, transform 0.1s',
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                >
                  {messages.length === 0 ? "👋" : "🎲"}
                </button>

                {/* Edit pivot list */}
                <button
                  onClick={() => setShowPivotEditor(true)}
                  title="Manage conversation starters"
                  style={{
                    background: 'rgba(0,0,0,0.05)',
                    border: '1px solid rgba(0,0,0,0.1)',
                    borderRadius: 10,
                    padding: '7px 9px',
                    fontSize: 14,
                    cursor: 'pointer',
                    color: '#9ca3af',
                    flexShrink: 0,
                    lineHeight: 1,
                    transition: 'background 0.15s, color 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.1)'; e.currentTarget.style.color = '#6b7280'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.05)'; e.currentTarget.style.color = '#9ca3af'; }}
                >
                  ✏️
                </button>

                {currentSuggestions.map((suggestion) => {
                  const isRevealed = revealedSuggestionIds.has(suggestion.id);

                  const stopAudioRepeat = () => {
                    if (audioRepeatTimeoutRef.current) {
                      window.clearTimeout(audioRepeatTimeoutRef.current);
                      audioRepeatTimeoutRef.current = null;
                    }
                    currentlyPlayingSuggestionRef.current = null;
                  };

                  const playAudioForSuggestion = (url: string) => {
                    stopAudioRepeat();
                    currentlyPlayingSuggestionRef.current = suggestion.id;
                    const playAndRepeat = async () => {
                      if (currentlyPlayingSuggestionRef.current !== suggestion.id) return;
                      await audioPlayer.playUrl(`${apiBase}${url}`);
                      if (currentlyPlayingSuggestionRef.current === suggestion.id) {
                        audioRepeatTimeoutRef.current = window.setTimeout(playAndRepeat, 500);
                      }
                    };
                    void playAndRepeat();
                  };

                  const handleAudioHover = async () => {
                    const cached = suggestionAudioCacheRef.current.get(suggestion.id);
                    if (cached) {
                      playAudioForSuggestion(cached);
                      return;
                    }
                    const locale = localeFor(learning.code);
                    const audioPath = await fetchAudioUrl(suggestion.text_target, locale);
                    if (audioPath) {
                      suggestionAudioCacheRef.current.set(suggestion.id, audioPath);
                      playAudioForSuggestion(audioPath);
                    }
                  };

                  return (
                    <div
                      key={suggestion.id}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                        borderRadius: 14,
                        overflow: 'hidden',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                        minWidth: 110,
                        maxWidth: 180,
                        cursor: 'pointer',
                      }}
                    >
                      {/* Native text — click to send */}
                      <div
                        onClick={() => {
                          stopAudioRepeat();
                          handleSuggestionClick(suggestion);
                        }}
                        style={{
                          padding: '8px 12px',
                          fontSize: 13,
                          color: 'white',
                          fontWeight: 500,
                          lineHeight: 1.3,
                          userSelect: 'none',
                        }}
                      >
                        {suggestion.text_native}
                      </div>

                      {/* Revealed target text */}
                      {isRevealed && (
                        <div style={{
                          padding: '4px 12px 6px',
                          fontSize: 12,
                          color: 'rgba(255,255,255,0.92)',
                          fontStyle: 'italic',
                          borderTop: '1px solid rgba(255,255,255,0.2)',
                          lineHeight: 1.3,
                        }}>
                          {suggestion.text_target}
                        </div>
                      )}

                      {/* Button row */}
                      <div style={{
                        display: 'flex',
                        borderTop: '1px solid rgba(255,255,255,0.2)',
                      }}>
                        {/* Text reveal button — hidden once revealed */}
                        {!isRevealed && (
                          <button
                            onMouseEnter={() => {
                              setRevealedSuggestionIds(prev => new Set([...prev, suggestion.id]));
                            }}
                            onClick={() => {
                              stopAudioRepeat();
                              handleSuggestionClick(suggestion);
                            }}
                            title="Reveal target text"
                            style={{
                              flex: 1,
                              background: 'rgba(255,255,255,0.08)',
                              border: 'none',
                              borderRight: (audioEnabled || !!suggestion.audio_file) ? '1px solid rgba(255,255,255,0.2)' : 'none',
                              color: 'white',
                              fontSize: 12,
                              fontWeight: 600,
                              padding: '5px 6px',
                              cursor: 'pointer',
                              transition: 'background 0.15s',
                            }}
                          >
                            Aa
                          </button>
                        )}

                        {/* Audio button — always for pre-generated audio, or when audioEnabled for on-demand */}
                        {(audioEnabled || !!suggestion.audio_file) && (
                          <button
                            onMouseEnter={handleAudioHover}
                            onMouseLeave={() => {
                              if (currentlyPlayingSuggestionRef.current === suggestion.id) {
                                stopAudioRepeat();
                              }
                            }}
                            title="Hear target text"
                            style={{
                              background: 'rgba(255,255,255,0.08)',
                              border: 'none',
                              color: 'white',
                              fontSize: 13,
                              padding: '5px 10px',
                              cursor: 'pointer',
                              transition: 'background 0.15s',
                            }}
                          >
                            🔊
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Chatbox - Sticky at bottom */}
        <div style={{
          position: 'sticky',
          bottom: 0,
          zIndex: 100,
          background: 'white',
          padding: '16px 20px',
          boxShadow: '0 -2px 8px rgba(0,0,0,0.1)',
        }}>
          <div style={{ maxWidth: '800px', margin: '0 auto' }}>
            {/* Recording indicator (task 4.1) — synced to F13 keydown edges, which
                the browser receives for free from the controller mapper. */}
            {recording && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 12, color: '#dc2626', fontWeight: 600 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', background: '#dc2626',
                  animation: 'pulse 1s ease-in-out infinite',
                }} />
                Recording (F13)
              </div>
            )}
            {/* Repeat-after-me drill. The screen is optional here — everything in
                this card is also spoken, and reachable by hotkey. */}
            {drill && (
              <div style={{
                marginBottom: 12,
                padding: '12px 16px',
                borderRadius: 14,
                background: drill.attempt || drill.skipped ? '#f1f5f9' : 'rgba(13,148,136,0.08)',
                border: `1px solid ${drill.attempt || drill.skipped ? '#e2e8f0' : 'rgba(13,148,136,0.35)'}`,
                animation: 'fadeIn 0.25s ease-out',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#0d9488', letterSpacing: 0.3 }}>
                    🔁 TRY SAYING
                  </span>
                  <span style={{ flex: 1, fontSize: 17, fontWeight: 600, color: '#0f172a', minWidth: 200 }}>
                    {drill.target}
                  </span>
                  {!drill.attempt && !drill.skipped && (
                    <>
                      <button
                        onClick={() => void repeatLastAudio()}
                        title="Hear it again, slowly (Alt+R)"
                        style={drillButtonStyle}
                      >🔊 again</button>
                      {drill.explanation && (
                        <button
                          onClick={() => void explainDrill()}
                          title="Why? (Alt+E)"
                          style={drillButtonStyle}
                        >❓ why</button>
                      )}
                      <button
                        onClick={() => void finishDrill()}
                        title="Skip this and carry on"
                        style={{ ...drillButtonStyle, color: '#94a3b8' }}
                      >skip</button>
                    </>
                  )}
                </div>
                <div style={{ marginTop: 6, fontSize: 12, color: drill.passed ? '#16a34a' : '#64748b' }}>
                  {drill.skipped
                    ? 'Skipped.'
                    : drill.attempt
                      ? `${drill.passed ? '✓ ' : ''}You said: ${drill.attempt}`
                      : 'Say it back — Alt+R to hear it again, Alt+E for why.'}
                </div>
              </div>
            )}
            <GameTextarea
              value={transcript}
              onChange={(val) => {
                setTranscript(val);
              }}
              onSubmit={(val) => void sendMessage(val)}
              busy={busy}
              placeholder={drill && !drill.attempt && !drill.skipped
                ? `say it back: "${drill.target}"`
                : `press CTRL + Windows key to speak in ${learning.name}...`}
              submitLabel="Send"
              busyLabel="Sending..."
              theme="light"
              autoFocus
              textareaRef={textareaRef}
              onAutoSendChange={handleAutoSendChange}
            />
          </div>
        </div>
      </div>

      {/* Pivot Editor Modal */}
      {showPivotEditor && (
        <div
          onClick={() => setShowPivotEditor(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'white', borderRadius: 16,
              width: '90%', maxWidth: 680, maxHeight: '82vh',
              display: 'flex', flexDirection: 'column',
              boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}
          >
            {/* Header */}
            <div style={{
              padding: '16px 20px', borderBottom: '1px solid #e5e7eb',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              flexShrink: 0,
            }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: '#111827' }}>
                  Conversation Starters
                </div>
                <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 3 }}>
                  {pivotEditorList.length} topics · {shownPivots.size} shown · ⭐ star · 👎 dislike · 🗑️ delete
                </div>
              </div>
              <button
                onClick={() => setShowPivotEditor(false)}
                style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af', padding: '4px 8px', lineHeight: 1 }}
              >✕</button>
            </div>

            {/* List */}
            <div style={{ overflowY: 'auto', padding: '4px 0' }}>
              {pivotEditorList.map((pivot, i) => {
                const isStarred = starredPivots.has(pivot.id);
                const isDisliked = dislikedPivots.has(pivot.id);
                const isShown = shownPivots.has(pivot.id);
                return (
                  <div
                    key={pivot.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 16px',
                      background: isStarred ? 'rgba(251,191,36,0.07)' : isDisliked ? 'rgba(239,68,68,0.04)' : 'transparent',
                      borderBottom: '1px solid #f3f4f6',
                    }}
                  >
                    {/* Row number */}
                    <span style={{ fontSize: 11, color: '#d1d5db', width: 20, textAlign: 'right', flexShrink: 0 }}>
                      {i + 1}
                    </span>

                    {/* Message text */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 13, lineHeight: 1.4,
                        color: isDisliked ? '#9ca3af' : '#1f2937',
                        textDecoration: isDisliked ? 'line-through' : 'none',
                      }}>
                        {pivot.opening_message}
                      </div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2, fontStyle: 'italic' }}>
                        {pivot.audio_message}
                      </div>
                    </div>

                    {/* Shown badge */}
                    {isShown && (
                      <span style={{
                        fontSize: 10, background: '#e0f2fe', color: '#0284c7',
                        borderRadius: 6, padding: '2px 6px', flexShrink: 0, fontWeight: 600,
                      }}>shown</span>
                    )}

                    {/* Star */}
                    <button
                      onClick={() => toggleStar(pivot.id)}
                      title={isStarred ? 'Unstar' : 'Star'}
                      style={{
                        background: 'none', border: 'none', fontSize: 16,
                        cursor: 'pointer', padding: '2px 4px', flexShrink: 0,
                        opacity: isStarred ? 1 : 0.25, transition: 'opacity 0.15s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                      onMouseLeave={e => (e.currentTarget.style.opacity = isStarred ? '1' : '0.25')}
                    >⭐</button>

                    {/* Dislike */}
                    <button
                      onClick={() => toggleDislike(pivot.id)}
                      title={isDisliked ? 'Undo dislike' : 'Dislike'}
                      style={{
                        background: 'none', border: 'none', fontSize: 16,
                        cursor: 'pointer', padding: '2px 4px', flexShrink: 0,
                        opacity: isDisliked ? 1 : 0.25, transition: 'opacity 0.15s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                      onMouseLeave={e => (e.currentTarget.style.opacity = isDisliked ? '1' : '0.25')}
                    >👎</button>

                    {/* Delete — only shown when disliked */}
                    {isDisliked ? (
                      <button
                        onClick={() => deletePivot(pivot.id)}
                        title="Delete permanently"
                        style={{
                          background: '#fee2e2', border: 'none', borderRadius: 6,
                          fontSize: 12, cursor: 'pointer', color: '#dc2626',
                          padding: '3px 8px', flexShrink: 0, fontWeight: 600,
                        }}
                      >🗑️</button>
                    ) : (
                      <div style={{ width: 42, flexShrink: 0 }} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%      { opacity: 0.3; }
        }
        @keyframes textWave {
          0%   { background-position: 200% center; }
          100% { background-position: -200% center; }
        }
        .text-wave {
          background: linear-gradient(90deg,
            rgba(255,255,255,0.45) 0%,
            rgba(255,255,255,1)    35%,
            rgba(190,215,255,0.9)  50%,
            rgba(255,255,255,1)    65%,
            rgba(255,255,255,0.45) 100%
          );
          background-size: 200% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: textWave 3s linear infinite;
        }
        @keyframes fadeInScale {
          0% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
          100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
        @keyframes typingBounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30% { transform: translateY(-4px); opacity: 1; }
        }
        .typing-dot {
          display: inline-block;
          font-size: 20px;
          color: #6b7280;
          animation: typingBounce 1s infinite;
        }
        @keyframes slideIn {
          0% { transform: translateX(100%); }
          100% { transform: translateX(0); }
        }
        @keyframes progressShimmer {
          0%   { background-position: 150% center; }
          100% { background-position: -50% center; }
        }
        .progress-shimmer {
          background: linear-gradient(90deg,
            rgba(99,102,241,0.12) 0%,
            rgba(99,102,241,0.55) 50%,
            rgba(99,102,241,0.12) 100%
          );
          background-size: 250% 100%;
          animation: progressShimmer 1.3s ease-in-out infinite;
        }
        /* Task 3.15: canned "someone is speaking" equalizer for the empty
           bubble's first-listen playback indicator — a fixed animation, not
           tied to the real signal or clip duration. */
        @keyframes equalizerBounce {
          0%, 100% { transform: scaleY(0.35); }
          50%      { transform: scaleY(1); }
        }
        .equalizer-bars {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
          height: 18px;
        }
        .equalizer-bar {
          width: 3px;
          height: 100%;
          border-radius: 2px;
          background: #6366f1;
          transform-origin: center;
          animation: equalizerBounce 0.9s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .equalizer-bar {
            animation: none;
            transform: scaleY(0.7);
            opacity: 0.7;
          }
        }
      `}</style>
    </>
  );
}
