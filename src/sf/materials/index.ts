/**
 * The San Francisco: FREE FALL material lab — public surface.
 *
 * Three things live here and nothing else should import the submodules
 * directly unless it needs a primitive:
 *
 *   getMaterial(kind, opts)        — every tiling surface in the city
 *   getFacadeMaterial(style, opts) — every building elevation
 *   preload(tier, onProgress)      — build it all, with real progress
 *
 * Everything is generated at runtime from seeded noise; there are no image
 * assets to download, and the same seed produces the same city on every
 * machine (which the offline screenshot harness depends on).
 */

/* ---- generation toolkit (for subsystems that need bespoke textures) ---- */
export {
  // canvas
  makeSurface,
  setPreferOffscreenCanvas,
  surfaceToField,
  surfaceToRaster,
  // noise
  fbmField,
  ridgedField,
  worleyField,
  whiteNoiseField,
  // field maths
  fieldOf,
  copyField,
  scaleBias,
  addField,
  mulField,
  mixField,
  clampField,
  powField,
  invertField,
  thresholdField,
  contrastField,
  fieldRange,
  normalizeField,
  sampleWrap,
  blurField,
  warpField,
  makeSeamless,
  // derived maps
  normalFromHeight,
  aoFromHeight,
  curvatureFromHeight,
  edgeWearMask,
  cavityMask,
  // weathering
  streakField,
  stainField,
  crackField,
  patchField,
  grimeField,
  decalField,
  // rasterisation
  AlbedoBuffer,
  hexRgb,
  packORM,
  flipRaster,
  applyTextureOpts,
  rasterTexture,
  canvasTexture,
  normalTexture,
  macroVariationRaster,
  generatorRng,
  clearGeneratorCaches,
} from "./textureGen";

export type {
  Field,
  Raster,
  Surface,
  Ctx2D,
  RGB,
  NoiseOpts,
  WorleyOpts,
  WorleyResult,
  AoOpts,
  StreakOpts,
  StainOpts,
  CrackOpts,
  PatchOpts,
  TextureOpts,
} from "./textureGen";

/* ---- shader injection ---- */
export {
  applyTriplanar,
  applyDetailBlend,
  getSfUniforms,
  isTriplanar,
  setTriplanarWorldScale,
  updateTriplanar,
} from "./triplanar";

export type {
  TriplanarOptions,
  DetailOptions,
  TriplanarPatch,
  SfShaderUniforms,
} from "./triplanar";

/* ---- material registry ---- */
export {
  getMaterial,
  getCarPaintMaterial,
  getTextureSet,
  getMacroVariationTexture,
  materialWorldScale,
  setMaterialTier,
  getMaterialTier,
  isMaterialReady,
  disposeMaterials,
  materialMemoryBytes,
  MATERIAL_KINDS,
} from "./materialLibrary";

export type {
  MaterialKind,
  MaterialOptions,
  TextureSet,
  TextureSetOptions,
} from "./materialLibrary";

/* ---- facades ---- */
export {
  getFacadeAtlas,
  getFacadeMaterial,
  facadePanelMetrics,
  disposeFacadeAtlases,
  FACADE_STYLES,
} from "./facadeAtlas";

export type {
  FacadeAtlas,
  FacadeVariant,
  FacadeRect,
  FacadeAtlasOptions,
  FacadeMaterialOptions,
} from "./facadeAtlas";

/* ================================================================== *
 * Preload
 * ================================================================== */

import type { QualityTier } from "../config";
import { getFacadeAtlas, disposeFacadeAtlases, FACADE_STYLES } from "./facadeAtlas";
import {
  MATERIAL_KINDS,
  disposeMaterials,
  getMacroVariationTexture,
  getTextureSet,
  setMaterialTier,
  type MaterialKind,
} from "./materialLibrary";

export interface PreloadStep {
  label: string;
  run: () => void;
  /** Relative cost, used to weight the progress bar honestly. */
  weight: number;
}

/**
 * Materials the player will be standing on or looking at within the first
 * second. These are generated first so a fast-start path can begin rendering
 * before the long tail (roof tiles, chainlink, chrome) has finished.
 */
const CRITICAL: MaterialKind[] = [
  "asphalt",
  "concrete-sidewalk",
  "stucco",
  "brick-red",
  "glass-curtainwall",
  "concrete-cast",
  "grass",
];

