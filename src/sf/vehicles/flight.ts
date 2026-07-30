/**
 * flight.ts — helicopters and the light attack aircraft.
 *
 * Two flight models, one control philosophy.
 *
 * **Helicopters** ride `physics.Helicopter`, which already does collective lag,
 * ground effect, translational lift, torque reaction and autorotation. What is
 * missing from a raw collective/cyclic/pedal rig is that it is genuinely hard
 * to fly, and this is not a helicopter simulator. So on top sit two assists:
 *
 *   • *auto-level* — with the cyclic centred, a proportional-derivative torque
 *     brings the disc back toward level. Release the stick and the machine
 *     stops falling out of the sky. Hold the stick and the assist is silent, so
 *     an expert loses nothing;
 *   • *hover hold* — with no vertical input and no forward speed, the collective
 *     trims itself to hold altitude. This is a real autopilot mode, not a
 *     cheat, and it is the difference between "landing on the Transamerica
 *     Pyramid" being an objective and being a chore.
 *
 * **The aircraft** is a proper fixed-wing model, because a plane that flies
 * like a fast helicopter is instantly, unpleasantly wrong. Lift comes from a
 * real lift curve against angle of attack with a stall break past 16°; drag is
 * parasitic plus induced; control authority scales with dynamic pressure, so
 * the controls go soft as you slow down and the aeroplane gets heavy in your
 * hands before it drops a wing. It sits on `physics.Vehicle` for its landing
 * gear, which means it taxis, rotates off the runway at a speed you can feel,
 * and can be landed badly.
 *
 * Also here, because they belong to whoever is flying: the chin gun (hitscan
 * with tracers), the rocket pods (a pooled ballistic projectile with a trail
 * and a proximity blast) and the bail-out, which throws you clear at whatever
 * speed you were doing and hands you straight to the wingsuit.
 *
 * Public API
 * ----------
 *   flightSystem.update(dt)               once per frame while flying
 *   flightSystem.attachAero(v)            give an aircraft its aerodynamics
 *   flightSystem.detachAero(v)
 *   flightSystem.telemetry                airspeed / AGL / stall, for the HUD
 *   FixedWingAero                         the aeroplane model, usable by AI
 */
import * as THREE from "three";
import type * as RAPIER from "@dimforge/rapier3d-compat";
import { WORLD, terrainHeight } from "../geo/sfGeo";
import { frame, useSfStore } from "../state/store";
import { clamp, clamp01, damp } from "../math/rng";
import { cameraRig, input, parachute, playerCtrl, wingsuit } from "@/sf/player";
import {
  GROUP,
  interactionGroups,
  makeRayHit,
  onFixedStep,
  raycast,
  type RayHit,
} from "@/sf/physics";
import {
  emitRotorWash,
  rocketTrail,
  spawnExplosion,
  spawnImpact,
  trails,
  tracerTrail,
} from "@/sf/vfx";
import { drivingSystem } from "./driving";
import { originYFor } from "./models";
import { vehicleRuntime, type VehicleInstance } from "./vehicle";

/* ================================================================== *
 * Constants
 * ================================================================== */

const RHO_SEA = 1.225;
const G = 9.81;

/** Lift-curve slope per radian for a thick, low-aspect wing. */
const CL_ALPHA = 5.2;
const CL_MAX = 1.42;
const STALL_ALPHA = 0.29; // ≈16.5°
const CD0 = 0.028;
/** Oswald efficiency × π × aspect ratio, folded into one induced-drag constant. */
const K_INDUCED = 0.062;

const GUN_RPS = 18;
const GUN_RANGE = 900;
const GUN_DAMAGE = 26;
const ROCKET_SPEED = 118;
const ROCKET_LIFE = 5.5;
const MAX_ROCKETS = 28;
const ROCKET_INTERVAL = 0.22;

const AIR_QUERY = interactionGroups(GROUP.PROJECTILE, GROUP.TERRAIN | GROUP.BUILDING | GROUP.VEHICLE | GROUP.PROP | GROUP.ENEMY);

/* ================================================================== *
 * Scratch
 * ================================================================== */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _hit: RayHit = makeRayHit();
const _force = { x: 0, y: 0, z: 0 };
const _torque = { x: 0, y: 0, z: 0 };

