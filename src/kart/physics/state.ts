/**
 * Vibe Kart — per-racer state: the public `RacerState` plus the private
 * bookkeeping the integrator needs.
 *
 * `RacerState` is shared law and every other system reads it, so it holds only
 * things worth publishing. The `Sim` record beside it holds the ugly parts —
 * spring velocities, edge latches, cooldowns, the projection hint — and never
 * escapes this module. Splitting them keeps the contract clean and stops a
 * later reader from wondering whether `padCooldown` is something the HUD
 * should be drawing.
 *
 * `KartRacer` is a strict superset of `RacerState`: a handful of extra visual
 * channels the model and VFX rigs can use if they know to look for them, and
 * which cost nothing if they do not. It is declared here rather than in
 * types.ts because this module does not get to edit shared law.
 */
import * as THREE from "three";
import { SURFACES, type GridSlot, type RacerState, type SurfaceKind, type SurfaceSample } from "../types";
import { REST_COMPRESSION } from "./tuning";
import type { KartStats } from "./tuning";

/** Additive visual channels published alongside the contract fields. */
export interface KartRacer extends RacerState {
  /** Live normalised arc position on the centreline — not lap-aware. */
  t: number;
  /** Signed metres from the centreline, + to the racer's right. */
  lateral: number;
  /** Signed slip angle of the velocity in body space, radians. */
  slipAngle: number;
  /** Vertical scale for squash hits: 1 normal, 0.35 flattened. */
  squash: number;
  /** Body pitch from load transfer, radians. + is nose-up. */
  bodyPitch: number;
  /** Hop lift 0..1 while the wheels are tucked mid-hop. */
  hop: number;
  /** True while any wheel is on a boost panel. */
  onPad: boolean;
  /** True while the kart is being lifted back onto the road. */
  respawning: boolean;
  /** Longitudinal g, smoothed — the camera and the HUD both want it. */
  accelG: number;
}

/** Per-wheel probe results, kept flat and reused every step. */
export interface WheelProbe {
  /** Contact-patch clearance along the surface normal, metres. */
  clearance: number;
  /** Spring compression 0..1 after load transfer, written to the racer. */
  compression: number;
  /** Surface normal under this wheel. */
  normal: THREE.Vector3;
  kind: SurfaceKind;
  onTrack: boolean;
  contact: boolean;
  sample: SurfaceSample;
  /** World position of the probe, kept for spark and dust emitters. */
  point: THREE.Vector3;
}

export function makeWheelProbe(): WheelProbe {
  return {
    clearance: 0,
    compression: REST_COMPRESSION,
    normal: new THREE.Vector3(0, 1, 0),
    kind: "road",
    onTrack: true,
    contact: true,
    sample: {
      height: 0,
      normal: new THREE.Vector3(0, 1, 0),
      kind: "road",
      onTrack: true,
      lateral: 0,
      t: 0,
    },
    point: new THREE.Vector3(),
  };
}

export type Controls = { accel: number; brake: number; steer: number; drift: boolean };

/** Everything the step needs and nobody else should see. */
export interface Sim {
  racer: KartRacer;
  stats: KartStats;

  /** Orthonormal body frame, maintained directly rather than via the quaternion. */
  forward: THREE.Vector3;
  up: THREE.Vector3;
  right: THREE.Vector3;
  /** Velocity of the ground-alignment spring. */
  upVel: THREE.Vector3;

  controls: Controls;
  /** Level state of the drift button last step, for deriving the AI's edge. */
  prevDrift: boolean;
  /** Smoothed steering, so keyboard input is not a square wave. */
  steerSmoothed: number;

  wheels: WheelProbe[];
  /** Averaged surface properties under the contacting wheels. */
  grip: number;
  speedMul: number;
  drag: number;
  rattle: number;
  /** Blended contact normal, and how far it leans off world up. */
  contactNormal: THREE.Vector3;
  contacts: number;
  /** Seconds of grounded grace remaining after the last contact. */
  coyote: number;
  /**
   * Smallest clearance to a lethal surface when every probe reports void.
   * Large while sailing over the gap jump, small once the kart is genuinely at
   * the bottom of the drop — which is the difference between a stunt and a
   * respawn.
   */
  voidDepth: number;
  /** Suspension is disabled while this is positive (immediately after a hop). */
  hopMute: number;
  /** Normal-direction closing speed measured at the last touchdown. */
  landImpact: number;

