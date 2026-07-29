/**
 * rigidBodies.ts — the dynamic-body budget.
 *
 * In a Just Cause firefight you will, over ten minutes, ask for tens of
 * thousands of dynamic bodies: every shattered window, every bollard you
 * clipped, every wheel that came off, every ragdoll limb. You cannot have
 * them. `QUALITY[tier].maxRigidBodies` is 60 on low and 420 on ultra, and the
 * moment you exceed it the solver cost goes superlinear and the frame dies.
 *
 * So this is a **pool with a hard cap and LRU recycling**. Ask for a body when
 * the pool is full and you get one anyway — taken from the least interesting
 * body currently alive, which quietly vanishes. That is the property that
 * matters: a long firefight never degrades, because the cost is constant. The
 * alternative (refuse the spawn) means the twentieth explosion produces no
 * debris at all, which reads as a bug.
 *
 * "Least interesting" is scored, not just oldest:
 *   sleeping  ×4      a settled chunk of kerb is doing nothing
 *   distance  ×       something 200 m behind you will not be missed
 *   age       ×       break ties toward the oldest
 * Anything spawned in the last 0.4 s is exempt, or a single grenade could
 * recycle its own debris mid-flight.
 *
 * Bodies are *recycled*, never destroyed and recreated: creating a Rapier body
 * plus collider costs several WASM round trips and an allocation in the
 * collider set, and doing that 200 times in one frame after an explosion is a
 * visible hitch. Instead a retired entry keeps its body, gets disabled, and on
 * the next spawn has its collider's shape swapped in place.
 *
 * Public API
 * ----------
 *   rigidBodyPool.spawn(desc) → handle (0 when refused before boot)
 *   rigidBodyPool.despawn(h) / isAlive(h) / bodyOf(h) / objectOf(h)
 *   rigidBodyPool.applyImpulse / applyImpulseAt / applyTorqueImpulse
 *   rigidBodyPool.update(dt, camX, camY, camZ)
 *   rigidBodyPool.sample(h, out7)   interpolated pose for rendering
 *   rigidBodyPool.forEachAlive(cb)
 */
import type * as RAPIER from "@dimforge/rapier3d-compat";
import { QUALITY, type QualityTier } from "../config";
import {
  FILTER,
  physics,
  rapier,
  registerObject,
  sampleTransform,
  unregisterObject,
  type PhysicsObject,
  type SurfaceTag,
} from "./world";

/* ------------------------------------------------------------------ *
 * Descriptors
 * ------------------------------------------------------------------ */

export type BodyShapeKind = "box" | "sphere" | "capsule" | "cylinder" | "convex";

export interface SpawnBodyDesc {
  shape: BodyShapeKind;
  /** box: half extents. cylinder/capsule: (hy = half height). */
  hx?: number;
  hy?: number;
  hz?: number;
  /** sphere/capsule/cylinder radius. */
  radius?: number;
  /** convex: packed xyz point cloud. Retained only for the build call. */
  points?: Float32Array;

  x: number;
  y: number;
  z: number;
  qx?: number;
  qy?: number;
  qz?: number;
  qw?: number;

  vx?: number;
  vy?: number;
  vz?: number;
  avx?: number;
  avy?: number;
  avz?: number;

  /** kg/m³. Concrete 2400, steel 7800, wood 600, glass 2500. */
  density?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  angularDamping?: number;
  gravityScale?: number;
  /** Continuous collision — only for genuinely fast, small things. */
  ccd?: boolean;

  /** Seconds before automatic despawn. <= 0 means "until recycled". */
  lifetime?: number;
  /** Collision groups; defaults to FILTER.debris. */
  groups?: number;
  kind?: "debris" | "prop" | "vehicle" | "ragdoll";
  surface?: SurfaceTag;
  ref?: unknown;
  /** Emit contact-force events (impact audio, damage). Costs a little. */
  reportContacts?: boolean;
  /** Keep prev/curr poses so the renderer can interpolate. Default true. */
  interpolate?: boolean;
  /**
   * Priority 0..3. Higher survives recycling longer. Use 3 for anything
   * gameplay-critical that happens to be pooled (a mission crate).
   */
  priority?: number;
}

