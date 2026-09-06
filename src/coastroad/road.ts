/**
 * Coast Road, the part that never touches a pixel.
 *
 * One road, two and a half kilometres, down a headland to the sea. The path is
 * a curvature function integrated into a table, so it is the same road every
 * time and the same road in both looks. The physics is a longboard: gravity
 * along the grade, drag, a carve that scrubs speed, a jump that clears a crack,
 * and the wind, which is the whole point. Nothing here can hurt you; the worst
 * outcome is grass.
 */

export const LENGTH = 2600; // metres of road
export const ROAD_HALF = 3.5; // metres, edge line to edge line
export const SAMPLE = 2; // metres between table rows
export const TOP_ELEVATION = 168; // metres above the sea at the start

export type Style = "painted" | "lens";

export interface RoadPoint {
  x: number;
  y: number;
  z: number;
  /** Unit tangent, xz only. */
  tx: number;
  tz: number;
  /** dy/ds. Negative is downhill. */
  grade: number;
  /** Signed curvature, positive turns left. */
  curve: number;
}

export type ObstacleType = "crack" | "leaves" | "puddle";

export interface Obstacle {
  s: number;
  lat: number;
  width: number;
  type: ObstacleType;
}

export interface Gust {
  s: number;
  /** +1 pushes you seaward (left), -1 pushes you into the hill. */
  side: 1 | -1;
  strength: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Curvature along the road, 1/m. Long sweepers with a couple of tighter bends. */
export function curvatureAt(s: number): number {
  return (
    0.0042 * Math.sin(s / 210) +
    0.0031 * Math.sin(s / 87 + 1.7) +
    0.0018 * Math.sin(s / 41 + 0.4) +
    (s > 900 && s < 1080 ? 0.006 * Math.sin(((s - 900) / 180) * Math.PI) : 0) +
    (s > 1700 && s < 1860 ? -0.0065 * Math.sin(((s - 1700) / 160) * Math.PI) : 0)
  );
}

/** Elevation, metres. A long drop with a few shelves; it reaches the sand at the end. */
export function elevationAt(s: number): number {
  const t = Math.min(1, Math.max(0, s / LENGTH));
  const main = TOP_ELEVATION * Math.pow(1 - t, 1.25);
  const shelves = 4.5 * Math.sin(s / 140 + 0.6) * (1 - t) + 2.2 * Math.sin(s / 53) * (1 - t);
  const tail = 2.4 * Math.max(0, 1 - Math.abs(s - LENGTH) / 120); // the last bit onto the beach
  return Math.max(0.4, main + shelves + tail);
}

let table: RoadPoint[] | null = null;

/** The road as a table, built once. */
export function roadTable(): RoadPoint[] {
  if (table) return table;
  const n = Math.floor(LENGTH / SAMPLE) + 1;
  const out: RoadPoint[] = [];
  let x = 0;
  let z = 0;
  let heading = Math.PI; // start heading -z ("north", toward the sea)
  for (let i = 0; i < n; i++) {
    const s = i * SAMPLE;
    const y = elevationAt(s);
    const grade = (elevationAt(s + 1) - elevationAt(s - 1)) / 2;
    const curve = curvatureAt(s);
    out.push({ x, y, z, tx: Math.sin(heading), tz: Math.cos(heading), grade, curve });
    heading += curve * SAMPLE;
    x += Math.sin(heading) * SAMPLE;
    z += Math.cos(heading) * SAMPLE;
  }
  table = out;
  return out;
}

const scratch: RoadPoint = { x: 0, y: 0, z: 0, tx: 0, tz: 1, grade: 0, curve: 0 };

/** Interpolated road point at arc length s. Returns a shared scratch object. */
export function roadAt(s: number, out: RoadPoint = scratch): RoadPoint {
  const t = roadTable();
  const f = Math.min(Math.max(s, 0), LENGTH) / SAMPLE;
  const i = Math.min(t.length - 2, Math.floor(f));
  const a = t[i];
  const b = t[i + 1];
  const u = Math.min(1, Math.max(0, f - i));
  out.x = a.x + (b.x - a.x) * u;
  out.y = a.y + (b.y - a.y) * u;
  out.z = a.z + (b.z - a.z) * u;
  let tx = a.tx + (b.tx - a.tx) * u;
  let tz = a.tz + (b.tz - a.tz) * u;
  const l = Math.hypot(tx, tz) || 1;
  tx /= l;
  tz /= l;
  out.tx = tx;
  out.tz = tz;
  out.grade = a.grade + (b.grade - a.grade) * u;
  out.curve = a.curve + (b.curve - a.curve) * u;
  return out;
}

/** World position of a point `lat` metres to the left of the road at s. */
export function roadPos(s: number, lat: number, out: { x: number; y: number; z: number }): void {
  const p = roadAt(s);
  // Left of the tangent (tx, tz) in xz is (-tz, tx) when looking down +y... pick one and keep it.
  out.x = p.x + -p.tz * lat;
  out.y = p.y;
  out.z = p.z + p.tx * lat;
}

/**
 * Nearest arc length to a world point. Coarse then fine; good to a metre,
 * which is all the terrain builder needs.
 */
export function nearestS(x: number, z: number): { s: number; lat: number } {
  const t = roadTable();
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < t.length; i += 6) {
    const dx = t[i].x - x;
    const dz = t[i].z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const lo = Math.max(0, best - 6);
  const hi = Math.min(t.length - 1, best + 6);
  for (let i = lo; i <= hi; i++) {
    const dx = t[i].x - x;
    const dz = t[i].z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const p = t[best];
  const lat = -p.tz * (x - p.x) + p.tx * (z - p.z);
  return { s: best * SAMPLE, lat };
}

/** Where the land meets the sea, metres left of the road. Varies along the way. */
export function coastAt(s: number): number {
  return 96 + 38 * Math.sin(s / 310 + 0.9) + 24 * Math.sin(s / 118 + 2.2) + 50 * Math.max(0, 1 - s / 500);
}

/** Cheap value noise, deterministic. */
export function noise2(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const h = (a: number, b: number) => {
    const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = h(xi, zi);
  const b = h(xi + 1, zi);
  const c = h(xi, zi + 1);
  const d = h(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x: number, z: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * (noise2(x * f, z * f) * 2 - 1);
    f *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

/**
 * Terrain height in road space. `lat` positive is seaward (left). The road bed
 * is flat for 4.5 m either side, the seaward side falls to the coast and on
 * into the sea floor, and the landward side climbs into the hills.
 */
export function terrainAt(s: number, lat: number, x: number, z: number): number {
  const base = elevationAt(Math.min(Math.max(s, 0), LENGTH));
  const a = Math.abs(lat);
  if (a <= 4.5) return base - 0.06;
  const bump = fbm(x * 0.013, z * 0.013, 3);
  if (lat > 0) {
    const c = coastAt(s);
    const t = Math.min(1, (a - 4.5) / Math.max(10, c - 4.5));
    const drop = base * 0.5 * (1 + Math.cos(Math.PI * t)); // a shoulder, then the fall, then the beach
    const land = drop + bump * 6 * t - 0.4;
    if (a < c) return Math.max(land, 0.35 + (c - a) * 0.02);
    // Sea floor: beach slope then deeper.
    return -0.6 - (a - c) * 0.22 + bump * 1.2;
  }
  const rise = (a - 4.5) * (0.42 + 0.18 * Math.sin(s / 260));
  const shape = Math.min(1, (a - 4.5) / 22);
  return base + rise * shape * shape + bump * 14 * shape + (a > 40 ? fbm(x * 0.004, z * 0.004, 3) * 28 * Math.min(1, (a - 40) / 60) : 0);
}

export function terrainAtXZ(x: number, z: number): number {
  const { s, lat } = nearestS(x, z);
  return terrainAt(s, lat, x, z);
}

// ---- Things on the road ------------------------------------------------------

export function makeObstacles(style: Style, seed = 7): Obstacle[] {
  const rnd = mulberry32(seed);
  const out: Obstacle[] = [];
  let s = 120;
  while (s < LENGTH - 80) {
    s += 55 + rnd() * 70;
    if (s > LENGTH - 60) break;
    const r = rnd();
    const type: ObstacleType = style === "painted" ? (r < 0.75 ? "crack" : "leaves") : r < 0.5 ? "crack" : r < 0.8 ? "leaves" : "puddle";
    const width = type === "crack" ? 1.6 + rnd() * 1.4 : 2.2 + rnd() * 2;
    const lat = (rnd() - 0.5) * (ROAD_HALF * 2 - width);
    out.push({ s, lat, width, type });
  }
  return out;
}

export function makeGusts(seed = 11): Gust[] {
  const rnd = mulberry32(seed);
  const out: Gust[] = [];
  let s = 200;
  while (s < LENGTH - 100) {
    s += 140 + rnd() * 180;
    if (s > LENGTH - 80) break;
    out.push({ s, side: rnd() < 0.62 ? 1 : -1, strength: 0.55 + rnd() * 0.45 });
  }
  return out;
}

/** Ambient wind, 0..1, slow and never still. */
export function ambientWind(s: number, t: number): number {
  return 0.42 + 0.22 * Math.sin(t * 0.17 + s * 0.0021) + 0.16 * Math.sin(t * 0.41 + 1.3) + 0.1 * Math.sin(s * 0.011);
}

// ---- The ride ----------------------------------------------------------------

export interface RideInput {
  /** -1 into the hill, +1 toward the sea. */
  steer: number;
  jump: boolean;
  tuck: boolean;
  brake: boolean;
}

export interface RideState {
  s: number;
  lat: number;
  speed: number;
  /** Height above the road, metres. */
  z: number;
  vz: number;
  grounded: boolean;
  lean: number;
  wobble: number;
  flow: number;
  topSpeed: number;
  elapsed: number;
  jumped: number;
  hits: number;
  onGrass: boolean;
  /** Active gust, or null. */
  gust: { side: 1 | -1; strength: number; ttl: number } | null;
  /** 0..1, ambient plus gust, for the grass and the sound. */
  wind: number;
  /** Signed lateral wind, for the particles. */
  windLat: number;
  finished: boolean;
  note: string | null;
  noteTtl: number;
  nextObstacle: number;
  nextGust: number;
  /** How much of the way the wind was at your back, running fraction. */
  tailwind: number;
}

export interface Course {
  obstacles: Obstacle[];
  gusts: Gust[];
}

export function makeCourse(style: Style): Course {
  return { obstacles: makeObstacles(style), gusts: makeGusts() };
}

export function newRide(): RideState {
  return {
    s: 12,
    lat: 0,
    speed: 0,
    z: 0,
    vz: 0,
    grounded: true,
    lean: 0,
    wobble: 0,
    flow: 0,
    topSpeed: 0,
    elapsed: 0,
    jumped: 0,
    hits: 0,
    onGrass: false,
    gust: null,
    wind: 0.5,
    windLat: 0,
    finished: false,
    note: null,
    noteTtl: 0,
    nextObstacle: 0,
    nextGust: 0,
    tailwind: 0,
  };
}

const G = 9.81;
export const MAX_SPEED = 19; // m/s, about 68 km/h, tucked on the steepest pitch

function say(st: RideState, text: string, ttl = 3) {
  st.note = text;
  st.noteTtl = ttl;
}

export function stepRide(st: RideState, input: RideInput, course: Course, dt: number): void {
  if (dt <= 0) return;
  dt = Math.min(dt, 0.05);
  st.elapsed += dt;
  if (st.noteTtl > 0) {
    st.noteTtl -= dt;
    if (st.noteTtl <= 0) st.note = null;
  }

  const p = roadAt(st.s);

  // Wind.
  const amb = ambientWind(st.s, st.elapsed);
  if (st.gust) {
    st.gust.ttl -= dt;
    if (st.gust.ttl <= 0) st.gust = null;
  } else if (st.nextGust < course.gusts.length && st.s >= course.gusts[st.nextGust].s) {
    const g = course.gusts[st.nextGust++];
    st.gust = { side: g.side, strength: g.strength, ttl: 2.6 };
    say(st, g.side > 0 ? "Gust off the hill. Lean into it." : "Gust off the sea. Lean into it.", 2.2);
  }
  const gustNow = st.gust ? st.gust.strength * Math.sin(Math.min(1, st.gust.ttl / 2.6) * Math.PI) : 0;
  st.wind = Math.min(1, amb + gustNow * 0.6);
  st.windLat = (st.gust ? st.gust.side * gustNow : 0) + 0.15 * Math.sin(st.elapsed * 0.7);
  // Tailwind: the ambient wind blows down the road most of the time; the fraction is a running mean.
  const tail = 0.5 + 0.5 * Math.sin(st.s * 0.0031 + 0.8);
  st.tailwind += (tail - st.tailwind) * Math.min(1, dt * 0.2);

  if (st.finished) {
    st.speed = Math.max(0, st.speed - 3 * dt);
    st.lean += (0 - st.lean) * Math.min(1, dt * 4);
    return;
  }

  // Speed along the road.
  const slope = -p.grade; // positive downhill
  const dragK = input.tuck ? 0.0023 : 0.0041;
  let a = G * slope * 0.92 - dragK * st.speed * st.speed - 0.22;
  if (input.brake && st.grounded) a -= 3.8;
  if (st.onGrass) a -= 2.6;
  if (st.speed < 2.6 && !input.brake) a = Math.max(a, 1.3); // a foot push whenever you are slow
  st.speed = Math.max(0, Math.min(MAX_SPEED, st.speed + a * dt));

  // Carve.
  const target = Math.max(-1, Math.min(1, input.steer)) * (st.grounded ? 1 : 0.4);
  st.lean += (target - st.lean) * Math.min(1, dt * 4.5);
  const vLat = st.lean * (0.28 * st.speed + 1.2) + st.windLat * (0.35 + st.speed / 30) * 2.4;
  st.lat += vLat * dt;
  if (st.grounded) st.speed -= Math.abs(st.lean) * 0.5 * (st.speed / 12) * dt;
  // Curvature pushes you outward if you do not turn with the road.
  st.lat += -p.curve * st.speed * st.speed * 0.12 * dt;

  // Edges.
  const half = ROAD_HALF;
  const wasGrass = st.onGrass;
  st.onGrass = Math.abs(st.lat) > half - 0.25;
  if (Math.abs(st.lat) > half + 1.6) {
    st.lat = Math.sign(st.lat) * (half + 1.6);
    st.wobble = Math.min(1, st.wobble + 0.5);
  }
  if (st.onGrass && !wasGrass && st.grounded) {
    st.wobble = Math.min(1, st.wobble + 0.35);
    say(st, st.lat > 0 ? "Grass. The sea side." : "Grass. The hill side.", 1.8);
  }

  // Jump.
  if (input.jump && st.grounded && st.speed > 1.5) {
    st.grounded = false;
    st.vz = 3.9;
    st.z = 0.01;
  }
  if (!st.grounded) {
    st.vz -= G * dt;
    st.z += st.vz * dt;
    if (st.z <= 0) {
      st.z = 0;
      st.vz = 0;
      st.grounded = true;
      st.wobble = Math.min(1, st.wobble + 0.12);
    }
  }

  // Obstacles.
  while (st.nextObstacle < course.obstacles.length && course.obstacles[st.nextObstacle].s < st.s - 2) st.nextObstacle++;
  const ob = course.obstacles[st.nextObstacle];
  if (ob && Math.abs(ob.s - st.s) < 0.9 && Math.abs(ob.lat - st.lat) < ob.width / 2 + 0.2) {
    st.nextObstacle++;
    if (!st.grounded && st.z > 0.12) {
      st.jumped++;
      st.flow += 9;
      say(st, ob.type === "crack" ? "Cleared it." : "Over the top.", 1.4);
    } else if (ob.type === "crack") {
      st.speed *= 0.62;
      st.wobble = 1;
      st.hits++;
      st.flow = Math.max(0, st.flow - 6);
      say(st, "Crack. Wheels remember that.", 1.8);
    } else if (ob.type === "leaves") {
      st.speed *= 0.86;
      st.wobble = Math.min(1, st.wobble + 0.4);
      say(st, "Leaves. Loud, harmless.", 1.6);
    } else {
      st.lat += (st.lean !== 0 ? Math.sign(st.lean) : 1) * 0.9;
      st.wobble = Math.min(1, st.wobble + 0.5);
      say(st, "Puddle. That is a slide.", 1.6);
    }
  }

  // Flow: speed, carving with the road, staying on the tarmac, staying loose.
  const carveMatch = 1 - Math.min(1, Math.abs(st.lean - Math.max(-1, Math.min(1, p.curve * 160))) * 0.5);
  const gain = (st.speed / 12) * (0.4 + 0.6 * carveMatch) * (st.onGrass ? 0.1 : 1) * (1 - st.wobble * 0.8);
  st.flow += gain * dt * 2.2;
  st.wobble = Math.max(0, st.wobble - dt * 0.9);
  st.topSpeed = Math.max(st.topSpeed, st.speed);

  // Advance. Speed is along the road; on grass you still move along it.
  st.s += st.speed * dt;
  if (st.s >= LENGTH) {
    st.s = LENGTH;
    st.finished = true;
    say(st, "The beach. You made it down.", 6);
  }
}
