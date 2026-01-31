// MessengerChat.tsx
// Messenger-style chat interface with auto-send and auto-focus
import React, { useEffect, useState, useRef } from "react";

type LangSpec = { code: string; name: string };

type Message = {
  id: number;
  text: string;
  timestamp: Date;
};

type MessengerChatProps = {
  apiBase?: string;
  fluent?: LangSpec;
  learning?: LangSpec;
  onBack?: () => void;
};

const MIN_AUTO_SEND_LENGTH = 8;
const AUTO_SEND_DELAY_MS = 1200;

export default function MessengerChat({
  apiBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000",
  fluent = { code: "en", name: "English" },
  learning = { code: "es", name: "Spanish" },
  onBack,
}: MessengerChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [transcript, setTranscript] = useState<string>("");
  const [isMockMode, setIsMockMode] = useState<boolean>(false);

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

  // Auto-focus textarea on mount
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, []);

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

    if (transcript.length >= MIN_AUTO_SEND_LENGTH) {
      const lengthIncrease = transcript.length - previousTranscriptLengthRef.current;
      const isWisprInput = lengthIncrease >= 10;
      const delayMs = isWisprInput ? 100 : AUTO_SEND_DELAY_MS;

      autoSendTimer.current = window.setTimeout(() => {
        sendMessage();
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
  }, [transcript]);

  function sendMessage() {
    const text = transcript.trim();
    if (!text) return;

    // Create a new message
    const newMessage: Message = {
      id: Date.now(),
      text,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, newMessage]);
    setTranscript("");

    // Refocus textarea after sending
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    }, 50);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
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

      <div style={{
        minHeight: '100vh',
        paddingTop: isMockMode ? 40 : 0,
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'system-ui, sans-serif',
      }}>
        {/* Header */}
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
            <h2 style={{ margin: 0, fontSize: '24px' }}>Messenger Chat</h2>
          </div>
          <div style={{
            fontSize: '14px',
            color: '#6b7280',
          }}>
            {fluent.name} → {learning.name}
          </div>
        </div>

        {/* Messages area */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}>
          {messages.length === 0 && (
            <div style={{
              textAlign: 'center',
              color: 'white',
              fontSize: '18px',
              marginTop: '40px',
              opacity: 0.8,
            }}>
              Start typing to send a message...
            </div>
          )}

          {messages.map((message) => (
            <div
              key={message.id}
              style={{
                alignSelf: 'flex-end',
                maxWidth: '70%',
              }}
            >
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
                {message.text}
              </div>
              <div style={{
                fontSize: '12px',
                color: 'rgba(255,255,255,0.7)',
                marginTop: '4px',
                textAlign: 'right',
              }}>
                {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          ))}

          <div ref={messagesEndRef} />
        </div>

        {/* Chatbox at bottom */}
        <div style={{
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
                e.currentTarget.focus();
              }}
              placeholder={`Type or speak in ${learning.name}...`}
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
              }}
            />
            <button
              onClick={sendMessage}
              disabled={!transcript.trim()}
              style={{
                padding: '12px 24px',
                fontSize: '16px',
                background: transcript.trim() ? '#3b82f6' : '#d1d5db',
                color: 'white',
                border: 'none',
                borderRadius: 24,
                cursor: transcript.trim() ? 'pointer' : 'not-allowed',
                fontWeight: 600,
                transition: 'background 0.2s',
              }}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
