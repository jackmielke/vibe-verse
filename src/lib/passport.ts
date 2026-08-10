/**
 * The passport — one traveller's record of the whole vibeverse.
 *
 * Every world in this repo is its own island: its own page, its own engine, its
 * own state, and no world has ever known that any other one exists. The hub
 * lists them, but nothing carries *across* them. This is the smallest thing
 * that does. A world stamps the passport when you arrive; every other world can
 * read every stamp.
 *
 * It deliberately does not touch Supabase. A visit record is not worth a
 * network round trip, an auth check or a row that fails to write when someone
 * is signed out — and the ship has to work offline. `localStorage` is shared
 * across every route on the origin, which is exactly the scope of "the
 * vibeverse", so it is the right size of tool for the job.
 *
 * Adding a world to the passport is `passport: true` in the registry plus one
 * `useWorldStamp` call in its page.
 */
import { PASSPORT_ROUTES, type PassportRoute } from "@/worlds/registry";

const KEY = "vibe.passport";
const VERSION = 1;

export interface Stamp {
  /** Route the world lives at — the stable id. */
  route: string;
  /** Human name, stored so a stamp survives a world being renamed. */
  name: string;
  /** Epoch ms of the first and most recent arrival. */
  first: number;
  last: number;
  /** How many separate arrivals. */
  count: number;
}

export interface Passport {
  version: number;
  stamps: Record<string, Stamp>;
}

const EMPTY: Passport = { version: VERSION, stamps: {} };

/**
 * Every world worth stamping, in the order the passport lists them.
 *
 * Kept here rather than derived from the router so the passport has a stable,
 * curated notion of "the vibeverse" — a debug route appearing in someone's
 * record because it happened to be mounted would be noise.
 */
/**
 * The worlds a passport has pages for.
 *
 * Derived, not written: a world declares `passport: true` in
 * `src/worlds/registry.ts` and appears here. The list used to be maintained by
 * hand next to five other hand-maintained lists, which is how Vibe Kart ended
 * up shipping without a page in the one book that spans the whole vibeverse.
 *
 * The last entry is the stamp that is not a place you can navigate to. Redline
 * is a planet inside the ship's own galaxy — it has no page, so no
 * `useWorldStamp` can ever write it. It is stamped by *holding* it: clearing
 * the landing site of hostiles, once, on the ground. Which makes a full
 * passport the only thing in the vibeverse you have to earn rather than visit.
 * See Troopers.js and Game._updateBattle.
 */
export const PASSPORT_WORLDS: PassportRoute[] = PASSPORT_ROUTES;

/** Read the passport. Never throws: a corrupt entry is an empty passport. */
export function readPassport(): Passport {
  if (typeof localStorage === "undefined") return { ...EMPTY };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY, stamps: {} };
    const p = JSON.parse(raw) as Passport;
    if (!p || typeof p !== "object" || !p.stamps || typeof p.stamps !== "object") {
      return { ...EMPTY, stamps: {} };
    }
    return { version: p.version || VERSION, stamps: p.stamps };
  } catch {
    /* Somebody else's key, a half-written value, a browser with storage
       disabled — none of these are worth breaking a world over. */
    return { ...EMPTY, stamps: {} };
  }
}

/**
 * Record an arrival. Idempotent within a short window so that a React strict
 * double-mount, or a page that remounts on resize, does not read as two visits.
 */
export function stampPassport(route: string, name: string): Passport {
  const p = readPassport();
  if (!route) return p;
  const now = Date.now();
  const prev = p.stamps[route];
  // Two arrivals inside a minute are one arrival.
  if (prev && now - prev.last < 60_000) {
    prev.last = now;
  } else if (prev) {
    prev.last = now;
    prev.count += 1;
    prev.name = name || prev.name;
  } else {
    p.stamps[route] = { route, name: name || route, first: now, last: now, count: 1 };
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* Private browsing, quota, disabled storage. The visit simply is not kept;
       nothing downstream depends on the write having succeeded. */
  }
  return p;
}

export type PassportRow = Stamp & PassportRoute & { visited: boolean; rank: Rank };

/**
 * How well you know a place.
 *
 * A passport that only records *whether* you went somewhere flattens the
 * difference between a world you glanced at once and one you keep coming back
 * to, and those are the two most different things it could be recording. The
 * thresholds are deliberately low — this is a book of places, not a grind.
 */
export type Rank = "unexplored" | "visited" | "regular" | "local";

export const RANKS: Record<Rank, { label: string; at: number }> = {
  unexplored: { label: "Unexplored", at: 0 },
  visited: { label: "Stamped", at: 1 },
  regular: { label: "Regular", at: 4 },
  local: { label: "Local", at: 12 },
};

export function rankOf(count: number): Rank {
  if (count >= RANKS.local.at) return "local";
  if (count >= RANKS.regular.at) return "regular";
  if (count >= RANKS.visited.at) return "visited";
  return "unexplored";
}

/** Stamps in passport order, with the unvisited worlds included and blank. */
export function passportRows(): PassportRow[] {
  const p = readPassport();
  return PASSPORT_WORLDS.map((w) => {
    const s = p.stamps[w.route];
    const count = s?.count ?? 0;
    return {
      ...w,
      route: w.route,
      name: w.name,
      first: s?.first ?? 0,
      last: s?.last ?? 0,
      count,
      visited: !!s,
      rank: rankOf(count),
    };
  });
}

export function passportProgress(): { visited: number; total: number; trips: number } {
  const rows = passportRows();
  return {
    visited: rows.filter((r) => r.visited).length,
    total: rows.length,
    trips: rows.reduce((n, r) => n + r.count, 0),
  };
}
