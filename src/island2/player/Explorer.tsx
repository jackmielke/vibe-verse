/**
 * Explorer — the free-flying camera for VIBE ISLAND II.
 *
 * The real player controller (walking, gliding, ziplines) is not built yet.
 * Until it is, the island still has to be something you can actually move
 * through on whatever device you are holding, so this is a free-flying
 * observer with a proper input layer: pointer-lock + WASD on desktop, and twin
 * touch sticks on a phone.
 *
 * It writes into `frame` exactly the way the real controller will — position,
 * yaw, pitch, velocity, movement state — so when the controller lands this can
 * be deleted without anything downstream noticing.
 *
 * Design notes for touch, which is where most of the care went:
 *  - The look stick is the *whole right half of the screen*, not a small pad.
 *    Small pads are a desktop designer's idea of a thumbstick.
 *  - The move stick is anchored wherever the thumb first lands on the left
 *    half, rather than at a fixed spot, because thumbs do not land where a
 *    layout grid expects them to.
 *  - Look sensitivity is independent of frame rate and of device pixel ratio.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { PLAYER } from "../config";
import { frame } from "../state/store";
import { WORLD, clampToWorld, surfaceHeight } from "../geo/islandGeo";
import { clamp, damp } from "@/shared/proc/rng";

/** Live input state. Mutated by listeners, read once per frame. */
interface InputState {
  /** -1..1 strafe / forward. */
  moveX: number;
  moveZ: number;
  /** -1..1 vertical (space / ctrl, or the touch rise-fall pad). */
  moveY: number;
  boost: boolean;
  /** Accumulated look delta in pixels, drained each frame. */
  lookX: number;
  lookY: number;
}

/** How fast the observer flies, m/s. The archipelago is compact — too fast
 *  and you overshoot every island before you can look at it. */
const BASE_SPEED = 17;
const BOOST_MULTIPLIER = 4.0;
const SLOW_MULTIPLIER = 0.22;

export interface ExplorerProps {
  /** Disabled while the screenshot harness owns the camera. */
  enabled?: boolean;
}

