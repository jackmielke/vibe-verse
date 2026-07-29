/**
 * wingsuit.ts — the flight model.
 *
 * A wingsuit is a wing with a person inside it, so this is an aerodynamics
 * model rather than a "fly forward at N m/s" cheat: lift is proportional to
 * airspeed squared and to the lift coefficient at the current angle of attack,
 * drag is parasitic plus induced, and the whole thing stalls when you get slow.
 * That matters because it is what produces the *loop*: you dive to buy speed,
 * you trade speed for altitude by flaring, and when you run out of both you
 * fire the hook. If flight were a constant velocity there would be no reason
 * ever to grapple.
 *
 * Two things are deliberately not simulated:
 *
 *  • **The body does not have its own orientation.** In first person the look
 *    direction *is* the nose. Giving the suit a separate attitude that chases
 *    the camera makes it feel like you are piloting a drone from behind. What
 *    provides the weight instead is `WINGSUIT.pitchRate`/`rollRate`, which cap
 *    how fast the nose can move — you cannot flick 90° in a frame, and that
 *    single clamp is what makes the suit feel like it has mass.
 *
 *  • **Roll steers you.** Real wingsuit pilots turn by banking, and so does
 *    this one: `yawFromRoll` couples bank angle into a yaw rate that also
 *    turns the camera, so holding a bank carves a genuine arc instead of
 *    sliding sideways.
 *
 * Coefficients are normalised against the config values so that the tuning
 * numbers in `config.ts` mean something physical: with `drag` at its reference
 * value a vertical dive terminates at exactly `WINGSUIT.maxSpeed`, and with
 * `lift` at 1.55 a level glide trims at about 12° angle of attack around
 * 45 m/s. Change the config, get a proportional change in the air.
 *
 * Public API
 * ----------
 *   wingsuit                    the singleton
 *   .canDeploy() / .deploy() / .stow()
 *   .update(dt, steer, boost)   integrates one frame of flight into frame.velocity
 *   .active .stall .rush .warning .fuel .bankRoll .airspeed .aoa .glideRatio
 */
import * as THREE from "three";
import { PLAYER, WINGSUIT } from "../config";
import { frame } from "../state/store";
import { WORLD, terrainHeight } from "../geo/sfGeo";
import { clamp, clamp01, damp, smoothstep } from "../math/rng";
import { QUERY_STATIC, makeRayHit, sphereCast, type RayHit } from "../physics";

/* ------------------------------------------------------------------ *
 * Derived coefficients — see the header for why these are not free numbers
 * ------------------------------------------------------------------ */

/** Reference drag from config.ts; everything is expressed relative to it. */
const DRAG_REFERENCE = 0.021;
/**
 * Parasitic drag. Solved from "a vertical dive must terminate at maxSpeed":
 * g = k·v² at v = maxSpeed.
 */
const DRAG_K = (-PLAYER.gravity / (WINGSUIT.maxSpeed * WINGSUIT.maxSpeed)) *
  (WINGSUIT.drag / DRAG_REFERENCE);

/**
 * Lift. Solved from "a level glide trims near 12° AoA at 45 m/s":
 * g = LIFT_K · lift · v² · Cl(0.21 rad).
 */
const LIFT_K = 0.0132;

/** Lift-curve slope, per radian, below the stall break. */
const CL_SLOPE = 2.6;
/** Angle of attack where the wing breaks, radians (~17°). */
const CL_STALL_ANGLE = 0.3;
/** Induced drag factor — the price of pulling hard on the wing. */
const INDUCED_K = 0.00082;

/**
 * Post-stall flat-plate normal force.
 *
 * Past the break the wing stops being an aerofoil and starts being a board
 * held across the airflow, which produces a large force along the body normal
 * (≈ 2·sin²α·q·S). Without this term a deep stall is unrecoverable: lift decays
 * to nothing, the flight path goes vertical, the angle of attack pins at 90°
 * and there is no force left that can ever bring the two back into line. With
 * it, a stalled suit belly-flops, sheds speed and flies again — which is what a
 * stall should be: a mistake with a cost, not a death sentence.
 */
