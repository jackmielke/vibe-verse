/**
 * Shared vocabulary for THE FINAL FRONTIER.
 *
 * Two scenes, two cameras, and that split is the whole design. `space` holds
 * the starfield, the ships and everything that shoots; `bridge` holds a room
 * with six people in it. The room never moves. What sells the fiction is that
 * the biggest object in the room is a rectangle showing a *live render of the
 * other scene* — so when Sulu answers the helm the stars really do swing, and
 * the torpedo you just ordered really is the one that hits.
 *
 * Systems never import one another. They publish into `ctx.services` and read
 * what they need from there, which is what lets the bridge be rebuilt without
 * touching the combat model, and lets any one of them fail at boot without
 * taking the episode down with it.
 */
import * as THREE from "three";

export type Quality = "low" | "medium" | "high" | "ultra";

/** Ship dynamics run at a fixed 60 Hz. */
export const FIXED_DT = 1 / 60;

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

/**
 * One unit is one metre, and the numbers below are the real ones off the
 * plans: a Constitution-class starship is 289 m long with a 141 m saucer.
 *
 * That matters for more than pedantry. Engagement ranges in Star Trek are
 * always described in kilometres and always *look* like a few ship-lengths,
 * because that is the only way both ships fit in the same shot. So combat here
 * happens between 400 m and 25 km, the viewscreen has a magnification factor
 * to reconcile the two, and "range 3,000 kilometres" in the dialogue is
 * spoken, not measured. The show did exactly this.
 */
export const SHIP_LENGTH = 289;
/**
 * A 5 m near plane and a 4,000 km far plane.
 *
 * That is an 800,000:1 range on a plain 24-bit buffer, which sounds like the
 * classic recipe for a planet that z-fights with its own cloud deck — and it
 * would be, except that nothing in this world lives in the middle distance.
 * Ships are between 300 m and 25 km out, where the precision is centimetres;
 * the planet and the star are past 60 km, where nothing else is competing for
 * depth. The gap between those two bands is what buys the range, and it is
 * why this world does *not* pay for a logarithmic depth buffer — which would
 * otherwise have to be threaded through every hand-written shader here.
 */
export const NEAR_PLANE = 5;
export const FAR_PLANE = 4e6;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * One frame of the captain's intent.
 *
 * Note what is *not* here: there is no aim. You do not aim a starship. You
 * order a heading and a target and the crew does the rest, which is both the
 * canon and, it turns out, a better game — it puts the tension in choosing
 * when to fire rather than in mouse precision.
 */
export interface TrekInput {
  /** -1 port .. +1 starboard. */
  yaw: number;
  /** -1 down .. +1 up. */
  pitch: number;
  /** -1 roll port .. +1 roll starboard. */
  roll: number;
  /** 0 .. 1 impulse throttle. */
  throttle: number;

  /** Head rotation from the centre seat, radians. */
  lookYaw: number;
  lookPitch: number;

  /** Held: phasers fire continuously while the button is down. */
  firePhasers: boolean;

  // Edge-triggered orders. Consumed and cleared once per frame.
  fireTorpedo: boolean;
  nextTarget: boolean;
  toggleAlert: boolean;
  evasive: boolean;
  cycleCamera: boolean;
  cycleMagnification: boolean;
  hail: boolean;
  /**
   * The other verb.
   *
   * Every other order in this list is about moving the ship or shooting
   * something with it. This one is about *looking*, and it is the one that
   * makes the game Star Trek rather than a submarine sim with better lighting:
   * there are problems out here that a full spread of photon torpedoes makes
   * strictly worse, and you find them by asking Mr Spock what he sees.
   */
  scan: boolean;
  allStop: boolean;
  warp: boolean;
  /** 0 = engines, 1 = shields, 2 = weapons. -1 = nothing asked for. */
  powerTo: number;
  advance: boolean;

  touch: boolean;
}

