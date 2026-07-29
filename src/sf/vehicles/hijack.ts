/**
 * hijack.ts — taking someone else's car off them.
 *
 * The Just Cause staple, and the single interaction that most defines whether
 * a city feels like a playground or like scenery. Three verbs:
 *
 *  1. **Ground hijack.** Sprint at a car — moving or stopped — and press
 *     interact. The player closes the last two metres, rips the door open,
 *     throws the driver into the road and is behind the wheel before the car
 *     has finished rolling. It works at speed because every keyframe target is
 *     recomputed from the vehicle's *live* transform, so a target doing 60 km/h
 *     is simply a target whose door handle is moving. Nothing about the
 *     sequence is authored in world space.
 *
 *  2. **Air hijack.** Grapple over a moving vehicle, press interact while
 *     falling toward it, and the player drops through the roof into the seat.
 *     Available from a tether, a wingsuit or a plain fall; the only requirement
 *     is that you are above it and coming down.
 *
 *  3. **Roof riding.** Land on a car and stay on it. The player is attached to
 *     a local point on the bodywork and moved by the *delta* of that point each
 *     frame, so they keep their own footing, can walk around, shoot, and jump
 *     off, while the car goes wherever it was going.
 *
 * The animation is first-person, which means it is entirely camera work: a
 * reach, a whip toward the driver as they come out, and a settle into the seat.
 * That is not a shortcut — it is what these look like from inside the player's
 * head, and it never breaks because there is no character rig to desynchronise.
 *
 * Public API
 * ----------
 *   hijackSystem.update(dt)     once per frame, after the player controller
 *   hijackSystem.prompt         { active, vehicleId, kind, label } for the HUD
 *   hijackSystem.state          "none" | "prompt" | "hijack" | "air" | "riding"
 *   hijackSystem.cancel()
 */
import * as THREE from "three";
import { PLAYER, VEHICLE } from "../config";
import { frame, useSfStore } from "../state/store";
import { walkableHeight } from "../geo/sfGeo";
import { clamp, clamp01, damp, smoothstep } from "../math/rng";
import { cameraRig, grappleSystem, input, playerCtrl } from "@/sf/player";
import { playerController as charCtrl } from "@/sf/physics";
import { drivingSystem, nearestSeat } from "./driving";
import { originYFor } from "./models";
import { vehicleRuntime, type VehicleInstance } from "./vehicle";

/* ================================================================== *
 * Tuning
 * ================================================================== */

/** Base reach, from config, plus the lunge a sprint buys you. */
const REACH = VEHICLE.hijackRange;
const SPRINT_REACH = REACH + 2.3;
/** How far ahead of the player a moving vehicle may be and still be grabbable. */
const LEAD_TIME = 0.35;
/** Vertical window for an air hijack, metres above the roof. */
const AIR_HEIGHT = 14;
/** Horizontal window for an air hijack. */
const AIR_RADIUS = 5.5;
/** Minimum closing speed for an air hijack to be offered, m/s. */
const AIR_CLOSING = 2.5;

const GROUND_DURATION = 0.86;
const AIR_DURATION = 0.62;

/* ================================================================== *
 * Scratch
 * ================================================================== */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _target = new THREE.Vector3();
const _prevAttach = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _q = new THREE.Quaternion();

export type HijackState = "none" | "prompt" | "hijack" | "air" | "riding";
export type HijackKind = "ground" | "air" | "board" | "ride";

export interface HijackPrompt {
  active: boolean;
  vehicleId: number;
  kind: HijackKind;
  /** HUD string, e.g. "HIJACK — Police Cruiser". */
  label: string;
  /** 0..1 how centred/close the target is; the HUD can fade on it. */
  strength: number;
}

/* ================================================================== *
 * The system
 * ================================================================== */

class HijackSystem {
  state: HijackState = "none";
  readonly prompt: HijackPrompt = {
    active: false, vehicleId: 0, kind: "ground", label: "", strength: 0,
  };

  /* ---- sequence ---- */
  private target: VehicleInstance | null = null;
  private seat = 0;
  private t = 0;
  private duration = GROUND_DURATION;
  private kind: HijackKind = "ground";
  /** Where the camera started the sequence, world space. */
  private from = new THREE.Vector3();
  private fromYaw = 0;
  private ejected = false;
  private doorIndex = -1;