const HUMAN_LABEL: Partial<Record<MaterialKind, string>> = {
  asphalt: "Paving Market Street",
  "asphalt-wet": "Wetting down the Embarcadero",
  "concrete-sidewalk": "Pouring sidewalks",
  "concrete-cast": "Striking the formwork",
  "brick-red": "Laying brick in Jackson Square",
  "brick-painted": "Painting over the brick",
  stucco: "Rendering the Sunset",
  "wood-siding": "Milling redwood siding",
  "victorian-trim": "Carving Victorian trim",
  "glass-curtainwall": "Glazing the Financial District",
  "glass-window-lit": "Turning on the lights",
  "steel-painted": "Mixing International Orange",
  "steel-rusted": "Rusting the shipyard",
  "corrugated-metal": "Bolting up Dogpatch",
  "roof-tar-gravel": "Tarring the rooftops",
  "roof-tile": "Laying mission tile",
  terracotta: "Firing terracotta",
  "marble-civic": "Polishing City Hall",
  sand: "Trucking in Ocean Beach",
  grass: "Seeding Golden Gate Park",
  foliage: "Planting cypress and eucalyptus",
  chainlink: "Fencing the lots",
  "road-marking-paint": "Painting lane lines",
  "rubber-tyre": "Vulcanising rubber",
  "car-paint": "Spraying clearcoat",
  chrome: "Chroming the bumpers",
  plastic: "Moulding trim",
};

function buildSteps(tier: QualityTier): PreloadStep[] {
  const steps: PreloadStep[] = [];
  steps.push({
    label: "Mixing pigments",
    weight: 0.5,
    run: () => {
      setMaterialTier(tier);
      getMacroVariationTexture(tier);
    },
  });
  const ordered = [
    ...CRITICAL,
    ...MATERIAL_KINDS.filter((k) => !CRITICAL.includes(k)),
  ];
  for (const kind of ordered) {
    steps.push({
      label: HUMAN_LABEL[kind] ?? `Generating ${kind}`,
      weight: CRITICAL.includes(kind) ? 2 : 1,
      run: () => {
        getTextureSet(kind, { tier });
      },
    });
  }
  for (const style of FACADE_STYLES) {
    steps.push({
      label: `Detailing ${style.replace(/-/g, " ")} facades`,
      weight: 3,
      run: () => {
        getFacadeAtlas(style, { tier });
      },
    });
  }
  return steps;
}

export type ProgressCallback = (fraction: number, label: string) => void;

let preloadedTier: QualityTier | null = null;
let inFlight: Promise<void> | null = null;

/** Yield to the browser so the loading screen can actually repaint. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * Generate the whole library, reporting genuine progress.
 *
 * Each step is a single synchronous bake — there is no way to interrupt a
 * 40 ms texture mid-flight — so we yield between steps. That keeps the loading
 * screen alive and makes the progress bar reflect real work rather than a
 * timer, which is the difference between "loading" and "hung".
 *
 * Safe to call twice: the second call returns the same promise.
 */
export function preload(
  tier: QualityTier = "high",
  onProgress?: ProgressCallback,
): Promise<void> {
  if (preloadedTier === tier && !inFlight) {
    onProgress?.(1, "Ready");
    return Promise.resolve();
  }
  if (inFlight) return inFlight;

  const steps = buildSteps(tier);
  const total = steps.reduce((a, s) => a + s.weight, 0);

  inFlight = (async () => {
    let done = 0;
    for (const step of steps) {
      onProgress?.(done / total, step.label);
      await nextTick();
      try {
        step.run();
      } catch (err) {
        // A single failed material must not take the level down with it — the
        // registry will fall back to regenerating it on demand.
        console.error(`[sf/materials] step failed: ${step.label}`, err);
      }
      done += step.weight;
    }
    onProgress?.(1, "Ready");
    preloadedTier = tier;
    inFlight = null;
  })();

  return inFlight;
}

/** True once `preload` has completed for this tier. */
export function isPreloaded(tier: QualityTier): boolean {
  return preloadedTier === tier;
}

/** Tear everything down — textures, materials, atlases and scratch buffers. */
export function disposeAll(): void {
  disposeFacadeAtlases();
  disposeMaterials();
  preloadedTier = null;
  inFlight = null;
}
