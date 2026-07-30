/**
 * San Palmas — landmarks.
 *
 * The five hero silhouettes: Puente Dorado, La Aguja, Torre Palma, Isla Roca
 * and Mercado Ferry. These are what the camera points at from every hilltop in
 * the world, so none of them is a box approximation — each one is a swept,
 * fluted, weathered, instanced model with human-scale detail down to kerbs and
 * railing posts.
 *
 * Four ideas do all the work here:
 *
 *  1. TWO SWEEP BUILDERS, NOT A HUNDRED BOXES. `sweepY` extrudes a 2D section
 *     up a list of tapering stations (tower legs, the pyramid, the lighthouse,
 *     the clock tower); `sweepZ` extrudes a 2D section along the bridge axis
 *     (roadway, sidewalks, stiffening truss, kerbs, main cables). Sections
 *     carry their own U coordinate, so texel density is uniform on a taper and
 *     the roadway's painted lane lines land exactly where they should.
 *
 *  2. THE GROUND IS SAMPLED, NEVER ASSUMED. Every abutment, pier, plinth and
 *     footing is seated with `TerrainService.heightAt`. The bridge in
 *     particular is *surveyed* at boot: it marches north from the tower until
 *     the descending deck meets the ground and puts its abutment there, and
 *     marches south until the Presidio cliff rises through the deck and puts a
 *     tunnel portal there. Move a hill in the atlas and the bridge re-fits.
 *
 *  3. EVERY SURFACE IS TEXTURED. Seven procedural material sets — painted
 *     steel, weathered concrete, roadway, curtain-wall panel, stucco,
 *     terracotta and sea rock — each baked in a single texel pass that emits
 *     albedo, a roughness/metalness pack, a height-derived normal map and (for
 *     the glazed ones) an emissive window map. No canvas, no downloads.
 *     Tinted variants share the maps, so a new colour costs nothing.
 *
 *  4. INSTANCE THE REPEATS. Suspenders, railing posts, lamp standards, truss
 *     bracing, viaduct piers, cell windows and arcade bays are InstancedMeshes;
 *     everything static is merged per material. The whole set lands at roughly
 *     50 draw calls.
 *
 * Reads TerrainService (seating), SkyService (night emissives, clock hands) and
 * CollisionService (colliders). All three optional — a missing service costs
 * that feature and nothing else.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { QualityTier, System, SystemFactory, WorldCtx } from "../types";
import { LANDMARKS, SEA_LEVEL, hillHeight, landSignedDistance, shoreProfile } from "./atlas";

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

interface Tier {
  /** Procedural map resolution, per side. */
  tex: number;
  /** Radial segments on cylindrical sweeps. */
  radial: number;
  /** Metres between bridge suspender ropes. */
  suspender: number;
  /** Metres between railing posts. */
  railPost: number;
  /** Emit the second tier of detail (bracing, mullions, bollards, ruins). */
  detail: boolean;
  /** Distance at which small detail groups switch off, metres. */
  detailRange: number;
}

const TIERS: Record<QualityTier, Tier> = {
  low: { tex: 64, radial: 12, suspender: 26, railPost: 9, detail: false, detailRange: 260 },
  medium: { tex: 128, radial: 16, suspender: 18, railPost: 6, detail: false, detailRange: 400 },
  high: { tex: 256, radial: 22, suspender: 12, railPost: 4.2, detail: true, detailRange: 620 },
  ultra: { tex: 256, radial: 32, suspender: 10, railPost: 3.4, detail: true, detailRange: 900 },
};

/* ------------------------------------------------------------------------ *
 * Small maths
 * ------------------------------------------------------------------------ */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const fract = (v: number) => v - Math.floor(v);

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** A soft band centred on `c`, `w` wide. Used for seams, mouldings, markings. */
function band(x: number, c: number, w: number, soft: number): number {
  return 1 - smoothstep(w, w + soft, Math.abs(x - c));
}

/* ------------------------------------------------------------------------ *
 * Tileable procedural noise
 * ------------------------------------------------------------------------ */
//
// Same wrapped-lattice family the terrain uses. Every map below is seamless by
// construction, which matters more here than on the ground: a repeating seam
// on a 190 m tower is visible from the far side of the bay.

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

/**
 * Fractal value noise over UV in [0,1). `u` and `v` may only ever be scaled by
 * whole numbers before they get here, or the lattice stops wrapping at the tile
 * edge and the map grows a seam.
 */
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

/** Value noise on a lattice that wraps at different periods in x and y. */
function vnoiseA(x: number, y: number, px: number, py: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py;
  const x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  const top = a + (b - a) * u;
  return top + (c + (d - c) * u - top) * v;
}

/**
 * Anisotropic fBm. Weathering is *directional* — rain runs down, salt blooms
 * out of horizontal joints — and an isotropic noise stretched by scaling one
 * axis of an isotropic lattice produces a comb of evenly spaced vertical bars,
 * which is exactly what plaster and concrete must not look like. Independent
 * x/y periods give irregular streaks instead.
 */
function fbmA(u: number, v: number, px: number, py: number, octaves: number, seed: number): number {
  let amp = 1, sum = 0, norm = 0, ax = px, ay = py;
  for (let o = 0; o < octaves; o++) {
    sum += vnoiseA(u * ax, v * ay, ax, ay, seed + o * 197) * amp;
    norm += amp;
    amp *= 0.5;
    ax *= 2; ay *= 2;
  }
  return sum / norm;
}

/**
 * Vertical weathering streaks.
 *
 * An anisotropic lattice alone still lands its features on an even comb — a
 * 3 m concrete pier ends up looking like corrugated card. Warping the U domain
 * with a low-frequency field first scatters them. The warp is safe for tiling
 * because it wraps over U with period 1, so shifting U by a whole tile shifts
 * the warped lattice by a whole number of cells.
 */
function streakT(u: number, v: number, across: number, seed: number): number {
  const w = (fbmT(u, v, 3, 3, seed + 7717) - 0.5) * 0.6;
  return (
    fbmA(u + w, v, across, 2, 4, seed) * 0.66 +
    fbmA(u - w * 0.5, v, Math.max(2, across >> 1), 3, 3, seed + 313) * 0.34
  );
}

/** Tileable Worley F1, roughly 0..1. Aggregate, pitting, lichen, tile cells. */
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

/** Ridged fractal — the |n| fold gives cracks and fractures, not blobs. */
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

/* ------------------------------------------------------------------------ *
 * Material bakery
 * ------------------------------------------------------------------------ */
//
// One texel pass per material emits everything at once:
//   out[0..2] albedo            → `map` (sRGB)
//   out[3]    roughness         → `roughnessMap`.g
//   out[4]    metalness         → `metalnessMap`.b (same texture)
//   out[5]    height            → central-differenced into `normalMap`
//   out[6..8] emissive          → `emissiveMap` (sRGB), only when asked for
// Sharing one pass matters: these seven materials are ~1.2 M texel evaluations
// between them and the loading screen has to keep painting through it.

type TexelFn = (u: number, v: number, out: Float32Array) => void;

/**
 * Window bays (and storeys) per curtain-wall tile. Six rather than four: the
 * lit-window lottery then has thirty-six outcomes before it repeats, which at
 * 2.9 m bays puts the repeat at 17 m across and 23 m up — far enough apart that
 * a 300 m tower does not read as a stamped sheet.
 */
const PANEL_TILE = 6;

export interface MapSet {
  map: THREE.DataTexture;
  rough: THREE.DataTexture;
  normal: THREE.DataTexture | null;
  emissive: THREE.DataTexture | null;
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

function bakeMaps(
  size: number,
  aniso: number,
  opts: { normal?: number; emissive?: boolean; clampU?: boolean },
  fn: TexelFn,
): MapSet {
  const alb = new Uint8Array(size * size * 4);
  const rm = new Uint8Array(size * size * 4);
  const emi = opts.emissive ? new Uint8Array(size * size * 4) : null;
  const height = opts.normal ? new Float32Array(size * size) : null;
  const out = new Float32Array(9);
  const inv = 1 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = y * size + x;
      out.fill(0);
      out[3] = 0.8;
      fn((x + 0.5) * inv, (y + 0.5) * inv, out);
      const o = c * 4;
      alb[o] = clamp01(out[0]) * 255;
      alb[o + 1] = clamp01(out[1]) * 255;
      alb[o + 2] = clamp01(out[2]) * 255;
      alb[o + 3] = 255;
      // R free, G roughness, B metalness — the layout MeshStandardMaterial
      // wants when one texture serves as both roughnessMap and metalnessMap.
      rm[o] = 255;
      rm[o + 1] = clamp01(out[3]) * 255;
      rm[o + 2] = clamp01(out[4]) * 255;
      rm[o + 3] = 255;
      if (height) height[c] = out[5];
      if (emi) {
        emi[o] = clamp01(out[6]) * 255;
        emi[o + 1] = clamp01(out[7]) * 255;
        emi[o + 2] = clamp01(out[8]) * 255;
        emi[o + 3] = 255;
      }
    }
  }

  let normal: THREE.DataTexture | null = null;
  if (height && opts.normal) {
    const strength = opts.normal * size * 0.012;
    const nrm = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      const yp = ((y + 1) % size) * size, yn = ((y - 1 + size) % size) * size, yc = y * size;
      for (let x = 0; x < size; x++) {
        const xp = (x + 1) % size, xn = (x - 1 + size) % size;
        // Wrapped central differences, so the normal map is as seamless as the
        // height field it came from.
        const dx = (height[yc + xp] - height[yc + xn]) * strength;
        const dy = (height[yp + x] - height[yn + x]) * strength;
        let nx = -dx, ny = -dy, nz = 1;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx /= len; ny /= len; nz /= len;
        const o = (y * size + x) * 4;
        nrm[o] = (nx * 0.5 + 0.5) * 255;
        nrm[o + 1] = (ny * 0.5 + 0.5) * 255;
        nrm[o + 2] = (nz * 0.5 + 0.5) * 255;
        nrm[o + 3] = 255;
      }
    }
    normal = finish(new THREE.DataTexture(nrm, size, size, THREE.RGBAFormat), false, aniso);
  }

  const set: MapSet = {
    map: finish(new THREE.DataTexture(alb, size, size, THREE.RGBAFormat), true, aniso),
    rough: finish(new THREE.DataTexture(rm, size, size, THREE.RGBAFormat), false, aniso),
    normal,
    emissive: emi ? finish(new THREE.DataTexture(emi, size, size, THREE.RGBAFormat), true, aniso) : null,
  };

  // The roadway map spans the deck exactly once across its width; letting it
  // wrap in U would put a second set of lane lines on the sidewalk.
  if (opts.clampU) {
    for (const t of [set.map, set.rough, set.normal, set.emissive]) {
      if (t) t.wrapS = THREE.ClampToEdgeWrapping;
    }
  }
  return set;
}

interface MatOpts {
  color?: number;
  roughness?: number;
  metalness?: number;
  emissive?: number;
  /** Emissive intensity at full daylight / full night. */
  day?: number;
  night?: number;
  normalScale?: number;
  side?: THREE.Side;
}

/**
 * A standard material over a baked map set. `scene.environment` in r160 only
 * reaches Standard/Physical materials, so everything visible in this module is
 * one of these — a Lambert or Basic surface here would read as a dead cutout.
 */
function makeMat(maps: MapSet | null, o: MatOpts = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: o.color ?? 0xffffff,
    roughness: o.roughness ?? 1,
    metalness: o.metalness ?? (maps ? 1 : 0),
    side: o.side ?? THREE.FrontSide,
    dithering: true,
  });
  if (maps) {
    m.map = maps.map;
    m.roughnessMap = maps.rough;
    m.metalnessMap = maps.rough;
    if (maps.normal) {
      m.normalMap = maps.normal;
      const s = o.normalScale ?? 1;
      m.normalScale = new THREE.Vector2(s, s);
    }
    if (maps.emissive && o.emissive !== undefined) {
      m.emissiveMap = maps.emissive;
      m.emissive = new THREE.Color(o.emissive);
      m.emissiveIntensity = o.day ?? 0;
    }
  } else if (o.emissive !== undefined) {
    m.emissive = new THREE.Color(o.emissive);
    m.emissiveIntensity = o.day ?? 0;
  }
  return m;
}

/* ------------------------------------------------------------------------ *
 * The seven surfaces
 * ------------------------------------------------------------------------ */

/**
 * Painted structural steel — international orange, sun-faded, streaked and
 * rusting out of every riveted seam. Tiles over 4 m, which puts the rivets at
 * a believable 12 cm pitch.
 */
const steelTexel: TexelFn = (u, v, out) => {
  const pu = u * 4, pv = v * 3;                       // plate grid
  const du = Math.min(fract(pu), 1 - fract(pu));
  const dv = Math.min(fract(pv), 1 - fract(pv));
  const seamU = smoothstep(0.030, 0.0, du);
  const seamV = smoothstep(0.024, 0.0, dv);
  const seam = Math.max(seamU, seamV);

  // Rivet heads march down every seam.
  const rivU = Math.abs(fract(pv * 14) - 0.5);
  const rivV = Math.abs(fract(pu * 14) - 0.5);
  const rivet = Math.max(seamU * smoothstep(0.34, 0.16, rivU), seamV * smoothstep(0.34, 0.16, rivV));

  const grain = fbmT(u, v, 26, 3, 3301);
  const fade = fbmT(u, v, 3, 4, 771);
  // Rain runs *down* a bridge tower, so the run-off lattice is 14 cells across
  // and 2 tall — irregular vertical streaking, not a comb of even bars.
  const streak = streakT(u, v, 14, 1187);
  const rustBlob = smoothstep(0.44, 0.86, fbmT(u, v, 5, 4, 2213));
  const rust = clamp01(
    rustBlob * (0.50 + 0.90 * seam) + smoothstep(0.54, 0.90, streak) * 0.85 * (0.22 + seam),
  );
  // Every plate was painted on a different day by a different crew.
  const plate = hash2(Math.floor(pu), Math.floor(pv), 5591) - 0.5;

  // Base coat: deep orange-vermilion, bleached where the sun has had at it.
  let r = 0.605 + fade * 0.20 + grain * 0.05 + plate * 0.11;
  let g = 0.180 + fade * 0.085 + grain * 0.035 + plate * 0.045;
  let b = 0.090 + fade * 0.050 + grain * 0.030 + plate * 0.030;
  const bleach = smoothstep(0.52, 0.92, fade);
  r += bleach * 0.15; g += bleach * 0.13; b += bleach * 0.12;

  // Streaked grime, then rust eating the paint from the seams outward, with
  // a pale primer coat showing through where the top coat has flaked.
  const grime = smoothstep(0.34, 0.82, streak) * 0.45;
  r *= 1 - grime * 0.42; g *= 1 - grime * 0.34; b *= 1 - grime * 0.26;
  const flake = smoothstep(0.74, 0.94, fbmT(u, v, 13, 3, 6607)) * (1 - rust);
  r = lerp(r, 0.50, flake * 0.5); g = lerp(g, 0.32, flake * 0.5); b = lerp(b, 0.24, flake * 0.5);
  r = lerp(r, 0.335, rust); g = lerp(g, 0.150, rust); b = lerp(b, 0.070, rust);

  // Seam shadow, rivet highlight.
  const sh = seam * 0.30;
  out[0] = r * (1 - sh) + rivet * 0.10;
  out[1] = g * (1 - sh) + rivet * 0.06;
  out[2] = b * (1 - sh) + rivet * 0.04;
  out[3] = lerp(0.42 - bleach * 0.06 + grain * 0.10 + grime * 0.10, 0.95, rust);
  out[4] = lerp(0.40, 0.05, rust);
  out[5] = rivet * 0.9 - seam * 0.45 + grain * 0.10 - rustBlob * 0.16 - flake * 0.20;
};

/**
 * Weathered cast concrete: board-formed, aggregate-pitted, stained by fifty
 * tropical wet seasons. The workhorse — piers, anchorages, kerbs, the prison,
 * the portal, every plinth.
 */
