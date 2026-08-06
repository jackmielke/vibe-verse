/**
 * DROP ZERO — vegetation.
 *
 * Everything on the island that grows. Six tree species (hero oak, broadleaf,
 * birch, two conifers and a coconut palm), the shrub layer under them, ferns
 * and flowers, reeds and cattails at the waterline, mossy boulders, and a
 * dense grass field that follows the camera. No service is published — this
 * module reads the world and plants it.
 *
 * Five pieces, in dependency order:
 *
 *  1. THE ATLAS. One canvas atlas carries every leaf, needle, frond, bark and
 *     blade the module will ever draw: sixteen cells, painted with Canvas2D
 *     paths for the organic shapes and written per-texel from tileable noise
 *     for the four barks (a bark that does not wrap shows a seam straight down
 *     the trunk, and it is the first thing anyone notices). The library's own
 *     `leafCluster` and `grassBlade` sprites are composited in underneath the
 *     hand-painted foliage, so the canopies and the ground cover share their
 *     colour identity with the rest of the island. The buffer is then
 *     RGB-dilated into its transparent margins — untouched transparent texels
 *     are (0,0,0,0) and a mip chain averages that black straight into the leaf
 *     edges, which is where the classic dark halo around web-game foliage
 *     comes from — Sobel'd into a normal map and re-read into roughness.
 *     NO EXTERNAL ASSETS, per the repo rule: every texel here is computed.
 *
 *  2. THE PLANTS. Real geometry. Trunks are swept tubes with a running frame,
 *     so a leaning trunk keeps a circular section perpendicular to its own
 *     axis instead of shearing into an ellipse, and they carry a root flare
 *     where they meet the ground — the contact point is exactly where a
 *     procedural tree usually betrays itself. Branches recurse, tapering, each
 *     one lifting toward the light as it goes out. Canopies are clustered leaf
 *     cards and clumped low-poly blobs seated on an ellipsoid shell with their
 *     normals blended 70 % toward the shell normal; that single trick is the
 *     difference between a canopy and a pile of quads, because it makes the
 *     whole mass shade as one round object.
 *
 *  3. THE MATERIAL. One `MeshStandardMaterial` for every plant in the world
 *     (`scene.environment` only lights Standard/Physical in r160), alpha
 *     tested, double sided, with three injections through `onBeforeCompile`:
 *       • VERTEX WIND — per-instance phase and compliance, a gust front that
 *         travels across the island in world space so the whole treeline
 *         ripples rather than breathing in place, trunks swaying quadratically
 *         with height and leaves fluttering along their own length. Wind is
 *         the difference between a live world and a photograph of one.
 *       • BACK-LIT TRANSMISSION — forward scatter plus a wrap term, keyed off
 *         the sun. The far side of a canopy with the sun behind it should
 *         glow; a canopy that only ever gets darker as it turns away from the
 *         key light reads as a dark green blob, which is the single loudest
 *         "this is a Three.js demo" tell foliage has.
 *       • AN ORDERED-DITHER DISTANCE FADE, so ground cover and the far LOD
 *         dissolve instead of popping. It writes depth and needs no sorting.
 *     A matching `MeshDepthMaterial` carries the same wind into the shadow
 *     map — without it every plant casts the shadow of a plant standing still.
 *
 *  4. THE PLACEMENT RULES. Species are chosen by altitude, slope and the
 *     terrain's own surface splat: palms only on shoreline sand, conifers on
 *     the highland shoulders, broadleaf and the hero oak on the plains, reeds
 *     where the water meets the land, scrub and moss on the cliffs. Nothing is
 *     placed inside a POI footprint or on a road — the road splines are
 *     reproduced from `pois.ts` exactly, because the value of the test is that
 *     it rejects the ground the carriageway actually occupies.
 *
 *  5. THE STREAMER. Nothing is placed at boot. Two grids of cells — 96 m for
 *     plants, 24 m for grass — generate their contents from a cell-seeded RNG
 *     the first time the camera comes near, on a per-frame instance budget.
 *     Instances live in slot pools with swap-with-last compaction, so a cell
 *     leaving the radius costs O(its own instances) and the GPU never sees a
 *     hole in the buffer. Tens of thousands of plants, ~40 draw calls.
 *
 * Trunks inside the collider band register an `addBox` with `harvest: "wood"`
 * so the pickaxe can fell them. Canopies never do: bullets pass through
 * leaves, and a canopy collider would make every treeline a bullet sponge.
 *
 * Reads `materials`, `terrain`, `collision`, `pois` and `sky`, all lazily and
 * all null-checked. Boot order is a guarantee about ordering, not about
 * success, and vegetation must never be the reason the world fails to come up.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre.
 */
import * as THREE from "three";
import {
  makeRng,
  type CollisionService,
  type MaterialsService,
  type Poi,
  type QualityTier,
  type SkyService,
  type System,
  type SystemFactory,
  type TerrainService,
  type WorldCtx,
} from "../types";

/* ------------------------------------------------------------------------ *
 * Contract shims
 *
 * `types.ts` belongs to the whole world while it is compiling, so the extras
 * terrain publishes beyond `TerrainService` are read structurally. Every one
 * is optional and every one has a working fallback — this module degrades, it
 * does not throw.
 * ------------------------------------------------------------------------ */

type TerrainLike = TerrainService & {
  /** 0 = flat, 1 = vertical. `1 - normal.y`. */
  slopeAt?(x: number, z: number): number;
  /** Signed metres to the coastline, positive inland. */
  coastDistanceAt?(x: number, z: number): number;
  /** Metres of water above the ground, 0 on land. */
  waterDepthAt?(x: number, z: number): number;
  /** Baked macro AO, 0..1. Darkens plants sitting in gullies. */
  aoAt?(x: number, z: number): number;
  /** Normalised [sand, grass, dirt, rock] cover. */
  surfaceWeightsAt?(x: number, z: number, out?: Float32Array): Float32Array;
  readonly islandRadius?: number;
};

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

const TAU = Math.PI * 2;

/** Plant streaming cell, metres. Big enough that a cell is a decent unit of
 *  work, small enough that one generating cell never blows the frame. */
const PLANT_CELL = 96;
/** Ground-cover cell. Grass turns over constantly, so its cells are small. */
const GRASS_CELL = 24;

/**
 * Alpha cutoff for every plant surface.
 *
 * Low enough that a mip-shrunk leaf keeps its shape at distance, high enough
 * that the dilated margin around a leaf never shows as a grey fringe. Moving
 * it much either way costs one of those two things.
 */
const ALPHA_TEST = 0.38;

/** Atlas layout. Square grid, so a cell is `size / ATLAS_COLS` on a side. */
const ATLAS_COLS = 4;
const ATLAS_ROWS = 4;
/**
 * Fraction of a cell left blank around its content.
 *
 * Mip level 4 of a 1024 atlas averages 16 px blocks; without a margin that
 * block straddles two cells and a birch leaf grows a strip of bark down one
 * side at 200 m.
 */
const CELL_INSET = 0.035;

interface VegTier {
  /** Atlas edge in texels. */
  atlas: number;
  aniso: number;
  /** Multiplier on every scattered count. */
  density: number;
  /** Radius the plant grid streams to, metres. */
  plantRadius: number;
  /** Radius the grass grid streams to. */
  grassRadius: number;
  /** LOD band radii: [full → mid, mid → impostor]. */
  bands: [number, number];
  /** Trunk colliders are only registered inside this radius. */
  colliderRadius: number;
  /** Cross-sections around a trunk. 5 is the floor before it reads faceted. */
  trunkSides: number;
  /** Rings along a trunk sweep. Buys the lean and the root flare. */
  trunkRings: number;
  /** Distinct geometry variants baked per species. */
  variants: number;
  /** Plants cast shadows at all. */
  shadows: boolean;
  /** Instances the streamer may place in one frame. */
  budget: number;
  /** Extra canopy detail cards, bud clusters, hanging moss. */
  trim: boolean;
}

/**
 * `high` is the tier the world is authored against — everything else is that
 * one scaled. The lever that actually moves the frame time is `plantRadius`
 * (area, so quadratic) followed by `density`; atlas size costs boot time and
 * VRAM but almost no frame time.
 */
const TIERS: Record<QualityTier, VegTier> = {
  low: {
    atlas: 512, aniso: 1, density: 0.34, plantRadius: 260, grassRadius: 34,
    bands: [58, 130], colliderRadius: 140, trunkSides: 5, trunkRings: 4,
    variants: 1, shadows: false, budget: 220, trim: false,
  },
  medium: {
    atlas: 1024, aniso: 4, density: 0.62, plantRadius: 380, grassRadius: 54,
    bands: [82, 190], colliderRadius: 190, trunkSides: 6, trunkRings: 5,
    variants: 2, shadows: true, budget: 380, trim: false,
  },
  high: {
    atlas: 1024, aniso: 8, density: 1, plantRadius: 540, grassRadius: 82,
    bands: [105, 250], colliderRadius: 230, trunkSides: 7, trunkRings: 6,
    variants: 3, shadows: true, budget: 600, trim: true,
  },
  ultra: {
    // Deliberately not 2048. A cell would be 512 px, and nothing samples a
    // leaf card at more than about 100 px on screen — the extra texels buy
    // nothing but a 1.2 s synchronous stall on the loading screen while the
    // dilate and Sobel passes chew through four times the pixels. Ultra
    // spends its budget where it shows: radius, density and variants.
    atlas: 1024, aniso: 16, density: 1.34, plantRadius: 720, grassRadius: 108,
    bands: [140, 330], colliderRadius: 270, trunkSides: 9, trunkRings: 8,
    variants: 3, shadows: true, budget: 900, trim: true,
  },
};

/**
 * The road network, mirrored from `pois.ts`.
 *
 * Same pairs, same bow, same width, same centripetal Catmull-Rom at tension
 * 0.5 — reproduced rather than imported because systems here never import each
 * other. The whole value of the test is that it rejects the ground the
 * carriageway actually covers; if the road module is ever re-tuned this table
 * has to move with it.
 */
const ROAD_LINKS: ReadonlyArray<readonly [string, string, number, number]> = [
  ["Neon Heights", "Lonely Lookout", 90, 13],
  ["Neon Heights", "Mill Hollow", -120, 15],
  ["Neon Heights", "Foundry Flats", 150, 15],
  ["Foundry Flats", "Vista Villa", -70, 13],
  ["Foundry Flats", "Salt Harbor", 60, 13],
  ["Foundry Flats", "Signal Summit", -90, 13],
  ["Signal Summit", "Broken Basilica", 70, 11],
  ["Signal Summit", "Timber Tents", -80, 11],
  ["Broken Basilica", "Mill Hollow", 40, 11],
  ["Broken Basilica", "Stonewall Stand", -50, 9],
];

/** Metres of clear verge either side of the carriageway edge. Trees on the
 *  kerb look placed; trees set back look like the road was cut through them. */
const ROAD_VERGE = 5.5;

/* ------------------------------------------------------------------------ *
 * Small maths
 * ------------------------------------------------------------------------ */

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Integer hash → 0..1. Used by every tileable field below. */
function hash2(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1274126177) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Tileable value noise on a lattice of `period` cells across the unit square.
 * Tileable is not a nicety here: every bark cell wraps around a trunk, and a
 * non-tiling field puts a hard vertical seam down one side of every tree.
 */
function vnoise(u: number, v: number, pu: number, pv: number, seed: number): number {
  const x = u * pu, y = v * pv;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const wrap = (i: number, n: number) => ((i % n) + n) % n;
  const x0 = wrap(ix, pu), x1 = wrap(ix + 1, pu);
  const y0 = wrap(iy, pv), y1 = wrap(iy + 1, pv);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

/**
 * Anisotropic tileable fBm. Bark wants features long in one axis and short in
 * the other — a furrow runs up the trunk, it does not run round it — so the
 * two periods are independent.
 */
function fbmA(u: number, v: number, pu: number, pv: number, oct: number, seed: number): number {
  let sum = 0, amp = 0.5, norm = 0;
  let au = pu, av = pv;
  for (let i = 0; i < oct; i++) {
    sum += vnoise(u, v, Math.max(1, Math.round(au)), Math.max(1, Math.round(av)), seed + i * 71) * amp;
    norm += amp;
    au *= 2; av *= 2; amp *= 0.5;
  }
  return sum / norm;
}

/** Ridged variant — the sharp crest is what makes a furrow read as a furrow. */
function ridgedA(u: number, v: number, pu: number, pv: number, oct: number, seed: number): number {
  let sum = 0, amp = 0.5, norm = 0;
  let au = pu, av = pv;
  for (let i = 0; i < oct; i++) {
    const n = vnoise(u, v, Math.max(1, Math.round(au)), Math.max(1, Math.round(av)), seed + i * 131);
    sum += (1 - Math.abs(n * 2 - 1)) * amp;
    norm += amp;
    au *= 2; av *= 2; amp *= 0.5;
  }
  return sum / norm;
}

/** Tileable Worley F1, for bark plates and lichen blotches. */
function worleyT(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells, y = v * cells;
  const ix = Math.floor(x), iy = Math.floor(y);
  let best = 4;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = ix + i, gy = iy + j;
      const wx = ((gx % cells) + cells) % cells;
      const wy = ((gy % cells) + cells) % cells;
      const px = gx + hash2(wx, wy, seed);
      const py = gy + hash2(wx, wy, seed + 4001);
      const dx = px - x, dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best));
}

/* ------------------------------------------------------------------------ *
 * The atlas
 * ------------------------------------------------------------------------ */

/** Foliage cells. */
const C_BROAD = 0;      // clustered broadleaf spray
const C_OAK = 1;        // heavier, darker, lobed oak clump
const C_NEEDLE = 2;     // conifer needle spray
const C_BIRCH = 3;      // small round birch leaves, pale
const C_FROND = 4;      // coconut palm frond
const C_FERN = 5;       // fern frond
const C_GRASS = 6;      // grass blade card
const C_REED = 7;       // reeds with a cattail head
const C_FLOWER = 8;     // wildflower cluster
const C_BARK_OAK = 9;
const C_BARK_PINE = 10;
const C_BARK_BIRCH = 11;
const C_BARK_PALM = 12;
const C_MOSS = 13;
const C_IMP_BROAD = 14; // impostor silhouette, broadleaf
const C_IMP_CONIF = 15; // impostor silhouette, conifer

const BARK_CELLS = [C_BARK_OAK, C_BARK_PINE, C_BARK_BIRCH, C_BARK_PALM];

/**
 * Per-cell roughness floor and ceiling.
 *
 * Uniform roughness is the fastest way to make a whole world look like
 * plastic, and foliage is where it shows worst: a waxy broadleaf and a dry
 * grass blade are not the same surface. The ceiling is what the darkest texel
 * of the cell gets, the floor what the brightest gets — leaves are glossier
 * where the cuticle catches the light.
 */
const CELL_ROUGH: Array<[number, number]> = [
  [0.52, 0.86], // broadleaf: waxy on the highlights
  [0.58, 0.90], // oak
  [0.46, 0.80], // needles: the shiniest thing in the canopy
  [0.50, 0.84], // birch
  [0.44, 0.78], // palm frond, very waxy
  [0.62, 0.92], // fern
  [0.66, 0.95], // grass, matte
  [0.60, 0.94], // reed
  [0.55, 0.90], // flower
  [0.82, 0.99], // oak bark
  [0.78, 0.98], // pine bark
  [0.70, 0.94], // birch bark: papery, a little sheen
  [0.80, 0.99], // palm bark
  [0.74, 0.98], // moss
  [0.80, 0.95], // impostors are lit flat; keep them out of the specular
  [0.80, 0.95],
];

/** Normal-map relief per cell, in Sobel gain. Bark carries the deep stuff. */
const CELL_RELIEF = [
  1.5, 1.7, 1.2, 1.3, 1.6, 1.4, 0.9, 1.0, 1.1, 4.2, 4.8, 2.4, 4.0, 2.6, 0.6, 0.6,
];

type G2 = CanvasRenderingContext2D;

const css = (r: number, g: number, b: number, a = 1): string =>
  `rgba(${Math.round(clamp01(r) * 255)},${Math.round(clamp01(g) * 255)},${Math.round(clamp01(b) * 255)},${a})`;

/** UV rect of a cell's inner (inset) box, in the flipped-V atlas. */
function cellUV(cell: number): { u0: number; v0: number; du: number; dv: number } {
  const col = cell % ATLAS_COLS;
  const row = Math.floor(cell / ATLAS_COLS);
  const cs = 1 / ATLAS_COLS;
  const inset = cs * CELL_INSET;
  const inner = cs - inset * 2;
  // Rows are flipped: the atlas buffer is written bottom-up so that texture V
  // and the painter's +Y agree.
  const rowF = ATLAS_ROWS - 1 - row;
  return { u0: col * cs + inset, v0: rowF * cs + inset, du: inner, dv: inner };
}

/**
 * Draw one cell in a normalised, Y-UP box inset from the cell edge.
 *
 * Everything inside `draw` works in [0,1]² with +Y up, so a leaf painter reads
 * the same way the geometry that will sample it does.
 */
function paintCell(g: G2, size: number, cell: number, draw: (g: G2) => void): void {
  const cs = size / ATLAS_COLS;
  const cx = (cell % ATLAS_COLS) * cs;
  const cy = Math.floor(cell / ATLAS_COLS) * cs;
  const inset = cs * CELL_INSET;
  const inner = cs - inset * 2;
  g.save();
  g.beginPath();
  g.rect(cx, cy, cs, cs);
  g.clip();
  g.translate(cx + inset, cy + inset + inner);
  g.scale(inner, -inner);
  g.lineJoin = "round";
  g.lineCap = "round";
  draw(g);
  g.restore();
}

/**
 * One leaf blade, as a path, from base to tip in +Y.
 *
 * `bow` bends the midrib sideways so a spray never reads as a fan of identical
 * mirrored blades; `waist` is where the blade is at its widest, which is the
 * single parameter that separates a willow (0.35) from an oak leaf (0.55).
 */
function leafPath(g: G2, len: number, wid: number, bow: number, waist: number, tip: number): void {
  const mx = bow * len;
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(wid * 0.9, len * waist * 0.5, mx + wid, len * waist, mx + wid * tip, len * 0.86);
  g.quadraticCurveTo(mx + wid * 0.22, len * 0.98, mx * 1.04, len);
  g.quadraticCurveTo(mx - wid * 0.22, len * 0.98, mx - wid * tip, len * 0.86);
  g.bezierCurveTo(mx - wid, len * waist, -wid * 0.9, len * waist * 0.5, 0, 0);
  g.closePath();
}

interface LeafStyle {
  /** Blades per cluster. */
  count: number;
  len: [number, number];
  /** Width as a fraction of length. */
  wid: [number, number];
  waist: number;
  tip: number;
  bow: number;
  /** Base hue in HSL-ish terms, expressed as an RGB triple at full light. */
  lit: [number, number, number];
  shade: [number, number, number];
  /** Radius of the cluster the blades radiate from. */
  spread: number;
  /** Serrated edge — oak and birch have one, a palm does not. */
  serrate: number;
  /** Visible midrib strength. */
  rib: number;
}

/**
 * The generic leaf-mass painter.
 *
 * Every broadleaf cell in the atlas comes out of this with different numbers.
 * The important part is not the shapes, it is the *value ramp*: blades near
 * the middle of the cluster are painted with the shade colour and blades near
 * the rim with the lit colour, which bakes a soft internal occlusion into the
 * card. A canopy of cards with uniformly-lit leaves has no interior and looks
 * like cut paper no matter how good the lighting is.
 */
function paintLeafMass(g: G2, rnd: () => number, s: LeafStyle): void {
  const cx = 0.5, cy = 0.5;
  // Two passes: a dark under-layer offset down and in, then the lit layer.
  for (let pass = 0; pass < 2; pass++) {
    const n = pass === 0 ? Math.round(s.count * 0.55) : s.count;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rnd() * 0.9;
      const rr = s.spread * (pass === 0 ? 0.42 : 0.35 + rnd() * 0.75);
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr * 0.92;
      const len = lerp(s.len[0], s.len[1], rnd());
      const wid = len * lerp(s.wid[0], s.wid[1], rnd());
      // Rim leaves catch the light; interior leaves sit in the mass's shadow.
      const rim = clamp01(rr / (s.spread * 1.05));
      const k = pass === 0 ? 0 : rim * rim * (0.55 + rnd() * 0.45);
      const cr = lerp(s.shade[0], s.lit[0], k);
      const cg = lerp(s.shade[1], s.lit[1], k);
      const cb = lerp(s.shade[2], s.lit[2], k);

      g.save();
      g.translate(px, py);
      g.rotate(a - Math.PI * 0.5 + (rnd() - 0.5) * 0.8);
      g.fillStyle = css(cr, cg, cb);
      leafPath(g, len, wid, (rnd() - 0.5) * s.bow, s.waist, s.tip);
      g.fill();

      if (s.serrate > 0.01) {
        // Notches cut back into the blade. Drawn as erasures so the silhouette
        // itself is broken — a serration painted *on* the leaf is invisible at
        // 40 m, one cut out of it survives all the way to the impostor.
        g.save();
        g.globalCompositeOperation = "destination-out";
        const notches = 3 + Math.floor(rnd() * 3);
        for (let q = 0; q < notches; q++) {
          const t = 0.22 + (q / notches) * 0.62;
          const side = q % 2 === 0 ? 1 : -1;
          g.beginPath();
          g.ellipse(side * wid * 0.95, len * t, wid * 0.34 * s.serrate, len * 0.10 * s.serrate, 0, 0, TAU);
          g.fill();
        }
        g.restore();
      }

      if (s.rib > 0.01) {
        g.strokeStyle = css(cr * 1.28 + 0.04, cg * 1.22 + 0.05, cb * 1.1, 0.55 * s.rib);
        g.lineWidth = Math.max(0.0016, len * 0.018);
        g.beginPath();
        g.moveTo(0, len * 0.02);
        g.lineTo(0, len * 0.94);
        g.stroke();
        // Two pairs of side veins. Cheap, and they hold up in the near LOD.
        for (const t of [0.32, 0.58]) {
          for (const side of [-1, 1]) {
            g.beginPath();
            g.moveTo(0, len * t);
            g.quadraticCurveTo(side * wid * 0.5, len * (t + 0.10), side * wid * 0.85, len * (t + 0.20));
            g.stroke();
          }
        }
      }
      g.restore();
    }
  }
}

