import type * as THREE from "three";
import type { Colliders } from "./colliders";

/** A walkable surface that is not the terrain: a dock, a bridge, a stair. Null where it is not. */
export type SurfaceFn = (x: number, z: number) => number | null;

export interface Quality {
  /** "vr" and "phone" get less of everything that is optional. */
  tier: "desktop" | "phone" | "vr";
}

export interface BuildCtx {
  colliders: Colliders;
  surfaces: SurfaceFn[];
  quality: Quality;
}

export interface FrameCtx {
  player: THREE.Vector3;
  camera: THREE.Camera;
  sunDir: THREE.Vector3;
}

export interface Part {
  group: THREE.Object3D;
  update?(dt: number, time: number, ctx: FrameCtx): void;
  dispose(): void;
}
