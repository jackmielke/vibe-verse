/**
 * Boot order — the single source of truth for what exists and when.
 *
 * Ordered by dependency rather than importance. Audio comes up first so that
 * anything failing after it still gets to make a noise about it; the fleet has
 * to exist before the game can hand it a mission; the crew has to exist before
 * the game reads its first captain's log; and the camera goes last because it
 * needs a player ship to sit in front of.
 *
 * The other rule: a system that throws must not take the episode down with it.
 * Losing the nebula should cost you the nebula, not the bridge.
 */
import { Engine, type EngineOptions } from "./engine/core";
import { createInput } from "./engine/input";
import { createCamera } from "./engine/camera";
import { createAudio } from "./audio/audio";
import { createSpace } from "./world/space";
import { createFleet } from "./play/fleet";
import { createWeapons } from "./play/weapons";
import { createBridge } from "./bridge/bridge";
import { createCrew } from "./play/crew";
import { createGame } from "./play/game";

export interface BootResult {
  engine: Engine;
}

export type BootProgress = (stage: string, fraction: number) => void;

const STAGES = [
  { label: "Powering up the consoles", factory: createInput },
  { label: "Bringing the intermix online", factory: createAudio },
  { label: "Charting the sector", factory: createSpace },
  { label: "Clearing spacedock", factory: createFleet },
  { label: "Arming the torpedo bays", factory: createWeapons },
  { label: "Rigging the bridge", factory: createBridge },
  { label: "Mustering the crew", factory: createCrew },
  { label: "Receiving orders from Starfleet", factory: createGame },
  { label: "Opening the viewscreen", factory: createCamera },
] as const;

export async function boot(opts: EngineOptions, onProgress?: BootProgress): Promise<BootResult> {
  const engine = new Engine(opts);

  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i];
    onProgress?.(stage.label, i / STAGES.length);
    try {
      await engine.add(stage.factory);
    } catch (err) {
      console.error(`[Final Frontier] system "${stage.label}" failed to boot:`, err);
    }
    // Yield, so the loading screen can actually paint between stages.
    await new Promise((r) => setTimeout(r, 0));
  }

  onProgress?.("Ready", 1);
  return { engine };
}
