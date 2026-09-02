/**
 * What kind of screen this is — one answer, for every HUD in the vibeverse.
 *
 * Every world that draws chrome over a canvas eventually asks the same three
 * questions: is this a finger or a mouse, is this a phone, and which way up is
 * it. Each had been answering them separately with its own `matchMedia`, its
 * own breakpoint and its own idea of "mobile" (768 px, in one hook, which
 * calls a landscape phone a desktop). This is the one place the answer lives.
 *
 * - `touch`   — `(pointer: coarse)`: the primary pointer is a finger. Decides
 *               whether keycaps mean anything and whether a thumb layer mounts.
 * - `phone`   — the SHORTER side is under 520 px. A phone either way up, and
 *               not a tablet, which has room for the desktop layout.
 * - `short`   — under 520 px tall: a phone on its side. The layout that has
 *               to fit is the one with the least height, so this is the flag
 *               most HUDs branch on.
 * - `portrait`— taller than wide.
 *
 * `readScreen()` for imperative code, `useScreen()` for React. The hook
 * re-renders on resize and orientation change and nowhere else.
 */
import { useEffect, useState } from "react";

export interface ScreenShape {
  touch: boolean;
  phone: boolean;
  short: boolean;
  portrait: boolean;
}

/** The short side below which a screen is a phone, not a tablet. */
export const PHONE_MAX = 520;

const DESKTOP: ScreenShape = { touch: false, phone: false, short: false, portrait: false };

/** Pure: the shape for a given viewport, so a test can ask about any size. */
export function shapeFor(width: number, height: number, touch: boolean): ScreenShape {
  return {
    touch,
    phone: Math.min(width, height) < PHONE_MAX,
    short: height < PHONE_MAX,
    portrait: height > width,
  };
}

export function readScreen(): ScreenShape {
  if (typeof window === "undefined") return DESKTOP;
  const touch = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return shapeFor(window.innerWidth, window.innerHeight, touch);
}

function same(a: ScreenShape, b: ScreenShape): boolean {
  return a.touch === b.touch && a.phone === b.phone && a.short === b.short && a.portrait === b.portrait;
}

/** Call `fn` with the new shape whenever it changes. Returns the unsubscribe. */
export function subscribeScreen(fn: (s: ScreenShape) => void): () => void {
  if (typeof window === "undefined") return () => {};
  let last = readScreen();
  const check = () => {
    const next = readScreen();
    if (same(next, last)) return;
    last = next;
    fn(next);
  };
  window.addEventListener("resize", check);
  window.addEventListener("orientationchange", check);
  const mq = typeof window.matchMedia === "function" ? window.matchMedia("(pointer: coarse)") : null;
  mq?.addEventListener?.("change", check);
  return () => {
    window.removeEventListener("resize", check);
    window.removeEventListener("orientationchange", check);
    mq?.removeEventListener?.("change", check);
  };
}

export function useScreen(): ScreenShape {
  const [shape, setShape] = useState<ScreenShape>(readScreen);
  useEffect(() => subscribeScreen(setShape), []);
  return shape;
}
