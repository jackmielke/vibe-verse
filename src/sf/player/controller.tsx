/**
 * controller.tsx — the movement state machine.
 *
 * One integrator, one authority. Every traversal system in this directory
 * (grapple, wingsuit, parachute) is a *force contributor*: it is handed the
 * velocity vector, it adds accelerations to it, and this file does the single
 * integration, the single collision resolve and the single write into `frame`.
 * That is deliberate. The alternative — each system moving the player itself —
 * is how you end up with a wingsuit that fights a tether, or a mantle that
 * teleports you out of a swing.
 *
 * States: grounded / airborne / wingsuit / parachute / grappling / swimming /
 * vehicle / dead. They are not classes with their own update loops; they are a
 * classification computed at the end of each frame from what actually
 * happened, which means they can never disagree with the simulation.
 *
 * The things in here that are not obvious, and why they exist:
 *
 *  • **Coyote time and jump buffering.** 120 ms and 150 ms respectively. These
 *    two numbers are the difference between "the jump didn't register" and a
 *    game that feels responsive. Nobody notices them; everybody notices their
 *    absence.
 *
 *  • **Hill-aware footing.** San Francisco's streets hit 31% grade. Running up
 *    Filbert at the same speed as running down it looks broken, so the target
 *    speed is scaled by the component of the wish direction against the ground
 *    normal, and the wish direction is projected into the ground plane so you
 *    do not launch off every downhill.
 *
 *  • **Auto-mantle.** The ledge probe runs whenever you are moving into
 *    something climbable, not only when you press jump. In a game about
 *    rooftops, being stopped by a parapet you could obviously climb is the
 *    single most frustrating failure available.
 *
 *  • **Quadratic air drag.** Tuned so freefall terminates exactly at
 *    `PLAYER.terminalVelocity` rather than accelerating forever, which also
 *    means fall damage has a well-defined worst case.
 *
 * Public API
 * ----------
 *   playerCtrl                        the singleton
 *   .init(x, y, z, heading)
 *   .update(dt, camera)               call once per frame
 *   .respawn(x, y, z, heading)
 *   .enterVehicle(id) / .exitVehicle(x, y, z)
 *   .setVehicleSeat(x, y, z)          vehicle system writes the eye each frame
 *   .stamina .health .sprintBlend .adsBlend
 */
import * as THREE from "three";
import { PLAYER, WINGSUIT } from "../config";
import { frame, sf, useSfStore } from "../state/store";
import { WORLD, clampToWorld, walkableHeight } from "../geo/sfGeo";
import { clamp, clamp01, damp } from "../math/rng";
import {
  makeLedgeInfo,
  playerController as charCtrl,
  type LedgeInfo,
} from "../physics";
import { postFx } from "../postfx/state";
import { cameraRig } from "./camera";
import { grappleSystem } from "./grapple";
import { input } from "./input";
import { parachute } from "./parachute";
import { wingsuit } from "./wingsuit";

/* ------------------------------------------------------------------ *
 * Locomotion tuning that is specific to the character and would only be
 * noise in config.ts
 * ------------------------------------------------------------------ */

/** Ground acceleration, m/s². Reaches sprint speed in about a fifth of a second. */
const GROUND_ACCEL = 62;
/** Ground deceleration when there is no input. Deliberately snappier than accel. */
const GROUND_DECEL = 52;
/** Air acceleration before `PLAYER.airControl` scales it. */
const AIR_ACCEL = 34;
/** Coyote window: you may still jump this long after walking off a ledge. */
const COYOTE_TIME = 0.12;
/** Jump buffer: a jump pressed this long before landing still fires. */
const JUMP_BUFFER = 0.15;
/** Quadratic air drag, solved so freefall terminates at PLAYER.terminalVelocity. */
const AIR_DRAG_K = -PLAYER.gravity / (PLAYER.terminalVelocity * PLAYER.terminalVelocity);
/** Slide duration cap, seconds. */
const SLIDE_TIME = 0.95;
/** Slide friction, 1/s. Low, so a slide down Lombard actually goes somewhere. */
const SLIDE_FRICTION = 1.15;
/** Minimum speed to enter a slide. */
const SLIDE_MIN_SPEED = PLAYER.walkSpeed * 1.12;
/** Slope past which you slide rather than stand, radians. */
const SLIDE_SLOPE = (47 * Math.PI) / 180;

/** Fall damage curve: damage = K * (impact - safe) ^ P. */
const FALL_DAMAGE_K = 2.84;
const FALL_DAMAGE_P = 1.3;
/** Speed at which slamming into a wall hurts, m/s. */
const WALL_IMPACT_SPEED = 34;

/* swimming */
const SWIM_SPEED = 3.3;
const SWIM_SPRINT_SPEED = 4.8;
/** Buoyancy pushes you toward the surface, m/s². */
const BUOYANCY = 16;
const STAMINA_DRAIN_SWIM = 0.034;
const STAMINA_DRAIN_SPRINT = 0.098;
const STAMINA_REGEN = 0.26;
/** Health per second lost once stamina is gone and you are under. */
const DROWN_RATE = 9;