/* ================================================================== *
 * Fixed-wing aerodynamics
 * ================================================================== */

export interface FixedWingInput {
  /** −1 nose down … +1 nose up. */
  pitch: number;
  /** −1 roll left … +1 roll right. */
  roll: number;
  /** −1 yaw left … +1 yaw right. */
  yaw: number;
  /** 0..1. */
  throttle: number;
  /** 0..1 — more lift, more drag, lower stall speed. */
  flaps: number;
  /** 0..1 wheel brakes. */
  brake: number;
}

/**
 * A believable light attack aircraft.
 *
 * Forces are applied in the fixed step at the aerodynamic centre, slightly
 * ahead of the centre of mass so the airframe is naturally pitch-stable — which
 * is what makes it possible to fly hands-off and what makes a stall a
 * recoverable event rather than an instant spin.
 */
export class FixedWingAero {
  readonly input: FixedWingInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0, brake: 0 };

  /** Wing area, m². */
  wingArea: number;
  /** Max static thrust, newtons. */
  maxThrust: number;
  /** Control authority at 50 m/s, N·m. */
  pitchPower: number;
  rollPower: number;
  yawPower: number;

  /* ---- telemetry ---- */
  airspeed = 0;
  alpha = 0;
  beta = 0;
  stall = 0;
  gLoad = 1;
  /** 0..1 propeller/turbine spool. */
  spool = 0;

  private prevVy = 0;

  constructor(private v: VehicleInstance) {
    const d = v.def;
    this.wingArea = Math.max(8, d.wingSpan * 1.55);
    // Thrust-to-weight around 0.42 — brisk, not a fighter.
    this.maxThrust = d.mass * G * 0.42;
    this.pitchPower = d.mass * 26;
    this.rollPower = d.mass * 34;
    this.yawPower = d.mass * 14;
  }

  /** One fixed step of aerodynamics. */
  step(dt: number): void {
    const body = this.v.body;
    if (!body || !body.isValid()) return;

    const q = body.rotation();
    _fwd.set(0, 0, -1).applyQuaternion(_qFrom(q));
    _up.set(0, 1, 0).applyQuaternion(_qFrom(q));
    _right.set(1, 0, 0).applyQuaternion(_qFrom(q));

    const lin = body.linvel();
    _v.set(lin.x, lin.y, lin.z);
    const speed = _v.length();
    this.airspeed = speed;

    // Engine spool: a turboprop takes a couple of seconds to come up.
    this.spool = damp(this.spool, this.v.running ? clamp01(this.input.throttle) : 0, 1.4, dt);
    this.v.rotorSpeed = this.spool;

    // Air density falls with altitude; at 2 km SF's ceiling that is a 20%
    // difference and it is exactly why a loaded aeroplane runs out of climb.
    const alt = Math.max(0, body.translation().y);
    const rho = RHO_SEA * Math.exp(-alt / 8400);
    const qDyn = 0.5 * rho * speed * speed;

    /* ---- thrust ------------------------------------------------- */
    const thrust = this.maxThrust * this.spool * (this.v.engine.health > 0 ? 1 : 0);
    _force.x = _fwd.x * thrust;
    _force.y = _fwd.y * thrust;
    _force.z = _fwd.z * thrust;
    body.addForce(_force, true);

    if (speed < 0.5) {
      this.alpha = 0;
      this.beta = 0;
      this.stall = 0;
      return;
    }

    /* ---- angles ------------------------------------------------- */
    const vf = _v.dot(_fwd);
    const vu = _v.dot(_up);
    const vr = _v.dot(_right);
    this.alpha = Math.atan2(-vu, Math.max(0.5, vf));
    this.beta = Math.atan2(vr, Math.max(0.5, vf));

    /* ---- lift --------------------------------------------------- */
    // Linear up to the stall, then a sharp break and a slow recovery. That
    // break is the whole feel of an aeroplane near the ground.
    const aAbs = Math.abs(this.alpha);
    let cl = CL_ALPHA * this.alpha + this.input.flaps * 0.55;
    if (aAbs > STALL_ALPHA) {
      const over = clamp01((aAbs - STALL_ALPHA) / 0.32);
      cl *= 1 - over * 0.72;
      this.stall = over;
    } else {
      this.stall = damp(this.stall, 0, 6, dt);
    }
    cl = clamp(cl, -CL_MAX, CL_MAX);
    const lift = qDyn * this.wingArea * cl;
    _force.x = _up.x * lift;
    _force.y = _up.y * lift;
    _force.z = _up.z * lift;
    // Applied a little ahead of the centre of mass: static pitch stability.
    _v2.copy(_fwd).multiplyScalar(-0.45).add(_posOf(body));
    body.addForceAtPoint(_force, { x: _v2.x, y: _v2.y, z: _v2.z }, true);

    /* ---- drag --------------------------------------------------- */
    const cd = CD0 + K_INDUCED * cl * cl + this.input.flaps * 0.045 + this.stall * 0.12;
    const drag = qDyn * this.wingArea * cd;
    const inv = 1 / Math.max(speed, 1e-3);
    _force.x = -_v.x * inv * drag;
    _force.y = -_v.y * inv * drag;
    _force.z = -_v.z * inv * drag;
    body.addForce(_force, true);

    /* ---- side force + weathervane ------------------------------- */
    const side = -qDyn * this.wingArea * 0.42 * this.beta;
    _force.x = _right.x * side;
    _force.y = _right.y * side;
    _force.z = _right.z * side;
    body.addForce(_force, true);
    const weather = -this.beta * qDyn * this.wingArea * 0.5;
    _torque.x = _up.x * weather;
    _torque.y = _up.y * weather;
    _torque.z = _up.z * weather;
    body.addTorque(_torque, true);

    /* ---- control surfaces --------------------------------------- */
    // Authority ∝ dynamic pressure, with a propwash floor so you still have
    // some rudder on the ground at taxi speed.
    const auth = clamp01(qDyn / (0.5 * RHO_SEA * 50 * 50)) + this.spool * 0.14;
    const p = -this.input.pitch * this.pitchPower * auth;
    const r = -this.input.roll * this.rollPower * auth;
    const y = this.input.yaw * this.yawPower * auth;
    _torque.x = _right.x * p + _fwd.x * r + _up.x * y;
    _torque.y = _right.y * p + _fwd.y * r + _up.y * y;
    _torque.z = _right.z * p + _fwd.z * r + _up.z * y;
    body.addTorque(_torque, true);

    /* ---- rate damping ------------------------------------------- */
    // Real airframes have aerodynamic damping in all three axes; without it
    // the aeroplane rings like a bell after every input.
    const av = body.angvel();
    const kd = qDyn * this.wingArea * 0.09 + this.v.def.mass * 0.4;
    _torque.x = -av.x * kd * dt;
    _torque.y = -av.y * kd * dt * 0.6;
    _torque.z = -av.z * kd * dt;
    body.applyTorqueImpulse(_torque, true);

    /* ---- g meter ------------------------------------------------- */
    this.gLoad = 1 + (lift / Math.max(1, this.v.def.mass * G) - 1);
    this.prevVy = lin.y;
  }
}

