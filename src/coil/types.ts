/**
 * COIL — the shapes the sim moves around.
 *
 * Same discipline as BLOB's: plain data, no methods, so a test can build one
 * out of a literal. The one exception is `Body`, which owns a trail and a
 * binary search and would be absurd as three loose arrays on a struct.
 */
import type { Body } from "./body";

export interface Snake {
  id: number;
  name: string;
  /**
   * A `CharSpec.id` from `src/lib/characters.ts`.
   *
   * This is the whole hook of the world: the thing on the front of the snake is
   * the character you bought in the shop and are wearing everywhere else. The
   * body takes its colour from the same spec, so a snake is *your* snake at a
   * glance from across the arena.
   */
  charId: string;
  /** Body colour, resolved from the character once at spawn. */
  color: string;
  isBot: boolean;
  alive: boolean;
  body: Body;
  /** Heading in radians. The head only ever moves along this. */
  angle: number;
  /** Where this snake wants to be pointing. The turn rate does the rest. */
  targetAngle: number;
  boosting: boolean;
  /** Length in orbs eaten, which is also the score and the leaderboard number. */
  score: number;
  /** Biggest score this snake ever held. */
  peak: number;
  /** How many snakes have died on this one's body. */
  kills: number;
  /** Sim time it died, for the respawn timer. */
  diedAt: number;
  /** Fractional score owed to the boost drain, carried between ticks. */
  boostDebt: number;
  /** Sim time the next boost orb is due. */
  nextBoostOrb: number;
  brain?: BotBrain;
}

export interface Orb {
  id: number;
  x: number;
  y: number;
  value: number;
  /** Drawn radius. Corpse orbs are fatter than grazing orbs. */
  r: number;
  hue: number;
  /** Phase offset so the field breathes instead of pulsing in lockstep. */
  phase: number;
}

export interface BotBrain {
  wit: number;
  daring: number;
  greed: number;
  /** Sim time of the next decision. */
  nextThink: number;
  /** Heading it settled on last time it thought. */
  want: number;
  wantBoost: boolean;
  /** Sim time this bot stops committing to whatever it is doing, so it does
   *  not re-decide every tick and vibrate between two equally good ideas. */
  commitUntil: number;
  /** Sim time it may next *try* a cut. Without a cooldown a bot rolls for one
   *  seven times a second and spends its life charging at heads. */
  nextCut: number;
}

export type CoilEvent =
  | { type: "eat"; x: number; y: number; value: number; by: number }
  | { type: "boost"; x: number; y: number; by: number }
  /** A head ran into a body. `by` is the head; `into` is whose body it was. */
  | { type: "crash"; x: number; y: number; by: number; into: number; score: number }
  /** Somebody's line killed somebody. Both names, for the feed. */
  | { type: "kill"; killer: string; victim: string; color: string; score: number };

export interface Standing {
  id: number;
  name: string;
  score: number;
  color: string;
  charId: string;
  isBot: boolean;
}
