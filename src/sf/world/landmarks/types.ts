/**
 * types.ts — the landmark contract, plus the collision registry the rest of the
 * game queries.
 *
 * A landmark builder is a pure function of `(LandmarkCtx) -> void` that pushes
 * geometry into a `Batch`. It never touches the scene graph, never reads the
 * clock, and never calls `Math.random`. That means the same seed produces the
 * same Golden Gate Bridge on every machine, which the screenshot harness
 * depends on, and it means a landmark can be rebuilt at a different LOD without
 * any of the surrounding machinery caring.
 *
 * Local frame
 * -----------
 * Every landmark group sits at `(def.x, 0, def.z)` in world space with a yaw
 * from its module. So inside a builder:
 *
 *   local X/Z   metres from the landmark's anchor point, in the rotated frame
 *   local Y     **world-absolute elevation** — y = 0 is sea level
 *
 * Leaving Y in world space is the unusual choice, and it is deliberate. The
 * Golden Gate Bridge spans 2.7 km of wildly varying seabed and headland; Lombard
 * Street descends 20 m across a block; Alcatraz is an island. Every one of those
 * needs to talk about elevation in the same units the terrain does, and
 * `ctx.ground(lx, lz)` gives it to them without a coordinate conversion at every
 * call site.
 */
import * as THREE from "three";
import type { LandmarkDef, LandmarkKind } from "../../geo/sfGeo";
import { gridAt, terrainHeight } from "../../geo/sfGeo";
import type { Rng } from "../../math/rng";
import type { Batch } from "./kit";

/* ------------------------------------------------------------------ *
 * Colliders
 * ------------------------------------------------------------------ */

/**
 * One oriented box of solid landmark.
 *
 * Landmarks are the only geometry in the world a player can be *inside* the
 * silhouette of while still needing to stand on a specific surface 60 m up, so
 * they publish an explicit collider set rather than relying on a mesh raycast.
 * Boxes, not triangles: the physics and vehicle systems want something they can
 * sweep against cheaply, and a bridge deck genuinely is a box.
 */
export interface LandmarkCollider {
  /** `LandmarkDef.key` this belongs to. */
  key: string;
  kind: LandmarkKind;
  /** Centre, world metres. */
  x: number;
  y: number;
  z: number;
  /** Half extents in the box's own frame. */
  hx: number;
  hy: number;
  hz: number;
  /** Yaw of the box about +Y, radians. */
  yaw: number;
  /** Roadway a vehicle may drive on (bridge decks, Lombard, park roads). */
  drivable: boolean;
  /** Walkable surface (decks, sidewalks, roofs, catwalks). */
  walkable: boolean;
}

/** What a builder is handed to describe its solid volumes. */
export interface ColliderSink {
  /**
   * Add an oriented box, in the builder's **local** frame. `cy` is a world
   * elevation like every other Y in a builder.
   */
  box(
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    yaw?: number,
    flags?: { drivable?: boolean; walkable?: boolean },
  ): void;
  /**
   * Add a drivable/walkable ribbon: a chain of boxes following a polyline.
   * Used by the bridge decks and Lombard Street's switchbacks.
   */
  ribbon(
    points: readonly THREE.Vector3[],
    halfWidth: number,
    thickness: number,
    flags?: { drivable?: boolean; walkable?: boolean },
  ): void;
}

/* ------------------------------------------------------------------ *
 * Build context
 * ------------------------------------------------------------------ */

export interface LandmarkCtx {
  def: LandmarkDef;
  /** 0 = hero detail (near), 1 = silhouette (far / horizon). */
  lod: 0 | 1;
  /** Convenience for `lod === 0`; builders branch on this constantly. */
  detail: boolean;
  /** Deterministic stream, forked per landmark key. */
  rng: Rng;
  /** Geometry sink. */
  batch: Batch;
  /** World yaw of the group this builder's local frame is rotated by. */
  yaw: number;
  /** Terrain elevation at the landmark anchor, metres. */
  originY: number;
  /** Terrain elevation under a point in the builder's local frame. */
  ground(lx: number, lz: number): number;
  /** Local -> world X. */
  worldX(lx: number, lz: number): number;
  /** Local -> world Z. */
  worldZ(lx: number, lz: number): number;
  /** World -> local X (for reading `sfGeo` polygons into the local frame). */
  localX(wx: number, wz: number): number;
  /** World -> local Z. */
  localZ(wx: number, wz: number): number;
  /** Solid volumes. A no-op sink when this LOD is not the authoritative one. */
  collide: ColliderSink;
  /**
   * Register a per-frame callback (seconds since level load). Use sparingly —
   * blinking aircraft lights, the windmill's sails, the Salesforce crown. The
   * callback must not allocate.
   */
  onFrame(fn: (t: number) => void): void;
}

