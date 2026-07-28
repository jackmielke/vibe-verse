/**
 * San Palmas — the city.
 *
 * Everything between the shoreline and the hilltops: the street network, the
 * blocks it cuts, the buildings that fill them, the clutter that makes them
 * read as inhabited — and the broadphase every other system collides against.
 *
 * Four pieces, in dependency order:
 *
 *  1. THE BAKERY. Ten procedural material families (asphalt, pavement,
 *     clapboard, stucco, curtain wall, terracotta, corrugated steel, board
 *     concrete, mural, signage). Each is painted twice into a Canvas2D — once
 *     for albedo, once for a packed aux map — plus a height pass that becomes a
 *     tangent-space normal map. NO EXTERNAL ASSETS: every pixel is drawn here.
 *
 *     Aux packing is the glTF ORM convention, bent one notch:
 *       R = emissive mask   (which texels are windows/neon, and how lit)
 *       G = roughness       (three reads .g from `roughnessMap` natively)
 *       B = tint weight     (moved into the albedo map's alpha at bake time)
 *     The tint weight is what makes one clapboard texture serve six hundred
 *     differently painted Victorians: a per-vertex `aTrim` colour multiplies
 *     the albedo *only where the mask allows*, so the body takes the paint and
 *     the sash windows and the white trim do not.
 *
 *  2. THE NETWORK. `AVENUES` become terrain-conformed arterials; every entry in
 *     `DISTRICTS` gets a local grid laid on its own bearing. The grid is drawn
 *     in plan and *then* dropped onto `TerrainService.heightAt` — SF's surveyors
 *     ignored the topography and so do we, which is exactly where the signature
 *     hilltop descents come from. Roads carry a crowned carriageway, kerbs,
 *     pavements, a retaining skirt on the downhill side and crosswalk decals.
 *
 *  3. THE BLOCKS. The same grid lines that became streets bound the blocks.
 *     Each block is inset by the carriageway and the pavement, then its four
 *     edges are subdivided into lots and built out shoulder-to-shoulder. Lots
 *     are rejected against water, against the landmark reservations and against
 *     `districtAt`, which arbitrates wherever two district discs overlap.
 *
 *  4. THE BROADPHASE. One `Box3` per building lands in a uniform 24 m grid.
 *     Weapons raycast every projectile step and the player resolves a capsule
 *     every frame, so a linear scan over ~4000 boxes is not an option: capsule
 *     resolution queries the handful of cells its AABB touches, and `raycast`
 *     walks a 2-D DDA down the ray, stamping boxes so a box straddling four
 *     cells is still only intersected once.
 *
 * Reads: TerrainService (seating — nothing here assumes flat ground), SkyService
 * (window/neon glow follows dusk). Both optional; the module degrades to the
 * atlas and to daylight rather than throwing during boot.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre.
 */
import * as THREE from "three";
import type {
  CollisionService,
  QualityTier,
  RayHit,
  System,
  SystemFactory,
  TerrainService,
} from "../types";
import { makeRng } from "../types";
import {
  AVENUES,
  DISTRICTS,
  LANDMARKS,
  SEA_LEVEL,
  type District,
  districtAt,
  hillHeight,
  isWaterAt,
  landSignedDistance,
  shoreProfile,
} from "./atlas";

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

interface CityTier {
  /** Square resolution of every procedural material map. */
  tex: number;
  /** Fraction of buildable lots that actually get a building. */
  fill: number;
  /** Multiplier on street furniture counts. */
  props: number;
  /** Emit the expensive relief: bays, balconies, fire escapes, belt courses. */
  relief: boolean;
  /** Overhead trolley/power spans. */
  wires: boolean;
  /** Hard ceiling on buildings, so a big map can't melt a small GPU. */
  maxBuildings: number;
  aniso: number;
}

const TIERS: Record<QualityTier, CityTier> = {
  low: { tex: 256, fill: 0.62, props: 0.3, relief: false, wires: false, maxBuildings: 1500, aniso: 2 },
  medium: { tex: 384, fill: 0.82, props: 0.62, relief: true, wires: true, maxBuildings: 2600, aniso: 4 },
  high: { tex: 512, fill: 1.0, props: 1.0, relief: true, wires: true, maxBuildings: 4200, aniso: 8 },
  ultra: { tex: 768, fill: 1.0, props: 1.35, relief: true, wires: true, maxBuildings: 5200, aniso: 16 },
};

/** Carriageway sits this far proud of the terrain sample under it. */
const ROAD_LIFT = 0.08;
/** Kerb height. Anything smaller stops reading as a kerb at eye level. */
const KERB = 0.16;
/** Broadphase cell size, metres. Roughly one building frontage. */
const CELL = 24;
/** Streets are abandoned below this elevation — no roads in the surf. */
const MIN_ROAD_Y = SEA_LEVEL + 1.1;
/** Along-street sampling interval for terrain conformance. */
const ROAD_STEP = 13;

/**
 * Landmark reservations. The landmarks module owns these footprints; the city
 * must not build inside them (La Aguja at (430,-520) especially — that gap is
 * load-bearing for the downtown silhouette).
 */
const RESERVED: Record<string, number> = {
  pyramid: 86,
  coit: 64,
  ferry: 74,
  bridge: 230,
  alcatraz: 240,
};

/* ------------------------------------------------------------------------ *
 * Small maths
 * ------------------------------------------------------------------------ */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Integer hash on a wrapped lattice. Shared by every tileable noise below. */
function hash2(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise wrapping every `period` cells — the tiling guarantee. */
function vnoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  const top = a + (b - a) * u;
  return top + (c + (d - c) * u - top) * v;
}

/** Fractal value noise over UV in [0,1). Seamless across the texture edge. */
function fbmT(u: number, v: number, period: number, octaves: number, seed: number): number {
  let amp = 1, sum = 0, norm = 0, p = period;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(u * p, v * p, p, seed + o * 131) * amp;
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------------ *
 * Canvas painting
 * ------------------------------------------------------------------------ */
//
// Three canvases are painted per family in lockstep: albedo, aux and height.
// `style()` sets all three fill colours at once and `rect()` strokes all three
// in one call, so a window is authored as a single statement that knows it is
// dark, glossy, untintable and recessed. `rect()` wraps anything that crosses
// an edge, which is what keeps every map seamless without a post-pass.

type Ctx2D = CanvasRenderingContext2D;

interface Paint {
  a: Ctx2D;
  x: Ctx2D;
  h: Ctx2D;
  /** Texture resolution. */
  n: number;
  rng: () => number;
}

const css = (r: number, g: number, b: number) =>
  `rgb(${Math.round(clamp01(r) * 255)},${Math.round(clamp01(g) * 255)},${Math.round(clamp01(b) * 255)})`;

/** Set albedo / aux(glow,rough,tint) / height fills together. */
function style(p: Paint, r: number, g: number, b: number, glow: number, rough: number, tint: number, hgt: number) {
  p.a.fillStyle = css(r, g, b);
  p.x.fillStyle = css(glow, rough, tint);
  p.h.fillStyle = css(hgt, hgt, hgt);
}

/** Fill a rect into all three canvases, wrapping across the texture edges. */
function rect(p: Paint, x: number, y: number, w: number, h: number) {
  const n = p.n;
  const xs = x < 0 ? [x, x + n] : x + w > n ? [x, x - n] : [x];
  const ys = y < 0 ? [y, y + n] : y + h > n ? [y, y - n] : [y];
  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < ys.length; j++) {
      p.a.fillRect(xs[i], ys[j], w, h);
      p.x.fillRect(xs[i], ys[j], w, h);
      p.h.fillRect(xs[i], ys[j], w, h);
    }
  }
}

/** Albedo-only rect (stains, paint, posters) — leaves relief and gloss alone. */
function tone(p: Paint, r: number, g: number, b: number, alpha: number, x: number, y: number, w: number, h: number) {
  const n = p.n;
  p.a.save();
  p.a.globalAlpha = alpha;
  p.a.fillStyle = css(r, g, b);
  const xs = x < 0 ? [x, x + n] : x + w > n ? [x, x - n] : [x];
  const ys = y < 0 ? [y, y + n] : y + h > n ? [y, y - n] : [y];
  for (let i = 0; i < xs.length; i++) for (let j = 0; j < ys.length; j++) p.a.fillRect(xs[i], ys[j], w, h);
  p.a.restore();
}

/** Roughness-only rect — wet patches, polish, scuffs. */
function gloss(p: Paint, rough: number, alpha: number, x: number, y: number, w: number, h: number) {
  p.x.save();
  p.x.globalAlpha = alpha;
  p.x.fillStyle = css(0, rough, 0);
  p.x.globalCompositeOperation = "source-over";
  p.x.fillRect(x, y, w, h);
  p.x.restore();
}

function makeCanvas(size: number): Ctx2D | null {
  try {
    if (typeof document === "undefined") return null;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d", { willReadFrequently: true }) as Ctx2D | null;
    if (!g) return null;
    g.imageSmoothingEnabled = false;
    return g;
  } catch {
    return null;
  }
}

function readPixels(g: Ctx2D, size: number): Uint8ClampedArray | null {
  try {
    return g.getImageData(0, 0, size, size).data;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ *
 * Material families
 * ------------------------------------------------------------------------ */

const FAMILIES = [
  "asphalt",
  "pavement",
  "victorian",
  "stucco",
  "glass",
  "roof",
  "steel",
  "concrete",
  "mural",
  "sign",
  "paint",
] as const;
type Family = (typeof FAMILIES)[number];

/**
 * V-bands. A few families pack several surfaces into one map along V, which is
 * only safe where the geometry's V range is bounded by construction — road and
 * pavement ribbons run V *across* the strip, and signs are single quads.
 * Anything that tiles vertically (walls) gets a family to itself.
 */
const BAND = {
  /** Asphalt: marked carriageway, a zebra strip, then clean junction infill. */
  roadMarked: [0.005, 0.495] as const,
  zebra: [0.545, 0.725] as const,
  roadPlain: [0.745, 0.995] as const,
  /** Pavement: slabs, kerb stone, pool mosaic. */
  walk: [0.01, 0.32] as const,
  kerb: [0.35, 0.65] as const,
  pool: [0.68, 0.99] as const,
};

/* --- asphalt -------------------------------------------------------------- */

function paintAsphalt(p: Paint) {
  const n = p.n, rng = p.rng;
  const half = n * 0.5;

  // Two independent carriageways stacked in V: the top half carries markings,
  // the bottom half is clean tarmac for junction boxes and driveways.
  for (let band = 0; band < 2; band++) {
    const y0 = band * half;
    style(p, 0.20, 0.198, 0.198, 0, 0.9, 0, 0.5);
    rect(p, 0, y0, n, half);

    // Aggregate mottle — big slow blotches, then a fine chip pass.
    for (let i = 0; i < 220; i++) {
      const w = 6 + rng() * 44;
      tone(p, 0.30, 0.29, 0.28, 0.05 + rng() * 0.12, rng() * n, y0 + rng() * (half - w), w, w * (0.4 + rng()));
    }
    // Resurfacing patches: a slightly different mix, with a seam around them.
    for (let i = 0; i < 5; i++) {
      const w = n * (0.12 + rng() * 0.3), h = half * (0.2 + rng() * 0.5);
      const x = rng() * n, y = y0 + rng() * (half - h);
      style(p, 0.155, 0.155, 0.16, 0, 0.82, 0, 0.47);
      rect(p, x, y, w, h);
      style(p, 0.10, 0.10, 0.10, 0, 0.88, 0, 0.36);
      rect(p, x, y, w, 1.5);
      rect(p, x, y + h - 1.5, w, 1.5);
    }
    // Cracks — thin, branching, recessed.
    p.a.save(); p.h.save();
    p.a.strokeStyle = "rgb(24,24,25)";
    p.h.strokeStyle = "rgb(60,60,60)";
    p.a.lineWidth = p.h.lineWidth = Math.max(1, n / 340);
    for (let i = 0; i < 22; i++) {
      let x = rng() * n, y = y0 + rng() * half;
      p.a.beginPath(); p.h.beginPath();
      p.a.moveTo(x, y); p.h.moveTo(x, y);
      for (let k = 0; k < 5; k++) {
        x += (rng() - 0.5) * n * 0.12;
        y += (rng() - 0.5) * half * 0.16;
        p.a.lineTo(x, y); p.h.lineTo(x, y);
      }
      p.a.stroke(); p.h.stroke();
    }
    p.a.restore(); p.h.restore();

    // Wheel polish: two darker, glossier ribbons per lane.
    for (const t of [0.16, 0.30, 0.68, 0.84]) {
      const y = y0 + half * t;
      tone(p, 0.10, 0.10, 0.11, 0.30, 0, y - half * 0.035, n, half * 0.07);
      gloss(p, 0.62, 0.55, 0, y - half * 0.035, n, half * 0.07);
    }
    if (band === 1) continue;

    // --- markings (top band only) ---------------------------------------
    // Gutters first: a darker, wetter strip against each kerb.
    tone(p, 0.09, 0.10, 0.10, 0.5, 0, y0, n, half * 0.055);
    tone(p, 0.09, 0.10, 0.10, 0.5, 0, y0 + half * 0.945, n, half * 0.055);

    const paint = (r: number, g: number, b: number, y: number, h: number, dash: boolean) => {
      style(p, r, g, b, 0, 0.55, 0, 0.62);
      if (!dash) { rect(p, 0, y, n, h); return; }
      const period = n * 0.26;
      for (let x = 0; x < n; x += period) rect(p, x, y, period * 0.52, h);
    };
    const lw = Math.max(1.5, n * 0.008);
    // Double centre line, tropical ochre rather than US yellow.
    paint(0.86, 0.68, 0.16, y0 + half * 0.485 - lw * 1.6, lw, false);
    paint(0.86, 0.68, 0.16, y0 + half * 0.515 + lw * 0.6, lw, false);
    // Lane divisions.
    paint(0.90, 0.90, 0.87, y0 + half * 0.24, lw, true);
    paint(0.90, 0.90, 0.87, y0 + half * 0.76, lw, true);
    // Edge lines against the gutter.
    paint(0.88, 0.88, 0.85, y0 + half * 0.075, lw * 0.8, false);
    paint(0.88, 0.88, 0.85, y0 + half * 0.925 - lw * 0.8, lw * 0.8, false);
    // Wear: scuff the paint back so it never reads as freshly striped.
    for (let i = 0; i < 90; i++) {
      const w = 3 + rng() * 18;
      tone(p, 0.20, 0.20, 0.20, 0.35 + rng() * 0.45, rng() * n, y0 + rng() * half, w, 2 + rng() * 3);
    }
  }

  // --- zebra band ----------------------------------------------------------
  // Bars alternate along U, so a crosswalk decal is one quad whose U runs
  // across the carriageway. Worn asymmetrically, because the wheel paths eat
  // the paint long before the gutters do.
  const z0 = BAND.zebra[0] * n, z1 = BAND.zebra[1] * n;
  const bars = 8;
  const bw = n / bars;
  for (let i = 0; i < bars; i++) {
    style(p, 0.88, 0.88, 0.85, 0, 0.58, 0, 0.62);
    rect(p, i * bw + bw * 0.18, z0, bw * 0.60, z1 - z0);
    const wear = 0.25 + rng() * 0.55;
    tone(p, 0.20, 0.20, 0.20, wear, i * bw + bw * 0.18, z0 + (z1 - z0) * (0.25 + rng() * 0.3), bw * 0.60, (z1 - z0) * (0.12 + rng() * 0.22));
    for (let k = 0; k < 14; k++) {
      tone(p, 0.22, 0.22, 0.22, 0.2 + rng() * 0.5, i * bw + bw * (0.18 + rng() * 0.6), z0 + rng() * (z1 - z0), 2 + rng() * 6, 2 + rng() * 5);
    }
  }
}

/* --- pavement ------------------------------------------------------------- */

function paintPavement(p: Paint) {
  const n = p.n, rng = p.rng;
  const b0 = BAND.walk[0] * n, b1 = BAND.walk[1] * n;
  const k0 = BAND.kerb[0] * n, k1 = BAND.kerb[1] * n;
  const p0 = BAND.pool[0] * n, p1 = BAND.pool[1] * n;

  style(p, 0.63, 0.60, 0.55, 0, 0.88, 0, 0.5);
  rect(p, 0, 0, n, n);

  // --- slabs ---------------------------------------------------------------
  // Six bays along U, three across V: the joint spacing is the only human-scale
  // reference a pavement has, so it has to survive at grazing angles.
  const cols = 6, rows = 3;
  const cw = n / cols, rh = (b1 - b0) / rows;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const v = 0.58 + rng() * 0.14;
      style(p, v, v * 0.965, v * 0.90, 0, 0.86 + rng() * 0.09, 0, 0.60 + rng() * 0.10);
      rect(p, i * cw + 1, b0 + j * rh + 1, cw - 2, rh - 2);
    }
  }
  // Joints, cut into the height map so they read as grooves.
  style(p, 0.40, 0.38, 0.35, 0, 0.94, 0, 0.24);
  for (let i = 0; i <= cols; i++) rect(p, i * cw - 1, b0, 2, b1 - b0);
  for (let j = 0; j <= rows; j++) rect(p, 0, b0 + j * rh - 1, n, 2);
  // Grit, gum, moss in the joints, and the odd oil shadow.
  for (let i = 0; i < 260; i++) {
    const s = 1 + rng() * 4;
    tone(p, 0.35, 0.34, 0.30, 0.10 + rng() * 0.35, rng() * n, b0 + rng() * (b1 - b0), s, s);
  }
  for (let i = 0; i < 14; i++) {
    const s = 5 + rng() * 20;
    tone(p, 0.30, 0.36, 0.24, 0.16 + rng() * 0.2, rng() * n, b0 + rng() * (b1 - b0), s, s * 0.6);
  }

  // --- kerb stone ----------------------------------------------------------
  style(p, 0.55, 0.53, 0.49, 0, 0.80, 0, 0.55);
  rect(p, 0, k0, n, k1 - k0);
  const stone = n / 4.0;
  for (let i = 0; i < 4; i++) {
    const v = 0.50 + rng() * 0.12;
    style(p, v, v * 0.97, v * 0.92, 0, 0.78 + rng() * 0.1, 0, 0.58);
    rect(p, i * stone + 1.5, k0 + 1, stone - 3, k1 - k0 - 2);
  }
  // Chipped top arris + tyre rubber along the bottom.
  tone(p, 0.78, 0.76, 0.70, 0.5, 0, k0, n, Math.max(1, n * 0.006));
  tone(p, 0.16, 0.16, 0.17, 0.45, 0, k1 - n * 0.03, n, n * 0.03);
  for (let i = 0; i < 40; i++) {
    const s = 2 + rng() * 7;
    tone(p, 0.72, 0.70, 0.64, 0.5, rng() * n, k0 + rng() * (k1 - k0), s, s * 0.5);
  }

  // --- pool mosaic ---------------------------------------------------------
  style(p, 0.11, 0.52, 0.56, 0, 0.10, 0, 0.5);
  rect(p, 0, p0, n, p1 - p0);
  const tile = n / 16;
  for (let j = 0; j * tile < p1 - p0; j++) {
    for (let i = 0; i < 16; i++) {
      const t = rng();
      const r = 0.08 + t * 0.10, g = 0.50 + t * 0.24, b = 0.56 + t * 0.22;
      style(p, r, g, b, 0, 0.07 + rng() * 0.06, 0, 0.62);
      rect(p, i * tile + 0.8, p0 + j * tile + 0.8, tile - 1.6, tile - 1.6);
    }
  }
  // Caustic sheen, and grout darkened by the water.
  for (let i = 0; i < 60; i++) {
    tone(p, 0.85, 1.0, 0.98, 0.10 + rng() * 0.12, rng() * n, p0 + rng() * (p1 - p0), 6 + rng() * 26, 3 + rng() * 8);
  }
}

/* --- clapboard (the painted ladies) --------------------------------------- */

/**
 * One tile = 3 bays × 4 storeys. `VIC_FLOOR`/`VIC_BAY` are the metric contract
 * the building generator has to honour, or the sash windows land halfway
 * through a floor slab.
 */
const VIC_FLOOR = 3.4;
const VIC_BAY = 3.2;

