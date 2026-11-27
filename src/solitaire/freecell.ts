/**
 * FreeCell: every card dealt face up into eight columns, four free cells to
 * park a card in, and almost every deal can be won. The thinking game to
 * Klondike's luck.
 *
 * Piles: `c0`..`c3` (free cells, one card each), `f0`..`f3` (foundations),
 * `t0`..`t7` (tableau, built down in alternating colours, anything on an empty
 * column). A run can be moved as a unit when there is room to have moved it
 * one card at a time: (free cells + 1) doubled for every empty column that is
 * not the destination.
 */
import { freshDeck, isRed, shuffled, type Card } from "./cards";
import { top, withPiles, type BaseState, type Hint, type Rules } from "./rules";

export type FreeCellState = BaseState;

export const CELLS = ["c0", "c1", "c2", "c3"] as const;
export const FC_FOUNDATIONS = ["f0", "f1", "f2", "f3"] as const;
export const FC_TABLEAU = ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"] as const;
const KEYS = [...CELLS, ...FC_FOUNDATIONS, ...FC_TABLEAU];

const isCell = (k: string) => k[0] === "c";
const isFoundation = (k: string) => k[0] === "f";
const isTableau = (k: string) => k[0] === "t";

export function dealFreeCell(seed: number): FreeCellState {
  const deck = shuffled(freshDeck(), seed).map((c) => ({ ...c, up: true }));
  const piles: Record<string, Card[]> = {};
  for (const k of KEYS) piles[k] = [];
  deck.forEach((c, i) => piles[FC_TABLEAU[i % 8]].push(c));
  return { piles, moves: 0, score: 0, seed };
}

const inSequence = (a: Card, b: Card) => b.rank === a.rank - 1 && isRed(a.suit) !== isRed(b.suit);

/** How many cards may move at once onto `to`. */
export function maxRun(s: FreeCellState, to: string): number {
  const freeCells = CELLS.filter((c) => s.piles[c].length === 0).length;
  const emptyCols = FC_TABLEAU.filter((t) => t !== to && s.piles[t].length === 0).length;
  return (freeCells + 1) * 2 ** emptyCols;
}

function canPickUp(s: FreeCellState, pile: string, index: number): boolean {
  const p = s.piles[pile];
  if (!p || index < 0 || index >= p.length) return false;
  if (!isTableau(pile)) return index === p.length - 1;
  for (let i = index + 1; i < p.length; i++) if (!inSequence(p[i - 1], p[i])) return false;
  return true;
}

function accepts(s: FreeCellState, to: string, card: Card, count: number): boolean {
  const pile = s.piles[to];
  if (!pile) return false;
  const t = top(pile);
  if (isCell(to)) return count === 1 && !t;
  if (isFoundation(to)) {
    if (count !== 1) return false;
    return t ? t.suit === card.suit && card.rank === t.rank + 1 : card.rank === 1;
  }
  if (count > maxRun(s, to)) return false;
  return !t || inSequence(t, card);
}

function tryMove(s: FreeCellState, from: string, index: number, to: string): FreeCellState | null {
  if (from === to || !canPickUp(s, from, index)) return null;
  const src = s.piles[from];
  const run = src.slice(index);
  if (!accepts(s, to, run[0], run.length)) return null;
  return {
    ...withPiles(s, { [from]: src.slice(0, index), [to]: s.piles[to].concat(run) }),
    moves: s.moves + 1,
    score: s.score + (isFoundation(to) ? 10 : isFoundation(from) ? -10 : 0),
  };
}

function smartTarget(s: FreeCellState, from: string, index: number): string | null {
  if (!canPickUp(s, from, index)) return null;
  const src = s.piles[from];
  const card = src[index];
  const count = src.length - index;
  if (count === 1 && !isFoundation(from)) {
    for (const f of FC_FOUNDATIONS) if (accepts(s, f, card, 1)) return f;
  }
  const start = isTableau(from) ? Number(from.slice(1)) + 1 : 0;
  let empty: string | null = null;
  for (let k = 0; k < FC_TABLEAU.length; k++) {
    const t = FC_TABLEAU[(start + k) % FC_TABLEAU.length];
    if (t === from || !accepts(s, t, card, count)) continue;
    if (s.piles[t].length === 0) {
      if (!(isTableau(from) && index === 0) && !empty) empty = t;
      continue;
    }
    return t;
  }
  if (empty) return empty;
  if (count === 1 && !isCell(from)) {
    for (const c of CELLS) if (s.piles[c].length === 0) return c;
  }
  return null;
}

function hint(s: FreeCellState): Hint | null {
  const singles: { from: string; index: number }[] = [];
  for (const k of [...CELLS, ...FC_TABLEAU]) if (s.piles[k].length) singles.push({ from: k, index: s.piles[k].length - 1 });
  for (const src of singles) {
    const c = s.piles[src.from][src.index];
    for (const f of FC_FOUNDATIONS) if (accepts(s, f, c, 1)) return { ...src, to: f };
  }
  // The longest movable run onto a non-empty column.
  for (const t of FC_TABLEAU) {
    const p = s.piles[t];
    if (!p.length) continue;
    let i = p.length - 1;
    while (i > 0 && inSequence(p[i - 1], p[i])) i--;
    for (let j = i; j < p.length; j++) {
      for (const to of FC_TABLEAU) {
        if (to === t || !s.piles[to].length) continue;
        if (accepts(s, to, p[j], p.length - j)) return { from: t, index: j, to };
      }
    }
  }
  for (const c of CELLS) {
    const card = top(s.piles[c]);
    if (!card) continue;
    for (const to of FC_TABLEAU) if (accepts(s, to, card, 1)) return { from: c, index: 0, to };
  }
  return null;
}

export function isWonFC(s: FreeCellState): boolean {
  return FC_FOUNDATIONS.reduce((n, f) => n + s.piles[f].length, 0) === 52;
}

function canAutoFinish(s: FreeCellState): boolean {
  if (isWonFC(s)) return false;
  return FC_TABLEAU.every((t) => {
    const p = s.piles[t];
    for (let i = 1; i < p.length; i++) if (p[i].rank >= p[i - 1].rank) return false;
    return true;
  });
}

function autoStep(s: FreeCellState): FreeCellState | null {
  let best: { from: string; index: number; to: string; rank: number } | null = null;
  for (const k of [...CELLS, ...FC_TABLEAU]) {
    const p = s.piles[k];
    const c = top(p);
    if (!c) continue;
    for (const f of FC_FOUNDATIONS) {
      if (accepts(s, f, c, 1) && (!best || c.rank < best.rank)) best = { from: k, index: p.length - 1, to: f, rank: c.rank };
    }
  }
  if (!best) return null;
  const b = best as { from: string; index: number; to: string };
  return tryMove(s, b.from, b.index, b.to);
}

export const FreeCell: Rules<FreeCellState> = {
  id: "freecell",
  name: "FreeCell",
  deal: (seed) => dealFreeCell(seed),
  pileKeys: () => KEYS,
  canPickUp,
  tryMove,
  smartTarget,
  hint,
  canAutoFinish,
  autoStep,
  isWon: isWonFC,
};
