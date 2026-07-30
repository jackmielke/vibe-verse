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
}

const BASE: QualitySettings = {
  tier: "high",
  label: "High",
  maxPixelRatio: 1.5,
  drawDistance: 9000,
  detailRadius: 900,
  impostorRadius: 4200,
  shadowCascades: 4,
  shadowMapSize: 2048,
  shadowDistance: 900,
  textureSize: 1024,
  ssao: true,
  ssaoSamples: 16,
  ssr: true,
  volumetrics: true,
  volumetricSteps: 48,
  taa: true,
  motionBlur: true,
  bloom: true,
  depthOfField: true,
  lensEffects: true,
  maxParticles: 24000,
  maxRigidBodies: 260,
  crowdDensity: 1,
  foliageDensity: 1,
  anisotropy: 8,
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
    ssaoSamples: 10,
    ssr: false,
    volumetricSteps: 24,
    motionBlur: false,
    depthOfField: false,
    maxParticles: 9000,
    maxRigidBodies: 130,
    crowdDensity: 0.6,
    foliageDensity: 0.6,
    anisotropy: 4,
  },
  high: BASE,
  ultra: {
    ...BASE,
    tier: "ultra",
    label: "Ultra",
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
export function detectQualityTier(): QualityTier {
  if (typeof navigator === "undefined") return "high";
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 4;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (mobile) return mem >= 6 && cores >= 6 ? "medium" : "low";
  if (cores >= 12 && mem >= 16) return "ultra";
  if (cores >= 8 && mem >= 8) return "high";
  if (cores >= 4) return "medium";
  return "low";
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
