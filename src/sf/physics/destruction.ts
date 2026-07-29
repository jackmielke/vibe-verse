/**
 * destruction.ts — the Just Cause heart of the physics layer.
 *
 * Four things live here, and they are deliberately one module because they are
 * one feedback loop: damage feeds staging, staging feeds fracture, fracture
 * feeds the blast solver, and the blast solver feeds damage again.
 *
 *   1. **Voronoi pre-fracture.** A destructible's source volume is shattered
 *      into convex cells *once*, cached by archetype, and reused for every
 *      instance of that prop in the city. Fracturing at the moment of
 *      destruction is what makes browser destruction stutter; fracturing at
 *      first use and then reusing the pattern is free. The cells are computed
 *      as true Voronoi regions — the intersection of the source half-spaces
 *      with the bisector half-spaces between seeds — so the shards tessellate
 *      the original volume exactly, with no gaps and no overlap.
 *
 *   2. **Staged destruction.** intact → damaged → destroyed, with a damage
 *      accumulator per object. The middle stage is what sells it: a hit that
 *      does not destroy still has to *show*, or every fight feels like shooting
 *      at invulnerable scenery until something pops.
 *
 *   3. **Explosions with falloff and occlusion.** Impulse falls off as
 *      (1 - d/R)^1.6 (a fair approximation of near-field overpressure decay),
 *      and every target gets a three-ray occlusion test against the static
 *      world. Standing behind a concrete pillar has to matter, and the shape
 *      of the blast has to follow the geometry of the street.
 *
 *   4. **Structural detachment and chains.** Objects declare what holds them
 *      up. Shoot out a support and everything it carried loses its footing and
 *      collapses a beat later. Explosive objects inside a blast light their own
 *      fuse, which is where the Just Cause cascade comes from — one shot into a
 *      fuel depot walks across the whole yard.
 *
 * Nothing here allocates per frame. The fracture cache allocates once per
 * archetype, the blast solver reuses scratch arrays, and shards come out of
 * `rigidBodyPool` so they respect the global body cap.
 */
import type * as RAPIER from "@dimforge/rapier3d-compat";
import { QUALITY, type QualityTier } from "../config";
import { clamp01, makeRng, type Rng } from "../math/rng";
import { makeRayHit, overlapSphere, raycast, type RayHit } from "./raycast";
import { rigidBodyPool, type BodyHandle } from "./rigidBodies";
import { removeStaticBoxes } from "./terrainCollider";
import {
  QUERY_STATIC,
  physics,
  type PhysicsObject,
  type SurfaceTag,
} from "./world";

/* ================================================================== *
 * 1. Voronoi pre-fracture
 * ================================================================== */

/** One convex cell of a fractured volume, expressed about its own centroid. */
export interface Shard {
  /** Triangle soup for rendering, local to the shard centroid. */
  positions: Float32Array;
  /** Flat per-vertex normals matching `positions`. */
  normals: Float32Array;
  indices: Uint32Array;
  /** Unique hull points for the physics collider, same local frame. */
  hull: Float32Array;
  /** Shard centroid in the *source object's* local frame. */
  cx: number;
  cy: number;
  cz: number;
  /** Cubic metres. Mass = volume × material density. */
  volume: number;
  /** Local-frame half extents — the fallback collider if the hull degenerates. */
  hx: number;
  hy: number;
  hz: number;
}

export interface FracturePattern {
  key: string;
  shards: Shard[];
  totalVolume: number;
  /** Source half extents the pattern was cut from. */
  hx: number;
  hy: number;
  hz: number;
}

const fractureCache = new Map<string, FracturePattern>();

/* --- plane / polytope helpers ------------------------------------- */

/** Half-space `n·p <= d`, packed as 4 floats. */
type Planes = Float64Array;

function pushPlane(p: Planes, i: number, nx: number, ny: number, nz: number, d: number): void {
  const o = i * 4;
  p[o] = nx;
  p[o + 1] = ny;
  p[o + 2] = nz;
  p[o + 3] = d;
}

/**
 * Enumerate the vertices of the polytope defined by `count` half-spaces.
 *
 * Brute force over plane triples. With ≤ 20 planes that is 1140 candidate
 * points and a linear feasibility check each — roughly 25 k operations per
 * cell, run once per archetype at load. A proper incremental clip would be
 * asymptotically better and materially harder to get numerically right; at
 * this plane count the constant factor wins and the failure mode (a dropped
 * vertex from a near-degenerate triple) is invisible.
 */
