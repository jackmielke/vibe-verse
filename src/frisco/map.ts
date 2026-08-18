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

/**
 * How far the world extends from the origin before the sea takes over.
 *
 * Both `minX` and `minZ` reach further than it looks like they need to, and
 * the reason is that they once did not. At -1250 and -1450 the map stopped
 * short of the whole north-west quarter of downtown: Fisherman's Wharf,
 * Aquatic Park, Russian Hill and the crooked block of Lombard Street were all
 * in `DISTRICTS`, `SPAWNS` or `OPEN_SPACES` and all sat past the edge of the
 * ground mesh. `maxZ` had the same hole in the other direction, with SoMa's
 * own centre off the south edge. Nothing failed. The generator simply never visited those
 * coordinates, so they were places you could be sent and could not stand —
 * and `SPAWNS` would happily send you.
 *
 * `friscoMap.test.ts` now walks all three lists against these numbers, which
 * is the only way this stays true: the bounds and the gazetteer are edited
 * months apart by people looking at different things.
 */
export const BOUNDS = {
  minX: -2000,
  maxX: 1400,
  minZ: -2200,
  maxZ: 2200,
  /* Ceiling for the jetpack. High enough to see the whole map from, and —
     since Salesforce Tower is 268 m of it — high enough to get above the
     tallest thing in the world rather than level with it. */
  skyCeiling: 560,
  seaLevel: 0,
} as const;

export const MAP_WIDTH = BOUNDS.maxX - BOUNDS.minX;
export const MAP_DEPTH = BOUNDS.maxZ - BOUNDS.minZ;
/** Corner to corner. What the camera and the sky dome have to clear. */
export const MAP_DIAGONAL = Math.hypot(MAP_WIDTH, MAP_DEPTH);

/**
 * How far from the origin the street grids have to be walked to reach every
 * corner of the map.
 *
 * Derived, because it was a literal — 1700, then 1800 in a second place — and
 * the moment the bounds grew, the grids stopped short of the new edges. The
 * result is not an error but something worse: the city simply ends, and the
 * outer ring of the map becomes bare hillside with a coastline on it, which
 * looks exactly like a deliberate green belt until you notice Fisherman's
 * Wharf is in it.
 */
export const GRID_REACH = Math.hypot(
  Math.max(-BOUNDS.minX, BOUNDS.maxX),
  Math.max(-BOUNDS.minZ, BOUNDS.maxZ),
);

/**
 * The camera's clip planes and the radius of the sky dome — here, in the file
 * that owns how big the world is, because that is the only thing they are
 * derived from.
 *
 * They used to be three literals in three files, and growing `minZ` to take in
 * Fisherman's Wharf silently pushed the map's diagonal past the dome: the sky
 * would have ended nearer than the far shore. `friscoMap.test.ts` caught it,
 * because it asserts the *relationships* rather than the numbers — the dome
 * outside the world so you can never fly to the edge of it, and inside the far
 * plane so it is never clipped away. A clipped dome renders as the clear
 * colour, which reads as "the world failed to load".
 *
 * The near plane stays at 0.4 for a third-person camera that has to get close
 * to a wall without slicing through the character. That makes the depth range
 * twelve thousand to one, which is far past what a conventional depth buffer
 * can hold — see `engine.ts` for why that is fine and what it cost to learn.
 */
export const VIEW = {
  near: 0.4,
  far: 7000,
  domeRadius: 6100,
} as const;

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
/**
 * Unit normal to Market, pointing north-west — toward the Financial District.
 *
 * The sign here is load-bearing and it is easy to get backwards, which is
 * exactly what happened first. With it flipped, `sideOfMarket` called the
 * Transamerica Pyramid "south of Market", the two street grids were built into
 * each other's halves of the city, and `buildBlocks` — which asks which side a
 * block is on before it fills it — rejected nearly every block it looked at.
 * The whole city rendered in one corner and was empty everywhere else, from a
 * single minus sign. `src/test/friscoMap.test.ts` now asserts it against real
 * addresses rather than against my arithmetic.
 *
 * Market runs south-west; +X is east and +Z is south, so the normal that
 * points into the Financial District is (-dir.z, +dir.x).
 */