export function makeInput(): TrekInput {
  return {
    yaw: 0,
    pitch: 0,
    roll: 0,
    throttle: 0.25,
    lookYaw: 0,
    lookPitch: 0,
    firePhasers: false,
    fireTorpedo: false,
    nextTarget: false,
    toggleAlert: false,
    evasive: false,
    cycleCamera: false,
    cycleMagnification: false,
    hail: false,
    scan: false,
    allStop: false,
    warp: false,
    powerTo: -1,
    advance: false,
    touch: false,
  };
}

// ---------------------------------------------------------------------------
// Ships
// ---------------------------------------------------------------------------

/**
 * `creature` is not a faction and does not want anything from you. It is here
 * so that a living thing can be *targetable* without being an enemy — which is
 * the whole tension of the episode it appears in.
 */
export type Allegiance = "starfleet" | "klingon" | "romulan" | "neutral" | "machine" | "creature";

export type HullClass =
  | "constitution"
  | "miranda"
  | "d7"
  | "birdOfPrey"
  | "freighter"
  | "planetKiller"
  | "creature"
  | "shuttle";

/** Fore, aft, port, starboard — the four the show actually names. */
export type ShieldFacing = 0 | 1 | 2 | 3;
export const FACING_NAMES = ["forward", "aft", "port", "starboard"] as const;

export interface ShipSystems {
  warp: number;
  impulse: number;
  phasers: number;
  torpedoes: number;
  sensors: number;
  shields: number;
  lifeSupport: number;
}

export interface Ship {
  id: number;
  name: string;
  registry: string;
  hull: HullClass;
  allegiance: Allegiance;
  object: THREE.Object3D;

  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  /** Rad/s about the ship's own axes. */
  angular: THREE.Vector3;

  /** 0..1 of maximum impulse. */
  throttle: number;
  maxSpeed: number;
  agility: number;
  mass: number;

  /** 0..1 per facing. */
  shields: number[];
  shieldsUp: boolean;
  shieldRegen: number;
  /** 0..1. At zero the ship is gone. */
  hull_: number;
  maxHull: number;
  systems: ShipSystems;

  /** Seconds until each weapon may fire again. */
  phaserCooldown: number;
  torpedoCooldown: number;
  torpedoes: number;
  /** Beam power drawn down by sustained fire, 0..1. */
  phaserCharge: number;

  cloaked: boolean;
  /** 0 = fully visible, 1 = fully cloaked. Decloaking takes time, which is the game. */
  cloakLevel: number;
  canCloak: boolean;

  targetId: number | null;
  alive: boolean;
  /** Set the frame the ship dies, so the wreck can burn before it is removed. */
  dyingFor: number;
  /** AI personality knobs; absent on the player. */
  ai?: ShipAI;
  /** Radius used for hit tests and collision avoidance. */
  radius: number;
  /** Faded in by the mission script for a dramatic arrival. */
  arriving: number;
}

