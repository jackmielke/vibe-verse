/**
 * Vibe Golf — input.
 *
 * One pointer model for mouse and touch: press, drag, release. The aim system
 * reads `dragStart` → `pointer` as a slingshot vector, so the same gesture
 * works identically with a finger and a mouse. Two-finger pinch drives zoom;
 * keyboard exists as a desktop convenience, never as a requirement.
 *
 * Writes into `ctx.input` only — it never dispatches gameplay itself.
 */
import type { GolfCtx, System, SystemFactory } from "../types";
import type { GolfEngine } from "./core";

export interface GolfInputSystem extends System {
  attachEngine(engine: GolfEngine): void;
}

const createGolfInput: SystemFactory = (ctx: GolfCtx) => {
  const input = ctx.input;
  const canvas = ctx.renderer.domElement;
  let engine: GolfEngine | null = null;

  /** Live touches, so we can tell a drag from a pinch. */
  const touches = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  /** The pointer that owns the current drag. */
  let dragId: number | null = null;

  const toWorld = (cx: number, cy: number) => {
    if (!engine) return { x: 0, y: 0 };
    const v = engine.screenToWorld(cx, cy);
    return { x: v.x, y: v.y };
  };

  const onPointerDown = (e: PointerEvent) => {
    canvas.setPointerCapture?.(e.pointerId);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (touches.size === 2) {
      // Second finger down promotes the gesture to a pinch and cancels the
      // drag, so a two-finger zoom never fires a shot.
      const [a, b] = [...touches.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      input.dragging = false;
      input.dragStart = null;
      dragId = null;
      return;
    }

    if (touches.size === 1) {
      dragId = e.pointerId;
      const w = toWorld(e.clientX, e.clientY);
      input.dragStart = w;
      input.pointer = w;
      input.dragging = true;
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    const t = touches.get(e.pointerId);
    if (t) {
      t.x = e.clientX;
      t.y = e.clientY;
    }

    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) input.zoomDelta += (d - pinchDist) * 0.004;
      pinchDist = d;
      return;
    }

    const w = toWorld(e.clientX, e.clientY);
    input.pointer = w;
  };

  const endPointer = (e: PointerEvent) => {
    canvas.releasePointerCapture?.(e.pointerId);
    const wasDrag = dragId === e.pointerId && input.dragging;
    touches.delete(e.pointerId);
    if (touches.size < 2) pinchDist = 0;

    if (wasDrag) {
      input.pointer = toWorld(e.clientX, e.clientY);
      input.released = true;
      input.dragging = false;
      dragId = null;
    }
    if (touches.size === 0) {
      input.dragging = false;
      dragId = null;
    }
  };

  const onWheel = (e: WheelEvent) => {
    input.zoomDelta -= Math.sign(e.deltaY) * 0.12;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!e.repeat) input.pressed.add(e.code);
    input.held.add(e.code);
    if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
  };

  const onKeyUp = (e: KeyboardEvent) => input.held.delete(e.code);

  const onContext = (e: Event) => e.preventDefault();
  // Stop iOS Safari from rubber-banding or double-tap-zooming the game away.
  const onTouchMove = (e: TouchEvent) => e.preventDefault();

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", onWheel, { passive: true });
  canvas.addEventListener("contextmenu", onContext);
  canvas.addEventListener("touchmove", onTouchMove, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  const sys: GolfInputSystem = {
    name: "input",
    attachEngine(e) {
      engine = e;
    },
    dispose() {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endPointer);
      canvas.removeEventListener("pointercancel", endPointer);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContext);
      canvas.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    },
  };

  return sys;
};

export default createGolfInput;
