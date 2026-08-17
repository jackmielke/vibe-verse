/**
 * map.ts — the plan of Vibe Francisco.
 *
 * This is downtown San Francisco, laid out from its real geography, and it is
 * the only file that knows where anything is. Everything else in this world
 * asks it questions.
 *
 * Two decisions shape the whole world and both are here:
 *
 * **1. It is a diorama, not a simulation.** The map is 2.4 km across and every
 * one of its buildings is built once, at load, and never touched again. /sf —
 * the photoreal San Francisco next door — streams a 9.8 km city through a
 * chunk queue with four levels of detail, and *that machinery* is where its
 * glitching came from: chunks arriving late, tiers cross-fading, impostor
 * tiles blinking. None of it exists here. There is no chunk queue to drain, no
 * LOD to swap, no budget to run out of, and so there is no class of bug where
 * the city changes while you look at it. A toy city you can hold in your hands
 * is one you can also hold in memory.
 *
 * **2. The layout is real.** Downtown San Francisco is two street grids that
 * collide along Market Street at 37 degrees, and that collision is the single
 * most recognisable thing about the place — the wedge blocks, the six-way
 * intersections, the way Market runs dead straight from the Ferry Building to
 * the hills. Getting it right costs one rotation matrix and it is the
 * difference between "a city" and "San Francisco". The grid north of Market
 * runs almost true north; the grid south of it is turned to meet Market square
 * on, with blocks twice the size. Both are anchored on real intersections.
 *
 * Everything is in metres, +X east, +Z south, Y up, origin at Montgomery &
 * Market — the same convention and the same origin as `src/sf/geo/sfGeo.ts`,
 * so a position means the same thing in both worlds.
 */

/* ------------------------------------------------------------------ *
 * Geodesy
 * ------------------------------------------------------------------ */

/** Montgomery & Market — world origin, shared with /sf. */
export const ORIGIN = { lat: 37.7936, lon: -122.4014 } as const;

const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

export interface Vec2 {
  x: number;
  z: number;
}

/** Real lat/lon → world metres. */
export function ll(lat: number, lon: number): Vec2 {
  return {
    x: (lon - ORIGIN.lon) * M_PER_DEG_LON,
    z: -(lat - ORIGIN.lat) * M_PER_DEG_LAT,
  };
}

/** How far the world extends from the origin before the sea takes over. */
export const BOUNDS = {
  minX: -1250,
  maxX: 1100,
  minZ: -1450,
  maxZ: 1150,
  /** Ceiling for the jetpack. High enough to see the whole map from. */
  skyCeiling: 430,
  seaLevel: 0,
} as const;

export const MAP_WIDTH = BOUNDS.maxX - BOUNDS.minX;
export const MAP_DEPTH = BOUNDS.maxZ - BOUNDS.minZ;

/* ------------------------------------------------------------------ *
 * The two grids
 * ------------------------------------------------------------------ */

/**
 * Market Street's bearing, radians, as an angle in the XZ plane.
 *
 * Measured off the real thing: the Ferry Building end at 37.7935,-122.3959 and
 * the Castro end at 37.7758,-122.4260. Everything else in this file is
 * expressed relative to it, because that is how the city itself is organised.
 */
const MARKET_A = ll(37.7935, -122.3959);
const MARKET_B = ll(37.7758, -122.426);
export const MARKET_ANGLE = Math.atan2(MARKET_B.z - MARKET_A.z, MARKET_B.x - MARKET_A.x);

/** A point on Market, and the unit vector along it (pointing south-west). */
export const MARKET_ORIGIN: Vec2 = { x: 0, z: 0 };
export const MARKET_DIR: Vec2 = {
  x: Math.cos(MARKET_ANGLE),
  z: Math.sin(MARKET_ANGLE),
};
/** Unit normal to Market, pointing north-west (toward the Financial District). */
export const MARKET_NORMAL: Vec2 = { x: MARKET_DIR.z, z: -MARKET_DIR.x };

/** Signed distance from Market's centreline. Positive = north of Market. */
export function sideOfMarket(x: number, z: number): number {
  return (x - MARKET_ORIGIN.x) * MARKET_NORMAL.x + (z - MARKET_ORIGIN.z) * MARKET_NORMAL.z;
}

