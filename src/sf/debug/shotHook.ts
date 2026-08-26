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
  /** Streaming chunks still outstanding (building chunks + impostor tiles). */
  pendingChunks: number;
  /** The same number, split — a queue that will not drain is one or the other. */
  pendingDetail?: number;
  pendingImpostor?: number;
  /** Force a new camera pose at runtime (used by the critic loop). */
  setPose?: (pos: [number, number, number], look: [number, number, number], fov?: number) => void;
  /** Force time of day / fog at runtime. */
  setWeather?: (tod: number, fog: number) => void;
  /** Where the camera actually is, and what its depth range currently is. */
  camPose?: () => CamPose;
  /**
   * Where the *player* is, which is a different question and the one you want
   * when somebody reports that their character is not there. A chase camera
   * five metres behind a character buried inside a landmark's plinth looks
   * exactly like a chase camera behind no character at all.
   */
  player?: () => PlayerPose;
  /**
   * Render one frame synchronously and return it as a data URL, optionally
   * with the depth range perturbed by `depthNudge` (a multiplier, e.g. 1.0002)
   * for that render only.
   *
   * This is the whole basis of `scripts/sf-flicker.mjs`: two renders taken
   * inside one call, a hair apart in depth precision, with nothing else in the
   * world allowed to move between them. See that file for why a frame-to-frame
   * diff cannot answer the same question — and `SanFranciscoGame` for which
   * plane the nudge has to be applied to, which is not the obvious one.
   */
  snapshot?: (depthNudge?: number) => string;
  /**
   * What is actually on screen at a normalised device coordinate.
   *
   * "Something is floating in the sky and I do not know what draws it" is a
   * question a screenshot cannot answer and reading the scene graph answers
   * far too slowly — nine thousand instanced trees all report the same mesh
   * name. This casts a ray through the frame and names the mesh, its material
   * and, for an InstancedMesh, the instance and its world transform, which is
   * the part that identifies *which* of the nine thousand.
   */
  pick?: (ndcX: number, ndcY: number) => PickHit[];
  /**
   * The gameplay state a screenshot cannot show: is the sim paused, is input
   * bound, are we in a car, what does the store think the phase is.
   *
   * "The character will not walk" has half a dozen causes that all look
   * identical from outside — a menu holding `paused`, input never attached,
   * pointer lock refused, a controller that thinks it is seated in a vehicle.
   * Guessing between them from a frame is hopeless.
   */
  state?: () => SfRuntimeState;
  /**
   * Put the player somewhere, facing something.
   *
   * `setPose` moves the *camera*, which is a different thing and useless for
   * testing anything the player's own position drives — you cannot walk up to
   * a car by flying the lens at it. This respawns the capsule, so the physics
   * controller, the camera rig and the avatar all agree afterwards.
   */
  teleport?: (x: number, y: number, z: number, yaw?: number) => void;
  /** The closest simulated vehicle, for tests that need to reach one. */
  nearestVehicle?: () => NearestVehicle | null;
  /** The closest pedestrian. A crowd of twelve spread over a 200 m radius is
   *  nearly impossible to point a camera at by hand. */
  nearestPedestrian?: () => NearestPedestrian | null;
}

export interface NearestPedestrian {
  entityId: number;
  x: number;
  y: number;
  z: number;
  distance: number;
  alive: boolean;
}

export interface NearestVehicle {
  id: number;
  kind: string;
  x: number;
  y: number;
  z: number;
  /** Metres from the player. */
  distance: number;
}

export interface SfRuntimeState {
  paused: boolean;
  phase: string;
  /** True once the input layer has bound its listeners to the canvas. */
  inputEnabled: boolean;
  /** Vehicle the player is seated in, or null on foot. */
  vehicleId: number | null;
  grounded: boolean;
  speed: number;
  /** Live move axes, so "the key never arrived" is distinguishable from
   *  "the key arrived and the controller ignored it". */
  moveX: number;
  moveZ: number;
  health: number;
  /** False means every physics query is answering "nothing hit". */
  physicsReady: boolean;
  /** Advances once per stepped frame. Frozen means nobody is driving it. */
  stepCount: number;
  /** Live crowd and traffic populations near the player. */
  pedestrians: number;
  traffic: number;
  /** Simulated vehicles — parked, drivable and hero rigs. */
  vehicles: number;
  /** Lifetime spawns. Zero means the spawner never fired, which is a
   *  different bug from spawning and immediately culling. */
  vehiclesSpawned: number;
  /** Waiting on Rapier to accept a body. Should drain to 0. */
  vehiclesPending: number;
  /** True while the camera is out on the boom. */
  thirdPerson: boolean;
  /** Live render tier. Drops on its own if the frame rate will not hold. */
  quality: string;
}

export interface PickHit {
  /** Distance from the camera, metres. */
  distance: number;
  /** `Object3D.name`, or the geometry's uuid tail when nothing named it. */
  object: string;
  material: string;
  /** Instance index when the hit object is an InstancedMesh. */
  instanceId?: number;
  /** World-space hit point. */
  point: [number, number, number];
  /** World-space scale of the hit instance — a "Lego" is a big flat one. */
  scale?: [number, number, number];
  /** World-space centre of the hit instance. */
  origin?: [number, number, number];
}

export interface PlayerPose {
  x: number;
  y: number;
  z: number;
  grounded: boolean;
  /** Height of the surface the controller believes is under the feet. */
  support: number;
  /** Seconds left of the post-spawn window in which the feet may still climb. */
  settling: number;
  /** True once the character rig has loaded and been parented. */
  rig: boolean;
  /** Landmark colliders registered within 40 m of the feet. */
  colliders: number;
  /** Fitted height of the character rig, metres. Should be PLAYER.height. */
  rigHeight: number;
}

export interface CamPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  near: number;
  far: number;
  fov: number;
  /** True when three actually granted a logarithmic depth buffer. */
  logDepth: boolean;
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