  /** Seconds of drift charge accumulated. */
  driftTime: number;
  /** Countdown of the window in which a hop can still become a drift. */
  driftLock: number;
  /** Ramp 0..1 of the drift slip target. */
  driftRamp: number;
  /** True between the hop and the landing that starts the drift. */
  hopping: boolean;
  /** The hop has actually left the ground — guards against instant landings. */
  hopLeft: boolean;
  hopTimer: number;
  /** Drift direction picked during the hop, applied on touchdown. */
  pendingDir: 0 | 1 | -1;
  /** Smoothed nose-up/nose-down attitude while airborne, radians. */
  airPitch: number;
  /** Which way a spin-out turns — fixed per hit so it reads consistently. */
  spinDir: 1 | -1;
  /** How long the kart has been wading. Deep water eventually drowns it. */
  drownTimer: number;

  /** Trick animation timer and whether the boost has been banked. */
  trickTimer: number;
  trickDir: 0 | 1 | -1;
  trickArmed: boolean;

  /** Accumulated spin-out rotation, radians. */
  spinAngle: number;

  /** Respawn choreography. */
  respawnTimer: number;
  respawnSlot: GridSlot | null;
  respawnFrom: THREE.Vector3;

  /** Projection hint — a kart moves ~0.25 m a step, so this is nearly free. */
  hint: number;
  /** World height of the road plane under the kart, from the same projection. */
  roadHeight: number;
  /** Last progress at which the kart was safely on the road. */
  safeT: number;
  safeLane: number;

  padCooldown: number;
  /** Blocks the tow from recharging the instant it paid out. */
  draftCooldown: number;
  wallCooldown: number;
  offroadCooldown: number;
  prevSurface: SurfaceKind;

  /** Deterministic noise phase — distance travelled, for kerb rattle. */
  travel: number;
  /** Per-racer noise salt so eight karts do not rattle in unison. */
  salt: number;
}

export function makeRacer(spec: {
  id: number;
  name: string;
  characterId: string;
  isPlayer: boolean;
}): KartRacer {
  return {
    id: spec.id,
    name: spec.name,
    characterId: spec.characterId,
    isPlayer: spec.isPlayer,

    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    yawRate: 0,

    speed: 0,
    maxSpeed: 0,
    rpm: 0,

    grounded: true,
    airTime: 0,
    surface: "road",
    groundNormal: new THREE.Vector3(0, 1, 0),

    drifting: false,
    driftDir: 0,
    driftCharge: 0,
    driftTier: 0,

    boost: 0,
    boostSource: null,
    draft: 0,

    stun: 0,
    stunKind: null,
    invuln: 0,
    star: 0,

    progress: 0,
    lap: 0,
    checkpoint: 0,
    place: spec.id + 1,
    finished: false,
    finishTime: 0,
    lapTimes: [],
    coins: 0,

    item: null,
    itemCount: 0,
    rolling: false,

    wheelCompression: [REST_COMPRESSION, REST_COMPRESSION, REST_COMPRESSION, REST_COMPRESSION],
    wheelSpin: 0,
    steerAngle: 0,
    bodyRoll: 0,
    trick: 0,

    t: 0,
    lateral: 0,
    slipAngle: 0,
    squash: 1,
    bodyPitch: 0,
    hop: 0,
    onPad: false,
    respawning: false,
    accelG: 0,
  };
}

export function makeSim(racer: KartRacer, stats: KartStats): Sim {
  return {
    racer,
    stats,
    forward: new THREE.Vector3(0, 0, -1),
    up: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(1, 0, 0),
    upVel: new THREE.Vector3(),
    controls: { accel: 0, brake: 0, steer: 0, drift: false },
    prevDrift: false,
    steerSmoothed: 0,
    wheels: [makeWheelProbe(), makeWheelProbe(), makeWheelProbe(), makeWheelProbe()],
    grip: 1,
    speedMul: 1,
    drag: SURFACES.road.drag,
    rattle: 0,
    contactNormal: new THREE.Vector3(0, 1, 0),
    contacts: 4,
    coyote: 0,
    voidDepth: Infinity,
    hopMute: 0,
    landImpact: 0,
    driftTime: 0,
    driftLock: 0,
    driftRamp: 0,
    hopping: false,
    hopLeft: false,
    hopTimer: 0,
    pendingDir: 0,
    airPitch: 0,
    spinDir: (racer.id & 1) === 0 ? 1 : -1,
    drownTimer: 0,
    trickTimer: 0,
    trickDir: 0,
    trickArmed: false,
    spinAngle: 0,
    respawnTimer: 0,
    respawnSlot: null,
    respawnFrom: new THREE.Vector3(),
    hint: 0,
    roadHeight: 0,
    safeT: 0,
    safeLane: 0,
    padCooldown: 0,
    draftCooldown: 0,
    wallCooldown: 0,
    offroadCooldown: 0,
    prevSurface: "road",
    travel: 0,
    salt: (racer.id * 2654435761) >>> 0,
  };
}
