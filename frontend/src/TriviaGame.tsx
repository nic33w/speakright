// TriviaGame.tsx
// Trivia game where users translate between languages with hint cards
import React, { useEffect, useState, useRef } from "react";
import SPANISH_TRIVIA_RAW from './spanish_trivia_game.json';
import ENGLISH_INDONESIAN_TRIVIA_RAW from './english_indonesian_trivia_game.json';
import INDONESIAN_ENGLISH_TRIVIA_RAW from './indonesian_english_casual_trivia_game.json';

type LangSpec = { code: string; name: string };

type SpanishTriviaQuestion = {
  id: number;
  spanish: string;
  english: string;
  hints: Array<{ english: string; spanish: string }>;
};

type IndonesianTriviaQuestion = {
  id: number;
  english: string;
  indonesian: string;
  hints: Array<{ indonesian: string; english: string }>;
};

type TriviaQuestion = {
  id: number;
  nativeText: string;    // The text in the fluent language (what they see)
  learningText: string;  // The text in the learning language (what they need to type)
  hints: Array<{ native: string; learning: string }>;
};

type TriviaGameProps = {
  apiBase?: string;
  fluent?: LangSpec;
  learning?: LangSpec;
  onBack?: () => void;
};

const TIMER_DURATION_SECONDS = 40; // Easily configurable
const MIN_AUTO_SEND_LENGTH = 8;
const AUTO_SEND_DELAY_MS = 1200;
const NEXT_QUESTION_DELAY_MS = 5000; // Delay after audio before next question (5 seconds)

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to normalize trivia questions based on language combination
function loadTriviaQuestions(fluent: LangSpec, learning: LangSpec): TriviaQuestion[] {
  // English fluent → Spanish learning
  if (fluent.code === 'en' && learning.code === 'es') {
    const raw = (SPANISH_TRIVIA_RAW as any).sentences as SpanishTriviaQuestion[];
    return raw.map(q => ({
      id: q.id,
      nativeText: q.english,
      learningText: q.spanish,
      hints: q.hints.map(h => ({ native: h.english, learning: h.spanish })),
    }));
  }

  // Indonesian fluent → English learning
  if (fluent.code === 'id' && learning.code === 'en') {
    const raw = (ENGLISH_INDONESIAN_TRIVIA_RAW as any).sentences as IndonesianTriviaQuestion[];
    return raw.map(q => ({
      id: q.id,
      nativeText: q.indonesian,
      learningText: q.english,
      hints: q.hints.map(h => ({ native: h.indonesian, learning: h.english })),
    }));
  }

  // English fluent → Indonesian learning
  if (fluent.code === 'en' && learning.code === 'id') {
    const raw = (INDONESIAN_ENGLISH_TRIVIA_RAW as any).sentences as IndonesianTriviaQuestion[];
    return raw.map(q => ({
      id: q.id,
      nativeText: q.english,
      learningText: q.indonesian,
      hints: q.hints.map(h => ({ native: h.english, learning: h.indonesian })),
    }));
  }

  // Default fallback to Spanish (for English → Spanish)
  const raw = (SPANISH_TRIVIA_RAW as any).sentences as SpanishTriviaQuestion[];
  return raw.map(q => ({
    id: q.id,
    nativeText: q.english,
    learningText: q.spanish,
    hints: q.hints.map(h => ({ native: h.english, learning: h.spanish })),
  }));
}