function polytopeVertices(planes: Planes, count: number, scale: number, out: number[]): void {
  out.length = 0;
  const eps = 1e-4 * scale;
  const dedupe = 1e-3 * scale;
  const seen = new Map<string, number>();

  for (let a = 0; a < count; a++) {
    const ax = planes[a * 4], ay = planes[a * 4 + 1], az = planes[a * 4 + 2], ad = planes[a * 4 + 3];
    for (let b = a + 1; b < count; b++) {
      const bx = planes[b * 4], by = planes[b * 4 + 1], bz = planes[b * 4 + 2], bd = planes[b * 4 + 3];
      // n0 × n1 — independent of the third plane, so hoisted out of the loop.
      const c01x = ay * bz - az * by;
      const c01y = az * bx - ax * bz;
      const c01z = ax * by - ay * bx;
      for (let c = b + 1; c < count; c++) {
        const gx = planes[c * 4], gy = planes[c * 4 + 1], gz = planes[c * 4 + 2], gd = planes[c * 4 + 3];
        // det = n2 · (n0 × n1) = det[n0; n1; n2]
        const det = gx * c01x + gy * c01y + gz * c01z;
        if (Math.abs(det) < 1e-9) continue;
        const inv = 1 / det;
        // Cramer: p = (d0 (n1×n2) + d1 (n2×n0) + d2 (n0×n1)) / det
        const c12x = by * gz - bz * gy;
        const c12y = bz * gx - bx * gz;
        const c12z = bx * gy - by * gx;
        const c20x = gy * az - gz * ay;
        const c20y = gz * ax - gx * az;
        const c20z = gx * ay - gy * ax;
        const px = (ad * c12x + bd * c20x + gd * c01x) * inv;
        const py = (ad * c12y + bd * c20y + gd * c01y) * inv;
        const pz = (ad * c12z + bd * c20z + gd * c01z) * inv;
        if (!isFinite(px) || !isFinite(py) || !isFinite(pz)) continue;

        let ok = true;
        for (let k = 0; k < count; k++) {
          const o = k * 4;
          if (planes[o] * px + planes[o + 1] * py + planes[o + 2] * pz > planes[o + 3] + eps) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;

        const key =
          Math.round(px / dedupe) + "," + Math.round(py / dedupe) + "," + Math.round(pz / dedupe);
        if (seen.has(key)) continue;
        seen.set(key, out.length / 3);
        out.push(px, py, pz);
      }
    }
  }
}

const _faceIdx: number[] = [];
const _faceAng: number[] = [];

/**
 * Build a watertight triangle mesh from a vertex cloud plus the planes that
 * generated it: each plane contributes one polygonal face, and every face is
 * fanned about its own centroid so concave-looking numerical artefacts cannot
 * produce sliver triangles.
 */
function buildShardMesh(
  verts: number[],
  planes: Planes,
  planeCount: number,
  scale: number,
): { positions: number[]; indices: number[] } | null {
  const onPlane = 2e-3 * scale;
  const positions: number[] = [];
  const indices: number[] = [];

  for (let k = 0; k < planeCount; k++) {
    const nx = planes[k * 4];
    const ny = planes[k * 4 + 1];
    const nz = planes[k * 4 + 2];
    const d = planes[k * 4 + 3];

    _faceIdx.length = 0;
    for (let i = 0; i < verts.length; i += 3) {
      const dist = nx * verts[i] + ny * verts[i + 1] + nz * verts[i + 2] - d;
      if (Math.abs(dist) < onPlane) _faceIdx.push(i);
    }
    if (_faceIdx.length < 3) continue;

    // Face centroid.
    let fx = 0, fy = 0, fz = 0;
    for (const i of _faceIdx) {
      fx += verts[i];
      fy += verts[i + 1];
      fz += verts[i + 2];
    }
    const inv = 1 / _faceIdx.length;
    fx *= inv; fy *= inv; fz *= inv;

    // Orthonormal basis in the face plane with u × v = n, so ascending angle
    // is counter-clockwise seen from outside and the winding comes out right.
    let ux = 0, uy = 0, uz = 0;
    if (Math.abs(nx) < 0.9) {
      ux = 0; uy = nz; uz = -ny;
    } else {
      ux = -nz; uy = 0; uz = nx;
    }
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ny * uz - nz * uy;
    const vy = nz * ux - nx * uz;
    const vz = nx * uy - ny * ux;

    _faceAng.length = 0;
    for (let j = 0; j < _faceIdx.length; j++) {
      const i = _faceIdx[j];
      const dx = verts[i] - fx;
      const dy = verts[i + 1] - fy;
      const dz = verts[i + 2] - fz;
      _faceAng.push(Math.atan2(dx * vx + dy * vy + dz * vz, dx * ux + dy * uy + dz * uz));
    }
    // Insertion sort — faces have 3..8 vertices; anything fancier is noise.
    for (let a = 1; a < _faceIdx.length; a++) {
      const ka = _faceAng[a];
      const ki = _faceIdx[a];
      let b = a - 1;
      while (b >= 0 && _faceAng[b] > ka) {
        _faceAng[b + 1] = _faceAng[b];
        _faceIdx[b + 1] = _faceIdx[b];
        b--;
      }
      _faceAng[b + 1] = ka;
      _faceIdx[b + 1] = ki;
    }

    const centreIndex = positions.length / 3;
    positions.push(fx, fy, fz);
    const ringStart = positions.length / 3;
    for (const i of _faceIdx) positions.push(verts[i], verts[i + 1], verts[i + 2]);

    const n = _faceIdx.length;
    for (let j = 0; j < n; j++) {
      const i0 = ringStart + j;
      const i1 = ringStart + ((j + 1) % n);
      indices.push(centreIndex, i0, i1);
    }
  }

  if (indices.length < 12) return null; // fewer than 4 triangles is not a solid
  return { positions, indices };
}

/**
 * Fracture an axis-aligned box into `cellCount` Voronoi cells.
 *
 * The seeds are jittered-stratified rather than uniformly random: pure random
 * seeds produce a distribution with slivers and one giant cell, which looks
 * like a bug. A jittered lattice gives shards whose sizes vary by maybe 3:1,
 * which is what real concrete does.
 */
export function fractureBox(
  hx: number,
  hy: number,
  hz: number,
  cellCount: number,
  seed: string,
): FracturePattern {
  const key = `${hx.toFixed(3)}|${hy.toFixed(3)}|${hz.toFixed(3)}|${cellCount}|${seed}`;
  const cached = fractureCache.get(key);
  if (cached) return cached;

  const rng = makeRng(`sf-fracture:${key}`);
  // Geometric tolerances are keyed to the *smallest* extent, not the largest:
  // a window pane is 1.2 × 1.6 × 0.02 m, and a tolerance sized off 1.6 m would
  // merge its front and back faces into one. Doubles give us ~15 digits, so
  // tightening this costs nothing.
  const scale = Math.max(2 * Math.min(hx, hy, hz), 1e-3);

  // --- seeds ------------------------------------------------------
  const seeds = generateSeeds(hx, hy, hz, cellCount, rng);
  const n = seeds.length / 3;

  // --- cells ------------------------------------------------------
  const MAX_NEIGHBOURS = 14;
  const planeBuf: Planes = new Float64Array((6 + MAX_NEIGHBOURS) * 4);
  const verts: number[] = [];
  const shards: Shard[] = [];
  const order = new Int32Array(n);
  const dist2 = new Float64Array(n);

  let totalVolume = 0;

  for (let i = 0; i < n; i++) {
    const sx = seeds[i * 3];
    const sy = seeds[i * 3 + 1];
    const sz = seeds[i * 3 + 2];

    pushPlane(planeBuf, 0, 1, 0, 0, hx);
    pushPlane(planeBuf, 1, -1, 0, 0, hx);
    pushPlane(planeBuf, 2, 0, 1, 0, hy);
    pushPlane(planeBuf, 3, 0, -1, 0, hy);
    pushPlane(planeBuf, 4, 0, 0, 1, hz);
    pushPlane(planeBuf, 5, 0, 0, -1, hz);
    let planeCount = 6;

    // Nearest neighbours only. A seed on the far side of the box cannot
    // contribute a face to this cell, and testing it costs a plane.
    for (let j = 0; j < n; j++) {
      order[j] = j;
      const dx = seeds[j * 3] - sx;
      const dy = seeds[j * 3 + 1] - sy;
      const dz = seeds[j * 3 + 2] - sz;
      dist2[j] = j === i ? Infinity : dx * dx + dy * dy + dz * dz;
    }
    // Partial selection sort for the K nearest — cheaper than a full sort.
    const take = Math.min(MAX_NEIGHBOURS, n - 1);
    for (let k = 0; k < take; k++) {
      let best = k;
      for (let j = k + 1; j < n; j++) if (dist2[order[j]] < dist2[order[best]]) best = j;
      const t = order[k];
      order[k] = order[best];
      order[best] = t;

      const j = order[k];
      let dx = seeds[j * 3] - sx;
      let dy = seeds[j * 3 + 1] - sy;
      let dz = seeds[j * 3 + 2] - sz;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) continue;
      dx /= len; dy /= len; dz /= len;
      const mx = (seeds[j * 3] + sx) * 0.5;
      const my = (seeds[j * 3 + 1] + sy) * 0.5;
      const mz = (seeds[j * 3 + 2] + sz) * 0.5;
      pushPlane(planeBuf, planeCount++, dx, dy, dz, dx * mx + dy * my + dz * mz);
    }

    polytopeVertices(planeBuf, planeCount, scale, verts);
    if (verts.length < 12) continue;

    const mesh = buildShardMesh(verts, planeBuf, planeCount, scale);
    if (!mesh) continue;

    const shard = finishShard(mesh.positions, mesh.indices, verts);
    if (!shard || shard.volume < 1e-6) continue;
    shards.push(shard);
    totalVolume += shard.volume;
  }

  // Biggest first: when the shard budget cuts the list short at spawn time we
  // want to keep the slabs and lose the gravel, not the other way round.
  shards.sort((a, b) => b.volume - a.volume);

  const pattern: FracturePattern = { key, shards, totalVolume, hx, hy, hz };
  fractureCache.set(key, pattern);
  return pattern;
}

