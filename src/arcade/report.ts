/**
 * How a game tells the Vibe Arcade a run is over.
 *
 * A game played inside an arcade cabinet is an iframe of its own route on our
 * own origin (`ArcadeCabinet.tsx`). When a run ends it calls this with one
 * number; the cabinet hears it, pays tickets and offers the high score wall.
 * Played anywhere else (the front page, its own tab) this does nothing at all,
 * so a game can call it unconditionally.
 */
export const ARCADE_SCORE_MESSAGE = "vibe-arcade-score";

export interface ArcadeScoreMessage {
  type: typeof ARCADE_SCORE_MESSAGE;
  game: string;
  score: number;
  won: boolean;
}

export function inArcade(): boolean {
  if (typeof window === "undefined" || window.parent === window) return false;
  return new URLSearchParams(window.location.search).get("from") === "arcade";
}

export function reportArcadeScore(game: string, score: number, won = false) {
  if (!inArcade() || !Number.isFinite(score) || score < 0) return;
  const msg: ArcadeScoreMessage = { type: ARCADE_SCORE_MESSAGE, game, score: Math.round(score), won };
  try {
    window.parent.postMessage(msg, window.location.origin);
  } catch {
    /* the parent went away; nothing to tell */
  }
}
