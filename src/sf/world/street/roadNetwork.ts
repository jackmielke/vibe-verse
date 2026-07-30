/**
 * roadNetwork.ts — the queryable street graph of San Francisco.
 *
 * Everything above the asphalt reads this module: the road ribbon mesher, the
 * sidewalk mesher, street-furniture placement, vegetation (tree wells sit on
 * kerb lines), traffic AI, pedestrian AI and the minimap. It exists so that
 * exactly one piece of code decides where a street is, how wide it is, what it
 * is called, which way its lanes run and where the stop bar goes.
 *
 * It does **not** invent geometry. Street positions come from `sfGeo`'s grid
 * systems and its `nearestStreet` / `ROAD_HALF_WIDTH` contract, because the
 * building generator fits its lots to exactly those lines. Any disagreement
 * here shows up in game as a tower standing in a traffic lane.
 *
 * Structure
 * ---------
 *   Node   an intersection. Owns the junction polygon: the kerb-return corner
 *          points, computed by intersecting the offset kerb lines of angularly
 *          adjacent approaches. That polygon is the paved deck of the junction,
 *          the source of the wheelchair-ramp positions, and the thing the
 *          approaches are trimmed back to.
 *   Edge   one block face of street between two nodes. Carries its graded
 *          longitudinal profile (real terrain, smoothed the way a grader
 *          smooths it, then floored so it can never sink below the ground),
 *          its lane layout, and its per-corridor flags (transit lane, bike
 *          lane, cable car slot, trolleybus catenary).
 *
 * Generation is lazy and tile-based: `ensureRect` materialises the graph for a
 * region. Building the whole 9.8 × 9.6 km graph up front is ~30 000 nodes and
 * a hundred thousand `terrainHeight` calls, which is a two-second hitch on the
 * loading screen for data that a player standing on Market Street will never
 * look at.
 *
 * Determinism: every derived property is a pure function of (grid index, line
 * indices, WORLD_SEED). A tile that streams out and streams back in is
 * byte-identical, which the screenshot harness depends on.
 */
import {
  GRID_NORTH,
  GRID_SOUTH,
  GRID_WEST,
  MARKET_STREET,
  ROAD_HALF_WIDTH,
  WORLD,
  districtAt,
  fromGridSpace,
  gridAt,
  isPark,
  landSDF,
  latLonToWorld,
  terrainHeight,
  toGridSpace,
  type District,
  type GridSystem,
  type RoadClass,
} from "../../geo/sfGeo";
import { EXCLUSIONS } from "../../geo/sfGeo";
import { WORLD_SEED } from "../../config";
import { clamp, clamp01, hashSeed, makeRng } from "../../math/rng";

/* ================================================================== *
 * Constants
 * ================================================================== */

/** The three grids, in the same order `lots.ts` uses. */
export const GRIDS: GridSystem[] = [GRID_NORTH, GRID_SOUTH, GRID_WEST];

/**
 * How far the finished roadway sits above `terrainHeight`. The terrain is a
 * geometry clipmap whose vertices only land on the true height field at the
 * innermost ring; further out it under- and over-shoots by tens of centimetres.
 * Rather than fight that with polygon offset (which fails at grazing angles and
 * at distance), the road is simply built proud of the ground and the sidewalk's
 * outer apron drops a skirt down into the terrain to hide the seam.
 */
export const ROAD_LIFT = 0.24;

/** Pavement width from the kerb to the property line — matches `lots.ts`. */
export const SIDEWALK_WIDTH = 3.6;

/** Standard kerb reveal: six inches, the number every American city uses. */
export const KERB_HEIGHT = 0.152;

/** Cross-fall of the carriageway, as a fraction. 2 % is the drainage minimum. */
export const CAMBER = 0.02;

/** Centreline sampling interval for the graded profile, metres. */
const PROFILE_STEP = 8;

/** Lazy build tile. */
const TILE = 384;

/* ================================================================== *
 * Types
 * ================================================================== */

export type TrafficControl = "none" | "yield" | "stop" | "signal";

export interface Lane {
  /** Lateral offset of the lane centre from the road centreline, metres.
   *  Positive is to the *right* of the a→b direction. */
  offset: number;
  width: number;
  /** +1 = runs a→b, -1 = runs b→a. */
  dir: 1 | -1;
  kind: "travel" | "parking" | "transit" | "bike" | "turn";
}

export interface RoadEdge {
  id: number;
  /** Node ids. Direction a→b defines "forward". */
  a: number;
  b: number;
  cls: RoadClass;
  /** Half-width of the *right of way*, exactly `ROAD_HALF_WIDTH[cls]`. */
  halfWidth: number;
  /** Half-width of the paved carriageway. Never wider than `halfWidth`; the
   *  slack becomes extra-wide pavement (which is why Market has plazas). */
  carriageway: number;
  /** Unit direction a→b in the XZ plane. */
  dx: number;
  dz: number;
  /** Right-hand normal (`-dz, dx`) — a driver's right. */
  rx: number;
  rz: number;
  length: number;
  /** Graded centreline, [x,y,z] triples, from node a to node b inclusive. */
  samples: Float32Array;
  sampleCount: number;
  sampleStep: number;
  /** Distance the ribbon is trimmed back at each end for the junction deck. */
  trimA: number;
  trimB: number;
  lanes: Lane[];
  /** Longitudinal grade at the midpoint, radians. Cable cars and parked cars
   *  both care; so does the "this hill is stupid" camera shake. */
  grade: number;
  name: string;
  /** True when parking is permitted along the kerb. */
  parking: boolean;
  transitLane: boolean;
  bikeLane: boolean;
  cableCar: boolean;
  trolley: boolean;
  /** True for the mid-block service alleys behind the big SoMa blocks. */
  isAlley: boolean;
  /** Which grid produced it; -1 for Market and for cross-seam connectors. */
  gi: number;
  district: District;
  seed: number;
}

export interface RoadNode {
  id: number;
  key: string;
  x: number;
  y: number;
  z: number;
  /** Incident edge ids, sorted by the outgoing bearing of each approach. */
  edges: number[];
  /** Outgoing bearing per entry of `edges`, radians, matching order. */
  bearings: number[];
  cls: RoadClass;
  control: TrafficControl;
  /** Junction deck polygon, [x,y,z] triples, CCW seen from above. `corners[i]`
   *  lies between `edges[i]` and `edges[i+1]`. Empty for degree-1 stubs. */
  corners: Float32Array;
  cornerCount: number;
  /** Largest trim any approach needed — the junction's effective radius. */
  radius: number;
  seed: number;
  /** Which of the two signal phases each incident edge belongs to. */
  phaseOf: Uint8Array;
  dirty: boolean;
}

/* ================================================================== *
 * Street naming
 * ================================================================== *
 * Real names, in their real order, walked outward from the world origin. The
 * grid in `sfGeo` is a regularised San Francisco rather than a surveyed one, so
 * these do not land on their true coordinates to the metre — but a street blade
 * that reads BUSH ST where Bush Street ought to be is worth a great deal, and
 * the alternative (procedural nonsense) is worth nothing.
 */

