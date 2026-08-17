/**
 * input.ts — one input layer for keyboard, mouse and thumbs.
 *
 * Vibe Francisco is a world you fly around, which puts more on the input layer
 * than a walking game does: there is a throttle as well as a stick, and on a
 * phone both thumbs are already busy. The layout that falls out:
 *
 *   left half   move stick, anchored where the thumb lands
 *   right half  look, anywhere, plus a thumb-reachable JET pad
 *   tap JET     hold to fly, release to fall
 *
 * The move stick is anchored wherever the thumb first touches rather than at a
 * fixed spot on the screen, because thumbs do not land where a layout grid
 * expects them to. The look area is the whole right half rather than a small
 * pad, because a small pad is a desktop designer's idea of a thumbstick.
 *
 * A dead zone across the top keeps the chrome tappable: without it every tap
 * on "Worlds" also spins the camera, which reads as the world lurching when
 * you try to leave it.
 */

export interface FriscoInput {
  /** -1..1, camera-relative. */
  moveX: number;
  moveZ: number;
  /** Accumulated look delta in CSS pixels; drained by the controller. */
  lookX: number;
  lookY: number;
  /** Jetpack throttle: held. */
  jet: boolean;
  /** Sprint / boost. */
  boost: boolean;
  /** Read-and-clear jump. */
  consumeJump(): boolean;
  /** Read-and-clear a "swap camera side" request. */
  consumeCamSwap(): boolean;
  keys: Set<string>;
  /**
   * Stop reading the player entirely — what attract mode needs.
   *
   * Zeroing the axes is not enough on its own: the listeners stay attached and
   * a stray keypress during a three-second recording puts a jetpack burn in
   * the middle of the card art. This gates the whole thing at the source.
   */
  setEnabled(on: boolean): void;
  dispose(): void;
  /** For the HUD: where the touch move-stick is, so it can be drawn. */
  stick: { active: boolean; ox: number; oy: number; x: number; y: number };
}

export interface InputOptions {
  /** Pixels from the top of the canvas that belong to the chrome, not the game. */
  deadZoneTop?: number;
  /** Called when the pointer lock state changes, so the HUD can react. */
  onLockChange?: (locked: boolean) => void;
}

