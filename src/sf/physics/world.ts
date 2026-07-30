/**
 * world.ts — the Rapier singleton for San Francisco: FREE FALL.
 *
 * Everything physical in the game talks to exactly one `PhysicsWorld`. It owns
 * the Rapier `World`, the fixed-timestep accumulator, the collision filter
 * vocabulary, the event plumbing and the handle→gameplay-object registry.
 *
 * Three decisions worth explaining, because they shape every other file here:
 *
 * 1. **Rapier is loaded lazily, via `await import()`.**
 *    rapier3d-compat inlines a ~1.4 MB base64 WASM blob into its ES module.
 *    A static import would put that on the critical path of the very first
 *    paint, before the player has even seen the sky. So the namespace lives in
 *    a module-local `R` that is `null` until `initPhysics()` resolves, and
 *    *every* public entry point in this directory is written to no-op when it
 *    is null. Calling `raycast()` on frame 1 returns "nothing hit"; it does not
 *    throw. That is the contract the task demands and it is also just how you
 *    ship a streaming world.
 *
 * 2. **Fixed 60 Hz simulation with render interpolation.**
 *    A variable timestep makes suspension springs, ragdolls and stacked debris
 *    behave differently on a 144 Hz monitor than on a 30 fps laptop, which is
 *    unshippable. We accumulate real time, run whole 1/60 s steps, and expose
 *    `alpha` so renderers can lerp between the last two poses. Bodies that opt
 *    into interpolation get a 7-float prev/curr pair maintained here.
 *
 * 3. **Interaction groups are a *vocabulary*, not ad-hoc numbers.**
 *    Rapier's `InteractionGroups` is a packed u32: membership in the high 16
 *    bits, filter mask in the low 16. Getting that backwards is the single
 *    most common Rapier bug, and it fails silently — things just fall through
 *    the world. So nobody in this codebase writes the packing by hand; they
 *    pick a preset from `FILTER` or call `interactionGroups()`.
 *
 * Public API
 * ----------
 *   initPhysics() / whenPhysicsReady() / isPhysicsReady() / rapier()
 *   physics                      the singleton PhysicsWorld
 *   GROUP, FILTER, interactionGroups(), QUERY_STATIC, QUERY_ALL
 *   registerObject / unregisterObject / objectForCollider / objectForBody
 *   PhysicsObject, PhysicsKind, SurfaceTag
 *   onCollision / onContactForce / onFixedStep
 *   sampleTransform()            interpolated pose for rendering
 *   disposePhysics()
 */
import type * as RAPIER from "@dimforge/rapier3d-compat";
import { clamp01 } from "../math/rng";

export type RapierNS = typeof RAPIER;

/* ------------------------------------------------------------------ *
 * Lazy WASM boot
 * ------------------------------------------------------------------ */

let R: RapierNS | null = null;
let bootPromise: Promise<RapierNS | null> | null = null;
let bootFailed = false;

/**
 * The Rapier namespace, or null if the engine has not finished booting.
 *
 * Call sites are expected to early-out on null rather than assert. There is no
 * frame of gameplay in which "physics is not up yet" should be fatal.
 */
export function rapier(): RapierNS | null {
  return R;
}

export function isPhysicsReady(): boolean {
  return R !== null && physics.world !== null;
}

/**
 * Boot Rapier and build the world. Idempotent — concurrent callers share the
 * same promise, and a second call after success resolves immediately.
 */
export function initPhysics(): Promise<RapierNS | null> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    try {
      const mod = await import("@dimforge/rapier3d-compat");
      await mod.init();
      R = mod as unknown as RapierNS;
      physics.build(R);
      return R;
    } catch (err) {
      // A failed WASM boot must degrade to "no physics", not a white screen:
      // the city still renders, the player still flies, nothing collides.
      bootFailed = true;
      // eslint-disable-next-line no-console
      console.error("[sf/physics] Rapier failed to initialise; running without physics.", err);
      return null;
    }
  })();
  return bootPromise;
}

