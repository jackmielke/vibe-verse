/**
 * Boot order — the single source of truth for what exists and when.
 *
 * The list is ordered by dependency, not by importance: the sky owns the
 * lighting uniforms every other material reads, the terrain owns the height
 * field the water bakes from and the city stands on, and the fleet needs the
 * terrain to know where the ground is. Everything after that is decoration and
 * can fail without consequence.
 *
 * Which is the other rule here: a system that throws must not take the world
 * down with it. Losing the audio should cost you the audio, not the flight.
 */
import { Engine, type EngineOptions } from "./engine/core";
import { createInput } from "./engine/input";
import { createCamera } from "./engine/camera";
import { createSky } from "./world/sky";
import { createTerrain } from "./world/terrain";
import { createWater } from "./world/water";
import { createCity } from "./world/city";
import { createLife } from "./world/life";
import { createFleet } from "./play/fleet";
import { createEffects } from "./entities/effects";
import { createCourses } from "./play/courses";
import { createGame } from "./play/game";
import { createAudio } from "./audio/audio";

export interface BootResult {
  engine: Engine;
}

export type BootProgress = (stage: string, fraction: number) => void;

const STAGES = [
  { label: "Reading the wind", factory: createInput },
  { label: "Raising the sun over Rainier", factory: createSky },
  { label: "Carving the Sound", factory: createTerrain },
  { label: "Filling the lake", factory: createWater },
  { label: "Building the skyline", factory: createCity },
  { label: "Launching the hydros", factory: createLife },
  { label: "Rolling out the jets", factory: createFleet },
  { label: "Mixing the smoke oil", factory: createEffects },
  { label: "Hanging the hoops", factory: createCourses },
  { label: "Briefing the flight", factory: createGame },
  { label: "Lighting the burners", factory: createAudio },
  { label: "Taking the runway", factory: createCamera },
] as const;

export async function boot(opts: EngineOptions, onProgress?: BootProgress): Promise<BootResult> {
  const engine = new Engine(opts);

  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i];
    onProgress?.(stage.label, i / STAGES.length);
    try {
      await engine.add(stage.factory);
    } catch (err) {
      console.error(`[Blue Angels] system "${stage.label}" failed to boot:`, err);
    }
    // Yield, so the loading screen can actually paint between stages.
    await new Promise((r) => setTimeout(r, 0));
  }

  onProgress?.("Ready", 1);
  return { engine };
}
