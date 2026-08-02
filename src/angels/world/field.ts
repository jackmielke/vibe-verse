/**
 * The height field.
 *
 * Seattle's shape, baked once at boot into a plain Float32Array that everything
 * afterwards samples bilinearly: the terrain mesh reads it to build triangles,
 * the flight model reads it 120 times a second for radar altitude, the ring
 * courses read it to know how high to float, and the city reads it to know
 * where the ground is under each block.
 *
 * Baking rather than evaluating matters. The honest version of this function —
 * two dozen Gaussians plus a signed distance to two hundred coastline segments
 * — costs about forty microseconds, and the flight model cannot afford that
 * per jet per step. Bilinear off a grid costs nothing, and at 150 m spacing
 * the error against the analytic field is under a metre anywhere it matters.
 */
import {
  EXTENT,
  FLATS,
  GREEN_LAKE_LEVEL,
  HILLS,
  LAKE_LEVEL,
  SEA_LEVEL,
  SHIP_CANAL,
  WATER_BODIES,
  latToZ,
  lonToX,
  projectRing,
} from "./geo";

/** What kind of surface a cell is. */
export const SURFACE_LAND = 0;
export const SURFACE_SOUND = 1;
export const SURFACE_LAKE = 2;
export const SURFACE_GREEN = 3;

export interface HeightField {
  /** Samples per side. The grid is (res+1)² so both edges are represented. */
  res: number;
  extent: number;
  /** Metres between samples. */
  step: number;
  height: Float32Array;
  /** SURFACE_* per sample. */
  surface: Uint8Array;
  /** Water surface level per sample, or NaN on dry land. */
  water: Float32Array;
  /** Signed distance to the nearest shoreline: negative in the water. */
  shore: Float32Array;
}

// ---------------------------------------------------------------------------
// Polygon maths
// ---------------------------------------------------------------------------

interface Ring {
  pts: Float64Array;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function makeRing(pts: Float64Array): Ring {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < minX) minX = pts[i];
    if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 1] < minZ) minZ = pts[i + 1];
    if (pts[i + 1] > maxZ) maxZ = pts[i + 1];
  }
  return { pts, minX, maxX, minZ, maxZ };
}

