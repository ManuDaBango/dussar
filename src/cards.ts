// ---------------------------------------------------------------------------
// cards.ts: the basic building blocks: suits, ranks, cards, the deck.
// Nothing in here knows anything about Dussar's rules. It is just "a pack of cards".
// ---------------------------------------------------------------------------

/** S = spades, H = hearts, D = diamonds, C = clubs */
export type Suit = 'S' | 'H' | 'D' | 'C';

/** Ranks are numbers so we can compare them: 2..10, then J=11, Q=12, K=13, A=14. */
export interface Card {
  suit: Suit;
  rank: number;
}

export const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'];

const RANK_TO_LABEL: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

/** Card -> short text such as "AS" (ace of spades) or "10H" (ten of hearts). */
export function cardToString(card: Card): string {
  return RANK_TO_LABEL[card.rank] + card.suit;
}

/** Short text -> Card. The reverse of cardToString. Handy for tests and for saved games. */
export function parseCard(text: string): Card {
  const suit = text.slice(-1) as Suit;
  const label = text.slice(0, -1);
  const rank = Object.entries(RANK_TO_LABEL).find(([, l]) => l === label)?.[0];
  if (!SUITS.includes(suit) || rank === undefined) {
    throw new Error(`Cannot understand card "${text}"`);
  }
  return { suit, rank: Number(rank) };
}

/** Several cards at once: parseCards("AS KS 10H") */
export function parseCards(text: string): Card[] {
  return text.trim() === '' ? [] : text.trim().split(/\s+/).map(parseCard);
}

export function sameCard(a: Card, b: Card): boolean {
  return a.suit === b.suit && a.rank === b.rank;
}

/** A fresh, ordered 52-card pack. */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank++) deck.push({ suit, rank });
  }
  return deck;
}

/**
 * Shuffle with the Fisher-Yates method. `rng` is any function that returns a number
 * between 0 and 1. In real games we pass Math.random; in tests we pass a predictable
 * generator so a "random" game can be replayed exactly.
 */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = a;
  }
  return copy;
}

/** A small predictable random number generator (mulberry32), for tests and replays. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