/** Resolves when physics is usable (or immediately if it failed — check `isPhysicsReady`). */
export function whenPhysicsReady(): Promise<RapierNS | null> {
  return initPhysics();
}

export function physicsBootFailed(): boolean {
  return bootFailed;
}

/* ------------------------------------------------------------------ *
 * Collision filtering vocabulary
 * ------------------------------------------------------------------ */

/**
 * Membership bits. Sixteen available; eleven used, five kept spare so a later
 * system (rope segments, water volumes per-district) does not force a
 * renumber that silently changes every mask in the game.
 */
export const GROUP = {
  TERRAIN: 1 << 0,
  BUILDING: 1 << 1,
  PLAYER: 1 << 2,
  ENEMY: 1 << 3,
  VEHICLE: 1 << 4,
  PROP: 1 << 5,
  DEBRIS: 1 << 6,
  PROJECTILE: 1 << 7,
  WATER: 1 << 8,
  TRIGGER: 1 << 9,
  RAGDOLL: 1 << 10,
} as const;

export type GroupBit = (typeof GROUP)[keyof typeof GROUP];

/** Every solid thing — the mask most colliders want as a base. */
export const ALL_SOLID =
  GROUP.TERRAIN |
  GROUP.BUILDING |
  GROUP.PLAYER |
  GROUP.ENEMY |
  GROUP.VEHICLE |
  GROUP.PROP |
  GROUP.DEBRIS |
  GROUP.RAGDOLL;

/** The immovable city. */
export const STATIC_WORLD = GROUP.TERRAIN | GROUP.BUILDING;

/**
 * Pack membership + filter into Rapier's `InteractionGroups`.
 *
 * Two colliders interact iff each one's membership intersects the other's
 * filter. Both directions must agree — a one-sided mask is a no-op.
 */
export function interactionGroups(memberships: number, filters: number): number {
  return ((memberships & 0xffff) << 16) | (filters & 0xffff);
}

/**
 * Ready-made presets. Prefer these; hand-rolled masks drift.
 *
 * Notes on the deliberate exclusions:
 *  - Debris does not collide with the player. Ten thousand concrete chunks
 *    shoving the camera around after an explosion feels broken, not powerful.
 *  - Projectiles are sensors against water so a bullet splashes rather than
 *    ricochets, and never collide with each other.
 *  - Ragdolls ignore the player capsule so corpses cannot body-block a doorway.
 */
export const FILTER = {
  terrain: interactionGroups(GROUP.TERRAIN, ALL_SOLID | GROUP.PROJECTILE),
  building: interactionGroups(GROUP.BUILDING, ALL_SOLID | GROUP.PROJECTILE),
  player: interactionGroups(
    GROUP.PLAYER,
    GROUP.TERRAIN | GROUP.BUILDING | GROUP.VEHICLE | GROUP.PROP | GROUP.ENEMY | GROUP.TRIGGER,
  ),
  enemy: interactionGroups(
    GROUP.ENEMY,
    GROUP.TERRAIN | GROUP.BUILDING | GROUP.VEHICLE | GROUP.PROP | GROUP.PLAYER | GROUP.PROJECTILE | GROUP.TRIGGER,
  ),
  vehicle: interactionGroups(
    GROUP.VEHICLE,
    ALL_SOLID | GROUP.PROJECTILE | GROUP.TRIGGER,
  ),
  prop: interactionGroups(GROUP.PROP, ALL_SOLID | GROUP.PROJECTILE),
  debris: interactionGroups(
    GROUP.DEBRIS,
    GROUP.TERRAIN | GROUP.BUILDING | GROUP.VEHICLE | GROUP.PROP | GROUP.DEBRIS,
  ),
  projectile: interactionGroups(
    GROUP.PROJECTILE,
    GROUP.TERRAIN | GROUP.BUILDING | GROUP.VEHICLE | GROUP.PROP | GROUP.ENEMY | GROUP.RAGDOLL | GROUP.WATER,
  ),
  water: interactionGroups(GROUP.WATER, GROUP.VEHICLE | GROUP.PLAYER | GROUP.PROJECTILE | GROUP.DEBRIS),
  trigger: interactionGroups(GROUP.TRIGGER, GROUP.PLAYER | GROUP.VEHICLE | GROUP.ENEMY),
  ragdoll: interactionGroups(
    GROUP.RAGDOLL,
    GROUP.TERRAIN | GROUP.BUILDING | GROUP.VEHICLE | GROUP.PROP | GROUP.DEBRIS | GROUP.PROJECTILE,
  ),
} as const;