/* ------------------------------------------------------------------ *
 * Scratch
 * ------------------------------------------------------------------ */

const _wish = new THREE.Vector3();
const _fwdFlat = new THREE.Vector3();
const _rightFlat = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _anchorDir = new THREE.Vector3();
const _look = new THREE.Vector2();
const _ledge: LedgeInfo = makeLedgeInfo();

interface MantleState {
  active: boolean;
  t: number;
  duration: number;
  fromX: number;
  fromY: number;
  fromZ: number;
  toX: number;
  toY: number;
  toZ: number;
}

export class PlayerController {
  /* ---- timers and blends ---- */
  private coyote = 0;
  private jumpBuffered = 0;
  private grappleHeld = 0;
  private sinceGround = 0;
  private fallPeak = 0;
  private lastDamageTime = -100;
  private healAccum = 0;
  private crouched = false;
  private slideT = 0;
  private sliding = false;
  private wasGrounded = false;

  sprintBlend = 0;
  adsBlend = 0;
  /** 0..1 swimming stamina. */
  stamina = 1;
  /** Cached health so we can detect an external hit without a subscription. */
  private lastHealth: number = PLAYER.maxHealth;
  private drownAccum = 0;

  private mantle: MantleState = {
    active: false, t: 0, duration: 0,
    fromX: 0, fromY: 0, fromZ: 0, toX: 0, toY: 0, toZ: 0,
  };

  /** Set true once the capsule has been placed. */
  private spawned = false;

  /* ---------------- lifecycle ---------------- */

  init(x: number, y: number, z: number, heading: number): void {
    frame.position.set(x, y, z);
    frame.velocity.set(0, 0, 0);
    frame.yaw = heading;
    frame.pitch = 0;
    charCtrl.setPosition(x, y, z);
    this.spawned = true;
    this.reset();
  }

  respawn(x: number, y: number, z: number, heading: number): void {
    grappleSystem.clearAll();
    wingsuit.stow();
    parachute.cutaway();
    this.init(x, y, z, heading);
    cameraRig.reset();
    useSfStore.getState().respawn();
    this.lastHealth = PLAYER.maxHealth;
  }

  private reset(): void {
    this.coyote = 0;
    this.jumpBuffered = 0;
    this.fallPeak = 0;
    this.sliding = false;
    this.slideT = 0;
    this.crouched = false;
    this.stamina = 1;
    this.mantle.active = false;
    this.sprintBlend = 0;
    this.adsBlend = 0;
    charCtrl.setCrouch(false);
  }

  /* ---------------- vehicles ---------------- */

  /**
   * Hand control to the vehicle system. The capsule stops simulating; the
   * camera blends into the seat over ~0.4 s. The vehicle system is expected to
   * call `setVehicleSeat` every frame after this.
   */
  enterVehicle(id: number): void {
    frame.vehicleId = id;
    grappleSystem.clearAll();
    wingsuit.stow();
    parachute.cutaway();
    cameraRig.setVehicle(true, frame.position.x, frame.position.y + 0.8, frame.position.z);
  }

  /** Where the seat's eye is, world space. Called by the vehicle system. */
  setVehicleSeat(x: number, y: number, z: number): void {
    cameraRig.vehicleEye.set(x, y, z);
  }

  exitVehicle(x: number, y: number, z: number): void {
    frame.vehicleId = null;
    frame.position.set(x, y, z);
    charCtrl.setPosition(x, y, z);
    cameraRig.setVehicle(false);
    this.sinceGround = 0;
    this.fallPeak = 0;
  }

  /* ---------------- the frame ---------------- */

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    // Menus and photo mode own the input; the world keeps rendering.
    if (frame.paused) {
      input.update(dt, this.adsBlend);
      input.endFrame();
      cameraRig.update(dt, camera);
      return;
    }

    input.update(dt, this.adsBlend);

    const st = sf();
    const dead = st.health <= 0 || st.phase === "dead";
    this.syncHealth(dt, st.health, dead);

    /* ---- look ---------------------------------------------------- */
    this.applyLook(dt, dead);

    /* ---- capsule bookkeeping -------------------------------------- */
    if (!charCtrl.ready) charCtrl.spawn(frame.position.x, frame.position.y, frame.position.z);
    // Anything that teleported the player (level load, cutscene, the shot
    // harness) moves `frame.position` behind our back. Re-seat the capsule
    // instead of letting the two drift apart.
    const drift = Math.abs(charCtrl.position[0] - frame.position.x) +
      Math.abs(charCtrl.position[1] - frame.position.y) +
      Math.abs(charCtrl.position[2] - frame.position.z);
    if (!this.spawned || drift > 4) {
      charCtrl.setPosition(frame.position.x, frame.position.y, frame.position.z);
      this.spawned = true;
    }

