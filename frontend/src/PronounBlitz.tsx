// PronounBlitz.tsx
// Minigame: watch a transfer animation, say the Spanish pronoun sentence.
// Subject + IO pronoun + DO pronoun + preterite verb — no backend needed.
import React, { useState, useEffect, useRef, useCallback } from "react";

type LangSpec = { code: string; name: string };
type Phase = 'select_difficulty' | 'showing' | 'animating' | 'input' | 'correct' | 'wrong' | 'game_over';
type Difficulty = 'easy' | 'hard';
type CharKey = 'yo' | 'tu' | 'el';
type Pos = { x: number; y: number };

interface ObjectDef { key: string; emoji: string; pronoun: 'lo' | 'la' | 'las'; label: string; }
interface VerbDef { key: string; label: string; animType: 'glide' | 'arc' | 'envelope' | 'sneak'; bubble: string; }
interface Round {
  subject: CharKey; ioChar: CharKey;
  object: ObjectDef; verb: VerbDef;
  ioPronoun: 'me' | 'te' | 'se';
  correctDisplay: string;
  accepted: string[];
}

interface PronounBlitzProps {
  fluent: LangSpec; learning: LangSpec; onBack: () => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ARENA_W = 420;
const ARENA_H = 340;
const ROUNDS_PER_GAME = 10;
const CHAR_SIZE = 64;

const CHARS: Record<CharKey, { label: string; emoji: string; bg: string }> = {
  yo: { label: 'Yo',      emoji: '🧑', bg: '#3b82f6' },
  tu: { label: 'Tú',     emoji: '🧞', bg: '#8b5cf6' },
  el: { label: 'Él/Ella', emoji: '🧸', bg: '#f59e0b' },
};

// Pixel centers of each character in the arena
const CHAR_POS: Record<CharKey, Pos> = {
  yo: { x: ARENA_W * 0.50, y: ARENA_H * 0.85 },
  tu: { x: ARENA_W * 0.50, y: ARENA_H * 0.12 },
  el: { x: ARENA_W * 0.87, y: ARENA_H * 0.50 },
};

// Arc apex for throw animations — "sender-receiver"
const ARC_APEX: Record<string, Pos> = {
  'yo-tu': { x: ARENA_W * 0.22, y: ARENA_H * 0.42 },
  'yo-el': { x: ARENA_W * 0.85, y: ARENA_H * 0.15 },
  'tu-yo': { x: ARENA_W * 0.78, y: ARENA_H * 0.58 },
  'tu-el': { x: ARENA_W * 0.98, y: ARENA_H * 0.10 },
  'el-yo': { x: ARENA_W * 0.15, y: ARENA_H * 0.80 },
  'el-tu': { x: ARENA_W * 0.18, y: ARENA_H * 0.15 },
};

const OBJECTS: ObjectDef[] = [
  { key: 'libro',  emoji: '📖', pronoun: 'lo',  label: 'el libro'   },
  { key: 'pelota', emoji: '⚽', pronoun: 'la',  label: 'la pelota'  },
  { key: 'dinero', emoji: '💰', pronoun: 'lo',  label: 'el dinero'  },
  { key: 'llaves', emoji: '🔑', pronoun: 'las', label: 'las llaves' },
];

const VERBS: VerbDef[] = [
  { key: 'dar',     label: 'dar',     animType: 'glide',    bubble: '🤲' },
  { key: 'tirar',   label: 'tirar',   animType: 'arc',      bubble: '🤾' },
  { key: 'pasar',   label: 'pasar',   animType: 'arc',      bubble: '🙌' },
  { key: 'mandar',  label: 'mandar',  animType: 'envelope', bubble: '✉️' },
  { key: 'mostrar', label: 'mostrar', animType: 'glide',    bubble: '👀' },
  { key: 'prestar', label: 'prestar', animType: 'glide',    bubble: '🤝' },
  { key: 'robar',   label: 'robar',   animType: 'sneak',    bubble: '🤏' },
];

const PRETERITE: Record<CharKey, Record<string, string>> = {
  yo: { dar:'di',    tirar:'tiré',    pasar:'pasé',    mandar:'mandé',    mostrar:'mostré',    prestar:'presté',    robar:'robé'    },
  tu: { dar:'diste', tirar:'tiraste', pasar:'pasaste', mandar:'mandaste', mostrar:'mostraste', prestar:'prestaste', robar:'robaste' },
  el: { dar:'dio',   tirar:'tiró',    pasar:'pasó',    mandar:'mandó',    mostrar:'mostró',    prestar:'prestó',    robar:'robó'    },
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿¡.,!?;:\s]/g, '');
}

