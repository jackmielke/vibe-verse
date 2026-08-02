/**
 * What the space camera is doing.
 *
 * In `viewscreen` mode — the default, and the one that matters — this camera
 * *is* the viewscreen. It sits a couple of hundred metres off the bow so your
 * own saucer is never in shot, and it points forward.
 *
 * Except that it cheats, exactly the way the show cheats. A real forward view
 * would lose the enemy the moment it crossed the beam, and the audience would
 * spend the battle looking at empty stars. So the aim is blended toward the
 * locked target whenever the target is within about seventy degrees of the
 * bow, and snaps back to dead ahead when it is not. Nobody notices, everybody
 * would notice its absence, and it is why "on screen" works as an order.
 *
 * Magnification is a real focal length change: 52° wide, 13° at 4×, 4.3° at
 * 12×. At twelve the enemy fills the frame and you cannot see anything else —
 * which is the correct trade and the reason the order exists.
 */
import * as THREE from "three";
import { clamp, damp, type CameraMode, type CameraService, type System, type TrekCtx } from "../types";

const BASE_FOV = 52;

export function createCamera(ctx: TrekCtx): System {
  const cam = ctx.viewCam;
  const desiredPos = new THREE.Vector3();
  const desiredLook = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const FORWARD = new THREE.Vector3(0, 0, -1);
  const UP = new THREE.Vector3(0, 1, 0);

  let shake = 0;
  let posed: { from: THREE.Vector3; to: THREE.Vector3 } | null = null;
  let orbitAngle = 0;
  let snap = true;

  const service: CameraService = {
    mode: "viewscreen",
    magnification: 1,
    setMode(m) {
      if (service.mode !== m) snap = true;
      service.mode = m;
      posed = null;
    },
    cycle() {
      const order: CameraMode[] = ["viewscreen", "chase", "orbit", "tactical"];
      const i = order.indexOf(service.mode);
      service.setMode(order[(i + 1) % order.length]);
      return service.mode;
    },
    cycleMagnification() {
      const steps = [1, 4, 12];
      const i = steps.indexOf(service.magnification);
      service.magnification = steps[(i + 1) % steps.length];
      return service.magnification;
    },
    shake(amount) {
      shake = Math.min(1.6, shake + amount);
    },
    pose(from, to) {
      posed = { from: from.clone(), to: to.clone() };
      service.mode = "free";
    },
    release() {
      posed = null;
      service.setMode("viewscreen");
    },
  };
  ctx.services.camera = service;

  return {
    lateUpdate(dt, c) {
      const fleet = c.services.fleet;
      const player = fleet?.player;
      if (!player) return;

      if (posed) {
        cam.position.copy(posed.from);
        cam.lookAt(posed.to);
        cam.fov = BASE_FOV;
        cam.updateProjectionMatrix();
        return;
      }

      const target =
        c.services.game?.targetId != null ? fleet?.byId(c.services.game.targetId) : undefined;
      const forward = tmp.copy(FORWARD).applyQuaternion(player.quaternion);

      switch (service.mode) {
        case "viewscreen": {
          // Out past the bow, and a little high, so the frame reads as "the
          // view from the ship" rather than "the view from a point in space".
          desiredPos.copy(player.position).addScaledVector(forward, 260).addScaledVector(UP, 24);
          desiredLook.copy(desiredPos).addScaledVector(forward, 4000);

          if (target?.alive && target.cloakLevel < 0.9) {
            tmp2.copy(target.position).sub(player.position).normalize();
            const off = tmp2.dot(forward);
            // Full weight straight ahead, nothing past ~70° off the bow, and a
            // smooth ramp between — the pan happens on its own.
            const weight = clamp((off - 0.34) / 0.5, 0, 1);
            if (weight > 0) {
              desiredLook.lerp(target.position, weight * 0.92);
            }
          }
          break;
        }

        case "chase": {
          desiredPos
            .copy(player.position)
            .addScaledVector(forward, -520)
            .addScaledVector(UP, 150);
          desiredLook.copy(player.position).addScaledVector(forward, 400);
          break;
        }

        case "orbit": {
          orbitAngle += dt * 0.12;
          const r = 780;
          desiredPos.set(
            player.position.x + Math.cos(orbitAngle) * r,
            player.position.y + 190,
            player.position.z + Math.sin(orbitAngle) * r,
          );
          desiredLook.copy(player.position);
          break;
        }

        case "tactical": {
          // High and wide, framing the whole engagement. Useful, and the
          // reason it is not the default: it is a strategy game from up here,
          // and this is not a strategy game.
          const centre = tmp2.copy(player.position);
          let n = 1;
          if (fleet) {
            for (const s of fleet.ships) {
              if (!s.alive || s === player || s.cloakLevel > 0.5) continue;
              centre.add(s.position);
              n++;
            }
          }
          centre.divideScalar(n);
          let spread = 2600;
          if (fleet) {
            for (const s of fleet.ships) {
              if (!s.alive || s.cloakLevel > 0.5) continue;
              spread = Math.max(spread, s.position.distanceTo(centre) * 2.4);
            }
          }
          desiredPos.set(centre.x, centre.y + spread * 0.7, centre.z + spread);
          desiredLook.copy(centre);
          break;
        }

        default:
          return;
      }

      if (snap) {
        cam.position.copy(desiredPos);
        snap = false;
      } else {
        const lambda = service.mode === "viewscreen" ? 14 : 3.2;
        cam.position.x = damp(cam.position.x, desiredPos.x, lambda, dt);
        cam.position.y = damp(cam.position.y, desiredPos.y, lambda, dt);
        cam.position.z = damp(cam.position.z, desiredPos.z, lambda, dt);
      }

      // Aim through a smoothed look-at point rather than by lerping the
      // quaternion, so a target crossing behind the ship makes the view sweep
      // round instead of taking the short way through the floor.
      const look = cam.userData.look as THREE.Vector3 | undefined;
      if (!look) cam.userData.look = desiredLook.clone();
      else {
        const lambda = service.mode === "viewscreen" ? 5.5 : 4;
        look.x = damp(look.x, desiredLook.x, lambda, dt);
        look.y = damp(look.y, desiredLook.y, lambda, dt);
        look.z = damp(look.z, desiredLook.z, lambda, dt);
      }
      cam.lookAt(cam.userData.look as THREE.Vector3);

      // Shake, applied after the aim so it does not fight the smoothing.
      shake = Math.max(0, shake - dt * 1.6);
      if (shake > 0.001) {
        const s = shake * shake * 0.02;
        cam.rotation.x += (Math.random() - 0.5) * s;
        cam.rotation.y += (Math.random() - 0.5) * s;
        cam.rotation.z += (Math.random() - 0.5) * s * 0.6;
      }

      const wantFov = BASE_FOV / service.magnification;
      if (Math.abs(cam.fov - wantFov) > 0.01) {
        cam.fov = damp(cam.fov, wantFov, 9, dt);
        cam.updateProjectionMatrix();
      }

      // In an external mode this camera draws the whole canvas, so it has to
      // take the window's aspect; on the viewscreen it keeps the set's 2.35.
      const wantAspect = service.mode === "viewscreen" ? 2.35 : c.viewport.aspect;
      if (Math.abs(cam.aspect - wantAspect) > 0.001) {
        cam.aspect = wantAspect;
        cam.updateProjectionMatrix();
      }
    },
  };
}