const concreteTexel: TexelFn = (u, v, out) => {
  const boardV = v * 6;                              // form-board lifts
  const bf = Math.min(fract(boardV), 1 - fract(boardV));
  const lift = smoothstep(0.045, 0.0, bf);
  // Each board pour cured a slightly different colour — the single most
  // recognisable thing about board-formed concrete.
  const pour = hash2(0, Math.floor(boardV), 3121) - 0.5;
  const pourWarm = hash2(1, Math.floor(boardV), 8837) - 0.5;
  const grain = fbmT(u, v, 24, 4, 4801);
  const blotch = fbmT(u, v, 3, 5, 611);
  const agg = worleyT(u, v, 20, 9911);
  const pit = 1 - smoothstep(0.0, 0.24, agg);
  // One streak field, read at two thresholds: the general wash, and the rust
  // bleed that only happens where the water actually runs. Halves the noise
  // budget of the most expensive map in the module and is more truthful too.
  const runoff = streakT(u, v, 12, 1553);
  const stain = smoothstep(0.40, 0.86, runoff);
  const crack = Math.pow(ridgedT(u, v, 7, 4, 88), 9);

  // Warm pale grey, drifting toward bone in the sun and mould in the shade.
  let r = 0.640 + blotch * 0.22 + grain * 0.08 + pour * 0.10 + pourWarm * 0.05;
  let g = 0.612 + blotch * 0.20 + grain * 0.08 + pour * 0.095;
  let b = 0.548 + blotch * 0.16 + grain * 0.07 + pour * 0.080 - pourWarm * 0.04;

  r *= 1 - stain * 0.36; g *= 1 - stain * 0.32; b *= 1 - stain * 0.24;
  // Algae in the damp, warm rust bleed from the rebar, salt bloom at the joints.
  const algae = smoothstep(0.62, 0.94, blotch) * (0.35 + 0.65 * stain);
  r -= algae * 0.13; g -= algae * 0.02; b -= algae * 0.11;
  const bleed = smoothstep(0.74, 0.97, runoff) * 0.70;
  r += bleed * 0.20; g += bleed * 0.08; b += bleed * 0.01;
  const bloom = smoothstep(0.14, 0.02, bf) * smoothstep(0.35, 0.75, grain) * 0.35;
  r += bloom * 0.16; g += bloom * 0.16; b += bloom * 0.15;

  r -= crack * 0.32 + pit * 0.16 + lift * 0.12;
  g -= crack * 0.31 + pit * 0.16 + lift * 0.12;
  b -= crack * 0.28 + pit * 0.14 + lift * 0.11;

  out[0] = r; out[1] = g; out[2] = b;
  out[3] = 0.88 + grain * 0.09 - pit * 0.06 + stain * 0.04;
  out[4] = 0.0;
  out[5] = -lift * 0.5 - pit * 0.55 - crack * 0.7 + grain * 0.22 + bloom * 0.15;
};

/**
 * The roadway. U runs across the full carriageway exactly once, so the painted
 * lines are geometry-accurate rather than a texture that happens to look like
 * road: double yellow on the centreline, dashed lane whites at the four-metre
 * marks, solid edge lines, and the tyre-polished bands between them.
 */
const roadTexel: TexelFn = (u, v, out) => {
  const agg = worleyT(u, v, 22, 5501);
  const grain = fbmT(u, v, 30, 3, 991);
  const patch = smoothstep(0.62, 0.72, fbmT(u, v, 4, 3, 3307));
  const crack = Math.pow(ridgedT(u, v, 9, 4, 7717), 10);

  // Asphalt, lighter where a repair patch has been laid in.
  let r = 0.115 + grain * 0.075 + agg * 0.030;
  let g = 0.113 + grain * 0.072 + agg * 0.030;
  let b = 0.112 + grain * 0.070 + agg * 0.032;
  r = lerp(r, r * 1.45, patch); g = lerp(g, g * 1.42, patch); b = lerp(b, b * 1.38, patch);

  // Wheel tracks: four polished bands per direction, darker and glossier.
  let polish = 0;
  for (const c of [0.20, 0.30, 0.37, 0.46, 0.54, 0.63, 0.70, 0.80]) polish += band(u, c, 0.018, 0.030);
  polish = Math.min(1, polish) * 0.55;
  r *= 1 - polish * 0.25; g *= 1 - polish * 0.25; b *= 1 - polish * 0.24;

  // Markings. Wear comes from the same noise as the surface, so it agrees.
  const wear = 0.55 + 0.45 * fbmT(u * 2, v, 8, 3, 4243);
  const dash = smoothstep(0.02, 0.06, fract(v * 2)) * smoothstep(0.52, 0.46, fract(v * 2));
  let white = 0;
  for (const c of [0.3333, 0.6667]) white += band(u, c, 0.0035, 0.0045) * dash;
  for (const c of [0.1667, 0.8333]) white += band(u, c, 0.0035, 0.0045) * dash;
  white += band(u, 0.022, 0.0055, 0.005) + band(u, 0.978, 0.0055, 0.005);
  white = clamp01(white) * wear;
  const yellow = clamp01(band(u, 0.4915, 0.0035, 0.004) + band(u, 0.5085, 0.0035, 0.004)) * wear;

  r = lerp(r, 0.84, white); g = lerp(g, 0.83, white); b = lerp(b, 0.78, white);
  r = lerp(r, 0.80, yellow); g = lerp(g, 0.60, yellow); b = lerp(b, 0.13, yellow);

  r -= crack * 0.06; g -= crack * 0.06; b -= crack * 0.06;

  out[0] = r; out[1] = g; out[2] = b;
  out[3] = 0.90 - polish * 0.30 - white * 0.10 - yellow * 0.10 + grain * 0.05;
  out[4] = 0.0;
  out[5] = agg * 0.35 - crack * 0.8 + patch * 0.18 + (white + yellow) * 0.12;
};

/**
 * Curtain wall — precast quartz-aggregate panel with a recessed glazing bay.
 * One tile covers four bays across by four storeys down, so the lit-window
 * lottery has sixteen outcomes before it repeats and the tower never reads as
 * a stamped grid. La Aguja and Mercado Ferry's upper floors both wear it.
 */
const panelTexel: TexelFn = (u, v, out) => {
  const bx = u * PANEL_TILE, by = v * PANEL_TILE;
  const bu = fract(bx), bv = fract(by);
  const bay = Math.floor(bx), flr = Math.floor(by);

  // The glazed opening inside each module.
  const win =
    smoothstep(0.150, 0.185, bu) * smoothstep(0.850, 0.815, bu) *
    smoothstep(0.075, 0.110, bv) * smoothstep(0.720, 0.685, bv);
  // Mullion and transom inside the glass.
  const mull = clamp01(band(bu, 0.5, 0.010, 0.012) + band(bv, 0.40, 0.008, 0.010)) * win;
  const fin = band(bu, 0.0, 0.062, 0.040) + band(bu, 1.0, 0.062, 0.040);
  // Shadow line down the outboard side of every fin — this is what makes a
  // precast facade read as relief rather than as wallpaper.
  const finShade = band(bu, 0.115, 0.030, 0.045) + band(bu, 0.885, 0.030, 0.045);
  const sill = band(bv, 0.735, 0.022, 0.026);

  const speck = worleyT(u, v, 30, 1201);
  const dirt = streakT(u, v, 10, 5077);
  const age = fbmT(u, v, 5, 3, 3313);

  // Panel: warm white quartz aggregate, greyed by rain tracks under the sills.
  let pr = 0.845 + age * 0.085 + speck * 0.045;
  let pg = 0.825 + age * 0.080 + speck * 0.045;
  let pb = 0.775 + age * 0.070 + speck * 0.050;
  const track = smoothstep(0.52, 0.92, dirt) * 0.36;
  pr *= 1 - track * 0.20; pg *= 1 - track * 0.19; pb *= 1 - track * 0.16;
  pr += fin * 0.075 - finShade * 0.085;
  pg += fin * 0.075 - finShade * 0.085;
  pb += fin * 0.075 - finShade * 0.080;
  pr -= sill * 0.13; pg -= sill * 0.13; pb -= sill * 0.12;

  // Glass: deep teal, with a bright sky band across the top of every pane and
  // a per-pane tint — blinds down, lights off, a different decade of glazing.
  // Without it the tower is a stamped grid, which is the loudest amateur tell
  // a skyscraper can have.
  const pane = hash2(bay, flr, 2287);
  const blind = hash2(bay, flr, 6421) < 0.28 ? smoothstep(0.10, 0.45, bv) : 0;
  const skyBand = smoothstep(0.68, 0.30, bv) * (0.55 + 0.9 * pane);
  let gr = 0.040 + skyBand * 0.150 + pane * 0.030;
  let gg = 0.074 + skyBand * 0.205 + pane * 0.040;
  let gb = 0.088 + skyBand * 0.250 + pane * 0.045;
  gr = lerp(gr, 0.46, blind * 0.75); gg = lerp(gg, 0.43, blind * 0.75); gb = lerp(gb, 0.39, blind * 0.75);
  gr += mull * 0.36; gg += mull * 0.35; gb += mull * 0.33;

  out[0] = lerp(pr, gr, win);
  out[1] = lerp(pg, gg, win);
  out[2] = lerp(pb, gb, win);
  out[3] = lerp(0.66 + speck * 0.16 + track * 0.08, lerp(0.075 + blind * 0.55, 0.55, mull), win);
  out[4] = lerp(0.02, lerp(0.82 * (1 - blind * 0.8), 0.15, mull), win);
  out[5] = -win * 0.55 + fin * 0.34 - finShade * 0.10 - sill * 0.25 + speck * 0.10 + mull * 0.20;

  // Night: about two fifths of the offices are still burning, in three warmths.
  const lot = hash2(bay, flr, 8123);
  const lit = lot < 0.42 && blind < 0.6 ? 1 : 0;
  const warmth = hash2(bay, flr, 4451);
  const e = lit * win * (1 - mull * 0.8) * (0.55 + 0.45 * warmth);
  out[6] = e * 1.00;
  out[7] = e * (0.74 + warmth * 0.16);
  out[8] = e * (0.42 + warmth * 0.26);
};

/** Troweled lime stucco, sun-baked and hairline-cracked. Tiles over 3 m. */
const stuccoTexel: TexelFn = (u, v, out) => {
  const trowel = fbmT(u, v, 7, 4, 6151) * 0.62 + fbmT(u, v, 19, 3, 1699) * 0.38;
  // Two scales of patching: whole re-rendered panels, and the sun bleaching
  // whatever it has had longest.
  const patch = fbmT(u, v, 2, 5, 2437);
  const sun = smoothstep(0.40, 0.86, fbmT(u, v, 4, 4, 9109));
  const crack = Math.pow(ridgedT(u, v, 5, 5, 5233), 7);
  const streak = smoothstep(0.42, 0.88, streakT(u, v, 10, 3167));
  // Chips are blown render, not pinpricks. The cell field is domain-warped and
  // the threshold is noisy, so the patches come out ragged; a plain Worley mask
  // here reads as grey polka dots, which is worse than no chips at all.
  const wx = (fbmT(u, v, 5, 3, 111) - 0.5) * 0.14;
  const wy = (fbmT(u, v, 5, 3, 227) - 0.5) * 0.14;
  const chip = smoothstep(0.22 + fbmT(u, v, 24, 3, 3011) * 0.13, 0.03, worleyT(u + wx, v + wy, 6, 8221)) *
    smoothstep(0.56, 0.80, fbmT(u, v, 5, 3, 4177)) * 0.7;

  // Warm ochre with coral undertones — the waterfront palette.
  let r = 0.720 + patch * 0.190 + trowel * 0.090;
  let g = 0.560 + patch * 0.155 + trowel * 0.085;
  let b = 0.385 + patch * 0.120 + trowel * 0.075;
  r += sun * 0.085; g += sun * 0.075; b += sun * 0.085;   // bleached, desaturated
  r *= 1 - streak * 0.22; g *= 1 - streak * 0.23; b *= 1 - streak * 0.18;
  // Chipped render showing the grey scratch coat beneath.
  r = lerp(r, 0.600, chip); g = lerp(g, 0.548, chip); b = lerp(b, 0.462, chip);
  r -= crack * 0.26; g -= crack * 0.23; b -= crack * 0.19;

  out[0] = r; out[1] = g; out[2] = b;
  out[3] = 0.86 + trowel * 0.10 - chip * 0.05 + streak * 0.04;
  out[4] = 0.0;
  out[5] = trowel * 0.45 - crack * 0.9 - chip * 0.7;
};

/** Barrel roof tiles. Eight courses across the tile, lapped every third row. */
const terracottaTexel: TexelFn = (u, v, out) => {
  const col = u * 8;
  const ci = Math.floor(col);
  const cu = fract(col);
  // Half-round pan: bright on the crown, deep shadow in the valley.
  const round = Math.sin(cu * Math.PI);
  const valley = 1 - round;
  const lap = smoothstep(0.05, 0.0, Math.min(fract(v * 5), 1 - fract(v * 5)));
  const tint = hash2(ci, Math.floor(v * 5), 7331);
  const grain = fbmT(u, v, 20, 3, 4127);
  const moss = smoothstep(0.55, 0.95, fbmT(u, v, 7, 4, 8017)) * valley;

  let r = 0.585 + tint * 0.180 + grain * 0.070;
  let g = 0.275 + tint * 0.105 + grain * 0.055;
  let b = 0.175 + tint * 0.070 + grain * 0.045;
  const shade = valley * 0.42 + lap * 0.30;
  r *= 1 - shade; g *= 1 - shade * 0.96; b *= 1 - shade * 0.90;
  r -= moss * 0.14; g -= moss * 0.02; b -= moss * 0.10;

  out[0] = r; out[1] = g; out[2] = b;
  out[3] = 0.80 + grain * 0.12 + moss * 0.06;
  out[4] = 0.0;
  out[5] = round * 0.7 - lap * 0.5 + grain * 0.12;
};

/** Sea-cliff rock: warped bedding, salt fretting, lichen above the splash. */
const rockTexel: TexelFn = (u, v, out) => {
  const warp = fbmT(u, v, 3, 4, 401) - 0.5;
  const bandv = v * 7 + warp * 2.1 + fbmT(u, v, 6, 3, 88) * 0.6;
  const step = Math.floor(bandv);
  const frac = bandv - step;
  const bed = hash2(0, ((step % 7) + 7) % 7, 6101);
  const joint = smoothstep(0.0, 0.08, frac) * smoothstep(1.0, 0.92, frac);
  const fracture = Math.pow(ridgedT(u, v, 5, 4, 733), 6);
  const grit = fbmT(u, v, 32, 3, 12) * 0.6 + worleyT(u, v, 30, 4409) * 0.4;
  const spall = 1 - smoothstep(0.0, 0.30, worleyT(u, v, 9, 1777));
  const lichen = smoothstep(0.58, 0.92, fbmT(u, v, 9, 4, 5623));
  const h = bed * 0.62 + joint * 0.32 + grit * 0.24 - fracture * 0.55 - spall * 0.30;

  // Warm ochre sandstone with iron in the beds, greened by salt-tolerant lichen.
  let r = 0.300 + h * 0.52 + grit * 0.10;
  let g = 0.264 + h * 0.45 + grit * 0.085;
  let b = 0.212 + h * 0.35 + grit * 0.070;
  r -= spall * 0.05; g -= spall * 0.05; b -= spall * 0.04;
  const iron = smoothstep(0.55, 0.95, fbmT(u, v * 3, 3, 4, 271));
  r += iron * 0.18; g += iron * 0.06; b -= iron * 0.02;
  r -= lichen * 0.06; g -= lichen * 0.00; b -= lichen * 0.07;
  g += lichen * 0.05;

  out[0] = r; out[1] = g; out[2] = b;
  out[3] = 0.90 - h * 0.12 + grit * 0.06;
  out[4] = 0.0;
  out[5] = h;
};

/* ------------------------------------------------------------------------ *
 * Geometry builders
 * ------------------------------------------------------------------------ */

