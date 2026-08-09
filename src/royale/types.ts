/**
 * DROP ZERO — shared engine contracts.
 *
 * Same System/service architecture San Palmas uses: every subsystem is a
 * factory that receives the shared `WorldCtx` and returns update/dispose
 * hooks. Systems never import each other — they publish into `ctx.services`
 * and read each other from there, late-bound, so each module stays
 * independently authorable.
 *
 * What's different from San Palmas is the shape of the game on top: this is
 * a battle royale. That adds four services the shooter never needed —
 * `build` (the harvest/place/edit loop), `storm` (the closing circle),
 * `loot` (rarity-tiered ground spawns + chests) and `match` (the phase
 * machine that runs bus → drop → fight → victory).
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre. The build grid is
 * 4 m — every wall, floor and ramp snaps to it, and every structure in the
 * world is authored so its floors land on multiples of 4.
 */
import * as THREE from "three";

/** The build grid, in metres. Everything structural is a multiple of this. */
export const GRID = 4;
/** Wall thickness for built pieces. */
export const WALL_THICKNESS = 0.25;

// ---------------------------------------------------------------- world

/**
 * The shared material library. Every textured surface in the world comes from
 * here rather than each system rolling its own canvas texture — that is what
 * keeps the island looking like one place, and what keeps the texture count
 * (and the VRAM) bounded.
 */
export interface MaterialsService {
  /** Fetch a named PBR material. Cached — repeated calls return the same one. */
  get(name: MaterialName): THREE.Material;
  /**
   * A variant of a named material tinted to a colour, for per-POI roof and
   * wall identity. Also cached, keyed by name + colour.
   */
  tinted(name: MaterialName, color: THREE.ColorRepresentation): THREE.Material;
  /** Procedural texture by name, for systems that build their own material. */
  texture(name: TextureName): THREE.Texture;
  /** Environment map used for reflections. */
  readonly env: THREE.Texture | null;
}

export type MaterialName =
  | "plaster"
  | "brick"
  | "woodPlank"
  | "woodLog"
  | "concrete"
  | "asphalt"
  | "metalPanel"
  | "corrugated"
  | "roofTile"
  | "roofShingle"
  | "glass"
  | "rock"
  | "dirt"
  | "sand"
  | "grass"
  | "foliage"
  | "bark"
  | "fabric"
  | "gold"
  | "rubber";

export type TextureName =
  | "noise"
  | "grassBlade"
  | "leafCluster"
  | "gravel"
  | "cloud"
  | "spark"
  | "smoke"
  | "muzzle"
  | "decalBullet"
  | "stormGrid";

/** Terrain/collision query surface, provided by the terrain system. */
export interface TerrainService {
  /** Ground height (world Y) at an XZ position. */
  heightAt(x: number, z: number): number;
  /** Upward surface normal at an XZ position. */
  normalAt(x: number, z: number, out?: THREE.Vector3): THREE.Vector3;
  /** True when the point is below sea level. */
  isWater(x: number, z: number): boolean;
  /** Surface material at a point — drives footsteps, impacts, decals. */
  materialAt(x: number, z: number): ImpactMaterial;
  /** Half-extent of the playable square, in metres. */
  readonly worldSize: number;
  readonly seaLevel: number;
}

/** A named place on the map — the POI system registers these. */
export interface Poi {
  name: string;
  center: THREE.Vector3;
  /** Rough radius used for the map, loot density and bot pathing. */
  radius: number;
  /** How much loot this POI is worth — drives chest + floor-loot counts. */
  tier: "minor" | "major" | "landmark";
}

/**
 * Broadphase collision against static world geometry AND player-built
 * structures. Built pieces register/unregister as they are placed and
 * destroyed, so this is not a load-time-only structure.
 */
export interface CollisionService {
  /** Register an axis-aligned collider box (world space). Returns a remover. */
  addBox(box: THREE.Box3, opts?: ColliderOpts): () => void;
  /** Push a capsule out of any overlapping collider. Mutates `pos`. */
  resolveCapsule(pos: THREE.Vector3, radius: number, height: number): CapsuleResolve;
  /** First hit along a ray, or null. Used by weapons, build preview, bots. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null;
  /** Every collider overlapping a sphere — explosions, build validation. */
  query(center: THREE.Vector3, radius: number): ColliderHandle[];
}

