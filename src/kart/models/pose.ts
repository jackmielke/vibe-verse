/**
 * Vibe Kart — posing. This is where the models stop being props.
 *
 * The physics system publishes a handful of scalars per racer — four wheel
 * compressions, a spin angle, a steering angle, a body roll, a trick phase — and
 * this file turns them into a performance: the chassis squats under power and
 * dives under brakes, the outside wheels load up through a drift, the driver
 * counter-leans and braces, both hands stay welded to the wheel rim through
 * full lock via a two-bone IK solve, the head turns into the corner and snaps
 * around on look-back, the scarf trails on a Verlet chain, and the face changes
 * expression with what is actually happening in the race.
 *
 * Three rules run through all of it:
 *
 * · **Nothing snaps.** Every value the eye can follow goes through `damp()` or a
 *   `Spring`, so it has a rise time and, where it matters, an overshoot.
 * · **Nothing is authoritative.** Physics owns the root transform; if it is not
 *   driving it, we do, and we notice which case we are in rather than fighting.
 * · **Everything degrades.** A racer with no wheel data still rolls its wheels
 *   (integrated from speed), a rig with no scarf skips the sim, and a missing
 *   track service costs a shadow, not a frame.
 */
import * as THREE from "three";
import { TUNING, type RacerState } from "../types";
import { Spring, clamp, clamp01, damp, dampAngle, easeInOutCubic, hump, makeRng, smoothstep, TAU, type Rng } from "./math";
import type { KartAssembly } from "./kart";
import type { DriverAssembly } from "./driver";
import { poseArms } from "./driver";
import type { RigMaterials } from "./materials";
import { faceOffset, type Expression } from "./textures";
import { WEIGHT_FEEL, type RacerLook } from "./roster";

export interface PoseState {
  rng: Rng;
  /** Idle phase offset so eight karts never breathe in lockstep. */
  phase: number;

  steer: number;
  wheelAngle: number;
  roll: number;
  pitch: number;
  yawLag: number;
  accel: number;
  lastSpeed: number;

  spin: number;
  lastWheelSpin: number;
  compression: [number, number, number, number];

  squash: Spring;
  hop: Spring;
  brace: number;
  lookBack: number;
  headYaw: number;
  headPitch: number;
  headRoll: number;
  celebrate: number;
  limp: number;

  trickPhase: number;
  trickAxis: 0 | 1;
  trickDir: number;

  expression: Expression;
  exprHold: number;
  blinkIn: number;

  brakeGlow: number;
  exhaustGlow: number;

  wasGrounded: boolean;
  scarf: { points: THREE.Vector3[]; prev: THREE.Vector3[]; ready: boolean } | null;

  /** Set once the physics system is seen writing the root transform. */
  externallyDriven: boolean;
  lastWrite: THREE.Vector3;
  /** Distance to the camera, for the cheap LOD in `poseRacer`. */
  distance: number;
}

export interface RacerRig {
  id: number;
  look: RacerLook;
  root: THREE.Group;
  /** Trick rotations — a whole-body flip that must not disturb body lean. */
  trickNode: THREE.Group;
  /** Roll / pitch / squash. */
  bodyNode: THREE.Group;
  kart: KartAssembly;
  driver: DriverAssembly;
  mats: RigMaterials;
  state: PoseState;
  /** Slot in the shared contact-shadow instanced mesh. */
  shadowSlot: number;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  triangles: number;
}

