/**
 * vfx/textures.ts — every sprite the VFX system draws, generated on the CPU.
 *
 * There are no image assets in this project, and a particle system is exactly
 * the wrong place to start adding them: a smoke puff is 90% a density field and
 * 10% shading, and both of those are cheaper to *compute* than to download.
 *
 * Two structural decisions worth knowing before you edit anything here:
 *
 *  1. **Everything is atlased.** A particle layer is one draw call, and a draw
 *     call has one texture. So all the one-shot sprites (smoke, fire, spark,
 *     flash, dust, splash, speck, ring, blood, haze, drop, litter, bird, glow,
 *     wisp, ember) live in a single 4x4 atlas, and the per-particle `frame`
 *     attribute picks the tile. Adding a sprite means claiming a `Tile` index,
 *     not adding a texture.
 *
 *  2. **Smoke is shaded, not just masked.** A radial alpha ramp times some fbm
 *     gives you a fuzzy blob that reads as fog, not as smoke. What sells smoke
 *     is *internal form*: self-shadowing on the underside of each billow. So
 *     the puff generators build a float density field first, derive a normal
 *     from its gradient, and light it with a fixed key. The particle shader
 *     then tints that shaded luminance, which is why one grey texture can be a
 *     white steam plume, a black diesel column and an orange-lit fireball head
 *     without ever swapping a texture.
 *
 * Everything is cached by (kind, resolution) and disposed together.
 */
import * as THREE from "three";
import { clamp01, fbm2, makeRng, ridged2, smoothstep, worley2, type Rng } from "../math/rng";
import type { QualityTier } from "../config";

/* ================================================================== *
 * Canvas plumbing
 * ================================================================== */

interface Surf {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

/**
 * Returns null rather than throwing when there is no canvas implementation
 * (node test runs, exotic webviews). Callers fall back to a 2x2 DataTexture,
 * which keeps the whole VFX stack constructible in an environment that will
 * never actually render it.
 */
function makeCanvas(w: number, h: number): Surf | null {
  let canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(w, h);
  } else if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    canvas = c;
  }
  if (!canvas) return null;
  // jsdom *throws* from getContext rather than returning null, and a webview
  // with a broken 2D backend can do the same. Either way the answer is "no
  // canvas", not "crash the level".
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = (canvas as HTMLCanvasElement).getContext("2d", {
      willReadFrequently: true,
      alpha: true,
    }) as CanvasRenderingContext2D | null;
  } catch {
    ctx = null;
  }
  if (!ctx) return null;
  return { canvas, ctx, w, h };
}

function fallbackTexture(name: string): THREE.Texture {
  const data = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255,
                               255, 255, 255, 255, 255, 255, 255, 255]);
  const t = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.name = name;
  t.needsUpdate = true;
  return t;
}

/* ================================================================== *
 * Field helpers — all sprite generators speak "float density field"
 * ================================================================== */

/** A px*px scalar field, row-major, values conventionally in [0,1]. */
type Field = Float32Array;

function field(px: number): Field {
  return new Float32Array(px * px);
}

/** Bilinear-safe read with edge clamp; used by the gradient/normal pass. */
function at(f: Field, px: number, x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= px ? px - 1 : x;
  const cy = y < 0 ? 0 : y >= px ? px - 1 : y;
  return f[cy * px + cx];
}

/**
 * Separable box blur, run twice — that is a good enough Gaussian for a 256px
 * sprite and it is O(n) instead of O(n·r).
 */
function blur(f: Field, px: number, radius: number): Field {
  if (radius < 1) return f;
  const tmp = new Float32Array(px * px);
  const out = new Float32Array(px * px);
  const r = Math.round(radius);
  const inv = 1 / (r * 2 + 1);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += at(f, px, x + i, y);
      tmp[y * px + x] = s * inv;
    }
  }
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += at(tmp, px, x, y + i);
      out[y * px + x] = s * inv;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Shared tileable noise fields
 * ------------------------------------------------------------------ *
 * The naive version of this file called `fbm2` per pixel per tile. That is
 * correct and it costs 4.3 seconds of blocked main thread at the `high` tier —
 * a hitch the player sees as a hang, for textures nobody can tell apart from
 * the cheap version.
 *
 * So: bake four 128x128 *tileable* noise fields once (about 60 ms total), then
 * every sprite, flipbook frame and decal samples them bilinearly with its own
 * scale and offset. Sampling is two multiplies and four array reads, so the
 * whole texture set drops to roughly 200 ms — and because the fields are
 * resolution-independent they are shared across quality tiers too.
 *
 * Tileability matters because sprites sample at arbitrary offsets and a wrap
 * seam would show up as a hard line through a smoke puff. It is bought with
 * the standard four-quadrant cross-blend, then renormalised because that blend
 * eats about a third of the contrast.
 */

const FIELD_RES = 128;

/** Cross-blend a raw field with itself, offset by half, to make it wrap. */
function makeTileable(raw: Field, R: number): Field {
  const out = new Float32Array(R * R);
  const h = R >> 1;
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      const xr = (x + h) % R;
      const yr = (y + h) % R;
      const wx = x / R;
      const wy = y / R;
      const v =
        raw[y * R + x] * (1 - wx) * (1 - wy) +
        raw[y * R + xr] * wx * (1 - wy) +
        raw[yr * R + x] * (1 - wx) * wy +
        raw[yr * R + xr] * wx * wy;
      out[y * R + x] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  // Restore the contrast the blend cost us, back into [-1,1].
  const span = hi - lo || 1;
  for (let i = 0; i < out.length; i++) out[i] = ((out[i] - lo) / span) * 2 - 1;
  return out;
}

const fieldCache = new Map<string, Field>();

function bakeField(key: string, gen: (u: number, v: number) => number): Field {
  const hit = fieldCache.get(key);
  if (hit) return hit;
  const R = FIELD_RES;
  const raw = new Float32Array(R * R);
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) raw[y * R + x] = gen((x + 0.5) / R, (y + 0.5) / R);
  }
  const out = makeTileable(raw, R);
  fieldCache.set(key, out);
  return out;
}

/** Domain-warped fbm — stretched, sheared filaments. The smoke field. */
function fTurb(): Field {
  return bakeField("turb", (u, v) => {
    const D = 6;
    const wx = fbm2(u * D * 0.42 + 11.3, v * D * 0.42 - 4.7, 3, 2, 0.5, 91) * 0.9;
    const wy = fbm2(u * D * 0.42 - 7.1, v * D * 0.42 + 19.4, 3, 2, 0.5, 277) * 0.9;
    return fbm2(u * D + wx, v * D + wy, 5, 2.07, 0.52, 1337);
  });
}

/** High-frequency grain: powder, grit, paper crease, spall dust. */
function fFine(): Field {
  return bakeField("fine", (u, v) => fbm2(u * 11, v * 11, 3, 2.1, 0.5, 4801));
}

/** Ridged multifractal — flame licks and crack ridges. In [0,1]. */
function fRidge(): Field {
  return bakeField("ridge", (u, v) => ridged2(u * 5, v * 5, 4, 5501) * 2 - 1);
}

/** Cellular F1, remapped so 1 is a cell centre. Billows and blistering. */
function fCell(): Field {
  return bakeField("cell", (u, v) => {
    const w = worley2(u * 5, v * 5, 7717);
    return 1 - Math.min(1, w.f1 * 2.4) * 2;
  });
}

/** Wrapped bilinear sample. `u`/`v` tile at 1.0. */
function fs(f: Field, u: number, v: number): number {
  const R = FIELD_RES;
  let x = (u - Math.floor(u)) * R;
  let y = (v - Math.floor(v)) * R;
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const x1 = x0 + 1 === R ? 0 : x0 + 1;
  const y1 = y0 + 1 === R ? 0 : y0 + 1;
  const r0 = y0 * R;
  const r1 = y1 * R;
  const a = f[r0 + x0], b = f[r0 + x1], c = f[r1 + x0], d = f[r1 + x1];
  const top = a + (b - a) * fx;
  return top + (c + (d - c) * fx - top) * fy;
}

