/**
 * input.ts — the single input layer for San Francisco: FREE FALL.
 *
 * Three very different devices have to produce the *same* per-frame action
 * snapshot, because nothing downstream of here is allowed to know whether the
 * player is on a desk, a couch or a phone. Gameplay asks `input.held("jump")`
 * and `input.snapshot.moveX`; it never sees a KeyboardEvent, a Gamepad or a
 * PointerEvent, and it never subscribes to anything. That is the whole point:
 * a controller that reads DOM events directly ends up with input latency that
 * varies with frame rate, and with rebinding that is impossible to add later.
 *
 * Decisions worth explaining, because they are the ones that make or break
 * how a shooter feels in the hand:
 *
 *  • **Mouse deltas are raw and unaccelerated by default.** `movementX` is
 *    already device-space; multiplying it by dt (a mistake in roughly half of
 *    all browser FPS code) makes aim speed depend on frame rate. Acceleration
 *    exists as an option because some players want it, and is OFF.
 *
 *  • **Gamepad look is rate-based, mouse look is delta-based.** A stick is a
 *    velocity input; a mouse is a position input. Treating a stick as a delta
 *    gives you the classic "turns faster on a 144 Hz monitor" bug, so stick
 *    look is integrated against dt and mouse look is not.
 *
 *  • **Radial deadzone, not per-axis.** Per-axis deadzones make diagonals
 *    snap to the cardinal directions near the centre, which is why so many
 *    browser games feel like they have eight-way movement.
 *
 *  • **A tap shorter than one frame still registers.** Keys pressed and
 *    released inside the same frame set a sticky "pressed this frame" bit that
 *    is only cleared in `endFrame()`. At 30 fps on a phone that matters.
 *
 *  • **Touch sticks anchor where the thumb lands** (carried over from the
 *    interim Explorer camera), the look area is the whole right half rather
 *    than a postage-stamp pad, and the action cluster is built as plain DOM by
 *    this module — the HUD should not have to own the controls.
 *
 * Public API
 * ----------
 *   input                       the singleton InputManager
 *   input.attach(canvas) / detach()
 *   input.update(dt)            call once at the top of the player frame
 *   input.endFrame()            call once at the bottom
 *   input.snapshot              the per-frame action snapshot
 *   input.held/pressed/released/analog(action)
 *   input.rumble(ms, weak, strong)
 *   input.bind(action, tokens)  rebinding; tokens are "KeyW" | "Mouse0" | "Pad4"
 *   ACTIONS, ActionName, DEFAULT_BINDINGS
 */
import { PLAYER } from "../config";
import { clamp, clamp01 } from "../math/rng";

/* ------------------------------------------------------------------ *
 * Action vocabulary
 * ------------------------------------------------------------------ */

/**
 * Every discrete thing the player can ask for. Movement axes are *not* here —
 * they are analog and live on the snapshot — but the four direction keys are,
 * because on a keyboard they are buttons and they must be rebindable.
 */
export const ACTIONS = [
  "moveForward",
  "moveBack",
  "moveLeft",
  "moveRight",
  "jump",
  "sprint",
  "crouch",
  /** Fire the hook at the crosshair. Hold after it bites to reel. */
  "grapple",
  /** Two-shot object↔object tether — the Just Cause signature. */
  "tetherLink",
  /** Explicit reel, for players who do not want a press-and-hold. */
  "reel",
  /** Release every tether (with a swing boost if you time it). */
  "cut",
  "wingsuit",
  "parachute",
  "boost",
  "flare",
  "fire",
  "aim",
  "reload",
  "melee",
  "interact",
  "inspect",
  "nextWeapon",
  "prevWeapon",
  "pause",
  "map",
  "hud",
] as const;

export type ActionName = (typeof ACTIONS)[number];

export const ACTION_COUNT = ACTIONS.length;

/** action name → dense index into the held/pressed/analog arrays. */
export const ACTION_INDEX: Record<ActionName, number> = (() => {
  const m = {} as Record<ActionName, number>;
  for (let i = 0; i < ACTIONS.length; i++) m[ACTIONS[i]] = i;
  return m;
})();

/**
 * Binding tokens:
 *   "KeyW", "Space", "ShiftLeft", …   KeyboardEvent.code
 *   "Mouse0" | "Mouse1" | "Mouse2"    left / middle / right
 *   "Wheel+" | "Wheel-"               one notch of scroll
 *   "Pad0" … "Pad15"                  standard-mapping gamepad buttons
 *   "PadLT" | "PadRT"                 analog triggers (also readable via analog())
 */
export type BindingToken = string;

export type Bindings = Record<ActionName, BindingToken[]>;

