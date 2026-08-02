/**
 * The flight model.
 *
 * Six degrees of freedom, forces and moments in the body frame, semi-implicit
 * Euler at 120 Hz. No Three.js beyond the vector maths, no game logic, and no
 * knowledge that anybody is watching — which is what makes it testable, and
 * `dynamics.test.ts` next door flies it for a minute at a time and asserts
 * things a pilot would recognise.
 *
 * ## Axes, and the sign convention that nearly ate this file
 *
 * World: **+X east, +Y up, −Z north.** Body: **+X right wing, +Y up through
 * the roof, −Z out of the nose.** A heading of 090° therefore points the nose
 * down +X, which is the direction runway 09 goes.
 *
 * The aerodynamic coefficients in `airframe.ts` are written in the **standard
 * aero convention** — x forward out of the nose, y out of the right wing, z
 * down; L positive rolls right, M positive pitches up, N positive yaws right —
 * because that is the convention every number you can look up is quoted in,
 * and silently redefining them is how you end up with a stability derivative
 * that is "obviously" stable and is in fact positive feedback.
 *
 * Three.js body axes are not that frame. Converting between them costs exactly
 * two sign flips, done once, in `momentsToBodyTorque` below:
 *
 *     τ_bodyX = +M     (body +X is the right wing, and +M is nose up)
 *     τ_bodyY = −N     (body +Y is up, and a positive rotation about it is
 *                       nose *left*, while +N is nose right)
 *     τ_bodyZ = −L     (body −Z is the nose, so a positive roll-right is a
 *                       negative rotation about body +Z)
 *
 * Every rate fed back into a damping term is converted the same way, in
 * `standardRates`. Both are three lines long and both are the reason the
 * Dutch roll damps instead of diverging.
 *
 * ## The other thing worth reading twice
 *
 * Lift is not applied "up". It is applied perpendicular to the *relative
 * wind*, in the plane containing the wind and the aeroplane's own up axis,
 * computed by projecting body-up onto the plane normal to the velocity and
 * normalising. An aeroplane whose lift acts along body-up flies almost
 * correctly in level flight, descends slightly wrong, and cannot be trimmed at
 * all in a steep turn — and it takes a long time to find, because every
 * individual frame looks fine.
 */
import * as THREE from "three";
import { AERO, AIRFRAME } from "./airframe";
import {
  RHO_SL,
  densityAt,
  indicatedFrom,
  soundSpeedAt,
  thrustLapse,
} from "./atmosphere";
import { FLAP_DETENTS, type FlightState, type GearState } from "../types";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => clamp(v, 0, 1);

/** One frame of pilot input, as the flight model wants it. */
export interface ControlInput {
  /** −1 yoke full forward .. +1 yoke full aft. A yoke position, not a surface angle. */
  pitch: number;
  /** −1 wheel left .. +1 wheel right. */
  roll: number;
  /** −1 left .. +1 right pedal. Also steers the nose wheel below taxi speed. */
  yaw: number;
  /** 0..1 thrust lever. */
  throttle: number;
  /** 0..1 wheel brakes. */
  brake: number;
  /** 0..1 speedbrake lever. */
  speedbrake: number;
  /** −1..+1 stabiliser trim. Holds the yoke force so you do not have to. */
  trim: number;
}

export function makeControls(): ControlInput {
  return { pitch: 0, roll: 0, yaw: 0, throttle: 0.72, brake: 0, speedbrake: 0, trim: 0 };
}

/** Where the ground is, as the flight model needs it. */
export interface GroundProbe {
  heightAt(x: number, z: number): number;
}

export interface WindField {
  /** Steady wind in world axes, m/s. */
  steady: THREE.Vector3;
  /** 0..1 — how rough it is. */
  turbulence: number;
}

const FWD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const G0 = 9.80665;

/** Contact points in body coordinates, metres from the centre of gravity. */
const GEAR_POINTS = [
  { r: new THREE.Vector3(0, -4.55, -16.98), steers: true, brakes: false },
  { r: new THREE.Vector3(-3.37, -4.55, 1.0), steers: false, brakes: true },
  { r: new THREE.Vector3(3.37, -4.55, 1.0), steers: false, brakes: true },
] as const;

/** The pilot's eyes: left seat, up on the flight deck, 18 m ahead of the CG. */
export const EYE_POINT = new THREE.Vector3(-0.62, 1.62, -18.2);

