/**
 * Vibe Kart — the material library.
 *
 * Every surface in the game is procedurally generated at boot: no texture
 * downloads, no licensing, no 20 MB of JPEGs. Each entry is a full PBR set
 * (albedo / normal / packed AO-roughness-metalness) baked on a canvas, so the
 * road can have real aggregate, the kerbs real paint wear, and the grass real
 * clumping.
 *
 * Published on `ctx.services.materials`. Consumers must never mutate a shared
 * material — call `clone()` (the library caches the originals).
 *
 * Layout of this module:
 *   noise.ts    — the periodic noise kit and the raster/texture plumbing
 *   textures.ts — one baker per surface, producing raw channels
 *   library.ts  — channels → shared THREE materials, animation, envMap, dispose
 *
 * The handle is published synchronously, before the bake starts, so systems
 * booted after this one always find it. Anything requested before its turn in
 * the bake queue is generated on demand rather than returning undefined.
 */
import type * as THREE from "three";
import type { KartCtx, System } from "../types";
import { createMaterialLibrary, type MaterialLibrary, type MaterialMaps } from "./library";
import type { MaterialName } from "./textures";

export type { MaterialName, MaterialLibrary, MaterialMaps };
export { createMaterialLibrary };

export default function createMaterials(ctx: KartCtx): System | Promise<System> {
  const lib = createMaterialLibrary({ quality: ctx.quality, renderer: ctx.renderer });

  // Synchronous publish: every system booted after this one asks us for a
  // surface, and none of them should have to know we are still baking.
  ctx.services.materials = lib;

  let appliedEnv: THREE.Texture | null = null;
  const adoptEnv = (env: THREE.Texture | null | undefined) => {
    const next = env ?? null;
    if (next === appliedEnv) return;
    appliedEnv = next;
    lib.setEnvMap(next);
  };

  // Fast path if the environment system announces itself; the poll below is
  // the safety net for an env system that only publishes its service.
  const offEnv = ctx.on("env:ready", ((payload: unknown) => {
    const env = (payload as { envMap?: THREE.Texture } | null)?.envMap;
    adoptEnv(env ?? ctx.services.env?.envMap);
  }) as (p: never) => void);

  const system: System = {
    update(dt) {
      lib.update(dt, ctx.elapsed);
      // One reference compare a frame, and it means a sky that fades between
      // probes (time of day, a tunnel) re-points every PBR material for free.
      adoptEnv(ctx.services.env?.envMap);
    },
    dispose() {
      offEnv();
      lib.dispose();
      if (ctx.services.materials === lib) delete ctx.services.materials;
    },
  };

  // Awaited by the boot sequence, so the loading bar attributes the bake to
  // this stage and the track never asks for tarmac that does not exist yet.
  return lib.bakeAll().then(() => system);
}