/**
 * Defaults. The traversal verbs sit under the left hand because in this game
 * you will use them far more than you use the trigger: grapple on E and middle
 * mouse, link on Q, cut on X, wingsuit chained onto Space.
 */
export const DEFAULT_BINDINGS: Bindings = {
  moveForward: ["KeyW", "ArrowUp"],
  moveBack: ["KeyS", "ArrowDown"],
  moveLeft: ["KeyA", "ArrowLeft"],
  moveRight: ["KeyD", "ArrowRight"],
  jump: ["Space", "Pad0"],
  sprint: ["ShiftLeft", "ShiftRight", "Pad10"],
  crouch: ["ControlLeft", "KeyC", "Pad1"],
  grapple: ["KeyE", "Mouse1", "Pad4"],
  tetherLink: ["KeyQ", "Pad5"],
  reel: ["KeyG"],
  cut: ["KeyX", "Pad2"],
  wingsuit: ["KeyV"],
  parachute: ["KeyB"],
  boost: ["ShiftLeft", "ShiftRight", "Pad10"],
  flare: ["ControlLeft", "PadLT"],
  fire: ["Mouse0", "PadRT"],
  aim: ["Mouse2", "PadLT"],
  reload: ["KeyR", "Pad3"],
  melee: ["KeyF", "Pad11"],
  interact: ["KeyF", "Pad3"],
  inspect: ["KeyH", "Pad12"],
  nextWeapon: ["Wheel+", "Pad15"],
  prevWeapon: ["Wheel-", "Pad14"],
  pause: ["Escape", "Pad9"],
  map: ["KeyM", "Pad8"],
  hud: ["KeyU"],
};

/* ------------------------------------------------------------------ *
 * Snapshot
 * ------------------------------------------------------------------ */

export type InputDevice = "kbm" | "gamepad" | "touch";

/**
 * What one frame of intent looks like. Read it; do not keep a reference to
 * the typed arrays across frames — they are reused.
 */
export interface ActionSnapshot {
  /** -1..1 strafe. +1 is right. */
  moveX: number;
  /** -1..1 forward. +1 is forward (away from the camera). */
  moveZ: number;
  /** Radians to ADD to `frame.yaw` this frame. Already sign-corrected. */
  lookYaw: number;
  /** Radians to ADD to `frame.pitch` this frame. */
  lookPitch: number;
  /** Notches of wheel this frame, +up. */
  wheel: number;
  /** Whichever device produced input most recently — drives HUD glyphs. */
  device: InputDevice;
  pointerLocked: boolean;
  /** True while the player is actually able to control the game. */
  focused: boolean;
  /** 1 while held. */
  held: Uint8Array;
  /** 1 on the frame the action went down. */
  pressed: Uint8Array;
  /** 1 on the frame the action came up. */
  released: Uint8Array;
  /** 0..1 for triggers; 0/1 for digital sources. */
  analog: Float32Array;
}

export interface InputOptions {
  /** Radians per mouse pixel. */
  sensitivity: number;
  /** Multiplier applied while aiming down sights. */
  adsSensitivityScale: number;
  /** Mouse acceleration. OFF by default and it should stay that way. */
  acceleration: boolean;
  /** How much acceleration, when enabled. 0.4 is already a lot. */
  accelerationAmount: number;
  invertY: boolean;
  /** Stick look rate, radians/second at full deflection. */
  padLookRate: number;
  /** Stick look response exponent. 1 = linear, 2.2 is a good shooter default. */
  padLookExponent: number;
  /** Radial deadzone, 0..1. */
  padDeadzone: number;
  /** Beyond this the stick reads as fully deflected. */
  padSaturation: number;
  /** Analog trigger threshold at which a trigger counts as "held". */
  triggerThreshold: number;
  /** Master rumble scale, 0 disables. */
  rumble: number;
  /** Touch look sensitivity, radians per CSS pixel. */
  touchSensitivity: number;
}

const DEFAULT_OPTIONS: InputOptions = {
  sensitivity: PLAYER.mouseSensitivity,
  adsSensitivityScale: 0.62,
  acceleration: false,
  accelerationAmount: 0.35,
  invertY: false,
  padLookRate: 3.1,
  padLookExponent: 2.2,
  padDeadzone: 0.16,
  padSaturation: 0.94,
  triggerThreshold: 0.42,
  rumble: 1,
  touchSensitivity: 0.0042,
};

/* ------------------------------------------------------------------ *
 * Touch overlay layout
 * ------------------------------------------------------------------ */

/**
 * The on-screen cluster. `slot` is a stable id so the controller can relabel a
 * button as the traversal state changes ("WINGSUIT" → "CHUTE" → "CUT") without
 * knowing anything about the DOM.
 */
