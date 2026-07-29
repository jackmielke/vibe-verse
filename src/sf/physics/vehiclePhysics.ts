/**
 * vehiclePhysics.ts — cars, trucks, the cable car, boats and helicopters.
 *
 * The chassis is Rapier's `DynamicRayCastVehicleController`: four suspension
 * raycasts, per-wheel friction, forces applied to one rigid body. That gets you
 * a vehicle that stays upright and drives. It does not get you a vehicle that
 * *feels* like anything, because its friction model is a constant coefficient
 * and its "engine force" is a number you make up.
 *
 * So this module drives it from a real drivetrain and a real tyre model:
 *
 *   • an engine torque curve with idle, peak and a redline taper;
 *   • a gearbox with ratios, a final drive and a torque-cut shift delay;
 *   • per-wheel load from the actual suspension force Rapier computed, so
 *     weight transfer under braking and cornering is measured, not guessed;
 *   • a Pacejka-style magic-formula lateral tyre curve, so grip builds, peaks
 *     around 7° of slip and then falls away — which is the whole reason a car
 *     can be drifted rather than merely steered;
 *   • load-sensitive grip (a tyre carrying twice the load does not make twice
 *     the force), which is what makes weight transfer matter at all;
 *   • anti-roll bars, aero drag and downforce.
 *
 * Also here, because they share the same fixed-step plumbing:
 *   • `Buoyancy` — multi-probe hull flotation for boats, with an injectable
 *     water-height sampler so the Gerstner wave surface can drive it;
 *   • `Helicopter` — collective/cyclic/tail-rotor flight with ground effect
 *     and autorotation.
 *
 * Coordinate convention: vehicle local forward is **-Z** (three.js), right is
 * +X, up is +Y. Rapier's forward axis index is 2 with an implied +Z, so every
 * engine/brake force here carries `FORWARD_SIGN`.
 */
import type * as RAPIER from "@dimforge/rapier3d-compat";
import { VEHICLE } from "../config";
import { WORLD } from "../geo/sfGeo";
import { clamp01 } from "../math/rng";
import { makeRayHit, raycast, type RayHit } from "./raycast";
import {
  FILTER,
  GROUP,
  interactionGroups,
  onFixedStep,
  physics,
  rapier,
  registerObject,
  unregisterObject,
  type PhysicsObject,
} from "./world";

/** Vehicle local forward is -Z; Rapier's forward axis index 2 implies +Z. */
const FORWARD_SIGN = -1;
/** Air density at sea level, kg/m³. San Francisco is at sea level. */
const RHO_AIR = 1.225;
const RHO_WATER = 1025;
const G = 9.81;

/** What the wheels are allowed to find. */
const WHEEL_QUERY = interactionGroups(
  GROUP.VEHICLE,
  GROUP.TERRAIN | GROUP.BUILDING | GROUP.PROP,
);

/* ------------------------------------------------------------------ *
 * Scratch
 * ------------------------------------------------------------------ */

const _v = { x: 0, y: 0, z: 0 };
const _v2 = { x: 0, y: 0, z: 0 };
const _q = { x: 0, y: 0, z: 0, w: 1 };
const _axis = { x: 0, y: 0, z: 0 };
const _dir = { x: 0, y: -1, z: 0 };
const _basis = new Float64Array(9); // right, up, forward as world vectors
const _hit: RayHit = makeRayHit();

function rotateVec(
  q: { x: number; y: number; z: number; w: number },
  vx: number, vy: number, vz: number,
  out: Float64Array, off: number,
): void {
  const tx = 2 * (q.y * vz - q.z * vy);
  const ty = 2 * (q.z * vx - q.x * vz);
  const tz = 2 * (q.x * vy - q.y * vx);
  out[off] = vx + q.w * tx + q.y * tz - q.z * ty;
  out[off + 1] = vy + q.w * ty + q.z * tx - q.x * tz;
  out[off + 2] = vz + q.w * tz + q.x * ty - q.y * tx;
}

/* ================================================================== *
 * Specs
 * ================================================================== */

export interface WheelSpec {
  /** Suspension hard point in chassis local space. */
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Visual half width, metres. Not used by the solver. */
  width: number;
  steered: boolean;
  powered: boolean;
  /** 0..1 share of the brake torque this wheel takes. */
  brakeBias: number;
  /** Handbrake acts on this wheel. */
  handbrake: boolean;
  /** Per-wheel suspension overrides. */
  restLength?: number;
  stiffness?: number;
  /** Extra grip multiplier — rear-biased tyres, a truck's duals. */
  gripScale?: number;
}

export interface VehicleSpec {
  /** Kerb mass, kg. */
  mass: number;
  /** Chassis collider half extents. */
  hx: number;
  hy: number;
  hz: number;
  /** Centre of mass offset from the collider centre. Lower = harder to roll. */
  comY: number;
  comZ?: number;

  wheels: WheelSpec[];

  /** Peak engine torque, N·m, and the rpm it happens at. */
  peakTorque: number;
  peakTorqueRpm: number;
  idleRpm: number;
  redlineRpm: number;
  /** Forward gear ratios, low to high. */
  gearRatios: number[];
  reverseRatio: number;
  finalDrive: number;
  /** Drivetrain efficiency 0..1. */
  efficiency: number;
  /** Seconds of torque cut on a shift. */
  shiftTime: number;

  /** Max steering angle at rest, radians, and how fast it moves. */
  maxSteer: number;
  steerRate: number;
  /** Steering authority falls off with speed; this is the speed it halves at. */
  steerSpeedFalloff: number;

  /** Total brake torque, N·m, and the handbrake's. */
  brakeTorque: number;
  handbrakeTorque: number;

  /** Peak tyre friction coefficient on dry asphalt. */
  tyreGrip: number;
  /** Load sensitivity: grip lost per unit of normalised extra load. */
  loadSensitivity: number;
  /** Pacejka shape factors for the lateral curve. */
  pacejkaB: number;
  pacejkaC: number;
  pacejkaE: number;

  /** Anti-roll bar rate, N per metre of suspension travel difference. */
  antiRollFront: number;
  antiRollRear: number;

  /** 0.5·ρ·Cd·A, so drag = that × v². */
  dragArea: number;
  /** 0.5·ρ·Cl·A for downforce, same convention. Positive pushes down. */
  downforceArea: number;

  /** Top speed limiter, m/s. Set from the gearing; belt and braces. */
  maxSpeed: number;
}

