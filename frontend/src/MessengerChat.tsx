// MessengerChat.tsx
// Persona-based adaptive language learning chat with Mateo
import React, { useEffect, useState, useRef } from "react";
import { GameTextarea, CorrectionTokens } from "./sharedGameComponents";
import { buildCorrectionTokens } from "./sharedGameUtils";
import type { CorrectionToken } from "./sharedGameUtils";

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
const LOCALE_MAP: Record<string, string> = { es: "es-MX", id: "id-ID", en: "en-US" };

// --- V2 Challenge Pair: 3-zone hover-reveal card (light theme for messenger) ---
function MessengerChallengePair({
  chunk, fluentName, learningName, audioUrl,
}: {
  chunk: ResponseChunk;
  fluentName: string;
  learningName: string;
  audioUrl: string | undefined;
}) {
  const [pinned, setPinned] = useState<Set<"native" | "learning">>(new Set());
  const [hovered, setHovered] = useState<"native" | "learning" | "audio" | null>(null);
  const isHoveringAudio = useRef(false);
  const isLoopRunning = useRef(false);
  const currentAudio = useRef<HTMLAudioElement | null>(null);
  const pendingResolve = useRef<(() => void) | null>(null);

  function stopAudio() {
    if (currentAudio.current) {
      currentAudio.current.pause();
      currentAudio.current.currentTime = 0;
      currentAudio.current = null;
    }
    if (pendingResolve.current) {
      pendingResolve.current();
      pendingResolve.current = null;
    }
  }

  function playOnce(): Promise<void> {
    return new Promise((resolve) => {
      if (!audioUrl) { resolve(); return; }
      stopAudio();
      const audio = new Audio(audioUrl);
      currentAudio.current = audio;
      pendingResolve.current = resolve;
      const done = () => { currentAudio.current = null; pendingResolve.current = null; resolve(); };
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
    });
  }

  async function startAudioLoop() {
    if (isLoopRunning.current) return;
    isLoopRunning.current = true;
    await new Promise(r => setTimeout(r, 500));
    while (isHoveringAudio.current) {
      await playOnce();
      if (!isHoveringAudio.current) break;
      await new Promise(r => setTimeout(r, 700));
    }
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
    stopAudio();
  }

  function togglePin(zone: "native" | "learning") {
    setPinned(prev => {
      const next = new Set(prev);
      if (next.has(zone)) next.delete(zone); else next.add(zone);
      return next;
    });
  }

  const zoneBase: React.CSSProperties = { padding: "3px 10px", borderRadius: 6, cursor: "pointer", transition: "background 0.15s", display: "flex", alignItems: "center", justifyContent: "space-between", border: "1px solid rgba(0,0,0,0.08)", minHeight: 26 };

  const nativeVisible = hovered === "native" || pinned.has("native");
  const learningVisible = hovered === "learning" || pinned.has("learning");

  return (
    <div style={{ background: "white", borderRadius: 18, padding: "8px 14px", boxShadow: "0 2px 8px rgba(0,0,0,0.15)", border: "2px solid rgba(99,102,241,0.2)", display: "flex", flexDirection: "column", gap: 0 }}>
      {/* Zone 1: native */}
      <div
        style={{ ...zoneBase, background: pinned.has("native") ? "rgba(0,0,0,0.07)" : hovered === "native" ? "rgba(0,0,0,0.05)" : "rgba(0,0,0,0.03)" }}
        onMouseEnter={() => setHovered("native")}
        onMouseLeave={() => setHovered(null)}
        onClick={() => togglePin("native")}
      >
        {nativeVisible
          ? <span style={{ fontSize: 13, color: "#374151" }}>{chunk.native_text}</span>
          : <span style={{ fontSize: 12, color: "#9ca3af", fontStyle: "italic" }}>Show {fluentName}</span>
        }
        {pinned.has("native") && <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 6, flexShrink: 0 }}>📌</span>}
      </div>

      {/* Zone 2: learning */}
      <div
        style={{ ...zoneBase, background: pinned.has("learning") ? "rgba(59,130,246,0.1)" : hovered === "learning" ? "rgba(59,130,246,0.08)" : "rgba(59,130,246,0.04)" }}
        onMouseEnter={() => setHovered("learning")}
        onMouseLeave={() => setHovered(null)}
        onClick={() => togglePin("learning")}
      >
        {learningVisible
          ? <span style={{ fontSize: 13, fontWeight: 600, color: "#3b82f6" }}>{chunk.text}</span>
          : <span style={{ fontSize: 12, color: "#93c5fd", fontStyle: "italic" }}>Show {learningName}</span>
        }
        {pinned.has("learning") && <span style={{ fontSize: 11, color: "#93c5fd", marginLeft: 6, flexShrink: 0 }}>📌</span>}
      </div>

      {/* Zone 3: audio replay — loops while hovering */}
      <div
        style={{
          ...zoneBase,
          justifyContent: "center",
          background: hovered === "audio" ? "rgba(59,130,246,0.1)" : "rgba(0,0,0,0.03)",
          fontSize: 12,
          color: hovered === "audio" ? "#3b82f6" : "#9ca3af",
          transition: "background 0.2s, color 0.2s",
          userSelect: "none",
        }}
        onMouseEnter={onAudioEnter}
        onMouseLeave={onAudioLeave}
      >
        🔊 {hovered === "audio" ? "replaying…" : "hover to replay"}
      </div>
    </div>
  );
}

