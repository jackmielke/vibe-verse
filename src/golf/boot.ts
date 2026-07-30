/**
 * Vibe Golf — boot sequence.
 *
 * Order matters: physics before course (the course hands its hole to the
 * broadphase), rules before aim, render last so it can dress a loaded hole.
 */
import { GolfEngine, type GolfEngineOptions } from "./engine/core";
import createGolfInput, { type GolfInputSystem } from "./engine/input";
import createPhysics from "./engine/physics";
import createCourse from "./course/course";
import createRules from "./play/rules";
import createAim from "./play/aim";
import createPowerups from "./play/powerups";
import createJetpack from "./play/jetpack";
import createHazards from "./course/hazards";
import createPortals from "./course/portals";
import createCharacter from "./play/character";
import createVfx from "./fx/vfx";
import createAudio from "./fx/audio";
import createCamera, { type GolfCameraSystem } from "./engine/camera";
import createRender from "./engine/render";
import createPostFx from "./engine/postfx";
import createProgression from "./play/progression";

export interface GolfBootResult {
  engine: GolfEngine;
}

export type GolfBootProgress = (stage: string, fraction: number) => void;

const STAGES = [
  { label: "Reading the greens", factory: createGolfInput },
  { label: "Winding the clockwork", factory: createPhysics },
  { label: "Mowing the fairway", factory: createCourse },
  { label: "Chalking the scorecard", factory: createRules },
  { label: "Waxing the clubface", factory: createAim },
  { label: "Loading the ball bag", factory: createPowerups },
  { label: "Fuelling the jetpack", factory: createJetpack },
  { label: "Filling the water", factory: createHazards },
  { label: "Aligning the portals", factory: createPortals },
  { label: "Stretching", factory: createCharacter },
  { label: "Sparking effects", factory: createVfx },
  { label: "Tuning audio", factory: createAudio },
  { label: "Setting the camera", factory: createCamera },
  { label: "Dressing the course", factory: createRender },
  { label: "Grading the image", factory: createPostFx },
  { label: "Opening the clubhouse", factory: createProgression },
] as const;

export async function bootGolf(
  opts: GolfEngineOptions,
  onProgress?: GolfBootProgress,
): Promise<GolfBootResult> {
  const engine = new GolfEngine(opts);

  engine.on("golf:postfx", (fn) => {
    engine.renderOverride = typeof fn === "function" ? (fn as (dt: number) => void) : null;
  });

  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i];
    onProgress?.(stage.label, i / STAGES.length);
    try {
      const sys = await engine.add(stage.factory);
      // Two systems need the engine itself (camera framing, pointer unproject)
      // rather than just the context.
      const maybe = sys as Partial<GolfInputSystem & GolfCameraSystem>;
      maybe.attachEngine?.(engine);
    } catch (err) {
      // One broken subsystem costs that feature, never the whole game.
      console.error(`[Vibe Golf] system "${stage.label}" failed to boot:`, err);
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  onProgress?.("Ready", 1);
  return { engine };
}