const FLAT_PLATE_K = 0.0032;
/** Extra parasitic drag multiplier when fully stalled — a spoiled wing. */
const STALL_DRAG = 2.2;

/** Sideslip damping: the suit is a poor sideways wing, so kill lateral drift. */
const SIDESLIP_DAMP = 1.35;

/** How close the ground has to be before the speed rush kicks in, metres. */
const RUSH_RANGE = 46;
/** Minimum AGL at which you are allowed to deploy at all. */
const MIN_DEPLOY_AGL = 5;

/* ------------------------------------------------------------------ *
 * Scratch
 * ------------------------------------------------------------------ */

const _vhat = new THREE.Vector3();
const _lift = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _hit: RayHit = makeRayHit();

class WingsuitSystem {
  /** True while the suit is flying. */
  active = false;
  /** 0..1 how deeply stalled. Drives buffet and the nose drop. */
  stall = 0;
  /** 0..1 proximity speed rush — screen effects, FOV and audio read this. */
  rush = 0;
  /** 0..1 ground-proximity warning. 1 means pull up now. */
  warning = 0;
  /** Boost fuel, seconds remaining. */
  fuel: number = WINGSUIT.boostFuel;
  /** True on the frames the thruster is actually burning. */
  burning = false;
  /** Bank angle, radians. Positive is right wing down. */
  bankRoll = 0;
  /** Current airspeed, m/s. */
  airspeed = 0;
  /** Angle of attack, radians. Positive is nose-up relative to the flight path. */
  aoa = 0;
  /** Lift/drag this frame — the number that tells you if you are flying well. */
  glideRatio = 0;
  /** Metres of clearance ahead-and-below. Used by rush + warning. */
  clearance = 999;
  /** Seconds since deploy — the canopy of the suit inflates over the first beat. */
  deployT = 0;

  /** Set true the frame the suit is deployed; consumed by audio/HUD. */
  justDeployed = false;

  /**
   * A wingsuit needs air under it. Refusing to deploy at head height is not
   * fussiness — it stops the player from turning a two-metre hop into flight
   * and skimming the pavement forever.
   */
  canDeploy(): boolean {
    if (this.active) return false;
    if (frame.grounded) return false;
    if (frame.position.y < WORLD.seaLevel + 1) return false;
    return frame.altitudeAGL > MIN_DEPLOY_AGL;
  }

  deploy(): boolean {
    if (!this.canDeploy()) return false;
    this.active = true;
    this.deployT = 0;
    this.stall = 0;
    this.justDeployed = true;
    // Deployment costs a little forward speed — the wing has to inflate — but
    // gives an immediate arrest of the fall so the transition reads as a snap
    // rather than a continued plummet.
    if (frame.velocity.y < -6) frame.velocity.y *= 0.72;
    return true;
  }

  stow(): void {
    this.active = false;
    this.stall = 0;
    this.rush = 0;
    this.warning = 0;
    this.burning = false;
    this.bankRoll = 0;
    this.deployT = 0;
  }

  /** Refuel on the ground / under canopy, so a landing resets the loop. */
  rest(dt: number): void {
    this.fuel = Math.min(WINGSUIT.boostFuel, this.fuel + WINGSUIT.boostRefill * dt * 2.4);
    this.bankRoll = damp(this.bankRoll, 0, 6, dt);
    this.rush = damp(this.rush, 0, 6, dt);
    this.warning = 0;
  }

  /**
   * Clamp how fast the nose can move. Called by the controller *before* it
   * commits the frame's look delta, so the cap applies to mouse, stick and
   * thumb identically.
   */
  limitLook(dYaw: number, dPitch: number, dt: number, out: THREE.Vector2): void {
    const maxPitch = WINGSUIT.pitchRate * dt;
    const maxYaw = WINGSUIT.rollRate * dt * 0.7;
    out.x = clamp(dYaw, -maxYaw, maxYaw);
    out.y = clamp(dPitch, -maxPitch, maxPitch);
  }

