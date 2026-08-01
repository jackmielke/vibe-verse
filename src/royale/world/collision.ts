/**
 * DROP ZERO — collision broadphase.
 *
 * Publishes `CollisionService`. Everything that moves goes through here: the
 * player capsule, every bot capsule, every bullet, the build preview, the
 * pickaxe, explosions and the loot drop test. It is the single hottest
 * non-render system in the game, so it is written as a flat spatial hash over
 * typed arrays rather than a tree of objects.
 *
 * ── Why a uniform hash and not a BVH ────────────────────────────────────────
 * A BVH is faster to query and *much* slower to edit, and this world edits
 * constantly: a build fight adds and removes a few hundred 4 m pieces in ten
 * seconds, and every removal would mean a refit up the tree. A uniform hash
 * inserts and removes in the time it takes to touch the handful of buckets a
 * box overlaps, which is what the build loop actually needs.
 *
 * ── Cell size: 8 m ─────────────────────────────────────────────────────────
 * The build grid is 4 m (`GRID`), so 8 m is exactly two build cells, and that
 * is the whole argument:
 *
 *  - A built wall/floor/ramp (4 m × 4 m, 0.25 m thick) lands in 1–4 buckets.
 *    Insert and remove touch at most four arrays. At a 4 m cell it would be
 *    1–9 buckets for no gain in candidate count, because a bucket cannot hold
 *    fewer than the pieces that share a grid cell anyway.
 *  - A POI building shell (12–40 m) spans 2–6 cells per axis, i.e. 4–36
 *    buckets. Still cheap to insert once at worldgen, and it keeps the
 *    per-bucket occupancy in single digits so a capsule resolve tests ~4–12
 *    boxes instead of the ~15 000 in the world.
 *  - A capsule (r ≈ 0.42) never straddles more than 2 × 2 cells, and a bullet
 *    DDA at 8 m steps crosses ~30 cells over a 250 m shot — few enough that
 *    the traversal overhead stays under the cost of the slab tests it saves.
 *
 * Going smaller (2–4 m) multiplies insert cost and bucket bookkeeping for
 * large static geometry; going larger (16–24 m, what San Palmas used) is fine
 * for a city of big prisms but buries the 0.25 m built pieces — a single
 * bucket in a built-up tower would hold 60+ walls and every capsule resolve
 * would test all of them. 8 m is the size that serves both populations.
 *
 * Boxes that span an absurd number of cells (a ground plane, a POI bounds
 * volume someone registers by mistake) go into an `oversized` list that every
 * query scans linearly, rather than being smeared across ten thousand
 * buckets.
 *
 * ── What this system does NOT do ───────────────────────────────────────────
 * No visuals except an opt-in debug wireframe (`dz:debug-collision`), no
 * gameplay decisions, no damage. It answers three questions — "am I inside
 * something", "what does this ray hit", "what is near this point" — and it
 * answers them without allocating on the hot path.
 */
import * as THREE from "three";
import type {
  BuildPiece,
  CapsuleResolve,
  ColliderHandle,
  ColliderOpts,
  CollisionService,
  DamageTarget,
  RayHit,
  System,
  SystemFactory,
  TerrainService,
} from "../types";

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

/** Spatial hash cell size in metres. See the header for why this is 8. */
const CELL = 8;
const INV_CELL = 1 / CELL;

/**
 * A box wider than this many cells on either axis is filed as "oversized" and
 * scanned linearly. 24 cells is 192 m — larger than any building or cliff we
 * author, so in practice only genuinely global colliders land here.
 */
const MAX_CELL_SPAN = 24;

/** Initial slot capacity. Grows by doubling; worldgen fills ~8–15k. */
const INITIAL_CAPACITY = 2048;

/**
 * Capsule resolution passes. One pass fixes a single-surface penetration;
 * a capsule wedged into an inside corner needs the second, and a corner where
 * a built ramp meets two walls needs the third. Four is belt-and-braces and
 * costs nothing because the loop breaks the moment a pass moves nothing.
 */
const RESOLVE_ITERATIONS = 4;

/**
 * How far the feet may be lifted onto a surface in one resolve — the step
 * height. 0.62 m clears a kerb, a doorstep, a loot chest lid and the 0.25 m
 * lip of a built floor, and is under half a build cell so you can never walk
 * up a wall.
 */
const STEP_HEIGHT = 0.62;

/**
 * Downward reach of the support probe. Anything solid within this distance of
 * the feet counts as ground even when nothing is penetrating. Two frames of
 * free-fall at 120 Hz is under 5 cm, so 0.24 m never reports a false airborne
 * on a slope, and is small enough that stepping off a roof drops you inside
 * two fixed steps.
 */
const GROUND_PROBE = 0.24;

/**
 * Fraction of the capsule radius one continuous-collision substep may cover.
 * The failure mode this exists to prevent: a sprinting player crossing a
 * 0.25 m built wall between two fixed steps. Keeping each substep under the
 * radius guarantees the capsule centre can never reach the far side of a
 * surface it started clear of, so minimum-penetration resolution always picks
 * the side the player came from.
 */
const SUBSTEP_FRACTION = 0.6;

/**
 * Penetration below this is left alone — the "allowed penetration" every
 * solver has. Two reasons it must be non-zero:
 *
 *  - Bounds are stored as float32, whose quantum at the ±1500 m map edge is
 *    ~1.2e-4 m. Without slop, a capsule resting exactly on a surface reports
 *    a resolved penetration every single step purely from that rounding, and
 *    `hit` — which callers read as "something blocked me" — is then always
 *    true while you are merely standing still.
 *  - It stops the 3-4 resolution passes from ping-ponging a capsule between
 *    two coplanar surfaces (the seam between two built floors) forever.
 *
 * 0.5 mm: comfortably above the float32 quantum, far below anything visible.
 */
const PENETRATION_SLOP = 5e-4;

/**
 * Hard ceiling on substeps per resolve, so a teleport can't spin the CPU.
 * At r = 0.42 this fully covers 6 m of motion per call — 720 m/s at the fixed
 * step, which is faster than anything in the game including grenade knockback.
 * Beyond that the sweep degrades gracefully to a coarse one rather than
 * blowing the frame budget.
 */
