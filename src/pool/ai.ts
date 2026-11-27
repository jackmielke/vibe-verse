/**
 * The computer. It plays the way a decent bar player thinks:
 *
 *  1. List every shot it could pot: each legal ball into each pocket, aimed at
 *     the ghost ball, where the cue ball's path and the object ball's path are
 *     both clear and the cut is not hopeless.
 *  2. Play the best of them for real, in the same physics the table uses, at a
 *     few speeds and with a little draw or follow, and see what happens.
 *  3. Keep the one that pots a ball and leaves the cue ball somewhere with
 *     another shot on. If nothing pots, play the safest touch on its own ball.
 *
 * Then it misses on purpose by however much its level says: a small random
 * error on the angle and the speed of the shot it chose. Easy misses a lot and
 * never plans position; hard barely misses and does.
 *
 * It is a generator so the page can spread the thinking over a few frames.
 */
import {
  type Ball, type Strike, POCKETS, R, L, W, HEAD_STRING, cloneBalls, simulate, strike, canPlace,
} from "./physics";
import { type PoolState, cloneState, legalTargets, onEight, resolveShot, groupOf } from "./rules";

export type Level = "easy" | "normal" | "hard";

export interface Plan extends Strike {
  /** Where to put the cue ball first, with ball in hand. */
  place?: { x: number; y: number };
  /** The pocket it is calling for the 8. */
  called: number | null;
}

const LEVELS: Record<Level, { aim: number; speed: number; sims: number; position: boolean; spin: boolean }> = {
  easy: { aim: 0.034, speed: 0.12, sims: 10, position: false, spin: false },
  normal: { aim: 0.014, speed: 0.06, sims: 26, position: true, spin: true },
  hard: { aim: 0.0028, speed: 0.025, sims: 44, position: true, spin: true },
};

interface Candidate {
  target: number;
  pocket: number;
  angle: number;
  ease: number;
  cue: { x: number; y: number };
}

function segClear(balls: Ball[], ax: number, ay: number, bx: number, by: number, skip: number[], clearance: number): boolean {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey;
  if (len2 === 0) return true;
  for (const b of balls) {
    if (!b.on || skip.includes(b.id)) continue;
    let t = ((b.x - ax) * ex + (b.y - ay) * ey) / len2;
    if (t < 0 || t > 1) continue;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(b.x - (ax + ex * t), b.y - (ay + ey * t));
    if (d < clearance) return false;
  }
  return true;
}

/** Straightforward pots from a cue position. */
export function potCandidates(s: PoolState, cue: { x: number; y: number }, targets = legalTargets(s)): Candidate[] {
  const out: Candidate[] = [];
  for (const id of targets) {
    const ob = s.balls[id];
    if (!ob.on) continue;
    POCKETS.forEach((p, pi) => {
      const dx = p.mx - ob.x;
      const dy = p.my - ob.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-6) return;
      const ux = dx / dist;
      const uy = dy / dist;
      // Side pockets refuse balls coming in too shallow.
      if (!p.corner && Math.abs(uy) < 0.45) return;
      // Corner pockets refuse balls running almost along the rail.
      if (p.corner && (Math.abs(ux) < 0.15 || Math.abs(uy) < 0.15) && dist > 0.25) return;
      const gx = ob.x - ux * 2 * R;
      const gy = ob.y - uy * 2 * R;
      const cx = gx - cue.x;
      const cy = gy - cue.y;
      const cd = Math.hypot(cx, cy);
      if (cd < 1e-6) return;
      const cos = (cx * ux + cy * uy) / cd;
      if (cos < 0.26) return; // cut past ~75 degrees
      if (!segClear(s.balls, cue.x, cue.y, gx, gy, [0, id], 2 * R - 0.001)) return;
      if (!segClear(s.balls, ob.x, ob.y, p.mx, p.my, [0, id], 2 * R - 0.001)) return;
      const ease = cos * cos / (1 + 1.2 * dist + 0.6 * cd);
      out.push({ target: id, pocket: pi, angle: Math.atan2(cy, cx), ease, cue: { x: cue.x, y: cue.y } });
    });
  }
  return out.sort((a, b) => b.ease - a.ease);
}

/** How many decent shots the shooter would have from here, weighted. */
function positionScore(s: PoolState): number {
  if (s.phase === "over") return 0;
  const c = potCandidates(s, s.balls[0]);
  let v = 0;
  for (let i = 0; i < Math.min(3, c.length); i++) v += c[i].ease * (i === 0 ? 1 : 0.35);
  return v;
}

function score(s: PoolState, plan: Strike & { place?: { x: number; y: number } }, called: number | null, wantPosition: boolean): number {
  const st = cloneState(s);
  st.called = called;
  const balls = cloneBalls(st.balls);
  if (plan.place) { balls[0].x = plan.place.x; balls[0].y = plan.place.y; }
  const start = cloneState(st);
  start.balls = cloneBalls(balls);
  strike(balls[0], plan);
  const rec = simulate(balls, 20, false);
  const { state, outcome } = resolveShot(start, balls, rec);
  const me = s.turn;
  if (outcome.winner === me) return 1e5;
  if (outcome.winner !== null) return -1e5;
  if (outcome.foul) return -800 + Math.random();
  if (outcome.again) return 1000 + (wantPosition ? 3000 * positionScore(state) : 0) + Math.random();
  // A miss: the less the other player has to shoot at, the better.
  return -2000 * positionScore(state) + Math.random();
}