function paintVictorian(p: Paint) {
  const n = p.n, rng = p.rng;
  const rows = 4, cols = 3;
  const rh = n / rows, cw = n / cols;

  // Body: near-white clapboard so the per-building tint has full range.
  style(p, 0.86, 0.845, 0.82, 0, 0.72, 1, 0.55);
  rect(p, 0, 0, n, n);

  // Horizontal siding: a groove every 190 mm with a soft shadow beneath.
  const boards = rows * 18;
  const bh = n / boards;
  for (let i = 0; i < boards; i++) {
    const y = i * bh;
    tone(p, 0.55, 0.54, 0.52, 0.30, 0, y + bh - 1.5, n, 1.5);
    style(p, 0.80, 0.79, 0.77, 0, 0.74, 1, 0.30);
    rect(p, 0, y + bh - 1.2, n, 1.2);
    tone(p, 1.0, 0.99, 0.96, 0.10, 0, y, n, bh * 0.35);
  }
  // Weathering: long vertical rain streaks and a little mildew low down.
  for (let i = 0; i < 26; i++) {
    const x = rng() * n;
    tone(p, 0.52, 0.51, 0.48, 0.05 + rng() * 0.10, x, 0, 1 + rng() * 5, n);
  }

  for (let r = 0; r < rows; r++) {
    // Floor line: a belt shadow so storeys are legible even in silhouette.
    style(p, 0.72, 0.71, 0.69, 0, 0.70, 0.55, 0.72);
    rect(p, 0, r * rh, n, Math.max(2, n * 0.008));
    tone(p, 0.35, 0.34, 0.32, 0.35, 0, r * rh + n * 0.008, n, n * 0.006);

    for (let c = 0; c < cols; c++) {
      const x = c * cw, y = r * rh;
      // Sash window: tall, narrow, deeply framed. Trim is only half-tintable so
      // it drifts toward the body colour without matching it.
      const ww = cw * 0.44, wh = rh * 0.56;
      const wx = x + (cw - ww) * 0.5, wy = y + rh * 0.24;
      const t = n * 0.012;
      style(p, 0.94, 0.93, 0.90, 0, 0.66, 0.42, 0.86);
      rect(p, wx - t * 2.2, wy - t * 2.2, ww + t * 4.4, wh + t * 4.4);
      // Pediment over the head and a projecting sill under it.
      style(p, 0.96, 0.95, 0.92, 0, 0.64, 0.42, 0.95);
      rect(p, wx - t * 3.4, wy - t * 4.6, ww + t * 6.8, t * 2.6);
      rect(p, wx - t * 3.0, wy + wh + t * 2.0, ww + t * 6.0, t * 2.2);

      // Glazing. Lit/unlit is decided per window here and read back through the
      // aux red channel, so no two buildings light the same pattern once their
      // UV offsets differ.
      const lit = rng() < 0.42 ? 0.45 + rng() * 0.55 : 0.0;
      const g = 0.10 + rng() * 0.05;
      style(p, g * 0.9, g, g * 1.25, lit, 0.09, 0, 0.16);
      rect(p, wx, wy, ww, wh);
      // Sky gradient in the glass — the cheapest possible fake reflection, and
      // the thing that stops windows reading as painted-on black rectangles.
      tone(p, 0.55, 0.72, 0.88, 0.42, wx, wy, ww, wh * 0.42);
      tone(p, 0.30, 0.40, 0.50, 0.30, wx, wy + wh * 0.42, ww, wh * 0.28);
      if (lit > 0) tone(p, 1.0, 0.86, 0.60, 0.35 + lit * 0.3, wx, wy, ww, wh);
      // Glazing bars: one vertical, one meeting rail.
      style(p, 0.93, 0.92, 0.89, 0, 0.60, 0.35, 0.66);
      rect(p, wx + ww * 0.5 - t * 0.35, wy, t * 0.7, wh);
      rect(p, wx, wy + wh * 0.5 - t * 0.35, ww, t * 0.7);
      // A blind, half the time, pulled to a random height.
      if (rng() < 0.45) {
        const bh2 = wh * (0.15 + rng() * 0.5);
        style(p, 0.80, 0.77, 0.70, 0, 0.85, 0.3, 0.2);
        rect(p, wx + 1, wy + 1, ww - 2, bh2);
      }
    }
  }
}

/* --- stucco (chinatown, mission, resort) ---------------------------------- */

const STU_FLOOR = 3.25;
const STU_BAY = 3.0;

function paintStucco(p: Paint) {
  const n = p.n, rng = p.rng;
  const rows = 4, cols = 4;
  const rh = n / rows, cw = n / cols;

  style(p, 0.88, 0.86, 0.81, 0, 0.90, 1, 0.55);
  rect(p, 0, 0, n, n);

  // Trowel texture: overlapping soft arcs, then a rough scatter.
  p.a.save();
  for (let i = 0; i < 420; i++) {
    const s = n * (0.02 + rng() * 0.09);
    p.a.globalAlpha = 0.03 + rng() * 0.06;
    p.a.fillStyle = rng() < 0.5 ? "rgb(255,252,244)" : "rgb(150,144,132)";
    p.a.beginPath();
    p.a.ellipse(rng() * n, rng() * n, s, s * (0.4 + rng() * 0.5), rng() * Math.PI, 0, Math.PI * 2);
    p.a.fill();
  }
  p.a.restore();

  for (let r = 0; r < rows; r++) {
    // Storey band: a shallow moulding, proud of the wall.
    style(p, 0.90, 0.88, 0.83, 0, 0.88, 0.85, 0.74);
    rect(p, 0, r * rh, n, Math.max(2, n * 0.010));
    tone(p, 0.42, 0.40, 0.36, 0.30, 0, r * rh + n * 0.010, n, n * 0.007);

    for (let c = 0; c < cols; c++) {
      const x = c * cw, y = r * rh;
      const ww = cw * 0.50, wh = rh * 0.50;
      const wx = x + (cw - ww) * 0.5, wy = y + rh * 0.27;
      const t = n * 0.010;
      // Reveal: the wall steps *back* into the opening — the height map does the
      // work, so the shading is correct from any sun angle.
      style(p, 0.80, 0.78, 0.73, 0, 0.90, 0.9, 0.38);
      rect(p, wx - t, wy - t, ww + t * 2, wh + t * 2);
      const lit = rng() < 0.38 ? 0.4 + rng() * 0.6 : 0.0;
      const g = 0.09 + rng() * 0.05;
      style(p, g, g * 1.05, g * 1.2, lit, 0.10, 0, 0.14);
      rect(p, wx, wy, ww, wh);
      tone(p, 0.50, 0.68, 0.84, 0.40, wx, wy, ww, wh * 0.45);
      if (lit > 0) tone(p, 1.0, 0.82, 0.52, 0.4 + lit * 0.3, wx, wy, ww, wh);
      // Sill, projecting.
      style(p, 0.92, 0.90, 0.85, 0, 0.85, 0.5, 0.92);
      rect(p, wx - t * 2, wy + wh, ww + t * 4, t * 2.2);
      // Security bars or a shutter, some of the time.
      if (rng() < 0.3) {
        style(p, 0.30, 0.29, 0.28, 0, 0.55, 0, 0.6);
        for (let k = 1; k < 5; k++) rect(p, wx + (ww * k) / 5 - 1, wy, 2, wh);
      } else if (rng() < 0.25) {
        style(p, 0.55, 0.42, 0.30, 0, 0.80, 0.6, 0.7);
        rect(p, wx, wy, ww, wh * (0.3 + rng() * 0.5));
      }
    }
  }
  // Damp rising up the base of the tile, and hairline crazing.
  for (let i = 0; i < 30; i++) {
    tone(p, 0.55, 0.52, 0.44, 0.06 + rng() * 0.12, rng() * n, n * 0.86, 8 + rng() * 60, n * 0.14);
  }
  p.a.save();
  p.a.strokeStyle = "rgba(90,86,78,0.35)";
  p.a.lineWidth = 1;
  for (let i = 0; i < 40; i++) {
    let x = rng() * n, y = rng() * n;
    p.a.beginPath();
    p.a.moveTo(x, y);
    for (let k = 0; k < 4; k++) { x += (rng() - 0.5) * 40; y += (rng() - 0.5) * 40; p.a.lineTo(x, y); }
    p.a.stroke();
  }
  p.a.restore();
}

/* --- curtain wall --------------------------------------------------------- */

const GLASS_FLOOR = 4.0;
const GLASS_BAY = 1.6;

function paintGlass(p: Paint) {
  const n = p.n, rng = p.rng;
  const rows = 6, cols = 8;
  const rh = n / rows, cw = n / cols;

  // Anodised aluminium frame behind everything.
  style(p, 0.34, 0.35, 0.36, 0, 0.42, 0.25, 0.72);
  rect(p, 0, 0, n, n);

  for (let r = 0; r < rows; r++) {
    // Spandrel: the opaque panel hiding the floor slab. Slightly warmer and
    // much rougher than the vision glass above it.
    style(p, 0.20, 0.22, 0.24, 0, 0.46, 0.35, 0.60);
    rect(p, 0, r * rh, n, rh * 0.26);
    tone(p, 0.06, 0.07, 0.08, 0.45, 0, r * rh + rh * 0.24, n, rh * 0.03);

    for (let c = 0; c < cols; c++) {
      const gx = c * cw + cw * 0.06, gy = r * rh + rh * 0.30;
      const gw = cw * 0.88, gh = rh * 0.64;
      const lit = rng() < 0.33 ? 0.35 + rng() * 0.65 : 0.0;
      // Vision glass: dark sea-green, very smooth, and taking a vertical sky
      // ramp so a tower gradates from bright at the top to deep at the base.
      const tintv = 0.055 + rng() * 0.035;
      style(p, tintv * 0.75, tintv * 1.25, tintv * 1.35, lit, 0.045, 0.12, 0.34);
      rect(p, gx, gy, gw, gh);
      tone(p, 0.42, 0.66, 0.82, 0.55 - (r / rows) * 0.30, gx, gy, gw, gh * 0.55);
      tone(p, 0.90, 0.80, 0.62, 0.10 + rng() * 0.10, gx, gy + gh * 0.55, gw, gh * 0.20);
      if (lit > 0) {
        tone(p, 1.0, 0.90, 0.68, 0.28 + lit * 0.25, gx, gy, gw, gh);
        // A silhouetted ceiling grid inside the lit floors.
        tone(p, 0.15, 0.13, 0.10, 0.25, gx, gy + gh * 0.10, gw, gh * 0.06);
      }
      // Blinds at a random drop on a third of the panels.
      if (rng() < 0.3) {
        style(p, 0.72, 0.70, 0.66, lit * 0.6, 0.70, 0.2, 0.36);
        rect(p, gx, gy, gw, gh * (0.2 + rng() * 0.55));
      }
    }
    // Mullion caps, proud of the glass line.
    style(p, 0.46, 0.47, 0.48, 0, 0.36, 0.2, 0.90);
    for (let c = 0; c <= cols; c++) rect(p, c * cw - n * 0.004, r * rh, n * 0.008, rh);
  }
  // Grime tracking down the mullions and a wash of horizontal streaking.
  for (let i = 0; i < 40; i++) {
    tone(p, 0.28, 0.28, 0.27, 0.05 + rng() * 0.10, rng() * n, rng() * n, 2 + rng() * 6, n * (0.2 + rng() * 0.6));
  }
}

/* --- terracotta ----------------------------------------------------------- */

function paintRoof(p: Paint) {
  const n = p.n, rng = p.rng;
  const rowsN = 7;
  const rh = n / rowsN;
  const pitchN = 12;
  const pw = n / pitchN;

  style(p, 0.36, 0.20, 0.13, 0, 0.86, 0.6, 0.30);
  rect(p, 0, 0, n, n);

  for (let r = 0; r < rowsN; r++) {
    // Courses lap downward, so each row overlaps the one below by a third.
    const y = r * rh;
    const stagger = (r % 2) * pw * 0.5;
    for (let c = 0; c < pitchN + 1; c++) {
      const x = c * pw + stagger;
      // Barrel tile: a lit crown falling to a shadowed valley on each side.
      const warm = 0.86 + rng() * 0.28;
      for (let k = 0; k < 7; k++) {
        const t = k / 6;
        const shade = Math.sin(t * Math.PI);
        const rr = (0.52 + 0.34 * shade) * warm;
        const gg = (0.24 + 0.20 * shade) * warm;
        const bb = (0.16 + 0.13 * shade) * warm;
        style(p, rr, gg, bb, 0, 0.84 - shade * 0.10, 0.55, 0.28 + shade * 0.62);
        rect(p, x + t * pw * 0.92, y, pw * 0.17, rh * 1.02);
      }
      // The lap shadow under the course above.
      tone(p, 0.14, 0.07, 0.05, 0.55, x, y, pw, rh * 0.20);
    }
    style(p, 0.16, 0.08, 0.05, 0, 0.9, 0.4, 0.12);
    rect(p, 0, y + rh - 1.5, n, 1.5);
  }
  // Lichen, salt bloom and sun-bleaching — a clean terracotta roof looks CG.
  for (let i = 0; i < 130; i++) {
    const s = 3 + rng() * 22;
    const g = rng() < 0.55;
    tone(p, g ? 0.42 : 0.72, g ? 0.46 : 0.70, g ? 0.26 : 0.64, 0.06 + rng() * 0.22, rng() * n, rng() * n, s, s * 0.7);
  }
}

/* --- corrugated steel ----------------------------------------------------- */

function paintSteel(p: Paint) {
  const n = p.n, rng = p.rng;
  style(p, 0.66, 0.66, 0.64, 0, 0.52, 1, 0.5);
  rect(p, 0, 0, n, n);

  // Ribs along V, 24 to the tile. The height map carries the true profile; the
  // albedo only carries the shading that survives a flat sun.
  const ribs = 24;
  const rw = n / ribs;
  for (let i = 0; i < ribs; i++) {
    for (let k = 0; k < 6; k++) {
      const t = k / 5;
      const shade = Math.sin(t * Math.PI);
      const v = 0.42 + shade * 0.36;
      style(p, v, v * 1.005, v * 0.985, 0, 0.46 - shade * 0.14, 1, 0.14 + shade * 0.80);
      rect(p, i * rw + t * rw * 0.86, 0, rw * 0.20, n);
    }
  }
  // Fixing lines: bolt heads every so often across the sheet.
  for (let j = 0; j < 5; j++) {
    const y = n * (0.08 + j * 0.21);
    for (let i = 0; i < ribs; i++) {
      style(p, 0.34, 0.33, 0.31, 0, 0.50, 0.5, 0.92);
      rect(p, i * rw + rw * 0.36, y, rw * 0.22, Math.max(2, n * 0.008));
    }
    tone(p, 0.20, 0.19, 0.17, 0.25, 0, y + n * 0.008, n, n * 0.006);
  }
  // Sheet joins every quarter, and rust bleeding down from them.
  for (let i = 1; i < 4; i++) {
    tone(p, 0.22, 0.21, 0.19, 0.5, 0, (n * i) / 4, n, Math.max(1, n * 0.005));
  }
  for (let i = 0; i < 55; i++) {
    const x = rng() * n, y = rng() * n;
    tone(p, 0.42, 0.20, 0.08, 0.10 + rng() * 0.32, x, y, 2 + rng() * 7, n * (0.05 + rng() * 0.35));
  }
  for (let i = 0; i < 120; i++) {
    const s = 2 + rng() * 9;
    tone(p, 0.30, 0.30, 0.29, 0.06 + rng() * 0.14, rng() * n, rng() * n, s, s);
  }
}

/* --- board-formed concrete ------------------------------------------------ */

function paintConcrete(p: Paint) {
  const n = p.n, rng = p.rng;
  style(p, 0.62, 0.60, 0.56, 0, 0.90, 1, 0.5);
  rect(p, 0, 0, n, n);

  // Shuttering boards: 8 horizontal lifts, each with its own tone and a
  // grout line at the joint. The single most recognisable concrete cue.
  const lifts = 8;
  const lh = n / lifts;
  for (let i = 0; i < lifts; i++) {
    const v = 0.55 + rng() * 0.14;
    style(p, v, v * 0.975, v * 0.93, 0, 0.88 + rng() * 0.08, 1, 0.55 + rng() * 0.08);
    rect(p, 0, i * lh + 1.5, n, lh - 3);
    style(p, 0.40, 0.39, 0.36, 0, 0.92, 1, 0.26);
    rect(p, 0, i * lh, n, 1.8);
    tone(p, 0.86, 0.85, 0.80, 0.20, 0, i * lh + 2, n, lh * 0.2);
    // Form-tie holes, two per lift.
    for (let k = 0; k < 2; k++) {
      const s = Math.max(2, n * 0.012);
      style(p, 0.34, 0.33, 0.30, 0, 0.9, 1, 0.18);
      rect(p, rng() * n, i * lh + lh * 0.5 - s * 0.5, s, s);
    }
  }
  // Blotching, water staining and a few spalled corners.
  for (let i = 0; i < 200; i++) {
    const s = 4 + rng() * 50;
    tone(p, rng() < 0.5 ? 0.42 : 0.80, rng() < 0.5 ? 0.41 : 0.78, 0.72, 0.03 + rng() * 0.10, rng() * n, rng() * n, s, s * (0.3 + rng()));
  }
  for (let i = 0; i < 20; i++) {
    tone(p, 0.30, 0.29, 0.26, 0.10 + rng() * 0.18, rng() * n, rng() * n, 3 + rng() * 8, n * (0.1 + rng() * 0.5));
  }
}

/* --- murals --------------------------------------------------------------- */

/** Mission palette: hot, saturated, poster-flat. Deliberately not tintable. */
const MURAL_INKS: [number, number, number][] = [
  [0.92, 0.24, 0.20], [0.96, 0.62, 0.12], [0.98, 0.84, 0.24],
  [0.16, 0.58, 0.44], [0.10, 0.36, 0.58], [0.62, 0.20, 0.52],
  [0.98, 0.94, 0.86], [0.10, 0.12, 0.16],
];

function paintMural(p: Paint) {
  const n = p.n, rng = p.rng;
  const ink = (i: number) => MURAL_INKS[i % MURAL_INKS.length];

  const bg = ink(Math.floor(rng() * 8));
  style(p, bg[0] * 0.7, bg[1] * 0.7, bg[2] * 0.7, 0, 0.86, 0, 0.5);
  rect(p, 0, 0, n, n);

  // Rays from a low sun — the compositional spine of half the murals in the
  // Mission, and it gives the wall a focal point from across the street.
  const cx = n * (0.2 + rng() * 0.6), cy = n * (0.55 + rng() * 0.3);
  const rays = 12 + Math.floor(rng() * 8);
  p.a.save();
  for (let i = 0; i < rays; i++) {
    const c = ink(i);
    p.a.fillStyle = css(c[0], c[1], c[2]);
    p.a.globalAlpha = 0.85;
    p.a.beginPath();
    p.a.moveTo(cx, cy);
    const a0 = (i / rays) * Math.PI * 2, a1 = a0 + (Math.PI * 2) / rays;
    p.a.lineTo(cx + Math.cos(a0) * n * 2, cy + Math.sin(a0) * n * 2);
    p.a.lineTo(cx + Math.cos(a1) * n * 2, cy + Math.sin(a1) * n * 2);
    p.a.closePath();
    p.a.fill();
  }
  // Banded arcs over the top, then leaf/wave silhouettes.
  for (let i = 0; i < 5; i++) {
    const c = ink(Math.floor(rng() * 8));
    p.a.strokeStyle = css(c[0], c[1], c[2]);
    p.a.globalAlpha = 0.9;
    p.a.lineWidth = n * (0.015 + rng() * 0.04);
    p.a.beginPath();
    p.a.arc(cx, cy, n * (0.12 + i * 0.11), 0, Math.PI * 2);
    p.a.stroke();
  }
  for (let i = 0; i < 22; i++) {
    const c = ink(Math.floor(rng() * 8));
    p.a.fillStyle = css(c[0], c[1], c[2]);
    p.a.globalAlpha = 0.75 + rng() * 0.25;
    const x = rng() * n, y = rng() * n;
    const w = n * (0.05 + rng() * 0.16), h = n * (0.10 + rng() * 0.35);
    p.a.save();
    p.a.translate(x, y);
    p.a.rotate((rng() - 0.5) * 2.2);
    p.a.beginPath();
    p.a.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
    p.a.fill();
    p.a.restore();
  }
  p.a.restore();

  // The wall underneath still has to behave like a wall: uniform matte finish,
  // a shallow render texture and a scatter of paint loss at the base.
  style(p, 0, 0.88, 0, 0, 0.88, 0, 0.5);
  p.x.fillStyle = css(0, 0.88, 0);
  p.x.fillRect(0, 0, n, n);
  p.h.fillStyle = css(0.5, 0.5, 0.5);
  p.h.fillRect(0, 0, n, n);
  for (let i = 0; i < 700; i++) {
    const s = 1 + rng() * 3;
    const v = 0.5 + (rng() - 0.5) * 0.22;
    p.h.fillStyle = css(v, v, v);
    p.h.fillRect(rng() * n, rng() * n, s, s);
  }
  for (let i = 0; i < 60; i++) {
    tone(p, 0.55, 0.52, 0.47, 0.10 + rng() * 0.25, rng() * n, n * (0.7 + rng() * 0.3), 4 + rng() * 24, 4 + rng() * 24);
  }
}

/* --- signage -------------------------------------------------------------- */

/** 4×4 atlas. Cells 12..15 are reserved for lamp/traffic lenses. */
const SIGN_COLS = 4;