/** Query mask that sees only the immovable city — used for line-of-sight. */
export const QUERY_STATIC = interactionGroups(0xffff, STATIC_WORLD);
/** Query mask that sees everything solid. */
export const QUERY_ALL = interactionGroups(0xffff, ALL_SOLID);

/* ------------------------------------------------------------------ *
 * Surfaces
 * ------------------------------------------------------------------ */

/**
 * What a bullet, footstep or tyre found. Weapons pick impact decals, particle
 * colours and audio banks straight off this tag, so it lives here next to the
 * registry rather than inside any one consumer.
 */
export type SurfaceTag =
  | "concrete"
  | "asphalt"
  | "metal"
  | "thinMetal"
  | "glass"
  | "wood"
  | "brick"
  | "stucco"
  | "stone"
  | "dirt"
  | "grass"
  | "sand"
  | "gravel"
  | "water"
  | "flesh"
  | "foliage"
  | "plastic"
  | "rubber"
  | "fabric";

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

export type PhysicsKind =
  | "player"
  | "enemy"
  | "vehicle"
  | "prop"
  | "debris"
  | "terrain"
  | "building"
  | "projectile"
  | "water"
  | "trigger"
  | "ragdoll";

/**
 * The bridge between a Rapier handle and whatever gameplay thing it *is*.
 *
 * Rapier gives you integers. Weapons, AI, the damage model and the VFX system
 * all need to go from "collider 4711" to "the second door of the police
 * cruiser you just shot", in one map lookup, with no allocation.
 */
export interface PhysicsObject {
  /** Stable id, unique for the lifetime of the process. */
  id: number;
  kind: PhysicsKind;
  /** Null for parentless colliders (static chunk colliders share one body). */
  body: RAPIER.RigidBody | null;
  colliders: RAPIER.Collider[];
  /** Default surface for anything that hits this object. */
  surface: SurfaceTag;
  /** Whatever the owning subsystem wants back: an entity, an index, a record. */
  ref: unknown;
  /** Destructible id in `destruction.ts`, or -1. */
  destructibleId: number;
  /** Maintain prev/curr transforms so renderers can interpolate. */
  interpolate: boolean;
  /** [x,y,z,qx,qy,qz,qw] at the start of the last completed substep. */
  prev: Float32Array | null;
  /** [x,y,z,qx,qy,qz,qw] after the last completed substep. */
  curr: Float32Array | null;
  /** Simulation time this object was last touched — LRU recycling reads it. */
  touched: number;
}

let nextObjectId = 1;

const byId = new Map<number, PhysicsObject>();
const byBody = new Map<number, PhysicsObject>();
const byCollider = new Map<number, PhysicsObject>();
/** Objects with `interpolate` set, kept as a dense array for the capture loop. */
const interpolated: PhysicsObject[] = [];

export interface RegisterOptions {
  kind: PhysicsKind;
  body?: RAPIER.RigidBody | null;
  colliders?: RAPIER.Collider[];
  surface?: SurfaceTag;
  ref?: unknown;
  destructibleId?: number;
  interpolate?: boolean;
}