/** A believable mid-size sedan — the default city car. */
export const SEDAN_SPEC: VehicleSpec = {
  mass: 1480,
  hx: 0.88, hy: 0.62, hz: 2.24,
  comY: -0.28,
  comZ: 0.05,
  wheels: [
    { x: -0.78, y: -0.34, z: -1.42, radius: 0.34, width: 0.22, steered: true, powered: false, brakeBias: 0.32, handbrake: false },
    { x: 0.78, y: -0.34, z: -1.42, radius: 0.34, width: 0.22, steered: true, powered: false, brakeBias: 0.32, handbrake: false },
    { x: -0.78, y: -0.34, z: 1.38, radius: 0.34, width: 0.24, steered: false, powered: true, brakeBias: 0.18, handbrake: true },
    { x: 0.78, y: -0.34, z: 1.38, radius: 0.34, width: 0.24, steered: false, powered: true, brakeBias: 0.18, handbrake: true },
  ],
  peakTorque: 320,
  peakTorqueRpm: 3800,
  idleRpm: 780,
  redlineRpm: 6600,
  gearRatios: [3.54, 2.05, 1.38, 1.0, 0.78, 0.63],
  reverseRatio: 3.2,
  finalDrive: 3.9,
  efficiency: 0.88,
  shiftTime: 0.22,
  maxSteer: 0.62,
  steerRate: 3.4,
  steerSpeedFalloff: 22,
  brakeTorque: 4200,
  handbrakeTorque: 2600,
  tyreGrip: 1.42,
  loadSensitivity: 0.28,
  pacejkaB: 8.6,
  pacejkaC: 1.36,
  pacejkaE: 0.92,
  antiRollFront: 22000,
  antiRollRear: 15000,
  dragArea: 0.5 * RHO_AIR * 0.31 * 2.2,
  downforceArea: 0.5 * RHO_AIR * 0.08 * 2.0,
  maxSpeed: 62,
};

/** Box truck / delivery van: heavy, tall, understeers, brakes badly. */
export const TRUCK_SPEC: VehicleSpec = {
  ...SEDAN_SPEC,
  mass: 5200,
  hx: 1.15, hy: 1.35, hz: 3.6,
  comY: -0.45,
  wheels: [
    { x: -0.98, y: -0.98, z: -2.3, radius: 0.46, width: 0.28, steered: true, powered: false, brakeBias: 0.3, handbrake: false },
    { x: 0.98, y: -0.98, z: -2.3, radius: 0.46, width: 0.28, steered: true, powered: false, brakeBias: 0.3, handbrake: false },
    { x: -0.98, y: -0.98, z: 2.1, radius: 0.46, width: 0.36, steered: false, powered: true, brakeBias: 0.2, handbrake: true, gripScale: 1.12 },
    { x: 0.98, y: -0.98, z: 2.1, radius: 0.46, width: 0.36, steered: false, powered: true, brakeBias: 0.2, handbrake: true, gripScale: 1.12 },
  ],
  peakTorque: 900,
  peakTorqueRpm: 2100,
  redlineRpm: 3400,
  gearRatios: [5.2, 3.1, 2.0, 1.4, 1.0, 0.78],
  finalDrive: 4.6,
  maxSteer: 0.46,
  brakeTorque: 9000,
  handbrakeTorque: 5200,
  tyreGrip: 1.12,
  antiRollFront: 42000,
  antiRollRear: 30000,
  dragArea: 0.5 * RHO_AIR * 0.62 * 7.4,
  downforceArea: 0,
  maxSpeed: 38,
};

/**
 * The cable car. Rail-guided in reality, but modelled as a very heavy,
 * very-low-grip four-wheeler with no steering — the traffic system pins it to
 * the track and this just keeps it upright and gives it suspension.
 */
export const CABLE_CAR_SPEC: VehicleSpec = {
  ...SEDAN_SPEC,
  mass: 7000,
  hx: 1.15, hy: 1.5, hz: 4.3,
  comY: -0.6,
  wheels: [
    { x: -0.92, y: -1.2, z: -2.7, radius: 0.34, width: 0.14, steered: false, powered: true, brakeBias: 0.25, handbrake: true },
    { x: 0.92, y: -1.2, z: -2.7, radius: 0.34, width: 0.14, steered: false, powered: true, brakeBias: 0.25, handbrake: true },
    { x: -0.92, y: -1.2, z: 2.7, radius: 0.34, width: 0.14, steered: false, powered: true, brakeBias: 0.25, handbrake: true },
    { x: 0.92, y: -1.2, z: 2.7, radius: 0.34, width: 0.14, steered: false, powered: true, brakeBias: 0.25, handbrake: true },
  ],
  peakTorque: 1400,
  peakTorqueRpm: 900,
  idleRpm: 300,
  redlineRpm: 1600,
  gearRatios: [6.0],
  finalDrive: 5.5,
  maxSteer: 0,
  brakeTorque: 16000,
  handbrakeTorque: 24000,
  tyreGrip: 0.95,
  maxSpeed: 6.5,
};

/* ================================================================== *
 * Input + telemetry
 * ================================================================== */

export interface VehicleInput {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1 (left) .. +1 (right) */
  steer: number;
  /** 0..1 */
  handbrake: number;
  /** true = reverse gear requested. */
  reverse: boolean;
}

export function makeVehicleInput(): VehicleInput {
  return { throttle: 0, brake: 0, steer: 0, handbrake: 0, reverse: false };
}

export interface WheelState {
  /** World contact point, or the hard point when airborne. */
  px: number;
  py: number;
  pz: number;
  /** Current suspension length — the renderer offsets the wheel by this. */
  suspension: number;
  /** Steering angle, radians. */
  steer: number;
  /** Accumulated spin angle, radians. */
  spin: number;
  grounded: boolean;
  /** Normalised slip 0..1+ — drives tyre smoke and screech. */
  slip: number;
  /** Normal load, newtons. */
  load: number;
}

/* ================================================================== *
 * The chassis
 * ================================================================== */

export class Vehicle {
  spec: VehicleSpec;
  body: RAPIER.RigidBody | null = null;
  collider: RAPIER.Collider | null = null;
  controller: RAPIER.DynamicRayCastVehicleController | null = null;
  object: PhysicsObject | null = null;

  readonly input: VehicleInput = makeVehicleInput();

  /** Signed forward speed, m/s. Positive = forwards. */
  speed = 0;
  rpm = 0;
  gear = 1;
  /** -1 reverse, 0 neutral, 1..n forward. */
  private shiftTimer = 0;
  private steerAngle = 0;
  /** Longitudinal/lateral acceleration for weight transfer + camera shake. */
  accelLong = 0;
  accelLat = 0;
  private lastSpeed = 0;
  private lastLatVel = 0;

  /** Engine load 0..1 for audio. */
  load = 0;
  /** Peak wheel slip this step, 0..1+ — for smoke and screech. */
  slip = 0;
  grounded = false;
  /** Wheels in contact this step. */
  wheelsDown = 0;

  readonly wheels: WheelState[] = [];

  /** Damage 0..1 degrades power and grip. Set by the damage model. */
  damage = 0;
  /** Engine cut (destroyed, EMP, out of fuel). */
  engineOn = true;

