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
 * Adding a world to the passport is one `useWorldStamp` call in its page.
 */

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
export const PASSPORT_WORLDS: { route: string; name: string; emoji: string }[] = [
  { route: "/vibeverse", name: "The Vibeverse", emoji: "🛰️" },
  { route: "/sf", name: "San Francisco", emoji: "🌉" },
  { route: "/seafair", name: "Seafair 2117", emoji: "🛩️" },
  { route: "/island-2", name: "Vibe Island II", emoji: "🏝️" },
  { route: "/edm-town", name: "EDM Town", emoji: "🪩" },
  { route: "/san-palmas", name: "San Palmas", emoji: "🌴" },
  { route: "/golf", name: "Vibe Golf", emoji: "⛳" },
  { route: "/terminal", name: "The Terminal", emoji: "🛫" },
  { route: "/city", name: "Vibe City", emoji: "🌆" },
  { route: "/garden", name: "Memory Garden", emoji: "🌱" },
  /* The one stamp that is not a place you can navigate to.
     Redline is a planet inside the ship's own galaxy — it has no page, so no
     `useWorldStamp` can ever write it. It is stamped by *holding* it: clearing
     the landing site of hostiles, once, on the ground. Which makes a full
     passport the only thing in the vibeverse you have to earn rather than
     visit. See Troopers.js and Game._updateBattle. */
  { route: "/vibeverse/redline", name: "Redline", emoji: "🎖️" },
];

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

/** Stamps in passport order, with the unvisited worlds included and blank. */
export function passportRows(): (Stamp & { visited: boolean; emoji: string })[] {
  const p = readPassport();
  return PASSPORT_WORLDS.map((w) => {
    const s = p.stamps[w.route];
    return s
      ? { ...s, name: w.name, visited: true, emoji: w.emoji }
      : { route: w.route, name: w.name, first: 0, last: 0, count: 0, visited: false, emoji: w.emoji };
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
