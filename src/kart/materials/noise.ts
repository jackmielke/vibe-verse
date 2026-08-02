/**
 * Vibe Kart — the procedural texture foundry.
 *
 * Everything the game renders is baked here at boot: there is not a single
 * image file in the project. That is a deliberate trade — a second of CPU at
 * load instead of megabytes of download — and it buys something a downloaded
 * texture pack cannot give us: every surface is *parameterised*, so the kerb
 * knows where its own chamfer is and the asphalt knows which of its stones are
 * proud enough to have been polished bare by tyres.
 *
 * Rules that matter if you extend this file:
 *
 * 1. **Everything tiles.** Every noise primitive is evaluated on a periodic
 *    integer lattice whose period divides the texture exactly, so column 0 is
 *    genuinely continuous with column N-1. No cross-fade, no mirror, no seam —
 *    which matters enormously on a race track, where the same tarmac tile is
 *    repeated two hundred times down a straight and any seam becomes a
 *    strobing ladder at 100 km/h.
 *
 * 2. **Octaves are rendered small and upsampled.** A 5-octave fbm evaluated
 *    per-pixel at 512² is ~80 M operations. Instead each octave is rendered
 *    into a buffer just large enough to resolve its own lattice and bilinearly
 *    accumulated. The result is visually identical (the octave is already
 *    band-limited at that scale) and the whole library bakes in ~1 s.
 *
 * 3. **Row 0 is the top**, like a canvas, because that is how a human reasons
 *    about "grime runs down into the joint". Rasters are flipped exactly once,
 *    on the way into a DataTexture, which keeps `flipY = false` — the only
 *    combination that is reliable for ArrayBufferView uploads across drivers.
 *
 * 4. **ORM packing.** three reads ao from `.r`, roughness from `.g` and
 *    metalness from `.b`. We honour that exactly and bind one packed texture to
 *    all three slots: one upload, one fetch, three maps.
 */
import * as THREE from "three";

// ---------------------------------------------------------------------------
// Small maths
// ---------------------------------------------------------------------------

/** A single-channel image, `size * size` floats, row 0 = top. */
export type Field = Float32Array;

/** RGBA byte raster, `size * size * 4`, row 0 = top. */
export type Raster = Uint8Array;

export type Rng = () => number;

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** FNV-1a so a human-readable seed string maps to a stable 32-bit stream. */
export function hashSeed(seed: number | string): number {
  if (typeof seed === "number") return seed >>> 0 || 0x9e3779b9;
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0 || 0x9e3779b9;
}

/** xorshift32 — same generator as the engine's, seeded from a name. */
export function makeRng(seed: number | string): Rng {
  let s = hashSeed(seed);
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/** Integer modulo that stays positive — used everywhere for wrap addressing. */
function wrapi(v: number, n: number): number {
  return ((v % n) + n) % n;
}

// ---------------------------------------------------------------------------
// Canvas plumbing
// ---------------------------------------------------------------------------

export interface Surface {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
}

/**
 * OffscreenCanvas keeps generation off the DOM and is measurably faster, but a
 * few embedded webviews still lie about supporting it, so we fall back.
 */
export function makeSurface(width: number, height = width): Surface {
  let canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(width, height);
  } else if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    canvas = c;
  }
  if (!canvas) throw new Error("[kart/materials] no canvas implementation available");
  // willReadFrequently matters: we always read these back with getImageData and
  // without the hint the browser keeps the surface GPU-side, making every read
  // a full pipeline stall.
  const ctx = (canvas as HTMLCanvasElement).getContext("2d", {
    willReadFrequently: true,
    alpha: true,
  }) as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("[kart/materials] 2D context unavailable");
  return { canvas, ctx, width, height };
}

export function surfaceToRaster(s: Surface): Raster {
  const img = s.ctx.getImageData(0, 0, s.width, s.height);
  return new Uint8Array(img.data.buffer.slice(0));
}

