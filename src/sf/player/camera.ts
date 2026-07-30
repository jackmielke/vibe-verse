/**
 * camera.ts — the first-person camera rig.
 *
 * The controller decides where the *body* is; this decides where the *eyes*
 * are, and it is where roughly half the perceived quality of a first-person
 * game lives. A capsule sliding along a spline at a fixed eye height reads as
 * a camera on a rail no matter how good the city is. What sells weight is the
 * secondary motion: the head lagging a fraction behind the body, the dip when
 * you land, the lens breathing open as you accelerate into a dive, the roll
 * that follows a wingsuit bank a beat late.
 *
 * Everything here is a critically-damped (or slightly under-damped) spring
 * rather than a keyframed curve, for one reason: springs compose. Landing
 * while being kicked by a rifle while banking out of a swing produces one
 * coherent motion instead of three animations fighting.
 *
 * The rig owns *no* state the simulation needs. It reads `frame`, reads the
 * `drive` block the controller fills in, and writes the camera transform,
 * `frame.fov` and `frame.viewKick`. Delete it and the game still simulates.
 *
 * Public API
 * ----------
 *   cameraRig                     the singleton
 *   rig.drive                     mutable per-frame inputs from the controller
 *   rig.update(dt, camera)
 *   rig.addKick(pitch, yaw, roll) weapon recoil / impacts
 *   rig.addTrauma(t)              damage shake, 0..1
 *   rig.landed(impactSpeed)       landing dip
 *   rig.setVehicle(on, eye?)      smooth blend into and out of a seat
 *   rig.reset()
 */
import * as THREE from "three";
import { PLAYER, WINGSUIT } from "../config";
import { frame } from "../state/store";
import { clamp, clamp01, damp, valueNoise2 } from "../math/rng";
import { QUERY_STATIC, makeRayHit, sphereCast, type RayHit } from "../physics";

/** Per-frame inputs the controller hands the rig. Mutated in place. */
export interface CameraDrive {
  /** Eye height above the capsule centre, metres. Crouch shrinks it. */
  eyeOffset: number;
  /** Horizontal ground speed used for the bob cycle, m/s. */
  bobSpeed: number;
  grounded: boolean;
  /** 0..1 sprint blend — drives FOV and bob amplitude. */
  sprint: number;
  /** 0..1 aim-down-sights blend. */
  ads: number;
  /** 0..1 slide blend: drops the eye and adds a little roll. */
  slide: number;
  /** 0..1 wingsuit speed-rush, from the wingsuit model. */
  rush: number;
  /** 0..1 how submerged the head is; drives the underwater blend. */
  submersion: number;
  /** True while at least one tether is loaded; drives swing lean. */
  swinging: boolean;
  /** Unit vector from the eye toward the swing anchor. */
  swingX: number;
  swingY: number;
  swingZ: number;
  /** Extra roll the flight models want, radians. */
  bankRoll: number;
  /** True while the controller is playing a scripted mantle. */
  mantling: boolean;
}

function makeDrive(): CameraDrive {
  return {
    eyeOffset: PLAYER.eyeHeight - PLAYER.height * 0.5,
    bobSpeed: 0,
    grounded: false,
    sprint: 0,
    ads: 0,
    slide: 0,
    rush: 0,
    submersion: 0,
    swinging: false,
    swingX: 0,
    swingY: 1,
    swingZ: 0,
    bankRoll: 0,
    mantling: false,
  };
}

/* ------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------ */

/**
 * Stride length. A 4.4 m/s walk at 0.82 m per step is about 5.4 steps a
 * second, which is what a jogging human actually does; shorter strides make
 * the bob read as a vibration rather than as footfalls.
 */
const STRIDE = 0.82;
/** Peak vertical head travel at full sprint, metres. Subtle on purpose. */
const BOB_Y = 0.036;
const BOB_X = 0.028;
const BOB_ROLL = 0.0075;

/** Recoil spring: stiff and slightly under-damped so it snaps and settles. */
const KICK_K = 160;
const KICK_C = 17;
/** Landing spring: softer and slower — you feel your knees absorb it. */
const DIP_K = 78;
const DIP_C = 12.5;