/** A landmark module: how to orient it, how to build it, how far it reads. */
export interface LandmarkModule {
  /** World yaw for the group. Defaults to `def.rotation`. */
  yaw?: (def: LandmarkDef) => number;
  build: (ctx: LandmarkCtx) => void;
  /**
   * Distance at which the hero mesh is swapped for the silhouette. Defaults to
   * a multiple of `def.radius`.
   */
  nearRange?: (def: LandmarkDef) => number;
  /**
   * True for the objects you navigate the whole city by — Sutro Tower, both
   * bridges, the Transamerica. Their far LOD is never distance-culled, and
   * they are built before anything else.
   */
  anchor?: boolean;
}

/* ------------------------------------------------------------------ *
 * Orientation helpers
 * ------------------------------------------------------------------ */

function wrapPi(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Snap a yaw to the street grid that governs a point.
 *
 * Real-world compass bearings are *not* used for the street-facing landmarks,
 * and that is intentional. `sfGeo` owns the road network; if the Ferry Building
 * faces true west but the Embarcadero in front of it runs at the grid angle,
 * the building sits skewed to its own street and the whole block reads broken.
 * Consistency with the generated city beats consistency with a compass, so the
 * caller passes the *intent* ("face roughly east") and the grid decides.
 */
export function streetYaw(x: number, z: number, preferred: number): number {
  const g = gridAt(x, z);
  let best = preferred;
  let bestD = Infinity;
  for (let k = 0; k < 4; k++) {
    const a = g.angle + (k * Math.PI) / 2;
    const d = Math.abs(wrapPi(a - preferred));
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return wrapPi(best);
}

/** Yaw of the line from A to B in world space (for bridges traced from lat/lon). */
export function bearingYaw(ax: number, az: number, bx: number, bz: number): number {
  // A group with rotation.y = t maps local +X to world (cos t, -sin t).
  return Math.atan2(-(bz - az), bx - ax);
}

/* ------------------------------------------------------------------ *
 * Collider registry
 * ------------------------------------------------------------------ */

const CELL = 96;
const store: LandmarkCollider[] = [];
const index = new Map<number, number[]>();

function cellKey(cx: number, cz: number): number {
  // 16-bit signed cell coordinates packed into one number — the world is
  // 9.8 km across, so ±512 cells is ample and this stays a fast integer key.
  return ((cx + 32768) << 16) | (cz + 32768);
}

function insert(i: number): void {
  const c = store[i];
  // Conservative AABB of the oriented box.
  const s = Math.abs(Math.sin(c.yaw));
  const co = Math.abs(Math.cos(c.yaw));
  const ex = c.hx * co + c.hz * s;
  const ez = c.hx * s + c.hz * co;
  const x0 = Math.floor((c.x - ex) / CELL);
  const x1 = Math.floor((c.x + ex) / CELL);
  const z0 = Math.floor((c.z - ez) / CELL);
  const z1 = Math.floor((c.z + ez) / CELL);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const k = cellKey(cx, cz);
      let list = index.get(k);
      if (!list) {
        list = [];
        index.set(k, list);
      }
      list.push(i);
    }
  }
}

/** Drop every registered collider. Called when the landmark layer unmounts. */
export function clearLandmarkColliders(): void {
  store.length = 0;
  index.clear();
}

/** Remove one landmark's colliders (used when a landmark is rebuilt). */
export function clearLandmarkCollidersFor(key: string): void {
  let write = 0;
  for (let i = 0; i < store.length; i++) {
    if (store[i].key !== key) store[write++] = store[i];
  }
  if (write === store.length) return;
  store.length = write;
  index.clear();
  for (let i = 0; i < store.length; i++) insert(i);
}

/** Everything currently registered. Read-only — mutate through the sink. */
export function landmarkColliders(): readonly LandmarkCollider[] {
  return store;
}

/**
 * Create a sink bound to one landmark's local frame. `record: false` returns a
 * sink that silently discards, so a builder does not have to know which LOD it
 * is producing.
 */
