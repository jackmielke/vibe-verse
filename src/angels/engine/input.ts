/**
 * Input — keyboard, mouse, gamepad and a touch overlay built for thumbs.
 *
 * ## The timing contract
 * Continuous axes are written every frame from `update`. Edge-triggered flags
 * (`viewPressed`, `gearToggle`, …) are raised inside the DOM handler that saw
 * the press and cleared by the engine at the end of the frame, so a tap that
 * lands between two frames is never lost and never fires twice.
 *
 * ## Why the touch layout is shaped the way it is
 * A flight sim on a phone fails in one of two ways: it asks for four
 * simultaneous axes from two thumbs, or it takes so much away that you are
 * watching a cutscene. This layout gives the thumbs the two things that
 * actually fly the aeroplane — the stick and the throttle — puts everything
 * else on buttons that can be missed without consequence, and leans on the
 * fly-by-wire underneath to make a rough thumb gesture into a clean manoeuvre.
 *
 * The stick floats: it materialises wherever the thumb lands rather than
 * living in a fixed circle. That is the single difference between a control
 * that works while a phone is being held one-handed and one that does not.
 *
 * ## Pitch sense
 * Default is **push up to climb**, because that is what someone who has never
 * flown expects and this is a game before it is a simulator. Real stick sense
 * (pull back to climb) is one toggle away and the setting is remembered.
 */
import * as THREE from "three";
import type { AngelsCtx, AngelsInput, System } from "../types";
import { isShotMode } from "./core";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Pointer capture, defensively.
 *
 * `setPointerCapture` throws — not returns false, throws — if the browser does
 * not consider that pointer active, and a throw inside a `pointerdown` handler
 * abandons the rest of it. That would leave a stick that renders but never
 * moves. It costs nothing to make it impossible.
 */
function capture(el: Element, id: number): void {
  try {
    el.setPointerCapture?.(id);
  } catch {
    /* the gesture still works without capture; it just leaks past the edge */
  }
}

function release(el: Element, id: number): void {
  try {
    el.releasePointerCapture?.(id);
  } catch {
    /* already released, or never captured */
  }
}

/** Expo shaping: soft around neutral, full authority at the edge. */
function expo(v: number, amount = 1.7): number {
  const s = Math.sign(v);
  const a = Math.abs(v);
  return s * Math.pow(a, amount);
}

const DEADZONE = 0.09;
function dead(v: number): number {
  const a = Math.abs(v);
  if (a < DEADZONE) return 0;
  return Math.sign(v) * ((a - DEADZONE) / (1 - DEADZONE));
}

export interface InputSettings {
  /** Real stick sense: pull back to climb. */
  invertPitch: boolean;
  /** Roll the jet by tilting the phone instead of using the stick's X axis. */
  tiltRoll: boolean;
  /** The throttle looks after itself; the stick is all you touch. */
  autoThrottle: boolean;
  sensitivity: number;
}

export interface InputService {
  settings: InputSettings;
  setSetting<K extends keyof InputSettings>(key: K, value: InputSettings[K]): void;
  /** Show or hide the touch overlay. Null hands the decision back to the heuristic. */
  setTouchVisible(visible: boolean | null): void;
  /** Ask iOS for motion permission. Must be called from a real user gesture. */
  requestTilt(): void;
  hasGamepad(): boolean;
}

const SETTINGS_KEY = "angels.input";

function loadSettings(): InputSettings {
  const base: InputSettings = {
    invertPitch: false,
    tiltRoll: false,
    autoThrottle: false,
    sensitivity: 1,
  };
  if (typeof localStorage === "undefined") return base;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return base;
    return { ...base, ...(JSON.parse(raw) as Partial<InputSettings>) };
  } catch {
    return base;
  }
}

function saveSettings(s: InputSettings): void {
  try {
    localStorage?.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private mode, a full quota — none of it is worth a crash */
  }
}

