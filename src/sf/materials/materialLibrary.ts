/**
 * materialLibrary — the cached PBR material registry for
 * San Francisco: FREE FALL.
 *
 * Every surface in the city asks this module for its material. Nothing else
 * constructs a `MeshStandardMaterial` with a flat colour, because a flat
 * colour is a bug report (see ART_DIRECTION.md §4).
 *
 * The contract
 * ------------
 *   getMaterial(kind, opts) -> MeshStandardMaterial | MeshPhysicalMaterial
 *
 * Every material returned carries, at minimum, `map`, `normalMap`,
 * `roughnessMap` and `aoMap`, plus `metalnessMap` and `emissiveMap` where the
 * surface earns them. `roughness` and `metalness` are pinned to 1 on the
 * material so the *maps* are absolute rather than modulating an arbitrary
 * scalar — that way "wet asphalt is 0.08 rough in the puddles and 0.62 on the
 * crown of the road" is a fact about the texture, not a tuning fight between
 * two systems.
 *
 * ORM packing: three samples ao from `.r`, roughness from `.g`, metalness from
 * `.b`. One packed texture is bound to all three slots, so a material costs
 * three uploads (albedo / normal / ORM), not five.
 *
 * Caching: textures are keyed by (kind, tier, variant) and shared. Materials
 * are keyed by everything that changes a uniform. Tinting goes through
 * `material.color` rather than through a re-bake, which is why the stucco,
 * painted-brick, car-paint and plastic albedos are deliberately near-neutral.
 */
import * as THREE from "three";
import { QUALITY, type QualityTier } from "../config";
import { clamp01, makeRng, smoothstep, type Rng } from "../math/rng";
import {
  AlbedoBuffer,
  aoFromHeight,
  addField,
  blurField,
  clampField,
  contrastField,
  crackField,
  copyField,
  curvatureFromHeight,
  decalField,
  edgeWearMask,
  fbmField,
  fieldOf,
  flipRaster,
  grimeField,
  hexRgb,
  invertField,
  macroVariationRaster,
  mulField,
  normalFromHeight,
  packORM,
  patchField,
  rasterTexture,
  ridgedField,
  stainField,
  streakField,
  thresholdField,
  warpField,
  whiteNoiseField,
  worleyField,
  type Field,
  type Raster,
} from "./textureGen";
import {
  applyDetailBlend,
  applyTriplanar,
  type DetailOptions,
  type TriplanarOptions,
} from "./triplanar";

/* ================================================================== *
 * Kinds
 * ================================================================== */

export type MaterialKind =
  | "asphalt"
  | "asphalt-wet"
  | "concrete-sidewalk"
  | "concrete-cast"
  | "brick-red"
  | "brick-painted"
  | "stucco"
  | "wood-siding"
  | "victorian-trim"
  | "glass-curtainwall"
  | "glass-window-lit"
  | "steel-painted"
  | "steel-rusted"
  | "corrugated-metal"
  | "roof-tar-gravel"
  | "roof-tile"
  | "terracotta"
  | "marble-civic"
  | "sand"
  | "grass"
  | "foliage"
  | "chainlink"
  | "road-marking-paint"
  | "rubber-tyre"
  | "car-paint"
  | "chrome"
  | "plastic";

/* ================================================================== *
 * Budget
 * ================================================================== */

/**
 * Texture resolution per tier. "Hero" surfaces are the ones the player's face
 * spends the most time against — road, pavement, brick, stucco — and they get
 * double the budget.
 *
 * Note that Ultra does not simply scale everything up: past ~1024 the wins come
 * from anisotropic filtering, the detail layer and more noise octaves, not from
 * raw texels, and 2048² albedo+normal+ORM for thirty materials is a third of a
 * gigabyte of VRAM for a difference nobody can see.
 */
const SIZE_TABLE: Record<QualityTier, { hero: number; std: number }> = {
  low: { hero: 256, std: 128 },
  medium: { hero: 512, std: 256 },
  high: { hero: 512, std: 512 },
  ultra: { hero: 1024, std: 512 },
};

let activeTier: QualityTier = "high";

/** Set the tier new materials are generated at. Does not re-bake existing ones. */
export function setMaterialTier(tier: QualityTier): void {
  activeTier = tier;
}

export function getMaterialTier(): QualityTier {
  return activeTier;
}

function octavesFor(size: number): number {
  return Math.max(3, Math.round(Math.log2(size)) - 4);
}

/* ================================================================== *
 * Build context + intermediate representation
 * ================================================================== */

interface BuildCtx {
  size: number;
  rng: Rng;
  /** Metres covered by one tile of this texture. */
  world: number;
  octaves: number;
  tier: QualityTier;
  variant: number;
}

interface Built {
  albedo: AlbedoBuffer;
  /** 0..1 height, used for normals + AO + cavity/edge masks. */
  height: Field;
  /** Absolute roughness. */
  rough: Field | number;
  metal?: Field | number;
  /** Override the derived AO. */
  ao?: Field;
  emissive?: AlbedoBuffer;
  /** Normal map intensity multiplier. */
  normalStrength?: number;
}

export interface TextureSet {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  /** Packed ao(.r)/roughness(.g)/metalness(.b) — bound to all three slots. */
  ormMap: THREE.DataTexture;
  emissiveMap: THREE.DataTexture | null;
  size: number;
  /** Metres covered by one tile. */
  worldScale: number;
  /** Mean albedo luminance — the pivot the detail-blend shader normalises by. */
  pivot: number;
  hasAlpha: boolean;
}

/* ================================================================== *
 * Small shared generators
 * ================================================================== */

/** Distance (in pixels) to the nearest line of a `cells`-wide grid. */
function gridJoint(size: number, cellsX: number, cellsY: number, widthPx: number): Field {
  const out = new Float32Array(size * size);
  const bx = size / cellsX;
  const by = size / cellsY;
  const w = Math.max(0.75, widthPx);
  for (let y = 0; y < size; y++) {
    const fy = y / by;
    const dy = Math.min(fy - Math.floor(fy), 1 - (fy - Math.floor(fy))) * by;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const fx = x / bx;
      const dx = Math.min(fx - Math.floor(fx), 1 - (fx - Math.floor(fx))) * bx;
      const d = Math.min(dx, dy);
      out[row + x] = 1 - smoothstep(w * 0.5, w * 0.5 + 1.4, d);
    }
  }
  return out;
}

interface BondResult {
  /** 1 inside the mortar joint, 0 on the brick face. */
  mortar: Field;
  /** Stable 0..1 random per brick. */
  id: Field;
  /** Local coordinates within a brick, 0..1. */
  u: Field;
  v: Field;
  /** Distance to the nearest brick edge, normalised by half the short side. */
  edge: Field;
}

/** Running-bond masonry layout. Tileable as long as `cols` is even. */
function runningBond(
  size: number,
  cols: number,
  rows: number,
  mortarPx: number,
  rng: Rng,
): BondResult {
  const n = size * size;
  const mortar = new Float32Array(n);
  const id = new Float32Array(n);
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const edge = new Float32Array(n);
  const bw = size / cols;
  const bh = size / rows;
  const table = new Float32Array(cols * rows);
  for (let i = 0; i < table.length; i++) table[i] = rng.next();
  const half = Math.min(bw, bh) * 0.5;

  for (let y = 0; y < size; y++) {
    const fr = y / bh;
    const r = Math.floor(fr);
    const vy = fr - r;
    const off = (r & 1) * 0.5 * bw;
    const row = y * size;
    const rr = ((r % rows) + rows) % rows;
    for (let x = 0; x < size; x++) {
      const xs = x + off;
      const fc = xs / bw;
      const c = Math.floor(fc);
      const ux = fc - c;
      const i = row + x;
      const dx = Math.min(ux, 1 - ux) * bw;
      const dy = Math.min(vy, 1 - vy) * bh;
      const d = Math.min(dx, dy);
      mortar[i] = 1 - smoothstep(mortarPx * 0.5, mortarPx * 0.5 + 1.2, d);
      const cc = ((c % cols) + cols) % cols;
      id[i] = table[rr * cols + cc];
      u[i] = ux;
      v[i] = vy;
      edge[i] = clamp01(d / half);
    }
  }
  return { mortar, id, u, v, edge };
}

/** Fine surface grain — the layer that stops anything reading as plastic. */
function grain(size: number, seed: string, freq = 3, octaves = 2): Field {
  return fbmField(size, {
    period: Math.max(4, Math.round(size / freq)),
    octaves,
    gain: 0.6,
    seed,
  });
}

/** Mixes a set of palette colours by a 0..1 selector field. */
function paletteMix(buf: AlbedoBuffer, colors: number[], sel: Field): void {
  const rgbs = colors.map(hexRgb);
  const last = rgbs.length - 1;
  for (let i = 0; i < sel.length; i++) {
    const t = clamp01(sel[i]) * last;
    const a = Math.min(last, Math.floor(t));
    const b = Math.min(last, a + 1);
    const f = t - a;
    buf.r[i] = rgbs[a].r + (rgbs[b].r - rgbs[a].r) * f;
    buf.g[i] = rgbs[a].g + (rgbs[b].g - rgbs[a].g) * f;
    buf.b[i] = rgbs[a].b + (rgbs[b].b - rgbs[a].b) * f;
  }
}

/** Roughness field from a base value plus fields that push it either way. */
function roughness(
  size: number,
  base: number,
  terms: Array<{ f: Field; amount: number }> = [],
): Field {
  const out = new Float32Array(size * size).fill(base);
  for (const t of terms) {
    for (let i = 0; i < out.length; i++) out[i] = clamp01(out[i] + t.f[i] * t.amount);
  }
  return out;
}

/* ================================================================== *
 * Recipes
 * ================================================================== */

/* ---------------- Asphalt ---------------- */

function buildAsphalt(c: BuildCtx, wet: boolean): Built {
  const { size, rng } = c;
  const n = size * size;

  // Aggregate: at 8 m per tile a chip of asphalt is one or two texels, so the
  // "stones" are really a high-frequency field. The detail layer is what makes
  // individual chips visible from a metre away.
  const fine = grain(size, "asphalt:fine", 3, 2);
  const mid = fbmField(size, { period: 22, octaves: c.octaves, seed: "asphalt:mid" });
  const macro = fbmField(size, { period: 3, octaves: 3, gain: 0.55, seed: "asphalt:macro" });

  // Cracks propagate roughly every 2.5 m in a tired SF street.
  const cracks = crackField(size, {
    period: Math.max(2, Math.round(c.world / 2.5)),
    width: 0.03,
    coverage: 0.55,
    detail: true,
    seed: "asphalt:cracks",
  });
  // Utility trenches, patched and never quite matching.
  const patch = patchField(size, {
    period: Math.max(2, Math.round(c.world / 3.5)),
    coverage: 0.34,
    feather: 0.05,
    seed: "asphalt:patch",
  });
  const oil = stainField(size, {
    count: 7,
    radiusMin: 0.03,
    radiusMax: 0.11,
    raggedness: 0.75,
    seed: "asphalt:oil",
  });
  const scuff = decalField(size, { count: 26, radius: 0.02, seed: "asphalt:scuff" });

  const a = new AlbedoBuffer(size, 0x3a3a3c);
  a.modulate(fine, 0.34);
  a.modulate(mid, 0.22);
  a.modulate(macro, 0.26);
  // Fresh patches are darker and bluer than sun-bleached old surface.
  for (let i = 0; i < n; i++) {
    const m = patch.mask[i];
    if (m <= 0) continue;
    const age = patch.tone[i];
    const t = m * 0.85;
    const tr = 0.155 + age * 0.09;
    const tg = 0.155 + age * 0.09;
    const tb = 0.17 + age * 0.085;
    a.r[i] += (tr - a.r[i]) * t;
    a.g[i] += (tg - a.g[i]) * t;
    a.b[i] += (tb - a.b[i]) * t;
  }
  a.lerpTo(0x151516, cracks, 0.85);
  a.lerpTo(0x121110, oil, 0.7);
  a.lerpTo(0x2a2a2b, scuff, 0.35);

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] = clamp01(
      0.45 + (fine[i] - 0.5) * 0.55 + (mid[i] - 0.5) * 0.2 - cracks[i] * 0.55 + patch.edge[i] * 0.25,
    );
  }

  const rough = roughness(size, 0.93, [
    { f: mid, amount: -0.1 },
    { f: oil, amount: -0.28 },
    { f: patch.mask, amount: -0.06 },
    { f: scuff, amount: -0.12 },
  ]);

  if (!wet) {
    return { albedo: a, height, rough, metal: 0, normalStrength: 1.15 };
  }

  /* Wet variant. Water pools where the surface is low, so the puddle mask is
   * driven by the height field itself rather than by an unrelated noise — that
   * is what makes puddles sit in the wheel ruts and along the gutter line
   * instead of floating over the crown of the road. */
  const lowness = new Float32Array(n);
  const smoothH = blurField(height, size, Math.max(2, size / 64), 2);
  for (let i = 0; i < n; i++) lowness[i] = 1 - smoothH[i];
  const puddleNoise = fbmField(size, { period: 4, octaves: 4, seed: "asphalt:puddle" });
  const puddle = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    puddle[i] = smoothstep(0.5, 0.78, lowness[i] * 0.55 + puddleNoise[i] * 0.65);
  }
  // Wet asphalt is dramatically darker: water fills the pores, kills the
  // diffuse bounce, and the surface goes almost specular.
  for (let i = 0; i < n; i++) {
    const damp = 0.42 + 0.28 * (1 - puddle[i]);
    a.r[i] *= damp;
    a.g[i] *= damp;
    a.b[i] *= damp;
    // Standing water reads faintly cool from the sky it reflects.
    a.b[i] += puddle[i] * 0.012;
  }
  const wetRough = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    wetRough[i] = clamp01(rough[i] * (0.62 - puddle[i] * 0.5) + puddle[i] * 0.03);
  }
  // Flatten the micro-relief under standing water; a puddle has a flat surface.
  const wetHeight = new Float32Array(n);
  for (let i = 0; i < n; i++) wetHeight[i] = height[i] + (smoothH[i] - height[i]) * puddle[i] * 0.9;

  return { albedo: a, height: wetHeight, rough: wetRough, metal: 0, normalStrength: 0.9 };
}

