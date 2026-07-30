/**
 * textureGen — the procedural texture foundry for San Francisco: FREE FALL.
 *
 * There are no image assets in this game. Every texel of every surface is
 * computed here at startup, cached, and shared. That is a deliberate trade:
 * we spend a second of CPU at load so we never spend a megabyte of download,
 * and in exchange we get textures that can be parameterised per district, per
 * building and per weather state instead of being frozen at bake time.
 *
 * Design notes that matter if you are extending this file:
 *
 * 1. **Everything tiles.** Every noise primitive here is evaluated on a
 *    *periodic* integer lattice whose period divides the texture exactly, so
 *    the left edge is genuinely continuous with the right edge — no
 *    cross-fade, no mirror, no seam. `src/sf/math/rng.ts` gives us the seeded
 *    RNG (which we use, because determinism is mandatory) but its noise
 *    functions are aperiodic, so the lattice evaluators are re-implemented
 *    here with wrap-aware indexing.
 *
 * 2. **Octave upsampling.** A five-octave fbm at 1024² evaluated per-pixel is
 *    ~300 M operations and takes the better part of a second in JS. Instead
 *    each octave is rendered into a buffer just large enough to resolve its
 *    own lattice (period × 6) and bilinearly accumulated into the target.
 *    Low-frequency octaves therefore cost almost nothing, and the result is
 *    visually identical because the octave is already band-limited at that
 *    scale. This is the single reason a full material library builds in
 *    ~2 s instead of ~30 s.
 *
 * 3. **Row 0 is the top.** All `Field`s are laid out top-down, like a canvas,
 *    because that is how a human reasons about "streaks run down the wall".
 *    The texture writers flip vertically on output and leave `flipY = false`
 *    on the resulting DataTexture, which is the only combination that is
 *    reliable for data uploads across drivers.
 *
 * 4. **ORM packing.** three samples ao from `.r`, roughness from `.g` and
 *    metalness from `.b`. We honour that convention exactly and ship a single
 *    packed texture bound to all three slots — one upload, one fetch, three
 *    maps.
 */
import * as THREE from "three";
import { clamp01, hashSeed, makeRng, smoothstep, type Rng } from "../math/rng";

/* ================================================================== *
 * Types
 * ================================================================== */

/** A single-channel image, `size * size` floats, row 0 = top. */
export type Field = Float32Array;

/** RGBA byte raster, `size * size * 4`, row 0 = top. */
export type Raster = Uint8Array;

export type Ctx2D = CanvasRenderingContext2D;

export interface Surface {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: Ctx2D;
  width: number;
  height: number;
}

/* ================================================================== *
 * Canvas plumbing
 * ================================================================== */

let preferOffscreen = true;

/**
 * OffscreenCanvas is faster and keeps generation off the DOM, but a handful of
 * embedded webviews still lie about supporting it. Exposed so the harness (or
 * a bug report) can force the DOM path.
 */
export function setPreferOffscreenCanvas(v: boolean): void {
  preferOffscreen = v;
}

export function makeSurface(width: number, height = width): Surface {
  let canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  if (preferOffscreen && typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(width, height);
  } else if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    canvas = c;
  }
  if (!canvas) throw new Error("[sf/materials] no canvas implementation available");
  // willReadFrequently matters: we always read these back with getImageData,
  // and without the hint Chrome keeps the surface GPU-side and every read is a
  // full pipeline stall.
  const ctx = (canvas as HTMLCanvasElement).getContext("2d", {
    willReadFrequently: true,
    alpha: true,
  }) as unknown as Ctx2D;
  if (!ctx) throw new Error("[sf/materials] 2D context unavailable");
  return { canvas, ctx, width, height };
}

/** Read a surface back as an RGBA raster (row 0 = top). */
export function surfaceToRaster(s: Surface): Raster {
  const img = s.ctx.getImageData(0, 0, s.width, s.height);
  return new Uint8Array(img.data.buffer.slice(0));
}

/** Read one channel of a surface as a 0..1 field. */
export function surfaceToField(s: Surface, channel: 0 | 1 | 2 | 3 = 0): Field {
  const img = s.ctx.getImageData(0, 0, s.width, s.height);
  const d = img.data;
  const n = s.width * s.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = d[i * 4 + channel] / 255;
  return out;
}

/* ================================================================== *
 * Periodic lattice noise
 * ================================================================== */

interface LatticeTable {
  px: number;
  py: number;
  g: Float32Array;
}

const latticeCache = new Map<string, LatticeTable>();

function latticeTable(px: number, py: number, seed: number): LatticeTable {
  const key = `${px}x${py}:${seed}`;
  const hit = latticeCache.get(key);
  if (hit) return hit;
  // Keep the cache bounded — a long session with many districts can otherwise
  // accumulate thousands of tables.
  if (latticeCache.size > 512) latticeCache.clear();
  const rng = makeRng(seed >>> 0);
  const g = new Float32Array(px * py * 2);
  for (let i = 0; i < px * py; i++) {
    const a = rng.next() * Math.PI * 2;
    g[i * 2] = Math.cos(a);
    g[i * 2 + 1] = Math.sin(a);
  }
  const t: LatticeTable = { px, py, g };
  latticeCache.set(key, t);
  return t;
}

const scratchCache = new Map<number, Float32Array>();
function scratch(n: number): Float32Array {
  let s = scratchCache.get(n);
  if (!s) {
    s = new Float32Array(n * n);
    scratchCache.set(n, s);
  }
  return s;
}

/** 0 = signed gradient noise, 1 = ridged, 2 = billow. */
type NoiseMode = 0 | 1 | 2;

/**
 * Render one periodic gradient-noise octave into `out` (side `tile`), where
 * the image spans exactly `px × py` lattice cells and therefore tiles.
 */
