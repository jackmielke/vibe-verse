import type * as THREE from "three";
import type { QualityProfile } from "./core/Settings";
import type { TerrainRig } from "./world/Terrain";
import type { WaterRig } from "./world/Water";
import type { SkyRig } from "./world/Sky";
import type { NeedleRig } from "./world/SpaceNeedle";
import type { Player, Collider } from "./entities/Player";
import type { WeaponSystem } from "./systems/Weapons";
import type { Rng } from "./core/Assets";

/**
 * Everything a world module is allowed to reach. Anything not on here is
 * deliberately out of bounds — if you need something new, add it here rather
 * than importing GameWorld.
 */
export interface ModuleContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  profile: QualityProfile;

  terrain: TerrainRig;
  water: WaterRig;
  sky: SkyRig;
  needle: NeedleRig;
  player: Player;
  weapons: WeaponSystem;

  /** Push here to block player movement. */
  colliders: Collider[];

  /** Deterministic PRNG — use instead of Math.random for stable worlds. */
  rng: Rng;

  /** Register a damageable target so weapons can hit it. */
  registerTarget: (t: DamageTarget) => () => void;

  /** Query all damageable targets (enemy AI, aim assist, radar). */
  targets: DamageTarget[];

  /** Broad-phase raycast against terrain, colliders and targets. */
  raycast: (origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number) => RayHit | null;

  /** Spawn a one-shot effect. Implemented by the FX module if present. */
  fx: FxBus;

  /** Play a positional sound. Implemented by the audio module if present. */
  sound: SoundBus;
}

export interface DamageTarget {
  id: string;
  name: string;
  /** Centre of mass in world space, updated by the owner each frame. */
  position: THREE.Vector3;
  /** Bounding radius for the cheap sphere test. */
  radius: number;
  /** Y offset from `position` to the head centre; 0 disables headshots. */
  headOffset: number;
  headRadius: number;
  health: number;
  maxHealth: number;
  team: "player" | "covenant" | "neutral";
  /** Return true if the hit killed it. */
  applyDamage: (amount: number, headshot: boolean, direction: THREE.Vector3) => boolean;
  alive: boolean;
}

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  target?: DamageTarget;
  headshot?: boolean;
  surface: "terrain" | "water" | "prop" | "target";
}

export type FxKind =
  | "impact-dirt"
  | "impact-metal"
  | "impact-water"
  | "impact-flesh"
  | "muzzle"
  | "explosion"
  | "plasma-burst"
  | "shield-pop"
  | "spray"
  | "smoke";

export interface FxBus {
  spawn: (kind: FxKind, position: THREE.Vector3, normal?: THREE.Vector3, scale?: number) => void;
  tracer: (from: THREE.Vector3, to: THREE.Vector3, color: number) => void;
}

export interface SoundBus {
  play: (id: string, position?: THREE.Vector3, volume?: number, pitch?: number) => void;
  music: (id: string | null) => void;
}

export interface ModuleInstance {
  update?: (dt: number, elapsed: number) => void;
  /** Runs on the fixed physics step instead of the render step. */
  fixed?: (dt: number) => void;
  dispose?: () => void;
}

export interface GameModule {
  id: string;
  /** Lower builds first. Default 100. Terrain-dependent props should be > 50. */
  order?: number;
  /** Skip this module below a quality tier, e.g. "medium". */
  minTier?: "low" | "medium" | "high" | "ultra";
  build: (ctx: ModuleContext) => ModuleInstance | void;
}
