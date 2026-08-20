/**
 * Four things you can get into.
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
 * **The flyer** is the one for somebody who has never flown anything. There
 * are seven of them, parked on pads on rooftops around the city, and the
 * whole design brief was that a person can walk up to one, get in, and be
 * flying between the towers inside ten seconds with nobody having explained
 * anything. So it cannot stall, it cannot spin, it cannot run out of
 * anything, and it cannot fall out of the sky: bank and climb are *commands*
 * rather than forces, the throttle sets a speed and holds it, and below a
 * soft floor the nose comes up on its own rather than arriving in the snow at
 * sixty metres a second. See `FLYER` for the whole model in one block.
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
 * | flyer `Wren` | the Halo apron, beside the avenue you arrive on | one flyer has to be reachable on foot; the jetpack is how you get to the other six and not everybody has found it yet |
 * | flyers ×6 | mid-rise rooftops, one per sixth of the compass | see `roofSpots` — chosen by a rule over `cityPlan().lots`, never by pasted coordinates |
 *
 * Each pad is a painted ring, pylons and a column of soft light, so all of
 * them read as "you can get in this" from well past thirty metres and from
 * the air, which is where most people will first see them.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

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
import { cityPlan, HALO_R, LANDMARKS, RIM_R, surfaceAt, type Lot, type Vec2 } from "./cityplan";

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
  /**
   * World velocity of the craft, m/s.
   *
   * Here so the engine can hand it to the body while somebody is riding.
   * `world.ts` currently zeroes `flyer.velocity` aboard a vehicle, which is
   * true of the *legs* and wrong for everything that reads it: the camera rig
   * takes its field of view from that vector, so the one thing in the toolbox
   * that conveys speed is switched off in the only situations where this
   * world goes fast. Copying these three numbers into it instead is the whole
   * fix, and it also puts a real number back on the HUD's speed readout.
   */
  vx: number;
  vy: number;
  vz: number;
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

export type VehicleKind = "skiff" | "glider" | "lifter" | "flyer";