function noiseTile(
  out: Float32Array,
  tile: number,
  px: number,
  py: number,
  g: Float32Array,
  mode: NoiseMode,
): void {
  const SQRT2 = 1.41421356;
  for (let y = 0; y < tile; y++) {
    const fy = (y / tile) * py;
    const yi = Math.floor(fy);
    const yf = fy - yi;
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const y0 = ((yi % py) + py) % py;
    const y1 = y0 + 1 === py ? 0 : y0 + 1;
    const r0 = y0 * px;
    const r1 = y1 * px;
    const rowBase = y * tile;
    for (let x = 0; x < tile; x++) {
      const fx = (x / tile) * px;
      const xi = Math.floor(fx);
      const xf = fx - xi;
      const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
      const x0 = ((xi % px) + px) % px;
      const x1 = x0 + 1 === px ? 0 : x0 + 1;
      const i00 = (r0 + x0) * 2;
      const i10 = (r0 + x1) * 2;
      const i01 = (r1 + x0) * 2;
      const i11 = (r1 + x1) * 2;
      const xf1 = xf - 1;
      const yf1 = yf - 1;
      const n00 = g[i00] * xf + g[i00 + 1] * yf;
      const n10 = g[i10] * xf1 + g[i10 + 1] * yf;
      const n01 = g[i01] * xf + g[i01 + 1] * yf1;
      const n11 = g[i11] * xf1 + g[i11 + 1] * yf1;
      const a = n00 + (n10 - n00) * u;
      const b = n01 + (n11 - n01) * u;
      let n = (a + (b - a) * v) * SQRT2;
      if (mode === 1) n = 1 - Math.abs(n);
      else if (mode === 2) n = Math.abs(n) * 2 - 1;
      out[rowBase + x] = n;
    }
  }
}

/** Bilinear, wrap-aware accumulate of a small tile into a larger field. */
function upsampleAdd(
  dst: Float32Array,
  dstSize: number,
  src: Float32Array,
  srcSize: number,
  amp: number,
): void {
  if (srcSize === dstSize) {
    for (let i = 0, n = dst.length; i < n; i++) dst[i] += src[i] * amp;
    return;
  }
  const s = srcSize / dstSize;
  for (let y = 0; y < dstSize; y++) {
    const fy = (y + 0.5) * s - 0.5;
    const yi = Math.floor(fy);
    const ty = fy - yi;
    const ya = ((yi % srcSize) + srcSize) % srcSize;
    const yb = ya + 1 === srcSize ? 0 : ya + 1;
    const ra = ya * srcSize;
    const rb = yb * srcSize;
    const row = y * dstSize;
    for (let x = 0; x < dstSize; x++) {
      const fx = (x + 0.5) * s - 0.5;
      const xi = Math.floor(fx);
      const tx = fx - xi;
      const xa = ((xi % srcSize) + srcSize) % srcSize;
      const xb = xa + 1 === srcSize ? 0 : xa + 1;
      const v00 = src[ra + xa];
      const v10 = src[ra + xb];
      const v01 = src[rb + xa];
      const v11 = src[rb + xb];
      const a = v00 + (v10 - v00) * tx;
      const b = v01 + (v11 - v01) * tx;
      dst[row + x] += (a + (b - a) * ty) * amp;
    }
  }
}

/** How many pixels we resolve per lattice cell before falling back to full res. */
const OVERSAMPLE = 6;

export interface NoiseOpts {
  /** Lattice cells across the texture at octave 0. Number, or [x, y] for anisotropy. */
  period?: number | [number, number];
  octaves?: number;
  lacunarity?: number;
  gain?: number;
  seed?: number | string;
  kind?: "fbm" | "ridged" | "billow";
  /** "unit" (default) maps to 0..1, "signed" leaves it around -1..1. */
  range?: "unit" | "signed";
}

/**
 * Tileable fractal noise. This is the workhorse — nearly every field in the
 * library starts life here.
 */
export function fbmField(size: number, o: NoiseOpts = {}): Field {
  const octaves = Math.max(1, o.octaves ?? 4);
  const lac = o.lacunarity ?? 2;
  const gain = o.gain ?? 0.5;
  const seed = typeof o.seed === "string" ? hashSeed(o.seed) : (o.seed ?? 1) >>> 0;
  const p = o.period ?? 4;
  const px0 = Array.isArray(p) ? p[0] : p;
  const py0 = Array.isArray(p) ? p[1] : p;
  const mode: NoiseMode = o.kind === "ridged" ? 1 : o.kind === "billow" ? 2 : 0;

  const out = new Float32Array(size * size);
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const f = Math.pow(lac, i);
    const cx = Math.max(1, Math.round(px0 * f));
    const cy = Math.max(1, Math.round(py0 * f));
    const tile = Math.min(size, Math.max(8, Math.max(cx, cy) * OVERSAMPLE));
    const tmp = scratch(tile);
    noiseTile(tmp, tile, cx, cy, latticeTable(cx, cy, seed + i * 7919).g, mode);
    upsampleAdd(out, size, tmp, tile, amp);
    norm += amp;
    amp *= gain;
  }
  const inv = 1 / (norm || 1);
  if (o.range === "signed") {
    for (let i = 0; i < out.length; i++) out[i] *= inv;
  } else if (mode === 1) {
    // Ridged already lands in 0..1; just normalise the octave sum.
    for (let i = 0; i < out.length; i++) out[i] = clamp01(out[i] * inv);
  } else {
    for (let i = 0; i < out.length; i++) out[i] = clamp01(out[i] * inv * 0.5 + 0.5);
  }
  return out;
}

/** Convenience: tileable ridged multifractal (cliffs, veins, fibres). */
export function ridgedField(size: number, o: NoiseOpts = {}): Field {
  return fbmField(size, { ...o, kind: "ridged" });
}

/** Per-pixel white noise. Deterministic in scan order — used for grain/speckle. */
export function whiteNoiseField(size: number, seed: number | string = 0): Field {
  const rng = makeRng(typeof seed === "string" ? seed : seed >>> 0);
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = rng.next();
  return out;
}

/* ================================================================== *
 * Worley / cellular
 * ================================================================== */

export interface WorleyOpts {
  /** Cells across the texture. Number or [x, y]. */
  period?: number | [number, number];
  seed?: number | string;
  /** 0 = perfect grid, 1 = fully jittered. */
  jitter?: number;
  metric?: "euclid" | "manhattan" | "chebyshev";
}