/** Seed → a decorrelated offset into a field. Golden-ratio, so it spreads. */
function offX(seed: number): number {
  return (seed * 0.6180339887498949) % 1;
}
function offY(seed: number): number {
  return (seed * 0.3819660112501051) % 1;
}

/**
 * Drop-in for `fbm2` inside the painters. The octave/lacunarity/gain arguments
 * are accepted and ignored — the field is pre-baked at fixed settings, and the
 * caller's *scale* is what actually controls how detailed the result looks.
 */
function nfbm(x: number, y: number, _o = 4, _l = 2, _g = 0.5, seed = 0): number {
  return fs(fTurb(), x * 0.16 + offX(seed), y * 0.16 + offY(seed));
}

/** Drop-in for `ridged2`, in [0,1]. */
function nridge(x: number, y: number, _o = 4, seed = 0): number {
  return fs(fRidge(), x * 0.16 + offX(seed), y * 0.16 + offY(seed)) * 0.5 + 0.5;
}

/** Drop-in for a worley F1 lookup: returns "how close to a cell centre", 0..1. */
function ncell(x: number, y: number, seed = 0): number {
  return fs(fCell(), x * 0.16 + offX(seed), y * 0.16 + offY(seed)) * 0.5 + 0.5;
}

/** Grain lookup for powder, grit and creases. */
function nfine(x: number, y: number, seed = 0): number {
  return fs(fFine(), x * 0.16 + offX(seed), y * 0.16 + offY(seed));
}

/** Domain-warped turbulence at an explicit frequency, in roughly [-1,1]. */
function turbulence(u: number, v: number, freq: number, seed: number): number {
  return fs(fTurb(), u * freq * 0.15 + offX(seed), v * freq * 0.15 + offY(seed));
}

/* ================================================================== *
 * Sprite atlas
 * ================================================================== */

/**
 * Tile indices into the shared particle atlas. The particle shader takes these
 * straight out of the per-instance `frameStart` slot, so the numbers are part
 * of the public contract — append, never renumber.
 */
export const Tile = {
  /** Soft, internally-shaded billow. The workhorse. */
  Smoke: 0,
  /** Hot, high-contrast ragged blob for fireball cores. */
  Fire: 1,
  /** Elongated streak, meant to be used with velocity stretching. */
  Spark: 2,
  /** Star flare with radial spikes — muzzle flashes, detonation flash. */
  Flash: 3,
  /** Flat, low-contrast, granular — kicked-up dirt and concrete dust. */
  Dust: 4,
  /** Cluster of droplets for water impacts and bay spray. */
  Splash: 5,
  /** Small hard-edged chip — visual (non-physical) debris. */
  Speck: 6,
  /** Thin bright ring with a soft compression halo — shockwaves. */
  Ring: 7,
  /** Irregular splat with satellites. */
  Blood: 8,
  /** Very soft wide falloff, near-zero contrast — heat haze and glow bloom. */
  Haze: 9,
  /** Vertical streak with a bright head — rain. */
  Drop: 10,
  /** Crumpled paper scrap silhouette — drifting litter. */
  Litter: 11,
  /** Distant bird silhouette, wings mid-beat. */
  Bird: 12,
  /** Perfect soft round dot — light glows, tracer heads. */
  Glow: 13,
  /** Thin torn wisp — ground fog, dissipating tails. */
  Wisp: 14,
  /** Tiny hot point with a subtle cross flare — embers. */
  Ember: 15,
} as const;
export type TileIndex = (typeof Tile)[keyof typeof Tile];

/** Atlas is 4x4 for both the sprite sheet and the flipbooks. */
export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 4;

/* ---- individual tile painters ------------------------------------ */

/**
 * Build a density field for a billowing puff: a radial falloff cut by
 * cellular-plus-turbulence detail, then eroded so the silhouette is torn
 * instead of circular.
 */
function puffDensity(px: number, seed: number, opts: {
  softness: number;   // 0 = hard rim, 1 = fog
  detail: number;     // fbm frequency in tile units
  erosion: number;    // how much noise eats the silhouette
  cell: number;       // worley contribution — gives distinct billows
}): Field {
  const f = field(px);
  const inv = 1 / px;
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      const dx = u - 0.5;
      const dy = v - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2; // 0 at centre, 1 at tile edge

      // Base: a wide plateau that falls off well inside the tile so the sprite
      // never clips against its own quad (clipped particles read as squares).
      let d = 1 - smoothstep(0.12 + opts.softness * 0.25, 0.96, r);

      const t = turbulence(u, v, opts.detail, seed);
      const billow = ncell(u * opts.cell, v * opts.cell, seed + 5501);

      d *= 0.62 + 0.5 * t + 0.34 * billow;
      // Erosion: subtract noise near the rim only, so the core stays dense and
      // the edge shreds. Uniform erosion just makes the whole sprite thinner.
      d -= opts.erosion * clamp01(r * 1.35) * (0.5 + 0.5 * turbulence(u, v, opts.detail * 2.3, seed + 733));
      f[y * px + x] = clamp01(d);
    }
  }
  return f;
}

/**
 * Shade a density field into RGBA. The normal comes from the density gradient,
 * which is physically nonsense but visually exactly right: it puts a lit crown
 * on top of every billow and a shadow under it, and that is the entire reason
 * real smoke reads as volume.
 */
function shadeDensity(
  img: ImageData,
  d: Field,
  px: number,
  o: {
    lx: number; ly: number;       // key direction in tile space
    ambient: number;              // floor luminance in shadow
    relief: number;               // gradient strength
    tint: [number, number, number];
    rim?: [number, number, number]; // optional warm rim toward the light
    alphaGain: number;
    alphaPow: number;
  },
): void {
  const data = img.data;
  const len = Math.hypot(o.lx, o.ly, 0.75) || 1;
  const lx = o.lx / len;
  const ly = o.ly / len;
  const lz = 0.75 / len;
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const i = y * px + x;
      const a0 = d[i];
      if (a0 <= 0.0015) {
        const p = i * 4;
        data[p] = 0; data[p + 1] = 0; data[p + 2] = 0; data[p + 3] = 0;
        continue;
      }
      const gx = at(d, px, x + 1, y) - at(d, px, x - 1, y);
      const gy = at(d, px, x, y + 1) - at(d, px, x, y - 1);
      let nx = -gx * o.relief;
      let ny = -gy * o.relief;
      const nl = Math.sqrt(nx * nx + ny * ny + 1);
      nx /= nl; ny /= nl;
      const nz = 1 / nl;
      const lam = clamp01(nx * lx + ny * ly + nz * lz);
      const lum = o.ambient + (1 - o.ambient) * (lam * lam * 0.65 + lam * 0.35);
      let r = o.tint[0] * lum;
      let g = o.tint[1] * lum;
      let b = o.tint[2] * lum;
      if (o.rim) {
        // Thin, dense edges scatter forward — the classic bright smoke rim.
        const rimAmt = clamp01((1 - a0) * a0 * 4) * clamp01(lam * 1.4);
        r += o.rim[0] * rimAmt;
        g += o.rim[1] * rimAmt;
        b += o.rim[2] * rimAmt;
      }
      const a = clamp01(Math.pow(a0, o.alphaPow) * o.alphaGain);
      const p = i * 4;
      data[p] = Math.min(255, r * 255) | 0;
      data[p + 1] = Math.min(255, g * 255) | 0;
      data[p + 2] = Math.min(255, b * 255) | 0;
      data[p + 3] = (a * 255) | 0;
    }
  }
}

