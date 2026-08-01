/**
 * Vibe Kart — the feel constants that `types.ts` does not own.
 *
 * `TUNING` in types.ts is shared law and this module never edits it. What lives
 * here is everything the drive model needs that is *implementation* rather than
 * contract: slip angles, spring frequencies, scrub coefficients, the weight
 * table. Keeping them in one place means the handling can be balanced by
 * reading a single screen of numbers instead of grepping for magic constants.
 *
 * A note on the suspension geometry, because the model rig depends on it:
 *
 *   · A racer's `position` is the chassis origin.
 *   · At rest it floats exactly `TUNING.suspensionRest` (0.42 m) above the
 *     road. The spring's free length is `rest + gravity / stiffness`, chosen so
 *     that gravity settles the kart at precisely the rest height rather than
 *     somewhere the tuner has to discover empirically.
 *   · `wheelCompression` is 0 at full droop (contact patch DROOP below the
 *     origin) and 1 on the bump stop (contact patch BUMP below the origin), so
 *     a wheel centre sits at local
 *         y = TUNING.wheelRadius − lerp(DROOP, BUMP, compression)
 *     which is −0.08 m at rest. Draw the wheels there and they touch tarmac.
 */
import { TUNING, type BoostSource, type CharacterPreset } from "../types";

/** Spring free length: gravity compresses this to exactly `suspensionRest`. */
export const DROOP = TUNING.suspensionRest + TUNING.gravity / TUNING.suspensionStiffness;
/** Bump stop — the shortest the suspension can get before it goes solid. */
export const BUMP = 0.1;
/** Compression the kart settles at when parked, for anyone posing a static kart. */
export const REST_COMPRESSION = (DROOP - TUNING.suspensionRest) / (DROOP - BUMP);

/** Wheel mount points in body space, order FL FR RL RR. Local −Z is forwards. */
export const WHEEL_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [-(TUNING.kartHalf.x + 0.08), 0, -TUNING.kartHalf.z * 0.8],
  [+(TUNING.kartHalf.x + 0.08), 0, -TUNING.kartHalf.z * 0.8],
  [-(TUNING.kartHalf.x + 0.08), 0, +TUNING.kartHalf.z * 0.8],
  [+(TUNING.kartHalf.x + 0.08), 0, +TUNING.kartHalf.z * 0.8],
];