function _qFrom(q: { x: number; y: number; z: number; w: number }): THREE.Quaternion {
  return _scratchQ.set(q.x, q.y, q.z, q.w);
}
const _scratchQ = new THREE.Quaternion();

function _posOf(body: RAPIER.RigidBody): THREE.Vector3 {
  const t = body.translation();
  return _scratchP.set(t.x, t.y, t.z);
}
const _scratchP = new THREE.Vector3();

/* ================================================================== *
 * Rockets
 * ================================================================== */

interface Rocket {
  active: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  trail: number;
  owner: number;
}

/**
 * A pooled unguided rocket.
 *
 * Stepped in the render frame rather than the fixed step, deliberately: at
 * 118 m/s a rocket covers under two metres a frame and a swept raycast between
 * the previous and current position never tunnels, so the extra fidelity of a
 * fixed-step integration would buy nothing but cost a hook.
 */
class RocketPool {
  private pool: Rocket[] = [];

  constructor() {
    for (let i = 0; i < MAX_ROCKETS; i++) {
      this.pool.push({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, trail: -1, owner: 0 });
    }
  }

  fire(x: number, y: number, z: number, dx: number, dy: number, dz: number, owner: number): boolean {
    for (const r of this.pool) {
      if (r.active) continue;
      r.active = true;
      r.x = x; r.y = y; r.z = z;
      r.vx = dx * ROCKET_SPEED;
      r.vy = dy * ROCKET_SPEED;
      r.vz = dz * ROCKET_SPEED;
      r.life = ROCKET_LIFE;
      r.owner = owner;
      r.trail = rocketTrail(x, y, z);
      return true;
    }
    return false;
  }