/**
 * A section point. `u` is the texture coordinate around the profile, in metres
 * before scaling. `brk` means "emit no face between me and the next point" —
 * that is how a section gets hard corners: duplicate the corner vertex so the
 * two faces cannot share (and therefore cannot average) a normal.
 */
interface SecPt { x: number; z: number; u: number; brk?: boolean }
interface Section { pts: SecPt[]; cap: { x: number; z: number }[] }

/** Section point for the along-Z sweeps: XY profile, walked clockwise. */
interface ZPt { x: number; y: number; u: number; brk?: boolean }

interface StationY { y: number; s: number; sz?: number; dx?: number; dz?: number }
interface StationZ { z: number; y: number; s?: number }

/**
 * Extrude a section up a stack of tapering stations. Sections are walked with
 * increasing angle about +Y, which is the winding that yields outward normals.
 */
function sweepY(
  sec: Section,
  stations: StationY[],
  opts: { uScale?: number; vScale?: number; capTop?: boolean; capBottom?: boolean; scaleU?: boolean } = {},
): THREE.BufferGeometry {
  const n = sec.pts.length;
  const m = stations.length;
  const uScale = opts.uScale ?? 1;
  const vScale = opts.vScale ?? 1;
  const scaleU = opts.scaleU !== false;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];

  for (let j = 0; j < m; j++) {
    const st = stations[j];
    const sz = st.sz ?? st.s;
    const dx = st.dx ?? 0, dz = st.dz ?? 0;
    for (let i = 0; i < n; i++) {
      const p = sec.pts[i];
      pos.push(p.x * st.s + dx, st.y, p.z * sz + dz);
      uv.push(p.u * (scaleU ? st.s : 1) * uScale, st.y * vScale);
    }
  }
  for (let j = 0; j < m - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      if (sec.pts[i].brk) continue;
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  // Caps are triangle fans from the centroid; every section here is star-shaped
  // about its own centre, so a fan is always valid.
  const addCap = (st: StationY, up: boolean) => {
    const sz = st.sz ?? st.s;
    const dx = st.dx ?? 0, dz = st.dz ?? 0;
    const base = pos.length / 3;
    pos.push(dx, st.y, dz);
    uv.push(0, st.y * vScale);
    for (const c of sec.cap) {
      pos.push(c.x * st.s + dx, st.y, c.z * sz + dz);
      uv.push(c.x * st.s * uScale * 0.5, c.z * sz * uScale * 0.5);
    }
    const k = sec.cap.length;
    for (let i = 0; i < k; i++) {
      const a = base + 1 + i, b = base + 1 + ((i + 1) % k);
      if (up) idx.push(base, b, a);
      else idx.push(base, a, b);
    }
  };
  if (opts.capBottom) addCap(stations[0], false);
  if (opts.capTop) addCap(stations[m - 1], true);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Extrude a section along Z, with a per-station vertical offset. Sections are
 * walked clockwise in XY, which is the winding that yields outward normals.
 * This is the whole bridge deck: roadway, kerbs, truss shell, barrier, cables.
 */
function sweepZ(
  section: ZPt[],
  stations: StationZ[],
  opts: { uScale?: number; vScale?: number; uAbsolute?: boolean } = {},
): THREE.BufferGeometry {
  const n = section.length;
  const m = stations.length;
  const uScale = opts.uScale ?? 1;
  const vScale = opts.vScale ?? 1;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];

  for (let j = 0; j < m; j++) {
    const st = stations[j];
    const s = st.s ?? 1;
    for (let i = 0; i < n; i++) {
      const p = section[i];
      pos.push(p.x * s, st.y + p.y, st.z);
      uv.push(p.u * uScale, st.z * vScale);
    }
  }
  for (let j = 0; j < m - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      if (section[i].brk) continue;
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Rectangular section with hard corners and per-face U. */
function rectSection(hx: number, hz: number): Section {
  const c = [
    { x: hx, z: hz }, { x: -hx, z: hz }, { x: -hx, z: -hz }, { x: hx, z: -hz },
  ];
  const pts: SecPt[] = [];
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    pts.push({ x: a.x, z: a.z, u: 0 });
    pts.push({ x: b.x, z: b.z, u: len, brk: true });
  }
  pts[pts.length - 1].brk = false; // the final point closes the loop, no face after
  return { pts, cap: c };
}

/**
 * Fluted rectangle — a rectangle whose faces carry vertical ribs. Art-deco
 * bridge towers and the pyramid's shaft both live off this: the ribs are what
 * catch a low sun and give a 190 m surface something to shade with.
 */
function flutedRect(hx: number, hz: number, ribs: number, depth: number): Section {
  const corners = [
    { x: hx, z: hz }, { x: -hx, z: hz }, { x: -hx, z: -hz }, { x: hx, z: -hz },
  ];
  const pts: SecPt[] = [];
  const cap: { x: number; z: number }[] = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    // Outward normal of this face, in XZ.
    const nx = (b.z - a.z) / len, nz = -(b.x - a.x) / len;
    const steps = Math.max(2, ribs * 2);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      // Cosine ribs, pinned flat at the corners so the mitre stays crisp.
      const rib = Math.pow(Math.sin(t * Math.PI), 0.35) * (0.5 - 0.5 * Math.cos(t * ribs * Math.PI * 2));
      const x = lerp(a.x, b.x, t) + nx * rib * depth;
      const z = lerp(a.z, b.z, t) + nz * rib * depth;
      pts.push({ x, z, u: t * len, brk: s === steps });
      cap.push({ x, z });
    }
  }
  pts[pts.length - 1].brk = false;
  return { pts, cap };
}

/** Smooth ring, optionally fluted. Lighthouses, tanks, the Torre Palma shaft. */
function circleSection(radius: number, segments: number, flutes = 0, depth = 0): Section {
  const pts: SecPt[] = [];
  const cap: { x: number; z: number }[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const a = t * Math.PI * 2;
    const r = radius + (flutes > 0 ? -depth * (0.5 - 0.5 * Math.cos(a * flutes)) : 0);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    pts.push({ x, z, u: t * Math.PI * 2 * radius });
    if (i < segments) cap.push({ x, z });
  }
  return { pts, cap };
}

/**
 * Re-tile UVs from object-space position and normal. Box, cylinder and lathe
 * primitives all arrive with 0..1 face UVs, which stretch a 3 m concrete map
 * across a 40 m pier; this gives every merged primitive the same texel density
 * whatever its size, and neighbouring boxes line up because the projection is
 * shared.
 */
function retile(geo: THREE.BufferGeometry, tile: number): THREE.BufferGeometry {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  if (!pos || !nrm) return geo;
  const uv = new Float32Array(pos.count * 2);
  const inv = 1 / tile;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i)), nz = Math.abs(nrm.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u: number, v: number;
    if (nx >= ny && nx >= nz) { u = z; v = y; }
    else if (ny >= nz) { u = x; v = z; }
    else { u = x; v = y; }
    uv[i * 2] = u * inv;
    uv[i * 2 + 1] = v * inv;
  }
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

/** Scale existing UVs in place — for ExtrudeGeometry, whose UVs are in metres. */
function scaleUV(geo: THREE.BufferGeometry, s: number): THREE.BufferGeometry {
  const uv = geo.attributes.uv as THREE.BufferAttribute | undefined;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s);
  uv.needsUpdate = true;
  return geo;
}

/** An axis-aligned box, world-placed and world-tiled, ready to merge. */
function boxAt(
  cx: number, cy: number, cz: number,
  w: number, h: number, d: number,
  tile: number,
  rotY = 0,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotY) g.rotateY(rotY);
  g.translate(cx, cy, cz);
  return retile(g, tile);
}

/** Merge a pile of geometries into one buffer, tolerating an empty list. */
function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!list.length) return null;
  const flat = list.map((g) => (g.index ? g.toNonIndexed() : g));
  if (flat.length === 1) return flat[0];
  const merged = mergeGeometries(flat, false);
  for (const g of flat) g.dispose();
  return merged ?? null;
}

/**
 * A wall panel with an arched opening cut clean through it. Real geometry, not
 * a texture: the Mercado arcade, the Torre Palma crown and the bridge's tunnel
 * portal all need the light to actually pass through the hole. The panel's
 * front face lies at z = 0 and looks down -Z.
 */
function archPanel(
  w: number, h: number, openW: number, springH: number, depth: number, segments: number,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(w / 2, h);
  shape.lineTo(-w / 2, h);
  shape.closePath();

  const r = openW / 2;
  const hole = new THREE.Path();
  hole.moveTo(-r, 0);
  hole.lineTo(-r, springH);
  hole.absarc(0, springH, r, Math.PI, 0, true);
  hole.lineTo(r, 0);
  hole.closePath();
  shape.holes.push(hole);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    curveSegments: segments,
  });
  geo.translate(0, 0, -depth);
  return geo;
}

/* ------------------------------------------------------------------------ *
 * Instancing helpers
 * ------------------------------------------------------------------------ */

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/**
 * Map a unit Y-cylinder (height 1, radius 1, centred on the origin) onto the
 * segment from `a` to `b`. Suspender ropes, tower bracing, water-tower legs and
 * jetty piles are all this one call.
 */
function segmentMatrix(out: THREE.Matrix4, a: THREE.Vector3, b: THREE.Vector3, radius: number): THREE.Matrix4 {
  _dir.subVectors(b, a);
  const len = _dir.length();
  if (len < 1e-5) return out.identity();
  _quat.setFromUnitVectors(_up, _dir.divideScalar(len));
  _mid.addVectors(a, b).multiplyScalar(0.5);
  return out.compose(_mid, _quat, _scale.set(radius, len, radius));
}

function makeInstanced(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  mats: THREE.Matrix4[],
  shadows = true,
): THREE.InstancedMesh | null {
  if (!mats.length) return null;
  const im = new THREE.InstancedMesh(geo, mat, mats.length);
  for (let i = 0; i < mats.length; i++) im.setMatrixAt(i, mats[i]);
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = shadows;
  im.receiveShadow = true;
  im.computeBoundingSphere();
  return im;
}

/* ------------------------------------------------------------------------ *
 * The shared kit every landmark builder is handed
 * ------------------------------------------------------------------------ */

interface Mats {
  steel: THREE.MeshStandardMaterial;
  steelDark: THREE.MeshStandardMaterial;
  road: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  concretePale: THREE.MeshStandardMaterial;
  concreteWarm: THREE.MeshStandardMaterial;
  panel: THREE.MeshStandardMaterial;
  stucco: THREE.MeshStandardMaterial;
  stuccoCoral: THREE.MeshStandardMaterial;
  terracotta: THREE.MeshStandardMaterial;
  rock: THREE.MeshStandardMaterial;
  /** Unlit interiors seen through openings; glows at night. */
  interior: THREE.MeshStandardMaterial;
  /** Lamp globes, lantern rooms, warning beacons. */
  lamp: THREE.MeshStandardMaterial;
  beacon: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
}

interface NightMat {
  mat: THREE.MeshStandardMaterial;
  day: number;
  night: number;
}

/**
 * Lowest and highest ground under a rectangular footprint. Anything that meets
 * the ground over a wide span — a plaza, a quay, a terrace — has to know both:
 * the high point sets the finished level, the low point says how far the
 * foundation must reach before it stops being a slab hanging in the air.
 */
function groundRange(
  ground: (x: number, z: number) => number,
  ox: number, oz: number, hx: number, hz: number, n = 5,
): { lo: number; hi: number } {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const g = ground(ox + lerp(-hx, hx, i / n), oz + lerp(-hz, hz, j / n));
      if (!isFinite(g)) continue;
      if (g < lo) lo = g;
      if (g > hi) hi = g;
    }
  }
  return { lo: isFinite(lo) ? lo : 0, hi: isFinite(hi) ? hi : 0 };
}

interface Kit {
  ctx: WorldCtx;
  rng: () => number;
  tier: Tier;
  mats: Mats;
  night: NightMat[];
  /** Terrain height in WORLD coordinates, with an atlas fallback. */
  ground(x: number, z: number): number;
  /** Register a world-space collider. */
  collide(min: THREE.Vector3, max: THREE.Vector3, tag: string, climbable?: boolean): void;
  /** Detail groups that switch off past `tier.detailRange`. */
  detail: THREE.Object3D[];
}

/** One landmark's scene node plus the bits the system has to drive per frame. */
interface Built {
  group: THREE.Group;
}

/* ------------------------------------------------------------------------ *
 * Puente Dorado — the suspension bridge
 * ------------------------------------------------------------------------ */
//
// Geometry, all in local coordinates about the atlas anchor (-880, -1080):
// the strait runs north-south, so the bridge runs north-south too, along local
// Z, with the towers standing in open water 600 m apart. Everything past the
// towers is surveyed against the terrain at boot rather than hard-coded.

const HALF_SPAN = 300;          // tower to mid-span, metres
const DECK_CROWN = 70;          // deck height at mid-span, metres above sea
const DECK_AT_TOWER = 64;
const TOWER_TOP = 176;          // above sea level
const SADDLE_Y = 171;           // where the main cable crosses the tower
const CABLE_LOW = 78;           // main cable at mid-span
const NORTH_GRADE = 0.07;       // approach descent, 7% — steep, but it lands
const SOUTH_GRADE = 0.02;
const DECK_HALF = 13.2;
const ROAD_HALF = 11.0;
const TRUSS_DEPTH = 6.6;
/**
 * Cable plane and tower leg centreline. Set so the leg's inner face clears the
 * carriageway with 500 mm to spare: the sidewalks then run *into* the tower and
 * out the far side, which is exactly what the Golden Gate does, rather than
 * clipping through it.
 */
const LEG_X = 14.6;
const CABLE_R = 0.62;

/**
 * The tower leg's tapering profile, absolute Y. Three stepped shoulders — the
 * deco setbacks — and a cornice under the cable saddle. `legHalfAt` reads this
 * back so the portal struts always meet the legs whatever height they sit at.
 */
const TOWER_LEG: { y: number; sx: number; sz: number }[] = [
  { y: 7.5, sx: 3.30, sz: 6.60 },
  { y: 26, sx: 3.18, sz: 6.25 },
  { y: 55, sx: 3.08, sz: 5.95 },
  { y: 55.6, sx: 3.28, sz: 6.20 },
  { y: 57, sx: 2.98, sz: 5.78 },
  { y: 96, sx: 2.82, sz: 5.35 },
  { y: 96.6, sx: 3.00, sz: 5.60 },
  { y: 98, sx: 2.70, sz: 5.18 },
  { y: 134, sx: 2.52, sz: 4.72 },
  { y: 134.6, sx: 2.70, sz: 4.96 },
  { y: 136, sx: 2.42, sz: 4.55 },
  { y: 164, sx: 2.26, sz: 4.20 },
  { y: 165, sx: 2.46, sz: 4.48 },
  { y: TOWER_TOP - 4, sx: 2.14, sz: 3.95 },
  { y: TOWER_TOP - 3.2, sx: 2.32, sz: 4.20 },
  { y: TOWER_TOP, sx: 1.90, sz: 3.50 },
];

/** Half-width of a tower leg in X at an absolute height. */
function legHalfAt(y: number): number {
  if (y <= TOWER_LEG[0].y) return TOWER_LEG[0].sx;
  for (let i = 1; i < TOWER_LEG.length; i++) {
    if (y <= TOWER_LEG[i].y) {
      const a = TOWER_LEG[i - 1], b = TOWER_LEG[i];
      return lerp(a.sx, b.sx, (y - a.y) / Math.max(1e-3, b.y - a.y));
    }
  }
  return TOWER_LEG[TOWER_LEG.length - 1].sx;
}

/** Clear span between the two legs at a height, with a little bury at each end. */
function braceWidth(y: number): number {
  return (LEG_X - legHalfAt(y)) * 2 + 1.6;
}