  constructor(spec: VehicleSpec) {
    this.spec = spec;
    for (let i = 0; i < spec.wheels.length; i++) {
      this.wheels.push({
        px: 0, py: 0, pz: 0,
        suspension: spec.wheels[i].restLength ?? VEHICLE.suspensionRest,
        steer: 0, spin: 0, grounded: false, slip: 0, load: 0,
      });
    }
  }

  get ready(): boolean {
    return this.controller !== null;
  }

  /** Build the rapier objects. No-ops (returns false) before boot. */
  spawn(x: number, y: number, z: number, yaw = 0): boolean {
    if (this.ready) return true;
    const r = rapier();
    const w = physics.world;
    if (!r || !w) return false;
    const s = this.spec;

    const h = yaw * 0.5;
    _q.x = 0; _q.y = Math.sin(h); _q.z = 0; _q.w = Math.cos(h);

    this.body = w.createRigidBody(
      r.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation(_q)
        // Cars are damped by their tyres, not by air; keep these low or the
        // vehicle feels like it is driving through treacle.
        .setLinearDamping(0.02)
        .setAngularDamping(0.35)
        .setCanSleep(true)
        .setCcdEnabled(true),
    );

    // Inertia tensor of a solid box, scaled up ~1.4× because a car's mass is
    // in its shell and drivetrain, not uniformly distributed. Too low and it
    // spins like a toy; too high and it refuses to turn.
    const m = s.mass;
    const ixx = (m / 12) * (4 * s.hy * s.hy + 4 * s.hz * s.hz) * 1.4;
    const iyy = (m / 12) * (4 * s.hx * s.hx + 4 * s.hz * s.hz) * 1.4;
    const izz = (m / 12) * (4 * s.hx * s.hx + 4 * s.hy * s.hy) * 1.4;
    _v.x = 0; _v.y = s.comY; _v.z = s.comZ ?? 0;
    _v2.x = ixx; _v2.y = iyy; _v2.z = izz;
    _axis.x = 0; _axis.y = 0; _axis.z = 0;

    this.collider = w.createCollider(
      r.ColliderDesc.cuboid(s.hx, s.hy, s.hz)
        .setMassProperties(m, _v, _v2, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.4)
        .setRestitution(0.08)
        .setCollisionGroups(FILTER.vehicle)
        .setActiveEvents(r.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(9000),
      this.body,
    );

    const ctrl = w.createVehicleController(this.body);
    ctrl.indexUpAxis = 1;
    ctrl.setIndexForwardAxis = 2;

    for (let i = 0; i < s.wheels.length; i++) {
      const ws = s.wheels[i];
      _v.x = ws.x; _v.y = ws.y; _v.z = ws.z;
      _dir.x = 0; _dir.y = -1; _dir.z = 0;
      _axis.x = -1; _axis.y = 0; _axis.z = 0;
      ctrl.addWheel(_v, _dir, _axis, ws.restLength ?? VEHICLE.suspensionRest, ws.radius);
      // Rapier inherits Bullet's suspension parameterisation, in which the
      // damping numbers are *not* absolute — they are meaningful only relative
      // to √stiffness. Feeding a raw damping constant in produces a car that
      // pogos for a minute after every kerb, which is exactly what you get if
      // you take the config number literally. So: derive from the stiffness
      // using Bullet's own guidance (ζ≈0.28 compressing, ≈0.48 rebounding —
      // real dampers resist extension harder than compression), and treat
      // VEHICLE.suspensionDamping as the ratio knob it actually is.
      const share = m / s.wheels.length;
      const k = ws.stiffness ?? VEHICLE.suspensionStiffness;
      const damperScale = VEHICLE.suspensionDamping / 3.1;
      const sqrtK = Math.sqrt(k);
      ctrl.setWheelSuspensionStiffness(i, k);
      ctrl.setWheelSuspensionCompression(i, 4.4 * 0.28 * sqrtK * damperScale);
      ctrl.setWheelSuspensionRelaxation(i, 4.4 * 0.48 * sqrtK * damperScale);
      ctrl.setWheelMaxSuspensionTravel(i, VEHICLE.maxSuspensionTravel);
      ctrl.setWheelMaxSuspensionForce(i, share * G * 18);
      ctrl.setWheelFrictionSlip(i, s.tyreGrip);
      ctrl.setWheelSideFrictionStiffness(i, 1);
    }
    this.controller = ctrl;

    this.object = registerObject({
      kind: "vehicle",
      body: this.body,
      colliders: [this.collider],
      surface: "thinMetal",
      ref: this,
      interpolate: true,
    });

    vehicleSystem.add(this);
    return true;
  }

  /* ---------------- the fixed step ---------------- */

  /**
   * One simulation step of the whole drivetrain.
   *
   * Order: steering → gearbox → per-wheel tyre model → engine/brake forces →
   * `updateVehicle` (which does the raycasts and applies suspension+friction)
   * → chassis-level aero and anti-roll. Anti-roll has to come *after* the
   * update because it needs this step's suspension lengths.
   */
  step(dt: number): void {
    const ctrl = this.controller;
    const body = this.body;
    if (!ctrl || !body || !body.isValid()) return;
    const s = this.spec;
    const inp = this.input;

    // Rapier reports speed along +Z; ours is -Z.
    const rawSpeed = ctrl.currentVehicleSpeed();
    this.speed = rawSpeed * FORWARD_SIGN;

    const q = body.rotation();
    rotateVec(q, 1, 0, 0, _basis, 0);                       // right
    rotateVec(q, 0, 1, 0, _basis, 3);                       // up
    rotateVec(q, 0, 0, FORWARD_SIGN, _basis, 6);            // forward

    const lin = body.linvel();
    const latVel = lin.x * _basis[0] + lin.y * _basis[1] + lin.z * _basis[2];
    this.accelLong = (this.speed - this.lastSpeed) / Math.max(dt, 1e-4);
    this.accelLat = (latVel - this.lastLatVel) / Math.max(dt, 1e-4);
    this.lastSpeed = this.speed;
    this.lastLatVel = latVel;

    /* --- steering ------------------------------------------------ */
    // Authority falls with speed: full lock at a walking pace would spin the
    // car at 30 m/s and is not what any real rack does.
    const speedFactor = 1 / (1 + Math.abs(this.speed) / s.steerSpeedFalloff);
    const targetSteer = inp.steer * s.maxSteer * speedFactor;
    const maxDelta = s.steerRate * dt;
    const dSteer = targetSteer - this.steerAngle;
    this.steerAngle += Math.max(-maxDelta, Math.min(maxDelta, dSteer));

    /* --- gearbox ------------------------------------------------- */
    this.updateGearbox(dt);

    /* --- per-wheel tyre model ------------------------------------ */
    const n = s.wheels.length;
    let poweredCount = 0;
    for (let i = 0; i < n; i++) if (s.wheels[i].powered) poweredCount++;
    if (poweredCount === 0) poweredCount = 1;

    const damageFactor = 1 - this.damage * 0.55;
    const engineTorque = this.engineOn && this.shiftTimer <= 0
      ? this.torqueAtRpm(this.rpm) * inp.throttle * damageFactor
      : 0;

    const ratio =
      this.gear === -1 ? -s.reverseRatio :
      this.gear === 0 ? 0 :
      s.gearRatios[Math.min(this.gear - 1, s.gearRatios.length - 1)];

    // Speed limiter: fold power off near the top rather than clamping velocity,
    // which would fight the solver.
    const limiter = clamp01(1 - (Math.abs(this.speed) - s.maxSpeed * 0.94) / (s.maxSpeed * 0.12));

    let peakSlip = 0;
    let down = 0;
    let totalLoad = 0;

    for (let i = 0; i < n; i++) {
      const ws = s.wheels[i];
      const state = this.wheels[i];

      ctrl.setWheelSteering(i, ws.steered ? this.steerAngle * FORWARD_SIGN : 0);
      state.steer = ws.steered ? this.steerAngle : 0;

      const contact = ctrl.wheelIsInContact(i);
      state.grounded = contact;
      if (contact) down++;

      const suspForce = ctrl.wheelSuspensionForce(i) ?? 0;
      state.load = suspForce;
      totalLoad += suspForce;

      // --- lateral slip angle -----------------------------------
      let slipNorm = 0;
      if (contact) {
        const cp = ctrl.wheelContactPoint(i);
        if (cp) {
          _v.x = cp.x; _v.y = cp.y; _v.z = cp.z;
          const pv = body.velocityAtPoint(_v);
          const vLong = pv.x * _basis[6] + pv.y * _basis[7] + pv.z * _basis[8];
          const vLat = pv.x * _basis[0] + pv.y * _basis[1] + pv.z * _basis[2];
          // +0.9 in the denominator keeps the slip angle finite at a standstill.
          const alpha = Math.atan2(vLat, Math.abs(vLong) + 0.9) - (ws.steered ? state.steer : 0);
          slipNorm = this.pacejkaSlip(alpha);
          state.slip = Math.min(2, Math.abs(alpha) / 0.14);
          if (state.slip > peakSlip) peakSlip = state.slip;
        }
      } else {
        state.slip = 0;
      }

      // --- load-sensitive friction cap ---------------------------
      // A tyre at twice its design load makes well under twice the force.
      const nominal = (s.mass * G) / n;
      const loadRatio = nominal > 1 ? suspForce / nominal : 1;
      const loadTerm = 1 - s.loadSensitivity * (loadRatio - 1);
      let mu = s.tyreGrip * Math.max(0.4, loadTerm) * (ws.gripScale ?? 1) * damageFactor;
      // Pacejka shapes the *available* lateral force against slip: full grip
      // at the peak, falling away past it. That fall-off is the drift.
      mu *= 0.45 + 0.55 * slipNorm;

      if (inp.handbrake > 0.2 && ws.handbrake) mu *= 0.55;

      ctrl.setWheelFrictionSlip(i, mu);
      ctrl.setWheelSideFrictionStiffness(i, ws.steered ? 1.0 : 0.92);

      // --- engine + brakes ---------------------------------------
      let force = 0;
      if (ws.powered && ratio !== 0) {
        force =
          (engineTorque * Math.abs(ratio) * s.finalDrive * s.efficiency) /
          (ws.radius * poweredCount);
        if (this.gear === -1) force = -force;
        force *= limiter;
      }
      ctrl.setWheelEngineForce(i, force * FORWARD_SIGN);

      let brake = inp.brake * s.brakeTorque * ws.brakeBias;
      if (ws.handbrake) brake += inp.handbrake * s.handbrakeTorque;
      // Engine braking off-throttle: without it a car coasts forever and feels
      // like it is on ice even when it is not.
      if (inp.throttle < 0.05 && ratio !== 0 && ws.powered) {
        brake += 90 * Math.abs(ratio) * s.finalDrive * clamp01(Math.abs(this.speed) / 4);
      }
      ctrl.setWheelBrake(i, brake);

      // Visual spin. Airborne wheels keep their last rate, decaying.
      if (contact) {
        state.spin += (this.speed / ws.radius) * dt;
        const cp = ctrl.wheelContactPoint(i);
        if (cp) {
          state.px = cp.x;
          state.py = cp.y;
          state.pz = cp.z;
        }
      } else {
        state.spin += (this.speed / ws.radius) * dt * 0.6;
      }
      state.suspension = ctrl.wheelSuspensionLength(i) ?? state.suspension;
    }

    this.slip = peakSlip;
    this.wheelsDown = down;
    this.grounded = down > 0;
    this.load = clamp01(inp.throttle * (0.4 + 0.6 * clamp01(this.rpm / s.redlineRpm)));

    /* --- let rapier do the raycasts and the impulses -------------- */
    const r = rapier();
    const selfCollider = this.collider;
    ctrl.updateVehicle(
      dt,
      r ? r.QueryFilterFlags.EXCLUDE_SENSORS : undefined,
      WHEEL_QUERY,
      (c) => c.handle !== selfCollider?.handle,
    );

    /* --- anti-roll bars ------------------------------------------ */
    this.applyAntiRoll(ctrl, body);

    /* --- aero ---------------------------------------------------- */
    const v = body.linvel();
    const v2 = v.x * v.x + v.y * v.y + v.z * v.z;
    if (v2 > 1) {
      const vmag = Math.sqrt(v2);
      const drag = s.dragArea * v2;
      _v.x = (-v.x / vmag) * drag;
      _v.y = (-v.y / vmag) * drag;
      _v.z = (-v.z / vmag) * drag;
      body.addForce(_v, true);

      if (s.downforceArea > 0 && down > 0) {
        const df = s.downforceArea * v2;
        _v.x = -_basis[3] * df;
        _v.y = -_basis[4] * df;
        _v.z = -_basis[5] * df;
        body.addForce(_v, true);
      }
    }

    /* --- airborne attitude damping -------------------------------- */
    // A car that has left the ground should not tumble like a die. Real jumps
    // are stabilised by aero and by the wheels' gyroscopic inertia; a small
    // angular damper standing in for both keeps landings survivable.
    if (down === 0) {
      const a = body.angvel();
      _v.x = -a.x * s.mass * 0.09;
      _v.y = -a.y * s.mass * 0.05;
      _v.z = -a.z * s.mass * 0.09;
      body.applyTorqueImpulse(_v, true);
    }
  }

  /**
   * Anti-roll bars, per axle.
   *
   * A bar transfers load from the compressed side to the extended side,
   * resisting body roll without stiffening the ride over a single bump. Two
   * equal-and-opposite forces at the hard points is exactly how a real one
   * behaves, and it is what stops a top-heavy van from rolling over every
   * corner on Lombard.
   */
  private applyAntiRoll(ctrl: RAPIER.DynamicRayCastVehicleController, body: RAPIER.RigidBody): void {
    const s = this.spec;
    const n = s.wheels.length;
    // Pair wheels by their Z (axle) position.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(s.wheels[i].z - s.wheels[j].z) > 0.35) continue;
        if (s.wheels[i].x * s.wheels[j].x >= 0) continue; // must be opposite sides
        const rate = s.wheels[i].z < 0 ? s.antiRollFront : s.antiRollRear;
        if (rate <= 0) continue;

        const li = ctrl.wheelSuspensionLength(i) ?? 0;
        const lj = ctrl.wheelSuspensionLength(j) ?? 0;
        const travel = li - lj;
        if (Math.abs(travel) < 1e-4) continue;
        const f = travel * rate;

        const hpi = ctrl.wheelHardPoint(i);
        const hpj = ctrl.wheelHardPoint(j);
        if (!hpi || !hpj) continue;

        // Push down on the extended corner, lift the compressed one.
        _v.x = _basis[3] * -f;
        _v.y = _basis[4] * -f;
        _v.z = _basis[5] * -f;
        _v2.x = hpi.x; _v2.y = hpi.y; _v2.z = hpi.z;
        body.addForceAtPoint(_v, _v2, true);

        _v.x = _basis[3] * f;
        _v.y = _basis[4] * f;
        _v.z = _basis[5] * f;
        _v2.x = hpj.x; _v2.y = hpj.y; _v2.z = hpj.z;
        body.addForceAtPoint(_v, _v2, true);
      }
    }
  }

  /**
   * Normalised lateral force from the magic formula, 0..1.
   *
   * `Fy = D·sin(C·atan(B·α − E·(B·α − atan(B·α))))`, with D folded out so the
   * result is a pure shape: 0 at zero slip, 1 at the peak (~7°), falling to
   * about 0.75 by 25°. Everything a tyre does that a constant friction
   * coefficient cannot is in that fall-off.
   */
  private pacejkaSlip(alpha: number): number {
    const s = this.spec;
    const x = Math.abs(alpha);
    const bx = s.pacejkaB * x;
    const inner = bx - s.pacejkaE * (bx - Math.atan(bx));
    const f = Math.sin(s.pacejkaC * Math.atan(inner));
    // Normalise so the peak reads 1.
    return clamp01(f / 0.9995);
  }

  /** Torque curve: idle plateau, broad peak, sharp taper past the redline. */
  private torqueAtRpm(rpm: number): number {
    const s = this.spec;
    const r = Math.max(rpm, s.idleRpm);
    if (r > s.redlineRpm) {
      // Rev limiter — cut hard, the way a real one sounds.
      return s.peakTorque * 0.12;
    }
    const spread = Math.max(1, s.redlineRpm - s.idleRpm) * 0.62;
    const t = (r - s.peakTorqueRpm) / spread;
    return s.peakTorque * Math.max(0.28, 1 - 0.62 * t * t);
  }

  private updateGearbox(dt: number): void {
    const s = this.spec;
    const inp = this.input;

    if (this.shiftTimer > 0) this.shiftTimer -= dt;

    if (inp.reverse && this.speed < 1.5) {
      this.gear = -1;
    } else if (!inp.reverse && this.gear === -1 && this.speed > -1.0) {
      this.gear = 1;
    }

    const wheelRadius = s.wheels[0].radius;
    const ratio =
      this.gear === -1 ? s.reverseRatio :
      s.gearRatios[Math.min(Math.max(this.gear, 1) - 1, s.gearRatios.length - 1)];
    const wheelOmega = Math.abs(this.speed) / Math.max(wheelRadius, 0.05);
    const rpmTarget = (wheelOmega * ratio * s.finalDrive * 60) / (2 * Math.PI);
    // Smooth: the clutch and flywheel do not let rpm step.
    const blend = 1 - Math.exp(-dt * 9);
    this.rpm += (Math.max(s.idleRpm, Math.min(s.redlineRpm * 1.04, rpmTarget)) - this.rpm) * blend;

    if (this.gear <= 0 || this.shiftTimer > 0) return;

    // Shift up near the redline under power; shift down when the engine falls
    // off the bottom of the curve.
    if (this.rpm > s.redlineRpm * 0.93 && this.gear < s.gearRatios.length && inp.throttle > 0.2) {
      this.gear++;
      this.shiftTimer = s.shiftTime;
    } else if (this.rpm < s.idleRpm + (s.peakTorqueRpm - s.idleRpm) * 0.42 && this.gear > 1) {
      this.gear--;
      this.shiftTimer = s.shiftTime * 0.6;
    }
  }

  /* ---------------- external forces ---------------- */

  applyImpulse(ix: number, iy: number, iz: number): void {
    if (!this.body) return;
    _v.x = ix; _v.y = iy; _v.z = iz;
    this.body.applyImpulse(_v, true);
  }

  /** World transform, non-interpolated. */
  pose(out: Float32Array): boolean {
    if (!this.body || !this.body.isValid()) return false;
    const t = this.body.translation();
    const q = this.body.rotation();
    out[0] = t.x; out[1] = t.y; out[2] = t.z;
    out[3] = q.x; out[4] = q.y; out[5] = q.z; out[6] = q.w;
    return true;
  }

  destroy(): void {
    vehicleSystem.remove(this);
    const w = physics.world;
    unregisterObject(this.object);
    this.object = null;
    if (w) {
      if (this.controller) {
        this.controller.free();
      }
      if (this.body && this.body.isValid()) w.removeRigidBody(this.body);
    }
    this.controller = null;
    this.body = null;
    this.collider = null;
  }
}

