import { isTouchDevice } from "./Settings";

/**
 * Unified input: KB+M with pointer lock on desktop, virtual sticks + gesture
 * look on touch, and gamepad. Consumers read the normalised `state` each frame
 * and never touch DOM events directly.
 */

export interface InputState {
  /** -1..1 strafe (right positive) */
  moveX: number;
  /** -1..1 forward (forward positive) */
  moveY: number;
  /** accumulated look delta in radians, consumed each frame */
  lookX: number;
  lookY: number;
  jump: boolean;
  jumpPressed: boolean;
  crouch: boolean;
  sprint: boolean;
  fire: boolean;
  firePressed: boolean;
  aim: boolean;
  reloadPressed: boolean;
  meleePressed: boolean;
  grenadePressed: boolean;
  interactPressed: boolean;
  swapPressed: boolean;
  flashlightPressed: boolean;
  pausePressed: boolean;
}

const BASE: InputState = {
  moveX: 0,
  moveY: 0,
  lookX: 0,
  lookY: 0,
  jump: false,
  jumpPressed: false,
  crouch: false,
  sprint: false,
  fire: false,
  firePressed: false,
  aim: false,
  reloadPressed: false,
  meleePressed: false,
  grenadePressed: false,
  interactPressed: false,
  swapPressed: false,
  flashlightPressed: false,
  pausePressed: false,
};

/** Touch UI writes into this; Input merges it with keyboard each frame. */
export interface TouchBridge {
  moveX: number;
  moveY: number;
  lookX: number;
  lookY: number;
  fire: boolean;
  aim: boolean;
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
  reload: boolean;
  melee: boolean;
  grenade: boolean;
  interact: boolean;
  swap: boolean;
}

export const touchBridge: TouchBridge = {
  moveX: 0,
  moveY: 0,
  lookX: 0,
  lookY: 0,
  fire: false,
  aim: false,
  jump: false,
  crouch: false,
  sprint: false,
  reload: false,
  melee: false,
  grenade: false,
  interact: false,
  swap: false,
};

export class Input {
  readonly state: InputState = { ...BASE };
  sensitivity = 1;
  invertY = false;
  locked = false;
  onLockChange?: (locked: boolean) => void;

  private keys = new Set<string>();
  private edge = new Set<string>();
  private el: HTMLElement;
  private disposers: Array<() => void> = [];
  private prevGamepadButtons: boolean[] = [];

  constructor(el: HTMLElement) {
    this.el = el;
    this.bind();
  }