  update(dt: number): void {
    for (const r of this.pool) {
      if (!r.active) continue;
      r.life -= dt;
      // Rocket motors burn for about a second, then it is a ballistic lump.
      const burning = r.life > ROCKET_LIFE - 1.1;
      if (burning) {
        const sp = Math.hypot(r.vx, r.vy, r.vz) || 1;
        const a = 120 * dt;
        r.vx += (r.vx / sp) * a;
        r.vy += (r.vy / sp) * a;
        r.vz += (r.vz / sp) * a;
      } else {
        r.vy -= 9.81 * dt;
      }

      const nx = r.x + r.vx * dt;
      const ny = r.y + r.vy * dt;
      const nz = r.z + r.vz * dt;
      const dist = Math.hypot(nx - r.x, ny - r.y, nz - r.z);
      let hitX = nx, hitY = ny, hitZ = nz;
      let detonate = false;

      if (dist > 1e-4 && raycast(r.x, r.y, r.z, r.vx, r.vy, r.vz, dist, _hit, { groups: AIR_QUERY })) {
        hitX = _hit.px;
        hitY = _hit.py;
        hitZ = _hit.pz;
        detonate = true;
      } else if (ny < terrainHeight(nx, nz)) {
        hitY = terrainHeight(nx, nz);
        detonate = true;
      } else if (ny < WORLD.seaLevel) {
        hitY = WORLD.seaLevel;
        detonate = true;
      }

      r.x = nx; r.y = ny; r.z = nz;
      if (r.trail >= 0) trails.move(r.trail, r.x, r.y, r.z);

      if (detonate || r.life <= 0) {
        if (detonate) this.detonate(hitX, hitY, hitZ, r.owner);
        if (r.trail >= 0) trails.release(r.trail);
        r.trail = -1;
        r.active = false;
      }
    }
  }

  private detonate(x: number, y: number, z: number, owner: number): void {
    spawnExplosion(x, y, z, { yield: "rocket", surface: "concrete" });
    // Blast damage to every vehicle in radius, falling off with distance.
    const R = 7.5;
    for (const v of vehicleRuntime.vehicles) {
      if (!v.ready || v.id === owner) continue;
      const d = Math.hypot(v.position.x - x, v.position.y - y, v.position.z - z);
      if (d > R + v.def.length * 0.5) continue;
      const f = clamp01(1 - d / (R + v.def.length * 0.5));
      v.hit(x, y, z, 420 * f * f, "explosion");
    }
    flightSystem.onExplosion?.(x, y, z, R);
  }

  clear(): void {
    for (const r of this.pool) {
      if (r.trail >= 0) trails.release(r.trail);
      r.trail = -1;
      r.active = false;
    }
  }
}

/* ================================================================== *
 * The flight system
 * ================================================================== */

export interface FlightTelemetry {
  /** m/s. */
  airspeed: number;
  /** metres above whatever is below. */
  agl: number;
  /** metres above sea level. */
  altitude: number;
  /** m/s, positive climbing. */
  climb: number;
  /** 0..1 stall severity (aircraft) or vortex-ring risk (helicopter). */
  stall: number;
  /** 0..1 collective / throttle. */
  power: number;
  /** 0..1 rotor speed. */
  rotor: number;
  /** true when the hover autopilot is holding. */
  hover: boolean;
  /** true when auto-level is correcting. */
  levelling: boolean;
  rockets: number;
  gunHeat: number;
}

class FlightSystem {
  readonly telemetry: FlightTelemetry = {
    airspeed: 0, agl: 0, altitude: 0, climb: 0, stall: 0, power: 0, rotor: 0,
    hover: false, levelling: false, rockets: 14, gunHeat: 0,
  };

  /** Assists. Both default on; the options screen can turn them off. */
  autoLevel = true;
  hoverAssist = true;

  private aero = new Map<number, FixedWingAero>();
  private rockets = new RocketPool();
  private detachStep: (() => void) | null = null;

