/**
 * weapons/types.ts — the vocabulary the whole gunplay stack speaks.
 *
 * Everything here is data or a plain interface. No three.js, no React, no
 * physics imports beyond the surface tag, so the registry can be unit-tested
 * and the ballistics solver can run headless in the screenshot harness.
 *
 * The one opinion baked into these types: a weapon is *data*, and every system
 * that makes a weapon feel like something — recoil, viewmodel, muzzle flash,
 * audio — reads that data rather than special-casing weapon names. Adding a
 * gun should mean adding a table row, not editing seven files.
 */
import type { PhysicsObject, SurfaceTag } from "../physics";

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

export type WeaponClass =
  | "sidearm"
  | "smg"
  | "rifle"
  | "battle"
  | "shotgun"
  | "sniper"
  | "lmg"
  | "launcher"
  | "rocket"
  | "sticky"
  | "thrown";

/** How the trigger behaves. */
export type FireMode = "semi" | "auto" | "burst" | "pump" | "bolt" | "single" | "throw";

/** How the round gets from muzzle to target. */
export type BallisticMode = "hitscan" | "projectile";

/** How the viewmodel cycles after a shot — drives animation and audio. */
export type ActionType = "slide" | "bolt" | "pump" | "openBolt" | "breech" | "tube" | "none";

/** Which body region a hit landed on. Multiplies damage. */
export type HitPart = "head" | "chest" | "stomach" | "arm" | "leg" | "none";

/* ------------------------------------------------------------------ *
 * Damage
 * ------------------------------------------------------------------ */

/**
 * A single knot on the damage-over-distance curve. Curves are authored as
 * "damage at these ranges" and linearly interpolated, which is how every
 * shipped shooter does it — designers think in "two-shot kill out to 30 m",
 * not in exponential coefficients.
 */
export interface DamageKnot {
  /** Metres from the muzzle. */
  d: number;
  /** Damage per round (or per pellet) at that range. */
  dmg: number;
}

export interface HitMultipliers {
  head: number;
  chest: number;
  stomach: number;
  arm: number;
  leg: number;
}

/* ------------------------------------------------------------------ *
 * Dispersion
 * ------------------------------------------------------------------ */

/**
 * Cone half-angles in degrees, per player state. The solver takes the base for
 * the current stance, adds `perShot` for every round still "hot", and clamps
 * at `max`. `recover` is degrees bled off per second once the trigger is
 * released — the reason a controlled burst is tighter than a held one.
 */
export interface SpreadProfile {
  hip: number;
  ads: number;
  /** Added while moving faster than a walk. */
  moving: number;
  /** Multiplier (not addend) while crouched — always < 1. */
  crouch: number;
  /** Added while airborne. Big, deliberately. */
  air: number;
  /** Added per shot fired. */
  perShot: number;
  /** Hard ceiling. */
  max: number;
  /** Degrees per second of bloom recovery. */
  recover: number;
  /** Shotguns: pellet count and the pattern cone. */
  pellets?: number;
  pelletCone?: number;
}

/* ------------------------------------------------------------------ *
 * Recoil
 * ------------------------------------------------------------------ */

/**
 * An authored recoil pattern.
 *
 * `pattern` is a per-shot list of [vertical, horizontal] impulses in degrees.
 * These are *authored curves*, not noise: the first few rounds climb hard and
 * straight, then the pattern breaks into a signature drift the player can
 * learn and counter. That learnability is the entire point — random recoil is
 * indistinguishable from bad aim, and players correctly hate it.
 *
 * `randomV/randomH` are the envelope *around* the authored value, expressed as
 * a fraction of it, so a pattern stays recognisable while never being twice
 * the same.
 */
export interface RecoilProfile {
  /** [vertical°, horizontal°] per shot index. */
  pattern: readonly (readonly [number, number])[];
  /** Applied to shots past the end of the pattern (the pattern loops with drift). */
  tailV: number;
  tailH: number;
  /** Randomness envelope, fraction of the authored magnitude. */
  randomV: number;
  randomH: number;
  /** How fast the aim punch is applied, 1/s. Higher = snappier. */
  riseRate: number;
  /** How fast the aim returns to the pre-fire point, 1/s. */
  recoveryRate: number;
  /** Seconds after the last shot before recovery starts. */
  recoveryDelay: number;
  /** Multiplier while aiming down sights. */
  adsScale: number;
  /** Multiplier while crouched. */
  crouchScale: number;
  /** Visual-only camera kick: [pitch°, yaw°, roll°] amplitude. */
  viewKick: readonly [number, number, number];
  /** Visual kick spring, rad/s and damping ratio. */
  viewKickFreq: number;
  viewKickDamp: number;
  /** Viewmodel push-back along the barrel, metres. */
  punchBack: number;
}

/* ------------------------------------------------------------------ *
 * Handling / animation timings
 * ------------------------------------------------------------------ */

