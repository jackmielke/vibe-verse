/**
 * weapons/ballistics.ts — where the round actually goes.
 *
 * Two solvers, one hit contract.
 *
 *  **Hitscan** for anything leaving the muzzle above ~300 m/s. At those speeds
 *  a bullet crosses the whole playable width of San Francisco in under ten
 *  frames; simulating it buys nothing a player can perceive and costs a
 *  broadphase query every step. Instead the ray is walked in one pass with
 *  penetration and ricochet handled as *segments* of the same trace, and the
 *  tracer effect is given the real muzzle velocity so the visual still lags
 *  the hit the way it should.
 *
 *  **Projectiles** for grenades, rockets, sticky mines and thrown ordnance,
 *  integrated at a fixed 120 Hz with drag and gravity, swept between substeps
 *  so nothing tunnels through a wall at 120 m/s.
 *
 * Both report through the same `WeaponHit` record, and both go through the
 * same hitbox resolution — which is where lag compensation lives. Entities are
 * never queried "where are you"; they are queried "where were you at t", with
 * `t` being the moment the trigger was pulled. In single player this mostly
 * matters for projectiles: a rocket that takes 900 ms to cross a plaza should
 * hit the truck the player led, not the truck's current position.
 *
 * Public API
 * ----------
 *   fireHitscan(def, ox,oy,oz, dx,dy,dz, ctx, onHit)
 *   spawnProjectile(def, ox,oy,oz, dx,dy,dz, ctx, extra?)
 *   updateBallistics(dt, onHit)
 *   detonateSticky(all?) / stickyCount() / forEachProjectile(cb)
 *   clearBallistics()
 *   segmentCapsule(...)      exposed for tests and for the AI's own aim checks
 */
import {
  ALL_SOLID,
  GROUP,
  SURFACE_PROPS,
  destruction,
  interactionGroups,
  makeRayHit,
  overlapSphere,
  physics,
  raycast,
  type PhysicsObject,
  type RayHit,
  type SurfaceTag,
} from "../physics";
import { isWater, terrainHeight } from "../geo/sfGeo";
import { clamp, clamp01, type Rng } from "../math/rng";
import {
  applyEntityDamage,
  emitVfx,
  hitboxProvider,
  playExplosionSound,
  playImpactSound,
} from "./bridge";
import { damageAtRange } from "./registry";
import {
  makeWeaponHit,
  type Hitbox,
  type HitPart,
  type ShotContext,
  type WeaponDef,
  type WeaponHit,
} from "./types";

/* ------------------------------------------------------------------ *
 * Query masks
 * ------------------------------------------------------------------ */

/**
 * Everything a bullet can hit *except* the shooter. Without this mask the
 * player's own capsule is the first thing in front of the muzzle and every
 * shot is a suicide.
 */
const BULLET_MASK = interactionGroups(0xffff, ALL_SOLID & ~GROUP.PLAYER);

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ *
 * Scratch — one of everything, reused forever
 * ------------------------------------------------------------------ */

const rayHit: RayHit = makeRayHit();
const exitHit: RayHit = makeRayHit();
const hit: WeaponHit = makeWeaponHit();
const boxes: Hitbox[] = [];
for (let i = 0; i < 64; i++) {
  boxes.push({
    targetId: -1, part: "chest",
    ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0,
    radius: 0.3, scale: 1, alive: true,
  });
}
const overlapScratch: PhysicsObject[] = [];

export type HitHandler = (h: WeaponHit, def: WeaponDef) => void;

/* ------------------------------------------------------------------ *
 * Geometry helpers
 * ------------------------------------------------------------------ */

const _cap = { t: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0 };

/**
 * Ray vs capsule. Returns the distance along the ray or -1.
 *
 * Solved as ray-vs-infinite-cylinder clipped to the segment, then the two end
 * spheres — the textbook decomposition, written out rather than pulled from a
 * library because it runs a few hundred times per shotgun blast and must not
 * allocate.
 */