/** A conifer spray: a woody twig with needles combed back along it. */
function paintNeedles(g: G2, rnd: () => number): void {
  // The twig first, so needles overlap it.
  g.strokeStyle = css(0.24, 0.17, 0.11);
  g.lineWidth = 0.012;
  g.beginPath();
  g.moveTo(0.5, 0.02);
  g.quadraticCurveTo(0.53, 0.5, 0.5, 0.97);
  g.stroke();

  for (let i = 0; i < 72; i++) {
    const t = 0.04 + (i / 72) * 0.93;
    const side = i % 2 === 0 ? 1 : -1;
    // Needles sweep from 70° at the base to 30° at the tip: the whole spray
    // then reads as a shuttlecock rather than a bottle brush.
    const sweep = lerp(1.22, 0.52, t) + (rnd() - 0.5) * 0.22;
    const len = lerp(0.30, 0.13, t) * (0.75 + rnd() * 0.5);
    const dark = 0.42 + rnd() * 0.5;
    const x0 = 0.5 + (t - 0.5) * 0.06;
    g.save();
    g.translate(x0, t);
    g.rotate(-side * sweep);
    const grad = g.createLinearGradient(0, 0, 0, len);
    grad.addColorStop(0, css(0.10 * dark + 0.02, 0.22 * dark + 0.05, 0.09 * dark + 0.02));
    grad.addColorStop(0.6, css(0.20 * dark, 0.40 * dark + 0.06, 0.16 * dark));
    grad.addColorStop(1, css(0.34 * dark + 0.06, 0.58 * dark + 0.12, 0.24 * dark + 0.04));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(-0.006, 0);
    g.quadraticCurveTo(-0.004, len * 0.6, 0, len);
    g.quadraticCurveTo(0.004, len * 0.6, 0.006, 0);
    g.closePath();
    g.fill();
    g.restore();
  }

  // A handful of green cones near the top. Tiny, but they are the detail that
  // reads as "this is a spruce" instead of "this is generic foliage".
  for (let i = 0; i < 3; i++) {
    const x = 0.32 + rnd() * 0.36, y = 0.62 + rnd() * 0.28;
    g.save();
    g.translate(x, y);
    g.rotate((rnd() - 0.5) * 0.6);
    const grad = g.createLinearGradient(0, 0, 0, 0.14);
    grad.addColorStop(0, css(0.28, 0.20, 0.10));
    grad.addColorStop(1, css(0.46, 0.34, 0.16));
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(0, 0.07, 0.026, 0.07, 0, 0, TAU);
    g.fill();
    g.restore();
  }
}

/** A coconut frond, painted flat: the geometry supplies the arch. */
function paintFrond(g: G2, rnd: () => number): void {
  g.strokeStyle = css(0.34, 0.30, 0.14);
  g.lineWidth = 0.02;
  g.beginPath();
  g.moveTo(0.5, 0.0);
  g.quadraticCurveTo(0.5, 0.5, 0.5, 1.0);
  g.stroke();

  const N = 42;
  for (let i = 0; i < N; i++) {
    const t = 0.05 + (i / N) * 0.93;
    const side = i % 2 === 0 ? 1 : -1;
    // Leaflets stand off the rachis at 62° near the base and 24° at the tip.
    const ang = lerp(1.08, 0.42, t) + (rnd() - 0.5) * 0.13;
    // Longest at a third of the way up, tapering hard to the tip.
    const env = Math.sin(Math.pow(t, 0.62) * Math.PI) * (0.62 + 0.38 * (1 - t));
    const len = 0.40 * env * (0.86 + rnd() * 0.26);
    const wid = len * 0.075;
    const dry = rnd() < 0.10 ? 1 : 0;
    const v = 0.7 + rnd() * 0.4;

    g.save();
    g.translate(0.5, t);
    g.rotate(-side * ang);
    const grad = g.createLinearGradient(0, 0, 0, len);
    if (dry) {
      grad.addColorStop(0, css(0.36 * v, 0.30 * v, 0.13 * v));
      grad.addColorStop(1, css(0.62 * v, 0.52 * v, 0.24 * v));
    } else {
      grad.addColorStop(0, css(0.07 * v, 0.20 * v, 0.06 * v));
      grad.addColorStop(0.5, css(0.17 * v, 0.38 * v, 0.11 * v));
      grad.addColorStop(1, css(0.34 * v, 0.60 * v, 0.20 * v));
    }
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(wid * 1.6, len * 0.42, 0, len);
    g.quadraticCurveTo(-wid * 1.6, len * 0.42, 0, 0);
    g.fill();
    // Split tips: real coconut leaflets tear along the midrib in the wind.
    if (rnd() < 0.3) {
      g.save();
      g.globalCompositeOperation = "destination-out";
      g.lineWidth = 0.004;
      g.strokeStyle = "#000";
      g.beginPath();
      g.moveTo(0, len * 0.62);
      g.lineTo(0, len);
      g.stroke();
      g.restore();
    }
    g.restore();
  }
}

/** A fern frond: pinnae that are themselves lobed. */
function paintFern(g: G2, rnd: () => number): void {
  g.strokeStyle = css(0.26, 0.32, 0.12);
  g.lineWidth = 0.014;
  g.beginPath();
  g.moveTo(0.5, 0.02);
  g.quadraticCurveTo(0.52, 0.55, 0.5, 0.98);
  g.stroke();

  const N = 26;
  for (let i = 0; i < N; i++) {
    const t = 0.05 + (i / N) * 0.92;
    const side = i % 2 === 0 ? 1 : -1;
    const env = Math.sin(Math.pow(t, 0.7) * Math.PI * 0.98);
    const len = 0.34 * env * (0.85 + rnd() * 0.3);
    const v = 0.72 + rnd() * 0.42;
    g.save();
    g.translate(0.5, t);
    g.rotate(-side * (0.95 - t * 0.35));
    g.fillStyle = css(0.13 * v, 0.30 * v, 0.09 * v);
    // Pinna outline, with lobes cut along the leading edge.
    g.beginPath();
    g.moveTo(0, 0);
    const lobes = 5;
    for (let k = 1; k <= lobes; k++) {
      const s = k / lobes;
      const w = len * 0.20 * (1 - s * 0.7);
      g.quadraticCurveTo(w * 1.7, len * (s - 0.5 / lobes), w * 0.55, len * s);
    }
    for (let k = lobes; k >= 1; k--) {
      const s = k / lobes;
      const w = len * 0.20 * (1 - s * 0.7);
      g.quadraticCurveTo(-w * 1.7, len * (s - 0.5 / lobes), -w * 0.55, len * (s - 1 / lobes));
    }
    g.closePath();
    g.fill();
    g.strokeStyle = css(0.26 * v, 0.48 * v, 0.16 * v, 0.7);
    g.lineWidth = 0.0035;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(0, len * 0.95);
    g.stroke();
    g.restore();
  }
}

/** Grass card: five blades, tapering, dark at the root. */
function paintGrassCard(g: G2, rnd: () => number): void {
  for (let i = 0; i < 5; i++) {
    const x0 = 0.12 + i * 0.19 + (rnd() - 0.5) * 0.05;
    const h = 0.62 + rnd() * 0.36;
    const lean = (x0 - 0.5) * 0.5 + (rnd() - 0.5) * 0.18;
    const w = 0.028 * (0.7 + rnd() * 0.6);
    const tone = 0.78 + rnd() * 0.44;
    const dry = rnd() < 0.18;
    const grad = g.createLinearGradient(0, 0, 0, h);
    if (dry) {
      grad.addColorStop(0, css(0.14 * tone, 0.16 * tone, 0.06 * tone));
      grad.addColorStop(0.6, css(0.40 * tone, 0.38 * tone, 0.16 * tone));
      grad.addColorStop(1, css(0.66 * tone, 0.60 * tone, 0.28 * tone));
    } else {
      grad.addColorStop(0, css(0.07 * tone, 0.15 * tone, 0.05 * tone));
      grad.addColorStop(0.55, css(0.19 * tone, 0.40 * tone, 0.11 * tone));
      grad.addColorStop(1, css(0.44 * tone, 0.66 * tone, 0.22 * tone));
    }
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x0 - w, 0);
    g.quadraticCurveTo(x0 - w * 0.4 + lean * 0.5, h * 0.5, x0 + lean, h);
    g.quadraticCurveTo(x0 + w * 0.4 + lean * 0.5, h * 0.5, x0 + w, 0);
    g.closePath();
    g.fill();
    // Centre rib: a blade with a fold in it catches a specular line, and that
    // line is what stops a grass field looking like felt.
    g.strokeStyle = "rgba(255,255,255,0.15)";
    g.lineWidth = 0.004;
    g.beginPath();
    g.moveTo(x0, 0.01);
    g.quadraticCurveTo(x0 + lean * 0.5, h * 0.5, x0 + lean, h * 0.97);
    g.stroke();
  }
}

/** Reeds with a cattail head — the waterline card. */
function paintReed(g: G2, rnd: () => number): void {
  for (let i = 0; i < 6; i++) {
    const x0 = 0.14 + i * 0.15 + (rnd() - 0.5) * 0.04;
    const h = 0.55 + rnd() * 0.44;
    const lean = (x0 - 0.5) * 0.7 + (rnd() - 0.5) * 0.12;
    const w = 0.017;
    const tone = 0.8 + rnd() * 0.4;
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, css(0.10 * tone, 0.17 * tone, 0.07 * tone));
    grad.addColorStop(0.7, css(0.28 * tone, 0.42 * tone, 0.15 * tone));
    grad.addColorStop(1, css(0.52 * tone, 0.60 * tone, 0.26 * tone));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x0 - w, 0);
    g.quadraticCurveTo(x0 - w * 0.3 + lean * 0.5, h * 0.55, x0 + lean, h);
    g.quadraticCurveTo(x0 + w * 0.3 + lean * 0.5, h * 0.55, x0 + w, 0);
    g.closePath();
    g.fill();

    // Every third reed carries a cattail. Brown, velvety, slightly bulged.
    if (i % 3 === 1) {
      const hx = x0 + lean, hy = h * 0.72;
      const hh = h * 0.22;
      const cg = g.createLinearGradient(hx - 0.02, 0, hx + 0.02, 0);
      cg.addColorStop(0, css(0.19, 0.11, 0.05));
      cg.addColorStop(0.45, css(0.40, 0.24, 0.10));
      cg.addColorStop(1, css(0.22, 0.13, 0.06));
      g.fillStyle = cg;
      g.beginPath();
      g.ellipse(hx, hy, 0.022, hh * 0.5, lean * 0.4, 0, TAU);
      g.fill();
      // The wisp on top, where the head has gone to seed.
      g.strokeStyle = css(0.52, 0.44, 0.28, 0.8);
      g.lineWidth = 0.006;
      g.beginPath();
      g.moveTo(hx, hy + hh * 0.5);
      g.lineTo(hx + lean * 0.2, hy + hh * 0.5 + 0.06);
      g.stroke();
    }
  }
}

/** A wildflower cluster: foliage first, then blooms of two colours. */
function paintFlower(g: G2, rnd: () => number): void {
  for (let i = 0; i < 16; i++) {
    const a = rnd() * TAU;
    const r = rnd() * 0.3;
    const x = 0.5 + Math.cos(a) * r, y = 0.34 + Math.sin(a) * r * 0.7;
    const len = 0.14 + rnd() * 0.16;
    const v = 0.7 + rnd() * 0.4;
    g.save();
    g.translate(x, y);
    g.rotate((rnd() - 0.5) * 1.4);
    g.fillStyle = css(0.14 * v, 0.30 * v, 0.10 * v);
    leafPath(g, len, len * 0.24, (rnd() - 0.5) * 0.4, 0.45, 0.4);
    g.fill();
    g.restore();
  }
  // Stems.
  const heads: Array<[number, number, number]> = [];
  for (let i = 0; i < 9; i++) {
    const x0 = 0.2 + rnd() * 0.6;
    const h = 0.45 + rnd() * 0.45;
    const lean = (x0 - 0.5) * 0.6;
    g.strokeStyle = css(0.20, 0.36, 0.13);
    g.lineWidth = 0.008;
    g.beginPath();
    g.moveTo(x0, 0.02);
    g.quadraticCurveTo(x0 + lean * 0.4, h * 0.6, x0 + lean, h);
    g.stroke();
    heads.push([x0 + lean, h, rnd()]);
  }
  // Blooms. Two hues only — a meadow with six flower colours reads as a
  // sweet-shop, and the eye reads two as "wildflowers".
  const palette: Array<[number, number, number]> = [
    [0.96, 0.86, 0.34],
    [0.86, 0.42, 0.62],
  ];
  for (const [hx, hy, r] of heads) {
    const col = palette[r < 0.6 ? 0 : 1];
    const petals = 5 + Math.floor(r * 3);
    const rad = 0.035 + r * 0.022;
    for (let p = 0; p < petals; p++) {
      const a = (p / petals) * TAU + r * 2;
      g.save();
      g.translate(hx, hy);
      g.rotate(a);
      g.fillStyle = css(col[0] * (0.82 + r * 0.3), col[1] * (0.82 + r * 0.3), col[2] * (0.82 + r * 0.3));
      g.beginPath();
      g.ellipse(0, rad * 0.7, rad * 0.42, rad * 0.72, 0, 0, TAU);
      g.fill();
      g.restore();
    }
    g.fillStyle = css(0.42, 0.30, 0.08);
    g.beginPath();
    g.arc(hx, hy, rad * 0.34, 0, TAU);
    g.fill();
  }
}

/** Moss: a solid, fuzzy, opaque cell. Used on boulders and root buttresses. */
function paintMoss(g: G2, rnd: () => number): void {
  g.fillStyle = css(0.10, 0.17, 0.07);
  g.fillRect(-0.05, -0.05, 1.1, 1.1);
  for (let i = 0; i < 900; i++) {
    const x = rnd(), y = rnd();
    const v = 0.5 + rnd() * 0.7;
    const s = 0.004 + rnd() * 0.014;
    g.fillStyle = css(0.13 * v, 0.30 * v, 0.09 * v, 0.8);
    g.beginPath();
    g.ellipse(x, y, s, s * (1.4 + rnd()), rnd() * TAU, 0, TAU);
    g.fill();
  }
  // Pale sporophyte tips scattered through it; moss is not one flat green.
  for (let i = 0; i < 140; i++) {
    const x = rnd(), y = rnd();
    g.strokeStyle = css(0.46, 0.52, 0.24, 0.6);
    g.lineWidth = 0.0025;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rnd() - 0.5) * 0.02, y + 0.018 + rnd() * 0.02);
    g.stroke();
  }
}

/**
 * An impostor silhouette.
 *
 * This is what a tree is past the far band: two crossed quads sampling one
 * painted card. It has to carry three things or the treeline dies at distance
 * — a broken outline (clumps, never an ellipse), an internal value ramp (lit
 * top-left, shadowed bottom-right, matching the key), and a visible trunk.
 */
function paintImpostor(g: G2, rnd: () => number, conifer: boolean): void {
  const clumps: Array<[number, number, number]> = [];
  if (conifer) {
    // A spire: whorls that shrink with height, each one a ragged disc.
    const tiers = 9;
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1);
      const y = 0.20 + t * 0.76;
      const r = lerp(0.30, 0.045, Math.pow(t, 0.85));
      const n = Math.max(2, Math.round(6 - t * 3));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * TAU + i * 1.1;
        clumps.push([0.5 + Math.cos(a) * r * 0.72, y + (rnd() - 0.5) * 0.03, r * (0.42 + rnd() * 0.2)]);
      }
    }
  } else {
    // A broad crown: an ellipsoid mass roughened by 30 overlapping clumps.
    for (let i = 0; i < 34; i++) {
      const a = rnd() * TAU;
      const rr = Math.pow(rnd(), 0.55);
      clumps.push([
        0.5 + Math.cos(a) * rr * 0.40,
        0.62 + Math.sin(a) * rr * 0.30,
        0.08 + rnd() * 0.10,
      ]);
    }
  }

  // Trunk, drawn first so the canopy overlaps it.
  const th = conifer ? 0.22 : 0.44;
  const tw = conifer ? 0.020 : 0.026;
  const tg = g.createLinearGradient(0.5 - tw, 0, 0.5 + tw, 0);
  tg.addColorStop(0, css(0.10, 0.07, 0.05));
  tg.addColorStop(0.42, css(0.26, 0.19, 0.13));
  tg.addColorStop(1, css(0.13, 0.09, 0.06));
  g.fillStyle = tg;
  g.beginPath();
  g.moveTo(0.5 - tw * 1.9, 0);
  g.lineTo(0.5 - tw * 0.72, th + 0.1);
  g.lineTo(0.5 + tw * 0.72, th + 0.1);
  g.lineTo(0.5 + tw * 1.9, 0);
  g.closePath();
  g.fill();

  for (const [x, y, r] of clumps) {
    // Key light comes from up and to the left in atlas space; the impostor
    // bakes it because a two-quad cross has no useful normals of its own.
    const k = clamp01(0.5 + (x - 0.5) * -1.1 + (y - 0.6) * 1.5);
    const base: [number, number, number] = conifer ? [0.09, 0.20, 0.10] : [0.11, 0.24, 0.08];
    const lit: [number, number, number] = conifer ? [0.30, 0.47, 0.24] : [0.40, 0.58, 0.22];
    const grad = g.createRadialGradient(x - r * 0.3, y + r * 0.3, r * 0.1, x, y, r);
    grad.addColorStop(0, css(lerp(base[0], lit[0], k), lerp(base[1], lit[1], k), lerp(base[2], lit[2], k), 1));
    grad.addColorStop(0.72, css(lerp(base[0], lit[0], k * 0.5), lerp(base[1], lit[1], k * 0.5), lerp(base[2], lit[2], k * 0.5), 0.96));
    grad.addColorStop(1, css(base[0], base[1], base[2], 0));
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(x, y, r, r * (conifer ? 0.62 : 0.92), 0, 0, TAU);
    g.fill();
  }

  // Cut a few holes through the crown. Sky through a canopy is the cue that
  // sells the impostor as a tree rather than a green lollipop.
  g.save();
  g.globalCompositeOperation = "destination-out";
  for (let i = 0; i < (conifer ? 5 : 8); i++) {
    const a = rnd() * TAU, rr = rnd() * 0.26;
    g.beginPath();
    g.ellipse(0.5 + Math.cos(a) * rr, 0.64 + Math.sin(a) * rr * 0.7, 0.016 + rnd() * 0.024, 0.012 + rnd() * 0.02, rnd() * TAU, 0, TAU);
    g.fill();
  }
  g.restore();
}

/* ---- barks --------------------------------------------------------------- */
//
// Written straight into an ImageData rather than drawn with paths: bark is a
// field, not a shape, and it has to tile in both axes — u wraps the trunk,
// v repeats up it.

type BarkFn = (u: number, v: number, out: Float32Array) => void;

/** Oak: deep vertical furrows broken into short plates. */
const barkOak: BarkFn = (u, v, out) => {
  const furrow = ridgedA(u, v, 9, 2, 3, 11);
  const plate = worleyT(u * 1.0, v * 2.2, 7, 23);
  const grain = fbmA(u, v, 26, 5, 2, 41);
  let k = furrow * 0.62 + plate * 0.28 + grain * 0.10;
  k = Math.pow(clamp01(k), 1.25);
  // Warm mid-brown with a grey lichen cast in the deepest crevices.
  out[0] = lerp(0.10, 0.42, k) + grain * 0.05;
  out[1] = lerp(0.08, 0.34, k) + grain * 0.05;
  out[2] = lerp(0.06, 0.25, k) + grain * 0.04;
  out[3] = k;
};

/** Pine: long straight fissures, red-brown plates flaking off. */
const barkPine: BarkFn = (u, v, out) => {
  const fissure = ridgedA(u, v, 7, 1.6, 3, 71);
  const flake = worleyT(u, v * 1.6, 5, 97);
  const grain = fbmA(u, v, 34, 7, 2, 131);
  let k = fissure * 0.5 + flake * 0.38 + grain * 0.12;
  k = clamp01(k);
  const red = smoothstep(0.45, 0.95, flake);
  out[0] = lerp(0.09, 0.48, k) + red * 0.14;
  out[1] = lerp(0.06, 0.30, k) + red * 0.05;
  out[2] = lerp(0.05, 0.19, k);
  out[3] = k * 0.9 + flake * 0.1;
};

/** Birch: white paper with black lenticel scars and peeling curls. */
const barkBirch: BarkFn = (u, v, out) => {
  const paper = fbmA(u, v, 12, 4, 4, 211);
  // Lenticels: short horizontal dashes, sparse, dark. The single feature that
  // makes a white cylinder read as birch.
  const rowV = Math.floor(v * 22);
  const jitter = hash2(rowV, 3, 307);
  const uu = (u + jitter) % 1;
  const seg = Math.floor(uu * 9);
  const inSeg = hash2(seg, rowV, 401) < 0.34;
  const dv = Math.abs((v * 22 - rowV) - 0.5) * 2;
  const du = Math.abs((uu * 9 - seg) - 0.5) * 2;
  const mark = inSeg ? clamp01(1 - dv * 3.2) * clamp01(1 - Math.pow(du, 3)) : 0;
  const peel = smoothstep(0.62, 0.78, fbmA(u, v, 5, 3, 3, 509));
  const base = 0.78 + paper * 0.22;
  out[0] = base - mark * 0.66 + peel * 0.05;
  out[1] = base * 0.97 - mark * 0.62 + peel * 0.02;
  out[2] = base * 0.92 - mark * 0.58 - peel * 0.03;
  out[3] = 0.45 + mark * 0.28 + peel * 0.35;
};