export interface HandlingProfile {
  /** Seconds from "pressed aim" to full sight alignment. */
  adsTime: number;
  /** Seconds to raise the weapon on a switch. */
  drawTime: number;
  /** Seconds to lower it. */
  holsterTime: number;
  /** Seconds from sprint-stop to able-to-fire. */
  sprintOutTime: number;
  /** Seconds to enter the sprint carry. */
  sprintInTime: number;
  /** Tactical reload (round still chambered). */
  reloadTactical: number;
  /** Empty reload (must cycle the action). */
  reloadEmpty: number;
  /** Normalised time within the reload when the magazine leaves the weapon. */
  magOutAt: number;
  /** Normalised time when the fresh magazine seats — ammo is credited here. */
  magInAt: number;
  /** Normalised time when the bolt is released, on empty reloads only. */
  boltAt: number;
  /** Shell-at-a-time weapons: seconds per shell, and the in/out shoulder times. */
  shellTime?: number;
  shellStart?: number;
  shellEnd?: number;
  /** Seconds of inspect animation. */
  inspectTime: number;
}

/* ------------------------------------------------------------------ *
 * Sights
 * ------------------------------------------------------------------ */

export interface SightProfile {
  /** Magnification. 1 = iron sights at hip FOV. */
  zoom: number;
  /**
   * Where the sight sits relative to the weapon's local origin, metres. The
   * ADS transition lerps the *weapon* so this point lands on the camera axis —
   * which is what "correct sight alignment" means, and why the offset is
   * authored per weapon rather than hand-tuned per animation.
   */
  eyeOffset: readonly [number, number, number];
  /** True for a scope: renders the scope overlay, allows breath hold. */
  scoped: boolean;
  /** Seconds of steady hold available. */
  breathHold?: number;
  /** Seconds to fully recover the breath meter. */
  breathRecover?: number;
}

/* ------------------------------------------------------------------ *
 * Explosives
 * ------------------------------------------------------------------ */

export interface ExplosiveProfile {
  /** Blast radius, metres. */
  radius: number;
  /** Damage at the centre; falls to zero at the radius. */
  damage: number;
  /** Impulse applied to rigid bodies, N·s at the centre. */
  force: number;
  /** Seconds from arming to detonation. <= 0 means impact-fused. */
  fuse: number;
  /** Sticks to the first thing it touches instead of bouncing or exploding. */
  sticky?: boolean;
  /** Bounces (grenades) rather than detonating on contact. */
  bounces?: boolean;
  restitution?: number;
  /** Arming delay after launch — a rocket cannot kill you at the muzzle. */
  armTime?: number;
}

/* ------------------------------------------------------------------ *
 * Viewmodel shape (procedural geometry description)
 * ------------------------------------------------------------------ */

export interface ViewmodelSpec {
  /** Overall length in metres — the barrel axis runs -Z. */
  length: number;
  /** Receiver box half-extents. */
  bodyW: number;
  bodyH: number;
  /** Barrel radius and protrusion past the receiver. */
  barrelR: number;
  barrelLen: number;
  /** Muzzle device: none, brake, suppressor, flash hider, or a launcher tube. */
  muzzle: "none" | "brake" | "hider" | "tube" | "can";
  /** Magazine box size; zero for tube-fed and single-shot weapons. */
  magW: number;
  magH: number;
  magD: number;
  /** Where the magazine well sits along the receiver, metres from the origin. */
  magZ: number;
  /** Stock: none (pistol), folding, fixed, or a launcher's shoulder rest. */
  stock: "none" | "brace" | "fixed" | "rest";
  /** Optic type drawn on top. */
  optic: "irons" | "reddot" | "scope" | "ladder";
  /** Foregrip / handguard length. */
  handguard: number;
  /** Body colour and metal roughness — worn service finishes, never plastic toys. */
  bodyColor: number;
  metalColor: number;
  roughness: number;
  /** Ejection port side: +1 right, -1 left, 0 none (launchers). */
  ejectSide: 0 | 1 | -1;
  /** Casing size in metres [radius, length]; zero-length means no casing. */
  casing: readonly [number, number];
}

/* ------------------------------------------------------------------ *
 * The weapon
 * ------------------------------------------------------------------ */

export interface WeaponDef {
  key: string;
  name: string;
  /** Short label for the HUD. */
  short: string;
  cls: WeaponClass;
  fireMode: FireMode;
  ballistics: BallisticMode;
  action: ActionType;

  /** Rounds per minute. For pump/bolt guns this is the cycled rate. */
  rpm: number;
  /** Rounds in a burst, when fireMode is "burst". */
  burst?: number;
  /** Seconds between bursts. */
  burstDelay?: number;

  magazine: number;
  reserve: number;
  /** Starting reserve when the player first picks it up. */
  startReserve: number;
  /** True if a round stays chambered, giving mag+1 on a tactical reload. */
  chambered: boolean;

  damage: readonly DamageKnot[];
  mult: HitMultipliers;
  /** Damage against vehicles and destructibles is scaled by this. */
  structure: number;

  /** m/s. Drives projectile travel and hitscan tracer speed alike. */
  muzzleVelocity: number;
  /** Ballistic coefficient-ish drag term, 1/m. Zero for hitscan weapons. */
  drag: number;
  /** Gravity scale on the projectile. */
  gravity: number;