const MAX_SUBSTEPS = 24;

/**
 * Movement beyond this in one resolve is a teleport (bus drop, respawn,
 * launch pad), not motion — sweeping it would drag the capsule through the
 * whole map testing every cell on the line. Resolve in place instead.
 */
const TELEPORT_DISTANCE = 40;

/** Cells a single raycast may walk before giving up. 512 × 8 m = 4 km. */
const MAX_DDA_CELLS = 512;

/** Terrain march: first step, growth per step, and the far-field cap. */
const TERRAIN_STEP_NEAR = 0.5;
const TERRAIN_STEP_GROWTH = 1.09;
const TERRAIN_STEP_FAR = 14;
/** Bisections once the march brackets the surface. 2^-16 of a step is plenty. */
const TERRAIN_BISECT = 16;
/** Ceiling on terrain samples per ray. */
const MAX_TERRAIN_SAMPLES = 160;

/** Debug wireframe: rebuild rate and the box budget around the camera. */
const DEBUG_REBUILD_HZ = 6;
const DEBUG_RADIUS = 90;
const DEBUG_MAX_BOXES = 1400;

/* ------------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------------ */

/**
 * Pack a cell coordinate pair into one int32. Halves are 16-bit, so the hash
 * is unique for |c| < 32768 — 262 km either side of the origin at 8 m cells.
 * The world is 3 km across; nothing legitimate can wrap this.
 */
function cellKey(cx: number, cz: number): number {
  return ((cx & 0xffff) << 16) | (cz & 0xffff);
}

/**
 * `owner` is deliberately `unknown` in the contract — collision must not know
 * what a build piece or a bot is. These duck-typed narrowings are the price of
 * that decoupling: they let a RayHit carry `piece`/`target` through without
 * this module importing either system.
 */
function asBuildPiece(owner: unknown): BuildPiece | undefined {
  if (!owner || typeof owner !== "object") return undefined;
  const p = owner as Partial<BuildPiece>;
  if (typeof p.id !== "number" || typeof p.hp !== "number" || typeof p.kind !== "string") {
    return undefined;
  }
  return owner as BuildPiece;
}

function asDamageTarget(owner: unknown): DamageTarget | undefined {
  if (!owner || typeof owner !== "object") return undefined;
  const t = owner as Partial<DamageTarget>;
  if (typeof t.id !== "string" || typeof t.hp !== "number" || typeof t.faction !== "string") {
    return undefined;
  }
  return owner as DamageTarget;
}

/** Mutable view of the resolve result while we accumulate into it. */
interface MutableResolve {
  hit: boolean;
  grounded: boolean;
  groundY: number;
  groundNormal: THREE.Vector3;
}

/* ------------------------------------------------------------------------ *
 * The broadphase
 * ------------------------------------------------------------------------ */

class Broadphase implements CollisionService {
  /** minX,minY,minZ,maxX,maxY,maxZ per slot. */
  private bounds: Float32Array;
  /** cx0,cx1,cz0,cz1 per slot — kept so removal can find its buckets again. */
  private rect: Int32Array;
  /** 0 = free, 1 = live, 2 = live + oversized. */
  private state: Uint8Array;
  /** Bumped on free, so a stale remover closure cannot delete a new collider. */
  private gen: Int32Array;
  /** Per-slot visit stamp: a box in four buckets is tested once per query. */
  private stamp: Int32Array;
  /** Cold data, only touched once a query has already decided it hit. */
  private opts: (ColliderOpts | undefined)[] = [];

  private capacity = 0;
  private nextSlot = 0;
  private free: number[] = [];
  private live = 0;

  private cells = new Map<number, number[]>();
  private oversized: number[] = [];
  private tick = 0;

  /**
   * Last resolved position per capsule, keyed by the caller's own Vector3.
   * This is how `resolveCapsule` gets a swept motion out of an API that only
   * ever sees the destination. Weak so a dead bot's entry evaporates with it.
   */
  private lastPos = new WeakMap<THREE.Vector3, THREE.Vector3>();

  /**
   * Running maximum of every terrain height we have ever sampled. Used purely
   * as an early-out: a ray already climbing and well above anything the island
   * has shown us cannot come back down onto it.
   */
  private terrainMaxSeen = -Infinity;

  constructor() {
    this.capacity = INITIAL_CAPACITY;
    this.bounds = new Float32Array(this.capacity * 6);
    this.rect = new Int32Array(this.capacity * 4);
    this.state = new Uint8Array(this.capacity);
    this.gen = new Int32Array(this.capacity);
    this.stamp = new Int32Array(this.capacity);
  }

  get count(): number {
    return this.live;
  }

  /* -------------------------------------------------------------- storage */

  private grow(): void {
    const cap = this.capacity * 2;
    const bounds = new Float32Array(cap * 6);
    bounds.set(this.bounds);
    const rect = new Int32Array(cap * 4);
    rect.set(this.rect);
    const state = new Uint8Array(cap);
    state.set(this.state);
    const gen = new Int32Array(cap);
    gen.set(this.gen);
    this.bounds = bounds;
    this.rect = rect;
    this.state = state;
    this.gen = gen;
    // Stamps reset to 0 here, which is safe: `tick` only ever counts up and
    // starts at 1, so a zeroed stamp can never match the current query.
    this.stamp = new Int32Array(cap);
    this.capacity = cap;
  }