/** Palm: stacked leaf-scar rings with a fibrous vertical grain. */
const barkPalm: BarkFn = (u, v, out) => {
  const rings = Math.abs(Math.sin(v * Math.PI * 11 + fbmA(u, v, 6, 3, 2, 601) * 1.6));
  const fibre = fbmA(u, v, 40, 6, 3, 617);
  const k = clamp01(rings * 0.6 + fibre * 0.4);
  out[0] = lerp(0.20, 0.52, k);
  out[1] = lerp(0.16, 0.44, k);
  out[2] = lerp(0.11, 0.30, k);
  out[3] = rings * 0.8 + fibre * 0.2;
};

const BARK_FN: Record<number, BarkFn> = {
  [C_BARK_OAK]: barkOak,
  [C_BARK_PINE]: barkPine,
  [C_BARK_BIRCH]: barkBirch,
  [C_BARK_PALM]: barkPalm,
};

/* ---- the bake ------------------------------------------------------------ */

export interface VegAtlas {
  albedo: THREE.DataTexture;
  normal: THREE.DataTexture;
  rough: THREE.DataTexture;
  dispose(): void;
}

function finishTex(tex: THREE.DataTexture, srgb: boolean, aniso: number): THREE.DataTexture {
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Paint, flip, dilate, differentiate.
 *
 * The dilation pass is not optional. A transparent canvas texel is (0,0,0,0);
 * every mip level averages it into the leaf beside it, and by mip 3 the whole
 * canopy has a black rim. Four passes of "borrow the mean of my opaque
 * neighbours" pushes real colour far enough into the margin to survive the
 * chain — and it is confined to the owning cell, so a birch leaf never borrows
 * from the pine bark next door.
 */
function buildAtlas(size: number, aniso: number, rng: () => number, mats?: MaterialsService): VegAtlas | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  g.clearRect(0, 0, size, size);

  const cs = size / ATLAS_COLS;
  const rnd = (): number => rng();

  /**
   * The library's own foliage sprites, composited under the hand-painted
   * cells. Sharing them is what keeps this module's greens in the same family
   * as everything else the island draws — and it is the contract the material
   * service exists to provide.
   */
  const stamp = (cell: number, name: "leafCluster" | "grassBlade", alpha: number, times: number): void => {
    if (!mats) return;
    let src: CanvasImageSource | null = null;
    try {
      const tex = mats.texture(name);
      const img = tex?.image as { width?: number; height?: number } | undefined;
      if (img && typeof img.width === "number" && img.width > 0) src = img as CanvasImageSource;
    } catch {
      /* the library is allowed to have failed; the hand-painted layer stands alone */
    }
    if (!src) return;
    paintCell(g, size, cell, (c) => {
      c.save();
      c.globalAlpha = alpha;
      for (let i = 0; i < times; i++) {
        const s = 0.55 + rnd() * 0.6;
        c.save();
        c.translate(0.5 + (rnd() - 0.5) * 0.36, 0.5 + (rnd() - 0.5) * 0.3);
        c.rotate(rnd() * TAU);
        c.scale(s, -s);
        c.drawImage(src as CanvasImageSource, -0.5, -0.5, 1, 1);
        c.restore();
      }
      c.restore();
    });
  };

  // ---- foliage -----------------------------------------------------------
  stamp(C_BROAD, "leafCluster", 0.85, 3);
  paintCell(g, size, C_BROAD, (c) => paintLeafMass(c, rnd, {
    count: 30, len: [0.16, 0.30], wid: [0.30, 0.46], waist: 0.46, tip: 0.30, bow: 0.24,
    lit: [0.44, 0.66, 0.20], shade: [0.07, 0.18, 0.06], spread: 0.30, serrate: 0, rib: 1,
  }));

  stamp(C_OAK, "leafCluster", 0.7, 4);
  paintCell(g, size, C_OAK, (c) => paintLeafMass(c, rnd, {
    count: 34, len: [0.14, 0.26], wid: [0.42, 0.60], waist: 0.55, tip: 0.42, bow: 0.18,
    lit: [0.34, 0.54, 0.16], shade: [0.05, 0.13, 0.04], spread: 0.32, serrate: 1, rib: 0.9,
  }));

  paintCell(g, size, C_NEEDLE, (c) => paintNeedles(c, rnd));

  stamp(C_BIRCH, "leafCluster", 0.5, 2);
  paintCell(g, size, C_BIRCH, (c) => paintLeafMass(c, rnd, {
    count: 40, len: [0.09, 0.17], wid: [0.62, 0.86], waist: 0.42, tip: 0.30, bow: 0.20,
    lit: [0.60, 0.78, 0.30], shade: [0.12, 0.26, 0.09], spread: 0.31, serrate: 0.7, rib: 0.7,
  }));

  paintCell(g, size, C_FROND, (c) => paintFrond(c, rnd));
  paintCell(g, size, C_FERN, (c) => paintFern(c, rnd));

  stamp(C_GRASS, "grassBlade", 0.9, 1);
  paintCell(g, size, C_GRASS, (c) => paintGrassCard(c, rnd));

  paintCell(g, size, C_REED, (c) => paintReed(c, rnd));
  paintCell(g, size, C_FLOWER, (c) => paintFlower(c, rnd));
  paintCell(g, size, C_MOSS, (c) => paintMoss(c, rnd));
  paintCell(g, size, C_IMP_BROAD, (c) => paintImpostor(c, rnd, false));
  paintCell(g, size, C_IMP_CONIF, (c) => paintImpostor(c, rnd, true));

  // ---- barks, written per texel ------------------------------------------
  //
  // Evaluated at 256² and blown up to the cell size rather than evaluated at
  // full resolution. Each bark texel costs thirty-odd hash lookups, and at a
  // 2048 atlas the honest version is two thirds of a second of boot for
  // detail nobody can resolve — bark noise has no features finer than a
  // millimetre of trunk. The normal map is Sobel'd from the *upscaled*
  // result, so the relief survives the resample; only the grain softens.
  const px = Math.round(cs);
  const bpx = Math.min(256, px);
  const out = new Float32Array(4);
  const scratchCanvas = document.createElement("canvas");
  scratchCanvas.width = bpx;
  scratchCanvas.height = bpx;
  const sg = scratchCanvas.getContext("2d");
  for (const cell of BARK_CELLS) {
    const fn = BARK_FN[cell];
    const img = (sg ?? g).createImageData(bpx, bpx);
    const d = img.data;
    for (let y = 0; y < bpx; y++) {
      for (let x = 0; x < bpx; x++) {
        // The inset margin is filled too — bark cells tile, so their margin is
        // real bark rather than dilated fringe.
        fn((x + 0.5) / bpx, (y + 0.5) / bpx, out);
        const o = (y * bpx + x) * 4;
        d[o] = clamp01(out[0]) * 255;
        d[o + 1] = clamp01(out[1]) * 255;
        d[o + 2] = clamp01(out[2]) * 255;
        d[o + 3] = 255;
      }
    }
    const col = cell % ATLAS_COLS, row = Math.floor(cell / ATLAS_COLS);
    if (sg && bpx !== px) {
      sg.putImageData(img, 0, 0);
      g.drawImage(scratchCanvas, Math.round(col * cs), Math.round(row * cs), px, px);
    } else {
      g.putImageData(img, Math.round(col * cs), Math.round(row * cs));
    }
  }
  scratchCanvas.width = 1;
  scratchCanvas.height = 1;

  // ---- read back, flipped so texture V and the painter's +Y agree ---------
  const raw = g.getImageData(0, 0, size, size).data;
  const alb = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    alb.set(raw.subarray(src, src + size * 4), y * size * 4);
  }

  // ---- dilate, per cell ---------------------------------------------------
  //
  // Frontier flood rather than a full-image sweep per pass: only texels that
  // actually border known colour are ever visited, which is a few per cent of
  // the atlas instead of all of it. At 1024 that is the difference between
  // 300 ms of boot and 30 ms, and the result is identical.
  const csi = Math.round(cs);
  const known = new Uint8Array(size * size);
  for (let i = 0; i < known.length; i++) known[i] = alb[i * 4 + 3] > 8 ? 1 : 0;

  let frontier: number[] = [];
  const inCutoutCell = new Uint8Array(size * size);
  for (let cell = 0; cell < ATLAS_COLS * ATLAS_ROWS; cell++) {
    // Bark and moss are fully opaque, so they have no margin to fill.
    if (BARK_CELLS.indexOf(cell) >= 0 || cell === C_MOSS) continue;
    const col = cell % ATLAS_COLS;
    const rowF = ATLAS_ROWS - 1 - Math.floor(cell / ATLAS_COLS);
    const x0 = col * csi, y0 = rowF * csi;
    for (let y = y0; y < y0 + csi; y++) {
      for (let x = x0; x < x0 + csi; x++) {
        const i = y * size + x;
        // Marks the texel as belonging to a cell that has a cutout margin to
        // fill, so the flood can reject a neighbour without re-deriving which
        // cell it is in.
        inCutoutCell[i] = 1;
        if (known[i]) continue;
        if (
          (x > x0 && known[i - 1]) || (x < x0 + csi - 1 && known[i + 1]) ||
          (y > y0 && known[i - size]) || (y < y0 + csi - 1 && known[i + size])
        ) {
          frontier.push(i);
        }
      }
    }
  }

  for (let pass = 0; pass < 4 && frontier.length > 0; pass++) {
    const next: number[] = [];
    // Two-phase: read every frontier texel against the *old* known set, then
    // commit. Filling in place would let a texel borrow from another texel
    // filled a moment earlier in the same pass and the colour would smear
    // along the scan direction.
    const vals = new Float32Array(frontier.length * 3);
    const got = new Uint8Array(frontier.length);
    for (let f = 0; f < frontier.length; f++) {
      const i = frontier[f];
      const x = i % size, y = (i - x) / size;
      let r = 0, g2 = 0, b2 = 0, n = 0;
      for (let j = -1; j <= 1; j++) {
        for (let k = -1; k <= 1; k++) {
          const nx = x + k, ny = y + j;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const ni = ny * size + nx;
          // Cell-local: a birch leaf must never borrow colour from the pine
          // bark in the cell next door.
          if (!inCutoutCell[ni] || !known[ni]) continue;
          if (Math.floor(nx / csi) !== Math.floor(x / csi)) continue;
          if (Math.floor(ny / csi) !== Math.floor(y / csi)) continue;
          const no = ni * 4;
          r += alb[no]; g2 += alb[no + 1]; b2 += alb[no + 2]; n++;
        }
      }
      if (n === 0) continue;
      vals[f * 3] = r / n;
      vals[f * 3 + 1] = g2 / n;
      vals[f * 3 + 2] = b2 / n;
      got[f] = 1;
    }
    for (let f = 0; f < frontier.length; f++) {
      const i = frontier[f];
      if (!got[f]) continue;
      const o = i * 4;
      alb[o] = vals[f * 3];
      alb[o + 1] = vals[f * 3 + 1];
      alb[o + 2] = vals[f * 3 + 2];
      // Alpha stays where it was: this is colour bleed for the mip chain, not
      // a widening of the cutout.
      known[i] = 1;
    }
    for (let f = 0; f < frontier.length; f++) {
      const i = frontier[f];
      if (!known[i]) continue;
      const x = i % size, y = (i - x) / size;
      const cxi = Math.floor(x / csi), cyi = Math.floor(y / csi);
      for (const ni of [i - 1, i + 1, i - size, i + size]) {
        if (ni < 0 || ni >= known.length || known[ni] || !inCutoutCell[ni]) continue;
        const nx2 = ni % size, ny2 = (ni - nx2) / size;
        if (Math.floor(nx2 / csi) !== cxi || Math.floor(ny2 / csi) !== cyi) continue;
        known[ni] = 2;          // queued; cleared back to 0 below
        next.push(ni);
      }
    }
    for (const i of next) known[i] = 0;
    frontier = next;
  }

  // ---- normal + roughness -------------------------------------------------
  const nrm = new Uint8Array(size * size * 4);
  const rgh = new Uint8Array(size * size * 4);
  const lum = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    // Alpha-weighted luminance: a transparent texel must not carve a cliff
    // into the height field at the leaf edge.
    const a = alb[o + 3] / 255;
    lum[i] = ((alb[o] * 0.30 + alb[o + 1] * 0.59 + alb[o + 2] * 0.11) / 255) * a;
  }

  for (let cell = 0; cell < ATLAS_COLS * ATLAS_ROWS; cell++) {
    const col = cell % ATLAS_COLS;
    const rowF = ATLAS_ROWS - 1 - Math.floor(cell / ATLAS_COLS);
    const x0 = col * csi, y0 = rowF * csi;
    const relief = CELL_RELIEF[cell] * (csi / 256);
    const [rLo, rHi] = CELL_ROUGH[cell];
    // Wrapped inside the cell: correct for the tiling barks and harmless for
    // the cutout cells, whose margins are flat anyway. The wrap is only ever
    // needed on the cell's own border, and the border is 0.8 % of a 256 px
    // cell — so the interior runs on straight offsets and the modulo path is
    // reserved for the four edges.
    const at = (x: number, y: number): number => {
      const wx = x0 + (((x - x0) % csi) + csi) % csi;
      const wy = y0 + (((y - y0) % csi) + csi) % csi;
      return lum[wy * size + wx];
    };
    for (let y = y0; y < y0 + csi; y++) {
      const edgeRow = y === y0 || y === y0 + csi - 1;
      for (let x = x0; x < x0 + csi; x++) {
        const o = (y * size + x) * 4;
        let gx: number, gy: number;
        if (edgeRow || x === x0 || x === x0 + csi - 1) {
          gx =
            (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) -
            (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
          gy =
            (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) -
            (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
        } else {
          const c = y * size + x;
          const up = c - size, dn = c + size;
          gx = (lum[up + 1] + 2 * lum[c + 1] + lum[dn + 1]) -
               (lum[up - 1] + 2 * lum[c - 1] + lum[dn - 1]);
          gy = (lum[dn - 1] + 2 * lum[dn] + lum[dn + 1]) -
               (lum[up - 1] + 2 * lum[up] + lum[up + 1]);
        }
        let nx = -gx * relief, ny = -gy * relief, nz = 1;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= inv; ny *= inv; nz *= inv;
        nrm[o] = (nx * 0.5 + 0.5) * 255;
        nrm[o + 1] = (ny * 0.5 + 0.5) * 255;
        nrm[o + 2] = (nz * 0.5 + 0.5) * 255;
        nrm[o + 3] = 255;

        // Bright texels are the ones catching the light, and on a leaf that is
        // the waxy cuticle — so roughness falls as luminance rises.
        const l = lum[y * size + x];
        const r = lerp(rHi, rLo, clamp01(l * 1.6));
        const v = r * 255;
        rgh[o] = v; rgh[o + 1] = v; rgh[o + 2] = v; rgh[o + 3] = 255;
      }
    }
  }

  const albedo = finishTex(new THREE.DataTexture(alb, size, size, THREE.RGBAFormat), true, aniso);
  const normal = finishTex(new THREE.DataTexture(nrm, size, size, THREE.RGBAFormat), false, aniso);
  const rough = finishTex(new THREE.DataTexture(rgh, size, size, THREE.RGBAFormat), false, aniso);

  // Let the canvas go now rather than waiting for the GC: at 2048 that is
  // 16 MB of backing store still resident while the geometry bakes.
  canvas.width = 1;
  canvas.height = 1;

  return {
    albedo, normal, rough,
    dispose() {
      albedo.dispose();
      normal.dispose();
      rough.dispose();
    },
  };
}

/* ------------------------------------------------------------------------ *
 * Geometry builder
 * ------------------------------------------------------------------------ */
//
// Everything a plant is made of is appended into one flat vertex soup and
// handed to a single `BufferGeometry` at the end. Besides position/normal/uv
// there are two extra channels, and both of them exist for the shader:
//
//   • `color` carries baked ambient occlusion, cooled toward blue as it
//     darkens. Sky fill is blue; occluded foliage in the real world goes cool,
//     not just dark, and a canopy interior that only loses value reads as
//     dirty rather than shaded.
//   • `aFlex` carries the wind response: x = how much this vertex swings with
//     the trunk (0 at the roots, 1 at the crown), y = how much it flutters on
//     its own petiole, z = how translucent it is (bark 0, a leaf tip 1).

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

class Build {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uvs: number[] = [];
  readonly col: number[] = [];
  readonly flx: number[] = [];
  readonly idx: number[] = [];
  tris = 0;

  get count(): number {
    return this.pos.length / 3;
  }

  /** Append one vertex, transformed by `m`. Returns its index. */
  vert(
    m: THREE.Matrix4,
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
    ao: number, sway: number, flut: number, trans: number,
  ): number {
    _v.set(x, y, z).applyMatrix4(m);
    _n.set(nx, ny, nz).transformDirection(m);
    this.pos.push(_v.x, _v.y, _v.z);
    this.nrm.push(_n.x, _n.y, _n.z);
    this.uvs.push(u, v);
    // The cool shift: 4 % more blue than red at full occlusion, none at all in
    // full light. Small enough to read as light rather than as a tint.
    const cool = 1 + (1 - ao) * 0.06;
    this.col.push(ao, ao * (1 + (1 - ao) * 0.015), ao * cool);
    this.flx.push(sway, flut, trans);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
    this.tris++;
  }

  /** Two triangles for a quad given in winding order. */
  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  geometry(name: string): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.name = name;
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    geo.setAttribute("aFlex", new THREE.Float32BufferAttribute(this.flx, 3));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

/* ---- placement helpers --------------------------------------------------- */

const _ax = new THREE.Vector3();
const _ay = new THREE.Vector3();
const _az = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _mr = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * A matrix whose local +Y points along `dir`, positioned at `pos`, twisted by
 * `roll` around its own axis. Every branch, frond and leaf card in the module
 * is seated with this.
 */
function faceMatrix(out: THREE.Matrix4, pos: THREE.Vector3, dir: THREE.Vector3, roll: number): THREE.Matrix4 {
  _ay.copy(dir).normalize();
  // Any reference that is not parallel to the axis will do; +X only fails for
  // a perfectly horizontal-east branch, which the fallback catches.
  _ax.set(1, 0, 0);
  if (Math.abs(_ay.x) > 0.94) _ax.set(0, 0, 1);
  _az.crossVectors(_ax, _ay).normalize();
  _ax.crossVectors(_ay, _az).normalize();
  out.makeBasis(_ax, _ay, _az);
  if (roll !== 0) {
    _q0.setFromAxisAngle(_ay, roll);
    out.premultiply(_mr.makeRotationFromQuaternion(_q0));
  }
  out.setPosition(pos);
  return out;
}

const _bv = new THREE.Vector3();
const _bd = new THREE.Vector3();

/**
 * The frame at the *base* of a limb whose tip frame is `tip`.
 *
 * `trunk()` hands back the tip, because that is where canopies hang; anything
 * that wants to distribute detail *along* the limb — needle cards on a
 * conifer branch, a second-order twig — needs the other end. Walking back
 * along the tip's own axis is exact for a straight limb and off by a
 * centimetre for a bowed one, which is well inside the width of the branch.
 */
function baseFrameOf(tip: THREE.Matrix4, len: number, out: THREE.Matrix4): THREE.Matrix4 {
  out.copy(tip);
  _bv.setFromMatrixPosition(tip);
  _bd.set(0, 1, 0).transformDirection(tip);
  _bv.addScaledVector(_bd, -len);
  out.setPosition(_bv);
  return out;
}

/* ---- trunks and branches ------------------------------------------------- */

interface TrunkSpec {
  /** Length along the sweep, metres. */
  len: number;
  /** Radius at the base and at the tip. */
  r0: number;
  r1: number;
  /** Sideways drift of the tip, in metres, as [x, z]. Gives the lean. */
  leanX: number;
  leanZ: number;
  /**
   * Bow of the sweep. Positive arcs the middle of the trunk *against* the
   * lean, which is how a real tree that grew into the wind looks: the base
   * leans, the crown recovers toward vertical.
   */
  bow: number;
  sides: number;
  rings: number;
  /** Root buttress: extra radius at the very bottom, and how lobed it is. */
  flare: number;
  lobes: number;
  cell: number;
  /** Texture repeats up the length. */
  vRepeat: number;
  /** Ambient occlusion at base and tip. */
  ao0: number;
  ao1: number;
  /** Wind compliance at base and tip. */
  sway0: number;
  sway1: number;
  /** Close the tip with a cap. Branches want it; a trunk under a canopy does not. */
  cap?: boolean;
}

const _p0 = new THREE.Vector3();
const _t0 = new THREE.Vector3();
const _r0 = new THREE.Vector3();
const _s0 = new THREE.Vector3();

/**
 * The sweep, as a quadratic bezier from the base to the tip with the control
 * point pushed sideways by `bow`.
 *
 * Exposed rather than kept inside `trunk()` because every branch in the module
 * is hung off a point partway up its parent, and the attachment has to land on
 * the surface the parent actually built — a branch seated on the straight line
 * between base and tip floats off a bowed trunk by a visible margin.
 */
function sweepAt(o: TrunkSpec, t: number, dst: THREE.Vector3): THREE.Vector3 {
  const s = 1 - t;
  const cx = o.leanX * 0.5 - o.leanZ * o.bow * 0.5;
  const cz = o.leanZ * 0.5 + o.leanX * o.bow * 0.5;
  const cy = o.len * 0.5;
  return dst.set(
    2 * s * t * cx + t * t * o.leanX,
    2 * s * t * cy + t * t * o.len,
    2 * s * t * cz + t * t * o.leanZ,
  );
}

function sweepTangent(o: TrunkSpec, t: number, dst: THREE.Vector3): THREE.Vector3 {
  const s = 1 - t;
  const cx = o.leanX * 0.5 - o.leanZ * o.bow * 0.5;
  const cz = o.leanZ * 0.5 + o.leanX * o.bow * 0.5;
  const cy = o.len * 0.5;
  return dst.set(
    2 * s * cx + 2 * t * (o.leanX - cx),
    2 * s * cy + 2 * t * (o.len - cy),
    2 * s * cz + 2 * t * (o.leanZ - cz),
  ).normalize();
}

/** Radius of the sweep at `t`, buttress lobes excluded. */
function sweepRadius(o: TrunkSpec, t: number): number {
  return lerp(o.r1, o.r0, Math.pow(1 - t, 1.42));
}

/**
 * A swept, tapered tube.
 *
 * The ring frame is rebuilt from the analytic tangent at every station rather
 * than extruding a fixed cross-section, so a leaning trunk keeps a circular
 * section perpendicular to its own axis. Extruded-along-Y trunks shear into
 * ellipses as they lean and the silhouette goes soft exactly where the eye is
 * looking — the point where the tree meets the ground.
 *
 * Returns the tip frame, so a caller can hang a canopy or another branch off
 * the end without recomputing anything.
 */
function trunk(b: Build, m: THREE.Matrix4, o: TrunkSpec, rng: () => number, out?: THREE.Matrix4): THREE.Matrix4 {
  const uv = cellUV(o.cell);
  const sides = Math.max(3, o.sides);
  const rings = Math.max(2, o.rings);
  const ringIdx: number[][] = [];

  // A per-trunk twist so two instances of the same species never show the same
  // buttress facing the camera.
  const twist = rng() * TAU;

  for (let ri = 0; ri <= rings; ri++) {
    const t = ri / rings;
    sweepAt(o, t, _p0);
    sweepTangent(o, t, _t0);
    // Stable frame: reference against world +X unless the tangent is near it.
    _r0.set(1, 0, 0);
    if (Math.abs(_t0.x) > 0.94) _r0.set(0, 0, 1);
    _s0.crossVectors(_t0, _r0).normalize();
    _r0.crossVectors(_s0, _t0).normalize();

    // Taper is a power curve, not a lerp: real trunks lose most of their girth
    // in the first third and then run nearly parallel.
    const rad = sweepRadius(o, t);
    const flare = o.flare > 0 ? Math.pow(clamp01(1 - t * 5.5), 2.4) * o.flare : 0;
    const ao = lerp(o.ao0, o.ao1, Math.pow(t, 0.7));
    const sway = lerp(o.sway0, o.sway1, t);

    const row: number[] = [];
    for (let si = 0; si <= sides; si++) {
      const a = (si / sides) * TAU + twist;
      // Buttress lobes: the flare is not a cone, it is a set of roots.
      const lobe = flare * (1 + Math.cos(a * o.lobes) * 0.55);
      const rr = rad + lobe;
      const nx = Math.cos(a), nz = Math.sin(a);
      const vx = _r0.x * nx + _s0.x * nz;
      const vy = _r0.y * nx + _s0.y * nz;
      const vz = _r0.z * nx + _s0.z * nz;
      row.push(b.vert(
        m,
        _p0.x + vx * rr, _p0.y + vy * rr, _p0.z + vz * rr,
        vx, vy, vz,
        uv.u0 + (si / sides) * uv.du,
        uv.v0 + ((t * o.vRepeat) % 1) * uv.dv,
        ao, sway, 0, 0.02,
      ));
    }
    ringIdx.push(row);
  }

  for (let ri = 0; ri < rings; ri++) {
    const a = ringIdx[ri], c = ringIdx[ri + 1];
    for (let si = 0; si < sides; si++) {
      b.quad(a[si], a[si + 1], c[si + 1], c[si]);
    }
  }

  if (o.cap) {
    sweepAt(o, 1, _p0);
    sweepTangent(o, 1, _t0);
    const top = b.vert(
      m, _p0.x, _p0.y, _p0.z, _t0.x, _t0.y, _t0.z,
      uv.u0 + uv.du * 0.5, uv.v0 + uv.dv * 0.5, o.ao1, o.sway1, 0, 0.02,
    );
    const row = ringIdx[rings];
    for (let si = 0; si < sides; si++) b.tri(row[si], row[si + 1], top);
  }

  const dst = out ?? new THREE.Matrix4();
  sweepAt(o, 1, _p0);
  sweepTangent(o, 1, _t0);
  _p0.applyMatrix4(m);
  _t0.transformDirection(m);
  faceMatrix(dst, _p0, _t0, 0);
  return dst;
}

/* ---- leaf cards ---------------------------------------------------------- */

interface CardSpec {
  w: number;
  h: number;
  /** Bow out of plane, in metres, at the tip. */
  bow: number;
  /** Subdivisions along the length. 1 = a flat quad, 3 = a curved blade. */
  segs: number;
  cell: number;
  /** Direction the card's normals are dragged toward — the canopy shell. */
  toward: THREE.Vector3;
  /** 0 = keep the card's own normal, 1 = take the shell's entirely. */
  blend: number;
  ao0: number;
  ao1: number;
  sway: number;
  flut0: number;
  flut1: number;
  trans: number;
  /** Sample a random sub-rectangle of the cell, so cards do not repeat. */
  jitter?: number;
}

const _cn = new THREE.Vector3();

/**
 * A bowed leaf card, rooted at the origin of `m`, growing along +Y, facing +Z.
 *
 * The normal blend is the entire reason clustered cross-planes work at all.
 * Shade a card with its own flat normal and the canopy is a stack of
 * differently-lit rectangles; drag the normals toward the canopy's shell
 * normal and the same geometry shades like one round mass with detail in it.
 * 0.7 is the number: below it the flatness shows, above it the cards stop
 * catching any light of their own and the canopy goes plastic.
 */
function card(b: Build, m: THREE.Matrix4, o: CardSpec, rng?: () => number): void {
  const uv = cellUV(o.cell);
  const j = o.jitter ?? 0;
  // Sub-rectangle of the cell. Uses only the middle of the cell when jittered,
  // so a jittered card never clips into the inset margin.
  const ju = j > 0 && rng ? rng() * j : 0;
  const jv = j > 0 && rng ? rng() * j : 0;
  const su = 1 - j, sv = 1 - j;

  const segs = Math.max(1, o.segs);
  const rows: number[][] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // Quadratic droop: leaves hang, they do not fold at a hinge.
    const z = o.bow * t * t;
    const dz = 2 * o.bow * t;
    const ao = lerp(o.ao0, o.ao1, t);
    const flut = lerp(o.flut0, o.flut1, t);
    // The card's own normal follows its curve.
    _cn.set(0, -dz, 1).normalize();
    _cn.lerp(o.toward, o.blend).normalize();
    const row: number[] = [];
    for (let k = 0; k <= 1; k++) {
      const x = (k - 0.5) * o.w;
      row.push(b.vert(
        m, x, t * o.h, z,
        _cn.x, _cn.y, _cn.z,
        uv.u0 + (ju + k * su) * uv.du,
        uv.v0 + (jv + t * sv) * uv.dv,
        ao, o.sway, flut, o.trans,
      ));
    }
    rows.push(row);
  }
  for (let i = 0; i < segs; i++) {
    b.quad(rows[i][0], rows[i][1], rows[i + 1][1], rows[i + 1][0]);
  }
}

/* ---- fronds -------------------------------------------------------------- */

interface FrondSpec {
  len: number;
  /** Width at the base, at the widest point, and at the tip. */
  w0: number;
  w1: number;
  w2: number;
  /** How far the tip falls, in metres. */
  droop: number;
  /** Depth of the V-fold along the midrib. */
  keel: number;
  /** Twist along the length, radians at the tip. */
  twist: number;
  segs: number;
  cell: number;
  ao0: number;
  ao1: number;
  sway: number;
  flut: number;
  trans: number;
}

/**
 * One frond: a swept, tapered, twisted, V-keeled strip.
 *
 * The keel is what makes it survive being seen edge-on. A flat frond viewed
 * along its own plane disappears into a line; one with a real cross-section
 * still reads as a frond, and a palm crown seen from underneath is exactly
 * that view.
 */
function frond(b: Build, m: THREE.Matrix4, o: FrondSpec): void {
  const uv = cellUV(o.cell);
  const segs = Math.max(2, o.segs);
  const rows: number[][] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // The arch: rises, then falls away past the halfway point.
    const y = t * o.len;
    const drop = -o.droop * t * t;
    const tw = o.twist * t;
    const w = t < 0.35 ? lerp(o.w0, o.w1, t / 0.35) : lerp(o.w1, o.w2, (t - 0.35) / 0.65);
    const keel = o.keel * (1 - t * 0.5);
    const ao = lerp(o.ao0, o.ao1, t);
    const ct = Math.cos(tw), st = Math.sin(tw);
    const row: number[] = [];
    for (let k = -1; k <= 1; k++) {
      const x = k * w * 0.5;
      // The V: edges lift above the midrib line.
      const z = Math.abs(k) * keel;
      const rx = x * ct - z * st;
      const rz = x * st + z * ct;
      // Normal of the half-plane this vertex sits on.
      const nSide = k === 0 ? 0 : -Math.sign(k) * 0.42;
      _cn.set(nSide, -0.28, 1).normalize();
      row.push(b.vert(
        m, rx, y, drop + rz,
        _cn.x * ct - _cn.z * st, _cn.y, _cn.x * st + _cn.z * ct,
        uv.u0 + ((k + 1) * 0.5) * uv.du,
        uv.v0 + t * uv.dv,
        ao, o.sway, o.flut * t, o.trans,
      ));
    }
    rows.push(row);
  }
  for (let i = 0; i < segs; i++) {
    b.quad(rows[i][0], rows[i][1], rows[i + 1][1], rows[i + 1][0]);
    b.quad(rows[i][1], rows[i][2], rows[i + 1][2], rows[i + 1][1]);
  }
}