/** Above this rate of descent at touchdown the gear is being asked too much. */
export const HARD_LANDING_VS = -3.1;
export const GEAR_COLLAPSE_VS = -5.2;
/** Bank at touchdown that puts an outboard engine pod on the runway. */
export const POD_STRIKE_BANK = 0.16;

/**
 * Wet-runway friction. Roughly what a grooved runway with standing water on it
 * gives you: about two thirds of the braking and two thirds of the cornering.
 */
export const WET_BRAKING = 0.68;
export const WET_SIDE_MU = 0.55;

export function makeFlightState(): FlightState {
  return {
    position: new THREE.Vector3(0, 3000, 0),
    velocity: new THREE.Vector3(0, 0, 0),
    omega: new THREE.Vector3(0, 0, 0),
    orientation: new THREE.Quaternion(),
    altitude: 3000,
    radarAltitude: 3000,
    tas: 0,
    ias: 0,
    groundSpeed: 0,
    vs: 0,
    heading: 0,
    pitchAngle: 0,
    bankAngle: 0,
    alpha: 0,
    beta: 0,
    g: 1,
    n1: [0.2, 0.2, 0.2, 0.2],
    engineOut: [false, false, false, false],
    throttle: 0.72,
    flapIndex: 0,
    flapAngle: 0,
    gear: { down: false, position: 0 },
    speedbrake: 0,
    fuel: AIRFRAME.fuelStart,
    onGround: false,
    stalled: false,
    stallMargin: 1,
    overspeed: false,
    damage: 0,
    landed: false,
    touchdownVs: 0,
    touchdownX: 0,
    touchdownOffset: 0,
    podStrike: false,
    crashed: false,
    crashReason: "",
  };
}

// Scratch. Allocating inside a 120 Hz loop is how you get a game that stutters
// once a second and nobody can find the reason.
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _liftAxis = new THREE.Vector3();
const _sideAxis = new THREE.Vector3();
const _force = new THREE.Vector3();
const _torque = new THREE.Vector3();
const _moments = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");
const _prevVel = new THREE.Vector3();
// Ground-reaction scratch, kept separate from the accumulators it writes into.
const _gr = new THREE.Vector3();
const _gPos = new THREE.Vector3();
const _gVel = new THREE.Vector3();
const _gRoll = new THREE.Vector3();
const _gSide = new THREE.Vector3();
const _gForce = new THREE.Vector3();
const _omegaWorld = new THREE.Vector3();

export class FlightModel {
  readonly state = makeFlightState();
  readonly controls = makeControls();
  wind: WindField = { steady: new THREE.Vector3(), turbulence: 0 };
  ground: GroundProbe | null = null;

  /** Filtered gust state, so turbulence feels like air rather than like noise. */
  private gustLin = new THREE.Vector3();
  private gustAng = new THREE.Vector3();
  private gustPhase = 0;

  /** True once the wheels have left the ground, so a landing can be detected. */
  private hasFlown = false;

  get mass(): number {
    return AIRFRAME.massEmpty + this.state.fuel;
  }