/** Jittered lattice inside the box, roughly isotropic in cell size. */
function generateSeeds(hx: number, hy: number, hz: number, target: number, rng: Rng): Float64Array {
  const vol = hx * hy * hz * 8;
  const cell = Math.cbrt(vol / Math.max(1, target));
  const gx = Math.max(1, Math.round((hx * 2) / cell));
  const gy = Math.max(1, Math.round((hy * 2) / cell));
  const gz = Math.max(1, Math.round((hz * 2) / cell));

  const all: number[] = [];
  for (let iz = 0; iz < gz; iz++) {
    for (let iy = 0; iy < gy; iy++) {
      for (let ix = 0; ix < gx; ix++) {
        const u = (ix + 0.5) / gx;
        const v = (iy + 0.5) / gy;
        const w = (iz + 0.5) / gz;
        all.push(
          (u - 0.5) * 2 * hx + rng.range(-0.42, 0.42) * ((2 * hx) / gx),
          (v - 0.5) * 2 * hy + rng.range(-0.42, 0.42) * ((2 * hy) / gy),
          (w - 0.5) * 2 * hz + rng.range(-0.42, 0.42) * ((2 * hz) / gz),
        );
      }
    }
  }
  // Trim to target, seeded so the pattern is deterministic.
  let count = all.length / 3;
  while (count > target && count > 1) {
    const drop = rng.int(0, count - 1);
    all[drop * 3] = all[(count - 1) * 3];
    all[drop * 3 + 1] = all[(count - 1) * 3 + 1];
    all[drop * 3 + 2] = all[(count - 1) * 3 + 2];
    all.length -= 3;
    count--;
  }
  return Float64Array.from(all);
}

