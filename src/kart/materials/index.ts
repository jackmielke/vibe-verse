/**
 * Vibe Kart — the material library.
 *
 * Every surface in the game is procedurally generated at boot: no texture
 * downloads, no licensing, no 20 MB of JPEGs. Each entry is a full PBR set
 * (albedo / normal / roughness / AO) baked on a canvas, so the road can have
 * real aggregate, the kerbs real paint wear, and the grass real clumping.
 *
 * Published on `ctx.services.materials`. Consumers must never mutate a shared
 * material — call `clone()` (the library caches the originals).
 *
 * STUB — owned by the materials agent, replaced wholesale during the build.
 * The exported types below are the contract other systems compile against.
 */
import * as THREE from "three";
import type { KartCtx, System } from "../types";

export type MaterialName =
  | "asphalt"
  | "asphaltWorn"
  | "kerb"
  | "roadLine"
  | "startLine"
  | "grass"
  | "dirt"
  | "sand"
  | "water"
  | "ice"
  | "wood"
  | "metal"
  | "grate"
  | "concrete"
  | "brick"
  | "stone"
  | "rubber"
  | "chrome"
  | "carPaint"
  | "glass"
  | "plastic"
  | "foliage"
  | "bark"
  | "cloth"
  | "banner"
  | "neon"
  | "antigrav"
  | "boostPad"
  | "crowd";

export interface MaterialLibrary {
  /** Cached shared material. Clone before mutating. */
  get(name: MaterialName): THREE.Material;
  /** A car-paint material tinted for a racer. */
  carPaint(color: number, accent?: number): THREE.Material;
  /** Cached procedural texture, tiled `repeat` times over a metre. */
  texture(name: MaterialName, repeat?: number): THREE.Texture;
  /** Animated materials (water, neon, anti-gravity) tick here. */
  update(dt: number, elapsed: number): void;
  /** Re-point every PBR material at the scene's prefiltered environment. */
  setEnvMap(env: THREE.Texture | null): void;
  dispose(): void;
}

export default function createMaterials(ctx: KartCtx): System {
  void ctx;
  return {};
}
