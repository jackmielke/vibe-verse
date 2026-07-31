/**
 * Vibe Kart — input: keyboard, gamepad and touch, normalised into `ctx.input`.
 *
 * Three devices, one contract. Whatever the player is holding, the simulation
 * only ever sees `accel`, `brake`, `steer`, `drift` and a handful of edges.
 *
 * TIMING. This matters more than it looks. The engine runs `fixedUpdate` for
 * every system *before* any `update`, and clears the edge flags at the end of
 * the frame. So an edge written during `update` would be cleared before the
 * physics ever ran a step against it. Two things fall out of that:
 *
 *   · Keyboard and touch edges are raised inside the DOM event handler, the
 *     instant the button goes down, so the next fixed step sees them.
 *   · The gamepad, which has to be polled, is sampled from this system's
 *     `fixedUpdate` — input is the first system booted, so its fixed step runs
 *     before the physics' does. A frame that runs no fixed step at all is
 *     caught by the same sampler being called from `update`, guarded so it
 *     happens exactly once per frame either way.
 *
 * Nothing here dispatches gameplay. It writes `ctx.input` and gets out of the
 * way.
 */
import { PALETTE, type KartCtx, type KartInput, type System } from "../types";

/** Published on `ctx.services.input` for the HUD and the options menu. */
export interface KartInputService {
  /** Device that last produced meaningful input. */
  source: "keyboard" | "gamepad" | "touch";
  /** A gamepad is connected and reporting. */
  gamepad: boolean;
  /** Fire the pad's rumble motors. Silently does nothing if it has none. */
  rumble(strength: number, ms?: number): void;
  /** Steer by tilting the device instead of using the on-screen stick. */
  setTiltSteer(on: boolean): void;
  tiltSteer: boolean;
  /** Force the touch overlay on or off; `null` returns it to auto-detect. */
  setTouchVisible(visible: boolean | null): void;
}

const DEADZONE = 0.16;
/** Slightly expanded response: fine control near centre, full lock at the rim. */
const STEER_EXP = 1.35;
/** Keyboard steering ramp, 1/s. Paired with the physics' own smoothing. */
const KEY_RAMP = 16;
const TRIGGER_FLOOR = 0.06;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function deadzone(x: number, dz: number): number {
  const a = Math.abs(x);
  if (!(a > dz)) return 0;
  return Math.sign(x) * ((a - dz) / (1 - dz));
}

function response(x: number): number {
  const v = deadzone(clamp(x, -1, 1), DEADZONE);
  return Math.sign(v) * Math.pow(Math.abs(v), STEER_EXP);
}

