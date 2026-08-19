/**
 * Three things you can get into.
 *
 * The Empyrean's default verb is the jetpack, and the jetpack is *very* good:
 * fifty metres a second squared of thrust, instant response, no commitment.
 * That is also its limit. Everything you do on it you do standing up, alone,
 * and steering with your shoulders — so the city has exactly one way of
 * feeling, and a six-hundred-metre drop with a frozen lake under it deserves
 * more than one.
 *
 * These are the other ways:
 *
 * **The skiff** is *weight*. It leans into a turn, it slides through the exit,
 * it takes four seconds to stop and it has a turning circle you have to plan
 * around. Faster than a boosted jetpack in a straight line and much worse in a
 * street, which is the whole trade: it is for crossing the island and for
 * carrying somebody who came to look at the view.
 *
 * **The glider** has no engine at all. It converts height into speed and speed
 * into height and nothing else, and the only way back up is to find air that
 * is going up faster than you are going down. The sunlit face of the rock
 * makes that air. Launching off the promenade rail at sunset, dropping into
 * the slope lift under the rim, and circling back up to deck height on a
 * thermal is the best thirty seconds in this world, and it is a *skill* — a
 * bad pilot lands on the ice, which is a soft landing and a long walk, not a
 * death. This is an optimistic place.
 *
 * **The lifter** is the opposite of both: slow, square, and rock-steady in a
 * hover, with the vertical authority to put a load on a roof. It is the one
 * you take when you want to stop somewhere precise.
 *
 * ## Rules this file lives under
 *
 * - **It is a system.** It imports `types.ts`, `config.ts`, `cityplan.ts`,
 *   `three` and `@/lib/worldPhysics`, and nothing else from this directory.
 *   In particular it knows nothing about `traffic.ts` — the skycars and the
 *   tram are somebody else's world and these three do not talk to them.
 * - **The engine owns the player.** Nothing here writes to the flyer. `riding()`
 *   reports where the seat is and the engine puts the body there; `dismount()`
 *   reports where to stand and the engine stands them there.
 * - **Fixed-step physics.** `drive()` accumulates real time and steps the
 *   model at a fixed 120 Hz. A vehicle integrated at the display's frame rate
 *   is a vehicle that behaves differently on a 144 Hz monitor from the one it
 *   was tuned on — `src/orbit/orbit.ts` has the same accumulator for the same
 *   reason, and got it the hard way.
 * - **No allocation in `update()` or `drive()`.** Every vector, euler and
 *   quaternion is made once. The HUD strings are rebuilt at 10 Hz rather than
 *   per frame, because that is the rate the React layer reads them at anyway.
 *
 * ## Where they are
 *
 * | vehicle | pad | why there |
 * | --- | --- | --- |
 * | skiff `Ember` | the Launch Terrace, on the pavement beside the start circles | every race starts here; it is the one place on the island that already means "things take off from here" |
 * | glider `Vesper` | promenade deck 1 at the foot of the south-west avenue stairs | the rail points off the rim, and at the world's default sunset that face of the rock is the lit one |
 * | lifter `Derrick` | the Halo, south-east of the Beacon | the plaza is where a service lift for the Beacon would live, and it is the first thing you walk past on arrival |
 *
 * Each pad is a painted ring, three pylons and a forty-metre column of soft
 * light, so all three read as "you can get in this" from well past thirty
 * metres and from the air, which is where most people will first see them.
 */
import * as THREE from "three";
import { GRAVITY } from "@/lib/worldPhysics";

import type { BuildContext, FrameContext, Interactable, System } from "./types";
import {
  DECKS,
  GROUND_Y,
  ISLAND_Y,
  KILL_Y,
  LAKE_R,
  PLATEAU_R,
  WATER_Y,
} from "./config";
import { LANDMARKS, RIM_R, surfaceAt } from "./cityplan";

/* =========================================================================
 * The API
 * ====================================================================== */

export interface VehicleInput {
  forward: number; // -1..1
  strafe: number; // -1..1
  lift: number; // 0..1, the jetpack key
  boost: boolean;
  /** Camera yaw, for camera-relative steering if you want it. */
  camYaw: number;
}

export interface RideState {
  /** Where to put the player this frame. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** For the HUD. */
  speed: number;
  altitude: number;
  label: string;
  /** Extra HUD lines, e.g. glide ratio or a landing score. */
  lines: string[];
}

export interface VehiclesHandle extends System {
  interactables(): Interactable[];
  /** null when the player is on foot. */
  riding(): RideState | null;
  /** Called by the engine every frame while riding. */
  drive(input: VehicleInput, dt: number): void;
  /** Get out. Returns where to stand the player. */
  dismount(): { x: number; y: number; z: number } | null;
  /** The engine gives you the world to collide against at build time. */
  setWorld(w: {
    blockedAt(x: number, z: number, y: number): boolean;
    supportAt(x: number, z: number, fromY: number): number;
  }): void;

  /* ---- extras, all read-only, none of them required by the engine ---- */
  /** Which of the three is being ridden, or null. */
  ridingKind(): VehicleKind | null;
  /** Every vehicle's pad, for a map pin or a test. */
  readonly pads: readonly VehiclePad[];
  /** Live position of one vehicle, for a map pin. Mutates `out`. */
  positionOf(kind: VehicleKind, out: THREE.Vector3): THREE.Vector3;
  /** The last landing the glider made, or null. Kept until the next launch. */
  lastLanding(): LandingReport | null;
}

export type VehicleKind = "skiff" | "glider" | "lifter";

