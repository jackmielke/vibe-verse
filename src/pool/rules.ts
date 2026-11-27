/**
 * 8-ball, the bar-and-league rules everybody plays. Pure.
 *
 *  - Fifteen balls racked in a triangle, the 8 in the middle, a solid and a
 *    stripe in the two back corners. The breaker places the cue ball anywhere
 *    behind the head string.
 *  - The table is open after the break. The first player to pot a ball on a
 *    later shot owns that group (solids 1 to 7, stripes 9 to 15).
 *  - Pot one of yours and you keep shooting. Clear your group, then pot the 8
 *    in the pocket you called (the pocket is marked before the shot) to win.
 *  - A foul hands the other player the cue ball, to place anywhere: scratching,
 *    hitting nothing, hitting the wrong group (or the 8 on an open table)
 *    first, or no ball reaching a cushion after contact when nothing dropped.
 *  - Pot the 8 early, in the wrong pocket, or on a foul, and you lose. The 8 on
 *    the break is not a loss: it comes back to the foot spot.
 */
import {
  type Ball, type ShotRecord, FOOT_SPOT, HEAD_SPOT, R, cloneBalls, makeBall, nearestFree,
} from "./physics";

export type Group = "solids" | "stripes";
export type Phase = "aim" | "moving" | "over";

export interface PoolState {
  balls: Ball[];
  turn: 0 | 1;
  groups: [Group | null, Group | null];
  phase: Phase;
  /** Next shot is the break. */
  isBreak: boolean;
  /** The shooter may move the cue ball first. */
  ballInHand: boolean;
  /** …but only behind the head string (the break). */
  kitchen: boolean;
  winner: 0 | 1 | null;
  /** Plain words for what the last shot did. */
  message: string;
  /** Called pocket for the 8, when the shooter is on it. */
  called: number | null;
  shots: number;
  /** Bumped on every resolved shot, so a peer can tell states apart. */
  seq: number;
}

export const isSolid = (id: number): boolean => id >= 1 && id <= 7;
export const isStripe = (id: number): boolean => id >= 9 && id <= 15;
export const groupOf = (id: number): Group | null => (isSolid(id) ? "solids" : isStripe(id) ? "stripes" : null);
const other = (g: Group): Group => (g === "solids" ? "stripes" : "solids");

/** Small, seeded, good enough for a rack. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rack(seed: number): Ball[] {
  const rand = rng(seed);
  const balls: Ball[] = [makeBall(0, HEAD_SPOT.x, HEAD_SPOT.y)];
  // Fifteen slots, apex first, row by row toward the foot rail.
  const slots: { x: number; y: number }[] = [];
  const gap = 1.0004;
  for (let row = 0; row < 5; row++) {
    for (let j = 0; j <= row; j++) {
      slots.push({
        x: FOOT_SPOT.x + row * R * Math.sqrt(3) * gap,
        y: (j - row / 2) * 2 * R * gap,
      });
    }
  }
  const order: number[] = new Array(15).fill(0);
  order[4] = 8; // the middle of the third row
  const solids = [1, 2, 3, 4, 5, 6, 7];
  const stripes = [9, 10, 11, 12, 13, 14, 15];
  const take = (arr: number[]): number => arr.splice(Math.floor(rand() * arr.length), 1)[0];
  // A solid and a stripe in the back corners, either way round.
  const flip = rand() < 0.5;
  order[10] = take(flip ? solids : stripes);
  order[14] = take(flip ? stripes : solids);
  const rest = [...solids, ...stripes];
  for (let i = 0; i < 15; i++) {
    if (order[i] !== 0) continue;
    order[i] = take(rest);
  }
  for (let i = 0; i < 15; i++) {
    const b = makeBall(order[i], slots[i].x, slots[i].y);
    b.q = restingPose(rand);
    balls.push(b);
  }
  // Keep ids at their index, which everything else assumes.
  balls.sort((a, b) => a.id - b.id);
  return balls;
}

/**
 * A ball sitting on the cloth with its number roughly facing up, the way a
 * racker leaves them: body x (the number) toward the ceiling, a little tilt,
 * any heading. Identity would show every stripe as a plain white cap.
 */
function restingPose(rand: () => number): [number, number, number, number] {
  const mul = (a: number[], b: number[]): [number, number, number, number] => [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
  const up = [Math.SQRT1_2, 0, -Math.SQRT1_2, 0];
  const ta = rand() * Math.PI * 2;
  const tilt = (rand() - 0.5) * 0.9;
  const qt = [Math.cos(tilt / 2), Math.cos(ta) * Math.sin(tilt / 2), Math.sin(ta) * Math.sin(tilt / 2), 0];
  const yaw = rand() * Math.PI * 2;
  const qy = [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)];
  return mul(qy, mul(qt, up));
}

export function newGame(seed: number, breaker: 0 | 1 = 0): PoolState {
  return {
    balls: rack(seed),
    turn: breaker,
    groups: [null, null],
    phase: "aim",
    isBreak: true,
    ballInHand: true,
    kitchen: true,
    winner: null,
    message: "Your break. Drag the cue ball to place it.",
    called: null,
    shots: 0,
    seq: 0,
  };
}

export function cloneState(s: PoolState): PoolState {
  return { ...s, balls: cloneBalls(s.balls), groups: [s.groups[0], s.groups[1]] };
}