/* ================================================================== *
 * Buoyancy — boats, and anything that ends up in the bay
 * ================================================================== */

export type WaterHeightSampler = (x: number, z: number, time: number) => number;

let waterSampler: WaterHeightSampler | null = null;

/**
 * Hand the buoyancy solver the real wave surface.
 *
 * `Bay.tsx` evaluates a Gerstner sum on the GPU; if it exposes the same sum on
 * the CPU, wiring it in here makes boats actually ride the swell instead of a
 * flat plane. Until then everything floats on `WORLD.seaLevel`, which is
 * correct, just calm.
 */
export function setWaterHeightSampler(fn: WaterHeightSampler | null): void {
  waterSampler = fn;
}

export function waterHeightAt(x: number, z: number): number {
  return waterSampler ? waterSampler(x, z, physics.simTime) : WORLD.seaLevel;
}

export interface BuoyancyProbe {
  /** Probe position in body local space. */
  x: number;
  y: number;
  z: number;
  /** Volume this probe is responsible for, m³. */
  volume: number;
}

/**
 * Multi-probe buoyancy.
 *
 * One force at the centre of buoyancy would float a boat but never right it
 * or pitch it over a wave. A handful of probes spread over the hull gives you
 * both restoring moments for free, because a submerged bow probe pushes up
 * harder than a raised stern probe. Four is enough for a skiff, eight for a
 * ferry.
 */