/**
 * An opaque, generation-tagged handle. Holding a stale handle is safe: every
 * accessor validates the generation and returns null once the slot is reused.
 */
export type BodyHandle = number;

const SLOT_BITS = 20;
const SLOT_MASK = (1 << SLOT_BITS) - 1;

function makeHandle(slot: number, gen: number): BodyHandle {
  return ((gen & 0x7ff) << SLOT_BITS) | (slot & SLOT_MASK);
}
function handleSlot(h: BodyHandle): number {
  return h & SLOT_MASK;
}
function handleGen(h: BodyHandle): number {
  return (h >>> SLOT_BITS) & 0x7ff;
}

/* ------------------------------------------------------------------ *
 * Pool entries
 * ------------------------------------------------------------------ */

interface Entry {
  slot: number;
  gen: number;
  alive: boolean;
  body: RAPIER.RigidBody | null;
  collider: RAPIER.Collider | null;
  obj: PhysicsObject | null;
  /** Sim time of the spawn. */
  born: number;
  /** Sim time this body last had meaningful velocity. */
  lastMoved: number;
  lifetime: number;
  priority: number;
  shape: BodyShapeKind;
  ref: unknown;
}

/* ------------------------------------------------------------------ *
 * Scratch
 * ------------------------------------------------------------------ */

const _v = { x: 0, y: 0, z: 0 };
const _v2 = { x: 0, y: 0, z: 0 };
const _q = { x: 0, y: 0, z: 0, w: 1 };
const _pose = new Float32Array(7);

/** How far behind the camera a sleeping body is worth keeping, metres. */
const CULL_DISTANCE = 420;
/** Bodies newer than this cannot be recycled. */
const RECYCLE_GRACE = 0.4;
/** Below this speed a body counts as "not moving" for the LRU score. */
const STILL_SPEED = 0.35;

/* ------------------------------------------------------------------ *
 * The pool
 * ------------------------------------------------------------------ */

class RigidBodyPool {
  private entries: Entry[] = [];
  private free: number[] = [];
  private aliveList: Entry[] = [];

  /** Hard cap, refreshed from the quality tier. */
  cap = QUALITY.high.maxRigidBodies;

  readonly stats = {
    alive: 0,
    pooled: 0,
    spawned: 0,
    recycled: 0,
    expired: 0,
    culled: 0,
  };

  /** Point the cull/LRU distance term at the camera. Updated by `update()`. */
  private camX = 0;
  private camY = 0;
  private camZ = 0;

  setQuality(tier: QualityTier): void {
    this.cap = QUALITY[tier].maxRigidBodies;
    // Shrinking the cap mid-game must take effect immediately, or dropping to
    // Low during a firefight does nothing until the next spawn.
    while (this.aliveList.length > this.cap) {
      const victim = this.pickVictim(true);
      if (!victim) break;
      this.retire(victim);
    }
  }

  /* ---------------- spawning ---------------- */

