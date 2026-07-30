/**
 * Tuning and quality tiers for VIBE ISLAND II.
 *
 * Deliberately separate from San Francisco's config even where the numbers
 * rhyme. The two worlds want genuinely different budgets — SF spends its
 * frame on a 9.5 km city with a huge draw distance; the island is small and
 * spends everything it has on foliage density, water and atmosphere, which is
 * where its beauty lives.
 */

export type QualityTier = "low" | "medium" | "high" | "ultra";

export interface QualitySettings {
  tier: QualityTier;
  label: string;
  maxPixelRatio: number;
  /** Camera far plane, metres. */
  drawDistance: number;
  /** Terrain mesh resolution across an island's diameter. */
  terrainSegments: number;
  shadowMapSize: number;
  shadowDistance: number;
  /** Procedural texture resolution. */
  textureSize: number;
  ssao: boolean;
  ssr: boolean;
  /** Raymarched god rays through the cloud deck. */
  volumetrics: boolean;
  volumetricSteps: number;
  bloom: boolean;
  depthOfField: boolean;
  /** Vegetation instance multiplier — the single biggest look/perf lever here. */
  foliageDensity: number;
  /** Max simultaneous particles (spray, pollen, fireflies, leaves). */
  maxParticles: number;
  /** Cloud-sea raymarch quality. */
  cloudSteps: number;
  anisotropy: number;
}

const HIGH: QualitySettings = {
  tier: "high",
  label: "High",
  maxPixelRatio: 1.5,
  drawDistance: 6000,
  terrainSegments: 224,
  shadowMapSize: 2048,
  shadowDistance: 420,
  textureSize: 1024,
  ssao: true,
  ssr: true,
  volumetrics: true,
  volumetricSteps: 48,
  bloom: true,
  depthOfField: true,
  foliageDensity: 1,
  maxParticles: 18000,
  cloudSteps: 32,
  anisotropy: 8,
};

export const QUALITY: Record<QualityTier, QualitySettings> = {
  low: {
    ...HIGH,
    tier: "low", label: "Low",
    maxPixelRatio: 1, drawDistance: 3000, terrainSegments: 96,
    shadowMapSize: 1024, shadowDistance: 180, textureSize: 256,
    ssao: false, ssr: false, volumetrics: false, volumetricSteps: 10,
    depthOfField: false, foliageDensity: 0.3, maxParticles: 2500,
    cloudSteps: 10, anisotropy: 2,
  },
  medium: {
    ...HIGH,
    tier: "medium", label: "Medium",
    maxPixelRatio: 1.25, drawDistance: 4200, terrainSegments: 144,
    shadowMapSize: 1536, shadowDistance: 300, textureSize: 512,
    ssr: false, volumetricSteps: 24, depthOfField: false,
    foliageDensity: 0.6, maxParticles: 7000, cloudSteps: 18, anisotropy: 4,
  },
  high: HIGH,
  ultra: {
    ...HIGH,
    tier: "ultra", label: "Ultra",
    maxPixelRatio: 2, drawDistance: 9000, terrainSegments: 320,
    shadowMapSize: 4096, shadowDistance: 620, textureSize: 2048,
    volumetricSteps: 96, foliageDensity: 1.5, maxParticles: 36000,
    cloudSteps: 64, anisotropy: 16,
  },
};

/** Conservative device sniff — better to open at Medium than stutter at Ultra. */
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
 * Movement — this world is about gliding, not gunfights.
 * ------------------------------------------------------------------ */

export const PLAYER = {
  eyeHeight: 1.66,
  radius: 0.36,
  walkSpeed: 4.2,
  sprintSpeed: 8.0,
  gravity: -19.5,
  jumpVelocity: 7.4,
  /** Double-jump gives the island its bouncy, generous feel. */
  airJumps: 1,
  airControl: 0.42,
  terminalVelocity: 55,
  stepHeight: 0.5,
  fov: 72,
  sprintFovBoost: 7,
  mouseSensitivity: 0.0022,
} as const;

/** The glider — the island's signature traversal, replacing SF's wingsuit. */
export const GLIDER = {
  lift: 1.42,
  drag: 0.019,
  stallSpeed: 12,
  maxSpeed: 62,
  pitchRate: 1.4,
  rollRate: 2.4,
  yawFromRoll: 0.9,
  /** Warm updraughts rise off the islands; riding them is how you gain height. */
  thermalStrength: 11,
  thermalRadius: 90,
} as const;

export const ZIPLINE = {
  speed: 22,
  accel: 14,
  /** How close you must be to a tower handle to grab it. */
  grabRadius: 3.2,
} as const;

/** Seed for the whole world. Change it and you get a different archipelago. */
export const WORLD_SEED = "vibe-island-ii-v1";
