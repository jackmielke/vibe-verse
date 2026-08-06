/**
 * An unlimited hydroplane, as a thing you can drive.
 *
 * Seafair is a *boat race* that grew an air show, and the air show has had this
 * world to itself for long enough. The boats were already out there running the
 * course as scenery; this is the model that lets you be one of them.
 *
 * ## What makes a hydroplane a hydroplane
 *
 * It is not a boat with a big engine. An unlimited is a **three-point hull**: at
 * speed it rides on two sponson tips and the propeller, with something like a
 * square metre of hull in the water and the rest of it flying. That single fact
 * produces every characteristic worth modelling here:
 *
 *  - **A drag cliff.** Below planing speed it is dragging a hull through water
 *    and the drag is enormous; above it, the drag more than halves. Getting a
 *    boat "on the plane" is a real event you can feel, and it is why the first
 *    ten seconds of a start feel completely different from the rest of a lap.
 *  - **It turns on the water, not on the hull.** Steering authority comes from
 *    the rudder in the prop wash, so it scales with how much water is going
 *    past. Stationary, the wheel does nothing. That is the opposite of a car
 *    and it is the first thing anyone notices.
 *  - **It leans *out* of the turn.** The outboard sponson is the one carrying
 *    the load, so the boat rolls away from the corner. Getting this backwards
 *    makes it look like a motorcycle, which is exactly wrong.
 *  - **It can blow over.** The hull is a wing in ground effect. Get the nose up
 *    at speed — over a wake, or out of a turn too hard — and the air under it
 *    lifts the whole boat, which then goes over backwards. This is *the*
 *    signature accident of the class, everyone who has watched a race has seen
 *    one, and a hydroplane game without it is missing the thing that makes the
 *    class frightening.
 *
 * ## Frames
 * Same world as everything else: Y-up, +X east, −Z north, and a heading of zero
 * is north increasing clockwise. The boat is two dimensional apart from the
 * hull attitude, which is cosmetic until it is not — see `blownOver`.
 *
 * No Three.js in this file. It is arithmetic and it is tested as arithmetic.
 */

/** Everything you can ask a hydroplane to do. */
export interface BoatControls {
  /** 0..1. There is no gearbox and no brake. */
  throttle: number;
  /** -1 left .. +1 right. */
  steer: number;
}

export interface BoatSpec {
  name: string;
  /** Race weight with the driver and fuel, kg. Rule minimum is 6,750 lb. */
  mass: number;
  /** Newtons at the prop, wide open. */
  thrust: number;
  /** Hull drag coefficient below planing speed — most of a hull in the water. */
  dragPlowing: number;
  /** And above it, riding on two sponsons and a propeller. */
  dragPlaning: number;
  /** Metres per second at which it climbs onto the plane. */
  planingSpeed: number;
  /** Peak yaw rate, rad/s, at the speed the rudder likes best. */
  turnRate: number;
  /** Length overall, metres. */
  length: number;
  /** Beam across the sponsons, metres. */
  beam: number;
}

/**
 * The T-55 era turbine boat, which is what runs Seafair now.
 *
 * The numbers that matter are the ones you can check: a Lycoming T-55 makes
 * about 3,000 shaft horsepower, race weight is a shade over 3,000 kg, the
 * straightaway speed is around 320 km/h and a competitive lap of the 3.2 km
 * Seafair course averages about 250 km/h. The thrust figure is chosen to land
 * the top speed there rather than quoted from anywhere.
 */
export const UNLIMITED: BoatSpec = {
  name: "Unlimited",
  mass: 3060,
  thrust: 30500,
  dragPlowing: 9.4,
  dragPlaning: 3.55,
  planingSpeed: 22,
  turnRate: 0.62,
  length: 9.1,
  beam: 4.3,
};

export interface BoatState {
  /** World position. `y` is the water surface; the hull rides just above it. */
  x: number;
  y: number;
  z: number;
  /** Metres per second, always along the heading — a hull does not slide much. */
  speed: number;
  /** Radians, 0 = north, increasing clockwise. */
  heading: number;
  /** Radians per second. */
  yawRate: number;
  /** Roll, radians. Positive = right side down. Leans *out* of a turn. */
  roll: number;
  /** Bow-up attitude, radians. Rises with speed and with the throttle. */
  pitch: number;
  /** 0 below planing speed, 1 fully up on the sponsons. */
  planing: number;
  /**
   * How close the hull is to flying. At 1 the air under it has won and the
   * boat is going over backwards.
   */
  lift: number;
  /** Set once the boat has blown over. Nothing recovers from this. */
  blownOver: boolean;
  /** Seconds since the last reset. */
  age: number;
}

