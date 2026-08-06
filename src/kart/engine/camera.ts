/**
 * Vibe Kart — the chase camera.
 *
 * After drift, this is the biggest lever on how the game feels, so the whole
 * rig is built around one idea: **the camera is a physical object on a spring,
 * not a transform assignment.** Every channel — boom distance, boom angle,
 * height, look point, up vector, field of view — is either a critically damped
 * spring or an exponential smoother driven by `dt`. Nothing is a fixed lerp
 * factor, so the feel is identical at 30, 60 and 144 Hz and identical again
 * when the screenshot harness steps the engine by hand.
 *
 * The rig is **polar around the kart**: a boom angle θ (0 = in front of the
 * nose, π = directly behind), a boom length, and a height along the camera's
 * up vector. Expressing it this way means every transition — the race-start
 * sweep, look-back, the drift swing — is an *arc around the kart* rather than a
 * straight line through it. A camera that lerps its position from a front
 * three-quarter to a chase pose flies through the driver's head; one that
 * interpolates θ orbits the kart the way a real camera operator would.
 *
 * The up vector is the other thing worth reading twice. It blends toward the
 * surface normal so banked corners and the anti-gravity plating read as
 * *banked* rather than as the world sliding sideways — but only ~40% of the
 * way, because a camera that matches the road exactly makes people ill. The
 * exception is genuine wall/ceiling driving, where 40% of a 150° roll is an
 * unreadable image; there the blend opens back up to 1 so the anti-gravity
 * tube stays legible. `ROLL_*` below is that curve.
 *
 * Everything is read defensively from `ctx.services`. No physics? The camera
 * falls back to the scenic orbit and the title screen still looks like a game.
 * No track? The collision solver is skipped and nothing throws.
 */
import * as THREE from "three";
import {
  TUNING,
  type CameraService,
  type KartCtx,
  type PhysicsService,
  type RaceService,
  type RacerState,
  type SurfaceSample,
  type System,
  type TrackService,
} from "../types";

// ---------------------------------------------------------------------------
// Local contracts
// ---------------------------------------------------------------------------

export type KartCameraMode = CameraService["mode"];

/**
 * Additive channels the physics module publishes on top of `RacerState`. They
 * are optional here on purpose: this module does not get to edit shared law,
 * and a racer that lacks them still films perfectly well.
 */
interface CamRacer extends RacerState {
  /** Live normalised arc position — a free projection hint for surface probes. */
  t?: number;
  /** Longitudinal g, smoothed. Sells acceleration through boom length. */
  accelG?: number;
  /** True while the kart is being lifted back onto the road. */
  respawning?: boolean;
}

/**
 * The published handle. `CameraService` is the contract; the extras are
 * additive and every consumer is free to ignore them.
 */
export interface KartCameraService extends CameraService {
  /** Racer id currently being filmed. */
  readonly target: number;
  /** Switch mode, optionally cutting instead of flying there. */
  setMode(mode: KartCameraMode, opts?: { snap?: boolean }): void;
  /** Drop a `pose()` hold and resume following. */
  release(): void;
  /** True while `pose()` is holding the camera. */
  readonly held: boolean;
  /** Beauty mark the scenic orbit is currently on. */
  readonly scenicMark: number;
  /** Cut the scenic camera to a specific beauty mark. */
  scenicTo(index: number): void;
  /** Distance-attenuated shake — explosions, thwomps, anything with a place. */
  shakeAt(position: THREE.Vector3, amount: number, radius?: number, duration?: number): void;
  /** Live rig, for anything that wants to aim with the camera (VFX, post). */
  readonly boom: { position: THREE.Vector3; lookAt: THREE.Vector3; up: THREE.Vector3 };
  /** Kick the race-start sweep by hand (the race system normally does this). */
  playIntro(seconds?: number): void;
}

// ---------------------------------------------------------------------------
// Rig table — one place to balance the feel of every mode
// ---------------------------------------------------------------------------

interface Rig {
  /** Boom length in metres at rest. */
  dist: number;
  /** Height above the kart along the camera up vector. */
  height: number;
  /** Look point height above the kart origin. */
  look: number;
  /** How far ahead of the kart the look point leads, at top speed. */
  lead: number;
  /** Field of view at a standstill, degrees. */
  fov: number;
  /** How much the FOV opens up by top speed, degrees. */
  fovSpeed: number;
  /** Spring stiffness of the boom, rad/s. Higher = tighter, less floaty. */
  omega: number;
  /** Exponential rate of the look point, 1/s. */
  lookRate: number;
  /** Exponential rate of the up vector, 1/s. */
  upRate: number;
  /** Fraction of the surface roll the camera adopts on ordinary banking. */
  roll: number;
}

const RIGS: Record<KartCameraMode, Rig> = {
  chase: {
    dist: 6.5, height: 2.52, look: 1.06, lead: 3.4,
    fov: 68, fovSpeed: 15, omega: 8.6, lookRate: 11, upRate: 6, roll: 0.4,
  },
  // The far chase is for heavies and for anyone who wants to see the corner
  // rather than the kart: longer boom, higher, and a *narrower* base FOV so the
  // extra distance does not flatten the track into a postcard.
  chaseFar: {
    dist: 9.6, height: 3.5, look: 1.4, lead: 4.4,
    fov: 64, fovSpeed: 16, omega: 7.0, lookRate: 9, upRate: 5.2, roll: 0.36,
  },
  // Cockpit-ish: sat on the bonnet behind the nose cone. Stiff springs, because
  // a floaty first-person camera is nausea in a bottle.
  hood: {
    dist: 0.36, height: 1.0, look: 0.62, lead: 14,
    fov: 74, fovSpeed: 14, omega: 24, lookRate: 17, upRate: 9, roll: 0.72,
  },
  scenic: {
    dist: 24, height: 6, look: 1.2, lead: 0,
    fov: 55, fovSpeed: 0, omega: 26, lookRate: 20, upRate: 10, roll: 0,
  },
  results: {
    dist: 6.9, height: 2.35, look: 1.05, lead: 0,
    fov: 50, fovSpeed: 0, omega: 13, lookRate: 14, upRate: 8, roll: 0.5,
  },
  free: {
    dist: 6.5, height: 2.4, look: 1.15, lead: 3.2,
    fov: 60, fovSpeed: 0, omega: 20, lookRate: 20, upRate: 12, roll: 0.4,
  },
};

/** Surface roll below this (rad) is banking: adopt `rig.roll` of it. */
const ROLL_BANK = 0.78;
/** Above this the kart is on a wall or a ceiling: adopt all of it, or the
 *  picture is unreadable and the player cannot tell which way is "down". */
const ROLL_WALL = 1.95;

