/**
 * Klondike, the solitaire everybody means when they say solitaire.
 *
 * Pure: no DOM, no clock. `src/test/solitaire.test.ts` plays it in node.
 *
 * Piles: `stock`, `waste`, `f0`..`f3` (foundations, built up by suit from the
 * ace), `t0`..`t6` (tableau, built down in alternating colours, kings only on
 * an empty column). Draw 1 or draw 3 from the stock; the waste turns back over
 * when the stock runs out, as many times as you like.
 *
 * Scoring follows the familiar shape: 10 for a card to a foundation, 5 for a
 * waste card to the tableau, 5 for turning a tableau card, minus 15 for taking
 * a card back off a foundation, minus 20 for turning the waste over in draw 1.
 * Never below zero.
 */
import { freshDeck, shuffled, type Card } from "./cards";
import { isRed } from "./cards";
import { top, withPiles, type BaseState, type Hint, type Rules } from "./rules";

export interface KlondikeState extends BaseState {
  draw: 1 | 3;
  recycles: number;
}

export const FOUNDATIONS = ["f0", "f1", "f2", "f3"] as const;
export const TABLEAU = ["t0", "t1", "t2", "t3", "t4", "t5", "t6"] as const;
const KEYS = ["stock", "waste", ...FOUNDATIONS, ...TABLEAU];

const isFoundation = (k: string) => k[0] === "f";
const isTableau = (k: string) => k[0] === "t";

export function dealKlondike(seed: number, draw: 1 | 3 = 1): KlondikeState {
  const deck = shuffled(freshDeck(), seed);
  const piles: Record<string, Card[]> = { stock: [], waste: [] };
  for (const f of FOUNDATIONS) piles[f] = [];
  let n = 0;
  TABLEAU.forEach((t, i) => {
    const col: Card[] = [];
    for (let j = 0; j <= i; j++) col.push({ ...deck[n++], up: j === i });
    piles[t] = col;
  });
  piles.stock = deck.slice(n).map((c) => ({ ...c, up: false }));
  return { piles, moves: 0, score: 0, seed, draw, recycles: 0 };
}

/** May this one card be laid on pile `to`? */
export function accepts(s: KlondikeState, to: string, card: Card, count = 1): boolean {
  const pile = s.piles[to];
  if (!pile) return false;
  const t = top(pile);
  if (isFoundation(to)) {
    if (count !== 1) return false;
    if (!t) return card.rank === 1;
    return t.suit === card.suit && card.rank === t.rank + 1;
  }
  if (isTableau(to)) {
    if (!t) return card.rank === 13;
    return t.up && isRed(t.suit) !== isRed(card.suit) && card.rank === t.rank - 1;
  }
  return false;
}

function canPickUp(s: KlondikeState, pile: string, index: number): boolean {
  const p = s.piles[pile];
  if (!p || index < 0 || index >= p.length) return false;
  if (pile === "stock") return false;
  if (pile === "waste" || isFoundation(pile)) return index === p.length - 1;
  // Tableau: a face-up run in sequence.
  for (let i = index; i < p.length; i++) {
    if (!p[i].up) return false;
    if (i > index) {
      const a = p[i - 1], b = p[i];
      if (b.rank !== a.rank - 1 || isRed(a.suit) === isRed(b.suit)) return false;
    }
  }
  return true;
}

function clampScore(n: number) {
  return Math.max(0, n);
}

function tryMove(s: KlondikeState, from: string, index: number, to: string): KlondikeState | null {
  if (from === to || !canPickUp(s, from, index)) return null;
  const src = s.piles[from];
  const run = src.slice(index);
  if (!accepts(s, to, run[0], run.length)) return null;
  const rest = src.slice(0, index);
  let score = s.score;
  if (isFoundation(to)) score += 10;
  if (from === "waste" && isTableau(to)) score += 5;
  if (isFoundation(from) && isTableau(to)) score -= 15;
  const t = top(rest);
  if (isTableau(from) && t && !t.up) {
    rest[rest.length - 1] = { ...t, up: true };
    score += 5;
  }
  return {
    ...withPiles(s, { [from]: rest, [to]: s.piles[to].concat(run) }),
    moves: s.moves + 1,
    score: clampScore(score),
  };
}

