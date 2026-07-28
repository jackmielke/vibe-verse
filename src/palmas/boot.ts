/**
 * San Palmas — boot sequence.
 *
 * Systems come up in dependency order. Anything that publishes a service
 * must boot before its consumers:
 *
 *   sky ──▶ (lighting for everything)
 *   terrain ──▶ city, vegetation, landmarks, player, vehicles, ai
 *   city ──▶ collision ──▶ player, weapons, traversal
 *   vfx + audio + combat ──▶ weapons, ai, vehicles
 *   postfx boots last: it wraps the finished scene.
 */
import { Engine, type EngineOptions } from "./engine/core";
import createInput from "./engine/input";
import createSky from "./engine/sky";
import createPostFx from "./engine/postfx";
import createTerrain from "./world/terrain";
import createWater from "./world/water";
import createCity from "./world/city";
import createLandmarks from "./world/landmarks";
import createVegetation from "./world/vegetation";
import createVfx from "./fx/vfx";
import createCombat from "./fx/combat";
import createAudio from "./audio/audio";
import createPlayer from "./play/player";
import createWeapons from "./play/weapons";
import createTraversal from "./play/traversal";
import createVehicles from "./play/vehicles";
import createAi from "./play/ai";

export interface BootResult {
  engine: Engine;
}

export type BootProgress = (stage: string, fraction: number) => void;

/** Ordered boot list. Keep this the single source of truth for load order. */
const STAGES = [
  { label: "Calibrating optics", factory: createInput },
  { label: "Raising the sun", factory: createSky },
  { label: "Sculpting the peninsula", factory: createTerrain },
  { label: "Flooding the bay", factory: createWater },
  { label: "Pouring the streets", factory: createCity },
  { label: "Anchoring the bridge", factory: createLandmarks },
  { label: "Planting the palms", factory: createVegetation },
  { label: "Loading effects", factory: createVfx },
  { label: "Arming combat", factory: createCombat },
  { label: "Mixing audio", factory: createAudio },
  { label: "Dropping in", factory: createPlayer },
  { label: "Issuing hardware", factory: createWeapons },
  { label: "Spooling the grapple", factory: createTraversal },
  { label: "Parking the fleet", factory: createVehicles },
  { label: "Deploying the cartel", factory: createAi },
  { label: "Grading the image", factory: createPostFx },
] as const;

export async function boot(opts: EngineOptions, onProgress?: BootProgress): Promise<BootResult> {
  const engine = new Engine(opts);

  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i];
    onProgress?.(stage.label, i / STAGES.length);
    await engine.add(stage.factory);
    // Yield to the browser so the loading screen can actually paint.
    await new Promise((r) => setTimeout(r, 0));
  }
  onProgress?.("Ready", 1);

  return { engine };
}