export interface WorleyResult {
  /** Distance to nearest feature point, in cell units. */
  f1: Field;
  /** Distance to second-nearest — `f2 - f1` is the classic crack/edge mask. */
  f2: Field;
  /** A stable 0..1 random value per cell — patch tone, per-brick colour, etc. */
  cell: Field;
}

/**
 * Tileable Worley noise. Feature points live on a wrapped `px × py` grid so
 * the cells continue across the seam.
 */
export function worleyField(size: number, o: WorleyOpts = {}): WorleyResult {
  const p = o.period ?? 6;
  const px = Math.max(1, Math.round(Array.isArray(p) ? p[0] : p));
  const py = Math.max(1, Math.round(Array.isArray(p) ? p[1] : p));
  const jitter = o.jitter ?? 1;
  const seed = typeof o.seed === "string" ? hashSeed(o.seed) : (o.seed ?? 3) >>> 0;
  const rng = makeRng(seed);

  const ptx = new Float32Array(px * py);
  const pty = new Float32Array(px * py);
  const rndv = new Float32Array(px * py);
  for (let cy = 0; cy < py; cy++) {
    for (let cx = 0; cx < px; cx++) {
      const i = cy * px + cx;
      ptx[i] = cx + 0.5 + (rng.next() - 0.5) * jitter;
      pty[i] = cy + 0.5 + (rng.next() - 0.5) * jitter;
      rndv[i] = rng.next();
    }
  }

  const f1 = new Float32Array(size * size);
  const f2 = new Float32Array(size * size);
  const cell = new Float32Array(size * size);
  const metric = o.metric ?? "euclid";

  for (let y = 0; y < size; y++) {
    const gy = (y / size) * py;
    const cy0 = Math.floor(gy);
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * px;
      const cx0 = Math.floor(gx);
      let best = 1e9;
      let second = 1e9;
      let bestId = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const wy = ((cy0 + oy) % py + py) % py;
        const shiftY = cy0 + oy - wy;
        for (let ox = -1; ox <= 1; ox++) {
          const wx = ((cx0 + ox) % px + px) % px;
          const shiftX = cx0 + ox - wx;
          const i = wy * px + wx;
          const dx = ptx[i] + shiftX - gx;
          const dy = pty[i] + shiftY - gy;
          let d: number;
          if (metric === "manhattan") d = Math.abs(dx) + Math.abs(dy);
          else if (metric === "chebyshev") d = Math.max(Math.abs(dx), Math.abs(dy));
          else d = Math.sqrt(dx * dx + dy * dy);
          if (d < best) {
            second = best;
            best = d;
            bestId = i;
          } else if (d < second) {
            second = d;
          }
        }
      }
      f1[row + x] = best;
      f2[row + x] = second;
      cell[row + x] = rndv[bestId];
    }
  }
  return { f1, f2, cell };
}

/* ================================================================== *
 * Field arithmetic
 *
 * Deliberately plain loops over Float32Array. Anything fancier (a small
 * expression compiler, chained lazy ops) measured slower and read worse.
 * ================================================================== */

export function fieldOf(size: number, v = 0): Field {
  const f = new Float32Array(size * size);
  if (v !== 0) f.fill(v);
  return f;
}

export function copyField(a: Field): Field {
  return new Float32Array(a);
}

/** out = a * s + b */
export function scaleBias(a: Field, s: number, b: number, out = a): Field {
  for (let i = 0; i < a.length; i++) out[i] = a[i] * s + b;
  return out;
}

export function addField(a: Field, b: Field, k = 1, out = a): Field {
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i] * k;
  return out;
}

export function mulField(a: Field, b: Field, out = a): Field {
  for (let i = 0; i < a.length; i++) out[i] = a[i] * b[i];
  return out;
}

/** out = a + (b - a) * t, where t may be a field or a constant. */
export function mixField(a: Field, b: Field, t: Field | number, out = a): Field {
  if (typeof t === "number") {
    for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  } else {
    for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t[i];
  }
  return out;
}

export function clampField(a: Field, lo = 0, hi = 1, out = a): Field {
  for (let i = 0; i < a.length; i++) out[i] = a[i] < lo ? lo : a[i] > hi ? hi : a[i];
  return out;
}

export function powField(a: Field, e: number, out = a): Field {
  for (let i = 0; i < a.length; i++) out[i] = Math.pow(a[i] < 0 ? 0 : a[i], e);
  return out;
}

export function invertField(a: Field, out = a): Field {
  for (let i = 0; i < a.length; i++) out[i] = 1 - a[i];
  return out;
}

/** Smoothstep remap — the workhorse for turning a noise field into a mask. */
export function thresholdField(a: Field, lo: number, hi: number, out = a): Field {
  const inv = 1 / (hi - lo || 1e-6);
  for (let i = 0; i < a.length; i++) {
    const t = clamp01((a[i] - lo) * inv);
    out[i] = t * t * (3 - 2 * t);
  }
  return out;
}

/** Push values away from `pivot`. `amount` > 1 increases contrast. */
export function contrastField(a: Field, amount: number, pivot = 0.5, out = a): Field {
  for (let i = 0; i < a.length; i++) out[i] = pivot + (a[i] - pivot) * amount;
  return out;
}

export function fieldRange(a: Field): { min: number; max: number; mean: number } {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, mean: sum / (a.length || 1) };
}

/** Rescale to exactly 0..1. */
export function normalizeField(a: Field, out = a): Field {
  const { min, max } = fieldRange(a);
  const inv = 1 / (max - min || 1e-6);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] - min) * inv;
  return out;
}

/** Bilinear sample with wrapping — coordinates in pixels. */
export function sampleWrap(a: Field, size: number, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = x - xi;
  const ty = y - yi;
  const x0 = ((xi % size) + size) % size;
  const y0 = ((yi % size) + size) % size;
  const x1 = x0 + 1 === size ? 0 : x0 + 1;
  const y1 = y0 + 1 === size ? 0 : y0 + 1;
  const r0 = y0 * size;
  const r1 = y1 * size;
  const v00 = a[r0 + x0];
  const v10 = a[r0 + x1];
  const v01 = a[r1 + x0];
  const v11 = a[r1 + x1];
  const p = v00 + (v10 - v00) * tx;
  const q = v01 + (v11 - v01) * tx;
  return p + (q - p) * ty;
}

