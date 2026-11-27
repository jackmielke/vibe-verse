/**
 * The shape every card game here exposes to the page.
 *
 * The page knows how to draw piles, drag cards, animate and undo. It does not
 * know a single rule: it asks the game whether a card can be picked up, where
 * it may go, and what the state is afterwards. Klondike and FreeCell are both
 * this interface, so they share one table, one renderer and one undo stack.
 *
 * States are immutable. Every move returns a new object (piles that did not
 * change are shared), so undo is a stack of old states and nothing else.
 */
import type { Card } from "./cards";

export interface BaseState {
  piles: Record<string, Card[]>;
  moves: number;
  score: number;
  seed: number;
}

export interface Hint {
  from: string;
  index: number;
  to: string;
}

export interface Rules<S extends BaseState> {
  id: string;
  name: string;
  deal(seed: number, opts?: Record<string, unknown>): S;
  /** Every pile key, in drawing order. */
  pileKeys(s: S): string[];
  /** Can the card at `index` (and everything on top of it) be lifted? */
  canPickUp(s: S, pile: string, index: number): boolean;
  /** The state after moving `from[index..]` onto `to`, or null if illegal. */
  tryMove(s: S, from: string, index: number, to: string): S | null;
  /** Where a tap on this card should send it, best first. Null if nowhere. */
  smartTarget(s: S, from: string, index: number): string | null;
  /** Tap on a pile itself (the stock, mostly). Null if a tap there does nothing. */
  tapPile?(s: S, pile: string): S | null;
  /** A useful move, for the hint button. */
  hint(s: S): Hint | "draw" | null;
  /** Can the rest be played out automatically? */
  canAutoFinish(s: S): boolean;
  /** One automatic step toward the win, or null when there is nothing left. */
  autoStep(s: S): S | null;
  isWon(s: S): boolean;
}

export const top = <T>(a: readonly T[]): T | undefined => a[a.length - 1];

/** Shallow copy of `piles` with some keys replaced. */
export function withPiles<S extends BaseState>(s: S, patch: Record<string, Card[]>): S {
  return { ...s, piles: { ...s.piles, ...patch } };
}
