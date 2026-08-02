/**
 * Input — keyboard, mouse, and a thumb-sized version for phones.
 *
 * Two things are worth reading twice.
 *
 * **There is no pointer lock.** Every other world in the vibeverse grabs the
 * pointer, because every other world aims something. This one does not: you
 * are sitting in a chair looking around a room, and the orders you give are
 * discrete. Free-look follows the mouse across the window instead, which means
 * the mouse can also press the on-screen buttons — and being able to *click a
 * console* is worth more here than a locked crosshair would be.
 *
 * **Held versus edge.** Phasers are held; everything else is an order, given
 * once. The engine clears the edge-triggered fields at the end of each frame,
 * so a system that reads `input.fireTorpedo` twice in one frame gets it twice
 * and in two frames gets it once — which is the behaviour you want when a
 * torpedo costs one of the forty you have.
 */
import { clamp, type System, type TrekCtx } from "../types";

const KEY_HELP = "The captain's controls are documented in ui/BridgeUI.tsx.";

export function createInput(ctx: TrekCtx): System {
  const input = ctx.input;
  const down = new Set<string>();

  // Look is absolute — the pointer's position in the window maps to a head
  // rotation, with a dead zone in the middle so the view is steady when you
  // are reading the captions rather than sightseeing.
  let pointerX = 0.5;
  let pointerY = 0.5;
  let pointerActive = false;

  const isTyping = () => {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping()) return;
    const k = e.key.toLowerCase();
    if (down.has(k)) {
      // Auto-repeat must not machine-gun the torpedo tubes.
      if (k !== "shift") e.preventDefault();
      return;
    }
    down.add(k);

    switch (k) {
      case " ":
        input.firePhasers = true;
        break;
      case "t":
        input.fireTorpedo = true;
        break;
      case "r":
        input.nextTarget = true;
        break;
      case "y":
        input.toggleAlert = true;
        break;
      case "f":
        input.evasive = true;
        break;
      case "tab":
        input.cycleCamera = true;
        break;
      case "z":
        input.cycleMagnification = true;
        break;
      case "h":
        input.hail = true;
        break;
      case "x":
        input.allStop = true;
        break;
      case "g":
        input.warp = true;
        break;
      case "1":
        input.powerTo = 0;
        break;
      case "2":
        input.powerTo = 1;
        break;
      case "3":
        input.powerTo = 2;
        break;
      case "enter":
      case "escape":
        input.advance = true;
        break;
      default:
        break;
    }
    if (k === " " || k === "tab" || k.startsWith("arrow")) e.preventDefault();
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    down.delete(k);
    if (k === " ") input.firePhasers = false;
  };

  const onBlur = () => {
    down.clear();
    input.firePhasers = false;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    pointerX = e.clientX / Math.max(1, window.innerWidth);
    pointerY = e.clientY / Math.max(1, window.innerHeight);
    pointerActive = true;
  };

  const canvas = ctx.renderer.domElement;
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "touch") input.touch = true;
    if (e.button === 0 && e.target === canvas) input.firePhasers = true;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (e.button === 0) input.firePhasers = false;
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointerup", onPointerUp);

  /** The touch HUD writes here; `update` folds it in with the keyboard. */
  const touch = { yaw: 0, pitch: 0, throttle: -1 };
  (ctx.services as Record<string, unknown>).touchAxes = touch;

  const axis = (neg: string[], pos: string[]) => {
    let v = 0;
    for (const k of neg) if (down.has(k)) v -= 1;
    for (const k of pos) if (down.has(k)) v += 1;
    return clamp(v, -1, 1);
  };

  return {
    update(dt) {
      // Helm. A starship does not snap: the commanded rate ramps, which is why
      // turning one feels like turning something with mass in it.
      const yawTarget = clamp(axis(["a", "arrowleft"], ["d", "arrowright"]) + touch.yaw, -1, 1);
      const pitchTarget = clamp(axis(["s", "arrowdown"], ["w", "arrowup"]) + touch.pitch, -1, 1);
      const rollTarget = axis(["q"], ["e"]);
      const k = 1 - Math.exp(-9 * dt);
      input.yaw += (yawTarget - input.yaw) * k;
      input.pitch += (pitchTarget - input.pitch) * k;
      input.roll += (rollTarget - input.roll) * k;

      // Throttle is a lever, not a pedal: it holds where you leave it.
      if (touch.throttle >= 0) {
        input.throttle = touch.throttle;
      } else {
        if (down.has("shift")) input.throttle = Math.min(1, input.throttle + dt * 0.9);
        if (down.has("control") || down.has("c")) {
          input.throttle = Math.max(0, input.throttle - dt * 0.9);
        }
      }

      if (pointerActive && !input.touch) {
        // ±38° of yaw and ±20° of pitch is the whole room from the chair, and
        // the dead zone keeps the view still while you read.
        const dx = pointerX - 0.5;
        const dy = pointerY - 0.5;
        const dead = 0.08;
        const shape = (v: number) => {
          const a = Math.abs(v);
          return a < dead ? 0 : Math.sign(v) * ((a - dead) / (0.5 - dead)) ** 1.4;
        };
        const targetYaw = -shape(dx) * 0.66;
        const targetPitch = -shape(dy) * 0.34;
        const kk = 1 - Math.exp(-6 * dt);
        input.lookYaw += (targetYaw - input.lookYaw) * kk;
        input.lookPitch += (targetPitch - input.lookPitch) * kk;
      }
    },

    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      void KEY_HELP;
    },
  };
}