export default function TriviaGame({
  apiBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000",
  fluent: initialFluent = { code: "en", name: "English" },
  learning: initialLearning = { code: "es", name: "Spanish" },
  onBack,
}: TriviaGameProps) {
  const [isMockMode, setIsMockMode] = useState<boolean>(false);
  const [triviaQuestions, setTriviaQuestions] = useState<TriviaQuestion[]>([]);
  const [currentSentence, setCurrentSentence] = useState<TriviaQuestion | null>(null);
  const [usedSentenceIds, setUsedSentenceIds] = useState<Set<number>>(new Set());
  const [transcript, setTranscript] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState<number>(TIMER_DURATION_SECONDS);
  const [timerActive, setTimerActive] = useState<boolean>(false);
  const [viewedHints, setViewedHints] = useState<Set<number>>(new Set());
  const [answerStatus, setAnswerStatus] = useState<'idle' | 'checking' | 'correct' | 'incorrect'>('idle');
  const [feedbackMessage, setFeedbackMessage] = useState<string>("");
  const [sessionId] = useState<string>(`trivia_${Date.now()}`);
  const [paused, setPaused] = useState<boolean>(false);

  // Proximity-based scaling state
  const [mousePosition, setMousePosition] = useState<{ x: number; y: number } | null>(null);
  const [closestHintIndex, setClosestHintIndex] = useState<number | null>(null);
  const [closestHintScale, setClosestHintScale] = useState<number>(14);

  const autoSendTimer = useRef<number | null>(null);
  const lastSentRef = useRef<number>(0);
  const previousTranscriptLengthRef = useRef<number>(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const timerExpiredInProgress = useRef<boolean>(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const hintCardsRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Initialize trivia questions based on language selection
  useEffect(() => {
    const questions = loadTriviaQuestions(initialFluent, initialLearning);
    setTriviaQuestions(questions);
  }, [initialFluent, initialLearning]);

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

  // Initialize with first question once trivia questions are loaded
  useEffect(() => {
    if (triviaQuestions.length > 0 && !currentSentence) {
      loadNextSentence();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triviaQuestions]);

  // Auto-focus textarea when new question loads, when resumed, or when ready for input
  useEffect(() => {
    if (currentSentence && textareaRef.current && timerActive && !paused && !busy) {
      textareaRef.current.focus();
    }
  }, [currentSentence, timerActive, paused, busy, answerStatus]);

  // Cleanup: stop audio on unmount
  useEffect(() => {
    return () => {
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current = null;
      }
    };
  }, []);

  // Initialize hint card refs array when hints change
  useEffect(() => {
    if (currentSentence) {
      hintCardsRefs.current = new Array(currentSentence.hints.length).fill(null);
    }
  }, [currentSentence]);

  // Reset proximity scaling state when question changes
  useEffect(() => {
    setMousePosition(null);
    setClosestHintIndex(null);
    setClosestHintScale(14);
  }, [currentSentence?.id]);

  // Timer countdown logic
  useEffect(() => {
    if (!timerActive || timerSeconds <= 0 || paused) return;

    const interval = setInterval(() => {
      setTimerSeconds(prev => {
        if (prev <= 1) {
          setTimerActive(false);
          void handleTimerExpired();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [timerActive, timerSeconds, paused]);

  // Auto-send logic (debounced for typing, immediate for Wispr)
  useEffect(() => {
    if (autoSendTimer.current) {
      window.clearTimeout(autoSendTimer.current);
      autoSendTimer.current = null;
    }

    if (transcript.length >= MIN_AUTO_SEND_LENGTH && timerActive && !paused) {
      const lengthIncrease = transcript.length - previousTranscriptLengthRef.current;
      const isWisprInput = lengthIncrease >= 10;
      const delayMs = isWisprInput ? 100 : AUTO_SEND_DELAY_MS;

      autoSendTimer.current = window.setTimeout(() => {
        const now = Date.now();
        if (now - lastSentRef.current > 700) {
          void submitAnswer();
        }
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
  }, [transcript, paused]);

  function loadNextSentence() {
    const available = triviaQuestions.filter(s => !usedSentenceIds.has(s.id));

    if (available.length === 0) {
      // All questions answered
      setCurrentSentence(null);
      setTimerActive(false);
      return;
    }

    const next = available[Math.floor(Math.random() * available.length)];
    setUsedSentenceIds(prev => new Set([...prev, next.id]));
    setCurrentSentence(next);
    setViewedHints(new Set());
    setTranscript("");
    setTimerSeconds(TIMER_DURATION_SECONDS);
    setTimerActive(true);
    setAnswerStatus('idle');
    setFeedbackMessage('');
    lastSentRef.current = Date.now();

    // Focus textarea for new question
    setTimeout(() => {
      if (textareaRef.current && !paused) {
        textareaRef.current.focus();
      }
    }, 100);
  }

  function checkFuzzyMatch(userAnswer: string, correctAnswer: string): boolean {
    const normalize = (text: string) => {
      return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // remove accents
        .replace(/[.,;:!?¿¡\-_…]+/g, '') // remove punctuation
        .replace(/\s+/g, ' ')
        .trim();
    };

    return normalize(userAnswer) === normalize(correctAnswer);
  }

  async function submitAnswer() {
    if (!currentSentence) return;

    const userAnswer = transcript.trim();
    if (!userAnswer) return;
    if (busy || answerStatus === 'checking') return;

    lastSentRef.current = Date.now();
    setBusy(true);
    setAnswerStatus('checking');

    // STEP 1: Fuzzy match check
    const fuzzyMatch = checkFuzzyMatch(userAnswer, currentSentence.learningText);

    if (fuzzyMatch) {
      // Exact or close match - show green checkmark
      await handleCorrectAnswer(true);
      setBusy(false);
      return;
    }

    // STEP 2: LLM semantic check via backend
    try {
      const response = await fetch(`${apiBase}/api/trivia/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          user_answer: userAnswer,
          correct_answer: currentSentence.learningText,
          prompt_text: currentSentence.nativeText,
          learning: initialLearning,
          fluent: initialFluent,
        }),
      });

      if (!response.ok) {
        throw new Error('Check failed');
      }

      const data = await response.json();

      if (data.is_correct) {
        await handleCorrectAnswer(false);
      } else {
        handleIncorrectAnswer(data.feedback);
      }
    } catch (e) {
      console.error(e);
      handleIncorrectAnswer("Check failed. Try again!");
    } finally {
      setBusy(false);
    }
  }

  async function handleCorrectAnswer(wasFuzzyMatch: boolean) {
    setAnswerStatus('correct');
    setFeedbackMessage(wasFuzzyMatch ? "Perfect!" : "Correct!");
    setTimerActive(false);

    // Show checkmark for 1 second
    await delay(1000);

    // Load next sentence
    loadNextSentence();
  }

  function handleIncorrectAnswer(feedback: string) {
    setAnswerStatus('incorrect');
    setFeedbackMessage(feedback || "Try again!");

    // Show red X for 1.5 seconds, then refocus textarea
    setTimeout(() => {
      if (timerActive) {
        setAnswerStatus('idle');
        setFeedbackMessage('');
        // Refocus textarea after feedback clears
        if (textareaRef.current && !paused) {
          textareaRef.current.focus();
        }
      }
    }, 1500);

    // Timer keeps running - user can try again
    setTranscript('');
  }

  async function handleTimerExpired() {
    if (!currentSentence || timerExpiredInProgress.current) return;

    timerExpiredInProgress.current = true;

    // Clear auto-send timer to prevent race condition
    if (autoSendTimer.current) {
      window.clearTimeout(autoSendTimer.current);
      autoSendTimer.current = null;
    }

    // Clear transcript and prevent further submissions
    setTranscript('');
    setBusy(true); // Prevent submitAnswer from running during this process
    setAnswerStatus('idle');
    setFeedbackMessage("Time's up!");

    // Get appropriate locales based on language selection
    const fluentLocale = initialFluent.code === 'es' ? 'es-MX' : initialFluent.code === 'id' ? 'id-ID' : 'en-US';
    const learningLocale = initialLearning.code === 'es' ? 'es-MX' : initialLearning.code === 'id' ? 'id-ID' : 'en-US';

    // Play native language audio (what they should have seen/understood)
    await playAudioForText(currentSentence.nativeText, fluentLocale);

    // Play learning language audio (the correct answer)
    await playAudioForText(currentSentence.learningText, learningLocale);

    // Show "Here's the next question" message
    setFeedbackMessage("Here's the next question");
    await delay(NEXT_QUESTION_DELAY_MS);

    // Load next sentence
    loadNextSentence();

    // Reset busy state and flag
    setBusy(false);
    timerExpiredInProgress.current = false;
  }

  async function playAudioForText(text: string, locale: string): Promise<void> {
    try {
      const response = await fetch(`${apiBase}/api/trivia/audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, locale }),
      });

      if (!response.ok) {
        console.error('Audio generation failed');
        return;
      }

      const data = await response.json();
      const audioUrl = data.audio_file.startsWith('http')
        ? data.audio_file
        : `${apiBase}${data.audio_file}`;

      await playAudioUrl(audioUrl);
    } catch (e) {
      console.error("Audio playback failed:", e);
    }
  }

  function playAudioUrl(url: string): Promise<void> {
    return new Promise((resolve) => {
      // Stop any currently playing audio
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current.currentTime = 0;
        currentAudioRef.current = null;
      }

      const audio = new Audio(url);
      currentAudioRef.current = audio;

      audio.onended = () => {
        currentAudioRef.current = null;
        resolve();
      };
      audio.onerror = () => {
        currentAudioRef.current = null;
        resolve();
      };
      audio.play().catch(() => {
        currentAudioRef.current = null;
        resolve();
      });
    });
  }

  function handleHintView(index: number) {
    setViewedHints(prev => new Set([...prev, index]));
  }

  /**
   * Calculate Euclidean distance from cursor to nearest edge of hint card
   */
  function calculateDistance(
    cursorX: number,
    cursorY: number,
    cardElement: HTMLDivElement
  ): number {
    const rect = cardElement.getBoundingClientRect();

    // Calculate distance to nearest edge (0 if inside the box)
    const dx = Math.max(rect.left - cursorX, 0, cursorX - rect.right);
    const dy = Math.max(rect.top - cursorY, 0, cursorY - rect.bottom);

    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Convert distance to font size using inverse linear interpolation
   * Distance 0-300px maps to 24-14px font size
   */
  function distanceToFontSize(distance: number): number {
    const MAX_DISTANCE = 300;
    const MIN_FONT_SIZE = 14;
    const MAX_FONT_SIZE = 24;

    if (distance >= MAX_DISTANCE) return MIN_FONT_SIZE;
    if (distance <= 0) return MAX_FONT_SIZE;

    // Linear interpolation: fontSize = 14 + (10 * (1 - distance/300))
    const scale = 1 - (distance / MAX_DISTANCE);
    return MIN_FONT_SIZE + (MAX_FONT_SIZE - MIN_FONT_SIZE) * scale;
  }

  /**
   * Handle mouse movement within hints container
   * Calculates closest unrevealed hint and updates scaling
   */
  const handleHintsMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!currentSentence) return;

    const cursorX = e.clientX;
    const cursorY = e.clientY;

    setMousePosition({ x: cursorX, y: cursorY });

    let closestIndex: number | null = null;
    let minDistance = Infinity;

    // Find closest unrevealed hint
    currentSentence.hints.forEach((hint, index) => {
      // Skip revealed hints
      if (viewedHints.has(index)) return;

      const cardElement = hintCardsRefs.current[index];
      if (!cardElement) return;

      const distance = calculateDistance(cursorX, cursorY, cardElement);

      if (distance < minDistance) {
        minDistance = distance;
        closestIndex = index;
      }
    });

    setClosestHintIndex(closestIndex);

    // Update font size based on distance
    if (closestIndex !== null && minDistance < Infinity) {
      const fontSize = distanceToFontSize(minDistance);
      setClosestHintScale(fontSize);
    } else {
      // No valid hints nearby, reset to default
      setClosestHintScale(14);
    }
  };

  /**
   * Reset scaling when mouse leaves hints container
   */
  const handleHintsMouseLeave = () => {
    setMousePosition(null);
    setClosestHintIndex(null);
    setClosestHintScale(14);
  };

  // Completion screen
  if (!currentSentence) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, sans-serif',
        padding: '20px',
      }}>
        <div style={{
          background: 'white',
          borderRadius: '16px',
          padding: '40px',
          textAlign: 'center',
          maxWidth: '500px',
        }}>
          <div style={{ fontSize: '80px', marginBottom: '20px' }}>🎉</div>
          <h1 style={{ fontSize: '32px', marginBottom: '16px' }}>Congratulations!</h1>
          <p style={{ fontSize: '18px', color: '#6b7280', marginBottom: '32px' }}>
            You've completed all {triviaQuestions.length} questions!
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <button
              onClick={() => {
                setUsedSentenceIds(new Set());
                loadNextSentence();
              }}
              style={{
                padding: '12px 24px',
                fontSize: '16px',
                background: '#f093fb',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Play Again
            </button>
            {onBack && (
              <button
                onClick={onBack}
                style={{
                  padding: '12px 24px',
                  fontSize: '16px',
                  background: '#6b7280',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                Back to Home
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Main game UI
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

      <style>{`
        @keyframes fadeInScale {
          0% { opacity: 0; transform: scale(0.5); }
          50% { opacity: 1; transform: scale(1.1); }
          100% { opacity: 1; transform: scale(1); }
        }
        .status-icon {
          font-size: 80px;
          animation: fadeInScale 0.5s ease-out;
        }
        .status-correct {
          color: #22c55e;
        }
        .status-incorrect {
          color: #ef4444;
        }
      `}</style>

      <div style={{
        minHeight: '100vh',
        paddingTop: isMockMode ? 40 : 0,
        background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'system-ui, sans-serif',
      }}>
        {/* Header with back button and timer */}
        <div style={{
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
            <h2 style={{ margin: 0, fontSize: '24px' }}>Trivia Game</h2>
            <button
              onClick={() => setPaused(!paused)}
              style={{
                padding: '8px 16px',
                fontSize: 14,
                background: paused ? '#22c55e' : '#f59e0b',
                color: 'white',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              {paused ? '▶ Resume' : '⏸ Pause'}
            </button>
          </div>

          {/* Timer display */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}>
            <div style={{
              fontSize: '18px',
              fontWeight: 600,
              color: timerSeconds <= 3 ? '#ef4444' : '#1f2937',
            }}>
              {timerSeconds}s
            </div>
            <div style={{
              width: 60,
              height: 60,
              borderRadius: '50%',
              border: `4px solid ${timerSeconds <= 3 ? '#ef4444' : '#3b82f6'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: `conic-gradient(${timerSeconds <= 3 ? '#ef4444' : '#3b82f6'} ${(timerSeconds / TIMER_DURATION_SECONDS) * 360}deg, #e5e7eb 0deg)`,
            }}>
              <div style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '20px',
                fontWeight: 700,
              }}>
                {timerSeconds}
              </div>
            </div>
          </div>
        </div>

        {/* Main content area */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '40px 20px',
          overflow: 'auto',
        }}>
          {/* Mouse tracking container for hints + sentence */}
          <div
            onMouseMove={handleHintsMouseMove}
            onMouseLeave={handleHintsMouseLeave}
            style={{
              width: '100%',
              maxWidth: '900px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              marginBottom: '32px',
            }}
          >
            {/* Hint cards */}
            <div style={{
              width: '100%',
              marginBottom: '32px',
            }}>
              <div style={{
                display: 'flex',
                gap: 12,
                overflowX: 'auto',
                padding: '16px 0',
                justifyContent: 'center',
                flexWrap: 'wrap',
              }}>
                {currentSentence.hints.map((hint, index) => {
                  const isRevealed = viewedHints.has(index);
                  const isClosest = closestHintIndex === index;
                  const dynamicFontSize = isClosest && !isRevealed ? closestHintScale : 14;

                  return (
                    <div
                      key={index}
                      ref={(el) => { hintCardsRefs.current[index] = el; }}
                      onMouseEnter={() => handleHintView(index)}
                      style={{
                        minWidth: 150,
                        height: 100,
                        border: isRevealed ? '2px solid #333' : '3px solid #FFD700',
                        borderRadius: 8,
                        padding: 12,
                        background: isRevealed ? '#fff' : '#fffbeb',
                        cursor: 'pointer',
                        transition: 'all 0.3s ease',
                        boxShadow: isRevealed ? '0 2px 8px rgba(0,0,0,0.1)' : '0 4px 12px rgba(255, 215, 0, 0.3)',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        alignItems: 'center',
                      }}
                    >
                      <div style={{
                        fontWeight: 600,
                        marginBottom: 8,
                        textAlign: 'center',
                        fontSize: dynamicFontSize,
                        color: '#1f2937',
                        transition: 'font-size 0.15s ease-out',
                      }}>
                        {hint.native}
                      </div>
                      {isRevealed && (
                        <div style={{
                          color: '#3b82f6',
                          fontSize: 14,
                          textAlign: 'center',
                          fontWeight: 500,
                        }}>
                          {hint.learning}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Sentence prompt (in fluent language) */}
            <div style={{
              background: 'white',
              borderRadius: '16px',
              padding: '32px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
              minWidth: '300px',
              textAlign: 'center',
            }}>
              <div style={{
                fontSize: '28px',
                fontWeight: 600,
                color: '#1f2937',
                lineHeight: 1.4,
              }}>
                {currentSentence.nativeText}
              </div>
            </div>
          </div>

          {/* Status indicator */}
          {(answerStatus === 'correct' || answerStatus === 'incorrect' || feedbackMessage || paused) && (
            <div style={{
              marginBottom: '24px',
              textAlign: 'center',
            }}>
              {answerStatus === 'correct' && (
                <div className="status-icon status-correct">✓</div>
              )}
              {answerStatus === 'incorrect' && (
                <div className="status-icon status-incorrect">✗</div>
              )}
              {paused && !feedbackMessage && (
                <div style={{
                  fontSize: '48px',
                  marginBottom: '12px',
                }}>
                  ⏸
                </div>
              )}
              {feedbackMessage && (
                <div style={{
                  fontSize: '20px',
                  fontWeight: 600,
                  color: 'white',
                  marginTop: 12,
                  textShadow: '0 2px 4px rgba(0,0,0,0.2)',
                }}>
                  {feedbackMessage}
                </div>
              )}
              {paused && !feedbackMessage && (
                <div style={{
                  fontSize: '24px',
                  fontWeight: 600,
                  color: 'white',
                  textShadow: '0 2px 4px rgba(0,0,0,0.2)',
                }}>
                  Game Paused
                </div>
              )}
            </div>
          )}

          {/* Chatbox */}
          <div style={{
            width: '100%',
            maxWidth: '600px',
            background: 'white',
            borderRadius: '12px',
            padding: '20px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          }}>
            <textarea
              ref={textareaRef}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submitAnswer();
                }
              }}
              onMouseEnter={(e) => {
                if (!busy && timerActive && !paused) {
                  e.currentTarget.focus();
                }
              }}
              placeholder={`Type or speak your answer in ${initialLearning.name}...`}
              disabled={!timerActive || busy || paused}
              autoFocus
              style={{
                width: '100%',
                minHeight: '80px',
                padding: '12px',
                fontSize: '16px',
                border: '2px solid #e5e7eb',
                borderRadius: 8,
                resize: 'vertical',
                fontFamily: 'system-ui, sans-serif',
                boxSizing: 'border-box',
              }}
            />
            <div style={{
              display: 'flex',
              gap: 8,
              marginTop: 12,
              justifyContent: 'flex-end',
            }}>
              <button
                onClick={() => setTranscript('')}
                disabled={!transcript || busy || paused}
                style={{
                  padding: '8px 16px',
                  fontSize: 14,
                  background: '#6b7280',
                  color: 'white',
                  border: 'none',
                  borderRadius: 6,
                  cursor: transcript && !busy && !paused ? 'pointer' : 'not-allowed',
                  opacity: transcript && !busy && !paused ? 1 : 0.5,
                }}
              >
                Clear
              </button>
              <button
                onClick={() => void submitAnswer()}
                disabled={!transcript || !timerActive || busy || paused}
                style={{
                  padding: '8px 16px',
                  fontSize: 14,
                  background: '#3b82f6',
                  color: 'white',
                  border: 'none',
                  borderRadius: 6,
                  cursor: transcript && timerActive && !busy && !paused ? 'pointer' : 'not-allowed',
                  opacity: transcript && timerActive && !busy && !paused ? 1 : 0.5,
                }}
              >
                {busy ? 'Checking...' : 'Send'}
              </button>
            </div>
          </div>

          {/* Progress indicator */}
          <div style={{
            marginTop: '24px',
            color: 'white',
            fontSize: '14px',
            textShadow: '0 1px 2px rgba(0,0,0,0.2)',
          }}>
            Question {usedSentenceIds.size} of {triviaQuestions.length}
          </div>
        </div>
      </div>
    </>
  );
}
