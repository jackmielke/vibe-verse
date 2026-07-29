/**
 * terminalGeo — the spatial truth for THE TERMINAL, the Vibeverse's front door.
 *
 * You stand on a circular platform on a small grassy island. The worlds of the
 * Vibeverse orbit you as floating islands, each one a departure gate. Picking
 * one flies you into it.
 *
 * Deliberately tiny compared to San Francisco or Island II — the whole point is
 * that it loads in about a second on a phone, because it is the first thing
 * anyone ever sees and a lobby that takes twenty seconds to appear is a lobby
 * nobody waits for.
 *
 * Art direction is reference 3 in `references/VISION.md`: saturated blue sky,
 * big soft cumulus, flat-shaded low-poly islands with clean silhouettes. Low
 * fidelity is the *style*, not the budget — with no texture detail to hide
 * behind, every silhouette and colour has to be deliberate.
 */
import { fbm2, valueNoise2 } from "@/shared/proc/rng";

/* ------------------------------------------------------------------ *
 * The home island
 * ------------------------------------------------------------------ */

export const HOME = {
  /** Radius of the grassy island you stand on, metres. */
  radius: 30,
  /** Depth of its keel. */
  keel: 26,
  /** Radius of the stone platform at its centre. */
  platformRadius: 7.4,
  /** Height of the platform's top above the island's grass. */
  platformHeight: 0.42,
} as const;

/**
 * Height of the home island's grass at a point, relative to the platform top.
 *
 * Defined everywhere on purpose. An earlier version returned -Infinity outside
 * the radius, which seems reasonable until the mesh builder samples the noisy
 * rim — which reaches 1.14x the base radius — and every one of those vertices
 * becomes NaN, taking the normals and the bounding sphere with it. A height
 * field should not have holes in it; the *rim* decides where the island ends.
 */
export function homeHeight(x: number, z: number): number {
  const d = Math.hypot(x, z);
  // A gentle rise toward the middle so the platform sits on a crown, and the
  // rim rolls off rather than ending in a wall.
  const crown = Math.cos((d / HOME.radius) * Math.PI * 0.5) * 1.35;
  const roll = -Math.pow(d / HOME.radius, 4) * 2.2;
  const bump = fbm2(x * 0.06, z * 0.06, 3, 2, 0.5, 21) * 0.5;
  return crown + roll + bump;
}

/** The keel underside of the home island. */
export function homeKeel(x: number, z: number): number {
  const d = Math.hypot(x, z);
  const t = Math.max(0, 1 - d / HOME.radius);
  const flute = valueNoise2(x * 0.10, z * 0.10, 7) * 2.6;
  return -HOME.keel * Math.pow(t, 0.55) - flute * t;
}

/* ------------------------------------------------------------------ *
 * The gates
 * ------------------------------------------------------------------ *
 * One floating island per world, arranged on an arc in front of the player so
 * the whole Vibeverse is legible in a single glance without turning around.
 */

export interface GateDef {
  key: string;
  /** Route to travel to. */
  to: string;
  name: string;
  blurb: string;
  /** Accent colour, hex. Drives the island's flora and its card. */
  accent: number;
  /** Silhouette archetype for the island's contents. */
  motif: "city" | "pagoda" | "tree" | "peak" | "ruin" | "dome" | "arch";
  /** Position on the arc, radians. 0 = straight ahead. */
  bearing: number;
  /** Distance from the home island, metres. */
  distance: number;
  /** Height relative to the platform. */
  elevation: number;
  /** Island footprint radius. */
  radius: number;
}

/**
 * The arc. Ordering is deliberate: the two flagship worlds sit dead ahead where
 * the eye lands first, and the rest fan out by how finished they are.
 */