export interface VehiclePad {
  kind: VehicleKind;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface LandingReport {
  /** 0..100. Above 85 is a greaser. */
  score: number;
  grade: string;
  /** Vertical speed at touchdown, m/s, positive downward. */
  sink: number;
  /** Ground speed at touchdown, m/s. */
  ground: number;
  /** Bank at touchdown, radians. */
  bank: number;
  /** True when the wheels found the island rather than the ice. */
  onIsland: boolean;
}

/* =========================================================================
 * Tuning
 *
 * All of it in one block, because a number that lives next to the line that
 * uses it is a number nobody ever compares against its neighbours. Speeds are
 * m/s, accelerations m/s², angles radians, times seconds.
 * ====================================================================== */

/** The physics step. Everything below is integrated at exactly this. */
const FIXED = 1 / 120;
/** Never chase more than this much wall-clock in one call. */
const MAX_STEPS = 16;

/**
 * How thick the rock under a walkable surface is treated as being.
 *
 * The rim wall is twenty-two metres from the deck to the first promenade and
 * the rings step down by twenty-two to twenty-six, so thirty-four covers every
 * face a vehicle can fly into without claiming the whole keel.
 */
const ISLAND_SLAB = 34;

/** The frozen lake counts as ground: it is a soft landing, not a death. */
const ICE_Y = WATER_Y;
/**
 * Outside the lake the snow has drifts and, further out, ranges — and
 * `terrain.ts` is another system, so this file may not ask it how high they
 * are. It does not need to: the air past the shore sinks hard enough (see
 * `airLiftAt`) that nothing gets out there with height to spare, and a
 * conservative floor is all that is left to do.
 */
const SNOW_Y = GROUND_Y + 22;

const SKIFF = {
  /** Cruise and boost top speeds. The jetpack's are 22 and 34. */
  vCruise: 31,
  vBoost: 47,
  /** Seconds to 63% of the target speed. This is the "heavier" in heavier. */
  tauThrottle: 1.9,
  tauBrake: 2.6,
  /** Yaw rate at a standstill, and the speed at which it has halved. */
  yawRate0: 1.06,
  yawRateV: 22,
  /** How long the rate takes to build. Commitment. */
  tauYaw: 0.36,
  /** How fast sideways velocity bleeds off. Higher = more slide. */
  tauSlideGrip: 0.85,
  tauSlideBoost: 1.35,
  /** Climb rate under full lift, and the sink with the key released. */
  vRise: 15,
  vSink: 5.2,
  tauVert: 0.62,
  /** Metres of clearance over which the sink is throttled back to a settle. */
  cushion: 3.2,
  /** Hull half-length / half-width used against `blockedAt`. */
  hullR: 2.4,
  /** How high the hull floats over the skids when parked. */
  skidH: 0.62,
  /** Feet, in hull space. */
  seat: { x: 0, y: 0.58, z: 0.2 },
  ceiling: ISLAND_Y + 520,
} as const;

const LIFTER = {
  vCruise: 11,
  vBoost: 17,
  tauThrottle: 2.1,
  tauBrake: 1.7,
  /** It rotates in place; the nose follows travel rather than steering it. */
  tauFacing: 1.15,
  vRise: 8.5,
  vSink: 2.4,
  tauVert: 0.8,
  cushion: 2.4,
  hullR: 2.9,
  skidH: 0.5,
  seat: { x: 0, y: 0.78, z: 0.75 },
  ceiling: ISLAND_Y + 340,
} as const;

/**
 * The glider's polar.
 *
 * A real one, at this world's gravity rather than at Earth's — everything in
 * The Empyrean falls at 24 m/s², so a sailplane tuned at 9.81 would feel like
 * a different world's aircraft the moment you compared it to a jump. The wing
 * loading is then chosen to put best glide back at a speed a person can read:
 *
 *   stall              19.8 m/s
 *   best glide         24.4 m/s at 19.1 : 1, sinking 1.28 m/s
 *   trimmed cruise     32.6 m/s at 16.3 : 1, sinking 2.00 m/s
 *   nose down          60.8 m/s at  6.0 : 1, sinking 10.2 m/s
 *
 * Those four numbers *are* the aircraft. If they drift the glider still flies
 * and quietly stops being the thing it was; `src/test/empyreanVehicles.test.ts`
 * asserts them.
 */
export const GLIDER = {
  /** All-up mass, kg, and wing area, m². */
  mass: 240,
  wing: 21.0,
  /** Air density at six hundred metres over a frozen lake. */
  rho: 1.1,
  /** Lift slope and zero-alpha lift. */
  clAlpha: 5.2,
  cl0: 0.18,
  /** Parasitic drag and the induced-drag factor 1/(pi*AR*e), AR 12, e 0.85. */
  cd0: 0.022,
  kInduced: 0.0312,
  /**
   * Where the wing lets go, and how fast lift falls away past it.
   *
   * Set so that a firm flare — seven tenths of back stick — is *inside* the
   * stall and full back stick is outside it. Trim it any tighter and the
   * flare and the stall are the same input, which makes the correct technique
   * "do nothing" and throws away the skill the landing score is measuring.
   */
  alphaStall: 0.21,
  stallFade: 2.2,
  /** Stick range: neutral is best glide, full back is past the stall. */
  alphaMin: -0.0087,
  alphaTrim: 0.127,
  alphaMax: 0.235,
  /** How quickly the wing follows the stick, and the roll rate. */
  tauAlpha: 0.34,
  tauBank: 0.42,
  bankMax: 1.05,
  /** Spoilers: the landing tool. Drag up, lift down. */
  brakeCd: 0.09,
  brakeCl: 0.85,
  /** Never-exceed. Past it the airframe is a brick. */
  vne: 78,
  /** Below this the equations stop meaning anything and it is falling. */
  vMin: 6,
  /** Wingspan and the nose-skid height, for the model and the touchdown test. */
  span: 15.9,
  skidH: 0.55,
  hullR: 3.4,
  seat: { x: 0, y: 0.46, z: 0.15 },
  /** Rail launch: how hard the catapult pushes and how fast it lets go. */
  railAccel: 26,
  railSpeed: 26,
  railLength: 22,
  ceiling: ISLAND_Y + 620,
} as const;

/* -------------------------------------------------------------------------
 * The air
 * ---------------------------------------------------------------------- */

/**
 * Where the columns are, relative to the sun's bearing.
 *
 * The rock spends the day absorbing light on one face and giving it back as
 * rising air, so the thermal field is anchored to the sun rather than to the
 * island: `da` is the offset in radians from the sun's bearing, `rr` a
 * multiple of the plateau radius, `r` the core radius in metres and `w` the
 * core strength in metres a second.
 *
 * Seven of them, spread over rather more than a half-circle, because a field
 * that is exactly a half-circle has a hard edge you can feel.
 */
const COLUMNS = [
  { da: -1.06, rr: 1.3, r: 80, w: 4.6 },
  { da: -0.62, rr: 1.14, r: 78, w: 5.0 },
  { da: -0.2, rr: 1.36, r: 92, w: 5.8 },
  { da: 0.24, rr: 1.1, r: 70, w: 4.4 },
  { da: 0.66, rr: 1.42, r: 86, w: 5.2 },
  { da: 1.1, rr: 1.18, r: 74, w: 4.0 },
  { da: 0.02, rr: 1.9, r: 112, w: 3.6 },
] as const;

/** Where a column starts and where it dies. */
const THERMAL_BASE = 110;
const THERMAL_TOP = ISLAND_Y + 320;

/** Ambient sink between the columns. Nothing here is free. */
const AMBIENT_SINK = -0.38;

/**
 * The slope-lift band: air deflected up the sunlit face of the rock.
 *
 * Deliberately wide. A narrow ridge band is realistic and unplayable — you
 * cannot circle inside fifty metres without flying back into the island — so
 * this one is nearly two hundred metres across and centred well outside the
 * rim, which leaves room for a turn. It is the first lift a new pilot finds,
 * because it is directly under the rail.
 */
const SLOPE_R = PLATEAU_R * 1.22;
const SLOPE_WIDTH = 95;
const SLOPE_W = 5.6;

/**
 * Vertical velocity of the air at a point, m/s. Positive is up.
 *
 * Pure, deterministic and allocation-free, so the whole lift model can be
 * mapped in a test rather than felt for in a browser at sunset.
 *
 * @param sunBearing `atan2(sunDir.z, sunDir.x)` — which way the lit face is.
 * @param sunHeight  `sunDir.y`. The world opens at a sunset, where this is
 *   about zero, so the field is deliberately still 70% alive at that hour:
 *   evening thermals off warm rock are a real thing, and a world whose best
 *   trick only works at noon has thrown away the light it was painted in.
 */
export function airLiftAt(
  x: number,
  y: number,
  z: number,
  time: number,
  sunBearing: number,
  sunHeight = 0,
): number {
  const r = Math.hypot(x, z);

  /* Past the shore the air is dead. This is half the fence: nineteen to one
   * from six hundred metres is eleven kilometres of glide, which is seven
   * times the lake and out over terrain this file is not allowed to ask the
   * height of. The other half is in `stepGlider`, which weathercocks the nose
   * back over the water — sink alone would only mean you crashed further
   * out. Together they mean the lake is the world and nothing has to be a
   * wall. */
  if (r > LAKE_R * 0.88) {
    const t = (r - LAKE_R * 0.88) / (LAKE_R * 0.16);
    return -1.0 - Math.min(t, 2.4) * 3.4;
  }

  const strength = Math.min(1.25, 0.7 + Math.max(0, sunHeight) * 0.55);
  let w = AMBIENT_SINK;

  /* ---- the columns ---- */
  const env = columnEnvelope(y);
  if (env > 0) {
    for (let i = 0; i < COLUMNS.length; i++) {
      const c = COLUMNS[i];
      const a = sunBearing + c.da;
      const cx = Math.cos(a) * PLATEAU_R * c.rr;
      const cz = Math.sin(a) * PLATEAU_R * c.rr;
      const d = Math.hypot(x - cx, z - cz);
      if (d > c.r * 1.9) continue;
      // A pulse, so a column is not a cylinder you can park in for ever.
      const pulse = 0.82 + 0.18 * Math.sin(time * 0.21 + i * 1.7);
      if (d <= c.r) {
        const k = d / c.r;
        w += c.w * Math.exp(-k * k * 1.6) * env * pulse * strength;
      } else {
        // The shell of sinking air every thermal drags down around itself.
        // It is what makes centring a skill instead of a formality.
        const k = (d - c.r) / (c.r * 0.9);
        w += -0.95 * Math.sin(Math.PI * k) * env * strength;
      }
    }
  }

  /* ---- the slope, right under the rim ---- */
  const facing = Math.cos(Math.atan2(z, x) - sunBearing);
  if (facing > -0.25 && r > PLATEAU_R * 0.9) {
    const band = Math.exp(-(((r - SLOPE_R) / SLOPE_WIDTH) ** 2));
    const vert = slopeEnvelope(y);
    if (band > 0.02 && vert > 0) {
      w += SLOPE_W * band * vert * Math.min(1, facing + 0.25) * strength;
    }
  }

  return w;
}

/** 0..1 up the height of a column: a ramp in at the bottom, a taper at the top. */
function columnEnvelope(y: number): number {
  if (y < THERMAL_BASE || y > THERMAL_TOP) return 0;
  const ramp = Math.min(1, (y - THERMAL_BASE) / 90);
  const cap = Math.min(1, (THERMAL_TOP - y) / 240);
  return ramp * cap;
}

/**
 * 0..1 through the slope band.
 *
 * A broad plateau rather than a peak: the band has to still be worth something
 * at the height of the launch rail, or the first thing a new pilot does is
 * step off the edge into nothing.
 */
function slopeEnvelope(y: number): number {
  const lo = 140;
  const hi = ISLAND_Y + 60;
  if (y < lo || y > hi) return 0;
  const t = (y - lo) / (hi - lo);
  return Math.sin(Math.PI * t) ** 0.45;
}

/* -------------------------------------------------------------------------
 * The polar
 * ---------------------------------------------------------------------- */

export interface Polar {
  cl: number;
  cd: number;
}

/** Reusable, because this is called inside the fixed step. */
const _polar: Polar = { cl: 0, cd: 0 };

/**
 * Lift and drag coefficients at an angle of attack.
 *
 * Linear up to the stall and then falling away — the fall is the whole reason
 * a glider can be mishandled. Hold the stick back through a flare and the wing
 * stops working, which is exactly what it should do and exactly what a pilot
 * has to learn not to do at two metres.
 */
export function gliderPolar(alpha: number, airbrake: boolean, out: Polar = { cl: 0, cd: 0 }): Polar {
  let cl = GLIDER.cl0 + GLIDER.clAlpha * alpha;
  if (alpha > GLIDER.alphaStall) {
    const clMax = GLIDER.cl0 + GLIDER.clAlpha * GLIDER.alphaStall;
    cl = Math.max(0.34, clMax * (1 - GLIDER.stallFade * (alpha - GLIDER.alphaStall)));
  }
  if (airbrake) cl *= GLIDER.brakeCl;
  let cd = GLIDER.cd0 + GLIDER.kInduced * cl * cl;
  if (airbrake) cd += GLIDER.brakeCd;
  out.cl = cl;
  out.cd = cd;
  return out;
}

/** Steady-state glide ratio at an angle of attack. The number on the HUD. */
export function glideRatio(alpha: number, airbrake = false): number {
  gliderPolar(alpha, airbrake, _polar);
  return _polar.cl / Math.max(1e-4, _polar.cd);
}

/** Steady-state airspeed that supports the aircraft at this lift coefficient. */
export function speedForCl(cl: number): number {
  return Math.sqrt((2 * GLIDER.mass * GRAVITY) / (GLIDER.rho * GLIDER.wing * Math.max(0.02, cl)));
}

/* =========================================================================
 * Where they are parked
 * ====================================================================== */

/** Yaw such that the craft's nose (local -Z) points along (dx, dz). */
function yawTowards(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

function padAt(kind: VehicleKind, name: string, angle: number, radius: number, faceOut: boolean): VehiclePad {
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  const s = surfaceAt(x, z);
  const dir = faceOut ? 1 : -1;
  return {
    kind,
    name,
    x,
    z,
    y: Number.isFinite(s.y) ? s.y : ISLAND_Y,
    yaw: yawTowards(Math.cos(angle) * dir, Math.sin(angle) * dir),
  };
}

const LAUNCH = LANDMARKS.find((l) => l.id === "launch")!;
/** The Launch Terrace's polar angle. Its `yaw` field happens to be it. */
const LAUNCH_A = Math.atan2(LAUNCH.z, LAUNCH.x);

/**
 * The three pads.
 *
 * The skiff sits sixteen metres round the arc from the terrace's centreline,
 * which puts it on the pavement beside the ring road rather than on the
 * carriageway the races start on. The glider is on the first promenade at the
 * foot of the south-west avenue's stairs — you walk out the avenue, down the
 * gate, and the rail is there pointing off the edge, at the face of the rock
 * the sun is on when the world opens. The lifter is on the Halo, clear of the
 * Beacon's skirt and of the Cistern.
 */
const PADS: VehiclePad[] = [
  padAt("skiff", "Ember", LAUNCH_A + 0.055, RIM_R - 26, true),
  padAt("glider", "Vesper", -Math.PI * 0.75, DECKS[1].outer - DECKS[1].width * 0.5, true),
  padAt("lifter", "Derrick", -Math.PI * 0.25, 42, false),
];

/* =========================================================================
 * State
 * ====================================================================== */

type Phase = "parked" | "railed" | "flying" | "landed";

interface Craft {
  kind: VehicleKind;
  pad: VehiclePad;
  group: THREE.Group;
  /** Hull origin: the underside of the skids sits `skidH` below it. */
  pos: THREE.Vector3;
  /** World velocity, m/s. The glider derives it; the others own it. */
  vel: THREE.Vector3;
  yaw: number;
  pitch: number;
  roll: number;
  phase: Phase;
  /* ---- powered craft ---- */
  yawRate: number;
  /* ---- glider ---- */
  airspeed: number;
  gamma: number;
  alpha: number;
  bank: number;
  railRun: number;
  /** Vertical air velocity where it is, m/s. Read by the HUD. */
  air: number;
  /** Metres of clear air below the skids. */
  clearance: number;
  /** Fades a beacon out once you have used the thing. */
  idleGlow: number;
}

/* ---- scratch. Made once, mutated for ever. ---- */
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _seat = new THREE.Vector3();
const _sun = new THREE.Vector3(0, 0, -1);
const _seatEuler = new THREE.Euler(0, 0, 0, "YXZ");

/* =========================================================================
 * Build
 * ====================================================================== */

export function buildVehicles(ctx: BuildContext): VehiclesHandle {
  const low = ctx.quality === "low";
  const group = new THREE.Group();
  group.name = "empyrean-vehicles";

  /* A copy per world, because `setWorld` settles each pad onto whatever is
   * really under it and a module-level constant that two worlds both write to
   * is a bug waiting for the second tab. */
  const pads: VehiclePad[] = PADS.map((p) => ({ ...p }));

  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(d: T): T => {
    disposables.push(d);
    return d;
  };

  /* ---- materials ------------------------------------------------------- */
  const matHull = keep(
    new THREE.MeshStandardMaterial({
      name: "EmpyreanVehicleHull",
      color: 0xdfe6ef,
      roughness: 0.36,
      metalness: 0.5,
    }),
  );
  const matDark = keep(
    new THREE.MeshStandardMaterial({
      name: "EmpyreanVehicleTrim",
      color: 0x2c3340,
      roughness: 0.55,
      metalness: 0.35,
    }),
  );
  const matWarm = keep(
    new THREE.MeshStandardMaterial({
      name: "EmpyreanVehicleWarm",
      color: 0xc08a4a,
      roughness: 0.44,
      metalness: 0.62,
    }),
  );
  const matGlass = keep(
    new THREE.MeshStandardMaterial({
      name: "EmpyreanVehicleGlass",
      color: 0x9fd8ff,
      roughness: 0.08,
      metalness: 0,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
    }),
  );
  /** One emissive per vehicle, so a pad and its craft glow the same colour. */
  const glowMats = new Map<VehicleKind, THREE.MeshBasicMaterial>();
  const columnMats = new Map<VehicleKind, THREE.ShaderMaterial>();

  const ACCENT: Record<VehicleKind, number> = {
    skiff: 0xffb35c,
    glider: 0x9ce8a8,
    lifter: 0xc8a2ff,
  };

  for (const kind of ["skiff", "glider", "lifter"] as VehicleKind[]) {
    glowMats.set(
      kind,
      keep(
        new THREE.MeshBasicMaterial({
          name: `EmpyreanVehicleGlow-${kind}`,
          color: new THREE.Color(ACCENT[kind]).multiplyScalar(1.7),
          toneMapped: false,
          fog: false,
        }),
      ),
    );
    columnMats.set(kind, keep(padColumnMaterial(ACCENT[kind])));
  }

  /* ---- geometry -------------------------------------------------------- */
  const crafts: Craft[] = [];
  const byKind = new Map<VehicleKind, Craft>();

  for (const pad of pads) {
    const g = new THREE.Group();
    g.name = `empyrean-${pad.kind}`;
    g.rotation.order = "YXZ";

    const glow = glowMats.get(pad.kind)!;
    if (pad.kind === "skiff") buildSkiff(g, matHull, matDark, matWarm, matGlass, glow, keep, !low);
    else if (pad.kind === "glider") buildGlider(g, matHull, matDark, matGlass, glow, keep, !low);
    else buildLifter(g, matHull, matDark, matWarm, glow, keep, !low);

    group.add(g);

    const skidH =
      pad.kind === "skiff" ? SKIFF.skidH : pad.kind === "glider" ? GLIDER.skidH : LIFTER.skidH;

    const c: Craft = {
      kind: pad.kind,
      pad,
      group: g,
      pos: new THREE.Vector3(pad.x, pad.y + skidH, pad.z),
      vel: new THREE.Vector3(),
      yaw: pad.yaw,
      pitch: 0,
      roll: 0,
      phase: "parked",
      yawRate: 0,
      airspeed: 0,
      gamma: 0,
      alpha: GLIDER.alphaTrim,
      bank: 0,
      railRun: 0,
      air: 0,
      clearance: 0,
      idleGlow: 1,
    };
    crafts.push(c);
    byKind.set(pad.kind, c);

    /* ---- the pad it is standing on ---- */
    group.add(buildPad(pad, ACCENT[pad.kind], columnMats.get(pad.kind)!, glow, keep));
  }

  /* ---- the world it collides with -------------------------------------- */
  let world: {
    blockedAt(x: number, z: number, y: number): boolean;
    supportAt(x: number, z: number, fromY: number): number;
  } = {
    blockedAt: () => false,
    supportAt: () => -Infinity,
  };

  /* ---- ride state ------------------------------------------------------ */
  let ride: Craft | null = null;
  let pendingExit: { x: number; y: number; z: number } | null = null;
  let accum = 0;
  let time = 0;
  let sunBearing = -Math.PI * 0.78;
  let sunHeight = 0;
  let hudTimer = 0;
  let landing: LandingReport | null = null;

  const rideState: RideState = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    speed: 0,
    altitude: 0,
    label: "",
    lines: [],
  };

  /* =======================================================================
   * Ground
   * ==================================================================== */

  /**
   * The highest thing under (x, z), taking the lake and the snow into
   * account as well as the city.
   *
   * `supportAt` reports -Infinity over the void, which is correct for a body
   * — it falls — and useless for a glider, which has six hundred metres of
   * air and then a frozen lake to arrive on.
   */
  function groundBelow(x: number, z: number, fromY: number): number {
    const deck = world.supportAt(x, z, fromY);
    const r = Math.hypot(x, z);
    const floor = r < LAKE_R ? ICE_Y : SNOW_Y;
    /* One-way, and the `fromY` guard is applied here rather than left to
     * `supportAt`, which only enforces it for built decks and answers "the
     * city deck" for any point inside the plateau at any height at all. Take
     * that answer literally and a glider two hundred metres under the island
     * is teleported up onto the plaza. */
    if (Number.isFinite(deck) && deck <= fromY && deck > floor) return deck;
    return floor;
  }

  /**
   * The rock itself, as a wall.
   *
   * `blockedAt` knows about buildings and knows nothing about the island, so
   * without this a skiff flies through the rim and a glider launched off the
   * promenade can cut back across the middle of the city at deck-minus-twenty.
   * Each walkable surface is treated as a slab `ISLAND_SLAB` thick — the rim
   * wall, and the underside of each promenade ring — which is what a vehicle
   * can actually hit. Below that the keel is open air, on purpose: flying
   * under the island is one of the better things this world offers, and the
   * spike is a shape a pilot can see and avoid.
   */
  function insideIsland(x: number, z: number, y: number): boolean {
    const s = surfaceAt(x, z);
    if (!Number.isFinite(s.y)) return false;
    return y < s.y - 0.7 && y > s.y - ISLAND_SLAB;
  }

  /**
   * True if the hull would be inside something.
   *
   * Five samples: the centre and four at hull radius on the nose/tail and
   * both beams, each tested at the skid line and again a metre and a half up,
   * because `blockedAt` treats a point above a roof as clear and a craft that
   * only ever asks about its own belly lands halfway through a parapet.
   */
  function hullBlocked(c: Craft, x: number, y: number, z: number, yaw: number): boolean {
    const R = c.kind === "skiff" ? SKIFF.hullR : c.kind === "glider" ? GLIDER.hullR : LIFTER.hullR;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    for (let i = 0; i < 5; i++) {
      let px = x;
      let pz = z;
      if (i === 1) { px += fx * R; pz += fz * R; }
      else if (i === 2) { px -= fx * R; pz -= fz * R; }
      else if (i === 3) { px += fz * R; pz -= fx * R; }
      else if (i === 4) { px -= fz * R; pz += fx * R; }
      if (world.blockedAt(px, pz, y)) return true;
      if (world.blockedAt(px, pz, y + 1.5)) return true;
      if (insideIsland(px, pz, y + 0.3)) return true;
    }
    return false;
  }

  /* =======================================================================
   * The powered craft: skiff and lifter
   * ==================================================================== */

  function stepSkiff(c: Craft, input: VehicleInput, dt: number): void {
    const boost = input.boost;
    const vMax = boost ? SKIFF.vBoost : SKIFF.vCruise;

    /* ---- turn ----
     * The rate a hover skiff can turn at falls with speed, which is what
     * gives it a turning circle rather than a pivot. At forty-seven metres a
     * second the circle is about a hundred and thirty metres across — wider
     * than a city block, so streets are for the jetpack and the open air is
     * for this. */
    const speed0 = Math.hypot(c.vel.x, c.vel.z);
    const rateMax = SKIFF.yawRate0 / (1 + speed0 / SKIFF.yawRateV);
    const wantRate = -clamp(input.strafe, -1, 1) * rateMax;
    c.yawRate += (wantRate - c.yawRate) * ease(dt, SKIFF.tauYaw);
    c.yaw += c.yawRate * dt;

    /* ---- decompose into the hull's own frame ---- */
    _fwd.set(-Math.sin(c.yaw), 0, -Math.cos(c.yaw));
    _right.set(Math.cos(c.yaw), 0, -Math.sin(c.yaw));
    let vf = c.vel.x * _fwd.x + c.vel.z * _fwd.z;
    let vl = c.vel.x * _right.x + c.vel.z * _right.z;

    const thr = clamp(input.forward, -1, 1);
    const target = thr >= 0 ? thr * vMax : thr * vMax * 0.35;
    const tau = Math.abs(target) > Math.abs(vf) ? SKIFF.tauThrottle : SKIFF.tauBrake;
    vf += (target - vf) * ease(dt, tau);

    /* ---- slide ----
     * Lateral velocity bleeds off rather than vanishing, so the skiff carries
     * through the exit of a turn. Under boost it lets go further, which is
     * the only handling difference between the two speeds that you can feel
     * with your hands rather than read off the HUD. */
    vl *= Math.exp(-dt / (boost ? SKIFF.tauSlideBoost : SKIFF.tauSlideGrip));

    /* On the skids, everything stops fast: it is a hull on stone. */
    if (c.phase === "landed") {
      const grip = Math.exp(-dt / 0.55);
      vf *= grip;
      vl *= grip;
    }

    c.vel.x = _fwd.x * vf + _right.x * vl;
    c.vel.z = _fwd.z * vf + _right.z * vl;

    stepHoverVertical(c, input, dt, SKIFF.vRise, SKIFF.vSink, SKIFF.tauVert, SKIFF.cushion, SKIFF.skidH, SKIFF.ceiling);
    tether(c, dt);
    integrate(c, dt, SKIFF.skidH);

    /* ---- attitude ----
     * Bank is the real one: atan(v*omega/g), the angle a passenger's drink
     * would sit at. Pitch is nose-down under power and nose-up on the brakes,
     * a tenth of what the bank is, because a hovercraft that pitches like an
     * aircraft looks like an aircraft. */
    const speed = Math.hypot(c.vel.x, c.vel.z);
    const wantRoll = Math.atan((speed * c.yawRate) / GRAVITY) * 1.35;
    c.roll += (wantRoll - c.roll) * ease(dt, 0.3);
    const wantPitch = c.phase === "landed" ? 0 : -clamp((target - vf) / vMax, -1, 1) * 0.16;
    c.pitch += (wantPitch - c.pitch) * ease(dt, 0.45);
  }

  function stepLifter(c: Craft, input: VehicleInput, dt: number): void {
    /* Camera-relative and direct, like a crane rather than a car. Nothing
     * about the lifter is committed: it goes where you point and stops when
     * you stop, slowly, which is the point of it. */
    const vMax = input.boost ? LIFTER.vBoost : LIFTER.vCruise;
    const fx = -Math.sin(input.camYaw);
    const fz = -Math.cos(input.camYaw);
    const rx = Math.cos(input.camYaw);
    const rz = -Math.sin(input.camYaw);
    let ix = fx * clamp(input.forward, -1, 1) + rx * clamp(input.strafe, -1, 1);
    let iz = fz * clamp(input.forward, -1, 1) + rz * clamp(input.strafe, -1, 1);
    const il = Math.hypot(ix, iz);
    if (il > 1) {
      ix /= il;
      iz /= il;
    }

    const moving = il > 0.02;
    const tau = moving ? LIFTER.tauThrottle : LIFTER.tauBrake;
    c.vel.x += (ix * vMax - c.vel.x) * ease(dt, tau);
    c.vel.z += (iz * vMax - c.vel.z) * ease(dt, tau);
    if (c.phase === "landed") {
      const grip = Math.exp(-dt / 0.4);
      c.vel.x *= grip;
      c.vel.z *= grip;
    }

    stepHoverVertical(c, input, dt, LIFTER.vRise, LIFTER.vSink, LIFTER.tauVert, LIFTER.cushion, LIFTER.skidH, LIFTER.ceiling);
    tether(c, dt);
    integrate(c, dt, LIFTER.skidH);

    /* The nose follows travel instead of steering it, slowly, and it never
     * banks: a laden lifter that leaned would drop the load. */
    const speed = Math.hypot(c.vel.x, c.vel.z);
    if (speed > 1.2) {
      const want = Math.atan2(-c.vel.x, -c.vel.z);
      c.yaw += shortestAngle(want - c.yaw) * ease(dt, LIFTER.tauFacing);
    }
    c.roll += (0 - c.roll) * ease(dt, 0.5);
    c.pitch += (0 - c.pitch) * ease(dt, 0.5);
  }

  /**
   * The shared hover column.
   *
   * Hold the lift key and it climbs at a fixed rate; release it and it sinks
   * at a slower one, throttled back to nothing as the skids come into the
   * cushion. That last part is what makes setting one of these down feel like
   * setting it down rather than dropping it — and it is the reason neither of
   * them uses gravity at all. They are not falling; they are descending.
   */
  function stepHoverVertical(
    c: Craft,
    input: VehicleInput,
    dt: number,
    vRise: number,
    vSink: number,
    tau: number,
    cushion: number,
    skidH: number,
    ceiling: number,
  ): void {
    const ground = groundBelow(c.pos.x, c.pos.z, c.pos.y + 0.4);
    c.clearance = Math.max(0, c.pos.y - skidH - ground);

    const lift = clamp(input.lift, 0, 1);
    let target: number;
    if (lift > 0.02) {
      target = vRise * lift;
      c.phase = "flying";
    } else {
      target = -vSink * Math.min(1, Math.max(0.05, c.clearance / cushion));
    }
    if (c.pos.y > ceiling && target > 0) target = 0;

    c.vel.y += (target - c.vel.y) * ease(dt, tau);
  }

  /* =======================================================================
   * The glider
   * ==================================================================== */

  function stepGlider(c: Craft, input: VehicleInput, dt: number): void {
    /* ---- on the rail ---------------------------------------------------
     * The catapult. Push forward (or hold the lift key) and it runs the
     * twenty-two metres of rail, off the promenade, and lets go at flying
     * speed. Doing it any other way — spawning you already airborne — throws
     * away the one moment where the height under the rim first appears. */
    if (c.phase === "railed") {
      if (input.forward > 0.15 || input.lift > 0.15) {
        c.airspeed = Math.min(GLIDER.railSpeed, c.airspeed + GLIDER.railAccel * dt);
        c.railRun += c.airspeed * dt;
        _fwd.set(-Math.sin(c.yaw), 0, -Math.cos(c.yaw));
        c.pos.addScaledVector(_fwd, c.airspeed * dt);
        c.vel.set(_fwd.x * c.airspeed, 0, _fwd.z * c.airspeed);
        if (c.railRun >= GLIDER.railLength) {
          c.phase = "flying";
          c.gamma = -0.05;
          c.alpha = GLIDER.alphaTrim;
          landing = null;
        }
      }
      c.pitch = 0.03;
      c.roll = 0;
      return;
    }

    if (c.phase === "landed") {
      /* Skidding to a halt. Friction, and nothing else. */
      c.airspeed *= Math.exp(-dt / 1.1);
      if (c.airspeed < 0.35) c.airspeed = 0;
      _fwd.set(-Math.sin(c.yaw), 0, -Math.cos(c.yaw));
      const rx = c.pos.x + _fwd.x * c.airspeed * dt;
      const rz = c.pos.z + _fwd.z * c.airspeed * dt;
      if (hullBlocked(c, rx, c.pos.y, rz, c.yaw)) c.airspeed = 0;
      else {
        c.pos.x = rx;
        c.pos.z = rz;
      }
      c.pos.y = groundBelow(c.pos.x, c.pos.z, c.pos.y + 0.4) + GLIDER.skidH;
      c.vel.set(_fwd.x * c.airspeed, 0, _fwd.z * c.airspeed);
      c.roll += (0 - c.roll) * ease(dt, 0.6);
      c.pitch += (0.06 - c.pitch) * ease(dt, 0.6);
      c.clearance = 0;
      return;
    }

    /* ---- stick ----------------------------------------------------------
     * Neutral is best glide, which is the trim a sailplane is actually flown
     * at and means a player who does nothing at all still gets nineteen to
     * one. Back is the flare and, past about seven tenths, the stall. The
     * lift key is folded in as extra back-stick because on foot it means
     * "up", and here pulling up is the only thing that means "up". */
    const pitchIn = clamp(-clamp(input.forward, -1, 1) + clamp(input.lift, 0, 1), -1, 1);
    const alphaCmd =
      GLIDER.alphaTrim +
      (pitchIn >= 0
        ? pitchIn * (GLIDER.alphaMax - GLIDER.alphaTrim)
        : pitchIn * (GLIDER.alphaTrim - GLIDER.alphaMin));
    c.alpha += (alphaCmd - c.alpha) * ease(dt, GLIDER.tauAlpha);

    const bankCmd = clamp(input.strafe, -1, 1) * GLIDER.bankMax;
    c.bank += (bankCmd - c.bank) * ease(dt, GLIDER.tauBank);

    /* ---- the wing ------------------------------------------------------- */
    gliderPolar(c.alpha, input.boost, _polar);
    const v = Math.max(GLIDER.vMin, c.airspeed);
    const q = 0.5 * GLIDER.rho * v * v * GLIDER.wing;

    /* Ground effect. Inside a wingspan of the surface the wing works against
     * a cushion instead of against open air: real, worth about a quarter of
     * the lift at nothing, and the reason a sailplane *floats* down the last
     * five metres instead of arriving. It is also what makes a good flare
     * achievable rather than theoretical, which the brief asked for in as
     * many words — be generous, the ice is a soft landing. */
    const ge = 1 + 0.24 * Math.exp((-2.4 * Math.max(0, c.clearance)) / GLIDER.span);
    const L = q * _polar.cl * ge;
    let D = q * _polar.cd * (2 - ge);
    // Past never-exceed the airframe stops being a wing and starts being a
    // parachute. It is not a wall, it is a very steep curve, and you can feel
    // it arrive — which is the point of having one.
    if (v > GLIDER.vne) D += q * 0.004 * (v - GLIDER.vne);

    const m = GLIDER.mass;
    const cosB = Math.cos(c.bank);
    const sinB = Math.sin(c.bank);

    /* Airspeed: gravity along the path, minus drag. */
    c.airspeed = Math.max(0.5, v + (-GRAVITY * Math.sin(c.gamma) - D / m) * dt);

    /* Flight-path angle: the vertical component of lift against weight. */
    const dGamma = ((L * cosB) / (m * v) - (GRAVITY * Math.cos(c.gamma)) / v) * dt;
    c.gamma = clamp(c.gamma + clamp(dGamma, -2.2 * dt - 0.02, 2.2 * dt + 0.02), -1.45, 1.2);

    /* Heading: the horizontal component of lift. A coordinated turn, so the
     * radius falls out of the bank and the speed rather than being a number
     * somebody picked. At twenty-six metres a second and forty-five degrees
     * it is twenty-eight metres, which fits inside a thermal core. */
    const cg = Math.max(0.15, Math.cos(c.gamma));
    c.yaw += ((L * sinB) / (m * v * cg)) * dt * -1;

    /* ---- the wind off the plain ----------------------------------------
     * The powered craft get a tether — an inward shove they can fight. A
     * glider cannot be shoved: cancel its outward velocity and it stops flying
     * and falls straight down, which is both ugly and unfair, and it wrecks
     * every landing because the sinking air out there is unflareable. So the
     * glider is *turned* instead. The nose comes round toward the middle of
     * the lake over five or ten seconds, it keeps every metre of its
     * airspeed, and what the player feels is weather rather than a fence. */
    const rr = Math.hypot(c.pos.x, c.pos.z);
    if (rr > LAKE_R * 0.88) {
      const t = Math.min(1, (rr - LAKE_R * 0.88) / (LAKE_R * 0.16));
      const home = Math.atan2(c.pos.x, c.pos.z);
      c.yaw += shortestAngle(home - c.yaw) * ease(dt, 8.4 - 6.9 * t);
    }

    /* ---- the air it is flying through ---- */
    c.air = airLiftAt(c.pos.x, c.pos.y, c.pos.z, time, sunBearing, sunHeight);

    /* ---- integrate ------------------------------------------------------
     * Air-relative: the glider flies through an air mass and the air mass
     * moves. That is why a thermal works at all — nothing about the wing
     * changes inside one, the whole parcel simply goes up faster than the
     * glider goes down through it. */
    _fwd.set(-Math.sin(c.yaw), 0, -Math.cos(c.yaw));
    const horiz = c.airspeed * Math.cos(c.gamma);
    c.vel.set(_fwd.x * horiz, c.airspeed * Math.sin(c.gamma) + c.air, _fwd.z * horiz);

    integrate(c, dt, GLIDER.skidH);

    c.pitch = c.gamma + c.alpha;
    c.roll = -c.bank;
  }

  /* =======================================================================
   * Shared integration
   * ==================================================================== */

  /**
   * Move, collide, and land.
   *
   * Axis-separated horizontally so a craft slides along a facade instead of
   * stopping dead on it, and reverted wholesale if the new place is inside
   * something — which is the invariant the test leans on: a craft that starts
   * outside every blocker can never end up inside one.
   */
  function integrate(c: Craft, dt: number, skidH: number): void {
    const prevY = c.pos.y;

    const nx = c.pos.x + c.vel.x * dt;
    const nz = c.pos.z + c.vel.z * dt;
    if (!hullBlocked(c, nx, prevY, nz, c.yaw)) {
      c.pos.x = nx;
      c.pos.z = nz;
    } else if (!hullBlocked(c, nx, prevY, c.pos.z, c.yaw)) {
      c.pos.x = nx;
      bleed(c, 0, 1);
    } else if (!hullBlocked(c, c.pos.x, prevY, nz, c.yaw)) {
      c.pos.z = nz;
      bleed(c, 1, 0);
    } else {
      bleed(c, 1, 1);
    }

    const ny = c.pos.y + c.vel.y * dt;
    if (!hullBlocked(c, c.pos.x, ny, c.pos.z, c.yaw)) c.pos.y = ny;
    else c.vel.y = 0;

    /* ---- the ground ---- */
    const ground = groundBelow(c.pos.x, c.pos.z, prevY + 0.6);
    const floor = ground + skidH;
    c.clearance = Math.max(0, c.pos.y - floor);
    if (c.pos.y <= floor) {
      const sink = -Math.min(0, c.vel.y);
      c.pos.y = floor;
      c.vel.y = 0;
      if (c.phase !== "landed") touchdown(c, sink, ground);
    } else if (c.pos.y > floor + 0.35 && c.phase === "landed") {
      c.phase = "flying";
    }

    /* Belt and braces. Nothing can reach the kill plane with the ice at
     * `ICE_Y`, and a physics function that relies on that is one refactor
     * from a vehicle in the void. */
    if (c.pos.y < KILL_Y + 8) {
      c.pos.y = KILL_Y + 8;
      c.vel.y = Math.max(0, c.vel.y);
    }
  }

  function bleed(c: Craft, kx: number, kz: number): void {
    if (kx) c.vel.x *= 0.25;
    if (kz) c.vel.z *= 0.25;
    if (c.kind === "glider") {
      /* A glider that hit a tower is a glider that has finished flying. */
      c.airspeed *= 0.35;
      if (c.phase === "flying") {
        c.phase = "landed";
        landing = {
          score: 0,
          grade: "You found a tower",
          sink: 0,
          ground: 0,
          bank: c.bank,
          onIsland: true,
        };
      }
    }
  }

  /**
   * Arrival.
   *
   * For the powered craft it is a state change and nothing else. For the
   * glider it is the exam: how fast you were going down, how fast you were
   * going along, and whether a wing was still low when the skid touched.
   */
  function touchdown(c: Craft, sink: number, ground: number): void {
    c.phase = "landed";
    if (c.kind !== "glider") {
      c.vel.y = 0;
      return;
    }
    const groundSpeed = Math.hypot(c.vel.x, c.vel.z);
    const bank = Math.abs(c.bank);
    let score = 100 - sink * 6.5 - Math.max(0, groundSpeed - 28) * 2.2 - bank * 40;
    score = Math.max(0, Math.min(100, score));
    const onIsland = ground > ISLAND_Y - 120;
    landing = {
      score: Math.round(score),
      grade: gradeFor(score, sink, bank),
      sink,
      ground: groundSpeed,
      bank,
      onIsland,
    };
    /* The touchdown itself: keep the ground run, lose the descent. */
    c.airspeed = groundSpeed;
    c.gamma = 0;
    c.vel.y = 0;
  }

  function gradeFor(score: number, sink: number, bank: number): string {
    if (bank > 0.62) return "Wing down. Not elegant.";
    if (sink > 9) return "That was an arrival, not a landing";
    if (score > 90) return "Greased it";
    if (score > 76) return "Good landing";
    if (score > 58) return "Firm, but yours";
    if (score > 36) return "Heavy";
    return "You bounced";
  }

  /**
   * The soft fence at the shore.
   *
   * Powered craft do not care how dead the air is, so they get a tether
   * instead: past the lake's edge a gentle acceleration inward, growing with
   * distance. It never takes control away — you can fight it, and at full
   * boost you will win for a while — it simply makes going home the path of
   * least effort, which is what a fence in a world like this should do.
   */
  function tether(c: Craft, dt: number): void {
    const r = Math.hypot(c.pos.x, c.pos.z);
    if (r < LAKE_R * 0.9) return;
    const nx = c.pos.x / r;
    const nz = c.pos.z / r;
    const t = Math.min(1, (r - LAKE_R * 0.9) / (LAKE_R * 0.2));

    /* Take the outward part of the velocity away, in proportion. At the far
     * edge of the ramp it is taken away entirely, so no amount of throttle
     * gets any further — but it is taken away from the *radial component
     * only*, so you can still fly along the shore at full speed and it never
     * reads as a wall. */
    const vr = c.vel.x * nx + c.vel.z * nz;
    if (vr > 0) {
      c.vel.x -= nx * vr * t;
      c.vel.z -= nz * vr * t;
    }
    /* And a nudge home, so standing still out here drifts you back in. */
    const pull = t * 6;
    c.vel.x -= nx * pull * dt;
    c.vel.z -= nz * pull * dt;
  }

  /* =======================================================================
   * Boarding
   * ==================================================================== */

  function seatOf(c: Craft): { x: number; y: number; z: number } {
    return c.kind === "skiff" ? SKIFF.seat : c.kind === "glider" ? GLIDER.seat : LIFTER.seat;
  }

  function board(c: Craft): void {
    if (ride) return;
    ride = c;
    accum = 0;
    hudTimer = 0;
    c.idleGlow = 0;
    if (c.kind === "glider") {
      /* Back on the rail, wherever it landed: the glider is winched home the
       * moment somebody gets into it, which is both what happens to a real
       * one and the only way the second flight is as good as the first. */
      sendHome(c);
      c.alpha = GLIDER.alphaTrim;
      c.phase = "railed";
      landing = null;
    } else if (c.phase === "parked") {
      c.phase = "landed";
    }
    writeRideState(true);
  }

  /**
   * Where to stand somebody who has just got out.
   *
   * Four candidates round the hull and then the hull itself; the first with a
   * real surface within four metres of the skids and nothing solid over it
   * wins. If none of them do — you set the skiff down on the ice, or you put
   * the glider on the lake, both of which are things people will do on
   * purpose — the answer is the vehicle's own pad, because the alternative is
   * a player standing on a surface `surfaceAt` calls the void, falling six
   * hundred metres and being respawned by the kill plane. The fiction is the
   * retrieval winch; the reason is that a dismount must never be a trap.
   */
  /**
   * Where to stand somebody who has just got out.
   *
   * Four candidates round the hull and then the hull itself; the first with a
   * real surface within four and a half metres of the skids and nothing solid
   * over it wins. `found` says whether one did — if none of them did, the
   * caller is looking at a craft that is over the ice, over the void, or
   * simply still in the air, and the point returned is the pad instead.
   */
  const _exit = { x: 0, y: 0, z: 0, found: false };

  function exitPoint(c: Craft): typeof _exit {
    const R = (c.kind === "skiff" ? SKIFF.hullR : c.kind === "glider" ? GLIDER.hullR : LIFTER.hullR) + 1.3;
    const fx = -Math.sin(c.yaw);
    const fz = -Math.cos(c.yaw);
    for (let i = 0; i < 5; i++) {
      let px = c.pos.x;
      let pz = c.pos.z;
      if (i === 0) { px += fz * R; pz -= fx * R; }
      else if (i === 1) { px -= fz * R; pz += fx * R; }
      else if (i === 2) { px -= fx * R; pz -= fz * R; }
      else if (i === 3) { px += fx * R; pz += fz * R; }
      const sup = world.supportAt(px, pz, c.pos.y + 2.5);
      if (!Number.isFinite(sup)) continue;
      if (Math.abs(sup - c.pos.y) > 4.5) continue;
      if (world.blockedAt(px, pz, sup + 0.9)) continue;
      _exit.x = px;
      _exit.y = sup + 0.05;
      _exit.z = pz;
      _exit.found = true;
      return _exit;
    }
    _exit.x = c.pad.x;
    _exit.y = c.pad.y + 0.05;
    _exit.z = c.pad.z;
    _exit.found = false;
    return _exit;
  }

  /** Put a craft back on its pad, still and level. */
  function sendHome(c: Craft): void {
    const skidH =
      c.kind === "skiff" ? SKIFF.skidH : c.kind === "glider" ? GLIDER.skidH : LIFTER.skidH;
    c.pos.set(c.pad.x, c.pad.y + skidH, c.pad.z);
    c.yaw = c.pad.yaw;
    c.vel.set(0, 0, 0);
    c.airspeed = 0;
    c.gamma = 0;
    c.bank = 0;
    c.railRun = 0;
    c.yawRate = 0;
    c.pitch = 0;
    c.roll = 0;
  }

  /**
   * Get out.
   *
   * A craft left somewhere with a floor stays exactly where you put it —
   * parking the skiff on a roof is one of the better things you can do with
   * it. A craft left over the ice, over the void, or still in the air goes
   * home with you: the fiction is the retrieval winch, and the reason is that
   * a dismount must never strand the player on a surface `surfaceAt` calls
   * the void, six hundred metres up, to be caught by the kill plane.
   */
  function stepOut(): { x: number; y: number; z: number } | null {
    if (!ride) return null;
    const c = ride;
    const e = exitPoint(c);
    const out = { x: e.x, y: e.y, z: e.z };
    if (!e.found) sendHome(c);
    c.phase = "parked";
    c.yawRate = 0;
    c.vel.set(0, 0, 0);
    c.idleGlow = 1;
    ride = null;
    return out;
  }

  /* =======================================================================
   * HUD
   * ==================================================================== */

  function writeRideState(force: boolean): void {
    const c = ride;
    if (!c) return;
    const seat = seatOf(c);
    /* The seat, carried round by the hull's own attitude, so a banked skiff
     * carries the rider over with it instead of leaving them level in the
     * middle of a turn. */
    _seat.set(seat.x, seat.y, seat.z);
    _seatEuler.set(c.pitch, c.yaw, c.roll, "YXZ");
    _seat.applyEuler(_seatEuler).add(c.pos);

    rideState.x = _seat.x;
    rideState.y = _seat.y;
    rideState.z = _seat.z;
    rideState.yaw = c.yaw;
    rideState.pitch = c.pitch;
    /* Horizontal, to mean the same thing `EmpyreanState.speed` does — except
     * for a glider in flight, where the number a pilot wants is airspeed. */
    rideState.speed =
      c.kind === "glider" && c.phase === "flying" ? c.airspeed : Math.hypot(c.vel.x, c.vel.z);
    rideState.altitude = c.clearance;

    if (!force && hudTimer > 0) return;
    hudTimer = 0.1;
    rideState.label = LABEL[c.kind];
    const lines = rideState.lines;
    lines.length = 0;
    if (c.kind === "glider") {
      if (c.phase === "railed") {
        lines.push("On the rail — push forward to launch");
        lines.push("Neutral stick is best glide. Shift is the airbrake.");
      } else if (c.phase === "landed") {
        const l = landing;
        if (l) {
          lines.push(`${l.grade} — ${l.score}/100`);
          lines.push(`Touchdown ${l.sink.toFixed(1)} m/s down, ${l.ground.toFixed(0)} m/s along`);
          lines.push(l.onIsland ? "Back on the island." : "On the ice. The winch will fetch you.");
        } else {
          lines.push("Down.");
        }
      } else {
        const ratio = glideRatio(c.alpha, false);
        lines.push(`${c.airspeed.toFixed(0)} m/s · ${ratio.toFixed(1)} : 1`);
        // A variometer: the number a real pilot flies by is the total rate of
        // climb, not the sink through the air, because the whole game is
        // whether the air is going up faster than you are going down in it.
        lines.push(
          `Vario ${c.vel.y >= 0 ? "+" : ""}${c.vel.y.toFixed(1)} m/s · air ${c.air >= 0 ? "+" : ""}${c.air.toFixed(1)}`,
        );
        if (c.alpha > GLIDER.alphaStall) lines.push("STALL — stick forward");
        else if (c.air > 1.2) lines.push("Lift. Turn into it.");
        if (Math.hypot(c.pos.x, c.pos.z) > LAKE_R * 0.9) lines.push("Sinking air — turn back");
      }
    } else if (c.kind === "skiff") {
      const speed = Math.hypot(c.vel.x, c.vel.z);
      lines.push(`${speed.toFixed(0)} m/s · bank ${((c.roll * 180) / Math.PI).toFixed(0)}°`);
      lines.push(c.phase === "landed" ? "On the skids" : `${c.clearance.toFixed(0)} m clear below`);
    } else {
      lines.push(`${Math.hypot(c.vel.x, c.vel.z).toFixed(0)} m/s · ${c.clearance.toFixed(0)} m clear`);
      lines.push(c.phase === "landed" ? "Down and level" : "Hold Space to climb");
    }
  }

  const LABEL: Record<VehicleKind, string> = {
    skiff: "Sky skiff · Ember",
    glider: "Glider · Vesper",
    lifter: "Cargo lifter · Derrick",
  };

  /* =======================================================================
   * Interactables
   * ==================================================================== */

  /* The prompt follows the craft rather than its pad: park the skiff on a
   * roof and the way back into it has to be on the roof too. */
  const boardOffers: Interactable[] = crafts.map((c) => ({
    id: `vehicle-${c.kind}`,
    x: c.pos.x,
    y: c.pos.y,
    z: c.pos.z,
    radius: 7,
    label: BOARD_LABEL[c.kind],
    detail: BOARD_DETAIL[c.kind],
    enabled: () => ride === null,
    activate: () => board(c),
  }));

  const exitOffer: Interactable = {
    id: "vehicle-exit",
    x: 0,
    y: 0,
    z: 0,
    radius: 9,
    label: "Step out",
    detail: "",
    enabled: () => ride !== null,
    activate: () => {
      const p = stepOut();
      if (p) pendingExit = p;
    },
  };

  const offers: Interactable[] = [];

  /* =======================================================================
   * The system
   * ==================================================================== */

  const handle: VehiclesHandle = {
    name: "vehicles",
    group,
    reflected: false,

    pads,

    setWorld(w) {
      world = w;
      /* Settle every parked craft onto whatever is actually under it now
       * that there is something to ask. A pad computed from `surfaceAt` is
       * right about the deck and knows nothing about a plinth on it. */
      for (const c of crafts) {
        const skidH =
          c.kind === "skiff" ? SKIFF.skidH : c.kind === "glider" ? GLIDER.skidH : LIFTER.skidH;
        const g = groundBelow(c.pad.x, c.pad.z, c.pad.y + 3);
        c.pad.y = g;
        c.pos.y = g + skidH;
      }
    },

    interactables() {
      offers.length = 0;
      if (ride) {
        exitOffer.x = rideState.x;
        exitOffer.y = rideState.y;
        exitOffer.z = rideState.z;
        exitOffer.detail = ride.phase === "landed" || ride.phase === "railed"
          ? "Back on your feet"
          : "Not while you are up here";
        if (ride.phase === "landed" || ride.phase === "railed") offers.push(exitOffer);
      } else {
        for (let i = 0; i < boardOffers.length; i++) {
          const o = boardOffers[i];
          const c = crafts[i];
          o.x = c.pos.x;
          o.y = c.pos.y - 0.4;
          o.z = c.pos.z;
          offers.push(o);
        }
      }
      return offers;
    },

    riding() {
      return ride ? rideState : null;
    },

    ridingKind() {
      return ride ? ride.kind : null;
    },

    drive(input, dtRaw) {
      if (!ride) return;
      const dt = Math.min(Math.max(dtRaw, 0), 0.05);
      accum += dt;
      let steps = 0;
      while (accum >= FIXED && steps < MAX_STEPS) {
        stepOne(ride, input, FIXED);
        accum -= FIXED;
        steps++;
      }
      // A tab that was in the background for a minute does not get a minute
      // of catch-up; it gets the frame it is on.
      if (steps >= MAX_STEPS) accum = 0;
      hudTimer -= dt;
      writeRideState(false);
    },

    dismount() {
      if (pendingExit) {
        const p = pendingExit;
        pendingExit = null;
        return p;
      }
      return stepOut();
    },

    positionOf(kind, out) {
      const c = byKind.get(kind);
      return c ? out.copy(c.pos) : out.set(0, ISLAND_Y, 0);
    },

    lastLanding() {
      return landing;
    },

    update(frame: FrameContext) {
      time = frame.time;
      _sun.copy(frame.sunDir);
      sunBearing = Math.atan2(_sun.z, _sun.x);
      sunHeight = _sun.y;

      if (ride) writeRideState(false);

      for (let i = 0; i < crafts.length; i++) {
        const c = crafts[i];
        if (c !== ride) idle(c, frame.dt);
        c.group.position.copy(c.pos);
        c.group.rotation.set(c.pitch, c.yaw, c.roll);
      }

      /* The pad columns breathe, faster while nobody is aboard. */
      for (const m of columnMats.values()) {
        m.uniforms.uTime.value = frame.time;
        m.uniforms.uNight.value = 1 - frame.daylight * 0.55;
      }
    },

    dispose() {
      for (const d of disposables) d.dispose();
      group.clear();
    },
  };

  /** One fixed step of whichever craft is being ridden. */
  function stepOne(c: Craft, input: VehicleInput, dt: number): void {
    if (c.kind === "skiff") stepSkiff(c, input, dt);
    else if (c.kind === "lifter") stepLifter(c, input, dt);
    else stepGlider(c, input, dt);
  }

  /**
   * A parked craft.
   *
   * The lifter idles in a low hover with the fans running, because that is
   * what reads as "running" from a distance and it is the only one of the
   * three light enough on its feet to do it. The other two sit on their
   * skids: an open cockpit with nothing in it is a clearer invitation than
   * anything that moves.
   */
  function idle(c: Craft, dt: number): void {
    c.idleGlow = Math.min(1, c.idleGlow + dt * 0.6);
    /* Whatever attitude it was abandoned in, it comes back to level. A skiff
     * left banked over on a roof reads as crashed rather than as parked. */
    c.pitch += (0 - c.pitch) * ease(dt, 0.8);
    c.roll += (0 - c.roll) * ease(dt, 0.8);
    if (c.kind === "lifter") {
      const base = c.pad.y + LIFTER.skidH + 0.55;
      c.pos.y += (base + Math.sin(time * 0.9) * 0.12 - c.pos.y) * ease(dt, 0.9);
      c.pitch += Math.sin(time * 0.62) * 0.012 * ease(dt, 0.4);
      c.roll += Math.cos(time * 0.51) * 0.014 * ease(dt, 0.4);
    }
  }

  return handle;
}

/* =========================================================================
 * Maths
 * ====================================================================== */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * The frame-rate-independent easing factor for a time constant.
 *
 * `1 - exp(-dt/tau)`, everywhere, rather than `dt * k` — the second one is
 * the bug this world's sibling worlds have all had at least once, and it
 * makes every vehicle handle differently on a 144 Hz screen.
 */
function ease(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / tau);
}

