/**
 * Fog City: the map as numbers.
 *
 * Everything here is pure: where the land is, how high it is, where the roads
 * run, what stands on each block. The renderer and the game both read it, so
 * a car's wheels and the road it is drawn on can never disagree.
 *
 * The city is a regular grid on purpose. San Francisco really is a grid thrown
 * over hills with no regard for them, which is the whole look of the place,
 * and a grid is what lets the ground be one shader, the traffic one line of
 * arithmetic per car and the collision a lookup instead of a physics engine.
 *
 * Axes: +x is east, +z is south, y is up. Metres.
 */

/** Road pitch. Centre lines sit at x = i * BX and z = j * BZ. */
export const BX = 96;
export const BZ = 72;
/** Node range: i in [-IMAX, IMAX], j in [-JMAX, JMAX]. */
export const IMAX = 11;
export const JMAX = 14;
/** Half width of the carriageway, and of carriageway plus pavement. */
export const ROAD = 7;
export const WALK = 10;

export const GRID_X = IMAX * BX; // 1056
export const GRID_Z = JMAX * BZ; // 1008

/** Mainland shore. South has none: the peninsula runs off into the haze. */
export const SHORE_X = 1100;
export const SHORE_N = -1050;

/* ---------------------------------------------------------------- bridge */

/** The Golden Gate runs north from the grid road at i = -9. */
export const GG_X = -9 * BX; // -864
export const GG_Z0 = -900; // ramp starts
export const GG_Z1 = -1050; // deck leaves the land
export const GG_Z2 = -2390; // deck lands in Marin
export const GG_Z3 = -2480; // ramp ends
export const GG_DECK = 56;
export const GG_HALF = 9;
export const GG_TOWERS = [-1340, -2100];

/* ---------------------------------------------------------------- hills */

interface Hill { x: number; z: number; h: number; r: number }

const HILLS: Hill[] = [
  { x: 150, z: -250, h: 62, r: 250 }, // Nob Hill
  { x: -150, z: -580, h: 56, r: 210 }, // Russian Hill
  { x: 420, z: -756, h: 58, r: 140 }, // Telegraph Hill
  { x: -620, z: -360, h: 70, r: 290 }, // Pacific Heights
  { x: -500, z: 650, h: 135, r: 330 }, // Twin Peaks
  { x: -340, z: 60, h: 34, r: 200 }, // Alamo Square
  { x: 640, z: 620, h: 46, r: 230 }, // Potrero Hill
  { x: -864, z: -900, h: 52, r: 190 }, // Presidio bluff, under the bridge approach
];

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Height of the natural ground, analytically. Negative means under water. */
function rawHeight(x: number, z: number): number {
  // Mainland.
  const d = Math.min(x + SHORE_X, SHORE_X - x, z - SHORE_N);
  let land: number;
  if (d > 0) {
    let hills = 0;
    for (const k of HILLS) {
      const dx = x - k.x;
      const dz = z - k.z;
      hills += k.h * Math.exp(-(dx * dx + dz * dz) / (k.r * k.r));
    }
    // The bluff keeps its height right to the water so the bridge can leave it.
    const nearBridge = Math.exp(-((x - GG_X) * (x - GG_X)) / (170 * 170));
    const fade = smooth(0, 150, d);
    land = 2 + hills * Math.max(fade, nearBridge * smooth(0, 40, d));
    // South of the grid the ground rolls up into the haze.
    if (z > GRID_Z + 40) land += smooth(GRID_Z + 40, GRID_Z + 500, z) * (40 + 30 * Math.sin(x * 0.006));
  } else {
    land = Math.max(-9, d * 0.22);
  }
  // Marin headlands, north of the Gate.
  const dm = GG_Z2 + 60 - z;
  let marin = Math.max(-9, dm * 0.22);
  if (dm > 0) {
    const ridge = 70 + 45 * Math.sin(x * 0.0045 + 1.3) + 30 * Math.sin(x * 0.011);
    const road = Math.exp(-((x - GG_X) * (x - GG_X)) / (60 * 60));
    marin = 2 + (ridge * smooth(0, 320, dm)) * (1 - road * 0.75) + road * Math.min(dm * 0.55, GG_DECK - 2);
  }
  // Alcatraz.
  const ax = x - 230;
  const az = z + 1680;
  const rock = 34 * Math.exp(-(ax * ax + az * az) / (95 * 95)) - 7;
  return Math.max(land, marin, rock);
}

/* The heightfield. The renderer builds its mesh from exactly these samples and
   everything that stands on the ground interpolates the same samples, so
   nothing floats and nothing sinks. */