/** Deck elevation at a local Z. Parabolic crown between the towers. */
function deckY(z: number): number {
  if (z < -HALF_SPAN) return DECK_AT_TOWER - NORTH_GRADE * (-HALF_SPAN - z);
  if (z > HALF_SPAN) return DECK_AT_TOWER - SOUTH_GRADE * (z - HALF_SPAN);
  const t = z / HALF_SPAN;
  return DECK_CROWN - (DECK_CROWN - DECK_AT_TOWER) * t * t;
}

/** Main cable elevation over the main span — the parabola of a loaded cable. */
function mainCableY(z: number): number {
  const t = z / HALF_SPAN;
  return CABLE_LOW + (SADDLE_Y - CABLE_LOW) * t * t;
}

/** Side-span cable: a straight backstay with a tenth of the span's sag in it. */
function sideCableY(t: number, yTower: number, yAnchor: number, span: number): number {
  return lerp(yTower, yAnchor, t) - span * 0.055 * 4 * t * (1 - t);
}

function buildBridge(kit: Kit, ox: number, oz: number): Built {
  const { mats, tier } = kit;
  const group = new THREE.Group();
  group.name = "palmas:puente-dorado";
  group.position.set(ox, 0, oz);

  const gnd = (z: number, x = 0) => kit.ground(ox + x, oz + z);

  // --- Survey ---------------------------------------------------------------
  // South: march until the Presidio headland rises through the deck. That is
  // where the roadway has to enter the rock, so that is where the portal goes.
  let southEnd = HALF_SPAN + 150;
  for (let z = HALF_SPAN + 10; z < HALF_SPAN + 190; z += 3) {
    if (gnd(z) > deckY(z) - 2.0) { southEnd = z; break; }
  }
  // North: find the shoreline, set the anchorage back from it on dry land,
  // then run the approach viaduct down until the deck meets the ground.
  let northShore = -HALF_SPAN - 110;
  for (let z = -HALF_SPAN - 20; z > -HALF_SPAN - 400; z -= 5) {
    if (gnd(z) > SEA_LEVEL + 2.5) { northShore = z; break; }
  }
  const anchorZ = northShore - 105;
  // Run past the landfall until the deck is a clear metre *under* the ground,
  // so the roadway disappears into the hillside instead of stopping dead in a
  // 2 m lip that the player can see the underside of.
  let northEnd = anchorZ - 400;
  for (let z = anchorZ - 40; z > anchorZ - 950; z -= 8) {
    if (deckY(z) <= gnd(z) - 1.2) { northEnd = z; break; }
  }

  const steelGeo: THREE.BufferGeometry[] = [];
  const concGeo: THREE.BufferGeometry[] = [];
  const cableGeo: THREE.BufferGeometry[] = [];

  // --- Deck stations --------------------------------------------------------
  const stations: StationZ[] = [];
  {
    const step = 12;
    for (let z = northEnd; z < southEnd; z += step) stations.push({ z, y: deckY(z) });
    stations.push({ z: southEnd, y: deckY(southEnd) });
  }

  // Roadway: a two-lane-each-way carriageway with a slight crown so rain runs
  // off it. U spans the painted width exactly once — see `roadTexel`.
  const roadSection: ZPt[] = [
    { x: -ROAD_HALF, y: 0.0, u: 0 },
    { x: -ROAD_HALF * 0.5, y: 0.10, u: 0.25 },
    { x: 0, y: 0.14, u: 0.5 },
    { x: ROAD_HALF * 0.5, y: 0.10, u: 0.75 },
    { x: ROAD_HALF, y: 0.0, u: 1 },
  ];
  const road = new THREE.Mesh(sweepZ(roadSection, stations, { vScale: 1 / 26 }), mats.road);
  road.castShadow = false;
  road.receiveShadow = true;
  group.add(road);

  // Sidewalks and kerbs, both sides. Human scale: a 2.2 m walkway with a
  // 200 mm kerb is the thing that tells the eye how big the towers are.
  for (const s of [-1, 1]) {
    const walk: ZPt[] = s < 0
      ? [
        { x: -DECK_HALF, y: 0.34, u: 0 },
        { x: -ROAD_HALF - 0.35, y: 0.34, u: 2.5 },
        { x: -ROAD_HALF - 0.35, y: 0.0, u: 2.9 },
        { x: -ROAD_HALF + 0.15, y: 0.0, u: 3.4 },
      ]
      : [
        { x: ROAD_HALF - 0.15, y: 0.0, u: 0 },
        { x: ROAD_HALF + 0.35, y: 0.0, u: 0.5 },
        { x: ROAD_HALF + 0.35, y: 0.34, u: 0.9 },
        { x: DECK_HALF, y: 0.34, u: 3.4 },
      ];
    concGeo.push(sweepZ(walk, stations, { uScale: 1 / 2.6, vScale: 1 / 2.6 }));
  }

  // Jersey barrier down the centreline.
  const barrier: ZPt[] = [
    { x: -0.55, y: 0.14, u: 0 },
    { x: -0.40, y: 1.00, u: 0.9 },
    { x: 0.40, y: 1.00, u: 1.7 },
    { x: 0.55, y: 0.14, u: 2.6 },
  ];
  concGeo.push(sweepZ(barrier, stations, { uScale: 1 / 2.6, vScale: 1 / 2.6 }));

  // Stiffening truss shell — fascia, haunch and soffit, walked clockwise in XY
  // so its normals face out of the deck box.
  const truss: ZPt[] = [
    { x: DECK_HALF, y: 0.34, u: 0 },
    { x: DECK_HALF, y: -1.6, u: 2.0 },
    { x: DECK_HALF - 1.7, y: -TRUSS_DEPTH, u: 7.2 },
    { x: -(DECK_HALF - 1.7), y: -TRUSS_DEPTH, u: 30.2 },
    { x: -DECK_HALF, y: -1.6, u: 35.4 },
    { x: -DECK_HALF, y: 0.34, u: 37.4 },
  ];
  steelGeo.push(sweepZ(truss, stations, { uScale: 1 / 4, vScale: 1 / 4 }));

  // Railings: two rails and a kick plate, swept; posts instanced below.
  for (const s of [-1, 1]) {
    for (const ry of [0.55, 1.02, 1.34]) {
      const t = ry > 1.2 ? 0.075 : 0.055;
      const x = s * (DECK_HALF - 0.30);
      steelGeo.push(sweepZ(
        [
          { x: x - t, y: ry + t, u: 0 },
          { x: x + t, y: ry + t, u: 2 * t },
          { x: x + t, y: ry - t, u: 4 * t },
          { x: x - t, y: ry - t, u: 6 * t },
          { x: x - t, y: ry + t, u: 8 * t },
        ],
        stations, { uScale: 1 / 4, vScale: 1 / 4 },
      ));
    }
  }

  // --- Towers ---------------------------------------------------------------
  const towerZ = [-HALF_SPAN, HALF_SPAN];
  for (const tz of towerZ) {
    const seabed = Math.min(gnd(tz), SEA_LEVEL - 2);
    // Caisson: a battered concrete island carrying both legs, with a wave
    // apron so it does not read as a box dropped in the sea.
    const pierTop = 9;
    const pier = sweepY(
      rectSection(1, 1),
      [
        { y: seabed - 4, s: 30, sz: 19 },
        { y: SEA_LEVEL - 3, s: 27, sz: 17 },
        { y: SEA_LEVEL + 1.6, s: 25.5, sz: 16 },
        { y: pierTop - 2.4, s: 24, sz: 15 },
        { y: pierTop, s: 23.2, sz: 14.4 },
      ],
      { uScale: 1 / 3.2, vScale: 1 / 3.2, capTop: true, scaleU: true },
    );
    pier.translate(0, 0, tz);
    concGeo.push(pier);
    kit.collide(
      new THREE.Vector3(ox - 24, seabed - 4, oz + tz - 15),
      new THREE.Vector3(ox + 24, pierTop, oz + tz + 15),
      "bridge-pier",
    );

    for (const s of [-1, 1]) {
      const lx = s * LEG_X;
      // Art-deco leg: fluted, tapering, with three stepped shoulders. The
      // steps are what make the silhouette read deco instead of industrial.
      const leg = sweepY(
        flutedRect(1, 1, 3, 0.16),
        TOWER_LEG.map((st, i) => ({ y: i === 0 ? pierTop - 1.5 : st.y, s: st.sx, sz: st.sz })),
        { uScale: 1 / 4, vScale: 1 / 4, capTop: true, scaleU: true },
      );
      leg.translate(lx, 0, tz);
      steelGeo.push(leg);

      // Cable saddle housing where the main cable crosses the leg.
      steelGeo.push(boxAt(lx, SADDLE_Y + 1.2, tz, 6.4, 4.6, 9.0, 4));
      // Sidewalk portal: the walkway runs through the leg, so give it a mouth.
      const dY = deckY(tz);
      steelGeo.push(boxAt(
        lx - s * (legHalfAt(dY) - 0.35), dY + 1.5, tz,
        0.9, 3.6, 3.2, 4,
      ));
      kit.collide(
        new THREE.Vector3(ox + lx - 3.6, pierTop, oz + tz - 7),
        new THREE.Vector3(ox + lx + 3.6, TOWER_TOP, oz + tz + 7),
        "bridge-tower",
      );
    }

    // Portal struts between the legs: a deco cross-brace stack, plus the deep
    // portal beam the roadway passes under. Widths come off the leg taper, so
    // no strut can ever end in mid-air.
    for (const by of [30, 78, 118, 152]) {
      const w = braceWidth(by);
      steelGeo.push(boxAt(0, by, tz, w, 3.4, 5.2, 4));
      steelGeo.push(boxAt(0, by + 1.9, tz, w * 0.62, 1.1, 5.4, 4));
      if (tier.detail) {
        // Chevron infill under each strut — deco, and it breaks the void up.
        for (let k = -1; k <= 1; k++) {
          const g = new THREE.BoxGeometry(w * 0.30, 1.0, 4.6);
          g.rotateZ(k === 0 ? 0 : (k * Math.PI) / 8);
          g.translate(k * w * 0.30, by - 2.6 - Math.abs(k) * 0.6, tz);
          steelGeo.push(retile(g, 4));
        }
      }
    }
    // Portal beam framing the roadway, above and below the deck.
    const dy = deckY(tz);
    steelGeo.push(boxAt(0, dy + 9.4, tz, braceWidth(dy + 9.4), 4.2, 6.4, 4));
    steelGeo.push(boxAt(0, dy - TRUSS_DEPTH - 1.4, tz, braceWidth(dy), 2.6, 6.0, 4));
  }

  // --- Anchorages -----------------------------------------------------------
  const anchorY = deckY(anchorZ);
  const anchorGround = gnd(anchorZ);
  for (const s of [-1, 1]) {
    const ax = s * (LEG_X + 4.5);
    const block = sweepY(
      rectSection(1, 1),
      [
        { y: Math.min(anchorGround, anchorY) - 22, s: 13, sz: 19 },
        { y: anchorY - 4, s: 11, sz: 16 },
        { y: anchorY + 9, s: 9, sz: 13 },
        { y: anchorY + 11.5, s: 9.8, sz: 13.8 },
      ],
      { uScale: 1 / 3.2, vScale: 1 / 3.2, capTop: true, scaleU: true },
    );
    block.translate(ax, 0, anchorZ);
    concGeo.push(block);
    kit.collide(
      new THREE.Vector3(ox + ax - 11, anchorGround - 4, oz + anchorZ - 16),
      new THREE.Vector3(ox + ax + 11, anchorY + 11.5, oz + anchorZ + 16),
      "bridge-anchor",
    );
  }

  // South anchorage, up on the headland behind the portal.
  const sAnchorZ = southEnd + 46;
  const sAnchorG = gnd(sAnchorZ);
  const sAnchorY = Math.max(sAnchorG + 10, deckY(southEnd) + 30);
  for (const s of [-1, 1]) {
    const ax = s * (LEG_X + 3);
    const block = sweepY(
      rectSection(1, 1),
      [
        { y: sAnchorG - 26, s: 13, sz: 18 },
        { y: sAnchorY - 8, s: 11, sz: 15 },
        { y: sAnchorY, s: 9.4, sz: 12.6 },
        { y: sAnchorY + 2.4, s: 10.2, sz: 13.4 },
      ],
      { uScale: 1 / 3.2, vScale: 1 / 3.2, capTop: true, scaleU: true },
    );
    block.translate(ax, 0, sAnchorZ);
    concGeo.push(block);
  }

  // --- Main cables and suspenders -------------------------------------------
  const cableSection: ZPt[] = [];
  {
    const seg = Math.max(8, Math.round(tier.radial * 0.5));
    for (let i = 0; i <= seg; i++) {
      const a = -(i / seg) * Math.PI * 2;           // clockwise in XY = outward
      cableSection.push({
        x: Math.cos(a) * CABLE_R,
        y: Math.sin(a) * CABLE_R,
        u: (i / seg) * Math.PI * 2 * CABLE_R,
      });
    }
  }
  const suspenders: THREE.Matrix4[] = [];
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _m = new THREE.Matrix4();

  const cableRun = (
    from: number, to: number, yAt: (z: number) => number, hang: boolean,
  ) => {
    const stns: StationZ[] = [];
    const n = Math.max(6, Math.ceil(Math.abs(to - from) / 10));
    for (let i = 0; i <= n; i++) {
      const z = lerp(from, to, i / n);
      stns.push({ z, y: yAt(z) });
    }
    for (const s of [-1, 1]) {
      const g = sweepZ(cableSection, stns, { uScale: 1 / 1.5, vScale: 1 / 1.5 });
      g.translate(s * LEG_X, 0, 0);
      cableGeo.push(g);
    }
    if (!hang) return;
    const step = tier.suspender;
    for (let z = Math.min(from, to) + step * 0.5; z < Math.max(from, to); z += step) {
      const cy = yAt(z);
      const dy = cy - deckY(z);
      if (dy < 3.2) continue;
      for (const s of [-1, 1]) {
        _a.set(s * LEG_X, cy - CABLE_R * 0.4, z);
        _b.set(s * (DECK_HALF - 0.30), deckY(z) + 1.5, z);
        suspenders.push(segmentMatrix(new THREE.Matrix4(), _a, _b, 0.11));
      }
    }
  };

  cableRun(-HALF_SPAN, HALF_SPAN, mainCableY, true);
  {
    const span = -HALF_SPAN - anchorZ;
    cableRun(anchorZ, -HALF_SPAN, (z) => sideCableY((z - anchorZ) / span, anchorY + 10, SADDLE_Y, span), true);
  }
  {
    const span = sAnchorZ - HALF_SPAN;
    cableRun(HALF_SPAN, sAnchorZ, (z) => sideCableY((z - HALF_SPAN) / span, SADDLE_Y, sAnchorY + 1.5, span), true);
  }

  const susGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  const susMesh = makeInstanced(susGeo, mats.steelDark, suspenders, false);
  if (susMesh) group.add(susMesh);

  // --- Railing posts, lamp standards, truss bracing -------------------------
  const posts: THREE.Matrix4[] = [];
  const lampBodies: THREE.Matrix4[] = [];
  const lampHeads: THREE.Matrix4[] = [];
  const braces: THREE.Matrix4[] = [];
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    let lampFlip = 1;
    for (let z = northEnd + 4; z < southEnd; z += tier.railPost) {
      const y = deckY(z);
      for (const s of [-1, 1]) {
        posts.push(m.clone().compose(
          new THREE.Vector3(s * (DECK_HALF - 0.30), y + 0.34, z), q, one,
        ));
      }
    }
    for (let z = northEnd + 20; z < southEnd; z += 44) {
      const y = deckY(z);
      lampFlip = -lampFlip;
      const x = lampFlip * (DECK_HALF - 1.05);
      lampBodies.push(m.clone().compose(
        new THREE.Vector3(x, y + 0.34, z), q.setFromAxisAngle(_up, lampFlip > 0 ? 0 : Math.PI), one,
      ));
      lampHeads.push(m.clone().compose(
        new THREE.Vector3(x - lampFlip * 1.5, y + 7.9, z), new THREE.Quaternion(), one,
      ));
    }
    if (tier.detail) {
      for (let z = northEnd + 6; z < southEnd; z += 12) {
        const y = deckY(z) - TRUSS_DEPTH + 0.6;
        _a.set(-DECK_HALF + 2, y, z);
        _b.set(DECK_HALF - 2, y + 0.001, z);
        braces.push(segmentMatrix(new THREE.Matrix4(), _a, _b, 0.30));
      }
    }
  }

  // A railing post is a stanchion with a foot plate — 36 triangles, and it is
  // the single strongest scale cue on the whole bridge.
  const postGeo = mergeAll([
    boxAt(0, 0.72, 0, 0.16, 1.44, 0.16, 2),
    boxAt(0, 0.05, 0, 0.42, 0.10, 0.42, 2),
  ]);
  if (postGeo) {
    const pm = makeInstanced(postGeo, mats.steel, posts, false);
    if (pm) { group.add(pm); kit.detail.push(pm); }
  }

  const lampGeo = mergeAll([
    boxAt(0, 3.8, 0, 0.30, 7.6, 0.30, 2),
    boxAt(0, 0.28, 0, 0.62, 0.56, 0.62, 2),
    boxAt(-0.8, 7.56, 0, 1.7, 0.26, 0.26, 2),
    boxAt(-1.5, 7.34, 0, 0.5, 0.5, 0.5, 2),
  ]);
  if (lampGeo) {
    const lm = makeInstanced(lampGeo, mats.steel, lampBodies, false);
    if (lm) { group.add(lm); kit.detail.push(lm); }
    const headGeo = new THREE.SphereGeometry(0.34, 8, 6);
    const hm = makeInstanced(headGeo, mats.lamp, lampHeads, false);
    if (hm) { hm.castShadow = false; group.add(hm); kit.detail.push(hm); }
  }

  if (braces.length) {
    const braceGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    const bm = makeInstanced(braceGeo, mats.steelDark, braces, false);
    if (bm) { group.add(bm); kit.detail.push(bm); }
  }

  // --- North approach viaduct -----------------------------------------------
  const cols: THREE.Matrix4[] = [];
  const caps: THREE.Matrix4[] = [];
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let z = anchorZ - 42; z > northEnd + 18; z -= 42) {
      const g = gnd(z);
      const top = deckY(z) - TRUSS_DEPTH - 1.2;
      const h = top - (g - 3);
      if (h < 3) continue;
      for (const s of [-1, 1]) {
        cols.push(m.clone().compose(
          new THREE.Vector3(s * 7.5, (g - 3 + top) * 0.5, z), q, new THREE.Vector3(1, h, 1),
        ));
      }
      caps.push(m.clone().compose(new THREE.Vector3(0, top + 0.9, z), q, new THREE.Vector3(1, 1, 1)));
    }
  }
  {
    // A tapered pier column: unit height, so one instance matrix does the rest.
    const colGeo = sweepY(
      rectSection(1, 1),
      [{ y: -0.5, s: 2.3, sz: 1.9 }, { y: 0.2, s: 1.9, sz: 1.6 }, { y: 0.5, s: 1.75, sz: 1.5 }],
      { uScale: 1 / 3.2, vScale: 1 / 3.2, scaleU: false },
    );
    const cm = makeInstanced(colGeo, mats.concrete, cols);
    if (cm) group.add(cm);
    const capGeo = mergeAll([
      boxAt(0, 0, 0, 22, 1.8, 5.0, 3.2),
      boxAt(0, -1.5, 0, 17, 1.6, 4.2, 3.2),
    ]);
    if (capGeo) {
      const capm = makeInstanced(capGeo, mats.concrete, caps);
      if (capm) group.add(capm);
    }
  }

  // --- Tunnel portal, south --------------------------------------------------
  // The Presidio headland ends in a near-vertical wall, so the roadway does not
  // climb onto it — it drives straight into it. What the player sees is a
  // deco-arched abutment rising out of the strait at the cliff foot with the
  // deck disappearing through the arch, which is what the Golden Gate does at
  // Fort Point. The mass below the springing has to reach the seabed, or the
  // facade hangs fifty metres over open water.
  {
    const py = deckY(southEnd);
    const faceZ = southEnd - 4;
    const springY = py - TRUSS_DEPTH - 2;
    const seabed = Math.min(gnd(faceZ), SEA_LEVEL) - 8;

    concGeo.push(boxAt(0, (seabed + springY) * 0.5, faceZ + 8, 46, springY - seabed, 16, 3.2));
    const face = archPanel(46, 40, 26.4, 20, 16, 10);
    face.translate(0, springY, faceZ + 16);
    concGeo.push(retile(face, 3.2));
    // Wing walls, battered back into the cliff.
    for (const s of [-1, 1]) {
      concGeo.push(boxAt(s * 27, py - 6, faceZ + 24, 10, 52, 30, 3.2));
    }
    // Cutwater at the foot, so the sea meets a shaped mass and not a slab end.
    concGeo.push(boxAt(0, seabed + 6, faceZ - 3, 34, 12, 10, 3.2, Math.PI / 4));
    kit.collide(
      new THREE.Vector3(ox - 30, seabed, oz + faceZ),
      new THREE.Vector3(ox + 30, py + 26, oz + faceZ + 34),
      "bridge-portal",
    );
  }

  // --- North abutment --------------------------------------------------------
  {
    const ny = deckY(northEnd);
    concGeo.push(boxAt(0, ny - TRUSS_DEPTH - 5, northEnd - 4, 32, 12, 22, 3.2));
    for (const s of [-1, 1]) {
      concGeo.push(boxAt(s * 16.5, ny - 2.4, northEnd - 2, 3.0, 9.0, 20, 3.2));
    }
  }

  // --- Deck collision --------------------------------------------------------
  // Segmented so the broadphase can reject most of a 1.3 km deck with two
  // compares, and so `raycast` returns a sane normal for grapple hooks.
  for (let z = northEnd; z < southEnd; z += 90) {
    const z1 = Math.min(z + 90, southEnd);
    const yTop = Math.max(deckY(z), deckY(z1));
    const yBot = Math.min(deckY(z), deckY(z1)) - TRUSS_DEPTH;
    kit.collide(
      new THREE.Vector3(ox - DECK_HALF, yBot, oz + z),
      new THREE.Vector3(ox + DECK_HALF, yTop, oz + z1),
      "bridge-deck",
      true,
    );
  }

  // --- Assemble --------------------------------------------------------------
  const addMerged = (list: THREE.BufferGeometry[], mat: THREE.Material, name: string) => {
    const g = mergeAll(list);
    if (!g) return;
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  addMerged(steelGeo, mats.steel, "puente:steel");
  addMerged(concGeo, mats.concrete, "puente:concrete");
  addMerged(cableGeo, mats.steel, "puente:cables");

  kit.ctx.scene.add(group);
  return { group };
}