export function createInput(ctx: AngelsCtx): System {
  const input = ctx.input;
  const canvas = ctx.renderer.domElement;
  const settings = loadSettings();
  const shot = isShotMode();

  const held = new Set<string>();
  let deviceUsed = false;
  let touchForced: boolean | null = null;
  const coarse =
    typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

  // Keyboard axes ramp rather than snap: a digital key driving an analogue
  // control law directly is how you get a jet that porpoises.
  let kbPitch = 0;
  let kbRoll = 0;
  let kbYaw = 0;
  let kbThrottle = 0.75;

  let tiltGamma = 0;
  let tiltZero = 0;
  let tiltCalibrated = false;

  let padIndex: number | null = null;

  const touch = buildTouchOverlay();

  // ---- keyboard -----------------------------------------------------------

  const EDGE: Record<string, keyof AngelsInput> = {
    KeyC: "viewPressed",
    KeyG: "gearToggle",
    KeyX: "smokeToggle",
    Escape: "pausePressed",
    KeyP: "pausePressed",
    KeyR: "resetPressed",
    KeyH: "photoPressed",
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    deviceUsed = true;
    input.source = "keyboard";
    const edge = EDGE[e.code];
    if (edge && !e.repeat) {
      (input as unknown as Record<string, boolean>)[edge] = true;
      e.preventDefault();
      return;
    }
    if (!held.has(e.code)) held.add(e.code);
    // Arrows and space scroll the page otherwise, which in a fullscreen world
    // shows up as the whole thing twitching under the canvas.
    if (
      e.code.startsWith("Arrow") ||
      e.code === "Space" ||
      e.code === "Tab" ||
      e.code.startsWith("Key")
    ) {
      e.preventDefault();
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    held.delete(e.code);
  };

  const onBlur = () => {
    held.clear();
    touch.reset();
  };

  // ---- mouse: free look while held ----------------------------------------

  let looking = false;
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "touch") {
      deviceUsed = true;
      input.source = "touch";
      input.touch = true;
      return;
    }
    if (e.button !== 2 && e.button !== 1) return;
    looking = true;
    capture(canvas, e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!looking || e.pointerType === "touch") return;
    input.lookX += e.movementX * 0.0022 * settings.sensitivity;
    input.lookY += e.movementY * 0.0022 * settings.sensitivity;
    input.looking = true;
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    if (looking) release(canvas, e.pointerId);
    looking = false;
    input.looking = false;
  };

  const onWheel = (e: WheelEvent) => {
    deviceUsed = true;
    kbThrottle = clamp(kbThrottle - e.deltaY * 0.0009, 0, 1);
    e.preventDefault();
  };

  const onContext = (e: Event) => e.preventDefault();

  // ---- gamepad ------------------------------------------------------------

  const onPadConnect = (e: GamepadEvent) => {
    padIndex = e.gamepad.index;
  };
  const onPadDisconnect = (e: GamepadEvent) => {
    if (padIndex === e.gamepad.index) padIndex = null;
  };

  let padPrev: boolean[] = [];

  function samplePad(): boolean {
    if (typeof navigator === "undefined" || !navigator.getGamepads) return false;
    const pads = navigator.getGamepads();
    let pad: Gamepad | null = null;
    if (padIndex !== null) pad = pads[padIndex] ?? null;
    if (!pad) {
      for (const p of pads) {
        if (p?.connected) {
          pad = p;
          padIndex = p.index;
          break;
        }
      }
    }
    if (!pad) return false;

    const ax = pad.axes;
    const lx = dead(ax[0] ?? 0);
    const ly = dead(ax[1] ?? 0);
    const rx = dead(ax[2] ?? 0);
    // Triggers: analogue on a modern pad, buttons on an old one.
    const lt = pad.buttons[6]?.value ?? 0;
    const rt = pad.buttons[7]?.value ?? 0;

    const active =
      Math.abs(lx) > 0 || Math.abs(ly) > 0 || Math.abs(rx) > 0 || lt > 0.06 || rt > 0.06;
    if (active) {
      deviceUsed = true;
      input.source = "gamepad";
    }
    if (input.source !== "gamepad") return false;

    input.roll = expo(lx) * settings.sensitivity;
    // A pad stick pushed forward is nose-down in every flight game ever made,
    // so the raw axis already carries real-stick sense; the setting flips it.
    input.pitch = expo(settings.invertPitch ? ly : -ly) * settings.sensitivity;
    input.yaw = expo(rx, 1.4);
    if (rt > 0.02 || lt > 0.02) kbThrottle = clamp(kbThrottle + (rt - lt) * 0.03, 0, 1);
    input.throttle = kbThrottle;
    input.brake = pad.buttons[4]?.value ?? 0;
    input.wheelBrake = pad.buttons[5]?.value ?? 0;

    const edges: Array<[number, keyof AngelsInput]> = [
      [0, "viewPressed"],
      [1, "smokeToggle"],
      [2, "gearToggle"],
      [3, "resetPressed"],
      [9, "pausePressed"],
    ];
    for (const [i, flag] of edges) {
      const pressed = pad.buttons[i]?.pressed ?? false;
      if (pressed && !padPrev[i]) (input as unknown as Record<string, boolean>)[flag] = true;
      padPrev[i] = pressed;
    }
    return true;
  }

  // ---- tilt ---------------------------------------------------------------

  const onOrientation = (e: DeviceOrientationEvent) => {
    if (!settings.tiltRoll) return;
    // Landscape is the assumed grip, so beta is the roll axis; in portrait it
    // is gamma. Reading `window.orientation` is deprecated but it is the only
    // thing that answers on every phone that matters.
    const portrait = window.innerHeight > window.innerWidth;
    const raw = portrait ? (e.gamma ?? 0) : (e.beta ?? 0);
    if (!tiltCalibrated) {
      tiltZero = raw;
      tiltCalibrated = true;
    }
    tiltGamma = raw;
  };

  // ---- wiring -------------------------------------------------------------

  const prevTouchAction = canvas.style.touchAction;
  const prevOverscroll = typeof document !== "undefined" ? document.body.style.overscrollBehavior : "";
  canvas.style.touchAction = "none";
  if (typeof document !== "undefined") document.body.style.overscrollBehavior = "none";

  const onTouchMove = (e: TouchEvent) => e.preventDefault();

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("gamepadconnected", onPadConnect);
  window.addEventListener("gamepaddisconnected", onPadDisconnect);
  window.addEventListener("deviceorientation", onOrientation);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContext);
  canvas.addEventListener("touchmove", onTouchMove, { passive: false });

  touch.attach(input, {
    onFirstTouch() {
      deviceUsed = true;
      input.source = "touch";
      input.touch = true;
    },
    settings,
  });

  function touchVisible(): boolean {
    if (touchForced !== null) return touchForced;
    if (shot) return false;
    if (input.source === "touch") return true;
    // A coarse pointer puts the controls up before the first tap: a phone
    // player should not have to guess that the screen does anything.
    return coarse && !deviceUsed;
  }

  const service: InputService = {
    settings,
    setSetting(key, value) {
      settings[key] = value;
      if (key === "tiltRoll") {
        tiltCalibrated = false;
        if (value) service.requestTilt();
      }
      saveSettings(settings);
    },
    setTouchVisible(visible) {
      touchForced = visible;
    },
    requestTilt() {
      const DOE = (
        window as unknown as {
          DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
        }
      ).DeviceOrientationEvent;
      // iOS gates motion behind an explicit grant that must be asked for from
      // a user gesture — which is exactly where this call comes from.
      if (DOE?.requestPermission) {
        DOE.requestPermission().catch(() => {
          settings.tiltRoll = false;
          saveSettings(settings);
        });
      }
    },
    hasGamepad: () => padIndex !== null,
  };
  ctx.services.input = service;

  return {
    update(dt) {
      touch.setVisible(touchVisible());

      const padActive = samplePad();
      if (padActive) return;

      if (input.source === "touch") {
        touch.write(
          input,
          settings.tiltRoll && tiltCalibrated
            ? clamp((tiltGamma - tiltZero) / 24, -1, 1)
            : null,
        );
        return;
      }

      // ---- keyboard axes, ramped ------------------------------------------
      const rate = 3.4 * settings.sensitivity;
      const centre = 5.2;

      const up = held.has("ArrowUp") || held.has("KeyW");
      const down = held.has("ArrowDown") || held.has("KeyS");
      const left = held.has("ArrowLeft") || held.has("KeyA");
      const right = held.has("ArrowRight") || held.has("KeyD");
      const yawL = held.has("KeyQ") || held.has("Comma");
      const yawR = held.has("KeyE") || held.has("Period");

      // "Up" means climb unless the pilot has asked for real stick sense.
      const climb = settings.invertPitch ? down : up;
      const dive = settings.invertPitch ? up : down;

      const step = (v: number, wantPos: boolean, wantNeg: boolean) => {
        if (wantPos) return clamp(v + rate * dt, -1, 1);
        if (wantNeg) return clamp(v - rate * dt, -1, 1);
        const decay = centre * dt;
        return Math.abs(v) <= decay ? 0 : v - Math.sign(v) * decay;
      };

      kbPitch = step(kbPitch, climb, dive);
      kbRoll = step(kbRoll, right, left);
      kbYaw = step(kbYaw, yawR, yawL);

      if (held.has("ShiftLeft") || held.has("ShiftRight")) kbThrottle = clamp(kbThrottle + dt * 0.7, 0, 1);
      if (held.has("ControlLeft") || held.has("KeyZ")) kbThrottle = clamp(kbThrottle - dt * 0.7, 0, 1);
      // Number row is a throttle gate: 1 is idle, 0 is full burner.
      for (let i = 1; i <= 9; i++) {
        if (held.has(`Digit${i}`)) kbThrottle = (i - 1) / 8;
      }
      if (held.has("Digit0")) kbThrottle = 1;

      input.pitch = kbPitch;
      input.roll = kbRoll;
      input.yaw = kbYaw;
      input.throttle = kbThrottle;
      input.brake = held.has("Space") ? 1 : 0;
      input.wheelBrake = held.has("KeyB") ? 1 : 0;
      input.touch = false;
    },

    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("gamepadconnected", onPadConnect);
      window.removeEventListener("gamepaddisconnected", onPadDisconnect);
      window.removeEventListener("deviceorientation", onOrientation);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContext);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.style.touchAction = prevTouchAction;
      if (typeof document !== "undefined") document.body.style.overscrollBehavior = prevOverscroll;
      touch.dispose();
      held.clear();
      padPrev = [];
      if (ctx.services.input === service) delete ctx.services.input;
    },
  };
}

