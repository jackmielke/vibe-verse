/**
 * A single requestAnimationFrame driver for the whole HUD.
 *
 * The hard rule for this subsystem is that no 60 Hz value ever passes through
 * React. That leaves two options for live readouts: one rAF per component
 * (a dozen callbacks, a dozen closures, a dozen `performance.now()` calls per
 * frame) or one shared driver that fans out. This is the second one.
 *
 * The loop only runs while something is subscribed, so a paused game with the
 * HUD hidden costs literally nothing. Subscribers get `(now, dt)` in seconds
 * and are expected to write straight into DOM nodes they hold refs to.
 */
import { useEffect, useRef } from "react";

export type UiTick = (now: number, dt: number) => void;

const subs = new Set<UiTick>();
let raf = 0;
let last = 0;

function pump(t: number) {
  raf = requestAnimationFrame(pump);
  const now = t / 1000;
  const dt = last === 0 ? 1 / 60 : Math.min(0.1, now - last);
  last = now;
  // Iterate a snapshot: a subscriber that unsubscribes itself mid-tick (the
  // hit marker retiring, say) must not corrupt the iteration.
  for (const fn of Array.from(subs)) {
    try {
      fn(now, dt);
    } catch {
      // A throwing HUD widget must never take down the frame loop with it.
    }
  }
}

function start() {
  if (raf) return;
  last = 0;
  raf = requestAnimationFrame(pump);
}

function stop() {
  if (!raf) return;
  cancelAnimationFrame(raf);
  raf = 0;
}

/** Subscribe imperatively. Returns the unsubscribe. */
export function subscribeUiFrame(fn: UiTick): () => void {
  subs.add(fn);
  start();
  return () => {
    subs.delete(fn);
    if (subs.size === 0) stop();
  };
}

/**
 * React binding. `active` lets a widget drop out of the loop when it is not
 * on screen — the map screen's live readouts should not tick while the map
 * is closed.
 *
 * The callback is held in a ref so callers can close over fresh props
 * without churning the subscription every render.
 */
export function useUiFrame(fn: UiTick, active = true): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    return subscribeUiFrame((now, dt) => ref.current(now, dt));
  }, [active]);
}

/**
 * A rate-limited variant for readouts where 60 Hz is wasted work: distances,
 * altitudes, anything the eye reads as text. 12-20 Hz looks identical and
 * costs a third of the layout thrash.
 */
export function useUiInterval(fn: UiTick, hz = 15, active = true): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const period = 1 / hz;
    let acc = 0;
    return subscribeUiFrame((now, dt) => {
      acc += dt;
      if (acc < period) return;
      const step = acc;
      acc = 0;
      ref.current(now, step);
    });
  }, [hz, active]);
}

/**
 * Write text into a node only when it actually changed.
 *
 * `el.textContent = x` on an unchanged string still dirties the node in some
 * engines; more importantly it is the single most common HUD hot path, so
 * gating it here keeps every call site honest without each one remembering.
 */
export function setText(el: HTMLElement | null | undefined, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

/** Same idea for a CSS custom property or inline style value. */
export function setStyleVar(
  el: HTMLElement | null | undefined,
  prop: string,
  value: string,
): void {
  if (!el) return;
  const cache = (el as HTMLElement & { __sfvars?: Record<string, string> }).__sfvars ??
    ((el as HTMLElement & { __sfvars?: Record<string, string> }).__sfvars = {});
  if (cache[prop] === value) return;
  cache[prop] = value;
  el.style.setProperty(prop, value);
}

/** Attribute setter with the same change-gate. Used for SVG geometry. */
export function setAttr(el: Element | null | undefined, name: string, value: string): void {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/**
 * Exponential smoothing that is framerate independent.
 * Duplicated from math/rng's `damp` so the UI has no reason to reach into a
 * simulation module for two lines of arithmetic.
 */
export function approach(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}
