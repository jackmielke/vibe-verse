/**
 * Vibe Kart — the drive model: throttle, grip, steering, and drift.
 *
 * This is the feel of the game, so it is worth being explicit about the shape
 * of it. Velocity is decomposed into the body frame every step —
 * (forward, right, up) — and each component is given its own law:
 *
 *   forward  a throttle curve that flattens toward the speed cap, plus brake,
 *            reverse, coast, surface rolling drag, aero drag, scrub from
 *            sliding sideways, and boost.
 *   right    a *slip* model, not a rail. The velocity's angle in the body frame
 *            — the slip angle β — is turned toward a target at a rate set by
 *            surface grip, and that turn rate is capped by how much lateral
 *            acceleration the tyres can make. Crucially it *rotates* the
 *            velocity rather than damping a component of it: a tyre turning a
 *            car does almost no work on it, and a damper that pushes sideways
 *            in the body frame quietly brakes the kart every time it is
 *            sideways — which is exactly when it should feel fastest. What a
 *            slide costs is charged explicitly, below, where it can be tuned.
 *            The turn-rate cap is where understeer comes from: at top speed the
 *            kart cannot make the lateral acceleration the steering is asking
 *            for, so it runs wide. Ice turns slowly and slides; grass washes
 *            out.
 *   up       the suspension (see suspension.ts) and gravity.
 *
 * Drift is the heart of it. Pressing the button hops the kart — a real hop,
 * with air time — and the direction of the steering during that hop locks the
 * drift. From then on the body yaws *outward* of the arc while the lateral
 * damper holds the velocity along it: the lateral target is no longer zero but
 * `v · tan(slip)`, so the kart is genuinely sideways rather than merely
 * animated sideways. Steering modulates both the yaw authority
 * (TUNING.driftSteerInner..Outer) and the slip angle, so counter-steering runs
 * the drift wide and steering into it tightens and kicks the tail out. Charge
 * accumulates faster the deeper the slip, tiers at TUNING.miniTurboTimes, and
 * releasing pays out TUNING.miniTurboBoost. Let go, re-press, and the whole
 * thing re-arms in a single hop.
 */
import * as THREE from "three";
import { SURFACES, TUNING, type BoostSource } from "../types";
import { clamp, clamp01, damp, lerp } from "./math";
import { PHYS, boostStrength } from "./tuning";
import type { Sim } from "./state";

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const gravityDir = new THREE.Vector3();
const negUp = new THREE.Vector3();
const slopeTangent = new THREE.Vector3();
const yawQuat = new THREE.Quaternion();

/** The bits of the outside world the drive model is allowed to touch. */
export interface DriveWorld {
  emit(event: string, payload?: unknown): void;
  applyBoost(sim: Sim, seconds: number, source: BoostSource): void;
  paused: boolean;
}

/** Outputs the caller needs for the suspension and the visual pass. */
export interface DriveResult {
  /** Longitudinal acceleration actually applied, m/s². */
  aLong: number;
  /** Lateral acceleration actually applied, m/s². */
  aLat: number;
  /** Extra pitch to fold into the body attitude, radians. */
  airPitch: number;
}

const result: DriveResult = { aLong: 0, aLat: 0, airPitch: 0 };

/**
 * Advance one racer's drive model by `dt`. Expects `probeWheels` to have run,
 * and leaves the caller to integrate position and call `alignBody`.
 */
