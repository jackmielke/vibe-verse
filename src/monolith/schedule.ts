/**
 * Where the Monolith stands today.
 *
 * Pure and keyed on the UTC day, so every visitor on every device agrees on
 * the same world and the same spot without asking a server. It walks through
 * the host worlds in a shuffled order, one a day, and never stands in the
 * same world two days running (including across the seam between two
 * shuffles, which is where a naive shuffle repeats itself).
 *
 * A host world is one that calls `mountMonolith` with its key. Adding a host
 * is one entry below plus that call; spots are in the host's own world
 * coordinates, feet on the ground, and must be open walkable ground: the
 * slab has no collider, so a spot inside a wall is a monolith nobody reaches.
 */

export type MonolithHost = "island" | "thalassa" | "summit" | "magician";

export interface MonolithSpot {
  x: number;
  z: number;
  /** Which way the broad face looks, radians about +y. */
  yaw: number;
  /** "on the quay": finishes the sentence "The Monolith stands …". */
  where: string;
}

export interface HostWorld {
  key: MonolithHost;
  name: string;
  /** The route to open to find it. */
  route: string;
  spots: MonolithSpot[];
}

export const HOSTS: HostWorld[] = [
  {
    key: "island",
    name: "Vibe Island",
    route: "/city?spawn=island",
    // Island-local: the island's origin is the plaza centre.
    spots: [
      { x: 17, z: -9, yaw: -0.9, where: "on the lawn east of the plaza" },
      { x: -17, z: 8, yaw: 1.2, where: "on the lawn west of the high street" },
    ],
  },
  {
    key: "thalassa",
    name: "Thalassa",
    route: "/thalassa",
    spots: [
      { x: 58, z: -12, yaw: -1.2, where: "in the meadow east of the quay" },
    ],
  },
  {
    key: "summit",
    name: "Vibe Summit",
    route: "/summit",
    spots: [
      { x: 0, z: -2386, yaw: 0, where: "on the summit deck, between the trail signs" },
    ],
  },
  {
    key: "magician",
    name: "The Magician's valley",
    route: "/magician",
    spots: [
      { x: -8, z: 24, yaw: 2.6, where: "in the long grass south of the village" },
    ],
  },
];

export interface Placement {
  host: HostWorld;
  spot: MonolithSpot;
  /** UTC day number (days since 1970-01-01). */
  day: number;
}

/** UTC day number. Everybody's midnight is the same midnight. */
export function dayNumber(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 86_400_000);
}

/** A small integer hash, stable across engines. */
function hash(n: number): number {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** One shuffle of the hosts per cycle of HOSTS.length days. */
function cycleOrder(cycle: number): number[] {
  const order = HOSTS.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = hash(cycle * 31 + i) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function orderFor(cycle: number): number[] {
  const order = cycleOrder(cycle);
  // Never the same world two days running across a seam.
  const prev = cycleOrder(cycle - 1);
  if (order.length > 1 && order[0] === prev[prev.length - 1]) [order[0], order[1]] = [order[1], order[0]];
  return order;
}

export function placementOn(day: number): Placement {
  const n = HOSTS.length;
  const cycle = Math.floor(day / n);
  const idx = day - cycle * n;
  const host = HOSTS[orderFor(cycle)[idx]];
  const spot = host.spots[hash(day * 7 + 3) % host.spots.length];
  return { host, spot, day };
}

export function today(at: Date = new Date()): Placement {
  return placementOn(dayNumber(at));
}

/**
 * Is the Monolith in this world right now? `?monolith` in the URL forces it
 * here (at spot 0, or `?monolith=1` for the second), which is how scripts
 * and curious admins find it on any day.
 */
export function placementFor(host: MonolithHost, search = typeof window !== "undefined" ? window.location.search : ""): Placement | null {
  const q = new URLSearchParams(search);
  if (q.has("monolith")) {
    const h = HOSTS.find((x) => x.key === host)!;
    const i = Math.max(0, Math.min(h.spots.length - 1, Number(q.get("monolith")) || 0));
    return { host: h, spot: h.spots[i], day: dayNumber() };
  }
  const p = today();
  return p.host.key === host ? p : null;
}

/** Seconds until the Monolith moves on (next UTC midnight). */
export function secondsUntilItMoves(at: Date = new Date()): number {
  return (dayNumber(at) + 1) * 86_400 - at.getTime() / 1000;
}
