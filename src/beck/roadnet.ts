/**
 * The road network as the ground and the road surfaces both need it: every
 * Overture segment chained into continuous roads, each with the width,
 * shoulder, bank and lift of its class, in a spatial index so a ground vertex
 * can ask "what road am I near, and how far from its edge" without walking
 * three hundred polylines. Shared by terrain.ts and roads.ts only.
 */
import { lines, mulberry32, pointInRing, ringBounds, rings, roadWidth, type Neighbourhood } from "./geo";

export type Surface = "asphalt" | "chipseal" | "gravel" | "oldasphalt" | "concrete" | "dirt";

export interface Chain {
  id: number;
  name: string | null;
  cls: string;
  pts: number[][];
  len: number;
  /** Paved width, metres. */
  w: number;
  /** Gravel shoulder each side, metres, before the grass takes over. */
  shoulder: number;
  /** How far past the shoulder the cut or fill bank reaches the natural ground. */
  bank: number;
  /** Depth of the ditch on the uphill side, 0 for none. */
  ditch: number;
  /** Height the surface floats above the flattened ground. */
  lift: number;
  /** Higher wins at a junction. */
  prio: number;
  /** How far along a road profile is averaged, metres each way. */
  grade: number;
  surface: Surface;
  /** A long rural driveway: two tyre tracks with grass between. */
  strip: boolean;
  /** Which chain ends touch another road, and how far to trim back, per end. */
  trim: [number, number];
  /** Which ends get a flared apron (a driveway meeting a road). */
  apron: [boolean, boolean];
}

export interface Seg {
  chain: Chain;
  i: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Chainage at the start of the segment. */
  s0: number;
  len: number;
}

export interface Hit {
  chain: Chain;
  d: number;
  s: number;
  x: number;
  z: number;
  tx: number;
  tz: number;
  /** Which side of the road the query point is on (sign of the cross product). */
  side: number;
}

export interface RoadNet {
  chains: Chain[];
  /** Every chain, best first, whose centreline is within `r` of the point. */
  near(x: number, z: number, r: number): Hit[];
  /** Nearest chain by edge distance (d - w/2), or null beyond `r`. */
  nearest(x: number, z: number, r: number, filter?: (c: Chain) => boolean): Hit | null;
  /** Nearest hit on a specific chain, unbounded. */
  onChain(chain: Chain, x: number, z: number): Hit;
  /** Furthest any chain reaches from its centreline (half width + shoulder + bank). */
  reach: number;
}

const CLASS: Record<string, { shoulder: number; bank: number; ditch: number; lift: number; prio: number; grade: number }> = {
  secondary: { shoulder: 1.0, bank: 5.5, ditch: 0.3, lift: 0.07, prio: 5, grade: 22 },
  tertiary: { shoulder: 0.9, bank: 5, ditch: 0.3, lift: 0.065, prio: 4, grade: 20 },
  residential: { shoulder: 0.8, bank: 4.5, ditch: 0.28, lift: 0.06, prio: 3, grade: 16 },
  service: { shoulder: 0.4, bank: 2.6, ditch: 0, lift: 0.05, prio: 2, grade: 7 },
  track: { shoulder: 0.3, bank: 2, ditch: 0, lift: 0.04, prio: 1, grade: 6 },
  footway: { shoulder: 0.15, bank: 1.2, ditch: 0, lift: 0.035, prio: 0, grade: 4 },
  path: { shoulder: 0.15, bank: 1.2, ditch: 0, lift: 0.035, prio: 0, grade: 4 },
};

export function isMainRoad(cls: string): boolean {
  return cls === "secondary" || cls === "tertiary" || cls === "residential";
}

function key(p: number[]): string {
  return `${Math.round(p[0] * 4)}:${Math.round(p[1] * 4)}`;
}

/** Join segments of the same road that meet end to end into one polyline. */
function chainSegments(data: Neighbourhood): { name: string | null; cls: string; pts: number[][] }[] {
  type Piece = { name: string | null; cls: string; pts: number[][]; used: boolean };
  const pieces: Piece[] = [];
  for (const r of data.roads) {
    for (const l of lines(r.g)) {
      if (l.length < 2) continue;
      pieces.push({ name: r.name, cls: r.cls, pts: l.map((p) => [p[0], p[1]]), used: false });
    }
  }
  // Endpoints index: key -> pieces touching it.
  const ends = new Map<string, Piece[]>();
  const touch = (k: string, p: Piece) => {
    const list = ends.get(k);
    if (list) list.push(p);
    else ends.set(k, [p]);
  };
  for (const p of pieces) {
    touch(key(p.pts[0]), p);
    touch(key(p.pts[p.pts.length - 1]), p);
  }
  const same = (a: Piece, b: Piece) => a.cls === b.cls && (a.name ?? "") === (b.name ?? "");
  const out: { name: string | null; cls: string; pts: number[][] }[] = [];
  for (const start of pieces) {
    if (start.used) continue;
    start.used = true;
    let pts = start.pts.slice();
    // Grow forwards then backwards, only through endpoints where exactly one same-road piece continues.
    for (const dir of [1, -1] as const) {
      for (;;) {
        const end = dir === 1 ? pts[pts.length - 1] : pts[0];
        const cands = (ends.get(key(end)) ?? []).filter((p) => !p.used && same(p, start));
        if (cands.length !== 1) break;
        const nxt = cands[0];
        nxt.used = true;
        const forward = key(nxt.pts[0]) === key(end);
        const seq = forward ? nxt.pts.slice(1) : nxt.pts.slice(0, -1).reverse();
        pts = dir === 1 ? pts.concat(seq) : seq.reverse().concat(pts);
      }
    }
    out.push({ name: start.name, cls: start.cls, pts });
  }
  return out;
}

