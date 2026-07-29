/**
 * terrainCollider.ts — the collidable city, streamed.
 *
 * San Francisco is 9.5 × 9.5 km. A single heightfield at a useful resolution
 * would be ~5.6 million samples and a trimesh of every building would be tens
 * of megabytes of BVH, so the collision world is streamed exactly like the
 * visual world: rings of chunks around the player, built under a per-frame
 * millisecond budget, evicted with hysteresis so walking back and forth across
 * a boundary does not thrash.
 *
 * Ground truth comes from `sfGeo.terrainHeight` and from the buildings' own
 * spatial index. Nothing here invents geometry. If the visual terrain and the
 * collision terrain disagree by even half a metre you get the classic
 * open-world failure: the player's feet sink into the road, or float above it.
 *
 * Two LOD rings:
 *   near  128 m cells, 32 subdivisions → 4 m samples, out to ~340 m.
 *   far   512 m cells, 32 subdivisions → 16 m samples, out to ~1.7 km.
 * The far ring exists for vehicles launched off a hill and for debris thrown a
 * long way; 16 m samples are far too coarse to walk on but perfectly adequate
 * to stop a flaming truck falling through the planet at 300 m out.
 *
 * Heightfield index layout (verified against the engine, not assumed):
 * Rapier/parry stores the matrix column-major with the *row* index running
 * along +Z and the *column* index along +X, so a sample at (ix, iz) lives at
 * `iz + ix * (N + 1)`. Getting this transposed is a silent, beautiful,
 * completely wrong world, so it is spelled out in `fillHeights` below.
 *
 * Public API
 * ----------
 *   terrainCollider.update(x, z, budgetMs?)  call once per frame
 *   terrainCollider.dispose()
 *   registerStaticBoxes(key, boxes) / removeStaticBoxes(key)
 *   ensureWaterSensor()
 *   terrainCollider.stats
 */
import type * as RAPIER from "@dimforge/rapier3d-compat";
import { WORLD, terrainHeight } from "../geo/sfGeo";
import { buildingIndex } from "../world/buildings/spatialIndex";
import type { BuildingRecord } from "../world/buildings/generator";
import {
  FILTER,
  physics,
  rapier,
  registerObject,
  unregisterObject,
  type PhysicsObject,
} from "./world";

/* ------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------ */

/** Near-ring cell edge, metres. */
const NEAR_CELL = 128;
/** Far-ring cell edge, metres. Must be an integer multiple of NEAR_CELL. */
const FAR_CELL = 512;
const FAR_PER_NEAR = FAR_CELL / NEAR_CELL;
/** Subdivisions per chunk in each axis; samples = (N+1)². */
const SUBDIV = 32;
/** Chebyshev radius of the near ring, in near cells. 2 → 5×5 → ±320 m. */
const NEAR_RING = 2;
/** Chebyshev radius of the far ring, in far cells. 1 → 3×3 → ±768 m of ring. */
const FAR_RING = 2;
/** Building collider ring, in near cells. Buildings only matter close in. */
const BUILDING_RING = 3;
/** Default build budget per frame, ms. */
const DEFAULT_BUDGET_MS = 1.6;
/** Extra budget while the first ring is still empty — a cold start must be quick. */
const WARMUP_BUDGET_MS = 6;

/* ------------------------------------------------------------------ *
 * Scratch
 * ------------------------------------------------------------------ */

const _heights = new Float32Array((SUBDIV + 1) * (SUBDIV + 1));
const _recs: BuildingRecord[] = [];
const _quat = { x: 0, y: 0, z: 0, w: 1 };
const _scale = { x: 0, y: 1, z: 0 };

/* ------------------------------------------------------------------ *
 * Chunk records
 * ------------------------------------------------------------------ */

interface TerrainChunk {
  key: number;
  /** Centre of the chunk, world metres. */
  cx: number;
  cz: number;
  size: number;
  lod: 0 | 1;
  body: RAPIER.RigidBody | null;
  obj: PhysicsObject | null;
}

interface BuildingChunk {
  key: number;
  body: RAPIER.RigidBody | null;
  obj: PhysicsObject | null;
  /** Building ids this chunk owns, so eviction is exact. */
  ids: number[];
}

/** 20-bit signed pack of a chunk index pair plus a 1-bit LOD tag. */
function chunkKey(ix: number, iz: number, lod: number): number {
  return ((ix + 8192) * 16384 + (iz + 8192)) * 2 + lod;
}

