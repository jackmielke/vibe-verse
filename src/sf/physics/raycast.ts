/**
 * raycast.ts — the query layer.
 *
 * Weapons, the grapple, AI, footstep audio, camera collision, the vault
 * detector and the explosion solver all ask the world the same handful of
 * questions. They ask them *here*, through an allocation-free API that returns
 * a resolved surface tag, so that a rifle round hitting a Victorian's clapboard
 * gets wood splinters and the right report tail without every weapon
 * re-implementing "what am I looking at".
 *
 * Everything degrades gracefully before Rapier boots: a raycast returns false,
 * an overlap returns zero results. Nothing throws.
 *
 * One ordering rule, because it is not obvious and it bites: Rapier's scene
 * queries run against the broad phase, which is refreshed by `world.step()`.
 * A collider created *after* the last step is invisible to queries until the
 * next one. `updateSfPhysics()` therefore streams colliders and then steps,
 * in that order, so anything called from the render frame sees a current
 * world. Code that creates a collider and immediately raycasts against it
 * inside the same frame must step in between.
 *
 * Public API
 * ----------
 *   makeRayHit() / raycast() / raycastAll()
 *   sphereCast() / capsuleCast() / boxCast()
 *   overlapSphere() / overlapBox() / overlapCapsule()
 *   resolveSurface() / SURFACE_PROPS
 *   losPool                       batched, cached AI line-of-sight
 */
import type * as RAPIER from "@dimforge/rapier3d-compat";
import {
  DISTRICTS,
  ROAD_HALF_WIDTH,
  isPark,
  isRoad,
  isWater,
  nearestStreet,
  terrainSlope,
} from "../geo/sfGeo";
import { buildingIndex } from "../world/buildings/spatialIndex";
import type { BuildingStyle } from "../geo/sfGeo";
import {
  QUERY_ALL,
  QUERY_STATIC,
  physics,
  objectForCollider,
  rapier,
  type PhysicsObject,
  type SurfaceTag,
} from "./world";

/* ------------------------------------------------------------------ *
 * Hit records
 * ------------------------------------------------------------------ */

export interface RayHit {
  hit: boolean;
  /** Distance along the ray, metres. */
  distance: number;
  px: number;
  py: number;
  pz: number;
  /** Outward surface normal at the hit. */
  nx: number;
  ny: number;
  nz: number;
  collider: RAPIER.Collider | null;
  object: PhysicsObject | null;
  surface: SurfaceTag;
}

/** Reusable hit record. Weapons should own one, not allocate per shot. */
export function makeRayHit(): RayHit {
  return {
    hit: false,
    distance: 0,
    px: 0,
    py: 0,
    pz: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    collider: null,
    object: null,
    surface: "concrete",
  };
}

export interface QueryOptions {
  /** Packed InteractionGroups filter. Defaults to QUERY_ALL. */
  groups?: number;
  /** Treat the shape as solid when the origin is inside it. */
  solid?: boolean;
  excludeCollider?: RAPIER.Collider | null;
  excludeBody?: RAPIER.RigidBody | null;
  /** Return false to reject a collider. Called from inside the query. */
  predicate?: (c: RAPIER.Collider) => boolean;
  /** Skip the (cheap but not free) surface lookup. */
  skipSurface?: boolean;
  /** Include sensors. Off by default — you do not want to shoot the bay slab. */
  includeSensors?: boolean;
}

/* ------------------------------------------------------------------ *
 * Scratch — created once, after boot
 * ------------------------------------------------------------------ */

let _ray: RAPIER.Ray | null = null;
let _ball: RAPIER.Ball | null = null;
let _cuboid: RAPIER.Cuboid | null = null;
let _capsule: RAPIER.Capsule | null = null;

const _pos = { x: 0, y: 0, z: 0 };
const _rot = { x: 0, y: 0, z: 0, w: 1 };
const _vel = { x: 0, y: 0, z: 0 };

function ensureScratch(r: NonNullable<ReturnType<typeof rapier>>): void {
  if (!_ray) _ray = new r.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  if (!_ball) _ball = new r.Ball(1);
  if (!_cuboid) _cuboid = new r.Cuboid(1, 1, 1);
  if (!_capsule) _capsule = new r.Capsule(1, 0.5);
}