/** Read one channel of a surface back as a 0..1 field. */
export function surfaceToField(s: Surface, channel: 0 | 1 | 2 | 3 = 0): Field {
  const img = s.ctx.getImageData(0, 0, s.width, s.height);
  const d = img.data;
  const n = s.width * s.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = d[i * 4 + channel] / 255;
  return out;
}

/**
 * Run `draw` nine times on a 3×3 lattice of offsets so anything stamped near an
 * edge reappears on the opposite one. The cheapest correct way to make hand-drawn
 * content (leaves, spectators, chevrons) tile.
 */
export function stampWrapped(s: Surface, draw: (ctx: CanvasRenderingContext2D) => void): void {
  const { ctx, width: w, height: h } = s;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      ctx.save();
      ctx.translate(ox * w, oy * h);
      draw(ctx);
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------------------
// Periodic lattice noise
// ---------------------------------------------------------------------------

const latticeCache = new Map<string, Float32Array>();

function lattice(px: number, py: number, seed: number): Float32Array {
  const key = `${px}x${py}:${seed}`;
  const hit = latticeCache.get(key);
  if (hit) return hit;
  if (latticeCache.size > 384) latticeCache.clear();
  const rng = makeRng(seed);
  const g = new Float32Array(px * py * 2);
  for (let i = 0; i < px * py; i++) {
    const a = rng() * Math.PI * 2;
    g[i * 2] = Math.cos(a);
    g[i * 2 + 1] = Math.sin(a);
  }
  latticeCache.set(key, g);
  return g;
}

const scratchCache = new Map<number, Float32Array>();
function scratch(n: number): Float32Array {
  let s = scratchCache.get(n);
  if (!s) scratchCache.set(n, (s = new Float32Array(n * n)));
  return s;
}

/** 0 = signed gradient noise, 1 = ridged, 2 = billow. */
type NoiseMode = 0 | 1 | 2;

/** One periodic gradient-noise octave rendered into `out` (side `tile`). */
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
    const y0 = wrapi(yi, py);
    const y1 = y0 + 1 === py ? 0 : y0 + 1;
    const r0 = y0 * px;
    const r1 = y1 * px;
    const row = y * tile;
    for (let x = 0; x < tile; x++) {
      const fx = (x / tile) * px;
      const xi = Math.floor(fx);
      const xf = fx - xi;
      const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
      const x0 = wrapi(xi, px);
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
      out[row + x] = n;
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
    const ya = wrapi(yi, srcSize);
    const yb = ya + 1 === srcSize ? 0 : ya + 1;
    const ra = ya * srcSize;
    const rb = yb * srcSize;
    const row = y * dstSize;
    for (let x = 0; x < dstSize; x++) {
      const fx = (x + 0.5) * s - 0.5;
      const xi = Math.floor(fx);
      const tx = fx - xi;
      const xa = wrapi(xi, srcSize);
      const xb = xa + 1 === srcSize ? 0 : xa + 1;
      const v0 = src[ra + xa] + (src[ra + xb] - src[ra + xa]) * tx;
      const v1 = src[rb + xa] + (src[rb + xb] - src[rb + xa]) * tx;
      dst[row + x] += (v0 + (v1 - v0) * ty) * amp;
    }
  }
}

/** Pixels resolved per lattice cell before an octave goes to full resolution. */
const OVERSAMPLE = 6;

export interface NoiseOpts {
  /** Lattice cells across the texture at octave 0. `[x, y]` for stretched grain. */
  period?: number | [number, number];
  octaves?: number;
  lacunarity?: number;
  gain?: number;
  seed?: number | string;
  kind?: "fbm" | "ridged" | "billow";
  /** "unit" (default) remaps to 0..1; "signed" leaves it around -1..1. */
  range?: "unit" | "signed";
}