function paintSign(p: Paint) {
  const n = p.n, rng = p.rng;
  const cell = n / SIGN_COLS;

  style(p, 0.06, 0.06, 0.07, 0, 0.6, 0, 0.5);
  rect(p, 0, 0, n, n);

  const neon: [number, number, number][] = [
    [1.0, 0.22, 0.20], [1.0, 0.72, 0.16], [0.30, 1.0, 0.62],
    [0.34, 0.72, 1.0], [1.0, 0.36, 0.78], [0.98, 0.92, 0.60],
  ];

  for (let idx = 0; idx < 16; idx++) {
    const cx0 = (idx % SIGN_COLS) * cell;
    const cy0 = Math.floor(idx / SIGN_COLS) * cell;
    const pad = cell * 0.05;

    if (idx >= 12) {
      // Lenses: a bright disc on a dark housing. Used by lamp heads and the
      // three signal aspects, so they must be flat and fully emissive.
      const lens: [number, number, number] =
        idx === 12 ? [1.0, 0.20, 0.16] : idx === 13 ? [1.0, 0.66, 0.12] :
        idx === 14 ? [0.30, 1.0, 0.48] : [1.0, 0.92, 0.74];
      style(p, 0.05, 0.05, 0.05, 0, 0.7, 0, 0.5);
      rect(p, cx0, cy0, cell, cell);
      p.a.fillStyle = css(lens[0], lens[1], lens[2]);
      p.x.fillStyle = css(1, 0.25, 0);
      p.a.beginPath(); p.a.arc(cx0 + cell / 2, cy0 + cell / 2, cell * 0.36, 0, Math.PI * 2); p.a.fill();
      p.x.beginPath(); p.x.arc(cx0 + cell / 2, cy0 + cell / 2, cell * 0.36, 0, Math.PI * 2); p.x.fill();
      continue;
    }

    // Board: a saturated field, a border tube, and abstract glyph strokes. Real
    // lettering would be unreadable at the scale these are seen from — the
    // rhythm of the strokes is what says "signage".
    const c = neon[idx % neon.length];
    const back = rng() < 0.5 ? [0.06, 0.05, 0.08] : [0.55 * c[0], 0.30 * c[1], 0.22 * c[2]];
    style(p, back[0], back[1], back[2], 0.04, 0.42, 0, 0.55);
    rect(p, cx0 + pad, cy0 + pad, cell - pad * 2, cell - pad * 2);

    const glowStroke = (x: number, y: number, w: number, h: number, bright: number) => {
      style(p, c[0], c[1], c[2], bright, 0.28, 0, 0.78);
      rect(p, x, y, w, h);
    };
    // Border tube.
    const b = Math.max(2, cell * 0.035);
    glowStroke(cx0 + pad, cy0 + pad, cell - pad * 2, b, 0.95);
    glowStroke(cx0 + pad, cy0 + cell - pad - b, cell - pad * 2, b, 0.95);
    glowStroke(cx0 + pad, cy0 + pad, b, cell - pad * 2, 0.95);
    glowStroke(cx0 + cell - pad - b, cy0 + pad, b, cell - pad * 2, 0.95);

    // Glyph rows: vertical for a hanging blade sign, horizontal for a fascia.
    const vertical = idx % 3 === 0;
    const gl = cell * 0.10;
    if (vertical) {
      const rows = 4;
      for (let r = 0; r < rows; r++) {
        const y = cy0 + cell * (0.16 + r * 0.19);
        for (let s = 0; s < 3; s++) {
          if (rng() < 0.35) continue;
          glowStroke(cx0 + cell * (0.34 + s * 0.12), y, gl * 0.9, gl * 0.28, 0.85);
        }
        if (rng() < 0.7) glowStroke(cx0 + cell * 0.44, y - gl * 0.3, gl * 0.24, gl * 0.9, 0.85);
      }
    } else {
      for (let s = 0; s < 5; s++) {
        const x = cx0 + cell * (0.14 + s * 0.16);
        const hgt = cell * (0.20 + rng() * 0.28);
        glowStroke(x, cy0 + cell * 0.34, gl * 0.30, hgt, 0.9);
        if (rng() < 0.6) glowStroke(x, cy0 + cell * 0.34, gl * 0.85, gl * 0.25, 0.9);
        if (rng() < 0.5) glowStroke(x, cy0 + cell * 0.34 + hgt * 0.5, gl * 0.7, gl * 0.22, 0.9);
      }
    }
    // Dead tubes and dirt: a sign that is 100% lit reads as a render.
    if (rng() < 0.4) {
      tone(p, 0.05, 0.05, 0.06, 0.55, cx0 + pad, cy0 + cell * (0.2 + rng() * 0.5), cell - pad * 2, cell * 0.09);
    }
  }
}

/* --- enamel paint --------------------------------------------------------- */
//
// Vehicles, awnings, painted ironwork. Fully tintable, near-white, with a
// clearcoat's worth of gloss and just enough orange-peel in the normal map to
// catch a moving highlight — a perfectly smooth car body reads as plastic.

function paintPaint(p: Paint) {
  const n = p.n, rng = p.rng;
  style(p, 0.92, 0.92, 0.92, 0, 0.20, 1, 0.5);
  rect(p, 0, 0, n, n);
  p.h.save();
  for (let i = 0; i < 900; i++) {
    const s = n * (0.01 + rng() * 0.05);
    const v = 0.5 + (rng() - 0.5) * 0.16;
    p.h.globalAlpha = 0.35;
    p.h.fillStyle = css(v, v, v);
    p.h.beginPath();
    p.h.ellipse(rng() * n, rng() * n, s, s * (0.6 + rng() * 0.6), 0, 0, Math.PI * 2);
    p.h.fill();
  }
  p.h.restore();
  // Metallic flake and a scatter of stone chips and swirl marks.
  for (let i = 0; i < 900; i++) {
    tone(p, 1, 1, 1, 0.05 + rng() * 0.10, rng() * n, rng() * n, 1, 1);
  }
  for (let i = 0; i < 40; i++) {
    tone(p, 0.55, 0.53, 0.50, 0.2 + rng() * 0.4, rng() * n, rng() * n, 1 + rng() * 3, 1 + rng() * 3);
  }
  for (let i = 0; i < 26; i++) {
    gloss(p, 0.34, 0.35, rng() * n, rng() * n, 4 + rng() * 40, 4 + rng() * 40);
  }
}

const PAINTERS: Record<Family, (p: Paint) => void> = {
  asphalt: paintAsphalt,
  pavement: paintPavement,
  victorian: paintVictorian,
  stucco: paintStucco,
  glass: paintGlass,
  roof: paintRoof,
  steel: paintSteel,
  concrete: paintConcrete,
  mural: paintMural,
  sign: paintSign,
  paint: paintPaint,
};

/** Normal-map strength per family, in height-units per texel. */
const RELIEF: Record<Family, number> = {
  asphalt: 0.7, pavement: 1.6, victorian: 2.1, stucco: 1.8, glass: 2.4,
  roof: 3.0, steel: 3.4, concrete: 1.2, mural: 0.5, sign: 1.2, paint: 0.5,
};

/* ------------------------------------------------------------------------ *
 * Texture bakery
 * ------------------------------------------------------------------------ */

interface FamilyMaps {
  /** RGB albedo, A = tint weight (see the header note on the aux packing). */
  map: THREE.Texture;
  normal: THREE.Texture;
  /** R = emissive mask, G = roughness. Bound as `roughnessMap`. */
  aux: THREE.Texture;
}

function finish(tex: THREE.DataTexture, srgb: boolean, aniso: number): THREE.DataTexture {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** A flat stand-in so a headless or canvas-less context still boots. */
function flatTexture(r: number, g: number, b: number, a: number, srgb: boolean): THREE.DataTexture {
  const d = new Uint8Array([r * 255, g * 255, b * 255, a * 255]);
  return finish(new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat), srgb, 1);
}

/**
 * Tangent-space normals from the height canvas, by wrapped central difference.
 * Wrapped, because a normal map with a seam is worse than no normal map at all.
 */
function normalFromHeight(px: Uint8ClampedArray, size: number, strength: number, aniso: number): THREE.DataTexture {
  const out = new Uint8Array(size * size * 4);
  const s = strength / 255;
  for (let y = 0; y < size; y++) {
    const yc = y * size, yp = ((y + 1) % size) * size, yn = ((y - 1 + size) % size) * size;
    for (let x = 0; x < size; x++) {
      const xp = (x + 1) % size, xn = (x - 1 + size) % size;
      const dx = (px[(yc + xp) * 4] - px[(yc + xn) * 4]) * s;
      const dy = (px[(yp + x) * 4] - px[(yn + x) * 4]) * s;
      let nx = -dx, ny = -dy, nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv; nz *= inv;
      const o = (yc + x) * 4;
      out[o] = (nx * 0.5 + 0.5) * 255;
      out[o + 1] = (ny * 0.5 + 0.5) * 255;
      out[o + 2] = (nz * 0.5 + 0.5) * 255;
      out[o + 3] = 255;
    }
  }
  return finish(new THREE.DataTexture(out, size, size, THREE.RGBAFormat), false, aniso);
}

/**
 * Paint one family and lift it onto the GPU.
 *
 * The grain pass at the end runs on the pixel arrays rather than the canvas
 * because it is evaluated from a wrapped integer lattice — canvas noise drawn
 * as sprites would break the seam the wrapped `rect()` works so hard to keep.
 */
function bakeFamily(fam: Family, size: number, aniso: number, rng: () => number): FamilyMaps {
  const ga = makeCanvas(size), gx = makeCanvas(size), gh = makeCanvas(size);
  if (!ga || !gx || !gh) {
    return {
      map: flatTexture(0.62, 0.58, 0.52, 1, true),
      normal: flatTexture(0.5, 0.5, 1, 1, false),
      aux: flatTexture(0, 0.85, 1, 1, false),
    };
  }
  const p: Paint = { a: ga, x: gx, h: gh, n: size, rng };
  try {
    PAINTERS[fam](p);
  } catch {
    /* a family that fails to paint still ships a usable surface */
  }

  const albedo = readPixels(ga, size);
  const auxPx = readPixels(gx, size);
  const hgtPx = readPixels(gh, size);
  if (!albedo || !auxPx || !hgtPx) {
    return {
      map: flatTexture(0.62, 0.58, 0.52, 1, true),
      normal: flatTexture(0.5, 0.5, 1, 1, false),
      aux: flatTexture(0, 0.85, 1, 1, false),
    };
  }

  // Grain: a two-octave tileable field modulating albedo and height. Every
  // family gets it — uniform texel-level flatness is the loudest CG tell there
  // is, and it costs one multiply.
  const seed = (rng() * 1e6) | 0;
  const mapData = new Uint8Array(size * size * 4);
  const auxData = new Uint8Array(size * size * 4);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const o = i * 4;
      const g = fbmT((x + 0.5) * inv, (y + 0.5) * inv, 24, 3, seed) - 0.5;
      const m = 1 + g * 0.16;
      mapData[o] = Math.min(255, albedo[o] * m);
      mapData[o + 1] = Math.min(255, albedo[o + 1] * m);
      mapData[o + 2] = Math.min(255, albedo[o + 2] * m);
      // Tint weight rides in alpha, where the sRGB transfer never touches it.
      mapData[o + 3] = auxPx[o + 2];
      auxData[o] = auxPx[o];
      auxData[o + 1] = auxPx[o + 1];
      auxData[o + 2] = auxPx[o + 2];
      auxData[o + 3] = 255;
      // Fold the same field into the height so the relief grains too.
      hgtPx[o] = Math.max(0, Math.min(255, hgtPx[o] + g * 26));
    }
  }

  return {
    map: finish(new THREE.DataTexture(mapData, size, size, THREE.RGBAFormat), true, aniso),
    normal: normalFromHeight(hgtPx, size, RELIEF[fam] * (size / 256), aniso),
    aux: finish(new THREE.DataTexture(auxData, size, size, THREE.RGBAFormat), false, aniso),
  };
}

/* ------------------------------------------------------------------------ *
 * Materials
 * ------------------------------------------------------------------------ */
//
// One MeshStandardMaterial per family (so `scene.environment` reaches all of
// them — in r160 only standard/physical materials read the PMREM probe), with
// a single shared patch bolted on:
//
//   • the albedo's alpha gates a per-vertex tint, which is how one clapboard
//     map paints six hundred different houses;
//   • the aux map's red channel is an emissive mask, scaled by a per-building
//     glow factor and a global dusk uniform, so windows and neon come up as
//     the sky system rolls the sun down.

interface GlowUniforms {
  uNightGlow: { value: number };
  uGlowColor: { value: THREE.Color };
}

function patchMaterial(mat: THREE.MeshStandardMaterial, uni: GlowUniforms) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNightGlow = uni.uNightGlow;
    shader.uniforms.uGlowColor = uni.uGlowColor;

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        attribute vec4 aTrim;
        varying vec4 vTrim;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        vTrim = aTrim;
        #ifdef USE_INSTANCING_COLOR
          // r160 routes instanceColor into vColor but <color_fragment> only
          // applies it when USE_COLOR is set, which needs vertexColors — which
          // we do not use. Fold it into the tint here instead, so an instanced
          // fleet of cars or a stack of containers can be individually painted.
          vTrim.rgb *= instanceColor;
        #endif`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        uniform float uNightGlow;
        uniform vec3 uGlowColor;
        varying vec4 vTrim;`,
      )
      .replace(
        "#include <map_fragment>",
        /* glsl */ `#include <map_fragment>
        // Alpha is the tint weight: 1 = painted body, 0 = glass or ironwork.
        diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vTrim.rgb, diffuseColor.a );
        diffuseColor.a = 1.0;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
        #ifdef USE_ROUGHNESSMAP
          totalEmissiveRadiance += uGlowColor * ( uNightGlow * texelRoughness.r * vTrim.a );
        #endif`,
      );
  };
}

interface MatOpts {
  metalness?: number;
  side?: THREE.Side;
  transparent?: boolean;
  polygonOffset?: number;
  depthWrite?: boolean;
}

function makeMaterial(maps: FamilyMaps, uni: GlowUniforms, opts: MatOpts = {}): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normal,
    roughnessMap: maps.aux,
    roughness: 1,
    metalness: opts.metalness ?? 0,
    // Black: the patch *adds* to `totalEmissiveRadiance`, it does not replace
    // it. A non-black base here would make every wall a light source.
    emissive: new THREE.Color(0x000000),
    side: opts.side ?? THREE.FrontSide,
    transparent: opts.transparent ?? false,
    depthWrite: opts.depthWrite ?? true,
    dithering: true,
  });
  mat.normalScale.set(1, 1);
  if (opts.polygonOffset) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -opts.polygonOffset;
    mat.polygonOffsetUnits = -opts.polygonOffset;
  }
  patchMaterial(mat, uni);
  return mat;
}

/* ------------------------------------------------------------------------ *
 * Geometry accumulation
 * ------------------------------------------------------------------------ */
//
// A city is a few hundred thousand quads. Building them as BoxGeometry objects
// and merging afterwards costs an order of magnitude more time and peak memory
// than writing straight into growable typed arrays, so that is what `Batch`
// does. Everything is emitted in a *local frame* (origin, yaw, base height) so
// a building's parts can be authored in "metres right, up, and out toward the
// street" and land correctly on a rotated lot halfway up a hill.

class FloatBuf {
  private a: Float32Array;
  n = 0;
  constructor(cap = 4096) { this.a = new Float32Array(cap); }
  private ensure(k: number) {
    if (this.n + k <= this.a.length) return;
    let c = this.a.length;
    while (c < this.n + k) c *= 2;
    const b = new Float32Array(c);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  push2(x: number, y: number) { this.ensure(2); this.a[this.n++] = x; this.a[this.n++] = y; }
  push3(x: number, y: number, z: number) { this.ensure(3); this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z; }
  view() { return this.a.subarray(0, this.n); }
}

class ByteBuf {
  private a: Uint8Array;
  n = 0;
  constructor(cap = 4096) { this.a = new Uint8Array(cap); }
  push4(x: number, y: number, z: number, w: number) {
    if (this.n + 4 > this.a.length) {
      const b = new Uint8Array(this.a.length * 2);
      b.set(this.a.subarray(0, this.n));
      this.a = b;
    }
    this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z; this.a[this.n++] = w;
  }
  view() { return this.a.subarray(0, this.n); }
}

class IndexBuf {
  private a: Uint32Array;
  n = 0;
  constructor(cap = 8192) { this.a = new Uint32Array(cap); }
  private ensure(k: number) {
    if (this.n + k <= this.a.length) return;
    let c = this.a.length;
    while (c < this.n + k) c *= 2;
    const g = new Uint32Array(c);
    g.set(this.a.subarray(0, this.n));
    this.a = g;
  }
  push3(a: number, b: number, c: number) {
    this.ensure(3);
    this.a[this.n++] = a; this.a[this.n++] = b; this.a[this.n++] = c;
  }
  push6(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.ensure(6);
    this.a[this.n++] = a; this.a[this.n++] = b; this.a[this.n++] = c;
    this.a[this.n++] = d; this.a[this.n++] = e; this.a[this.n++] = f;
  }
  view() { return this.a.subarray(0, this.n); }
}

/** Local authoring frame: an origin on the ground, a bearing, a base height. */
interface Frame {
  ox: number;
  oz: number;
  /** World Y that local y = 0 maps to. */
  oy: number;
  cos: number;
  sin: number;
}

function frameAt(x: number, z: number, y: number, yaw: number): Frame {
  return { ox: x, oz: z, oy: y, cos: Math.cos(yaw), sin: Math.sin(yaw) };
}

/**
 * UV contract for a box. `tu`/`tv` are metres per texture tile horizontally and
 * vertically on the side faces; `tt` is metres per tile on the caps. Offsets
 * are in tile units and are how two buildings sharing a texture stop sharing a
 * window pattern.
 */
interface BoxUV {
  tu: number;
  tv: number;
  tt?: number;
  uOff?: number;
  vOff?: number;
}

/** RGB tint (0..1) plus the building's night-glow multiplier. */
type Trim = [number, number, number, number];

const WHITE: Trim = [1, 1, 1, 0];

const F_PX = 1, F_NX = 2, F_PY = 4, F_NY = 8, F_PZ = 16, F_NZ = 32;
const F_ALL = 63;
/** Everything but the underside — the default for anything sitting on ground. */
const F_SHELL = F_PX | F_NX | F_PY | F_PZ | F_NZ;

class Batch {
  pos = new FloatBuf();
  nrm = new FloatBuf();
  uv = new FloatBuf();
  trim = new ByteBuf();
  idx = new IndexBuf();
  verts = 0;

  private vert(f: Frame, lx: number, ly: number, lz: number, nx: number, ny: number, nz: number, u: number, v: number, t: Trim) {
    this.pos.push3(f.ox + lx * f.cos + lz * f.sin, f.oy + ly, f.oz - lx * f.sin + lz * f.cos);
    this.nrm.push3(nx * f.cos + nz * f.sin, ny, -nx * f.sin + nz * f.cos);
    this.uv.push2(u, v);
    this.trim.push4(t[0] * 255, t[1] * 255, t[2] * 255, t[3] * 255);
    this.verts++;
  }

  /** Four local corners in CCW order as seen from `+n`, plus their UVs. */
  quad(
    f: Frame,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
    au: number, av: number, bu: number, bv: number, cu: number, cv: number, du: number, dv: number,
    t: Trim,
  ) {
    const i = this.verts;
    this.vert(f, ax, ay, az, nx, ny, nz, au, av, t);
    this.vert(f, bx, by, bz, nx, ny, nz, bu, bv, t);
    this.vert(f, cx, cy, cz, nx, ny, nz, cu, cv, t);
    this.vert(f, dx, dy, dz, nx, ny, nz, du, dv, t);
    this.idx.push6(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  /** Three local corners, CCW as seen from `+n`. Gable ends, awning cheeks. */
  tri(
    f: Frame,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    nx: number, ny: number, nz: number,
    au: number, av: number, bu: number, bv: number, cu: number, cv: number,
    t: Trim,
  ) {
    const i = this.verts;
    this.vert(f, ax, ay, az, nx, ny, nz, au, av, t);
    this.vert(f, bx, by, bz, nx, ny, nz, bu, bv, t);
    this.vert(f, cx, cy, cz, nx, ny, nz, cu, cv, t);
    this.idx.push3(i, i + 1, i + 2);
  }

  /**
   * An axis-aligned box in the local frame. `faces` drops the ones nobody can
   * see — party walls between shoulder-to-shoulder Victorians are a third of
   * the district's triangles if you let them through.
   */
  box(f: Frame, lx: number, ly: number, lz: number, hx: number, hy: number, hz: number, uv: BoxUV, t: Trim, faces = F_SHELL) {
    const x0 = lx - hx, x1 = lx + hx;
    const y0 = ly - hy, y1 = ly + hy;
    const z0 = lz - hz, z1 = lz + hz;
    const uo = uv.uOff ?? 0, vo = uv.vOff ?? 0;
    const tt = uv.tt ?? uv.tu;
    // Vertical UVs are measured from the frame base, never from the box, so a
    // plinth, a shaft and a cornice stacked on one lot keep one continuous
    // storey rhythm.
    const vA = y0 / uv.tv + vo, vB = y1 / uv.tv + vo;
    const uxA = x0 / uv.tu + uo, uxB = x1 / uv.tu + uo;
    const uzA = z0 / uv.tu + uo, uzB = z1 / uv.tu + uo;

    if (faces & F_PZ) this.quad(f, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, uxA, vA, uxB, vA, uxB, vB, uxA, vB, t);
    if (faces & F_NZ) this.quad(f, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, uxB, vA, uxA, vA, uxA, vB, uxB, vB, t);
    if (faces & F_PX) this.quad(f, x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, uzB, vA, uzA, vA, uzA, vB, uzB, vB, t);
    if (faces & F_NX) this.quad(f, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, uzA, vA, uzB, vA, uzB, vB, uzA, vB, t);
    if (faces & F_PY) this.quad(f, x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0, x0 / tt + uo, z1 / tt + vo, x1 / tt + uo, z1 / tt + vo, x1 / tt + uo, z0 / tt + vo, x0 / tt + uo, z0 / tt + vo, t);
    if (faces & F_NY) this.quad(f, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0, x0 / tt + uo, z0 / tt + vo, x1 / tt + uo, z0 / tt + vo, x1 / tt + uo, z1 / tt + vo, x0 / tt + uo, z1 / tt + vo, t);
  }

  /**
   * A vertical prism over a convex outline (flat `[x,z,...]`, positive signed
   * area). Bay windows, tapered turrets, storage tanks, lamp columns — one
   * primitive covers all of them.
   */
  prism(f: Frame, outline: number[], y0: number, y1: number, uv: BoxUV, t: Trim, capTop = true, capBottom = false) {
    const m = outline.length / 2;
    const uo = uv.uOff ?? 0, vo = uv.vOff ?? 0;
    const tt = uv.tt ?? uv.tu;
    let run = 0;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const ax = outline[i * 2], az = outline[i * 2 + 1];
      const bx = outline[j * 2], bz = outline[j * 2 + 1];
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz) || 1e-4;
      const nx = dz / len, nz = -dx / len;
      const u0 = run / uv.tu + uo, u1 = (run + len) / uv.tu + uo;
      const v0 = y0 / uv.tv + vo, v1 = y1 / uv.tv + vo;
      this.quad(f, bx, y0, bz, ax, y0, az, ax, y1, az, bx, y1, bz, nx, 0, nz, u1, v0, u0, v0, u0, v1, u1, v1, t);
      run += len;
    }
    if (capTop) {
      const i0 = this.verts;
      for (let i = 0; i < m; i++) {
        this.vert(f, outline[i * 2], y1, outline[i * 2 + 1], 0, 1, 0, outline[i * 2] / tt + uo, outline[i * 2 + 1] / tt + vo, t);
      }
      // Outlines are wound with a positive signed area in XZ, which fans to a
      // downward normal — so the top cap runs the fan backwards.
      for (let i = 1; i < m - 1; i++) this.idx.push3(i0, i0 + i + 1, i0 + i);
    }
    if (capBottom) {
      const i0 = this.verts;
      for (let i = 0; i < m; i++) {
        this.vert(f, outline[i * 2], y0, outline[i * 2 + 1], 0, -1, 0, outline[i * 2] / tt + uo, outline[i * 2 + 1] / tt + vo, t);
      }
      for (let i = 1; i < m - 1; i++) this.idx.push3(i0, i0 + i, i0 + i + 1);
    }
  }

