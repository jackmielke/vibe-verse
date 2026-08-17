/**
 * sfGeo — the single spatial source of truth for San Francisco: FREE FALL.
 *
 * Every other system (terrain mesh, building generator, road network, traffic,
 * water, AI navigation, minimap, physics heightfield) reads the world through
 * this module. Nothing else is allowed to invent its own idea of where the
 * ground is or where the bay starts, because the moment two systems disagree
 * you get cars driving through hills and skyscrapers standing in the water.
 *
 * Coordinate system
 * -----------------
 *   1 world unit = 1 metre.
 *   +X = east, +Z = south, +Y = up.  (So north is -Z; three.js default.)
 *   Origin (0,0) = Montgomery & Market, the heart of the Financial District.
 *
 * The map is real San Francisco geometry sampled from actual coordinates —
 * the street grid's famous 42-degree kink at Market Street, the seven hills
 * with their true heights, the bay shoreline, and every landmark placed at
 * its genuine lat/lon. It is not "a city that feels like SF"; it is SF.
 */
import { clamp, clamp01, fbm2, smoothstep } from "../math/rng";
import { SPAWN_DEFS } from "./spawnList";

/* ------------------------------------------------------------------ *
 * Geodesy
 * ------------------------------------------------------------------ */

/** Montgomery & Market — world origin. */
export const SF_ORIGIN = { lat: 37.7936, lon: -122.4014 } as const;

const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((SF_ORIGIN.lat * Math.PI) / 180);

export interface Vec2 {
  x: number;
  z: number;
}

/** Real-world lat/lon → world metres. */
export function latLonToWorld(lat: number, lon: number): Vec2 {
  return {
    x: (lon - SF_ORIGIN.lon) * M_PER_DEG_LON,
    z: -(lat - SF_ORIGIN.lat) * M_PER_DEG_LAT,
  };
}

/** World metres → real-world lat/lon (for the map screen + share links). */
export function worldToLatLon(x: number, z: number): { lat: number; lon: number } {
  return {
    lat: SF_ORIGIN.lat - z / M_PER_DEG_LAT,
    lon: SF_ORIGIN.lon + x / M_PER_DEG_LON,
  };
}

/* ------------------------------------------------------------------ *
 * World bounds
 * ------------------------------------------------------------------ *
 * From the Golden Gate in the northwest down past Twin Peaks and out to the
 * Bay Bridge. Roughly 9.5 km × 9.5 km of playable space.
 */
export const WORLD = {
  // These must actually contain everything this file places. An earlier pass
  // set them by eye from the downtown skyline and they quietly excluded the
  // south and west of the city: real Bayview sits at z ~ 7080 and Ocean Beach
  // at x ~ -9600, so four missions and three districts were being generated
  // outside the world they belong to. Widened to hold the whole peninsula plus
  // the offshore approaches the wingsuit and boat routes use.
  minX: -10200,
  maxX: 2600,
  minZ: -5200,
  maxZ: 7800,
  /** Sea level. Everything below this is bay/ocean. */
  seaLevel: 0,
  /** Ceiling used by the wingsuit, aircraft and the fog/atmosphere solver. */
  skyCeiling: 2400,
} as const;

export const WORLD_SIZE_X = WORLD.maxX - WORLD.minX;
export const WORLD_SIZE_Z = WORLD.maxZ - WORLD.minZ;

/* ------------------------------------------------------------------ *
 * Topography — San Francisco's real hills
 * ------------------------------------------------------------------ *
 * SF is famously built on hills, and the hills *are* the level design: they
 * create the sightlines, the vertical streets, the rooftop-to-rooftop grapple
 * routes. Each entry is a real summit at its real elevation in metres.
 */
interface Hill {
  name: string;
  lat: number;
  lon: number;
  /** Summit elevation, metres above sea level. */
  height: number;
  /** Radius at which the hill has fallen to ~0, metres. */
  radius: number;
  /** >1 = steeper shoulders (SF hills are steep), <1 = gentler. */
  sharpness: number;
  /** Anisotropy: ridge direction in radians and how elongated, for ridge-like hills. */
  ridgeAngle?: number;
  ridgeStretch?: number;
}

const HILLS: Hill[] = [
  { name: "Twin Peaks", lat: 37.7544, lon: -122.4477, height: 282, radius: 1250, sharpness: 1.35, ridgeAngle: 0.35, ridgeStretch: 1.7 },
  { name: "Mount Davidson", lat: 37.7381, lon: -122.4541, height: 283, radius: 1050, sharpness: 1.3 },
  { name: "Mount Sutro", lat: 37.7601, lon: -122.4577, height: 274, radius: 780, sharpness: 1.4 },
  { name: "Buena Vista", lat: 37.7686, lon: -122.4413, height: 175, radius: 520, sharpness: 1.5 },
  { name: "Corona Heights", lat: 37.7654, lon: -122.4383, height: 156, radius: 380, sharpness: 1.7 },
  { name: "Bernal Heights", lat: 37.7433, lon: -122.4160, height: 141, radius: 700, sharpness: 1.25 },
  { name: "Potrero Hill", lat: 37.7576, lon: -122.4013, height: 91, radius: 780, sharpness: 1.15 },
  { name: "Pacific Heights", lat: 37.7924, lon: -122.4350, height: 113, radius: 900, sharpness: 1.2, ridgeAngle: 1.5708, ridgeStretch: 1.8 },
  { name: "Lone Mountain", lat: 37.7796, lon: -122.4508, height: 134, radius: 520, sharpness: 1.35 },
  { name: "Nob Hill", lat: 37.7930, lon: -122.4161, height: 103, radius: 480, sharpness: 1.45 },
  { name: "Russian Hill", lat: 37.8010, lon: -122.4189, height: 90, radius: 440, sharpness: 1.5 },
  { name: "Telegraph Hill", lat: 37.8024, lon: -122.4058, height: 84, radius: 300, sharpness: 1.9 },
  { name: "Rincon Hill", lat: 37.7852, lon: -122.3903, height: 30, radius: 340, sharpness: 1.2 },
  { name: "Presidio Ridge", lat: 37.7975, lon: -122.4640, height: 112, radius: 900, sharpness: 1.1, ridgeAngle: 0.2, ridgeStretch: 1.6 },
  { name: "Lands End", lat: 37.7830, lon: -122.5050, height: 120, radius: 700, sharpness: 1.3 },
  { name: "Marin Headlands", lat: 37.8290, lon: -122.4970, height: 290, radius: 1700, sharpness: 1.15, ridgeAngle: 0.9, ridgeStretch: 1.5 },
];

