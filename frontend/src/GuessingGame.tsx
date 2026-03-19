// GuessingGame.tsx
// Yes/No guessing game - LLM picks something, user asks questions
import React, { useEffect, useState, useRef } from "react";

type LangSpec = { code: string; name: string };

type Theme = {
  id: string;
  name: string;
  emoji: string;
  description: string;
};

type GameMessage = {
  id: number;
  timestamp: Date;
  side: "user" | "llm";
  text: string;
  isSystemMessage?: boolean;
  // Correction fields (for user messages)
  correctedText?: string;
  hadErrors?: boolean;
  errorExplanation?: string;
};

type GuessingGameProps = {
  apiBase?: string;
  fluent?: LangSpec;
  learning?: LangSpec;
  onBack?: () => void;
};

type GameState = "theme-selection" | "playing" | "game-over";

const THEMES: Theme[] = [
  {
    id: "animals",
    name: "Animals",
    emoji: "🦁",
    description: "Guess the animal I'm thinking of!"
  },
  // Easy to add more themes later:
  // { id: "mythical", name: "Mythical Creatures", emoji: "🐉", description: "..." },
  // { id: "countries", name: "Countries", emoji: "🌍", description: "..." },
];

// Vocabulary hints by theme
const VOCABULARY_HINTS: Record<string, Array<{spanish: string; english: string}>> = {
  animals: [
    { spanish: "garras", english: "claws" },
    { spanish: "garras afiladas", english: "sharp claws" },
    { spanish: "pezuñas", english: "hooves" },
    { spanish: "cuernos", english: "horns" },
    { spanish: "colmillos", english: "fangs / tusks" },
    { spanish: "pico", english: "beak" },
    { spanish: "plumas", english: "feathers" },
    { spanish: "alas", english: "wings" },
    { spanish: "escamas", english: "scales" },
    { spanish: "pelaje", english: "fur" },
    { spanish: "cola", english: "tail" },
    { spanish: "trompa", english: "trunk" },
    { spanish: "carnívoro", english: "carnivore" },
    { spanish: "herbívoro", english: "herbivore" },
    { spanish: "omnívoro", english: "omnivore" },
    { spanish: "mamífero", english: "mammal" },
    { spanish: "reptil", english: "reptile" },
    { spanish: "ave", english: "bird" },
    { spanish: "pez", english: "fish" },
    { spanish: "acuático", english: "aquatic" },
    { spanish: "terrestre", english: "terrestrial" },
    { spanish: "nocturno", english: "nocturnal" },
    { spanish: "diurno", english: "diurnal" },
    { spanish: "depredador", english: "predator" },
    { spanish: "presa", english: "prey" },
    { spanish: "domesticado", english: "domesticated" },
    { spanish: "salvaje", english: "wild" },
    { spanish: "en peligro de extinción", english: "endangered" },
  ]
};

const MIN_AUTO_SEND_LENGTH = 8;
const AUTO_SEND_DELAY_MS = 1200;

