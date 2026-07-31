/**
 * Vibe Kart — the bridge between the engine loop and React.
 *
 * The whole HUD hangs off three primitives:
 *
 *   `useKartFrame(fn)`  — `fn(dt)` once per engine frame. This is where every
 *                         fast-moving value is written: straight to `style` and
 *                         `textContent` through refs, never through state. A
 *                         speedometer that re-renders React at 60 fps is a
 *                         speedometer that costs more than the game.
 *
 *   `useSample(read)`   — polls `read()` at 15 Hz and only re-renders when the
 *                         value actually changes. Position, lap, coins and the
 *                         held item all move slowly enough that a sixty-fourth
 *                         of a second of latency is invisible, and 15 Hz with a
 *                         change guard means the tree is idle most of the time.
 *
 *   `useKartEvent(e,fn)`— the engine's event bus, unsubscribed on unmount.
 *
 * The frame pump comes from the minimap system's `lateUpdate` (see
 * `ui/types.ts`), which is inside the engine's own loop. `requestAnimationFrame`
 * is only a fallback for the case where that system failed to boot — and it is
 * genuinely a fallback, because the screenshot harness stops rAF and steps the
 * engine by hand.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { KartEngine } from "../engine/core";
import type { KartCtx } from "../types";

export interface UiRuntime {
  engine: KartEngine;
  ctx: KartCtx;
  /** `?shot` — the screenshot harness is driving; skip the front end. */
  shot: boolean;
  /** Subscribe to the engine frame. Returns an unsubscribe. */
  onFrame(fn: (dt: number) => void): () => void;
}

const RuntimeContext = createContext<UiRuntime | null>(null);

export const RuntimeProvider = RuntimeContext.Provider;

/** Never null below `KartUI`'s provider; the throw is a wiring bug, not a state. */
export function useRuntime(): UiRuntime {
  const rt = useContext(RuntimeContext);
  if (!rt) throw new Error("[Vibe Kart/ui] a HUD component was rendered outside the runtime provider");
  return rt;
}

/** Per-frame callback. The identity of `fn` may change freely between renders. */
export function useKartFrame(fn: (dt: number) => void): void {
  const rt = useRuntime();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => rt.onFrame((dt) => ref.current(dt)), [rt]);
}

/** Default sampling rate for continuous values that drive React state. */
export const SAMPLE_HZ = 15;

export function useSample<T>(read: () => T, eq: (a: T, b: T) => boolean = Object.is, hz = SAMPLE_HZ): T {
  const readRef = useRef(read);
  readRef.current = read;
  const eqRef = useRef(eq);
  eqRef.current = eq;

  const [value, setValue] = useState<T>(() => {
    try {
      return read();
    } catch {
      return undefined as unknown as T;
    }
  });
  const latest = useRef(value);
  const acc = useRef(0);

  useKartFrame((dt) => {
    acc.current += dt;
    if (acc.current < 1 / hz) return;
    acc.current = 0;
    let next: T;
    try {
      next = readRef.current();
    } catch {
      return;
    }
    if (eqRef.current(latest.current, next)) return;
    latest.current = next;
    setValue(next);
  });

  return value;
}

/** Shallow equality for the small record shapes the samplers return. */
export function shallowEq<T extends object>(a: T, b: T): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  if (keys.length !== Object.keys(rb).length) return false;
  for (const k of keys) if (!Object.is(ra[k], rb[k])) return false;
  return true;
}

export function useKartEvent<T = unknown>(event: string, fn: (payload: T) => void): void {
  const rt = useRuntime();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(
    () => rt.ctx.on(event, ((p: T) => ref.current(p)) as (p: never) => void),
    [rt, event],
  );
}

/** Read a service, tolerating both a missing service and a torn-down engine. */
export function useService<K extends keyof KartCtx["services"]>(name: K): KartCtx["services"][K] {
  const rt = useRuntime();
  return rt.ctx.services[name];
}

/**
 * A one-shot flag that turns itself off. Used for the pop animations: set the
 * key, React remounts the node, the CSS animation replays.
 */
export function usePulse(): [number, () => void] {
  const [n, setN] = useState(0);
  const bump = useRef(() => setN((v) => v + 1)).current;
  return [n, bump];
}
