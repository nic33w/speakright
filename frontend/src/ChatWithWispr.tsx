// ChatWithWispr.tsx
import React, { useState, useRef, useEffect } from "react";
import type { FormEvent, KeyboardEvent } from "react";

/**
 * ChatWithWispr.tsx
 * - Per-sentence pairs (native on top, learning on bottom)
 * - Fluent/native language + learning language stored in component state
 * - Toggles to hide native or learning text (bubbles still clickable to play audio)
 * - Works with backend endpoints:
 *    POST /api/transcript  -> returns { turn_id, user_pairs: [{ native, learning }] }
 *    POST /api/confirm     -> returns { turn_id, corrected_pairs, reply_pairs, correction_explanation,
 *                                       audio_base64, audio_file (URL) per pair ... }
 */

type LangSpec = { code: string; name: string };

type SentencePair = {
  id: string; // unique per sentence
  native: string; // fluent language text (top)
  learning: string; // target language text (bottom)
  audio_base64?: string | null; // optional per-sentence audio (base64)
  audio_file?: string | null; // optional per-sentence URL returned by backend (e.g. "/api/audio_file/<session>/<filename>")
  audio_filename?: string | null; // backend filename if provided
};

type Message =
  | { kind: "translation_check"; turnId: string; joinedEnglish: string; userPairs: SentencePair[] }
  | { kind: "pair"; turnId: string; side: "user" | "reply"; pair: SentencePair }
  | { kind: "explanation"; turnId?: string; text: string }
  | { kind: "status"; text: string };

const LANG_OPTIONS: LangSpec[] = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "id", name: "Indonesian" },
];

const generateId = () => Math.random().toString(36).slice(2, 9);
const VITE_MOCK_MODE = 0; //Boolean(import.meta.env.VITE_MOCK_MODE);

