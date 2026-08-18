/**
 * One quality ladder for every world.
 *
 * ## Why this exists
 *
 * There were seven copies of this before — `sf/config.ts`, `island2/config.ts`,
 * `seafair/core/Settings.ts`, `royale/engine/core.ts`, `kart/engine/core.ts`,
 * `palmas/engine/core.ts`, `golf/engine/core.ts` — and they disagreed about the
 * same laptop. A 10-core MacBook was `ultra` in Vibe Kart, `high` in Splash
 * Royale, and in San Francisco it hit an `ultra` branch that *cannot be
 * reached*, because that branch tests `deviceMemory >= 16` and no browser will
 * ever report more than 8.
 *
 * This is the registry argument from CLAUDE.md, applied to settings: one list,
 * so that the nav and the picker cannot drift apart. Do not start an eighth.
 *
 * ## Why the old signals could not work
 *
 * All seven guessed from `navigator.deviceMemory` and `hardwareConcurrency`:
 *
 *   - **`deviceMemory` is not implemented in Safari or Firefox at all**, so on
 *     roughly half of desktop traffic every branch fell through to the `?? 8`
 *     default and the guess was a constant.
 *   - **Chrome caps it at 8** to resist fingerprinting. It is not a memory
 *     reading, it is a bucket, and the top bucket starts at 8 GB.
 *   - **Neither says anything about the GPU**, which is the thing that renders.
 *     A 16-core Mac Pro with integrated graphics and an 8-core laptop with a
 *     discrete card score identically, and they are not close.
 *
 * So this reads the GPU string instead, via `WEBGL_debug_renderer_info`, and
 * counts the pixels it will actually have to fill. A Retina display is not a
 * free upgrade: at DPR 2 a 1512-wide MacBook screen is 4.4 M pixels a frame,
 * which is more than a 4K monitor at DPR 1.
 *
 * ## The part that matters more than the guess
 *
 * `createAdaptive()` measures the frame time and moves the render scale. That
 * is the mechanism that actually protects a weak machine, and it means the
 * guess above only has to be *approximately* right — it picks a starting point,
 * not a destiny. Lifted from `seafair/core/Engine.ts`, which had the only
 * working copy in the repo and kept it to itself.
 */

export type QualityTier = "low" | "medium" | "high" | "ultra";

export interface QualityProfile {
  tier: QualityTier;
  /** Hard clamp on devicePixelRatio. The single most expensive number here. */
  maxPixelRatio: number;
  /** Sun shadow map resolution. 0 disables shadows entirely. */
  shadowMapSize: number;
  /** How far the sun shadow camera reaches, in metres. */
  shadowDistance: number;
  /** Procedural / render-target texture base resolution. */
  textureSize: number;
  anisotropy: number;
  /** Planar reflection render target size. 0 = no reflections. */
  reflectionSize: number;
  ssao: boolean;
  bloom: boolean;
  /** Screen-space fog / god rays: 0 off, 1 half-res, 2 full. */
  volumetrics: number;
  /** Multiplier on particle and instance counts. */
  particleScale: number;
  foliageDensity: number;
  drawDistance: number;
}

