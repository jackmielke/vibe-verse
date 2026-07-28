/**
 * lots.ts — turning San Francisco's street grid into buildable parcels.
 *
 * A city block is not a box you extrude. It is a ring of parcels facing the
 * street, backing onto each other across a rear yard, with wider lots on the
 * corners, the odd mid-block alley, and — in this city specifically — a lot
 * width that has barely moved since the 1870s: 25 feet (7.62 m) of frontage by
 * 100 feet of depth is *the* San Francisco parcel. Get that number right and
 * the Mission and the Sunset come out looking like themselves for free.
 *
 * Everything here is a pure function of (grid, block index) through a seeded
 * RNG, so a chunk that streams out and streams back in is byte-identical. That
 * is not a nicety: the screenshot harness diffs frames.
 *
 * Public API
 * ----------
 *   enumerateBlocks(minX, minZ, maxX, maxZ, out)   blocks whose centre is in the box
 *   buildBlock(spec)                               subdivide one block into lots
 *   lotCorner(lot, sx, sz, out)                    lot-local (±1,±1) → world
 *   Lot, Block, BlockSpec                          types
 */
import {
  DISTRICTS,
  GRID_NORTH,
  GRID_SOUTH,
  GRID_WEST,
  MARKET_STREET,
  ROAD_HALF_WIDTH,
  districtAt,
  fromGridSpace,
  gridAt,
  isExcluded,
  isPark,
  landSDF,
  nearestStreet,
  terrainHeight,
  terrainSlope,
  toGridSpace,
  type BuildingStyle,
  type District,
  type GridSystem,
  type RoadClass,
} from "../../geo/sfGeo";
import { clamp, clamp01, hashSeed, makeRng, type Rng } from "../../math/rng";

/** Pavement width between the kerb and the property line, metres. */
export const SIDEWALK = 3.6;

/** The three grids, indexed so a block key can be an integer triple. */
const GRIDS: GridSystem[] = [GRID_NORTH, GRID_SOUTH, GRID_WEST];

export interface Lot {
  /** Stable identity: grid index, block indices, parcel index. */
  id: number;
  /** Parcel centre in world metres. */
  cx: number;
  cz: number;
  /**
   * Rotation about +Y such that local +X runs along the street frontage and
   * local +Z points *into* the block, away from the street. Every generator
   * relies on this: the front facade is the local -Z face.
   */
  yaw: number;
  /** Half-extent along the frontage (local X). */
  hw: number;
  /** Half-extent into the block (local Z). */
  hd: number;
  /** Class of the street this parcel fronts. */
  frontage: RoadClass;
  /** True for a parcel at the end of a row — SF corners get the bank, the bar, the taller building. */
  corner: boolean;
  /** True if the rear of the parcel opens onto a service alley. */
  alley: boolean;
  /** 0..1 — how important this frontage is. Drives commercial ground floors and height. */
  prominence: number;
  /** True where a neighbour's party wall abuts (so no windows on that side). */
  attachLeft: boolean;
  attachRight: boolean;
  /** Front setback already removed from `hd`; kept for stoops and porches. */
  setback: number;
  /** Highest ground under the footprint — the building sits on this. */
  groundHigh: number;
  /** Lowest ground under the footprint — the foundation skirt reaches this. */
  groundLow: number;
  /** Deterministic per-parcel seed. */
  seed: number;
  /** The block's dominant style; the generator biases toward it. */
  blockStyle: BuildingStyle;
  district: District;
}

export interface BlockSpec {
  gridIndex: number;
  iu: number;
  iv: number;
  /** Block centre, world metres. */
  cx: number;
  cz: number;
}

export interface Block extends BlockSpec {
  grid: GridSystem;
  district: District;
  style: BuildingStyle;
  lots: Lot[];
}

/* ------------------------------------------------------------------ *
 * Block enumeration
 * ------------------------------------------------------------------ */

/** Street class of the grid line at integer index n — every 4th is an arterial. */
function lineClass(n: number): RoadClass {
  return n % 4 === 0 ? "arterial" : "street";
}

/**
 * All blocks whose *centre* falls inside the box. Centre-ownership is what
 * makes chunk streaming seamless: a block belongs to exactly one chunk, no
 * matter how far it spills over the boundary.
 */