/* ------------------------------------------------------------------ *
 * The streamer
 * ------------------------------------------------------------------ */

class TerrainColliderStreamer {
  private terrain = new Map<number, TerrainChunk>();
  private buildings = new Map<number, BuildingChunk>();

  /** Chunks scheduled but not yet built, oldest first. */
  private pending: TerrainChunk[] = [];
  private pendingBuildings: { key: number; ix: number; iz: number }[] = [];

  private lastScanX = Infinity;
  private lastScanZ = Infinity;

  readonly stats = {
    terrainChunks: 0,
    buildingChunks: 0,
    buildingColliders: 0,
    pending: 0,
    lastBuildMs: 0,
  };

  /**
   * Bring the resident set in line with the player's position.
   *
   * Cheap when nothing changed: a rescan only happens after the player has
   * moved a third of a near cell, and building work is amortised by the budget.
   */
  update(px: number, pz: number, budgetMs = DEFAULT_BUDGET_MS): void {
    const r = rapier();
    const w = physics.world;
    if (!r || !w) return;

    const moved = Math.abs(px - this.lastScanX) + Math.abs(pz - this.lastScanZ);
    if (moved > NEAR_CELL / 3) {
      this.lastScanX = px;
      this.lastScanZ = pz;
      this.rescan(px, pz);
    }

    const warm = this.terrain.size === 0;
    this.drainQueue(warm ? WARMUP_BUDGET_MS : budgetMs);

    this.stats.terrainChunks = this.terrain.size;
    this.stats.buildingChunks = this.buildings.size;
    this.stats.pending = this.pending.length + this.pendingBuildings.length;
  }

  /* ---------------- residency ---------------- */

  private rescan(px: number, pz: number): void {
    const nx = Math.floor(px / NEAR_CELL);
    const nz = Math.floor(pz / NEAR_CELL);
    const fx = Math.floor(px / FAR_CELL);
    const fz = Math.floor(pz / FAR_CELL);

    const wanted = new Set<number>();

    // --- near ring -------------------------------------------------
    for (let iz = nz - NEAR_RING; iz <= nz + NEAR_RING; iz++) {
      for (let ix = nx - NEAR_RING; ix <= nx + NEAR_RING; ix++) {
        const k = chunkKey(ix, iz, 0);
        wanted.add(k);
        if (!this.terrain.has(k) && !this.isQueued(k)) {
          this.pending.push({
            key: k,
            cx: (ix + 0.5) * NEAR_CELL,
            cz: (iz + 0.5) * NEAR_CELL,
            size: NEAR_CELL,
            lod: 0,
            body: null,
            obj: null,
          });
        }
      }
    }

    // --- far ring, skipping anything the near ring already covers ---
    for (let iz = fz - FAR_RING; iz <= fz + FAR_RING; iz++) {
      for (let ix = fx - FAR_RING; ix <= fx + FAR_RING; ix++) {
        // A far chunk maps onto exactly FAR_PER_NEAR² near chunks. If all of
        // them are resident we must NOT also add the coarse one: two
        // overlapping heightfields produce duplicate contacts and a character
        // that vibrates against the higher of the two surfaces.
        const n0x = ix * FAR_PER_NEAR;
        const n0z = iz * FAR_PER_NEAR;
        const n1x = n0x + FAR_PER_NEAR - 1;
        const n1z = n0z + FAR_PER_NEAR - 1;
        const covered =
          n0x >= nx - NEAR_RING && n1x <= nx + NEAR_RING &&
          n0z >= nz - NEAR_RING && n1z <= nz + NEAR_RING;
        if (covered) continue;

        const k = chunkKey(ix, iz, 1);
        wanted.add(k);
        if (!this.terrain.has(k) && !this.isQueued(k)) {
          this.pending.push({
            key: k,
            cx: (ix + 0.5) * FAR_CELL,
            cz: (iz + 0.5) * FAR_CELL,
            size: FAR_CELL,
            lod: 1,
            body: null,
            obj: null,
          });
        }
      }
    }

    // --- evict ------------------------------------------------------
    for (const [k, chunk] of this.terrain) {
      if (!wanted.has(k)) {
        this.destroyTerrainChunk(chunk);
        this.terrain.delete(k);
      }
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (!wanted.has(this.pending[i].key)) {
        this.pending[i] = this.pending[this.pending.length - 1];
        this.pending.pop();
      }
    }

    // --- buildings --------------------------------------------------
    const wantedB = new Set<number>();
    for (let iz = nz - BUILDING_RING; iz <= nz + BUILDING_RING; iz++) {
      for (let ix = nx - BUILDING_RING; ix <= nx + BUILDING_RING; ix++) {
        const k = chunkKey(ix, iz, 0);
        wantedB.add(k);
        if (!this.buildings.has(k) && !this.pendingBuildings.some((p) => p.key === k)) {
          this.pendingBuildings.push({ key: k, ix, iz });
        }
      }
    }
    for (const [k, chunk] of this.buildings) {
      if (!wantedB.has(k)) {
        this.destroyBuildingChunk(chunk);
        this.buildings.delete(k);
      }
    }
    for (let i = this.pendingBuildings.length - 1; i >= 0; i--) {
      if (!wantedB.has(this.pendingBuildings[i].key)) {
        this.pendingBuildings[i] = this.pendingBuildings[this.pendingBuildings.length - 1];
        this.pendingBuildings.pop();
      }
    }

    // Nearest-first: the chunk under your feet must never be the last built.
    this.pending.sort(
      (a, b) =>
        (a.cx - px) ** 2 + (a.cz - pz) ** 2 - ((b.cx - px) ** 2 + (b.cz - pz) ** 2),
    );
  }