  addBox(box: THREE.Box3, opts?: ColliderOpts): () => void {
    // A NaN box would poison every bucket it touches and be impossible to
    // find again. Reject it here rather than debugging it in the raycast.
    if (
      !box ||
      !Number.isFinite(box.min.x) ||
      !Number.isFinite(box.min.y) ||
      !Number.isFinite(box.min.z) ||
      !Number.isFinite(box.max.x) ||
      !Number.isFinite(box.max.y) ||
      !Number.isFinite(box.max.z)
    ) {
      return () => {};
    }

    if (this.nextSlot >= this.capacity && this.free.length === 0) this.grow();
    const id = this.free.length > 0 ? (this.free.pop() as number) : this.nextSlot++;

    const b = id * 6;
    // Tolerate a box authored inside-out — worldgen builds a lot of these from
    // expandByPoint on unsorted corners.
    this.bounds[b] = Math.min(box.min.x, box.max.x);
    this.bounds[b + 1] = Math.min(box.min.y, box.max.y);
    this.bounds[b + 2] = Math.min(box.min.z, box.max.z);
    this.bounds[b + 3] = Math.max(box.min.x, box.max.x);
    this.bounds[b + 4] = Math.max(box.min.y, box.max.y);
    this.bounds[b + 5] = Math.max(box.min.z, box.max.z);
    this.opts[id] = opts;
    this.live++;

    const cx0 = Math.floor(this.bounds[b] * INV_CELL);
    const cx1 = Math.floor(this.bounds[b + 3] * INV_CELL);
    const cz0 = Math.floor(this.bounds[b + 2] * INV_CELL);
    const cz1 = Math.floor(this.bounds[b + 5] * INV_CELL);
    const r = id * 4;
    this.rect[r] = cx0;
    this.rect[r + 1] = cx1;
    this.rect[r + 2] = cz0;
    this.rect[r + 3] = cz1;

    if (cx1 - cx0 > MAX_CELL_SPAN || cz1 - cz0 > MAX_CELL_SPAN) {
      this.state[id] = 2;
      this.oversized.push(id);
    } else {
      this.state[id] = 1;
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const k = cellKey(cx, cz);
          const bucket = this.cells.get(k);
          if (bucket) bucket.push(id);
          else this.cells.set(k, [id]);
        }
      }
    }

    const generation = this.gen[id];
    return () => this.removeSlot(id, generation);
  }

  /**
   * O(cells touched × bucket length), and both are small by construction —
   * a built wall is in ≤ 4 buckets of ≤ 12 entries. Swap-pop keeps the bucket
   * arrays dense without ever reallocating them, which matters because a
   * build fight churns hundreds of pieces a second.
   */
  private removeSlot(id: number, generation: number): void {
    if (id < 0 || id >= this.capacity) return;
    if (this.state[id] === 0 || this.gen[id] !== generation) return;

    if (this.state[id] === 2) {
      const i = this.oversized.indexOf(id);
      if (i >= 0) {
        this.oversized[i] = this.oversized[this.oversized.length - 1];
        this.oversized.pop();
      }
    } else {
      const r = id * 4;
      for (let cz = this.rect[r + 2]; cz <= this.rect[r + 3]; cz++) {
        for (let cx = this.rect[r]; cx <= this.rect[r + 1]; cx++) {
          const k = cellKey(cx, cz);
          const bucket = this.cells.get(k);
          if (!bucket) continue;
          const i = bucket.indexOf(id);
          if (i >= 0) {
            bucket[i] = bucket[bucket.length - 1];
            bucket.pop();
          }
          // Drop the empty bucket: a tower that gets shot down should give the
          // map back, otherwise a long match leaks one Map entry per cell ever
          // built in.
          if (bucket.length === 0) this.cells.delete(k);
        }
      }
    }

    this.state[id] = 0;
    this.gen[id] = (this.gen[id] + 1) | 0;
    this.opts[id] = undefined;
    this.live--;
    this.free.push(id);
  }

  /* ------------------------------------------------------- capsule resolve */

  /**
   * `pos` is the capsule's FEET. The capsule occupies [pos.y, pos.y + height]
   * with the given radius, which is the convention the player and every bot
   * uses. The vector is mutated in place.
   */
  resolveCapsule(pos: THREE.Vector3, radius: number, height: number): CapsuleResolve {
    const out: MutableResolve = {
      hit: false,
      grounded: false,
      groundY: -Infinity,
      groundNormal: new THREE.Vector3(0, 1, 0),
    };
    if (!(radius > 0) || !(height > 0) || !Number.isFinite(pos.x)) return out;

    // --- Continuous collision -------------------------------------------
    // Split the motion since the last resolve into substeps no longer than a
    // fraction of the radius, and resolve at each. Without this a player at
    // sprint speed plus a knockback impulse can put 1.5 m of travel into one
    // 120 Hz step, which is six wall thicknesses.
    const prev = this.lastPos.get(pos);
    if (prev) {
      const dx = pos.x - prev.x;
      const dy = pos.y - prev.y;
      const dz = pos.z - prev.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const stepLen = radius * SUBSTEP_FRACTION;
      if (dist > stepLen && dist < TELEPORT_DISTANCE) {
        const steps = Math.min(Math.ceil(dist / stepLen), MAX_SUBSTEPS);
        const sx = dx / steps;
        const sy = dy / steps;
        const sz = dz / steps;
        // Rewind to where the capsule actually was, then walk it forward.
        // Advancing from the *resolved* position each time is what makes
        // sliding along a wall accumulate correctly instead of snapping back.
        pos.set(prev.x, prev.y, prev.z);
        for (let i = 0; i < steps; i++) {
          pos.x += sx;
          pos.y += sy;
          pos.z += sz;
          this.resolveAt(pos, radius, height, out);
        }
      } else {
        this.resolveAt(pos, radius, height, out);
      }
    } else {
      this.resolveAt(pos, radius, height, out);
    }

    // --- Support probe ---------------------------------------------------
    this.probeGround(pos, radius, out);
    this.probeTerrain(pos, out);

    if (!out.grounded) out.groundY = pos.y;

    let store = this.lastPos.get(pos);
    if (!store) {
      store = new THREE.Vector3();
      this.lastPos.set(pos, store);
    }
    store.copy(pos);
    return out;
  }

  /** Iterate minimum-penetration passes until nothing moves. */
  private resolveAt(
    pos: THREE.Vector3,
    radius: number,
    height: number,
    out: MutableResolve,
  ): void {
    for (let iter = 0; iter < RESOLVE_ITERATIONS; iter++) {
      if (!this.resolvePass(pos, radius, height, out)) break;
    }
  }

  /**
   * One pass over every collider the capsule's footprint touches. Returns true
   * when something was pushed, so the caller knows to run another pass.
   */
  private resolvePass(
    pos: THREE.Vector3,
    radius: number,
    height: number,
    out: MutableResolve,
  ): boolean {
    let moved = false;
    this.tick++;
    const tick = this.tick;

    const cx0 = Math.floor((pos.x - radius) * INV_CELL);
    const cx1 = Math.floor((pos.x + radius) * INV_CELL);
    const cz0 = Math.floor((pos.z - radius) * INV_CELL);
    const cz1 = Math.floor((pos.z + radius) * INV_CELL);

    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const bucket = this.cells.get(cellKey(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const id = bucket[i];
          if (this.stamp[id] === tick) continue;
          this.stamp[id] = tick;
          if (this.pushOut(id, pos, radius, height, out)) moved = true;
        }
      }
    }
    for (let i = 0; i < this.oversized.length; i++) {
      const id = this.oversized[i];
      if (this.stamp[id] === tick) continue;
      this.stamp[id] = tick;
      if (this.pushOut(id, pos, radius, height, out)) moved = true;
    }
    return moved;
  }

  /**
   * Separate the capsule from one box along the axis of minimum penetration.
   *
   * Two regimes, and getting the second one right is what stops the player
   * catching on the outside corner of every wall they run past:
   *
   *  - Centre inside the box footprint: the cheapest horizontal escape is one
   *    of the four faces, so compare all four against the vertical escapes.
   *  - Centre outside the footprint (i.e. near an edge or a corner): the
   *    cheapest horizontal escape is radial, away from the closest point on
   *    the rectangle. Using face pushes here would shove the capsule sideways
   *    along a wall it was only clipping the end of.
   */
  private pushOut(
    id: number,
    pos: THREE.Vector3,
    radius: number,
    height: number,
    out: MutableResolve,
  ): boolean {
    const b = id * 6;
    const minX = this.bounds[b];
    const minY = this.bounds[b + 1];
    const minZ = this.bounds[b + 2];
    const maxX = this.bounds[b + 3];
    const maxY = this.bounds[b + 4];
    const maxZ = this.bounds[b + 5];

    const feet = pos.y;
    const head = pos.y + height;
    if (head <= minY || feet >= maxY) return false;

    // Closest point on the box footprint to the capsule axis.
    const qx = pos.x < minX ? minX : pos.x > maxX ? maxX : pos.x;
    const qz = pos.z < minZ ? minZ : pos.z > maxZ ? maxZ : pos.z;
    const ex = pos.x - qx;
    const ez = pos.z - qz;
    const d2 = ex * ex + ez * ez;
    if (d2 >= radius * radius) return false;

    const pushUp = maxY - feet; // stand on top
    const pushDown = head - minY; // duck under

    // Horizontal minimum-translation vector.
    let hDist: number;
    let hx = 0;
    let hz = 0;
    if (d2 > 1e-10) {
      const d = Math.sqrt(d2);
      hDist = radius - d;
      hx = ex / d;
      hz = ez / d;
    } else {
      const west = pos.x - minX + radius;
      const east = maxX - pos.x + radius;
      const north = pos.z - minZ + radius;
      const south = maxZ - pos.z + radius;
      hDist = west;
      hx = -1;
      hz = 0;
      if (east < hDist) {
        hDist = east;
        hx = 1;
        hz = 0;
      }
      if (north < hDist) {
        hDist = north;
        hx = 0;
        hz = -1;
      }
      if (south < hDist) {
        hDist = south;
        hx = 0;
        hz = 1;
      }
    }

    // Resting contact, not a collision. Both vertical depths are positive by
    // the overlap test above and hDist is positive by the radius test, so this
    // is the true minimum translation distance.
    if (hDist < PENETRATION_SLOP || pushUp < PENETRATION_SLOP || pushDown < PENETRATION_SLOP) {
      return false;
    }

    /**
     * Standing on top wins whenever the lift is within step height, even if a
     * sideways push would be marginally cheaper. That single bias is what
     * makes built floors, ramps, roof edges, kerbs and stair treads walkable
     * instead of surfaces you slide off — and because STEP_HEIGHT is well
     * under a build cell, it can never be abused to climb a wall.
     */
    const standable = pushUp > 0 && pushUp <= STEP_HEIGHT;
    if (standable || (pushUp <= hDist && pushUp <= pushDown)) {
      pos.y = maxY;
      out.hit = true;
      if (maxY > out.groundY) {
        out.groundY = maxY;
        out.groundNormal.set(0, 1, 0);
      }
      out.grounded = true;
      return true;
    }

    if (pushDown < hDist) {
      // Head-bonk. Leave a hair of clearance so the next pass doesn't find the
      // capsule exactly coincident with the face and flip-flop.
      pos.y = minY - height - 1e-4;
      out.hit = true;
      return true;
    }

    pos.x += hx * hDist;
    pos.z += hz * hDist;
    out.hit = true;
    return true;
  }

  /**
   * Find support under the feet when nothing is penetrating — walking along a
   * floor at exactly its surface height produces no penetration at all, and a
   * player who is only "grounded" on the frames they happen to be sunk into
   * the geometry cannot jump reliably.
   */
  private probeGround(pos: THREE.Vector3, radius: number, out: MutableResolve): void {
    this.tick++;
    const tick = this.tick;
    const lo = pos.y - GROUND_PROBE;
    const hi = pos.y + 0.06;

    const cx0 = Math.floor((pos.x - radius) * INV_CELL);
    const cx1 = Math.floor((pos.x + radius) * INV_CELL);
    const cz0 = Math.floor((pos.z - radius) * INV_CELL);
    const cz1 = Math.floor((pos.z + radius) * INV_CELL);

    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const bucket = this.cells.get(cellKey(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const id = bucket[i];
          if (this.stamp[id] === tick) continue;
          this.stamp[id] = tick;
          this.probeOne(id, pos, radius, lo, hi, out);
        }
      }
    }
    for (let i = 0; i < this.oversized.length; i++) {
      const id = this.oversized[i];
      if (this.stamp[id] === tick) continue;
      this.stamp[id] = tick;
      this.probeOne(id, pos, radius, lo, hi, out);
    }
  }

  private probeOne(
    id: number,
    pos: THREE.Vector3,
    radius: number,
    lo: number,
    hi: number,
    out: MutableResolve,
  ): void {
    const b = id * 6;
    const top = this.bounds[b + 4];
    if (top < lo || top > hi || top <= out.groundY) return;
    const minX = this.bounds[b];
    const minZ = this.bounds[b + 2];
    const maxX = this.bounds[b + 3];
    const maxZ = this.bounds[b + 5];
    const qx = pos.x < minX ? minX : pos.x > maxX ? maxX : pos.x;
    const qz = pos.z < minZ ? minZ : pos.z > maxZ ? maxZ : pos.z;
    const ex = pos.x - qx;
    const ez = pos.z - qz;
    if (ex * ex + ez * ez >= radius * radius) return;
    out.groundY = top;
    out.groundNormal.set(0, 1, 0);
    out.grounded = true;
  }

  /**
   * The heightfield is not in the hash — it is a function, and sampling it is
   * cheaper than storing it. Sinking below it is the one bug nobody can
   * recover from in-game, so the capsule is lifted back out unconditionally.
   *
   * Deliberately does NOT set `hit`: consumers read `hit` as "something
   * blocked me this step", and standing on the island is not that.
   */
  private probeTerrain(pos: THREE.Vector3, out: MutableResolve): void {
    const terrain = this.terrain;
    if (!terrain) return;
    const ty = terrain.heightAt(pos.x, pos.z);
    if (!Number.isFinite(ty)) return;
    if (ty > this.terrainMaxSeen) this.terrainMaxSeen = ty;

    if (pos.y < ty) {
      pos.y = ty;
      out.groundY = ty;
      out.grounded = true;
      terrain.normalAt(pos.x, pos.z, out.groundNormal);
      return;
    }
    // A built floor 2 cm above the dirt should win the ground contact, so only
    // take the terrain when it is the higher of the two.
    if (ty > out.groundY && pos.y - ty <= GROUND_PROBE) {
      out.groundY = ty;
      out.grounded = true;
      terrain.normalAt(pos.x, pos.z, out.groundNormal);
    }
  }

  /* --------------------------------------------------------------- raycast */

  // Scratch state for the ray hot path. A weapon fires several rays per frame,
  // every bot line-of-sight check is a ray, and the build preview casts one
  // every single frame — none of them may allocate until there is a hit.
  private hitNormal = new THREE.Vector3();

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
    const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    if (!(len > 1e-8) || !(maxDist > 0)) return null;
    const dx = dir.x / len;
    const dy = dir.y / len;
    const dz = dir.z / len;
    /**
     * A huge finite reciprocal rather than Infinity for an axis the ray is
     * parallel to. `1/0` looks equivalent until the origin sits exactly on a
     * box face plane — then the slab test evaluates `0 * Infinity`, gets NaN,
     * and every comparison against it is false, which silently drops that
     * axis' constraint and produces a phantom hit. Grid-aligned build pieces
     * and a player standing on a grid line make that case common here, not
     * theoretical.
     */
    const ix = dx !== 0 ? 1 / dx : 1e30;
    const iy = dy !== 0 ? 1 / dy : 1e30;
    const iz = dz !== 0 ? 1 / dz : 1e30;

    this.tick++;
    const tick = this.tick;
    let bestT = maxDist;
    let bestId = -1;

    for (let i = 0; i < this.oversized.length; i++) {
      const id = this.oversized[i];
      this.stamp[id] = tick;
      const t = this.slab(id, origin.x, origin.y, origin.z, ix, iy, iz, bestT);
      if (t >= 0 && t < bestT) {
        bestT = t;
        bestId = id;
      }
    }

    // --- 2-D DDA over the XZ lattice -------------------------------------
    // Colliders are prisms in Y, so the vertical axis never needs its own
    // traversal — the slab test covers it. Walking cells means a 250 m shot
    // across a built-up POI tests ~40 boxes instead of ~15 000.
    let cx = Math.floor(origin.x * INV_CELL);
    let cz = Math.floor(origin.z * INV_CELL);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const tDeltaX = stepX !== 0 ? Math.abs(CELL * ix) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(CELL * iz) : Infinity;
    let tMaxX =
      stepX !== 0 ? ((stepX > 0 ? (cx + 1) * CELL : cx * CELL) - origin.x) * ix : Infinity;
    let tMaxZ =
      stepZ !== 0 ? ((stepZ > 0 ? (cz + 1) * CELL : cz * CELL) - origin.z) * iz : Infinity;

    let entry = 0;
    for (let guard = 0; guard < MAX_DDA_CELLS; guard++) {
      // Everything in a further cell is further away than what we already
      // found — this is the early-out that makes the DDA worth the bookkeeping.
      if (bestId >= 0 && bestT <= entry) break;
      const bucket = this.cells.get(cellKey(cx, cz));
      if (bucket) {
        for (let i = 0; i < bucket.length; i++) {
          const id = bucket[i];
          if (this.stamp[id] === tick) continue;
          this.stamp[id] = tick;
          const t = this.slab(id, origin.x, origin.y, origin.z, ix, iy, iz, bestT);
          if (t >= 0 && t < bestT) {
            bestT = t;
            bestId = id;
          }
        }
      }
      const next = tMaxX < tMaxZ ? tMaxX : tMaxZ;
      if (next >= maxDist) break;
      entry = next;
      if (tMaxX < tMaxZ) {
        cx += stepX;
        tMaxX += tDeltaX;
      } else {
        cz += stepZ;
        tMaxZ += tDeltaZ;
      }
    }

    // --- Terrain ----------------------------------------------------------
    // Only march as far as the nearest box hit: a shot into a wall never pays
    // for a heightfield march behind it.
    const groundT = this.marchTerrain(origin, dx, dy, dz, bestId >= 0 ? bestT : maxDist);
    if (groundT >= 0) return this.makeTerrainHit(origin, dx, dy, dz, groundT);
    if (bestId < 0) return null;
    return this.makeBoxHit(bestId, origin, dx, dy, dz, bestT);
  }

  /** Slab test against one slot. Returns entry distance, or -1 on a miss. */
  private slab(
    id: number,
    ox: number,
    oy: number,
    oz: number,
    ix: number,
    iy: number,
    iz: number,
    limit: number,
  ): number {
    const b = id * 6;
    let t0 = 0;
    let t1 = limit;

    let n0 = (this.bounds[b] - ox) * ix;
    let n1 = (this.bounds[b + 3] - ox) * ix;
    if (n0 > n1) {
      const s = n0;
      n0 = n1;
      n1 = s;
    }
    if (n0 > t0) t0 = n0;
    if (n1 < t1) t1 = n1;
    if (t1 < t0) return -1;

    n0 = (this.bounds[b + 1] - oy) * iy;
    n1 = (this.bounds[b + 4] - oy) * iy;
    if (n0 > n1) {
      const s = n0;
      n0 = n1;
      n1 = s;
    }
    if (n0 > t0) t0 = n0;
    if (n1 < t1) t1 = n1;
    if (t1 < t0) return -1;

    n0 = (this.bounds[b + 2] - oz) * iz;
    n1 = (this.bounds[b + 5] - oz) * iz;
    if (n0 > n1) {
      const s = n0;
      n0 = n1;
      n1 = s;
    }
    if (n0 > t0) t0 = n0;
    if (n1 < t1) t1 = n1;
    if (t1 < t0) return -1;

    return t0;
  }

  /**
   * Face normal from the slab the ray crossed last on the way in. Recomputing
   * the three entry distances is exact; comparing the hit point against each
   * face with an epsilon (the obvious approach) picks the wrong face on a
   * grazing hit and produces impact decals lying flat on a wall.
   */
  private boxNormal(
    id: number,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    out: THREE.Vector3,
  ): void {
    const b = id * 6;
    const tx = dx !== 0 ? ((dx > 0 ? this.bounds[b] : this.bounds[b + 3]) - ox) / dx : -Infinity;
    const ty =
      dy !== 0 ? ((dy > 0 ? this.bounds[b + 1] : this.bounds[b + 4]) - oy) / dy : -Infinity;
    const tz =
      dz !== 0 ? ((dz > 0 ? this.bounds[b + 2] : this.bounds[b + 5]) - oz) / dz : -Infinity;

    if (tx >= ty && tx >= tz) out.set(dx > 0 ? -1 : 1, 0, 0);
    else if (ty >= tz) out.set(0, dy > 0 ? -1 : 1, 0);
    else out.set(0, 0, dz > 0 ? -1 : 1);
  }

  private makeBoxHit(
    id: number,
    origin: THREE.Vector3,
    dx: number,
    dy: number,
    dz: number,
    t: number,
  ): RayHit {
    this.boxNormal(id, origin.x, origin.y, origin.z, dx, dy, dz, this.hitNormal);
    const opts = this.opts[id];
    const owner = opts?.owner;
    const target = asDamageTarget(owner);
    const piece = opts?.built ? asBuildPiece(owner) : undefined;
    const object =
      owner instanceof THREE.Object3D ? owner : target ? target.object : undefined;

    return {
      point: new THREE.Vector3(origin.x + dx * t, origin.y + dy * t, origin.z + dz * t),
      normal: this.hitNormal.clone(),
      distance: t,
      object,
      material: opts?.material,
      harvest: opts?.harvest,
      piece,
      target,
      tag: opts?.tag,
    };
  }

  /**
   * March the heightfield until the ray crosses below it, then bisect.
   *
   * A fixed fine step is unaffordable at battle-royale ranges and a fixed
   * coarse step tunnels straight through ridge lines, so the step grows with
   * distance: metre-scale where the shot matters and where the geometry is in
   * front of your face, tens of metres out at the far plane where a whole hill
   * is a couple of pixels. Returns distance, or -1 when the ray never lands.
   */
  private marchTerrain(
    origin: THREE.Vector3,
    dx: number,
    dy: number,
    dz: number,
    limit: number,
  ): number {
    const terrain = this.terrain;
    if (!terrain || !(limit > 0)) return -1;

    let h = terrain.heightAt(origin.x, origin.z);
    if (h > this.terrainMaxSeen) this.terrainMaxSeen = h;
    let prevT = 0;
    let prevClear = origin.y - h;
    // Already underground: the caller is inside a hill, and reporting the hit
    // at the origin is the only answer that keeps a bullet from escaping.
    if (prevClear <= 0) return 0;

    // Climbing, and already above everything the island has ever shown us.
    // The margin is generous because `terrainMaxSeen` calibrates from nothing.
    if (dy >= 0 && origin.y > this.terrainMaxSeen + 250) return -1;

    let t = 0;
    let step = TERRAIN_STEP_NEAR;
    for (let i = 0; i < MAX_TERRAIN_SAMPLES && t < limit; i++) {
      t = Math.min(t + step, limit);
      const x = origin.x + dx * t;
      const y = origin.y + dy * t;
      const z = origin.z + dz * t;
      h = terrain.heightAt(x, z);
      if (h > this.terrainMaxSeen) this.terrainMaxSeen = h;
      const clear = y - h;
      if (clear <= 0) {
        // Bracketed between prevT (above) and t (below). Bisect for a contact
        // point tight enough that a decal never floats off a slope.
        let lo = prevT;
        let hi = t;
        for (let k = 0; k < TERRAIN_BISECT; k++) {
          const mid = (lo + hi) * 0.5;
          const my = origin.y + dy * mid;
          if (my - terrain.heightAt(origin.x + dx * mid, origin.z + dz * mid) > 0) lo = mid;
          else hi = mid;
        }
        return hi;
      }
      prevT = t;
      prevClear = clear;
      step = Math.min(step * TERRAIN_STEP_GROWTH, TERRAIN_STEP_FAR);
      // Sprint through empty air: never step further than the current
      // clearance allows if the ray is descending steeply, or a cliff edge
      // gets skipped between samples.
      if (dy < -0.05) step = Math.min(step, Math.max(TERRAIN_STEP_NEAR, prevClear / -dy));
    }
    return -1;
  }

  private makeTerrainHit(
    origin: THREE.Vector3,
    dx: number,
    dy: number,
    dz: number,
    t: number,
  ): RayHit {
    const terrain = this.terrain;
    const x = origin.x + dx * t;
    const y = origin.y + dy * t;
    const z = origin.z + dz * t;
    const normal = new THREE.Vector3(0, 1, 0);
    let material = terrain?.materialAt(x, z);
    if (terrain) {
      terrain.normalAt(x, z, normal);
      // Below the waterline the surface a bullet actually meets is water, and
      // the splash/ricochet families differ. Terrain reports the seabed.
      if (y < terrain.seaLevel) material = "water";
    }
    return {
      point: new THREE.Vector3(x, y, z),
      normal,
      distance: t,
      material: material ?? "dirt",
      tag: "terrain",
    };
  }

  /* ----------------------------------------------------------------- query */

  /**
   * Cold path — explosions and build validation, a few times a second, not a
   * few hundred times a frame. Allocating a handle per result is fine here and
   * keeps the caller's life simple.
   *
   * The returned `box` is a copy. Colliders never move (they are added and
   * removed, never translated), so a copy can only go stale by the collider
   * being destroyed, which the handle's own `remove` already guards against.
   */
  query(center: THREE.Vector3, radius: number): ColliderHandle[] {
    const results: ColliderHandle[] = [];
    if (!(radius > 0)) return results;
    this.tick++;
    const tick = this.tick;

    const cx0 = Math.floor((center.x - radius) * INV_CELL);
    const cx1 = Math.floor((center.x + radius) * INV_CELL);
    const cz0 = Math.floor((center.z - radius) * INV_CELL);
    const cz1 = Math.floor((center.z + radius) * INV_CELL);
    const r2 = radius * radius;

    const consider = (id: number) => {
      if (this.stamp[id] === tick) return;
      this.stamp[id] = tick;
      const b = id * 6;
      // Sphere vs AABB: squared distance to the closest point on the box.
      let d2 = 0;
      for (let a = 0; a < 3; a++) {
        const v = a === 0 ? center.x : a === 1 ? center.y : center.z;
        const lo = this.bounds[b + a];
        const hi = this.bounds[b + 3 + a];
        if (v < lo) d2 += (lo - v) * (lo - v);
        else if (v > hi) d2 += (v - hi) * (v - hi);
      }
      if (d2 > r2) return;
      results.push(this.handle(id));
    };

    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const bucket = this.cells.get(cellKey(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) consider(bucket[i]);
      }
    }
    for (let i = 0; i < this.oversized.length; i++) consider(this.oversized[i]);
    return results;
  }

  private handle(id: number): ColliderHandle {
    const b = id * 6;
    const generation = this.gen[id];
    return {
      box: new THREE.Box3(
        new THREE.Vector3(this.bounds[b], this.bounds[b + 1], this.bounds[b + 2]),
        new THREE.Vector3(this.bounds[b + 3], this.bounds[b + 4], this.bounds[b + 5]),
      ),
      opts: this.opts[id] ?? {},
      remove: () => this.removeSlot(id, generation),
    };
  }

  /**
   * Extra beyond `CollisionService`: a boolean overlap test for build
   * placement. The build system needs "is this 4 m cell clear" dozens of times
   * a second while the preview follows the crosshair, and `query` would
   * allocate a handle per candidate to answer a yes/no question.
   */
  overlapBox(box: THREE.Box3, filter?: (opts: ColliderOpts) => boolean): boolean {
    this.tick++;
    const tick = this.tick;
    const cx0 = Math.floor(box.min.x * INV_CELL);
    const cx1 = Math.floor(box.max.x * INV_CELL);
    const cz0 = Math.floor(box.min.z * INV_CELL);
    const cz1 = Math.floor(box.max.z * INV_CELL);

    const test = (id: number): boolean => {
      if (this.stamp[id] === tick) return false;
      this.stamp[id] = tick;
      const b = id * 6;
      if (box.max.x <= this.bounds[b] || box.min.x >= this.bounds[b + 3]) return false;
      if (box.max.y <= this.bounds[b + 1] || box.min.y >= this.bounds[b + 4]) return false;
      if (box.max.z <= this.bounds[b + 2] || box.min.z >= this.bounds[b + 5]) return false;
      if (filter && !filter(this.opts[id] ?? {})) return false;
      return true;
    };

    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const bucket = this.cells.get(cellKey(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) if (test(bucket[i])) return true;
      }
    }
    for (let i = 0; i < this.oversized.length; i++) if (test(this.oversized[i])) return true;
    return false;
  }

  /* ----------------------------------------------------------------- misc */

  /**
   * Late-bound terrain. Collision is the fourth system up and terrain is the
   * fifth, so this is null for part of boot — and systems that come later
   * still raycast during *their* factories, before any frame has run. Hence a
   * resolver rather than a value: the first query that needs the heightfield
   * finds it, and every one after that reads the cached reference. It may
   * legitimately stay null forever if terrain failed to boot, which costs the
   * ground hit and nothing else.
   */
  terrainSource: (() => TerrainService | undefined) | null = null;
  private terrainCache: TerrainService | null = null;

  private get terrain(): TerrainService | null {
    if (this.terrainCache) return this.terrainCache;
    const t = this.terrainSource?.();
    if (t) this.terrainCache = t;
    return t ?? null;
  }

  /** Copy the live bounds of the N boxes nearest a point, for the debug view. */
  collectNear(
    point: THREE.Vector3,
    radius: number,
    max: number,
    into: number[],
  ): number {
    into.length = 0;
    this.tick++;
    const tick = this.tick;
    const c = Math.ceil(radius * INV_CELL);
    const ccx = Math.floor(point.x * INV_CELL);
    const ccz = Math.floor(point.z * INV_CELL);
    let n = 0;
    for (let cz = ccz - c; cz <= ccz + c && n < max; cz++) {
      for (let cx = ccx - c; cx <= ccx + c && n < max; cx++) {
        const bucket = this.cells.get(cellKey(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length && n < max; i++) {
          const id = bucket[i];
          if (this.stamp[id] === tick) continue;
          this.stamp[id] = tick;
          into.push(id);
          n++;
        }
      }
    }
    return n;
  }

  boundsOf(id: number, out: THREE.Box3): void {
    const b = id * 6;
    out.min.set(this.bounds[b], this.bounds[b + 1], this.bounds[b + 2]);
    out.max.set(this.bounds[b + 3], this.bounds[b + 4], this.bounds[b + 5]);
  }

  optsOf(id: number): ColliderOpts | undefined {
    return this.opts[id];
  }

  clear(): void {
    this.terrainCache = null;
    this.cells.clear();
    this.oversized.length = 0;
    this.free.length = 0;
    this.opts.length = 0;
    this.nextSlot = 0;
    this.live = 0;
    this.state.fill(0);
  }
}

