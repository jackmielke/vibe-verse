/**
 * Where you are looking from.
 *
 * Five rigs, but only one of them is the game: **cockpit**. The others exist
 * for the replay, the card art and the moment after you stop on the runway,
 * and they are deliberately not as good — a chase camera makes any approach
 * look easy, because it shows you the runway from a viewpoint no pilot has.
 *
 * The cockpit rig is the only one with any real thought in it, and the thought
 * is this: **it is bolted to the aeroplane, not smoothed onto it.** No spring,
 * no lag, no damping. Every one of those is standard practice for a chase
 * camera and every one of them is wrong here, because the reason turbulence
 * feels like turbulence is that your head is rigidly attached to the airframe.
 * Smooth the cockpit camera and the storm turns into a gentle sway that you
 * watch rather than something happening to you.
 *
 * What *is* added is the head: a small positional offset driven by the load
 * factor and the buffet, because a real pilot's head does move relative to the
 * aeroplane — it is on a neck.
 */
import * as THREE from "three";
import { EYE_POINT } from "../flight/dynamics";
import { RUNWAY } from "../flight/nav";
import type {
  CameraMode,
  CameraService,
  PlaneCtx,
  System,
  Vec3Like,
} from "../types";
import type { AircraftService } from "../play/aircraft";

const MODES: CameraMode[] = ["cockpit", "chase", "wing", "cabin", "tower"];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _target = new THREE.Vector3();
const _up = new THREE.Vector3();
const _seatEuler = new THREE.Euler(0, 0, 0, "YXZ");