  /* ---- riding ---- */
  private ride: VehicleInstance | null = null;
  private rideLocal = new THREE.Vector3();
  private rideValid = false;

  /* ---- edges (see driving.ts for why we do not use input.pressed) ---- */
  private interactPrev = false;
  private jumpPrev = false;

  /* ---------------- frame ---------------- */

  update(dt: number): void {
    const interactNow = input.held("interact");
    const interactEdge = interactNow && !this.interactPrev;
    this.interactPrev = interactNow;
    const jumpNow = input.held("jump");
    const jumpEdge = jumpNow && !this.jumpPrev;
    this.jumpPrev = jumpNow;

    if (frame.paused) return;

    // A sequence in flight owns everything.
    if (this.state === "hijack" || this.state === "air") {
      this.advanceSequence(dt);
      return;
    }

    // Already driving: nothing to hijack, but stay out of the way.
    if (drivingSystem.active) {
      this.clearPrompt();
      this.state = "none";
      return;
    }

    if (this.state === "riding") {
      this.updateRiding(dt, jumpEdge, interactEdge);
      return;
    }

    // Look for something to ride first: if you are standing on a car, that is
    // unambiguously what you meant to do.
    const under = this.vehicleUnderfoot();
    if (under) {
      this.beginRide(under);
      return;
    }

    const cand = this.findTarget();
    if (!cand) {
      this.clearPrompt();
      this.state = "none";
      return;
    }

    this.state = "prompt";
    this.prompt.active = true;
    this.prompt.vehicleId = cand.v.id;
    this.prompt.kind = cand.kind;
    this.prompt.strength = cand.strength;
    this.prompt.label =
      cand.kind === "air"
        ? `SKYJACK — ${cand.v.def.label}`
        : cand.v.wrecked
          ? `${cand.v.def.label} (wrecked)`
          : cand.v.freeSeat(true) === 0
            ? `HIJACK — ${cand.v.def.label}`
            : `RIDE — ${cand.v.def.label}`;

    if (interactEdge && !cand.v.wrecked) {
      this.begin(cand.v, cand.kind);
    }
  }

  cancel(): void {
    if (this.state === "hijack" || this.state === "air") {
      this.state = "none";
      this.target = null;
      frame.vehicleId = null;
      playerCtrl.exitVehicle(frame.position.x, frame.position.y, frame.position.z);
    }
    this.detachRide();
  }

  /* ---------------- target selection ---------------- */

  /**
   * Find the best hijack candidate.
   *
   * Moving vehicles are *led*: the test point is where the vehicle will be in
   * `LEAD_TIME`, which is what makes running alongside a car and grabbing it
   * feel like the game understood your intention rather than punishing your
   * reaction time. Sprinting extends the reach, so the verb reads as a lunge.
   */
  private findTarget(): { v: VehicleInstance; kind: HijackKind; strength: number } | null {
    const px = frame.position.x;
    const py = frame.position.y;
    const pz = frame.position.z;
    const airborne = !frame.grounded;
    const falling = frame.velocity.y < -AIR_CLOSING;
    const sprinting = input.held("sprint");
    const reach = sprinting ? SPRINT_REACH : REACH;

    let best: VehicleInstance | null = null;
    let bestScore = -1;
    let bestKind: HijackKind = "ground";

    for (const v of vehicleRuntime.vehicles) {
      if (!v.ready || v === drivingSystem.vehicle) continue;
      if (v.def.klass === "rail" && v.wrecked) continue;

      // Lead the target.
      _v.copy(v.position).addScaledVector(v.velocity, LEAD_TIME);
      const dx = _v.x - px;
      const dy = _v.y - py;
      const dz = _v.z - pz;
      const dist = Math.hypot(dx, dy, dz);

      /* ---- air hijack ---- */
      if (airborne && falling) {
        const horiz = Math.hypot(dx, dz);
        const drop = py - v.position.y;
        if (horiz < AIR_RADIUS + v.def.width * 0.5 && drop > 0.4 && drop < AIR_HEIGHT) {
          // Prefer whatever is most directly below and closest.
          const s = 3 + (1 - horiz / (AIR_RADIUS + v.def.width * 0.5)) * 2 + (1 - drop / AIR_HEIGHT);
          if (s > bestScore) {
            bestScore = s;
            best = v;
            bestKind = "air";
          }
          continue;
        }
      }

      /* ---- ground hijack ---- */
      const bodyReach = reach + Math.max(v.def.length, v.def.width) * 0.5;
      if (dist > bodyReach) continue;
      // Must be roughly in front of the player — you cannot hijack something
      // behind your head.
      _fwd.copy(frame.forward);
      const dot = (dx * _fwd.x + dy * _fwd.y + dz * _fwd.z) / Math.max(dist, 1e-3);
      if (dot < 0.12) continue;
      // Closing speed helps: running *at* a car should beat standing next to
      // a different one.
      const rel = Math.max(0, -(v.velocity.x - frame.velocity.x) * (dx / Math.max(dist, 1e-3)));
      const s = dot * 1.6 + (1 - dist / bodyReach) * 1.8 + clamp01(rel * 0.05);
      if (s > bestScore) {
        bestScore = s;
        best = v;
        bestKind = v.freeSeat(true) === 0 ? "ground" : "board";
      }
    }

    if (!best) return null;
    return { v: best, kind: bestKind, strength: clamp01(bestScore / 4) };
  }

