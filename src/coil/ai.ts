/**
 * COIL — the other twenty-two.
 *
 * There is no server behind this arena, so the bots *are* the game, and the bar
 * is set by what the genre actually feels like: something that grazes in a
 * straight line is scenery, and dying to scenery is not a story.
 *
 * A snake cannot stop, cannot reverse, and cannot turn faster than its turn
 * rate, so "what do I do" is only ever "which heading do I commit to". That
 * makes the natural shape of this brain a **fan of candidate headings, scored**:
 * project a ray along each one, and ask what is on it.
 *
 *   - somebody's body on it, close      → very bad, and worse the closer it is
 *   - the wall on it                    → the same, because the wall kills too
 *   - orbs on it                        → good, weighted by value over distance
 *   - a big turn away from where I am pointing → mildly bad
 *
 * Take the best. That one loop produces all the behaviour that matters: bots
 * that thread gaps, follow food, peel away from a wall, and — because a wall of
 * somebody's body scores worse than a long way round — go *around* a snake that
 * is crossing in front rather than into it.
 *
 * On top of that sits exactly one deliberate move, `cutOff`, because it is the
 * one thing a person does in this game that emergent steering never invents:
 * getting in front of somebody on purpose.
 */
import { ARENA_R, BOOST_MIN_SCORE, SPEED, TURN_RATE, radiusOf } from "./config";
import type { Hit } from "./grid";
import type { CoilSim } from "./sim";
import type { Snake } from "./types";

/** Candidate headings, spread either side of where the snake already points. */
const FAN = 11;
/** How far either side the fan reaches. Wider than one tick of turning, because
 *  the question is "where do I commit", not "where can I be next frame". */
const FAN_SPREAD = 1.5;
/**
 * Samples along each candidate ray.
 *
 * Three left gaps between the probe discs that a body could sit in unseen, and
 * the arena read as a blender — a median bot life of seven seconds. Five is
 * still cheap (eleven rays, seven times a second) and closes them.
 */
const SAMPLES = 5;

/**
 * How often a bot may *try* a cut, per second.
 *
 * The first version rolled `daring` on every think, which at seven thinks a
 * second is a bot that spends its life charging at other snakes' heads — and
 * charging at a head is precisely how you arrive at a body. A cut is a thing
 * you do occasionally and on purpose.
 */
const CUT_COOLDOWN = 2.5;

const scratch: Hit[] = [];
const orbScratch: Hit[] = [];

export function think(sim: CoilSim, s: Snake): void {
  const brain = s.brain;
  if (!brain || !s.alive) return;

  const hx = s.body.headX;
  const hy = s.body.headY;
  const r = radiusOf(s.score);
  /* How far ahead to care about. Two-thirds of a second of travel, plus the
     turning circle — anything closer than your own turning circle is already
     unavoidable, so looking only that far is looking too late. */
  const turnRadius = SPEED / TURN_RATE;
  const look = SPEED * 0.66 + turnRadius * (0.8 + brain.wit * 0.9);
  const clearance = r + 14 + brain.wit * 12;

  let bestAngle = s.angle;
  let bestScore = -Infinity;

  for (let i = 0; i < FAN; i++) {
    // -1 … +1 across the fan, so `t` is also how far off-centre this candidate
    // is and can be used as the turn-cost weight below.
    const t = (i / (FAN - 1)) * 2 - 1;
    const angle = s.angle + t * FAN_SPREAD;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    let score = 0;

    // --- what is on this ray ------------------------------------------------
    let blocked = false;
    for (let k = 1; k <= SAMPLES; k++) {
      const along = (k / SAMPLES) * look;
      const px = hx + ca * along;
      const py = hy + sa * along;

      // The wall kills exactly like a body does, so it is scored the same way.
      const fromCentre = Math.hypot(px, py);
      if (fromCentre > ARENA_R - r * 1.5) {
        score -= 1400 * (1 - (k - 1) / SAMPLES);
        blocked = true;
        break;
      }

      sim.hits.query(px, py, clearance, scratch);
      for (let j = 0; j < scratch.length; j++) {
        const h = scratch[j];
        if (h.snake === s.id) continue;
        const dx = h.x - px;
        const dy = h.y - py;
        const reach = clearance + h.r;
        if (dx * dx + dy * dy > reach * reach) continue;
        // Nearer samples matter more: something two body lengths away is a
        // problem, something at the end of the ray is a preference.
        score -= 1200 * (1 - (k - 1) / SAMPLES);
        blocked = true;
        break;
      }
      if (blocked) break;
    }

    /* Somebody else's *head* is a body about to be where their head is. The
       ray test only sees the line that already exists, so an oncoming snake
       reads as clear until the moment it is not. */
    if (!blocked) {
      for (const other of sim.snakes) {
        if (other.id === s.id || !other.alive) continue;
        const ox = other.body.headX;
        const oy = other.body.headY;
        const dx = ox - hx;
        const dy = oy - hy;
        const d = Math.hypot(dx, dy);
        if (d > look * 1.2 || d < 1) continue;
        // Only the ones roughly along this candidate matter.
        const along = (dx * ca + dy * sa) / d;
        if (along < 0.55) continue;
        score -= (1 - d / (look * 1.2)) * 420 * (0.5 + brain.wit);
      }
    }

    // --- what is worth having on it ----------------------------------------
    if (!blocked) {
      const px = hx + ca * look * 0.55;
      const py = hy + sa * look * 0.55;
      sim.orbGridQuery(px, py, look * 0.5, orbScratch);
      let food = 0;
      for (let j = 0; j < orbScratch.length; j++) {
        const o = orbScratch[j];
        const d = Math.hypot(o.x - px, o.y - py);
        // `o.r` stands in for value: corpse orbs are drawn fatter, and a bot
        // steering towards the fat ones is a bot that goes for the kill spill.
        food += (o.r * o.r) / (d + 60);
      }
      score += food * (0.9 + brain.greed * 1.4);
    }

    // Prefer not to swing wildly. Without this a bot in an empty arena picks a
    // different edge of the fan every time it thinks and swims like a fish.
    score -= Math.abs(t) * 26;
    if (score > bestScore) {
      bestScore = score;
      bestAngle = angle;
    }
  }

  // Once a heading is chosen, hold it briefly. Re-deciding every 80 ms from a
  // scoring function this twitchy makes a snake that shivers down the middle of
  // two equally good gaps.
  if (sim.time < brain.commitUntil && bestScore > -600) {
    // Still commit, but let a genuinely alarming reading override the hold.
    brain.wantBoost = brain.wantBoost && s.score > BOOST_MIN_SCORE * 1.6;
    return;
  }
  brain.want = bestAngle;
  /* Short, and shorter for a sharper bot. The heading it just picked may be a
     radian away, which takes a third of a second to reach — most of which is
     spent travelling somewhere it has not evaluated. Re-deciding on the way
     there is what keeps that from being fatal. */
  brain.commitUntil = sim.time + 0.1 + (1 - brain.wit) * 0.16;
  brain.wantBoost = false;

  // --- the one deliberate move ---------------------------------------------
  if (sim.time < brain.nextCut) return;
  const target = cutOff(sim, s, brain.wit);
  if (target && sim.random() < brain.daring) {
    // Never cut into something. The fan already knows what is on that heading;
    // asking it again for this one heading is four probes and buys a bot that
    // does not kill itself going for a kill.
    if (!clearAhead(sim, s, target.angle, look * 0.9, clearance)) return;
    brain.nextCut = sim.time + CUT_COOLDOWN * (1.4 - brain.daring);
    brain.want = target.angle;
    // Boost into it, but only with something in the tank — a bot that burns
    // itself down to nothing chasing a kill is a bot that dies to the corpse.
    brain.wantBoost = s.score > BOOST_MIN_SCORE * 2.4 && target.close;
    brain.commitUntil = sim.time + 0.25;
  }
}