  private isQueued(k: number): boolean {
    for (let i = 0; i < this.pending.length; i++) if (this.pending[i].key === k) return true;
    return false;
  }

  /* ---------------- building work ---------------- */

  private drainQueue(budgetMs: number): void {
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    const now = () => (typeof performance !== "undefined" ? performance.now() : t0);

    // Terrain first — you can fall through the ground, you cannot fall through
    // a missing building.
    while (this.pending.length > 0 && now() - t0 < budgetMs) {
      const chunk = this.pending.shift()!;
      if (this.terrain.has(chunk.key)) continue;
      if (this.buildTerrainChunk(chunk)) this.terrain.set(chunk.key, chunk);
    }
    while (this.pendingBuildings.length > 0 && now() - t0 < budgetMs) {
      const job = this.pendingBuildings.shift()!;
      if (this.buildings.has(job.key)) continue;
      const chunk = this.buildBuildingChunk(job.ix, job.iz, job.key);
      if (chunk) this.buildings.set(job.key, chunk);
    }

    this.stats.lastBuildMs = now() - t0;
  }

  private buildTerrainChunk(chunk: TerrainChunk): boolean {
    const r = rapier();
    const w = physics.world;
    if (!r || !w) return false;

    const half = chunk.size * 0.5;
    fillHeights(chunk.cx - half, chunk.cz - half, chunk.size);

    // The heightfield is centred on its body; the body carries the offset.
    _scale.x = chunk.size;
    _scale.y = 1;
    _scale.z = chunk.size;

    const body = w.createRigidBody(
      r.RigidBodyDesc.fixed().setTranslation(chunk.cx, 0, chunk.cz),
    );
    const desc = r.ColliderDesc.heightfield(
      SUBDIV,
      SUBDIV,
      _heights,
      _scale,
      r.HeightFieldFlags.FIX_INTERNAL_EDGES,
    )
      .setCollisionGroups(FILTER.terrain)
      // Loose dirt/asphalt: enough grip for tyres, not so much that a rolling
      // barrel stops dead the instant it touches the ground.
      .setFriction(0.92)
      .setRestitution(0.02)
      .setContactSkin(0.02);
    const collider = w.createCollider(desc, body);

    chunk.body = body;
    chunk.obj = registerObject({
      kind: "terrain",
      body,
      colliders: [collider],
      surface: "dirt",
      ref: chunk.key,
    });
    return true;
  }

  private destroyTerrainChunk(chunk: TerrainChunk): void {
    const w = physics.world;
    unregisterObject(chunk.obj);
    if (w && chunk.body) w.removeRigidBody(chunk.body);
    chunk.body = null;
    chunk.obj = null;
  }