export function fbmField(size: number, o: NoiseOpts = {}): Field {
  const period = o.period ?? 4;
  const [p0x, p0y] = Array.isArray(period) ? period : [period, period];
  const octaves = Math.max(1, o.octaves ?? 4);
  const lacunarity = o.lacunarity ?? 2;
  const gain = o.gain ?? 0.5;
  const mode: NoiseMode = o.kind === "ridged" ? 1 : o.kind === "billow" ? 2 : 0;
  const seed = hashSeed(o.seed ?? 1);

  const out = new Float32Array(size * size);
  // Nyquist guard. A lattice cell narrower than about four texels stops being
  // detail and starts being a rectangular moiré — which is exactly what a
  // "fine grain" octave degrades into once the quality tier halves the texture.
  // Clamping (rather than dropping) keeps the material's character at low
  // resolution instead of flattening it to grey.
  const maxPeriod = Math.max(4, Math.floor(size / 4));
  let amp = 1;
  let norm = 0;
  for (let oct = 0; oct < octaves; oct++) {
    const m = Math.pow(lacunarity, oct);
    const wantX = Math.max(1, Math.round(p0x * m));
    const wantY = Math.max(1, Math.round(p0y * m));
    const px = Math.min(wantX, maxPeriod);
    const py = Math.min(wantY, maxPeriod);
    // Both axes pinned means every remaining octave would render the same
    // lattice again; stop rather than pay for a duplicate.
    if (oct > 0 && px < wantX && py < wantY) break;
    // Resolve the octave at whatever size actually carries its detail.
    let tile = 1;
    const want = Math.max(px, py) * OVERSAMPLE;
    while (tile < want && tile < size) tile *= 2;
    const buf = scratch(tile);
    noiseTile(buf, tile, px, py, lattice(px, py, seed + oct * 7919), mode);
    upsampleAdd(out, size, buf, tile, amp);
    norm += amp;
    amp *= gain;
  }
  const inv = 1 / (norm || 1);
  if (o.range === "signed") {
    for (let i = 0; i < out.length; i++) out[i] *= inv;
  } else if (mode === 1) {
    // Ridged noise is already 0..1-ish; rescaling it to the full range costs
    // the crisp ridge line, so only normalise the amplitude sum.
    for (let i = 0; i < out.length; i++) out[i] = clamp01(out[i] * inv);
  } else {
    for (let i = 0; i < out.length; i++) out[i] = clamp01(out[i] * inv * 0.5 + 0.5);
  }
  return out;
}

export function ridgedField(size: number, o: NoiseOpts = {}): Field {
  return fbmField(size, { ...o, kind: "ridged" });
}

export function whiteField(size: number, seed: number | string = 0): Field {
  const rng = makeRng(seed);
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = rng();
  return out;
}

// ---------------------------------------------------------------------------
// Worley / voronoi
// ---------------------------------------------------------------------------

export interface WorleyOpts {
  /** Cells across the texture. `[x, y]` for stretched cells (planks, ripples). */
  cells?: number | [number, number];
  seed?: number | string;
  /** 0 = perfect grid, 1 = fully random placement inside each cell. */
  jitter?: number;
  /** Chebyshev-ish blending gives brick-like cells; 0 = euclidean. */
  manhattan?: number;
}

export interface WorleyResult {
  /** Distance to nearest feature point, normalised to ~0..1. */
  f1: Field;
  /** Distance to second nearest — `f2 - f1` is the cell-edge network. */
  f2: Field;
  /** Per-cell random value in 0..1, constant inside a cell. */
  id: Field;
}

/**
 * Periodic Worley. The feature points live on a wrapped cell grid so the result
 * tiles; the 3×3 neighbourhood search is exact for jitter ≤ 1.
 */
