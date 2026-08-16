/**
 * The Midnight Zone — input.
 *
 * Keyboard + mouse, and a touch layer that is not an afterthought: a left
 * thumb stick for surge/yaw, a right pair of pads for ballast, and taps for
 * scan and lamps. The world is a slow drift through the dark, which is exactly
 * the kind of thing people do one-handed on a phone.
 *
 * Look is accumulated as a *delta* and consumed by the sub each frame — the
 * sub owns the attitude, this only reports what the hand did. That is why
 * `lookYaw`/`lookPitch` are zeroed by the reader rather than here.
 */
import type { DeepCtx, System } from "../types";

const LOOK_SPEED = 0.0026;
const TOUCH_LOOK_SPEED = 0.004;

export interface DeepInputService {
  source: "keyboard" | "touch";
  setTouchVisible(visible: boolean): void;
}

export default function createInput(ctx: DeepCtx): System {
  const keys = new Set<string>();
  const canvas = ctx.renderer.domElement;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  // -- touch state ----------------------------------------------------------
  let stickId = -1;
  let stickX = 0;
  let stickY = 0;
  let stickOx = 0;
  let stickOy = 0;
  let lookId = -1;
  let touchHeave = 0;

  const service: DeepInputService = {
    source: "keyboard",
    setTouchVisible(visible) {
      root.style.display = visible ? "block" : "none";
    },
  };
  ctx.services.input = service;

  // -- keyboard -------------------------------------------------------------
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
    if (!keys.has(k)) {
      if (k === "f") ctx.input.scanPressed = true;
      if (k === "l") ctx.input.lightsPressed = true;
      if (k === "escape" || k === "p") ctx.input.pausePressed = true;
    }
    keys.add(k);
    service.source = "keyboard";
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
  const onBlur = () => keys.clear();

  // -- mouse ----------------------------------------------------------------
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType === "touch" || !dragging) return;
    ctx.input.lookYaw += (e.clientX - lastX) * LOOK_SPEED;
    ctx.input.lookPitch += (e.clientY - lastY) * LOOK_SPEED;
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  canvas.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);

  // -- touch overlay --------------------------------------------------------
  // Built in DOM rather than in the HUD's React tree so it survives a HUD that
  // failed to mount: losing the menu is bad, losing the controls is fatal.
  const root = document.createElement("div");
  root.setAttribute("data-deep-hud", "touch");
  root.style.cssText =
    "position:absolute;inset:0;z-index:20;display:none;pointer-events:none;touch-action:none;";
  const stick = document.createElement("div");
  stick.style.cssText =
    "position:absolute;left:5vmin;bottom:9vmin;width:30vmin;height:30vmin;border-radius:50%;" +
    "border:0.4vmin solid rgba(150,225,255,0.28);background:rgba(8,26,44,0.3);pointer-events:auto;";
  const nub = document.createElement("div");
  nub.style.cssText =
    "position:absolute;left:50%;top:50%;width:11vmin;height:11vmin;margin:-5.5vmin 0 0 -5.5vmin;" +
    "border-radius:50%;background:rgba(150,225,255,0.42);box-shadow:0 0 3vmin rgba(120,220,255,0.5);";
  stick.appendChild(nub);
  root.appendChild(stick);

  const mkPad = (label: string, bottom: string, onDownPad: () => void, onUpPad: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      `position:absolute;right:5vmin;bottom:${bottom};width:15vmin;height:11vmin;border-radius:2vmin;` +
      "border:0.35vmin solid rgba(150,225,255,0.3);background:rgba(8,26,44,0.45);color:#bfe9ff;" +
      "font:900 3.2vmin/1 system-ui;pointer-events:auto;touch-action:none;";
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      onDownPad();
    });
    b.addEventListener("pointerup", onUpPad);
    b.addEventListener("pointercancel", onUpPad);
    b.addEventListener("pointerleave", onUpPad);
    root.appendChild(b);
    return b;
  };
  mkPad("▲", "24vmin", () => (touchHeave = 1), () => (touchHeave = 0));
  mkPad("▼", "10vmin", () => (touchHeave = -1), () => (touchHeave = 0));

  const mkTap = (label: string, right: string, fire: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      `position:absolute;right:${right};top:12vmin;padding:1.4vmin 2.4vmin;border-radius:1.6vmin;` +
      "border:0.35vmin solid rgba(150,225,255,0.3);background:rgba(8,26,44,0.45);color:#bfe9ff;" +
      "font:900 1.9vmin/1 system-ui;letter-spacing:0.12em;pointer-events:auto;touch-action:none;";
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      fire();
    });
    root.appendChild(b);
  };
  mkTap("SCAN", "5vmin", () => (ctx.input.scanPressed = true));
  mkTap("LAMPS", "22vmin", () => (ctx.input.lightsPressed = true));

  canvas.parentElement?.appendChild(root);

  const onTouchStart = (e: TouchEvent) => {
    service.source = "touch";
    root.style.display = "block";
    for (const t of Array.from(e.changedTouches)) {
      const inStick = t.clientX < window.innerWidth * 0.42 && t.clientY > window.innerHeight * 0.45;
      if (inStick && stickId === -1) {
        stickId = t.identifier;
        stickOx = t.clientX;
        stickOy = t.clientY;
      } else if (lookId === -1 && t.clientX > window.innerWidth * 0.42) {
        lookId = t.identifier;
        lastX = t.clientX;
        lastY = t.clientY;
      }
    }
  };
  const onTouchMove = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === stickId) {
        const max = Math.min(window.innerWidth, window.innerHeight) * 0.13;
        stickX = Math.max(-1, Math.min(1, (t.clientX - stickOx) / max));
        stickY = Math.max(-1, Math.min(1, (t.clientY - stickOy) / max));
        nub.style.transform = `translate(${stickX * 5.5}vmin, ${stickY * 5.5}vmin)`;
      } else if (t.identifier === lookId) {
        ctx.input.lookYaw += (t.clientX - lastX) * TOUCH_LOOK_SPEED;
        ctx.input.lookPitch += (t.clientY - lastY) * TOUCH_LOOK_SPEED;
        lastX = t.clientX;
        lastY = t.clientY;
      }
    }
  };
  const onTouchEnd = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === stickId) {
        stickId = -1;
        stickX = stickY = 0;
        nub.style.transform = "translate(0,0)";
      } else if (t.identifier === lookId) {
        lookId = -1;
      }
    }
  };
  canvas.addEventListener("touchstart", onTouchStart, { passive: true });
  canvas.addEventListener("touchmove", onTouchMove, { passive: true });
  canvas.addEventListener("touchend", onTouchEnd, { passive: true });
  canvas.addEventListener("touchcancel", onTouchEnd, { passive: true });

  const held = (...names: string[]) => names.some((n) => keys.has(n));

  return {
    update() {
      const i = ctx.input;
      const kSurge = (held("w", "arrowup") ? 1 : 0) - (held("s", "arrowdown") ? 1 : 0);
      const kYaw = (held("d", "arrowright") ? 1 : 0) - (held("a", "arrowleft") ? 1 : 0);
      const kHeave = (held(" ", "e", "r") ? 1 : 0) - (held("shift", "q", "c") ? 1 : 0);

      i.surge = Math.max(-1, Math.min(1, kSurge - stickY));
      i.yaw = Math.max(-1, Math.min(1, kYaw + stickX));
      i.heave = Math.max(-1, Math.min(1, kHeave + touchHeave));
      // Shift is ballast-down, so it cannot also gate boost.
      i.boost = held("z");
    },

    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchEnd);
      root.remove();
      if (ctx.services.input === service) delete ctx.services.input;
    },
  };
}