  /**
   * A quad strip between two world-space polylines. Roads, pavements, kerb
   * faces and retaining skirts are all this, differing only in the V band they
   * sample and whether the two rails share an XZ position.
   */
  strip(left: number[], right: number[], v0: number, v1: number, uPerMetre: number, t: Trim) {
    const count = Math.min(left.length, right.length) / 3;
    if (count < 2) return;
    const f = frameAt(0, 0, 0, 0);
    let u = 0;
    const first = this.verts;
    for (let i = 0; i < count; i++) {
      if (i > 0) {
        const dx = left[i * 3] - left[i * 3 - 3];
        const dz = left[i * 3 + 2] - left[i * 3 - 1];
        u += Math.hypot(dx, dz) * uPerMetre;
      }
      // Normal from the strip's own cross and along vectors, so a road banked
      // over a hill shades as the surface the player actually walks on.
      const k = Math.min(count - 1, i + 1), h = Math.max(0, i - 1);
      const ax = left[k * 3] - left[h * 3], ay = left[k * 3 + 1] - left[h * 3 + 1], az = left[k * 3 + 2] - left[h * 3 + 2];
      const cx = right[i * 3] - left[i * 3], cy = right[i * 3 + 1] - left[i * 3 + 1], cz = right[i * 3 + 2] - left[i * 3 + 2];
      let nx = ay * cz - az * cy, ny = az * cx - ax * cz, nz = ax * cy - ay * cx;
      const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
      nx *= inv; ny *= inv; nz *= inv;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      this.vert(f, left[i * 3], left[i * 3 + 1], left[i * 3 + 2], nx, ny, nz, u, v0, t);
      this.vert(f, right[i * 3], right[i * 3 + 1], right[i * 3 + 2], nx, ny, nz, u, v1, t);
      if (i > 0) {
        const a = first + (i - 1) * 2;
        this.idx.push6(a, a + 2, a + 3, a, a + 3, a + 1);
      }
    }
  }

  /** A free horizontal quad — crosswalk decals, pool surfaces, mural panels. */
  flat(x: number, y: number, z: number, hx: number, hz: number, yaw: number, u0: number, v0: number, u1: number, v1: number, t: Trim) {
    const f = frameAt(x, z, y, yaw);
    this.quad(f, -hx, 0, hz, hx, 0, hz, hx, 0, -hz, -hx, 0, -hz, 0, 1, 0, u0, v1, u1, v1, u1, v0, u0, v0, t);
  }

  build(): THREE.BufferGeometry | null {
    if (this.verts === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos.view().slice(), 3));
    // Normals go down to normalized bytes. At two and a half million vertices
    // that is twenty megabytes of VRAM back, and the quantisation error on a
    // unit vector is under half a degree — invisible on flat-shaded masonry.
    const nsrc = this.nrm.view();
    const ndst = new Int8Array(nsrc.length);
    for (let i = 0; i < nsrc.length; i++) ndst[i] = Math.max(-127, Math.min(127, Math.round(nsrc[i] * 127)));
    g.setAttribute("normal", new THREE.BufferAttribute(ndst, 3, true));
    g.setAttribute("uv", new THREE.BufferAttribute(this.uv.view().slice(), 2));
    g.setAttribute("aTrim", new THREE.BufferAttribute(this.trim.view().slice(), 4, true));
    const idx = this.idx.view();
    g.setIndex(new THREE.BufferAttribute(this.verts > 65535 ? idx.slice() : Uint16Array.from(idx), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/* ------------------------------------------------------------------------ *
 * Broadphase
 * ------------------------------------------------------------------------ */
//
// ~4000 boxes, queried by the player every frame and by every projectile every
// integration step. A linear scan is ~4000 AABB tests per query; a uniform grid
// at one-frontage resolution is typically three or four. The grid is sparse
// (a Map keyed by a packed cell index) because two thirds of San Palmas is
// water, hillside or jungle and has no colliders at all.

interface Collider {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  climbable: boolean;
  tag?: string;
}

class Broadphase implements CollisionService {
  private boxes: Collider[] = [];
  private cells = new Map<number, number[]>();
  /** Per-box visit stamp, so a box spanning four cells is tested once a query. */
  private stamp: Int32Array = new Int32Array(0);
  private tick = 0;
  /** Owner of the player capsule, so we can settle it on rooftops. */
  playerPosition: THREE.Vector3 | null = null;
  playerVelocity: THREE.Vector3 | null = null;

  private key(cx: number, cz: number): number {
    // 16-bit halves; the world is 6 km across at 24 m cells, so ±1365 fits.
    return ((cx + 32768) << 16) | (cz + 32768);
  }

  addBox(box: THREE.Box3, opts?: { climbable?: boolean; tag?: string }): void {
    if (!box || !isFinite(box.min.x) || !isFinite(box.max.x)) return;
    const c: Collider = {
      minX: box.min.x, minY: box.min.y, minZ: box.min.z,
      maxX: box.max.x, maxY: box.max.y, maxZ: box.max.z,
      climbable: opts?.climbable ?? false,
      tag: opts?.tag,
    };
    const id = this.boxes.length;
    this.boxes.push(c);
    const x0 = Math.floor(c.minX / CELL), x1 = Math.floor(c.maxX / CELL);
    const z0 = Math.floor(c.minZ / CELL), z1 = Math.floor(c.maxZ / CELL);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const k = this.key(cx, cz);
        const list = this.cells.get(k);
        if (list) list.push(id);
        else this.cells.set(k, [id]);
      }
    }
  }

  /** Grow the visit stamps to cover every registered box. Call after building. */
  seal(): void {
    this.stamp = new Int32Array(this.boxes.length);
  }

  get count(): number { return this.boxes.length; }

  resolveCapsule(pos: THREE.Vector3, radius: number, height: number): boolean {
    if (this.boxes.length === 0) return false;
    const isPlayer = this.playerPosition === pos;
    let hit = false;
    // Two passes: a capsule wedged in a corner needs the second one to settle,
    // and two is enough for axis-aligned geometry.
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      const x0 = Math.floor((pos.x - radius) / CELL), x1 = Math.floor((pos.x + radius) / CELL);
      const z0 = Math.floor((pos.z - radius) / CELL), z1 = Math.floor((pos.z + radius) / CELL);
      this.tick++;
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const list = this.cells.get(this.key(cx, cz));
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const id = list[i];
            if (this.stamp[id] === this.tick) continue;
            this.stamp[id] = this.tick;
            const b = this.boxes[id];
            if (pos.x < b.minX - radius || pos.x > b.maxX + radius) continue;
            if (pos.z < b.minZ - radius || pos.z > b.maxZ + radius) continue;
            if (pos.y + height < b.minY || pos.y > b.maxY) continue;

            const dxMin = pos.x - (b.minX - radius);
            const dxMax = b.maxX + radius - pos.x;
            const dzMin = pos.z - (b.minZ - radius);
            const dzMax = b.maxZ + radius - pos.z;
            const dyTop = b.maxY - pos.y;               // lift onto the roof

            // Standing on a roof is the cheapest escape whenever the capsule is
            // barely inside the top face — which is exactly what a descending
            // player looks like. Preferring it here is what makes rooftops and
            // pier decks walkable instead of walls you slide off. Killing the
            // downward velocity is what stops it from jittering: the player
            // system only zeroes gravity against the *terrain*.
            const m = Math.min(dxMin, dxMax, dzMin, dzMax);
            if (dyTop <= m && dyTop <= height * 0.55) {
              pos.y = b.maxY;
              if (isPlayer && this.playerVelocity && this.playerVelocity.y < 0) this.playerVelocity.y = 0;
            } else {
              if (m === dxMin) pos.x = b.minX - radius;
              else if (m === dxMax) pos.x = b.maxX + radius;
              else if (m === dzMin) pos.z = b.minZ - radius;
              else pos.z = b.maxZ + radius;
            }
            hit = true;
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
    return hit;
  }

  /** Slab test. Returns entry distance, or -1 when the ray misses. */
  private slab(b: Collider, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, maxDist: number): number {
    let t0 = 0, t1 = maxDist;
    let n0 = (b.minX - ox) * ix, n1 = (b.maxX - ox) * ix;
    if (n0 > n1) { const s = n0; n0 = n1; n1 = s; }
    if (n0 > t0) t0 = n0;
    if (n1 < t1) t1 = n1;
    n0 = (b.minY - oy) * iy; n1 = (b.maxY - oy) * iy;
    if (n0 > n1) { const s = n0; n0 = n1; n1 = s; }
    if (n0 > t0) t0 = n0;
    if (n1 < t1) t1 = n1;
    n0 = (b.minZ - oz) * iz; n1 = (b.maxZ - oz) * iz;
    if (n0 > n1) { const s = n0; n0 = n1; n1 = s; }
    if (n0 > t0) t0 = n0;
    if (n1 < t1) t1 = n1;
    return t1 >= Math.max(0, t0) ? t0 : -1;
  }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
    if (this.boxes.length === 0) return null;
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (!(len > 1e-8) || !(maxDist > 0)) return null;
    const dx = dir.x / len, dy = dir.y / len, dz = dir.z / len;
    const ix = dx !== 0 ? 1 / dx : Infinity;
    const iy = dy !== 0 ? 1 / dy : Infinity;
    const iz = dz !== 0 ? 1 / dz : Infinity;

    this.tick++;
    let bestT = maxDist;
    let bestId = -1;

    // 2-D DDA over the XZ lattice. Buildings are prisms, so the vertical axis
    // never needs its own traversal — the slab test handles it.
    let cx = Math.floor(origin.x / CELL);
    let cz = Math.floor(origin.z / CELL);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const tDeltaX = stepX !== 0 ? Math.abs(CELL * ix) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(CELL * iz) : Infinity;
    let tMaxX = stepX !== 0
      ? ((stepX > 0 ? (cx + 1) * CELL : cx * CELL) - origin.x) * ix
      : Infinity;
    let tMaxZ = stepZ !== 0
      ? ((stepZ > 0 ? (cz + 1) * CELL : cz * CELL) - origin.z) * iz
      : Infinity;

    let entry = 0;
    // The ceiling stops a grazing ray from walking the whole map; 512 cells at
    // 24 m is 12 km, which is the camera far plane.
    for (let guard = 0; guard < 512; guard++) {
      if (bestId >= 0 && bestT <= entry) break;
      const list = this.cells.get(this.key(cx, cz));
      if (list) {
        for (let i = 0; i < list.length; i++) {
          const id = list[i];
          if (this.stamp[id] === this.tick) continue;
          this.stamp[id] = this.tick;
          const t = this.slab(this.boxes[id], origin.x, origin.y, origin.z, ix, iy, iz, maxDist);
          if (t >= 0 && t < bestT) { bestT = t; bestId = id; }
        }
      }
      const next = Math.min(tMaxX, tMaxZ);
      if (next > maxDist) break;
      entry = next;
      if (tMaxX < tMaxZ) { cx += stepX; tMaxX += tDeltaX; }
      else { cz += stepZ; tMaxZ += tDeltaZ; }
    }

    if (bestId < 0) return null;
    const b = this.boxes[bestId];
    const px = origin.x + dx * bestT, py = origin.y + dy * bestT, pz = origin.z + dz * bestT;
    // Face from whichever slab the entry distance belongs to — compare the
    // hit point against each face with a tolerance scaled by the box.
    const eps = 1e-3;
    const n = new THREE.Vector3(0, 1, 0);
    if (Math.abs(px - b.minX) < eps) n.set(-1, 0, 0);
    else if (Math.abs(px - b.maxX) < eps) n.set(1, 0, 0);
    else if (Math.abs(pz - b.minZ) < eps) n.set(0, 0, -1);
    else if (Math.abs(pz - b.maxZ) < eps) n.set(0, 0, 1);
    else if (Math.abs(py - b.minY) < eps) n.set(0, -1, 0);
    return { point: new THREE.Vector3(px, py, pz), normal: n, distance: bestT, tag: b.tag };
  }
}

/* ------------------------------------------------------------------------ *
 * District plans
 * ------------------------------------------------------------------------ */

interface Plan {
  /** Block pitch along the district's own u and v axes, metres. */
  gu: number;
  gv: number;
  /** Carriageway half-width and pavement width for the local streets. */
  half: number;
  walk: number;
  /** Lot frontage and depth ranges. */
  lotW: [number, number];
  lotD: [number, number];
  /** Gap between neighbours — 0.2 m is "shoulder to shoulder". */
  gap: number;
  floors: [number, number];
  fill: number;
}

const PLANS: Record<District["kind"], Plan> = {
  downtown: { gu: 132, gv: 112, half: 10.5, walk: 4.4, lotW: [26, 46], lotD: [26, 40], gap: 1.2, floors: [14, 44], fill: 0.88 },
  victorian: { gu: 112, gv: 84, half: 6.8, walk: 2.9, lotW: [7.4, 11.2], lotD: [13, 17], gap: 0.22, floors: [2, 4], fill: 0.97 },
  chinatown: { gu: 84, gv: 68, half: 6.2, walk: 2.7, lotW: [6.4, 9.6], lotD: [12, 16], gap: 0.18, floors: [3, 5], fill: 0.98 },
  wharf: { gu: 126, gv: 112, half: 8.4, walk: 3.4, lotW: [16, 30], lotD: [18, 30], gap: 2.5, floors: [1, 2], fill: 0.6 },
  mission: { gu: 120, gv: 96, half: 7.6, walk: 3.2, lotW: [9, 16], lotD: [14, 20], gap: 0.3, floors: [2, 4], fill: 0.93 },
  industrial: { gu: 168, gv: 144, half: 8.8, walk: 2.4, lotW: [22, 44], lotD: [24, 40], gap: 4, floors: [1, 3], fill: 0.55 },
  resort: { gu: 152, gv: 128, half: 7.2, walk: 3.0, lotW: [16, 30], lotD: [16, 26], gap: 5, floors: [2, 4], fill: 0.5 },
};

/**
 * Grid bearings, in radians. Authored rather than randomised: San Palmas needs
 * downtown and Little Canton to share a bearing (they are one survey), the two
 * Victorian districts to sit square to the compass, and Astillero to skew — the
 * mismatched joins are where the triangular blocks come from.
 */
const BEARINGS: Record<string, number> = {
  downtown: 0.33,
  chinatown: 0.33,
  wharf: 0.24,
  nob: 0.0,
  haight: -0.03,
  mission: -0.14,
  dogpatch: 0.38,
  sunset: 0.02,
};

/* ------------------------------------------------------------------------ *
 * Palettes
 * ------------------------------------------------------------------------ */

type RGB = [number, number, number];

/** Painted ladies: bleached-pastel bodies with a handful of bold outliers. */
const VICTORIAN_BODY: RGB[] = [
  [0.93, 0.86, 0.72], [0.80, 0.90, 0.86], [0.96, 0.78, 0.70], [0.86, 0.88, 0.95],
  [0.98, 0.92, 0.78], [0.78, 0.86, 0.78], [0.94, 0.80, 0.84], [0.72, 0.82, 0.88],
  [0.90, 0.72, 0.60], [0.88, 0.90, 0.80], [0.66, 0.78, 0.74], [0.98, 0.86, 0.62],
  [0.84, 0.66, 0.68], [0.60, 0.72, 0.82], [0.96, 0.70, 0.52],
];
const VICTORIAN_TRIM: RGB[] = [
  [1.0, 0.99, 0.96], [0.98, 0.95, 0.88], [0.94, 0.92, 0.90], [0.99, 0.90, 0.72],
];

/** Little Canton: lacquer red, jade, gold, ivory. */
const CHINATOWN_BODY: RGB[] = [
  [0.86, 0.28, 0.22], [0.94, 0.72, 0.28], [0.42, 0.62, 0.48], [0.96, 0.92, 0.82],
  [0.78, 0.34, 0.30], [0.90, 0.84, 0.66], [0.36, 0.50, 0.56],
];

/** La Misión: hot stucco, taken straight off the mural palette. */
const MISSION_BODY: RGB[] = [
  [0.95, 0.74, 0.40], [0.88, 0.46, 0.34], [0.72, 0.80, 0.60], [0.96, 0.88, 0.70],
  [0.58, 0.70, 0.78], [0.90, 0.62, 0.52], [0.82, 0.84, 0.66], [0.94, 0.84, 0.50],
];

/** Costa Dorada: resort white, sand, faded terracotta. */
const RESORT_BODY: RGB[] = [
  [0.99, 0.97, 0.92], [0.96, 0.92, 0.84], [0.94, 0.86, 0.76], [0.90, 0.94, 0.94],
];

/** Astillero: works paint that has been in the salt air for twenty years. */
const INDUSTRIAL_BODY: RGB[] = [
  [0.62, 0.64, 0.62], [0.52, 0.58, 0.60], [0.72, 0.66, 0.54], [0.46, 0.52, 0.50],
  [0.70, 0.48, 0.34], [0.58, 0.62, 0.56],
];

const CONTAINER_COLORS: RGB[] = [
  [0.72, 0.24, 0.18], [0.18, 0.38, 0.58], [0.86, 0.68, 0.20], [0.20, 0.46, 0.34],
  [0.66, 0.66, 0.64], [0.56, 0.24, 0.44], [0.84, 0.44, 0.16],
];

const CAR_COLORS: RGB[] = [
  [0.82, 0.82, 0.84], [0.10, 0.11, 0.13], [0.55, 0.10, 0.10], [0.14, 0.28, 0.52],
  [0.90, 0.88, 0.82], [0.32, 0.34, 0.36], [0.18, 0.44, 0.36], [0.86, 0.62, 0.14],
  [0.70, 0.72, 0.74], [0.42, 0.14, 0.16],
];

const pick = <T,>(arr: T[], rng: () => number): T => arr[Math.floor(rng() * arr.length) % arr.length];

/* ------------------------------------------------------------------------ *
 * Street network
 * ------------------------------------------------------------------------ */

interface Street {
  /** Flat XZ polyline, already conformed nowhere — Y comes later. */
  pts: number[];
  half: number;
  walk: number;
  arterial: boolean;
}

/** Catmull-Rom resample of an avenue polyline, so arterials sweep. */
function smoothAvenue(points: [number, number][], step: number): number[] {
  const v = points.map(([x, z]) => new THREE.Vector3(x, 0, z));
  if (v.length < 2) return [];
  const curve = new THREE.CatmullRomCurve3(v, false, "centripetal", 0.5);
  const total = curve.getLength();
  const n = Math.max(2, Math.ceil(total / step));
  const out: number[] = [];
  const p = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    curve.getPoint(i / n, p);
    out.push(p.x, p.z);
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * System
 * ------------------------------------------------------------------------ */

/**
 * Async so the loading screen keeps painting: ten procedural material families
 * and four thousand buildings is the better part of a second of pure CPU, and a
 * frozen loading bar reads as a hang. Nothing here awaits I/O.
 */
const createCity: SystemFactory = async (ctx) => {
  const breathe = () => new Promise<void>((r) => setTimeout(r, 0));
  const tier = TIERS[ctx.quality] ?? TIERS.high;
  const rng = makeRng(Math.floor(ctx.rng() * 0xffffffff) >>> 0);

  const terrain: TerrainService | undefined = ctx.services.terrain;
  /** Ground height. Falls back to the raw atlas if terrain failed to boot. */
  const ground = (x: number, z: number): number =>
    terrain ? terrain.heightAt(x, z) : shoreProfile(landSignedDistance(x, z)) + hillHeight(x, z);
  const wet = (x: number, z: number): boolean =>
    terrain ? terrain.isWater(x, z) : isWaterAt(x, z);
  const sea = terrain?.seaLevel ?? SEA_LEVEL;

  /** Inside a landmark's reservation — the landmarks module owns these. */
  function reserved(x: number, z: number, pad = 0): boolean {
    for (let i = 0; i < LANDMARKS.length; i++) {
      const lm = LANDMARKS[i];
      const r = RESERVED[lm.key];
      if (!r) continue;
      const dx = x - lm.x, dz = z - lm.z;
      if (dx * dx + dz * dz < (r + pad) * (r + pad)) return true;
    }
    return false;
  }

  const root = new THREE.Group();
  root.name = "palmas.city";
  ctx.scene.add(root);

  const broadphase = new Broadphase();
  ctx.services.collision = broadphase;

  // -------------------------------------------------------------------------
  // Materials
  // -------------------------------------------------------------------------

  const glowUniforms: GlowUniforms = {
    uNightGlow: { value: 0 },
    uGlowColor: { value: new THREE.Color(1.0, 0.78, 0.48) },
  };

  let maxAniso = tier.aniso;
  try {
    maxAniso = Math.min(tier.aniso, ctx.renderer.capabilities.getMaxAnisotropy());
  } catch {
    /* headless — anisotropy is a hint, not a requirement */
  }

  const maps = {} as Record<Family, FamilyMaps>;
  for (let i = 0; i < FAMILIES.length; i++) {
    const fam = FAMILIES[i];
    maps[fam] = bakeFamily(fam, tier.tex, maxAniso, rng);
    // Ten families is ~400 ms of canvas work; yield between each so the loader
    // animates instead of locking the tab.
    if (i % 3 === 2) await breathe();
  }

  const materials: Record<string, THREE.MeshStandardMaterial> = {
    asphalt: makeMaterial(maps.asphalt, glowUniforms),
    pavement: makeMaterial(maps.pavement, glowUniforms),
    victorian: makeMaterial(maps.victorian, glowUniforms),
    stucco: makeMaterial(maps.stucco, glowUniforms),
    glass: makeMaterial(maps.glass, glowUniforms, { metalness: 0.72 }),
    roof: makeMaterial(maps.roof, glowUniforms),
    steel: makeMaterial(maps.steel, glowUniforms, { metalness: 0.62 }),
    concrete: makeMaterial(maps.concrete, glowUniforms),
    mural: makeMaterial(maps.mural, glowUniforms),
    // Signage and awnings are seen from both sides; the decal pass sits a
    // couple of centimetres over the carriageway and needs the depth nudge.
    sign: makeMaterial(maps.sign, glowUniforms, { side: THREE.DoubleSide }),
    paint: makeMaterial(maps.paint, glowUniforms, { metalness: 0.35 }),
    decal: makeMaterial(maps.asphalt, glowUniforms, { polygonOffset: 2 }),
  };

  await breathe();

  // -------------------------------------------------------------------------
  // Batch registry — one merged mesh per (district, family) pair
  // -------------------------------------------------------------------------
  //
  // Grouping by district keeps each mesh inside a ~700 m sphere, which is small
  // enough for frustum culling to earn its keep and large enough that the whole
  // city still lands in well under a hundred draw calls.

  const batches = new Map<string, Batch>();
  const bat = (group: string, fam: string): Batch => {
    const k = group + "|" + fam;
    let b = batches.get(k);
    if (!b) { b = new Batch(); batches.set(k, b); }
    return b;
  };

  // -------------------------------------------------------------------------
  // Street network
  // -------------------------------------------------------------------------

  const streets: { group: string; s: Street }[] = [];
  /** Junction centres, for signals, crosswalks and clean asphalt patches. */
  const junctions: { x: number; z: number; yaw: number; half: number; arterial: boolean }[] = [];

  /** Split an XZ polyline wherever it leaves buildable land. */
  function landRuns(pts: number[]): number[][] {
    const runs: number[][] = [];
    let cur: number[] = [];
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], z = pts[i + 1];
      const ok = !wet(x, z) && ground(x, z) > MIN_ROAD_Y && !reserved(x, z, -20);
      if (ok) cur.push(x, z);
      else if (cur.length >= 4) { runs.push(cur); cur = []; }
      else cur = [];
    }
    if (cur.length >= 4) runs.push(cur);
    return runs;
  }