/** Even-odd crossing test. */
function inRing(ring: Ring, x: number, z: number): boolean {
  if (x < ring.minX || x > ring.maxX || z < ring.minZ || z > ring.maxZ) return false;
  const p = ring.pts;
  const n = p.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2];
    const zi = p[i * 2 + 1];
    const xj = p[j * 2];
    const zj = p[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from a point to the ring's boundary. */
function distToRing(ring: Ring, x: number, z: number): number {
  const p = ring.pts;
  const n = p.length / 2;
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = p[j * 2];
    const az = p[j * 2 + 1];
    const bx = p[i * 2];
    const bz = p[i * 2 + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + dx * t - x;
    const cz = az + dz * t - z;
    const d2 = cx * cx + cz * cz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/** Distance from a point to an open polyline, and its parameter along it. */
function distToLine(pts: Float64Array, x: number, z: number): number {
  const n = pts.length / 2;
  let best = Infinity;
  for (let i = 1; i < n; i++) {
    const ax = pts[(i - 1) * 2];
    const az = pts[(i - 1) * 2 + 1];
    const bx = pts[i * 2];
    const bz = pts[i * 2 + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + dx * t - x;
    const cz = az + dz * t - z;
    const d2 = cx * cx + cz * cz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Cheap deterministic value noise. Two octaves is all the ground needs. */
function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

interface WaterRings {
  outline: Ring;
  holes: Ring[];
  level: number;
  depth: number;
  surface: number;
  index: number;
}

/**
 * Bake the field.
 *
 * Around 250 ms at the highest resolution and under 40 ms at the lowest, which
 * is why the boot sequence yields to the browser around it.
 */
export function buildHeightField(res: number): HeightField {
  const step = (EXTENT * 2) / res;
  const n = res + 1;
  const height = new Float32Array(n * n);
  const surface = new Uint8Array(n * n);
  const water = new Float32Array(n * n);
  const shore = new Float32Array(n * n);

  const hills = HILLS.map((h) => ({
    x: lonToX(h.at[1]),
    z: latToZ(h.at[0]),
    height: h.height,
    invSigmaX: 1 / h.sigma,
    invSigmaZ: 1 / (h.sigma * (h.stretch ?? 1)),
  }));

  const flats = FLATS.map((f) => ({
    minX: Math.min(lonToX(f.min[1]), lonToX(f.max[1])),
    maxX: Math.max(lonToX(f.min[1]), lonToX(f.max[1])),
    minZ: Math.min(latToZ(f.min[0]), latToZ(f.max[0])),
    maxZ: Math.max(latToZ(f.min[0]), latToZ(f.max[0])),
    height: f.height,
    feather: f.feather,
  }));

  const bodies: WaterRings[] = WATER_BODIES.map((b, i) => ({
    outline: makeRing(projectRing(b.outline)),
    holes: b.holes.map((h) => makeRing(projectRing(h))),
    level: b.level,
    depth: b.depth,
    surface:
      b.level === SEA_LEVEL
        ? SURFACE_SOUND
        : b.level === GREEN_LAKE_LEVEL
          ? SURFACE_GREEN
          : SURFACE_LAKE,
    index: i,
  }));

  const canal = projectRing(SHIP_CANAL);
  /** The Ship Canal is 60–100 m wide; this is its half-width plus a bank. */
  const CANAL_HALF = 55;

  for (let j = 0; j < n; j++) {
    const z = -EXTENT + j * step;
    for (let i = 0; i < n; i++) {
      const x = -EXTENT + i * step;
      const idx = j * n + i;

      // ---- land elevation ------------------------------------------------
      let h = 0;
      for (const hill of hills) {
        const dx = (x - hill.x) * hill.invSigmaX;
        const dz = (z - hill.z) * hill.invSigmaZ;
        const d2 = dx * dx + dz * dz;
        if (d2 < 9) h += hill.height * Math.exp(-d2);
      }

      // One octave of texture so ridges are not glassy from a thousand feet.
      //
      // The 260 m octave that used to be here was finer than the grid spacing
      // at every quality tier below "ultra", so it did not add detail — it
      // added aliasing, as a field of triangular facets across otherwise
      // smooth ground.
      h += valueNoise(x / 1400, z / 1400) * 14;

      // The flats win wherever they apply — the Duwamish valley is a table.
      for (const f of flats) {
        const inX = smoothstep(f.minX - f.feather, f.minX, x) * (1 - smoothstep(f.maxX, f.maxX + f.feather, x));
        const inZ = smoothstep(f.minZ - f.feather, f.minZ, z) * (1 - smoothstep(f.maxZ, f.maxZ + f.feather, z));
        const w = inX * inZ;
        if (w > 0) h = h * (1 - w) + f.height * w;
      }

      // ---- water ----------------------------------------------------------
      let inWater = -1;
      let dShore = Infinity;
      let signedShore = Infinity;

      for (const b of bodies) {
        const d = distToRing(b.outline, x, z);
        let inside = inRing(b.outline, x, z);
        let holeDist = Infinity;
        if (inside) {
          for (const hole of b.holes) {
            if (inRing(hole, x, z)) {
              inside = false;
              holeDist = Math.min(holeDist, distToRing(hole, x, z));
              break;
            }
            holeDist = Math.min(holeDist, distToRing(hole, x, z));
          }
        }
        const edge = Math.min(d, holeDist);
        if (inside) {
          if (inWater < 0 || b.level > bodies[inWater].level) inWater = b.index;
          dShore = Math.min(dShore, edge);
          signedShore = Math.min(signedShore, -edge);
        } else {
          signedShore = Math.min(signedShore, edge);
        }
      }

      // The Ship Canal, cut as a channel rather than described as a polygon.
      const dCanal = distToLine(canal, x, z);
      if (dCanal < CANAL_HALF) {
        inWater = inWater < 0 ? 1 : inWater; // Lake Washington's level and colour
        dShore = Math.min(dShore, CANAL_HALF - dCanal);
        signedShore = Math.min(signedShore, -(CANAL_HALF - dCanal));
      } else {
        signedShore = Math.min(signedShore, dCanal - CANAL_HALF);
      }

      if (inWater >= 0) {
        const body = bodies[inWater];
        // Shelving beach: shallow at the edge, plunging within a few hundred
        // metres. Lake Washington really is 60 m deep a stone's throw offshore.
        const depth = Math.min(body.depth, 2 + dShore * 0.16);
        height[idx] = body.level - depth;
        surface[idx] = body.surface;
        water[idx] = body.level;
        shore[idx] = -dShore;
      } else {
        // Land rises out of the water rather than stepping out of it.
        const rise = smoothstep(0, 550, signedShore);
        const level = signedShore < 900 ? SEA_LEVEL : 0;
        height[idx] = Math.max(0.4, level + h * rise + 3 * rise);
        surface[idx] = SURFACE_LAND;
        water[idx] = NaN;
        shore[idx] = signedShore;
      }
    }
  }

  return { res, extent: EXTENT, step, height, surface, water, shore };
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/** Bilinear ground height at a world XZ. Outside the box, the nearest edge. */
export function sampleHeight(f: HeightField, x: number, z: number): number {
  const n = f.res + 1;
  const fx = (x + f.extent) / f.step;
  const fz = (z + f.extent) / f.step;
  const i = Math.max(0, Math.min(f.res - 1, Math.floor(fx)));
  const j = Math.max(0, Math.min(f.res - 1, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - i));
  const tz = Math.max(0, Math.min(1, fz - j));
  const h00 = f.height[j * n + i];
  const h10 = f.height[j * n + i + 1];
  const h01 = f.height[(j + 1) * n + i];
  const h11 = f.height[(j + 1) * n + i + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

/** The surface classification at the nearest sample. */
export function sampleSurface(f: HeightField, x: number, z: number): number {
  const n = f.res + 1;
  const i = Math.max(0, Math.min(f.res, Math.round((x + f.extent) / f.step)));
  const j = Math.max(0, Math.min(f.res, Math.round((z + f.extent) / f.step)));
  return f.surface[j * n + i];
}

/**
 * What you would hit here: the water surface over water, the ground over land.
 *
 * A jet that ditches in Lake Washington must stop at 4.9 m, not carry on down
 * to the lake bed sixty metres below, and this is the function that knows it.
 */
export function sampleSurfaceHeight(f: HeightField, x: number, z: number): number {
  const s = sampleSurface(f, x, z);
  const ground = sampleHeight(f, x, z);
  if (s === SURFACE_LAND) return ground;
  const level = s === SURFACE_SOUND ? SEA_LEVEL : s === SURFACE_GREEN ? GREEN_LAKE_LEVEL : LAKE_LEVEL;
  return Math.max(ground, level);
}

/** Signed distance to the nearest shoreline, negative offshore. */
export function sampleShore(f: HeightField, x: number, z: number): number {
  const n = f.res + 1;
  const i = Math.max(0, Math.min(f.res, Math.round((x + f.extent) / f.step)));
  const j = Math.max(0, Math.min(f.res, Math.round((z + f.extent) / f.step)));
  return f.shore[j * n + i];
}

/** Surface normal, from the field's own gradient. */
export function sampleNormal(
  f: HeightField,
  x: number,
  z: number,
  out: { x: number; y: number; z: number },
): void {
  const d = f.step;
  const hx = sampleHeight(f, x + d, z) - sampleHeight(f, x - d, z);
  const hz = sampleHeight(f, x, z + d) - sampleHeight(f, x, z - d);
  const nx = -hx;
  const nz = -hz;
  const ny = 2 * d;
  const len = Math.hypot(nx, ny, nz) || 1;
  out.x = nx / len;
  out.y = ny / len;
  out.z = nz / len;
}