/** Never let the boom collapse closer than this to the kart. */
const MIN_BOOM = 1.75;
/** Clearance the camera keeps above whatever surface is under it. */
const GROUND_CLEAR = 0.85;
/** Clearance above the plane the kart is sitting on (anti-gravity safe). */
const PLANE_CLEAR = 0.55;
/**
 * Clearance the *settled* eye keeps, after the spring has run.
 *
 * Slightly under `GROUND_CLEAR`: the boom solver is what should be keeping the
 * camera honest, and this is the backstop that catches the frames where the
 * spring has not caught up with it yet. Making it equal would have the backstop
 * fighting the solver on every crest.
 */
const EYE_CLEAR = 0.6;
/** How far above the waterline the camera is allowed to get, ever. */
const SEA_CLEAR = 1.2;
/** Seconds a scenic beauty mark holds before the camera cuts to the next. */
const SCENIC_HOLD = 12;
/** Seconds the race-start sweep takes to arc into the chase pose. */
const HANDOFF_TIME = 1.1;
/** Largest radius the scenic camera will orbit on, metres. */
const SCENIC_ORBIT = 20;

// ---------------------------------------------------------------------------
// Frame-rate independent maths
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Exponential smoothing: the honest frame-rate independent lerp. */
function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

function dampVec(current: THREE.Vector3, target: THREE.Vector3, rate: number, dt: number): void {
  const k = 1 - Math.exp(-rate * dt);
  current.x += (target.x - current.x) * k;
  current.y += (target.y - current.y) * k;
  current.z += (target.z - current.z) * k;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
}

/** C² ease — the one to use for anything a viewer will consciously watch. */
function smootherstep(x: number): number {
  const t = clamp01(x);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Ryan Juckett's stable critically damped spring. Exact for the analytic
 * solution rather than an Euler approximation, so it cannot explode on a long
 * frame and it behaves identically at any dt.
 */
interface Spring1 {
  x: number;
  v: number;
}

function springStep(s: Spring1, target: number, omega: number, dt: number): void {
  const e = Math.exp(-omega * dt);
  const dx = s.x - target;
  const tmp = (s.v + omega * dx) * dt;
  s.x = target + (dx + tmp) * e;
  s.v = (s.v - omega * tmp) * e;
}

/** Same solution, applied to a position + velocity pair. */
function springVec(pos: THREE.Vector3, vel: THREE.Vector3, target: THREE.Vector3, omega: number, dt: number): void {
  const e = Math.exp(-omega * dt);
  const dxX = pos.x - target.x;
  const dxY = pos.y - target.y;
  const dxZ = pos.z - target.z;
  const tX = (vel.x + omega * dxX) * dt;
  const tY = (vel.y + omega * dxY) * dt;
  const tZ = (vel.z + omega * dxZ) * dt;
  pos.set(target.x + (dxX + tX) * e, target.y + (dxY + tY) * e, target.z + (dxZ + tZ) * e);
  vel.set((vel.x - omega * tX) * e, (vel.y - omega * tY) * e, (vel.z - omega * tZ) * e);
}

/** Deterministic value noise — shake must not consume `ctx.rng`. */
function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return (hash1(i) + (hash1(i + 1) - hash1(i)) * u) * 2 - 1;
}

/** Two octaves — a single sine reads as a wobble, this reads as an impact. */
function shakeNoise(t: number, seed: number): number {
  return noise1(t * 17 + seed) * 0.68 + noise1(t * 41.3 + seed * 3.7) * 0.32;
}

// ---------------------------------------------------------------------------
// Scratch — the frame loop allocates nothing
// ---------------------------------------------------------------------------

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _bodyUp = new THREE.Vector3();
const _surfN = new THREE.Vector3();
const _perpW = new THREE.Vector3();
const _perpN = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _boom = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();
const _upTarget = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _plane = new THREE.Vector3();
// Write-out gets its own scratch: it runs *after* everything else has finished
// with theirs, and aliasing a look-at basis is the kind of bug that produces a
// camera that works fine until the one frame it does not.
const _outFwd = new THREE.Vector3();
const _outUp = new THREE.Vector3();
const _outAt = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _quat = new THREE.Quaternion();

/** Reused by every surface probe — `surfaceAt` allocates a sample otherwise. */
function makeSample(): SurfaceSample {
  return {
    height: 0,
    normal: new THREE.Vector3(0, 1, 0),
    kind: "road",
    onTrack: false,
    lateral: 0,
    t: 0,
  };
}