const PROFILES: Record<QualityTier, QualityProfile> = {
  low: {
    tier: "low",
    maxPixelRatio: 1,
    shadowMapSize: 0,
    shadowDistance: 60,
    textureSize: 256,
    anisotropy: 1,
    reflectionSize: 0,
    ssao: false,
    bloom: false,
    volumetrics: 0,
    particleScale: 0.3,
    foliageDensity: 0.2,
    drawDistance: 900,
  },
  medium: {
    tier: "medium",
    maxPixelRatio: 1.25,
    shadowMapSize: 1024,
    shadowDistance: 90,
    textureSize: 512,
    anisotropy: 4,
    reflectionSize: 256,
    ssao: false,
    bloom: true,
    volumetrics: 1,
    particleScale: 0.6,
    foliageDensity: 0.55,
    drawDistance: 1600,
  },
  high: {
    tier: "high",
    maxPixelRatio: 1.5,
    shadowMapSize: 2048,
    shadowDistance: 140,
    textureSize: 1024,
    anisotropy: 8,
    reflectionSize: 512,
    ssao: true,
    bloom: true,
    volumetrics: 1,
    particleScale: 1,
    foliageDensity: 1,
    drawDistance: 2600,
  },
  ultra: {
    tier: "ultra",
    maxPixelRatio: 2,
    shadowMapSize: 4096,
    shadowDistance: 200,
    textureSize: 2048,
    anisotropy: 16,
    reflectionSize: 1024,
    ssao: true,
    bloom: true,
    volumetrics: 2,
    particleScale: 1.4,
    foliageDensity: 1.4,
    drawDistance: 4000,
  },
};

export const getProfile = (tier: QualityTier): QualityProfile => ({ ...PROFILES[tier] });

export const isTouch = (): boolean =>
  typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0);

export const isMobile = (): boolean => {
  if (typeof navigator === "undefined") return false;
  return (
    /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent) ||
    (isTouch() && window.innerWidth < 1024)
  );
};

/**
 * What the GPU calls itself, e.g. "Apple M2", "ANGLE (Intel, Intel(R) Iris(TM)
 * Plus Graphics ...)", "NVIDIA GeForce RTX 4070".
 *
 * Costs one throwaway context, so it is cached — a page that asks twice should
 * not pay twice, and contexts are a capped resource (see docs/performance.md).
 * Returns "" where the extension is masked, which is a legitimate answer and
 * must not be read as "weak".
 */
let gpuCache: string | null = null;
export function gpuName(): string {
  if (gpuCache !== null) return gpuCache;
  gpuCache = "";
  if (typeof document === "undefined") return gpuCache;
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") ?? c.getContext("webgl");
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      if (ext) gpuCache = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? "");
      /* Hand the context straight back. Without this the probe itself leaks one
         of the ~16 a tab is allowed. */
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    /* masked, blocked, or no WebGL — "" and move on */
  }
  return gpuCache;
}

/** Rough buckets from the renderer string. Deliberately coarse. */
function gpuClass(name: string): "weak" | "mid" | "strong" | "unknown" {
  if (!name) return "unknown";
  const s = name.toLowerCase();
  /* Software rasterisers. Nothing else matters if we are here. */
  if (/swiftshader|llvmpipe|software|basic render/.test(s)) return "weak";
  /* Apple silicon: even the base M1 outruns any integrated Intel part. */
  if (/apple m[1-9]/.test(s)) return /m[1-9]\s*(pro|max|ultra)/.test(s) ? "strong" : "mid";
  /* Discrete cards. */
  if (/rtx|radeon rx|geforce gtx 1[6-9]|geforce rtx|arc a[0-9]/.test(s)) return "strong";
  /* The integrated parts that people actually struggle on — including every
     Intel MacBook, which is the machine that started this audit. */
  if (/intel|uhd|iris|hd graphics|vega [0-9]|adreno [1-5][0-9]{2}\b|mali-[tg]/.test(s)) return "weak";
  if (/geforce|radeon|quadro|firepro/.test(s)) return "mid";
  return "unknown";
}

/**
 * Pick a starting tier. Refined a second later by `createAdaptive`, so being
 * one step optimistic is survivable and being one step pessimistic is not
 * permanent.
 */