/* ---------------- Concrete ---------------- */

function buildSidewalk(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  // SF pavement is scored into ~1.5 m squares; at 6 m per tile that is 4x4.
  const cells = Math.max(2, Math.round(c.world / 1.5));
  const joint = gridJoint(size, cells, cells, size / 220);
  // Every fourth score line is a real expansion joint — wider, deeper, filled.
  const expansion = gridJoint(size, cells / 2, cells / 2, size / 130);

  const fine = grain(size, "walk:fine", 2.5, 2);
  const aggregate = worleyField(size, {
    period: Math.round(size / 6),
    seed: "walk:agg",
    jitter: 1,
  });
  const mid = fbmField(size, { period: 14, octaves: c.octaves, seed: "walk:mid" });
  const macro = fbmField(size, { period: 2, octaves: 3, seed: "walk:macro" });
  const cracks = crackField(size, {
    period: Math.max(3, Math.round(c.world / 1.2)),
    width: 0.022,
    coverage: 0.32,
    seed: "walk:cracks",
  });
  const repair = patchField(size, {
    period: Math.max(2, Math.round(c.world / 2.2)),
    coverage: 0.2,
    feather: 0.04,
    seed: "walk:repair",
  });
  const gum = decalField(size, { count: 34, radius: 0.006, jaggedness: 0.3, seed: "walk:gum" });
  const water = stainField(size, {
    count: 9,
    radiusMin: 0.05,
    radiusMax: 0.16,
    strength: 0.6,
    seed: "walk:water",
  });

  // Broom finish: fine parallel drag marks, only visible up close.
  const broom = fbmField(size, {
    period: [3, Math.round(size / 2.2)],
    octaves: 2,
    seed: "walk:broom",
  });

  const a = new AlbedoBuffer(size, 0x9c988f);
  a.modulate(macro, 0.2);
  a.modulate(mid, 0.16);
  a.modulate(fine, 0.16);
  a.modulate(broom, 0.07);
  // Exposed aggregate: pale chips of stone showing through the cement paste.
  const chips = new Float32Array(n);
  for (let i = 0; i < n; i++) chips[i] = smoothstep(0.34, 0.06, aggregate.f1[i]) * aggregate.cell[i];
  a.lerpTo(0xc3bcae, chips, 0.35);
  for (let i = 0; i < n; i++) {
    const m = repair.mask[i];
    if (m <= 0) continue;
    const t = m * 0.8;
    const g = 0.5 + repair.tone[i] * 0.16;
    a.r[i] += (g - a.r[i]) * t;
    a.g[i] += (g * 0.99 - a.g[i]) * t;
    a.b[i] += (g * 0.96 - a.b[i]) * t;
  }
  a.lerpTo(0x5e5a54, joint, 0.75);
  a.lerpTo(0x46433e, expansion, 0.8);
  a.lerpTo(0x3d3a36, cracks, 0.7);
  a.lerpTo(0x2a2724, gum, 0.72);
  a.lerpTo(0x6f6a62, water, 0.35);

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] = clamp01(
      0.62 +
        (fine[i] - 0.5) * 0.22 +
        chips[i] * 0.1 +
        (broom[i] - 0.5) * 0.06 -
        joint[i] * 0.45 -
        expansion[i] * 0.55 -
        cracks[i] * 0.35 +
        repair.edge[i] * 0.12,
    );
  }
  const rough = roughness(size, 0.9, [
    { f: chips, amount: -0.12 },
    { f: water, amount: -0.1 },
    { f: gum, amount: -0.3 },
    { f: repair.mask, amount: 0.04 },
  ]);
  return { albedo: a, height, rough, metal: 0, normalStrength: 1.0 };
}

function buildCastConcrete(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  // Board-formed: 150 mm boards leave horizontal lines and a grain impression.
  const boards = Math.max(4, Math.round(c.world / 0.15));
  const boardLine = gridJoint(size, 1, boards, size / 300);
  const boardTone = new Float32Array(n);
  const boardRng = makeRng("concrete:boards");
  const boardTable = new Float32Array(boards);
  for (let i = 0; i < boards; i++) boardTable[i] = boardRng.next();
  for (let y = 0; y < size; y++) {
    const b = Math.floor((y / size) * boards) % boards;
    const v = boardTable[b];
    for (let x = 0; x < size; x++) boardTone[y * size + x] = v;
  }
  // Wood grain pressed into the face.
  const woodGrain = fbmField(size, {
    period: [Math.round(size / 2.5), 5],
    octaves: 3,
    seed: "concrete:grain",
  });

  // Snap-tie holes on a 600 x 1200 grid.
  const tieX = Math.max(2, Math.round(c.world / 0.6));
  const tieY = Math.max(2, Math.round(c.world / 1.2));
  const ties = new Float32Array(n);
  const rTie = (size / tieX) * 0.09;
  for (let y = 0; y < size; y++) {
    const gy = (y / size) * tieY;
    const dy = (gy - Math.round(gy)) * (size / tieY);
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * tieX;
      const dx = (gx - Math.round(gx)) * (size / tieX);
      const d = Math.sqrt(dx * dx + dy * dy);
      ties[y * size + x] = 1 - smoothstep(rTie * 0.6, rTie, d);
    }
  }

  const fine = grain(size, "concrete:fine", 2.6, 2);
  const mid = fbmField(size, { period: 9, octaves: c.octaves, seed: "concrete:mid" });
  const macro = fbmField(size, { period: 2, octaves: 4, seed: "concrete:macro" });
  // Bug holes — the trapped air bubbles every cast wall has.
  const bug = worleyField(size, { period: Math.round(size / 10), seed: "concrete:bug" });
  const bugholes = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    bugholes[i] = smoothstep(0.3, 0.05, bug.f1[i]) * (bug.cell[i] > 0.62 ? 1 : 0);
  }
  // Rain wash off the top of the pour.
  const streaks = streakField(size, {
    count: Math.round(size / 5),
    startMin: 0,
    startMax: 0.14,
    lengthMin: 0.25,
    lengthMax: 0.95,
    widthMin: 0.002,
    widthMax: 0.016,
    strength: 0.85,
    seed: "concrete:streaks",
  });
  const efflor = stainField(size, {
    count: 8,
    radiusMin: 0.05,
    radiusMax: 0.2,
    strength: 0.55,
    seed: "concrete:efflor",
  });

  const a = new AlbedoBuffer(size, 0x94918a);
  a.modulate(macro, 0.22);
  a.modulate(mid, 0.15);
  a.modulate(fine, 0.13);
  a.modulate(boardTone, 0.1);
  a.modulate(woodGrain, 0.06);
  a.lerpTo(0x6d6a64, boardLine, 0.55);
  a.lerpTo(0x5c5952, bugholes, 0.65);
  a.lerpTo(0x5a5750, ties, 0.6);
  a.lerpTo(0x4c4a45, streaks, 0.4);
  a.lerpTo(0xcfcbc0, efflor, 0.4);

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] = clamp01(
      0.68 +
        (fine[i] - 0.5) * 0.14 +
        (woodGrain[i] - 0.5) * 0.1 -
        boardLine[i] * 0.3 -
        bugholes[i] * 0.5 -
        ties[i] * 0.45,
    );
  }
  const rough = roughness(size, 0.86, [
    { f: streaks, amount: 0.07 },
    { f: efflor, amount: 0.08 },
    { f: bugholes, amount: 0.06 },
  ]);
  return { albedo: a, height, rough, metal: 0, normalStrength: 0.95 };
}

/* ---------------- Masonry ---------------- */

interface BrickOpts {
  painted: boolean;
  paint?: number;
}

