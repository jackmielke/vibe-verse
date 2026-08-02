/**
 * The flight model.
 *
 * Two things had to be true at once: it has to *be* a flight simulator — real
 * lift, real drag, real thrust lapse, a wing that stops working if you ask too
 * much of it — and it has to be flyable with a thumb on a phone. Those pull in
 * opposite directions, and the resolution is the same one McDonnell Douglas
 * reached in 1978: put a fly-by-wire computer between the stick and the
 * control surfaces.
 *
 * So the pilot's stick does not deflect an elevator here. Aft stick commands
 * *G*; lateral stick commands a *roll rate*; the rudder is coordinated for you
 * unless you take it. That is genuinely how an F/A-18 flies, and it happens to
 * be exactly what a touchscreen needs: a control that asks for an outcome
 * rather than a surface position degrades gracefully when the input is a
 * fingertip instead of a 30 cm control stick.
 *
 * Underneath the control law the physics is unassisted. The FBW asks for 7 G;
 * if the wing cannot make 7 G at this speed and density, you do not get 7 G,
 * you get buffet and a stall warning. Fly it too slow behind the power curve
 * and it will sink no matter how hard you pull, which is the lesson that makes
 * a flight sim feel like flying.
 *
 * Frames and signs, once, so nothing downstream has to guess:
 *   - World is Y-up, metres, right-handed. +X is east, -Z is north.
 *   - Body axes follow Three's convention: nose along local -Z, right wing
 *     along +X, canopy along +Y.
 *   - Angular velocity is stored in WORLD space. Body rates come out of it by
 *     projection: p = ω·forward is roll-right, q = ω·right is pitch-up, and
 *     ω·up is yaw-LEFT (so yaw-right is its negation). Every sign in this file
 *     was checked against those three sentences.
 */
import * as THREE from "three";
import {
  GRAVITY,
  atmosphere,
  dynamicPressure,
  indicatedAirspeed,
  smoothstep,
  thrustLapse,
} from "./atmosphere";
import type { AircraftSpec } from "./aircraft";

/** What the pilot — human or AI — is asking for this frame. */
export interface Controls {
  /** -1 (full forward, push) .. +1 (full aft, pull). Commands G. */
  pitch: number;
  /** -1 (left) .. +1 (right). Commands roll rate. */
  roll: number;
  /** -1 (left) .. +1 (right). Rudder. Zero means "coordinate it for me". */
  yaw: number;
  /** 0 .. 1 throttle lever position. */
  throttle: number;
  /** 0 .. 1 speedbrake. */
  brake: number;
  /** Wheel brakes, only meaningful on the ground. */
  wheelBrake: number;
  /** Gear handle. */
  gear: boolean;
  /** Smoke on. */
  smoke: boolean;
}

export function neutralControls(): Controls {
  return {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: 0.7,
    brake: 0,
    wheelBrake: 0,
    gear: false,
    smoke: false,
  };
}

/**
 * How much the machine flies itself.
 *
 * "Rookie" is not a cheat mode so much as an autopilot riding along: it holds
 * the turn for you, refuses to let the wing stall, and rolls back toward level
 * when you let go. "Ace" hands you the raw control law and lets you depart.
 */
export type AssistLevel = "rookie" | "angel" | "ace";

export interface Assists {
  level: AssistLevel;
  /** Add the extra G a level turn needs, so a bank holds altitude. */
  turnCompensation: number;
  /** Roll back toward wings-level when the stick is centred. */
  levelling: number;
  /** Hard limit on commanded AOA — the wing never gets to let go. */
  envelopeProtection: number;
  /** How much the rudder is flown for you. */
  coordination: number;
  /** Prevents flight into terrain by pulling up. 0 = off. */
  groundAvoidance: number;
}

export function assistsFor(level: AssistLevel): Assists {
  switch (level) {
    case "rookie":
      return {
        level,
        turnCompensation: 1,
        levelling: 1.1,
        envelopeProtection: 1,
        coordination: 1,
        groundAvoidance: 1,
      };
    case "ace":
      return {
        level,
        turnCompensation: 0,
        levelling: 0,
        envelopeProtection: 0,
        coordination: 0.25,
        groundAvoidance: 0,
      };
    default:
      return {
        level: "angel",
        turnCompensation: 0.45,
        levelling: 0.25,
        envelopeProtection: 0.75,
        coordination: 0.9,
        groundAvoidance: 0,
      };
  }
}

