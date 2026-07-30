/**
 * Deterministic RNG + noise primitives for San Francisco: FREE FALL.
 *
 * Everything in the world is generated, never authored by hand, so every
 * generator has to be *seedable* — the same seed must produce the same city
 * on every machine, every reload, and inside the offline screenshot harness.
 * `Math.random()` is banned everywhere under `src/sf`.
 */

/** xmur3 string hash → 32-bit seed. */
export function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export interface Rng {
  /** [0,1) */
  next(): number;
  /** [min,max) */
  range(min: number, max: number): number;
  /** integer in [min,max] inclusive */
  int(min: number, max: number): number;
  /** true with probability p */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Gaussian-ish, mean 0 stddev 1 (sum of 3 uniforms). */
  gauss(): number;
  /** Fork a decorrelated child stream — lets one system reseed another safely. */
  fork(salt: string): Rng;
}

/** mulberry32 — fast, tiny, good enough distribution for content generation. */
export function makeRng(seed: number | string): Rng {
  let a = typeof seed === "string" ? hashSeed(seed) : seed >>> 0;
  const seedLabel = String(seed);
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length) % items.length],
    gauss: () => (next() + next() + next() - 1.5) * 1.1547,
    fork: (salt) => makeRng(hashSeed(`${seedLabel}:${salt}`)),
  };
  return rng;
}

/* ------------------------------------------------------------------ *
 * Value / gradient noise. Hand-rolled so terrain, textures and shaders
 * can all share the exact same field on CPU and GPU.
 * ------------------------------------------------------------------ */

function hash2(x: number, y: number, seed: number): number {
  let h = seed + Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 2D value noise in [-1,1]. */
export function valueNoise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = fade(xf);
  const v = fade(yf);
  const n00 = hash2(xi, yi, seed);
  const n10 = hash2(xi + 1, yi, seed);
  const n01 = hash2(xi, yi + 1, seed);
  const n11 = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 2 - 1;
}

/** 2D gradient (Perlin-style) noise in roughly [-1,1]. */
export function gradNoise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const grad = (ix: number, iy: number, dx: number, dy: number) => {
    const a = hash2(ix, iy, seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const u = fade(xf);
  const v = fade(yf);
  return lerp(
    lerp(grad(xi, yi, xf, yf), grad(xi + 1, yi, xf - 1, yf), u),
    lerp(grad(xi, yi + 1, xf, yf - 1), grad(xi + 1, yi + 1, xf - 1, yf - 1), u),
    v,
  );
}

/** Fractal Brownian motion over gradient noise. */
export function fbm2(
  x: number,
  y: number,
  octaves = 4,
  lacunarity = 2.0,
  gain = 0.5,
  seed = 0,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += gradNoise2(fx, fy, seed + i * 1013) * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return sum / (norm || 1);
}

/** Ridged multifractal — for rock, cliff faces and cloud silhouettes. */
export function ridged2(x: number, y: number, octaves = 4, seed = 0): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += (1 - Math.abs(gradNoise2(fx, fy, seed + i * 7919))) * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2.03;
    fy *= 2.03;
  }
  return sum / (norm || 1);
}

/** Worley / cellular noise. Returns { f1, f2, id } — f1 is distance to nearest. */
export function worley2(
  x: number,
  y: number,
  seed = 0,
): { f1: number; f2: number; id: number } {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = Infinity;
  let f2 = Infinity;
  let id = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = xi + ox;
      const cy = yi + oy;
      const px = cx + hash2(cx, cy, seed);
      const py = cy + hash2(cx, cy, seed + 977);
      const dx = px - x;
      const dy = py - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663);
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return { f1, f2, id: id >>> 0 };
}

/* ------------------------------------------------------------------ *
 * Small math helpers shared by every subsystem.
 * ------------------------------------------------------------------ */

export const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

export const clamp01 = (v: number) => clamp(v, 0, 1);

export const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
};

export const mix = lerp;

/** Frame-rate independent exponential smoothing. `rate` ≈ 1/seconds. */
export const damp = (current: number, target: number, rate: number, dt: number) =>
  target + (current - target) * Math.exp(-rate * dt);