export const TERRAIN = { x0: -1500, z0: -2900, step: 12.5, nx: 241, nz: 353 };
let heights: Float32Array | null = null;

export function terrainSamples(): Float32Array {
  if (heights) return heights;
  const { x0, z0, step, nx, nz } = TERRAIN;
  heights = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) heights[j * nx + i] = rawHeight(x0 + i * step, z0 + j * step);
  }
  return heights;
}

/** Natural ground height, interpolated from the mesh's own samples. */
export function heightAt(x: number, z: number): number {
  const h = terrainSamples();
  const { x0, z0, step, nx, nz } = TERRAIN;
  const fx = Math.min(nx - 1.001, Math.max(0, (x - x0) / step));
  const fz = Math.min(nz - 1.001, Math.max(0, (z - z0) / step));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const a = h[j * nx + i];
  const b = h[j * nx + i + 1];
  const c = h[(j + 1) * nx + i];
  const d = h[(j + 1) * nx + i + 1];
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Height of the bridge deck at z, or -Infinity where there is no deck. */
export function deckAt(x: number, z: number): number {
  if (Math.abs(x - GG_X) > GG_HALF || z > GG_Z0 || z < GG_Z3) return -Infinity;
  if (z > GG_Z1) {
    const t = smooth(GG_Z0, GG_Z1, z);
    return heightAt(GG_X, GG_Z0) * (1 - t) + GG_DECK * t;
  }
  if (z < GG_Z2) {
    const t = smooth(GG_Z2, GG_Z3, z);
    return GG_DECK * (1 - t) + heightAt(GG_X, GG_Z3) * t;
  }
  // A gentle camber, so the deck is not a ruler.
  const m = (z - GG_Z2) / (GG_Z1 - GG_Z2);
  return GG_DECK + Math.sin(m * Math.PI) * 6;
}

/** What you stand or drive on: the ground, or the deck where there is one. */
export function groundAt(x: number, z: number): number {
  return Math.max(heightAt(x, z), deckAt(x, z));
}

/** True over the span itself, where the only thing under you is the deck. */
export function onSpan(x: number, z: number): boolean {
  return Math.abs(x - GG_X) <= GG_HALF + 3 && z < GG_Z1 + 30 && z > GG_Z2 - 30;
}

/* ---------------------------------------------------------------- blocks */

export type BlockKind = "tower" | "mid" | "homes" | "park" | "plaza" | "forest";

/** Small deterministic hash, 0..1. */
export function hash2(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h ^= h >>> 16;
  return ((h >>> 0) % 100000) / 100000;
}

export const DOWNTOWN = { x: 620, z: -330 };

/** Block (i, j) lies between nodes i..i+1 and j..j+1. */
export function blockKind(i: number, j: number): BlockKind {
  const cx = (i + 0.5) * BX;
  const cz = (j + 0.5) * BZ;
  if (cx < -690 && cz < -690) return "forest"; // the Presidio
  if (j >= 1 && j <= 2 && i <= -5) return "park"; // Golden Gate Park
  if (i === -4 && j === 0) return "park"; // Alamo Square
  if (i === 4 && j === -11) return "park"; // Coit Tower's hill
  if (i === 2 && j === 0) return "plaza"; // Civic Center
  if (Math.hypot(cx + 500, cz - 650) < 150) return "park"; // Twin Peaks summit
  const d = Math.hypot(cx - DOWNTOWN.x, cz - DOWNTOWN.z);
  if (d < 330) return "tower";
  if (d < 560) return "mid";
  const r = hash2(i * 7 + 3, j * 13 + 5);
  if (r < 0.045) return "park";
  if (r < 0.16) return "mid";
  return "homes";
}

/* ---------------------------------------------------------------- buildings */

export interface Box {
  x0: number; x1: number; z0: number; z1: number;
  /** Bottom and top, world y. */
  y0: number; y1: number;
  color: number;
  seed: number;
  /** Gabled roof on top, ridge along x (1) or z (2), or none (0). */
  gable: 0 | 1 | 2;
  /** 1 for glass towers: bigger windows. */
  glass: 0 | 1;
}

const PASTEL = [0xe8c9a0, 0xd9e2c4, 0xc7d8e6, 0xf0d9d2, 0xe9e3c8, 0xcfe3dc, 0xe6c7b8, 0xdcd3ea, 0xf2e6c2, 0xb9cfc4];
const MASONRY = [0xb9a48c, 0x9c8f82, 0xc4b6a2, 0x8d7b6c, 0xa89a8e, 0xb0705a, 0xd0c4b0];
const GLASS = [0x6f8ea6, 0x86a0b4, 0x5d7890, 0x9fb3c2, 0x74909c, 0xa9a39a];
/** The seven sisters on Steiner Street. */
const LADIES = [0xd9b44a, 0x7fa7c9, 0xe7dcc2, 0xc96f6a, 0x8fb99a, 0xb7a3d0, 0xe9a98b];

let boxes: Box[] | null = null;
let boxGrid: Map<number, Box[]> | null = null;

const cellKey = (i: number, j: number): number => (i + 64) * 256 + (j + 64);

/** Reserved lots: a landmark stands here, so no ordinary building does. */
export const PYRAMID = { x: 5.5 * BX, z: -5.5 * BZ, half: 24, h: 235 };
export const SPIRE = { x: 7.5 * BX, z: -3.5 * BZ, half: 22, h: 300 };
export const COIT = { x: 4.5 * BX, z: -10.5 * BZ, r: 6, h: 58 };
export const SUTRO = { x: -5.5 * BX, z: 9.5 * BZ, h: 150 };
export const CITY_HALL = { x: 2.5 * BX, z: 0.5 * BZ };
export const FERRY = { x: 1082, z: -3.5 * BZ, h: 66 };
/** The Painted Ladies face the park across the road at i = -3. */
export const LADIES_BLOCK = { i: -3, j: 0 };

function lowest(x0: number, x1: number, z0: number, z1: number): number {
  return Math.min(heightAt(x0, z0), heightAt(x1, z0), heightAt(x0, z1), heightAt(x1, z1));
}

function generate(): void {
  boxes = [];
  const out = boxes;
  const push = (b: Omit<Box, "y0" | "y1"> & { h: number }): void => {
    const y0 = lowest(b.x0, b.x1, b.z0, b.z1) - 1.5;
    const top = Math.max(heightAt((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2), y0 + 1.5) + b.h;
    out.push({ x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y0, y1: top, color: b.color, seed: b.seed, gable: b.gable, glass: b.glass });
  };

  for (let i = -IMAX; i < IMAX; i++) {
    for (let j = -JMAX; j < JMAX; j++) {
      const kind = blockKind(i, j);
      const bx0 = i * BX + WALK + 1;
      const bx1 = (i + 1) * BX - WALK - 1;
      const bz0 = j * BZ + WALK + 1;
      const bz1 = (j + 1) * BZ - WALK - 1;
      const r = (n: number): number => hash2(i * 31 + n * 17, j * 57 + n * 3);
      const cx = (bx0 + bx1) / 2;
      const cz = (bz0 + bz1) / 2;

      if (kind === "park" || kind === "forest" || kind === "plaza") continue;

      if (kind === "tower") {
        if (Math.abs(cx - PYRAMID.x) < 2 && Math.abs(cz - PYRAMID.z) < 2) continue;
        const d = Math.hypot(cx - DOWNTOWN.x, cz - DOWNTOWN.z);
        const peak = 190 * (1 - d / 360) + 40;
        if (Math.abs(cx - SPIRE.x) < 2 && Math.abs(cz - SPIRE.z) < 2) {
          push({ x0: cx - SPIRE.half, x1: cx + SPIRE.half, z0: cz - SPIRE.half, z1: cz + SPIRE.half, h: SPIRE.h, color: 0x7d9fb8, seed: 0.77, gable: 0, glass: 1 });
          continue;
        }
        // Two towers and a podium, or one big one.
        if (r(1) < 0.45) {
          const h = peak * (0.6 + r(2) * 0.6);
          push({ x0: bx0 + 4, x1: bx1 - 4, z0: bz0 + 3, z1: bz1 - 3, h: 14 + r(3) * 10, color: MASONRY[Math.floor(r(4) * MASONRY.length)], seed: r(5), gable: 0, glass: 0 });
          push({ x0: cx - 17, x1: cx + 17, z0: cz - 14, z1: cz + 14, h, color: GLASS[Math.floor(r(6) * GLASS.length)], seed: r(7), gable: 0, glass: 1 });
        } else {
          const mid = bx0 + (bx1 - bx0) * (0.42 + r(8) * 0.16);
          const hA = peak * (0.35 + r(9) * 0.75);
          const hB = peak * (0.35 + r(10) * 0.75);
          push({ x0: bx0 + 2, x1: mid - 3, z0: bz0 + 2, z1: bz1 - 2, h: hA, color: (r(11) < 0.6 ? GLASS : MASONRY)[Math.floor(r(12) * 6)], seed: r(13), gable: 0, glass: r(11) < 0.6 ? 1 : 0 });
          push({ x0: mid + 3, x1: bx1 - 2, z0: bz0 + 2, z1: bz1 - 2, h: hB, color: (r(14) < 0.6 ? GLASS : MASONRY)[Math.floor(r(15) * 6)], seed: r(16), gable: 0, glass: r(14) < 0.6 ? 1 : 0 });
        }
        continue;
      }

      if (kind === "mid") {
        const n = 3;
        const w = (bx1 - bx0) / n;
        for (let a = 0; a < n; a++) {
          for (let b = 0; b < 2; b++) {
            const h = 14 + r(20 + a * 2 + b) * 26;
            const z0 = b === 0 ? bz0 : cz + 3;
            const z1 = b === 0 ? cz - 3 : bz1;
            push({ x0: bx0 + a * w + 0.6, x1: bx0 + (a + 1) * w - 0.6, z0, z1, h, color: MASONRY[Math.floor(r(30 + a * 2 + b) * MASONRY.length)], seed: r(40 + a * 2 + b), gable: 0, glass: 0 });
          }
        }
        continue;
      }

      // Homes: two rows of narrow houses, back to back, with yards between.
      const ladies = i === LADIES_BLOCK.i && j === LADIES_BLOCK.j;
      const n = 7;
      const w = (bx1 - bx0) / n;
      if (ladies) {
        // Seven in a row along the west edge, facing the park, gables to the street.
        const lw = (bz1 - bz0) / 7;
        for (let a = 0; a < 7; a++) {
          push({ x0: bx0, x1: bx0 + 15, z0: bz0 + a * lw + 0.5, z1: bz0 + (a + 1) * lw - 0.5, h: 11.5, color: LADIES[a], seed: 0.1 + a * 0.11, gable: 1, glass: 0 });
        }
        for (let a = 0; a < 4; a++) {
          push({ x0: bx0 + 30 + a * 11.5, x1: bx0 + 40 + a * 11.5, z0: bz0, z1: bz0 + 17, h: 9 + r(50 + a) * 4, color: PASTEL[Math.floor(r(60 + a) * PASTEL.length)], seed: r(70 + a), gable: 2, glass: 0 });
          push({ x0: bx0 + 30 + a * 11.5, x1: bx0 + 40 + a * 11.5, z0: bz1 - 17, z1: bz1, h: 9 + r(54 + a) * 4, color: PASTEL[Math.floor(r(64 + a) * PASTEL.length)], seed: r(74 + a), gable: 2, glass: 0 });
        }
        continue;
      }
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < 2; b++) {
          const h = 8 + r(80 + a * 2 + b) * 5.5;
          const z0 = b === 0 ? bz0 : bz1 - 17;
          const z1 = b === 0 ? bz0 + 17 : bz1;
          const flat = r(100 + a * 2 + b) < 0.35;
          push({ x0: bx0 + a * w + 0.35, x1: bx0 + (a + 1) * w - 0.35, z0, z1, h, color: PASTEL[Math.floor(r(120 + a * 2 + b) * PASTEL.length)], seed: r(140 + a * 2 + b), gable: flat ? 0 : 2, glass: 0 });
        }
      }
    }
  }

  // Landmarks that need to be solid.
  const solid = (x: number, z: number, half: number, h: number): void => {
    const y0 = heightAt(x, z) - 1;
    out.push({ x0: x - half, x1: x + half, z0: z - half, z1: z + half, y0, y1: y0 + h, color: 0, seed: -1, gable: 0, glass: 0 });
  };
  solid(PYRAMID.x, PYRAMID.z, PYRAMID.half * 0.8, 60);
  solid(COIT.x, COIT.z, COIT.r, COIT.h);
  solid(SUTRO.x, SUTRO.z, 5, 40);
  out.push({ x0: CITY_HALL.x - 26, x1: CITY_HALL.x + 26, z0: CITY_HALL.z - 12, z1: CITY_HALL.z + 12, y0: heightAt(CITY_HALL.x, CITY_HALL.z) - 1, y1: heightAt(CITY_HALL.x, CITY_HALL.z) + 20, color: 0, seed: -1, gable: 0, glass: 0 });
  out.push({ x0: FERRY.x - 7, x1: FERRY.x + 7, z0: FERRY.z - 60, z1: FERRY.z + 60, y0: 0, y1: 16, color: 0, seed: -1, gable: 0, glass: 0 });
  for (const tz of GG_TOWERS) {
    for (const sx of [-1, 1]) solid(GG_X + sx * (GG_HALF + 3.5), tz, 3.2, 200);
  }

  boxGrid = new Map();
  for (const b of out) {
    const i0 = Math.floor(b.x0 / BX);
    const i1 = Math.floor(b.x1 / BX);
    const j0 = Math.floor(b.z0 / BZ);
    const j1 = Math.floor(b.z1 / BZ);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = cellKey(i, j);
        let list = boxGrid.get(k);
        if (!list) boxGrid.set(k, (list = []));
        list.push(b);
      }
    }
  }
}