function shortestAngle(a: number): number {
  let d = a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/* =========================================================================
 * Geometry
 *
 * All procedural, all `three` primitives, no assets and no textures — see the
 * root CLAUDE.md. Every geometry is registered with `keep` so `dispose` can
 * release it: this world runs on a WebGL context a browser will not give back
 * twice.
 * ====================================================================== */

type Keep = <T extends { dispose(): void }>(d: T) => T;

/**
 * The skiff.
 *
 * A shallow lifting-body hull with the cockpit cut into the top of it, two
 * intake pods on outriggers and a pair of curved skids. Read from thirty
 * metres it is the open seat that says "get in": the silhouette is deliberately
 * a scoop rather than a canopy.
 */
function buildSkiff(
  g: THREE.Group,
  hull: THREE.Material,
  dark: THREE.Material,
  warm: THREE.Material,
  glass: THREE.Material,
  glow: THREE.Material,
  keep: Keep,
  shadows: boolean,
): void {
  const body = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.95, 1.35, 5.4, 7, 1, false)), hull);
  body.rotation.x = Math.PI / 2;
  body.scale.set(1, 1, 0.42);
  body.position.y = 0.95;
  body.castShadow = shadows;
  g.add(body);

  const nose = new THREE.Mesh(keep(new THREE.ConeGeometry(0.95, 1.9, 7)), hull);
  nose.rotation.x = -Math.PI / 2;
  nose.scale.set(1, 1, 0.42);
  nose.position.set(0, 0.95, -3.05);
  nose.castShadow = shadows;
  g.add(nose);

  // The cockpit: a dark tub sunk into the deck with a low screen in front.
  const tub = new THREE.Mesh(keep(new THREE.BoxGeometry(1.15, 0.5, 1.9)), dark);
  tub.position.set(0, 1.22, 0.3);
  g.add(tub);

  const screen = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.72, 0.72, 0.62, 12, 1, true, -1.1, 2.2)), glass);
  screen.position.set(0, 1.62, -0.72);
  g.add(screen);

  const seat = new THREE.Mesh(keep(new THREE.BoxGeometry(0.72, 0.72, 0.2)), warm);
  seat.position.set(0, 1.62, 1.02);
  g.add(seat);

  // Intake pods on short outriggers. The glowing throat is the "it is on" cue.
  const podGeo = keep(new THREE.CylinderGeometry(0.46, 0.52, 2.0, 10, 1, true));
  const throatGeo = keep(new THREE.CircleGeometry(0.42, 10));
  const armGeo = keep(new THREE.BoxGeometry(0.9, 0.16, 0.5));
  for (const side of [-1, 1]) {
    const pod = new THREE.Mesh(podGeo, warm);
    pod.rotation.x = Math.PI / 2;
    pod.position.set(side * 1.55, 0.86, 0.65);
    pod.castShadow = shadows;
    g.add(pod);

    const throat = new THREE.Mesh(throatGeo, glow);
    throat.position.set(side * 1.55, 0.86, 1.66);
    g.add(throat);

    const arm = new THREE.Mesh(armGeo, dark);
    arm.position.set(side * 0.95, 0.86, 0.65);
    g.add(arm);
  }

  // Skids: two curved rails, so it has something to settle onto.
  const skidGeo = keep(new THREE.TorusGeometry(1.6, 0.09, 5, 10, Math.PI * 0.55));
  const legGeo = keep(new THREE.BoxGeometry(0.12, 0.5, 0.12));
  for (const side of [-1, 1]) {
    const skid = new THREE.Mesh(skidGeo, dark);
    skid.rotation.set(Math.PI / 2, 0, Math.PI * 0.72);
    skid.position.set(side * 0.95, 0.42, 0.1);
    g.add(skid);
    for (const zz of [-1.1, 1.1]) {
      const leg = new THREE.Mesh(legGeo, dark);
      leg.position.set(side * 0.95, 0.62, zz);
      g.add(leg);
    }
  }

  const fin = new THREE.Mesh(keep(new THREE.BoxGeometry(0.1, 1.0, 1.3)), warm);
  fin.position.set(0, 1.55, 2.2);
  fin.rotation.x = -0.22;
  g.add(fin);

  const stripe = new THREE.Mesh(keep(new THREE.BoxGeometry(0.06, 0.1, 3.6)), glow);
  for (const side of [-1, 1]) {
    const s = stripe.clone();
    s.position.set(side * 1.0, 1.14, 0.1);
    g.add(s);
  }
}

