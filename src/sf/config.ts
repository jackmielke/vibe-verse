/**
 * Global tuning + quality tiers for San Francisco: FREE FALL.
 *
 * One place to answer "how far do we draw", "how many shadow cascades", "how
 * big is a texture" — so the quality slider is a single switch rather than a
 * scavenger hunt through twenty files.
 */

export type QualityTier = "low" | "medium" | "high" | "ultra";

export interface QualitySettings {
  tier: QualityTier;
  label: string;
  /** Renderer pixel ratio cap. */
  maxPixelRatio: number;
  /** Camera far plane, metres. */
  drawDistance: number;
  /** Radius within which full-detail buildings are generated, metres. */
  detailRadius: number;
  /** Radius for silhouette-only (impostor) buildings, metres. */
  impostorRadius: number;
  /** Cascaded shadow map cascade count + per-cascade resolution. */
  shadowCascades: number;
  shadowMapSize: number;
  /** Max shadow distance, metres. */
  shadowDistance: number;
  /** Procedural material texture resolution. */
  textureSize: number;
  /** Screen-space ambient occlusion. */
  ssao: boolean;
  ssaoSamples: number;
  /** Screen-space reflections on wet asphalt + glass. */
  ssr: boolean;
  /** Raymarched volumetric light shafts through the fog. */
  volumetrics: boolean;
  volumetricSteps: number;
  /** Temporal anti-aliasing (vs. plain FXAA). */
  taa: boolean;
  /** Per-object motion blur. */
  motionBlur: boolean;
  bloom: boolean;
  /** Depth of field on ADS + cinematics. */
  depthOfField: boolean;
  /** Chromatic aberration + lens dirt + vignette. */
  lensEffects: boolean;
  /** Max simultaneous GPU particles. */
  maxParticles: number;
  /** Max simultaneous physics-active rigid bodies. */
  maxRigidBodies: number;
  /** Traffic + pedestrian population multiplier. */
  crowdDensity: number;
  /** Vegetation instance multiplier. */
  foliageDensity: number;
  /** Anisotropic filtering level. */
  anisotropy: number;
  /**
   * Run the post-processing composer at all.
   *
   * Off means the scene is rendered straight to the screen: no HDR
   * intermediates, no render targets, no grade. That is not a downgrade you
   * negotiate pass by pass — a phone cannot afford several full-resolution
   * half-float targets at devicePixelRatio 3 no matter which effects are
   * ticked, and the cost is paid on allocation rather than on use.
   */
  postProcessing: boolean;
}

/**
 * High — what a normal desktop gets, and therefore what most people see.
 *
 * This used to be the whole feature list switched on: screen-space
 * reflections, forty-eight-step volumetrics, temporal AA, per-object motion
 * blur, depth of field and lens effects, all at once, for anyone with eight
 * cores. Two things came back from that, and both were right:
 *
 *  - **It was blurry.** TAA resolves by blending the last frame into this one,
 *    which is close to free and looks superb at a locked 60 — and smears into
 *    a soft, ghosting mess the moment the frame rate is uneven, which in a
 *    streaming open world in a browser tab it always is. Motion blur then
 *    smears the smear. SMAA costs a little more per frame and is *sharp*, and
 *    sharp is worth more here than perfect edges.
 *  - **It crashed machines.** The expensive passes are expensive on
 *    allocation, not just per pixel: every one wants its own full-resolution
 *    half-float target, and a 1.5× pixel ratio on a 4K display is a lot of
 *    video memory before a single triangle is drawn.
 *
 * So High is now a *light* chain — ambient occlusion, bloom, the grade, SMAA —
 * and the full one lives at Ultra, which nothing auto-detects into. If you
 * want the whole thing you can ask for it, and asking is the point.
 */
const BASE: QualitySettings = {
  tier: "high",
  label: "High",
  maxPixelRatio: 1.5,
  drawDistance: 9000,
  detailRadius: 900,
  impostorRadius: 4200,
  shadowCascades: 3,
  shadowMapSize: 2048,
  shadowDistance: 900,
  textureSize: 1024,
  ssao: true,
  ssaoSamples: 12,
  ssr: false,
  volumetrics: false,
  volumetricSteps: 24,
  taa: false,
  motionBlur: false,
  bloom: true,
  depthOfField: false,
  lensEffects: false,
  maxParticles: 18000,
  maxRigidBodies: 200,
  crowdDensity: 1,
  foliageDensity: 1,
  anisotropy: 8,
  postProcessing: true,
};

