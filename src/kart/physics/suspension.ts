/**
 * Vibe Kart — four-corner suspension and ground alignment.
 *
 * The kart is a rigid body with no real inertia tensor: orientation is driven
 * by a spring on the up-vector rather than by torque, which is how every kart
 * game has done it since the N64 and is the only way to get a body that banks
 * into a corner without also being able to end up on its roof. What *is* real
 * is the vertical spring — four independent probes, each pushing along its own
 * surface normal — because that is where the weight of the thing comes from.
 * A kart with no suspension reads as a decal sliding on a plane; a kart that
 * squats on power, dives on the brakes and takes one corner of a kerb reads as
 * an object.
 *
 * The probes sample `track.surfaceAt`, which is analytic: no BVH, no raycast,
 * no allocation. See tuning.ts for the geometry the compressions are expressed
 * in — the model rig depends on it.
 */
import * as THREE from "three";
import { SURFACES, TUNING, type SurfaceSample, type TrackService } from "../types";
import { clamp, clamp01, damp, noise1, safeNormalize, springVec } from "./math";
import { BUMP, DROOP, PHYS, WHEEL_OFFSETS } from "./tuning";
import type { Sim } from "./state";

const UP = new THREE.Vector3(0, 1, 0);
const probePoint = new THREE.Vector3();
const accelAcc = new THREE.Vector3();
const targetUp = new THREE.Vector3();
const normalAcc = new THREE.Vector3();
const basis = new THREE.Matrix4();
const negFwd = new THREE.Vector3();
const pitchAxis = new THREE.Vector3();
const tilt = new THREE.Quaternion();

/**
 * Sample the world under a point. Without a track service we invent a flat
 * tarmac plane at y=0 — a missing course must cost the course, not the game.
 */
function sampleAt(
  track: TrackService | undefined,
  point: THREE.Vector3,
  hint: number,
  out: SurfaceSample,
): SurfaceSample {
  if (!track) {
    out.height = 0;
    out.normal.set(0, 1, 0);
    out.kind = "road";
    out.onTrack = true;
    out.lateral = 0;
    out.t = hint;
    return out;
  }
  return track.surfaceAt(point, hint, out);
}

/**
 * Probe all four corners, aggregate the surface the kart is actually on, and
 * decide whether it is grounded. Writes into `sim.wheels` and the surface
 * summary fields; applies no forces.
 */