export class Buoyancy {
  probes: BuoyancyProbe[];
  /** Vertical extent each probe integrates over, metres. */
  probeHeight: number;
  /** Quadratic drag through water, per m/s². */
  linearDrag: number;
  angularDrag: number;
  /** 0..1 submerged fraction from the last step. */
  submerged = 0;

  constructor(probes: BuoyancyProbe[], probeHeight = 0.6, linearDrag = 18, angularDrag = 260) {
    this.probes = probes;
    this.probeHeight = probeHeight;
    this.linearDrag = linearDrag;
    this.angularDrag = angularDrag;
  }

  /** Apply flotation + drag for one fixed step. */
  step(body: RAPIER.RigidBody, dt: number): void {
    if (!body || !body.isValid()) return;
    const t = body.translation();
    const q = body.rotation();

    let wet = 0;
    for (let i = 0; i < this.probes.length; i++) {
      const p = this.probes[i];
      rotateVec(q, p.x, p.y, p.z, _basis, 0);
      const wx = t.x + _basis[0];
      const wy = t.y + _basis[1];
      const wz = t.z + _basis[2];

      const surface = waterHeightAt(wx, wz);
      const depth = surface - wy;
      if (depth <= 0) continue;

      // Smooth the transition over `probeHeight` so a probe crossing the
      // surface does not deliver a step change in force (which reads as a slap).
      const frac = clamp01(depth / this.probeHeight);
      wet += frac;

      const displaced = p.volume * frac;
      const lift = RHO_WATER * G * displaced;

      _v.x = 0; _v.y = lift; _v.z = 0;
      _v2.x = wx; _v2.y = wy; _v2.z = wz;
      body.addForceAtPoint(_v, _v2, true);

      // Local drag at the probe: the part that damps pitch and roll.
      const pv = body.velocityAtPoint(_v2);
      const drag = this.linearDrag * frac;
      _v.x = -pv.x * Math.abs(pv.x) * drag * 0.08 - pv.x * drag;
      _v.y = -pv.y * Math.abs(pv.y) * drag * 0.14 - pv.y * drag;
      _v.z = -pv.z * Math.abs(pv.z) * drag * 0.08 - pv.z * drag;
      body.addForceAtPoint(_v, _v2, true);
    }

    this.submerged = this.probes.length ? wet / this.probes.length : 0;

    if (this.submerged > 0.01) {
      const a = body.angvel();
      const k = this.angularDrag * this.submerged * dt;
      _v.x = -a.x * k;
      _v.y = -a.y * k;
      _v.z = -a.z * k;
      body.applyTorqueImpulse(_v, true);
    }
  }
}