/** Separable wrapping box blur. Three passes approximate a Gaussian well. */
export function blurField(a: Field, size: number, radius: number, passes = 2): Field {
  const r = Math.max(1, Math.round(radius));
  let src = new Float32Array(a);
  let dst = new Float32Array(a.length);
  const w = 2 * r + 1;
  const inv = 1 / w;
  for (let p = 0; p < passes; p++) {
    // horizontal
    for (let y = 0; y < size; y++) {
      const row = y * size;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[row + (((k % size) + size) % size)];
      for (let x = 0; x < size; x++) {
        dst[row + x] = sum * inv;
        const outIdx = ((x - r) % size + size) % size;
        const inIdx = ((x + r + 1) % size + size) % size;
        sum += src[row + inIdx] - src[row + outIdx];
      }
    }
    const t0 = src;
    src = dst;
    dst = t0;
    // vertical
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[(((k % size) + size) % size) * size + x];
      for (let y = 0; y < size; y++) {
        dst[y * size + x] = sum * inv;
        const outIdx = ((y - r) % size + size) % size;
        const inIdx = ((y + r + 1) % size + size) % size;
        sum += src[inIdx * size + x] - src[outIdx * size + x];
      }
    }
    const t1 = src;
    src = dst;
    dst = t1;
  }
  return src;
}

/**
 * Domain warp: resample `src` with an offset driven by two 0..1 fields.
 * This is what turns "obviously noise" into "obviously a material" — troweled
 * stucco, marble veining and rust fronts all depend on it.
 */
export function warpField(
  src: Field,
  size: number,
  wx: Field,
  wy: Field,
  amount: number,
): Field {
  const out = new Float32Array(src.length);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const i = row + x;
      out[i] = sampleWrap(src, size, x + (wx[i] - 0.5) * amount, y + (wy[i] - 0.5) * amount);
    }
  }
  return out;
}

/**
 * Cross-fade the edges of a field into each other. Everything generated in
 * this module is already periodic, so this exists purely as a guarantee for
 * fields that came from somewhere else (a hand-drawn canvas, an imported
 * pattern) and must be made safe to tile.
 */
export function makeSeamless(a: Field, size: number, band = Math.round(size * 0.08)): Field {
  const out = new Float32Array(a);
  const b = Math.max(1, band);
  for (let y = 0; y < size; y++) {
    for (let i = 0; i < b; i++) {
      const t = smoothstep(0, 1, i / b) * 0.5;
      const left = y * size + i;
      const right = y * size + (size - 1 - i);
      const l = a[left];
      const r = a[right];
      out[left] = l + (r - l) * (0.5 - t);
      out[right] = r + (l - r) * (0.5 - t);
    }
  }
  const tmp = new Float32Array(out);
  for (let x = 0; x < size; x++) {
    for (let i = 0; i < b; i++) {
      const t = smoothstep(0, 1, i / b) * 0.5;
      const top = i * size + x;
      const bot = (size - 1 - i) * size + x;
      const u = tmp[top];
      const d = tmp[bot];
      out[top] = u + (d - u) * (0.5 - t);
      out[bot] = d + (u - d) * (0.5 - t);
    }
  }
  return out;
}

/* ================================================================== *
 * Derived maps: normal, AO, curvature, roughness
 * ================================================================== */

/**
 * Sobel normal-from-height, wrap-aware.
 *
 * `strength` is in "height units per pixel" — a height field in 0..1 with
 * strength 1 gives a fairly aggressive surface, which is usually what you
 * want for brick mortar and far too much for stucco.
 */