/** Compute volume + centroid, re-origin the mesh, and pack the typed arrays. */
function finishShard(positions: number[], indices: number[], hullVerts: number[]): Shard | null {
  // Signed volume and centroid via the divergence theorem over the triangles.
  let vol = 0;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const gx = positions[c], gy = positions[c + 1], gz = positions[c + 2];
    const v = (ax * (by * gz - bz * gy) + ay * (bz * gx - bx * gz) + az * (bx * gy - by * gx)) / 6;
    vol += v;
    cx += (ax + bx + gx) * 0.25 * v;
    cy += (ay + by + gy) * 0.25 * v;
    cz += (az + bz + gz) * 0.25 * v;
  }
  if (vol < 0) {
    // Winding came out inward; flip so normals point out of the shard.
    vol = -vol;
    cx = -cx; cy = -cy; cz = -cz;
    for (let i = 0; i < indices.length; i += 3) {
      const t = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = t;
    }
  }
  if (vol < 1e-9) return null;
  cx /= vol; cy /= vol; cz /= vol;

  const pos = new Float32Array(positions.length);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] - cx;
    const y = positions[i + 1] - cy;
    const z = positions[i + 2] - cz;
    pos[i] = x; pos[i + 1] = y; pos[i + 2] = z;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  // Flat normals: fractured stone has no smooth shading anywhere in it.
  const nrm = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    nrm[a] = nx; nrm[a + 1] = ny; nrm[a + 2] = nz;
    nrm[b] = nx; nrm[b + 1] = ny; nrm[b + 2] = nz;
    nrm[c] = nx; nrm[c + 1] = ny; nrm[c + 2] = nz;
  }

  const hull = new Float32Array(hullVerts.length);
  for (let i = 0; i < hullVerts.length; i += 3) {
    hull[i] = hullVerts[i] - cx;
    hull[i + 1] = hullVerts[i + 1] - cy;
    hull[i + 2] = hullVerts[i + 2] - cz;
  }

  return {
    positions: pos,
    normals: nrm,
    indices: Uint32Array.from(indices),
    hull,
    cx, cy, cz,
    volume: vol,
    hx: (maxX - minX) * 0.5,
    hy: (maxY - minY) * 0.5,
    hz: (maxZ - minZ) * 0.5,
  };
}

/** Drop the fracture cache (quality change, level unload). */
export function clearFractureCache(): void {
  fractureCache.clear();
}

/* ================================================================== *
 * 2. Destructibles
 * ================================================================== */

export type DestructionStage = "intact" | "damaged" | "destroyed";

/** kg/m³. Used for shard mass and therefore for how debris *reads* in motion. */
export const MATERIAL_DENSITY: Partial<Record<SurfaceTag, number>> = {
  concrete: 2400,
  stone: 2700,
  brick: 1900,
  asphalt: 2300,
  metal: 7800,
  thinMetal: 2400,
  glass: 2500,
  wood: 620,
  stucco: 1600,
  plastic: 950,
  rubber: 1100,
  fabric: 300,
  foliage: 400,
};

export interface DestructibleDesc {
  /** World position of the object's centre. */
  x: number;
  y: number;
  z: number;
  /** Yaw about +Y. */
  yaw?: number;
  /** Half extents of the fracturable volume. */
  hx: number;
  hy: number;
  hz: number;

  /** Total hit points. */
  hp: number;
  /** Fraction of hp at which the "damaged" stage starts. Default 0.5. */
  damagedAt?: number;
  material?: SurfaceTag;
  /**
   * Fracture archetype. Instances that share an archetype share one cached
   * Voronoi pattern, so "every parking meter in SoMa" costs one fracture.
   */
  archetype: string;
  /** Voronoi cell count. Clamped by the quality tier at shatter time. */
  cells?: number;

  /** Non-zero makes this a bomb: blast radius in metres. */
  explosiveRadius?: number;
  /** Peak impulse at the epicentre, N·s. */
  explosiveForce?: number;
  explosiveDamage?: number;

  /** Chaos award, forwarded on the destroy event. */
  chaosPoints?: number;
  /** Static collider group key, removed automatically on destroy. */
  staticKey?: string;
  /** Pooled body handle if the object is already dynamic (a parked car). */
  bodyHandle?: BodyHandle;
  /** Anything the owner wants back on the event. */
  ref?: unknown;
  /** Skip fracture; the owner will swap in its own destroyed mesh. */
  noShards?: boolean;
}

export interface Destructible {
  id: number;
  desc: DestructibleDesc;
  hp: number;
  maxHp: number;
  stage: DestructionStage;
  /** Sim time of the last damage tick — used for burning/decay logic upstream. */
  lastHit: number;
  /** Ids of objects this one holds up. */
  supports: number[];
  /** Ids of objects holding this one up. */
  supportedBy: number[];
  /** Fuse time (sim seconds) once lit, or -1. */
  fuseAt: number;
  /** Collapse time once unsupported, or -1. */
  collapseAt: number;
  alive: boolean;
}

/* --- events -------------------------------------------------------- */

export interface DestructionEvent {
  target: Destructible;
  stage: DestructionStage;
  /** Where the killing blow landed. */
  x: number;
  y: number;
  z: number;
  /** Direction of the impulse that did it. */
  dx: number;
  dy: number;
  dz: number;
  /** Chaos points, if the desc declared any. */
  chaos: number;
  /** Shard handles spawned, if any. Valid only during the callback. */
  shards: BodyHandle[];
}

export interface ExplosionEvent {
  x: number;
  y: number;
  z: number;
  radius: number;
  force: number;
  damage: number;
  /** Destructible that produced it, or -1 for a weapon. */
  sourceId: number;
  /** Depth in a chain: 0 for the shot that started it. */
  chainDepth: number;
}

type StageHandler = (e: DestructionEvent) => void;
type ExplosionHandler = (e: ExplosionEvent) => void;

const stageHandlers: StageHandler[] = [];
const explosionHandlers: ExplosionHandler[] = [];

