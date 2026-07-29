/**
 * boats.ts — the bay.
 *
 * San Francisco is half water, and a city you can only cross by road is half a
 * city. This is the traversal layer for the other half: the speedboat and the
 * jet ski, the wave surface they ride on, the wake they leave, and what happens
 * when you drive one onto Baker Beach at thirty knots.
 *
 * The single most important thing in this file is not the boat — it is
 * `installWaterSampler()`.
 *
 * `Bay.tsx` displaces its surface with a four-wave Gerstner sum evaluated on
 * the GPU. `physics/vehiclePhysics.ts` floats things on `WORLD.seaLevel` unless
 * somebody hands it a height function. Until those two agree, a boat sits on a
 * flat plane while the water visibly heaves around it, which is the exact
 * uncanny failure that makes water in games look cheap. So this module
 * reimplements the *same* four waves, with the same wavelengths, the same
 * steepnesses, the same dispersion relation and the same time source, on the
 * CPU, and injects it. The hull then genuinely rides the swell you can see: it
 * pitches over the crests, the stern squats in the troughs, and a wake off the
 * Golden Gate throws the bow.
 *
 * The rest:
 *  • **Planing.** Below hull speed a boat pushes water; above it, it climbs its
 *    own bow wave and skims. Modelled as a speed-dependent lift force plus a
 *    drag that *drops* once you are up on the plane, which is why a speedboat
 *    accelerates hard, then harder.
 *  • **Wake and spray.** Two persistent trails from the transom corners, bow
 *    spray scaled by how hard the hull is slamming, and a rooster tail behind
 *    the jet ski.
 *  • **Beaching.** Ground contact under the keel kills thrust, adds a scraping
 *    drag and throws the crew forward. Getting off again means reverse and
 *    patience.
 *
 * Public API
 * ----------
 *   installWaterSampler() / uninstallWaterSampler()
 *   waveHeight(x, z, t) / waveNormal(x, z, t, out)
 *   boatSystem.update(dt)          once per frame
 *   boatSystem.attach(v)           start tracking a boat's wake and beaching
 */
import * as THREE from "three";
import { WORLD, landSDF, terrainHeight } from "../geo/sfGeo";
import { frame } from "../state/store";
import { clamp, clamp01, damp } from "../math/rng";
import { cameraRig, input } from "@/sf/player";
import { setWaterHeightSampler } from "@/sf/physics";
import { emitWaterSplash, trails } from "@/sf/vfx";
import { drivingSystem } from "./driving";
import { vehicleRuntime, type VehicleInstance } from "./vehicle";

/* ================================================================== *
 * The wave surface
 * ================================================================== *
 * Mirrors the vertex shader in `world/Bay.tsx` exactly. If that file's wave
 * table changes, this one has to change with it — they are one surface
 * described twice, and the whole point is that they never disagree.
 */

interface WaveDef {
  /** Direction offset added to the wind vector before normalising. */
  dx: number;
  dz: number;
  /** Steepness at unit energy. */
  steep: number;
  /** Wavelength, metres. */
  length: number;
}

const WAVES: WaveDef[] = [
  { dx: 0.0, dz: 0.0, steep: 0.16, length: 128 },
  { dx: 0.6, dz: -0.4, steep: 0.13, length: 61 },
  { dx: -0.8, dz: 0.5, steep: 0.1, length: 27 },
  { dx: 1.2, dz: 0.9, steep: 0.07, length: 11 },
];

const TWO_PI = Math.PI * 2;

/**
 * Surface height at a world point.
 *
 * `t` defaults to `frame.time`, which is what the Bay shader is fed. Passing
 * the physics sim time instead would drift the two apart by however far the
 * fixed-step accumulator happens to be lagging, and a boat floating 4 cm above
 * the water it is meant to be in is very visible.
 */
export function waveHeight(x: number, z: number, t: number = frame.time): number {
  const wx = frame.windDirection.x;
  const wz = frame.windDirection.y;
  const energy = clamp(frame.windSpeed / 12, 0.25, 1.6);
  let y = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i];
    let dx = wx + w.dx;
    let dz = wz + w.dz;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const k = TWO_PI / w.length;
    const c = Math.sqrt(9.81 / k);
    const steep = w.steep * energy;
    const a = steep / k;
    const f = k * (dx * x + dz * z - c * t);
    y += a * Math.sin(f);
  }
  return WORLD.seaLevel + y;
}

