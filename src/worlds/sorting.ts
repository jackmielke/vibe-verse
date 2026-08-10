/**
 * The three orders the front door can be read in, and which one you get.
 *
 * Lives here rather than inside `/game` because "which world comes first" is a
 * rule about the collection, not about a page — and because the rules have
 * edges (a first-time visitor has no play history; a stored preference can name
 * an order that is no longer offered) that are much easier to pin down here
 * than through a rendered grid.
 */
import { byFreshest } from "./freshness";
import { featuredFirst, type WorldEntry } from "./registry";

/**
 * - `featured` — the hand-tuned running order at the top of `registry.ts`.
 *   What somebody arriving cold should see, and therefore the default.
 * - `updated`  — what is still being worked on, freshest first.
 * - `played`   — the doors you have already opened, most recent first.
 */
export type WorldSort = "featured" | "updated" | "played";

const ALL: WorldSort[] = ["featured", "updated", "played"];

const KEY = "vibe.game.sort.v1";

/** Is this one of the orders we offer, given what this visitor has done? */
const usable = (value: unknown, hasPlays: boolean): value is WorldSort =>
  ALL.includes(value as WorldSort) && (value !== "played" || hasPlays);

/**
 * Which order to open on.
 *
 * Featured unless this visitor has deliberately chosen otherwise before. The
 * front door used to open on `played`, which meant a first-time visitor — the
 * one person whose opinion of this page matters most — got the registry order
 * under a heading that said "recently played", describing worlds they had
 * never been to.
 *
 * A stored `played` is dropped when the passport is empty (a cleared browser, a
 * new device), because restoring an order with nothing in it looks broken.
 */
export function initialSort(hasPlays: boolean, stored?: string | null): WorldSort {
  const raw = stored !== undefined ? stored : readStored();
  return usable(raw, hasPlays) ? raw : "featured";
}

function readStored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    /* Private mode. A preference nobody can save is not worth an error. */
    return null;
  }
}

/** Remember a deliberate choice, so the next visit opens the same way. */
export function rememberSort(sort: WorldSort): void {
  try {
    localStorage.setItem(KEY, sort);
  } catch {
    /* As above. */
  }
}

/**
 * Put a list of worlds in one of the three orders.
 *
 * `played` keeps everything you have *not* been to behind what you have, in the
 * featured order, rather than hiding it — an order that shortens the page to
 * four cards is a filter wearing a sort's clothes, and the whole job of this
 * page is showing you what exists.
 */
export function sortWorlds(
  worlds: WorldEntry[],
  sort: WorldSort,
  lastPlayed: Record<string, number> = {},
): WorldEntry[] {
  if (sort === "updated") return [...worlds].sort((a, b) => byFreshest(a.key, b.key));
  const featured = featuredFirst(worlds);
  if (sort !== "played") return featured;
  return [...featured].sort(
    (a, b) => (lastPlayed[b.route] ?? 0) - (lastPlayed[a.route] ?? 0),
  );
}

/** What the tab says, and what it promises. Order is the order they render in. */
export const SORT_TABS: { id: WorldSort; label: string; hint: string }[] = [
  { id: "featured", label: "Featured", hint: "The running order — best first" },
  { id: "updated", label: "Updated", hint: "What changed most recently" },
  { id: "played", label: "Played", hint: "Where you have been, latest first" },
];