export default function Explorer({ enabled = true }: ExplorerProps) {
  const { camera, gl } = useThree();

  const input = useMemo<InputState>(
    () => ({ moveX: 0, moveZ: 0, moveY: 0, boost: false, lookX: 0, lookY: 0 }),
    [],
  );

  // Scratch vectors — allocating these per frame is exactly the mistake this
  // codebase bans elsewhere.
  const scratch = useMemo(
    () => ({
      forward: new THREE.Vector3(),
      right: new THREE.Vector3(),
      move: new THREE.Vector3(),
      euler: new THREE.Euler(0, 0, 0, "YXZ"),
    }),
    [],
  );

  const keys = useRef(new Set<string>()).current;
  /** Active touches: which pointer id is driving which stick. */
  const touch = useRef({
    moveId: -1,
    moveOx: 0,
    moveOy: 0,
    lookId: -1,
    lookX: 0,
    lookY: 0,
  }).current;

  const speedRef = useRef(BASE_SPEED);

  useEffect(() => {
    if (!enabled) return;
    const canvas = gl.domElement;

    /* ---------------- keyboard ---------------- */
    const onKeyDown = (e: KeyboardEvent) => {
      keys.add(e.code);
      // Don't let the page scroll out from under a game.
      if (
        ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)
      ) {
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp);

    /* ---------------- pointer lock (desktop) ---------------- */
    const onCanvasClick = () => {
      if (window.matchMedia("(pointer: coarse)").matches) return;
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
    };
    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return;
      input.lookX += e.movementX;
      input.lookY += e.movementY;
    };
    canvas.addEventListener("click", onCanvasClick);
    window.addEventListener("mousemove", onMouseMove);

    /* ---------------- touch ---------------- */
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      const half = canvas.clientWidth * 0.5;
      if (e.clientX < half && touch.moveId === -1) {
        // Anchor the move stick wherever the thumb actually landed.
        touch.moveId = e.pointerId;
        touch.moveOx = e.clientX;
        touch.moveOy = e.clientY;
      } else if (e.clientX >= half && touch.lookId === -1) {
        touch.lookId = e.pointerId;
        touch.lookX = e.clientX;
        touch.lookY = e.clientY;
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      if (e.pointerId === touch.moveId) {
        // 62 px of travel = full deflection. Comfortable for a thumb.
        const dx = (e.clientX - touch.moveOx) / 62;
        const dy = (e.clientY - touch.moveOy) / 62;
        input.moveX = clamp(dx, -1, 1);
        input.moveZ = clamp(dy, -1, 1);
      } else if (e.pointerId === touch.lookId) {
        input.lookX += e.clientX - touch.lookX;
        input.lookY += e.clientY - touch.lookY;
        touch.lookX = e.clientX;
        touch.lookY = e.clientY;
      }
    };
    const endPointer = (e: PointerEvent) => {
      if (e.pointerId === touch.moveId) {
        touch.moveId = -1;
        input.moveX = 0;
        input.moveZ = 0;
      }
      if (e.pointerId === touch.lookId) touch.lookId = -1;
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);

    // Stop the browser turning a drag into a scroll, a pinch-zoom, or a
    // text selection. Without this the world slides around under your thumb.
    const stop = (e: Event) => e.preventDefault();
    canvas.addEventListener("touchstart", stop, { passive: false });
    canvas.addEventListener("touchmove", stop, { passive: false });
    canvas.style.touchAction = "none";

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("click", onCanvasClick);
      window.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endPointer);
      canvas.removeEventListener("pointercancel", endPointer);
      canvas.removeEventListener("touchstart", stop);
      canvas.removeEventListener("touchmove", stop);
      if (document.pointerLockElement === canvas) document.exitPointerLock?.();
    };
  }, [enabled, gl, input, keys, touch]);

  useFrame((_, delta) => {
    if (!enabled) return;
    const dt = Math.min(delta, 1 / 15);

    /* ---- look ---- */
    // movementX is in CSS pixels; the sensitivity constant is per-pixel, so
    // this is naturally frame-rate independent.
    frame.yaw -= input.lookX * PLAYER.mouseSensitivity;
    frame.pitch -= input.lookY * PLAYER.mouseSensitivity;
    frame.pitch = clamp(frame.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
    input.lookX = 0;
    input.lookY = 0;

    /* ---- keyboard movement ---- */
    let kx = 0;
    let kz = 0;
    let ky = 0;
    if (keys.has("KeyW") || keys.has("ArrowUp")) kz -= 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) kz += 1;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) kx -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) kx += 1;
    if (keys.has("Space")) ky += 1;
    if (keys.has("ControlLeft") || keys.has("KeyC")) ky -= 1;
    const boost = keys.has("ShiftLeft") || keys.has("ShiftRight") || input.boost;
    const slow = keys.has("AltLeft");

    const mx = kx + input.moveX;
    const mz = kz + input.moveZ;
    const my = ky + input.moveY;

    /* ---- integrate ---- */
    const target =
      BASE_SPEED * (boost ? BOOST_MULTIPLIER : 1) * (slow ? SLOW_MULTIPLIER : 1);
    speedRef.current = damp(speedRef.current, target, 6, dt);

    const cy = Math.cos(frame.yaw);
    const sy = Math.sin(frame.yaw);
    const cp = Math.cos(frame.pitch);
    const sp = Math.sin(frame.pitch);
    scratch.forward.set(-sy * cp, sp, -cy * cp).normalize();
    scratch.right.set(cy, 0, -sy).normalize();

    scratch.move
      .set(0, 0, 0)
      .addScaledVector(scratch.forward, -mz)
      .addScaledVector(scratch.right, mx);
    scratch.move.y += my;
    if (scratch.move.lengthSq() > 1) scratch.move.normalize();

    frame.velocity.copy(scratch.move).multiplyScalar(speedRef.current);
    frame.position.addScaledVector(frame.velocity, dt);

    // Keep the observer inside the map and above the ground — falling through
    // the world with no collision system is a bad first impression.
    const clamped = clampToWorld(frame.position.x, frame.position.z);
    frame.position.x = clamped.x;
    frame.position.z = clamped.z;
    // Only clamp to ground where there IS ground. Over open sky the whole
    // point is that you can drop below the islands and look up at them.
    const ground = surfaceHeight(frame.position.x, frame.position.z);
    if (ground !== null && frame.position.y < ground + 1.7) {
      frame.position.y = ground + 1.7;
    }
    frame.position.y = clamp(frame.position.y, WORLD.killPlane + 40, WORLD.skyCeiling);

    frame.movement = "airborne";
    frame.grounded = false;

    camera.position.copy(frame.position);
    scratch.euler.set(frame.pitch, frame.yaw, 0);
    camera.quaternion.setFromEuler(scratch.euler);
  });

  return null;
}