function newImage(ctx: CanvasRenderingContext2D, px: number): ImageData {
  return ctx.createImageData(px, px);
}

/* ---- painters ----------------------------------------------------- */

function tileSmoke(ctx: CanvasRenderingContext2D, px: number, rng: Rng): ImageData {
  const seed = rng.int(0, 1e6);
  const d = blur(puffDensity(px, seed, { softness: 0.22, detail: 4.4, erosion: 0.55, cell: 3.1 }), px, px / 96);
  const img = newImage(ctx, px);
  shadeDensity(img, d, px, {
    lx: -0.55, ly: -0.72,
    ambient: 0.26, relief: px * 0.34,
    tint: [0.94, 0.94, 0.96],
    rim: [0.1, 0.09, 0.08],
    alphaGain: 1.0, alphaPow: 1.0,
  });
  return img;
}

function tileWisp(ctx: CanvasRenderingContext2D, px: number, rng: Rng): ImageData {
  const seed = rng.int(0, 1e6);
  const f = field(px);
  const inv = 1 / px;
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      // Anisotropic: stretched horizontally, thin vertically. Ground fog does
      // not billow, it lies down.
      const dx = (u - 0.5) * 2.05;
      const dy = (v - 0.5) * 3.4;
      const r = Math.sqrt(dx * dx + dy * dy);
      let d = 1 - smoothstep(0.05, 1.0, r);
      d *= 0.45 + 0.8 * turbulence(u * 1.0, v * 2.4, 3.0, seed);
      d -= 0.42 * clamp01(r);
      f[y * px + x] = clamp01(d);
    }
  }
  const img = newImage(ctx, px);
  shadeDensity(img, blur(f, px, px / 110), px, {
    lx: -0.4, ly: -0.5, ambient: 0.55, relief: px * 0.12,
    tint: [0.97, 0.97, 1.0], alphaGain: 0.8, alphaPow: 1.25,
  });
  return img;
}

function tileDust(ctx: CanvasRenderingContext2D, px: number, rng: Rng): ImageData {
  const seed = rng.int(0, 1e6);
  const d = blur(puffDensity(px, seed, { softness: 0.42, detail: 7.5, erosion: 0.4, cell: 5.2 }), px, px / 128);
  const img = newImage(ctx, px);
  // Dust has almost no self-shadowing — it is optically thin. Flat luminance
  // plus fine grain, or it reads as smoke.
  shadeDensity(img, d, px, {
    lx: -0.5, ly: -0.6, ambient: 0.72, relief: px * 0.1,
    tint: [1.0, 0.98, 0.94], alphaGain: 0.86, alphaPow: 1.15,
  });
  return img;
}

function tileFire(ctx: CanvasRenderingContext2D, px: number, rng: Rng): ImageData {
  const seed = rng.int(0, 1e6);
  const f = field(px);
  const inv = 1 / px;
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      const dx = u - 0.5, dy = v - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      let d = 1 - smoothstep(0.0, 0.92, r);
      const t = nridge(u * 5.5 + 3.1, v * 5.5 - 2.2, 4, seed);
      d *= 0.35 + 1.1 * t * t;
      d -= 0.5 * clamp01(r * 1.6) * (0.4 + 0.6 * turbulence(u, v, 9.0, seed + 17));
      f[y * px + x] = clamp01(d);
    }
  }
  const d = blur(f, px, px / 160);
  const img = newImage(ctx, px);
  const data = img.data;
  // Baked blackbody ramp: the densest part of the sprite is the hottest, and it
  // desaturates to white before it clips. Additive blending then does the rest.
  for (let i = 0; i < px * px; i++) {
    const a = d[i];
    const h = clamp01(a * 1.35);
    const r = clamp01(h * 3.2);
    const g = clamp01((h - 0.16) * 2.1);
    const b = clamp01((h - 0.62) * 2.6);
    const p = i * 4;
    data[p] = (r * 255) | 0;
    data[p + 1] = (g * 255) | 0;
    data[p + 2] = (b * 255) | 0;
    data[p + 3] = (clamp01(a * 1.25) * 255) | 0;
  }
  return img;
}

function tileSpark(ctx: CanvasRenderingContext2D, px: number, rng: Rng): ImageData {
  const img = newImage(ctx, px);
  const data = img.data;
  const inv = 1 / px;
  const seed = rng.int(0, 1e6);
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      // Vertical streak: the shader stretches along +Y for velocity-aligned
      // sparks, so the sprite must be tall, not wide.
      const dx = Math.abs(u - 0.5) * 2;
      const dy = (v - 0.5) * 2;
      const core = Math.exp(-dx * dx * 46);
      // Taper: bright head at v=0.35, fading tail downward.
      const along = clamp01(1 - Math.abs(dy + 0.28) * 0.92) * (1 - smoothstep(0.5, 1.0, Math.abs(dy)));
      const flick = 0.7 + 0.5 * nfine(v * 14, seed * 0.001, seed);
      const a = clamp01(core * along * flick);
      const p = (y * px + x) * 4;
      data[p] = 255;
      data[p + 1] = (clamp01(0.55 + a * 0.55) * 255) | 0;
      data[p + 2] = (clamp01(a * a * 0.9) * 255) | 0;
      data[p + 3] = (a * 255) | 0;
    }
  }
  return img;
}

function tileFlash(ctx: CanvasRenderingContext2D, px: number, rng: Rng): ImageData {
  const img = newImage(ctx, px);
  const data = img.data;
  const inv = 1 / px;
  const spikes = rng.int(6, 9);
  const phase = rng.range(0, Math.PI * 2);
  const jitter: number[] = [];
  for (let i = 0; i < spikes; i++) jitter.push(rng.range(0.45, 1.0));
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
      const r = Math.sqrt(dx * dx + dy * dy);
      const ang = Math.atan2(dy, dx);
      const core = Math.pow(clamp01(1 - r), 6) + Math.pow(clamp01(1 - r * 0.55), 26);
      // Radial spikes: a sum of narrow angular lobes, each with its own length.
      let star = 0;
      for (let i = 0; i < spikes; i++) {
        const a = phase + (i / spikes) * Math.PI * 2;
        let da = ang - a;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        const lobe = Math.exp(-da * da * 220);
        star += lobe * clamp01(1 - r / jitter[i]) * jitter[i];
      }
      const a = clamp01(core + star * 0.6);
      const p = (y * px + x) * 4;
      // Cool blue-white at the very core, warm at the tips — real flashes have
      // that gradient and it is what keeps them from looking like a white blob.
      const warm = clamp01(r * 1.6);
      data[p] = 255;
      data[p + 1] = (clamp01(1 - warm * 0.35) * 255) | 0;
      data[p + 2] = (clamp01(1 - warm * 0.85) * 255) | 0;
      data[p + 3] = (a * 255) | 0;
    }
  }
  return img;
}

function tileRing(ctx: CanvasRenderingContext2D, px: number, _rng: Rng): ImageData {
  const img = newImage(ctx, px);
  const data = img.data;
  const inv = 1 / px;
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
      const r = Math.sqrt(dx * dx + dy * dy);
      // Sharp leading edge at r=0.92, long soft trailing wash inward: that
      // asymmetry is what makes a ring read as *expanding*.
      const lead = Math.exp(-Math.pow((r - 0.9) * 26, 2));
      const wash = clamp01(1 - Math.abs(r - 0.62) * 3.1) * 0.32;
      const inner = clamp01(1 - r * 1.25) * 0.06;
      const a = clamp01(lead + wash + inner) * (1 - smoothstep(0.97, 1.0, r));
      const p = (y * px + x) * 4;
      data[p] = 255;
      data[p + 1] = (clamp01(0.72 + lead * 0.4) * 255) | 0;
      data[p + 2] = (clamp01(0.45 + lead * 0.6) * 255) | 0;
      data[p + 3] = (a * 255) | 0;
    }
  }
  return img;
}