  private gunTimer = 0;
  private gunHeat = 0;
  private rocketTimer = 0;
  private rocketsLeft = 14;
  private rocketSide = 1;
  private hoverTarget = 0;
  private hoverHeld = false;
  private washAcc = 0;

  /** Hook for the damage layer: a blast happened here. */
  onExplosion: ((x: number, y: number, z: number, radius: number) => void) | null = null;
  /** Hook for a hitscan that struck something the vehicle layer does not own. */
  onGunHit: ((x: number, y: number, z: number, nx: number, ny: number, nz: number, damage: number) => void) | null = null;

  /* ---------------- aero registration ---------------- */

  /** Give an aircraft its aerodynamics. Safe to call twice. */
  attachAero(v: VehicleInstance): FixedWingAero {
    let a = this.aero.get(v.id);
    if (!a) {
      a = new FixedWingAero(v);
      this.aero.set(v.id, a);
    }
    this.install();
    return a;
  }

  detachAero(v: VehicleInstance): void {
    this.aero.delete(v.id);
  }

  aeroFor(v: VehicleInstance): FixedWingAero | null {
    return this.aero.get(v.id) ?? null;
  }

  private install(): void {
    if (this.detachStep) return;
    // Aerodynamic forces are forces: they belong in the fixed step or a fast
    // monitor flies differently to a slow one.
    this.detachStep = onFixedStep((dt) => {
      for (const [id, a] of this.aero) {
        const v = vehicleRuntime.get(id);
        if (!v || !v.ready) {
          this.aero.delete(id);
          continue;
        }
        a.step(dt);
      }
    });
  }

  dispose(): void {
    this.detachStep?.();
    this.detachStep = null;
    this.aero.clear();
    this.rockets.clear();
  }

  /* ---------------- the frame ---------------- */

  /**
   * Called once per frame while the player is in a helicopter or an aircraft.
   * `drivingSystem` still owns the camera and the exit; this owns the controls
   * and the weapons.
   */
  update(dt: number): void {
    this.rockets.update(dt);
    this.gunHeat = Math.max(0, this.gunHeat - dt * 0.55);

    const v = drivingSystem.vehicle;
    if (!drivingSystem.active || !v) return;
    const klass = v.def.klass;
    if (klass !== "heli" && klass !== "plane") return;

    const bailed = klass === "heli" ? this.updateHelicopter(dt, v) : this.updateAircraft(dt, v);
    // Bailing hands the frame to the wingsuit; the aircraft we just left must
    // not keep taking trigger pulls on the way down.
    if (bailed) return;

    this.updateWeapons(dt, v);
    this.updateTelemetry(v);
  }

  /* ---------------- helicopter ---------------- */

