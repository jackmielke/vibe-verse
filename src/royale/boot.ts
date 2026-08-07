/**
 * DROP ZERO — boot sequence.
 *
 * Systems come up in dependency order. Anything that publishes a service
 * must boot before its consumers:
 *
 *   materials ──▶ (every textured surface in the world)
 *   sky ──────▶ (lighting for everything)
 *   collision ─▶ player, weapons, building, bots
 *   terrain ──▶ water, pois, props, vegetation, loot, player, bots
 *   pois ─────▶ loot (chests spawn per-POI), bots (drop targets)
 *   vfx + audio + combat ──▶ weapons, building, bots, storm
 *   inventory ─▶ building, weapons, HUD
 *   postfx boots last: it wraps the finished scene.
 *
 * A subsystem that throws must not take the world down with it. Losing audio
 * or post-processing should cost you those features, not the game.
 */
import { Engine, type EngineOptions } from "./engine/core";
import createInput from "./engine/input";
import createSky from "./engine/sky";
import createPostFx from "./engine/postfx";
import createMaterials from "./world/materials";
import createCollision from "./world/collision";
import createTerrain from "./world/terrain";
import createWater from "./world/water";
import createPois from "./world/pois";
import createProps from "./world/props";
import createVegetation from "./world/vegetation";
import createVfx from "./fx/vfx";
import createCombat from "./fx/combat";
import createAudio from "./audio/audio";
import createInventory from "./play/inventory";
import createPlayer from "./play/player";
import createBuilding from "./play/building";
import createWeapons from "./play/weapons";
import createLoot from "./play/loot";
import createStorm from "./play/storm";
import createMatch from "./play/match";
import createBots from "./play/bots";
import createNetSystem from "./net/net";
import createWetness from "./play/wetness";
import createGhostsSystem from "./net/ghosts";

export interface BootResult {
  engine: Engine;
}

export type BootProgress = (stage: string, fraction: number) => void;

/** Ordered boot list. The single source of truth for load order. */
const STAGES = [
  { label: "Calibrating optics", factory: createInput },
  { label: "Opening the channel", factory: createNetSystem },
  { label: "Weaving materials", factory: createMaterials },
  { label: "Raising the sun", factory: createSky },
  { label: "Setting the bounds", factory: createCollision },
  { label: "Sculpting the island", factory: createTerrain },
  { label: "Flooding the coast", factory: createWater },
  { label: "Building the districts", factory: createPois },
  { label: "Scattering the props", factory: createProps },
  { label: "Planting the treeline", factory: createVegetation },
  { label: "Filling the puddles", factory: createWetness },
  { label: "Loading effects", factory: createVfx },
  { label: "Arming combat", factory: createCombat },
  { label: "Mixing audio", factory: createAudio },
  { label: "Issuing loadout", factory: createInventory },
  { label: "Boarding the bus", factory: createPlayer },
  { label: "Dressing the rivals", factory: createGhostsSystem },
  { label: "Pouring concrete", factory: createBuilding },
  { label: "Racking the guns", factory: createWeapons },
  { label: "Seeding the chests", factory: createLoot },
  { label: "Charging the storm", factory: createStorm },
  { label: "Counting the drop", factory: createMatch },
  { label: "Deploying rivals", factory: createBots },
  { label: "Grading the image", factory: createPostFx },
] as const;

export async function boot(opts: EngineOptions, onProgress?: BootProgress): Promise<BootResult> {
  const engine = new Engine(opts);

  // Post-processing publishes its composer's render function here rather than
  // reaching into the engine, so it stays a plain System like everything
  // else. Passing null hands rendering back to the forward path.
  engine.on("dz:postfx", (fn) => {
    engine.renderOverride = typeof fn === "function" ? (fn as (dt: number) => void) : null;
  });

  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i];
    onProgress?.(stage.label, i / STAGES.length);
    try {
      await engine.add(stage.factory);
    } catch (err) {
      console.error(`[Drop Zero] system "${stage.label}" failed to boot:`, err);
    }
    // Yield to the browser so the loading screen can actually paint.
    await new Promise((r) => setTimeout(r, 0));
  }
  onProgress?.("Ready", 1);

  return { engine };
}