/** North of Market, running parallel to Market, walking away from it. */
const NORTH_PARALLEL = [
  "POST", "SUTTER", "BUSH", "PINE", "CALIFORNIA", "SACRAMENTO", "CLAY",
  "WASHINGTON", "JACKSON", "PACIFIC", "BROADWAY", "VALLEJO", "GREEN", "UNION",
  "FILBERT", "GREENWICH", "LOMBARD", "CHESTNUT", "FRANCISCO", "BAY",
  "NORTH POINT", "BEACH", "JEFFERSON",
];

/** North of Market, crossing it, walking northwest from Montgomery. */
const NORTH_CROSS = [
  "MONTGOMERY", "KEARNY", "GRANT", "STOCKTON", "POWELL", "MASON", "TAYLOR",
  "JONES", "LEAVENWORTH", "HYDE", "LARKIN", "POLK", "VAN NESS", "FRANKLIN",
  "GOUGH", "OCTAVIA", "LAGUNA", "BUCHANAN", "WEBSTER", "FILLMORE", "STEINER",
  "PIERCE", "SCOTT", "DIVISADERO", "BRODERICK", "BAKER", "LYON", "PRESIDIO",
];

/** ...and southeast from Montgomery, down to the water. */
const NORTH_CROSS_EAST = ["SANSOME", "BATTERY", "FRONT", "DAVIS", "DRUMM", "EMBARCADERO"];

/** South of Market, parallel to Market, walking away from it. */
const SOUTH_PARALLEL = [
  "MISSION", "HOWARD", "FOLSOM", "HARRISON", "BRYANT", "BRANNAN", "TOWNSEND",
  "KING", "BERRY", "CHANNEL", "16TH", "17TH", "MARIPOSA", "18TH", "19TH",
  "20TH", "22ND", "24TH", "26TH", "CESAR CHAVEZ",
];

/** South of Market, crossing Market: the numbered streets, then the Rincon set. */
const SOUTH_CROSS = [
  "1ST", "2ND", "3RD", "4TH", "5TH", "6TH", "7TH", "8TH", "9TH", "10TH",
  "11TH", "12TH", "SOUTH VAN NESS", "FOLSOM", "HARRISON", "ALABAMA", "FLORIDA",
  "BRYANT", "YORK", "HAMPSHIRE", "POTRERO",
];
const SOUTH_CROSS_EAST = ["FREMONT", "BEALE", "MAIN", "SPEAR", "STEUART"];

/** The Richmond/Sunset east-west streets, north to south. */
const WEST_EW = [
  "LAKE", "CALIFORNIA", "CLEMENT", "GEARY", "ANZA", "BALBOA", "CABRILLO",
  "FULTON", "LINCOLN", "IRVING", "JUDAH", "KIRKHAM", "LAWTON", "MORAGA",
  "NORIEGA", "ORTEGA", "PACHECO", "QUINTARA", "RIVERA", "SANTIAGO", "TARAVAL",
  "ULLOA", "VICENTE", "WAWONA", "SLOAT",
];

function ordinalAvenue(n: number): string {
  const suffix = n % 10 === 1 && n % 100 !== 11 ? "ST"
    : n % 10 === 2 && n % 100 !== 12 ? "ND"
    : n % 10 === 3 && n % 100 !== 13 ? "RD"
    : "TH";
  return `${n}${suffix} AVE`;
}

/**
 * Names wrap rather than falling back to a generated string. Out past the
 * twenty-third street the sequence repeats, which is wrong but invisible — and
 * infinitely better than a blade reading "ST 7 ST", which is wrong *and*
 * obviously machine-made.
 */
function pickName(list: string[], i: number): string {
  const n = list.length;
  return list[((i % n) + n) % n];
}

/** Names that already carry their own street type. */
const NO_SUFFIX = new Set([
  "BROADWAY", "EMBARCADERO", "THE EMBARCADERO", "VAN NESS", "SOUTH VAN NESS",
  "CESAR CHAVEZ", "NORTH POINT", "THE WIGGLE", "JFK DRIVE", "COLUMBUS",
]);

function withSuffix(name: string): string {
  if (NO_SUFFIX.has(name)) return name.startsWith("THE ") ? name : `${name} AVE`;
  if (name.endsWith("AVE") || name.endsWith("ST") || name.endsWith("BLVD")) return name;
  return `${name} ST`;
}

/**
 * Name a grid line. `axis` 0 = constant-u (runs along v), 1 = constant-v.
 * The offsets are chosen so index 0 lands on the street that really is nearest
 * the world origin on that axis.
 */
function streetName(gi: number, axis: 0 | 1, index: number): string {
  if (gi === 0) {
    // North of Market. Market itself sits at u ~ +3.26 in this grid's space, so
    // the streets parallel to it walk *down* from u = 3 as you go inland.
    if (axis === 0) return withSuffix(pickName(NORTH_PARALLEL, 3 - index));
    return index >= 0
      ? withSuffix(pickName(NORTH_CROSS, index))
      : withSuffix(pickName(NORTH_CROSS_EAST, -index - 1));
  }
  if (gi === 1) {
    // South of Market. u = 0 is Market; v runs from the Embarcadero end at
    // about -18 back toward Castro at 0.
    if (axis === 0) return withSuffix(pickName(SOUTH_PARALLEL, index - 1));
    return index <= -1
      ? withSuffix(pickName(SOUTH_CROSS, 18 + index))
      : withSuffix(pickName(SOUTH_CROSS_EAST, index - 1));
  }
  // The western grid: numbered avenues running north-south, named streets E-W.
  if (axis === 0) return ordinalAvenue(clamp(48 - index, 2, 48));
  return withSuffix(pickName(WEST_EW, index + 2));
}

/* ================================================================== *
 * Named corridors
 * ================================================================== *
 * A handful of streets in San Francisco are not interchangeable with their
 * neighbours: the cable car lines, the trolleybus wires, the transit-only lanes
 * on Market and Mission, the green bike lanes on Valencia and the Wiggle. They
 * are picked out here by real-world polyline so the dressing lands on the right
 * street rather than on a random one.
 */

interface Corridor {
  name: string;
  pts: { x: number; z: number }[];
  /** Metres either side of the polyline that count as "on" this corridor. */
  reach: number;
  cableCar?: boolean;
  trolley?: boolean;
  transit?: boolean;
  bike?: boolean;
}

function corridor(
  name: string,
  ll: readonly (readonly [number, number])[],
  reach: number,
  flags: Partial<Corridor> = {},
): Corridor {
  return { name, pts: ll.map(([lat, lon]) => latLonToWorld(lat, lon)), reach, ...flags };
}