export function makePoseState(id: number): PoseState {
  const rng = makeRng(`pose:${id}`);
  return {
    rng,
    phase: rng() * TAU,
    steer: 0,
    wheelAngle: 0,
    roll: 0,
    pitch: 0,
    yawLag: 0,
    accel: 0,
    lastSpeed: 0,
    spin: 0,
    lastWheelSpin: 0,
    compression: [0.5, 0.5, 0.5, 0.5],
    squash: new Spring(1, 220, 15),
    hop: new Spring(0, 150, 13),
    brace: 0,
    lookBack: 0,
    headYaw: 0,
    headPitch: 0,
    headRoll: 0,
    celebrate: 0,
    limp: 0,
    trickPhase: 0,
    trickAxis: 0,
    trickDir: 1,
    expression: "neutral",
    exprHold: 0,
    blinkIn: 1 + rng() * 3,
    brakeGlow: 0,
    exhaustGlow: 0,
    wasGrounded: true,
    scarf: null,
    externallyDriven: false,
    lastWrite: new THREE.Vector3(NaN, NaN, NaN),
    distance: 0,
  };
}

// ---------------------------------------------------------------------------
// Scratch — one set for the whole field, allocated once
// ---------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qs = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _axisX = new THREE.Vector3(1, 0, 0);
const _axisY = new THREE.Vector3(0, 1, 0);
const _wrist = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _restUpper = new THREE.Vector3();
const _restFore = new THREE.Vector3();
const _newUpper = new THREE.Vector3();
const _newFore = new THREE.Vector3();

/**
 * Analytic two-bone IK. Given a shoulder, a target and a pole direction, place
 * the elbow on the circle of valid solutions nearest the pole. The clamp on `d`
 * is what stops the arm popping inside out when the target is out of reach —
 * which happens every time the steering wheel goes to full lock.
 */
