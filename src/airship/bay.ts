/**
 * Pathfinder — the Bay, as a function.
 *
 * San Francisco Bay at about a third of its real size, so a 400-foot airship
 * doing thirty knots crosses it in minutes rather than an hour. Every land
 * mass is a smooth blob and every blob is listed here, so the terrain mesh,
 * the buildings, the drop zones and the water all read the same map. Heights
 * are real-ish: the Marin Headlands are tall, Treasure Island is flat, and
 * the East Bay is one long ridge.
 *
 * Axes: x runs east, z runs south. The Golden Gate is at the north-west.
 */
export interface Blob {
  x: number;
  z: number;
  /** Radius, metres. */
  r: number;
  /** Peak height, metres. */
  h: number;
  /** Stretch along x relative to z. */
  ax?: number;
  rot?: number;
}

export const LAND: Blob[] = [
  // San Francisco: the peninsula's north end, with hills.
  { x: -900, z: 1200, r: 1300, h: 40, ax: 1.0 },
  { x: -1100, z: 1500, r: 500, h: 210 }, // Twin Peaks
  { x: -700, z: 900, r: 260, h: 90 }, // Nob / Russian Hill
  { x: -1300, z: 800, r: 320, h: 120 }, // Presidio
  // The peninsula continuing south.
  { x: -800, z: 2600, r: 1500, h: 60, ax: 0.8 },
  { x: -1500, z: 3400, r: 1400, h: 260, ax: 0.7 },
  // Marin.
  { x: -1300, z: -600, r: 900, h: 200, ax: 1.2 }, // Headlands
  { x: -600, z: -1300, r: 900, h: 260, ax: 1.0 }, // Mount Tam shoulder
  { x: -200, z: -700, r: 380, h: 60 }, // Sausalito / Tiburon
  { x: 300, z: -1500, r: 800, h: 90, ax: 1.3 },
  // East Bay: a long ridge.
  { x: 2300, z: 200, r: 1700, h: 40, ax: 0.55 },
  { x: 2900, z: 0, r: 1300, h: 320, ax: 0.35 }, // Berkeley / Oakland hills
  { x: 2500, z: 2400, r: 1600, h: 40, ax: 0.6 },
  { x: 2000, z: 3800, r: 1800, h: 60, ax: 0.9 },
  // Islands.
  { x: 300, z: 300, r: 190, h: 40 }, // Alcatraz
  { x: 600, z: -300, r: 420, h: 170 }, // Angel Island
  { x: 900, z: 900, r: 330, h: 8, ax: 0.6 }, // Treasure Island
  { x: 950, z: 1250, r: 180, h: 80 }, // Yerba Buena
  // South Bay, where Moffett is.
  { x: 900, z: 5200, r: 2600, h: 30, ax: 1.4 },
];

function blobHeight(b: Blob, x: number, z: number): number {
  const dx = (x - b.x) / (b.ax ?? 1);
  const dz = z - b.z;
  const d = Math.sqrt(dx * dx + dz * dz) / b.r;
  if (d >= 1) return 0;
  const t = 1 - d;
  // Smooth dome with a flatter top than a cosine — islands are not cones.
  return b.h * t * t * (3 - 2 * t);
}

function hash(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/** Ground height in metres; below zero is water. */
export function bayHeight(x: number, z: number): number {
  let h = -12;
  for (const b of LAND) h += blobHeight(b, x, z);
  // Folds, only where there is land to fold.
  if (h > 0) h += (vnoise(x * 0.004, z * 0.004) - 0.5) * Math.min(60, h * 0.6);
  return h;
}

export const isWater = (x: number, z: number): boolean => bayHeight(x, z) < 0;

export interface Landmark {
  name: string;
  x: number;
  z: number;
}

/** Where the cargo goes. Each is a real place with a story this week. */
export interface DropZone extends Landmark {
  /** What the pallet is. */
  cargo: string;
  /** One line about why. */
  why: string;
}

export const DROPS: DropZone[] = [
  {
    name: "Sausalito",
    x: -200,
    z: -560,
    cargo: "Water, 2 tonnes",
    why: "The marine layer took the road out. Boats are full.",
  },
  {
    name: "Alcatraz",
    x: 300,
    z: 300,
    cargo: "Generators",
    why: "Island power went with the storm. The rangers are still there.",
  },
  {
    name: "Treasure Island",
    x: 900,
    z: 900,
    cargo: "Shelter kits, 40",
    why: "Flat, exposed, and the ferry is not running.",
  },
  {
    name: "Angel Island",
    x: 600,
    z: -300,
    cargo: "Medical, cold chain",
    why: "A camp on the north shore. Cold chain, so land gently.",
  },
  {
    name: "Berkeley Marina",
    x: 1650,
    z: 250,
    cargo: "Food, 3 tonnes",
    why: "Pathfinder's heaviest lift. Vent early on the way down.",
  },
];

/** Where you start and where you bring her home. */
export const MOFFETT: Landmark = { name: "Moffett Field, Hangar One", x: 900, z: 4700 };

export const BRIDGES = {
  goldenGate: { x1: -1180, z1: 340, x2: -1160, z2: -260, height: 227 * 0.6, deck: 67 * 0.6 },
  bayBridgeWest: { x1: -520, z1: 1120, x2: 880, z2: 1180, height: 160 * 0.6, deck: 60 * 0.6 },
  bayBridgeEast: { x1: 1020, z1: 1160, x2: 2050, z2: 1240, height: 120 * 0.6, deck: 45 * 0.6 },
};