export interface ColliderOpts {
  /** Surface sound/particle family. */
  material?: ImpactMaterial;
  /** Harvestable by the pickaxe — trees, walls, cars. */
  harvest?: HarvestKind;
  /** Structures the player built; shot through by bullets differently. */
  built?: boolean;
  tag?: string;
  /** Back-reference so a raycast can find the thing that owns the box. */
  owner?: unknown;
}

export interface ColliderHandle {
  box: THREE.Box3;
  opts: ColliderOpts;
  remove(): void;
}

/** Result of pushing a capsule out of the world. */
export interface CapsuleResolve {
  /** True if any penetration was resolved this call. */
  hit: boolean;
  /** True when something solid is directly underfoot. */
  grounded: boolean;
  /** Y of the surface under the capsule, when grounded. */
  groundY: number;
  /** Normal of the surface under the capsule. */
  groundNormal: THREE.Vector3;
}

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  object?: THREE.Object3D;
  material?: ImpactMaterial;
  harvest?: HarvestKind;
  /** Set when the ray hit a player-built piece. */
  piece?: BuildPiece;
  /** Set when the ray hit a damageable actor. */
  target?: DamageTarget;
  /**
   * The `owner` the collider was registered with, passed straight through.
   *
   * `piece` and `target` are the two owners collision knows how to recognise;
   * this is how everything else finds its way home. Vegetation needs it so a
   * pickaxe hit can tell *which* tree it just felled — without it a harvested
   * trunk's canopy is left standing in the air with nothing underneath.
   */
  owner?: unknown;
  tag?: string;
}

export type HarvestKind = "wood" | "stone" | "metal";
export type ImpactMaterial =
  | "concrete"
  | "metal"
  | "wood"
  | "dirt"
  | "grass"
  | "sand"
  | "water"
  | "glass"
  | "flesh";

/** Time-of-day + lighting state, owned by the sky system. */
export interface SkyService {
  /** Normalised time of day, 0 = midnight, 0.5 = noon. */
  time: number;
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  /** Scalar 0..1, 1 = full daylight. */
  daylight: number;
  /** The scene's key light — shadow-casting systems read its target. */
  sun: THREE.DirectionalLight;
  setTime(t: number): void;
  /** Ask the cascade to cover a point this frame (player, spectate cam). */
  focus(point: THREE.Vector3): void;
}

// ---------------------------------------------------------------- combat

/** Damage + combat routing so weapons/bots/props stay decoupled. */
export interface CombatService {
  /** Register a damageable actor. Returns an unregister fn. */
  registerTarget(t: DamageTarget): () => void;
  queryTargets(point: THREE.Vector3, radius: number): DamageTarget[];
  /** Apply damage along a ray hit — handles headshots, shields, feedback. */
  applyHit(hit: RayHit, amount: number, source: DamageSource): void;
  /** Spawn an explosion: damages actors, breaks builds, triggers VFX + audio. */
  explode(point: THREE.Vector3, radius: number, damage: number, source: DamageSource): void;
}

export interface DamageSource {
  /** Who fired. "player" for the local player, else a bot id. */
  by: string;
  /** Display name for the elimination feed. */
  name?: string;
  weapon?: string;
}

export interface DamageTarget {
  id: string;
  object: THREE.Object3D;
  /** Capsule radius + height used for hit registration. */
  radius: number;
  height: number;
  hp: number;
  shield: number;
  /** Y offset from the capsule base where a headshot registers. */
  headY: number;
  faction: "player" | "bot";
  alive: boolean;
  onDamage(amount: number, point: THREE.Vector3, source: DamageSource, headshot: boolean): void;
}

/** Particle / decal / debris spawning. */
export interface VfxService {
  explosion(point: THREE.Vector3, scale?: number): void;
  impact(point: THREE.Vector3, normal: THREE.Vector3, material?: ImpactMaterial): void;
  tracer(from: THREE.Vector3, to: THREE.Vector3, opts?: { width?: number; color?: THREE.Color }): void;
  muzzleFlash(matrix: THREE.Matrix4, scale?: number): void;
  smoke(point: THREE.Vector3, amount?: number): void;
  /** Floating damage number — the single most-read piece of BR feedback. */
  damageNumber(point: THREE.Vector3, amount: number, headshot: boolean, shield: boolean): void;
  /** The blue shimmer a harvested surface throws off. */
  harvestBurst(point: THREE.Vector3, kind: HarvestKind): void;
  /** Splintering debris when a built piece dies. */
  buildBreak(box: THREE.Box3, kind: HarvestKind): void;
  /** Rarity-coloured beam over a loot item. */
  lootBeam(point: THREE.Vector3, rarity: Rarity): THREE.Object3D;
}

