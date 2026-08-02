/**
 * Yoke, thrust levers, and the things you press when a passenger is screaming.
 *
 * Three devices produce one `PlaneInput`, and by the time the flight model
 * sees it there is no way to tell which. That is the whole design, and it is
 * borrowed wholesale from the Blue Angels world next door.
 *
 * The one thing that is different — and it is the interesting difference — is
 * that this aeroplane has **no fly-by-wire**. A Hornet's stick commands a G
 * and degrades gracefully to a fingertip; a 707's yoke moves a cable, and if
 * you let go the aeroplane does whatever it was trimmed to do. So a keyboard
 * cannot simply ramp to ±1 and sit there, because holding a key would be
 * holding forty pounds of back pressure for ever.
 *
 * Instead the keyboard ramps *and self-centres* at a rate that makes a tap
 * behave like a nudge and a hold behave like a hold — and the **trim** is a
 * real control, on the same keys a 707 has it on, because trimming is how you
 * fly a big aeroplane hands-off. Learning that you have to trim is most of
 * learning to fly this thing, and it is a lesson the game teaches by making
 * the yoke spring back rather than by explaining anything.
 */
import type { PlaneCtx, System } from "../types";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** How fast a held key drives a control, and how fast it returns. */
const RAMP = { pitch: 1.9, roll: 2.6, yaw: 2.8 };
const RETURN = { pitch: 3.2, roll: 4.4, yaw: 5.0 };
/** The thrust levers move at a lever's pace, not a switch's. */
const THROTTLE_RATE = 0.42;
const TRIM_RATE = 0.16;

export interface InputService {
  /** Stabiliser trim, −1..+1. Read by the aircraft system. */
  trim: number;
  /** True while a touch control is being dragged, so the UI can hide prompts. */
  touching: boolean;
  /** Set by the touch overlay in the React layer. */
  setAxis(axis: "pitch" | "roll" | "yaw" | "throttle", value: number): void;
  press(action: string): void;
  /** Release every axis a finger was holding — used when the overlay unmounts. */
  releaseAll(): void;
}

