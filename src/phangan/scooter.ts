/**
 * The scooter: a 125cc rental, five dollars a day, as a pure step function.
 *
 * Velocity is a vector and heading is a direction, and the two only agree when
 * the tyres grip. Turn hard on dry tarmac and the velocity swings round with
 * you; turn hard on wet tarmac or gravel and it keeps going where it was going
 * for a moment, which is the slide. Lean is derived, not simulated: it is what
 * the rider does with a corner, and the camera copies it.
 *
 * No three import, so `src/test/phangan.test.ts` can drive it.
 */

export interface ScooterState {
  x: number;
  z: number;
  /** Heading in radians; 0 faces -z (north), increasing clockwise seen from above. */
  heading: number;
  vx: number;
  vz: number;
  /** Signed forward speed, m/s. Derived each step; kept for the HUD and the engine note. */
  speed: number;
  /** Lateral slip, m/s. Positive is sliding to the rider's right. */
  slip: number;
  /** Visual lean in radians, positive leans right. */
  lean: number;
  steer: number;
  /** Wheel rotation for the render, radians. */
  wheelSpin: number;
}

export interface ScooterInput {
  /** -1 brake, +1 throttle. */
  throttle: number;
  /** -1 left, +1 right. */
  lean: number;
  boost: boolean;
}

export interface Surface {
  onRoad: boolean;
  wet: boolean;
  /** Slope in the direction of travel; positive is uphill. Rise over run. */
  grade: number;
  /** Energy 0..100. Under a quarter the throttle goes soft. */
  energy: number;
  /** Parked at a checkpoint or by the story. */
  held: boolean;
}

export const SCOOTER = {
  maxSpeed: 23,
  offRoadMax: 8.5,
  boostMul: 1.32,
  accel: 7.5,
  brake: 13,
  reverse: 2.5,
  wheelRadius: 0.27,
};

export function newScooter(x: number, z: number, heading: number): ScooterState {
  return { x, z, heading, vx: 0, vz: 0, speed: 0, slip: 0, lean: 0, steer: 0, wheelSpin: 0 };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function stepScooter(s: ScooterState, input: ScooterInput, surf: Surface, dt: number): ScooterState {
  const out = { ...s };
  const tired = surf.energy < 25 ? 0.45 + (surf.energy / 25) * 0.55 : 1;
  const cap = (surf.onRoad ? SCOOTER.maxSpeed : SCOOTER.offRoadMax) * (input.boost && surf.energy > 0 ? SCOOTER.boostMul : 1) * tired;

  // Steering follows the stick with a little lag, so a tap is a nudge and a hold is a corner.
  const wantSteer = clamp(input.lean, -1, 1);
  out.steer += (wantSteer - out.steer) * Math.min(1, dt * 9);

  // Decompose velocity into the rider's frame.
  let dirX = Math.sin(out.heading);
  let dirZ = -Math.cos(out.heading);
  let perpX = -dirZ;
  let perpZ = dirX;
  let forward = out.vx * dirX + out.vz * dirZ;
  let lateral = out.vx * perpX + out.vz * perpZ;

  // Throttle and brake, minus gravity on the hills.
  let a = 0;
  if (surf.held) {
    a = -forward * 6;
  } else if (input.throttle > 0.05) {
    // The throttle fades out over the last two metres a second, so the cap is a ceiling and not a fight.
    const room = clamp((cap - forward) / 2, 0, 1);
    a = SCOOTER.accel * input.throttle * (input.boost && surf.energy > 0 ? 1.5 : 1) * tired * room;
  } else if (input.throttle < -0.05) {
    if (forward > 0.3) a = -SCOOTER.brake * -input.throttle;
    else a = -SCOOTER.reverse * -input.throttle;
  }
  a -= surf.grade * 9.81 * 0.55;
  a -= 0.008 * forward * Math.abs(forward) + 0.08 * forward;
  if (!surf.onRoad) a -= 1.2 * forward;
  forward += a * dt;
  if (forward > cap) forward = Math.max(cap, forward - 4 * dt);
  if (forward < -SCOOTER.reverse) forward = -SCOOTER.reverse;
  if (Math.abs(forward) < 0.02 && Math.abs(input.throttle) < 0.05) forward = 0;

  // Yaw. A scooter turns with the bars at walking pace and with its lean at speed.
  const speedNorm = clamp(Math.abs(forward) / 6, 0, 1);
  const highSpeed = clamp(1 - Math.abs(forward) / 70, 0.45, 1);
  const yawRate = out.steer * 1.9 * speedNorm * highSpeed * Math.sign(forward || 1);
  out.heading += yawRate * dt;

  // The heading has moved; the velocity has not. Compose it in the old frame,
  // read it back in the new one, and let grip pull the difference round.
  const vx = dirX * forward + perpX * lateral;
  const vz = dirZ * forward + perpZ * lateral;
  dirX = Math.sin(out.heading);
  dirZ = -Math.cos(out.heading);
  perpX = -dirZ;
  perpZ = dirX;
  forward = vx * dirX + vz * dirZ;
  lateral = vx * perpX + vz * perpZ;
  const grip = surf.onRoad ? (surf.wet ? 3.2 : 11) : 2.6;
  lateral *= Math.exp(-grip * dt);
  if (Math.abs(lateral) < 0.01) lateral = 0;

  out.vx = dirX * forward + perpX * lateral;
  out.vz = dirZ * forward + perpZ * lateral;
  out.x += out.vx * dt;
  out.z += out.vz * dt;
  out.speed = forward;
  out.slip = lateral;

  // Lean: into the corner, plus a wobble from the slide.
  const wantLean = clamp(out.steer * (Math.abs(forward) / SCOOTER.maxSpeed) * 0.62 - lateral * 0.03, -0.7, 0.7);
  out.lean += (wantLean - out.lean) * Math.min(1, dt * 6);
  out.wheelSpin += (forward * dt) / SCOOTER.wheelRadius;
  return out;
}

/** Heading of travel for something that needs to face the way it is going. */
export function headingOf(dx: number, dz: number): number {
  return Math.atan2(dx, -dz);
}
