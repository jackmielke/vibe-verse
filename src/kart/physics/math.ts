/**
 * Vibe Kart — small numerical helpers for the kart simulation.
 *
 * Everything here is allocation-free and framerate-independent. The simulation
 * runs at a fixed 120 Hz, but the helpers are still written as if dt could
 * vary: a spring that is only stable at one timestep is a spring that explodes
 * the first time somebody changes FIXED_DT.
 *
 * Nothing in this file may return NaN. Every divide is guarded, every square
 * root takes a clamped argument, and `finite()` exists so the step can notice
 * a kart has gone wrong and put it back on the road instead of propagating a
 * NaN into the scene graph — which in Three.js means a silently invisible mesh
 * and an hour of confusion.
 */
import * as THREE from "three";

export const EPS = 1e-6;

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / Math.max(EPS, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Signed magnitude with a dead band — used for stick and slip thresholds. */
export function deadzone(x: number, dz: number): number {
  const a = Math.abs(x);
  if (a <= dz) return 0;
  return Math.sign(x) * ((a - dz) / Math.max(EPS, 1 - dz));
}

/** Wrap into [0,1) — track progress arithmetic lives on this. */
export function wrap01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const y = x % 1;
  return y < 0 ? y + 1 : y;
}

/** Shortest signed difference between two [0,1) progress values. */
export function deltaWrap01(from: number, to: number): number {
  let d = wrap01(to) - wrap01(from);
  if (d > 0.5) d -= 1;
  else if (d < -0.5) d += 1;
  return d;
}

/**
 * Framerate-independent exponential approach. `rate` is the reciprocal time
 * constant: at rate 10 the value covers 63% of the gap in 100 ms regardless of
 * how the frames fell.
 */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-Math.max(0, rate) * dt);
}

/** Move toward a target at a bounded speed — for things that must not overshoot. */
export function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (d > maxDelta) return current + maxDelta;
  if (d < -maxDelta) return current - maxDelta;
  return target;
}

/**
 * Implicit critically-damped spring (Game Programming Gems 4). Unconditionally
 * stable — it cannot ring or explode however large `omega * dt` gets, which
 * matters because the ground-alignment spring is stiff and a single long frame
 * would otherwise flip a kart inside out.
 *
 * Returns the new position and writes the new velocity into `vel[0]`.
 */
export function springStep(
  x: number,
  target: number,
  vel: number[],
  omega: number,
  dt: number,
): number {
  const w = Math.max(0, omega);
  const f = 1 + 2 * dt * w;
  const oo = w * w;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const det = 1 / (f + hhoo);
  const nx = (x * f + vel[0] * dt + target * hhoo) * det;
  const nv = (vel[0] + (target - x) * hoo) * det;
  vel[0] = Number.isFinite(nv) ? nv : 0;
  return Number.isFinite(nx) ? nx : target;
}

const springScratch = [0];

/** The same spring, componentwise on a vector. Mutates `x` and `vel`. */
export function springVec(
  x: THREE.Vector3,
  target: THREE.Vector3,
  vel: THREE.Vector3,
  omega: number,
  dt: number,
): void {
  springScratch[0] = vel.x;
  x.x = springStep(x.x, target.x, springScratch, omega, dt);
  vel.x = springScratch[0];
  springScratch[0] = vel.y;
  x.y = springStep(x.y, target.y, springScratch, omega, dt);
  vel.y = springScratch[0];
  springScratch[0] = vel.z;
  x.z = springStep(x.z, target.z, springScratch, omega, dt);
  vel.z = springScratch[0];
}

/** Normalise in place, falling back to `fallback` if the vector has no length. */
export function safeNormalize(v: THREE.Vector3, fallback: THREE.Vector3): THREE.Vector3 {
  const len = v.length();
  if (!Number.isFinite(len) || len < EPS) return v.copy(fallback);
  return v.multiplyScalar(1 / len);
}

/** Remove any component of `v` along `axis`, then renormalise. */
export function orthonormalize(v: THREE.Vector3, axis: THREE.Vector3, fallback: THREE.Vector3): THREE.Vector3 {
  v.addScaledVector(axis, -v.dot(axis));
  return safeNormalize(v, fallback);
}

export function finite(v: THREE.Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/**
 * Deterministic value noise from an integer. The simulation must produce the
 * same frames for the same inputs — the screenshot harness diffs against it —
 * so kerb rattle and AI trick timing hash a counter rather than calling
 * Math.random.
 */
export function hash01(n: number): number {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x ^= x >>> 15;
  return (x >>> 0) / 0x100000000;
}

/** Smooth 1-D value noise over a continuous coordinate, in [-1,1]. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash01(i * 73856093 + seed);
  const b = hash01((i + 1) * 73856093 + seed);
  const u = f * f * (3 - 2 * f);
  return (a + (b - a) * u) * 2 - 1;
}
