// StoryCardsGame.tsx
// Full component with card-replacement highlight + +points animation
import React, { useEffect, useState, useRef } from "react";

type LangSpec = { code: string; name: string };

type Card = {
  id: string;
  type: "image" | "spanish_word" | "english_word" | "phrase" | "grammar" | "constraint";
  value: string;
  display_text?: string;
  image_url?: string | null;
  points?: number;
};

const LANG_OPTIONS: LangSpec[] = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "id", name: "Indonesian" },
];

const MIN_AUTO_SEND_LENGTH = 8; // characters
const AUTO_SEND_DELAY_MS = 1200; // debounce delay after typing stops

// small seed deck (you should move to cards.ts if you want a central deck)
const CARD_DECK: Card[] = [
  { id: "c_camino", type: "spanish_word", value: "camino", display_text: "camino", points: 5 },
  { id: "c_cesta", type: "image", value: "basket", display_text: "(image) basket", image_url: "/img/basket.png", points: 4 },
  { id: "c_lobo", type: "spanish_word", value: "lobo", display_text: "lobo", points: 6 },
  { id: "c_noche", type: "phrase", value: "por la noche", display_text: "por la noche", points: 5 },
  { id: "c_subj", type: "grammar", value: "subjunctive", display_text: "use subjunctive", points: 8 },
  { id: "c_arbol", type: "spanish_word", value: "árbol", display_text: "árbol", points: 4 },
  { id: "c_llama", type: "spanish_word", value: "llama", display_text: "llama", points: 3 },
  { id: "c_flor", type: "spanish_word", value: "flor", display_text: "flor", points: 3 },
  { id: "c_neg", type: "constraint", value: "negative", display_text: "make sentence negative", points: 7 },
  { id: "c_rapido", type: "phrase", value: "rápido", display_text: "rápido", points: 4 },
];

function shuffle<T>(arr: T[]) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function drawCards(deck: Card[], count = 7) {
  return shuffle(deck).slice(0, count);
}

