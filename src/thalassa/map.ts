/**
 * The map of Thalassa: where the land is, how high it stands, and what it is
 * made of. Everything else in the world reads from here: the terrain mesh, the
 * water's depth colour, where houses may stand, where the walls run, and the
 * floor the player walks on.
 *
 * The layout is the reference painting read as a plan, north at -z:
 *
 *   - a walled town wrapped round a turquoise bay, with a paved quay between
 *     the water and the walls, and the town on a terrace behind them
 *   - an upper town on a rise to the north-west, with its own small temple
 *   - a grassy peninsula on the bay's east side, ending in a rocky knoll
 *   - a stone bridge from the knoll to a cliff island with a temple on top
 *   - an inlet to the north-east between white cliffs, and open sea beyond
 *   - green hills behind the town and grey mountains behind those
 *
 * Coastlines are polygons, rounded by Chaikin subdivision and roughened by
 * noise. Signed distances to them are computed once on a coarse grid and the
 * height on a finer one, so `heightAt` is a bilinear lookup and costs nothing
 * per call.
 */
import { fbm2, ridged2, smoothstep, clamp } from "@/shared/proc/rng";

export type V2 = [number, number];

/** Half-size of the terrain, in metres. The walkable world is smaller. */
export const EXTENT = 520;
/** Where the player is allowed to go. */
export const WALK_LIMIT = 228;
export const QUAY_Y = 1.6;
export const TERRACE_Y = 6.2;

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

function chaikin(poly: V2[], iterations = 3): V2[] {
  let p = poly;
  for (let k = 0; k < iterations; k++) {
    const out: V2[] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    p = out;
  }
  return p;
}

/** The mainland, including the peninsula; the bay is carved out of it. */
const MAIN_RAW: V2[] = [
  [-900, -900], [64, -900], [72, -320], [64, -210], [70, -140], [60, -88], [68, -50],
  [84, -26], [100, -8], [109, 10], [106, 28], [96, 42], [82, 56], [66, 62],
  [50, 74], [38, 86], [34, 97], [4, 101], [-40, 107], [-92, 118], [-160, 134],
  [-260, 150], [-900, 165],
];

/** The bay. It reaches past the coast to the south-east, which is its mouth. */
const BAY_RAW: V2[] = [
  [46, -4], [28, -12], [-4, -15], [-34, -14], [-54, -8], [-64, 6], [-67, 28],
  [-65, 50], [-57, 66], [-40, 76], [-12, 80], [16, 80], [34, 76], [52, 70],
  [84, 74], [88, 60], [64, 50], [52, 38], [47, 18],
];

/** Across the inlet: white cliffs and high ground. */
const EAST_RAW: V2[] = [
  [122, -900], [900, -900], [900, -132], [270, -118], [206, -98], [158, -90],
  [134, -108], [122, -158], [128, -222], [118, -320],
];

export const MAIN = chaikin(MAIN_RAW);
export const BAY = chaikin(BAY_RAW);
export const EAST = chaikin(EAST_RAW);

/** The temple island: a rock with a flat top, a ledge round its foot. */
export const ISLE = { x: 152, z: 22 };
export function isleRadius(a: number): number {
  return 30 + 2.6 * Math.sin(3 * a + 0.4) + 1.8 * Math.sin(5 * a + 1.3) + 1.1 * Math.sin(9 * a);
}
export const ISLE_TOP = 27;
export const ISLE_LEDGE = 8.5;
/** The stair that winds up the island, by angle (atan2(z - cz, x - cx)). */
export const ISLE_STAIR = { a0: Math.PI * 0.99, a1: Math.PI * 0.42, inner: 7.2, outer: 11.2 };

/** Sea stacks and an islet, for the composition. */
export const STACKS: Array<{ x: number; z: number; r: number; h: number }> = [
  { x: 194, z: 46, r: 6.5, h: 21 },
  { x: 204, z: 30, r: 4.2, h: 15 },
  { x: 187, z: 62, r: 3.4, h: 9 },
  { x: 118, z: 104, r: 9, h: 3.4 },
  { x: 160, z: -40, r: 5, h: 6 },
];

