// cards.ts
// Central deck file — edit this to add/remove cards.
// Exported helpers give you a shuffled deck and drawing utilities.

export type Card = {
  id: string;
  type: "image" | "spanish_word" | "english_word" | "phrase" | "grammar" | "constraint";
  value: string;
  display_text?: string;
  image_url?: string | null;
  points?: number;
};

// --- your canonical deck: edit this array to add/modify cards ---
export const CARD_DECK: Card[] = [
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
  // Add your custom cards below...
];

// --- simple helpers ---

export function shuffle<T>(arr: T[]) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Draw `count` cards from deck (returns new array).
 * Does not mutate the input deck.
 */
export function drawCards(deck: Card[], count = 7) {
  return shuffle(deck).slice(0, count);
}

/**
 * Draw one random card from `deck` excluding any `excludeIds`.
 * Returns null if none available.
 */
export function drawOneExcluding(deck: Card[], excludeIds: string[] = []): Card | null {
  const pool = deck.filter((c) => !excludeIds.includes(c.id));
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}
