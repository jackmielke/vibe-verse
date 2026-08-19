/**
 * DROP ZERO — the sea, the lagoons and the rivers.
 *
 * One camera-locked radial mesh covers every body of water on the map. Rings
 * grow exponentially outward, so the surface is sub-metre dense around the
 * player's feet and kilometre-coarse at the horizon — the whole ocean, out to
 * the far clip, for a single draw call.
 *
 * There are no separate river meshes. Everything the terrain carved below
 * `seaLevel` — open ocean, the beach shelf, lagoons, the inland channels — is
 * the same plane, and the shader decides what it looks like from a bake of the
 * seabed. That bake is the interesting part of this file:
 *
 *   • `TerrainService.heightAt` is sampled onto a grid once at boot;
 *   • an 8SSEDT vector distance transform turns the waterline into a signed
 *     distance field *plus* a direction-to-shore field, so the surf band lands
 *     exactly on the coast the terrain actually built and the foam sheet knows
 *     which way to wash — no hand-authored coastline SDF to drift out of sync;
 *   • a flood fill from the map border, restricted to genuinely open water and
 *     then dilated, separates the sea from fresh water. Narrow inland channels
 *     come out tagged "fresh": no swell, greener body colour, a gentle
 *     downstream drift on the ripple detail. That is what makes the rivers
 *     read as rivers while still being the ocean plane.
 *
 * The surface itself is a custom ShaderMaterial:
 *   • five Gerstner waves with deep-water dispersion, per-wave distance
 *     geomorph (short chop dies before it can alias) and real shoaling —
 *     swell steepens as the bottom comes up, then collapses at the waterline;
 *   • Beer–Lambert depth colour: bleached sand transmitting through turquoise
 *     shallows falling away to sapphire, with caustics dancing on the sandbars;
 *   • Schlick fresnel against an analytic sky that tracks the sky system's own
 *     horizon/zenith palette, with reflected cloud patches and a short march
 *     through the baked land-height field so cliffs actually darken the water
 *     under them;
 *   • a two-lobe sun specular plus a sparkle lobe riding procedurally
 *     generated normal maps — that glint is what makes water look expensive;
 *   • shoreline surf that marches in as breaker sets and retreats, whitecaps
 *     on offshore crests, and expanding ripple rings around anything swimming;
 *   • an underwater branch with a Snell's window and caustic shimmer for when
 *     the camera dips below the surface.
 *
 * NO EXTERNAL ASSETS: the ripple normal map, the foam/bubble map and the
 * seabed bake are all generated here at boot.
 *
 * Reads (all lazily, all optional): TerrainService (the bake), SkyService
 * (sun + palette), CombatService + PlayerService (ripple emitters),
 * AudioService (the splash). Publishes no service — nothing else needs to ask
 * the water anything that `terrain.isWater` cannot already answer.
 */
import * as THREE from "three";
import type { QualityTier, SkyService, System, SystemFactory, WorldCtx } from "../types";

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

/** Radius of the water disc. Inside the 8000 m camera far plane, with room. */
const DISC_RADIUS = 7400;
/** Innermost ring radius — keeps the fan from degenerating at the camera. */
const DISC_INNER = 0.3;
/** Ring growth exponent. Higher = denser near the camera, coarser far out. */
const DISC_FALLOFF = 7.2;

/** Sea level used only when terrain failed to boot. */
const FALLBACK_SEA_LEVEL = 0;
/** Half-extent used only when terrain failed to boot (3 km island + margin). */
const FALLBACK_WORLD_SIZE = 1500;
/** Metres of ocean baked outside the playable square, so the shelf has room. */
const MAP_MARGIN = 420;

/** Depth encoded in the R channel spans 0..this metres. */
const DEPTH_RANGE = 220;
/** Depth in the G channel spans 0..this — the shallows at 22× the precision. */
const SHORE_RANGE = 10;
/** Land height above sea in the A channel spans 0..this metres. */
const LAND_RANGE = 140;
/** Signed shore distance spans ±this many metres. */
const SHORE_DIST_RANGE = 96;

/**
 * Water wider than twice this counts as open sea for the ocean/fresh split.
 * A 40 m channel is a river; a 300 m bay is not. Tuned against the 4 m build
 * grid: anything a player can bridge in ten pieces should feel like a river.
 */
const OPEN_WATER_HALF_WIDTH = 26;
/**
 * The ocean mask is dilated by this much before the fresh-water tag is taken,
 * so the beach shelf — narrow, but obviously sea — is not mistaken for a
 * river. Also softens the river mouth into the bay instead of hard-cutting it.
 */
const OCEAN_DILATE = 46;

/**
 * How far the swash sheet lifts over the sand at the top of a set, in metres.
 *
 * This is the whole shoreline effect and it is deliberately a *height*, not a
 * distance. Lift the water and let it intersect the terrain, and the waterline
 * that comes out is the real geometric one — it finds every cove, rock and
 * sandbar the terrain built without this file being told any of them exist.
 *
 * The number is small because the beaches here are flat. 0.30 was the first
 * one tried: the east coast runs at about 1 in 60, so it put nearly twenty
 * metres of sand under water at the top of every set and the frame came back
 * as a snowfield. At 0.16 the line travels a believable few metres, and it
 * still travels — which is the thing being fixed.
 */
const SWASH_HEIGHT = 0.16;

/** Seconds an actor ripple ring lives. */
const RIPPLE_LIFE = 2.2;
/** How often a swimming actor sheds a new ring. */
const RIPPLE_INTERVAL = 0.3;
/** How often we re-scan combat for swimmers. Cheap, but not free. */
const RIPPLE_SCAN_INTERVAL = 0.25;

interface WaterTier {
  /** Radial segments around the disc. */
  segments: number;
  /** Concentric rings from the camera out to DISC_RADIUS. */
  rings: number;
  /** Seabed bake resolution (square). Cost is O(n²) `heightAt` calls at boot. */
  bake: number;
  /** Procedural normal/foam texture resolution. */
  detail: number;
  /** Gerstner waves summed in the vertex shader. */
  waves: number;
  /** Live actor ripple rings, or 0 to compile the feature out entirely. */
  ripples: number;
  /** Whether the fragment shader runs the land-reflection march. */
  landReflection: boolean;
  /**
   * Caustic budget, in texture fetches per shaded pixel of shallow water:
   *   1 — one web, squared. Reads as moving light; does not read as filaments.
   *   2 — two counter-scrolling webs multiplied. The real thing, monochrome.
   *   3 — as 2, with the red and blue channels sampled either side along the
   *       refraction, which is where a caustic's colour fringe comes from.
   * Only pixels shallow enough to see the bottom pay any of it.
   */
  caustics: 1 | 2 | 3;
}

const TIERS: Record<QualityTier, WaterTier> = {
  low: { segments: 96, rings: 78, bake: 256, detail: 128, waves: 3, ripples: 0, landReflection: false, caustics: 1 },
  medium: { segments: 140, rings: 106, bake: 320, detail: 256, waves: 4, ripples: 0, landReflection: false, caustics: 2 },
  high: { segments: 196, rings: 142, bake: 384, detail: 256, waves: 5, ripples: 6, landReflection: true, caustics: 2 },
  ultra: { segments: 272, rings: 182, bake: 512, detail: 512, waves: 5, ripples: 8, landReflection: true, caustics: 3 },
};

/**
 * The swell stack. `dir` is the propagation direction on the XZ plane, `amp`
 * the crest height in metres, `len` the wavelength in metres, `q` the
 * horizontal steepness (how far crests pinch toward each other), `speed` a
 * multiplier on the deep-water phase velocity.
 *
 * Wave 1 is the groundswell rolling in from the west-north-west and is the
 * only one that survives to the horizon; 2–3 are local wind swell crossing
 * it; 4–5 are chop that only exists within a few hundred metres.
 *
 * Total amplitude is deliberately modest (~2.2 m). Players swim, land in the
 * shallows off the bus and build on the beach — a two-metre sea is dramatic;
 * a four-metre one hides the shoreline and eats drops.
 */
const WAVES: { dir: [number, number]; amp: number; len: number; q: number; speed: number }[] = [
  { dir: [0.94, 0.34], amp: 1.1, len: 128, q: 0.7, speed: 1.0 },
  { dir: [0.7, -0.71], amp: 0.6, len: 71, q: 0.6, speed: 1.05 },
  { dir: [0.41, 0.91], amp: 0.28, len: 36, q: 0.52, speed: 1.12 },
  { dir: [-0.36, 0.93], amp: 0.13, len: 18, q: 0.44, speed: 1.2 },
  { dir: [0.87, -0.49], amp: 0.06, len: 8.5, q: 0.34, speed: 1.32 },
];

/* ------------------------------------------------------------------------ *
 * Procedural texture generation
 * ------------------------------------------------------------------------ */

/** Integer hash → [0,1). Cheap, well-mixed, stable across platforms. */
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smoothstep-interpolated value noise on a wrapping lattice, so it tiles. */
function periodicValueNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** Tiling fBm. `basePeriod` is in lattice cells across the full [0,1) tile. */
function periodicFbm(u: number, v: number, basePeriod: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += periodicValueNoise(u * period, v * period, period, seed + o * 7919) * amp;
    norm += amp;
    amp *= 0.52;
    period *= 2;
  }
  return sum / norm;
}