interface TouchButtonSpec {
  slot: string;
  action: ActionName;
  label: string;
  /** Grid cell within the cluster; x grows left, y grows up from the corner. */
  gx: number;
  gy: number;
  size: number;
  accent?: boolean;
}

const TOUCH_BUTTONS: TouchButtonSpec[] = [
  { slot: "jump", action: "jump", label: "JUMP", gx: 0, gy: 0, size: 82, accent: true },
  { slot: "grapple", action: "grapple", label: "HOOK", gx: 1, gy: 0.55, size: 74 },
  { slot: "link", action: "tetherLink", label: "LINK", gx: 2, gy: 1.05, size: 62 },
  { slot: "cut", action: "cut", label: "CUT", gx: 0.15, gy: 1.1, size: 62 },
  { slot: "fire", action: "fire", label: "FIRE", gx: 1.15, gy: 1.65, size: 68 },
  { slot: "boost", action: "boost", label: "BOOST", gx: 2.1, gy: 2.15, size: 58 },
  { slot: "crouch", action: "crouch", label: "DUCK", gx: 0.3, gy: 2.2, size: 58 },
];

/* ------------------------------------------------------------------ *
 * The manager
 * ------------------------------------------------------------------ */

class InputManager {
  readonly options: InputOptions = { ...DEFAULT_OPTIONS };

  readonly snapshot: ActionSnapshot = {
    moveX: 0,
    moveZ: 0,
    lookYaw: 0,
    lookPitch: 0,
    wheel: 0,
    device: "kbm",
    pointerLocked: false,
    focused: true,
    held: new Uint8Array(ACTION_COUNT),
    pressed: new Uint8Array(ACTION_COUNT),
    released: new Uint8Array(ACTION_COUNT),
    analog: new Float32Array(ACTION_COUNT),
  };

  private bindings: Bindings = cloneBindings(DEFAULT_BINDINGS);
  /** token → action indices. Rebuilt whenever a binding changes. */
  private tokenMap = new Map<BindingToken, number[]>();

  private prevHeld = new Uint8Array(ACTION_COUNT);
  /** Tokens currently down (keyboard + mouse). */
  private tokensDown = new Set<BindingToken>();
  /** Tokens that went down since the last endFrame — survives sub-frame taps. */
  private tokensTapped = new Set<BindingToken>();
  /** Analog value per token, for triggers. */
  private tokenAnalog = new Map<BindingToken, number>();

  /** Accumulated raw mouse pixels, drained by update(). */
  private mouseDX = 0;
  private mouseDY = 0;
  private wheelAcc = 0;

  /* ---- touch ---- */
  private touchMoveId = -1;
  private touchMoveOx = 0;
  private touchMoveOy = 0;
  private touchMoveX = 0;
  private touchMoveY = 0;
  private touchLookId = -1;
  private touchLookX = 0;
  private touchLookY = 0;
  private touchHeld = new Set<ActionName>();
  private touchTapped = new Set<ActionName>();
  private touchRoot: HTMLDivElement | null = null;
  private touchKnob: HTMLDivElement | null = null;
  private touchBase: HTMLDivElement | null = null;
  private touchButtonEls = new Map<string, HTMLDivElement>();
  /** True on phones/tablets; drives whether the overlay exists at all. */
  isTouch = false;

  /* ---- gamepad ---- */
  private padIndex = -1;
  private padHeld = new Uint8Array(ACTION_COUNT);
  private padTapped = new Uint8Array(ACTION_COUNT);
  private padMoveX = 0;
  private padMoveY = 0;
  private padLookX = 0;
  private padLookY = 0;
  private rumbleUntil = 0;

  private canvas: HTMLCanvasElement | null = null;
  private detachers: (() => void)[] = [];
  /** Suppress input while a menu owns the keyboard. */
  enabled = true;

  constructor() {
    this.rebuildTokenMap();
  }

  /* ---------------- binding ---------------- */

  /** Replace the tokens bound to an action. Pass [] to unbind. */
  bind(action: ActionName, tokens: BindingToken[]): void {
    this.bindings[action] = tokens.slice();
    this.rebuildTokenMap();
  }

  /** Current bindings, cloned — mutating the result does nothing. */
  getBindings(): Bindings {
    return cloneBindings(this.bindings);
  }

  /** Bulk restore, e.g. from a settings blob. Unknown actions are ignored. */
  setBindings(b: Partial<Bindings>): void {
    for (const k of ACTIONS) if (b[k]) this.bindings[k] = b[k]!.slice();
    this.rebuildTokenMap();
  }