/* ---- clumps -------------------------------------------------------------- */

const _bi = new THREE.Vector3();
const _bj = new THREE.Vector3();

/**
 * A foliage clump: a low-poly sphere whose every face samples a different
 * random triangle of the leaf cell.
 *
 * The alpha cutout then eats the face edges, so what you get is a ragged ball
 * of leaves rather than a faceted sphere. This is the workhorse of every
 * canopy here — cards give the canopy its edge detail, clumps give it its
 * mass, and the pair together is what a Fortnite tree actually is.
 */
function blob(
  b: Build, m: THREE.Matrix4,
  r: number, squash: number, detail: number, cell: number,
  ao0: number, ao1: number, sway: number, flut: number, trans: number,
  rng: () => number,
): void {
  const uv = cellUV(cell);
  const src = new THREE.IcosahedronGeometry(1, detail);
  const pos = src.getAttribute("position");
  const n = pos.count;
  for (let f = 0; f < n; f += 3) {
    // A random rotated triangle inside the cell. Three corners of an
    // equilateral triangle inscribed in the cell's inner circle covers most of
    // the painted leaf mass at any rotation.
    const rot = rng() * TAU;
    const rad = 0.42 + rng() * 0.06;
    const cu = 0.5 + (rng() - 0.5) * 0.1;
    const cv = 0.5 + (rng() - 0.5) * 0.1;
    const tri: number[] = [];
    for (let k = 0; k < 3; k++) {
      const i = f + k;
      _bi.set(pos.getX(i), pos.getY(i) * squash, pos.getZ(i));
      _bj.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
      // Occlusion follows height in the clump: the underside is in shadow.
      const ao = lerp(ao0, ao1, clamp01(_bj.y * 0.5 + 0.5));
      const a = rot + (k / 3) * TAU;
      tri.push(b.vert(
        m,
        _bi.x * r, _bi.y * r, _bi.z * r,
        _bj.x, _bj.y, _bj.z,
        uv.u0 + (cu + Math.cos(a) * rad) * uv.du,
        uv.v0 + (cv + Math.sin(a) * rad) * uv.dv,
        ao, sway, flut, trans,
      ));
    }
    b.tri(tri[0], tri[1], tri[2]);
  }
  src.dispose();
}

/**
 * A cross-billboard impostor: three quads at 60° through a common axis, each
 * sampling the painted silhouette card.
 *
 * Three rather than two, because two flip visibly as you orbit — at 60° the
 * worst-case view still has a quad within 30° of facing you. They are the only
 * geometry in the module that does not shade: the card has the key baked in.
 */
function impostorCross(b: Build, w: number, h: number, cell: number, planes: number): void {
  const uv = cellUV(cell);
  for (let p = 0; p < planes; p++) {
    const a = (p / planes) * Math.PI;
    const cx = Math.cos(a), cz = Math.sin(a);
    const m = new THREE.Matrix4();
    const rows: number[][] = [];
    for (let i = 0; i <= 1; i++) {
      const row: number[] = [];
      for (let k = 0; k <= 1; k++) {
        const x = (k - 0.5) * w;
        row.push(b.vert(
          m, x * cx, i * h, x * cz,
          // Normals point up and out: the impostor should take the sky's fill
          // and a little of the key without ever showing a hard terminator.
          cx * 0.25, 0.94, cz * 0.25,
          uv.u0 + k * uv.du, uv.v0 + i * uv.dv,
          lerp(0.72, 1.0, i), i * 0.35, 0, 0.5,
        ));
      }
      rows.push(row);
    }
    b.quad(rows[0][0], rows[0][1], rows[1][1], rows[1][0]);
  }
}

/* ------------------------------------------------------------------------ *
 * Species
 * ------------------------------------------------------------------------ */

/** Golden angle. Distributing anything round a stem with it is what stops
 *  whorls of leaves lining up into visible spirals. */
const GOLD = 2.399963;

interface BuildCtx {
  tier: VegTier;
  /** 0 = full, 1 = mid, 2 = impostor. */
  lod: number;
  rng: () => number;
}

/** Identity, for the many builders whose root frame is the origin. */
const IDENT4 = new THREE.Matrix4();

const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _da = new THREE.Vector3();
const _sh = new THREE.Vector3();

interface CanopyOpts {
  /** Centre of the canopy ellipsoid in the tree's local space. */
  cy: number;
  cx?: number;
  cz?: number;
  rx: number;
  ry: number;
  rz: number;
  clumps: number;
  clumpR: [number, number];
  cards: number;
  cardW: number;
  cardH: number;
  cardDroop: number;
  cell: number;
  ao0: number;
  ao1: number;
  /** Tree height, for deriving each element's wind compliance from its Y. */
  treeH: number;
  swayGain: number;
  flut: number;
  trans: number;
  squash: number;
  detail: number;
  /** Pull the whole shell down on one side, as if it grew away from a slope. */
  droop?: number;
}

/**
 * A canopy: clumps for the mass, cards for the edge.
 *
 * Both are seated on the same ellipsoid shell and both take that shell's
 * outward normal, which is what makes the whole thing shade as one object. The
 * clumps sit *inside* the shell (0.55–0.95 of the radius) and the cards sit on
 * it and hang past it — mass in, detail out. A canopy built the other way
 * round has a hard convex edge and a hollow middle, which is the classic
 * procedural-tree silhouette.
 */
function canopy(b: Build, o: CanopyOpts, rng: () => number): void {
  const ox = o.cx ?? 0, oz = o.cz ?? 0;

  for (let i = 0; i < o.clumps; i++) {
    // Golden-angle spiral over the sphere, so no two clumps stack.
    const t = (i + 0.5) / o.clumps;
    const y = 1 - t * 1.72;              // biased upward: crowns are top-heavy
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * GOLD;
    _sh.set(Math.cos(a) * rr, y, Math.sin(a) * rr);
    const shell = 0.52 + rng() * 0.42;
    const px = ox + _sh.x * o.rx * shell;
    const py = o.cy + _sh.y * o.ry * shell - (o.droop ?? 0) * (1 - _sh.y) * 0.5;
    const pz = oz + _sh.z * o.rz * shell;
    _m1.makeTranslation(px, py, pz);
    const r = lerp(o.clumpR[0], o.clumpR[1], rng());
    blob(
      b, _m1, r, o.squash, o.detail, o.cell,
      o.ao0, o.ao1,
      clamp01(py / o.treeH) * o.swayGain, o.flut, o.trans, rng,
    );
  }

  for (let i = 0; i < o.cards; i++) {
    const t = (i + 0.5) / o.cards;
    const y = 1 - t * 1.85;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * GOLD + 0.7;
    _sh.set(Math.cos(a) * rr, y, Math.sin(a) * rr);
    _pa.set(
      ox + _sh.x * o.rx * 0.94,
      o.cy + _sh.y * o.ry * 0.94 - (o.droop ?? 0) * (1 - _sh.y) * 0.5,
      oz + _sh.z * o.rz * 0.94,
    );
    // Cards grow outward along the shell normal but tilted down: leaves hang.
    _da.copy(_sh).normalize();
    _da.y -= 0.55;
    _da.normalize();
    faceMatrix(_m1, _pa, _da, rng() * TAU);
    const scale = 0.72 + rng() * 0.62;
    card(b, _m1, {
      w: o.cardW * scale, h: o.cardH * scale, bow: o.cardDroop * scale, segs: 3,
      cell: o.cell, toward: _sh.clone().normalize(), blend: 0.7,
      ao0: lerp(o.ao0, o.ao1, 0.4), ao1: o.ao1,
      sway: clamp01(_pa.y / o.treeH) * o.swayGain,
      flut0: o.flut * 0.35, flut1: o.flut,
      trans: o.trans, jitter: 0.34,
    }, rng);
  }
}

/**
 * One bough: a tapering swept limb that lifts as it goes out.
 *
 * `lift` is the whole character of a species. An oak's boughs leave the trunk
 * at 55° and then curl *up* — the bow term does that — which is why an oak
 * silhouette is all elbows. A conifer's leave at 100° and sag.
 */
function bough(
  b: Build, parent: THREE.Matrix4, t: number, parentSpec: TrunkSpec,
  angle: number, azimuth: number, len: number, r0: number, r1: number,
  lift: number, barkCell: number, cx: BuildCtx, ao: number, sway: number,
  out: THREE.Matrix4, emitWood = true,
): THREE.Matrix4 {
  sweepAt(parentSpec, t, _pa);
  // Start the bough inside the parent's wood, or a gap opens at the joint the
  // moment the trunk is seen against the sky.
  const surf = sweepRadius(parentSpec, t) * 0.7;
  _da.set(Math.cos(azimuth), 0, Math.sin(azimuth));
  _pa.x += _da.x * surf;
  _pa.z += _da.z * surf;
  _pa.applyMatrix4(parent);
  _da.set(Math.cos(azimuth) * Math.sin(angle), Math.cos(angle), Math.sin(azimuth) * Math.sin(angle));
  _da.transformDirection(parent);
  faceMatrix(_m2, _pa, _da, 0);

  const spec: TrunkSpec = {
    len, r0, r1,
    // Lean back toward vertical as it goes out — `faceMatrix` already tipped
    // the whole limb over, so a positive Y-ward lean here reads as a lift.
    leanX: 0, leanZ: -len * lift * 0.42,
    bow: lift * 0.9,
    sides: Math.max(3, cx.tier.trunkSides - 2 - cx.lod),
    rings: Math.max(2, cx.tier.trunkRings - 2 - cx.lod),
    flare: r0 * 0.5, lobes: 3,
    cell: barkCell, vRepeat: Math.max(1, Math.round(len * 0.5)),
    ao0: ao * 0.86, ao1: ao, sway0: sway * 0.5, sway1: sway, cap: false,
  };
  if (emitWood) {
    trunk(b, _m2, spec, cx.rng, out);
  } else {
    // Frame only. Past the near band a conifer's branch wood is entirely
    // hidden under its own needles, and a 40-triangle tube nobody can see,
    // multiplied by fifty branches and a thousand trees, is most of the mid
    // band's triangle budget spent on nothing.
    sweepAt(spec, 1, _pa);
    sweepTangent(spec, 1, _da);
    _pa.applyMatrix4(_m2);
    _da.transformDirection(_m2);
    faceMatrix(out, _pa, _da, 0);
  }
  return out;
}

/* ---- broadleaf family ---------------------------------------------------- */

/**
 * The generic hardwood.
 *
 * Oak, the plains broadleaf and birch are all this function with different
 * numbers, because they are the same plant structurally — a trunk, a whorl of
 * boughs starting somewhere up it, a canopy hung off the bough tips plus one
 * mass over the crown. What separates them visually is trunk slenderness,
 * where the boughs start, and the leaf cell.
 */
interface HardwoodOpts {
  h: number;
  r0: number;
  r1: number;
  lean: number;
  bow: number;
  flare: number;
  barkCell: number;
  leafCell: number;
  /** Fraction of the height where the first bough leaves the trunk. */
  crownStart: number;
  boughs: number;
  boughLen: number;
  boughAngle: number;
  boughLift: number;
  /** Second-order branches per bough. */
  twigs: number;
  crownRx: number;
  crownRy: number;
  clumps: number;
  clumpR: [number, number];
  cards: number;
  cardW: number;
  cardH: number;
  trans: number;
  swayGain: number;
  flut: number;
  detail: number;
}