export interface BoatInput {
  /** -1..1 */
  throttle: number;
  /** -1..1 */
  rudder: number;
}

/** A powered hull: buoyancy plus a propeller and a rudder at the stern. */
export class Boat {
  body: RAPIER.RigidBody | null = null;
  collider: RAPIER.Collider | null = null;
  object: PhysicsObject | null = null;
  buoyancy: Buoyancy;
  readonly input: BoatInput = { throttle: 0, rudder: 0 };

  /** Peak propeller thrust, newtons. */
  thrust: number;
  /** Rudder authority, N·m per unit of rudder at 1 m/s. */
  rudderPower: number;
  /** Stern offset where thrust is applied, local space. */
  private sternZ: number;

  constructor(
    private hx: number,
    private hy: number,
    private hz: number,
    private mass: number,
    thrust = 26000,
    rudderPower = 9000,
  ) {
    this.thrust = thrust;
    this.rudderPower = rudderPower;
    this.sternZ = hz * 0.86;
    // Probe grid across the hull. Total volume is sized so the boat sits with
    // roughly a third of its depth under water at rest.
    const probes: BuoyancyProbe[] = [];
    const totalVolume = (mass / RHO_WATER) * 3.1;
    const grid: [number, number][] = [
      [-0.6, -0.75], [0.6, -0.75],
      [-0.7, -0.2], [0.7, -0.2],
      [-0.7, 0.35], [0.7, 0.35],
      [-0.55, 0.85], [0.55, 0.85],
    ];
    for (const [u, v] of grid) {
      probes.push({
        x: u * hx,
        y: -hy * 0.55,
        z: v * hz,
        volume: totalVolume / grid.length,
      });
    }
    this.buoyancy = new Buoyancy(probes, hy * 0.9, 16, 320);
  }

  spawn(x: number, y: number, z: number, yaw = 0): boolean {
    const r = rapier();
    const w = physics.world;
    if (!r || !w || this.body) return !!this.body;
    const h = yaw * 0.5;
    _q.x = 0; _q.y = Math.sin(h); _q.z = 0; _q.w = Math.cos(h);
    this.body = w.createRigidBody(
      r.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation(_q)
        .setLinearDamping(0.08)
        .setAngularDamping(0.6)
        .setCanSleep(false),
    );
    _v.x = 0; _v.y = -this.hy * 0.45; _v.z = 0;
    const m = this.mass;
    _v2.x = (m / 12) * (4 * this.hy * this.hy + 4 * this.hz * this.hz);
    _v2.y = (m / 12) * (4 * this.hx * this.hx + 4 * this.hz * this.hz);
    _v2.z = (m / 12) * (4 * this.hx * this.hx + 4 * this.hy * this.hy);
    this.collider = w.createCollider(
      r.ColliderDesc.cuboid(this.hx, this.hy, this.hz)
        .setMassProperties(m, _v, _v2, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.3)
        .setRestitution(0.1)
        .setCollisionGroups(FILTER.vehicle),
      this.body,
    );
    this.object = registerObject({
      kind: "vehicle",
      body: this.body,
      colliders: [this.collider],
      surface: "metal",
      ref: this,
      interpolate: true,
    });
    vehicleSystem.addBoat(this);
    return true;
  }

  step(dt: number): void {
    const body = this.body;
    if (!body || !body.isValid()) return;
    this.buoyancy.step(body, dt);

    // No water under the propeller, no thrust. Falls out for free and stops a
    // beached boat from driving up the Embarcadero.
    const wetness = clamp01(this.buoyancy.submerged * 2.2);
    if (wetness <= 0.02) return;

    const q = body.rotation();
    rotateVec(q, 0, 0, FORWARD_SIGN, _basis, 6);
    const f = this.thrust * this.input.throttle * wetness;
    _v.x = _basis[6] * f;
    _v.y = _basis[7] * f;
    _v.z = _basis[8] * f;
    rotateVec(q, 0, 0, this.sternZ, _basis, 0);
    const t = body.translation();
    _v2.x = t.x + _basis[0];
    _v2.y = t.y + _basis[1];
    _v2.z = t.z + _basis[2];
    body.addForceAtPoint(_v, _v2, true);

    // A rudder only works with water flowing past it, so authority scales
    // with speed — which is why boats cannot turn on the spot.
    const lin = body.linvel();
    const speed = Math.hypot(lin.x, lin.y, lin.z);
    const yawTorque = -this.input.rudder * this.rudderPower * Math.min(speed, 14) * wetness;
    rotateVec(q, 0, 1, 0, _basis, 3);
    _v.x = _basis[3] * yawTorque;
    _v.y = _basis[4] * yawTorque;
    _v.z = _basis[5] * yawTorque;
    body.addTorque(_v, true);
  }