/* ------------------------------------------------------------------------ *
 * Debug wireframe
 * ------------------------------------------------------------------------ */

/** The 12 edges of a unit box, as pairs of corner indices. */
const BOX_EDGES = [
  0, 1, 1, 3, 3, 2, 2, 0, // bottom
  4, 5, 5, 7, 7, 6, 6, 4, // top
  0, 4, 1, 5, 2, 6, 3, 7, // uprights
];

/**
 * Dev-only overlay: draws every collider near the camera as coloured box
 * edges. One draw call, built into a pre-sized buffer, and completely absent
 * from the scene graph until someone asks for it — a debug view that costs a
 * draw call while switched off is a debug view that gets left in the frame.
 */
class DebugView {
  readonly object: THREE.LineSegments;
  private geometry: THREE.BufferGeometry;
  private material: THREE.LineBasicMaterial;
  private positions: Float32Array;
  private colors: Float32Array;
  private ids: number[] = [];
  private box = new THREE.Box3();
  private timer = 0;

  constructor(private bp: Broadphase) {
    const verts = DEBUG_MAX_BOXES * 24;
    this.positions = new Float32Array(verts * 3);
    this.colors = new Float32Array(verts * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setDrawRange(0, 0);
    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthTest: true,
      // Tone mapping would mute these into the scene; a debug line wants to be
      // unmistakably not part of the world.
      toneMapped: false,
    });
    this.object = new THREE.LineSegments(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 999;
    this.object.name = "collision-debug";
  }

