/**
 * Footprint geometry for the buildings, with no three in it so it can be
 * tested on its own: a local frame aligned to the footprint's oriented box,
 * the split of a rectilinear footprint into the overlapping rectangles that
 * each carry a roof (an L is two bars that cross, a T is a bar and a stem
 * that runs through it), and a ring offset for the stem wall. Coordinates
 * are the world's: metres, +x east, +z south. Rings are normalised to run
 * clockwise in x/z so the outward normal of an edge (dx, dz) is (-dz, dx).
 */
import { orientedBox, pointInRing, ringArea } from "./geo";

export interface Frame {
  cx: number;
  cz: number;
  c: number;
  s: number;
  /** Extent of the oriented box along u and v (full widths). */
  w: number;
  d: number;
}

/** A rectangle in the frame: centre and half extents along u (ridge) and v (across). */
export interface Rect {
  cu: number;
  cv: number;
  hu: number;
  hv: number;
}

/** A closed ring, clockwise in x/z, without a duplicated last point. */
export function normaliseRing(ring: number[][]): number[][] {
  const pts = ring.slice();
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (pts.length > 1 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6) pts.pop();
  // Drop repeated points.
  const out: number[][] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.02) out.push([p[0], p[1]]);
  }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 0.02) out.pop();
  if (ringArea(out) > 0) out.reverse();
  return out;
}

/**
 * The frame is aligned to the dominant wall direction (edge directions folded
 * modulo 90 degrees and weighted by length), which for a house is the same as
 * the minimum-area box and for a rambling school is not: the box tilts to
 * shave area off the corners and every wall then reads as skewed.
 */
export function frameOf(ring: number[][]): Frame {
  const n = ring.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const t = Math.atan2(dz, dx) * 4;
    sx += Math.cos(t) * len;
    sy += Math.sin(t) * len;
  }
  let angle = Math.hypot(sx, sy) > 1e-6 ? Math.atan2(sy, sx) / 4 : orientedBox(ring.concat([ring[0]])).angle;
  const c0 = Math.cos(angle);
  const s0 = Math.sin(angle);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const p of ring) {
    const u = p[0] * c0 + p[1] * s0;
    const v = -p[0] * s0 + p[1] * c0;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  let w = maxU - minU;
  let d = maxV - minV;
  let cu = (minU + maxU) / 2;
  let cv = (minV + maxV) / 2;
  // Put the long side along u so a plain rectangle's ridge runs the long way.
  if (d > w) {
    angle += Math.PI / 2;
    const t = w;
    w = d;
    d = t;
    const tu = cu;
    cu = cv;
    cv = -tu;
  }
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { cx: cu * c - cv * s, cz: cu * s + cv * c, c, s, w, d };
}

export function toWorld(f: Frame, u: number, v: number): [number, number] {
  return [f.cx + u * f.c - v * f.s, f.cz + u * f.s + v * f.c];
}

export function toLocal(f: Frame, x: number, z: number): [number, number] {
  const dx = x - f.cx;
  const dz = z - f.cz;
  return [dx * f.c + dz * f.s, -dx * f.s + dz * f.c];
}

function cluster(values: number[], tol: number): number[] {
  const sorted = values.slice().sort((a, b) => a - b);
  const out: number[] = [];
  let group: number[] = [];
  for (const v of sorted) {
    if (group.length && v - group[group.length - 1] > tol) {
      out.push(group.reduce((a, b) => a + b, 0) / group.length);
      group = [];
    }
    group.push(v);
  }
  if (group.length) out.push(group.reduce((a, b) => a + b, 0) / group.length);
  return out;
}

function nearest(values: number[], v: number): number {
  let best = values[0];
  for (const x of values) if (Math.abs(x - v) < Math.abs(best - v)) best = x;
  return best;
}

export interface Decomposition {
  /** True when every edge runs along u or v, so the rectangles follow the walls. */
  rectilinear: boolean;
  /** Largest first. Rectangles may overlap; their union covers the footprint. */
  rects: Rect[];
  /** The ring snapped to the grid, in the frame, when rectilinear. */
  snapped: [number, number][];
}

/**
 * Split a footprint into the rectangles that carry its roofs. Rectilinear
 * footprints are snapped to a grid of their own edge lines and covered by
 * greedy maximal rectangles, each of which runs as far as it can (so a wing's
 * roof runs through to the far wall and shows a gable on both faces, the way
 * a cross-gabled house does). Anything else gets its oriented box.
 */