const CORRIDORS: Corridor[] = [
  // Powell–Hyde and Powell–Mason cable cars, and the California Street line.
  corridor("POWELL", [[37.7847, -122.4079], [37.7955, -122.4090], [37.8000, -122.4110]], 26, { cableCar: true }),
  corridor("HYDE", [[37.7990, -122.4160], [37.8050, -122.4185], [37.8070, -122.4200]], 26, { cableCar: true }),
  corridor("MASON", [[37.7960, -122.4100], [37.8040, -122.4130], [37.8070, -122.4145]], 24, { cableCar: true }),
  corridor("CALIFORNIA", [[37.7930, -122.3970], [37.7920, -122.4090], [37.7910, -122.4220]], 26, { cableCar: true, trolley: true }),
  // Trolleybus wire: the ETB network's spine routes.
  corridor("MISSION", [[37.7880, -122.3980], [37.7750, -122.4180], [37.7600, -122.4190], [37.7450, -122.4200]], 30, { trolley: true, transit: true }),
  corridor("GEARY", [[37.7870, -122.4070], [37.7840, -122.4330], [37.7810, -122.4600], [37.7800, -122.4900]], 32, { trolley: true, transit: true }),
  corridor("VAN NESS", [[37.8020, -122.4230], [37.7860, -122.4210], [37.7720, -122.4190]], 30, { trolley: true, transit: true }),
  corridor("UNION", [[37.7980, -122.4360], [37.7980, -122.4200]], 26, { trolley: true }),
  corridor("FILLMORE", [[37.8000, -122.4360], [37.7760, -122.4330]], 26, { trolley: true }),
  corridor("STOCKTON", [[37.7860, -122.4070], [37.7960, -122.4080], [37.8020, -122.4110]], 24, { trolley: true }),
  corridor("COLUMBUS", [[37.7960, -122.4040], [37.8000, -122.4090], [37.8050, -122.4140]], 30, { trolley: true }),
  // Green paint: the city's protected bike spine.
  corridor("VALENCIA", [[37.7690, -122.4220], [37.7500, -122.4210]], 22, { bike: true }),
  corridor("THE WIGGLE", [[37.7710, -122.4270], [37.7700, -122.4410]], 22, { bike: true }),
  corridor("THE EMBARCADERO", [[37.7900, -122.3880], [37.7990, -122.3930], [37.8080, -122.4110], [37.8070, -122.4260]], 34, { bike: true }),
  corridor("JFK DRIVE", [[37.7720, -122.4550], [37.7710, -122.4830], [37.7700, -122.5080]], 26, { bike: true }),
  corridor("POLK", [[37.8000, -122.4210], [37.7800, -122.4190]], 22, { bike: true }),
];

/** Distance from a point to a corridor polyline, or Infinity past its reach. */
function corridorDistance(x: number, z: number, c: Corridor): number {
  let best = Infinity;
  for (let i = 1; i < c.pts.length; i++) {
    const a = c.pts[i - 1];
    const b = c.pts[i];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const len2 = ex * ex + ez * ez || 1e-6;
    const t = clamp01(((x - a.x) * ex + (z - a.z) * ez) / len2);
    const d = Math.hypot(a.x + ex * t - x, a.z + ez * t - z);
    if (d < best) best = d;
  }
  return best;
}

/** Direction of the corridor nearest to (x,z), unit, or null. */
function corridorDirection(x: number, z: number, c: Corridor, out: { x: number; z: number }): boolean {
  let best = Infinity;
  let bx = 0;
  let bz = 0;
  for (let i = 1; i < c.pts.length; i++) {
    const a = c.pts[i - 1];
    const b = c.pts[i];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const len2 = ex * ex + ez * ez || 1e-6;
    const t = clamp01(((x - a.x) * ex + (z - a.z) * ez) / len2);
    const d = Math.hypot(a.x + ex * t - x, a.z + ez * t - z);
    if (d < best) {
      best = d;
      const l = Math.sqrt(len2);
      bx = ex / l;
      bz = ez / l;
    }
  }
  out.x = bx;
  out.z = bz;
  return best < Infinity;
}

/* ================================================================== *
 * Geometry helpers shared with sfGeo's conventions
 * ================================================================== */

const MARKET_DX = MARKET_STREET.bx - MARKET_STREET.ax;
const MARKET_DZ = MARKET_STREET.bz - MARKET_STREET.az;
const MARKET_LEN = Math.hypot(MARKET_DX, MARKET_DZ);
const MARKET_UX = MARKET_DX / MARKET_LEN;
const MARKET_UZ = MARKET_DZ / MARKET_LEN;

/** Parameter along Market (0 at the west end, 1 at the Embarcadero). */
function marketT(x: number, z: number): number {
  return ((x - MARKET_STREET.ax) * MARKET_DX + (z - MARKET_STREET.az) * MARKET_DZ) / (MARKET_LEN * MARKET_LEN);
}

/** Perpendicular distance to Market's infinite centreline (unsigned). */
function marketPerp(x: number, z: number): number {
  const nx = -MARKET_DZ / MARKET_LEN;
  const nz = MARKET_DX / MARKET_LEN;
  return Math.abs((x - MARKET_STREET.ax) * nx + (z - MARKET_STREET.az) * nz);
}

/** Class of the grid line at integer index n — must match `lots.ts`. */
function lineClass(n: number): RoadClass {
  return n % 4 === 0 ? "arterial" : "street";
}

/** Carriageway half-width for a class: what actually gets asphalt. */
function carriagewayFor(cls: RoadClass): number {
  switch (cls) {
    case "boulevard": return 13.4; // Market keeps 8.6 m of brick plaza per side
    case "arterial": return 9.8;
    case "street": return 6.2;
    default: return 2.6;
  }
}

/** Number of travel lanes for a class. */
function laneCountFor(cls: RoadClass): number {
  switch (cls) {
    case "boulevard": return 6;
    case "arterial": return 4;
    case "street": return 2;
    default: return 1;
  }
}

/* ================================================================== *
 * Validity tests
 * ================================================================== */

/** Landmark footprints small enough that a street through them is a bug. */
const HARD_EXCLUSIONS = EXCLUSIONS.filter(
  (e) => e.radius <= 250 && !/Park|Square|Green|Plaza|Forest|Peaks|Mason|Davidson/.test(e.reason),
);

function insideHardExclusion(x: number, z: number): boolean {
  for (const e of HARD_EXCLUSIONS) {
    const dx = x - e.x;
    const dz = z - e.z;
    if (dx * dx + dz * dz < e.radius * e.radius) return true;
  }
  return false;
}

/**
 * Can a street exist between these two points?
 *
 * The rules, in the order they are cheapest to evaluate:
 *   - inside the playable box
 *   - on land, above the tide line
 *   - not through a landmark's footprint
 *   - inside a park, only the arterials survive (park drives, not a grid)
 *   - not steeper than 47 % — San Francisco tops out at 31.5 % on Filbert, and
 *     anything past this is a cliff face the surveyors would have refused too
 */
function segmentBuildable(
  ax: number, az: number, bx: number, bz: number, cls: RoadClass,
): boolean {
  const mx = (ax + bx) * 0.5;
  const mz = (az + bz) * 0.5;
  if (mx < WORLD.minX + 20 || mx > WORLD.maxX - 20 || mz < WORLD.minZ + 20 || mz > WORLD.maxZ - 20) return false;
  if (landSDF(mx, mz) < 6) return false;
  if (insideHardExclusion(mx, mz)) return false;
  if (isPark(mx, mz) && cls !== "arterial" && cls !== "boulevard") return false;

  // Grade check along the whole run, not just end to end: a saddle between two
  // equal-height nodes hides a 60 % pitch in the middle.
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 4) return false;
  const steps = Math.max(3, Math.min(6, Math.round(len / 40)));
  let prevH = terrainHeight(ax, az);
  if (prevH < 0.7) return false;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    const h = terrainHeight(x, z);
    if (h < 0.7) return false;
    if (Math.abs(h - prevH) / (len / steps) > 0.47) return false;
    prevH = h;
  }
  return true;
}

/* ================================================================== *
 * The network
 * ================================================================== */

const _tmpDir = { x: 0, z: 0 };