  update(dt: number, camera: THREE.Camera): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1 / DEBUG_REBUILD_HZ;

    const n = this.bp.collectNear(camera.position, DEBUG_RADIUS, DEBUG_MAX_BOXES, this.ids);
    let v = 0;
    for (let i = 0; i < n; i++) {
      const id = this.ids[i];
      this.bp.boundsOf(id, this.box);
      const o = this.bp.optsOf(id);
      // Built pieces cyan, harvestables amber, everything static magenta —
      // enough to tell at a glance whether a wall you cannot shoot through is
      // a piece that failed to unregister.
      const r = o?.built ? 0.25 : o?.harvest ? 1.0 : 1.0;
      const g = o?.built ? 1.0 : o?.harvest ? 0.7 : 0.25;
      const b = o?.built ? 1.0 : o?.harvest ? 0.15 : 0.9;

      const x0 = this.box.min.x;
      const y0 = this.box.min.y;
      const z0 = this.box.min.z;
      const x1 = this.box.max.x;
      const y1 = this.box.max.y;
      const z1 = this.box.max.z;
      for (let e = 0; e < BOX_EDGES.length; e++) {
        const c = BOX_EDGES[e];
        const p = v * 3;
        this.positions[p] = c & 1 ? x1 : x0;
        this.positions[p + 1] = c & 4 ? y1 : y0;
        this.positions[p + 2] = c & 2 ? z1 : z0;
        this.colors[p] = r;
        this.colors[p + 1] = g;
        this.colors[p + 2] = b;
        v++;
      }
    }
    (this.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.setDrawRange(0, v);
  }

