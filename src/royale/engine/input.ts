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
 *
 * ## Touch
 *
 * On a coarse-pointer device the canvas itself is a twin stick — left half
 * moves, right half looks, a tap on the right fires — and everything the
 * keyboard has that a thumb cannot reach (build pieces, edit, rotate,
 * inventory slots, jump, sprint, interact) comes from the on-screen layer in
 * `ui/TouchControls.tsx`. That layer is loaded lazily and only when
 * `(pointer: coarse)` matches, so desktop never downloads it, never mounts it
 * and never pays a listener for it.
 *
 * The two talk through `TouchDriver` below rather than by importing each
 * other's internals: the UI asks for a virtual press and this file writes the
 * same `ctx.input` fields the keyboard writes, so no gameplay system has to
 * know a finger was involved.
 */
import type { BuildKind, InputState, System, SystemFactory } from "../types";

/** Boolean input flags a virtual button is allowed to hold down. */
export type TouchFlag = "fire" | "jump" | "sprint" | "crouch" | "aim" | "reload" | "interact";

/** Where the move thumbstick is right now, in viewport pixels. */
export interface StickState {
  active: boolean;
  /** Where the thumb first landed — the stick's base is drawn here. */
  baseX: number;
  baseY: number;
  /** Where the thumb is now. */
  x: number;
  y: number;
  /** Pixel distance that reads as full deflection. */
  radius: number;
}

/**
 * The surface `ui/TouchControls.tsx` drives. Every method writes exactly what
 * the equivalent key writes, so `buildKind`, `pressed`, `fire`, `jump`,
 * `slot`, `rotate` and `interact` mean the same thing to every system whether
 * they came from a keyboard or a thumb.
 */
export interface TouchDriver {
  /** Hold or release a flag. Buttons that repeat (fire) use this, not a tap. */
  setFlag(flag: TouchFlag, on: boolean): void;
  /**
   * Edge-triggered key press — lands in `input.pressed`, which the engine
   * clears at the end of the frame, exactly like a real `keydown`.
   */
  press(code: string): void;
  /** Select a build piece, or `null` to leave build mode. */
  setBuildKind(kind: BuildKind | null): void;
  /** 1..6. Mirrors the digit keys, including their exit from build mode. */
  selectSlot(slot: number): void;
  /** Q — rotate the build preview. Consumed once per frame. */
  rotate(): void;
  /** Subscribe to the move stick. Returns an unsubscribe. */
  onStick(fn: (s: StickState) => void): () => void;
  /** Subscribe to touch-session engage/release. Returns an unsubscribe. */
  onEngage(fn: (on: boolean) => void): () => void;
  /** True while the touch session owns the controls. */
  readonly engaged: boolean;
  engage(): void;
  release(): void;
}