/** Camera collision probe radius. A shade under the near plane's diagonal. */
const PROBE_RADIUS = 0.24;

/* ------------------------------------------------------------------ *
 * Module scratch
 * ------------------------------------------------------------------ */

const _eye = new THREE.Vector3();
const _target = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");
const _hit: RayHit = makeRayHit();

export class CameraRig {
  readonly drive: CameraDrive = makeDrive();

  /** World-space eye position after all offsets. Read by the viewmodel. */
  readonly eye = new THREE.Vector3();

  /** Bob cycle phase, radians. Exposed so the viewmodel can march in step. */
  bobPhase = 0;
  /** 0..1 blended bob amplitude — fades in and out of a stop. */
  private bobAmp = 0;

  /* recoil / kick springs (radians) */
  private kickPitch = 0;
  private kickYaw = 0;
  private kickRoll = 0;
  private kickPitchV = 0;
  private kickYawV = 0;
  private kickRollV = 0;

  /* landing dip (metres, negative = down) */
  private dip = 0;
  private dipV = 0;

  /* damage shake */
  private trauma = 0;

  /* smoothed continuous values */
  private roll = 0;
  private fov: number = PLAYER.fov;
  private eyeOffsetSmooth = PLAYER.eyeHeight - PLAYER.height * 0.5;
  private lookLagYaw = 0;
  private lookLagPitch = 0;
  private prevYaw = 0;
  private prevPitch = 0;

  /* vehicle transition */
  private vehicleBlend = 0;
  private vehicleActive = false;
  /**
   * Where the vehicle wants the eye, world space. The vehicle system writes
   * this every frame while seated; look direction stays with `frame.yaw/pitch`
   * so getting in a car never wrenches the player's aim away from them.
   */
  readonly vehicleEye = new THREE.Vector3();

  /** Reset everything transient. Called on respawn and on teleport. */
  reset(): void {
    this.bobPhase = 0;
    this.bobAmp = 0;
    this.kickPitch = this.kickYaw = this.kickRoll = 0;
    this.kickPitchV = this.kickYawV = this.kickRollV = 0;
    this.dip = this.dipV = 0;
    this.trauma = 0;
    this.roll = 0;
    this.fov = PLAYER.fov;
    this.lookLagYaw = this.lookLagPitch = 0;
    this.vehicleBlend = this.vehicleActive ? 1 : 0;
    frame.viewKick.set(0, 0);
  }

  /**
   * Punch the camera. Weapons call this on every shot; explosions call it with
   * a large roll term. Angles in radians — a 5.56 rifle is about (0.012, ±0.004).
   */
  addKick(pitch: number, yaw = 0, roll = 0): void {
    this.kickPitchV += pitch * KICK_K * 0.08;
    this.kickYawV += yaw * KICK_K * 0.08;
    this.kickRollV += roll * KICK_K * 0.08;
  }

  /** Add screen shake. 0.3 is a nearby ricochet, 1.0 is a car exploding on you. */
  addTrauma(t: number): void {
    this.trauma = clamp01(this.trauma + t);
  }

  /** Called by the controller on ground contact. `speed` is the impact m/s. */
  landed(speed: number): void {
    // Below a walking pace a landing should not be felt at all, or every
    // stair step becomes an event.
    if (speed < 3) return;
    const t = clamp01((speed - 3) / (PLAYER.terminalVelocity - 3));
    this.dipV -= 0.9 + t * 5.2;
    this.addKick(-0.02 - t * 0.09, 0, (valueNoise2(frame.time * 3.1, 7.7) * 0.02 * t));
    if (t > 0.35) this.addTrauma(t * 0.45);
  }

  /**
   * Enter or leave a vehicle seat. The blend is a real transition, not a cut:
   * the eye slides from wherever it was into the seat over ~0.4 s, which is
   * the difference between "I got in a car" and "the screen teleported".
   */
  setVehicle(on: boolean, eyeX?: number, eyeY?: number, eyeZ?: number): void {
    this.vehicleActive = on;
    if (eyeX !== undefined) this.vehicleEye.set(eyeX, eyeY ?? 0, eyeZ ?? 0);
  }

