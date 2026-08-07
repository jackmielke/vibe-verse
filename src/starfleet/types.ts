/**
 * Shared vocabulary: the context every system is handed, the input it reads,
 * the bus it talks over, and the two or three constants that decide how the
 * world is shaped.
 *
 * The scale note is the important one, because it is the decision everything
 * else in this world is downstream of. See `PLANET_R`.
 */
import * as THREE from "three";
import type { Character } from "./crew/characters";
import type { TrekSystem } from "./galaxy/systems";

export type Quality = "low" | "medium" | "high" | "ultra";
export type Mode = "space" | "surface";

/* ---------------------------------------------------------------------------
   Scale.

   Two scenes, two unit systems, and they do not talk to each other.

   In `space`, one unit is one kilometre *of nothing in particular*. The planet
   is drawn at a fixed 1,200 units whatever its catalogue diameter says, and the
   ship is three units long. That is a lie by a factor of about four thousand,
   and it is the correct lie: at true scale a starship in orbit is a single
   subpixel and the planet is a wall, which is exactly what it looks like from
   the ISS and exactly what nobody wants to look at.

   What the fixed radius buys is a depth budget. Everything in the space scene
   lives between 0.5 and 20,000 units — the starfield is a point cloud carried
   along by the camera at 9,000 and the local star is a sprite at 8,000 — so a
   plain 24-bit depth buffer covers the whole range without z-fighting, without
   a logarithmic buffer, and therefore without threading log-depth chunks
   through four hand-written shaders. Widen this range and the planet's
   terminator starts to shimmer; that is the failure this constant prevents.

   In `surface`, one unit is one metre and the numbers mean what they say.
   --------------------------------------------------------------------------- */
export const PLANET_R = 1200;
/**
 * Standard orbit, and it is a *composition* constant rather than a physical
 * one.
 *
 * At 1.9 R the planet subtends 63° across and its nearest limb sits 58° off
 * the along-track axis — which is outside a 58°-vertical frustum, so the world
 * you flew ninety light years to see is entirely off-screen while the HUD
 * cheerfully reports standard orbit. That was the first build, and it looked
 * like deep space with a scratch of ring in the corner.
 *
 * 1.33 R puts the limb 41° off-axis, inside the frame with the camera pitched
 * down 25°, and it also happens to read as about 400 km on a 12,000 km world —
 * roughly where the ISS is, which is a good place for a ship in a standard
 * orbit to be.
 */
export const ORBIT_R = PLANET_R * 1.33;
export const SPACE_NEAR = 0.5;
export const SPACE_FAR = 20000;
export const STARFIELD_R = 9000;
export const STAR_DIST = 8000;

export const SURFACE_NEAR = 0.1;
export const SURFACE_FAR = 3500;

/** Fixed simulation step. Everything integrates against this, never against
 *  the frame time, so a stutter cannot teleport the ship through a planet. */
export const FIXED_DT = 1 / 60;

/* --- input ---------------------------------------------------------------- */

export interface Input {
  /** Held keys, lower-cased `event.key` plus the raw `event.code`. */
  down: Set<string>;
  /** Pressed this frame only. Cleared at the end of every update. */
  hit: Set<string>;
  /** Mouse/touch look delta since the last frame, radians-ish. */
  look: { x: number; y: number };
  /** Virtual stick, -1..1 both axes. Touch drives it; WASD also writes it. */
  move: { x: number; y: number };
  /** Throttle axis for the ship, -1..1. */
  thrust: number;
  pointerLocked: boolean;
  /** True when the player is typing into the comm panel — the world must not
   *  read WASD out from under a sentence being written. */
  typing: boolean;
  held(key: string): boolean;
  pressed(key: string): boolean;
  endFrame(): void;
  dispose(): void;
}

