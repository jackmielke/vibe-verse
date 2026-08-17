/**
 * traversalInput — the one input layer every way of moving through San
 * Francisco reads from.
 *
 * This was `Explorer`'s, and it stayed `Explorer`'s right up until there was a
 * second controller. Two copies of a pointer-lock/twin-stick implementation is
 * how you end up with a game where the fly camera respects the safe area and
 * the walk camera does not, and nobody notices for a month — so it is extracted
 * here rather than pasted, and the controllers are left holding only the part
 * that is actually different: what they do with the numbers.
 *
 * Design notes for touch, which is where most of the care went and all of it
 * predates this file:
 *  - The look stick is the *whole right half of the screen*, not a small pad.
 *    Small pads are a desktop designer's idea of a thumbstick.
 *  - The move stick is anchored wherever the thumb first lands on the left
 *    half, rather than at a fixed spot, because thumbs do not land where a
 *    layout grid expects them to.
 *  - Look sensitivity is independent of frame rate and of device pixel ratio.
 *
 * The one addition: `jump`. A flying observer rises while a key is held, which
 * is a state; a walking character jumps on the edge, which is an event, and an
 * event read once per frame has to be latched or it is lost on any frame that
 * runs long. `consumeJump()` is that latch.
 */
import { useEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { clamp } from "../math/rng";

/** Live input state. Mutated by listeners, read once per frame. */
export interface TraversalInput {
  /** -1..1 strafe / forward. */
  moveX: number;
  moveZ: number;
  /** -1..1 vertical (space / ctrl, or the touch rise-fall pad). */
  moveY: number;
  boost: boolean;
  slow: boolean;
  /** Accumulated look delta in pixels, drained each frame. */
  lookX: number;
  lookY: number;
  /** True on the frame a jump was requested; cleared by `consumeJump`. */
  jumpLatched: boolean;
  /** Read-and-clear the jump edge. */
  consumeJump(): boolean;
  /** Keys currently down, for controllers that want their own bindings. */
  keys: Set<string>;
}

export interface TraversalInputOptions {
  /** Disabled while a menu or the screenshot harness owns the camera. */
  enabled?: boolean;
  /**
   * Touch: reserve the top of the screen for chrome rather than treating it as
   * the look pad. Without this every tap on the "Worlds" button also spins the
   * camera, which reads as the world lurching when you try to leave it.
   */
  deadZoneTop?: number;
}

/**
 * Install the listeners and return the shared, mutable input state.
 *
 * The returned object is stable for the lifetime of the component — read it in
 * `useFrame`, do not put it in React state.
 */
export function useTraversalInput(options: TraversalInputOptions = {}): TraversalInput {
  const { enabled = true, deadZoneTop = 72 } = options;
  const { gl } = useThree();

  const keys = useRef(new Set<string>()).current;
  const input = useMemo<TraversalInput>(
    () => ({
      moveX: 0,
      moveZ: 0,
      moveY: 0,
      boost: false,
      slow: false,
      lookX: 0,
      lookY: 0,
      jumpLatched: false,
      consumeJump() {
        const j = this.jumpLatched;
        this.jumpLatched = false;
        return j;
      },
      keys,
    }),
    [keys],
  );

  /** Active touches: which pointer id is driving which stick. */
  const touch = useRef({
    moveId: -1,
    moveOx: 0,
    moveOy: 0,
    lookId: -1,
    lookX: 0,
    lookY: 0,
  }).current;

  useEffect(() => {
    if (!enabled) {
      // Leaving a key latched across a mode switch means walking off on your
      // own the moment the menu closes.
      keys.clear();
      input.moveX = input.moveZ = input.moveY = 0;
      input.lookX = input.lookY = 0;
      input.boost = input.slow = false;
      input.jumpLatched = false;
      return;
    }
    const canvas = gl.domElement;

    /* ---------------- keyboard ---------------- */
    const onKeyDown = (e: KeyboardEvent) => {
      if (!keys.has(e.code) && e.code === "Space") input.jumpLatched = true;
      keys.add(e.code);
      // Don't let the page scroll out from under a game.
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
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
      if (e.clientY < deadZoneTop) return;
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
  }, [enabled, gl, input, keys, touch, deadZoneTop]);

  return input;
}

/** Resolve keyboard + stick into one -1..1 pair, plus the speed modifiers. */
export function readMove(input: TraversalInput): {
  x: number;
  z: number;
  y: number;
  boost: boolean;
  slow: boolean;
} {
  const k = input.keys;
  let kx = 0;
  let kz = 0;
  let ky = 0;
  if (k.has("KeyW") || k.has("ArrowUp")) kz -= 1;
  if (k.has("KeyS") || k.has("ArrowDown")) kz += 1;
  if (k.has("KeyA") || k.has("ArrowLeft")) kx -= 1;
  if (k.has("KeyD") || k.has("ArrowRight")) kx += 1;
  if (k.has("Space")) ky += 1;
  if (k.has("ControlLeft") || k.has("KeyC")) ky -= 1;
  return {
    x: kx + input.moveX,
    z: kz + input.moveZ,
    y: ky + input.moveY,
    boost: k.has("ShiftLeft") || k.has("ShiftRight") || input.boost,
    slow: k.has("AltLeft") || input.slow,
  };
}