export function segmentCapsule(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  radius: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const aox = ox - ax;
  const aoy = oy - ay;
  const aoz = oz - az;

  const abab = abx * abx + aby * aby + abz * abz;
  const abd = abx * dx + aby * dy + abz * dz;
  const abao = abx * aox + aby * aoy + abz * aoz;

  const r2 = radius * radius;
  let best = -1;

  if (abab > 1e-9) {
    const m = abd / abab;
    const n = abao / abab;
    const qx = dx - abx * m;
    const qy = dy - aby * m;
    const qz = dz - abz * m;
    const rx = aox - abx * n;
    const ry = aoy - aby * n;
    const rz = aoz - abz * n;
    const a = qx * qx + qy * qy + qz * qz;
    const b = 2 * (qx * rx + qy * ry + qz * rz);
    const c = rx * rx + ry * ry + rz * rz - r2;
    if (a > 1e-9) {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        const t0 = (-b - sq) / (2 * a);
        const t1 = (-b + sq) / (2 * a);
        for (const t of [t0, t1]) {
          if (t < 0 || t > maxDist) continue;
          const u = n + t * m;
          if (u >= 0 && u <= 1) {
            best = t;
            break;
          }
        }
      }
    } else if (c <= 0) {
      // Ray parallel to the axis and already inside the cylinder.
      best = 0;
    }
  }

  // End caps.
  for (let e = 0; e < 2; e++) {
    const cx = e === 0 ? ax : bx;
    const cy = e === 0 ? ay : by;
    const cz = e === 0 ? az : bz;
    const ex = ox - cx;
    const ey = oy - cy;
    const ez = oz - cz;
    const b2 = 2 * (ex * dx + ey * dy + ez * dz);
    const c2 = ex * ex + ey * ey + ez * ez - r2;
    const disc = b2 * b2 - 4 * c2;
    if (disc < 0) continue;
    const sq = Math.sqrt(disc);
    const t0 = (-b2 - sq) * 0.5;
    if (t0 >= 0 && t0 <= maxDist && (best < 0 || t0 < best)) best = t0;
  }
  return best;
}

