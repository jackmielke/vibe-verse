/**
 * Vibe Kart — the centreline: spline, arc-length table, frames, projection.
 *
 * Three things have to be true for the rest of the track to work, and this file
 * is where each of them is made true:
 *
 * 1. **`t` is genuinely normalised distance.** The Catmull-Rom is sampled
 *    finely, its chord lengths accumulated, and the result *re-sampled* at a
 *    fixed metre spacing. Anything that uses the raw curve parameter drifts —
 *    a tight hairpin eats parameter far faster than a straight, and lap
 *    progress computed off it would jump.
 *
 * 2. **The frame never flips.** The Frenet frame is defined by the second
 *    derivative, so it spins 180° through every inflection point — put a road
 *    on it and the tarmac turns inside out halfway down a straight. Instead the
 *    up vector is *parallel-transported* along the curve (rotation-minimising
 *    frame), the holonomy that accumulates around the closed lap is measured
 *    and distributed away, and only then is the authored bank applied on top.
 *
 * 3. **`project` is O(1).** It is called around forty times a frame — eight
 *    karts × several probes, plus items, plus AI. A uniform XZ bucket grid over
 *    the station table turns it into a fixed handful of distance tests, and the
 *    `hint` short-circuits even that.
 */
import * as THREE from "three";
import type { TrackFrame } from "../types";
import { buildLayout, SEGMENTS, type LayoutResult } from "./layout";
import { clamp, wrap01 } from "./util";

/** Station spacing along the resampled centreline, metres. */
const STATION_DS = 1.0;

/** Bucket size for the projection grid, metres. */
const CELL = 16;

export interface ProjectResult {
  t: number;
  /** Arc length in metres. */
  s: number;
  lateral: number;
  /** World height of the road plane under the query point. */
  height: number;
  /** World height of the centreline itself, unaffected by banking. */
  centreY: number;
  /** Signed distance along the road normal — negative means below the road. */
  above: number;
  /** Fractional station index, for callers that want to interpolate further. */
  index: number;
}

export interface TrackCurve {
  readonly layout: LayoutResult;
  readonly length: number;
  readonly count: number;
  readonly ds: number;
  /** Flat arrays, station-major. `pos[i*3+k]` etc. */
  readonly pos: Float32Array;
  readonly fwd: Float32Array;
  readonly rgt: Float32Array;
  readonly up: Float32Array;
  /** Horizontal right vector — the frame cameras and terrain reason in. */
  readonly flatRgt: Float32Array;
  readonly halfWidth: Float32Array;
  readonly bank: Float32Array;
  readonly curvature: Float32Array;
  readonly grade: Float32Array;
  readonly segOf: Int32Array;
  /** Arc position where each segment of the layout begins. */
  readonly segStart: Float64Array;

  /** Station index (fractional) for an arc position, wrapping. */
  indexAt(s: number): number;
  frameAt(t: number, out?: TrackFrame): TrackFrame;
  frameAtS(s: number, out?: TrackFrame): TrackFrame;
  /** Centreline point + basis without allocating: writes into the vectors. */
  sample(s: number, pos: THREE.Vector3, fwd: THREE.Vector3, rgt: THREE.Vector3, up: THREE.Vector3): void;
  project(p: THREE.Vector3, hint?: number): ProjectResult;
  /** Horizontal right vector at an arc position. */
  flatRightAt(s: number, out: THREE.Vector3): THREE.Vector3;
  segmentAt(s: number): number;
  /** Arc range of a named layout segment. */
  spanOf(id: string): { start: number; end: number };
}

export function makeTrackFrame(): TrackFrame {
  return {
    t: 0,
    position: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    halfWidth: 8,
    bank: 0,
    curvature: 0,
    grade: 0,
  };
}

