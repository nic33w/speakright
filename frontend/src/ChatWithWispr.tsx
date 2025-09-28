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
 *    POST /api/confirm     -> returns { turn_id, corrected_pairs, reply_pairs, correction_explanation, audio_base64 per pair ... }
 */

type LangSpec = { code: string; name: string };

type SentencePair = {
  id: string; // unique per sentence
  native: string; // fluent language text (top)
  learning: string; // target language text (bottom)
  audio_base64?: string | null; // optional per-sentence audio (base64)
};

type Message =
  | { kind: "translation_check"; turnId: string; joinedEnglish: string; userPairs: SentencePair[] }
  | { kind: "pair"; turnId: string; side: "user" | "reply"; pair: SentencePair }
  | { kind: "explanation"; turnId?: string; text: string }
  | { kind: "status"; text: string };

const generateId = () => Math.random().toString(36).slice(2, 9);
const VITE_MOCK_MODE = Boolean(import.meta.env.VITE_MOCK_MODE);

export default function ChatWithWispr({
  apiBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000",
}: { apiBase?: string }) {
  // --- session languages (default) ---
  const [fluentLanguage] = useState<LangSpec>({ code: "en", name: "English" }); // top
  const [learningLanguage] = useState<LangSpec>({ code: "es", name: "Spanish" }); // bottom

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);

  // toggles for hiding/showing
  const [showNative, setShowNative] = useState(true);
  const [showLearning, setShowLearning] = useState(true);
  const [showExplanations, setShowExplanations] = useState(true);

  const sessionIdRef = useRef<string>(generateId());
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const chatWindowRef = useRef<HTMLDivElement | null>(null);

  // When new messages are added, only auto-scroll if user was already near bottom.
  // This ref is set in pushMessage / replaceMessagesWithTurn *before* changing state.
  const shouldAutoScrollRef = useRef<boolean>(true);
  // px threshold to consider "near bottom"
  const NEAR_BOTTOM_PX = 500;

  // showJump indicates whether to display the "Jump to newest" button
  const [showJump, setShowJump] = useState(false);

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

  // Very simple heuristic to detect Spanish/learning language (accented letters or common words).
  function isProbablyLearning(text: string) {
    if (!text.trim()) return false;
    const lower = text.toLowerCase();
    if (/[áéíóúñ¿¡]/.test(lower)) return true;
    const words = ["que", "por", "para", "hola", "gracias", "quiero", "buen", "mañana", "cómo", "dónde"];
    return words.some((w) => new RegExp(`\\b${w}\\b`).test(lower));
  }

  // convert base64 to object URL and play
  function playBase64(base64?: string | null) {
    if (!base64) return;
    try {
      const binary = atob(base64);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.play().catch((e) => console.warn("Audio play failed:", e));
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      console.error("playBase64 error", e);
    }
  }

  async function playSequence(pairs: SentencePair[]) {
    for (const p of pairs) {
      if (p.audio_base64) {
        await new Promise<void>((resolve) => {
          const binary = atob(p.audio_base64 || "");
          const arr = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
          const blob = new Blob([arr], { type: "audio/wav" });
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.onended = () => {
            URL.revokeObjectURL(url);
            resolve();
          };
          audio.onerror = () => resolve();
          audio.play().catch(() => resolve());
        });
      }
    }
  }

  // submit flow for typed/pasted text
  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    // decide if user typed in learning language (bottom) or native (top)
    const probablyLearning = isProbablyLearning(trimmed);

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
        }));

        // push a translation_check object (user can edit the joined English meaning)
        const joinedEnglish = pairs.map((p) => p.native).join("\n");
        pushMessage({
          kind: "translation_check",
          turnId,
          joinedEnglish,
          userPairs: pairs,
        });
        setInput(joinedEnglish);
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
        }));
        const replyPairs: SentencePair[] = (data.reply_pairs || []).map((p: any) => ({
          id: generateId(),
          native: p.native,
          learning: p.learning,
          audio_base64: p.audio_base64 ?? null,
        }));

        // remove status messages
        setMessages((m) => m.filter((x) => x.kind !== "status"));

        // push corrected user pairs (left) and reply pairs (right)
        const newMessages: Message[] = [];
        for (const cp of correctedPairs) newMessages.push({ kind: "pair", turnId, side: "user", pair: cp });
        if (data.correction_explanation) newMessages.push({ kind: "explanation", turnId, text: data.correction_explanation });
        for (const rp of replyPairs) newMessages.push({ kind: "pair", turnId, side: "reply", pair: rp });

        replaceMessagesWithTurn(turnId, newMessages);

        // optionally auto-play first user audio then reply sequence
        if (correctedPairs.length && correctedPairs[0].audio_base64) {
          playBase64(correctedPairs[0].audio_base64);
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

  // Confirm flow: after the user edits the English meaning and presses confirm
  async function confirmEditedEnglish(editedEnglishJoined: string, originalTurn?: { userPairs: SentencePair[]; turnId: string }) {
    // editedEnglishJoined is the joined native-language text (multi-line)
    if (!editedEnglishJoined || loading) return;
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
        confirmed_native_joined: editedEnglishJoined,
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
      }));
      const replyPairs: SentencePair[] = (data.reply_pairs || []).map((p: any) => ({
        id: generateId(),
        native: p.native,
        learning: p.learning,
        audio_base64: p.audio_base64 ?? null,
      }));

      setMessages((m) => m.filter((x) => x.kind !== "status"));

      // Replace any translation_check and pending pairs for this turnId with final corrected + reply
      const newMessages: Message[] = [];
      for (const cp of correctedPairs) newMessages.push({ kind: "pair", turnId, side: "user", pair: cp });
      if (data.correction_explanation && showExplanations) newMessages.push({ kind: "explanation", turnId, text: data.correction_explanation });
      for (const rp of replyPairs) newMessages.push({ kind: "pair", turnId, side: "reply", pair: rp });

      replaceMessagesWithTurn(turnId, newMessages);

      // optionally play first corrected audio then reply
      if (correctedPairs.length && correctedPairs[0].audio_base64) {
        playBase64(correctedPairs[0].audio_base64);
        // then reply sequence after short delay
        setTimeout(() => playSequence(replyPairs), 900 + correctedPairs[0].native.split(" ").length * 120);
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

  // --- Render functions ---
  function renderPair(m: Extract<Message, { kind: "pair" }>) {
    const { pair, side } = m;
    const isUser = side === "user";
    const wrapperStyle: React.CSSProperties = {
      ...bubbleStyle(isUser ? "user" : "reply"),
      alignSelf: isUser ? "flex-start" : "flex-end",
      cursor: pair.audio_base64 ? "pointer" : "default",
      display: "inline-block",
      minWidth: 160,
      maxWidth: "85%",
      textAlign: isUser ? "left" : "right",
    };

    return (
      <div
        key={m.turnId + ":" + pair.id}
        style={wrapperStyle}
        role="button"
        onClick={() => {
          // clicking a pair plays its audio if present
          if (pair.audio_base64) playBase64(pair.audio_base64);
        }}
      >
        {showNative && <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>{pair.native}</div>}
        {showLearning && <div style={{ fontSize: 16, fontWeight: 700 }}>{pair.learning}</div>}
      </div>
    );
  }

  function renderTranslationCheck(m: Extract<Message, { kind: "translation_check" }>) {
    return (
      <div key={m.turnId} style={bubbleStyle("translation_check")}>
        <div style={{ marginBottom: 8, opacity: 0.9 }}>Is this what you meant? (edit the native text below and press Confirm)</div>
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

  // Handler for Jump button
  function jumpToNewest() {
    const el = chatWindowRef.current;
    if (!el) return;
    shouldAutoScrollRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setShowJump(false);
  }

  return (
    <div style={{ ...styles.container, height: "100vh", position: "relative" }}>
      {/* Sticky toolbar */}
      <div style={{ ...styles.toolbar, position: "sticky", top: 0, zIndex: 40, background: "#071226" }}>
        <div style={{ display: "flex", gap: 12 }}>
          <label style={styles.toggleLabel}>
            <input type="checkbox" checked={showNative} onChange={() => setShowNative((s) => !s)} /> Show {fluentLanguage.name}
          </label>
          <label style={styles.toggleLabel}>
            <input type="checkbox" checked={showLearning} onChange={() => setShowLearning((s) => !s)} /> Show {learningLanguage.name}
          </label>
          <label style={styles.toggleLabel}>
            <input type="checkbox" checked={showExplanations} onChange={() => setShowExplanations((s) => !s)} /> Show explanations
          </label>
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
          placeholder={awaitingConfirm ? `Edit the ${fluentLanguage.name} meaning and press Confirm` : `Type or paste ${learningLanguage.name} (or ${fluentLanguage.name}) here`}
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
