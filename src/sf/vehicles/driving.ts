/**
 * driving.ts — what it feels like to drive in San Francisco.
 *
 * The physics module already produces a car that is *correct*: a Pacejka tyre,
 * measured weight transfer, a real gearbox. Correct is not the same as good.
 * This module is the layer between a correct simulation and a game you want to
 * play, and almost all of it is about the two things a player actually
 * perceives — the camera, and the moment-to-moment feedback that tells them
 * what the car is doing before the car has finished doing it.
 *
 * What lives here
 * ---------------
 *  • **Input → drivetrain.** Analog throttle/brake with an automatic
 *    reverse-on-stop, steering that speed-scales *on top of* the rack's own
 *    falloff, a handbrake that unloads the rear axle, and a boost.
 *  • **The chase camera.** A critically-damped follow spring with a look-ahead
 *    that leads the car into corners, a sphere-cast collision probe so the lens
 *    never ends up inside a Victorian, speed-driven FOV, and impact shake. Four
 *    modes, because the cable car wants a different camera to the gunship.
 *  • **Hills.** San Francisco is the mechanic. On a 20% grade the camera has to
 *    pitch with the car or you cannot see the road; on a crest at 25 m/s all
 *    four wheels leave the ground, and that has to be *rewarded*, not punished.
 *    Airtime is tracked, scored, and paid out as chaos — Bullitt, the Steve
 *    McQueen chase down Taylor Street, is the whole reason this city is the
 *    setting.
 *  • **Handbrake turns and drift.** The handbrake drops rear grip; a sustained
 *    slip angle feeds the camera a lateral lean and the tyres a smoke budget,
 *    and holding a long drift builds a score multiplier.
 *  • **Brake fade** on long descents, because a 12-tonne coach going down
 *    Filbert with the pedal buried should eventually stop stopping.
 *
 * Camera ownership
 * ----------------
 * `player/camera.ts` owns the actual `THREE.PerspectiveCamera`. This module
 * never touches it. It computes where the eye should be and pushes that through
 * `playerCtrl.setVehicleSeat()`, and it adds shake and lean through the rig's
 * own kick/trauma springs. That means driving composes with everything else the
 * rig does — damage shake, explosions, the vehicle-enter blend — instead of
 * fighting it.
 *
 * Public API
 * ----------
 *   drivingSystem.enter(vehicleId, seat?)  / .exit(bail?)
 *   drivingSystem.update(dt)               once per frame, after the controller
 *   drivingSystem.active / .vehicle / .cameraMode
 *   DRIVE_BINDINGS                          remappable action map
 */
import * as THREE from "three";
import { PLAYER } from "../config";
import { frame, useSfStore } from "../state/store";
import { terrainHeight, terrainSlope, walkableHeight } from "../geo/sfGeo";
import { clamp, clamp01, damp } from "../math/rng";
import { cameraRig, playerCtrl, input, type ActionName } from "@/sf/player";
import { QUERY_STATIC, makeRayHit, sphereCast, type RayHit } from "@/sf/physics";
import { originYFor } from "./models";
import { vehicleRuntime, type VehicleInstance } from "./vehicle";

/* ================================================================== *
 * Bindings
 * ================================================================== *
 * Driving reuses the on-foot action set rather than inventing a second one,
 * because every one of these is already rebindable and already has gamepad and
 * touch coverage. The mapping is exported so the options screen can relabel it.
 */
export const DRIVE_BINDINGS = {
  throttle: "moveForward",
  brake: "moveBack",
  steerLeft: "moveLeft",
  steerRight: "moveRight",
  handbrake: "jump",
  boost: "sprint",
  exit: "interact",
  horn: "inspect",
  cameraCycle: "crouch",
  lights: "flare",
  fire: "fire",
  secondary: "aim",
  bail: "parachute",
  wingsuitBail: "wingsuit",
} satisfies Record<string, ActionName>;

export type DriveAction = keyof typeof DRIVE_BINDINGS;

/**
 * Rising-edge detection that does not depend on `input.pressed`.
 *
 * `pressed` is only valid inside the controller's own update window; this
 * module runs after it, by which point the flags may already have been cleared.
 * Tracking held-state transitions ourselves makes the ordering irrelevant,
 * which is worth far more than the four bytes it costs.
 */