export class RoadNetwork {
  readonly nodes: RoadNode[] = [];
  readonly edges: RoadEdge[] = [];
  private byKey = new Map<string, number>();
  private tiles = new Set<string>();
  /** Spatial hash of edge ids by the cell containing the edge midpoint. */
  private hash = new Map<number, number[]>();
  /** The same for nodes: a linear scan of thirty thousand nodes per chunk
   *  build is the difference between streaming and stuttering. */
  private nodeHash = new Map<number, number[]>();
  private static readonly CELL = 128;
  /** Market's own node chain, built eagerly — it is small and everything on
   *  the downtown grid needs to terminate against it. */
  private marketNodes: number[] = [];
  private marketBuilt = false;

  /* ---------------- node / edge creation ---------------- */

  private addNode(key: string, x: number, z: number): RoadNode {
    const hit = this.byKey.get(key);
    if (hit !== undefined) return this.nodes[hit];
    const n: RoadNode = {
      id: this.nodes.length,
      key,
      x,
      y: terrainHeight(x, z) + ROAD_LIFT,
      z,
      edges: [],
      bearings: [],
      cls: "alley",
      control: "none",
      corners: new Float32Array(0),
      cornerCount: 0,
      radius: 0,
      seed: hashSeed(`${WORLD_SEED}|node|${key}`),
      phaseOf: new Uint8Array(0),
      dirty: true,
    };
    this.byKey.set(key, n.id);
    this.nodes.push(n);
    const cell = this.cellOf(x, z);
    let bucket = this.nodeHash.get(cell);
    if (!bucket) {
      bucket = [];
      this.nodeHash.set(cell, bucket);
    }
    bucket.push(n.id);
    return n;
  }

  private gridNode(gi: number, iu: number, iv: number): RoadNode {
    const key = `${gi}:${iu}:${iv}`;
    const hit = this.byKey.get(key);
    if (hit !== undefined) return this.nodes[hit];
    const p = fromGridSpace(iu, iv, GRIDS[gi]);
    return this.addNode(key, p.x, p.z);
  }

  private cellOf(x: number, z: number): number {
    const i = Math.floor(x / RoadNetwork.CELL);
    const j = Math.floor(z / RoadNetwork.CELL);
    return (i & 0xffff) | ((j & 0xffff) << 16);
  }

  /**
   * Create one street between two existing nodes. Returns null when the two
   * are already joined (which happens where the seam stitcher and the grid
   * both want the same connection).
   */
  private addEdge(
    a: RoadNode,
    b: RoadNode,
    cls: RoadClass,
    gi: number,
    name: string,
    isAlley = false,
  ): RoadEdge | null {
    for (const eid of a.edges) {
      const e = this.edges[eid];
      if (e.a === b.id || e.b === b.id) return null;
    }
    const dx0 = b.x - a.x;
    const dz0 = b.z - a.z;
    const length = Math.hypot(dx0, dz0);
    if (length < 3) return null;
    const dx = dx0 / length;
    const dz = dz0 / length;

    const halfWidth = ROAD_HALF_WIDTH[cls];
    const carriageway = isAlley ? 3.0 : Math.min(carriagewayFor(cls), halfWidth);

    const e: RoadEdge = {
      id: this.edges.length,
      a: a.id,
      b: b.id,
      cls,
      halfWidth: isAlley ? 3.2 : halfWidth,
      carriageway,
      dx,
      dz,
      rx: -dz,
      rz: dx,
      length,
      samples: null as unknown as Float32Array,
      sampleCount: 0,
      sampleStep: PROFILE_STEP,
      trimA: 0,
      trimB: 0,
      lanes: [],
      grade: 0,
      name,
      parking: !isAlley && cls !== "boulevard" ? true : cls === "boulevard",
      transitLane: false,
      bikeLane: false,
      cableCar: false,
      trolley: false,
      isAlley,
      gi,
      district: districtAt((a.x + b.x) * 0.5, (a.z + b.z) * 0.5),
      seed: hashSeed(`${WORLD_SEED}|edge|${a.key}|${b.key}`),
    };

    this.gradeProfile(e, a, b);
    this.tagCorridors(e);
    this.buildLanes(e);

    this.edges.push(e);
    a.edges.push(e.id);
    b.edges.push(e.id);
    a.dirty = true;
    b.dirty = true;

    const cell = this.cellOf((a.x + b.x) * 0.5, (a.z + b.z) * 0.5);
    let bucket = this.hash.get(cell);
    if (!bucket) {
      bucket = [];
      this.hash.set(cell, bucket);
    }
    bucket.push(e.id);
    return e;
  }

  /**
   * Sample the terrain along the centreline, then grade it the way a road
   * actually gets graded: a few passes of a 1-2-1 smoothing kernel with the
   * ends pinned to the junction heights (so adjacent blocks meet exactly), and
   * a floor at ground level so a smoothed dip can never sink into the hill.
   */
  private gradeProfile(e: RoadEdge, a: RoadNode, b: RoadNode): void {
    const n = Math.max(2, Math.ceil(e.length / PROFILE_STEP) + 1);
    const step = e.length / (n - 1);
    e.sampleStep = step;
    e.sampleCount = n;
    const s = new Float32Array(n * 3);
    const raw = new Float32Array(n);
    const ground = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i * step;
      const x = a.x + e.dx * t;
      const z = a.z + e.dz * t;
      s[i * 3] = x;
      s[i * 3 + 2] = z;
      // `terrainHeight` walks the shoreline polygons; it is by far the most
      // expensive thing in graph construction, so it is sampled exactly once
      // per station and reused for both the profile and the floor.
      ground[i] = terrainHeight(x, z);
      raw[i] = ground[i] + ROAD_LIFT;
    }
    raw[0] = a.y;
    raw[n - 1] = b.y;