/**
 * The glider.
 *
 * Sixteen metres of wing on a five-metre pod, with a V-tail and one nose
 * skid. The span is the whole silhouette and it is the reason this is the one
 * you can pick out from the far side of the island: nothing else in the world
 * is that wide and that thin.
 */
function buildGlider(
  g: THREE.Group,
  hull: THREE.Material,
  dark: THREE.Material,
  glass: THREE.Material,
  glow: THREE.Material,
  keep: Keep,
  shadows: boolean,
): void {
  const half = GLIDER.span / 2;

  const pod = new THREE.Mesh(keep(new THREE.CapsuleGeometry(0.44, 2.6, 4, 10)), hull);
  pod.rotation.x = Math.PI / 2;
  pod.position.set(0, 0.72, -0.4);
  pod.castShadow = shadows;
  g.add(pod);

  const boom = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.2, 0.07, 3.4, 8)), hull);
  boom.rotation.x = Math.PI / 2;
  boom.position.set(0, 0.78, 2.4);
  g.add(boom);

  const canopy = new THREE.Mesh(keep(new THREE.SphereGeometry(0.5, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55)), glass);
  canopy.position.set(0, 0.98, -1.1);
  canopy.scale.set(1, 0.9, 1.9);
  g.add(canopy);

  /* The wing: a tapered, slightly swept plate with dihedral, made from two
   * boxes rather than one so each half can be tilted on its own. A single
   * flat plank reads as a paper aeroplane; three degrees of dihedral is the
   * difference between a toy and an aircraft. */
  const wingGeo = keep(new THREE.BoxGeometry(half, 0.1, 1.25));
  for (const side of [-1, 1]) {
    const w = new THREE.Mesh(wingGeo, hull);
    w.position.set((side * half) / 2, 0.92, -0.15);
    w.rotation.z = side * 0.055;
    w.rotation.y = side * -0.06;
    w.scale.z = 1;
    w.castShadow = shadows;
    g.add(w);

    const tip = new THREE.Mesh(keep(new THREE.BoxGeometry(0.5, 0.1, 0.7)), glow);
    tip.position.set(side * (half - 0.1), 0.92 + side * side * 0.02 + half * 0.055 * 0.5, -0.15);
    tip.rotation.z = side * 0.055;
    g.add(tip);
  }

  // V-tail, because a T-tail on a fifteen-metre span looks like a model.
  const tailGeo = keep(new THREE.BoxGeometry(2.2, 0.08, 0.75));
  for (const side of [-1, 1]) {
    const t = new THREE.Mesh(tailGeo, hull);
    t.position.set(side * 0.85, 1.28, 3.7);
    t.rotation.z = side * 0.62;
    g.add(t);
  }

  const skid = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.14, 0.14, 1.6, 8)), dark);
  skid.rotation.x = Math.PI / 2;
  skid.position.set(0, 0.16, -0.5);
  g.add(skid);

  const stripe = new THREE.Mesh(keep(new THREE.BoxGeometry(0.14, 0.06, 2.6)), glow);
  stripe.position.set(0, 1.14, -0.4);
  g.add(stripe);
}