export interface VehiclePad {
  kind: VehicleKind;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /**
   * The lot whose roof this pad stands on, when it stands on one.
   *
   * Absent for the four pads on the ground. Present ones are the contract
   * with `buildings.ts`: `y` is that lot's `y + height`, which is where its
   * roof deck is, and a test checks that the deck the collision world reports
   * agrees.
   */
  roofLot?: string;
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
 * Deliberately more than the deepest step in `DECKS` — it has to cover the
 * whole rim wall and the underside of every promenade ring, and being too
 * generous only means a vehicle stops a few metres early against solid rock,
 * while being too mean means it flies through the island. It is read as a
 * slab rather than "everything below", so the keel stays open air: flying
 * under the island is one of the better things this world offers, and the
 * spike is a shape a pilot can see and avoid.
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
 * The flyer: the aircraft for somebody who has never flown one.
 *
 * Every number here exists to remove a way of getting it wrong, and the model
 * is four rules:
 *
 * 1. **The throttle is a speed, not a thrust.** `W` and `S` move a throttle
 *    setting between 0 and 1 at `throttleRate` a second and it *stays* where
 *    you left it; the craft eases to `throttle × vCruise` and holds it. There
 *    is no airspeed to manage, nothing to keep above, and letting go of every
 *    key leaves you flying straight and level at whatever you had.
 * 2. **Bank is a command.** `A`/`D` roll the craft to at most `bankMax` and it
 *    rolls back to level the moment you let go. The turn rate is derived from
 *    the bank the way a real coordinated turn is — `g·tan(φ)/v` — so the
 *    aircraft always looks like it is doing what it is doing, but with a
 *    `vTurnRef` floor under the speed and a hard cap on the rate, because the
 *    honest formula turns a slow aircraft on the spot and that reads as a
 *    twitch rather than as agility.
 * 3. **It cannot be flown into the ground.** Above `floorSpeed` a soft floor
 *    holds `floor` metres of clearance over whatever is coming, sampled ahead
 *    in proportion to speed: fly at the snow at full throttle and the nose
 *    comes up on its own. Below `floorSpeed` the floor lets go, because
 *    otherwise you could never land.
 * 4. **Down is the throttle, and landing is the same action as stopping.**
 *    Close the throttle and it settles at `vSettle`, cushioned to nothing as
 *    the skids arrive; hold `S` with the throttle already shut and it comes
 *    down at `vDive`, which is the way back from nine hundred metres. Open
 *    the throttle on the ground and it lifts itself off at `vHop` rather than
 *    asking you to know that `Space` exists.
 *
 * There is deliberately no stall, no spin, no fuel and no damage. The worst
 * thing that can happen is that you stop against a wall, which costs you your
 * throttle setting and nothing else.
 */
const FLYER = {
  /** Cruise and boost. The skiff's are 31 and 47; this is the fast one. */
  vCruise: 58,
  vBoost: 84,
  /** Spool up, and the rather firmer rate it sheds speed at. */
  tauSpeed: 1.7,
  tauBrake: 1.1,
  /** How fast W and S move the throttle setting, per second. */
  throttleRate: 0.62,
  /** At or below this the throttle counts as shut. */
  idleThrottle: 0.02,
  /** Roll authority and how long it takes to get there. Not twitchy. */
  bankMax: 0.62,
  tauBank: 0.55,
  /** Turn rate is `tan(bank)·g·turnGain / max(vTurnRef, v)`, capped. */
  turnGain: 2.8,
  vTurnRef: 26,
  yawRateMax: 1.0,
  /** Climb on the lift key, and the two ways down. */
  vRise: 16,
  vDive: 18,
  vSettle: 3.4,
  tauVert: 0.8,
  /** Metres of clearance over which the settle is throttled back to nothing. */
  cushion: 4.2,
  /** Below this much clearance, opening the throttle lifts it off. */
  hop: 5.0,
  vHop: 5.2,
  /** The soft floor: metres of clearance held, and the speed it works above. */
  floor: 24,
  floorSpeed: 12,
  /** Seconds of travel to look ahead when asking what the ground is doing. */
  floorLook: 1.9,
  /** Hull half-extent against `blockedAt`. The span is 7 m. */
  hullR: 3.6,
  skidH: 0.55,
  seat: { x: 0, y: 0.66, z: 0.15 },
  ceiling: ISLAND_Y + 480,
  /** Outer radius of the painted pad, and the light column over it. */
  padR: 4.6,
  columnH: 26,
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

/** Where the skiff stands, in metres round the arc from the terrace. */
const SKIFF_R = RIM_R - 26;

/**
 * The three pads, as intended. `resolvePads` gets the last word.
 *
 * The skiff stands just outside the Launch Terrace's own clear radius —
 * `clear` is not empty ground, it is the footprint of the landmark's
 * *structure*, and the first version of this parked the skiff ten metres
 * inside the terrace building. Nothing caught it: the collision world is
 * handed over at `setWorld`, so every test that used a synthetic one saw open
 * pavement, and the only symptom in the real world was a camera inside a wall.
 *
 * The glider is on the first promenade at the foot of the south-west avenue's
 * stairs — you walk out the avenue, down the gate, and the rail is there
 * pointing off the edge, at the face of the rock the sun is on when the world
 * opens. The lifter is on the Halo, clear of the Beacon's skirt and the
 * Cistern.
 */
const PADS: VehiclePad[] = [
  padAt("skiff", "Ember", LAUNCH_A + (LAUNCH.clear + 10) / SKIFF_R, SKIFF_R, true),
  padAt("glider", "Vesper", -Math.PI * 0.75, DECKS[1].outer - DECKS[1].width * 0.5, true),
  padAt("lifter", "Derrick", -Math.PI * 0.25, 42, false),
];

/* -------------------------------------------------------------------------
 * The rooftop pads
 * ---------------------------------------------------------------------- */

/**
 * Names for the fleet, in the order the pads come out of the rule.
 *
 * The first is the one on the ground; a flyer nobody can reach without the
 * jetpack is a flyer half the visitors never find, and "work out the jetpack"
 * is not a reasonable price of entry for the thing this world is *for*.
 */
const FLYER_NAMES = ["Wren", "Kestrel", "Swift", "Martin", "Tern", "Pipit", "Lark"] as const;

/** How many rooftop pads, and therefore how many sixths of the compass. */
const ROOF_PADS = 6;

/**
 * No district may hold more than this many rooftop pads until every sixth of
 * the compass has one. `block` lots exist in exactly two districts, and the
 * Bazaar's are the taller of the two, so without this the whole fleet parks
 * in the Bazaar and "spread across the city" quietly means "spread across
 * half of it".
 */
const ROOF_PER_DISTRICT = 3;

/**
 * How much clear roof a pad needs around its centre, in metres.
 *
 * `FLYER.padR` of paint plus a margin, and comfortably more than the 3.5 m
 * half-span of the aircraft. Measured to the lot's own polygon and then
 * discounted by `ROOF_EDGE`, which is what `buildings.ts` takes off the lot
 * before it builds: `LOT_INSET` of 1.2 and another 0.35 for the parapet it
 * stands a wall on. Neither number is importable from here — that is the
 * system rule — so they are written down, and `empyreanVehicles.test.ts`
 * checks the answer against the collision world the engine really hands over
 * rather than against this arithmetic.
 */
const ROOF_CLEAR = FLYER.padR + 1.2;
const ROOF_EDGE = 1.55;

/**
 * How far off the middle of the roof the pad sits.
 *
 * Every `block` roof has a head-house on it — `buildings.ts` puts a 3.6 × 2.8
 * box at the centroid of every parapet it closes — so the middle of a roof is
 * the one place a pad may not go. Six metres out clears its corner with the
 * aircraft's tail, and the nose is pointed *away* from it, so the take-off
 * run is over the parapet rather than through the stair hut.
 */
const ROOF_OFFSETS = [5.5, 6.5] as const;

/** A candidate rooftop, ranked. */
interface RoofSpot {
  lot: string;
  district: string;
  x: number;
  z: number;
  y: number;
  yaw: number;
  /** Clear roof around the pad centre, m. Bigger is better. */
  clear: number;
  /** Height of the roof above the deck it stands on. */
  rise: number;
}

/** Shortest distance from a point to a polygon's edges. */
function polyClearance(poly: Vec2[], px: number, pz: number): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 1e-9 ? ((px - p.x) * dx + (pz - p.z) * dz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(px - (p.x + dx * t), pz - (p.z + dz * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * The best pad spot on one lot's roof, or null if it has not got one.
 *
 * Sixteen bearings by two offsets, and the one with the most clear roof round
 * it wins. A scan rather than a formula because the lots are trapezoids of
 * every proportion the plan felt like — the widest direction on a Bazaar
 * block is not the widest direction on a Terraces one, and a rule that
 * assumed either would put half the fleet through a parapet.
 */
function bestRoofSpot(lot: Lot): RoofSpot | null {
  const c = lot.centroid;
  let best: RoofSpot | null = null;
  for (let k = 0; k < 16; k++) {
    const th = (k / 16) * Math.PI * 2;
    const dx = Math.cos(th);
    const dz = Math.sin(th);
    for (const off of ROOF_OFFSETS) {
      const px = c.x + dx * off;
      const pz = c.z + dz * off;
      const clear = polyClearance(lot.poly, px, pz) - ROOF_EDGE;
      if (best && clear <= best.clear) continue;
      best = {
        lot: lot.id,
        district: lot.district,
        x: px,
        z: pz,
        y: lot.y + lot.height,
        // Nose away from the head-house, so the run is out over the parapet.
        yaw: yawTowards(dx, dz),
        clear,
        rise: lot.height,
      };
    }
  }
  return best && best.clear >= ROOF_CLEAR ? best : null;
}

/**
 * Which sixth of the compass a point is in.
 *
 * Sectors rather than "every nth lot" because the plan is radial and the
 * thing a player notices is whether there is a pad on *their* side of the
 * island, not whether the list is evenly indexed.
 */
function sectorOf(x: number, z: number): number {
  const a = Math.atan2(z, x);
  const t = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return Math.min(ROOF_PADS - 1, Math.floor((t / (Math.PI * 2)) * ROOF_PADS));
}

/**
 * Where the rooftop pads go, and the fallbacks if the built world disagrees.
 *
 * **The rule, in one sentence:** one pad per sixth of the compass, on the
 * tallest `block` lot in that sixth whose roof has `ROOF_CLEAR` metres of
 * space somewhere on it — with no district taking more than half of them
 * until every sixth has been served.
 *
 * `use === "block"` is the whole reason this is safe to write against the
 * plan rather than against the geometry: those lots and only those get a flat
 * roof deck registered at exactly `lot.y + lot.height`, which is a contract
 * `buildings.ts` states and does not drift. Towers taper and their crowns are
 * built at whatever the taper arrived at; shops are three storeys of nothing
 * much; gardens have no roof at all.
 *
 * Each bucket is a *ranked list*, not a point. The plan knows where the lots
 * are and nothing about what was built on them, and blockers are the bounding
 * boxes of polygons, so a tall neighbour on a diagonal can cover a roof that
 * the plan says is open. `resolvePads` walks the list against the real
 * collision world and takes the first that holds an aircraft.
 */
let _roofSpots: RoofSpot[][] | null = null;

function roofSpots(): RoofSpot[][] {
  if (_roofSpots) return _roofSpots;

  const cands: RoofSpot[] = [];
  for (const lot of cityPlan().lots) {
    if (lot.use !== "block" || lot.height < 18) continue;
    const spot = bestRoofSpot(lot);
    if (spot) cands.push(spot);
  }
  // Tallest first, ties broken by id so the fleet is the same every boot.
  cands.sort((a, b) => b.rise - a.rise || (a.lot < b.lot ? -1 : 1));

  const buckets: RoofSpot[][] = Array.from({ length: ROOF_PADS }, () => []);
  const taken = new Array<boolean>(ROOF_PADS).fill(false);
  const perDistrict = new Map<string, number>();

  /* Two passes. The first honours the district cap, which is what spreads the
   * fleet over both districts that have `block` lots; the second fills any
   * sixth the cap starved, because an empty sixth is a worse outcome than an
   * uneven split. */
  for (const capped of [true, false]) {
    for (const s of cands) {
      const sec = sectorOf(s.x, s.z);
      if (taken[sec]) continue;
      const n = perDistrict.get(s.district) ?? 0;
      if (capped && n >= ROOF_PER_DISTRICT) continue;
      taken[sec] = true;
      perDistrict.set(s.district, n + 1);
      buckets[sec].push(s);
    }
  }
  // Everything else in the sixth, in rank order, as the fallback list.
  for (const s of cands) {
    const sec = sectorOf(s.x, s.z);
    if (buckets[sec][0] !== s) buckets[sec].push(s);
  }

  _roofSpots = buckets.filter((b) => b.length > 0);
  return _roofSpots;
}

/**
 * The pad you can walk to.
 *
 * On the Halo apron beside the avenue you arrive on, about thirty-five metres
 * from the spawn point. Reaching a roof is the player's problem and the
 * jetpack is the answer, but "find the jetpack" cannot be the price of the
 * first flight — somebody who has just arrived should be able to walk to an
 * aircraft, and this is it. `resolvePads` settles it onto whatever is really
 * there, exactly as it does for the other three on the ground.
 */
const APRON_A = Math.PI * 0.5 + 0.15;
const APRON_R = HALO_R + 16;

/* =========================================================================
 * State
 * ====================================================================== */

type Phase = "parked" | "railed" | "flying" | "landed";

interface Craft {
  kind: VehicleKind;
  pad: VehiclePad;
  /**
   * The object this craft is drawn as, or null when it is an instance.
   *
   * The three one-offs each get a group of three merged meshes. The flyers do
   * not: seven of them would be twenty-one more draw calls for a system whose
   * whole budget is twenty, so the fleet is three `InstancedMesh`es and a
   * craft carries the index of its own instance instead.
   */
  group: THREE.Group | null;
  /** Index into the flyer instance buffers, or -1. */
  inst: number;
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
  /* ---- flyer ---- */
  /** 0..1. Where the player left the throttle. It stays there. */
  throttle: number;
  /** Forward speed the throttle is holding, m/s. */
  speedHold: number;
  /** The rooftops this one may stand on, best first. Null for the ground pads. */
  spots: RoofSpot[] | null;
  /** HUD label, built once rather than per readout. */
  label: string;
}

/* ---- scratch. Made once, mutated for ever. ---- */
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _seat = new THREE.Vector3();
const _sun = new THREE.Vector3(0, 0, -1);
const _seatEuler = new THREE.Euler(0, 0, 0, "YXZ");
/* ---- and the ones the instanced fleet is placed with ---- */
const _instM = new THREE.Matrix4();
const _instQ = new THREE.Quaternion();
const _instE = new THREE.Euler(0, 0, 0, "YXZ");
const _instOne = new THREE.Vector3(1, 1, 1);

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
  /* The four on the ground, then one per rooftop bucket. The rooftop pads are
   * nominal here — `resolvePads` walks each bucket against the real collision
   * world and may take a different roof entirely. */
  const spotLists = roofSpots();
  const pads: VehiclePad[] = [
    ...PADS.map((p) => ({ ...p })),
    padAt("flyer", FLYER_NAMES[0], APRON_A, APRON_R, true),
    ...spotLists.map((list, i) => ({
      kind: "flyer" as const,
      name: FLYER_NAMES[(i + 1) % FLYER_NAMES.length],
      x: list[0].x,
      y: list[0].y,
      z: list[0].z,
      yaw: list[0].yaw,
      roofLot: list[0].lot,
    })),
  ];

  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(d: T): T => {
    disposables.push(d);
    return d;
  };

  /* ---- materials -------------------------------------------------------
   *
   * Four, for three vehicles and three pads, and every one of them is shared.
   *
   * The first version had eight materials and thirty-odd meshes per craft,
   * which was eighty-three draw calls for four thousand triangles — more
   * calls than the entire city, whose hundred and eighty-two buildings are
   * four. Every one of those calls is a state change and a validation pass in
   * the browser's GL layer, and on a phone a few hundred is where it starts
   * to hurt; the triangles were never the problem.
   *
   * The fix is the one the rest of this world already uses: colour lives in a
   * vertex attribute rather than in a material, so every part of a craft that
   * is lit can be one merged geometry and one call. What is left is the two
   * things that genuinely cannot share a program with it — the transparent
   * canopy, and the unlit additive glow the bloom pass turns into light. */
  const matBody = keep(
    new THREE.MeshStandardMaterial({
      name: "EmpyreanVehicleBody",
      vertexColors: true,
      roughness: 0.44,
      metalness: 0.5,
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
  const matGlow = keep(
    new THREE.MeshBasicMaterial({
      name: "EmpyreanVehicleGlow",
      vertexColors: true,
      toneMapped: false,
      fog: false,
    }),
  );
  const matColumn = keep(padColumnMaterial());

  /* ---- geometry -------------------------------------------------------- */
  const crafts: Craft[] = [];
  const byKind = new Map<VehicleKind, Craft>();

  const flyerCount = pads.reduce((n, p) => n + (p.kind === "flyer" ? 1 : 0), 0);
  let flyerIndex = 0;

  for (const pad of pads) {
    const flyer = pad.kind === "flyer";
    let g: THREE.Group | null = null;

    if (!flyer) {
      g = new THREE.Group();
      g.name = `empyrean-${pad.kind}`;
      g.rotation.order = "YXZ";

      const bin: CraftParts = { body: [], glass: [], glow: [] };
      const accent = ACCENT[pad.kind];
      if (pad.kind === "skiff") skiffParts(bin, accent);
      else if (pad.kind === "glider") gliderParts(bin, accent);
      else lifterParts(bin, accent);

      flush(g, bin.body, matBody, `empyrean-${pad.kind}-body`, !low, keep);
      flush(g, bin.glass, matGlass, `empyrean-${pad.kind}-glass`, false, keep);
      flush(g, bin.glow, matGlow, `empyrean-${pad.kind}-glow`, false, keep);
      group.add(g);
    }

    const c: Craft = {
      kind: pad.kind,
      pad,
      group: g,
      inst: flyer ? flyerIndex++ : -1,
      pos: new THREE.Vector3(pad.x, pad.y + skidOf(pad.kind), pad.z),
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
      throttle: 0,
      speedHold: 0,
      spots: null,
      label: flyer ? `Skyflyer · ${pad.name}` : LABEL[pad.kind],
    };
    crafts.push(c);
    if (!byKind.has(pad.kind)) byKind.set(pad.kind, c);
  }

  /* Hand each rooftop flyer its bucket of candidate roofs. The apron one — the
   * first flyer in the list — has none and is settled by the arc walk that
   * places the other three ground pads. */
  {
    let i = 0;
    for (const c of crafts) {
      if (c.kind !== "flyer" || !c.pad.roofLot) continue;
      c.spots = spotLists[i++] ?? null;
    }
  }

  /* ---- the fleet, as three draws --------------------------------------
   *
   * One merged geometry per program, `flyerCount` instances of each. This is
   * the shape the permanent test in this repo exists to enforce: a population
   * that is not an `InstancedMesh` is a population that updated its state
   * perfectly and left all its geometry at the origin, which is exactly what
   * happened to the ring tram. Frustum culling is off because the instance
   * bounding sphere three caches is computed once and these move. */
  let flyerBody: THREE.InstancedMesh | null = null;
  let flyerGlass: THREE.InstancedMesh | null = null;
  let flyerGlow: THREE.InstancedMesh | null = null;
  if (flyerCount > 0) {
    const bin: CraftParts = { body: [], glass: [], glow: [] };
    flyerParts(bin, ACCENT.flyer);
    flyerBody = fleet(group, bin.body, matBody, "empyrean-flyer-body", !low, keep, flyerCount);
    flyerGlass = fleet(group, bin.glass, matGlass, "empyrean-flyer-glass", false, keep, flyerCount);
    flyerGlow = fleet(group, bin.glow, matGlow, "empyrean-flyer-glow", false, keep, flyerCount);
  }

  /** Write one flyer's transform into every instance buffer it appears in. */
  function placeFlyer(c: Craft): void {
    if (c.inst < 0) return;
    _instE.set(c.pitch, c.yaw, c.roll, "YXZ");
    _instQ.setFromEuler(_instE);
    _instM.compose(c.pos, _instQ, _instOne);
    flyerBody?.setMatrixAt(c.inst, _instM);
    flyerGlass?.setMatrixAt(c.inst, _instM);
    flyerGlow?.setMatrixAt(c.inst, _instM);
  }

  /**
   * The pads, merged in world space — once, and not until somebody has told
   * us where the buildings are.
   *
   * Three fixed marks on a deck have no business being three objects with
   * three transforms, so all three are one merge per program and cannot move
   * afterwards. That is exactly why this is deferred: `resolvePads` may shift
   * a pad several metres to get it out of a wall, and the paint has to be
   * drawn where the pad ends up rather than where it was hoped for. Called
   * from `setWorld` and, for anything that never calls it, from the first
   * frame.
   */
  let padsBuilt = false;
  function ensurePads(): void {
    if (padsBuilt) return;
    padsBuilt = true;
    const paint: THREE.BufferGeometry[] = [];
    const post: THREE.BufferGeometry[] = [];
    const column: THREE.BufferGeometry[] = [];
    for (const pad of pads) {
      const accent = ACCENT[pad.kind];
      if (pad.kind === "glider") railParts(pad, accent, paint, post, column);
      else if (pad.kind === "flyer") flyerPadParts(pad, accent, paint, post, column);
      else padParts(pad, accent, paint, post, column);
    }
    flush(group, post, matBody, "empyrean-pad-posts", false, keep);
    flush(group, paint, matGlow, "empyrean-pad-paint", false, keep);
    flush(group, column, matColumn, "empyrean-pad-columns", false, keep);
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
   * can actually hit — see `ISLAND_SLAB`.
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
    const R = hullOf(c.kind);
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

  /** Hull half-extent used against `blockedAt`, by kind. */
  function hullOf(kind: VehicleKind): number {
    if (kind === "skiff") return SKIFF.hullR;
    if (kind === "glider") return GLIDER.hullR;
    if (kind === "flyer") return FLYER.hullR;
    return LIFTER.hullR;
  }

  function skidOf(kind: VehicleKind): number {
    if (kind === "skiff") return SKIFF.skidH;
    if (kind === "glider") return GLIDER.skidH;
    if (kind === "flyer") return FLYER.skidH;
    return LIFTER.skidH;
  }

  /**
   * Is this somewhere a vehicle could actually stand?
   *
   * Support within a few metres of where the pad was meant to be, nothing
   * solid over it, and nothing solid within a hull radius of it.
   */
  function padFits(x: number, z: number, wantY: number, hull: number): number | null {
    const kind = surfaceAt(x, z).kind;
    if (kind === "void" || kind === "parapet") return null;
    const sup = world.supportAt(x, z, wantY + 3);
    if (!Number.isFinite(sup) || Math.abs(sup - wantY) > 6) return null;
    if (world.blockedAt(x, z, sup + 1.2)) return null;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      if (world.blockedAt(x + Math.cos(a) * hull, z + Math.sin(a) * hull, sup + 1.2)) return null;
    }
    return sup;
  }

  /**
   * Put every pad somewhere its vehicle can stand, given the real world.
   *
   * The nominal positions come out of `cityplan.ts`, which knows where the
   * streets are and nothing about what was built on them — and buildings,
   * interiors and props are three other systems that may move under this one
   * at any time. `clear` on a landmark is the *footprint of its structure*,
   * not a clearing, which is how the skiff came to be parked inside the Launch
   * Terrace through a green build and a green test suite.
   *
   * So the nominal point is a preference, not a promise: if it is inside
   * something, walk round the arc a few metres at a time, in and out a little,
   * and take the first spot that holds a vehicle. Staying on the same radius
   * first keeps a pad on the pavement it was meant to be on rather than
   * marching it into the road.
   */
  /**
   * Is this rooftop really a rooftop?
   *
   * Stricter than `padFits` in the one way that matters up here: the deck the
   * collision world reports has to be *this* roof, not a neighbour's. Blockers
   * and decks are the bounding boxes of polygons and the lots are trapezoids
   * on a radial grid, so a taller building two doors down can have a box that
   * covers a roof the plan says is open — and a pad painted onto a deck whose
   * polygon does not reach it is paint hanging in the air.
   */
  function roofFits(spot: RoofSpot, hull: number): boolean {
    const sup = world.supportAt(spot.x, spot.z, spot.y + 2);
    if (!Number.isFinite(sup) || Math.abs(sup - spot.y) > 0.6) return false;
    if (world.blockedAt(spot.x, spot.z, sup + 1.2)) return false;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const px = spot.x + Math.cos(a) * hull;
      const pz = spot.z + Math.sin(a) * hull;
      if (world.blockedAt(px, pz, sup + 1.2)) return false;
      // And the roof carries on under the wing tip, rather than stopping.
      const s2 = world.supportAt(px, pz, spot.y + 2);
      if (!Number.isFinite(s2) || Math.abs(s2 - spot.y) > 0.6) return false;
    }
    return true;
  }

  function resolvePads(): void {
    for (const c of crafts) {
      const pad = c.pad;

      /* ---- a rooftop pad ----
       * Not the arc walk below: walking round the island at this radius from a
       * roof lands on the neighbouring block, or on the street between them,
       * six hundred metres from anything. The bucket is the fallback instead —
       * every qualifying roof in this sixth of the compass, best first. */
      if (c.spots) {
        const hull = hullOf(c.kind);
        for (const spot of c.spots) {
          if (!roofFits(spot, hull)) continue;
          pad.x = spot.x;
          pad.z = spot.z;
          pad.y = spot.y;
          pad.yaw = spot.yaw;
          pad.roofLot = spot.lot;
          break;
        }
        if (c.phase === "parked") {
          c.pos.set(pad.x, pad.y + skidOf(c.kind), pad.z);
          c.yaw = pad.yaw;
        }
        continue;
      }

      const hull = hullOf(c.kind);
      const r0 = Math.max(1, Math.hypot(pad.x, pad.z));
      const a0 = Math.atan2(pad.z, pad.x);
      let placed = false;
      for (let step = 0; step <= 14 && !placed; step++) {
        for (const dir of step === 0 ? [1] : [1, -1]) {
          for (const dr of [0, -7, 7]) {
            const r = r0 + dr;
            const a = a0 + (dir * step * 5) / r;
            const x = Math.cos(a) * r;
            const z = Math.sin(a) * r;
            const sup = padFits(x, z, pad.y, hull);
            if (sup === null) continue;
            pad.x = x;
            pad.z = z;
            pad.y = sup;
            placed = true;
            break;
          }
          if (placed) break;
        }
      }
      if (!placed) pad.y = groundBelow(pad.x, pad.z, pad.y + 3);
      // A craft still on its pad comes with it. One somebody has already
      // parked on a roof stays where they left it.
      if (c.phase === "parked") {
        c.pos.set(pad.x, pad.y + skidOf(c.kind), pad.z);
        c.yaw = pad.yaw;
      }
    }
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

  /* =======================================================================
   * The flyer
   * ==================================================================== */

  /**
   * One step of the aircraft anybody can fly.
   *
   * Read `FLYER` for why each rule is there. In order: the throttle, which is
   * a speed and stays where it is put; the bank, which is a command and rolls
   * back to level; the turn, which falls out of the bank; the vertical, which
   * is altitude-hold by default and has two separate ways down; the soft
   * floor, which is the reason you cannot fly this into the snow; and the
   * fence at the shore, which turns the nose home rather than pushing.
   *
   * Nothing in here can produce a state the aircraft cannot fly out of. There
   * is no stall to fall out of, no spin to enter, and the only thing a
   * collision costs is the throttle setting.
   */
  function stepFlyer(c: Craft, input: VehicleInput, dt: number): void {
    /* ---- throttle: a speed, held ---- */
    const thr = clamp(input.forward, -1, 1);
    c.throttle = clamp(c.throttle + thr * FLYER.throttleRate * dt, 0, 1);
    const idle = c.throttle <= FLYER.idleThrottle;
    const vMax = input.boost ? FLYER.vBoost : FLYER.vCruise;
    const want = c.throttle * vMax;
    const tau = want > c.speedHold ? FLYER.tauSpeed : FLYER.tauBrake;
    c.speedHold += (want - c.speedHold) * ease(dt, tau);
    if (c.phase === "landed") c.speedHold *= Math.exp(-dt / 0.5);
    if (c.speedHold < 0.05) c.speedHold = 0;

    /* ---- bank, and the turn that falls out of it ----
     * A command, not a force: the roll goes where the stick says and comes
     * back to level on its own the moment the stick is centred, which is the
     * single rule that makes this flyable by somebody who has never flown. */
    const bankCmd = -clamp(input.strafe, -1, 1) * FLYER.bankMax;
    c.roll += (bankCmd - c.roll) * ease(dt, FLYER.tauBank);
    const vTurn = Math.max(FLYER.vTurnRef, c.speedHold);
    const rate = clamp(
      (Math.tan(c.roll) * GRAVITY * FLYER.turnGain) / vTurn,
      -FLYER.yawRateMax,
      FLYER.yawRateMax,
    );
    // Airborne only. A parked aircraft that spins on its skids reads as broken.
    if (c.phase !== "landed" || c.speedHold > 1) c.yaw += rate * dt;
    c.yawRate = rate;

    /* ---- the fence at the shore ----
     * The powered craft use `tether`, which edits the velocity; this one
     * derives its velocity from the throttle every step, so an edit to it
     * would be erased before it did anything. The glider's answer works here:
     * turn the nose home and ease the throttle off, so what the player feels
     * is weather rather than a wall. */
    const rr = Math.hypot(c.pos.x, c.pos.z);
    if (rr > LAKE_R * 0.82) {
      const t = Math.min(1, (rr - LAKE_R * 0.82) / (LAKE_R * 0.18));
      const home = Math.atan2(c.pos.x, c.pos.z);
      c.yaw += shortestAngle(home - c.yaw) * ease(dt, 4.0 - 3.4 * t);
      c.throttle = Math.min(c.throttle, 1 - 0.55 * t);
    }

    _fwd.set(-Math.sin(c.yaw), 0, -Math.cos(c.yaw));
    c.vel.x = _fwd.x * c.speedHold;
    c.vel.z = _fwd.z * c.speedHold;

    /* ---- vertical ---- */
    const ground = groundBelow(c.pos.x, c.pos.z, c.pos.y + 0.4);
    c.clearance = Math.max(0, c.pos.y - FLYER.skidH - ground);
    const lift = clamp(input.lift, 0, 1);

    let target: number;
    if (lift > 0.02) {
      target = FLYER.vRise * lift;
    } else if (idle && thr < -0.15) {
      // Throttle already shut and still asking for less: that is "down".
      target = FLYER.vDive * thr;
    } else if (idle) {
      // Settle, cushioned to nothing as the skids arrive. This is the landing.
      target = -FLYER.vSettle * Math.min(1, Math.max(0.05, c.clearance / FLYER.cushion));
    } else {
      // Hold what you have. No key held is level flight, on purpose.
      target = 0;
    }

    /* Lift-off without having to know that Space exists: open the throttle on
     * the ground and it picks itself up. */
    if (!idle && c.clearance < FLYER.hop && target < FLYER.vHop) target = FLYER.vHop;

    /* ---- the soft floor ----
     * Sampled ahead in proportion to speed, so it is the ground you are about
     * to be over that lifts the nose rather than the ground you are already
     * past. It lets go below `floorSpeed`, because a floor that never lets go
     * is an aircraft that can never land. */
    if (c.speedHold > FLYER.floorSpeed && target < FLYER.vRise) {
      const look = FLYER.floorLook * c.speedHold;
      const ahead = groundBelow(
        c.pos.x + _fwd.x * look,
        c.pos.z + _fwd.z * look,
        c.pos.y + 0.4,
      );
      const clearAhead = Math.min(c.clearance, c.pos.y - FLYER.skidH - ahead);
      if (clearAhead < FLYER.floor) {
        const urgency = Math.min(1, (FLYER.floor - clearAhead) / FLYER.floor);
        target = Math.max(target, urgency * FLYER.vRise);
      }
    }

    if (c.pos.y > FLYER.ceiling && target > 0) target = 0;
    c.vel.y += (target - c.vel.y) * ease(dt, FLYER.tauVert);

    integrate(c, dt, FLYER.skidH);

    /* ---- attitude ----
     * Pitch is the flight path and nothing else: nose up when it is going up,
     * nose down when it is going down, level when it is level. Honest, and it
     * self-levels for free because the flight path does. */
    const wantPitch = clamp(
      Math.atan2(c.vel.y, Math.max(10, c.speedHold)) * 0.85,
      -0.34,
      0.34,
    );
    c.pitch += (wantPitch - c.pitch) * ease(dt, 0.5);
    if (c.phase === "landed") c.pitch += (0 - c.pitch) * ease(dt, 0.4);
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
    if (c.kind === "flyer") {
      /* Stopping against a wall is the worst thing that can happen to a
       * flyer, and it costs the throttle setting and nothing else: no damage,
       * no spin, no falling. Push forward again and you are flying again. */
      c.speedHold *= 0.2;
      c.throttle *= 0.35;
    }
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
    if (c.kind === "skiff") return SKIFF.seat;
    if (c.kind === "glider") return GLIDER.seat;
    if (c.kind === "flyer") return FLYER.seat;
    return LIFTER.seat;
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
    if (c.kind === "flyer") {
      /* Get in and the throttle is shut, whatever the last pilot left it at.
       * An aircraft that takes off the instant somebody sits in it is a
       * surprise, and the one thing this craft is not allowed to be. */
      c.throttle = 0;
      c.speedHold = 0;
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
    const R = hullOf(c.kind) + 1.3;
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
    c.pos.set(c.pad.x, c.pad.y + skidOf(c.kind), c.pad.z);
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
      resolvePads();
      ensurePads();
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
      ensurePads();
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

      /* The pad columns breathe, and come up at dusk like everything else. */
      matColumn.uniforms.uTime.value = frame.time;
      matColumn.uniforms.uNight.value = 1 - frame.daylight * 0.55;
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
    else if (c.kind === "flyer") stepFlyer(c, input, dt);
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
 * root CLAUDE.md.
 *
 * ## Why none of this is a mesh until the end
 *
 * A vehicle is thirty small pieces: a nose, a canopy, two skids, four legs,
 * four fans, nine pylons. Built the obvious way that is thirty meshes and
 * thirty draw calls, and three vehicles and three pads came to eighty-three —
 * more than the whole city, for four thousand triangles. Draw calls are the
 * number that decides whether this runs on a phone, and they have nothing to
 * do with how much geometry is in them.
 *
 * So the builders below do not make meshes. Each one drops transformed,
 * vertex-coloured geometries into one of three bins — lit, transparent,
 * glowing — and `flush` merges each bin into a single mesh. A craft is three
 * draws; all three pads together are three more. Colour that used to come
 * from a material comes from a `color` attribute instead, which is the same
 * trick `buildings.ts` and `props.ts` already use for the same reason.
 *
 * The pads are merged in *world* space, because they never move. The craft
 * are merged in their own local space, because they very much do.
 * ====================================================================== */

type Keep = <T extends { dispose(): void }>(d: T) => T;

/** The three programs a vehicle is allowed to need. */
interface CraftParts {
  body: THREE.BufferGeometry[];
  glass: THREE.BufferGeometry[];
  glow: THREE.BufferGeometry[];
}

const ACCENT: Record<VehicleKind, number> = {
  skiff: 0xffb35c,
  glider: 0x9ce8a8,
  lifter: 0xc8a2ff,
  flyer: 0x5ce0ff,
};

/**
 * The HUD's name for each craft.
 *
 * The flyers do not use it — there are seven of them and they have names of
 * their own — but a `Record` over the union is the thing that fails to
 * compile when somebody adds a fifth kind, which is the point.
 */
const LABEL: Record<VehicleKind, string> = {
  skiff: "Sky skiff · Ember",
  glider: "Glider · Vesper",
  lifter: "Cargo lifter · Derrick",
  flyer: "Skyflyer",
};

/** Body palette. Named rather than inlined so a craft can be re-liveried. */
const HULL = 0xdfe6ef;
const TRIM = 0x2c3340;
const WARM = 0xc08a4a;

const _partM = new THREE.Matrix4();
const _partQ = new THREE.Quaternion();
const _partE = new THREE.Euler();
const _partP = new THREE.Vector3();
const _partS = new THREE.Vector3();
const _partC = new THREE.Color();

/**
 * Put one primitive where it belongs, paint it, and hand it to a bin.
 *
 * The transform is baked into the vertices — this geometry will never have an
 * object of its own to carry it — and the colour is baked into an attribute,
 * which is what lets twenty parts in three colours share one material and one
 * call. `THREE.Color.set` converts an sRGB hex into the renderer's linear
 * working space, which is the space vertex colours are read in; skip that and
 * every painted part comes out noticeably too bright.
 */
function part(
  bin: THREE.BufferGeometry[],
  geo: THREE.BufferGeometry,
  hex: number,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
  order: THREE.EulerOrder = "XYZ",
): void {
  _partE.set(rx, ry, rz, order);
  _partQ.setFromEuler(_partE);
  _partM.compose(_partP.set(x, y, z), _partQ, _partS.set(sx, sy, sz));
  geo.applyMatrix4(_partM);

  const n = geo.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  _partC.set(hex);
  for (let i = 0; i < n; i++) {
    col[i * 3] = _partC.r;
    col[i * 3 + 1] = _partC.g;
    col[i * 3 + 2] = _partC.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  bin.push(geo);
}

/** A glowing part, painted above 1.0 so the bloom pass has something to find. */
function lit(
  bin: THREE.BufferGeometry[],
  geo: THREE.BufferGeometry,
  accent: number,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
  order: THREE.EulerOrder = "XYZ",
): void {
  _partE.set(rx, ry, rz, order);
  _partQ.setFromEuler(_partE);
  _partM.compose(_partP.set(x, y, z), _partQ, _partS.set(sx, sy, sz));
  geo.applyMatrix4(_partM);

  const n = geo.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  _partC.set(accent).multiplyScalar(1.7);
  for (let i = 0; i < n; i++) {
    col[i * 3] = _partC.r;
    col[i * 3 + 1] = _partC.g;
    col[i * 3 + 2] = _partC.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  bin.push(geo);
}

/** Merge a bin into one mesh and hang it off `parent`. Empty bins cost nothing. */
function flush(
  parent: THREE.Object3D,
  bin: THREE.BufferGeometry[],
  mat: THREE.Material,
  name: string,
  castShadow: boolean,
  keep: Keep,
): void {
  if (bin.length === 0) return;
  const merged = bin.length === 1 ? bin[0] : mergeGeometries(bin, false);
  if (!merged) return;
  if (bin.length > 1) for (const g of bin) g.dispose();
  merged.computeBoundingSphere();
  keep(merged);
  const mesh = new THREE.Mesh(merged, mat);
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = false;
  parent.add(mesh);
  bin.length = 0;
}

/**
 * The skiff.
 *
 * A shallow lifting-body hull with the cockpit cut into the top of it, two
 * intake pods on outriggers and a pair of curved skids. Read from thirty
 * metres it is the open seat that says "get in": the silhouette is
 * deliberately a scoop rather than a canopy.
 */
function skiffParts(p: CraftParts, accent: number): void {
  const H = Math.PI / 2;

  part(p.body, new THREE.CylinderGeometry(0.95, 1.35, 5.4, 7, 1, false), HULL, 0, 0.95, 0, H, 0, 0, 1, 1, 0.42);
  part(p.body, new THREE.ConeGeometry(0.95, 1.9, 7), HULL, 0, 0.95, -3.05, -H, 0, 0, 1, 1, 0.42);

  // The cockpit: a dark tub sunk into the deck with a low screen in front.
  part(p.body, new THREE.BoxGeometry(1.15, 0.5, 1.9), TRIM, 0, 1.22, 0.3);
  part(p.glass, new THREE.CylinderGeometry(0.72, 0.72, 0.62, 12, 1, true, -1.1, 2.2), 0x9fd8ff, 0, 1.62, -0.72);
  part(p.body, new THREE.BoxGeometry(0.72, 0.72, 0.2), WARM, 0, 1.62, 1.02);

  // Intake pods on short outriggers. The glowing throat is the "it is on" cue.
  for (const side of [-1, 1]) {
    part(p.body, new THREE.CylinderGeometry(0.46, 0.52, 2.0, 10, 1, true), WARM, side * 1.55, 0.86, 0.65, H);
    lit(p.glow, new THREE.CircleGeometry(0.42, 10), accent, side * 1.55, 0.86, 1.66);
    part(p.body, new THREE.BoxGeometry(0.9, 0.16, 0.5), TRIM, side * 0.95, 0.86, 0.65);

    // Skids: two curved rails, so it has something to settle onto.
    part(p.body, new THREE.TorusGeometry(1.6, 0.09, 5, 10, Math.PI * 0.55), TRIM, side * 0.95, 0.42, 0.1, H, 0, Math.PI * 0.72);
    for (const zz of [-1.1, 1.1]) {
      part(p.body, new THREE.BoxGeometry(0.12, 0.5, 0.12), TRIM, side * 0.95, 0.62, zz);
    }
    lit(p.glow, new THREE.BoxGeometry(0.06, 0.1, 3.6), accent, side * 1.0, 1.14, 0.1);
  }

  part(p.body, new THREE.BoxGeometry(0.1, 1.0, 1.3), WARM, 0, 1.55, 2.2, -0.22);
}

/**
 * The glider.
 *
 * Sixteen metres of wing on a five-metre pod, with a V-tail and one nose
 * skid. The span is the whole silhouette and it is the reason this is the one
 * you can pick out from the far side of the island: nothing else in the world
 * is that wide and that thin.
 */
function gliderParts(p: CraftParts, accent: number): void {
  const H = Math.PI / 2;
  const half = GLIDER.span / 2;

  part(p.body, new THREE.CapsuleGeometry(0.44, 2.6, 4, 10), HULL, 0, 0.72, -0.4, H);
  part(p.body, new THREE.CylinderGeometry(0.2, 0.07, 3.4, 8), HULL, 0, 0.78, 2.4, H);
  part(
    p.glass,
    new THREE.SphereGeometry(0.5, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
    0x9fd8ff,
    0, 0.98, -1.1, 0, 0, 0, 1, 0.9, 1.9,
  );

  /* The wing: a tapered, slightly swept plate with dihedral, made from two
   * halves rather than one plank so each can be tilted on its own. Three
   * degrees of dihedral is the difference between a toy and an aircraft. */
  for (const side of [-1, 1]) {
    part(p.body, new THREE.BoxGeometry(half, 0.1, 1.25), HULL, (side * half) / 2, 0.92, -0.15, 0, side * -0.06, side * 0.055);
    lit(p.glow, new THREE.BoxGeometry(0.5, 0.1, 0.7), accent, side * (half - 0.1), 0.94 + half * 0.0275, -0.15, 0, 0, side * 0.055);
    // V-tail, because a T-tail on a fifteen-metre span looks like a model.
    part(p.body, new THREE.BoxGeometry(2.2, 0.08, 0.75), HULL, side * 0.85, 1.28, 3.7, 0, 0, side * 0.62);
  }

  part(p.body, new THREE.CylinderGeometry(0.14, 0.14, 1.6, 8), TRIM, 0, 0.16, -0.5, H);
  lit(p.glow, new THREE.BoxGeometry(0.14, 0.06, 2.6), accent, 0, 1.14, -0.4);
}

/**
 * The lifter.
 *
 * A flat load deck, four ducted fans on outriggers, a cage over the pilot and
 * a hook underneath. It is the only one of the three with no aerodynamic
 * shape at all, on purpose: it should look like it works for a living.
 */
function lifterParts(p: CraftParts, accent: number): void {
  const H = Math.PI / 2;

  part(p.body, new THREE.BoxGeometry(2.6, 0.3, 3.4), HULL, 0, 0.8, 0);
  part(p.body, new THREE.TorusGeometry(0.95, 0.07, 5, 12, Math.PI), WARM, 0, 0.95, -1.0, 0, H, 0);
  part(p.body, new THREE.BoxGeometry(2.2, 0.12, 1.1), TRIM, 0, 2.32, 1.2);
  part(p.body, new THREE.TorusGeometry(0.22, 0.06, 5, 10), WARM, 0, 0.42, 0);
  lit(p.glow, new THREE.SphereGeometry(0.16, 8, 6), accent, 0, 2.5, 1.2);

  for (const sx of [-1, 1]) {
    part(p.body, new THREE.BoxGeometry(0.16, 1.5, 0.16), TRIM, sx * 0.95, 1.6, 1.4);
    part(p.body, new THREE.BoxGeometry(0.16, 0.16, 4.0), TRIM, sx * 1.05, 0.12, 0);
    for (const sz of [-1.4, 1.4]) {
      part(p.body, new THREE.BoxGeometry(0.14, 0.55, 0.14), TRIM, sx * 1.05, 0.42, sz);
    }
    for (const sz of [-1, 1]) {
      part(p.body, new THREE.TorusGeometry(1.0, 0.2, 6, 16), TRIM, sx * 2.15, 1.05, sz * 1.5, H);
      part(p.body, new THREE.BoxGeometry(1.7, 0.05, 0.22), WARM, sx * 2.15, 1.05, sz * 1.5, 0, sx * sz * 0.4, 0);
      part(p.body, new THREE.BoxGeometry(1.5, 0.16, 0.3), HULL, sx * 1.45, 1.05, sz * 1.5);
    }
  }
}

/**
 * The pad.
 *
 * A painted ring, three pylons, and a column of soft light. The column is the
 * part that does the work: a parked skiff is two metres tall on a deck full of
 * two-metre things, and the whole brief for these was that you can find one.
 * It is additive and unlit, so the bloom in `postfx.ts` turns it into a
 * landmark from the far side of the island without costing a light.
 *
 * It starts four metres up and it is narrow at the bottom. The first one was
 * a five-metre-wide cylinder standing on the deck, which from the far side of
 * the island was perfect and from ten metres away was a wall of violet haze
 * with the vehicle somewhere inside it. A beacon you cannot see the thing
 * through is a beacon pointing at nothing.
 *
 * Everything here is emitted in world space and merged with the other two
 * pads: they are three fixed marks on a deck and there is no reason for any
 * of them to be an object.
 */
function padParts(
  pad: VehiclePad,
  accent: number,
  paint: THREE.BufferGeometry[],
  post: THREE.BufferGeometry[],
  column: THREE.BufferGeometry[],
): void {
  const px = pad.x;
  const pz = pad.z;
  const py = pad.y + 0.03;
  const c = Math.cos(pad.yaw);
  const sn = Math.sin(pad.yaw);
  /** Pad-local (x, z) to world, through the pad's own yaw. */
  const wx = (lx: number, lz: number) => px + lx * c + lz * sn;
  const wz = (lx: number, lz: number) => pz - lx * sn + lz * c;

  lit(paint, new THREE.RingGeometry(6.4, 7.4, 40), accent, px, py, pz, -Math.PI / 2);
  lit(
    paint,
    new THREE.RingGeometry(3.2, 3.6, 24, 1, -0.5, 1.0),
    accent,
    wx(0, -1.5), py, wz(0, -1.5),
    -Math.PI / 2, pad.yaw, 0,
    1, 1, 1,
    "YXZ",
  );

  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i / 3) * Math.PI * 2;
    const lx = Math.cos(a) * 6.9;
    const lz = Math.sin(a) * 6.9;
    part(post, new THREE.CylinderGeometry(0.12, 0.18, 1.5, 6), 0x333a46, wx(lx, lz), py + 0.75, wz(lx, lz));
    lit(paint, new THREE.SphereGeometry(0.2, 8, 6), accent, wx(lx, lz), py + 1.6, wz(lx, lz));
  }

  lit(column, new THREE.CylinderGeometry(2.2, 0.7, 34, 10, 1, true), accent, px, py + 21, pz);
}

/**
 * The glider's launch rail.
 *
 * Not a circle, because there is nowhere to put one: the promenade rings are
 * seven metres wide and a fifteen-metre wingspan already overhangs both edges
 * of the ledge it is perched on. A pad ring drawn out here would be half over
 * the parapet and half over six hundred metres of nothing.
 *
 * A rail is also the better object. It says which way the thing is going to
 * leave, it explains the catapult, and pointing it off the edge is the whole
 * invitation.
 */
function railParts(
  pad: VehiclePad,
  accent: number,
  paint: THREE.BufferGeometry[],
  post: THREE.BufferGeometry[],
  column: THREE.BufferGeometry[],
): void {
  const py = pad.y + 0.03;
  const c = Math.cos(pad.yaw);
  const sn = Math.sin(pad.yaw);
  const wx = (lx: number, lz: number) => pad.x + lx * c + lz * sn;
  const wz = (lx: number, lz: number) => pad.z - lx * sn + lz * c;
  const L = GLIDER.railLength * 0.7;

  for (const side of [-1, 1]) {
    part(
      post, new THREE.BoxGeometry(0.26, 0.2, L), 0x333a46,
      wx(side * 1.15, 0), py + 0.1, wz(side * 1.15, 0),
      0, pad.yaw, 0,
    );
    // A pair of low stanchions at the inboard end, to stand the tail on.
    part(
      post, new THREE.CylinderGeometry(0.1, 0.15, 0.9, 6), 0x333a46,
      wx(side * 1.15, L * 0.42), py + 0.55, wz(side * 1.15, L * 0.42),
    );
    lit(
      paint, new THREE.SphereGeometry(0.17, 8, 6), accent,
      wx(side * 1.15, L * 0.42), py + 1.05, wz(side * 1.15, L * 0.42),
    );
  }

  // The centre stripe, running out to the lip: the direction of travel.
  lit(
    paint, new THREE.BoxGeometry(0.36, 0.05, L * 1.02), accent,
    wx(0, -L * 0.06), py + 0.04, wz(0, -L * 0.06),
    0, pad.yaw, 0,
  );

  lit(column, new THREE.CylinderGeometry(2.2, 0.7, 34, 10, 1, true), accent, pad.x, py + 21, pad.z);
}

/**
 * The light column's material.
 *
 * Additive, unlit, fog-free and fading out with height, with a slow travelling
 * band so it reads as alive rather than as a decal. It brightens at night —
 * `uNight` — for the same reason every lamp in the city does.
 *
 * One material for all three columns: the accent arrives on the `color`
 * attribute rather than in a uniform, which is the only reason three pads on
 * opposite sides of the island can be a single draw. `vertexColors` on a
 * `ShaderMaterial` gets `#define USE_COLOR` and the `attribute vec3 color`
 * declaration from three's own prefix, so this shader must not declare it
 * again.
 */
function padColumnMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "EmpyreanPadColumn",
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    fog: false,
    vertexColors: true,
    uniforms: {
      uTime: { value: 0 },
      uNight: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying float vH;
      varying vec3 vCol;
      void main() {
        vH = uv.y;
        vCol = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime;
      uniform float uNight;
      varying float vH;
      varying vec3 vCol;
      void main() {
        float fade = pow(1.0 - vH, 2.2);
        float band = 0.5 + 0.5 * sin((vH - uTime * 0.11) * 22.0);
        float a = fade * (0.16 + 0.12 * band) * uNight;
        gl_FragColor = vec4(vCol * (0.55 + band * 0.3), a);
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
