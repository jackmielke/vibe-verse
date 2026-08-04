/**
 * Vibe Kart — shared contracts.
 *
 * A Mario-Kart-shaped arcade racer. Every subsystem is a `System` that
 * receives the shared `KartCtx`; systems never import each other, they
 * publish and consume through `ctx.services`. Same pattern as Vibe Golf and
 * the San Francisco engine — it is the thing that lets a dozen modules be
 * authored independently without a merge war.
 *
 * Conventions
 * -----------
 * · Units are metres, seconds, radians. +Y is up. Right-handed.
 * · A kart's local forward is **-Z** (Three.js camera convention), local
 *   right is +X. `quaternion` always maps local → world.
 * · Track progress `t` is normalised arc length in [0,1) around the lap.
 * · "lateral" is signed metres from the centreline, +X of the track frame
 *   (i.e. the racer's right when driving forwards).
 */
import type * as THREE from "three";

// ---------------------------------------------------------------------------
// Engine plumbing
// ---------------------------------------------------------------------------

export type KartQuality = "low" | "medium" | "high" | "ultra";

/** Deterministic RNG — every system takes its own stream off `ctx.rng`. */
export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let s = seed >>> 0 || 0x2f6e2b1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

export interface KartInput {
  /** 0..1 throttle. */
  accel: number;
  /** 0..1 brake / reverse. */
  brake: number;
  /** -1 (left) .. +1 (right). */
  steer: number;
  /** Drift / hop button held. */
  drift: boolean;
  /** Drift pressed this frame (edge). */
  driftPressed: boolean;
  /** Use item pressed this frame (edge). */
  itemPressed: boolean;
  /** Aim item backwards (hold). */
  aimBack: boolean;
  /** Look behind (hold). */
  lookBack: boolean;
  /** Trick input during airtime (edge) — direction of the flick. */
  trick: 0 | 1 | -1;
  /** Pause pressed this frame (edge). */
  pausePressed: boolean;
  /** Set when the player is driving from a touchscreen. */
  touch: boolean;
}

export function makeKartInput(): KartInput {
  return {
    accel: 0,
    brake: 0,
    steer: 0,
    drift: false,
    driftPressed: false,
    itemPressed: false,
    aimBack: false,
    lookBack: false,
    trick: 0,
    pausePressed: false,
    touch: false,
  };
}

export interface KartCtx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** Published subsystem handles. Consumers must tolerate `undefined`. */
  services: KartServices;
  input: KartInput;
  /** Seconds since boot, advanced by the engine before systems tick. */
  elapsed: number;
  /** Wall-clock delta of the current frame, already clamped. */
  dt: number;
  quality: KartQuality;
  rng: Rng;
  /** Viewport in CSS pixels. */
  viewport: { width: number; height: number; aspect: number; dpr: number };
  emit: (event: KartEvent | string, payload?: unknown) => void;
  on: (event: KartEvent | string, fn: (payload: never) => void) => () => void;
}

export interface System {
  /** Variable-rate tick, once per frame. */
  update?(dt: number, ctx: KartCtx): void;
  /** Fixed-rate tick (see FIXED_DT). Runs 0..N times per frame. */
  fixedUpdate?(dt: number, ctx: KartCtx): void;
  /** After all updates — cameras, HUD sampling, anything that reads state. */
  lateUpdate?(dt: number, ctx: KartCtx): void;
  resize?(width: number, height: number): void;
  dispose?(): void;
}

export type SystemFactory = (ctx: KartCtx) => System | Promise<System>;