/* ------------------------------------------------------------------------ *
 * La Aguja — the pyramid tower
 * ------------------------------------------------------------------------ */
//
// The curtain-wall tile carries PANEL_TILE window bays by as many storeys, so a
// UV of 1.0 is 17.4 m across and 23.4 m down. Get these wrong and the windows
// come out at pot-hole scale, which is the single fastest way to make a 300 m
// tower look like a toy.
const BAY_W = 2.9;
const STOREY = 3.9;
const PANEL_U = 1 / (BAY_W * PANEL_TILE);
const PANEL_V = 1 / (STOREY * PANEL_TILE);

function buildPyramid(kit: Kit, ox: number, oz: number): Built {
  const { mats, tier } = kit;
  const group = new THREE.Group();
  group.name = "palmas:la-aguja";
  group.position.set(ox, 0, oz);

  // The plaza is 96 m across, and downtown is not a billiard table: take the
  // high point for the finished level and the low point for the depth the slab
  // has to reach before it stops being a slab hanging in the air.
  const PLAZA = 48;
  const gr = groundRange(kit.ground, ox, oz, PLAZA, PLAZA, 6);

  const panelGeo: THREE.BufferGeometry[] = [];
  const concGeo: THREE.BufferGeometry[] = [];
  const plazaY = gr.hi + 0.4;
  const podiumTop = plazaY + 21;
  const APEX = plazaY + 252;

  // --- Plaza and podium -----------------------------------------------------
  {
    const bottom = gr.lo - 4;
    concGeo.push(boxAt(0, (plazaY + bottom) * 0.5, 0, PLAZA * 2, plazaY - bottom, PLAZA * 2, 3.2));
  }
  for (let s = 0; s < 3; s++) {
    concGeo.push(boxAt(0, plazaY - 0.2 - s * 0.34, 0, 74 + s * 3.2, 0.36, 74 + s * 3.2, 3.2));
  }
  // The exposed legs: X-braced precast frames all round the base. This is the
  // building's signature at street level, and it lets you see through the base.
  const legTop = podiumTop - 1.4;
  const legH = legTop - plazaY;
  for (let side = 0; side < 4; side++) {
    const a = (side / 4) * Math.PI * 2 + Math.PI / 4;
    const nx = Math.cos(a), nz = Math.sin(a);
    const tx = -nz, tz = nx;
    for (let k = -3; k <= 3; k++) {
      const cx = nx * 27 + tx * k * 8.6;
      const cz = nz * 27 + tz * k * 8.6;
      const col = new THREE.BoxGeometry(2.1, legH, 2.1);
      col.translate(cx, plazaY + legH * 0.5, cz);
      concGeo.push(retile(col, 3.2));
      if (tier.detail && k < 3) {
        for (const d of [-1, 1]) {
          const br = new THREE.BoxGeometry(1.2, Math.hypot(8.6, legH) * 0.92, 1.2);
          br.rotateZ(d * Math.atan2(8.6, legH));
          br.rotateY(-a + Math.PI / 2);
          br.translate(cx + tx * 4.3, plazaY + legH * 0.5, cz + tz * 4.3);
          concGeo.push(retile(br, 3.2));
        }
      }
    }
  }
  concGeo.push(boxAt(0, legTop + 0.7, 0, 58, 1.4, 58, 3.2));
  concGeo.push(boxAt(0, podiumTop - 0.15, 0, 61, 1.1, 61, 3.2));

  // --- The shaft ------------------------------------------------------------
  // A true four-sided taper. U restarts at every corner so the window bays
  // line up down each face; because U is scaled by the station scale the bays
  // keep a constant physical width and simply run out as the tower narrows —
  // which is exactly what the real thing does.
  const shaftStations: StationY[] = [];
  {
    const steps = 26;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const y = lerp(podiumTop, APEX - 4, t);
      shaftStations.push({ y, s: lerp(27.0, 4.6, t) });
    }
  }
  // Subdivided but flat (rib depth 0): the faces are trapezoids, and a
  // trapezoid drawn as two triangles interpolates its UVs differently on each
  // side of the diagonal — a visible crease straight up 230 m of window grid.
  // Eight segments a face kills it. The vertical rhythm comes from the texture's
  // own precast fins, which stay a constant 2.9 m however the tower narrows.
  const shaft = sweepY(flutedRect(1, 1, 4, 0), shaftStations, {
    uScale: PANEL_U, vScale: PANEL_V, capTop: true, scaleU: true,
  });
  panelGeo.push(shaft);

  /** Half-width of the shaft at an absolute height. */
  const shaftHalfAt = (y: number) =>
    lerp(27.0, 4.6, clamp01((y - podiumTop) / (APEX - 4 - podiumTop)));

  // --- Wing buttresses -------------------------------------------------------
  // Two service wings riding the east and west faces, tracking the taper the
  // whole way up and stopping two thirds of the way. They are what stops the
  // pyramid reading as a paper dart. Each is a true slab, offset outboard by
  // the station's own dx rather than clipped out of a bigger prism.
  const wingTop = podiumTop + 152;
  for (const s of [-1, 1]) {
    const wingStations: StationY[] = [];
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const y = lerp(podiumTop + 1, wingTop, t);
      wingStations.push({
        y,
        s: 3.1,
        sz: lerp(5.8, 3.6, t),
        dx: s * (shaftHalfAt(y) + 2.2),
      });
    }
    panelGeo.push(sweepY(flutedRect(1, 1, 3, 0), wingStations, {
      uScale: PANEL_U, vScale: PANEL_V, capTop: true, capBottom: true, scaleU: true,
    }));

    // Crown of the wing: a stepped cap, deco again.
    const wx = s * (shaftHalfAt(wingTop) + 2.2);
    concGeo.push(boxAt(wx, wingTop + 1.2, 0, 7.4, 2.4, 8.6, 3.2));
    concGeo.push(boxAt(wx, wingTop + 3.0, 0, 5.8, 1.6, 6.8, 3.2));
  }

  // --- Spire ----------------------------------------------------------------
  const spire = sweepY(
    flutedRect(1, 1, 4, 0),
    [
      { y: APEX - 4, s: 4.6 },
      { y: APEX + 26, s: 2.2 },
      { y: APEX + 50, s: 0.55 },
    ],
    { uScale: PANEL_U, vScale: PANEL_V, capTop: true, scaleU: true },
  );
  panelGeo.push(spire);
  const mast = new THREE.CylinderGeometry(0.34, 0.55, 22, 8, 1, true);
  mast.translate(0, APEX + 60, 0);
  concGeo.push(retile(mast, 2));

  // --- Warning beacons -------------------------------------------------------
  const beacons: THREE.Matrix4[] = [];
  {
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    for (const y of [APEX + 50, APEX + 71]) {
      beacons.push(new THREE.Matrix4().compose(new THREE.Vector3(0, y, 0), q, one));
    }
    for (const s of [-1, 1]) {
      beacons.push(new THREE.Matrix4().compose(
        new THREE.Vector3(s * (shaftHalfAt(wingTop) + 2.2), wingTop + 4.4, 0), q, one,
      ));
    }
  }
  const beaconMesh = makeInstanced(new THREE.SphereGeometry(0.75, 8, 6), mats.beacon, beacons, false);
  if (beaconMesh) { beaconMesh.castShadow = false; group.add(beaconMesh); }

  // --- Collision -------------------------------------------------------------
  // Stacked boxes tracking the taper: a single AABB would leave the player
  // colliding with thin air fifty metres off the face.
  for (let i = 0; i < 6; i++) {
    const y0 = lerp(podiumTop, APEX, i / 6);
    const y1 = lerp(podiumTop, APEX, (i + 1) / 6);
    const h = lerp(27.0, 4.6, i / 6);
    kit.collide(
      new THREE.Vector3(ox - h, y0, oz - h),
      new THREE.Vector3(ox + h, y1, oz + h),
      "aguja",
    );
  }
  kit.collide(
    new THREE.Vector3(ox - 30, plazaY, oz - 30),
    new THREE.Vector3(ox + 30, podiumTop, oz + 30),
    "aguja-podium",
  );

  const shaftMesh = new THREE.Mesh(mergeAll(panelGeo)!, mats.panel);
  shaftMesh.name = "aguja:curtain";
  shaftMesh.castShadow = true;
  shaftMesh.receiveShadow = true;
  group.add(shaftMesh);

  const cm = mergeAll(concGeo);
  if (cm) {
    const m = new THREE.Mesh(cm, mats.concretePale);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }

  kit.ctx.scene.add(group);
  return { group };
}

/* ------------------------------------------------------------------------ *
 * Torre Palma — the fluted tower on Telegraph Hill
 * ------------------------------------------------------------------------ */