  /**
   * Put the aeroplane somewhere, trimmed and flying.
   *
   * The attitude is not zero: it is the angle of attack the wing needs at this
   * speed and weight, and the velocity is along the resulting flight path. An
   * aeroplane placed level at cruise speed instead spends the first three
   * seconds falling while it sorts itself out, which is a terrible first
   * impression and looks exactly like a broken flight model.
   */
  place(opts: {
    position: THREE.Vector3;
    heading: number;
    ias: number;
    flapIndex?: number;
    gearDown?: boolean;
    onGround?: boolean;
  }): void {
    const s = this.state;
    s.position.copy(opts.position);
    if (opts.flapIndex !== undefined) s.flapIndex = opts.flapIndex;
    s.flapAngle = FLAP_DETENTS[clamp(s.flapIndex, 0, FLAP_DETENTS.length - 1)];
    if (opts.gearDown !== undefined) {
      s.gear.down = opts.gearDown;
      s.gear.position = opts.gearDown ? 1 : 0;
    }

    const onGround = opts.onGround ?? false;
    const rho = densityAt(opts.position.y);
    const tas = opts.ias / Math.sqrt(rho / RHO_SL);
    const qS = 0.5 * rho * tas * tas * AIRFRAME.wingArea;
    const clNeeded = qS > 1 ? (this.mass * G0) / qS : AERO.cl0;
    const cl0 = AERO.cl0 + AERO.cl0Flap[s.flapIndex];
    // Sitting on the wheels the attitude is the *ground* attitude, not the one
    // the wing would need. Placing a stationary aeroplane at the angle of
    // attack for zero airspeed points its nose four degrees into the tarmac
    // and drives the nose leg a metre through the runway, which the oleo then
    // resolves by throwing the whole aircraft into the air.
    const alpha = onGround ? 0 : clamp((clNeeded - cl0) / AERO.clAlpha, -0.1, 0.2);

    s.orientation.setFromEuler(_euler.set(alpha, headingToYaw(opts.heading), 0, "YXZ"));
    _right.copy(RIGHT).applyQuaternion(s.orientation);
    s.velocity.copy(FWD).applyQuaternion(s.orientation).applyAxisAngle(_right, -alpha);
    s.velocity.multiplyScalar(tas).add(this.wind.steady);
    s.omega.set(0, 0, 0);
    s.onGround = onGround;
    s.crashed = false;
    s.crashReason = "";
    s.landed = false;
    s.podStrike = false;
    s.damage = 0;
    this.hasFlown = !onGround;
    _prevVel.copy(s.velocity);

    // A stabiliser setting that holds this angle of attack, so the yoke is
    // neutral at the trim speed instead of needing constant aft pressure.
    this.controls.trim = clamp((-AERO.cmAlpha * alpha) / AERO.cmTrim, -1, 1);
    this.controls.pitch = 0;
    this.controls.roll = 0;

    // Trim the *thrust* too, not just the pitch. An aeroplane handed a round
    // number for a throttle setting is not in equilibrium: thrust and drag
    // disagree, the speed drifts, lift follows it, and the whole thing settles
    // into a seventy-second phugoid that looks exactly like a bad integrator.
    // Solving for the setting where thrust equals drag costs four lines.
    const cd =
      AERO.cd0 +
      AERO.cdFlap[s.flapIndex] +
      AERO.cdGear * s.gear.position +
      (clNeeded * clNeeded) / (Math.PI * AIRFRAME.aspectRatio * AIRFRAME.oswald);
    const available = 4 * AIRFRAME.thrustPerEngine * thrustLapse(opts.position.y, tas / 300);
    this.controls.throttle = onGround
      ? 0
      : clamp((qS * cd) / Math.max(available, 1), 0.05, 1);
    for (let i = 0; i < 4; i++) s.n1[i] = s.engineOut[i] ? 0 : this.controls.throttle;
    this.syncDerived(1 / 120);
  }

  /** An upset, in body-frame rad/s: pitch, roll, yaw. */
  gust(pitch: number, roll: number, yaw: number): void {
    // omega is stored in body axes as (pitch, yaw, roll) — see `step`.
    this.state.omega.x += pitch;
    this.state.omega.y -= yaw;
    this.state.omega.z -= roll;
  }

  failEngine(index: number): void {
    if (index >= 0 && index < 4) this.state.engineOut[index] = true;
  }

  /** Stall speed in the current configuration and at the current weight, m/s IAS. */
  stallSpeed(): number {
    const idx = clamp(flapIndexFor(this.state.flapAngle), 0, FLAP_DETENTS.length - 1);
    const clMax = AERO.clMaxClean + AERO.clMaxFlap[idx];
    return Math.sqrt((2 * this.mass * G0) / (RHO_SL * AIRFRAME.wingArea * clMax));
  }

  /** The approach speed. 1.3 × stall, which is where the book puts it. */
  vref(): number {
    return this.stallSpeed() * 1.3;
  }

