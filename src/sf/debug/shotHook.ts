/**
 * The bridge between the running game and the offline screenshot harness
 * (`scripts/sf-shot.mjs`).
 *
 * The harness needs three things and nothing more: a way to force a specific
 * camera pose and time of day, a signal that the frame is actually finished
 * (streaming resolved, TAA converged) rather than merely mounted, and the
 * render stats so a critic can tell "it looks better" apart from "it looks
 * better because it now runs at 4 fps".
 */
import * as THREE from "three";

export interface ShotRequest {
  key: string;
  pos: THREE.Vector3;
  look: THREE.Vector3;
  tod: number;
  fog: number;
  fov: number;
  hud: boolean;
  action: string;
  quality: string;
}

export interface ShotStats {
  fps: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  textures: number;
  geometries: number;
}

export interface SfDebugHook {
  /** Flipped true once a fully populated frame has been presented. */
  ready: boolean;
  /** Live render stats, refreshed once a second. */
  stats: ShotStats | null;
  /** The shot the level was asked to reproduce, if any. */
  request: ShotRequest | null;
  /** Frames rendered since the shot pose was applied. */
  framesSincePose: number;
  /** Streaming chunks still outstanding. */
  pendingChunks: number;
  /** Force a new camera pose at runtime (used by the critic loop). */
  setPose?: (pos: [number, number, number], look: [number, number, number], fov?: number) => void;
  /** Force time of day / fog at runtime. */
  setWeather?: (tod: number, fog: number) => void;
}

declare global {
  interface Window {
    __sf?: SfDebugHook;
  }
}

/** Parse a shot request out of the page URL, if the harness set one. */
export function readShotRequest(search: string): ShotRequest | null {
  const p = new URLSearchParams(search);
  const key = p.get("shot");
  if (!key) return null;
  // The harness passes the pose indirectly by shot key; the level owns the
  // table so poses stay in sync with the world when geometry moves.
  return {
    key,
    pos: new THREE.Vector3(),
    look: new THREE.Vector3(),
    tod: Number(p.get("tod") ?? 17),
    fog: Number(p.get("fog") ?? 0.35),
    fov: Number(p.get("fov") ?? 60),
    hud: p.get("hud") === "true",
    action: p.get("action") ?? "",
    quality: p.get("quality") ?? "high",
  };
}

/**
 * The camera poses the harness knows about. Mirrors `SHOTS` in sf-shot.mjs.
 *
 * `agl` means the Y values are metres ABOVE GROUND rather than above sea
 * level, and it matters: San Francisco's terrain is nowhere near sea level
 * once you are a block inland. Market Street's ground sits about 10 m up, so
 * an absolute "eye height" of 3.2 m puts the camera underground, staring out
 * through the bay from inside a hill. Street-level shots are therefore always
 * ground-relative; only the genuinely airborne and over-water poses are
 * absolute.
 */
export interface ShotPose {
  pos: [number, number, number];
  look: [number, number, number];
  agl?: boolean;
}

export const SHOT_POSES: Record<string, ShotPose> = {
  skyline: { pos: [-620, 236, -1290], look: [220, 70, 340] },
  "golden-gate": { pos: [-6200, 180, -2500], look: [-6800, 120, -2920] },
  "market-street": { pos: [40, 3.2, 30], look: [-600, 30, -420] , agl: true },
  "transamerica-base": { pos: [-60, 2.0, -120], look: [-120, 240, -180] , agl: true },
  wingsuit: { pos: [-3900, 320, 4100], look: [-1200, 40, 900] },
  "night-fidi": { pos: [220, 46, 260], look: [-200, 160, -300] },
  "painted-ladies": { pos: [-2980, 24, 2110], look: [-400, 120, -200] , agl: true },
  "bay-water": { pos: [-1400, 4, -2600], look: [-1900, 40, -3680] },
  "chinatown-alley": { pos: [-330, 3.0, 240], look: [-420, 14, -320] , agl: true },
  combat: { pos: [-500, 8, -220], look: [-80, 12, -60] , agl: true },
  hud: { pos: [-1500, 210, -1200], look: [200, 60, 200] },
  "fog-roll": { pos: [-2400, 240, -400], look: [-5200, 180, -2200] },
};

/**
 * Resolve a pose into absolute world metres, lifting `agl` poses onto the
 * terrain. `groundAt` is injected rather than imported so this module stays
 * free of a dependency on the geo layer (and so tests can feed a flat world).
 */
export function resolvePose(
  pose: ShotPose,
  groundAt: (x: number, z: number) => number,
): { pos: [number, number, number]; look: [number, number, number] } {
  if (!pose.agl) return { pos: pose.pos, look: pose.look };
  const [px, py, pz] = pose.pos;
  const [lx, ly, lz] = pose.look;
  return {
    pos: [px, groundAt(px, pz) + py, pz],
    look: [lx, groundAt(lx, lz) + ly, lz],
  };
}

const hook: SfDebugHook = {
  ready: false,
  stats: null,
  request: null,
  framesSincePose: 0,
  pendingChunks: 0,
};

/** Install (idempotently) and return the shared debug hook. */
export function installShotHook(): SfDebugHook {
  if (typeof window === "undefined") return hook;
  if (!window.__sf) window.__sf = hook;
  return window.__sf;
}

export function getShotHook(): SfDebugHook {
  return typeof window !== "undefined" && window.__sf ? window.__sf : hook;
}