export const PHYS = {
  // --- suspension ---------------------------------------------------------
  /** Clearance beyond droop at which a wheel is considered off the ground. */
  contactSlop: 0.06,
  /** Grace period where a kart still counts as grounded after losing contact. */
  coyoteTime: 0.07,
  /** Suspension is muted for this long after a hop, so the hop is crisp. */
  hopMute: 0.09,
  /** Load transfer written into wheelCompression: longitudinal, lateral. */
  squatGain: 0.011,
  rollGain: 0.008,
  /** How much of the load transfer is baked into the body's actual pitch. */
  pitchGain: 0.0026,
  pitchMax: 0.075,

  // --- ground alignment ---------------------------------------------------
  /** Up-vector spring frequency, grounded and airborne (rad/s). */
  alignFreq: 11,
  alignFreqAir: 3.4,
  /**
   * Above this tilt the kart stops obeying world gravity and starts obeying the
   * road. It is what makes the banked bowl hold you and the anti-gravity
   * plating drivable; below it, slopes still push you around like they should.
   */
  stickTilt: 0.5,

  // --- longitudinal -------------------------------------------------------
  /** Extra decel applied to speed above the current cap, m/s². */
  overspeedDecel: 9,
  /** Reverse takes longer to wind up than forwards. */
  reverseAccelMul: 0.55,
  /** Speed below which brake becomes reverse. */
  reverseThreshold: 0.9,
  /**
   * What sliding costs, as a fraction of speed shed per second per unit of
   * sin(slip). `slideDrag` is the standing charge on any slip at all — a held
   * drift should cost a little, or there would be no reason ever to stop.
   * `scrubDrag` is the punitive rate on slip beyond what the drift asked for,
   * which is what makes a sloppy slide slower than a tidy one.
   */
  slideDrag: 0.14,
  scrubDrag: 0.55,
  /** Slip beyond the drift's target that is still considered tidy. */
  scrubSlack: 0.25,
  /** Air drag coefficient — quadratic, sets the real terminal speed. */
  airDrag: 0.0016,
  /**
   * Fraction of gravity's along-the-road component refunded while grounded.
   * The arcade dial: 0 is a simulation that cannot climb its own ramps, 1 is a
   * course with no elevation at all.
   */
  slopeAssist: 0.78,

  // --- lateral grip -------------------------------------------------------
  /** Lateral velocity damping rate on tarmac, 1/s. */
  baseGrip: 11,
  /** Ceiling on lateral acceleration, m/s². This is where understeer comes from. */
  maxLatAccel: 31,
  /** Grip multiplier while drifting — the slide has to hold its arc. */
  driftGrip: 1.35,
  driftLatCap: 1.3,
  /** Understeer: grip falls off toward the top of the speed range. */
  speedUndersteer: 0.2,
  /** Almost no lateral authority in the air. */
  airGrip: 0.6,

  // --- steering -----------------------------------------------------------
  /** Steering input smoothing, 1/s — stops keyboard steering from being binary. */
  steerSmooth: 20,
  /** Yaw damping toward the commanded rate, 1/s. */
  yawSmooth: 16,
  /** Air steering authority, rad/s. */
  airSteer: 1.15,
  /** Air pitch authority and its limit. */
  airPitchRate: 1.5,
  airPitchMax: 0.36,
  /** Steering authority on the throttle at a standstill, as a fraction of full. */
  pivotAuthority: 0.55,
  /** Visual front-wheel lock. */
  steerVisual: 0.62,

  // --- drift --------------------------------------------------------------
  /** Hop launch speed, m/s. ~0.27 s of air at TUNING.gravity. */
  hopSpeed: 3.6,
  /** Below this you just hop; above it the hop can become a drift. */
  driftMinSpeed: 4.5,
  /** Below this a live drift gives up. */
  driftDropSpeed: 2.6,
  /** Window after the hop in which steering still picks the drift direction. */
  driftLockWindow: 0.26,
  /**
   * Body slip angle, steering all the way out of the drift and all the way
   * into it. Paired with TUNING.driftSteerInner/Outer, which are the matching
   * bounds on yaw authority: counter-steer runs the drift wide and shallow,
   * steering into it tightens the arc and kicks the tail further out.
   */
  slipMin: 0.115,
  slipMax: 0.46,
  /** Seconds for the slip target to ramp in — no snapping sideways. */
  slipRamp: 0.22,
  /** Drift yaw authority falls off with speed less sharply than grip steering. */
  driftYawFalloff: 0.42,
  /** Charge rate at zero slip, and how much full slip adds. */
  chargeBase: 0.86,
  chargeSlipGain: 0.36,
  /** Slip past the target that the drift tolerates before it starts catching. */
  driftSlipSlack: 0.14,
  /** How much further slip it takes to wind the drift's yaw command to nothing. */
  driftSlipCatch: 0.4,
  /** Airborne for longer than this and the drift is gone. */
  driftAirGrace: 0.45,
  /** A landing harder than this breaks a drift. */
  driftBreakImpact: 12,

  // --- boost --------------------------------------------------------------
  /** Boost pads re-arm this long after firing, so one pad is one event. */
  padCooldown: 0.5,
  padBoost: 0.95,
  /** Grip and drag both improve while boosting. */
  boostGrip: 1.12,
  boostDragMul: 0.35,
  /** Cooldown after a tow pays out, so a pack cannot draft in permanent orbit. */
  draftRefractory: 1.4,

  // --- tricks -------------------------------------------------------------
  /** Minimum air before a trick is allowed, and how long the animation runs. */
  trickMinAir: 0.14,
  trickTime: 0.52,
  trickBoost: 0.55,
  /** Rivals trick automatically once they have been airborne this long. */
  aiTrickAir: 0.2,

  // --- landing / impacts --------------------------------------------------
  /** Normal speed at touchdown above which the landing costs you. */
  landSoft: 6,
  landHard: 15,
  landSpeedLoss: 0.28,

  // --- collisions ---------------------------------------------------------
  kartRestitution: 0.42,
  /** Extra shove so a cruiser genuinely bullies a feather. */
  kartShove: 3.4,
  /** Positional de-overlap fraction applied per step. */
  separationBias: 0.6,
  /** Vertical squash on the contact normal — karts bump, they do not climb. */
  contactFlatten: 0.35,
  /** Minimum closing impulse worth telling the rest of the game about. */
  collideEventImpulse: 1.5,
  collideEventGap: 0.3,
  /** Wall bounce, and how much of a head-on hit is taken out of your speed. */
  wallRestitutionSolid: 0.26,
  wallRestitutionSoft: 0.06,
  wallScrub: 0.88,
  wallEventGap: 0.35,
  wallEventSpeed: 3.5,

  // --- states -------------------------------------------------------------
  /** Full rotations a spin-out makes. */
  spinTurns: 2,
  /** How fast a spun or shocked kart bleeds off its momentum, 1/s. */
  spinDrag: 1.5,
  shockDrag: 1.1,
  /** How hard a frozen kart is pinned to its grid slot, 1/s. */
  parkedDrag: 7,
  squashTime: 1.1,
  squashSpeedMul: 0.3,
  shockTime: 1.5,
  shockSpeedMul: 0.36,
  bumpTime: 0.32,
  starSpeedMul: 1.1,
  starGrip: 1.15,
  /** Respawn: lift, hang, drop, and the mercy afterwards. */
  respawnLift: 0.45,
  respawnHang: 0.3,
  respawnHeight: 2.2,
  respawnInvuln: 2.0,
  respawnSpeed: 7,

  // --- draft --------------------------------------------------------------
  /** Half-angle of the tow cone behind a rival, radians. */
  draftCone: 0.42,
  /** You have to be moving to get a tow. */
  draftMinSpeedFrac: 0.55,
  draftDecay: 1.5,

  // --- integration --------------------------------------------------------
  /** Substep whenever a step would move a kart further than this, metres. */
  substepDistance: 0.3,
  maxSubsteps: 6,
  /** Absolute speed ceiling — a safety rail against a runaway impulse. */
  speedCeiling: 90,
} as const;