  /**
   * Create (or recycle) a dynamic body. Returns 0 if physics is not up.
   *
   * The returned handle is valid until the body is despawned, expires, or is
   * recycled to make room — after which every accessor returns null. Callers
   * are expected to tolerate that; nothing in a debris system should assume
   * its chunk of concrete still exists.
   */
  spawn(desc: SpawnBodyDesc): BodyHandle {
    const r = rapier();
    const w = physics.world;
    if (!r || !w) return 0;

    let entry: Entry | null = null;

    // Evict until there is room. A single eviction per spawn is not enough:
    // when the cap is lowered mid-game (quality slider, or a spike of
    // ragdolls claiming budget) the pool must converge, not hover one over.
    let guard = 0;
    while (this.aliveList.length >= this.cap && guard++ < 64) {
      const victim = this.pickVictim(false);
      if (!victim) {
        // Everything alive is inside the spawn grace window — this frame is
        // already pathological (a chained explosion). Refuse rather than
        // recycle debris that is still in the air from the same blast.
        return 0;
      }
      this.retire(victim);
      this.stats.recycled++;
    }

    const freeSlot = this.free.pop();
    if (freeSlot !== undefined) entry = this.entries[freeSlot];

    const shape = buildShape(r, desc);
    if (!shape) return 0;

    if (entry && entry.body && entry.collider && entry.body.isValid()) {
      this.reuse(entry, desc, shape);
    } else {
      // Either a brand-new slot, or a recycled one whose body was destroyed
      // out from under us (world teardown). Either way, build in place.
      entry = this.create(r, w, desc, shape, entry);
      if (!entry) return 0;
    }

    entry.alive = true;
    entry.born = physics.simTime;
    entry.lastMoved = physics.simTime;
    entry.lifetime = desc.lifetime ?? -1;
    entry.priority = desc.priority ?? 0;
    entry.shape = desc.shape;
    entry.ref = desc.ref ?? null;
    this.aliveList.push(entry);
    this.stats.spawned++;
    this.stats.alive = this.aliveList.length;
    return makeHandle(entry.slot, entry.gen);
  }

  private create(
    r: NonNullable<ReturnType<typeof rapier>>,
    w: RAPIER.World,
    desc: SpawnBodyDesc,
    shape: RAPIER.Shape,
    existing?: Entry | null,
  ): Entry | null {
    const slot = existing ? existing.slot : this.entries.length;
    const bodyDesc = r.RigidBodyDesc.dynamic()
      .setTranslation(desc.x, desc.y, desc.z)
      .setLinearDamping(desc.linearDamping ?? 0.06)
      .setAngularDamping(desc.angularDamping ?? 0.42)
      .setGravityScale(desc.gravityScale ?? 1)
      .setCcdEnabled(!!desc.ccd)
      .setCanSleep(true);
    if (desc.qw !== undefined) {
      _q.x = desc.qx ?? 0; _q.y = desc.qy ?? 0; _q.z = desc.qz ?? 0; _q.w = desc.qw;
      bodyDesc.setRotation(_q);
    }
    const body = w.createRigidBody(bodyDesc);

    const cd = new r.ColliderDesc(shape)
      .setDensity(desc.density ?? 1200)
      .setFriction(desc.friction ?? 0.72)
      .setRestitution(desc.restitution ?? 0.12)
      .setCollisionGroups(desc.groups ?? FILTER.debris);
    if (desc.reportContacts) {
      cd.setActiveEvents(r.ActiveEvents.CONTACT_FORCE_EVENTS);
      cd.setContactForceEventThreshold(600);
    }
    const collider = w.createCollider(cd, body);

    const entry: Entry = existing ?? {
      slot,
      gen: 1,
      alive: false,
      body: null,
      collider: null,
      obj: null,
      born: 0,
      lastMoved: 0,
      lifetime: -1,
      priority: 0,
      shape: desc.shape,
      ref: null,
    };
    entry.body = body;
    entry.collider = collider;
    if (!existing) this.entries.push(entry);
    this.applyVelocity(entry, desc);
    entry.obj = registerObject({
      kind: desc.kind ?? "debris",
      body,
      colliders: [collider],
      surface: desc.surface ?? "concrete",
      ref: desc.ref ?? null,
      interpolate: desc.interpolate ?? true,
    });
    this.stats.pooled = this.entries.length;
    return entry;
  }

