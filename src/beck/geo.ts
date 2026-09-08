/**
 * Beck Road, the ground truth.
 *
 * Everything in this world is placed from real data: Overture Maps (which
 * carries OpenStreetMap and Microsoft's building footprints, addresses, roads
 * down to the driveways, land cover, fences, power lines) for the 2026-08-19
 * release, and the Mapzen/AWS terrain tiles for the ground. Coordinates are
 * metres from the address point of 8330 NE Beck Road: +x east, +z south, +y
 * up. Nothing in here touches three.
 */

export type Geom =
  | { t: "pt"; c: number[] }
  | { t: "ls"; c: number[][] }
  | { t: "mls"; c: number[][][] }
  | { t: "pg"; c: number[][][] }
  | { t: "mpg"; c: number[][][][] };

export interface Road {
  name: string | null;
  cls: string;
  g: Geom;
}
export interface Building {
  h: number | null;
  fl: number | null;
  roof: string | null;
  rm: string | null;
  fm: string | null;
  fc: string | null;
  rc: string | null;
  cls: string | null;
  name: string | null;
  src: "osm" | "ml";
  g: Geom;
}
export interface Address {
  n: string;
  st: string | null;
  g: Geom;
}
export interface Feature {
  sub: string | null;
  cls: string | null;
  name?: string | null;
  g: Geom;
}
export interface Place {
  name: string | null;
  cat: string | null;
  g: Geom;
}
export interface Neighbourhood {
  origin: { lon: number; lat: number; mx: number; my: number; label: string };
  bbox: [number[], number[]];
  roads: Road[];
  buildings: Building[];
  addresses: Address[];
  land: Feature[];
  landuse: Feature[];
  water: Feature[];
  infra: Feature[];
  places: Place[];
  terrain: { w: number; h: number; tl: number[]; br: number[]; png: string };
}

export interface Terrain {
  w: number;
  h: number;
  tl: number[];
  br: number[];
  data: Float32Array;
  /** Metres above sea level at world x,z (bilinear). */
  at(x: number, z: number): number;
}

/** Decode the height PNG: h = (R*256 + G) / 16 - 512. */
export function decodeTerrain(meta: Neighbourhood["terrain"], rgba: Uint8ClampedArray): Terrain {
  const { w, h, tl, br } = meta;
  const data = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) data[i] = (rgba[i * 4] * 256 + rgba[i * 4 + 1]) / 16 - 512;
  const sx = (w - 1) / (br[0] - tl[0]);
  const sz = (h - 1) / (br[1] - tl[1]);
  return {
    w,
    h,
    tl,
    br,
    data,
    at(x, z) {
      const fx = Math.min(w - 1.001, Math.max(0, (x - tl[0]) * sx));
      const fz = Math.min(h - 1.001, Math.max(0, (z - tl[1]) * sz));
      const i = Math.floor(fx);
      const j = Math.floor(fz);
      const u = fx - i;
      const v = fz - j;
      const a = data[j * w + i];
      const b = data[j * w + i + 1];
      const c = data[(j + 1) * w + i];
      const d = data[(j + 1) * w + i + 1];
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    },
  };
}

export async function loadNeighbourhood(): Promise<{ data: Neighbourhood; terrain: Terrain }> {
  const mod = await import("./data/neighbourhood.json");
  const data = (mod.default ?? mod) as unknown as Neighbourhood;
  const url = (await import("./data/terrain.png")).default as string;
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const rgba = g.getImageData(0, 0, img.width, img.height).data;
  return { data, terrain: decodeTerrain(data.terrain, rgba) };
}

// ---- Geometry helpers ----------------------------------------------------------

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

/** Every linestring in a geometry. */
export function lines(g: Geom): number[][][] {
  if (g.t === "ls") return [g.c];
  if (g.t === "mls") return g.c;
  if (g.t === "pg") return [g.c[0]];
  if (g.t === "mpg") return g.c.map((p) => p[0]);
  return [];
}

/** Outer rings of every polygon in a geometry (holes dropped). */
export function rings(g: Geom): number[][][] {
  if (g.t === "pg") return [g.c[0]];
  if (g.t === "mpg") return g.c.map((p) => p[0]);
  return [];
}

export function point(g: Geom): number[] | null {
  if (g.t === "pt") return g.c;
  if (g.t === "pg") return centroid(g.c[0]);
  if (g.t === "ls") return g.c[Math.floor(g.c.length / 2)];
  return null;
}

