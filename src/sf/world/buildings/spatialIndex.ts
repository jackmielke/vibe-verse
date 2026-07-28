/**
 * spatialIndex.ts — what physics, AI and the grapple actually talk to.
 *
 * The renderer only needs triangles; every other system needs to *ask*
 * questions about the city: what is under me, what did my hook hit, can I walk
 * from this roof to that one, where is the nearest ledge in the direction I am
 * looking. Answering those from the merged chunk geometry would mean raycasting
 * a million triangles, so the generator publishes a parallel, coarse
 * description — one AABB and a list of roof decks per building — into a flat
 * uniform grid.
 *
 * A uniform grid rather than a BVH on purpose: the city is uniformly dense in
 * the places you play, insertion and removal have to be O(1) because chunks
 * stream in and out constantly, and a 2D DDA over 64 m cells resolves a 240 m
 * grapple ray in about four cell visits.
 *
 * Public API
 * ----------
 *   buildingIndex                       the singleton
 *   BuildingIndex.insert / removeChunk
 *   queryAABB, queryPoint, heightAt, raycast, nearestAnchor
 */
import type { BuildingRecord, RoofSurface } from "./generator";

const CELL = 64;

/** Scratch normal written by the OBB test and copied out only on acceptance. */
const _hitN = new Float32Array(3);
/** Scratch record list, so the aim assist allocates nothing per frame. */
const _scratchRecs: BuildingRecord[] = [];

/** Result of a ray against the building set. */
export interface BuildingHit {
  record: BuildingRecord;
  /** Distance along the ray, metres. */
  distance: number;
  px: number;
  py: number;
  pz: number;
  /** Surface normal of the face that was hit. */
  nx: number;
  ny: number;
  nz: number;
  /** True when the hit face is the roof deck — the grapple prefers these. */
  roof: boolean;
}

function cellKey(ix: number, iz: number): number {
  // 20-bit signed pack; the world is under 10 km so this cannot collide.
  return ((ix + 524288) << 20) | (iz + 524288);
}

export class BuildingIndex {
  private cells = new Map<number, BuildingRecord[]>();
  /** Records grouped by the chunk that produced them, for O(n) eviction. */
  private byChunk = new Map<string, BuildingRecord[]>();
  /** Per-record visit stamp so a DDA never tests the same building twice. */
  private stamp = new WeakMap<BuildingRecord, number>();
  private stampGen = 0;
  /** Live building count — the debug overlay reads this. */
  count = 0;