/** Physics runs at a fixed 120 Hz — drift and suspension want it stiff. */
export const FIXED_DT = 1 / 120;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type KartEvent =
  | "race:countdown" // payload: { count: 3|2|1|0 }
  | "race:start"
  | "race:lap" // { racer: number; lap: number; lapTime: number }
  | "race:finish" // { racer: number; place: number; total: number }
  | "race:results" // { standings: Standing[] }
  | "race:respawn" // { racer: number }
  | "kart:drift" // { racer: number; charging: boolean }
  | "kart:miniTurbo" // { racer: number; tier: MiniTurboTier }
  | "kart:boost" // { racer: number; source: BoostSource; duration: number }
  | "kart:trick" // { racer: number }
  | "kart:land" // { racer: number; impact: number }
  | "kart:hit" // { racer: number; by: ItemKind | "wall"; spin: boolean }
  | "kart:offroad" // { racer: number; surface: SurfaceKind }
  | "kart:collide" // { a: number; b: number; impulse: number }
  | "item:roll" // { racer: number; kind: ItemKind }
  | "item:use" // { racer: number; kind: ItemKind }
  | "item:spawn" // { id: number; kind: ItemKind; position: THREE.Vector3 }
  | "item:despawn" // { id: number }
  | "coin:pickup" // { racer: number; coins: number }
  | "ui:pause"
  | "ui:resume"
  | "postfx:override"; // payload: ((dt:number)=>void) | null

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export type SurfaceKind =
  | "road" // tarmac / the fast line
  | "rumble" // painted kerb, mild rattle
  | "boost" // boost pad
  | "dirt" // off-road, slow
  | "grass" // off-road, slower
  | "sand" // off-road, slowest, big particles
  | "water" // shallow water — drag + splash
  | "ice" // low grip
  | "wood" // bridge planks
  | "metal" // grated ramp
  | "antigrav" // anti-gravity plating: wall/ceiling driving
  | "void"; // fell off the world → respawn

export interface SurfaceProps {
  /** Lateral grip multiplier, 1 = tarmac. */
  grip: number;
  /** Top-speed multiplier, 1 = tarmac. */
  speed: number;
  /** Constant rolling deceleration in m/s². */
  drag: number;
  /** Vertical jitter amplitude in metres — kerbs and planks rattle. */
  rattle: number;
  /** Which particle emitter this surface kicks up. */
  spray: "none" | "dust" | "grass" | "sand" | "water" | "sparks";
  /** Respawn the racer on contact. */
  lethal?: boolean;
  /** Free speed while touching (boost panels). */
  boost?: number;
}

export const SURFACES: Record<SurfaceKind, SurfaceProps> = {
  road: { grip: 1.0, speed: 1.0, drag: 0.6, rattle: 0, spray: "none" },
  rumble: { grip: 0.96, speed: 0.99, drag: 1.1, rattle: 0.035, spray: "dust" },
  boost: { grip: 1.0, speed: 1.0, drag: 0.4, rattle: 0, spray: "sparks", boost: 1.0 },
  dirt: { grip: 0.72, speed: 0.62, drag: 5.2, rattle: 0.05, spray: "dust" },
  grass: { grip: 0.66, speed: 0.55, drag: 6.4, rattle: 0.04, spray: "grass" },
  sand: { grip: 0.58, speed: 0.46, drag: 8.0, rattle: 0.03, spray: "sand" },
  water: { grip: 0.8, speed: 0.7, drag: 4.5, rattle: 0.02, spray: "water" },
  ice: { grip: 0.28, speed: 1.0, drag: 0.25, rattle: 0, spray: "none" },
  wood: { grip: 0.94, speed: 0.98, drag: 0.8, rattle: 0.02, spray: "dust" },
  metal: { grip: 1.02, speed: 1.0, drag: 0.6, rattle: 0.01, spray: "sparks" },
  antigrav: { grip: 1.1, speed: 1.04, drag: 0.5, rattle: 0, spray: "sparks" },
  void: { grip: 0, speed: 0, drag: 0, rattle: 0, spray: "none", lethal: true },
};

// ---------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------

