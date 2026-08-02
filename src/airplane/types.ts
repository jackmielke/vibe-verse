/**
 * Shared vocabulary for Trans American Flight 209.
 *
 * Same contract the Blue Angels world uses, and for the same reason: every
 * system gets one `PlaneCtx`, publishes what it wants others to see into
 * `ctx.services`, and never imports another system. That is what lets the
 * cockpit be rebuilt without touching the flight model, and what lets the
 * audio fail at boot without taking the flight down with it.
 */
import * as THREE from "three";

export type Quality = "low" | "medium" | "high" | "ultra";

/** The flight model integrates at a fixed 120 Hz. Frame-rate physics is a different aeroplane on every device. */
export const FIXED_DT = 1 / 120;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type InputSource = "keyboard" | "gamepad" | "touch";

/**
 * One frame of pilot intent, whatever produced it.
 *
 * Note what this is *not*: a fly-by-wire command. A 707 has cables and a
 * hydraulic boost pack, and the yoke moves a control surface — so `pitch` here
 * is elevator deflection, not a G command, and holding it does not hold an
 * attitude. That is the whole reason the aeroplane wanders when you stop
 * paying attention to it, which is the thing this game is about.
 */
export interface PlaneInput {
  /** -1 yoke full forward .. +1 yoke full aft. Elevator. */
  pitch: number;
  /** -1 wheel left .. +1 wheel right. Ailerons + spoilers. */
  roll: number;
  /** -1 left .. +1 right rudder pedal. */
  yaw: number;
  /** 0 .. 1 absolute thrust-lever position, all four together. */
  throttle: number;
  /** 0 .. 1 wheel brakes. */
  wheelBrake: number;
  /** 0 .. 1 speedbrake / spoiler lever. */
  speedbrake: number;

  /** Free-look offsets in radians — you can look around the flight deck. */
  lookX: number;
  lookY: number;
  looking: boolean;

  // Edge-triggered. Consumed and cleared once per frame by the engine.
  gearToggle: boolean;
  flapsUp: boolean;
  flapsDown: boolean;
  autopilotToggle: boolean;
  viewPressed: boolean;
  pausePressed: boolean;
  /** Space — "say the thing". Answers the radio, acknowledges a crisis. */
  actionPressed: boolean;
  /** 1..4 — the cabin choices. -1 when nothing was pressed. */
  choicePressed: number;

  source: InputSource;
  touch: boolean;
}

export function makeInput(): PlaneInput {
  return {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: 0.72,
    wheelBrake: 0,
    speedbrake: 0,
    lookX: 0,
    lookY: 0,
    looking: false,
    gearToggle: false,
    flapsUp: false,
    flapsDown: false,
    autopilotToggle: false,
    viewPressed: false,
    pausePressed: false,
    actionPressed: false,
    choicePressed: -1,
    source: "keyboard",
    touch: false,
  };
}

export function clearEdges(input: PlaneInput): void {
  input.gearToggle = false;
  input.flapsUp = false;
  input.flapsDown = false;
  input.autopilotToggle = false;
  input.viewPressed = false;
  input.pausePressed = false;
  input.actionPressed = false;
  input.choicePressed = -1;
  input.lookX = 0;
  input.lookY = 0;
}

// ---------------------------------------------------------------------------
// The aeroplane, as everything outside the flight model sees it
// ---------------------------------------------------------------------------

/** Where the gear lever is, and how far the legs have actually got. */
export interface GearState {
  /** Commanded: true = down. */
  down: boolean;
  /** 0 = up and locked, 1 = down and locked. Takes ~10 s either way. */
  position: number;
}