/** Register a body/collider set so queries can resolve it back to gameplay. */
export function registerObject(opts: RegisterOptions): PhysicsObject {
  const obj: PhysicsObject = {
    id: nextObjectId++,
    kind: opts.kind,
    body: opts.body ?? null,
    colliders: opts.colliders ? opts.colliders.slice() : [],
    surface: opts.surface ?? "concrete",
    ref: opts.ref ?? null,
    destructibleId: opts.destructibleId ?? -1,
    interpolate: !!opts.interpolate,
    prev: null,
    curr: null,
    touched: physics.simTime,
  };
  byId.set(obj.id, obj);
  if (obj.body) byBody.set(obj.body.handle, obj);
  for (const c of obj.colliders) byCollider.set(c.handle, obj);
  if (obj.interpolate && obj.body) {
    obj.prev = new Float32Array(7);
    obj.curr = new Float32Array(7);
    readPose(obj.body, obj.curr);
    obj.prev.set(obj.curr);
    interpolated.push(obj);
  }
  return obj;
}

/** Attach another collider to an already-registered object. */
export function attachCollider(obj: PhysicsObject, collider: RAPIER.Collider): void {
  obj.colliders.push(collider);
  byCollider.set(collider.handle, obj);
}

/** Drop an object from the registry. Does *not* remove its Rapier bodies. */
export function unregisterObject(obj: PhysicsObject | null | undefined): void {
  if (!obj) return;
  byId.delete(obj.id);
  if (obj.body) byBody.delete(obj.body.handle);
  for (const c of obj.colliders) byCollider.delete(c.handle);
  if (obj.interpolate) {
    const i = interpolated.indexOf(obj);
    if (i >= 0) {
      interpolated[i] = interpolated[interpolated.length - 1];
      interpolated.pop();
    }
  }
}

export function objectForCollider(c: RAPIER.Collider | null | undefined): PhysicsObject | null {
  if (!c) return null;
  return byCollider.get(c.handle) ?? null;
}

export function objectForColliderHandle(h: number): PhysicsObject | null {
  return byCollider.get(h) ?? null;
}

export function objectForBody(b: RAPIER.RigidBody | null | undefined): PhysicsObject | null {
  if (!b) return null;
  return byBody.get(b.handle) ?? null;
}