/** Positional + UI audio. */
export interface AudioService {
  play(name: string, opts?: AudioOpts): void;
  /** Start/stop a looping bed. */
  ambience(name: string, on: boolean, volume?: number): void;
  /** Music is its own bus so the storm can duck it. */
  music(name: string | null, volume?: number): void;
  setListener(camera: THREE.Camera): void;
  readonly ready: boolean;
  /** Browsers gate audio behind a gesture — the page calls this on entry. */
  resume(): void;
}

export interface AudioOpts {
  position?: THREE.Vector3;
  volume?: number;
  rate?: number;
  /** Distance at which the sound is inaudible. */
  maxDistance?: number;
}

// ---------------------------------------------------------------- player

export type PlayerState =
  | "bus"
  | "skydive"
  | "glide"
  | "ground"
  | "air"
  | "sprint"
  | "crouch"
  | "swim"
  | "down"
  | "dead";

/** Player state the HUD, bots and camera all read. */
export interface PlayerService {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Yaw/pitch in radians — the camera rig derives from these. */
  yaw: number;
  pitch: number;
  readonly camera: THREE.PerspectiveCamera;
  health: number;
  maxHealth: number;
  shield: number;
  maxShield: number;
  state: PlayerState;
  /** Third-person rig root, for cosmetics and animation systems. */
  readonly rig: THREE.Object3D;
  /** Where bullets originate — camera in first person, muzzle in third. */
  eye(out?: THREE.Vector3): THREE.Vector3;
  /** Unit forward vector from the current look. */
  look(out?: THREE.Vector3): THREE.Vector3;
  damage(amount: number, from: THREE.Vector3 | undefined, source: DamageSource): void;
  heal(hp: number, shield: number): void;
  teleport(pos: THREE.Vector3): void;
  /** True while the player owns the pointer and the match is live. */
  readonly controllable: boolean;
}

// ---------------------------------------------------------------- build

export type BuildKind = "wall" | "floor" | "ramp" | "cone";

/** One placed structural piece. */
export interface BuildPiece {
  id: number;
  kind: BuildKind;
  material: HarvestKind;
  /** Grid cell — world position is cell * GRID. */
  cell: THREE.Vector3;
  /** Quarter turns around Y. */
  rotation: number;
  hp: number;
  maxHp: number;
  /** False while the piece is still building up to full HP. */
  complete: boolean;
  owner: string;
  box: THREE.Box3;
}

/**
 * The build system — Fortnite's actual core loop. Owns the grid, the
 * placement preview, the edit mode, structural integrity and destruction.
 */
export interface BuildService {
  /** Currently selected piece kind, or null when not in build mode. */
  selected: BuildKind | null;
  material: HarvestKind;
  /** Try to place at the current preview transform. Returns the piece. */
  place(): BuildPiece | null;
  /** Damage a piece; removes it (and anything it supported) at zero. */
  damagePiece(piece: BuildPiece, amount: number, source: DamageSource): void;
  /** Every piece overlapping a sphere. */
  queryPieces(center: THREE.Vector3, radius: number): BuildPiece[];
  /** True while the player is mid-edit on a piece. */
  readonly editing: boolean;
  readonly pieceCount: number;
}

/** Harvested materials + carried items. */
export interface InventoryService {
  wood: number;
  stone: number;
  metal: number;
  /** Six slots: 0 = pickaxe, 1..5 = weapons/consumables. */
  readonly slots: (InventoryItem | null)[];
  activeSlot: number;
  readonly active: InventoryItem | null;
  addMaterial(kind: HarvestKind, amount: number): void;
  spendMaterial(kind: HarvestKind, amount: number): boolean;
  /** Pick up an item; returns false when there's no room. */
  pickUp(item: InventoryItem): boolean;
  dropActive(): void;
  select(slot: number): void;
}

export interface InventoryItem {
  id: string;
  kind: "pickaxe" | "weapon" | "consumable" | "throwable";
  /** Weapon/consumable definition id, e.g. "ar", "pump", "shield-small". */
  def: string;
  name: string;
  rarity: Rarity;
  /** Rounds in the magazine, for weapons. */
  ammo?: number;
  /** Stack size, for consumables/throwables. */
  count?: number;
}

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

/** Canonical rarity colours. Loot beams, item cards and the HUD all use these. */
export const RARITY_COLOR: Record<Rarity, number> = {
  common: 0xb1b1b1,
  uncommon: 0x53d24a,
  rare: 0x4c8bf5,
  epic: 0xb455f0,
  legendary: 0xf2a93b,
};