    if (frame.vehicleId !== null) {
      this.updateVehicle(dt, camera);
      input.endFrame();
      return;
    }

    /* ---- traversal verbs ------------------------------------------ */
    if (!dead) this.handleTraversalInput(dt);
    else this.releaseAllVerbs();

    /* ---- forces ---------------------------------------------------- */
    _vel.copy(frame.velocity);
    const grounded = frame.grounded;

    if (dead) {
      this.applyGravity(dt, _vel, 1);
      this.applyAirDrag(dt, _vel);
    } else if (this.mantle.active) {
      _vel.set(0, 0, 0);
    } else if (charCtrl.result.swimming) {
      this.swim(dt, _vel);
    } else if (parachute.active) {
      frame.velocity.copy(_vel);
      parachute.update(dt, this.steerX(), input.snapshot.moveZ, this.flareInput());
      _vel.copy(frame.velocity);
      this.airMove(dt, _vel, 0.35);
    } else if (wingsuit.active) {
      this.applyGravity(dt, _vel, 1);
      frame.velocity.copy(_vel);
      wingsuit.update(dt, this.steerX(), input.held("boost"));
      _vel.copy(frame.velocity);
    } else if (grounded) {
      this.groundMove(dt, _vel);
    } else {
      this.applyGravity(dt, _vel, 1);
      this.applyAirDrag(dt, _vel);
      this.airMove(dt, _vel, 1);
    }

    /* ---- tethers ---------------------------------------------------- */
    // Grapple forces come last so they can override the locomotion model —
    // reeling out of a slide, or swinging while the wingsuit is deployed.
    grappleSystem.update(dt);
    if (!dead) grappleSystem.applyToPlayer(dt, frame.position, _vel);

    /* ---- integrate + collide ---------------------------------------- */
    frame.velocity.copy(_vel);
    this.integrate(dt, dead);

    /* ---- classify + present ------------------------------------------ */
    this.classify(dead);
    this.updateCameraDrive(dt, dead);
    cameraRig.update(dt, camera);
    this.updateHudFeedback();