export function worleyField(size: number, o: WorleyOpts = {}): WorleyResult {
  const cells = o.cells ?? 8;
  const [cx0, cy0] = Array.isArray(cells) ? cells : [cells, cells];
  // Same Nyquist guard as the gradient noise: below ~4 px a cell is aliasing.
  const maxCells = Math.max(2, Math.floor(size / 4));
  const cx = Math.min(cx0, maxCells);
  const cy = Math.min(cy0, maxCells);
  const jitter = o.jitter ?? 0.85;
  const manhattan = o.manhattan ?? 0;
  const rng = makeRng(o.seed ?? "worley");

  const n = cx * cy;
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  const idv = new Float32Array(n);
  for (let j = 0; j < cy; j++) {
    for (let i = 0; i < cx; i++) {
      const k = j * cx + i;
      px[k] = (i + 0.5 + (rng() - 0.5) * jitter) / cx;
      py[k] = (j + 0.5 + (rng() - 0.5) * jitter) / cy;
      idv[k] = rng();
    }
  }

  const f1 = new Float32Array(size * size);
  const f2 = new Float32Array(size * size);
  const id = new Float32Array(size * size);
  // Normalising by the cell diagonal keeps f1 in a predictable range whatever
  // the aspect ratio, which is what lets callers reuse thresholds.
  const norm = Math.min(cx, cy) * 0.75;

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    const cj = Math.floor(v * cy);
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const ci = Math.floor(u * cx);
      let d1 = 1e9;
      let d2 = 1e9;
      let best = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = wrapi(cj + dj, cy);
        for (let di = -1; di <= 1; di++) {
          const ii = wrapi(ci + di, cx);
          const k = jj * cx + ii;
          let dx = px[k] - u;
          let dy = py[k] - v;
          // Shortest wrapped offset — this is what makes the pattern periodic.
          if (dx > 0.5) dx -= 1;
          else if (dx < -0.5) dx += 1;
          if (dy > 0.5) dy -= 1;
          else if (dy < -0.5) dy += 1;
          const e = Math.sqrt(dx * dx + dy * dy);
          const m = Math.abs(dx) + Math.abs(dy);
          const d = e + (m - e) * manhattan;
          if (d < d1) {
            d2 = d1;
            d1 = d;
            best = idv[k];
          } else if (d < d2) {
            d2 = d;
          }
        }
      }
      const i = y * size + x;
      f1[i] = clamp01(d1 * norm);
      f2[i] = clamp01(d2 * norm);
      id[i] = best;
    }
  }
  return { f1, f2, id };
}

// ---------------------------------------------------------------------------
// Field arithmetic
// ---------------------------------------------------------------------------

export function fieldOf(size: number, v = 0): Field {
  const f = new Float32Array(size * size);
  if (v !== 0) f.fill(v);
  return f;
}

export function copyField(a: Field): Field {
  return new Float32Array(a);
}

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

export function maxField(a: Field, b: Field, out = a): Field {
  for (let i = 0; i < a.length; i++) out[i] = a[i] > b[i] ? a[i] : b[i];
  return out;
}

export function mixField(a: Field, b: Field, t: Field | number, out = a): Field {
  if (typeof t === "number") {
    for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  } else {
    for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t[i];
  }
  return out;
}

export function clampField(a: Field, lo = 0, hi = 1, out = a): Field {
  for (let i = 0; i < a.length; i++) out[i] = clamp(a[i], lo, hi);
  return out;
}

export function powField(a: Field, e: number, out = a): Field {
  for (let i = 0; i < a.length; i++) out[i] = Math.pow(clamp01(a[i]), e);
  return out;
}

export function invertField(a: Field, out = a): Field {
  for (let i = 0; i < a.length; i++) out[i] = 1 - a[i];
  return out;
}

/** Smoothstep remap — the workhorse for turning noise into a mask. */
export function thresholdField(a: Field, lo: number, hi: number, out = a): Field {
  const d = hi - lo || 1e-6;
  for (let i = 0; i < a.length; i++) {
    const t = clamp01((a[i] - lo) / d);
    out[i] = t * t * (3 - 2 * t);
  }
  return out;
}