/** Distance ALONG Market from the origin. Positive = toward the hills. */
export function alongMarket(x: number, z: number): number {
  return (x - MARKET_ORIGIN.x) * MARKET_DIR.x + (z - MARKET_ORIGIN.z) * MARKET_DIR.z;
}

export const MARKET_HALF_WIDTH = 17;

/**
 * The downtown grid, north of Market.
 *
 * Montgomery Street runs 37.7907,-122.4028 → 37.7975,-122.4032: within three
 * degrees of true north. Blocks are the real ones — 275 × 412 feet, the
 * shortest blocks in the city, which is why downtown SF feels dense on foot.
 */
export const GRID_N = {
  angle: -0.045,
  /** Along-street spacing (north-south streets, e.g. Montgomery). */
  spacingX: 84,
  /** Cross-street spacing (east-west, e.g. Bush, Pine, California). */
  spacingZ: 126,
  roadHalfWidth: 9,
} as const;

/**
 * South of Market the grid turns to meet Market square on and the blocks
 * double: 550 × 825 feet. That is why SoMa reads as a different city — it was
 * laid out by a different surveyor in a different decade, and never
 * reconciled.
 */
export const GRID_S = {
  angle: MARKET_ANGLE,
  spacingX: 168,
  spacingZ: 251,
  roadHalfWidth: 11,
} as const;

/* ------------------------------------------------------------------ *
 * Hills
 * ------------------------------------------------------------------ */

export interface Hill {
  name: string;
  /** Real summit. */
  lat: number;
  lon: number;
  /** Real height in metres, before the toy exaggeration below. */
  height: number;
  /** Radius at which the hill has flattened out. */
  radius: number;
  /** >1 makes a sharper peak, <1 a broader dome. */
  sharpness: number;
}

/**
 * The hills, at their real heights.
 *
 * `HILL_GAIN` is the one deliberate lie in this file. San Francisco's hills are
 * genuinely steep — Nob Hill climbs 100 m in four blocks — but a toy city wants
 * you to *see* that from across the map, and at 1:1 from a jetpack it reads as
 * a gentle swell. A third again is enough that the streets visibly roll and
 * Coit Tower stands over North Beach the way it does in your memory of it,
 * which is taller than it is in life.
 */
export const HILL_GAIN = 1.34;

export const HILLS: Hill[] = [
  { name: "Nob Hill", lat: 37.793, lon: -122.4161, height: 103, radius: 470, sharpness: 1.4 },
  { name: "Russian Hill", lat: 37.801, lon: -122.4189, height: 90, radius: 430, sharpness: 1.5 },
  { name: "Telegraph Hill", lat: 37.8024, lon: -122.4058, height: 84, radius: 290, sharpness: 1.9 },
  { name: "Rincon Hill", lat: 37.7852, lon: -122.3903, height: 30, radius: 330, sharpness: 1.2 },
  { name: "Cathedral Hill", lat: 37.7856, lon: -122.4242, height: 66, radius: 380, sharpness: 1.2 },
];

interface HillW extends Hill {
  wx: number;
  wz: number;
}

const HILLS_W: HillW[] = HILLS.map((h) => {
  const p = ll(h.lat, h.lon);
  return { ...h, wx: p.x, wz: p.z };
});

/* ------------------------------------------------------------------ *
 * Shoreline
 * ------------------------------------------------------------------ */

/**
 * The Embarcadero seawall, traced from the real waterfront.
 *
 * Land is inside this polyline (to the west/south of it); the bay is outside.
 * A polyline rather than an SDF blob because the waterfront is the one edge of
 * downtown you walk along, and it needs to be exactly where the piers are.
 */
const SHORE_LL: [number, number][] = [
  [37.8103, -122.4192], // Aquatic Park
  [37.8085, -122.4155], // Hyde St Pier
  [37.8087, -122.4098], // Pier 39
  [37.8067, -122.4048], // Pier 27
  [37.8024, -122.3985], // Pier 15 / Exploratorium
  [37.7955, -122.3927], // Ferry Building
  [37.7906, -122.3886], // Rincon Park
  [37.7863, -122.3874], // Bay Bridge landing
  [37.7818, -122.3877], // South Beach
  [37.7785, -122.3874], // Oracle Park
  [37.7745, -122.3893], // Mission Creek
];

