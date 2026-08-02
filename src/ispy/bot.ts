/**
 * I SPY — the bot.
 *
 * It exists to answer one question honestly: *is this level actually
 * possible?* A level like this is authored blind — the whole design goal is
 * that you cannot see what is coming — so "I played it and it felt fine" is
 * not evidence. `level.test.ts` flies this bot end to end and fails the build
 * if it cannot finish.
 *
 * It also runs the attract mode on the title screen, which is the honest way
 * to show someone what they are about to be asked to do.
 *
 * It is deliberately *not* frame-perfect. It may only change its mind twenty
 * times a second, on a fixed grid, with no knowledge the player lacks except
 * where the real hazards are. If it can clear the level at 50 ms granularity,
 * a human with the level memorised can clear it too.
 */
import { clonePlayer, step, World } from "./physics";
import type { PlayerState } from "./types";

const TICK = 1 / 240;
/** How often the bot is allowed to change its mind. */
export const DECISION_DT = 1 / 20;
const TICKS_PER_DECISION = Math.round(DECISION_DT / TICK);
/**
 * How far ahead it searches, in decisions. 26 × 50 ms = 1.3 s ≈ 13 blocks —
 * far enough to see that the jump pad at 64 commits you to whatever is at 68.
 */
const HORIZON = 26;
/** Frontier cap. Dedupe usually keeps it near a dozen; this is a seatbelt. */
const MAX_FRONTIER = 96;

/** Run one decision window at a constant button state. False if it died. */
function advance(p: PlayerState, world: World, hold: boolean): boolean {
  for (let i = 0; i < TICKS_PER_DECISION; i++) {
    step(p, world, TICK, { hold, tap: hold && i === 0 });
    if (p.dead) return false;
  }
  return true;
}

/** Does pressing the button at this instant change anything at all? */
function actionMatters(p: PlayerState, world: World): boolean {
  if (p.mode === "ship" || p.mode === "wave") return true;
  if (p.onGround) return true;
  for (const i of world.near(p.x)) {
    const o = world.objects[i];
    if (o.kind !== "orb" || p.usedOrbs.has(i)) continue;
    if (p.x > o.x && p.x < o.x + o.w && p.y + 0.5 > o.y && p.y + 0.5 < o.y + o.h)
      return true;
  }
  return false;
}

/** The free vertical interval at `x` that contains (or is nearest to) `y`. */
export function corridorAt(world: World, x: number, y: number): [number, number] {
  const spans: Array<[number, number]> = [];
  for (const i of world.near(x)) {
    const o = world.objects[i];
    if (o.kind !== "block" && o.kind !== "spike" && o.kind !== "saw") continue;
    if (x < o.x - 0.5 || x > o.x + o.w + 0.5) continue;
    spans.push([o.y - 0.9, o.y + o.h + 0.2]);
  }
  spans.sort((a, c) => a[0] - c[0]);
  let lo = 0;
  let hi = 40;
  for (const [s0, s1] of spans) {
    if (s1 <= y) lo = Math.max(lo, s1);
    else if (s0 >= y) { hi = Math.min(hi, s0); break; }
    else {
      // Standing inside a wall in the plan — bias toward the roomier side.
      if (y - s0 < s1 - y) hi = Math.min(hi, s0);
      else lo = Math.max(lo, s1);
    }
  }
  return [lo, hi];
}

/**
 * Is there any button pattern from here that survives `depth` decisions?
 *
 * Breadth-first with the frontier deduplicated by rounded state. Depth-first
 * would be exponential in the number of ground contacts and a flat run of
 * twenty decisions would hang; two different jump patterns that arrive at the
 * same height and speed are the same future, and collapsing them keeps the
 * frontier at a couple of dozen states no matter how deep the search goes.
 */
function survives(p: PlayerState, world: World, depth: number): boolean {
  let frontier = [p];
  for (let d = 0; d < depth; d++) {
    const next: PlayerState[] = [];
    const seen = new Set<string>();
    for (const s of frontier) {
      const options = actionMatters(s, world) ? [false, true] : [false];
      for (const hold of options) {
        const q = clonePlayer(s);
        if (!advance(q, world, hold)) continue;
        if (q.x >= world.length) return true;
        const key = `${Math.round(q.y * 20)}|${Math.round(q.vy * 2)}|${
          q.onGround ? 1 : 0
        }|${q.mode}|${q.grav}|${q.usedOrbs.size}`;
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(q);
        if (next.length >= MAX_FRONTIER) break;
      }
      if (next.length >= MAX_FRONTIER) break;
    }
    if (!next.length) return false;
    frontier = next;
  }
  return true;
}

/**
 * Steering for the two modes where searching is both expensive and pointless:
 * a ship or a wave is just "get to the middle of the hole".
 */
function fly(p: PlayerState, world: World): boolean {
  const ahead = p.mode === "wave" ? 2.2 : 5.5;
  const here = corridorAt(world, p.x + 0.4, p.y + 0.5);
  const there = corridorAt(world, p.x + ahead, p.y + 0.5);
  const lo = Math.max(here[0], there[0]);
  const hi = Math.min(here[1], there[1]);
  const target = hi > lo ? (lo + hi) / 2 : (there[0] + there[1]) / 2;
  if (p.mode === "wave") return p.y + 0.5 < target === (p.grav === 1);
  // Ship: lead with velocity so it stops arriving sideways into the roof.
  const projected = p.y + 0.5 + p.vy * 0.32;
  return projected < target === (p.grav === 1);
}

export interface BotDecision {
  hold: boolean;
  /** True when the bot could see no surviving line from here. */
  doomed: boolean;
}

/** What should the button be doing right now? */
export function botDecision(p: PlayerState, world: World): BotDecision {
  if (p.mode === "ship" || p.mode === "wave") {
    const hold = fly(p, world);
    const q = clonePlayer(p);
    // One decision of sanity-checking: if steering is about to kill us, the
    // other way round is usually right.
    if (!advance(q, world, hold)) return { hold: !hold, doomed: false };
    return { hold, doomed: false };
  }
  if (!actionMatters(p, world)) return { hold: false, doomed: false };
  for (const hold of [false, true]) {
    const q = clonePlayer(p);
    if (!advance(q, world, hold)) continue;
    if (survives(q, world, HORIZON)) return { hold, doomed: false };
  }
  // Nothing survives the horizon. Jump and hope — and say so.
  return { hold: true, doomed: true };
}

export interface BotRun {
  /** Furthest x reached. */
  reached: number;
  finished: boolean;
  /** Seconds of level time the attempt lasted. */
  time: number;
  /** Where it died, if it did. */
  deathX: number | null;
}

/** Fly the whole level headlessly. Used by the test, not by the game. */
export function flyLevel(world: World, start: PlayerState, maxSeconds = 200): BotRun {
  const p = clonePlayer(start);
  let t = 0;
  while (t < maxSeconds) {
    if (p.x >= world.length) return { reached: p.x, finished: true, time: t, deathX: null };
    const { hold } = botDecision(p, world);
    if (!advance(p, world, hold)) {
      return { reached: p.x, finished: false, time: t, deathX: p.x };
    }
    t += DECISION_DT;
  }
  return { reached: p.x, finished: false, time: t, deathX: null };
}