function generateId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export default function StoryCardsGame({ apiBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000" }:{ apiBase?: string }) {
  const [fluent, setFluent] = useState<LangSpec>(LANG_OPTIONS[0]);
  const [learning, setLearning] = useState<LangSpec>(LANG_OPTIONS[1]);

  const [phase, setPhase] = useState<"setup" | "chooseTitle" | "playing">("setup");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [storyTitle, setStoryTitle] = useState<string>("");

  const [character, setCharacter] = useState<string>("Ghost");
  const [objectOrPlace, setObjectOrPlace] = useState<string>("Forest");

  const [availableCards, setAvailableCards] = useState<Card[]>([]);
  const [visibleCards, setVisibleCards] = useState<Card[]>([]);

  const [transcript, setTranscript] = useState<string>("");
  const autoSendTimer = useRef<number | null>(null);
  const lastSentRef = useRef<number>(0);
  const [busy, setBusy] = useState(false);

  const [history, setHistory] = useState<any[]>([]);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // hover playback control refs
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const isHoveringRef = useRef<boolean>(false);

  // highlight animation state: map cardId -> { ts, points }
  const [replacedHighlights, setReplacedHighlights] = useState<Record<string, { ts: number; points: number }>>({});

  // title options
  const characterOptions = ["Ghost","Camel","Llama","Rabbit","Sad Prince","Laughing Tree","Tiny Dragon"];
  const placeOrObjectOptions = ["Forest","Castle","Market","River","Treehouse","Cave","Tower"];

  function randomTitle() {
    const c = characterOptions[Math.floor(Math.random()*characterOptions.length)];
    const o = placeOrObjectOptions[Math.floor(Math.random()*placeOrObjectOptions.length)];
    return `The ${c} and the ${o}`;
  }

  // When starting, initialize availableCards from CARD_DECK and draw 7
  async function handleStart() {
    const title = storyTitle.trim() || randomTitle();
    try {
      setBusy(true);
      // ask backend to create session (optional); backend may return active_cards
      const res = await fetch(`${apiBase}/api/game/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ story_title: title, fluent: fluent, learning: learning }),
      });
      if (!res.ok) throw new Error("start failed");
      const data = await res.json();

      setSessionId(data.session_id || `sess_${Date.now()}`);
      setStoryTitle(title);

      // set available cards from central deck and draw initial visible cards
      setAvailableCards(CARD_DECK);
      if (Array.isArray(data.active_cards) && data.active_cards.length) {
        setVisibleCards(data.active_cards);
      } else {
        setVisibleCards(drawCards(CARD_DECK, 7));
      }

      setPhase("playing");
    } catch (e) {
      console.error(e);
      alert("Failed to start session — see console.");
    } finally {
      setBusy(false);
    }
  }

  // auto-send logic (debounced)
  useEffect(() => {
    if (autoSendTimer.current) {
      window.clearTimeout(autoSendTimer.current);
      autoSendTimer.current = null;
    }
    if (transcript.length >= MIN_AUTO_SEND_LENGTH) {
      autoSendTimer.current = window.setTimeout(() => {
        const now = Date.now();
        if (now - lastSentRef.current > 700) {
          void submitTurn();
        }
      }, AUTO_SEND_DELAY_MS);
    }
    return () => {
      if (autoSendTimer.current) {
        window.clearTimeout(autoSendTimer.current);
        autoSendTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcript]);

  // cleanup highlights after animation duration
  useEffect(() => {
    // animation duration (ms)
    const D = 1200;
    const interval = setInterval(() => {
      const now = Date.now();
      setReplacedHighlights((prev) => {
        const next: Record<string, { ts:number; points:number }> = {};
        for (const k of Object.keys(prev)) {
          if (now - prev[k].ts < D) next[k] = prev[k];
        }
        return next;
      });
    }, 200);
    return () => clearInterval(interval);
  }, []);

  // Replace used visible cards with fresh draws from CARD_DECK (no duplicates)
  function replaceUsedCards(usedCards: string[] | undefined) {
    if (!usedCards || !usedCards.length) return;

    setVisibleCards((currentVisible) => {
      // compute set of ids currently visible
      const visibleIds = new Set(currentVisible.map((c) => c.id));
      // build exclude list (visible after replacements will also avoid duplicates)
      const exclude = new Set(Array.from(visibleIds));

      // helper to draw a card not currently visible and not used in this replacement
      function drawNew(excludeSet: Set<string>): Card | null {
        const pool = CARD_DECK.filter((c) => !excludeSet.has(c.id));
        if (!pool.length) return null;
        const pick = pool[Math.floor(Math.random() * pool.length)];
        excludeSet.add(pick.id);
        return pick;
      }

      // Create sets to match by id/value/display_text (case-insensitive)
      const usedSetById = new Set(usedCards);
      const usedSetByValue = new Set(usedCards.map((s) => String(s).toLowerCase()));

      const newVisible = currentVisible.map((card) => {
        const cardMatched =
          usedSetById.has(card.id) ||
          usedSetByValue.has(String(card.value).toLowerCase()) ||
          (card.display_text && usedSetByValue.has(String(card.display_text).toLowerCase()));

        if (!cardMatched) return card;

        const replacement = drawNew(exclude);
        if (replacement) {
          // add highlight for this replacement (show +points on UI)
          setReplacedHighlights((prev) => ({
            ...prev,
            [replacement.id]: { ts: Date.now(), points: replacement.points ?? 0 },
          }));
          return replacement;
        }
        return card;
      });

      return newVisible;
    });
  }

  async function submitTurn() {
    if (!sessionId) {
      alert("No session — press Start");
      return;
    }
    const text = transcript.trim();
    if (!text || text.length < 2) return;

    lastSentRef.current = Date.now();
    setBusy(true);

    try {
      const body = {
        session_id: sessionId,
        story_title: storyTitle,
        active_cards: visibleCards,
        transcript: text,
        fluent: fluent,
        learning: learning,
      };
      const res = await fetch(`${apiBase}/api/game/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`turn failed ${res.status}`);
      const data = await res.json();

      // append response to history
      setHistory((h) => [...h, data]);

      // handle used cards replacement (frontend local replacement)
      if (Array.isArray(data.used_cards) && data.used_cards.length) {
        replaceUsedCards(data.used_cards);
      } else if (Array.isArray(data.used_card_ids) && data.used_card_ids.length) {
        replaceUsedCards(data.used_card_ids);
      } else if (Array.isArray(data.used_card_values) && data.used_card_values.length) {
        replaceUsedCards(data.used_card_values);
      }

      // Playback (prioritize audio_files array)
      const audioList: Array<{ purpose?:string, audio_file?:string, lang?:string }> = [];
      if (Array.isArray(data.audio_files) && data.audio_files.length) {
        for (const a of data.audio_files) audioList.push({ purpose: a.purpose, audio_file: a.audio_file, lang: a.lang });
      } else if (data.audio_file_en || data.audio_file_learning) {
        if (data.audio_file_en) audioList.push({ purpose: "native_translation", audio_file: data.audio_file_en, lang: "en-US" });
        if (data.audio_file_learning) audioList.push({ purpose: "corrected_sentence", audio_file: data.audio_file_learning, lang: learning.code === "es" ? "es-MX" : (learning.code === "id" ? "id-ID" : "en-US") });
      } else if (data.audio_chunks && Array.isArray(data.audio_chunks)) {
        for (const c of data.audio_chunks) audioList.push({ purpose: c.purpose, audio_file: c.audio_file, lang: c.lang });
      }

      const playOrder: Array<{ audio_file?: string }> = [];
      const native = audioList.find(a => a.purpose === "native_translation" || a.lang?.startsWith("en"));
      if (native) playOrder.push(native);
      const corrected = audioList.find(a => a.purpose === "corrected_sentence" || a.lang?.startsWith(learning.code === "es" ? "es" : (learning.code === "id" ? "id" : "en")));
      if (corrected && corrected !== native) playOrder.push(corrected);
      for (const a of audioList) if (!playOrder.includes(a)) playOrder.push(a);

      for (const a of playOrder) {
        if (!a || !a.audio_file) continue;
        const url = a.audio_file.startsWith("http") ? a.audio_file : `${apiBase}${a.audio_file}`;
        await playAudioUrl(url);
      }

      // update visible cards if backend suggested new ones (server authoritative)
      if (Array.isArray(data.new_cards) && data.new_cards.length) {
        setVisibleCards(data.new_cards);
      } else if (Array.isArray(data.active_cards) && data.active_cards.length) {
        setVisibleCards(data.active_cards);
      }

      setTranscript("");
    } catch (e) {
      console.error(e);
      alert("Turn failed — see console.");
    } finally {
      setBusy(false);
    }
  }

  function playAudioUrl(url: string) {
    return new Promise<void>((resolve) => {
      try {
        const audio = new Audio(url);
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        audio.play().catch(() => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  // hover/preview helpers (improved to continue to learning audio)
  function stopCurrentAudio() {
    try {
      isHoveringRef.current = false;
      const a = currentAudioRef.current;
      if (a) {
        a.pause();
        a.currentTime = 0;
      }
    } catch (e) {
      // ignore
    } finally {
      currentAudioRef.current = null;
      setHoverIndex(null);
    }
  }

  function playAudioElement(url: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        if (currentAudioRef.current) {
          try { currentAudioRef.current.pause(); currentAudioRef.current.currentTime = 0; } catch (e) {}
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
      } catch (e) {
        currentAudioRef.current = null;
        resolve();
      }
    });
  }

  async function startHoverPlayForHistory(h: any, idx: number) {
    if (!h) return;
    const audioList: Array<{ audio_file?: string, lang?: string, purpose?: string }> = [];

    if (Array.isArray(h.audio_files) && h.audio_files.length) {
      for (const a of h.audio_files) audioList.push({ audio_file: a.audio_file, lang: a.lang, purpose: a.purpose });
    } else if (h.audio_file_en || h.audio_file_learning) {
      if (h.audio_file_en) audioList.push({ audio_file: h.audio_file_en, lang: "en-US", purpose: "native_translation" });
      if (h.audio_file_learning) audioList.push({ audio_file: h.audio_file_learning, lang: learning.code === "es" ? "es-MX" : (learning.code === "id" ? "id-ID" : "en-US"), purpose: "corrected_sentence" });
    } else if (Array.isArray(h.audio_chunks) && h.audio_chunks.length) {
      for (const c of h.audio_chunks) audioList.push({ audio_file: c.audio_file ?? c.file ?? c.src, lang: c.lang, purpose: c.purpose });
    }

    const native = audioList.find(a => a.purpose === "native_translation" || (a.lang && a.lang.startsWith("en")));
    const corrected = audioList.find(a => a.purpose === "corrected_sentence" || (a.lang && a.lang.startsWith(learning.code === "es" ? "es" : (learning.code === "id" ? "id" : "en"))));
    const playOrder: Array<{ audio_file?: string }> = [];
    if (native) playOrder.push(native);
    if (corrected && corrected !== native) playOrder.push(corrected);
    for (const a of audioList) if (!playOrder.includes(a)) playOrder.push(a);

    isHoveringRef.current = true;
    setHoverIndex(idx);

    try {
      for (const a of playOrder) {
        if (!a || !a.audio_file) continue;
        if (!isHoveringRef.current) break;
        const url = a.audio_file.startsWith("http") ? a.audio_file : `${apiBase}${a.audio_file}`;
        // eslint-disable-next-line no-await-in-loop
        await playAudioElement(url);
        if (!isHoveringRef.current) break;
      }
    } catch (e) {
      console.error("hover playback error", e);
    } finally {
      stopCurrentAudio();
    }
  }

  async function playHistoryItem(h: any, idx: number) {
    if (!h) return;
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    stopCurrentAudio();

    const audioList: Array<{ purpose?: string; audio_file?: string; lang?: string }> = [];
    if (Array.isArray(h.audio_files) && h.audio_files.length) {
        for (const a of h.audio_files) audioList.push({ purpose: a.purpose, audio_file: a.audio_file, lang: a.lang });
    } else if (h.audio_file_en || h.audio_file_learning) {
        if (h.audio_file_en) audioList.push({ purpose: "native_translation", audio_file: h.audio_file_en, lang: "en-US" });
        if (h.audio_file_learning) audioList.push({ purpose: "corrected_sentence", audio_file: h.audio_file_learning, lang: learning.code === "es" ? "es-MX" : (learning.code === "id" ? "id-ID" : "en-US") });
    } else if (Array.isArray(h.audio_chunks) && h.audio_chunks.length) {
        for (const c of h.audio_chunks) {
        audioList.push({ purpose: c.purpose, audio_file: c.audio_file ?? c.file ?? c.src, lang: c.lang });
        }
    }

    const playOrder: Array<{ audio_file?: string }> = [];
    const native = audioList.find(a => a.purpose === "native_translation" || (a.lang && a.lang.startsWith("en")));
    if (native) playOrder.push(native);
    const corrected = audioList.find(a => a.purpose === "corrected_sentence" || (a.lang && a.lang.startsWith(learning.code === "es" ? "es" : (learning.code === "id" ? "id" : "en"))));
    if (corrected && corrected !== native) playOrder.push(corrected);
    for (const a of audioList) {
        if (!playOrder.includes(a)) playOrder.push(a);
    }

    setPlayingIndex(idx);
    try {
        for (const a of playOrder) {
        if (!a || !a.audio_file) continue;
        const url = a.audio_file.startsWith("http") ? a.audio_file : `${apiBase}${a.audio_file}`;
        // eslint-disable-next-line no-await-in-loop
        await playAudioUrl(url);
        }
    } catch (e) {
        console.error("Error during history playback", e);
    } finally {
        setPlayingIndex(null);
    }
  }

  // swap card locally (unused replacement will not duplicate existing visible cards)
  function swapCard(index: number) {
    const remaining = CARD_DECK.filter(c => !visibleCards.some(vc => vc.id === c.id));
    if (remaining.length === 0) return;
    const next = remaining[Math.floor(Math.random() * remaining.length)];
    setVisibleCards((v) => v.map((c,i)=> i===index ? next : c));
    // show highlight for swapped-in card
    setReplacedHighlights((prev) => ({ ...prev, [next.id]: { ts: Date.now(), points: next.points ?? 0 } }));
  }

  // UI
  if (phase === "setup") {
    return (
      <div style={{ padding: 18 }}>
        <h2>Story Cards — Setup</h2>
        <div style={{ display: 'flex', gap: 12 }}>
          <div>
            <label>Fluent language</label>
            <select value={fluent.code} onChange={(e)=> setFluent(LANG_OPTIONS.find(l=>l.code===e.target.value) || LANG_OPTIONS[0])}>
              {LANG_OPTIONS.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </div>
          <div>
            <label>Learning language</label>
            <select value={learning.code} onChange={(e)=> setLearning(LANG_OPTIONS.find(l=>l.code===e.target.value) || LANG_OPTIONS[1])}>
              {LANG_OPTIONS.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <button onClick={()=> setPhase('chooseTitle') } disabled={busy}>Choose Title & Start</button>
        </div>
      </div>
    );
  }

  if (phase === "chooseTitle") {
    return (
      <div style={{ padding: 18 }}>
        <h2>Pick a title</h2>
        <div style={{ display:'flex', gap:12, alignItems:'center' }}>
          <div>
            <label>Character</label>
            <select value={character} onChange={(e)=> setCharacter(e.target.value)}>
              {characterOptions.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label>Place / Object</label>
            <select value={objectOrPlace} onChange={(e)=> setObjectOrPlace(e.target.value)}>
              {placeOrObjectOptions.map(p => <option key={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label>Or enter custom title</label>
            <input value={storyTitle} onChange={(e)=> setStoryTitle(e.target.value)} placeholder="Optional custom title" />
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <button onClick={() => { setStoryTitle(storyTitle || `The ${character} and the ${objectOrPlace}`); handleStart(); }} disabled={busy}>Start Story</button>
          <button style={{ marginLeft: 8 }} onClick={()=> setStoryTitle(randomTitle())}>Randomize title</button>
          <button style={{ marginLeft: 8 }} onClick={()=> setPhase('setup')}>Back</button>
        </div>
      </div>
    );
  }

  // playing phase
  return (
    <div style={{ padding: 18 , display: 'flex', flexDirection: 'row'}}>
      {/* CSS for highlight + floating points */}
      <style>{`
        @keyframes cardPulse {
          0% { box-shadow: 0 0 0 0 rgba(34,197,94,0.0); transform: scale(1); }
          40% { box-shadow: 0 8px 24px 6px rgba(34,197,94,0.18); transform: scale(1.06); }
          100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); transform: scale(1); }
        }
        @keyframes pointsRise {
          0% { transform: translateY(0px) scale(1); opacity: 1; }
          60% { transform: translateY(-26px) scale(1.04); opacity: 0.9; }
          100% { transform: translateY(-46px) scale(1.0); opacity: 0; }
        }
        .card-highlight {
          animation: cardPulse 1.1s cubic-bezier(.2,.9,.2,1);
          border-color: #22c55e !important;
        }
        .points-fly {
          position: absolute;
          right: 8px;
          top: 8px;
          font-weight: 800;
          background: rgba(34,197,94,0.98);
          color: white;
          padding: 4px 8px;
          border-radius: 999px;
          transform-origin: center;
          animation: pointsRise 1.1s forwards ease-out;
          pointer-events: none;
          font-size: 12px;
          box-shadow: 0 6px 18px rgba(2,6,23,0.25);
        }
      `}</style>

      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3>{storyTitle}</h3>
            <div>Session: {sessionId}</div>
          </div>
          <div>
            <button onClick={()=> { setPhase('setup'); setSessionId(null); setVisibleCards([]); }}>End Story</button>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            {visibleCards.map((c, i) => {
              const highlight = replacedHighlights[c.id];
              const isHighlighted = !!highlight;
              return (
                <div key={c.id} style={{ position: 'relative' }}>
                  <div
                    className={isHighlighted ? "card-highlight" : ""}
                    style={{
                      backgroundImage: "url(/cardFront.png)",
                      backgroundSize: "cover",
                      width: 132,
                      height: 174,
                      border: '2px solid #333',
                      padding: 8,
                      borderRadius: 8,
                      transition: 'transform 220ms ease, border-color 220ms ease',
                      transformOrigin: 'center',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'flex-start',
                      gap: 6,
                    }}
                  >
                    <div style={{ fontWeight:700, color: "red", wordBreak: 'break-word' }}>{c.display_text ?? c.value}</div>
                    <div style={{ fontSize: 12, opacity: 0.8, color: "red" }}>{c.type}</div>
                    <div style={{ marginTop: 6, fontSize: 12, color: "red" }}>{c.points ?? 5} pts</div>
                    <button style={{ marginTop: 8 }} onClick={()=> swapCard(i)}>Swap</button>
                  </div>

                  {/* floating +points */}
                  {isHighlighted && (
                    <div className="points-fly">+{highlight.points ?? 0}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <div style={{ marginBottom: 6, color: '#666' }}>Speak (Wispr will fill or paste transcript below). Autosend after you stop speaking.</div>
          <textarea
            value={transcript}
            onChange={(e)=> setTranscript(e.target.value)}
            placeholder={`Speak now in ${learning.name} (Wispr -> this box) or type a sentence`}
            rows={3}
            style={{ width: '97%', padding: 8 }}
          />
          <div style={{ marginTop: 8 }}>
            <button onClick={()=> void submitTurn()} disabled={busy}>Send now</button>
            <button style={{ marginLeft: 8 }} onClick={()=> setTranscript('')}>Clear</button>
          </div>
        </div>
      </div>

      <div style={{ width: 420, marginLeft: 24 }}>
        <h4>History</h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {history.map((h, idx) => {
            const isPlaying = playingIndex === idx;
            const isHovering = hoverIndex === idx;
            return (
              <div
                key={idx}
                style={{
                  padding: 8,
                  border: '1px solid #ddd',
                  borderRadius: 6,
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                  background: isPlaying ? '#eef6ff' : (isHovering ? '#f7fff2' : undefined),
                  cursor: 'pointer'
                }}
                onClick={() => void playHistoryItem(h, idx)}
                onMouseLeave={() => {
                  if (hoverTimerRef.current) {
                    window.clearTimeout(hoverTimerRef.current);
                    hoverTimerRef.current = null;
                  }
                  stopCurrentAudio();
                }}
              >
                <div style={{ width: 56, textAlign: 'center' }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void playHistoryItem(h, idx);
                    }}
                    onMouseEnter={(e) => {
                      e.stopPropagation();
                      if (hoverTimerRef.current) {
                        window.clearTimeout(hoverTimerRef.current);
                        hoverTimerRef.current = null;
                      }
                      hoverTimerRef.current = window.setTimeout(() => {
                        setHoverIndex(idx);
                        void startHoverPlayForHistory(h, idx);
                      }, 200);
                    }}
                    onMouseLeave={(e) => {
                      e.stopPropagation();
                      if (hoverTimerRef.current) {
                        window.clearTimeout(hoverTimerRef.current);
                        hoverTimerRef.current = null;
                      }
                      stopCurrentAudio();
                    }}
                    style={{ padding: '6px 8px' }}
                  >
                    {isPlaying ? 'Playing…' : (isHovering ? 'Preview…' : 'Play')}
                  </button>
                </div>

                <div style={{ flex: 1 }}>
                  <div><strong>Corrected ({learning.name}):</strong> {h.corrected_sentence}</div>
                  <div style={{ marginTop: 6 }}><strong>Translation ({fluent.name}):</strong> {h.native_translation ?? h.translation ?? ''}</div>
                  <div style={{ marginTop: 6 }}><strong>Used cards:</strong> {(h.used_cards || []).join(', ')}</div>
                  <div style={{ marginTop: 6 }}><strong>ASR fixes:</strong> {(h.asr_fixes || []).map((f:any)=> `${f.original}->${f.guess}`).join(', ')}</div>
                  {h.brief_explanation_native && <div style={{ marginTop:6, fontStyle:'italic' }}>{h.brief_explanation_native}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