interface HillW extends Hill {
  wx: number;
  wz: number;
  cos: number;
  sin: number;
  stretch: number;
}

const HILLS_W: HillW[] = HILLS.map((h) => {
  const p = latLonToWorld(h.lat, h.lon);
  const a = h.ridgeAngle ?? 0;
  return {
    ...h,
    wx: p.x,
    wz: p.z,
    cos: Math.cos(a),
    sin: Math.sin(a),
    stretch: h.ridgeStretch ?? 1,
  };
});

/** Named summits, exposed so the world can put a viewpoint on each one. */
export const SUMMITS = HILLS_W.map((h) => ({
  name: h.name,
  x: h.wx,
  z: h.wz,
  height: h.height,
}));

/* ------------------------------------------------------------------ *
 * Shoreline
 * ------------------------------------------------------------------ *
 * The San Francisco peninsula traced from its real coastline, plus the
 * islands and the Marin shore the Golden Gate Bridge lands on.
 */

type LatLonRing = readonly (readonly [number, number])[];

/** The peninsula, traced clockwise from the Golden Gate. */
const PENINSULA_LL: LatLonRing = [
  [37.8106, -122.4776], // Fort Point, under the bridge
  [37.8090, -122.4700],
  [37.8078, -122.4620], // Crissy Field
  [37.8065, -122.4520], // Marina Green west
  [37.8072, -122.4430], // Marina Green
  [37.8068, -122.4330], // Fort Mason
  [37.8090, -122.4260], // Aquatic Park
  [37.8095, -122.4180], // Hyde Street Pier
  [37.8098, -122.4120], // Pier 39
  [37.8075, -122.4030], // Pier 27
  [37.8020, -122.3960], // Pier 15
  [37.7955, -122.3925], // Ferry Building
  [37.7908, -122.3878], // Bay Bridge landing
  [37.7855, -122.3866], // South Beach
  [37.7805, -122.3880], // McCovey Cove
  [37.7760, -122.3865], // Mission Bay
  [37.7700, -122.3855],
  [37.7620, -122.3830], // Dogpatch
  [37.7500, -122.3780], // Islais Creek
  [37.7350, -122.3760], // Hunters Point
  [37.7220, -122.3900],
  [37.7080, -122.4020], // Candlestick / south edge
  [37.7060, -122.4600],
  [37.7080, -122.5040], // Fort Funston
  [37.7250, -122.5100], // Ocean Beach south
  [37.7500, -122.5110], // Ocean Beach
  [37.7720, -122.5115], // Ocean Beach north
  [37.7830, -122.5110], // Cliff House
  [37.7870, -122.5060], // Lands End
  [37.7900, -122.4990],
  [37.7960, -122.4900], // Baker Beach
  [37.8030, -122.4830],
  [37.8080, -122.4790],
];

/** Marin, north of the Golden Gate — the far tower's anchor. */
const MARIN_LL: LatLonRing = [
  [37.8330, -122.4790], // Fort Baker
  [37.8300, -122.4700],
  [37.8340, -122.4600],
  [37.8500, -122.4620],
  [37.8600, -122.4900],
  [37.8560, -122.5200],
  [37.8330, -122.5250],
  [37.8250, -122.5000],
  [37.8258, -122.4830], // south tower footing side
];

const ALCATRAZ_LL: LatLonRing = [
  [37.8280, -122.4245],
  [37.8272, -122.4200],
  [37.8250, -122.4198],
  [37.8244, -122.4235],
  [37.8262, -122.4258],
];

const TREASURE_ISLAND_LL: LatLonRing = [
  [37.8290, -122.3760],
  [37.8290, -122.3640],
  [37.8180, -122.3620],
  [37.8130, -122.3700],
  [37.8180, -122.3790],
];

const YERBA_BUENA_LL: LatLonRing = [
  [37.8130, -122.3700],
  [37.8125, -122.3595],
  [37.8055, -122.3585],
  [37.8045, -122.3690],
];

const ANGEL_ISLAND_LL: LatLonRing = [
  [37.8700, -122.4400],
  [37.8700, -122.4180],
  [37.8560, -122.4130],
  [37.8500, -122.4300],
  [37.8580, -122.4450],
];

