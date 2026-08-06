/**
 * DROP ZERO — input.
 *
 * Pointer-lock mouse look + WASD on desktop, twin-stick touch on mobile.
 * Writes into the shared `ctx.input` snapshot every system reads; it never
 * dispatches gameplay itself.
 *
 * Binds are the browser-safe translation of Fortnite's defaults. F1–F4 are
 * the real game's build keys and are unusable here (F1 opens browser help),
 * so building sits on the left-hand cluster instead:
 *
 *   Z wall · X floor · C ramp · V cone · B toggle build · G edit · Q rotate
 *   1–5 inventory · E interact · R reload · Space jump · Shift sprint
 *
 * Left ctrl is crouch and is deliberately NOT bound to KeyC — that would
 * fight the ramp key, and misfiring a ramp when you meant to crouch is the
 * kind of thing that loses a fight.
 */
import type { BuildKind, InputState, System, SystemFactory } from "../types";

/** Keys that map straight onto boolean input flags. */
const KEY_FLAGS: Record<string, keyof InputState> = {
  Space: "jump",
  ShiftLeft: "sprint",
  ShiftRight: "sprint",
  ControlLeft: "crouch",
  KeyR: "reload",
  KeyE: "interact",
};

/** Build-piece hotkeys. */
const BUILD_KEYS: Record<string, BuildKind> = {
  KeyZ: "wall",
  KeyX: "floor",
  KeyC: "ramp",
  KeyV: "cone",
};

export interface InputSystem extends System {
  /** True while the pointer is locked (i.e. the player is actually playing). */
  readonly locked: boolean;
  requestLock(): void;
  setSensitivity(v: number): void;
  /** Sensitivity multiplier applied while aiming down sights. */
  setAimScale(v: number): void;
}

const createInput: SystemFactory = (ctx) => {
  const input = ctx.input;
  const canvas = ctx.renderer.domElement;
  const down = new Set<string>();
  let locked = false;
  let sensitivity = 0.0022;
  let aimScale = 0.55;
  /** Touch state keyed by pointerId so two thumbs stay independent. */
  const touches = new Map<
    number,
    { kind: "move" | "look"; startX: number; startY: number; x: number; y: number; moved: boolean }
  >();

  const isTouch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    // Let the browser keep its own shortcuts (devtools, reload, tab switch).
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    down.add(e.code);
    input.pressed.add(e.code);

    const flag = KEY_FLAGS[e.code];
    if (flag) (input as unknown as Record<string, boolean>)[flag] = true;

    const build = BUILD_KEYS[e.code];
    if (build) input.buildKind = build;
    if (e.code === "KeyQ") input.rotate = true;
    if (e.code === "KeyG") input.drop = true;

    const slot = /^Digit([1-6])$/.exec(e.code);
    if (slot) {
      input.slot = Number(slot[1]);
      // Picking a weapon leaves build mode, the same way it does in the real
      // game — otherwise you fire a wall into someone's face.
      input.buildKind = null;
    }

    if (e.code === "Space" || e.code.startsWith("Arrow") || e.code === "Tab") e.preventDefault();
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
    const s = sensitivity * (input.aim ? aimScale : 1);
    input.lookX -= dx * s;
    input.lookY -= dy * s;
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
    input.wheel += Math.sign(e.deltaY);
  };

  const onLockChange = () => {
    locked = document.pointerLockElement === canvas;
    input.locked = locked;
    ctx.emit("dz:lock", locked);
    if (!locked) {
      // Drop every held key so the player doesn't run off on their own while
      // the pause menu is up.
      down.clear();
      input.fire = false;
      input.aim = false;
      input.jump = false;
      input.sprint = false;
      input.crouch = false;
      input.reload = false;
      input.interact = false;
      input.moveX = 0;
      input.moveZ = 0;
    }
  };

  // A backgrounded tab stops sending keyup, so a held W survives the switch
  // and the player is still sprinting when they come back.
  const onBlur = () => {
    down.clear();
    input.fire = false;
    input.aim = false;
    input.jump = false;
    input.sprint = false;
    input.crouch = false;
    input.moveX = 0;
    input.moveZ = 0;
  };

  const onContext = (e: Event) => e.preventDefault();

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    const kind = e.clientX < window.innerWidth * 0.5 ? "move" : "look";
    touches.set(e.pointerId, {
      kind,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      moved: false,
    });
  };

  const onPointerMove = (e: PointerEvent) => {
    const t = touches.get(e.pointerId);
    if (!t) return;
    if (t.kind === "look") {
      input.lookX -= (e.clientX - t.x) * sensitivity * 1.6;
      input.lookY -= (e.clientY - t.y) * sensitivity * 1.6;
    }
    if (Math.hypot(e.clientX - t.startX, e.clientY - t.startY) > 12) t.moved = true;
    t.x = e.clientX;
    t.y = e.clientY;
  };

  const onPointerUp = (e: PointerEvent) => {
    const t = touches.get(e.pointerId);
    if (!t) return;
    // A tap on the right half is a shot; a drag is a look. Holding fire for
    // the whole drag (what San Palmas does) makes aiming on a phone useless.
    if (t.kind === "look" && !t.moved) {
      input.fire = true;
      setTimeout(() => {
        input.fire = false;
      }, 120);
    }
    touches.delete(e.pointerId);
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("blur", onBlur);
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
    setAimScale(v: number) {
      aimScale = v;
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
      window.removeEventListener("blur", onBlur);
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