function buildHardwood(b: Build, cx: BuildCtx, o: HardwoodOpts): void {
  const rng = cx.rng;
  const lod = cx.lod;
  const leanA = rng() * TAU;
  const spec: TrunkSpec = {
    len: o.h, r0: o.r0, r1: o.r1,
    leanX: Math.cos(leanA) * o.lean, leanZ: Math.sin(leanA) * o.lean,
    bow: o.bow,
    sides: Math.max(4, o.detail > 0 ? cx.tier.trunkSides - lod : cx.tier.trunkSides - lod - 1),
    rings: Math.max(3, cx.tier.trunkRings - lod),
    flare: o.flare, lobes: 5,
    cell: o.barkCell, vRepeat: Math.max(2, Math.round(o.h * 0.28)),
    // The trunk base sits in its own contact shadow. Without this the tree
    // looks like it is hovering, whatever the terrain under it does.
    ao0: 0.46, ao1: 0.92,
    sway0: 0, sway1: 0.65,
  };
  trunk(b, IDENT4, spec, rng, _m3);

  const nBough = Math.max(2, Math.round(o.boughs * (lod === 0 ? 1 : 0.6)));
  const nTwig = lod === 0 ? o.twigs : 0;
  const tipM = new THREE.Matrix4();
  const twigM = new THREE.Matrix4();
  const baseM = new THREE.Matrix4();

  for (let i = 0; i < nBough; i++) {
    const t = o.crownStart + (i / Math.max(1, nBough - 1)) * (0.96 - o.crownStart) * 0.9;
    const az = i * GOLD + rng() * 0.4;
    const len = o.boughLen * (0.72 + rng() * 0.56) * (1 - t * 0.3);
    const r = sweepRadius(spec, t) * 0.62;
    bough(
      b, IDENT4, t, spec,
      o.boughAngle + (rng() - 0.5) * 0.35, az, len, r, r * 0.34,
      o.boughLift, o.barkCell, cx, 0.86, 0.72, tipM,
    );

    // A cluster of foliage on the bough tip. This is what gives a hardwood its
    // lumpy crown instead of one smooth ball.
    _pb.setFromMatrixPosition(tipM);
    canopy(b, {
      cx: _pb.x, cy: _pb.y, cz: _pb.z,
      rx: o.crownRx * 0.42, ry: o.crownRy * 0.40, rz: o.crownRx * 0.42,
      clumps: Math.max(1, Math.round(o.clumps * 0.22 * (lod === 0 ? 1 : 0.5))),
      clumpR: [o.clumpR[0] * 0.8, o.clumpR[1] * 0.8],
      cards: Math.max(0, Math.round(o.cards * 0.16 * (lod === 0 ? 1 : 0.4))),
      cardW: o.cardW, cardH: o.cardH, cardDroop: o.cardH * 0.32,
      cell: o.leafCell, ao0: 0.52, ao1: 1.0,
      treeH: o.h, swayGain: o.swayGain, flut: o.flut, trans: o.trans,
      squash: 0.78, detail: o.detail,
    }, rng);

    for (let k = 0; k < nTwig; k++) {
      const tt = 0.45 + (k / Math.max(1, nTwig)) * 0.45;
      const sub: TrunkSpec = {
        len, r0: r, r1: r * 0.34, leanX: 0, leanZ: -len * o.boughLift * 0.42,
        bow: o.boughLift * 0.9, sides: 4, rings: 3, flare: 0, lobes: 3,
        cell: o.barkCell, vRepeat: 2, ao0: 0.8, ao1: 0.9, sway0: 0.5, sway1: 0.8,
      };
      bough(
        b, baseFrameOf(tipM, len, baseM), tt, sub,
        0.7 + rng() * 0.5, k * GOLD + rng(), len * 0.44, r * 0.4, r * 0.14,
        o.boughLift * 1.3, o.barkCell, cx, 0.9, 0.85, twigM,
      );
    }
  }

  // The crown mass, over the top of the trunk.
  sweepAt(spec, 0.94, _pa);
  canopy(b, {
    cx: _pa.x, cy: _pa.y + o.crownRy * 0.34, cz: _pa.z,
    rx: o.crownRx, ry: o.crownRy, rz: o.crownRx * 0.96,
    clumps: Math.round(o.clumps * (lod === 0 ? 1 : 0.42)),
    clumpR: o.clumpR,
    cards: Math.round(o.cards * (lod === 0 ? 1 : 0.3)),
    cardW: o.cardW, cardH: o.cardH, cardDroop: o.cardH * 0.34,
    cell: o.leafCell, ao0: 0.44, ao1: 1.0,
    treeH: o.h, swayGain: o.swayGain, flut: o.flut, trans: o.trans,
    squash: 0.72, detail: o.detail,
  }, rng);
}

function buildOak(b: Build, cx: BuildCtx, variant: number): void {
  if (cx.lod >= 2) {
    impostorCross(b, 15, 19, C_IMP_BROAD, 3);
    return;
  }
  const rng = cx.rng;
  buildHardwood(b, cx, {
    h: 14 + variant * 1.6 + rng() * 3,
    r0: 0.92 + variant * 0.06, r1: 0.30,
    lean: 0.5 + rng() * 0.8, bow: 0.22,
    flare: 0.55, barkCell: C_BARK_OAK, leafCell: C_OAK,
    crownStart: 0.40, boughs: 6, boughLen: 4.4, boughAngle: 0.95, boughLift: 0.55,
    twigs: 2, crownRx: 6.2, crownRy: 4.0,
    clumps: 26, clumpR: [1.5, 2.6], cards: 30, cardW: 2.0, cardH: 2.4,
    trans: 0.9, swayGain: 1.0, flut: 0.9, detail: 1,
  });
  // Root buttresses breaking the surface, and moss on the north side of them.
  // The contact point is where a procedural tree usually gives itself away.
  if (cx.tier.trim && cx.lod === 0) {
    for (let i = 0; i < 5; i++) {
      const a = i * GOLD;
      _pa.set(Math.cos(a) * 0.75, 0.12, Math.sin(a) * 0.75);
      _da.set(Math.cos(a) * 0.75, 0.62, Math.sin(a) * 0.75).normalize();
      faceMatrix(_m1, _pa, _da, 0);
      trunk(b, _m1, {
        len: 1.1 + rng() * 0.5, r0: 0.26, r1: 0.07,
        leanX: 0, leanZ: 0.5, bow: -0.6, sides: 4, rings: 3,
        flare: 0.1, lobes: 3, cell: C_BARK_OAK, vRepeat: 1,
        ao0: 0.4, ao1: 0.72, sway0: 0, sway1: 0.02, cap: true,
      }, rng);
    }
  }
}

function buildBroadleaf(b: Build, cx: BuildCtx, variant: number): void {
  if (cx.lod >= 2) {
    impostorCross(b, 9.5, 12.5, C_IMP_BROAD, 3);
    return;
  }
  const rng = cx.rng;
  buildHardwood(b, cx, {
    h: 8.5 + variant * 1.2 + rng() * 3.4,
    r0: 0.40 + variant * 0.04, r1: 0.14,
    lean: 0.6 + rng() * 1.1, bow: 0.3,
    flare: 0.24, barkCell: C_BARK_OAK, leafCell: C_BROAD,
    crownStart: 0.46, boughs: 5, boughLen: 2.9, boughAngle: 0.85, boughLift: 0.62,
    twigs: 1, crownRx: 3.5, crownRy: 2.8,
    clumps: 18, clumpR: [1.0, 1.9], cards: 22, cardW: 1.5, cardH: 1.9,
    trans: 1.0, swayGain: 1.15, flut: 1.0, detail: 1,
  });
}

function buildBirch(b: Build, cx: BuildCtx, variant: number): void {
  if (cx.lod >= 2) {
    impostorCross(b, 6.5, 14, C_IMP_BROAD, 2);
    return;
  }
  const rng = cx.rng;
  buildHardwood(b, cx, {
    h: 10 + variant * 1.4 + rng() * 3,
    r0: 0.20, r1: 0.07,
    // Birch is the leaner: a stand of them all bending slightly different ways
    // is one of the strongest "this is a real wood" cues there is.
    lean: 1.1 + rng() * 1.4, bow: 0.42,
    flare: 0.08, barkCell: C_BARK_BIRCH, leafCell: C_BIRCH,
    crownStart: 0.52, boughs: 5, boughLen: 2.0, boughAngle: 0.62, boughLift: 0.85,
    twigs: 1, crownRx: 2.2, crownRy: 3.0,
    clumps: 14, clumpR: [0.75, 1.35], cards: 20, cardW: 1.0, cardH: 1.5,
    trans: 1.15, swayGain: 1.5, flut: 1.25, detail: 1,
  });
}

/* ---- conifers ------------------------------------------------------------ */

/**
 * A conifer.
 *
 * Whorls of branches down a straight leader, each whorl wider and lower than
 * the one above it, every branch carrying needle cards along its length. The
 * cards lie roughly horizontal and droop at the tip, which is the shape that
 * makes a spruce read as a spruce from 300 m — a cone of green blobs does not.
 */
function buildConifer(
  b: Build, cx: BuildCtx,
  h: number, r0: number, whorls: number, skirt: number, spread: number, droopy: number,
): void {
  const rng = cx.rng;
  const lod = cx.lod;
  const leanA = rng() * TAU;
  const spec: TrunkSpec = {
    len: h, r0, r1: 0.04,
    leanX: Math.cos(leanA) * 0.25, leanZ: Math.sin(leanA) * 0.25, bow: 0.1,
    sides: Math.max(4, cx.tier.trunkSides - 1 - lod),
    rings: Math.max(3, cx.tier.trunkRings - lod),
    flare: r0 * 0.7, lobes: 4,
    cell: C_BARK_PINE, vRepeat: Math.max(3, Math.round(h * 0.32)),
    ao0: 0.42, ao1: 0.9, sway0: 0, sway1: 0.5, cap: true,
  };
  trunk(b, IDENT4, spec, rng, _m3);

  const nW = Math.max(3, Math.round(whorls * (lod === 0 ? 1 : 0.5)));
  const perW = lod === 0 ? 6 : 3;
  const tipM = new THREE.Matrix4();
  const baseM = new THREE.Matrix4();
  // Conifer branch wood is thin, straight and almost entirely buried in its
  // own needles, so it gets a coarser tube than a hardwood bough would — one
  // ring and one side fewer, which is a third of the tree's triangles back.
  const branchCx: BuildCtx = {
    ...cx,
    tier: { ...cx.tier, trunkSides: cx.tier.trunkSides - 1, trunkRings: cx.tier.trunkRings - 1 },
  };

  for (let w = 0; w < nW; w++) {
    const t = skirt + (w / (nW - 1)) * (0.97 - skirt);
    // Radius envelope: widest at the skirt, tapering to nothing at the leader.
    const env = Math.pow(1 - (t - skirt) / (1 - skirt), 0.82);
    const len = spread * env * (0.8 + rng() * 0.4);
    if (len < 0.25) continue;
    const r = Math.max(0.02, sweepRadius(spec, t) * 0.5);
    const count = Math.max(3, Math.round(perW * (0.55 + env * 0.6)));
    for (let i = 0; i < count; i++) {
      const az = (i / count) * TAU + w * GOLD;
      const angle = lerp(1.05, 1.45, env) + droopy * 0.3;
      bough(
        b, IDENT4, t, spec, angle, az, len, r, r * 0.3,
        -droopy, C_BARK_PINE, branchCx, 0.8, 0.55, tipM, lod === 0,
      );

      // Needle cards laid along the branch, alternating sides, hanging.
      baseFrameOf(tipM, len, baseM);
      const cards = Math.max(2, Math.round(len * (lod === 0 ? 2.1 : 0.9)));
      for (let c = 0; c < cards; c++) {
        const ct = 0.12 + (c / cards) * 0.88;
        _pa.set(0, ct * len, -ct * ct * len * droopy * 0.42).applyMatrix4(baseM);
        const side = c % 2 === 0 ? 1 : -1;
        _da.set(side * 0.85, 0.1, 0.5).transformDirection(baseM).normalize();
        faceMatrix(_m1, _pa, _da, rng() * 0.7);
        // Fewer cards at range, each one bigger, so the mass of green the
        // branch presents stays roughly constant across the LOD swap.
        const s = lerp(1.0, 0.45, ct) * (lod === 0 ? 1 : 1.85);
        card(b, _m1, {
          w: 0.9 * s, h: 1.5 * s, bow: 0.28 * s, segs: 2, cell: C_NEEDLE,
          toward: _sh.set(0, 1, 0), blend: 0.45,
          ao0: lerp(0.55, 0.85, env), ao1: 1.0,
          sway: clamp01(_pa.y / h) * 0.85,
          flut0: 0.25, flut1: 0.8, trans: 0.75, jitter: 0.3,
        }, rng);
      }
    }
  }

  // The leader tuft, so the spire never ends in a bare stick.
  sweepAt(spec, 0.99, _pa);
  for (let i = 0; i < (lod === 0 ? 5 : 3); i++) {
    const a = i * GOLD;
    _da.set(Math.cos(a) * 0.5, 1, Math.sin(a) * 0.5).normalize();
    faceMatrix(_m1, _pa, _da, rng() * TAU);
    card(b, _m1, {
      w: 0.5, h: 1.0, bow: 0.1, segs: 2, cell: C_NEEDLE,
      toward: _sh.set(0, 1, 0), blend: 0.5, ao0: 0.8, ao1: 1.0,
      sway: 0.95, flut0: 0.4, flut1: 1.0, trans: 0.8, jitter: 0.3,
    }, rng);
  }
}

function buildPine(b: Build, cx: BuildCtx, variant: number): void {
  if (cx.lod >= 2) {
    impostorCross(b, 7.5, 21, C_IMP_CONIF, 3);
    return;
  }
  // Tall, bare-legged, narrow: the highland skyline tree.
  buildConifer(b, cx, 16 + variant * 2.4 + cx.rng() * 5, 0.42, 8, 0.44, 3.0, 0.45);
}

function buildFir(b: Build, cx: BuildCtx, variant: number): void {
  if (cx.lod >= 2) {
    impostorCross(b, 6.0, 12, C_IMP_CONIF, 3);
    return;
  }
  // Short, skirted to the ground, fat: fills the understorey of the pine wood.
  buildConifer(b, cx, 7.5 + variant * 1.2 + cx.rng() * 3.5, 0.26, 9, 0.10, 2.3, 0.2);
}

/* ---- palm ---------------------------------------------------------------- */

function buildPalm(b: Build, cx: BuildCtx, variant: number): void {
  if (cx.lod >= 2) {
    impostorCross(b, 7, 11, C_IMP_BROAD, 2);
    return;
  }
  const rng = cx.rng;
  const lod = cx.lod;
  const h = 7 + variant * 1.5 + rng() * 4.5;
  const leanA = rng() * TAU;
  // A coconut palm's whole character is the curve. 12–18 % of its height in
  // lateral drift, bowed the other way, is the classic postcard silhouette.
  const lean = h * (0.12 + rng() * 0.10);
  const spec: TrunkSpec = {
    len: h, r0: 0.30, r1: 0.19,
    leanX: Math.cos(leanA) * lean, leanZ: Math.sin(leanA) * lean, bow: 0.55,
    sides: Math.max(5, cx.tier.trunkSides - lod),
    rings: Math.max(4, cx.tier.trunkRings + 1 - lod),
    flare: 0.22, lobes: 6,
    cell: C_BARK_PALM, vRepeat: Math.max(3, Math.round(h * 0.55)),
    ao0: 0.5, ao1: 0.95, sway0: 0, sway1: 0.9, cap: true,
  };
  const crown = trunk(b, IDENT4, spec, rng, new THREE.Matrix4());
  _pa.setFromMatrixPosition(crown);

  const n = lod === 0 ? 11 + Math.floor(rng() * 4) : 7;
  for (let i = 0; i < n; i++) {
    const a = i * GOLD;
    // Fronds sit anywhere from 20° above horizontal (the young spear) to 40°
    // below it (the old frond about to drop).
    const pitch = lerp(1.32, 0.35, i / n) + (rng() - 0.5) * 0.25;
    _da.set(Math.cos(a) * Math.sin(pitch), Math.cos(pitch), Math.sin(a) * Math.sin(pitch));
    faceMatrix(_m1, _pa, _da, 0);
    const len = 2.9 + rng() * 1.5;
    frond(b, _m1, {
      len, w0: 0.16, w1: 0.72, w2: 0.10,
      droop: len * (0.30 + rng() * 0.30), keel: 0.10, twist: (rng() - 0.5) * 0.6,
      segs: lod === 0 ? 7 : 4, cell: C_FROND,
      ao0: 0.62, ao1: 1.0, sway: 1.0, flut: 1.25, trans: 1.1,
    });
  }

  // Coconuts and the old frond boots under the crown. Tiny detail, but the
  // crown looks bald without something in the joint.
  if (cx.tier.trim && lod === 0) {
    for (let i = 0; i < 4; i++) {
      const a = rng() * TAU;
      _m1.makeTranslation(
        _pa.x + Math.cos(a) * 0.30, _pa.y - 0.28, _pa.z + Math.sin(a) * 0.30,
      );
      blob(b, _m1, 0.15, 1.05, 0, C_BARK_PALM, 0.6, 0.95, 0.9, 0, 0, rng);
    }
  }
}

/* ---- undergrowth --------------------------------------------------------- */

function buildBush(b: Build, cx: BuildCtx, variant: number): void {
  const rng = cx.rng;
  const s = 0.8 + variant * 0.2;
  const h = (1.0 + rng() * 0.9) * s;
  // A few woody stems, visible through the base of the foliage. A bush that is
  // pure leaf mass reads as a green pillow.
  if (cx.lod === 0) {
    for (let i = 0; i < 4; i++) {
      const a = i * GOLD;
      _pa.set(0, 0, 0);
      _da.set(Math.cos(a) * 0.42, 1, Math.sin(a) * 0.42).normalize();
      faceMatrix(_m1, _pa, _da, 0);
      trunk(b, _m1, {
        len: h * 0.7, r0: 0.05, r1: 0.015, leanX: 0, leanZ: h * 0.1, bow: 0.3,
        sides: 4, rings: 3, flare: 0.02, lobes: 3, cell: C_BARK_OAK, vRepeat: 1,
        ao0: 0.42, ao1: 0.7, sway0: 0, sway1: 0.9, cap: true,
      }, rng);
    }
  }
  canopy(b, {
    cy: h * 0.72, rx: h * 0.78, ry: h * 0.52, rz: h * 0.74,
    clumps: cx.lod === 0 ? 7 : 4, clumpR: [h * 0.30, h * 0.48],
    cards: cx.lod === 0 ? 12 : 5, cardW: h * 0.6, cardH: h * 0.72, cardDroop: h * 0.2,
    cell: variant === 2 ? C_BIRCH : C_BROAD, ao0: 0.5, ao1: 1.0,
    treeH: h, swayGain: 1.35, flut: 1.2, trans: 1.05,
    squash: 0.7, detail: cx.lod === 0 ? 1 : 0,
  }, rng);
}

function buildFern(b: Build, cx: BuildCtx, variant: number): void {
  const rng = cx.rng;
  const n = cx.lod === 0 ? 7 + Math.floor(rng() * 4) : 4;
  const s = 0.75 + variant * 0.25;
  for (let i = 0; i < n; i++) {
    const a = i * GOLD;
    const pitch = 0.45 + rng() * 0.55;
    _pa.set(0, 0.04, 0);
    _da.set(Math.cos(a) * Math.sin(pitch), Math.cos(pitch), Math.sin(a) * Math.sin(pitch));
    faceMatrix(_m1, _pa, _da, 0);
    const len = (0.75 + rng() * 0.5) * s;
    card(b, _m1, {
      w: len * 0.42, h: len, bow: len * 0.34, segs: 4, cell: C_FERN,
      toward: _sh.set(0, 1, 0), blend: 0.55, ao0: 0.42, ao1: 1.0,
      sway: 0.7, flut0: 0.4, flut1: 1.3, trans: 1.2,
    }, rng);
  }
}

function buildFlower(b: Build, cx: BuildCtx, variant: number): void {
  const rng = cx.rng;
  const n = cx.lod === 0 ? 3 : 2;
  const s = 0.7 + variant * 0.3;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI + rng() * 0.5;
    _pa.set((rng() - 0.5) * 0.14, 0, (rng() - 0.5) * 0.14);
    _da.set(Math.cos(a) * 0.12, 1, Math.sin(a) * 0.12).normalize();
    faceMatrix(_m1, _pa, _da, a);
    card(b, _m1, {
      w: 0.55 * s, h: 0.6 * s, bow: 0.05, segs: 2, cell: C_FLOWER,
      toward: _sh.set(0, 1, 0), blend: 0.6, ao0: 0.5, ao1: 1.0,
      sway: 0.5, flut0: 0.6, flut1: 1.4, trans: 1.0,
    }, rng);
  }
}

function buildReed(b: Build, cx: BuildCtx, variant: number): void {
  const rng = cx.rng;
  const n = cx.lod === 0 ? 3 : 2;
  const s = 0.9 + variant * 0.35;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI + rng() * 0.4;
    _pa.set((rng() - 0.5) * 0.2, -0.1, (rng() - 0.5) * 0.2);
    _da.set(Math.cos(a) * 0.1, 1, Math.sin(a) * 0.1).normalize();
    faceMatrix(_m1, _pa, _da, a);
    card(b, _m1, {
      w: 0.85 * s, h: 1.45 * s, bow: 0.1, segs: 3, cell: C_REED,
      toward: _sh.set(0, 1, 0), blend: 0.5, ao0: 0.4, ao1: 1.0,
      // Reeds are the most compliant thing in the world: they are the tell
      // that the wind is blowing at all when nothing else is moving.
      sway: 0.9, flut0: 0.8, flut1: 1.8, trans: 1.2,
    }, rng);
  }
}

