/**
 * Quality tiers + device capability detection.
 * Every world/system module must read from here rather than hard-coding
 * geometry densities, texture sizes, or post-FX budgets.
 */

export type QualityTier = "low" | "medium" | "high" | "ultra";

export interface QualityProfile {
  tier: QualityTier;
  /** devicePixelRatio clamp */
  maxPixelRatio: number;
  /** directional light shadow map resolution; 0 disables shadows */
  shadowMapSize: number;
  /** number of cascades for the sun shadow */
  shadowCascades: number;
  /** procedural texture base resolution */
  textureSize: number;
  /** anisotropic filtering level */
  anisotropy: number;
  /** water reflection render target size; 0 = screen-space only */
  waterReflectionSize: number;
  /** enable screen-space ambient occlusion */
  ssao: boolean;
  /** enable bloom */
  bloom: boolean;
  /** enable motion blur / TAA-style temporal accumulation */
  temporal: boolean;
  /** volumetric god-ray quality: 0 off, 1 half-res, 2 full */
  volumetrics: number;
  /** particle budget multiplier */
  particleScale: number;
  /** draw distance in metres */
  drawDistance: number;
  /** crowd / instanced prop density multiplier */
  crowdDensity: number;
  /** grass + vegetation instance multiplier */
  foliageDensity: number;
  /** LOD bias — higher pushes detailed LODs further out */
  lodBias: number;
}

const PROFILES: Record<QualityTier, QualityProfile> = {
  low: {
    tier: "low",
    maxPixelRatio: 1,
    shadowMapSize: 1024,
    shadowCascades: 1,
    textureSize: 256,
    anisotropy: 2,
    waterReflectionSize: 0,
    ssao: false,
    bloom: true,
    temporal: false,
    volumetrics: 0,
    particleScale: 0.35,
    drawDistance: 3200,
    crowdDensity: 0.25,
    foliageDensity: 0.2,
    lodBias: 0.6,
  },
  medium: {
    tier: "medium",
    maxPixelRatio: 1.5,
    shadowMapSize: 2048,
    shadowCascades: 2,
    textureSize: 512,
    anisotropy: 4,
    waterReflectionSize: 256,
    ssao: false,
    bloom: true,
    temporal: false,
    volumetrics: 1,
    particleScale: 0.6,
    drawDistance: 5000,
    crowdDensity: 0.5,
    foliageDensity: 0.5,
    lodBias: 0.85,
  },
  high: {
    tier: "high",
    maxPixelRatio: 2,
    shadowMapSize: 2048,
    shadowCascades: 3,
    textureSize: 1024,
    anisotropy: 8,
    waterReflectionSize: 512,
    ssao: true,
    bloom: true,
    temporal: true,
    volumetrics: 1,
    particleScale: 1,
    drawDistance: 7000,
    crowdDensity: 1,
    foliageDensity: 1,
    lodBias: 1,
  },
  ultra: {
    tier: "ultra",
    maxPixelRatio: 2,
    shadowMapSize: 4096,
    shadowCascades: 4,
    textureSize: 2048,
    anisotropy: 16,
    waterReflectionSize: 1024,
    ssao: true,
    bloom: true,
    temporal: true,
    volumetrics: 2,
    particleScale: 1.5,
    drawDistance: 9000,
    crowdDensity: 1.4,
    foliageDensity: 1.5,
    lodBias: 1.3,
  },
};

export function getProfile(tier: QualityTier): QualityProfile {
  return { ...PROFILES[tier] };
}

export const isTouchDevice = (): boolean =>
  typeof window !== "undefined" &&
  ("ontouchstart" in window || navigator.maxTouchPoints > 0);

export const isMobile = (): boolean => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(ua) || (isTouchDevice() && window.innerWidth < 1024);
};

/**
 * Pick a starting tier from coarse device signals. The adaptive resolution
 * controller in Engine refines this at runtime from measured frame time.
 */
export function detectTier(): QualityTier {
  if (typeof navigator === "undefined") return "high";
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;

  if (isMobile()) {
    if (mem >= 6 && cores >= 6) return "medium";
    return "low";
  }
  if (mem >= 8 && cores >= 8) return "ultra";
  if (mem >= 8 || cores >= 8) return "high";
  return "medium";
}

export interface UserSettings {
  tier: QualityTier;
  autoQuality: boolean;
  sensitivity: number;
  fov: number;
  invertY: boolean;
  masterVolume: number;
  musicVolume: number;
  motionBlur: boolean;
  filmGrain: boolean;
  showFps: boolean;
  aimAssist: number;
}

export const DEFAULT_SETTINGS: UserSettings = {
  tier: detectTier(),
  autoQuality: true,
  sensitivity: 1,
  fov: 78,
  invertY: false,
  masterVolume: 0.8,
  musicVolume: 0.5,
  motionBlur: true,
  filmGrain: true,
  showFps: false,
  aimAssist: isMobile() ? 0.85 : 0.25,
};

const KEY = "seafair2117:settings";

export function loadSettings(): UserSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<UserSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: UserSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode — ignore */
  }
}