/** An orthonormal frame on the centreline: position + road basis. */
export interface TrackFrame {
  /** Normalised arc-length position around the lap, [0,1). */
  t: number;
  /** Centreline point, on the road surface. */
  position: THREE.Vector3;
  /** Unit tangent, direction of travel. */
  forward: THREE.Vector3;
  /** Unit lateral, points to the racer's right. */
  right: THREE.Vector3;
  /** Unit road normal (banking + anti-gravity aware). */
  up: THREE.Vector3;
  /** Half-width of drivable road in metres. */
  halfWidth: number;
  /** Bank angle in radians, + = banked right-side-up into a right turn. */
  bank: number;
  /** Signed curvature 1/m; + turns right. */
  curvature: number;
  /** Grade, dy/ds. */
  grade: number;
}

export interface SurfaceSample {
  /** World height of the surface directly under/over the sample point. */
  height: number;
  /** World-space surface normal. */
  normal: THREE.Vector3;
  kind: SurfaceKind;
  /** True when the sample is on the drivable ribbon (not scenery). */
  onTrack: boolean;
  /** Signed lateral distance from centreline. */
  lateral: number;
  /** Nearest centreline frame. */
  t: number;
}

export interface WallHit {
  /** World point of contact. */
  point: THREE.Vector3;
  /** Unit normal pointing away from the wall, into the road. */
  normal: THREE.Vector3;
  /** Penetration depth in metres. */
  depth: number;
  /** Solid walls stop you; soft ones (hedges) slow you. */
  solid: boolean;
}

export interface ItemBoxSpec {
  position: THREE.Vector3;
  t: number;
  lateral: number;
}

export interface GridSlot {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

/**
 * The track is analytic, not a collision mesh: the ribbon is generated from a
 * spline, so every physics query is a projection onto that spline rather than
 * a BVH raycast. Far cheaper, exactly stable, and it is how the genre has
 * always done it.
 */
export interface TrackService {
  /** Total centreline length in metres. */
  length: number;
  /** Laps in a standard race. */
  laps: number;
  /** Number of checkpoints (used for lap validation + position). */
  checkpointCount: number;
  /** Human-readable course name for the HUD and results screen. */
  name: string;
  /** Frame at normalised arc position `t` (wraps). */
  frameAt(t: number, out?: TrackFrame): TrackFrame;
  /** Nearest centreline position to a world point. `hint` speeds the search. */
  project(position: THREE.Vector3, hint?: number): { t: number; lateral: number; height: number };
  /** Surface under a world point — the workhorse of the suspension raycast. */
  surfaceAt(position: THREE.Vector3, hint?: number, out?: SurfaceSample): SurfaceSample;
  /** Wall/edge query for a sphere of `radius` at `position`. */
  wallAt(position: THREE.Vector3, radius: number, hint?: number): WallHit | null;
  /** Start-line grid slot for a 0-based finishing-order index. */
  gridSlot(index: number): GridSlot;
  /** Respawn pose after falling off, given last valid progress. */
  respawnAt(t: number, lane?: number): GridSlot;
  /** Checkpoint index for a progress value. */
  checkpointOf(t: number): number;
  /** Item box positions, published for the item system to instance. */
  itemBoxes: ItemBoxSpec[];
  /** Coin positions. */
  coins: THREE.Vector3[];
  /** Root of all track visuals (road, scenery, decoration). */
  root: THREE.Object3D;
  /** A good "beauty shot" camera pose, used by the screenshot harness. */
  scenicPose(index: number): { position: THREE.Vector3; lookAt: THREE.Vector3 };
}

// ---------------------------------------------------------------------------
// Racers
// ---------------------------------------------------------------------------

export type MiniTurboTier = 0 | 1 | 2 | 3; // none, blue, orange, purple

export type BoostSource = "miniTurbo" | "pad" | "mushroom" | "start" | "trick" | "slipstream" | "bullet";

export interface RacerState {
  /**
   * Stable id, unique for the life of the race and preserved across respawns
   * and kart swaps. It is **not** a seat number: physics grids the human
   * mid-pack (id 3 on an 8-kart field) so there are rivals to chase and rivals
   * to worry about. Identify the human with `isPlayer` or `physics.player`,
   * never by comparing the id to 0.
   */
  id: number;
  name: string;
  /** Character/kart preset id — the model system keys off this. */
  characterId: string;
  isPlayer: boolean;
  /**
   * Driven over the network by another human. The AI leaves it alone and the
   * integrator does not step it — netplay writes the pose directly.
   */
  remote?: boolean;