  // --- arterials -----------------------------------------------------------
  for (const ave of AVENUES) {
    const line = smoothAvenue(ave.points, ROAD_STEP);
    for (const run of landRuns(line)) {
      streets.push({ group: "arterial", s: { pts: run, half: 11, walk: 4.2, arterial: true } });
    }
  }

  // --- district grids ------------------------------------------------------
  // Laid in plan and dropped onto the terrain afterwards. That is the whole
  // trick behind the San Francisco silhouette: the survey never once looked up.
  for (const d of DISTRICTS) {
    const plan = PLANS[d.kind];
    const bearing = BEARINGS[d.key] ?? 0;
    const ca = Math.cos(bearing), sa = Math.sin(bearing);
    const R = d.radius;
    const nu = Math.ceil(R / plan.gu) + 1;
    const nv = Math.ceil(R / plan.gv) + 1;

    const toWorld = (u: number, v: number): [number, number] => [
      d.x + u * ca - v * sa,
      d.z + u * sa + v * ca,
    ];

    // Lines of constant u run along v, and vice versa. Each is clipped to the
    // district disc, then to land, then to whichever district `districtAt`
    // says owns the ground — that arbitration is what stops Palma Centro and
    // Little Canton drawing two grids through each other.
    const emitLine = (fixed: number, along: "u" | "v") => {
      const span = R;
      const step = ROAD_STEP;
      const pts: number[] = [];
      for (let t = -span; t <= span; t += step) {
        const [x, z] = along === "u" ? toWorld(t, fixed) : toWorld(fixed, t);
        if (Math.hypot(x - d.x, z - d.z) > R) { continue; }
        if (districtAt(x, z) !== d) { continue; }
        pts.push(x, z);
      }
      // Gaps opened by the district test would otherwise be bridged by a
      // straight jump, so split on any step that is far longer than expected.
      let cur: number[] = [];
      for (let i = 0; i < pts.length; i += 2) {
        if (cur.length >= 2) {
          const dx = pts[i] - cur[cur.length - 2];
          const dz = pts[i + 1] - cur[cur.length - 1];
          if (dx * dx + dz * dz > step * step * 2.5) {
            if (cur.length >= 4) for (const r of landRuns(cur)) streets.push({ group: d.key, s: { pts: r, half: plan.half, walk: plan.walk, arterial: false } });
            cur = [];
          }
        }
        cur.push(pts[i], pts[i + 1]);
      }
      if (cur.length >= 4) {
        for (const r of landRuns(cur)) {
          streets.push({ group: d.key, s: { pts: r, half: plan.half, walk: plan.walk, arterial: false } });
        }
      }
    };

    for (let i = -nv; i <= nv; i++) emitLine(i * plan.gv, "u");
    for (let i = -nu; i <= nu; i++) emitLine(i * plan.gu, "v");

    // Junctions fall out of the grid analytically.
    for (let i = -nu; i <= nu; i++) {
      for (let j = -nv; j <= nv; j++) {
        const [x, z] = toWorld(i * plan.gu, j * plan.gv);
        if (Math.hypot(x - d.x, z - d.z) > R - plan.half) continue;
        if (districtAt(x, z) !== d) continue;
        if (wet(x, z) || ground(x, z) <= MIN_ROAD_Y) continue;
        junctions.push({ x, z, yaw: bearing, half: plan.half, arterial: false });
      }
    }
  }

  await breathe();

  // -------------------------------------------------------------------------
  // Road, kerb, pavement and retaining geometry
  // -------------------------------------------------------------------------

  const ROAD_V0 = BAND.roadMarked[0], ROAD_V1 = BAND.roadMarked[1];
  const PLAIN_V0 = BAND.roadPlain[0], PLAIN_V1 = BAND.roadPlain[1];
  const WALK_V0 = BAND.walk[0], WALK_V1 = BAND.walk[1];
  const KERB_V0 = BAND.kerb[0], KERB_V1 = BAND.kerb[1];

  function emitStreet(group: string, s: Street) {
    const n = s.pts.length / 2;
    if (n < 2) return;

    const cx: number[] = [], cz: number[] = [], cy: number[] = [];
    const px: number[] = [], pz: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = s.pts[i * 2], z = s.pts[i * 2 + 1];
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      const tx = s.pts[b * 2] - s.pts[a * 2];
      const tz = s.pts[b * 2 + 1] - s.pts[a * 2 + 1];
      const tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl, nz = tx / tl;
      px.push(nx); pz.push(nz);
      cx.push(x); cz.push(z);
      // Crown height is the *highest* of three cross samples plus the lift, so
      // the carriageway never sinks into the hillside it is cut across; the
      // downhill side is picked up by the retaining skirt below.
      const h = Math.max(
        ground(x, z),
        ground(x + nx * s.half, z + nz * s.half),
        ground(x - nx * s.half, z - nz * s.half),
      );
      cy.push(h + ROAD_LIFT);
    }