class EdgeTracker {
  private prev = new Set<string>();
  private now = new Set<string>();

  sample(): void {
    const t = this.prev;
    this.prev = this.now;
    this.now = t;
    this.now.clear();
    for (const k of Object.keys(DRIVE_BINDINGS) as DriveAction[]) {
      if (input.held(DRIVE_BINDINGS[k])) this.now.add(k);
    }
  }
  held(a: DriveAction): boolean {
    return this.now.has(a);
  }
  pressed(a: DriveAction): boolean {
    return this.now.has(a) && !this.prev.has(a);
  }
  released(a: DriveAction): boolean {
    return !this.now.has(a) && this.prev.has(a);
  }
}

/* ================================================================== *
 * Camera
 * ================================================================== */

export type CameraMode = "chase" | "close" | "cockpit" | "hood";
const CAMERA_ORDER: CameraMode[] = ["chase", "close", "cockpit", "hood"];

interface CameraTuning {
  /** Distance behind the vehicle at rest, in vehicle lengths. */
  distance: number;
  /** Height above the vehicle origin, metres. */
  height: number;
  /** Extra distance per m/s of speed. */
  speedPull: number;
  /** Follow-spring rate. Lower = more lag = more weight. */
  follow: number;
  /** How far ahead of the car the camera looks, per m/s. */
  lookAhead: number;
}

const TUNING: Record<CameraMode, CameraTuning> = {
  chase: { distance: 1.5, height: 1.55, speedPull: 0.055, follow: 7.5, lookAhead: 0.09 },
  close: { distance: 0.95, height: 1.05, speedPull: 0.03, follow: 11, lookAhead: 0.05 },
  cockpit: { distance: 0, height: 0, speedPull: 0, follow: 26, lookAhead: 0 },
  hood: { distance: 0, height: 0, speedPull: 0, follow: 20, lookAhead: 0 },
};

/** Camera probe radius. Slightly larger than the near-plane diagonal. */
const PROBE_R = 0.3;

const _desired = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _hit: RayHit = makeRayHit();

/**
 * The chase camera.
 *
 * Kept as its own class because `flight.ts` and `boats.ts` want exactly the
 * same behaviour with different numbers — a helicopter's camera is a chase
 * camera with a longer arm and no ground collision bias.
 */
export class VehicleCamera {
  mode: CameraMode = "chase";
  /** Extra distance multiplier for big vehicles / aircraft. */
  scale = 1;
  /** True while the camera has not been placed yet — snaps instead of springs. */
  private fresh = true;
  private pos = new THREE.Vector3();
  /** Auto-centre timer: how long since the player last moved the look stick. */
  private idleLook = 0;

  reset(): void {
    this.fresh = true;
    this.idleLook = 0;
  }

  cycle(): CameraMode {
    const i = CAMERA_ORDER.indexOf(this.mode);
    this.mode = CAMERA_ORDER[(i + 1) % CAMERA_ORDER.length];
    this.fresh = true;
    return this.mode;
  }