/**
 * Analytic surface normal. Same sum, differentiated — no finite differences,
 * so it stays exact at any wavelength and costs the same as the height.
 */
export function waveNormal(x: number, z: number, t: number, out: THREE.Vector3): THREE.Vector3 {
  const wx = frame.windDirection.x;
  const wz = frame.windDirection.y;
  const energy = clamp(frame.windSpeed / 12, 0.25, 1.6);
  let tx = 1, ty = 0, tz = 0;
  let bx = 0, by = 0, bz = 1;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i];
    let dx = wx + w.dx;
    let dz = wz + w.dz;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const k = TWO_PI / w.length;
    const c = Math.sqrt(9.81 / k);
    const steep = w.steep * energy;
    const f = k * (dx * x + dz * z - c * t);
    const sf = Math.sin(f);
    const cf = Math.cos(f);
    tx += -dx * dx * steep * sf;
    ty += dx * steep * cf;
    tz += -dx * dz * steep * sf;
    bx += -dx * dz * steep * sf;
    by += dz * steep * cf;
    bz += -dz * dz * steep * sf;
  }
  // n = binormal × tangent, matching the shader's handedness.
  out.set(by * tz - bz * ty, bz * tx - bx * tz, bx * ty - by * tx);
  if (out.y < 0) out.negate();
  return out.normalize();
}

let installed = false;

/** Hand the Gerstner surface to the buoyancy solver. Idempotent. */
export function installWaterSampler(): void {
  if (installed) return;
  installed = true;
  setWaterHeightSampler((x, z) => waveHeight(x, z, frame.time));
}

export function uninstallWaterSampler(): void {
  if (!installed) return;
  installed = false;
  setWaterHeightSampler(null);
}

/* ================================================================== *
 * Scratch
 * ================================================================== */

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _n = new THREE.Vector3();

/* ================================================================== *
 * Per-boat state
 * ================================================================== */

interface BoatState {
  v: VehicleInstance;
  /** Two persistent wake ribbons from the transom corners. */
  wake: [number, number];
  /** 0..1 — how far up on the plane the hull is. */
  plane: number;
  /** Vertical velocity last frame, for slam detection. */
  prevVy: number;
  beached: boolean;
  beachTimer: number;
  sprayAcc: number;
  /** Rooster tail behind a jet ski. */
  rooster: number;
}

/* ================================================================== *
 * The system
 * ================================================================== */

/** Speed at which a planing hull is fully up, m/s. */
const PLANE_SPEED = 11;
/** Extra lift on the plane, as a fraction of weight. */
const PLANE_LIFT = 0.42;

class BoatSystem {
  private states = new Map<number, BoatState>();

  /** Start tracking a boat. Safe to call every frame. */
  attach(v: VehicleInstance): void {
    if (v.def.klass !== "boat" || this.states.has(v.id)) return;
    this.states.set(v.id, {
      v,
      wake: [-1, -1],
      plane: 0,
      prevVy: 0,
      beached: false,
      beachTimer: 0,
      sprayAcc: 0,
      rooster: -1,
    });
  }

  detach(id: number): void {
    const s = this.states.get(id);
    if (!s) return;
    for (const h of s.wake) if (h >= 0) trails.release(h);
    if (s.rooster >= 0) trails.release(s.rooster);
    this.states.delete(id);
  }

  /**
   * Called once per frame. Adopts any boat the runtime knows about, drives the
   * player's controls if they are in one, and runs wake/spray/beaching for all
   * of them so an AI ferry leaves a wake too.
   */
  update(dt: number): void {
    installWaterSampler();

    for (const v of vehicleRuntime.vehicles) {
      if (v.def.klass === "boat") this.attach(v);
    }

    const player = drivingSystem.active ? drivingSystem.vehicle : null;
    if (player && player.def.klass === "boat") this.drive(dt, player);

    for (const [id, s] of this.states) {
      const v = vehicleRuntime.get(id);
      if (!v || !v.ready || !v.alive) {
        this.detach(id);
        continue;
      }
      this.stepBoat(dt, s);
    }
  }

  /* ---------------- controls ---------------- */