function ringToWorld(ring: LatLonRing): Vec2[] {
  return ring.map(([lat, lon]) => latLonToWorld(lat, lon));
}

export interface Landmass {
  name: string;
  ring: Vec2[];
  /** Axis-aligned bounds for fast rejection. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Baseline elevation the interior lifts toward, metres. */
  baseHeight: number;
  /** How far inland the beach/cliff ramp extends, metres. */
  shoreRamp: number;
}

function makeLandmass(
  name: string,
  ll: LatLonRing,
  baseHeight: number,
  shoreRamp: number,
): Landmass {
  const ring = ringToWorld(ll);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { name, ring, minX, maxX, minZ, maxZ, baseHeight, shoreRamp };
}

export const LANDMASSES: Landmass[] = [
  makeLandmass("San Francisco", PENINSULA_LL, 9, 90),
  makeLandmass("Marin Headlands", MARIN_LL, 24, 140),
  makeLandmass("Alcatraz", ALCATRAZ_LL, 21, 40),
  makeLandmass("Treasure Island", TREASURE_ISLAND_LL, 4, 60),
  makeLandmass("Yerba Buena Island", YERBA_BUENA_LL, 46, 70),
  makeLandmass("Angel Island", ANGEL_ISLAND_LL, 60, 110),
];