    const work = new Float32Array(raw);
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 1; i < n - 1; i++) {
        work[i] = raw[i - 1] * 0.25 + raw[i] * 0.5 + raw[i + 1] * 0.25;
      }
      raw.set(work);
      raw[0] = a.y;
      raw[n - 1] = b.y;
    }
    for (let i = 0; i < n; i++) {
      s[i * 3 + 1] = Math.max(raw[i], ground[i] + 0.06);
    }
    e.samples = s;
    e.grade = Math.atan2(b.y - a.y, e.length);
  }

  /** Attach the named-corridor dressing: wires, rails, paint. */
  private tagCorridors(e: RoadEdge): void {
    const a = this.nodes[e.a];
    const b = this.nodes[e.b];
    const mx = (a.x + b.x) * 0.5;
    const mz = (a.z + b.z) * 0.5;
    for (const c of CORRIDORS) {
      if (corridorDistance(mx, mz, c) > c.reach) continue;
      if (!corridorDirection(mx, mz, c, _tmpDir)) continue;
      // Only if the street actually runs *along* the corridor. Without this a
      // cable car track appears on every cross street Powell touches.
      const align = Math.abs(_tmpDir.x * e.dx + _tmpDir.z * e.dz);
      if (align < 0.82) continue;
      e.name = withSuffix(c.name);
      if (c.cableCar) e.cableCar = true;
      if (c.trolley) e.trolley = true;
      if (c.transit) e.transitLane = true;
      if (c.bike) e.bikeLane = true;
    }
    if (e.cls === "boulevard") {
      e.transitLane = true;
      e.trolley = true;
    }
    // A bike lane on an alley or a cable car in the Sunset is nonsense.
    if (e.isAlley) {
      e.bikeLane = false;
      e.cableCar = false;
      e.trolley = false;
      e.transitLane = false;
    }
  }

  /**
   * Lay out the cross-section. Order across the carriageway, left kerb to
   * right kerb: parking, [bike], transit, travel × n, transit, [bike], parking.
   * Lanes are sized to fill the paved width exactly, because a lane line that
   * does not land on the edge of the asphalt reads as a mistake even to people
   * who could not tell you why.
   */
  private buildLanes(e: RoadEdge): void {
    const total = e.carriageway * 2;
    const lanes: Lane[] = [];
    const parkW = e.parking && total > 11 ? 2.5 : 0;
    const bikeW = e.bikeLane && total > 14 ? 1.8 : 0;
    const travelCount = Math.max(1, Math.min(laneCountFor(e.cls), Math.floor((total - 2 * parkW - 2 * bikeW) / 3.0)));
    const travelTotal = total - 2 * parkW - 2 * bikeW;
    const laneW = travelTotal / travelCount;

    let cursor = -e.carriageway;
    const push = (w: number, dir: 1 | -1, kind: Lane["kind"]) => {
      if (w <= 0.05) return;
      lanes.push({ offset: cursor + w * 0.5, width: w, dir, kind });
      cursor += w;
    };
    // Left kerb (the b→a side).
    push(parkW, -1, "parking");
    push(bikeW, -1, "bike");
    const half = Math.floor(travelCount / 2);
    for (let i = 0; i < travelCount; i++) {
      const dir: 1 | -1 = i < half ? -1 : 1;
      const kind: Lane["kind"] =
        e.transitLane && (i === 0 || i === travelCount - 1) ? "transit" : "travel";
      push(laneW, dir, kind);
    }
    push(bikeW, 1, "bike");
    push(parkW, 1, "parking");
    e.lanes = lanes;
  }

  /* ---------------- Market ---------------- */

  /**
   * Market Street. It is not a grid line for the downtown grid — it runs
   * parallel to that grid's long axis but sits at a non-integer offset — so it
   * is built explicitly, and every north-grid street that would cross it is
   * split at the crossing. That split is what produces the irregular junctions
   * along the Market seam.
   */
  private buildMarket(): void {
    if (this.marketBuilt) return;
    this.marketBuilt = true;

    // Collect every crossing parameter contributed by either grid.
    const crossings: { t: number; gi: number; iv: number }[] = [];
    for (let gi = 0; gi <= 1; gi++) {
      const g = GRIDS[gi];
      // The v axis of both downtown grids runs parallel to Market, so a line of
      // constant v meets Market once, at u = the Market offset.
      const origin = toGridSpace(MARKET_STREET.ax, MARKET_STREET.az, g);
      const far = toGridSpace(MARKET_STREET.bx, MARKET_STREET.bz, g);
      const v0 = Math.floor(Math.min(origin.v, far.v)) - 1;
      const v1 = Math.ceil(Math.max(origin.v, far.v)) + 1;
      const uMarket = (origin.u + far.u) * 0.5;
      for (let iv = v0; iv <= v1; iv++) {
        const p = fromGridSpace(uMarket, iv, g);
        const t = marketT(p.x, p.z);
        if (t < 0.002 || t > 0.998) continue;
        crossings.push({ t, gi, iv });
      }
    }
    crossings.sort((p, q) => p.t - q.t);

    // Merge crossings that land on top of each other — a north-grid street and
    // a south-grid street four metres apart is one junction, not two.
    const kept: { t: number }[] = [];
    for (const c of crossings) {
      const last = kept[kept.length - 1];
      if (last && (c.t - last.t) * MARKET_LEN < 26) continue;
      kept.push({ t: c.t });
    }
    if (kept.length < 2) return;

    let prev: RoadNode | null = null;
    for (let i = 0; i < kept.length; i++) {
      const t = kept[i].t;
      const x = MARKET_STREET.ax + MARKET_DX * t;
      const z = MARKET_STREET.az + MARKET_DZ * t;
      if (landSDF(x, z) < 6 || terrainHeight(x, z) < 0.7) {
        prev = null;
        continue;
      }
      const node = this.addNode(`M:${i}`, x, z);
      this.marketNodes.push(node.id);
      if (prev) this.addEdge(prev, node, "boulevard", -1, "MARKET ST");
      prev = node;
    }
  }

  /** The Market node nearest a point, within `tol` metres. */
  private marketNodeNear(x: number, z: number, tol: number): RoadNode | null {
    let best: RoadNode | null = null;
    let bestD = tol;
    for (const id of this.marketNodes) {
      const n = this.nodes[id];
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  /* ---------------- tiles ---------------- */

  /**
   * Materialise the graph for everything overlapping the box. Callers building
   * chunk geometry must pass a box inflated by at least one block (260 m is
   * used everywhere) so that every edge incident on an in-box node exists
   * before its junction polygon is computed — otherwise a chunk built at the
   * edge of the streamed region would bake a two-way junction that later grows
   * a third arm.
   */
  ensureRect(minX: number, minZ: number, maxX: number, maxZ: number): void {
    this.buildMarket();
    const i0 = Math.floor(minX / TILE);
    const i1 = Math.floor(maxX / TILE);
    const j0 = Math.floor(minZ / TILE);
    const j1 = Math.floor(maxZ / TILE);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const key = `${i}:${j}`;
        if (this.tiles.has(key)) continue;
        this.tiles.add(key);
        this.buildTile(i * TILE, j * TILE);
      }
    }
  }

  /** Every grid node whose position falls in this tile, plus its two forward
   *  edges. Ownership by position keeps tiles from racing each other. */
  private buildTile(tx: number, tz: number): void {
    const tx1 = tx + TILE;
    const tz1 = tz + TILE;
    for (let gi = 0; gi < GRIDS.length; gi++) {
      const g = GRIDS[gi];
      let u0 = Infinity;
      let u1 = -Infinity;
      let v0 = Infinity;
      let v1 = -Infinity;
      for (let c = 0; c < 4; c++) {
        const x = c & 1 ? tx1 : tx;
        const z = c & 2 ? tz1 : tz;
        const gs = toGridSpace(x, z, g);
        if (gs.u < u0) u0 = gs.u;
        if (gs.u > u1) u1 = gs.u;
        if (gs.v < v0) v0 = gs.v;
        if (gs.v > v1) v1 = gs.v;
      }
      for (let iv = Math.floor(v0); iv <= Math.ceil(v1); iv++) {
        for (let iu = Math.floor(u0); iu <= Math.ceil(u1); iu++) {
          const p = fromGridSpace(iu, iv, g);
          if (p.x < tx || p.x >= tx1 || p.z < tz || p.z >= tz1) continue;
          this.emitFrom(gi, iu, iv);
        }
      }
    }
  }

  /**
   * The two forward edges out of grid node (iu, iv), plus the mid-block alley
   * that runs behind the deep SoMa and Mission blocks.
   */
  private emitFrom(gi: number, iu: number, iv: number): void {
    const g = GRIDS[gi];
    const p = fromGridSpace(iu, iv, g);
    // +u direction: a line of constant v.
    this.tryGridEdge(gi, iu, iv, iu + 1, iv, lineClass(iv), streetName(gi, 1, iv));
    // +v direction: a line of constant u.
    this.tryGridEdge(gi, iu, iv, iu, iv + 1, lineClass(iu), streetName(gi, 0, iu));

    // Mid-block service alleys. Only where the block is deep enough that
    // `lots.ts` leaves a rear yard wide enough to hold one, and only sometimes:
    // a city where every block has an alley reads as a maze, not as a city.
    if (g.spacingV >= 150) {
      const rng = makeRng(hashSeed(`${WORLD_SEED}|alley|${gi}|${iu}|${iv}`));
      if (rng.chance(0.3)) {
        const a = fromGridSpace(iu, iv + 0.5, g);
        const b = fromGridSpace(iu + 1, iv + 0.5, g);
        if (
          gridAt((a.x + b.x) * 0.5, (a.z + b.z) * 0.5) === g &&
          segmentBuildable(a.x, a.z, b.x, b.z, "alley")
        ) {
          const na = this.addNode(`${gi}:${iu}:${iv}.5`, a.x, a.z);
          const nb = this.addNode(`${gi}:${iu + 1}:${iv}.5`, b.x, b.z);
          this.addEdge(na, nb, "alley", gi, `${streetName(gi, 1, iv)} ALLEY`, true);
        }
      }
    }
    void p;
  }

  private tryGridEdge(
    gi: number,
    iu0: number, iv0: number,
    iu1: number, iv1: number,
    cls: RoadClass,
    name: string,
  ): void {
    const g = GRIDS[gi];
    const p0 = fromGridSpace(iu0, iv0, g);
    const p1 = fromGridSpace(iu1, iv1, g);
    const mx = (p0.x + p1.x) * 0.5;
    const mz = (p0.z + p1.z) * 0.5;

    // The governing-grid test, identical to the one `lots.ts` uses to decide
    // which grid owns a block. Without it the north and south grids would both
    // pave the same ground along Market.
    if (gridAt(mx, mz) !== g) return;

    // Suppress grid lines that run so close to Market that their kerbs would
    // collide with Market's. The block they would have bounded fronts Market
    // instead, which is what actually happens on the ground.
    const clearance = marketPerp(mx, mz);
    const t = marketT(mx, mz);
    const nearMarket = t > -0.02 && t < 1.02;
    if (nearMarket && clearance < MARKET_STREET.halfWidth + ROAD_HALF_WIDTH[cls] + 4) return;

    if (!segmentBuildable(p0.x, p0.z, p1.x, p1.z, cls)) return;

    const a = this.gridNode(gi, iu0, iv0);
    const b = this.gridNode(gi, iu1, iv1);

    // Does Market cut across this segment? If so, split it there so the
    // crossing becomes a real junction rather than a painted overlap.
    if (nearMarket) {
      const sideA = this.marketSideSigned(a.x, a.z);
      const sideB = this.marketSideSigned(b.x, b.z);
      if (sideA * sideB < 0) {
        const f = sideA / (sideA - sideB);
        const cx = a.x + (b.x - a.x) * f;
        const cz = a.z + (b.z - a.z) * f;
        const mn = this.marketNodeNear(cx, cz, 90);
        if (mn) {
          if (Math.hypot(mn.x - a.x, mn.z - a.z) > 14) this.addEdge(a, mn, cls, gi, name);
          if (Math.hypot(mn.x - b.x, mn.z - b.z) > 14) this.addEdge(mn, b, cls, gi, name);
          return;
        }
      }
      // A south-grid street whose endpoint sits on Market should terminate at
      // the Market node rather than beside it.
      const snapA = Math.abs(sideA) < 3 ? this.marketNodeNear(a.x, a.z, 40) : null;
      const snapB = Math.abs(sideB) < 3 ? this.marketNodeNear(b.x, b.z, 40) : null;
      if (snapA || snapB) {
        this.addEdge(snapA ?? a, snapB ?? b, cls, gi, name);
        return;
      }
    }

    this.addEdge(a, b, cls, gi, name);
  }

  private marketSideSigned(x: number, z: number): number {
    const nx = -MARKET_DZ / MARKET_LEN;
    const nz = MARKET_DX / MARKET_LEN;
    return (x - MARKET_STREET.ax) * nx + (z - MARKET_STREET.az) * nz;
  }

  /* ---------------- junction geometry ---------------- */

  /**
   * Build (or rebuild) a node's junction polygon.
   *
   * For each pair of angularly adjacent approaches, intersect their facing kerb
   * lines. That intersection is the kerb return corner — the point a pedestrian
   * stands on waiting to cross — and the distance from the node to it, measured
   * along each approach, is exactly how far that approach's ribbon must be
   * trimmed so the junction deck covers the gap with no overlap and no hole.
   *
   * Nearly-parallel approaches (a street continuing straight through a T) are
   * special-cased, because their kerb lines meet at infinity.
   */
  private computeNode(n: RoadNode): void {
    n.dirty = false;
    const deg = n.edges.length;
    n.bearings.length = 0;
    if (deg === 0) {
      n.corners = new Float32Array(0);
      n.cornerCount = 0;
      return;
    }

    // Sort approaches by outgoing bearing.
    const order = n.edges.map((eid) => {
      const e = this.edges[eid];
      const out = e.a === n.id ? 1 : -1;
      return { eid, ang: Math.atan2(e.dz * out, e.dx * out) };
    });
    order.sort((p, q) => p.ang - q.ang);
    for (let i = 0; i < order.length; i++) {
      n.edges[i] = order[i].eid;
      n.bearings.push(order[i].ang);
    }

    // Highest class present drives control and kerb-ramp styling.
    let best: RoadClass = "alley";
    const rank: Record<RoadClass, number> = { alley: 0, street: 1, arterial: 2, boulevard: 3 };
    for (const eid of n.edges) {
      const c = this.edges[eid].cls;
      if (rank[c] > rank[best]) best = c;
    }
    n.cls = best;
    n.control = deg <= 2 ? "none" : rank[best] >= 2 ? "signal" : "stop";

    // Signal phasing: split the approaches into two opposing groups by bearing.
    n.phaseOf = new Uint8Array(deg);
    const base = n.bearings[0];
    for (let i = 0; i < deg; i++) {
      let d = n.bearings[i] - base;
      while (d < 0) d += Math.PI * 2;
      // 0..90° and 180..270° are phase 0; the rest phase 1.
      n.phaseOf[i] = d > Math.PI * 0.5 && d <= Math.PI * 1.5 ? 1 : 0;
    }

    const corners = new Float32Array(Math.max(4, deg) * 3);
    let cc = 0;
    let radius = 0;
    const trim = new Float32Array(deg);

    const dirOf = (i: number): { dx: number; dz: number; hw: number } => {
      const e = this.edges[n.edges[i]];
      const out = e.a === n.id ? 1 : -1;
      return { dx: e.dx * out, dz: e.dz * out, hw: e.carriageway };
    };

    for (let i = 0; i < deg; i++) {
      const j = (i + 1) % deg;
      const A = dirOf(i);
      const B = dirOf(j);
      // Approach i's kerb on the side facing approach j is its *left* in the
      // outgoing sense (bearings increase counter-clockwise in screen terms).
      const anx = -A.dz;
      const anz = A.dx;
      const bnx = -B.dz;
      const bnz = B.dx;
      // Point + direction form of each kerb line.
      const p1x = n.x + anx * A.hw;
      const p1z = n.z + anz * A.hw;
      const p2x = n.x - bnx * B.hw;
      const p2z = n.z - bnz * B.hw;
      const cross = A.dx * B.dz - A.dz * B.dx;

      let cx: number;
      let cz: number;
      if (deg === 1 || Math.abs(cross) < 0.08) {
        // Straight-through or a stub: square the corner off at the wider of the
        // two half-widths, one metre proud so the deck still stitches.
        const hw = Math.max(A.hw, B.hw);
        const ext = deg === 1 ? hw : 1.0;
        cx = n.x + anx * A.hw + A.dx * ext;
        cz = n.z + anz * A.hw + A.dz * ext;
      } else {
        const t = ((p2x - p1x) * B.dz - (p2z - p1z) * B.dx) / cross;
        cx = p1x + A.dx * t;
        cz = p1z + A.dz * t;
        // A kerb return should never fly off to infinity on a 5° fork.
        const d = Math.hypot(cx - n.x, cz - n.z);
        const cap = Math.max(A.hw, B.hw) * 3.2 + 6;
        if (d > cap) {
          cx = n.x + (cx - n.x) * (cap / d);
          cz = n.z + (cz - n.z) * (cap / d);
        }
      }

      // Trim each of the two approaches back past this corner.
      const projA = (cx - n.x) * A.dx + (cz - n.z) * A.dz;
      const projB = (cx - n.x) * B.dx + (cz - n.z) * B.dz;

      // Corner height comes from the two approaches' own graded surfaces rather
      // than from the node, so the junction deck meets each ribbon end at the
      // same height instead of leaving a centimetre step you trip over.
      const ea = this.edges[n.edges[i]];
      const eb = this.edges[n.edges[j]];
      const ya = this.approachY(ea, n.id, projA, A.hw);
      const yb = this.approachY(eb, n.id, projB, -B.hw);
      corners[cc * 3] = cx;
      corners[cc * 3 + 1] = (ya + yb) * 0.5;
      corners[cc * 3 + 2] = cz;
      cc++;
      if (projA > trim[i]) trim[i] = projA;
      if (projB > trim[j]) trim[j] = projB;
      radius = Math.max(radius, Math.hypot(cx - n.x, cz - n.z));
    }

    // Degree 1 is a dead end. The single "corner" the loop produced is not a
    // junction at all, so replace it with a proper square cap: the two kerb
    // points at the node and the two a body-length out, which gives the stub a
    // finished end instead of a wedge.
    if (deg === 1) {
      const A = dirOf(0);
      const anx = -A.dz;
      const anz = A.dx;
      const ext = A.hw;
      const put = (i: number, x: number, z: number) => {
        corners[i * 3] = x;
        corners[i * 3 + 1] = this.approachY(this.edges[n.edges[0]], n.id, 0, 0);
        corners[i * 3 + 2] = z;
      };
      put(0, n.x + anx * A.hw, n.z + anz * A.hw);
      put(1, n.x + anx * A.hw + A.dx * ext, n.z + anz * A.hw + A.dz * ext);
      put(2, n.x - anx * A.hw + A.dx * ext, n.z - anz * A.hw + A.dz * ext);
      put(3, n.x - anx * A.hw, n.z - anz * A.hw);
      cc = 4;
      trim[0] = ext;
    }

    n.corners = corners;
    n.cornerCount = cc;
    n.radius = radius;

    for (let i = 0; i < deg; i++) {
      const e = this.edges[n.edges[i]];
      // Never eat more than 40 % of a short block.
      const t = Math.min(trim[i] + 0.35, e.length * 0.4);
      if (e.a === n.id) e.trimA = t;
      else e.trimB = t;
    }
  }

  /**
   * Surface height of an approach `d` metres out from `nodeId`, `lat` metres to
   * the right of the outgoing direction. Used to stitch junction decks.
   */
  private approachY(e: RoadEdge, nodeId: number, d: number, lat: number): number {
    const atA = e.a === nodeId;
    const s = clamp(atA ? d : e.length - d, 0, e.length);
    return roadSurface(e, s, atA ? lat : -lat).y;
  }

  /** Ensure a node's junction geometry is current. */
  node(id: number): RoadNode {
    const n = this.nodes[id];
    if (n.dirty) this.computeNode(n);
    return n;
  }

  /** Ensure both endpoints of an edge are resolved (so trims are valid). */
  edge(id: number): RoadEdge {
    const e = this.edges[id];
    if (this.nodes[e.a].dirty) this.computeNode(this.nodes[e.a]);
    if (this.nodes[e.b].dirty) this.computeNode(this.nodes[e.b]);
    return e;
  }

  /* ---------------- queries ---------------- */

  /**
   * Edges whose midpoint falls in the box. Midpoint ownership is what makes
   * chunk streaming seamless: an edge belongs to exactly one chunk however far
   * it spills across the boundary.
   */
  edgesInRect(minX: number, minZ: number, maxX: number, maxZ: number, out: RoadEdge[] = []): RoadEdge[] {
    out.length = 0;
    const c = RoadNetwork.CELL;
    const i0 = Math.floor(minX / c);
    const i1 = Math.floor(maxX / c);
    const j0 = Math.floor(minZ / c);
    const j1 = Math.floor(maxZ / c);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const bucket = this.hash.get((i & 0xffff) | ((j & 0xffff) << 16));
        if (!bucket) continue;
        for (const id of bucket) {
          const e = this.edges[id];
          const a = this.nodes[e.a];
          const b = this.nodes[e.b];
          const mx = (a.x + b.x) * 0.5;
          const mz = (a.z + b.z) * 0.5;
          if (mx < minX || mx >= maxX || mz < minZ || mz >= maxZ) continue;
          out.push(this.edge(id));
        }
      }
    }
    return out;
  }

  /** Nodes whose position falls in the box, junction geometry resolved. */
  nodesInRect(minX: number, minZ: number, maxX: number, maxZ: number, out: RoadNode[] = []): RoadNode[] {
    out.length = 0;
    const c = RoadNetwork.CELL;
    const i0 = Math.floor(minX / c);
    const i1 = Math.floor(maxX / c);
    const j0 = Math.floor(minZ / c);
    const j1 = Math.floor(maxZ / c);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const bucket = this.nodeHash.get((i & 0xffff) | ((j & 0xffff) << 16));
        if (!bucket) continue;
        for (const id of bucket) {
          const n = this.nodes[id];
          if (n.x < minX || n.x >= maxX || n.z < minZ || n.z >= maxZ) continue;
          if (n.edges.length === 0) continue;
          out.push(this.node(id));
        }
      }
    }
    return out;
  }

  /**
   * Nearest edge to a point, with the parameter along it. Used by traffic AI to
   * snap a vehicle onto the network and by the HUD to name the street you are
   * standing on. `maxDist` bounds the search rings.
   */
  nearestEdge(x: number, z: number, maxDist = 90): { edge: RoadEdge; s: number; lateral: number; distance: number } | null {
    const c = RoadNetwork.CELL;
    const reach = Math.ceil(maxDist / c) + 1;
    const ci = Math.floor(x / c);
    const cj = Math.floor(z / c);
    let best: RoadEdge | null = null;
    let bestD = maxDist;
    let bestS = 0;
    let bestLat = 0;
    for (let j = cj - reach; j <= cj + reach; j++) {
      for (let i = ci - reach; i <= ci + reach; i++) {
        const bucket = this.hash.get((i & 0xffff) | ((j & 0xffff) << 16));
        if (!bucket) continue;
        for (const id of bucket) {
          const e = this.edges[id];
          const a = this.nodes[e.a];
          const s = clamp((x - a.x) * e.dx + (z - a.z) * e.dz, 0, e.length);
          const px = a.x + e.dx * s;
          const pz = a.z + e.dz * s;
          const d = Math.hypot(px - x, pz - z);
          if (d < bestD) {
            bestD = d;
            best = e;
            bestS = s;
            bestLat = (x - a.x) * e.rx + (z - a.z) * e.rz;
          }
        }
      }
    }
    if (!best) return null;
    return { edge: this.edge(best.id), s: bestS, lateral: bestLat, distance: bestD };
  }

  /** Total node/edge counts — for the debug overlay. */
  get stats(): { nodes: number; edges: number; tiles: number } {
    return { nodes: this.nodes.length, edges: this.edges.length, tiles: this.tiles.size };
  }

  /** Drop everything. Called on unmount so a hot reload does not leak. */
  clear(): void {
    this.nodes.length = 0;
    this.edges.length = 0;
    this.byKey.clear();
    this.tiles.clear();
    this.hash.clear();
    this.nodeHash.clear();
    this.marketNodes.length = 0;
    this.marketBuilt = false;
  }
}