function filterFlags(r: NonNullable<ReturnType<typeof rapier>>, opts?: QueryOptions): number {
  return opts?.includeSensors ? 0 : r.QueryFilterFlags.EXCLUDE_SENSORS;
}

/* ------------------------------------------------------------------ *
 * Rays
 * ------------------------------------------------------------------ */

/**
 * Closest hit along a ray. `dx,dy,dz` need not be normalised — it is
 * normalised here, and `out.distance` is in metres regardless.
 */
export function raycast(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
  out: RayHit,
  opts?: QueryOptions,
): boolean {
  out.hit = false;
  out.collider = null;
  out.object = null;
  const r = rapier();
  const w = physics.world;
  if (!r || !w) return false;

  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9 || !(maxDist > 0)) return false;
  const inv = 1 / len;
  dx *= inv; dy *= inv; dz *= inv;

  ensureScratch(r);
  const ray = _ray!;
  ray.origin.x = ox; ray.origin.y = oy; ray.origin.z = oz;
  ray.dir.x = dx; ray.dir.y = dy; ray.dir.z = dz;

  const res = w.castRayAndGetNormal(
    ray,
    maxDist,
    opts?.solid ?? true,
    filterFlags(r, opts),
    opts?.groups ?? QUERY_ALL,
    opts?.excludeCollider ?? undefined,
    opts?.excludeBody ?? undefined,
    opts?.predicate,
  );
  if (!res) return false;

  const t = res.timeOfImpact;
  out.hit = true;
  out.distance = t;
  out.px = ox + dx * t;
  out.py = oy + dy * t;
  out.pz = oz + dz * t;
  out.nx = res.normal.x;
  out.ny = res.normal.y;
  out.nz = res.normal.z;
  out.collider = res.collider;
  out.object = objectForCollider(res.collider);
  out.surface = opts?.skipSurface
    ? out.object?.surface ?? "concrete"
    : resolveSurface(out.object, out.px, out.py, out.pz, out.nx, out.ny, out.nz);
  return true;
}

/**
 * Every hit along a ray, nearest first, up to `out.length`.
 * Returns the count written. Used by penetrating rounds and by the explosion
 * occlusion test, which wants to know how much material is in the way.
 */
export function raycastAll(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
  out: RayHit[],
  opts?: QueryOptions,
): number {
  const r = rapier();
  const w = physics.world;
  if (!r || !w || out.length === 0) return 0;

  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return 0;
  const inv = 1 / len;
  dx *= inv; dy *= inv; dz *= inv;

  ensureScratch(r);
  const ray = _ray!;
  ray.origin.x = ox; ray.origin.y = oy; ray.origin.z = oz;
  ray.dir.x = dx; ray.dir.y = dy; ray.dir.z = dz;

  let n = 0;
  w.intersectionsWithRay(
    ray,
    maxDist,
    opts?.solid ?? true,
    (res) => {
      const h = out[n];
      const t = res.timeOfImpact;
      h.hit = true;
      h.distance = t;
      h.px = ox + dx * t;
      h.py = oy + dy * t;
      h.pz = oz + dz * t;
      h.nx = res.normal.x;
      h.ny = res.normal.y;
      h.nz = res.normal.z;
      h.collider = res.collider;
      h.object = objectForCollider(res.collider);
      h.surface = opts?.skipSurface
        ? h.object?.surface ?? "concrete"
        : resolveSurface(h.object, h.px, h.py, h.pz, h.nx, h.ny, h.nz);
      n++;
      return n < out.length;
    },
    filterFlags(r, opts),
    opts?.groups ?? QUERY_ALL,
    opts?.excludeCollider ?? undefined,
    opts?.excludeBody ?? undefined,
    opts?.predicate,
  );
  // intersectionsWithRay does not promise ordering; the callers that care do.
  if (n > 1) {
    const slice = out.slice(0, n).sort((a, b) => a.distance - b.distance);
    for (let i = 0; i < n; i++) out[i] = slice[i];
  }
  return n;
}

