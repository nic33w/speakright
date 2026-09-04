// RepeatBack.tsx
// Say the Spanish back and have it checked (TASKS.md 8.14).
//
// Scoring is word coverage accumulated across attempts, not string similarity —
// see coverage.ts for why. Miss a word, say just that word, and it passes.
//
// Input is Wispr, driven by the controller: clicking a stick becomes an F13
// keypress via tools/controller/f13_mapper.py, Wispr has F13 as its hotkey, and
// its transcript lands in the focused textarea as a paste. `useWisprAutoSend`
// recognises that paste and submits it after a short cancelable window — the same
// machinery every other mode uses, so the timing is consistent across the app.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AutoSendBar } from "../sharedGameComponents";
import { useWisprAutoSend } from "../sharedGameHooks";
import { addAttempt, emptyCoverage, markUp, type Coverage } from "./coverage";

// Long enough to register that it went green, short enough not to feel like a
// stall. A pass advances by itself from here.
const PASS_HOLD_MS = 1500;

type Props = {
  target: string;
  langCode: string;
  /** Called once the whole sentence has been covered, after the green hold. */
  onPass: () => void;
  /** Play the sentence again — the learner usually wants to hear it before trying. */
  onHear?: () => void;
};

export default function RepeatBack({ target, langCode, onPass, onHear }: Props) {
  const [value, setValue] = useState("");
  const [coverage, setCoverage] = useState<Coverage>(() => emptyCoverage(target, langCode));
  const [attempts, setAttempts] = useState(0);
  const [recording, setRecording] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const passedRef = useRef(false);

  // A new sentence is a new drill.
  useEffect(() => {
    setCoverage(emptyCoverage(target, langCode));
    setValue("");
    setAttempts(0);
    passedRef.current = false;
  }, [target, langCode]);

  const submit = useCallback((text: string) => {
    const spoken = text.trim();
    if (!spoken) return;
    setAttempts((n) => n + 1);
    setValue("");
    setCoverage((prev) => {
      const next = addAttempt(prev, spoken, langCode);
      if (next.complete && !passedRef.current) {
        passedRef.current = true;
        // Green first, then move on — long enough to see that it landed.
        window.setTimeout(onPass, PASS_HOLD_MS);
      }
      return next;
    });
  }, [langCode, onPass]);

  const autoSend = useWisprAutoSend({ value, onSubmit: submit, disabled: coverage.complete });

  // Keep the box focused: Wispr pastes into whatever has focus, so losing it
  // silently sends the transcript nowhere.
  useEffect(() => {
    if (!coverage.complete) textareaRef.current?.focus();
  }, [coverage.complete, attempts]);

  // F13 from the controller mapper. MODIFIERS ARE DELIBERATELY IGNORED — real
  // mappers send F13 with modifiers attached (the working local setup sends
  // Ctrl+F13) and `e.key` is "F13" either way. Adding modifier guards here breaks
  // controller recording, and the failure looks like a dead button.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "F13" || e.repeat) return;
      e.preventDefault();
      setRecording((r) => !r);
      textareaRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const marked = useMemo(() => markUp(target, coverage, langCode), [target, coverage, langCode]);
  const done = coverage.complete;

  return (
    <div style={{
      marginTop: 10,
      border: `1px solid ${done ? "rgba(16,185,129,0.55)" : "rgba(255,255,255,0.16)"}`,
      background: done ? "rgba(16,185,129,0.09)" : "rgba(0,0,0,0.18)",
      borderRadius: 10,
      padding: "10px 12px",
      transition: "border-color 0.25s, background 0.25s",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase", color: done ? "#6ee7b7" : "#64748b" }}>
          {done ? "✓ got every word" : "Say it back"}
        </span>
        {recording && !done && (
          <span style={{ fontSize: 11, color: "#fca5a5" }}>● recording</span>
        )}
        {attempts > 0 && !done && (
          <span style={{ fontSize: 11, color: "#64748b" }}>
            {coverage.missing.length} word{coverage.missing.length === 1 ? "" : "s"} to go
          </span>
        )}
        <span style={{ flex: 1 }} />
        {onHear && (
          <button
            onMouseEnter={onHear}
            onClick={onHear}
            style={{
              padding: "3px 9px", fontSize: 11, borderRadius: 6, cursor: "pointer",
              border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.06)", color: "#e2e8f0",
            }}
          >
            ▶ hear it
          </button>
        )}
      </div>

      {/* The target, with what you have already said dimmed out. Nothing is
          hidden — the point is to say it, not to recall it. */}
      <div style={{ fontSize: 15, lineHeight: 1.5, marginBottom: 8 }}>
        {marked.map((token, i) => (
          <span
            key={i}
            style={{
              color: token.space ? "inherit" : token.covered ? "#475569" : "#7dd3fc",
              textDecoration: token.covered ? "line-through" : "none",
              transition: "color 0.2s",
            }}
          >
            {token.text}
          </span>
        ))}
      </div>

      {!done && (
        <>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              // Enter submits; the viewer's own arrow-key navigation must not fire
              // while the drill has focus.
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(value);
              } else if (e.key === "Escape") {
                autoSend.cancel();
                setValue("");
              }
            }}
            rows={2}
            placeholder="Click a stick to record, or type it"
            style={{
              width: "100%", padding: "8px 10px", fontSize: 14, borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.2)", background: "rgba(0,0,0,0.3)",
              color: "#e2e8f0", boxSizing: "border-box", fontFamily: "inherit", resize: "vertical",
            }}
          />
          {autoSend.pending && <AutoSendBar progress={autoSend.progress} />}
        </>
      )}
    </div>
  );
}