  step(dt: number): void {
    const s = this.state;
    if (s.crashed) {
      s.velocity.multiplyScalar(Math.max(0, 1 - dt * 2.5));
      s.omega.multiplyScalar(Math.max(0, 1 - dt * 3));
      s.position.addScaledVector(s.velocity, dt);
      if (this.ground) {
        const h = this.ground.heightAt(s.position.x, s.position.z);
        if (s.position.y < h + 3) s.position.y = h + 3;
      }
      this.syncDerived(dt);
      return;
    }

    _prevVel.copy(s.velocity);
    this.stepSystems(dt);
    this.stepGusts(dt);

    const mass = this.mass;
    _force.set(0, 0, 0);
    _torque.set(0, 0, 0);

    // --- attitude basis ----------------------------------------------------
    _q.copy(s.orientation);
    _qInv.copy(_q).invert();
    _fwd.copy(FWD).applyQuaternion(_q);
    _up.copy(UP).applyQuaternion(_q);
    _right.copy(RIGHT).applyQuaternion(_q);

    // --- relative wind -----------------------------------------------------
    // Airspeed is measured against the air, not the ground. That one
    // subtraction is the entire reason a crosswind landing is hard.
    _wind.copy(this.wind.steady).add(this.gustLin);
    _v.copy(s.velocity).sub(_wind);
    const tas = _v.length();
    const alt = s.position.y;
    const rho = densityAt(alt);
    const mach = tas / soundSpeedAt(alt);
    const qBar = 0.5 * rho * tas * tas;
    const S = AIRFRAME.wingArea;

    _v2.copy(_v).applyQuaternion(_qInv);
    const u = -_v2.z;
    const alpha = tas > 0.5 ? Math.atan2(-_v2.y, Math.max(u, 0.1)) : 0;
    const beta = tas > 0.5 ? Math.asin(clamp(_v2.x / tas, -1, 1)) : 0;
    s.alpha = alpha;
    s.beta = beta;

    // --- lift, drag, side force -------------------------------------------
    const flapIdx = flapIndexFor(s.flapAngle);
    const flapFrac = s.flapAngle / 50;
    const clMax = AERO.clMaxClean + AERO.clMaxFlap[flapIdx];
    const cl0 = AERO.cl0 + AERO.cl0Flap[flapIdx];
    const alphaStall = (clMax - cl0) / AERO.clAlpha;

    let cl = cl0 + AERO.clAlpha * alpha;
    let stallFrac = 0;
    if (alpha > alphaStall) {
      // Past the break the wing sheds lift over `stallWidth` radians rather
      // than falling off a cliff — a swept wing lets go from the tips inboard.
      stallFrac = clamp01((alpha - alphaStall) / AERO.stallWidth);
      cl = clMax * (1 - 0.55 * stallFrac * stallFrac);
    } else if (alpha < -alphaStall * 0.75) {
      stallFrac = clamp01((-alpha - alphaStall * 0.75) / AERO.stallWidth);
      cl = -clMax * 0.7 * (1 - 0.5 * stallFrac);
    }
    s.stalled = stallFrac > 0.06;
    // 1 well below the stall, 0 at the break. The shaker fires at 0.12. The
    // negative branch counts too — pushing over hard enough to unload the wing
    // the other way is still a wing that has stopped working, and a margin
    // that reads 1.00 while `stalled` is true is a lying instrument.
    s.stallMargin = Math.min(
      clamp01(1 - alpha / Math.max(alphaStall, 0.05)),
      clamp01(1 - stallFrac),
    );

    // Ground effect.
    //
    // Within about a wingspan of the ground the wing's trailing vortices can no
    // longer roll up properly, the downwash collapses, and induced drag falls
    // away — Wieselsberger's factor, which at a tenth of a span is a halving.
    // This is the cushion every flare is flown onto, and without it a landing
    // in this model was a controlled descent that simply *stopped*, at whatever
    // rate it happened to be going, a metre above the tarmac. Modelling it is
    // two lines and it changed every touchdown in the game.
    const hb = clamp(s.radarAltitude / AIRFRAME.span, 0.033, 1.2);
    const ge = (33 * Math.pow(hb, 1.5)) / (1 + 33 * Math.pow(hb, 1.5));

    let cd =
      AERO.cd0 +
      AERO.cdFlap[flapIdx] +
      AERO.cdGear * s.gear.position +
      AERO.cdSpeedbrake * s.speedbrake +
      ge * ((cl * cl) / (Math.PI * AIRFRAME.aspectRatio * AIRFRAME.oswald)) +
      AERO.cdStall * stallFrac +
      0.05 * s.damage;
    // Drag rise past the drag-divergence Mach — steep, and the reason the
    // barber pole is a wall rather than a suggestion.
    if (mach > AERO.machDrag) cd += 22 * Math.pow(mach - AERO.machDrag, 3);

    const lift = qBar * S * cl;
    const drag = qBar * S * cd;
    const side = qBar * S * AERO.cyBeta * beta;

    if (tas > 0.5) {
      _v.normalize();
      _liftAxis.copy(_up).addScaledVector(_v, -_up.dot(_v));
      if (_liftAxis.lengthSq() > 1e-6) _liftAxis.normalize();
      else _liftAxis.copy(_up);
      _sideAxis.copy(_right).addScaledVector(_v, -_right.dot(_v));
      if (_sideAxis.lengthSq() > 1e-6) _sideAxis.normalize();
      else _sideAxis.copy(_right);

      _force.addScaledVector(_liftAxis, lift);
      _force.addScaledVector(_v, -drag);
      _force.addScaledVector(_sideAxis, side);
    }

    // --- thrust ------------------------------------------------------------
    const lapse = thrustLapse(alt, mach);
    let thrust = 0;
    let yawFromThrust = 0;
    for (let i = 0; i < 4; i++) {
      const t = s.n1[i] * AIRFRAME.thrustPerEngine * lapse;
      thrust += t;
      // 1 and 2 hang off the left wing, 3 and 4 off the right, and the arm
      // grows outboard — which is why losing an outboard engine is so much
      // worse than losing an inboard one. τ_y = x·T falls straight out of
      // r × F with the nose along −Z.
      yawFromThrust += t * ENGINE_X[i];
    }
    _force.addScaledVector(_fwd, thrust);

    // --- gravity -----------------------------------------------------------
    _force.y -= mass * G0;

    // --- moments, in the standard aero convention -------------------------
    const b = AIRFRAME.span;
    const c = AIRFRAME.chord;
    const qSb = qBar * S * b;
    const qSc = qBar * S * c;
    const twoV = 2 * Math.max(tas, 20);

    const { p, q: qStd, r } = standardRates(s.omega);

    const cm =
      AERO.cmAlpha * alpha +
      AERO.cmQ * ((qStd * c) / twoV) +
      AERO.cmElevator * this.controls.pitch +
      AERO.cmTrim * this.controls.trim +
      AERO.cmFlap * flapFrac +
      // A jet transport pitches *up* at the stall as the tips let go ahead of
      // the roots and the wake blankets the tailplane. That mechanism is what
      // makes recovering one urgent, so it is modelled rather than assumed.
      AERO.pitchUpAtStall * stallFrac;

    const clRoll =
      AERO.clAileron * this.controls.roll * (1 - 0.5 * stallFrac) +
      AERO.clP * ((p * b) / twoV) +
      AERO.clBeta * beta +
      AERO.clR * ((r * b) / twoV);

    const cnYaw =
      AERO.cnRudder * this.controls.yaw +
      AERO.cnBeta * beta +
      AERO.cnR * ((r * b) / twoV) +
      AERO.cnAileron * this.controls.roll;

    momentsToBodyTorque(clRoll * qSb, cm * qSc, cnYaw * qSb, _moments);
    _moments.y += yawFromThrust;
    if (this.gustAng.lengthSq() > 0) _moments.addScaledVector(this.gustAng, qBar * S * 0.35);
    _moments.applyQuaternion(_q);
    _torque.add(_moments);

    // --- ground reaction ---------------------------------------------------
    if (this.ground) this.applyGround(_force, _torque, mass);

    // --- integrate ---------------------------------------------------------
    s.velocity.addScaledVector(_force, dt / mass);
    s.position.addScaledVector(s.velocity, dt);

    // The inertia tensor is diagonal in body axes, so the torque goes there,
    // gets divided, and comes back.
    _v2.copy(_torque).applyQuaternion(_qInv);
    _v2.x /= AIRFRAME.iyy; // pitch, about the right-wing axis
    _v2.y /= AIRFRAME.izz; // yaw, about the roof axis
    _v2.z /= AIRFRAME.ixx; // roll, about the fuselage axis
    s.omega.addScaledVector(_v2, dt);
    // A little numerical bleed. Without it the integrator slowly pumps energy
    // into the rates and the aeroplane develops a shimmy over ten minutes.
    s.omega.multiplyScalar(Math.max(0, 1 - 0.02 * dt));

    const rate = s.omega.length();
    if (rate > 1e-7) {
      _v2.copy(s.omega).applyQuaternion(_q).normalize();
      _q.setFromAxisAngle(_v2, rate * dt);
      s.orientation.premultiply(_q).normalize();
    }

    this.checkLimits(dt, tas, alt);
    this.syncDerived(dt);
  }