export function detectTier(): QualityTier {
  if (typeof navigator === "undefined") return "medium";

  const cores = navigator.hardwareConcurrency ?? 4;
  const cls = gpuClass(gpuName());

  if (isMobile()) return cls === "strong" || cls === "mid" ? "medium" : "low";

  /* How many pixels this display will actually demand at the tier's own cap.
     A 5K iMac and a 1080p monitor are not the same workload on the same GPU. */
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const px = typeof window !== "undefined" ? window.innerWidth * window.innerHeight * Math.min(dpr, 2) ** 2 : 2e6;
  const dense = px > 4.5e6;

  if (cls === "weak") return dense ? "low" : "medium";
  if (cls === "strong") return dense && cores < 8 ? "high" : "ultra";
  if (cls === "mid") return dense ? "medium" : "high";

  /* Unknown GPU — the extension is masked, which Firefox does by default. Fall
     back to the old core count, but never to the top tier: an unknown machine
     that turns out to be fast climbs there within a second or two, and one that
     turns out to be slow never had to stutter to find out. */
  return cores >= 8 ? "high" : "medium";
}

export interface Adaptive {
  /** Feed one frame's delta, in seconds. Cheap; call it every frame. */
  sample(dt: number): void;
  /** Current scale on top of the pixel-ratio cap, 0.5–1. */
  readonly scale: number;
  /** Smoothed frames per second over the sample window. */
  readonly fps: number;
  reset(): void;
}

/**
 * Adaptive resolution: watch the frame time, move the render scale.
 *
 * Judged on the **p90**, not the mean. A world that renders at a comfortable
 * 60 and stalls every twelfth frame is the one that feels broken, and a mean
 * hides exactly that. Hysteresis is deliberately lopsided — drop fast (0.08),
 * recover slowly (0.04) — because oscillating between two scales is more
 * visible than sitting one step too low.
 *
 * `onChange` only fires when the scale actually moves, so it is safe to do
 * something expensive in it (resizing render targets, rebuilding a composer).
 */
export function createAdaptive(opts: {
  targetFps?: number;
  min?: number;
  onChange: (scale: number) => void;
}): Adaptive {
  const target = 1 / (opts.targetFps ?? 58);
  const min = opts.min ?? 0.5;
  const times: number[] = [];
  let scale = 1;
  let timer = 0;
  let mean = target;

  return {
    get scale() {
      return scale;
    },
    get fps() {
      return 1 / Math.max(mean, 1e-4);
    },
    reset() {
      times.length = 0;
      timer = 0;
      scale = 1;
    },
    sample(dt: number) {
      /* A tab that was backgrounded returns one enormous delta. Feeding that to
         the controller drops the scale to the floor for a world that is running
         perfectly well. */
      if (dt > 0.25) return;
      times.push(dt);
      if (times.length > 90) times.shift();
      timer += dt;
      if (timer < 1 || times.length < 45) return;
      timer = 0;

      const sorted = [...times].sort((a, b) => a - b);
      const p90 = sorted[Math.floor(sorted.length * 0.9)];
      mean = times.reduce((a, b) => a + b, 0) / times.length;

      const prev = scale;
      if (p90 > target * 1.2) scale = Math.max(min, scale - 0.08);
      else if (p90 < target * 0.75) scale = Math.min(1, scale + 0.04);
      if (Math.abs(prev - scale) > 1e-3) opts.onChange(scale);
    },
  };
}

/**
 * Release a renderer's GL context for real.
 *
 * `renderer.dispose()` in three r160 drops three's own caches and leaves the
 * context to the garbage collector, which may take its time. Browsers allow
 * around sixteen live contexts per tab and evict the **oldest** when you pass
 * it — so a world that leaks one does not break itself, it breaks whichever
 * world the visitor opened first. Measured before this existed: six worlds
 * visited, twelve contexts alive, one released.
 *
 * Call this in teardown, after disposing your own geometries and materials.
 */
export function releaseRenderer(renderer: {
  dispose(): void;
  forceContextLoss?: () => void;
  domElement?: HTMLCanvasElement;
}): void {
  try {
    renderer.dispose();
  } catch {
    /* already gone */
  }
  try {
    renderer.forceContextLoss?.();
  } catch {
    /* context already lost — that is the desired end state anyway */
  }
}