export function stepDrive(
  sim: Sim,
  world: DriveWorld,
  dt: number,
  driftEdge: boolean,
  trickEdge: 0 | 1 | -1,
): DriveResult {
  const r = sim.racer;
  const stats = sim.stats;

  tickTimers(sim, dt);

  // ---- controls --------------------------------------------------------
  const stunned = r.stun > 0;
  const frozen = world.paused || r.respawning || r.finished;
  const c = sim.controls;
  let accel = stunned || frozen ? 0 : clamp01(c.accel);
  let brake = stunned || frozen ? 0 : clamp01(c.brake);
  const steerRaw = stunned || frozen ? 0 : clamp(c.steer, -1, 1);
  // Even a locked grid revs: the audio system reads rpm, and a silent countdown
  // is a dead countdown.
  const revving = frozen && !stunned ? clamp01(c.accel) : 0;
  sim.steerSmoothed = damp(sim.steerSmoothed, steerRaw, PHYS.steerSmooth, dt);
  const steer = sim.steerSmoothed;

  // ---- velocity in the body frame ---------------------------------------
  let vLong = r.velocity.dot(sim.forward);
  let vLat = r.velocity.dot(sim.right);
  if (!Number.isFinite(vLong)) vLong = 0;
  if (!Number.isFinite(vLat)) vLat = 0;

  // ---- speed cap --------------------------------------------------------
  const surfSpeed = r.grounded ? sim.speedMul : 1;
  const boosting = r.boost > 0;
  let cap = TUNING.topSpeed * stats.speed * surfSpeed;
  const boostMul = boosting ? boostStrength(r.boostSource) : 0;
  if (r.star > 0) cap *= PHYS.starSpeedMul;
  if (boosting) cap *= 1 + (TUNING.boostSpeedMul - 1) * boostMul;
  if (r.stunKind === "squash") cap *= PHYS.squashSpeedMul;
  else if (r.stunKind === "shock") cap *= PHYS.shockSpeedMul;
  cap = Math.max(2, cap);
  r.maxSpeed = cap;

  // Slip angle of the velocity in the body frame: 0 means the kart is going
  // exactly where it is pointing. Measured once, here, and read by the drift
  // model, the scrub charge and the lateral solver alike.
  const planarIn = Math.hypot(vLong, vLat);
  const beta = vLong > 0.4 && planarIn > 0.6 ? Math.atan2(vLat, vLong) : 0;
  const speedFrac = clamp01(planarIn / cap);

  // ---- drift + hop ------------------------------------------------------
  const drift = updateDrift(sim, world, dt, driftEdge, vLong, speedFrac, steer, beta);

  // ---- tricks -----------------------------------------------------------
  updateTricks(sim, world, dt, trickEdge, driftEdge, steer);

  // ---- yaw --------------------------------------------------------------
  let yawCmd: number;
  if (!r.grounded) {
    yawCmd = -steer * PHYS.airSteer * stats.handling;
  } else if (r.drifting) {
    yawCmd = drift.yawRate;
  } else {
    // Steering authority falls with speed and reverses as the kart rolls
    // backwards. Below walking pace it would fade to nothing — which is how a
    // driver who noses into a barrier ends up wedged there forever, unable to
    // turn because they cannot move and unable to move because they cannot
    // turn. So the throttle also pivots the kart on the spot.
    const rate = TUNING.steerRate * stats.handling * (1 - TUNING.steerSpeedFalloff * speedFrac);
    const rolling = clamp(vLong / 1.6, -1, 1);
    const stalled = 1 - Math.min(1, Math.abs(vLong) / 1.6);
    const pivot = (accel > 0.05 ? 1 : brake > 0.05 ? -1 : 0) * stalled * PHYS.pivotAuthority;
    yawCmd = -steer * rate * (rolling + pivot);
  }
  if (stunned || frozen) yawCmd = 0;
  r.yawRate = damp(r.yawRate, yawCmd, PHYS.yawSmooth, dt);

  let yawDelta = r.yawRate * dt;
  if (r.stunKind === "spin" && r.stun > 0) {
    // A spin-out is a fixed number of turns over TUNING.spinTime, so it always
    // ends facing forwards no matter how it started.
    const spinRate = (Math.PI * 2 * PHYS.spinTurns) / Math.max(0.1, TUNING.spinTime);
    yawDelta += sim.spinDir * spinRate * dt;
    sim.spinAngle += Math.abs(spinRate * dt);
  }
  if (yawDelta !== 0) {
    yawQuat.setFromAxisAngle(sim.up, yawDelta);
    sim.forward.applyQuaternion(yawQuat).normalize();
    sim.right.crossVectors(sim.forward, sim.up).normalize();
    // The velocity split has to be re-read against the rotated frame or the
    // kart quietly gains lateral speed every step.
    vLong = r.velocity.dot(sim.forward);
    vLat = r.velocity.dot(sim.right);
  }

  // ---- gravity ----------------------------------------------------------
  // Level ground gets honest world gravity, so hills push and pull. As the
  // surface tilts past `stickTilt` the kart starts obeying the road instead —
  // which is what holds it in the banked bowl and lets the anti-gravity plating
  // carry it around a vertical wall without inventing a special case for it.
  let stick = r.grounded ? clamp01((1 - sim.up.dot(UP)) / PHYS.stickTilt) : 0;
  if (r.grounded && r.surface === "antigrav") stick = 1;
  negUp.copy(sim.up).multiplyScalar(-1);
  gravityDir.copy(DOWN).lerp(negUp, stick);
  if (gravityDir.lengthSq() < 1e-8) gravityDir.copy(DOWN);
  else gravityDir.normalize();
  r.velocity.addScaledVector(gravityDir, TUNING.gravity * dt);
  if (r.grounded) {
    // Hills are meant to be a challenge, not a tax. Honest gravity down the
    // twenty-degree kicker at the Bluff Jump costs nine metres a second
    // squared — more than a kart can make — which turns every climb into a
    // crawl and leaves the jump physically unmakeable. So: keep the pull into
    // the road exactly as it is, because the suspension and every landing are
    // built on it, and refund most of the component that runs *along* the
    // surface. Slopes still push and pull, just at arcade scale.
    slopeTangent.copy(gravityDir).addScaledVector(sim.up, -gravityDir.dot(sim.up));
    r.velocity.addScaledVector(slopeTangent, -TUNING.gravity * dt * PHYS.slopeAssist);
  }
  // Re-read all three components here, after gravity and after the hop: the
  // recomposition at the end is authoritative, so anything that touched the
  // velocity vector directly has to be folded back in before it happens.
  vLong = r.velocity.dot(sim.forward);
  vLat = r.velocity.dot(sim.right);
  const vUp = r.velocity.dot(sim.up);

  // ---- longitudinal -----------------------------------------------------
  const sgn = vLong > 0.02 ? 1 : vLong < -0.02 ? -1 : 0;
  let aLong = 0;
  const airborne = !r.grounded;
  // A spin-out and a shock are *slides*: the body pirouettes but the momentum
  // keeps the heading it had. Driving them through the longitudinal law would
  // accelerate the kart along a forward axis that is itself rotating — which
  // is how a spin-out ends up doing thirteen metres a second in reverse.
  const sliding = (r.stunKind === "spin" || r.stunKind === "shock") && r.stun > 0;

  if (sliding) {
    aLong = 0;
  } else if (accel > 0) {
    const frac = clamp01(vLong / cap);
    const base = (TUNING.topSpeed / TUNING.accelTime) * stats.accel;
    // Cubic falloff: pulls hard for most of the range and only goes soft in the
    // last fifth, which is what makes a kart feel eager rather than geared.
    aLong += base * accel * (1 - frac * frac * frac * 0.9) * (airborne ? 0.12 : 1);
    if (boosting) aLong += TUNING.boostAccel * boostMul * Math.pow(1 - frac, 0.8) * (airborne ? 0.2 : 1);
  }

  if (brake > 0 && !airborne) {
    if (vLong > PHYS.reverseThreshold) {
      aLong -= TUNING.brakeDecel * brake;
    } else {
      const revCap = TUNING.reverseSpeed * stats.speed * surfSpeed;
      if (vLong > -revCap) {
        aLong -= (TUNING.topSpeed / TUNING.accelTime) * stats.accel * PHYS.reverseAccelMul * brake;
      }
    }
  }

  if (!sliding && accel <= 0 && brake <= 0 && sgn !== 0) aLong -= sgn * TUNING.coastDecel;

  if (!airborne && !sliding) {
    // Rolling resistance of whatever is under the wheels. Boost and slipstream
    // both punch a hole in it, which is most of why they feel fast.
    let roll = sim.drag;
    if (boosting) roll *= PHYS.boostDragMul;
    roll *= 1 - 0.35 * clamp01(r.draft);
    aLong -= sgn * roll;
    // Scrubbing. A held drift costs a little; slip *beyond* what the drift is
    // asking for costs a lot. This is the entire price of sliding, charged in
    // one place, which is what lets it be tuned instead of discovered.
    const excess = Math.max(0, Math.abs(beta) - Math.abs(drift.slipTarget) - PHYS.scrubSlack);
    const bleed = PHYS.slideDrag * Math.sin(Math.abs(beta)) + PHYS.scrubDrag * Math.sin(excess);
    aLong -= sgn * bleed * Math.abs(vLong);
  }
  if (!sliding) aLong -= vLong * Math.abs(vLong) * PHYS.airDrag;

  if (!sliding && Math.abs(vLong) > cap && sgn !== 0) {
    // Boost expiry, a downhill run, an item launch: bleed the overspeed off
    // smoothly rather than clamping, so the speedometer never jumps.
    aLong -= sgn * PHYS.overspeedDecel * clamp01((Math.abs(vLong) - cap) / 6);
  }

  const nextLong = vLong + aLong * dt;
  // Never let deceleration drive the kart through zero into a reverse it did
  // not ask for.
  if (accel <= 0 && brake <= 0 && sgn !== 0 && Math.sign(nextLong) !== sgn) vLong = 0;
  else vLong = clamp(nextLong, -PHYS.speedCeiling, PHYS.speedCeiling);

  // ---- lateral ----------------------------------------------------------
  let gripRate = PHYS.baseGrip * sim.grip * stats.traction;
  if (r.drifting) gripRate *= PHYS.driftGrip;
  if (boosting) gripRate *= PHYS.boostGrip;
  if (r.star > 0) gripRate *= PHYS.starGrip;
  gripRate *= 1 - PHYS.speedUndersteer * speedFrac * speedFrac;
  if (airborne) gripRate = PHYS.airGrip;
  // Spinning: the tyres have nothing to say. The velocity keeps its heading in
  // world space while the body turns underneath it.
  if (sliding) gripRate = 0;

  const latCap =
    PHYS.maxLatAccel *
    (airborne ? 0.25 : sim.grip) *
    stats.traction *
    (r.drifting ? PHYS.driftLatCap : 1);

  let aLat = 0;
  const planar = Math.hypot(vLong, vLat);
  if (vLong > 0.4 && planar > 0.6) {
    // Turn the velocity toward the target slip angle, preserving its magnitude.
    // The cap on how fast it may turn is the tyres' lateral acceleration budget
    // divided by speed — so the faster you go, the wider you run.
    const b = Math.atan2(vLat, vLong);
    const maxTurn = (latCap / planar) * dt;
    let dBeta = (drift.slipTarget - b) * Math.max(0, gripRate) * dt;
    if (dBeta > maxTurn) dBeta = maxTurn;
    else if (dBeta < -maxTurn) dBeta = -maxTurn;
    const nb = b + dBeta;
    vLong = planar * Math.cos(nb);
    vLat = planar * Math.sin(nb);
    aLat = (planar * dBeta) / dt;
  } else {
    // Crawling, stopped or reversing, where the angle is ill-conditioned: a
    // plain damper is better behaved and nobody can tell the difference at
    // walking pace.
    const desired = -vLat * Math.max(0, gripRate);
    aLat = clamp(desired, -latCap, latCap);
    vLat += aLat * dt;
  }

  if (sliding) {
    // Scrub the whole planar velocity down uniformly, which preserves its
    // direction exactly: a spun kart drifts to a halt facing whichever way the
    // pirouette left it, and that is the shot.
    const decay = Math.exp(-(r.stunKind === "spin" ? PHYS.spinDrag : PHYS.shockDrag) * dt);
    vLong *= decay;
    vLat *= decay;
    aLat = 0;
  } else if (world.paused && r.grounded) {
    // Parked on the grid. Eight karts leaning on each other through a long
    // countdown will otherwise shuffle themselves out of formation entirely,
    // one contact impulse at a time.
    const decay = Math.exp(-PHYS.parkedDrag * dt);
    vLong *= decay;
    vLat *= decay;
  }

  // ---- recompose --------------------------------------------------------
  r.velocity
    .copy(sim.forward)
    .multiplyScalar(vLong)
    .addScaledVector(sim.right, vLat)
    .addScaledVector(sim.up, vUp);

  r.speed = vLong;
  r.slipAngle = Math.atan2(vLat, Math.max(0.4, Math.abs(vLong))) * (vLong < 0 ? -1 : 1);
  sim.travel += Math.abs(vLong) * dt;

  // ---- air attitude -----------------------------------------------------
  const pitchTarget = airborne ? clamp(brake - accel, -1, 1) * PHYS.airPitchMax : 0;
  sim.airPitch = damp(sim.airPitch, pitchTarget, airborne ? PHYS.airPitchRate : 12, dt);

  // ---- rpm --------------------------------------------------------------
  r.rpm = damp(r.rpm, engineTarget(r.speed, cap, accel + revving, boosting), 9, dt);
  r.accelG = damp(r.accelG, aLong, 6, dt);

  result.aLong = aLong;
  result.aLat = aLat;
  result.airPitch = sim.airPitch;
  return result;
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

function tickTimers(sim: Sim, dt: number): void {
  const r = sim.racer;
  if (r.boost > 0) {
    r.boost = Math.max(0, r.boost - dt);
    if (r.boost === 0) r.boostSource = null;
  }
  if (r.stun > 0) {
    r.stun = Math.max(0, r.stun - dt);
    if (r.stun === 0) {
      r.stunKind = null;
      sim.spinAngle = 0;
    }
  }
  if (r.invuln > 0) r.invuln = Math.max(0, r.invuln - dt);
  if (r.star > 0) {
    r.star = Math.max(0, r.star - dt);
    if (r.star > 0) r.invuln = Math.max(r.invuln, dt * 2);
  }
  sim.padCooldown = Math.max(0, sim.padCooldown - dt);
  sim.wallCooldown = Math.max(0, sim.wallCooldown - dt);
  sim.offroadCooldown = Math.max(0, sim.offroadCooldown - dt);
  // Squash recovers as a visible pop back to shape rather than a snap.
  r.squash = damp(r.squash, r.stunKind === "squash" ? 0.34 : 1, r.stunKind === "squash" ? 24 : 7, dt);
  r.hop = damp(r.hop, sim.hopping && !r.grounded ? 1 : 0, 14, dt);
}

function engineTarget(speed: number, cap: number, throttle: number, boosting: boolean): number {
  if (boosting) return 1;
  const frac = clamp01(Math.abs(speed) / Math.max(2, cap));
  if (Math.abs(speed) < 0.5) return 0.14 + 0.72 * clamp01(throttle);
  // Four notional gears, so the engine loop has something to climb and drop
  // through instead of a single flat glide from idle to redline.
  const gears = 4;
  const g = Math.min(gears - 1, Math.floor(frac * gears));
  const within = frac * gears - g;
  return clamp01(0.3 + 0.7 * within);
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

interface DriftOut {
  /** Commanded yaw rate about the body up axis, rad/s. */
  yawRate: number;
  /** Target slip angle of the velocity in the body frame, radians. */
  slipTarget: number;
}

const driftOut: DriftOut = { yawRate: 0, slipTarget: 0 };

function updateDrift(
  sim: Sim,
  world: DriveWorld,
  dt: number,
  driftEdge: boolean,
  vLong: number,
  speedFrac: number,
  steer: number,
  beta: number,
): DriftOut {
  const r = sim.racer;
  const stats = sim.stats;
  driftOut.yawRate = 0;
  driftOut.slipTarget = 0;

  const blocked = r.stun > 0 || r.respawning || world.paused || r.finished;

  // --- the hop ------------------------------------------------------------
  if (driftEdge && !blocked && !r.drifting && !sim.hopping && r.grounded) {
    r.velocity.addScaledVector(sim.up, PHYS.hopSpeed - Math.min(0, r.velocity.dot(sim.up)));
    sim.hopping = true;
    sim.hopLeft = false;
    sim.hopTimer = 0;
    sim.hopMute = PHYS.hopMute;
    sim.driftLock = PHYS.driftLockWindow;
    sim.pendingDir = Math.abs(steer) > 0.22 ? (Math.sign(steer) as 1 | -1) : 0;
    sim.coyote = 0;
    r.grounded = false;
  }

  if (sim.hopping) {
    sim.hopTimer += dt;
    sim.driftLock = Math.max(0, sim.driftLock - dt);
    if (!r.grounded) sim.hopLeft = true;
    // Late steering still counts: players commit to the direction as they land.
    if (sim.driftLock > 0 && Math.abs(steer) > 0.22) sim.pendingDir = Math.sign(steer) as 1 | -1;

    const landed = sim.hopLeft && r.grounded;
    if (landed || sim.hopTimer > 1.2) {
      sim.hopping = false;
      if (
        landed &&
        !blocked &&
        sim.controls.drift &&
        sim.pendingDir !== 0 &&
        vLong > PHYS.driftMinSpeed
      ) {
        beginDrift(sim, world, sim.pendingDir);
      }
      sim.pendingDir = 0;
    }
  }

  if (!r.drifting) return driftOut;

  // --- live drift ---------------------------------------------------------
  const cancel =
    blocked ||
    sim.controls.brake > 0.55 ||
    vLong < PHYS.driftDropSpeed ||
    r.airTime > PHYS.driftAirGrace ||
    sim.landImpact > PHYS.driftBreakImpact;

  if (cancel) {
    endDrift(sim, world, false);
    return driftOut;
  }
  if (!sim.controls.drift) {
    endDrift(sim, world, true);
    return driftOut;
  }

  // Steering into the drift (k→1) tightens the arc and deepens the slip;
  // counter-steering (k→0) runs it wide and shallow.
  const k = clamp01((steer * r.driftDir + 1) * 0.5);
  const slip = lerp(PHYS.slipMin, PHYS.slipMax, k);
  const yaw = lerp(TUNING.driftSteerInner, TUNING.driftSteerOuter, k);
  sim.driftRamp = Math.min(1, sim.driftRamp + dt / PHYS.slipRamp);

  // The slide catches itself. Past the target slip the drift's yaw command eases
  // off toward whatever the velocity is actually managing to follow — which is
  // what a driver does with the wheel, and without it a drift held at speed on
  // grippy tarmac diverges into a pirouette: the body can always out-yaw what
  // the tyres can turn the velocity through.
  const over = Math.max(0, Math.abs(beta) - slip * sim.driftRamp - PHYS.driftSlipSlack);
  const catchEase = Math.max(0, 1 - over / PHYS.driftSlipCatch);

  driftOut.yawRate =
    -r.driftDir * yaw * stats.handling * (1 - PHYS.driftYawFalloff * speedFrac) * catchEase;
  // Positive driftDir is a right-hand drift, and in a right-hand drift the
  // velocity sits to the *left* of the nose — hence the sign.
  driftOut.slipTarget = -r.driftDir * slip * sim.driftRamp;

  if (r.grounded) {
    const rate = PHYS.chargeBase + PHYS.chargeSlipGain * k + 0.12 * speedFrac;
    sim.driftTime += dt * rate;
  }

  const times = TUNING.miniTurboTimes;
  const tier = sim.driftTime >= times[2] ? 3 : sim.driftTime >= times[1] ? 2 : sim.driftTime >= times[0] ? 1 : 0;
  if (tier > r.driftTier) {
    r.driftTier = tier as 0 | 1 | 2 | 3;
    world.emit("kart:miniTurbo", { racer: r.id, tier: r.driftTier });
  }
  const lo = tier === 0 ? 0 : times[tier - 1];
  const hi = times[Math.min(2, tier)];
  r.driftCharge = tier >= 3 ? 1 : clamp01((sim.driftTime - lo) / Math.max(0.01, hi - lo));

  return driftOut;
}

function beginDrift(sim: Sim, world: DriveWorld, dir: 1 | -1): void {
  const r = sim.racer;
  r.drifting = true;
  r.driftDir = dir;
  r.driftTier = 0;
  r.driftCharge = 0;
  sim.driftTime = 0;
  sim.driftRamp = 0;
  world.emit("kart:drift", { racer: r.id, charging: true });
}

function endDrift(sim: Sim, world: DriveWorld, payOut: boolean): void {
  const r = sim.racer;
  if (!r.drifting) return;
  const tier = r.driftTier;
  r.drifting = false;
  r.driftDir = 0;
  r.driftTier = 0;
  r.driftCharge = 0;
  sim.driftTime = 0;
  sim.driftRamp = 0;
  world.emit("kart:drift", { racer: r.id, charging: false });
  if (payOut && tier > 0) world.applyBoost(sim, TUNING.miniTurboBoost[tier], "miniTurbo");
}

/** Public so a hit, a respawn or a restart can tear a drift down cleanly. */
export function cancelDrift(sim: Sim, world: DriveWorld): void {
  endDrift(sim, world, false);
  sim.hopping = false;
  sim.pendingDir = 0;
}

// ---------------------------------------------------------------------------
// Tricks
// ---------------------------------------------------------------------------

function updateTricks(
  sim: Sim,
  world: DriveWorld,
  dt: number,
  trickEdge: 0 | 1 | -1,
  driftEdge: boolean,
  steer: number,
): void {
  const r = sim.racer;

  if (!r.grounded && !sim.trickArmed && r.airTime > PHYS.trickMinAir && r.stun <= 0) {
    // The player flicks; the rivals always trick, because a field that does not
    // is a field that looks asleep every time the course jumps.
    const wants = trickEdge !== 0 || driftEdge || (!r.isPlayer && r.airTime > PHYS.aiTrickAir);
    if (wants) {
      sim.trickArmed = true;
      sim.trickTimer = 0;
      sim.trickDir = trickEdge !== 0 ? trickEdge : Math.abs(steer) > 0.3 ? (Math.sign(steer) as 1 | -1) : 1;
      world.emit("kart:trick", { racer: r.id });
    }
  }

  if (sim.trickArmed) {
    sim.trickTimer += dt;
    r.trick = clamp01(sim.trickTimer / PHYS.trickTime);
    if (r.grounded) {
      // Banked on landing, MK-style: the reward is for committing in the air
      // and getting the wheels back down.
      world.applyBoost(sim, PHYS.trickBoost, "trick");
      sim.trickArmed = false;
      sim.trickTimer = 0;
      r.trick = 0;
    }
  } else if (r.trick > 0) {
    r.trick = Math.max(0, r.trick - dt * 4);
  }
}

// ---------------------------------------------------------------------------
// Surface reactions
// ---------------------------------------------------------------------------

/**
 * Boost panels, off-road warnings and the drowning check. Runs after the
 * integration so it sees where the kart actually ended up.
 */
export function surfaceEffects(sim: Sim, world: DriveWorld, dt: number): void {
  const r = sim.racer;
  if (r.respawning) return;

  if (r.onPad && sim.padCooldown <= 0 && !world.paused) {
    world.applyBoost(sim, PHYS.padBoost, "pad");
    sim.padCooldown = PHYS.padCooldown;
  }

  const props = SURFACES[r.surface] ?? SURFACES.road;
  if (r.grounded && props.speed < 0.9 && r.surface !== sim.prevSurface && sim.offroadCooldown <= 0) {
    world.emit("kart:offroad", { racer: r.id, surface: r.surface });
    sim.offroadCooldown = 0.6;
  }
  sim.prevSurface = r.surface;

  // Standing water is survivable for a moment — a splash through the ford is
  // part of the course. The sea is not.
  if (r.grounded && r.surface === "water") sim.drownTimer += dt;
  else sim.drownTimer = Math.max(0, sim.drownTimer - dt * 2);
}