/**
 * The lifter.
 *
 * A flat load deck, four ducted fans on outriggers, a cage over the pilot and
 * a hook underneath. It is the only one of the three with no aerodynamic
 * shape at all, on purpose: it should look like it works for a living.
 */
function buildLifter(
  g: THREE.Group,
  hull: THREE.Material,
  dark: THREE.Material,
  warm: THREE.Material,
  glow: THREE.Material,
  keep: Keep,
  shadows: boolean,
): void {
  const deck = new THREE.Mesh(keep(new THREE.BoxGeometry(2.6, 0.3, 3.4)), hull);
  deck.position.y = 0.8;
  deck.castShadow = shadows;
  g.add(deck);

  const cage = new THREE.Mesh(keep(new THREE.TorusGeometry(0.95, 0.07, 5, 12, Math.PI)), warm);
  cage.position.set(0, 0.95, -1.0);
  cage.rotation.y = Math.PI / 2;
  g.add(cage);

  const post = new THREE.Mesh(keep(new THREE.BoxGeometry(0.16, 1.5, 0.16)), dark);
  for (const sx of [-1, 1]) {
    const p = post.clone();
    p.position.set(sx * 0.95, 1.6, 1.4);
    g.add(p);
  }
  const roof = new THREE.Mesh(keep(new THREE.BoxGeometry(2.2, 0.12, 1.1)), dark);
  roof.position.set(0, 2.32, 1.2);
  g.add(roof);

  const ductGeo = keep(new THREE.TorusGeometry(1.0, 0.2, 6, 16));
  const bladeGeo = keep(new THREE.BoxGeometry(1.7, 0.05, 0.22));
  const armGeo = keep(new THREE.BoxGeometry(1.5, 0.16, 0.3));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const duct = new THREE.Mesh(ductGeo, dark);
      duct.rotation.x = Math.PI / 2;
      duct.position.set(sx * 2.15, 1.05, sz * 1.5);
      duct.castShadow = shadows;
      g.add(duct);

      const blade = new THREE.Mesh(bladeGeo, warm);
      blade.position.set(sx * 2.15, 1.05, sz * 1.5);
      blade.rotation.y = sx * sz * 0.4;
      g.add(blade);

      const arm = new THREE.Mesh(armGeo, hull);
      arm.position.set(sx * 1.45, 1.05, sz * 1.5);
      g.add(arm);
    }
  }

  const skidGeo = keep(new THREE.BoxGeometry(0.16, 0.16, 4.0));
  const legGeo = keep(new THREE.BoxGeometry(0.14, 0.55, 0.14));
  for (const sx of [-1, 1]) {
    const s = new THREE.Mesh(skidGeo, dark);
    s.position.set(sx * 1.05, 0.12, 0);
    g.add(s);
    for (const sz of [-1.4, 1.4]) {
      const l = new THREE.Mesh(legGeo, dark);
      l.position.set(sx * 1.05, 0.42, sz);
      g.add(l);
    }
  }

  const hook = new THREE.Mesh(keep(new THREE.TorusGeometry(0.22, 0.06, 5, 10)), warm);
  hook.position.set(0, 0.42, 0);
  g.add(hook);

  const beacon = new THREE.Mesh(keep(new THREE.SphereGeometry(0.16, 8, 6)), glow);
  beacon.position.set(0, 2.5, 1.2);
  g.add(beacon);
}