function detach<T>(list: T[], fn: T): () => void {
  return () => {
    const i = list.indexOf(fn);
    if (i >= 0) {
      list[i] = list[list.length - 1];
      list.pop();
    }
  };
}

/** Fired on every stage transition, including intact→damaged. */
export function onDestructionStage(fn: StageHandler): () => void {
  stageHandlers.push(fn);
  return detach(stageHandlers, fn);
}

/** Fired for every explosion, primary or chained. VFX and audio live here. */
export function onExplosion(fn: ExplosionHandler): () => void {
  explosionHandlers.push(fn);
  return detach(explosionHandlers, fn);
}

/**
 * Optional sink for blast forces on things this module does not own — most
 * importantly the player, whose velocity belongs to the player subsystem.
 */
export type BlastSink = (
  x: number, y: number, z: number,
  ix: number, iy: number, iz: number,
  strength: number,
  damage: number,
) => void;

let blastSink: BlastSink | null = null;
export function setBlastSink(fn: BlastSink | null): void {
  blastSink = fn;
}

/* ================================================================== *
 * The manager
 * ================================================================== */

/** Broadphase cell for the destructible grid, metres. */
const GRID_CELL = 48;

const _stageEvent: DestructionEvent = {
  target: null as unknown as Destructible,
  stage: "intact",
  x: 0, y: 0, z: 0,
  dx: 0, dy: 1, dz: 0,
  chaos: 0,
  shards: [],
};
const _explosionEvent: ExplosionEvent = {
  x: 0, y: 0, z: 0, radius: 0, force: 0, damage: 0, sourceId: -1, chainDepth: 0,
};
const _hit: RayHit = makeRayHit();
const _blastTargets: PhysicsObject[] = [];
const _blastDestructibles: Destructible[] = [];
const _shardHandles: BodyHandle[] = [];

class DestructionSystem {
  private byId = new Map<number, Destructible>();
  private grid = new Map<number, Destructible[]>();
  private nextId = 1;

  /** Pending chained explosions and delayed collapses, processed in update(). */
  private fuses: Destructible[] = [];
  private collapses: Destructible[] = [];

  private rng: Rng = makeRng("sf-destruction");
  private tier: QualityTier = "high";

  readonly stats = {
    registered: 0,
    destroyed: 0,
    explosions: 0,
    shardsSpawned: 0,
  };

  setQuality(tier: QualityTier): void {
    this.tier = tier;
  }

  /* ---------------- registration ---------------- */

  register(desc: DestructibleDesc): Destructible {
    const d: Destructible = {
      id: this.nextId++,
      desc,
      hp: desc.hp,
      maxHp: desc.hp,
      stage: "intact",
      lastHit: -Infinity,
      supports: [],
      supportedBy: [],
      fuseAt: -1,
      collapseAt: -1,
      alive: true,
    };
    this.byId.set(d.id, d);
    this.insertGrid(d);
    this.stats.registered = this.byId.size;
    return d;
  }

  unregister(id: number): void {
    const d = this.byId.get(id);
    if (!d) return;
    this.removeGrid(d);
    this.byId.delete(id);
    for (const s of d.supportedBy) {
      const p = this.byId.get(s);
      if (p) {
        const i = p.supports.indexOf(id);
        if (i >= 0) p.supports.splice(i, 1);
      }
    }
    this.stats.registered = this.byId.size;
  }

  get(id: number): Destructible | null {
    return this.byId.get(id) ?? null;
  }

  /**
   * Declare that `supporterId` holds `childId` up.
   *
   * This is the whole structural model, and it is deliberately a graph rather
   * than a simulation: real structural analysis in a browser at 60 Hz is not
   * happening, and players cannot tell the difference between "the solver
   * decided the awning falls" and "the awning was listed as held by the two
   * posts you just shot".
   */
  registerSupport(childId: number, supporterId: number): void {
    const child = this.byId.get(childId);
    const sup = this.byId.get(supporterId);
    if (!child || !sup || childId === supporterId) return;
    if (child.supportedBy.indexOf(supporterId) < 0) child.supportedBy.push(supporterId);
    if (sup.supports.indexOf(childId) < 0) sup.supports.push(childId);
  }

  private cellKey(x: number, z: number): number {
    const ix = Math.floor(x / GRID_CELL) + 4096;
    const iz = Math.floor(z / GRID_CELL) + 4096;
    return ix * 8192 + iz;
  }

  private insertGrid(d: Destructible): void {
    const k = this.cellKey(d.desc.x, d.desc.z);
    let list = this.grid.get(k);
    if (!list) {
      list = [];
      this.grid.set(k, list);
    }
    list.push(d);
  }

  private removeGrid(d: Destructible): void {
    const k = this.cellKey(d.desc.x, d.desc.z);
    const list = this.grid.get(k);
    if (!list) return;
    const i = list.indexOf(d);
    if (i >= 0) {
      list[i] = list[list.length - 1];
      list.pop();
    }
    if (list.length === 0) this.grid.delete(k);
  }

