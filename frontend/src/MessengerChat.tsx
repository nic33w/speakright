// MessengerChat.tsx
// Persona-based adaptive language learning chat with Mateo
import React, { useEffect, useState, useRef } from "react";

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
  hadErrors?: boolean;
  errorExplanation?: string;

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

const MIN_AUTO_SEND_LENGTH = 8;
const AUTO_SEND_DELAY_MS = 1200;
const SESSION_ID = `sess_${Date.now()}`;

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

  // Feature toggles for realistic chat simulation
  const [delayMessages, setDelayMessages] = useState<boolean>(false);
  const [streamLetters, setStreamLetters] = useState<boolean>(false);

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

  const autoSendTimer = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const previousTranscriptLengthRef = useRef<number>(0);

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

  // Auto-send logic (debounced for typing, immediate for Wispr)
  useEffect(() => {
    if (autoSendTimer.current) {
      window.clearTimeout(autoSendTimer.current);
      autoSendTimer.current = null;
    }

    if (transcript.length >= MIN_AUTO_SEND_LENGTH && !busy) {
      const lengthIncrease = transcript.length - previousTranscriptLengthRef.current;
      const isWisprInput = lengthIncrease >= 10;
      const delayMs = isWisprInput ? 100 : AUTO_SEND_DELAY_MS;

      autoSendTimer.current = window.setTimeout(() => {
        void sendMessage();
      }, delayMs);
    }

    previousTranscriptLengthRef.current = transcript.length;

    return () => {
      if (autoSendTimer.current) {
        window.clearTimeout(autoSendTimer.current);
        autoSendTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcript, busy]);

  // Helper function for delays
  function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Helper function to stream text letter by letter
  async function streamText(messageId: number, chunkIndex: number, fullText: string): Promise<void> {
    const key = `${messageId}-${chunkIndex}`;
    for (let i = 0; i <= fullText.length; i++) {
      setStreamedText(prev => new Map(prev).set(key, fullText.slice(0, i)));
      await delay(25); // 25ms per character
    }
  }

  async function sendMessage() {
    const text = transcript.trim();
    if (!text || busy) return;

    setBusy(true);
    const userMsgId = Date.now();

    // IMMEDIATELY show user's message (before API call)
    const pendingUserMsg: MessengerMessage = {
      id: userMsgId,
      timestamp: new Date(),
      side: "user",
      userInput: text,
      hadErrors: false // Will update after API response
    };
    setMessages((prev) => [...prev, pendingUserMsg]);

    // Clear textarea right away
    setTranscript("");

    try {
      // Determine endpoint: use premade-start for the first message (no character messages yet)
      const hasCharacterMessages = messages.some(m => m.side === "character");
      const endpoint = !hasCharacterMessages
        ? `${apiBase}/api/messenger/premade-start`
        : `${apiBase}/api/messenger/turn`;
      const body = !hasCharacterMessages
        ? JSON.stringify({ session_id: SESSION_ID })
        : JSON.stringify({ user_input: text, session_id: SESSION_ID });

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });

      if (!res.ok) {
        throw new Error('Turn API failed');
      }

      const data = await res.json();

      // UPDATE user's message with correction info (if any)
      setMessages((prev) => prev.map(msg =>
        msg.id === userMsgId
          ? {
              ...msg,
              correctedInput: data.corrected_input,
              hadErrors: data.had_errors,
              errorExplanation: data.error_explanation
            }
          : msg
      ));

      // Delay before showing character's response (simulates typing)
      if (delayMessages) {
        setIsTyping(true);
        await delay(800 + Math.random() * 400); // 800-1200ms
        setIsTyping(false);
      }

      // Add character's response
      const characterMsgId = Date.now() + 1;
      const characterMsg: MessengerMessage = {
        id: characterMsgId,
        timestamp: new Date(),
        side: "character",
        responseChunks: delayMessages ? [] : data.response_chunks, // Start empty if delaying
        suggestedReplies: data.suggested_replies || []
      };
      setMessages((prev) => [...prev, characterMsg]);

      // If delaying messages, add chunks one by one
      if (delayMessages && data.response_chunks) {
        for (let i = 0; i < data.response_chunks.length; i++) {
          const chunk = data.response_chunks[i];

          // Add this chunk to the message
          setMessages((prev) => prev.map(msg =>
            msg.id === characterMsgId
              ? { ...msg, responseChunks: [...(msg.responseChunks || []), chunk] }
              : msg
          ));

          // Stream letters if enabled
          if (streamLetters) {
            setStreamingMessageId(characterMsgId);
            await streamText(characterMsgId, i, chunk.text);
            setStreamingMessageId(null);
          }

          // Delay before next chunk (if not last)
          if (i < data.response_chunks.length - 1) {
            await delay(500 + Math.random() * 300); // 500-800ms between chunks
          }
        }
      } else if (streamLetters && data.response_chunks) {
        // Stream letters without delay between messages
        setStreamingMessageId(characterMsgId);
        for (let i = 0; i < data.response_chunks.length; i++) {
          await streamText(characterMsgId, i, data.response_chunks[i].text);
        }
        setStreamingMessageId(null);
      }

      // Update current suggestions for display and reset revealed state
      setCurrentSuggestions(data.suggested_replies || []);
      setRevealedSuggestionIds(new Set());
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

      // Play audio chunks sequentially
      await playResponseAudio(data.response_chunks);

    } catch (e) {
      console.error("Failed to send message:", e);
      alert("Failed to send message. Please try again.");
    } finally {
      setBusy(false);
      setIsTyping(false);
      setStreamingMessageId(null);

      // Refocus textarea
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
        }
      }, 100);
    }
  }

  async function playResponseAudio(chunks: ResponseChunk[]) {
    for (const chunk of chunks) {
      if (chunk.modality === "audio" && chunk.audio_file) {
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
    // Stop any ongoing audio repeat
    currentlyPlayingSuggestionRef.current = null;
    if (audioRepeatTimeoutRef.current) {
      window.clearTimeout(audioRepeatTimeoutRef.current);
      audioRepeatTimeoutRef.current = null;
    }
    // Fill textarea with target language version
    setTranscript(suggestion.text_target);
    // Clear current suggestions and revealed state
    setCurrentSuggestions([]);
    setRevealedSuggestionIds(new Set());
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

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
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
                  checked={delayMessages}
                  onChange={(e) => setDelayMessages(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                Delay msgs
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6b7280', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={streamLetters}
                  onChange={(e) => setStreamLetters(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                Stream text
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
                  {message.hadErrors ? (
                    <>
                      <div style={{
                        background: '#fef3c7',
                        color: '#92400e',
                        padding: '12px 16px',
                        borderRadius: '18px',
                        fontSize: '16px',
                        lineHeight: '1.4',
                        wordWrap: 'break-word',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                        marginBottom: '8px',
                      }}>
                        <div style={{ textDecoration: 'line-through', opacity: 0.6 }}>
                          {message.userInput}
                        </div>
                        <div style={{ marginTop: '4px', fontWeight: 600 }}>
                          → {message.correctedInput}
                        </div>
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
                  }}>
                    {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              ) : (
                // Character's message
                <div>
                  <div style={{
                    background: 'white',
                    padding: '12px 16px',
                    borderRadius: '18px',
                    fontSize: '16px',
                    lineHeight: '1.4',
                    wordWrap: 'break-word',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                  }}>
                    {message.responseChunks?.map((chunk, idx) => {
                      // Skip audio-only chunks with no display text (premade TTS playback)
                      if (chunk.modality === "audio" && !chunk.text) return null;

                      // Check if we're streaming this chunk
                      const streamKey = `${message.id}-${idx}`;
                      const isStreaming = streamingMessageId === message.id && streamedText.has(streamKey);
                      const displayText = isStreaming ? (streamedText.get(streamKey) || "") : chunk.text;

                      return (
                        <div key={idx} style={{ marginBottom: idx < (message.responseChunks?.length || 0) - 1 ? '8px' : 0 }}>
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
                    })}
                  </div>

                  {/* Suggested Replies removed - now only shown in sticky bar above chatbox */}

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
          {isTyping && (
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
                gap: 4,
              }}>
                <span className="typing-dot" style={{ animationDelay: '0ms' }}>•</span>
                <span className="typing-dot" style={{ animationDelay: '150ms' }}>•</span>
                <span className="typing-dot" style={{ animationDelay: '300ms' }}>•</span>
              </div>
              <div style={{
                fontSize: '12px',
                color: 'rgba(255,255,255,0.7)',
                marginTop: '4px',
              }}>
                Sombongo is typing...
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
                  const hasAudio = !!suggestion.audio_file;

                  // Stop any current audio playback
                  const stopAudioRepeat = () => {
                    if (audioRepeatTimeoutRef.current) {
                      window.clearTimeout(audioRepeatTimeoutRef.current);
                      audioRepeatTimeoutRef.current = null;
                    }
                    currentlyPlayingSuggestionRef.current = null;
                  };

                  // Function to play audio and schedule repeat for THIS suggestion only
                  const startAudioRepeat = () => {
                    if (!hasAudio) return;

                    // Stop any existing playback first
                    stopAudioRepeat();

                    // Mark this suggestion as the one currently playing
                    currentlyPlayingSuggestionRef.current = suggestion.id;

                    const playAndRepeat = async () => {
                      // Only continue if THIS suggestion is still the one being hovered
                      if (currentlyPlayingSuggestionRef.current !== suggestion.id) return;

                      await playAudioUrl(`${apiBase}${suggestion.audio_file}`);

                      // Small delay before repeat (500ms), but only if still hovering this one
                      if (currentlyPlayingSuggestionRef.current === suggestion.id) {
                        audioRepeatTimeoutRef.current = window.setTimeout(playAndRepeat, 500);
                      }
                    };

                    void playAndRepeat();
                  };

                  return (
                    <button
                      key={suggestion.id}
                      onClick={() => {
                        stopAudioRepeat();
                        handleSuggestionClick(suggestion);
                      }}
                      onMouseEnter={() => {
                        // Mark as revealed (stays visible)
                        if (!isRevealed) {
                          setRevealedSuggestionIds(prev => new Set([...prev, suggestion.id]));
                        }
                        // Start audio repeat for greetings with audio
                        if (hasAudio) {
                          startAudioRepeat();
                        }
                      }}
                      onMouseLeave={() => {
                        // Only stop if this suggestion is the one currently playing
                        if (currentlyPlayingSuggestionRef.current === suggestion.id) {
                          stopAudioRepeat();
                        }
                      }}
                      style={{
                        padding: '10px 16px',
                        background: isRevealed
                          ? 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)'
                          : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                        border: 'none',
                        borderRadius: '20px',
                        fontSize: '14px',
                        color: 'white',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        boxShadow: isRevealed ? '0 4px 12px rgba(0,0,0,0.25)' : '0 2px 8px rgba(0,0,0,0.15)',
                        fontWeight: 500,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: isRevealed ? '4px' : '0',
                        minWidth: isRevealed ? '120px' : 'auto',
                      }}
                    >
                      <span>
                        {suggestion.text_native}
                        {hasAudio && <span style={{ marginLeft: 6, opacity: 0.7 }}>🔊</span>}
                      </span>
                      {isRevealed && (
                        <span style={{
                          fontSize: '12px',
                          opacity: 0.9,
                          fontStyle: 'italic',
                          borderTop: '1px solid rgba(255,255,255,0.3)',
                          paddingTop: '4px',
                          marginTop: '2px',
                        }}>
                          {suggestion.text_target}
                        </span>
                      )}
                    </button>
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
          <div style={{
            maxWidth: '800px',
            margin: '0 auto',
            display: 'flex',
            gap: '12px',
            alignItems: 'flex-end',
          }}>
            <textarea
              ref={textareaRef}
              value={transcript}
              onChange={(e) => {
                setTranscript(e.target.value);
                // If user starts typing something custom, clear suggestions
                const newValue = e.target.value;
                if (currentSuggestions.length > 0) {
                  const matchesSuggestion = currentSuggestions.some(
                    s => s.text_target.startsWith(newValue) || newValue === ""
                  );
                  if (!matchesSuggestion && newValue.length > 3) {
                    // Stop any ongoing audio repeat
                    currentlyPlayingSuggestionRef.current = null;
                    if (audioRepeatTimeoutRef.current) {
                      window.clearTimeout(audioRepeatTimeoutRef.current);
                      audioRepeatTimeoutRef.current = null;
                    }
                    setCurrentSuggestions([]);
                    setRevealedSuggestionIds(new Set());
                  }
                }
              }}
              onKeyDown={handleKeyDown}
              onMouseEnter={(e) => {
                if (!busy) e.currentTarget.focus();
              }}
              placeholder={`press CTRL + Windows key to speak in ${learning.name}...`}
              disabled={busy}
              autoFocus
              style={{
                flex: 1,
                minHeight: '48px',
                maxHeight: '120px',
                padding: '12px 16px',
                fontSize: '16px',
                border: '2px solid #e5e7eb',
                borderRadius: 24,
                resize: 'none',
                fontFamily: 'system-ui, sans-serif',
                boxSizing: 'border-box',
                outline: 'none',
                opacity: busy ? 0.6 : 1,
              }}
            />
            <button
              onClick={() => void sendMessage()}
              disabled={!transcript.trim() || busy}
              style={{
                padding: '12px 24px',
                fontSize: '16px',
                background: transcript.trim() && !busy ? '#3b82f6' : '#d1d5db',
                color: 'white',
                border: 'none',
                borderRadius: 24,
                cursor: transcript.trim() && !busy ? 'pointer' : 'not-allowed',
                fontWeight: 600,
                transition: 'background 0.2s',
              }}
            >
              {busy ? 'Sending...' : 'Send'}
            </button>
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