export function createCamera(ctx: PlaneCtx): System {
  const camera = ctx.camera;
  let mode: CameraMode = "cockpit";
  let posed: { position: THREE.Vector3; lookAt: THREE.Vector3 } | null = null;
  let shake = 0;
  let snap = true;

  // Free-look, in radians from straight ahead. You can look around a 707
  // flight deck, and you need to — the left window is how you see the runway
  // in a crosswind.
  let lookYaw = 0;
  let lookPitch = 0;

  /**
   * Where the pilot is looking when not looking anywhere in particular.
   *
   * Nine degrees down, and it is not a stylistic choice. Straight ahead puts
   * the panel out of frame entirely and fills the screen with windshield post;
   * far enough down to centre the panel loses the horizon. Nine degrees is
   * where the attitude indicator sits in the lower third and the runway
   * appears in the upper middle at exactly the point on a 3° approach where
   * you would first see it — which is the composition the whole last minute of
   * the game is read from.
   */
  const SEAT_PITCH = -0.16;

  const chasePos = new THREE.Vector3();
  const headOffset = new THREE.Vector3();

  const service: CameraService = {
    mode,
    setMode(next, opts) {
      mode = next;
      service.mode = next;
      snap = opts?.snap ?? false;
      lookYaw = 0;
      lookPitch = 0;
      posed = null;
      ctx.emit("cameraMode", { mode: next });
    },
    cycle() {
      const i = MODES.indexOf(mode);
      service.setMode(MODES[(i + 1) % MODES.length]);
      return service.mode;
    },
    shake(amount) {
      shake = Math.min(1, shake + amount);
    },
    pose(position: Vec3Like, lookAt: Vec3Like) {
      posed = {
        position: new THREE.Vector3(position.x, position.y, position.z),
        lookAt: new THREE.Vector3(lookAt.x, lookAt.y, lookAt.z),
      };
    },
    release() {
      posed = null;
    },
    get inCockpit() {
      return mode === "cockpit" && !posed;
    },
  };
  ctx.services.camera = service;

  return {
    lateUpdate(dt, c) {
      const air = c.services.flight as AircraftService | undefined;
      if (c.input.viewPressed) service.cycle();

      if (posed) {
        camera.position.copy(posed.position);
        camera.lookAt(posed.lookAt);
        return;
      }
      if (!air) return;

      const s = air.state;
      shake = Math.max(0, shake - dt * 2.2);
      const buffet = Math.max(shake, air.buffet * 0.8);

      // Free-look. Clamped to what a neck does, not to what a gimbal does.
      if (c.input.looking || c.input.lookX || c.input.lookY) {
        lookYaw = THREE.MathUtils.clamp(lookYaw - c.input.lookX, -2.2, 2.2);
        lookPitch = THREE.MathUtils.clamp(lookPitch - c.input.lookY, -0.9, 0.75);
      } else if (mode === "cockpit") {
        // Recentre slowly, so a glance out of the side window does not become
        // a permanent state you forget you are in.
        lookYaw *= Math.max(0, 1 - dt * 1.4);
        lookPitch *= Math.max(0, 1 - dt * 1.4);
      }

      switch (mode) {
        case "cockpit": {
          // Rigidly attached. See the file header.
          _v.copy(EYE_POINT);
          // The head, on its neck: pushed down under g, forward under braking.
          const gLoad = THREE.MathUtils.clamp(s.g - 1, -1.5, 2.5);
          headOffset.lerp(
            _v2.set(
              THREE.MathUtils.clamp(s.beta * 0.35, -0.06, 0.06),
              -gLoad * 0.035,
              THREE.MathUtils.clamp(-s.velocity.length() * 0.0002, -0.05, 0.05),
            ),
            Math.min(1, dt * 6),
          );
          _v.add(headOffset);
          if (buffet > 0.002) {
            const t = c.elapsed;
            _v.x += Math.sin(t * 53.1) * buffet * 0.012;
            _v.y += Math.sin(t * 71.7) * buffet * 0.016;
            _v.z += Math.sin(t * 61.3) * buffet * 0.008;
          }
          camera.position.copy(_v).applyQuaternion(s.orientation).add(s.position);
          camera.quaternion.copy(s.orientation);
          camera.quaternion.multiply(
            _q.setFromEuler(_seatEuler.set(SEAT_PITCH + lookPitch, lookYaw, 0, "YXZ")),
          );
          break;
        }

        case "cabin": {
          // Row 14, left side, looking out at a wing in a thunderstorm.
          _v.set(-1.7, 0.3, 6.0).applyQuaternion(s.orientation).add(s.position);
          camera.position.copy(_v);
          camera.quaternion.copy(s.orientation);
          camera.quaternion.multiply(
            _q.setFromEuler(_seatEuler.set(lookPitch - 0.1, lookYaw - 1.35, 0, "YXZ")),
          );
          break;
        }

        case "wing": {
          _v.set(24, 2.5, 6).applyQuaternion(s.orientation).add(s.position);
          camera.position.copy(_v);
          _target.copy(s.position);
          camera.up.copy(_up.set(0, 1, 0).applyQuaternion(s.orientation));
          camera.lookAt(_target);
          break;
        }

        case "chase": {
          _v.set(0, 11, 74).applyQuaternion(s.orientation).add(s.position);
          if (snap) {
            chasePos.copy(_v);
            snap = false;
          } else {
            // The one rig that *should* be smoothed: a chase camera that is
            // rigid reads as a boom welded to the tail.
            chasePos.lerp(_v, Math.min(1, dt * 2.6));
          }
          camera.position.copy(chasePos);
          camera.up.set(0, 1, 0);
          _target.copy(s.position).addScaledVector(s.velocity, 0.25);
          camera.lookAt(_target);
          if (buffet > 0.002) {
            camera.position.y += Math.sin(c.elapsed * 44) * buffet * 0.35;
          }
          break;
        }

        case "tower": {
          // The Chicago tower cab, watching 209 come down the approach. It is
          // where Rex Kramer is standing, which is the only reason it exists.
          camera.position.set(RUNWAY.length * 0.4, RUNWAY.threshold.y + 48, -1900);
          camera.up.set(0, 1, 0);
          camera.lookAt(_target.copy(s.position));
          break;
        }
      }
    },
    dispose() {
      delete ctx.services.camera;
    },
  };
}