/** Pixel deflection that counts as a full stick push. */
const STICK_MAX = 70;
/** Dead zone before the stick reads at all, in pixels. */
const STICK_DEAD = 8;

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
  /** Virtual input for the on-screen touch layer. Present on every device. */
  readonly touch: TouchDriver;
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

  const isTouch =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;

  /** True once the player has entered the match with a finger. See `engage`. */
  let touchEngaged = false;
  const stickListeners = new Set<(s: StickState) => void>();
  const engageListeners = new Set<(on: boolean) => void>();

  /**
   * Drop every held control. Called whenever the lock is lost, so the player
   * does not run off on their own while the pause menu is up.
   */
  const clearHeld = () => {
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
  };

  /**
   * Single writer for the lock flag, because there are now two ways to hold
   * the controls: the pointer lock on desktop and a touch session on a phone.
   */
  const setLocked = (next: boolean) => {
    if (next === locked) return;
    locked = next;
    input.locked = next;
    ctx.emit("dz:lock", next);
    if (!next) clearHeld();
  };

  /**
   * Ungate touch play.
   *
   * `player.controllable` is false unless `input.locked` is true, and a phone
   * has no Pointer Lock API to give — so on a coarse-pointer device the lock
   * flag would never flip and the player would stand there watching a HUD
   * they cannot move. `locked` does not actually mean "the pointer is
   * captured"; it means *the player has the controls*, which is why every
   * system reads it as a gate rather than reading `document.pointerLockElement`
   * itself. A live touch session satisfies that meaning exactly, so it sets
   * the same flag and emits the same `dz:lock` event, and nothing downstream
   * needs a second concept.
   */
  const engageTouch = () => {
    if (!isTouch || touchEngaged) return;
    touchEngaged = true;
    setLocked(true);
    for (const fn of [...engageListeners]) fn(true);
  };

  const releaseTouch = () => {
    if (!touchEngaged) return;
    touchEngaged = false;
    touches.clear();
    setLocked(false);
    for (const fn of [...engageListeners]) fn(false);
  };

  /**
   * The page enters the match by calling `canvas.requestPointerLock()` — that
   * one call is what "the player pressed DROP IN" means everywhere in this
   * codebase. On a phone it is either missing or a no-op, so on coarse-pointer
   * devices the method is replaced with the touch equivalent. Swapping it here
   * rather than asking every page to learn about touch keeps the entry point
   * singular; the original is restored in `dispose()`.
   */
  if (isTouch) {
    (canvas as unknown as Record<string, unknown>).requestPointerLock = () => {
      engageTouch();
    };
  }

  /** Publish the move stick so the on-screen thumbstick can draw itself. */
  const emitStick = () => {
    if (stickListeners.size === 0) return;
    let state: StickState = { active: false, baseX: 0, baseY: 0, x: 0, y: 0, radius: STICK_MAX };
    for (const t of touches.values()) {
      if (t.kind !== "move") continue;
      state = {
        active: true,
        baseX: t.startX,
        baseY: t.startY,
        x: t.x,
        y: t.y,
        radius: STICK_MAX,
      };
      break;
    }
    for (const fn of [...stickListeners]) fn(state);
  };

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
    // A touch session holds the controls in its own right, so losing the
    // (never-granted) pointer lock must not take them away.
    setLocked(document.pointerLockElement === canvas || touchEngaged);
  };

  // A backgrounded tab stops sending keyup, so a held W survives the switch
  // and the player is still sprinting when they come back.
  const onBlur = () => {
    clearHeld();
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
    if (kind === "move") emitStick();
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
    if (t.kind === "move") emitStick();
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
    if (t.kind === "move") emitStick();
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

  /**
   * The virtual keyboard the on-screen layer types on. Every method here has
   * exactly one job: write the field a key would have written. No gameplay
   * logic lives on this side of the line.
   */
  const touchDriver: TouchDriver = {
    setFlag(flag, on) {
      (input as unknown as Record<string, boolean>)[flag] = on;
    },
    press(code) {
      input.pressed.add(code);
    },
    setBuildKind(kind) {
      input.buildKind = kind;
    },
    selectSlot(slot) {
      input.slot = slot;
      // Same rule as the digit keys: picking a weapon leaves build mode.
      input.buildKind = null;
    },
    rotate() {
      input.rotate = true;
    },
    onStick(fn) {
      stickListeners.add(fn);
      return () => {
        stickListeners.delete(fn);
      };
    },
    onEngage(fn) {
      engageListeners.add(fn);
      return () => {
        engageListeners.delete(fn);
      };
    },
    get engaged() {
      return touchEngaged;
    },
    engage: engageTouch,
    release: releaseTouch,
  };

  /**
   * The control layer is a React island mounted from here rather than from the
   * page, so a world that boots this engine gets thumb controls without having
   * to know they exist. The import is dynamic and guarded: on a mouse the
   * chunk is never fetched.
   */
  let unmountTouchUi: (() => void) | null = null;
  let disposed = false;
  if (isTouch) {
    void import("../ui/TouchControls")
      .then((mod) => {
        if (disposed) return;
        unmountTouchUi = mod.mountTouchControls(ctx, touchDriver);
      })
      .catch((err) => {
        // A missing control layer must not take the match down with it — the
        // canvas twin-stick still works.
        console.error("[Drop Zero] touch controls failed to load", err);
      });
  }

  const sys: InputSystem = {
    name: "input",
    touch: touchDriver,
    get locked() {
      return locked;
    },
    requestLock() {
      // On a phone this is the touch swap installed above; on desktop it is
      // the real thing.
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
        if (Math.hypot(dx, dy) > STICK_DEAD) {
          mx = Math.max(-1, Math.min(1, dx / STICK_MAX));
          mz = Math.max(-1, Math.min(1, -dy / STICK_MAX));
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
      disposed = true;
      unmountTouchUi?.();
      unmountTouchUi = null;
      stickListeners.clear();
      engageListeners.clear();
      // Hand the canvas its own method back; the override is an own property
      // shadowing the prototype, so deleting it restores the native one.
      if (isTouch) Reflect.deleteProperty(canvas, "requestPointerLock");
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