/**
 * The pad.
 *
 * A painted ring, three pylons, and a forty-metre column of soft light. The
 * column is the part that does the work: a parked skiff is two metres tall on
 * a deck full of two-metre things, and the whole brief for these was that you
 * can find one. The column is additive and unlit, so the bloom in `postfx.ts`
 * turns it into a landmark from the far side of the island without costing a
 * light.
 */
function buildPad(
  pad: VehiclePad,
  accent: number,
  columnMat: THREE.ShaderMaterial,
  glow: THREE.Material,
  keep: Keep,
): THREE.Group {
  const g = new THREE.Group();
  g.name = `empyrean-pad-${pad.kind}`;
  g.position.set(pad.x, pad.y + 0.03, pad.z);
  g.rotation.y = pad.yaw;

  const ring = new THREE.Mesh(
    keep(new THREE.RingGeometry(6.4, 7.4, 40)),
    keep(
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(accent).multiplyScalar(0.9),
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    ),
  );
  ring.rotation.x = -Math.PI / 2;
  g.add(ring);

  const chevron = new THREE.Mesh(keep(new THREE.RingGeometry(3.2, 3.6, 24, 1, -0.5, 1.0)), glow);
  chevron.rotation.x = -Math.PI / 2;
  chevron.position.z = -1.5;
  g.add(chevron);

  const pylonGeo = keep(new THREE.CylinderGeometry(0.12, 0.18, 1.5, 6));
  const capGeo = keep(new THREE.SphereGeometry(0.2, 8, 6));
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i / 3) * Math.PI * 2;
    const px = Math.cos(a) * 6.9;
    const pz = Math.sin(a) * 6.9;
    const p = new THREE.Mesh(pylonGeo, keep(new THREE.MeshStandardMaterial({ color: 0x333a46, roughness: 0.7 })));
    p.position.set(px, 0.75, pz);
    g.add(p);
    const cap = new THREE.Mesh(capGeo, glow);
    cap.position.set(px, 1.6, pz);
    g.add(cap);
  }

  const column = new THREE.Mesh(keep(new THREE.CylinderGeometry(1.5, 2.6, 40, 12, 1, true)), columnMat);
  column.position.y = 20;
  column.frustumCulled = false;
  g.add(column);

  return g;
}

