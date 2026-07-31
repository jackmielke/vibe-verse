/**
 * Tileable value noise — the only CPU noise the environment needs.
 *
 * The cloud sheets are world-scrolling planes that repeat forever, so their
 * texture has to be *genuinely* periodic: a cross-faded tile shows its seam as
 * a straight line marching across the sky at exactly the wind speed, which is
 * the most obvious tell in the book. Every evaluator here works on an integer
 * lattice whose period divides the texture, so the left edge is the right edge
 * by construction — no fade, no mirror, no seam.
 *
 * Value noise rather than gradient noise on purpose: clouds want blobby
 * lumps with fat cores, and value noise's characteristic "puffiness" (the one
 * thing that makes it a poor terrain primitive) is exactly the shape we want.
 */

/** 32-bit integer hash of a lattice cell → [0,1). Cheap and well-mixed. */
function hashCell(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Quintic smoothstep — C² continuous, so fbm derivatives stay clean. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * One octave of periodic value noise. `period` is in lattice cells and must
 * divide the sampling domain for the result to tile.
 */
export function valueNoise2D(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = fade(x - xi);
  const v = fade(y - yi);

  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;

  const a = hashCell(x0, y0, seed);
  const b = hashCell(x1, y0, seed);
  const c = hashCell(x0, y1, seed);
  const d = hashCell(x1, y1, seed);

  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

export interface FbmOptions {
  octaves: number;
  /** Lattice period of the *first* octave, in cells across the tile. */
  period: number;
  gain?: number;
  lacunarity?: number;
  seed?: number;
  /** Ridged/billow fold — turns smooth lumps into cauliflower edges. */
  billow?: boolean;
}

/**
 * Fractal sum in [0,1]. `x`/`y` are in tile units (0..1 spans one full tile),
 * which keeps every call site free of lattice arithmetic.
 */
export function fbm2D(x: number, y: number, opts: FbmOptions): number {
  const { octaves, period, gain = 0.5, lacunarity = 2, seed = 0, billow = false } = opts;
  let amp = 1;
  let norm = 0;
  let sum = 0;
  let p = period;
  for (let o = 0; o < octaves; o++) {
    let n = valueNoise2D(x * p, y * p, p, seed + o * 1013);
    // Billow folds the octave about its midpoint: the fold line becomes a
    // crease, and creases are what read as cloud edges rather than fog.
    if (billow) n = Math.abs(n * 2 - 1);
    sum += n * amp;
    norm += amp;
    amp *= gain;
    // Integer lacunarity keeps every octave on a lattice that still divides
    // the tile, which is the whole reason this thing is seamless.
    p = Math.round(p * lacunarity);
  }
  return sum / norm;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}