export interface FlightState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Body-frame angular rates, rad/s: pitch, roll, yaw. */
  omega: THREE.Vector3;
  orientation: THREE.Quaternion;

  /** Metres above mean sea level. */
  altitude: number;
  /** Metres above the ground directly below. */
  radarAltitude: number;
  /** True airspeed, m/s. */
  tas: number;
  /** Indicated airspeed, m/s — the number on the dial and the one that stalls. */
  ias: number;
  /** Ground speed, m/s. */
  groundSpeed: number;
  /** Rate of climb, m/s. Positive up. */
  vs: number;
  /** Radians. 0 = north, increasing clockwise. */
  heading: number;
  pitchAngle: number;
  bankAngle: number;
  /** Angle of attack, radians. */
  alpha: number;
  /** Sideslip, radians. */
  beta: number;
  /** Load factor, g. */
  g: number;

  /** 0..1 per engine. Four of them, and they can fail independently. */
  n1: [number, number, number, number];
  engineOut: [boolean, boolean, boolean, boolean];
  /** Commanded thrust lever, 0..1. */
  throttle: number;

  /** Flap detent index into `FLAP_DETENTS`. */
  flapIndex: number;
  /** Actual flap angle in degrees — the lever moves faster than the flaps. */
  flapAngle: number;
  gear: GearState;
  speedbrake: number;

  /** Kilograms of fuel remaining. */
  fuel: number;

  onGround: boolean;
  /** True when the wing is at or past the stall. */
  stalled: boolean;
  /** 0..1 — how close to the stall. Drives the stick shaker. */
  stallMargin: number;
  /** True while the airframe is being overstressed or overspeed. */
  overspeed: boolean;
  /** Accumulated structural damage, 0..1. At 1 something comes off. */
  damage: number;

  /** True once the wheels have touched and stayed down. */
  landed: boolean;
  /** Vertical speed at the instant of touchdown, m/s. Negative is down. */
  touchdownVs: number;
  /** Where along the runway the wheels first touched, metres from threshold. */
  touchdownX: number;
  /** Lateral offset from the centreline at touchdown, metres. */
  touchdownOffset: number;
  /** True if an outboard engine pod touched the runway on landing. */
  podStrike: boolean;
  crashed: boolean;
  crashReason: string;
}

export interface AutopilotState {
  /** Otto is engaged. */
  engaged: boolean;
  /** Otto's target altitude, metres. */
  targetAltitude: number;
  /** Otto's target heading, radians. */
  targetHeading: number;
  /** Otto's target indicated airspeed, m/s. */
  targetIas: number;
  /** Otto is chasing the ILS rather than a heading. */
  approachMode: boolean;
  /** 0..1 — how inflated Otto is. Below 0.35 he cannot hold anything. */
  inflation: number;
}

