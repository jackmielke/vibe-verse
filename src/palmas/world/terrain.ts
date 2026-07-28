/**
 * San Palmas — terrain.
 *
 * The landmass itself: the peninsula, its hills, its beaches and the floor of
 * the bay. Publishes TerrainService, which is the single thing every other
 * system asks "how high is the ground here?".
 *
 * Three pieces, in dependency order:
 *
 *  1. THE MACRO FIELD. `atlas.landSignedDistance` + `atlas.shoreProfile` +
 *     `atlas.hillHeight`, unioned with a civic landmass (see CIVIC LANDMASS
 *     below) and baked once into a pair of float grids. Baking matters: the
 *     atlas functions cost ~550 ns a call and the player controller, the tree
 *     scatterer and the city grid all hammer `heightAt`. Bilinear taps into a
 *     grid cost ~30 ns. The macro field is all low-frequency — the tightest
 *     feature in it is a ~90 m avenue capsule — so a ~17 m lattice loses
 *     nothing. Crucially we bake the *signed distance*, not the elevation, and
 *     run `shoreProfile` on the interpolated distance, so the beach break stays
 *     razor sharp instead of being smeared by the lattice.
 *
 *  2. THE DETAIL. Three octaves of simplex evaluated analytically on top:
 *     rolling ground swell, ridged spurs on the flanks of the big hills, dunes
 *     in the beach band, sandbars and reef on the bay floor. Everything the
 *     mesh draws goes through `heightAt`, so mesh and collision can never
 *     disagree — the mesh is literally a sampling of the collision function.
 *
 *  3. THE CLIPMAP. Seven concentric grids centred on the player, each one twice
 *     the cell size of the one inside it. Metre-scale detail underfoot, 64 m
 *     cells out at the 4 km horizon, ~180 k triangles and 8 draw calls for the
 *     lot. Levels re-snap and re-tessellate incrementally as the player moves;
 *     because the GPU only sees a vertex buffer when we flip `needsUpdate`, a
 *     rebuild can be spread over several frames with no tearing.
 *
 * CIVIC LANDMASS — read this before you "fix" the coastline.
 * `atlas.landSignedDistance` puts the bay ellipse over Palma Centro, Little
 * Canton, Pier Verde, Alta Loma, Nob/Russian/Telegraph Hill and the spawn
 * point: taken literally, six districts and three named hills are 30 m under
 * water. Terrain owns elevation, so terrain reconciles it — we union the atlas
 * SDF with a civic footprint built from DISTRICTS, the AVENUES polylines and
 * the land landmarks, then re-carve the strait so Puente Dorado still spans
 * water. Every coordinate involved still comes from the atlas; nothing here
 * invents geography. If the atlas SDF is ever corrected, delete `civicLand`.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre.
 */
import * as THREE from "three";
import { createNoise2D } from "simplex-noise";
import type { QualityTier, System, SystemFactory, TerrainService } from "../types";
import { makeRng } from "../types";
import {
  AVENUES,
  DISTRICTS,
  HILLS,
  LANDMARKS,
  LAND_RADIUS,
  SEA_LEVEL,
  STRAIT,
  WORLD_SIZE,
  biomeAt,
  districtAt,
  hillHeight,
  landSignedDistance,
  shoreProfile,
} from "./atlas";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Half-extent of the baked macro field. Comfortably past the clipmap edge. */
const FIELD_EXTENT = 4400;

/** Hills fade out over this distance inland, so none of them wades offshore. */
const HILL_SHORE_FADE = 130;

/** Detail noise is silent at the waterline and full strength this far inland. */
const DETAIL_FADE = 110;

interface Tier {
  /** Quads per side on every clipmap level. Must be a multiple of four. */
  grid: number;
  /** Cell size of the innermost level, metres. */
  cell: number;
  /** Number of concentric levels. */
  levels: number;
  /** Resolution of the baked macro field (per side). */
  field: number;
  /** Procedural texture resolution. */
  tex: number;
  /** Skip the second detail-normal octave and the triplanar rock normal. */
  cheap: boolean;
  aniso: number;
}

const TIERS: Record<QualityTier, Tier> = {
  low: { grid: 64, cell: 2.0, levels: 7, field: 384, tex: 128, cheap: true, aniso: 2 },
  medium: { grid: 96, cell: 1.5, levels: 7, field: 448, tex: 256, cheap: true, aniso: 4 },
  high: { grid: 128, cell: 1.0, levels: 7, field: 512, tex: 256, cheap: false, aniso: 8 },
  ultra: { grid: 160, cell: 0.8, levels: 7, field: 640, tex: 256, cheap: false, aniso: 16 },
};

/** Vertices re-tessellated per frame before a rebuild spills into the next. */
const REBUILD_BUDGET = 5000;

/**
 * A level re-snaps every `SNAP_MULT * 2 * cell` metres rather than every
 * `2 * cell`. The innermost level is 128 cells wide, so letting the player sit
 * up to four cells off centre costs nothing visually and cuts re-tessellation
 * — by far the largest per-frame expense in this module — by 4×. Must stay a
 * power of two, or the levels stop sharing grid lines and the seams open up.
 */
const SNAP_MULT = 4;

/** Channels packed into the macro field, interleaved so one tap fills a line. */
const F_DIST = 0;
const F_MACRO = 1;
const F_CALM = 2;
const F_VEG = 3;
const F_STRIDE = 4;

// ---------------------------------------------------------------------------
// Small maths
// ---------------------------------------------------------------------------

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Polynomial smooth maximum — unions two fields without a crease. */
function smax(a: number, b: number, k: number): number {
  const h = Math.max(0, k - Math.abs(a - b)) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

/** Squared-free point/segment distance. `Math.hypot` is ~8× slower than this. */
function segDistance(px: number, pz: number, s: Float64Array, i: number): number {
  const ax = s[i], az = s[i + 1], vx = s[i + 2], vz = s[i + 3], inv = s[i + 4];
  const wx = px - ax, wz = pz - az;
  let t = (wx * vx + wz * vz) * inv;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = wx - t * vx, ez = wz - t * vz;
  return Math.sqrt(ex * ex + ez * ez);
}

// ---------------------------------------------------------------------------
// Tileable procedural noise (texture generation only)
// ---------------------------------------------------------------------------
//
// simplex-noise is perfect for the world but useless for textures: it doesn't
// tile, and a ground texture that doesn't tile shows a hard seam every few
// metres. These run on a wrapped integer lattice, so every map below is
// seamless by construction.

function hash2(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise wrapping every `period` lattice cells. */
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

/** Fractal value noise over UV in [0,1). Tiles over the full UV square. */
function fbmT(u: number, v: number, period: number, octaves: number, seed: number, gain = 0.5): number {
  let amp = 1, sum = 0, norm = 0, p = period;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(u * p, v * p, p, seed + o * 131) * amp;
    norm += amp;
    amp *= gain;
    p *= 2;
  }
  return sum / norm;
}

/** Tileable Worley F1, normalised to roughly 0..1. Organic cell structure. */
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

/** Ridged fractal — the |n| fold gives creases instead of blobs. */
function ridgedT(u: number, v: number, period: number, octaves: number, seed: number): number {
  let amp = 1, sum = 0, norm = 0, p = period;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(vnoise(u * p, v * p, p, seed + o * 77) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// Texture bakery
// ---------------------------------------------------------------------------
//
// Everything is a DataTexture built from a per-texel callback — no canvas, no
// DOM, no assets. Albedo maps carry roughness in alpha (alpha is never sRGB
// decoded, so it survives the colour-space round trip intact), which halves
// the sampler count on the hot path.

function finishTexture(tex: THREE.DataTexture, srgb: boolean, aniso: number): THREE.DataTexture {
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

type AlbedoFn = (u: number, v: number, out: Float32Array, index: number) => void;

/**
 * RGB = albedo, A = roughness.
 *
 * Every `fbmT`/`worleyT`/`ridgedT` call below must scale u and v by whole
 * numbers, or the lattice stops wrapping at the texture edge and the map grows
 * a seam every tile. It is the easiest mistake to make here and the ugliest.
 */
function bakeAlbedo(size: number, aniso: number, srgb: boolean, fn: AlbedoFn): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const out = new Float32Array(4);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = y * size + x;
      fn((x + 0.5) * inv, (y + 0.5) * inv, out, c);
      const o = c * 4;
      data[o] = clamp01(out[0]) * 255;
      data[o + 1] = clamp01(out[1]) * 255;
      data[o + 2] = clamp01(out[2]) * 255;
      data[o + 3] = clamp01(out[3]) * 255;
    }
  }
  return finishTexture(new THREE.DataTexture(data, size, size, THREE.RGBAFormat), srgb, aniso);
}

/** Sample a tileable height callback into a grid, ready for `bakeNormal`. */
function heightField(size: number, h: (u: number, v: number) => number): Float32Array {
  const field = new Float32Array(size * size);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) field[y * size + x] = h((x + 0.5) * inv, (y + 0.5) * inv);
  }
  return field;
}