function buildScrub(b: Build, cx: BuildCtx, variant: number): void {
  const rng = cx.rng;
  const h = 0.55 + rng() * 0.45 + variant * 0.12;
  // Dead twigs poking out of a low mound — the cliff and highland filler.
  for (let i = 0; i < (cx.lod === 0 ? 4 : 2); i++) {
    const a = i * GOLD;
    _pa.set(0, 0, 0);
    _da.set(Math.cos(a) * 0.7, 1, Math.sin(a) * 0.7).normalize();
    faceMatrix(_m1, _pa, _da, 0);
    trunk(b, _m1, {
      len: h * (0.8 + rng() * 0.6), r0: 0.032, r1: 0.008,
      leanX: 0, leanZ: h * 0.3, bow: 0.5, sides: 3, rings: 3,
      flare: 0.01, lobes: 3, cell: C_BARK_OAK, vRepeat: 1,
      ao0: 0.45, ao1: 0.85, sway0: 0, sway1: 1.0, cap: true,
    }, rng);
  }
  canopy(b, {
    cy: h * 0.55, rx: h * 0.72, ry: h * 0.38, rz: h * 0.70,
    clumps: cx.lod === 0 ? 3 : 2, clumpR: [h * 0.26, h * 0.42],
    cards: cx.lod === 0 ? 5 : 2, cardW: h * 0.5, cardH: h * 0.5, cardDroop: h * 0.12,
    cell: C_BROAD, ao0: 0.5, ao1: 1.0,
    treeH: h, swayGain: 1.2, flut: 1.1, trans: 0.9, squash: 0.6,
    detail: 0,
  }, rng);
}

/**
 * A mossy boulder.
 *
 * Not a rock from `props` — this is the one that grows things. The body takes
 * the oak-bark cell, which at a grey tint reads as lichen-crusted stone, and
 * the moss goes on the upward faces only, because moss grows where the water
 * sits. Moss on all sides is the giveaway that it was applied as a material
 * rather than as weather.
 */
function buildMossRock(b: Build, cx: BuildCtx, variant: number): void {
  const rng = cx.rng;
  const r = 0.55 + rng() * 0.9 + variant * 0.2;
  const src = new THREE.IcosahedronGeometry(r, cx.lod === 0 ? 1 : 0);
  const pos = src.getAttribute("position");
  const uv = cellUV(C_BARK_OAK);
  // Per-vertex deformation keyed off the direction, so shared corners agree
  // and the boulder stays watertight.
  const wob = (x: number, y: number, z: number): number =>
    1 + (hash2(Math.round(x * 97), Math.round(y * 89 + z * 71), 17) - 0.5) * 0.42;
  for (let f = 0; f < pos.count; f += 3) {
    const tri: number[] = [];
    for (let k = 0; k < 3; k++) {
      const i = f + k;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const s = wob(x, y, z);
      _bj.set(x, y, z).normalize();
      tri.push(b.vert(
        IDENT4,
        x * s, y * s * 0.72 + r * 0.3, z * s,
        _bj.x, _bj.y, _bj.z,
        uv.u0 + (x / r * 0.5 + 0.5) * uv.du,
        uv.v0 + (z / r * 0.5 + 0.5) * uv.dv,
        lerp(0.42, 1.0, clamp01(_bj.y * 0.5 + 0.5)), 0, 0, 0,
      ));
    }
    b.tri(tri[0], tri[1], tri[2]);
  }
  src.dispose();

  // Moss caps on the top, plus a skirt of it where the rock meets the ground.
  const caps = cx.lod === 0 ? 5 : 2;
  for (let i = 0; i < caps; i++) {
    const a = i * GOLD;
    const rr = rng() * 0.6;
    _m1.makeTranslation(Math.cos(a) * r * rr, r * (0.72 + rng() * 0.24), Math.sin(a) * r * rr);
    blob(b, _m1, r * (0.32 + rng() * 0.2), 0.42, 0, C_MOSS, 0.62, 1.0, 0, 0.1, 0.5, rng);
  }
  for (let i = 0; i < (cx.lod === 0 ? 6 : 3); i++) {
    const a = i * GOLD + rng() * 0.4;
    _pa.set(Math.cos(a) * r * 0.85, 0.02, Math.sin(a) * r * 0.85);
    _da.set(Math.cos(a) * 0.6, 1, Math.sin(a) * 0.6).normalize();
    faceMatrix(_m1, _pa, _da, 0);
    card(b, _m1, {
      w: r * 0.7, h: r * 0.55, bow: r * 0.2, segs: 2, cell: C_GRASS,
      toward: _sh.set(0, 1, 0), blend: 0.6, ao0: 0.4, ao1: 0.9,
      sway: 0.4, flut0: 0.5, flut1: 1.2, trans: 0.9, jitter: 0.4,
    }, rng);
  }
}

/** A fallen, hollowed, moss-covered log. Cover, and firewood. */
function buildLog(b: Build, cx: BuildCtx, variant: number): void {
  const rng = cx.rng;
  const len = 2.6 + rng() * 2.4 + variant * 0.4;
  const r = 0.24 + rng() * 0.14;
  _pa.set(-len * 0.5, r * 0.85, 0);
  _da.set(1, 0.06, 0).normalize();
  faceMatrix(_m1, _pa, _da, 0);
  trunk(b, _m1, {
    len, r0: r, r1: r * 0.72, leanX: 0, leanZ: 0, bow: 0.12,
    sides: Math.max(5, cx.tier.trunkSides - 1 - cx.lod),
    rings: Math.max(3, cx.tier.trunkRings - 1 - cx.lod),
    flare: r * 0.35, lobes: 4, cell: C_BARK_OAK,
    vRepeat: Math.max(2, Math.round(len * 0.4)),
    ao0: 0.5, ao1: 0.8, sway0: 0, sway1: 0, cap: true,
  }, rng);
  // Moss along the upper surface, thickest at the ends where damp collects.
  for (let i = 0; i < (cx.lod === 0 ? 7 : 3); i++) {
    const t = (i + 0.5) / (cx.lod === 0 ? 7 : 3);
    _m2.makeTranslation((t - 0.5) * len * 0.9, r * 1.45, (rng() - 0.5) * r * 0.5);
    blob(b, _m2, r * (0.5 + rng() * 0.3), 0.36, 0, C_MOSS, 0.6, 1.0, 0, 0.08, 0.5, rng);
  }
  // A couple of shelf fungi on the flank. Pure trim, and worth every triangle.
  if (cx.tier.trim && cx.lod === 0) {
    for (let i = 0; i < 3; i++) {
      const t = rng();
      _pa.set((t - 0.5) * len * 0.8, r * (0.4 + rng() * 0.6), r * 0.75);
      _da.set(0, 0.3, 1).normalize();
      faceMatrix(_m2, _pa, _da, 0);
      card(b, _m2, {
        w: 0.26, h: 0.16, bow: -0.05, segs: 1, cell: C_FLOWER,
        toward: _sh.set(0, 1, 0), blend: 0.8, ao0: 0.6, ao1: 0.95,
        sway: 0, flut0: 0, flut1: 0, trans: 0.4, jitter: 0.5,
      }, rng);
    }
  }
}

/**
 * A grass tuft: crossed blade cards.
 *
 * There are tens of thousands of these on screen, so the geometry is as small
 * as it can be while still having a cross-section — three cards at 60°, two
 * segments each, 12 triangles. Everything interesting about the grass field
 * happens in the wind shader and in the per-instance colour.
 */
function buildTuft(b: Build, cx: BuildCtx, variant: number): void {
  const rng = cx.rng;
  const planes = cx.lod === 0 ? 3 : 2;
  const h = 0.34 + variant * 0.14 + rng() * 0.16;
  const w = h * (1.5 + rng() * 0.5);
  for (let p = 0; p < planes; p++) {
    const a = (p / planes) * Math.PI + rng() * 0.3;
    _pa.set((rng() - 0.5) * 0.06, -0.02, (rng() - 0.5) * 0.06);
    _da.set(Math.cos(a) * 0.16, 1, Math.sin(a) * 0.16).normalize();
    faceMatrix(_m1, _pa, _da, a);
    card(b, _m1, {
      w, h, bow: h * 0.12, segs: 2, cell: C_GRASS,
      toward: _sh.set(0, 1, 0), blend: 0.62,
      // Dark at the root: the single cheapest way to make a grass field look
      // deep rather than like a green carpet with blades printed on it.
      ao0: 0.34, ao1: 1.0,
      sway: 0.55, flut0: 0.9, flut1: 2.1, trans: 1.15, jitter: 0.42,
    }, rng);
  }
}

/* ---- the table ----------------------------------------------------------- */

const SP_OAK = 0, SP_BROADLEAF = 1, SP_BIRCH = 2, SP_PINE = 3, SP_FIR = 4;
const SP_PALM = 5, SP_BUSH = 6, SP_FERN = 7, SP_FLOWER = 8, SP_REED = 9;
const SP_SCRUB = 10, SP_ROCK = 11, SP_LOG = 12, SP_TUFT = 13;

interface SpeciesDef {
  key: string;
  build: (b: Build, cx: BuildCtx, variant: number) => void;
  /** 2 = canopy tree (reaches the far band), 1 = mid plant, 0 = ground cover. */
  rank: 0 | 1 | 2;
  lods: number;
  variants: number;
  scale: [number, number];
  /** How far the plant tilts toward the ground normal. Trees stand up. */
  tilt: number;
  /** Per-instance wind compliance range. */
  wind: [number, number];
  /** Instance tint: base hue 0..1, saturation range, luminance range. */
  hue: number;
  sat: [number, number];
  lum: [number, number];
  /** Slot capacity per layer at density 1. */
  cap: number;
  shadow: boolean;
  /** Trunk collider: [radius, height] in local metres, or null. */
  collide: [number, number] | null;
}

const SPECIES: SpeciesDef[] = [
  {
    key: "oak", build: buildOak, rank: 2, lods: 3, variants: 3,
    scale: [0.85, 1.25], tilt: 0.05, wind: [0.35, 0.62],
    hue: 0.27, sat: [0.10, 0.26], lum: [0.66, 1.02], cap: 190, shadow: true,
    collide: [0.95, 4.2],
  },
  {
    key: "broadleaf", build: buildBroadleaf, rank: 2, lods: 3, variants: 3,
    scale: [0.78, 1.42], tilt: 0.07, wind: [0.45, 0.85],
    hue: 0.29, sat: [0.10, 0.30], lum: [0.60, 1.06], cap: 520, shadow: true,
    collide: [0.44, 3.2],
  },
  {
    key: "birch", build: buildBirch, rank: 2, lods: 3, variants: 3,
    scale: [0.80, 1.30], tilt: 0.05, wind: [0.60, 1.05],
    hue: 0.24, sat: [0.06, 0.20], lum: [0.78, 1.16], cap: 420, shadow: true,
    collide: [0.26, 3.2],
  },
  {
    key: "pine", build: buildPine, rank: 2, lods: 3, variants: 3,
    scale: [0.80, 1.35], tilt: 0.04, wind: [0.28, 0.52],
    hue: 0.37, sat: [0.08, 0.22], lum: [0.58, 0.94], cap: 520, shadow: true,
    collide: [0.44, 4.0],
  },
  {
    key: "fir", build: buildFir, rank: 2, lods: 3, variants: 2,
    scale: [0.75, 1.40], tilt: 0.06, wind: [0.30, 0.55],
    hue: 0.36, sat: [0.08, 0.24], lum: [0.56, 0.96], cap: 460, shadow: true,
    collide: [0.30, 2.4],
  },
  {
    key: "palm", build: buildPalm, rank: 2, lods: 3, variants: 3,
    scale: [0.78, 1.30], tilt: 0.12, wind: [0.65, 1.15],
    hue: 0.26, sat: [0.10, 0.26], lum: [0.72, 1.08], cap: 300, shadow: true,
    collide: [0.34, 3.0],
  },
  {
    key: "bush", build: buildBush, rank: 1, lods: 2, variants: 3,
    scale: [0.70, 1.60], tilt: 0.40, wind: [0.55, 1.0],
    hue: 0.28, sat: [0.10, 0.30], lum: [0.58, 1.05], cap: 900, shadow: true,
    collide: null,
  },
  {
    key: "fern", build: buildFern, rank: 1, lods: 2, variants: 2,
    scale: [0.70, 1.55], tilt: 0.55, wind: [0.6, 1.1],
    hue: 0.31, sat: [0.12, 0.30], lum: [0.55, 1.00], cap: 900, shadow: false,
    collide: null,
  },
  {
    key: "flower", build: buildFlower, rank: 1, lods: 1, variants: 2,
    scale: [0.75, 1.45], tilt: 0.60, wind: [0.5, 1.0],
    hue: 0.30, sat: [0.02, 0.10], lum: [0.90, 1.20], cap: 700, shadow: false,
    collide: null,
  },
  {
    key: "reed", build: buildReed, rank: 1, lods: 1, variants: 2,
    scale: [0.75, 1.55], tilt: 0.25, wind: [0.9, 1.5],
    hue: 0.23, sat: [0.10, 0.28], lum: [0.66, 1.10], cap: 900, shadow: false,
    collide: null,
  },
  {
    key: "scrub", build: buildScrub, rank: 1, lods: 1, variants: 2,
    scale: [0.70, 1.50], tilt: 0.70, wind: [0.5, 0.95],
    hue: 0.18, sat: [0.06, 0.20], lum: [0.72, 1.14], cap: 800, shadow: false,
    collide: null,
  },
  {
    key: "rock", build: buildMossRock, rank: 1, lods: 2, variants: 2,
    scale: [0.70, 1.80], tilt: 0.85, wind: [0, 0],
    hue: 0.28, sat: [0.0, 0.06], lum: [0.70, 1.10], cap: 340, shadow: true,
    collide: null,
  },
  {
    key: "log", build: buildLog, rank: 1, lods: 2, variants: 2,
    scale: [0.80, 1.35], tilt: 0.85, wind: [0, 0],
    hue: 0.10, sat: [0.02, 0.12], lum: [0.72, 1.08], cap: 160, shadow: true,
    collide: null,
  },
  {
    key: "tuft", build: buildTuft, rank: 0, lods: 1, variants: 3,
    scale: [0.72, 1.60], tilt: 0.90, wind: [0.9, 1.6],
    hue: 0.22, sat: [0.12, 0.34], lum: [0.58, 1.16], cap: 7000, shadow: false,
    collide: null,
  },
];

/* ------------------------------------------------------------------------ *
 * Material
 * ------------------------------------------------------------------------ */

/** Declarations shared by the surface shader and the shadow depth shader. */
const VEG_ATTRS = /* glsl */ `
attribute vec3 aFlex;    // x = trunk sway, y = leaf flutter, z = translucency
attribute vec2 aOrient;  // cos / sin of this instance's inverse yaw
attribute vec4 aWind;    // x = phase, y = compliance, zw = fade start / end
uniform float uTime;
uniform vec4 uWind;      // xy = direction, z = strength, w = time scale
`;

/**
 * The wind.
 *
 * Three motions, all driven off one per-instance phase so nothing in the world
 * moves in lockstep:
 *
 *  • A GUST FRONT. The phase is offset by the instance's own position
 *    projected onto the wind direction, so gusts *travel* — the treeline on
 *    the far ridge bends a beat before the one in front of you. A world where
 *    every tree breathes on the same clock reads as an animation loop; one
 *    where the gust moves reads as weather.
 *  • THE SWAY. The whole plant leans along the gust with a quadratic ramp up
 *    its height (`aFlex.x²`), and drops as it leans so a bending trunk pivots
 *    instead of stretching.
 *  • THE FLUTTER. Every leaf oscillates along its own length at roughly three
 *    times the frequency, phase-offset by its own position within the plant,
 *    so a canopy shimmers rather than swinging as a slab.
 *
 * `aOrient` is the cosine/sine of the instance's inverse yaw. Instance
 * matrices here are (yaw × uniform scale × translation), so rotating the
 * world-space gust into the instance's own space is a single 2D rotation — no
 * inverse matrix, no per-frame CPU work.
 */
const VEG_WIND = /* glsl */ `
  vec3 vegInst = vec3( 0.0 );
  #ifdef USE_INSTANCING
    vegInst = instanceMatrix[ 3 ].xyz;
  #endif
  // 0.0105 rad/m ≈ a 600 m gust front, which at the default time scale walks
  // across the island in about twelve seconds. Slower reads as a heaving sea,
  // faster as a vibration.
  float vegT = uTime * uWind.w + aWind.x - dot( vegInst.xz, uWind.xy ) * 0.0105;
  float vegGust = 0.55 + 0.45 * sin( vegT * 0.31 ) * sin( vegT * 0.127 + 1.3 );
  float vegAmp = uWind.z * aWind.y * vegGust;
  float vegS = sin( vegT ) * 0.66 + sin( vegT * 1.73 + 2.1 ) * 0.34;
  vec2 vegW = uWind.xy * ( vegS * vegAmp );
  vec2 vegL = vec2( vegW.x * aOrient.x - vegW.y * aOrient.y,
                    vegW.x * aOrient.y + vegW.y * aOrient.x );
  float vegBend = aFlex.x * aFlex.x;
  transformed.xz += vegL * vegBend * 2.4;
  transformed.y -= vegBend * length( vegL ) * 1.3;
  if ( aFlex.y > 0.001 ) {
    float vegF = vegT * 3.05 + transformed.x * 1.21 + transformed.z * 0.87 + transformed.y * 0.53;
    float vegFl = sin( vegF ) * 0.62 + sin( vegF * 1.91 + 1.1 ) * 0.38;
    transformed.y += vegFl * aFlex.y * ( 0.035 + 0.13 * vegAmp );
    transformed.xz += vegL * aFlex.y * 0.55;
  }
`;

export interface VegMaterials {
  main: THREE.MeshStandardMaterial;
  depth: THREE.MeshDepthMaterial;
  uTime: { value: number };
  uWind: { value: THREE.Vector4 };
  uTrans: { value: THREE.Color };
  uTransGain: { value: number };
  dispose(): void;
}

