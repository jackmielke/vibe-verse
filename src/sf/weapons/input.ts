/**
 * weapons/input.ts — the input snapshot the weapon system reads.
 *
 * The player controller owns the real input layer (look, move, grapple,
 * wingsuit). Weapons must not fight it for listeners, so the contract is a
 * single mutable snapshot: whoever owns input sets `weaponInput.external = true`
 * and writes the fields every frame; the weapon system only ever *reads* them
 * and derives its own edges (press/release) internally.
 *
 * If nobody claims input — a level loaded straight into a test scene, the
 * screenshot harness, an early build — `installWeaponInput()` binds a
 * conventional mouse-and-keyboard set so the guns are still playable.
 *
 * Bindings when we own them:
 *   LMB            fire (hold for automatics, hold to cook a grenade)
 *   RMB            aim down sights
 *   R              reload
 *   1..9, 0, -     weapon slots
 *   wheel          cycle weapons
 *   F              detonate placed sticky mines
 *   Shift          sprint (and hold breath while scoped)
 *   Ctrl / C       crouch
 *   I              inspect weapon
 */

export interface WeaponInputSnapshot {
  /** True while the trigger is held. */
  fire: boolean;
  /** True while aiming down sights. */
  ads: boolean;
  reload: boolean;
  /** Remote-detonate placed explosives. */
  detonate: boolean;
  inspect: boolean;
  sprint: boolean;
  crouch: boolean;
  /** Hold breath while scoped. */
  holdBreath: boolean;
  /** Requested slot index, or -1. Cleared by the weapon system once consumed. */
  slot: number;
  /** Accumulated wheel/next-previous steps. Drained by the weapon system. */
  cycle: number;
  /** Set true by whoever owns the real input layer. */
  external: boolean;
}

export const weaponInput: WeaponInputSnapshot = {
  fire: false,
  ads: false,
  reload: false,
  detonate: false,
  inspect: false,
  sprint: false,
  crouch: false,
  holdBreath: false,
  slot: -1,
  cycle: 0,
  external: false,
};

export function resetWeaponInput(): void {
  weaponInput.fire = false;
  weaponInput.ads = false;
  weaponInput.reload = false;
  weaponInput.detonate = false;
  weaponInput.inspect = false;
  weaponInput.sprint = false;
  weaponInput.crouch = false;
  weaponInput.holdBreath = false;
  weaponInput.slot = -1;
  weaponInput.cycle = 0;
}

const SLOT_KEYS: Record<string, number> = {
  Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4,
  Digit6: 5, Digit7: 6, Digit8: 7, Digit9: 8, Digit0: 9, Minus: 10,
};

/**
 * Bind the fallback listeners. Returns a teardown.
 *
 * `onGesture` fires on the first real user interaction — the weapon system
 * uses it to unlock the AudioContext, which browsers will not let us do at
 * any other time.
 */
export function installWeaponInput(
  target: HTMLElement,
  onGesture?: () => void,
): () => void {
  let gestured = false;
  const gesture = () => {
    if (gestured) return;
    gestured = true;
    onGesture?.();
  };

  const onMouseDown = (e: MouseEvent) => {
    gesture();
    if (e.button === 0) weaponInput.fire = true;
    if (e.button === 2) weaponInput.ads = true;
  };
  const onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) weaponInput.fire = false;
    if (e.button === 2) weaponInput.ads = false;
  };
  const onContext = (e: Event) => e.preventDefault();
  const onWheel = (e: WheelEvent) => {
    weaponInput.cycle += e.deltaY > 0 ? 1 : -1;
  };
  const onBlur = () => resetWeaponInput();

  const onKeyDown = (e: KeyboardEvent) => {
    gesture();
    switch (e.code) {
      case "KeyR": weaponInput.reload = true; break;
      case "KeyF": weaponInput.detonate = true; break;
      case "KeyI": weaponInput.inspect = true; break;
      case "ShiftLeft":
      case "ShiftRight":
        weaponInput.sprint = true;
        weaponInput.holdBreath = true;
        break;
      case "ControlLeft":
      case "KeyC":
        weaponInput.crouch = true;
        break;
      default:
        if (e.code in SLOT_KEYS) weaponInput.slot = SLOT_KEYS[e.code];
        break;
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    switch (e.code) {
      case "KeyR": weaponInput.reload = false; break;
      case "KeyF": weaponInput.detonate = false; break;
      case "KeyI": weaponInput.inspect = false; break;
      case "ShiftLeft":
      case "ShiftRight":
        weaponInput.sprint = false;
        weaponInput.holdBreath = false;
        break;
      case "ControlLeft":
      case "KeyC":
        weaponInput.crouch = false;
        break;
      default:
        break;
    }
  };

  target.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  target.addEventListener("contextmenu", onContext);
  target.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  return () => {
    target.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("mouseup", onMouseUp);
    target.removeEventListener("contextmenu", onContext);
    target.removeEventListener("wheel", onWheel);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    resetWeaponInput();
  };
}