  position: THREE.Vector3;
  /** Linear velocity in world space, m/s. */
  velocity: THREE.Vector3;
  /** Body orientation, local -Z forward. */
  quaternion: THREE.Quaternion;
  /** Angular velocity about the body up axis, rad/s. */
  yawRate: number;

  /** Signed forward speed in m/s. */
  speed: number;
  /** Current speed cap after surface/boost/item modifiers, m/s. */
  maxSpeed: number;
  /** Engine RPM 0..1, for audio + exhaust. */
  rpm: number;

  grounded: boolean;
  /** Seconds since the wheels left the ground. */
  airTime: number;
  /** Surface currently under the kart. */
  surface: SurfaceKind;
  /** Surface normal the kart is aligning to. */
  groundNormal: THREE.Vector3;

  drifting: boolean;
  /** -1 left, +1 right, 0 not drifting. */
  driftDir: 0 | 1 | -1;
  /** Charge 0..1 toward the next mini-turbo tier. */
  driftCharge: number;
  driftTier: MiniTurboTier;

  /** Remaining boost seconds. */
  boost: number;
  boostSource: BoostSource | null;
  /** Slipstream accumulation 0..1. */
  draft: number;

  /** Spin-out / squash / stun timer. */
  stun: number;
  stunKind: "spin" | "squash" | "shock" | "bump" | null;
  /** Invulnerability seconds (star, post-respawn). */
  invuln: number;
  /** Star power remaining, seconds. */
  star: number;

  /** Race progress: laps completed + fraction, monotonic. */
  progress: number;
  lap: number;
  checkpoint: number;
  place: number;
  finished: boolean;
  finishTime: number;
  lapTimes: number[];
  coins: number;

  /** Held item, and the roulette state while it is spinning. */
  item: ItemKind | null;
  itemCount: number;
  rolling: boolean;

  /** Per-wheel suspension compression 0..1, FL FR RL RR. */
  wheelCompression: [number, number, number, number];
  /** Per-wheel spin angle, radians. */
  wheelSpin: number;
  /** Visual steering angle of the front wheels, radians. */
  steerAngle: number;
  /** Visual body lean/roll from drift + banking, radians. */
  bodyRoll: number;
  /** Trick animation phase 0..1, 0 = idle. */
  trick: number;