export function normalFromHeight(height: Field, size: number, strength = 1): Raster {
  const out = new Uint8Array(size * size * 4);
  const k = strength * size * 0.0125;
  for (let y = 0; y < size; y++) {
    const ym = ((y - 1 + size) % size) * size;
    const y0 = y * size;
    const yp = ((y + 1) % size) * size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const h00 = height[ym + xm];
      const h10 = height[ym + x];
      const h20 = height[ym + xp];
      const h01 = height[y0 + xm];
      const h21 = height[y0 + xp];
      const h02 = height[yp + xm];
      const h12 = height[yp + x];
      const h22 = height[yp + xp];
      const dx = h20 + 2 * h21 + h22 - (h00 + 2 * h01 + h02);
      const dy = h02 + 2 * h12 + h22 - (h00 + 2 * h10 + h20);
      let nx = -dx * k;
      let ny = dy * k;
      const nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= len;
      ny /= len;
      const i = (y0 + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

export interface AoOpts {
  /** Blur radii, in pixels, of the cavity scales that are combined. */
  radii?: number[];
  weights?: number[];
  /** Overall darkening exponent. */
  strength?: number;
  /** Height amplitude of the field; used to normalise the cavity term. */
  amplitude?: number;
}

/**
 * Cheap AO from a height field.
 *
 * A proper horizon-scan AO at 1024² is tens of millions of samples and we
 * cannot afford it for thirty materials at load. What we can afford — and what
 * offline bakers approximate anyway at low ray counts — is a multi-scale
 * cavity term: height minus a blurred height, at three radii, multiplied
 * together. Small radii catch mortar joints and pores, large radii catch the
 * fact that the middle of a recessed panel is darker than its edge. The result
 * is visually indistinguishable from baked AO on tiling materials, and it
 * costs three box blurs.
 */
export function aoFromHeight(height: Field, size: number, o: AoOpts = {}): Field {
  const radii = o.radii ?? [Math.max(1, size / 256), Math.max(2, size / 64), Math.max(4, size / 16)];
  const weights = o.weights ?? [0.5, 0.34, 0.24];
  const strength = o.strength ?? 1;
  const n = size * size;
  const ao = new Float32Array(n).fill(1);

  for (let s = 0; s < radii.length; s++) {
    const b = blurField(height, size, radii[s], 2);
    // Self-normalising: measure the cavity spread at this scale so the term
    // behaves the same whether the height field is 0..1 or 0..0.02.
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const d = height[i] - b[i];
      acc += d * d;
    }
    const sd = Math.sqrt(acc / n) || 1e-5;
    const gain = (o.amplitude ? 0.5 / o.amplitude : 0.55 / sd) * weights[s];
    for (let i = 0; i < n; i++) {
      const occ = clamp01(0.5 + (height[i] - b[i]) * gain + (1 - weights[s]) * 0.5);
      ao[i] *= 0.35 + 0.65 * clamp01(occ * 1.15);
    }
  }
  // Re-expand so the average surface sits near white; AO should darken
  // crevices, not the whole material.
  const { max } = fieldRange(ao);
  const inv = 1 / (max || 1);
  for (let i = 0; i < n; i++) ao[i] = Math.pow(clamp01(ao[i] * inv), strength);
  return ao;
}

/**
 * Signed curvature: >0 on convex ridges (where paint chips and edges polish),
 * <0 in concave crevices (where grime collects). Output is remapped to 0..1
 * with 0.5 = flat, which is the form both wear masks want.
 */
export function curvatureFromHeight(height: Field, size: number, radius = 2): Field {
  const b = blurField(height, size, radius, 2);
  const n = size * size;
  const out = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = height[i] - b[i];
    out[i] = d;
    acc += d * d;
  }
  const sd = Math.sqrt(acc / n) || 1e-5;
  const g = 0.5 / (sd * 3);
  for (let i = 0; i < n; i++) out[i] = clamp01(0.5 + out[i] * g);
  return out;
}

/** Convex edge-wear mask: 1 where an edge is proud enough to be rubbed bare. */
export function edgeWearMask(height: Field, size: number, radius = 2, bias = 0.58): Field {
  const c = curvatureFromHeight(height, size, radius);
  return thresholdField(c, bias, Math.min(0.98, bias + 0.28));
}

/** Concave grime mask: 1 deep in the crevices. */
export function cavityMask(height: Field, size: number, radius = 3, bias = 0.44): Field {
  const c = curvatureFromHeight(height, size, radius);
  invertField(c);
  return thresholdField(c, 1 - bias, Math.min(0.99, 1 - bias + 0.3));
}

/* ================================================================== *
 * Wear, weathering and dirt
 * ================================================================== */

export interface StreakOpts {
  count?: number;
  seed?: number | string;
  /** Where streaks start, as a 0..1 row fraction (0 = top). */
  startMin?: number;
  startMax?: number;
  /** Run length as a fraction of the texture height. */
  lengthMin?: number;
  lengthMax?: number;
  /** Streak half-width as a fraction of the texture width. */
  widthMin?: number;
  widthMax?: number;
  strength?: number;
  /** Sideways wander over the run, in pixels. */
  wander?: number;
  /** Falloff exponent along the run. */
  fade?: number;
}

/**
 * Gravity-driven vertical drips.
 *
 * This is the highest-value weathering effect there is: rain running off a
 * sill, a cornice or a window head and leaving a dark tail is what makes a
 * wall look like it has stood outside for eighty years. It is also directional
 * — the streaks *must* run down, which means the caller has to know which way
 * is up, which is why the whole module keeps row 0 at the top.
 */
export function streakField(size: number, o: StreakOpts = {}): Field {
  const rng = makeRng(o.seed ?? "streaks");
  const count = o.count ?? Math.round(size / 8);
  const out = new Float32Array(size * size);
  const startMin = o.startMin ?? 0;
  const startMax = o.startMax ?? 0.35;
  const lenMin = (o.lengthMin ?? 0.15) * size;
  const lenMax = (o.lengthMax ?? 0.7) * size;
  const wMin = Math.max(0.6, (o.widthMin ?? 0.004) * size);
  const wMax = Math.max(1.2, (o.widthMax ?? 0.02) * size);
  const strength = o.strength ?? 1;
  const wander = o.wander ?? size * 0.01;
  const fade = o.fade ?? 1.6;
  // A cheap 1D noise for the wander, sampled per row.
  const wobble = fbmField(size, { period: 6, octaves: 3, seed: rng.next() * 1e6, range: "signed" });

  for (let s = 0; s < count; s++) {
    const cx = rng.next() * size;
    const y0 = (startMin + rng.next() * (startMax - startMin)) * size;
    const len = lenMin + rng.next() * (lenMax - lenMin);
    const hw = wMin + rng.next() * (wMax - wMin);
    const inten = strength * (0.25 + rng.next() * 0.75);
    const wobRow = Math.floor(rng.next() * size);
    for (let dy = 0; dy < len; dy++) {
      const y = Math.floor(y0 + dy);
      if (y < 0) continue;
      const yy = y % size;
      const t = dy / len;
      // Drips are strongest just under the ledge and taper to nothing.
      const along = Math.pow(1 - t, fade) * (0.55 + 0.45 * Math.pow(1 - t, 0.3));
      const wob = wobble[((wobRow + y) % size) * size + (Math.floor(cx) % size)] * wander * t;
      const c = cx + wob;
      const w = hw * (0.7 + t * 0.9);
      const x0 = Math.floor(c - w);
      const x1 = Math.ceil(c + w);
      const row = yy * size;
      for (let x = x0; x <= x1; x++) {
        const d = Math.abs(x - c) / w;
        if (d > 1) continue;
        const a = along * inten * Math.pow(1 - d, 1.5);
        const xi = ((x % size) + size) % size;
        if (a > out[row + xi]) out[row + xi] = a;
      }
    }
  }
  // Soften across, not along — a drip is sharp vertically and soft laterally.
  const soft = blurField(out, size, Math.max(1, size / 512), 1);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i], soft[i] * 0.85);
  return clampField(out, 0, 1);
}

export interface StainOpts {
  count?: number;
  seed?: number | string;
  radiusMin?: number;
  radiusMax?: number;
  strength?: number;
  /** How irregular the blob outline is, 0..1. */
  raggedness?: number;
}

