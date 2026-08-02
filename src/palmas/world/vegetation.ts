/**
 * San Palmas — vegetation.
 *
 * The tropical half of tropical-SF. Everything that grows: coconut palms
 * leaning off the beaches, a genuinely thick jungle canopy on the hills,
 * wind-shaped cypress and eucalyptus on the exposed tops, agave and scrub on
 * the cliffs, and street palms down the avenues.
 *
 * Four pieces, in dependency order:
 *
 *  1. THE ATLAS. One 4x4 canvas atlas carries every leaf, frond, bark and
 *     bloom this module will ever draw — fronds, banana paddles, broadleaf
 *     clusters, fern fronds, four barks, grass, agave blades, bougainvillea,
 *     sea grape, cypress spray, eucalyptus sickles, vines and dead thatch.
 *     Organic shapes are drawn with Canvas2D paths; the four bark cells are
 *     written straight into the pixel buffer from tileable value/Worley noise,
 *     because a bark that does not wrap shows a seam down the trunk. The
 *     buffer is then RGB-dilated into its transparent margins (so mip chains
 *     never bleed black halos around a leaf), Sobel'd into a normal map, and
 *     re-read into a roughness map. NO EXTERNAL ASSETS — see the repo rule.
 *
 *  2. THE PLANTS. Real geometry, not billboards. Fronds are curved, tapered,
 *     twisted, V-keeled strips — a frond seen edge-on still reads as a frond
 *     because the keel gives it a cross-section. Trunks are swept tubes with a
 *     root flare and a running frame, so a leaning palm has a circular section
 *     perpendicular to its own axis instead of a sheared ellipse. Broadleaf
 *     canopies are the only cross-planes here, and every card sits on an
 *     ellipsoid shell with its normals blended 70% toward the shell normal —
 *     that single trick is what stops a pile of quads reading as a pile of
 *     quads. Three LODs per canopy species, decimated geometry (never
 *     billboards), so there is nothing to pop or flip.
 *
 *  3. THE MATERIAL. One MeshStandardMaterial for every plant in the world
 *     (scene.environment only lights Standard/Physical in r160), alpha-tested,
 *     double-sided, with three injections via onBeforeCompile:
 *       • vertex wind — per-instance phase and compliance, the world-space
 *         gust rotated into instance space by a cached inverse yaw, trunks
 *         swaying quadratically with height and fronds fluttering along their
 *         own length rather than pivoting rigidly;
 *       • fragment back-lit transmission — forward-scatter plus wrap, keyed
 *         off the sun. Low sun through a frond is the single loudest "this was
 *         lit properly" tell there is;
 *       • an ordered-dither distance fade so ground cover and the far LOD
 *         dissolve instead of popping.
 *     A matching customDepthMaterial carries the same wind into the shadow
 *     map, or every shadow would be of a tree standing still.
 *
 *  4. THE STREAMER. Nothing is placed at boot. Two grids of cells (128 m for
 *     plants, 32 m for ground cover) generate their contents from a
 *     cell-seeded RNG the first time the player comes near, band by band, on a
 *     per-frame time budget. Instances live in slot pools with swap-with-last
 *     compaction, so a cell leaving the radius costs O(its own instances) and
 *     the GPU never sees a gap. ~42 draw calls for the whole world.
 *
 * Reads: TerrainService (every plant is seated with `heightAt`, and nothing is
 * placed where `isWater`), SkyService (sun colour/daylight for the
 * transmission term), the atlas (biomes, districts, avenues, landmarks). All
 * optional — with no terrain service the module falls back to the atlas
 * profile rather than throwing, because nothing here may take the boot down.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre.
 */
import * as THREE from "three";
import type { QualityTier, System, SystemFactory, TerrainService } from "../types";
import { makeRng } from "../types";
import type { Biome } from "./atlas";
import {
  AVENUES,
  DISTRICTS,
  LANDMARKS,
  SEA_LEVEL,
  biomeAt,
  districtAt,
  hillHeight,
  landSignedDistance,
  shoreProfile,
} from "./atlas";

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

const TAU = Math.PI * 2;

/** Plant grid cell, metres. Big enough that 1 km of radius is ~300 cells. */
const PLANT_CELL = 128;
/** Ground-cover grid cell, metres. Small, because its radius is small. */
const COVER_CELL = 32;

/** Alpha cutoff. Low enough to keep soft leaf edges, high enough to not fuzz. */
const ALPHA_TEST = 0.42;

interface VegTier {
  /** Atlas texture resolution (a 4x4 grid of cells). */
  atlas: number;
  /** Radial segments on an LOD0 trunk. */
  radial: number;
  /** Length segments on an LOD0 frond. */
  frondSegs: number;
  /** Global density multiplier. */
  density: number;
  /** Band radii, metres: LOD0 / mid-plant LOD1 / canopy LOD1 / canopy LOD2. */
  bands: [number, number, number, number];
  /** Ground-cover radius. 0 disables ground cover entirely. */
  cover: number;
  /** Ground cover starts dissolving this far out, and is gone at `cover`. */
  coverFade: number;
  /** Variants built per species at LOD0. */
  variants: number;
  /** Cast shadows from LOD0 plants. */
  shadows: boolean;
  /** Dead-frond skirts, coconuts, hanging vines, agave flower spikes. */
  detail: boolean;
  /** Streaming budget, milliseconds per frame. */
  budgetMs: number;
  aniso: number;
}

const TIERS: Record<QualityTier, VegTier> = {
  low: {
    atlas: 512, radial: 5, frondSegs: 5, density: 0.34,
    bands: [105, 150, 250, 560], cover: 0, coverFade: 0,
    variants: 1, shadows: false, detail: false, budgetMs: 1.1, aniso: 2,
  },
  medium: {
    atlas: 768, radial: 6, frondSegs: 7, density: 0.62,
    bands: [145, 200, 345, 780], cover: 62, coverFade: 42,
    variants: 2, shadows: false, detail: true, budgetMs: 1.6, aniso: 4,
  },
  high: {
    atlas: 1024, radial: 7, frondSegs: 9, density: 1.0,
    bands: [175, 245, 430, 950], cover: 88, coverFade: 60,
    variants: 2, shadows: true, detail: true, budgetMs: 2.1, aniso: 8,
  },
  ultra: {
    atlas: 1536, radial: 8, frondSegs: 11, density: 1.35,
    bands: [215, 305, 520, 1150], cover: 115, coverFade: 80,
    variants: 3, shadows: true, detail: true, budgetMs: 2.8, aniso: 16,
  },
};

/**
 * Landmark footprints the landmarks module owns. Mirrors city.ts's RESERVED
 * table with a little more margin — a palm growing out of Puente Dorado's
 * anchorage is the kind of thing that ends up in a review screenshot.
 */
const LANDMARK_CLEAR: Record<string, number> = {
  bridge: 260,
  pyramid: 100,
  coit: 78,
  ferry: 90,
  alcatraz: 130,
};

/**
 * Arterial half-width (11 m) plus pavement (4.2 m), from city.ts. Street palms
 * stand inside that band, which the city guarantees is clear of buildings;
 * everything else keeps well outside it so nothing grows in a carriageway.
 */
const ARTERIAL_HALF = 11;
const ARTERIAL_WALK = 4.2;
/** Wild vegetation must stay this far off an avenue centreline. */
const AVENUE_CLEAR = ARTERIAL_HALF + ARTERIAL_WALK + 7;

/* ------------------------------------------------------------------------ *
 * Small maths
 * ------------------------------------------------------------------------ */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Integer hash on a lattice. Shared by every noise below. */
function hash2(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise wrapping every `period` lattice cells — the tiling guarantee. */
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

/**
 * Anisotropic tileable fBm. Bark wants features that are long in one axis and
 * narrow in the other — vertical fissures, horizontal frond scars — so the two
 * periods are independent. Both must stay integers or the cell stops wrapping.
 */
function fbmA(u: number, v: number, pu: number, pv: number, oct: number, seed: number): number {
  let amp = 1, sum = 0, norm = 0, a = pu, b = pv;
  for (let o = 0; o < oct; o++) {
    // A rectangular lattice needs a single modulus, so wrap on the larger of
    // the two and scale the shorter axis into it.
    const p = Math.max(a, b);
    sum += vnoise((u * a) % p, (v * b) % p, p, seed + o * 131) * amp;
    norm += amp;
    amp *= 0.5;
    a *= 2; b *= 2;
  }
  return sum / norm;
}

/** Isotropic tileable fBm. */
function fbmT(u: number, v: number, period: number, oct: number, seed: number): number {
  return fbmA(u, v, period, period, oct, seed);
}

/** Tileable Worley F1, roughly 0..1. Cell structure for lichen and peel. */
function worleyT(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells, y = v * cells;
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 16;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const wx = ((cx % cells) + cells) % cells;
      const wy = ((cy % cells) + cells) % cells;
      const dx = cx + hash2(wx, wy, seed) - x;
      const dy = cy + hash2(wx, wy, seed + 9781) - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best) * 1.45);
}

/** Which Worley cell owns this point — gives every peel flake its own tint. */
function worleyId(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells, y = v * cells;
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 16, id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const wx = ((cx % cells) + cells) % cells;
      const wy = ((cy % cells) + cells) % cells;
      const dx = cx + hash2(wx, wy, seed) - x;
      const dy = cy + hash2(wx, wy, seed + 9781) - y;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; id = hash2(wx, wy, seed + 31337); }
    }
  }
  return id;
}

/** Ridged fractal — the |n| fold gives creases instead of blobs. */
function ridgedA(u: number, v: number, pu: number, pv: number, oct: number, seed: number): number {
  let amp = 1, sum = 0, norm = 0, a = pu, b = pv;
  for (let o = 0; o < oct; o++) {
    const p = Math.max(a, b);
    const n = 1 - Math.abs(vnoise((u * a) % p, (v * b) % p, p, seed + o * 77) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    a *= 2; b *= 2;
  }
  return sum / norm;
}

/** Unbounded world-space value noise — used by the scatter, never by a texture. */
function vnoiseW(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  const top = a + (b - a) * u;
  return top + (c + (d - c) * u - top) * v;
}

/** Two-octave world fBm. Drives clearings, thickets and species drift. */
function fbmW(x: number, y: number, seed: number): number {
  return vnoiseW(x, y, seed) * 0.66 + vnoiseW(x * 2.7 + 11.3, y * 2.7 - 4.1, seed + 77) * 0.34;
}

/* ------------------------------------------------------------------------ *
 * The atlas
 * ------------------------------------------------------------------------ */
//
// Cell indices are (col + row * 4), row 0 at the TOP of the canvas. `cellUV`
// flips V on the way out, so a paint function drawing with its base at the
// bottom of the cell lines up with geometry v = 0 at the base of a frond.

const C_FROND = 0;      // coconut palm frond
const C_PADDLE = 1;     // traveller's palm / heliconia paddle
const C_BROAD = 2;      // clustered broadleaf card
const C_FERNL = 3;      // fern frond
const C_BARK_PALM = 4;
const C_BARK_WOOD = 5;
const C_BARK_EUC = 6;
const C_BARK_FIBRE = 7;
const C_GRASS = 8;
const C_AGAVE = 9;
const C_BLOOM = 10;
const C_SEAGRAPE = 11;
const C_CYPRESS = 12;
const C_EUCLEAF = 13;
const C_VINE = 14;
const C_DRY = 15;

/** The four bark cells are written procedurally, not painted. */
const BARK_CELLS = [C_BARK_PALM, C_BARK_WOOD, C_BARK_EUC, C_BARK_FIBRE];

/** Base roughness per cell. Tropical leaves are waxy; bark is not. */
const CELL_ROUGH = [
  0.62, 0.58, 0.66, 0.70,
  0.90, 0.94, 0.80, 0.93,
  0.78, 0.52, 0.72, 0.56,
  0.74, 0.66, 0.70, 0.88,
];

/** How much relief the normal map pulls out of each cell's luminance. */
const CELL_RELIEF = [
  0.55, 0.75, 0.45, 0.45,
  1.60, 2.30, 1.10, 1.45,
  0.35, 0.90, 0.55, 0.85,
  0.35, 0.45, 0.35, 0.60,
];

/** UV rect of a cell, inset so mip chains cannot bleed across the grid lines. */
function cellUV(cell: number): { u0: number; v0: number; du: number; dv: number } {
  const col = cell & 3, row = cell >> 2;
  const inset = 0.004;
  const u0 = col * 0.25 + inset;
  // Row 0 sits at the top of the canvas; texture V runs the other way.
  const v0 = (3 - row) * 0.25 + inset;
  return { u0, v0, du: 0.25 - inset * 2, dv: 0.25 - inset * 2 };
}

type G2 = CanvasRenderingContext2D;
type Rnd = () => number;

const css = (h: number, s: number, l: number, a = 1) =>
  `hsla(${h.toFixed(1)},${(s * 100).toFixed(1)}%,${(l * 100).toFixed(1)}%,${a.toFixed(3)})`;

/**
 * Draw one atlas cell in a normalised, Y-UP coordinate box inset from the cell
 * edge. Y-up matters: `cellUV` flips V, so local y = 0 is texture v = 0, which
 * is where every frond, blade and stem is rooted.
 */
function paintCell(g: G2, size: number, cell: number, draw: (g: G2) => void): void {
  const col = cell & 3, row = cell >> 2;
  const s = size * 0.25;
  const pad = s * 0.05;
  const inner = s - pad * 2;
  g.save();
  g.beginPath();
  g.rect(col * s, row * s, s, s);
  g.clip();
  g.translate(col * s + pad, row * s + s - pad);
  g.scale(inner, -inner);
  g.lineCap = "round";
  g.lineJoin = "round";
  draw(g);
  g.restore();
}

/** A lanceolate leaflet/leaf: two quadratics from base to tip and back. */
function leafPath(
  g: G2, bx: number, by: number, tx: number, ty: number, w: number, bulge = 0.5,
): void {
  const dx = tx - bx, dy = ty - by;
  const len = Math.hypot(dx, dy) || 1e-4;
  const px = -dy / len, py = dx / len;         // unit normal to the leaf axis
  const mx = bx + dx * bulge, my = by + dy * bulge;
  g.beginPath();
  g.moveTo(bx, by);
  g.quadraticCurveTo(mx + px * w, my + py * w, tx, ty);
  g.quadraticCurveTo(mx - px * w, my - py * w, bx, by);
  g.closePath();
}

/* ---- row 0: the big leaves ---------------------------------------------- */

/**
 * A coconut frond, painted straight: the geometry supplies the arch, the
 * twist and the keel, so the texture only has to supply leaflets and gaps.
 * Leaflets sweep from ~62° off the rachis at the base to ~24° at the tip,
 * which is the angle profile that reads unmistakably as a palm.
 */
function paintFrond(g: G2, rnd: Rnd, dry: boolean): void {
  const hw = (t: number) => 0.47 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.94 + 0.06)), 0.62);
  const hueOf = () => (dry ? 26 + rnd() * 20 : 82 + rnd() * 34);
  const satOf = () => (dry ? 0.30 + rnd() * 0.24 : 0.36 + rnd() * 0.28);

  // Rachis first, so leaflets overlap it and hide the join.
  g.fillStyle = css(dry ? 34 : 68, 0.34, dry ? 0.30 : 0.24);
  g.beginPath();
  g.moveTo(0.5 - 0.014, 0.0);
  g.lineTo(0.5 + 0.014, 0.0);
  g.lineTo(0.5 + 0.004, 1.0);
  g.lineTo(0.5 - 0.004, 1.0);
  g.closePath();
  g.fill();

  const n = 58;
  for (let i = 0; i < n; i++) {
    for (let sideI = 0; sideI < 2; sideI++) {
      const side = sideI === 0 ? -1 : 1;
      if (rnd() < (dry ? 0.16 : 0.05)) continue;          // natural gaps
      const t = 0.035 + 0.945 * ((i + (sideI ? 0.5 : 0)) / n) + (rnd() - 0.5) * 0.008;
      if (t > 0.995) continue;
      const len = hw(t) * (0.86 + rnd() * 0.24);
      const ang = lerp(1.09, 0.40, Math.pow(t, 0.85)) + (rnd() - 0.5) * 0.16;
      const sag = dry ? 0.34 : 0.13;
      const bx = 0.5 + side * 0.006;
      const tx = bx + side * len * Math.sin(ang);
      const ty = t + len * Math.cos(ang) - len * sag;
      const w = (0.0115 + 0.0055 * (1 - t)) * (0.8 + rnd() * 0.5);

      const h = hueOf();
      const sat = satOf();
      const lum = (dry ? 0.24 : 0.17) + 0.20 * t + rnd() * 0.13 + (side > 0 ? 0.02 : 0);
      g.fillStyle = css(h, sat, lum);
      leafPath(g, bx, t, tx, ty, w, 0.46);
      g.fill();

      // Midvein: a pale hairline. This is most of the normal-map relief.
      g.strokeStyle = css(h + 6, sat * 0.7, Math.min(0.72, lum + 0.16), 0.75);
      g.lineWidth = 0.0022;
      g.beginPath();
      g.moveTo(bx, t);
      g.quadraticCurveTo((bx + tx) * 0.5, (t + ty) * 0.5 + w * 0.15, tx, ty);
      g.stroke();
    }
  }
}