  destroy(): void {
    vehicleSystem.removeBoat(this);
    const w = physics.world;
    unregisterObject(this.object);
    this.object = null;
    if (w && this.body && this.body.isValid()) w.removeRigidBody(this.body);
    this.body = null;
    this.collider = null;
  }
}

/* ================================================================== *
 * Helicopter
 * ================================================================== */

export interface HeliInput {
  /** 0..1 — main rotor pitch. 0.5 is roughly a hover at sea level. */
  collective: number;
  /** -1..1 — nose down/up. */
  cyclicPitch: number;
  /** -1..1 — roll left/right. */
  cyclicRoll: number;
  /** -1..1 — tail rotor. */
  pedal: number;
}

export interface HeliSpec {
  mass: number;
  /** Chassis half extents. */
  hx: number;
  hy: number;
  hz: number;
  /** Main rotor radius, metres — sets the ground-effect envelope. */
  rotorRadius: number;
  /** Thrust at 100% collective and 100% rotor rpm, as a multiple of weight. */
  thrustRatio: number;
  /** Cyclic authority, N·m per unit input. */
  cyclicTorque: number;
  /** Tail rotor authority, N·m per unit input. */
  yawTorque: number;
  /** Nominal rotor rpm. */
  rotorRpm: number;
  /** Body drag coefficient, 0.5·ρ·Cd·A. */
  dragArea: number;
}

export const HELI_SPEC: HeliSpec = {
  mass: 2400,
  hx: 1.15, hy: 1.25, hz: 4.6,
  rotorRadius: 5.4,
  thrustRatio: 2.05,
  cyclicTorque: 34000,
  yawTorque: 14000,
  rotorRpm: 394,
  dragArea: 0.5 * RHO_AIR * 0.9 * 6.5,
};

/**
 * A flight model, not a flight simulator.
 *
 * Everything a player can feel is here — collective lag, translational lift,
 * ground effect, torque reaction, and autorotation — and everything they
 * cannot (blade element theory, retreating blade stall, coning) is not.
 */
export class Helicopter {
  spec: HeliSpec;
  body: RAPIER.RigidBody | null = null;
  collider: RAPIER.Collider | null = null;
  object: PhysicsObject | null = null;
  readonly input: HeliInput = { collective: 0, cyclicPitch: 0, cyclicRoll: 0, pedal: 0 };

  /** 0..1.1 — rotor speed as a fraction of nominal. The autorotation state. */
  rotorSpeed = 0;
  /** Engine running. Kill it and you are autorotating. */
  engineOn = true;
  /** Height above whatever is below, metres. -1 when nothing is. */
  altitudeAGL = -1;
  /** Ground effect multiplier applied this step, for the HUD. */
  groundEffect = 1;
  /** Smoothed collective — the rotor cannot change pitch instantly. */
  private collectiveLag = 0;
  private probeTimer = 0;

  constructor(spec: HeliSpec = HELI_SPEC) {
    this.spec = spec;
  }