  /**
   * One frame of flight.
   *
   * `steer` is -1..1 roll input; `boost` is the thruster. Mutates
   * `frame.velocity` and `frame.yaw` (bank-induced turn).
   */
  update(dt: number, steer: number, boost: boolean): void {
    if (!this.active) {
      this.rest(dt);
      return;
    }
    this.deployT += dt;
    this.justDeployed = false;

    const vel = frame.velocity;
    const fwd = frame.forward;
    const right = frame.right;
    const up = frame.up;

    /* ---- bank ------------------------------------------------------ */
    // Roll is rate-limited toward the stick, and washes out on its own so
    // letting go returns you to wings-level like a real dihedral aircraft.
    const wantRoll = clamp(steer, -1, 1) * 0.95;
    const rollDelta = clamp(wantRoll - this.bankRoll, -1, 1) * WINGSUIT.rollRate * dt;
    this.bankRoll = clamp(this.bankRoll + rollDelta, -1.15, 1.15);
    if (Math.abs(steer) < 0.05) this.bankRoll = damp(this.bankRoll, 0, 2.4, dt);

    /* ---- speed + angle of attack ----------------------------------- */
    let v = vel.length();
    if (v < 0.5) {
      // Stepping off a ledge at zero speed: seed the airflow from the nose so
      // the first frame has a defined angle of attack.
      _vhat.copy(fwd);
      v = 0.5;
    } else {
      _vhat.copy(vel).multiplyScalar(1 / v);
    }
    this.airspeed = v;

    const cosA = _vhat.dot(fwd);
    const sinA = -_vhat.dot(up);
    const aoa = Math.atan2(sinA, Math.max(0.05, cosA));
    this.aoa = aoa;

    /* ---- stall ------------------------------------------------------ */
    // Two ways to stall: too slow, or too much angle of attack. Both collapse
    // the same lift term, and both drop the nose.
    const slowStall = 1 - smoothstep(WINGSUIT.stallSpeed * 0.6, WINGSUIT.stallSpeed, v);
    const aoaStall = smoothstep(CL_STALL_ANGLE, CL_STALL_ANGLE + 0.35, Math.abs(aoa));
    this.stall = clamp01(Math.max(slowStall, aoaStall));

    /* ---- lift ------------------------------------------------------- */
    let cl: number;
    const absA = Math.abs(aoa);
    if (absA <= CL_STALL_ANGLE) {
      cl = aoa * CL_SLOPE;
    } else {
      // Past the break the coefficient decays instead of climbing — this is
      // the bit that makes yanking the nose up cost you the wing.
      const over = absA - CL_STALL_ANGLE;
      cl = Math.sign(aoa) * CL_STALL_ANGLE * CL_SLOPE * Math.exp(-over * 2.6);
    }
    const inflate = smoothstep(0, 0.35, this.deployT);
    const liftMag = LIFT_K * WINGSUIT.lift * v * v * cl * (1 - this.stall * 0.85) * inflate;

    // Lift acts perpendicular to the airflow, in the plane of the body's up.
    _lift.copy(up).addScaledVector(_vhat, -up.dot(_vhat));
    const ll = _lift.length();
    if (ll > 1e-4) _lift.multiplyScalar(1 / ll);
    else _lift.set(0, 1, 0);
    vel.addScaledVector(_lift, liftMag * dt);

    /* ---- drag ------------------------------------------------------- */
    const parasitic = DRAG_K * v * v * (1 + this.stall * STALL_DRAG);
    const induced = INDUCED_K * cl * cl * v * v;
    // Soft ceiling: past maxSpeed drag climbs steeply rather than clamping,
    // so terminal velocity is approached instead of hit.
    const over = Math.max(0, v - WINGSUIT.maxSpeed);
    const overspeed = over * over * 0.05;
    const dragMag = parasitic + induced + overspeed;
    vel.addScaledVector(_vhat, -dragMag * dt);
    this.glideRatio = dragMag > 1e-4 ? Math.abs(liftMag) / dragMag : 0;

    /* ---- post-stall flat plate --------------------------------------- */
    if (aoaStall > 1e-3) {
      const plate = FLAT_PLATE_K * v * v * sinA * Math.abs(sinA) * aoaStall;
      vel.addScaledVector(up, plate * dt);
    }

    /* ---- sideslip ---------------------------------------------------- */
    // A wingsuit has almost no lateral surface; without this you drift like a
    // hovercraft and banked turns never bite.
    const lateral = vel.dot(right);
    vel.addScaledVector(right, -lateral * SIDESLIP_DAMP * dt);

    /* ---- bank-induced yaw -------------------------------------------- */
    // Carving. Scaled by airspeed because a stalled suit cannot turn.
    const turnAuthority = clamp01(v / (WINGSUIT.stallSpeed * 1.6)) * (1 - this.stall * 0.7);
    frame.yaw -= Math.sin(this.bankRoll) * WINGSUIT.yawFromRoll * turnAuthority * dt;

    /* ---- stall nose drop ---------------------------------------------- */
    if (this.stall > 0.25) {
      // The nose falls through on its own. It is not a punishment, it is the
      // recovery: pointing down is how you get your airspeed back. The rate is
      // in 1/s — folding dt in here as well (an easy mistake) makes the
      // recovery a hundred times too weak to escape a deep stall.
      const rate = (this.stall - 0.25) * 5.0;
      frame.pitch = damp(frame.pitch, -0.75, rate, dt);
    }

    /* ---- boost -------------------------------------------------------- */
    this.burning = false;
    if (boost && this.fuel > 0) {
      this.fuel = Math.max(0, this.fuel - dt);
      this.burning = true;
      vel.addScaledVector(fwd, WINGSUIT.boostAccel * dt);
    } else if (!boost) {
      this.fuel = Math.min(WINGSUIT.boostFuel, this.fuel + WINGSUIT.boostRefill * dt);
    }

    /* ---- proximity ----------------------------------------------------- */
    this.updateProximity(dt, v);

    /* ---- exit conditions ------------------------------------------------ */
    if (frame.position.y <= WORLD.seaLevel + 0.5) this.stow();
  }

