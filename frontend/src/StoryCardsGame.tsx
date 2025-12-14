// StoryCardsGame.tsx
// Full component with card-replacement highlight + +points animation
import React, { useEffect, useState, useRef } from "react";
import CARDS_DECK_150_RAW from './cards_deck_150.json';

type LangSpec = { code: string; name: string };

type Card = {
  id: string;
  type: "image" | "spanish_word" | "english_word" | "phrase" | "grammar" | "constraint";
  value: string;
  display_text?: string;
  image_url?: string | null;
  points?: number;
};

type Card2 = {
  id: string;
  text_en: string;
  type: string;
  difficulty: number;
  tags: string[];
  examples: string[];
  hints: {
    "en-US": string;
    "es-MX": string;
    "id-ID": string;
  };
};

const LANG_OPTIONS: LangSpec[] = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "id", name: "Indonesian" },
];

const CARD_DECK_150: Card2[] = CARDS_DECK_150_RAW as Card2[];

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

function drawCards2(deck: Card2[], count = 7) {
  return shuffle(deck).slice(0, count);
}

function getHintForLearningLang(card: Card2, learningCode: string): string {
  const hintMap: Record<string, keyof Card2["hints"]> = {
    "es": "es-MX",
    "id": "id-ID",
    "en": "en-US"
  };
  const hintKey = hintMap[learningCode] || "en-US";
  return card.hints[hintKey] || card.text_en;
}

function generateId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

type StoryCardsGameProps = {
  apiBase?: string;
  fluent?: LangSpec;
  learning?: LangSpec;
  onBack?: () => void;
};