  private updateHelicopter(dt: number, v: VehicleInstance): boolean {
    const h = v.heli;
    if (!h) return false;
    const s = input.snapshot;
    const inp = h.input;

    const up = input.held("jump") ? 1 : 0;
    const down = input.held("crouch") ? 1 : 0;
    const collectiveAxis = up - down;

    /* ---- collective, with hover hold ---------------------------- */
    if (Math.abs(collectiveAxis) > 0.05 || !this.hoverAssist || !v.running) {
      this.hoverHeld = false;
      // 0.5 is roughly a hover; the stick moves either side of it.
      inp.collective = clamp01(inp.collective + collectiveAxis * dt * 1.35);
      this.hoverTarget = v.position.y;
    } else {
      // Hold the altitude we were at when the stick was released, with a
      // damped-vertical-speed inner loop. This is a real radar-altimeter hold,
      // and it is what makes hovering over a target possible with a mouse.
      this.hoverHeld = true;
      const err = this.hoverTarget - v.position.y;
      const vy = v.velocity.y;
      const want = clamp(err * 0.35 - vy * 0.42, -1, 1);
      const trim = 1 / Math.max(0.2, h.spec.thrustRatio * Math.max(0.2, h.rotorSpeed ** 2));
      inp.collective = clamp01(trim + want * 0.28);
    }

    /* ---- cyclic ------------------------------------------------- */
    const pitchIn = clamp(s.moveZ, -1, 1);
    const rollIn = clamp(s.moveX, -1, 1);
    inp.cyclicPitch = damp(inp.cyclicPitch, pitchIn, 9, dt);
    inp.cyclicRoll = damp(inp.cyclicRoll, rollIn, 9, dt);

    /* ---- pedals ------------------------------------------------- */
    const pedal = (input.held("cut") ? 1 : 0) - (input.held("tetherLink") ? 1 : 0);
    inp.pedal = damp(inp.pedal, pedal, 8, dt);

    /* ---- auto-level --------------------------------------------- */
    // Only when the stick is centred. Proportional on attitude, derivative on
    // body rate — a textbook PD loop, and it disappears the moment you touch
    // the controls, so it never fights an expert.
    const body = v.body;
    this.telemetry.levelling = false;
    if (this.autoLevel && body && body.isValid() && Math.abs(pitchIn) + Math.abs(rollIn) < 0.08) {
      _up.set(0, 1, 0).applyQuaternion(v.quaternion);
      const tiltX = _up.z; // nose up/down component
      const tiltZ = -_up.x; // roll component
      const av = body.angvel();
      const k = v.def.mass * 9.0;
      _torque.x = (-tiltX * k - av.x * k * 0.5) * dt * 6;
      _torque.y = -av.y * k * 0.08 * dt * 6;
      _torque.z = (-tiltZ * k - av.z * k * 0.5) * dt * 6;
      body.applyTorqueImpulse(_torque, true);
      this.telemetry.levelling = Math.abs(tiltX) + Math.abs(tiltZ) > 0.02;
    }

    /* ---- rotor wash --------------------------------------------- */
    const agl = v.position.y - terrainHeight(v.position.x, v.position.z);
    if (agl < v.def.rotorRadius * 2.4 && h.rotorSpeed > 0.4) {
      this.washAcc += dt * 22;
      if (this.washAcc > 1) {
        this.washAcc = 0;
        emitRotorWash(
          v.position.x, terrainHeight(v.position.x, v.position.z), v.position.z,
          v.def.rotorRadius * 1.4,
          clamp01(1 - agl / (v.def.rotorRadius * 2.4)) * h.rotorSpeed,
        );
      }
    }

    // Rotor vibration into the camera. A helicopter is never still.
    // A helicopter is never still: a constant low-level thrum, settling at
    // about 0.3 trauma against the rig's 1.45/s bleed-off.
    cameraRig.addTrauma(h.rotorSpeed * 0.45 * dt);
    v.rotorSpeed = h.rotorSpeed;

    return this.handleBail(v);
  }

  /* ---------------- aircraft ---------------- */

  private updateAircraft(dt: number, v: VehicleInstance): boolean {
    const a = this.attachAero(v);
    const s = input.snapshot;

    a.input.pitch = damp(a.input.pitch, clamp(-s.moveZ, -1, 1), 10, dt);
    a.input.roll = damp(a.input.roll, clamp(s.moveX, -1, 1), 12, dt);
    const rudder = (input.held("cut") ? 1 : 0) - (input.held("tetherLink") ? 1 : 0);
    a.input.yaw = damp(a.input.yaw, rudder, 9, dt);

    const up = input.held("jump") ? 1 : 0;
    const down = input.held("crouch") ? 1 : 0;
    a.input.throttle = clamp01(a.input.throttle + (up - down) * dt * 0.7);

    // Flaps and gear brakes on the ground; on a 700 m stretch of the
    // Embarcadero you need both.
    const onGround = v.car ? v.car.wheelsDown > 0 : false;
    a.input.flaps = onGround && a.airspeed < 45 ? 1 : 0;
    if (v.car) {
      v.car.input.throttle = 0;
      v.car.input.brake = onGround && input.held("crouch") ? 1 : 0;
      // Nosewheel steering while rolling.
      v.car.input.steer = onGround ? clamp(s.moveX, -1, 1) * clamp01(1 - a.airspeed / 40) : 0;
      // Parking brake: hold crouch on the ground to hold position for run-up.
      v.car.input.handbrake = onGround && input.held("crouch") && a.airspeed < 3 ? 1 : 0;
    }

    // Stall buffet — you feel it before the wing lets go.
    if (a.stall > 0.02) cameraRig.addTrauma(a.stall * 1.6 * dt);
    // Auto-level for the aeroplane is a wing-leveller, not an attitude hold:
    // with the stick centred it rolls the wings level and leaves pitch alone.
    const body = v.body;
    this.telemetry.levelling = false;
    if (this.autoLevel && body && body.isValid() && Math.abs(s.moveX) < 0.06 && a.airspeed > 25) {
      _up.set(0, 1, 0).applyQuaternion(v.quaternion);
      const tiltZ = -_up.x;
      const av = body.angvel();
      _fwd.set(0, 0, -1).applyQuaternion(v.quaternion);
      const rollRate = av.x * _fwd.x + av.y * _fwd.y + av.z * _fwd.z;
      const k = v.def.mass * 7;
      const t = (-tiltZ * k - rollRate * k * 0.55) * dt * 5;
      _torque.x = _fwd.x * t;
      _torque.y = _fwd.y * t;
      _torque.z = _fwd.z * t;
      body.applyTorqueImpulse(_torque, true);
      this.telemetry.levelling = Math.abs(tiltZ) > 0.03;
    }

    return this.handleBail(v);
  }