/** A traveller's-palm / heliconia paddle: midrib, lateral veins, torn edges. */
function paintPaddle(g: G2, rnd: Rnd): void {
  const hw = (t: number) => 0.43 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.90 + 0.07)), 0.34);
  const hue = 96 + rnd() * 22;

  // Blade, as a filled outline sampled off the width profile.
  g.beginPath();
  g.moveTo(0.5, 0.0);
  for (let i = 0; i <= 40; i++) { const t = i / 40; g.lineTo(0.5 - hw(t), t); }
  for (let i = 40; i >= 0; i--) { const t = i / 40; g.lineTo(0.5 + hw(t), t); }
  g.closePath();
  const grd = g.createLinearGradient(0, 0, 0, 1);
  grd.addColorStop(0, css(hue - 10, 0.44, 0.19));
  grd.addColorStop(0.55, css(hue, 0.47, 0.28));
  grd.addColorStop(1, css(hue + 12, 0.50, 0.36));
  g.fillStyle = grd;
  g.fill();

  // Lateral veins, at the ~62° a banana-family leaf actually runs.
  g.lineWidth = 0.0042;
  for (let i = 0; i < 34; i++) {
    const t = 0.03 + 0.94 * (i / 34);
    for (const side of [-1, 1]) {
      g.strokeStyle = css(hue + 10, 0.36, 0.42 + rnd() * 0.10, 0.65);
      g.beginPath();
      g.moveTo(0.5 + side * 0.006, t);
      g.lineTo(0.5 + side * hw(t) * 1.02, t + hw(t) * 0.52);
      g.stroke();
    }
  }

  // Midrib.
  g.fillStyle = css(hue + 18, 0.30, 0.52);
  g.beginPath();
  g.moveTo(0.5 - 0.016, 0.0);
  g.lineTo(0.5 + 0.016, 0.0);
  g.lineTo(0.5 + 0.003, 1.0);
  g.lineTo(0.5 - 0.003, 1.0);
  g.closePath();
  g.fill();

  // Wind tears, cut back toward the midrib. Without these it reads as plastic.
  g.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 13; i++) {
    const t = 0.10 + rnd() * 0.82;
    const side = rnd() < 0.5 ? -1 : 1;
    const depth = 0.35 + rnd() * 0.60;
    const w = hw(t);
    g.beginPath();
    g.moveTo(0.5 + side * w * 1.05, t - 0.012);
    g.lineTo(0.5 + side * w * (1 - depth), t + 0.004);
    g.lineTo(0.5 + side * w * 1.05, t + 0.020);
    g.closePath();
    g.fill();
  }
  g.globalCompositeOperation = "source-over";
}

/** A cluster of small leaves on twigs — the only card texture in the module. */
function paintBroadleaf(g: G2, rnd: Rnd): void {
  g.strokeStyle = css(32, 0.28, 0.22);
  for (let i = 0; i < 6; i++) {
    g.lineWidth = 0.008 - i * 0.0008;
    g.beginPath();
    g.moveTo(0.5, 0.02);
    g.quadraticCurveTo(0.5 + (rnd() - 0.5) * 0.5, 0.45, 0.1 + rnd() * 0.8, 0.55 + rnd() * 0.42);
    g.stroke();
  }
  const n = 42;
  for (let i = 0; i < n; i++) {
    // Radial bias keeps the silhouette ragged instead of a filled disc.
    const a = rnd() * TAU;
    const r = 0.20 + Math.pow(rnd(), 0.62) * 0.30;
    const cx = 0.5 + Math.cos(a) * r * 1.02;
    const cy = 0.52 + Math.sin(a) * r * 0.92;
    if (cx < -0.05 || cx > 1.05) continue;
    const dir = a + (rnd() - 0.5) * 1.5;
    const len = 0.11 + rnd() * 0.13;
    const hue = 88 + rnd() * 36;
    const sat = 0.34 + rnd() * 0.30;
    const lum = 0.16 + rnd() * 0.26;
    const bx = cx - Math.cos(dir) * len * 0.5, by = cy - Math.sin(dir) * len * 0.5;
    const tx = cx + Math.cos(dir) * len * 0.5, ty = cy + Math.sin(dir) * len * 0.5;
    g.fillStyle = css(hue, sat, lum);
    leafPath(g, bx, by, tx, ty, len * 0.30, 0.48);
    g.fill();
    g.strokeStyle = css(hue + 8, sat * 0.6, lum + 0.16, 0.7);
    g.lineWidth = 0.0028;
    g.beginPath(); g.moveTo(bx, by); g.lineTo(tx, ty); g.stroke();
  }
}

/** A bipinnate fern frond: a rachis of pinnae, each pinna a comb of lobes. */
function paintFern(g: G2, rnd: Rnd): void {
  const hw = (t: number) => 0.44 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.92 + 0.08)), 0.70);
  g.strokeStyle = css(72, 0.42, 0.30);
  g.lineWidth = 0.010;
  g.beginPath(); g.moveTo(0.5, 0.0); g.lineTo(0.5, 0.99); g.stroke();

  const n = 26;
  for (let i = 0; i < n; i++) {
    for (const side of [-1, 1]) {
      const t = 0.04 + 0.93 * ((i + (side > 0 ? 0.45 : 0)) / n);
      const len = hw(t) * (0.9 + rnd() * 0.2);
      const ang = lerp(1.05, 0.55, t);
      const ex = 0.5 + side * len * Math.sin(ang);
      const ey = t + len * Math.cos(ang) - len * 0.16;
      const hue = 74 + rnd() * 26;
      const lum = 0.20 + 0.16 * t + rnd() * 0.12;
      g.strokeStyle = css(hue, 0.44, lum);
      g.lineWidth = 0.0035;
      g.beginPath(); g.moveTo(0.5, t); g.lineTo(ex, ey); g.stroke();
      // Lobes down each pinna.
      const lobes = 8;
      for (let k = 1; k <= lobes; k++) {
        const u = k / lobes;
        const px = lerp(0.5, ex, u), py = lerp(t, ey, u);
        const lw = (1 - u * 0.75) * len * 0.20;
        g.fillStyle = css(hue + 4, 0.46, lum + 0.05 * (1 - u));
        for (const s2 of [-1, 1]) {
          leafPath(g, px, py, px + s2 * lw * 1.5, py + lw * 1.1, lw * 0.42, 0.5);
          g.fill();
        }
      }
    }
  }
}

/* ---- row 2 and 3: the small stuff --------------------------------------- */

function paintGrass(g: G2, rnd: Rnd): void {
  for (let i = 0; i < 46; i++) {
    const bx = 0.5 + (rnd() - 0.5) * 0.42;
    const lean = (rnd() - 0.5) * 0.95;
    const h = 0.42 + Math.pow(rnd(), 0.6) * 0.56;
    const tx = bx + lean * h;
    const w = 0.011 + rnd() * 0.008;
    const hue = 62 + rnd() * 44;
    const sat = 0.30 + rnd() * 0.30;
    const lum = 0.20 + rnd() * 0.22;
    const grd = g.createLinearGradient(bx, 0, tx, h);
    grd.addColorStop(0, css(hue - 12, sat, lum * 0.8));
    grd.addColorStop(1, css(hue + 16, sat * 0.85, lum + 0.20));
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(bx - w, 0);
    g.quadraticCurveTo(bx + lean * h * 0.35 + w * 0.6, h * 0.6, tx, h);
    g.quadraticCurveTo(bx + lean * h * 0.35 - w * 0.6, h * 0.6, bx + w, 0);
    g.closePath();
    g.fill();
  }
}

/** One agave blade: glaucous, keeled, toothed margin, hard terminal spine. */
function paintAgave(g: G2, rnd: Rnd): void {
  const hue = 128 + rnd() * 34;
  const hw = (t: number) => 0.26 * Math.pow(1 - Math.pow(t, 1.7), 0.55);
  g.beginPath();
  g.moveTo(0.5, 0.0);
  for (let i = 0; i <= 30; i++) { const t = i / 30; g.lineTo(0.5 - hw(t), t); }
  g.lineTo(0.5, 0.995);
  for (let i = 30; i >= 0; i--) { const t = i / 30; g.lineTo(0.5 + hw(t), t); }
  g.closePath();
  const grd = g.createLinearGradient(0.24, 0, 0.76, 0);
  grd.addColorStop(0, css(hue - 8, 0.20, 0.34));
  grd.addColorStop(0.5, css(hue, 0.24, 0.52));
  grd.addColorStop(1, css(hue - 8, 0.20, 0.34));
  g.fillStyle = grd;
  g.fill();

  // Bud imprints — the faint pale arcs a rosette leaves on its neighbours.
  g.strokeStyle = css(hue + 6, 0.16, 0.66, 0.30);
  g.lineWidth = 0.006;
  for (let i = 0; i < 7; i++) {
    const t = 0.10 + i * 0.11;
    g.beginPath();
    g.moveTo(0.5 - hw(t) * 0.85, t);
    g.quadraticCurveTo(0.5, t + 0.035, 0.5 + hw(t) * 0.85, t);
    g.stroke();
  }
  // Marginal teeth and terminal spine.
  g.fillStyle = css(18, 0.44, 0.24);
  for (let i = 0; i < 22; i++) {
    const t = 0.06 + (i / 22) * 0.88;
    for (const side of [-1, 1]) {
      const w = hw(t);
      g.beginPath();
      g.moveTo(0.5 + side * w, t - 0.012);
      g.lineTo(0.5 + side * (w + 0.028), t + 0.006);
      g.lineTo(0.5 + side * w, t + 0.014);
      g.closePath();
      g.fill();
    }
  }
  g.beginPath();
  g.moveTo(0.5 - 0.016, 0.93); g.lineTo(0.5 + 0.016, 0.93); g.lineTo(0.5, 1.0);
  g.closePath(); g.fill();
}

/** Bougainvillea: papery bracts in magenta / coral / cream, with a few leaves. */
function paintBloom(g: G2, rnd: Rnd): void {
  for (let i = 0; i < 16; i++) {
    const a = rnd() * TAU, r = 0.18 + rnd() * 0.28;
    const cx = 0.5 + Math.cos(a) * r, cy = 0.5 + Math.sin(a) * r * 0.95;
    g.fillStyle = css(104 + rnd() * 24, 0.42, 0.16 + rnd() * 0.12);
    leafPath(g, cx, cy, cx + (rnd() - 0.5) * 0.18, cy + (rnd() - 0.5) * 0.18, 0.030, 0.5);
    g.fill();
  }
  for (let cluster = 0; cluster < 9; cluster++) {
    const a = rnd() * TAU, r = Math.pow(rnd(), 0.55) * 0.40;
    const cx = 0.5 + Math.cos(a) * r, cy = 0.5 + Math.sin(a) * r * 0.95;
    const hue = rnd() < 0.68 ? 322 + rnd() * 22 : rnd() < 0.6 ? 358 + rnd() * 12 : 38;
    const sat = hue === 38 ? 0.30 : 0.62 + rnd() * 0.26;
    for (let k = 0; k < 3; k++) {
      const ang = k * (TAU / 3) + rnd() * 0.6;
      const len = 0.075 + rnd() * 0.045;
      const tx = cx + Math.cos(ang) * len, ty = cy + Math.sin(ang) * len;
      g.fillStyle = css(hue, sat, 0.44 + rnd() * 0.22);
      leafPath(g, cx, cy, tx, ty, len * 0.62, 0.5);
      g.fill();
      g.strokeStyle = css(hue, sat * 0.7, 0.30, 0.55);
      g.lineWidth = 0.0026;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(tx, ty); g.stroke();
    }
    g.fillStyle = css(52, 0.30, 0.86);
    g.beginPath(); g.arc(cx, cy, 0.010, 0, TAU); g.fill();
  }
}

/** Sea grape: round leathery leaves with red radial veins. */
function paintSeagrape(g: G2, rnd: Rnd): void {
  g.strokeStyle = css(30, 0.30, 0.26);
  g.lineWidth = 0.010;
  for (let i = 0; i < 5; i++) {
    g.beginPath(); g.moveTo(0.5, 0.02);
    g.quadraticCurveTo(0.5 + (rnd() - 0.5) * 0.4, 0.4, 0.15 + rnd() * 0.7, 0.5 + rnd() * 0.45);
    g.stroke();
  }
  for (let i = 0; i < 11; i++) {
    const a = rnd() * TAU, rr = Math.pow(rnd(), 0.6) * 0.33;
    const cx = 0.5 + Math.cos(a) * rr, cy = 0.52 + Math.sin(a) * rr;
    const r = 0.11 + rnd() * 0.075;
    const red = rnd() < 0.22;
    const hue = red ? 22 + rnd() * 16 : 74 + rnd() * 26;
    const sat = red ? 0.42 : 0.32 + rnd() * 0.18;
    const lum = 0.20 + rnd() * 0.20;
    g.fillStyle = css(hue, sat, lum);
    g.beginPath();
    // Round with a heart-shaped notch at the petiole.
    for (let k = 0; k <= 24; k++) {
      const th = (k / 24) * TAU;
      const notch = 1 - 0.34 * Math.exp(-Math.pow((th - Math.PI * 1.5) * 1.9, 2));
      const px = cx + Math.cos(th) * r * notch * 1.06;
      const py = cy + Math.sin(th) * r * notch;
      if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath(); g.fill();
    g.strokeStyle = css(8, 0.52, 0.42, 0.6);
    g.lineWidth = 0.0032;
    for (let k = 0; k < 7; k++) {
      const th = Math.PI * 0.35 + (k / 6) * Math.PI * 1.3;
      g.beginPath();
      g.moveTo(cx, cy - r * 0.55);
      g.lineTo(cx + Math.cos(th) * r * 0.92, cy + Math.sin(th) * r * 0.92);
      g.stroke();
    }
  }
}

/** Monterey-cypress spray: lacy forked sprigs of scale leaves. */
function paintCypress(g: G2, rnd: Rnd): void {
  const sprig = (x: number, y: number, ang: number, len: number, depth: number, hue: number) => {
    const ex = x + Math.cos(ang) * len, ey = y + Math.sin(ang) * len;
    g.strokeStyle = css(hue, 0.30, 0.16 + depth * 0.06);
    g.lineWidth = 0.004 * (depth + 1);
    g.beginPath(); g.moveTo(x, y); g.lineTo(ex, ey); g.stroke();
    if (depth <= 0) {
      g.fillStyle = css(hue + 6, 0.32, 0.20 + rnd() * 0.14);
      for (let k = 1; k <= 5; k++) {
        const u = k / 5;
        const px = lerp(x, ex, u), py = lerp(y, ey, u);
        g.beginPath(); g.arc(px, py, len * 0.15, 0, TAU); g.fill();
      }
      return;
    }
    const n = 4 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const u = 0.25 + (i / n) * 0.75;
      const px = lerp(x, ex, u), py = lerp(y, ey, u);
      sprig(px, py, ang + (i % 2 ? 1 : -1) * (0.5 + rnd() * 0.4), len * (0.42 + rnd() * 0.2), depth - 1, hue);
    }
  };
  for (let i = 0; i < 7; i++) {
    sprig(0.5 + (rnd() - 0.5) * 0.3, 0.03 + rnd() * 0.1,
      Math.PI * 0.5 + (rnd() - 0.5) * 1.5, 0.30 + rnd() * 0.18, 2, 146 + rnd() * 26);
  }
}

/** Eucalyptus: pendulous blue-green sickles. */
function paintEucLeaf(g: G2, rnd: Rnd): void {
  g.strokeStyle = css(28, 0.16, 0.44);
  g.lineWidth = 0.0055;
  for (let i = 0; i < 5; i++) {
    g.beginPath(); g.moveTo(0.2 + rnd() * 0.6, 1.0);
    g.quadraticCurveTo(0.5, 0.55, 0.15 + rnd() * 0.7, 0.05 + rnd() * 0.25);
    g.stroke();
  }
  for (let i = 0; i < 30; i++) {
    const cx = 0.08 + rnd() * 0.84;
    const cy = 0.10 + rnd() * 0.82;
    const dir = -Math.PI * 0.5 + (rnd() - 0.5) * 1.5;   // hanging
    const len = 0.16 + rnd() * 0.18;
    const hue = 88 + rnd() * 42;
    const sat = 0.12 + rnd() * 0.16;
    const lum = 0.30 + rnd() * 0.24;
    const tx = cx + Math.cos(dir) * len, ty = cy + Math.sin(dir) * len;
    // Sickle: an asymmetric bulge gives the crescent.
    g.fillStyle = css(hue, sat, lum);
    const dx = tx - cx, dy = ty - cy, L = Math.hypot(dx, dy) || 1e-4;
    const px = -dy / L, py = dx / L, w = len * 0.17;
    g.beginPath();
    g.moveTo(cx, cy);
    g.quadraticCurveTo(cx + dx * 0.45 + px * w * 1.9, cy + dy * 0.45 + py * w * 1.9, tx, ty);
    g.quadraticCurveTo(cx + dx * 0.55 - px * w * 0.5, cy + dy * 0.55 - py * w * 0.5, cx, cy);
    g.closePath(); g.fill();
    g.strokeStyle = css(hue, sat * 0.6, lum + 0.14, 0.6);
    g.lineWidth = 0.0025;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(tx, ty); g.stroke();
  }
}