export function createInput(canvas: HTMLCanvasElement, o: InputOptions = {}): FriscoInput {
  const deadZoneTop = o.deadZoneTop ?? 78;
  const keys = new Set<string>();
  let jumpLatched = false;
  let camSwapLatched = false;
  let enabled = true;

  const state: FriscoInput = {
    moveX: 0, moveZ: 0, lookX: 0, lookY: 0,
    jet: false, boost: false,
    keys,
    consumeJump() {
      const j = jumpLatched;
      jumpLatched = false;
      return j;
    },
    consumeCamSwap() {
      const c = camSwapLatched;
      camSwapLatched = false;
      return c;
    },
    stick: { active: false, ox: 0, oy: 0, x: 0, y: 0 },
    setEnabled(on: boolean) {
      enabled = on;
      if (!on) {
        keys.clear();
        state.moveX = state.moveZ = 0;
        state.lookX = state.lookY = 0;
        state.jet = false;
        state.boost = false;
        state.stick.active = false;
        jumpLatched = false;
      }
    },
    dispose() {
      /* replaced below */
    },
  };

  /* ---------------- keyboard ---------------- */
  const onKeyDown = (e: KeyboardEvent) => {
    if (!enabled || e.repeat) return;
    if (e.code === "Space") jumpLatched = true;
    if (e.code === "KeyV") camSwapLatched = true;
    keys.add(e.code);
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
      e.preventDefault();
    }
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  window.addEventListener("keydown", onKeyDown, { passive: false });
  window.addEventListener("keyup", onKeyUp);
  // A tab-out with a key held leaves you walking into a wall forever.
  const onBlur = () => {
    keys.clear();
    state.moveX = state.moveZ = 0;
    state.jet = false;
  };
  window.addEventListener("blur", onBlur);

  /* ---------------- pointer lock ---------------- */
  const onClick = () => {
    if (!enabled) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
  };
  const onMouseMove = (e: MouseEvent) => {
    if (!enabled) return;
    if (document.pointerLockElement !== canvas) return;
    state.lookX += e.movementX;
    state.lookY += e.movementY;
  };
  const onLockChange = () => o.onLockChange?.(document.pointerLockElement === canvas);
  canvas.addEventListener("click", onClick);
  window.addEventListener("mousemove", onMouseMove);
  document.addEventListener("pointerlockchange", onLockChange);

  /* ---------------- touch ---------------- */
  const touch = { moveId: -1, lookId: -1, jetId: -1, lookX: 0, lookY: 0 };

  /** The JET pad: bottom-right corner, sized for a thumb at rest. */
  const inJetPad = (x: number, y: number) =>
    x > canvas.clientWidth - 150 && y > canvas.clientHeight - 150;

  const onPointerDown = (e: PointerEvent) => {
    if (!enabled || e.pointerType !== "touch") return;
    if (e.clientY < deadZoneTop) return;
    if (inJetPad(e.clientX, e.clientY) && touch.jetId === -1) {
      touch.jetId = e.pointerId;
      state.jet = true;
      return;
    }
    const half = canvas.clientWidth * 0.5;
    if (e.clientX < half && touch.moveId === -1) {
      touch.moveId = e.pointerId;
      state.stick.active = true;
      state.stick.ox = e.clientX;
      state.stick.oy = e.clientY;
      state.stick.x = e.clientX;
      state.stick.y = e.clientY;
    } else if (e.clientX >= half && touch.lookId === -1) {
      touch.lookId = e.pointerId;
      touch.lookX = e.clientX;
      touch.lookY = e.clientY;
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!enabled || e.pointerType !== "touch") return;
    if (e.pointerId === touch.moveId) {
      const dx = (e.clientX - state.stick.ox) / 64;
      const dy = (e.clientY - state.stick.oy) / 64;
      state.moveX = Math.max(-1, Math.min(1, dx));
      state.moveZ = Math.max(-1, Math.min(1, dy));
      state.stick.x = e.clientX;
      state.stick.y = e.clientY;
      // Push the stick hard and you run.
      state.boost = Math.hypot(dx, dy) > 0.92;
    } else if (e.pointerId === touch.lookId) {
      state.lookX += e.clientX - touch.lookX;
      state.lookY += e.clientY - touch.lookY;
      touch.lookX = e.clientX;
      touch.lookY = e.clientY;
    }
  };
  const endPointer = (e: PointerEvent) => {
    if (e.pointerId === touch.moveId) {
      touch.moveId = -1;
      state.moveX = state.moveZ = 0;
      state.boost = false;
      state.stick.active = false;
    }
    if (e.pointerId === touch.lookId) touch.lookId = -1;
    if (e.pointerId === touch.jetId) {
      touch.jetId = -1;
      state.jet = false;
    }
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  const stop = (e: Event) => e.preventDefault();
  canvas.addEventListener("touchstart", stop, { passive: false });
  canvas.addEventListener("touchmove", stop, { passive: false });
  canvas.style.touchAction = "none";

  state.dispose = () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    canvas.removeEventListener("click", onClick);
    window.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("pointerlockchange", onLockChange);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", endPointer);
    canvas.removeEventListener("pointercancel", endPointer);
    canvas.removeEventListener("touchstart", stop);
    canvas.removeEventListener("touchmove", stop);
    if (document.pointerLockElement === canvas) document.exitPointerLock?.();
  };

  return state;
}

/** Resolve keyboard and stick into one intent. */
export function readIntent(i: FriscoInput): {
  x: number;
  z: number;
  boost: boolean;
  jet: boolean;
} {
  const k = i.keys;
  let x = i.moveX;
  let z = i.moveZ;
  if (k.has("KeyW") || k.has("ArrowUp")) z -= 1;
  if (k.has("KeyS") || k.has("ArrowDown")) z += 1;
  if (k.has("KeyA") || k.has("ArrowLeft")) x -= 1;
  if (k.has("KeyD") || k.has("ArrowRight")) x += 1;
  const mag = Math.hypot(x, z);
  if (mag > 1) {
    x /= mag;
    z /= mag;
  }
  return {
    x,
    z,
    boost: i.boost || k.has("ShiftLeft") || k.has("ShiftRight"),
    // Space is jump from the ground and throttle in the air; the controller
    // decides which, so both are reported.
    jet: i.jet || k.has("Space"),
  };
}