export function makeColliderSink(
  def: LandmarkDef,
  yaw: number,
  record: boolean,
): ColliderSink {
  if (!record) return NULL_SINK;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const push = (
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    localYaw: number,
    drivable: boolean,
    walkable: boolean,
  ) => {
    // Local -> world: rotate by the group yaw, then translate to the anchor.
    const wx = def.x + cx * cos + cz * sin;
    const wz = def.z - cx * sin + cz * cos;
    store.push({
      key: def.key,
      kind: def.kind,
      x: wx,
      y: cy,
      z: wz,
      hx,
      hy,
      hz,
      yaw: yaw + localYaw,
      drivable,
      walkable,
    });
    insert(store.length - 1);
  };
  return {
    box(cx, cy, cz, hx, hy, hz, localYaw = 0, flags) {
      push(cx, cy, cz, hx, hy, hz, localYaw, flags?.drivable ?? false, flags?.walkable ?? true);
    },
    ribbon(points, halfWidth, thickness, flags) {
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.01) continue;
        push(
          (a.x + b.x) / 2,
          (a.y + b.y) / 2 - thickness / 2,
          (a.z + b.z) / 2,
          len / 2 + 0.15,
          thickness / 2 + Math.abs(b.y - a.y) / 2,
          halfWidth,
          Math.atan2(-dz, dx),
          flags?.drivable ?? true,
          flags?.walkable ?? true,
        );
      }
    },
  };
}

const NULL_SINK: ColliderSink = {
  box: () => {},
  ribbon: () => {},
};

/**
 * Highest walkable/drivable landmark surface directly under `(x, z)` and at or
 * below `ceiling`, or `null` if there is none.
 *
 * This is the query the character controller and the vehicle suspension use to
 * find the Golden Gate's deck, Lombard's switchbacks and Pier 39's boardwalk —
 * surfaces that are far above `terrainHeight` and would otherwise be invisible
 * to anything that only knows about the ground.
 */
export function landmarkSurfaceHeight(
  x: number,
  z: number,
  ceiling = Infinity,
  drivableOnly = false,
): number | null {
  const list = index.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!list) return null;
  let best: number | null = null;
  for (let i = 0; i < list.length; i++) {
    const c = store[list[i]];
    if (drivableOnly && !c.drivable) continue;
    if (!c.drivable && !c.walkable) continue;
    const dx = x - c.x;
    const dz = z - c.z;
    const cos = Math.cos(c.yaw);
    const sin = Math.sin(c.yaw);
    // World -> box local (inverse of the yaw rotation used above).
    const lx = dx * cos - dz * sin;
    const lz = dx * sin + dz * cos;
    if (Math.abs(lx) > c.hx || Math.abs(lz) > c.hz) continue;
    const top = c.y + c.hy;
    if (top > ceiling) continue;
    if (best === null || top > best) best = top;
  }
  return best;
}

/** Colliders overlapping a circle, appended to `out`. Returns `out`. */
export function queryLandmarkColliders(
  x: number,
  z: number,
  radius: number,
  out: LandmarkCollider[],
): LandmarkCollider[] {
  const x0 = Math.floor((x - radius) / CELL);
  const x1 = Math.floor((x + radius) / CELL);
  const z0 = Math.floor((z - radius) / CELL);
  const z1 = Math.floor((z + radius) / CELL);
  const seen = new Set<number>();
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const list = index.get(cellKey(cx, cz));
      if (!list) continue;
      for (const i of list) {
        if (seen.has(i)) continue;
        seen.add(i);
        out.push(store[i]);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Context factory
 * ------------------------------------------------------------------ */

export interface MakeCtxOptions {
  def: LandmarkDef;
  lod: 0 | 1;
  yaw: number;
  rng: Rng;
  batch: Batch;
  /** Whether this build is the one that publishes colliders. */
  recordColliders: boolean;
  onFrame: (fn: (t: number) => void) => void;
}

export function makeLandmarkCtx(o: MakeCtxOptions): LandmarkCtx {
  const cos = Math.cos(o.yaw);
  const sin = Math.sin(o.yaw);
  const worldX = (lx: number, lz: number) => o.def.x + lx * cos + lz * sin;
  const worldZ = (lx: number, lz: number) => o.def.z - lx * sin + lz * cos;
  return {
    def: o.def,
    lod: o.lod,
    detail: o.lod === 0,
    rng: o.rng,
    batch: o.batch,
    yaw: o.yaw,
    originY: terrainHeight(o.def.x, o.def.z),
    ground: (lx, lz) => terrainHeight(worldX(lx, lz), worldZ(lx, lz)),
    worldX,
    worldZ,
    localX: (wx, wz) => (wx - o.def.x) * cos - (wz - o.def.z) * sin,
    localZ: (wx, wz) => (wx - o.def.x) * sin + (wz - o.def.z) * cos,
    collide: makeColliderSink(o.def, o.yaw, o.recordColliders),
    onFrame: o.onFrame,
  };
}