// ---------------------------------------------------------------------------
// Touch overlay
// ---------------------------------------------------------------------------

interface TouchHooks {
  onFirstTouch(): void;
  settings: InputSettings;
}

interface TouchOverlay {
  attach(input: AngelsInput, hooks: TouchHooks): void;
  write(input: AngelsInput, tilt: number | null): void;
  setVisible(visible: boolean): void;
  reset(): void;
  dispose(): void;
}

const OVERLAY_ID = "blue-angels-touch";

/**
 * DOM rather than canvas: it costs no draw calls, it is crisp at whatever
 * pixel ratio the device has, and a backdrop blur that would be expensive in
 * GL is free here.
 *
 * Layout, landscape: stick anywhere in the left 46%, throttle strip pinned to
 * the right edge, four buttons stacked inboard of it, rudder chips along the
 * bottom middle where neither thumb has to leave its home position. Portrait
 * moves the throttle down beside the stick and shrinks the button column,
 * because in portrait the top two thirds of the screen is the view and putting
 * a control up there means covering the thing you are flying at.
 *
 * Tagged `data-angels-hud` so the screenshot harness hides it with the rest of
 * the chrome.
 */
function buildTouchOverlay(): TouchOverlay {
  if (typeof document === "undefined") {
    return {
      attach() {},
      write() {},
      setVisible() {},
      reset() {},
      dispose() {},
    };
  }

  const style = document.createElement("style");
  style.id = `${OVERLAY_ID}-style`;
  style.textContent = `
#${OVERLAY_ID}{position:fixed;inset:0;z-index:26;pointer-events:none;display:none;
  touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;
  font:600 12px/1 ui-rounded,system-ui,-apple-system,sans-serif;letter-spacing:.09em;text-transform:uppercase}
#${OVERLAY_ID}.on{display:block}
#${OVERLAY_ID} .zone{position:absolute;left:0;top:0;bottom:0;width:46%;pointer-events:auto}
#${OVERLAY_ID} .base,#${OVERLAY_ID} .knob{position:absolute;border-radius:50%;
  transform:translate(-50%,-50%);opacity:0;transition:opacity .18s ease}
#${OVERLAY_ID} .base{width:146px;height:146px;background:rgba(10,36,114,.16);
  border:2px solid rgba(255,255,255,.32);
  box-shadow:0 8px 26px rgba(0,0,0,.30) inset,0 2px 10px rgba(0,0,0,.22)}
#${OVERLAY_ID} .base::before,#${OVERLAY_ID} .base::after{content:"";position:absolute;
  background:rgba(255,255,255,.20)}
#${OVERLAY_ID} .base::before{left:50%;top:12%;bottom:12%;width:1px;transform:translateX(-50%)}
#${OVERLAY_ID} .base::after{top:50%;left:12%;right:12%;height:1px;transform:translateY(-50%)}
#${OVERLAY_ID} .knob{width:66px;height:66px;
  background:radial-gradient(circle at 34% 30%,rgba(255,255,255,.97),rgba(214,226,246,.66));
  box-shadow:0 4px 16px rgba(0,0,0,.4)}
#${OVERLAY_ID} .base.live,#${OVERLAY_ID} .knob.live{opacity:1}

#${OVERLAY_ID} .thr{position:absolute;pointer-events:auto;right:max(16px,env(safe-area-inset-right));
  bottom:max(20px,env(safe-area-inset-bottom));width:64px;height:min(48vh,260px);border-radius:32px;
  background:linear-gradient(180deg,rgba(255,199,40,.20),rgba(10,36,114,.30));
  border:2px solid rgba(255,255,255,.34);overflow:hidden;
  box-shadow:0 6px 20px rgba(0,0,0,.32)}
#${OVERLAY_ID} .fill{position:absolute;left:0;right:0;bottom:0;
  background:linear-gradient(180deg,rgba(255,199,40,.92),rgba(255,160,20,.72));
  transition:height .06s linear}
#${OVERLAY_ID} .ab{position:absolute;left:0;right:0;top:0;height:12%;
  background:repeating-linear-gradient(45deg,rgba(255,90,40,.75) 0 6px,rgba(255,150,40,.55) 6px 12px)}
#${OVERLAY_ID} .thrLabel{position:absolute;left:0;right:0;bottom:8px;text-align:center;
  font-size:10px;color:rgba(255,255,255,.9);text-shadow:0 1px 3px rgba(0,0,0,.8);pointer-events:none}

#${OVERLAY_ID} .btn{position:absolute;pointer-events:auto;border-radius:50%;display:grid;place-items:center;
  width:62px;height:62px;font-size:10.5px;color:rgba(8,16,34,.86);
  background:linear-gradient(180deg,rgba(255,255,255,.92),rgba(222,232,246,.72));
  border:2px solid rgba(255,255,255,.7);box-shadow:0 5px 16px rgba(0,0,0,.32);
  transition:transform .09s ease,filter .09s ease}
#${OVERLAY_ID} .btn.down{transform:scale(.92);filter:brightness(.86)}
#${OVERLAY_ID} .btn.lit{background:linear-gradient(180deg,#ffd75c,#f0a90c);border-color:rgba(255,246,214,.9)}
#${OVERLAY_ID} .brk{right:max(92px,calc(env(safe-area-inset-right) + 92px));bottom:max(24px,env(safe-area-inset-bottom))}
#${OVERLAY_ID} .smk{right:max(92px,calc(env(safe-area-inset-right) + 92px));bottom:max(96px,calc(env(safe-area-inset-bottom) + 76px))}
#${OVERLAY_ID} .vw{right:max(92px,calc(env(safe-area-inset-right) + 92px));bottom:max(168px,calc(env(safe-area-inset-bottom) + 148px))}
#${OVERLAY_ID} .gr{right:max(92px,calc(env(safe-area-inset-right) + 92px));bottom:max(240px,calc(env(safe-area-inset-bottom) + 220px));
  width:52px;height:52px;font-size:9.5px}

#${OVERLAY_ID} .rud{position:absolute;pointer-events:auto;bottom:max(18px,env(safe-area-inset-bottom));
  width:56px;height:44px;border-radius:14px;display:grid;place-items:center;font-size:15px;
  color:rgba(255,255,255,.85);background:rgba(10,26,58,.42);border:1.5px solid rgba(255,255,255,.26)}
#${OVERLAY_ID} .rud.down{background:rgba(255,199,40,.5);color:#101a30}
#${OVERLAY_ID} .rl{left:calc(50% - 68px)}
#${OVERLAY_ID} .rr{left:calc(50% + 12px)}

/* Portrait: the view is the top two thirds and nothing may cover it. */
@media (orientation:portrait){
  #${OVERLAY_ID} .zone{width:52%;top:38%}
  #${OVERLAY_ID} .thr{width:56px;height:min(30vh,190px)}
  #${OVERLAY_ID} .btn{width:56px;height:56px;font-size:10px}
  #${OVERLAY_ID} .brk{right:max(84px,calc(env(safe-area-inset-right) + 84px))}
  #${OVERLAY_ID} .smk{right:max(84px,calc(env(safe-area-inset-right) + 84px));bottom:max(88px,calc(env(safe-area-inset-bottom) + 70px))}
  #${OVERLAY_ID} .vw{right:max(84px,calc(env(safe-area-inset-right) + 84px));bottom:max(156px,calc(env(safe-area-inset-bottom) + 138px))}
  #${OVERLAY_ID} .gr{right:max(84px,calc(env(safe-area-inset-right) + 84px));bottom:max(224px,calc(env(safe-area-inset-bottom) + 206px));width:48px;height:48px}
  #${OVERLAY_ID} .rud{bottom:max(74px,calc(env(safe-area-inset-bottom) + 60px));width:50px;height:40px}
  #${OVERLAY_ID} .rl{left:16px}
  #${OVERLAY_ID} .rr{left:78px}
}
/* A short landscape window (a phone on its side) has no vertical room to spare. */
@media (orientation:landscape) and (max-height:430px){
  #${OVERLAY_ID} .base{width:124px;height:124px}
  #${OVERLAY_ID} .knob{width:56px;height:56px}
  #${OVERLAY_ID} .thr{width:56px;height:min(58vh,200px)}
  #${OVERLAY_ID} .btn{width:54px;height:54px;font-size:9.5px}
  #${OVERLAY_ID} .brk{right:max(84px,calc(env(safe-area-inset-right) + 84px))}
  #${OVERLAY_ID} .smk{right:max(84px,calc(env(safe-area-inset-right) + 84px));bottom:max(84px,calc(env(safe-area-inset-bottom) + 66px))}
  #${OVERLAY_ID} .vw{right:max(84px,calc(env(safe-area-inset-right) + 84px));bottom:max(148px,calc(env(safe-area-inset-bottom) + 130px))}
  #${OVERLAY_ID} .gr{display:none}
}
`;

  const root = document.createElement("div");
  root.id = OVERLAY_ID;
  root.setAttribute("data-angels-hud", "touch");
  root.innerHTML =
    '<div class="zone"></div><div class="base"></div><div class="knob"></div>' +
    '<div class="thr"><div class="fill"></div><div class="ab"></div><div class="thrLabel">PWR</div></div>' +
    '<div class="btn brk">Brk</div><div class="btn smk">Smoke</div>' +
    '<div class="btn vw">View</div><div class="btn gr">Gear</div>' +
    '<div class="rud rl">&#9664;</div><div class="rud rr">&#9654;</div>';

  const zone = root.querySelector(".zone") as HTMLDivElement;
  const base = root.querySelector(".base") as HTMLDivElement;
  const knob = root.querySelector(".knob") as HTMLDivElement;
  const thr = root.querySelector(".thr") as HTMLDivElement;
  const fill = root.querySelector(".fill") as HTMLDivElement;
  const brkBtn = root.querySelector(".brk") as HTMLDivElement;
  const smkBtn = root.querySelector(".smk") as HTMLDivElement;
  const viewBtn = root.querySelector(".vw") as HTMLDivElement;
  const gearBtn = root.querySelector(".gr") as HTMLDivElement;
  const rudL = root.querySelector(".rl") as HTMLDivElement;
  const rudR = root.querySelector(".rr") as HTMLDivElement;

  /** Stick travel in CSS pixels for full deflection. */
  const THROW = 58;

  let stickId: number | null = null;
  let originX = 0;
  let originY = 0;
  let stickX = 0;
  let stickY = 0;

  let thrId: number | null = null;
  let throttle = 0.75;

  let brake = false;
  let rudder = 0;
  let smokeOn = false;
  let gearOn = false;

  const buttonIds = new Map<number, HTMLDivElement>();
  let hooks: TouchHooks | null = null;
  let inputRef: AngelsInput | null = null;
  let attached = false;

  const placeStick = (x: number, y: number) => {
    base.style.left = `${originX}px`;
    base.style.top = `${originY}px`;
    knob.style.left = `${x}px`;
    knob.style.top = `${y}px`;
  };

  const onZoneDown = (e: PointerEvent) => {
    if (stickId !== null) return;
    hooks?.onFirstTouch();
    stickId = e.pointerId;
    capture(zone, e.pointerId);
    originX = e.clientX;
    originY = e.clientY;
    base.classList.add("live");
    knob.classList.add("live");
    placeStick(e.clientX, e.clientY);
    e.preventDefault();
  };

  const onZoneMove = (e: PointerEvent) => {
    if (e.pointerId !== stickId) return;
    const dx = e.clientX - originX;
    const dy = e.clientY - originY;
    const len = Math.hypot(dx, dy);
    const k = len > THROW ? THROW / len : 1;
    placeStick(originX + dx * k, originY + dy * k);
    stickX = clamp(dx / THROW, -1, 1);
    stickY = clamp(dy / THROW, -1, 1);
    e.preventDefault();
  };

  const onZoneUp = (e: PointerEvent) => {
    if (e.pointerId !== stickId) return;
    release(zone, e.pointerId);
    stickId = null;
    stickX = 0;
    stickY = 0;
    base.classList.remove("live");
    knob.classList.remove("live");
  };

  const readThrottle = (clientY: number) => {
    const r = thr.getBoundingClientRect();
    // Top of the strip is full burner, bottom is idle — the way a real quadrant
    // works, and the way the fill bar reads.
    throttle = clamp(1 - (clientY - r.top) / Math.max(1, r.height), 0, 1);
    fill.style.height = `${throttle * 100}%`;
  };

  const onThrDown = (e: PointerEvent) => {
    hooks?.onFirstTouch();
    thrId = e.pointerId;
    capture(thr, e.pointerId);
    readThrottle(e.clientY);
    e.preventDefault();
  };
  const onThrMove = (e: PointerEvent) => {
    if (e.pointerId !== thrId) return;
    readThrottle(e.clientY);
    e.preventDefault();
  };
  const onThrUp = (e: PointerEvent) => {
    if (e.pointerId !== thrId) return;
    release(thr, e.pointerId);
    thrId = null;
  };

  function bindButton(el: HTMLDivElement, onDown: () => void, onUp?: () => void): void {
    const down = (e: PointerEvent) => {
      hooks?.onFirstTouch();
      buttonIds.set(e.pointerId, el);
      el.classList.add("down");
      capture(el, e.pointerId);
      onDown();
      e.preventDefault();
    };
    const release = (e: PointerEvent) => {
      if (buttonIds.get(e.pointerId) !== el) return;
      buttonIds.delete(e.pointerId);
      el.classList.remove("down");
      onUp?.();
    };
    el.addEventListener("pointerdown", down, { passive: false });
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    el.addEventListener("pointerleave", release);
  }

  const overlay: TouchOverlay = {
    attach(input, h) {
      if (attached) return;
      attached = true;
      hooks = h;
      inputRef = input;
      throttle = input.throttle;
      fill.style.height = `${throttle * 100}%`;
      document.head.appendChild(style);
      document.body.appendChild(root);

      zone.addEventListener("pointerdown", onZoneDown, { passive: false });
      zone.addEventListener("pointermove", onZoneMove, { passive: false });
      zone.addEventListener("pointerup", onZoneUp);
      zone.addEventListener("pointercancel", onZoneUp);

      thr.addEventListener("pointerdown", onThrDown, { passive: false });
      thr.addEventListener("pointermove", onThrMove, { passive: false });
      thr.addEventListener("pointerup", onThrUp);
      thr.addEventListener("pointercancel", onThrUp);

      bindButton(brkBtn, () => { brake = true; }, () => { brake = false; });
      bindButton(smkBtn, () => {
        smokeOn = !smokeOn;
        smkBtn.classList.toggle("lit", smokeOn);
        if (inputRef) inputRef.smokeToggle = true;
      });
      bindButton(viewBtn, () => {
        if (inputRef) inputRef.viewPressed = true;
      });
      bindButton(gearBtn, () => {
        gearOn = !gearOn;
        gearBtn.classList.toggle("lit", gearOn);
        if (inputRef) inputRef.gearToggle = true;
      });
      bindButton(rudL, () => { rudder = -1; }, () => { if (rudder < 0) rudder = 0; });
      bindButton(rudR, () => { rudder = 1; }, () => { if (rudder > 0) rudder = 0; });
    },

    write(input, tilt) {
      input.touch = true;
      // Push up to climb unless the pilot asked for real stick sense. Expo on
      // both axes, because a thumb's precision near neutral is what decides
      // whether formation flying is possible at all.
      const pitchRaw = hooks?.settings.invertPitch ? stickY : -stickY;
      input.pitch = expo(pitchRaw, 1.8) * (hooks?.settings.sensitivity ?? 1);
      input.roll = expo(tilt !== null ? tilt : stickX, 1.6) * (hooks?.settings.sensitivity ?? 1);
      input.yaw = rudder;
      input.brake = brake ? 1 : 0;
      // On the ground the same button is the wheel brake, which is what a
      // thumb reaching for "stop" expects it to be.
      input.wheelBrake = brake ? 1 : 0;
      if (hooks?.settings.autoThrottle) {
        input.throttle = clamp(0.72 + input.pitch * 0.28, 0.35, 1);
        fill.style.height = `${input.throttle * 100}%`;
      } else {
        input.throttle = throttle;
      }
    },

    setVisible(visible) {
      root.classList.toggle("on", visible);
    },

    reset() {
      stickId = null;
      thrId = null;
      stickX = 0;
      stickY = 0;
      brake = false;
      rudder = 0;
      buttonIds.clear();
      base.classList.remove("live");
      knob.classList.remove("live");
      for (const el of [brkBtn, smkBtn, viewBtn, gearBtn, rudL, rudR]) el.classList.remove("down");
    },

    dispose() {
      overlay.reset();
      zone.removeEventListener("pointerdown", onZoneDown);
      zone.removeEventListener("pointermove", onZoneMove);
      zone.removeEventListener("pointerup", onZoneUp);
      zone.removeEventListener("pointercancel", onZoneUp);
      thr.removeEventListener("pointerdown", onThrDown);
      thr.removeEventListener("pointermove", onThrMove);
      thr.removeEventListener("pointerup", onThrUp);
      thr.removeEventListener("pointercancel", onThrUp);
      root.remove();
      style.remove();
      attached = false;
      hooks = null;
      inputRef = null;
    },
  };

  return overlay;
}

/** Exposed for tests — the shaping the flight model actually receives. */
export const _shaping = { expo, dead, clamp };

/** Scratch used by callers that want to reason about the stick in world terms. */
export const _scratch = new THREE.Vector2();