function buildBrick(c: BuildCtx, o: BrickOpts): Built {
  const { size, rng } = c;
  const n = size * size;
  // Modular brick: 194x57 mm plus 10 mm joints. Eight bricks across the tile
  // keeps the running bond seamless (cols must be even).
  const cols = 8;
  const rows = 24;
  const mortarPx = Math.max(1.2, (size / c.world) * 0.011);
  const bond = runningBond(size, cols, rows, mortarPx, rng.fork("bond"));

  const fine = grain(size, "brick:fine", 2.4, 2);
  const sandy = fbmField(size, { period: Math.round(size / 6), octaves: 2, seed: "brick:sand" });
  const macro = fbmField(size, { period: 2, octaves: 4, seed: "brick:macro" });

  // Per-brick pillowing: a fired brick is not flat, it bulges very slightly.
  const pillow = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const du = Math.sin(bond.u[i] * Math.PI);
    const dv = Math.sin(bond.v[i] * Math.PI);
    pillow[i] = Math.pow(du * dv, 0.55);
  }

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] = clamp01(
      0.72 +
        pillow[i] * 0.07 +
        (fine[i] - 0.5) * 0.09 +
        (sandy[i] - 0.5) * 0.05 -
        bond.mortar[i] * 0.55,
    );
  }
  // Chipped arrises where the brick meets the joint.
  const chips = new Float32Array(n);
  const chipNoise = fbmField(size, { period: Math.round(size / 8), octaves: 2, seed: "brick:chip" });
  for (let i = 0; i < n; i++) {
    const nearEdge = 1 - smoothstep(0.02, 0.16, bond.edge[i]);
    chips[i] = nearEdge * smoothstep(0.62, 0.86, chipNoise[i]) * (bond.id[i] > 0.55 ? 1 : 0.25);
    height[i] -= chips[i] * 0.16;
  }

  const a = new AlbedoBuffer(size);
  if (!o.painted) {
    // Fired-clay colour is bimodal — most bricks cluster around two tones with
    // a handful of dark over-fired headers. That is what stops brickwork from
    // looking like a gradient.
    const sel = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = bond.id[i];
      sel[i] = clamp01(t * 0.75 + macro[i] * 0.35 - 0.05);
    }
    paletteMix(a, [0x6d3a2e, 0x8a4634, 0x9d5741, 0x7c4030, 0xa9694c, 0x5c3129], sel);
    a.modulate(pillow, 0.12, 0.5);
    a.modulate(fine, 0.2);
    a.modulate(sandy, 0.14);
    a.modulate(macro, 0.14);
    a.lerpTo(0x9a9184, chips, 0.45);
    // Lime mortar: pale, matte, and much lighter than people remember.
    a.lerpTo(0xb2ac9d, bond.mortar, 0.92);
  } else {
    const paint = o.paint ?? 0xdedad0;
    a.fill(paint);
    a.modulate(macro, 0.1);
    a.modulate(fine, 0.09);
    // Paint bridges the joints but still sinks into them.
    a.lerpTo(0xc9c4b8, bond.mortar, 0.45);
    // Failure: paint blisters and flakes, exposing the brick beneath. It goes
    // first on the proud arrises and the sun-baked upper wall.
    const peel = patchField(size, {
      period: Math.max(3, Math.round(c.world / 0.4)),
      coverage: 0.16,
      feather: 0.12,
      seed: "brick:peel",
    });
    const wear = edgeWearMask(height, size, Math.max(1, size / 200), 0.55);
    const exposed = new Float32Array(n);
    for (let y = 0; y < size; y++) {
      const sun = 0.55 + 0.75 * (1 - y / (size - 1)); // top of the wall fails first
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        exposed[i] = clamp01((peel.mask[i] * 0.85 + wear[i] * 0.35) * sun);
      }
    }
    const under = new AlbedoBuffer(size);
    const sel = new Float32Array(n);
    for (let i = 0; i < n; i++) sel[i] = clamp01(bond.id[i] * 0.8 + macro[i] * 0.3);
    paletteMix(under, [0x7a4232, 0x8d4c39, 0x66362a, 0x9b5c45], sel);
    for (let i = 0; i < n; i++) {
      const t = exposed[i];
      if (t <= 0) continue;
      a.r[i] += (under.r[i] - a.r[i]) * t;
      a.g[i] += (under.g[i] - a.g[i]) * t;
      a.b[i] += (under.b[i] - a.b[i]) * t;
      height[i] += peel.edge[i] * 0.05;
    }
  }

  // Grime: rain-borne dirt collects in the joints and at the foot of the wall,
  // and rusty efflorescence runs down from the sills above.
  const grime = grimeField(height, size, { seed: "brick:grime", baseBias: 0.55, amount: 0.85 });
  const streaks = streakField(size, {
    count: Math.round(size / 7),
    startMin: 0,
    startMax: 0.2,
    lengthMin: 0.2,
    lengthMax: 0.85,
    widthMin: 0.003,
    widthMax: 0.018,
    strength: 0.8,
    seed: "brick:streaks",
  });
  const salts = stainField(size, {
    count: 6,
    radiusMin: 0.04,
    radiusMax: 0.16,
    strength: 0.5,
    seed: "brick:salts",
  });
  a.lerpTo(0x2e2a26, grime, 0.34);
  a.lerpTo(0x3a342e, streaks, 0.3);
  a.lerpTo(0xd6d0c2, salts, 0.32);

  const rough = roughness(size, o.painted ? 0.58 : 0.86, [
    { f: bond.mortar, amount: o.painted ? 0.06 : 0.09 },
    { f: grime, amount: 0.08 },
    { f: chips, amount: 0.08 },
    { f: pillow, amount: o.painted ? -0.08 : -0.04 },
  ]);
  return { albedo: a, height, rough, metal: 0, normalStrength: 1.35 };
}

/* ---------------- Stucco ---------------- */

function buildStucco(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  // Troweled render: a sand-float finish is domain-warped noise, full stop.
  // Straight fbm reads as "noise"; warping it by a second field gives you the
  // arcs a plasterer's float actually leaves.
  const base = fbmField(size, { period: Math.round(size / 9), octaves: 3, seed: "stucco:base" });
  const wx = fbmField(size, { period: 5, octaves: 3, seed: "stucco:wx" });
  const wy = fbmField(size, { period: 5, octaves: 3, seed: "stucco:wy" });
  const trowel = warpField(base, size, wx, wy, size * 0.05);
  const sand = grain(size, "stucco:sand", 2.2, 2);
  const macro = fbmField(size, { period: 2, octaves: 4, seed: "stucco:macro" });

  const cracks = crackField(size, {
    period: Math.max(3, Math.round(c.world / 0.5)),
    width: 0.016,
    coverage: 0.28,
    detail: true,
    seed: "stucco:cracks",
  });
  const repair = patchField(size, {
    period: Math.max(2, Math.round(c.world / 1.4)),
    coverage: 0.16,
    feather: 0.14,
    seed: "stucco:repair",
  });
  const streaks = streakField(size, {
    count: Math.round(size / 9),
    startMin: 0,
    startMax: 0.12,
    lengthMin: 0.3,
    lengthMax: 0.95,
    widthMin: 0.004,
    widthMax: 0.022,
    strength: 0.7,
    seed: "stucco:streaks",
  });

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] = clamp01(
      0.6 + (trowel[i] - 0.5) * 0.4 + (sand[i] - 0.5) * 0.22 - cracks[i] * 0.45 + repair.edge[i] * 0.1,
    );
  }

  // Deliberately near-white: district palettes tint this through material.color,
  // which is how the Sunset gets forty shades of pastel from one bake.
  const a = new AlbedoBuffer(size, 0xe9e4da);
  a.modulate(trowel, 0.13);
  a.modulate(sand, 0.1);
  a.modulate(macro, 0.15);
  for (let i = 0; i < n; i++) {
    const m = repair.mask[i] * 0.7;
    if (m <= 0) continue;
    const g = 0.86 + repair.tone[i] * 0.1;
    a.r[i] += (g - a.r[i]) * m;
    a.g[i] += (g * 0.985 - a.g[i]) * m;
    a.b[i] += (g * 0.96 - a.b[i]) * m;
  }
  a.lerpTo(0x9b968c, cracks, 0.5);
  const grime = grimeField(height, size, { seed: "stucco:grime", baseBias: 0.6, amount: 0.7 });
  a.lerpTo(0x8a857a, grime, 0.3);
  a.lerpTo(0x8f8a80, streaks, 0.28);

  const rough = roughness(size, 0.82, [
    { f: sand, amount: 0.08 },
    { f: grime, amount: 0.07 },
    { f: streaks, amount: 0.05 },
    { f: repair.mask, amount: -0.05 },
  ]);
  return { albedo: a, height, rough, metal: 0, normalStrength: 0.85 };
}

/* ---------------- Timber ---------------- */

function buildWoodSiding(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  const boards = Math.max(4, Math.round(c.world / 0.15));
  const bh = size / boards;

  // Clapboard: each board laps the one below, so the bottom edge throws a hard
  // shadow line. That shadow is the entire read of a Victorian from 50 m.
  const lap = new Float32Array(n);
  const boardV = new Float32Array(n);
  const boardId = new Float32Array(n);
  const rngB = makeRng("wood:boards");
  const table = new Float32Array(boards);
  for (let i = 0; i < boards; i++) table[i] = rngB.next();
  for (let y = 0; y < size; y++) {
    const f = (y / size) * boards;
    const b = Math.floor(f) % boards;
    const v = f - Math.floor(f);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      boardV[i] = v;
      boardId[i] = table[b];
      // Board face ramps out toward its bottom edge, then drops away.
      lap[i] = v < 0.9 ? 0.25 + v * 0.75 : 0.25 + (1 - (v - 0.9) / 0.1) * 0.75;
    }
  }

  const grainF = fbmField(size, {
    period: [Math.round(size / 2.2), 4],
    octaves: 4,
    kind: "ridged",
    seed: "wood:grain",
  });
  const fine = grain(size, "wood:fine", 2.5, 2);
  const macro = fbmField(size, { period: 2, octaves: 3, seed: "wood:macro" });

  // Nails on studs every 400 mm.
  const studs = Math.max(2, Math.round(c.world / 0.4));
  const nails = new Float32Array(n);
  const rNail = Math.max(1, (size / c.world) * 0.006);
  for (let y = 0; y < size; y++) {
    const v = boardV[y * size];
    const dyBoard = (v - 0.3) * bh;
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * studs;
      const dx = (gx - Math.round(gx)) * (size / studs);
      const d = Math.sqrt(dx * dx + dyBoard * dyBoard);
      nails[y * size + x] = 1 - smoothstep(rNail * 0.7, rNail * 1.3, d);
    }
  }

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] = clamp01(
      lap[i] * 0.72 + (grainF[i] - 0.5) * 0.07 + (fine[i] - 0.5) * 0.05 - nails[i] * 0.2,
    );
  }

  // Near-white so the painted-lady palette can be applied per building.
  const a = new AlbedoBuffer(size, 0xe4dfd4);
  a.modulate(boardId, 0.09);
  a.modulate(grainF, 0.09);
  a.modulate(fine, 0.07);
  a.modulate(macro, 0.12);
  a.lerpTo(0x6e685e, nails, 0.5);

  // Paint failure on timber: it cracks along the grain and lifts at the laps.
  const peel = patchField(size, {
    period: Math.max(3, Math.round(c.world / 0.35)),
    coverage: 0.12,
    feather: 0.2,
    seed: "wood:peel",
  });
  for (let i = 0; i < n; i++) {
    const t = peel.mask[i] * 0.7;
    if (t <= 0) continue;
    a.r[i] += (0.44 - a.r[i]) * t;
    a.g[i] += (0.36 - a.g[i]) * t;
    a.b[i] += (0.27 - a.b[i]) * t;
    height[i] -= peel.edge[i] * 0.06;
  }
  const grime = grimeField(height, size, { seed: "wood:grime", baseBias: 0.4, amount: 0.6 });
  a.lerpTo(0x8d887c, grime, 0.26);

  const rough = roughness(size, 0.48, [
    { f: peel.mask, amount: 0.42 },
    { f: grime, amount: 0.16 },
    { f: grainF, amount: 0.05 },
  ]);
  return { albedo: a, height, rough, metal: 0, normalStrength: 1.5 };
}

function buildVictorianTrim(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  // A horizontal ornament band: cyma at the top, dentils, bead-and-reel, then a
  // fielded panel. Drawn analytically into the height field so the normal map
  // carries the whole profile — a distant Victorian never needs the geometry.
  const height = new Float32Array(n);
  const bandId = new Float32Array(n);
  const dentils = Math.max(4, Math.round(c.world / 0.09));
  const beads = Math.max(4, Math.round(c.world / 0.055));

  for (let y = 0; y < size; y++) {
    const v = y / (size - 1); // 0 = top
    let h = 0.5;
    let band = 0;
    if (v < 0.1) {
      // Crown moulding: cyma recta, convex over concave.
      const t = v / 0.1;
      h = 0.55 + 0.45 * Math.sin(t * Math.PI * 0.9);
      band = 0.1;
    } else if (v < 0.16) {
      h = 0.42; // fillet / soffit shadow
      band = 0.2;
    } else if (v < 0.3) {
      h = 0.78; // dentil course carrier
      band = 0.3;
    } else if (v < 0.36) {
      h = 0.5;
      band = 0.4;
    } else if (v < 0.44) {
      h = 0.86; // bead-and-reel
      band = 0.5;
    } else if (v < 0.52) {
      h = 0.46;
      band = 0.6;
    } else if (v < 0.94) {
      h = 0.66; // fielded panel
      band = 0.7;
    } else {
      h = 0.4; // base fillet
      band = 0.8;
    }
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      let hh = h;
      if (band === 0.3) {
        // Dentils: square blocks with gaps.
        const f = u * dentils;
        const fr = f - Math.floor(f);
        hh = fr < 0.58 ? 0.92 : 0.52;
        const edge = Math.min(fr, 0.58 - fr) * dentils * 6;
        hh -= (1 - clamp01(edge)) * 0.05;
      } else if (band === 0.5) {
        // Bead-and-reel: alternating spheres and discs.
        const f = u * beads;
        const fr = f - Math.floor(f);
        const idx = Math.floor(f) % 3;
        const s = Math.sin(fr * Math.PI);
        hh = idx === 2 ? 0.72 + s * 0.1 : 0.78 + Math.pow(s, 0.6) * 0.22;
      } else if (band === 0.7) {
        // Fielded panel with a chamfered border.
        const px = Math.min(u, 1 - u);
        const pv = (v - 0.52) / 0.42;
        const pyd = Math.min(pv, 1 - pv);
        const inset = smoothstep(0.0, 0.06, Math.min(px, pyd * 0.4));
        hh = 0.55 + inset * 0.2;
      }
      height[i] = hh;
      bandId[i] = band;
    }
  }

  const fine = grain(size, "trim:fine", 2.6, 2);
  const brush = fbmField(size, {
    period: [Math.round(size / 3), 6],
    octaves: 2,
    seed: "trim:brush",
  });
  for (let i = 0; i < n; i++) height[i] = clamp01(height[i] + (fine[i] - 0.5) * 0.05);

  const a = new AlbedoBuffer(size, 0xf0ece2);
  a.modulate(brush, 0.06);
  a.modulate(fine, 0.05);
  const ao = aoFromHeight(height, size, { strength: 1.25 });
  // Dust and soot settle on every upward-facing ledge of a cornice.
  const ledge = new Float32Array(n);
  for (let y = 1; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      ledge[i] = clamp01((height[i] - height[i - size]) * 6);
    }
  }
  const grime = grimeField(height, size, { seed: "trim:grime", amount: 0.7 });
  a.lerpTo(0x8b8478, ledge, 0.3);
  a.lerpTo(0x9a9488, grime, 0.22);

  const rough = roughness(size, 0.36, [
    { f: grime, amount: 0.3 },
    { f: ledge, amount: 0.22 },
    { f: brush, amount: 0.06 },
  ]);
  return { albedo: a, height, rough, metal: 0, ao, normalStrength: 2.2 };
}

