// HomeScreen.tsx
// Simple home screen to choose between Story Cards Game and Trivia Game
import React, { useState, useEffect } from "react";

type LangSpec = { code: string; name: string };

type HomeScreenProps = {
  apiBase?: string;
  onSelectMode: (mode: 'story' | 'trivia' | 'messenger', fluent: LangSpec, learning: LangSpec) => void;
};

const LANG_OPTIONS: LangSpec[] = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "id", name: "Indonesian" },
];

export default function HomeScreen({
  apiBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000",
  onSelectMode,
}: HomeScreenProps) {
  const [fluent, setFluent] = useState<LangSpec>(LANG_OPTIONS[0]); // English
  const [learning, setLearning] = useState<LangSpec>(LANG_OPTIONS[1]); // Spanish
  const [isMockMode, setIsMockMode] = useState<boolean>(false);

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

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      {/* Mock Mode Banner */}
      {isMockMode && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          background: '#fbbf24',
          color: '#78350f',
          padding: '8px',
          textAlign: 'center',
          fontWeight: 600,
          fontSize: '14px',
          zIndex: 1000,
        }}>
          ⚠️ MOCK MODE - Using test data (no API keys required)
        </div>
      )}

      {/* Main Container */}
      <div style={{
        background: 'white',
        borderRadius: '16px',
        padding: '40px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        maxWidth: '800px',
        width: '100%',
      }}>
        {/* Title */}
        <h1 style={{
          fontSize: '36px',
          fontWeight: 700,
          textAlign: 'center',
          marginBottom: '40px',
          color: '#1f2937',
        }}>
          SpeakRight
        </h1>

        {/* Language Selectors */}
        <div style={{
          display: 'flex',
          gap: '20px',
          marginBottom: '40px',
          justifyContent: 'center',
          flexWrap: 'wrap',
        }}>
          {/* Fluent Language */}
          <div style={{ flex: '1', minWidth: '200px' }}>
            <label style={{
              display: 'block',
              fontSize: '14px',
              fontWeight: 600,
              color: '#6b7280',
              marginBottom: '8px',
            }}>
              I speak (fluent):
            </label>
            <select
              value={fluent.code}
              onChange={(e) => {
                const lang = LANG_OPTIONS.find(l => l.code === e.target.value);
                if (lang) setFluent(lang);
              }}
              style={{
                width: '100%',
                padding: '12px',
                fontSize: '16px',
                border: '2px solid #e5e7eb',
                borderRadius: '8px',
                background: 'white',
                color: '#1f2937',
                cursor: 'pointer',
              }}
            >
              {LANG_OPTIONS.map(lang => (
                <option key={lang.code} value={lang.code} style={{ color: '#1f2937', background: 'white' }}>
                  {lang.name}
                </option>
              ))}
            </select>
          </div>

          {/* Learning Language */}
          <div style={{ flex: '1', minWidth: '200px' }}>
            <label style={{
              display: 'block',
              fontSize: '14px',
              fontWeight: 600,
              color: '#6b7280',
              marginBottom: '8px',
            }}>
              I'm learning:
            </label>
            <select
              value={learning.code}
              onChange={(e) => {
                const lang = LANG_OPTIONS.find(l => l.code === e.target.value);
                if (lang) setLearning(lang);
              }}
              style={{
                width: '100%',
                padding: '12px',
                fontSize: '16px',
                border: '2px solid #e5e7eb',
                borderRadius: '8px',
                background: 'white',
                color: '#1f2937',
                cursor: 'pointer',
              }}
            >
              {LANG_OPTIONS.map(lang => (
                <option key={lang.code} value={lang.code} style={{ color: '#1f2937', background: 'white' }}>
                  {lang.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Preset Language Buttons */}
        <div style={{
          display: 'flex',
          gap: '12px',
          marginBottom: '32px',
          justifyContent: 'center',
          flexWrap: 'wrap',
        }}>
          <button
            onClick={() => {
              setFluent({ code: 'en', name: 'English' });
              setLearning({ code: 'es', name: 'Spanish' });
            }}
            style={{
              padding: '10px 20px',
              fontSize: '14px',
              fontWeight: 600,
              background: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              transition: 'transform 0.2s, box-shadow 0.2s',
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = '0 4px 8px rgba(0,0,0,0.15)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
            }}
          >
            🇺🇸 EN → ES 🇪🇸
          </button>

          <button
            onClick={() => {
              setFluent({ code: 'en', name: 'English' });
              setLearning({ code: 'id', name: 'Indonesian' });
            }}
            style={{
              padding: '10px 20px',
              fontSize: '14px',
              fontWeight: 600,
              background: '#10b981',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              transition: 'transform 0.2s, box-shadow 0.2s',
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = '0 4px 8px rgba(0,0,0,0.15)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
            }}
          >
            🇺🇸 EN → ID 🇮🇩
          </button>

          <button
            onClick={() => {
              setFluent({ code: 'id', name: 'Indonesian' });
              setLearning({ code: 'en', name: 'English' });
            }}
            style={{
              padding: '10px 20px',
              fontSize: '14px',
              fontWeight: 600,
              background: '#f59e0b',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              transition: 'transform 0.2s, box-shadow 0.2s',
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = '0 4px 8px rgba(0,0,0,0.15)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
            }}
          >
            🇮🇩 ID → EN 🇺🇸
          </button>
        </div>

        {/* Game Mode Cards */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '24px',
        }}>
          {/* Story Cards Game Card */}
          <button
            onClick={() => onSelectMode('story', fluent, learning)}
            style={{
              padding: '32px 24px',
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              border: 'none',
              borderRadius: '12px',
              color: 'white',
              cursor: 'pointer',
              transition: 'transform 0.2s, box-shadow 0.2s',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-4px)';
              e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.25)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
            }}
          >
            <div style={{
              fontSize: '48px',
              marginBottom: '16px',
            }}>
              🎴
            </div>
            <h2 style={{
              fontSize: '24px',
              fontWeight: 700,
              marginBottom: '12px',
            }}>
              Story Cards Game
            </h2>
            <p style={{
              fontSize: '14px',
              opacity: 0.9,
              lineHeight: '1.5',
            }}>
              Create stories using vocabulary and grammar cards. Practice creative language use.
            </p>
          </button>

          {/* Trivia Game Card */}
          <button
            onClick={() => onSelectMode('trivia', fluent, learning)}
            style={{
              padding: '32px 24px',
              background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
              border: 'none',
              borderRadius: '12px',
              color: 'white',
              cursor: 'pointer',
              transition: 'transform 0.2s, box-shadow 0.2s',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-4px)';
              e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.25)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
            }}
          >
            <div style={{
              fontSize: '48px',
              marginBottom: '16px',
            }}>
              ❓
            </div>
            <h2 style={{
              fontSize: '24px',
              fontWeight: 700,
              marginBottom: '12px',
            }}>
              Trivia Game
            </h2>
            <p style={{
              fontSize: '14px',
              opacity: 0.9,
              lineHeight: '1.5',
            }}>
              Translate English sentences with hint cards. Race against the timer!
            </p>
          </button>

          {/* Messenger Chat Card */}
          <button
            onClick={() => onSelectMode('messenger', fluent, learning)}
            style={{
              padding: '32px 24px',
              background: 'linear-gradient(135deg, #4ade80 0%, #22c55e 100%)',
              border: 'none',
              borderRadius: '12px',
              color: 'white',
              cursor: 'pointer',
              transition: 'transform 0.2s, box-shadow 0.2s',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-4px)';
              e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.25)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
            }}
          >
            <div style={{
              fontSize: '48px',
              marginBottom: '16px',
            }}>
              💬
            </div>
            <h2 style={{
              fontSize: '24px',
              fontWeight: 700,
              marginBottom: '12px',
            }}>
              Messenger Chat
            </h2>
            <p style={{
              fontSize: '14px',
              opacity: 0.9,
              lineHeight: '1.5',
            }}>
              Practice conversation in a messenger-style interface with auto-send.
            </p>
          </button>
        </div>
      </div>
    </div>
  );
}