/** Everything the renderer, HUD and game logic want to know about an aircraft. */
export interface FlightState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  orientation: THREE.Quaternion;
  /** World-space angular velocity, rad/s. */
  angular: THREE.Vector3;

  /** Spooled engine setting, 0..1 military, >1 into afterburner. */
  power: number;
  /** True airspeed, m/s. */
  airspeed: number;
  /** Indicated airspeed, m/s — the number on the tape. */
  ias: number;
  mach: number;
  /** Metres above mean sea level. */
  altitude: number;
  /** Metres above the terrain directly below. */
  radarAltitude: number;
  /** Angle of attack, radians. */
  alpha: number;
  /** Sideslip, radians. */
  beta: number;
  /** Normal load factor. 1 in level flight. */
  gLoad: number;
  /** Vertical speed, m/s. */
  climb: number;
  /** Body roll-right rate, rad/s. */
  rollRate: number;
  /** Body pitch-up rate, rad/s. */
  pitchRate: number;
  /** Bank angle, radians. Positive = right wing down. */
  bank: number;
  /** Flight path angle, radians. */
  gamma: number;
  /** Compass heading, radians, 0 = north, increasing clockwise. */
  heading: number;
  /** Nose-up attitude, radians. */
  pitchAttitude: number;

  /** Fraction of CLmax the wing is currently using. >0.9 buffets. */
  liftDemand: number;
  /** True once the wing has actually let go. */
  stalled: boolean;
  /** Gear position, 0 up .. 1 down. */
  gearPos: number;
  onGround: boolean;
  /** Accumulated physiological G — drives greyout, lags the instantaneous G. */
  gStrain: number;
  /** Fuel remaining, kg. */
  fuel: number;
  /** Set for one step when the aircraft touches down or hits something. */
  impact: number;
  /**
   * Set for one step when the aircraft arrived at the ground in a way it does
   * not walk away from. Distinct from `impact`, which a firm but legal landing
   * also raises — this one means the aeroplane is scrap.
   */
  crashed: boolean;
  /** Seconds of continuous flight since the last reset. */
  age: number;
}

export function createFlightState(spec: AircraftSpec): FlightState {
  return {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    orientation: new THREE.Quaternion(),
    angular: new THREE.Vector3(),
    power: 0.7,
    airspeed: 0,
    ias: 0,
    mach: 0,
    altitude: 0,
    radarAltitude: 0,
    alpha: 0,
    beta: 0,
    gLoad: 1,
    climb: 0,
    rollRate: 0,
    pitchRate: 0,
    bank: 0,
    gamma: 0,
    heading: 0,
    pitchAttitude: 0,
    liftDemand: 0,
    stalled: false,
    gearPos: 0,
    onGround: false,
    gStrain: 1,
    fuel: spec.mass * 0.18,
    impact: 0,
    crashed: false,
    age: 0,
  };
}