/** Hanging jungle vine — mostly transparent, which is the point. */
function paintVine(g: G2, rnd: Rnd): void {
  for (let s = 0; s < 5; s++) {
    const x0 = 0.12 + s * 0.19 + (rnd() - 0.5) * 0.06;
    const sway = (rnd() - 0.5) * 0.22;
    const bottom = rnd() * 0.30;
    g.strokeStyle = css(48, 0.28, 0.22);
    g.lineWidth = 0.008;
    g.beginPath();
    g.moveTo(x0, 1.0);
    g.quadraticCurveTo(x0 + sway, 0.5, x0 + sway * 0.4, bottom);
    g.stroke();
    for (let k = 0; k < 15; k++) {
      const t = bottom + (1 - bottom) * (k / 15);
      const u = 1 - (t - bottom) / (1 - bottom);
      const x = x0 + sway * (1 - u) * 0.4 + sway * u * 0.0;
      const side = k % 2 ? 1 : -1;
      const len = 0.055 + rnd() * 0.045;
      const hue = 94 + rnd() * 28;
      g.fillStyle = css(hue, 0.40, 0.18 + rnd() * 0.18);
      leafPath(g, x, t, x + side * len, t - len * 0.55, len * 0.42, 0.5);
      g.fill();
    }
  }
}

/* ---- row 1: the barks, written rather than painted ----------------------- */

type BarkFn = (u: number, v: number, out: Float32Array) => void;

/** Coconut palm: stacked frond scars, vertical fibre, weathered grey-brown. */
const barkPalm: BarkFn = (u, v, out) => {
  const band = v * 17 + (fbmA(u, v, 4, 2, 3, 411) - 0.5) * 0.9;
  const frac = band - Math.floor(band);
  const ridge = smoothstep(0, 0.30, frac) * smoothstep(1, 0.66, frac);
  const fibre = fbmA(u, v, 26, 4, 3, 77);
  const lichen = 1 - worleyT(u, v, 6, 913);
  const h = ridge * 0.62 + fibre * 0.26 + lichen * 0.12;
  out[0] = 0.30 + h * 0.30 + fibre * 0.06;
  out[1] = 0.27 + h * 0.27 + fibre * 0.05;
  out[2] = 0.21 + h * 0.20 + fibre * 0.04;
  // Grey-green lichen in the scar shadows.
  out[0] -= lichen * 0.05; out[1] += lichen * 0.03; out[2] -= lichen * 0.02;
  out[3] = 1;
  out[4] = h;
};

/** Tropical hardwood: deep vertical fissures, moss in the grooves. */
const barkWood: BarkFn = (u, v, out) => {
  const fis = ridgedA(u, v, 9, 3, 4, 733);
  const grain = fbmA(u, v, 40, 6, 3, 208);
  const moss = smoothstep(0.55, 0.95, fbmA(u, v, 5, 3, 3, 5501)) * (1 - fis);
  const h = fis * 0.72 + grain * 0.28;
  out[0] = 0.16 + h * 0.30 + grain * 0.05;
  out[1] = 0.13 + h * 0.25 + grain * 0.04;
  out[2] = 0.10 + h * 0.19 + grain * 0.03;
  out[0] -= moss * 0.05; out[1] += moss * 0.10; out[2] -= moss * 0.02;
  out[3] = 1;
  out[4] = h;
};

/** Eucalyptus: smooth, and peeling in flakes of cream, olive and rose. */
const barkEuc: BarkFn = (u, v, out) => {
  const cellId = worleyId(u, v, 5, 2207);
  const edge = worleyT(u, v, 5, 2207);
  const flake = smoothstep(0.05, 0.22, edge);
  const grain = fbmA(u, v, 30, 8, 3, 66);
  // Three flake palettes, picked by cell id: cream, olive-grey, rose.
  const k = cellId * 3;
  let r: number, gg: number, b: number;
  if (k < 1) { r = 0.80; gg = 0.75; b = 0.64; }
  else if (k < 2) { r = 0.58; gg = 0.58; b = 0.48; }
  else { r = 0.74; gg = 0.60; b = 0.55; }
  const t = 0.72 + grain * 0.38;
  out[0] = r * t * (0.72 + flake * 0.34);
  out[1] = gg * t * (0.72 + flake * 0.34);
  out[2] = b * t * (0.72 + flake * 0.34);
  out[3] = 1;
  out[4] = flake * 0.7 + grain * 0.3;
};

/** Fibrous: fine twisted striations. Tree ferns and cypress trunks. */
const barkFibre: BarkFn = (u, v, out) => {
  const twist = u + v * 0.22;
  const stri = fbmA(twist, v, 44, 5, 4, 1409);
  const knots = 1 - worleyT(u, v, 9, 3301);
  const h = stri * 0.72 + knots * 0.28;
  out[0] = 0.22 + h * 0.30;
  out[1] = 0.18 + h * 0.24;
  out[2] = 0.14 + h * 0.18;
  out[3] = 1;
  out[4] = h;
};

const BARK_FN: Record<number, BarkFn> = {
  [C_BARK_PALM]: barkPalm,
  [C_BARK_WOOD]: barkWood,
  [C_BARK_EUC]: barkEuc,
  [C_BARK_FIBRE]: barkFibre,
};

interface VegAtlas {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  rough: THREE.Texture;
  dispose(): void;
}

function finish(tex: THREE.DataTexture, srgb: boolean, aniso: number): THREE.DataTexture {
  // Clamp, not repeat: this is an atlas, and a wrapped tap would fetch a
  // neighbouring species.
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Paint, write, dilate, differentiate. Returns albedo (RGB + cutout alpha),
 * a tangent-space normal map and a roughness map, all sharing one UV layout.
 *
 * The dilation pass is not optional. Transparent canvas texels are (0,0,0,0);
 * mip them and every leaf grows a black fringe that shows up the moment the
 * plant is more than thirty metres away. Flooding leaf colour outward into the
 * margin makes the fringe the leaf's own colour instead, which is invisible.
 */
function buildAtlas(size: number, aniso: number, rng: () => number): VegAtlas {
  const px = new Uint8ClampedArray(size * size * 4);
  const cs = size >> 2;

  // ---- 1. paint the organic cells ----------------------------------------
  let painted = false;
  try {
    if (typeof document !== "undefined" && document.createElement) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const g = canvas.getContext("2d");
      if (g) {
        g.clearRect(0, 0, size, size);
        paintCell(g, size, C_FROND, (c) => paintFrond(c, rng, false));
        paintCell(g, size, C_DRY, (c) => paintFrond(c, rng, true));
        paintCell(g, size, C_PADDLE, (c) => paintPaddle(c, rng));
        paintCell(g, size, C_BROAD, (c) => paintBroadleaf(c, rng));
        paintCell(g, size, C_FERNL, (c) => paintFern(c, rng));
        paintCell(g, size, C_GRASS, (c) => paintGrass(c, rng));
        paintCell(g, size, C_AGAVE, (c) => paintAgave(c, rng));
        paintCell(g, size, C_BLOOM, (c) => paintBloom(c, rng));
        paintCell(g, size, C_SEAGRAPE, (c) => paintSeagrape(c, rng));
        paintCell(g, size, C_CYPRESS, (c) => paintCypress(c, rng));
        paintCell(g, size, C_EUCLEAF, (c) => paintEucLeaf(c, rng));
        paintCell(g, size, C_VINE, (c) => paintVine(c, rng));
        px.set(g.getImageData(0, 0, size, size).data);
        painted = true;
      }
    }
  } catch {
    /* headless, tainted or no 2D context — fall through to the flat fallback */
  }
  if (!painted) {
    // Never throw during boot. A flat green cutout is ugly but it is a world.
    for (let c = 0; c < 16; c++) {
      if (BARK_CELLS.indexOf(c) >= 0) continue;
      const col = c & 3, row = c >> 2;
      for (let y = 0; y < cs; y++) {
        for (let x = 0; x < cs; x++) {
          const o = ((row * cs + y) * size + col * cs + x) * 4;
          const r = Math.hypot(x / cs - 0.5, y / cs - 0.5);
          px[o] = 60; px[o + 1] = 96; px[o + 2] = 40; px[o + 3] = r < 0.42 ? 255 : 0;
        }
      }
    }
  }

  // ---- 2. relief field, and the barks written straight into the buffer ----
  const hgt = new Float32Array(size * size);
  const out = new Float32Array(5);
  for (let c = 0; c < 16; c++) {
    const col = c & 3, row = c >> 2;
    const bark = BARK_FN[c];
    for (let y = 0; y < cs; y++) {
      for (let x = 0; x < cs; x++) {
        const i = (row * cs + y) * size + col * cs + x;
        const o = i * 4;
        if (bark) {
          // v runs up the trunk; the buffer's y runs down, so flip it to match
          // `cellUV` and keep the frond scars the right way up.
          bark((x + 0.5) / cs, 1 - (y + 0.5) / cs, out);
          px[o] = out[0] * 255;
          px[o + 1] = out[1] * 255;
          px[o + 2] = out[2] * 255;
          px[o + 3] = 255;
          hgt[i] = out[4];
        } else {
          const a = px[o + 3] / 255;
          hgt[i] = a * (px[o] * 0.0011 + px[o + 1] * 0.0022 + px[o + 2] * 0.0004);
        }
      }
    }
  }

  // ---- 3. dilate RGB outward inside each cell -----------------------------
  {
    const filled = new Uint8Array(size * size);
    for (let i = 0; i < size * size; i++) filled[i] = px[i * 4 + 3] > 12 ? 1 : 0;
    const passes = Math.max(3, Math.round(cs / 40));
    for (let p = 0; p < passes; p++) {
      const next = filled.slice();
      for (let c = 0; c < 16; c++) {
        const col = c & 3, row = c >> 2;
        if (BARK_FN[c]) continue;
        for (let y = 0; y < cs; y++) {
          for (let x = 0; x < cs; x++) {
            const i = (row * cs + y) * size + col * cs + x;
            if (filled[i]) continue;
            let r = 0, g2 = 0, b = 0, n = 0;
            for (let dy = -1; dy <= 1; dy++) {
              const ny = y + dy;
              if (ny < 0 || ny >= cs) continue;
              for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;
                if (nx < 0 || nx >= cs || (dx === 0 && dy === 0)) continue;
                const j = (row * cs + ny) * size + col * cs + nx;
                if (!filled[j]) continue;
                r += px[j * 4]; g2 += px[j * 4 + 1]; b += px[j * 4 + 2]; n++;
              }
            }
            if (!n) continue;
            px[i * 4] = r / n; px[i * 4 + 1] = g2 / n; px[i * 4 + 2] = b / n;
            next[i] = 1;
          }
        }
      }
      filled.set(next);
    }
  }

  // ---- 4. normal + roughness ---------------------------------------------
  const nrm = new Uint8Array(size * size * 4);
  const rgh = new Uint8Array(size * size * 4);
  for (let c = 0; c < 16; c++) {
    const col = c & 3, row = c >> 2;
    const strength = CELL_RELIEF[c] * cs * 0.055;
    const rough0 = CELL_ROUGH[c];
    for (let y = 0; y < cs; y++) {
      // Sobel wraps inside the cell, never across it.
      const yp = (y + 1) % cs, yn = (y + cs - 1) % cs;
      for (let x = 0; x < cs; x++) {
        const xp = (x + 1) % cs, xn = (x + cs - 1) % cs;
        const at = (xx: number, yy: number) => hgt[(row * cs + yy) * size + col * cs + xx];
        const i = (row * cs + y) * size + col * cs + x;
        const dx = (at(xp, y) - at(xn, y)) * strength;
        // The buffer's y runs down while tangent-space green runs up.
        const dy = (at(x, yn) - at(x, yp)) * strength;
        let nx = -dx, ny = -dy, nz = 1;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx /= len; ny /= len; nz /= len;
        nrm[i * 4] = (nx * 0.5 + 0.5) * 255;
        nrm[i * 4 + 1] = (ny * 0.5 + 0.5) * 255;
        nrm[i * 4 + 2] = (nz * 0.5 + 0.5) * 255;
        nrm[i * 4 + 3] = 255;
        // Proud surfaces are polished by weather; recesses hold dust.
        const r = clamp01(rough0 * (1.06 - hgt[i] * 0.30));
        rgh[i * 4] = 255; rgh[i * 4 + 1] = r * 255; rgh[i * 4 + 2] = 0; rgh[i * 4 + 3] = 255;
      }
    }
  }

  const albedo = finish(new THREE.DataTexture(new Uint8Array(px.buffer.slice(0)), size, size, THREE.RGBAFormat), true, aniso);
  const normal = finish(new THREE.DataTexture(nrm, size, size, THREE.RGBAFormat), false, aniso);
  const rough = finish(new THREE.DataTexture(rgh, size, size, THREE.RGBAFormat), false, aniso);

  return {
    albedo, normal, rough,
    dispose() { albedo.dispose(); normal.dispose(); rough.dispose(); },
  };
}

/* ------------------------------------------------------------------------ *
 * Geometry builder
 * ------------------------------------------------------------------------ */
//
// Every plant is assembled in "plant space": y = 0 is the ground, +Y is up, and
// species that lean (beach palms, wind-shaped cypress) lean along +X so the
// scatterer can simply yaw them to face the sea or the prevailing wind.
//
// Alongside position/normal/uv each vertex carries:
//   color  — baked occlusion, dark inside a crown and at ground contact;
//   aFlex  — (trunk sway weight, leaf flutter weight, translucency).
// aFlex is what makes the wind read as a plant bending rather than a rigid
// object rocking: sway ramps quadratically up the trunk, flutter ramps along
// each individual frond, and bark gets neither.

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

class Build {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  flx: number[] = [];
  idx: number[] = [];

  vert(
    m: THREE.Matrix4 | null,
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
    ao: number, sway: number, flut: number, trans: number,
  ): number {
    _p.set(x, y, z);
    _n.set(nx, ny, nz);
    if (m) { _p.applyMatrix4(m); _n.transformDirection(m); }
    const i = this.pos.length / 3;
    this.pos.push(_p.x, _p.y, _p.z);
    this.nrm.push(_n.x, _n.y, _n.z);
    this.uv.push(u, v);
    this.col.push(ao, ao, ao);
    this.flx.push(sway, flut, trans);
    return i;
  }

  /** Same, but the normal is supplied already in plant space. */
  vertN(
    m: THREE.Matrix4 | null,
    x: number, y: number, z: number,
    n: THREE.Vector3,
    u: number, v: number,
    ao: number, sway: number, flut: number, trans: number,
  ): number {
    _p.set(x, y, z);
    if (m) _p.applyMatrix4(m);
    const i = this.pos.length / 3;
    this.pos.push(_p.x, _p.y, _p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(ao, ao, ao);
    this.flx.push(sway, flut, trans);
    return i;
  }

  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number): void { this.idx.push(a, b, c, a, c, d); }

  get tris(): number { return this.idx.length / 3; }

  geometry(name: string): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("aFlex", new THREE.Float32BufferAttribute(this.flx, 3));
    g.setIndex(this.pos.length / 3 > 65535
      ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.name = name;
    return g;
  }
}

/* ---- leaves --------------------------------------------------------------*/

interface FrondSpec {
  length: number;
  /** Half-width at the widest point. */
  width: number;
  /** Initial rise, as a fraction of length. */
  lift: number;
  /** Cubic droop toward the tip, as a fraction of length. */
  droop: number;
  /** Lateral sweep — a frond that curves sideways as well as down. */
  curve: number;
  /** Depth of the V fold, as a fraction of half-width. This is what stops a
   *  frond disappearing when it is seen edge-on. */
  keel: number;
  /** Radians of twist from base to tip. */
  twist: number;
  segs: number;
  cell: number;
  /** Wide base tapering to a point (agave, grass) instead of a leaf profile. */
  bladed?: boolean;
  /** Fullness exponent on the width profile. Lower = broader paddle. */
  taper?: number;
  sway: number;
  flutter: number;
  trans: number;
  ao0: number;
  ao1: number;
}

const _t = new THREE.Vector3();
const _s = new THREE.Vector3();
const _u = new THREE.Vector3();
const _q = new THREE.Vector3();

/**
 * One frond: a swept, tapered, twisted, V-keeled strip. Three vertices per
 * cross-section (left tip, rachis, right tip) — the middle one riding proud —
 * so the strip has a real cross-section from every angle, and edge normals
 * that splay outward the way a folded leaf's do.
 */