/** The one network. Everything shares it. */
export const roadNetwork = new RoadNetwork();

/* ================================================================== *
 * Sampling the road surface
 * ================================================================== */

export interface SurfacePoint {
  x: number;
  y: number;
  z: number;
  /** Right-hand normal in the XZ plane. */
  rx: number;
  rz: number;
  /** Forward tangent including its vertical component. */
  tx: number;
  ty: number;
  tz: number;
}

const _sp: SurfacePoint = { x: 0, y: 0, z: 0, rx: 0, rz: 0, tx: 0, ty: 0, tz: 0 };

/**
 * Position on the finished road surface, `s` metres from node a and `lateral`
 * metres to the driver's right. Includes the 2 % camber, so a wheel contact
 * point and a puddle both land where the eye expects.
 *
 * This is the function traffic, parked cars, pedestrians crossing and the
 * cable car rails all use. Nothing recomputes it.
 */
export function roadSurface(
  e: RoadEdge,
  s: number,
  lateral: number,
  out: SurfacePoint = _sp,
): SurfacePoint {
  const n = e.sampleCount;
  const f = clamp(s / e.sampleStep, 0, n - 1.0001);
  const i = Math.floor(f);
  const frac = f - i;
  const i3 = i * 3;
  const j3 = Math.min(i + 1, n - 1) * 3;
  const cx = e.samples[i3] + (e.samples[j3] - e.samples[i3]) * frac;
  const cy = e.samples[i3 + 1] + (e.samples[j3 + 1] - e.samples[i3 + 1]) * frac;
  const cz = e.samples[i3 + 2] + (e.samples[j3 + 2] - e.samples[i3 + 2]) * frac;

  // Crown: parabolic drop to the kerb, capped at the carriageway edge so the
  // pavement behind the kerb stays level.
  const lc = clamp(Math.abs(lateral) / Math.max(e.carriageway, 0.5), 0, 1);
  const crown = CAMBER * e.carriageway * lc * lc;

  out.x = cx + e.rx * lateral;
  out.z = cz + e.rz * lateral;
  out.y = cy - crown;
  out.rx = e.rx;
  out.rz = e.rz;
  // Vertical tangent from the local profile slope.
  const dy = (e.samples[j3 + 1] - e.samples[i3 + 1]) / e.sampleStep;
  const inv = 1 / Math.sqrt(1 + dy * dy);
  out.tx = e.dx * inv;
  out.ty = dy * inv;
  out.tz = e.dz * inv;
  return out;
}