/* ---------------- Glass ---------------- */

interface GlassOpts {
  lit: boolean;
}

function buildGlass(c: BuildCtx, o: GlassOpts): Built {
  const { size } = c;
  const n = size * size;
  const panesX = 2;
  const panesY = 1;
  const mullionPx = Math.max(1.5, (size / c.world) * 0.075);
  const mull = gridJoint(size, panesX, panesY, mullionPx);
  // Pane-local coordinates for the bow and for per-pane randomisation.
  const pu = new Float32Array(n);
  const pv = new Float32Array(n);
  const pid = new Float32Array(n);
  const rngP = makeRng("glass:panes");
  const table = new Float32Array(panesX * panesY * 8);
  for (let i = 0; i < table.length; i++) table[i] = rngP.next();
  // Panes repeat across the tile, so vary them with a low-frequency field
  // instead of a per-cell table (which would repeat every tile).
  const paneVar = fbmField(size, { period: panesX * 3, octaves: 2, seed: "glass:var" });
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * panesY;
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * panesX;
      const i = y * size + x;
      pu[i] = fx - Math.floor(fx);
      pv[i] = fy - Math.floor(fy);
      pid[i] = paneVar[i];
    }
  }

  // Insulated glazing units are never flat: pressure differences bow them, and
  // that is exactly why real curtain walls have that rippling reflection.
  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const bow = Math.sin(pu[i] * Math.PI) * Math.sin(pv[i] * Math.PI);
    height[i] = clamp01(
      0.5 + bow * (0.1 + pid[i] * 0.14) * (1 - mull[i]) + mull[i] * 0.42,
    );
  }
  const dirt = streakField(size, {
    count: Math.round(size / 10),
    startMin: 0,
    startMax: 0.1,
    lengthMin: 0.15,
    lengthMax: 0.6,
    widthMin: 0.002,
    widthMax: 0.01,
    strength: 0.5,
    seed: "glass:dirt",
  });
  const fine = grain(size, "glass:fine", 2.5, 2);

  const a = new AlbedoBuffer(size);
  if (!o.lit) {
    // Daytime curtain wall: what you see is reflectance plus the dark interior.
    // Transmission is deliberately not used — it costs a full extra render pass
    // and buys nothing when the interior is a black box anyway.
    for (let i = 0; i < n; i++) {
      const t = pid[i];
      const r = 0.045 + t * 0.03;
      const g = 0.062 + t * 0.04;
      const b = 0.072 + t * 0.05;
      a.r[i] = r;
      a.g[i] = g;
      a.b[i] = b;
    }
    // Some panes have blinds down, some have a lit interior even by day.
    const blindMask = fbmField(size, { period: panesX * 3, octaves: 1, seed: "glass:blind" });
    const blindLine = new Float32Array(n);
    const slats = Math.max(8, Math.round(c.world / 0.05));
    for (let y = 0; y < size; y++) {
      const f = (y / size) * slats;
      const v = 0.5 + 0.5 * Math.cos((f - Math.floor(f)) * Math.PI * 2);
      for (let x = 0; x < size; x++) blindLine[y * size + x] = v;
    }
    for (let i = 0; i < n; i++) {
      const hasBlind = smoothstep(0.62, 0.72, blindMask[i]) * (1 - mull[i]);
      if (hasBlind <= 0) continue;
      const t = hasBlind * 0.8;
      const l = 0.28 + blindLine[i] * 0.22;
      a.r[i] += (l - a.r[i]) * t;
      a.g[i] += (l * 0.99 - a.g[i]) * t;
      a.b[i] += (l * 0.95 - a.b[i]) * t;
    }
  } else {
    a.fill(0x0d1116);
  }

  // Dark anodised aluminium mullions and spandrel caps.
  a.lerpTo(0x2b2e32, mull, 0.92);
  a.modulate(fine, 0.05);
  a.lerpTo(0x585c60, dirt, o.lit ? 0.12 : 0.22);

  const rough = new Float32Array(n);
  const metal = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const m = mull[i];
    // Glass: near-mirror. Mullion: satin anodised.
    rough[i] = clamp01((0.045 + dirt[i] * 0.16 + (fine[i] - 0.5) * 0.02) * (1 - m) + m * 0.34);
    metal[i] = m * 0.95;
  }

  let emissive: AlbedoBuffer | undefined;
  if (o.lit) {
    // Night: individual panes lit at different colour temperatures, a handful
    // blown out, most dark. Office fluorescent runs cool; flats run warm.
    emissive = new AlbedoBuffer(size, 0x000000);
    const litSel = fbmField(size, { period: panesX * 4, octaves: 1, seed: "glass:lit" });
    const warmSel = fbmField(size, { period: panesX * 5, octaves: 1, seed: "glass:warm" });
    const inten = fbmField(size, { period: panesX * 6, octaves: 2, seed: "glass:inten" });
    // A soft vertical falloff inside each pane fakes a ceiling luminaire.
    for (let i = 0; i < n; i++) {
      const on = smoothstep(0.44, 0.5, litSel[i]) * (1 - mull[i]);
      if (on <= 0.001) continue;
      const warm = smoothstep(0.35, 0.65, warmSel[i]);
      const lamp = 0.55 + 0.45 * Math.pow(1 - pv[i], 1.4);
      const k = on * lamp * (0.45 + inten[i] * 1.1);
      emissive.r[i] = k * (0.72 + warm * 0.28);
      emissive.g[i] = k * (0.78 + warm * 0.12);
      emissive.b[i] = k * (0.92 - warm * 0.34);
    }
  }

  return {
    albedo: a,
    height,
    rough,
    metal,
    emissive,
    normalStrength: 0.55,
    ao: fieldOf(size, 1),
  };
}

/* ---------------- Metals ---------------- */

function buildPaintedSteel(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  // Rivet lines on plate seams — the Golden Gate's whole visual identity at
  // close range is rivets and the way the orange fades.
  const seams = Math.max(2, Math.round(c.world / 0.9));
  const rivetsAlong = Math.max(4, Math.round(c.world / 0.11));
  const rivets = new Float32Array(n);
  const seamLine = new Float32Array(n);
  const rr = Math.max(1, (size / c.world) * 0.028);
  for (let y = 0; y < size; y++) {
    const gy = (y / size) * seams;
    const dyv = (gy - Math.round(gy)) * (size / seams);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      seamLine[i] = 1 - smoothstep(rr * 0.9, rr * 2.2, Math.abs(dyv));
      const gx = (x / size) * rivetsAlong;
      const dxv = (gx - Math.round(gx)) * (size / rivetsAlong);
      const d = Math.sqrt(dxv * dxv + dyv * dyv);
      rivets[i] = 1 - smoothstep(rr * 0.55, rr, d);
    }
  }

  const orange = fbmField(size, { period: 3, octaves: 4, seed: "steel:macro" });
  const roller = fbmField(size, {
    period: [Math.round(size / 4), Math.round(size / 12)],
    octaves: 3,
    seed: "steel:roller",
  });
  const fine = grain(size, "steel:fine", 2.4, 2);

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] = clamp01(
      0.5 + rivets[i] * 0.42 + seamLine[i] * 0.06 + (roller[i] - 0.5) * 0.06 + (fine[i] - 0.5) * 0.04,
    );
  }

  // International Orange — the real thing, not a traffic cone.
  const a = new AlbedoBuffer(size, 0xc0362c);
  a.modulate(orange, 0.16);
  a.modulate(roller, 0.09);
  a.modulate(fine, 0.06);

  // Paint fails on the proud edges: rivet heads first, then seams.
  const wear = edgeWearMask(height, size, Math.max(1, size / 180), 0.56);
  const chipNoise = fbmField(size, { period: Math.round(size / 6), octaves: 3, seed: "steel:chip" });
  const chip = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    chip[i] = clamp01(wear[i] * smoothstep(0.5, 0.8, chipNoise[i]) * 1.3);
  }
  a.lerpTo(0x7a3a26, chip, 0.75); // red-oxide primer
  const rustN = fbmField(size, { period: Math.round(size / 4), octaves: 3, seed: "steel:rust" });
  const rust = new Float32Array(n);
  for (let i = 0; i < n; i++) rust[i] = chip[i] * smoothstep(0.55, 0.8, rustN[i]);
  a.lerpTo(0x6b3a1e, rust, 0.85);

  const drips = streakField(size, {
    count: Math.round(size / 12),
    startMin: 0.05,
    startMax: 0.6,
    lengthMin: 0.08,
    lengthMax: 0.35,
    widthMin: 0.002,
    widthMax: 0.008,
    strength: 0.7,
    seed: "steel:drips",
  });
  a.lerpTo(0x5e3320, drips, 0.35);

  const rough = roughness(size, 0.42, [
    { f: chip, amount: 0.4 },
    { f: rust, amount: 0.2 },
    { f: drips, amount: 0.18 },
    { f: roller, amount: 0.07 },
  ]);
  const metal = new Float32Array(n);
  for (let i = 0; i < n; i++) metal[i] = chip[i] * 0.35 * (1 - rust[i]);
  return { albedo: a, height, rough, metal, normalStrength: 1.6 };
}

function buildRustedSteel(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  // Rust advances as a front, not as noise: warp the mask so the boundary is
  // lobed and the scale flakes off in plates.
  const base = fbmField(size, { period: 4, octaves: c.octaves, seed: "rust:base" });
  const wx = fbmField(size, { period: 7, octaves: 3, seed: "rust:wx" });
  const wy = fbmField(size, { period: 7, octaves: 3, seed: "rust:wy" });
  const front = warpField(base, size, wx, wy, size * 0.07);
  const stage1 = new Float32Array(n);
  const stage2 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    stage1[i] = smoothstep(0.42, 0.56, front[i]);
    stage2[i] = smoothstep(0.58, 0.74, front[i]);
  }
  const scale = worleyField(size, { period: Math.round(size / 14), seed: "rust:scale" });
  const flakes = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    flakes[i] = smoothstep(0.42, 0.16, scale.f1[i]) * stage2[i] * (scale.cell[i] > 0.35 ? 1 : 0.3);
  }
  const pits = new Float32Array(n);
  const pitN = worleyField(size, { period: Math.round(size / 7), seed: "rust:pits" });
  for (let i = 0; i < n; i++) {
    pits[i] = smoothstep(0.3, 0.05, pitN.f1[i]) * stage1[i] * (pitN.cell[i] > 0.6 ? 1 : 0);
  }
  const fine = grain(size, "rust:fine", 2.3, 2);
  const brushed = fbmField(size, {
    period: [Math.round(size / 2), 8],
    octaves: 2,
    seed: "rust:brushed",
  });

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] = clamp01(
      0.55 + flakes[i] * 0.3 + stage2[i] * 0.1 + (fine[i] - 0.5) * 0.12 - pits[i] * 0.4,
    );
  }

  const a = new AlbedoBuffer(size, 0x6b6d70);
  a.modulate(brushed, 0.12);
  a.modulate(fine, 0.08);
  a.lerpTo(0x8a6a4a, stage1, 0.85); // the bloom before real rust
  a.lerpTo(0x8f4a22, stage2, 0.9); // active orange rust
  a.lerpTo(0x5a2d16, flakes, 0.6); // dark loose scale
  a.lerpTo(0x3a2313, pits, 0.7);
  const drips = streakField(size, {
    count: Math.round(size / 8),
    startMin: 0,
    startMax: 0.4,
    lengthMin: 0.15,
    lengthMax: 0.75,
    widthMin: 0.003,
    widthMax: 0.016,
    strength: 0.85,
    seed: "rust:drips",
  });
  a.lerpTo(0x7a3d18, drips, 0.45);

  const rough = new Float32Array(n);
  const metal = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = clamp01(stage2[i] * 0.9 + stage1[i] * 0.4 + drips[i] * 0.3);
    rough[i] = clamp01(0.34 + r * 0.58 + (fine[i] - 0.5) * 0.06);
    metal[i] = clamp01(1 - r * 0.95);
  }
  return { albedo: a, height, rough, metal, normalStrength: 1.5 };
}