/** The upper town's plateau. */
export const ACROPOLIS = { x: -96, z: -64, r: 30, y: 15.5 };
/** The knoll at the end of the peninsula, where the bridge starts. */
export const KNOLL = { x: 100, z: 18, y: 9.5 };
/** A hill west of town, high enough to see the whole painting from. */
export const OVERLOOK = { x: -176, z: 54, y: 34 };

export const BRIDGE = {
  a: { x: 103, z: 19 },
  b: { x: 126, z: 23 },
  ya: 9.5,
  yb: ISLE_LEDGE,
  width: 5.2,
};

export const MOLE = {
  a: { x: 26, z: 89 },
  b: { x: 58, z: 82 },
  width: 6.5,
  y: QUAY_Y + 0.4,
};

/** Dirt paths over the grass, as polylines. */
export const PATHS: V2[][] = [
  [[24, -40], [44, -34], [62, -22], [78, -6], [90, 8], [101, 18]],
  [[-92, 22], [-118, 30], [-140, 42], [-160, 50], [-176, 54]],
  [[-96, -96], [-90, -122], [-76, -150], [-70, -180]],
  [[44, -34], [56, -60], [60, -96]],
  [[-110, 40], [-112, 70], [-100, 92]],
];

export function pathDist(x: number, z: number): number {
  let d = Infinity;
  for (const path of PATHS) {
    for (let i = 0; i < path.length - 1; i++) {
      const [ax, az] = path[i], [bx, bz] = path[i + 1];
      const ex = bx - ax, ez = bz - az;
      const t = clamp(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez), 0, 1);
      d = Math.min(d, Math.hypot(x - ax - ex * t, z - az - ez * t));
    }
  }
  return d + fbm2(x * 0.15, z * 0.15, 2, 2, 0.5, 21) * 0.8;
}

/* ------------------------------------------------------------------ *
 * Signed distance
 * ------------------------------------------------------------------ */

/** Signed distance to a polygon: negative inside. */
export function sdPoly(px: number, pz: number, poly: V2[]): number {
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j][0], az = poly[j][1], bx = poly[i][0], bz = poly[i][1];
    const ex = bx - ax, ez = bz - az, wx = px - ax, wz = pz - az;
    const t = clamp((wx * ex + wz * ez) / (ex * ex + ez * ez), 0, 1);
    const dx = wx - ex * t, dz = wz - ez * t;
    const dd = dx * dx + dz * dz;
    if (dd < d) d = dd;
    if ((az > pz) !== (bz > pz) && px < (bx - ax) * (pz - az) / (bz - az) + ax) inside = !inside;
  }
  return inside ? -Math.sqrt(d) : Math.sqrt(d);
}

/* Coarse grids of the three distances that matter, so everything downstream
   is a lookup. 4 m cells; the fields are smooth enough to interpolate. */
const SD_CELL = 4;
const SD_N = Math.round((EXTENT * 2) / SD_CELL) + 1;

function sdGrid(poly: V2[]): Float32Array {
  const g = new Float32Array(SD_N * SD_N);
  for (let j = 0; j < SD_N; j++) {
    const z = -EXTENT + j * SD_CELL;
    for (let i = 0; i < SD_N; i++) {
      const x = -EXTENT + i * SD_CELL;
      g[j * SD_N + i] = sdPoly(x, z, poly);
    }
  }
  return g;
}