/** Tangent-space normal map derived from a tileable height field. */
function bakeNormal(size: number, strength: number, aniso: number, field: Float32Array): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const yp = ((y + 1) % size) * size, yn = ((y - 1 + size) % size) * size, yc = y * size;
    for (let x = 0; x < size; x++) {
      const xp = (x + 1) % size, xn = (x - 1 + size) % size;
      // Wrapped central differences keep the normal map as seamless as the
      // height field it came from.
      const dx = (field[yc + xp] - field[yc + xn]) * strength;
      const dy = (field[yp + x] - field[yn + x]) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len; ny /= len; nz /= len;
      const o = (y * size + x) * 4;
      data[o] = (nx * 0.5 + 0.5) * 255;
      data[o + 1] = (ny * 0.5 + 0.5) * 255;
      data[o + 2] = (nz * 0.5 + 0.5) * 255;
      data[o + 3] = 255;
    }
  }
  return finishTexture(new THREE.DataTexture(data, size, size, THREE.RGBAFormat), false, aniso);
}

/** Strata count in the rock map. Integer, so the bedding wraps in V. */
const ROCK_BEDS = 9;

/** Height field for the rock map — shared by its albedo and its normal. */
function rockHeight(u: number, v: number): number {
  // Warped strata. The warp is what turns concentric bands into geology.
  const warp = fbmT(u, v, 3, 4, 401) - 0.5;
  const band = v * ROCK_BEDS + warp * 1.9 + fbmT(u, v, 6, 3, 88) * 0.55;
  const step = Math.floor(band);
  const frac = band - step;
  // Bed index wraps with the bands, so bed N and bed N+ROCK_BEDS agree.
  const bed = hash2(0, ((step % ROCK_BEDS) + ROCK_BEDS) % ROCK_BEDS, 6101);
  // Beds sit proud or recessed; the joint between them is a hard dark line.
  const joint = smoothstep(0.0, 0.07, frac) * smoothstep(1.0, 0.93, frac);
  // Fractures cut across the bedding.
  const fracture = ridgedT(u, v, 5, 4, 733);
  return bed * 0.55 + joint * 0.35 + fbmT(u, v, 24, 3, 12) * 0.16 - Math.pow(fracture, 6) * 0.5;
}

function makeSandTexture(size: number, aniso: number): THREE.DataTexture {
  return bakeAlbedo(size, aniso, true, (u, v, out) => {
    const grain = fbmT(u, v, 32, 3, 21);
    // Wind ripples: a warped sine, the signature of a dry beach at low sun.
    const ripple = 0.5 + 0.5 * Math.sin((v * 13 + (fbmT(u, v, 4, 3, 55) - 0.5) * 3.4) * Math.PI * 2);
    const shell = worleyT(u, v, 14, 909);
    const pebble = 1 - smoothstep(0.0, 0.22, shell);
    const t = grain * 0.45 + ripple * 0.35 + 0.2;
    // Bleached coral sand, warm in the troughs.
    out[0] = 0.78 + t * 0.20 - pebble * 0.10;
    out[1] = 0.68 + t * 0.20 - pebble * 0.06;
    out[2] = 0.50 + t * 0.20 + pebble * 0.06;
    // Sparse dark mineral grains stop it reading as flat cream.
    if (grain > 0.74) { out[0] -= 0.16; out[1] -= 0.15; out[2] -= 0.10; }
    out[3] = 0.94 - t * 0.10 + pebble * 0.06;
  });
}

function makeJungleTexture(size: number, aniso: number): THREE.DataTexture {
  return bakeAlbedo(size, aniso, true, (u, v, out) => {
    const leaf = worleyT(u, v, 9, 1301);
    const litter = worleyT(u * 2 + 0.31, v * 2, 15, 4402);
    const humus = fbmT(u, v, 6, 4, 77);
    const moss = fbmT(u * 2, v * 2, 5, 3, 611);
    // Dark wet humus base.
    let r = 0.12 + humus * 0.10;
    let g = 0.16 + humus * 0.14;
    let b = 0.07 + humus * 0.06;
    // Leaf plates catch the light.
    const lit = 1 - smoothstep(0.10, 0.55, leaf);
    r += lit * (0.16 + moss * 0.14);
    g += lit * (0.30 + moss * 0.20);
    b += lit * (0.07 + moss * 0.06);
    // Fallen fronds go rusty ochre — the warm accent the greens need.
    const dead = (1 - smoothstep(0.05, 0.30, litter)) * smoothstep(0.45, 0.8, humus);
    r += dead * 0.30; g += dead * 0.17; b += dead * 0.04;
    out[0] = r; out[1] = g; out[2] = b;
    out[3] = 0.97 - lit * 0.14 - dead * 0.05;
  });
}

/** Rock albedo, reading the strata height field the normal map also uses. */
function makeRockTexture(size: number, aniso: number, relief: Float32Array): THREE.DataTexture {
  return bakeAlbedo(size, aniso, true, (u, v, out, i) => {
    const h = relief[i];
    const grit = fbmT(u, v, 40, 2, 313);
    const iron = smoothstep(0.55, 0.95, fbmT(u, v * 3, 3, 4, 271));
    // Warm sandstone through to a shaded grey-brown in the recesses.
    let r = 0.30 + h * 0.44 + grit * 0.07;
    let g = 0.26 + h * 0.39 + grit * 0.06;
    let b = 0.20 + h * 0.30 + grit * 0.05;
    // Iron staining bleeding down the beds.
    r += iron * 0.20; g += iron * 0.07; b -= iron * 0.03;
    out[0] = r; out[1] = g; out[2] = b;
    out[3] = 0.86 - h * 0.16 + grit * 0.05;
  });
}

function makeGrassTexture(size: number, aniso: number): THREE.DataTexture {
  return bakeAlbedo(size, aniso, true, (u, v, out) => {
    // Stretching the lattice on one axis gives blades instead of blobs.
    const blade = fbmT(u * 5, v, 16, 3, 1717);
    const tuft = worleyT(u, v, 11, 2029);
    const patch = fbmT(u, v, 3, 4, 88);
    const clump = 1 - smoothstep(0.0, 0.5, tuft);
    const t = blade * 0.6 + clump * 0.4;
    // Sun-cured hillside grass: straw at the tips, olive at the root.
    let r = 0.34 + t * 0.42 + patch * 0.10;
    let g = 0.34 + t * 0.34 + patch * 0.12;
    let b = 0.14 + t * 0.17 + patch * 0.05;
    // Shadowed root line under every clump.
    const shade = smoothstep(0.55, 0.95, tuft);
    r -= shade * 0.13; g -= shade * 0.11; b -= shade * 0.05;
    out[0] = r; out[1] = g; out[2] = b;
    out[3] = 0.95 - t * 0.06;
  });
}

/**
 * Low-frequency variation: R = macro tint, G = warmth, B = biome drift.
 * Linear, not sRGB — this is data, not colour.
 */
function makeMacroTexture(size: number, aniso: number): THREE.DataTexture {
  return bakeAlbedo(size, aniso, false, (u, v, out) => {
    out[0] = fbmT(u, v, 3, 5, 5501);
    out[1] = fbmT(u, v, 5, 4, 8123);
    out[2] = fbmT(u, v, 2, 5, 3307);
    out[3] = 1;
  });
}

// ---------------------------------------------------------------------------
// Terrain field — the analytic ground, and the grids that make it cheap
// ---------------------------------------------------------------------------

interface Field {
  /**
   * Interleaved, stride `F_STRIDE`:
   *   0 land signed distance, metres, >0 land
   *   1 macro elevation above `shoreProfile(d)` — hills, swell, wild ridges
   *   2 street flatness 0..1, damping detail noise under the districts
   *   3 aridity 0..1 from the biome — jungle floor → dry hillside grass
   * Interleaved because `heightAt` wants three of the four and a scattered
   * read of three separate arrays costs three cache misses instead of one.
   */
  data: Float32Array;
  /** Macro ambient occlusion 0..255, from horizon sampling. Vertex-rate only. */
  ao: Uint8Array;
  res: number;
  /** Grid cells per metre. */
  scale: number;
}