function buildTorre(kit: Kit, ox: number, oz: number): Built {
  const { mats, tier } = kit;
  const group = new THREE.Group();
  group.name = "palmas:torre-palma";
  group.position.set(ox, 0, oz);

  // Telegraph Hill is anything but flat: take the lowest ground under the full
  // terrace so the plinth beds into the downhill side instead of hovering over
  // it, and the highest for the finished level.
  const { lo, hi } = groundRange(kit.ground, ox, oz, 26, 26, 6);
  const terraceY = hi + 0.6;

  const pale: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  const R = tier.radial * 2;

  // --- Terrace and steps ------------------------------------------------------
  {
    const terrace = sweepY(
      circleSection(1, R),
      [{ y: lo - 5, s: 21 }, { y: terraceY - 1.1, s: 20 }, { y: terraceY, s: 19.4 }],
      { uScale: 1 / 3.2, vScale: 1 / 3.2, capTop: true, scaleU: true },
    );
    pale.push(terrace);
    for (let s = 0; s < 3; s++) {
      const step = sweepY(
        circleSection(1, R),
        [{ y: terraceY - 0.36 * (s + 1), s: 22.6 + s * 1.3 }, { y: terraceY - 0.36 * s, s: 22.6 + s * 1.3 }],
        { uScale: 1 / 3.2, vScale: 1 / 3.2, capTop: true, scaleU: true },
      );
      pale.push(step);
    }
  }

  // --- Plinth and shaft --------------------------------------------------------
  const shaftBase = terraceY + 4.6;
  const crownY = terraceY + 52;
  pale.push(sweepY(
    circleSection(1, R),
    [{ y: terraceY, s: 10.6 }, { y: shaftBase - 0.9, s: 10.2 }, { y: shaftBase, s: 9.3 }],
    { uScale: 1 / 3.2, vScale: 1 / 3.2, capTop: true, scaleU: true },
  ));
  // Twenty flutes, tapering. This is the whole character of the tower — a
  // smooth cylinder here would be a chimney.
  pale.push(sweepY(
    circleSection(1, R, 20, 0.10),
    [
      { y: shaftBase, s: 8.5 },
      { y: shaftBase + 16, s: 8.05 },
      { y: shaftBase + 32, s: 7.6 },
      { y: crownY - 3.4, s: 7.15 },
      { y: crownY - 2.6, s: 7.9 },     // corbel under the crown
      { y: crownY - 1.2, s: 8.4 },
      { y: crownY, s: 8.3 },
    ],
    { uScale: 1 / 3.2, vScale: 1 / 3.2, scaleU: true },
  ));

  // Slit windows up the shaft, sunk into the flute valleys.
  const slits: THREE.Matrix4[] = [];
  {
    const q = new THREE.Quaternion();
    for (let f = 0; f < 5; f++) {
      const y = shaftBase + 6 + f * 9.4;
      const rr = lerp(8.5, 7.15, (y - shaftBase) / (crownY - 3.4 - shaftBase));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + (f % 2) * 0.4;
        slits.push(new THREE.Matrix4().compose(
          new THREE.Vector3(Math.cos(a) * (rr - 0.25), y, Math.sin(a) * (rr - 0.25)),
          q.setFromAxisAngle(_up, -a),
          new THREE.Vector3(1, 1, 1),
        ));
      }
    }
  }
  const slitMesh = makeInstanced(new THREE.BoxGeometry(0.5, 2.6, 0.9), mats.interior, slits, false);
  if (slitMesh) { slitMesh.castShadow = false; group.add(slitMesh); kit.detail.push(slitMesh); }

  // --- Observation crown --------------------------------------------------------
  // Twelve piers with a lit core behind them, so the arcade reads as openings
  // rather than as a painted band. At night the core is the light source.
  const crownH = 9.4;
  {
    const core = sweepY(
      circleSection(1, R),
      [{ y: crownY, s: 6.1 }, { y: crownY + crownH, s: 6.0 }],
      { uScale: 1 / 3.2, vScale: 1 / 3.2, capTop: true, scaleU: true },
    );
    const coreMesh = new THREE.Mesh(core, mats.interior);
    coreMesh.castShadow = false;
    coreMesh.receiveShadow = false;
    group.add(coreMesh);

    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const g = new THREE.BoxGeometry(1.55, crownH, 2.5);
      g.rotateY(-a);
      g.translate(Math.cos(a) * 7.5, crownY + crownH * 0.5, Math.sin(a) * 7.5);
      pale.push(retile(g, 3.2));
      if (tier.detail) {
        // Arch spandrel over each opening.
        const sp = new THREE.BoxGeometry(2.6, 1.5, 2.3);
        sp.rotateY(-a - Math.PI / 12);
        sp.translate(
          Math.cos(a + Math.PI / 12) * 7.5,
          crownY + crownH - 0.9,
          Math.sin(a + Math.PI / 12) * 7.5,
        );
        pale.push(retile(sp, 3.2));
      }
    }
    // Gallery floor, cornice, parapet, cap.
    pale.push(sweepY(
      circleSection(1, R),
      [{ y: crownY, s: 9.3 }, { y: crownY + 0.8, s: 9.1 }],
      { uScale: 1 / 3.2, vScale: 1 / 3.2, capTop: true, scaleU: true },
    ));
    pale.push(sweepY(
      circleSection(1, R),
      [
        { y: crownY + crownH, s: 8.2 },
        { y: crownY + crownH + 1.5, s: 9.4 },
        { y: crownY + crownH + 2.1, s: 9.2 },
        { y: crownY + crownH + 3.6, s: 8.6 },
        { y: crownY + crownH + 4.2, s: 7.2 },
        { y: crownY + crownH + 6.0, s: 4.6 },
        { y: crownY + crownH + 7.2, s: 2.0 },
      ],
      { uScale: 1 / 3.2, vScale: 1 / 3.2, capTop: true, scaleU: true },
    ));
    const finial = new THREE.CylinderGeometry(0.18, 0.5, 5.2, 8);
    finial.translate(0, crownY + crownH + 9.6, 0);
    dark.push(retile(finial, 2));
  }

  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.62, 8, 6), mats.beacon);
  beacon.position.set(0, crownY + crownH + 12.4, 0);
  group.add(beacon);

  // Doorway: a dark recess with a deco surround, at the foot of the plinth.
  {
    const door = archPanel(7.2, 6.6, 3.2, 4.0, 1.6, 8);
    door.rotateY(Math.PI);
    door.translate(0, terraceY, -10.3);
    pale.push(scaleUV(retile(door, 3.2), 1));
    dark.push(boxAt(0, terraceY + 2.6, -9.0, 3.4, 5.2, 1.6, 3.2));
  }

  kit.collide(
    new THREE.Vector3(ox - 10.6, lo - 5, oz - 10.6),
    new THREE.Vector3(ox + 10.6, crownY + crownH + 8, oz + 10.6),
    "torre-palma",
  );

  const pm = mergeAll(pale);
  if (pm) {
    const m = new THREE.Mesh(pm, mats.concretePale);
    m.name = "torre:stone";
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }
  const dm = mergeAll(dark);
  if (dm) {
    const m = new THREE.Mesh(dm, mats.steelDark);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }

  kit.ctx.scene.add(group);
  return { group };
}

/* ------------------------------------------------------------------------ *
 * Isla Roca — the prison island
 * ------------------------------------------------------------------------ */

interface IslaBuilt extends Built {
  beam: THREE.Object3D | null;
}

function buildIsla(kit: Kit, ox: number, oz: number): IslaBuilt {
  const { mats, tier, rng } = kit;
  const group = new THREE.Group();
  group.name = "palmas:isla-roca";
  group.position.set(ox, 0, oz);

  const rock: THREE.BufferGeometry[] = [];
  const conc: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  const steel: THREE.BufferGeometry[] = [];

  // --- The rock -------------------------------------------------------------
  // A mesa built from the seabed up. The plateau sits well above the terrain
  // mound the atlas puts here, and the skirt runs below it, so the island is a
  // solid object seated in the bay rather than a model resting on a bump.
  const PLATEAU = 27;
  const ANG = tier.radial * 3;
  const profile = [
    { y: -1, r: 1.10 },     // skirt, below the seabed
    { y: -0.1, r: 1.02 },
    { y: 0.10, r: 0.94 },   // wave-cut notch
    { y: 0.30, r: 0.90 },
    { y: 0.62, r: 0.88 },
    { y: 0.86, r: 0.82 },
    { y: 0.97, r: 0.76 },
    { y: 1.00, r: 0.70 },
  ];
  const R0 = 88;
  // Per-angle character, fixed once so the cliff has bays and headlands. The
  // rim wall and every building on the plateau read this back — a rock that
  // varies its radius by a third and a retaining wall drawn on a perfect
  // circle is how you end up with a wall floating over open water.
  const lobe: number[] = [];
  const twist: number[] = [];
  for (let i = 0; i < ANG; i++) {
    const a = (i / ANG) * Math.PI * 2;
    lobe.push(
      1 +
      0.16 * Math.sin(a * 3 + 0.7) +
      0.10 * Math.sin(a * 5 - 1.9) +
      0.055 * Math.sin(a * 9 + 2.4) +
      (rng() - 0.5) * 0.05,
    );
    twist.push(0.06 * Math.sin(a * 4 + 1.1));
  }
  /** Radius of the plateau lip at a bearing, metres. */
  const plateauR = (a: number) => {
    const i = ((Math.round((a / (Math.PI * 2)) * ANG) % ANG) + ANG) % ANG;
    return R0 * 0.70 * lobe[i] * (1 + twist[i] * 0.5);
  };

  {
    const seabed = Math.min(kit.ground(ox, oz + 96), kit.ground(ox, oz - 96), SEA_LEVEL - 6) - 6;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j < profile.length; j++) {
      const p = profile[j];
      const y = lerp(seabed, PLATEAU, clamp01(p.y));
      for (let i = 0; i <= ANG; i++) {
        const ii = i % ANG;
        const a = (i / ANG) * Math.PI * 2;
        const r = R0 * p.r * lobe[ii] * (1 + twist[ii] * (p.y - 0.5));
        pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
        uv.push((i / ANG) * (R0 * Math.PI * 2) / 26, y / 26);
      }
    }
    const ring = ANG + 1;
    for (let j = 0; j < profile.length - 1; j++) {
      for (let i = 0; i < ANG; i++) {
        const a = j * ring + i, b = a + 1, c = a + ring, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    // Plateau cap, dished slightly so rain would run to the rim.
    const capBase = pos.length / 3;
    pos.push(0, PLATEAU + 1.4, 0);
    uv.push(0, 0);
    const top = profile[profile.length - 1];
    for (let i = 0; i < ANG; i++) {
      const a = (i / ANG) * Math.PI * 2;
      const r = R0 * top.r * lobe[i] * (1 + twist[i] * 0.5);
      pos.push(Math.cos(a) * r, PLATEAU, Math.sin(a) * r);
      uv.push(Math.cos(a) * r / 26, Math.sin(a) * r / 26);
    }
    for (let i = 0; i < ANG; i++) {
      idx.push(capBase, capBase + 1 + ((i + 1) % ANG), capBase + 1 + i);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    rock.push(geo);

    // Talus boulders round the waterline, so the cliff foot is not a clean arc.
    const boulders: THREE.Matrix4[] = [];
    const n = tier.detail ? 40 : 18;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const ii = Math.floor((a / (Math.PI * 2)) * ANG) % ANG;
      const r = R0 * 0.97 * lobe[ii] + rng() * 10 - 3;
      const s = 2.4 + rng() * 5.5;
      boulders.push(new THREE.Matrix4().compose(
        new THREE.Vector3(Math.cos(a) * r, SEA_LEVEL - 1 + rng() * 3.5, Math.sin(a) * r),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rng() * 3, rng() * 6, rng() * 3)),
        new THREE.Vector3(s, s * (0.5 + rng() * 0.4), s * (0.7 + rng() * 0.5)),
      ));
    }
    const bGeo = new THREE.IcosahedronGeometry(1, 0);
    const bm = makeInstanced(retile(bGeo, 6), mats.rock, boulders);
    if (bm) group.add(bm);
  }

  // --- Cell block -----------------------------------------------------------
  const blockY = PLATEAU + 1.4;
  const BW = 74, BD = 23, BH = 16;
  conc.push(boxAt(0, blockY + BH * 0.5, 0, BW, BH, BD, 3.2));
  conc.push(boxAt(0, blockY + BH + 0.55, 0, BW + 1.8, 1.1, BD + 1.8, 3.2));  // cornice
  conc.push(boxAt(0, blockY + BH + 1.7, 0, BW + 0.6, 1.2, BD + 0.6, 3.2));   // parapet
  // Stair penthouse and vent stacks on the roof.
  conc.push(boxAt(-22, blockY + BH + 4.4, 0, 12, 6.4, 11, 3.2));
  conc.push(boxAt(18, blockY + BH + 3.2, -4, 7, 4.2, 7, 3.2));
  for (let i = 0; i < 4; i++) {
    const vent = new THREE.CylinderGeometry(0.75, 0.9, 3.6, 8);
    vent.translate(-8 + i * 9, blockY + BH + 3.6, 6.5);
    steel.push(retile(vent, 2));
  }

  // Cell windows: four storeys of barred slots, both long faces. Instanced,
  // dark, and lit from within at night — the detail that makes it a prison.
  {
    const wins: THREE.Matrix4[] = [];
    const bars: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    for (let f = 0; f < 4; f++) {
      const y = blockY + 3.0 + f * 3.6;
      for (let i = 0; i < 22; i++) {
        const x = -BW * 0.5 + 3.4 + i * 3.2;
        for (const s of [-1, 1]) {
          const z = s * (BD * 0.5 + 0.06);
          wins.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, one));
          if (tier.detail) {
            for (let b = -1; b <= 1; b++) {
              bars.push(new THREE.Matrix4().compose(
                new THREE.Vector3(x + b * 0.42, y, z + s * 0.14), q, new THREE.Vector3(1, 1, 1),
              ));
            }
          }
        }
      }
    }
    const wm = makeInstanced(new THREE.BoxGeometry(1.5, 2.1, 0.5), mats.interior, wins, false);
    if (wm) { wm.castShadow = false; group.add(wm); }
    if (bars.length) {
      const bm = makeInstanced(new THREE.BoxGeometry(0.09, 2.2, 0.09), mats.steelDark, bars, false);
      if (bm) { bm.castShadow = false; group.add(bm); kit.detail.push(bm); }
    }
  }

  // --- Lighthouse -----------------------------------------------------------
  let beam: THREE.Object3D | null = null;
  {
    const lx = 31, lz = 21;
    const baseY = PLATEAU + 1.4;
    conc.push(boxAt(lx, baseY + 3.0, lz, 15, 6.0, 12, 3.2));   // keeper's quarters
    conc.push(sweepY(
      circleSection(1, tier.radial * 2),
      [
        { y: baseY, s: 5.2 },
        { y: baseY + 2.4, s: 4.6 },
        { y: baseY + 4.0, s: 4.0 },
        { y: baseY + 26, s: 2.9 },
        { y: baseY + 27.4, s: 3.9 },   // gallery corbel
        { y: baseY + 28.2, s: 4.2 },
      ],
      { uScale: 1 / 3.2, vScale: 1 / 3.2, scaleU: true },
    ).translate(lx, 0, lz));
    // Gallery deck + rail.
    conc.push(sweepY(
      circleSection(1, tier.radial * 2),
      [{ y: baseY + 28.2, s: 4.2 }, { y: baseY + 28.9, s: 4.1 }],
      { uScale: 1 / 3.2, vScale: 1 / 3.2, capTop: true, scaleU: true },
    ).translate(lx, 0, lz));
    const rail = new THREE.TorusGeometry(4.0, 0.07, 5, tier.radial * 2);
    rail.rotateX(Math.PI / 2);
    rail.translate(lx, baseY + 30.1, lz);
    steel.push(retile(rail, 2));

    // Lantern room: a glazed drum with a conical cap.
    const lantern = new THREE.Mesh(
      new THREE.CylinderGeometry(2.5, 2.5, 3.6, tier.radial),
      mats.lamp,
    );
    lantern.position.set(lx, baseY + 30.9, lz);
    group.add(lantern);
    steel.push(retile(
      new THREE.ConeGeometry(3.1, 2.8, tier.radial).translate(lx, baseY + 34.1, lz), 2,
    ));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      steel.push(boxAt(lx + Math.cos(a) * 2.5, baseY + 30.9, lz + Math.sin(a) * 2.5, 0.16, 3.6, 0.16, 2));
    }

    // The beam: a long, very transparent additive cone sweeping the bay. The
    // apex has to sit at the lantern and the wide end 340 m out, so the cone is
    // rotated +90° (which sends its tip to +Z) before being pulled back.
    const beamGeo = new THREE.ConeGeometry(11, 340, 14, 1, true);
    beamGeo.rotateX(Math.PI / 2);
    beamGeo.translate(0, 0, -170);
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xffe9bd,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.set(lx, baseY + 30.9, lz);
    beam.renderOrder = 4;
    group.add(beam);

    kit.collide(
      new THREE.Vector3(ox + lx - 5, baseY, oz + lz - 5),
      new THREE.Vector3(ox + lx + 5, baseY + 34, oz + lz + 5),
      "lighthouse",
    );
  }

  // --- Water tower -----------------------------------------------------------
  {
    const wx = -29, wz = -19;
    const footY = PLATEAU + 1.4;
    const tankY = footY + 17;
    const legs: THREE.Vector3[] = [];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      legs.push(new THREE.Vector3(wx + Math.cos(a) * 5.4, footY, wz + Math.sin(a) * 5.4));
    }
    const legMats: THREE.Matrix4[] = [];
    for (let i = 0; i < 4; i++) {
      const a = legs[i];
      const b = a.clone().setY(tankY);
      b.x = lerp(b.x, wx, 0.35);
      b.z = lerp(b.z, wz, 0.35);
      legMats.push(segmentMatrix(new THREE.Matrix4(), a, b, 0.24));
      // X-bracing between adjacent legs, two levels.
      if (tier.detail) {
        const nx = legs[(i + 1) % 4];
        for (const lv of [0.32, 0.68]) {
          const p = a.clone().lerp(a.clone().setY(tankY), lv);
          const q2 = nx.clone().lerp(nx.clone().setY(tankY), lv + 0.28);
          legMats.push(segmentMatrix(new THREE.Matrix4(), p, q2, 0.09));
        }
      }
    }
    const lm = makeInstanced(new THREE.CylinderGeometry(1, 1, 1, 6, 1, true), mats.steelDark, legMats);
    if (lm) group.add(lm);
    steel.push(sweepY(
      circleSection(1, tier.radial * 2),
      [
        { y: tankY, s: 5.4 },
        { y: tankY + 0.9, s: 6.1 },
        { y: tankY + 8.2, s: 6.1 },
        { y: tankY + 9.0, s: 5.6 },
      ],
      { uScale: 1 / 3.2, vScale: 1 / 3.2, capTop: true, capBottom: true, scaleU: true },
    ).translate(wx, 0, wz));
    steel.push(retile(new THREE.ConeGeometry(6.3, 2.4, tier.radial * 2).translate(wx, tankY + 10.2, wz), 3));
    kit.collide(
      new THREE.Vector3(ox + wx - 6, footY, oz + wz - 6),
      new THREE.Vector3(ox + wx + 6, tankY + 11, oz + wz + 6),
      "water-tower",
    );
  }

  // --- Guard tower, ruins, rim wall ------------------------------------------
  {
    const gx = -10, gz = 30;
    const y = PLATEAU + 1.4;
    conc.push(sweepY(
      rectSection(1, 1),
      [{ y, s: 3.4 }, { y: y + 14, s: 2.6 }],
      { uScale: 1 / 3.2, vScale: 1 / 3.2, scaleU: true },
    ).translate(gx, 0, gz));
    conc.push(boxAt(gx, y + 15.4, gz, 8.2, 0.6, 8.2, 3.2));
    // Glazed cabin — tiled at the curtain-wall pitch so its panes are 2.9 m.
    dark.push(boxAt(gx, y + 17.6, gz, 6.4, 3.8, 6.4, BAY_W * PANEL_TILE));
    conc.push(boxAt(gx, y + 19.9, gz, 8.6, 0.9, 8.6, 3.2));
  }
  if (tier.detail) {
    // Roofless warden's house — three walls and a gable, no roof.
    const hx = 26, hz = -28, y = PLATEAU + 1.4;
    conc.push(boxAt(hx, y + 4, hz - 7, 20, 8, 0.7, 3.2));
    conc.push(boxAt(hx - 10, y + 4, hz, 0.7, 8, 14, 3.2));
    conc.push(boxAt(hx + 10, y + 3.2, hz, 0.7, 6.4, 14, 3.2));
    conc.push(boxAt(hx, y + 5.6, hz + 7, 20, 3.2, 0.7, 3.2));
  }
  {
    // Rim retaining wall: rides the real plateau lip, broken in places where
    // sixty tropical winters have taken a section into the sea.
    const n = 30;
    for (let i = 0; i < n; i++) {
      if (rng() < 0.20) continue;
      const a = (i / n) * Math.PI * 2;
      const r = plateauR(a) - 3.5;
      conc.push(boxAt(
        Math.cos(a) * r, PLATEAU + 2.2, Math.sin(a) * r,
        r * (Math.PI * 2 / n) * 1.12, 2.4 + rng() * 0.5, 1.1, 3.2, -a + Math.PI / 2,
      ));
    }
  }

  // --- Jetty -----------------------------------------------------------------
  {
    // The cliff meets the water somewhere near r = 60 on this bearing, so the
    // deck starts well inside it and runs out over open water from there.
    const jz = 78;
    const deckYj = SEA_LEVEL + 3.4;
    conc.push(boxAt(0, deckYj, jz, 24, 0.9, 52, 3.2));
    const piles: THREE.Matrix4[] = [];
    for (let i = -1; i <= 1; i++) {
      for (let k = 0; k < 5; k++) {
        const p = new THREE.Vector3(i * 10, deckYj - 12, jz - 12 + k * 8);
        const q2 = p.clone().setY(deckYj);
        piles.push(segmentMatrix(new THREE.Matrix4(), p, q2, 0.42));
      }
    }
    const pm = makeInstanced(new THREE.CylinderGeometry(1, 1, 1, 7, 1, true), mats.steelDark, piles);
    if (pm) group.add(pm);
    conc.push(boxAt(-7, deckYj + 3.2, jz + 18, 9, 5.4, 8, 3.2));   // boat shed
    steel.push(boxAt(-7, deckYj + 6.3, jz + 18, 10, 0.5, 9, 3.2));
  }

  kit.collide(
    new THREE.Vector3(ox - BW * 0.5, blockY, oz - BD * 0.5),
    new THREE.Vector3(ox + BW * 0.5, blockY + BH + 6, oz + BD * 0.5),
    "isla-cellblock",
  );

  const push = (list: THREE.BufferGeometry[], mat: THREE.Material) => {
    const g = mergeAll(list);
    if (!g) return;
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  };
  push(rock, mats.rock);
  push(conc, mats.concrete);
  push(steel, mats.steel);
  push(dark, mats.glass);

  kit.ctx.scene.add(group);
  return { group, beam };
}