  // -------------------------------------------------------------------------

  /** Engines, flaps, gear, speedbrake and fuel — everything with a time constant. */
  private stepSystems(dt: number): void {
    const s = this.state;
    const c = this.controls;
    s.throttle = clamp01(c.throttle);

    let burn = 0;
    for (let i = 0; i < 4; i++) {
      const target = s.engineOut[i] ? 0 : s.throttle;
      // Spooling up is slower than spooling down, and anyone who has flown an
      // approach in a big jet knows why that matters: you cannot get the
      // energy back in under eight seconds, so you never let it go.
      const tau = target > s.n1[i] ? AIRFRAME.spoolUp : AIRFRAME.spoolDown;
      s.n1[i] += (target - s.n1[i]) * clamp01(dt / tau);
      burn += s.n1[i];
    }
    s.fuel = Math.max(0, s.fuel - (burn / 4) * AIRFRAME.fuelBurn * dt);
    if (s.fuel <= 0) for (let i = 0; i < 4; i++) s.engineOut[i] = true;

    // 707 flaps take about half a minute to run from up to 50°.
    const FLAP_RATE = 1.7; // degrees per second
    const target = FLAP_DETENTS[clamp(s.flapIndex, 0, FLAP_DETENTS.length - 1)];
    s.flapAngle += clamp(target - s.flapAngle, -FLAP_RATE * dt, FLAP_RATE * dt);

    const gear: GearState = s.gear;
    const gearRate = 1 / AIRFRAME.gearTravel;
    gear.position = clamp01(gear.position + (gear.down ? gearRate : -gearRate) * dt);

    s.speedbrake += clamp(c.speedbrake - s.speedbrake, -dt * 0.8, dt * 0.8);
    s.speedbrake = clamp01(s.speedbrake);
  }