export interface ShipAI {
  aggression: number;
  skill: number;
  /** Seconds until the AI re-decides what it is doing. */
  think: number;
  state: "approach" | "attack" | "break" | "flee" | "hold" | "cloak";
  /** Where this ship wants to be, relative to its target. */
  offset: THREE.Vector3;
  /** Romulans decloak, fire, and vanish. This is the timer for that cycle. */
  cloakTimer: number;
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export type AlertLevel = "normal" | "yellow" | "red";

export interface CrewLine {
  /** Which officer is talking. Drives the voice and the colour of the caption. */
  who: string;
  text: string;
  /** Seconds the caption stays up. */
  hold: number;
  /** Low-priority chatter is dropped if something important is queued. */
  priority: number;
}

export interface AudioService {
  unlock(): void;
  cue(name: string, opts?: { gain?: number; rate?: number; detune?: number }): void;
  /** Start/stop the looping red-alert klaxon. */
  setAlert(level: AlertLevel): void;
  /** The phaser beam is a sustained sound, not a one-shot. */
  setPhaserBeam(on: boolean): void;
  speak(line: CrewLine): void;
  setMuted(m: boolean): void;
  setVoices(on: boolean): void;
  muted: boolean;
  voices: boolean;
}

export interface FleetService {
  ships: Ship[];
  player: Ship;
  spawn(spec: SpawnSpec): Ship;
  remove(ship: Ship): void;
  byId(id: number): Ship | undefined;
  hostilesOf(ship: Ship): Ship[];
  /** Apply a hit, routed through the correct shield facing. Returns damage dealt to hull. */
  damage(ship: Ship, amount: number, from: THREE.Vector3, kind: "beam" | "torpedo" | "collision"): number;
  clearAll(): void;
}

export interface SpawnSpec {
  name: string;
  registry?: string;
  hull: HullClass;
  allegiance: Allegiance;
  position: THREE.Vector3;
  lookAt?: THREE.Vector3;
  ai?: Partial<ShipAI>;
  torpedoes?: number;
  hullStrength?: number;
  canCloak?: boolean;
  cloaked?: boolean;
  isPlayer?: boolean;
  arriving?: number;
}

export interface WeaponsService {
  firePhasers(from: Ship, target: Ship): boolean;
  fireTorpedo(from: Ship, target: Ship): boolean;
  explode(at: THREE.Vector3, size: number, colour?: number): void;
  /** The planet killer's antiproton beam — a different animal to a phaser. */
  fireAntiproton(from: Ship, at: THREE.Vector3): void;
}

export type CameraMode = "viewscreen" | "chase" | "orbit" | "tactical" | "free";

export interface CameraService {
  mode: CameraMode;
  setMode(m: CameraMode): void;
  cycle(): CameraMode;
  /** Viewscreen magnification: 1x, 4x, 12x. */
  magnification: number;
  cycleMagnification(): number;
  shake(amount: number): void;
  /** For the screenshot harness. */
  pose(from: THREE.Vector3, to: THREE.Vector3): void;
  release(): void;
}

export interface ViewscreenService {
  target: THREE.WebGLRenderTarget;
  /** Static, ripple and blackout when the screen takes a hit. */
  disrupt(amount: number): void;
  /** A face fills the screen: hostile hails and Starfleet Command. */
  showComm(who: string | null): void;
}

export interface BridgeService {
  /** Where the captain's eyes are, in bridge-scene space. */
  eyePosition: THREE.Vector3;
  setAlert(level: AlertLevel): void;
  /** Lights flicker and consoles blow when the ship is hit hard. */
  jolt(amount: number): void;
}

export interface GameService {
  alert: AlertLevel;
  /** Fractions of total power. Sums to 1. */
  power: { engines: number; shields: number; weapons: number };
  targetId: number | null;
  mission: number;
  /** How many episodes there are. Read by the playthrough harness. */
  missionCount: number;
  missionTitle: string;
  stardate: string;
  objective: string;
  status: "briefing" | "playing" | "won" | "lost" | "complete";
  /** `ctx.elapsed` until which the helm is flying evasive. Gunners hate it. */
  evasiveUntil: number;
  /** Called by the UI's continue button. */
  advance(): void;
  restart(): void;
  /** Load a specific episode. The only authoritative way to change `mission`. */
  goto(index: number): void;
  say(line: Partial<CrewLine> & { who: string; text: string }): void;
}

export interface Services {
  audio?: AudioService;
  fleet?: FleetService;
  weapons?: WeaponsService;
  camera?: CameraService;
  viewscreen?: ViewscreenService;
  bridge?: BridgeService;
  game?: GameService;
  space?: SpaceService;
  [key: string]: unknown;
}

export interface SpaceService {
  /** Swap the backdrop between episodes: open space, a nebula, a planet. */
  setScene(name: SpaceSceneName): void;
  /** 0..1 — how blind sensors are here. The Mutara Nebula is 1. */
  interference: number;
  sunDirection: THREE.Vector3;
}

export type SpaceSceneName =
  | "spacedock"
  | "neutralZone"
  | "colony"
  | "janus"
  | "l374"
  | "mutara"
  | "deepSpace";

// ---------------------------------------------------------------------------
// Context and systems
// ---------------------------------------------------------------------------

export interface Viewport {
  width: number;
  height: number;
  aspect: number;
  dpr: number;
  portrait: boolean;
}

export interface TrekCtx {
  renderer: THREE.WebGLRenderer;
  /** Everything outside the hull. */
  space: THREE.Scene;
  /** The room. */
  bridge: THREE.Scene;
  /** Renders `space` — into the viewscreen in bridge mode, to the canvas otherwise. */
  viewCam: THREE.PerspectiveCamera;
  /** The captain's eyes. Renders `bridge`. */
  eyeCam: THREE.PerspectiveCamera;
  services: Services;
  input: TrekInput;
  elapsed: number;
  dt: number;
  quality: Quality;
  rng: Rng;
  viewport: Viewport;
  emit(event: string, payload?: unknown): void;
  on(event: string, fn: (payload: never) => void): () => void;
}

export interface System {
  update?(dt: number, ctx: TrekCtx): void;
  fixedUpdate?(dt: number, ctx: TrekCtx): void;
  lateUpdate?(dt: number, ctx: TrekCtx): void;
  resize?(width: number, height: number, portrait: boolean): void;
  dispose?(): void;
}

export type SystemFactory = (ctx: TrekCtx) => System | Promise<System>;

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

export interface Rng {
  next(): number;
  range(min: number, max: number): number;
  int(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  gauss(): number;
  fork(salt: number): Rng;
}

/** mulberry32 — small, fast, and the same panel blinks the same way every boot. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length) % items.length],
    gauss: () => (next() + next() + next() - 1.5) * 1.1547,
    fork: (salt) => makeRng((seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0),
  };
}

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------

/**
 * Colours taken off the show rather than off memory, which are different
 * things — the bridge everyone remembers as "grey" is a warm sand, and the
 * railing everyone remembers as "red" is closer to a dark coral. Getting those
 * two wrong makes a room that is unmistakably not the Enterprise even when
 * every shape is right.
 */
export const PALETTE = {
  // The room.
  bulkhead: 0x9c8f79,
  bulkheadDark: 0x6f6555,
  railing: 0xa8382c,
  deck: 0x2c2c30,
  // Near-black, but not black. A true 0x14 console under this room's low key
  // light renders as a hole punched in the set — and there are eleven of them
  // in shot at any moment.
  consoleBody: 0x2a2a33,
  consoleTrim: 0x8a8172,
  screenBezel: 0xb99b5e,

  // Uniforms. TOS: command gold, sciences blue, operations red.
  tunicGold: 0xc9a227,
  tunicBlue: 0x4a7ba8,
  tunicRed: 0xa8352a,
  trousers: 0x1a1a20,
  skinLight: 0xd9a887,
  skinVulcan: 0xd8b498,
  skinDark: 0x8a5a3c,

  // The ship.
  hullLight: 0xc3c8cc,
  hullShadow: 0x8d949c,
  hullAccent: 0x6f7d8c,
  nacelleGrille: 0x3f8cff,
  bussard: 0xff5a2a,
  deflector: 0xffb15c,
  window: 0xffe7bd,

  // Adversaries.
  klingonHull: 0x6a7568,
  klingonAccent: 0x3f4a3e,
  romulanHull: 0x6d7a74,
  romulanAccent: 0x2f4f45,
  machineHull: 0x4a453f,
  machineMaw: 0xfff0c0,

  // Ordnance.
  phaser: 0xff8a2b,
  phaserCore: 0xffe0b0,
  torpedo: 0xff3f2a,
  disruptor: 0x7dff5a,
  plasma: 0x6effc8,

  // Signal.
  alertRed: 0xff2b1a,
  alertYellow: 0xffc21a,
  hudAmber: 0xffb648,
  hudBlue: 0x7fd8ff,
  hudGreen: 0x6dffa8,
} as const;

/** The jelly-bean buttons. Every TOS console is these seven colours. */
export const BUTTON_COLOURS = [
  "#ff4a3d",
  "#ff9a2e",
  "#ffe94a",
  "#52d669",
  "#4aa8ff",
  "#b47aff",
  "#f2f2f2",
] as const;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}