/** Soft irregular blotches — oil, water staining, mildew, soot. */
export function stainField(size: number, o: StainOpts = {}): Field {
  const rng = makeRng(o.seed ?? "stains");
  const count = o.count ?? 14;
  const rMin = (o.radiusMin ?? 0.03) * size;
  const rMax = (o.radiusMax ?? 0.14) * size;
  const strength = o.strength ?? 1;
  const ragged = o.raggedness ?? 0.55;
  const out = new Float32Array(size * size);
  const edge = fbmField(size, { period: 10, octaves: 4, seed: rng.next() * 1e6 });

  for (let s = 0; s < count; s++) {
    const cx = rng.next() * size;
    const cy = rng.next() * size;
    const r = rMin + rng.next() * (rMax - rMin);
    const inten = strength * (0.35 + rng.next() * 0.65);
    const ext = Math.ceil(r * 1.6);
    for (let dy = -ext; dy <= ext; dy++) {
      const y = ((Math.floor(cy + dy) % size) + size) % size;
      const row = y * size;
      for (let dx = -ext; dx <= ext; dx++) {
        const x = ((Math.floor(cx + dx) % size) + size) % size;
        const d = Math.sqrt(dx * dx + dy * dy) / r;
        const wobbled = d * (1 - ragged * 0.5 + edge[row + x] * ragged);
        if (wobbled > 1) continue;
        const a = inten * Math.pow(1 - wobbled, 1.7);
        if (a > out[row + x]) out[row + x] = a;
      }
    }
  }
  return clampField(out, 0, 1);
}

export interface CrackOpts {
  seed?: number | string;
  /** Cells across the texture — larger = finer crack network. */
  period?: number | [number, number];
  /** Crack width in cell units. */
  width?: number;
  /** Regional mask frequency — cracks cluster, they do not cover evenly. */
  clumpPeriod?: number;
  /** 0..1 fraction of the surface that is cracked at all. */
  coverage?: number;
  /** Add a second, finer network on top. */
  detail?: boolean;
}

/**
 * Crack networks from Worley cell boundaries. `f2 - f1` is zero exactly on the
 * boundary between two cells, so thresholding it gives a connected network of
 * lines that looks like real settlement cracking rather than scribbled noise.
 */
export function crackField(size: number, o: CrackOpts = {}): Field {
  const seedStr = String(o.seed ?? "cracks");
  const w = o.width ?? 0.035;
  const { f1, f2 } = worleyField(size, {
    period: o.period ?? 7,
    seed: seedStr,
    jitter: 0.9,
  });
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) {
    const e = f2[i] - f1[i];
    out[i] = 1 - smoothstep(0, w, e);
  }
  if (o.detail) {
    const d = worleyField(size, {
      period: Array.isArray(o.period) ? [o.period[0] * 3, o.period[1] * 3] : (o.period ?? 7) * 3,
      seed: seedStr + ":fine",
      jitter: 0.95,
    });
    for (let i = 0; i < out.length; i++) {
      const e = d.f2[i] - d.f1[i];
      out[i] = Math.max(out[i], (1 - smoothstep(0, w * 1.6, e)) * 0.55);
    }
  }
  // Cracks cluster around structural weak points instead of covering evenly.
  const clump = fbmField(size, {
    period: o.clumpPeriod ?? 3,
    octaves: 3,
    seed: seedStr + ":clump",
  });
  const cov = o.coverage ?? 0.45;
  thresholdField(clump, 1 - cov - 0.2, 1 - cov + 0.25);
  return mulField(out, clump);
}

export interface PatchOpts {
  seed?: number | string;
  period?: number | [number, number];
  /** Fraction of cells that are patched. */
  coverage?: number;
  /** Softness of the patch boundary, in cell units. */
  feather?: number;
}

/**
 * Patchy repair — the tar-band over a trench in asphalt, the replaced course
 * of brick, the render patch on a stucco wall. Returns a coverage mask and a
 * per-patch tone offset so each patch is a different age.
 */
export function patchField(
  size: number,
  o: PatchOpts = {},
): { mask: Field; tone: Field; edge: Field } {
  const { f1, f2, cell } = worleyField(size, {
    period: o.period ?? 3,
    seed: o.seed ?? "patch",
    jitter: 1,
  });
  const coverage = o.coverage ?? 0.3;
  const feather = o.feather ?? 0.06;
  const mask = new Float32Array(size * size);
  const tone = new Float32Array(size * size);
  const edge = new Float32Array(size * size);
  for (let i = 0; i < mask.length; i++) {
    const inPatch = cell[i] < coverage ? 1 : 0;
    // Feather using distance to the cell boundary so patches have soft, slightly
    // irregular edges rather than hard Voronoi walls.
    const boundary = smoothstep(0, feather, f2[i] - f1[i]);
    mask[i] = inPatch * boundary;
    tone[i] = cell[i] / Math.max(coverage, 1e-3);
    edge[i] = inPatch * (1 - boundary);
  }
  return { mask, tone, edge };
}

/**
 * Grime accumulation: dirt that settles where the surface is concave, near the
 * base of a wall, and wherever water has been sitting. Combines a cavity term
 * with a low-frequency dirt field and an optional downward gradient.
 */
export function grimeField(
  height: Field,
  size: number,
  o: { seed?: number | string; cavityRadius?: number; baseBias?: number; amount?: number } = {},
): Field {
  const cav = cavityMask(height, size, o.cavityRadius ?? 3, 0.42);
  const blotch = fbmField(size, { period: 4, octaves: 5, seed: o.seed ?? "grime" });
  thresholdField(blotch, 0.35, 0.85);
  const out = new Float32Array(size * size);
  const baseBias = o.baseBias ?? 0;
  const amount = o.amount ?? 1;
  for (let y = 0; y < size; y++) {
    // Grime is heaviest at the foot of a wall where splash-back happens.
    const down = baseBias * Math.pow(y / (size - 1), 2.2);
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const i = row + x;
      out[i] = clamp01((cav[i] * 0.75 + blotch[i] * 0.55 + down) * amount);
    }
  }
  return out;
}