export function objectById(id: number): PhysicsObject | null {
  return byId.get(id) ?? null;
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export interface CollisionEvent {
  /** Gameplay object for collider A, if registered. */
  a: PhysicsObject | null;
  b: PhysicsObject | null;
  colliderA: RAPIER.Collider | null;
  colliderB: RAPIER.Collider | null;
  /** True on begin, false on end. */
  started: boolean;
  /** True when either collider is a sensor — the "trigger volume" case. */
  sensor: boolean;
}

export interface ContactForceEvent {
  a: PhysicsObject | null;
  b: PhysicsObject | null;
  colliderA: RAPIER.Collider | null;
  colliderB: RAPIER.Collider | null;
  /** Sum of contact force magnitudes, newtons. */
  totalMagnitude: number;
  maxMagnitude: number;
  /** Unit direction of the strongest contact force. */
  dirX: number;
  dirY: number;
  dirZ: number;
}

type CollisionHandler = (e: CollisionEvent) => void;
type ContactForceHandler = (e: ContactForceEvent) => void;
type FixedStepHandler = (dt: number) => void;

const collisionHandlers: CollisionHandler[] = [];
const contactForceHandlers: ContactForceHandler[] = [];
const fixedStepHandlers: FixedStepHandler[] = [];

/** Scratch events — handlers must not retain them past the callback. */
const _collisionEvent: CollisionEvent = {
  a: null, b: null, colliderA: null, colliderB: null, started: false, sensor: false,
};
const _forceEvent: ContactForceEvent = {
  a: null, b: null, colliderA: null, colliderB: null,
  totalMagnitude: 0, maxMagnitude: 0, dirX: 0, dirY: 1, dirZ: 0,
};

function detach<T>(list: T[], fn: T): () => void {
  return () => {
    const i = list.indexOf(fn);
    if (i >= 0) {
      list[i] = list[list.length - 1];
      list.pop();
    }
  };
}

/** Subscribe to begin/end collision and sensor events. Returns an unsubscriber. */
export function onCollision(fn: CollisionHandler): () => void {
  collisionHandlers.push(fn);
  return detach(collisionHandlers, fn);
}

/** Subscribe to contact-force events (impact damage, crash audio, dents). */
export function onContactForce(fn: ContactForceHandler): () => void {
  contactForceHandlers.push(fn);
  return detach(contactForceHandlers, fn);
}

/**
 * Run a callback inside the fixed timestep, after each `world.step()`.
 *
 * Anything that applies forces — vehicles, buoyancy, ragdoll joint limits,
 * helicopter aero — must live here, not in `useFrame`, or the forces get
 * applied a variable number of times per simulated second.
 */
export function onFixedStep(fn: FixedStepHandler): () => void {
  fixedStepHandlers.push(fn);
  return detach(fixedStepHandlers, fn);
}

/* ------------------------------------------------------------------ *
 * Pose helpers
 * ------------------------------------------------------------------ */

function readPose(body: RAPIER.RigidBody, out: Float32Array): void {
  const t = body.translation();
  const r = body.rotation();
  out[0] = t.x;
  out[1] = t.y;
  out[2] = t.z;
  out[3] = r.x;
  out[4] = r.y;
  out[5] = r.z;
  out[6] = r.w;
}

/**
 * Interpolated pose for rendering: `out` receives [x,y,z,qx,qy,qz,qw] sampled
 * between the last two simulation states at the world's current `alpha`.
 *
 * Quaternions are nlerp'd with a hemisphere fix. Slerp would be more correct
 * and is not worth the acos per body per frame at this rotation rate.
 */
export function sampleTransform(obj: PhysicsObject, out: Float32Array): boolean {
  if (!obj) return false;
  if (!obj.prev || !obj.curr) {
    if (!obj.body) return false;
    readPose(obj.body, out);
    return true;
  }
  const a = physics.alpha;
  const p = obj.prev;
  const c = obj.curr;
  out[0] = p[0] + (c[0] - p[0]) * a;
  out[1] = p[1] + (c[1] - p[1]) * a;
  out[2] = p[2] + (c[2] - p[2]) * a;

  let dot = p[3] * c[3] + p[4] * c[4] + p[5] * c[5] + p[6] * c[6];
  const s = dot < 0 ? -1 : 1;
  let qx = p[3] + (c[3] * s - p[3]) * a;
  let qy = p[4] + (c[4] * s - p[4]) * a;
  let qz = p[5] + (c[5] * s - p[5]) * a;
  let qw = p[6] + (c[6] * s - p[6]) * a;
  const len = Math.hypot(qx, qy, qz, qw) || 1;
  out[3] = qx / len;
  out[4] = qy / len;
  out[5] = qz / len;
  out[6] = qw / len;
  return true;
}

/* ------------------------------------------------------------------ *
 * The world
 * ------------------------------------------------------------------ */

/** Simulation rate. Everything in this directory assumes it. */
export const FIXED_DT = 1 / 60;
/**
 * Hard cap on catch-up substeps. Past this we drop the backlog rather than
 * chase it: a 400 ms hitch (tab restore, shader compile) must not turn into a
 * 24-step spiral that produces another 400 ms hitch.
 */
const MAX_SUBSTEPS = 4;

export interface PhysicsStats {
  bodies: number;
  colliders: number;
  /** Substeps executed on the last `step()` call. */
  substeps: number;
  /** Wall-clock ms spent inside Rapier on the last frame. */
  stepMs: number;
  /** Registered gameplay objects. */
  objects: number;
}

class PhysicsWorld {
  world: RAPIER.World | null = null;
  events: RAPIER.EventQueue | null = null;

  /** Leftover real time not yet simulated, seconds. */
  accumulator = 0;
  /** Render interpolation factor, 0..1, between `prev` and `curr`. */
  alpha = 0;
  /** Total simulated seconds. */
  simTime = 0;
  /** Completed substeps since boot — a cheap determinism checksum. */
  stepCount = 0;
  /** Set true by the pause menu / photo mode. */
  paused = false;

  readonly stats: PhysicsStats = {
    bodies: 0,
    colliders: 0,
    substeps: 0,
    stepMs: 0,
    objects: 0,
  };

  /** Called once by `initPhysics`. */
  build(r: RapierNS): void {
    if (this.world) return;
    // Real gravity here, not PLAYER.gravity: the punchy -22.5 is a *character*
    // feel number. Cars, debris and helicopters must fall at 9.81 or every
    // suspension, mass and drag constant below becomes meaningless.
    this.world = new r.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_DT;
    // Four velocity iterations is Rapier's default; long vehicle/ragdoll joint
    // chains want a little more before they visibly stretch under load.
    this.world.numSolverIterations = 6;
    this.events = new r.EventQueue(true);
  }

  /**
   * Advance the simulation by `dtRaw` seconds of real time.
   * Returns the number of substeps actually executed (0 before boot/paused).
   */
  step(dtRaw: number): number {
    const w = this.world;
    if (!w || this.paused) return 0;

    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    // Clamp before accumulating: a hidden tab hands you dt in whole seconds.
    this.accumulator += Math.min(Math.max(dtRaw, 0), 0.25);

    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      for (let i = 0; i < interpolated.length; i++) {
        const o = interpolated[i];
        if (o.prev && o.curr) o.prev.set(o.curr);
      }

      w.step(this.events ?? undefined);
      this.accumulator -= FIXED_DT;
      this.simTime += FIXED_DT;
      this.stepCount++;
      steps++;

      this.drainEvents();

      for (let i = 0; i < fixedStepHandlers.length; i++) fixedStepHandlers[i](FIXED_DT);

      for (let i = 0; i < interpolated.length; i++) {
        const o = interpolated[i];
        if (o.body && o.curr) readPose(o.body, o.curr);
      }
    }

    if (steps === MAX_SUBSTEPS && this.accumulator > FIXED_DT) {
      // Deliberately drop the rest. Better one skipped instant than a stall.
      this.accumulator = 0;
    }

    this.alpha = clamp01(this.accumulator / FIXED_DT);

    const s = this.stats;
    s.substeps = steps;
    s.stepMs = typeof performance !== "undefined" ? performance.now() - t0 : 0;
    s.bodies = w.bodies.len();
    s.colliders = w.colliders.len();
    s.objects = byId.size;
    return steps;
  }

  private drainEvents(): void {
    const w = this.world;
    const q = this.events;
    if (!w || !q) return;

    if (collisionHandlers.length > 0) {
      q.drainCollisionEvents((h1, h2, started) => {
        const c1 = w.colliders.get(h1);
        const c2 = w.colliders.get(h2);
        const e = _collisionEvent;
        e.colliderA = c1;
        e.colliderB = c2;
        e.a = byCollider.get(h1) ?? null;
        e.b = byCollider.get(h2) ?? null;
        e.started = started;
        e.sensor = !!(c1 && c1.isSensor()) || !!(c2 && c2.isSensor());
        for (let i = 0; i < collisionHandlers.length; i++) collisionHandlers[i](e);
      });
    } else {
      // Still drain, or the queue grows without bound.
      q.drainCollisionEvents(() => {});
    }

    if (contactForceHandlers.length > 0) {
      q.drainContactForceEvents((ev) => {
        const h1 = ev.collider1();
        const h2 = ev.collider2();
        const dir = ev.maxForceDirection();
        const e = _forceEvent;
        e.colliderA = w.colliders.get(h1);
        e.colliderB = w.colliders.get(h2);
        e.a = byCollider.get(h1) ?? null;
        e.b = byCollider.get(h2) ?? null;
        e.totalMagnitude = ev.totalForceMagnitude();
        e.maxMagnitude = ev.maxForceMagnitude();
        e.dirX = dir.x;
        e.dirY = dir.y;
        e.dirZ = dir.z;
        for (let i = 0; i < contactForceHandlers.length; i++) contactForceHandlers[i](e);
      });
    } else {
      q.drainContactForceEvents(() => {});
    }
  }

  /** Tear everything down (hot reload, leaving /sf). */
  dispose(): void {
    byId.clear();
    byBody.clear();
    byCollider.clear();
    interpolated.length = 0;
    collisionHandlers.length = 0;
    contactForceHandlers.length = 0;
    fixedStepHandlers.length = 0;
    if (this.events) {
      this.events.free();
      this.events = null;
    }
    if (this.world) {
      this.world.free();
      this.world = null;
    }
    this.accumulator = 0;
    this.alpha = 0;
  }
}