export const MARKET_NORMAL: Vec2 = { x: -MARKET_DIR.z, z: MARKET_DIR.x };

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
/**
 * Alcatraz, as terrain rather than as scenery.
 *
 * The island is in the heightfield, not modelled on top of it, and that is
 * what makes it a *place*: `walkHeight`, `isWater`, the ground mesh, the tree
 * scatter and the player's collision all read the same function, so the rock
 * is solid the moment it exists and nothing has to be told about it. Building
 * it as a mesh instead would have given a beautiful island you sink through.
 *
 * See `LANDMARK_SITES` for why it is at 55% of its true distance.
 */
export const ALCATRAZ_PULL = 0.55;
const ALCATRAZ_TRUE = ll(37.8267, -122.423);
const ALCATRAZ = {
  x: ALCATRAZ_TRUE.x * ALCATRAZ_PULL,
  z: ALCATRAZ_TRUE.z * ALCATRAZ_PULL,
  radius: 118,
  height: 26,
};

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
  // The rock, after the shore ramp has finished pushing everything offshore
  // down to -6. Before it, and the bay would drown the island it just built.
  const ad = Math.hypot(x - ALCATRAZ.x, z - ALCATRAZ.z) / ALCATRAZ.radius;
  if (ad < 1) {
    const t = 0.5 + 0.5 * Math.cos(Math.PI * ad);
    h = Math.max(h, -6 + (ALCATRAZ.height + 6) * Math.pow(t, 0.75));
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
  | "civic"
  | "mission"
  | "hayes";

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
    /* Five wall colours rather than three, and two of them warm. A district
       palette of nothing but slate, navy glass and pale blue is correct about
       the new towers on Folsom and wrong about everything else, and SoMa is
       the biggest district on the map — from the air the southern third of the
       city was one continuous grey field. */
    radius: 520, minH: 14, maxH: 96, palette: [2, 10, 1, 0, 6], towerBias: 0.34,
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
  /* The two below are not downtown, and they are here because the map now
     reaches them. `districtAt` returns the *nearest* district to any point, so
     without them the whole south-western quarter was built to SoMa's rules:
     ninety-metre glass towers all the way out to the edge of a map whose real
     equivalent is three-storey Victorians. A district is how a place is built
     as much as it is a name. */
  {
    key: "mission", name: "The Mission", lat: 37.776, lon: -122.413,
    radius: 520, minH: 9, maxH: 24, palette: [7, 9, 6, 3], towerBias: 0.02,
  },
  {
    key: "hayes", name: "Hayes Valley", lat: 37.779, lon: -122.421,
    radius: 420, minH: 10, maxH: 26, palette: [6, 8, 9, 0], towerBias: 0.04,
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

/* ------------------------------------------------------------------ *
 * Landmarks
 * ------------------------------------------------------------------ */

/**
 * Where each landmark stands, and how much room the block generator has to
 * leave it.
 *
 * The *sites* live here and the *geometry* lives in `landmarks.ts`, which is
 * the same split as everything else in this world: `map.ts` is the only file
 * that knows where anything is. It also means the generic block filler and the
 * landmark builder cannot disagree about a footprint, which they would within
 * a week of being two lists — a generated tower growing up through the middle
 * of Grace Cathedral is not a bug anybody would think to look for.
 */
export interface LandmarkSite {
  key: string;
  name: string;
  lat: number;
  lon: number;
  /** Metres of clearance the generated city leaves around it. */
  footprint: number;
  /** Roughly how tall, for the map pin and the fly-to camera. */
  height: number;
  blurb: string;
  /**
   * Fraction of the true distance from the origin to place it at.
   *
   * Only Alcatraz uses this. Everything else in the city is where a map says
   * it is, and should stay that way.
   */
  pull?: number;
}

export const LANDMARK_SITES: LandmarkSite[] = [
  {
    key: "transamerica", name: "Transamerica Pyramid", lat: 37.7952, lon: -122.4028,
    footprint: 46, height: 240,
    blurb: "The one on the skyline. Two white wings and a spike you can stand on.",
  },
  {
    key: "salesforce", name: "Salesforce Tower", lat: 37.7897, lon: -122.3972,
    footprint: 44, height: 300,
    blurb: "The tallest thing for a thousand miles. Round, tapered, and always in the way of your photo.",
  },
  {
    key: "coit", name: "Coit Tower", lat: 37.8024, lon: -122.4058,
    footprint: 34, height: 64,
    blurb: "A fluted column on Telegraph Hill, paid for by a woman who liked firefighters.",
  },
  {
    key: "ferry", name: "Ferry Building", lat: 37.7955, lon: -122.3937,
    footprint: 66, height: 74,
    blurb: "The clock at the foot of Market. Everything downtown points at it.",
  },
  {
    key: "grace", name: "Grace Cathedral", lat: 37.7919, lon: -122.4133,
    footprint: 54, height: 52,
    blurb: "Twin towers on top of Nob Hill, with the whole city underneath.",
  },
  {
    key: "dragon", name: "Dragon Gate", lat: 37.7908, lon: -122.4058,
    footprint: 22, height: 14,
    blurb: "The green-tiled gate into Chinatown. Walk under it, that is the point.",
  },
  {
    key: "dewey", name: "Union Square", lat: 37.7879, lon: -122.4075,
    footprint: 40, height: 30,
    blurb: "Palms, a column with Victory on top, and shopping you cannot do.",
  },
  {
    key: "pier39", name: "Pier 39", lat: 37.8087, lon: -122.4098,
    footprint: 70, height: 16,
    blurb: "Sheds on stilts over the water. The sea lions got here first.",
  },
  {
    key: "lombard", name: "Lombard Street", lat: 37.8021, lon: -122.4187,
    footprint: 46, height: 8,
    blurb: "Eight switchbacks down Russian Hill. Try it without touching the flowers.",
  },
  {
    key: "cablecar", name: "Powell Street Turnaround", lat: 37.7857, lon: -122.4079,
    footprint: 22, height: 6,
    blurb: "Where they spin the cable car round by hand and everybody queues.",
  },
  {
    key: "baybridge", name: "Bay Bridge", lat: 37.7906, lon: -122.3888,
    footprint: 60, height: 160,
    blurb: "The other bridge. Longer, busier, and it holds the light better.",
  },
  {
    /* Alcatraz is real, and 3.7 km out — half again as far as this whole map
       is wide. So it is the one thing here placed on its true *bearing* at
       55% of its true distance, which is what `pull` means and what it is for.

       That is a compression and it is the right one. Putting the island where
       a ruler says leaves it outside the world: visible from the air, and
       impossible to land on, because the player is clamped to the map. A
       landmark you can see and cannot reach is a worse lie than a short swim.
       Pulled in, it still reads correctly — out past the wharf, off the north
       shore, alone in the bay — and you can fly to it, which is the entire
       point of having a jetpack. */
    key: "alcatraz", name: "Alcatraz", lat: 37.8267, lon: -122.423, pull: 0.55,
    footprint: 130, height: 44,
    blurb: "The rock. Nobody ever swam off it, and you can fly.",
  },
];

const LANDMARKS_W = LANDMARK_SITES.map((l) => {
  const p = ll(l.lat, l.lon);
  const k = l.pull ?? 1;
  return { ...l, x: p.x * k, z: p.z * k };
});

/** Every landmark, in world metres. */
export function landmarkPositions(): Array<LandmarkSite & Vec2> {
  return LANDMARKS_W;
}

/** True where the block generator must not put a building. */
export function isOpen(x: number, z: number): boolean {
  for (const o of OPEN_SPACES) {
    if (Math.hypot(x - o.x, z - o.z) < o.radius) return true;
  }
  for (const l of LANDMARKS_W) {
    if (Math.hypot(x - l.x, z - l.z) < l.footprint) return true;
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

/**
 * How far to the next junction, and which of the grid's axes you are on.
 *
 * This is what lets traffic stop at a red light without there being a road
 * network to stop on. The grid is a pure function — streets are the lines
 * `local X = n · spacingX` and `local Z = n · spacingZ` — so "where is the next
 * junction ahead of me" is a modulo, not a search, and it costs the same at
 * every point in the city whether there are two cars or two hundred.
 *
 * `axis` is 0 for a car travelling along the grid's local X and 1 for local Z.
 * A signal cycle only has to agree with those two numbers to make every
 * junction in a grid alternate together, which is what real signal timing on a
 * rectangular grid does anyway (it is how you get a green wave).
 *
 * `distance` is to the STOP LINE, not to the middle of the junction: the same
 * `roadHalfWidth + 5` offset that `buildCrossings` paints the zebra bars at, so
 * a car stops behind the crossing rather than on top of it.
 */
export interface StopAhead {
  /** Metres to the stop line. Negative means already into the junction. */
  distance: number;
  /** 0 = travelling along the grid's local X, 1 = along its local Z. */
  axis: 0 | 1;
}

export function stopLineAhead(x: number, z: number, dx: number, dz: number): StopAhead {
  const g = sideOfMarket(x, z) >= 0 ? GRID_N : GRID_S;
  const c = Math.cos(-g.angle);
  const s = Math.sin(-g.angle);
  const lx = x * c - z * s;
  const lz = x * s + z * c;
  const vx = dx * c - dz * s;
  const vz = dx * s + dz * c;
  // Whichever local axis the car is more aligned with is the one it runs along;
  // the junctions it meets are therefore spaced by the OTHER axis's period.
  const alongZ = Math.abs(vz) >= Math.abs(vx);
  const period = alongZ ? g.spacingZ : g.spacingX;
  // Measure forward: flip the coordinate so travel is always increasing, then
  // the gap to the next multiple is one modulo.
  const u = (alongZ ? lz : lx) * ((alongZ ? vz : vx) >= 0 ? 1 : -1);
  const gap = period - (((u % period) + period) % period);
  return { distance: gap - (g.roadHalfWidth + 5), axis: alongZ ? 1 : 0 };
}

/** Which grid axis a heading runs along at a point. See `stopLineAhead`. */
export function gridAxis(x: number, z: number, dx: number, dz: number): 0 | 1 {
  const g = sideOfMarket(x, z) >= 0 ? GRID_N : GRID_S;
  const c = Math.cos(-g.angle);
  const s = Math.sin(-g.angle);
  const vx = dx * c - dz * s;
  const vz = dx * s + dz * c;
  return Math.abs(vz) >= Math.abs(vx) ? 1 : 0;
}

/** True if a point is on asphalt. */
export function isRoad(x: number, z: number): boolean {
  const r = roadAt(x, z);
  return r.distance < r.halfWidth;
}

/**
 * Nudge a point onto the nearest piece of asphalt.
 *
 * Spawns are stored as the real lat/lon of a real place, which is the right way
 * to store them and lands you wherever that place happens to fall relative to
 * the generated street grid — quite often the middle of a block, between the
 * backs of four buildings, in a courtyard with no way out that reads as a bug
 * in the collision system. Fisherman's Wharf did exactly that.
 *
 * A spiral search rather than anything clever: the grid is a pure function, so
 * this is a few hundred cheap evaluations, once, at spawn time.
 */
export function snapToStreet(x: number, z: number): Vec2 {
  if (isRoad(x, z) && !isWater(x, z)) return { x, z };
  for (let r = 7; r <= 110; r += 7) {
    for (let a = 0; a < 16; a++) {
      const t = (a / 16) * Math.PI * 2 + r * 0.21;
      const px = x + Math.cos(t) * r;
      const pz = z + Math.sin(t) * r;
      if (isRoad(px, pz) && !isWater(px, pz)) return { x: px, z: pz };
    }
  }
  return { x, z };
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
    /* Facing away from the tower and down the hill. Pointing at it puts the
       third-person camera inside sixty metres of solid concrete, and the
       collision does the only thing it can — shoves the camera onto the back
       of the character's head. */
    key: "coit", name: "Coit Tower", lat: 37.802, lon: -122.4051,
    up: 0, heading: 5.55, blurb: "Top of Telegraph Hill. Jump off — that is what the jetpack is for.",
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