  /* ------------------------------------------------------------------ */

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    const d = this.drive;

    /* ---- eye height ---------------------------------------------- */
    // Crouch and slide change the eye height; damping it means the transition
    // reads as the body compressing rather than the camera snapping.
    const wantOffset = d.eyeOffset - d.slide * 0.16;
    this.eyeOffsetSmooth = damp(this.eyeOffsetSmooth, wantOffset, 14, dt);

    /* ---- head bob ------------------------------------------------ */
    const walking = d.grounded && d.bobSpeed > 0.4 && !d.mantling;
    // Two full bumps per stride; the phase runs on distance travelled, so the
    // bob never desynchronises from the feet when you accelerate.
    if (walking) this.bobPhase += (d.bobSpeed / STRIDE) * Math.PI * dt;
    const bobTarget = walking ? clamp01(d.bobSpeed / PLAYER.sprintSpeed) : 0;
    this.bobAmp = damp(this.bobAmp, bobTarget, 8, dt);
    const amp = this.bobAmp * (1 - d.ads * 0.75);
    // |sin| for the vertical so both feet produce a dip, plain sin laterally
    // so the head sways to alternating sides.
    const bobY = -Math.abs(Math.sin(this.bobPhase)) * BOB_Y * amp;
    const bobX = Math.sin(this.bobPhase * 0.5) * BOB_X * amp;
    const bobRoll = Math.sin(this.bobPhase * 0.5) * BOB_ROLL * amp;

    /* ---- springs -------------------------------------------------- */
    this.kickPitchV += (-KICK_K * this.kickPitch - KICK_C * this.kickPitchV) * dt;
    this.kickYawV += (-KICK_K * this.kickYaw - KICK_C * this.kickYawV) * dt;
    this.kickRollV += (-KICK_K * this.kickRoll - KICK_C * this.kickRollV) * dt;
    this.kickPitch += this.kickPitchV * dt;
    this.kickYaw += this.kickYawV * dt;
    this.kickRoll += this.kickRollV * dt;

    this.dipV += (-DIP_K * this.dip - DIP_C * this.dipV) * dt;
    this.dip += this.dipV * dt;
    // Hard floor: a 60 m/s impact must not drive the eye through the pavement.
    if (this.dip < -0.34) {
      this.dip = -0.34;
      if (this.dipV < 0) this.dipV = 0;
    }

    this.trauma = Math.max(0, this.trauma - dt * 1.45);

    /* ---- look lag ------------------------------------------------- */
    // The head does not track the aim instantly. A ~35 ms lag on fast flicks
    // is invisible as latency and reads as mass.
    const dyaw = wrapAngle(frame.yaw - this.prevYaw);
    const dpitch = frame.pitch - this.prevPitch;
    this.prevYaw = frame.yaw;
    this.prevPitch = frame.pitch;
    this.lookLagYaw = damp(this.lookLagYaw + dyaw * 0.22, 0, 16, dt);
    this.lookLagPitch = damp(this.lookLagPitch + dpitch * 0.22, 0, 16, dt);

    /* ---- roll ----------------------------------------------------- */
    // Wingsuit bank, swing lean and slide lean all feed one roll channel.
    let rollTarget = d.bankRoll + bobRoll + d.slide * 0.09;
    if (d.swinging) {
      // Lean into the rope: the component of the anchor direction across the
      // view is what a body under load actually does.
      const lat = d.swingX * frame.right.x + d.swingZ * frame.right.z;
      rollTarget += clamp(lat, -1, 1) * 0.16 * clamp01(frame.speed / 26);
    }
    this.roll = damp(this.roll, rollTarget, 7.5, dt);
    frame.roll = this.roll;