function tileSplash(ctx: CanvasRenderingContext2D, px: number, rng: Rng): ImageData {
  const img = newImage(ctx, px);
  const f = field(px);
  const n = rng.int(9, 16);
  // Droplet cluster: elongated blobs radiating from just below centre, which
  // is where a real impact crown throws from.
  for (let i = 0; i < n; i++) {
    const ang = rng.range(-Math.PI * 0.95, -Math.PI * 0.05);
    const dist = rng.range(0.08, 0.42);
    const cx = 0.5 + Math.cos(ang) * dist;
    const cy = 0.62 + Math.sin(ang) * dist;
    const rr = rng.range(0.025, 0.075);
    const stretch = rng.range(1.2, 2.6);
    const sa = Math.sin(ang), ca = Math.cos(ang);
    const ext = rr * stretch + 0.01;
    const bx0 = Math.max(0, Math.floor((cx - ext) * px));
    const bx1 = Math.min(px - 1, Math.ceil((cx + ext) * px));
    const by0 = Math.max(0, Math.floor((cy - ext) * px));
    const by1 = Math.min(px - 1, Math.ceil((cy + ext) * px));
    for (let y = by0; y <= by1; y++) {
      const v = (y + 0.5) / px;
      for (let x = bx0; x <= bx1; x++) {
        const u = (x + 0.5) / px;
        const ex = u - cx, ey = v - cy;
        const lx = ex * ca + ey * sa;
        const ly = -ex * sa + ey * ca;
        const d = Math.sqrt((lx / stretch) * (lx / stretch) + ly * ly);
        const a = clamp01(1 - d / rr);
        const idx = y * px + x;
        if (a > f[idx]) f[idx] = a;
      }
    }
  }
  const d = blur(f, px, px / 180);
  const data = img.data;
  for (let i = 0; i < px * px; i++) {
    const a = clamp01(d[i] * 1.3);
    const p = i * 4;
    data[p] = 235; data[p + 1] = 244; data[p + 2] = 252;
    data[p + 3] = (a * 255) | 0;
  }
  return img;
}

function tileSpeck(ctx: CanvasRenderingContext2D, px: number, rng: Rng): ImageData {
  const img = newImage(ctx, px);
  const data = img.data;
  const seed = rng.int(0, 1e6);
  const inv = 1 / px;
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
      const ang = Math.atan2(dy, dx);
      // Irregular convex-ish silhouette: radius modulated by angular noise.
      const rad = 0.62 + 0.26 * nfbm(Math.cos(ang) * 2 + 5, Math.sin(ang) * 2 - 3, 3, 2, 0.5, seed);
      const r = Math.sqrt(dx * dx + dy * dy);
      const a = 1 - smoothstep(rad - 0.09, rad, r);
      // Faceted shading so a chip has a lit side and a dark side.
      const lum = 0.42 + 0.58 * clamp01(0.5 - dy * 0.7 - dx * 0.3);
      const p = (y * px + x) * 4;
      data[p] = (lum * 255) | 0;
      data[p + 1] = (lum * 250) | 0;
      data[p + 2] = (lum * 242) | 0;
      data[p + 3] = (a * 255) | 0;
    }
  }
  return img;
}

function tileBlood(ctx: CanvasRenderingContext2D, px: number, rng: Rng): ImageData {
  const img = newImage(ctx, px);
  const f = field(px);
  const seed = rng.int(0, 1e6);
  // Main body with a ragged, noise-modulated boundary.
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) / px;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) / px;
      const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
      const ang = Math.atan2(dy, dx);
      const rad = 0.5 + 0.2 * nfbm(Math.cos(ang) * 3, Math.sin(ang) * 3, 4, 2, 0.55, seed);
      const r = Math.sqrt(dx * dx + dy * dy);
      f[y * px + x] = 1 - smoothstep(rad - 0.06, rad, r);
    }
  }
  // Satellite droplets, biased outward — that is what makes it look thrown.
  // Each droplet only touches its own bounding box; scanning the whole tile 22
  // times over is 1.4 M wasted hypots for 22 blobs a few pixels across.
  for (let i = 0; i < 22; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const dist = rng.range(0.32, 0.48);
    const cx = 0.5 + Math.cos(ang) * dist;
    const cy = 0.5 + Math.sin(ang) * dist;
    const rr = rng.range(0.012, 0.05);
    const x0 = Math.max(0, Math.floor((cx - rr) * px));
    const x1 = Math.min(px - 1, Math.ceil((cx + rr) * px));
    const y0 = Math.max(0, Math.floor((cy - rr) * px));
    const y1 = Math.min(px - 1, Math.ceil((cy + rr) * px));
    for (let y = y0; y <= y1; y++) {
      const v = (y + 0.5) / px;
      for (let x = x0; x <= x1; x++) {
        const u = (x + 0.5) / px;
        const d = Math.hypot(u - cx, v - cy);
        const a = 1 - smoothstep(rr * 0.6, rr, d);
        const idx = y * px + x;
        if (a > f[idx]) f[idx] = a;
      }
    }
  }
  const data = img.data;
  for (let i = 0; i < px * px; i++) {
    const a = f[i];
    // Thin edges are brighter and more orange; the pooled centre goes almost
    // black-red. Uniform red reads as paint.
    const thick = a;
    const p = i * 4;
    data[p] = (clamp01(0.30 + (1 - thick) * 0.34) * 255) | 0;
    data[p + 1] = (clamp01(0.020 + (1 - thick) * 0.05) * 255) | 0;
    data[p + 2] = (clamp01(0.018 + (1 - thick) * 0.04) * 255) | 0;
    data[p + 3] = (clamp01(a * 1.1) * 255) | 0;
  }
  return img;
}

function tileHaze(ctx: CanvasRenderingContext2D, px: number, rng: Rng): ImageData {
  const img = newImage(ctx, px);
  const data = img.data;
  const seed = rng.int(0, 1e6);
  const inv = 1 / px;
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      const r = Math.hypot(u - 0.5, v - 0.5) * 2;
      const falloff = Math.pow(clamp01(1 - r), 2.2);
      // RG carry a low-amplitude normal so a consumer (the postfx refraction
      // pass) can use this same sprite as a distortion source.
      const n = turbulence(u, v, 6.5, seed);
      const nx = clamp01(0.5 + n * 0.5);
      const ny = clamp01(0.5 + turbulence(u + 3.7, v - 1.9, 6.5, seed + 41) * 0.5);
      const p = (y * px + x) * 4;
      data[p] = (nx * 255) | 0;
      data[p + 1] = (ny * 255) | 0;
      data[p + 2] = 255;
      data[p + 3] = (falloff * 190) | 0;
    }
  }
  return img;
}

function tileDrop(ctx: CanvasRenderingContext2D, px: number, _rng: Rng): ImageData {
  const img = newImage(ctx, px);
  const data = img.data;
  const inv = 1 / px;
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      const dx = Math.abs(u - 0.5) * 2;
      // Narrow vertical line with a slightly fatter, brighter head.
      const width = 0.06 + 0.05 * smoothstep(0.0, 0.25, v);
      const core = clamp01(1 - dx / width);
      const along = (1 - smoothstep(0.72, 1.0, v)) * smoothstep(0.0, 0.06, v);
      const a = clamp01(core * core * along);
      const p = (y * px + x) * 4;
      data[p] = 210; data[p + 1] = 226; data[p + 2] = 240;
      data[p + 3] = (a * 255) | 0;
    }
  }
  return img;
}

