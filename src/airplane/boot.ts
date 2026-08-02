/**
 * Boot order — the single source of truth for what exists and when.
 *
 * Ordered by dependency, not importance. The sky owns the lighting uniforms
 * every other material in the world shares, so it is first; the ground owns
 * the height field the flight model probes, so it comes before the aeroplane;
 * the camera needs something to be attached to, so it is last.
 *
 * The other rule: **a system that throws must not take the flight down with
 * it.** Losing the audio should cost you the audio. Losing the cabin should
 * cost you the jokes. Neither should cost you the aeroplane.
 */
import { Engine, type EngineOptions } from "./engine/core";
import { createInput } from "./engine/input";
import { createCamera } from "./engine/camera";
import { createSky } from "./world/sky";
import { createGround } from "./world/ground";
import { createAirport } from "./world/airport";
import { createWeather } from "./world/weather";
import { createAircraft } from "./play/aircraft";
import { createAirliner } from "./entities/airliner";
import { createCockpit } from "./cockpit/deck";
import { createCabin } from "./play/cabin";
import { createGame } from "./play/game";
import { createAudio } from "./audio/audio";

export interface BootResult {
  engine: Engine;
}

export type BootProgress = (stage: string, fraction: number) => void;

/**
 * The loading messages are the film's, because the loading screen is the first
 * thing anybody sees and there is no reason for it to be "Loading 43%".
 */
const STAGES = [
  { label: "Checking in the passengers", factory: createInput },
  { label: "Rolling in the weather", factory: createSky },
  { label: "Switching on Chicago", factory: createGround },
  { label: "Lighting runway two-seven left", factory: createAirport },
  { label: "Starting the rain", factory: createWeather },
  { label: "Pushing back from the gate", factory: createAircraft },
  { label: "Painting the cheatline", factory: createAirliner },
  { label: "Building the flight deck", factory: createCockpit },
  { label: "Serving the fish", factory: createCabin },
  { label: "Briefing the cabin crew", factory: createGame },
  { label: "Tuning the tower", factory: createAudio },
  { label: "Taking your seat", factory: createCamera },
] as const;

export async function boot(opts: EngineOptions, onProgress?: BootProgress): Promise<BootResult> {
  const engine = new Engine(opts);

  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i];
    onProgress?.(stage.label, i / STAGES.length);
    try {
      await engine.add(stage.factory);
    } catch (err) {
      console.error(`[Flight 209] system "${stage.label}" failed to boot:`, err);
    }
    // Yield, so the loading screen can actually paint between stages.
    await new Promise((r) => setTimeout(r, 0));
  }

  onProgress?.("Ready", 1);
  return { engine };
}