export default function createInput(ctx: KartCtx): System {
  const input: KartInput = ctx.input;
  const canvas = ctx.renderer.domElement;
  const shotMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  // ---------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------
  const held = new Set<string>();
  let keySteer = 0;
  let deviceUsed = false;
  let source: KartInputService["source"] = "keyboard";

  const has = (...codes: string[]) => codes.some((c) => held.has(c));

  /** Never eat keystrokes aimed at a text field. */
  const typing = (): boolean => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  };

  const airborne = (): boolean => {
    const phys = ctx.services.physics as { player?: { airTime: number; grounded: boolean } } | undefined;
    const p = phys?.player;
    return !!p && !p.grounded && p.airTime > 0.05;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.altKey || typing()) return;
    if (!held.has(e.code)) {
      // Edges are raised here, not in the sampler — see the timing note above.
      switch (e.code) {
        case "Space":
        case "ShiftLeft":
        case "ShiftRight":
          // In the air the drift button is the trick flick, which is exactly how
          // the genre has always spelled it.
          if (airborne()) {
            input.trick = has("KeyA", "ArrowLeft") ? -1 : has("KeyD", "ArrowRight") ? 1 : 1;
          } else {
            input.driftPressed = true;
          }
          break;
        case "KeyE":
        case "ControlLeft":
        case "ControlRight":
          input.itemPressed = true;
          break;
        case "Escape":
          input.pausePressed = true;
          break;
      }
    }
    held.add(e.code);
    deviceUsed = true;
    if (source !== "keyboard") setSource("keyboard");
    // Stop the page scrolling out from under the race.
    if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
  };

  const onKeyUp = (e: KeyboardEvent) => held.delete(e.code);
  const onBlur = () => held.clear();

  // ---------------------------------------------------------------------
  // Gamepad
  // ---------------------------------------------------------------------
  let padIndex = -1;
  let padButtons: boolean[] = [];
  let padStickY = 0;
  let hasPad = false;
  /** Right-stick flick latch, so one flick is one trick. */
  let flicked = false;

  const onPadConnect = (e: Event) => {
    padIndex = (e as GamepadEvent).gamepad?.index ?? 0;
    hasPad = true;
  };
  const onPadDisconnect = () => {
    padIndex = -1;
    hasPad = false;
    padButtons = [];
  };

  /** Analog value of a button, falling back to its pressed state. */
  function buttonValue(pad: Gamepad, index: number): number {
    const b = pad.buttons[index];
    if (!b) return 0;
    const v = typeof b.value === "number" ? b.value : b.pressed ? 1 : 0;
    return v > TRIGGER_FLOOR ? clamp(v, 0, 1) : 0;
  }

  function pressed(pad: Gamepad, index: number): boolean {
    const b = pad.buttons[index];
    return !!b && (b.pressed || b.value > 0.55);
  }

  /** Rising edge on a pad button, against the state we saw last sample. */
  function padEdge(pad: Gamepad, index: number): boolean {
    const now = pressed(pad, index);
    const was = padButtons[index] ?? false;
    padButtons[index] = now;
    return now && !was;
  }

  function samplePad(): boolean {
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : null;
    if (!pads) return false;
    let pad: Gamepad | null = padIndex >= 0 ? pads[padIndex] : null;
    if (!pad) {
      for (const p of pads) {
        if (p && p.connected) {
          pad = p;
          padIndex = p.index;
          break;
        }
      }
    }
    if (!pad || !pad.connected) {
      hasPad = false;
      return false;
    }
    hasPad = true;

    const steer = response(pad.axes[0] ?? 0);
    // Triggers first; face buttons as the fallback for pads without them.
    const rt = buttonValue(pad, 7);
    const lt = buttonValue(pad, 6);
    const accel = Math.max(rt, pressed(pad, 0) ? 1 : 0);
    const brake = Math.max(lt, pressed(pad, 1) ? 1 : 0);
    const drift = pressed(pad, 5) || pressed(pad, 4);
    const active =
      Math.abs(steer) > 0.02 || accel > 0 || brake > 0 || drift || pressed(pad, 2) || pressed(pad, 9);

    if (active) {
      deviceUsed = true;
      if (source !== "gamepad") setSource("gamepad");
    }
    if (source !== "gamepad") {
      // Keep the edge history warm so switching back does not fire a phantom
      // press for a button that was already being held.
      padEdge(pad, 5);
      padEdge(pad, 4);
      padEdge(pad, 2);
      padEdge(pad, 9);
      padEdge(pad, 8);
      return false;
    }

    input.steer = steer;
    input.accel = accel;
    input.brake = brake;
    input.drift = drift;
    input.lookBack = pressed(pad, 3);
    // Pull the stick back to aim an item over your shoulder.
    padStickY = pad.axes[1] ?? 0;
    input.aimBack = padStickY > 0.55 || brake > 0.5;
    input.touch = false;

    const driftEdge = padEdge(pad, 5) || padEdge(pad, 4);
    if (driftEdge) {
      if (airborne()) input.trick = steer < -0.35 ? -1 : steer > 0.35 ? 1 : 1;
      else input.driftPressed = true;
    }
    if (padEdge(pad, 2)) input.itemPressed = true;
    if (padEdge(pad, 9) || padEdge(pad, 8)) input.pausePressed = true;

    // D-pad and a right-stick flick both count as a trick.
    if (airborne()) {
      const flickX = pad.axes[2] ?? 0;
      const flickY = pad.axes[3] ?? 0;
      if (padEdge(pad, 12) || padEdge(pad, 13)) input.trick = 1;
      else if (padEdge(pad, 14)) input.trick = -1;
      else if (padEdge(pad, 15)) input.trick = 1;
      else if (Math.abs(flickX) > 0.62 || Math.abs(flickY) > 0.62) {
        if (!flicked) input.trick = flickX < -0.4 ? -1 : 1;
        flicked = true;
      } else if (Math.abs(flickX) < 0.35 && Math.abs(flickY) < 0.35) {
        flicked = false;
      }
    }
    return true;
  }

  function rumble(strength: number, ms = 140): void {
    if (padIndex < 0 || typeof navigator === "undefined" || !navigator.getGamepads) return;
    const pad = navigator.getGamepads()[padIndex];
    const actuator = (pad as unknown as { vibrationActuator?: { playEffect?: (t: string, o: object) => Promise<unknown> } })
      ?.vibrationActuator;
    if (!actuator?.playEffect) return;
    const s = clamp(strength, 0, 1);
    actuator
      .playEffect("dual-rumble", {
        startDelay: 0,
        duration: clamp(ms, 20, 1000),
        weakMagnitude: s,
        strongMagnitude: s * 0.85,
      })
      .catch(() => {
        /* some pads reject the effect type; that is not an error worth logging */
      });
  }

  // ---------------------------------------------------------------------
  // Touch
  // ---------------------------------------------------------------------
  const touch = buildTouchOverlay();
  let touchForced: boolean | null = null;
  let tiltSteer = false;
  let tiltZero = 0;
  let tiltGamma = 0;
  let tiltCalibrated = false;

  const onOrientation = (e: DeviceOrientationEvent) => {
    if (!tiltSteer) return;
    const gamma = e.gamma ?? 0;
    if (!tiltCalibrated) {
      tiltZero = gamma;
      tiltCalibrated = true;
    }
    tiltGamma = gamma;
  };

  function setTiltSteer(on: boolean): void {
    tiltSteer = on;
    tiltCalibrated = false;
    if (!on) return;
    const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } })
      .DeviceOrientationEvent;
    // iOS gates motion behind an explicit grant, which must be asked for from a
    // user gesture — which is exactly where this call comes from.
    if (DOE?.requestPermission) {
      DOE.requestPermission().catch(() => {
        tiltSteer = false;
      });
    }
  }

  /** A phone or tablet, as far as the browser is willing to say. */
  const coarsePointer =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(pointer: coarse)").matches
      : false;

  function touchVisible(): boolean {
    if (touchForced !== null) return touchForced;
    if (shotMode) return false;
    if (source === "touch") return true;
    // On a coarse pointer the controls are up before the first tap — a phone
    // player should not have to guess that touching the screen does something.
    return coarsePointer && !deviceUsed;
  }

  // Published before the listeners are wired: `setSource` writes through it, and
  // a keystroke arriving mid-construction must not find it in the dead zone
  // between `let` and its assignment.
  const service: KartInputService = {
    source,
    gamepad: false,
    rumble,
    setTiltSteer,
    get tiltSteer() {
      return tiltSteer;
    },
    setTouchVisible(visible) {
      touchForced = visible;
      touch.setVisible(touchVisible());
    },
  };
  ctx.services.input = service;

  // ---------------------------------------------------------------------
  // Sampling
  // ---------------------------------------------------------------------
  let sampledThisFrame = false;

  function setSource(next: KartInputService["source"]): void {
    if (source === next) return;
    source = next;
    service.source = next;
    if (next !== "touch") {
      touch.reset();
      input.touch = false;
    }
    touch.setVisible(touchVisible());
  }

  function sample(dt: number): void {
    service.gamepad = hasPad;
    // In `?shot` mode the harness drives `ctx.input` directly. Until a real
    // device says otherwise, leave its values exactly where it put them.
    if (shotMode && !deviceUsed) return;

    if (samplePad()) return;

    if (source === "touch") {
      touch.write(input, tiltSteer ? clamp((tiltGamma - tiltZero) / 26, -1, 1) : null);
      return;
    }

    const targetSteer = (has("KeyD", "ArrowRight") ? 1 : 0) - (has("KeyA", "ArrowLeft") ? 1 : 0);
    // A ramp rather than a step: binary steering makes an arcade racer feel
    // like a spreadsheet, and the physics smooths on top of this.
    keySteer += (targetSteer - keySteer) * Math.min(1, KEY_RAMP * dt);
    if (Math.abs(keySteer) < 1e-3) keySteer = 0;

    input.steer = clamp(keySteer, -1, 1);
    input.accel = has("KeyW", "ArrowUp") ? 1 : 0;
    input.brake = has("KeyS", "ArrowDown") ? 1 : 0;
    input.drift = has("Space", "ShiftLeft", "ShiftRight");
    input.lookBack = has("KeyC");
    // Holding back (or Q) fires the held item over your shoulder.
    input.aimBack = has("KeyQ", "KeyS", "ArrowDown");
    input.touch = false;
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  const prevTouchAction = canvas.style.touchAction;
  const prevOverscroll = document.body.style.overscrollBehavior;
  canvas.style.touchAction = "none";
  document.body.style.overscrollBehavior = "none";

  const onTouchMove = (e: TouchEvent) => e.preventDefault();
  const onContext = (e: Event) => e.preventDefault();

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("gamepadconnected", onPadConnect);
  window.addEventListener("gamepaddisconnected", onPadDisconnect);
  window.addEventListener("deviceorientation", onOrientation);
  canvas.addEventListener("touchmove", onTouchMove, { passive: false });
  canvas.addEventListener("contextmenu", onContext);

  touch.attach(canvas, input, {
    onFirstTouch: () => {
      deviceUsed = true;
      setSource("touch");
    },
    airborne,
  });
  touch.setVisible(touchVisible());

  return {
    fixedUpdate(dt) {
      // First fixed step of the frame: sample here so the physics sees this
      // frame's buttons rather than last frame's.
      if (sampledThisFrame) return;
      sampledThisFrame = true;
      sample(Math.max(dt, ctx.dt));
    },

    update(dt) {
      if (!sampledThisFrame) sample(dt);
      sampledThisFrame = false;
    },

    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("gamepadconnected", onPadConnect);
      window.removeEventListener("gamepaddisconnected", onPadDisconnect);
      window.removeEventListener("deviceorientation", onOrientation);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("contextmenu", onContext);
      canvas.style.touchAction = prevTouchAction;
      document.body.style.overscrollBehavior = prevOverscroll;
      touch.dispose();
      held.clear();
      if (ctx.services.input === service) delete ctx.services.input;
    },
  };
}