  private drive(dt: number, v: VehicleInstance): void {
    const b = v.boat;
    if (!b) return;
    const s = input.snapshot;
    const throttle = clamp(s.moveZ, -1, 1);
    const rudder = clamp(s.moveX, -1, 1);
    const boost = input.held("sprint") ? 1.28 : 1;

    // A propeller cannot make reverse thrust as well as forward thrust; a
    // real stern drive is about 45% as effective backing down.
    const t = throttle >= 0 ? throttle * boost : throttle * 0.45;
    b.input.throttle = damp(b.input.throttle, v.running ? t : 0, 3.2, dt);
    b.input.rudder = damp(b.input.rudder, rudder, 6, dt);

    v.lights.brake = throttle < -0.05 ? 1 : 0;
    v.lights.reverse = throttle < -0.3 ? 1 : 0;

    // A jet ski steers by vectoring its thrust: no throttle, no steering. That
    // one detail is the entire character of the machine.
    if (v.kind === "jetski" && Math.abs(t) < 0.05) {
      b.input.rudder *= 0.15;
    }
  }

  /* ---------------- per-boat physics + presentation ---------------- */

  private stepBoat(dt: number, s: BoatState): void {
    const v = s.v;
    const b = v.boat;
    if (!b || !b.body || !b.body.isValid()) return;
    const body = b.body;
    const def = v.def;

    _fwd.set(0, 0, -1).applyQuaternion(v.quaternion);
    _right.set(1, 0, 0).applyQuaternion(v.quaternion);
    _up.set(0, 1, 0).applyQuaternion(v.quaternion);
    const speed = v.velocity.dot(_fwd);
    const absSpeed = Math.abs(speed);

    /* ---- planing ------------------------------------------------ */
    // Below hull speed the boat is pushing a wall of water; above it, it
    // climbs onto its own bow wave and the wetted area collapses.
    const want = clamp01((absSpeed - PLANE_SPEED * 0.45) / (PLANE_SPEED * 0.55));
    s.plane = damp(s.plane, b.buoyancy.submerged > 0.05 ? want : 0, 2.2, dt);
    if (s.plane > 0.02) {
      const lift = def.mass * 9.81 * PLANE_LIFT * s.plane;
      // Applied aft of the centre so the bow rises — the visual signature of
      // a boat getting up on the plane.
      _v.copy(_fwd).multiplyScalar(-def.length * 0.22).add(v.position);
      body.addForceAtPoint({ x: 0, y: lift, z: 0 }, { x: _v.x, y: _v.y, z: _v.z }, true);
    }

    /* ---- beaching ------------------------------------------------ */
    const groundY = terrainHeight(v.position.x, v.position.z);
    const keelY = v.position.y - def.hullDraft;
    const onLand = landSDF(v.position.x, v.position.z) > -1.5 || keelY < groundY + 0.05;
    if (onLand) {
      if (!s.beached) {
        s.beached = true;
        s.beachTimer = 0;
        // The crunch: everything stops, hard.
        if (v === drivingSystem.vehicle) {
          cameraRig.addTrauma(clamp01(absSpeed * 0.06));
          cameraRig.addKick(-absSpeed * 0.004, 0, 0);
          input.rumble(240, 0.5, 0.8);
        }
        if (absSpeed > 6) v.hit(v.position.x, v.position.y, v.position.z, absSpeed * 9, "collision");
        emitWaterSplash(v.position.x, WORLD.seaLevel, v.position.z, clamp01(absSpeed * 0.1) * 2);
      }
      s.beachTimer += dt;
      // Sand and shingle: a large, speed-proportional drag plus a hard stop on
      // the vertical, so a beached hull sits rather than bobs.
      const lin = body.linvel();
      const k = def.mass * 3.4 * dt;
      body.applyImpulse({ x: -lin.x * k * 0.02, y: -Math.min(0, lin.y) * k * 0.06, z: -lin.z * k * 0.02 }, true);
      // Keep it from sinking into the terrain.
      if (keelY < groundY) {
        body.applyImpulse({ x: 0, y: (groundY - keelY) * def.mass * 3.2 * dt, z: 0 }, true);
      }
      b.input.throttle *= 0.35;
    } else if (s.beached) {
      s.beached = false;
    }

    /* ---- slam ---------------------------------------------------- */
    // A hull re-entering the water after a wave jump lands hard. The impact is
    // the difference between the vertical velocity before and after the water
    // caught it.
    const vy = v.velocity.y;
    const slam = s.prevVy < -3.2 && vy > s.prevVy + 1.5 ? -s.prevVy : 0;
    s.prevVy = vy;
    if (slam > 0) {
      emitWaterSplash(v.position.x, waveHeight(v.position.x, v.position.z), v.position.z, clamp01(slam * 0.12) * 2.4);
      if (v === drivingSystem.vehicle) {
        cameraRig.addTrauma(clamp01(slam * 0.045));
        cameraRig.landed(slam * 0.55);
      }
    }

    /* ---- wake + spray -------------------------------------------- */
    this.updateWake(dt, s, absSpeed);
  }

