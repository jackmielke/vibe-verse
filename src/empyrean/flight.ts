/**
 * The body — walking, falling, and the jetpack.
 *
 * This is Vibe City's player, lifted out into a function you can call from a
 * test. Every constant it uses comes from `@/lib/worldPhysics`, which is the
 * whole point: the same 24 m/s² of gravity, the same 7 and 16 on the ground,
 * the same 22 and 34 in the air, the same 11 m/s jump and the same 50 m/s² of
 * thrust that City's Space bar gives you. Somebody who has learned to fly in
 * Vibe City already knows how to fly here, down to the muscle memory of how
 * long to hold to clear a roof.
 *
 * The one number that is local is `THRUST`, and only because City keeps it in
 * its page rather than in the shared module. It is the same 50.
 *
 * Kept free of Three's scene graph and of any DOM so `src/test/empyrean.test.ts`
 * can fly it around and assert on where it ends up — the alternative is that
 * the only way to find out whether the jetpack still works is to open the route
 * and hold the space bar.
 */
import * as THREE from "three";
import {
  FLY_RUN_SPEED,
  FLY_SPEED,
  GRAVITY,
  JUMP_VELOCITY,
  MAX_FALL,
  MAX_RISE,
  RUN_SPEED,
  WALK_SPEED,
} from "@/lib/worldPhysics";

/** Jetpack acceleration, m/s². Net climb is this minus gravity. Same as City. */
export const THRUST = 50;

/** Body radius used against the tower boxes, m. */
export const BODY_R = 0.6;

/** How far above a surface still counts as standing on it. */
export const SNAP = 0.35;

/**
 * How high a step a body can walk up without jumping.
 *
 * The city has kerbs at 16 cm and stairs down to the promenades, and a player
 * who has to jump onto a kerb is a player who is fighting the world. Sixty
 * centimetres takes every step and every kerb in the plan and still stops you
 * strolling up the side of a building.
 *
 * It is only offered when you are on the ground or drifting up slowly. Applied
 * while climbing at nineteen metres a second it would catch you on the
 * underside of every balcony you flew past, which is the exact thing the
 * one-way decks exist to prevent.
 */
export const CLIMB = 0.62;

/** Vertical speed above which the step-up reach is withdrawn. */
const CLIMB_MAX_RISE = 1.5;

export interface FlyerInput {
  /** -1..1, forward positive. */
  forward: number;
  /** -1..1, right positive. */
  strafe: number;
  run: boolean;
  /** The jetpack, held. */
  jet: boolean;
  /** Camera yaw, radians. Movement is camera-relative, as everywhere else. */
  camYaw: number;
}

export interface FlyerState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Which way the body is facing. Eased toward the direction of travel. */
  yaw: number;
  /** Lean into the run, and forward under thrust. Radians. */
  pitch: number;
  grounded: boolean;
  thrusting: boolean;
  /** 0..1, how hard the jets are burning. Drives the plume and the sound. */
  burn: number;
  /** Set on the frame the body touches down, with the impact speed in m/s. */
  landed: number;
  /**
   * 0..1, decaying. Set by a hard landing and read by whatever wants to
   * squash the body, shake the camera or thump the speakers. An event that
   * only exists for one frame is an event most systems will miss, because
   * most systems do not run every frame.
   */
  impact: number;
  /** Metres climbed by the step-up this frame, for a footfall on stairs. */
  stepped: number;
  /** Metres of clear air directly below. Infinity over the void. */
  drop: number;
}

export interface FlyerWorld {
  /**
   * The highest standable surface at (x, z) that is at or below `fromY`.
   *
   * The `fromY` argument is what makes the terraces one-way: approach a deck
   * from underneath and it is not there, so you fly up past it rather than
   * being snapped onto its roof through half a metre of stone.
   */
  supportAt(x: number, z: number, fromY: number): number;
  /** True if a body at (x, z, y) would be inside a building. */
  blockedAt(x: number, z: number, y: number): boolean;
  /** Below this, you have left the world. */
  killY: number;
  /** Where you come back. */
  spawn: { x: number; y: number; z: number; yaw: number };
}

export function makeFlyer(spawn: FlyerWorld["spawn"]): FlyerState {
  return {
    position: new THREE.Vector3(spawn.x, spawn.y, spawn.z),
    velocity: new THREE.Vector3(),
    yaw: spawn.yaw,
    pitch: 0,
    grounded: true,
    thrusting: false,
    burn: 0,
    landed: 0,
    impact: 0,
    stepped: 0,
    drop: 0,
  };
}

const _intent = new THREE.Vector3();

/**
 * One step. `dt` is expected clamped by the caller; it is clamped again here
 * because a physics function that a background tab can teleport through the
 * floor is a physics function with a bug in it.
 */