/* ------------------------------------------------------------------------ *
 * Mercado Ferry — the waterfront terminal
 * ------------------------------------------------------------------------ */

interface FerryBuilt extends Built {
  hands: { hour: THREE.Object3D; minute: THREE.Object3D }[];
}

function buildFerry(kit: Kit, ox: number, oz: number): FerryBuilt {
  const { mats, tier } = kit;
  const group = new THREE.Group();
  group.name = "palmas:mercado-ferry";
  group.position.set(ox, 0, oz);

  // The terminal fronts east onto the bay, so its long axis runs north-south.
  const LEN = 186, DEPTH = 34;
  const quay = groundRange(kit.ground, ox + 6, oz, (DEPTH + 44) * 0.5, (LEN + 30) * 0.5, 7);
  const Y0 = quay.hi + 0.3;

  const stucco: THREE.BufferGeometry[] = [];
  const stone: THREE.BufferGeometry[] = [];
  const roof: THREE.BufferGeometry[] = [];
  const darkGeo: THREE.BufferGeometry[] = [];

  // Depth layout, west to east:
  //   WEST ─── main block ─── BODY_E ─ loggia ─ SCREEN ─ arcade wall ─ EAST
  // The arcade is a screen wall standing 3.4 m in front of the block, so its
  // arches open onto a real covered walkway with a real dark rear wall. Get
  // this wrong and the arcade floats off the facade with daylight behind it.
  const EAST = DEPTH * 0.5;
  const WEST = -DEPTH * 0.5;
  const ARCADE_D = 2.6;
  const SCREEN = EAST - ARCADE_D;
  const BODY_E = SCREEN - 3.4;
  const ARCADE_H = 12.5;
  const BODY_H = 20.5;
  const ARCADE_Y = Y0 + 1.2;
  const ARCADE_TOP = ARCADE_Y + ARCADE_H;

  // --- Quay, stylobate and steps ---------------------------------------------
  {
    // The quay is 78 m by 216 m; it has to reach the low corner of that
    // footprint or the whole terrace sits on a visible lip of daylight.
    const bottom = quay.lo - 4;
    stone.push(boxAt(6, (Y0 + bottom) * 0.5, 0, DEPTH + 44, Y0 - bottom, LEN + 30, 3.2));
  }
  stone.push(boxAt(0, Y0 + 0.6, 0, DEPTH + 5, 1.2, LEN + 7, 3.2));
  for (let s = 0; s < 2; s++) {
    stone.push(boxAt(EAST + 20 + s * 1.6, Y0 - 0.35 - s * 0.34, 0, 2.2, 0.4, LEN + 22, 3.2));
  }

  // --- Main block -------------------------------------------------------------
  stucco.push(boxAt((WEST + BODY_E) * 0.5, Y0 + BODY_H * 0.5, 0, BODY_E - WEST, BODY_H, LEN, 3));
  // Upper floors carried over the loggia and the arcade.
  stucco.push(boxAt(
    (BODY_E + EAST) * 0.5, (ARCADE_TOP + Y0 + BODY_H) * 0.5, 0,
    EAST - BODY_E, Y0 + BODY_H - ARCADE_TOP, LEN, 3,
  ));
  // Rusticated stone base course — human scale, and it grounds the stucco.
  stone.push(boxAt((WEST + BODY_E) * 0.5, Y0 + 2.9, 0, BODY_E - WEST + 0.8, 3.4, LEN + 0.8, 3.2));
  // Cornice and parapet, over the full depth so the arcade is capped too.
  stone.push(boxAt(0, Y0 + BODY_H + 0.7, 0, DEPTH + 2.4, 1.4, LEN + 2.6, 3.2));
  stone.push(boxAt(0, Y0 + BODY_H + 2.0, 0, DEPTH + 1.2, 1.2, LEN + 1.4, 3.2));

  // --- Arcade ----------------------------------------------------------------
  // One bay panel, instanced down the frontage with the clocktower's bays
  // skipped. Real arched openings — the sun goes through them.
  const BAY = 6.2;
  const bays = Math.floor(LEN / BAY);
  const TX = EAST - 8.6 + 1.0;                       // clocktower centreline
  {
    const panel = archPanel(BAY, ARCADE_H, 4.3, 6.4, ARCADE_D, tier.detail ? 10 : 6);
    panel.rotateY(-Math.PI / 2);
    scaleUV(panel, 1 / 3);
    const mats4: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < bays; i++) {
      const z = -LEN / 2 + BAY * 0.5 + i * BAY;
      if (Math.abs(z) < 11) continue;                 // clocktower stands here
      mats4.push(new THREE.Matrix4().compose(new THREE.Vector3(SCREEN, ARCADE_Y, z), q, one));
    }
    const am = makeInstanced(panel, mats.stuccoCoral, mats4);
    if (am) group.add(am);
    // The loggia's rear wall, in permanent shadow behind the arches.
    darkGeo.push(boxAt(BODY_E + 0.25, ARCADE_Y + ARCADE_H * 0.5, 0, 0.5, ARCADE_H, LEN, 3));
  }
  // Arcade string course, and a second storey of arched windows above it.
  stone.push(boxAt(EAST - 1.3, ARCADE_TOP + 0.6, 0, 3.6, 1.2, LEN + 1.2, 3.2));
  {
    const winH = Y0 + BODY_H - ARCADE_TOP - 2.4;
    const win = archPanel(BAY, winH, 2.6, winH * 0.52, 1.4, tier.detail ? 8 : 5);
    win.rotateY(-Math.PI / 2);
    scaleUV(win, 1 / 3);
    const mats4: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < bays; i++) {
      const z = -LEN / 2 + BAY * 0.5 + i * BAY;
      if (Math.abs(z) < 11) continue;
      mats4.push(new THREE.Matrix4().compose(
        new THREE.Vector3(EAST - 1.4, ARCADE_TOP + 1.4, z), q, one,
      ));
    }
    const wm = makeInstanced(win, mats.stucco, mats4);
    if (wm) { group.add(wm); kit.detail.push(wm); }
    darkGeo.push(boxAt(EAST - 1.7, ARCADE_TOP + 1.4 + winH * 0.5, 0, 0.5, winH, LEN, 3));
  }

  // West elevation: a simpler pilaster rhythm so the back is not a blank slab.
  if (tier.detail) {
    const pil: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < bays; i++) {
      const z = -LEN / 2 + BAY * 0.5 + i * BAY;
      pil.push(new THREE.Matrix4().compose(new THREE.Vector3(WEST - 0.3, Y0 + 4.6, z), q, one));
    }
    const pg = mergeAll([
      boxAt(0, (BODY_H - 4.6) * 0.5, 0, 1.1, BODY_H - 4.6, 1.6, 3),
      boxAt(0, BODY_H - 4.8, 0, 1.7, 0.7, 2.1, 3),
    ]);
    if (pg) {
      const pm = makeInstanced(pg, mats.concretePale, pil);
      if (pm) { group.add(pm); kit.detail.push(pm); }
    }
  }

  // --- Roof ------------------------------------------------------------------
  // Hipped terracotta over the whole block, with the ridge running north-south.
  {
    const rw = DEPTH, rl = LEN + 1.6, rh = 5.2;
    const y = Y0 + BODY_H + 2.6;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const hx = rw * 0.5, hz = rl * 0.5;
    const ridge = hz - rw * 0.45;
    const V = [
      [-hx, y, -hz], [hx, y, -hz], [hx, y, hz], [-hx, y, hz],
      [0, y + rh, -ridge], [0, y + rh, ridge],
    ];
    const tri = [
      [0, 4, 1], [1, 4, 5], [1, 5, 2], [2, 5, 3], [3, 5, 4], [3, 4, 0],
    ];
    for (const t of tri) {
      for (const vi of t) {
        pos.push(V[vi][0], V[vi][1], V[vi][2]);
        // Project along the slope. 2.4 m per tile of the eight-pan map puts the
        // barrel pans at 300 mm, which is what a real clay pan measures.
        uv.push(V[vi][0] / 2.4, V[vi][2] / 2.4);
      }
    }
    for (let i = 0; i < tri.length * 3; i++) idx.push(i);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    roof.push(geo);
    // Eaves board.
    stone.push(boxAt(0, y - 0.35, 0, rw + 1.4, 0.7, rl + 1.4, 3.2));
  }

  // --- Clocktower ------------------------------------------------------------
  const hands: { hour: THREE.Object3D; minute: THREE.Object3D }[] = [];
  const TW = 8.6;
  const TOP = Y0 + 62;
  {
    stucco.push(sweepY(
      rectSection(1, 1),
      [
        { y: Y0, s: TW + 1.6, dx: TX },
        { y: Y0 + 4, s: TW + 1.2, dx: TX },
        { y: Y0 + 26, s: TW, dx: TX },
        { y: Y0 + 40, s: TW - 0.5, dx: TX },
      ],
      { uScale: 1 / 3, vScale: 1 / 3, scaleU: true },
    ));
    // Belfry: four arched openings, one per face.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const p = archPanel(TW * 2 - 1.0, 12.2, 4.6, 6.6, 1.5, tier.detail ? 10 : 6);
      p.rotateY(a);
      // Push the panel out to the face along its own (rotated) normal.
      p.translate(TX - Math.sin(a) * (TW - 0.7), Y0 + 40, -Math.cos(a) * (TW - 0.7));
      stucco.push(retile(p, 3));
    }
    darkGeo.push(boxAt(TX, Y0 + 46, 0, TW * 1.3, 12, TW * 1.3, 3));
    stone.push(boxAt(TX, Y0 + 52.6, 0, TW * 2 + 2.4, 1.4, TW * 2 + 2.4, 3.2));

    // Clock stage.
    stucco.push(sweepY(
      rectSection(1, 1),
      [{ y: Y0 + 53.3, s: TW - 0.2, dx: TX }, { y: TOP - 1.2, s: TW - 0.6, dx: TX }],
      { uScale: 1 / 3, vScale: 1 / 3, scaleU: true },
    ));
    stone.push(boxAt(TX, TOP - 0.4, 0, TW * 2 + 3.0, 1.6, TW * 2 + 3.0, 3.2));

    // Four clock faces, hands driven by the sky clock. The bezel and its
    // twelve hour marks merge into one dial geometry shared by all four faces,
    // so the whole clock costs sixteen draw calls instead of sixty-four.
    const faceGeo = new THREE.CircleGeometry(3.5, 28);
    const faceMat = makeMat(null, { color: 0xf3ece0, roughness: 0.55, metalness: 0 });
    faceMat.emissive = new THREE.Color(0xffe4b0);
    faceMat.emissiveIntensity = 0;
    kit.night.push({ mat: faceMat, day: 0, night: 0.85 });

    const dialParts: THREE.BufferGeometry[] = [];
    const bezel = new THREE.TorusGeometry(3.75, 0.34, 6, 26);
    bezel.translate(0, 0, 0.05);
    dialParts.push(retile(bezel, 2));
    for (let h = 0; h < 12; h++) {
      const ha = (h / 12) * Math.PI * 2;
      const mark = new THREE.BoxGeometry(0.16, h % 3 === 0 ? 0.78 : 0.46, 0.06);
      mark.rotateZ(-ha);
      mark.translate(Math.sin(ha) * 3.0, Math.cos(ha) * 3.0, 0.12);
      dialParts.push(retile(mark, 2));
    }
    const dialGeo = mergeAll(dialParts);

    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const pivot = new THREE.Group();
      pivot.position.set(TX + Math.sin(a) * (TW - 0.45), Y0 + 57.6, Math.cos(a) * (TW - 0.45));
      pivot.rotation.y = a;
      const face = new THREE.Mesh(faceGeo, faceMat);
      face.position.z = 0.05;
      pivot.add(face);
      if (dialGeo) pivot.add(new THREE.Mesh(dialGeo, mats.steelDark));
      const hour = new THREE.Mesh(new THREE.BoxGeometry(0.24, 2.0, 0.09), mats.steelDark);
      hour.geometry.translate(0, 0.85, 0);
      hour.position.z = 0.16;
      const minute = new THREE.Mesh(new THREE.BoxGeometry(0.17, 2.9, 0.08), mats.steelDark);
      minute.geometry.translate(0, 1.30, 0);
      minute.position.z = 0.22;
      pivot.add(hour, minute);
      group.add(pivot);
      hands.push({ hour, minute });
    }

    // Cap: a stepped pyramid and a finial.
    stucco.push(sweepY(
      rectSection(1, 1),
      [
        { y: TOP + 0.4, s: TW - 0.4, dx: TX },
        { y: TOP + 5.2, s: TW * 0.62, dx: TX },
        { y: TOP + 5.9, s: TW * 0.68, dx: TX },
        { y: TOP + 11.0, s: TW * 0.30, dx: TX },
        { y: TOP + 14.5, s: 0.7, dx: TX },
      ],
      { uScale: 1 / 3, vScale: 1 / 3, capTop: true, scaleU: true },
    ));
    const mast = new THREE.CylinderGeometry(0.12, 0.30, 6.5, 8);
    mast.translate(TX, TOP + 17.5, 0);
    stone.push(retile(mast, 2));
  }

  // --- Quay furniture ---------------------------------------------------------
  if (tier.detail) {
    const bollards: THREE.Matrix4[] = [];
    const lampBodies: THREE.Matrix4[] = [];
    const lampHeads: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    for (let z = -LEN / 2 + 6; z < LEN / 2; z += 11) {
      bollards.push(new THREE.Matrix4().compose(new THREE.Vector3(EAST + 19, Y0, z), q, one));
    }
    for (let z = -LEN / 2 + 14; z < LEN / 2; z += 28) {
      lampBodies.push(new THREE.Matrix4().compose(new THREE.Vector3(EAST + 12, Y0, z), q, one));
      lampHeads.push(new THREE.Matrix4().compose(new THREE.Vector3(EAST + 12, Y0 + 6.3, z), q, one));
    }
    const bg = mergeAll([
      boxAt(0, 0.55, 0, 0.62, 1.1, 0.62, 2),
      boxAt(0, 1.22, 0, 0.86, 0.28, 0.86, 2),
    ]);
    if (bg) {
      const bm = makeInstanced(bg, mats.steelDark, bollards, false);
      if (bm) { group.add(bm); kit.detail.push(bm); }
    }
    const lg = mergeAll([
      boxAt(0, 3.0, 0, 0.26, 6.0, 0.26, 2),
      boxAt(0, 0.24, 0, 0.66, 0.48, 0.66, 2),
    ]);
    if (lg) {
      const lm = makeInstanced(lg, mats.steelDark, lampBodies, false);
      if (lm) { group.add(lm); kit.detail.push(lm); }
      const hm = makeInstanced(new THREE.SphereGeometry(0.42, 8, 6), mats.lamp, lampHeads, false);
      if (hm) { hm.castShadow = false; group.add(hm); kit.detail.push(hm); }
    }
  }

  kit.collide(
    new THREE.Vector3(ox - DEPTH * 0.5, Y0, oz - LEN * 0.5),
    new THREE.Vector3(ox + DEPTH * 0.5, Y0 + BODY_H + 8, oz + LEN * 0.5),
    "mercado",
  );
  kit.collide(
    new THREE.Vector3(ox + TX - TW - 1.6, Y0, oz - TW - 1.6),
    new THREE.Vector3(ox + TX + TW + 1.6, TOP + 15, oz + TW + 1.6),
    "mercado-tower",
  );

  const push = (list: THREE.BufferGeometry[], mat: THREE.Material) => {
    const g = mergeAll(list);
    if (!g) return;
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  };
  push(stucco, mats.stucco);
  push(stone, mats.concretePale);
  push(roof, mats.terracotta);
  push(darkGeo, mats.interior);

  kit.ctx.scene.add(group);
  return { group, hands };
}

