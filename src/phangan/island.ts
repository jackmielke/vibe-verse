/**
 * Flow Phangan: the island, as numbers.
 *
 * A rounded island, jungle in the middle and gold at the edge, with the one
 * ring road and two steep concrete shortcuts across the interior. Everything
 * here is a pure function of (x, z) so it can be unit tested and so the
 * renderer, the physics and the map all agree about where the ground is.
 *
 * Compass: north is -z, east is +x. Bearings are degrees clockwise from north,
 * which is how everybody on the island gives directions ("Chaloklum, top of
 * the island, Haad Rin, bottom right").
 */

export interface Vec2 {
  x: number;
  z: number;
}

/**
 * One knob for the size of the island. The ring road is about 1.8 km around at
 * this size, which is a ninety-second lap flat out and makes six guests fit in
 * an eight-minute day with time to stop for pad thai.
 */
const K = 0.9;

/** Radius of the coastline at angle theta (radians, atan2(z, x)). */
export function coastRadius(theta: number): number {
  return K * (380 + 28 * Math.sin(3 * theta + 0.4) + 18 * Math.sin(5 * theta + 2.1) + 10 * Math.sin(9 * theta));
}

interface Hill {
  x: number;
  z: number;
  r: number;
  h: number;
}

/** The interior: one big hill, four smaller ones. Gaussian, so the roads over them are smooth. */
const HILLS: Hill[] = [
  { x: 40, z: -20, r: 150, h: 95 },
  { x: -80, z: 90, r: 110, h: 60 },
  { x: 140, z: -120, r: 90, h: 55 },
  { x: -150, z: -140, r: 70, h: 35 },
  { x: 200, z: 150, r: 80, h: 40 },
].map((h) => ({ x: h.x * K, z: h.z * K, r: h.r * K, h: h.h }));

const k = (x: number, z: number): Vec2 => ({ x: x * K, z: z * K });

const smooth = (t: number) => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

/** Ground height in metres. Sea level is 0; the beach is just above it, the sea bed just below. */
export function terrainHeight(x: number, z: number): number {
  const d = Math.hypot(x, z);
  const coast = coastRadius(Math.atan2(z, x));
  const s = coast - d;
  if (s < 0) return Math.max(-40, 0.3 + s * 0.2);
  let h = 0.3 + (Math.min(s, 40) / 40) * 2.5;
  const inland = smooth(s / 80);
  for (const hill of HILLS) {
    const dx = x - hill.x;
    const dz = z - hill.z;
    h += hill.h * Math.exp(-(dx * dx + dz * dz) / (hill.r * hill.r)) * inland;
  }
  return h;
}

/** True where the ground is dry. */
export function isLand(x: number, z: number): boolean {
  return Math.hypot(x, z) < coastRadius(Math.atan2(z, x));
}

// ---------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------

export const ROAD_HALF_WIDTH = 3.6;

/** A point on the ring road at a compass bearing (degrees clockwise from north). */
export function ringPoint(bearingDeg: number, inland = 0): Vec2 {
  const b = (bearingDeg * Math.PI) / 180;
  const dirX = Math.sin(b);
  const dirZ = -Math.cos(b);
  const theta = Math.atan2(dirZ, dirX);
  const r = coastRadius(theta) - 52 - 8 * Math.sin(theta * 4 + 1) - inland;
  return { x: dirX * r, z: dirZ * r };
}

export interface Road {
  name: string;
  points: Vec2[];
  closed: boolean;
  /** Shortcuts are concrete, steep and narrow. */
  steep: boolean;
}

function ring(): Road {
  const pts: Vec2[] = [];
  for (let i = 0; i < 96; i++) pts.push(ringPoint((i / 96) * 360));
  return { name: "the ring road", points: pts, closed: true, steep: false };
}

/** Over the summit, west to east. Haad Yao side to the east coast. */
function summitRoad(): Road {
  const west = ringPoint(275);
  const east = ringPoint(85);
  const pts: Vec2[] = [west, k(-230, -18), k(-130, -30), k(-40, -42), k(60, -38), k(160, -20), k(250, -5), east];
  return { name: "the summit road", points: pts, closed: false, steep: true };
}

/** Thong Sala north to Chaloklum, across the saddle. */
function chaloklumRoad(): Road {
  const south = ringPoint(232);
  const north = ringPoint(2);
  const pts: Vec2[] = [south, k(-150, 190), k(-125, 110), k(-95, 30), k(-60, -60), k(-30, -150), k(0, -240), north];
  return { name: "the Chaloklum road", points: pts, closed: false, steep: true };
}

export const ROADS: Road[] = [ring(), summitRoad(), chaloklumRoad()];