export const QUALITY: Record<QualityTier, QualitySettings> = {
  low: {
    ...BASE,
    tier: "low",
    label: "Low",
    maxPixelRatio: 1,
    drawDistance: 4500,
    detailRadius: 420,
    impostorRadius: 1800,
    shadowCascades: 2,
    shadowMapSize: 1024,
    shadowDistance: 320,
    textureSize: 256,
    ssao: false,
    ssaoSamples: 8,
    ssr: false,
    volumetrics: false,
    volumetricSteps: 12,
    taa: false,
    motionBlur: false,
    bloom: true,
    depthOfField: false,
    lensEffects: false,
    maxParticles: 3000,
    maxRigidBodies: 60,
    crowdDensity: 0.35,
    foliageDensity: 0.35,
    anisotropy: 2,
    // Straight to the screen. This is the tier every phone gets.
    postProcessing: false,
  },
  medium: {
    ...BASE,
    tier: "medium",
    label: "Medium",
    maxPixelRatio: 1.25,
    drawDistance: 6500,
    detailRadius: 640,
    impostorRadius: 2800,
    shadowCascades: 3,
    shadowMapSize: 1536,
    shadowDistance: 560,
    textureSize: 512,
    ssao: false,
    ssaoSamples: 10,
    ssr: false,
    volumetrics: false,
    volumetricSteps: 24,
    taa: false,
    motionBlur: false,
    depthOfField: false,
    lensEffects: false,
    maxParticles: 9000,
    maxRigidBodies: 130,
    crowdDensity: 0.6,
    foliageDensity: 0.6,
    anisotropy: 4,
    postProcessing: true,
  },
  high: BASE,
  /**
   * Everything, for a machine you have decided can take it. Nothing
   * auto-detects into this tier — see `detectQualityTier`.
   */
  ultra: {
    ...BASE,
    tier: "ultra",
    label: "Ultra",
    ssr: true,
    volumetrics: true,
    taa: true,
    motionBlur: true,
    depthOfField: true,
    lensEffects: true,
    maxPixelRatio: 2,
    drawDistance: 12000,
    detailRadius: 1400,
    impostorRadius: 6000,
    shadowCascades: 4,
    shadowMapSize: 4096,
    shadowDistance: 1400,
    textureSize: 2048,
    ssaoSamples: 24,
    volumetricSteps: 96,
    maxParticles: 48000,
    maxRigidBodies: 420,
    crowdDensity: 1.35,
    foliageDensity: 1.4,
    anisotropy: 16,
  },
};

/**
 * Pick a starting tier from what the device tells us. Deliberately
 * conservative — it is far better to start at Medium and let the player push
 * it up than to open at Ultra and stutter through the first ten seconds.
 */
/* ================================================================== *
 * The clock
 * ================================================================== */

/**
 * How long a full day takes, in real minutes.
 *
 * Every system in this world already reads `frame.timeOfDay` — the sky, the
 * nine thousand window lights, the street lamps, the neon, headlights, the
 * ambience mix, how many people are on the pavement and which people they are
 * — and for a long time nothing ever moved it. San Francisco was permanently
 * 5:24 in the afternoon. Turning the clock on does not add a feature so much
 * as connect eighteen files that were already waiting for it.
 *
 * Forty-eight minutes is Grand Theft Auto V's number and it is a good one: an
 * in-game hour every two minutes, so a sunset is something you sit and watch
 * rather than something that happens between glances, and you will still see
 * one inside a single visit.
 */
export const DAY_MINUTES = 48;

/** In-game hours per real second. */
export const CLOCK_RATE = 24 / (DAY_MINUTES * 60);

/**
 * What time it is in San Francisco, right now, as a fractional hour.
 *
 * The world opens on the real city's clock. Load it over breakfast and the
 * sun is coming up over the East Bay; load it at midnight and Market Street is
 * empty and lit. It costs nothing and it is the difference between a level and
 * a place.
 *
 * Via `Intl` rather than a fixed UTC offset, so this is right on both sides of
 * a daylight-saving change without anybody having to remember it.
 */
export function sanFranciscoHour(now: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? NaN);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return 17.4;
    // `hour12: false` yields 24 for midnight in some engines rather than 0.
    return (h % 24) + m / 60;
  } catch {
    // An environment without the time-zone database. Late afternoon is the
    // hour this world was art-directed at, so it is the right thing to fall
    // back to.
    return 17.4;
  }
}

/**
 * The real hour if the sun is up in San Francisco, otherwise late afternoon.
 *
 * For the door that promises a game (`/free-fall`). The real clock is right
 * for the city, and wrong for somebody who opened a game at eight in the
 * evening and got a black street they could not see to play on. The clock
 * still runs from here, so night still comes, just not as the first thing.
 */
export function daylightHour(now: Date = new Date()): number {
  const h = sanFranciscoHour(now);
  return h >= 8 && h <= 18 ? h : 16.5;
}