export function decompose(ring: number[][], f: Frame, maxRects = 6): Decomposition {
  const uv = ring.map((p) => toLocal(f, p[0], p[1]));
  const n = uv.length;
  // Rectilinear enough: the walls that run off-axis (hand-traced jogs, a bay) are a small part of the perimeter.
  let perimeter = 0;
  let skewed = 0;
  for (let i = 0; i < n; i++) {
    const a = uv[i];
    const b = uv[(i + 1) % n];
    const du = Math.abs(b[0] - a[0]);
    const dv = Math.abs(b[1] - a[1]);
    const len = Math.hypot(du, dv);
    if (len < 0.05) continue;
    perimeter += len;
    if (Math.min(du, dv) / len > 0.18) skewed += len;
  }
  const rectilinear = skewed < perimeter * 0.15;
  const box: Rect = { cu: 0, cv: 0, hu: f.w / 2, hv: f.d / 2 };
  if (!rectilinear || n < 6) return { rectilinear, rects: [box], snapped: uv };

  const us = cluster(uv.map((p) => p[0]), 0.45);
  const vs = cluster(uv.map((p) => p[1]), 0.45);
  const snapped: [number, number][] = uv.map((p) => [nearest(us, p[0]), nearest(vs, p[1])]);
  if (us.length < 2 || vs.length < 2) return { rectilinear, rects: [box], snapped };
  const snappedRing = snapped.map((p) => [p[0], p[1]]);
  const nu = us.length - 1;
  const nv = vs.length - 1;
  const inside: boolean[] = new Array(nu * nv);
  const covered: boolean[] = new Array(nu * nv).fill(false);
  let insideCount = 0;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const cu = (us[i] + us[i + 1]) / 2;
      const cv = (vs[j] + vs[j + 1]) / 2;
      const inn = pointInRing(cu, cv, snappedRing);
      inside[j * nu + i] = inn;
      if (inn) insideCount++;
    }
  }
  if (!insideCount) return { rectilinear, rects: [box], snapped };
  const rects: Rect[] = [];
  let uncovered = insideCount;
  let guard = 0;
  while (uncovered > 0 && guard++ < 40) {
    let best: { i0: number; i1: number; j0: number; j1: number; area: number } | null = null;
    for (let j0 = 0; j0 < nv; j0++) {
      for (let i0 = 0; i0 < nu; i0++) {
        if (!inside[j0 * nu + i0]) continue;
        // Grow i1 then j1; stop a column when it hits an outside cell.
        let maxI1 = nu;
        for (let j1 = j0 + 1; j1 <= nv; j1++) {
          let i1 = i0;
          while (i1 < maxI1 && inside[(j1 - 1) * nu + i1]) i1++;
          maxI1 = i1;
          if (i1 === i0) break;
          let hasUncovered = false;
          for (let j = j0; j < j1 && !hasUncovered; j++) for (let i = i0; i < i1; i++) if (!covered[j * nu + i]) { hasUncovered = true; break; }
          if (!hasUncovered) continue;
          const area = (us[i1] - us[i0]) * (vs[j1] - vs[j0]);
          if (!best || area > best.area) best = { i0, i1, j0, j1, area };
        }
      }
    }
    if (!best) break;
    for (let j = best.j0; j < best.j1; j++) for (let i = best.i0; i < best.i1; i++) if (!covered[j * nu + i]) { covered[j * nu + i] = true; uncovered--; }
    const hu = (us[best.i1] - us[best.i0]) / 2;
    const hv = (vs[best.j1] - vs[best.j0]) / 2;
    // A sliver narrower than a hallway does not get a roof of its own; the ceiling cap closes it.
    if (rects.length && Math.min(hu, hv) < 0.9) continue;
    rects.push({ cu: (us[best.i0] + us[best.i1]) / 2, cv: (vs[best.j0] + vs[best.j1]) / 2, hu, hv });
    if (rects.length >= maxRects) break;
  }
  if (!rects.length) rects.push(box);
  rects.sort((a, b) => b.hu * b.hv - a.hu * a.hv);
  return { rectilinear, rects, snapped };
}

/** Offset a clockwise ring outward by d metres (mitred). */
export function offsetRing(ring: number[][], d: number): number[][] {
  const n = ring.length;
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[(i - 1 + n) % n];
    const q = ring[i];
    const r = ring[(i + 1) % n];
    const l1 = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const l2 = Math.hypot(r[0] - q[0], r[1] - q[1]) || 1;
    const n1 = [-(q[1] - p[1]) / l1, (q[0] - p[0]) / l1];
    const n2 = [-(r[1] - q[1]) / l2, (r[0] - q[0]) / l2];
    let mx = n1[0] + n2[0];
    let mz = n1[1] + n2[1];
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml;
    mz /= ml;
    const k = d / Math.max(0.35, mx * n1[0] + mz * n1[1]);
    out.push([q[0] + mx * k, q[1] + mz * k]);
  }
  return out;
}

/** Edge description of a clockwise ring: outward normal, length, and the yaw that turns +z onto the normal. */
export interface Edge {
  i: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  len: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  yaw: number;
}

export function edgesOf(ring: number[][]): Edge[] {
  const out: Edge[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const tx = dx / len;
    const tz = dz / len;
    const nx = -tz;
    const nz = tx;
    out.push({ i, ax: a[0], az: a[1], bx: b[0], bz: b[1], len, tx, tz, nx, nz, yaw: Math.atan2(nx, nz) });
  }
  return out;
}