export function probeWheels(sim: Sim, track: TrackService | undefined, dt: number): void {
  const r = sim.racer;
  let contacts = 0;
  let grip = 0;
  let speedMul = 0;
  let drag = 0;
  let rattle = 0;
  let deepest = -Infinity;
  let deepKind = sim.prevSurface;
  let onPad = false;
  let onTrack = false;
  let voidCount = 0;
  let voidDepth = Infinity;
  normalAcc.set(0, 0, 0);

  for (let i = 0; i < 4; i++) {
    const w = sim.wheels[i];
    const o = WHEEL_OFFSETS[i];
    probePoint
      .copy(r.position)
      .addScaledVector(sim.right, o[0])
      .addScaledVector(sim.up, o[1])
      .addScaledVector(sim.forward, -o[2]);
    w.point.copy(probePoint);

    const s = sampleAt(track, probePoint, sim.hint, w.sample);
    // `surfaceAt` returns height as "probe.y minus the signed distance to the
    // surface along its normal", so this subtraction is a true clearance even
    // on the vertical anti-gravity plating where a naive drop test is
    // meaningless.
    const clearance = probePoint.y - s.height;
    w.clearance = Number.isFinite(clearance) ? clearance : DROOP;
    w.normal.copy(s.normal);
    if (w.normal.lengthSq() < 0.25) w.normal.copy(UP);
    w.kind = s.kind;
    w.onTrack = s.onTrack;

    if (s.kind === "void") {
      voidCount++;
      if (w.clearance < voidDepth) voidDepth = w.clearance;
    }
    const touching = s.kind !== "void" && w.clearance < DROOP + PHYS.contactSlop && w.clearance > -2;
    w.contact = touching;

    if (touching) {
      contacts++;
      const props = SURFACES[s.kind] ?? SURFACES.road;
      grip += props.grip;
      speedMul += props.speed;
      drag += props.drag;
      rattle += props.rattle;
      normalAcc.addScaledVector(w.normal, 1);
      if (props.boost !== undefined) onPad = true;
      if (s.onTrack) onTrack = true;
      // The most-loaded wheel decides what the kart is "on" for events, spray
      // and audio: straddling a kerb should read as kerb, not as tarmac.
      const load = DROOP - w.clearance;
      if (load > deepest) {
        deepest = load;
        deepKind = s.kind;
      }
    }
  }

  sim.contacts = contacts;
  if (contacts > 0) {
    const inv = 1 / contacts;
    sim.grip = grip * inv;
    sim.speedMul = speedMul * inv;
    sim.drag = drag * inv;
    sim.rattle = rattle * inv;
    safeNormalize(normalAcc, sim.up);
    sim.contactNormal.copy(normalAcc);
    sim.coyote = PHYS.coyoteTime;
    r.surface = deepKind;
    r.groundNormal.copy(sim.contactNormal);
  } else {
    sim.coyote = Math.max(0, sim.coyote - dt);
    sim.grip = 1;
    sim.speedMul = 1;
    sim.drag = 0;
    sim.rattle = 0;
    if (voidCount === 4) r.surface = "void";
  }
  sim.voidDepth = voidCount === 4 ? voidDepth : Infinity;

  r.onPad = onPad;
  const grounded = contacts > 0 || sim.coyote > 0;
  if (grounded) {
    if (!r.grounded) sim.landImpact = 0;
    r.airTime = 0;
  } else {
    r.airTime += dt;
  }
  r.grounded = grounded;
  // `onTrack` is only meaningful while something is touching it.
  if (contacts > 0 && !onTrack && r.surface !== "void") {
    // Off the ribbon but on solid ground — the apron and the wilds.
    sim.rattle = Math.max(sim.rattle, 0.015);
  }
}

/** Apply the spring, the damper and the bump stops. */
export function applySuspension(sim: Sim, dt: number): void {
  const r = sim.racer;
  if (sim.hopMute > 0) {
    // Muted immediately after a hop, so the hop is a hop and not a spring
    // fighting the player for the first tenth of a second.
    sim.hopMute = Math.max(0, sim.hopMute - dt);
    return;
  }
  if (sim.contacts === 0) return;

  accelAcc.set(0, 0, 0);

  for (let i = 0; i < 4; i++) {
    const w = sim.wheels[i];
    if (!w.contact) continue;
    const vn = r.velocity.dot(w.normal);
    // Kerbs, planks and grated metal buzz the chassis. Driven off distance
    // travelled rather than time so the frequency scales with speed, and off a
    // hashed salt so eight karts do not rattle in lockstep.
    const buzz = sim.rattle > 0 ? sim.rattle * noise1(sim.travel * 2.6 + i * 3.1, sim.salt + i) : 0;
    let travel = DROOP - w.clearance + buzz;
    if (travel < 0) travel = 0;

    let force = TUNING.suspensionStiffness * travel - TUNING.suspensionDamping * vn;
    // A spring pushes; it never pulls the kart down onto the road.
    if (force < 0) force = 0;
    accelAcc.addScaledVector(w.normal, force * 0.25);
  }

  r.velocity.addScaledVector(accelAcc, dt);

  // Bump stops: below BUMP the suspension is solid, and letting the chassis
  // sink further is how a kart ends up inside the tarmac after a big landing.
  for (let i = 0; i < 4; i++) {
    const w = sim.wheels[i];
    if (!w.contact || w.clearance >= BUMP) continue;
    const push = BUMP - w.clearance;
    r.position.addScaledVector(w.normal, push * 0.6);
    const vn = r.velocity.dot(w.normal);
    if (vn < 0) r.velocity.addScaledVector(w.normal, -vn * 0.65);
  }
}

