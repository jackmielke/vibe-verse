/**
 * physics/index.ts — one import and two calls.
 *
 * The composition root should not have to know that there are eight modules in
 * here, in what order they boot, or which of them need the fixed step rather
 * than the render frame. It calls `initSfPhysics()` once and `updateSfPhysics()`
 * once per frame, and everything below stays an implementation detail.
 *
 *   await initSfPhysics();                       // in an effect, fire-and-forget
 *   updateSfPhysics(dt, cam.x, cam.y, cam.z);    // top of useFrame
 *   disposeSfPhysics();                          // on unmount
 *
 * Ordering inside `updateSfPhysics` is deliberate:
 *   1. stream colliders  — the ground must exist before anything steps onto it;
 *   2. step the world    — fixed substeps, with vehicles/ragdolls hooked in;
 *   3. maintain pools    — expire, cull, sleep, using the post-step state;
 *   4. drain AI queries  — cheapest last, on whatever budget is left.
 */
import type { QualityTier } from "../config";
import { frame } from "../state/store";
import { destruction } from "./destruction";
import { losPool } from "./raycast";
import { ragdolls } from "./ragdoll";
import { rigidBodyPool } from "./rigidBodies";
import {
  disposeTerrainColliders,
  ensureWaterSensor,
  terrainCollider,
} from "./terrainCollider";
import { vehicleSystem } from "./vehiclePhysics";
import { disposePhysics, initPhysics, isPhysicsReady, onFixedStep, physics } from "./world";

export * from "./world";
export * from "./terrainCollider";
export * from "./characterController";
export * from "./raycast";
export * from "./rigidBodies";
export * from "./destruction";
export * from "./ragdoll";
export * from "./vehiclePhysics";

let ragdollHook: (() => void) | null = null;

export interface SfPhysicsOptions {
  quality?: QualityTier;
  /** Create the bay sensor slab. Default true. */
  water?: boolean;
}

/**
 * Boot Rapier and wire the fixed-step consumers.
 *
 * Safe to call more than once; safe to ignore the promise. Until it resolves
 * every query in this directory answers "nothing", which is the correct answer
 * for a world that does not exist yet.
 */
export async function initSfPhysics(opts: SfPhysicsOptions = {}): Promise<boolean> {
  await initPhysics();
  if (!isPhysicsReady()) return false;

  if (opts.quality) setPhysicsQuality(opts.quality);
  if (opts.water !== false) ensureWaterSensor();

  // Ragdoll joint limits are forces; they belong in the fixed step, not the
  // render frame, or a 144 Hz monitor gets stiffer shoulders than a 60 Hz one.
  if (!ragdollHook) ragdollHook = onFixedStep((dt) => ragdolls.update(dt));

  return true;
}

/** Propagate a quality change to every budgeted subsystem. */
export function setPhysicsQuality(tier: QualityTier): void {
  rigidBodyPool.setQuality(tier);
  ragdolls.setQuality(tier);
  destruction.setQuality(tier);
}

/**
 * One frame of physics.
 *
 * `dt` is real seconds; the world converts it into whole 1/60 s substeps and
 * exposes `physics.alpha` for renderers to interpolate with. The (cam*)
 * position is the streaming and culling centre — pass the player's position,
 * or the camera's in photo mode.
 *
 * Pausing is read from `frame.paused` rather than being a second flag to
 * remember: photo mode and the pause menu already set it, and two sources of
 * truth for "is the world frozen" is how you get a ragdoll that keeps sliding
 * behind a paused screen.
 */
export function updateSfPhysics(
  dt: number,
  camX: number,
  camY: number,
  camZ: number,
  budgetMs?: number,
): void {
  if (!isPhysicsReady()) return;
  physics.paused = frame.paused;
  if (physics.paused) return;

  terrainCollider.update(camX, camZ, budgetMs);
  physics.step(dt);
  rigidBodyPool.update(dt, camX, camY, camZ);
  destruction.update(dt);
  losPool.update();
}

/** Tear everything down. */
export function disposeSfPhysics(): void {
  if (ragdollHook) {
    ragdollHook();
    ragdollHook = null;
  }
  vehicleSystem.dispose();
  ragdolls.clear();
  destruction.clear();
  rigidBodyPool.dispose();
  disposeTerrainColliders();
  losPool.clear();
  disposePhysics();
}

/** Aggregated counters for the debug overlay. */
export function physicsStats() {
  return {
    world: physics.stats,
    terrain: terrainCollider.stats,
    bodies: rigidBodyPool.stats,
    ragdolls: ragdolls.stats,
    destruction: destruction.stats,
    vehicles: vehicleSystem.stats,
    losRays: losPool.raysLastFrame,
    alpha: physics.alpha,
    simTime: physics.simTime,
  };
}