function frond(b: Build, m: THREE.Matrix4, o: FrondSpec): void {
  const L = o.length, W = o.width, segs = o.segs;
  const uvr = cellUV(o.cell);
  const taper = o.taper ?? 0.60;
  const halfW = (t: number) =>
    o.bladed
      ? W * Math.pow(Math.max(0, 1 - Math.pow(t, 1.7)), 0.55)
      : W * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.94 + 0.06)), taper);

  const rows: number[][] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // Rachis: rise, cubic droop, and a lateral sweep that grows quadratically.
    const px = L * t;
    const py = L * (o.lift * t - o.droop * t * t * t);
    const pz = L * o.curve * t * t;
    // Analytic tangent — no finite differences, so the frame never jitters.
    _t.set(L, L * (o.lift - 3 * o.droop * t * t), 2 * L * o.curve * t).normalize();
    _s.set(0, 1, 0).cross(_t).normalize();
    if (_s.lengthSq() < 1e-6) _s.set(0, 0, -1);
    _u.copy(_t).cross(_s).normalize();
    const tw = o.twist * t;
    if (tw !== 0) {
      // Rotate the section frame about its own tangent.
      const cs2 = Math.cos(tw), sn = Math.sin(tw);
      const sx = _s.x * cs2 + _u.x * sn, sy = _s.y * cs2 + _u.y * sn, sz = _s.z * cs2 + _u.z * sn;
      const ux = _u.x * cs2 - _s.x * sn, uy = _u.y * cs2 - _s.y * sn, uz = _u.z * cs2 - _s.z * sn;
      _s.set(sx, sy, sz); _u.set(ux, uy, uz);
    }
    const w = halfW(t);
    const drop = w * o.keel;
    const ao = lerp(o.ao0, o.ao1, t);
    const flut = o.flutter * Math.pow(t, 1.5);
    const v = uvr.v0 + t * uvr.dv;

    // Edge normals lean outward by the keel angle; the rachis normal is the
    // section's own up.
    _q.copy(_u).addScaledVector(_s, o.keel).normalize();
    const nl = _q.clone();
    _q.copy(_u).addScaledVector(_s, -o.keel).normalize();
    const nr = _q.clone();

    const cx = px + _u.x * drop * 0.35, cy = py + _u.y * drop * 0.35, cz = pz + _u.z * drop * 0.35;
    const l = b.vertN(m,
      px - _s.x * w - _u.x * drop, py - _s.y * w - _u.y * drop, pz - _s.z * w - _u.z * drop,
      _n.copy(nl).transformDirection(m), uvr.u0, v, ao * 0.94, o.sway, flut, o.trans);
    const c = b.vertN(m, cx, cy, cz,
      _n.copy(_u).transformDirection(m), uvr.u0 + uvr.du * 0.5, v, ao, o.sway, flut * 0.7, o.trans * 0.8);
    const r = b.vertN(m,
      px + _s.x * w - _u.x * drop, py + _s.y * w - _u.y * drop, pz + _s.z * w - _u.z * drop,
      _n.copy(nr).transformDirection(m), uvr.u0 + uvr.du, v, ao * 0.94, o.sway, flut, o.trans);
    rows.push([l, c, r]);
  }
  for (let i = 0; i < segs; i++) {
    const a = rows[i], d = rows[i + 1];
    b.quad(a[0], a[1], d[1], d[0]);
    b.quad(a[1], a[2], d[2], d[1]);
  }
}

/* ---- cards ---------------------------------------------------------------*/

interface CardSpec {
  w: number;
  h: number;
  /** Bow out of plane, metres. A flat quad is the amateur tell; this is not. */
  bow: number;
  cell: number;
  /** Blend the face normal toward (vertex - center) by `blend`. */
  center?: THREE.Vector3 | null;
  blend?: number;
  /** Or blend toward a fixed direction (ground cover blends toward world up). */
  toward?: THREE.Vector3 | null;
  segs?: number;
  swayA: number; swayB: number;
  flutA: number; flutB: number;
  trans: number;
  ao0: number; ao1: number;
}

const _fn = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _bl = new THREE.Vector3();

/**
 * A bowed leaf card, centred on the origin of `m`, facing +Z.
 *
 * The normal blend is the whole reason clustered cross-planes can work: shade a
 * card by its own flat normal and it reads as cardboard from every angle, but
 * shade it by the direction out of the canopy's centre and a dozen of them read
 * as one soft volume. 0.7 is about right — enough to round the canopy, not so
 * much that the cards stop catching the light individually.
 */
function card(b: Build, m: THREE.Matrix4, o: CardSpec): void {
  const uvr = cellUV(o.cell);
  const segs = o.segs ?? 2;
  const blend = o.blend ?? 0.7;
  _fn.set(0, 0, 1).transformDirection(m);
  const rows: number[][] = [];
  for (let j = 0; j <= segs; j++) {
    const fy = j / segs;
    const y = (fy - 0.5) * o.h;
    const row: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const fx = i / segs;
      const x = (fx - 0.5) * o.w;
      const ax = fx * 2 - 1, ay = fy * 2 - 1;
      const z = o.bow * (1 - ax * ax) * (1 - ay * ay * 0.55);
      _vp.set(x, y, z).applyMatrix4(m);
      _bl.copy(_fn);
      if (o.center) {
        _q.copy(_vp).sub(o.center);
        if (_q.lengthSq() > 1e-8) _bl.lerp(_q.normalize(), blend).normalize();
      } else if (o.toward) {
        _bl.lerp(o.toward, blend).normalize();
      }
      row.push(b.vertN(null, _vp.x, _vp.y, _vp.z, _bl,
        uvr.u0 + fx * uvr.du, uvr.v0 + fy * uvr.dv,
        lerp(o.ao0, o.ao1, fy),
        lerp(o.swayA, o.swayB, fy), lerp(o.flutA, o.flutB, fy), o.trans));
    }
    rows.push(row);
  }
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      b.quad(rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]);
    }
  }
}

/* ---- trunks --------------------------------------------------------------*/

interface TrunkSpec {
  height: number;
  baseR: number;
  topR: number;
  rings: number;
  radial: number;
  /** Horizontal displacement of the top, metres. Palms lean along +X. */
  bendX: number;
  bendZ: number;
  /** Exponent on the bend. >1 keeps the base plumb and curves near the top. */
  bendPow: number;
  /** Root flare multiplier at the base. */
  flare: number;
  cell: number;
  /** Sway weight at the very top; ramps as t^1.4 below it. */
  sway: number;
  /** Radial lumpiness, as a fraction of radius. */
  lumps: number;
  ao0: number;
  ao1: number;
  /** Wrap the bark texture this many times around the trunk. */
  wrapU?: number;
  /** ...and this many times along it. */
  wrapV?: number;
}

const _c0 = new THREE.Vector3();
const _c1 = new THREE.Vector3();

/**
 * A swept tube. The ring frame is rebuilt from the analytic tangent at every
 * ring, so a palm leaning 30° still has a circular section perpendicular to its
 * own axis instead of the sheared ellipse you get from displacing rings
 * sideways. Returns the frame at the top, for hanging a crown off.
 */
function trunk(b: Build, m: THREE.Matrix4, o: TrunkSpec, rng: () => number): THREE.Matrix4 {
  const uvr = cellUV(o.cell);
  const H = o.height;
  const seed = Math.floor(rng() * 65536);
  const at = (t: number, v: THREE.Vector3) =>
    v.set(o.bendX * Math.pow(t, o.bendPow), H * t, o.bendZ * Math.pow(t, o.bendPow));
  const wrapU = o.wrapU ?? 1;
  const wrapV = o.wrapV ?? 1;

  const rows: number[][] = [];
  for (let i = 0; i <= o.rings; i++) {
    const t = i / o.rings;
    at(t, _c0);
    at(Math.min(1, t + 0.01), _c1);
    if (t > 0.99) { at(t - 0.01, _c1); _t.copy(_c0).sub(_c1).normalize(); }
    else _t.copy(_c1).sub(_c0).normalize();
    _s.set(1, 0, 0).cross(_t);
    if (_s.lengthSq() < 1e-6) _s.set(0, 0, 1).cross(_t);
    _s.normalize();
    _u.copy(_t).cross(_s).normalize();

    const flare = 1 + o.flare * Math.exp(-t * 8.5);
    const r0 = lerp(o.baseR, o.topR, Math.pow(t, 0.8)) * flare;
    const ao = lerp(o.ao0, o.ao1, t);
    const sway = o.sway * Math.pow(t, 1.4);
    const v = uvr.v0 + ((t * wrapV) % 1) * uvr.dv;
    const row: number[] = [];
    for (let j = 0; j <= o.radial; j++) {
      const a = (j / o.radial) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      // Per-ring, per-facet lumpiness: no trunk in nature is a lathe turning.
      const lump = 1 + o.lumps * (hash2(i, j % o.radial, seed) - 0.5) * 2
        + (i === 0 ? 0.22 * Math.max(0, hash2(j % o.radial, 7, seed + 3) - 0.4) : 0);
      const r = r0 * lump;
      const x = _c0.x + _s.x * ca * r + _u.x * sa * r;
      const y = _c0.y + _s.y * ca * r + _u.y * sa * r;
      const z = _c0.z + _s.z * ca * r + _u.z * sa * r;
      _q.set(_s.x * ca + _u.x * sa, _s.y * ca + _u.y * sa, _s.z * ca + _u.z * sa);
      row.push(b.vertN(m, x, y, z, _n.copy(_q).transformDirection(m),
        uvr.u0 + ((j / o.radial) * wrapU % 1.0000001) * uvr.du, v, ao, sway, 0, 0));
    }
    rows.push(row);
  }
  for (let i = 0; i < o.rings; i++) {
    for (let j = 0; j < o.radial; j++) {
      b.quad(rows[i][j], rows[i][j + 1], rows[i + 1][j + 1], rows[i + 1][j]);
    }
  }

  // The frame at the top, in the caller's space.
  at(1, _c0);
  at(0.99, _c1);
  _t.copy(_c0).sub(_c1).normalize();
  _s.set(1, 0, 0).cross(_t);
  if (_s.lengthSq() < 1e-6) _s.set(0, 0, 1).cross(_t);
  _s.normalize();
  _u.copy(_t).cross(_s).normalize();
  const top = new THREE.Matrix4().makeBasis(_s, _t, _u).setPosition(_c0);
  return top.premultiply(m);
}

/** A cheap octahedral blob — coconuts, seed pods, flower-spike buds. */
function blob(b: Build, m: THREE.Matrix4, r: number, cell: number, ao: number): void {
  const uvr = cellUV(cell);
  const u = uvr.u0 + uvr.du * 0.5, v = uvr.v0 + uvr.dv * 0.5;
  const d = uvr.du * 0.06;
  const p: number[] = [];
  const axes: [number, number, number][] = [
    [r, 0, 0], [-r, 0, 0], [0, r * 1.15, 0], [0, -r * 1.15, 0], [0, 0, r], [0, 0, -r],
  ];
  for (let i = 0; i < 6; i++) {
    const a = axes[i];
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    p.push(b.vert(m, a[0], a[1], a[2], a[0] / l, a[1] / l, a[2] / l,
      u + (i & 1 ? d : -d), v + (i & 2 ? d : -d), ao, 0, 0, 0));
  }
  const f = [2, 0, 4, 2, 4, 1, 2, 1, 5, 2, 5, 0, 3, 4, 0, 3, 1, 4, 3, 5, 1, 3, 0, 5];
  for (let i = 0; i < f.length; i += 3) b.tri(p[f[i]], p[f[i + 1]], p[f[i + 2]]);
}

/* ------------------------------------------------------------------------ *
 * Species
 * ------------------------------------------------------------------------ */

const IDENT = new THREE.Matrix4();

interface BuildCtx {
  tier: VegTier;
  /** 0 = full, 1 = mid, 2 = far. Geometry is decimated, never billboarded. */
  lod: number;
  rng: () => number;
}

/** Golden angle — the phyllotaxis that keeps a rosette from looking spoked. */
const GOLD = 2.399963;

const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _dir = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _ay = new THREE.Vector3();

/** Orient a card at `pos` facing `dir`, rolled about its own normal. */
function faceMatrix(out: THREE.Matrix4, pos: THREE.Vector3, dir: THREE.Vector3, roll: number): THREE.Matrix4 {
  _ax.set(0, 1, 0).cross(dir);
  if (_ax.lengthSq() < 1e-6) _ax.set(1, 0, 0);
  _ax.normalize();
  _ay.copy(dir).cross(_ax).normalize();
  out.makeBasis(_ax, _ay, dir).setPosition(pos);
  return out.multiply(_m2.makeRotationZ(roll));
}

/** Scatter `n` cards over an ellipsoid shell, normals blended toward the shell. */
function canopy(
  b: Build, cx: BuildCtx, o: {
    center: THREE.Vector3; rx: number; ry: number; rz: number;
    n: number; cell: number; w: number; h: number; bow: number;
    /** 0 = whole shell, 1 = top hemisphere only. */
    topBias: number;
    rollBias?: number;
    sway: number; flut: number; trans: number; blend: number;
    segs?: number;
  },
): void {
  const rng = cx.rng;
  const pos = new THREE.Vector3();
  for (let i = 0; i < o.n; i++) {
    const u2 = (i + 0.5) / o.n;
    const phi = Math.acos(1 - (2 - o.topBias) * u2);
    const th = i * GOLD + rng() * 0.7;
    _dir.set(Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th)).normalize();
    pos.set(
      o.center.x + _dir.x * o.rx * (0.78 + rng() * 0.30),
      o.center.y + _dir.y * o.ry * (0.78 + rng() * 0.30),
      o.center.z + _dir.z * o.rz * (0.78 + rng() * 0.30),
    );
    const roll = (o.rollBias ?? 0) + (rng() - 0.5) * TAU;
    faceMatrix(_m1, pos, _dir, roll);
    const k = 0.78 + rng() * 0.44;
    card(b, _m1, {
      w: o.w * k, h: o.h * k, bow: o.bow * k, cell: o.cell,
      center: o.center, blend: o.blend, segs: o.segs ?? 2,
      // Lower cards sit deeper in the crown and are correspondingly darker.
      swayA: o.sway * 0.85, swayB: o.sway,
      flutA: o.flut * 0.5, flutB: o.flut,
      trans: o.trans,
      ao0: lerp(0.44, 0.92, clamp01(_dir.y * 0.5 + 0.5)),
      ao1: lerp(0.58, 1.0, clamp01(_dir.y * 0.5 + 0.5)),
    });
  }
}

/** Short tapered limb hung off a trunk at height `t`. */
function branch(
  b: Build, cx: BuildCtx, o: {
    bendX: number; bendPow: number; H: number; t: number;
    az: number; tilt: number; len: number; r0: number; cell: number;
    sway: number; downwind?: number;
  },
): THREE.Matrix4 {
  const rng = cx.rng;
  const y = o.H * o.t;
  const x = o.bendX * Math.pow(o.t, o.bendPow);
  _m1.makeRotationY(o.az).multiply(_m2.makeRotationZ(-o.tilt));
  _m1.setPosition(x, y, 0);
  return trunk(b, _m1, {
    height: o.len, baseR: o.r0, topR: o.r0 * 0.34,
    rings: cx.lod === 0 ? 3 : 2, radial: cx.lod === 0 ? 5 : 4,
    bendX: (o.downwind ?? 0) + o.len * 0.22, bendZ: 0, bendPow: 1.5,
    flare: 0.25, cell: o.cell, sway: o.sway, lumps: 0.12,
    ao0: 0.55, ao1: 0.80, wrapV: 2,
  }, rng);
}

/* ---- palms ---------------------------------------------------------------*/

function buildPalm(b: Build, cx: BuildCtx, variant: number, tall: boolean): void {
  const { rng, tier, lod } = cx;
  const H = (tall ? 16.5 : 9.8) + variant * (tall ? 3.4 : 2.1) + rng() * 1.6;
  const lean = tall ? 0.05 + rng() * 0.06 : 0.14 + rng() * 0.15;
  const top = trunk(b, IDENT, {
    height: H,
    baseR: (tall ? 0.30 : 0.35) * (0.9 + rng() * 0.22),
    topR: tall ? 0.16 : 0.19,
    rings: lod === 0 ? 10 : lod === 1 ? 5 : 2,
    radial: lod === 0 ? tier.radial : lod === 1 ? 5 : 4,
    bendX: lean * H, bendZ: (rng() - 0.5) * 0.09 * H, bendPow: 1.85,
    flare: tall ? 0.55 : 0.9, cell: C_BARK_PALM,
    sway: tall ? 0.62 : 0.50, lumps: 0.055,
    ao0: 0.48, ao1: 0.95, wrapV: tall ? 3 : 2,
  }, rng);

  // Crownshaft: the smooth green sheath a tall palm carries under its fronds.
  if (tall && lod <= 1) {
    _m1.copy(top);
    trunk(b, _m1, {
      height: 1.5, baseR: 0.20, topR: 0.13,
      rings: 2, radial: lod === 0 ? tier.radial : 4,
      bendX: 0, bendZ: 0, bendPow: 1, flare: 0.28, cell: C_BARK_FIBRE,
      sway: 0.68, lumps: 0.03, ao0: 0.72, ao1: 0.92, wrapV: 1,
    }, rng);
  }

  const crown = _m2.copy(top).multiply(new THREE.Matrix4().makeTranslation(0, tall ? 1.25 : -0.25, 0));
  const crownM = crown.clone();
  const n = lod === 0 ? 11 + variant : lod === 1 ? 7 : 4;
  const segs = lod === 0 ? tier.frondSegs : lod === 1 ? 4 : 2;
  for (let i = 0; i < n; i++) {
    // A stride permutation pairs elevation with azimuth so the upright fronds
    // are never neighbours — a palm crown is a spiral, not a fan.
    const k = ((i * 5) % n) / Math.max(1, n - 1);
    const az = (i / n) * TAU + (rng() - 0.5) * 0.42;
    const el = lerp(1.02, -0.52, k) + (rng() - 0.5) * 0.16;
    _m1.copy(crownM)
      .multiply(new THREE.Matrix4().makeRotationY(az))
      .multiply(new THREE.Matrix4().makeRotationZ(el));
    frond(b, _m1, {
      length: H * (tall ? 0.48 : 0.45) * (0.86 + rng() * 0.28),
      width: H * (tall ? 0.070 : 0.078),
      lift: 0.28 + rng() * 0.14,
      droop: 0.34 + k * 0.55 + rng() * 0.12,
      curve: (rng() - 0.5) * 0.26,
      keel: 0.38 + rng() * 0.10,
      twist: (rng() - 0.5) * 1.0,
      segs, cell: C_FROND, taper: 0.60,
      sway: 1.0, flutter: 0.52, trans: 1.0,
      ao0: 0.60, ao1: 1.0,
    });
  }

  if (tier.detail && lod === 0) {
    // Dead fronds still hanging — the "skirt" that reads instantly as a palm.
    for (let i = 0; i < 3; i++) {
      const az = rng() * TAU;
      _m1.copy(crownM)
        .multiply(new THREE.Matrix4().makeRotationY(az))
        .multiply(new THREE.Matrix4().makeRotationZ(-1.15 - rng() * 0.3));
      frond(b, _m1, {
        length: H * 0.30, width: H * 0.052, lift: 0.10, droop: 0.30,
        curve: (rng() - 0.5) * 0.2, keel: 0.30, twist: (rng() - 0.5) * 1.2,
        segs: Math.max(4, segs - 3), cell: C_DRY,
        sway: 1.0, flutter: 0.75, trans: 0.55, ao0: 0.55, ao1: 0.85,
      });
    }
    // Coconuts (or a seed bunch on the tall palm).
    const nb = 5 + Math.floor(rng() * 3);
    for (let i = 0; i < nb; i++) {
      const a = i * GOLD;
      const r = 0.30 + rng() * 0.18;
      _m1.copy(crownM).multiply(new THREE.Matrix4().makeTranslation(
        Math.cos(a) * r, -0.28 - rng() * 0.22, Math.sin(a) * r));
      blob(b, _m1, tall ? 0.10 : 0.155, C_BARK_PALM, 0.68);
    }
  }
}