  /** Root object of this racer's visual rig, owned by the model system. */
  object?: THREE.Object3D;
}

export interface PhysicsService {
  racers: RacerState[];
  player: RacerState;
  /** Add a racer at a grid slot. */
  spawn(spec: { id: number; name: string; characterId: string; isPlayer: boolean; slot: number }): RacerState;
  /** Drive a racer this fixed step (AI writes into these before the step). */
  setControls(id: number, controls: { accel: number; brake: number; steer: number; drift: boolean }): void;
  /** Apply a boost. */
  applyBoost(id: number, seconds: number, source: BoostSource): void;
  /** Spin out / squash a racer. */
  applyHit(id: number, kind: "spin" | "squash" | "shock" | "bump", seconds?: number): void;
  /** Launch a racer (springs, ramps, blast waves). */
  applyImpulse(id: number, impulse: THREE.Vector3): void;
  /** Teleport back to the road. */
  respawn(id: number): void;
  /** Frozen during countdown / results. */
  paused: boolean;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export type ItemKind =
  | "banana"
  | "greenShell"
  | "redShell"
  | "blueShell"
  | "mushroom"
  | "tripleMushroom"
  | "star"
  | "bobomb"
  | "lightning"
  | "boo"
  | "bullet"
  | "coin"
  | "fireflower"
  | "blooper";

export interface ItemService {
  /** Roll a new item for a racer based on their place. */
  roll(racerId: number): ItemKind;
  /** Fire the racer's held item. */
  use(racerId: number, aimBack: boolean): void;
  /** Live projectiles/hazards, for the AI to steer around. */
  hazards(): Array<{ id: number; kind: ItemKind; position: THREE.Vector3; ownerId: number }>;
}

export interface Standing {
  id: number;
  name: string;
  place: number;
  finished: boolean;
  time: number;
  lap: number;
  bestLap: number;
}

export type RacePhase = "grid" | "countdown" | "racing" | "finished" | "results";

export interface RaceService {
  phase: RacePhase;
  /** Seconds since the lights went out. */
  time: number;
  countdown: number;
  standings(): Standing[];
  /** Player's live standing shortcut for the HUD. */
  playerStanding(): Standing;
  totalLaps: number;
  start(): void;
  restart(): void;
}

// ---------------------------------------------------------------------------
// Presentation services
// ---------------------------------------------------------------------------

export interface VfxService {
  /** One-shot burst at a world point. */
  burst(kind: VfxBurst, position: THREE.Vector3, normal?: THREE.Vector3, scale?: number): void;
  /** Continuous emitter attached to a racer (drift sparks, exhaust, spray). */
  setRacerEmitters(racer: RacerState): void;
}

export type VfxBurst =
  | "impact"
  | "explosion"
  | "boostFlame"
  | "landing"
  | "splash"
  | "coin"
  | "itemBox"
  | "smokePuff"
  | "shockwave"
  | "confetti";

export interface AudioService {
  /** Positional one-shot. */
  play(id: string, position?: THREE.Vector3, opts?: { volume?: number; rate?: number }): void;
  /** Engine loop follow — called each frame with the player's state. */
  engine(racer: RacerState): void;
  music(track: "menu" | "race" | "finalLap" | "results" | null): void;
  setMuted(muted: boolean): void;
  muted: boolean;
  /** Browsers gate WebAudio behind a gesture; call on the start button. */
  unlock(): void;
}

export interface CameraService {
  mode: "chase" | "chaseFar" | "hood" | "scenic" | "results" | "free";
  /** Point the camera at a racer. */
  follow(racerId: number): void;
  /** Screenshot harness: pose the camera and hold it. */
  pose(position: THREE.Vector3, lookAt: THREE.Vector3): void;
  shake(amount: number, duration?: number): void;
  /** Field of view actually in use this frame (speed-widened). */
  fov: number;
}

export interface PostFxService {
  /** Runtime toggles for the critic harness and the options menu. */
  set(flags: Partial<PostFxFlags>): void;
  flags: PostFxFlags;
  /** Render one frame; installed as the engine's render override. */
  render(dt: number): void;
}

export interface PostFxFlags {
  bloom: boolean;
  motionBlur: boolean;
  dof: boolean;
  ssao: boolean;
  godRays: boolean;
  chromatic: boolean;
  grain: boolean;
  vignette: boolean;
  grade: boolean;
  fxaa: boolean;
  taa: boolean;
  speedLines: boolean;
  exposure: number;
}

export interface EnvironmentService {
  /** Prefiltered environment map for every PBR material in the scene. */
  envMap: THREE.Texture | null;
  /** The key light, so shadows can be re-aimed at the player. */
  sun: THREE.DirectionalLight;
  /** Time of day 0..1 — 0.25 is noon-ish; drives sky, fog and grade. */
  timeOfDay: number;
  sunDirection: THREE.Vector3;
}

export interface ModelsService {
  /** Build the visual rig for a racer; the physics system owns its transform. */
  createRacer(racer: RacerState): THREE.Object3D;
  /** Per-frame pose: wheels, steering, lean, driver animation. */
  poseRacer(racer: RacerState, dt: number): void;
  /** Character roster for the select screen. */
  roster: CharacterPreset[];
}

export interface CharacterPreset {
  id: string;
  name: string;
  /** Marketing blurb for the select screen. */
  blurb: string;
  /** Weight class drives collisions and top speed. */
  weight: "feather" | "light" | "medium" | "cruiser" | "heavy";
  /** Base stats 1..10, Mario-Kart style. */
  stats: { speed: number; accel: number; handling: number; traction: number; weight: number };
  /** Primary + secondary body colours. */
  colors: { body: number; accent: number; trim: number };
  /** Driver palette. */
  driver: { skin: number; outfit: number; hat: number };
}

export interface MinimapService {
  /** Normalised [0,1]² track-space position for a world point. */
  toMinimap(position: THREE.Vector3): { x: number; y: number };
  /** Baked SVG path of the centreline, for the HUD to draw. */
  path: string;
}

export interface KartServices {
  track?: TrackService;
  physics?: PhysicsService;
  items?: ItemService;
  race?: RaceService;
  vfx?: VfxService;
  audio?: AudioService;
  camera?: CameraService;
  postfx?: PostFxService;
  env?: EnvironmentService;
  models?: ModelsService;
  minimap?: MinimapService;
  /** Anything else a system wants to publish. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Tuning — one table so the feel can be balanced in a single place
// ---------------------------------------------------------------------------

export const TUNING = {
  /** Top speed on tarmac, m/s (≈ 100 km/h at 150cc). */
  topSpeed: 28,
  reverseSpeed: 9,
  /** Time to reach top speed, seconds. */
  accelTime: 2.6,
  brakeDecel: 22,
  coastDecel: 3.2,
  /** Steering rate at low speed, rad/s, and its falloff with speed. */
  steerRate: 2.5,
  steerSpeedFalloff: 0.55,
  /** Drift steer authority range: [inner, outer] rad/s. */
  driftSteerInner: 1.5,
  driftSteerOuter: 3.4,
  /** Mini-turbo charge times in seconds for blue / orange / purple. */
  miniTurboTimes: [0.85, 1.7, 2.9] as const,
  /** Mini-turbo boost durations, seconds. */
  miniTurboBoost: [0, 0.55, 1.05, 1.65] as const,
  /** Boost speed multiplier and acceleration while boosting. */
  boostSpeedMul: 1.45,
  boostAccel: 42,
  /** Gravity, m/s². Arcade-heavy so jumps land fast. */
  gravity: 26,
  /** Suspension: rest length, stiffness, damping. */
  suspensionRest: 0.42,
  suspensionStiffness: 140,
  suspensionDamping: 9.5,
  /** Kart body half-extents, metres. */
  kartHalf: { x: 0.62, y: 0.36, z: 0.95 },
  wheelRadius: 0.34,
  /** Collision radius used against walls and other karts. */
  collisionRadius: 0.95,
  /** Slipstream: distance behind a rival and the boost it grants. */
  draftDistance: 14,
  draftChargeTime: 1.6,
  draftBoost: 0.9,
  /** Rubber-banding for AI, as a fraction of top speed. */
  aiCatchup: 0.12,
  aiFallback: 0.07,
  /** Number of racers on the grid, including the player. */
  fieldSize: 8,
  /** Star power duration. */
  starTime: 7.5,
  /** Spin-out duration. */
  spinTime: 1.35,
} as const;

/** Colour identity of the game — used by HUD, grade and menus alike. */
export const PALETTE = {
  sky: 0x5fc7f5,
  sun: 0xfff3d6,
  road: 0x3b3f4a,
  kerbA: 0xf24b4b,
  kerbB: 0xfefefe,
  grass: 0x54b04a,
  sand: 0xe8d18a,
  water: 0x2e93d9,
  accent: 0xffcc22,
  hudInk: 0x0d1420,
} as const;
