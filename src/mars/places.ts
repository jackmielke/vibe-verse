/**
 * The map, as data. Where every camp is, what pressing E does there, and the
 * ground under the wheel. No three in here, so the layout can be checked in a
 * test and the engine only has to draw it.
 *
 * Units are metres. +x is east, toward the mountains; -x is west, toward the
 * Salton Sea. +z is south. The dining table is the origin because that is the
 * point of the table.
 */
import type { Action, ColonyState } from "./colony";

export type PlaceId =
  | "home"
  | "table"
  | "research"
  | "freeside"
  | "bodywork"
  | "tools"
  | "nature"
  | "poop"
  | "trailhead"
  | "sunflower"
  | "water";

export interface Place {
  id: PlaceId;
  name: string;
  /** What it is for, one line, on the sign. */
  tag: string;
  x: number;
  z: number;
  /** How close the wheel has to be for E to mean this place. */
  radius: number;
}

export const PLACES: Place[] = [
  { id: "home", name: "Your trailer", tag: "cheap, small, yours", x: 8, z: 50, radius: 9 },
  { id: "table", name: "The table", tag: "the gravity well", x: 0, z: 0, radius: 8 },
  { id: "research", name: "Mars Research", tag: "AI, and the dodecahedron", x: 74, z: -36, radius: 14 },
  { id: "freeside", name: "Freeside", tag: "lifestyle design and co-living", x: -74, z: -42, radius: 14 },
  { id: "bodywork", name: "Bodywork", tag: "noticeably longer hugs", x: -64, z: 54, radius: 14 },
  { id: "tools", name: "Tool Camp", tag: "the infrastructure of Mars", x: 80, z: 46, radius: 14 },
  { id: "nature", name: "Natural Intelligence", tag: "the sciences, and the scorpions", x: 8, z: -100, radius: 14 },
  { id: "poop", name: "Poop Mountain", tag: "an installation", x: -36, z: 116, radius: 11 },
  { id: "trailhead", name: "The trailhead", tag: "east, toward the mountains", x: 172, z: -14, radius: 10 },
  { id: "sunflower", name: "Sunflower Lab", tag: "Bombay Beach, not Mars", x: -548, z: 176, radius: 14 },
  { id: "water", name: "The water station", tag: "town", x: -588, z: 214, radius: 12 },
];

export const SEA_X = -720;
export const BOMBAY = { x: -560, z: 190 };

export function placeById(id: PlaceId): Place {
  return PLACES.find((p) => p.id === id)!;
}

export function nearestPlace(x: number, z: number): Place | null {
  let best: Place | null = null;
  let bestD = Infinity;
  for (const p of PLACES) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d <= p.radius && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

export interface Prompt {
  action: Action;
  label: string;
}

/** What E means here, right now. */
export function promptFor(s: ColonyState, place: Place): Prompt {
  switch (place.id) {
    case "home":
      if (!s.pullupBar && s.day <= 7) return { action: "pullup", label: "build the pull-up bar" };
      if (s.shelter >= 100) return { action: "sleep", label: "sit in the shelter" };
      return { action: "build", label: s.parts > 0 ? `build (${s.parts} parts)` : "build (no parts)" };
    case "table":
      return { action: "dinner", label: s.part === "night" ? "cook dinner for everybody" : "sit at the table" };
    case "research":
      return { action: "research", label: s.metBrain ? "talk to the Mars Brain" : "a session at Mars Research" };
    case "freeside":
      return { action: "freeside", label: "hang out at Freeside" };
    case "bodywork":
      return { action: "hug", label: "get a hug" };
    case "tools":
      return { action: "parts", label: "pick up parts" };
    case "nature":
      return { action: "nature", label: "go look at something alive" };
    case "poop":
      return { action: "poop", label: "admire the installation" };
    case "trailhead":
      return { action: "run", label: s.longRunDone ? "run" : s.stats.runs >= 2 ? "the long run" : "go for a run" };
    case "sunflower":
      return { action: "sunflower", label: "an afternoon at Sunflower Lab" };
    case "water":
      return { action: "water", label: "fill the jerry cans (half a day)" };
  }
}

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

function hash2(x: number, z: number): number {
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function noise2(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

const POOP = placeById("poop");
export const POOP_HEIGHT = 7;

/**
 * Height of the sand. Almost flat, a little roll, a rise toward the mountains
 * in the east, and one mound: Poop Mountain, with a shallow ramp on its south
 * side so a unicycle can get up it.
 */
export function groundHeight(x: number, z: number): number {
  let y = (noise2(x * 0.012, z * 0.012) - 0.5) * 1.6 + (noise2(x * 0.05, z * 0.05) - 0.5) * 0.25;
  // The alluvial rise toward the Chocolate Mountains.
  if (x > 300) y += ((x - 300) / 900) * ((x - 300) / 900) * 60;
  // The shore drops a little to the sea.
  if (x < SEA_X + 60) y -= Math.min(1.5, (SEA_X + 60 - x) * 0.05);
  // Poop Mountain.
  const dx = x - POOP.x;
  const dz = z - POOP.z;
  const d = Math.hypot(dx, dz);
  const R = 16;
  if (d < R) {
    const t = 1 - d / R;
    y += POOP_HEIGHT * t * t * (3 - 2 * t);
  }
  return y;
}

/** Where a fresh run begins, facing the table. */
export const SPAWN = { x: 8, z: 62 };