/* ------------------------------------------------------------------ *
 * Shape casts
 * ------------------------------------------------------------------ */

function shapeCast(
  r: NonNullable<ReturnType<typeof rapier>>,
  shape: RAPIER.Shape,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
  out: RayHit,
  opts?: QueryOptions,
): boolean {
  const w = physics.world;
  if (!w) return false;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9 || !(maxDist > 0)) return false;
  const inv = 1 / len;
  dx *= inv; dy *= inv; dz *= inv;

  _pos.x = ox; _pos.y = oy; _pos.z = oz;
  _vel.x = dx; _vel.y = dy; _vel.z = dz;

  const res = w.castShape(
    _pos,
    _rot,
    _vel,
    shape,
    0,
    maxDist,
    true,
    filterFlags(r, opts),
    opts?.groups ?? QUERY_ALL,
    opts?.excludeCollider ?? undefined,
    opts?.excludeBody ?? undefined,
    opts?.predicate,
  );
  if (!res) {
    out.hit = false;
    return false;
  }
  const t = res.time_of_impact;
  out.hit = true;
  out.distance = t;
  // witness1 is on the *hit* collider and is already world-space for the
  // collider-vs-shape cast, which is exactly the contact point we want.
  out.px = res.witness1.x;
  out.py = res.witness1.y;
  out.pz = res.witness1.z;
  out.nx = res.normal1.x;
  out.ny = res.normal1.y;
  out.nz = res.normal1.z;
  out.collider = res.collider;
  out.object = objectForCollider(res.collider);
  out.surface = opts?.skipSurface
    ? out.object?.surface ?? "concrete"
    : resolveSurface(out.object, out.px, out.py, out.pz, out.nx, out.ny, out.nz);
  return true;
}

/** Sweep a sphere. The camera-collision and grapple-clearance workhorse. */
export function sphereCast(
  radius: number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
  out: RayHit,
  opts?: QueryOptions,
): boolean {
  const r = rapier();
  if (!r) return false;
  ensureScratch(r);
  _ball!.radius = radius;
  _rot.x = 0; _rot.y = 0; _rot.z = 0; _rot.w = 1;
  return shapeCast(r, _ball!, ox, oy, oz, dx, dy, dz, maxDist, out, opts);
}

/** Sweep an upright capsule — used for step-up probes and vault detection. */
export function capsuleCast(
  halfHeight: number,
  radius: number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
  out: RayHit,
  opts?: QueryOptions,
): boolean {
  const r = rapier();
  if (!r) return false;
  ensureScratch(r);
  _capsule!.halfHeight = halfHeight;
  _capsule!.radius = radius;
  _rot.x = 0; _rot.y = 0; _rot.z = 0; _rot.w = 1;
  return shapeCast(r, _capsule!, ox, oy, oz, dx, dy, dz, maxDist, out, opts);
}

/** Sweep an axis-aligned (or yawed) box. */
export function boxCast(
  hx: number, hy: number, hz: number, yaw: number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
  out: RayHit,
  opts?: QueryOptions,
): boolean {
  const r = rapier();
  if (!r) return false;
  ensureScratch(r);
  _cuboid!.halfExtents.x = hx;
  _cuboid!.halfExtents.y = hy;
  _cuboid!.halfExtents.z = hz;
  const h = yaw * 0.5;
  _rot.x = 0; _rot.y = Math.sin(h); _rot.z = 0; _rot.w = Math.cos(h);
  return shapeCast(r, _cuboid!, ox, oy, oz, dx, dy, dz, maxDist, out, opts);
}

/* ------------------------------------------------------------------ *
 * Overlaps
 * ------------------------------------------------------------------ */

/**
 * Every distinct registered object whose collider overlaps a sphere.
 *
 * Appends into `out` and returns it. Deduplicated by object id, because a
 * vehicle is half a dozen colliders and the explosion solver must not push it
 * six times.
 */