/** Height of the kerb top (the pavement surface) at a point on an edge. */
export function pavementY(e: RoadEdge, s: number, side: 1 | -1): number {
  const p = roadSurface(e, s, side * e.carriageway, _sp);
  return p.y + KERB_HEIGHT;
}

/** Usable span of an edge after its junction decks have taken their bite. */
export function edgeSpan(e: RoadEdge): { s0: number; s1: number; len: number } {
  const s0 = e.trimA;
  const s1 = e.length - e.trimB;
  return { s0, s1, len: Math.max(0, s1 - s0) };
}

/* ================================================================== *
 * Traffic signals
 * ================================================================== */

/** Full signal cycle length, seconds. Real SF downtown runs 60–90 s. */
const CYCLE = 74;

export interface SignalState {
  /** Which phase group currently has green. */
  green: 0 | 1;
  /** True during the amber clearance of `green`. */
  amber: boolean;
  /** True during the all-red overlap. */
  allRed: boolean;
  /** 0..1 through the current cycle. */
  phase: number;
}

const _sig: SignalState = { green: 0, amber: false, allRed: false, phase: 0 };

/**
 * Deterministic signal state for a node. Offsets are derived from the node seed
 * so a corridor's signals are not all in lockstep — which is what makes a night
 * drive down Van Ness look alive instead of look like a metronome.
 */