export function createInput(ctx: PlaneCtx): System {
  const input = ctx.input;
  const keys = new Set<string>();
  const touchAxes: Partial<Record<string, number>> = {};
  let trim = 0;

  const service: InputService = {
    trim: 0,
    touching: false,
    setAxis(axis, value) {
      touchAxes[axis] = clamp(value, -1, 1);
      input.source = "touch";
      input.touch = true;
      service.touching = true;
    },
    press(action) {
      input.source = "touch";
      input.touch = true;
      applyAction(action);
    },
    releaseAll() {
      for (const k of Object.keys(touchAxes)) delete touchAxes[k];
      service.touching = false;
    },
  };
  ctx.services.input = service;

  function applyAction(action: string): void {
    switch (action) {
      case "gear":
        input.gearToggle = true;
        break;
      case "flapsDown":
        input.flapsDown = true;
        break;
      case "flapsUp":
        input.flapsUp = true;
        break;
      case "autopilot":
        input.autopilotToggle = true;
        break;
      case "view":
        input.viewPressed = true;
        break;
      case "pause":
        input.pausePressed = true;
        break;
      case "action":
        input.actionPressed = true;
        break;
      default:
        if (action.startsWith("choice")) input.choicePressed = Number(action.slice(6));
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    // Never swallow the browser's own shortcuts, and never trap a player who
    // wants to leave the page.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const code = e.code;
    keys.add(code);
    input.source = "keyboard";

    switch (code) {
      case "KeyG":
        input.gearToggle = true;
        break;
      case "KeyF":
        input.flapsDown = true;
        break;
      case "KeyR":
        input.flapsUp = true;
        break;
      case "KeyO":
      case "KeyZ":
        input.autopilotToggle = true;
        break;
      case "KeyC":
        input.viewPressed = true;
        break;
      case "Escape":
      case "KeyP":
        input.pausePressed = true;
        break;
      case "Space":
        input.actionPressed = true;
        break;
      case "Digit1":
      case "Digit2":
      case "Digit3":
      case "Digit4":
        input.choicePressed = Number(code.slice(5));
        break;
    }
    if (SWALLOW.has(code)) e.preventDefault();
  };

  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onBlur = () => keys.clear();

  // Mouse look: hold the right button (or any button with the pointer locked)
  // and look around the flight deck.
  let looking = false;
  const canvas = ctx.renderer.domElement;
  const onPointerDown = (e: PointerEvent) => {
    if (e.button === 2 || e.button === 1) {
      looking = true;
      canvas.setPointerCapture(e.pointerId);
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    if (looking) {
      looking = false;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* already gone */
      }
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!looking) return;
    input.lookX += e.movementX * 0.0026;
    input.lookY += e.movementY * 0.0026;
    input.looking = true;
    input.source = "keyboard";
  };
  const onContextMenu = (e: Event) => e.preventDefault();

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("contextmenu", onContextMenu);

  const held = (...codes: string[]) => codes.some((c) => keys.has(c));

  return {
    update(dt) {
      // --- yoke -------------------------------------------------------------
      const axis = (
        neg: boolean,
        pos: boolean,
        current: number,
        ramp: number,
        back: number,
        touch: number | undefined,
      ) => {
        if (touch !== undefined) return touch;
        const want = (pos ? 1 : 0) - (neg ? 1 : 0);
        if (want === 0) {
          // Self-centring. A yoke you have let go of returns; a fly-by-wire
          // side stick does too, and this aeroplane has neither, but a
          // keyboard that latches at full deflection is unflyable.
          const step = back * dt;
          return Math.abs(current) <= step ? 0 : current - Math.sign(current) * step;
        }
        return clamp(current + want * ramp * dt, -1, 1);
      };

      input.pitch = axis(
        held("KeyS", "ArrowDown"),
        held("KeyW", "ArrowUp"),
        input.pitch,
        RAMP.pitch,
        RETURN.pitch,
        touchAxes.pitch,
      );
      input.roll = axis(
        held("KeyA", "ArrowLeft"),
        held("KeyD", "ArrowRight"),
        input.roll,
        RAMP.roll,
        RETURN.roll,
        touchAxes.roll,
      );
      input.yaw = axis(
        held("KeyQ", "Comma"),
        held("KeyE", "Period"),
        input.yaw,
        RAMP.yaw,
        RETURN.yaw,
        touchAxes.yaw,
      );

      // --- thrust levers ----------------------------------------------------
      if (touchAxes.throttle !== undefined) {
        input.throttle = clamp(touchAxes.throttle, 0, 1);
      } else {
        if (held("ShiftLeft", "ShiftRight", "Equal", "BracketRight")) {
          input.throttle = clamp(input.throttle + THROTTLE_RATE * dt, 0, 1);
        }
        if (held("ControlLeft", "ControlRight", "Minus", "BracketLeft")) {
          input.throttle = clamp(input.throttle - THROTTLE_RATE * dt, 0, 1);
        }
        // The detents everyone actually uses.
        if (keys.has("Backquote")) input.throttle = 0;
        if (keys.has("Backslash")) input.throttle = 1;
      }

      // --- trim, on the keys a 707 has it on --------------------------------
      if (held("BracketLeft", "PageDown")) trim = clamp(trim - TRIM_RATE * dt, -1, 1);
      if (held("BracketRight", "PageUp")) trim = clamp(trim + TRIM_RATE * dt, -1, 1);
      if (keys.has("Home")) trim = 0;
      service.trim = trim;

      // --- brakes and boards -------------------------------------------------
      input.wheelBrake = held("KeyB", "Slash") ? 1 : 0;
      input.speedbrake = held("KeyX") ? 1 : 0;

      // Gamepad, if one showed up. Left stick is the yoke, triggers the levers.
      readGamepad(input);

      input.looking = looking || service.touching;
    },
    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("contextmenu", onContextMenu);
      delete ctx.services.input;
    },
  };
}

/** Keys the page must not scroll on. */
const SWALLOW = new Set([
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "Slash",
  "Backquote",
]);

const DEADZONE = 0.14;
function expo(v: number): number {
  const a = Math.abs(v);
  if (a < DEADZONE) return 0;
  const n = (a - DEADZONE) / (1 - DEADZONE);
  // A gentle expo. A yoke is not a switch and neither is a thumbstick.
  return Math.sign(v) * (n * n * 0.65 + n * 0.35);
}

let lastButtons: boolean[] = [];

function readGamepad(input: import("../types").PlaneInput): void {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return;
  const pads = navigator.getGamepads();
  for (const pad of pads) {
    if (!pad?.connected) continue;
    const ax = pad.axes;
    const pitch = expo(-(ax[1] ?? 0));
    const roll = expo(ax[0] ?? 0);
    const yaw = expo(ax[2] ?? 0);
    if (pitch || roll || yaw) {
      input.pitch = pitch;
      input.roll = roll;
      input.yaw = yaw;
      input.source = "gamepad";
    }
    // Right trigger up, left trigger down — the thrust levers, held.
    const up = pad.buttons[7]?.value ?? 0;
    const down = pad.buttons[6]?.value ?? 0;
    if (up > 0.05 || down > 0.05) {
      input.throttle = clamp(input.throttle + (up - down) * 0.02, 0, 1);
      input.source = "gamepad";
    }
    const pressed = pad.buttons.map((b) => b.pressed);
    const fell = (i: number) => pressed[i] && !lastButtons[i];
    if (fell(0)) input.actionPressed = true;
    if (fell(1)) input.gearToggle = true;
    if (fell(2)) input.flapsDown = true;
    if (fell(3)) input.flapsUp = true;
    if (fell(9)) input.pausePressed = true;
    if (fell(8)) input.viewPressed = true;
    lastButtons = pressed;
    return;
  }
}
