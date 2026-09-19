/**
 * The player: one rig, three ways to drive it.
 *
 * The camera sits inside a `rig` group. On a desktop the rig yaws with the
 * mouse and the camera pitches; on a phone the left half of the screen is a
 * stick and the right half looks; in VR the headset owns the camera and the
 * thumbsticks move the rig. Everything downstream (Vibey following, spawn
 * "here", the fireballs' aim) reads `position` and `yaw` and never cares
 * which of the three is in charge.
 */
import * as THREE from "three";
import type { Gravity } from "../state";

export interface Player {
  rig: THREE.Group;
  camera: THREE.PerspectiveCamera;
  /** Feet position. */
  position: THREE.Vector3;
  /** Heading in radians, 0 looks down -z. */
  yaw(): number;
  update(dt: number, groundAt: (x: number, z: number) => number, opts: { gravity: Gravity; speed: number; eye: number; xr: XRSession | null; xrCamera: THREE.Camera | null }): void;
  teleport(x: number, z: number, yaw?: number): void;
  /** Whether the pointer is locked / a touch is active — input is bound. */
  active(): boolean;
  dispose(): void;
}

export function createPlayer(container: HTMLElement, camera: THREE.PerspectiveCamera): Player {
  const rig = new THREE.Group();
  const head = new THREE.Group();
  head.position.y = 1.62;
  head.add(camera);
  rig.add(head);

  let yaw = Math.PI * 0.15;
  let pitch = -0.05;
  const vel = new THREE.Vector3();
  let grounded = true;
  let vy = 0;
  const keys = new Set<string>();
  let locked = false;

  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    if (e.target && (e.target as HTMLElement).tagName === "INPUT") return;
    if (down) keys.add(e.code); else keys.delete(e.code);
    if (down && e.code === "Space" && grounded) e.preventDefault();
  };
  const keyDown = onKey(true);
  const keyUp = onKey(false);
  window.addEventListener("keydown", keyDown);
  window.addEventListener("keyup", keyUp);

  const onMouseMove = (e: MouseEvent) => {
    if (!locked) return;
    yaw -= e.movementX * 0.0022;
    pitch = Math.max(-1.3, Math.min(1.3, pitch - e.movementY * 0.0022));
  };
  const onLockChange = () => { locked = document.pointerLockElement === container; };
  const onClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, input, a, [data-ui]")) return;
    if (!locked && "requestPointerLock" in container) container.requestPointerLock?.();
  };
  container.addEventListener("click", onClick);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("pointerlockchange", onLockChange);

  // Touch: left half moves, right half looks.
  const touches = new Map<number, { x0: number; y0: number; x: number; y: number; side: "l" | "r" }>();
  const onTouchStart = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if ((t.target as HTMLElement).closest("button, input, a, [data-ui]")) continue;
      const side = t.clientX < window.innerWidth / 2 ? "l" : "r";
      touches.set(t.identifier, { x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, side });
    }
  };
  const onTouchMove = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      const s = touches.get(t.identifier);
      if (!s) continue;
      if (s.side === "r") {
        yaw -= (t.clientX - s.x) * 0.005;
        pitch = Math.max(-1.3, Math.min(1.3, pitch - (t.clientY - s.y) * 0.005));
      }
      s.x = t.clientX; s.y = t.clientY;
    }
    if (touches.size) e.preventDefault();
  };
  const onTouchEnd = (e: TouchEvent) => { for (const t of Array.from(e.changedTouches)) touches.delete(t.identifier); };
  container.addEventListener("touchstart", onTouchStart, { passive: true });
  container.addEventListener("touchmove", onTouchMove, { passive: false });
  container.addEventListener("touchend", onTouchEnd);
  container.addEventListener("touchcancel", onTouchEnd);

  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const xrYawQ = new THREE.Quaternion();
  const xrEuler = new THREE.Euler();
  let snapCooldown = 0;
  let xrJumpLatch = false;

  return {
    rig,
    camera,
    position: rig.position,
    yaw() { return yaw; },
    active() { return locked || touches.size > 0; },
    update(dt, groundAt, opts) {
      let mx = 0, mz = 0, jump = false;
      if (opts.xr && opts.xrCamera) {
        // VR: thumbsticks. Left moves relative to the head's yaw, right snap-turns.
        snapCooldown = Math.max(0, snapCooldown - dt);
        for (const src of opts.xr.inputSources) {
          const gp = src.gamepad;
          if (!gp) continue;
          const ax = gp.axes.length >= 4 ? [gp.axes[2], gp.axes[3]] : [gp.axes[0] ?? 0, gp.axes[1] ?? 0];
          if (src.handedness === "left") { mx += ax[0]; mz += ax[1]; if (gp.buttons[0]?.pressed || gp.buttons[3]?.pressed) jump = true; }
          else if (src.handedness === "right") {
            if (Math.abs(ax[0]) > 0.7 && snapCooldown === 0) { yaw -= Math.sign(ax[0]) * (Math.PI / 6); snapCooldown = 0.3; }
            if (Math.abs(ax[0]) < 0.3) snapCooldown = 0;
            if (gp.buttons[0]?.pressed || gp.buttons[4]?.pressed) jump = true;
          }
        }
        if (jump && xrJumpLatch) jump = false; else xrJumpLatch = jump;
        // Head yaw in rig space.
        xrEuler.setFromQuaternion(opts.xrCamera.quaternion, "YXZ");
        const headYaw = xrEuler.y;
        fwd.set(-Math.sin(yaw + headYaw), 0, -Math.cos(yaw + headYaw));
        right.set(fwd.z, 0, -fwd.x);
        vel.set(0, 0, 0).addScaledVector(fwd, -mz).addScaledVector(right, mx);
        if (vel.lengthSq() > 1) vel.normalize();
        if (vel.lengthSq() < 0.02) vel.set(0, 0, 0);
        rig.rotation.y = yaw;
        xrYawQ.setFromEuler(new THREE.Euler(0, yaw, 0));
      } else {
        if (keys.has("KeyW") || keys.has("ArrowUp")) mz -= 1;
        if (keys.has("KeyS") || keys.has("ArrowDown")) mz += 1;
        if (keys.has("KeyA") || keys.has("ArrowLeft")) mx -= 1;
        if (keys.has("KeyD") || keys.has("ArrowRight")) mx += 1;
        if (keys.has("Space")) jump = true;
        for (const t of touches.values()) {
          if (t.side !== "l") continue;
          mx += Math.max(-1, Math.min(1, (t.x - t.x0) / 60));
          mz += Math.max(-1, Math.min(1, (t.y - t.y0) / 60));
        }
        fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
        right.set(fwd.z, 0, -fwd.x);
        vel.set(0, 0, 0).addScaledVector(fwd, -mz).addScaledVector(right, mx);
        if (vel.lengthSq() > 1) vel.normalize();
        rig.rotation.y = yaw;
        head.rotation.x = pitch;
      }
      const run = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 1.8 : 1;
      const speed = 4.2 * opts.speed * run;
      rig.position.x += vel.x * speed * dt;
      rig.position.z += vel.z * speed * dt;
      const limit = 230;
      rig.position.x = Math.max(-limit, Math.min(limit, rig.position.x));
      rig.position.z = Math.max(-limit, Math.min(limit, rig.position.z));
      const g = opts.gravity === "moon" ? 3.2 : opts.gravity === "heavy" ? 24 : 16;
      const jumpV = opts.gravity === "moon" ? 6.5 : opts.gravity === "heavy" ? 5.5 : 6.2;
      const ground = groundAt(rig.position.x, rig.position.z);
      if (jump && grounded) { vy = jumpV; grounded = false; }
      vy -= g * dt;
      rig.position.y += vy * dt;
      if (rig.position.y <= ground) { rig.position.y = ground; vy = 0; grounded = true; }
      else if (rig.position.y - ground < 0.05 && vy <= 0) { rig.position.y = ground; grounded = true; }
      else grounded = false;
      if (!opts.xr) {
        // Walking bob, at whatever eye height the world's scale says.
        head.position.y = 1.62 * opts.eye + (vel.lengthSq() > 0.01 && grounded ? Math.sin(performance.now() * 0.011 * run) * 0.035 : 0);
        rig.scale.setScalar(1);
      } else { head.position.y = 0; rig.scale.setScalar(opts.eye); }
    },
    teleport(x, z, y) {
      rig.position.x = x;
      rig.position.z = z;
      vy = 0;
      if (typeof y === "number") yaw = y;
    },
    dispose() {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("pointerlockchange", onLockChange);
      container.removeEventListener("click", onClick);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
      if (document.pointerLockElement === container) document.exitPointerLock();
    },
  };
}