/** Signed area of a ring in metres squared (positive = counter-clockwise in x/z). */
export function ringArea(r: number[][]): number {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i];
    const q = r[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function centroid(r: number[][]): number[] {
  let x = 0;
  let z = 0;
  let n = 0;
  for (const p of r) {
    x += p[0];
    z += p[1];
    n++;
  }
  return n ? [x / n, z / n] : [0, 0];
}

export function pointInRing(x: number, z: number, r: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0];
    const zi = r[i][1];
    const xj = r[j][0];
    const zj = r[j][1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function ringBounds(r: number[][]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of r) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  return { minX, maxX, minZ, maxZ };
}

/** Minimum-area bounding rectangle of a ring by rotating calipers over edge directions. */
export function orientedBox(r: number[][]): { cx: number; cz: number; angle: number; w: number; d: number } {
  let best: { angle: number; area: number; minU: number; maxU: number; minV: number; maxV: number } | null = null;
  for (let i = 0; i < r.length - 1; i++) {
    const dx = r[i + 1][0] - r[i][0];
    const dz = r[i + 1][1] - r[i][1];
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const angle = Math.atan2(dz, dx);
    const c = Math.cos(-angle);
    const s = Math.sin(-angle);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of r) {
      const u = p[0] * c - p[1] * s;
      const v = p[0] * s + p[1] * c;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { angle, area, minU, maxU, minV, maxV };
  }
  if (!best) {
    const c = centroid(r);
    return { cx: c[0], cz: c[1], angle: 0, w: 1, d: 1 };
  }
  const cu = (best.minU + best.maxU) / 2;
  const cv = (best.minV + best.maxV) / 2;
  const c = Math.cos(best.angle);
  const s = Math.sin(best.angle);
  return { cx: cu * c - cv * s, cz: cu * s + cv * c, angle: best.angle, w: best.maxU - best.minU, d: best.maxV - best.minV };
}

/** Resample a polyline every `step` metres. Returns points with tangents. */
export function resample(line: number[][], step: number): { x: number; z: number; tx: number; tz: number; s: number }[] {
  const out: { x: number; z: number; tx: number; tz: number; s: number }[] = [];
  let carry = 0;
  let s = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const [x0, z0] = line[i];
    const [x1, z1] = line[i + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-6) continue;
    const tx = (x1 - x0) / len;
    const tz = (z1 - z0) / len;
    let d = carry;
    while (d <= len) {
      out.push({ x: x0 + tx * d, z: z0 + tz * d, tx, tz, s: s + d });
      d += step;
    }
    carry = d - len;
    s += len;
  }
  const last = line[line.length - 1];
  const prev = line[line.length - 2] ?? last;
  const len = Math.hypot(last[0] - prev[0], last[1] - prev[1]) || 1;
  out.push({ x: last[0], z: last[1], tx: (last[0] - prev[0]) / len, tz: (last[1] - prev[1]) / len, s });
  return out;
}

/** Distance from a point to a polyline, with the nearest point and tangent. */
export function nearestOnLine(x: number, z: number, line: number[][]): { d: number; x: number; z: number; tx: number; tz: number } {
  let best = { d: Infinity, x: 0, z: 0, tx: 1, tz: 0 };
  for (let i = 0; i < line.length - 1; i++) {
    const [x0, z0] = line[i];
    const [x1, z1] = line[i + 1];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const l2 = dx * dx + dz * dz || 1e-9;
    let t = ((x - x0) * dx + (z - z0) * dz) / l2;
    t = Math.max(0, Math.min(1, t));
    const px = x0 + dx * t;
    const pz = z0 + dz * t;
    const d = Math.hypot(px - x, pz - z);
    if (d < best.d) {
      const l = Math.sqrt(l2);
      best = { d, x: px, z: pz, tx: dx / l, tz: dz / l };
    }
  }
  return best;
}

export function polyLength(line: number[][]): number {
  let s = 0;
  for (let i = 0; i < line.length - 1; i++) s += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
  return s;
}

/** Road width in metres by Overture class. Bainbridge's rural roads have no kerbs; shoulders are gravel and ditch. */
export function roadWidth(cls: string): number {
  switch (cls) {
    case "secondary":
      return 7.6;
    case "tertiary":
      return 6.8;
    case "residential":
      return 5.8;
    case "service":
      return 3.4;
    case "track":
      return 2.8;
    case "footway":
    case "path":
      return 1.2;
    default:
      return 4;
  }
}

/** Short road name the way the county signs it: "NE Beck Rd". */
export function signName(name: string | null): string {
  if (!name) return "";
  return name
    .replace(/\bNortheast\b/g, "NE")
    .replace(/\bNorthwest\b/g, "NW")
    .replace(/\bSouthwest\b/g, "SW")
    .replace(/\bSoutheast\b/g, "SE")
    .replace(/\bRoad\b/g, "Rd")
    .replace(/\bAvenue\b/g, "Ave")
    .replace(/\bDrive\b/g, "Dr")
    .replace(/\bLane\b/g, "Ln")
    .replace(/\bCourt\b/g, "Ct")
    .replace(/\bPlace\b/g, "Pl")
    .replace(/\bStreet\b/g, "St");
}

/** Nearest address to a point, with the road it fronts. */
export function nearestAddress(data: Neighbourhood, x: number, z: number): { address: Address; d: number } | null {
  let best: { address: Address; d: number } | null = null;
  for (const a of data.addresses) {
    const p = point(a.g);
    if (!p) continue;
    const d = Math.hypot(p[0] - x, p[1] - z);
    if (!best || d < best.d) best = { address: a, d };
  }
  return best;
}

export function nearestRoad(data: Neighbourhood, x: number, z: number, classes?: string[], nameLike?: string): { road: Road; d: number; tx: number; tz: number; x: number; z: number } | null {
  let best: { road: Road; d: number; tx: number; tz: number; x: number; z: number } | null = null;
  for (const r of data.roads) {
    if (classes && !classes.includes(r.cls)) continue;
    if (nameLike && !(r.name || "").toLowerCase().includes(nameLike.toLowerCase())) continue;
    for (const l of lines(r.g)) {
      const n = nearestOnLine(x, z, l);
      if (!best || n.d < best.d) best = { road: r, d: n.d, tx: n.tx, tz: n.tz, x: n.x, z: n.z };
    }
  }
  return best;
}