  private reuse(entry: Entry, desc: SpawnBodyDesc, shape: RAPIER.Shape): void {
    const r = rapier();
    const body = entry.body!;
    const collider = entry.collider!;

    collider.setShape(shape);
    collider.setDensity(desc.density ?? 1200);
    collider.setFriction(desc.friction ?? 0.72);
    collider.setRestitution(desc.restitution ?? 0.12);
    collider.setCollisionGroups(desc.groups ?? FILTER.debris);
    if (r) {
      collider.setActiveEvents(
        desc.reportContacts ? r.ActiveEvents.CONTACT_FORCE_EVENTS : r.ActiveEvents.NONE,
      );
    }
    if (desc.reportContacts) collider.setContactForceEventThreshold(600);

    body.setEnabled(true);
    _v.x = desc.x; _v.y = desc.y; _v.z = desc.z;
    body.setTranslation(_v, false);
    _q.x = desc.qx ?? 0; _q.y = desc.qy ?? 0; _q.z = desc.qz ?? 0; _q.w = desc.qw ?? 1;
    body.setRotation(_q, false);
    body.setLinearDamping(desc.linearDamping ?? 0.06);
    body.setAngularDamping(desc.angularDamping ?? 0.42);
    body.setGravityScale(desc.gravityScale ?? 1, false);
    body.enableCcd(!!desc.ccd);
    // Density changed, so the cached mass properties are stale.
    body.recomputeMassPropertiesFromColliders();
    this.applyVelocity(entry, desc);
    body.wakeUp();

    // Fresh identity: anything still holding the old PhysicsObject must not
    // suddenly find itself pointing at a different chunk of masonry.
    unregisterObject(entry.obj);
    entry.obj = registerObject({
      kind: desc.kind ?? "debris",
      body,
      colliders: [collider],
      surface: desc.surface ?? "concrete",
      ref: desc.ref ?? null,
      interpolate: desc.interpolate ?? true,
    });
  }

  private applyVelocity(entry: Entry, desc: SpawnBodyDesc): void {
    const body = entry.body!;
    _v.x = desc.vx ?? 0; _v.y = desc.vy ?? 0; _v.z = desc.vz ?? 0;
    body.setLinvel(_v, true);
    _v2.x = desc.avx ?? 0; _v2.y = desc.avy ?? 0; _v2.z = desc.avz ?? 0;
    body.setAngvel(_v2, true);
  }

  /* ---------------- recycling ---------------- */