  /**
   * Place the eye for one frame and return it. Also nudges `frame.yaw` toward
   * the vehicle's heading when the player is not actively looking around,
   * which is the difference between a camera you have to fight and one that
   * just puts the road in front of you.
   */
  update(
    dt: number,
    v: VehicleInstance,
    out: THREE.Vector3,
    opts: { autoCentre?: boolean; reverse?: boolean; groundBias?: boolean } = {},
  ): THREE.Vector3 {
    const t = TUNING[this.mode];
    const def = v.def;

    _fwd.set(0, 0, -1).applyQuaternion(v.quaternion);
    _right.set(1, 0, 0).applyQuaternion(v.quaternion);
    _up.set(0, 1, 0).applyQuaternion(v.quaternion);

    /* ---- auto-centring ------------------------------------------ */
    const looked = Math.abs(input.snapshot.lookYaw) + Math.abs(input.snapshot.lookPitch);
    this.idleLook = looked > 0.0006 ? 0 : this.idleLook + dt;
    const heading = Math.atan2(-_fwd.x, -_fwd.z);
    const speed = v.speed;
    if (opts.autoCentre !== false && this.idleLook > 0.55 && Math.abs(speed) > 3.5) {
      // Behind the car when moving forward, in front of it when reversing —
      // reversing with the camera behind you is how you hit a fire hydrant.
      const target = opts.reverse && speed < -1.5 ? heading + Math.PI : heading;
      const delta = ((target - frame.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const rate = clamp01((Math.abs(speed) - 3) / 14) * 3.2;
      frame.yaw += delta * clamp01(rate * dt);
      // Level the pitch out gently too; nobody wants to drive looking at the sky.
      frame.pitch = damp(frame.pitch, -0.06, 1.4, dt);
    }

    /* ---- desired eye -------------------------------------------- */
    if (this.mode === "cockpit" || this.mode === "hood") {
      const originY = originYFor(def);
      if (this.mode === "cockpit") {
        const s = def.seats[0];
        _tmp.set(s ? s.x : 0, (s ? s.y : 1) - originY + 0.66, s ? s.z - 0.06 : 0);
      } else {
        _tmp.set(0, def.bonnet - originY + 0.28, def.cabinFrontZ - 0.15);
      }
      _desired.copy(_tmp).applyQuaternion(v.quaternion).add(v.position);
    } else {
      // Orbit anchor sits at roof height above the centre of mass, and the arm
      // grows with speed so fast driving reads as fast.
      const dist = (t.distance * def.length + Math.abs(speed) * t.speedPull * def.length) * this.scale;
      const cy = Math.cos(frame.yaw);
      const sy = Math.sin(frame.yaw);
      _desired.set(
        v.position.x + sy * dist,
        v.position.y + t.height * this.scale + def.height * 0.42 - frame.pitch * dist * 0.8,
        v.position.z + cy * dist,
      );
      // Lead the car. Two separate leads, and both matter:
      //  · longitudinal — the anchor slides toward where the nose is pointing,
      //    so at speed you see further up the road than you do at a standstill;
      //  · lateral — the eye drifts to the outside of a corner under lateral
      //    load, which opens the apex up before you have turned into it.
      _desired.addScaledVector(_fwd, Math.abs(speed) * t.lookAhead);
      _desired.addScaledVector(_right, clamp(v.car ? -v.car.accelLat * 0.035 : 0, -1.4, 1.4));

      // Never let the eye sink below the road; on a 25% grade the naive orbit
      // point is a metre inside Nob Hill.
      if (opts.groundBias !== false) {
        const g = terrainHeight(_desired.x, _desired.z) + 1.1;
        if (_desired.y < g) _desired.y = g;
      }
    }

    /* ---- spring -------------------------------------------------- */
    if (this.fresh) {
      this.pos.copy(_desired);
      this.fresh = false;
    } else {
      const k = t.follow;
      this.pos.x = damp(this.pos.x, _desired.x, k, dt);
      this.pos.y = damp(this.pos.y, _desired.y, k * 1.25, dt);
      this.pos.z = damp(this.pos.z, _desired.z, k, dt);
    }

    /* ---- collision ----------------------------------------------- */
    if (this.mode === "chase" || this.mode === "close") {
      _tmp2.copy(this.pos).sub(v.position);
      const len = _tmp2.length();
      if (len > 0.05) {
        _tmp2.multiplyScalar(1 / len);
        const from = v.position;
        if (
          sphereCast(
            from.x, from.y + def.height * 0.4, from.z,
            _tmp2.x, _tmp2.y, _tmp2.z,
            PROBE_R, len, _hit, { groups: QUERY_STATIC, skipSurface: true },
          )
        ) {
          const d = Math.max(0.6, _hit.distance - PROBE_R * 1.2);
          this.pos.set(
            from.x + _tmp2.x * d,
            from.y + def.height * 0.4 + _tmp2.y * d,
            from.z + _tmp2.z * d,
          );
        }
      }
    }

    return out.copy(this.pos);
  }
}

/* ================================================================== *
 * The driving system
 * ================================================================== */

/** Longest airtime that still counts as a bump rather than a jump. */
const AIR_THRESHOLD = 0.32;

export class DrivingSystem {
  readonly camera = new VehicleCamera();
  private edges = new EdgeTracker();

  active = false;
  vehicle: VehicleInstance | null = null;
  seat = 0;

  /* ---- feel state ---- */
  /** 0..1 boost charge. Refills when off the throttle. */
  boost = 1;
  private boosting = false;
  private lastGear = 1;
  private airTime = 0;
  private airStartY = 0;
  private airStartX = 0;
  private airStartZ = 0;
  private wasGrounded = true;
  /** Seconds of continuous drift, and the score it has banked. */
  driftTime = 0;
  driftScore = 0;
  private hornTimer = 0;
  private detachImpact: (() => void) | null = null;
  private enterBlend = 0;

  /** Set by hijack.ts while a hijack animation is playing — input is ignored. */
  scripted = false;

  /**
   * Deterministic jitter for crash shake.
   *
   * `Math.random()` is banned under `src/sf` because the screenshot harness
   * needs the world to be reproducible. A hashed counter is just as unbiased
   * for a one-frame camera kick and costs a multiply.
   */
  private noiseCounter = 0;
  private shakeNoise(): number {
    this.noiseCounter = (this.noiseCounter * 1664525 + 1013904223) >>> 0;
    return this.noiseCounter / 4294967296;
  }

  get cameraMode(): CameraMode {
    return this.camera.mode;
  }

  /* ---------------- enter / exit ---------------- */

  /**
   * Take the wheel. Returns false if the seat is unusable — a wreck, a locked
   * car, or a seat somebody else is already in.
   */
  enter(vehicleId: number, seat = 0): boolean {
    const v = vehicleRuntime.get(vehicleId);
    if (!v || !v.ready || v.wrecked) return false;
    if (this.vehicle && this.vehicle.id === vehicleId) return true;
    if (this.active) this.exit(false);

    this.vehicle = v;
    this.seat = seat;
    this.active = true;
    v.driverIsPlayer = seat === 0;
    v.persistent = true;
    v.closeDoors();
    if (!v.running) v.start();
    this.camera.reset();
    this.camera.scale = v.def.klass === "heli" || v.def.klass === "plane" ? 1.7 : 1;
    this.airTime = 0;
    this.driftTime = 0;
    this.driftScore = 0;
    this.boost = 1;
    this.enterBlend = 0;
    this.lastGear = v.car ? v.car.gear : 1;

    playerCtrl.enterVehicle(vehicleId);
    frame.vehicleId = vehicleId;

    // Crash feedback: the shake is identical whether the player hit something
    // or something hit them, which is the only way a collision reads as an
    // event rather than as a control glitch.
    vehicleRuntime.onPlayerImpact = (veh, energy) => {
      if (veh !== this.vehicle) return;
      cameraRig.addTrauma(clamp01(energy * 0.16));
      cameraRig.addKick(
        -energy * 0.008,
        (this.shakeNoise() - 0.5) * energy * 0.006,
        (this.shakeNoise() - 0.5) * energy * 0.012,
      );
      input.rumble(90 + energy * 30, clamp01(energy * 0.2), clamp01(energy * 0.3));
      // A hard enough shunt hurts the driver too.
      if (energy > 3.4) useSfStore.getState().damage((energy - 3.4) * 5.5);
    };
    this.detachImpact = () => {
      vehicleRuntime.onPlayerImpact = null;
    };

    useSfStore.getState().notify(`${v.def.label}`, "info");
    return true;
  }

  /**
   * Leave. `bail` throws the player clear at speed rather than stepping out,
   * carrying the vehicle's velocity — which is what makes leaping from a
   * moving car into a wingsuit work.
   */
  exit(bail = false): void {
    const v = this.vehicle;
    if (!v) return;
    const def = v.def;

    // Step out on the driver's side, or upward when bailing.
    const s = def.seats[this.seat] ?? def.seats[0];
    const side = Math.sign(s?.x || -1);
    v.localToWorld(side * (def.width * 0.5 + 0.55), 0.2, s ? s.z : 0, _tmp);
    let x = _tmp.x;
    let z = _tmp.z;
    let y = walkableHeight(x, z) + PLAYER.height * 0.5;

    if (bail || Math.abs(v.speed) > 6) {
      // Bailing: keep the car's momentum, add a little lift, and let the fall
      // damage model decide whether that was a good idea.
      v.localToWorld(side * (def.width * 0.5 + 0.3), def.height * 0.7, s ? s.z : 0, _tmp);
      x = _tmp.x;
      y = _tmp.y;
      z = _tmp.z;
    }

    v.openDoorNear(this.seat);
    v.driverIsPlayer = false;
    if (v.car) {
      v.car.input.throttle = 0;
      v.car.input.brake = bail ? 0 : 1;
      v.car.input.steer = 0;
      v.car.input.handbrake = bail ? 0 : 1;
    }
    v.lights.brake = 0;
    v.lights.indicator = 0;

    playerCtrl.exitVehicle(x, y, z);
    if (bail || Math.abs(v.speed) > 6) {
      frame.velocity.copy(v.velocity).multiplyScalar(0.92);
      frame.velocity.y = Math.max(frame.velocity.y, 2.2);
      cameraRig.addTrauma(0.28);
    } else {
      frame.velocity.set(0, 0, 0);
    }

    this.detachImpact?.();
    this.detachImpact = null;
    this.active = false;
    this.vehicle = null;
    frame.vehicleId = null;
  }

  /* ---------------- the frame ---------------- */

  update(dt: number): void {
    if (!this.active || !this.vehicle) return;
    const v = this.vehicle;
    if (!v.ready || !v.alive) {
      this.exit(true);
      return;
    }

    this.edges.sample();
    this.enterBlend = Math.min(1, this.enterBlend + dt * 3);

    // Flight and boats drive their own controls; this module still owns the
    // camera, the exit and the scoring for them.
    const wheeled = !!v.car;

    if (!this.scripted && !frame.paused) {
      if (wheeled) this.driveWheels(dt, v);
      this.commonInput(dt, v);
    }

    if (wheeled) {
      this.updateAirtime(dt, v);
      this.updateDrift(dt, v);
      this.updateFeel(dt, v);
    }

    // A destroyed vehicle throws the player out rather than trapping them in a
    // fireball, which is both merciful and correct.
    if (v.wrecked) {
      this.exit(true);
      useSfStore.getState().damage(22);
      return;
    }

    /* ---- camera + player state ---------------------------------- */
    this.camera.update(dt, v, _tmp, {
      reverse: wheeled ? v.car!.gear === -1 : false,
      groundBias: v.def.klass !== "heli" && v.def.klass !== "plane",
    });
    playerCtrl.setVehicleSeat(_tmp.x, _tmp.y, _tmp.z);

    // The rest of the game reads the player's position and velocity from
    // `frame`; while driving, those are the vehicle's.
    frame.position.copy(v.position);
    frame.velocity.copy(v.velocity);
    // The rig's own FOV curve keys off `frame.speed`, so a fast car opens the
    // lens for free. `rush` is written for the *next* frame's rig update —
    // the controller clears it before its own call, and one frame of lag on a
    // field-of-view blend is not something anyone has ever perceived.
    cameraRig.drive.rush = clamp01((Math.abs(v.speed) - 16) / 46) + (this.boosting ? 0.3 : 0);
  }

  /* ---------------- input ---------------- */

  private driveWheels(dt: number, v: VehicleInstance): void {
    const car = v.car!;
    const inp = car.input;
    const s = input.snapshot;

    const throttleAxis = clamp01(Math.max(s.moveZ, 0));
    const brakeAxis = clamp01(Math.max(-s.moveZ, 0));
    const steerAxis = clamp(s.moveX, -1, 1);

    // Automatic reverse: hold the brake at a standstill and the car backs up.
    // This is a driving *game*, not a driving simulator with an H-pattern.
    const rolling = v.speed;
    if (brakeAxis > 0.1 && rolling < 0.8 && rolling > -0.4) inp.reverse = true;
    if (throttleAxis > 0.1 && rolling > -0.4) inp.reverse = false;

    if (inp.reverse) {
      inp.throttle = brakeAxis;
      inp.brake = throttleAxis;
    } else {
      inp.throttle = throttleAxis;
      inp.brake = brakeAxis;
    }

    // Steering: the rack already falls off with speed. This adds a small extra
    // taper at very high speed, and a counter-steer assist in a slide, which is
    // what stops a keyboard player from spinning on every drift.
    let steer = steerAxis;
    const slip = car.slip;
    if (slip > 0.85 && Math.abs(v.speed) > 8) {
      const yaw = car.accelLat;
      steer = clamp(steer - Math.sign(yaw) * clamp01((slip - 0.85) * 1.6) * 0.22, -1, 1);
    }
    inp.steer = steer;

    inp.handbrake = this.edges.held("handbrake") ? 1 : 0;

    /* ---- boost -------------------------------------------------- */
    this.boosting = this.edges.held("boost") && this.boost > 0.02 && inp.throttle > 0.3;
    if (this.boosting) {
      this.boost = Math.max(0, this.boost - dt * 0.42);
      _fwd.set(0, 0, -1).applyQuaternion(v.quaternion);
      const f = v.def.mass * 9.5 * dt;
      car.applyImpulse(_fwd.x * f, _fwd.y * f * 0.1, _fwd.z * f);
    } else if (inp.throttle < 0.35) {
      this.boost = Math.min(1, this.boost + dt * 0.16);
    }

    /* ---- lamps -------------------------------------------------- */
    v.lights.brake = Math.max(inp.brake, inp.handbrake * 0.8);
    v.lights.reverse = inp.reverse ? 1 : 0;
    v.lights.indicator = 0;
  }

  private commonInput(dt: number, v: VehicleInstance): void {
    if (this.edges.pressed("cameraCycle")) {
      const m = this.camera.cycle();
      useSfStore.getState().notify(`Camera: ${m}`, "info");
    }
    if (this.edges.pressed("lights")) {
      v.lights.highBeam = v.lights.highBeam > 0.5 ? 0 : 1;
    }
    if (this.edges.held("horn")) {
      this.hornTimer = 0.2;
      v.horn = 1;
    } else {
      this.hornTimer = Math.max(0, this.hornTimer - dt);
      v.horn = this.hornTimer > 0 ? 1 : 0;
    }
    if (this.edges.pressed("exit")) this.exit(Math.abs(v.speed) > 6);
    if (this.edges.pressed("bail") || this.edges.pressed("wingsuitBail")) this.exit(true);
  }

  /* ---------------- feel ---------------- */

  /**
   * Airtime.
   *
   * SF's crests are the reason this exists: crossing Taylor at 25 m/s puts all
   * four wheels in the air for the better part of a second, and the game must
   * notice. Landing flat and fast is rewarded; landing nose-down is punished by
   * the physics all on its own.
   */
  private updateAirtime(dt: number, v: VehicleInstance): void {
    const car = v.car!;
    const grounded = car.wheelsDown > 0;

    if (!grounded) {
      if (this.wasGrounded) {
        this.airStartY = v.position.y;
        this.airStartX = v.position.x;
        this.airStartZ = v.position.z;
        this.airTime = 0;
      }
      this.airTime += dt;
      // In the air the camera pulls back and the world goes quiet — the
      // standard trick for making a jump feel longer than it is.
      cameraRig.drive.rush = Math.max(cameraRig.drive.rush, clamp01(this.airTime * 1.4) * 0.5);
    } else if (!this.wasGrounded) {
      const dist = Math.hypot(v.position.x - this.airStartX, v.position.z - this.airStartZ);
      const drop = this.airStartY - v.position.y;
      const impact = Math.max(0, -v.velocity.y);
      if (this.airTime > AIR_THRESHOLD) {
        cameraRig.landed(impact * 0.7);
        cameraRig.addTrauma(clamp01(this.airTime * 0.35 + impact * 0.012));
        input.rumble(120, 0.4, 0.7);
      }
      // The Bullitt bonus. A real jump is over half a second of air and at
      // least eight metres of ground covered; anything less is a pothole.
      if (this.airTime > 0.55 && dist > 8) {
        const points = Math.round(24 + this.airTime * 90 + dist * 3.5 + Math.max(0, drop) * 4);
        useSfStore
          .getState()
          .addChaos(points, this.airTime > 1.1 ? "BULLITT!" : "Airborne");
      }
      this.airTime = 0;
    }
    this.wasGrounded = grounded;
  }

  /**
   * Drift scoring.
   *
   * A drift is a sustained slip angle with the throttle on. Holding one builds
   * a multiplier; touching a wall or spinning out banks nothing. Being on a
   * gradient counts for more, because sliding sideways down Lombard is harder
   * and more spectacular than sliding sideways along the Embarcadero.
   */
  private updateDrift(dt: number, v: VehicleInstance): void {
    const car = v.car!;
    const speed = Math.abs(v.speed);
    const sliding = car.slip > 0.95 && speed > 7 && car.wheelsDown >= 2;
    if (sliding) {
      const grade = terrainSlope(v.position.x, v.position.z);
      this.driftTime += dt;
      this.driftScore += dt * (speed * 1.6) * (1 + grade * 2.2) * (1 + this.driftTime * 0.35);
    } else if (this.driftTime > 0) {
      if (this.driftTime > 1.2 && this.driftScore > 60) {
        useSfStore.getState().addChaos(Math.round(this.driftScore * 0.35), "Drift");
      }
      this.driftTime = 0;
      this.driftScore = 0;
    }
  }

  /**
   * Everything that is purely about perception: the lean under lateral load,
   * the pitch under braking, the shift kick, the rumble of a redline.
   */
  private updateFeel(dt: number, v: VehicleInstance): void {
    const car = v.car!;

    // Body lean. A real driver's head tips with lateral g; feeding the rig's
    // roll spring a steady impulse proportional to lateral acceleration
    // produces exactly that, and it decays on its own when the corner ends.
    //
    // The coefficients are derived, not guessed. The rig's kick spring is
    // v += p·K·0.08 with K = 160, so a constant per-frame p at 60 Hz settles at
    // x = 4.8·p radians. Two degrees of lean at 8 m/s² of lateral load — which
    // is about what a driver's head actually does — wants p = 9e-4 per m/s².
    // Scaling by dt·60 keeps it identical on a 144 Hz monitor.
    const lat = clamp(car.accelLat, -25, 25);
    const lon = clamp(car.accelLong, -25, 25);
    const rate = dt * 60;
    cameraRig.addKick(-lon * 0.0006 * rate, 0, lat * 0.0009 * rate);

    // Gear change: a small downward kick and a rumble tick.
    if (car.gear !== this.lastGear) {
      if (car.gear > this.lastGear) {
        cameraRig.addKick(-0.006, 0, 0.0015);
        input.rumble(45, 0.12, 0.05);
      }
      this.lastGear = car.gear;
    }

    // Redline / surface vibration, scaled so it is felt and not seen.
    // Trauma bleeds off at 1.45/s, so a steady feed of f·dt settles at f/1.45.
    // Redline sits at ~0.4, which reads as a hum rather than as damage.
    const rev = clamp01((car.rpm - car.spec.redlineRpm * 0.9) / (car.spec.redlineRpm * 0.12));
    if (rev > 0.02) cameraRig.addTrauma(rev * 0.6 * dt);

    // Wheel slip screeches into the trauma channel too — you feel a lock-up.
    if (car.slip > 1.2) cameraRig.addTrauma(clamp01((car.slip - 1.2) * 0.8) * 1.2 * dt);
  }
}

export const drivingSystem = new DrivingSystem();

/* ================================================================== *
 * Small helpers other modules use
 * ================================================================== */

/**
 * Where a player standing next to a vehicle would get in.
 * Returns the seat index, or −1 if there is nowhere to sit.
 */
export function nearestSeat(v: VehicleInstance, x: number, y: number, z: number): number {
  v.worldToLocal(x, y, z, _tmp);
  let best = -1;
  let bestD = 1e9;
  for (let i = 0; i < v.def.seats.length; i++) {
    const s = v.def.seats[i];
    const d = (s.x - _tmp.x) ** 2 + (s.y - _tmp.y) ** 2 + (s.z - _tmp.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Heading of a vehicle in world space, radians. */
export function vehicleHeading(v: VehicleInstance): number {
  _fwd.set(0, 0, -1).applyQuaternion(v.quaternion);
  return Math.atan2(-_fwd.x, -_fwd.z);
}