// ---------------------------------------------------------------- match

export type MatchPhase = "warmup" | "bus" | "dropping" | "live" | "victory" | "eliminated";

/** The closing circle. */
export interface StormService {
  /** Current safe-zone centre + radius. */
  center: THREE.Vector3;
  radius: number;
  /** Where the circle is closing to. */
  nextCenter: THREE.Vector3;
  nextRadius: number;
  /** Seconds until the current phase flips. */
  timer: number;
  /** True while the wall is actively shrinking. */
  closing: boolean;
  /** 1-indexed circle number. */
  circle: number;
  /** Damage per second taken outside the wall right now. */
  dps: number;
  /** True when a point is inside the safe zone. */
  isSafe(point: THREE.Vector3): boolean;
}

/** Phase machine: bus route, drop, alive counts, victory. */
export interface MatchService {
  phase: MatchPhase;
  /** Players still alive, including the local player. */
  alive: number;
  /** Local player's elimination count. */
  eliminations: number;
  /** Placement, set once the player dies or wins. */
  placement: number;
  /** Bus start/end and progress 0..1, for the drop sequence. */
  readonly busFrom: THREE.Vector3;
  readonly busTo: THREE.Vector3;
  busT: number;
  /** Leave the bus. */
  jump(): void;
  /** Called by combat when anyone dies. */
  reportDeath(id: string, by: DamageSource): void;
}

/** Ground loot + chests. */
export interface LootService {
  /** Spawn a pickup at a point. */
  spawn(item: InventoryItem, point: THREE.Vector3): void;
  /** Nearest pickup within range of a point, for the interact prompt. */
  nearest(point: THREE.Vector3, range: number): LootPickup | null;
  take(pickup: LootPickup): void;
}

export interface LootPickup {
  item: InventoryItem;
  object: THREE.Object3D;
  position: THREE.Vector3;
}

// ---------------------------------------------------------------- context

/** Everything a system may reach for. Populated progressively at boot. */
export interface WorldServices {
  materials?: MaterialsService;
  terrain?: TerrainService;
  collision?: CollisionService;
  sky?: SkyService;
  combat?: CombatService;
  vfx?: VfxService;
  audio?: AudioService;
  player?: PlayerService;
  build?: BuildService;
  inventory?: InventoryService;
  storm?: StormService;
  match?: MatchService;
  loot?: LootService;
  /** Named places, registered by the POI system. */
  pois?: Poi[];
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
  /** Build-mode piece hotkeys resolve to this. */
  buildKind: BuildKind | null;
  /** Q — rotate the build preview. Edge-triggered. */
  rotate: boolean;
  /** G — drop the active item. Edge-triggered. */
  drop: boolean;
  /** Edge-triggered: true only on the frame the key went down. */
  pressed: Set<string>;
  /** 1..6 weapon slot, or null. */
  slot: number | null;
  /** Mouse wheel delta this frame. */
  wheel: number;
  /** True while the pointer is locked. */
  locked: boolean;
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
  /**
   * Which game this is. `classic` is Drop Zero — bullets, health, a purple
   * storm. `water` is SPLASH ROYALE — soakers, dryness, and the Downpour.
   *
   * One engine, one island, one set of 22 systems. The difference is a lookup
   * into `mode/water.ts` rather than a fork, because two battle royales would
   * mean every bug fixed twice and every art pass done twice.
   */
  mode: GameMode;
  /** Deterministic RNG so the world regenerates identically. */
  rng: () => number;
  /** Shadow map resolution for this tier. */
  shadowMapSize: number;
  emit(event: string, payload?: unknown): void;
  on(event: string, fn: (payload: unknown) => void): () => void;
}

export type QualityTier = "low" | "medium" | "high" | "ultra";

export type GameMode = "classic" | "water";

/** A subsystem instance. All hooks are optional. */
export interface System {
  name: string;
  /**
   * Deterministic simulation step, called at a hard 120 Hz with leftover time
   * carried in the engine's accumulator. Movement, capsule resolution, build
   * placement and projectiles belong here — all of them misbehave at variable
   * dt, which is how you end up walking through your own wall on a frame
   * spike. Cosmetics belong in `update`.
   */
  fixed?(dt: number, ctx: WorldCtx): void;
  update?(dt: number, ctx: WorldCtx): void;
  /** Called after all systems have updated — camera-dependent work. */
  lateUpdate?(dt: number, ctx: WorldCtx): void;
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