  /* ---------------- weapons ---------------- */

  private updateWeapons(dt: number, v: VehicleInstance): void {
    const armed = v.def.chinGun || v.def.rocketPods;
    if (!armed) return;

    /* ---- gun ---------------------------------------------------- */
    this.gunTimer -= dt;
    if (v.def.chinGun && input.held("fire") && this.gunHeat < 1 && v.running) {
      if (this.gunTimer <= 0) {
        this.gunTimer = 1 / GUN_RPS;
        this.gunHeat = Math.min(1.2, this.gunHeat + 0.035);
        this.fireGun(v);
      }
    }

    /* ---- rockets ------------------------------------------------ */
    this.rocketTimer -= dt;
    if (v.def.rocketPods && input.held("aim") && this.rocketsLeft > 0 && v.running) {
      if (this.rocketTimer <= 0) {
        this.rocketTimer = ROCKET_INTERVAL;
        this.fireRocket(v);
      }
    }
    if (!input.held("aim") && this.rocketsLeft < 14) {
      // Slow rearm so the pods are a resource within a fight but never a
      // dead end between them.
      this.rocketTimer -= dt * 0.35;
      if (this.rocketTimer < -2.4) {
        this.rocketTimer = 0;
        this.rocketsLeft = Math.min(14, this.rocketsLeft + 1);
      }
    }
  }

  private fireGun(v: VehicleInstance): void {
    const def = v.def;
    const originY = originYFor(def);
    // Chin gun sits under the nose and points where the nose points, with a
    // small convergence toward the crosshair so it is usable without a turret.
    v.localToWorld(0, def.clearance + 0.28 - originY, -def.length * 0.5 + 0.3, _v);
    _fwd.set(0, 0, -1).applyQuaternion(v.quaternion);
    // Blend toward the camera's aim so looking around walks the rounds.
    _fwd.lerp(frame.forward, 0.45).normalize();
    // Dispersion: 4 mrad, which at 400 m is a metre and a half.
    _fwd.x += (Math.random() - 0.5) * 0.004;
    _fwd.y += (Math.random() - 0.5) * 0.004;
    _fwd.z += (Math.random() - 0.5) * 0.004;
    _fwd.normalize();

    let endX = _v.x + _fwd.x * GUN_RANGE;
    let endY = _v.y + _fwd.y * GUN_RANGE;
    let endZ = _v.z + _fwd.z * GUN_RANGE;

    if (raycast(_v.x, _v.y, _v.z, _fwd.x, _fwd.y, _fwd.z, GUN_RANGE, _hit, { groups: AIR_QUERY })) {
      endX = _hit.px;
      endY = _hit.py;
      endZ = _hit.pz;
      spawnImpact(endX, endY, endZ, _hit.nx, _hit.ny, _hit.nz, _hit.surface ?? "concrete", 1.2);
      const target = vehicleRuntime.fromPhysicsObject(_hit.object);
      if (target && target !== v) target.hit(endX, endY, endZ, GUN_DAMAGE, "bullet");
      else {
        this.onGunHit?.(endX, endY, endZ, _hit.nx, _hit.ny, _hit.nz, GUN_DAMAGE);
      }
    }

    // One tracer in three — a solid line of tracers is a laser, not a gun.
    if (Math.random() < 0.34) {
      const t = tracerTrail(_v.x, _v.y, _v.z);
      trails.move(t, endX, endY, endZ);
      trails.release(t);
    }
    cameraRig.addKick(-0.0016, (Math.random() - 0.5) * 0.001, 0);
  }