/** Per-wheel compression for the model rig, including load transfer. */
export function writeCompression(sim: Sim, aLong: number, aLat: number, dt: number): void {
  const r = sim.racer;
  const span = DROOP - BUMP;
  for (let i = 0; i < 4; i++) {
    const w = sim.wheels[i];
    const front = i < 2;
    const rightSide = i === 1 || i === 3;
    let target = w.contact ? clamp01((DROOP - w.clearance) / span) : 0;
    // Weight shifts backwards on power and forwards on the brakes; and onto the
    // outside pair through a corner. This is the whole reason the kart reads as
    // having mass.
    target += (front ? -1 : 1) * PHYS.squatGain * aLong;
    // Accelerating rightwards throws the load onto the *left* pair, so the sign
    // is the opposite of the one you first reach for.
    target += (rightSide ? -1 : 1) * PHYS.rollGain * aLat;
    target = clamp01(target);
    // The spring already supplies the dynamics; this only smooths the step a
    // wheel takes when it leaves the ground.
    w.compression = damp(w.compression, target, w.contact ? 28 : 9, dt);
    r.wheelCompression[i] = w.compression;
  }
  r.bodyPitch = damp(
    r.bodyPitch,
    clamp(PHYS.pitchGain * aLong, -PHYS.pitchMax, PHYS.pitchMax),
    9,
    dt,
  );
}

/**
 * Rotate the body's up-vector toward the surface with a critically damped
 * spring. In the air the target eases back to world up so a kart that leaves a
 * banked corner does not fly sideways, and the anti-gravity plating works for
 * free: its normal points out of the wall, so the spring simply follows it
 * round.
 */
export function alignBody(sim: Sim, dt: number, airPitch: number): void {
  const r = sim.racer;
  if (r.grounded && sim.contacts > 0) {
    targetUp.copy(sim.contactNormal);
  } else {
    // Ease toward level, slowly — the arc of a jump should keep the launch
    // attitude long enough to read.
    targetUp.copy(sim.up).lerp(UP, clamp01(dt * 1.1)).normalize();
  }

  springVec(sim.up, targetUp, sim.upVel, r.grounded ? PHYS.alignFreq : PHYS.alignFreqAir, dt);
  safeNormalize(sim.up, UP);

  // Keep the frame orthonormal. Forward is authoritative in yaw; up is
  // authoritative in tilt; right falls out of the pair.
  sim.forward.addScaledVector(sim.up, -sim.forward.dot(sim.up));
  if (sim.forward.lengthSq() < 1e-8) {
    // Perfectly aligned with up (a kart pointing straight at the sky) — pick any
    // perpendicular rather than emitting a zero vector into the scene graph.
    sim.forward.set(sim.up.y, -sim.up.x, 0);
    if (sim.forward.lengthSq() < 1e-8) sim.forward.set(0, 0, -1);
  }
  sim.forward.normalize();
  sim.right.crossVectors(sim.forward, sim.up).normalize();

  negFwd.copy(sim.forward).multiplyScalar(-1);
  basis.makeBasis(sim.right, sim.up, negFwd);
  r.quaternion.setFromRotationMatrix(basis);

  // Load-transfer pitch plus whatever the player is doing with the nose in the
  // air, folded in as a local rotation about the body's right axis.
  const pitch = r.bodyPitch + airPitch;
  if (Math.abs(pitch) > 1e-4) {
    pitchAxis.set(1, 0, 0);
    tilt.setFromAxisAngle(pitchAxis, pitch);
    r.quaternion.multiply(tilt);
  }
  r.quaternion.normalize();
}
