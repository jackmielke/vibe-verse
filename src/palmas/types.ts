/**
 * San Palmas — shared engine contracts.
 *
 * Every subsystem (terrain, city, water, weapons, AI, …) is a `System`:
 * a factory that receives the shared `WorldCtx` and returns update/dispose
 * hooks. Systems never import each other directly — they talk through
 * `ctx.services`, which is a late-bound registry. That keeps each module
 * independently authorable and independently testable.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre.
 */
import * as THREE from "three";

/** Terrain/collision query surface, provided by the terrain system. */
export interface TerrainService {
  /** Ground height (world Y) at an XZ position. */
  heightAt(x: number, z: number): number;
  /** Upward surface normal at an XZ position. */
  normalAt(x: number, z: number, out?: THREE.Vector3): THREE.Vector3;
  /** True when the point is below sea level (i.e. in the bay). */
  isWater(x: number, z: number): boolean;
  /** Half-extent of the playable square, in metres. */
  readonly worldSize: number;
  readonly seaLevel: number;
}

/** Broadphase collision against city geometry (buildings, props). */
export interface CollisionService {
  /** Register an axis-aligned collider box (world space). */
  addBox(box: THREE.Box3, opts?: { climbable?: boolean; tag?: string }): void;
  /** Push a capsule out of any overlapping collider. Mutates `pos`. */
  resolveCapsule(pos: THREE.Vector3, radius: number, height: number): boolean;
  /** First hit along a ray, or null. Used by weapons + grapple. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null;
}

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  /** Optional object that owns the surface (for damage / decals). */
  object?: THREE.Object3D;
  tag?: string;
}

/** Time-of-day + lighting state, owned by the sky system. */
export interface SkyService {
  /** Normalised time of day, 0 = midnight, 0.5 = noon. */
  time: number;
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  /** Scalar 0..1, 1 = full daylight. Drives headlights, emissives, etc. */
  daylight: number;
  setTime(t: number): void;
}

/** Damage + combat routing so weapons/AI/vehicles stay decoupled. */
export interface CombatService {
  /** Apply damage to whatever occupies `point`. Returns true if something was hit. */
  damageAt(point: THREE.Vector3, amount: number, source?: string): boolean;
  /** Spawn an explosion: pushes physics, damages actors, triggers VFX + audio. */
  explode(point: THREE.Vector3, radius: number, force: number): void;
  /** Register a damageable actor (enemy, vehicle, prop). */
  registerTarget(t: DamageTarget): () => void;
  queryTargets(point: THREE.Vector3, radius: number): DamageTarget[];
}

export interface DamageTarget {
  object: THREE.Object3D;
  radius: number;
  hp: number;
  onDamage(amount: number, point: THREE.Vector3, source?: string): void;
  faction?: "player" | "enemy" | "neutral";
}

/** Particle / decal / debris spawning. */
export interface VfxService {
  explosion(point: THREE.Vector3, scale?: number): void;
  impact(point: THREE.Vector3, normal: THREE.Vector3, material?: ImpactMaterial): void;
  tracer(from: THREE.Vector3, to: THREE.Vector3): void;
  muzzleFlash(matrix: THREE.Matrix4, scale?: number): void;
  smoke(point: THREE.Vector3, amount?: number): void;
}

export type ImpactMaterial = "concrete" | "metal" | "wood" | "dirt" | "water" | "glass" | "flesh";

/** Positional + UI audio. */
export interface AudioService {
  play(name: string, opts?: { position?: THREE.Vector3; volume?: number; rate?: number }): void;
  /** Start/stop a looping ambience bed. */
  ambience(name: string, on: boolean): void;
  setListener(camera: THREE.Camera): void;
}

/** Player state the HUD and AI both read. */
export interface PlayerService {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Eye/camera transform in world space. */
  readonly camera: THREE.PerspectiveCamera;
  health: number;
  maxHealth: number;
  state: "ground" | "air" | "wingsuit" | "parachute" | "grapple" | "vehicle" | "water";
  damage(amount: number, from?: THREE.Vector3): void;
  teleport(pos: THREE.Vector3): void;
}

/** Everything a system may reach for. Populated progressively at boot. */
export interface WorldServices {
  terrain?: TerrainService;
  collision?: CollisionService;
  sky?: SkyService;
  combat?: CombatService;
  vfx?: VfxService;
  audio?: AudioService;
  player?: PlayerService;
}

/** Live input snapshot, refreshed before every system update. */
export interface InputState {
  /** -1..1 strafe (+ = right) and forward (+ = forward). */
  moveX: number;
  moveZ: number;
  /** Accumulated look delta for this frame, radians. */
  lookX: number;
  lookY: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  fire: boolean;
  aim: boolean;
  reload: boolean;
  interact: boolean;
  grapple: boolean;
  wingsuit: boolean;
  /** Edge-triggered: true only on the frame the key went down. */
  pressed: Set<string>;
  weaponSlot: number | null;
}

/** Shared context handed to every system factory. */
export interface WorldCtx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  services: WorldServices;
  input: InputState;
  /** Seconds since boot. */
  elapsed: number;
  /** Quality tier — systems should scale their cost off this. */
  quality: QualityTier;
  /** Deterministic RNG so the world regenerates identically. */
  rng: () => number;
  /** Emit a HUD/UI event (picked up by the React layer). */
  emit(event: string, payload?: unknown): void;
  /** Subscribe to a HUD/UI event. Returns an unsubscribe fn. */
  on(event: string, fn: (payload: unknown) => void): () => void;
}

export type QualityTier = "low" | "medium" | "high" | "ultra";

/** A subsystem instance. All hooks are optional. */
export interface System {
  name: string;
  /** Per-frame update. `dt` is clamped delta seconds. */
  update?(dt: number, ctx: WorldCtx): void;
  /** Called after all systems have updated — use for camera-dependent work. */
  lateUpdate?(dt: number, ctx: WorldCtx): void;
  /** Called on canvas resize. */
  resize?(width: number, height: number): void;
  dispose?(): void;
}

/** Factory signature every module must export as its default. */
export type SystemFactory = (ctx: WorldCtx) => System | Promise<System>;

/** Mulberry32 — small, fast, seedable. Keeps worldgen reproducible. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
