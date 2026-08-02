/**
 * The aeroplane as a live object in the world: flight model, Otto, and the
 * bridge between the player's hands and the control surfaces.
 *
 * The flight model itself knows nothing about any of this — it takes a
 * `ControlInput` and a dt. What lives here is everything about *who is
 * flying*, which in this game is a question with three possible answers at any
 * moment: the player, Otto, or nobody, and the last one is a real state that
 * the game puts you in on purpose.
 */
import * as THREE from "three";
import { FlightModel, EYE_POINT } from "../flight/dynamics";
import { Autopilot } from "../flight/autopilot";
import { ilsFix, type IlsFix } from "../flight/nav";
import { CRUISE_START } from "../flight/nav";
import { FLAP_DETENTS, type FlightService, type PlaneCtx, type System } from "../types";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export interface AircraftService extends FlightService {
  model: FlightModel;
  ap: Autopilot;
  ils: IlsFix;
  /** Where the pilot's eyes are, in world space. The cockpit camera sits here. */
  eye: THREE.Vector3;
  /**
   * True when the player's inputs reach the aeroplane. False during the intro,
   * while Otto has it, and after the wheels have stopped.
   */
  playerHasControls: boolean;
  /** How hard the airframe is being shaken right now, 0..1. Drives the camera. */
  buffet: number;
}