  /**
   * One fixed body per cell carrying an oriented box per building whose
   * *centre* falls inside the cell.
   *
   * Ownership by centre rather than by overlap is what makes eviction exact:
   * a building that straddles two cells belongs to exactly one of them, so it
   * neither gets two colliders nor loses its only one when a neighbour unloads.
   */
  private buildBuildingChunk(ix: number, iz: number, key: number): BuildingChunk | null {
    const r = rapier();
    const w = physics.world;
    if (!r || !w) return null;
    if (!buildingIndex || typeof buildingIndex.queryAABB !== "function") return null;

    const minX = ix * NEAR_CELL;
    const minZ = iz * NEAR_CELL;
    const maxX = minX + NEAR_CELL;
    const maxZ = minZ + NEAR_CELL;

    _recs.length = 0;
    buildingIndex.queryAABB(minX, minZ, maxX, maxZ, _recs);
    if (_recs.length === 0) {
      // Still record the empty chunk so we do not re-query it every rescan.
      return { key, body: null, obj: null, ids: [] };
    }

    const body = w.createRigidBody(r.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
    const colliders: RAPIER.Collider[] = [];
    const ids: number[] = [];

    for (let i = 0; i < _recs.length; i++) {
      const b = _recs[i];
      if (b.cx < minX || b.cx >= maxX || b.cz < minZ || b.cz >= maxZ) continue;

      // Collide against the *mass* of the building, not `topY`: topY includes
      // spires and antennas, and an invisible box around Sutro Tower's needle
      // would stop a helicopter in mid-air for no visible reason.
      const top = Math.max(b.roofY, b.baseY + 2);
      const bottom = b.baseY - 4; // bury the base so hillside plinths never gap
      const hy = (top - bottom) * 0.5;
      const cy = bottom + hy;

      const h = b.yaw * 0.5;
      _quat.x = 0;
      _quat.y = Math.sin(h);
      _quat.z = 0;
      _quat.w = Math.cos(h);

      const desc = r.ColliderDesc.cuboid(b.hw, hy, b.hd)
        .setTranslation(b.cx, cy, b.cz)
        .setRotation(_quat)
        .setCollisionGroups(FILTER.building)
        .setFriction(0.8)
        .setRestitution(0.05);
      colliders.push(w.createCollider(desc, body));
      ids.push(b.id);
    }

    if (colliders.length === 0) {
      w.removeRigidBody(body);
      return { key, body: null, obj: null, ids: [] };
    }

    this.stats.buildingColliders += colliders.length;
    const obj = registerObject({
      kind: "building",
      body,
      colliders,
      surface: "concrete",
      ref: key,
    });
    return { key, body, obj, ids };
  }

  private destroyBuildingChunk(chunk: BuildingChunk): void {
    const w = physics.world;
    if (chunk.obj) this.stats.buildingColliders -= chunk.obj.colliders.length;
    unregisterObject(chunk.obj);
    if (w && chunk.body) w.removeRigidBody(chunk.body);
    chunk.body = null;
    chunk.obj = null;
    chunk.ids.length = 0;
  }

  /** Drop every streamed collider. Safe to call before boot. */
  dispose(): void {
    for (const c of this.terrain.values()) this.destroyTerrainChunk(c);
    for (const c of this.buildings.values()) this.destroyBuildingChunk(c);
    this.terrain.clear();
    this.buildings.clear();
    this.pending.length = 0;
    this.pendingBuildings.length = 0;
    this.lastScanX = Infinity;
    this.lastScanZ = Infinity;
    this.stats.buildingColliders = 0;
  }
}

/**
 * Sample `terrainHeight` into the scratch heights array.
 *
 * Layout, verified against the engine: the fastest-moving index is the matrix
 * row, and rows run along +Z. So the sample for world (x0 + ix*step,
 * z0 + iz*step) is written to `iz + ix * (SUBDIV + 1)`.
 */
function fillHeights(x0: number, z0: number, size: number): void {
  const step = size / SUBDIV;
  const stride = SUBDIV + 1;
  for (let ix = 0; ix <= SUBDIV; ix++) {
    const x = x0 + ix * step;
    const base = ix * stride;
    for (let iz = 0; iz <= SUBDIV; iz++) {
      _heights[base + iz] = terrainHeight(x, z0 + iz * step);
    }
  }
}

export const terrainCollider = new TerrainColliderStreamer();

/* ------------------------------------------------------------------ *
 * Static boxes fed by the integrator
 * ------------------------------------------------------------------ */

export interface StaticBox {
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
  /** Yaw about +Y, radians. */
  yaw?: number;
  friction?: number;
  restitution?: number;
  surface?: import("./world").SurfaceTag;
}

const staticGroups = new Map<string, { body: RAPIER.RigidBody; obj: PhysicsObject }>();

/**
 * Feed permanent world geometry that does not come from the building index —
 * landmark hulls, bridge decks, jersey barriers, the Alcatraz cliffs.
 *
 * Registered under a key so the owner can replace or drop the whole set in one
 * call. Re-registering the same key replaces it.
 */
export function registerStaticBoxes(
  key: string,
  boxes: StaticBox[],
  kind: "building" | "prop" | "terrain" = "building",
): boolean {
  const r = rapier();
  const w = physics.world;
  if (!r || !w) return false;

  removeStaticBoxes(key);
  if (boxes.length === 0) return true;

  const body = w.createRigidBody(r.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
  const colliders: RAPIER.Collider[] = [];
  for (const b of boxes) {
    const h = (b.yaw ?? 0) * 0.5;
    _quat.x = 0;
    _quat.y = Math.sin(h);
    _quat.z = 0;
    _quat.w = Math.cos(h);
    const desc = r.ColliderDesc.cuboid(Math.max(b.hx, 0.02), Math.max(b.hy, 0.02), Math.max(b.hz, 0.02))
      .setTranslation(b.cx, b.cy, b.cz)
      .setRotation(_quat)
      .setCollisionGroups(kind === "terrain" ? FILTER.terrain : FILTER.building)
      .setFriction(b.friction ?? 0.85)
      .setRestitution(b.restitution ?? 0.05);
    colliders.push(w.createCollider(desc, body));
  }

  const obj = registerObject({
    kind,
    body,
    colliders,
    surface: boxes[0].surface ?? "concrete",
    ref: key,
  });
  staticGroups.set(key, { body, obj });
  return true;
}

export function removeStaticBoxes(key: string): void {
  const entry = staticGroups.get(key);
  if (!entry) return;
  const w = physics.world;
  unregisterObject(entry.obj);
  if (w) w.removeRigidBody(entry.body);
  staticGroups.delete(key);
}

export function clearStaticBoxes(): void {
  for (const key of Array.from(staticGroups.keys())) removeStaticBoxes(key);
}

/* ------------------------------------------------------------------ *
 * Water
 * ------------------------------------------------------------------ */

let waterObj: PhysicsObject | null = null;

/**
 * A single world-sized sensor slab at sea level.
 *
 * Water is not simulated as a solid — buoyancy in `vehiclePhysics.ts` is
 * analytic — but gameplay still needs to *know* when something entered the
 * bay, so a sensor is exactly the right primitive: zero solver cost, one
 * begin/end event per entity, and it shows up in overlap queries as GROUP.WATER.
 */
export function ensureWaterSensor(): PhysicsObject | null {
  if (waterObj) return waterObj;
  const r = rapier();
  const w = physics.world;
  if (!r || !w) return null;

  const cx = (WORLD.minX + WORLD.maxX) * 0.5;
  const cz = (WORLD.minZ + WORLD.maxZ) * 0.5;
  const hx = (WORLD.maxX - WORLD.minX) * 0.5 + 500;
  const hz = (WORLD.maxZ - WORLD.minZ) * 0.5 + 500;
  const depth = 60; // slab from -60 m to sea level

  const body = w.createRigidBody(r.RigidBodyDesc.fixed().setTranslation(cx, WORLD.seaLevel - depth * 0.5, cz));
  const desc = r.ColliderDesc.cuboid(hx, depth * 0.5, hz)
    .setSensor(true)
    .setCollisionGroups(FILTER.water)
    .setActiveEvents(r.ActiveEvents.COLLISION_EVENTS)
    .setActiveCollisionTypes(r.ActiveCollisionTypes.ALL);
  const collider = w.createCollider(desc, body);

  waterObj = registerObject({
    kind: "water",
    body,
    colliders: [collider],
    surface: "water",
    ref: "bay",
  });
  return waterObj;
}

export function disposeTerrainColliders(): void {
  terrainCollider.dispose();
  clearStaticBoxes();
  if (waterObj) {
    const w = physics.world;
    if (w && waterObj.body) w.removeRigidBody(waterObj.body);
    unregisterObject(waterObj);
    waterObj = null;
  }
}
