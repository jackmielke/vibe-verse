/**
 * San Palmas — input.
 *
 * Pointer-lock mouse look + WASD on desktop, twin-stick touch on mobile.
 * Writes into the shared `ctx.input` snapshot that every system reads; it
 * never dispatches gameplay itself.
 */
import type { InputState, System, SystemFactory } from "../types";

/** Keys that map straight onto boolean input flags. */
const KEY_FLAGS: Record<string, keyof InputState> = {
  Space: "jump",
  ShiftLeft: "sprint",
  ShiftRight: "sprint",
  ControlLeft: "crouch",
  KeyC: "crouch",
  KeyR: "reload",
  KeyE: "interact",
  KeyQ: "grapple",
  KeyF: "wingsuit",
};

export interface InputSystem extends System {
  /** True while the pointer is locked (i.e. the player is actually playing). */
  readonly locked: boolean;
  requestLock(): void;
  setSensitivity(v: number): void;
}

const createInput: SystemFactory = (ctx) => {
  const input = ctx.input;
  const canvas = ctx.renderer.domElement;
  const down = new Set<string>();
  let locked = false;
  let sensitivity = 0.0022;
  // Touch look/move state, keyed by pointerId so two thumbs stay independent.
  const touches = new Map<number, { kind: "move" | "look"; startX: number; startY: number; x: number; y: number }>();

  const isTouch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    // Let the browser keep its own shortcuts (devtools, reload, tab switch).
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    down.add(e.code);
    input.pressed.add(e.code);
    const flag = KEY_FLAGS[e.code];
    if (flag) (input as unknown as Record<string, boolean>)[flag] = true;
    const slot = /^Digit([1-9])$/.exec(e.code);
    if (slot) input.weaponSlot = Number(slot[1]);
    if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
  };

  const onKeyUp = (e: KeyboardEvent) => {
    down.delete(e.code);
    const flag = KEY_FLAGS[e.code];
    if (flag) (input as unknown as Record<string, boolean>)[flag] = false;
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!locked) return;
    // Guard against the huge synthetic delta some browsers emit on the first
    // event after a lock — it would snap the view.
    const dx = Math.abs(e.movementX) > 300 ? 0 : e.movementX;
    const dy = Math.abs(e.movementY) > 300 ? 0 : e.movementY;
    input.lookX -= dx * sensitivity;
    input.lookY -= dy * sensitivity;
  };

  const onMouseDown = (e: MouseEvent) => {
    if (!locked) return;
    if (e.button === 0) input.fire = true;
    if (e.button === 2) input.aim = true;
  };

  const onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) input.fire = false;
    if (e.button === 2) input.aim = false;
  };

  const onWheel = (e: WheelEvent) => {
    if (!locked) return;
    ctx.emit("palmas:wheel", Math.sign(e.deltaY));
  };

  const onLockChange = () => {
    locked = document.pointerLockElement === canvas;
    ctx.emit("palmas:lock", locked);
    if (!locked) {
      // Drop every held key so the player doesn't run off on their own while
      // the pause menu is up.
      down.clear();
      input.fire = false;
      input.aim = false;
      input.jump = false;
      input.sprint = false;
      input.crouch = false;
    }
  };

  const onContext = (e: Event) => e.preventDefault();

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    const kind = e.clientX < window.innerWidth * 0.5 ? "move" : "look";
    touches.set(e.pointerId, { kind, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY });
    if (kind === "look") input.fire = true;
  };

  const onPointerMove = (e: PointerEvent) => {
    const t = touches.get(e.pointerId);
    if (!t) return;
    if (t.kind === "look") {
      input.lookX -= (e.clientX - t.x) * sensitivity * 1.6;
      input.lookY -= (e.clientY - t.y) * sensitivity * 1.6;
    }
    t.x = e.clientX;
    t.y = e.clientY;
  };

  const onPointerUp = (e: PointerEvent) => {
    const t = touches.get(e.pointerId);
    if (!t) return;
    if (t.kind === "look") input.fire = false;
    touches.delete(e.pointerId);
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("wheel", onWheel, { passive: true });
  document.addEventListener("pointerlockchange", onLockChange);
  canvas.addEventListener("contextmenu", onContext);
  if (isTouch) {
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
  }

  const sys: InputSystem = {
    name: "input",
    get locked() {
      return locked;
    },
    requestLock() {
      canvas.requestPointerLock?.();
    },
    setSensitivity(v: number) {
      sensitivity = v;
    },
    update() {
      // Keyboard axes. Touch move-stick overrides when active.
      let mx = 0;
      let mz = 0;
      if (down.has("KeyW") || down.has("ArrowUp")) mz += 1;
      if (down.has("KeyS") || down.has("ArrowDown")) mz -= 1;
      if (down.has("KeyD") || down.has("ArrowRight")) mx += 1;
      if (down.has("KeyA") || down.has("ArrowLeft")) mx -= 1;

      for (const t of touches.values()) {
        if (t.kind !== "move") continue;
        const dx = t.x - t.startX;
        const dy = t.y - t.startY;
        const dead = 8;
        const max = 70;
        if (Math.hypot(dx, dy) > dead) {
          mx = Math.max(-1, Math.min(1, dx / max));
          mz = Math.max(-1, Math.min(1, -dy / max));
        }
      }

      // Normalise so diagonals aren't faster than cardinals.
      const len = Math.hypot(mx, mz);
      if (len > 1) {
        mx /= len;
        mz /= len;
      }
      input.moveX = mx;
      input.moveZ = mz;
    },
    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("wheel", onWheel);
      document.removeEventListener("pointerlockchange", onLockChange);
      canvas.removeEventListener("contextmenu", onContext);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      if (document.pointerLockElement === canvas) document.exitPointerLock?.();
    },
  };

  return sys;
};

export default createInput;