export function stepFlyer(
  s: FlyerState,
  input: FlyerInput,
  world: FlyerWorld,
  dtRaw: number,
): void {
  const dt = Math.min(Math.max(dtRaw, 0), 0.05);
  s.landed = 0;
  s.stepped = 0;
  s.impact *= Math.pow(0.02, dt);

  /* ---- intent, in camera space ---------------------------------------- */
  const fx = -Math.sin(input.camYaw);
  const fz = -Math.cos(input.camYaw);
  const rx = Math.cos(input.camYaw);
  const rz = -Math.sin(input.camYaw);
  _intent.set(
    fx * input.forward + rx * input.strafe,
    0,
    fz * input.forward + rz * input.strafe,
  );
  if (_intent.lengthSq() > 1) _intent.normalize();

  const running = input.run;
  const thrusting = input.jet;
  s.thrusting = thrusting;
  // The plume lags the input a little in both directions — a jet that snaps
  // on and off looks like a boolean, which is what it is and not what it
  // should look like.
  s.burn += ((thrusting ? 1 : 0) - s.burn) * (1 - Math.pow(thrusting ? 0.002 : 0.02, dt));

  const wasGrounded = s.grounded;

  /* ---- horizontal ------------------------------------------------------
   * Exponential easing toward a target velocity, with the ground far firmer
   * than the air. Identical shape and identical constants to City's, which is
   * why a run off the edge of the plaza carries exactly as far as it does
   * off a City rooftop. */
  const targetSpeed = s.grounded
    ? running
      ? RUN_SPEED
      : WALK_SPEED
    : running
      ? FLY_RUN_SPEED
      : FLY_SPEED;
  const k = s.grounded ? 1 - Math.pow(0.0001, dt) : 1 - Math.pow(0.05, dt);
  s.velocity.x += (_intent.x * targetSpeed - s.velocity.x) * k;
  s.velocity.z += (_intent.z * targetSpeed - s.velocity.z) * k;

  /* ---- vertical -------------------------------------------------------- */
  s.velocity.y -= GRAVITY * dt;
  if (thrusting) {
    s.velocity.y += THRUST * dt;
    s.grounded = false;
  }
  s.velocity.y = THREE.MathUtils.clamp(s.velocity.y, -MAX_FALL, MAX_RISE);

  /* ---- integrate, axis-separated -------------------------------------- */
  const prevY = s.position.y;

  const nx = s.position.x + s.velocity.x * dt;
  const nz = s.position.z + s.velocity.z * dt;
  if (!world.blockedAt(nx, nz, prevY)) {
    s.position.x = nx;
    s.position.z = nz;
  } else if (!world.blockedAt(nx, s.position.z, prevY)) {
    // Slide along the wall rather than stopping dead against it.
    s.position.x = nx;
    s.velocity.z = 0;
  } else if (!world.blockedAt(s.position.x, nz, prevY)) {
    s.position.z = nz;
    s.velocity.x = 0;
  } else {
    s.velocity.x = 0;
    s.velocity.z = 0;
  }

  s.position.y += s.velocity.y * dt;

  /* ---- ground ----------------------------------------------------------
   * Support is looked up from where the body *was*, not where it now is, so a
   * deck you passed under going up cannot catch you. The reach is the step-up
   * height on foot and almost nothing while climbing — see CLIMB. */
  const reach = wasGrounded || s.velocity.y < CLIMB_MAX_RISE ? CLIMB : 0.05;
  const support = world.supportAt(s.position.x, s.position.z, prevY + reach);
  if (s.position.y <= support) {
    const impact = -s.velocity.y;
    if (support > prevY + 0.02 && wasGrounded) s.stepped = support - prevY;
    s.position.y = support;
    s.velocity.y = 0;
    s.grounded = true;
    if (!wasGrounded) {
      s.landed = Math.max(0, impact);
      // Anything under a five-metre drop is a step, not a landing.
      s.impact = Math.min(1, Math.max(0, (impact - 9) / 23));
    }
  } else if (s.position.y > support + SNAP) {
    s.grounded = false;
  }
  s.drop = Math.max(0, s.position.y - support);
  if (!Number.isFinite(support)) s.drop = Infinity;

  /* ---- fell out of the world ------------------------------------------ */
  if (s.position.y < world.killY) {
    s.position.set(world.spawn.x, world.spawn.y, world.spawn.z);
    s.velocity.set(0, 0, 0);
    s.yaw = world.spawn.yaw;
    s.grounded = true;
  }

  /* ---- facing ----------------------------------------------------------
   * Turn toward where you are actually going, not where the stick points:
   * under thrust with no stick you keep drifting, and the body should keep
   * facing the drift rather than snapping back to the camera. */
  const speed = Math.hypot(s.velocity.x, s.velocity.z);
  if (speed > 0.8) {
    const target = Math.atan2(s.velocity.x, s.velocity.z);
    let dy = target - s.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    s.yaw += dy * Math.min(1, dt * 9);
  }

  // Lean: into the run on the ground, and much harder in the air, where the
  // body is being pushed by a rocket rather than by its own legs.
  const targetPitch = s.grounded
    ? Math.min(speed / RUN_SPEED, 1) * 0.10
    : Math.min(speed / FLY_RUN_SPEED, 1) * 0.42 - (thrusting ? 0.10 : 0);
  s.pitch += (targetPitch - s.pitch) * Math.min(1, dt * 5);
}

/**
 * The parkour jump, for a tap of Space on the ground.
 *
 * Kept out of the step function because it is edge-triggered and the step
 * function is not.
 */
export function jump(s: FlyerState): void {
  if (!s.grounded) return;
  s.velocity.y = JUMP_VELOCITY;
  s.grounded = false;
}