const jitter = (rand: () => number, sd: number): number => {
  // Roughly normal.
  return (rand() + rand() + rand() - 1.5) * sd * 1.4;
};

function ballInHandSpots(s: PoolState): { x: number; y: number }[] {
  const spots: { x: number; y: number }[] = [];
  const targets = legalTargets(s);
  for (const id of targets) {
    const ob = s.balls[id];
    if (!ob.on) continue;
    for (const p of POCKETS) {
      const dx = p.mx - ob.x;
      const dy = p.my - ob.y;
      const d = Math.hypot(dx, dy);
      for (const back of [0.18, 0.32]) {
        const x = ob.x - (dx / d) * (2 * R + back);
        const y = ob.y - (dy / d) * (2 * R + back);
        if (canPlace(s.balls, x, y, s.kitchen)) spots.push({ x, y });
      }
    }
  }
  if (spots.length === 0) {
    for (let i = 0; i < 40; i++) {
      const x = s.kitchen ? -L / 2 + 0.1 + Math.random() * (HEAD_STRING + L / 2 - 0.12) : (Math.random() - 0.5) * (L - 0.2);
      const y = (Math.random() - 0.5) * (W - 0.2);
      if (canPlace(s.balls, x, y, s.kitchen)) spots.push({ x, y });
    }
  }
  return spots;
}

/** Think. Yields between batches so a frame can draw; returns the shot. */
export function* think(s: PoolState, level: Level, rand: () => number = Math.random): Generator<void, Plan, void> {
  const cfg = LEVELS[level];
  const cue = s.balls[0];

  // The break: from just off the head spot, hard, at the apex.
  if (s.isBreak) {
    const place = { x: HEAD_STRING - 0.02, y: (rand() - 0.5) * 0.25 };
    const apex = s.balls.filter((b) => b.on && b.id !== 0).sort((a, b) => a.x - b.x)[0];
    const angle = Math.atan2(apex.y - place.y, apex.x - place.x) + jitter(rand, 0.004);
    return { place, angle, speed: 6.3 + rand() * 0.3, spinX: 0, spinY: 0.1, called: null };
  }

  const eight = onEight(s);
  const tries: { plan: Strike & { place?: { x: number; y: number } }; called: number | null; base: Candidate | null }[] = [];

  const positions = s.ballInHand ? ballInHandSpots(s) : [{ x: cue.x, y: cue.y }];
  let cands: Candidate[] = [];
  for (const pos of positions) cands.push(...potCandidates(s, pos));
  cands.sort((a, b) => b.ease - a.ease);
  // Keep variety: no more than two attempts on the same ball and pocket.
  const seen = new Map<string, number>();
  cands = cands.filter((c) => {
    const k = `${c.target}-${c.pocket}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n < 2;
  });

  const speeds = cfg.position ? [1.4, 2.3, 3.4] : [2.2];
  const spins = cfg.spin ? [0, -0.6, 0.5] : [0];
  for (const c of cands) {
    for (const sp of speeds) {
      for (const sy of spins) {
        tries.push({
          plan: { angle: c.angle, speed: sp, spinX: 0, spinY: sy, place: s.ballInHand ? c.cue : undefined },
          called: eight ? c.pocket : null,
          base: c,
        });
      }
    }
  }
  tries.splice(cfg.sims);

  // Safeties: roll softly into one of its own balls.
  if (tries.length < cfg.sims) {
    const pos = positions[0];
    for (const id of legalTargets(s)) {
      const b = s.balls[id];
      for (const off of [0, -0.6, 0.6]) {
        const a = Math.atan2(b.y - pos.y, b.x - pos.x) + off * Math.asin(Math.min(1, (2 * R) / Math.max(2 * R, Math.hypot(b.x - pos.x, b.y - pos.y))));
        for (const sp of [1.1, 1.9]) {
          tries.push({ plan: { angle: a, speed: sp, spinX: 0, spinY: 0, place: s.ballInHand ? pos : undefined }, called: eight ? 0 : null, base: null });
        }
      }
      if (tries.length > cfg.sims + 12) break;
    }
  }

  let best = tries[0];
  let bestScore = -Infinity;
  for (let i = 0; i < tries.length; i++) {
    const t = tries[i];
    const v = score(s, t.plan, t.called, cfg.position);
    if (v > bestScore) { bestScore = v; best = t; }
    if (i % 3 === 2) yield;
  }

  if (!best) {
    // Nothing at all: hit something, anything, firmly.
    const id = legalTargets(s)[0] ?? 8;
    const b = s.balls[id];
    return { angle: Math.atan2(b.y - cue.y, b.x - cue.x), speed: 2.5, spinX: 0, spinY: 0, called: eight ? 0 : null };
  }

  const angle = best.plan.angle + jitter(rand, cfg.aim);
  const speed = best.plan.speed * (1 + jitter(rand, cfg.speed));
  return { ...best.plan, angle, speed, called: best.called };
}

/** Run the generator to the end, for tests and the shot mode. */
export function planNow(s: PoolState, level: Level, rand?: () => number): Plan {
  const g = think(s, level, rand);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

export const groupName = (id: number): string => groupOf(id) ?? "eight";