    input.endFrame();
  }

  /* ---------------- look ---------------- */

  private applyLook(dt: number, dead: boolean): void {
    const s = input.snapshot;
    let dy = s.lookYaw;
    let dp = s.lookPitch;
    if (dead) {
      dy *= 0.25;
      dp *= 0.25;
    } else if (wingsuit.active) {
      // The suit has mass: the nose cannot be flicked around.
      wingsuit.limitLook(dy, dp, dt, _look);
      dy = _look.x;
      dp = _look.y;
    } else if (parachute.active) {
      dy *= 0.75;
      dp *= 0.8;
    }
    frame.yaw += dy;
    frame.pitch = clamp(frame.pitch + dp, -Math.PI * 0.5 + 0.02, Math.PI * 0.5 - 0.02);
    this.refreshBasis();
  }

  /** Rebuild the camera basis so everything downstream sees this frame's aim. */
  private refreshBasis(): void {
    const cy = Math.cos(frame.yaw);
    const sy = Math.sin(frame.yaw);
    const cp = Math.cos(frame.pitch);
    const sp = Math.sin(frame.pitch);
    frame.forward.set(-sy * cp, sp, -cy * cp).normalize();
    frame.right.set(cy, 0, -sy).normalize();
    frame.up.crossVectors(frame.right, frame.forward).normalize();
  }

  /* ---------------- input → verbs ---------------- */

  private steerX(): number {
    return input.snapshot.moveX;
  }

  private flareInput(): number {
    return Math.max(input.analog("flare"), input.held("crouch") ? 1 : 0);
  }

  private releaseAllVerbs(): void {
    grappleSystem.setReeling(false);
    this.grappleHeld = 0;
  }

  private handleTraversalInput(dt: number): void {
    /* ---- grapple ---- */
    if (input.pressed("grapple")) {
      grappleSystem.fire("swing");
      this.grappleHeld = 0;
    }
    if (input.held("grapple")) {
      this.grappleHeld += dt;
    } else {
      this.grappleHeld = 0;
    }
    // Holding the hook button after it bites reels. The 0.12 s gate stops a
    // quick tap-to-swing from also yanking you off the arc.
    const reelWanted =
      input.held("reel") || (this.grappleHeld > 0.12 && input.held("grapple"));
    grappleSystem.setReeling(reelWanted && grappleSystem.anyLoaded);

    if (input.pressed("tetherLink")) grappleSystem.link();
    if (input.pressed("cut")) grappleSystem.cutAll(true);

    /* ---- explicit flight toggles ---- */
    if (input.pressed("wingsuit")) {
      if (wingsuit.active) wingsuit.stow();
      else {
        parachute.cutaway();
        wingsuit.deploy();
      }
    }
    if (input.pressed("parachute")) {
      if (parachute.active) parachute.cutaway();
      else {
        wingsuit.stow();
        parachute.deploy();
      }
    }

    /* ---- the space bar chain ---- */
    // Ground → jump. Air → wingsuit → parachute → cut back to freefall.
    // One button covers the entire traversal vocabulary, which is why this
    // game can be played with a thumb on a phone.
    if (input.pressed("jump")) {
      if (frame.grounded || this.coyote > 0 || charCtrl.result.swimming) {
        // Swimming counts: at the surface, jump is a lunge, not a wingsuit.
        this.jumpBuffered = JUMP_BUFFER;
      } else if (parachute.active) {
        parachute.cutaway();
        // Cutting away straight back into flight keeps the chain alive.
        if (!wingsuit.deploy()) {
          /* freefall */
        }
      } else if (wingsuit.active) {
        wingsuit.stow();
        parachute.deploy();
      } else if (!this.tryMantle()) {
        if (!wingsuit.deploy()) parachute.deploy();
      }
    } else if (this.jumpBuffered > 0) {
      this.jumpBuffered -= dt;
    }

    /* ---- crouch / slide ---- */
    const wantCrouch = input.held("crouch") && !wingsuit.active && !parachute.active;
    if (wantCrouch && !this.crouched && frame.grounded) {
      const speed = Math.hypot(frame.velocity.x, frame.velocity.z);
      if (speed > SLIDE_MIN_SPEED && !this.sliding) {
        this.sliding = true;
        this.slideT = SLIDE_TIME;
        // A slide is a commitment: you get a shove for entering it.
        const inv = 1 / Math.max(1e-3, speed);
        frame.velocity.x += frame.velocity.x * inv * 2.6;
        frame.velocity.z += frame.velocity.z * inv * 2.6;
      }
    }
    if (wantCrouch !== this.crouched) {
      if (charCtrl.setCrouch(wantCrouch)) this.crouched = wantCrouch;
    }
    if (this.sliding) {
      this.slideT -= dt;
      const speed = Math.hypot(frame.velocity.x, frame.velocity.z);
      if (this.slideT <= 0 || !wantCrouch || speed < PLAYER.walkSpeed * 0.55 || !frame.grounded) {
        this.sliding = false;
      }
    }

    /* ---- aim ---- */
    const wantAds = input.held("aim") && !wingsuit.active && !parachute.active;
    this.adsBlend = damp(this.adsBlend, wantAds ? 1 : 0, 13, dt);
    // Only touch React on the transition — `aiming` drives the HUD reticle.
    const store = useSfStore.getState();
    if (store.aiming !== wantAds) store.setAiming(wantAds);

    /* ---- auto-mantle ---- */
    // Runs on contact rather than on a button. See the header.
    if (!this.mantle.active && !wingsuit.active && !parachute.active) {
      const moving = input.snapshot.moveZ > 0.35;
      if (moving && (frame.grounded || this.sinceGround < 0.9)) this.tryMantle(1.35);
    }
  }

  /* ---------------- locomotion ---------------- */

  private applyGravity(dt: number, vel: THREE.Vector3, scale: number): void {
    vel.y += PLAYER.gravity * scale * dt;
  }

  private applyAirDrag(dt: number, vel: THREE.Vector3): void {
    const v = vel.length();
    if (v < 1e-3) return;
    const d = AIR_DRAG_K * v * v * dt;
    const s = Math.max(0, 1 - d / v);
    vel.multiplyScalar(s);
  }

  /** Flattened camera basis — what "forward" means for the feet. */
  private wishDirection(): void {
    const s = input.snapshot;
    _fwdFlat.set(frame.forward.x, 0, frame.forward.z);
    if (_fwdFlat.lengthSq() < 1e-6) _fwdFlat.set(-Math.sin(frame.yaw), 0, -Math.cos(frame.yaw));
    _fwdFlat.normalize();
    _rightFlat.set(frame.right.x, 0, frame.right.z).normalize();
    _wish.set(0, 0, 0)
      .addScaledVector(_fwdFlat, s.moveZ)
      .addScaledVector(_rightFlat, s.moveX);
    const l = _wish.length();
    if (l > 1) _wish.multiplyScalar(1 / l);
  }

  private groundMove(dt: number, vel: THREE.Vector3): void {
    this.wishDirection();
    const s = input.snapshot;
    const wishLen = _wish.length();

    /* sprint */
    const wantSprint =
      input.held("sprint") && s.moveZ > 0.3 && !this.crouched && this.stamina > 0.02;
    this.sprintBlend = damp(this.sprintBlend, wantSprint ? 1 : 0, 8, dt);

    /* hill-aware footing: the horizontal part of the ground normal points
       downhill, so a positive dot means we are heading down. */
    const nx = frame.groundNormal.x;
    const nz = frame.groundNormal.z;
    const downhill = _wish.x * nx + _wish.z * nz;
    const grade = clamp(downhill, -0.55, 0.55);

    let target = this.crouched
      ? PLAYER.crouchSpeed
      : PLAYER.walkSpeed + (PLAYER.sprintSpeed - PLAYER.walkSpeed) * this.sprintBlend;
    target *= 1 + grade * 0.75;
    target *= wishLen;

    /* project the wish into the ground plane so slopes do not launch you */
    const dot = _wish.x * nx + _wish.z * nz;
    _wish.x -= nx * dot;
    _wish.z -= nz * dot;
    const pl = Math.hypot(_wish.x, _wish.z);
    if (pl > 1e-4) {
      _wish.x /= pl;
      _wish.z /= pl;
    }

    /* steep slopes slide */
    const slope = Math.acos(clamp(frame.groundNormal.y, -1, 1));
    if (slope > SLIDE_SLOPE) {
      const steepness = clamp01((slope - SLIDE_SLOPE) / 0.5);
      vel.x += nx * PLAYER.gravity * -0.8 * steepness * dt;
      vel.z += nz * PLAYER.gravity * -0.8 * steepness * dt;
      target *= 1 - steepness * 0.7;
    }

    if (this.sliding) {
      /* a slide keeps its own momentum; steering only nudges it */
      const fr = 1 - Math.exp(-SLIDE_FRICTION * dt);
      vel.x -= vel.x * fr;
      vel.z -= vel.z * fr;
      vel.x += _wish.x * GROUND_ACCEL * 0.22 * dt;
      vel.z += _wish.z * GROUND_ACCEL * 0.22 * dt;
      // Slides accelerate downhill — Lombard Street is the whole point.
      vel.x += nx * 16 * dt;
      vel.z += nz * 16 * dt;
    } else if (wishLen > 0.01) {
      const tx = _wish.x * target;
      const tz = _wish.z * target;
      const ax = tx - vel.x;
      const az = tz - vel.z;
      const am = Math.hypot(ax, az);
      if (am > 1e-4) {
        const step = Math.min(am, GROUND_ACCEL * dt);
        vel.x += (ax / am) * step;
        vel.z += (az / am) * step;
      }
    } else {
      const sp = Math.hypot(vel.x, vel.z);
      if (sp > 1e-4) {
        const step = Math.min(sp, GROUND_DECEL * dt);
        vel.x -= (vel.x / sp) * step;
        vel.z -= (vel.z / sp) * step;
      }
    }

    /* jump */
    if (this.jumpBuffered > 0 && (frame.grounded || this.coyote > 0)) {
      this.jumpBuffered = 0;
      this.coyote = 0;
      this.sliding = false;
      vel.y = PLAYER.jumpVelocity;
      // Jumping out of a slide keeps the speed you earned.
      frame.grounded = false;
    } else {
      // Grounded and not jumping: never carry upward velocity (it would fight
      // the controller's ground snap), and keep pushing down so the capsule
      // stays glued to a 30% downhill grade instead of skipping along it.
      if (vel.y > 0) vel.y = 0;
      vel.y += PLAYER.gravity * dt;
    }
  }

  private airMove(dt: number, vel: THREE.Vector3, scale: number): void {
    this.wishDirection();
    const wishLen = _wish.length();
    if (wishLen < 0.01) return;
    const accel = AIR_ACCEL * PLAYER.airControl * scale;
    const maxAir = PLAYER.sprintSpeed * 1.15;
    // Classic air control: you may steer, but you may not accelerate past the
    // air speed cap along the direction you are already going.
    const along = vel.x * _wish.x + vel.z * _wish.z;
    const room = Math.max(0, maxAir - along);
    const add = Math.min(room, accel * dt);
    vel.x += _wish.x * add;
    vel.z += _wish.z * add;
  }

  private swim(dt: number, vel: THREE.Vector3): void {
    this.wishDirection();
    const s = input.snapshot;
    const sub = charCtrl.result.submersion;
    const sprinting = input.held("sprint") && this.stamina > 0.02;
    const speed = sprinting ? SWIM_SPRINT_SPEED : SWIM_SPEED;

    // Swim in the direction you are looking, so you can dive by aiming down.
    _wish.x = frame.forward.x * s.moveZ + frame.right.x * s.moveX;
    _wish.z = frame.forward.z * s.moveZ + frame.right.z * s.moveX;
    _wish.y = frame.forward.y * s.moveZ;
    const l = _wish.length();
    if (l > 1) _wish.multiplyScalar(1 / l);

    const chase = 1 - Math.exp(-3.4 * dt);
    vel.x += (_wish.x * speed - vel.x) * chase;
    vel.z += (_wish.z * speed - vel.z) * chase;

    // Buoyancy: float toward the surface unless actively swimming down.
    const feet = frame.position.y - charCtrl.totalHeight * 0.5;
    const depth = WORLD.seaLevel - (feet + charCtrl.totalHeight * 0.82);
    let vy = vel.y;
    if (this.stamina > 0.02) {
      vy += (BUOYANCY * clamp01(depth / 1.2) - 6.5 * clamp01(-depth)) * dt;
      vy += _wish.y * speed * dt * 3.2;
      if (input.held("crouch")) vy -= 9 * dt;
    } else {
      // Out of stamina you sink. It is the only genuinely dangerous water.
      vy -= 4.2 * dt;
    }
    vy -= vy * (1 - Math.exp(-2.6 * dt));
    vel.y = vy;

    this.stamina = clamp01(
      this.stamina - (sprinting ? STAMINA_DRAIN_SPRINT : STAMINA_DRAIN_SWIM) * dt,
    );

    // Jumping at the surface is a lunge out of the water.
    if (this.jumpBuffered > 0 && sub < 0.85) {
      this.jumpBuffered = 0;
      vel.y = Math.max(vel.y, PLAYER.jumpVelocity * 0.72);
    }

    if (sub > 0.98 && this.stamina <= 0.02) {
      this.drownAccum += DROWN_RATE * dt;
      if (this.drownAccum >= 1) {
        const n = Math.floor(this.drownAccum);
        this.drownAccum -= n;
        useSfStore.getState().damage(n);
      }
    }
  }

  /* ---------------- mantle ---------------- */

  /**
   * Look for a ledge ahead and start climbing it.
   *
   * Returns true if a climb started. `maxHeight` defaults to full mantle reach;
   * the auto-mantle path passes a lower value so that walking into a wall does
   * not silently teleport you onto a two-metre parapet.
   */
  private tryMantle(maxHeight = 2.3): boolean {
    if (this.mantle.active || !charCtrl.ready) return false;
    // Straight from the aim, not from `_fwdFlat` — that is only valid after
    // `wishDirection()` has run, and this can be called before it.
    const fl = Math.hypot(frame.forward.x, frame.forward.z) || 1;
    const dx = frame.forward.x / fl;
    const dz = frame.forward.z / fl;
    if (!charCtrl.detectLedge(dx, dz, _ledge, maxHeight)) return false;
    if (_ledge.kind === "none" || _ledge.kind === "step") return false;

    const half = charCtrl.totalHeight * 0.5;
    const m = this.mantle;
    m.active = true;
    m.t = 0;
    // Tall mantles take longer, but never so long that the player feels
    // they have lost control of the character.
    m.duration = clamp(0.28 + _ledge.height * 0.17, 0.28, 0.66);
    m.fromX = frame.position.x;
    m.fromY = frame.position.y;
    m.fromZ = frame.position.z;
    const push = _ledge.depth > 0.8 ? 0.42 : 0.2;
    m.toX = _ledge.x + dx * push;
    m.toY = _ledge.y + half + 0.03;
    m.toZ = _ledge.z + dz * push;
    frame.velocity.set(0, 0, 0);
    // A vault reads as a hop, a mantle as a pull-up. The camera sells both.
    cameraRig.addKick(_ledge.kind === "vault" ? -0.05 : -0.09, 0, 0.03 * (dx > 0 ? 1 : -1));
    input.rumble(90, 0.25, 0.12);
    return true;
  }

  private stepMantle(dt: number): void {
    const m = this.mantle;
    m.t += dt;
    const t = clamp01(m.t / m.duration);
    // Rise first, then move in: the shape of an actual pull-up. A straight
    // lerp clips your knees through the parapet.
    const up = t < 0.55 ? t / 0.55 : 1;
    const inw = t < 0.35 ? 0 : (t - 0.35) / 0.65;
    const ey = up * up * (3 - 2 * up);
    const ex = inw * inw * (3 - 2 * inw);
    frame.position.x = m.fromX + (m.toX - m.fromX) * ex;
    frame.position.y = m.fromY + (m.toY - m.fromY) * ey;
    frame.position.z = m.fromZ + (m.toZ - m.fromZ) * ex;
    charCtrl.setPosition(frame.position.x, frame.position.y, frame.position.z);
    if (t >= 1) {
      m.active = false;
      frame.grounded = true;
      this.coyote = COYOTE_TIME;
    }
  }

  /* ---------------- integration ---------------- */

  private integrate(dt: number, dead: boolean): void {
    if (this.mantle.active) {
      this.stepMantle(dt);
      frame.velocity.set(0, 0, 0);
      return;
    }

    _delta.copy(frame.velocity).multiplyScalar(dt);
    const res = charCtrl.move(_delta.x, _delta.y, _delta.z, dt);

    frame.position.set(charCtrl.position[0], charCtrl.position[1], charCtrl.position[2]);

    /* ---- fall tracking ---- */
    const wasGrounded = this.wasGrounded;
    let grounded = res.grounded;
    frame.groundNormal.set(res.nx, res.ny, res.nz);

    /* ---- fallback ground when Rapier has not booted ---- */
    if (!charCtrl.ready) {
      const c = clampToWorld(frame.position.x, frame.position.z);
      frame.position.x = c.x;
      frame.position.z = c.z;
      const half = charCtrl.totalHeight * 0.5;
      const floor = walkableHeight(frame.position.x, frame.position.z) + half;
      if (frame.position.y <= floor) {
        frame.position.y = floor;
        grounded = true;
        frame.groundNormal.set(0, 1, 0);
        if (frame.velocity.y < 0) frame.velocity.y = 0;
      }
      if (frame.position.y > WORLD.skyCeiling) {
        frame.position.y = WORLD.skyCeiling;
        if (frame.velocity.y > 0) frame.velocity.y = 0;
      }
      charCtrl.setPosition(frame.position.x, frame.position.y, frame.position.z);
    }

    /* ---- collision response on velocity ---- */
    if (res.hitCeiling && frame.velocity.y > 0) frame.velocity.y = 0;
    if (grounded && frame.velocity.y < 0) frame.velocity.y = 0;
    if (res.hitWall) {
      const speed = Math.hypot(frame.velocity.x, frame.velocity.z);
      const n = Math.hypot(res.wallX, res.wallZ);
      if (n > 1e-4) {
        const nx = res.wallX / n;
        const nz = res.wallZ / n;
        const into = frame.velocity.x * nx + frame.velocity.z * nz;
        if (into < 0) {
          frame.velocity.x -= nx * into;
          frame.velocity.z -= nz * into;
        }
      }
      // Reeling face-first into a wall at speed should hurt and should break
      // the tether, not smear you along the facade.
      if (speed > WALL_IMPACT_SPEED && !dead) {
        const over = speed - WALL_IMPACT_SPEED;
        this.hurt(over * 1.5, frame.yaw + Math.PI);
        cameraRig.addTrauma(clamp01(over / 30));
        grappleSystem.cutAll(false);
        frame.velocity.multiplyScalar(0.25);
      }
    }

    /* ---- landing ---- */
    if (!grounded) {
      this.sinceGround += dt;
      this.coyote = Math.max(0, this.coyote - dt);
      if (!wingsuit.active && !parachute.active) {
        this.fallPeak = Math.max(this.fallPeak, -frame.velocity.y);
      } else {
        this.fallPeak = 0;
      }
    } else {
      this.coyote = COYOTE_TIME;
      this.sinceGround = 0;
      if (!wasGrounded) this.onLand(dead);
      // Landing cancels flight, always. Skimming a rooftop under canopy and
      // continuing to fly is the sort of thing that makes a game feel loose.
      if (wingsuit.active) wingsuit.stow();
      if (parachute.active) parachute.cutaway();
    }
    this.wasGrounded = grounded;
    frame.grounded = grounded;

    /* ---- water ---- */
    const sub = res.submersion;
    if (sub > 0.2) {
      // Hitting water at speed is a hard landing too, just a wetter one.
      if (this.fallPeak > PLAYER.safeLandingSpeed * 2.2 && !dead) {
        this.hurt((this.fallPeak - PLAYER.safeLandingSpeed * 2.2) * 2.1, frame.yaw);
        cameraRig.addTrauma(0.5);
      }
      if (this.fallPeak > 6) {
        cameraRig.landed(Math.min(this.fallPeak, 24) * 0.5);
        this.fallPeak = 0;
      }
      if (wingsuit.active) wingsuit.stow();
      if (parachute.active) parachute.cutaway();
    }
    if (res.swimming) {
      this.stamina = Math.max(this.stamina, 0);
    } else if (grounded) {
      this.stamina = clamp01(this.stamina + STAMINA_REGEN * dt);
      this.drownAccum = 0;
    }

    frame.speed = frame.velocity.length();
  }

  private onLand(dead: boolean): void {
    const impact = this.fallPeak;
    this.fallPeak = 0;
    if (impact < 1) return;
    cameraRig.landed(impact);
    if (impact > 9) input.rumble(120, 0.3, clamp01(impact / 40));
    if (!dead && impact > PLAYER.safeLandingSpeed) {
      const dmg = FALL_DAMAGE_K * Math.pow(impact - PLAYER.safeLandingSpeed, FALL_DAMAGE_P);
      this.hurt(dmg, frame.yaw);
      // Hard landings knock the legs out: you slow down whether you like it
      // or not, which stops fall damage from being a pure number.
      frame.velocity.x *= 0.4;
      frame.velocity.z *= 0.4;
    }
  }

  /* ---------------- classification + presentation ---------------- */

  private classify(dead: boolean): void {
    if (dead) {
      frame.movement = "dead";
      return;
    }
    if (frame.vehicleId !== null) {
      frame.movement = "vehicle";
      return;
    }
    if (charCtrl.result.swimming) {
      frame.movement = "swimming";
      return;
    }
    if (parachute.active) {
      frame.movement = "parachute";
      return;
    }
    if (wingsuit.active) {
      frame.movement = "wingsuit";
      return;
    }
    if (grappleSystem.reelIntensity > 0.02 && !frame.grounded) {
      frame.movement = "grappling";
      return;
    }
    frame.movement = frame.grounded ? "grounded" : "airborne";
  }

  private updateVehicle(dt: number, camera: THREE.PerspectiveCamera): void {
    frame.movement = "vehicle";
    frame.grounded = true;
    grappleSystem.update(dt);
    const d = cameraRig.drive;
    d.eyeOffset = 0;
    d.bobSpeed = 0;
    d.grounded = true;
    d.sprint = 0;
    d.ads = 0;
    d.slide = 0;
    d.rush = clamp01((frame.speed - 24) / 60);
    d.swinging = false;
    d.bankRoll = 0;
    d.mantling = false;
    cameraRig.update(dt, camera);
    postFx.setSpeedBlur(d.rush * 0.45);
  }

  private updateCameraDrive(dt: number, dead: boolean): void {
    const d = cameraRig.drive;
    const eyeHeight = this.crouched ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight;
    d.eyeOffset = dead
      ? -charCtrl.totalHeight * 0.32
      : eyeHeight - charCtrl.totalHeight * 0.5;
    d.bobSpeed = frame.grounded ? Math.hypot(frame.velocity.x, frame.velocity.z) : 0;
    d.grounded = frame.grounded;
    d.sprint = this.sprintBlend;
    d.ads = this.adsBlend;
    d.slide = this.sliding ? 1 : 0;
    d.rush = wingsuit.active ? wingsuit.rush : 0;
    d.submersion = charCtrl.result.submersion;
    d.mantling = this.mantle.active;
    d.bankRoll = wingsuit.active
      ? -wingsuit.bankRoll * 0.55
      : parachute.active
        ? -parachute.bankRoll * 0.5
        : 0;
    d.swinging = grappleSystem.primaryAnchorDir(_anchorDir);
    if (d.swinging) {
      d.swingX = _anchorDir.x;
      d.swingY = _anchorDir.y;
      d.swingZ = _anchorDir.z;
    }

    frame.altitudeAGL =
      frame.position.y - walkableHeight(frame.position.x, frame.position.z);
  }

  /**
   * Push the handful of values the post pipeline and the touch HUD want.
   * Everything here is read-only from this system's point of view; none of it
   * feeds back into the simulation.
   */
  private updateHudFeedback(): void {
    postFx.setSpeedBlur(
      clamp01(
        wingsuit.rush * 0.85 +
          clamp01((frame.speed - 45) / 60) * 0.4 +
          grappleSystem.reelIntensity * 0.18,
      ),
    );
    const sub = charCtrl.result.submersion;
    postFx.setUnderwater(clamp01((sub - 0.72) / 0.22));
    if (this.adsBlend > 0.05) {
      postFx.setFocus(28, this.adsBlend * 0.75, 2.4, 55);
    } else {
      postFx.setAutoFocus(true);
    }

    if (input.isTouch) {
      // The big button's meaning changes with the state; label it honestly.
      if (frame.grounded) input.setTouchSlot("jump", "JUMP");
      else if (parachute.active) input.setTouchSlot("jump", "CUT");
      else if (wingsuit.active) input.setTouchSlot("jump", "CHUTE");
      else input.setTouchSlot("jump", "WING");
    }
  }

  /* ---------------- health ---------------- */

  private hurt(amount: number, direction: number): void {
    if (amount < 0.5) return;
    useSfStore.getState().damage(Math.round(amount), direction);
    postFx.triggerDamageFlash(clamp01(amount / 40), direction);
    input.rumble(160, 0.4, clamp01(amount / 50));
    this.lastDamageTime = frame.time;
  }

  /**
   * Regeneration, and the bookkeeping that lets this system notice damage it
   * did not cause. Polling the store beats subscribing: a zustand subscription
   * firing inside the frame loop would re-enter React on every bullet.
   */
  private syncHealth(dt: number, health: number, dead: boolean): void {
    if (health < this.lastHealth) this.lastDamageTime = frame.time;
    this.lastHealth = health;
    postFx.setLowHealth(clamp01(1 - health / 35));

    if (dead || health >= PLAYER.maxHealth) {
      this.healAccum = 0;
      return;
    }
    if (frame.time - this.lastDamageTime < PLAYER.regenDelay) return;
    this.healAccum += PLAYER.regenRate * dt;
    if (this.healAccum >= 1) {
      const n = Math.floor(this.healAccum);
      this.healAccum -= n;
      // Only touches React when a whole point of health has actually accrued.
      useSfStore.getState().heal(n);
      this.lastHealth = Math.min(PLAYER.maxHealth, this.lastHealth + n);
    }
  }

  /* ---------------- readouts ---------------- */

  get health(): number {
    return this.lastHealth;
  }

  /** Airspeed relative to the wingsuit's usable envelope, 0..1. HUD uses it. */
  get envelope(): number {
    return clamp01(frame.speed / WINGSUIT.maxSpeed);
  }
}

/** The one player controller. */
export const playerCtrl = new PlayerController();