export function createAircraft(ctx: PlaneCtx): System {
  const model = new FlightModel();
  const ap = new Autopilot();
  const object = new THREE.Object3D();
  object.matrixAutoUpdate = false;
  ctx.scene.add(object);

  model.ground = {
    heightAt: (x, z) => ctx.services.ground?.heightAt(x, z) ?? 0,
  };
  model.place({
    position: CRUISE_START.clone(),
    heading: Math.PI / 2,
    ias: 138,
    flapIndex: 0,
    gearDown: false,
  });

  const ils = ilsFix(model.state.position);
  const eye = new THREE.Vector3();

  const service: AircraftService = {
    model,
    ap,
    ils,
    eye,
    state: model.state,
    autopilot: ap.state,
    object,
    playerHasControls: false,
    buffet: 0,
    place(opts) {
      model.place(opts);
      ap.disengage();
    },
    gust(pitch, roll, yaw) {
      model.gust(pitch, roll, yaw);
    },
    failEngine(i) {
      model.failEngine(i);
      ctx.emit("engineFailure", { engine: i });
    },
    stallSpeed: () => model.stallSpeed(),
    vref: () => model.vref(),
  };
  ctx.services.flight = service;

  // Edge-triggered inputs are consumed once per frame by the engine, so they
  // have to be latched here in `update` and applied in `fixedUpdate` — which
  // runs a different number of times per frame and would otherwise miss them
  // entirely on a fast machine and fire them twice on a slow one.
  let pendingGear = false;
  let pendingFlaps = 0;
  let pendingAp = false;
  const state = model.state;

  return {
    update(dt, c) {
      const input = c.input;
      if (input.gearToggle) pendingGear = true;
      if (input.flapsDown) pendingFlaps += 1;
      if (input.flapsUp) pendingFlaps -= 1;
      if (input.autopilotToggle) pendingAp = true;

      // Weather. Turbulence rises with the storm and again in the shear layer
      // just under the cloud base, which is where it always is.
      const sky = c.services.sky;
      if (sky) {
        const storm = sky.storm;
        // Roughest in the shear layer just under the cloud base, which is
        // where it always is — but not so rough that the last thousand feet
        // becomes a lottery. The approach has to be *demanding*, not random:
        // a gust that moves the aeroplane more than the pilot can is not
        // difficulty, it is noise.
        const nearBase = 1 - clamp(Math.abs(state.altitude - sky.cloudBase) / 700, 0, 1);
        // Turbulence dies away in the last two hundred feet, and not as a
        // kindness — the ground is a boundary condition. Air cannot have a
        // large vertical velocity a few metres above a surface, so the vertical
        // gust component collapses near the runway even when it is rough
        // higher up. Ignoring that let a three-metre-a-second downdraught
        // arrive in the last second of the flare and collapse the gear on an
        // approach the player had flown correctly, which is the least fair
        // thing a flight game can do.
        const nearGround = clamp(state.radarAltitude / 300, 0.18, 1);
        model.wind.turbulence = clamp(storm * (0.28 + 0.38 * nearBase) * nearGround, 0, 1);
        // A gusty quartering headwind on 09, which is what makes the last two
        // hundred feet an actual piece of flying rather than a cutscene.
        const gustFactor = 1 + 0.3 * Math.sin(c.elapsed * 0.31) + 0.2 * Math.sin(c.elapsed * 0.83);
        const strength = clamp(1 - state.altitude / 3000, 0.35, 1);
        // Fifteen knots down the runway and six across it, gusting. The
        // crosswind was twice this to begin with, which on top of the shear
        // layer's turbulence made the last two hundred feet a lottery rather
        // than a piece of flying — and a gust that moves the aeroplane further
        // than the pilot can is not difficulty.
        model.wind.steady.set(-7.5, 0, -3.0).multiplyScalar(strength * gustFactor * storm);
      }

      // Buffet: stick shaker at the stall, and the airframe complaining at the
      // barber pole. Both are felt through the camera, not shown on a meter.
      const shake =
        Math.max(0, 0.14 - state.stallMargin) / 0.14 +
        (state.overspeed ? 0.6 : 0) +
        model.wind.turbulence * 0.35;
      service.buffet = clamp(shake, 0, 1);
    },

    fixedUpdate(dt, c) {
      if (pendingGear) {
        pendingGear = false;
        state.gear.down = !state.gear.down;
        c.emit("gear", { down: state.gear.down });
      }
      if (pendingFlaps !== 0) {
        const next = clamp(state.flapIndex + Math.sign(pendingFlaps), 0, FLAP_DETENTS.length - 1);
        pendingFlaps = 0;
        if (next !== state.flapIndex) {
          state.flapIndex = next;
          c.emit("flaps", { index: next, degrees: FLAP_DETENTS[next] });
        }
      }
      if (pendingAp) {
        pendingAp = false;
        if (ap.state.engaged) {
          ap.disengage();
          c.emit("autopilot", { engaged: false });
        } else if (!ap.failed) {
          ap.engage(state);
          c.emit("autopilot", { engaged: true });
        } else {
          c.emit("ottoRefused");
        }
      }

      ilsFix(state.position, ils);

      // Who is flying? Otto first — if he takes it, the player's hands do
      // nothing, which is the correct and slightly unnerving feeling.
      const ottoFlying = ap.step(dt, state, ils, model.controls);
      if (!ottoFlying) {
        const input = c.input;
        if (service.playerHasControls) {
          model.controls.pitch = input.pitch;
          model.controls.roll = input.roll;
          model.controls.yaw = input.yaw;
          model.controls.throttle = input.throttle;
          model.controls.brake = input.wheelBrake;
          model.controls.speedbrake = input.speedbrake;
        } else {
          // Nobody at the controls. The aeroplane is trimmed and will fly
          // itself for a while, which is exactly what it did in the film.
          model.controls.pitch *= 0.9;
          model.controls.roll *= 0.9;
          model.controls.yaw *= 0.9;
        }
      }

      model.step(dt);
    },

    lateUpdate(_dt, c) {
      // One matrix compose per frame, not per fixed step.
      object.position.copy(state.position);
      object.quaternion.copy(state.orientation);
      object.updateMatrix();
      object.updateMatrixWorld(true);

      eye.copy(EYE_POINT).applyQuaternion(state.orientation).add(state.position);
      c.services.skyEnvHeight = state.altitude;
    },

    dispose() {
      ctx.scene.remove(object);
    },
  };
}