// ---------------------------------------------------------------------------
// Touch overlay
// ---------------------------------------------------------------------------

interface TouchHooks {
  onFirstTouch(): void;
  airborne(): boolean;
}

interface TouchOverlay {
  attach(canvas: HTMLCanvasElement, input: KartInput, hooks: TouchHooks): void;
  /** Write the current gesture state into `ctx.input`. */
  write(input: KartInput, tilt: number | null): void;
  setVisible(visible: boolean): void;
  reset(): void;
  dispose(): void;
}

const OVERLAY_ID = "vibe-kart-touch";

/**
 * A thumb-sized control layout built out of DOM rather than drawn into the
 * canvas: it costs no draw calls, it scales with the device's own pixel ratio,
 * and it can use a backdrop blur that would be expensive to fake in GL.
 *
 * The left half is a floating stick — it materialises wherever the thumb lands
 * rather than living in a fixed corner, which is the difference between a
 * control that works one-handed on a phone and one that does not. The right
 * cluster is three targets, none smaller than 68 px, spaced so a thumb rolling
 * between accelerate and drift never lands between them.
 *
 * Tagged `data-kart-hud` so the screenshot harness hides it with everything
 * else that is chrome rather than world.
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

  const accent = `#${PALETTE.accent.toString(16).padStart(6, "0")}`;
  const style = document.createElement("style");
  style.id = `${OVERLAY_ID}-style`;
  style.textContent = `
#${OVERLAY_ID}{position:fixed;inset:0;z-index:24;pointer-events:none;display:none;
  touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;
  font:600 13px/1 ui-rounded,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase}
#${OVERLAY_ID}.on{display:block}
#${OVERLAY_ID} .zone{position:absolute;top:0;bottom:0;left:0;width:46%;pointer-events:auto}
#${OVERLAY_ID} .base,#${OVERLAY_ID} .knob{position:absolute;border-radius:50%;
  transform:translate(-50%,-50%);opacity:0;transition:opacity .18s ease}
#${OVERLAY_ID} .base{width:132px;height:132px;background:rgba(255,255,255,.10);
  border:2px solid rgba(255,255,255,.34);box-shadow:0 8px 26px rgba(0,0,0,.32) inset,0 2px 10px rgba(0,0,0,.25)}
#${OVERLAY_ID} .knob{width:64px;height:64px;background:radial-gradient(circle at 34% 30%,
  rgba(255,255,255,.96),rgba(255,255,255,.62));box-shadow:0 4px 14px rgba(0,0,0,.38)}
#${OVERLAY_ID} .base.live,#${OVERLAY_ID} .knob.live{opacity:1}
#${OVERLAY_ID} .btn{position:absolute;pointer-events:auto;border-radius:50%;display:grid;place-items:center;
  color:rgba(12,18,30,.82);background:linear-gradient(180deg,rgba(255,255,255,.90),rgba(232,238,246,.72));
  border:2px solid rgba(255,255,255,.75);box-shadow:0 6px 18px rgba(0,0,0,.34);
  transition:transform .09s ease,filter .09s ease}
#${OVERLAY_ID} .btn.down{transform:scale(.93);filter:brightness(.88)}
#${OVERLAY_ID} .go{right:22px;bottom:26px;width:104px;height:104px;font-size:15px;
  background:linear-gradient(180deg,${accent},#e5a413);color:rgba(38,26,0,.86);
  border-color:rgba(255,242,200,.85)}
#${OVERLAY_ID} .dr{right:138px;bottom:52px;width:88px;height:88px}
#${OVERLAY_ID} .it{right:34px;bottom:150px;width:78px;height:78px}
#${OVERLAY_ID} .bk{right:150px;bottom:154px;width:68px;height:68px;font-size:11px}
@media (max-height:460px){#${OVERLAY_ID} .go{width:88px;height:88px}#${OVERLAY_ID} .dr{width:76px;height:76px;right:118px}}
`;

  const root = document.createElement("div");
  root.id = OVERLAY_ID;
  root.setAttribute("data-kart-hud", "touch");
  root.innerHTML =
    '<div class="zone"></div><div class="base"></div><div class="knob"></div>' +
    '<div class="btn go">Go</div><div class="btn dr">Drift</div>' +
    '<div class="btn it">Item</div><div class="btn bk">Brake</div>';

  const zone = root.querySelector(".zone") as HTMLDivElement;
  const base = root.querySelector(".base") as HTMLDivElement;
  const knob = root.querySelector(".knob") as HTMLDivElement;
  const goBtn = root.querySelector(".go") as HTMLDivElement;
  const driftBtn = root.querySelector(".dr") as HTMLDivElement;
  const itemBtn = root.querySelector(".it") as HTMLDivElement;
  const brakeBtn = root.querySelector(".bk") as HTMLDivElement;

  /** Stick travel in CSS pixels for full lock. */
  const THROW = 54;

  let stickId: number | null = null;
  let originX = 0;
  let originY = 0;
  let steer = 0;
  let accel = false;
  let brake = false;
  let drift = false;
  const buttonIds = new Map<number, HTMLDivElement>();
  let hooks: TouchHooks | null = null;
  let inputRef: KartInput | null = null;
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
    zone.setPointerCapture?.(e.pointerId);
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
    steer = clamp(dx / THROW, -1, 1);
    // Pulling the thumb down is the brake, so one thumb can do everything.
    brake = dy > THROW * 0.75;
    e.preventDefault();
  };

  const onZoneUp = (e: PointerEvent) => {
    if (e.pointerId !== stickId) return;
    zone.releasePointerCapture?.(e.pointerId);
    stickId = null;
    steer = 0;
    brake = false;
    base.classList.remove("live");
    knob.classList.remove("live");
  };

  function bindButton(el: HTMLDivElement, onDown: () => void, onUp?: () => void): void {
    el.addEventListener(
      "pointerdown",
      (e) => {
        hooks?.onFirstTouch();
        buttonIds.set(e.pointerId, el);
        el.classList.add("down");
        el.setPointerCapture?.(e.pointerId);
        onDown();
        e.preventDefault();
      },
      { passive: false },
    );
    const release = (e: PointerEvent) => {
      if (buttonIds.get(e.pointerId) !== el) return;
      buttonIds.delete(e.pointerId);
      el.classList.remove("down");
      onUp?.();
    };
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    el.addEventListener("pointerleave", release);
  }

  const overlay: TouchOverlay = {
    attach(canvas, input, h) {
      if (attached) return;
      attached = true;
      hooks = h;
      inputRef = input;
      document.head.appendChild(style);
      document.body.appendChild(root);

      zone.addEventListener("pointerdown", onZoneDown, { passive: false });
      zone.addEventListener("pointermove", onZoneMove, { passive: false });
      zone.addEventListener("pointerup", onZoneUp);
      zone.addEventListener("pointercancel", onZoneUp);

      bindButton(
        goBtn,
        () => {
          accel = true;
        },
        () => {
          accel = false;
        },
      );
      bindButton(
        driftBtn,
        () => {
          drift = true;
          if (!inputRef) return;
          // Same rule as every other device: in the air the drift button tricks.
          if (hooks?.airborne()) inputRef.trick = steer < -0.3 ? -1 : 1;
          else inputRef.driftPressed = true;
        },
        () => {
          drift = false;
        },
      );
      bindButton(itemBtn, () => {
        if (inputRef) inputRef.itemPressed = true;
      });
      bindButton(
        brakeBtn,
        () => {
          brake = true;
        },
        () => {
          brake = false;
        },
      );

      // A coarse pointer is a strong hint, but the overlay only actually shows
      // once a finger has touched something — a laptop with a touchscreen
      // should not get a joystick over its window.
      canvas.addEventListener(
        "pointerdown",
        (e) => {
          if (e.pointerType === "touch") h.onFirstTouch();
        },
        { passive: true },
      );
    },

    write(input, tilt) {
      input.touch = true;
      input.steer = tilt !== null ? tilt : steer;
      input.accel = accel ? 1 : 0;
      input.brake = brake ? 1 : 0;
      input.drift = drift;
      input.aimBack = brake;
      input.lookBack = false;
    },

    setVisible(visible) {
      root.classList.toggle("on", visible);
    },

    reset() {
      stickId = null;
      steer = 0;
      accel = false;
      brake = false;
      drift = false;
      buttonIds.clear();
      base.classList.remove("live");
      knob.classList.remove("live");
      for (const el of [goBtn, driftBtn, itemBtn, brakeBtn]) el.classList.remove("down");
    },

    dispose() {
      overlay.reset();
      zone.removeEventListener("pointerdown", onZoneDown);
      zone.removeEventListener("pointermove", onZoneMove);
      zone.removeEventListener("pointerup", onZoneUp);
      zone.removeEventListener("pointercancel", onZoneUp);
      root.remove();
      style.remove();
      attached = false;
      hooks = null;
      inputRef = null;
    },
  };

  return overlay;
}