/** Is this heading free of bodies and wall for `dist`? */
function clearAhead(
  sim: CoilSim,
  s: Snake,
  angle: number,
  dist: number,
  clearance: number,
): boolean {
  const hx = s.body.headX;
  const hy = s.body.headY;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  for (let k = 1; k <= 4; k++) {
    const px = hx + ca * (k / 4) * dist;
    const py = hy + sa * (k / 4) * dist;
    if (Math.hypot(px, py) > ARENA_R - radiusOf(s.score) * 2) return false;
    sim.hits.query(px, py, clearance, scratch);
    for (let j = 0; j < scratch.length; j++) {
      const h = scratch[j];
      if (h.snake === s.id) continue;
      const dx = h.x - px;
      const dy = h.y - py;
      const reach = clearance + h.r;
      if (dx * dx + dy * dy <= reach * reach) return false;
    }
  }
  return true;
}

/**
 * Can I get in front of somebody?
 *
 * Lead their head by where it will be in the time it takes me to get there —
 * the standard interception — and only take it if the answer is *ahead* of
 * them rather than beside them. Aiming at where somebody is right now is how a
 * bot rams the side of a snake and dies on it, which is the exact opposite of
 * the intended move.
 */
function cutOff(
  sim: CoilSim,
  s: Snake,
  wit: number,
): { angle: number; close: boolean } | null {
  if (wit < 0.35) return null;
  const hx = s.body.headX;
  const hy = s.body.headY;
  const range = 260 + wit * 420;

  let best: Snake | null = null;
  let bestD = Infinity;
  for (const other of sim.snakes) {
    if (other.id === s.id || !other.alive) continue;
    const d = Math.hypot(other.body.headX - hx, other.body.headY - hy);
    if (d > range || d > bestD) continue;
    bestD = d;
    best = other;
  }
  if (!best) return null;

  const lead = bestD / SPEED;
  const tx = best.body.headX + Math.cos(best.angle) * SPEED * lead * 1.35;
  const ty = best.body.headY + Math.sin(best.angle) * SPEED * lead * 1.35;
  const angle = Math.atan2(ty - hy, tx - hx);

  // Only worth it if the intercept is in front of *them*: dot the direction we
  // would be arriving from against their heading.
  const facing = Math.cos(angle - best.angle);
  if (facing > -0.15) return null;

  // ...and never if the wall is where we would be going.
  const px = hx + Math.cos(angle) * bestD * 0.8;
  const py = hy + Math.sin(angle) * bestD * 0.8;
  if (Math.hypot(px, py) > ARENA_R - radiusOf(s.score) * 2) return null;

  return { angle, close: bestD < range * 0.6 };
}

/** Used by the tests: a bot with every dial in the middle. */
export function neutralBrain(): NonNullable<Snake["brain"]> {
  return {
    wit: 0.75,
    daring: 0.4,
    greed: 0.6,
    nextThink: 0,
    want: 0,
    wantBoost: false,
    commitUntil: 0,
    nextCut: 0,
  };
}