export function remaining(s: PoolState, g: Group): number {
  return s.balls.filter((b) => b.on && groupOf(b.id) === g).length;
}

/** The shooter has cleared their group and is shooting at the 8. */
export function onEight(s: PoolState, player: 0 | 1 = s.turn): boolean {
  const g = s.groups[player];
  return g !== null && remaining(s, g) === 0;
}

/** Which balls the shooter may hit first. */
export function legalTargets(s: PoolState, player: 0 | 1 = s.turn): number[] {
  const g = s.groups[player];
  const on = s.balls.filter((b) => b.on && b.id !== 0);
  if (g === null) return on.filter((b) => b.id !== 8 || s.isBreak).map((b) => b.id);
  if (remaining(s, g) === 0) return [8];
  return on.filter((b) => groupOf(b.id) === g).map((b) => b.id);
}

export interface Outcome {
  foul: string | null;
  /** The shooter keeps the table. */
  again: boolean;
  /** Somebody won on this shot. */
  winner: 0 | 1 | null;
}

/**
 * Apply a finished shot. `before` is the state the shot was played from,
 * `balls` is where everything came to rest, `rec` is what happened on the way.
 */
export function resolveShot(before: PoolState, balls: Ball[], rec: ShotRecord): { state: PoolState; outcome: Outcome } {
  const s = cloneState(before);
  s.balls = cloneBalls(balls);
  s.shots += 1;
  s.seq += 1;
  const me = s.turn;
  const you: 0 | 1 = me === 0 ? 1 : 0;
  const pots = rec.potted.map((p) => p.ball);
  const scratch = pots.includes(0);
  const eight = rec.potted.find((p) => p.ball === 8);
  const objectPots = pots.filter((id) => id !== 0 && id !== 8);
  const wasBreak = before.isBreak;
  const myGroup = before.groups[me];
  const wasOnEight = onEight(before, me);

  // Fouls, first one wins.
  let foul: string | null = null;
  if (scratch) foul = "Scratch";
  else if (rec.firstHit === null) foul = "No ball hit";
  else if (!wasBreak) {
    const legal = legalTargets(before, me);
    if (!legal.includes(rec.firstHit)) {
      foul = rec.firstHit === 8 ? "Hit the 8 first" : "Wrong ball first";
    } else if (pots.length === 0 && !rec.railAfterContact) {
      foul = "No rail after contact";
    }
  }

  const finish = (winner: 0 | 1, message: string) => {
    s.winner = winner;
    s.phase = "over";
    s.message = message;
    s.ballInHand = false;
    s.called = null;
    return { state: s, outcome: { foul, again: false, winner } };
  };

  if (eight) {
    if (wasBreak) {
      // Back on the spot, and the break otherwise stands.
      const b8 = s.balls[8];
      const spot = nearestFree(s.balls.map((b) => (b.id === 8 ? { ...b, on: false } : b)), FOOT_SPOT.x, FOOT_SPOT.y);
      b8.on = true;
      b8.pocket = -1;
      b8.x = spot.x;
      b8.y = spot.y;
    } else if (!wasOnEight) {
      return finish(you, "The 8 went down early");
    } else if (foul) {
      return finish(you, foul === "Scratch" ? "Scratched on the 8" : `Foul on the 8: ${foul.toLowerCase()}`);
    } else if (before.called !== null && eight.pocket !== before.called) {
      return finish(you, "The 8 dropped in the wrong pocket");
    } else {
      return finish(me, "Sank the 8!");
    }
  }

  // Claim a group on an open table.
  let claimed: Group | null = null;
  if (!wasBreak && myGroup === null && !foul && objectPots.length > 0) {
    claimed = groupOf(objectPots[0]);
    if (claimed) {
      s.groups[me] = claimed;
      s.groups[you] = other(claimed);
    }
  }

  const mine = s.groups[me];
  const pottedMine = mine === null ? objectPots.length > 0 : objectPots.some((id) => groupOf(id) === mine);
  const again = !foul && pottedMine;

  s.isBreak = false;
  s.kitchen = false;
  s.called = null;
  s.phase = "aim";
  if (scratch) {
    const c = s.balls[0];
    const spot = nearestFree(s.balls.map((b) => (b.id === 0 ? { ...b, on: false } : b)), HEAD_SPOT.x, HEAD_SPOT.y);
    c.on = true;
    c.pocket = -1;
    c.x = spot.x;
    c.y = spot.y;
  }
  if (!again) s.turn = you;
  s.ballInHand = !!foul;

  const n = objectPots.length;
  if (foul) s.message = `Foul: ${foul.toLowerCase()}. Ball in hand.`;
  else if (claimed) s.message = `${claimed === "solids" ? "Solids" : "Stripes"} it is.`;
  else if (wasBreak) s.message = n > 0 ? `${n} down on the break. The table is open.` : "The table is open.";
  else if (again) s.message = n > 1 ? `${n} down. Keep going.` : "Nice. Keep going.";
  else s.message = n > 0 ? "Only theirs went down." : "Nothing down.";
  return { state: s, outcome: { foul, again, winner: null } };
}

/** Drop a cue ball in hand where the shooter wants it. */
export function placeCue(s: PoolState, x: number, y: number): boolean {
  const spot = nearestFree(s.balls, x, y, s.kitchen);
  s.balls[0].x = spot.x;
  s.balls[0].y = spot.y;
  return true;
}