/** Tiling Worley F1 distance in [0,1). Gives foam its organic clumping. */
function periodicWorley(u: number, v: number, cells: number, seed: number): number {
  const cx = Math.floor(u * cells);
  const cy = Math.floor(v * cells);
  let best = 4;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const gx = cx + ox;
      const gy = cy + oy;
      const wx = ((gx % cells) + cells) % cells;
      const wy = ((gy % cells) + cells) % cells;
      const px = (gx + hash2(wx, wy, seed)) / cells;
      const py = (gy + hash2(wx, wy, seed + 4451)) / cells;
      const dx = px - u;
      const dy = py - v;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best) * cells);
}

/**
 * Tiling Worley returning F1 *and* F2. The gap between them is small exactly
 * on the boundaries between cells, which is where a caustic net's filaments
 * live — F1 alone only ever gives blobs at cell centres.
 */
function periodicWorley2(u: number, v: number, cells: number, seed: number): [number, number] {
  const cx = Math.floor(u * cells);
  const cy = Math.floor(v * cells);
  let f1 = 9;
  let f2 = 9;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const gx = cx + ox;
      const gy = cy + oy;
      const wx = ((gx % cells) + cells) % cells;
      const wy = ((gy % cells) + cells) % cells;
      const px = (gx + hash2(wx, wy, seed)) / cells;
      const py = (gy + hash2(wx, wy, seed + 4451)) / cells;
      const dx = px - u;
      const dy = py - v;
      const d = dx * dx + dy * dy;
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return [Math.min(1, Math.sqrt(f1) * cells), Math.min(1, Math.sqrt(f2) * cells)];
}

/**
 * Caustic map — the net of focused sunlight that lands on a seabed.
 *
 * A caustic is an image of the *surface*, projected onto whatever is under it,
 * and its structure is the fold lines of that projection: thin, bright, closed
 * loops, not blobs. So this is built from the Worley F2−F1 ridge (a web of cell
 * boundaries) on a domain warped by fBm so the cells stop reading as cells,
 * and two of them are stored at different scales — the shader multiplies the
 * pair as it scrolls them against each other, and a filament only survives
 * where both webs fold at once. That is what keeps the pattern sparse and
 * bright instead of an even mesh, which is the giveaway of a one-layer caustic.
 *
 * R coarse web, G fine web, B slow patch intensity, A grain.
 */
function makeCausticTexture(size: number, seed: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const ridge = (u: number, v: number, cells: number, warp: number, sd: number): number => {
    const wu = u + (periodicFbm(u, v, 5, 3, sd + 3) - 0.5) * warp;
    const wv = v + (periodicFbm(u + 0.41, v + 0.17, 5, 3, sd + 9) - 0.5) * warp;
    const [f1, f2] = periodicWorley2(((wu % 1) + 1) % 1, ((wv % 1) + 1) % 1, cells, sd);
    // 2.6 sets the filament width: the ridge is bright only where the two
    // nearest cells are within ~0.4 of a cell of each other.
    return Math.pow(1 - Math.min(1, (f2 - f1) * 2.6), 2.2);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const i = (y * size + x) * 4;
      data[i] = Math.round(ridge(u, v, 7, 0.22, seed) * 255);
      data[i + 1] = Math.round(ridge(v * 1.03 + 0.29, u * 0.97 + 0.61, 13, 0.16, seed + 617) * 255);
      data[i + 2] = Math.round(periodicFbm(u, v, 4, 4, seed + 61) * 255);
      data[i + 3] = Math.round(periodicFbm(u, v, 20, 3, seed + 77) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Ripple detail normal map. A tiling fBm height field, two lobes with
 * different anisotropy so the ripples read as wind-driven rather than
 * isotropic mush, finite-differenced into a tangent-space normal. Alpha keeps
 * the height so the fragment shader can pick micro-crests out for sparkle and
 * reuse the same texture as a caustic source.
 */
function makeRippleNormalTexture(size: number, seed: number): THREE.DataTexture {
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const a = periodicFbm(u, v, 8, 5, seed);
      const b = periodicFbm(v * 0.98 + 0.13, u * 1.02, 13, 4, seed + 131);
      height[y * size + x] = a * 0.62 + b * 0.38;
    }
  }

  const data = new Uint8Array(size * size * 4);
  // Slope scale: how much of a bump the height field is taken to represent.
  // Scaled off the resolution so the 128² low-tier map is not flatter than
  // the 512² ultra one.
  const scale = size * 0.05;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = height[y * size + ((x - 1 + size) % size)];
      const xr = height[y * size + ((x + 1) % size)];
      const yd = height[((y - 1 + size) % size) * size + x];
      const yu = height[((y + 1) % size) * size + x];
      let nx = (xl - xr) * scale;
      let ny = (yd - yu) * scale;
      const inv = 1 / Math.hypot(nx, ny, 1);
      nx *= inv;
      ny *= inv;
      const i = (y * size + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      data[i + 3] = Math.round(height[y * size + x] * 255);
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Foam map. R is clumpy surf (Worley, inverted and contrast-pushed), G is fine
 * bubble speckle, B is a slow large-scale patch mask — it breaks the surf line
 * into clumps so it never reads as a painted stripe, and doubles as the cloud
 * mask for the reflection.
 */
function makeFoamTexture(size: number, seed: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Warp the Worley lookup so the cells stop looking like cells.
      const wx = u + (periodicFbm(u, v, 6, 3, seed + 11) - 0.5) * 0.14;
      const wy = v + (periodicFbm(u + 0.37, v + 0.71, 6, 3, seed + 23) - 0.5) * 0.14;
      const clump = 1 - periodicWorley(((wx % 1) + 1) % 1, ((wy % 1) + 1) % 1, 10, seed);
      const bubbles = periodicFbm(u, v, 26, 3, seed + 57);
      const patch = periodicFbm(u, v, 3, 4, seed + 91);
      const i = (y * size + x) * 4;
      data[i] = Math.round(Math.min(1, Math.pow(clump, 1.6) * 1.35) * 255);
      data[i + 1] = Math.round(Math.min(1, Math.pow(bubbles, 1.9) * 1.8) * 255);
      data[i + 2] = Math.round(patch * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------------ *
 * Seabed bake — depth, shoreline SDF, shore direction, fresh-water mask
 * ------------------------------------------------------------------------ */

/**
 * A plausible island, used only if terrain failed to boot. The water must
 * still look like water in that case — a flat blue plane out to the horizon
 * with no shoreline is exactly the "Three.js demo" frame we are trying not to
 * ship, and a black-screen fallback is worse.
 */
function fallbackHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const wob =
    Math.sin(x * 0.0031 + z * 0.0019) * 90 +
    Math.sin(x * 0.0077 - z * 0.0061) * 42 +
    Math.sin(z * 0.0142 + 1.7) * 18;
  const shore = FALLBACK_WORLD_SIZE * 0.78 + wob;
  // A dome inland, a shelf just offshore, then the drop-off.
  const t = (shore - r) / shore;
  if (t > 0) return 6 + t * t * 110;
  return -Math.min(180, Math.pow(-t * shore * 0.06, 1.6));
}

/** Vector distance field: for every cell, the offset to the nearest seed cell. */
interface VectorField {
  /** Offset in cells from this cell to the nearest seed, X then Y. */
  vx: Float32Array;
  vy: Float32Array;
  /** Distance in cells. */
  dist: Float32Array;
}

/** Large enough to lose against any real offset, small enough to square safely. */
const EDT_FAR = 1e4;

/**
 * 8SSEDT — Danielsson's two-pass vector distance transform. Near-exact
 * Euclidean distance for a fraction of the cost of a proper EDT, and it hands
 * back the *vector* to the nearest seed, which is what the surf needs: the
 * direction the foam sheet washes is the direction to the beach.
 */
function vectorDistanceField(seed: Uint8Array, w: number, h: number): VectorField {
  const vx = new Float32Array(w * h);
  const vy = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (seed[i]) continue;
    vx[i] = EDT_FAR;
    vy[i] = EDT_FAR;
  }

  const relax = (x: number, y: number, ox: number, oy: number): void => {
    const nx = x + ox;
    const ny = y + oy;
    if (nx < 0 || nx >= w || ny < 0 || ny >= h) return;
    const i = y * w + x;
    const j = ny * w + nx;
    // The neighbour's offset to its seed, plus the step we took to reach it.
    // Sign matters: `v` must come out as the offset FROM this cell TO the
    // seed, because the surf reads it as "which way is the beach".
    const cx = vx[j] + ox;
    const cy = vy[j] + oy;
    if (cx * cx + cy * cy < vx[i] * vx[i] + vy[i] * vy[i]) {
      vx[i] = cx;
      vy[i] = cy;
    }
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      relax(x, y, -1, 0);
      relax(x, y, 0, -1);
      relax(x, y, -1, -1);
      relax(x, y, 1, -1);
    }
    for (let x = w - 1; x >= 0; x--) relax(x, y, 1, 0);
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      relax(x, y, 1, 0);
      relax(x, y, 0, 1);
      relax(x, y, 1, 1);
      relax(x, y, -1, 1);
    }
    for (let x = 0; x < w; x++) relax(x, y, -1, 0);
  }

  const dist = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) dist[i] = Math.hypot(vx[i], vy[i]);
  return { vx, vy, dist };
}