/* ------------------------------------------------------------------------ *
 * System
 * ------------------------------------------------------------------------ */

const createLandmarks: SystemFactory = async (ctx) => {
  const breathe = () => new Promise<void>((r) => setTimeout(r, 0));
  const tier = TIERS[ctx.quality] ?? TIERS.high;

  let aniso = 8;
  try {
    aniso = Math.min(16, ctx.renderer.capabilities.getMaxAnisotropy());
  } catch {
    /* headless — anisotropy is a hint, not a requirement */
  }

  // ---- Bake the seven surfaces --------------------------------------------
  const T = tier.tex;
  const N = tier.tex >= 128 ? 1 : 0;   // normal maps are free-ish, but not at 64²

  const steelMaps = bakeMaps(T, aniso, { normal: N * 1.0 }, steelTexel);
  await breathe();
  const concreteMaps = bakeMaps(T, aniso, { normal: N * 0.85 }, concreteTexel);
  await breathe();
  // The roadway map spans 24 m of carriageway in one tile, so a 150 mm lane
  // line is under two texels at the shared resolution. It is the one surface
  // the player walks on, so it gets double.
  const roadMaps = bakeMaps(Math.min(384, T * 2), aniso, { normal: N * 0.55, clampU: true }, roadTexel);
  await breathe();
  const panelMaps = bakeMaps(T, aniso, { normal: N * 0.8, emissive: true }, panelTexel);
  await breathe();
  const stuccoMaps = bakeMaps(T, aniso, { normal: N * 0.9 }, stuccoTexel);
  await breathe();
  const terracottaMaps = bakeMaps(Math.min(T, 128), aniso, { normal: N * 1.2 }, terracottaTexel);
  const rockMaps = bakeMaps(T, aniso, { normal: N * 1.3 }, rockTexel);
  await breathe();

  const night: NightMat[] = [];

  // Tinted variants share their maps: a second colour costs nothing but a
  // material, and it is the cheapest way to stop five landmarks looking like
  // they were poured from the same bucket.
  const mats: Mats = {
    steel: makeMat(steelMaps, { color: 0xffffff, normalScale: 1.0 }),
    steelDark: makeMat(steelMaps, { color: 0x6a5148, roughness: 0.8, metalness: 0.75, normalScale: 0.7 }),
    road: makeMat(roadMaps, { color: 0xffffff, metalness: 0.0, normalScale: 0.6 }),
    concrete: makeMat(concreteMaps, { color: 0xd8cfbe, metalness: 0.0, normalScale: 0.9 }),
    concretePale: makeMat(concreteMaps, { color: 0xf2ece0, metalness: 0.0, roughness: 0.92, normalScale: 0.8 }),
    concreteWarm: makeMat(concreteMaps, { color: 0xd6b58c, metalness: 0.0, normalScale: 0.9 }),
    panel: makeMat(panelMaps, { color: 0xffffff, emissive: 0xffc478, day: 0, night: 1.5, normalScale: 0.9 }),
    stucco: makeMat(stuccoMaps, { color: 0xffe9c8, metalness: 0.0, normalScale: 0.9 }),
    stuccoCoral: makeMat(stuccoMaps, { color: 0xf0b48c, metalness: 0.0, normalScale: 0.9 }),
    terracotta: makeMat(terracottaMaps, { color: 0xffffff, metalness: 0.0, normalScale: 1.0 }),
    rock: makeMat(rockMaps, { color: 0xffffff, metalness: 0.0, normalScale: 1.1 }),
    interior: makeMat(null, { color: 0x14100c, roughness: 0.95, metalness: 0.0, emissive: 0xffb45a, day: 0 }),
    lamp: makeMat(null, { color: 0xfff3d8, roughness: 0.35, metalness: 0.0, emissive: 0xffdc9a, day: 0.05 }),
    beacon: makeMat(null, { color: 0x501008, roughness: 0.5, metalness: 0.0, emissive: 0xff3018, day: 0.4 }),
    glass: makeMat(panelMaps, { color: 0x2c3a3c, roughness: 0.25, metalness: 0.8, normalScale: 0.5 }),
  };
  night.push({ mat: mats.panel, day: 0, night: 1.6 });
  night.push({ mat: mats.interior, day: 0.0, night: 0.85 });
  night.push({ mat: mats.lamp, day: 0.06, night: 3.2 });
  night.push({ mat: mats.beacon, day: 0.5, night: 2.6 });

  // ---- Services (all optional — a missing one costs its feature only) ------
  const terrain = ctx.services.terrain;
  const collision = ctx.services.collision;

  /** Terrain height, falling back to the atlas if terrain never booted. */
  const ground = (x: number, z: number): number => {
    const h = terrain?.heightAt(x, z);
    if (typeof h === "number" && isFinite(h)) return h;
    const d = landSignedDistance(x, z);
    return shoreProfile(d) + (d > 0 ? hillHeight(x, z) * smoothstep(0, 130, d) : 0);
  };

  let colliderCount = 0;
  const collide = (min: THREE.Vector3, max: THREE.Vector3, tag: string, climbable = false) => {
    if (!collision) return;
    colliderCount++;
    collision.addBox(new THREE.Box3(min, max), { tag, climbable });
  };

  const kit: Kit = {
    ctx,
    rng: ctx.rng,
    tier,
    mats,
    night,
    ground,
    collide,
    detail: [],
  };

  // ---- Build ---------------------------------------------------------------
  const at = (key: string) => LANDMARKS.find((l) => l.key === key);
  const built: THREE.Group[] = [];
  let beam: THREE.Object3D | null = null;
  let clockHands: { hour: THREE.Object3D; minute: THREE.Object3D }[] = [];

  /** One landmark failing must never cost the other four, or the boot. */
  const raise = async (key: string, fn: (x: number, z: number) => void) => {
    const lm = at(key);
    if (!lm) return;
    try {
      fn(lm.x, lm.z);
    } catch (err) {
      console.error(`[San Palmas] landmark "${key}" failed to build:`, err);
    }
    await breathe();
  };

  await raise("bridge", (x, z) => { built.push(buildBridge(kit, x, z).group); });
  await raise("pyramid", (x, z) => { built.push(buildPyramid(kit, x, z).group); });
  await raise("coit", (x, z) => { built.push(buildTorre(kit, x, z).group); });
  await raise("alcatraz", (x, z) => {
    const b = buildIsla(kit, x, z);
    built.push(b.group);
    beam = b.beam;
  });
  await raise("ferry", (x, z) => {
    const b = buildFerry(kit, x, z);
    built.push(b.group);
    clockHands = b.hands;
  });

  ctx.emit("palmas:landmarks-ready", {
    count: built.length,
    colliders: colliderCount,
    quality: ctx.quality,
  });

  // ---- Per-frame -----------------------------------------------------------
  const camPos = new THREE.Vector3();
  const nodePos = new THREE.Vector3();
  let lastDay = -1;
  let detailOn = true;
  let beamAngle = ctx.rng() * Math.PI * 2;

  const sys: System = {
    name: "landmarks",

    update(dt, c) {
      const sky = c.services.sky;
      const daylight = sky?.daylight ?? 1;

      // Emissives only get rewritten when the light actually moves — the sky
      // steps time slowly, so this is a no-op on the vast majority of frames.
      if (Math.abs(daylight - lastDay) > 0.004) {
        lastDay = daylight;
        const dark = 1 - daylight;
        for (const n of night) n.mat.emissiveIntensity = lerp(n.day, n.night, dark * dark);
      }

      // The Isla Roca light: sweeps always, but only visible after dusk.
      if (beam) {
        beamAngle += dt * 0.42;
        beam.rotation.y = beamAngle;
        const m = (beam as THREE.Mesh).material as THREE.MeshBasicMaterial;
        if (m) m.opacity = 0.085 * clamp01((1 - daylight) * 1.6);
        beam.visible = daylight < 0.55;
      }

      // The clock keeps the world's own time — a twelve-hour dial off the
      // sky's 0..1 day, so dusk really does read as seven o'clock.
      if (clockHands.length) {
        const t = sky?.time ?? 0.5;
        const hourAngle = -((t * 24) % 12) * (Math.PI / 6);
        const minuteAngle = -fract(t * 24) * Math.PI * 2;
        for (const h of clockHands) {
          h.hour.rotation.z = hourAngle;
          h.minute.rotation.z = minuteAngle;
        }
      }
    },

    lateUpdate(_dt, c) {
      // Distance culling for the small stuff. Railing posts and window bars
      // are the bulk of the landmark triangle count and are invisible past a
      // few hundred metres; one boolean flip per group is the whole cost.
      camPos.copy(c.camera.position);
      let near = false;
      for (const g of built) {
        g.getWorldPosition(nodePos);
        if (camPos.distanceTo(nodePos) < tier.detailRange + 700) { near = true; break; }
      }
      // Per-group would be finer, but every detail node belongs to a landmark
      // and the ranges overlap heavily; the coarse test costs five distances.
      if (near !== detailOn) {
        detailOn = near;
        for (const d of kit.detail) d.visible = near;
      }
    },

    dispose() {
      for (const g of built) {
        g.parent?.remove(g);
        g.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          mesh.geometry?.dispose?.();
        });
      }
      built.length = 0;
      for (const set of [steelMaps, concreteMaps, roadMaps, panelMaps, stuccoMaps, terracottaMaps, rockMaps]) {
        set.map.dispose();
        set.rough.dispose();
        set.normal?.dispose();
        set.emissive?.dispose();
      }
      for (const m of Object.values(mats)) m.dispose();
    },
  };

  return sys;
};

export default createLandmarks;