export const SHORE: Vec2[] = SHORE_LL.map(([la, lo]) => ll(la, lo));

/**
 * Signed distance to the shoreline: positive on land, negative in the bay.
 *
 * The polyline is open, so "inside" is decided by which side of the nearest
 * segment the point falls on, with the segments wound so that land is to the
 * left. That is enough for a waterfront that never doubles back on itself, and
 * it is O(segments) with eleven segments.
 */
export function shoreSDF(x: number, z: number): number {
  let best = Infinity;
  let sign = 1;
  for (let i = 0; i < SHORE.length - 1; i++) {
    const a = SHORE[i];
    const b = SHORE[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      // Cross product: land is on the left of the direction of travel.
      sign = (x - a.x) * dz - (z - a.z) * dx > 0 ? -1 : 1;
    }
  }
  return best * sign;
}

/* ------------------------------------------------------------------ *
 * Terrain
 * ------------------------------------------------------------------ */

/**
 * Ground height at a point.
 *
 * Deterministic, cheap, and with no noise in it at all — which is unusual and
 * deliberate. Procedural noise is what makes photoreal terrain convincing and
 * what makes toy terrain look mouldy; a diorama wants surfaces that read as
 * *made*, so the ground here is exactly the sum of five hills and a beach
 * ramp, and nothing else. It is also why the streets can be laid flat on it
 * without a single seam.
 */
export function groundHeight(x: number, z: number): number {
  let h = 2.5;
  for (const hill of HILLS_W) {
    const d = Math.hypot(x - hill.wx, z - hill.wz) / hill.radius;
    if (d >= 1) continue;
    // Smooth cosine dome, sharpened toward a peak.
    const t = 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, d));
    h += hill.height * HILL_GAIN * Math.pow(t, hill.sharpness);
  }
  // Ramp down into the bay so the shoreline is a beach, not a cliff.
  const s = shoreSDF(x, z);
  if (s < 60) {
    const t = Math.max(0, Math.min(1, (s + 30) / 90));
    h = h * t + (1 - t) * -6;
  }
  return h;
}

/** Ground height clamped to sea level — what a walking character stands on. */
export function walkHeight(x: number, z: number): number {
  return Math.max(groundHeight(x, z), BOUNDS.seaLevel);
}

/** True if the point is in the bay. */
export function isWater(x: number, z: number): boolean {
  return groundHeight(x, z) < BOUNDS.seaLevel;
}

/** Keep a position on the map. */
export function clampToMap(x: number, z: number): Vec2 {
  return {
    x: Math.max(BOUNDS.minX + 20, Math.min(BOUNDS.maxX - 20, x)),
    z: Math.max(BOUNDS.minZ + 20, Math.min(BOUNDS.maxZ - 20, z)),
  };
}

/* ------------------------------------------------------------------ *
 * Districts
 * ------------------------------------------------------------------ */

export type DistrictKey =
  | "financial"
  | "chinatown"
  | "northbeach"
  | "nobhill"
  | "russianhill"
  | "union"
  | "soma"
  | "embarcadero"
  | "wharf"
  | "civic";

export interface District {
  key: DistrictKey;
  name: string;
  lat: number;
  lon: number;
  radius: number;
  /** Typical building height range, metres. Toy proportions, real ordering. */
  minH: number;
  maxH: number;
  /** Palette indices into `PALETTE.walls`. */
  palette: number[];
  /** 0..1 — how likely a block is a tower rather than a low building. */
  towerBias: number;
}