  /** Collect destructibles whose centre is within `radius` of a point. */
  query(x: number, z: number, radius: number, out: Destructible[]): Destructible[] {
    const r2 = radius * radius;
    const ix0 = Math.floor((x - radius) / GRID_CELL);
    const ix1 = Math.floor((x + radius) / GRID_CELL);
    const iz0 = Math.floor((z - radius) / GRID_CELL);
    const iz1 = Math.floor((z + radius) / GRID_CELL);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const list = this.grid.get((ix + 4096) * 8192 + (iz + 4096));
        if (!list) continue;
        for (const d of list) {
          if (!d.alive) continue;
          const dx = d.desc.x - x;
          const dz = d.desc.z - z;
          if (dx * dx + dz * dz <= r2) out.push(d);
        }
      }
    }
    return out;
  }

  /* ---------------- damage ---------------- */

  /**
   * Apply damage at a point. `impulse` is the momentum of whatever hit it,
   * used to throw the shards in a believable direction.
   */
  applyDamage(
    id: number,
    amount: number,
    px = 0, py = 0, pz = 0,
    ix = 0, iy = 0, iz = 0,
  ): DestructionStage {
    const d = this.byId.get(id);
    if (!d || !d.alive) return "destroyed";
    if (amount <= 0) return d.stage;

    d.hp -= amount;
    d.lastHit = physics.simTime;

    const damagedAt = d.desc.damagedAt ?? 0.5;
    if (d.hp <= 0) {
      this.destroy(d, px, py, pz, ix, iy, iz);
      return "destroyed";
    }
    if (d.stage === "intact" && d.hp <= d.maxHp * damagedAt) {
      d.stage = "damaged";
      this.emitStage(d, px, py, pz, ix, iy, iz, null);
    }
    return d.stage;
  }

  /** Force an object to the destroyed stage (scripted demolition, melee). */
  destroy(
    d: Destructible,
    px?: number, py?: number, pz?: number,
    ix = 0, iy = 0, iz = 0,
    chainDepth = 0,
  ): void {
    if (!d.alive) return;
    d.alive = false;
    d.stage = "destroyed";
    d.hp = 0;
    this.stats.destroyed++;

    const cx = px ?? d.desc.x;
    const cy = py ?? d.desc.y;
    const cz = pz ?? d.desc.z;

    // Remove its collision footprint first: shards must not spawn inside the
    // very box they came from and get violently ejected by depenetration.
    if (d.desc.staticKey) removeStaticBoxes(d.desc.staticKey);
    if (d.desc.bodyHandle) rigidBodyPool.despawn(d.desc.bodyHandle);

    _shardHandles.length = 0;
    if (!d.desc.noShards) this.shatter(d, cx, cy, cz, ix, iy, iz, _shardHandles);

    this.emitStage(d, cx, cy, cz, ix, iy, iz, _shardHandles);

    // Anything this object held up loses a leg. Give it a beat: a support
    // failing and its load hitting the ground on the same frame reads as a
    // pop, not a collapse.
    for (const childId of d.supports) {
      const child = this.byId.get(childId);
      if (!child || !child.alive) continue;
      const i = child.supportedBy.indexOf(d.id);
      if (i >= 0) child.supportedBy.splice(i, 1);
      if (child.supportedBy.length === 0 && child.collapseAt < 0) {
        child.collapseAt = physics.simTime + 0.18 + this.rng.next() * 0.42;
        this.collapses.push(child);
      }
    }

    // Its own payload, if it had one.
    if ((d.desc.explosiveRadius ?? 0) > 0) {
      this.explode(
        d.desc.x, d.desc.y, d.desc.z,
        d.desc.explosiveRadius!,
        d.desc.explosiveForce ?? 9000,
        d.desc.explosiveDamage ?? 220,
        d.id,
        chainDepth,
      );
    }

    this.removeGrid(d);
    this.byId.delete(d.id);
    this.stats.registered = this.byId.size;
  }

  private emitStage(
    d: Destructible,
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    shards: BodyHandle[] | null,
  ): void {
    const e = _stageEvent;
    e.target = d;
    e.stage = d.stage;
    e.x = x; e.y = y; e.z = z;
    const l = Math.hypot(dx, dy, dz);
    if (l > 1e-6) {
      e.dx = dx / l; e.dy = dy / l; e.dz = dz / l;
    } else {
      e.dx = 0; e.dy = 1; e.dz = 0;
    }
    e.chaos = d.stage === "destroyed" ? d.desc.chaosPoints ?? 0 : 0;
    e.shards = shards ?? [];
    for (let i = 0; i < stageHandlers.length; i++) stageHandlers[i](e);
  }

  /* ---------------- fracture ---------------- */

  /**
   * Turn a destroyed object into pooled convex shards.
   *
   * Shard count is clamped hard by tier — the pattern may have 24 cells but on
   * Low we spawn the eight largest and let the VFX layer cover the rest with
   * particles, which is what every shipped destruction system does.
   */
  private shatter(
    d: Destructible,
    hitX: number, hitY: number, hitZ: number,
    ix: number, iy: number, iz: number,
    out: BodyHandle[],
  ): void {
    const q = QUALITY[this.tier];
    const maxShards = Math.max(4, Math.round(q.maxRigidBodies * 0.14));
    const cells = Math.min(d.desc.cells ?? 14, 28);

    const pattern = fractureBox(d.desc.hx, d.desc.hy, d.desc.hz, cells, d.desc.archetype);
    if (pattern.shards.length === 0) return;

    const material = d.desc.material ?? "concrete";
    const density = MATERIAL_DENSITY[material] ?? 2000;
    const yaw = d.desc.yaw ?? 0;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);

    // Already sorted biggest-first by `fractureBox`.
    const shards = pattern.shards;
    const n = Math.min(shards.length, maxShards);

    // Impulse direction, normalised, with a bias upward so a floor-level blast
    // still throws material into the air instead of skidding it along.
    let dirX = ix, dirY = iy, dirZ = iz;
    const dl = Math.hypot(dirX, dirY, dirZ);
    if (dl > 1e-5) {
      dirX /= dl; dirY /= dl; dirZ /= dl;
    } else {
      dirX = 0; dirY = 1; dirZ = 0;
    }
    const energy = Math.min(1, dl / 4000);

    for (let i = 0; i < n; i++) {
      const s = shards[i];
      // Local → world (yaw only).
      const lx = s.cx * cy - s.cz * sy;
      const lz = s.cx * sy + s.cz * cy;
      const wx = d.desc.x + lx;
      const wy = d.desc.y + s.cy;
      const wz = d.desc.z + lz;

      // Radial scatter from the hit point, plus the incoming impulse, plus
      // a little noise so a symmetric prop does not explode symmetrically.
      let rx = wx - hitX;
      let ry = wy - hitY;
      let rz = wz - hitZ;
      const rl = Math.hypot(rx, ry, rz) || 1;
      rx /= rl; ry /= rl; rz /= rl;

      const burst = 2.5 + energy * 9 + this.rng.range(-0.6, 1.4);
      const push = 1.5 + energy * 6;

      const h = yaw * 0.5;
      const handle = rigidBodyPool.spawn({
        shape: "convex",
        points: s.hull,
        hx: s.hx, hy: s.hy, hz: s.hz,
        x: wx, y: wy, z: wz,
        qx: 0, qy: Math.sin(h), qz: 0, qw: Math.cos(h),
        vx: rx * burst + dirX * push + this.rng.range(-1.2, 1.2),
        vy: ry * burst + dirY * push + this.rng.range(0.4, 2.6),
        vz: rz * burst + dirZ * push + this.rng.range(-1.2, 1.2),
        avx: this.rng.range(-9, 9),
        avy: this.rng.range(-9, 9),
        avz: this.rng.range(-9, 9),
        density,
        friction: material === "metal" || material === "glass" ? 0.5 : 0.82,
        restitution: material === "glass" ? 0.06 : 0.14,
        angularDamping: 0.5,
        linearDamping: 0.02,
        lifetime: 22 + this.rng.next() * 10,
        surface: material,
        kind: "debris",
        ref: s,
        priority: 0,
      });
      if (handle) {
        out.push(handle);
        this.stats.shardsSpawned++;
      }
    }
  }

  /* ---------------- explosions ---------------- */

  /**
   * The blast solver.
   *
   * Order matters and is not arbitrary:
   *   1. dynamic bodies get an impulse (they are cheap and they sell the hit);
   *   2. destructibles take damage, which may destroy them *this frame*;
   *   3. explosive destructibles inside the radius light a fuse instead of
   *      detonating inline — a synchronous chain would recurse arbitrarily
   *      deep in one frame and produce a single frame-long superexplosion
   *      rather than the rolling cascade the genre is built on;
   *   4. the blast sink (the player) gets its push last, so it is not
   *      cancelled by anything above.
   */
  explode(
    x: number, y: number, z: number,
    radius: number,
    force: number,
    damage: number,
    sourceId = -1,
    chainDepth = 0,
  ): void {
    this.stats.explosions++;

    const e = _explosionEvent;
    e.x = x; e.y = y; e.z = z;
    e.radius = radius;
    e.force = force;
    e.damage = damage;
    e.sourceId = sourceId;
    e.chainDepth = chainDepth;
    for (let i = 0; i < explosionHandlers.length; i++) explosionHandlers[i](e);

    // --- 1. dynamic bodies ----------------------------------------
    _blastTargets.length = 0;
    overlapSphere(x, y, z, radius, _blastTargets);
    for (let i = 0; i < _blastTargets.length; i++) {
      const o = _blastTargets[i];
      const body = o.body;
      if (!body || body.isFixed() || !body.isValid()) continue;
      if (o.kind === "terrain" || o.kind === "building" || o.kind === "water") continue;

      const t = body.translation();
      let dx = t.x - x;
      let dy = t.y - y;
      let dz = t.z - z;
      let dist = Math.hypot(dx, dy, dz);
      if (dist > radius) continue;
      if (dist < 1e-3) {
        dx = 0; dy = 1; dz = 0; dist = 1e-3;
      } else {
        dx /= dist; dy /= dist; dz /= dist;
      }

      const fall = falloff(dist, radius);
      const occ = this.occlusion(x, y, z, t.x, t.y, t.z, body);
      // Blast lofts things: real overpressure plus the ground reflection means
      // debris goes up as much as out. 0.45 is the number that makes cars
      // cartwheel instead of sliding.
      const up = 0.45 * fall;
      const mag = force * fall * occ;
      applyBlastImpulse(body, dx * mag, (dy + up) * mag, dz * mag, t, x, y, z);
    }

    // --- 2/3. destructibles ---------------------------------------
    _blastDestructibles.length = 0;
    this.query(x, z, radius, _blastDestructibles);
    for (let i = 0; i < _blastDestructibles.length; i++) {
      const d = _blastDestructibles[i];
      if (!d.alive || d.id === sourceId) continue;
      const dx = d.desc.x - x;
      const dy = d.desc.y - y;
      const dz = d.desc.z - z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > radius) continue;

      const fall = falloff(dist, radius);
      const occ = this.occlusion(x, y, z, d.desc.x, d.desc.y, d.desc.z, null);
      const dmg = damage * fall * occ;
      if (dmg <= 0.5) continue;

      const inv = dist > 1e-4 ? 1 / dist : 0;
      const mag = force * fall * occ;

      if ((d.desc.explosiveRadius ?? 0) > 0 && chainDepth < 6) {
        // Light the fuse rather than detonating now — but still take the
        // damage, so a fuel drum that survives the blast is a damaged drum.
        if (d.fuseAt < 0) {
          d.fuseAt = physics.simTime + 0.06 + this.rng.next() * 0.28;
          this.fuses.push(d);
        }
        d.hp -= dmg;
        continue;
      }

      this.applyDamage(
        d.id, dmg,
        d.desc.x, d.desc.y, d.desc.z,
        dx * inv * mag, dy * inv * mag, dz * inv * mag,
      );
    }

    // --- 4. the player and anything else external ------------------
    if (blastSink) blastSink(x, y, z, 0, 0, 0, force, damage);
  }

  /**
   * Three-ray occlusion between the epicentre and a target.
   *
   * One ray is too binary — a target half-hidden behind a car flickers between
   * full and zero blast as it moves. Three rays (centre plus two lateral
   * offsets, so the samples straddle a typical cover edge) give 0, 1/3, 2/3 or
   * 1 clear, remapped so that even fully-occluded targets take a floor of 18%:
   * blast waves diffract around corners, and a hard zero feels like a bug.
   */
  private occlusion(
    ex: number, ey: number, ez: number,
    tx: number, ty: number, tz: number,
    exclude: RAPIER.RigidBody | null,
  ): number {
    let dx = tx - ex;
    let dy = ty - ey;
    let dz = tz - ez;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.35) return 1;
    dx /= dist; dy /= dist; dz /= dist;

    // Lateral basis for the offset samples.
    let ux = -dz, uy = 0, uz = dx;
    const ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-4) {
      ux = 1; uy = 0; uz = 0;
    } else {
      ux /= ul; uz /= ul;
    }
    const spread = Math.min(0.9, dist * 0.12);

    let clear = 0;
    for (let s = -1; s <= 1; s++) {
      const ox = ex + ux * spread * s;
      const oz = ez + uz * spread * s;
      const oy = ey + (s === 0 ? 0 : 0.35 * s);
      const blocked = raycast(
        ox, oy, oz,
        tx - ox, ty - oy, tz - oz,
        dist - 0.25,
        _hit,
        {
          groups: QUERY_STATIC,
          skipSurface: true,
          excludeBody: exclude ?? undefined,
        },
      );
      if (!blocked) clear++;
    }
    return 0.18 + 0.82 * (clear / 3);
  }

  /* ---------------- per-frame ---------------- */

  /** Advance fuses and collapses. Call once per frame (or per fixed step). */
  update(_dt: number): void {
    const now = physics.simTime;

    for (let i = this.fuses.length - 1; i >= 0; i--) {
      const d = this.fuses[i];
      if (!d.alive) {
        this.fuses.splice(i, 1);
        continue;
      }
      if (now >= d.fuseAt) {
        this.fuses.splice(i, 1);
        d.fuseAt = -1;
        this.destroy(d, d.desc.x, d.desc.y, d.desc.z, 0, 1, 0, 1);
      }
    }

    for (let i = this.collapses.length - 1; i >= 0; i--) {
      const d = this.collapses[i];
      if (!d.alive) {
        this.collapses.splice(i, 1);
        continue;
      }
      if (now >= d.collapseAt) {
        this.collapses.splice(i, 1);
        d.collapseAt = -1;
        // A structural collapse is a fall, not a blast: shards drop with a
        // small downward bias rather than being thrown outward.
        this.destroy(d, d.desc.x, d.desc.y + d.desc.hy, d.desc.z, 0, -900, 0, 0);
      }
    }
  }

  /** Wipe every destructible (level reload). */
  clear(): void {
    this.byId.clear();
    this.grid.clear();
    this.fuses.length = 0;
    this.collapses.length = 0;
    this.stats.registered = 0;
  }
}