export function buildCurve(): TrackCurve {
  const layout = buildLayout();
  const cps = layout.points;
  const P = cps.length;

  const curve = new THREE.CatmullRomCurve3(
    cps.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
    true,
    // Centripetal: uniform overshoots and cusps on the hairpin, chordal
    // flattens the easements. Centripetal is the only one that never self-
    // intersects between control points, which matters when the points are
    // 3.5 m apart round a 28 m radius.
    "centripetal",
    0.5,
  );

  // --- arc-length table over the curve parameter ---------------------------
  // Dense enough that chord length is within a millimetre of arc length even
  // in the hairpin, and it is thrown away as soon as the stations are placed.
  const FINE = Math.max(2048, P * 24);
  const fineS = new Float64Array(FINE + 1);
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  curve.getPoint(0, tmpA);
  for (let i = 1; i <= FINE; i++) {
    curve.getPoint(i / FINE, tmpB);
    fineS[i] = fineS[i - 1] + tmpA.distanceTo(tmpB);
    tmpA.copy(tmpB);
  }
  const total = fineS[FINE];
  const count = Math.max(64, Math.round(total / STATION_DS));
  const ds = total / count;

  /** Curve parameter at an arc position, by binary search + linear interp. */
  const uAt = (s: number): number => {
    const target = clamp(s, 0, total);
    let lo = 0;
    let hi = FINE;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (fineS[mid] <= target) lo = mid;
      else hi = mid;
    }
    const span = fineS[hi] - fineS[lo] || 1e-9;
    return (lo + (target - fineS[lo]) / span) / FINE;
  };

  // --- stations ------------------------------------------------------------
  const pos = new Float32Array(count * 3);
  const fwd = new Float32Array(count * 3);
  const rgt = new Float32Array(count * 3);
  const up = new Float32Array(count * 3);
  const flatRgt = new Float32Array(count * 3);
  const halfWidth = new Float32Array(count);
  const bank = new Float32Array(count);
  const curvature = new Float32Array(count);
  const grade = new Float32Array(count);
  const segOf = new Int32Array(count);
  const uOf = new Float64Array(count);

  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const u = uAt(i * ds);
    uOf[i] = u;
    curve.getPoint(u, v);
    pos[i * 3] = v.x;
    pos[i * 3 + 1] = v.y;
    pos[i * 3 + 2] = v.z;
    // Control-point scalars ride along at the same parameter. The points are
    // ~11 m apart and the authored profiles are already smooth, so linear here
    // is invisible and cheap.
    const cf = u * P;
    const c0 = Math.floor(cf) % P;
    const c1 = (c0 + 1) % P;
    const w = cf - Math.floor(cf);
    bank[i] = cps[c0].bank + (cps[c1].bank - cps[c0].bank) * w;
    halfWidth[i] = cps[c0].halfWidth + (cps[c1].halfWidth - cps[c0].halfWidth) * w;
  }

  // Central-difference tangents off the resampled points: consistent with the
  // geometry we actually build, and smoother than the curve's own derivative
  // near a control point.
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const p = (i - 1 + count) % count;
    const n = (i + 1) % count;
    a.set(pos[n * 3] - pos[p * 3], pos[n * 3 + 1] - pos[p * 3 + 1], pos[n * 3 + 2] - pos[p * 3 + 2]);
    a.normalize();
    fwd[i * 3] = a.x;
    fwd[i * 3 + 1] = a.y;
    fwd[i * 3 + 2] = a.z;
    grade[i] = a.y;
    // Horizontal right: forward flattened, then rotated a quarter turn.
    const hl = Math.hypot(a.x, a.z) || 1e-6;
    flatRgt[i * 3] = -a.z / hl;
    flatRgt[i * 3 + 1] = 0;
    flatRgt[i * 3 + 2] = a.x / hl;
  }

  // --- parallel transport --------------------------------------------------
  const tUp = new Float32Array(count * 3);
  const cur = new THREE.Vector3();
  const nextF = new THREE.Vector3();
  const prevF = new THREE.Vector3();
  const axis = new THREE.Vector3();
  // Seed with world up made perpendicular to the tangent.
  prevF.set(fwd[0], fwd[1], fwd[2]);
  cur.set(0, 1, 0).addScaledVector(prevF, -prevF.y).normalize();
  for (let i = 0; i < count; i++) {
    nextF.set(fwd[i * 3], fwd[i * 3 + 1], fwd[i * 3 + 2]);
    axis.crossVectors(prevF, nextF);
    const sin = axis.length();
    if (sin > 1e-9) {
      const ang = Math.atan2(sin, prevF.dot(nextF));
      cur.applyAxisAngle(axis.divideScalar(sin), ang);
    }
    // Re-orthogonalise every step; 2000 small rotations otherwise drift.
    cur.addScaledVector(nextF, -cur.dot(nextF)).normalize();
    tUp[i * 3] = cur.x;
    tUp[i * 3 + 1] = cur.y;
    tUp[i * 3 + 2] = cur.z;
    prevF.copy(nextF);
  }

  // Close the loop: transport once more onto station 0 and measure the residual
  // twist, then unwind it linearly around the lap so the seam is invisible.
  nextF.set(fwd[0], fwd[1], fwd[2]);
  axis.crossVectors(prevF, nextF);
  const sinEnd = axis.length();
  if (sinEnd > 1e-9) cur.applyAxisAngle(axis.divideScalar(sinEnd), Math.atan2(sinEnd, prevF.dot(nextF)));
  cur.addScaledVector(nextF, -cur.dot(nextF)).normalize();
  const up0 = new THREE.Vector3(tUp[0], tUp[1], tUp[2]);
  const rgt0 = new THREE.Vector3().crossVectors(nextF, up0);
  const holonomy = Math.atan2(cur.dot(rgt0), cur.dot(up0));

  const rot = new THREE.Vector3();
  const fi = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    fi.set(fwd[i * 3], fwd[i * 3 + 1], fwd[i * 3 + 2]);
    rot.set(tUp[i * 3], tUp[i * 3 + 1], tUp[i * 3 + 2]);
    const unwind = (-holonomy * i) / count;
    // One rotation about the tangent carries both the holonomy unwind and the
    // authored bank, so the frame stays exactly orthonormal.
    rot.applyAxisAngle(fi, unwind + bank[i]);
    rot.addScaledVector(fi, -rot.dot(fi)).normalize();
    up[i * 3] = rot.x;
    up[i * 3 + 1] = rot.y;
    up[i * 3 + 2] = rot.z;
    a.crossVectors(fi, rot).normalize();
    rgt[i * 3] = a.x;
    rgt[i * 3 + 1] = a.y;
    rgt[i * 3 + 2] = a.z;
  }

  // --- curvature -----------------------------------------------------------
  for (let i = 0; i < count; i++) {
    const p = (i - 1 + count) % count;
    const n = (i + 1) % count;
    a.set(fwd[n * 3] - fwd[p * 3], fwd[n * 3 + 1] - fwd[p * 3 + 1], fwd[n * 3 + 2] - fwd[p * 3 + 2]);
    a.divideScalar(2 * ds);
    // Against the *flat* right, so a banked corner reports the curvature of
    // the road rather than the tilt of the plate it is on.
    curvature[i] = a.x * flatRgt[i * 3] + a.z * flatRgt[i * 3 + 2];
  }

  // --- segment boundaries --------------------------------------------------
  // Control point `segStartIndex[g]` sits exactly at curve parameter g/P, so
  // inverting the arc table gives the segment's arc position to the millimetre.
  const segStart = new Float64Array(SEGMENTS.length + 1);
  const sAtU = (u: number): number => {
    const f = clamp(u, 0, 1) * FINE;
    const i0 = Math.min(FINE - 1, Math.floor(f));
    return fineS[i0] + (fineS[i0 + 1] - fineS[i0]) * (f - i0);
  };
  for (let g = 0; g < SEGMENTS.length; g++) segStart[g] = sAtU(layout.segStartIndex[g] / P);
  segStart[SEGMENTS.length] = total;
  for (let i = 0; i < count; i++) {
    const s = i * ds;
    let g = 0;
    while (g + 1 < SEGMENTS.length && segStart[g + 1] <= s) g++;
    segOf[i] = g;
  }

  // --- projection grid -----------------------------------------------------
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    minX = Math.min(minX, pos[i * 3]);
    maxX = Math.max(maxX, pos[i * 3]);
    minZ = Math.min(minZ, pos[i * 3 + 2]);
    maxZ = Math.max(maxZ, pos[i * 3 + 2]);
  }
  const gx0 = minX - CELL;
  const gz0 = minZ - CELL;
  const gw = Math.ceil((maxX - minX) / CELL) + 3;
  const gh = Math.ceil((maxZ - minZ) / CELL) + 3;
  const buckets: number[][] = new Array(gw * gh);
  for (let i = 0; i < count; i++) {
    const cx = clamp(Math.floor((pos[i * 3] - gx0) / CELL), 0, gw - 1);
    const cz = clamp(Math.floor((pos[i * 3 + 2] - gz0) / CELL), 0, gh - 1);
    const k = cz * gw + cx;
    (buckets[k] ??= []).push(i);
  }

  const dist2 = (px: number, py: number, pz: number, i: number): number => {
    const dx = px - pos[i * 3];
    const dy = py - pos[i * 3 + 1];
    const dz = pz - pos[i * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };

  const scratchP = new THREE.Vector3();
  const scratchF = new THREE.Vector3();
  const scratchR = new THREE.Vector3();
  const scratchU = new THREE.Vector3();

  const curveApi: TrackCurve = {
    layout,
    length: total,
    count,
    ds,
    pos,
    fwd,
    rgt,
    up,
    flatRgt,
    halfWidth,
    bank,
    curvature,
    grade,
    segOf,
    segStart,

    indexAt(s) {
      let x = s % total;
      if (x < 0) x += total;
      return x / ds;
    },

    frameAt(t, out) {
      return curveApi.frameAtS(wrap01(t) * total, out);
    },

    frameAtS(s, out) {
      const f = out ?? makeTrackFrame();
      curveApi.sample(s, f.position, f.forward, f.right, f.up);
      const idx = curveApi.indexAt(s);
      const i0 = Math.floor(idx) % count;
      const i1 = (i0 + 1) % count;
      const w = idx - Math.floor(idx);
      f.t = wrap01(s / total);
      f.halfWidth = halfWidth[i0] + (halfWidth[i1] - halfWidth[i0]) * w;
      f.bank = bank[i0] + (bank[i1] - bank[i0]) * w;
      f.curvature = curvature[i0] + (curvature[i1] - curvature[i0]) * w;
      f.grade = grade[i0] + (grade[i1] - grade[i0]) * w;
      return f;
    },

    sample(s, p, fo, r, u) {
      const idx = curveApi.indexAt(s);
      const i0 = Math.floor(idx) % count;
      const i1 = (i0 + 1) % count;
      const w = idx - Math.floor(idx);
      const iw = 1 - w;
      p.set(
        pos[i0 * 3] * iw + pos[i1 * 3] * w,
        pos[i0 * 3 + 1] * iw + pos[i1 * 3 + 1] * w,
        pos[i0 * 3 + 2] * iw + pos[i1 * 3 + 2] * w,
      );
      fo.set(
        fwd[i0 * 3] * iw + fwd[i1 * 3] * w,
        fwd[i0 * 3 + 1] * iw + fwd[i1 * 3 + 1] * w,
        fwd[i0 * 3 + 2] * iw + fwd[i1 * 3 + 2] * w,
      ).normalize();
      u.set(
        up[i0 * 3] * iw + up[i1 * 3] * w,
        up[i0 * 3 + 1] * iw + up[i1 * 3 + 1] * w,
        up[i0 * 3 + 2] * iw + up[i1 * 3 + 2] * w,
      );
      // Re-orthogonalise: two lerped unit vectors are neither unit nor square.
      u.addScaledVector(fo, -u.dot(fo)).normalize();
      r.crossVectors(fo, u).normalize();
    },

    flatRightAt(s, out) {
      const idx = curveApi.indexAt(s);
      const i0 = Math.floor(idx) % count;
      const i1 = (i0 + 1) % count;
      const w = idx - Math.floor(idx);
      out.set(
        flatRgt[i0 * 3] * (1 - w) + flatRgt[i1 * 3] * w,
        0,
        flatRgt[i0 * 3 + 2] * (1 - w) + flatRgt[i1 * 3 + 2] * w,
      );
      return out.normalize();
    },

    segmentAt(s) {
      let x = s % total;
      if (x < 0) x += total;
      let g = 0;
      while (g + 1 < SEGMENTS.length && segStart[g + 1] <= x) g++;
      return g;
    },

    spanOf(id) {
      const g = SEGMENTS.findIndex((seg) => seg.id === id);
      if (g < 0) return { start: 0, end: total };
      return { start: segStart[g], end: segStart[g + 1] };
    },

    project(p, hint) {
      const px = p.x;
      const py = p.y;
      const pz = p.z;
      let best = Infinity;
      let bi = 0;

      // 1. The hint. A kart moves at most 0.3 m per fixed step, so its own last
      //    projection is nearly always the answer — and it is what disambiguates
      //    two parts of the course that pass close together in plan.
      if (hint !== undefined && Number.isFinite(hint)) {
        const centre = Math.round(wrap01(hint) * count);
        for (let k = -40; k <= 40; k++) {
          const i = (centre + k + count * 2) % count;
          const d = dist2(px, py, pz, i);
          if (d < best) {
            best = d;
            bi = i;
          }
        }
      }

      // 2. The bucket grid, unless the hint already landed us on the road.
      if (best > 400) {
        const cx = clamp(Math.floor((px - gx0) / CELL), 0, gw - 1);
        const cz = clamp(Math.floor((pz - gz0) / CELL), 0, gh - 1);
        for (let oz = -1; oz <= 1; oz++) {
          const z = cz + oz;
          if (z < 0 || z >= gh) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const x = cx + ox;
            if (x < 0 || x >= gw) continue;
            const list = buckets[z * gw + x];
            if (!list) continue;
            for (let n = 0; n < list.length; n++) {
              const d = dist2(px, py, pz, list[n]);
              if (d < best) {
                best = d;
                bi = list[n];
              }
            }
          }
        }
      }

      // 3. Nothing anywhere near — a kart blasted off the map. Coarse sweep.
      if (best === Infinity || best > 40000) {
        for (let i = 0; i < count; i += 8) {
          const d = dist2(px, py, pz, i);
          if (d < best) {
            best = d;
            bi = i;
          }
        }
        for (let k = -8; k <= 8; k++) {
          const i = (bi + k + count) % count;
          const d = dist2(px, py, pz, i);
          if (d < best) {
            best = d;
            bi = i;
          }
        }
      }

      // Refine to sub-station accuracy by projecting onto the two neighbouring
      // chords; at 1 m spacing this lands within a millimetre.
      const prev = (bi - 1 + count) % count;
      const next = (bi + 1) % count;
      let frac = 0;
      const proj = (from: number, to: number): number => {
        const ax = pos[from * 3];
        const ay = pos[from * 3 + 1];
        const az = pos[from * 3 + 2];
        const vx = pos[to * 3] - ax;
        const vy = pos[to * 3 + 1] - ay;
        const vz = pos[to * 3 + 2] - az;
        const len2 = vx * vx + vy * vy + vz * vz || 1e-9;
        return clamp(((px - ax) * vx + (py - ay) * vy + (pz - az) * vz) / len2, 0, 1);
      };
      const fPrev = proj(prev, bi);
      const fNext = proj(bi, next);
      const dPrev = segDist2(pos, prev, bi, fPrev, px, py, pz);
      const dNext = segDist2(pos, bi, next, fNext, px, py, pz);
      let baseIndex = bi;
      if (dPrev < dNext) {
        baseIndex = prev;
        frac = fPrev;
      } else {
        frac = fNext;
      }

      const s = ((baseIndex + frac) * ds) % total;
      curveApi.sample(s, scratchP, scratchF, scratchR, scratchU);
      const dx = px - scratchP.x;
      const dy = py - scratchP.y;
      const dz = pz - scratchP.z;
      const lateral = dx * scratchR.x + dy * scratchR.y + dz * scratchR.z;
      const above = dx * scratchU.x + dy * scratchU.y + dz * scratchU.z;
      return {
        t: wrap01(s / total),
        s,
        lateral,
        height: scratchP.y + scratchR.y * lateral,
        centreY: scratchP.y,
        above,
        index: baseIndex + frac,
      };
    },
  };

  return curveApi;
}

function segDist2(
  pos: Float32Array,
  from: number,
  to: number,
  f: number,
  px: number,
  py: number,
  pz: number,
): number {
  const x = pos[from * 3] + (pos[to * 3] - pos[from * 3]) * f;
  const y = pos[from * 3 + 1] + (pos[to * 3 + 1] - pos[from * 3 + 1]) * f;
  const z = pos[from * 3 + 2] + (pos[to * 3 + 2] - pos[from * 3 + 2]) * f;
  const dx = px - x;
  const dy = py - y;
  const dz = pz - z;
  return dx * dx + dy * dy + dz * dz;
}