function buildTraveller(b: Build, cx: BuildCtx, variant: number): void {
  const { rng, tier, lod } = cx;
  const H = 2.4 + variant * 0.7 + rng() * 0.5;
  const top = trunk(b, IDENT, {
    height: H, baseR: 0.38, topR: 0.28,
    rings: lod === 0 ? 5 : 3, radial: lod === 0 ? tier.radial : 4,
    bendX: 0.10 * H, bendZ: 0, bendPow: 1.6, flare: 0.7, cell: C_BARK_FIBRE,
    sway: 0.30, lumps: 0.07, ao0: 0.45, ao1: 0.85, wrapV: 2,
  }, rng);
  const topM = top.clone();
  const n = lod === 0 ? 9 : lod === 1 ? 6 : 4;
  const L = H * 2.0;
  for (let i = 0; i < n; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const k = Math.floor(i / 2) / Math.max(1, Math.ceil(n / 2) - 1);
    // A traveller's palm splays in a single plane — that flat fan is the whole
    // silhouette, so azimuth stays pinned and only elevation spreads.
    const az = (side > 0 ? 0 : Math.PI) + (rng() - 0.5) * 0.24;
    const el = 1.44 - k * 1.10 + (rng() - 0.5) * 0.12;
    _m1.copy(topM)
      .multiply(new THREE.Matrix4().makeRotationY(az))
      .multiply(new THREE.Matrix4().makeRotationZ(el));
    if (lod === 0) {
      // Petiole: the long bare stalk before the blade starts.
      trunk(b, _m2.copy(_m1).multiply(new THREE.Matrix4().makeRotationZ(-Math.PI / 2)), {
        height: L * 0.34, baseR: 0.055, topR: 0.035, rings: 2, radial: 4,
        bendX: 0, bendZ: 0, bendPow: 1, flare: 0.2, cell: C_BARK_FIBRE,
        sway: 0.7, lumps: 0.04, ao0: 0.55, ao1: 0.80, wrapV: 1,
      }, rng);
    }
    _m1.multiply(new THREE.Matrix4().makeTranslation(L * 0.32, 0, 0));
    frond(b, _m1, {
      length: L * 0.68, width: H * 0.40, lift: 0.30, droop: 0.60,
      curve: (rng() - 0.5) * 0.12, keel: 0.28, twist: (rng() - 0.5) * 0.35,
      segs: lod === 0 ? Math.max(5, tier.frondSegs - 2) : lod === 1 ? 4 : 2,
      cell: C_PADDLE, taper: 0.30,
      sway: 0.95, flutter: 0.62, trans: 1.0, ao0: 0.62, ao1: 1.0,
    });
  }
}

/* ---- broadleaf and the hillside trees ------------------------------------*/

function buildBroadleaf(b: Build, cx: BuildCtx, variant: number): void {
  const { rng, tier, lod } = cx;
  const H = 10.5 + variant * 3.2 + rng() * 2.5;
  const bendX = (rng() - 0.5) * 0.11 * H;
  trunk(b, IDENT, {
    height: H * 0.92, baseR: 0.52 + rng() * 0.12, topR: 0.20,
    rings: lod === 0 ? 8 : lod === 1 ? 4 : 2,
    radial: lod === 0 ? tier.radial : lod === 1 ? 5 : 4,
    bendX, bendZ: (rng() - 0.5) * 0.06 * H, bendPow: 1.6,
    flare: 1.25, cell: C_BARK_WOOD, sway: 0.42, lumps: 0.075,
    ao0: 0.40, ao1: 0.88, wrapV: 3,
  }, rng);

  const nb = lod === 0 ? 5 : lod === 1 ? 3 : 0;
  const tips: THREE.Matrix4[] = [];
  for (let i = 0; i < nb; i++) {
    tips.push(branch(b, cx, {
      bendX, bendPow: 1.6, H: H * 0.92, t: 0.56 + (i / Math.max(1, nb)) * 0.36,
      az: i * GOLD + rng() * 0.5, tilt: 0.55 + rng() * 0.45,
      len: H * (0.20 + rng() * 0.14), r0: 0.15, cell: C_BARK_WOOD, sway: 0.62,
    }).clone());
  }

  const center = new THREE.Vector3(bendX * 0.8, H * 1.00, 0);
  canopy(b, cx, {
    center, rx: H * 0.44, ry: H * 0.23, rz: H * 0.44,
    n: lod === 0 ? 15 : lod === 1 ? 7 : 3,
    cell: C_BROAD, w: H * 0.40, h: H * 0.34, bow: H * 0.07,
    topBias: 0.55, sway: 0.80, flut: 0.55, trans: 1.0, blend: 0.72,
    segs: lod === 0 ? 2 : 1,
  });

  if (tier.detail && lod === 0) {
    // Lianas. Two crossed strips each, so they never vanish edge-on.
    for (let i = 0; i < Math.min(4, tips.length); i++) {
      const t = tips[i];
      const p = new THREE.Vector3().setFromMatrixPosition(t);
      for (let k = 0; k < 2; k++) {
        _m1.makeRotationY(rng() * TAU + k * Math.PI * 0.5);
        _m1.setPosition(p.x, p.y - H * 0.16, p.z);
        card(b, _m1, {
          w: 1.1, h: H * 0.34, bow: 0.12, cell: C_VINE,
          toward: new THREE.Vector3(0, 1, 0), blend: 0.35, segs: 1,
          swayA: 0.9, swayB: 0.86, flutA: 1.1, flutB: 0.25,
          trans: 0.9, ao0: 0.62, ao1: 0.88,
        });
      }
    }
  }
}

function buildCypress(b: Build, cx: BuildCtx, variant: number): void {
  const { rng, tier, lod } = cx;
  const H = 7.6 + variant * 2.3 + rng() * 1.8;
  // Wind-shaped: the whole tree leans and the crown is pushed downwind and
  // flattened, which is what a headland cypress actually looks like.
  const lean = 0.26 + rng() * 0.12;
  trunk(b, IDENT, {
    height: H * 0.86, baseR: 0.46 + rng() * 0.10, topR: 0.16,
    rings: lod === 0 ? 8 : lod === 1 ? 4 : 2,
    radial: lod === 0 ? tier.radial : lod === 1 ? 5 : 4,
    bendX: lean * H, bendZ: (rng() - 0.5) * 0.05 * H, bendPow: 1.45,
    flare: 1.1, cell: C_BARK_FIBRE, sway: 0.26, lumps: 0.10,
    ao0: 0.42, ao1: 0.86, wrapV: 3,
  }, rng);
  const nb = lod === 0 ? 5 : lod === 1 ? 3 : 0;
  for (let i = 0; i < nb; i++) {
    branch(b, cx, {
      bendX: lean * H, bendPow: 1.45, H: H * 0.86, t: 0.5 + (i / Math.max(1, nb)) * 0.42,
      az: -0.9 + (i / Math.max(1, nb)) * 1.8 + rng() * 0.4,
      tilt: 0.85 + rng() * 0.4, len: H * (0.20 + rng() * 0.12),
      r0: 0.12, cell: C_BARK_FIBRE, sway: 0.42, downwind: H * 0.10,
    });
  }
  canopy(b, cx, {
    center: new THREE.Vector3(lean * H * 0.95, H * 0.90, 0),
    rx: H * 0.56, ry: H * 0.19, rz: H * 0.42,
    n: lod === 0 ? 14 : lod === 1 ? 6 : 3,
    cell: C_CYPRESS, w: H * 0.34, h: H * 0.26, bow: H * 0.05,
    topBias: 0.65, sway: 0.55, flut: 0.30, trans: 0.72, blend: 0.68,
    segs: lod === 0 ? 2 : 1,
  });
}

function buildEucalyptus(b: Build, cx: BuildCtx, variant: number): void {
  const { rng, tier, lod } = cx;
  const H = 16 + variant * 4.2 + rng() * 3;
  const bendX = (rng() - 0.5) * 0.13 * H;
  trunk(b, IDENT, {
    height: H * 0.80, baseR: 0.44 + rng() * 0.10, topR: 0.14,
    rings: lod === 0 ? 9 : lod === 1 ? 4 : 2,
    radial: lod === 0 ? tier.radial : lod === 1 ? 5 : 4,
    bendX, bendZ: (rng() - 0.5) * 0.07 * H, bendPow: 1.4,
    flare: 0.85, cell: C_BARK_EUC, sway: 0.40, lumps: 0.05,
    ao0: 0.52, ao1: 1.0, wrapV: 4,
  }, rng);
  const nb = lod === 0 ? 4 : lod === 1 ? 2 : 0;
  for (let i = 0; i < nb; i++) {
    branch(b, cx, {
      bendX, bendPow: 1.4, H: H * 0.80, t: 0.72 + (i / Math.max(1, nb)) * 0.24,
      az: i * GOLD + rng() * 0.6, tilt: 0.5 + rng() * 0.4,
      len: H * (0.16 + rng() * 0.10), r0: 0.11, cell: C_BARK_EUC, sway: 0.66,
    });
  }
  canopy(b, cx, {
    center: new THREE.Vector3(bendX, H * 0.90, 0),
    rx: H * 0.29, ry: H * 0.25, rz: H * 0.29,
    n: lod === 0 ? 13 : lod === 1 ? 6 : 3,
    cell: C_EUCLEAF, w: H * 0.30, h: H * 0.34, bow: H * 0.04,
    topBias: 0.35, rollBias: 0, sway: 0.90, flut: 0.70, trans: 0.95, blend: 0.62,
    segs: lod === 0 ? 2 : 1,
  });
}

/* ---- shrubs, rosettes, cover ---------------------------------------------*/

function buildSeaGrape(b: Build, cx: BuildCtx, variant: number): void {
  const { rng, tier, lod } = cx;
  const H = 1.6 + variant * 0.55 + rng() * 0.4;
  const stems = lod === 0 ? 4 : 2;
  for (let i = 0; i < stems; i++) {
    _m1.makeRotationY(i * GOLD).multiply(_m2.makeRotationZ(-(0.25 + rng() * 0.3)));
    trunk(b, _m1, {
      height: H * 0.85, baseR: 0.075, topR: 0.035,
      rings: lod === 0 ? 3 : 2, radial: lod === 0 ? 5 : 4,
      bendX: 0.2, bendZ: 0, bendPow: 1.4, flare: 0.5, cell: C_BARK_WOOD,
      sway: 0.4, lumps: 0.12, ao0: 0.40, ao1: 0.72, wrapV: 2,
    }, rng);
  }
  canopy(b, cx, {
    center: new THREE.Vector3(0, H * 0.78, 0),
    rx: H * 0.80, ry: H * 0.40, rz: H * 0.80,
    n: lod === 0 ? 9 : 4,
    cell: C_SEAGRAPE, w: H * 1.05, h: H * 0.95, bow: H * 0.16,
    topBias: 0.5, sway: 0.55, flut: 0.35, trans: 0.85, blend: 0.70,
    segs: lod === 0 ? 2 : 1,
  });
}

function buildTreeFern(b: Build, cx: BuildCtx, variant: number): void {
  const { rng, tier, lod } = cx;
  const H = 2.6 + variant * 0.9 + rng() * 0.7;
  const top = trunk(b, IDENT, {
    height: H, baseR: 0.24, topR: 0.18,
    rings: lod === 0 ? 6 : 3, radial: lod === 0 ? tier.radial : 4,
    bendX: (rng() - 0.5) * 0.14 * H, bendZ: (rng() - 0.5) * 0.1 * H, bendPow: 1.7,
    flare: 0.55, cell: C_BARK_FIBRE, sway: 0.32, lumps: 0.10,
    ao0: 0.36, ao1: 0.80, wrapV: 3,
  }, rng).clone();
  const n = lod === 0 ? 9 : 5;
  for (let i = 0; i < n; i++) {
    const k = ((i * 3) % n) / Math.max(1, n - 1);
    _m1.copy(top)
      .multiply(_m2.makeRotationY(i * GOLD + rng() * 0.3))
      .multiply(new THREE.Matrix4().makeRotationZ(0.92 - k * 0.88 + (rng() - 0.5) * 0.15));
    frond(b, _m1, {
      length: H * (0.95 + rng() * 0.30), width: H * 0.23,
      lift: 0.36, droop: 0.55 + k * 0.45, curve: (rng() - 0.5) * 0.2,
      keel: 0.26, twist: (rng() - 0.5) * 0.5,
      segs: lod === 0 ? Math.max(6, tier.frondSegs - 1) : 3,
      cell: C_FERNL, taper: 0.55,
      sway: 0.9, flutter: 0.72, trans: 1.0, ao0: 0.52, ao1: 1.0,
    });
  }
}

function buildUnderstory(b: Build, cx: BuildCtx, variant: number): void {
  const { rng, tier, lod } = cx;
  const H = 1.3 + variant * 0.45 + rng() * 0.4;
  const n = lod === 0 ? 8 : 4;
  for (let i = 0; i < n; i++) {
    const k = i / Math.max(1, n - 1);
    _m1.makeRotationY(i * GOLD + rng() * 0.3)
      .multiply(_m2.makeRotationZ(1.15 - k * 0.85 + (rng() - 0.5) * 0.2));
    frond(b, _m1, {
      length: H * (1.05 + rng() * 0.4), width: H * 0.30,
      lift: 0.42, droop: 0.62, curve: (rng() - 0.5) * 0.22,
      keel: 0.34, twist: (rng() - 0.5) * 0.4,
      segs: lod === 0 ? 5 : 3, cell: C_PADDLE, taper: 0.32,
      sway: 0.5, flutter: 0.85, trans: 1.0, ao0: 0.46, ao1: 0.98,
    });
  }
}

function buildAgave(b: Build, cx: BuildCtx, variant: number): void {
  const { rng, tier, lod } = cx;
  const S = 0.85 + variant * 0.22 + rng() * 0.2;
  const n = lod === 0 ? 15 + variant * 3 : 8;
  for (let i = 0; i < n; i++) {
    const k = i / Math.max(1, n - 1);
    _m1.makeRotationY(i * GOLD)
      .multiply(_m2.makeRotationZ(1.28 - k * 1.10 + (rng() - 0.5) * 0.12));
    frond(b, _m1, {
      length: S * (1.05 + rng() * 0.35), width: S * 0.15,
      lift: 0.55, droop: 0.85 + k * 0.35, curve: (rng() - 0.5) * 0.1,
      keel: 0.55, twist: (rng() - 0.5) * 0.25,
      segs: lod === 0 ? 4 : 2, cell: C_AGAVE, bladed: true,
      // Succulents are rigid. Almost no flutter is exactly right.
      sway: 0.10, flutter: 0.06, trans: 0.45, ao0: 0.48, ao1: 0.95,
    });
  }
  if (variant >= 1 && tier.detail && lod === 0) {
    // The flowering spike. A four-metre candelabra on a cliff edge is worth
    // twenty triangles.
    const top = trunk(b, IDENT, {
      height: S * 4.4, baseR: 0.075, topR: 0.022, rings: 5, radial: 4,
      bendX: S * 0.25, bendZ: 0, bendPow: 1.8, flare: 0.4, cell: C_BARK_FIBRE,
      sway: 0.95, lumps: 0.06, ao0: 0.6, ao1: 1.0, wrapV: 3,
    }, rng).clone();
    for (let i = 0; i < 9; i++) {
      const t = 0.35 + (i / 9) * 0.6;
      _m1.copy(top).multiply(new THREE.Matrix4().makeTranslation(
        Math.cos(i * GOLD) * S * 0.30, -S * 4.4 * (1 - t), Math.sin(i * GOLD) * S * 0.30));
      blob(b, _m1, S * 0.11, C_AGAVE, 0.85);
    }
  }
}