function tileLitter(ctx: CanvasRenderingContext2D, px: number, rng: Rng): ImageData {
  const img = newImage(ctx, px);
  const data = img.data;
  const seed = rng.int(0, 1e6);
  const inv = 1 / px;
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      // A crumpled quad: rectangle warped by noise, with creases shaded in.
      const wu = u + 0.09 * nfbm(u * 3, v * 3, 2, 2, 0.5, seed);
      const wv = v + 0.09 * nfbm(u * 3 + 9, v * 3 - 5, 2, 2, 0.5, seed + 3);
      const inside =
        (1 - smoothstep(0.72, 0.8, Math.abs(wu - 0.5) * 2)) *
        (1 - smoothstep(0.66, 0.76, Math.abs(wv - 0.5) * 2));
      const crease = 0.6 + 0.4 * Math.abs(nfbm(u * 7, v * 7, 3, 2, 0.5, seed + 77));
      const p = (y * px + x) * 4;
      const lum = clamp01(0.66 + crease * 0.34);
      data[p] = (lum * 236) | 0;
      data[p + 1] = (lum * 232) | 0;
      data[p + 2] = (lum * 220) | 0;
      data[p + 3] = (clamp01(inside) * 255) | 0;
    }
  }
  return img;
}

function tileBird(ctx: CanvasRenderingContext2D, px: number, _rng: Rng): ImageData {
  const img = newImage(ctx, px);
  const data = img.data;
  const inv = 1 / px;
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      const dx = (u - 0.5) * 2;
      const dy = (v - 0.5) * 2;
      // Two swept wings + a stub body: a gull at 200 m is four pixels of
      // silhouette, and anything more detailed is wasted.
      const wing = Math.abs(dy + 0.34 * Math.abs(dx) - 0.05 * dx * dx);
      const span = 1 - smoothstep(0.86, 1.0, Math.abs(dx));
      const thick = 1 - smoothstep(0.06, 0.16, wing);
      const body = 1 - smoothstep(0.1, 0.19, Math.hypot(dx * 1.9, dy));
      const a = clamp01(Math.max(thick * span, body));
      const p = (y * px + x) * 4;
      data[p] = 40; data[p + 1] = 42; data[p + 2] = 48;
      data[p + 3] = (a * 255) | 0;
    }
  }
  return img;
}

function tileGlow(ctx: CanvasRenderingContext2D, px: number, _rng: Rng): ImageData {
  const img = newImage(ctx, px);
  const data = img.data;
  const inv = 1 / px;
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      const r = Math.hypot(u - 0.5, v - 0.5) * 2;
      // Sum of a tight core and a wide halo — a single gaussian looks flat and
      // a single power curve looks like a hole.
      const a = clamp01(Math.pow(clamp01(1 - r), 2.6) * 0.55 + Math.exp(-r * r * 30) * 0.85);
      const p = (y * px + x) * 4;
      data[p] = 255; data[p + 1] = 255; data[p + 2] = 255;
      data[p + 3] = (a * 255) | 0;
    }
  }
  return img;
}

function tileEmber(ctx: CanvasRenderingContext2D, px: number, _rng: Rng): ImageData {
  const img = newImage(ctx, px);
  const data = img.data;
  const inv = 1 / px;
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
      const r = Math.hypot(dx, dy);
      const core = Math.exp(-r * r * 90);
      const flareH = Math.exp(-dy * dy * 900) * clamp01(1 - Math.abs(dx)) * 0.35;
      const flareV = Math.exp(-dx * dx * 900) * clamp01(1 - Math.abs(dy)) * 0.35;
      const a = clamp01(core + flareH + flareV);
      const p = (y * px + x) * 4;
      data[p] = 255;
      data[p + 1] = (clamp01(0.42 + core * 0.6) * 255) | 0;
      data[p + 2] = (clamp01(core * core * 0.7) * 255) | 0;
      data[p + 3] = (a * 255) | 0;
    }
  }
  return img;
}

const TILE_PAINTERS: Array<(ctx: CanvasRenderingContext2D, px: number, rng: Rng) => ImageData> = [
  tileSmoke, tileFire, tileSpark, tileFlash,
  tileDust, tileSplash, tileSpeck, tileRing,
  tileBlood, tileHaze, tileDrop, tileLitter,
  tileBird, tileGlow, tileWisp, tileEmber,
];

/* ================================================================== *
 * Flipbooks
 * ================================================================== */

/**
 * Generic flipbook baker. `paint(frame, t)` draws frame `i` at normalised time
 * `t`, returning a full-tile ImageData.
 *
 * Exported because fire, smoke and (later) water all want animated sheets and
 * the packing logic should exist exactly once.
 */
export function bakeFlipbook(
  tilePx: number,
  cols: number,
  rows: number,
  paint: (ctx: CanvasRenderingContext2D, px: number, t: number, i: number) => ImageData,
  name: string,
): THREE.Texture {
  const s = makeCanvas(tilePx * cols, tilePx * rows);
  if (!s) return fallbackTexture(name);
  const n = cols * rows;
  for (let i = 0; i < n; i++) {
    const img = paint(s.ctx, tilePx, i / n, i);
    s.ctx.putImageData(img, (i % cols) * tilePx, Math.floor(i / cols) * tilePx);
  }
  const tex = new THREE.CanvasTexture(s.canvas as HTMLCanvasElement);
  tex.name = name;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * A 16-frame billowing smoke cycle.
 *
 * The frames are not independent noise — that flickers horribly. Each frame is
 * the *same* turbulence field advected by a slowly rotating, slowly expanding
 * warp, so consecutive frames are correlated and the puff appears to churn.
 */
function paintSmokeFrame(ctx: CanvasRenderingContext2D, px: number, t: number, i: number): ImageData {
  const seed = 90210;
  const f = field(px);
  const inv = 1 / px;
  const grow = 1 - t * 0.22;                  // the puff spreads over its life
  const swirl = t * Math.PI * 0.65;
  const cs = Math.cos(swirl), sn = Math.sin(swirl);
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      let dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
      // Rotate the *sampling* frame, not the sprite, so the silhouette stays
      // put while the internal structure turns over.
      const ru = dx * cs - dy * sn;
      const rv = dx * sn + dy * cs;
      const r = Math.hypot(dx, dy) * grow;
      let d = 1 - smoothstep(0.16, 0.98, r);
      const tt = turbulence(ru * 0.5 + 0.5, rv * 0.5 + 0.5, 4.1 + t * 1.1, seed);
      const billow = ncell((ru * 0.5 + 0.5) * 3.0, (rv * 0.5 + 0.5) * 3.0 + t * 0.6, seed + 5501);
      d *= 0.58 + 0.55 * tt + 0.3 * billow;
      // Erosion accelerates with age — old smoke is holes held together by
      // wishful thinking.
      d -= (0.34 + t * 0.5) * clamp01(r * 1.2) * (0.5 + 0.5 * turbulence(ru + 4, rv - 2, 9, seed + 31));
      f[y * px + x] = clamp01(d);
    }
  }
  const img = ctx.createImageData(px, px);
  shadeDensity(img, blur(f, px, Math.max(1, px / 80)), px, {
    lx: -0.55, ly: -0.7,
    ambient: 0.24 + t * 0.1,
    relief: px * (0.4 - t * 0.16),
    tint: [0.95, 0.95, 0.97],
    rim: [0.12, 0.1, 0.085],
    alphaGain: 1.0 - t * 0.12,
    alphaPow: 1.0 + t * 0.35,
  });
  void i;
  return img;
}