function buildCorrugated(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  const flutes = Math.max(4, Math.round(c.world / 0.17));
  // Real profiled sheet is a trapezoid, not a sine: flat crest, flat pan,
  // steep webs. That difference is very visible in the specular.
  const profile = new Float32Array(size);
  for (let x = 0; x < size; x++) {
    const f = (x / size) * flutes;
    const t = f - Math.floor(f);
    let h: number;
    if (t < 0.28) h = 1;
    else if (t < 0.42) h = 1 - (t - 0.28) / 0.14;
    else if (t < 0.72) h = 0;
    else if (t < 0.86) h = (t - 0.72) / 0.14;
    else h = 1;
    profile[x] = h;
  }
  const fine = grain(size, "corr:fine", 2.4, 2);
  const spangle = worleyField(size, { period: Math.round(size / 12), seed: "corr:spangle" });
  const dents = fbmField(size, { period: 6, octaves: 3, seed: "corr:dents" });

  // Screws through the crests, every 600 mm vertically.
  const rowsScrew = Math.max(2, Math.round(c.world / 0.6));
  const screws = new Float32Array(n);
  const rs = Math.max(1, (size / c.world) * 0.012);
  for (let y = 0; y < size; y++) {
    const gy = (y / size) * rowsScrew;
    const dyv = (gy - Math.round(gy)) * (size / rowsScrew);
    for (let x = 0; x < size; x++) {
      const f = (x / size) * flutes;
      const t = f - Math.floor(f);
      const onCrest = t < 0.28 || t > 0.86 ? 1 : 0;
      const dxv = (t < 0.28 ? t : t - 1) * (size / flutes);
      const d = Math.sqrt(dxv * dxv + dyv * dyv);
      screws[y * size + x] = onCrest * (1 - smoothstep(rs * 0.6, rs * 1.2, d));
    }
  }

  const height = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      height[i] = clamp01(
        profile[x] * 0.78 + (dents[i] - 0.5) * 0.08 + (fine[i] - 0.5) * 0.05 + screws[i] * 0.12,
      );
    }
  }

  const a = new AlbedoBuffer(size, 0x9aa0a3);
  // Galvanised spangle — the crystalline pattern in hot-dip zinc.
  const sp = new Float32Array(n);
  for (let i = 0; i < n; i++) sp[i] = spangle.cell[i];
  a.modulate(sp, 0.16);
  a.modulate(fine, 0.09);
  a.modulate(dents, 0.1);
  a.lerpTo(0x4b4a48, screws, 0.55);

  // Rust creeps up from the bottom edge and out from every fastener.
  const rustN = fbmField(size, { period: 5, octaves: 4, seed: "corr:rust" });
  const rust = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    const up = Math.pow(y / (size - 1), 2.0);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      rust[i] = clamp01((up * 1.3 + screws[i] * 0.9) * smoothstep(0.35, 0.75, rustN[i]));
    }
  }
  a.lerpTo(0x7d4322, rust, 0.85);
  const drips = streakField(size, {
    count: Math.round(size / 14),
    startMin: 0.1,
    startMax: 0.7,
    lengthMin: 0.1,
    lengthMax: 0.4,
    widthMin: 0.002,
    widthMax: 0.01,
    strength: 0.6,
    seed: "corr:drips",
  });
  a.lerpTo(0x6d3a1c, drips, 0.4);

  const rough = new Float32Array(n);
  const metal = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    rough[i] = clamp01(0.34 + rust[i] * 0.55 + (sp[i] - 0.5) * 0.1 + drips[i] * 0.2);
    metal[i] = clamp01(0.95 - rust[i] * 0.85);
  }
  return { albedo: a, height, rough, metal, normalStrength: 1.9 };
}

/* ---------------- Roofs ---------------- */

function buildTarGravel(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  const gravel = worleyField(size, { period: Math.round(size / 5), seed: "roof:gravel" });
  const fine = grain(size, "roof:fine", 2.3, 2);
  const macro = fbmField(size, { period: 2, octaves: 4, seed: "roof:macro" });
  // Rolled bitumen comes in 900 mm sheets with lapped, tarred seams.
  const laps = Math.max(2, Math.round(c.world / 0.9));
  const seam = new Float32Array(n);
  const sw = Math.max(1.2, (size / c.world) * 0.05);
  for (let y = 0; y < size; y++) {
    const gy = (y / size) * laps;
    const dyv = Math.abs(gy - Math.round(gy)) * (size / laps);
    const v = 1 - smoothstep(sw, sw * 2.4, dyv);
    for (let x = 0; x < size; x++) seam[y * size + x] = v;
  }
  const ponding = stainField(size, {
    count: 6,
    radiusMin: 0.08,
    radiusMax: 0.24,
    strength: 0.7,
    raggedness: 0.7,
    seed: "roof:pond",
  });
  const repair = patchField(size, {
    period: Math.max(2, Math.round(c.world / 1.6)),
    coverage: 0.24,
    feather: 0.08,
    seed: "roof:repair",
  });

  const stones = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    stones[i] = smoothstep(0.42, 0.1, gravel.f1[i]) * (0.35 + gravel.cell[i] * 0.65);
  }

  const a = new AlbedoBuffer(size, 0x35322e);
  a.modulate(macro, 0.22);
  a.modulate(fine, 0.18);
  // Grey-buff granule ballast over the black bitumen.
  const stoneTone = new AlbedoBuffer(size);
  paletteMix(stoneTone, [0x6d6558, 0x8b8175, 0x565049, 0x9a9184], gravel.cell);
  for (let i = 0; i < n; i++) {
    const t = stones[i] * 0.85;
    a.r[i] += (stoneTone.r[i] - a.r[i]) * t;
    a.g[i] += (stoneTone.g[i] - a.g[i]) * t;
    a.b[i] += (stoneTone.b[i] - a.b[i]) * t;
  }
  a.lerpTo(0x201e1c, seam, 0.55);
  a.lerpTo(0x2a2724, ponding, 0.45);
  // Aluminised reflective coating, patchily re-applied over the decades.
  for (let i = 0; i < n; i++) {
    const t = repair.mask[i] * (repair.tone[i] > 0.5 ? 0.7 : 0.25);
    if (t <= 0) continue;
    a.r[i] += (0.55 - a.r[i]) * t;
    a.g[i] += (0.55 - a.g[i]) * t;
    a.b[i] += (0.54 - a.b[i]) * t;
  }

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] = clamp01(0.45 + stones[i] * 0.4 + (fine[i] - 0.5) * 0.16 + seam[i] * 0.14);
  }
  const rough = roughness(size, 0.88, [
    { f: stones, amount: -0.06 },
    { f: ponding, amount: -0.24 },
    { f: seam, amount: -0.1 },
    { f: repair.mask, amount: -0.12 },
  ]);
  const metal = new Float32Array(n);
  for (let i = 0; i < n; i++) metal[i] = repair.mask[i] * (repair.tone[i] > 0.5 ? 0.35 : 0);
  return { albedo: a, height, rough, metal, normalStrength: 1.25 };
}

function buildRoofTile(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  const cols = Math.max(4, Math.round(c.world / 0.25)); // barrel pitch 250 mm
  const rows = Math.max(3, Math.round(c.world / 0.34)); // course exposure 340 mm
  const height = new Float32Array(n);
  const tileId = new Float32Array(n);
  const tileU = new Float32Array(n);
  const rngT = makeRng("tile:id");
  const table = new Float32Array(cols * rows);
  for (let i = 0; i < table.length; i++) table[i] = rngT.next();

  for (let y = 0; y < size; y++) {
    const fr = (y / size) * rows;
    const r = Math.floor(fr) % rows;
    const v = fr - Math.floor(fr);
    // Each course laps the one below: a step at the head, then the barrel.
    const step = v < 0.12 ? 1 - v / 0.12 : 0;
    for (let x = 0; x < size; x++) {
      const fc = (x / size) * cols;
      const cIdx = Math.floor(fc) % cols;
      const u = fc - Math.floor(fc);
      const i = y * size + x;
      // Alternating pan and cover tile — the mission-tile silhouette.
      const barrel = Math.pow(Math.sin(u * Math.PI), 0.65);
      const isCover = (cIdx & 1) === 1;
      const h = isCover ? 0.42 + barrel * 0.55 : 0.18 + barrel * 0.24;
      height[i] = clamp01(h + step * 0.16);
      tileId[i] = table[r * cols + cIdx];
      tileU[i] = u;
    }
  }
  const fine = grain(size, "tile:fine", 2.4, 2);
  const macro = fbmField(size, { period: 2, octaves: 3, seed: "tile:macro" });
  for (let i = 0; i < n; i++) height[i] = clamp01(height[i] + (fine[i] - 0.5) * 0.06);

  const a = new AlbedoBuffer(size);
  const sel = new Float32Array(n);
  for (let i = 0; i < n; i++) sel[i] = clamp01(tileId[i] * 0.8 + macro[i] * 0.35 - 0.06);
  paletteMix(a, [0x8f4a2c, 0xa85c36, 0xbb6f45, 0x7a4028, 0xc98457], sel);
  a.modulate(fine, 0.14);
  a.modulate(macro, 0.12);

  // Moss and lime deposits collect in the pans, never on the ridges.
  const ao = aoFromHeight(height, size, { strength: 1.15 });
  const mossN = fbmField(size, { period: 5, octaves: 4, seed: "tile:moss" });
  const moss = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    moss[i] = clamp01((1 - height[i]) * 1.4 - 0.45) * smoothstep(0.45, 0.75, mossN[i]);
  }
  a.lerpTo(0x4f5a37, moss, 0.7);
  const lime = stainField(size, {
    count: 10,
    radiusMin: 0.02,
    radiusMax: 0.09,
    strength: 0.5,
    seed: "tile:lime",
  });
  a.lerpTo(0xcfc7b4, lime, 0.4);
  const chips = edgeWearMask(height, size, Math.max(1, size / 220), 0.62);
  a.lerpTo(0xb87f5e, chips, 0.3);

  const rough = roughness(size, 0.72, [
    { f: moss, amount: 0.2 },
    { f: lime, amount: 0.12 },
    { f: fine, amount: 0.06 },
  ]);
  return { albedo: a, height, rough, metal: 0, ao, normalStrength: 1.7 };
}