  /**
   * Turbulence.
   *
   * Three sines at incommensurate frequencies per axis, scaled by the storm.
   * Deliberately not white noise: real turbulence has structure at a period of
   * a few seconds, and noise at frame rate reads as a broken renderer rather
   * than as weather.
   */
  private stepGusts(dt: number): void {
    const t = (this.gustPhase += dt);
    const a = this.wind.turbulence;
    if (a <= 0.001) {
      this.gustLin.multiplyScalar(Math.max(0, 1 - dt * 3));
      this.gustAng.multiplyScalar(Math.max(0, 1 - dt * 3));
      return;
    }
    const s1 = Math.sin(t * 0.83) + 0.6 * Math.sin(t * 2.17 + 1.3) + 0.35 * Math.sin(t * 5.1 + 2.9);
    const s2 = Math.sin(t * 0.61 + 2.1) + 0.6 * Math.sin(t * 1.93 + 0.4) + 0.35 * Math.sin(t * 4.3 + 1.1);
    const s3 = Math.sin(t * 0.97 + 4.2) + 0.6 * Math.sin(t * 2.53 + 3.3) + 0.35 * Math.sin(t * 6.7 + 0.2);
    this.gustLin.set(s1 * 3.4, s3 * 4.6, s2 * 3.4).multiplyScalar(a);
    // Body-axis rolling moment dominates: an aeroplane in rough air rocks far
    // more than it pitches, because the gust hits one wing before the other.
    this.gustAng.set(s2 * 0.0016, s1 * 0.0011, s3 * 0.0042).multiplyScalar(a);
  }