  private clearPrompt(): void {
    this.prompt.active = false;
    this.prompt.vehicleId = 0;
    this.prompt.strength = 0;
    this.prompt.label = "";
  }

  /* ---------------- the sequence ---------------- */

  private begin(v: VehicleInstance, kind: HijackKind): void {
    this.target = v;
    this.kind = kind === "board" ? "ground" : kind;
    this.state = kind === "air" ? "air" : "hijack";
    this.duration = kind === "air" ? AIR_DURATION : GROUND_DURATION;
    this.t = 0;
    this.ejected = false;
    this.seat = kind === "board" ? Math.max(1, nearestSeat(v, frame.position.x, frame.position.y, frame.position.z)) : 0;
    this.from.copy(cameraRig.eye.lengthSq() > 0 ? cameraRig.eye : frame.position);
    this.fromYaw = frame.yaw;
    this.detachRide();

    // Hand the camera to the vehicle blend for the duration; this also stops
    // the character controller simulating a capsule that is about to be
    // teleported through a door.
    playerCtrl.enterVehicle(v.id);
    grappleSystem.cutAll(false);

    this.doorIndex = v.openDoorNear(this.seat);
    cameraRig.addTrauma(kind === "air" ? 0.42 : 0.2);
    input.rumble(140, 0.35, 0.55);
    if (kind === "air") {
      v.model?.breakGlass("front");
      useSfStore.getState().addChaos(35, "Skyjack");
    }
  }