export function overlapSphere(
  x: number, y: number, z: number,
  radius: number,
  out: PhysicsObject[],
  opts?: QueryOptions,
): PhysicsObject[] {
  const r = rapier();
  const w = physics.world;
  if (!r || !w) return out;
  ensureScratch(r);
  _ball!.radius = radius;
  _pos.x = x; _pos.y = y; _pos.z = z;
  _rot.x = 0; _rot.y = 0; _rot.z = 0; _rot.w = 1;

  const seen = _overlapSeen;
  seen.clear();
  w.intersectionsWithShape(
    _pos,
    _rot,
    _ball!,
    (c) => {
      const o = objectForCollider(c);
      if (o && !seen.has(o.id)) {
        seen.add(o.id);
        out.push(o);
      }
      return true;
    },
    filterFlags(r, opts),
    opts?.groups ?? QUERY_ALL,
    opts?.excludeCollider ?? undefined,
    opts?.excludeBody ?? undefined,
    opts?.predicate,
  );
  return out;
}

const _overlapSeen = new Set<number>();

/** Static world only — the mask AI line-of-sight uses. */
const STATIC_LOS_GROUPS = QUERY_STATIC;

export function overlapBox(
  x: number, y: number, z: number,
  hx: number, hy: number, hz: number,
  yaw: number,
  out: PhysicsObject[],
  opts?: QueryOptions,
): PhysicsObject[] {
  const r = rapier();
  const w = physics.world;
  if (!r || !w) return out;
  ensureScratch(r);
  _cuboid!.halfExtents.x = hx;
  _cuboid!.halfExtents.y = hy;
  _cuboid!.halfExtents.z = hz;
  _pos.x = x; _pos.y = y; _pos.z = z;
  const h = yaw * 0.5;
  _rot.x = 0; _rot.y = Math.sin(h); _rot.z = 0; _rot.w = Math.cos(h);

  const seen = _overlapSeen;
  seen.clear();
  w.intersectionsWithShape(
    _pos, _rot, _cuboid!,
    (c) => {
      const o = objectForCollider(c);
      if (o && !seen.has(o.id)) {
        seen.add(o.id);
        out.push(o);
      }
      return true;
    },
    filterFlags(r, opts),
    opts?.groups ?? QUERY_ALL,
    opts?.excludeCollider ?? undefined,
    opts?.excludeBody ?? undefined,
    opts?.predicate,
  );
  return out;
}

export function overlapCapsule(
  x: number, y: number, z: number,
  halfHeight: number, radius: number,
  out: PhysicsObject[],
  opts?: QueryOptions,
): PhysicsObject[] {
  const r = rapier();
  const w = physics.world;
  if (!r || !w) return out;
  ensureScratch(r);
  _capsule!.halfHeight = halfHeight;
  _capsule!.radius = radius;
  _pos.x = x; _pos.y = y; _pos.z = z;
  _rot.x = 0; _rot.y = 0; _rot.z = 0; _rot.w = 1;

  const seen = _overlapSeen;
  seen.clear();
  w.intersectionsWithShape(
    _pos, _rot, _capsule!,
    (c) => {
      const o = objectForCollider(c);
      if (o && !seen.has(o.id)) {
        seen.add(o.id);
        out.push(o);
      }
      return true;
    },
    filterFlags(r, opts),
    opts?.groups ?? QUERY_ALL,
    opts?.excludeCollider ?? undefined,
    opts?.excludeBody ?? undefined,
    opts?.predicate,
  );
  return out;
}

/** True if anything solid overlaps the capsule — the crouch/stand-up test. */
export function capsuleBlocked(
  x: number, y: number, z: number,
  halfHeight: number, radius: number,
  opts?: QueryOptions,
): boolean {
  const r = rapier();
  const w = physics.world;
  if (!r || !w) return false;
  ensureScratch(r);
  _capsule!.halfHeight = halfHeight;
  _capsule!.radius = radius;
  _pos.x = x; _pos.y = y; _pos.z = z;
  _rot.x = 0; _rot.y = 0; _rot.z = 0; _rot.w = 1;
  let blocked = false;
  w.intersectionsWithShape(
    _pos, _rot, _capsule!,
    () => {
      blocked = true;
      return false;
    },
    filterFlags(r, opts),
    opts?.groups ?? QUERY_ALL,
    opts?.excludeCollider ?? undefined,
    opts?.excludeBody ?? undefined,
    opts?.predicate,
  );
  return blocked;
}