  /** Oleos, tyres and brakes. Three contact points, sprung and damped. */
  private applyGround(force: THREE.Vector3, torque: THREE.Vector3, mass: number): void {
    const s = this.state;
    const ground = this.ground!;
    _omegaWorld.copy(s.omega).applyQuaternion(s.orientation);

    let anyContact = false;
    const reach = s.gear.position;

    for (const leg of GEAR_POINTS) {
      // Retracted gear pulls the contact point up into the wheel well, so a
      // gear-up arrival meets the ground at the belly line instead.
      const dropY = leg.r.y * reach + 1.9 * (1 - reach);
      _gr.set(leg.r.x, dropY, leg.r.z).applyQuaternion(s.orientation);
      _gPos.copy(s.position).add(_gr);

      const pen = ground.heightAt(_gPos.x, _gPos.z) - _gPos.y;
      if (pen <= 0) continue;
      anyContact = true;

      _gVel.copy(_omegaWorld).cross(_gr).add(s.velocity);

      // Spring minus damper, never pulling down. 0.6 m of travel; past that
      // the oleo is on its stops and the rate goes up hard, which is what
      // makes a heavy landing feel like one.
      const bottomed = Math.max(0, pen - 0.6);
      const n = clamp(
        AIRFRAME.oleoK * pen + AIRFRAME.oleoK * 8 * bottomed - AIRFRAME.oleoC * _gVel.y,
        0,
        mass * 55,
      );
      if (n <= 0) continue;

      _gForce.set(0, n, 0);
      force.add(_gForce);
      torque.add(_v.crossVectors(_gr, _gForce));

      // Rolling direction: the wheel's own heading, flattened. The nose wheel
      // is steered by the pedals below taxi speed.
      _gRoll.copy(FWD).applyQuaternion(s.orientation).setY(0);
      if (_gRoll.lengthSq() < 1e-6) continue;
      _gRoll.normalize();
      if (leg.steers) {
        const authority = clamp(1 - s.groundSpeed / 32, 0, 1);
        _gRoll.applyAxisAngle(UP, -this.controls.yaw * 0.42 * authority);
      }
      _gSide.crossVectors(UP, _gRoll); // points left of travel

      const vRoll = _gVel.dot(_gRoll);
      const vSide = _gVel.dot(_gSide);

      // Wet. Tonight the runway has an inch of water on it, and a wet runway
      // is not a dry runway with the brakes turned down — it changes what the
      // *tyres* can do sideways, which is the number that decides whether a
      // crabbed touchdown straightens out or turns into a ground loop. With a
      // dry-runway side coefficient the aeroplane lands forty metres off the
      // centreline, the nose wheel bites, and it rolls over on its own
      // undercarriage inside ten seconds.
      const braking =
        leg.brakes ? this.controls.brake * AIRFRAME.brakeForce * 0.5 * WET_BRAKING : 0;
      const rollMag = Math.min(
        AIRFRAME.rollingFriction * n + braking,
        Math.abs(vRoll) * mass * 4 + 1,
      );
      const sideForce = -clamp(vSide * mass * 0.9, -n * WET_SIDE_MU, n * WET_SIDE_MU);

      _gForce.set(0, 0, 0)
        .addScaledVector(_gRoll, -Math.sign(vRoll) * rollMag)
        .addScaledVector(_gSide, sideForce);
      force.add(_gForce);
      torque.add(_v.crossVectors(_gr, _gForce));
    }

    if (anyContact && !s.onGround && this.hasFlown && !s.landed) {
      // First contact after a flight. The whole game is scored on these.
      s.landed = true;
      s.touchdownVs = s.velocity.y;
      s.touchdownX = s.position.x;
      s.touchdownOffset = s.position.z;

      if (reach < 0.95) this.crash("touched down with the gear up");
      else if (s.touchdownVs < GEAR_COLLAPSE_VS) this.crash("the gear collapsed");
      else {
        // A pod strike is expensive, not fatal. A 707's outboard nacelles hang
        // low enough that nine degrees of bank puts one on the runway, and
        // nine degrees is entirely reachable in a gusting crosswind — making
        // it a total loss turns the last two seconds of a well-flown approach
        // into a coin toss, which is the wrong kind of hard.
        if (Math.abs(s.bankAngle) > POD_STRIKE_BANK) {
          s.podStrike = true;
          s.damage = clamp01(s.damage + 0.45);
        }
        if (s.touchdownVs < HARD_LANDING_VS) s.damage = clamp01(s.damage + 0.3);
      }
    }
    s.onGround = anyContact;
    if (!anyContact) this.hasFlown = true;
  }

  /** Overspeed, over-G, gear and flap limits, and hitting things. */
  private checkLimits(dt: number, tas: number, alt: number): void {
    const s = this.state;
    const ias = indicatedFrom(tas, alt);

    s.overspeed = ias > AIRFRAME.vmo || tas / soundSpeedAt(alt) > AIRFRAME.mmo;
    if (s.overspeed) s.damage = clamp01(s.damage + dt * 0.03);

    const flapIdx = flapIndexFor(s.flapAngle);
    if (flapIdx > 0 && ias > AIRFRAME.vfe[flapIdx]) s.damage = clamp01(s.damage + dt * 0.045);
    if (s.gear.position > 0.02 && s.gear.position < 0.98 && ias > AIRFRAME.vlo) {
      s.damage = clamp01(s.damage + dt * 0.035);
    }
    if (Math.abs(s.g) > AIRFRAME.gLimit) {
      s.damage = clamp01(s.damage + (Math.abs(s.g) - AIRFRAME.gLimit) * dt * 0.25);
    }
    if (s.damage >= 1) this.crash("the airframe came apart");

    if (!this.ground) return;

    // A wing on the runway. Without this the rollout can keep rolling past
    // ninety degrees of bank — the tyre side force acts below the centre of
    // gravity, so once one main lifts there is nothing left to stop it, and a
    // ground loop turns into a barrel roll at forty knots. In an aeroplane the
    // wing hits the tarmac at about fifteen degrees and that is the end of it.
    if (s.onGround && Math.abs(s.bankAngle) > 0.26) this.crash("put a wing into the runway");

    // Anything below the belly line that is not the undercarriage.
    const clearance = s.position.y - this.ground.heightAt(s.position.x, s.position.z);
    if (clearance < 1.6) this.crash("flew into the ground");
  }