  dispose(): void {
    this.object.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ------------------------------------------------------------------------ *
 * System
 * ------------------------------------------------------------------------ */

/** Extras this system offers beyond the shared `CollisionService` contract. */
export interface CollisionSystemService extends CollisionService {
  /** Live collider count — the HUD's debug readout and the perf overlay use it. */
  readonly count: number;
  /** Allocation-free yes/no overlap test, for build placement validation. */
  overlapBox(box: THREE.Box3, filter?: (opts: ColliderOpts) => boolean): boolean;
}

const createCollision: SystemFactory = (ctx) => {
  const bp = new Broadphase();

  /**
   * Published first, before anything else in this factory runs. Collision is
   * the fourth system to boot and half the world registers colliders during
   * its own factory — if the service appeared any later, terrain, the POIs and
   * the props would all quietly build a world you can walk straight through.
   */
  ctx.services.collision = bp as CollisionSystemService;

  // Lazy, null-checked, and re-evaluated until it succeeds — the boot order in
  // boot.ts is a promise about sequence, not about anything actually working.
  bp.terrainSource = () => ctx.services.terrain;

  let debug: DebugView | null = null;

  const offDebug = ctx.on("dz:debug-collision", (payload) => {
    const want = typeof payload === "boolean" ? payload : !debug;
    if (want === !!debug) return;
    if (want) {
      debug = new DebugView(bp);
      ctx.scene.add(debug.object);
    } else {
      debug?.dispose();
      debug = null;
    }
    ctx.emit("dz:hud", { toast: `Collision debug ${want ? "on" : "off"} · ${bp.count} boxes` });
  });

  const sys: System = {
    name: "collision",

    update(dt) {
      // Nothing to simulate — the broadphase is passive. The only per-frame
      // cost this system carries at all is the debug overlay, and only while
      // someone has it switched on.
      if (debug) debug.update(dt, ctx.camera);
    },

    dispose() {
      offDebug();
      debug?.dispose();
      debug = null;
      bp.clear();
      bp.terrainSource = null;
      if (ctx.services.collision === (bp as CollisionSystemService)) {
        ctx.services.collision = undefined;
      }
    },
  };

  return sys;
};

export default createCollision;