/* ------------------------------------------------------------------ *
 * Surface resolution
 * ------------------------------------------------------------------ */

/** Per-surface response numbers. Weapons and VFX read straight off this. */
export interface SurfaceProps {
  /** 0..1 — how much of a round's energy survives passing through 10 cm. */
  penetration: number;
  /** 0..1 — chance a shallow hit skips rather than sticks. */
  ricochet: number;
  /** Impact spark brightness, 0 = none. */
  sparks: number;
  /** Dust/debris puff scale. */
  dust: number;
  /** Decal lifetime multiplier; glass and water get none. */
  decal: number;
  /** Footstep/tyre grip hint, 0..1.5. */
  grip: number;
  /** Audio bank key. */
  audio: string;
}

export const SURFACE_PROPS: Record<SurfaceTag, SurfaceProps> = {
  concrete:  { penetration: 0.18, ricochet: 0.34, sparks: 0.25, dust: 1.0,  decal: 1.0, grip: 1.0,  audio: "concrete" },
  asphalt:   { penetration: 0.22, ricochet: 0.30, sparks: 0.15, dust: 0.85, decal: 1.0, grip: 1.05, audio: "asphalt" },
  metal:     { penetration: 0.10, ricochet: 0.55, sparks: 1.0,  dust: 0.1,  decal: 0.9, grip: 0.75, audio: "metal" },
  thinMetal: { penetration: 0.72, ricochet: 0.22, sparks: 0.8,  dust: 0.15, decal: 1.0, grip: 0.75, audio: "thinMetal" },
  glass:     { penetration: 0.88, ricochet: 0.04, sparks: 0.0,  dust: 0.35, decal: 0.0, grip: 0.5,  audio: "glass" },
  wood:      { penetration: 0.55, ricochet: 0.10, sparks: 0.0,  dust: 0.7,  decal: 1.0, grip: 0.95, audio: "wood" },
  brick:     { penetration: 0.24, ricochet: 0.26, sparks: 0.2,  dust: 1.15, decal: 1.0, grip: 1.0,  audio: "brick" },
  stucco:    { penetration: 0.42, ricochet: 0.14, sparks: 0.05, dust: 1.25, decal: 1.0, grip: 1.0,  audio: "stucco" },
  stone:     { penetration: 0.12, ricochet: 0.40, sparks: 0.3,  dust: 1.0,  decal: 1.0, grip: 1.0,  audio: "stone" },
  dirt:      { penetration: 0.34, ricochet: 0.06, sparks: 0.0,  dust: 1.3,  decal: 0.6, grip: 0.85, audio: "dirt" },
  grass:     { penetration: 0.40, ricochet: 0.04, sparks: 0.0,  dust: 0.75, decal: 0.5, grip: 0.8,  audio: "grass" },
  sand:      { penetration: 0.46, ricochet: 0.03, sparks: 0.0,  dust: 1.5,  decal: 0.4, grip: 0.6,  audio: "sand" },
  gravel:    { penetration: 0.30, ricochet: 0.18, sparks: 0.1,  dust: 1.2,  decal: 0.7, grip: 0.75, audio: "gravel" },
  water:     { penetration: 0.62, ricochet: 0.45, sparks: 0.0,  dust: 0.0,  decal: 0.0, grip: 0.15, audio: "water" },
  flesh:     { penetration: 0.68, ricochet: 0.0,  sparks: 0.0,  dust: 0.0,  decal: 1.0, grip: 0.9,  audio: "flesh" },
  foliage:   { penetration: 0.92, ricochet: 0.0,  sparks: 0.0,  dust: 0.3,  decal: 0.0, grip: 0.7,  audio: "foliage" },
  plastic:   { penetration: 0.64, ricochet: 0.08, sparks: 0.0,  dust: 0.3,  decal: 1.0, grip: 0.85, audio: "plastic" },
  rubber:    { penetration: 0.48, ricochet: 0.05, sparks: 0.0,  dust: 0.2,  decal: 1.0, grip: 1.4,  audio: "rubber" },
  fabric:    { penetration: 0.86, ricochet: 0.0,  sparks: 0.0,  dust: 0.4,  decal: 1.0, grip: 0.9,  audio: "fabric" },
};

