/**
 * The Midnight Zone — boot sequence.
 *
 * Order matters. Input first so the touch overlay exists before anything can
 * ask about it; the ocean before everything else visible, because it owns the
 * fog and the lights that every other material is shaded against; the sub
 * before the camera and the creatures, both of which follow it; post last, so
 * it wraps a scene that is fully dressed.
 *
 * A system that throws costs its own feature and nothing else. That is not
 * politeness — the seafloor and the post stack are the two most likely things
 * to fail on an old GPU, and neither is worth losing the dive over.
 */
import { DeepEngine, type DeepEngineOptions } from "./engine/core";

import createInput from "./engine/input";
import createOcean from "./world/ocean";
import createSub from "./play/sub";
import createSnow from "./world/snow";
import createCreatures from "./life/creatures";
import createFloor from "./world/floor";
import createScan from "./play/scan";
import createCamera from "./engine/camera";
import createSound from "./fx/sound";
import createPostFx from "./engine/postfx";

export interface DeepBootResult {
  engine: DeepEngine;
}

export type DeepBootProgress = (stage: string, fraction: number) => void;

const STAGES = [
  { label: "Sealing the hatch", factory: createInput },
  { label: "Flooding the ballast", factory: createOcean },
  { label: "Lowering the submersible", factory: createSub },
  { label: "Seeding the water column", factory: createSnow },
  { label: "Waking what lives here", factory: createCreatures },
  { label: "Charting the trench", factory: createFloor },
  { label: "Calibrating the survey camera", factory: createScan },
  { label: "Aiming the lamps", factory: createCamera },
  { label: "Dropping the hydrophone", factory: createSound },
  { label: "Grading the picture", factory: createPostFx },
] as const;

export async function bootDeep(
  opts: DeepEngineOptions,
  onProgress?: DeepBootProgress,
): Promise<DeepBootResult> {
  const engine = new DeepEngine(opts);

  engine.on("postfx:override", ((fn: unknown) => {
    engine.renderOverride = typeof fn === "function" ? (fn as (dt: number) => void) : null;
  }) as (p: never) => void);

  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i];
    onProgress?.(stage.label, i / STAGES.length);
    try {
      await engine.add(stage.factory);
    } catch (err) {
      console.error(`[The Deep] system "${stage.label}" failed to boot:`, err);
    }
    // Yield so the loading bar actually paints between stages.
    await new Promise((r) => setTimeout(r, 0));
  }

  onProgress?.("Ready", 1);
  return { engine };
}
