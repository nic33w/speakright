// coverage.ts
// Lenient scoring for the repeat-back drill (TASKS.md 8.14).
//
// The question is "did you say every word of this sentence", NOT "does your
// transcript match the sentence". That distinction is the whole design:
//
//   Wispr emits cleaned-up, fluent text. Matching the whole string therefore
//   measures Wispr's tidying at least as much as the learner's speech — the same
//   trap TASKS.md 6.1 documents for pronunciation. Word coverage survives Wispr
//   rewording the sentence around the words that matter.
//
// Three rules, all settled deliberately:
//
//   ORDER IS IGNORED. Coverage accumulates across attempts, so missing one word
//   and then saying just that word passes — which is exactly the recovery the
//   learner asked for. Requiring order would break it.
//
//   ONE OCCURRENCE COVERS ALL. The target is a SET of distinct words: "ahí se va a
//   caer la estrella" has one "a" to cover, not two. Wispr's cleanup makes
//   duplicate short words unreliable, so counting them produces failures nobody
//   can act on.
//
//   FUNCTION WORDS ARE NOT STRIPPED. "se", "ya", "lo" are precisely what the
//   constructions turn on — dropping them as stopwords would score out the thing
//   being taught.
//
// Local to LingoPause for now. It is the same family as `checkFuzzyMatch` in
// sharedGameUtils and would move there if a second mode ever wants it.
import { normalizeForMatch } from "../sharedGameUtils";

/** Split into comparable words.
 *
 *  `normalizeForMatch` strips ALL whitespace — it is built for whole-string
 *  comparison — so it is applied per word rather than to the sentence. It also
 *  handles the accent- and punctuation-insensitivity that is the app-wide rule.
 */
export function words(text: string, langCode: string): string[] {
  return (text || "")
    .split(/\s+/)
    .map((w) => normalizeForMatch(w, langCode))
    .filter(Boolean);
}

export type Coverage = {
  /** Distinct target words, in the order they appear. */
  targets: string[];
  /** Which of them have been said, across every attempt so far. */
  covered: Set<string>;
  missing: string[];
  complete: boolean;
};

export function emptyCoverage(target: string, langCode: string): Coverage {
  const targets = Array.from(new Set(words(target, langCode)));
  return {
    targets,
    covered: new Set(),
    missing: targets,
    // A target with no words cannot be "completed" by saying nothing — guarding
    // this keeps an empty sentence from auto-passing the drill.
    complete: false,
  };
}

/** Fold one spoken attempt into the coverage so far. */
export function addAttempt(prev: Coverage, spoken: string, langCode: string): Coverage {
  const said = new Set(words(spoken, langCode));
  const covered = new Set(prev.covered);
  for (const target of prev.targets) {
    if (said.has(target)) covered.add(target);
  }
  const missing = prev.targets.filter((t) => !covered.has(t));
  return {
    targets: prev.targets,
    covered,
    missing,
    complete: prev.targets.length > 0 && missing.length === 0,
  };
}

/** Per-word state for rendering the target with covered words marked. */
export function markUp(target: string, coverage: Coverage, langCode: string) {
  return (target || "").split(/(\s+)/).map((token) => {
    if (/^\s*$/.test(token)) return { text: token, space: true, covered: false };
    const norm = normalizeForMatch(token, langCode);
    return { text: token, space: false, covered: !!norm && coverage.covered.has(norm) };
  });
}