function buildTerracotta(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  const panels = Math.max(2, Math.round(c.world / 0.75));
  const joint = gridJoint(size, panels, panels, Math.max(1.2, (size / c.world) * 0.012));
  const fine = grain(size, "terra:fine", 2.5, 2);
  const macro = fbmField(size, { period: 3, octaves: 4, seed: "terra:macro" });
  // Crazing: the fine craquelure a fired glaze develops over a century.
  const craze = crackField(size, {
    period: Math.round(size / 24),
    width: 0.05,
    coverage: 0.85,
    clumpPeriod: 4,
    seed: "terra:craze",
  });
  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] = clamp01(0.72 + (fine[i] - 0.5) * 0.08 - joint[i] * 0.6 - craze[i] * 0.08);
  }
  const a = new AlbedoBuffer(size, 0xb5714b);
  a.modulate(macro, 0.16);
  a.modulate(fine, 0.09);
  a.lerpTo(0x7d5238, joint, 0.7);
  a.lerpTo(0x9c6242, craze, 0.22);
  const grime = grimeField(height, size, { seed: "terra:grime", baseBias: 0.35, amount: 0.65 });
  a.lerpTo(0x584538, grime, 0.28);
  const rough = roughness(size, 0.3, [
    { f: craze, amount: 0.22 },
    { f: grime, amount: 0.35 },
    { f: joint, amount: 0.4 },
  ]);
  return { albedo: a, height, rough, metal: 0, normalStrength: 1.1 };
}

function buildMarble(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  // Veining is a ridged field warped hard along one axis — geological banding,
  // not isotropic noise.
  const wx = fbmField(size, { period: 3, octaves: 4, seed: "marble:wx" });
  const wy = fbmField(size, { period: 3, octaves: 4, seed: "marble:wy" });
  const bandBase = ridgedField(size, { period: [2, 9], octaves: 5, seed: "marble:band" });
  const veins = warpField(bandBase, size, wx, wy, size * 0.18);
  const fineVein = ridgedField(size, { period: [4, 20], octaves: 4, seed: "marble:fine" });
  const fineWarped = warpField(fineVein, size, wy, wx, size * 0.1);
  const cloud = fbmField(size, { period: 2, octaves: 4, seed: "marble:cloud" });
  const fine = grain(size, "marble:grain", 2.6, 2);

  const panels = Math.max(1, Math.round(c.world / 0.9));
  const joint = gridJoint(size, panels, panels, Math.max(1, (size / c.world) * 0.006));

  const a = new AlbedoBuffer(size, 0xdbd8d0);
  a.modulate(cloud, 0.1);
  const veinMask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    veinMask[i] = clamp01(smoothstep(0.72, 0.95, veins[i]) + smoothstep(0.82, 0.98, fineWarped[i]) * 0.6);
  }
  a.lerpTo(0x8e8a80, veinMask, 0.75);
  const goldVein = new Float32Array(n);
  for (let i = 0; i < n; i++) goldVein[i] = smoothstep(0.9, 0.99, fineWarped[i]) * cloud[i];
  a.lerpTo(0xa8926a, goldVein, 0.4);
  a.modulate(fine, 0.05);
  a.lerpTo(0x8c8880, joint, 0.6);

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] = clamp01(0.8 + (fine[i] - 0.5) * 0.04 - veinMask[i] * 0.03 - joint[i] * 0.5);
  }
  // Polished stone: low roughness with real variation. A constant 0.1 across a
  // whole civic facade is the giveaway of a cheap renderer.
  const rough = roughness(size, 0.13, [
    { f: cloud, amount: 0.08 },
    { f: veinMask, amount: 0.06 },
    { f: joint, amount: 0.5 },
    { f: fine, amount: 0.03 },
  ]);
  return { albedo: a, height, rough, metal: 0, normalStrength: 0.55 };
}

/* ---------------- Natural ---------------- */

function buildSand(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  // Wind ripples: a directional wave warped by noise, plus a coarser dune set.
  const wx = fbmField(size, { period: 4, octaves: 3, seed: "sand:wx" });
  const wy = fbmField(size, { period: 4, octaves: 3, seed: "sand:wy" });
  const ripplePeriod = Math.max(6, Math.round(c.world / 0.09));
  const rippleRaw = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const t = ((x * 0.34 + y * 0.94) / size) * ripplePeriod;
      rippleRaw[i] = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
    }
  }
  const ripple = warpField(rippleRaw, size, wx, wy, size * 0.03);
  const dunes = fbmField(size, { period: 3, octaves: 4, seed: "sand:dunes" });
  const grains = grain(size, "sand:grain", 2.2, 2);
  const shells = worleyField(size, { period: Math.round(size / 9), seed: "sand:shells" });
  const shellMask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    shellMask[i] = smoothstep(0.26, 0.05, shells.f1[i]) * (shells.cell[i] > 0.72 ? 1 : 0);
  }
  const damp = fbmField(size, { period: 2, octaves: 3, seed: "sand:damp" });

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] = clamp01(
      0.5 + (ripple[i] - 0.5) * 0.34 + (dunes[i] - 0.5) * 0.2 + (grains[i] - 0.5) * 0.12 + shellMask[i] * 0.2,
    );
  }
  const a = new AlbedoBuffer(size, 0xbfae90);
  a.modulate(dunes, 0.16);
  a.modulate(ripple, 0.14);
  a.modulate(grains, 0.16);
  a.lerpTo(0xe6dfcd, shellMask, 0.6);
  // Damp sand is markedly darker and less rough — the tide line reads instantly.
  const wetMask = new Float32Array(n);
  for (let i = 0; i < n; i++) wetMask[i] = smoothstep(0.62, 0.82, damp[i]);
  a.lerpTo(0x7d6c53, wetMask, 0.55);
  const rough = roughness(size, 0.95, [
    { f: wetMask, amount: -0.3 },
    { f: shellMask, amount: -0.25 },
  ]);
  return { albedo: a, height, rough, metal: 0, normalStrength: 0.75 };
}

function buildGrass(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  const clumps = worleyField(size, { period: Math.round(size / 14), seed: "grass:clump" });
  const blades = fbmField(size, { period: Math.round(size / 2.2), octaves: 2, seed: "grass:blades" });
  const mid = fbmField(size, { period: 9, octaves: 4, seed: "grass:mid" });
  const macro = fbmField(size, { period: 2, octaves: 4, seed: "grass:macro" });
  const dryN = fbmField(size, { period: 4, octaves: 4, seed: "grass:dry" });
  const stones = worleyField(size, { period: Math.round(size / 6), seed: "grass:stones" });

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c1 = 1 - clamp01(clumps.f1[i]);
    height[i] = clamp01(0.4 + c1 * 0.3 + (blades[i] - 0.5) * 0.3 + (mid[i] - 0.5) * 0.2);
  }

  // California: green in the fog belt, gold everywhere the sun gets at it. The
  // terrain shader lerps between them by longitude; the texture has to carry
  // both so the transition has something to blend.
  const a = new AlbedoBuffer(size);
  const sel = new Float32Array(n);
  for (let i = 0; i < n; i++) sel[i] = clamp01(dryN[i] * 0.7 + macro[i] * 0.4 - 0.05);
  paletteMix(a, [0x38491f, 0x47562a, 0x6a6c34, 0x8a7d43, 0xa08f52], sel);
  a.modulate(blades, 0.28);
  a.modulate(clumps.cell, 0.16);
  a.modulate(mid, 0.16);
  a.modulate(macro, 0.14);
  // Bare earth where feet have worn it through.
  const bare = new Float32Array(n);
  for (let i = 0; i < n; i++) bare[i] = smoothstep(0.66, 0.86, mid[i]) * smoothstep(0.4, 0.7, macro[i]);
  a.lerpTo(0x5a4a35, bare, 0.6);
  const stoneMask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    stoneMask[i] = smoothstep(0.22, 0.05, stones.f1[i]) * (stones.cell[i] > 0.78 ? 1 : 0);
  }
  a.lerpTo(0x8b8478, stoneMask, 0.65);
  for (let i = 0; i < n; i++) height[i] = clamp01(height[i] + stoneMask[i] * 0.25 - bare[i] * 0.12);

  const rough = roughness(size, 0.88, [
    { f: bare, amount: 0.06 },
    { f: stoneMask, amount: -0.2 },
    { f: blades, amount: -0.08 },
  ]);
  return { albedo: a, height, rough, metal: 0, normalStrength: 1.3 };
}

function buildFoliage(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  // A cluster card: masses of leaves with a ragged alpha boundary. Cypress and
  // eucalyptus dominate SF, so the mass is dense with hard silhouette notches.
  const mass = worleyField(size, { period: 5, seed: "foliage:mass" });
  const leafN = fbmField(size, { period: Math.round(size / 5), octaves: 3, seed: "foliage:leaf" });
  const detail = fbmField(size, { period: Math.round(size / 2.4), octaves: 2, seed: "foliage:det" });
  const macro = fbmField(size, { period: 3, octaves: 4, seed: "foliage:macro" });

  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const blob = 1 - smoothstep(0.24, 0.62, mass.f1[i]);
    const bite = smoothstep(0.34, 0.66, leafN[i]);
    const edge = smoothstep(0.3, 0.7, detail[i]);
    alpha[i] = clamp01(blob * 1.25 * (0.35 + bite * 0.85) * (0.5 + edge * 0.7));
  }
  // Push toward a hard cutout so alphaTest gives clean, non-fizzy leaves.
  for (let i = 0; i < n; i++) alpha[i] = clamp01((alpha[i] - 0.32) * 3.2);

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] = clamp01(0.4 + (1 - mass.f1[i]) * 0.35 + (detail[i] - 0.5) * 0.4);
  }
  const a = new AlbedoBuffer(size);
  const sel = new Float32Array(n);
  for (let i = 0; i < n; i++) sel[i] = clamp01(mass.cell[i] * 0.6 + macro[i] * 0.5 + (detail[i] - 0.5) * 0.4);
  paletteMix(a, [0x22331a, 0x2d4522, 0x3d5628, 0x556a31, 0x6d7a3c], sel);
  a.modulate(detail, 0.3);
  a.modulate(leafN, 0.18);
  // Leaves at the silhouette edge are backlit and read much lighter.
  const rim = new Float32Array(n);
  for (let i = 0; i < n; i++) rim[i] = clamp01(alpha[i] * (1 - alpha[i]) * 4);
  a.lerpTo(0x86913f, rim, 0.35);
  a.setAlpha(alpha);

  const rough = roughness(size, 0.72, [
    { f: detail, amount: 0.12 },
    { f: rim, amount: -0.12 },
  ]);
  return { albedo: a, height, rough, metal: 0, normalStrength: 1.1 };
}

/* ---------------- Misc ---------------- */

function buildChainlink(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  const mesh = Math.max(3, Math.round(c.world / 0.055)); // 55 mm diamond
  const wirePx = Math.max(1.1, (size / c.world) * 0.0035);
  const alpha = new Float32Array(n);
  const height = new Float32Array(n);
  const overUnder = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const a1 = ((x + y) / size) * mesh;
      const a2 = ((x - y) / size) * mesh;
      const d1 = Math.abs(a1 - Math.round(a1)) * (size / mesh) * 0.7071;
      const d2 = Math.abs(a2 - Math.round(a2)) * (size / mesh) * 0.7071;
      const w1 = 1 - smoothstep(wirePx * 0.6, wirePx * 1.15, d1);
      const w2 = 1 - smoothstep(wirePx * 0.6, wirePx * 1.15, d2);
      const cov = Math.max(w1, w2);
      alpha[i] = cov;
      // Round the wire cross-section, and let one strand pass over the other.
      const r1 = w1 > 0 ? Math.sqrt(Math.max(0, 1 - Math.pow(d1 / wirePx, 2))) : 0;
      const r2 = w2 > 0 ? Math.sqrt(Math.max(0, 1 - Math.pow(d2 / wirePx, 2))) : 0;
      const over = ((Math.floor(a1) + Math.floor(a2)) & 1) === 0 ? 1 : 0;
      const h = over ? Math.max(r1 * 1.0, r2 * 0.6) : Math.max(r1 * 0.6, r2 * 1.0);
      height[i] = clamp01(0.5 + h * 0.5);
      overUnder[i] = over;
    }
  }
  const fine = grain(size, "chain:fine", 2.4, 2);
  const rustN = fbmField(size, { period: 5, octaves: 4, seed: "chain:rust" });
  const rust = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    const up = Math.pow(y / (size - 1), 1.8);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      rust[i] = clamp01(up * 1.1 * smoothstep(0.42, 0.8, rustN[i]));
    }
  }
  const a = new AlbedoBuffer(size, 0x9ba0a4);
  a.modulate(fine, 0.12);
  a.modulate(overUnder, 0.08);
  a.lerpTo(0x7d4726, rust, 0.8);
  a.setAlpha(alpha);
  const rough = new Float32Array(n);
  const metal = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    rough[i] = clamp01(0.3 + rust[i] * 0.55 + (fine[i] - 0.5) * 0.08);
    metal[i] = clamp01(0.95 - rust[i] * 0.8);
  }
  return { albedo: a, height, rough, metal, normalStrength: 1.4, ao: fieldOf(size, 1) };
}

