import * as THREE from "three";

export type Mode = "walking" | "driving";

export interface InputState {
  forward: number;
  strafe: number;
  yaw: number;
  pitch: number;
  run: boolean;
  jump: boolean;
  enterExit: boolean;
  toggleMute: boolean;
  toggleDayNight: boolean;
}

export interface AABB {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface CollisionWorld {
  boxes: AABB[];
  resolve: (px: number, pz: number, radius: number) => { x: number; z: number; hit: boolean };
}

export interface WorldHandles {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  collision: CollisionWorld;
}

export interface HudState {
  mode: Mode;
  speedKph: number;
  heading: number;
  timeOfDay: number;
  muted: boolean;
  hint: string | null;
}