/** Every solid box in the city. Boxes with seed < 0 are landmark colliders, not drawn. */
export function allBoxes(): Box[] {
  if (!boxes) generate();
  return boxes!;
}

const EMPTY: Box[] = [];

/** Boxes that could touch a circle at (x, z). */
export function boxesNear(x: number, z: number): Box[] {
  if (!boxGrid) generate();
  return boxGrid!.get(cellKey(Math.floor(x / BX), Math.floor(z / BZ))) ?? EMPTY;
}

/**
 * Push a circle out of every building it overlaps. Returns true if it touched
 * one. `y` is the height of the thing's feet: a box whose roof is below them
 * is not in the way.
 */
export function resolveCircle(p: { x: number; z: number }, radius: number, y: number): boolean {
  let hit = false;
  // A circle near a cell edge can touch boxes filed under the neighbour.
  for (let pass = 0; pass < 2; pass++) {
    const list = pass === 0 ? boxesNear(p.x, p.z) : boxesNear(p.x + (p.x % BX > BX / 2 ? radius : -radius), p.z + (p.z % BZ > BZ / 2 ? radius : -radius));
    for (const b of list) {
      if (y > b.y1 - 0.3) continue;
      const nx = Math.max(b.x0, Math.min(p.x, b.x1));
      const nz = Math.max(b.z0, Math.min(p.z, b.z1));
      const dx = p.x - nx;
      const dz = p.z - nz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= radius * radius) continue;
      hit = true;
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        p.x = nx + (dx / d) * radius;
        p.z = nz + (dz / d) * radius;
      } else {
        // Centre is inside: leave by the nearest wall.
        const l = p.x - b.x0;
        const r = b.x1 - p.x;
        const t = p.z - b.z0;
        const u = b.z1 - p.z;
        const m = Math.min(l, r, t, u);
        if (m === l) p.x = b.x0 - radius;
        else if (m === r) p.x = b.x1 + radius;
        else if (m === t) p.z = b.z0 - radius;
        else p.z = b.z1 + radius;
      }
    }
  }
  return hit;
}

