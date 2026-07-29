/**
 * ai/types.ts — the vocabulary every AI module shares.
 *
 * Deliberately dependency-free (three.js and sfGeo excepted) so that importing
 * a type never drags a simulation singleton into a module that only wanted an
 * enum. Everything here is data: ids, factions, LOD bands, and the couple of
 * small records that cross module boundaries.
 *
 * Entity ids
 * ----------
 * Every AI-owned thing that can be shot, hijacked, tracked or heard gets a
 * globally unique integer id from `nextEntityId()`. The weapon stack's hitbox
 * provider, the LOS cache key packer and the squad bookkeeping all key off it,
 * so ids must never be recycled inside a session — reuse means a dead soldier's
 * cached line-of-sight answer gets handed to whoever inherits his slot.
 */

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

let entityCounter = 1;

/** Monotonic, never recycled. 0 is reserved for "nothing". */
export function nextEntityId(): number {
  return entityCounter++;
}

/** Reset for tests / level reload. */
export function resetEntityIds(): void {
  entityCounter = 1;
}

/**
 * Pack an (observer, target) pair into one integer for the LOS cache.
 * Ids are kept under 2^15 per side by folding — collisions between two live
 * pairs would need 32768 simultaneous agents, which the caps forbid.
 */
export function losKey(observer: number, target: number): number {
  return ((observer & 0x7fff) << 15) | (target & 0x7fff);
}

/** The player is not an AI entity but is a valid perception target. */
export const PLAYER_ENTITY_ID = 0x7ffe;

/* ------------------------------------------------------------------ *
 * Factions
 * ------------------------------------------------------------------ */

export type Faction = "civilian" | "police" | "military" | "cartel" | "player";

/** Who shoots whom. Symmetric except that everyone tolerates civilians. */
export function hostile(a: Faction, b: Faction): boolean {
  if (a === b) return false;
  if (a === "civilian" || b === "civilian") return false;
  if (a === "player") return b === "police" || b === "military" || b === "cartel";
  if (b === "player") return a === "police" || a === "military" || a === "cartel";
  // Cops and the army are on the same side; the cartel is on nobody's.
  if ((a === "police" && b === "military") || (a === "military" && b === "police")) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * Level of detail for the *simulation*, not the mesh
 * ------------------------------------------------------------------ *
 * The renderer's LOD decides how many triangles a body costs. This one decides
 * how many *milliseconds* a brain costs, which on a city this size is the
 * expensive half. Three bands, chosen so the transitions are invisible:
 *
 *   FULL     everything: steering, avoidance, perception, animation blending.
 *   SIMPLE   kinematic advance along the path; perception at 4 Hz; no RVO.
 *   FROZEN   position integrated on a coarse tick, no queries at all. The agent
 *            still *exists* so that walking back toward it does not produce a
 *            street that repopulates itself in front of your eyes.
 */
export const LOD_FULL = 0;
export const LOD_SIMPLE = 1;
export const LOD_FROZEN = 2;
export type AiLod = 0 | 1 | 2;

/* ------------------------------------------------------------------ *
 * Character archetypes — what the mesh builder and the AI both key off
 * ------------------------------------------------------------------ */

export type CharacterArchetype =
  | "civilian"
  | "civilian-heavy"
  | "civilian-slim"
  | "tourist"
  | "worker"
  | "cop"
  | "swat"
  | "soldier"
  | "officer";

/** Animation clips the shared character shader knows how to synthesise. */
export const ANIM_IDLE = 0;
export const ANIM_WALK = 1;
export const ANIM_RUN = 2;
export const ANIM_AIM = 3;
export const ANIM_COWER = 4;
export const ANIM_DEAD = 5;
export const ANIM_SIT = 6;
export type AnimClip = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/* ------------------------------------------------------------------ *
 * Vehicles the traffic sim knows how to build and drive
 * ------------------------------------------------------------------ */

export type TrafficVehicleKind =
  | "sedan"
  | "hatchback"
  | "suv"
  | "taxi"
  | "van"
  | "pickup"
  | "bus"
  | "cablecar"
  | "police"
  | "swatvan"
  | "ambulance"
  | "firetruck"
  | "apc";

/** All the kinds, in the order their instanced meshes are allocated. */
export const TRAFFIC_KINDS: readonly TrafficVehicleKind[] = [
  "sedan",
  "hatchback",
  "suv",
  "taxi",
  "van",
  "pickup",
  "bus",
  "cablecar",
  "police",
  "swatvan",
  "ambulance",
  "firetruck",
  "apc",
];

/**
 * The snapshot handed to the vehicles system when the player hijacks something.
 * It is a plain value object on purpose: once it is handed over, the traffic
 * sim has forgotten the vehicle entirely and must not hold a live reference.
 */
export interface HijackSnapshot {
  id: number;
  kind: TrafficVehicleKind;
  x: number;
  y: number;
  z: number;
  /** Heading in radians, 0 = +X. */
  yaw: number;
  /** Forward speed at the moment of the grab, m/s. */
  speed: number;
  /** Body paint, 0xRRGGBB. */
  color: number;
  /** True if a driver was thrown out (and is now a fleeing pedestrian). */
  hadDriver: boolean;
  /** Emergency lights / siren fitted. */
  emergency: boolean;
  /** Remaining structural health 0..1. */
  health: number;
}

/* ------------------------------------------------------------------ *
 * Small shared math — hoisted so nothing allocates in a frame loop
 * ------------------------------------------------------------------ */

/** Shortest signed angular difference b − a, wrapped to (−π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Move `a` toward `b` by at most `maxStep` radians, taking the short way. */
export function approachAngle(a: number, b: number, maxStep: number): number {
  const d = angleDelta(a, b);
  if (d > maxStep) return a + maxStep;
  if (d < -maxStep) return a - maxStep;
  return b;
}

/** Frame-rate independent exponential approach. */
export function expApproach(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

/** Squared XZ distance — the comparison used everywhere in this directory. */
export function dist2XZ(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}