  /**
   * Advance the scripted camera.
   *
   * Every waypoint is expressed in the vehicle's local frame and converted to
   * world space *this frame*, so the whole animation rides the vehicle. That is
   * the entire trick to hijacking something at 25 m/s.
   */
  private advanceSequence(dt: number): void {
    const v = this.target;
    if (!v || !v.ready || !v.alive) {
      this.state = "none";
      this.target = null;
      playerCtrl.exitVehicle(frame.position.x, frame.position.y, frame.position.z);
      return;
    }

    this.t += dt;
    const u = clamp01(this.t / this.duration);
    const def = v.def;
    const originY = originYFor(def);
    const s = def.seats[this.seat] ?? def.seats[0];
    const side = Math.sign((s?.x ?? -1) || -1);

    // Waypoints, vehicle-local.
    const seatLocal = _v2.set(s ? s.x : 0, (s ? s.y : 1) - originY + 0.66, s ? s.z - 0.05 : 0);
    const doorLocal = _v.set(
      side * (def.width * 0.5 + 0.42),
      def.beltline - originY + 0.24,
      s ? s.z : 0,
    );

    if (this.kind === "air") {
      // Three beats: fall through the roof line, punch in, settle.
      const roofLocal = _v.set(0, def.roof - originY + 0.55, (def.cabinFrontZ + def.cabinRearZ) * 0.5);
      if (u < 0.45) {
        const k = smoothstep(0, 1, u / 0.45);
        v.localToWorld(roofLocal.x, roofLocal.y, roofLocal.z, _target);
        _target.lerpVectors(this.from, _target, k);
      } else {
        const k = smoothstep(0, 1, (u - 0.45) / 0.55);
        v.localToWorld(roofLocal.x, roofLocal.y, roofLocal.z, _target);
        v.localToWorld(seatLocal.x, seatLocal.y, seatLocal.z, _v);
        _target.lerp(_v, k);
      }
      if (!this.ejected && u > 0.42) this.ejectDriver(v);
    } else {
      // Ground: reach for the handle, whip as the driver comes out, slide in.
      if (u < 0.34) {
        const k = smoothstep(0, 1, u / 0.34);
        v.localToWorld(doorLocal.x, doorLocal.y, doorLocal.z, _target);
        _target.lerpVectors(this.from, _target, k);
      } else if (u < 0.62) {
        const k = smoothstep(0, 1, (u - 0.34) / 0.28);
        v.localToWorld(doorLocal.x, doorLocal.y, doorLocal.z, _target);
        // Lean back as the driver is dragged past the lens.
        _target.y += Math.sin(k * Math.PI) * 0.18;
        _target.x -= side * Math.sin(k * Math.PI) * 0.22;
      } else {
        const k = smoothstep(0, 1, (u - 0.62) / 0.38);
        v.localToWorld(doorLocal.x, doorLocal.y, doorLocal.z, _target);
        v.localToWorld(seatLocal.x, seatLocal.y, seatLocal.z, _v);
        _target.lerp(_v, k);
      }
      if (!this.ejected && u > 0.36) this.ejectDriver(v);
      // Door swings wide over the yank and closes as we seat.
      if (this.doorIndex >= 0) {
        v.doorTarget[this.doorIndex] = u < 0.72 ? 1 : 0;
      }
    }

    // Aim the look at the driver during the yank, then at the road.
    _q.copy(v.quaternion);
    _fwd.set(0, 0, -1).applyQuaternion(_q);
    const heading = Math.atan2(-_fwd.x, -_fwd.z);
    const yawTarget =
      this.kind === "ground" && u > 0.34 && u < 0.62 ? heading + side * 0.85 : heading;
    const d = ((yawTarget - frame.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    frame.yaw += d * clamp01(9 * dt);
    frame.pitch = damp(frame.pitch, this.kind === "air" && u < 0.5 ? -0.5 : -0.05, 7, dt);

    playerCtrl.setVehicleSeat(_target.x, _target.y, _target.z);
    frame.position.copy(v.position);
    frame.velocity.copy(v.velocity);
    charCtrl.setPosition(v.position.x, v.position.y, v.position.z);

    if (u >= 1) {
      this.state = "none";
      const id = v.id;
      const seat = this.seat;
      this.target = null;
      this.clearPrompt();
      if (this.doorIndex >= 0) v.doorTarget[this.doorIndex] = 0;
      this.doorIndex = -1;
      if (!drivingSystem.enter(id, seat)) {
        playerCtrl.exitVehicle(frame.position.x, frame.position.y + 1, frame.position.z);
      }
    }
  }

  /** Throw the current driver into the road. */
  private ejectDriver(v: VehicleInstance): void {
    this.ejected = true;
    _fwd.set(0, 0, -1).applyQuaternion(v.quaternion);
    const occ = v.ejectOccupant(this.seat, -_fwd.x, -_fwd.z);
    cameraRig.addTrauma(0.3);
    cameraRig.addKick(0.02, 0.05, 0.06);
    input.rumble(180, 0.5, 0.8);
    if (occ) {
      useSfStore.getState().addChaos(15, "Carjacking");
    }
    // Some cars are locked; breaking in costs the window.
    if (v.locked) {
      v.model?.breakGlass("side");
      v.locked = false;
    }
  }

  /* ---------------- roof riding ---------------- */

  /** The vehicle the player is standing on, if any. */
  private vehicleUnderfoot(): VehicleInstance | null {
    if (!frame.grounded || drivingSystem.active) return null;
    const feetY = frame.position.y - PLAYER.height * 0.5;
    for (const v of vehicleRuntime.vehicles) {
      if (!v.ready) continue;
      const def = v.def;
      const r = Math.max(def.length, def.width) * 0.5 + 0.4;
      if (
        (v.position.x - frame.position.x) ** 2 + (v.position.z - frame.position.z) ** 2 > r * r
      ) {
        continue;
      }
      v.worldToLocal(frame.position.x, feetY, frame.position.z, _v);
      const originY = originYFor(def);
      const top = def.roof - originY;
      if (
        Math.abs(_v.x) < def.width * 0.5 + 0.25 &&
        Math.abs(_v.z) < def.length * 0.5 + 0.25 &&
        _v.y > top - 0.75 &&
        _v.y < top + 0.7
      ) {
        return v;
      }
    }
    return null;
  }

  private beginRide(v: VehicleInstance): void {
    this.state = "riding";
    this.ride = v;
    v.worldToLocal(frame.position.x, frame.position.y, frame.position.z, this.rideLocal);
    v.localToWorld(this.rideLocal.x, this.rideLocal.y, this.rideLocal.z, _prevAttach);
    this.rideValid = true;
    this.prompt.active = true;
    this.prompt.vehicleId = v.id;
    this.prompt.kind = "ride";
    this.prompt.strength = 1;
    this.prompt.label = `RIDING — ${v.def.label}`;
  }

  private detachRide(): void {
    this.ride = null;
    this.rideValid = false;
    if (this.state === "riding") this.state = "none";
  }

  /**
   * Carry the player with the vehicle.
   *
   * Position is advanced by the *delta* of the attach point rather than being
   * set to it, so the player keeps whatever motion the character controller
   * gave them this frame — they can walk up the bonnet, turn round, and shoot
   * backwards while the truck they are on takes a corner.
   */
  private updateRiding(dt: number, jumpEdge: boolean, interactEdge: boolean): void {
    const v = this.ride;
    if (!v || !v.ready || !v.alive) {
      this.detachRide();
      return;
    }

    // Re-anchor from where the player actually is; they may have walked.
    v.worldToLocal(frame.position.x, frame.position.y, frame.position.z, _v);
    const def = v.def;
    const originY = originYFor(def);
    const top = def.roof - originY;
    const onBody =
      Math.abs(_v.x) < def.width * 0.5 + 0.45 &&
      Math.abs(_v.z) < def.length * 0.5 + 0.45 &&
      _v.y > top - 1.1;
    if (!onBody || jumpEdge) {
      // Jumping off inherits the vehicle's velocity, which is the whole point
      // of riding a truck up to speed and then leaping.
      if (jumpEdge) {
        frame.velocity.add(v.velocity);
        cameraRig.addKick(-0.012, 0, 0);
      }
      this.detachRide();
      this.clearPrompt();
      return;
    }

    // Move by the delta of the previous attach point.
    v.localToWorld(this.rideLocal.x, this.rideLocal.y, this.rideLocal.z, _target);
    if (this.rideValid) {
      _target.sub(_prevAttach);
      // Clamp: a teleporting vehicle (respawn, physics blow-up) must not drag
      // the player across the map.
      const step = _target.length();
      if (step < 6) {
        frame.position.add(_target);
        charCtrl.setPosition(frame.position.x, frame.position.y, frame.position.z);
      }
    }
    this.rideLocal.copy(_v);
    v.localToWorld(this.rideLocal.x, this.rideLocal.y, this.rideLocal.z, _prevAttach);
    this.rideValid = true;

    // Standing on a moving roof is not free: it shakes, and hard cornering
    // slides you toward the outside of the turn.
    const shake = clamp01(Math.abs(v.speed) / 34);
    if (shake > 0.05) cameraRig.addTrauma(shake * 0.9 * dt);
    if (v.car) {
      const lat = clamp(v.car.accelLat, -18, 18);
      _v2.set(1, 0, 0).applyQuaternion(v.quaternion).multiplyScalar(-lat * 0.014 * dt);
      frame.position.add(_v2);
    }

    this.prompt.active = true;
    this.prompt.vehicleId = v.id;
    this.prompt.kind = "ride";
    this.prompt.strength = 1;
    this.prompt.label = `RIDING — ${v.def.label}`;

    // Interact from the roof drops you in through the window.
    if (interactEdge && !v.wrecked) {
      this.detachRide();
      this.begin(v, "air");
    }
  }

  /** Debug/HUD: where the player would land if they stepped off right now. */
  dismountPoint(out: THREE.Vector3): THREE.Vector3 {
    const v = this.ride;
    if (!v) return out.copy(frame.position);
    v.localToWorld(v.def.width * 0.5 + 0.8, 0, 0, out);
    out.y = walkableHeight(out.x, out.z) + PLAYER.height * 0.5;
    return out;
  }
}

export const hijackSystem = new HijackSystem();