export default function StoryCardsGame({
  apiBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000",
  fluent: initialFluent,
  learning: initialLearning,
  onBack,
}: StoryCardsGameProps) {
  const [isMockMode, setIsMockMode] = useState<boolean>(false);

  const [fluent, setFluent] = useState<LangSpec>(initialFluent || LANG_OPTIONS[0]);
  const [learning, setLearning] = useState<LangSpec>(initialLearning || LANG_OPTIONS[1]);

  const [phase, setPhase] = useState<"setup" | "chooseTitle" | "playing">("setup");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [storyTitle, setStoryTitle] = useState<string>("");

  const [character, setCharacter] = useState<string>("Ghost");
  const [objectOrPlace, setObjectOrPlace] = useState<string>("Forest");

  const [availableCards, setAvailableCards] = useState<Card[]>([]);
  const [visibleCards, setVisibleCards] = useState<Card[]>([]);

  const [availableCards2, setAvailableCards2] = useState<Card2[]>([]);
  const [visibleCards2, setVisibleCards2] = useState<Card2[]>([]);
  const [hoverCard2Index, setHoverCard2Index] = useState<number | null>(null);

  const [transcript, setTranscript] = useState<string>("");
  const autoSendTimer = useRef<number | null>(null);
  const lastSentRef = useRef<number>(0);
  const previousTranscriptLengthRef = useRef<number>(0);
  const [busy, setBusy] = useState(false);

  const [history, setHistory] = useState<any[]>([]);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // New state for tracking expanded history items and button hover
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [hoverButton, setHoverButton] = useState<{idx: number, btn: 1|2|3} | null>(null);

  // State for tracking which side of "Show More" button is hovered (left=normal, right=no spaces)
  const [showMoreHoverSide, setShowMoreHoverSide] = useState<'left' | 'right' | null>(null);

  // hover playback control refs
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const isHoveringRef = useRef<boolean>(false);
  const historyScrollRef = useRef<HTMLDivElement | null>(null);

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

      // initialize row 2 cards from cards_deck_150.json
      setAvailableCards2(CARD_DECK_150);
      setVisibleCards2(drawCards2(CARD_DECK_150, 7));

      setPhase("playing");
    } catch (e) {
      console.error(e);
      alert("Failed to start session — see console.");
    } finally {
      setBusy(false);
    }
  }

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
        // Default to false if config fetch fails
      }
    }
    void fetchConfig();
  }, [apiBase]);

  // auto-send logic (debounced for typing, immediate for Wispr)
  useEffect(() => {
    if (autoSendTimer.current) {
      window.clearTimeout(autoSendTimer.current);
      autoSendTimer.current = null;
    }
    if (transcript.length >= MIN_AUTO_SEND_LENGTH) {
      // Detect if this is Wispr input (large chunk added at once) vs typing (gradual)
      const lengthIncrease = transcript.length - previousTranscriptLengthRef.current;
      const isWisprInput = lengthIncrease >= 10; // 10+ chars added at once = likely Wispr
      const delay = isWisprInput ? 100 : AUTO_SEND_DELAY_MS; // 100ms for Wispr, 1200ms for typing

      autoSendTimer.current = window.setTimeout(() => {
        const now = Date.now();
        if (now - lastSentRef.current > 700) {
          void submitTurn();
        }
      }, delay);
    }

    // Update previous length for next comparison
    previousTranscriptLengthRef.current = transcript.length;

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

  // Auto-scroll history to bottom when new items are added (if already near bottom)
  useEffect(() => {
    const scrollContainer = historyScrollRef.current;
    if (!scrollContainer || history.length === 0) return;

    const isNearBottom =
      scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 300;

    if (isNearBottom) {
      setTimeout(() => {
        scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' });
      }, 100);
    }
  }, [history]);

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

  // Replace used visible cards from row 2 with fresh draws from CARD_DECK_150
  function replaceUsedCards2(usedCards: string[] | undefined) {
    if (!usedCards || !usedCards.length) return;

    setVisibleCards2((currentVisible) => {
      const visibleIds = new Set(currentVisible.map((c) => c.id));
      const exclude = new Set(Array.from(visibleIds));

      function drawNew(excludeSet: Set<string>): Card2 | null {
        const pool = CARD_DECK_150.filter((c) => !excludeSet.has(c.id));
        if (!pool.length) return null;
        const pick = pool[Math.floor(Math.random() * pool.length)];
        excludeSet.add(pick.id);
        return pick;
      }

      const usedSetById = new Set(usedCards);
      const usedSetByText = new Set(usedCards.map((s) => String(s).toLowerCase()));

      const newVisible = currentVisible.map((card) => {
        const cardMatched =
          usedSetById.has(card.id) ||
          usedSetByText.has(String(card.text_en).toLowerCase());

        if (!cardMatched) return card;

        const replacement = drawNew(exclude);
        if (replacement) {
          setReplacedHighlights((prev) => ({
            ...prev,
            [replacement.id]: { ts: Date.now(), points: 0 },
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
      // Transform row 2 cards to row 1 format for backend compatibility
      // Use hint in learning language as value so mock mode can detect it
      const row2AsRow1Format = visibleCards2.map((c) => {
        const hintInLearningLang = getHintForLearningLang(c, learning.code);
        return {
          id: c.id,
          type: c.type,
          value: hintInLearningLang,
          display_text: c.text_en,
          points: 0,
        };
      });

      const body = {
        session_id: sessionId,
        story_title: storyTitle,
        active_cards: [...visibleCards, ...row2AsRow1Format],
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

      // handle used cards replacement - split between row 1 and row 2
      const usedCardIds = data.used_cards || data.used_card_ids || data.used_card_values || [];

      if (usedCardIds.length) {
        const row1Ids = new Set(visibleCards.map(c => c.id));
        const row2Ids = new Set(visibleCards2.map(c => c.id));

        const usedRow1 = usedCardIds.filter((id: string) => row1Ids.has(id));
        const usedRow2 = usedCardIds.filter((id: string) => row2Ids.has(id));

        if (usedRow1.length) replaceUsedCards(usedRow1);
        if (usedRow2.length) replaceUsedCards2(usedRow2);
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
      previousTranscriptLengthRef.current = 0; // Reset after submit
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

  async function startHoverPlayForHistory(h: any, idx: number, mode: 'both' | 'learning' = 'both') {
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

    // Build play order based on mode
    const playOrder: Array<{ audio_file?: string }> = [];
    if (mode === 'both') {
      if (native) playOrder.push(native);
      if (corrected && corrected !== native) playOrder.push(corrected);
      for (const a of audioList) if (!playOrder.includes(a)) playOrder.push(a);
    } else if (mode === 'learning') {
      if (corrected) playOrder.push(corrected);
    }

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

  async function playLearningAudioOnly(h: any, idx: number) {
    if (!h) return;
    // Clear timers and stop current audio
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    stopCurrentAudio();

    // Extract audio list (reuse existing logic from playHistoryItem)
    const audioList: Array<{ purpose?: string; audio_file?: string; lang?: string }> = [];
    if (Array.isArray(h.audio_files) && h.audio_files.length) {
      for (const a of h.audio_files) audioList.push({ purpose: a.purpose, audio_file: a.audio_file, lang: a.lang });
    } else if (h.audio_file_learning) {
      audioList.push({
        purpose: "corrected_sentence",
        audio_file: h.audio_file_learning,
        lang: learning.code === "es" ? "es-MX" : (learning.code === "id" ? "id-ID" : "en-US")
      });
    } else if (Array.isArray(h.audio_chunks) && h.audio_chunks.length) {
      for (const c of h.audio_chunks) {
        audioList.push({ purpose: c.purpose, audio_file: c.audio_file ?? c.file ?? c.src, lang: c.lang });
      }
    }

    // Find ONLY the learning/corrected audio
    const corrected = audioList.find(a =>
      a.purpose === "corrected_sentence" ||
      (a.lang && a.lang.startsWith(learning.code === "es" ? "es" : (learning.code === "id" ? "id" : "en")))
    );

    setPlayingIndex(idx);
    try {
      if (corrected && corrected.audio_file) {
        const url = corrected.audio_file.startsWith("http")
          ? corrected.audio_file
          : `${apiBase}${corrected.audio_file}`;
        await playAudioUrl(url);
      }
    } catch (e) {
      console.error("Error during learning audio playback", e);
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

  // swap card for row 2
  function swapCard2(index: number) {
    const remaining = CARD_DECK_150.filter(c => !visibleCards2.some(vc => vc.id === c.id));
    if (remaining.length === 0) return;
    const next = remaining[Math.floor(Math.random() * remaining.length)];
    setVisibleCards2((v) => v.map((c,i)=> i===index ? next : c));
    setReplacedHighlights((prev) => ({ ...prev, [next.id]: { ts: Date.now(), points: 0 } }));
  }

  // UI
  if (phase === "setup") {
    return (
      <>
        {isMockMode && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 9999,
            background: 'linear-gradient(135deg, #ff6b6b 0%, #ff8e53 100%)',
            color: 'white',
            padding: '8px 16px',
            textAlign: 'center',
            fontWeight: 800,
            fontSize: 14,
            letterSpacing: '1px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            borderBottom: '3px solid rgba(0,0,0,0.1)'
          }}>
            ⚠️ MOCK MODE ⚠️
          </div>
        )}
        <div style={{ padding: 18, paddingTop: isMockMode ? 48 : 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
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
            <h2 style={{ margin: 0 }}>Story Cards — Setup</h2>
          </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <div>
            <label>Fluent language</label>
            <select
              value={fluent.code}
              onChange={(e)=> setFluent(LANG_OPTIONS.find(l=>l.code===e.target.value) || LANG_OPTIONS[0])}
              style={{ background: 'white', color: '#1f2937', padding: '8px', border: '1px solid #e5e7eb', borderRadius: '4px' }}
            >
              {LANG_OPTIONS.map(l => <option key={l.code} value={l.code} style={{ color: '#1f2937', background: 'white' }}>{l.name}</option>)}
            </select>
          </div>
          <div>
            <label>Learning language</label>
            <select
              value={learning.code}
              onChange={(e)=> setLearning(LANG_OPTIONS.find(l=>l.code===e.target.value) || LANG_OPTIONS[1])}
              style={{ background: 'white', color: '#1f2937', padding: '8px', border: '1px solid #e5e7eb', borderRadius: '4px' }}
            >
              {LANG_OPTIONS.map(l => <option key={l.code} value={l.code} style={{ color: '#1f2937', background: 'white' }}>{l.name}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <button onClick={()=> setPhase('chooseTitle') } disabled={busy}>Choose Title & Start</button>
        </div>
        </div>
      </>
    );
  }

  if (phase === "chooseTitle") {
    return (
      <>
        {isMockMode && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 9999,
            background: 'linear-gradient(135deg, #ff6b6b 0%, #ff8e53 100%)',
            color: 'white',
            padding: '8px 16px',
            textAlign: 'center',
            fontWeight: 800,
            fontSize: 14,
            letterSpacing: '1px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            borderBottom: '3px solid rgba(0,0,0,0.1)'
          }}>
            ⚠️ MOCK MODE ⚠️
          </div>
        )}
        <div style={{ padding: 18, paddingTop: isMockMode ? 48 : 18 }}>
          <h2>Pick a title</h2>
        <div style={{ display:'flex', gap:12, alignItems:'center' }}>
          <div>
            <label>Character</label>
            <select
              value={character}
              onChange={(e)=> setCharacter(e.target.value)}
              style={{ background: 'white', color: '#1f2937', padding: '8px', border: '1px solid #e5e7eb', borderRadius: '4px' }}
            >
              {characterOptions.map(c => <option key={c} style={{ color: '#1f2937', background: 'white' }}>{c}</option>)}
            </select>
          </div>
          <div>
            <label>Place / Object</label>
            <select
              value={objectOrPlace}
              onChange={(e)=> setObjectOrPlace(e.target.value)}
              style={{ background: 'white', color: '#1f2937', padding: '8px', border: '1px solid #e5e7eb', borderRadius: '4px' }}
            >
              {placeOrObjectOptions.map(p => <option key={p} style={{ color: '#1f2937', background: 'white' }}>{p}</option>)}
            </select>
          </div>
          <div>
            <label>Or enter custom title</label>
            <input
              value={storyTitle}
              onChange={(e)=> setStoryTitle(e.target.value)}
              placeholder="Optional custom title"
              style={{ background: 'white', color: '#1f2937', padding: '8px', border: '1px solid #e5e7eb', borderRadius: '4px', width: '300px' }}
            />
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <button onClick={() => { setStoryTitle(storyTitle || `The ${character} and the ${objectOrPlace}`); handleStart(); }} disabled={busy}>Start Story</button>
          <button style={{ marginLeft: 8 }} onClick={()=> setStoryTitle(randomTitle())}>Randomize title</button>
          <button style={{ marginLeft: 8 }} onClick={()=> setPhase('setup')}>Back</button>
        </div>
        </div>
      </>
    );
  }

  // playing phase
  return (
    <>
      {isMockMode && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 9999,
          background: 'linear-gradient(135deg, #ff6b6b 0%, #ff8e53 100%)',
          color: 'white',
          padding: '8px 16px',
          textAlign: 'center',
          fontWeight: 800,
          fontSize: 14,
          letterSpacing: '1px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          borderBottom: '3px solid rgba(0,0,0,0.1)'
        }}>
          ⚠️ MOCK MODE ⚠️
        </div>
      )}

      <div style={{
        height: '100vh',
        paddingTop: isMockMode ? 40 : 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxSizing: 'border-box'
      }}>
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

        {/* Main content area: cards + history */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* Left: Cards section + fixed input at bottom */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            {/* Scrollable cards area */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3>{storyTitle} (session: {sessionId})</h3>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
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
                ← Back to Home
              </button>
            )}
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

        {/* Row 2: Advanced Cards from cards_deck_150.json */}
        <div style={{ marginTop: 24 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {visibleCards2.map((c, i) => {
              const highlight = replacedHighlights[c.id];
              const isHighlighted = !!highlight;
              const isHovered = hoverCard2Index === i;
              const displayText = isHovered
                ? getHintForLearningLang(c, learning.code)
                : c.text_en;

              return (
                <div key={c.id} style={{ position: 'relative' }}>
                  <div
                    className={isHighlighted ? "card-highlight" : ""}
                    onMouseEnter={() => setHoverCard2Index(i)}
                    onMouseLeave={() => setHoverCard2Index(null)}
                    style={{
                      backgroundImage: "url(/cardFront.png)",
                      backgroundSize: "cover",
                      width: 132,
                      height: 174,
                      border: '2px solid #333',
                      padding: 8,
                      borderRadius: 8,
                      transition: 'transform 220ms ease, border-color 220ms ease, background-color 150ms ease',
                      transformOrigin: 'center',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'flex-start',
                      gap: 6,
                      backgroundColor: isHovered ? 'rgba(255, 248, 220, 0.9)' : undefined,
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{
                      fontWeight: 700,
                      color: "blue",
                      wordBreak: 'break-word',
                      fontSize: isHovered ? 11 : 13,
                      transition: 'font-size 150ms ease'
                    }}>
                      {displayText}
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.8, color: "blue" }}>
                      {c.type}
                    </div>
                    <div style={{ fontSize: 10, opacity: 0.7, color: "blue" }}>
                      Difficulty: {c.difficulty}
                    </div>
                    <button
                      style={{ marginTop: 'auto', fontSize: 11 }}
                      onClick={() => swapCard2(i)}
                    >
                      Swap
                    </button>
                  </div>

                  {isHighlighted && (
                    <div className="points-fly">NEW</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
            </div>

            {/* Fixed bottom input - only for left column */}
            <div style={{
              borderTop: '2px solid #ccc',
              padding: 16,
              background: '#fafafa',
              boxShadow: '0 -2px 8px rgba(0,0,0,0.1)'
            }}>
              <div style={{ marginBottom: 6, color: '#666', fontSize: 13 }}>
                Hold CTRL + WIN and Speak (Wispr will fill or paste transcript below). Auto-send after pause.
              </div>
              <textarea
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                onMouseEnter={(e) => e.currentTarget.focus()}
                placeholder={`Speak now in ${learning.name} (Wispr → this box) or type a sentence`}
                rows={6}
                style={{
                  width: '98%',
                  padding: 8,
                  fontSize: 14,
                  resize: 'vertical'
                }}
              />
              <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                <button
                  onClick={() => void submitTurn()}
                  disabled={busy}
                  style={{ padding: '8px 16px' }}
                >
                  Send now
                </button>
                <button
                  onClick={() => setTranscript('')}
                  style={{ padding: '8px 16px' }}
                >
                  Clear
                </button>
              </div>
            </div>
          </div>

      {/* Right: History section */}
      <div style={{ width: 420, display: 'flex', flexDirection: 'column', height: '100%', borderLeft: '1px solid #ddd' }}>
        {/* Fixed header */}
        <div style={{ padding: '12px', borderBottom: '2px solid #ddd', background: '#6c6c6cff' }}>
          <h4 style={{ margin: 0, fontSize: 16 }}>History</h4>
        </div>

        {/* Scrollable history list */}
        <div
          ref={historyScrollRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '8px 12px',
            paddingBottom: '200px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8
          }}
        >
          {history.map((h, idx) => {
            const isPlaying = playingIndex === idx;
            const isExpanded = expandedIndex === idx;

            // Helper function to conditionally remove spaces based on hover side
            const displayText = (text: string) =>
              showMoreHoverSide === 'right' ? text.replace(/\s+/g, '') : text;

            return (
              <div
                key={idx}
                style={{
                  padding: 8,
                  border: '1px solid #ddd',
                  borderRadius: 6,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  background: isPlaying ? '#eef6ff' : undefined,
                }}
              >
                {/* ROW 1: Three Buttons */}
                <div style={{ display: 'flex', gap: 8 }}>
                  {/* Button 1: Both Audio (Native → Learning) */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void playHistoryItem(h, idx);
                    }}
                    onMouseEnter={(e) => {
                      e.stopPropagation();
                      setHoverButton({idx, btn: 1});
                      if (hoverTimerRef.current) {
                        window.clearTimeout(hoverTimerRef.current);
                        hoverTimerRef.current = null;
                      }
                      hoverTimerRef.current = window.setTimeout(() => {
                        void startHoverPlayForHistory(h, idx, 'both');
                      }, 1);
                    }}
                    onMouseLeave={(e) => {
                      e.stopPropagation();
                      setHoverButton(null);
                      if (hoverTimerRef.current) {
                        window.clearTimeout(hoverTimerRef.current);
                        hoverTimerRef.current = null;
                      }
                      stopCurrentAudio();
                    }}
                    style={{
                      padding: '6px 12px',
                      flex: 1,
                      fontSize: 12,
                      background: hoverButton?.idx === idx && hoverButton.btn === 1 ? '#f7fff2' : undefined
                    }}
                  >
                    {fluent.name} Audio
                  </button>

                  {/* Button 2: Learning Audio Only */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void playLearningAudioOnly(h, idx);
                    }}
                    onMouseEnter={(e) => {
                      e.stopPropagation();
                      setHoverButton({idx, btn: 2});
                      if (hoverTimerRef.current) {
                        window.clearTimeout(hoverTimerRef.current);
                        hoverTimerRef.current = null;
                      }
                      hoverTimerRef.current = window.setTimeout(() => {
                        void startHoverPlayForHistory(h, idx, 'learning');
                      }, 1);
                    }}
                    onMouseLeave={(e) => {
                      e.stopPropagation();
                      setHoverButton(null);
                      if (hoverTimerRef.current) {
                        window.clearTimeout(hoverTimerRef.current);
                        hoverTimerRef.current = null;
                      }
                      stopCurrentAudio();
                    }}
                    style={{
                      padding: '6px 12px',
                      flex: 1,
                      fontSize: 12,
                      background: hoverButton?.idx === idx && hoverButton.btn === 2 ? '#f7fff2' : undefined
                    }}
                  >
                    {learning.name} Audio
                  </button>

                  {/* Button 3: Show More - Split into two hover zones */}
                  <button
                    onMouseMove={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const relativeX = e.clientX - rect.left;
                      const halfWidth = rect.width / 2;
                      const side = relativeX < halfWidth ? 'left' : 'right';
                      setShowMoreHoverSide(side);
                      setHoverButton({idx, btn: 3});
                      setExpandedIndex(idx);
                    }}
                    onMouseLeave={(e) => {
                      e.stopPropagation();
                      setHoverButton(null);
                      setExpandedIndex(null);
                      setShowMoreHoverSide(null);
                    }}
                    style={{
                      padding: '6px 12px',
                      flex: 1,
                      fontSize: 12,
                      background: hoverButton?.idx === idx && hoverButton.btn === 3
                        ? (showMoreHoverSide === 'left' ? '#fffae6' : '#ffe6f0')
                        : undefined,
                      position: 'relative',
                      overflow: 'hidden'
                    }}
                  >
                    {/* Visual split indicator */}
                    {hoverButton?.idx === idx && hoverButton.btn === 3 && (
                      <div style={{
                        position: 'absolute',
                        top: 0,
                        left: '50%',
                        bottom: 0,
                        width: 1,
                        background: 'rgba(0,0,0,0.1)',
                        pointerEvents: 'none'
                      }} />
                    )}
                    <span style={{ position: 'relative', zIndex: 1 }}>
                      Show More {isExpanded ? '▲' : '▼'}
                    </span>
                  </button>
                </div>

                {/* ROW 2: Native Translation (Always Visible) */}
                <div style={{ padding: '4px 0' }}>
                  <strong>{fluent.name}:</strong> {h.native_translation ?? h.translation ?? ''}
                </div>

                {/* Hidden Details (Shown on Button 3 Hover) */}
                {isExpanded && (
                  <div style={{
                    padding: 8,
                    background: '#f9f9f9',
                    borderRadius: 4,
                    border: '1px solid #e0e0e0',
                    color: 'red',
                    minHeight: 80,
                    position: 'relative'
                  }}>
                    <div style={{ marginBottom: 6, wordBreak: 'break-word', overflowWrap: 'break-word' }}>
                      <strong>Corrected ({learning.name}):</strong> {displayText(h.corrected_sentence || '')}
                    </div>
                    <div style={{ marginBottom: 6 }}>
                      <strong>Used cards:</strong> {(h.used_cards || h.used_card_ids || []).join(', ') || 'None'}
                    </div>
                    <div style={{ marginBottom: 6 }}>
                      <strong>ASR fixes:</strong> {
                        (h.asr_fixes || [])
                          .map((f: any) => `${f.original}→${f.guess}`)
                          .join(', ') || 'None'
                      }
                    </div>
                    {h.brief_explanation_native && (
                      <div style={{ fontStyle: 'italic', color: '#666' }}>
                        {h.brief_explanation_native}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      </div>
      </div>
    </>
  );
}
