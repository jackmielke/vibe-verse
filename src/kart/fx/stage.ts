/**
 * Vibe Kart — the VFX stage.
 *
 * The bag of batches every effect writes into, plus the frame's emission
 * budget. Emitters and bursts take a stage rather than the system so that
 * neither of them can reach the scene graph, the services or the clock: an
 * effect is a pure function from game state to particles, and keeping it that
 * way is what makes the whole layer testable and re-orderable.
 *
 * `budget` is the safety valve. A twelve-kart pile-up on a boost pad can ask
 * for more particles in one frame than the ring buffers hold, which would
 * silently evict the sparks that were emitted a millisecond earlier. Spending
 * from a shared per-frame allowance instead means the pile-up degrades to
 * "slightly thinner" rather than "everything else disappeared".
 */
import type * as THREE from "three";
import type { KartQuality, Rng } from "../types";
import type { ParticleBatch } from "./pool";
import type { RibbonPool } from "./ribbons";
import type { RingPool } from "./rings";

export interface FxStage {
  /** Light-emitting particles: sparks, flame, sparkle, energy. */
  additive: ParticleBatch;
  /** Light-occluding particles: smoke, dust, debris, confetti. */
  alpha: ParticleBatch;
  /** Ground-aligned expanding rings that emit light — shockwaves, ripples. */
  rings: RingPool;
  /** Ground-aligned rings that occlude it — landing dust, scorch marks. */
  dustRings: RingPool;
  /** Rubber on the road. */
  skid: RibbonPool;
  /** Star-power shimmer. */
  star: RibbonPool;
  rng: Rng;
  quality: KartQuality;
  /** Global density multiplier, 0.35 (low) .. 1.25 (ultra). */
  density: number;
  camera: THREE.PerspectiveCamera;
  elapsed: number;
  /** Particles this frame may still emit. Decremented by `spend`. */
  budget: number;
}

/**
 * Claim up to `want` particles from the frame allowance. Callers must use the
 * returned count, not the one they asked for.
 */
export function spend(stage: FxStage, want: number): number {
  if (want <= 0) return 0;
  const got = want < stage.budget ? want : Math.max(0, stage.budget);
  stage.budget -= got;
  return got | 0;
}

/** Symmetric random in [-1, 1). */
export function sym(rng: Rng): number {
  return rng() * 2 - 1;
}

/** Random in [a, b). */
export function between(rng: Rng, a: number, b: number): number {
  return a + (b - a) * rng();
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