/**
 * The civic footprint. See the CIVIC LANDMASS note at the top of the file:
 * this exists so the districts the atlas declares are not underwater.
 */
function buildCivic() {
  const segs: Float64Array[] = [];
  for (const ave of AVENUES) {
    for (let i = 0; i < ave.points.length - 1; i++) {
      const [ax, az] = ave.points[i];
      const [bx, bz] = ave.points[i + 1];
      const vx = bx - ax, vz = bz - az;
      segs.push(Float64Array.of(ax, az, vx, vz, 1 / Math.max(1e-6, vx * vx + vz * vz)));
    }
  }
  const seg = new Float64Array(segs.length * 5);
  segs.forEach((s, i) => seg.set(s, i * 5));

  // Land landmarks get a footing; Isla Roca gets an island and Puente Dorado
  // deliberately gets nothing, because it has to span open water.
  const nodes: number[] = [];
  for (const lm of LANDMARKS) {
    if (lm.key === "bridge") continue;
    nodes.push(lm.x, lm.z, lm.key === "alcatraz" ? 92 : 150, lm.key === "alcatraz" ? 1 : 0);
  }

  return { seg, segCount: segs.length, nodes };
}

const CIVIC = buildCivic();
const DISTRICT_MARGIN = 1.18;
const AVENUE_MARGIN = 118;
/** Peak amplitude of the civic wobble, so the bounds below can't clip it. */
const CIVIC_WOBBLE = 49;

/**
 * Everything the civic footprint can possibly reach, plus the wobble and the
 * smooth-max blend width. Outside this box `civicLand` cannot influence the
 * result, and skipping it there removes ~90% of the coastline bake's cost.
 */
const CIVIC_BOUNDS = (() => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const grow = (x: number, z: number, r: number) => {
    x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r);
    z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r);
  };
  for (const d of DISTRICTS) grow(d.x, d.z, d.radius * DISTRICT_MARGIN);
  for (const a of AVENUES) for (const [x, z] of a.points) grow(x, z, AVENUE_MARGIN);
  for (let i = 0; i < CIVIC.nodes.length; i += 4) {
    grow(CIVIC.nodes[i], CIVIC.nodes[i + 1], CIVIC.nodes[i + 2]);
  }
  const pad = CIVIC_WOBBLE + 90; // wobble + smooth-max blend width
  return { x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad };
})();

function civicLand(x: number, z: number): number {
  let best = -1e9;
  for (let i = 0; i < DISTRICTS.length; i++) {
    const d = DISTRICTS[i];
    const dx = x - d.x, dz = z - d.z;
    const v = d.radius * DISTRICT_MARGIN - Math.sqrt(dx * dx + dz * dz);
    if (v > best) best = v;
  }
  for (let i = 0; i < CIVIC.segCount; i++) {
    const v = AVENUE_MARGIN - segDistance(x, z, CIVIC.seg, i * 5);
    if (v > best) best = v;
  }
  for (let i = 0; i < CIVIC.nodes.length; i += 4) {
    if (CIVIC.nodes[i + 3] === 1) continue; // islands are added after the wobble
    const dx = x - CIVIC.nodes[i], dz = z - CIVIC.nodes[i + 1];
    const v = CIVIC.nodes[i + 2] - Math.sqrt(dx * dx + dz * dz);
    if (v > best) best = v;
  }
  // Its own wobble, out of phase with the atlas coastline, so the union never
  // reads as a string of circles.
  best += Math.sin(x * 0.0062 - z * 0.0048 + 2.1) * 34 + Math.sin(x * 0.0139 + z * 0.0107 - 0.7) * 15;
  for (let i = 0; i < CIVIC.nodes.length; i += 4) {
    if (CIVIC.nodes[i + 3] !== 1) continue;
    const dx = x - CIVIC.nodes[i], dz = z - CIVIC.nodes[i + 1];
    const v = CIVIC.nodes[i + 2] - Math.sqrt(dx * dx + dz * dz);
    if (v > best) best = v;
  }
  return best;
}

/**
 * `atlas.landSignedDistance` with its strait clause omitted.
 *
 * WORKAROUND — delete the moment atlas.ts guards its own clause. The atlas runs
 * `d = min(d, -channel * endFade)` for every point inside the strait's z-band,
 * including the whole map either side of the channel, where `channel` is
 * negative and the expression is therefore a small *positive* number. At the
 * band's ends `endFade` reaches zero, so d is pinned to ~0 — a shoreline ruled
 * straight across the entire world at z = -1500 and z = -700. Both creases are
 * plainly visible in a relief render. Everything below is copied verbatim from
 * `landSignedDistance` minus that clause; it is only ever consulted in the band
 * and outside the channel, and only as a `max`, so if the atlas is corrected
 * this silently becomes a no-op.
 */
function atlasWithoutStrait(x: number, z: number): number {
  const r = Math.hypot(x * 1.0, (z + 120) * 0.86);
  let d = LAND_RADIUS - r;
  const bay = 1180 - Math.hypot((x - 980) * 0.78, (z + 900) * 1.05);
  d = Math.min(d, -bay);
  d = Math.min(d, x + 1560);
  return (
    d +
    Math.sin(x * 0.0034 + z * 0.0021) * 52 +
    Math.sin(x * 0.0091 - z * 0.0072) * 24 +
    Math.sin(z * 0.0157 + 1.7) * 11
  );
}

/** Authoritative land signed distance: the atlas, reconciled with the city. */
function landDistance(x: number, z: number): number {
  let atlas = landSignedDistance(x, z);
  let channel = -1;
  let endFade = 0;
  if (z > STRAIT.zFrom && z < STRAIT.zTo) {
    channel = STRAIT.halfWidth - Math.abs(x - STRAIT.x);
    endFade = Math.min(1, Math.min(z - STRAIT.zFrom, STRAIT.zTo - z) / 160);
    if (channel <= 0) atlas = Math.max(atlas, atlasWithoutStrait(x, z));
  }

  let d =
    x < CIVIC_BOUNDS.x0 || x > CIVIC_BOUNDS.x1 || z < CIVIC_BOUNDS.z0 || z > CIVIC_BOUNDS.z1
      ? atlas
      : smax(atlas, civicLand(x, z), 90);

  // Re-cut the channel: nothing the city adds is allowed to fill it in, and
  // Puente Dorado has to have something to span.
  if (channel > 0) d = Math.min(d, -channel * endFade);

  // And keep the Pacific open on the west edge.
  return Math.min(d, x + 1560 + Math.sin(z * 0.0041) * 44);
}

/** Normalised influence of the authored hills — suppresses the wild ridges. */
function hillInfluence(x: number, z: number): number {
  let m = 0;
  for (let i = 0; i < HILLS.length; i++) {
    const h = HILLS[i];
    const dx = x - h.x, dz = z - h.z;
    const t = 1 - Math.sqrt(dx * dx + dz * dz) / (h.radius * 1.15);
    if (t > m) m = t;
  }
  return clamp01(m);
}

