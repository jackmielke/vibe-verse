import type { InputState } from "./types";

export interface InputController {
  state: InputState;
  consumeEnterExit: () => boolean;
  consumeMuteToggle: () => boolean;
  consumeDayNightToggle: () => boolean;
  requestPointerLock: () => void;
  isPointerLocked: () => boolean;
  dispose: () => void;
}

export function createInput(target: HTMLElement): InputController {
  const keys: Record<string, boolean> = {};
  const state: InputState = {
    forward: 0,
    strafe: 0,
    yaw: 0,
    pitch: 0,
    run: false,
    jump: false,
    enterExit: false,
    toggleMute: false,
    toggleDayNight: false,
  };

  let pendingEnterExit = false;
  let pendingMute = false;
  let pendingDayNight = false;

  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    keys[k] = true;
    if (k === "f") pendingEnterExit = true;
    if (k === "m") pendingMute = true;
    if (k === "n") pendingDayNight = true;
    if (k === " " || k === "arrowup" || k === "arrowdown" || k === "arrowleft" || k === "arrowright") {
      e.preventDefault();
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    keys[e.key.toLowerCase()] = false;
  };

  const onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== target) return;
    state.yaw -= e.movementX * 0.0022;
    state.pitch -= e.movementY * 0.0022;
    state.pitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, state.pitch));
  };

  const onClick = () => {
    if (document.pointerLockElement !== target) {
      target.requestPointerLock?.();
    }
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mousemove", onMouseMove);
  target.addEventListener("click", onClick);

  const update = () => {
    const fwd = (keys["w"] || keys["arrowup"] ? 1 : 0) - (keys["s"] || keys["arrowdown"] ? 1 : 0);
    const str = (keys["d"] || keys["arrowright"] ? 1 : 0) - (keys["a"] || keys["arrowleft"] ? 1 : 0);
    state.forward = fwd;
    state.strafe = str;
    state.run = !!keys["shift"];
    state.jump = !!keys[" "];
  };

  // Tick on RAF to coalesce keys → state
  let raf = 0;
  const loop = () => {
    update();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return {
    state,
    consumeEnterExit: () => {
      if (pendingEnterExit) {
        pendingEnterExit = false;
        return true;
      }
      return false;
    },
    consumeMuteToggle: () => {
      if (pendingMute) {
        pendingMute = false;
        return true;
      }
      return false;
    },
    consumeDayNightToggle: () => {
      if (pendingDayNight) {
        pendingDayNight = false;
        return true;
      }
      return false;
    },
    requestPointerLock: () => target.requestPointerLock?.(),
    isPointerLocked: () => document.pointerLockElement === target,
    dispose: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      target.removeEventListener("click", onClick);
    },
  };
}
