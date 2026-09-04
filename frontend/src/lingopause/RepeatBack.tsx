// RepeatBack.tsx
// Say the Spanish back and have it checked (TASKS.md 8.14).
//
// Deliberately small: one input sitting beside the Show-Spanish button, not a
// panel of its own. The drill is a thing you do to the sentence, not a second
// screen about it.
//
// Scoring is word coverage accumulated across attempts, not string similarity —
// see coverage.ts for why. Miss a word, say just that word, and it passes.
//
// Input is Wispr, driven by the controller: clicking a stick becomes an F13
// keypress via tools/controller/f13_mapper.py, Wispr has F13 as its hotkey, and
// its transcript lands in the focused input as a paste. `useWisprAutoSend`
// recognises that paste and submits it after a short cancelable window — the same
// machinery every other mode uses, so the timing is consistent across the app.
import { useCallback, useEffect, useRef, useState } from "react";
import { useWisprAutoSend } from "../sharedGameHooks";
import { playUiSound } from "../audio/uiSounds";
import { addAttempt, emptyCoverage, type Coverage } from "./coverage";

// Long enough to hear the bell and see it go green before moving on.
const PASS_HOLD_MS = 1500;

type Props = {
  target: string;
  langCode: string;
  /** True once this sentence's audio has finished — the cue to take focus. */
  ready: boolean;
  /** Called after the green hold, once every word has been covered. */
  onPass: () => void;
};

export default function RepeatBack({ target, langCode, ready, onPass }: Props) {
  const [value, setValue] = useState("");
  const [coverage, setCoverage] = useState<Coverage>(() => emptyCoverage(target, langCode));
  const [attempts, setAttempts] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
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
        playUiSound("ring");
        window.setTimeout(onPass, PASS_HOLD_MS);
      }
      return next;
    });
  }, [langCode, onPass]);

  const autoSend = useWisprAutoSend({ value, onSubmit: submit, disabled: coverage.complete });

  // Take focus when the sentence has just been spoken — that is the moment you are
  // meant to answer, and Wispr pastes into whatever has focus, so an unfocused box
  // silently swallows the transcript.
  useEffect(() => {
    if (ready && !coverage.complete) inputRef.current?.focus();
  }, [ready, coverage.complete, attempts]);

  const done = coverage.complete;
  const started = attempts > 0;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // The viewer's arrow-key navigation must not fire while you are typing
          // Spanish into this box.
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            submit(value);
          } else if (e.key === "Escape") {
            autoSend.cancel();
            setValue("");
            inputRef.current?.blur();
          }
        }}
        disabled={done}
        placeholder={done ? "" : "say it back"}
        style={{
          width: 150, padding: "4px 8px", fontSize: 12, borderRadius: 6,
          border: `1px solid ${done ? "rgba(16,185,129,0.6)" : autoSend.pending ? "rgba(239,68,68,0.6)" : "rgba(255,255,255,0.2)"}`,
          background: done ? "rgba(16,185,129,0.12)" : "rgba(0,0,0,0.3)",
          color: "#e2e8f0", fontFamily: "inherit",
          transition: "border-color 0.2s, background 0.2s",
        }}
      />
      {done ? (
        <span style={{ fontSize: 11, color: "#6ee7b7", whiteSpace: "nowrap" }}>✓ all words</span>
      ) : started ? (
        <span style={{ fontSize: 11, color: "#94a3b8", whiteSpace: "nowrap" }}>
          {coverage.missing.length} to go
        </span>
      ) : null}
    </span>
  );
}
