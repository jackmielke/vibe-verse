/**
 * The Midnight Zone — camera.
 *
 * A chase camera that lags. The lag is not laziness — it is the only cue you
 * get for acceleration in a world with no ground, no horizon and no landmarks.
 * A camera rigidly bolted behind the sub makes 13 m/s and 30 m/s look
 * identical; one that falls behind and catches up makes them obvious.
 *
 * It also owns the title screen's slow orbit, because the alternative is a
 * static hero shot of a yellow submarine hanging in blue, and the first frame
 * of a world is worth more than that.
 */
import * as THREE from "three";
import type { DeepCtx, SubService, System } from "../types";

export type CameraMode = "chase" | "scenic";

export interface CameraService {
  mode: CameraMode;
  setMode(mode: CameraMode, opts?: { snap?: boolean }): void;
  /** Kicked by the scanner and by hull groans. */
  shake(amount: number): void;
}

/** Where the camera wants to sit relative to the hull, in the hull's frame. */
const CHASE_OFFSET = new THREE.Vector3(0, 1.5, -6.2);
const CHASE_LOOK = new THREE.Vector3(0, 0.4, 7);

export default function createCamera(ctx: DeepCtx): System {
  const cam = ctx.camera;
  let mode: CameraMode = "scenic";
  let shake = 0;
  let scenicT = 0;

  const desired = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const smoothLook = new THREE.Vector3(0, -6, 0);
  const tmp = new THREE.Vector3();

  const service: CameraService = {
    mode,
    setMode(next, opts) {
      mode = next;
      service.mode = next;
      if (opts?.snap) snap();
    },
    shake(amount) {
      shake = Math.min(1.4, shake + amount);
    },
  };
  ctx.services.camera = service;

  function snap(): void {
    const sub = ctx.services.sub as SubService | undefined;
    if (!sub) return;
    desired.copy(CHASE_OFFSET).applyQuaternion(sub.object.quaternion).add(sub.position);
    cam.position.copy(desired);
    lookAt.copy(CHASE_LOOK).applyQuaternion(sub.object.quaternion).add(sub.position);
    smoothLook.copy(lookAt);
    cam.lookAt(smoothLook);
  }

  return {
    lateUpdate(dt) {
      // Pump the HUD from inside the engine loop. React's own rAF callback
      // always runs *after* the engine has cleared its edge-triggered input,
      // so a HUD driven by rAF can never see a keypress — and the screenshot
      // harness stops rAF entirely and steps by hand. See `ui/DeepUI.tsx`.
      const ui = ctx.services.ui as { tick?(dt: number): void } | undefined;
      try {
        ui?.tick?.(dt);
      } catch (err) {
        console.error("[The Deep] the HUD threw while being pumped:", err);
      }

      const sub = ctx.services.sub as SubService | undefined;

      if (mode === "scenic" || !sub) {
        // A slow crawl around the hull, drifting down, so the title screen is
        // already the world rather than a picture of it.
        scenicT += dt * 0.16;
        const r = 9.5 + Math.sin(scenicT * 0.6) * 1.6;
        const centre = sub?.position ?? tmp.set(0, -6, 0);
        cam.position.set(
          centre.x + Math.cos(scenicT) * r,
          centre.y + 2.4 + Math.sin(scenicT * 0.8) * 1.5,
          centre.z + Math.sin(scenicT) * r,
        );
        smoothLook.lerp(centre, Math.min(1, dt * 2.5));
        cam.lookAt(smoothLook);
        return;
      }

      // Position: spring toward the offset. Slower vertically than laterally,
      // so a hard dive lets the sub drop out of frame for a moment — which is
      // the most legible "you are descending fast" the camera can give.
      desired.copy(CHASE_OFFSET).applyQuaternion(sub.object.quaternion).add(sub.position);
      const k = Math.min(1, dt * 4.6);
      cam.position.x += (desired.x - cam.position.x) * k;
      cam.position.z += (desired.z - cam.position.z) * k;
      cam.position.y += (desired.y - cam.position.y) * Math.min(1, dt * 3.2);

      lookAt.copy(CHASE_LOOK).applyQuaternion(sub.object.quaternion).add(sub.position);
      smoothLook.lerp(lookAt, Math.min(1, dt * 5.2));
      cam.lookAt(smoothLook);

      // FOV opens with speed. Small — 6 degrees — and it does more for the
      // sense of speed than doubling the actual velocity would.
      const want = 62 + THREE.MathUtils.clamp(Math.abs(sub.speed) / 30, 0, 1) * 6;
      if (Math.abs(cam.fov - want) > 0.01) {
        cam.fov += (want - cam.fov) * Math.min(1, dt * 2.2);
        cam.updateProjectionMatrix();
      }

      if (shake > 0.001) {
        cam.position.x += (ctx.rng() - 0.5) * shake * 0.32;
        cam.position.y += (ctx.rng() - 0.5) * shake * 0.32;
        cam.position.z += (ctx.rng() - 0.5) * shake * 0.32;
        shake *= Math.exp(-4.2 * dt);
      }
    },

    dispose() {
      if (ctx.services.camera === service) delete ctx.services.camera;
    },
  };
}