function getIOPronoun(subject: CharKey, io: CharKey): 'me' | 'te' | 'se' {
  if (subject === 'yo' && io === 'tu') return 'te';
  if (subject === 'yo' && io === 'el') return 'se';  // le → se before lo/la/las
  if (subject === 'tu' && io === 'yo') return 'me';
  if (subject === 'tu' && io === 'el') return 'se';
  if (subject === 'el' && io === 'yo') return 'me';
  /* el → tu */                        return 'te';
}

function buildAccepted(subject: CharKey, io: string, doPron: string, verbForm: string): string[] {
  const base = normalize(`${io} ${doPron} ${verbForm}`);
  const subjectForms: Record<CharKey, string[]> = {
    yo: ['yo'],
    tu: ['tu', 'usted'],
    el: ['el', 'ella'],
  };
  const result = new Set([base]);
  for (const sp of subjectForms[subject]) {
    result.add(normalize(`${sp} ${io} ${doPron} ${verbForm}`));
  }
  return [...result];
}

function randItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildRound(): Round {
  const chars: CharKey[] = ['yo', 'tu', 'el'];
  const subject = randItem(chars);
  const ioChar  = randItem(chars.filter(c => c !== subject));
  const object  = randItem(OBJECTS);
  const verb    = randItem(VERBS);
  const ioPronoun = getIOPronoun(subject, ioChar);
  const verbForm  = PRETERITE[subject][verb.key];
  return {
    subject, ioChar, object, verb, ioPronoun,
    correctDisplay: `${ioPronoun} ${object.pronoun} ${verbForm}`,
    accepted: buildAccepted(subject, ioPronoun, object.pronoun, verbForm),
  };
}