export function signalState(n: RoadNode, time: number, out: SignalState = _sig): SignalState {
  const offset = (n.seed % 1000) / 1000 * CYCLE;
  const t = ((time + offset) % CYCLE + CYCLE) % CYCLE;
  const half = CYCLE * 0.5;
  const inFirst = t < half;
  const local = inFirst ? t : t - half;
  out.green = inFirst ? 0 : 1;
  out.amber = local > half - 6.5 && local <= half - 2.5;
  out.allRed = local > half - 2.5;
  out.phase = t / CYCLE;
  return out;
}

/** Signal group of an approach at a node (0 or 1). */
export function approachPhase(n: RoadNode, edgeId: number): number {
  const i = n.edges.indexOf(edgeId);
  return i < 0 ? 0 : n.phaseOf[i] ?? 0;
}

/* ================================================================== *
 * Convenience for consumers outside this directory
 * ================================================================== */

/** Which street am I standing on? Returns null off the network. */
export function streetAt(x: number, z: number): { name: string; cls: RoadClass } | null {
  const hit = roadNetwork.nearestEdge(x, z, 40);
  if (!hit) return null;
  return { name: hit.edge.name, cls: hit.edge.cls };
}

/** Lane centre offsets running in one direction — the traffic AI's spawn set. */
export function travelLanes(e: RoadEdge, dir: 1 | -1, out: Lane[] = []): Lane[] {
  out.length = 0;
  for (const l of e.lanes) {
    if (l.dir === dir && (l.kind === "travel" || l.kind === "transit" || l.kind === "turn")) out.push(l);
  }
  return out;
}

/** The kerbside parking lane on a given side, if there is one. */
export function parkingLane(e: RoadEdge, side: 1 | -1): Lane | null {
  for (const l of e.lanes) {
    if (l.kind !== "parking") continue;
    if (side === 1 && l.offset > 0) return l;
    if (side === -1 && l.offset < 0) return l;
  }
  return null;
}