function buildRoadPaint(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  // Thermoplastic road marking: thick, retro-reflective, and always worn.
  const wearN = fbmField(size, { period: 5, octaves: 4, seed: "paint:wear" });
  const edgeN = fbmField(size, { period: Math.round(size / 5), octaves: 3, seed: "paint:edge" });
  const beads = worleyField(size, { period: Math.round(size / 4), seed: "paint:beads" });
  const scuff = decalField(size, { count: 22, radius: 0.03, seed: "paint:scuff" });
  const cracks = crackField(size, {
    period: Math.max(3, Math.round(c.world / 0.25)),
    width: 0.05,
    coverage: 0.45,
    seed: "paint:cracks",
  });

  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const wear = smoothstep(0.32, 0.62, wearN[i]);
    alpha[i] = clamp01(wear * 1.35 - edgeN[i] * 0.35 - cracks[i] * 0.5);
  }
  const beadMask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    beadMask[i] = smoothstep(0.34, 0.08, beads.f1[i]) * (beads.cell[i] > 0.4 ? 1 : 0.3);
  }
  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] = clamp01(0.35 + alpha[i] * 0.45 + beadMask[i] * 0.3 - cracks[i] * 0.2);
  }
  // Near-white so a single bake serves both lane white and centreline yellow
  // via material.color.
  const a = new AlbedoBuffer(size, 0xeeece4);
  a.modulate(wearN, 0.12);
  a.lerpTo(0xbdb9ad, scuff, 0.55);
  a.lerpTo(0xd6d2c6, cracks, 0.4);
  a.setAlpha(alpha);
  const rough = roughness(size, 0.62, [
    { f: beadMask, amount: -0.35 },
    { f: scuff, amount: 0.18 },
  ]);
  return { albedo: a, height, rough, metal: 0, normalStrength: 1.0 };
}

function buildTyre(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  // Tread: circumferential grooves plus a lateral block pattern.
  const ribs = 5;
  const blocks = Math.max(6, Math.round(c.world / 0.045));
  const height = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    const fb = (y / size) * blocks;
    const bv = fb - Math.floor(fb);
    const lateral = smoothstep(0.0, 0.1, bv) * smoothstep(1.0, 0.9, bv);
    for (let x = 0; x < size; x++) {
      const fr = (x / size) * ribs;
      const ru = fr - Math.floor(fr);
      const ribIdx = Math.floor(fr) % ribs;
      // Grooves between ribs, shoulder ribs a touch lower.
      const groove = smoothstep(0.0, 0.12, ru) * smoothstep(1.0, 0.88, ru);
      const shoulder = ribIdx === 0 || ribIdx === ribs - 1 ? 0.88 : 1;
      // Stagger alternate ribs so the pattern is not a grid.
      const stagger = (ribIdx & 1) === 1 ? 0.5 : 0;
      const fb2 = fb + stagger;
      const bv2 = fb2 - Math.floor(fb2);
      const lat2 = smoothstep(0.0, 0.1, bv2) * smoothstep(1.0, 0.9, bv2);
      height[y * size + x] = clamp01(groove * (ribIdx & 1 ? lat2 : lateral) * shoulder);
    }
  }
  const fine = grain(size, "tyre:fine", 2.2, 2);
  const mould = fbmField(size, { period: 8, octaves: 3, seed: "tyre:mould" });
  for (let i = 0; i < n; i++) height[i] = clamp01(height[i] * 0.85 + 0.08 + (fine[i] - 0.5) * 0.07);
  const a = new AlbedoBuffer(size, 0x1c1c1e);
  a.modulate(fine, 0.3);
  a.modulate(mould, 0.18);
  const wear = edgeWearMask(height, size, Math.max(1, size / 200), 0.6);
  a.lerpTo(0x2e2e30, wear, 0.5); // polished crown from road contact
  const rough = roughness(size, 0.88, [
    { f: wear, amount: -0.3 },
    { f: fine, amount: 0.08 },
  ]);
  return { albedo: a, height, rough, metal: 0, normalStrength: 1.8 };
}

function buildCarPaint(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  // Metallic flake: tiny, high-frequency, and only ever visible as a glitter in
  // the specular. It lives almost entirely in the normal and roughness maps.
  const flake = worleyField(size, { period: Math.round(size / 1.6), seed: "car:flake" });
  const flakeN = whiteNoiseField(size, "car:flakeN");
  // Orange peel: the low-frequency waviness every production clearcoat has.
  const peel = fbmField(size, { period: 26, octaves: 3, seed: "car:peel" });
  const swirl = fbmField(size, {
    period: [Math.round(size / 3), Math.round(size / 3.4)],
    octaves: 2,
    seed: "car:swirl",
  });

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] = clamp01(
      0.5 + (peel[i] - 0.5) * 0.55 + (flakeN[i] - 0.5) * 0.14 + (swirl[i] - 0.5) * 0.06,
    );
  }
  // Near-white: the actual colour arrives per-instance through material.color.
  const a = new AlbedoBuffer(size, 0xf2f2f4);
  const sparkle = new Float32Array(n);
  for (let i = 0; i < n; i++) sparkle[i] = smoothstep(0.5, 0.1, flake.f1[i]) * flake.cell[i];
  a.modulate(sparkle, 0.12);
  a.modulate(peel, 0.03);
  const rough = roughness(size, 0.26, [
    { f: sparkle, amount: -0.12 },
    { f: swirl, amount: 0.06 },
    { f: peel, amount: 0.03 },
  ]);
  const metal = new Float32Array(n);
  for (let i = 0; i < n; i++) metal[i] = clamp01(0.55 + sparkle[i] * 0.4);
  return { albedo: a, height, rough, metal, normalStrength: 0.35, ao: fieldOf(size, 1) };
}

function buildChrome(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  const scratches = ridgedField(size, {
    period: [Math.round(size / 1.8), 5],
    octaves: 3,
    seed: "chrome:scratch",
  });
  const smudge = fbmField(size, { period: 6, octaves: 4, seed: "chrome:smudge" });
  const spots = decalField(size, { count: 30, radius: 0.008, seed: "chrome:spots" });
  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] = clamp01(0.5 + (scratches[i] - 0.5) * 0.06 + spots[i] * 0.03);
  }
  const a = new AlbedoBuffer(size, 0xf0f2f3);
  a.modulate(smudge, 0.05);
  a.lerpTo(0xd8dadc, spots, 0.35);
  const rough = roughness(size, 0.05, [
    { f: smudge, amount: 0.06 },
    { f: spots, amount: 0.22 },
    { f: scratches, amount: 0.05 },
  ]);
  return { albedo: a, height, rough, metal: 1, normalStrength: 0.4, ao: fieldOf(size, 1) };
}

function buildPlastic(c: BuildCtx): Built {
  const { size } = c;
  const n = size * size;
  // Tool-side leather grain — the pebbled texture on every moulded panel.
  const pebble = worleyField(size, { period: Math.round(size / 5), seed: "plastic:pebble" });
  const fine = grain(size, "plastic:fine", 2.4, 2);
  const flow = fbmField(size, {
    period: [Math.round(size / 3), 10],
    octaves: 3,
    seed: "plastic:flow",
  });
  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cellH = smoothstep(0.5, 0.05, pebble.f1[i]);
    height[i] = clamp01(0.45 + cellH * 0.35 + (fine[i] - 0.5) * 0.1 + (flow[i] - 0.5) * 0.05);
  }
  const a = new AlbedoBuffer(size, 0xdadade);
  a.modulate(pebble.cell, 0.07);
  a.modulate(fine, 0.05);
  a.modulate(flow, 0.04);
  const rough = roughness(size, 0.44, [
    { f: fine, amount: 0.1 },
    { f: flow, amount: 0.06 },
  ]);
  return { albedo: a, height, rough, metal: 0, normalStrength: 0.9 };
}

/* ================================================================== *
 * Recipe table
 * ================================================================== */

interface Recipe {
  /** Metres covered by one tile. */
  world: number;
  hero?: boolean;
  physical?: boolean;
  /** Albedo alpha is meaningful → alphaTest cutout. */
  cutout?: number;
  build(c: BuildCtx): Built;
  /** Extra material configuration applied after the maps are bound. */
  configure?(m: THREE.MeshStandardMaterial): void;
}

const RECIPES: Record<MaterialKind, Recipe> = {
  asphalt: { world: 8, hero: true, build: (c) => buildAsphalt(c, false) },
  "asphalt-wet": {
    world: 8,
    hero: true,
    build: (c) => buildAsphalt(c, true),
    configure: (m) => {
      m.envMapIntensity = 1.5;
    },
  },
  "concrete-sidewalk": { world: 6, hero: true, build: buildSidewalk },
  "concrete-cast": { world: 4, hero: true, build: buildCastConcrete },
  "brick-red": { world: 1.632, hero: true, build: (c) => buildBrick(c, { painted: false }) },
  "brick-painted": { world: 1.632, build: (c) => buildBrick(c, { painted: true }) },
  stucco: { world: 3, hero: true, build: buildStucco },
  "wood-siding": { world: 2.4, build: buildWoodSiding },
  "victorian-trim": { world: 1.2, build: buildVictorianTrim },
  "glass-curtainwall": {
    world: 3,
    physical: true,
    build: (c) => buildGlass(c, { lit: false }),
    configure: (m) => {
      const p = m as THREE.MeshPhysicalMaterial;
      p.envMapIntensity = 2.2;
      p.ior = 1.52;
      p.reflectivity = 0.62;
      p.clearcoat = 0.35;
      p.clearcoatRoughness = 0.06;
    },
  },
  "glass-window-lit": {
    world: 3,
    build: (c) => buildGlass(c, { lit: true }),
    configure: (m) => {
      m.emissive = new THREE.Color(0xffffff);
      m.emissiveIntensity = 2.6;
      m.envMapIntensity = 1.4;
    },
  },
  "steel-painted": { world: 2, build: buildPaintedSteel },
  "steel-rusted": { world: 2, build: buildRustedSteel },
  "corrugated-metal": { world: 2, build: buildCorrugated },
  "roof-tar-gravel": { world: 4, build: buildTarGravel },
  "roof-tile": { world: 2, build: buildRoofTile },
  terracotta: { world: 1.5, build: buildTerracotta },
  "marble-civic": { world: 1.8, build: buildMarble },
  sand: { world: 3, build: buildSand },
  grass: { world: 4, build: buildGrass },
  foliage: {
    world: 1,
    cutout: 0.42,
    build: buildFoliage,
    configure: (m) => {
      m.side = THREE.DoubleSide;
      m.shadowSide = THREE.DoubleSide;
    },
  },
  chainlink: {
    world: 1,
    cutout: 0.45,
    build: buildChainlink,
    configure: (m) => {
      m.side = THREE.DoubleSide;
    },
  },
  "road-marking-paint": { world: 1, cutout: 0.35, build: buildRoadPaint },
  "rubber-tyre": { world: 0.9, build: buildTyre },
  "car-paint": {
    world: 2,
    physical: true,
    build: buildCarPaint,
    configure: (m) => {
      const p = m as THREE.MeshPhysicalMaterial;
      p.clearcoat = 1;
      p.clearcoatRoughness = 0.045;
      p.envMapIntensity = 1.8;
    },
  },
  chrome: {
    world: 0.6,
    build: buildChrome,
    configure: (m) => {
      m.envMapIntensity = 2.4;
    },
  },
  plastic: { world: 0.5, build: buildPlastic },
};

export const MATERIAL_KINDS = Object.keys(RECIPES) as MaterialKind[];

/** Metres covered by one tile of this material's textures. */
export function materialWorldScale(kind: MaterialKind): number {
  return RECIPES[kind].world;
}