export interface FlightService {
  state: FlightState;
  autopilot: AutopilotState;
  /** The aeroplane's transform, for anything that needs to hang off it. */
  object: THREE.Object3D;
  /** Put the aeroplane somewhere. Used by the intro and the shot harness. */
  place(opts: {
    position: THREE.Vector3;
    heading: number;
    ias: number;
    flapIndex?: number;
    gearDown?: boolean;
  }): void;
  /** Add an upset — turbulence, a slap, a passenger stampede. */
  gust(pitch: number, roll: number, yaw: number): void;
  /** Fail an engine. The movie never does this; the storm does. */
  failEngine(index: number): void;
  /** Instantaneous stall speed at this weight and configuration, m/s IAS. */
  stallSpeed(): number;
  /** The speed the approach should be flown at, m/s IAS. */
  vref(): number;
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface GroundService {
  /** Terrain elevation at a world XZ, metres above sea level. */
  heightAt(x: number, z: number): number;
  /** True if this XZ is over Lake Michigan. */
  isWater(x: number, z: number): boolean;
  extent: number;
}

export interface SkyService {
  /** 0..1 how hard it is raining right now. */
  rain: number;
  /** 0..1 general storm intensity. Drives turbulence and lightning. */
  storm: number;
  setStorm(v: number): void;
  /** Fire a lightning flash near the aeroplane. */
  strike(intensity?: number): void;
  /** Cloud base and tops, metres MSL. You break out at `base`. */
  cloudBase: number;
  cloudTops: number;
}

export type CameraMode = "cockpit" | "chase" | "cabin" | "wing" | "tower";

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface CameraService {
  mode: CameraMode;
  setMode(mode: CameraMode, opts?: { snap?: boolean }): void;
  cycle(): CameraMode;
  shake(amount: number): void;
  /** Park the camera. Any {x,y,z} will do — the shot harness passes plain objects. */
  pose(position: Vec3Like, lookAt: Vec3Like): void;
  release(): void;
  /** True when the lens is inside the flight deck, so the deck must be drawn. */
  readonly inCockpit: boolean;
}

export interface AudioService {
  unlock(): void;
  cue(name: string, opts?: { gain?: number; rate?: number; pan?: number }): void;
  /** Speak a line — a synthesised radio blip train, not real speech. */
  say(voice: string, syllables: number): void;
  setMuted(muted: boolean): void;
  muted: boolean;
}

export interface Services {
  ground?: GroundService;
  sky?: SkyService;
  camera?: CameraService;
  audio?: AudioService;
  flight?: FlightService;
  cockpit?: unknown;
  game?: unknown;
  crises?: unknown;
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
  portrait: boolean;
}

export interface PlaneCtx {
  scene: THREE.Scene;
  /** The world camera. Near 1 m, far 60 km. */
  camera: THREE.PerspectiveCamera;
  /**
   * The cockpit camera. Same position and orientation as `camera`, near plane
   * at 3 cm — the panel is 70 cm from your eyes and the runway is 8 km away,
   * and no depth buffer covers both. The two are rendered as separate passes.
   */
  cockpitCamera: THREE.PerspectiveCamera;
  /** Everything drawn by the cockpit pass hangs off this. */
  cockpitScene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  services: Services;
  input: PlaneInput;
  elapsed: number;
  dt: number;
  quality: Quality;
  rng: Rng;
  viewport: Viewport;
  emit(event: string, payload?: unknown): void;
  on(event: string, fn: (payload: never) => void): () => void;
}

export interface System {
  update?(dt: number, ctx: PlaneCtx): void;
  fixedUpdate?(dt: number, ctx: PlaneCtx): void;
  lateUpdate?(dt: number, ctx: PlaneCtx): void;
  resize?(width: number, height: number, portrait: boolean): void;
  dispose?(): void;
}

export type SystemFactory = (ctx: PlaneCtx) => System | Promise<System>;

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

/** mulberry32 — small, fast, and reproducible, which the shot harness needs. */
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
// Units — the cockpit talks in feet and knots, the physics in metres
// ---------------------------------------------------------------------------

export const KT = 0.514444;            // knots → m/s
export const FT = 0.3048;              // feet → m
export const toKnots = (ms: number) => ms / KT;
export const toFeet = (m: number) => m / FT;
export const toFpm = (ms: number) => (ms / FT) * 60;

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------

/**
 * Trans American, and the flight deck it is seen from.
 *
 * The cockpit colours are the thing to get right. A 1979 wide-body flight deck
 * is not black — it is a warm grey-brown ("charcoal" in the Boeing paint
 * catalogue but distinctly brown under incandescent light), lit by red-orange
 * flood lamps and the green-white glow of the instrument faces. Painting it
 * neutral grey and lighting it white is what makes a cockpit look like a
 * render, and it is the single most nostalgic thing in the world.
 */
export const PALETTE = {
  /** Trans American's cheatline. Red over orange, 1970s airline stripe. */
  taRed: 0xd2232a,
  taOrange: 0xf07f1a,
  fuselage: 0xe9e9ea,
  fuselageBelly: 0xb9c0c6,

  panel: 0x2e2a26,
  panelLit: 0x413a33,
  bezel: 0x14120f,
  dialFace: 0x0b0c0d,
  needle: 0xf2efe6,
  markings: 0xd8d4c6,
  /** The flood lamps. Warm and low — a 707 flight deck at night is dim. */
  flood: 0xff8a3d,
  /** The glow behind the instrument faces. */
  instrument: 0xc8ffd8,

  warn: 0xffb020,
  danger: 0xff3b30,
  ok: 0x46d17a,
  /** Runway and approach lighting. */
  approachWhite: 0xfff4dc,
  thresholdGreen: 0x2bff88,
  runwayEdge: 0xfff0c0,
  papiRed: 0xff2a1a,
} as const;

/** The flap detents on a 707: lever positions, and what each is for. */
export const FLAP_DETENTS = [0, 14, 25, 30, 40, 50] as const;
