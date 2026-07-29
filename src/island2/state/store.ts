/**
 * State for VIBE ISLAND II.
 *
 * Same split that works in San Francisco: `frame` is a plain mutable object
 * carrying everything that changes at 60 Hz and is never allowed near React,
 * and `useIslandStore` carries only what the UI actually re-renders for.
 */
import * as THREE from "three";
import { create } from "zustand";
import { PLAYER, QUALITY, WORLD_SEED, detectQualityTier, type QualityTier } from "../config";
import { makeRng, type Rng } from "@/shared/proc/rng";
import { WORLD } from "../geo/islandGeo";

export type MovementState =
  | "grounded"
  | "airborne"
  | "gliding"
  | "zipline"
  | "swimming"
  | "resting"
  | "falling";

export interface FrameState {
  time: number;
  dt: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  yaw: number;
  pitch: number;
  /** Bank angle — the glider leans into turns. */
  roll: number;
  forward: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  movement: MovementState;
  grounded: boolean;
  groundNormal: THREE.Vector3;
  /** Height above whatever is directly below, or a large number over open sky. */
  altitudeAGL: number;
  /** True when there is no island under the player at all. */
  overVoid: boolean;
  speed: number;
  fov: number;
  /** 0..24. The island's default is a held golden hour. */
  timeOfDay: number;
  /** Wind, which drives foliage, cloth, particles and the glider. */
  windDirection: THREE.Vector2;
  windSpeed: number;
  /** 0..1 haze in the sky sea. */
  haze: number;
  paused: boolean;
}

export const frame: FrameState = {
  time: 0,
  dt: 1 / 60,
  position: new THREE.Vector3(0, 30, 34),
  velocity: new THREE.Vector3(),
  yaw: Math.PI,
  pitch: 0,
  roll: 0,
  forward: new THREE.Vector3(0, 0, -1),
  right: new THREE.Vector3(1, 0, 0),
  up: new THREE.Vector3(0, 1, 0),
  movement: "airborne",
  grounded: false,
  groundNormal: new THREE.Vector3(0, 1, 0),
  altitudeAGL: 0,
  overVoid: false,
  speed: 0,
  fov: PLAYER.fov,
  timeOfDay: WORLD.defaultTimeOfDay,
  windDirection: new THREE.Vector2(0.78, 0.63),
  windSpeed: 5.4,
  haze: 0.42,
  paused: false,
};

export function resetFrame(x: number, y: number, z: number, heading: number): void {
  frame.position.set(x, y, z);
  frame.velocity.set(0, 0, 0);
  frame.yaw = heading;
  frame.pitch = 0;
  frame.roll = 0;
  frame.movement = "airborne";
  frame.grounded = false;
  frame.overVoid = false;
  frame.speed = 0;
  frame.fov = PLAYER.fov;
}

/** The world's master RNG. Every generator forks from this. */
export const worldRng: Rng = makeRng(WORLD_SEED);

/* ------------------------------------------------------------------ *
 * UI state
 * ------------------------------------------------------------------ */

export type GamePhase = "loading" | "playing" | "paused" | "photo";

export interface Discovery {
  key: string;
  name: string;
  blurb: string;
  at: number;
}

export interface IslandState {
  phase: GamePhase;
  loadProgress: number;
  loadLabel: string;

  quality: QualityTier;
  settings: (typeof QUALITY)[QualityTier];

  /** Landmarks the player has physically reached. */
  discovered: string[];
  /** The most recent discovery, for the toast. */
  lastDiscovery: Discovery | null;

  /** Shells and other collectibles, because the original had them. */
  shells: number;

  showHud: boolean;
  showMap: boolean;
  fps: number;
  drawCalls: number;
  triangles: number;

  setPhase: (p: GamePhase) => void;
  setLoad: (progress: number, label?: string) => void;
  setQuality: (q: QualityTier) => void;
  discover: (d: Discovery) => void;
  clearDiscovery: () => void;
  collectShell: () => void;
  toggleHud: () => void;
  toggleMap: () => void;
  setStats: (fps: number, drawCalls: number, triangles: number) => void;
}

const initialTier = detectQualityTier();

export const useIslandStore = create<IslandState>((set, get) => ({
  phase: "loading",
  loadProgress: 0,
  loadLabel: "Finding the island",

  quality: initialTier,
  settings: QUALITY[initialTier],

  discovered: [],
  lastDiscovery: null,
  shells: 0,

  showHud: true,
  showMap: false,
  fps: 0,
  drawCalls: 0,
  triangles: 0,

  setPhase: (phase) => set({ phase }),
  setLoad: (loadProgress, loadLabel) =>
    set((s) => ({ loadProgress, loadLabel: loadLabel ?? s.loadLabel })),
  setQuality: (quality) => set({ quality, settings: QUALITY[quality] }),

  discover: (d) => {
    if (get().discovered.includes(d.key)) return;
    set((s) => ({ discovered: [...s.discovered, d.key], lastDiscovery: d }));
  },
  clearDiscovery: () => set({ lastDiscovery: null }),
  collectShell: () => set((s) => ({ shells: s.shells + 1 })),

  toggleHud: () => set((s) => ({ showHud: !s.showHud })),
  toggleMap: () => set((s) => ({ showMap: !s.showMap })),
  setStats: (fps, drawCalls, triangles) => set({ fps, drawCalls, triangles }),
}));

/** Non-reactive read, for the frame loop. */
export const island = () => useIslandStore.getState();
