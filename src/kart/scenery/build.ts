/**
 * Vibe Kart — the shared build context and the density budget.
 *
 * Each builder in this directory is a pure `(BuildCtx) => SceneryPiece`: it
 * places instances into the field, hangs any hero props off `root`, and hands
 * back an optional per-frame tick. Nothing a builder makes is reachable from
 * another builder — the only shared state is the field, the material set and
 * the uniform bag, all of which are read-only from a builder's point of view.
 *
 * `DENSITY` is the one table that decides how full the world is. It is tuned so
 * that `high` — what the screenshot harness runs — is the full dressing, and
 * `low` still has a crowd, trees and a skyline, because a stripped world reads
 * as a broken world rather than a fast one.
 */
import type * as THREE from "three";
import type { KartCtx, KartQuality } from "../types";
import type { SceneryField } from "./field";
import type { StandSpec } from "./stands";
import type { TrackSampler } from "./layout";
import type { SceneryMaterials } from "./mats";
import type { Resources } from "./util";
import type { SceneryUniforms } from "./wind";

export interface Density {
  /** Spectators actually seated, before per-stand occupancy thinning. */
  crowd: number;
  /** Grandstand bays across the whole circuit. */
  bays: number;
  /** Trees, summed across the three species. */
  trees: number;
  bushes: number;
  /** Grass tufts hugging the road edge. */
  tufts: number;
  /** Advertising hoardings. */
  hoardings: number;
  flags: number;
  /** Radial segments on the far terrain ring. */
  farSegments: number;
  /** Hills and mesas in the middle distance. */
  hills: number;
  balloons: number;
  birds: number;
  /** Foliage and prop shadow casting. */
  shadows: boolean;
  /** View distance multiplier applied to every kind. */
  viewScale: number;
}

export const DENSITY: Record<KartQuality, Density> = {
  low: {
    crowd: 620, bays: 24, trees: 300, bushes: 90, tufts: 0, hoardings: 60,
    flags: 18, farSegments: 48, hills: 22, balloons: 2, birds: 0,
    shadows: false, viewScale: 0.6,
  },
  medium: {
    crowd: 1500, bays: 38, trees: 720, bushes: 220, tufts: 1600, hoardings: 110,
    flags: 32, farSegments: 72, hills: 34, balloons: 3, birds: 24,
    shadows: false, viewScale: 0.8,
  },
  high: {
    crowd: 3600, bays: 58, trees: 1500, bushes: 460, tufts: 5000, hoardings: 180,
    flags: 52, farSegments: 108, hills: 48, balloons: 5, birds: 40,
    shadows: true, viewScale: 1,
  },
  ultra: {
    crowd: 6000, bays: 72, trees: 2400, bushes: 700, tufts: 9000, hoardings: 240,
    flags: 68, farSegments: 144, hills: 60, balloons: 6, birds: 56,
    shadows: true, viewScale: 1.25,
  },
};

/**
 * Written by one builder, read by the next. Kept deliberately small: the only
 * real cross-builder facts are where the stands ended up (so the signage can
 * hang off their front walls) and where the hero landmarks are (so the forest
 * does not grow through the castle).
 */
export interface ScenePlan {
  stands: StandSpec[];
  /** Circles on the ground nothing else may be placed inside. */
  keepOut: Array<{ x: number; z: number; r: number }>;
  /** Lap position of the start/finish line. */
  startT: number;
}

export interface BuildCtx {
  ctx: KartCtx;
  quality: KartQuality;
  density: Density;
  sampler: TrackSampler;
  field: SceneryField;
  mats: SceneryMaterials;
  uniforms: SceneryUniforms;
  res: Resources;
  /** Hero props that are not instanced hang here. */
  root: THREE.Object3D;
  plan: ScenePlan;
  /** Deterministic stream factory — every builder takes a named one. */
  rng(name: string): () => number;
}

export interface SceneryPiece {
  /** Variable-rate tick. Only hero props need one. */
  update?(dt: number, elapsed: number, cameraPosition: THREE.Vector3): void;
  dispose?(): void;
}