/** A 16-frame fire cycle: rising, licking, breaking up. Additive. */
function paintFireFrame(ctx: CanvasRenderingContext2D, px: number, t: number, i: number): ImageData {
  const seed = 4242 + 0;
  const img = ctx.createImageData(px, px);
  const data = img.data;
  const inv = 1 / px;
  const rise = t * 1.3;
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      const dx = (u - 0.5) * 2;
      // Flame envelope: wide and hot at the base, pinched and cool at the tip.
      const h = 1 - v;                                  // 1 at bottom of tile
      const width = 0.92 * Math.pow(h, 0.55) * (1 - 0.25 * t);
      let d = clamp01(1 - Math.abs(dx) / Math.max(width, 1e-3));
      d *= smoothstep(0.0, 0.14, h) * (1 - smoothstep(0.62 + t * 0.2, 1.0, h));
      // Advected turbulence: the field scrolls upward, which is the entire
      // reason it reads as flame rather than as an orange triangle.
      const tt = nridge(u * 4.2 + 3.1, (v + rise) * 3.4, 4, seed);
      d *= 0.28 + 1.35 * tt * tt;
      d -= 0.42 * (1 - h) * (0.4 + 0.6 * turbulence(u * 1.4, v * 1.4 + rise, 8, seed + 11));
      d = clamp01(d);

      // Colour by temperature, and temperature falls with height.
      const temp = clamp01(d * (1.25 - (1 - h) * 0.55));
      const r = clamp01(temp * 3.4);
      const g = clamp01((temp - 0.18) * 2.0);
      const b = clamp01((temp - 0.68) * 2.8);
      const p = (y * px + x) * 4;
      data[p] = (r * 255) | 0;
      data[p + 1] = (g * 255) | 0;
      data[p + 2] = (b * 255) | 0;
      data[p + 3] = (clamp01(d * 1.2) * 255) | 0;
    }
  }
  void i;
  return img;
}

/* ================================================================== *
 * Decal atlas
 * ================================================================== */

/**
 * Decal tile indices. Same append-only rule as `Tile`.
 */
export const Decal = {
  ScorchLarge: 0,
  ScorchSmall: 1,
  HoleConcrete: 2,
  HoleMetal: 3,
  HoleGlass: 4,
  HoleWood: 5,
  BloodSplat: 6,
  BloodPool: 7,
  Oil: 8,
  TyreMark: 9,
  GraffitiA: 10,
  GraffitiB: 11,
  Crack: 12,
  WaterMark: 13,
  SootStreak: 14,
  DirtPatch: 15,
} as const;
export type DecalIndex = (typeof Decal)[keyof typeof Decal];

function decalScorch(ctx: CanvasRenderingContext2D, px: number, rng: Rng, big: boolean): ImageData {
  const img = ctx.createImageData(px, px);
  const data = img.data;
  const seed = rng.int(0, 1e6);
  const inv = 1 / px;
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
      const ang = Math.atan2(dy, dx);
      const r = Math.hypot(dx, dy);
      // Ragged boundary + radial soot streaks flung outward from the seat.
      const wob = 0.16 * nfbm(Math.cos(ang) * 2.4, Math.sin(ang) * 2.4, 4, 2, 0.55, seed);
      const rad = (big ? 0.82 : 0.66) + wob;
      let a = 1 - smoothstep(rad * 0.45, rad, r);
      const streak = clamp01(nfbm(ang * 5.5, r * 3.0, 4, 2.1, 0.5, seed + 401) * 1.6);
      a *= 0.55 + 0.65 * streak;
      // Hot centre is nearly pure carbon; the outer ring is grey ash.
      const carbon = clamp01(1 - r / (rad * 0.7));
      const lum = 0.055 + (1 - carbon) * 0.14 + 0.06 * nfbm(u * 22, v * 22, 3, 2, 0.5, seed + 9);
      const p = (y * px + x) * 4;
      data[p] = (clamp01(lum * 1.06) * 255) | 0;
      data[p + 1] = (clamp01(lum * 0.98) * 255) | 0;
      data[p + 2] = (clamp01(lum * 0.95) * 255) | 0;
      data[p + 3] = (clamp01(a * (big ? 0.94 : 0.88)) * 255) | 0;
    }
  }
  return img;
}

function decalHole(
  ctx: CanvasRenderingContext2D, px: number, rng: Rng,
  kind: "concrete" | "metal" | "glass" | "wood",
): ImageData {
  const img = ctx.createImageData(px, px);
  const data = img.data;
  const seed = rng.int(0, 1e6);
  const inv = 1 / px;
  const spall = kind === "concrete" ? 0.34 : kind === "wood" ? 0.26 : 0.12;
  const cracks = kind === "glass" ? 14 : kind === "concrete" ? 7 : kind === "wood" ? 5 : 0;
  const crackAng: number[] = [];
  const crackLen: number[] = [];
  for (let i = 0; i < cracks; i++) {
    crackAng.push(rng.range(0, Math.PI * 2));
    crackLen.push(rng.range(kind === "glass" ? 0.55 : 0.3, kind === "glass" ? 1.0 : 0.62));
  }
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const wob = 0.07 * nfbm(Math.cos(ang) * 4, Math.sin(ang) * 4, 3, 2, 0.5, seed);
      const holeR = 0.17 + wob;
      const spallR = holeR + spall;

      const hole = 1 - smoothstep(holeR * 0.82, holeR, r);
      const dust = (1 - smoothstep(spallR * 0.5, spallR, r)) *
        clamp01(0.35 + 0.9 * nfbm(u * 15, v * 15, 3, 2, 0.5, seed + 5));

      let crack = 0;
      const maxCrack = r > holeR * 0.8 ? 1 : 0;
      for (let i = 0; maxCrack > 0 && i < cracks; i++) {
        let da = ang - crackAng[i];
        da = Math.atan2(Math.sin(da), Math.cos(da));
        const line = Math.exp(-da * da * (kind === "glass" ? 900 : 380));
        crack = Math.max(crack, line * clamp01(1 - r / crackLen[i]));
      }

      const a = clamp01(hole + dust * 0.6 + crack * (kind === "glass" ? 0.85 : 0.5));
      // Hole is black; spall dust is the pale powder the round kicked out;
      // metal gets a bright torn lip instead.
      let lr: number, lg: number, lb: number;
      if (hole > 0.5) { lr = 0.03; lg = 0.028; lb = 0.026; }
      else if (kind === "metal") { lr = 0.72; lg = 0.73; lb = 0.75; }
      else if (kind === "wood") { lr = 0.26; lg = 0.17; lb = 0.1; }
      else if (kind === "glass") { lr = 0.86; lg = 0.9; lb = 0.94; }
      else { lr = 0.82; lg = 0.8; lb = 0.76; }
      const p = (y * px + x) * 4;
      data[p] = (lr * 255) | 0;
      data[p + 1] = (lg * 255) | 0;
      data[p + 2] = (lb * 255) | 0;
      data[p + 3] = (a * 255) | 0;
    }
  }
  return img;
}

function decalOil(ctx: CanvasRenderingContext2D, px: number, rng: Rng): ImageData {
  const img = ctx.createImageData(px, px);
  const data = img.data;
  const seed = rng.int(0, 1e6);
  const inv = 1 / px;
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2.2;
      const ang = Math.atan2(dy, dx);
      const r = Math.hypot(dx, dy);
      const rad = 0.68 + 0.22 * nfbm(Math.cos(ang) * 2, Math.sin(ang) * 2, 3, 2, 0.6, seed);
      const a = 1 - smoothstep(rad - 0.12, rad, r);
      // Thin-film iridescence at the edge — the one detail that makes an oil
      // slick unmistakably oil and not a shadow.
      const film = clamp01((1 - a) * a * 5);
      const ph = nfbm(u * 6, v * 6, 3, 2, 0.5, seed + 7) * 6.28;
      const p = (y * px + x) * 4;
      data[p] = (clamp01(0.045 + film * (0.4 + 0.4 * Math.sin(ph))) * 255) | 0;
      data[p + 1] = (clamp01(0.04 + film * (0.4 + 0.4 * Math.sin(ph + 2.1))) * 255) | 0;
      data[p + 2] = (clamp01(0.05 + film * (0.4 + 0.4 * Math.sin(ph + 4.2))) * 255) | 0;
      data[p + 3] = (clamp01(a * 0.92) * 255) | 0;
    }
  }
  return img;
}

