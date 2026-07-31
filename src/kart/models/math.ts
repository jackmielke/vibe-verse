/**
 * Vibe Kart — the small maths kit the rigs animate with.
 *
 * Everything here is frame-rate independent on purpose. A kart racer is played
 * on anything from a 60 Hz laptop to a 144 Hz desktop, and the screenshot
 * harness steps the engine at whatever dt it likes; a `x += (target - x) * 0.2`
 * smoother would give three different amounts of body roll on those three
 * machines. `damp()` is the same curve regardless, which is why it is used for
 * every follow value in this module rather than a raw lerp.
 */

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/**
 * Exponential approach. `lambda` is the rate in "e-folds per second": 10 is a
 * snappy follow, 3 is lazy, 25 is nearly instant. Identical result at any dt,
 * which is the whole reason it exists.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(target, current, Math.exp(-lambda * dt));
}

/** Shortest-path angular damp — stops the head snapping the long way round. */
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  let d = (target - current) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return current + d * (1 - Math.exp(-lambda * dt));
}

/**
 * A critically-damped-ish spring with a stable semi-implicit integrator.
 *
 * Used for the things that must *overshoot*: landing squash, the celebration
 * hop, the trick pop. Easing alone reads as software; a spring reads as
 * animation, and the follow-through is what sells the weight of the kart.
 */
export class Spring {
  value: number;
  velocity = 0;
  constructor(value = 0, public stiffness = 160, public damping = 16) {
    this.value = value;
  }

  step(target: number, dt: number): number {
    // Sub-step long frames: a stiff spring integrated at dt = 1/15 explodes.
    const steps = dt > 1 / 45 ? Math.min(4, Math.ceil(dt * 45)) : 1;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.velocity += (target - this.value) * this.stiffness * h;
      this.velocity -= this.velocity * this.damping * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }

  /** Kick the spring without moving it — how an impact enters the rig. */
  impulse(v: number): void {
    this.velocity += v;
  }

  reset(value = 0): void {
    this.value = value;
    this.velocity = 0;
  }
}

// ---------------------------------------------------------------------------
// Easing — the vocabulary the poses are written in
// ---------------------------------------------------------------------------

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function easeOutBack(t: number): number {
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
}

/** A single hump: 0 at both ends, 1 in the middle. Squash and pop live here. */
export function hump(t: number): number {
  return Math.sin(clamp01(t) * Math.PI);
}

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

export function hashSeed(seed: string | number): number {
  if (typeof seed === "number") return seed >>> 0 || 0x9e3779b9;
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0 || 0x9e3779b9;
}

export type Rng = () => number;

export function makeRng(seed: string | number): Rng {
  let s = hashSeed(seed);
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}
