/**
 * "Something good just happened" — one event, anything can listen.
 *
 * The mark on `/coin` has had five celebration animations since the day it was
 * written, and the only way to see one was to click it yourself. Which is
 * backwards: the moment worth celebrating is the moment the number goes *up*,
 * and that happens in an edge function, three components away from the canvas.
 *
 * So this is the thinnest possible wire between them. Not a context, because
 * the emitter is a plain module (`vibecoin.ts` is not React and should not have
 * to become React to say "you earned something"), and not a `window` event,
 * because a global name is a public API nobody agreed to.
 *
 * Deliberately fire-and-forget: nothing waits on a celebration, nothing fails
 * if there is no mark on screen to play one, and a listener that throws must
 * not take the payout with it.
 */

export interface Celebration {
  /** What happened. Free text, for a listener that wants to differentiate. */
  reason: string;
  /** How big a deal it was, roughly — coins earned, worlds stamped, whatever. */
  magnitude?: number;
}

type Listener = (c: Celebration) => void;

const listeners = new Set<Listener>();

/**
 * Announce it.
 *
 * Safe to call from anywhere, at any rate: listeners are expected to rate-limit
 * themselves rather than have this guess what a sensible cadence is. A payout
 * of one coin per second should not queue sixty animations.
 */
export function celebrate(reason: string, magnitude?: number): void {
  const c: Celebration = { reason, magnitude };
  for (const l of listeners) {
    try {
      l(c);
    } catch {
      /* A confetti animation is never worth breaking the thing that paid out. */
    }
  }
}

export function onCelebrate(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