/**
 * Impulse falloff. Physically the near field decays faster than 1/d but slower
 * than 1/d²; the exponent here is tuned so an explosion feels dangerous well
 * past its visual fireball and stops abruptly at the stated radius, which is
 * what makes the radius readable to the player.
 */
function falloff(dist: number, radius: number): number {
  const t = clamp01(1 - dist / radius);
  // t^1.6, without a pow call: t * t^0.6 ≈ t * sqrt(t) * t^0.1. In practice
  // t*t*sqrt(t) (= t^2.5) is too sharp and t*t (= t^2) too soft, so we blend.
  const t2 = t * t;
  return t2 * 0.55 + t * Math.sqrt(t) * 0.45;
}

const _imp = { x: 0, y: 0, z: 0 };
const _at = { x: 0, y: 0, z: 0 };

/**
 * Apply a blast impulse slightly off centre of mass so things tumble.
 *
 * A perfectly central impulse makes every car in the blast translate without
 * rotating, which looks like a physics demo from 2004. Offsetting toward the
 * epicentre-facing side is both more correct and dramatically better looking.
 */
function applyBlastImpulse(
  body: RAPIER.RigidBody,
  ix: number, iy: number, iz: number,
  t: { x: number; y: number; z: number },
  ex: number, ey: number, ez: number,
): void {
  _imp.x = ix; _imp.y = iy; _imp.z = iz;
  let ox = t.x - ex;
  let oy = t.y - ey;
  let oz = t.z - ez;
  const l = Math.hypot(ox, oy, oz) || 1;
  ox /= l; oy /= l; oz /= l;
  // Push at a point on the near face, roughly a metre off centre.
  _at.x = t.x - ox * 0.9;
  _at.y = t.y - oy * 0.9;
  _at.z = t.z - oz * 0.9;
  body.applyImpulseAtPoint(_imp, _at, true);
}

export const destruction = new DestructionSystem();

/** Convenience wrapper matching the shape weapons want to call. */
export function explodeAt(
  x: number, y: number, z: number,
  radius: number,
  force: number,
  damage: number,
): void {
  destruction.explode(x, y, z, radius, force, damage, -1, 0);
}