  /** Add every building a chunk produced. */
  insert(chunkKey: string, records: BuildingRecord[]): void {
    if (this.byChunk.has(chunkKey)) this.removeChunk(chunkKey);
    this.byChunk.set(chunkKey, records);
    for (const r of records) {
      const ix0 = Math.floor(r.minX / CELL);
      const ix1 = Math.floor(r.maxX / CELL);
      const iz0 = Math.floor(r.minZ / CELL);
      const iz1 = Math.floor(r.maxZ / CELL);
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const k = cellKey(ix, iz);
          let list = this.cells.get(k);
          if (!list) {
            list = [];
            this.cells.set(k, list);
          }
          list.push(r);
        }
      }
    }
    this.count += records.length;
  }

  /** Drop everything a chunk contributed. */
  removeChunk(chunkKey: string): void {
    const records = this.byChunk.get(chunkKey);
    if (!records) return;
    this.byChunk.delete(chunkKey);
    for (const r of records) {
      const ix0 = Math.floor(r.minX / CELL);
      const ix1 = Math.floor(r.maxX / CELL);
      const iz0 = Math.floor(r.minZ / CELL);
      const iz1 = Math.floor(r.maxZ / CELL);
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const k = cellKey(ix, iz);
          const list = this.cells.get(k);
          if (!list) continue;
          const i = list.indexOf(r);
          if (i >= 0) list[i] = list[list.length - 1];
          if (i >= 0) list.pop();
          if (list.length === 0) this.cells.delete(k);
        }
      }
    }
    this.count -= records.length;
  }

  clear(): void {
    this.cells.clear();
    this.byChunk.clear();
    this.count = 0;
  }

  /** Every building whose AABB overlaps the XZ box. Appends into `out`. */
  queryAABB(minX: number, minZ: number, maxX: number, maxZ: number, out: BuildingRecord[]): BuildingRecord[] {
    const gen = ++this.stampGen;
    const ix0 = Math.floor(minX / CELL);
    const ix1 = Math.floor(maxX / CELL);
    const iz0 = Math.floor(minZ / CELL);
    const iz1 = Math.floor(maxZ / CELL);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const list = this.cells.get(cellKey(ix, iz));
        if (!list) continue;
        for (const r of list) {
          if (this.stamp.get(r) === gen) continue;
          this.stamp.set(r, gen);
          if (r.maxX < minX || r.minX > maxX || r.maxZ < minZ || r.minZ > maxZ) continue;
          out.push(r);
        }
      }
    }
    return out;
  }

  /** The building whose oriented footprint contains (x,z), if any. */
  queryPoint(x: number, z: number): BuildingRecord | null {
    const list = this.cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return null;
    for (const r of list) {
      if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) continue;
      // Exact test in the building's own frame.
      const dx = x - r.cx;
      const dz = z - r.cz;
      const c = Math.cos(-r.yaw);
      const s = Math.sin(-r.yaw);
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      if (Math.abs(lx) <= r.hw && Math.abs(lz) <= r.hd) return r;
    }
    return null;
  }

  /**
   * Height of the highest *walkable* building surface over (x,z), or
   * -Infinity if the point is in the open. This is what the character
   * controller uses before it falls back to the terrain.
   */
  heightAt(x: number, z: number): number {
    const list = this.cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return -Infinity;
    let best = -Infinity;
    for (const r of list) {
      if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) continue;
      for (const s of r.roofs) {
        if (!s.walkable) continue;
        const dx = x - s.cx;
        const dz = z - s.cz;
        const c = Math.cos(-s.yaw);
        const sn = Math.sin(-s.yaw);
        const lx = dx * c - dz * sn;
        const lz = dx * sn + dz * c;
        if (Math.abs(lx) <= s.hw && Math.abs(lz) <= s.hd && s.cy > best) best = s.cy;
      }
    }
    return best;
  }

  /** All roof decks overlapping a box — AI navigation builds its graph on these. */
  queryRoofs(minX: number, minZ: number, maxX: number, maxZ: number, out: RoofSurface[]): RoofSurface[] {
    const recs: BuildingRecord[] = [];
    this.queryAABB(minX, minZ, maxX, maxZ, recs);
    for (const r of recs) {
      for (const s of r.roofs) if (s.walkable) out.push(s);
    }
    return out;
  }

  /**
   * Ray against the building AABBs, via a 2D DDA over the grid.
   *
   * Buildings are tested as oriented boxes, not the axis-aligned bounds, so a
   * grapple fired down a 42-degree downtown street does not snag on the empty
   * corner of a rotated building's AABB.
   */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
    out: BuildingHit,
  ): boolean {
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;

    const gen = ++this.stampGen;
    let bestT = maxDist;
    let hit = false;

    let ix = Math.floor(ox / CELL);
    let iz = Math.floor(oz / CELL);
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const invDx = dx !== 0 ? 1 / dx : Infinity;
    const invDz = dz !== 0 ? 1 / dz : Infinity;
    let tMaxX = dx !== 0 ? ((ix + (dx > 0 ? 1 : 0)) * CELL - ox) * invDx : Infinity;
    let tMaxZ = dz !== 0 ? ((iz + (dz > 0 ? 1 : 0)) * CELL - oz) * invDz : Infinity;
    const tDeltaX = dx !== 0 ? Math.abs(CELL * invDx) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(CELL * invDz) : Infinity;

    let travelled = 0;
    let guard = 0;
    while (travelled <= bestT && guard++ < 512) {
      const list = this.cells.get(cellKey(ix, iz));
      if (list) {
        for (const r of list) {
          if (this.stamp.get(r) === gen) continue;
          this.stamp.set(r, gen);
          const t = intersectOBB(r, ox, oy, oz, dx, dy, dz, bestT);
          if (t >= 0 && t < bestT) {
            bestT = t;
            hit = true;
            out.record = r;
            out.distance = t;
            out.px = ox + dx * t;
            out.py = oy + dy * t;
            out.pz = oz + dz * t;
            // The normal lives in a scratch until the hit is accepted; a
            // farther building tested later must not clobber it.
            out.nx = _hitN[0];
            out.ny = _hitN[1];
            out.nz = _hitN[2];
            out.roof = out.ny > 0.5;
          }
        }
      }
      if (tMaxX < tMaxZ) {
        travelled = tMaxX;
        ix += stepX;
        tMaxX += tDeltaX;
      } else {
        travelled = tMaxZ;
        iz += stepZ;
        tMaxZ += tDeltaZ;
      }
      if (!isFinite(travelled)) break;
    }
    return hit;
  }

  /**
   * The best grapple anchor near a ray — used by the aim assist so the hook
   * snaps to a ledge or a mast instead of a blank wall.
   *
   * @param cone  cosine of the half-angle the assist accepts.
   */
  nearestAnchor(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
    cone: number,
    out: { x: number; y: number; z: number },
  ): boolean {
    const recs = _scratchRecs;
    recs.length = 0;
    this.queryAABB(
      Math.min(ox, ox + dx * maxDist) - 8, Math.min(oz, oz + dz * maxDist) - 8,
      Math.max(ox, ox + dx * maxDist) + 8, Math.max(oz, oz + dz * maxDist) + 8,
      recs,
    );
    let bestScore = cone;
    let found = false;
    for (const r of recs) {
      const a = r.anchors;
      for (let i = 0; i < a.length; i += 3) {
        const vx = a[i] - ox;
        const vy = a[i + 1] - oy;
        const vz = a[i + 2] - oz;
        const d = Math.hypot(vx, vy, vz);
        if (d < 2 || d > maxDist) continue;
        const dot = (vx * dx + vy * dy + vz * dz) / d;
        if (dot > bestScore) {
          bestScore = dot;
          out.x = a[i];
          out.y = a[i + 1];
          out.z = a[i + 2];
          found = true;
        }
      }
    }
    return found;
  }
}