/** Scattered dirt decals — tyre scuffs, splashes, dropped paint, gum. */
export function decalField(
  size: number,
  o: { count?: number; seed?: number | string; radius?: number; jaggedness?: number } = {},
): Field {
  const rng = makeRng(o.seed ?? "decals");
  const out = new Float32Array(size * size);
  const count = o.count ?? 40;
  const r0 = (o.radius ?? 0.012) * size;
  const jag = o.jaggedness ?? 0.6;
  for (let s = 0; s < count; s++) {
    const cx = rng.next() * size;
    const cy = rng.next() * size;
    const r = r0 * (0.4 + rng.next() * 1.6);
    const sq = 0.6 + rng.next() * 0.8; // slight anisotropy so nothing is a perfect disc
    const rot = rng.next() * Math.PI;
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const inten = 0.5 + rng.next() * 0.5;
    const ext = Math.ceil(r * 2);
    for (let dy = -ext; dy <= ext; dy++) {
      for (let dx = -ext; dx <= ext; dx++) {
        const lx = (dx * cs + dy * sn) / r;
        const ly = (-dx * sn + dy * cs) / (r * sq);
        const d = Math.sqrt(lx * lx + ly * ly);
        const wob = 1 + jag * 0.3 * Math.sin(Math.atan2(ly, lx) * 5 + s);
        if (d > wob) continue;
        const x = ((Math.floor(cx + dx) % size) + size) % size;
        const y = ((Math.floor(cy + dy) % size) + size) % size;
        const i = y * size + x;
        const a = inten * (1 - smoothstep(wob * 0.5, wob, d));
        if (a > out[i]) out[i] = a;
      }
    }
  }
  return out;
}

/* ================================================================== *
 * Rasterisation
 * ================================================================== */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function hexRgb(hex: number): RGB {
  return {
    r: ((hex >> 16) & 255) / 255,
    g: ((hex >> 8) & 255) / 255,
    b: (hex & 255) / 255,
  };
}

/**
 * A three-channel working buffer in display-referred (sRGB-encoded) 0..1.
 *
 * Compositing in display space rather than linear is technically "wrong", but
 * it is what every texture-painting tool does and it is what makes hand-picked
 * hex colours behave the way you expect when you tint and layer them. The
 * texture is flagged sRGB on upload, so the GPU decodes it correctly.
 */
export class AlbedoBuffer {
  readonly size: number;
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly a: Float32Array;

  constructor(size: number, base?: number | RGB) {
    this.size = size;
    const n = size * size;
    this.r = new Float32Array(n);
    this.g = new Float32Array(n);
    this.b = new Float32Array(n);
    this.a = new Float32Array(n).fill(1);
    if (base !== undefined) this.fill(base);
  }

  fill(color: number | RGB): this {
    const c = typeof color === "number" ? hexRgb(color) : color;
    this.r.fill(c.r);
    this.g.fill(c.g);
    this.b.fill(c.b);
    return this;
  }

  /** Blend toward `color` by `mask` (field or constant), scaled by `amount`. */
  lerpTo(color: number | RGB, mask: Field | number, amount = 1): this {
    const c = typeof color === "number" ? hexRgb(color) : color;
    const n = this.r.length;
    if (typeof mask === "number") {
      const t = mask * amount;
      for (let i = 0; i < n; i++) {
        this.r[i] += (c.r - this.r[i]) * t;
        this.g[i] += (c.g - this.g[i]) * t;
        this.b[i] += (c.b - this.b[i]) * t;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const t = mask[i] * amount;
        this.r[i] += (c.r - this.r[i]) * t;
        this.g[i] += (c.g - this.g[i]) * t;
        this.b[i] += (c.b - this.b[i]) * t;
      }
    }
    return this;
  }

  /** Multiply brightness by `1 + (field - pivot) * amount` — tone variation. */
  modulate(f: Field, amount: number, pivot = 0.5): this {
    const n = this.r.length;
    for (let i = 0; i < n; i++) {
      const m = 1 + (f[i] - pivot) * amount;
      this.r[i] *= m;
      this.g[i] *= m;
      this.b[i] *= m;
    }
    return this;
  }

  /** Per-channel multiply by a field (e.g. AO baked lightly into albedo). */
  multiplyField(f: Field, amount = 1): this {
    const n = this.r.length;
    for (let i = 0; i < n; i++) {
      const m = 1 - (1 - f[i]) * amount;
      this.r[i] *= m;
      this.g[i] *= m;
      this.b[i] *= m;
    }
    return this;
  }

  /** Shift hue/saturation cheaply toward a target chroma — used for rust fronts. */
  desaturate(f: Field | number, amount = 1): this {
    const n = this.r.length;
    for (let i = 0; i < n; i++) {
      const t = (typeof f === "number" ? f : f[i]) * amount;
      const l = this.r[i] * 0.2126 + this.g[i] * 0.7152 + this.b[i] * 0.0722;
      this.r[i] += (l - this.r[i]) * t;
      this.g[i] += (l - this.g[i]) * t;
      this.b[i] += (l - this.b[i]) * t;
    }
    return this;
  }

  setAlpha(f: Field | number): this {
    if (typeof f === "number") this.a.fill(f);
    else this.a.set(f);
    return this;
  }

  clamp(): this {
    for (let i = 0; i < this.r.length; i++) {
      this.r[i] = clamp01(this.r[i]);
      this.g[i] = clamp01(this.g[i]);
      this.b[i] = clamp01(this.b[i]);
    }
    return this;
  }

  /** Mean luminance — the pivot the detail-map shader normalises against. */
  meanLuminance(): number {
    let sum = 0;
    const n = this.r.length;
    for (let i = 0; i < n; i++) {
      sum += this.r[i] * 0.2126 + this.g[i] * 0.7152 + this.b[i] * 0.0722;
    }
    return sum / (n || 1);
  }