    /* ---- trauma shake --------------------------------------------- */
    const shake = this.trauma * this.trauma;
    let shakePitch = 0;
    let shakeYaw = 0;
    let shakeRoll = 0;
    if (shake > 1e-4) {
      const t = frame.time;
      // Three decorrelated noise channels; value noise rather than sin so the
      // shake never reads as a periodic wobble.
      shakePitch = valueNoise2(t * 31.0, 0.0) * 0.06 * shake;
      shakeYaw = valueNoise2(t * 27.3, 11.0) * 0.06 * shake;
      shakeRoll = valueNoise2(t * 23.7, 23.0) * 0.09 * shake;
    }

    /* ---- assemble the eye ----------------------------------------- */
    _target.copy(frame.position);
    _target.y += this.eyeOffsetSmooth + this.dip;
    _offset.set(0, 0, 0);
    _offset.addScaledVector(frame.right, bobX);
    _offset.y += bobY;
    _target.add(_offset);

    // Camera collision. Sweeping from the capsule centre outward keeps the
    // near plane out of geometry when a swing slams the head into a parapet.
    this.resolveCollision(_target);

    /* ---- vehicle blend -------------------------------------------- */
    this.vehicleBlend = damp(this.vehicleBlend, this.vehicleActive ? 1 : 0, 7, dt);
    if (this.vehicleBlend > 1e-3) {
      _target.lerp(this.vehicleEye, smoothstep01(this.vehicleBlend));
    }

    _eye.copy(_target);
    this.eye.copy(_eye);
    camera.position.copy(_eye);

    /* ---- orientation ---------------------------------------------- */
    const kickP = this.kickPitch + shakePitch;
    const kickY = this.kickYaw + shakeYaw;
    frame.viewKick.set(kickY, kickP);

    const yaw = frame.yaw + kickY - this.lookLagYaw;
    const pitch = clamp(
      frame.pitch + kickP - this.lookLagPitch,
      -Math.PI * 0.5 + 0.015,
      Math.PI * 0.5 - 0.015,
    );
    _euler.set(pitch, yaw, this.roll + this.kickRoll + shakeRoll);
    camera.quaternion.setFromEuler(_euler);

    /* ---- field of view -------------------------------------------- */
    // Three additive sources, then one multiplicative ADS scale:
    //  · sprint gives a small, constant widening;
    //  · airspeed opens the lens as you accelerate, which is what makes a
    //    wingsuit dive feel fast rather than merely be fast;
    //  · terrain proximity ("rush") adds the last few degrees only when you
    //    are actually threading a street.
    const speedT = clamp01((frame.speed - 22) / (WINGSUIT.maxSpeed - 22));
    let fovTarget = PLAYER.fov;
    fovTarget += d.sprint * PLAYER.sprintFovBoost;
    fovTarget += speedT * speedT * 15;
    fovTarget += d.rush * 7;
    fovTarget *= 1 - d.ads * (1 - PLAYER.adsFovScale);
    // Slower opening than closing: the lens should bloom into a dive and snap
    // back the instant you pull out.
    const rate = fovTarget > this.fov ? 3.4 : 6.5;
    this.fov = damp(this.fov, fovTarget, rate, dt);
    frame.fov = this.fov;
    if (Math.abs(camera.fov - this.fov) > 0.01) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }

  /**
   * Keep the eye out of walls.
   *
   * In first person this matters less than in third, but it matters at exactly
   * the moments this game is about: reeling into a facade at 40 m/s, or
   * swinging through a fire escape. A short sphere sweep from the body centre
   * to the eye is cheap and removes the worst of it.
   */
  private resolveCollision(target: THREE.Vector3): void {
    const ox = frame.position.x;
    const oy = frame.position.y;
    const oz = frame.position.z;
    const dx = target.x - ox;
    const dy = target.y - oy;
    const dz = target.z - oz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-4) return;
    if (
      sphereCast(PROBE_RADIUS, ox, oy, oz, dx, dy, dz, dist, _hit, {
        groups: QUERY_STATIC,
        skipSurface: true,
      })
    ) {
      const t = Math.max(0, _hit.distance - 0.02) / dist;
      target.set(ox + dx * t, oy + dy * t, oz + dz * t);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function smoothstep01(t: number): number {
  return t * t * (3 - 2 * t);
}

/** The one camera rig. */
export const cameraRig = new CameraRig();