/**
 * The light column's material.
 *
 * Additive, unlit, fog-free and fading out with height, with a slow travelling
 * band so it reads as alive rather than as a decal. It brightens at night —
 * `uNight` — for the same reason every lamp in the city does.
 */
function padColumnMaterial(accent: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "EmpyreanPadColumn",
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uNight: { value: 1 },
      uColor: { value: new THREE.Color(accent) },
    },
    vertexShader: /* glsl */ `
      varying float vH;
      void main() {
        vH = uv.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime;
      uniform float uNight;
      uniform vec3 uColor;
      varying float vH;
      void main() {
        float fade = pow(1.0 - vH, 2.2);
        float band = 0.5 + 0.5 * sin((vH - uTime * 0.11) * 22.0);
        float a = fade * (0.22 + 0.18 * band) * uNight;
        gl_FragColor = vec4(uColor * (0.9 + band * 0.5), a);
      }
    `,
  });
}

const BOARD_LABEL: Record<VehicleKind, string> = {
  skiff: "Take the skiff",
  glider: "Take the glider",
  lifter: "Take the lifter",
};

const BOARD_DETAIL: Record<VehicleKind, string> = {
  skiff: "Ember · fast, heavy, and it slides",
  glider: "Vesper · no engine. Find the lift.",
  lifter: "Derrick · slow, steady, goes straight up",
};