/** Signed angle from `a` to `b` measured about `axis`, both unit. */
function signedAngle(a: THREE.Vector3, b: THREE.Vector3, axis: THREE.Vector3): number {
  const ang = Math.acos(clamp(a.dot(b), -1, 1));
  _cross.crossVectors(a, b);
  return _cross.dot(axis) < 0 ? -ang : ang;
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

export default function createCamera(ctx: KartCtx): System {
  const cam = ctx.camera;
  const quality = ctx.quality;
  const cheap = quality === "low" || quality === "medium";

  // --- rig state ----------------------------------------------------------
  let mode: KartCameraMode = "chase";
  /** Requested subject. -1 means "whoever the human is" — the grid order is the
   *  race system's business, and the player is not necessarily racer zero. */
  let target = -1;
  /** Id actually being filmed this frame; what events are matched against. */
  let liveId = 0;
  let held = false;
  let time = 0;

  /** Spring-followed eye position and its velocity. */
  const eye = new THREE.Vector3().copy(cam.position);
  const eyeVel = new THREE.Vector3();
  /** Smoothed look point and up vector. */
  const look = new THREE.Vector3(0, 0, 0);
  const up = new THREE.Vector3(0, 1, 0);
  /** Heading the boom hangs off — smoothed so a flick of the wheel does not
   *  whip the whole world around. */
  const boomFwd = new THREE.Vector3(0, 0, -1);

  let fov = RIGS.chase.fov;

  // Held pose, for the screenshot harness.
  const poseEye = new THREE.Vector3();
  const poseLook = new THREE.Vector3();
  let poseFov = 55;

  // Blend channels — all exponential, all dt driven.
  let backBlend = 0; // look-back 0..1
  let driftBlend = 0; // 0..1 while drifting
  let swingDir = 0; // latched drift direction, survives the release
  let boostBlend = 0; // 0..1 while boosting
  let airBlend = 0; // 0..1 while airborne
  let speedBlend = 0; // smoothed speed fraction, for FOV and boom length
  let collision = 1; // fraction of the boom the world lets us have

  // Impulse springs.
  const punch: Spring1 = { x: 0, v: 0 }; // boom pull-in on boost onset
  const fovKick: Spring1 = { x: 0, v: 0 }; // matching FOV flare
  const dip: Spring1 = { x: 0, v: 0 }; // camera drop on landing

  // Trauma-model shake (Eiserloh): linear decay, squared response.
  let trauma = 0;
  let traumaFall = 3.2;
  let shakeSeed = 11.7;

  // Race-start cinematic.
  let introActive = true;
  let introTime = 0;
  let introDur = 9; // slow attract-mode arc until a countdown says otherwise
  let handoff = 0; // 0 = cinematic, 1 = chase
  /** One cinematic per countdown, however many times the lights tick. */
  let sawCountdown = false;

  // Scenic orbit.
  let scenicMark = 0;
  let scenicTime = 0;
  const scenicPivot = new THREE.Vector3();
  const scenicOrbit = new THREE.Vector3();
  const scenicEye = new THREE.Vector3();
  let scenicRadius = 20;
  let scenicAngle = 0;
  let scenicHeight = 6;
  let scenicFov = 55;
  let scenicReady = false;

  // Results orbit.
  let resultsAngle = 0;

  /** Reused surface probe — the collision march runs eight of these a frame. */
  const sample = makeSample();
  /** The very first frame snaps rather than springs: the boot pose is (0,4,10)
   *  and nobody wants to watch the camera fly in from it. */
  let firstFrame = true;

  const boomOut = { position: eye, lookAt: look, up };

  // --- service, published before anything can await --------------------------
  const service: KartCameraService = {
    get mode() {
      return mode;
    },
    set mode(next: KartCameraMode) {
      service.setMode(next);
    },
    get fov() {
      return fov;
    },
    get target() {
      return liveId;
    },
    get held() {
      return held;
    },
    get scenicMark() {
      return scenicMark;
    },
    get boom() {
      return boomOut;
    },

    follow(racerId: number) {
      target = racerId | 0;
      held = false;
      if (mode === "free") mode = "chase";
    },

    /**
     * Set and hold. The harness calls this with plain `{x,y,z}` objects, so we
     * read fields rather than calling Vector3 methods on the arguments.
     */
    pose(position: THREE.Vector3, lookAt: THREE.Vector3, fovDeg?: number) {
      if (!position || !lookAt) return;
      const px = Number(position.x);
      const py = Number(position.y);
      const pz = Number(position.z);
      const lx = Number(lookAt.x);
      const ly = Number(lookAt.y);
      const lz = Number(lookAt.z);
      if (![px, py, pz, lx, ly, lz].every(Number.isFinite)) return;
      poseEye.set(px, py, pz);
      poseLook.set(lx, ly, lz);
      // The harness poses the track's authored beauty marks without telling us
      // what focal length they were framed for. If this pose *is* one of those
      // marks, borrow its FOV — otherwise a shot composed for 46° gets taken at
      // the 84° the chase camera happened to be sitting at.
      poseFov = fovDeg ?? matchScenicFov(poseEye) ?? 55;
      mode = "free";
      held = true;
      // Keep the springs continuous so a later follow() flies out of the pose
      // instead of teleporting.
      eye.copy(poseEye);
      eyeVel.set(0, 0, 0);
      look.copy(poseLook);
      up.copy(WORLD_UP);
      fov = poseFov;
      trauma = 0;
      writeCamera();
    },

    release() {
      held = false;
      if (mode === "free") mode = "chase";
    },

    setMode(next: KartCameraMode, opts?: { snap?: boolean }) {
      if (next === mode && !opts?.snap) return;
      mode = next;
      if (next !== "free") held = false;
      // Asking for a different camera outranks the cinematic: a player who hits
      // the view button during the countdown gets the view they asked for.
      if (next !== "chase") introActive = false;
      if (next === "scenic") {
        scenicReady = false;
        scenicTime = 0;
      }
      if (next === "results") resultsAngle = Math.PI;
      if (opts?.snap) eyeVel.set(0, 0, 0);
    },

    shake(amount: number, duration = 0.34) {
      if (!(amount > 0)) return;
      trauma = clamp01(trauma + amount);
      // A long shake must not be cut short by a small quick one landing on top,
      // so the envelope always takes the slower of the two decays.
      traumaFall = Math.min(traumaFall, 1 / Math.max(duration, 0.06));
      shakeSeed = (shakeSeed + 7.31) % 1000;
    },

    shakeAt(position: THREE.Vector3, amount: number, radius = 26, duration = 0.4) {
      const d = eye.distanceTo(position);
      const fall = 1 - smoothstep(radius * 0.25, radius, d);
      if (fall > 0.01) service.shake(amount * fall, duration);
    },

    scenicTo(index: number) {
      scenicMark = index | 0;
      scenicReady = false;
      scenicTime = 0;
    },

    playIntro(seconds = 3.3) {
      introActive = true;
      introTime = 0;
      // `seconds` is the *whole* cinematic including the arc into the chase
      // pose, so that "3.3" means "be in the chase pose as the lights go out"
      // rather than "start moving there when they do".
      introDur = Math.max(0.4, seconds - HANDOFF_TIME);
      handoff = 0;
    },
  };

  ctx.services.camera = service;

  // --- reactions ------------------------------------------------------------
  const off: Array<() => void> = [];
  /** Events carry racer ids, and the subject may be "the player" rather than a
   *  fixed id, so match against whoever is actually on camera. */
  const isTarget = (id: unknown): boolean => typeof id === "number" && id === liveId;

  off.push(
    ctx.on("race:countdown", ((p: { count?: number }) => {
      // The sweep is timed to the lights: the arc is over and the boom is in
      // the chase pose as the last light goes out. The latch matters — the race
      // system ticks this event once a second, and without it every tick would
      // re-arm the cinematic and stomp on a player who just picked a camera.
      if (sawCountdown) return;
      sawCountdown = true;
      const count = typeof p?.count === "number" ? p.count : 3;
      service.playIntro(Math.max(0.9, count + 0.35));
    }) as (p: never) => void),
  );

  off.push(
    ctx.on("race:start", (() => {
      sawCountdown = false;
      // Hand the camera over half a beat before the field actually moves.
      if (introActive) introTime = Math.max(introTime, introDur);
      service.shake(0.16, 0.4);
    }) as (p: never) => void),
  );

  off.push(
    ctx.on("race:results", (() => {
      sawCountdown = false;
      service.setMode("results");
    }) as (p: never) => void),
  );

  off.push(
    ctx.on("kart:boost", ((p: { racer?: number; source?: string }) => {
      if (!isTarget(p?.racer)) return;
      // Velocity impulses, not position steps: a critically damped spring turns
      // them into a rise-and-settle with no overshoot and no pop.
      const big = p?.source === "mushroom" || p?.source === "bullet" || p?.source === "start";
      punch.v -= big ? 34 : 24;
      fovKick.v += big ? 150 : 105;
    }) as (p: never) => void),
  );

  off.push(
    ctx.on("kart:miniTurbo", ((p: { racer?: number; tier?: number }) => {
      if (!isTarget(p?.racer)) return;
      const tier = typeof p?.tier === "number" ? p.tier : 1;
      service.shake(0.07 + tier * 0.035, 0.24);
    }) as (p: never) => void),
  );

  off.push(
    ctx.on("kart:land", ((p: { racer?: number; impact?: number }) => {
      if (!isTarget(p?.racer)) return;
      const impact = clamp(Number(p?.impact) || 0, 0, 26);
      if (impact < 1.5) return;
      dip.v += clamp(impact * 0.85, 0, 16);
      service.shake(clamp(impact * 0.035, 0.05, 0.5), 0.3);
    }) as (p: never) => void),
  );

  off.push(
    ctx.on("kart:hit", ((p: { racer?: number; by?: string; spin?: boolean }) => {
      if (!isTarget(p?.racer)) return;
      if (p?.by === "wall") {
        service.shake(0.22, 0.28);
        return;
      }
      service.shake(p?.spin ? 0.62 : 0.4, 0.5);
      fovKick.v -= 60; // a hit pinches the frame in — the opposite of a boost
    }) as (p: never) => void),
  );

  off.push(
    ctx.on("kart:collide", ((p: { a?: number; b?: number; impulse?: number }) => {
      if (!isTarget(p?.a) && !isTarget(p?.b)) return;
      service.shake(clamp((Number(p?.impulse) || 0) * 0.02, 0.04, 0.28), 0.22);
    }) as (p: never) => void),
  );

  off.push(
    ctx.on("race:respawn", ((p: { racer?: number }) => {
      if (!isTarget(p?.racer)) return;
      // Snap the boom to the new pose: dragging the camera across the map at
      // spring speed after a respawn looks like the game lost track of you.
      eyeVel.set(0, 0, 0);
      collision = 1;
      trauma = 0;
    }) as (p: never) => void),
  );

  // -------------------------------------------------------------------------
  // Helpers that read other systems — every one tolerates a missing service
  // -------------------------------------------------------------------------

  const physics = (): PhysicsService | undefined => ctx.services.physics as PhysicsService | undefined;
  const track = (): TrackService | undefined => ctx.services.track as TrackService | undefined;
  const race = (): RaceService | undefined => ctx.services.race as RaceService | undefined;

  function racerOf(id: number): CamRacer | undefined {
    const phys = physics();
    if (!phys) return undefined;
    const list = phys.racers;
    if (id >= 0 && Array.isArray(list)) {
      for (const r of list) if (r && r.id === id) return r as CamRacer;
    }
    // No explicit subject, or the subject has left the field: film the human.
    const player = phys.player as CamRacer | undefined;
    if (player) return player;
    if (Array.isArray(list)) {
      for (const r of list) if (r && r.isPlayer) return r as CamRacer;
      if (list[0]) return list[0] as CamRacer;
    }
    return undefined;
  }

  function winner(): CamRacer | undefined {
    const phys = physics();
    if (!phys || !Array.isArray(phys.racers)) return undefined;
    let best: RacerState | undefined;
    for (const r of phys.racers) if (!best || r.place < best.place) best = r;
    return (best ?? phys.player) as CamRacer | undefined;
  }

  /** The track's beauty marks carry their own focal length; find it by pose. */
  function matchScenicFov(position: THREE.Vector3): number | null {
    const t = track() as (TrackService & { scenicCount?: number; scenicFov?: (i: number) => number }) | undefined;
    if (!t || typeof t.scenicPose !== "function" || typeof t.scenicFov !== "function") return null;
    const count = typeof t.scenicCount === "number" ? t.scenicCount : 8;
    for (let i = 0; i < count; i++) {
      const p = t.scenicPose(i);
      if (p && p.position.distanceToSquared(position) < 0.25) return t.scenicFov(i);
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Up vector: banking without the motion sickness
  // -------------------------------------------------------------------------
  function solveUp(racer: CamRacer, fwdRef: THREE.Vector3, rig: Rig, out: THREE.Vector3): void {
    _surfN.copy(racer.groundNormal ?? WORLD_UP);
    if (_surfN.lengthSq() < 1e-6) _surfN.copy(_bodyUp);
    else _surfN.normalize();

    // Both candidates measured perpendicular to the travel axis: that isolates
    // *roll* from *pitch*, and pitch we follow in full (cresting a hill should
    // show the road, not the sky).
    _perpW.copy(WORLD_UP).addScaledVector(fwdRef, -WORLD_UP.dot(fwdRef));
    if (_perpW.lengthSq() < 1e-4) {
      // Pointing straight up or straight down — no meaningful world roll axis.
      out.copy(_bodyUp);
      return;
    }
    _perpW.normalize();
    _perpN.copy(_surfN).addScaledVector(fwdRef, -_surfN.dot(fwdRef));
    if (_perpN.lengthSq() < 1e-4) {
      out.copy(_perpW);
      return;
    }
    _perpN.normalize();

    const rollAngle = signedAngle(_perpW, _perpN, fwdRef);
    const mag = Math.abs(rollAngle);
    // Banking: take a fraction, so the corner tips but the horizon stays sane.
    // Wall/ceiling driving: take all of it, or "down" stops meaning anything.
    const k = rig.roll + (1 - rig.roll) * smoothstep(ROLL_BANK, ROLL_WALL, mag);
    out.copy(_perpW).applyAxisAngle(fwdRef, rollAngle * k);
  }

  // -------------------------------------------------------------------------
  // Collision: keep the boom out of the scenery
  // -------------------------------------------------------------------------
  /**
   * A cheap analytic sphere-cast. The track is not a collision mesh — it is a
   * spline with an analytic cross-section — so "cast" here means marching the
   * boom and asking `surfaceAt` / `wallAt` at each station, which is an order
   * of magnitude cheaper than a BVH and exactly stable.
   *
   * The clearance test is `probe.y − sample.height`, and that one expression is
   * correct everywhere because of how `surfaceAt` defines `height`:
   *
   *   · on the ribbon it is `probe.y − (signed distance along the surface
   *     normal)`, so the subtraction is a true along-normal clearance — it
   *     works on the Quarry Bowl's banking and on the vertical anti-gravity
   *     plating, where a naive drop test means nothing;
   *   · off the ribbon it is the terrain height at that XZ, and for a
   *     heightfield "below the height at my XZ" *is* "inside the hill",
   *     however steep the hill happens to be.
   *
   * This used to be gated on `normal.y > 0.45`, which was a stand-in for "is
   * this a floor". It is also true of every cliff face on the course, so the
   * bluff, the quarry walls and the rock slab behind the plating were all
   * invisible to the solver and the camera marched straight into them.
   *
   * A *plane* guard against the plane the kart is standing on backs it up,
   * which works on a wall, a ceiling and a loop alike.
   */
  /**
   * Move `point` out of whatever it is inside, along that surface's own normal.
   *
   * The shortfall is measured the way `surfaceAt` reports it — along the normal
   * on the ribbon, vertically off it — so an off-track push has to be divided
   * by the normal's vertical component to actually clear the shortfall. The
   * divisor is floored: on a near-vertical cliff the honest answer diverges,
   * and one bounded shove followed by a second call is better behaved than a
   * single enormous one.
   */
  function pushClear(point: THREE.Vector3, t: TrackService, hint: number | undefined, want: number): void {
    const s = t.surfaceAt(point, hint, sample);
    if (!s) return;
    const clear = point.y - s.height;
    const need = (s.onTrack ? want : want + 0.35) - clear;
    if (!(need > 0) || !Number.isFinite(need)) return;
    _tmp2.copy(s.normal);
    if (_tmp2.lengthSq() < 1e-6) _tmp2.copy(WORLD_UP);
    else _tmp2.normalize();
    point.addScaledVector(_tmp2, need / (s.onTrack ? 1 : Math.max(0.35, _tmp2.y)));
  }

  /**
   * The backstop, applied to the settled eye rather than to the pose it is
   * springing toward.
   *
   * `resolveCollision` only ever guarantees that the *target* is legal. The eye
   * is a spring, and a spring lags — through a respawn lift, the roll onto the
   * anti-gravity plating, a fall into Gull Creek — which is exactly when the
   * camera used to end up filming the inside of a hillside or the underside of
   * the sea. Bleeding the velocity that put it there matters as much as moving
   * it: without that the spring simply drives it back in on the next frame and
   * the picture judders.
   */
  function keepEyeClear(racer: CamRacer | null): void {
    const t = track();
    const sea = (t as (TrackService & { seaLevel?: number }) | undefined)?.seaLevel;
    // The sea is a plane over the whole world, so it needs no probe at all.
    if (typeof sea === "number" && eye.y < sea + SEA_CLEAR) {
      eye.y = sea + SEA_CLEAR;
      if (eyeVel.y < 0) eyeVel.y = 0;
    }
    if (!t || typeof t.surfaceAt !== "function") return;
    const hint =
      racer && typeof racer.t === "number" && Number.isFinite(racer.t) ? racer.t : undefined;
    _tmp.copy(eye);
    pushClear(eye, t, hint, EYE_CLEAR);
    pushClear(eye, t, hint, EYE_CLEAR);
    _tmp.subVectors(eye, _tmp);
    const moved = _tmp.lengthSq();
    if (moved > 1e-8) {
      _tmp.multiplyScalar(1 / Math.sqrt(moved));
      const into = eyeVel.dot(_tmp);
      if (into < 0) eyeVel.addScaledVector(_tmp, -into);
    }
  }

  function resolveCollision(racer: CamRacer, anchor: THREE.Vector3, desired: THREE.Vector3, dt: number): void {
    const t = track();
    _tmp.copy(desired).sub(anchor);
    const len = _tmp.length();
    if (len < 1e-4) return;
    _tmp.multiplyScalar(1 / len);

    const hint = typeof racer.t === "number" && Number.isFinite(racer.t) ? racer.t : undefined;
    let allowed = 1;
    if (t && typeof t.surfaceAt === "function") {
      const steps = cheap ? 4 : 7;
      for (let i = 1; i <= steps; i++) {
        const u = i / steps;
        _probe.copy(anchor).addScaledVector(_tmp, len * u);
        const s = t.surfaceAt(_probe, hint, sample);
        let blocked = false;
        if (s) {
          const clear = s.onTrack ? GROUND_CLEAR : GROUND_CLEAR + 0.35;
          if (_probe.y - s.height < clear) blocked = true;
        }
        if (!blocked && typeof t.wallAt === "function") {
          const hit = t.wallAt(_probe, 0.55, hint);
          if (hit && hit.solid) blocked = true;
        }
        if (blocked) {
          allowed = (i - 1) / steps;
          break;
        }
      }
    }

    const minU = Math.min(1, MIN_BOOM / len);
    const targetU = clamp(allowed, minU, 1);
    // Asymmetric: duck out of the way instantly, come back out slowly. The
    // reverse reads as the camera being shoved, which is exactly what it is.
    collision = damp(collision, targetU, targetU < collision ? 26 : 3.2, dt);
    collision = clamp(collision, minU, 1);
    desired.copy(anchor).addScaledVector(_tmp, len * collision);

    // Riding a crest, shortening the boom does not help — the ground behind is
    // simply higher than the camera. Push out instead; it keeps the framing.
    if (t && typeof t.surfaceAt === "function") {
      pushClear(desired, t, hint, GROUND_CLEAR);
      pushClear(desired, t, hint, GROUND_CLEAR);
    }

    // Anti-gravity safe floor: stay on the driving side of the plane the kart
    // is standing on, whatever direction that plane happens to face.
    _plane.copy(racer.groundNormal ?? up);
    if (_plane.lengthSq() < 1e-6) _plane.copy(up);
    else _plane.normalize();
    _tmp2.copy(desired).sub(racer.position);
    const along = _tmp2.dot(_plane);
    if (along < PLANE_CLEAR) desired.addScaledVector(_plane, PLANE_CLEAR - along);
  }

  // -------------------------------------------------------------------------
  // Scenic orbit — the title screen, and the first thing anyone sees
  // -------------------------------------------------------------------------
  function armScenic(): void {
    const t = track() as (TrackService & { scenicCount?: number; scenicFov?: (i: number) => number }) | undefined;
    if (t && typeof t.scenicPose === "function") {
      const count = typeof t.scenicCount === "number" && t.scenicCount > 0 ? t.scenicCount : 6;
      scenicMark = ((scenicMark % count) + count) % count;
      const shot = t.scenicPose(scenicMark);
      scenicPivot.copy(shot.lookAt);
      scenicEye.copy(shot.position);
      scenicFov = typeof t.scenicFov === "function" ? t.scenicFov(scenicMark) : 55;
    } else {
      // No course to film: orbit whatever the player is, or the origin.
      const r = racerOf(target);
      scenicPivot.copy(r ? r.position : WORLD_UP);
      scenicEye.copy(scenicPivot).add(new THREE.Vector3(18, 8, 18));
      scenicFov = 55;
    }
    // The authored marks are compositions, not subjects: several of them look a
    // hundred and fifty metres down a straight. Orbiting *that* point would move
    // the camera a millimetre a second. So the eye orbits a pivot capped at
    // `SCENIC_ORBIT` metres along the view ray, while the look point stays on
    // the authored target — the framing survives and the foreground parallaxes,
    // which is the part the eye actually reads as camera movement.
    const dx = scenicEye.x - scenicPivot.x;
    const dz = scenicEye.z - scenicPivot.z;
    const flat = Math.max(1e-3, Math.hypot(dx, dz));
    scenicRadius = Math.min(flat, SCENIC_ORBIT);
    scenicOrbit.set(
      scenicEye.x - (dx / flat) * scenicRadius,
      scenicEye.y,
      scenicEye.z - (dz / flat) * scenicRadius,
    );
    scenicAngle = Math.atan2(scenicEye.z - scenicOrbit.z, scenicEye.x - scenicOrbit.x);
    scenicHeight = 0;
    scenicReady = true;
    scenicTime = 0;
    // A cut is a cut: put the springs exactly on the new mark so the camera
    // does not fly a kilometre across the course between beauty shots.
    eye.copy(scenicEye);
    eyeVel.set(0, 0, 0);
    look.copy(scenicPivot);
    up.copy(WORLD_UP);
  }

  function scenicUpdate(dt: number): void {
    if (!scenicReady) armScenic();
    scenicTime += dt;
    if (scenicTime > SCENIC_HOLD) {
      scenicMark++;
      armScenic();
    }

    // Each shot pushes in slightly and rises as it plays — a locked-off orbit
    // reads as a screensaver, a drifting one reads as a camera operator.
    const e = smootherstep(scenicTime / SCENIC_HOLD);
    // The sweep is *centred* on the authored angle: the mark was composed by
    // hand, so the middle of the shot should be that composition, with the move
    // arriving into it and leaving it rather than starting there and wandering.
    const ang = scenicAngle + (scenicTime - SCENIC_HOLD * 0.5) * 0.021;
    const radius = scenicRadius * (1.045 - 0.085 * e);
    const height = scenicHeight + 0.7 * (e - 0.5) + Math.sin(scenicTime * 0.21) * 0.3;

    _desired.set(
      scenicOrbit.x + Math.cos(ang) * radius,
      scenicOrbit.y + height,
      scenicOrbit.z + Math.sin(ang) * radius,
    );
    // Handheld sway: two slow octaves, barely perceptible, and the single
    // cheapest thing that stops a beauty shot looking computer-generated.
    if (!cheap) {
      _desired.x += noise1(time * 0.19) * 0.16;
      _desired.y += noise1(time * 0.13 + 40) * 0.11;
      _desired.z += noise1(time * 0.17 + 80) * 0.16;
    }
    _lookTarget.copy(scenicPivot);
    _lookTarget.y += Math.sin(scenicTime * 0.17) * 0.35;

    const rig = RIGS.scenic;
    springVec(eye, eyeVel, _desired, rig.omega, dt);
    dampVec(look, _lookTarget, rig.lookRate, dt);
    // A hair of roll, on a period slow enough that you feel it rather than see
    // it. Guarded: a zero-length view axis would make the rotation NaN.
    _upTarget.copy(WORLD_UP);
    _outFwd.copy(look).sub(eye);
    if (_outFwd.lengthSq() > 1e-6) {
      _upTarget.applyAxisAngle(_outFwd.normalize(), Math.sin(time * 0.11) * 0.014);
    }
    dampVec(up, _upTarget, rig.upRate, dt);
    up.normalize();
    fov = damp(fov, scenicFov + Math.sin(time * 0.23) * 0.35, 4, dt);

    keepAboveGround();
  }

  /** Scenic and results never pull the boom in — that would wreck the framing
   *  — but they still must not end up inside a hill or under the waterline. */
  function keepAboveGround(): void {
    keepEyeClear(null);
  }

  // -------------------------------------------------------------------------
  // Results orbit — the winner, at their best angle
  // -------------------------------------------------------------------------
  function resultsUpdate(dt: number, racer: CamRacer): void {
    const rig = RIGS.results;
    resultsAngle += dt * 0.42;
    _fwd.set(0, 0, -1).applyQuaternion(racer.quaternion);
    // Orbit in the kart's own horizontal plane so a winner parked on a banked
    // apron still gets a level, flattering circle.
    _boom.copy(_fwd).applyAxisAngle(WORLD_UP, resultsAngle);
    const rise = 0.65 + 0.35 * Math.sin(resultsAngle * 0.5);
    _desired
      .copy(racer.position)
      .addScaledVector(_boom, rig.dist)
      .addScaledVector(WORLD_UP, rig.height * rise + 0.9);
    _lookTarget.copy(racer.position).addScaledVector(WORLD_UP, rig.look);

    springVec(eye, eyeVel, _desired, rig.omega, dt);
    dampVec(look, _lookTarget, rig.lookRate, dt);
    dampVec(up, WORLD_UP, rig.upRate, dt);
    up.normalize();
    fov = damp(fov, rig.fov, 4, dt);
    keepAboveGround();
  }

  // -------------------------------------------------------------------------
  // The chase — chase / chaseFar / hood, plus the race-start sweep
  // -------------------------------------------------------------------------
  function chaseUpdate(dt: number, racer: CamRacer, rigMode: KartCameraMode): void {
    const rig = RIGS[rigMode];
    const snap = firstFrame;
    const speed = Math.abs(racer.speed || 0);
    const speedFrac = clamp01(speed / TUNING.topSpeed);
    speedBlend = damp(speedBlend, speedFrac, 5, dt);

    // --- body basis --------------------------------------------------------
    _fwd.set(0, 0, -1).applyQuaternion(racer.quaternion);
    _bodyUp.set(0, 1, 0).applyQuaternion(racer.quaternion);

    // --- heading the boom hangs off ---------------------------------------
    // Partly the body, partly the direction of travel. Following travel is what
    // makes a drift read: the camera sits behind where you are *going*, so the
    // kart appears sideways in frame. Following it entirely would make the
    // camera swing wildly the instant the rear steps out, so it is a blend, and
    // the blend opens up while drifting.
    const drifting = racer.drifting ? 1 : 0;
    driftBlend = damp(driftBlend, drifting, drifting ? 4.5 : 10, dt);
    if (racer.driftDir) swingDir = racer.driftDir;

    _tmp.copy(racer.velocity);
    _tmp.addScaledVector(up, -_tmp.dot(up)); // flatten into the road plane
    const vLen = _tmp.length();
    const travelWeight = vLen > 2.5 ? (0.18 + 0.42 * driftBlend) * clamp01(vLen / 8) : 0;
    _tmp2.copy(_fwd);
    if (travelWeight > 0) {
      _tmp.multiplyScalar(1 / vLen);
      // Reverse: never film from in front of the kart just because it rolled back.
      if (_tmp.dot(_fwd) > 0) _tmp2.lerp(_tmp, travelWeight).normalize();
    }
    // Heading rate rises with speed — slow and forgiving in the hairpins, tight
    // on the straights where a lagging boom would feel like steering treacle.
    if (snap) boomFwd.copy(_tmp2);
    else dampVec(boomFwd, _tmp2, 5.5 + 7 * speedBlend, dt);
    if (boomFwd.lengthSq() < 1e-6) boomFwd.copy(_fwd);
    boomFwd.normalize();

    // --- up vector ---------------------------------------------------------
    solveUp(racer, boomFwd, rig, _upTarget);
    // A whisper of banking into the corner from the kart's own yaw rate. Tiny —
    // six degrees at the absolute limit — but it is what stops fast corners
    // feeling like they were filmed from a tripod.
    const bank = clamp(-(racer.yawRate || 0) * speedBlend * 0.05, -0.11, 0.11);
    _upTarget.applyAxisAngle(boomFwd, bank).normalize();
    if (snap) up.copy(_upTarget);
    else dampVec(up, _upTarget, rig.upRate, dt);
    if (up.lengthSq() < 1e-6) up.copy(WORLD_UP);
    up.normalize();

    // --- state blends ------------------------------------------------------
    const boosting = (racer.boost || 0) > 0 || (racer.star || 0) > 0 ? 1 : 0;
    boostBlend = damp(boostBlend, boosting, boosting ? 8 : 2.6, dt);
    const airing = racer.grounded ? 0 : smoothstep(0.12, 0.5, racer.airTime || 0);
    airBlend = damp(airBlend, airing, airing > airBlend ? 6 : 4, dt);
    const wantBack = ctx.input.lookBack ? 1 : 0;
    backBlend = damp(backBlend, wantBack, 14, dt);

    springStep(punch, 0, 9, dt);
    springStep(fovKick, 0, 7, dt);
    springStep(dip, 0, 13, dt);

    // --- polar rig ---------------------------------------------------------
    // θ = 0 is in front of the nose, π is directly behind.
    let theta = Math.PI;
    // Swing to the *outside* of the drift: a right-hand drift throws the tail
    // left, and the camera goes with it, so you see the flank and the sparks.
    theta -= swingDir * driftBlend * (0.1 + 0.06 * clamp01(racer.driftCharge || 0));
    // Look-back whips the boom around the side rather than through the kart.
    theta += Math.PI * backBlend;

    let dist = rig.dist;
    dist *= 1 + 0.14 * speedBlend + 0.2 * airBlend + 0.1 * boostBlend;
    dist -= 0.55 * boostBlend; // the boost pull-in, held for the duration
    dist += punch.x; // ...and the kick at its onset
    dist *= 1 - 0.14 * backBlend;
    // Braking hard pulls the camera in, hard acceleration lets it trail: the
    // load transfer the player already feels in their hands, made visible.
    const g = typeof racer.accelG === "number" ? clamp(racer.accelG, -1.2, 1.2) : 0;
    dist += g * 0.35;
    dist = Math.max(rigMode === "hood" ? 0.2 : MIN_BOOM, dist);

    let height = rig.height;
    height += 0.55 * airBlend; // rise to show the landing
    height -= 0.18 * speedBlend; // and drop toward the tarmac with speed
    height -= dip.x * 0.55; // landings punch the camera down and back up
    if (rigMode !== "hood") height += 0.25 * driftBlend;

    // --- desired eye -------------------------------------------------------
    _boom.copy(boomFwd).applyAxisAngle(up, theta);
    _anchor.copy(racer.position);
    _desired.copy(_anchor).addScaledVector(_boom, dist).addScaledVector(up, height);

    // --- look point --------------------------------------------------------
    const lead = rig.lead * (0.35 + 0.75 * speedBlend) * (1 - backBlend);
    _lookTarget.copy(racer.position).addScaledVector(up, rig.look).addScaledVector(boomFwd, lead);
    // Airborne, aim down the arc: the player needs to see where they land far
    // more than they need to see the horizon.
    if (airBlend > 0.01) {
      _lookTarget.addScaledVector(boomFwd, 3.2 * airBlend);
      _lookTarget.addScaledVector(up, -2.4 * airBlend);
    }
    if (rigMode === "hood") {
      // The cockpit looks where the *kart* is pointed, plus a little of where
      // the wheels are pointed — steering you can see is steering you can feel.
      _tmp.copy(boomFwd).applyAxisAngle(up, -(racer.steerAngle || 0) * 0.45);
      _lookTarget.copy(racer.position).addScaledVector(up, rig.look).addScaledVector(_tmp, rig.lead);
      if (backBlend > 0.01) {
        _lookTarget.copy(racer.position).addScaledVector(up, rig.look).addScaledVector(_tmp, -rig.lead * backBlend);
      }
    }

    // --- race-start cinematic ---------------------------------------------
    if (introActive) applyIntro(dt, racer, rig, _desired, _lookTarget);

    // --- solve -------------------------------------------------------------
    // The anchor for the collision march sits at the kart's shoulder, not at
    // its origin, so the march never starts inside the tarmac.
    _anchor.copy(racer.position).addScaledVector(up, Math.min(height, 1.1));
    resolveCollision(racer, _anchor, _desired, dt);

    // Respawning karts are being flown through the air by the physics system;
    // stiffen the spring so the camera stays with them instead of trailing a
    // rubber band across the scenery.
    const omega = rig.omega * (racer.respawning ? 2.2 : 1) * (introActive ? 1.6 : 1);
    if (firstFrame) {
      eye.copy(_desired);
      eyeVel.set(0, 0, 0);
      look.copy(_lookTarget);
      firstFrame = false;
    } else {
      springVec(eye, eyeVel, _desired, omega, dt);
    }
    keepEyeClear(racer);
    dampVec(look, _lookTarget, rig.lookRate, dt);

    // --- field of view -----------------------------------------------------
    let fovTarget = rig.fov + rig.fovSpeed * Math.pow(speedBlend, 1.25);
    fovTarget += 7 * boostBlend + 2.2 * driftBlend + 2.5 * airBlend + fovKick.x;
    if (introActive) fovTarget = introFov(fovTarget);
    fov = damp(fov, clamp(fovTarget, 40, 96), 7, dt);
  }

  // -------------------------------------------------------------------------
  // Countdown sweep
  // -------------------------------------------------------------------------
  /**
   * A low front three-quarter of the grid that arcs around the kart's flank
   * into the chase pose as the lights go out. Because the rig is polar, the
   * handoff is an interpolation of θ, boom length and height — an orbit — and
   * never a straight line through the driver.
   *
   * With no race system booted this simply loops as a slow attract-mode arc,
   * which is exactly what the screenshot harness photographs.
   */
  function applyIntro(dt: number, racer: CamRacer, rig: Rig, outEye: THREE.Vector3, outLook: THREE.Vector3): void {
    introTime += dt;
    const phase = race()?.phase;
    const moving = Math.abs(racer.speed || 0) > 3.5;
    if (phase === "racing" || phase === "finished" || phase === "results" || moving) {
      introTime = Math.max(introTime, introDur);
    }

    // Hold the cinematic until the clock runs out, then arc away.
    const over = introTime - introDur;
    handoff = over <= 0 ? 0 : smootherstep(over / HANDOFF_TIME);
    if (handoff >= 1) {
      introActive = false;
      return;
    }

    // The cinematic itself keeps moving the whole time it is on screen: a slow
    // truck across the front of the grid, easing wider and taller.
    const e = smootherstep(clamp01(introTime / Math.max(introDur, 0.001)));
    const drift = introTime * 0.055;
    const theta = -1.12 + 0.34 * e + drift;
    // Close enough that the kart is the subject rather than a detail of the
    // grid, and low enough that it is a hero shot rather than a diagram.
    const dist = 7.1 - 1.5 * e;
    const height = 0.62 + 0.62 * e;

    _tmp.copy(boomFwd).applyAxisAngle(up, theta);
    _tmp2.copy(racer.position).addScaledVector(_tmp, dist).addScaledVector(up, height);
    // Blend the *polar* parameters rather than the two world positions, so the
    // camera swings around the kart's right flank on its way to the chase pose.
    const k = handoff;
    if (k > 0) {
      // Unwrap toward -π so the sweep goes the short way round the flank.
      const endTheta = -Math.PI;
      const th = theta + (endTheta - theta) * k;
      const d = dist + (rig.dist - dist) * k;
      const h = height + (rig.height - height) * k;
      _tmp.copy(boomFwd).applyAxisAngle(up, th);
      _tmp2.copy(racer.position).addScaledVector(_tmp, d).addScaledVector(up, h);
    }
    outEye.copy(_tmp2);

    // Aim at the driver's shoulders, not the floor pan: from this low the
    // camera should be looking slightly *up* at the kart.
    _tmp.copy(racer.position).addScaledVector(up, 1.05);
    outLook.lerp(_tmp, 1 - k);
  }

  function introFov(chaseFov: number): number {
    const e = smootherstep(clamp01(introTime / Math.max(introDur, 0.001)));
    const cine = 46 + 11 * e;
    return cine + (chaseFov - cine) * handoff;
  }

  // -------------------------------------------------------------------------
  // Shake + write-out
  // -------------------------------------------------------------------------
  function applyShake(dt: number): void {
    if (trauma <= 0) return;
    trauma = Math.max(0, trauma - traumaFall * dt);
    if (trauma <= 0) {
      traumaFall = 3.2;
      return;
    }
    // Squared response: small knocks stay small, a shell to the back of the
    // head is unmistakable.
    const amp = trauma * trauma;
    _fwd.copy(look).sub(eye);
    const dist = _fwd.length();
    if (dist < 1e-4) return;
    _fwd.multiplyScalar(1 / dist);
    _right.crossVectors(_fwd, up).normalize();
    _tmp.copy(up).crossVectors(_right, _fwd).normalize();

    eye.addScaledVector(_right, shakeNoise(time, shakeSeed) * amp * 0.5);
    eye.addScaledVector(_tmp, shakeNoise(time, shakeSeed + 21) * amp * 0.36);
    eye.addScaledVector(_fwd, shakeNoise(time, shakeSeed + 53) * amp * 0.22);
    // Rolling the up vector shakes the *frame*, not just the position, which is
    // what makes an impact feel like it happened to the camera operator.
    up.applyAxisAngle(_fwd, shakeNoise(time, shakeSeed + 77) * amp * 0.055).normalize();
    fov += shakeNoise(time, shakeSeed + 91) * amp * 1.6;
  }

  /** Boost hum: a fast, tiny vibration that reads as engine, not as a bug. */
  function applyBoostShimmer(): void {
    if (boostBlend < 0.02 || cheap) return;
    const a = boostBlend * 0.022;
    eye.x += Math.sin(time * 61) * a;
    eye.y += Math.sin(time * 47 + 1.3) * a;
  }

  function writeCamera(): void {
    if (!Number.isFinite(fov)) fov = RIGS.chase.fov;
    if (!Number.isFinite(eye.x) || !Number.isFinite(eye.y) || !Number.isFinite(eye.z)) {
      // A NaN camera is a black screen and a very long afternoon. Recover to
      // something sane rather than propagating it into the projection matrix.
      eye.set(0, 5, 12);
      eyeVel.set(0, 0, 0);
      look.set(0, 1, 0);
    }
    _outFwd.copy(look).sub(eye);
    if (_outFwd.lengthSq() < 1e-6) _outFwd.set(0, 0, -1);
    _outFwd.normalize();
    // A look-at basis collapses when up is parallel to forward — re-derive an
    // up rather than emitting a degenerate matrix.
    _outUp.copy(up);
    if (_outUp.lengthSq() < 1e-6 || Math.abs(_outUp.dot(_outFwd)) > 0.9995) {
      _outUp.set(0, 1, 0).addScaledVector(_outFwd, -_outFwd.y);
      if (_outUp.lengthSq() < 1e-6) _outUp.set(1, 0, 0).addScaledVector(_outFwd, -_outFwd.x);
      _outUp.normalize();
    }

    _outAt.copy(eye).add(_outFwd);
    _mat.lookAt(eye, _outAt, _outUp);
    _quat.setFromRotationMatrix(_mat);
    cam.position.copy(eye);
    cam.quaternion.copy(_quat);
    cam.up.copy(_outUp);
    if (Math.abs(cam.fov - fov) > 0.002) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------
  return {
    lateUpdate(dt: number) {
      // The harness steps at a forced dt and a stalled tab hands us a whole
      // second; clamp so neither can knock the springs sideways.
      const step = clamp(dt, 1 / 600, 1 / 12);
      time += step;

      if (held) {
        eye.copy(poseEye);
        look.copy(poseLook);
        up.copy(WORLD_UP);
        fov = poseFov;
        writeCamera();
        return;
      }

      const racer = mode === "results" ? (winner() ?? racerOf(target)) : racerOf(target);
      if (racer) liveId = racer.id;

      if (mode === "scenic" || (!racer && mode !== "free")) {
        scenicUpdate(step);
      } else if (!racer) {
        // Mode 'free' with nothing posed: leave the camera exactly where it is.
        return;
      } else if (mode === "results") {
        resultsUpdate(step, racer);
      } else {
        chaseUpdate(step, racer, mode === "free" ? "chase" : mode);
        applyBoostShimmer();
      }

      applyShake(step);
      writeCamera();
    },

    resize() {
      cam.updateProjectionMatrix();
    },

    dispose() {
      for (const fn of off) fn();
      off.length = 0;
      if (ctx.services.camera === service) delete ctx.services.camera;
    },
  };
}