export const DISTRICTS: District[] = [
  {
    key: "financial", name: "Financial District", lat: 37.7929, lon: -122.4003,
    radius: 420, minH: 34, maxH: 140, palette: [0, 1, 2], towerBias: 0.72,
  },
  {
    key: "chinatown", name: "Chinatown", lat: 37.7941, lon: -122.4078,
    radius: 240, minH: 12, maxH: 26, palette: [3, 4, 5], towerBias: 0.05,
  },
  {
    key: "northbeach", name: "North Beach", lat: 37.8003, lon: -122.4104,
    radius: 300, minH: 10, maxH: 22, palette: [6, 7, 3], towerBias: 0.03,
  },
  {
    key: "nobhill", name: "Nob Hill", lat: 37.7924, lon: -122.4145,
    radius: 300, minH: 16, maxH: 46, palette: [8, 6, 9], towerBias: 0.22,
  },
  {
    key: "russianhill", name: "Russian Hill", lat: 37.8009, lon: -122.4185,
    radius: 280, minH: 12, maxH: 30, palette: [7, 6, 8], towerBias: 0.08,
  },
  {
    key: "union", name: "Union Square", lat: 37.7879, lon: -122.4075,
    radius: 260, minH: 22, maxH: 62, palette: [9, 8, 0], towerBias: 0.35,
  },
  {
    key: "soma", name: "SoMa", lat: 37.7815, lon: -122.3968,
    radius: 520, minH: 14, maxH: 96, palette: [2, 10, 1], towerBias: 0.34,
  },
  {
    key: "embarcadero", name: "Embarcadero", lat: 37.7955, lon: -122.396,
    radius: 300, minH: 16, maxH: 84, palette: [1, 0, 10], towerBias: 0.4,
  },
  {
    key: "wharf", name: "Fisherman's Wharf", lat: 37.8073, lon: -122.4152,
    radius: 320, minH: 8, maxH: 18, palette: [4, 7, 6], towerBias: 0.0,
  },
  {
    key: "civic", name: "Civic Center", lat: 37.7793, lon: -122.4177,
    radius: 300, minH: 14, maxH: 40, palette: [8, 9, 6], towerBias: 0.12,
  },
];

const DISTRICTS_W = DISTRICTS.map((d) => ({ ...d, ...ll(d.lat, d.lon) }));