/** Even-odd point-in-polygon. */
function pointInRing(x: number, z: number, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Unsigned distance from a point to a closed polyline. */
function distanceToRing(x: number, z: number, ring: Vec2[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1e-6;
    const t = clamp01(((x - a.x) * dx + (z - a.z) * dz) / len2);
    const px = a.x + dx * t - x;
    const pz = a.z + dz * t - z;
    const d = Math.sqrt(px * px + pz * pz);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Signed distance to land: positive inland, negative offshore, in metres.
 * This is the primitive the whole coastline is built on — beaches, seawalls,
 * wave foam, water depth and swimming all read it.
 */
export function landSDF(x: number, z: number): number {
  let best = -Infinity;
  for (const lm of LANDMASSES) {
    // Cheap AABB reject with a margin so offshore distance stays continuous.
    if (
      x < lm.minX - 600 ||
      x > lm.maxX + 600 ||
      z < lm.minZ - 600 ||
      z > lm.maxZ + 600
    ) {
      continue;
    }
    const inside = pointInRing(x, z, lm.ring);
    const d = distanceToRing(x, z, lm.ring) * (inside ? 1 : -1);
    if (d > best) best = d;
  }
  if (best === -Infinity) {
    // Far from every landmass — return a large negative (deep water).
    let nearest = Infinity;
    for (const lm of LANDMASSES) {
      const cx = (lm.minX + lm.maxX) / 2;
      const cz = (lm.minZ + lm.maxZ) / 2;
      const d = Math.hypot(x - cx, z - cz);
      if (d < nearest) nearest = d;
    }
    return -nearest;
  }
  return best;
}

/** True if the point is bay/ocean rather than land. */
export function isWater(x: number, z: number): boolean {
  return landSDF(x, z) <= 0;
}

/** Which landmass (if any) contains this point. */
export function landmassAt(x: number, z: number): Landmass | null {
  for (const lm of LANDMASSES) {
    if (x < lm.minX || x > lm.maxX || z < lm.minZ || z > lm.maxZ) continue;
    if (pointInRing(x, z, lm.ring)) return lm;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Terrain elevation
 * ------------------------------------------------------------------ */

/**
 * Ground elevation in metres at a world position — the canonical answer.
 *
 * Composed of: the shoreline ramp (so land rises out of the bay instead of
 * ending in a cliff wall), the sum of the real hills, and two octaves of
 * gentle noise so nothing reads as a perfect analytic dome.
 *
 * Below sea level this returns the *seabed*, which the water shader uses for
 * depth-based absorption and the physics uses to stop boats sinking forever.
 */
export function terrainHeight(x: number, z: number): number {
  const sd = landSDF(x, z);

  if (sd <= 0) {
    // Offshore: seabed drops away from the shore, bottoming out around -34 m.
    const depth = -34 * smoothstep(0, 900, -sd);
    const ripple = fbm2(x * 0.0016, z * 0.0016, 3, 2, 0.5, 4471) * 3.2;
    return depth + ripple * smoothstep(0, 240, -sd);
  }

  const lm = landmassAt(x, z);
  const base = lm?.baseHeight ?? 8;
  const ramp = lm?.shoreRamp ?? 90;

  // Rise out of the water over `ramp` metres.
  let h = base * smoothstep(0, ramp, sd);

  // Sum the real hills.
  for (const hill of HILLS_W) {
    let dx = x - hill.wx;
    let dz = z - hill.wz;
    if (hill.stretch !== 1) {
      // Rotate into the ridge frame and squash across it.
      const rx = dx * hill.cos + dz * hill.sin;
      const rz = -dx * hill.sin + dz * hill.cos;
      dx = rx / hill.stretch;
      dz = rz;
    }
    const d2 = dx * dx + dz * dz;
    const r2 = hill.radius * hill.radius;
    if (d2 >= r2) continue;
    const t = 1 - d2 / r2; // 1 at summit → 0 at radius
    h += hill.height * Math.pow(t, hill.sharpness) * smoothstep(0, ramp * 1.4, sd);
  }

  // Landform detail — enough to break up the analytic surfaces, never enough
  // to make the street grid undrivable.
  const detail =
    fbm2(x * 0.00085, z * 0.00085, 4, 2.1, 0.5, 8123) * 11 +
    fbm2(x * 0.0042, z * 0.0042, 3, 2.0, 0.5, 2287) * 2.6;
  h += detail * smoothstep(0, ramp * 2, sd);

  return h;
}

/** Surface normal of the terrain, via central differences. */
export function terrainNormal(x: number, z: number, eps = 2): [number, number, number] {
  const hL = terrainHeight(x - eps, z);
  const hR = terrainHeight(x + eps, z);
  const hD = terrainHeight(x, z - eps);
  const hU = terrainHeight(x, z + eps);
  const nx = hL - hR;
  const nz = hD - hU;
  const ny = 2 * eps;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** Terrain slope in radians (0 = flat). Used for road cut/fill and traction. */
export function terrainSlope(x: number, z: number, eps = 4): number {
  const n = terrainNormal(x, z, eps);
  return Math.acos(clamp(n[1], -1, 1));
}

/* ------------------------------------------------------------------ *
 * The street grid
 * ------------------------------------------------------------------ *
 * San Francisco's plan is two grids that collide along Market Street at a
 * ~42-degree angle, producing the wedge blocks that define downtown. Getting
 * this right is the difference between "a city" and "San Francisco".
 */

export interface GridSystem {
  name: string;
  /** Rotation of the grid from north, radians. */
  angle: number;
  /** Spacing between streets along each axis, metres. */
  spacingU: number;
  spacingV: number;
  /** Grid origin in world space. */
  originX: number;
  originZ: number;
}

const MARKET_A = latLonToWorld(37.7749, -122.4194); // Market @ Castro-ish
const MARKET_B = latLonToWorld(37.7936, -122.3947); // Market @ Embarcadero

/** Market Street as a directed segment — the seam between the two grids. */
export const MARKET_STREET = {
  ax: MARKET_A.x,
  az: MARKET_A.z,
  bx: MARKET_B.x,
  bz: MARKET_B.z,
  halfWidth: 22,
} as const;

const MARKET_DX = MARKET_STREET.bx - MARKET_STREET.ax;
const MARKET_DZ = MARKET_STREET.bz - MARKET_STREET.az;
const MARKET_LEN = Math.hypot(MARKET_DX, MARKET_DZ);
const MARKET_ANGLE = Math.atan2(MARKET_DZ, MARKET_DX);

/**
 * Signed distance to the Market Street centreline. Negative = north side
 * (the 42-degree downtown grid), positive = south side (the cardinal
 * SoMa/Mission grid).
 */
export function marketSide(x: number, z: number): number {
  const nx = -MARKET_DZ / MARKET_LEN;
  const nz = MARKET_DX / MARKET_LEN;
  return (x - MARKET_STREET.ax) * nx + (z - MARKET_STREET.az) * nz;
}

/** The downtown/north-of-Market grid — rotated to align with Market. */
export const GRID_NORTH: GridSystem = {
  name: "north-of-market",
  angle: MARKET_ANGLE + Math.PI / 2,
  spacingU: 125, // block length along the avenues
  spacingV: 84, // the famously short north-south blocks
  originX: 0,
  originZ: 0,
};

/** SoMa / Mission — the big cardinal blocks south of Market. */
export const GRID_SOUTH: GridSystem = {
  name: "south-of-market",
  angle: MARKET_ANGLE + Math.PI / 2,
  spacingU: 168,
  spacingV: 168,
  originX: MARKET_STREET.ax,
  originZ: MARKET_STREET.az,
};

/** The Richmond / Sunset / Western Addition grid — nearly true cardinal. */
export const GRID_WEST: GridSystem = {
  name: "west",
  angle: -0.0125,
  spacingU: 122,
  spacingV: 168,
  originX: latLonToWorld(37.7749, -122.4594).x,
  originZ: latLonToWorld(37.7749, -122.4594).z,
};

/** Pick the grid that governs a world position. */
export function gridAt(x: number, z: number): GridSystem {
  if (x < -3400) return GRID_WEST;
  return marketSide(x, z) > 0 ? GRID_SOUTH : GRID_NORTH;
}

/** Project a world point into its grid's (u,v) block coordinates. */
export function toGridSpace(x: number, z: number, g: GridSystem): { u: number; v: number } {
  const dx = x - g.originX;
  const dz = z - g.originZ;
  const c = Math.cos(-g.angle);
  const s = Math.sin(-g.angle);
  return { u: (dx * c - dz * s) / g.spacingU, v: (dx * s + dz * c) / g.spacingV };
}

/** Inverse of `toGridSpace`. */
export function fromGridSpace(u: number, v: number, g: GridSystem): Vec2 {
  const su = u * g.spacingU;
  const sv = v * g.spacingV;
  const c = Math.cos(g.angle);
  const s = Math.sin(g.angle);
  return { x: g.originX + su * c - sv * s, z: g.originZ + su * s + sv * c };
}

/** Half-width of the roadway for a given street class, metres. */
export const ROAD_HALF_WIDTH = {
  boulevard: 22, // Market, Van Ness, Embarcadero
  arterial: 14, // Columbus, Geary, Mission
  street: 9, // ordinary grid streets
  alley: 4.5,
} as const;

export type RoadClass = keyof typeof ROAD_HALF_WIDTH;

/**
 * Distance from a point to the nearest street centreline, plus that street's
 * class. Buildings are pushed out of this, sidewalks are drawn along it, and
 * traffic drives down it.
 */
export function nearestStreet(x: number, z: number): { distance: number; roadClass: RoadClass } {
  // Market Street first — it overrides the grids.
  const t = clamp01(
    ((x - MARKET_STREET.ax) * MARKET_DX + (z - MARKET_STREET.az) * MARKET_DZ) /
      (MARKET_LEN * MARKET_LEN),
  );
  const mx = MARKET_STREET.ax + MARKET_DX * t - x;
  const mz = MARKET_STREET.az + MARKET_DZ * t - z;
  let best = Math.hypot(mx, mz);
  let cls: RoadClass = "boulevard";

  const g = gridAt(x, z);
  const { u, v } = toGridSpace(x, z, g);
  const du = Math.abs(u - Math.round(u)) * g.spacingU;
  const dv = Math.abs(v - Math.round(v)) * g.spacingV;
  // Every 4th line in each direction is an arterial.
  const uArterial = Math.round(u) % 4 === 0;
  const vArterial = Math.round(v) % 4 === 0;
  if (du < best) {
    best = du;
    cls = uArterial ? "arterial" : "street";
  }
  if (dv < best) {
    best = dv;
    cls = vArterial ? "arterial" : "street";
  }
  return { distance: best, roadClass: cls };
}

/** True if the point lies on paved roadway. */
export function isRoad(x: number, z: number): boolean {
  const { distance, roadClass } = nearestStreet(x, z);
  return distance < ROAD_HALF_WIDTH[roadClass];
}

/* ------------------------------------------------------------------ *
 * Districts
 * ------------------------------------------------------------------ *
 * Zoning drives the building generator: how tall, how dense, what era, what
 * palette, whether there are fire escapes or curtain walls or bay windows.
 */

export type BuildingStyle =
  | "highrise-glass" // Financial District / SoMa towers
  | "highrise-deco" // 1920s-30s stone towers
  | "midrise-brick" // Jackson Square, SoMa warehouses
  | "victorian" // Painted Ladies, Haight, Mission
  | "edwardian-apartment" // Nob Hill / Pacific Heights
  | "stucco-row" // Sunset / Richmond
  | "industrial" // Dogpatch, Bayview
  | "civic" // City Hall, museums
  | "warehouse"
  | "military"; // Presidio, Fort Mason

export interface District {
  key: string;
  name: string;
  /** Centre in world metres. */
  x: number;
  z: number;
  /** Influence radius, metres. */
  radius: number;
  /** Building height range, metres. */
  minHeight: number;
  maxHeight: number;
  /** Fraction of lots that are built on, 0..1. */
  density: number;
  styles: BuildingStyle[];
  /** Weight per style, same length as `styles`. */
  styleWeights: number[];
  /** Base facade palette (hex). The material lab varies around these. */
  palette: number[];
  /** Nighttime window-lit probability. */
  nightLit: number;
}

function district(
  key: string,
  name: string,
  lat: number,
  lon: number,
  radius: number,
  minHeight: number,
  maxHeight: number,
  density: number,
  styles: BuildingStyle[],
  styleWeights: number[],
  palette: number[],
  nightLit: number,
): District {
  const p = latLonToWorld(lat, lon);
  return {
    key,
    name,
    x: p.x,
    z: p.z,
    radius,
    minHeight,
    maxHeight,
    density,
    styles,
    styleWeights,
    palette,
    nightLit,
  };
}

export const DISTRICTS: District[] = [
  district("fidi", "Financial District", 37.7929, -122.4009, 700, 40, 260, 0.95,
    ["highrise-glass", "highrise-deco", "midrise-brick"], [0.55, 0.3, 0.15],
    [0x9fb0c4, 0x8d9aab, 0xb9c3cf, 0x76818f, 0xc8cfd6], 0.72),
  district("soma", "SoMa", 37.7810, -122.3990, 900, 14, 220, 0.82,
    ["highrise-glass", "warehouse", "midrise-brick", "industrial"], [0.34, 0.28, 0.24, 0.14],
    [0x8e8378, 0xa89b8c, 0x6f6a64, 0xb7ada0], 0.55),
  district("rincon", "Rincon Hill", 37.7852, -122.3903, 420, 60, 200, 0.7,
    ["highrise-glass"], [1], [0x9db4c8, 0x7f95a8, 0xb0c2d2], 0.68),
  district("chinatown", "Chinatown", 37.7941, -122.4078, 380, 12, 34, 0.97,
    ["midrise-brick", "victorian"], [0.7, 0.3],
    [0xb85c4a, 0xc9a23f, 0x8f4034, 0xd9c9a8, 0xa8583e], 0.8),
  district("northbeach", "North Beach", 37.8003, -122.4098, 420, 10, 26, 0.92,
    ["midrise-brick", "victorian", "edwardian-apartment"], [0.45, 0.3, 0.25],
    [0xd8c9ae, 0xc0a887, 0xa8907a, 0xe0d5c0], 0.66),
  district("telegraph", "Telegraph Hill", 37.8024, -122.4058, 300, 8, 20, 0.6,
    ["victorian", "edwardian-apartment"], [0.6, 0.4],
    [0xe6dcc8, 0xcbbba0, 0xa9b39c], 0.6),
  district("nobhill", "Nob Hill", 37.7930, -122.4161, 460, 18, 62, 0.88,
    ["edwardian-apartment", "highrise-deco", "civic"], [0.6, 0.28, 0.12],
    [0xd6cdbd, 0xb9ae9c, 0x9d9486, 0xe3dbcc], 0.63),
  district("russianhill", "Russian Hill", 37.8010, -122.4189, 420, 10, 44, 0.85,
    ["edwardian-apartment", "victorian"], [0.62, 0.38],
    [0xe4dccd, 0xc7bda9, 0xaeb7a8], 0.6),
  district("marina", "Marina", 37.8035, -122.4370, 620, 8, 18, 0.8,
    ["stucco-row", "victorian"], [0.7, 0.3],
    [0xf0e6d2, 0xe2d4bb, 0xd8cdb8, 0xefe9dc], 0.55),
  district("pacheights", "Pacific Heights", 37.7924, -122.4350, 700, 10, 34, 0.83,
    ["victorian", "edwardian-apartment"], [0.5, 0.5],
    [0xefe7d8, 0xd9cdb8, 0xc2b8a4, 0xf5efe4], 0.52),
  district("hayesvalley", "Hayes Valley", 37.7765, -122.4240, 480, 9, 26, 0.86,
    ["victorian", "midrise-brick", "civic"], [0.55, 0.3, 0.15],
    [0xe8dcc6, 0xcbb9a0, 0xb0a48f], 0.6),
  district("alamo", "Alamo Square", 37.7763, -122.4328, 380, 9, 17, 0.9,
    ["victorian"], [1],
    [0xf2e3c8, 0xd7e0e8, 0xe9cfd6, 0xcfe0cd, 0xf0d9b0], 0.62),
  district("haight", "Haight-Ashbury", 37.7699, -122.4469, 520, 9, 20, 0.88,
    ["victorian", "edwardian-apartment"], [0.72, 0.28],
    [0xe6d8bf, 0xcbb59c, 0xb6c2b0, 0xdcc8d2], 0.58),
  district("castro", "Castro", 37.7609, -122.4350, 420, 8, 20, 0.87,
    ["victorian"], [1], [0xeadcc4, 0xd2c0a6, 0xc4cfd6], 0.6),
  district("mission", "Mission", 37.7599, -122.4148, 800, 8, 26, 0.9,
    ["victorian", "midrise-brick", "warehouse"], [0.5, 0.32, 0.18],
    [0xdcc8a4, 0xc7ab84, 0xbf6a52, 0xd9d0bc], 0.62),
  district("potrero", "Potrero Hill", 37.7576, -122.4013, 620, 7, 18, 0.72,
    ["victorian", "industrial", "stucco-row"], [0.44, 0.3, 0.26],
    [0xe0d4bd, 0xb9ae99, 0x9aa3a6], 0.5),
  district("dogpatch", "Dogpatch", 37.7601, -122.3880, 520, 8, 24, 0.66,
    ["industrial", "warehouse", "midrise-brick"], [0.44, 0.36, 0.2],
    [0x8f8b83, 0xa69c8e, 0x7d7770, 0xb46a4e], 0.42),
  district("westernaddition", "Western Addition", 37.7830, -122.4310, 620, 9, 30, 0.85,
    ["victorian", "edwardian-apartment", "civic"], [0.5, 0.38, 0.12],
    [0xe5d9c4, 0xcabda6, 0xb0a692], 0.58),
  district("richmond", "Richmond", 37.7800, -122.4780, 1100, 8, 15, 0.88,
    ["stucco-row"], [1],
    [0xe9e0d0, 0xd6cbba, 0xc3bda9, 0xf0ebe0], 0.5),
  district("sunset", "Sunset", 37.7530, -122.4940, 1300, 8, 14, 0.9,
    ["stucco-row"], [1],
    [0xece4d6, 0xdad2c2, 0xc9c4b6, 0xf3eee2], 0.48),
  district("presidio", "Presidio", 37.7975, -122.4640, 950, 7, 16, 0.22,
    ["military", "victorian"], [0.75, 0.25],
    [0xe8e2d4, 0xd0c8b6, 0xa8544a], 0.3),
  district("civiccenter", "Civic Center", 37.7793, -122.4184, 380, 16, 60, 0.8,
    ["civic", "highrise-deco", "midrise-brick"], [0.5, 0.3, 0.2],
    [0xdfd8c8, 0xc6bda9, 0xe8e2d6], 0.66),
  district("embarcadero", "Embarcadero", 37.7990, -122.3960, 460, 10, 90, 0.6,
    ["warehouse", "midrise-brick", "highrise-glass"], [0.5, 0.28, 0.22],
    [0xc9bda6, 0x9aa3ab, 0xb5aa96], 0.6),
  district("bayview", "Bayview", 37.7300, -122.3880, 900, 7, 18, 0.62,
    ["industrial", "stucco-row", "warehouse"], [0.42, 0.34, 0.24],
    [0xd2c8b6, 0x9c968a, 0x8b8a84], 0.4),
];

/** Nearest district by weighted distance — the zoning lookup. */
export function districtAt(x: number, z: number): District {
  let best = DISTRICTS[0];
  let bestScore = Infinity;
  for (const d of DISTRICTS) {
    const dist = Math.hypot(x - d.x, z - d.z);
    // Normalised so a big district's edge and a small one's edge compare fairly.
    const score = dist / d.radius;
    if (score < bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * Smooth blend weight of a district at a point, 0..1. The building generator
 * lerps height/palette between neighbours so districts fade into each other
 * instead of switching on a hard line.
 */
export function districtInfluence(x: number, z: number, d: District): number {
  const dist = Math.hypot(x - d.x, z - d.z);
  return 1 - smoothstep(d.radius * 0.55, d.radius * 1.45, dist);
}

/* ------------------------------------------------------------------ *
 * Landmarks
 * ------------------------------------------------------------------ *
 * The silhouettes you navigate by. Each is placed at its true coordinates
 * and gets a bespoke mesh from the landmark system.
 */

export type LandmarkKind =
  | "golden-gate-bridge"
  | "bay-bridge"
  | "transamerica"
  | "salesforce-tower"
  | "coit-tower"
  | "ferry-building"
  | "painted-ladies"
  | "palace-of-fine-arts"
  | "alcatraz"
  | "lombard-street"
  | "city-hall"
  | "oracle-park"
  | "cable-car-turnaround"
  | "pier-39"
  | "sutro-tower"
  | "chinatown-gate"
  | "sfmoma"
  | "grace-cathedral"
  | "millennium-tower"
  | "555-california"
  | "shipyard-cranes"
  | "windmill"
  /* The ten added for walking. Everything above this line reads at a kilometre
     from a wingsuit; everything below it is a landmark because of what it is
     like to stand in front of, which is a different job and only became worth
     doing once there was a character to stand there. */
  | "conservatory-of-flowers"
  | "de-young"
  | "cliff-house"
  | "twin-peaks-overlook"
  | "union-square"
  | "ghirardelli-square"
  | "castro-theatre"
  | "mission-dolores"
  | "fort-point"
  | "chase-center";

export interface LandmarkDef {
  key: string;
  kind: LandmarkKind;
  name: string;
  x: number;
  z: number;
  /** Yaw in radians. */
  rotation: number;
  /** Structure height in metres (roof, not antenna). */
  height: number;
  /** Radius used for culling + "you are near X" prompts. */
  radius: number;
  /** Shown on the minimap / compass. */
  navpoint: boolean;
}

function landmark(
  key: string,
  kind: LandmarkKind,
  name: string,
  lat: number,
  lon: number,
  rotation: number,
  height: number,
  radius: number,
  navpoint = true,
): LandmarkDef {
  const p = latLonToWorld(lat, lon);
  return { key, kind, name, x: p.x, z: p.z, rotation, height, radius, navpoint };
}

export const LANDMARKS: LandmarkDef[] = [
  landmark("golden-gate", "golden-gate-bridge", "Golden Gate Bridge", 37.8199, -122.4783, 0.0, 227, 1400),
  landmark("bay-bridge", "bay-bridge", "Bay Bridge", 37.7983, -122.3778, 0.0, 160, 1600),
  landmark("transamerica", "transamerica", "Transamerica Pyramid", 37.7952, -122.4028, 0.0, 260, 60),
  landmark("salesforce", "salesforce-tower", "Salesforce Tower", 37.7897, -122.3972, 0.0, 326, 55),
  landmark("coit", "coit-tower", "Coit Tower", 37.8024, -122.4058, 0.0, 64, 30),
  landmark("ferry", "ferry-building", "Ferry Building", 37.7955, -122.3937, 0.0, 74, 120),
  landmark("painted-ladies", "painted-ladies", "Painted Ladies", 37.7763, -122.4328, 0.0, 17, 90),
  landmark("palace", "palace-of-fine-arts", "Palace of Fine Arts", 37.8029, -122.4484, 0.0, 49, 160),
  landmark("alcatraz", "alcatraz", "Alcatraz Island", 37.8267, -122.4230, 0.0, 42, 220),
  landmark("lombard", "lombard-street", "Lombard Street", 37.8021, -122.4187, 0.0, 4, 130),
  landmark("city-hall", "city-hall", "City Hall", 37.7793, -122.4193, 0.0, 94, 110),
  landmark("oracle-park", "oracle-park", "Oracle Park", 37.7786, -122.3893, 0.0, 40, 180),
  landmark("powell-turnaround", "cable-car-turnaround", "Powell St Turnaround", 37.7855, -122.4080, 0.0, 3, 26, false),
  landmark("pier39", "pier-39", "Pier 39", 37.8087, -122.4098, 0.0, 14, 160),
  landmark("sutro", "sutro-tower", "Sutro Tower", 37.7552, -122.4528, 0.0, 297, 90),
  landmark("chinatown-gate", "chinatown-gate", "Dragon Gate", 37.7908, -122.4056, 0.0, 12, 20, false),
  landmark("sfmoma", "sfmoma", "SFMOMA", 37.7857, -122.4011, 0.0, 61, 60, false),
  landmark("grace", "grace-cathedral", "Grace Cathedral", 37.7919, -122.4131, 0.0, 53, 55),
  landmark("millennium", "millennium-tower", "Millennium Tower", 37.7902, -122.3958, 0.0, 197, 34, false),
  landmark("555cal", "555-california", "555 California", 37.7924, -122.4038, 0.0, 237, 40, false),
  landmark("cranes", "shipyard-cranes", "Pier 70 Cranes", 37.7601, -122.3846, 0.0, 60, 80, false),
  landmark("windmill", "windmill", "Dutch Windmill", 37.7699, -122.5108, 0.0, 24, 24, false),

  /* ---- the walking landmarks ---- */
  landmark("conservatory", "conservatory-of-flowers", "Conservatory of Flowers", 37.7723, -122.4602, 0.0, 26, 90),
  landmark("de-young", "de-young", "de Young Museum", 37.7715, -122.4687, 0.0, 44, 130),
  landmark("cliff-house", "cliff-house", "Cliff House", 37.7787, -122.5137, 0.0, 22, 170),
  landmark("twin-peaks-view", "twin-peaks-overlook", "Twin Peaks Overlook", 37.7544, -122.4477, 0.0, 6, 190, false),
  landmark("union-square", "union-square", "Union Square", 37.7879, -122.4075, 0.0, 31, 60),
  landmark("ghirardelli", "ghirardelli-square", "Ghirardelli Square", 37.8060, -122.4229, 0.0, 41, 80),
  landmark("castro-theatre", "castro-theatre", "Castro Theatre", 37.7621, -122.4348, 0.0, 27, 40),
  landmark("mission-dolores", "mission-dolores", "Mission Dolores", 37.7645, -122.4268, 0.0, 43, 60),
  landmark("fort-point", "fort-point", "Fort Point", 37.8106, -122.4770, 0.0, 19, 70),
  landmark("chase-center", "chase-center", "Chase Center", 37.7680, -122.3877, 0.0, 45, 150),
];

export const LANDMARK_BY_KEY: Record<string, LandmarkDef> = Object.fromEntries(
  LANDMARKS.map((l) => [l.key, l]),
);

/** Exclusion zones where the procedural building generator must not build. */
export interface ExclusionZone {
  x: number;
  z: number;
  radius: number;
  reason: string;
}

export const EXCLUSIONS: ExclusionZone[] = [
  ...LANDMARKS.map((l) => ({ x: l.x, z: l.z, radius: l.radius * 0.9, reason: l.name })),
  // Parks — the green lungs the city needs so it doesn't read as solid concrete.
  { ...latLonToWorld(37.7694, -122.4862), radius: 1450, reason: "Golden Gate Park" },
  { ...latLonToWorld(37.7599, -122.4269), radius: 220, reason: "Dolores Park" },
  { ...latLonToWorld(37.8065, -122.4260), radius: 260, reason: "Fort Mason" },
  { ...latLonToWorld(37.8072, -122.4430), radius: 300, reason: "Marina Green" },
  { ...latLonToWorld(37.7952, -122.4098), radius: 90, reason: "Portsmouth Square" },
  { ...latLonToWorld(37.7879, -122.4075), radius: 95, reason: "Union Square" },
  { ...latLonToWorld(37.7749, -122.4194), radius: 60, reason: "Civic Center Plaza" },
  { ...latLonToWorld(37.8010, -122.4090), radius: 130, reason: "Washington Square" },
  { ...latLonToWorld(37.7647, -122.4562), radius: 480, reason: "Mount Sutro Forest" },
  { ...latLonToWorld(37.7544, -122.4477), radius: 620, reason: "Twin Peaks" },
  { ...latLonToWorld(37.7381, -122.4541), radius: 560, reason: "Mount Davidson" },
  { ...latLonToWorld(37.7433, -122.4160), radius: 340, reason: "Bernal Heights Park" },
];

/** True if procedural buildings are forbidden here. */
export function isExcluded(x: number, z: number): boolean {
  for (const e of EXCLUSIONS) {
    const dx = x - e.x;
    const dz = z - e.z;
    if (dx * dx + dz * dz < e.radius * e.radius) return true;
  }
  return false;
}

/** True if the point is inside a park (drives grass, trees, no asphalt). */
export function isPark(x: number, z: number): boolean {
  for (const e of EXCLUSIONS) {
    if (!/Park|Square|Green|Plaza|Forest|Peaks|Mason|Davidson/.test(e.reason)) continue;
    const dx = x - e.x;
    const dz = z - e.z;
    if (dx * dx + dz * dz < e.radius * e.radius) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Spawn points
 * ------------------------------------------------------------------ */

export interface SpawnPoint {
  key: string;
  name: string;
  x: number;
  z: number;
  /** Height above terrain, metres. Rooftop spawns use large values. */
  yOffset: number;
  heading: number;
  blurb: string;
}

/**
 * The spawn table, projected into world metres.
 *
 * The list itself lives in `spawnList.ts` with no dependencies, so the page
 * chrome can offer "Go somewhere" without importing this module — see the note
 * at the top of that file.
 */
export const SPAWNS: SpawnPoint[] = SPAWN_DEFS.map((d) => {
  const p = d.lat !== undefined && d.lon !== undefined
    ? latLonToWorld(d.lat, d.lon)
    : { x: d.x ?? 0, z: d.z ?? 0 };
  return {
    key: d.key,
    name: d.name,
    x: p.x,
    z: p.z,
    yOffset: d.yOffset,
    heading: d.heading,
    blurb: d.blurb,
  };
});

/* ------------------------------------------------------------------ *
 * Convenience
 * ------------------------------------------------------------------ */

/** Clamp a position into the playable bounds. */
export function clampToWorld(x: number, z: number): Vec2 {
  return {
    x: clamp(x, WORLD.minX + 40, WORLD.maxX - 40),
    z: clamp(z, WORLD.minZ + 40, WORLD.maxZ - 40),
  };
}

/** Ground height clamped to sea level — what a walking character stands on. */
export function walkableHeight(x: number, z: number): number {
  return Math.max(terrainHeight(x, z), WORLD.seaLevel);
}
