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
/**
 * The flying modes search less deeply but every single decision, because both
 * options always matter there. 20 × 50 ms = 1 s = ten blocks — two gates.
 */
const FLY_HORIZON = 20;
/**
 * Frontier cap. Dedupe keeps a cube's frontier near a dozen, but a ship's
 * state space is continuous in both y and vy, so its frontier is much wider
 * and truncating it produces *false negatives* — the search reports no future
 * where one exists. 240 is where the ship section stops producing them.
 */
const MAX_FRONTIER = 240;
/** A cube's frontier collapses under dedupe; it never needs the wide cap. */
const MAX_FRONTIER_GROUNDED = 96;

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
  const cap =
    p.mode === "ship" || p.mode === "wave" ? MAX_FRONTIER : MAX_FRONTIER_GROUNDED;
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
        if (next.length >= cap) break;
      }
      if (next.length >= cap) break;
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

/**
 * What should the button be doing right now?
 *
 * Every mode gets the same treatment: order the two options by a cheap
 * heuristic, then ask the search whether the first one has a future. The
 * heuristic alone used to drive the flying modes, and a proportional
 * controller cannot see a gate two beats out — it flew the ship into a wall at
 * 49% and the honest reading of that is that the *solver* was too weak, not
 * that the level was too hard. Searching in flight costs a few hundred
 * microseconds and removes the whole class of false negatives.
 */
export function botDecision(p: PlayerState, world: World): BotDecision {
  const flying = p.mode === "ship" || p.mode === "wave";
  if (!flying && !actionMatters(p, world)) return { hold: false, doomed: false };

  // Try the heuristic's answer first, so ties break toward the middle of the
  // corridor rather than toward whichever of the two happens to be `false`.
  const first = flying ? fly(p, world) : false;
  for (const hold of [first, !first]) {
    const q = clonePlayer(p);
    if (!advance(q, world, hold)) continue;
    if (survives(q, world, flying ? FLY_HORIZON : HORIZON)) return { hold, doomed: false };
  }
  // Nothing survives the horizon. Commit and hope — and say so.
  return { hold: first, doomed: true };
}

/** Distance from the player's centre to a point, in blocks. */
function distTo(p: PlayerState, c: { x: number; y: number }): number {
  return Math.hypot(p.x - c.x, p.y + 0.5 - c.y);
}

/**
 * Has the player actually picked the coin up?
 *
 * The same box the engine uses — a coin is 1.2 blocks wide and collects within
 * 0.4 of its edge, so the real reach is ±1 block on each axis. The chase used
 * to ask for a 0.85-block *radius*, which is smaller than the game's own
 * pickup, so it reported coins as unreachable that the engine would happily
 * have handed you. A verifier that is stricter than the thing it verifies
 * fails honest work.
 */
function collects(p: PlayerState, c: { x: number; y: number }): boolean {
  return Math.abs(p.x - c.x) < 1 && Math.abs(p.y + 0.5 - c.y) < 1;
}

/** Follow the cheap policy for a few decisions and report the closest this
    future ever comes to `c`. Cheap on purpose — it runs twice per decision. */
function closestApproach(
  p: PlayerState,
  world: World,
  decisions: number,
  c: { x: number; y: number },
): number {
  const q = clonePlayer(p);
  let best = distTo(q, c);
  for (let i = 0; i < decisions; i++) {
    const flying = q.mode === "ship" || q.mode === "wave";
    const wanted = flying ? fly(q, world) : false;
    let stepped = false;
    for (const hold of [wanted, !wanted]) {
      const t = clonePlayer(q);
      if (!advance(t, world, hold)) continue;
      Object.assign(q, t);
      q.usedOrbs = t.usedOrbs;
      stepped = true;
      break;
    }
    if (!stepped) break;
    best = Math.min(best, distTo(q, c));
  }
  return best;
}

/**
 * Can a player actually get that coin?
 *
 * "It sits near the line the bot flies" is an estimate, and a bad one — a coin
 * four blocks off the path might need a detour that cannot be recovered from.
 * This is a proof. At every decision it scores both options by simulating
 * which one's *future* passes closer to the coin, takes the better one, and
 * still requires it to survive the full search horizon. If this both touches
 * the coin and finishes the level, the detour is real and survivable.
 */
export function canCollect(
  world: World,
  start: PlayerState,
  coin: { x: number; y: number },
  maxSeconds = 200,
): { got: boolean; finished: boolean; stuckAt: number | null } {
  const p = clonePlayer(start);
  let got = false;
  let t = 0;
  while (t < maxSeconds && p.x < world.length) {
    if (collects(p, coin)) got = true;
    const flying = p.mode === "ship" || p.mode === "wave";
    const horizon = flying ? FLY_HORIZON : HORIZON;
    // Only steer for the coin while it is ahead and close enough to plan for.
    const chasing = !got && coin.x > p.x - 1 && coin.x - p.x < 14;

    let chosen: PlayerState | null = null;
    if (!chasing) {
      // Away from the coin this is just the ordinary solver — and asking it
      // once is half the work of scoring both options.
      const q = clonePlayer(p);
      if (advance(q, world, botDecision(p, world).hold)) chosen = q;
    } else {
      let bestScore = Infinity;
      for (const hold of [false, true]) {
        const q = clonePlayer(p);
        if (!advance(q, world, hold)) continue;
        if (!survives(q, world, horizon)) continue;
        if (collects(q, coin)) got = true;
        const score = closestApproach(q, world, 12, coin);
        if (score < bestScore) {
          bestScore = score;
          chosen = q;
        }
      }
    }
    if (!chosen) {
      // Same fallback the real solver has: the horizon is bounded, so "no
      // surviving line found" sometimes means "not within one second". Commit
      // to the heuristic and carry on rather than declaring the level over.
      const hold = flying ? fly(p, world) : true;
      const q = clonePlayer(p);
      if (!advance(q, world, hold)) return { got, finished: false, stuckAt: p.x };
      chosen = q;
    }
    Object.assign(p, chosen);
    p.usedOrbs = chosen.usedOrbs;
    t += DECISION_DT;
  }
  return { got, finished: p.x >= world.length, stuckAt: null };
}

export interface BotRun {
  /** Furthest x reached. */
  reached: number;
  finished: boolean;
  /** Seconds of level time the attempt lasted. */
  time: number;
  /** Where it died, if it did. */
  deathX: number | null;
  /** One [x, y] per decision, when `record` was asked for. The coin test uses
      it to check that each coin sits near the line a player actually flies. */
  path: Array<[number, number]>;
}

/** Fly the whole level headlessly. Used by the test, not by the game. */
export function flyLevel(
  world: World,
  start: PlayerState,
  maxSeconds = 200,
  record = false,
): BotRun {
  const p = clonePlayer(start);
  const path: Array<[number, number]> = [];
  let t = 0;
  while (t < maxSeconds) {
    if (record) path.push([p.x, p.y + 0.5]);
    if (p.x >= world.length) return { reached: p.x, finished: true, time: t, deathX: null, path };
    const { hold } = botDecision(p, world);
    if (!advance(p, world, hold)) {
      return { reached: p.x, finished: false, time: t, deathX: p.x, path };
    }
    t += DECISION_DT;
  }
  return { reached: p.x, finished: false, time: t, deathX: null, path };
}