/** The world the aircraft is flying through, as far as the physics cares. */
export interface FlightEnvironment {
  /** Ground or water height at a world XZ, metres above sea level. */
  terrainHeight(x: number, z: number): number;
  /** Wind vector in world space, m/s. */
  wind(position: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  /**
   * Whether this XZ is over water. Optional, and only used to decide whether
   * arriving at the surface counts as a landing — nothing here floats.
   */
  isWater?(x: number, z: number): boolean;
}

// Scratch vectors. This runs 120 times a second per aircraft with seven
// aircraft in the air; allocating here would hand the GC a steady diet.
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _vhat = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _force = new THREE.Vector3();
const _lift = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _spin = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _mat = new THREE.Matrix4();

const BODY_FWD = new THREE.Vector3(0, 0, -1);
const BODY_RIGHT = new THREE.Vector3(1, 0, 0);
const BODY_UP = new THREE.Vector3(0, 1, 0);
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Reference dynamic pressure at which control surfaces are fully effective. */
const REF_Q = 12000; // Pa — about 250 kn at sea level

export interface StepResult {
  /** Peak specific force felt this step, for the audio and the camera shake. */
  jolt: number;
}

/**
 * Advance one aircraft by `dt` seconds.
 *
 * Call this on a fixed timestep. It is stable at 1/120 and merely unpleasant
 * at 1/30; the engine runs it at 1/120 and lets the renderer interpolate.
 */
export function stepFlight(
  state: FlightState,
  spec: AircraftSpec,
  controls: Controls,
  assists: Assists,
  env: FlightEnvironment,
  dt: number,
): StepResult {
  const q = state.orientation;
  _fwd.copy(BODY_FWD).applyQuaternion(q);
  _right.copy(BODY_RIGHT).applyQuaternion(q);
  _up.copy(BODY_UP).applyQuaternion(q);

  const air = atmosphere(state.position.y);
  env.wind(state.position, _wind);

  // Airspeed is measured against the air, not the ground.
  _rel.copy(state.velocity).sub(_wind);
  const speed = _rel.length();
  const flying = speed > 0.5;
  if (flying) _vhat.copy(_rel).divideScalar(speed);
  else _vhat.copy(_fwd);

  // ---- angle of attack and sideslip ---------------------------------------
  const u = _rel.dot(_fwd);
  const w = _rel.dot(_up);
  const sv = _rel.dot(_right);
  const alpha = flying ? Math.atan2(-w, Math.abs(u) < 1e-3 ? 1e-3 : u) : 0;
  const beta = flying ? Math.asin(THREE.MathUtils.clamp(sv / speed, -1, 1)) : 0;

  const mach = speed / air.speedOfSound;
  const qBar = dynamicPressure(air.density, speed);
  // Control effectiveness: surfaces need air over them. Below about 100 knots
  // the jet answers the stick like a rowboat, which is the correct answer.
  const qFactor = THREE.MathUtils.clamp(qBar / REF_Q, 0.05, 1.35);

  // ---- fly-by-wire: what is the pilot asking for? -------------------------
  const gearDown = state.gearPos > 0.5;

  // Roll. Full lateral stick asks for the airframe's published roll rate,
  // tapered off as the surfaces run out of air and as G loads the wing.
  const gTaper = 1 - 0.35 * smoothstep(3, spec.gLimit.positive, Math.abs(state.gLoad));
  let rollCmd = controls.roll * spec.feel.rollRate * qFactor * gTaper;
  if (gearDown) rollCmd *= 0.6;

  // Wings-level assist: with the stick centred, roll out of a bank on its own.
  //
  // The right wing's world-space height *is* the bank signal: `_right.y` is
  // -sin(bank), so asin of it is the correction, already signed the right way
  // round. Getting this backwards builds a spiral instead of levelling one.
  if (assists.levelling > 0 && Math.abs(controls.roll) < 0.06 && !state.onGround) {
    rollCmd += Math.asin(THREE.MathUtils.clamp(_right.y, -1, 1)) * assists.levelling * 1.4;
  }

  // Pitch. Aft stick commands load factor, which is the whole trick: it makes
  // the jet hold whatever you point it at instead of endlessly pitching.
  const maxG = spec.feel.pitchG;
  const minG = spec.gLimit.negative;
  let gCmd =
    controls.pitch >= 0
      ? 1 + controls.pitch * (maxG - 1)
      : 1 + controls.pitch * (1 - minG);

  // Turn compensation: in a bank, ask for the extra G that holds altitude.
  if (assists.turnCompensation > 0 && !state.onGround) {
    const cosBank = Math.max(0.18, Math.abs(_up.y));
    const hold = THREE.MathUtils.clamp(1 / cosBank, 1, maxG * 0.85);
    gCmd += (hold - 1) * assists.turnCompensation * (1 - Math.abs(controls.pitch));
  }

  // The G the wing could actually produce right now, at CLmax. Beyond this the
  // command is a wish, and the envelope limiter turns it back into a number.
  const gAvailable = (qBar * spec.wingArea * spec.clMax) / (spec.mass * GRAVITY);
  if (assists.envelopeProtection > 0) {
    const ceiling = Math.max(1.05, gAvailable * (1 - 0.12 * assists.envelopeProtection));
    gCmd = Math.min(gCmd, ceiling);
    gCmd = Math.max(gCmd, minG * (1 - 0.2 * assists.envelopeProtection));
  }

  // Load factor becomes a pitch rate: the aircraft turns at a/V about its own
  // right axis, and gravity already supplies part of the acceleration.
  const vRef = Math.max(speed, 45);
  let pitchCmd = ((gCmd - _up.y) * GRAVITY) / vRef;
  pitchCmd *= THREE.MathUtils.clamp(qFactor * 1.4, 0.12, 1);

  // Ground-proximity save. Only Rookie gets this, and only when the geometry
  // says the next few seconds end in a hillside.
  if (assists.groundAvoidance > 0 && !state.onGround && state.radarAltitude < 900) {
    const sinkTime = state.climb < -2 ? state.radarAltitude / -state.climb : 99;
    if (sinkTime < 6 && controls.pitch < 0.3) {
      const urgency = assists.groundAvoidance * (1 - sinkTime / 6);
      pitchCmd += urgency * 0.9;
      rollCmd += Math.asin(THREE.MathUtils.clamp(_right.y, -1, 1)) * urgency * 2.2;
    }
  }

  // Yaw. The fin does most of it; the assist finishes the job so a bank does
  // not scrub sideways, and manual rudder always wins.
  //
  // Sign, because it is the one that bites: positive beta means the relative
  // wind is coming from the right, so the nose is sitting to the *left* of
  // where the jet is actually going, and the correction is yaw-right. Get it
  // backwards and the sideslip loop is a positive feedback — it looks fine for
  // thirty seconds and then departs.
  const manualYaw = controls.yaw * spec.feel.yawRate;
  const coordinate = beta * 3.2 * assists.coordination;
  const yawRightCmd = (manualYaw + coordinate) * qFactor;

  // ---- close the rate loops ----------------------------------------------
  let p = state.angular.dot(_fwd); // roll right
  let qq = state.angular.dot(_right); // pitch up
  // ω·up is yaw-LEFT, so yaw-right is its negation. See the header note.
  let r = -state.angular.dot(_up);

  // Post-stall the control law is writing cheques the wing will not cash.
  const stallDepth = smoothstep(spec.stallAlpha, spec.stallAlpha + 0.2, Math.abs(alpha));
  const authority = 1 - 0.72 * stallDepth;

  const kRoll = spec.feel.rollAuthority * authority;
  const kPitch = spec.feel.pitchAuthority * authority;
  const kYaw = spec.feel.yawAuthority * authority;

  p += (rollCmd - p) * Math.min(1, kRoll * dt);
  qq += (pitchCmd - qq) * Math.min(1, kPitch * dt);
  r += (yawRightCmd - r) * Math.min(1, kYaw * dt);

  // Aerodynamic damping — the airframe resists rotation even with the stick
  // centred, and resists it harder in thick air.
  const damp = spec.feel.damping;
  const dampScale = THREE.MathUtils.clamp(qBar / REF_Q, 0.02, 1.1);
  p -= p * Math.min(1, damp.x * dampScale * dt);
  qq -= qq * Math.min(1, damp.y * dampScale * dt);
  r -= r * Math.min(1, damp.z * dampScale * dt);

  // Departure. A stalled wing does not stay pointed where you left it; one
  // side lets go before the other and the jet starts to wander.
  if (stallDepth > 0.15 && !state.onGround) {
    const chaos = stallDepth * 0.9;
    const t = state.age;
    p += Math.sin(t * 5.3 + state.position.x * 0.01) * chaos * dt * 2.4;
    r += Math.sin(t * 3.1 + state.position.z * 0.01) * chaos * dt * 1.8;
    qq -= chaos * dt * 1.1; // the nose falls, as it should
  }

  // Weathervaning: the fin pulls the nose back into the relative wind. Same
  // sign as the coordination term above, for the same reason.
  r += beta * spec.sideForce * dampScale * dt * 2.6;

  state.angular
    .copy(_fwd)
    .multiplyScalar(p)
    .addScaledVector(_right, qq)
    .addScaledVector(_up, -r);

  // ---- lift, drag, side force --------------------------------------------
  const attached = 1 - smoothstep(spec.stallAlpha, spec.stallAlpha + 0.18, Math.abs(alpha));
  const clLinear = THREE.MathUtils.clamp(
    spec.cl0 + spec.clAlpha * alpha,
    -spec.clMax,
    spec.clMax,
  );
  // Past the break the wing behaves like a barn door: some lift, mostly drag.
  const clPostStall = 1.05 * Math.sin(2 * alpha);
  const gearLift = state.gearPos * 0.06;
  const cl = attached * clLinear + (1 - attached) * clPostStall + gearLift * attached;

  // Transonic drag rise: a hump at Mach 1 that flattens out supersonic.
  const wave =
    1 +
    spec.waveDrag *
      smoothstep(spec.machCrit, spec.machCrit + 0.14, mach) *
      (1 - 0.62 * smoothstep(1.08, 1.65, mach));
  const cdSeparated = (1 - attached) * 0.9;
  const cdGear = state.gearPos * 0.028;
  const cdBrake = controls.brake * 0.11;
  const cd =
    spec.cd0 * wave + spec.inducedK * cl * cl + cdSeparated + cdGear + cdBrake;
  const cy = -spec.sideForce * beta;

  const qS = qBar * spec.wingArea;

  _force.set(0, 0, 0);

  if (flying) {
    // Lift is perpendicular to the relative wind, in the plane of symmetry.
    _lift.copy(_right).cross(_vhat).normalize().multiplyScalar(qS * cl);
    _force.add(_lift);
    _force.addScaledVector(_vhat, -qS * cd);
    _force.addScaledVector(_right, qS * cy);
  }

  // ---- engine -------------------------------------------------------------
  const hasBurner = spec.thrustAB > 0;
  // The lever runs 0..1 for military power; the top 12% of travel lights the
  // burner, which is roughly where the detent is on the real throttle.
  const demand =
    hasBurner && controls.throttle > 0.88
      ? 1 + (controls.throttle - 0.88) / 0.12
      : Math.min(controls.throttle, 1);
  const spool = 1 - Math.exp(-dt / Math.max(0.05, spec.spoolTime));
  state.power += (demand - state.power) * spool;

  const lapse = thrustLapse(air.sigma);
  const dryFrac = Math.min(state.power, 1);
  const abFrac = Math.max(0, state.power - 1);
  // A turbofan makes a little more thrust as it goes faster (ram recovery); a
  // turboprop makes markedly less. This is the one number that keeps Fat
  // Albert from behaving like a fighter.
  const ram =
    spec.shape.planform === "prop"
      ? THREE.MathUtils.clamp(1.25 - mach * 1.4, 0.25, 1.25)
      : 1 + 0.28 * Math.min(mach, 1.6);
  const thrust =
    (spec.thrustMil * dryFrac + (spec.thrustAB - spec.thrustMil) * abFrac) *
    lapse *
    ram *
    (state.fuel > 0 ? 1 : 0);
  _force.addScaledVector(_fwd, thrust);

  const burn =
    (dryFrac * 0.62 + abFrac * 4.1) * (spec.thrustMil / 100000) * 1.35 * dt;
  state.fuel = Math.max(0, state.fuel - burn);

  // ---- gravity, integrate -------------------------------------------------
  const mass = spec.mass + state.fuel;
  _force.y -= mass * GRAVITY;

  _tmp.copy(_force).divideScalar(mass);

  // Load factor is what the pilot feels: every force except gravity, projected
  // onto the seat back. Gravity went into `_force` a moment ago, so take it
  // back out rather than recomputing the aerodynamic sum.
  _lift.copy(_force);
  _lift.y += mass * GRAVITY;
  const gLoad = _lift.dot(_up) / (mass * GRAVITY);
  state.gLoad = gLoad;

  state.velocity.addScaledVector(_tmp, dt);
  state.position.addScaledVector(state.velocity, dt);

  // Orientation: q' = q + 0.5 * ω ⊗ q * dt, renormalised.
  _spin.set(state.angular.x, state.angular.y, state.angular.z, 0);
  _spin.multiply(q);
  q.x += _spin.x * 0.5 * dt;
  q.y += _spin.y * 0.5 * dt;
  q.z += _spin.z * 0.5 * dt;
  q.w += _spin.w * 0.5 * dt;
  q.normalize();

  // ---- gear ---------------------------------------------------------------
  const gearTarget = controls.gear ? 1 : 0;
  const gearSpeed = dt / 4.2;
  state.gearPos += THREE.MathUtils.clamp(gearTarget - state.gearPos, -gearSpeed, gearSpeed);

  // ---- ground -------------------------------------------------------------
  const ground = env.terrainHeight(state.position.x, state.position.z);
  const gearHeight = spec.height * 0.42 * Math.max(state.gearPos, 0.35);
  let jolt = 0;
  state.impact = 0;
  state.crashed = false;

  if (state.position.y - gearHeight <= ground) {
    const sink = -state.velocity.y;
    const wingsLevel = _up.y > 0.86;
    // Read the attitude off this step's orientation, not off `pitchAttitude`,
    // which is published at the *bottom* of this function and is therefore one
    // step stale. Normally that costs nothing; on the first step after a
    // respawn it is the attitude of the previous flight, which is how a jet
    // parked on Boeing Field came to be judged by the dive it was in when it
    // hit the lake thirty seconds earlier.
    const noseUp = Math.asin(THREE.MathUtils.clamp(_fwd.y, -1, 1));
    const noseOk = Math.abs(noseUp) < 0.28;
    const gentle = sink < 6 && wingsLevel && noseOk && state.gearPos > 0.85;
    // Only the transition from flying to not-flying is an arrival. Evaluating
    // this every frame would call a takeoff roll past 200 knots a crash, and
    // it is the same contact block either way.
    const arriving = !state.onGround;

    state.position.y = ground + gearHeight;

    if (!gentle && (sink > 3.5 || !wingsLevel)) {
      // That was not a landing.
      state.impact = Math.max(1, sink / 6);
      jolt = state.impact;
    }

    // And this was not even a bad landing. The thresholds are deliberately
    // looser than `gentle`: a firm arrival should rattle the airframe and the
    // camera without ending the flight, so there is a band between "ouch" and
    // "scrap". Wheels up is outside it at any speed, and so is water, because
    // nothing here floats.
    if (
      arriving &&
      (sink > 9 ||
        _up.y < 0.72 ||
        Math.abs(noseUp) > 0.42 ||
        state.gearPos < 0.6 ||
        env.isWater?.(state.position.x, state.position.z) === true)
    ) {
      state.crashed = true;
      state.impact = Math.max(state.impact, Math.max(1.4, sink / 5));
      jolt = state.impact;
    }

    if (state.velocity.y < 0) state.velocity.y = 0;
    state.onGround = true;

    // Rolling friction, wheel brakes, and a nosewheel that follows the rudder.
    const groundSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    const rollDrag = (0.028 + controls.wheelBrake * 0.42) * GRAVITY;
    if (groundSpeed > 0.1) {
      const decel = Math.min(groundSpeed, rollDrag * dt);
      state.velocity.x -= (state.velocity.x / groundSpeed) * decel;
      state.velocity.z -= (state.velocity.z / groundSpeed) * decel;
    }

    // Level the aircraft onto its wheels and steer with the rudder.
    _euler.setFromQuaternion(q, "YXZ");
    const steer = controls.yaw * THREE.MathUtils.clamp(1 - groundSpeed / 80, 0.08, 1) * 0.9;
    _euler.y -= steer * dt;
    _euler.x += (0.02 - _euler.x) * Math.min(1, dt * 6);
    _euler.z += (0 - _euler.z) * Math.min(1, dt * 6);
    q.setFromEuler(_euler);
    state.angular.multiplyScalar(Math.max(0, 1 - dt * 5));

    // Once the wheels are rolling fast enough, the wing takes over again.
    if (groundSpeed > 62 && controls.pitch > 0.15) state.onGround = false;
  } else {
    state.onGround = false;
  }

  // ---- publish ------------------------------------------------------------
  state.airspeed = speed;
  state.ias = indicatedAirspeed(speed, air.sigma);
  state.mach = mach;
  state.altitude = state.position.y;
  state.radarAltitude = state.position.y - ground;
  state.alpha = alpha;
  state.beta = beta;
  state.climb = state.velocity.y;
  state.rollRate = p;
  state.pitchRate = qq;
  state.liftDemand = Math.abs(cl) / spec.clMax;
  state.stalled = stallDepth > 0.35;
  state.age += dt;

  _mat.makeRotationFromQuaternion(q);
  _euler.setFromRotationMatrix(_mat, "YXZ");
  state.pitchAttitude = _euler.x;
  state.bank = -_euler.z;
  // North is -Z, so a nose vector of (sin h, 0, -cos h) needs a yaw of -h.
  // This used to read `PI - y`, which is self-consistent with a `trimLevel`
  // that made the same mistake — every test that only compared the two passed,
  // and the jet flew due north when the show line said south.
  state.heading = normalizeAngle(-_euler.y);
  state.gamma = flying ? Math.asin(THREE.MathUtils.clamp(state.velocity.y / speed, -1, 1)) : 0;

  // Physiological G lags the instrument by a couple of seconds — that lag is
  // why a snatched 8 G costs you less vision than a held 6 G.
  const gTau = gLoad > state.gStrain ? 1.9 : 1.1;
  state.gStrain += (gLoad - state.gStrain) * Math.min(1, dt / gTau);

  return { jolt };
}

export function normalizeAngle(a: number): number {
  let x = a % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x;
}

/**
 * Vision loss from sustained G, 0 (fine) .. 1 (out).
 *
 * Positive G drains blood out of the head: grey at about 4.5 sustained,
 * tunnelled by 7, gone past 9. Negative G pushes it the other way and goes
 * red much sooner, which is why nobody holds -3 for long.
 */
export function greyout(gStrain: number): { grey: number; red: number } {
  return {
    grey: THREE.MathUtils.clamp((gStrain - 4.4) / 4.4, 0, 1),
    red: THREE.MathUtils.clamp((-gStrain - 1.4) / 2.2, 0, 1),
  };
}

/**
 * Place an aircraft in trimmed level flight, pointed at a heading.
 *
 * Used by every spawn, every reset, and every time an air-show element needs a
 * jet to exist somewhere sensible.
 */
export function trimLevel(
  state: FlightState,
  spec: AircraftSpec,
  position: THREE.Vector3,
  headingRad: number,
  speed: number,
): void {
  state.position.copy(position);
  const air = atmosphere(position.y);
  const qBar = dynamicPressure(air.density, speed);
  const clNeeded = (spec.mass * GRAVITY) / Math.max(1, qBar * spec.wingArea);

  // Below flying speed there is no such thing as a trimmed attitude, and
  // asking for one gives you the worst possible answer: at zero knots the lift
  // equation wants infinite CL, the clamp hands back 85% of the stall angle,
  // and a Super Hornet parked on Boeing Field spawns pointing thirty degrees
  // at the sky. It used to snap level over the next few frames and look like a
  // pop; now that arriving nose-high is a crash, it detonated on the ramp. A
  // stationary aeroplane sits on its gear — 0.02 rad, the same nose-up rake
  // the ground handler holds it at.
  const alpha =
    speed > 40
      ? THREE.MathUtils.clamp((clNeeded - spec.cl0) / spec.clAlpha, -0.1, spec.stallAlpha * 0.85)
      : 0.02;

  // Yaw is the negation of the compass heading: see the note in `stepFlight`.
  _euler.set(alpha, -headingRad, 0, "YXZ");
  state.orientation.setFromEuler(_euler);
  state.angular.set(0, 0, 0);

  _fwd.copy(BODY_FWD).applyQuaternion(state.orientation);
  // Velocity along the flight path, not the nose: level flight at a positive
  // angle of attack means the jet is flying slightly nose-high.
  state.velocity.set(Math.sin(headingRad) * 0, 0, 0);
  state.velocity.set(_fwd.x, 0, _fwd.z).normalize().multiplyScalar(speed);
  state.power = 0.75;
  state.gLoad = 1;
  state.gStrain = 1;
  state.stalled = false;
  state.onGround = false;
  state.age = 0;
  state.impact = 0;
  state.crashed = false;
  // Publish the derived attitude too. Everything that reads these before the
  // first step — the HUD's first frame, the contact test — would otherwise see
  // the previous flight's numbers.
  state.pitchAttitude = alpha;
  state.bank = 0;
  state.heading = normalizeAngle(headingRad);
  state.alpha = alpha;
  state.gamma = 0;
  state.airspeed = speed;
  state.climb = 0;
}