/** Fill `_cap` with the capsule surface normal at a point. */
function capsuleNormal(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): void {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (len2 > 1e-9) {
    t = clamp01(((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / len2);
  }
  let nx = px - (ax + abx * t);
  let ny = py - (ay + aby * t);
  let nz = pz - (az + abz * t);
  const l = Math.hypot(nx, ny, nz) || 1;
  _cap.nx = nx / l;
  _cap.ny = ny / l;
  _cap.nz = nz / l;
}

/* ------------------------------------------------------------------ *
 * Hitbox resolution (lag compensation)
 * ------------------------------------------------------------------ */

interface BoxResult {
  t: number;
  part: HitPart;
  targetId: number;
  scale: number;
  nx: number;
  ny: number;
  nz: number;
}

const boxResult: BoxResult = { t: -1, part: "none", targetId: -1, scale: 1, nx: 0, ny: 1, nz: 0 };

/**
 * Nearest registered hitbox along a segment, as of `atTime`.
 *
 * Hitboxes take priority over the physics collider of the same entity: a
 * ragdoll capsule in Rapier is one coarse shape, while the hitbox set knows
 * about heads. When both answer, whichever is nearer wins, and the hitbox wins
 * ties — a headshot must never be eaten by the body collider that encloses it.
 */
function resolveHitbox(
  atTime: number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
): BoxResult {
  boxResult.t = -1;
  boxResult.part = "none";
  boxResult.targetId = -1;
  const p = hitboxProvider();
  if (!p) return boxResult;

  const n = p.query(
    atTime,
    ox, oy, oz,
    ox + dx * maxDist, oy + dy * maxDist, oz + dz * maxDist,
    boxes,
  );
  for (let i = 0; i < n && i < boxes.length; i++) {
    const b = boxes[i];
    if (!b.alive) continue;
    const t = segmentCapsule(
      ox, oy, oz, dx, dy, dz, maxDist,
      b.ax, b.ay, b.az, b.bx, b.by, b.bz, b.radius,
    );
    if (t < 0) continue;
    // Ties go to the smaller box, which is always the more specific one.
    if (boxResult.t < 0 || t < boxResult.t - 1e-4) {
      boxResult.t = t;
      boxResult.part = b.part;
      boxResult.targetId = b.targetId;
      boxResult.scale = b.scale;
      capsuleNormal(
        ox + dx * t, oy + dy * t, oz + dz * t,
        b.ax, b.ay, b.az, b.bx, b.by, b.bz,
      );
      boxResult.nx = _cap.nx;
      boxResult.ny = _cap.ny;
      boxResult.nz = _cap.nz;
    }
  }
  return boxResult;
}

/* ------------------------------------------------------------------ *
 * Penetration
 * ------------------------------------------------------------------ */

/**
 * How thick was that? Cast back through the wall from a point beyond it.
 *
 * `probe` bounds how deep we are willing to look, which is also the "this is
 * solid rock, stop" test: no exit face inside the probe means the round is
 * staying in there.
 */
function measureThickness(
  px: number, py: number, pz: number,
  dx: number, dy: number, dz: number,
  probe: number,
  collider: unknown,
): number {
  const sx = px + dx * probe;
  const sy = py + dy * probe;
  const sz = pz + dz * probe;
  const found = raycast(sx, sy, sz, -dx, -dy, -dz, probe, exitHit, {
    groups: BULLET_MASK,
    skipSurface: true,
    // Only the wall we are inside counts. Without this, a wall in front of
    // another wall reports a "thickness" spanning the gap between them.
    predicate: (c) => (collider ? c === collider : true),
  });
  if (!found) return probe + 1;
  return Math.max(0.005, probe - exitHit.distance);
}

/**
 * Fraction of energy surviving `thickness` metres of `surface` for a round
 * with penetration rating `pen`.
 *
 * The surface's own factor is defined as "how much survives 10 cm", so the
 * exponent is thickness in decimetres. Glass is nearly free, a 30 cm concrete
 * column is a wall.
 */
function penetrationLoss(surface: SurfaceTag, pen: number, thickness: number): number {
  const props = SURFACE_PROPS[surface] ?? SURFACE_PROPS.concrete;
  const base = clamp01(props.penetration * (0.35 + pen * 1.3));
  if (base <= 0.001) return 0;
  return Math.pow(base, Math.max(0.15, thickness / 0.1));
}

/* ------------------------------------------------------------------ *
 * Hitscan
 * ------------------------------------------------------------------ */

function maxRangeOf(def: WeaponDef): number {
  const last = def.damage[def.damage.length - 1];
  return clamp((last?.d ?? 100) * 1.6, 120, 2600);
}

/** Fill the shared hit record from a world raycast. */
function fillFromRay(
  h: WeaponHit,
  r: RayHit,
  dx: number, dy: number, dz: number,
  travelled: number,
): void {
  h.hit = true;
  h.x = r.px; h.y = r.py; h.z = r.pz;
  h.nx = r.nx; h.ny = r.ny; h.nz = r.nz;
  h.dx = dx; h.dy = dy; h.dz = dz;
  h.distance = travelled;
  h.surface = r.surface;
  h.object = r.object;
  h.part = "none";
  h.targetId = -1;
}

/**
 * Trace one round. Returns the number of impacts reported.
 *
 * The loop is the interesting part: each iteration is a *segment*, and a
 * segment ends in one of four ways — nothing hit (done), an entity hit (done,
 * unless the round is strong enough to over-penetrate flesh), a ricochet (new
 * direction, reduced energy) or a penetration (same direction, reduced energy,
 * origin moved to the exit face).
 */
export function fireHitscan(
  def: WeaponDef,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ctx: ShotContext,
  rng: Rng,
  onHit: HitHandler,
): number {
  const maxRange = maxRangeOf(def);
  let x = ox;
  let y = oy;
  let z = oz;
  let remaining = maxRange;
  let travelled = 0;
  let energy = 1;
  let penetrations = 0;
  let ricochets = 0;
  let impacts = 0;

  for (let guard = 0; guard < 8 && remaining > 0.2 && energy > 0.05; guard++) {
    const worldHit = raycast(x, y, z, dx, dy, dz, remaining, rayHit, { groups: BULLET_MASK });
    const box = resolveHitbox(ctx.time, x, y, z, dx, dy, dz, remaining);
    const boxFirst = box.t >= 0 && (!worldHit || box.t <= rayHit.distance + 0.05);

    if (!worldHit && !boxFirst) break;

    if (boxFirst) {
      const t = box.t;
      travelled += t;
      hit.hit = true;
      hit.x = x + dx * t;
      hit.y = y + dy * t;
      hit.z = z + dz * t;
      hit.nx = box.nx; hit.ny = box.ny; hit.nz = box.nz;
      hit.dx = dx; hit.dy = dy; hit.dz = dz;
      hit.distance = travelled;
      hit.surface = "flesh";
      hit.object = null;
      hit.part = box.part;
      hit.targetId = box.targetId;
      hit.penetrated = penetrations;
      hit.ricochets = ricochets;
      hit.travelTime = travelled / Math.max(1, def.muzzleVelocity);
      hit.energy = energy;
      hit.damage =
        damageAtRange(def, travelled) * energy * partMultiplier(def, box.part) * box.scale;
      hit.throughAndThrough = def.penetration > 0.55 && energy > 0.5;
      onHit(hit, def);
      impacts++;

      if (!hit.throughAndThrough || penetrations >= def.maxPenetrations) break;
      // Through-and-through: a rifle round does not stop in a torso.
      penetrations++;
      energy *= 0.55;
      const step = t + 0.45;
      x += dx * step; y += dy * step; z += dz * step;
      remaining -= step;
      continue;
    }

    const t = rayHit.distance;
    travelled += t;
    const props = SURFACE_PROPS[rayHit.surface] ?? SURFACE_PROPS.concrete;

    fillFromRay(hit, rayHit, dx, dy, dz, travelled);
    hit.penetrated = penetrations;
    hit.ricochets = ricochets;
    hit.travelTime = travelled / Math.max(1, def.muzzleVelocity);
    hit.energy = energy;
    hit.damage = damageAtRange(def, travelled) * energy;

    /* ---- ricochet? ---- */
    const cosN = -(dx * rayHit.nx + dy * rayHit.ny + dz * rayHit.nz);
    const grazeDeg = Math.asin(clamp(Math.abs(cosN), 0, 1)) / DEG;
    const canRicochet =
      ricochets < def.maxRicochets &&
      grazeDeg < def.ricochetAngle &&
      props.ricochet > 0 &&
      rng.next() < props.ricochet * (1 - grazeDeg / Math.max(1, def.ricochetAngle));

    if (canRicochet) {
      hit.throughAndThrough = false;
      hit.damage *= 0.3;
      onHit(hit, def);
      impacts++;
      // Reflect, scatter a little, and bleed most of the energy: a skipped
      // round is dangerous but no longer aimed.
      const d = dx * rayHit.nx + dy * rayHit.ny + dz * rayHit.nz;
      dx = dx - 2 * d * rayHit.nx + rng.gauss() * 0.06;
      dy = dy - 2 * d * rayHit.ny + rng.gauss() * 0.06;
      dz = dz - 2 * d * rayHit.nz + rng.gauss() * 0.06;
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l; dy /= l; dz /= l;
      ricochets++;
      energy *= 0.42;
      x = rayHit.px + dx * 0.03;
      y = rayHit.py + dy * 0.03;
      z = rayHit.pz + dz * 0.03;
      remaining -= t + 0.03;
      continue;
    }

    /* ---- penetrate? ---- */
    let survived = 0;
    let thickness = 0;
    if (penetrations < def.maxPenetrations && def.penetration > 0.02) {
      const probe = Math.min(1.4, remaining - t);
      if (probe > 0.02) {
        thickness = measureThickness(rayHit.px, rayHit.py, rayHit.pz, dx, dy, dz, probe, rayHit.collider);
        if (thickness <= probe) survived = penetrationLoss(rayHit.surface, def.penetration, thickness);
      }
    }

    hit.throughAndThrough = survived > 0.05;
    onHit(hit, def);
    impacts++;

    if (survived <= 0.05) break;

    penetrations++;
    energy *= survived;
    const step = t + thickness + 0.02;
    x = rayHit.px + dx * (thickness + 0.02);
    y = rayHit.py + dy * (thickness + 0.02);
    z = rayHit.pz + dz * (thickness + 0.02);
    remaining -= step;

    // The exit wound is a real event: spall on the far side, and the sound
    // the guy behind the wall hears.
    if (remaining > 0.2) {
      hit.hit = true;
      hit.x = x; hit.y = y; hit.z = z;
      hit.nx = -dx; hit.ny = -dy; hit.nz = -dz;
      hit.distance = travelled + thickness;
      hit.penetrated = penetrations;
      hit.energy = energy;
      hit.damage = 0;
      hit.throughAndThrough = true;
      onHit(hit, def);
    }
    travelled += thickness;
  }

  return impacts;
}

function partMultiplier(def: WeaponDef, part: HitPart): number {
  switch (part) {
    case "head": return def.mult.head;
    case "chest": return def.mult.chest;
    case "stomach": return def.mult.stomach;
    case "arm": return def.mult.arm;
    case "leg": return def.mult.leg;
    default: return 1;
  }
}

/* ------------------------------------------------------------------ *
 * Projectiles
 * ------------------------------------------------------------------ */

export type ProjectileKind = "grenade" | "rocket" | "sticky" | "shell";

export interface Projectile {
  alive: boolean;
  id: number;
  kind: ProjectileKind;
  def: WeaponDef;
  x: number; y: number; z: number;
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  /** Orientation for the renderer: forward is the velocity, spin is cosmetic. */
  spin: number;
  spinRate: number;
  /** Seconds alive. */
  age: number;
  /** Seconds until the fuse blows. Infinity for remote-detonated. */
  fuse: number;
  armed: boolean;
  /** Stuck to something (sticky mines). */
  stuck: boolean;
  stuckTo: PhysicsObject | null;
  /** Offset in the stuck body's local frame. */
  lx: number; ly: number; lz: number;
  /** Surface normal we stuck to, world space at attach time. */
  snx: number; sny: number; snz: number;
  /** Sim time the shot was fired — the lag-compensation stamp. */
  firedAt: number;
  /** Rocket motor burn remaining. */
  burn: number;
  /** Smoke trail emission accumulator. */
  trail: number;
  bounces: number;
}

const MAX_PROJECTILES = 48;
const projectiles: Projectile[] = [];
let nextProjectileId = 1;

function makeProjectile(): Projectile {
  return {
    alive: false, id: 0, kind: "grenade", def: null as unknown as WeaponDef,
    x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0,
    spin: 0, spinRate: 0, age: 0, fuse: Infinity, armed: false,
    stuck: false, stuckTo: null, lx: 0, ly: 0, lz: 0,
    snx: 0, sny: 1, snz: 0,
    firedAt: 0, burn: 0, trail: 0, bounces: 0,
  };
}
for (let i = 0; i < MAX_PROJECTILES; i++) projectiles.push(makeProjectile());

/** Sticky mines the player has placed and not yet detonated. */
const stickies: Projectile[] = [];

export interface ProjectileOptions {
  /** Extra speed inherited from the shooter (a grenade thrown from a car). */
  inheritX?: number;
  inheritY?: number;
  inheritZ?: number;
  /** Override the fuse — used by cooked grenades. */
  fuse?: number;
  kind?: ProjectileKind;
}

export function spawnProjectile(
  def: WeaponDef,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ctx: ShotContext,
  opts?: ProjectileOptions,
): Projectile | null {
  let p: Projectile | null = null;
  for (let i = 0; i < projectiles.length; i++) {
    if (!projectiles[i].alive) {
      p = projectiles[i];
      break;
    }
  }
  // Full pool: recycle the oldest non-sticky. A player who has thirty rockets
  // in the air has bigger problems than losing the first one.
  if (!p) {
    let oldest: Projectile | null = null;
    for (const q of projectiles) {
      if (q.kind === "sticky") continue;
      if (!oldest || q.age > oldest.age) oldest = q;
    }
    if (!oldest) return null;
    p = oldest;
  }

  const e = def.explosive;
  p.alive = true;
  p.id = nextProjectileId++;
  p.kind = opts?.kind ?? (e?.sticky ? "sticky" : def.cls === "rocket" ? "rocket" : def.cls === "thrown" ? "grenade" : "shell");
  p.def = def;
  p.x = p.px = ox;
  p.y = p.py = oy;
  p.z = p.pz = oz;
  const v = def.muzzleVelocity;
  p.vx = dx * v + (opts?.inheritX ?? 0);
  p.vy = dy * v + (opts?.inheritY ?? 0);
  p.vz = dz * v + (opts?.inheritZ ?? 0);
  p.spin = 0;
  p.spinRate = p.kind === "grenade" ? 9 : p.kind === "sticky" ? 5 : 1.2;
  p.age = 0;
  p.fuse = opts?.fuse ?? (e && e.fuse > 0 ? e.fuse : e && e.fuse === 0 ? Infinity : Infinity);
  p.armed = false;
  p.stuck = false;
  p.stuckTo = null;
  p.firedAt = ctx.time;
  p.burn = def.cls === "rocket" ? 0.85 : 0;
  p.trail = 0;
  p.bounces = 0;
  return p;
}

const SUBSTEP = 1 / 120;
const _pose = new Float32Array(7);

/**
 * Integrate every live projectile.
 *
 * Fixed substeps, swept between them. `onHit` is called for non-explosive
 * impacts (a 40 mm that lands in the dirt still makes a hole) and detonations
 * route through `detonate`, which is also what the remote trigger calls.
 */
export function updateBallistics(dt: number, onHit: HitHandler): void {
  const steps = Math.min(8, Math.max(1, Math.ceil(dt / SUBSTEP)));
  const h = dt / steps;

  for (let i = 0; i < projectiles.length; i++) {
    const p = projectiles[i];
    if (!p.alive) continue;
    const def = p.def;
    const e = def.explosive;

    p.age += dt;
    p.spin += p.spinRate * dt;

    if (p.stuck) {
      followAttachment(p);
      if (p.fuse !== Infinity) {
        p.fuse -= dt;
        if (p.fuse <= 0) detonate(p, onHit);
      }
      continue;
    }

    if (!p.armed && p.age >= (e?.armTime ?? 0)) p.armed = true;

    for (let s = 0; s < steps && p.alive; s++) {
      p.px = p.x; p.py = p.y; p.pz = p.z;

      // Rocket sustainer: thrust along the current heading while it burns.
      if (p.burn > 0) {
        const l = Math.hypot(p.vx, p.vy, p.vz) || 1;
        const accel = 120;
        p.vx += (p.vx / l) * accel * h;
        p.vy += (p.vy / l) * accel * h;
        p.vz += (p.vz / l) * accel * h;
        p.burn -= h;
      }

      // Quadratic drag and gravity. `def.drag` is tuned so a 40 mm arcs the
      // way a designer expects rather than the way a wind tunnel does.
      const sp = Math.hypot(p.vx, p.vy, p.vz);
      if (sp > 0.001 && def.drag > 0) {
        const k = def.drag * sp * h;
        p.vx -= p.vx * k;
        p.vy -= p.vy * k;
        p.vz -= p.vz * k;
      }
      p.vy -= 9.81 * def.gravity * h;

      const nx = p.x + p.vx * h;
      const ny = p.y + p.vy * h;
      const nz = p.z + p.vz * h;

      let dx = nx - p.x;
      let dy = ny - p.y;
      let dz = nz - p.z;
      const seg = Math.hypot(dx, dy, dz);
      if (seg > 1e-6) {
        dx /= seg; dy /= seg; dz /= seg;
        const box = resolveHitbox(p.firedAt, p.x, p.y, p.z, dx, dy, dz, seg);
        const world = raycast(p.x, p.y, p.z, dx, dy, dz, seg, rayHit, { groups: BULLET_MASK });
        const boxFirst = box.t >= 0 && (!world || box.t <= rayHit.distance);

        if (boxFirst || world) {
          const t = boxFirst ? box.t : rayHit.distance;
          p.x += dx * t; p.y += dy * t; p.z += dz * t;
          const surface: SurfaceTag = boxFirst ? "flesh" : rayHit.surface;
          const obj = boxFirst ? null : rayHit.object;
          const nX = boxFirst ? box.nx : rayHit.nx;
          const nY = boxFirst ? box.ny : rayHit.ny;
          const nZ = boxFirst ? box.nz : rayHit.nz;
          onProjectileContact(p, onHit, surface, obj, nX, nY, nZ, dx, dy, dz, box.targetId, box.part);
          break;
        }
      }

      p.x = nx; p.y = ny; p.z = nz;

      // Backstop: the bay and the terrain always exist even when their
      // colliders have not streamed in yet. A grenade must never fall through
      // the world into the void.
      const ground = terrainHeight(p.x, p.z);
      if (p.y <= ground + 0.05) {
        p.y = ground + 0.05;
        if (isWater(p.x, p.z)) {
          onProjectileContact(p, onHit, "water", null, 0, 1, 0, 0, -1, 0, -1, "none");
        } else {
          onProjectileContact(p, onHit, "dirt", null, 0, 1, 0, 0, -1, 0, -1, "none");
        }
        break;
      }
    }

    if (!p.alive) continue;

    if (p.fuse !== Infinity) {
      p.fuse -= dt;
      if (p.fuse <= 0) detonate(p, onHit);
    }
    // Never let a dud live forever.
    if (p.alive && p.age > 22) retire(p);
  }
}

function onProjectileContact(
  p: Projectile,
  onHit: HitHandler,
  surface: SurfaceTag,
  obj: PhysicsObject | null,
  nx: number, ny: number, nz: number,
  dx: number, dy: number, dz: number,
  targetId: number,
  part: HitPart,
): void {
  const def = p.def;
  const e = def.explosive;

  hit.hit = true;
  hit.x = p.x; hit.y = p.y; hit.z = p.z;
  hit.nx = nx; hit.ny = ny; hit.nz = nz;
  hit.dx = dx; hit.dy = dy; hit.dz = dz;
  hit.distance = 0;
  hit.surface = surface;
  hit.object = obj;
  hit.part = part;
  hit.targetId = targetId;
  hit.penetrated = 0;
  hit.ricochets = p.bounces;
  hit.travelTime = p.age;
  hit.energy = 1;
  hit.throughAndThrough = false;
  hit.damage = damageAtRange(def, 0) * partMultiplier(def, part);

  if (!e) {
    onHit(hit, def);
    retire(p);
    return;
  }

  /* ---- sticky: attach and wait for the player ---- */
  if (e.sticky) {
    if (!p.armed) {
      // Not armed yet: bounce weakly instead of sticking to your own boot.
      bounce(p, nx, ny, nz, 0.25);
      return;
    }
    p.stuck = true;
    p.vx = p.vy = p.vz = 0;
    p.snx = nx; p.sny = ny; p.snz = nz;
    p.stuckTo = obj && obj.body ? obj : null;
    if (p.stuckTo && p.stuckTo.body) {
      const t = p.stuckTo.body.translation();
      const q = p.stuckTo.body.rotation();
      // Store the offset in the body's local frame so the mine rides a moving
      // car, a helicopter, or the guy you stuck it to.
      const ix = p.x - t.x;
      const iy = p.y - t.y;
      const iz = p.z - t.z;
      const inv = conjugate(q);
      const r = rotateByQuat(ix, iy, iz, inv);
      p.lx = r[0]; p.ly = r[1]; p.lz = r[2];
    }
    if (!stickies.includes(p)) stickies.push(p);
    onHit(hit, def);
    playImpactSound("metal", { x: p.x, y: p.y, z: p.z, volume: 0.5, pitch: 1.5 });
    return;
  }

  /* ---- grenade: bounce until the fuse runs out ---- */
  if (e.bounces && p.bounces < 6) {
    p.bounces++;
    bounce(p, nx, ny, nz, e.restitution ?? 0.35);
    playImpactSound(surface, {
      x: p.x, y: p.y, z: p.z,
      volume: 0.35 + 0.2 * Math.min(1, Math.hypot(p.vx, p.vy, p.vz) / 14),
      pitch: 1.3,
    });
    onHit(hit, def);
    return;
  }

  /* ---- impact-fused: detonate now ---- */
  if (p.armed || e.fuse < 0) {
    onHit(hit, def);
    detonate(p, onHit);
  } else {
    bounce(p, nx, ny, nz, 0.2);
  }
}

function bounce(p: Projectile, nx: number, ny: number, nz: number, restitution: number): void {
  const d = p.vx * nx + p.vy * ny + p.vz * nz;
  p.vx -= (1 + restitution) * d * nx;
  p.vy -= (1 + restitution) * d * ny;
  p.vz -= (1 + restitution) * d * nz;
  // Tangential friction — a grenade on asphalt does not skate forever.
  p.vx *= 0.72; p.vy *= 0.9; p.vz *= 0.72;
  p.x += nx * 0.045;
  p.y += ny * 0.045;
  p.z += nz * 0.045;
  p.spinRate = clamp(Math.hypot(p.vx, p.vy, p.vz) * 0.8, 0.5, 18);
}

/* ---- quaternion helpers for stuck mines ---- */

const _q = [0, 0, 0, 1];
const _r = [0, 0, 0];

function conjugate(q: { x: number; y: number; z: number; w: number }): number[] {
  _q[0] = -q.x; _q[1] = -q.y; _q[2] = -q.z; _q[3] = q.w;
  return _q;
}

function rotateByQuat(x: number, y: number, z: number, q: number[]): number[] {
  const qx = q[0];
  const qy = q[1];
  const qz = q[2];
  const qw = q[3];
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  _r[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  _r[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  _r[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
  return _r;
}

function followAttachment(p: Projectile): void {
  const obj = p.stuckTo;
  if (!obj || !obj.body) return;
  const t = obj.body.translation();
  const q = obj.body.rotation();
  _q[0] = q.x; _q[1] = q.y; _q[2] = q.z; _q[3] = q.w;
  const r = rotateByQuat(p.lx, p.ly, p.lz, _q);
  p.x = t.x + r[0];
  p.y = t.y + r[1];
  p.z = t.z + r[2];
}

/* ------------------------------------------------------------------ *
 * Detonation
 * ------------------------------------------------------------------ */

export type ExplosionHandler = (
  x: number, y: number, z: number,
  radius: number,
  def: WeaponDef,
) => void;

let explosionHandler: ExplosionHandler | null = null;

/** Register the VFX-side explosion callback (fireball, shockwave, dust). */
export function onWeaponExplosion(fn: ExplosionHandler | null): void {
  explosionHandler = fn;
}

export function detonate(p: Projectile, onHit: HitHandler): void {
  const def = p.def;
  const e = def.explosive;
  if (!p.alive) return;
  if (!e) {
    retire(p);
    return;
  }

  const x = p.x;
  const y = p.y;
  const z = p.z;

  // Physics + destructibles: the world's own solver handles occlusion,
  // staging and shard impulses. We only tell it where and how hard.
  destruction.explode(x, y, z, e.radius, e.force, e.damage * def.structure, -1, 0);

  // Entities: hitbox-aware so a target behind cover takes less.
  damageInRadius(x, y, z, e.radius, e.damage, def, onHit);

  playExplosionSound(e.radius, { x, y, z, volume: 1 });
  if (!emitVfx("explosion", (d) => {
    d.x = x; d.y = y; d.z = z; d.radius = e.radius; d.weapon = def.key;
  })) {
    explosionHandler?.(x, y, z, e.radius, def);
  }

  retire(p);
}

const _damageHit = makeWeaponHit();

/**
 * Radial damage against entities.
 *
 * Falloff is 1 - (d/r)² rather than linear: linear falloff makes the edge of
 * a blast feel unfairly lethal, and squared matches how players expect
 * explosives to behave after twenty years of shooters.
 */
function damageInRadius(
  x: number, y: number, z: number,
  radius: number,
  damage: number,
  def: WeaponDef,
  onHit: HitHandler,
): void {
  const p = hitboxProvider();
  if (p) {
    const n = p.query(physics.simTime, x, y, z, x, y + 0.01, z, boxes);
    const seen = new Set<number>();
    for (let i = 0; i < n && i < boxes.length; i++) {
      const b = boxes[i];
      if (!b.alive || seen.has(b.targetId)) continue;
      const cx = (b.ax + b.bx) * 0.5;
      const cy = (b.ay + b.by) * 0.5;
      const cz = (b.az + b.bz) * 0.5;
      const d = Math.hypot(cx - x, cy - y, cz - z) - b.radius;
      if (d > radius) continue;
      seen.add(b.targetId);
      const fall = 1 - clamp01(Math.max(0, d) / radius) ** 2;
      // Occlusion: one ray to the centre. Cheap, and the difference between
      // "the wall saved me" and "explosions ignore geometry".
      const dist = Math.max(0.01, Math.hypot(cx - x, cy - y, cz - z));
      const blocked = raycast(
        x, y, z,
        (cx - x) / dist, (cy - y) / dist, (cz - z) / dist,
        dist - 0.2, rayHit, { groups: BULLET_MASK, skipSurface: true },
      );
      const occ = blocked ? 0.28 : 1;
      _damageHit.hit = true;
      _damageHit.x = cx; _damageHit.y = cy; _damageHit.z = cz;
      _damageHit.nx = (cx - x) / dist; _damageHit.ny = (cy - y) / dist; _damageHit.nz = (cz - z) / dist;
      _damageHit.dx = _damageHit.nx; _damageHit.dy = _damageHit.ny; _damageHit.dz = _damageHit.nz;
      _damageHit.surface = "flesh";
      _damageHit.object = null;
      _damageHit.part = "chest";
      _damageHit.targetId = b.targetId;
      _damageHit.damage = damage * fall * occ;
      _damageHit.distance = dist;
      applyEntityDamage(null, b.targetId, _damageHit.damage, _damageHit, def);
      onHit(_damageHit, def);
    }
    return;
  }

  // No hitbox provider: fall back to physics objects with a gameplay ref.
  overlapScratch.length = 0;
  overlapSphere(x, y, z, radius, overlapScratch, { groups: BULLET_MASK });
  for (const obj of overlapScratch) {
    if (obj.kind !== "enemy" && obj.kind !== "ragdoll" && obj.kind !== "vehicle") continue;
    const t = obj.body?.translation();
    const cx = t?.x ?? x;
    const cy = t?.y ?? y;
    const cz = t?.z ?? z;
    const d = Math.hypot(cx - x, cy - y, cz - z);
    const fall = 1 - clamp01(d / radius) ** 2;
    _damageHit.x = cx; _damageHit.y = cy; _damageHit.z = cz;
    _damageHit.damage = damage * fall;
    _damageHit.targetId = obj.id;
    _damageHit.object = obj;
    applyEntityDamage(obj, obj.id, _damageHit.damage, _damageHit, def);
  }
}

function retire(p: Projectile): void {
  p.alive = false;
  p.stuck = false;
  p.stuckTo = null;
  const i = stickies.indexOf(p);
  if (i >= 0) stickies.splice(i, 1);
}

/** Blow every placed sticky mine (or just the oldest). Returns how many went. */
export function detonateSticky(onHit: HitHandler, all = true): number {
  if (stickies.length === 0) return 0;
  let n = 0;
  if (all) {
    // Copy: detonate() splices the array we are walking.
    const list = stickies.slice();
    for (const p of list) {
      if (p.alive) {
        detonate(p, onHit);
        n++;
      }
    }
  } else {
    const p = stickies[0];
    if (p?.alive) {
      detonate(p, onHit);
      n = 1;
    }
  }
  return n;
}

export function stickyCount(): number {
  return stickies.length;
}

export function forEachProjectile(cb: (p: Projectile) => void): void {
  for (let i = 0; i < projectiles.length; i++) {
    if (projectiles[i].alive) cb(projectiles[i]);
  }
}

export function clearBallistics(): void {
  for (const p of projectiles) {
    p.alive = false;
    p.stuck = false;
    p.stuckTo = null;
  }
  stickies.length = 0;
}

/* ------------------------------------------------------------------ *
 * Dispersion
 * ------------------------------------------------------------------ */

const _dir = { x: 0, y: 0, z: 0 };

/**
 * Perturb a direction inside a cone.
 *
 * The radius uses sqrt(u) so shots are distributed evenly over the *disc*
 * rather than clustered at the centre — a uniform angle would make a 4° cone
 * behave like a 1.5° one and every spread number in the registry would be a
 * lie.
 */
export function spreadDirection(
  dx: number, dy: number, dz: number,
  coneDeg: number,
  rng: Rng,
): { x: number; y: number; z: number } {
  if (coneDeg <= 1e-4) {
    _dir.x = dx; _dir.y = dy; _dir.z = dz;
    return _dir;
  }
  // Build a basis around the aim direction.
  let ux = 0;
  let uy = 1;
  let uz = 0;
  if (Math.abs(dy) > 0.98) {
    ux = 1; uy = 0; uz = 0;
  }
  let rx = uy * dz - uz * dy;
  let ry = uz * dx - ux * dz;
  let rz = ux * dy - uy * dx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const bx = dy * rz - dz * ry;
  const by = dz * rx - dx * rz;
  const bz = dx * ry - dy * rx;

  const a = rng.next() * Math.PI * 2;
  const r = Math.sqrt(rng.next()) * Math.tan(coneDeg * DEG);
  const ox = Math.cos(a) * r;
  const oy = Math.sin(a) * r;

  let x = dx + rx * ox + bx * oy;
  let y = dy + ry * ox + by * oy;
  let z = dz + rz * ox + bz * oy;
  const l = Math.hypot(x, y, z) || 1;
  _dir.x = x / l;
  _dir.y = y / l;
  _dir.z = z / l;
  return _dir;
}