    const rail = (off: number, dy: number, conform: boolean): number[] => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const x = cx[i] + px[i] * off, z = cz[i] + pz[i] * off;
        let y = cy[i] + dy;
        if (conform) y = Math.max(y, ground(x, z) + 0.06);
        out.push(x, y, z);
      }
      return out;
    };

    const uRoad = 1 / (s.arterial ? 13 : 9.5);
    const uWalk = 1 / 7.2;
    // Carriageway, crowned 90 mm so rain reads as running to the gutters.
    const cLeft = rail(-s.half, -0.09, false);
    const cRight = rail(s.half, -0.09, false);
    const cMid = rail(0, 0, false);
    const road = bat(group, "asphalt");
    road.strip(cLeft, cMid, ROAD_V0, (ROAD_V0 + ROAD_V1) * 0.5, uRoad, WHITE);
    road.strip(cMid, cRight, (ROAD_V0 + ROAD_V1) * 0.5, ROAD_V1, uRoad, WHITE);

    const pave = bat(group, "pavement");
    for (const side of [-1, 1]) {
      const kerbBase = rail(side * s.half, -0.09, false);
      const kerbTop = rail(side * s.half, KERB, false);
      const walkOut = rail(side * (s.half + s.walk), KERB, true);
      // Kerb face, then the pavement running back to the building line.
      if (side < 0) pave.strip(kerbBase, kerbTop, KERB_V0, KERB_V1, uWalk, WHITE);
      else pave.strip(kerbTop, kerbBase, KERB_V1, KERB_V0, uWalk, WHITE);
      if (side < 0) pave.strip(walkOut, kerbTop, WALK_V0, WALK_V1, uWalk, WHITE);
      else pave.strip(kerbTop, walkOut, WALK_V1, WALK_V0, uWalk, WHITE);

      // Retaining skirt: where the pavement stands proud of the hillside, drop
      // a concrete face to meet it. On San Palmas' gradients this is the
      // difference between a street and a strip of tape laid on a slope.
      const conc = bat(group, "concrete");
      const skirtTop: number[] = [], skirtBot: number[] = [];
      let need = false;
      for (let i = 0; i < n; i++) {
        const x = walkOut[i * 3], y = walkOut[i * 3 + 1], z = walkOut[i * 3 + 2];
        const g = ground(x, z);
        if (y - g > 0.12) need = true;
        skirtTop.push(x, y, z);
        skirtBot.push(x, Math.min(g, y) - 1.4, z);
      }
      if (need) {
        if (side < 0) conc.strip(skirtBot, skirtTop, 0.0, 0.55, 1 / 6, WHITE);
        else conc.strip(skirtTop, skirtBot, 0.55, 0.0, 1 / 6, WHITE);
      }
    }
  }

  for (const { group, s } of streets) emitStreet(group, s);

  // --- junction infill + crosswalks ---------------------------------------
  // A clean asphalt patch kills the lane markings that would otherwise run
  // straight through the intersection; the zebra decals sit 2 cm above it.
  for (const j of junctions) {
    const y = ground(j.x, j.z) + ROAD_LIFT + 0.012;
    const patch = bat("decal", "decal");
    patch.flat(j.x, y, j.z, j.half, j.half, j.yaw, 0, PLAIN_V0 + 0.02, 2.2, PLAIN_V1 - 0.02, WHITE);
    const zebra = bat("decal", "decal");
    for (let k = 0; k < 4; k++) {
      const a = j.yaw + (k * Math.PI) / 2;
      const ox = j.x + Math.sin(a) * (j.half + 1.5);
      const oz = j.z + Math.cos(a) * (j.half + 1.5);
      if (wet(ox, oz)) continue;
      // U runs across the carriageway, so the texture's alternating bars land
      // as a zebra. ~1.15 m per bar at any street width.
      zebra.flat(ox, ground(ox, oz) + ROAD_LIFT + 0.028, oz, j.half * 0.92, 1.6, a,
        0, BAND.zebra[0] + 0.012, j.half * 1.84 / 9.2, BAND.zebra[1] - 0.012, WHITE);
    }
  }

  await breathe();

  // -------------------------------------------------------------------------
  // Lots
  // -------------------------------------------------------------------------

  interface Lot {
    x: number; z: number;
    /** Outward bearing: the front face normal is (sin yaw, 0, cos yaw). */
    yaw: number;
    /** Frontage and depth, metres. */
    w: number;
    d: number;
    district: District;
    group: string;
    /** True when the lot turns a block corner and both its faces are exposed. */
    corner: boolean;
  }

  const lots: Lot[] = [];
  const _box = new THREE.Box3();
  const _v = new THREE.Vector3();

  /** Terrain envelope under a rotated footprint. Five taps is plenty at 15 m. */
  function seat(x: number, z: number, yaw: number, w: number, d: number) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const hx = w * 0.5, hz = d * 0.5;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 5; i++) {
      const lx = i === 4 ? 0 : (i & 1 ? hx : -hx);
      const lz = i === 4 ? 0 : (i & 2 ? hz : -hz);
      const h = ground(x + lx * c + lz * s, z - lx * s + lz * c);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    return { lo, hi };
  }

  /** World AABB of a rotated footprint, handed straight to the broadphase. */
  function collide(x: number, z: number, yaw: number, w: number, d: number, y0: number, y1: number, tag: string) {
    const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
    const ex = w * 0.5 * c + d * 0.5 * s;
    const ez = w * 0.5 * s + d * 0.5 * c;
    _box.min.set(x - ex, y0, z - ez);
    _box.max.set(x + ex, y1, z + ez);
    broadphase.addBox(_box, { tag });
  }

  /**
   * Flattened arterial segments, as [ax, az, vx, vz, invLenSq] quintuples. The
   * avenues cut across the district grids — that is where the triangular blocks
   * come from — so lots have to be tested against them explicitly or Market
   * Street ends up with houses standing in the carriageway.
   */
  const arterialSegs = (() => {
    const out: number[] = [];
    for (const { group, s } of streets) {
      if (group !== "arterial") continue;
      for (let i = 0; i + 3 < s.pts.length; i += 2) {
        const ax = s.pts[i], az = s.pts[i + 1];
        const vx = s.pts[i + 2] - ax, vz = s.pts[i + 3] - az;
        out.push(ax, az, vx, vz, 1 / Math.max(1e-6, vx * vx + vz * vz));
      }
    }
    return Float64Array.from(out);
  })();
  const ARTERIAL_CLEAR = 11 + 4.2 + 2.5;

  function onArterial(x: number, z: number, pad: number): boolean {
    const lim = ARTERIAL_CLEAR + pad;
    const lim2 = lim * lim;
    for (let i = 0; i < arterialSegs.length; i += 5) {
      const ax = arterialSegs[i], az = arterialSegs[i + 1];
      const wx = x - ax, wz = z - az;
      // Cheap reject before the projection: segments are ~13 m long.
      if (Math.abs(wx) > lim + 14 || Math.abs(wz) > lim + 14) continue;
      const vx = arterialSegs[i + 2], vz = arterialSegs[i + 3];
      let t = (wx * vx + wz * vz) * arterialSegs[i + 4];
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = wx - t * vx, ez = wz - t * vz;
      if (ex * ex + ez * ez < lim2) return true;
    }
    return false;
  }

  /** Is this footprint buildable? Dry, on land, and nobody else's ground. */
  function buildable(l: Lot): boolean {
    const c = Math.cos(l.yaw), s = Math.sin(l.yaw);
    const hx = l.w * 0.5, hz = l.d * 0.5;
    for (let i = 0; i < 5; i++) {
      const lx = i === 4 ? 0 : (i & 1 ? hx : -hx);
      const lz = i === 4 ? 0 : (i & 2 ? hz : -hz);
      const x = l.x + lx * c + lz * s, z = l.z - lx * s + lz * c;
      if (wet(x, z)) return false;
      if (ground(x, z) < sea + 1.4) return false;
    }
    if (reserved(l.x, l.z, Math.max(l.w, l.d) * 0.5)) return false;
    if (districtAt(l.x, l.z) !== l.district) return false;
    if (onArterial(l.x, l.z, Math.max(l.w, l.d) * 0.5)) return false;
    return true;
  }

  // Pier Verde gets land-side transit sheds from this pass; its decks over the
  // water are laid out separately, further down.
  for (const d of DISTRICTS) {
    const plan = PLANS[d.kind];
    const bearing = BEARINGS[d.key] ?? 0;
    const ca = Math.cos(bearing), sa = Math.sin(bearing);
    const R = d.radius;
    const nu = Math.ceil(R / plan.gu);
    const nv = Math.ceil(R / plan.gv);
    // The block face sits back from the street centreline by the carriageway
    // plus the pavement — the same numbers the road geometry used, so the
    // building line and the kerb line are guaranteed to agree.
    const setback = plan.half + plan.walk;

    for (let iu = -nu; iu < nu; iu++) {
      for (let iv = -nv; iv < nv; iv++) {
        const u0 = iu * plan.gu + setback, u1 = (iu + 1) * plan.gu - setback;
        const v0 = iv * plan.gv + setback, v1 = (iv + 1) * plan.gv - setback;
        const bw = u1 - u0, bd = v1 - v0;
        if (bw < 12 || bd < 12) continue;

        const emitEdge = (
          /** Outward normal in district-local (u,v). */
          nu2: number, nv2: number,
          /** Edge start and end in local coords. */
          ax: number, ay: number, bx: number, by: number,
        ) => {
          const len = Math.hypot(bx - ax, by - ay);
          if (len < plan.lotW[0]) return;
          const dirU = (bx - ax) / len, dirV = (by - ay) / len;
          const depth = lerp(plan.lotD[0], plan.lotD[1], rng());
          let t = 0;
          while (t < len - plan.lotW[0] * 0.6) {
            let w = lerp(plan.lotW[0], plan.lotW[1], rng());
            if (t + w > len) w = len - t;
            if (w < plan.lotW[0] * 0.6) break;
            const cu = ax + dirU * (t + w * 0.5) - nu2 * depth * 0.5;
            const cv = ay + dirV * (t + w * 0.5) - nv2 * depth * 0.5;
            // Local (u,v) into world, then the outward normal into a bearing.
            const wx = d.x + cu * ca - cv * sa;
            const wz = d.z + cu * sa + cv * ca;
            const wnx = nu2 * ca - nv2 * sa;
            const wnz = nu2 * sa + nv2 * ca;
            lots.push({
              x: wx, z: wz,
              yaw: Math.atan2(wnx, wnz),
              w: w - plan.gap,
              d: depth,
              district: d,
              group: d.key,
              corner: t < 0.5 || t + w > len - 0.5,
            });
            t += w;
          }
        };

        // The two long faces run the full block; the short faces are inset by
        // the lot depth so corners meet cleanly instead of interpenetrating.
        const inset = Math.min(bd, bw) * 0.5 > plan.lotD[1] ? plan.lotD[1] : Math.min(bd, bw) * 0.42;
        emitEdge(0, -1, u0, v0, u1, v0);
        emitEdge(0, 1, u1, v1, u0, v1);
        emitEdge(-1, 0, u0, v1 - inset, u0, v0 + inset);
        emitEdge(1, 0, u1, v0 + inset, u1, v1 - inset);
      }
    }
  }

  await breathe();

  // -------------------------------------------------------------------------
  // Buildings
  // -------------------------------------------------------------------------

  const trimOf = (c: RGB, glow: number): Trim => [c[0], c[1], c[2], glow];

  /** Whole-bay UVs: guarantees a facade never cuts a window in half. */
  function bayUV(w: number, bayM: number, baysPerTile: number, floorH: number, floorsPerTile: number, y0: number): BoxUV {
    const bays = Math.max(1, Math.round(w / bayM));
    const tu = baysPerTile * (w / bays);
    const tv = floorsPerTile * floorH;
    return {
      tu,
      tv,
      tt: 4,
      uOff: (w * 0.5) / tu + Math.floor(rng() * baysPerTile) / baysPerTile,
      vOff: Math.floor(rng() * floorsPerTile) / floorsPerTile - y0 / tv,
    };
  }

  /** A pitched roof ridged along the frontage. Two slopes plus two gable ends. */
  function gable(b: Batch, f: Frame, cy: number, hx: number, hz: number, rise: number, uv: BoxUV, t: Trim) {
    const slope = Math.hypot(hz, rise);
    const ny = hz / slope, nz = rise / slope;
    const u0 = -hx / uv.tu, u1 = hx / uv.tu;
    const v1 = slope / (uv.tt ?? uv.tu);
    b.quad(f, -hx, cy, hz, hx, cy, hz, hx, cy + rise, 0, -hx, cy + rise, 0, 0, ny, nz, u0, 0, u1, 0, u1, v1, u0, v1, t);
    b.quad(f, hx, cy, -hz, -hx, cy, -hz, -hx, cy + rise, 0, hx, cy + rise, 0, 0, ny, -nz, u0, 0, u1, 0, u1, v1, u0, v1, t);
    b.tri(f, hx, cy, hz, hx, cy + rise, 0, hx, cy, -hz, 1, 0, 0, 0, 0, 0.5, rise / uv.tv, 1, 0, t);
    b.tri(f, -hx, cy, -hz, -hx, cy + rise, 0, -hx, cy, hz, -1, 0, 0, 0, 0, 0.5, rise / uv.tv, 1, 0, t);
  }

  /** A railing: a top rail, a bottom rail and evenly spaced balusters. */
  function railing(b: Batch, f: Frame, cx: number, cy: number, cz: number, hx: number, hz: number, h: number, t: Trim) {
    const uv: BoxUV = { tu: 2, tv: 2, tt: 2 };
    const along = hx > hz ? hx : hz;
    const posts = Math.max(2, Math.floor(along / 0.34));
    b.box(f, cx, cy + h, cz, hx, 0.045, hz, uv, t, F_ALL);
    b.box(f, cx, cy + h * 0.45, cz, hx, 0.028, hz, uv, t, F_ALL);
    for (let i = 0; i <= posts; i++) {
      const p = -along + (2 * along * i) / posts;
      if (hx > hz) b.box(f, cx + p, cy + h * 0.5, cz, 0.022, h * 0.5, 0.022, uv, t, F_ALL);
      else b.box(f, cx, cy + h * 0.5, cz + p, 0.022, h * 0.5, 0.022, uv, t, F_ALL);
    }
  }

  let built = 0;

  /* --- painted ladies --------------------------------------------------- */
  //
  // The soul of the look, and where the detail budget goes: a raised entry over
  // a garage plinth, a projecting faceted bay running the full height, a belt
  // course at every storey, a heavy overhanging cornice, and a stoop you can
  // measure yourself against from the pavement.

  function buildVictorian(l: Lot) {
    const { lo, hi } = seat(l.x, l.z, l.yaw, l.w, l.d);
    const f = frameAt(l.x, l.z, lo, l.yaw);
    const body = bat(l.group, "victorian");
    const conc = bat(l.group, "concrete");
    const roofB = bat(l.group, "roof");

    const floors = Math.round(lerp(PLANS.victorian.floors[0], PLANS.victorian.floors[1], rng() ** 0.8));
    const plinth = (hi - lo) + 1.05 + rng() * 0.5;
    const wallH = floors * VIC_FLOOR;
    const top = plinth + wallH;
    const hx = l.w * 0.5, hz = l.d * 0.5;

    const bodyCol = pick(VICTORIAN_BODY, rng);
    const trimCol = pick(VICTORIAN_TRIM, rng);
    const glow = 0.55 + rng() * 0.45;
    const tBody = trimOf(bodyCol, glow);
    const tTrim = trimOf(trimCol, glow * 0.2);
    const tStone = trimOf([0.80, 0.78, 0.74], 0);

    // Plinth: swallows the cross-slope so nothing floats and nothing sinks.
    conc.box(f, 0, plinth * 0.5 - 1.2, 0, hx + 0.05, plinth * 0.5 + 1.2, hz + 0.05,
      { tu: 4, tv: 3.4, tt: 4 }, tStone, F_SHELL);
    // Garage: a recessed dark opening, because a blank plinth reads as a podium.
    conc.box(f, hx * 0.34, plinth * 0.55, hz + 0.02, hx * 0.30, plinth * 0.32, 0.10,
      { tu: 2, tv: 2, tt: 2 }, trimOf([0.24, 0.23, 0.22], 0), F_PZ | F_PX | F_NX | F_PY);

    // Shell. Party walls are dropped: neighbours are 220 mm apart.
    const uv = bayUV(l.w, VIC_BAY, 3, VIC_FLOOR, 4, plinth);
    body.box(f, 0, plinth + wallH * 0.5, 0, hx, wallH * 0.5, hz, uv, tBody, F_SHELL);

    if (tier.relief) {
      // Faceted bay window, full height, chamfered 45° cheeks.
      const bw = hx * (0.52 + rng() * 0.20);
      const proj = 0.72 + rng() * 0.26;
      const outline = [
        -bw, hz, -bw + proj * 0.9, hz + proj, bw - proj * 0.9, hz + proj, bw, hz,
      ];
      const bayUv: BoxUV = { tu: uv.tu * 0.62, tv: uv.tv, tt: 3, uOff: rng(), vOff: uv.vOff };
      body.prism(f, outline, plinth + 0.25, top - 0.35, bayUv, tBody, false, false);
      // The bay's own little roof and its underside soffit.
      roofB.prism(f, outline, top - 0.35, top - 0.10, { tu: 2.6, tv: 2.6, tt: 2.6 }, tTrim, true, false);
      conc.prism(f, outline, plinth + 0.05, plinth + 0.25, { tu: 2, tv: 2, tt: 2 }, tTrim, false, true);

      // Belt course at every storey line, plus a moulded sill under the bay.
      for (let i = 1; i <= floors; i++) {
        body.box(f, 0, plinth + i * VIC_FLOOR, hz + 0.06, hx + 0.06, 0.075, 0.075,
          { tu: 1.6, tv: 1.6, tt: 1.6 }, tTrim, F_ALL);
      }

      // Stoop: five treads up to a raised entry, with a cheek wall each side.
      const sx = -hx * 0.42;
      const steps = 5;
      for (let i = 0; i < steps; i++) {
        const t01 = i / steps;
        conc.box(f, sx, plinth * (1 - t01) * 0.5, hz + 0.28 + i * 0.30,
          1.05, plinth * (1 - t01) * 0.5, 0.16, { tu: 1.4, tv: 1.4, tt: 1.4 }, tStone, F_SHELL);
      }
      conc.box(f, sx - 1.16, plinth * 0.42, hz + 0.9, 0.11, plinth * 0.42, 0.85,
        { tu: 1.4, tv: 1.4, tt: 1.4 }, tTrim, F_SHELL);
      conc.box(f, sx + 1.16, plinth * 0.42, hz + 0.9, 0.11, plinth * 0.42, 0.85,
        { tu: 1.4, tv: 1.4, tt: 1.4 }, tTrim, F_SHELL);
      // Entry: a recessed door head under a small hood.
      body.box(f, sx, plinth + 1.15, hz + 0.04, 0.62, 1.15, 0.10,
        { tu: 1.2, tv: 2.4, tt: 1.2 }, trimOf([0.34, 0.20, 0.14], 0), F_PZ | F_PX | F_NX | F_PY);
      body.box(f, sx, plinth + 2.42, hz + 0.34, 0.95, 0.09, 0.40,
        { tu: 1.4, tv: 1.4, tt: 1.4 }, tTrim, F_ALL);
    }

    // Cornice: the heaviest single element on the elevation, and the thing that
    // gives a terrace of these its skyline.
    body.box(f, 0, top + 0.22, 0, hx + 0.30, 0.22, hz + 0.30,
      { tu: 1.8, tv: 1.8, tt: 1.8 }, tTrim, F_ALL);
    body.box(f, 0, top + 0.05, 0, hx + 0.16, 0.16, hz + 0.16,
      { tu: 1.4, tv: 1.4, tt: 1.4 }, tTrim, F_PX | F_NX | F_PZ | F_NZ);

    if (rng() < 0.42) {
      // Gabled attic, ridge parallel to the street.
      gable(roofB, f, top + 0.44, hx + 0.28, hz + 0.28, 1.5 + rng() * 1.2,
        { tu: 3.0, tv: 3.0, tt: 3.0 }, trimOf([0.92, 0.86, 0.80], 0));
    } else {
      // Flat roof behind a parapet, with a stubby chimney.
      roofB.box(f, 0, top + 0.5, 0, hx + 0.26, 0.06, hz + 0.26, { tu: 3, tv: 3, tt: 3 }, trimOf([0.5, 0.48, 0.46], 0), F_PY);
      body.box(f, 0, top + 0.62, hz + 0.16, hx + 0.30, 0.34, 0.12, { tu: 1.6, tv: 1.6, tt: 1.6 }, tTrim, F_ALL);
      conc.box(f, hx * 0.6, top + 1.35, -hz * 0.4, 0.42, 0.9, 0.42, { tu: 1.6, tv: 1.6, tt: 1.6 }, trimOf([0.62, 0.48, 0.42], 0), F_SHELL);
    }

    collide(l.x, l.z, l.yaw, l.w, l.d, lo - 2, lo + top + 0.6, "building");
    built++;
  }

  /* --- Little Canton ----------------------------------------------------- */

  function buildChinatown(l: Lot) {
    const { lo, hi } = seat(l.x, l.z, l.yaw, l.w, l.d);
    const f = frameAt(l.x, l.z, lo, l.yaw);
    const wall = bat(l.group, "stucco");
    const roofB = bat(l.group, "roof");
    const metal = bat(l.group, "steel");
    const signs = bat(l.group, "sign");

    const floors = Math.round(lerp(PLANS.chinatown.floors[0], PLANS.chinatown.floors[1], rng()));
    const plinth = (hi - lo) + 0.35;
    const wallH = floors * STU_FLOOR;
    const top = plinth + wallH;
    const hx = l.w * 0.5, hz = l.d * 0.5;
    const col = pick(CHINATOWN_BODY, rng);
    const tBody = trimOf(col, 0.75 + rng() * 0.25);
    const tDark = trimOf([0.30, 0.29, 0.28], 0);

    wall.box(f, 0, plinth * 0.5 - 1.4, 0, hx, plinth * 0.5 + 1.4, hz,
      { tu: 3, tv: 3, tt: 3 }, trimOf([0.42, 0.38, 0.34], 0), F_SHELL);
    const uv = bayUV(l.w, STU_BAY, 4, STU_FLOOR, 4, plinth);
    wall.box(f, 0, plinth + wallH * 0.5, 0, hx, wallH * 0.5, hz, uv, tBody, F_SHELL);

    // Shopfront: a glazed base under a fascia, which is what makes the ground
    // floor read as commercial rather than as more wall.
    wall.box(f, 0, plinth + 1.4, hz + 0.03, hx * 0.92, 1.35, 0.06,
      { tu: 2.2, tv: 2.4, tt: 2.2 }, trimOf([0.12, 0.14, 0.16], 0.9), F_PZ);
    wall.box(f, 0, plinth + 2.95, hz + 0.14, hx * 0.98, 0.30, 0.16,
      { tu: 1.8, tv: 1.8, tt: 1.8 }, trimOf([0.55, 0.14, 0.12], 0), F_ALL);

    if (tier.relief) {
      // Balconies at every upper storey, drying laundry and all.
      for (let i = 1; i < floors; i++) {
        const y = plinth + i * STU_FLOOR;
        metal.box(f, 0, y + 0.06, hz + 0.55, hx * 0.86, 0.06, 0.55,
          { tu: 2, tv: 2, tt: 2 }, tDark, F_ALL);
        railing(metal, f, 0, y + 0.12, hz + 1.06, hx * 0.86, 0.03, 0.92, tDark);
        for (let k = 0; k < 3; k++) {
          if (rng() < 0.5) continue;
          const cw = 0.30 + rng() * 0.35;
          wall.box(f, (k - 1) * hx * 0.5, y + 0.62, hz + 1.02, cw, 0.32, 0.02,
            { tu: 1, tv: 1, tt: 1 }, trimOf([0.7 + rng() * 0.3, 0.5 + rng() * 0.4, 0.4 + rng() * 0.5], 0), F_PZ | F_NZ);
        }
      }
      // Two-tier tiled eaves over the fascia, flared like a pagoda.
      roofB.box(f, 0, top + 0.10, hz + 0.42, hx + 0.34, 0.16, 0.80,
        { tu: 2.4, tv: 2.4, tt: 2.0 }, trimOf([0.92, 0.86, 0.80], 0), F_ALL);
      roofB.box(f, 0, top + 0.42, hz + 0.22, hx + 0.18, 0.14, 0.55,
        { tu: 2.4, tv: 2.4, tt: 2.0 }, trimOf([0.92, 0.86, 0.80], 0), F_ALL);
      // A hanging blade sign, glowing, projecting into the street.
      const cell = Math.floor(rng() * 12);
      const cu = (cell % SIGN_COLS) / SIGN_COLS, cv = Math.floor(cell / SIGN_COLS) / SIGN_COLS;
      const sh = 1.6 + rng() * 1.1;
      const sy = plinth + wallH * (0.42 + rng() * 0.3);
      // One double-sided quad mapped into a single atlas cell — a blade sign is
      // a board, and a board with thickness costs four times the triangles.
      signs.quad(f, hx * 0.55, sy - sh * 0.5, hz + 1.37, hx * 0.55, sy - sh * 0.5, hz + 0.33,
        hx * 0.55, sy + sh * 0.5, hz + 0.33, hx * 0.55, sy + sh * 0.5, hz + 1.37,
        1, 0, 0,
        cu, cv, cu + 1 / SIGN_COLS, cv, cu + 1 / SIGN_COLS, cv + 1 / SIGN_COLS, cu, cv + 1 / SIGN_COLS,
        trimOf([1, 1, 1], 1));
      metal.box(f, hx * 0.55, sy + sh * 0.5 + 0.12, hz + 0.45, 0.04, 0.04, 0.45,
        { tu: 1, tv: 1, tt: 1 }, tDark, F_ALL);
    }

    // Parapet and a clutter of roof tanks and vents.
    wall.box(f, 0, top + 0.34, 0, hx + 0.10, 0.34, hz + 0.10, { tu: 1.8, tv: 1.8, tt: 1.8 }, tBody, F_ALL);
    if (rng() < 0.6) {
      metal.box(f, (rng() - 0.5) * hx, top + 1.0, (rng() - 0.5) * hz, 0.5, 0.6, 0.5,
        { tu: 1.6, tv: 1.6, tt: 1.6 }, tDark, F_SHELL);
    }

    collide(l.x, l.z, l.yaw, l.w, l.d, lo - 2, lo + top + 0.7, "building");
    built++;
  }

  /* --- La Misión --------------------------------------------------------- */

  function buildMission(l: Lot) {
    const { lo, hi } = seat(l.x, l.z, l.yaw, l.w, l.d);
    const f = frameAt(l.x, l.z, lo, l.yaw);
    const wall = bat(l.group, "stucco");
    const metal = bat(l.group, "steel");
    const muralB = bat(l.group, "mural");

    const floors = Math.round(lerp(PLANS.mission.floors[0], PLANS.mission.floors[1], rng()));
    const plinth = (hi - lo) + 0.28;
    const wallH = floors * STU_FLOOR;
    const top = plinth + wallH;
    const hx = l.w * 0.5, hz = l.d * 0.5;
    const col = pick(MISSION_BODY, rng);
    const tBody = trimOf(col, 0.6 + rng() * 0.4);
    const tIron = trimOf([0.22, 0.22, 0.23], 0);

    wall.box(f, 0, plinth * 0.5 - 1.4, 0, hx, plinth * 0.5 + 1.4, hz,
      { tu: 3, tv: 3, tt: 3 }, trimOf([0.48, 0.44, 0.40], 0), F_SHELL);
    const uv = bayUV(l.w, STU_BAY, 4, STU_FLOOR, 4, plinth);
    wall.box(f, 0, plinth + wallH * 0.5, 0, hx, wallH * 0.5, hz, uv, tBody, F_SHELL);

    // Flat roof, deep parapet, and a scupper's worth of staining below it.
    wall.box(f, 0, top + 0.55, 0, hx + 0.12, 0.55, hz + 0.12, { tu: 2, tv: 2.6, tt: 2 }, tBody, F_ALL);

    if (tier.relief) {
      // Fire escape: platforms, stringers and a dropped ladder. Pure Mission.
      for (let i = 1; i < floors; i++) {
        const y = plinth + i * STU_FLOOR;
        metal.box(f, -hx * 0.32, y + 0.04, hz + 0.62, hx * 0.42, 0.045, 0.62,
          { tu: 1.6, tv: 1.6, tt: 1.6 }, tIron, F_ALL);
        railing(metal, f, -hx * 0.32, y + 0.08, hz + 1.20, hx * 0.42, 0.03, 0.86, tIron);
        // Stair flight down to the platform below, on alternating sides.
        const dir = i % 2 === 0 ? 1 : -1;
        metal.box(f, -hx * 0.32 + dir * hx * 0.30, y - STU_FLOOR * 0.5 + 0.1, hz + 0.62,
          hx * 0.10, STU_FLOOR * 0.30, 0.34, { tu: 1.2, tv: 1.2, tt: 1.2 }, tIron, F_ALL);
      }
      // Shopfront awning: a canted slab on two struts.
      const aw = hx * 0.8;
      wall.box(f, 0, plinth + 2.9, hz + 0.85, aw, 0.07, 0.85,
        { tu: 1.4, tv: 1.4, tt: 1.4 }, trimOf(pick(MISSION_BODY, rng), 0), F_ALL);
      metal.box(f, -aw * 0.85, plinth + 2.4, hz + 1.55, 0.04, 0.5, 0.04, { tu: 1, tv: 1, tt: 1 }, tIron, F_ALL);
      metal.box(f, aw * 0.85, plinth + 2.4, hz + 1.55, 0.04, 0.5, 0.04, { tu: 1, tv: 1, tt: 1 }, tIron, F_ALL);
      // Shopfront glazing.
      wall.box(f, 0, plinth + 1.35, hz + 0.03, hx * 0.86, 1.3, 0.06,
        { tu: 2.4, tv: 2.6, tt: 2.4 }, trimOf([0.13, 0.15, 0.17], 0.85), F_PZ);
    }

    // A mural on the exposed flank of every corner lot. One quad, no tiling —
    // the whole wall is one composition, the way it is painted in life.
    if (l.corner && rng() < 0.75) {
      const side = rng() < 0.5 ? 1 : -1;
      muralB.quad(f,
        side * (hx + 0.03), plinth + 0.1, side * -hz, side * (hx + 0.03), plinth + 0.1, side * hz,
        side * (hx + 0.03), top - 0.1, side * hz, side * (hx + 0.03), top - 0.1, side * -hz,
        side, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, trimOf([1, 1, 1], 0));
    }

    collide(l.x, l.z, l.yaw, l.w, l.d, lo - 2, lo + top + 0.7, "building");
    built++;
  }

  /* --- Palma Centro ------------------------------------------------------ */
  //
  // Setback towers: a stone podium at street level, then two or three shafts
  // stepping in, each with a slab at the setback and pilasters on the corners.
  // Roof plant and an aviation beacon finish the silhouette — a tower that ends
  // in a flat lid is the most obvious CG building there is.

  function buildTower(l: Lot) {
    const { lo, hi } = seat(l.x, l.z, l.yaw, l.w, l.d);
    const f = frameAt(l.x, l.z, lo, l.yaw);
    const glassB = bat(l.group, "glass");
    const conc = bat(l.group, "concrete");
    const metal = bat(l.group, "steel");

    const tall = rng() < 0.55;
    const floors = Math.round(lerp(tall ? 22 : 8, tall ? 44 : 20, rng()));
    const podium = (hi - lo) + 6.5 + rng() * 6;
    let hx = l.w * 0.5, hz = l.d * 0.5;
    const tGlass = trimOf([0.86, 0.92, 0.96], 0.5 + rng() * 0.5);
    const tStone = trimOf([0.74 + rng() * 0.2, 0.70 + rng() * 0.2, 0.64 + rng() * 0.2], 0);
    const tMetal = trimOf([0.55, 0.56, 0.57], 0);

    // Podium: stone, with a deep glazed colonnade at the pavement.
    conc.box(f, 0, podium * 0.5 - 1.6, 0, hx, podium * 0.5 + 1.6, hz,
      { tu: 5, tv: 4.2, tt: 5 }, tStone, F_SHELL);
    glassB.box(f, 0, (hi - lo) + 2.6, 0, hx - 0.35, 2.4, hz - 0.35,
      { tu: 9, tv: 6, tt: 6 }, trimOf([0.9, 0.95, 1], 0.9), F_PX | F_NX | F_PZ | F_NZ);
    conc.box(f, 0, podium + 0.35, 0, hx + 0.45, 0.35, hz + 0.45,
      { tu: 3, tv: 3, tt: 3 }, tStone, F_ALL);

    let y = podium + 0.7;
    const stages = tall ? 2 + Math.floor(rng() * 2) : 1 + Math.floor(rng() * 2);
    let left = floors;
    for (let s = 0; s < stages; s++) {
      const take = s === stages - 1 ? left : Math.max(3, Math.round(left * (0.4 + rng() * 0.25)));
      left -= take;
      const h = take * GLASS_FLOOR;
      const uv: BoxUV = {
        tu: (2 * hx) / Math.max(1, Math.round((2 * hx) / (GLASS_BAY * 8))),
        tv: GLASS_FLOOR * 6,
        tt: 6,
        uOff: hx / (2 * hx) + Math.floor(rng() * 8) / 8,
        vOff: Math.floor(rng() * 6) / 6 - y / (GLASS_FLOOR * 6),
      };
      glassB.box(f, 0, y + h * 0.5, 0, hx, h * 0.5, hz, uv, tGlass, F_SHELL);
      // Corner pilasters — real relief, so the tower has an edge highlight at
      // every hour of the day instead of a mitre line.
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          metal.box(f, sx * (hx - 0.18), y + h * 0.5, sz * (hz + 0.10), 0.30, h * 0.5, 0.22,
            { tu: 2, tv: 4, tt: 2 }, tMetal, F_ALL);
          metal.box(f, sx * (hx + 0.10), y + h * 0.5, sz * (hz - 0.18), 0.22, h * 0.5, 0.30,
            { tu: 2, tv: 4, tt: 2 }, tMetal, F_ALL);
        }
      }
      y += h;
      // Setback slab, then step the plan in for the next stage.
      conc.box(f, 0, y + 0.30, 0, hx + 0.40, 0.30, hz + 0.40, { tu: 3, tv: 3, tt: 3 }, tStone, F_ALL);
      y += 0.6;
      if (s < stages - 1) {
        hx *= 0.74 + rng() * 0.12;
        hz *= 0.74 + rng() * 0.12;
      }
    }

    // Roof: parapet, plant enclosures, cooling towers, mast and beacon.
    conc.box(f, 0, y + 0.55, 0, hx + 0.18, 0.55, hz + 0.18, { tu: 3, tv: 3, tt: 3 }, tStone, F_ALL);
    const plant = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < plant; i++) {
      const pw = hx * (0.18 + rng() * 0.3), pd = hz * (0.18 + rng() * 0.3);
      const ph = 1.2 + rng() * 3.2;
      metal.box(f, (rng() - 0.5) * (hx - pw) * 1.6, y + ph * 0.5, (rng() - 0.5) * (hz - pd) * 1.6,
        pw, ph * 0.5, pd, { tu: 3, tv: 3, tt: 3 }, tMetal, F_SHELL);
    }
    const mastH = 4 + rng() * 12;
    metal.prism(f, [-0.22, -0.22, 0.22, -0.22, 0.22, 0.22, -0.22, 0.22], y + 0.6, y + mastH,
      { tu: 1.2, tv: 3, tt: 1.2 }, tMetal, true, false);
    for (let i = 1; i <= 3; i++) {
      metal.box(f, 0, y + (mastH * i) / 3.4, 0, 0.55, 0.05, 0.55, { tu: 1, tv: 1, tt: 1 }, tMetal, F_ALL);
    }
    const sig = bat(l.group, "sign");
    const cu = (12 % SIGN_COLS) / SIGN_COLS, cv = Math.floor(12 / SIGN_COLS) / SIGN_COLS;
    const q = 1 / SIGN_COLS;
    sig.box(f, 0, y + mastH + 0.28, 0, 0.28, 0.28, 0.28,
      { tu: 1e6, tv: 1e6, tt: 1e6, uOff: cu + q * 0.5, vOff: cv + q * 0.5 }, trimOf([1, 1, 1], 1), F_ALL);

    collide(l.x, l.z, l.yaw, l.w, l.d, lo - 3, lo + y + 1.0, "building");
    built++;
  }

  /* --- Astillero --------------------------------------------------------- */

  function buildIndustrial(l: Lot) {
    const { lo, hi } = seat(l.x, l.z, l.yaw, l.w, l.d);
    const f = frameAt(l.x, l.z, lo, l.yaw);
    const shed = bat(l.group, "steel");
    const conc = bat(l.group, "concrete");
    const hx = l.w * 0.5, hz = l.d * 0.5;
    const tSkin = trimOf(pick(INDUSTRIAL_BODY, rng), 0.25);
    const tConc = trimOf([0.72, 0.70, 0.66], 0);
    const tDark = trimOf([0.28, 0.28, 0.29], 0);

    if (rng() < 0.24) {
      // Tank farm: a squat cylinder on a plinth with a walkway around the rim.
      const r = Math.min(hx, hz) * (0.6 + rng() * 0.3);
      const h = 6 + rng() * 12;
      const sides = 16;
      const outline: number[] = [];
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        outline.push(Math.cos(a) * r, Math.sin(a) * r);
      }
      conc.prism(f, outline.map((v) => v * 1.12), -1.2, (hi - lo) + 0.6,
        { tu: 4, tv: 3, tt: 4 }, tConc, true, false);
      shed.prism(f, outline, (hi - lo) + 0.6, (hi - lo) + 0.6 + h, { tu: 5, tv: 5, tt: 5 }, tSkin, true, false);
      railing(shed, f, 0, (hi - lo) + h + 0.6, 0, r, 0.03, 1.0, tDark);
      // Hoop stiffeners.
      for (let i = 1; i < 4; i++) {
        shed.prism(f, outline.map((v) => v * 1.015), (hi - lo) + 0.6 + (h * i) / 4, (hi - lo) + 0.72 + (h * i) / 4,
          { tu: 4, tv: 4, tt: 4 }, tDark, false, false);
      }
      collide(l.x, l.z, l.yaw, r * 2, r * 2, lo - 2, lo + (hi - lo) + h + 1.2, "building");
      built++;
      return;
    }

    // Shed: a portal frame with a gable, roller doors and a strip of glazing.
    const h = 6.5 + rng() * 5;
    const base = (hi - lo) + 0.35;
    conc.box(f, 0, base * 0.5 - 1.2, 0, hx + 0.2, base * 0.5 + 1.2, hz + 0.2,
      { tu: 4, tv: 3, tt: 4 }, tConc, F_SHELL);
    shed.box(f, 0, base + h * 0.5, 0, hx, h * 0.5, hz,
      { tu: 6, tv: 6, tt: 6, uOff: rng(), vOff: rng() }, tSkin, F_SHELL);
    gable(bat(l.group, "steel"), f, base + h, hx + 0.22, hz + 0.22, hz * 0.28,
      { tu: 6, tv: 6, tt: 6 }, tSkin);
    // Roller doors, dark and deeply framed.
    const doors = Math.max(1, Math.floor(l.w / 9));
    for (let i = 0; i < doors; i++) {
      const dx = -hx + ((i + 0.5) * 2 * hx) / doors;
      shed.box(f, dx, base + 2.1, hz + 0.05, Math.min(3.2, hx / doors * 0.8), 2.1, 0.10,
        { tu: 3, tv: 3, tt: 3 }, tDark, F_PZ | F_PX | F_NX | F_PY);
      conc.box(f, dx, base + 4.35, hz + 0.16, Math.min(3.5, hx / doors * 0.9), 0.16, 0.16,
        { tu: 2, tv: 2, tt: 2 }, tConc, F_ALL);
    }
    // High strip glazing under the eaves.
    shed.box(f, 0, base + h - 1.1, hz + 0.03, hx * 0.9, 0.7, 0.06,
      { tu: 4, tv: 2, tt: 4 }, trimOf([0.30, 0.34, 0.36], 0.6), F_PZ);

    collide(l.x, l.z, l.yaw, l.w, l.d, lo - 2, lo + base + h + hz * 0.3, "building");
    built++;
  }

  /* --- Costa Dorada ------------------------------------------------------ */

  function buildResort(l: Lot) {
    const { lo, hi } = seat(l.x, l.z, l.yaw, l.w, l.d);
    const f = frameAt(l.x, l.z, lo, l.yaw);
    const wall = bat(l.group, "stucco");
    const roofB = bat(l.group, "roof");
    const metal = bat(l.group, "steel");
    const pave = bat(l.group, "pavement");

    const floors = Math.round(lerp(PLANS.resort.floors[0], PLANS.resort.floors[1], rng()));
    const plinth = (hi - lo) + 0.9;
    const wallH = floors * STU_FLOOR;
    const top = plinth + wallH;
    const hx = l.w * 0.5, hz = l.d * 0.5;
    const tBody = trimOf(pick(RESORT_BODY, rng), 0.5 + rng() * 0.4);
    const tRail = trimOf([0.96, 0.95, 0.92], 0);

    // Terrace platform. The retaining sides are concrete (which tiles freely);
    // the deck is one bounded quad into the pavement map's slab band, because a
    // V-banded texture on a box would run straight through the kerb and pool
    // bands as soon as the box was taller than a third of a tile.
    const conc = bat(l.group, "concrete");
    const thx = hx + 3.5, thz = hz + 3.5;
    // Centred so the deck lands exactly on the building's ground floor and the
    // rest of the box is buried in the slope.
    conc.box(f, 0, plinth * 0.5 - 1.2, hz * 0.4, thx, plinth * 0.5 + 1.2, thz,
      { tu: 4, tv: 3, tt: 4 }, trimOf([0.94, 0.91, 0.85], 0), F_SHELL);
    pave.flat(
      l.x + Math.sin(l.yaw) * hz * 0.4, lo + plinth + 0.012,
      l.z + Math.cos(l.yaw) * hz * 0.4,
      thx, thz, l.yaw,
      0, WALK_V0 + 0.01, (thx * 2) / 7.2, WALK_V1 - 0.01, trimOf([0.96, 0.93, 0.87], 0));
    const uv = bayUV(l.w, STU_BAY, 4, STU_FLOOR, 4, plinth);
    wall.box(f, 0, plinth + wallH * 0.5, 0, hx, wallH * 0.5, hz, uv, tBody, F_SHELL);

    if (tier.relief) {
      // Continuous balcony to every storey, with a slab and a white rail.
      for (let i = 1; i <= floors; i++) {
        const y = plinth + i * STU_FLOOR;
        wall.box(f, 0, y + 0.07, hz + 0.85, hx + 0.2, 0.07, 0.85,
          { tu: 2, tv: 2, tt: 2 }, tRail, F_ALL);
        railing(metal, f, 0, y + 0.14, hz + 1.66, hx + 0.2, 0.03, 1.02, tRail);
      }
      // Pergola over the terrace: posts and a slatted beam grid.
      const px0 = -hx * 0.6, px1 = hx * 0.6;
      const pz = hz + 2.6;
      for (const sx of [px0, px1]) {
        metal.box(f, sx, plinth + 1.3, pz, 0.10, 1.3, 0.10, { tu: 1, tv: 2, tt: 1 }, trimOf([0.55, 0.42, 0.30], 0), F_ALL);
      }
      for (let i = 0; i < 8; i++) {
        metal.box(f, lerp(px0, px1, i / 7), plinth + 2.66, pz, 0.05, 0.06, 1.1,
          { tu: 1, tv: 1, tt: 1 }, trimOf([0.62, 0.48, 0.34], 0), F_ALL);
      }
    }

    // Hipped terracotta roof with a deep eave.
    gable(roofB, f, top + 0.14, hx + 0.55, hz + 0.55, 1.4 + rng() * 0.9,
      { tu: 3, tv: 3, tt: 3 }, trimOf([0.95, 0.90, 0.84], 0));
    wall.box(f, 0, top + 0.07, 0, hx + 0.55, 0.14, hz + 0.55, { tu: 2, tv: 2, tt: 2 }, tRail, F_PX | F_NX | F_PZ | F_NZ | F_NY);

    // A pool in the terrace, half the time: sunken mosaic with a coping edge.
    if (rng() < 0.55) {
      const pw = hx * 0.7, pd = 2.6;
      const pz2 = hz + 5.4;
      const px2 = l.x + Math.sin(l.yaw) * pz2;
      const pz3 = l.z + Math.cos(l.yaw) * pz2;
      // Sunken basin, a mosaic surface just under the coping, and a stone lip.
      conc.box(f, 0, plinth - 0.85, pz2, pw, 0.85, pd,
        { tu: 3, tv: 2, tt: 3 }, trimOf([0.97, 0.96, 0.93], 0), F_PX | F_NX | F_PZ | F_NZ);
      pave.flat(px2, lo + plinth - 0.14, pz3, pw, pd, l.yaw,
        0, BAND.pool[0] + 0.01, (pw * 2) / 4.5, BAND.pool[1] - 0.01, trimOf([1, 1, 1], 0));
      conc.box(f, 0, plinth - 0.06, pz2, pw + 0.55, 0.10, pd + 0.55,
        { tu: 2.4, tv: 2, tt: 2.4 }, trimOf([0.99, 0.97, 0.93], 0), F_PY | F_PX | F_NX | F_PZ | F_NZ);
    }

    collide(l.x, l.z, l.yaw, l.w, l.d, lo - 2, lo + top + 2.0, "building");
    built++;
  }

  /* --- Pier Verde -------------------------------------------------------- */

  function buildWharfShed(l: Lot) {
    const { lo, hi } = seat(l.x, l.z, l.yaw, l.w, l.d);
    const f = frameAt(l.x, l.z, lo, l.yaw);
    const shed = bat(l.group, "steel");
    const conc = bat(l.group, "concrete");
    const hx = l.w * 0.5, hz = l.d * 0.5;
    const tSkin = trimOf(pick(INDUSTRIAL_BODY, rng), 0.3);
    const base = (hi - lo) + 0.3;
    const h = 5.5 + rng() * 4;

    conc.box(f, 0, base * 0.5 - 1.2, 0, hx + 0.2, base * 0.5 + 1.2, hz + 0.2,
      { tu: 4, tv: 3, tt: 4 }, trimOf([0.70, 0.68, 0.64], 0), F_SHELL);
    shed.box(f, 0, base + h * 0.5, 0, hx, h * 0.5, hz,
      { tu: 6, tv: 6, tt: 6, uOff: rng(), vOff: rng() }, tSkin, F_SHELL);
    gable(shed, f, base + h, hx + 0.2, hz + 0.2, hz * 0.3, { tu: 6, tv: 6, tt: 6 }, tSkin);
    shed.box(f, 0, base + 2.0, hz + 0.05, hx * 0.42, 2.0, 0.10,
      { tu: 3, tv: 3, tt: 3 }, trimOf([0.26, 0.26, 0.27], 0), F_PZ | F_PX | F_NX | F_PY);
    collide(l.x, l.z, l.yaw, l.w, l.d, lo - 2, lo + base + h + hz * 0.32, "building");
    built++;
  }

  // --- dispatch ------------------------------------------------------------
  const BUILDERS: Record<District["kind"], (l: Lot) => void> = {
    victorian: buildVictorian,
    chinatown: buildChinatown,
    mission: buildMission,
    downtown: buildTower,
    industrial: buildIndustrial,
    resort: buildResort,
    wharf: buildWharfShed,
  };

  // Thin to the tier's ceiling before building, not after: shuffling the
  // survivors keeps the thinning uniform instead of clipping whole districts.
  for (let i = lots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = lots[i]; lots[i] = lots[j]; lots[j] = t;
  }
  let emitted = 0;
  for (const l of lots) {
    if (emitted >= tier.maxBuildings) break;
    const plan = PLANS[l.district.kind];
    if (rng() > plan.fill * tier.fill) continue;
    if (l.w < 4 || l.d < 6) continue;
    if (!buildable(l)) continue;
    try {
      BUILDERS[l.district.kind](l);
      emitted++;
    } catch {
      /* one bad lot must never take the city down */
    }
    if ((emitted & 511) === 511) await breathe();
  }

  await breathe();

  // -------------------------------------------------------------------------
  // Pier Verde — decks over the bay
  // -------------------------------------------------------------------------
  //
  // The one place the city is *supposed* to stand on water. Roots are found by
  // marching north from the district centre until `isWater` flips, so the piers
  // meet whatever shoreline terrain actually built.

  const wharfDistrict = DISTRICTS.find((d) => d.kind === "wharf");
  if (wharfDistrict) {
    const wd = wharfDistrict;
    const deckY = sea + 3.6;
    const conc = bat(wd.key, "concrete");
    const steel = bat(wd.key, "steel");
    const pave = bat(wd.key, "pavement");
    const tConc = trimOf([0.72, 0.70, 0.66], 0);
    const tDark = trimOf([0.30, 0.30, 0.31], 0);

    for (let i = 0; i < 6; i++) {
      const px = wd.x + (i - 2.5) * 74 + (rng() - 0.5) * 16;
      // Walk north until the ground drops below the waterline.
      let rz = wd.z + 60;
      let found = false;
      for (let k = 0; k < 90; k++) {
        if (wet(px, rz)) { found = true; break; }
        rz -= 6;
      }
      if (!found) continue;
      const len = 88 + rng() * 82;
      const halfW = 11 + rng() * 5;
      const cz = rz - len * 0.5 + 8;
      const f = frameAt(px, cz, deckY, 0);

      // Deck slab: a concrete box for the soffit and the edges, with one
      // bounded quad of paving slabs laid over the walking surface.
      conc.box(f, 0, -0.30, 0, halfW, 0.30, len * 0.5,
        { tu: 4, tv: 2.5, tt: 4 }, trimOf([0.84, 0.82, 0.77], 0), F_ALL);
      pave.flat(px, deckY + 0.012, cz, halfW, len * 0.5, 0,
        0, WALK_V0 + 0.01, (halfW * 2) / 7.2, WALK_V1 - 0.01, trimOf([0.88, 0.86, 0.81], 0));
      conc.box(f, -halfW - 0.15, 0.05, 0, 0.15, 0.28, len * 0.5, { tu: 3, tv: 2, tt: 3 }, tConc, F_ALL);
      conc.box(f, halfW + 0.15, 0.05, 0, 0.15, 0.28, len * 0.5, { tu: 3, tv: 2, tt: 3 }, tConc, F_ALL);

      // Pile bents every 9 m, driven to the bay floor.
      const bents = Math.max(3, Math.floor(len / 9));
      for (let b = 0; b <= bents; b++) {
        const lz = -len * 0.5 + (len * b) / bents;
        for (const sx of [-halfW + 1.4, 0, halfW - 1.4]) {
          const wx = px + sx, wz = cz + lz;
          const bed = Math.min(ground(wx, wz), deckY - 1.5);
          conc.prism(f, [sx - 0.34, lz - 0.34, sx + 0.34, lz - 0.34, sx + 0.34, lz + 0.34, sx - 0.34, lz + 0.34],
            bed - deckY - 0.6, -0.5, { tu: 2.4, tv: 4, tt: 2.4 }, tConc, false, false);
        }
        // Cross bracing between the outer piles.
        steel.box(f, 0, -1.4, lz, halfW - 1.0, 0.09, 0.09, { tu: 3, tv: 1, tt: 3 }, tDark, F_ALL);
      }
      collide(px, cz, 0, halfW * 2, len, deckY - 0.6, deckY, "pier");

      // Transit sheds down the pier, gabled, in works paint.
      const sheds = 1 + Math.floor(rng() * 2);
      for (let s = 0; s < sheds; s++) {
        const sl = len / (sheds + 0.6);
        const lz = -len * 0.4 + s * (sl + 6) + sl * 0.5;
        const sh = 6 + rng() * 3;
        const tSkin = trimOf(pick(INDUSTRIAL_BODY, rng), 0.3);
        const sf = frameAt(px, cz + lz, deckY, 0);
        steel.box(sf, 0, sh * 0.5, 0, halfW - 1.6, sh * 0.5, sl * 0.42,
          { tu: 6, tv: 6, tt: 6, uOff: rng(), vOff: rng() }, tSkin, F_SHELL);
        gable(steel, sf, sh, halfW - 1.4, sl * 0.44, sl * 0.13, { tu: 6, tv: 6, tt: 6 }, tSkin);
        steel.box(sf, 0, 2.1, sl * 0.42 + 0.05, (halfW - 1.6) * 0.4, 2.1, 0.10,
          { tu: 3, tv: 3, tt: 3 }, tDark, F_PZ | F_PX | F_NX | F_PY);
        collide(px, cz + lz, 0, (halfW - 1.6) * 2, sl * 0.88, deckY, deckY + sh + sl * 0.14, "building");
      }

      // A container gantry on the seaward end: legs, sill beam, cantilever jib.
      if (rng() < 0.7) {
        const gz = -len * 0.5 + 12;
        const gf = frameAt(px, cz + gz, deckY, 0);
        const gh = 22 + rng() * 10;
        const tCrane = trimOf([0.86, 0.52, 0.14], 0.15);
        for (const sx of [-halfW + 2.2, halfW - 2.2]) {
          for (const lz of [-3.5, 3.5]) {
            steel.prism(gf, [sx - 0.5, lz - 0.5, sx + 0.5, lz - 0.5, sx + 0.5, lz + 0.5, sx - 0.5, lz + 0.5],
              0, gh, { tu: 3, tv: 6, tt: 3 }, tCrane, true, false);
          }
          steel.box(gf, sx, gh * 0.55, 0, 0.35, 0.35, 4.2, { tu: 3, tv: 3, tt: 3 }, tCrane, F_ALL);
        }
        steel.box(gf, 0, gh + 1.0, 0, halfW - 1.6, 0.85, 1.1, { tu: 4, tv: 3, tt: 4 }, tCrane, F_ALL);
        // Jib reaching out over the water, plus the trolley hanging off it.
        steel.box(gf, 0, gh + 1.0, -18, halfW * 0.32, 0.7, 18, { tu: 4, tv: 3, tt: 4 }, tCrane, F_ALL);
        steel.box(gf, 0, gh - 1.4, -11, 1.1, 0.7, 1.1, { tu: 2, tv: 2, tt: 2 }, tDark, F_ALL);
        // Machinery house at the landward end.
        steel.box(gf, 0, gh + 3.0, 7.5, 3.0, 1.6, 3.0, { tu: 3, tv: 3, tt: 3 }, trimOf([0.5, 0.52, 0.52], 0.4), F_SHELL);
        collide(px, cz + gz, 0, halfW * 2, 10, deckY, deckY + gh + 4, "building");
      }
    }
  }

  await breathe();

  // -------------------------------------------------------------------------
  // Street furniture
  // -------------------------------------------------------------------------
  //
  // All instanced. A city without clutter reads as an architectural render; the
  // clutter is also where the eye takes its scale reading, so the lamp columns,
  // the kerbside cars and the hydrants matter more than another storey of
  // window detail.

  interface Inst { x: number; y: number; z: number; yaw: number; s: number; c?: RGB }

  const lamps: Inst[] = [];
  const signals: Inst[] = [];
  const benches: Inst[] = [];
  const bins: Inst[] = [];
  const hydrants: Inst[] = [];
  const cars: Inst[] = [];
  const containers: Inst[] = [];

  const wires = new Batch();

  for (const { s } of streets) {
    const n = s.pts.length / 2;
    if (n < 3) continue;
    const spacing = s.arterial ? 26 : 32;
    let acc = rng() * spacing;
    let carAcc = rng() * 14;
    let prevLampX = 0, prevLampZ = 0, prevLampY = 0, havePrev = false;

    for (let i = 1; i < n; i++) {
      const ax = s.pts[i * 2 - 2], az = s.pts[i * 2 - 1];
      const bx = s.pts[i * 2], bz = s.pts[i * 2 + 1];
      const seg = Math.hypot(bx - ax, bz - az);
      if (seg < 1e-3) continue;
      const dx = (bx - ax) / seg, dz = (bz - az) / seg;
      const nx = -dz, nz = dx;

      for (let t = 0; t < seg; t += 1) {
        acc += 1;
        carAcc += 1;
        const cxp = ax + dx * t, czp = az + dz * t;

        if (acc >= spacing) {
          acc = 0;
          const side = rng() < 0.5 ? 1 : -1;
          const lx = cxp + nx * side * (s.half + s.walk * 0.55);
          const lz = czp + nz * side * (s.half + s.walk * 0.55);
          if (!wet(lx, lz) && rng() < tier.props) {
            const ly = ground(lx, lz) + KERB;
            lamps.push({ x: lx, y: ly, z: lz, yaw: Math.atan2(-nx * side, -nz * side), s: 1 });
            // Trolley span across the street to the previous column.
            if (tier.wires && havePrev && Math.hypot(lx - prevLampX, lz - prevLampZ) < spacing * 1.7 && rng() < 0.5) {
              const segs = 6;
              const y0 = prevLampY + 7.2, y1 = ly + 7.2;
              for (let k = 0; k < segs; k++) {
                const t0 = k / segs, t1 = (k + 1) / segs;
                const mid = (t0 + t1) * 0.5;
                const wx = lerp(prevLampX, lx, mid), wz = lerp(prevLampZ, lz, mid);
                const wy = lerp(y0, y1, mid) - Math.sin(mid * Math.PI) * 0.9;
                const wf = frameAt(wx, wz, wy, Math.atan2(lx - prevLampX, lz - prevLampZ));
                const half = (Math.hypot(lx - prevLampX, lz - prevLampZ) / segs) * 0.55;
                wires.box(wf, 0, 0, 0, 0.035, 0.035, half, { tu: 2, tv: 2, tt: 2 }, trimOf([0.16, 0.16, 0.17], 0), F_ALL);
              }
            }
            prevLampX = lx; prevLampZ = lz; prevLampY = ly; havePrev = true;
          }
        }

        // Kerbside parking. Cars sit on the carriageway, nose along the street.
        if (carAcc >= 6.5 + rng() * 5) {
          carAcc = 0;
          if (rng() < tier.props * 0.62) {
            const side = rng() < 0.5 ? 1 : -1;
            const lx = cxp + nx * side * (s.half - 1.35);
            const lz = czp + nz * side * (s.half - 1.35);
            if (!wet(lx, lz)) {
              cars.push({
                x: lx, y: ground(lx, lz) + ROAD_LIFT, z: lz,
                yaw: Math.atan2(dx, dz) + (side > 0 ? 0 : Math.PI) + (rng() - 0.5) * 0.05,
                s: 1, c: pick(CAR_COLORS, rng),
              });
            }
          }
        }

        // Small furniture, sparse and always against the building line.
        if (rng() < 0.006 * tier.props) {
          const side = rng() < 0.5 ? 1 : -1;
          const lx = cxp + nx * side * (s.half + s.walk * 0.8);
          const lz = czp + nz * side * (s.half + s.walk * 0.8);
          if (wet(lx, lz)) continue;
          const y = ground(lx, lz) + KERB;
          const yaw = Math.atan2(-nx * side, -nz * side);
          const r = rng();
          if (r < 0.38) benches.push({ x: lx, y, z: lz, yaw, s: 1 });
          else if (r < 0.72) bins.push({ x: lx, y, z: lz, yaw, s: 1 });
          else hydrants.push({ x: cxp + nx * side * (s.half + 0.7), y: ground(cxp + nx * side * (s.half + 0.7), czp + nz * side * (s.half + 0.7)) + KERB, z: czp + nz * side * (s.half + 0.7), yaw, s: 1 });
        }
      }
    }
  }

  // Signals on every grid junction that carries enough traffic to warrant one.
  for (const j of junctions) {
    if (rng() > 0.34 * Math.min(1, tier.props * 1.6)) continue;
    for (let k = 0; k < 2; k++) {
      const a = j.yaw + k * Math.PI + Math.PI * 0.5;
      const lx = j.x + Math.sin(a) * (j.half + 1.0) + Math.cos(a) * (j.half + 1.0);
      const lz = j.z + Math.cos(a) * (j.half + 1.0) - Math.sin(a) * (j.half + 1.0);
      if (wet(lx, lz)) continue;
      signals.push({ x: lx, y: ground(lx, lz) + KERB, z: lz, yaw: a + Math.PI, s: 1 });
    }
  }

  // Container stacks along Astillero and the wharf aprons.
  for (const d of DISTRICTS) {
    if (d.kind !== "industrial" && d.kind !== "wharf") continue;
    const stacks = Math.floor(38 * tier.props);
    for (let i = 0; i < stacks; i++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * d.radius * 0.9;
      const x = d.x + Math.cos(a) * r, z = d.z + Math.sin(a) * r;
      if (wet(x, z) || districtAt(x, z) !== d || reserved(x, z, 20)) continue;
      const y = ground(x, z);
      if (y < sea + 1.2) continue;
      const yaw = (BEARINGS[d.key] ?? 0) + (rng() < 0.5 ? 0 : Math.PI * 0.5);
      const high = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < high; k++) {
        containers.push({ x, y: y + k * 2.62, z, yaw: yaw + (rng() - 0.5) * 0.04, s: 1, c: pick(CONTAINER_COLORS, rng) });
      }
      _box.min.set(x - 3.2, y, z - 3.2);
      _box.max.set(x + 3.2, y + high * 2.62, z + 3.2);
      broadphase.addBox(_box, { tag: "prop" });
    }
  }

  await breathe();

  // -------------------------------------------------------------------------
  // Prop prototypes
  // -------------------------------------------------------------------------

  const O = frameAt(0, 0, 0, 0);
  const SIGN_Q = 1 / SIGN_COLS;
  /** UV that pins a whole surface to the centre of one signage atlas cell. */
  const lensUV = (cell: number): BoxUV => ({
    tu: 1e6, tv: 1e6, tt: 1e6,
    uOff: ((cell % SIGN_COLS) + 0.5) * SIGN_Q,
    vOff: (Math.floor(cell / SIGN_COLS) + 0.5) * SIGN_Q,
  });

  const proto = (fn: (b: Batch) => void): THREE.BufferGeometry | null => {
    const b = new Batch();
    fn(b);
    return b.build();
  };

  const ringOutline = (r: number, sides: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      out.push(Math.cos(a) * r, Math.sin(a) * r);
    }
    return out;
  };

  const tIron: Trim = [0.24, 0.25, 0.26, 0];
  const tSteelPale: Trim = [0.62, 0.63, 0.64, 0];
  const uvM: BoxUV = { tu: 1.2, tv: 2.0, tt: 1.2 };

  // Lamp column: fluted base, tapered shaft, swan-neck arm, lantern.
  const lampGeo = proto((b) => {
    b.prism(O, ringOutline(0.16, 8), 0, 0.55, uvM, tIron, true, false);
    b.prism(O, ringOutline(0.085, 8), 0.5, 6.9, uvM, tIron, true, false);
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      b.box(O, 0, 6.9 + t * 0.55, t * 0.42, 0.055, 0.075, 0.16, uvM, tIron, F_ALL);
    }
    b.box(O, 0, 7.32, 0.95, 0.10, 0.055, 0.42, uvM, tIron, F_ALL);
  });
  const lampLensGeo = proto((b) => {
    b.box(O, 0, 7.16, 1.28, 0.22, 0.11, 0.34, lensUV(15), [1, 1, 1, 1], F_ALL);
    b.prism(O, ringOutline(0.26, 6), 7.24, 7.44, lensUV(15), [0.6, 0.6, 0.6, 0.2], true, false);
  });

  // Traffic signal: post, mast arm, three-aspect head.
  const signalGeo = proto((b) => {
    b.prism(O, ringOutline(0.10, 8), 0, 3.5, uvM, tIron, true, false);
    b.box(O, 0, 3.45, 0.75, 0.06, 0.06, 0.75, uvM, tIron, F_ALL);
    b.box(O, 0, 2.62, 1.42, 0.20, 0.62, 0.16, uvM, tIron, F_ALL);
    b.box(O, 0, 2.62, 1.62, 0.24, 0.66, 0.05, uvM, [0.14, 0.15, 0.15, 0], F_ALL);
  });
  const signalLensGeo = proto((b) => {
    for (let i = 0; i < 3; i++) {
      b.box(O, 0, 3.02 - i * 0.40, 1.68, 0.13, 0.13, 0.02, lensUV(12 + i), [1, 1, 1, i === 2 ? 1 : 0.35], F_PZ);
    }
  });

  // Bench: slatted seat and back on cast cheeks.
  const benchGeo = proto((b) => {
    for (let i = 0; i < 4; i++) {
      b.box(O, 0, 0.44, -0.24 + i * 0.16, 0.86, 0.028, 0.062, uvM, [0.55, 0.40, 0.26, 0], F_ALL);
    }
    for (let i = 0; i < 3; i++) {
      b.box(O, 0, 0.62 + i * 0.16, -0.34, 0.86, 0.055, 0.028, uvM, [0.55, 0.40, 0.26, 0], F_ALL);
    }
    for (const sx of [-0.82, 0.82]) {
      b.box(O, sx, 0.22, 0, 0.05, 0.22, 0.28, uvM, tIron, F_ALL);
      b.box(O, sx, 0.62, -0.30, 0.05, 0.24, 0.05, uvM, tIron, F_ALL);
    }
  });

  // Litter bin, hydrant.
  const binGeo = proto((b) => {
    b.prism(O, ringOutline(0.30, 10), 0.08, 0.92, uvM, tIron, false, false);
    b.prism(O, ringOutline(0.33, 10), 0.92, 1.02, uvM, [0.34, 0.35, 0.36, 0], true, false);
    b.prism(O, ringOutline(0.26, 10), 0, 0.10, uvM, tIron, true, false);
  });
  const hydrantGeo = proto((b) => {
    b.prism(O, ringOutline(0.17, 8), 0, 0.62, uvM, [0.86, 0.30, 0.16, 0], true, false);
    b.prism(O, ringOutline(0.12, 8), 0.62, 0.80, uvM, [0.86, 0.30, 0.16, 0], true, false);
    b.box(O, 0.20, 0.44, 0, 0.09, 0.09, 0.09, uvM, [0.90, 0.72, 0.20, 0], F_ALL);
    b.box(O, -0.20, 0.44, 0, 0.09, 0.09, 0.09, uvM, [0.90, 0.72, 0.20, 0], F_ALL);
  });

  // Car: a tapered greenhouse over a body, four wheels, lamps at both ends.
  const carGeo = proto((b) => {
    const uv: BoxUV = { tu: 2.4, tv: 1.6, tt: 2.4 };
    b.box(O, 0, 0.62, 0, 0.86, 0.30, 2.16, uv, [1, 1, 1, 0], F_ALL);
    b.box(O, 0, 0.36, 0, 0.80, 0.16, 2.20, uv, [0.86, 0.86, 0.86, 0], F_ALL);
    b.prism(O, [-0.80, -0.95, 0.80, -0.95, 0.70, 0.72, -0.70, 0.72], 0.90, 1.32, uv, [1, 1, 1, 0], true, false);
    // Bumpers and lamps.
    b.box(O, 0, 0.50, 2.18, 0.82, 0.14, 0.06, uv, [0.30, 0.31, 0.32, 0], F_ALL);
    b.box(O, 0, 0.50, -2.18, 0.82, 0.14, 0.06, uv, [0.30, 0.31, 0.32, 0], F_ALL);
    b.box(O, 0.58, 0.74, 2.18, 0.20, 0.09, 0.04, lensUV(15), [1, 1, 1, 0.55], F_PZ);
    b.box(O, -0.58, 0.74, 2.18, 0.20, 0.09, 0.04, lensUV(15), [1, 1, 1, 0.55], F_PZ);
    b.box(O, 0.58, 0.74, -2.18, 0.20, 0.09, 0.04, lensUV(12), [1, 1, 1, 0.35], F_NZ);
    b.box(O, -0.58, 0.74, -2.18, 0.20, 0.09, 0.04, lensUV(12), [1, 1, 1, 0.35], F_NZ);
  });
  const carGlassGeo = proto((b) => {
    const uv: BoxUV = { tu: 3, tv: 2, tt: 3 };
    const t: Trim = [0.10, 0.12, 0.14, 0];
    b.prism(O, [-0.74, -0.90, 0.74, -0.90, 0.65, 0.68, -0.65, 0.68], 0.94, 1.26, uv, t, false, false);
    for (const sx of [-0.88, 0.88]) {
      for (const sz of [-1.42, 1.42]) {
        b.box(O, sx, 0.34, sz, 0.10, 0.33, 0.33, uv, [0.08, 0.08, 0.09, 0], F_ALL);
      }
    }
  });

  // Shipping container: corrugated box with door furniture on one end.
  const containerGeo = proto((b) => {
    const uv: BoxUV = { tu: 2.2, tv: 2.2, tt: 2.2 };
    b.box(O, 0, 1.30, 0, 1.22, 1.30, 3.05, uv, [1, 1, 1, 0], F_ALL);
    for (const sy of [0.04, 2.56]) {
      b.box(O, 0, sy, 0, 1.26, 0.06, 3.09, uv, [0.72, 0.72, 0.70, 0], F_ALL);
    }
    for (let i = 0; i < 2; i++) {
      b.box(O, (i - 0.5) * 1.1, 1.30, 3.07, 0.05, 1.22, 0.05, uv, [0.60, 0.60, 0.58, 0], F_ALL);
    }
  });

  /** Wrap a prototype into an InstancedMesh, or nothing when the list is empty. */
  function instance(
    geo: THREE.BufferGeometry | null,
    mat: THREE.Material,
    list: Inst[],
    colored: boolean,
    shadow: boolean,
  ): THREE.InstancedMesh | null {
    if (!geo || list.length === 0) return null;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const col = new THREE.Color();
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      q.setFromAxisAngle(_v.set(0, 1, 0), it.yaw);
      p.set(it.x, it.y, it.z);
      s.setScalar(it.s);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      if (colored && it.c) mesh.setColorAt(i, col.setRGB(it.c[0], it.c[1], it.c[2]));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    try {
      mesh.computeBoundingSphere();
    } catch {
      mesh.frustumCulled = false;
    }
    root.add(mesh);
    return mesh;
  }

  const instanced: THREE.InstancedMesh[] = [];
  const push = (m: THREE.InstancedMesh | null) => { if (m) instanced.push(m); };

  push(instance(lampGeo, materials.steel, lamps, false, true));
  push(instance(lampLensGeo, materials.sign, lamps, false, false));
  push(instance(signalGeo, materials.steel, signals, false, true));
  push(instance(signalLensGeo, materials.sign, signals, false, false));
  push(instance(benchGeo, materials.paint, benches, false, true));
  push(instance(binGeo, materials.steel, bins, false, true));
  push(instance(hydrantGeo, materials.paint, hydrants, false, true));
  push(instance(carGeo, materials.paint, cars, true, true));
  push(instance(carGlassGeo, materials.paint, cars, false, false));
  push(instance(containerGeo, materials.steel, containers, true, true));

  await breathe();

  // -------------------------------------------------------------------------
  // Assembly
  // -------------------------------------------------------------------------

  const meshes: THREE.Mesh[] = [];
  const geometries: THREE.BufferGeometry[] = [];

  for (const [key, b] of batches) {
    const geo = b.build();
    if (!geo) continue;
    const fam = key.slice(key.indexOf("|") + 1);
    const mat = materials[fam] ?? materials.concrete;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "palmas.city." + key;
    // Roads and decals only receive; everything vertical casts as well. Decals
    // must not write shadows at all or they self-shadow into a dark smear.
    const flatSurface = fam === "asphalt" || fam === "pavement" || fam === "decal";
    mesh.castShadow = !flatSurface;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    root.add(mesh);
    meshes.push(mesh);
    geometries.push(geo);
  }

  const wireGeo = tier.wires ? wires.build() : null;
  if (wireGeo) {
    const wireMesh = new THREE.Mesh(wireGeo, materials.steel);
    wireMesh.name = "palmas.city.wires";
    wireMesh.castShadow = false;
    wireMesh.receiveShadow = false;
    wireMesh.matrixAutoUpdate = false;
    wireMesh.updateMatrix();
    root.add(wireMesh);
    meshes.push(wireMesh);
    geometries.push(wireGeo);
  }

  broadphase.seal();
  broadphase.playerPosition = ctx.services.player?.position ?? null;
  broadphase.playerVelocity = ctx.services.player?.velocity ?? null;

  let triangles = 0;
  for (const g of geometries) triangles += (g.getIndex()?.count ?? 0) / 3;

  ctx.emit("palmas:city-ready", {
    buildings: emitted,
    streets: streets.length,
    junctions: junctions.length,
    colliders: broadphase.count,
    drawCalls: meshes.length + instanced.length,
    triangles: Math.round(triangles),
  });

  // -------------------------------------------------------------------------

  const glowColor = new THREE.Color();

  const sys: System = {
    name: "city",

    update(_dt, c) {
      // The player system boots after the city, so bind its vectors the first
      // time they appear rather than assuming they were there at construction.
      if (!broadphase.playerPosition && c.services.player) {
        broadphase.playerPosition = c.services.player.position;
        broadphase.playerVelocity = c.services.player.velocity;
      }

      // Windows and neon come up as the sun goes down. One uniform, shared by
      // every city material, so this is a single write per frame.
      const daylight = c.services.sky?.daylight ?? 1;
      const night = clamp01(1 - daylight * 1.45);
      glowUniforms.uNightGlow.value = night * night * 2.6;
      // Interiors warm up and neon cools as true night sets in.
      glowColor.setRGB(1.0, lerp(0.86, 0.72, night), lerp(0.62, 0.42, night));
      glowUniforms.uGlowColor.value.copy(glowColor);
    },

    dispose() {
      ctx.scene.remove(root);
      for (const g of geometries) g.dispose();
      for (const m of instanced) {
        m.geometry.dispose();
        m.dispose();
      }
      for (const key of Object.keys(materials)) materials[key].dispose();
      for (const fam of FAMILIES) {
        maps[fam].map.dispose();
        maps[fam].normal.dispose();
        maps[fam].aux.dispose();
      }
      if (ctx.services.collision === broadphase) delete ctx.services.collision;
    },
  };

  return sys;
};

export default createCity;
