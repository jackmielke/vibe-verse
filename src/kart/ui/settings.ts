/**
 * Vibe Kart — player settings, persisted and applied to the live services.
 *
 * Four knobs, deliberately: graphics, sound, difficulty, camera. Anything more
 * belongs in a options screen nobody opens.
 *
 * `ctx.quality` is fixed at boot by the engine and cannot be changed without
 * rebuilding every material, so the graphics row does not pretend to change it.
 * What it does change is the post stack, which *is* live — and which is where
 * the frame time actually goes. "Performance" drops the expensive temporal and
 * volumetric passes, "Beautiful" turns everything the driver supports back on.
 *
 * Nothing here imports another subsystem. Services are read off `ctx.services`
 * through structural views, and every one of them is allowed to be absent — a
 * settings screen that throws because the audio system failed to boot would
 * take the pause menu down with it.
 */
import type { KartCtx, PostFxFlags } from "../types";

export type GraphicsPreset = "performance" | "balanced" | "beautiful";
/** Mirrors the AI system's cc classes without importing it. */
export type Difficulty = "50cc" | "100cc" | "150cc" | "200cc";
export type CameraChoice = "chase" | "chaseFar" | "hood";

export interface KartSettings {
  graphics: GraphicsPreset;
  muted: boolean;
  difficulty: Difficulty;
  camera: CameraChoice;
}

const KEY = "vibe-kart:settings";

const DEFAULTS: KartSettings = {
  graphics: "balanced",
  muted: false,
  difficulty: "150cc",
  camera: "chase",
};

export const GRAPHICS_LABEL: Record<GraphicsPreset, string> = {
  performance: "Fast",
  balanced: "Balanced",
  beautiful: "Beautiful",
};

/** Post-processing profiles. Exposure is left alone — the grade owns it. */
const PROFILES: Record<GraphicsPreset, Partial<PostFxFlags>> = {
  performance: {
    bloom: true, motionBlur: false, dof: false, ssao: false, godRays: false,
    chromatic: false, grain: false, vignette: true, grade: true, fxaa: true, taa: false, speedLines: true,
  },
  balanced: {
    bloom: true, motionBlur: true, dof: false, ssao: true, godRays: true,
    chromatic: true, grain: true, vignette: true, grade: true, fxaa: true, taa: false, speedLines: true,
  },
  beautiful: {
    bloom: true, motionBlur: true, dof: true, ssao: true, godRays: true,
    chromatic: true, grain: true, vignette: true, grade: true, fxaa: true, taa: true, speedLines: true,
  },
};

/** Structural views of the services this module pokes. All fields optional. */
interface AudioLike {
  setMuted?(muted: boolean): void;
  muted?: boolean;
}
interface PostFxLike {
  set?(flags: Partial<PostFxFlags>): void;
}
interface AiLike {
  difficulty?: string;
  presets?: readonly string[];
}
interface CameraLike {
  mode?: string;
  setMode?(mode: string, opts?: { snap?: boolean }): void;
}

export function loadSettings(): KartSettings {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<KartSettings>;
    return {
      graphics: parsed.graphics ?? DEFAULTS.graphics,
      muted: parsed.muted ?? DEFAULTS.muted,
      difficulty: parsed.difficulty ?? DEFAULTS.difficulty,
      camera: parsed.camera ?? DEFAULTS.camera,
    };
  } catch {
    // Private browsing, a corrupt blob, a schema from an older build: the
    // defaults are always a valid game.
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: KartSettings): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* not being able to remember the mute state is not worth an error */
  }
}

/** Push the whole set at the live services. Safe to call every time it changes. */
export function applySettings(ctx: KartCtx, settings: KartSettings): void {
  const audio = ctx.services.audio as AudioLike | undefined;
  if (audio?.setMuted && audio.muted !== settings.muted) audio.setMuted(settings.muted);

  const postfx = ctx.services.postfx as PostFxLike | undefined;
  postfx?.set?.(PROFILES[settings.graphics] ?? PROFILES.balanced);

  const ai = ctx.services.ai as AiLike | undefined;
  if (ai && typeof ai.difficulty === "string" && ai.difficulty !== settings.difficulty) {
    ai.difficulty = settings.difficulty;
  }

  const camera = ctx.services.camera as CameraLike | undefined;
  // Only follow the preference while actually chasing someone: overriding a
  // scenic or results camera from a settings write would fight the race.
  if (camera?.setMode && (camera.mode === "chase" || camera.mode === "chaseFar" || camera.mode === "hood")) {
    if (camera.mode !== settings.camera) camera.setMode(settings.camera);
  }
}
