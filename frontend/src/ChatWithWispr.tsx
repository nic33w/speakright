// ChatWithWispr.tsx
import React, { useState, useRef } from "react";
import type { FormEvent, KeyboardEvent } from "react";

type MsgType = "user_spanish" | "translation_check" | "corrected" | "explanation" | "reply" | "reply_english" | "status";
type ChatMessage = { id: string; type: MsgType; text: string };

const generateId = () => Math.random().toString(36).slice(2, 9);

export default function ChatWithWispr({
  apiBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000",
}: { apiBase?: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [awaitingConfirm, setAwaitingConfirm] = useState<boolean>(false);
  const sessionIdRef = useRef<string>(generateId());
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const pushMsg = (m: Omit<ChatMessage, "id">) => {
    setMessages((s) => [...s, { id: Date.now().toString() + Math.random().toString(36).slice(2, 6), ...m }]);
  };

  // Very simple heuristic: if it contains obvious Spanish characters or common Spanish words, assume Spanish.
  // Otherwise treat as English. This is fast and avoids an extra API call; you can replace with a library later.
  function isProbablySpanish(text: string) {
    if (!text.trim()) return false;
    const lower = text.toLowerCase();
    const spanishLetters = /[áéíóúñ¿¡]/;
    if (spanishLetters.test(lower)) return true;
    const spanishWords = ["que", "por", "para", "hola", "gracias", "buen", "quiero", "reservar", "mesa", "cómo", "dónde", "mañana"];
    for (const w of spanishWords) if (new RegExp(`\\b${w}\\b`).test(lower)) return true;
    return false;
  }

  // convert base64 to object URL and play
  function playBase64(base64: string, mime = "audio/wav") {
    try {
      const binary = atob(base64);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.play().catch((e) => console.warn("Audio play failed:", e));
      // free the object url after a while
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      console.error("playBase64 error", e);
    }
  }

  // Submit flow when the user presses Enter (or clicks send)
  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    // decide language
    const probablySpanish = isProbablySpanish(trimmed);

    if (probablySpanish) {
      // Spanish: first call /api/transcript to get english meaning (or just skip if you want)
      await submitSpanish(trimmed);
    } else {
      // English: go straight to generating natural Spanish + reply
      await submitEnglishFlow(trimmed);
    }
  }

  // submit Spanish text (from Wispr or manual Spanish typing)
  async function submitSpanish(spanishText: string) {
    setLoading(true);
    setAwaitingConfirm(true);
    pushMsg({ type: "user_spanish", text: spanishText });

    try {
      const res = await fetch(`${apiBase}/api/transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionIdRef.current, spanish_text: spanishText, source: "wispr_desktop" }),
      });
      if (!res.ok) throw new Error(`transcript failed ${res.status}`);
      const data = await res.json();
      const english = data.english_meaning || "";
      // show translation bubble and pre-fill text area for editing/confirmation
      pushMsg({ type: "translation_check", text: `Is this what you meant? — ${english}` });
      setInput(english);
      inputRef.current?.focus();
    } catch (err) {
      console.error("submitSpanish error", err);
      //alert("Translation failed. See console.");
    } finally {
      setLoading(false);
    }
  }

  // submit English flow (user typed/pasted English and wants a natural Spanish + reply)
  async function submitEnglishFlow(englishText: string) {
    setLoading(true);
    // show a little status in the chat
    pushMsg({ type: "status", text: "Generating Spanish and reply…" });

    try {
      // We'll POST to the same /api/confirm endpoint — backend should accept missing original_spanish
      const res = await fetch(`${apiBase}/api/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionIdRef.current, original_spanish: "", confirmed_english: englishText }),
      });
      if (!res.ok) throw new Error(`confirm failed ${res.status}`);
      const data = await res.json();

      // remove status messages (naive filter)
      setMessages((m) => m.filter((x) => x.type !== "status"));

      if (data.correction_explanation) pushMsg({ type: "explanation", text: data.correction_explanation });
      if (data.corrected_spanish) pushMsg({ type: "corrected", text: data.corrected_spanish });
      if (data.reply_english) pushMsg({ type: "reply_english", text: data.reply_english });
      if (data.reply_spanish) pushMsg({ type: "reply", text: data.reply_spanish });

      // play audios
      if (data.audio_corrected_base64) {
        playBase64(data.audio_corrected_base64);
        // approximate wait then play reply
        const approxMs = 900 + (data.corrected_spanish ? data.corrected_spanish.split(" ").length * 120 : 0);
        if (data.audio_reply_base64) setTimeout(() => playBase64(data.audio_reply_base64), approxMs);
      } else if (data.audio_reply_base64) {
        playBase64(data.audio_reply_base64);
      }

      // clear input
      setInput("");
      setAwaitingConfirm(false);
    } catch (err) {
      console.error("submitEnglishFlow error", err);
      //alert("Failed to generate Spanish. See console.");
      setMessages((m) => m.filter((x) => x.type !== "status"));
    } finally {
      setLoading(false);
    }
  }

  // When user confirms/edits the English (the confirm step after translation)
  async function confirmEnglish(confirmedEnglish: string) {
    if (!confirmedEnglish || loading) return;
    setLoading(true);
    pushMsg({ type: "status", text: "Applying corrections…" });

    // get last user_spanish
    const lastSpanish = [...messages].reverse().find((m) => m.type === "user_spanish");
    const originalSpanish = lastSpanish ? lastSpanish.text : "";

    try {
      const res = await fetch(`${apiBase}/api/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionIdRef.current, original_spanish: originalSpanish, confirmed_english: confirmedEnglish }),
      });
      if (!res.ok) throw new Error(`confirm failed ${res.status}`);
      const data = await res.json();

      // remove status messages
      setMessages((m) => m.filter((x) => x.type !== "status"));

      if (data.correction_explanation) pushMsg({ type: "explanation", text: data.correction_explanation });
      if (data.corrected_spanish) pushMsg({ type: "corrected", text: data.corrected_spanish });
      if (data.reply_english) pushMsg({ type: "reply_english", text: data.reply_english });
      if (data.reply_spanish) pushMsg({ type: "reply", text: data.reply_spanish });

      if (data.audio_corrected_base64) {
        playBase64(data.audio_corrected_base64);
        const approxMs = 900 + (data.corrected_spanish ? data.corrected_spanish.split(" ").length * 120 : 0);
        if (data.audio_reply_base64) setTimeout(() => playBase64(data.audio_reply_base64), approxMs);
      } else if (data.audio_reply_base64) {
        playBase64(data.audio_reply_base64);
      }

      setInput("");
      setAwaitingConfirm(false);
    } catch (err) {
      console.error("confirmEnglish error", err);
      //alert("Confirm failed. See console.");
      setMessages((m) => m.filter((x) => x.type !== "status"));
    } finally {
      setLoading(false);
    }
  }

  // decide whether to submit english confirm or a new spanish input
  function handleFormSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    if (awaitingConfirm) {
      confirmEnglish(trimmed);
    } else {
      handleSubmit();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleFormSubmit(e as unknown as FormEvent);
    }
  }

  // paste handler - useful for Wispr desktop pasting Spanish
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = (e.clipboardData || (window as any).clipboardData)?.getData("text");
    if (pasted && pasted.trim()) {
      e.preventDefault();
      setInput(pasted);
      // assume Wispr pasted Spanish — submit as Spanish
      //setTimeout(() => submitSpanish(pasted), 120);
      // focus the input so user can review before pressing Send
        setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.chatWindow}>
        {messages.map((m) => (
          <div key={m.id} style={bubbleStyle(m.type)}>
            <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
          </div>
        ))}
        {loading && <div style={{ color: "#94a3b8", fontSize: 13, padding: 6 }}>Loading...</div>}
      </div>

      <form onSubmit={handleFormSubmit} style={styles.form}>
        <textarea
          ref={inputRef}
          placeholder={awaitingConfirm ? "Edit the English meaning (press Enter to confirm)" : "Type or paste Spanish here (press Enter to send)"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          style={styles.textarea}
          rows={2}
          disabled={loading}
        />
        <button type="submit" style={styles.button} disabled={loading}>
          {awaitingConfirm ? "Confirm English" : "Send"}
        </button>
      </form>
    </div>
  );
}

// Styles
const styles: { [k: string]: React.CSSProperties } = {
  container: { display: "flex", flexDirection: "column", height: "100%", maxHeight: "100vh", width: "100%" },
  chatWindow: { flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8, background: "#0f172a", color: "#e2e8f0" },
  form: { display: "flex", gap: 8, padding: 8, borderTop: "1px solid rgba(255,255,255,0.06)", background: "#020617" },
  textarea: { flex: 1, resize: "none", padding: 10, borderRadius: 8, border: "1px solid rgba(255,255,255,0.06)", background: "#001122", color: "#e6eef8", fontSize: 14 },
  button: { minWidth: 120, padding: "8px 12px", borderRadius: 8, border: "none", background: "#0ea5a4", color: "#041014", fontWeight: 600, cursor: "pointer" },
};

function bubbleStyle(type: MsgType): React.CSSProperties {
  const base: React.CSSProperties = { alignSelf: "flex-start", maxWidth: "85%", padding: "10px 12px", borderRadius: 12, marginBottom: 4 };
  switch (type) {
    case "user_spanish": return { ...base, background: "#6e6e6eff", color: "#dff8f7" };
    case "translation_check": return { ...base, background: "#3d3d3dff", color: "#dbeafe" };
    case "corrected": return { ...base, background: "#11a6ebff", color: "#dfffe6" };
    case "explanation": return { ...base, background: "#30749eff", color: "#f0e9ff" };
    case "reply": return { ...base, background: "#23c75cff", alignSelf: "flex-end", color: "#e6eef8" };
    case "reply_english": return { ...base, background: "#52b775ff", alignSelf: "flex-end", color: "#e6eef8" };
    case "status": return { ...base, background: "transparent", color: "#94a3b8", alignSelf: "center" };
    default: return { ...base, background: "#1f2937", color: "#e6eef8" };
  }
}
