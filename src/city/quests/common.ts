/**
 * What every side quest is handed each frame, and what it hands back.
 *
 * A quest is a little state machine with some scenery. It never touches the
 * page's physics directly: like the landmarks, if it needs the player held
 * somewhere (sat on the pier with a rod, stuck to the side of the Empire
 * State) it returns a position, and the city puts the player's feet there
 * after its own physics step.
 */
import type * as THREE from "three";

export interface QuestInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  /** Space. */
  jump: boolean;
  /** E held, or the on-screen action button held. */
  hold: boolean;
  run: boolean;
}

export interface QuestCtx {
  t: number;
  dt: number;
  /** The player's feet. */
  player: THREE.Vector3;
  grounded: boolean;
  /** On another ride (an elevator, the boat, a mount, swimming). */
  busy: boolean;
  thrusting: boolean;
  /** Driving: which vehicle and where. */
  vehicle: { kind: string; x: number; z: number; yaw: number; speed: number } | null;
  camYaw: number;
  night: boolean;
  input: QuestInput;
}

/** What a quest asks of the page this frame. */
export interface QuestStep {
  /** Put the player's feet here, zero their velocity. */
  lock?: THREE.Vector3 | null;
  /** Set the player's velocity, once. */
  kick?: THREE.Vector3 | null;
  /** Turn the avatar to this yaw. */
  face?: number | null;
}

export interface Prompt {
  emoji: string;
  label: string;
  /** Distance to it, so the nearest one wins. */
  dist: number;
  act(): void;
}

export interface DialogOption {
  id: string;
  label: string;
  /** Greyed out, with the reason as a tooltip. */
  disabled?: string;
}

export interface Dialog {
  speaker: string;
  emoji: string;
  text: string;
  options: DialogOption[];
}

export type Sound = "chime" | "fanfare" | "thud" | "splash" | "meow" | "coin" | "countdown" | "go";

export interface QuestHost {
  balance(): number;
  /** Pay the player. `why` is for the toast. */
  earn(n: number, why: string): void;
  /** Take a stake. False if they cannot cover it. */
  spend(n: number): boolean;
  toast(title: string, description?: string): void;
  sound(s: Sound, n?: number): void;
  /** Put a quest hat on (or take it off). */
  wearHat(id: string | null): void;
}

export const dist2 = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);

/** Wrap an angle into -PI..PI. */
export function wrap(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* quota */
  }
}

/** Today, as a key for the daily ceilings. */
export const today = () => new Date().toISOString().slice(0, 10);
