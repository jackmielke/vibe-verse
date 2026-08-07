/**
 * Vibe Kart — boot sequence.
 *
 * Order matters. Materials and the environment come first because every mesh
 * built afterwards asks them for a texture or an envMap; the track publishes
 * the geometry the physics projects onto; the camera and post stack come last
 * so they can frame and grade a fully dressed world.
 *
 * A system that throws costs its own feature and nothing else — a broken
 * particle emitter must never take the race with it.
 */
import { KartEngine, type KartEngineOptions } from "./engine/core";

import createInput from "./engine/input";
import createMaterials from "./materials";
import createEnvironment from "./env";
import createTrack from "./track";
import createScenery from "./scenery";
import createModels from "./models";
import createPhysics from "./physics";
import createAi from "./ai";
import createRace from "./play/race";
import createItems from "./play/items";
import createVfx from "./fx";
import createAudio from "./audio";
import createCamera from "./engine/camera";
import createPostFx from "./postfx";
import createMinimap from "./ui/minimap";

export interface KartBootResult {
  engine: KartEngine;
}

export type KartBootProgress = (stage: string, fraction: number) => void;

const STAGES = [
  { label: "Warming the tyres", factory: createInput },
  { label: "Mixing paint", factory: createMaterials },
  { label: "Hanging the sun", factory: createEnvironment },
  { label: "Laying tarmac", factory: createTrack },
  { label: "Filling the grandstands", factory: createScenery },
  { label: "Rolling out the karts", factory: createModels },
  { label: "Bolting on suspension", factory: createPhysics },
  { label: "Briefing the rivals", factory: createAi },
  { label: "Chalking the grid", factory: createRace },
  { label: "Stocking item boxes", factory: createItems },
  { label: "Lighting the sparks", factory: createVfx },
  { label: "Revving the engines", factory: createAudio },
  { label: "Mounting the camera", factory: createCamera },
  { label: "Grading the picture", factory: createPostFx },
  { label: "Printing the map", factory: createMinimap },
] as const;

export async function bootKart(
  opts: KartEngineOptions,
  onProgress?: KartBootProgress,
): Promise<KartBootResult> {
  const engine = new KartEngine(opts);

  engine.on("postfx:override", ((fn: unknown) => {
    engine.renderOverride = typeof fn === "function" ? (fn as (dt: number) => void) : null;
  }) as (p: never) => void);

  // Multiplayer is *not* booted here. It is one extra system that only reads
  // physics and writes remote poses, and the UI bolts it on with `engine.add`
  // the moment a room's race starts — so a session that never opens the
  // multiplayer menu never opens a socket. See `ui/KartUI.tsx`.
  const stages = [...STAGES];

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    onProgress?.(stage.label, i / stages.length);
    try {
      await engine.add(stage.factory);
    } catch (err) {
      console.error(`[Vibe Kart] system "${stage.label}" failed to boot:`, err);
    }
    // Yield so the loading bar actually paints between stages.
    await new Promise((r) => setTimeout(r, 0));
  }

  onProgress?.("Ready", 1);
  return { engine };
}