export const GATES: GateDef[] = [
  {
    key: "island-2", to: "/island-2", name: "Vibe Island II",
    blurb: "A floating archipelago at golden hour.",
    accent: 0xffb347, motif: "tree", bearing: -0.16, distance: 108, elevation: 12, radius: 15,
  },
  {
    key: "sf", to: "/sf", name: "San Francisco",
    blurb: "The real city, hill for hill.",
    accent: 0xff6a2b, motif: "city", bearing: 0.30, distance: 122, elevation: 20, radius: 16,
  },
  {
    key: "san-palmas", to: "/san-palmas", name: "San Palmas",
    blurb: "Tropical city. Guns and sun.",
    accent: 0xffd23f, motif: "dome", bearing: -0.62, distance: 140, elevation: 4, radius: 13,
  },
  {
    key: "city", to: "/city", name: "Vibe City",
    blurb: "Neon district, jetpack included.",
    accent: 0xf0abfc, motif: "city", bearing: 0.74, distance: 150, elevation: 28, radius: 13,
  },
  {
    key: "edm-town", to: "/edm-town", name: "EDM Town",
    blurb: "Lasers, crowd, guestbook.",
    accent: 0xff2bd6, motif: "arch", bearing: -1.05, distance: 168, elevation: 34, radius: 12,
  },
  {
    key: "ski", to: "/city?spawn=ski", name: "Powder Peak",
    blurb: "Carve real slopes.",
    accent: 0xbfe9ff, motif: "peak", bearing: 1.14, distance: 176, elevation: 40, radius: 14,
  },
  {
    key: "garden", to: "/garden", name: "Memory Garden",
    blurb: "Walk among planted memories.",
    accent: 0x86efac, motif: "tree", bearing: -1.48, distance: 196, elevation: 16, radius: 12,
  },
  {
    key: "space", to: "/space", name: "Space Outpost",
    blurb: "A late-night show on an asteroid.",
    accent: 0x7dd3fc, motif: "ruin", bearing: 1.55, distance: 205, elevation: 52, radius: 11,
  },
  {
    key: "museum", to: "/museum", name: "Fractal Museum",
    blurb: "A walkable gallery of fractals.",
    accent: 0xfbcfe8, motif: "pagoda", bearing: -1.92, distance: 224, elevation: 24, radius: 11,
  },
  {
    key: "evolve", to: "/evolve", name: "Genesis Bloom",
    blurb: "Play a creature. Mutate. Survive.",
    accent: 0xa3e635, motif: "tree", bearing: 1.98, distance: 232, elevation: 8, radius: 11,
  },
];

export interface GatePos {
  x: number;
  y: number;
  z: number;
}

/** World position of a gate island's centre. */
export function gatePosition(g: GateDef): GatePos {
  // Bearing 0 is -Z (straight ahead from the spawn heading).
  return {
    x: Math.sin(g.bearing) * g.distance,
    y: g.elevation,
    z: -Math.cos(g.bearing) * g.distance,
  };
}

export const GATE_BY_KEY: Record<string, GateDef> = Object.fromEntries(
  GATES.map((g) => [g.key, g]),
);

/* ------------------------------------------------------------------ *
 * Ambience
 * ------------------------------------------------------------------ */

/** Distant background islands — pure silhouette, no gameplay meaning. */
export interface DriftIsland {
  x: number;
  y: number;
  z: number;
  radius: number;
  seed: number;
}

export const DRIFT: DriftIsland[] = Array.from({ length: 14 }, (_, i) => {
  // Deterministic scatter on a wide ring, biased above the horizon so they
  // read against the sky rather than getting lost in the cloud deck.
  const a = (i / 14) * Math.PI * 2 + 0.37;
  const r = 320 + valueNoise2(i * 3.1, 1.7, 99) * 520;
  return {
    x: Math.sin(a) * r,
    y: 40 + valueNoise2(i * 1.9, 5.3, 41) * 150,
    z: -Math.cos(a) * r,
    radius: 6 + valueNoise2(i * 7.7, 2.2, 13) * 16,
    seed: 100 + i * 17,
  };
});

/** Where the player stands when they arrive. */
export const SPAWN = { x: 0, y: 0, z: 9.5, heading: Math.PI } as const;

/** Camera framing for the lobby's default third-person view. */
export const LOBBY_CAMERA = {
  /** Distance behind the character. */
  distance: 9.0,
  /** Height above the platform. */
  height: 2.9,
  /** How far the camera looks above the character's feet. */
  lookHeight: 7.5,
  fov: 46,
} as const;