/** How much the districts flatten the ground. 1 = pool-table, 0 = wild. */
function urbanMask(x: number, z: number): number {
  let m = 0;
  for (let i = 0; i < DISTRICTS.length; i++) {
    const d = DISTRICTS[i];
    const dx = x - d.x, dz = z - d.z;
    const t = 1 - smoothstep(0.5, 1.0, Math.sqrt(dx * dx + dz * dz) / d.radius);
    if (t > m) m = t;
  }
  return m;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

/** A single concentric ring of the clipmap. */
interface Level {
  index: number;
  cell: number;
  mesh: THREE.Mesh;
  geom: THREE.BufferGeometry;
  pos: Float32Array;
  nrm: Float32Array;
  splat: Uint8Array;
  aux: Uint8Array;
  idx: Uint16Array;
  /** Origin the vertex buffer currently on the GPU was built around. */
  ox: number;
  oz: number;
  ready: boolean;
  minY: number;
  maxY: number;
}

interface PendingBuild {
  level: Level;
  ox: number;
  oz: number;
  /** True while filling the height halo, false while emitting vertices. */
  sampling: boolean;
  row: number;
  minY: number;
  maxY: number;
}

/** Terrain publishes a couple of extras neighbours have asked for. */
interface PalmasTerrainService extends TerrainService {
  /** Signed distance to the coastline in metres. >0 land, <0 water. */
  landDistanceAt(x: number, z: number): number;
  /** Depth of water at an XZ position, 0 on land. */
  waterDepthAt(x: number, z: number): number;
  /** Slope 0..1 (0 = flat, 1 = vertical) — cheap surface classification. */
  slopeAt(x: number, z: number): number;
}

/**
 * Async only so the loading screen can repaint between bake phases — building
 * a 6 km world and seven procedural material maps takes the best part of a
 * second and a frozen loading bar looks like a hang. Nothing here awaits I/O.
 */
const createTerrain: SystemFactory = async (ctx) => {
  const breathe = () => new Promise<void>((r) => setTimeout(r, 0));
  const tier = TIERS[ctx.quality] ?? TIERS.high;
  const rng = makeRng(Math.floor(ctx.rng() * 0xffffffff) >>> 0);

  // Three independent noise fields so octaves at different scales never
  // correlate into visible grid artefacts.
  const nSwell = createNoise2D(rng);
  const nRidge = createNoise2D(rng);
  const nDetail = createNoise2D(rng);

  // -------------------------------------------------------------------------
  // Bake the macro field
  // -------------------------------------------------------------------------

  const RES = tier.field;
  const FDATA = new Float32Array(RES * RES * F_STRIDE);
  const field: Field = {
    data: FDATA,
    ao: new Uint8Array(RES * RES),
    res: RES,
    scale: (RES - 1) / (2 * FIELD_EXTENT),
  };

  {
    const step = (2 * FIELD_EXTENT) / (RES - 1);
    // Ground elevation, cached: pass C and the occlusion pass would otherwise
    // evaluate `shoreProfile` (and its exp) thirty times per cell.
    const elev = new Float32Array(RES * RES);

    // --- Pass A — coastline, and everything that only needs it --------------
    for (let j = 0; j < RES; j++) {
      const z = -FIELD_EXTENT + j * step;
      for (let i = 0; i < RES; i++) {
        const x = -FIELD_EXTENT + i * step;
        const o = (j * RES + i) * F_STRIDE;
        const d = landDistance(x, z);
        FDATA[o + F_DIST] = d;
        FDATA[o + F_CALM] = d > 0 ? 1 - 0.88 * urbanMask(x, z) : 1;
      }
    }

    await breathe();

    // --- Pass B — macro elevation above the shore profile -------------------
    for (let j = 0; j < RES; j++) {
      const z = -FIELD_EXTENT + j * step;
      for (let i = 0; i < RES; i++) {
        const x = -FIELD_EXTENT + i * step;
        const c = j * RES + i;
        const o = c * F_STRIDE;
        const d = FDATA[o + F_DIST];

        if (d <= 0) {
          // Bay floor: broad basins and a shelf that gets rockier offshore.
          const amp = Math.min(1, -d / 90);
          const m = (nSwell(x * 0.0011, z * 0.0011) * 6.5 + nRidge(x * 0.0029, z * 0.0029) * 3.0) * amp;
          FDATA[o + F_MACRO] = m;
          elev[c] = shoreProfile(d) + m;
          continue;
        }

        // Hills fade to nothing at the waterline: without this, Presidio Ridge
        // fills the strait and Puente Dorado spans a meadow.
        const hills = hillHeight(x, z);
        const shoreFade = smoothstep(0, HILL_SHORE_FADE, d);
        const inland = smoothstep(0, DETAIL_FADE * 2.2, d);
        let h = hills * shoreFade;

        // Ground swell between the named hills.
        h += (nSwell(x * 0.00085, z * 0.00085) +
          nSwell(x * 0.0017, z * 0.0017) * 0.5 +
          nSwell(x * 0.0035, z * 0.0035) * 0.25) * 11 * inland;

        // Ridged relief for the wild country away from the authored hills — the
        // north headland and the outer coast need character of their own or they
        // read as a table.
        //
        // NOTHING baked into this grid may run above ~1/(8 * lattice step), or
        // bilinear reconstruction turns it into a quilt of axis-aligned facets.
        // At 17 m that caps us near a 140 m wavelength; the three octaves below
        // bottom out at 190 m. Everything finer is evaluated analytically in
        // `heightAt`, where there is no lattice to alias against.
        let wide = 0, amp = 1, f = 0.00115;
        for (let k = 0; k < 3; k++) {
          const t = 1 - Math.abs(nRidge(x * f + 91.3, z * f - 44.1));
          wide += t * t * amp;
          amp *= 0.5;
          f *= 2.15;
        }
        const urban = 1 - FDATA[o + F_CALM]; // 0..0.88
        h += (wide / 1.75 - 0.32) * 46 * (1 - hillInfluence(x, z) * 0.88) * inland * (1 - urban);

        FDATA[o + F_MACRO] = h;
        elev[c] = shoreProfile(d) + h;
      }
    }

    await breathe();

    // --- Pass C — biome aridity ---------------------------------------------
    for (let j = 0; j < RES; j++) {
      const z = -FIELD_EXTENT + j * step;
      const jp = Math.min(RES - 1, j + 1) * RES;
      const jm = Math.max(0, j - 1) * RES;
      for (let i = 0; i < RES; i++) {
        const x = -FIELD_EXTENT + i * step;
        const c = j * RES + i;
        const d = FDATA[c * F_STRIDE + F_DIST];

        // The reconciled distance is a smooth *max* of the atlas SDF and the
        // civic footprint, so d <= 0 implies the atlas SDF is also <= 0, which
        // implies `biomeAt` would return "ocean". Skipping the call there is
        // exact, and it is three quarters of the map.
        if (d <= 0) {
          FDATA[c * F_STRIDE + F_VEG] = 0.16;
          continue;
        }

        const e = elev[c];
        const ex = elev[j * RES + Math.min(RES - 1, i + 1)] - elev[j * RES + Math.max(0, i - 1)];
        const ez = elev[jp + i] - elev[jm + i];
        const grad = Math.sqrt(ex * ex + ez * ez) / (2 * step);
        const slope = 1 - 1 / Math.sqrt(1 + grad * grad);

        // The atlas classifies; we only turn its verdict into a blend weight.
        let biome = biomeAt(x, z, e, slope);
        if (biome === "ocean") {
          // Reconciled land the atlas SDF still believes is bay (see the CIVIC
          // LANDMASS note). Re-run the rest of `biomeAt`'s tree against the
          // coastline we actually built.
          biome =
            d < 26 && e < 8 ? "beach"
            : slope > 0.62 ? "cliff"
            : districtAt(x, z) ? "city"
            : e > 95 ? "hillside"
            : "jungle";
        }
        let arid: number;
        switch (biome) {
          case "beach": arid = 0.24; break;
          case "cliff": arid = 0.80; break;
          case "city": arid = 0.66; break;
          case "hillside": arid = 0.93; break;
          default: arid = 0.10; break; // jungle — "ocean" was handled above
        }
        FDATA[c * F_STRIDE + F_VEG] = arid;
      }
    }

    await breathe();

    // --- Macro occlusion -----------------------------------------------------
    // Horizon angle in eight directions at three radii. This is what puts shade
    // in the gullies and keeps the ridgelines bright, and unlike a shadow map it
    // holds true for every sun angle — which matters, because the sky system
    // moves the sun. Pure array reads now that `elev` is cached.
    const RAD = [2, 5, 11];
    const DIR = [1, 0, 1, 1, 0, 1, -1, 1, -1, 0, -1, -1, 0, -1, 1, -1];
    for (let j = 0; j < RES; j++) {
      for (let i = 0; i < RES; i++) {
        const c = j * RES + i;
        const e = elev[c];
        let occ = 0;
        for (let a = 0; a < 8; a++) {
          const ca = DIR[a * 2], sa = DIR[a * 2 + 1];
          let hmax = 0;
          for (let k = 0; k < 3; k++) {
            const si = Math.min(RES - 1, Math.max(0, i + ca * RAD[k]));
            const sj = Math.min(RES - 1, Math.max(0, j + sa * RAD[k]));
            const rise = (elev[sj * RES + si] - e) / (RAD[k] * step);
            if (rise > hmax) hmax = rise;
          }
          occ += hmax / (hmax + 0.9);
        }
        field.ao[c] = (1 - clamp01(occ / 8) * 0.85) * 255;
      }
    }
  }

  // Shared bilinear tap. Not reentrant — nothing here calls itself.
  const tap = new Float32Array(F_STRIDE);

  /** Fill `tap` with all four macro channels. Clamped; outside is deep water. */
  function sampleField(x: number, z: number): Float32Array {
    let u = (x + FIELD_EXTENT) * field.scale;
    let v = (z + FIELD_EXTENT) * field.scale;
    const lim = RES - 1.0001;
    u = u < 0 ? 0 : u > lim ? lim : u;
    v = v < 0 ? 0 : v > lim ? lim : v;
    const i = u | 0, j = v | 0;
    const fu = u - i, fv = v - j;
    const o = (j * RES + i) * F_STRIDE;
    const r = RES * F_STRIDE;
    for (let k = 0; k < F_STRIDE; k++) {
      const a = FDATA[o + k], b = FDATA[o + F_STRIDE + k];
      const c = FDATA[o + r + k], e = FDATA[o + r + F_STRIDE + k];
      const top = a + (b - a) * fu;
      tap[k] = top + (c + (e - c) * fu - top) * fv;
    }
    return tap;
  }

  function sampleAo(x: number, z: number): number {
    let u = (x + FIELD_EXTENT) * field.scale;
    let v = (z + FIELD_EXTENT) * field.scale;
    const lim = RES - 1.0001;
    u = u < 0 ? 0 : u > lim ? lim : u;
    v = v < 0 ? 0 : v > lim ? lim : v;
    const i = u | 0, j = v | 0;
    const fu = u - i, fv = v - j;
    const o = j * RES + i;
    const g = field.ao;
    const top = g[o] + (g[o + 1] - g[o]) * fu;
    const bot = g[o + RES] + (g[o + RES + 1] - g[o + RES]) * fu;
    return (top + (bot - top) * fv) * (1 / 255);
  }

  // -------------------------------------------------------------------------
  // The ground function. Everything — mesh, collision, trees, streets — is
  // this. Roughly 220 ns a call.
  // -------------------------------------------------------------------------

  function heightAt(x: number, z: number): number {
    const f = sampleField(x, z);
    const d = f[F_DIST];
    let h = shoreProfile(d) + f[F_MACRO];

    if (d > 0) {
      const inland = clamp01(d / DETAIL_FADE);
      const calm = f[F_CALM];
      // Drainage spurs. This octave lives here rather than in the baked grid
      // because at a ~230 m wavelength the lattice would quilt it, and it is
      // the band that gives a hillside its gullies and shoulders. Masked to the
      // flanks of raised ground so the flats stay flat.
      const flank = smoothstep(26, 105, h) * inland * calm;
      if (flank > 0.002) {
        const t = 1 - Math.abs(nRidge(x * 0.0043, z * 0.0043));
        h += (t * t - 0.42) * 17 * flank;
      }
      // Mid detail: the metre-scale lumpiness that makes a hillside walkable
      // rather than a ramp. Damped under the districts so streets stay flat.
      h += (nDetail(x * 0.0115, z * 0.0115) + nDetail(x * 0.0237, z * 0.0237) * 0.45) *
        3.1 * inland * calm;
      // Fine grain — sub-metre, always present, gives footfall something to read.
      h += nDetail(x * 0.062, z * 0.062) * 0.33 * calm;
      // Dunes: only in the beach band, aligned nowhere in particular.
      const dune = smoothstep(70, 14, d) * smoothstep(1, 7, h);
      if (dune > 0.001) h += nRidge(x * 0.019, z * 0.019) * 1.7 * dune;
    } else {
      // Bay floor. Amplitude tapers to nothing at the waterline so no sandbar
      // ever pokes through the surf line and no reef blocks the strait.
      const amp = Math.min(1, -d / 55);
      h += (nDetail(x * 0.0068, z * 0.0068) * 2.6 + nRidge(x * 0.028, z * 0.028) * 0.85) * amp;
      // Longshore bars, parallel to the coast because they follow the SDF.
      h += Math.sin(d * 0.115) * 0.75 * amp * smoothstep(-260, -20, d);
    }
    return h;
  }

  const normalScratch = new THREE.Vector3();

  function normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    // Central differences on the same function the mesh was tessellated from,
    // so the surface the player slides on is the surface they can see.
    const e = 0.75;
    const hl = heightAt(x - e, z), hr = heightAt(x + e, z);
    const hd = heightAt(x, z - e), hu = heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  function slopeAt(x: number, z: number): number {
    return 1 - normalAt(x, z, normalScratch).y;
  }

  // -------------------------------------------------------------------------
  // Splat weights. Vertex-rate authority (biome, coastline, altitude); the
  // fragment shader sharpens and noises the boundaries at pixel rate.
  // -------------------------------------------------------------------------

  const splatOut = new Float32Array(4);

  function splatAt(h: number, slope: number, d: number, veg: number): Float32Array {
    // `slope` is 1 - normal.y, so a 30° face is only 0.13 and a 55° face 0.43.
    // The thresholds have to be read in those terms, not in degrees.
    const rock = clamp01(smoothstep(0.13, 0.40, slope) + smoothstep(175, 255, h) * 0.55);
    let sand: number, jungle: number, grass: number;

    if (d <= 0) {
      // Bay floor: pale carbonate silt, rock where the shelf breaks away.
      sand = 1;
      jungle = 0;
      grass = 0;
      splatOut[2] = Math.max(rock * 0.8, smoothstep(-120, -420, d) * 0.45);
    } else {
      // Beach: wide where the shore is shallow, pinched where it is a cliff.
      const beach = smoothstep(85, 6, d) * (1 - smoothstep(3.5, 14, h)) * (1 - rock * 0.8);
      // Aridity from the atlas biome, pushed further by raw altitude — the
      // jungle canopy gives out on the exposed tops.
      const arid = clamp01(veg * 1.15 - 0.10 + smoothstep(90, 190, h) * 0.55);
      sand = beach;
      jungle = (1 - beach) * (1 - arid);
      grass = (1 - beach) * arid;
      splatOut[2] = rock;
    }

    splatOut[0] = sand;
    splatOut[1] = jungle;
    splatOut[3] = grass;
    const sum = splatOut[0] + splatOut[1] + splatOut[2] + splatOut[3] + 1e-5;
    splatOut[0] /= sum; splatOut[1] /= sum; splatOut[2] /= sum; splatOut[3] /= sum;
    return splatOut;
  }

  // -------------------------------------------------------------------------
  // Material
  // -------------------------------------------------------------------------

  const A = tier.aniso;
  let maxAniso = A;
  try {
    maxAniso = Math.min(A, ctx.renderer.capabilities.getMaxAnisotropy());
  } catch {
    /* headless — anisotropy is a hint, not a requirement */
  }

  await breathe();

  // The strata field is the single most expensive thing baked here; the rock
  // albedo and the rock normal both read the same copy of it.
  const rockRelief = heightField(tier.tex, rockHeight);

  const texSand = makeSandTexture(tier.tex, maxAniso);
  const texJungle = makeJungleTexture(tier.tex, maxAniso);
  const texRock = makeRockTexture(tier.tex, maxAniso, rockRelief);
  const texGrass = makeGrassTexture(tier.tex, maxAniso);
  const texMacro = makeMacroTexture(tier.tex, 1);
  const texDetailN = bakeNormal(
    tier.tex, tier.tex * 0.020, maxAniso,
    heightField(tier.tex, (u, v) => fbmT(u, v, 18, 4, 4404) * 0.7 + (1 - worleyT(u, v, 26, 5511)) * 0.3),
  );
  const texRockN = bakeNormal(tier.tex, tier.tex * 0.055, maxAniso, rockRelief);

  const hazeColor = new THREE.Color(0x9fd6ea);

  const uniforms = {
    uSand: { value: texSand },
    uJungle: { value: texJungle },
    uRock: { value: texRock },
    uGrass: { value: texGrass },
    uMacro: { value: texMacro },
    uDetailN: { value: texDetailN },
    uRockN: { value: texRockN },
    uHaze: { value: hazeColor },
    uSeaLevel: { value: SEA_LEVEL },
    // Mean colour of each map, used past the detail-fade distance. Sampling a
    // 7 m tile at 2 km is pure aliasing; a flat mean modulated by the macro
    // map reads better and costs less.
    uAvgSand: { value: new THREE.Color(0.80, 0.72, 0.56) },
    uAvgJungle: { value: new THREE.Color(0.19, 0.28, 0.11) },
    uAvgRock: { value: new THREE.Color(0.44, 0.39, 0.31) },
    uAvgGrass: { value: new THREE.Color(0.50, 0.47, 0.22) },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    dithering: true,
  });
  if (tier.cheap) material.defines = { ...(material.defines ?? {}), SP_CHEAP: "" };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        attribute vec4 aSplat;
        attribute vec2 aAux;
        varying vec3 vWPos;
        varying vec3 vWNrm;
        varying vec4 vSplat;
        varying vec2 vAux;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        vWNrm = normalize( mat3( modelMatrix ) * objectNormal );
        vSplat = aSplat;
        vAux = aAux;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        uniform sampler2D uSand;
        uniform sampler2D uJungle;
        uniform sampler2D uRock;
        uniform sampler2D uGrass;
        uniform sampler2D uMacro;
        uniform sampler2D uDetailN;
        uniform sampler2D uRockN;
        uniform vec3 uHaze;
        uniform vec3 uAvgSand;
        uniform vec3 uAvgJungle;
        uniform vec3 uAvgRock;
        uniform vec3 uAvgGrass;
        uniform float uSeaLevel;
        varying vec3 vWPos;
        varying vec3 vWNrm;
        varying vec4 vSplat;
        varying vec2 vAux;

        // Ground tiling: ~6.9 m for the fine maps. Small enough that a footprint
        // covers a handful of texels, large enough not to strobe at running speed.
        const float SP_TILE = 0.145;

        void spSurface( out vec3 oAlb, out float oRough, out vec3 oNrm ) {

          vec3 wN = normalize( vWNrm );
          vec3 p  = vWPos;
          float dist = length( p - cameraPosition );

          // --- variation ------------------------------------------------------
          // Two octaves of macro noise at world scale. Without this the ground
          // repeats on a visible grid from any elevated position, which is the
          // single loudest tell of procedural terrain.
          vec3 mac = texture2D( uMacro, p.xz * 0.00092 ).rgb;
          vec3 mic = texture2D( uMacro, p.xz * 0.0138 ).rgb;

          // --- splat ----------------------------------------------------------
          float steep = 1.0 - wN.y;
          vec4 w = vSplat;
          // Re-derive rock per pixel: the vertex weight is interpolated, and a
          // lerped cliff edge looks like a smear.
          w.z = max( w.z, smoothstep( 0.13, 0.40, steep ) );
          w.x *= 1.0 + ( mic.r - 0.5 ) * 0.9;
          w.y *= 1.0 + ( mic.g - 0.5 ) * 1.1 + ( mac.b - 0.5 ) * 0.8;
          w.w *= 1.0 + ( mic.b - 0.5 ) * 1.1 - ( mac.b - 0.5 ) * 0.8;
          w = max( w, vec4( 0.0 ) );
          w = w * w * w;                       // sharpen: interlock, not dissolve
          w /= ( w.x + w.y + w.z + w.w + 1e-4 );

          // --- triplanar rock -------------------------------------------------
          // Cliffs are the one place a planar XZ projection falls apart: the
          // texture stretches into vertical smears. Project on all three axes and
          // blend by the normal, so the strata stay horizontal on a vertical face.
          vec3 bw = abs( wN ); bw = bw * bw * bw * bw;
          bw /= ( bw.x + bw.y + bw.z + 1e-5 );
          float rs = SP_TILE * 0.55;
          vec4 rockX = texture2D( uRock, p.zy * rs );
          vec4 rockY = texture2D( uRock, p.xz * rs );
          vec4 rockZ = texture2D( uRock, p.xy * rs );
          vec4 tRock = rockX * bw.x + rockY * bw.y + rockZ * bw.z;

          vec4 tSand   = texture2D( uSand,   p.xz * SP_TILE );
          vec4 tJungle = texture2D( uJungle, p.xz * SP_TILE * 0.73 );
          vec4 tGrass  = texture2D( uGrass,  p.xz * SP_TILE * 0.61 );

          vec3 fine = tSand.rgb * w.x + tJungle.rgb * w.y + tRock.rgb * w.z + tGrass.rgb * w.w;
          vec3 mean = uAvgSand * w.x + uAvgJungle * w.y + uAvgRock * w.z + uAvgGrass * w.w;
          float near = smoothstep( 380.0, 90.0, dist );
          vec3 alb = mix( mean, fine, near );

          oRough = tSand.a * w.x + tJungle.a * w.y + tRock.a * w.z + tGrass.a * w.w;

          // --- macro tint ------------------------------------------------------
          alb *= 0.80 + 0.44 * mac.r;
          alb  = mix( alb, alb * vec3( 1.12, 1.01, 0.83 ), mac.g * 0.75 );   // sun-bleached patches
          alb  = mix( alb, alb * vec3( 0.88, 1.06, 0.86 ), ( 1.0 - mac.g ) * 0.35 * w.y );

          // --- baked occlusion --------------------------------------------------
          alb *= mix( 0.34, 1.0, vAux.x );

          // --- the waterline ----------------------------------------------------
          // Wet sand is darker and far glossier than dry sand. This band is what
          // sells the beach; the water system draws the foam on top of it.
          float above = p.y - uSeaLevel;
          float shore = vAux.y;
          float wet   = shore * ( 1.0 - smoothstep( -0.5, 2.0, above ) );
          alb   *= mix( 1.0, 0.44, wet );
          oRough = mix( oRough, 0.12, wet );
          // A bleached salt/tide line just above the wet band.
          float salt = shore * smoothstep( 1.5, 2.6, above ) * ( 1.0 - smoothstep( 2.6, 5.0, above ) );
          alb = mix( alb, vec3( 0.94, 0.91, 0.83 ), salt * 0.30 * mic.r );

          // --- the bay floor ----------------------------------------------------
          float depth = max( 0.0, uSeaLevel - p.y );
          float sub   = smoothstep( 0.0, 0.8, depth );
          alb = mix( alb, alb * mix( vec3( 1.0 ), vec3( 0.34, 0.62, 0.72 ), smoothstep( 0.0, 34.0, depth ) ), sub );
          oRough = mix( oRough, 0.42, sub );

          // --- normals -----------------------------------------------------------
          float nFade = smoothstep( 300.0, 40.0, dist );
          vec3 dn = texture2D( uDetailN, p.xz * 0.62 ).xyz * 2.0 - 1.0;
          #ifndef SP_CHEAP
            vec3 dn2 = texture2D( uDetailN, p.xz * 0.094 ).xyz * 2.0 - 1.0;
            vec2 tn = ( dn.xy + dn2.xy * 0.8 ) * nFade;
          #else
            vec2 tn = dn.xy * nFade;
          #endif
          // Frame built off the least-aligned world axis, so it never degenerates
          // however the ground is tilted.
          vec3 a = abs( wN );
          vec3 ref = ( a.x <= a.y && a.x <= a.z ) ? vec3( 1.0, 0.0, 0.0 )
                   : ( a.y <= a.z ) ? vec3( 0.0, 1.0, 0.0 ) : vec3( 0.0, 0.0, 1.0 );
          vec3 T = normalize( cross( ref, wN ) );
          vec3 B = cross( wN, T );
          vec3 nGround = normalize( wN + T * tn.x * 0.8 + B * tn.y * 0.8 );

          #ifndef SP_CHEAP
            vec3 rx = texture2D( uRockN, p.zy * rs ).xyz * 2.0 - 1.0;
            vec3 ry = texture2D( uRockN, p.xz * rs ).xyz * 2.0 - 1.0;
            vec3 rz = texture2D( uRockN, p.xy * rs ).xyz * 2.0 - 1.0;
            vec3 nx = vec3( rx.xy + wN.zy, abs( rx.z ) * wN.x ).zyx;
            vec3 ny = vec3( ry.xy + wN.xz, abs( ry.z ) * wN.y ).xzy;
            vec3 nz = vec3( rz.xy + wN.xy, abs( rz.z ) * wN.z ).xyz;
            vec3 nRock = normalize( nx * bw.x + ny * bw.y + nz * bw.z );
            oNrm = normalize( mix( nGround, nRock, w.z * ( 0.25 + 0.75 * nFade ) ) );
          #else
            oNrm = nGround;
          #endif

          // --- aerial perspective -------------------------------------------------
          // Fog alone turns distance grey. Bleeding saturation out of the albedo
          // first is what makes 3 km read as 3 km instead of a foggy 300 m.
          float ap = smoothstep( 180.0, 2600.0, dist );
          float lum = dot( alb, vec3( 0.2126, 0.7152, 0.0722 ) );
          alb = mix( alb, mix( vec3( lum ), uHaze, 0.62 ), ap * 0.52 );

          oAlb = alb;
        }`,
      )
      .replace(
        "#include <map_fragment>",
        /* glsl */ `
        vec3 spAlbedo; float spRough; vec3 spNormal;
        spSurface( spAlbedo, spRough, spNormal );
        diffuseColor.rgb *= spAlbedo;`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        /* glsl */ `float roughnessFactor = clamp( spRough, 0.04, 1.0 );`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        /* glsl */ `normal = normalize( ( viewMatrix * vec4( spNormal, 0.0 ) ).xyz );`,
      );
  };

  // -------------------------------------------------------------------------
  // Clipmap
  // -------------------------------------------------------------------------

  const N = tier.grid;                     // quads per side, every level
  const VERTS = (N + 1) * (N + 1);
  const HALO = N + 3;                      // height scratch carries a 1-cell halo
  const QUADS = N * N - (N / 2) * (N / 2); // the hole is always this big
  const root = new THREE.Group();
  root.name = "palmas.terrain";
  root.matrixAutoUpdate = false;
  ctx.scene.add(root);

  // One shared scratch set: only one level is ever mid-rebuild.
  const scratchH = new Float32Array(HALO * HALO);
  const scratchD = new Float32Array(HALO * HALO);
  const scratchV = new Float32Array(HALO * HALO);
  const levels: Level[] = [];

  for (let l = 0; l < tier.levels; l++) {
    const geom = new THREE.BufferGeometry();
    const pos = new Float32Array(VERTS * 3);
    const nrm = new Float32Array(VERTS * 3);
    const splat = new Uint8Array(VERTS * 4);
    const aux = new Uint8Array(VERTS * 2);
    const idx = new Uint16Array(QUADS * 6);

    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    geom.setAttribute("aSplat", new THREE.BufferAttribute(splat, 4, true));
    geom.setAttribute("aAux", new THREE.BufferAttribute(aux, 2, true));
    geom.setIndex(new THREE.BufferAttribute(idx, 1));
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);

    const mesh = new THREE.Mesh(geom, material);
    mesh.name = `palmas.terrain.L${l}`;
    mesh.receiveShadow = true;
    // Terrain deliberately does not cast: at these frustum sizes a heightfield
    // shadowing itself is all acne and no shadow. The baked macro AO carries
    // the large-scale occlusion instead. Revisit if the sky system ever tunes
    // a normalBias for the sun.
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    root.add(mesh);

    levels.push({
      index: l,
      cell: tier.cell * Math.pow(2, l),
      mesh, geom, pos, nrm, splat, aux, idx,
      ox: NaN, oz: NaN, ready: false, minY: 0, maxY: 0,
    });
  }

  const outerHalf = (N * levels[levels.length - 1].cell) / 2;

  /**
   * Snap a level's centre to a whole multiple of twice its cell size, so its
   * outer edge always lands on the next level's grid lines — that alignment is
   * the entire reason the hole below can be cut without a gap or an overlap.
   * `SNAP_MULT` coarsens the step further, purely to re-tessellate less often.
   */
  function snap(v: number, cell: number): number {
    const s = cell * 2 * SNAP_MULT;
    return Math.round(v / s) * s;
  }

  /**
   * Rewrite a level's index buffer, omitting the cells the finer level covers.
   * Because level L-1's extent is exactly N/2 of level L's cells and its edges
   * sit on level L's grid lines, the hole is always a whole number of cells —
   * no gap, no overlap, nothing to z-fight.
   */
  function buildIndex(level: Level): void {
    const { idx } = level;
    let holeI0 = -1, holeJ0 = -1;
    const inner = levels[level.index - 1];
    if (inner && inner.ready) {
      const originX = level.ox - (N * level.cell) / 2;
      const originZ = level.oz - (N * level.cell) / 2;
      // Exact: the inner level spans N/2 of this level's cells and its edges lie
      // on this level's grid lines, so the hole is a whole number of cells.
      holeI0 = Math.round((inner.ox - (N * inner.cell) / 2 - originX) / level.cell);
      holeJ0 = Math.round((inner.oz - (N * inner.cell) / 2 - originZ) / level.cell);
      // Only ever bites after a teleport, when the inner level lags a frame.
      holeI0 = Math.min(N / 2, Math.max(0, holeI0));
      holeJ0 = Math.min(N / 2, Math.max(0, holeJ0));
    }

    let w = 0;
    const half = N / 2;
    for (let j = 0; j < N; j++) {
      const inJ = holeJ0 >= 0 && j >= holeJ0 && j < holeJ0 + half;
      for (let i = 0; i < N; i++) {
        if (inJ && i >= holeI0 && i < holeI0 + half) continue;
        const a = j * (N + 1) + i;
        const b = a + (N + 1);
        idx[w++] = a; idx[w++] = b; idx[w++] = b + 1;
        idx[w++] = a; idx[w++] = b + 1; idx[w++] = a + 1;
      }
    }
    // Pad any unused tail with a degenerate triangle rather than reallocating.
    while (w < idx.length) idx[w++] = 0;
    level.geom.setDrawRange(0, w);
    (level.geom.index as THREE.BufferAttribute).needsUpdate = true;
  }

  // --- incremental tessellation ---------------------------------------------

  let pending: PendingBuild | null = null;
  const queue: Level[] = [];

  function sampleRows(b: PendingBuild, budget: number): number {
    const c = b.level.cell;
    const x0 = b.ox - (N * c) / 2 - c;   // one cell of halo, for clean normals
    const z0 = b.oz - (N * c) / 2 - c;
    let done = 0;
    while (b.row < HALO) {
      const z = z0 + b.row * c;
      const o = b.row * HALO;
      for (let i = 0; i < HALO; i++) {
        const x = x0 + i * c;
        scratchH[o + i] = heightAt(x, z);
        // `heightAt` just tapped the field for this exact point; keep the two
        // channels the vertex pass needs rather than tapping again for them.
        scratchD[o + i] = tap[F_DIST];
        scratchV[o + i] = tap[F_VEG];
      }
      b.row++;
      done += HALO;
      if (done >= budget) break;
    }
    return done;
  }

  function emitRows(b: PendingBuild, budget: number): number {
    const { level } = b;
    const c = level.cell;
    const x0 = b.ox - (N * c) / 2;
    const z0 = b.oz - (N * c) / 2;
    const outermost = level.index === levels.length - 1;
    let done = 0;

    while (b.row <= N) {
      const j = b.row;
      const z = z0 + j * c;
      const edgeJ = !outermost && (j === 0 || j === N);
      for (let i = 0; i <= N; i++) {
        const x = x0 + i * c;
        const hi = (j + 1) * HALO + (i + 1);
        let h = scratchH[hi];

        // Crack stitching. Along the outer border this level meets a grid of
        // twice the spacing, so every other vertex has no partner over there.
        // Averaging the odd ones puts them exactly on the coarse edge segment:
        // watertight, with no skirt geometry and no T-junction shimmer.
        if (edgeJ) {
          if (i & 1) h = (scratchH[hi - 1] + scratchH[hi + 1]) * 0.5;
        } else if (!outermost && (i === 0 || i === N)) {
          if (j & 1) h = (scratchH[hi - HALO] + scratchH[hi + HALO]) * 0.5;
        }

        // Normals come straight off the height halo — no extra height calls,
        // and they match across level boundaries because the function does.
        const nx = scratchH[hi - 1] - scratchH[hi + 1];
        const nz = scratchH[hi - HALO] - scratchH[hi + HALO];
        const inv = 1 / Math.sqrt(nx * nx + nz * nz + 4 * c * c);
        const nyv = 2 * c * inv;

        const v = j * (N + 1) + i;
        level.pos[v * 3] = x;
        level.pos[v * 3 + 1] = h;
        level.pos[v * 3 + 2] = z;
        level.nrm[v * 3] = nx * inv;
        level.nrm[v * 3 + 1] = nyv;
        level.nrm[v * 3 + 2] = nz * inv;

        const d = scratchD[hi];
        const s = splatAt(h, 1 - nyv, d, scratchV[hi]);
        level.splat[v * 4] = s[0] * 255;
        level.splat[v * 4 + 1] = s[1] * 255;
        level.splat[v * 4 + 2] = s[2] * 255;
        level.splat[v * 4 + 3] = s[3] * 255;

        // Macro occlusion × local cavity. The cavity term is free — it falls out
        // of the halo we already sampled — and it is what darkens gullies and
        // brightens the ridge of every dune.
        const cav = clamp01(
          0.55 +
            (h - (scratchH[hi - 1] + scratchH[hi + 1] + scratchH[hi - HALO] + scratchH[hi + HALO]) * 0.25) /
              (c * 0.9) * 0.30,
        );
        level.aux[v * 2] = clamp01(sampleAo(x, z) * (0.55 + 0.45 * cav)) * 255;
        level.aux[v * 2 + 1] = (1 - smoothstep(0, 60, Math.abs(d))) * 255;

        if (h < b.minY) b.minY = h;
        if (h > b.maxY) b.maxY = h;
      }
      b.row++;
      done += N + 1;
      if (done >= budget) break;
    }
    return done;
  }

  function commit(b: PendingBuild): void {
    const level = b.level;
    level.ox = b.ox;
    level.oz = b.oz;
    level.minY = b.minY;
    level.maxY = b.maxY;
    level.ready = true;

    (level.geom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (level.geom.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
    (level.geom.attributes.aSplat as THREE.BufferAttribute).needsUpdate = true;
    (level.geom.attributes.aAux as THREE.BufferAttribute).needsUpdate = true;

    const half = (N * level.cell) / 2;
    const mid = (level.minY + level.maxY) * 0.5;
    const sphere = level.geom.boundingSphere as THREE.Sphere;
    sphere.center.set(level.ox, mid, level.oz);
    sphere.radius = Math.sqrt(2 * half * half + Math.pow((level.maxY - level.minY) * 0.5, 2)) + 1;

    // The hole in this level and in the one outside it both depend on this
    // level's committed origin, so refresh both.
    buildIndex(level);
    const outer = levels[level.index + 1];
    if (outer && outer.ready) buildIndex(outer);
  }

  function startBuild(level: Level, ox: number, oz: number): PendingBuild {
    return { level, ox, oz, sampling: true, row: 0, minY: Infinity, maxY: -Infinity };
  }

  /**
   * Advance a build by at most `budget` vertices, across both phases. Returns
   * true when it committed. Nothing reaches the GPU until then — the driver
   * only sees a vertex buffer when `needsUpdate` flips — so a half-finished
   * rebuild is invisible rather than torn, and no double buffer is needed.
   */
  function advance(b: PendingBuild, budget: number): boolean {
    let left = budget;
    if (b.sampling) {
      left -= sampleRows(b, left);
      if (b.row < HALO) return false;
      b.sampling = false;
      b.row = 0;
      if (left <= 0) return false;
    }
    emitRows(b, left);
    if (b.row <= N) return false;
    commit(b);
    return true;
  }

  /** Run a level's rebuild to completion, ignoring the frame budget. */
  function buildNow(level: Level, ox: number, oz: number): void {
    advance(startBuild(level, ox, oz), Infinity);
  }

  function step(budget: number): void {
    if (!pending) {
      const level = queue.shift();
      if (!level) return;
      // Snap against the player's position *now*, not when it was queued.
      pending = startBuild(level, snap(followX, level.cell), snap(followZ, level.cell));
    }
    if (advance(pending, budget)) pending = null;
  }

  let followX = 0;
  let followZ = 0;

  function refresh(px: number, pz: number, sync: boolean): void {
    followX = px;
    followZ = pz;
    for (const level of levels) {
      const ox = snap(px, level.cell);
      const oz = snap(pz, level.cell);
      if (level.ready && ox === level.ox && oz === level.oz) continue;
      // A level moving further than its own extent means a teleport or a boot:
      // an incremental rebuild would leave the player standing over stale
      // ground for several frames, so eat the cost now.
      const jumped =
        !level.ready ||
        Math.abs(ox - level.ox) > N * level.cell ||
        Math.abs(oz - level.oz) > N * level.cell;
      if (sync || jumped) {
        if (pending && pending.level === level) pending = null;
        buildNow(level, ox, oz);
        const q = queue.indexOf(level);
        if (q >= 0) queue.splice(q, 1);
      } else if (!(pending && pending.level === level) && queue.indexOf(level) < 0) {
        queue.push(level);
      }
    }
  }

  // Boot the whole clipmap synchronously around the spawn area so the first
  // frame is already correct and the player has ground to stand on.
  refresh(0, 0, true);

  // --- the abyss apron -------------------------------------------------------
  // A flat frame from the clipmap edge out past the far plane, at the depth the
  // shore profile reaches offshore, so the ocean floor never shows a horizon
  // gap under the water surface. Eight triangles, one draw call.
  const apron = (() => {
    const inner = outerHalf;
    const outer = 11000;
    const y = shoreProfile(-(outer * 0.5)) * 0.35 - 60;
    const g = new THREE.BufferGeometry();
    const p: number[] = [];
    const n: number[] = [];
    const s: number[] = [];
    const a: number[] = [];
    const idx: number[] = [];
    const ring = [
      [-inner, -inner], [inner, -inner], [inner, inner], [-inner, inner],
      [-outer, -outer], [outer, -outer], [outer, outer], [-outer, outer],
    ];
    for (const [x, z] of ring) {
      p.push(x, y, z);
      n.push(0, 1, 0);
      s.push(255, 0, 40, 0);       // silt with a little rock
      a.push(200, 0);
    }
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      idx.push(i, i + 4, j + 4, i, j + 4, j);
    }
    g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(n, 3));
    g.setAttribute("aSplat", new THREE.BufferAttribute(new Uint8Array(s), 4, true));
    g.setAttribute("aAux", new THREE.BufferAttribute(new Uint8Array(a), 2, true));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, y, 0), outer * 1.5);
    const m = new THREE.Mesh(g, material);
    m.name = "palmas.terrain.apron";
    m.matrixAutoUpdate = false;
    root.add(m);
    return m;
  })();

  // -------------------------------------------------------------------------
  // Service
  // -------------------------------------------------------------------------

  const service: PalmasTerrainService = {
    heightAt,
    normalAt,
    isWater(x, z) {
      return heightAt(x, z) < SEA_LEVEL;
    },
    landDistanceAt(x, z) {
      return sampleField(x, z)[F_DIST];
    },
    waterDepthAt(x, z) {
      return Math.max(0, SEA_LEVEL - heightAt(x, z));
    },
    slopeAt,
    worldSize: WORLD_SIZE,
    seaLevel: SEA_LEVEL,
  };
  ctx.services.terrain = service;

  ctx.emit("palmas:terrain-ready", {
    worldSize: WORLD_SIZE,
    landRadius: LAND_RADIUS,
    levels: levels.length,
    triangles: levels.length * QUADS * 2,
  });

  // -------------------------------------------------------------------------

  const sys: System = {
    name: "terrain",

    update(dt, c) {
      const p = c.services.player?.position ?? c.camera.position;
      refresh(p.x, p.z, false);

      // Spend more when the queue backs up (vehicles, wingsuit, fast travel).
      const budget = REBUILD_BUDGET * (queue.length > 1 ? 4 : 1);
      step(budget);

      // The sky owns the fog; the aerial-perspective term just follows it, so
      // the terrain always desaturates toward whatever the horizon is doing.
      const fog = c.scene.fog as THREE.Fog | THREE.FogExp2 | null;
      if (fog && fog.color) hazeColor.copy(fog.color);

      // Keep the apron centred so its inner edge stays welded to the clipmap.
      const outerLevel = levels[levels.length - 1];
      if (outerLevel.ready) {
        apron.position.set(outerLevel.ox, 0, outerLevel.oz);
        apron.updateMatrix();
      }
    },

    dispose() {
      ctx.scene.remove(root);
      for (const level of levels) level.geom.dispose();
      apron.geometry.dispose();
      for (const u of Object.values(uniforms)) {
        const v = u.value as THREE.Texture;
        if (v && (v as THREE.Texture).isTexture) v.dispose();
      }
      material.dispose();
      if (ctx.services.terrain === service) delete ctx.services.terrain;
    },
  };

  return sys;
};

export default createTerrain;