function polyLen(pts: number[][]): number {
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) s += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return s;
}

export function buildRoadNet(data: Neighbourhood): RoadNet {
  const rnd = mulberry32(4242);
  const raw = chainSegments(data);
  // Paved ground the school sits on: service roads and footways there are asphalt and concrete.
  const paved = data.landuse.filter((l) => l.sub === "education").flatMap((l) => rings(l.g)).map((r) => ({ r, b: ringBounds(r) }));
  const inPaved = (p: number[]) => paved.some(({ r, b }) => p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minZ && p[1] <= b.maxZ && pointInRing(p[0], p[1], r));

  const chains: Chain[] = raw.map((c, id) => {
    const k = CLASS[c.cls] ?? CLASS.service;
    const len = polyLen(c.pts);
    const mid = c.pts[Math.floor(c.pts.length / 2)];
    let surface: Surface;
    let strip = false;
    if (c.cls === "secondary") surface = "asphalt";
    else if (isMainRoad(c.cls)) surface = "chipseal";
    else if (c.cls === "service") {
      const r = rnd();
      if (inPaved(mid)) surface = "asphalt";
      else if (r < 0.1 && len < 45) surface = "concrete";
      else if (r < 0.26) surface = "oldasphalt";
      else surface = "gravel";
      strip = surface === "gravel" && len > 38 && rnd() < 0.75;
    } else if (c.cls === "footway" || c.cls === "path") surface = inPaved(mid) ? "concrete" : "dirt";
    else surface = "dirt";
    return { id, name: c.name, cls: c.cls, pts: c.pts, len, w: roadWidth(c.cls), shoulder: k.shoulder, bank: k.bank, ditch: k.ditch, lift: k.lift, prio: k.prio, grade: k.grade, surface, strip, trim: [0, 0], apron: [false, false] };
  });
  // Sort so that at a junction the higher priority road is processed first; ties by length.
  chains.sort((a, b) => b.prio - a.prio || b.len - a.len);
  chains.forEach((c, i) => (c.id = i));

  let reach = 0;
  for (const c of chains) reach = Math.max(reach, c.w / 2 + c.shoulder + c.bank);

  // Spatial index of segments, cells of 24 m, each segment in every cell its reach-expanded bbox covers.
  const cell = 24;
  const grid = new Map<string, Seg[]>();
  const cellKey = (i: number, j: number) => `${i}:${j}`;
  for (const c of chains) {
    const rc = c.w / 2 + c.shoulder + c.bank + 1;
    let s = 0;
    for (let i = 0; i < c.pts.length - 1; i++) {
      const [x0, z0] = c.pts[i];
      const [x1, z1] = c.pts[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 1e-6) continue;
      const seg: Seg = { chain: c, i, x0, z0, x1, z1, s0: s, len };
      s += len;
      const i0 = Math.floor((Math.min(x0, x1) - rc) / cell);
      const i1 = Math.floor((Math.max(x0, x1) + rc) / cell);
      const j0 = Math.floor((Math.min(z0, z1) - rc) / cell);
      const j1 = Math.floor((Math.max(z0, z1) + rc) / cell);
      for (let j = j0; j <= j1; j++) {
        for (let ii = i0; ii <= i1; ii++) {
          const k = cellKey(ii, j);
          const list = grid.get(k);
          if (list) list.push(seg);
          else grid.set(k, [seg]);
        }
      }
    }
  }

  const hitSeg = (seg: Seg, x: number, z: number): Hit => {
    const dx = seg.x1 - seg.x0;
    const dz = seg.z1 - seg.z0;
    const l2 = dx * dx + dz * dz;
    let t = ((x - seg.x0) * dx + (z - seg.z0) * dz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = seg.x0 + dx * t;
    const pz = seg.z0 + dz * t;
    const tx = dx / seg.len;
    const tz = dz / seg.len;
    const cross = (x - px) * tz - (z - pz) * tx;
    return { chain: seg.chain, d: Math.hypot(px - x, pz - z), s: seg.s0 + seg.len * t, x: px, z: pz, tx, tz, side: cross >= 0 ? 1 : -1 };
  };

  const near = (x: number, z: number, r: number): Hit[] => {
    const list = grid.get(cellKey(Math.floor(x / cell), Math.floor(z / cell)));
    if (!list) return [];
    const best = new Map<Chain, Hit>();
    for (const seg of list) {
      const h = hitSeg(seg, x, z);
      if (h.d > r) continue;
      const prev = best.get(seg.chain);
      if (!prev || h.d < prev.d) best.set(seg.chain, h);
    }
    return [...best.values()].sort((a, b) => b.chain.prio - a.chain.prio || a.d - b.d);
  };

  const nearest = (x: number, z: number, r: number, filter?: (c: Chain) => boolean): Hit | null => {
    let out: Hit | null = null;
    for (const h of near(x, z, r + reach)) {
      if (filter && !filter(h.chain)) continue;
      if (h.d - h.chain.w / 2 > r) continue;
      if (!out || h.d - h.chain.w / 2 < out.d - out.chain.w / 2) out = h;
    }
    return out;
  };

  const onChain = (chain: Chain, x: number, z: number): Hit => {
    let best: Hit | null = null;
    let s = 0;
    for (let i = 0; i < chain.pts.length - 1; i++) {
      const [x0, z0] = chain.pts[i];
      const [x1, z1] = chain.pts[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 1e-6) continue;
      const h = hitSeg({ chain, i, x0, z0, x1, z1, s0: s, len }, x, z);
      s += len;
      if (!best || h.d < best.d) best = h;
    }
    return best!;
  };

  // Junctions: a chain whose end lies on a road of equal or higher priority is trimmed back to
  // that road's edge, and a driveway meeting a road gets an apron there.
  for (const c of chains) {
    const ends: [number[], number[]] = [c.pts[0], c.pts[c.pts.length - 1]];
    ends.forEach((e, ei) => {
      const dirIn = ei === 0 ? [c.pts[1][0] - e[0], c.pts[1][1] - e[1]] : [c.pts[c.pts.length - 2][0] - e[0], c.pts[c.pts.length - 2][1] - e[1]];
      const dl = Math.hypot(dirIn[0], dirIn[1]) || 1;
      for (const h of near(e[0], e[1], 12)) {
        const o = h.chain;
        if (o === c || o.prio < c.prio || (o.prio === c.prio && o.id > c.id)) continue;
        if (h.d > o.w / 2 + 0.6) continue;
        // A continuation (my end is their end, roughly the same direction) is not a junction.
        const oe0 = o.pts[0];
        const oe1 = o.pts[o.pts.length - 1];
        const atTheirEnd = Math.hypot(oe0[0] - e[0], oe0[1] - e[1]) < 0.6 || Math.hypot(oe1[0] - e[0], oe1[1] - e[1]) < 0.6;
        const along = Math.abs((dirIn[0] * h.tx + dirIn[1] * h.tz) / dl);
        if (atTheirEnd && along > 0.8) continue;
        const cut = Math.max(0, o.w / 2 - 0.4);
        if (cut > c.trim[ei]) c.trim[ei] = Math.min(cut, c.len * 0.4);
        if (c.cls === "service" && isMainRoad(o.cls)) c.apron[ei] = true;
        break;
      }
    });
  }

  return { chains, near, nearest, onChain, reach };
}

/** Walk a polyline and return points every `step` metres between chainage a and b, with tangents. */
export function sampleChain(c: Chain, step: number, a = 0, b = c.len): { x: number; z: number; tx: number; tz: number; s: number }[] {
  const out: { x: number; z: number; tx: number; tz: number; s: number }[] = [];
  const at = (s: number) => {
    let acc = 0;
    for (let i = 0; i < c.pts.length - 1; i++) {
      const [x0, z0] = c.pts[i];
      const [x1, z1] = c.pts[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 1e-6) continue;
      if (s <= acc + len || i === c.pts.length - 2) {
        const t = Math.max(0, Math.min(1, (s - acc) / len));
        return { x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, tx: (x1 - x0) / len, tz: (z1 - z0) / len, s };
      }
      acc += len;
    }
    const p = c.pts[c.pts.length - 1];
    return { x: p[0], z: p[1], tx: 1, tz: 0, s };
  };
  const n = Math.max(1, Math.ceil((b - a) / step));
  for (let i = 0; i <= n; i++) out.push(at(a + ((b - a) * i) / n));
  // Smooth the tangents so mitres do not kink at the data's vertices.
  for (let i = 0; i < out.length; i++) {
    const p = out[Math.max(0, i - 1)];
    const q = out[Math.min(out.length - 1, i + 1)];
    let tx = q.x - p.x;
    let tz = q.z - p.z;
    const l = Math.hypot(tx, tz);
    if (l > 1e-6) {
      tx /= l;
      tz /= l;
      out[i] = { ...out[i], tx, tz };
    }
  }
  return out;
}