export default function MessengerChat({
  apiBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000",
  fluent = { code: "en", name: "English" },
  learning = { code: "es", name: "Spanish" },
  onBack,
}: MessengerChatProps) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [messages, setMessages] = useState<MessengerMessage[]>([]);
  const [transcript, setTranscript] = useState<string>("");
  const [isMockMode, setIsMockMode] = useState<boolean>(false);
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


  // Feature toggles for realistic chat simulation
  const [streamLetters, setStreamLetters] = useState<boolean>(false);
  // Per-message chunk reveal counts (for progressive bubble-by-bubble appearance)
  const [visibleChunkCounts, setVisibleChunkCounts] = useState<Map<number, number>>(new Map());
  const [audioEnabled, setAudioEnabled] = useState<boolean>(false);
  const [liveReactions, setLiveReactions] = useState<boolean>(true);

  // Current reaction phase shown in the typing indicator
  const [reactionPhase, setReactionPhase] = useState<'reading' | 'thinking' | 'typing' | null>(null);

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

  // Helper function for delays
  function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Delay before revealing the next chunk — proportional to text length, simulating typing time
  function chunkRevealDelay(text: string): number {
    return Math.min(3500, Math.max(900, text.length * 55));
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

    setBusy(true);
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

    // Clear textarea right away
    setTranscript("");

    try {
      // Determine endpoint: use premade-start only when user picked a suggestion or typed a casual greeting
      const hasCharacterMessages = messages.some(m => m.side === "character");
      const isFirstMessage = !hasCharacterMessages;
      const usedSuggestion = matchedNative !== undefined;
      const usePremade = !isFirstMessage || usedSuggestion || isCasualGreeting(text);

      const endpoint = (isFirstMessage && usePremade)
        ? `${apiBase}/api/messenger/premade-start`
        : `${apiBase}/api/messenger/turn`;
      const body = (isFirstMessage && usePremade)
        ? JSON.stringify({ session_id: SESSION_ID })
        : JSON.stringify({ user_input: text, session_id: SESSION_ID, prompt_version: promptVersion });

      // Start API call immediately so it runs in parallel with reaction phases
      const fetchPromise = fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });

      // Animate reaction phases while the API is running
      if (liveReactions) {
        await delay(1200 + Math.random() * 600);   // ~1.2–1.8s before showing anything (showing the eyes)
        setReactionPhase('reading');
        await delay(900 + Math.random() * 600);   // ~0.9–1.5s
        setReactionPhase('thinking');
        await delay(700 + Math.random() * 500);   // ~0.7–1.2s
        setReactionPhase('typing');
      }

      const res = await fetchPromise;
      if (!res.ok) {
        throw new Error('Turn API failed');
      }

      const data = await res.json();
      setReactionPhase(null);

      // Generate user sentence audio if enabled (fetch before updating message so we can store URL)
      let userAudioFile: string | undefined;
      if (audioEnabled && data.corrected_input) {
        const locale = LOCALE_MAP[learning.code] || "es-MX";
        const audioPath = await fetchAudioUrl(data.corrected_input, locale);
        if (audioPath) userAudioFile = audioPath;
      }

      // UPDATE user's message with correction info (if any)
      setMessages((prev) => prev.map(msg => {
        if (msg.id !== userMsgId) return msg;
        const tokens = data.had_errors && msg.userInput && data.corrected_input
          ? buildCorrectionTokens(msg.userInput, data.corrected_input)
          : undefined;
        return {
          ...msg,
          correctedInput: data.corrected_input,
          correctionTokens: tokens,
          hadErrors: data.had_errors,
          errorExplanation: data.error_explanation,
          userAudioFile,
        };
      }));

      // Add character's response — all chunks stored, revealed one bubble at a time
      const characterMsgId = Date.now() + 1;
      const characterMsg: MessengerMessage = {
        id: characterMsgId,
        timestamp: new Date(),
        side: "character",
        responseChunks: data.response_chunks || [],
        suggestedReplies: data.suggested_replies || []
      };
      setVisibleChunkCounts(prev => new Map(prev).set(characterMsgId, 0));
      setMessages((prev) => [...prev, characterMsg]);

      // Reveal each chunk as its own bubble, with a delay based on the previous chunk's length
      const chunks: ResponseChunk[] = data.response_chunks || [];
      for (let i = 0; i < chunks.length; i++) {
        setVisibleChunkCounts(prev => new Map(prev).set(characterMsgId, i + 1));

        if (streamLetters) {
          setStreamingMessageId(characterMsgId);
          await streamText(characterMsgId, i, chunks[i].text || '');
          setStreamingMessageId(null);
        }

        if (i < chunks.length - 1) {
          setIsTyping(true);
          await delay(chunkRevealDelay(chunks[i].text || ''));
          setIsTyping(false);
        }
      }

      // Update current suggestions for display and reset revealed state
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

      // Play user sentence audio first (if generated), then response audio
      if (userAudioFile) {
        await playAudioUrl(`${apiBase}${userAudioFile}`);
      }
      await playResponseAudio(data.response_chunks);

    } catch (e) {
      console.error("Failed to send message:", e);
      alert("Failed to send message. Please try again.");
    } finally {
      setBusy(false);
      setIsTyping(false);
      setReactionPhase(null);
      setStreamingMessageId(null);
    }
  }

  async function playResponseAudio(chunks: ResponseChunk[]) {
    for (const chunk of chunks) {
      if (chunk.modality === "audio" && chunk.audio_file && chunk.language === "target") {
        await playAudioUrl(`${apiBase}${chunk.audio_file}`);
      }
    }
  }

  function playAudioUrl(url: string): Promise<void> {
    return new Promise((resolve) => {
      const audio = new Audio(url);
      audio.onended = () => resolve();
      audio.onerror = () => resolve(); // Continue even if audio fails
      audio.play().catch(() => resolve());
    });
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
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6b7280', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={liveReactions}
                  onChange={(e) => setLiveReactions(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                💬 Reactions
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6366f1', cursor: 'pointer', fontWeight: promptVersion === "v2" ? 700 : 400 }}>
                <input
                  type="checkbox"
                  checked={promptVersion === "v2"}
                  onChange={() => setPromptVersion(v => v === "v1" ? "v2" : "v1")}
                  style={{ cursor: 'pointer' }}
                />
                ✨ v2: last sentence in Spanish
              </label>
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
              Start chatting with Sombongo in {learning.name}...
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
                  {message.hadErrors ? (
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
                    {message.userAudioFile && (
                      <button
                        onMouseEnter={() => message.userAudioFile && void playAudioUrl(`${apiBase}${message.userAudioFile}`)}
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
                      if (chunk.is_challenge) {
                        return (
                          <MessengerChallengePair
                            key={`challenge-${message.id}-${idx}`}
                            chunk={chunk}
                            fluentName={fluent.name}
                            learningName={learning.name}
                            audioUrl={chunk.audio_file ? `${apiBase}${chunk.audio_file}` : undefined}
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
                              onClick={() => chunk.audio_file && playAudioUrl(`${apiBase}${chunk.audio_file}`)}
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
                    Sombongo · {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
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
                  ? `Sombongo is ${reactionPhase}...`
                  : 'Sombongo is typing...'
                }
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Suggestions Bar - Sticky above chatbox */}
        {currentSuggestions.length > 0 && !busy && (
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
              <div style={{
                fontSize: '12px',
                color: '#6b7280',
                marginBottom: '8px',
                fontWeight: 600,
              }}>
                💬 Quick replies (hover to see {learning.name}):
              </div>
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '8px',
              }}>
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
                      await playAudioUrl(`${apiBase}${url}`);
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
                    const locale = LOCALE_MAP[learning.code] || "es-MX";
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
            <GameTextarea
              value={transcript}
              onChange={(val) => {
                setTranscript(val);
              }}
              onSubmit={(val) => void sendMessage(val)}
              busy={busy}
              placeholder={`press CTRL + Windows key to speak in ${learning.name}...`}
              submitLabel="Send"
              busyLabel="Sending..."
              theme="light"
              autoFocus
              textareaRef={textareaRef}
            />
          </div>
        </div>
      </div>

      <style>{`
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
      `}</style>
    </>
  );
}