  resetBindings(): void {
    this.bindings = cloneBindings(DEFAULT_BINDINGS);
    this.rebuildTokenMap();
  }

  private rebuildTokenMap(): void {
    this.tokenMap.clear();
    for (let i = 0; i < ACTIONS.length; i++) {
      for (const tok of this.bindings[ACTIONS[i]]) {
        let list = this.tokenMap.get(tok);
        if (!list) this.tokenMap.set(tok, (list = []));
        list.push(i);
      }
    }
  }

  /* ---------------- queries ---------------- */

  held(a: ActionName): boolean {
    return this.snapshot.held[ACTION_INDEX[a]] !== 0;
  }
  pressed(a: ActionName): boolean {
    return this.snapshot.pressed[ACTION_INDEX[a]] !== 0;
  }
  released(a: ActionName): boolean {
    return this.snapshot.released[ACTION_INDEX[a]] !== 0;
  }
  analog(a: ActionName): number {
    return this.snapshot.analog[ACTION_INDEX[a]];
  }

  /** Consume a press so two systems cannot both act on the same tap. */
  consume(a: ActionName): void {
    this.snapshot.pressed[ACTION_INDEX[a]] = 0;
  }

  /* ---------------- lifecycle ---------------- */

  attach(canvas: HTMLCanvasElement): void {
    if (this.canvas === canvas) return;
    this.detach();
    if (typeof window === "undefined") return;
    this.canvas = canvas;
    this.isTouch =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;

    const on = <K extends keyof WindowEventMap>(
      target: EventTarget,
      type: K | string,
      fn: (e: never) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type as string, fn as EventListener, opts);
      this.detachers.push(() =>
        target.removeEventListener(type as string, fn as EventListener, opts),
      );
    };

    /* ---- keyboard ---- */
    on(window, "keydown", (e: KeyboardEvent) => {
      if (e.repeat) return;
      this.snapshot.device = "kbm";
      this.tokensDown.add(e.code);
      this.tokensTapped.add(e.code);
      // A game canvas must not let the page scroll out from under it, and
      // must not let '/' open quick-find in some browsers.
      if (SWALLOW_KEYS.has(e.code)) e.preventDefault();
    });
    on(window, "keyup", (e: KeyboardEvent) => {
      this.tokensDown.delete(e.code);
    });
    // Losing focus mid-sprint must not leave Shift stuck down forever.
    on(window, "blur", () => this.releaseAll());
    on(document, "visibilitychange", () => {
      if (document.hidden) this.releaseAll();
    });

