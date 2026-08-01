/**
 * What kind of machine is looking at the lobby.
 *
 * Its own module rather than a const in `TerminalScene`, because the scene
 * needs it too and importing it back out of the component that renders the
 * scene is an import cycle waiting to bite somebody.
 *
 * Both flags are sampled once. Neither changes mid-session, and re-reading
 * `matchMedia` per frame is not free.
 */

/** A coarse pointer means a phone or a tablet — the device this lobby exists
    to be fast on. `/terminal` promises to load in about a second there. */
export const MOBILE =
  typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

/** The screenshot harness drives routes with `?shot`. */
export const SHOT_MODE =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");
