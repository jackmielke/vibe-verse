/**
 * Capture contract for VIBE ISLAND II — the same idea as San Francisco's, and
 * for the same reason: iterating on how a world *looks* is only possible if
 * "the same view" can be re-rendered on demand and compared.
 */
import * as THREE from "three";

export interface IslandShotPose {
  pos: [number, number, number];
  look: [number, number, number];
  /** Y is metres above the surface rather than absolute. */
  agl?: boolean;
  tod: number;
  haze: number;
  fov: number;
  label: string;
}

/** The canonical shot list. Mirrored by scripts/island-shot.mjs. */
export const ISLAND_SHOTS: Record<string, IslandShotPose> = {
  arrival: {
    label: "The Plaza at golden hour — the first thing you ever see",
    pos: [0, 2.0, 96], look: [0, 14, -30], agl: true, tod: 18.35, haze: 0.42, fov: 68,
  },
  "island-from-below": {
    label: "Gliding under the heart island — the keel and the cloud sea",
    pos: [120, -230, 420], look: [0, 20, 0], tod: 18.1, haze: 0.5, fov: 74,
  },
  archipelago: {
    label: "The whole archipelago hanging in the haze",
    pos: [980, 340, 900], look: [-120, 20, -150], tod: 18.4, haze: 0.55, fov: 58,
  },
  "the-spill": {
    label: "The lagoon pouring off the rim into nothing",
    pos: [300, 40, 250], look: [214, -20, 176], tod: 18.2, haze: 0.4, fov: 64,
  },
  "palace-rock": {
    label: "THE PALACE on its own rock, above everything",
    pos: [-120, 210, -220], look: [-300, 130, -420], tod: 18.5, haze: 0.48, fov: 60,
  },
  cove: {
    label: "Down at the lagoon — sand, shallow water, canopy",
    pos: [40, 1.8, -60], look: [180, 8, 60], agl: true, tod: 17.9, haze: 0.35, fov: 70,
  },
  "blue-hour": {
    label: "After the sun goes — lanterns and the cool sky",
    pos: [0, 6, 120], look: [0, 20, -40], agl: true, tod: 20.3, haze: 0.5, fov: 66,
  },
  "sun-behind": {
    label: "Looking away from the sun — the cool half of the sky",
    pos: [-300, 120, 300], look: [400, 40, -400], tod: 18.3, haze: 0.45, fov: 62,
  },
};

export interface IslandShotRequest {
  key: string;
  tod: number;
  haze: number;
  fov: number;
  quality: string;
}

export interface IslandDebugHook {
  ready: boolean;
  stats: { fps: number; drawCalls: number; triangles: number } | null;
  request: IslandShotRequest | null;
  framesSincePose: number;
}

declare global {
  interface Window {
    __island?: IslandDebugHook;
  }
}

export function readIslandShot(search: string): IslandShotRequest | null {
  const p = new URLSearchParams(search);
  const key = p.get("shot");
  if (!key) return null;
  const preset = ISLAND_SHOTS[key];
  return {
    key,
    tod: Number(p.get("tod") ?? preset?.tod ?? 18.35),
    haze: Number(p.get("haze") ?? preset?.haze ?? 0.42),
    fov: Number(p.get("fov") ?? preset?.fov ?? 68),
    quality: p.get("quality") ?? "high",
  };
}

const hook: IslandDebugHook = { ready: false, stats: null, request: null, framesSincePose: 0 };

export function installIslandHook(): IslandDebugHook {
  if (typeof window === "undefined") return hook;
  if (!window.__island) window.__island = hook;
  return window.__island;
}

/** Kept so the module has a THREE dependency for future pose maths. */
export const _v = new THREE.Vector3();