/** Nearest district, and how strongly this point belongs to it (0..1). */
export function districtAt(x: number, z: number): { district: District; weight: number } {
  let best = DISTRICTS_W[0];
  let bestScore = -Infinity;
  for (const d of DISTRICTS_W) {
    const dist = Math.hypot(x - d.x, z - d.z);
    const score = 1 - dist / d.radius;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return { district: best, weight: Math.max(0, Math.min(1, bestScore)) };
}

/* ------------------------------------------------------------------ *
 * Open space — the places the block generator must leave alone
 * ------------------------------------------------------------------ */

export interface OpenSpace {
  x: number;
  z: number;
  radius: number;
  kind: "park" | "plaza" | "landmark" | "water";
  name: string;
}

function open(name: string, kind: OpenSpace["kind"], lat: number, lon: number, radius: number): OpenSpace {
  return { ...ll(lat, lon), radius, kind, name };
}

export const OPEN_SPACES: OpenSpace[] = [
  open("Union Square", "plaza", 37.7879, -122.4075, 78),
  open("Portsmouth Square", "park", 37.7952, -122.4055, 62),
  open("Washington Square", "park", 37.8006, -122.4103, 78),
  open("Huntington Park", "park", 37.7923, -122.4128, 52),
  open("Justin Herman Plaza", "plaza", 37.7947, -122.3948, 74),
  open("Yerba Buena Gardens", "park", 37.7847, -122.4025, 96),
  open("Rincon Park", "park", 37.7906, -122.3893, 60),
  open("Aquatic Park", "park", 37.8078, -122.4222, 110),
  open("Transamerica Redwood Park", "park", 37.7951, -122.4018, 34),
];

/** True where the block generator must not put a building. */
export function isOpen(x: number, z: number): boolean {
  for (const o of OPEN_SPACES) {
    if (Math.hypot(x - o.x, z - o.z) < o.radius) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Streets
 * ------------------------------------------------------------------ */

/**
 * Distance to the nearest street centreline, and which grid it belongs to.
 *
 * Rather than storing a road network, the grid IS the function: rotate into
 * the grid's frame and the distance to the nearest street is the distance to
 * the nearest multiple of the spacing. Market is handled separately because it
 * is the seam, and the Embarcadero because it follows the shore rather than
 * either grid.
 */
export interface RoadHit {
  /** Distance to the centreline, metres. */
  distance: number;
  /** Half-width of that road. */
  halfWidth: number;
  /** Direction of the road at that point, unit. */
  dir: Vec2;
  kind: "market" | "grid-n" | "grid-s" | "embarcadero";
}

function gridDistance(
  x: number,
  z: number,
  angle: number,
  spacingX: number,
  spacingZ: number,
): { d: number; dir: Vec2 } {
  const c = Math.cos(-angle);
  const s = Math.sin(-angle);
  const lx = x * c - z * s;
  const lz = x * s + z * c;
  const dx = Math.abs(lx - Math.round(lx / spacingX) * spacingX);
  const dz = Math.abs(lz - Math.round(lz / spacingZ) * spacingZ);
  // Whichever centreline is nearer decides the direction of travel.
  const ci = Math.cos(angle);
  const si = Math.sin(angle);
  if (dx < dz) {
    // A north-south street: runs along local +Z.
    return { d: dx, dir: { x: -si, z: ci } };
  }
  return { d: dz, dir: { x: ci, z: si } };
}

export function roadAt(x: number, z: number): RoadHit {
  const side = sideOfMarket(x, z);
  const along = alongMarket(x, z);

  // Market itself, but only along its real extent.
  const marketD = Math.abs(side);
  const onMarket = along > -900 && along < 1500;

  let best: RoadHit = {
    distance: onMarket ? marketD : Infinity,
    halfWidth: MARKET_HALF_WIDTH,
    dir: MARKET_DIR,
    kind: "market",
  };

  const g = side >= 0 ? GRID_N : GRID_S;
  const kind: RoadHit["kind"] = side >= 0 ? "grid-n" : "grid-s";
  const hit = gridDistance(x, z, g.angle, g.spacingX, g.spacingZ);
  if (hit.d < best.distance) {
    best = { distance: hit.d, halfWidth: g.roadHalfWidth, dir: hit.dir, kind };
  }

  // The Embarcadero, which follows the seawall instead of any grid.
  const s = shoreSDF(x, z);
  const embD = Math.abs(s - 26);
  if (embD < best.distance) {
    best = { distance: embD, halfWidth: 13, dir: { x: 1, z: 0 }, kind: "embarcadero" };
  }

  return best;
}

/** True if a point is on asphalt. */
export function isRoad(x: number, z: number): boolean {
  const r = roadAt(x, z);
  return r.distance < r.halfWidth;
}

/** True if a point is on the pavement beside a road. */
export function isSidewalk(x: number, z: number): boolean {
  const r = roadAt(x, z);
  return r.distance >= r.halfWidth && r.distance < r.halfWidth + 4.5;
}

/* ------------------------------------------------------------------ *
 * Spawns
 * ------------------------------------------------------------------ */

export interface Spawn {
  key: string;
  name: string;
  lat: number;
  lon: number;
  /** Metres above the ground. 0 = standing. */
  up: number;
  heading: number;
  blurb: string;
}

export const SPAWNS: Spawn[] = [
  {
    key: "market", name: "Market & Montgomery", lat: 37.7936, lon: -122.4014,
    up: 0, heading: 2.2, blurb: "The middle of it all. Towers up the street, water down it.",
  },
  {
    key: "coit", name: "Coit Tower", lat: 37.8024, lon: -122.4058,
    up: 0, heading: 2.4, blurb: "Top of Telegraph Hill. Jump off — that is what the jetpack is for.",
  },
  {
    key: "ferry", name: "Ferry Building", lat: 37.7955, lon: -122.3937,
    up: 0, heading: 4.4, blurb: "The clock tower and the whole waterfront.",
  },
  {
    key: "lombard", name: "Lombard Street", lat: 37.8021, lon: -122.4187,
    up: 0, heading: 1.6, blurb: "The crooked block. Try it without touching the flowers.",
  },
  {
    key: "union", name: "Union Square", lat: 37.7879, lon: -122.4075,
    up: 0, heading: 1.1, blurb: "Palms, the column, and shopping you cannot do.",
  },
  {
    key: "wharf", name: "Fisherman's Wharf", lat: 37.8073, lon: -122.4152,
    up: 0, heading: 3.0, blurb: "Sea lions, crab signs, and Alcatraz out there.",
  },
  {
    key: "transamerica", name: "Top of the Pyramid", lat: 37.7952, lon: -122.4028,
    up: 232, heading: 1.1, blurb: "The very tip. Long way down.",
  },
];