/* ------------------------------------------------------------------ *
 * Oriented-box ray test
 * ------------------------------------------------------------------ */

/**
 * Slab test in the building's local frame. Writes the hit normal into `out`
 * and returns the entry distance, or -1.
 *
 * The box runs from the ground-floor slab to `topY`, not `roofY`, so the
 * grapple can hook a tower's crown and a helipad's edge.
 */
function intersectOBB(
  r: BuildingRecord,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxT: number,
): number {
  const c = Math.cos(-r.yaw);
  const s = Math.sin(-r.yaw);
  const px = ox - r.cx;
  const pz = oz - r.cz;
  const lox = px * c - pz * s;
  const loz = px * s + pz * c;
  const ldx = dx * c - dz * s;
  const ldz = dx * s + dz * c;
  const loy = oy;

  const minY = r.baseY - 3;
  const maxY = r.topY;

  let tMin = 0;
  let tMax = maxT;
  let axis = -1;
  let sign = 1;

  // X slab
  if (Math.abs(ldx) < 1e-8) {
    if (lox < -r.hw || lox > r.hw) return -1;
  } else {
    const inv = 1 / ldx;
    let t1 = (-r.hw - lox) * inv;
    let t2 = (r.hw - lox) * inv;
    let sg = -1;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
      sg = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      axis = 0;
      sign = sg;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }
  // Y slab
  if (Math.abs(dy) < 1e-8) {
    if (loy < minY || loy > maxY) return -1;
  } else {
    const inv = 1 / dy;
    let t1 = (minY - loy) * inv;
    let t2 = (maxY - loy) * inv;
    let sg = -1;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
      sg = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      axis = 1;
      sign = sg;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }
  // Z slab
  if (Math.abs(ldz) < 1e-8) {
    if (loz < -r.hd || loz > r.hd) return -1;
  } else {
    const inv = 1 / ldz;
    let t1 = (-r.hd - loz) * inv;
    let t2 = (r.hd - loz) * inv;
    let sg = -1;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
      sg = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      axis = 2;
      sign = sg;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }

  if (tMin < 0) return -1;

  // Local normal → world.
  const fc = Math.cos(r.yaw);
  const fs = Math.sin(r.yaw);
  let nx = 0;
  let ny = 0;
  let nz = 0;
  if (axis === 0) nx = sign;
  else if (axis === 1) ny = sign;
  else if (axis === 2) nz = sign;
  _hitN[0] = nx * fc - nz * fs;
  _hitN[1] = ny;
  _hitN[2] = nx * fs + nz * fc;
  return tMin;
}

/** Reusable hit record so callers do not allocate per shot. */
export function makeBuildingHit(): BuildingHit {
  return {
    record: null as unknown as BuildingRecord,
    distance: 0,
    px: 0,
    py: 0,
    pz: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    roof: false,
  };
}

/**
 * The singleton every other subsystem imports.
 *
 * It holds only the streamed near/mid field — roughly a 2.5 km box around the
 * camera. Nothing outside that is queryable, and nothing outside that is
 * reachable within a frame at wingsuit speed, so that is the right trade.
 */
export const buildingIndex = new BuildingIndex();