/** Wall material by architectural style — matches the facade generator's palette. */
const STYLE_SURFACE: Record<BuildingStyle, SurfaceTag> = {
  victorian: "wood",
  "edwardian-apartment": "stucco",
  "stucco-row": "stucco",
  "midrise-brick": "brick",
  "highrise-glass": "glass",
  "highrise-deco": "stone",
  warehouse: "brick",
  industrial: "thinMetal",
  civic: "stone",
  military: "concrete",
};

/**
 * What did the bullet hit?
 *
 * Order matters. An explicitly-tagged object (a fuel drum, a car door, a
 * ragdoll) wins outright. Terrain and generic building colliders are coarse
 * boxes with no material of their own, so those get resolved against sfGeo and
 * the building index — which is why the physics layer is allowed to know about
 * roads and districts at all.
 */
export function resolveSurface(
  obj: PhysicsObject | null,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
): SurfaceTag {
  if (!obj) return "concrete";

  switch (obj.kind) {
    case "enemy":
    case "player":
    case "ragdoll":
      return "flesh";
    case "vehicle":
      // Panels are thin steel; the roof and bonnet read the same. Glass is
      // tagged per-collider by the vehicle builder and caught by the default.
      return obj.surface === "concrete" ? "thinMetal" : obj.surface;
    case "water":
      return "water";
    case "prop":
    case "debris":
    case "projectile":
    case "trigger":
      return obj.surface;
    case "building":
      return resolveBuildingSurface(x, y, z, ny);
    case "terrain":
      return resolveTerrainSurface(x, z);
    default:
      return obj.surface;
  }
}

function resolveBuildingSurface(x: number, y: number, z: number, ny: number): SurfaceTag {
  let style: BuildingStyle | null = null;
  if (buildingIndex && typeof buildingIndex.queryPoint === "function") {
    const rec = buildingIndex.queryPoint(x, z);
    if (rec) style = rec.style;
  }
  if (!style) return "concrete";

  // Roofs are never the wall material: SF roofs are tar-and-gravel or membrane
  // over concrete deck, and a glass tower's roof is emphatically not glass.
  if (ny > 0.6) {
    return style === "victorian" || style === "stucco-row" ? "gravel" : "concrete";
  }
  // Ground floor of a glass tower is usually stone cladding, not curtain wall.
  if (style === "highrise-glass" && y < 6) return "stone";
  return STYLE_SURFACE[style] ?? "concrete";
}

function resolveTerrainSurface(x: number, z: number): SurfaceTag {
  if (isWater(x, z)) return "water";
  if (isRoad(x, z)) return "asphalt";
  if (isPark(x, z)) return "grass";

  // Sidewalks: outside the carriageway but still hard up against a street.
  const st = nearestStreet(x, z);
  if (st.distance < ROAD_HALF_WIDTH[st.roadClass] + 4.5) return "concrete";

  // Beyond the built city: the Presidio, Lands End and the dunes. Steep ground
  // is bare rock and scree; gentle ground out here is grass or sand.
  const slope = terrainSlope(x, z, 6);
  if (slope > 0.62) return "gravel";

  const d = districtInfluenceSurface(x, z);
  if (d) return d;
  return "dirt";
}

/**
 * A handful of districts have a signature ground cover worth honouring: the
 * Presidio's forest floor, the Sunset's wind-blown sand over everything.
 */
const DISTRICT_GROUND: Record<string, SurfaceTag> = {
  presidio: "grass",
  sunset: "sand",
  richmond: "grass",
  bayview: "gravel",
};

