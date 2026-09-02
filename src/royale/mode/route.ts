/**
 * Which of the three games a URL boots.
 *
 * Three games share one page and every system under it; the route is the only
 * thing that tells them apart. `/better-fortnite` and its aliases are BETTER
 * FORTNITE; `?mode=classic` is Drop Zero; everything else is SPLASH ROYALE,
 * which is the default because it is the one people send to a friend.
 *
 * Pure, and in its own file, so the mapping is tested without mounting a page.
 */
import type { GameMode } from "../types";

const BETTER_PATH = /^\/(better-fortnite|better|bf|better-royale)(\/|$)/;

export function modeForLocation(pathname: string, search: string): GameMode {
  if (BETTER_PATH.test(pathname)) return "better";
  return new URLSearchParams(search).get("mode") === "classic" ? "classic" : "water";
}