  private fireRocket(v: VehicleInstance): void {
    const def = v.def;
    const originY = originYFor(def);
    const hw = def.width * 0.5;
    this.rocketSide = -this.rocketSide;
    const podX = this.rocketSide * (hw + (def.klass === "heli" ? 0.95 : def.wingSpan * 0.28));
    const podY = (def.klass === "heli" ? def.beltline - 0.36 : def.clearance + 0.72) - originY;
    const podZ = def.klass === "heli" ? def.cabinFrontZ + 0.65 : -0.9;
    v.localToWorld(podX, podY, podZ, _v);
    _fwd.set(0, 0, -1).applyQuaternion(v.quaternion);
    _fwd.lerp(frame.forward, 0.3).normalize();
    if (this.rockets.fire(_v.x, _v.y, _v.z, _fwd.x, _fwd.y, _fwd.z, v.id)) {
      this.rocketsLeft--;
      cameraRig.addKick(-0.004, 0, this.rocketSide * 0.004);
      input.rumble(70, 0.25, 0.35);
    }
  }

  /* ---------------- bail-out ---------------- */

  /**
   * Get out, at altitude, at speed.
   *
   * The handoff to the wingsuit is the important part: you leave the aircraft
   * with its full velocity, and the suit is deployed on the same frame if there
   * is height for it. Jumping out of a burning gunship over the Financial
   * District and flying away is the sort of thing this whole game is for.
   */
  private handleBail(v: VehicleInstance): boolean {
    if (!input.held("parachute") && !input.held("wingsuit")) return false;
    const agl = v.position.y - terrainHeight(v.position.x, v.position.z);
    if (agl < 2.5) return false;

    const wantWing = input.held("wingsuit");
    drivingSystem.exit(true);
    // `exit(true)` already copied the vehicle's velocity into `frame`.
    frame.velocity.y = Math.max(frame.velocity.y, -8);
    cameraRig.addTrauma(0.45);
    input.rumble(220, 0.6, 0.9);

    if (wantWing && wingsuit.canDeploy()) {
      wingsuit.deploy();
      useSfStore.getState().notify("Wingsuit", "info");
    } else if (parachute.canDeploy()) {
      parachute.deploy();
    }
    return true;
  }

  /* ---------------- telemetry ---------------- */

  private updateTelemetry(v: VehicleInstance): void {
    const t = this.telemetry;
    const a = this.aero.get(v.id);
    t.airspeed = a ? a.airspeed : v.velocity.length();
    t.altitude = v.position.y;
    t.agl = v.position.y - terrainHeight(v.position.x, v.position.z);
    t.climb = v.velocity.y;
    t.stall = a ? a.stall : this.vortexRingRisk(v);
    t.power = v.heli ? v.heli.input.collective : a ? a.input.throttle : 0;
    t.rotor = v.heli ? v.heli.rotorSpeed : a ? a.spool : 0;
    t.hover = this.hoverHeld;
    t.rockets = this.rocketsLeft;
    t.gunHeat = clamp01(this.gunHeat);
  }

  /**
   * Vortex ring state: descending fast, slowly, under power. The rotor eats
   * its own downwash and stops making lift. Reported rather than simulated —
   * `physics.Helicopter` does not model it — but the warning alone changes how
   * players fly, and the fix (get some forward speed) is the real one.
   */
  private vortexRingRisk(v: VehicleInstance): number {
    if (!v.heli) return 0;
    const descent = -v.velocity.y;
    const horiz = Math.hypot(v.velocity.x, v.velocity.z);
    if (descent < 4 || horiz > 9) return 0;
    return clamp01((descent - 4) / 8) * clamp01(1 - horiz / 9) * v.heli.input.collective;
  }

  /** Refill the pods — a pickup, a helipad, a mission reset. */
  rearm(): void {
    this.rocketsLeft = 14;
    this.gunHeat = 0;
  }
}

export const flightSystem = new FlightSystem();
