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
import { playUiSound, preloadUiSound } from "../audio/uiSounds";
import { addAttempt, emptyCoverage, words, type Coverage } from "./coverage";

// Long enough to hear the bell land and see the box go green before moving on.
const PASS_HOLD_MS = 1900;

// The app-wide auto-send window is 3s, which is right when a wrong send costs a
// turn. Here it costs nothing — coverage only ever accumulates, so an early submit
// can be followed by another attempt. Waiting 3s to be told you were right is the
// worst part of the interaction, so this is deliberately short.
const SEND_WINDOW_MS = 700;
// And when what was just pasted already finishes the sentence, there is nothing
// left to wait for at all.
const SEND_WINDOW_COMPLETE_MS = 120;

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

  const autoSend = useWisprAutoSend({
    value,
    onSubmit: submit,
    disabled: coverage.complete,
    windowMs: (val) => {
      const said = new Set(words(val, langCode));
      const finishes = coverage.targets.every((t) => coverage.covered.has(t) || said.has(t));
      return finishes ? SEND_WINDOW_COMPLETE_MS : SEND_WINDOW_MS;
    },
  });

  // The bell is a 170KB file; fetching it on first play is why it used to sound
  // after the screen had already moved on.
  useEffect(() => { preloadUiSound("ring"); }, []);

  // Take focus when the sentence has just been spoken — that is the moment you are
  // meant to answer, and Wispr pastes into whatever has focus, so an unfocused box
  // silently swallows the transcript.
  useEffect(() => {
    if (ready && !coverage.complete) inputRef.current?.focus();
  }, [ready, coverage.complete, attempts]);

  const done = coverage.complete;
  const started = attempts > 0;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: "1 1 60px", minWidth: 0 }}>
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
          // Flexes to whatever the row has left rather than claiming a fixed
          // width, so it never pushes itself onto a second line. The status beside
          // it keeps a fixed slot so the tick appearing cannot change the layout.
          flex: "1 1 60px", minWidth: 0, width: "100%",
          padding: "3px 7px", fontSize: 11, borderRadius: 6,
          border: `1px solid ${done ? "rgba(16,185,129,0.6)" : autoSend.pending ? "rgba(239,68,68,0.6)" : "rgba(255,255,255,0.2)"}`,
          background: done ? "rgba(16,185,129,0.12)" : "rgba(0,0,0,0.3)",
          color: "#e2e8f0", fontFamily: "inherit",
          transition: "border-color 0.2s, background 0.2s",
        }}
      />
      {/* Fixed width, always present: the row must not get wider when the tick
          appears, or the input wraps under the buttons at the moment of success. */}
      <span style={{
        width: 34, flexShrink: 0, fontSize: 10, whiteSpace: "nowrap",
        color: done ? "#6ee7b7" : "#94a3b8",
      }}>
        {done ? "✓" : started ? `${coverage.missing.length} to go` : ""}
      </span>
    </span>
  );
}