    /* ---- mouse ---- */
    on(canvas, "mousedown", (e: MouseEvent) => {
      this.snapshot.device = "kbm";
      const tok = `Mouse${e.button}`;
      this.tokensDown.add(tok);
      this.tokensTapped.add(tok);
      if (e.button === 1) e.preventDefault(); // middle-click autoscroll
    });
    on(window, "mouseup", (e: MouseEvent) => {
      this.tokensDown.delete(`Mouse${e.button}`);
    });
    on(canvas, "contextmenu", (e: Event) => e.preventDefault());
    on(window, "mousemove", (e: MouseEvent) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.snapshot.device = "kbm";
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    on(
      canvas,
      "wheel",
      (e: WheelEvent) => {
        this.wheelAcc += e.deltaY > 0 ? -1 : 1;
        e.preventDefault();
      },
      { passive: false },
    );

    /* ---- pointer lock ---- */
    on(canvas, "click", () => {
      if (this.isTouch || !this.enabled) return;
      if (document.pointerLockElement !== canvas) {
        // Chrome rejects an unadorned request during the exit cooldown; the
        // promise rejection is expected and must not surface as an error.
        const p = canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    });
    on(document, "pointerlockchange", () => {
      this.snapshot.pointerLocked = document.pointerLockElement === canvas;
      if (!this.snapshot.pointerLocked) this.releaseAll();
    });

    /* ---- gamepad ---- */
    on(window, "gamepadconnected", (e: GamepadEvent) => {
      this.padIndex = e.gamepad.index;
    });
    on(window, "gamepaddisconnected", (e: GamepadEvent) => {
      if (this.padIndex === e.gamepad.index) {
        this.padIndex = -1;
        this.padHeld.fill(0);
      }
    });

    /* ---- touch ---- */
    if (this.isTouch) {
      this.buildTouchOverlay(canvas);
      on(canvas, "pointerdown", (e: PointerEvent) => this.onTouchDown(e, canvas));
      on(canvas, "pointermove", (e: PointerEvent) => this.onTouchMove(e, canvas));
      on(canvas, "pointerup", (e: PointerEvent) => this.onTouchUp(e));
      on(canvas, "pointercancel", (e: PointerEvent) => this.onTouchUp(e));
      const swallow = (e: Event) => e.preventDefault();
      on(canvas, "touchstart", swallow, { passive: false } as AddEventListenerOptions);
      on(canvas, "touchmove", swallow, { passive: false } as AddEventListenerOptions);
      canvas.style.touchAction = "none";
    }
  }

  detach(): void {
    for (const d of this.detachers) d();
    this.detachers.length = 0;
    this.destroyTouchOverlay();
    if (typeof document !== "undefined" && document.pointerLockElement === this.canvas) {
      document.exitPointerLock?.();
    }
    this.canvas = null;
    this.releaseAll();
  }

  private releaseAll(): void {
    this.tokensDown.clear();
    this.touchHeld.clear();
    this.padHeld.fill(0);
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.touchMoveX = 0;
    this.touchMoveY = 0;
    this.touchMoveId = -1;
    this.touchLookId = -1;
    if (this.touchBase) this.touchBase.style.opacity = "0";
  }

  /* ---------------- per-frame ---------------- */

  /**
   * Fold every device into the snapshot. Call exactly once per frame, before
   * anything reads it.
   */
  update(dt: number, adsBlend = 0): void {
    const s = this.snapshot;
    s.pressed.fill(0);
    s.released.fill(0);
    s.analog.fill(0);
    this.prevHeld.set(s.held);
    s.held.fill(0);

    if (!this.enabled) {
      s.moveX = 0;
      s.moveZ = 0;
      s.lookYaw = 0;
      s.lookPitch = 0;
      s.wheel = 0;
      s.focused = false;
      this.mouseDX = 0;
      this.mouseDY = 0;
      return;
    }
    s.focused = true;

    this.pollGamepad(dt);

    /* ---- digital state from tokens ---- */
    for (const tok of this.tokensDown) this.applyToken(tok, 1);
    for (const tok of this.tokensTapped) this.applyToken(tok, 1);
    for (const [tok, v] of this.tokenAnalog) if (v > 0) this.applyToken(tok, v);
    if (this.wheelAcc > 0) this.applyToken("Wheel+", 1);
    if (this.wheelAcc < 0) this.applyToken("Wheel-", 1);

    /* ---- gamepad digital ---- */
    for (let i = 0; i < ACTION_COUNT; i++) {
      if (this.padHeld[i] || this.padTapped[i]) s.held[i] = 1;
    }

    /* ---- touch digital ---- */
    for (const a of this.touchHeld) s.held[ACTION_INDEX[a]] = 1;
    for (const a of this.touchTapped) s.held[ACTION_INDEX[a]] = 1;

    /* ---- edges ---- */
    for (let i = 0; i < ACTION_COUNT; i++) {
      if (s.held[i] && !this.prevHeld[i]) s.pressed[i] = 1;
      else if (!s.held[i] && this.prevHeld[i]) s.released[i] = 1;
      if (s.analog[i] === 0 && s.held[i]) s.analog[i] = 1;
    }

    /* ---- movement axes ---- */
    let mx = 0;
    let mz = 0;
    if (s.held[ACTION_INDEX.moveForward]) mz += 1;
    if (s.held[ACTION_INDEX.moveBack]) mz -= 1;
    if (s.held[ACTION_INDEX.moveRight]) mx += 1;
    if (s.held[ACTION_INDEX.moveLeft]) mx -= 1;
    mx += this.padMoveX + this.touchMoveX;
    mz += this.padMoveY + this.touchMoveY;
    const mag = Math.hypot(mx, mz);
    if (mag > 1) {
      mx /= mag;
      mz /= mag;
    }
    s.moveX = mx;
    s.moveZ = mz;

    /* ---- look ---- */
    // ADS scaling belongs here rather than in the camera so that every
    // device shrinks by the same proportion.
    const sens = this.options.sensitivity * (1 - adsBlend * (1 - this.options.adsSensitivityScale));
    let dx = this.mouseDX;
    let dy = this.mouseDY;
    if (this.options.acceleration && (dx !== 0 || dy !== 0)) {
      // Acceleration measured against a 900 px/s reference sweep, so the curve
      // does not change meaning when the frame rate does.
      const speed = Math.hypot(dx, dy) / Math.max(dt, 1e-4);
      const boost = 1 + this.options.accelerationAmount * clamp01(speed / 900);
      dx *= boost;
      dy *= boost;
    }
    const invY = this.options.invertY ? -1 : 1;
    let yaw = -dx * sens;
    let pitch = -dy * sens * invY;

    // Touch look is a delta like the mouse, but in CSS pixels on a screen the
    // player is holding, so it gets its own sensitivity.
    const tsens = this.options.touchSensitivity * (1 - adsBlend * 0.4);
    yaw += -this.touchLookX * tsens;
    pitch += -this.touchLookY * tsens * invY;

    // Stick look is a *rate*: integrate it, or turning speed tracks fps.
    const padScale =
      this.options.padLookRate * dt * (1 - adsBlend * (1 - this.options.adsSensitivityScale));
    yaw += -this.padLookX * padScale;
    pitch += -this.padLookY * padScale * invY;

    s.lookYaw = yaw;
    s.lookPitch = pitch;
    s.wheel = this.wheelAcc;
  }

  /** Clear per-frame accumulators. Call once at the end of the player frame. */
  endFrame(): void {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.touchLookX = 0;
    this.touchLookY = 0;
    this.wheelAcc = 0;
    this.tokensTapped.clear();
    this.touchTapped.clear();
    this.padTapped.fill(0);
  }

  private applyToken(tok: BindingToken, value: number): void {
    const list = this.tokenMap.get(tok);
    if (!list) return;
    const s = this.snapshot;
    for (let i = 0; i < list.length; i++) {
      const idx = list[i];
      s.held[idx] = 1;
      if (value > s.analog[idx]) s.analog[idx] = value;
    }
  }

  /* ---------------- gamepad ---------------- */

  private pollGamepad(dt: number): void {
    if (typeof navigator === "undefined" || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    let pad: Gamepad | null = this.padIndex >= 0 ? pads[this.padIndex] : null;
    if (!pad) {
      for (let i = 0; i < pads.length; i++) {
        if (pads[i] && pads[i]!.connected) {
          pad = pads[i];
          this.padIndex = i;
          break;
        }
      }
    }
    this.padMoveX = 0;
    this.padMoveY = 0;
    this.padLookX = 0;
    this.padLookY = 0;
    const prev = this.padHeld;
    const next = _padScratch;
    next.fill(0);
    if (!pad) {
      prev.fill(0);
      return;
    }

    let active = false;

    /* sticks — radial deadzone, then an expo curve for fine aim */
    const lx = pad.axes[0] ?? 0;
    const ly = pad.axes[1] ?? 0;
    const rx = pad.axes[2] ?? 0;
    const ry = pad.axes[3] ?? 0;
    const move = this.applyStick(lx, ly, 1);
    this.padMoveX = move.x;
    // Pushing the stick forward is -Y in the standard mapping; forward is +Z
    // in our snapshot.
    this.padMoveY = -move.y;
    const look = this.applyStick(rx, ry, this.options.padLookExponent);
    this.padLookX = look.x;
    this.padLookY = look.y;
    if (move.mag > 0 || look.mag > 0) active = true;

    /* buttons */
    const btns = pad.buttons;
    for (let b = 0; b < btns.length && b < 16; b++) {
      const bt = btns[b];
      if (!bt) continue;
      const down = bt.pressed || bt.value > this.options.triggerThreshold;
      if (!down) continue;
      active = true;
      const list = this.tokenMap.get(`Pad${b}`);
      if (list) for (const idx of list) next[idx] = 1;
    }
    /* analog triggers get their own tokens so a half-pull can drive a flare */
    const lt = btns[6]?.value ?? 0;
    const rt = btns[7]?.value ?? 0;
    this.tokenAnalog.set("PadLT", lt);
    this.tokenAnalog.set("PadRT", rt);
    if (lt > this.options.triggerThreshold) {
      const list = this.tokenMap.get("PadLT");
      if (list) for (const idx of list) next[idx] = 1;
    }
    if (rt > this.options.triggerThreshold) {
      const list = this.tokenMap.get("PadRT");
      if (list) for (const idx of list) next[idx] = 1;
    }

    for (let i = 0; i < ACTION_COUNT; i++) {
      if (next[i] && !prev[i]) this.padTapped[i] = 1;
    }
    prev.set(next);

    if (active) this.snapshot.device = "gamepad";

    if (this.rumbleUntil > 0) {
      this.rumbleUntil -= dt;
      if (this.rumbleUntil <= 0) this.rumbleUntil = 0;
    }
  }

  private applyStick(x: number, y: number, exponent: number): { x: number; y: number; mag: number } {
    const o = this.options;
    const raw = Math.hypot(x, y);
    if (raw < o.padDeadzone) {
      _stick.x = 0;
      _stick.y = 0;
      _stick.mag = 0;
      return _stick;
    }
    // Rescale so the deadzone edge is 0 and `saturation` is 1 — without this
    // the stick loses its top 6% of travel to hardware slop.
    const t = clamp01((raw - o.padDeadzone) / Math.max(1e-4, o.padSaturation - o.padDeadzone));
    const shaped = exponent === 1 ? t : Math.pow(t, exponent);
    const inv = shaped / raw;
    _stick.x = x * inv;
    _stick.y = y * inv;
    _stick.mag = shaped;
    return _stick;
  }

  /**
   * Fire the pad's haptics. `weak`/`strong` are 0..1; duration in ms.
   * Silently no-ops when there is no pad or no actuator, which is most of the
   * time, so callers should not bother checking.
   */
  rumble(ms: number, weak: number, strong: number): void {
    if (this.options.rumble <= 0 || this.padIndex < 0) return;
    if (typeof navigator === "undefined" || !navigator.getGamepads) return;
    const pad = navigator.getGamepads()[this.padIndex];
    const act = (pad as unknown as { vibrationActuator?: GamepadHapticActuator })
      ?.vibrationActuator as
      | (GamepadHapticActuator & {
          playEffect?: (type: string, params: Record<string, number>) => Promise<unknown>;
        })
      | undefined;
    if (!act || typeof act.playEffect !== "function") return;
    const g = this.options.rumble;
    act
      .playEffect("dual-rumble", {
        duration: Math.max(16, ms),
        strongMagnitude: clamp01(strong * g),
        weakMagnitude: clamp01(weak * g),
      })
      .catch(() => {});
    this.rumbleUntil = ms / 1000;
  }

  /* ---------------- touch ---------------- */

  private onTouchDown(e: PointerEvent, canvas: HTMLCanvasElement): void {
    if (e.pointerType !== "touch") return;
    this.snapshot.device = "touch";
    const half = canvas.clientWidth * 0.5;
    if (e.clientX < half && this.touchMoveId === -1) {
      this.touchMoveId = e.pointerId;
      this.touchMoveOx = e.clientX;
      this.touchMoveOy = e.clientY;
      if (this.touchBase) {
        this.touchBase.style.opacity = "1";
        this.touchBase.style.left = `${e.clientX}px`;
        this.touchBase.style.top = `${e.clientY}px`;
      }
      if (this.touchKnob) {
        this.touchKnob.style.left = `${e.clientX}px`;
        this.touchKnob.style.top = `${e.clientY}px`;
      }
    } else if (e.clientX >= half && this.touchLookId === -1) {
      this.touchLookId = e.pointerId;
      this.touchLookX = 0;
      this.touchLookY = 0;
      _lastLook.x = e.clientX;
      _lastLook.y = e.clientY;
    }
  }

  private onTouchMove(e: PointerEvent, _canvas: HTMLCanvasElement): void {
    if (e.pointerType !== "touch") return;
    if (e.pointerId === this.touchMoveId) {
      // 64 px of travel is full deflection: about as far as a thumb travels
      // comfortably without the hand rolling off the phone.
      const dx = (e.clientX - this.touchMoveOx) / 64;
      const dy = (e.clientY - this.touchMoveOy) / 64;
      const mag = Math.hypot(dx, dy);
      const s = mag > 1 ? 1 / mag : 1;
      this.touchMoveX = dx * s;
      this.touchMoveY = -dy * s;
      if (this.touchKnob) {
        this.touchKnob.style.left = `${this.touchMoveOx + dx * s * 46}px`;
        this.touchKnob.style.top = `${this.touchMoveOy + dy * s * 46}px`;
      }
    } else if (e.pointerId === this.touchLookId) {
      this.touchLookX += e.clientX - _lastLook.x;
      this.touchLookY += e.clientY - _lastLook.y;
      _lastLook.x = e.clientX;
      _lastLook.y = e.clientY;
    }
  }

  private onTouchUp(e: PointerEvent): void {
    if (e.pointerId === this.touchMoveId) {
      this.touchMoveId = -1;
      this.touchMoveX = 0;
      this.touchMoveY = 0;
      if (this.touchBase) this.touchBase.style.opacity = "0";
    }
    if (e.pointerId === this.touchLookId) this.touchLookId = -1;
  }

  /**
   * Build the phone controls as plain DOM over the canvas.
   *
   * Deliberately not React: these have to respond on `pointerdown` with zero
   * scheduling latency, and re-rendering a component tree because a thumb
   * moved is exactly the pattern the rest of this codebase avoids.
   */
  private buildTouchOverlay(canvas: HTMLCanvasElement): void {
    if (typeof document === "undefined") return;
    const parent = canvas.parentElement ?? document.body;
    const root = document.createElement("div");
    root.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:30;user-select:none;-webkit-user-select:none;font:600 11px/1 ui-sans-serif,system-ui,sans-serif;";

    const base = document.createElement("div");
    base.style.cssText =
      "position:absolute;width:112px;height:112px;margin:-56px 0 0 -56px;border-radius:50%;" +
      "border:1.5px solid rgba(255,255,255,0.22);background:radial-gradient(circle,rgba(255,255,255,0.07),rgba(255,255,255,0));" +
      "opacity:0;transition:opacity .12s;pointer-events:none;";
    const knob = document.createElement("div");
    knob.style.cssText =
      "position:absolute;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;" +
      "background:rgba(255,255,255,0.16);border:1.5px solid rgba(255,255,255,0.34);pointer-events:none;";
    base.appendChild(knob);
    root.appendChild(base);

    const cluster = document.createElement("div");
    cluster.style.cssText =
      "position:absolute;right:max(18px,env(safe-area-inset-right));bottom:max(18px,env(safe-area-inset-bottom));width:250px;height:250px;pointer-events:none;";
    for (const spec of TOUCH_BUTTONS) {
      const el = document.createElement("div");
      const x = spec.gx * 78;
      const y = spec.gy * 62;
      el.textContent = spec.label;
      el.style.cssText =
        `position:absolute;right:${x}px;bottom:${y}px;width:${spec.size}px;height:${spec.size}px;` +
        "border-radius:50%;display:flex;align-items:center;justify-content:center;" +
        `color:${spec.accent ? "rgba(255,236,190,0.95)" : "rgba(255,255,255,0.82)"};` +
        `background:${spec.accent ? "rgba(255,176,64,0.16)" : "rgba(12,16,22,0.36)"};` +
        `border:1.5px solid ${spec.accent ? "rgba(255,196,110,0.5)" : "rgba(255,255,255,0.24)"};` +
        "backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);pointer-events:auto;" +
        "letter-spacing:.08em;transition:transform .07s,background .07s;touch-action:none;";
      const down = (ev: PointerEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.snapshot.device = "touch";
        this.touchHeld.add(spec.action);
        this.touchTapped.add(spec.action);
        el.style.transform = "scale(0.92)";
        el.style.background = "rgba(255,255,255,0.3)";
        (ev.target as Element).setPointerCapture?.(ev.pointerId);
      };
      const up = (ev: PointerEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.touchHeld.delete(spec.action);
        el.style.transform = "";
        el.style.background = spec.accent ? "rgba(255,176,64,0.16)" : "rgba(12,16,22,0.36)";
      };
      el.addEventListener("pointerdown", down);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
      el.addEventListener("pointerleave", up);
      cluster.appendChild(el);
      this.touchButtonEls.set(spec.slot, el);
    }
    root.appendChild(cluster);
    parent.appendChild(root);

    this.touchRoot = root;
    this.touchBase = base;
    this.touchKnob = knob;
  }

  private destroyTouchOverlay(): void {
    this.touchRoot?.remove();
    this.touchRoot = null;
    this.touchBase = null;
    this.touchKnob = null;
    this.touchButtonEls.clear();
  }

  /**
   * Relabel and rebind a touch button as the traversal state changes — the big
   * button reads JUMP on the ground, WINGSUIT in the air, CHUTE under canopy.
   * No-ops on desktop.
   */
  setTouchSlot(slot: string, label: string, action?: ActionName): void {
    const el = this.touchButtonEls.get(slot);
    if (!el) return;
    if (el.textContent !== label) el.textContent = label;
    if (action) {
      const spec = TOUCH_BUTTONS.find((b) => b.slot === slot);
      if (spec && spec.action !== action) {
        // Release the old action so it does not stick held under the new label.
        this.touchHeld.delete(spec.action);
        spec.action = action;
      }
    }
  }

  /** Show or hide the whole touch overlay (pause menus, cutscenes). */
  setTouchVisible(v: boolean): void {
    if (this.touchRoot) this.touchRoot.style.display = v ? "" : "none";
  }
}

/* ------------------------------------------------------------------ *
 * Module scratch — never allocate inside the frame
 * ------------------------------------------------------------------ */

const _padScratch = new Uint8Array(ACTION_COUNT);
const _stick = { x: 0, y: 0, mag: 0 };
const _lastLook = { x: 0, y: 0 };

const SWALLOW_KEYS = new Set([
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Tab",
  "Slash",
  "Quote",
]);

function cloneBindings(b: Bindings): Bindings {
  const out = {} as Bindings;
  for (const k of ACTIONS) out[k] = (b[k] ?? []).slice();
  return out;
}

/** Clamp helper re-exported so callers do not import two modules for it. */
export { clamp, clamp01 };

/** The one input manager. */
export const input = new InputManager();
export type { InputManager };
