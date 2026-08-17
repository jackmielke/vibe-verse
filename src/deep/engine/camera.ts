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

/** How far back along the direction of travel the camera rides, metres. */
const CHASE_DISTANCE = 7.4;
/** …and how far above it, in world space, so the hull sits low in the frame. */
const CHASE_RISE = 1.9;
/** How far ahead of the sub the camera looks. Short: a long lead points the
 *  view away from the thing it is supposed to be framing. */
const CHASE_LEAD = 3.2;
/** Hard cap on how far the spring may stretch behind `desired`, metres. */
const MAX_TRAIL = 5.5;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

export default function createCamera(ctx: DeepCtx): System {
  const cam = ctx.camera;
  let mode: CameraMode = "scenic";
  let shake = 0;
  let scenicT = 0;

  const desired = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const travel = new THREE.Vector3();
  const nose = new THREE.Vector3();
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
    nose.set(0, 0, 1).applyQuaternion(sub.object.quaternion);
    desired
      .copy(sub.position)
      .addScaledVector(nose, -CHASE_DISTANCE)
      .addScaledVector(WORLD_UP, CHASE_RISE);
    cam.position.copy(desired);
    lookAt.copy(sub.position).addScaledVector(nose, CHASE_LEAD);
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

      /**
       * Trail the direction of *travel*, not the direction the nose points.
       *
       * This is the whole fix, and the original was subtly, badly wrong. The
       * camera sat behind the hull's forward axis and looked at a point seven
       * metres ahead of it — which is correct for something that moves the way
       * it is facing, and wrong for a submersible, because diving is straight
       * down while the nose stays level. Measured mid-dive, the sub projected
       * to y = -2.3 in normalised device coordinates: more than two full frame
       * heights below the bottom of the screen. You spent the entire descent
       * looking at empty water with your own vehicle somewhere off-camera, and
       * that is a very good imitation of a broken renderer.
       *
       * Trailing the velocity makes "behind" mean *above* when you dive and
       * *behind* when you cruise, with no special cases. The blend back toward
       * the nose keeps a slow drift framed like a chase camera rather than
       * swinging around every time the velocity wanders.
       */
      travel.copy(sub.velocity);
      nose.set(0, 0, 1).applyQuaternion(sub.object.quaternion);
      if (travel.lengthSq() < 1) travel.copy(nose);
      else travel.normalize().lerp(nose, 0.3).normalize();

      desired
        .copy(sub.position)
        .addScaledVector(travel, -CHASE_DISTANCE)
        .addScaledVector(WORLD_UP, CHASE_RISE);

      // One spring on all three axes now. The vertical lag that used to be a
      // deliberate speed cue is what put the sub off-screen once the descent
      // got fast enough to be worth doing.
      const k = Math.min(1, dt * 5.0);
      cam.position.lerp(desired, k);

      // A spring alone lets the trail grow with speed — steady-state lag is
      // roughly velocity over stiffness, so the 71 m/s descent would sit the
      // camera twenty-odd metres back and shrink a three-metre submersible to
      // a speck. Some stretch is a good speed cue; unbounded stretch is the
      // framing bug again in slow motion.
      const trail = cam.position.distanceTo(desired);
      if (trail > MAX_TRAIL) cam.position.lerpVectors(desired, cam.position, MAX_TRAIL / trail);

      lookAt.copy(sub.position).addScaledVector(travel, CHASE_LEAD);
      smoothLook.lerp(lookAt, Math.min(1, dt * 5.6));
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