function buildBloom(b: Build, cx: BuildCtx, variant: number): void {
  const { rng, lod } = cx;
  const climbing = variant >= 1;
  const H = climbing ? 2.5 + rng() * 0.6 : 1.5 + rng() * 0.4;
  for (let i = 0; i < (lod === 0 ? 5 : 3); i++) {
    _m1.makeRotationY(i * GOLD).multiply(_m2.makeRotationZ(-(0.1 + rng() * 0.35)));
    trunk(b, _m1, {
      height: H * 0.8, baseR: 0.045, topR: 0.018, rings: 2, radial: 4,
      bendX: 0.2, bendZ: 0, bendPow: 1.4, flare: 0.4, cell: C_BARK_WOOD,
      sway: 0.55, lumps: 0.14, ao0: 0.4, ao1: 0.72, wrapV: 2,
    }, rng);
  }
  canopy(b, cx, {
    center: new THREE.Vector3(0, H * 0.74, 0),
    rx: climbing ? H * 0.34 : H * 0.85, ry: H * 0.40, rz: climbing ? H * 0.34 : H * 0.85,
    n: lod === 0 ? 10 : 5,
    cell: C_BLOOM, w: H * 0.95, h: H * 0.85, bow: H * 0.13,
    topBias: 0.45, sway: 0.70, flut: 0.55, trans: 0.9, blend: 0.66,
    segs: lod === 0 ? 2 : 1,
  });
}

function buildDriftwood(b: Build, cx: BuildCtx, variant: number): void {
  const { rng, lod } = cx;
  const L = 2.4 + variant * 1.3 + rng() * 1.1;
  const R = 0.22 + rng() * 0.13;
  // Lay the log down: +Y becomes +X, then lift it onto its own radius.
  _m1.makeRotationZ(-Math.PI / 2 + 0.10 + rng() * 0.08);
  _m1.setPosition(-L * 0.35, R * 0.82, 0);
  const top = trunk(b, _m1, {
    height: L, baseR: R, topR: R * 0.55, rings: 5, radial: lod === 0 ? 6 : 4,
    bendX: L * 0.16, bendZ: L * 0.10, bendPow: 1.5, flare: 0.35,
    cell: C_BARK_EUC, sway: 0, lumps: 0.19, ao0: 0.62, ao1: 0.95, wrapV: 2,
  }, rng).clone();
  for (let i = 0; i < 2; i++) {
    _m2.copy(top).multiply(new THREE.Matrix4().makeRotationY(rng() * TAU))
      .multiply(new THREE.Matrix4().makeRotationZ(-0.7 - rng() * 0.6));
    trunk(b, _m2, {
      height: L * 0.30, baseR: R * 0.34, topR: R * 0.10, rings: 2, radial: 4,
      bendX: 0.15, bendZ: 0, bendPow: 1.4, flare: 0.3, cell: C_BARK_EUC,
      sway: 0, lumps: 0.2, ao0: 0.62, ao1: 0.92, wrapV: 1,
    }, rng);
  }
}

function buildTuft(b: Build, cx: BuildCtx, variant: number): void {
  const { rng } = cx;
  const up = new THREE.Vector3(0, 1, 0);
  if (variant === 1) {
    // A small fern clump for the jungle floor.
    for (let i = 0; i < 5; i++) {
      _m1.makeRotationY(i * GOLD + rng() * 0.4)
        .multiply(_m2.makeRotationZ(0.85 - (i / 5) * 0.6));
      frond(b, _m1, {
        length: 0.55 + rng() * 0.28, width: 0.15, lift: 0.35, droop: 0.7,
        curve: (rng() - 0.5) * 0.2, keel: 0.28, twist: (rng() - 0.5) * 0.4,
        segs: 3, cell: C_FERNL, taper: 0.55,
        sway: 0.35, flutter: 1.0, trans: 1.0, ao0: 0.42, ao1: 0.95,
      });
    }
    return;
  }
  const dry = variant === 2;
  const h = dry ? 0.72 + rng() * 0.3 : 0.52 + rng() * 0.26;
  const w = dry ? 0.58 : 0.82;
  const n = dry ? 2 : 3;
  for (let i = 0; i < n; i++) {
    _m1.makeRotationY((i / n) * Math.PI + rng() * 0.3);
    _m1.setPosition(0, h * 0.5, 0);
    card(b, _m1, {
      w: w * (0.85 + rng() * 0.3), h, bow: 0.05, cell: C_GRASS,
      toward: up, blend: 0.62, segs: 1,
      swayA: 0.15, swayB: 0.55, flutA: 0.10, flutB: 1.0,
      trans: 0.95, ao0: 0.40, ao1: 1.0,
    });
  }
}

/* ---- the table -----------------------------------------------------------*/

const SP_PALM = 0, SP_PALM_TALL = 1, SP_TRAVELLER = 2, SP_BROADLEAF = 3;
const SP_CYPRESS = 4, SP_EUCALYPTUS = 5, SP_SEAGRAPE = 6, SP_TREEFERN = 7;
const SP_UNDERSTORY = 8, SP_AGAVE = 9, SP_BLOOM = 10, SP_DRIFTWOOD = 11, SP_TUFT = 12;

interface SpeciesDef {
  key: string;
  build: (b: Build, cx: BuildCtx, variant: number) => void;
  /** 2 = canopy (reaches the far band), 1 = mid plant, 0 = ground cover. */
  rank: 0 | 1 | 2;
  lods: number;
  variants: number;
  scale: [number, number];
  /** How far the plant tilts toward the ground normal. Trees stand up. */
  tilt: number;
  wind: [number, number];
  /** Instance tint: hue 0..1, saturation range, luminance range. */
  hue: number;
  sat: [number, number];
  lum: [number, number];
  /** Slot capacity per layer at density 1. */
  cap: number;
  shadow: boolean;
}

const SPECIES: SpeciesDef[] = [
  {
    key: "palm", build: (b, c, v) => buildPalm(b, c, v, false), rank: 2, lods: 3, variants: 3,
    scale: [0.72, 1.34], tilt: 0.10, wind: [0.55, 1.0],
    hue: 0.26, sat: [0.10, 0.26], lum: [0.76, 1.08], cap: 300, shadow: true,
  },
  {
    key: "palmTall", build: (b, c, v) => buildPalm(b, c, v, true), rank: 2, lods: 3, variants: 3,
    scale: [0.78, 1.22], tilt: 0.06, wind: [0.6, 1.0],
    hue: 0.28, sat: [0.10, 0.24], lum: [0.70, 1.02], cap: 300, shadow: true,
  },
  {
    key: "traveller", build: buildTraveller, rank: 2, lods: 3, variants: 2,
    scale: [0.80, 1.45], tilt: 0.20, wind: [0.5, 0.9],
    hue: 0.30, sat: [0.10, 0.26], lum: [0.72, 1.05], cap: 220, shadow: true,
  },
  {
    key: "broadleaf", build: buildBroadleaf, rank: 2, lods: 3, variants: 3,
    scale: [0.78, 1.40], tilt: 0.08, wind: [0.45, 0.85],
    hue: 0.30, sat: [0.10, 0.28], lum: [0.62, 1.02], cap: 340, shadow: true,
  },
  {
    key: "cypress", build: buildCypress, rank: 2, lods: 3, variants: 2,
    scale: [0.80, 1.45], tilt: 0.10, wind: [0.30, 0.60],
    hue: 0.38, sat: [0.08, 0.20], lum: [0.66, 0.98], cap: 260, shadow: true,
  },
  {
    key: "eucalyptus", build: buildEucalyptus, rank: 2, lods: 3, variants: 2,
    scale: [0.78, 1.28], tilt: 0.06, wind: [0.55, 0.95],
    hue: 0.33, sat: [0.05, 0.15], lum: [0.80, 1.14], cap: 260, shadow: true,
  },
  {
    key: "seagrape", build: buildSeaGrape, rank: 1, lods: 2, variants: 2,
    scale: [0.72, 1.55], tilt: 0.42, wind: [0.35, 0.75],
    hue: 0.24, sat: [0.08, 0.24], lum: [0.68, 1.06], cap: 700, shadow: true,
  },
  {
    key: "treefern", build: buildTreeFern, rank: 1, lods: 2, variants: 2,
    scale: [0.70, 1.50], tilt: 0.30, wind: [0.5, 0.9],
    hue: 0.27, sat: [0.10, 0.26], lum: [0.62, 1.00], cap: 700, shadow: true,
  },
  {
    key: "understory", build: buildUnderstory, rank: 1, lods: 2, variants: 2,
    scale: [0.70, 1.65], tilt: 0.55, wind: [0.55, 1.0],
    hue: 0.29, sat: [0.10, 0.28], lum: [0.60, 1.05], cap: 900, shadow: false,
  },
  {
    key: "agave", build: buildAgave, rank: 1, lods: 1, variants: 2,
    scale: [0.70, 1.55], tilt: 0.62, wind: [0.10, 0.30],
    hue: 0.42, sat: [0.05, 0.18], lum: [0.82, 1.12], cap: 500, shadow: false,
  },
  {
    key: "bloom", build: buildBloom, rank: 1, lods: 1, variants: 2,
    scale: [0.75, 1.40], tilt: 0.45, wind: [0.45, 0.85],
    hue: 0.92, sat: [0.03, 0.13], lum: [0.85, 1.15], cap: 400, shadow: false,
  },
  {
    key: "driftwood", build: buildDriftwood, rank: 1, lods: 1, variants: 2,
    scale: [0.80, 1.60], tilt: 0.88, wind: [0, 0],
    hue: 0.09, sat: [0.0, 0.07], lum: [1.05, 1.45], cap: 220, shadow: true,
  },
  {
    key: "tuft", build: buildTuft, rank: 0, lods: 1, variants: 3,
    scale: [0.70, 1.55], tilt: 0.85, wind: [0.6, 1.15],
    hue: 0.22, sat: [0.12, 0.32], lum: [0.62, 1.14], cap: 4200, shadow: false,
  },
];

/* ------------------------------------------------------------------------ *
 * Material
 * ------------------------------------------------------------------------ */

/** Declarations shared by the surface shader and the shadow depth shader. */
const VEG_ATTRS = /* glsl */`
attribute vec3 aFlex;    // x = trunk sway, y = leaf flutter, z = translucency
attribute vec2 aOrient;  // cos / sin of this instance's inverse yaw
attribute vec4 aWind;    // x = phase, y = compliance, zw = fade start / end
uniform float uTime;
uniform vec4 uWindParams; // xy = direction, z = strength, w = time scale
`;

/**
 * The wind.
 *
 * Two coupled motions, both driven off one per-instance phase so nothing in the
 * world moves in lockstep: the whole plant leans along the gust with a
 * quadratic ramp up its trunk, and every leaf flutters along its own length at
 * roughly three times the frequency. The gust envelope is the product of two
 * slow sines, which gives the long swells and momentary lulls a single sine
 * cannot.
 *
 * `aOrient` is the cosine/sine of the instance's inverse yaw. Instance matrices
 * here are (yaw x uniform scale x translation), so rotating the world-space
 * gust into the instance's own space is a single 2D rotation — no inverse
 * matrix, no per-frame CPU work.
 */
const VEG_WIND = /* glsl */`
  float spT = uTime * uWindParams.w + aWind.x;
  float spGust = 0.55 + 0.45 * sin( spT * 0.27 ) * sin( spT * 0.113 + 1.9 );
  float spAmp = uWindParams.z * aWind.y * spGust;
  float spS = sin( spT ) * 0.68 + sin( spT * 1.71 + 2.3 ) * 0.32;
  vec2 spW = uWindParams.xy * ( spS * spAmp );
  vec2 spL = vec2( spW.x * aOrient.x - spW.y * aOrient.y,
                   spW.x * aOrient.y + spW.y * aOrient.x );
  float spBend = aFlex.x * aFlex.x;
  transformed.xz += spL * spBend * 2.6;
  // Drop as it leans, so a bending trunk pivots instead of stretching.
  transformed.y -= spBend * length( spL ) * 1.35;
  if ( aFlex.y > 0.001 ) {
    float spF = spT * 3.1 + transformed.x * 1.15 + transformed.z * 0.83 + transformed.y * 0.45;
    float spFl = sin( spF ) * 0.6 + sin( spF * 1.93 + 1.3 ) * 0.4;
    transformed.y += spFl * aFlex.y * ( 0.10 + 0.36 * spAmp );
    transformed.xz += spL * aFlex.y * 0.9;
  }
`;

interface VegMaterials {
  main: THREE.MeshStandardMaterial;
  depth: THREE.MeshDepthMaterial;
  uTime: { value: number };
  uWindParams: { value: THREE.Vector4 };
  uTransTint: { value: THREE.Color };
  dispose(): void;
}