export function contrastField(a: Field, amount: number, pivot = 0.5, out = a): Field {
  for (let i = 0; i < a.length; i++) out[i] = clamp01((a[i] - pivot) * amount + pivot);
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
  return { min, max, mean: sum / a.length };
}

export function normalizeField(a: Field, out = a): Field {
  const { min, max } = fieldRange(a);
  const inv = 1 / (max - min || 1);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] - min) * inv;
  return out;
}

export function sampleWrap(a: Field, size: number, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = x - xi;
  const ty = y - yi;
  const x0 = wrapi(xi, size);
  const y0 = wrapi(yi, size);
  const x1 = x0 + 1 === size ? 0 : x0 + 1;
  const y1 = y0 + 1 === size ? 0 : y0 + 1;
  const r0 = y0 * size;
  const r1 = y1 * size;
  const v0 = a[r0 + x0] + (a[r0 + x1] - a[r0 + x0]) * tx;
  const v1 = a[r1 + x0] + (a[r1 + x1] - a[r1 + x0]) * tx;
  return v0 + (v1 - v0) * ty;
}

/**
 * Wrapped box blur with running sums, so the cost is independent of radius —
 * which matters because the AO pass wants a radius of a sixteenth of the image
 * and a naive kernel there is 30 M samples per material.
 */
