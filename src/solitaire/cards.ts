/**
 * Cards, decks and a seeded shuffle. Shared by every card game here.
 *
 * A card is a plain object with a stable `id` (0..51) that never changes for
 * the life of a game. The page keys its DOM off that id, which is what lets
 * CSS slide a card from one pile to another instead of jump cutting: React
 * sees the same card in a new place, not a new card.
 */

/** 0 spades, 1 hearts, 2 diamonds, 3 clubs. Hearts and diamonds are red. */
export type Suit = 0 | 1 | 2 | 3;

export interface Card {
  id: number;
  suit: Suit;
  /** 1 (ace) to 13 (king). */
  rank: number;
  up: boolean;
}

export const SUITS: Suit[] = [0, 1, 2, 3];
export const SUIT_GLYPH = ["♠", "♥", "♦", "♣"] as const;
export const SUIT_NAME = ["spades", "hearts", "diamonds", "clubs"] as const;
export const RANK_LABEL = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;

export const isRed = (s: Suit): boolean => s === 1 || s === 2;

export const cardName = (c: Pick<Card, "rank" | "suit">): string =>
  `${RANK_LABEL[c.rank]}${SUIT_GLYPH[c.suit]}`;

/** mulberry32: small, fast, and the same deal for the same seed everywhere. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh 52 card deck, face down, ids in suit then rank order. */
export function freshDeck(): Card[] {
  const out: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank++) out.push({ id: suit * 13 + rank - 1, suit, rank, up: false });
  }
  return out;
}

/** Fisher-Yates with a seeded generator. Does not touch its input. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const r = rng(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const randomSeed = (): number => Math.floor(Math.random() * 2 ** 31);