export default function GuessingGame({
  apiBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000",
  fluent = { code: "en", name: "English" },
  learning = { code: "es", name: "Spanish" },
  onBack,
}: GuessingGameProps) {
  const [gameState, setGameState] = useState<GameState>("theme-selection");
  const [selectedTheme, setSelectedTheme] = useState<Theme | null>(null);
  const [messages, setMessages] = useState<GameMessage[]>([]);
  const [transcript, setTranscript] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [isMockMode, setIsMockMode] = useState<boolean>(false);
  const [sessionId, setSessionId] = useState<string>("");
  const [guessCount, setGuessCount] = useState<number>(0);
  const [gameResult, setGameResult] = useState<"won" | "gave-up" | null>(null);
  const [revealedAnswer, setRevealedAnswer] = useState<string>("");
  const [showHints, setShowHints] = useState<boolean>(false);

  const autoSendTimer = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const previousTranscriptLengthRef = useRef<number>(0);

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

  // Auto-focus textarea when playing
  useEffect(() => {
    if (gameState === "playing" && textareaRef.current && !busy) {
      textareaRef.current.focus();
    }
  }, [gameState, busy]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Auto-send logic
  useEffect(() => {
    if (autoSendTimer.current) {
      window.clearTimeout(autoSendTimer.current);
      autoSendTimer.current = null;
    }

    if (gameState === "playing" && transcript.length >= MIN_AUTO_SEND_LENGTH && !busy) {
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
  }, [transcript, busy, gameState]);

  async function startGame(theme: Theme) {
    setSelectedTheme(theme);
    setSessionId(`guessing_${Date.now()}`);
    setGameState("playing");
    setMessages([
      {
        id: Date.now(),
        timestamp: new Date(),
        side: "llm",
        text: `I'm thinking of an animal! Ask me yes/no questions to figure out what it is. Good luck! 🎯`,
        isSystemMessage: true
      }
    ]);
    setGuessCount(0);
  }

  async function sendMessage() {
    const text = transcript.trim();
    if (!text || busy) return;

    setBusy(true);
    setGuessCount(prev => prev + 1);

    try {
      // Add user message
      const userMsg: GameMessage = {
        id: Date.now(),
        timestamp: new Date(),
        side: "user",
        text: text
      };
      setMessages((prev) => [...prev, userMsg]);

      // Call backend
      const res = await fetch(`${apiBase}/api/guessing/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          theme: selectedTheme?.id,
          user_input: text,
          guess_count: guessCount + 1,
          fluent: fluent,
          learning: learning
        })
      });

      if (!res.ok) {
        throw new Error('Turn API failed');
      }

      const data = await res.json();

      // Update user message with corrections if any
      if (data.had_errors && data.corrected_input) {
        setMessages((prev) => {
          const updated = [...prev];
          const userMsgIndex = updated.findIndex(m => m.id === userMsg.id);
          if (userMsgIndex >= 0) {
            updated[userMsgIndex] = {
              ...updated[userMsgIndex],
              correctedText: data.corrected_input,
              hadErrors: true,
              errorExplanation: data.error_explanation
            };
          }
          return updated;
        });
      }

      // Add LLM response
      const llmMsg: GameMessage = {
        id: Date.now() + 1,
        timestamp: new Date(),
        side: "llm",
        text: data.response
      };
      setMessages((prev) => [...prev, llmMsg]);

      // Check if won
      if (data.is_correct_guess) {
        setGameResult("won");
        setRevealedAnswer(data.answer);
        setGameState("game-over");
      }

      // Clear textarea after message appears
      setTranscript("");

    } catch (e) {
      console.error("Failed to send message:", e);
      alert("Failed to send message. Please try again.");
    } finally {
      setBusy(false);

      setTimeout(() => {
        if (textareaRef.current && gameState === "playing") {
          textareaRef.current.focus();
        }
      }, 100);
    }
  }

  async function handleGiveUp() {
    if (!window.confirm("Are you sure you want to give up?")) {
      return;
    }

    setBusy(true);

    try {
      const res = await fetch(`${apiBase}/api/guessing/giveup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          theme: selectedTheme?.id
        })
      });

      if (!res.ok) {
        throw new Error('Give up API failed');
      }

      const data = await res.json();

      // Add reveal message
      const revealMsg: GameMessage = {
        id: Date.now(),
        timestamp: new Date(),
        side: "llm",
        text: data.reveal_message,
        isSystemMessage: true
      };
      setMessages((prev) => [...prev, revealMsg]);

      setGameResult("gave-up");
      setRevealedAnswer(data.answer);
      setGameState("game-over");

    } catch (e) {
      console.error("Failed to give up:", e);
      alert("Failed to process give up. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function handlePlayAgain() {
    setGameState("theme-selection");
    setSelectedTheme(null);
    setMessages([]);
    setTranscript("");
    setGuessCount(0);
    setGameResult(null);
    setRevealedAnswer("");
    setSessionId("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  }

  // Theme Selection Screen
  if (gameState === "theme-selection") {
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

        <div style={{
          minHeight: '100vh',
          paddingTop: isMockMode ? 40 : 0,
          background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          padding: '20px',
        }}>
          {/* Back Button */}
          {onBack && (
            <button
              onClick={onBack}
              style={{
                position: 'absolute',
                top: isMockMode ? 60 : 20,
                left: 20,
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

          <div style={{
            background: 'white',
            borderRadius: '16px',
            padding: '40px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
            maxWidth: '600px',
            width: '100%',
          }}>
            <h1 style={{
              fontSize: '32px',
              fontWeight: 700,
              textAlign: 'center',
              marginBottom: '16px',
              color: '#1f2937',
            }}>
              Guessing Game 🎯
            </h1>
            <p style={{
              fontSize: '16px',
              color: '#6b7280',
              textAlign: 'center',
              marginBottom: '32px',
            }}>
              I'll think of something, and you ask yes/no questions to guess it!
            </p>

            <h2 style={{
              fontSize: '20px',
              fontWeight: 600,
              marginBottom: '16px',
              color: '#1f2937',
            }}>
              Choose a theme:
            </h2>

            <div style={{
              display: 'grid',
              gap: '16px',
            }}>
              {THEMES.map(theme => (
                <button
                  key={theme.id}
                  onClick={() => startGame(theme)}
                  style={{
                    padding: '20px',
                    background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                    border: 'none',
                    borderRadius: '12px',
                    color: 'white',
                    cursor: 'pointer',
                    transition: 'transform 0.2s, box-shadow 0.2s',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = 'translateY(-2px)';
                    e.currentTarget.style.boxShadow = '0 6px 20px rgba(0,0,0,0.25)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
                  }}
                >
                  <div style={{ fontSize: '40px', marginBottom: '8px' }}>{theme.emoji}</div>
                  <div style={{ fontSize: '20px', fontWeight: 600, marginBottom: '4px' }}>{theme.name}</div>
                  <div style={{ fontSize: '14px', opacity: 0.9 }}>{theme.description}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </>
    );
  }

  // Playing or Game Over Screen
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

      {/* Game Over Overlay */}
      {gameState === "game-over" && (
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
          minWidth: '400px',
        }}>
          <div style={{ fontSize: '64px', marginBottom: '16px' }}>
            {gameResult === "won" ? "🎉" : "😅"}
          </div>
          <h2 style={{ fontSize: '28px', marginBottom: '16px', color: gameResult === "won" ? '#10b981' : '#6b7280' }}>
            {gameResult === "won" ? "You Got It!" : "Nice Try!"}
          </h2>
          <p style={{ fontSize: '18px', color: '#6b7280', marginBottom: '8px' }}>
            {gameResult === "won" ? `You guessed it in ${guessCount} questions!` : `You made ${guessCount} guesses.`}
          </p>
          <p style={{ fontSize: '20px', fontWeight: 600, color: '#1f2937', marginBottom: '24px' }}>
            The answer was: <span style={{ color: '#10b981' }}>{revealedAnswer}</span>
          </p>
          <button
            onClick={handlePlayAgain}
            style={{
              padding: '12px 32px',
              fontSize: '16px',
              background: '#10b981',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Play Again
          </button>
        </div>
      )}

      <div style={{
        minHeight: '100vh',
        paddingTop: isMockMode ? 40 : 0,
        background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'system-ui, sans-serif',
        position: 'relative',
      }}>
        {/* Header - Sticky */}
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
            {gameState === "playing" && (
              <button
                onClick={() => void handleGiveUp()}
                disabled={busy}
                style={{
                  padding: '8px 16px',
                  fontSize: 14,
                  background: busy ? '#d1d5db' : '#ef4444',
                  color: 'white',
                  border: 'none',
                  borderRadius: 6,
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                Give Up
              </button>
            )}
            <h2 style={{ margin: 0, fontSize: '24px' }}>Guessing Game</h2>
          </div>

          <div style={{
            fontSize: '14px',
            color: '#6b7280',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}>
            <span>Theme: {selectedTheme?.emoji} {selectedTheme?.name}</span>
            {gameState === "playing" && (
              <>
                <span style={{
                  padding: '4px 12px',
                  background: '#10b981',
                  color: 'white',
                  borderRadius: 12,
                  fontSize: '12px',
                  fontWeight: 600,
                }}>
                  {guessCount} questions
                </span>
                <button
                  onClick={() => setShowHints(!showHints)}
                  style={{
                    padding: '6px 12px',
                    fontSize: '12px',
                    background: showHints ? '#10b981' : '#e5e7eb',
                    color: showHints ? 'white' : '#1f2937',
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  💡 {showHints ? 'Hide' : 'Show'} Hints
                </button>
              </>
            )}
          </div>
        </div>

        {/* Hints Panel */}
        {gameState === "playing" && showHints && selectedTheme && (
          <div style={{
            background: 'white',
            padding: '16px 24px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            borderBottom: '1px solid #e5e7eb',
          }}>
            <h3 style={{
              margin: '0 0 12px 0',
              fontSize: '16px',
              fontWeight: 600,
              color: '#1f2937',
            }}>
              💡 Helpful Vocabulary
            </h3>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: '8px',
              fontSize: '14px',
            }}>
              {VOCABULARY_HINTS[selectedTheme.id]?.map((hint, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: '6px 12px',
                    background: '#f3f4f6',
                    borderRadius: '6px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                >
                  <span style={{ fontWeight: 600, color: '#10b981' }}>{hint.spanish}</span>
                  <span style={{ color: '#6b7280', fontSize: '12px' }}>{hint.english}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Messages area */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          minHeight: 0,
        }}>
          {messages.map((message) => (
            <div
              key={message.id}
              style={{
                alignSelf: message.side === "user" ? 'flex-end' : 'flex-start',
                maxWidth: '70%',
              }}
            >
              {/* User message with optional corrections */}
              {message.side === "user" && message.hadErrors && message.correctedText ? (
                <div>
                  <div style={{
                    background: '#fef3c7',
                    color: '#78350f',
                    padding: '12px 16px',
                    borderRadius: '18px',
                    fontSize: '16px',
                    lineHeight: '1.4',
                    wordWrap: 'break-word',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                  }}>
                    <div style={{ textDecoration: 'line-through', opacity: 0.7 }}>
                      {message.text}
                    </div>
                    <div style={{ marginTop: '4px', fontWeight: 600 }}>
                      → {message.correctedText}
                    </div>
                  </div>
                  {message.errorExplanation && (
                    <div style={{
                      fontSize: '12px',
                      color: 'rgba(255,255,255,0.8)',
                      marginTop: '4px',
                      textAlign: 'right',
                      fontStyle: 'italic',
                    }}>
                      {message.errorExplanation}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{
                  background: message.side === "user" ? '#3b82f6' : (message.isSystemMessage ? '#10b981' : 'white'),
                  color: message.side === "user" || message.isSystemMessage ? 'white' : '#1f2937',
                  padding: '12px 16px',
                  borderRadius: '18px',
                  fontSize: '16px',
                  lineHeight: '1.4',
                  wordWrap: 'break-word',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                }}>
                  {message.text}
                </div>
              )}
              <div style={{
                fontSize: '12px',
                color: 'rgba(255,255,255,0.7)',
                marginTop: '4px',
                textAlign: message.side === "user" ? 'right' : 'left',
              }}>
                {message.side === "llm" ? "🎯" : ""} {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          ))}

          <div ref={messagesEndRef} />
        </div>

        {/* Chatbox - Sticky (only show when playing) */}
        {gameState === "playing" && (
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
                onChange={(e) => setTranscript(e.target.value)}
                onKeyDown={handleKeyDown}
                onMouseEnter={(e) => {
                  if (!busy) e.currentTarget.focus();
                }}
                placeholder="Ask a yes/no question or make a guess..."
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
                  background: transcript.trim() && !busy ? '#10b981' : '#d1d5db',
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
        )}
      </div>
    </>
  );
}
