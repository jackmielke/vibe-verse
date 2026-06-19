import { useEffect, useRef } from "react";

export type InputState = {
  forward: number; // -1..1
  strafe: number; // -1..1
  run: boolean;
  jump: boolean;
  interact: boolean;
  cameraYaw: number; // accumulated yaw from mouse drag
  cameraPitch: number;
  cameraDist: number; // third-person zoom distance
};

const MIN_DIST = 3;
const MAX_DIST = 120;

export function useInput() {
  const state = useRef<InputState>({
    forward: 0,
    strafe: 0,
    run: false,
    jump: false,
    interact: false,
    cameraYaw: 0,
    cameraPitch: 0.35,
    cameraDist: 6,
  });
  const keys = useRef<Record<string, boolean>>({});

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keys.current[e.code] = true;
      if (e.code === "Space") {
        state.current.jump = true;
        e.preventDefault();
      }
      if (e.code === "KeyE") state.current.interact = true;
    };
    const up = (e: KeyboardEvent) => {
      keys.current[e.code] = false;
    };
    const update = () => {
      const k = keys.current;
      let f = 0,
        s = 0;
      if (k["KeyW"] || k["ArrowUp"]) f += 1;
      if (k["KeyS"] || k["ArrowDown"]) f -= 1;
      if (k["KeyD"] || k["ArrowRight"]) s += 1;
      if (k["KeyA"] || k["ArrowLeft"]) s -= 1;
      state.current.forward = f;
      state.current.strafe = s;
      state.current.run = !!(k["ShiftLeft"] || k["ShiftRight"]);
    };
    const id = setInterval(update, 16);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);

    // Mouse drag for camera
    let dragging = false;
    let lastX = 0,
      lastY = 0;
    const md = (e: MouseEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const mm = (e: MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      state.current.cameraYaw -= dx * 0.005;
      state.current.cameraPitch = Math.max(
        0.05,
        Math.min(1.2, state.current.cameraPitch + dy * 0.005)
      );
    };
    const mu = () => {
      dragging = false;
    };
    window.addEventListener("mousedown", md);
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", mu);

    // Mouse wheel zoom + keyboard zoom (+/-)
    const wheel = (e: WheelEvent) => {
      const factor = Math.exp(e.deltaY * 0.0015);
      state.current.cameraDist = Math.max(
        MIN_DIST,
        Math.min(MAX_DIST, state.current.cameraDist * factor)
      );
      e.preventDefault();
    };
    window.addEventListener("wheel", wheel, { passive: false });

    const zoomKey = () => {
      const k = keys.current;
      if (k["Equal"] || k["NumpadAdd"]) {
        state.current.cameraDist = Math.max(MIN_DIST, state.current.cameraDist * 0.97);
      }
      if (k["Minus"] || k["NumpadSubtract"]) {
        state.current.cameraDist = Math.min(MAX_DIST, state.current.cameraDist * 1.03);
      }
    };
    const zoomKeyId = setInterval(zoomKey, 16);

    // Touch joystick & jump
    let touchId: number | null = null;
    let touchStart = { x: 0, y: 0 };
    let camTouchId: number | null = null;
    let camLast = { x: 0, y: 0 };
    let pinchStartDist: number | null = null;
    let pinchStartCamDist = 6;
    const ts = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX < window.innerWidth / 2 && touchId === null) {
          touchId = t.identifier;
          touchStart = { x: t.clientX, y: t.clientY };
        } else if (camTouchId === null) {
          camTouchId = t.identifier;
          camLast = { x: t.clientX, y: t.clientY };
        }
      }
      if (e.touches.length >= 2) {
        const a = e.touches[0];
        const b = e.touches[1];
        pinchStartDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        pinchStartCamDist = state.current.cameraDist;
      }
    };
    const tm = (e: TouchEvent) => {
      if (e.touches.length >= 2 && pinchStartDist != null) {
        const a = e.touches[0];
        const b = e.touches[1];
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const ratio = pinchStartDist / Math.max(1, d);
        state.current.cameraDist = Math.max(
          MIN_DIST,
          Math.min(MAX_DIST, pinchStartCamDist * ratio)
        );
        return;
      }
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === touchId) {
          const dx = t.clientX - touchStart.x;
          const dy = t.clientY - touchStart.y;
          state.current.strafe = Math.max(-1, Math.min(1, dx / 50));
          state.current.forward = Math.max(-1, Math.min(1, -dy / 50));
          state.current.run = Math.hypot(dx, dy) > 60;
        } else if (t.identifier === camTouchId) {
          const dx = t.clientX - camLast.x;
          const dy = t.clientY - camLast.y;
          camLast = { x: t.clientX, y: t.clientY };
          state.current.cameraYaw -= dx * 0.005;
          state.current.cameraPitch = Math.max(
            0.05,
            Math.min(1.2, state.current.cameraPitch + dy * 0.005)
          );
        }
      }
    };
    const te = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === touchId) {
          touchId = null;
          state.current.forward = 0;
          state.current.strafe = 0;
          state.current.run = false;
        } else if (t.identifier === camTouchId) {
          camTouchId = null;
        }
      }
      if (e.touches.length < 2) pinchStartDist = null;
    };
    window.addEventListener("touchstart", ts, { passive: true });
    window.addEventListener("touchmove", tm, { passive: true });
    window.addEventListener("touchend", te);

    return () => {
      clearInterval(id);
      clearInterval(zoomKeyId);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("mousedown", md);
      window.removeEventListener("mousemove", mm);
      window.removeEventListener("mouseup", mu);
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("touchstart", ts);
      window.removeEventListener("touchmove", tm);
      window.removeEventListener("touchend", te);
    };
  }, []);

  return state;
}