export function blurField(a: Field, size: number, radius: number, passes = 2): Field {
  const r = Math.max(1, Math.round(radius));
  let src = new Float32Array(a);
  let dst = new Float32Array(a.length);
  const w = r * 2 + 1;
  const inv = 1 / w;
  for (let p = 0; p < passes; p++) {
    // Horizontal
    for (let y = 0; y < size; y++) {
      const row = y * size;
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += src[row + wrapi(i, size)];
      for (let x = 0; x < size; x++) {
        dst[row + x] = sum * inv;
        sum += src[row + wrapi(x + r + 1, size)] - src[row + wrapi(x - r, size)];
      }
    }
    [src, dst] = [dst, src];
    // Vertical
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += src[wrapi(i, size) * size + x];
      for (let y = 0; y < size; y++) {
        dst[y * size + x] = sum * inv;
        sum += src[wrapi(y + r + 1, size) * size + x] - src[wrapi(y - r, size) * size + x];
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}

/** Domain-warp `a` by two offset fields. The cheapest way to kill regularity. */
export function warpField(
  a: Field,
  size: number,
  dx: Field,
  dy: Field,
  amount: number,
): Field {
  const out = new Float32Array(a.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      out[i] = sampleWrap(a, size, x + (dx[i] - 0.5) * amount, y + (dy[i] - 0.5) * amount);
    }
  }
  return out;
}

/**
 * A network of wandering lines — tar seams, cracks, dried mud, tyre ruts.
 * Each line is a wobbling path across the tile (along U or V) rasterised with a
 * soft falloff; the wobble is a sum of sines whose periods divide the tile, so
 * the ends meet exactly when the line wraps.
 */
export function seamField(
  size: number,
  o: {
    count?: number;
    axis?: "u" | "v";
    width?: number;
    wobble?: number;
    seed?: number | string;
    /** Lines fade out along their length rather than running the full tile. */
    broken?: number;
  } = {},
): Field {
  const count = o.count ?? 3;
  const axis = o.axis ?? "u";
  const width = (o.width ?? 0.008) * size;
  const wobble = (o.wobble ?? 0.06) * size;
  const broken = o.broken ?? 0;
  const rng = makeRng(o.seed ?? "seam");
  const out = new Float32Array(size * size);

  for (let l = 0; l < count; l++) {
    const base = rng() * size;
    const w = width * (0.5 + rng());
    // Three harmonics with integer periods keeps the path continuous at wrap.
    const h = [1, 2, 3].map((k) => ({
      k: k + Math.floor(rng() * 2),
      a: (wobble / (k * k)) * (0.6 + rng() * 0.8),
      p: rng() * Math.PI * 2,
    }));
    const breakK = 1 + Math.floor(rng() * 3);
    const breakP = rng() * Math.PI * 2;
    for (let s = 0; s < size; s++) {
      const t = (s / size) * Math.PI * 2;
      let c = base;
      for (const q of h) c += Math.sin(t * q.k + q.p) * q.a;
      let strength = 1;
      if (broken > 0) {
        strength = clamp01(1 - broken + broken * (0.5 + 0.5 * Math.sin(t * breakK + breakP)) * 1.6);
      }
      const span = Math.ceil(w) + 2;
      for (let d = -span; d <= span; d++) {
        const v = 1 - clamp01(Math.abs(d + (c - Math.floor(c))) / w);
        if (v <= 0) continue;
        const soft = v * v * (3 - 2 * v) * strength;
        const cc = wrapi(Math.floor(c) + d, size);
        const i = axis === "u" ? cc * size + s : s * size + cc;
        if (soft > out[i]) out[i] = soft;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Derived maps
// ---------------------------------------------------------------------------

/**
 * Sobel normal-from-height, wrap-aware. `strength` is in height units per
 * pixel: 1 is aggressive (mortar joints, plank gaps), 0.3 is stucco.
 */
export function normalFromHeight(height: Field, size: number, strength = 1): Raster {
  const out = new Uint8Array(size * size * 4);
  const k = strength * size * 0.0125;
  for (let y = 0; y < size; y++) {
    const ym = wrapi(y - 1, size) * size;
    const y0 = y * size;
    const yp = wrapi(y + 1, size) * size;
    for (let x = 0; x < size; x++) {
      const xm = wrapi(x - 1, size);
      const xp = wrapi(x + 1, size);
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
      // +Y up: three expects the OpenGL convention, and rows run downwards.
      let ny = dy * k;
      const len = Math.sqrt(nx * nx + ny * ny + 1) || 1;
      nx /= len;
      ny /= len;
      const i = (y0 + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (1 / len) * 0.5 * 255 + 127.5;
      out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * Multi-scale cavity AO. A horizon-scan bake at 512² is tens of millions of
 * rays and we have thirty materials to build; what we can afford — and what
 * low-sample offline bakes converge to anyway on tiling detail — is height
 * minus blurred height at three radii, multiplied together. Small radii catch
 * mortar joints and stone pores, large radii catch the fact that the middle of
 * a recessed panel is darker than its edge.
 */
export function aoFromHeight(
  height: Field,
  size: number,
  o: { radii?: number[]; weights?: number[]; strength?: number } = {},
): Field {
  const radii = o.radii ?? [Math.max(1, size / 200), Math.max(2, size / 48), Math.max(4, size / 14)];
  const weights = o.weights ?? [0.5, 0.36, 0.26];
  const strength = o.strength ?? 1;
  const n = size * size;
  const ao = new Float32Array(n).fill(1);

  for (let s = 0; s < radii.length; s++) {
    const b = blurField(height, size, radii[s], 2);
    // Self-normalising, so the term behaves the same whether the height field
    // spans 0..1 or 0..0.02.
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const d = height[i] - b[i];
      acc += d * d;
    }
    const sd = Math.sqrt(acc / n) || 1e-5;
    const gain = (0.55 / sd) * weights[s];
    for (let i = 0; i < n; i++) {
      const occ = clamp01(0.5 + (height[i] - b[i]) * gain + (1 - weights[s]) * 0.5);
      ao[i] *= 0.4 + 0.6 * clamp01(occ * 1.15);
    }
  }
  // Re-expand so the average surface sits near white: AO darkens crevices, not
  // the whole material.
  const { max } = fieldRange(ao);
  const inv = 1 / (max || 1);
  for (let i = 0; i < n; i++) ao[i] = Math.pow(clamp01(ao[i] * inv), strength);
  return ao;
}

/** >0.5 on convex ridges (paint chips, polished edges), <0.5 in crevices. */
export function curvatureField(height: Field, size: number, radius = 2): Field {
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

/** 1 where an edge is proud enough to have been rubbed bare. */
export function edgeWearField(height: Field, size: number, radius = 2, bias = 0.58): Field {
  const c = curvatureField(height, size, radius);
  return thresholdField(c, bias, Math.min(0.98, bias + 0.28));
}

/** 1 deep in the crevices, where grime collects. */
export function cavityField(height: Field, size: number, radius = 3, bias = 0.44): Field {
  const c = curvatureField(height, size, radius);
  invertField(c);
  return thresholdField(c, 1 - bias, Math.min(0.99, 1 - bias + 0.3));
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function hexRgb(hex: number): RGB {
  return { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255 };
}

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

/** HSV in 0..1, out in sRGB 0..1 — the fastest way to author palette spreads. */
export function hsv(h: number, s: number, v: number): RGB {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return { r: v, g: t, b: p };
    case 1: return { r: q, g: v, b: p };
    case 2: return { r: p, g: v, b: t };
    case 3: return { r: p, g: q, b: v };
    case 4: return { r: t, g: p, b: v };
    default: return { r: v, g: p, b: q };
  }
}

/**
 * A floating-point RGBA image authored directly in sRGB display space — which
 * is how a human picks colours, and matches the SRGBColorSpace we tag the
 * finished albedo with.
 */
export class AlbedoBuffer {
  readonly size: number;
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly a: Float32Array;

  constructor(size: number) {
    const n = size * size;
    this.size = size;
    this.r = new Float32Array(n);
    this.g = new Float32Array(n);
    this.b = new Float32Array(n);
    this.a = new Float32Array(n).fill(1);
  }

  fill(hex: number): this {
    const c = hexRgb(hex);
    this.r.fill(c.r);
    this.g.fill(c.g);
    this.b.fill(c.b);
    return this;
  }

  /** Blend `hex` in wherever `mask` is high. */
  overlay(mask: Field, hex: number, amount = 1): this {
    const c = hexRgb(hex);
    for (let i = 0; i < mask.length; i++) {
      const t = clamp01(mask[i]) * amount;
      if (t <= 0) continue;
      this.r[i] += (c.r - this.r[i]) * t;
      this.g[i] += (c.g - this.g[i]) * t;
      this.b[i] += (c.b - this.b[i]) * t;
    }
    return this;
  }

  /** Blend between two colours by a field — the standard two-tone pass. */
  gradient(mask: Field, lo: number, hi: number): this {
    const a = hexRgb(lo);
    const b = hexRgb(hi);
    for (let i = 0; i < mask.length; i++) {
      const t = clamp01(mask[i]);
      this.r[i] = a.r + (b.r - a.r) * t;
      this.g[i] = a.g + (b.g - a.g) * t;
      this.b[i] = a.b + (b.b - a.b) * t;
    }
    return this;
  }

  /** Multiply luminance by a field — shading, dirt, AO bleed into albedo. */
  shade(mask: Field, amount = 1): this {
    for (let i = 0; i < mask.length; i++) {
      const m = 1 - (1 - clamp01(mask[i])) * amount;
      this.r[i] *= m;
      this.g[i] *= m;
      this.b[i] *= m;
    }
    return this;
  }

  /** Per-pixel value jitter — the single cheapest anti-plastic pass there is. */
  jitter(field: Field, amount: number): this {
    for (let i = 0; i < field.length; i++) {
      const d = (field[i] - 0.5) * amount;
      this.r[i] += d;
      this.g[i] += d;
      this.b[i] += d;
    }
    return this;
  }

  /** Per-pixel hue/saturation drift, so a "grey" road is never one grey. */
  tintNoise(field: Field, warm: number, cool: number): this {
    for (let i = 0; i < field.length; i++) {
      const d = field[i] - 0.5;
      const k = d > 0 ? d * warm : d * cool;
      this.r[i] += k;
      this.b[i] -= k;
    }
    return this;
  }

  setAlpha(mask: Field): this {
    for (let i = 0; i < mask.length; i++) this.a[i] = clamp01(mask[i]);
    return this;
  }

  toRaster(): Raster {
    const n = this.size * this.size;
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      out[j] = clamp01(this.r[i]) * 255;
      out[j + 1] = clamp01(this.g[i]) * 255;
      out[j + 2] = clamp01(this.b[i]) * 255;
      out[j + 3] = clamp01(this.a[i]) * 255;
    }
    return out;
  }
}

/** Read an RGBA raster back into an AlbedoBuffer so canvas art can be filtered. */
export function rasterToBuffer(raster: Raster, size: number): AlbedoBuffer {
  const buf = new AlbedoBuffer(size);
  for (let i = 0, n = size * size; i < n; i++) {
    const j = i * 4;
    buf.r[i] = raster[j] / 255;
    buf.g[i] = raster[j + 1] / 255;
    buf.b[i] = raster[j + 2] / 255;
    buf.a[i] = raster[j + 3] / 255;
  }
  return buf;
}

/** ao → r, roughness → g, metalness → b. One texture, three material slots. */
export function packORM(
  size: number,
  ao: Field | number,
  roughness: Field | number,
  metalness: Field | number,
): Raster {
  const n = size * size;
  const out = new Uint8Array(n * 4);
  const aoN = typeof ao === "number";
  const roN = typeof roughness === "number";
  const meN = typeof metalness === "number";
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    out[j] = clamp01(aoN ? (ao as number) : (ao as Field)[i]) * 255;
    out[j + 1] = clamp01(roN ? (roughness as number) : (roughness as Field)[i]) * 255;
    out[j + 2] = clamp01(meN ? (metalness as number) : (metalness as Field)[i]) * 255;
    out[j + 3] = 255;
  }
  return out;
}

/** Vertical flip — applied once, on the way into a texture. */
export function flipRaster(src: Raster, size: number): Raster {
  const stride = size * 4;
  const out = new Uint8Array(src.length);
  for (let y = 0; y < size; y++) {
    out.set(src.subarray(y * stride, y * stride + stride), (size - 1 - y) * stride);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Texture construction
// ---------------------------------------------------------------------------

export interface TextureOpts {
  srgb?: boolean;
  anisotropy?: number;
  repeat?: number | [number, number];
  wrap?: THREE.Wrapping;
  name?: string;
  generateMipmaps?: boolean;
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
  // Trilinear is mandatory here: a road tile repeated 200× down a straight
  // aliases into a shimmering mess without mips, on any rasteriser.
  tex.minFilter = tex.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = o.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (o.name) tex.name = o.name;
  tex.needsUpdate = true;
  return tex;
}

/**
 * DataTexture from a top-down raster. `flipY` stays false because driver
 * support for UNPACK_FLIP_Y on ArrayBufferView uploads is patchy; we flip in JS
 * once at bake time instead, which costs nothing.
 */
export function rasterTexture(data: Raster, size: number, o: TextureOpts = {}): THREE.DataTexture {
  const tex = new THREE.DataTexture(flipRaster(data, size), size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.flipY = false;
  tex.unpackAlignment = 4;
  applyTextureOpts(tex, o);
  return tex;
}

/** Height field → tangent-space normal DataTexture, flip included. */
export function normalTexture(
  height: Field,
  size: number,
  strength = 1,
  o: TextureOpts = {},
): THREE.DataTexture {
  return rasterTexture(normalFromHeight(height, size, strength), size, { ...o, srgb: false });
}

/** Free the lattice tables and octave scratch buffers after a bake run. */
export function clearNoiseCaches(): void {
  latticeCache.clear();
  scratchCache.clear();
}