export function createInput(target: HTMLElement): Input {
  const down = new Set<string>();
  const hit = new Set<string>();
  const look = { x: 0, y: 0 };
  const move = { x: 0, y: 0 };
  const api: Input = {
    down,
    hit,
    look,
    move,
    thrust: 0,
    pointerLocked: false,
    typing: false,
    held: (k) => down.has(k),
    pressed: (k) => hit.has(k),
    endFrame() {
      hit.clear();
      look.x = 0;
      look.y = 0;
    },
    dispose() {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      target.removeEventListener("mousemove", onMove);
      target.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUpBtn);
      document.removeEventListener("pointerlockchange", onLock);
      target.removeEventListener("touchstart", onTouchStart);
      target.removeEventListener("touchmove", onTouchMove);
      target.removeEventListener("touchend", onTouchEnd);
    },
  };

  const key = (e: KeyboardEvent) => e.key.toLowerCase();

  function onKey(e: KeyboardEvent) {
    if (api.typing) return;
    // Let the browser keep the shortcuts that mean "get me out of here".
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = key(e);
    if (!down.has(k)) hit.add(k);
    if (!down.has(e.code)) hit.add(e.code);
    down.add(k);
    down.add(e.code);
    if (["w", "a", "s", "d", " ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
      e.preventDefault();
    }
  }
  function onUp(e: KeyboardEvent) {
    down.delete(key(e));
    down.delete(e.code);
  }
  function onBlur() {
    down.clear();
  }
  /**
   * Look works two ways, and it has to.
   *
   * Pointer lock is the good one, but it routes *every* click to the locked
   * element — which on this ship means the entire LCARS panel stops responding
   * the moment you engage it. So lock is opt-in (click the viewport), it is
   * released whenever a panel opens, and the rest of the time looking around
   * is a drag with the button held. Without the drag path, a player who never
   * clicks the canvas can steer nothing at all.
   */
  let dragging = false;
  function onMove(e: MouseEvent) {
    if (!api.pointerLocked && !dragging) return;
    look.x += api.pointerLocked ? e.movementX : e.movementX;
    look.y += api.pointerLocked ? e.movementY : e.movementY;
  }
  function onDown(e: MouseEvent) {
    if (e.button === 0) dragging = true;
  }
  function onUpBtn() {
    dragging = false;
  }
  function onLock() {
    api.pointerLocked = document.pointerLockElement === target;
    if (!api.pointerLocked) down.clear();
  }

  /* Touch: left half is a stick, right half is the camera. Two fingers on the
     right half at once would fight each other, so the look finger is the first
     one to land there and nothing else is listened to. */
  let stickId: number | null = null;
  let stickOrigin = { x: 0, y: 0 };
  let lookId: number | null = null;
  let lookLast = { x: 0, y: 0 };

  function onTouchStart(e: TouchEvent) {
    for (const t of Array.from(e.changedTouches)) {
      const left = t.clientX < window.innerWidth * 0.45;
      if (left && stickId === null) {
        stickId = t.identifier;
        stickOrigin = { x: t.clientX, y: t.clientY };
      } else if (!left && lookId === null) {
        lookId = t.identifier;
        lookLast = { x: t.clientX, y: t.clientY };
      }
    }
  }
  function onTouchMove(e: TouchEvent) {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === stickId) {
        const dx = (t.clientX - stickOrigin.x) / 70;
        const dy = (t.clientY - stickOrigin.y) / 70;
        move.x = Math.max(-1, Math.min(1, dx));
        move.y = Math.max(-1, Math.min(1, -dy));
      } else if (t.identifier === lookId) {
        look.x += (t.clientX - lookLast.x) * 1.4;
        look.y += (t.clientY - lookLast.y) * 1.4;
        lookLast = { x: t.clientX, y: t.clientY };
      }
    }
    if (e.cancelable) e.preventDefault();
  }
  function onTouchEnd(e: TouchEvent) {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === stickId) {
        stickId = null;
        move.x = 0;
        move.y = 0;
      }
      if (t.identifier === lookId) lookId = null;
    }
  }

  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onUp);
  window.addEventListener("blur", onBlur);
  target.addEventListener("mousemove", onMove);
  target.addEventListener("mousedown", onDown);
  window.addEventListener("mouseup", onUpBtn);
  document.addEventListener("pointerlockchange", onLock);
  target.addEventListener("touchstart", onTouchStart, { passive: true });
  target.addEventListener("touchmove", onTouchMove, { passive: false });
  target.addEventListener("touchend", onTouchEnd, { passive: true });

  return api;
}

/* --- events ---------------------------------------------------------------- */

/**
 * The bus, and the reason systems never import one another.
 *
 * The space scene does not know the surface scene exists; the surface scene has
 * never heard of the warp drive; the UI holds a reference to the game and to
 * nothing else. Everything they need to say to each other goes through here as
 * a named event, which is what allows any one of them to fail at boot without
 * taking the rest of the world with it.
 */
export type BusEvent =
  | { type: "arrive"; system: TrekSystem }
  | { type: "warp-start"; system: TrekSystem; ly: number; warp: number }
  | { type: "warp-end"; system: TrekSystem }
  | { type: "orbit"; established: boolean }
  | { type: "scan"; system: TrekSystem }
  | { type: "beam"; down: boolean }
  | { type: "channel"; character: Character | null }
  | { type: "log"; line: string; urgent?: boolean }
  | { type: "alert"; on: boolean }
  | { type: "near"; character: Character | null };

export type BusHandler = (e: BusEvent) => void;

export interface Bus {
  on(fn: BusHandler): () => void;
  emit(e: BusEvent): void;
  clear(): void;
}

export function createBus(): Bus {
  const handlers = new Set<BusHandler>();
  return {
    on(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    emit(e) {
      for (const fn of Array.from(handlers)) {
        try {
          fn(e);
        } catch (err) {
          console.error("[SNW] bus handler threw", err);
        }
      }
    },
    clear() {
      handlers.clear();
    },
  };
}

/* --- misc ------------------------------------------------------------------ */

/** Deterministic PRNG. Seeded per system key, so a world looks the same on
 *  every visit — which is the whole difference between a place and a shuffle. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Frame-rate independent exponential approach. `k` is roughly "per second". */
export const damp = (a: number, b: number, k: number, dt: number) =>
  lerp(a, b, 1 - Math.exp(-k * dt));

/** Free every geometry, material and texture under a node, then detach it.
 *  Called on every scene swap — there are twelve systems and a visitor may see
 *  all of them in one session. */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose?.();
    const mat = (m as unknown as { material?: THREE.Material | THREE.Material[] }).material;
    if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.());
    else mat?.dispose?.();
  });
  root.parent?.remove(root);
}

export const col = (hex: number): THREE.Color => new THREE.Color(hex);