/** The singleton. */
export const physics = new PhysicsWorld();

/**
 * Full teardown, including the loader state, so a subsequent `initPhysics()`
 * rebuilds cleanly. The WASM module itself stays resident — re-`init()`ing it
 * is neither necessary nor cheap.
 */
export function disposePhysics(): void {
  physics.dispose();
  bootPromise = R ? Promise.resolve(R) : null;
  if (R) {
    // Rebuild an empty world so callers that survive the teardown keep working.
    physics.build(R);
  }
}

/* ------------------------------------------------------------------ *
 * Small construction helpers used across this directory
 * ------------------------------------------------------------------ */

/** Create a fixed (static) body at a position. Null before boot. */
export function createFixedBody(x: number, y: number, z: number): RAPIER.RigidBody | null {
  const r = R;
  const w = physics.world;
  if (!r || !w) return null;
  return w.createRigidBody(r.RigidBodyDesc.fixed().setTranslation(x, y, z));
}

/** Create a dynamic body. `ccd` should be true only for genuinely fast things. */
export function createDynamicBody(
  x: number,
  y: number,
  z: number,
  opts?: { linearDamping?: number; angularDamping?: number; ccd?: boolean; canSleep?: boolean; gravityScale?: number },
): RAPIER.RigidBody | null {
  const r = R;
  const w = physics.world;
  if (!r || !w) return null;
  const desc = r.RigidBodyDesc.dynamic()
    .setTranslation(x, y, z)
    .setLinearDamping(opts?.linearDamping ?? 0.05)
    .setAngularDamping(opts?.angularDamping ?? 0.35)
    .setCanSleep(opts?.canSleep ?? true)
    .setGravityScale(opts?.gravityScale ?? 1)
    .setCcdEnabled(!!opts?.ccd);
  return w.createRigidBody(desc);
}

/** Remove a body (and implicitly its colliders) plus its registry entry. */
export function destroyObject(obj: PhysicsObject | null): void {
  if (!obj) return;
  const w = physics.world;
  if (w) {
    if (obj.body) {
      w.removeRigidBody(obj.body);
    } else {
      for (const c of obj.colliders) {
        try {
          w.removeCollider(c, false);
        } catch {
          /* already gone */
        }
      }
    }
  }
  unregisterObject(obj);
}

/** Yaw-only quaternion, allocation-free into `out` = [x,y,z,w]. */
export function quatFromYaw(yaw: number, out: Float32Array): Float32Array {
  const h = yaw * 0.5;
  out[0] = 0;
  out[1] = Math.sin(h);
  out[2] = 0;
  out[3] = Math.cos(h);
  return out;
}