function sample(g: Float32Array, n: number, cell: number, x: number, z: number): number {
  const fx = clamp((x + EXTENT) / cell, 0, n - 1.001);
  const fz = clamp((z + EXTENT) / cell, 0, n - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz);
  const tx = fx - i, tz = fz - j;
  const a = g[j * n + i], b = g[j * n + i + 1], c = g[(j + 1) * n + i], d = g[(j + 1) * n + i + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

let SD_MAIN: Float32Array | null = null;
let SD_BAY: Float32Array | null = null;
let SD_EAST: Float32Array | null = null;

function ensureSd() {
  if (SD_MAIN) return;
  SD_MAIN = sdGrid(MAIN);
  SD_BAY = sdGrid(BAY);
  SD_EAST = sdGrid(EAST);
}

/** Positive inside the mainland polygon (ignoring the bay). */
export function sMainland(x: number, z: number): number { ensureSd(); return -sample(SD_MAIN!, SD_N, SD_CELL, x, z); }
/** Positive inside the bay. Near the bay it is exact enough to build to. */
export function sBay(x: number, z: number): number {
  ensureSd();
  // Exact near the shore, where the quay is built against it.
  const c = sample(SD_BAY!, SD_N, SD_CELL, x, z);
  if (Math.abs(c) < 30) return -sdPoly(x, z, BAY);
  return -c;
}
function sBayFast(x: number, z: number): number { ensureSd(); return -sample(SD_BAY!, SD_N, SD_CELL, x, z); }
export function sEast(x: number, z: number): number { ensureSd(); return -sample(SD_EAST!, SD_N, SD_CELL, x, z); }

/** How far inside the island's outline, by its radial profile. */
export function sIsle(x: number, z: number): number {
  const dx = x - ISLE.x, dz = z - ISLE.z;
  return isleRadius(Math.atan2(dz, dx)) - Math.hypot(dx, dz);
}

/** 1 in the town, 0 out on the peninsula. */
export function townMask(x: number, z: number): number {
  return smoothstep(56, 42, x);
}

/** How wide the quay is: the north side is the market and gets more room. */
export function quayWidth(x: number, z: number): number {
  return 14 + 8 * smoothstep(4, -12, z) * smoothstep(40, 20, x);
}

/* ------------------------------------------------------------------ *
 * Gates: ramps from the quay up through the wall into the town
 * ------------------------------------------------------------------ */

export interface Gate { x: number; z: number; nx: number; nz: number; qw: number; name: string }

/** Approximate places on the shore; each is snapped to the bay and given a normal. */
const GATE_SEEDS: Array<[number, number, string]> = [
  [-66, 26, "West Gate"],
  [-36, -15, "Market Gate"],
  [14, -14, "North Gate"],
  [-56, 64, "South Gate"],
];

export const GATES: Gate[] = [];

/** Outward (into the land) unit normal of the bay at a point, from the field's gradient. */
export function bayNormal(x: number, z: number): [number, number] {
  const e = 0.6;
  const gx = sBay(x + e, z) - sBay(x - e, z);
  const gz = sBay(x, z + e) - sBay(x, z - e);
  const l = Math.hypot(gx, gz) || 1;
  // sBay grows into the water, so outward is minus the gradient.
  return [-gx / l, -gz / l];
}

function buildGates() {
  if (GATES.length) return;
  for (const [sx, sz, name] of GATE_SEEDS) {
    // Snap to the shore: walk along the gradient until the distance is zero.
    let x = sx, z = sz;
    for (let k = 0; k < 12; k++) {
      const s = sBay(x, z);
      const [nx, nz] = bayNormal(x, z);
      x += nx * s; z += nz * s;
    }
    const [nx, nz] = bayNormal(x, z);
    GATES.push({ x, z, nx, nz, qw: quayWidth(x, z), name });
  }
}

/** Ramp height through a gate, or NaN if (x, z) is not on one. */
function gateRamp(x: number, z: number): { h: number; w: number } | null {
  for (const g of GATES) {
    const dx = x - g.x, dz = z - g.z;
    const v = dx * g.nx + dz * g.nz; // out from the shore
    const u = -dx * g.nz + dz * g.nx; // along the shore
    const v0 = g.qw - 9, v1 = g.qw + 6;
    if (v < v0 - 1 || v > v1 + 4 || Math.abs(u) > 4.2) continue;
    const t = clamp((v - v0) / (v1 - v0), 0, 1);
    const h = QUAY_Y + (TERRACE_Y - QUAY_Y) * t;
    // Full strength across the stair, fading over its last metre either side.
    const w = smoothstep(4.2, 2.8, Math.abs(u)) * smoothstep(v0 - 1, v0, v) * (v > v1 ? smoothstep(v1 + 4, v1, v) : 1);
    return { h, w };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Height
 * ------------------------------------------------------------------ */

function hills(x: number, z: number): number {
  const rolling = fbm2(x * 0.011, z * 0.011, 4, 2, 0.5, 11) * 14 + fbm2(x * 0.04, z * 0.04, 3, 2, 0.5, 12) * 2.5;
  // Mountains to the north, grey ridges.
  const north = smoothstep(-110, -300, z);
  const ridge = ridged2(x * 0.007, z * 0.007, 4, 13) * 58 * north;
  // A shoulder of hill west of town that the overlook stands on.
  const ov = Math.hypot(x - OVERLOOK.x, z - OVERLOOK.z);
  const overlook = 22 * (1 - smoothstep(0, 85, ov));
  return 10 + rolling + ridge + overlook;
}

/** The raw height, before it is baked into the grid. */
function rawHeight(x: number, z: number): number {
  const sm = sMainland(x, z);
  const sb = Math.abs(x - 0) < 140 && Math.abs(z - 30) < 120 ? sBay(x, z) : sBayFast(x, z);
  const se = sEast(x, z);
  const si = sIsle(x, z);
  const coastNoise = fbm2(x * 0.06, z * 0.06, 3, 2, 0.5, 5) * 2.2;

  let best = seaFloor(x, z, sm, sb, se, si);

  /* ---- the temple island ---- */
  if (si > -18) {
    const a = Math.atan2(z - ISLE.z, x - ISLE.x);
    const strata = Math.floor(fbm2(a * 3, 0.5, 2, 2, 0.5, 7) * 3) * 0.8;
    let h: number;
    if (si > 10.5) h = ISLE_TOP;
    else if (si > 6.5) {
      // The cliff: steep, with a stratum or two so it reads as layered rock.
      const t = (si - 6.5) / 4;
      h = ISLE_LEDGE + (ISLE_TOP - ISLE_LEDGE) * smoothstep(0, 1, t) + strata * Math.sin(t * Math.PI);
    } else if (si > 0.5) h = ISLE_LEDGE + strata * 0.3 + fbm2(x * 0.2, z * 0.2, 2, 2, 0.5, 8) * 0.6 * smoothstep(1, 3, si);
    else h = ISLE_LEDGE * smoothstep(-4, 0.5, si) - 6 * smoothstep(0, -16, si) - 1.5;
    // The winding stair.
    const st = ISLE_STAIR;
    if (si > st.inner - 1 && si < st.outer + 1 && a <= st.a0 && a >= st.a1) {
      const t = (st.a0 - a) / (st.a0 - st.a1);
      const rh = ISLE_LEDGE + (ISLE_TOP - ISLE_LEDGE) * t;
      const w = smoothstep(st.inner - 1, st.inner, si) * smoothstep(st.outer + 1, st.outer, si);
      h = h * (1 - w) + rh * w;
    }
    best = Math.max(best, h);
  }

  /* ---- sea stacks ---- */
  for (const s of STACKS) {
    const d = Math.hypot(x - s.x, z - s.z) - s.r - fbm2(x * 0.3, z * 0.3, 2, 2, 0.5, 9) * 1.2;
    if (d < 4) {
      const top = s.h + fbm2(x * 0.2, z * 0.2, 2, 2, 0.5, 10) * 1.2;
      best = Math.max(best, d < 0 ? top : top * smoothstep(4, 0, d) - 4 * smoothstep(0, 4, d));
    }
  }

  const landM = Math.min(sm, -sb);
  /* ---- the mainland ---- */
  if (landM > -0.01) {
    const dB = -sb; // distance from the bay, into the land
    const qw = quayWidth(x, z);
    const town = townMask(x, z);
    const stepMask = 1 - smoothstep(62, 74, z) * smoothstep(-115, -75, x);
    let tH = QUAY_Y + (TERRACE_Y - QUAY_Y) * smoothstep(qw + 0.5, qw + 1.7, dB) * stepMask;
    // The terrace climbs gently inland, then into the hills.
    tH += smoothstep(qw + 14, qw + 70, dB) * 3 * stepMask;
    const acro = Math.hypot(x - ACROPOLIS.x, z - ACROPOLIS.z);
    tH += (ACROPOLIS.y - TERRACE_Y - 3 * smoothstep(qw + 14, qw + 70, dB)) * (1 - smoothstep(ACROPOLIS.r - 2, ACROPOLIS.r + 30, acro)) * stepMask;
    const out = smoothstep(qw + 45, qw + 120, dB);
    const acroKeep = 1 - smoothstep(ACROPOLIS.r, ACROPOLIS.r + 20, acro);
    tH = tH + (Math.max(tH, hills(x, z)) - tH) * out * (1 - acroKeep);
    // A gate's ramp overrides the step.
    const g = gateRamp(x, z);
    if (g) tH = tH * (1 - g.w) + g.h * g.w;

    // The peninsula: rolling grass rising to the knoll.
    const kd = Math.hypot(x - KNOLL.x, z - KNOLL.z);
    let pH = 2.6 + fbm2(x * 0.035, z * 0.035, 3, 2, 0.5, 14) * 2.2 + 3.2 * smoothstep(-6, -60, z);
    pH = Math.max(pH, KNOLL.y * (1 - smoothstep(6, 20, kd)) + pH * smoothstep(6, 20, kd));
    // The peninsula meets the bay with rocks, not a quay.
    pH *= smoothstep(-0.2, 5, dB) * 0.6 + 0.4;

    let h = pH + (tH - pH) * town;
    // Out from the town, everything becomes hills.
    if (town < 1) h = Math.max(h, hills(x, z) * smoothstep(-40, -110, z) * (1 - town));

    // Sea-facing coasts are cliffs; the bay side of the town is a quay.
    const cliff = smoothstep(0, 4.5 + coastNoise, sm);
    const bayEdge = town > 0.5 ? 1 : smoothstep(0, 3.5, dB);
    h = -2.4 + (h + 2.4) * Math.min(cliff, bayEdge);
    best = Math.max(best, h);
  }

  /* ---- across the inlet ---- */
  if (se > -0.01) {
    const h = 12 + 34 * smoothstep(0, 140, se) + fbm2(x * 0.02, z * 0.02, 4, 2, 0.5, 15) * 12 + ridged2(x * 0.008, z * 0.008, 3, 16) * 38 * smoothstep(-150, -320, z);
    best = Math.max(best, -2.4 + (h + 2.4) * smoothstep(0, 5 + coastNoise, se));
  }

  return best;
}

function seaFloor(x: number, z: number, sm: number, sb: number, se: number, si: number): number {
  // Distance to the nearest land, negative.
  const near = Math.max(Math.min(sm, -sb), se, si);
  const inBay = sb > 0 && sm > -20;
  const k = inBay ? 0.2 : 0.3;
  const d = -1.4 + Math.min(0, near) * k + fbm2(x * 0.05, z * 0.05, 2, 2, 0.5, 6) * 0.8;
  return Math.max(d, inBay ? -8.5 : -26);
}

/* The baked height: 1.25 m cells over the walkable core, 5 m beyond. */
const H_CELL = 1.25;
const H_HALF = 260;
const H_N = Math.round((H_HALF * 2) / H_CELL) + 1;
const F_CELL = 5;
const F_N = Math.round((EXTENT * 2) / F_CELL) + 1;
let H_GRID: Float32Array | null = null;
let F_GRID: Float32Array | null = null;

export function buildMap(): void {
  if (H_GRID) return;
  ensureSd();
  buildGates();
  H_GRID = new Float32Array(H_N * H_N);
  for (let j = 0; j < H_N; j++) {
    const z = -H_HALF + j * H_CELL;
    for (let i = 0; i < H_N; i++) H_GRID[j * H_N + i] = rawHeight(-H_HALF + i * H_CELL, z);
  }
  F_GRID = new Float32Array(F_N * F_N);
  for (let j = 0; j < F_N; j++) {
    const z = -EXTENT + j * F_CELL;
    for (let i = 0; i < F_N; i++) {
      const x = -EXTENT + i * F_CELL;
      F_GRID[j * F_N + i] = Math.abs(x) < H_HALF - 2 && Math.abs(z) < H_HALF - 2 ? 0 : rawHeight(x, z);
    }
  }
  // Fill the far grid's core from the near one, so a lookup across the seam agrees.
  for (let j = 0; j < F_N; j++) {
    const z = -EXTENT + j * F_CELL;
    for (let i = 0; i < F_N; i++) {
      const x = -EXTENT + i * F_CELL;
      if (Math.abs(x) < H_HALF - 2 && Math.abs(z) < H_HALF - 2) F_GRID[j * F_N + i] = nearHeight(x, z);
    }
  }
}

function nearHeight(x: number, z: number): number {
  const fx = (x + H_HALF) / H_CELL, fz = (z + H_HALF) / H_CELL;
  const i = Math.floor(fx), j = Math.floor(fz);
  const tx = fx - i, tz = fz - j;
  const g = H_GRID!;
  const a = g[j * H_N + i], b = g[j * H_N + i + 1], c = g[(j + 1) * H_N + i], d = g[(j + 1) * H_N + i + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

/** The terrain's height. Water is at y = 0. */
export function heightAt(x: number, z: number): number {
  if (!H_GRID) buildMap();
  if (Math.abs(x) < H_HALF - 1.5 && Math.abs(z) < H_HALF - 1.5) return nearHeight(x, z);
  return sample(F_GRID!, F_N, F_CELL, x, z);
}

/* ------------------------------------------------------------------ *
 * What the ground is
 * ------------------------------------------------------------------ */

export const enum Ground { Sea, Sand, Paving, Grass, Dirt, Rock, Cliff }

/** Surface type for colouring, grass and placement. */
export function groundType(x: number, z: number, h = heightAt(x, z), slope = slopeAt(x, z)): Ground {
  if (h < -0.3) return Ground.Sea;
  const sb = sBay(x, z);
  const town = townMask(x, z);
  if (town > 0.5 && -sb < quayWidth(x, z) + 1.5 && -sb > -1 && z < 98) return Ground.Paving;
  if (Math.hypot(x - ACROPOLIS.x, z - ACROPOLIS.z) < ACROPOLIS.r - 4) return Ground.Paving;
  if (slope > 1.1) return Ground.Cliff;
  if (slope > 0.8) return Ground.Rock;
  if (h < 1.1) return Ground.Sand;
  if (pathDist(x, z) < 1.6) return Ground.Dirt;
  if (sIsle(x, z) > 0 && h > 7) return h > ISLE_TOP - 1 ? Ground.Grass : Ground.Rock;
  if (z < -150 && h > 62) return Ground.Rock;
  return Ground.Grass;
}

export function slopeAt(x: number, z: number): number {
  const e = 1.2;
  const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  return Math.hypot(gx, gz);
}

/** Is this spot in the town's walls, where houses go? */
export function inTown(x: number, z: number): boolean {
  if (townMask(x, z) < 0.9) return false;
  const dB = -sBay(x, z);
  const qw = quayWidth(x, z);
  if (z > 66) return false;
  const acro = Math.hypot(x - ACROPOLIS.x, z - ACROPOLIS.z);
  return (dB > qw + 3 && dB < qw + 52) || acro < ACROPOLIS.r + 18;
}

/* ------------------------------------------------------------------ *
 * Lines along the shore
 * ------------------------------------------------------------------ */

/** Points along the bay's shore, every `step` metres, with the outward normal. */
export function shoreSamples(step = 1.5): Array<{ x: number; z: number; nx: number; nz: number; s: number }> {
  const out: Array<{ x: number; z: number; nx: number; nz: number; s: number }> = [];
  let s = 0;
  for (let i = 0; i < BAY.length; i++) {
    const a = BAY[i], b = BAY[(i + 1) % BAY.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      // Only the parts of the bay that are actually shore.
      if (sMainland(x, z) > 0.5) {
        const [nx, nz] = bayNormal(x, z);
        out.push({ x, z, nx, nz, s });
      }
      s += len / n;
    }
  }
  return out;
}

/** A line at a fixed distance from the bay, as runs of points, split where it leaves the town. */
export function offsetLine(dist: (x: number, z: number) => number, keep: (x: number, z: number) => boolean, step = 1.5): Array<Array<{ x: number; z: number }>> {
  const runs: Array<Array<{ x: number; z: number }>> = [];
  let run: Array<{ x: number; z: number }> = [];
  let last: { x: number; z: number } | null = null;
  for (const p of shoreSamples(step)) {
    const d = dist(p.x, p.z);
    let x = p.x + p.nx * d, z = p.z + p.nz * d;
    // Refine onto the contour (an offset from a concave corner overshoots).
    for (let k = 0; k < 4; k++) {
      const [nx, nz] = bayNormal(x, z);
      const e = d - -sBay(x, z);
      x += nx * e; z += nz * e;
    }
    const ok = keep(x, z);
    if (!ok) { if (run.length > 1) runs.push(run); run = []; last = null; continue; }
    if (last && Math.hypot(x - last.x, z - last.z) < step * 0.6) continue;
    if (last && Math.hypot(x - last.x, z - last.z) > step * 4) { if (run.length > 1) runs.push(run); run = []; }
    run.push({ x, z });
    last = { x, z };
  }
  if (run.length > 1) runs.push(run);
  return runs.map(smoothRun);
}

function smoothRun(run: Array<{ x: number; z: number }>): Array<{ x: number; z: number }> {
  let r = run;
  for (let k = 0; k < 2; k++) {
    r = r.map((p, i) => {
      if (i === 0 || i === r.length - 1) return p;
      return { x: (r[i - 1].x + p.x * 2 + r[i + 1].x) / 4, z: (r[i - 1].z + p.z * 2 + r[i + 1].z) / 4 };
    });
  }
  return r;
}

/** Is (x, z) within `r` metres of a gate's stair (on the line out from the shore)? */
export function nearGate(x: number, z: number, r = 4.5): Gate | null {
  for (const g of GATES) {
    const dx = x - g.x, dz = z - g.z;
    const v = dx * g.nx + dz * g.nz;
    const u = -dx * g.nz + dz * g.nx;
    if (Math.abs(u) < r && v > -2 && v < g.qw + 60) return g;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Depth texture for the water
 * ------------------------------------------------------------------ */

/** RGBA bytes of water depth (R), shore proximity (G), over ±EXTENT. */
export function depthTexels(size: number): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    const z = -EXTENT + ((j + 0.5) / size) * EXTENT * 2;
    for (let i = 0; i < size; i++) {
      const x = -EXTENT + ((i + 0.5) / size) * EXTENT * 2;
      const h = heightAt(x, z);
      const depth = clamp(-h / 26, 0, 1);
      const o = (j * size + i) * 4;
      data[o] = Math.round(Math.sqrt(depth) * 255);
      // Is this a cliff coast (surf) or the sheltered bay (lapping)?
      const bay = sBay(x, z) > 2 ? 1 : 0;
      data[o + 1] = bay * 255;
      data[o + 2] = 0;
      data[o + 3] = 255;
    }
  }
  return data;
}