function districtInfluenceSurface(x: number, z: number): SurfaceTag | null {
  // DISTRICTS is small (24); a linear nearest-centre scan is cheaper than the
  // full districtAt() influence solve and this is only a material hint.
  let bestKey = "";
  let bestD = Infinity;
  for (let i = 0; i < DISTRICTS.length; i++) {
    const d = DISTRICTS[i];
    const dx = d.x - x;
    const dz = d.z - z;
    const dist = dx * dx + dz * dz;
    if (dist < bestD && dist < d.radius * d.radius * 2.25) {
      bestD = dist;
      bestKey = d.key;
    }
  }
  return DISTRICT_GROUND[bestKey] ?? null;
}

/* ------------------------------------------------------------------ *
 * Batched line-of-sight for AI
 * ------------------------------------------------------------------ */

interface LosSlot {
  key: number;
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  /** Last computed answer. */
  clear: boolean;
  /** Distance to the first blocker, or the full separation when clear. */
  distance: number;
  /** Sim time of the last computation. */
  stamp: number;
  /** Queued for recomputation. */
  dirty: boolean;
}

/**
 * A cached, budgeted line-of-sight service.
 *
 * Forty enemies each testing sight on the player every frame is forty rays
 * through the building BVH per frame, which is fine — until a firefight makes
 * it forty enemies testing each other. So: results are cached per (observer,
 * target) key, refreshed at most every `maxAge` seconds, and the refreshes are
 * spread over frames under a hard ray budget. AI gets an answer instantly; it
 * is just occasionally a fifth of a second stale, which no player has ever
 * noticed and every shipped shooter does.
 */
class LosPool {
  private slots = new Map<number, LosSlot>();
  private queue: LosSlot[] = [];
  private hit = makeRayHit();

  /** Rays actually cast on the last `update()`. */
  raysLastFrame = 0;

  /**
   * Ask whether `a` can see `b`. Returns the cached answer immediately and
   * schedules a refresh if it is older than `maxAge`.
   *
   * `key` must be stable and unique per observer/target pair — AI packs
   * `(observerId << 16) | targetId`.
   */
  query(
    key: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    maxAge = 0.2,
  ): boolean {
    let s = this.slots.get(key);
    if (!s) {
      s = {
        key,
        ax, ay, az, bx, by, bz,
        clear: false,
        distance: 0,
        stamp: -Infinity,
        dirty: true,
      };
      this.slots.set(key, s);
      this.queue.push(s);
      // First ask gets a synchronous answer; a fresh enemy must not spend its
      // first fifth of a second believing it is blind.
      this.solve(s);
      return s.clear;
    }
    s.ax = ax; s.ay = ay; s.az = az;
    s.bx = bx; s.by = by; s.bz = bz;
    if (!s.dirty && physics.simTime - s.stamp > maxAge) {
      s.dirty = true;
      this.queue.push(s);
    }
    return s.clear;
  }

  /** Distance to the first blocker for the last answer of `key`. */
  blockerDistance(key: number): number {
    return this.slots.get(key)?.distance ?? Infinity;
  }

  /** Process up to `budget` queued rays. Call once per frame. */
  update(budget = 24): void {
    let n = 0;
    while (this.queue.length > 0 && n < budget) {
      const s = this.queue.shift()!;
      if (!s.dirty) continue;
      this.solve(s);
      n++;
    }
    this.raysLastFrame = n;
  }

  private solve(s: LosSlot): void {
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const dz = s.bz - s.az;
    const dist = Math.hypot(dx, dy, dz);
    s.dirty = false;
    s.stamp = physics.simTime;
    if (dist < 1e-4) {
      s.clear = true;
      s.distance = 0;
      return;
    }
    // Static world only: a passing van should not make an enemy forget you.
    const blocked = raycast(s.ax, s.ay, s.az, dx, dy, dz, dist - 0.1, this.hit, {
      groups: STATIC_LOS_GROUPS,
      skipSurface: true,
    });
    s.clear = !blocked;
    s.distance = blocked ? this.hit.distance : dist;
  }

  /** Forget a pair (entity died, target despawned). */
  forget(key: number): void {
    this.slots.delete(key);
  }

  clear(): void {
    this.slots.clear();
    this.queue.length = 0;
  }
}

export const losPool = new LosPool();