  /**
   * Score every alive body and return the least interesting one.
   * `force` ignores the spawn grace window (used when the cap shrinks).
   */
  private pickVictim(force: boolean): Entry | null {
    const now = physics.simTime;
    let best: Entry | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < this.aliveList.length; i++) {
      const e = this.aliveList[i];
      const age = now - e.born;
      if (!force && age < RECYCLE_GRACE) continue;
      const body = e.body;
      if (!body || !body.isValid()) return e;

      const t = body.translation();
      const dx = t.x - this.camX;
      const dy = t.y - this.camY;
      const dz = t.z - this.camZ;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      let score = age + dist * 0.35;
      if (body.isSleeping()) score *= 4;
      score /= 1 + e.priority * 2;
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  /** Disable a body and return its slot to the free list. */
  private retire(entry: Entry): void {
    const i = this.aliveList.indexOf(entry);
    if (i >= 0) {
      this.aliveList[i] = this.aliveList[this.aliveList.length - 1];
      this.aliveList.pop();
    }
    entry.alive = false;
    entry.gen = (entry.gen + 1) & 0x7ff;
    if (entry.gen === 0) entry.gen = 1;
    unregisterObject(entry.obj);
    entry.obj = null;
    entry.ref = null;
    if (entry.body && entry.body.isValid()) {
      _v.x = 0; _v.y = 0; _v.z = 0;
      entry.body.setLinvel(_v, false);
      entry.body.setAngvel(_v, false);
      // Park it far below the seabed as well as disabling it: a disabled body
      // is out of the broad phase, but if anything ever re-enables it by
      // accident it must not do so in the middle of the street.
      _v.y = -4000;
      entry.body.setTranslation(_v, false);
      entry.body.setEnabled(false);
    }
    this.free.push(entry.slot);
    this.stats.alive = this.aliveList.length;
  }

  /* ---------------- accessors ---------------- */

  private entryOf(h: BodyHandle): Entry | null {
    if (!h) return null;
    const slot = handleSlot(h);
    const e = this.entries[slot];
    if (!e || !e.alive || e.gen !== handleGen(h)) return null;
    return e;
  }

  isAlive(h: BodyHandle): boolean {
    return this.entryOf(h) !== null;
  }

  bodyOf(h: BodyHandle): RAPIER.RigidBody | null {
    return this.entryOf(h)?.body ?? null;
  }

  objectOf(h: BodyHandle): PhysicsObject | null {
    return this.entryOf(h)?.obj ?? null;
  }

  refOf(h: BodyHandle): unknown {
    return this.entryOf(h)?.ref ?? null;
  }

  /** Interpolated [x,y,z,qx,qy,qz,qw]. False if the handle is dead. */
  sample(h: BodyHandle, out: Float32Array): boolean {
    const e = this.entryOf(h);
    if (!e || !e.obj) return false;
    return sampleTransform(e.obj, out);
  }

  /** Non-interpolated pose — for logic that needs the simulation truth. */
  poseNow(h: BodyHandle, out: Float32Array): boolean {
    const e = this.entryOf(h);
    if (!e || !e.body) return false;
    const t = e.body.translation();
    const q = e.body.rotation();
    out[0] = t.x; out[1] = t.y; out[2] = t.z;
    out[3] = q.x; out[4] = q.y; out[5] = q.z; out[6] = q.w;
    return true;
  }

  applyImpulse(h: BodyHandle, ix: number, iy: number, iz: number): void {
    const b = this.bodyOf(h);
    if (!b) return;
    _v.x = ix; _v.y = iy; _v.z = iz;
    b.applyImpulse(_v, true);
  }

  applyImpulseAt(h: BodyHandle, ix: number, iy: number, iz: number, px: number, py: number, pz: number): void {
    const b = this.bodyOf(h);
    if (!b) return;
    _v.x = ix; _v.y = iy; _v.z = iz;
    _v2.x = px; _v2.y = py; _v2.z = pz;
    b.applyImpulseAtPoint(_v, _v2, true);
  }

  applyTorqueImpulse(h: BodyHandle, tx: number, ty: number, tz: number): void {
    const b = this.bodyOf(h);
    if (!b) return;
    _v.x = tx; _v.y = ty; _v.z = tz;
    b.applyTorqueImpulse(_v, true);
  }

  despawn(h: BodyHandle): void {
    const e = this.entryOf(h);
    if (e) this.retire(e);
  }

  /** Iterate live bodies. `cb` receives the handle and the interpolated pose. */
  forEachAlive(cb: (handle: BodyHandle, pose: Float32Array, ref: unknown) => void): void {
    for (let i = 0; i < this.aliveList.length; i++) {
      const e = this.aliveList[i];
      if (!e.obj) continue;
      sampleTransform(e.obj, _pose);
      cb(makeHandle(e.slot, e.gen), _pose, e.ref);
    }
  }

  /* ---------------- per-frame maintenance ---------------- */

  /**
   * Expire, cull and put long-still bodies to sleep.
   *
   * Rapier sleeps bodies on its own, but only once their velocity has been
   * near zero for a while; debris that lands in a corner and keeps getting
   * nudged by neighbours can stay awake indefinitely. We additionally force
   * sleep after `stillFor` seconds under `STILL_SPEED`, which is what stops a
   * pile of a hundred shards costing solver time forever.
   */
  update(dt: number, camX: number, camY: number, camZ: number): void {
    this.camX = camX;
    this.camY = camY;
    this.camZ = camZ;
    if (!physics.world) return;

    const now = physics.simTime;
    for (let i = this.aliveList.length - 1; i >= 0; i--) {
      const e = this.aliveList[i];
      const body = e.body;
      if (!body || !body.isValid()) {
        this.retire(e);
        continue;
      }

      if (e.lifetime > 0 && now - e.born > e.lifetime) {
        this.retire(e);
        this.stats.expired++;
        continue;
      }

      const t = body.translation();

      // Anything that has left the world (blown off the map, fell through a
      // seam) is gone; there is no gameplay below -300 m.
      if (t.y < -300 || t.y > 4000) {
        this.retire(e);
        this.stats.culled++;
        continue;
      }

      const dx = t.x - camX;
      const dy = t.y - camY;
      const dz = t.z - camZ;
      const far = dx * dx + dy * dy + dz * dz > CULL_DISTANCE * CULL_DISTANCE;

      if (body.isSleeping()) {
        if (far && e.priority === 0) {
          this.retire(e);
          this.stats.culled++;
        }
        continue;
      }

      const v = body.linvel();
      const speed2 = v.x * v.x + v.y * v.y + v.z * v.z;
      if (speed2 > STILL_SPEED * STILL_SPEED) {
        e.lastMoved = now;
      } else if (now - e.lastMoved > 1.5) {
        body.sleep();
      }

      // Far *and* still is not worth simulating even if rapier disagrees.
      if (far && e.priority === 0 && now - e.lastMoved > 0.5) {
        this.retire(e);
        this.stats.culled++;
      }
    }
    this.stats.alive = this.aliveList.length;
  }

  /** Retire everything. Bodies stay pooled. */
  clearAll(): void {
    for (let i = this.aliveList.length - 1; i >= 0; i--) this.retire(this.aliveList[i]);
  }

  /** Destroy the pool entirely — call on unmount. */
  dispose(): void {
    const w = physics.world;
    this.clearAll();
    for (const e of this.entries) {
      unregisterObject(e.obj);
      if (w && e.body && e.body.isValid()) w.removeRigidBody(e.body);
      e.body = null;
      e.collider = null;
      e.obj = null;
    }
    this.entries.length = 0;
    this.free.length = 0;
    this.aliveList.length = 0;
    this.stats.alive = 0;
    this.stats.pooled = 0;
  }
}

/* ------------------------------------------------------------------ *
 * Shape construction
 * ------------------------------------------------------------------ */

function buildShape(
  r: NonNullable<ReturnType<typeof rapier>>,
  d: SpawnBodyDesc,
): RAPIER.Shape | null {
  switch (d.shape) {
    case "box":
      return new r.Cuboid(
        Math.max(d.hx ?? 0.2, 0.02),
        Math.max(d.hy ?? 0.2, 0.02),
        Math.max(d.hz ?? 0.2, 0.02),
      );
    case "sphere":
      return new r.Ball(Math.max(d.radius ?? 0.2, 0.02));
    case "capsule":
      return new r.Capsule(Math.max(d.hy ?? 0.2, 0.02), Math.max(d.radius ?? 0.2, 0.02));
    case "cylinder":
      return new r.Cylinder(Math.max(d.hy ?? 0.2, 0.02), Math.max(d.radius ?? 0.2, 0.02));
    case "convex": {
      if (!d.points || d.points.length < 12) return null;
      const desc = r.ColliderDesc.convexHull(d.points);
      // convexHull returns null for degenerate clouds (coplanar shards). Fall
      // back to a box so a bad Voronoi cell never swallows the spawn.
      if (!desc) {
        return new r.Cuboid(
          Math.max(d.hx ?? 0.2, 0.05),
          Math.max(d.hy ?? 0.2, 0.05),
          Math.max(d.hz ?? 0.2, 0.05),
        );
      }
      return desc.shape;
    }
    default:
      return null;
  }
}

export const rigidBodyPool = new RigidBodyPool();