/** Draw from the stock, or turn the waste back over when the stock is empty. */
export function drawStock(s: KlondikeState): KlondikeState | null {
  const { stock, waste } = s.piles;
  if (stock.length === 0) {
    if (waste.length === 0) return null;
    return {
      ...withPiles(s, { stock: waste.slice().reverse().map((c) => ({ ...c, up: false })), waste: [] }),
      moves: s.moves + 1,
      recycles: s.recycles + 1,
      score: clampScore(s.score - (s.draw === 1 ? 20 : 0)),
    };
  }
  const n = Math.min(s.draw, stock.length);
  const taken = stock.slice(stock.length - n).reverse().map((c) => ({ ...c, up: true }));
  return {
    ...withPiles(s, { stock: stock.slice(0, stock.length - n), waste: waste.concat(taken) }),
    moves: s.moves + 1,
  };
}

function smartTarget(s: KlondikeState, from: string, index: number): string | null {
  if (!canPickUp(s, from, index)) return null;
  const src = s.piles[from];
  const card = src[index];
  const single = index === src.length - 1;
  if (single && !isFoundation(from)) {
    for (const f of FOUNDATIONS) if (accepts(s, f, card)) return f;
  }
  // Tableau, starting from the column to the right so repeated taps cycle.
  const start = isTableau(from) ? Number(from.slice(1)) + 1 : 0;
  let empty: string | null = null;
  for (let k = 0; k < TABLEAU.length; k++) {
    const t = TABLEAU[(start + k) % TABLEAU.length];
    if (t === from || !accepts(s, t, card, src.length - index)) continue;
    if (s.piles[t].length === 0) {
      // A king already at the bottom of a column gains nothing by moving.
      if (!(isTableau(from) && index === 0) && !empty) empty = t;
      continue;
    }
    return t;
  }
  return empty;
}

function hint(s: KlondikeState): Hint | "draw" | null {
  const sources: { from: string; index: number }[] = [];
  const w = s.piles.waste;
  if (w.length) sources.push({ from: "waste", index: w.length - 1 });
  for (const t of TABLEAU) if (s.piles[t].length) sources.push({ from: t, index: s.piles[t].length - 1 });
  // 1. Anything that goes up.
  for (const src of sources) {
    const c = s.piles[src.from][src.index];
    for (const f of FOUNDATIONS) if (accepts(s, f, c)) return { ...src, to: f };
  }
  // 2. A whole face-up run that turns a card or clears a column for a king.
  for (const t of TABLEAU) {
    const p = s.piles[t];
    const first = p.findIndex((c) => c.up);
    if (first < 0) continue;
    if (first === 0 && p[0].rank === 13) continue;
    for (const to of TABLEAU) {
      if (to === t || !accepts(s, to, p[first], p.length - first)) continue;
      if (s.piles[to].length === 0 && first === 0) continue;
      return { from: t, index: first, to };
    }
  }
  // 3. The waste card onto the tableau.
  if (w.length) {
    const c = top(w)!;
    for (const to of TABLEAU) if (accepts(s, to, c)) return { from: "waste", index: w.length - 1, to };
  }
  if (s.piles.stock.length || w.length) return "draw";
  return null;
}

function allTableauUp(s: KlondikeState): boolean {
  return TABLEAU.every((t) => s.piles[t].every((c) => c.up));
}

export function isWonK(s: KlondikeState): boolean {
  return FOUNDATIONS.reduce((n, f) => n + s.piles[f].length, 0) === 52;
}

function canAutoFinish(s: KlondikeState): boolean {
  if (isWonK(s) || !allTableauUp(s)) return false;
  // In draw 3 a card can stay buried forever, so only finish once it is all out.
  if (s.draw === 3) return s.piles.stock.length === 0 && s.piles.waste.length <= 1;
  return true;
}

function autoStep(s: KlondikeState): KlondikeState | null {
  if (isWonK(s)) return null;
  let best: { from: string; index: number; to: string; rank: number } | null = null;
  const consider = (from: string) => {
    const p = s.piles[from];
    const c = top(p);
    if (!c) return;
    for (const f of FOUNDATIONS) {
      if (accepts(s, f, c) && (!best || c.rank < best.rank)) best = { from, index: p.length - 1, to: f, rank: c.rank };
    }
  };
  consider("waste");
  TABLEAU.forEach(consider);
  if (best) {
    const b = best as { from: string; index: number; to: string };
    return tryMove(s, b.from, b.index, b.to);
  }
  return drawStock(s);
}

export const Klondike: Rules<KlondikeState> = {
  id: "klondike",
  name: "Klondike",
  deal: (seed, opts) => dealKlondike(seed, (opts?.draw as 1 | 3) ?? 1),
  pileKeys: () => KEYS,
  canPickUp,
  tryMove,
  smartTarget,
  tapPile: (s, pile) => (pile === "stock" ? drawStock(s) : null),
  hint,
  canAutoFinish,
  autoStep,
  isWon: isWonK,
};