  crash(reason: string): void {
    if (this.state.crashed) return;
    this.state.crashed = true;
    this.state.crashReason = reason;
  }

  /** Everything the rest of the world reads off the state. */
  private syncDerived(dt: number): void {
    const s = this.state;
    const alt = s.position.y;
    s.altitude = alt;
    s.tas = _v.copy(s.velocity).sub(this.wind.steady).length();
    s.ias = indicatedFrom(s.tas, alt);
    s.groundSpeed = Math.hypot(s.velocity.x, s.velocity.z);
    s.vs = s.velocity.y;

    _euler.setFromQuaternion(s.orientation, "YXZ");
    s.pitchAngle = _euler.x;
    // YXZ order puts a positive z on the *left* wing going down, and every
    // instrument in the cockpit wants the opposite. Flip it once, here.
    s.bankAngle = -_euler.z;
    _fwd.copy(FWD).applyQuaternion(s.orientation);
    // `atan2(east, north)` *is* the compass heading — do not run it back
    // through `yawToHeading`, which converts a Three.js yaw and would mirror
    // it about north. That bug reads as a perfectly stable aeroplane whose
    // heading indicator is wrong, and every heading-driven control law
    // downstream then steers confidently in the wrong direction.
    s.heading = normalizeHeading(Math.atan2(_fwd.x, -_fwd.z));

    s.radarAltitude = this.ground
      ? alt - this.ground.heightAt(s.position.x, s.position.z)
      : alt;

    // Load factor: specific force along body-up, in g. Measured from the
    // change in velocity rather than recomputed from lift, so it includes the
    // ground reaction on a heavy landing — which is what the passengers feel.
    if (dt > 1e-6) {
      _v.copy(s.velocity).sub(_prevVel).divideScalar(dt);
      _v.y += G0;
      _up.copy(UP).applyQuaternion(s.orientation);
      s.g = _v.dot(_up) / G0;
    }
  }
}

// ---------------------------------------------------------------------------
// Frame conversions — see the file header
// ---------------------------------------------------------------------------

/** Lateral station of each engine, metres. 1 and 2 left, 3 and 4 right. */
export const ENGINE_X = [-11.6, -6.4, 6.4, 11.6] as const;

/**
 * Standard-convention body rates from the Three.js body-axis rate vector.
 *
 * `omega` holds (pitch about +X, yaw about +Y, roll about +Z). Body +Y is up
 * and body +Z is aft, so both the yaw and the roll rate come out with the
 * opposite sign to the aero convention, where +r is nose-right and +p is
 * right-wing-down.
 */
export function standardRates(omega: THREE.Vector3): { p: number; q: number; r: number } {
  return { p: -omega.z, q: omega.x, r: -omega.y };
}

/** Standard-convention moments (L, M, N) to a Three.js body-axis torque. */
export function momentsToBodyTorque(
  l: number,
  m: number,
  n: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  return out.set(m, -n, -l);
}

/**
 * Heading (0 = north, clockwise, radians) to a Three.js yaw about +Y.
 *
 * North is −Z and east is +X, so a heading of 090° has to point the nose down
 * +X. The nose is −Z in body space, so the yaw that does it is −heading.
 */
export function headingToYaw(heading: number): number {
  return -heading;
}

export function yawToHeading(yaw: number): number {
  return normalizeHeading(-yaw);
}

/** Into 0..2π. */
export function normalizeHeading(h: number): number {
  return ((h % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
}

/** The nearest flap detent to an actual flap angle. */
export function flapIndexFor(angle: number): number {
  let best = 0;
  let bestErr = Infinity;
  for (let i = 0; i < FLAP_DETENTS.length; i++) {
    const err = Math.abs(FLAP_DETENTS[i] - angle);
    if (err < bestErr) {
      bestErr = err;
      best = i;
    }
  }
  return best;
}

/** Shortest signed difference between two headings, radians. */
export function headingError(target: number, actual: number): number {
  let d = target - actual;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
