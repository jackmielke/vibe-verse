/**
 * Vibe Kart — small numeric helpers for the AI.
 *
 * Deliberately duplicated rather than imported from the physics module: no
 * subsystem imports another, and these are four-line functions. The only ones
 * worth a comment are `damp`, which is frame-rate independent where a naive
 * lerp is not, and `arcDelta`, which is the thing that stops every "who is
 * ahead of whom" question from breaking at the start/finish line.
 */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Exponential approach — the same result at 30 fps and at 240. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

/** Move toward a target by at most `maxDelta`; used where a rate limit reads better than a spring. */
export function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (d > maxDelta) return current + maxDelta;
  if (d < -maxDelta) return current - maxDelta;
  return target;
}

export function wrap01(v: number): number {
  const x = v % 1;
  return x < 0 ? x + 1 : x;
}

/**
 * Signed lap-space distance from `b` to `a`, in [-0.5, 0.5). Positive means
 * `a` is ahead. Every overtaking, blocking and shell-range test in this module
 * goes through it, because "0.98 versus 0.01" has to read as *two hundredths
 * ahead*, not as most of a lap behind.
 */
export function arcDelta(a: number, b: number): number {
  let d = (a - b) % 1;
  if (d >= 0.5) d -= 1;
  else if (d < -0.5) d += 1;
  return d;
}

/** Deterministic hash in [0,1) — per-racer salt that survives a page reload. */
export function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x / 4294967296;
}

/**
 * Lap-periodic wander. Two harmonics at integer frequencies so the weave joins
 * itself exactly at the start/finish line instead of stepping sideways there,
 * which is what a raw noise function would do on a closed circuit.
 */
export function wander(t: number, phase: number): number {
  const a = Math.sin(Math.PI * 2 * (3 * t + phase));
  const b = Math.sin(Math.PI * 2 * (7 * t + phase * 1.7 + 0.31));
  return a * 0.62 + b * 0.38;
}