  /**
   * The wake.
   *
   * Two ribbons from the transom corners, kept alive while the boat is moving
   * and released when it stops, plus bow spray whose rate follows both speed
   * and how much the bow is buried. Ribbons rather than particles because a
   * wake is a continuous surface feature and particles at this scale read as
   * fog.
   */
  private updateWake(dt: number, s: BoatState, absSpeed: number): void {
    const v = s.v;
    const def = v.def;
    const moving = absSpeed > 1.4 && (v.boat?.buoyancy.submerged ?? 0) > 0.04 && !s.beached;

    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      v.localToWorld(side * def.width * 0.42, -def.hullDraft * 0.2, def.length * 0.46, _v);
      _v.y = waveHeight(_v.x, _v.z) + 0.06;
      if (moving) {
        if (s.wake[i] < 0) {
          s.wake[i] = trails.acquire(_v.x, _v.y, _v.z, {
            width: def.width * 0.42,
            life: 3.6,
            minStep: 1.1,
            r: 0.92, g: 0.96, b: 0.98, a: 0.5,
            ramp: 0,
            additive: false,
          });
        } else {
          trails.move(s.wake[i], _v.x, _v.y, _v.z);
        }
      } else if (s.wake[i] >= 0) {
        trails.release(s.wake[i]);
        s.wake[i] = -1;
      }
    }

    if (!moving) return;

    // Bow spray. Rate rises with speed and with how deep the forefoot is.
    v.localToWorld(0, -def.hullDraft * 0.4, -def.length * 0.46, _v);
    const surface = waveHeight(_v.x, _v.z);
    const bury = clamp01((surface - _v.y) / Math.max(0.2, def.hullDraft));
    s.sprayAcc += dt * (absSpeed * 1.6) * (0.3 + bury * 1.6);
    if (s.sprayAcc > 1) {
      s.sprayAcc = 0;
      emitWaterSplash(_v.x, surface, _v.z, clamp01(absSpeed / 24 + bury * 0.5));
    }

    // Rooster tail: a jet drive throws a plume straight up behind it.
    if (v.kind === "jetski" && absSpeed > 6) {
      v.localToWorld(0, 0.1, def.length * 0.5, _v);
      const y = waveHeight(_v.x, _v.z);
      if (s.rooster < 0) {
        s.rooster = trails.acquire(_v.x, y, _v.z, {
          width: 0.5, life: 0.9, minStep: 0.7,
          r: 1, g: 1, b: 1, a: 0.55, ramp: 1, additive: false,
        });
      } else {
        trails.move(s.rooster, _v.x, y + 0.9 + absSpeed * 0.05, _v.z);
      }
    } else if (s.rooster >= 0) {
      trails.release(s.rooster);
      s.rooster = -1;
    }
  }

  /** Surface normal under a boat — the HUD's artificial horizon uses it. */
  surfaceNormal(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return waveNormal(x, z, frame.time, out);
  }

  /** Is this world point in navigable water? Used by AI boat routing. */
  navigable(x: number, z: number, draft = 0.8): boolean {
    if (landSDF(x, z) > -2) return false;
    return terrainHeight(x, z) < WORLD.seaLevel - draft;
  }

  dispose(): void {
    for (const id of Array.from(this.states.keys())) this.detach(id);
    this.states.clear();
    uninstallWaterSampler();
  }
}

export const boatSystem = new BoatSystem();

/** Convenience for other systems: how high the water is right now. */
export function seaLevelAt(x: number, z: number): number {
  return waveHeight(x, z, frame.time);
}

export { _n as boatScratchNormal };