function makeMaterials(atlas: VegAtlas): VegMaterials {
  const uTime = { value: 0 };
  // Direction is normalised west-north-westerly; strength is in metres of tip
  // displacement per unit compliance, and 0.14 is a stiff breeze that still
  // lets a trunk read as wood.
  const uWind = { value: new THREE.Vector4(0.86, 0.51, 0.14, 1.0) };
  const uTrans = { value: new THREE.Color(0.58, 0.94, 0.34) };
  const uTransGain = { value: 1 };

  const main = new THREE.MeshStandardMaterial({
    map: atlas.albedo,
    normalMap: atlas.normal,
    roughnessMap: atlas.rough,
    roughness: 1,
    metalness: 0,
    alphaTest: ALPHA_TEST,
    // Foliage is single-sided geometry standing in for a two-sided leaf; the
    // back face has to render or every canopy is half missing from underneath.
    side: THREE.DoubleSide,
    shadowSide: THREE.DoubleSide,
    vertexColors: true,
    dithering: true,
  });
  main.normalScale.set(0.9, 0.9);
  main.name = "dz.vegetation";
  // Without a stable cache key three re-links the program every time a new
  // material instance appears; there is only one here, but the key also keeps
  // it from colliding with any other patched Standard material in the world.
  main.customProgramCacheKey = () => "dz-veg-surface";

  main.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uWind = uWind;
    shader.uniforms.uTrans = uTrans;
    shader.uniforms.uTransGain = uTransGain;

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", /* glsl */ `#include <common>
        ${VEG_ATTRS}
        varying float vVegTrans;
        varying float vVegFade;`)
      .replace("#include <begin_vertex>", /* glsl */ `#include <begin_vertex>
        vVegTrans = aFlex.z;
        ${VEG_WIND}`)
      .replace("#include <project_vertex>", /* glsl */ `#include <project_vertex>
        vVegFade = 1.0 - smoothstep( aWind.z, aWind.w, length( mvPosition.xyz ) );`);

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", /* glsl */ `#include <common>
        varying float vVegTrans;
        varying float vVegFade;
        uniform vec3 uTrans;
        uniform float uTransGain;
        // Ordered dither. Screen-door beats popping, and unlike alpha blending
        // it needs no sorting and still writes depth.
        float vegBayer2( vec2 a ) { a = floor( a ); return fract( a.x * 0.5 + a.y * a.y * 0.75 ); }
        float vegBayer4( vec2 a ) { return vegBayer2( a * 0.5 ) * 0.25 + vegBayer2( a ); }`)
      .replace("#include <clipping_planes_fragment>", /* glsl */ `#include <clipping_planes_fragment>
        if ( vVegFade < 0.997 && vegBayer4( gl_FragCoord.xy ) * 1.0667 > vVegFade ) discard;`)
      .replace("#include <lights_fragment_end>", /* glsl */ `#include <lights_fragment_end>
        #if ( NUM_DIR_LIGHTS > 0 )
        if ( vVegTrans > 0.01 ) {
          // Sub-surface transmission: forward scatter for the moment the sun
          // is directly behind a leaf, plus a wrap term so the shaded side
          // never goes flat black. This is the loudest golden-hour cue
          // vegetation has, and its absence is why so much web foliage reads
          // as dark green cardboard.
          vec3 vegLdir = directionalLights[ 0 ].direction;
          float vegBack = pow( clamp( dot( -geometryViewDir, vegLdir ), 0.0, 1.0 ), 3.0 );
          float vegWrap = clamp( ( dot( geometryNormal, vegLdir ) + 0.62 ) * 0.617, 0.0, 1.0 );
          reflectedLight.indirectDiffuse += directionalLights[ 0 ].color * uTrans
            * diffuseColor.rgb * vVegTrans * uTransGain * ( vegBack * 2.05 + vegWrap * 0.32 );
        }
        #endif`);
  };

  // The shadow pass runs the same wind, or every plant casts the shadow of a
  // plant standing perfectly still — which is more distracting than no shadow.
  const depth = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: atlas.albedo,
    alphaTest: ALPHA_TEST,
    side: THREE.DoubleSide,
  });
  depth.name = "dz.vegetation.depth";
  depth.customProgramCacheKey = () => "dz-veg-depth";
  depth.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uWind = uWind;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VEG_ATTRS}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${VEG_WIND}`);
  };

  return {
    main, depth, uTime, uWind, uTrans, uTransGain,
    dispose() {
      main.dispose();
      depth.dispose();
    },
  };
}

/* ------------------------------------------------------------------------ *
 * Instance pools
 * ------------------------------------------------------------------------ */
//
// One `InstancedMesh` per (species, variant, LOD). Slots come off a bump
// allocator and are released by swapping the last live instance down into the
// hole, so a cell leaving the streaming radius costs O(its own instances) and
// the draw call never has to skip over dead entries. The alternative — marking
// slots dead and letting the mesh render them at zero scale — costs vertex
// work forever for instances nobody can see.

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
  /** Which cell owns each slot, and that cell's index for the slot. */
  ownerCell: (VegCell | null)[];
  ownerIdx: Int32Array;
  /** Dirty range, so a frame that touches ten instances uploads ten. */
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
  // Instances are scattered over half a kilometre; one bounding sphere would
  // either cull the whole layer or never cull anything. The cell streamer is
  // the culling system here, and it culls in world space where it is cheap.
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
  if (last < 0) return;
  if (slot !== last) {
    moveSlot(l, last, slot);
    const owner = l.ownerCell[last];
    const oi = l.ownerIdx[last];
    l.ownerCell[slot] = owner;
    l.ownerIdx[slot] = oi;
    // Repoint the cell that owned the instance we just relocated, or its next
    // release will free a slot that belongs to somebody else.
    if (owner) owner.slots[oi] = slot;
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
  const push = (attr: THREE.BufferAttribute | THREE.InstancedBufferAttribute, size: number): void => {
    // `addUpdateRange` landed in r159; guard it so a pinned older three still
    // uploads (whole-buffer, but correct).
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

/** World-space value noise. Not tileable — nothing out here wraps. */
function wnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

/**
 * The forest field.
 *
 * Trees do not grow at a uniform density; they grow in woods with clearings
 * between them, and the clearings are where a battle royale actually fights.
 * Two octaves — 380 m for the woods themselves, 130 m to eat ragged bays into
 * their edges — because a wood with a smooth boundary reads as a texture
 * threshold, which is exactly what it is.
 */
function forestAt(x: number, z: number): number {
  const a = wnoise(x / 380, z / 380, 1301);
  const b = wnoise(x / 130, z / 130, 2609);
  return clamp01((a * 0.74 + b * 0.26 - 0.30) * 2.1);
}

type Biome = "marsh" | "shore" | "plain" | "wood" | "highland" | "cliff";

interface MixEntry {
  sp: number;
  w: number;
  /** Reject above this slope (slope = 1 - normal.y, so 0.30 is about 29°). */
  maxSlope: number;
  /** Multiply the weight by the forest field. Trees clump; scrub does not. */
  forest?: boolean;
}

type Mix = Record<Biome, MixEntry[]>;

/** Canopy trees, by biome. */
const MIX_TREE: Mix = {
  // Nothing with a trunk stands in standing water.
  marsh: [],
  shore: [
    { sp: SP_PALM, w: 10, maxSlope: 0.30 },
    { sp: SP_BROADLEAF, w: 1.4, maxSlope: 0.26, forest: true },
  ],
  plain: [
    { sp: SP_BROADLEAF, w: 7, maxSlope: 0.34, forest: true },
    { sp: SP_OAK, w: 1.1, maxSlope: 0.26, forest: true },
    { sp: SP_BIRCH, w: 3, maxSlope: 0.32, forest: true },
    { sp: SP_FIR, w: 1.2, maxSlope: 0.36, forest: true },
  ],
  wood: [
    { sp: SP_BROADLEAF, w: 8, maxSlope: 0.38, forest: true },
    { sp: SP_BIRCH, w: 5, maxSlope: 0.36, forest: true },
    { sp: SP_OAK, w: 1.6, maxSlope: 0.28, forest: true },
    { sp: SP_PINE, w: 3, maxSlope: 0.40, forest: true },
    { sp: SP_FIR, w: 3, maxSlope: 0.42, forest: true },
  ],
  highland: [
    { sp: SP_PINE, w: 10, maxSlope: 0.44, forest: true },
    { sp: SP_FIR, w: 6, maxSlope: 0.46, forest: true },
    { sp: SP_BIRCH, w: 1.4, maxSlope: 0.36, forest: true },
  ],
  cliff: [
    { sp: SP_PINE, w: 1.2, maxSlope: 0.52, forest: true },
  ],
};

/** The mid layer: everything between ankle and shoulder. */
const MIX_SHRUB: Mix = {
  marsh: [
    { sp: SP_REED, w: 14, maxSlope: 0.26 },
    { sp: SP_FERN, w: 2, maxSlope: 0.26 },
  ],
  shore: [
    { sp: SP_SCRUB, w: 5, maxSlope: 0.40 },
    { sp: SP_BUSH, w: 2, maxSlope: 0.34 },
    { sp: SP_ROCK, w: 1.4, maxSlope: 0.46 },
    { sp: SP_LOG, w: 0.5, maxSlope: 0.20 },
  ],
  plain: [
    { sp: SP_BUSH, w: 6, maxSlope: 0.36 },
    { sp: SP_FLOWER, w: 5, maxSlope: 0.30 },
    { sp: SP_FERN, w: 1.6, maxSlope: 0.34 },
    { sp: SP_ROCK, w: 1.0, maxSlope: 0.44 },
    { sp: SP_LOG, w: 0.4, maxSlope: 0.22 },
  ],
  wood: [
    { sp: SP_FERN, w: 8, maxSlope: 0.40 },
    { sp: SP_BUSH, w: 6, maxSlope: 0.40 },
    { sp: SP_LOG, w: 1.4, maxSlope: 0.24 },
    { sp: SP_ROCK, w: 1.6, maxSlope: 0.46 },
    { sp: SP_FLOWER, w: 1.6, maxSlope: 0.32 },
  ],
  highland: [
    { sp: SP_FERN, w: 4, maxSlope: 0.44 },
    { sp: SP_SCRUB, w: 5, maxSlope: 0.50 },
    { sp: SP_ROCK, w: 4, maxSlope: 0.52 },
    { sp: SP_LOG, w: 0.8, maxSlope: 0.26 },
  ],
  cliff: [
    { sp: SP_SCRUB, w: 6, maxSlope: 0.62 },
    { sp: SP_ROCK, w: 5, maxSlope: 0.66 },
  ],
};

/** Ground cover. One species, but the tint and scale ranges do a lot of work. */
const MIX_GRASS: Mix = {
  marsh: [{ sp: SP_TUFT, w: 8, maxSlope: 0.34 }],
  shore: [{ sp: SP_TUFT, w: 3, maxSlope: 0.40 }],
  plain: [{ sp: SP_TUFT, w: 10, maxSlope: 0.46 }],
  wood: [{ sp: SP_TUFT, w: 7, maxSlope: 0.46 }],
  highland: [{ sp: SP_TUFT, w: 6, maxSlope: 0.50 }],
  cliff: [{ sp: SP_TUFT, w: 1.2, maxSlope: 0.60 }],
};

/** How straw-coloured a biome's plants go. Drives the tint toward dry. */
const ARID: Record<Biome, number> = {
  marsh: 0, shore: 0.42, plain: 0.14, wood: 0, highland: 0.30, cliff: 0.55,
};

/** Record layout in a cell's flat number array. */
const R_SP = 0, R_VAR = 1, R_X = 2, R_Y = 3, R_Z = 4, R_YAW = 5, R_SCALE = 6;
const R_NX = 7, R_NZ = 8, R_R = 9, R_G = 10, R_B = 11, R_PHASE = 12, R_GAIN = 13;
const REC = 14;

interface VegCell {
  key: number;
  ox: number;
  oz: number;
  /** Currently placed LOD band, -1 = nothing placed. */
  band: number;
  generated: boolean;
  recs: number[];
  /** Parallel arrays: the pool slots this cell currently owns. */
  layerOf: number[];
  slots: number[];
  /** Collider removers, held only while the cell is inside the collider band. */
  removers: Array<() => void>;
  /**
   * Whether this cell was placed *with* colliders.
   *
   * Not inferred from `removers.length`: a cell inside the collider band that
   * happens to contain no trees registers nothing, and inferring from the
   * empty list would make the streamer decide every frame that the cell still
   * needs doing — an invisible infinite re-place that eats the whole budget.
   */
  withColliders: boolean;
  /** Frame stamp, for the out-of-range sweep. */
  stamp: number;
  dist: number;
}

interface GridDef {
  name: string;
  cell: number;
  radius: number;
  mix: Mix;
  /** Candidate spacing before density scaling, metres. */
  step: number;
  /** LOD band radii. An empty array means one band. */
  bands: number[];
  /** Instances fade out over the last this-many metres of the radius. */
  fade: number;
  /** Register trunk colliders for cells inside this radius. */
  colliders: number;
}

/* ------------------------------------------------------------------------ *
 * System
 * ------------------------------------------------------------------------ */

const WHITE = new THREE.Color(1, 1, 1);
/** Late-summer straw. Arid biomes lerp toward it rather than desaturating. */
const STRAW = new THREE.Color(1.0, 0.85, 0.50);
/** The transmission tint foliage scatters. Chlorophyll passes green. */
const LEAF_GREEN = new THREE.Color(0.58, 0.94, 0.34);

/**
 * Async only so the loading screen can repaint between the atlas bake and the
 * geometry bake. Nothing here awaits I/O — there is no I/O in this world.
 */
const createVegetation: SystemFactory = async (ctx: WorldCtx): Promise<System> => {
  const breathe = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const tier = TIERS[ctx.quality] ?? TIERS.high;

  const terrain = ctx.services.terrain as TerrainLike | undefined;
  if (!terrain) {
    // Every plant here is seated on the ground. Without a terrain service
    // there is no ground to seat them on, and a forest floating at y = 0 is
    // worse than no forest.
    console.warn("[Drop Zero] vegetation: no terrain service; the island ships bare.");
    return { name: "vegetation" };
  }

  const materials = ctx.services.materials;
  const pois: Poi[] = ctx.services.pois ?? [];

  /**
   * A private RNG.
   *
   * `ctx.rng` is shared and its call count depends on how much entropy the
   * systems that booted before us happened to draw, so using it directly would
   * move every tree on the island whenever an unrelated system changed. Same
   * reasoning as `props.ts`: determinism is the point, the source of it is not.
   */
  const SEED = 0x5eed1ea4;

  let maxAniso = tier.aniso;
  try {
    maxAniso = Math.min(tier.aniso, ctx.renderer.capabilities.getMaxAnisotropy());
  } catch {
    maxAniso = 1;
  }

  const atlas = buildAtlas(tier.atlas, maxAniso, makeRng(SEED ^ 0x9e3779b9), materials);
  if (!atlas) {
    console.warn("[Drop Zero] vegetation: no 2D canvas; nothing to plant with.");
    return { name: "vegetation" };
  }
  await breathe();
  const mats = makeMaterials(atlas);

  // ---- geometry, baked once ----------------------------------------------
  const root = new THREE.Group();
  root.name = "dz:vegetation";
  root.matrixAutoUpdate = false;
  ctx.scene.add(root);

  const layers: Layer[] = [];
  /** layerIndex[species][lod][variant] — variants collapse to one above LOD 0. */
  const layerIndex: number[][][] = [];
  /** Species index per layer. Only the boot census reads it. */
  const layerSpecies: number[] = [];
  let totalTris = 0;

  for (let sp = 0; sp < SPECIES.length; sp++) {
    const def = SPECIES[sp];
    const nVar = Math.max(1, Math.min(def.variants, tier.variants));
    const perLod: number[][] = [];
    for (let lod = 0; lod < def.lods; lod++) {
      const row: number[] = [];
      const nHere = lod === 0 ? nVar : 1;
      for (let v = 0; v < nHere; v++) {
        const b = new Build();
        const rng = makeRng((SEED ^ (sp * 2654435761) ^ (v * 40503) ^ (lod * 9176)) >>> 0);
        try {
          def.build(b, { tier, lod, rng }, v);
        } catch (err) {
          // One species that fails to bake costs that species, not the island.
          console.warn(`[Drop Zero] vegetation: ${def.key} v${v} lod${lod} failed`, err);
        }
        if (b.idx.length === 0) {
          row.push(-1);
          continue;
        }
        totalTris += b.tris;
        // Far bands hold far more instances than near ones — the area of the
        // annulus grows, and the geometry per instance shrinks — so capacity
        // follows the band rather than being flat.
        const capMul = lod === 0 ? 1 : lod === 1 ? 4.5 : 11;
        const cap = Math.max(24, Math.round(def.cap * capMul * Math.max(0.35, tier.density)));
        const layer = makeLayer(
          b.geometry(`dz.veg.${def.key}.${v}.${lod}`), mats.main, mats.depth, cap,
          tier.shadows && lod === 0 && def.shadow, `dz.veg.${def.key}.${v}.lod${lod}`,
        );
        root.add(layer.mesh);
        row.push(layers.length);
        layerSpecies.push(sp);
        layers.push(layer);
      }
      perLod.push(row);
    }
    layerIndex.push(perLod);
  }

  await breathe();

  function pickLayer(sp: number, variant: number, lod: number): number {
    const rows = layerIndex[sp];
    if (!rows || rows.length === 0) return -1;
    const l = Math.min(lod, rows.length - 1);
    const row = rows[l];
    if (!row || row.length === 0) return -1;
    return row[l === 0 ? Math.min(variant, row.length - 1) : 0];
  }

  // ---- world queries ------------------------------------------------------

  const _nrm = new THREE.Vector3();
  const _wts = new Float32Array(4);
  const seaLevel = terrain.seaLevel;

  const groundAt = (x: number, z: number): number => terrain.heightAt(x, z);
  const normalAt = (x: number, z: number): THREE.Vector3 => terrain.normalAt(x, z, _nrm);
  const slopeAt = (x: number, z: number): number =>
    terrain.slopeAt ? terrain.slopeAt(x, z) : 1 - terrain.normalAt(x, z, _nrm).y;
  const weightsAt = (x: number, z: number): Float32Array => {
    if (terrain.surfaceWeightsAt) return terrain.surfaceWeightsAt(x, z, _wts);
    // No splat published: guess from the impact material, which every terrain
    // has to provide. Coarse, but it keeps palms off the highlands.
    const m = terrain.materialAt(x, z);
    _wts[0] = m === "sand" ? 1 : 0;
    _wts[1] = m === "grass" ? 1 : 0;
    _wts[2] = m === "dirt" ? 1 : 0;
    _wts[3] = m === "concrete" ? 1 : 0;
    return _wts;
  };

  /**
   * Biome for a point.
   *
   * Order matters: the tests run from the most specific ground to the least,
   * because a shoreline that is also steep is a cliff and a highland shoulder
   * that is also sand is still a highland.
   */
  function classify(x: number, z: number, h: number, slope: number): Biome {
    const w = weightsAt(x, z);
    if (h < seaLevel + 0.9) return "marsh";
    // A rock splat on its own is NOT a cliff. The terrain paints rock over
    // flat highland shelves as readily as over crags — measured, four fifths
    // of the plateau comes back rock-dominant at a slope of 0.04 — and the
    // bare `w[3] > 0.58` test handed all of it to the cliff mix, which is one
    // sparse pine and some scrub. That is why the highlands came up bald in
    // the first captures. A cliff has to actually be steep.
    if (slope > 0.52 || (w[3] > 0.58 && slope > 0.26)) return "cliff";
    if (w[0] > 0.42 && h < 9) return "shore";
    if (h > 96) return "highland";
    return forestAt(x, z) > 0.42 ? "wood" : "plain";
  }

  // ---- POI + road exclusion ----------------------------------------------

  /**
   * A uniform hash grid of road samples.
   *
   * A linear scan over the road polyline is ~1300 distance tests per
   * candidate, and there are tens of thousands of candidates per streamed
   * cell — that is the difference between a 1 ms cell and a 200 ms hitch. The
   * grid turns it into nine bucket lookups.
   */
  const ROAD_BUCKET = 64;
  const roadGrid = new Map<number, number[]>();
  const roadPts: number[] = []; // x, z, halfWidth
  {
    const byName = new Map(pois.map((p) => [p.name, p]));
    const tmp = new THREE.Vector3();
    for (const [aName, bName, bow, width] of ROAD_LINKS) {
      const A = byName.get(aName), B = byName.get(bName);
      if (!A || !B) continue;
      const dx = B.center.x - A.center.x, dz = B.center.z - A.center.z;
      const len = Math.hypot(dx, dz);
      if (len < 40) continue;
      const px = -dz / len, pz = dx / len;
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(A.center.x, 0, A.center.z),
        new THREE.Vector3(A.center.x + dx * 0.33 + px * bow * 0.7, 0, A.center.z + dz * 0.33 + pz * bow * 0.7),
        new THREE.Vector3(A.center.x + dx * 0.67 + px * bow, 0, A.center.z + dz * 0.67 + pz * bow),
        new THREE.Vector3(B.center.x, 0, B.center.z),
      ], false, "centripetal", 0.5);
      const total = curve.getLength();
      const steps = Math.max(4, Math.round(total / 10));
      for (let i = 0; i <= steps; i++) {
        curve.getPoint(i / steps, tmp);
        const id = roadPts.length / 3;
        roadPts.push(tmp.x, tmp.z, width * 0.5);
        const bx = Math.floor(tmp.x / ROAD_BUCKET), bz = Math.floor(tmp.z / ROAD_BUCKET);
        for (let j = -1; j <= 1; j++) {
          for (let i2 = -1; i2 <= 1; i2++) {
            // Written into the neighbourhood rather than read from it: the
            // write happens once per sample, the read happens millions of
            // times, and this way a read is a single bucket fetch.
            const key = (bx + i2) * 100003 + (bz + j);
            let arr = roadGrid.get(key);
            if (!arr) { arr = []; roadGrid.set(key, arr); }
            arr.push(id);
          }
        }
      }
    }
  }

  function onRoad(x: number, z: number, margin: number): boolean {
    const key = Math.floor(x / ROAD_BUCKET) * 100003 + Math.floor(z / ROAD_BUCKET);
    const arr = roadGrid.get(key);
    if (!arr) return false;
    for (let i = 0; i < arr.length; i++) {
      const o = arr[i] * 3;
      const dx = x - roadPts[o], dz = z - roadPts[o + 1];
      const r = roadPts[o + 2] + margin;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  function inPoi(x: number, z: number, k: number): boolean {
    for (let i = 0; i < pois.length; i++) {
      const p = pois[i];
      const dx = x - p.center.x, dz = z - p.center.z;
      const r = p.radius * k;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  // ---- tinting ------------------------------------------------------------

  const _col = new THREE.Color();

  /**
   * Per-instance colour.
   *
   * Hue is jittered barely at all and value is jittered hard, which is the
   * right way round: a hue-shifted tree is a different species, a
   * value-shifted one is the same species in different light. The straw lerp
   * is what makes the shoreline and the cliff tops read as dry ground without
   * needing separate geometry.
   */
  function tintFor(def: SpeciesDef, rng: () => number, arid: number, out: number[]): void {
    const sat = lerp(def.sat[0], def.sat[1], rng());
    const lum = lerp(def.lum[0], def.lum[1], rng());
    _col.setHSL(def.hue + (rng() - 0.5) * 0.035, 1, 0.5);
    _col.lerp(WHITE, 1 - sat);
    if (arid > 0.01) _col.lerp(STRAW, arid * 0.36 * (0.6 + rng() * 0.7));
    _col.multiplyScalar(lum);
    out[0] = _col.r; out[1] = _col.g; out[2] = _col.b;
  }

  // ---- generation ---------------------------------------------------------

  const tint3 = [1, 1, 1];

  /**
   * Fill `out` with the records for one cell of one grid.
   *
   * Candidates come off a jittered lattice, which beats pure random sampling
   * for the same count: random placement clumps and leaves bald patches, and
   * both are more visible than the regularity a jittered lattice retains.
   * Three terrain samples per candidate (a height and a two-tap slope); the
   * accurate normal is only fetched for candidates that survive every test.
   */
  function scatter(out: number[], g: GridDef, ox: number, oz: number, rng: () => number): void {
    const base = g.step / Math.sqrt(Math.max(0.15, tier.density));
    const n = Math.max(1, Math.round(g.cell / base));
    const step = g.cell / n;

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = ox + (i + rng()) * step;
        const z = oz + (j + rng()) * step;

        const h = groundAt(x, z);
        // Reeds want the waterline; everything else wants to be out of it.
        if (h < seaLevel - 0.55 || h > 400) continue;

        const slope = slopeAt(x, z);
        const biome = classify(x, z, h, slope);
        const mix = g.mix[biome];
        if (!mix || mix.length === 0) continue;

        // A POI's footprint belongs to the district, and its verge belongs to
        // the props pass. Grass is allowed closer in — a district with a hard
        // circular edge of bare ground looks like a crop circle.
        const poiK = g.name === "grass" ? 0.86 : 1.0;
        if (inPoi(x, z, poiK)) continue;
        if (onRoad(x, z, g.name === "grass" ? 1.5 : ROAD_VERGE)) continue;

        const forest = forestAt(x, z);
        let total = 0;
        for (let k = 0; k < mix.length; k++) {
          const e = mix[k];
          if (slope > e.maxSlope) continue;
          total += e.forest ? e.w * forest : e.w;
        }
        if (total <= 0) continue;
        // The acceptance gate. Without it every lattice point that passes the
        // slope test grows something and the island is one unbroken thicket.
        const accept = g.name === "grass" ? 0.92 : Math.min(0.85, total / 12);
        if (rng() > accept) continue;

        let roll = rng() * total;
        let chosen = -1;
        for (let k = 0; k < mix.length; k++) {
          const e = mix[k];
          if (slope > e.maxSlope) continue;
          roll -= e.forest ? e.w * forest : e.w;
          if (roll <= 0) { chosen = e.sp; break; }
        }
        if (chosen < 0) continue;

        const def = SPECIES[chosen];
        // Marsh plants stand in the shallows; everything else stays dry.
        if (chosen !== SP_REED && h < seaLevel + 0.15) continue;
        if (chosen === SP_REED && (h > seaLevel + 1.4 || h < seaLevel - 0.5)) continue;

        const nrm = normalAt(x, z);
        const scale = lerp(def.scale[0], def.scale[1], Math.pow(rng(), 0.85));
        tintFor(def, rng, ARID[biome], tint3);

        const o = out.length;
        out.length = o + REC;
        out[o + R_SP] = chosen;
        out[o + R_VAR] = Math.floor(rng() * Math.max(1, Math.min(def.variants, tier.variants)));
        out[o + R_X] = x;
        // Sink everything a few centimetres. A plant whose base sits exactly on
        // the surface shows a sliver of daylight under it on any slope, and
        // that gap is the single most common giveaway in scattered foliage.
        out[o + R_Y] = h - 0.06 * scale;
        out[o + R_Z] = z;
        out[o + R_YAW] = rng() * TAU;
        out[o + R_SCALE] = scale;
        out[o + R_NX] = nrm.x;
        out[o + R_NZ] = nrm.z;
        out[o + R_R] = tint3[0];
        out[o + R_G] = tint3[1];
        out[o + R_B] = tint3[2];
        out[o + R_PHASE] = rng() * TAU;
        out[o + R_GAIN] = lerp(def.wind[0], def.wind[1], rng());
      }
    }
  }

  // ---- instance writing ---------------------------------------------------

  const collision = (): CollisionService | undefined => ctx.services.collision;
  const _pos = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _qa = new THREE.Quaternion();
  const _qb = new THREE.Quaternion();
  const _scl = new THREE.Vector3();
  const _mtx = new THREE.Matrix4();
  const _box = new THREE.Box3();
  let dirty = false;

  function placeOne(
    cell: VegCell, o: number, lod: number, fade0: number, fade1: number, withCollider: boolean,
  ): void {
    const sp = cell.recs[o + R_SP] | 0;
    const def = SPECIES[sp];
    const li = pickLayer(sp, cell.recs[o + R_VAR] | 0, lod);
    if (li < 0) return;
    const l = layers[li];
    // Pool full: drop it silently. A dropped instance in the far band is
    // invisible; a resized buffer mid-frame is a stall.
    if (l.count >= l.cap) return;
    const slot = l.count++;

    const yaw = cell.recs[o + R_YAW];
    const nx = cell.recs[o + R_NX], nz = cell.recs[o + R_NZ];
    const ny = Math.sqrt(Math.max(0.04, 1 - nx * nx - nz * nz));
    // Trees stand up whatever the ground does; grass and scrub lie with it.
    _up.set(nx * def.tilt, lerp(1, ny, def.tilt), nz * def.tilt).normalize();
    _qa.setFromUnitVectors(UP, _up);
    _qb.setFromAxisAngle(UP, yaw);
    _qa.multiply(_qb);
    _pos.set(cell.recs[o + R_X], cell.recs[o + R_Y], cell.recs[o + R_Z]);
    const scale = cell.recs[o + R_SCALE];
    _scl.setScalar(scale);
    _mtx.compose(_pos, _qa, _scl);

    l.mat.set(_mtx.elements, slot * 16);
    l.col[slot * 3] = cell.recs[o + R_R];
    l.col[slot * 3 + 1] = cell.recs[o + R_G];
    l.col[slot * 3 + 2] = cell.recs[o + R_B];
    // The inverse yaw, cached: the wind shader needs it at every vertex and
    // it never changes for the life of the instance.
    l.ori[slot * 2] = Math.cos(yaw);
    l.ori[slot * 2 + 1] = -Math.sin(yaw);
    l.wnd[slot * 4] = cell.recs[o + R_PHASE];
    l.wnd[slot * 4 + 1] = cell.recs[o + R_GAIN];
    l.wnd[slot * 4 + 2] = fade0;
    l.wnd[slot * 4 + 3] = fade1;

    l.ownerCell[slot] = cell;
    l.ownerIdx[slot] = cell.slots.length;
    touch(l, slot);
    cell.layerOf.push(li);
    cell.slots.push(slot);
    dirty = true;

    if (withCollider && def.collide) {
      const col = collision();
      if (col) {
        const r = def.collide[0] * scale;
        const hgt = def.collide[1] * scale;
        _box.min.set(_pos.x - r, _pos.y, _pos.z - r);
        _box.max.set(_pos.x + r, _pos.y + hgt, _pos.z + r);
        // Trunks only. Canopies never get a collider: bullets have to pass
        // through leaves or every treeline turns into a wall, and the pickaxe
        // only ever reaches the trunk anyway.
        cell.removers.push(col.addBox(_box.clone(), {
          material: "wood", harvest: "wood", tag: "tree",
        }));
      }
    }
  }

  function unplace(cell: VegCell): void {
    for (let i = 0; i < cell.slots.length; i++) {
      // Read the slot fresh each time: freeing an earlier one may have
      // relocated this one into a different hole.
      freeSlot(layers[cell.layerOf[i]], cell.slots[i]);
    }
    if (cell.slots.length) dirty = true;
    cell.layerOf.length = 0;
    cell.slots.length = 0;
    for (const r of cell.removers) r();
    cell.removers.length = 0;
    cell.withColliders = false;
    cell.band = -1;
  }

  // ---- the grids ----------------------------------------------------------

  const GRIDS: GridDef[] = [
    {
      name: "trees", cell: PLANT_CELL, radius: tier.plantRadius, mix: MIX_TREE,
      step: 9.5, bands: tier.bands, fade: tier.plantRadius * 0.16,
      colliders: tier.colliderRadius,
    },
    {
      name: "shrubs", cell: 48, radius: Math.min(tier.plantRadius, tier.bands[0] * 1.7),
      mix: MIX_SHRUB, step: 5.2, bands: [tier.bands[0] * 0.7],
      fade: Math.min(tier.plantRadius, tier.bands[0] * 1.7) * 0.22, colliders: 0,
    },
    {
      name: "grass", cell: GRASS_CELL, radius: tier.grassRadius, mix: MIX_GRASS,
      // 1.5 m of tuft spacing at density 1 puts roughly 260 tufts in a 24 m
      // cell, which is the point where the ground reads as covered rather than
      // as dotted. Below ~2 m it starts to look sparse from standing height.
      step: 1.5, bands: [],
      // A third of the radius: the dissolve has to be long enough that the
      // last tufts are already ghosts when they go, or the field visibly ends.
      fade: tier.grassRadius * 0.34, colliders: 0,
    },
  ];

  interface GridState {
    def: GridDef;
    cells: Map<number, VegCell>;
    live: VegCell[];
    pending: VegCell[];
    /** Diagnostics only: how much ground this grid has actually generated. */
    cellsGenerated: number;
    recordsGenerated: number;
  }

  const grids: GridState[] = GRIDS.map((def) => ({
    def, cells: new Map<number, VegCell>(), live: [], pending: [],
    cellsGenerated: 0, recordsGenerated: 0,
  }));

  let stamp = 0;

  /* ---- streaming pace ---------------------------------------------------- *
   *
   * `tier.budget` is authored as instances per frame *at 60 fps*, and two
   * things break that assumption. Both of them are real, and together they are
   * why the first captures photographed a bare island:
   *
   *  • A SLOW RENDERER. Under software rasterisation this world runs at about
   *    one frame a second. A per-frame budget then fills the island sixty
   *    times slower in wall-clock terms than it does on a GPU, so a harness
   *    that poses the camera and waits two and a half seconds gets two or
   *    three frames of streaming — roughly one grass cell — and screenshots
   *    bare ground. `dt` cannot be used to correct for it: the engine clamps
   *    dt to 1/15 so a stalled tab cannot tunnel the player, which means at
   *    1 fps dt under-reports by a factor of four. The real interval has to be
   *    measured directly.
   *  • A TELEPORT. The camera warps when the player lands, when a shot is
   *    posed, and whenever anything else moves it a kilometre in one frame.
   *    Every cell in range is new at once, and dribbling them in at the idle
   *    rate leaves the ground undressed for as long as it takes. Burst until
   *    the backlog is gone, then go back to idling.
   *
   * The governor is the wall clock, not the instance count: the deadline is a
   * fraction of the frame we are already spending, so this can take a 400 ms
   * bite of a 1 s software frame and only an 8 ms bite of a 60 fps one.
   */
  const nowMs = (): number =>
    typeof performance !== "undefined" ? performance.now() : Date.now();
  /** A camera move this big in one update is a warp, not a walk. */
  const WARP2 = 64 * 64;
  /** Budget multiplier while catching up after a warp. */
  const CATCHUP = 40;

  const _lastCam = new THREE.Vector3(Infinity, 0, Infinity);
  let lastTick = -1;
  let deadline = Infinity;
  /** Set by `updateGrid` when it leaves cells unplaced. */
  let backlog = false;

  function cellKey(ix: number, iz: number): number {
    // 16-bit signed range per axis is ±32 km of cells; the island is ±1.5 km.
    return ((ix & 0xffff) << 16) | (iz & 0xffff);
  }

  function bandFor(def: GridDef, dist: number): number {
    for (let i = 0; i < def.bands.length; i++) if (dist < def.bands[i]) return i;
    return def.bands.length;
  }

  /**
   * One grid's turn.
   *
   * Three phases: stamp everything in range, retire everything that is not,
   * then spend the budget on the nearest cell whose placed band is wrong.
   * Nearest-first is what makes a fast traverse degrade gracefully — the
   * ground you are about to run onto is generated before the ridge behind you.
   */
  function updateGrid(g: GridState, camX: number, camZ: number, budget: number): number {
    const def = g.def;
    const size = def.cell;
    const r = def.radius;
    const i0 = Math.floor((camX - r) / size), i1 = Math.floor((camX + r) / size);
    const j0 = Math.floor((camZ - r) / size), j1 = Math.floor((camZ + r) / size);
    const rr = (r + size * 0.72) * (r + size * 0.72);

    g.pending.length = 0;
    for (let jz = j0; jz <= j1; jz++) {
      for (let ix = i0; ix <= i1; ix++) {
        const ox = ix * size, oz = jz * size;
        const dx = camX - (ox + size * 0.5), dz = camZ - (oz + size * 0.5);
        const d2 = dx * dx + dz * dz;
        if (d2 > rr) continue;
        const key = cellKey(ix, jz);
        let cell = g.cells.get(key);
        if (!cell) {
          cell = {
            key, ox, oz, band: -1, generated: false, recs: [],
            layerOf: [], slots: [], removers: [], withColliders: false,
            stamp: 0, dist: 0,
          };
          g.cells.set(key, cell);
        }
        cell.stamp = stamp;
        cell.dist = Math.sqrt(d2);
        const want = bandFor(def, cell.dist);
        const wantColliders = def.colliders > 0 && cell.dist < def.colliders;
        // A cell whose band is right but whose collider state is wrong still
        // has to be redone: the collider band and the near band are different
        // radii, and a player walking outward has to keep the trunks they can
        // still reach with a pickaxe.
        if (cell.band !== want || (cell.band >= 0 && cell.withColliders !== wantColliders)) {
          g.pending.push(cell);
        }
      }
    }

    // Retire whatever fell out of range this frame.
    for (let i = g.live.length - 1; i >= 0; i--) {
      const cell = g.live[i];
      if (cell.stamp === stamp) continue;
      unplace(cell);
      g.live[i] = g.live[g.live.length - 1];
      g.live.pop();
      // Records are kept: regenerating a cell the player is walking back and
      // forth across is pure waste, and a cell's records are a few kB.
    }

    if (g.pending.length === 0) return 0;
    g.pending.sort((a, c) => a.dist - c.dist);

    let spent = 0;
    let i = 0;
    for (; i < g.pending.length && spent < budget; i++) {
      // Checked every fourth cell rather than every cell: `now()` is cheap but
      // not free, and a cell is already the unit of work here.
      if ((i & 3) === 3 && nowMs() > deadline) break;
      const cell = g.pending[i];
      if (!cell.generated) {
        const rng = makeRng((SEED ^ (cell.key * 2654435761) ^ (def.name.length * 7919)) >>> 0);
        try {
          scatter(cell.recs, def, cell.ox, cell.oz, rng);
        } catch (err) {
          console.warn("[Drop Zero] vegetation: scatter failed", err);
          cell.recs.length = 0;
        }
        cell.generated = true;
        g.cellsGenerated++;
        g.recordsGenerated += cell.recs.length / REC;
        // Generation is the expensive half. Charge it, so a frame that
        // generates three dense cells does not also place four hundred
        // instances on top.
        spent += cell.recs.length / REC;
      }
      const wasLive = cell.band >= 0;
      if (wasLive) unplace(cell);
      const band = bandFor(def, cell.dist);
      const withColliders = def.colliders > 0 && cell.dist < def.colliders;
      // Only the outermost band dissolves. Inner bands are replaced in place
      // by the next one out at the same distance, so there is nothing there to
      // fade *to* — the LOD swap is a swap, and the impostor is authored to
      // match the silhouette it replaces.
      const last = band >= def.bands.length;
      const fade0 = last ? def.radius - def.fade : 1e6;
      const fade1 = last ? def.radius : 1e6 + 1;
      for (let o = 0; o < cell.recs.length; o += REC) {
        placeOne(cell, o, band, fade0, fade1, withColliders);
      }
      cell.band = band;
      cell.withColliders = withColliders;
      if (!wasLive) g.live.push(cell);
      spent += cell.recs.length / REC;
    }
    // Anything left in `pending` is ground the player can see that has not
    // been dressed yet. Saying so is what keeps the burst running.
    if (i < g.pending.length) backlog = true;
    return spent;
  }

  // ---- lifecycle ----------------------------------------------------------

  ctx.emit("dz:vegetation-ready", {
    layers: layers.length,
    triangles: totalTris,
    atlas: tier.atlas,
    species: SPECIES.length,
  });
  console.info(
    `[Drop Zero] vegetation: baked ${layers.length} layers, ` +
    `${totalTris} triangles, ${tier.atlas}px atlas, quality "${ctx.quality}".`,
  );

  /* ---- the census -------------------------------------------------------- *
   *
   * A scatter system that plants nothing fails silently: the root is in the
   * scene, the layers are in the root, the draw calls are simply never issued
   * because every `InstancedMesh.count` is zero, and no error is thrown
   * anywhere. That cost this world a whole capture round. So the first time
   * the streamer settles, say out loud what actually went into the ground —
   * and if the answer is nothing, say that louder still, with the numbers that
   * distinguish "generated nothing" from "generated records and placed none".
   */
  let censusDone = false;
  let censusClock = 0;
  const _cp = new THREE.Vector3();
  const _cbox = new THREE.Box3();

  function census(): void {
    censusDone = true;
    const per = new Map<string, number>();
    let total = 0;
    _cbox.makeEmpty();
    for (let li = 0; li < layers.length; li++) {
      const l = layers[li];
      const key = SPECIES[layerSpecies[li]].key;
      per.set(key, (per.get(key) ?? 0) + l.count);
      total += l.count;
      for (let s = 0; s < l.count; s++) {
        const o = s * 16;
        _cbox.expandByPoint(_cp.set(l.mat[o + 12], l.mat[o + 13], l.mat[o + 14]));
      }
    }
    const gridLine = grids
      .map((g) => `${g.def.name} ${g.cellsGenerated} cells/${Math.round(g.recordsGenerated)} recs`)
      .join(", ");
    if (total === 0) {
      console.warn(
        "[Drop Zero] vegetation: PLANTED NOTHING. " +
        `camera (${_cam.x.toFixed(0)}, ${_cam.z.toFixed(0)}), ` +
        `ground ${terrain.heightAt(_cam.x, _cam.z).toFixed(1)} m, ` +
        `sea ${seaLevel.toFixed(1)} m, ${gridLine}. ` +
        "Records with no instances means the pools or the LOD lookup; " +
        "no records means the scatter rules rejected every candidate.",
      );
      return;
    }
    const bySpecies = [...per.entries()]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    const b = _cbox;
    console.info(
      `[Drop Zero] vegetation: ${total} instances placed — ${bySpecies}. ` +
      `bounds (${b.min.x.toFixed(0)}, ${b.min.y.toFixed(0)}, ${b.min.z.toFixed(0)}) → ` +
      `(${b.max.x.toFixed(0)}, ${b.max.y.toFixed(0)}, ${b.max.z.toFixed(0)}). ${gridLine}.`,
    );
  }

  const _cam = new THREE.Vector3();
  const _sun = new THREE.Vector3();
  let disposed = false;
  let windClock = 0;

  const sys: System = {
    name: "vegetation",

    /**
     * Streaming runs on the render clock, not the fixed clock.
     *
     * Nothing here is simulation — no plant integrates a velocity, and the
     * only gameplay-visible state is the trunk colliders, which follow the
     * camera rather than the physics. Running a 121-cell sweep at 120 Hz would
     * burn six times the CPU for a result nobody can see.
     */
    update(dt, c) {
      if (disposed) return;

      // --- wind ------------------------------------------------------------
      mats.uTime.value += dt;
      windClock += dt;
      // A slow envelope on top of the shader's own gust, so the whole island
      // has calm minutes and blustery ones. 0.037 Hz ≈ a 27 s cycle.
      const breeze = 0.72 + 0.28 * Math.sin(windClock * 0.233) * Math.sin(windClock * 0.0913 + 2.1);
      mats.uWind.value.z = 0.14 * breeze;

      // --- light -----------------------------------------------------------
      const sky = c.services.sky as SkyService | undefined;
      if (sky) {
        // Transmission takes the sun's own colour, pulled most of the way
        // toward leaf green. At dawn that turns the canopy edges amber, which
        // is exactly what a low sun through leaves does.
        mats.uTrans.value.copy(sky.sunColor).lerp(LEAF_GREEN, 0.62);
        // Fade the term out with the sun: back-lighting at midnight is a
        // glowing bush, and a glowing bush is worse than a dark one.
        _sun.copy(sky.sunDirection);
        mats.uTransGain.value = clamp01(sky.daylight * 1.15) * clamp01(0.25 + _sun.y * 2.2);
      }

      // --- streaming -------------------------------------------------------
      _cam.copy(c.camera.position);

      // The honest frame interval. `dt` is clamped by the engine and lies at
      // low frame rates, which is exactly the case this has to get right.
      const t0 = nowMs();
      const realDt = lastTick < 0 ? 1 / 60 : Math.min(2, (t0 - lastTick) * 0.001);
      lastTick = t0;
      // A warp starts a burst; the burst runs until every grid is caught up,
      // so it survives however many frames the refill actually needs.
      if (_lastCam.distanceToSquared(_cam) > WARP2) backlog = true;
      _lastCam.copy(_cam);
      const catchUp = backlog;
      const scale = catchUp ? CATCHUP : Math.min(CATCHUP, Math.max(1, realDt * 60));
      let budget = Math.round(tier.budget * scale);
      // Never more than a fixed slice of the frame we are already spending:
      // 8 ms of a 60 fps frame, 400 ms of a one-second software frame. This,
      // not the instance count, is what actually stops a runaway refill.
      deadline = t0 + Math.min(400, Math.max(8, realDt * 400));

      backlog = false;
      // Grass first: it is the layer the player's own feet are standing in,
      // and it is the one that has to keep up during a sprint.
      let gi = grids.length - 1;
      for (; gi >= 0 && budget > 0; gi--) {
        budget -= updateGrid(grids[gi], _cam.x, _cam.z, budget);
        if (nowMs() > deadline) { gi--; break; }
      }
      // Grids the budget never reached still owe work.
      if (gi >= 0) backlog = true;
      stamp++;

      if (dirty) {
        for (let i = 0; i < layers.length; i++) flushLayer(layers[i]);
        dirty = false;
      }

      if (!censusDone) {
        censusClock += dt;
        // Report on the first settle — but not before the world has had a
        // chance to stream at all, and not while the camera is still out over
        // the sea in the bus, where planting nothing is the correct answer.
        if (!backlog && censusClock > 1 && terrain.heightAt(_cam.x, _cam.z) > seaLevel) census();
        else if (censusClock > 25) census();
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      // Retire every collider before anything else: a stale box in the
      // broadphase is a tree you can walk into on the next world.
      for (const g of grids) {
        for (const cell of g.live) {
          for (const r of cell.removers) r();
          cell.removers.length = 0;
        }
        g.cells.clear();
        g.live.length = 0;
        g.pending.length = 0;
      }
      // Pull the group before the engine's deep-disposer can walk it — the
      // atlas textures are ours and get disposed exactly once, here.
      root.parent?.remove(root);
      for (const l of layers) {
        l.mesh.geometry.dispose();
        l.mesh.dispose();
      }
      layers.length = 0;
      root.clear();
      mats.dispose();
      atlas.dispose();
    },
  };

  return sys;
};

export default createVegetation;