  /**
   * How close is the world?
   *
   * Two samples: the vertical AGL (cheap, always available) and a forward
   * sphere sweep along the flight path (which is what actually matters when
   * you are threading Market Street between buildings). The rush term is what
   * turns "going fast" into "going fast *past things*", which is the entire
   * sensation the wingsuit exists to deliver.
   */
  private updateProximity(dt: number, v: number): void {
    const agl = frame.altitudeAGL;
    let clear = agl;

    if (v > 8) {
      _tmp.copy(frame.velocity).multiplyScalar(1 / v);
      const look = Math.min(90, v * 1.1);
      if (
        sphereCast(1.4, frame.position.x, frame.position.y, frame.position.z,
          _tmp.x, _tmp.y, _tmp.z, look, _hit, { groups: QUERY_STATIC, skipSurface: true })
      ) {
        clear = Math.min(clear, _hit.distance);
      }
    }
    this.clearance = clear;

    const speedT = clamp01((v - WINGSUIT.stallSpeed) / (WINGSUIT.maxSpeed - WINGSUIT.stallSpeed));
    const nearT = 1 - clamp01(clear / RUSH_RANGE);
    // Squared speed term: the rush should be almost absent at a lazy glide and
    // overwhelming at 90 m/s two metres off a rooftop.
    const target = clamp01(speedT * speedT * (0.35 + 0.65 * nearT));
    // Fast attack, slow release — the sensation should linger a beat after you
    // clear the obstacle, which is how it feels in the body.
    this.rush = damp(this.rush, target, target > this.rush ? 9 : 3.2, dt);

    // Ground-proximity warning: only when you are actually going to hit it.
    const sinking = frame.velocity.y < -4;
    const groundClose = agl < WINGSUIT.pullWarning;
    const impactSoon = clear < Math.max(24, v * 0.9);
    this.warning = groundClose && (sinking || impactSoon) ? clamp01(1 - agl / WINGSUIT.pullWarning) : 0;
  }

  /** Terrain height under the player, for systems that do not want sfGeo. */
  groundBelow(): number {
    return terrainHeight(frame.position.x, frame.position.z);
  }
}

/** The one wingsuit. */
export const wingsuit = new WingsuitSystem();
export type { WingsuitSystem };