  spawn(x: number, y: number, z: number, yaw = 0): boolean {
    const r = rapier();
    const w = physics.world;
    if (!r || !w || this.body) return !!this.body;
    const s = this.spec;
    const h = yaw * 0.5;
    _q.x = 0; _q.y = Math.sin(h); _q.z = 0; _q.w = Math.cos(h);
    this.body = w.createRigidBody(
      r.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation(_q)
        .setLinearDamping(0.05)
        .setAngularDamping(1.15)
        .setCanSleep(false)
        .setCcdEnabled(true),
    );
    const m = s.mass;
    _v.x = 0; _v.y = -0.35; _v.z = 0;
    _v2.x = (m / 12) * (4 * s.hy * s.hy + 4 * s.hz * s.hz);
    _v2.y = (m / 12) * (4 * s.hx * s.hx + 4 * s.hz * s.hz);
    _v2.z = (m / 12) * (4 * s.hx * s.hx + 4 * s.hy * s.hy);
    this.collider = w.createCollider(
      r.ColliderDesc.cuboid(s.hx, s.hy, s.hz)
        .setMassProperties(m, _v, _v2, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.6)
        .setRestitution(0.05)
        .setCollisionGroups(FILTER.vehicle)
        .setActiveEvents(r.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(12000),
      this.body,
    );
    this.object = registerObject({
      kind: "vehicle",
      body: this.body,
      colliders: [this.collider],
      surface: "thinMetal",
      ref: this,
      interpolate: true,
    });
    vehicleSystem.addHeli(this);
    return true;
  }

  step(dt: number): void {
    const body = this.body;
    if (!body || !body.isValid()) return;
    const s = this.spec;
    const inp = this.input;

    const q = body.rotation();
    rotateVec(q, 1, 0, 0, _basis, 0);
    rotateVec(q, 0, 1, 0, _basis, 3);
    rotateVec(q, 0, 0, FORWARD_SIGN, _basis, 6);

    const lin = body.linvel();
    const vy = lin.y;
    const horizSpeed = Math.hypot(lin.x, lin.z);

    /* --- rotor speed / autorotation ------------------------------- */
    if (this.engineOn) {
      this.rotorSpeed += (1 - this.rotorSpeed) * (1 - Math.exp(-dt * 1.6));
    } else {
      // Engine out — autorotation. Air driven *up* through the disc by the
      // descent keeps the rotor turning; the equilibrium descent rate at flat
      // pitch is around 9 m/s for a machine this size, which is where the
      // constant comes from. Pull collective and you convert stored rotor
      // energy into lift: the rpm bleeds, and if you spend it too early you
      // arrive with nothing left. That trade *is* the autorotation minigame.
      const descent = Math.max(0, -vy);
      const target = Math.min(1.12, (descent / 9) * (1 - 0.45 * this.collectiveLag));
      // Slow time constant: rotor inertia is the whole point of the manoeuvre.
      this.rotorSpeed += (target - this.rotorSpeed) * (1 - Math.exp(-dt * 0.55));
      // Direct bleed from collective pitch, on top of the equilibrium chase.
      this.rotorSpeed -= this.collectiveLag * 0.5 * this.rotorSpeed * dt;
      this.rotorSpeed = Math.max(0, Math.min(1.12, this.rotorSpeed));
    }

    /* --- collective lag ------------------------------------------ */
    this.collectiveLag += (clamp01(inp.collective) - this.collectiveLag) * (1 - Math.exp(-dt * 5.5));

    /* --- ground effect ------------------------------------------- */
    // Probe at 20 Hz, not every step: the answer changes slowly and the ray is
    // the most expensive thing in this function.
    this.probeTimer -= dt;
    if (this.probeTimer <= 0) {
      this.probeTimer = 0.05;
      const t = body.translation();
      this.altitudeAGL = raycast(t.x, t.y, t.z, 0, -1, 0, s.rotorRadius * 2.4, _hit, {
        groups: interactionGroups(GROUP.VEHICLE, GROUP.TERRAIN | GROUP.BUILDING),
        skipSurface: true,
      })
        ? _hit.distance
        : -1;
    }
    if (this.altitudeAGL >= 0) {
      // In ground effect the disc works against a cushion; thrust rises up to
      // ~18% at half a rotor radius. This is what makes a landing float.
      const h = this.altitudeAGL / s.rotorRadius;
      this.groundEffect = 1 + 0.2 * Math.exp(-h * 2.4);
    } else {
      this.groundEffect = 1;
    }

    /* --- translational lift --------------------------------------- */
    // Above ~10 m/s the disc stops recirculating its own downwash and gets
    // measurably more efficient — the "through translational lift" shudder.
    const etl = 1 + 0.16 * clamp01((horizSpeed - 6) / 12);

    /* --- thrust --------------------------------------------------- */
    const rotor = this.rotorSpeed * this.rotorSpeed; // thrust ∝ rpm²
    const hoverThrust = s.mass * G;
    const thrust =
      hoverThrust * s.thrustRatio * this.collectiveLag * rotor * this.groundEffect * etl;
    _v.x = _basis[3] * thrust;
    _v.y = _basis[4] * thrust;
    _v.z = _basis[5] * thrust;
    body.addForce(_v, true);

    /* --- cyclic --------------------------------------------------- */
    // Cyclic authority scales with rotor speed: with the rotor stopped the
    // stick does nothing, which is exactly the problem with an engine failure.
    const auth = this.rotorSpeed;
    const pitchT = -inp.cyclicPitch * s.cyclicTorque * auth;
    const rollT = -inp.cyclicRoll * s.cyclicTorque * auth;
    _v.x = _basis[0] * pitchT + _basis[6] * rollT;
    _v.y = _basis[1] * pitchT + _basis[7] * rollT;
    _v.z = _basis[2] * pitchT + _basis[8] * rollT;
    body.addTorque(_v, true);

    /* --- tail rotor and torque reaction --------------------------- */
    // The main rotor's reaction torque tries to spin the fuselage the other
    // way, proportional to the power being pulled. The pedals cancel it; a
    // tail rotor failure means you spin.
    const reaction = -this.collectiveLag * rotor * s.yawTorque * 0.42;
    const pedal = inp.pedal * s.yawTorque * auth;
    const yawT = pedal + reaction;
    _v.x = _basis[3] * yawT;
    _v.y = _basis[4] * yawT;
    _v.z = _basis[5] * yawT;
    body.addTorque(_v, true);

    /* --- drag and weathervaning ----------------------------------- */
    const v2 = lin.x * lin.x + lin.y * lin.y + lin.z * lin.z;
    if (v2 > 0.5) {
      const vmag = Math.sqrt(v2);
      const drag = s.dragArea * v2;
      _v.x = (-lin.x / vmag) * drag;
      _v.y = (-lin.y / vmag) * drag * 1.6; // the disc is a big vertical brake
      _v.z = (-lin.z / vmag) * drag;
      body.addForce(_v, true);

      // The tail boom weathervanes the nose into the relative wind above ~8 m/s.
      if (horizSpeed > 8) {
        const fdotv = (_basis[6] * lin.x + _basis[8] * lin.z) / Math.max(horizSpeed, 1e-3);
        const cross = _basis[6] * lin.z - _basis[8] * lin.x;
        const weather = -Math.sign(cross) * (1 - clamp01(fdotv)) * s.yawTorque * 0.22;
        _v.x = _basis[3] * weather;
        _v.y = _basis[4] * weather;
        _v.z = _basis[5] * weather;
        body.addTorque(_v, true);
      }
    }
  }

  destroy(): void {
    vehicleSystem.removeHeli(this);
    const w = physics.world;
    unregisterObject(this.object);
    this.object = null;
    if (w && this.body && this.body.isValid()) w.removeRigidBody(this.body);
    this.body = null;
    this.collider = null;
  }
}

/* ================================================================== *
 * The system
 * ================================================================== */

/**
 * Steps every vehicle inside the fixed timestep.
 *
 * Registering the fixed-step hook lazily on first use means importing this
 * module costs nothing, and a level with no vehicles pays nothing.
 */
class VehicleSystem {
  private cars: Vehicle[] = [];
  private boats: Boat[] = [];
  private helis: Helicopter[] = [];
  private installed = false;
  private detach: (() => void) | null = null;

  readonly stats = { cars: 0, boats: 0, helis: 0 };

  private install(): void {
    if (this.installed) return;
    this.installed = true;
    this.detach = onFixedStep((dt) => this.step(dt));
  }

  add(v: Vehicle): void {
    this.install();
    if (this.cars.indexOf(v) < 0) this.cars.push(v);
    this.stats.cars = this.cars.length;
  }
  remove(v: Vehicle): void {
    const i = this.cars.indexOf(v);
    if (i >= 0) {
      this.cars[i] = this.cars[this.cars.length - 1];
      this.cars.pop();
    }
    this.stats.cars = this.cars.length;
  }

  addBoat(b: Boat): void {
    this.install();
    if (this.boats.indexOf(b) < 0) this.boats.push(b);
    this.stats.boats = this.boats.length;
  }
  removeBoat(b: Boat): void {
    const i = this.boats.indexOf(b);
    if (i >= 0) {
      this.boats[i] = this.boats[this.boats.length - 1];
      this.boats.pop();
    }
    this.stats.boats = this.boats.length;
  }

  addHeli(h: Helicopter): void {
    this.install();
    if (this.helis.indexOf(h) < 0) this.helis.push(h);
    this.stats.helis = this.helis.length;
  }
  removeHeli(h: Helicopter): void {
    const i = this.helis.indexOf(h);
    if (i >= 0) {
      this.helis[i] = this.helis[this.helis.length - 1];
      this.helis.pop();
    }
    this.stats.helis = this.helis.length;
  }

  private step(dt: number): void {
    for (let i = 0; i < this.cars.length; i++) this.cars[i].step(dt);
    for (let i = 0; i < this.boats.length; i++) this.boats[i].step(dt);
    for (let i = 0; i < this.helis.length; i++) this.helis[i].step(dt);
  }

  dispose(): void {
    for (let i = this.cars.length - 1; i >= 0; i--) this.cars[i].destroy();
    for (let i = this.boats.length - 1; i >= 0; i--) this.boats[i].destroy();
    for (let i = this.helis.length - 1; i >= 0; i--) this.helis[i].destroy();
    this.cars.length = 0;
    this.boats.length = 0;
    this.helis.length = 0;
    if (this.detach) this.detach();
    this.detach = null;
    this.installed = false;
  }
}

export const vehicleSystem = new VehicleSystem();