/** Resample a polyline so no segment is longer than `step` metres. */
export function resample(points: Vec2[], step: number, closed: boolean): Vec2[] {
  const out: Vec2[] = [];
  const n = closed ? points.length : points.length - 1;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const k = Math.max(1, Math.ceil(len / step));
    for (let j = 0; j < k; j++) {
      const t = j / k;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  if (!closed) out.push(points[points.length - 1]);
  return out;
}

export interface RoadHit {
  /** Distance from the centreline, metres. */
  dist: number;
  road: Road | null;
  /** Nearest point on the centreline. */
  point: Vec2;
  /** Direction of travel along the road at that point, unit length. */
  dir: Vec2;
}

/** The nearest road to a point. About two hundred segments; cheap enough to call every frame for a few things. */
export function nearestRoad(x: number, z: number): RoadHit {
  let best: RoadHit = { dist: Infinity, road: null, point: { x, z }, dir: { x: 0, z: 1 } };
  for (const road of ROADS) {
    const pts = road.points;
    const n = road.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const len2 = abx * abx + abz * abz || 1;
      let t = ((x - a.x) * abx + (z - a.z) * abz) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + abx * t;
      const pz = a.z + abz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < best.dist) {
        const len = Math.sqrt(len2);
        best = { dist: d, road, point: { x: px, z: pz }, dir: { x: abx / len, z: abz / len } };
      }
    }
  }
  return best;
}

export function onRoad(x: number, z: number): boolean {
  return nearestRoad(x, z).dist <= ROAD_HALF_WIDTH + 0.6;
}

/** A point on the summit road, by fraction of its length. */
export function summitPoint(t: number): Vec2 {
  const pts = resample(ROADS[1].points, 4, false);
  return pts[Math.max(0, Math.min(pts.length - 1, Math.round(t * (pts.length - 1))))];
}

// ---------------------------------------------------------------------------
// Landmarks: all placed by road bearing so they are reachable by definition
// ---------------------------------------------------------------------------

export interface Landmark {
  key: string;
  name: string;
  pos: Vec2;
  bearing: number;
}

const mark = (key: string, name: string, bearing: number, inland = 0): Landmark => ({
  key,
  name,
  pos: ringPoint(bearing, inland),
  bearing,
});

/** The villa: west side, up the slope behind Haad Yao, two minutes from the beach. */
export const VILLA = mark("villa", "the villa", 287, 12);
export const HAAD_YAO = mark("haad-yao", "Haad Yao", 278);
export const HAAD_SALAD = mark("haad-salad", "Haad Salad", 306);
export const THONG_SALA = mark("thong-sala", "Thong Sala", 236);
export const HAAD_RIN = mark("haad-rin", "Haad Rin", 142);
export const CHALOKLUM = mark("chaloklum", "Chaloklum", 358);
export const GYM = mark("gym", "the Muay Thai gym", 266, 12);
export const CHECKPOINT = mark("checkpoint", "the police checkpoint", 224);
export const WATERFALL: Landmark = { key: "waterfall", name: "the waterfall", pos: summitPoint(0.28), bearing: 0 };

/** Where you can buy a three dollar pad thai. */
export const PAD_THAI_STOPS: Landmark[] = [
  mark("pt-east", "the east coast pad thai place", 92),
  mark("pt-bantai", "the Ban Tai night market", 188),
  mark("pt-thongsala", "the Thong Sala food court", 242),
  mark("pt-haadyao", "the 7-Eleven at Haad Yao", 281),
  mark("pt-north", "the noodle cart at Chaloklum", 352),
];

/** Dogs asleep in the road. They never move. */
export const DOGS: Vec2[] = [58, 118, 178, 254, 322, 30].map((b) => {
  const p = ringPoint(b);
  return { x: p.x + 1.4, z: p.z + 0.8 };
});

/** The north coast, where the monkeys cross. Bearings on the ring road. */
export const MONKEY_BEARINGS = [330, 345, 12, 28];

/** Where guests wait for a lift. */
export const PIN_SPOTS: Landmark[] = [
  mark("utopia", "Phangan Utopia Resort", 292),
  mark("seven", "the 7-Eleven at Haad Yao", 279),
  mark("salad", "Haad Salad", 307),
  mark("chaloklum", "Chaloklum", 356),
  mark("bottle", "the Bottle Beach turnoff", 24),
  mark("east", "the east coast", 78),
  mark("thanSadet", "the Than Sadet turnoff", 104),
  mark("rin", "Haad Rin", 140),
  mark("pier", "the ferry pier", 234),
  mark("cowork", "the coworking cafe", 252),
  mark("bantai", "Ban Tai", 190),
  mark("gym", "the Muay Thai gym", 267),
  { key: "waterfall", name: "the waterfall car park", pos: summitPoint(0.24), bearing: 0 },
  { key: "summit", name: "the top of the summit road", pos: summitPoint(0.5), bearing: 0 },
];

export const dist2 = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