/** Separable box blur, in place via a scratch buffer. Softens mask edges. */
function blurField(field: Float32Array, w: number, h: number, radius: number, passes: number): void {
  const tmp = new Float32Array(field.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let n = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = Math.min(w - 1, Math.max(0, x + k));
          sum += field[y * w + sx];
          n++;
        }
        tmp[y * w + x] = sum / n;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let n = 0;
        for (let k = -radius; k <= radius; k++) {
          const sy = Math.min(h - 1, Math.max(0, y + k));
          sum += tmp[sy * w + x];
          n++;
        }
        field[y * w + x] = sum / n;
      }
    }
  }
}

interface SeabedBake {
  /** R depth/DEPTH_RANGE, G depth/SHORE_RANGE, B seabed slope, A land height. */
  depth: THREE.DataTexture;
  /** R signed shore distance, GB direction to shore, A fresh-water mask. */
  shore: THREE.DataTexture;
  /** True when the bake ran against a real TerrainService. */
  fromTerrain: boolean;
}

/**
 * Bake the seabed once. Everything the shader knows about where the land is
 * comes from here, so this runs against `TerrainService.heightAt` — the water
 * agrees with whatever the terrain module actually built, at whatever
 * resolution it built it.
 */
function bakeSeabed(ctx: WorldCtx, size: number, seaLevel: number, half: number): SeabedBake {
  const terrain = ctx.services.terrain;
  const heightAt = terrain ? (x: number, z: number) => terrain.heightAt(x, z) : fallbackHeight;

  const n = size * size;
  const heights = new Float32Array(n);
  const step = (half * 2) / (size - 1);

  for (let j = 0; j < size; j++) {
    const z = -half + j * step;
    for (let i = 0; i < size; i++) {
      heights[j * size + i] = heightAt(-half + i * step, z);
    }
  }

  // --- masks ---------------------------------------------------------------
  const landMask = new Uint8Array(n);
  const waterMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const land = heights[i] >= seaLevel ? 1 : 0;
    landMask[i] = land;
    waterMask[i] = land ? 0 : 1;
  }

  // Distance (and direction) to the nearest land cell, and back the other way,
  // so the waterline can be signed properly instead of clamped at zero.
  const toLand = vectorDistanceField(landMask, size, size);
  const toWater = vectorDistanceField(waterMask, size, size);

  // --- ocean vs fresh water ------------------------------------------------
  // Seed the flood fill only on water wide enough to be sea, then walk it from
  // the map border. Rivers and ponds are too narrow to be seeded and never get
  // reached; the beach shelf is narrow too, but sits right next to seeded
  // cells, so the dilation below folds it back into the ocean.
  const openCells = OPEN_WATER_HALF_WIDTH / step;
  const oceanSeed = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (waterMask[i] && toLand.dist[i] > openCells) oceanSeed[i] = 1;
  }

  const reached = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qHead = 0;
  let qTail = 0;
  const push = (idx: number): void => {
    if (reached[idx] || !oceanSeed[idx]) return;
    reached[idx] = 1;
    queue[qTail++] = idx;
  };
  for (let i = 0; i < size; i++) {
    push(i);
    push((size - 1) * size + i);
    push(i * size);
    push(i * size + size - 1);
  }
  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % size;
    const y = (idx / size) | 0;
    if (x > 0) push(idx - 1);
    if (x < size - 1) push(idx + 1);
    if (y > 0) push(idx - size);
    if (y < size - 1) push(idx + size);
  }

  // Dilate the ocean core outward so shelves, coves and river mouths inherit
  // sea treatment, and everything still inland of that is fresh.
  const oceanCore = new Uint8Array(n);
  for (let i = 0; i < n; i++) oceanCore[i] = reached[i];
  const toOcean = vectorDistanceField(oceanCore, size, size);
  const dilateCells = OCEAN_DILATE / step;

  const fresh = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!waterMask[i]) continue;
    // 1 well inland of the sea, 0 anywhere the ocean has reached.
    const t = (toOcean.dist[i] - dilateCells) / Math.max(1, dilateCells * 0.75);
    fresh[i] = Math.min(1, Math.max(0, t));
  }
  blurField(fresh, size, size, 1, 2);

  // --- pack ----------------------------------------------------------------
  const depthData = new Uint8Array(n * 4);
  const shoreData = new Uint8Array(n * 4);

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const h = heights[k];
      const depth = Math.max(0, seaLevel - h);

      // Central-difference slope of the seabed. Gentle beaches get a wide surf
      // band, steep rock keeps it tight — the single best cue that the coast
      // is made of different stuff in different places.
      const hx =
        (heights[j * size + Math.min(size - 1, i + 1)] - heights[j * size + Math.max(0, i - 1)]) /
        (2 * step);
      const hz =
        (heights[Math.min(size - 1, j + 1) * size + i] - heights[Math.max(0, j - 1) * size + i]) /
        (2 * step);
      const slope = Math.min(1, Math.hypot(hx, hz) * 3.0);

      const d4 = k * 4;
      depthData[d4] = Math.round(Math.min(1, depth / DEPTH_RANGE) * 255);
      depthData[d4 + 1] = Math.round(Math.min(1, depth / SHORE_RANGE) * 255);
      depthData[d4 + 2] = Math.round(slope * 255);
      depthData[d4 + 3] = Math.round(Math.min(1, Math.max(0, h - seaLevel) / LAND_RANGE) * 255);

      // Signed distance to the waterline, positive offshore. The -0.5 puts the
      // zero crossing between the last water cell and the first land cell,
      // which is where the waterline actually is.
      const water = waterMask[k] === 1;
      const cells = (water ? toLand.dist[k] : -toWater.dist[k]) - (water ? 0.5 : -0.5);
      const metres = Math.max(-SHORE_DIST_RANGE, Math.min(SHORE_DIST_RANGE, cells * step));

      // Direction to shore. Offshore that is the vector to the nearest land;
      // on land, the reverse of the vector to the nearest water, so the field
      // stays continuous across the waterline and the foam does not spin.
      let dirX = water ? toLand.vx[k] : -toWater.vx[k];
      let dirY = water ? toLand.vy[k] : -toWater.vy[k];
      const len = Math.hypot(dirX, dirY);
      if (len > 1e-4 && len < EDT_FAR * 0.5) {
        dirX /= len;
        dirY /= len;
      } else {
        dirX = 0;
        dirY = 0;
      }

      shoreData[d4] = Math.round(((metres / SHORE_DIST_RANGE) * 0.5 + 0.5) * 255);
      shoreData[d4 + 1] = Math.round((dirX * 0.5 + 0.5) * 255);
      shoreData[d4 + 2] = Math.round((dirY * 0.5 + 0.5) * 255);
      shoreData[d4 + 3] = Math.round(fresh[k] * 255);
    }
  }

  const make = (data: Uint8Array<ArrayBuffer>): THREE.DataTexture => {
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  };

  return { depth: make(depthData), shore: make(shoreData), fromTerrain: !!terrain };
}

/* ------------------------------------------------------------------------ *
 * Geometry — a camera-locked radial LOD disc
 * ------------------------------------------------------------------------ */

/**
 * Concentric rings whose radii grow exponentially: ~0.4 m spacing at the
 * camera, hundreds of metres at the horizon. That puts the vertex budget
 * exactly where the waves are legible. Waves are evaluated in world space in
 * the shader, so the disc can slide with the camera without the swell sliding
 * with it.
 */
