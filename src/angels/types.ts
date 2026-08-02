/**
 * Shared vocabulary for the Blue Angels world.
 *
 * Every system gets the same `AngelsCtx` and publishes what it wants others to
 * see into `ctx.services`. Systems never import one another — that rule is what
 * lets the terrain be rewritten without touching the jets, and what lets any
 * one of them fail at boot without taking the world down.
 */
import * as THREE from "three";

export type Quality = "low" | "medium" | "high" | "ultra";

/** Physics runs at a fixed 120 Hz. A flight model integrated at frame rate is a different aircraft on every device. */
export const FIXED_DT = 1 / 120;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type InputSource = "keyboard" | "gamepad" | "touch";

/**
 * One frame of pilot intent, whatever device produced it.
 *
 * The axes are *commands*, not device positions: a keyboard ramps toward ±1, a
 * thumbstick reads straight through, a phone's virtual stick gets a deadzone
 * and an expo curve. By the time the flight model sees this it cannot tell
 * which one it was, which is the entire point.
 */
export interface AngelsInput {
  /** -1 push .. +1 pull. */
  pitch: number;
  /** -1 left .. +1 right. */
  roll: number;
  /** -1 left .. +1 right rudder. */
  yaw: number;
  /** 0 .. 1 absolute throttle lever position. */
  throttle: number;
  /** 0 .. 1 speedbrake. */
  brake: number;
  /** 0 .. 1 wheel brakes. */
  wheelBrake: number;

  /** Free-look offsets in radians, for the padlock/cockpit cameras. */
  lookX: number;
  lookY: number;
  looking: boolean;

  // Edge-triggered. Consumed and cleared once per frame by the engine.
  gearToggle: boolean;
  smokeToggle: boolean;
  viewPressed: boolean;
  pausePressed: boolean;
  resetPressed: boolean;
  photoPressed: boolean;

  /** Which device most recently did something. Drives the on-screen prompts. */
  source: InputSource;
  /** True once a finger has actually touched the screen. */
  touch: boolean;
}

export function makeInput(): AngelsInput {
  return {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: 0.75,
    brake: 0,
    wheelBrake: 0,
    lookX: 0,
    lookY: 0,
    looking: false,
    gearToggle: false,
    smokeToggle: false,
    viewPressed: false,
    pausePressed: false,
    resetPressed: false,
    photoPressed: false,
    source: "keyboard",
    touch: false,
  };
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/** The ground, as far as anything that is not the terrain mesh needs it. */
export interface TerrainService {
  /** Ground or lake-bed height at a world XZ, metres above sea level. */
  heightAt(x: number, z: number): number;
  /** Height of whatever you would hit — water surface counts as solid. */
  surfaceAt(x: number, z: number): number;
  /** True if this XZ is under Puget Sound, Lake Washington, or Lake Union. */
  isWater(x: number, z: number): boolean;
  /** Half-extent of the modelled world, metres. */
  extent: number;
}

export interface SkyService {
  sunDirection: THREE.Vector3;
  /** 0 .. 1 across the day. */
  timeOfDay: number;
  setTimeOfDay(t: number): void;
  envMap: THREE.Texture | null;
}

/** Anything with three numbers on it. The harness passes plain objects. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export type CameraMode = "chase" | "cockpit" | "wing" | "tower" | "cinematic" | "free";

export interface CameraService {
  mode: CameraMode;
  setMode(mode: CameraMode, opts?: { snap?: boolean }): void;
  cycle(): CameraMode;
  /** Add camera shake. 0..1, decays quadratically. */
  shake(amount: number): void;
  /** Park the camera for the screenshot harness. Any {x,y,z} will do. */
  pose(position: Vec3Like, lookAt: Vec3Like): void;
  /** Hand the camera back to whichever rig is selected. */
  release(): void;
}

export interface AudioService {
  unlock(): void;
  cue(name: string, opts?: { gain?: number; rate?: number }): void;
  setMuted(muted: boolean): void;
  muted: boolean;
}

export interface Services {
  terrain?: TerrainService;
  sky?: SkyService;
  camera?: CameraService;
  audio?: AudioService;
  fleet?: unknown;
  game?: unknown;
  hoops?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Context and systems
// ---------------------------------------------------------------------------

export interface Viewport {
  width: number;
  height: number;
  aspect: number;
  dpr: number;
  /** True when the window is taller than it is wide. */
  portrait: boolean;
}

export interface AngelsCtx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  services: Services;
  input: AngelsInput;
  /** Seconds since boot. */
  elapsed: number;
  /** Last frame's delta, already clamped. */
  dt: number;
  quality: Quality;
  rng: Rng;
  viewport: Viewport;
  emit(event: string, payload?: unknown): void;
  on(event: string, fn: (payload: never) => void): () => void;
}

export interface System {
  /** Variable-rate tick, once per frame. */
  update?(dt: number, ctx: AngelsCtx): void;
  /** Fixed 120 Hz tick. Runs 0..N times per frame. The flight model lives here. */
  fixedUpdate?(dt: number, ctx: AngelsCtx): void;
  /** After every update — cameras, HUD sampling, anything that reads state. */
  lateUpdate?(dt: number, ctx: AngelsCtx): void;
  resize?(width: number, height: number, portrait: boolean): void;
  dispose?(): void;
}

export type SystemFactory = (ctx: AngelsCtx) => System | Promise<System>;

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

export interface Rng {
  next(): number;
  range(min: number, max: number): number;
  int(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** A gaussian-ish sample, mean 0, sd 1. Three uniforms is close enough. */
  gauss(): number;
  fork(salt: number): Rng;
}

/** mulberry32. Small, fast, and good enough that the city looks unplanned. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length) % items.length],
    gauss: () => (next() + next() + next() - 1.5) * 1.1547,
    fork: (salt) => makeRng((seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0),
  };
  return rng;
}

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------

/**
 * The team's colours, measured off the jets rather than guessed.
 *
 * The blue is Navy Insignia Blue — much deeper than the "royal blue" people
 * remember, almost navy in shadow — and the yellow is a saturated golden
 * yellow, not orange. Getting the ratio right matters more than either hex:
 * the jet is overwhelmingly blue with yellow only on the nose flash, the
 * tail, the numbers and the wing leading edges.
 */
export const PALETTE = {
  // Nominally FS 15050 Insignia Blue, which is about #0B1B3E on a paint chip.
  // Painted straight in, that value renders as black: a chip is measured under
  // a light, and this number is an albedo that then gets multiplied by one.
  // What the jets actually *photograph* as in sun is around #1C3A70, and that
  // is what belongs here.
  angelBlue: 0x1f3f7d,
  angelBlueLit: 0x2b53a0,
  angelYellow: 0xffc728,
  angelYellowDeep: 0xe8a800,
  canopy: 0x1c2a3a,
  metal: 0x8d97a5,
  nozzle: 0x3a3f47,
  /** HUD green, the classic phosphor. */
  hud: 0x7dffb0,
  hudWarn: 0xffcc33,
  hudDanger: 0xff4d4d,
} as const;