function makeMaterials(atlas: VegAtlas): VegMaterials {
  const uTime = { value: 0 };
  const uWindParams = { value: new THREE.Vector4(0.82, 0.57, 0.16, 1.0) };
  const uTransTint = { value: new THREE.Color(0.62, 0.92, 0.34) };

  const main = new THREE.MeshStandardMaterial({
    map: atlas.albedo,
    normalMap: atlas.normal,
    roughnessMap: atlas.rough,
    roughness: 1,
    metalness: 0,
    alphaTest: ALPHA_TEST,
    side: THREE.DoubleSide,
    shadowSide: THREE.DoubleSide,
    vertexColors: true,
    dithering: true,
  });
  main.normalScale.set(0.85, 0.85);
  main.name = "palmas.vegetation";
  main.customProgramCacheKey = () => "palmas-veg-surface";

  main.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uWindParams = uWindParams;
    shader.uniforms.uTransTint = uTransTint;

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", /* glsl */`#include <common>
        ${VEG_ATTRS}
        varying float vTrans;
        varying float vFade;`)
      .replace("#include <begin_vertex>", /* glsl */`#include <begin_vertex>
        vTrans = aFlex.z;
        ${VEG_WIND}`)
      .replace("#include <project_vertex>", /* glsl */`#include <project_vertex>
        vFade = 1.0 - smoothstep( aWind.z, aWind.w, length( mvPosition.xyz ) );`);

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", /* glsl */`#include <common>
        varying float vTrans;
        varying float vFade;
        uniform vec3 uTransTint;
        // Ordered dither. Screen-door beats popping, and unlike alpha blending
        // it needs no sorting and writes depth.
        float spBayer2( vec2 a ) { a = floor( a ); return fract( a.x * 0.5 + a.y * a.y * 0.75 ); }
        float spBayer4( vec2 a ) { return spBayer2( a * 0.5 ) * 0.25 + spBayer2( a ); }`)
      .replace("#include <clipping_planes_fragment>", /* glsl */`#include <clipping_planes_fragment>
        if ( vFade < 0.997 && spBayer4( gl_FragCoord.xy ) * 1.0667 > vFade ) discard;`)
      .replace("#include <lights_fragment_end>", /* glsl */`#include <lights_fragment_end>
        #if ( NUM_DIR_LIGHTS > 0 )
        if ( vTrans > 0.01 ) {
          // Sub-surface transmission. Forward scatter for the moment the sun is
          // directly behind a frond, plus a wrap term so the shaded side of a
          // leaf never goes flat black. This is the single strongest golden-hour
          // cue vegetation has.
          vec3 spLdir = directionalLights[ 0 ].direction;
          float spBack = pow( clamp( dot( -geometryViewDir, spLdir ), 0.0, 1.0 ), 3.0 );
          float spWrap = clamp( ( dot( geometryNormal, spLdir ) + 0.62 ) * 0.617, 0.0, 1.0 );
          reflectedLight.indirectDiffuse += directionalLights[ 0 ].color * uTransTint
            * diffuseColor.rgb * vTrans * ( spBack * 2.1 + spWrap * 0.30 );
        }
        #endif`);
  };

  // The shadow pass has to run the same wind, or every plant casts the shadow
  // of a plant standing perfectly still.
  const depth = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: atlas.albedo,
    alphaTest: ALPHA_TEST,
    side: THREE.DoubleSide,
  });
  depth.customProgramCacheKey = () => "palmas-veg-depth";
  depth.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uWindParams = uWindParams;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VEG_ATTRS}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${VEG_WIND}`);
  };

  return {
    main, depth, uTime, uWindParams, uTransTint,
    dispose() { main.dispose(); depth.dispose(); },
  };
}

/* ------------------------------------------------------------------------ *
 * Instance pools
 * ------------------------------------------------------------------------ */
//
// One InstancedMesh per (species, variant, LOD). Slots are handed out from a
// bump allocator and released by swapping the last live instance down into the
// hole, so a cell leaving the streaming radius costs O(its own instances) and
// the draw call never has to skip over dead entries.

interface Cell {
  key: number;
  cx: number;
  cz: number;
  /** Currently placed band, -1 = nothing placed. */
  band: number;
  /** Lowest rank generated so far; 3 = nothing generated yet. */
  gen: number;
  /** Flat records, stride REC. */
  recs: number[];
  /** Parallel arrays of the pool slots this cell currently owns. */
  sLayer: number[];
  sSlot: number[];
  queued: boolean;
  dist: number;
}

interface Layer {
  mesh: THREE.InstancedMesh;
  cap: number;
  count: number;
  mat: Float32Array;
  col: Float32Array;
  ori: Float32Array;
  wnd: Float32Array;
  oriAttr: THREE.InstancedBufferAttribute;
  wndAttr: THREE.InstancedBufferAttribute;
  ownerCell: (Cell | null)[];
  ownerIdx: Int32Array;
  lo: number;
  hi: number;
}

function makeLayer(
  geom: THREE.BufferGeometry, mat: THREE.Material, depth: THREE.MeshDepthMaterial,
  cap: number, castShadow: boolean, name: string,
): Layer {
  const ori = new Float32Array(cap * 2);
  const wnd = new Float32Array(cap * 4);
  const oriAttr = new THREE.InstancedBufferAttribute(ori, 2);
  const wndAttr = new THREE.InstancedBufferAttribute(wnd, 4);
  oriAttr.setUsage(THREE.DynamicDrawUsage);
  wndAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute("aOrient", oriAttr);
  geom.setAttribute("aWind", wndAttr);

  const mesh = new THREE.InstancedMesh(geom, mat, cap);
  mesh.name = name;
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  mesh.customDepthMaterial = depth;
  // Instances are scattered over kilometres; a single bounding sphere would
  // either cull the whole layer or never cull anything. The cell streamer is
  // the culling system here.
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  return {
    mesh, cap, count: 0,
    mat: mesh.instanceMatrix.array as Float32Array,
    col: mesh.instanceColor.array as Float32Array,
    ori, wnd, oriAttr, wndAttr,
    ownerCell: new Array(cap).fill(null),
    ownerIdx: new Int32Array(cap),
    lo: cap, hi: -1,
  };
}

function touch(l: Layer, slot: number): void {
  if (slot < l.lo) l.lo = slot;
  if (slot > l.hi) l.hi = slot;
}

function moveSlot(l: Layer, from: number, to: number): void {
  l.mat.copyWithin(to * 16, from * 16, from * 16 + 16);
  l.col.copyWithin(to * 3, from * 3, from * 3 + 3);
  l.ori.copyWithin(to * 2, from * 2, from * 2 + 2);
  l.wnd.copyWithin(to * 4, from * 4, from * 4 + 4);
}

function freeSlot(l: Layer, slot: number): void {
  const last = l.count - 1;
  if (slot !== last) {
    moveSlot(l, last, slot);
    const owner = l.ownerCell[last];
    const oi = l.ownerIdx[last];
    l.ownerCell[slot] = owner;
    l.ownerIdx[slot] = oi;
    // Repoint the cell that owned the instance we just relocated.
    if (owner) owner.sSlot[oi] = slot;
    touch(l, slot);
  }
  l.ownerCell[last] = null;
  l.count = last;
}

function flushLayer(l: Layer): void {
  const m = l.mesh;
  m.count = l.count;
  if (l.hi < l.lo) return;
  const lo = l.lo, n = l.hi - l.lo + 1;
  const push = (attr: THREE.BufferAttribute | THREE.InstancedBufferAttribute, size: number) => {
    const any = attr as unknown as { addUpdateRange?: (s: number, c: number) => void };
    if (typeof any.addUpdateRange === "function") any.addUpdateRange(lo * size, n * size);
    attr.needsUpdate = true;
  };
  push(m.instanceMatrix, 16);
  if (m.instanceColor) push(m.instanceColor, 3);
  push(l.oriAttr, 2);
  push(l.wndAttr, 4);
  l.lo = l.cap;
  l.hi = -1;
}

/* ------------------------------------------------------------------------ *
 * Scatter rules
 * ------------------------------------------------------------------------ */

interface MixEntry {
  sp: number;
  w: number;
  /** Reject above this slope (slope = 1 - normal.y, so 0.4 is about 33°). */
  maxSlope: number;
  /** Reject above this elevation. Driftwood belongs on the tide line. */
  maxH?: number;
  /** Restrict to these variants (ground cover picks its clump type by biome). */
  variants?: number[];
}

interface BiomeMix {
  /** Mean spacing in metres at density 1. */
  step: number;
  list: MixEntry[];
}

/** Densest spacing per rank — the candidate lattice all mixes are sampled from. */
const RANK_STEP = [1.75, 4.4, 8.4];

/** Rank 2: the canopy. Reaches the far band, so it defines the skyline. */
const MIX2: Partial<Record<Biome, BiomeMix>> = {
  jungle: {
    step: 8.6, list: [
      { sp: SP_PALM_TALL, w: 0.27, maxSlope: 0.52 },
      { sp: SP_BROADLEAF, w: 0.33, maxSlope: 0.50 },
      { sp: SP_PALM, w: 0.14, maxSlope: 0.55 },
      { sp: SP_TRAVELLER, w: 0.10, maxSlope: 0.48 },
      { sp: SP_EUCALYPTUS, w: 0.09, maxSlope: 0.46 },
      { sp: SP_CYPRESS, w: 0.07, maxSlope: 0.58 },
    ],
  },
  beach: {
    step: 15, list: [
      { sp: SP_PALM, w: 0.74, maxSlope: 0.48 },
      { sp: SP_BROADLEAF, w: 0.10, maxSlope: 0.40 },
      { sp: SP_PALM_TALL, w: 0.08, maxSlope: 0.40 },
      { sp: SP_TRAVELLER, w: 0.08, maxSlope: 0.38 },
    ],
  },
  hillside: {
    step: 12.5, list: [
      { sp: SP_CYPRESS, w: 0.30, maxSlope: 0.62 },
      { sp: SP_EUCALYPTUS, w: 0.27, maxSlope: 0.48 },
      { sp: SP_PALM, w: 0.21, maxSlope: 0.52 },
      { sp: SP_BROADLEAF, w: 0.12, maxSlope: 0.46 },
      { sp: SP_PALM_TALL, w: 0.10, maxSlope: 0.44 },
    ],
  },
  cliff: {
    step: 26, list: [
      { sp: SP_CYPRESS, w: 0.50, maxSlope: 0.80 },
      { sp: SP_PALM, w: 0.28, maxSlope: 0.72 },
      { sp: SP_BROADLEAF, w: 0.22, maxSlope: 0.70 },
    ],
  },
};

/** Rank 1: the middle storey — what makes the jungle floor unreadable. */
const MIX1: Partial<Record<Biome, BiomeMix>> = {
  jungle: {
    step: 4.6, list: [
      { sp: SP_UNDERSTORY, w: 0.42, maxSlope: 0.62 },
      { sp: SP_TREEFERN, w: 0.27, maxSlope: 0.58 },
      { sp: SP_SEAGRAPE, w: 0.12, maxSlope: 0.62 },
      { sp: SP_BLOOM, w: 0.12, maxSlope: 0.60 },
      { sp: SP_TRAVELLER, w: 0.07, maxSlope: 0.50 },
    ],
  },
  beach: {
    step: 7.0, list: [
      { sp: SP_SEAGRAPE, w: 0.46, maxSlope: 0.52 },
      { sp: SP_AGAVE, w: 0.18, maxSlope: 0.62 },
      { sp: SP_DRIFTWOOD, w: 0.13, maxSlope: 0.24, maxH: 3.4 },
      { sp: SP_UNDERSTORY, w: 0.14, maxSlope: 0.50 },
      { sp: SP_BLOOM, w: 0.09, maxSlope: 0.50 },
    ],
  },
  hillside: {
    step: 7.6, list: [
      { sp: SP_SEAGRAPE, w: 0.33, maxSlope: 0.68 },
      { sp: SP_AGAVE, w: 0.25, maxSlope: 0.82 },
      { sp: SP_UNDERSTORY, w: 0.17, maxSlope: 0.60 },
      { sp: SP_BLOOM, w: 0.15, maxSlope: 0.62 },
      { sp: SP_TREEFERN, w: 0.10, maxSlope: 0.55 },
    ],
  },
  cliff: {
    step: 8.5, list: [
      { sp: SP_AGAVE, w: 0.52, maxSlope: 0.90 },
      { sp: SP_SEAGRAPE, w: 0.30, maxSlope: 0.86 },
      { sp: SP_BLOOM, w: 0.18, maxSlope: 0.86 },
    ],
  },
};

/** Rank 0: ground cover. Near the camera only, dithering out by ~60 m. */
const MIX0: Partial<Record<Biome, BiomeMix>> = {
  jungle: { step: 1.75, list: [{ sp: SP_TUFT, w: 1, maxSlope: 0.78, variants: [1, 1, 0] }] },
  beach: { step: 3.1, list: [{ sp: SP_TUFT, w: 1, maxSlope: 0.62, variants: [2, 2, 0] }] },
  hillside: { step: 2.1, list: [{ sp: SP_TUFT, w: 1, maxSlope: 0.78, variants: [0, 0, 2] }] },
  cliff: { step: 3.9, list: [{ sp: SP_TUFT, w: 1, maxSlope: 0.88, variants: [0, 2] }] },
};

const MIXES = [MIX0, MIX1, MIX2];

/** Record layout. Flat numbers per cell rather than objects — this is hot. */
const R_SP = 0, R_VAR = 1, R_RANK = 2, R_X = 3, R_Y = 4, R_Z = 5, R_YAW = 6;
const R_SCALE = 7, R_NX = 8, R_NZ = 9, R_R = 10, R_G = 11, R_B = 12;
const R_PHASE = 13, R_GAIN = 14, R_FAR = 15, REC = 16;

/* ------------------------------------------------------------------------ *
 * System
 * ------------------------------------------------------------------------ */

const nowMs: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(1, 1, 1);
const STRAW = new THREE.Color(1.0, 0.86, 0.52);

/**
 * Async only so the loading screen can repaint between the atlas bake and the
 * geometry bake. Nothing here awaits I/O — there is no I/O.
 */
const createVegetation: SystemFactory = async (ctx) => {
  const breathe = () => new Promise<void>((r) => setTimeout(r, 0));
  const tier = TIERS[ctx.quality] ?? TIERS.high;
  const seed = Math.floor(ctx.rng() * 0xffffffff) >>> 0;

  // ---- terrain access, with a graceful fallback --------------------------
  const terrain = ctx.services.terrain as TerrainService | undefined;
  const seaLevel = terrain?.seaLevel ?? SEA_LEVEL;
  const _nrm = new THREE.Vector3();

  function ground(x: number, z: number): number {
    if (terrain) return terrain.heightAt(x, z);
    // No terrain service: the atlas profile is wrong in the districts (see the
    // CIVIC LANDMASS note in terrain.ts) but it is a world, and it never throws.
    return shoreProfile(landSignedDistance(x, z)) + hillHeight(x, z) * 0.85;
  }

  function groundNormal(x: number, z: number): THREE.Vector3 {
    if (terrain) return terrain.normalAt(x, z, _nrm);
    const e = 1.1;
    return _nrm.set(
      ground(x - e, z) - ground(x + e, z), 2 * e, ground(x, z - e) - ground(x, z + e),
    ).normalize();
  }

  /** Reconciled coastline distance, if terrain publishes it. */
  const landDistOf = (terrain as unknown as { landDistanceAt?: (x: number, z: number) => number })
    ?.landDistanceAt;
  const landDist = (x: number, z: number) =>
    landDistOf ? landDistOf(x, z) : landSignedDistance(x, z);

  /**
   * Biome, reconciled the same way terrain.ts reconciles it: the atlas SDF puts
   * six districts and three hills under water, so when `biomeAt` says "ocean"
   * for ground that is demonstrably dry we re-run the rest of its decision tree
   * against the coastline terrain actually built. Identical logic, identical
   * thresholds — if the atlas is ever corrected this becomes dead code.
   */
  function classify(x: number, z: number, h: number, slope: number): Biome {
    let b = biomeAt(x, z, h, slope);
    if (b === "ocean") {
      const d = landDist(x, z);
      b = d < 26 && h < 8 ? "beach"
        : slope > 0.62 ? "cliff"
        : districtAt(x, z) ? "city"
        : h > 95 ? "hillside"
        : "jungle";
    }
    return b;
  }

  // ---- avenue segments, for road clearance -------------------------------
  const roadSeg: number[] = [];
  for (const ave of AVENUES) {
    for (let i = 0; i < ave.points.length - 1; i++) {
      const [ax, az] = ave.points[i];
      const [bx, bz] = ave.points[i + 1];
      const vx = bx - ax, vz = bz - az;
      roadSeg.push(ax, az, vx, vz, 1 / Math.max(1e-6, vx * vx + vz * vz));
    }
  }

  function roadDistance(x: number, z: number): number {
    let best = 1e9;
    for (let i = 0; i < roadSeg.length; i += 5) {
      const wx = x - roadSeg[i], wz = z - roadSeg[i + 1];
      const vx = roadSeg[i + 2], vz = roadSeg[i + 3];
      let t = (wx * vx + wz * vz) * roadSeg[i + 4];
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = wx - t * vx, ez = wz - t * vz;
      const d = ex * ex + ez * ez;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  function inLandmark(x: number, z: number): boolean {
    for (const lm of LANDMARKS) {
      const r = LANDMARK_CLEAR[lm.key] ?? 60;
      const dx = x - lm.x, dz = z - lm.z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  // ---- atlas + materials --------------------------------------------------
  let maxAniso = tier.aniso;
  try {
    maxAniso = Math.min(tier.aniso, ctx.renderer.capabilities.getMaxAnisotropy());
  } catch {
    /* headless — anisotropy is a hint, not a requirement */
  }

  const atlas = buildAtlas(tier.atlas, maxAniso, makeRng(seed ^ 0x9e3779b9));
  await breathe();
  const mats = makeMaterials(atlas);

  // ---- build every geometry, once ----------------------------------------
  const root = new THREE.Group();
  root.name = "palmas.vegetation";
  root.matrixAutoUpdate = false;
  ctx.scene.add(root);

  const layers: Layer[] = [];
  /** layerOf[species][lod][variant] — variants collapse to 0 above LOD 0. */
  const layerOf: number[][][] = [];
  let totalTris = 0;

  for (let sp = 0; sp < SPECIES.length; sp++) {
    const def = SPECIES[sp];
    const nVar = Math.max(1, Math.min(def.variants, tier.variants));
    const perLod: number[][] = [];
    for (let lod = 0; lod < def.lods; lod++) {
      const row: number[] = [];
      const count = lod === 0 ? nVar : 1;
      for (let v = 0; v < count; v++) {
        const b = new Build();
        const rng = makeRng((seed ^ (sp * 2654435761) ^ (v * 40503) ^ (lod * 97)) >>> 0);
        try {
          def.build(b, { tier, lod, rng }, v);
        } catch (err) {
          console.warn(`[San Palmas] vegetation: ${def.key} v${v} lod${lod} failed`, err);
        }
        if (b.idx.length === 0) { row.push(-1); continue; }
        totalTris += b.tris;
        const capMul = lod === 0 ? (def.lods === 1 && def.rank === 1 ? 2.4 : 1)
          : lod === 1 ? (def.rank === 2 ? 6 : 2.4)
          : 14;
        const cap = Math.max(24, Math.round(def.cap * capMul * Math.max(0.4, tier.density)));
        const layer = makeLayer(
          b.geometry(`${def.key}.${v}.${lod}`), mats.main, mats.depth, cap,
          tier.shadows && lod === 0 && def.shadow, `palmas.veg.${def.key}.${v}.lod${lod}`,
        );
        root.add(layer.mesh);
        row.push(layers.length);
        layers.push(layer);
      }
      perLod.push(row);
    }
    layerOf.push(perLod);
  }

  await breathe();

  /** Layer index for a species/variant at a given LOD, or -1. */
  function pickLayer(sp: number, variant: number, lod: number): number {
    const rows = layerOf[sp];
    const l = Math.min(lod, rows.length - 1);
    const row = rows[l];
    if (!row || row.length === 0) return -1;
    return row[l === 0 ? Math.min(variant, row.length - 1) : 0];
  }

  // ---- instance writing ---------------------------------------------------
  const _pos = new THREE.Vector3();
  const _up2 = new THREE.Vector3();
  const _qa = new THREE.Quaternion();
  const _qb = new THREE.Quaternion();
  const _scl = new THREE.Vector3();
  const _mtx = new THREE.Matrix4();
  let dirty = false;

  function place(cell: Cell, o: number, lod: number, fade0: number, fade1: number): void {
    const sp = cell.recs[o + R_SP] | 0;
    const def = SPECIES[sp];
    const li = pickLayer(sp, cell.recs[o + R_VAR] | 0, lod);
    if (li < 0) return;
    const l = layers[li];
    if (l.count >= l.cap) return;                 // pool full: drop it silently
    const slot = l.count++;

    const yaw = cell.recs[o + R_YAW];
    const nx = cell.recs[o + R_NX], nz = cell.recs[o + R_NZ];
    const ny = Math.sqrt(Math.max(0.04, 1 - nx * nx - nz * nz));
    // Trees stand up regardless of the ground; grass and shrubs lie with it.
    _up2.set(nx * def.tilt, lerp(1, ny, def.tilt), nz * def.tilt).normalize();
    _qa.setFromUnitVectors(UP, _up2);
    _qb.setFromAxisAngle(UP, yaw);
    _qa.multiply(_qb);
    _pos.set(cell.recs[o + R_X], cell.recs[o + R_Y], cell.recs[o + R_Z]);
    _scl.setScalar(cell.recs[o + R_SCALE]);
    _mtx.compose(_pos, _qa, _scl);

    l.mat.set(_mtx.elements, slot * 16);
    l.col[slot * 3] = cell.recs[o + R_R];
    l.col[slot * 3 + 1] = cell.recs[o + R_G];
    l.col[slot * 3 + 2] = cell.recs[o + R_B];
    // The inverse yaw, cached: the wind shader needs it every vertex.
    l.ori[slot * 2] = Math.cos(yaw);
    l.ori[slot * 2 + 1] = -Math.sin(yaw);
    l.wnd[slot * 4] = cell.recs[o + R_PHASE];
    l.wnd[slot * 4 + 1] = cell.recs[o + R_GAIN];
    l.wnd[slot * 4 + 2] = fade0;
    l.wnd[slot * 4 + 3] = fade1;

    l.ownerCell[slot] = cell;
    l.ownerIdx[slot] = cell.sSlot.length;
    touch(l, slot);
    cell.sLayer.push(li);
    cell.sSlot.push(slot);
    dirty = true;
  }

  function unplace(cell: Cell): void {
    for (let i = 0; i < cell.sSlot.length; i++) {
      // Read the slot fresh: freeing an earlier one may have relocated it.
      freeSlot(layers[cell.sLayer[i]], cell.sSlot[i]);
    }
    if (cell.sSlot.length) dirty = true;
    cell.sLayer.length = 0;
    cell.sSlot.length = 0;
  }

  /* ---- generation ------------------------------------------------------- */

  const _col = new THREE.Color();

  function tintFor(def: SpeciesDef, rng: () => number, arid: number, out: number[]): void {
    const sat = lerp(def.sat[0], def.sat[1], rng());
    const lum = lerp(def.lum[0], def.lum[1], rng());
    _col.setHSL(def.hue + (rng() - 0.5) * 0.04, 1, 0.5);
    _col.lerp(WHITE, 1 - sat);
    if (arid > 0.01) _col.lerp(STRAW, arid * 0.34);
    _col.multiplyScalar(lum);
    out[0] = _col.r; out[1] = _col.g; out[2] = _col.b;
  }

  const aridOf: Record<string, number> = {
    jungle: 0.0, beach: 0.34, hillside: 0.66, cliff: 0.78, city: 0.30, ocean: 0,
  };

  const tint3 = [1, 1, 1];

  /**
   * Fill `out` with the records of one rank inside one cell.
   *
   * Candidates come off a jittered lattice at the rank's densest spacing and
   * are then rejected down to the biome's own spacing, so a single lattice
   * serves every biome without ever placing two plants in the same spot. Three
   * `heightAt` calls per candidate (height plus a two-tap slope); the accurate
   * normal is only fetched for candidates that survive.
   */
  function scatter(out: number[], rank: number, ox: number, oz: number, size: number, rng: () => number): void {
    const base = RANK_STEP[rank] / Math.sqrt(Math.max(0.15, tier.density));
    const n = Math.max(1, Math.round(size / base));
    const step = size / n;
    const mixes = MIXES[rank];
    const e = 1.4;

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = ox + (i + rng()) * step;
        const z = oz + (j + rng()) * step;

        const h = ground(x, z);
        if (h < seaLevel + 0.22) continue;
        // Two-tap slope. Cheap, and only used to classify.
        const dx = ground(x + e, z) - h;
        const dz = ground(x, z + e) - h;
        const grad = Math.sqrt(dx * dx + dz * dz) / e;
        const slope = 1 - 1 / Math.sqrt(1 + grad * grad);

        const biome = classify(x, z, h, slope);
        const mix = mixes[biome];
        if (!mix) continue;                        // ocean and city grow nothing

        // Clearings and thickets. Without this the jungle is a lawn of trees.
        const clump = clamp01(
          fbmW(x * 0.0072, z * 0.0072, 3301) * 0.62 +
          fbmW(x * 0.00185, z * 0.00185, 9109) * 0.38);
        const density = clamp01(0.30 + clump * 1.15);
        let p = (base / mix.step) * (base / mix.step) * density;
        // Keep the carriageway and the landmarks clear.
        if (roadSeg.length) p *= smoothstep(AVENUE_CLEAR - 8, AVENUE_CLEAR + 16, roadDistance(x, z));
        if (p <= 0 || rng() > p) continue;
        if (inLandmark(x, z)) continue;

        // Weighted pick, with a per-species drift field so the map grows
        // palm groves and eucalyptus stands rather than a uniform blend.
        let total = 0;
        for (let k = 0; k < mix.list.length; k++) {
          const m = mix.list[k];
          if (slope > m.maxSlope) continue;
          if (m.maxH !== undefined && h - seaLevel > m.maxH) continue;
          total += m.w * (0.35 + 1.45 * fbmW(
            x * 0.0026 + m.sp * 17.3, z * 0.0026 - m.sp * 11.1, 700 + m.sp));
        }
        if (total <= 0) continue;
        let pick = rng() * total;
        let chosen: MixEntry | null = null;
        for (let k = 0; k < mix.list.length; k++) {
          const m = mix.list[k];
          if (slope > m.maxSlope) continue;
          if (m.maxH !== undefined && h - seaLevel > m.maxH) continue;
          pick -= m.w * (0.35 + 1.45 * fbmW(
            x * 0.0026 + m.sp * 17.3, z * 0.0026 - m.sp * 11.1, 700 + m.sp));
          if (pick <= 0) { chosen = m; break; }
        }
        if (!chosen) continue;

        const def = SPECIES[chosen.sp];
        const nrm = groundNormal(x, z);
        let yaw = rng() * TAU;
        if (biome === "beach" && (chosen.sp === SP_PALM || chosen.sp === SP_PALM_TALL)) {
          // Lean seaward. The surface normal tilts downhill, and on a beach
          // downhill is the water; palms build their trunks out over it.
          const hx = nrm.x, hz = nrm.z;
          if (hx * hx + hz * hz > 1e-4) {
            yaw = Math.atan2(-hz, hx) + (rng() - 0.5) * 0.9;
          }
        } else if (chosen.sp === SP_CYPRESS) {
          // Cypress lean downwind, all of them the same way. That is the look.
          yaw = 0.62 + (rng() - 0.5) * 0.7;
        }

        const arid = clamp01((aridOf[biome] ?? 0.2) + smoothstep(95, 210, h) * 0.4);
        tintFor(def, rng, arid, tint3);
        const variant = chosen.variants
          ? chosen.variants[Math.floor(rng() * chosen.variants.length)]
          : Math.floor(rng() * Math.max(1, Math.min(def.variants, tier.variants)));
        const scale = lerp(def.scale[0], def.scale[1], Math.pow(rng(), 0.8))
          * (1 - arid * 0.16);

        out.push(
          chosen.sp, variant, rank,
          x, h - 0.05 * scale, z,
          yaw, scale, nrm.x, nrm.z,
          tint3[0], tint3[1], tint3[2],
          rng() * TAU, lerp(def.wind[0], def.wind[1], rng()),
          // Half the canopy survives into the far band; at 700 m the eye reads
          // the silhouette of the hillside, not the count of the trees.
          rng() < 0.5 ? 1 : 0,
        );
      }
    }
  }

  /* ---- street trees ------------------------------------------------------ */
  //
  // The city module owns everything inside a district, and this module has no
  // way to know where its buildings landed — so wild vegetation stays out of
  // the districts entirely and the only thing planted there is a street tree in
  // the avenue verge, the one band (11 m to 15.2 m off the centreline) that
  // city.ts guarantees is clear of lots.

  const preseed: Map<number, number[]>[] = [new Map(), new Map(), new Map()];

  const plantKey = (cx: number, cz: number) => (cx + 8192) * 16384 + (cz + 8192);

  function preseedAt(rank: number, rec: number[]): void {
    const cx = Math.floor(rec[R_X] / PLANT_CELL);
    const cz = Math.floor(rec[R_Z] / PLANT_CELL);
    const key = plantKey(cx, cz);
    let list = preseed[rank].get(key);
    if (!list) { list = []; preseed[rank].set(key, list); }
    for (let i = 0; i < REC; i++) list.push(rec[i]);
  }

  function nearDistrict(x: number, z: number, pad: number): boolean {
    for (const d of DISTRICTS) {
      const dx = x - d.x, dz = z - d.z;
      if (dx * dx + dz * dz < (d.radius + pad) * (d.radius + pad)) return true;
    }
    return false;
  }

  (function seedStreets() {
    const rng = makeRng(seed ^ 0x5eed57);
    const rec = new Array(REC).fill(0);
    const palm = SPECIES[SP_PALM];
    const bloom = SPECIES[SP_BLOOM];
    let planted = 0;

    for (const ave of AVENUES) {
      let carry = 12 + rng() * 20;
      let station = 0;
      for (let s = 0; s < ave.points.length - 1; s++) {
        const [ax, az] = ave.points[s];
        const [bx, bz] = ave.points[s + 1];
        const vx = bx - ax, vz = bz - az;
        const len = Math.hypot(vx, vz) || 1e-3;
        const ux = vx / len, uz = vz / len;
        // Left-hand normal of the direction of travel.
        const px = -uz, pz = ux;
        let t = 0;
        while (t < len) {
          const gap = 22 + rng() * 9;
          t += carry > 0 ? carry : gap;
          carry = 0;
          if (t >= len) break;
          const cx = ax + ux * t, cz = az + uz * t;
          if (!nearDistrict(cx, cz, 90)) continue;
          if (inLandmark(cx, cz)) continue;
          station++;

          for (const side of [-1, 1]) {
            const off = ARTERIAL_HALF + 1.7 + rng() * 1.3;
            const x = cx + px * side * off + (rng() - 0.5) * 2.4;
            const z = cz + pz * side * off + (rng() - 0.5) * 2.4;
            const h = ground(x, z);
            if (h < seaLevel + 1.0) continue;
            const nrm = groundNormal(x, z);
            const isPlanter = station % 3 === 0 && side < 0;
            const def = isPlanter ? bloom : palm;
            tintFor(def, rng, 0.28, tint3);
            rec[R_SP] = isPlanter ? SP_BLOOM : SP_PALM;
            rec[R_VAR] = Math.floor(rng() * Math.max(1, Math.min(def.variants, tier.variants)));
            rec[R_RANK] = isPlanter ? 1 : 2;
            rec[R_X] = x; rec[R_Y] = h - 0.05; rec[R_Z] = z;
            rec[R_YAW] = rng() * TAU;
            // Street palms are pruned and even-aged; keep the range tight or
            // the avenue stops reading as planted.
            rec[R_SCALE] = isPlanter ? 0.7 + rng() * 0.35 : 0.66 + rng() * 0.24;
            rec[R_NX] = nrm.x; rec[R_NZ] = nrm.z;
            rec[R_R] = tint3[0]; rec[R_G] = tint3[1]; rec[R_B] = tint3[2];
            rec[R_PHASE] = rng() * TAU;
            rec[R_GAIN] = isPlanter ? 0.4 + rng() * 0.2 : 0.42 + rng() * 0.22;
            rec[R_FAR] = 1;
            preseedAt(rec[R_RANK], rec);
            planted++;
          }
        }
        carry = t - len;
      }
    }
    return planted;
  })();

  /* ---- cell streaming ----------------------------------------------------- */

  const plantCells = new Map<number, Cell>();
  const coverCells = new Map<number, Cell>();
  const queue: Cell[] = [];
  let stamp = 0;
  const seen = new Map<number, number>();
  const coverSeen = new Map<number, number>();

  function makeCell(cx: number, cz: number): Cell {
    return {
      key: plantKey(cx, cz), cx, cz, band: -1, gen: 3,
      recs: [], sLayer: [], sSlot: [], queued: false, dist: 0,
    };
  }

  /** Generate this cell's records down to `rank`, in rank order, once each. */
  function generate(cell: Cell, rank: number, cover: boolean): void {
    const size = cover ? COVER_CELL : PLANT_CELL;
    for (let r = 2; r >= rank; r--) {
      if (cell.gen <= r) continue;
      if (cover !== (r === 0)) { cell.gen = Math.min(cell.gen, r); continue; }
      const rng = makeRng(
        (Math.floor(hash2(cell.cx, cell.cz, seed + r * 7919) * 4294967296) >>> 0) || 1);
      scatter(cell.recs, r, cell.cx * size, cell.cz * size, size, rng);
      const pre = preseed[r].get(cell.key);
      if (pre) for (let i = 0; i < pre.length; i++) cell.recs.push(pre[i]);
      cell.gen = r;
    }
  }

  function placeCell(cell: Cell, band: number, cover: boolean): void {
    unplace(cell);
    const far = tier.bands[3];
    const fade0 = cover ? tier.coverFade : band === 3 ? far * 0.86 : 1e7;
    const fade1 = cover ? Math.max(tier.cover, tier.coverFade + 1) : band === 3 ? far : 1e7 + 1;
    const lod = cover ? 0 : band === 0 ? 0 : band === 3 ? 2 : 1;
    for (let o = 0; o < cell.recs.length; o += REC) {
      const rank = cell.recs[o + R_RANK];
      if (band >= 2 && rank < 2) continue;
      if (band === 3 && cell.recs[o + R_FAR] < 0.5) continue;
      place(cell, o, lod, fade0, fade1);
    }
    cell.band = band;
  }

  function processCell(cell: Cell, cover: boolean): void {
    const band = cell.band;                    // set by refresh as the *wanted* band
    generate(cell, cover ? 0 : band <= 1 ? 1 : 2, cover);
    placeCell(cell, band, cover);
    cell.queued = false;
  }

  /** Wanted band from a cell's distance, or -1 when it is out of range. */
  function bandFor(d: number): number {
    const b = tier.bands;
    return d < b[0] ? 0 : d < b[1] ? 1 : d < b[2] ? 2 : d < b[3] ? 3 : -1;
  }

  function refreshGrid(
    map: Map<number, Cell>, seenMap: Map<number, number>, size: number,
    radius: number, cover: boolean, px: number, pz: number,
  ): void {
    if (radius <= 0) return;
    const half = size * 0.7072;                 // half diagonal of a cell
    const i0 = Math.floor((px - radius) / size), i1 = Math.floor((px + radius) / size);
    const j0 = Math.floor((pz - radius) / size), j1 = Math.floor((pz + radius) / size);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const ccx = (i + 0.5) * size, ccz = (j + 0.5) * size;
        const d = Math.max(0, Math.hypot(ccx - px, ccz - pz) - half);
        const want = cover ? (d < radius ? 0 : -1) : bandFor(d);
        if (want < 0) continue;
        const key = plantKey(i, j);
        seenMap.set(key, stamp);
        let cell = map.get(key);
        if (!cell) { cell = makeCell(i, j); map.set(key, cell); }
        cell.dist = d;
        if (cell.band !== want && !cell.queued) {
          // `band` doubles as the wanted band until the cell is processed.
          cell.band = want;
          cell.queued = true;
          queue.push(cell);
        } else if (!cell.queued) {
          cell.band = want;
        }
      }
    }
    // Release anything the sweep did not touch.
    for (const [key, cell] of map) {
      if (seenMap.get(key) === stamp) continue;
      unplace(cell);
      map.delete(key);
      seenMap.delete(key);
    }
  }

  // ---- publish -------------------------------------------------------------
  ctx.emit("palmas:vegetation-ready", {
    layers: layers.length,
    triangles: totalTris,
    atlas: tier.atlas,
  });

  const windDir = new THREE.Vector2(0.82, 0.57).normalize();
  const _px = new THREE.Vector3();
  let lastX = Infinity, lastZ = Infinity;
  let first = true;

  const sys: System = {
    name: "vegetation",

    update(dt, c) {
      // ---- wind ----------------------------------------------------------
      // One slowly veering direction for the whole island, with a long-period
      // strength swell on top of the per-instance gust envelope.
      const t = c.elapsed;
      const veer = 0.62 + Math.sin(t * 0.011) * 0.30 + Math.sin(t * 0.037) * 0.08;
      windDir.set(Math.cos(veer), Math.sin(veer));
      const strength = 0.115 + 0.055 * (0.5 + 0.5 * Math.sin(t * 0.043 + 1.2));
      mats.uTime.value = t;
      mats.uWindParams.value.set(windDir.x, windDir.y, strength, 1);

      // Transmission follows the sun, so fronds only glow when it is low and
      // behind them, and go dark at night.
      const sky = c.services.sky;
      mats.uTransTint.value.setRGB(0.62, 0.92, 0.34);
      if (sky) {
        if (sky.sunColor) mats.uTransTint.value.multiply(sky.sunColor);
        mats.uTransTint.value.multiplyScalar(0.35 + 0.85 * clamp01(sky.daylight ?? 1));
      }

      // ---- streaming -------------------------------------------------------
      _px.copy(c.services.player?.position ?? c.camera.position);
      const moved = Math.hypot(_px.x - lastX, _px.z - lastZ);
      if (first || moved > PLANT_CELL * 0.28) {
        lastX = _px.x; lastZ = _px.z;
        stamp++;
        refreshGrid(plantCells, seen, PLANT_CELL, tier.bands[3], false, _px.x, _px.z);
        refreshGrid(coverCells, coverSeen, COVER_CELL, tier.cover, true, _px.x, _px.z);
        // Nearest first: the cells the player is standing in must never be the
        // ones still waiting behind a queue of distant hillside.
        queue.sort((a, b) => a.dist - b.dist);
        first = false;
      }

      if (queue.length) {
        // A generous first slice, because the world starts empty and an empty
        // world for two seconds looks far worse than one long frame.
        const budget = first ? 12 : tier.budgetMs;
        const t0 = nowMs();
        let guard = 0;
        while (queue.length && guard++ < 512) {
          const cell = queue.shift()!;
          if (!cell.queued) continue;
          processCell(cell, coverCells.get(cell.key) === cell);
          if (nowMs() - t0 > budget) break;
        }
      }

      if (dirty) {
        for (let i = 0; i < layers.length; i++) flushLayer(layers[i]);
        dirty = false;
      }
    },

    dispose() {
      ctx.scene.remove(root);
      for (const l of layers) {
        l.mesh.geometry.dispose();
        l.mesh.dispose();
      }
      mats.dispose();
      atlas.dispose();
      plantCells.clear();
      coverCells.clear();
      queue.length = 0;
    },
  };

  return sys;
};

export default createVegetation;