/* ================================================================== *
 * Texture cache
 * ================================================================== */

const textureCache = new Map<string, TextureSet>();
const materialCache = new Map<string, THREE.MeshStandardMaterial>();
const clonedTextures: THREE.Texture[] = [];
let macroTexture: THREE.DataTexture | null = null;

function sizeFor(kind: MaterialKind, tier: QualityTier): number {
  const t = SIZE_TABLE[tier];
  return RECIPES[kind].hero ? t.hero : t.std;
}

function finalize(b: Built, size: number, aniso: number, kind: string): {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  ormMap: THREE.DataTexture;
  emissiveMap: THREE.DataTexture | null;
  pivot: number;
} {
  b.albedo.clamp();
  const ao = b.ao ?? aoFromHeight(b.height, size);
  const albedoRaster = b.albedo.toRaster();
  const normalRaster = flipRaster(
    normalFromHeight(b.height, size, b.normalStrength ?? 1),
    size,
  );
  const ormRaster = packORM(size, ao, b.rough, b.metal ?? 0);

  const map = rasterTexture(albedoRaster, size, {
    srgb: true,
    anisotropy: aniso,
    name: `sf/${kind}/albedo`,
  });
  const normalMap = rasterTexture(normalRaster, size, {
    anisotropy: aniso,
    name: `sf/${kind}/normal`,
  });
  const ormMap = rasterTexture(ormRaster, size, {
    anisotropy: aniso,
    name: `sf/${kind}/orm`,
    // aoMap defaults to uv1; every mesh in this game only has uv0.
    channel: 0,
  });
  const emissiveMap = b.emissive
    ? rasterTexture(b.emissive.clamp().toRaster(), size, {
        srgb: true,
        anisotropy: aniso,
        name: `sf/${kind}/emissive`,
      })
    : null;
  return { map, normalMap, ormMap, emissiveMap, pivot: b.albedo.meanLuminance() };
}

export interface TextureSetOptions {
  tier?: QualityTier;
  variant?: number;
}

/**
 * Generate (or fetch) the shared texture set for a material kind. Textures are
 * immutable and shared; use `getMaterial` unless you are doing something
 * unusual with them.
 */
export function getTextureSet(kind: MaterialKind, o: TextureSetOptions = {}): TextureSet {
  const tier = o.tier ?? activeTier;
  const variant = o.variant ?? 0;
  const key = `${kind}|${tier}|${variant}`;
  const hit = textureCache.get(key);
  if (hit) return hit;

  const recipe = RECIPES[kind];
  const size = sizeFor(kind, tier);
  const aniso = QUALITY[tier].anisotropy;
  const ctx: BuildCtx = {
    size,
    rng: makeRng(`sf-materials:${kind}:${variant}`),
    world: recipe.world,
    octaves: octavesFor(size),
    tier,
    variant,
  };
  const built = recipe.build(ctx);
  const fin = finalize(built, size, aniso, kind);
  const set: TextureSet = {
    map: fin.map,
    normalMap: fin.normalMap,
    ormMap: fin.ormMap,
    emissiveMap: fin.emissiveMap,
    size,
    worldScale: recipe.world,
    pivot: fin.pivot,
    hasAlpha: recipe.cutout !== undefined,
  };
  textureCache.set(key, set);
  return set;
}

/** Low-frequency variation map shared by every triplanar / detail material. */
export function getMacroVariationTexture(tier: QualityTier = activeTier): THREE.DataTexture {
  if (macroTexture) return macroTexture;
  const size = tier === "low" ? 128 : 256;
  macroTexture = rasterTexture(macroVariationRaster(size, "sf-macro"), size, {
    srgb: false,
    anisotropy: 4,
    name: "sf/macro-variation",
  });
  return macroTexture;
}

/* ================================================================== *
 * Material construction
 * ================================================================== */

export interface MaterialOptions {
  tier?: QualityTier;
  /** Deterministic variant index — different noise, same recipe. */
  variant?: number;
  /** Tint. Applied through `material.color`, so it costs nothing. */
  color?: THREE.ColorRepresentation;
  /** Texture repeats. Mutually exclusive with `worldSize`. */
  repeat?: number | [number, number];
  /** Real size of the surface in metres; repeat is derived from `worldScale`. */
  worldSize?: number | [number, number];
  /** World-space projection. `true` uses sensible defaults for the kind. */
  triplanar?: boolean | TriplanarOptions;
  /** Distance-blended detail without triplanar. Defaults to on. */
  detail?: boolean | DetailOptions;
  /** Multiply into macro-variation strength; 0 disables it. */
  macroStrength?: number;
  emissiveIntensity?: number;
  side?: THREE.Side;
  transparent?: boolean;
  opacity?: number;
  depthWrite?: boolean;
  polygonOffset?: number;
  vertexColors?: boolean;
  flatShading?: boolean;
  envMapIntensity?: number;
  /** Skip the cache — for per-instance colours that would otherwise thrash it. */
  unique?: boolean;
  name?: string;
}

function repeatFor(kind: MaterialKind, o: MaterialOptions): [number, number] {
  if (o.repeat !== undefined) {
    return Array.isArray(o.repeat) ? o.repeat : [o.repeat, o.repeat];
  }
  if (o.worldSize !== undefined) {
    const w = RECIPES[kind].world;
    const [sx, sy] = Array.isArray(o.worldSize) ? o.worldSize : [o.worldSize, o.worldSize];
    return [sx / w, sy / w];
  }
  return [1, 1];
}

/**
 * three keys GPU textures by `texture.source`, so a clone that only changes the
 * uv transform costs one extra uniform block and zero extra VRAM.
 */
function withRepeat(tex: THREE.Texture, rx: number, ry: number): THREE.Texture {
  if (tex.repeat.x === rx && tex.repeat.y === ry) return tex;
  const c = tex.clone();
  c.repeat.set(rx, ry);
  c.needsUpdate = true;
  clonedTextures.push(c);
  return c;
}

/**
 * The one entry point the rest of the game uses.
 *
 * Materials are cached on every parameter that changes a uniform, so calling
 * this per building or per road segment is free after the first hit.
 */
export function getMaterial(
  kind: MaterialKind,
  o: MaterialOptions = {},
): THREE.MeshStandardMaterial {
  const tier = o.tier ?? activeTier;
  const recipe = RECIPES[kind];
  const [rx, ry] = repeatFor(kind, o);
  const tri = o.triplanar ? (o.triplanar === true ? {} : o.triplanar) : null;
  const det =
    o.detail === false ? null : o.detail === true || o.detail === undefined ? {} : o.detail;
  const colorHex = o.color !== undefined ? new THREE.Color(o.color).getHex() : 0xffffff;

  const key = [
    kind,
    tier,
    o.variant ?? 0,
    colorHex.toString(16),
    rx.toFixed(3),
    ry.toFixed(3),
    tri ? `tri${JSON.stringify(tri)}` : det ? `det${JSON.stringify(det)}` : "plain",
    o.macroStrength ?? "",
    o.side ?? "",
    o.transparent ? 1 : 0,
    o.opacity ?? 1,
    o.vertexColors ? 1 : 0,
    o.flatShading ? 1 : 0,
    o.emissiveIntensity ?? "",
    o.envMapIntensity ?? "",
    o.depthWrite === false ? 0 : 1,
    o.polygonOffset ?? 0,
  ].join("|");

  if (!o.unique) {
    const hit = materialCache.get(key);
    if (hit) return hit;
  }

  const set = getTextureSet(kind, { tier, variant: o.variant });
  const M = recipe.physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const mat = new M() as THREE.MeshStandardMaterial;
  mat.name = o.name ?? `sf/${kind}`;

  mat.map = withRepeat(set.map, rx, ry);
  mat.normalMap = withRepeat(set.normalMap, rx, ry);
  const orm = withRepeat(set.ormMap, rx, ry);
  mat.roughnessMap = orm;
  mat.metalnessMap = orm;
  mat.aoMap = orm;
  if (set.emissiveMap) {
    mat.emissiveMap = withRepeat(set.emissiveMap, rx, ry);
    mat.emissive = new THREE.Color(0xffffff);
    mat.emissiveIntensity = o.emissiveIntensity ?? 2.6;
  }

  // Absolute maps: the scalars are multipliers, so they stay at 1.
  mat.roughness = 1;
  mat.metalness = 1;
  mat.aoMapIntensity = 1;
  mat.color = new THREE.Color(colorHex);
  mat.normalScale = new THREE.Vector2(1, 1);
  mat.dithering = true;
  mat.envMapIntensity = o.envMapIntensity ?? 1;
  if (o.vertexColors) mat.vertexColors = true;
  if (o.flatShading) mat.flatShading = true;
  if (o.side !== undefined) mat.side = o.side;
  if (o.transparent) {
    mat.transparent = true;
    mat.opacity = o.opacity ?? 1;
  }
  if (o.depthWrite === false) mat.depthWrite = false;
  if (o.polygonOffset) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = o.polygonOffset;
    mat.polygonOffsetUnits = o.polygonOffset;
  }
  if (recipe.cutout !== undefined) {
    mat.alphaTest = recipe.cutout;
  }
  recipe.configure?.(mat);
  if (o.emissiveIntensity !== undefined) mat.emissiveIntensity = o.emissiveIntensity;
  if (o.envMapIntensity !== undefined) mat.envMapIntensity = o.envMapIntensity;

  // Anti-tiling. The detail scale is chosen so the detail layer lands around
  // 3-5 mm per texel at the surface, which is where human vision stops caring.
  const macro = (o.macroStrength ?? 1) > 0 ? getMacroVariationTexture(tier) : null;
  const macroStrength = 0.45 * (o.macroStrength ?? 1);
  const detailScale = THREE.MathUtils.clamp(recipe.world * 3, 3, 12);
  if (tri) {
    applyTriplanar(mat, {
      worldScale: recipe.world,
      blendSharpness: 6,
      detailScale,
      detailPivot: set.pivot,
      detailStrength: 0.5,
      detailNormalStrength: 0.65,
      macroMap: macro,
      macroWorldScale: 72,
      macroStrength,
      ...tri,
    });
  } else if (det) {
    applyDetailBlend(mat, {
      detailScale,
      detailPivot: set.pivot,
      detailStrength: 0.45,
      detailNormalStrength: 0.55,
      macroMap: macro,
      macroWorldScale: Math.max(6, 24 / Math.max(rx, ry)),
      macroStrength: macroStrength * 0.8,
      ...det,
    });
  }

  if (!o.unique) materialCache.set(key, mat);
  return mat;
}

/**
 * Car paint with a per-vehicle colour. Bypasses the material cache on purpose:
 * every car wants its own `color`, and caching thousands of near-identical
 * materials would be worse than making them.
 */
export function getCarPaintMaterial(
  color: THREE.ColorRepresentation,
  o: MaterialOptions = {},
): THREE.MeshPhysicalMaterial {
  return getMaterial("car-paint", {
    ...o,
    color,
    unique: true,
    detail: false,
  }) as THREE.MeshPhysicalMaterial;
}

/* ================================================================== *
 * Lifecycle
 * ================================================================== */

/** True once this kind's textures exist. */
export function isMaterialReady(kind: MaterialKind, tier: QualityTier = activeTier): boolean {
  return textureCache.has(`${kind}|${tier}|0`);
}

/** Dispose every generated texture and material. Call on level teardown. */
export function disposeMaterials(): void {
  for (const m of materialCache.values()) m.dispose();
  materialCache.clear();
  for (const s of textureCache.values()) {
    s.map.dispose();
    s.normalMap.dispose();
    s.ormMap.dispose();
    s.emissiveMap?.dispose();
  }
  textureCache.clear();
  for (const t of clonedTextures) t.dispose();
  clonedTextures.length = 0;
  macroTexture?.dispose();
  macroTexture = null;
}

/** Rough VRAM accounting, for the debug overlay. */
export function materialMemoryBytes(): number {
  let bytes = 0;
  for (const s of textureCache.values()) {
    const px = s.size * s.size * 4;
    const withMips = px * 1.34;
    bytes += withMips * (3 + (s.emissiveMap ? 1 : 0));
  }
  return Math.round(bytes);
}