/** Advance a clock, wrapping at midnight. */
export function advanceClock(hour: number, dtSeconds: number): number {
  const next = hour + dtSeconds * CLOCK_RATE;
  return ((next % 24) + 24) % 24;
}

export function detectQualityTier(): QualityTier {
  if (typeof navigator === "undefined") return "medium";
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  if (isTouchDevice()) return "low";
  if (cores >= 12 && mem >= 16) return "high";
  if (cores >= 8 && mem >= 8) return "medium";
  return "low";
}

/**
 * A phone or a tablet, by input rather than by user-agent string.
 *
 * iPadOS reports itself as a Mac and has for years, so a UA sniff hands the
 * heaviest tier to a tablet; `maxTouchPoints` is the thing that has always
 * been true. Desktops with touchscreens get a cheaper tier than they can
 * afford, which is the failure that costs nothing.
 *
 * `navigator.deviceMemory` is Chromium-only, so Safari answers `undefined`
 * for the whole cast — every iPhone, every iPad, every Mac. Defaulting that
 * to 8 GB meant Safari fell through to the top desktop tier by *omission*.
 * It defaults to 4 now: unknown hardware is modest hardware.
 */
export function isTouchDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  if (navigator.maxTouchPoints > 1) return true;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/* ------------------------------------------------------------------ *
 * Gameplay tuning — the numbers that make it *feel* like Just Cause.
 * ------------------------------------------------------------------ */

export const PLAYER = {
  eyeHeight: 1.68,
  crouchEyeHeight: 1.02,
  radius: 0.38,
  height: 1.82,
  walkSpeed: 4.4,
  sprintSpeed: 8.6,
  crouchSpeed: 2.1,
  airControl: 0.34,
  jumpVelocity: 6.4,
  gravity: -22.5, // punchier than real gravity; standard shooter feel
  maxHealth: 100,
  regenDelay: 5.0,
  regenRate: 14,
  stepHeight: 0.55,
  /** Terminal velocity in a normal fall, m/s. */
  terminalVelocity: 62,
  /** Above this impact speed you take fall damage. */
  safeLandingSpeed: 14,
  /** Camera FOV, degrees. */
  fov: 74,
  sprintFovBoost: 8,
  adsFovScale: 0.62,
  mouseSensitivity: 0.0022,
} as const;

export const GRAPPLE = {
  /** Max hook range, metres. */
  maxRange: 240,
  /** Hook travel speed, m/s. */
  projectileSpeed: 220,
  /** Reel-in acceleration toward the anchor, m/s². */
  reelAcceleration: 62,
  /** Max reel speed, m/s. */
  maxReelSpeed: 48,
  /** Tether spring constant when swinging. */
  springK: 44,
  springDamping: 3.4,
  /** How many independent tethers can be live at once. */
  maxTethers: 2,
  /** Retract cooldown, seconds. */
  cooldown: 0.18,
  /** Boost applied when releasing at the bottom of a swing. */
  releaseBoost: 1.14,
} as const;

export const WINGSUIT = {
  /** Lift coefficient — how much forward speed becomes upward force. */
  lift: 1.55,
  drag: 0.021,
  /** Minimum airspeed before the suit stalls, m/s. */
  stallSpeed: 18,
  maxSpeed: 96,
  /** Pitch/roll authority, rad/s. */
  pitchRate: 1.5,
  rollRate: 2.6,
  yawFromRoll: 0.85,
  /** Altitude below which auto-deploy warning fires, metres AGL. */
  pullWarning: 60,
  /** Boost thruster, m/s². */
  boostAccel: 46,
  boostFuel: 3.2,
  boostRefill: 0.55,
} as const;

export const PARACHUTE = {
  deployTime: 0.42,
  descentRate: 6.2,
  forwardSpeed: 15,
  turnRate: 1.5,
  /** Air brake multiplier when both triggers held. */
  flareStrength: 0.35,
} as const;

export const VEHICLE = {
  /** Suspension rest length, metres. */
  suspensionRest: 0.42,
  suspensionStiffness: 32,
  suspensionDamping: 3.1,
  maxSuspensionTravel: 0.34,
  wheelFriction: 2.6,
  rollInfluence: 0.12,
  /** How hard a hijack yanks a driver out. */
  hijackRange: 3.2,
} as const;

export const CHAOS = {
  /** Chaos points per destroyed object class. */
  points: {
    prop: 5,
    vehicle: 40,
    fuelTank: 120,
    generator: 200,
    tower: 350,
    billboard: 90,
  },
  /** Chaos needed per heat level. */
  heatThresholds: [0, 250, 700, 1600, 3200, 6000],
  /** Seconds without incident before heat decays a level. */
  heatDecaySeconds: 22,
} as const;

/** Seed for the whole world. Change it and you get a different San Francisco. */
export const WORLD_SEED = "san-francisco-free-fall-v1";