/** Is this point inside a building, below its roof? For the camera boom. */
export function insideBox(x: number, y: number, z: number): boolean {
  for (const b of boxesNear(x, z)) {
    if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && y < b.y1 && y > b.y0) return true;
  }
  return false;
}

/* ---------------------------------------------------------------- places */

export interface Place { key: string; name: string; x: number; z: number; r: number; job: boolean }

/** Landmarks to discover, and the stops a courier run goes between. All on a road. */
export const PLACES: Place[] = [
  { key: "ladies", name: "The Painted Ladies", x: -3 * BX, z: 0.5 * BZ, r: 45, job: true },
  { key: "pyramid", name: "The Pyramid", x: 5 * BX, z: -5.5 * BZ, r: 45, job: true },
  { key: "coit", name: "Coit Tower", x: 4 * BX, z: -10.5 * BZ, r: 50, job: true },
  { key: "ferry", name: "The Ferry Building", x: 11 * BX, z: -3.5 * BZ, r: 45, job: true },
  { key: "peaks", name: "Twin Peaks", x: -5 * BX, z: 9.5 * BZ, r: 55, job: true },
  { key: "beach", name: "Ocean Beach", x: -11 * BX, z: 1.5 * BZ, r: 45, job: true },
  { key: "hall", name: "City Hall", x: 2 * BX, z: 0.5 * BZ, r: 45, job: true },
  { key: "ballpark", name: "The Ballpark", x: 10 * BX, z: 5 * BZ, r: 45, job: true },
  { key: "nob", name: "Nob Hill", x: 2 * BX, z: -3.5 * BZ, r: 45, job: true },
  { key: "gate", name: "The Golden Gate", x: GG_X, z: (GG_Z1 + GG_Z2) / 2, r: 300, job: false },
  { key: "vista", name: "Marin Vista Point", x: GG_X, z: GG_Z3 - 10, r: 45, job: true },
];

/** On the park side of Steiner, looking east at the Painted Ladies and downtown behind them. */
export const SPAWN = { x: -3 * BX - 8.6, z: 0.72 * BZ, heading: Math.PI / 2 };

/** True if node (i, j) is a real intersection. */
export function nodeOk(i: number, j: number): boolean {
  return Math.abs(i) <= IMAX && Math.abs(j) <= JMAX;
}