function buildDisc(segments: number, rings: number): THREE.BufferGeometry {
  const vertexCount = 1 + rings * segments;
  const positions = new Float32Array(vertexCount * 3);
  const expDenom = Math.exp(DISC_FALLOFF) - 1;

  positions[0] = 0;
  positions[1] = 0;
  positions[2] = 0;

  let p = 3;
  for (let r = 0; r < rings; r++) {
    const t = (r + 1) / rings;
    const radius =
      DISC_INNER + (DISC_RADIUS - DISC_INNER) * ((Math.exp(t * DISC_FALLOFF) - 1) / expDenom);
    // Twist each ring so the radial spokes never line up into a star pattern
    // under a grazing specular — the giveaway of every radial water disc.
    const twist = r * 0.37;
    for (let s = 0; s < segments; s++) {
      const a = ((s + 0.5) / segments) * Math.PI * 2 + twist;
      positions[p++] = Math.cos(a) * radius;
      positions[p++] = 0;
      positions[p++] = Math.sin(a) * radius;
    }
  }

  const triCount = segments + (rings - 1) * segments * 2;
  const indices =
    vertexCount > 65535 ? new Uint32Array(triCount * 3) : new Uint16Array(triCount * 3);
  let ix = 0;

  // Centre fan, wound so +Y is the front face. The surface renders DoubleSide
  // for the swimming case, but nothing downstream should have to guess.
  for (let s = 0; s < segments; s++) {
    indices[ix++] = 0;
    indices[ix++] = 1 + ((s + 1) % segments);
    indices[ix++] = 1 + s;
  }

  for (let r = 0; r < rings - 1; r++) {
    const a0 = 1 + r * segments;
    const b0 = 1 + (r + 1) * segments;
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      indices[ix++] = a0 + s;
      indices[ix++] = a0 + s1;
      indices[ix++] = b0 + s;
      indices[ix++] = a0 + s1;
      indices[ix++] = b0 + s1;
      indices[ix++] = b0 + s;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  // Repositioned every frame and displaced in the shader — there is nothing
  // sensible to cull against.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), DISC_RADIUS * 2);
  return geo;
}

/* ------------------------------------------------------------------------ *
 * Shaders
 * ------------------------------------------------------------------------ */

/** Shared decode of the two baked maps. Compiled into both stages. */
const MAP_SAMPLE_GLSL = /* glsl */ `
uniform sampler2D uDepthMap;
uniform sampler2D uShoreMap;
uniform vec2  uMapOrigin;
uniform float uMapInvSize;
uniform float uMapSpan;

// x = depth (m), y = seabed slope 0..1, z = land height above sea (m)
vec3 sampleSeabed(vec2 worldXZ) {
  vec2 uv = (worldXZ - uMapOrigin) * uMapInvSize;
  vec2 c = clamp(uv, vec2(0.0), vec2(1.0));
  // Past the baked square it is open ocean all the way down. Ramping hard
  // stops the abyss from inheriting the shelf colour clamped in from the edge.
  float outside = min(length(uv - c) * uMapSpan * 3.0, ${DEPTH_RANGE.toFixed(1)});
  vec4 s = texture2D(uDepthMap, c);
  float fine = s.g * ${SHORE_RANGE.toFixed(1)};
  float coarse = s.r * ${DEPTH_RANGE.toFixed(1)};
  // The fine channel runs out at SHORE_RANGE; hand over to the coarse one just
  // before it saturates, or the shelf gets a visible contour line.
  float depth = mix(fine, max(coarse, ${SHORE_RANGE.toFixed(1)}), smoothstep(0.86, 1.0, s.g));
  return vec3(depth + outside, s.b, s.a * ${LAND_RANGE.toFixed(1)});
}

// x = signed distance to the waterline (m, + = offshore), yz = unit direction
// toward the shore, w = fresh-water mask 0..1
vec4 sampleShore(vec2 worldXZ) {
  vec2 uv = (worldXZ - uMapOrigin) * uMapInvSize;
  vec2 c = clamp(uv, vec2(0.0), vec2(1.0));
  float outside = length(uv - c) * uMapSpan;
  vec4 s = texture2D(uShoreMap, c);
  float d = (s.r * 2.0 - 1.0) * ${SHORE_DIST_RANGE.toFixed(1)} + outside;
  return vec4(d, s.g * 2.0 - 1.0, s.b * 2.0 - 1.0, s.a);
}
`;

const WATER_VERT = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uSeaLevel;
uniform vec4  uWaveA[WAVE_COUNT];   // xy = direction, z = amplitude, w = wavelength
uniform vec2  uWaveB[WAVE_COUNT];   // x = steepness, y = speed multiplier
uniform float uWaveGain;
uniform float uMaxAmplitude;
uniform float uSwash;

varying vec3 vWorldPos;
varying vec3 vWaveNormal;
varying vec4 vSurf;      // x depth, y seabed slope, z shore distance, w freshness
varying vec4 vWave;      // x crest -1..1, y fold, z view distance, w land height
varying vec2 vShoreDir;

${MAP_SAMPLE_GLSL}

#include <fog_pars_vertex>

void main() {
  vec3 base = (modelMatrix * vec4(position, 1.0)).xyz;
  base.y = uSeaLevel;

  float viewDist = length(base.xz - cameraPosition.xz);

  vec3 seabed = sampleSeabed(base.xz);
  vec4 shore = sampleShore(base.xz);
  float depth = seabed.x;

  // Shoaling. Swell steepens as the bottom comes up — the crest gains about a
  // third before the break — then collapses at the waterline. The land mute is
  // the hard guarantee: a crest must never punch up through the beach.
  float deepWater = smoothstep(0.6, 16.0, depth);
  // A Gaussian bump on the shelf: crests are ~30% taller in 9 m of water than
  // they are out in the deep, which is where a real beach break happens.
  // Written as a Gaussian rather than a band so it can never go negative and
  // flip the swell inside out over the abyss. (Squared by hand: pow() with a
  // negative base is undefined in GLSL, and this base goes negative inshore.)
  float shelfT = (depth - 9.0) / 5.5;
  float peak = 1.0 + 0.30 * exp(-shelfT * shelfT);
  // Zero at the waterline, full swell 26 m out. NB: smoothstep needs
  // edge0 < edge1, and reversing the edges is undefined, not mirrored.
  float landMute = smoothstep(-2.0, 26.0, shore.x);
  // Fresh water has no fetch, so it has no swell — only the fine detail
  // normals in the fragment stage.
  float freshMute = 1.0 - shore.w * 0.94;
  float gain = uWaveGain * min(deepWater, landMute) * freshMute * peak;

  vec3 displaced = base;
  vec3 n = vec3(0.0, 1.0, 0.0);
  float fold = 0.0;
  float crest = 0.0;

  for (int i = 0; i < WAVE_COUNT; i++) {
    vec2 dir = normalize(uWaveA[i].xy);
    float amp = uWaveA[i].z * gain;
    float len = uWaveA[i].w;
    float steep = uWaveB[i].x;
    float speedMul = uWaveB[i].y;

    // Per-wave geomorph: a wave fades out once the ring spacing can no longer
    // resolve it. Chop is gone within a few hundred metres, the groundswell
    // survives to the horizon. This is what keeps the distance free of
    // shimmering vertex noise, which no amount of AA will fix.
    float fade = 1.0 - smoothstep(len * 10.0, len * 36.0, viewDist);
    if (fade <= 0.001) continue;

    float k = 6.2831853 / len;
    float c = sqrt(9.81 / k) * speedMul;          // deep-water dispersion
    float phase = k * dot(dir, base.xz) - c * k * uTime;
    float sinP = sin(phase);
    float cosP = cos(phase);
    float a = amp * fade;
    float wa = k * a;

    displaced.xz += dir * (steep * a * cosP);
    displaced.y  += a * sinP;

    n.x -= dir.x * wa * cosP;
    n.z -= dir.y * wa * cosP;
    fold += steep * wa * sinP;
    crest += a * sinP;
  }

  // ---- Swash: the sheet that runs up the beach and drains back ------------
  // A waterline pinned to one contour is the loudest tell in a rendered coast:
  // real water arrives and leaves. Rather than paint a moving edge, lift the
  // whole sheet a few tens of centimetres and let it intersect the sand. The
  // edge that comes out is the true geometric one, so it fits every cove, rock
  // and sandbar the terrain built without this file knowing any of them exist.
  //
  // Two sets whose periods do not divide into each other, running SHOREward:
  // phase = wt + kx puts the crest at a shore distance that falls as t runs.
  // Fresh water is excluded — a river bank does not have surf on it, and a
  // lifted river floods its own banks.
  float coastal = 1.0 - smoothstep(0.0, 34.0, max(shore.x, 0.0));
  float set1 = pow(sin(uTime * 0.55 + shore.x * 0.055) * 0.5 + 0.5, 2.0);
  float set2 = pow(sin(uTime * 0.34 + shore.x * 0.038 + 2.1) * 0.5 + 0.5, 3.0);
  float wash = max(set1, set2 * 0.9) * coastal * (1.0 - shore.w);
  displaced.y += uSwash * wash;

  n.y = 1.0 - fold;
  vWaveNormal = normalize(n);
  vWorldPos = displaced;
  vSurf = vec4(depth, seabed.y, shore.x, shore.w);
  // w carries the swash, normalised: the fragment stage needs to know how far
  // up the sand the sheet currently is, and nothing needs the land height.
  vWave = vec4(clamp(crest / max(0.05, uMaxAmplitude * gain), -1.0, 1.0), fold, viewDist, wash);
  vShoreDir = shore.yz;

  vec4 mvPosition = viewMatrix * vec4(displaced, 1.0);
  #ifdef USE_FOG
    vFogDepth = -mvPosition.z;
  #endif
  gl_Position = projectionMatrix * mvPosition;
}
`;

const WATER_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uSeaLevel;
uniform sampler2D uRippleMap;
uniform sampler2D uFoamMap;
uniform sampler2D uCausticMap;

uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uZenithColor;
uniform vec3  uHorizonColor;
uniform vec3  uHazeColor;
uniform vec3  uCloudColor;
uniform vec3  uLandReflectColor;
uniform float uDaylight;

uniform vec3  uShallowColor;
uniform vec3  uMidColor;
uniform vec3  uDeepColor;
uniform vec3  uSandColor;
uniform vec3  uFoamColor;
uniform vec3  uFreshColor;
uniform vec3  uSssColor;
uniform vec3  uWetSandColor;
uniform vec3  uSeabedColor;

uniform float uDetailStrength;
uniform float uFoamWidth;
uniform vec2  uFlowBias;

#ifdef RIPPLE_COUNT
uniform vec4 uRipples[RIPPLE_COUNT];   // xy = world XZ, z = age (s), w = strength
#endif

varying vec3 vWorldPos;
varying vec3 vWaveNormal;
varying vec4 vSurf;
varying vec4 vWave;
varying vec2 vShoreDir;

${MAP_SAMPLE_GLSL}

#include <fog_pars_fragment>

float sat(float x) { return clamp(x, 0.0, 1.0); }

/**
 * Analytic sky for the fresnel reflection. The colours are pulled from the sky
 * system every frame, so this tracks the real dome instead of drifting away
 * from it at dusk — and it costs three mixes instead of an env-map fetch.
 */
vec3 skyRadiance(vec3 dir) {
  float up = clamp(dir.y, -1.0, 1.0);
  vec3 col = mix(uHorizonColor, uZenithColor, pow(sat(up), 0.55));
  // Haze packed against the horizon — the aerial-perspective anchor. Without
  // it the reflection has no depth and the sea reads like a painted sheet.
  col = mix(col, uHazeColor, exp(-sat(up) * 12.0) * 0.72);
  float sd = sat(dot(dir, uSunDir));
  col += uSunColor * (pow(sd, 900.0) * 24.0 + pow(sd, 40.0) * 0.5 + pow(sd, 5.0) * 0.1);
  return mix(uHazeColor * 0.74, col, smoothstep(-0.14, 0.03, up));
}

/**
 * Broken cloud in the reflection. The reflected ray is intersected with a
 * plane at cloud height and the foam map's slow patch channel is read there —
 * the same trick a matte painter uses, and it is the difference between "sky
 * mirror" and "sky". Clouds drift; the plane is capped so grazing rays do not
 * shoot the UVs into precision mush.
 */
vec3 cloudyReflection(vec3 P, vec3 R, vec3 sky) {
  float up = max(R.y, 0.02);
  // Capped short: past this the cloud plane is so foreshortened that one pixel
  // spans several cloud cells and the reflection aliases into noise.
  float t = min((900.0 - (P.y - uSeaLevel)) / up, 9000.0);
  vec2 cp = P.xz + R.xz * t;
  float patchMask = texture2D(uFoamMap, cp * 0.00042 + uTime * vec2(0.00035, 0.00021)).b;
  float wisp = texture2D(uFoamMap, cp * 0.00135 - uTime * vec2(0.00052, 0.00033)).g;
  float cover = smoothstep(0.46, 0.78, patchMask * 0.75 + wisp * 0.35);
  // Only the part of the sky that is actually up gets clouds.
  cover *= smoothstep(0.02, 0.28, R.y);
  vec3 lit = uCloudColor * mix(0.72, 1.25, sat(dot(normalize(vec3(R.x, 0.35, R.z)), uSunDir) * 0.5 + 0.5));
  return mix(sky, lit * mix(0.35, 1.0, sat(uDaylight)), cover * 0.8);
}

/**
 * Caustics — the moving net of focused sunlight on the bottom.
 *
 * Two webs from the baked caustic map, scrolled against each other and
 * multiplied: a filament survives only where both fold at once, which is what
 * makes the pattern sparse and bright rather than an even mesh. Three things
 * make it read as depth rather than as a texture:
 *
 *   • the cells GROW with depth, because the cone of light spreads on the way
 *     down — this is the cue that tells you how deep the water is without a
 *     single colour changing;
 *   • it DEFOCUSES with depth, because a caustic is an image of the surface
 *     and the bottom is the screen it is projected on: sharp at ankle depth,
 *     a soft wash at four metres;
 *   • at the top tier the red and blue samples are taken either side along the
 *     refraction, so the filaments carry the colour fringe that real ones do.
 *
 * The point passed in is the SEABED point, not the surface point: anchoring
 * to the bottom is what stops the whole net sliding about with the camera.
 */
vec3 causticLight(vec2 p, float d, vec3 rd) {
  float scale = 0.055 / (1.0 + d * 0.055);
  vec2 driftA = vec2(0.011, 0.008) * uTime;
  vec2 driftB = vec2(0.013, 0.017) * uTime;
#if CAUSTIC_QUALITY >= 3
  vec2 e = normalize(rd.xz + vec2(1e-4)) * (0.10 + d * 0.05);
  float b = texture2D(uCausticMap, p * scale * 1.63 - driftB).g;
  vec3 w = vec3(
    texture2D(uCausticMap, (p - e) * scale + driftA).r,
    texture2D(uCausticMap, p * scale + driftA).r,
    texture2D(uCausticMap, (p + e) * scale + driftA).r
  ) * b;
#elif CAUSTIC_QUALITY == 2
  float a = texture2D(uCausticMap, p * scale + driftA).r;
  float b = texture2D(uCausticMap, p * scale * 1.63 - driftB).g;
  vec3 w = vec3(a * b);
#else
  // One fetch. Reads as light moving on the bottom; does not read as filaments.
  float a = texture2D(uCausticMap, p * scale + driftA).r;
  vec3 w = vec3(a * a);
#endif
  float focus = 1.0 - smoothstep(0.6, 14.0, d);
  vec3 c = pow(clamp(w * 2.35, 0.0, 1.0), vec3(mix(1.7, 3.4, focus)));
  c = mix(c * 0.42, c, focus);
  // A caustic is sunlight: it dies with the water column above it. 0.11/m put
  // the net out of sight by two metres, which is a silty English estuary; the
  // water this island is supposed to be sitting in holds it to six or eight.
  return c * exp(-d * 0.075) * 1.45;
}

/** Two scrolling octaves of the ripple map, plus a fine third close in. */
vec3 detailNormal(vec2 p, vec2 flow, float fadeFine, float fadeCoarse) {
  vec2 a = texture2D(uRippleMap, p * 0.0090 + flow * 0.35 + vec2(0.0060, 0.0036) * uTime).xy * 2.0 - 1.0;
  vec2 b = texture2D(uRippleMap, p * 0.0400 + flow * 1.20 - vec2(0.0130, 0.0186) * uTime).xy * 2.0 - 1.0;
  vec2 c = texture2D(uRippleMap, p * 0.1650 + flow * 3.60 + vec2(0.0300, -0.0235) * uTime).xy * 2.0 - 1.0;
  vec2 slope = a * fadeCoarse + b * (0.65 * mix(fadeFine, fadeCoarse, 0.4)) + c * (0.38 * fadeFine);
  return vec3(slope.x, 0.0, slope.y);
}

void main() {
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float viewDist = vWave.z;
  float depth = vSurf.x;
  float seabedSlope = vSurf.y;
  float shoreDist = vSurf.z;
  float fresh = vSurf.w;
  float crest = vWave.x;
  float fold = vWave.y;
  // How far up the sand the swash sheet currently is, 0..1.
  float wash = vWave.w;
  // Landward of the waterline: the wash itself. Only the part the terrain has
  // not already occluded survives to be shaded, so this is exactly the thin
  // sheet over the sand and nothing else.
  float film = sat(-shoreDist * 0.32);

  // ---- Normal --------------------------------------------------------------
  // Fine ripples die within a kilometre so the horizon cannot alias; the
  // coarse octave survives far enough that distant water never goes glassy.
  float fadeFine = 1.0 - smoothstep(60.0, 800.0, viewDist);
  float fadeCoarse = 1.0 - smoothstep(600.0, 3800.0, viewDist);
  // Ripples flatten out in ankle-deep water — friction with the bottom is
  // real, and it is what makes the last few metres read as *shallow*.
  float rippleMute = mix(0.25, 1.0, smoothstep(0.15, 5.0, depth));

  // Fresh water drifts downstream. The channel's flow direction is the shore
  // normal turned 90°, with the sign resolved against a fixed bias so both
  // banks of a river agree on which way is downhill.
  vec2 perp = vec2(-vShoreDir.y, vShoreDir.x);
  vec2 flow = perp * sign(dot(perp, uFlowBias) + 0.0001) * (fresh * uTime * 0.011);

  vec3 detail = detailNormal(vWorldPos.xz, flow, fadeFine, fadeCoarse);
  float rippleFoam = 0.0;

  #ifdef RIPPLE_COUNT
  // Rings shed by anything swimming. Spatially tiny, so the whole block is
  // skipped for the vast majority of the surface.
  if (viewDist < 190.0) {
    for (int i = 0; i < RIPPLE_COUNT; i++) {
      vec4 r = uRipples[i];
      if (r.w <= 0.0) continue;
      vec2 d = vWorldPos.xz - r.xy;
      float dist = length(d) + 1e-4;
      float radius = r.z * 3.2;
      if (dist > radius + 4.0) continue;
      float life = 1.0 - sat(r.z / ${RIPPLE_LIFE.toFixed(2)});
      float band = exp(-abs(dist - radius) * 1.6);
      float ring = band * life * r.w;
      detail.xz += (d / dist) * ring * -(dist - radius) * 1.8;
      rippleFoam += ring * 0.55;
    }
  }
  #endif

  vec3 N = normalize(vWaveNormal + detail * uDetailStrength * rippleMute);

  // Which side are we on? Taken from the camera rather than gl_FrontFacing:
  // the disc is DoubleSide and the answer has to stay stable no matter how the
  // rings happen to be wound.
  bool below = cameraPosition.y < uSeaLevel;
  if (below) N = -N;

  float ndv = sat(dot(N, viewDir));

  // ---- Lighting basis ------------------------------------------------------
  float sunUp = smoothstep(-0.06, 0.10, uSunDir.y);
  vec3 ambient = mix(vec3(0.10, 0.15, 0.26), vec3(1.0), sat(uDaylight));
  float diffuse = 0.55 + 0.45 * sat(dot(N, uSunDir));

  // ==========================================================================
  // Underwater — the player is swimming and we are shading the underside.
  // ==========================================================================
  if (below) {
    // Snell's window: a bright cone straight up, total internal reflection
    // everywhere outside it.
    float snell = smoothstep(0.55, 0.94, ndv);
    vec3 through = skyRadiance(normalize(vec3(viewDir.x * 0.4, abs(viewDir.y) + 0.45, viewDir.z * 0.4)));
    vec3 tir = uDeepColor * 2.4 + uMidColor * 0.4;
    vec3 col = mix(tir, mix(through, uShallowColor * 1.2, 0.25), snell);

    // The same net the seabed gets, seen from underneath as the light crossing
    // the water in front of the mask.
    col += uSunColor * causticLight(vWorldPos.xz, 3.0, vec3(0.0, -1.0, 0.0)) * 0.85 * sat(uDaylight);
    col *= ambient;

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
    return;
  }

  // ==========================================================================
  // Above water
  // ==========================================================================

  // ---- Refraction ----------------------------------------------------------
  // The view ray bends where it enters the water, so what you see on the bottom
  // is not what is directly under the pixel. Bending it properly is what makes
  // the seabed swim with the swell instead of reading as a photograph glued to
  // the underside of a sheet of glass — and because the offset is rd.xz / -rd.y
  // it stretches by itself as the view goes grazing, which is exactly what
  // refraction does and the reason a lagoon looks like one from the shore.
  vec3 rd = refract(-viewDir, N, 0.7519);          // air → water, 1.0 / 1.333
  vec2 bedP = vWorldPos.xz;
  float bedDepth = depth;
  if (depth < 34.0) {
    vec2 off = rd.xz / max(-rd.y, 0.09) * min(depth, 30.0);
    // Cap it. Three degrees above the water the analytic offset runs to
    // hundreds of metres and drags the next bay's seabed into these shallows.
    off *= min(1.0, 15.0 / max(length(off), 0.001));
    bedP = vWorldPos.xz + off;
    // Re-read the bottom where the bent ray lands. Per-pixel, so this also
    // takes the shoreline gradient off the vertex interpolation.
    bedDepth = mix(sampleSeabed(bedP).x, depth, smoothstep(140.0, 520.0, viewDist));
  }

  // ---- Depth colour (Beer–Lambert-ish, hand-graded for the tropics) --------
  vec3 body = mix(uShallowColor, uMidColor, smoothstep(0.0, 8.0, bedDepth));
  body = mix(body, uDeepColor, smoothstep(7.0, 65.0, bedDepth));

  // Bleached sand transmitting through the shallows — the single strongest
  // "tropical island" cue in the whole frame, and the reason the shoreline
  // reads from the bus at 700 m.
  // 0.36/m loses the bottom by four metres. The whole argument of a turquoise
  // shelf is that you can see through it, and the caustics have nothing to
  // land on once the sand has gone.
  float sandVis = exp(-bedDepth * 0.28);
  if (sandVis > 0.004) {
    vec3 sandCol = uSandColor;
    #if CAUSTIC_QUALITY > 1
    // Mottle the bottom. A seabed of one flat colour is what gives a shaded
    // bottom away instantly: real shallows are bare sand, weed and rock in slow
    // patches, with ripple bars combed across them.
    // (Not named "patch": that is a reserved word in GLSL ES, and the compiler
    // reports it as a syntax error two lines below where it is declared. A
    // backtick in a comment in here is the same class of trap — this whole
    // shader is a template literal, and one ends it.)
    float mottle = texture2D(uFoamMap, bedP * 0.0055).b;
    float bars = texture2D(uRippleMap, bedP * 0.085).a;
    sandCol = mix(sandCol, uSeabedColor, smoothstep(0.50, 0.80, mottle) * 0.8);
    sandCol *= 0.88 + 0.24 * bars;
    #endif
    vec3 caus = causticLight(bedP, bedDepth, rd);
    vec3 lit = sandCol * (0.80 + caus * 0.9) + uSunColor * caus * 0.55 * sat(uDaylight) * sunUp;
    body = mix(body, mix(lit, body, 0.30), sandVis * 0.88);
  }

  // Fresh water is not turquoise. Tannin green, murkier, and it loses the sand
  // read much faster — that difference is what tells the player at a glance
  // that this is a river and not a finger of the sea.
  body = mix(body, mix(uFreshColor, uFreshColor * 0.35, smoothstep(0.5, 6.0, depth)), fresh * 0.85);

  body *= ambient * diffuse;

  // ---- Sub-surface scatter through the crests ------------------------------
  // Light that enters the back of a wave scatters forward and leaves the face
  // green-teal. It is the cue that gives a swell scale — a wave with no glow
  // through it is a moving surface, a wave with one is a body of water — so it
  // is worth a real lobe rather than a rim term.
  //
  // The exit direction is the sun bent through the crest, so the term peaks
  // when the sun is behind the swell and the eye is looking into it.
  vec3 sssDir = normalize(-uSunDir + N * 0.6);
  float sss = pow(sat(dot(viewDir, sssDir)), 4.0);
  // Only water actually piled up has anything to glow through, and a steep face
  // has more of it in the way than a flat one.
  float thick = sat(crest * 0.8 + fold * 1.7);
  // A low sun rakes the long way through a crest; a noon sun goes down through
  // the top of it and lights nothing on the way to the eye.
  float rake = 1.0 - sat(uSunDir.y * 1.3);
  body += uSssColor * uSunColor * sss * thick * (0.30 + 0.95 * rake) * sat(uDaylight)
        * smoothstep(0.4, 4.0, depth) * (1.0 - fresh * 0.6)
        * (1.0 - smoothstep(700.0, 3000.0, viewDist));

  // ---- The wash over the sand ---------------------------------------------
  // Landward of the waterline the surface is a film a centimetre thick. There
  // is no water column to colour, so what shows through is wet sand: darker and
  // far glossier than the dry beach beside it, which is why every photograph of
  // a shoreline has a dark band running along it.
  body = mix(body, uWetSandColor * ambient * (0.5 + 0.5 * diffuse), film * 0.9);

  // ---- Fresnel reflection --------------------------------------------------
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  fres = clamp(fres, 0.02, 0.92);
  vec3 R = normalize(reflect(-viewDir, N));
  R.y = abs(R.y) * 0.86 + 0.02;              // never sample the underside
  R = normalize(R);
  // Clouds are a kilometre up, so the reflected ray travels kilometres before
  // it reaches them and any roughness on the surface blurs them out. Sampling
  // that plane along the DETAIL normal walks the cloud UV hundreds of metres
  // between neighbouring pixels, and it comes back as a field of white
  // speckle over the whole sea that reads as chop — it was the single most
  // artificial thing in an open-water frame, and it was not foam at all.
  // Macro normal for the clouds; the detail keeps the sky gradient and the
  // specular, which is where it belongs.
  vec3 Rc = normalize(reflect(-viewDir, normalize(vWaveNormal)));
  Rc.y = abs(Rc.y) * 0.86 + 0.02;
  vec3 reflection = cloudyReflection(vWorldPos, normalize(Rc), skyRadiance(R));

  #ifdef LAND_REFLECTION
  // March the reflected ray through the baked land-height field. Where the
  // island stands in front of the sky, the water under it goes dark instead of
  // mirroring a sky it cannot see — the cheapest honest reflection there is,
  // and its absence is exactly what makes web-game water look like plastic.
  if (shoreDist < 240.0) {
    float horiz = max(length(R.xz), 0.001);
    float occ = 0.0;
    for (int s = 1; s <= 4; s++) {
      float t = float(s) * 22.0;
      vec3 probe = sampleSeabed(vWorldPos.xz + R.xz / horiz * t);
      float rayY = (vWorldPos.y - uSeaLevel) + R.y / horiz * t;
      occ = max(occ, sat((probe.z - rayY) * 0.35));
    }
    vec3 landCol = uLandReflectColor * ambient * (0.5 + 0.5 * sat(uDaylight));
    reflection = mix(reflection, landCol, occ * 0.85);
  }
  #endif

  vec3 col = mix(body, reflection, fres);

  // ---- Sun specular: a tight disc lobe plus a broad glitter path -----------
  float spec = sat(dot(R, uSunDir));
  // As the fine normals fade with distance the sub-pixel roughness has to come
  // back as a wider lobe, or the glitter path collapses into a hard line.
  float tight = pow(spec, mix(160.0, 1100.0, fadeFine));
  float broad = pow(spec, mix(14.0, 70.0, fadeFine));
  col += uSunColor * (tight * 3.6 + broad * 0.3) * sat(uDaylight) * sunUp;

  // ---- Sparkle: micro-facets that only exist up close ----------------------
  // Rarer and brighter than it was. A glitter path is a scatter of individual
  // points that each blow past the bloom threshold, not a dusting over every
  // wave: pow(spec, 26) put one on a third of the sea whenever the sun was
  // anywhere ahead, which is the other half of why the water looked noisy.
  float sparkNoise = texture2D(uRippleMap, vWorldPos.xz * 0.62 + uTime * vec2(0.09, -0.07)).a;
  float spark = pow(sat(sparkNoise * 1.9 - 0.86), 3.0) * pow(spec, 52.0);
  col += uSunColor * spark * 9.0 * fadeFine * sat(uDaylight);

  // ==========================================================================
  // Foam
  // ==========================================================================
  vec3 foamTint = uFoamColor * ambient * (0.55 + 0.45 * diffuse);

  vec4 foamTex = texture2D(uFoamMap, vWorldPos.xz * 0.030);
  vec4 foamFine = texture2D(uFoamMap, vWorldPos.xz * 0.115);

  // ---- Shoreline surf ------------------------------------------------------
  // Only the coastal strip pays for this. The branch is spatially coherent, so
  // whole warps take the cheap path out over open water.
  float surf = 0.0;
  if (shoreDist < 140.0 && depth < 13.0) {
    // Gentle beaches spread the surf wide; steep rock keeps it tight. The band
    // also grows and shrinks with the sheet the vertex stage lifted, so the
    // foam travels with the water instead of breathing on the spot.
    // 2.2 on a flat beach was a fifty-metre band of white, which is a storm.
    float width = uFoamWidth * mix(1.45, 0.45, seabedSlope) * mix(1.0, 0.35, fresh)
                * mix(0.55, 1.35, wash);
    float shoreT = 1.0 - smoothstep(0.0, width, max(shoreDist, 0.0));
    // Gate on depth too, so surf can never appear over open water if the bake
    // and the terrain ever disagree.
    shoreT *= 1.0 - smoothstep(1.0, 10.0, depth);

    // Breaker sets marching IN. Phase = wt + kx puts the crest at a shore
    // distance that falls as time runs; reverse the sign and the sets walk out
    // to sea, which is what this did and what nobody had looked closely enough
    // to notice.
    float march = shoreDist * 0.09 + uTime * 0.62;
    float pulse = pow(sin(march) * 0.5 + 0.5, 2.2);
    float pulse2 = pow(sin(march * 0.47 + 1.7) * 0.5 + 0.5, 3.0);
    // The lift drives the wash now, so the foam brightens as the sheet arrives
    // and fades as it drains, in step with the geometry rather than beside it.
    float tide = 0.55 + 0.45 * wash;

    // The foam sheet drifts shoreward rather than sitting pinned to the world.
    vec4 drift = texture2D(uFoamMap, vWorldPos.xz * 0.030 - vShoreDir * (uTime * 0.020));
    vec4 driftFine = texture2D(uFoamMap, vWorldPos.xz * 0.115 + vShoreDir * (uTime * 0.010));

    surf = shoreT * tide * (0.30 + 0.70 * max(pulse, pulse2 * 0.8));
    surf *= mix(0.45, 1.25, drift.r) * mix(0.7, 1.3, drift.b);
    // The last metres of wash are almost solid white whatever the sets do.
    surf = max(surf, shoreT * shoreT * shoreT * 1.15 * mix(0.6, 1.0, driftFine.g));
    // Over the sand: a bright lip at the leading edge and streaks trailing
    // behind it, NOT a blanket. Painting the whole wet band white is what
    // turned a flat beach into a snowfield, and it also hid the wet sand,
    // which is the half of this that reads as water having just been there.
    float lip = smoothstep(0.0, 0.30, film) * (1.0 - smoothstep(0.30, 0.90, film));
    float streak = film * smoothstep(0.42, 0.86, drift.r) * 0.5;
    surf = max(surf, (lip * (0.45 + 0.55 * wash) + streak) * mix(0.6, 1.1, driftFine.g));
    surf = sat(surf);
  }

  // ---- Whitecaps on open-water crests --------------------------------------
  // Whitecaps break on the steepest few per cent of the crests, not on all of
  // them. This opened wide enough to lay a film of white over most of the sea,
  // and an even scatter of speckle everywhere is what a gale looks like from a
  // ferry — a two-metre swell in sunshine is blue with a little white on it,
  // and that difference is most of why the old frame read as choppy grey.
  float capDrive = sat(crest * 0.62 + fold * 1.3 - 0.52);
  float caps = smoothstep(0.14, 0.68, capDrive) * smoothstep(2.5, 16.0, depth);
  // Clumped hard rather than modulated: foam is patchy along a breaking crest
  // and absent between the patches, never an even film across the whole face.
  caps *= smoothstep(0.30, 0.80, foamTex.r) * mix(0.15, 1.0, foamFine.g);
  caps *= (1.0 - smoothstep(1400.0, 4600.0, viewDist)) * (1.0 - fresh);

  float foam = sat(max(max(surf, caps * 0.85), rippleFoam * mix(0.35, 1.0, foamFine.g)));
  col = mix(col, foamTint, foam);
  // Foam is rough, so it kills the specular under it rather than sitting on
  // top of a mirror. Cheap, and it is the detail that sells wet white water.
  col -= uSunColor * tight * 2.4 * foam * sat(uDaylight);

  // ---- Spray where the swell meets rock ------------------------------------
  // No particles: a steep shore, an arriving set, and a value pushed past the
  // bloom threshold so the pyramid smears it into a haze standing above the
  // rocks. One multiply-add, and it is the only thing in the frame that says
  // the water is hitting something hard rather than running out on sand.
  float rocky = smoothstep(0.42, 0.88, seabedSlope) * (1.0 - fresh);
  float burst = rocky * sat(wash * 1.3 - 0.35) * (1.0 - smoothstep(0.0, 14.0, max(shoreDist, 0.0)));
  col += uFoamColor * burst * 0.9 * sat(uDaylight) * (1.0 - smoothstep(220.0, 900.0, viewDist));

  // ---- Horizon resolve -----------------------------------------------------
  // Past the fog the disc edge must not read as a rim. Fold the last few
  // kilometres into the haze by hand, in case the sky ever runs without fog.
  float hz = smoothstep(4200.0, 7100.0, viewDist);
  col = mix(col, uHazeColor, hz * 0.92);
  // Then put the glitter road back into the haze. The far field is still
  // water, and at eight kilometres the only thing that says so is that the sun
  // is still on it; fold that away with everything else and the last two
  // kilometres read as a painted band.
  col += uSunColor * broad * 0.4 * hz * sat(uDaylight) * sunUp;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/* ------------------------------------------------------------------------ *
 * System
 * ------------------------------------------------------------------------ */

/**
 * The sky system publishes a superset of `SkyService` with its own palette on
 * it. Systems never import each other, so this is the structural shape we
 * duck-type against — every field optional, every read guarded.
 */
interface SkyPalette {
  horizonColor?: THREE.Color;
  zenithColor?: THREE.Color;
}

const createWater: SystemFactory = (ctx) => {
  const tier = TIERS[ctx.quality] ?? TIERS.high;
  const terrain = ctx.services.terrain;
  let seaLevel = terrain?.seaLevel ?? FALLBACK_SEA_LEVEL;
  const mapHalf = (terrain?.worldSize ?? FALLBACK_WORLD_SIZE) + MAP_MARGIN;
  const seed = Math.floor(ctx.rng() * 0xffffff);

  const rippleMap = makeRippleNormalTexture(tier.detail, seed);
  const foamMap = makeFoamTexture(tier.detail, seed + 977);
  // Capped at 256 whatever the tier: the Worley pass is O(n²·9) at boot and a
  // caustic net is all low-frequency structure — 512² buys nothing but a
  // slower load, which on the ultra tier was a fifth of a second of it.
  const causticMap = makeCausticTexture(Math.min(256, tier.detail), seed + 4241);

  const maxAniso = (() => {
    try {
      return ctx.renderer.capabilities.getMaxAnisotropy();
    } catch {
      return 1;
    }
  })();
  rippleMap.anisotropy = Math.min(8, maxAniso);
  foamMap.anisotropy = Math.min(8, maxAniso);
  causticMap.anisotropy = Math.min(8, maxAniso);

  // Boot order puts terrain ahead of us, but "ahead of us" is a guarantee
  // about ordering, not about success. If terrain is missing we bake a
  // plausible island now and re-bake for real the moment it shows up.
  let bake = bakeSeabed(ctx, tier.bake, seaLevel, mapHalf);
  let rebakeChecked = bake.fromTerrain;

  // Golden-hour defaults, overwritten every frame from the sky service.
  const sunDir = new THREE.Vector3(0.52, 0.42, 0.34).normalize();
  const sunColor = new THREE.Color(0xffd9a0);
  const horizonColor = new THREE.Color(0x9fd6ea);
  const zenithColor = new THREE.Color(0x2f7fc9);
  const hazeColor = new THREE.Color(0xbfe0ea);

  const rippleSlots = tier.ripples;
  const ripples: THREE.Vector4[] = [];
  for (let i = 0; i < rippleSlots; i++) ripples.push(new THREE.Vector4(0, 0, 0, 0));

  const maxAmplitude = WAVES.slice(0, tier.waves).reduce((s, w) => s + w.amp, 0);

  const uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uSeaLevel: { value: seaLevel },

    uWaveA: {
      value: WAVES.slice(0, tier.waves).map((w) => new THREE.Vector4(w.dir[0], w.dir[1], w.amp, w.len)),
    },
    uWaveB: { value: WAVES.slice(0, tier.waves).map((w) => new THREE.Vector2(w.q, w.speed)) },
    uWaveGain: { value: 1 },
    uMaxAmplitude: { value: maxAmplitude },

    uDepthMap: { value: bake.depth },
    uShoreMap: { value: bake.shore },
    uMapOrigin: { value: new THREE.Vector2(-mapHalf, -mapHalf) },
    uMapInvSize: { value: 1 / (mapHalf * 2) },
    uMapSpan: { value: mapHalf * 2 },

    uRippleMap: { value: rippleMap },
    uFoamMap: { value: foamMap },
    uCausticMap: { value: causticMap },

    uSunDir: { value: sunDir },
    uSunColor: { value: sunColor },
    uZenithColor: { value: zenithColor },
    uHorizonColor: { value: horizonColor },
    uHazeColor: { value: hazeColor },
    uCloudColor: { value: new THREE.Color(0xfdf6ec) },
    uLandReflectColor: { value: new THREE.Color(0x233524) },
    uDaylight: { value: 1 },

    // Graded against ACES + sRGB output: the shallows read turquoise, the deep
    // reads sapphire, and the sand is bleached rather than yellow. Saturated,
    // not garish — the art direction lives in these five colours.
    uShallowColor: { value: new THREE.Color(0x37d8c4) },
    uMidColor: { value: new THREE.Color(0x0c6e9c) },
    uDeepColor: { value: new THREE.Color(0x04203f) },
    uSandColor: { value: new THREE.Color(0xe7d8b2) },
    uFoamColor: { value: new THREE.Color(0xf2fbff) },
    uFreshColor: { value: new THREE.Color(0x2f7d5c) },
    // What comes back OUT of a lit wave, which is not what the water looks
    // like from above: scattering strips the blue on the way through and the
    // crest glows green.
    uSssColor: { value: new THREE.Color(0x4ce8b4) },
    // Wet sand, not sand. Roughly half the reflectance of the dry beach — the
    // water in the pores kills the diffuse and the band goes dark.
    uWetSandColor: { value: new THREE.Color(0x7d6c4f) },
    // Weed and rock on the bottom, in patches, under the sand tint.
    uSeabedColor: { value: new THREE.Color(0x2e5140) },

    uDetailStrength: { value: ctx.quality === "low" ? 0.55 : 0.9 },
    uFoamWidth: { value: 22 },
    uSwash: { value: SWASH_HEIGHT },
    uFlowBias: { value: new THREE.Vector2(0.86, 0.51) },

    uRipples: { value: ripples },

    // Populated by the renderer whenever scene.fog is present.
    fogColor: { value: new THREE.Color(0x9fd6ea) },
    fogNear: { value: 500 },
    fogFar: { value: 4200 },
    fogDensity: { value: 0.00025 },
  };

  const defines: Record<string, string | number> = {
    WAVE_COUNT: tier.waves,
    CAUSTIC_QUALITY: tier.caustics,
  };
  if (rippleSlots > 0) defines.RIPPLE_COUNT = rippleSlots;
  if (tier.landReflection) defines.LAND_REFLECTION = "";

  const material = new THREE.ShaderMaterial({
    uniforms,
    defines,
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    // Shaded from below when the player swims, so both faces must run.
    side: THREE.DoubleSide,
    fog: true,
    // Opaque: the plane terminates exactly where terrain rises through it,
    // which is a clean depth-buffer intersection. Going transparent here would
    // only buy sorting bugs against the vegetation and the loot beams.
    transparent: false,
    depthWrite: true,
  });

  const geometry = buildDisc(tier.segments, tier.rings);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "dz:water";
  mesh.frustumCulled = false;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  // Drawn after the opaque island, so most of the sea is already depth-
  // rejected by the time this very large surface is shaded.
  mesh.renderOrder = 1;
  mesh.position.set(0, seaLevel, 0);
  ctx.scene.add(mesh);

  /**
   * Underwater fog. Swapped in for the sky's fog while the camera is below the
   * surface and swapped straight back out — the sky keeps updating its own
   * instance the whole time, so surfacing restores a live object, not a stale
   * snapshot.
   */
  const underwaterFog = new THREE.FogExp2(0x0d4a58, 0.05);
  let priorFog: THREE.FogBase | null = null;
  let submerged = false;

  const tmpColor = new THREE.Color();
  const tmpVec = new THREE.Vector3();

  // Ripple emitters, keyed by actor id, each shedding a ring on a cooldown.
  const emitterCooldown = new Map<string, number>();
  let rippleCursor = 0;
  let scanTimer = 0;

  const spawnRipple = (x: number, z: number, strength: number): void => {
    if (rippleSlots === 0) return;
    // Reuse the oldest slot. With a handful of swimmers in view the pool never
    // runs dry; with a crowd, the nearest rings win by recency, which is the
    // right thing to lose.
    let slot = rippleCursor % rippleSlots;
    let bestAge = -1;
    for (let i = 0; i < rippleSlots; i++) {
      const r = ripples[i];
      if (r.w <= 0) {
        slot = i;
        bestAge = Infinity;
        break;
      }
      if (r.z > bestAge) {
        bestAge = r.z;
        slot = i;
      }
    }
    rippleCursor++;
    ripples[slot].set(x, z, 0, strength);
  };

  const waterDepthAt = (x: number, z: number): number => {
    const t = ctx.services.terrain;
    if (!t) return 0;
    return seaLevel - t.heightAt(x, z);
  };

  const sys: System = {
    name: "water",

    update(dt, c) {
      if (rippleSlots === 0) return;

      for (const r of ripples) {
        if (r.w <= 0) continue;
        r.z += dt;
        if (r.z > RIPPLE_LIFE) r.w = 0;
      }

      scanTimer -= dt;
      if (scanTimer > 0) return;
      scanTimer = RIPPLE_SCAN_INTERVAL;

      const shed = (id: string, pos: THREE.Vector3, strength: number): void => {
        // Only things actually in the water, and only where there is water
        // under them — a player standing on a cliff above the shoreline must
        // not shed rings into the sea below.
        if (pos.y > seaLevel + 1.4 || pos.y < seaLevel - 6) return;
        if (waterDepthAt(pos.x, pos.z) < 0.35) return;
        const next = (emitterCooldown.get(id) ?? 0) - RIPPLE_SCAN_INTERVAL;
        if (next > 0) {
          emitterCooldown.set(id, next);
          return;
        }
        emitterCooldown.set(id, RIPPLE_INTERVAL);
        spawnRipple(pos.x, pos.z, strength);
      };

      const player = c.services.player;
      if (player) shed("player", player.position, 1);

      // Bots wading in the shallows get rings too — movement in water you can
      // see from 100 m away is the cheapest tell in the game.
      const combat = c.services.combat;
      if (combat) {
        const targets = combat.queryTargets(c.camera.position, 140);
        for (const t of targets) {
          if (!t.alive || t.faction !== "bot") continue;
          t.object.getWorldPosition(tmpVec);
          shed(t.id, tmpVec, 0.8);
        }
      }
    },

    lateUpdate(_dt, c) {
      uniforms.uTime.value = c.elapsed;

      // If terrain booted late (or failed and recovered), the bake we are
      // running on is the fallback island. Redo it once, properly.
      if (!rebakeChecked) {
        const t = c.services.terrain;
        if (t) {
          rebakeChecked = true;
          seaLevel = t.seaLevel;
          const next = bakeSeabed(c, tier.bake, seaLevel, mapHalf);
          bake.depth.dispose();
          bake.shore.dispose();
          bake = next;
          uniforms.uDepthMap.value = bake.depth;
          uniforms.uShoreMap.value = bake.shore;
          uniforms.uSeaLevel.value = seaLevel;
        }
      }

      // Slide the disc under the camera. Waves are evaluated in world space in
      // the vertex shader, so the swell stays anchored to the world while the
      // vertex density stays anchored to the viewer.
      mesh.position.set(c.camera.position.x, seaLevel, c.camera.position.z);

      // ---- Sun -------------------------------------------------------------
      const sky = c.services.sky as (SkyService & SkyPalette) | undefined;
      if (sky) {
        sunDir.copy(sky.sunDirection).normalize();
        sunColor.copy(sky.sunColor);
        uniforms.uDaylight.value = sky.daylight;
        // The swell calms overnight. Small, but it stops the night sea from
        // being the same frame with the lights off.
        uniforms.uWaveGain.value = 0.74 + 0.26 * THREE.MathUtils.clamp(sky.daylight, 0, 1);
      }

      // ---- Sky palette -----------------------------------------------------
      // Preferred source is the sky system's own horizon/zenith radiance; the
      // fog and background are the fallback when it publishes neither.
      const fog = c.scene.fog;
      if (fog && !submerged) hazeColor.copy(fog.color);

      if (sky?.horizonColor && sky?.zenithColor) {
        horizonColor.copy(sky.horizonColor);
        zenithColor.copy(sky.zenithColor);
      } else {
        const bg = c.scene.background;
        if (bg && (bg as THREE.Color).isColor) horizonColor.copy(bg as THREE.Color);
        else if (fog) horizonColor.copy(fog.color).multiplyScalar(1.05);
        // Zenith is the horizon pushed deeper and bluer — cheap, and it keeps
        // the reflection consistent with the sky as the day moves.
        zenithColor.copy(horizonColor).multiply(tmpColor.setRGB(0.42, 0.66, 1.06));
      }

      // ---- Submersion ------------------------------------------------------
      const nowUnder = c.camera.position.y < seaLevel;
      if (nowUnder !== submerged) {
        submerged = nowUnder;
        if (submerged) {
          priorFog = c.scene.fog;
          // Visibility collapses to ~40 m and everything goes teal. Postfx
          // picks the same event up for the screen tint and the muffle.
          c.scene.fog = underwaterFog;
          hazeColor.setHex(0x0d4a58);
        } else {
          if (c.scene.fog === underwaterFog) c.scene.fog = priorFog;
          priorFog = null;
        }
        c.emit("dz:underwater", submerged);
        c.services.audio?.play(submerged ? "splash_in" : "splash_out", { volume: 0.6 });
      }
    },

    dispose() {
      if (ctx.scene.fog === underwaterFog) ctx.scene.fog = priorFog;
      ctx.scene.remove(mesh);
      geometry.dispose();
      material.dispose();
      rippleMap.dispose();
      foamMap.dispose();
      causticMap.dispose();
      bake.depth.dispose();
      bake.shore.dispose();
      emitterCooldown.clear();
    },
  };

  return sys;
};

export default createWater;

/** Tallest the swell can get, for anything that wants to clear the water. */
export const WATER_MAX_WAVE_HEIGHT = WAVES.reduce((s, w) => s + w.amp, 0);