export function enumerateBlocks(
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  out: BlockSpec[] = [],
): BlockSpec[] {
  out.length = 0;
  for (let gi = 0; gi < GRIDS.length; gi++) {
    const g = GRIDS[gi];
    // Project the box corners into grid space and take the integer hull.
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (let c = 0; c < 4; c++) {
      const x = c & 1 ? maxX : minX;
      const z = c & 2 ? maxZ : minZ;
      const gs = toGridSpace(x, z, g);
      if (gs.u < u0) u0 = gs.u;
      if (gs.u > u1) u1 = gs.u;
      if (gs.v < v0) v0 = gs.v;
      if (gs.v > v1) v1 = gs.v;
    }
    const iu0 = Math.floor(u0) - 1;
    const iu1 = Math.ceil(u1) + 1;
    const iv0 = Math.floor(v0) - 1;
    const iv1 = Math.ceil(v1) + 1;
    for (let iv = iv0; iv <= iv1; iv++) {
      for (let iu = iu0; iu <= iu1; iu++) {
        const c = fromGridSpace(iu + 0.5, iv + 0.5, g);
        if (c.x < minX || c.x >= maxX || c.z < minZ || c.z >= maxZ) continue;
        // The grid that actually governs this ground has to be *this* grid,
        // otherwise the north and south grids would both build on the same
        // block and you would get towers inside towers along Market Street.
        if (gridAt(c.x, c.z) !== g) continue;
        out.push({ gridIndex: gi, iu, iv, cx: c.x, cz: c.z });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Lot geometry helpers
 * ------------------------------------------------------------------ */

/** Lot-local (sx, sz) in [-1,1] → world position. */
export function lotCorner(
  lot: Lot,
  sx: number,
  sz: number,
  out: { x: number; z: number },
): { x: number; z: number } {
  const c = Math.cos(lot.yaw);
  const s = Math.sin(lot.yaw);
  const lx = sx * lot.hw;
  const lz = sz * lot.hd;
  out.x = lot.cx + lx * c - lz * s;
  out.z = lot.cz + lx * s + lz * c;
  return out;
}

const _pt = { x: 0, z: 0 };

/** Clearance from a point to the nearest kerb line. Negative = in the road. */
function roadClearance(x: number, z: number): number {
  const s = nearestStreet(x, z);
  return s.distance - ROAD_HALF_WIDTH[s.roadClass];
}

/**
 * Shrink a parcel about its centre until every corner clears the roadway.
 *
 * This is how the wedge blocks along Market get their taper without a full
 * polygon clipper: the grid says "here is a rectangle", Market says "not
 * there", and the parcel gives ground until both agree. Returns false if the
 * parcel has to give up more than it has.
 */
function fitLotToRoads(lot: Lot): boolean {
  let lo = 0;
  let hi = 1;
  const test = (t: number): boolean => {
    const hw = lot.hw * t;
    const hd = lot.hd * t;
    const c = Math.cos(lot.yaw);
    const s = Math.sin(lot.yaw);
    for (let k = 0; k < 4; k++) {
      const lx = k & 1 ? hw : -hw;
      const lz = k & 2 ? hd : -hd;
      const x = lot.cx + lx * c - lz * s;
      const z = lot.cz + lx * s + lz * c;
      if (roadClearance(x, z) < 0.9) return false;
    }
    return true;
  };
  if (test(1)) return true;
  // Bisect for the largest scale that fits. Six iterations lands inside 2 %.
  for (let i = 0; i < 6; i++) {
    const mid = (lo + hi) * 0.5;
    if (test(mid)) lo = mid;
    else hi = mid;
  }
  if (lo < 0.34) return false;
  lot.hw *= lo;
  lot.hd *= lo;
  return lot.hw > 1.6 && lot.hd > 2.2;
}

/* ------------------------------------------------------------------ *
 * Style-driven parcel dimensions
 * ------------------------------------------------------------------ */

interface ParcelRule {
  /** Frontage width range, metres. */
  minW: number;
  maxW: number;
  /** Probability a parcel is a merged double lot. */
  doubleP: number;
  /** Parcel depth range, metres. */
  minD: number;
  maxD: number;
  /** Front setback from the property line, metres. */
  setback: number;
  /** Gap to the neighbour: 0 for party walls, >0 for a light well. */
  sideGap: number;
  /** Rear yard as a fraction of the block's buildable depth. */
  rearYard: number;
}

const PARCEL_RULES: Record<BuildingStyle, ParcelRule> = {
  // 25-foot lots, wall to wall, three feet of stoop.
  victorian: { minW: 6.6, maxW: 9.6, doubleP: 0.14, minD: 20, maxD: 30, setback: 2.6, sideGap: 0, rearYard: 0.2 },
  "edwardian-apartment": { minW: 9, maxW: 16, doubleP: 0.2, minD: 22, maxD: 32, setback: 1.6, sideGap: 0, rearYard: 0.17 },
  // The Sunset's endless identical frontages — narrow, detached by a hair.
  "stucco-row": { minW: 7.2, maxW: 9.0, doubleP: 0.05, minD: 18, maxD: 26, setback: 3.2, sideGap: 0.5, rearYard: 0.24 },
  "midrise-brick": { minW: 11, maxW: 26, doubleP: 0.3, minD: 24, maxD: 40, setback: 0, sideGap: 0, rearYard: 0.1 },
  "highrise-glass": { minW: 26, maxW: 62, doubleP: 0.45, minD: 30, maxD: 66, setback: 0.6, sideGap: 0, rearYard: 0.02 },
  "highrise-deco": { minW: 22, maxW: 48, doubleP: 0.35, minD: 28, maxD: 56, setback: 0, sideGap: 0, rearYard: 0.04 },
  warehouse: { minW: 22, maxW: 52, doubleP: 0.25, minD: 30, maxD: 60, setback: 0, sideGap: 0, rearYard: 0.05 },
  industrial: { minW: 18, maxW: 46, doubleP: 0.25, minD: 26, maxD: 58, setback: 1.2, sideGap: 1.5, rearYard: 0.08 },
  civic: { minW: 34, maxW: 90, doubleP: 0.15, minD: 30, maxD: 70, setback: 6, sideGap: 4, rearYard: 0.06 },
  military: { minW: 16, maxW: 30, doubleP: 0.1, minD: 14, maxD: 24, setback: 5, sideGap: 6, rearYard: 0.3 },
};

/** Weighted style pick for a block. */
function pickStyle(d: District, rng: Rng): BuildingStyle {
  let total = 0;
  for (const w of d.styleWeights) total += w;
  let r = rng.next() * total;
  for (let i = 0; i < d.styles.length; i++) {
    r -= d.styleWeights[i];
    if (r <= 0) return d.styles[i];
  }
  return d.styles[d.styles.length - 1];
}

/**
 * Chop a run of frontage into parcels that exactly fill it.
 *
 * Draw widths from the style distribution until the remainder is too small,
 * then scale every parcel by the same factor so the row tiles with no gap.
 * Uniform scaling is important: it preserves the *relative* rhythm of wide and
 * narrow lots, which is what stops a Victorian row reading as a stamped
 * repeat, while still guaranteeing party walls actually meet.
 */
function splitFrontage(length: number, rule: ParcelRule, rng: Rng, out: number[]): void {
  out.length = 0;
  if (length < rule.minW * 0.8) {
    if (length > 3) out.push(length);
    return;
  }
  let used = 0;
  let guard = 0;
  while (used < length - rule.minW * 0.55 && guard++ < 64) {
    let w = rng.range(rule.minW, rule.maxW);
    if (rng.chance(rule.doubleP)) w *= rng.range(1.7, 2.2);
    w = Math.min(w, length - used);
    out.push(w);
    used += w;
  }
  if (out.length === 0) {
    out.push(length);
    return;
  }
  const scale = length / used;
  for (let i = 0; i < out.length; i++) out[i] *= scale;
}

/* ------------------------------------------------------------------ *
 * Block subdivision
 * ------------------------------------------------------------------ */

interface RowPlan {
  /** Start / end along the block's U axis, metres from the block's u=iu corner. */
  a0: number;
  a1: number;
  /** Near and far edge along V, metres from the block's v=iv corner. */
  b0: number;
  b1: number;
  /** Unit vector, in world space, from the parcel toward its street. */
  fx: number;
  fz: number;
  /** Frontage class. */
  cls: RoadClass;
  /** True when the row runs along the U axis (fronting a v-street). */
  alongU: boolean;
  /** True when the street this row fronts is the low-index edge (b0 / a0). */
  frontAtLow: boolean;
  alley: boolean;
  prominence: number;
}

const _blockLots: number[] = [];

/**
 * Subdivide one block. Deterministic in (gridIndex, iu, iv) and the world seed.
 */
export function buildBlock(spec: BlockSpec, worldSeed: string): Block {
  const grid = GRIDS[spec.gridIndex];
  const district = districtAt(spec.cx, spec.cz);
  const rng = makeRng(
    hashSeed(`${worldSeed}|blk|${spec.gridIndex}|${spec.iu}|${spec.iv}`),
  );
  const style = pickStyle(district, rng);
  const rule = PARCEL_RULES[style];
  const block: Block = { ...spec, grid, district, style, lots: [] };

  // Block frame: p00 is the (iu, iv) corner; eU/eV are unit world vectors.
  const p00 = fromGridSpace(spec.iu, spec.iv, grid);
  const p10 = fromGridSpace(spec.iu + 1, spec.iv, grid);
  const p01 = fromGridSpace(spec.iu, spec.iv + 1, grid);
  const lenU = Math.hypot(p10.x - p00.x, p10.z - p00.z);
  const lenV = Math.hypot(p01.x - p00.x, p01.z - p00.z);
  if (lenU < 1 || lenV < 1) return block;
  const eUx = (p10.x - p00.x) / lenU;
  const eUz = (p10.z - p00.z) / lenU;
  const eVx = (p01.x - p00.x) / lenV;
  const eVz = (p01.z - p00.z) / lenV;

  // Street half-widths on each of the four sides.
  const clsU0 = lineClass(spec.iu);
  const clsU1 = lineClass(spec.iu + 1);
  const clsV0 = lineClass(spec.iv);
  const clsV1 = lineClass(spec.iv + 1);
  const in0 = ROAD_HALF_WIDTH[clsU0] + SIDEWALK;
  const in1 = ROAD_HALF_WIDTH[clsU1] + SIDEWALK;
  const in2 = ROAD_HALF_WIDTH[clsV0] + SIDEWALK;
  const in3 = ROAD_HALF_WIDTH[clsV1] + SIDEWALK;

  const aStart = in0;
  const aEnd = lenU - in1;
  const bStart = in2;
  const bEnd = lenV - in3;
  const W = aEnd - aStart;
  const D = bEnd - bStart;
  if (W < 8 || D < 9) return block;

  const rows: RowPlan[] = [];

  // Is this block deep enough for two back-to-back rows plus a rear yard?
  const wantAlley = D > 46 && rng.chance(style === "victorian" || style === "midrise-brick" ? 0.28 : 0.14);
  const rearYard = wantAlley ? ROAD_HALF_WIDTH.alley * 2 : Math.min(D * rule.rearYard, 18);
  const twoRows = D - rearYard > 2 * Math.max(12, rule.minD * 0.55);

  // Corner / end-cap parcels facing the cross streets. Real blocks have them
  // whenever the block is long; short downtown blocks are usually just two rows.
  const wantEndcaps = W > 52 && D > 26 && rng.chance(0.6);
  const endcapDepth = wantEndcaps ? clamp(rng.range(0.13, 0.2) * W, 12, 26) : 0;

  const rowA0 = aStart + endcapDepth;
  const rowA1 = aEnd - endcapDepth;

  const promFor = (cls: RoadClass, marketNear: boolean): number =>
    marketNear ? 1 : cls === "arterial" ? 0.75 : cls === "boulevard" ? 1 : 0.4;

  // Market Street overrides everything it touches.
  const mdx = MARKET_STREET.bx - MARKET_STREET.ax;
  const mdz = MARKET_STREET.bz - MARKET_STREET.az;
  const mlen2 = mdx * mdx + mdz * mdz;
  const t = clamp01(((spec.cx - MARKET_STREET.ax) * mdx + (spec.cz - MARKET_STREET.az) * mdz) / mlen2);
  const marketDist = Math.hypot(
    MARKET_STREET.ax + mdx * t - spec.cx,
    MARKET_STREET.az + mdz * t - spec.cz,
  );
  const marketNear = marketDist < lenV * 0.75;

  if (twoRows && rowA1 - rowA0 > rule.minW) {
    const dA = (D - rearYard) * rng.range(0.44, 0.56);
    const dB = D - rearYard - dA;
    rows.push({
      a0: rowA0, a1: rowA1,
      b0: bStart, b1: bStart + dA,
      fx: -eVx, fz: -eVz,
      cls: marketNear && rng.chance(0.5) ? "boulevard" : clsV0,
      alongU: true, frontAtLow: true, alley: wantAlley, prominence: promFor(clsV0, marketNear),
    });
    rows.push({
      a0: rowA0, a1: rowA1,
      b0: bEnd - dB, b1: bEnd,
      fx: eVx, fz: eVz,
      cls: marketNear && rng.chance(0.5) ? "boulevard" : clsV1,
      alongU: true, frontAtLow: false, alley: wantAlley, prominence: promFor(clsV1, marketNear),
    });
  } else if (rowA1 - rowA0 > rule.minW) {
    // Shallow block — one row, fronting the more important street.
    const frontV0 = ROAD_HALF_WIDTH[clsV0] >= ROAD_HALF_WIDTH[clsV1];
    rows.push({
      a0: rowA0, a1: rowA1,
      b0: bStart, b1: bEnd,
      fx: frontV0 ? -eVx : eVx,
      fz: frontV0 ? -eVz : eVz,
      cls: frontV0 ? clsV0 : clsV1,
      alongU: true, frontAtLow: frontV0, alley: false,
      prominence: promFor(frontV0 ? clsV0 : clsV1, marketNear),
    });
  }

  if (wantEndcaps) {
    rows.push({
      a0: aStart, a1: aStart + endcapDepth,
      b0: bStart, b1: bEnd,
      fx: -eUx, fz: -eUz, cls: clsU0, alongU: false, frontAtLow: true, alley: false,
      prominence: promFor(clsU0, marketNear),
    });
    rows.push({
      a0: aEnd - endcapDepth, a1: aEnd,
      b0: bStart, b1: bEnd,
      fx: eUx, fz: eUz, cls: clsU1, alongU: false, frontAtLow: false, alley: false,
      prominence: promFor(clsU1, marketNear),
    });
  }

  // Downtown supersite: a single tower footprint eating most of the block.
  const towerish = style === "highrise-glass" || style === "highrise-deco" || style === "civic";
  if (towerish && rng.chance(district.maxHeight > 150 ? 0.5 : 0.3) && W > 34 && D > 26) {
    rows.length = 0;
    const padA = rng.range(0.0, 0.10) * W;
    const padB = rng.range(0.0, 0.10) * D;
    rows.push({
      a0: aStart + padA, a1: aEnd - padA,
      b0: bStart + padB, b1: bEnd - padB,
      fx: -eVx, fz: -eVz, cls: marketNear ? "boulevard" : clsV0,
      alongU: true, frontAtLow: true, alley: false, prominence: 1,
    });
    // One parcel, full block.
    const rp = rows[0];
    emitRow(block, rp, [rp.a1 - rp.a0], p00, eUx, eUz, eVx, eVz, rule, rng, style, district, spec, true);
    finishBlock(block, district, rng);
    return block;
  }

  for (const rp of rows) {
    const runLen = rp.alongU ? rp.a1 - rp.a0 : rp.b1 - rp.b0;
    if (runLen < 4) continue;
    splitFrontage(runLen, rule, rng, _blockLots);
    emitRow(block, rp, _blockLots.slice(), p00, eUx, eUz, eVx, eVz, rule, rng, style, district, spec, false);
  }

  finishBlock(block, district, rng);
  return block;
}

/** Emit one row of parcels into the block. */
function emitRow(
  block: Block,
  rp: RowPlan,
  widths: number[],
  p00: { x: number; z: number },
  eUx: number, eUz: number,
  eVx: number, eVz: number,
  rule: ParcelRule,
  rng: Rng,
  style: BuildingStyle,
  district: District,
  spec: BlockSpec,
  supersite: boolean,
): void {
  // Depth of the row, minus the front setback, capped by the style's max depth.
  const rowDepth = rp.alongU ? rp.b1 - rp.b0 : rp.a1 - rp.a0;
  const setback = supersite ? 0 : Math.min(rule.setback, rowDepth * 0.22);
  const depth = Math.min(rowDepth - setback, supersite ? 999 : rule.maxD);
  if (depth < 5) return;

  // Distance from the block corner to the row's *front* edge along the axis
  // the row is fronting, and the sign of "into the block".
  let cursor = rp.alongU ? rp.a0 : rp.b0;

  for (let i = 0; i < widths.length; i++) {
    const wRaw = widths[i];
    const gap = supersite ? 0 : rule.sideGap;
    const w = Math.max(wRaw - gap, 1.5);
    const midAlong = cursor + wRaw * 0.5;
    cursor += wRaw;

    // Position along the two block axes.
    let aMid: number;
    let bMid: number;
    if (rp.alongU) {
      aMid = midAlong;
      bMid = rp.frontAtLow
        ? rp.b0 + setback + depth * 0.5
        : rp.b1 - setback - depth * 0.5;
    } else {
      bMid = midAlong;
      aMid = rp.frontAtLow
        ? rp.a0 + setback + depth * 0.5
        : rp.a1 - setback - depth * 0.5;
    }

    const cx = p00.x + eUx * aMid + eVx * bMid;
    const cz = p00.z + eUz * aMid + eVz * bMid;

    // Reject early on the cheap tests before we pay for terrain sampling.
    if (landSDF(cx, cz) < 10) continue;
    if (isExcluded(cx, cz) || isPark(cx, cz)) continue;

    const yaw = Math.atan2(rp.fx, -rp.fz);

    const lot: Lot = {
      id: 0,
      cx,
      cz,
      yaw,
      hw: w * 0.5,
      hd: depth * 0.5,
      frontage: rp.cls,
      corner: !supersite && (i === 0 || i === widths.length - 1),
      alley: rp.alley,
      prominence: rp.prominence,
      attachLeft: !supersite && i > 0 && rule.sideGap === 0,
      attachRight: !supersite && i < widths.length - 1 && rule.sideGap === 0,
      setback,
      groundHigh: 0,
      groundLow: 0,
      seed: hashSeed(`${spec.gridIndex}:${spec.iu}:${spec.iv}:${block.lots.length}`),
      blockStyle: style,
      district,
    };

    if (!fitLotToRoads(lot)) continue;
    if (lot.hw < 1.8 || lot.hd < 2.4) continue;

    // Foundation: sample the four corners plus the centre. SF builds on 30 %
    // grades, but nothing gets built on a cliff.
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = 0; k < 5; k++) {
      const sx = k === 4 ? 0 : k & 1 ? 1 : -1;
      const sz = k === 4 ? 0 : k & 2 ? 1 : -1;
      lotCorner(lot, sx * 0.94, sz * 0.94, _pt);
      const h = terrainHeight(_pt.x, _pt.z);
      if (h > hi) hi = h;
      if (h < lo) lo = h;
    }
    if (hi < 0.6) continue; // below the tide line
    if (hi - lo > Math.max(lot.hw, lot.hd) * 1.35 + 8) continue; // a cliff, not a lot
    if (terrainSlope(cx, cz, 8) > 0.62) continue;
    lot.groundHigh = hi;
    lot.groundLow = lo;

    // Zoning density: some parcels are surface parking, a corner store's yard,
    // or simply vacant. Corners are built on far more often than mid-block.
    const keep = clamp01(district.density + (lot.corner ? 0.08 : 0) + (supersite ? 0.2 : 0));
    if (!rng.chance(keep)) continue;

    lot.id = block.lots.length;
    block.lots.push(lot);
  }
}

/** Post-pass: fix party-wall flags where a neighbour was culled. */
function finishBlock(block: Block, district: District, rng: Rng): void {
  void district;
  void rng;
  for (const lot of block.lots) {
    // A parcel whose neighbour did not get built exposes a blind party wall to
    // the sky — which is a *very* San Francisco sight, so we keep the flag and
    // let the generator paint it as an unfenestrated wall.
    if (lot.hw < 4) {
      lot.attachLeft = true;
      lot.attachRight = true;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Introspection helpers (used by the debug overlay and by tests)
 * ------------------------------------------------------------------ */

/** Total buildable area of a lot, m². */
export function lotArea(lot: Lot): number {
  return lot.hw * 2 * lot.hd * 2;
}

/** The district table, re-exported so callers do not need two imports. */
export { DISTRICTS };