function getHint(userInput: string, round: Round): string {
  const n = normalize(userInput);
  if (/\ble\s+(lo|la|las)\b/.test(n))
    return 'le + lo/la/las → se. Write "se" here, not "le"!';
  if (round.ioPronoun === 'se' && !n.startsWith('se ') && !/ se /.test(n))
    return 'Tip: when the indirect object is le/les before lo/la/las, use "se".';
  const words = n.split(' ').filter(Boolean);
  if (words.length < 3)
    return `Need 3 parts: [${round.ioPronoun}] [${round.object.pronoun}] [verb preterite]`;
  return 'Check pronoun order: indirect object → direct object → verb (preterite).';
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PronounBlitz({ onBack }: PronounBlitzProps) {
  const [phase,       setPhase]       = useState<Phase>('select_difficulty');
  const [difficulty,  setDifficulty]  = useState<Difficulty>('easy');
  const [rounds,      setRounds]      = useState<Round[]>([]);
  const [roundIndex,  setRoundIndex]  = useState(0);
  const [input,       setInput]       = useState('');
  const [score,       setScore]       = useState(0);
  const [streak,      setStreak]      = useState(0);
  const [bestStreak,  setBestStreak]  = useState(0);
  const [wrongList,   setWrongList]   = useState<string[]>([]);
  const [roundWrong,  setRoundWrong]  = useState(false); // already counted as wrong this round
  const [showAnswer,  setShowAnswer]  = useState(false);

  // Animated object state
  const [objPos,        setObjPos]        = useState<Pos>({ x: 0, y: 0 });
  const [objTransition, setObjTransition] = useState('none');
  const [objVisible,    setObjVisible]    = useState(false);
  const [objEmoji,      setObjEmoji]      = useState('📦');

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const round = rounds[roundIndex] as Round | undefined;

  // ── Animation ──────────────────────────────────────────────────────────────

  const playAnimation = useCallback((r: Round) => {
    const isRobar   = r.verb.key === 'robar';
    const startChar = isRobar ? r.ioChar   : r.subject;
    const endChar   = isRobar ? r.subject  : r.ioChar;
    const startPos  = CHAR_POS[startChar];
    const endPos    = CHAR_POS[endChar];
    const animType  = r.verb.animType;

    setObjEmoji(r.object.emoji);
    setObjTransition('none');
    setObjPos(startPos);
    setObjVisible(true);

    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (animType === 'arc') {
        const apexKey = `${startChar}-${endChar}`;
        const apex = ARC_APEX[apexKey] ?? {
          x: (startPos.x + endPos.x) / 2,
          y: Math.min(startPos.y, endPos.y) - 70,
        };
        const half = 360;
        setObjTransition(`left ${half}ms ease-out, top ${half}ms ease-in`);
        setObjPos(apex);
        setTimeout(() => {
          setObjTransition(`left ${half}ms ease-in, top ${half}ms ease-out`);
          setObjPos(endPos);
        }, half);
      } else if (animType === 'sneak') {
        setObjTransition('left 200ms linear, top 200ms linear');
        setObjPos(endPos);
      } else {
        const dur = animType === 'envelope' ? 700 : 800;
        setObjTransition(`left ${dur}ms ease-in-out, top ${dur}ms ease-in-out`);
        setObjPos(endPos);
      }
    }));
  }, []);

  // ── Phase transitions ──────────────────────────────────────────────────────

  // 'showing' → wait 550ms → 'animating'
  useEffect(() => {
    if (phase !== 'showing' || !round) return;
    setInput('');
    setObjVisible(false);
    const t = setTimeout(() => {
      setPhase('animating');
      playAnimation(round);
    }, 550);
    return () => clearTimeout(t);
  }, [phase, round, playAnimation]);

  // 'animating' → wait for animation → 'input'
  useEffect(() => {
    if (phase !== 'animating') return;
    const dur = round?.verb.animType === 'arc' ? 820 : round?.verb.animType === 'sneak' ? 350 : 950;
    const t = setTimeout(() => {
      setPhase('input');
      setTimeout(() => textareaRef.current?.focus(), 50);
    }, dur);
    return () => clearTimeout(t);
  }, [phase, round]);

  // Auto-send when input length > 2 (Wispr paste detection)
  useEffect(() => {
    if (input.length <= 2) return;
    if (phase !== 'input' && phase !== 'wrong') return;
    const t = setTimeout(() => submitAnswer(), 300);
    return () => clearTimeout(t);
  }, [input]);

  // 'correct' → wait 1.5s → next round or game over
  useEffect(() => {
    if (phase !== 'correct') return;
    const t = setTimeout(() => {
      const next = roundIndex + 1;
      if (next >= ROUNDS_PER_GAME) {
        setPhase('game_over');
      } else {
        setRoundIndex(next);
        setRoundWrong(false);
        setShowAnswer(false);
        setPhase('showing');
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [phase, roundIndex]);

  // ── Actions ────────────────────────────────────────────────────────────────

  function startGame(diff: Difficulty) {
    const newRounds = Array.from({ length: ROUNDS_PER_GAME }, buildRound);
    setRounds(newRounds);
    setRoundIndex(0);
    setScore(0);
    setStreak(0);
    setBestStreak(0);
    setWrongList([]);
    setRoundWrong(false);
    setShowAnswer(false);
    setDifficulty(diff);
    setPhase('showing');
  }

  function submitAnswer() {
    if (!input.trim() || !round || (phase !== 'input' && phase !== 'wrong')) return;
    const isCorrect = round.accepted.includes(normalize(input));

    if (isCorrect) {
      setScore(s => s + 1);
      const ns = streak + 1;
      setStreak(ns);
      setBestStreak(b => Math.max(b, ns));
      setPhase('correct');
    } else {
      if (!roundWrong) {
        setStreak(0);
        setWrongList(w => [...w, round.correctDisplay]);
        setRoundWrong(true);
      }
      setInput('');
      setPhase('wrong');
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }

  function giveUp() {
    if (!round) return;
    if (!showAnswer) {
      // First click: reveal answer
      if (!roundWrong) {
        setStreak(0);
        setWrongList(w => [...w, round.correctDisplay]);
        setRoundWrong(true);
      }
      setShowAnswer(true);
      return;
    }
    // Second click: advance
    setShowAnswer(false);
    const next = roundIndex + 1;
    if (next >= ROUNDS_PER_GAME) {
      setPhase('game_over');
    } else {
      setRoundIndex(next);
      setRoundWrong(false);
      setPhase('showing');
    }
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAnswer(); }
  }

  // ── Render helpers ─────────────────────────────────────────────────────────

  function renderArena() {
    if (!round) return null;
    const isInputPhase = phase === 'input' || phase === 'correct' || phase === 'wrong';
    return (
      <div style={{ position: 'relative', width: ARENA_W, height: ARENA_H, flexShrink: 0,
        background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 100%)',
        borderRadius: 16, overflow: 'hidden', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}>

        {/* Triangle lines */}
        <svg style={{ position: 'absolute', inset: 0, opacity: 0.15 }} width={ARENA_W} height={ARENA_H}>
          {(['yo','tu','el'] as CharKey[]).flatMap((a, i, arr) =>
            arr.slice(i + 1).map(b => (
              <line key={`${a}-${b}`}
                x1={CHAR_POS[a].x} y1={CHAR_POS[a].y}
                x2={CHAR_POS[b].x} y2={CHAR_POS[b].y}
                stroke="white" strokeWidth={1.5} />
            ))
          )}
        </svg>

        {/* Characters */}
        {(['yo', 'tu', 'el'] as CharKey[]).map(key => {
          const ch = CHARS[key];
          const pos = CHAR_POS[key];
          const isSubject = key === round.subject;
          const isIO      = key === round.ioChar;
          const highlight = isSubject
            ? '0 0 0 3px #fbbf24, 0 0 16px #fbbf24'
            : isIO && isInputPhase
            ? '0 0 0 3px #34d399, 0 0 16px #34d399'
            : 'none';
          return (
            <div key={key} style={{
              position: 'absolute',
              left: pos.x, top: pos.y,
              transform: 'translate(-50%, -50%)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
            }}>
              <div style={{
                width: CHAR_SIZE, height: CHAR_SIZE, borderRadius: '50%',
                background: ch.bg, display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: 30,
                boxShadow: highlight,
                transition: 'box-shadow 0.3s',
              }}>
                {ch.emoji}
              </div>
              <div style={{
                fontSize: 11, fontWeight: 700, color: 'white',
                background: 'rgba(0,0,0,0.5)', padding: '2px 6px',
                borderRadius: 4,
              }}>
                {ch.label}
                {isSubject && <span style={{ marginLeft: 4, color: '#fbbf24' }}>⚡</span>}
              </div>
            </div>
          );
        })}

        {/* Animated object */}
        {objVisible && (
          <div style={{
            position: 'absolute',
            left: objPos.x, top: objPos.y,
            transform: 'translate(-50%, -50%)',
            transition: objTransition,
            fontSize: 28,
            filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))',
            zIndex: 10,
            pointerEvents: 'none',
          }}>
            {objEmoji}
          </div>
        )}

        {/* Verb label (easy mode only, shown during showing + animating + input) */}
        {difficulty === 'easy' && round && (phase === 'showing' || phase === 'animating' || phase === 'input' || phase === 'wrong' || phase === 'correct') && (
          <div style={{
            position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.65)', color: '#fbbf24',
            padding: '4px 14px', borderRadius: 20, fontSize: 14, fontWeight: 700,
            letterSpacing: 1,
          }}>
            {round.verb.bubble} {round.verb.label}
          </div>
        )}

        {/* Object label hint */}
        {round && (phase === 'showing' || phase === 'animating') && (
          <div style={{
            position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.55)', color: '#e0e7ff',
            padding: '3px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
          }}>
            {round.object.emoji} {round.object.label}
          </div>
        )}

        {/* Phase overlays */}
        {phase === 'correct' && (
          <div style={{
            position: 'absolute', inset: 0, background: 'rgba(16,185,129,0.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 72, borderRadius: 16,
          }}>✅</div>
        )}
      </div>
    );
  }

  function renderResult() {
    if (!round) return null;
    const lastInput = phase === 'wrong' ? input : '';
    if (phase === 'correct') {
      return (
        <div style={{ textAlign: 'center', color: '#10b981', fontWeight: 700, fontSize: 18, marginTop: 8 }}>
          ✅ <span style={{ color: '#1f2937' }}>{round.correctDisplay}</span>
        </div>
      );
    }
    if (phase === 'wrong') {
      return (
        <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 10,
          padding: '12px 16px', marginTop: 8 }}>
          <div style={{ color: '#dc2626', fontWeight: 700, marginBottom: 4 }}>❌ Not quite</div>
          <div style={{ fontSize: 14, color: '#374151' }}>
            {getHint(lastInput, round)}
          </div>
        </div>
      );
    }
    return null;
  }

  // ── Screens ────────────────────────────────────────────────────────────────

  if (phase === 'select_difficulty') {
    return (
      <div style={containerStyle}>
        <BackButton onBack={onBack} />
        <div style={{ ...cardStyle, maxWidth: 480, textAlign: 'center' }}>
          <div style={{ fontSize: 52, marginBottom: 8 }}>⚡</div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: '#1f2937', marginBottom: 8 }}>Pronoun Blitz</h1>
          <p style={{ color: '#6b7280', marginBottom: 32, fontSize: 15 }}>
            Watch the transfer, say the Spanish sentence.<br />
            Practice <strong>indirect + direct object pronouns</strong> in preterite.
          </p>
          <div style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
            <ModeButton
              title="Easy"
              desc="Verb shown on screen"
              color="#3b82f6"
              onClick={() => startGame('easy')}
            />
            <ModeButton
              title="Hard"
              desc="Infer verb from animation"
              color="#dc2626"
              onClick={() => startGame('hard')}
            />
          </div>
          <div style={{ marginTop: 28, fontSize: 13, color: '#9ca3af', lineHeight: 1.6 }}>
            <strong>Structure:</strong> IO pronoun + DO pronoun + verb<br />
            <em>e.g. "Te lo di" · "Me la tiró" · "Se lo mandaste"</em>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'game_over') {
    const pct = Math.round((score / ROUNDS_PER_GAME) * 100);
    return (
      <div style={containerStyle}>
        <BackButton onBack={onBack} />
        <div style={{ ...cardStyle, maxWidth: 520 }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div style={{ fontSize: 52 }}>{pct >= 80 ? '🏆' : pct >= 50 ? '💪' : '📚'}</div>
            <h2 style={{ fontSize: 26, fontWeight: 800, color: '#1f2937', margin: '8px 0' }}>
              {score}/{ROUNDS_PER_GAME} correct
            </h2>
            <div style={{ color: '#6b7280', fontSize: 15 }}>
              Best streak: 🔥 {bestStreak}
            </div>
          </div>

          {wrongList.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 8 }}>
                Sentences to review:
              </div>
              {wrongList.map((s, i) => (
                <div key={i} style={{
                  background: '#fef2f2', border: '1px solid #fecaca',
                  borderRadius: 8, padding: '8px 12px', marginBottom: 6,
                  fontSize: 16, fontWeight: 600, color: '#dc2626',
                }}>
                  {s}
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button onClick={() => startGame(difficulty)} style={primaryBtnStyle('#3b82f6')}>
              Play Again ({difficulty})
            </button>
            <button onClick={() => setPhase('select_difficulty')} style={primaryBtnStyle('#6b7280')}>
              Change Difficulty
            </button>
            <button onClick={onBack} style={primaryBtnStyle('#9ca3af')}>
              Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Main game screen
  return (
    <div style={containerStyle}>
      <div style={{ width: '100%', maxWidth: 540, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} style={{
            background: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: 8,
            color: 'white', cursor: 'pointer', padding: '6px 12px', fontSize: 14,
          }}>← Back</button>
          <span style={{ color: 'white', fontWeight: 700, fontSize: 16 }}>Pronoun Blitz</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, color: 'white', fontSize: 14 }}>
            <span>Round {Math.min(roundIndex + 1, ROUNDS_PER_GAME)}/{ROUNDS_PER_GAME}</span>
            <span>✅ {score}</span>
            <span>🔥 {streak}</span>
          </div>
        </div>

        {/* Difficulty badge */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{
            background: difficulty === 'easy' ? '#3b82f6' : '#dc2626',
            color: 'white', fontSize: 11, fontWeight: 700, padding: '2px 10px',
            borderRadius: 20, letterSpacing: 1, textTransform: 'uppercase',
          }}>{difficulty}</span>
          {difficulty === 'hard' && (
            <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>
              Infer the verb from the animation
            </span>
          )}
        </div>

        {/* Arena */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          {renderArena()}
        </div>

        {/* Input area */}
        {(phase === 'input' || phase === 'wrong') && (
          <div style={{ background: 'white', borderRadius: 12, padding: 16,
            boxShadow: '0 4px 16px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 8 }}>
              Say the Spanish sentence (IO pronoun + DO pronoun + verb):
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKey}
                rows={1}
                placeholder="te lo di…"
                style={{
                  flex: 1, padding: '10px 12px', fontSize: 16,
                  border: '2px solid #e5e7eb', borderRadius: 8, resize: 'none',
                  outline: 'none', fontFamily: 'inherit',
                }}
              />
              <button onClick={submitAnswer} style={primaryBtnStyle('#3b82f6', '10px 16px')}>
                ✓
              </button>
            </div>
            {renderResult()}
            {phase === 'wrong' && (
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <button onClick={giveUp} style={{
                  background: 'none', border: '1px solid #d1d5db',
                  color: '#6b7280', borderRadius: 8, padding: '6px 14px',
                  cursor: 'pointer', fontSize: 13,
                }}>
                  {showAnswer ? 'Next →' : 'Give Up'}
                </button>
                {showAnswer && round && (
                  <span style={{ fontSize: 16, fontWeight: 700, color: '#1f2937' }}>
                    {round.correctDisplay}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Correct result (shown below arena while arena shows ✅) */}
        {phase === 'correct' && round && (
          <div style={{ background: 'white', borderRadius: 12, padding: 16,
            boxShadow: '0 4px 16px rgba(0,0,0,0.2)', textAlign: 'center' }}>
            <div style={{ color: '#10b981', fontWeight: 700, fontSize: 18 }}>
              ✅ <span style={{ color: '#1f2937' }}>{round.correctDisplay}</span>
            </div>
          </div>
        )}

        {/* Waiting states */}
        {(phase === 'showing' || phase === 'animating') && (
          <div style={{ background: 'rgba(255,255,255,0.15)', borderRadius: 12, padding: 14,
            textAlign: 'center', color: 'white', fontSize: 14 }}>
            {phase === 'showing' ? 'Watch the action…' : 'What happened?'}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Small shared components ──────────────────────────────────────────────────

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button onClick={onBack} style={{
      position: 'absolute', top: 16, left: 16,
      background: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: 8,
      color: 'white', cursor: 'pointer', padding: '8px 14px', fontSize: 14, fontWeight: 600,
    }}>← Back</button>
  );
}

function ModeButton({ title, desc, color, onClick }: {
  title: string; desc: string; color: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick} style={{
      padding: '20px 28px', background: color, border: 'none', borderRadius: 12,
      color: 'white', cursor: 'pointer', minWidth: 150,
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      transition: 'transform 0.15s, box-shadow 0.15s',
    }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = '0 8px 20px rgba(0,0,0,0.25)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)'; }}
    >
      <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12, opacity: 0.85 }}>{desc}</div>
    </button>
  );
}

function primaryBtnStyle(color: string, padding = '10px 20px'): React.CSSProperties {
  return {
    background: color, color: 'white', border: 'none', borderRadius: 8,
    padding, fontSize: 15, fontWeight: 700, cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
  };
}

const containerStyle: React.CSSProperties = {
  minHeight: '100vh',
  background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 100%)',
  display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center',
  padding: '20px', position: 'relative',
  fontFamily: 'system-ui, -apple-system, sans-serif',
};

const cardStyle: React.CSSProperties = {
  background: 'white', borderRadius: 16, padding: '36px 32px',
  boxShadow: '0 20px 60px rgba(0,0,0,0.3)', width: '100%',
};