export function createBoatState(): BoatState {
  return {
    x: 0,
    y: 0,
    z: 0,
    speed: 0,
    heading: 0,
    yawRate: 0,
    roll: 0,
    pitch: 0,
    planing: 0,
    lift: 0,
    blownOver: false,
    age: 0,
  };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * How much the rudder is worth at this speed.
 *
 * Zero stopped, because the rudder works in the propeller's wash and there is
 * none; a peak in the middle of the range; and falling away at the top end,
 * where an unlimited genuinely does need most of the lake to change direction.
 */
export function rudderAuthority(speed: number): number {
  if (speed < 1) return 0;
  const rise = clamp(speed / 16, 0, 1);
  const fall = 1 / (1 + Math.pow(speed / 52, 2.2));
  return rise * fall;
}

/** Water surface roughness the boat is currently crossing, 0..1. */
export interface BoatEnvironment {
  /**
   * How churned the water is here — another boat's rooster tail, or the wall
   * of a turn. Feeds the blowover, which is the whole reason it exists.
   */
  wake(x: number, z: number): number;
  /** True if this XZ is still water the boat may be on. */
  onWater(x: number, z: number): boolean;
}

export interface BoatStep {
  /** Metres travelled this step. */
  distance: number;
  /** Set on the step the boat left the water for good. */
  blewOver: boolean;
}

/**
 * One fixed step of hydroplane.
 *
 * Runs at the same 120 Hz as the flight model, for the same reason: a vehicle
 * integrated at frame rate is a different vehicle on every machine.
 */
export function stepBoat(
  s: BoatState,
  spec: BoatSpec,
  c: BoatControls,
  env: BoatEnvironment,
  dt: number,
): BoatStep {
  s.age += dt;

  if (s.blownOver) {
    // Ballistic and tumbling. It is scenery now.
    s.pitch += 2.4 * dt;
    s.roll += 1.1 * dt;
    s.speed = Math.max(0, s.speed - 9 * dt);
    const d = s.speed * dt;
    s.x += Math.sin(s.heading) * d;
    s.z -= Math.cos(s.heading) * d;
    return { distance: d, blewOver: false };
  }

  const throttle = clamp(c.throttle, 0, 1);
  const steer = clamp(c.steer, -1, 1);

  // ---- on the plane, or not -------------------------------------------------
  // A band rather than a step: the transition takes a second or two of real
  // time and you can feel the boat come up.
  const wantPlaning = clamp((s.speed - spec.planingSpeed * 0.45) / (spec.planingSpeed * 0.9), 0, 1);
  s.planing += (wantPlaning - s.planing) * Math.min(1, dt * 1.6);

  // ---- along the axis -------------------------------------------------------
  const drag = spec.dragPlowing + (spec.dragPlaning - spec.dragPlowing) * s.planing;
  // A turn costs speed: the sponson digs and the hull is no longer pointed
  // where it is going.
  const turnDrag = 1 + Math.abs(s.yawRate) * 3.1;
  const accel = (throttle * spec.thrust - drag * s.speed * s.speed * turnDrag) / spec.mass;
  s.speed = Math.max(0, s.speed + accel * dt);

  // ---- around the axis ------------------------------------------------------
  const authority = rudderAuthority(s.speed);
  const wantYaw = steer * spec.turnRate * authority;
  // First-order lag, so the boat takes a moment to set into a corner instead of
  // pivoting on the spot.
  s.yawRate += (wantYaw - s.yawRate) * Math.min(1, dt * 3.4);
  s.heading += s.yawRate * dt;
  if (s.heading > Math.PI) s.heading -= Math.PI * 2;
  if (s.heading < -Math.PI) s.heading += Math.PI * 2;

  // ---- attitude -------------------------------------------------------------
  // Leaning *out* of the corner: the outboard sponson carries the load.
  const wantRoll = -s.yawRate * 0.72;
  s.roll += (wantRoll - s.roll) * Math.min(1, dt * 3.0);
  // Bow-up rises with speed and with power, which is exactly the combination
  // that gets a hydroplane into trouble.
  const wantPitch = s.planing * (0.045 + throttle * 0.055 + s.speed / 2600);
  s.pitch += (wantPitch - s.pitch) * Math.min(1, dt * 2.2);

  // ---- the blowover ---------------------------------------------------------
  // The hull is a wing in ground effect and the lift goes as the square of the
  // speed and with the angle it is presented at. Rough water — somebody else's
  // rooster tail — is what supplies the angle, which is why passing in the
  // wrong place is the dangerous part of a hydroplane race.
  const q = (s.speed * s.speed) / 7000;
  const roughness = env.wake(s.x, s.z);
  const attack = s.pitch + roughness * 0.09;
  // The coefficient is set so that flat-out in clean air sits at about 0.6 —
  // uncomfortable, visible on the warning, and survivable. Rough water is what
  // takes it over the top, which puts the danger where the racing is rather
  // than making the throttle itself the enemy.
  const target = clamp(q * attack * 3.9, 0, 2);
  // Asymmetric: the air gets under it much faster than it lets go again.
  s.lift += (target - s.lift) * Math.min(1, dt * (target > s.lift ? 2.6 : 0.9));

  let blewOver = false;
  if (s.lift >= 1) {
    s.blownOver = true;
    blewOver = true;
  }

  // ---- move -----------------------------------------------------------------
  const distance = s.speed * dt;
  const nx = s.x + Math.sin(s.heading) * distance;
  const nz = s.z - Math.cos(s.heading) * distance;
  if (env.onWater(nx, nz)) {
    s.x = nx;
    s.z = nz;
  } else {
    // Aground. An unlimited that reaches the shore is finished, but stopping it
    // dead here rather than modelling a beaching keeps the failure legible: the
    // caller decides what that means.
    s.speed *= 0.2;
  }

  return { distance, blewOver };
}

/** Put a boat on the water pointed somewhere, stopped. */
export function placeBoat(
  s: BoatState,
  x: number,
  y: number,
  z: number,
  headingRad: number,
): void {
  s.x = x;
  s.y = y;
  s.z = z;
  s.heading = headingRad;
  s.speed = 0;
  s.yawRate = 0;
  s.roll = 0;
  s.pitch = 0;
  s.planing = 0;
  s.lift = 0;
  s.blownOver = false;
  s.age = 0;
}