  /**
   * 0..1 — how much wall the round will go through. Multiplied by the
   * surface's own penetration factor; the product is the fraction of damage
   * that survives 10 cm of material.
   */
  penetration: number;
  /** Max materials a single round will pass through. */
  maxPenetrations: number;
  /** Degrees of incidence below which the round can skip off a hard surface. */
  ricochetAngle: number;
  /** Max ricochets before the round is retired. */
  maxRicochets: number;

  spread: SpreadProfile;
  recoil: RecoilProfile;
  handling: HandlingProfile;
  sight: SightProfile;
  explosive?: ExplosiveProfile;

  /** Fraction of shots that draw a tracer. 1 = every round (LMG belts). */
  tracerFraction: number;
  tracerColor: number;
  /** Muzzle flash scale and colour temperature. */
  flashScale: number;
  flashColor: number;
  /** Muzzle light intensity (candela-ish) and radius. */
  flashLight: number;
  flashRadius: number;
  /** Smoke per shot, 0..2. */
  smoke: number;
  /** Heat added per shot, 0..1 of the barrel's capacity. */
  heatPerShot: number;
  heatCool: number;

  /** Audio bank keys handed to the audio system. */
  audio: {
    fire: string;
    fireDistant: string;
    reloadOut: string;
    reloadIn: string;
    bolt: string;
    draw: string;
    dry: string;
    /** Perceived loudness, metres of audible radius. Drives AI alerting too. */
    loudness: number;
  };

  view: ViewmodelSpec;
  /** Free-text designer note; shown in the weapon wheel. */
  blurb: string;
}

/* ------------------------------------------------------------------ *
 * Hit reporting
 * ------------------------------------------------------------------ */

/**
 * Everything a consumer could want about a round that stopped somewhere.
 *
 * Deliberately a flat, reusable record: the ballistics solver owns a small
 * pool of these and hands them out by reference, so a 900 RPM SMG does not
 * allocate 15 objects a second per shot.
 */
export interface WeaponHit {
  hit: boolean;
  /** Impact point, world space. */
  x: number;
  y: number;
  z: number;
  /** Outward surface normal. */
  nx: number;
  ny: number;
  nz: number;
  /** Direction the round was travelling at impact (unit). */
  dx: number;
  dy: number;
  dz: number;
  /** Metres travelled from the muzzle, including any penetration legs. */
  distance: number;
  surface: SurfaceTag;
  object: PhysicsObject | null;
  /** Body part, when the hit resolved against a registered hitbox. */
  part: HitPart;
  /** Entity id from the hitbox provider, or -1. */
  targetId: number;
  /** Final damage after range falloff, penetration loss and part multiplier. */
  damage: number;
  /** How many materials the round went through before this hit. */
  penetrated: number;
  ricochets: number;
  /** Seconds of flight — zero for hitscan, real for projectiles. */
  travelTime: number;
  /** True when the round exited the far side and kept going. */
  throughAndThrough: boolean;
  /** Remaining energy fraction, 0..1. */
  energy: number;
}

export function makeWeaponHit(): WeaponHit {
  return {
    hit: false,
    x: 0, y: 0, z: 0,
    nx: 0, ny: 1, nz: 0,
    dx: 0, dy: 0, dz: -1,
    distance: 0,
    surface: "concrete",
    object: null,
    part: "none",
    targetId: -1,
    damage: 0,
    penetrated: 0,
    ricochets: 0,
    travelTime: 0,
    throughAndThrough: false,
    energy: 1,
  };
}

/* ------------------------------------------------------------------ *
 * Lag-compensation hitboxes
 * ------------------------------------------------------------------ */

/**
 * A capsule hitbox as seen at a particular moment.
 *
 * The AI/entity system fills these in; the ballistics solver never asks where
 * an entity *is*, only where it *was* at the time the trigger was pulled. That
 * is the whole lag-compensation contract, and it is worth having even in a
 * single-player game: projectiles take real time to arrive and the player
 * should hit what the crosshair was on when they fired, not where the target
 * drifted to during the 180 ms flight.
 */
export interface Hitbox {
  targetId: number;
  part: HitPart;
  /** Capsule segment, world space. */
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  radius: number;
  /** Multiplier on top of the weapon's part multiplier (armour, weak points). */
  scale: number;
  /** Set false for downed/dead targets that should stop soaking rounds. */
  alive: boolean;
}

export interface HitboxProvider {
  /**
   * Fill `out` with every hitbox within `radius` of the segment, as it existed
   * at `atTime` seconds of sim time. Return the count written. Implementations
   * that keep no history should ignore `atTime` and report the present.
   */
  query(
    atTime: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    out: Hitbox[],
  ): number;
}

/* ------------------------------------------------------------------ *
 * Player-facing firing context
 * ------------------------------------------------------------------ */

/** What the shooter was doing at the instant of the shot. */
export interface ShotContext {
  /** 0..1 aim-down-sights blend. */
  ads: number;
  crouched: boolean;
  moving: boolean;
  airborne: boolean;
  sprinting: boolean;
  /** Sim time of the shot — used for lag-compensated rewind. */
  time: number;
}