  /** Emit an RGBA byte raster, vertically flipped for direct DataTexture upload. */
  toRaster(): Raster {
    const size = this.size;
    const out = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      const src = y * size;
      const dst = (size - 1 - y) * size;
      for (let x = 0; x < size; x++) {
        const i = src + x;
        const o = (dst + x) * 4;
        out[o] = clamp01(this.r[i]) * 255;
        out[o + 1] = clamp01(this.g[i]) * 255;
        out[o + 2] = clamp01(this.b[i]) * 255;
        out[o + 3] = clamp01(this.a[i]) * 255;
      }
    }
    return out;
  }
}

/**
 * Pack ao / roughness / metalness into one RGBA raster, matching three's
 * channel convention exactly (ao = r, roughness = g, metalness = b).
 */
export function packORM(
  size: number,
  ao: Field | number,
  rough: Field | number,
  metal: Field | number,
  alpha: Field | number = 1,
): Raster {
  const out = new Uint8Array(size * size * 4);
  const get = (f: Field | number, i: number) => (typeof f === "number" ? f : f[i]);
  for (let y = 0; y < size; y++) {
    const src = y * size;
    const dst = (size - 1 - y) * size;
    for (let x = 0; x < size; x++) {
      const i = src + x;
      const o = (dst + x) * 4;
      out[o] = clamp01(get(ao, i)) * 255;
      out[o + 1] = clamp01(get(rough, i)) * 255;
      out[o + 2] = clamp01(get(metal, i)) * 255;
      out[o + 3] = clamp01(get(alpha, i)) * 255;
    }
  }
  return out;
}

/** Flip an already-assembled top-down raster for upload. */
export function flipRaster(src: Raster, size: number): Raster {
  const out = new Uint8Array(src.length);
  const stride = size * 4;
  for (let y = 0; y < size; y++) {
    out.set(src.subarray(y * stride, y * stride + stride), (size - 1 - y) * stride);
  }
  return out;
}

export interface TextureOpts {
  srgb?: boolean;
  anisotropy?: number;
  repeat?: number | [number, number];
  wrap?: THREE.Wrapping;
  name?: string;
  generateMipmaps?: boolean;
  /** three's uv channel; ao maps default to uv1 unless told otherwise. */
  channel?: number;
}

export function applyTextureOpts(tex: THREE.Texture, o: TextureOpts = {}): THREE.Texture {
  const wrap = o.wrap ?? THREE.RepeatWrapping;
  tex.wrapS = wrap;
  tex.wrapT = wrap;
  if (o.repeat !== undefined) {
    const [rx, ry] = Array.isArray(o.repeat) ? o.repeat : [o.repeat, o.repeat];
    tex.repeat.set(rx, ry);
  }
  tex.anisotropy = o.anisotropy ?? 4;
  tex.generateMipmaps = o.generateMipmaps ?? true;
  tex.minFilter = tex.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  if (o.srgb) tex.colorSpace = THREE.SRGBColorSpace;
  else tex.colorSpace = THREE.NoColorSpace;
  if (o.name) tex.name = o.name;
  if (o.channel !== undefined) tex.channel = o.channel;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build a DataTexture from a raster that has already been flipped by the
 * writer (`AlbedoBuffer.toRaster`, `packORM`, `normalFromHeight` + `flipRaster`).
 * `flipY` stays false: driver support for UNPACK_FLIP_Y on ArrayBufferView
 * uploads is technically specified but historically patchy, and flipping in JS
 * once at load costs nothing.
 */
export function rasterTexture(data: Raster, size: number, o: TextureOpts = {}): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.flipY = false;
  tex.unpackAlignment = 4;
  applyTextureOpts(tex, o);
  return tex;
}

/** CanvasTexture wrapper — used where 2D drawing beats per-pixel maths. */
export function canvasTexture(s: Surface, o: TextureOpts = {}): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(s.canvas as HTMLCanvasElement);
  applyTextureOpts(tex, o);
  return tex;
}

/**
 * Convenience: height field → normal DataTexture, including the vertical flip.
 * Green channel follows the OpenGL (+Y up) convention three expects.
 */
export function normalTexture(
  height: Field,
  size: number,
  strength = 1,
  o: TextureOpts = {},
): THREE.DataTexture {
  return rasterTexture(flipRaster(normalFromHeight(height, size, strength), size), size, {
    ...o,
    srgb: false,
  });
}

/* ================================================================== *
 * Shared helpers used by the higher layers
 * ================================================================== */

/**
 * A low-frequency, three-channel "macro variation" texture. Sampled at tens of
 * metres per tile it breaks the repetition of every tiling material at range —
 * without it, a road or a hillside reads as a carpet from 200 m no matter how
 * good the close-up detail is. Values hover around 0.5 so the shader can use it
 * as a symmetric multiplier.
 */
export function macroVariationRaster(size: number, seed: number | string = "macro"): Raster {
  const a = fbmField(size, { period: 2, octaves: 5, gain: 0.55, seed: `${seed}:a` });
  const b = fbmField(size, { period: 3, octaves: 4, gain: 0.5, seed: `${seed}:b` });
  const c = fbmField(size, { period: 5, octaves: 3, gain: 0.5, seed: `${seed}:c` });
  const buf = new AlbedoBuffer(size);
  for (let i = 0; i < a.length; i++) {
    // Slightly correlated channels: real large-scale variation shifts tone and
    // value together, it does not scramble hue.
    const l = a[i] * 0.65 + b[i] * 0.35;
    buf.r[i] = 0.5 + (l - 0.5) * 0.55 + (c[i] - 0.5) * 0.08;
    buf.g[i] = 0.5 + (l - 0.5) * 0.5;
    buf.b[i] = 0.5 + (l - 0.5) * 0.45 - (c[i] - 0.5) * 0.07;
  }
  return buf.clamp().toRaster();
}

/** Deterministic child RNG for a named generator. */
export function generatorRng(kind: string, variant = 0, seed = "sf-materials"): Rng {
  return makeRng(`${seed}:${kind}:${variant}`);
}

/** Free every cached scratch buffer and lattice table. */
export function clearGeneratorCaches(): void {
  latticeCache.clear();
  scratchCache.clear();
}