function decalTyre(ctx: CanvasRenderingContext2D, px: number, rng: Rng): ImageData {
  const img = ctx.createImageData(px, px);
  const data = img.data;
  const seed = rng.int(0, 1e6);
  const inv = 1 / px;
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) * inv;
      // Two bands with a gap: that is a tyre's contact patch, not a stripe.
      const cu = Math.abs(u - 0.5) * 2;
      const band = (1 - smoothstep(0.62, 0.86, cu)) * (0.35 + 0.65 * smoothstep(0.05, 0.2, cu));
      const tread = 0.55 + 0.45 * Math.abs(Math.sin(v * Math.PI * 26 + nfbm(u * 4, v * 4, 2, 2, 0.5, seed) * 3));
      const wear = 0.5 + 0.7 * nfbm(u * 9, v * 3, 4, 2, 0.5, seed + 2);
      const a = clamp01(band * tread * wear * 0.9) * (1 - smoothstep(0.85, 1.0, Math.abs(v - 0.5) * 2));
      const p = (y * px + x) * 4;
      data[p] = 26; data[p + 1] = 25; data[p + 2] = 26;
      data[p + 3] = (a * 255) | 0;
    }
  }
  return img;
}

function decalGraffiti(ctx: CanvasRenderingContext2D, px: number, rng: Rng, variant: number): ImageData {
  const s = makeCanvas(px, px);
  // Falls back to a procedural scribble if we somehow have no canvas — but we
  // are already inside a canvas path, so this is just type-safety.
  const g = s ? s.ctx : ctx;
  g.clearRect(0, 0, px, px);
  const hues = variant === 0 ? [12, 198, 48] : [286, 92, 340];
  const strokes = rng.int(5, 9);
  g.lineCap = "round";
  g.lineJoin = "round";
  for (let i = 0; i < strokes; i++) {
    const hue = hues[i % hues.length] + rng.range(-14, 14);
    g.strokeStyle = `hsla(${hue}, ${rng.int(58, 92)}%, ${rng.int(38, 62)}%, ${rng.range(0.55, 0.95)})`;
    g.lineWidth = px * rng.range(0.035, 0.095);
    g.beginPath();
    let cx = px * rng.range(0.12, 0.4);
    let cy = px * rng.range(0.25, 0.75);
    g.moveTo(cx, cy);
    const segs = rng.int(3, 6);
    for (let k = 0; k < segs; k++) {
      const nx = cx + px * rng.range(0.08, 0.24);
      const ny = px * rng.range(0.2, 0.8);
      g.quadraticCurveTo(cx + px * rng.range(-0.1, 0.15), py(rng, px), nx, ny);
      cx = nx; cy = ny;
    }
    g.stroke();
  }
  // Overspray: a faint speckle halo, which is what actually sells spray paint.
  const img = g.getImageData(0, 0, px, px);
  const data = img.data;
  const seed = rng.int(0, 1e6);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const p = (y * px + x) * 4;
      if (data[p + 3] > 8) continue;
      const n = nfbm(x * 0.35, y * 0.35, 2, 2, 0.5, seed);
      if (n > 0.42) {
        data[p] = 120; data[p + 1] = 110; data[p + 2] = 116;
        data[p + 3] = ((n - 0.42) * 130) | 0;
      }
    }
  }
  return img;
}
function py(rng: Rng, px: number): number {
  return px * rng.range(0.15, 0.85);
}

function decalCrack(ctx: CanvasRenderingContext2D, px: number, rng: Rng): ImageData {
  const img = ctx.createImageData(px, px);
  const data = img.data;
  const seed = rng.int(0, 1e6);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) / px, v = (y + 0.5) / px;
      // The boundary between cells *is* the crack: the cell field peaks at
      // centres, so the crack is where it is closest to its mid value.
      const c = ncell(u * 5, v * 5, seed);
      const ridge = clamp01(1 - Math.abs(c - 0.42) * 9);
      const fade = 1 - smoothstep(0.55, 1.0, Math.hypot(u - 0.5, v - 0.5) * 2);
      const a = clamp01(ridge * fade * 0.85);
      const p = (y * px + x) * 4;
      data[p] = 30; data[p + 1] = 29; data[p + 2] = 30;
      data[p + 3] = (a * 255) | 0;
    }
  }
  return img;
}

function decalPatch(
  ctx: CanvasRenderingContext2D, px: number, rng: Rng,
  tint: [number, number, number], alpha: number, freq: number,
): ImageData {
  const img = ctx.createImageData(px, px);
  const data = img.data;
  const seed = rng.int(0, 1e6);
  for (let y = 0; y < px; y++) {
    const v = (y + 0.5) / px;
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) / px;
      const r = Math.hypot(u - 0.5, v - 0.5) * 2;
      const n = 0.5 + 0.5 * nfbm(u * freq, v * freq, 4, 2, 0.55, seed);
      const a = clamp01((1 - smoothstep(0.3, 0.95, r)) * n * alpha);
      const lum = 0.6 + 0.5 * nfbm(u * freq * 3, v * freq * 3, 3, 2, 0.5, seed + 3);
      const p = (y * px + x) * 4;
      data[p] = (clamp01(tint[0] * lum) * 255) | 0;
      data[p + 1] = (clamp01(tint[1] * lum) * 255) | 0;
      data[p + 2] = (clamp01(tint[2] * lum) * 255) | 0;
      data[p + 3] = (a * 255) | 0;
    }
  }
  return img;
}

/* ================================================================== *
 * Public cache
 * ================================================================== */

const cache = new Map<string, THREE.Texture>();

/**
 * Tile resolution by quality tier. The atlas is 4x this on each side.
 *
 * These are smaller than they look like they should be, on purpose. A particle
 * sprite is a soft blob that is almost never on screen at more than ~150 px,
 * and every doubling here quadruples a bake that blocks the main thread. 96 px
 * tiles (a 384² atlas) are indistinguishable in motion from 192 px ones.
 */
export function tilePxForTier(tier: QualityTier): number {
  switch (tier) {
    case "low": return 48;
    case "medium": return 64;
    case "ultra": return 128;
    default: return 96;
  }
}

/**
 * Decal tiles are bigger than particle tiles: a scorch mark on the ground sits
 * still, at a known scale, right under the player's feet, and it is the one
 * place a soft texture reads as a *blurry* texture.
 */
export function decalTilePxForTier(tier: QualityTier): number {
  switch (tier) {
    case "low": return 64;
    case "medium": return 96;
    case "ultra": return 192;
    default: return 128;
  }
}