// ---------------------------------------------------------------------------
// Weight and stats
// ---------------------------------------------------------------------------

/**
 * Not every boost is a mushroom. `TUNING.boostSpeedMul` is the full-strength
 * figure; a slipstream tow is a nudge and a bullet is a cannon, and without
 * this table a field running nose-to-tail spends the whole race at mushroom
 * speed, which makes the actual mushrooms worthless.
 */
const BOOST_STRENGTH: Record<BoostSource, number> = {
  miniTurbo: 1,
  pad: 1,
  mushroom: 1,
  start: 1,
  trick: 0.8,
  slipstream: 0.42,
  bullet: 1.3,
};

export function boostStrength(source: BoostSource | null): number {
  return source ? (BOOST_STRENGTH[source] ?? 1) : 1;
}

export type WeightClass = CharacterPreset["weight"];

/** Relative mass by weight class. Medium is 1. */
export const WEIGHT_MASS: Record<WeightClass, number> = {
  feather: 0.7,
  light: 0.84,
  medium: 1,
  cruiser: 1.2,
  heavy: 1.42,
};

/** Base chassis mass in kg — only ratios matter, but impulses read better in SI. */
export const BASE_MASS = 240;

export interface KartStats {
  mass: number;
  /** Top-speed multiplier. */
  speed: number;
  /** Acceleration multiplier. */
  accel: number;
  /** Steering-rate multiplier. */
  handling: number;
  /** Lateral grip multiplier. */
  traction: number;
  weight: WeightClass;
}

/**
 * Map a Mario-Kart-style 1..10 stat block onto physical multipliers. The ranges
 * are deliberately narrow: in this genre the spread between the fastest and
 * slowest kart is a few percent of top speed, and everything else is the
 * driver. A 20% spread would make half the roster unpickable.
 */
export function statsOf(preset: Pick<CharacterPreset, "weight" | "stats"> | undefined): KartStats {
  const s = preset?.stats;
  const weight: WeightClass = preset?.weight ?? "medium";
  const num = (v: number | undefined, fallback: number) =>
    Number.isFinite(v) ? Math.min(10, Math.max(1, v as number)) : fallback;
  return {
    mass: BASE_MASS * (WEIGHT_MASS[weight] ?? 1),
    speed: 0.94 + num(s?.speed, 5) * 0.014,
    accel: 0.8 + num(s?.accel, 5) * 0.042,
    handling: 0.86 + num(s?.handling, 5) * 0.032,
    traction: 0.86 + num(s?.traction, 5) * 0.03,
    weight,
  };
}

/**
 * A roster to fall back on when the model system failed to boot. Physics must
 * still produce a full, differentiated grid — a race of eight identical karts
 * is a bug the player can see.
 */
export const FALLBACK_ROSTER: CharacterPreset[] = [
  mk("scout", "Scout", "light", [6, 8, 8, 7, 3]),
  mk("bolt", "Bolt", "medium", [7, 6, 6, 6, 5]),
  mk("marina", "Marina", "feather", [5, 9, 9, 8, 2]),
  mk("gus", "Gus", "cruiser", [8, 4, 4, 5, 8]),
  mk("hex", "Hex", "medium", [7, 6, 7, 5, 5]),
  mk("tundra", "Tundra", "heavy", [9, 3, 3, 4, 10]),
  mk("pip", "Pip", "feather", [4, 10, 9, 9, 1]),
  mk("rook", "Rook", "cruiser", [8, 5, 5, 6, 8]),
];

function mk(
  id: string,
  name: string,
  weight: WeightClass,
  [speed, accel, handling, traction, w]: number[],
): CharacterPreset {
  return {
    id,
    name,
    blurb: "",
    weight,
    stats: { speed, accel, handling, traction, weight: w },
    colors: { body: 0xffffff, accent: 0xffffff, trim: 0xffffff },
    driver: { skin: 0xffffff, outfit: 0xffffff, hat: 0xffffff },
  };
}