  private bind(): void {
    const add = <K extends keyof WindowEventMap>(
      target: EventTarget,
      type: K | string,
      fn: (e: never) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type as string, fn as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type as string, fn as EventListener));
    };

    add(window, "keydown", (e: KeyboardEvent) => {
      if (e.repeat) return;
      const c = e.code;
      this.keys.add(c);
      this.edge.add(c);
      if (
        [
          "Space",
          "KeyW",
          "KeyA",
          "KeyS",
          "KeyD",
          "Tab",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
        ].includes(c)
      ) {
        e.preventDefault();
      }
    });

    add(window, "keyup", (e: KeyboardEvent) => this.keys.delete(e.code));
    add(window, "blur", () => {
      this.keys.clear();
      this.state.fire = false;
      this.state.aim = false;
    });

    add(this.el, "mousedown", (e: MouseEvent) => {
      if (!this.locked && !isTouchDevice()) return;
      if (e.button === 0) {
        this.state.fire = true;
        this.state.firePressed = true;
      }
      if (e.button === 2) this.state.aim = true;
    });

    add(window, "mouseup", (e: MouseEvent) => {
      if (e.button === 0) this.state.fire = false;
      if (e.button === 2) this.state.aim = false;
    });

    add(this.el, "contextmenu", (e: Event) => e.preventDefault());

    add(window, "mousemove", (e: MouseEvent) => {
      if (!this.locked) return;
      this.state.lookX += e.movementX * 0.0022 * this.sensitivity;
      this.state.lookY += e.movementY * 0.0022 * this.sensitivity * (this.invertY ? -1 : 1);
    });

    add(document, "pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) {
        this.state.fire = false;
        this.state.aim = false;
      }
      this.onLockChange?.(this.locked);
    });
  }

  requestLock(): void {
    if (isTouchDevice()) return;
    void this.el.requestPointerLock?.();
  }

  releaseLock(): void {
    if (document.pointerLockElement === this.el) document.exitPointerLock();
  }

  private pollGamepad(): void {
    const pads = navigator.getGamepads?.();
    if (!pads) return;
    const gp = Array.from(pads).find((p) => p && p.connected);
    if (!gp) return;

    const dz = (v: number) => (Math.abs(v) < 0.16 ? 0 : (v - Math.sign(v) * 0.16) / 0.84);
    this.state.moveX += dz(gp.axes[0] ?? 0);
    this.state.moveY += -dz(gp.axes[1] ?? 0);
    const lookScale = 0.045 * this.sensitivity;
    this.state.lookX += dz(gp.axes[2] ?? 0) * lookScale;
    this.state.lookY += dz(gp.axes[3] ?? 0) * lookScale * (this.invertY ? -1 : 1);

    const btn = (i: number) => gp.buttons[i]?.pressed ?? false;
    const pressed = (i: number) => btn(i) && !this.prevGamepadButtons[i];

    if (btn(7) || (gp.buttons[7]?.value ?? 0) > 0.3) this.state.fire = true;
    if (btn(6) || (gp.buttons[6]?.value ?? 0) > 0.3) this.state.aim = true;
    if (pressed(7)) this.state.firePressed = true;
    if (btn(0)) this.state.jump = true;
    if (pressed(0)) this.state.jumpPressed = true;
    if (btn(10)) this.state.sprint = true;
    if (btn(1)) this.state.crouch = true;
    if (pressed(2)) this.state.reloadPressed = true;
    if (pressed(3)) this.state.swapPressed = true;
    if (pressed(5)) this.state.grenadePressed = true;
    if (pressed(11)) this.state.meleePressed = true;
    if (pressed(9)) this.state.pausePressed = true;
    if (pressed(4)) this.state.interactPressed = true;

    this.prevGamepadButtons = gp.buttons.map((b) => b.pressed);
  }

  /** Call once per frame BEFORE systems read `state`. */
  update(): InputState {
    const s = this.state;
    const k = (c: string) => this.keys.has(c);
    const p = (c: string) => this.edge.has(c);

    s.moveX = (k("KeyD") || k("ArrowRight") ? 1 : 0) - (k("KeyA") || k("ArrowLeft") ? 1 : 0);
    s.moveY = (k("KeyW") || k("ArrowUp") ? 1 : 0) - (k("KeyS") || k("ArrowDown") ? 1 : 0);
    s.jump = k("Space");
    s.jumpPressed = p("Space");
    s.crouch = k("ControlLeft") || k("KeyC");
    s.sprint = k("ShiftLeft") || k("ShiftRight");
    s.reloadPressed = p("KeyR");
    s.meleePressed = p("KeyV") || p("KeyF");
    s.grenadePressed = p("KeyG") || p("KeyQ");
    s.interactPressed = p("KeyE");
    s.swapPressed = p("KeyX") || p("Digit1") || p("Digit2");
    s.flashlightPressed = p("KeyL");
    s.pausePressed = p("Escape") || p("KeyP");

    // Touch overlay contributions
    const t = touchBridge;
    s.moveX += t.moveX;
    s.moveY += t.moveY;
    s.lookX += t.lookX;
    s.lookY += t.lookY * (this.invertY ? -1 : 1);
    t.lookX = 0;
    t.lookY = 0;
    if (t.fire) {
      if (!s.fire) s.firePressed = true;
      s.fire = true;
    }
    if (t.aim) s.aim = true;
    if (t.jump) {
      s.jumpPressed = true;
      s.jump = true;
      t.jump = false;
    }
    if (t.crouch) s.crouch = true;
    if (t.sprint) s.sprint = true;
    if (t.reload) {
      s.reloadPressed = true;
      t.reload = false;
    }
    if (t.melee) {
      s.meleePressed = true;
      t.melee = false;
    }
    if (t.grenade) {
      s.grenadePressed = true;
      t.grenade = false;
    }
    if (t.interact) {
      s.interactPressed = true;
      t.interact = false;
    }
    if (t.swap) {
      s.swapPressed = true;
      t.swap = false;
    }

    this.pollGamepad();

    const len = Math.hypot(s.moveX, s.moveY);
    if (len > 1) {
      s.moveX /= len;
      s.moveY /= len;
    }

    this.edge.clear();
    return s;
  }

  /** Call after systems have consumed the frame's state. */
  endFrame(): void {
    const s = this.state;
    s.lookX = 0;
    s.lookY = 0;
    s.firePressed = false;
    s.jumpPressed = false;
    s.reloadPressed = false;
    s.meleePressed = false;
    s.grenadePressed = false;
    s.interactPressed = false;
    s.swapPressed = false;
    s.flashlightPressed = false;
    s.pausePressed = false;
    if (!touchBridge.fire && !this.mouseHeld()) s.fire = this.mouseHeld();
  }

  private mouseHeld(): boolean {
    return this.state.fire && (this.locked || isTouchDevice());
  }

  dispose(): void {
    this.disposers.forEach((d) => d());
    this.disposers = [];
    this.keys.clear();
  }
}