function finish(tex: THREE.Texture, name: string, srgb: boolean): THREE.Texture {
  tex.name = name;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The shared 4x4 sprite atlas. Every non-flipbook particle in the game samples
 * this one texture; `Tile.*` indexes it.
 */
export function particleAtlas(tilePx = 128): THREE.Texture {
  const key = `atlas:${tilePx}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const s = makeCanvas(tilePx * ATLAS_COLS, tilePx * ATLAS_ROWS);
  if (!s) {
    const t = fallbackTexture(key);
    cache.set(key, t);
    return t;
  }
  const rng = makeRng("sf-vfx-atlas");
  for (let i = 0; i < TILE_PAINTERS.length; i++) {
    const img = TILE_PAINTERS[i](s.ctx, tilePx, rng.fork(`tile${i}`));
    s.ctx.putImageData(img, (i % ATLAS_COLS) * tilePx, Math.floor(i / ATLAS_COLS) * tilePx);
  }
  const tex = finish(new THREE.CanvasTexture(s.canvas as HTMLCanvasElement), key, true);
  cache.set(key, tex);
  return tex;
}

/** 16-frame billowing smoke flipbook (4x4). */
export function smokeFlipbook(tilePx = 128): THREE.Texture {
  const key = `smokebook:${tilePx}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const tex = bakeFlipbook(tilePx, 4, 4, paintSmokeFrame, key);
  cache.set(key, tex);
  return tex;
}

/** 16-frame flame flipbook (4x4). Additive. */
export function fireFlipbook(tilePx = 128): THREE.Texture {
  const key = `firebook:${tilePx}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const tex = bakeFlipbook(tilePx, 4, 4, paintFireFrame, key);
  cache.set(key, tex);
  return tex;
}

/** The 4x4 decal atlas; `Decal.*` indexes it. */
export function decalAtlas(tilePx = 128): THREE.Texture {
  const key = `decals:${tilePx}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const s = makeCanvas(tilePx * 4, tilePx * 4);
  if (!s) {
    const t = fallbackTexture(key);
    cache.set(key, t);
    return t;
  }
  const rng = makeRng("sf-vfx-decals");
  const painters: Array<(r: Rng) => ImageData> = [
    (r) => decalScorch(s.ctx, tilePx, r, true),
    (r) => decalScorch(s.ctx, tilePx, r, false),
    (r) => decalHole(s.ctx, tilePx, r, "concrete"),
    (r) => decalHole(s.ctx, tilePx, r, "metal"),
    (r) => decalHole(s.ctx, tilePx, r, "glass"),
    (r) => decalHole(s.ctx, tilePx, r, "wood"),
    (r) => tileBlood(s.ctx, tilePx, r),
    (r) => decalPatch(s.ctx, tilePx, r, [0.24, 0.028, 0.024], 0.95, 3.2),
    (r) => decalOil(s.ctx, tilePx, r),
    (r) => decalTyre(s.ctx, tilePx, r),
    (r) => decalGraffiti(s.ctx, tilePx, r, 0),
    (r) => decalGraffiti(s.ctx, tilePx, r, 1),
    (r) => decalCrack(s.ctx, tilePx, r),
    (r) => decalPatch(s.ctx, tilePx, r, [0.62, 0.66, 0.7], 0.5, 5.0),
    (r) => decalPatch(s.ctx, tilePx, r, [0.09, 0.085, 0.082], 0.7, 2.2),
    (r) => decalPatch(s.ctx, tilePx, r, [0.4, 0.34, 0.26], 0.6, 4.0),
  ];
  for (let i = 0; i < painters.length; i++) {
    const img = painters[i](rng.fork(`decal${i}`));
    s.ctx.putImageData(img, (i % 4) * tilePx, Math.floor(i / 4) * tilePx);
  }
  const tex = finish(new THREE.CanvasTexture(s.canvas as HTMLCanvasElement), key, true);
  cache.set(key, tex);
  return tex;
}

/**
 * A 1x64 gradient strip: the fire colour ramp, sampled by the ribbon-trail and
 * flame-sheet shaders so every system agrees on what "hot" looks like.
 * White-yellow core → orange → deep red → smoke grey.
 */
export function fireRampTexture(): THREE.DataTexture {
  const key = "fireramp";
  const hit = cache.get(key) as THREE.DataTexture | undefined;
  if (hit) return hit;
  const n = 64;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // Hand-placed stops, not a lerp between two colours: real flame has a
    // distinct yellow shelf that a two-point ramp always misses.
    let r: number, g: number, b: number;
    if (t < 0.12) { const k = t / 0.12; r = 1; g = 0.97 + 0.03 * (1 - k); b = 0.88 - 0.42 * k; }
    else if (t < 0.36) { const k = (t - 0.12) / 0.24; r = 1; g = 1 - 0.28 * k; b = 0.46 - 0.4 * k; }
    else if (t < 0.62) { const k = (t - 0.36) / 0.26; r = 1 - 0.06 * k; g = 0.72 - 0.42 * k; b = 0.06 - 0.03 * k; }
    else if (t < 0.84) { const k = (t - 0.62) / 0.22; r = 0.94 - 0.6 * k; g = 0.30 - 0.24 * k; b = 0.03 + 0.0 * k; }
    else { const k = (t - 0.84) / 0.16; r = 0.34 - 0.24 * k; g = 0.06 + 0.02 * k; b = 0.03 + 0.04 * k; }
    data[i * 4] = (clamp01(r) * 255) | 0;
    data[i * 4 + 1] = (clamp01(g) * 255) | 0;
    data[i * 4 + 2] = (clamp01(b) * 255) | 0;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = key;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

/**
 * A soft 1D falloff used as the ribbon-trail alpha profile (opaque core,
 * feathered edges). Separating this from the colour ramp lets a rocket trail
 * be white-hot at the nozzle and still feather correctly at its edges.
 */
export function trailProfileTexture(): THREE.DataTexture {
  const key = "trailprofile";
  const hit = cache.get(key) as THREE.DataTexture | undefined;
  if (hit) return hit;
  const n = 32;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const a = Math.pow(Math.sin(t * Math.PI), 0.65);
    data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255;
    data[i * 4 + 3] = (clamp01(a) * 255) | 0;
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = key;
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

/**
 * Bake every VFX texture for a tier ahead of time, yielding to the browser
 * between atlases.
 *
 * The whole set costs roughly half a second of main thread at `high`. That is
 * fine on a loading screen and unacceptable as a hitch the first time somebody
 * throws a grenade, so the integrator should call this from the same place it
 * calls `materials.preload()`. If it never does, the textures simply bake on
 * first use and the only cost is one bad frame.
 */
export async function preloadVfxTextures(
  tier: QualityTier,
  onProgress?: (fraction: number, label: string) => void,
): Promise<void> {
  const px = tilePxForTier(tier);
  const steps: Array<[string, () => void]> = [
    ["Painting smoke and fire", () => { particleAtlas(px); }],
    ["Animating the smoke sheet", () => { smokeFlipbook(px); }],
    ["Animating the flame sheet", () => { fireFlipbook(px); }],
    ["Scorching the pavement", () => { decalAtlas(decalTilePxForTier(tier)); }],
    ["Mixing the fire ramp", () => { fireRampTexture(); trailProfileTexture(); }],
  ];
  for (let i = 0; i < steps.length; i++) {
    onProgress?.(i / steps.length, steps[i][1] ? steps[i][0] : "");
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });
    try {
      steps[i][1]();
    } catch (err) {
      // One failed atlas must not take the level down; the cache falls back to
      // a flat white texture and the effect degrades rather than disappearing.
      console.error(`[sf/vfx] texture step failed: ${steps[i][0]}`, err);
    }
  }
  onProgress?.(1, "Ready");
}

/**
 * Free every generated texture. Called by the VFX root on unmount.
 *
 * The shared noise *fields* are deliberately kept: they are a few hundred
 * kilobytes, they are resolution- and tier-independent, and re-baking them on
 * every quality change would reintroduce the stall this design exists to avoid.
 */
export function disposeVfxTextures(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}

/** Bytes resident in VFX textures — for the debug overlay. */
export function vfxTextureBytes(): number {
  let total = 0;
  for (const t of cache.values()) {
    const img = (t as THREE.Texture & { image?: { width?: number; height?: number } }).image;
    const w = img?.width ?? 0;
    const h = img?.height ?? 0;
    total += w * h * 4 * 1.34; // +mips
  }
  return Math.round(total);
}