export default function ChatWithWispr({
  apiBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000",
}: { apiBase?: string }) {
  // --- session languages (default) ---
  const [fluentLanguage, setFluentLanguage] = useState<LangSpec>(LANG_OPTIONS[0]); // top (default English)
  const [learningLanguage, setLearningLanguage] = useState<LangSpec>(LANG_OPTIONS[1]); // bottom (default Spanish)

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);

  // toggles for hiding/showing
  const [showNative, setShowNative] = useState(true);
  const [showLearning, setShowLearning] = useState(true);
  const [showExplanations, setShowExplanations] = useState(true);
  const [showSpaces, setShowSpaces] = useState(true); // for languages like Spanish

  const sessionIdRef = useRef<string>(generateId());
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const chatWindowRef = useRef<HTMLDivElement | null>(null);

  // When new messages are added, only auto-scroll if user was already near bottom.
  // This ref is set in pushMessage / replaceMessagesWithTurn *before* changing state.
  const shouldAutoScrollRef = useRef<boolean>(true);
  // px threshold to consider "near bottom"
  const NEAR_BOTTOM_PX = 160;

  // showJump indicates whether to display the "Jump to newest" button
  const [showJump, setShowJump] = useState(false);

  // Audio object-URL cache for fetched audio files to avoid re-fetching repeatedly.
  // key: audio_filename (backend), value: objectURL
  const audioUrlCacheRef = useRef<Map<string, string>>(new Map());

  // Conversation sidebar state
  const [conversations, setConversations] = useState<Array<{ session_id: string; filename: string; saved_at: number }>>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);

  // --- helpers ---
  function pushMessage(m: Message) {
    // compute whether user is near bottom right now
    const el = chatWindowRef.current;
    if (!el) {
      shouldAutoScrollRef.current = true;
    } else {
      const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
      shouldAutoScrollRef.current = distanceFromBottom < NEAR_BOTTOM_PX;
    }

    setMessages((s) => [...s, m]);
  }

  function replaceMessagesWithTurn(turnId: string, newMessages: Message[]) {
    // compute whether user is near bottom right now
    const el = chatWindowRef.current;
    if (!el) {
      shouldAutoScrollRef.current = true;
    } else {
      const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
      shouldAutoScrollRef.current = distanceFromBottom < NEAR_BOTTOM_PX;
    }

    setMessages((all) => {
      // remove any existing messages for this turn that are translation_check or pair (pending)
      const filtered = all.filter((m) => {
        if ((m as any).turnId && (m as any).turnId === turnId) {
          // drop translation_check and pair for this turn; keep explanation if present (we'll append new explanation)
          return m.kind === "explanation";
        }
        return true;
      });
      return [...filtered, ...newMessages];
    });
  }

  // swap-safe setter helpers:
  function handleSetFluent(newCode: string) {
    const newLang = LANG_OPTIONS.find((l) => l.code === newCode);
    if (!newLang) return;
    // if new selection equals current learning, swap learning to previous fluent
    if (newLang.code === learningLanguage.code) {
      setLearningLanguage(fluentLanguage);
    }
    setFluentLanguage(newLang);
  }
  function handleSetLearning(newCode: string) {
    const newLang = LANG_OPTIONS.find((l) => l.code === newCode);
    if (!newLang) return;
    if (newLang.code === fluentLanguage.code) {
      setFluentLanguage(learningLanguage);
    }
    setLearningLanguage(newLang);
  }

  // two quick preset buttons:
  function presetEnEs() {
    setFluentLanguage(LANG_OPTIONS[0]); // en
    setLearningLanguage(LANG_OPTIONS[1]); // es
  }
  function presetEnId() {
    setFluentLanguage(LANG_OPTIONS[0]); // en
    setLearningLanguage(LANG_OPTIONS[2]); // id
  }

  // Language-aware detection for whether input is in the learning language.
  function isProbablyLearning(text: string, langCode: string = learningLanguage.code) {
    if (!text || !text.trim()) return false;
    const lower = text.toLowerCase();

    if (langCode === "es") {
      if (/[áéíóúñ¿¡]/.test(lower)) return true;
      const words = ["que", "por", "para", "hola", "gracias", "quiero", "buen", "mañana", "cómo", "dónde", "está", "esta", "ser", "estar"];
      return words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(lower));
    }

    if (langCode === "id") {
      // Indonesian heuristics
      const words = ["dan", "saya", "kamu", "apa", "terima", "kasih", "selamat", "kabar", "ini", "itu", "sudah", "belum", "di", "ke", "dengan"];
      if (/\w+lah\b/.test(lower)) return true;
      return words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(lower));
    }

    // fallback for English: basic keywords (rarely used)
    if (langCode === "en") {
      const words = ["the", "is", "and", "you", "are", "i", "want", "please", "thanks"];
      return words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(lower));
    }

    return false;
  }

  // convert base64 to object URL and play — now returns a Promise that resolves on end (so sequential playback is possible)
  function playBase64(base64?: string | null): Promise<boolean> {
    if (!base64) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      try {
        const binary = atob(base64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: "audio/wav" });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);

        const cleanup = () => {
          URL.revokeObjectURL(url);
        };

        audio.onended = () => {
          cleanup();
          resolve(true);
        };
        audio.onerror = () => {
          cleanup();
          resolve(false);
        };
        // start playback; if it fails to start (autoplay), resolve(false)
        audio.play().then(() => {
          // playing started — wait for 'ended'
        }).catch((e) => {
          // couldn't start playback (user gesture/autoplay policy)
          cleanup();
          resolve(false);
        });
      } catch (e) {
        console.error("playBase64 error", e);
        resolve(false);
      }
    });
  }

  // fetch audio file URL (backend file endpoint) and play. caches object URL by filename.
  // returns Promise<boolean> that resolves when playback ends (or false on failure)
  async function fetchAndPlayAudioFile(audioFilePath: string | undefined, audioFilename?: string | null): Promise<boolean> {
    if (!audioFilePath) return false;
    try {
      // If we have cached object URL for filename, reuse it
      if (audioFilename) {
        const cached = audioUrlCacheRef.current.get(audioFilename);
        if (cached) {
          return await new Promise<boolean>((resolve) => {
            const audio = new Audio(cached);
            audio.onended = () => resolve(true);
            audio.onerror = () => resolve(false);
            audio.play().catch(() => resolve(false));
          });
        }
      }

      // fetch the file from backend (audioFilePath is returned by backend, usually like "/api/audio_file/<session>/<filename>")
      const fullUrl = audioFilePath.startsWith("http") ? audioFilePath : `${apiBase}${audioFilePath}`;
      const resp = await fetch(fullUrl);
      if (!resp.ok) throw new Error("audio fetch failed");
      const blob = await resp.blob();
      const objectUrl = URL.createObjectURL(blob);
      // cache if filename available
      if (audioFilename) audioUrlCacheRef.current.set(audioFilename, objectUrl);

      return await new Promise<boolean>((resolve) => {
        const audio = new Audio(objectUrl);
        audio.onended = () => resolve(true);
        audio.onerror = () => resolve(false);
        audio.play().catch(() => resolve(false));
      });
    } catch (e) {
      // network failure or file not ready
      return false;
    }
  }

  // play a single pair, returns Promise<boolean> that resolves when done (true if played through)
  async function playAudioForPair(pair: SentencePair): Promise<boolean> {
    // prefer audio_file (backend-served file) if present and fetchable; fallback to audio_base64
    if (pair.audio_file) {
      const ok = await fetchAndPlayAudioFile(pair.audio_file, pair.audio_filename);
      if (ok) return true;
    }
    if (pair.audio_base64) {
      return await playBase64(pair.audio_base64);
    }
    return false;
  }

  // play sequence of pairs sequentially
  async function playSequence(pairs: SentencePair[]) {
    for (const p of pairs) {
      // for sequence we try audio_file first, else base64
      if (p.audio_file) {
        const ok = await fetchAndPlayAudioFile(p.audio_file, p.audio_filename);
        if (ok) continue;
      }
      if (p.audio_base64) {
        // await base64 playback
        await playBase64(p.audio_base64);
      }
    }
  }

  // submit flow for typed/pasted text
  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    // decide if user typed in learning language (bottom) or native (top)
    const probablyLearning = isProbablyLearning(trimmed, learningLanguage.code);

    setLoading(true);
    const turnId = `turn_${Date.now().toString(36)}`;

    try {
      if (probablyLearning) {
        // User input is in learning language -> ask transcript endpoint to split+translate (learning->native)
        pushMessage({
          kind: "status",
          text: "Translating & aligning sentences...",
        });

        const body = {
          session_id: sessionIdRef.current,
          fluent_language: fluentLanguage,
          learning_language: learningLanguage,
          input_language: learningLanguage,
          text: trimmed,
        };

        const res = await fetch(`${apiBase}/api/transcript`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`transcript failed ${res.status}`);

        const data = await res.json();
        // server returns user_pairs: [{ native, learning }]
        const pairs: SentencePair[] = (data.user_pairs || []).map((p: any) => ({
          id: generateId(),
          native: p.native,
          learning: p.learning,
          audio_base64: p.audio_base64 ?? null,
          audio_file: p.audio_file ?? null,
          audio_filename: p.audio_filename ?? null,
        }));

        // push a translation_check object (user can edit the joined native meaning)
        const joinedNative = pairs.map((p) => p.native).join("\n");
        pushMessage({
          kind: "translation_check",
          turnId,
          joinedEnglish: joinedNative,
          userPairs: pairs,
        });
        setInput(joinedNative);
        setAwaitingConfirm(true);
      } else {
        // User typed in native language -> go straight to generating learning-language sentence(s) + reply
        pushMessage({ kind: "status", text: "Generating target-language phrasing & reply..." });

        const body = {
          session_id: sessionIdRef.current,
          fluent_language: fluentLanguage,
          learning_language: learningLanguage,
          input_language: fluentLanguage,
          text: trimmed,
        };

        const res = await fetch(`${apiBase}/api/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`confirm failed ${res.status}`);
        const data = await res.json();

        // The confirm response returns corrected_pairs and reply_pairs (arrays)
        const correctedPairs: SentencePair[] = (data.corrected_pairs || []).map((p: any) => ({
          id: generateId(),
          native: p.native,
          learning: p.learning,
          audio_base64: p.audio_base64 ?? null,
          audio_file: p.audio_file ?? null,
          audio_filename: p.audio_filename ?? null,
        }));
        const replyPairs: SentencePair[] = (data.reply_pairs || []).map((p: any) => ({
          id: generateId(),
          native: p.native,
          learning: p.learning,
          audio_base64: p.audio_base64 ?? null,
          audio_file: p.audio_file ?? null,
          audio_filename: p.audio_filename ?? null,
        }));

        // remove status messages
        setMessages((m) => m.filter((x) => x.kind !== "status"));

        // push corrected user pairs (left) and reply pairs (right)
        const newMessages: Message[] = [];
        for (const cp of correctedPairs) newMessages.push({ kind: "pair", turnId, side: "user", pair: cp });
        if (data.correction_explanation) newMessages.push({ kind: "explanation", turnId, text: data.correction_explanation });
        for (const rp of replyPairs) newMessages.push({ kind: "pair", turnId, side: "reply", pair: rp });

        replaceMessagesWithTurn(turnId, newMessages);

        // sequential playback: await corrected first (if available) then replies
        if (correctedPairs.length && (correctedPairs[0].audio_file || correctedPairs[0].audio_base64)) {
          // await the first corrected audio, then play reply sequence
          await playAudioForPair(correctedPairs[0]);
          await playSequence(replyPairs);
        }
        setInput("");
      }
    } catch (err) {
      console.error("submit error", err);
      // simple user-visible failure
      pushMessage({ kind: "status", text: "Failed to process — see console." });
    } finally {
      setLoading(false);
    }
  }

  // Confirm flow: after the user edits the native meaning and presses confirm
  async function confirmEditedEnglish(editedNativeJoined: string, originalTurn?: { userPairs: SentencePair[]; turnId: string }) {
    // editedNativeJoined is the joined native-language text (multi-line)
    if (!editedNativeJoined || loading) return;
    setLoading(true);
    const turnId = originalTurn?.turnId ?? `turn_${Date.now().toString(36)}`;

    try {
      pushMessage({ kind: "status", text: "Applying corrections & generating reply..." });

      const body = {
        session_id: sessionIdRef.current,
        fluent_language: fluentLanguage,
        learning_language: learningLanguage,
        // when confirming, send both original learning sentences (if available) and the edited native text
        original_pairs: originalTurn?.userPairs?.map((p) => ({ native: p.native, learning: p.learning })) ?? [],
        confirmed_native_joined: editedNativeJoined,
      };

      const res = await fetch(`${apiBase}/api/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`confirm failed ${res.status}`);
      const data = await res.json();

      // server returns corrected_pairs and reply_pairs
      const correctedPairs: SentencePair[] = (data.corrected_pairs || []).map((p: any) => ({
        id: generateId(),
        native: p.native,
        learning: p.learning,
        audio_base64: p.audio_base64 ?? null,
        audio_file: p.audio_file ?? null,
        audio_filename: p.audio_filename ?? null,
      }));
      const replyPairs: SentencePair[] = (data.reply_pairs || []).map((p: any) => ({
        id: generateId(),
        native: p.native,
        learning: p.learning,
        audio_base64: p.audio_base64 ?? null,
        audio_file: p.audio_file ?? null,
        audio_filename: p.audio_filename ?? null,
      }));

      setMessages((m) => m.filter((x) => x.kind !== "status"));

      // Replace any translation_check and pending pairs for this turnId with final corrected + reply
      const newMessages: Message[] = [];
      for (const cp of correctedPairs) newMessages.push({ kind: "pair", turnId, side: "user", pair: cp });
      if (data.correction_explanation && showExplanations) newMessages.push({ kind: "explanation", turnId, text: data.correction_explanation });
      for (const rp of replyPairs) newMessages.push({ kind: "pair", turnId, side: "reply", pair: rp });

      replaceMessagesWithTurn(turnId, newMessages);

      // sequential playback: await corrected first (if available) then replies
      if (correctedPairs.length && (correctedPairs[0].audio_file || correctedPairs[0].audio_base64)) {
        await playAudioForPair(correctedPairs[0]);
        await playSequence(replyPairs);
      }

      setInput("");
      setAwaitingConfirm(false);
    } catch (err) {
      console.error("confirm error", err);
      setMessages((m) => m.filter((x) => x.kind !== "status"));
      pushMessage({ kind: "status", text: "Failed to confirm — see console." });
    } finally {
      setLoading(false);
    }
  }

  // UI handlers
  function handleFormSubmit(e: FormEvent) {
    e.preventDefault();
    if (awaitingConfirm) {
      // find last translation_check for the current turn (the most recent)
      const lastCheck = [...messages].reverse().find((m) => m.kind === "translation_check") as
        | (Message & { kind: "translation_check" })
        | undefined;
      // ensure userPairs is an array (avoid undefined)
      confirmEditedEnglish(
        input.trim(),
        lastCheck
          ? { turnId: lastCheck.turnId, userPairs: lastCheck.userPairs ?? [] }
          : undefined
      );

    } else {
      handleSubmit();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleFormSubmit(e as any);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = (e.clipboardData || (window as any).clipboardData)?.getData("text");
    if (pasted && pasted.trim()) {
      e.preventDefault();
      setInput(pasted);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  // ---------- conversation sidebar functions ----------
  async function fetchConversations() {
    if (VITE_MOCK_MODE) {
      setConversations([]);
      return;
    }
    try {
      const res = await fetch(`${apiBase}/api/conversations`);
      if (!res.ok) throw new Error("failed to list conversations");
      const arr = await res.json();
      setConversations(arr || []);
    } catch (e) {
      console.warn("fetchConversations failed", e);
    }
  }

  // sanitize messages before saving: remove audio_base64 payloads to keep JSON small
  function sanitizeMessagesForSave(msgs: Message[]) {
    return msgs.map((m) => {
      if (m.kind === "pair") {
        const p = { ...m.pair } as SentencePair;
        // remove heavy base64 if present
        if ("audio_base64" in p) delete (p as any).audio_base64;
        return { ...m, pair: p };
      }
      if (m.kind === "translation_check") {
        const userPairs = (m.userPairs || []).map((p) => {
          const copy = { ...p } as SentencePair;
          if ("audio_base64" in copy) delete (copy as any).audio_base64;
          return copy;
        });
        return { ...m, userPairs };
      }
      return m;
    });
  }

  async function saveConversation() {
    if (VITE_MOCK_MODE) {
      alert("Mock mode: conversations are not saved.");
      return;
    }
    try {
      const sessionId = sessionIdRef.current;
      const payload = {
        messages: sanitizeMessagesForSave(messages),
        fluent_language: fluentLanguage,
        learning_language: learningLanguage,
      };
      const res = await fetch(`${apiBase}/api/conversations/${sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`save failed ${res.status}`);
      await fetchConversations();
      alert("Saved.");
    } catch (e) {
      console.error("saveConversation failed", e);
      alert("Save failed — see console.");
    }
  }

  async function loadConversation(sessionId: string) {
    try {
      const res = await fetch(`${apiBase}/api/conversations/${sessionId}`);
      if (!res.ok) throw new Error(`load failed ${res.status}`);
      const data = await res.json();
      // Load messages; optionally set languages if stored
      if (Array.isArray(data.messages)) setMessages(data.messages);
      if (data.fluent_language) setFluentLanguage(data.fluent_language);
      if (data.learning_language) setLearningLanguage(data.learning_language);
      sessionIdRef.current = data.session_id || sessionId;
      setSelectedSession(sessionId);
      // clear audio cache — object URLs might map to other sessions
      audioUrlCacheRef.current.forEach((url) => URL.revokeObjectURL(url));
      audioUrlCacheRef.current.clear();
    } catch (e) {
      console.error("loadConversation failed", e);
      alert("Failed to load conversation — see console.");
    }
  }

  // ---------- layout adjustments for sticky toolbar + sticky form ----------
  // set this to match the visible height of your form (padding + textarea height). Adjust if you style the form.
  const FORM_HEIGHT_PX = 92;

  // Auto-scroll: only when user was already near bottom before the update.
  useEffect(() => {
    const el = chatWindowRef.current;
    if (!el) return;

    if (shouldAutoScrollRef.current) {
      // scroll, hide the jump button
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      setShowJump(false);
    } else {
      // we did not auto-scroll; show the jump button so user can jump manually
      setShowJump(true);
    }
  }, [messages]);

  // Track user scrolling in the chat window so we can decide whether to show "Jump to newest".
  useEffect(() => {
    const el = chatWindowRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
      setShowJump(distanceFromBottom > NEAR_BOTTOM_PX);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // run once to set initial visibility
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // fetch conversations list at startup (unless mock)
  useEffect(() => {
    fetchConversations();
    // cleanup audio object URLs when unmounting
    return () => {
      audioUrlCacheRef.current.forEach((url) => URL.revokeObjectURL(url));
      audioUrlCacheRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handler for Jump button
  function jumpToNewest() {
    const el = chatWindowRef.current;
    if (!el) return;
    shouldAutoScrollRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setShowJump(false);
  }

  // --- Render functions ---
  function renderPair(m: Extract<Message, { kind: "pair" }>) {
    const { pair, side } = m;
    const isUser = side === "user";
    const wrapperStyle: React.CSSProperties = {
      ...bubbleStyle(isUser ? "user" : "reply"),
      alignSelf: isUser ? "flex-start" : "flex-end",
      cursor: (pair.audio_file || pair.audio_base64) ? "pointer" : "default",
      display: "inline-block",
      minWidth: 160,
      maxWidth: "85%",
      textAlign: isUser ? "left" : "right",
    };

    // If showSpaces is false, remove spaces (user requested)
    const learningText = showSpaces ? pair.learning : pair.learning.replaceAll?.(" ", "") ?? pair.learning.split(" ").join("");

    return (
      <div
        key={m.turnId + ":" + pair.id}
        style={wrapperStyle}
        role="button"
        onClick={() => {
          // clicking a pair plays its audio if present (fire-and-forget ok for user clicks)
          void playAudioForPair(pair);
        }}
      >
        {showNative && <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>{pair.native}</div>}
        {showLearning && <div style={{ fontSize: 16, fontWeight: 700 }}>{learningText}</div>}
      </div>
    );
  }

  function renderTranslationCheck(m: Extract<Message, { kind: "translation_check" }>) {
    return (
      <div key={m.turnId} style={bubbleStyle("translation_check")}>
        <div style={{ marginBottom: 8, opacity: 0.9 }}>Is this what you meant? (edit the {fluentLanguage.name} text below and press Confirm)</div>
        <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{m.joinedEnglish}</div>
      </div>
    );
  }

  function renderExplanation(m: Extract<Message, { kind: "explanation" }>) {
    if (!showExplanations) return null;
    return (
      <div key={m.text + (m.turnId ?? "")} style={bubbleStyle("explanation")}>
        <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100vh", background: "#071226" }}>
      {/* Sidebar */}
      <div style={{ width: 260, borderRight: "1px solid rgba(255,255,255,0.04)", padding: 12, background: "#061025", color: "#cbd5e1", boxSizing: "border-box" }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: "#e6eef8" }}>Conversations</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button onClick={() => fetchConversations()} style={{ flex: 1, padding: "6px 8px", borderRadius: 6, background: "#0ea5a4", border: "none", color: "#021014", fontWeight: 700 }}>
            Refresh
          </button>
          <button onClick={() => saveConversation()} style={{ flex: 1, padding: "6px 8px", borderRadius: 6, background: VITE_MOCK_MODE ? "#555" : "#ffff7a", border: "none", color: "#021014", fontWeight: 700 }} disabled={VITE_MOCK_MODE}>
            Save
          </button>
        </div>

        <div style={{ overflowY: "auto", maxHeight: "calc(100vh - 180px)" }}>
          {conversations.length === 0 && <div style={{ fontSize: 13, color: "#94a3b8" }}>No saved conversations</div>}
          {conversations.map((c) => (
            <div
              key={c.session_id}
              onClick={() => loadConversation(c.session_id)}
              style={{
                padding: 8,
                borderRadius: 8,
                cursor: "pointer",
                background: selectedSession === c.session_id ? "#0b6b5b" : "transparent",
                marginBottom: 6,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700 }}>{c.session_id}</div>
              <div style={{ fontSize: 12, color: "#94a3b8" }}>{new Date(c.saved_at * 1000).toLocaleString()}</div>
            </div>
          ))}
        </div>

        <div style={{ position: "absolute", bottom: 20, left: 12, right: 12, fontSize: 12, color: "#94a3b8" }}>
          <div>Session: <strong style={{ color: "#e6eef8" }}>{sessionIdRef.current}</strong></div>
          <div style={{ marginTop: 6 }}>Language: <strong style={{ color: "#e6eef8" }}>{fluentLanguage.name} ↔ {learningLanguage.name}</strong></div>
        </div>
      </div>

      {/* Main chat area */}
      <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
        {/* Sticky toolbar */}
        <div style={{ ...styles.toolbar, position: "sticky", top: 0, zIndex: 40, background: "#071226" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {/* toggles */}
            <label style={styles.toggleLabel}>
              <input type="checkbox" checked={showNative} onChange={() => setShowNative((s) => !s)} /> Show {fluentLanguage.name}
            </label>
            <label style={styles.toggleLabel}>
              <input type="checkbox" checked={showLearning} onChange={() => setShowLearning((s) => !s)} /> Show {learningLanguage.name}
            </label>
            <label style={styles.toggleLabel}>
              <input type="checkbox" checked={showSpaces} onChange={() => setShowSpaces((s) => !s)} /> Show spaces for {learningLanguage.name}
            </label>
            <label style={styles.toggleLabel}>
              <input type="checkbox" checked={showExplanations} onChange={() => setShowExplanations((s) => !s)} /> Show explanations
            </label>

            {/* language selects */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: 8 }}>
              <div style={{ fontSize: 12, color: "#94a3b8", marginRight: 6 }}>Native:</div>
              <select
                value={fluentLanguage.code}
                onChange={(e) => handleSetFluent(e.target.value)}
                style={{ padding: "6px 8px", borderRadius: 6, background: "#0b1220", color: "#e6eef8", border: "1px solid rgba(255,255,255,0.06)" }}
              >
                {LANG_OPTIONS.map((l) => (
                  <option key={l.code} value={l.code} style={{ background: "#0b1220", color: "#e6eef8" }}>
                    {l.name}
                  </option>
                ))}
              </select>

              <div style={{ fontSize: 12, color: "#94a3b8", marginLeft: 8, marginRight: 6 }}>Learning:</div>
              <select
                value={learningLanguage.code}
                onChange={(e) => handleSetLearning(e.target.value)}
                style={{ padding: "6px 8px", borderRadius: 6, background: "#0b1220", color: "#e6eef8", border: "1px solid rgba(255,255,255,0.06)" }}
              >
                {LANG_OPTIONS.map((l) => (
                  <option key={l.code} value={l.code} style={{ background: "#0b1220", color: "#e6eef8" }}>
                    {l.name}
                  </option>
                ))}
              </select>

              {/* preset buttons */}
              <button type="button" onClick={presetEnEs} style={{ marginLeft: 8, padding: "6px 10px", borderRadius: 6, background: "#ffff7aff", border: "none", color: "#021014", fontWeight: 700 }}>
                EN ↔ ES
              </button>
              <button type="button" onClick={presetEnId} style={{ padding: "6px 10px", borderRadius: 6, background: "#4141ffff", border: "none", color: "#021014", fontWeight: 700 }}>
                EN ↔ ID
              </button>
            </div>
          </div>

          <div style={{ fontSize: 12, color: "#94a3b8" }}>
            Session: {sessionIdRef.current} — {fluentLanguage.name} ↔ {learningLanguage.name}
          </div>
        </div>

        {/* Scrollable chat area — reserve space at bottom for sticky form */}
        <div ref={chatWindowRef} style={{ ...styles.chatWindow, paddingBottom: FORM_HEIGHT_PX + 12 }}>
          {messages.map((m) => {
            if (m.kind === "pair") return renderPair(m);
            if (m.kind === "translation_check") return renderTranslationCheck(m);
            if (m.kind === "explanation") return renderExplanation(m);
            if (m.kind === "status")
              return (
                <div key={"status-" + m.text} style={bubbleStyle("status")}>
                  {m.text}
                </div>
              );
            return null;
          })}
          {loading && (
            <div style={{ color: "#94a3b8", fontSize: 13, padding: 6, alignSelf: "center" }}>Loading...</div>
          )}
        </div>

        {/* Jump-to-newest button (appears when scrolled up) */}
        {showJump && (
          <button
            onClick={jumpToNewest}
            style={{
              position: "absolute",
              right: 20,
              bottom: FORM_HEIGHT_PX + 20,
              zIndex: 60,
              background: "#0ea5a4",
              border: "none",
              padding: "8px 12px",
              borderRadius: 999,
              color: "#021014",
              boxShadow: "0 6px 18px rgba(2,6,23,0.6)",
              cursor: "pointer",
              fontWeight: 700,
            }}
            title="Jump to newest messages"
          >
            Jump to newest
          </button>
        )}

        {/* Sticky form */}
        <form
          onSubmit={handleFormSubmit}
          style={{
            ...styles.form,
            position: "sticky",
            bottom: 0,
            zIndex: 50,
            boxShadow: "0 -8px 20px rgba(2,6,23,0.6)",
            background: "#020617",
            padding: 12,
          }}
        >
          <textarea
            ref={inputRef}
            placeholder={
              awaitingConfirm
                ? `Edit the ${fluentLanguage.name} text and press Confirm`
                : `Type or paste ${learningLanguage.name} (or ${fluentLanguage.name}) here`
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            style={styles.textarea}
            rows={2}
            disabled={loading}
          />
          <button type="submit" style={styles.button} disabled={loading}>
            {awaitingConfirm ? "Confirm" : "Send"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------- styles ----------
const styles: { [k: string]: React.CSSProperties } = {
  container: { display: "flex", flexDirection: "column", width: "100%" },
  toolbar: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", gap: 12 },
  toggleLabel: { marginRight: 12, fontSize: 13, color: "#cbd5e1", userSelect: "none" },
  chatWindow: { flex: 1, minHeight: 0, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8, background: "#0f172a", color: "#e2e8f0" },
  form: { display: "flex", gap: 8, padding: 8, borderTop: "1px solid rgba(255,255,255,0.06)", background: "#020617", alignItems: "center" },
  textarea: { flex: 1, resize: "none", padding: 10, borderRadius: 8, border: "1px solid rgba(255,255,255,0.06)", background: "#001122", color: "#e6eef8", fontSize: 14 },
  button: { minWidth: 120, padding: "8px 12px", borderRadius: 8, border: "none", background: "#0ea5a4", color: "#041014", fontWeight: 600, cursor: "pointer" },
};

function bubbleStyle(kind: "user" | "reply" | "translation_check" | "explanation" | "status"): React.CSSProperties {
  const base: React.CSSProperties = { maxWidth: "85%", padding: "10px 12px", borderRadius: 12, marginBottom: 6 };
  switch (kind) {
    case "user":
      return { ...base, background: "#427ccdff", color: "#e6eef8", alignSelf: "flex-start" };
    case "reply":
      return { ...base, background: "#0b6b5b", color: "#e6eef8", alignSelf: "flex-end" };
    case "translation_check":
      return { ...base, background: "#3d2666ff", color: "#dbeafe", alignSelf: "flex-start" };
    case "explanation":
      return { ...base, background: "#3f3f3fff", color: "#f0e9ff", alignSelf: "center" };
    case "status":
      return { ...base, background: "transparent", color: "#94a3b8", alignSelf: "center" };
    default:
      return base;
  }
}