function solveTwoBone(
  shoulder: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  l1: number,
  l2: number,
  out: THREE.Vector3,
): void {
  _dir.copy(target).sub(shoulder);
  let d = _dir.length();
  if (d < 1e-5) {
    _dir.set(0, 0, -1);
    d = 1e-5;
  }
  _dir.divideScalar(d);
  d = clamp(d, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const a = Math.acos(cosA);
  _perp.copy(pole).addScaledVector(_dir, -pole.dot(_dir));
  if (_perp.lengthSq() < 1e-8) _perp.set(0, -1, 0).addScaledVector(_dir, -_dir.y * -1);
  _perp.normalize();
  out.copy(shoulder).addScaledVector(_dir, Math.cos(a) * l1).addScaledVector(_perp, Math.sin(a) * l1);
}

// ---------------------------------------------------------------------------
// Expression
// ---------------------------------------------------------------------------

function pickExpression(racer: RacerState, st: PoseState, dt: number): Expression {
  if (st.exprHold > 0) st.exprHold -= dt;

  if (racer.stun > 0) {
    return racer.stunKind === "shock" ? "shock" : "hurt";
  }
  if (racer.finished) return "cheer";
  if (racer.airTime > 0.25 || racer.trick > 0.02) return "cheer";
  if (racer.boost > 0.05) return "strain";
  if (racer.drifting && racer.driftCharge > 0.45) return "focus";
  if (racer.drifting) return "focus";
  if (racer.star > 0) return "cheer";

  // Idle: blink on a per-racer schedule, and let the leader look pleased with
  // themselves. Small thing; it is also the only reason to look at second place.
  st.blinkIn -= dt;
  if (st.blinkIn <= 0) {
    st.blinkIn = 1.8 + st.rng() * 3.4;
    st.exprHold = 0.1;
    return "blink";
  }
  if (st.exprHold > 0 && st.expression === "blink") return "blink";
  return racer.place === 1 ? "smile" : "neutral";
}

// ---------------------------------------------------------------------------
// The pose
// ---------------------------------------------------------------------------

export interface PoseContext {
  camera: THREE.Camera;
  elapsed: number;
  /** Player input, when this racer is the player. Null for the AI. */
  brake: number;
  accelInput: number;
  lookBack: boolean;
}

export function poseRacer(rig: RacerRig, racer: RacerState, dt: number, pc: PoseContext): void {
  const st = rig.state;
  const kart = rig.kart;
  const feel = WEIGHT_FEEL[rig.look.preset.weight];
  const step = Math.max(1e-4, Math.min(dt, 1 / 20));

  // -- root transform --------------------------------------------------------

  // Physics owns this. But if nothing is writing it we must, or a rig that
  // booted without a physics system sits in a heap at the origin. The check is
  // one vector compare: if the root moved to somewhere we did not put it, we
  // hand ownership over permanently.
  if (!st.externallyDriven) {
    if (Number.isFinite(st.lastWrite.x) && !rig.root.position.equals(st.lastWrite)) {
      st.externallyDriven = true;
    } else {
      rig.root.position.copy(racer.position);
      rig.root.quaternion.copy(racer.quaternion);
      st.lastWrite.copy(rig.root.position);
    }
  }

  st.distance = rig.root.position.distanceTo(pc.camera.position);
  const near = st.distance < 40;

  // -- derived signals -------------------------------------------------------

  const speed = racer.speed;
  const speed01 = clamp01(Math.abs(speed) / TUNING.topSpeed);
  const rawAccel = (speed - st.lastSpeed) / step;
  st.lastSpeed = speed;
  st.accel = damp(st.accel, clamp(rawAccel, -60, 60), 9, step);

  const braking = racer.isPlayer ? pc.brake : clamp01(-st.accel / 14);
  st.brakeGlow = damp(st.brakeGlow, clamp01(braking * 1.2 + (racer.stun > 0 ? 0.5 : 0)), 14, step);
  // Exhaust heat follows rpm but lags it: an engine glows *after* the throttle,
  // not with it.
  const rpm = racer.rpm > 0 ? racer.rpm : speed01;
  st.exhaustGlow = damp(st.exhaustGlow, rpm * 0.8 + (racer.boost > 0 ? 1.1 : 0), 6, step);

  st.steer = damp(st.steer, racer.steerAngle, 16, step);
  // The steering wheel turns rather more than the road wheels do, and keeps
  // turning after they stop — that overshoot is most of the character in a
  // driver's hands.
  st.wheelAngle = damp(st.wheelAngle, racer.steerAngle * 2.6 + (racer.drifting ? racer.driftDir * 0.35 : 0), 11, step);

  // -- wheels ----------------------------------------------------------------

  const rollTarget =
    racer.bodyRoll * feel.lean +
    (racer.drifting ? -racer.driftDir * 0.1 : 0) +
    clamp(-racer.yawRate * speed01 * 0.06, -0.16, 0.16);
  st.roll = damp(st.roll, rollTarget, 10, step);

  // Squat under power, dive under brakes. The asymmetry is deliberate: braking
  // pitch is roughly half again as strong as acceleration squat, which is what
  // a real vehicle does and what makes a stop feel like it cost something.
  const pitchTarget = clamp(st.accel * (st.accel > 0 ? 0.0075 : 0.011), -0.1, 0.09) * feel.lean;
  st.pitch = damp(st.pitch, pitchTarget + (racer.grounded ? 0 : -0.05), 8, step);

  const travel = 0.13 * feel.travel;
  const rollSin = Math.sin(st.roll);
  for (let i = 0; i < 4; i++) {
    const w = kart.wheels[i];
    const src = racer.wheelCompression?.[i];
    const target = Number.isFinite(src) ? clamp01(src as number) : 0.5;
    st.compression[i] = damp(st.compression[i], target, 22, step);

    // Suspension travel, plus a partial counter to the body roll so the tyres
    // stay near the tarmac while the chassis still visibly leans.
    let hubY = w.y + (st.compression[i] - 0.5) * travel - w.x * rollSin * 0.7;
    if (!racer.grounded) hubY -= travel * 0.35 * smoothstep(0, 0.35, racer.airTime);

    _q.identity();
    if (w.front) {
      // +yaw is left in a -Z-forward frame, so steering right is a negative
      // rotation about Y.
      _q.setFromAxisAngle(_axisY, -st.steer);
    }
    _q2.setFromAxisAngle(_axisX, -st.spin);
    _q.multiply(_q2);

    _v.set(w.x, hubY, w.z);
    const rs = w.radius / 0.36;
    _scale.set(w.width / 0.32, rs, rs);
    _m.compose(_v, _q, _scale);
    kart.tyres.setMatrixAt(i, _m);
    kart.rims.setMatrixAt(i, _m);
    kart.hubs?.setMatrixAt(i, _m);
  }
  kart.tyres.instanceMatrix.needsUpdate = true;
  kart.rims.instanceMatrix.needsUpdate = true;
  if (kart.hubs) kart.hubs.instanceMatrix.needsUpdate = true;

  // Wheel spin. Prefer the physics value, but if it is not moving while the
  // kart is, integrate our own — a locked wheel on a moving kart is the single
  // most obvious "this is a demo" tell there is.
  if (racer.wheelSpin !== st.lastWheelSpin) {
    st.spin = racer.wheelSpin;
    st.lastWheelSpin = racer.wheelSpin;
  } else {
    st.spin += (speed / Math.max(0.05, kart.wheels[2].radius)) * step;
  }
  if (st.spin > 1e6 || st.spin < -1e6) st.spin = 0;

  // -- body ------------------------------------------------------------------

  // Landing: a spring impulse proportional to how long the kart was in the air.
  if (racer.grounded && !st.wasGrounded) {
    const impact = clamp01(racer.airTime * 1.8);
    st.squash.impulse(-3.2 * impact * feel.travel);
    st.hop.impulse(-0.5 * impact);
  }
  st.wasGrounded = racer.grounded;

  const squashTarget = racer.stunKind === "squash" && racer.stun > 0 ? 0.42 : 1;
  const sq = st.squash.step(squashTarget, step);
  const hopY = st.hop.step(0, step);

  const body = rig.bodyNode;
  const idle = Math.sin(pc.elapsed * 2.1 + st.phase) * 0.006 * feel.bob;
  const rumble = racer.grounded ? Math.sin(pc.elapsed * 41 + st.phase) * speed01 * 0.004 : 0;
  body.position.set(0, hopY * 0.12 + idle + rumble, 0);
  body.rotation.set(st.pitch, 0, st.roll);
  // Volume-preserving squash: flatten and spread, never just flatten.
  const spread = 1 / Math.sqrt(Math.max(0.2, sq));
  body.scale.set(spread, sq, spread);

  // Shock: a fast lateral jitter that reads as electricity without touching
  // the physics transform.
  if (racer.stun > 0 && racer.stunKind === "shock") {
    body.position.x += Math.sin(pc.elapsed * 71) * 0.03;
    body.position.y += Math.sin(pc.elapsed * 83) * 0.02;
  }

  // -- trick -----------------------------------------------------------------

  const trick = clamp01(racer.trick);
  if (trick > 0.01 && st.trickPhase <= 0.01) {
    // Pick the flavour once, at the start of the trick.
    st.trickAxis = st.rng() > 0.45 ? 0 : 1;
    st.trickDir = racer.steerAngle !== 0 ? Math.sign(racer.steerAngle) : st.rng() > 0.5 ? 1 : -1;
  }
  st.trickPhase = trick;
  const tn = rig.trickNode;
  if (trick > 0.001) {
    const e = easeInOutCubic(trick);
    const a = e * TAU * st.trickDir;
    if (st.trickAxis === 0) tn.rotation.set(0, 0, a);
    else tn.rotation.set(-a, 0, 0);
    // A pop out of the seat at the apex sells the height far better than the
    // rotation alone does.
    tn.position.y = hump(trick) * 0.16;
  } else if (tn.rotation.x !== 0 || tn.rotation.z !== 0 || tn.position.y !== 0) {
    tn.rotation.set(0, 0, 0);
    tn.position.y = 0;
  }

  // -- driver ----------------------------------------------------------------

  const driver = rig.driver;
  const torso = driver.torso;

  st.limp = damp(st.limp, racer.stun > 0 && racer.stunKind !== "shock" ? 1 : 0, racer.stun > 0 ? 14 : 6, step);
  st.celebrate = damp(st.celebrate, racer.finished ? 1 : 0, 5, step);
  st.brace = damp(st.brace, racer.drifting ? 1 : racer.boost > 0 ? 0.55 : 0, 8, step);

  // The driver counter-leans: the chassis rolls out, the body stays upright and
  // then some. Real riders do it, and it doubles the apparent lean of the kart.
  const lean = -st.roll * 0.55 - st.limp * 0.5;
  torso.rotation.set(
    st.pitch * -0.6 + st.brace * 0.16 + st.limp * 0.5 + st.celebrate * -0.14,
    st.steer * 0.14,
    lean,
  );
  torso.position.set(0, -st.brace * 0.025 - st.limp * 0.03 + st.celebrate * Math.abs(Math.sin(pc.elapsed * 7)) * 0.035, 0);

  // Head. Turns into the corner, lifts under acceleration, snaps right around
  // on look-back and lolls when stunned.
  const lookBackTarget = (racer.isPlayer && pc.lookBack ? 1 : 0) * (1 - st.limp);
  st.lookBack = damp(st.lookBack, lookBackTarget, 12, step);
  const headYawTarget =
    -st.steer * 0.55 - racer.yawRate * 0.06 + st.lookBack * 2.5 * (racer.driftDir || 1) + st.limp * 0.6;
  st.headYaw = dampAngle(st.headYaw, headYawTarget, 13, step);
  st.headPitch = damp(
    st.headPitch,
    -st.pitch * 0.4 + st.celebrate * -0.3 + st.limp * 0.45 + (racer.airTime > 0.2 ? -0.15 : 0),
    10,
    step,
  );
  st.headRoll = damp(st.headRoll, st.roll * 0.25 + st.limp * 0.4, 10, step);
  driver.head.rotation.set(st.headPitch, st.headYaw, st.headRoll);

  // Steering wheel and hands.
  kart.steering.rotation.z = -st.wheelAngle;

  if (near || racer.isPlayer) {
    poseHands(rig, st, pc);
  }

  // -- face ------------------------------------------------------------------

  const expr = pickExpression(racer, st, step);
  if (expr !== st.expression) {
    st.expression = expr;
    const off = faceOffset(expr);
    rig.mats.headTexture.offset.set(off.x, off.y);
  }

  // -- lights ----------------------------------------------------------------

  const mats = rig.mats;
  mats.brake.emissiveIntensity = 0.55 + st.brakeGlow * 3.4;
  // Idle flicker on the exhaust: combustion is not a dimmer switch.
  const flick = 0.85 + Math.sin(pc.elapsed * 37 + st.phase) * 0.1 + Math.sin(pc.elapsed * 61.7) * 0.05;
  mats.exhaust.emissiveIntensity = st.exhaustGlow * flick * 1.6;
  mats.headlight.emissiveIntensity = 0.5 + speed01 * 0.35;

  // -- scarf -----------------------------------------------------------------

  if (driver.scarf && near) {
    driver.scarf.mesh.visible = true;
    simulateScarf(rig, racer, step, pc);
  } else if (driver.scarf) {
    driver.scarf.mesh.visible = false;
  }

  // Cheap LOD: the contrast pass is sub-pixel detail past ~45 m and there are
  // seven other karts on screen competing for the same milliseconds.
  if (driver.detail) driver.detail.visible = st.distance < 55;
}

// ---------------------------------------------------------------------------
// Hands
// ---------------------------------------------------------------------------

function poseHands(rig: RacerRig, st: PoseState, pc: PoseContext): void {
  const driver = rig.driver;
  const kart = rig.kart;
  const arms = driver.arms;

  // The steering wheel's axis, in driver space. Both objects hang off the same
  // parent chain with no rotation between them, so the node's local Z rotated
  // by its own euler is all we need.
  _v3.set(0, 0, 1).applyEuler(kart.steering.rotation);
  const centreX = kart.steering.position.x - kart.seat.position.x;
  const centreY = kart.steering.position.y - kart.seat.position.y;
  const centreZ = kart.steering.position.z - kart.seat.position.z;

  for (let i = 0; i < arms.rest.length; i++) {
    const rest = arms.rest[i];
    const side = Math.sign(rest.shoulder.x) || (i === 0 ? -1 : 1);
    const bone = arms.bones[i];

    // Target wrist: the rest grip point, carried around the wheel.
    _wrist.set(rest.wrist.x - centreX, rest.wrist.y - centreY, rest.wrist.z - centreZ);
    _qs.setFromAxisAngle(_v3, -st.wheelAngle);
    _wrist.applyQuaternion(_qs);
    _wrist.set(_wrist.x + centreX, _wrist.y + centreY, _wrist.z + centreZ);

    if (st.celebrate > 0.01) {
      // One fist in the air, the other still on the wheel — a two-handed
      // celebration looks like surrender.
      const raise = side > 0 ? st.celebrate : st.celebrate * 0.25;
      _v.set(rest.shoulder.x + side * 0.22, rest.shoulder.y + 0.46, rest.shoulder.z + 0.12);
      _v.y += Math.sin(pc.elapsed * 8) * 0.05 * raise;
      _wrist.lerp(_v, raise);
    }
    if (st.limp > 0.01) {
      // Hands off, arms hanging and swinging with the spin.
      _v.set(
        rest.shoulder.x + side * (0.12 + Math.sin(pc.elapsed * 9 + side) * 0.06),
        rest.shoulder.y - 0.3,
        rest.shoulder.z + 0.08 + Math.cos(pc.elapsed * 7.5 + side) * 0.05,
      );
      _wrist.lerp(_v, st.limp);
    }

    const l1 = rest.shoulder.distanceTo(rest.elbow);
    const l2 = rest.elbow.distanceTo(rest.wrist);
    // Pole: outboard, down and a little back, so the elbow always breaks the
    // way a human elbow does no matter where the hand goes.
    _pole.set(side * 0.9, -0.5, 0.35).normalize();
    solveTwoBone(rest.shoulder, _wrist, _pole, l1, l2, _elbow);

    _restUpper.copy(rest.elbow).sub(rest.shoulder).normalize();
    _restFore.copy(rest.wrist).sub(rest.elbow).normalize();
    _newUpper.copy(_elbow).sub(rest.shoulder).normalize();
    _newFore.copy(_wrist).sub(_elbow).normalize();

    bone.upper.rotation.setFromUnitVectors(_restUpper, _newUpper);
    // The forearm rotation is authored in rest space and composed *after* the
    // upper bone, so the target direction has to be pulled back through it.
    _q2.copy(bone.upper.rotation).invert();
    _v2.copy(_newFore).applyQuaternion(_q2);
    bone.fore.rotation.setFromUnitVectors(_restFore, _v2);
  }

  poseArms(driver);
}

// ---------------------------------------------------------------------------
// Scarf
// ---------------------------------------------------------------------------

const _anchor = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _drape = new THREE.Vector3();

/**
 * Verlet chain in world space, projected back into the racer's local frame for
 * drawing. World space is the whole trick: the scarf inherits the kart's motion
 * for free, so it streams out behind a boost and settles on the grid without a
 * single special case.
 */
function simulateScarf(rig: RacerRig, racer: RacerState, dt: number, pc: PoseContext): void {
  const sc = rig.driver.scarf;
  if (!sc) return;
  const st = rig.state;

  rig.root.updateMatrixWorld(true);
  _anchor.copy(sc.anchor);
  rig.driver.head.localToWorld(_anchor);

  const n = sc.segments;
  const segLen = sc.length / n;

  if (!st.scarf || !st.scarf.ready) {
    const points: THREE.Vector3[] = [];
    const prev: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const p = _anchor.clone();
      p.y -= i * segLen * 0.3;
      p.z += i * segLen * 0.9;
      points.push(p);
      prev.push(p.clone());
    }
    st.scarf = { points, prev, ready: true };
  }
  const { points, prev } = st.scarf;

  // Apparent wind: the kart's own velocity, plus a little turbulence that
  // scales with speed so a stationary scarf hangs dead still.
  const sp = Math.min(1, Math.abs(racer.speed) / TUNING.topSpeed);
  // Enough drag to stream it backwards, not so much that it goes bar-taut and
  // reads as a plank. The vertical term must stay well under the drag term or
  // the scarf stands on end instead of trailing.
  _wind.copy(racer.velocity).multiplyScalar(-0.6);
  _wind.y += 1.6 * sp + Math.sin(pc.elapsed * 6.3 + st.phase) * 3.4 * sp;
  _wind.x += Math.sin(pc.elapsed * 4.1 + st.phase * 2) * 3.0 * sp;

  // A parked kart has no apparent wind, so gravity is the only force in the
  // integrator — and a two-metre scarf anchored at the neck then hangs dead
  // straight down through the driver's lap, the chassis floor and the road.
  // Every kart on the starting grid wore a white plank. Drape it over the
  // seat back instead, fading out as real wind takes over.
  _drape.set(0, 0, 1).applyQuaternion(racer.quaternion).multiplyScalar(7.5 * (1 - sp));
  _wind.add(_drape);

  // Gravity a little over half real: enough that the tail droops into a curve
  // rather than streaming out as a rigid pole, not so much that it drags.
  const g = -TUNING.gravity * 0.55;
  const damping = 0.965;
  points[0].copy(_anchor);
  prev[0].copy(_anchor);
  for (let i = 1; i <= n; i++) {
    const p = points[i];
    const q = prev[i];
    _delta.copy(p).sub(q).multiplyScalar(damping);
    q.copy(p);
    p.add(_delta);
    p.y += g * dt * dt;
    p.addScaledVector(_wind, dt * dt * (0.6 + i / n));
  }
  // Nothing in a Verlet chain knows the world is solid, so the cloth needs a
  // floor. The kart's wheels rest a suspension length below its origin, which
  // is the same ground estimate the contact-shadow blob uses and is right on
  // every surface the kart can actually be standing on.
  const floorY = racer.position.y - TUNING.suspensionRest + 0.06;

  // Two constraint passes: enough for a scarf, cheap enough for eight of them.
  for (let pass = 0; pass < 2; pass++) {
    points[0].copy(_anchor);
    for (let i = 1; i <= n; i++) {
      _delta.copy(points[i]).sub(points[i - 1]);
      const d = _delta.length();
      if (d < 1e-6) continue;
      const corr = (d - segLen) / d;
      // The anchor end is immovable, so the whole correction goes downstream.
      points[i].addScaledVector(_delta, -corr * (i === 1 ? 1 : 0.62));
      if (i > 1) points[i - 1].addScaledVector(_delta, corr * 0.38);
    }
    // Re-applied every pass: a length constraint would happily push the tail
    // back under the road again.
    for (let i = 1; i <= n; i++) {
      if (points[i].y < floorY) points[i].y = floorY;
    }
  }

  // Into the mesh's frame. The mesh hangs off the racer root, so this is one
  // inverse per point and no extra scene-graph nodes.
  const local: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) local.push(rig.root.worldToLocal(points[i].clone()));
  // The ribbon's "up" is the racer's own up, so the cloth banks with the kart
  // instead of staying stubbornly world-vertical through a banked corner.
  _up.set(0, 1, 0);
  const width = (sc.mesh.userData.width as number | undefined) ?? 0.2;
  sc.ribbon.update(local, _up, (t) => width * (1 - t * 0.55) * (0.6 + 0.4 * Math.sin(t * Math.PI)));
}

export type { Expression };
