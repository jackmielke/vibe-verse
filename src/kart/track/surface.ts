/**
 * Vibe Kart — the analytic course: cross-section, surface query, walls.
 *
 * The road is not a collision mesh. It is a function: given an arc position and
 * a lateral offset, `profile()` returns the height of the tarmac above the
 * centreline plane and its slope across. Everything else in the module — the
 * ribbon geometry, the kerbs, the quarter-pipe in the Quarry Bowl, the physics
 * probe under every wheel — reads that one function, so what the karts drive on
 * and what the renderer draws are the same surface by construction rather than
 * by diligence.
 *
 * `surfaceAt` is the workhorse: four wheel probes × eight karts × 120 Hz is
 * ~4000 calls a second, and it must not allocate. Everything below writes into
 * caller-supplied output objects and module-scoped scratch vectors.
 *
 * NOTE ON `SurfaceSample.height`: it is returned as
 * `point.y − (signed distance from the point to the surface along its normal)`.
 * On flat road that is exactly the road's world height, which is what a
 * suspension raycast expects. On the banked bowl and the vertical anti-gravity
 * plating it stays *useful* — `point.y − height` is the true clearance along
 * the surface normal instead of a meaningless vertical drop through a wall.
 */
import * as THREE from "three";
import type { SurfaceKind, SurfaceSample, WallHit } from "../types";
import { SEGMENTS, SHORTCUT, BOOST_PADS, apronSurface, placementS, type EdgeKind } from "./layout";
import type { TrackCurve } from "./spline";
import { SEA_LEVEL, type GroundField } from "./ground";
import { clamp, clamp01, lerp, smoothstep } from "./util";

/** Painted kerb width and how proud of the tarmac it sits. */
export const KERB_WIDTH = 1.35;
export const KERB_RISE = 0.06;
/** Drivable off-road band flanking the ribbon. */
export const APRON_WIDTH = 10;
/** How far the graded apron has fallen by its outer edge. */
export const APRON_DROP = 2.4;
/** Wall faces sit this far outside the drivable edge. */
export const WALL_OFFSET = 0.55;

export const WALL_HEIGHT: Record<EdgeKind, number> = {
  none: 0,
  rail: 1.05,
  barrier: 1.45,
  tube: 0.85,
  post: 0.95,
};

/** Anything below this much under the centreline is a fall, not a surface. */
const FALL_DEPTH = 11;

export interface BoostZone {
  s0: number;
  s1: number;
  lat0: number;
  lat1: number;
}

/** Interpolated cross-section parameters at one arc position. */
export interface Cross {
  s: number;
  halfWidth: number;
  /** Drivable half-width including any quarter-pipe lip, per side. */
  driveL: number;
  driveR: number;
  lipWL: number;
  lipHL: number;
  lipWR: number;
  lipHR: number;
  kerbL: number;
  kerbR: number;
  crown: number;
  seg: number;
}

export interface ShortcutPath {
  /** Sampled centreline of the dirt cut. */
  pos: Float32Array;
  fwd: Float32Array;
  rgt: Float32Array;
  count: number;
  length: number;
  halfWidth: number;
  /** Arc window on the main line where the cut is even worth testing. */
  sEnter: number;
  sExit: number;
  min: THREE.Vector3;
  max: THREE.Vector3;
}

export interface TrackSurface {
  readonly boostZones: BoostZone[];
  readonly shortcut: ShortcutPath;
  crossAt(s: number, out: Cross): Cross;
  /** Height of the ribbon above the centreline plane, and its lateral slope. */
  profile(c: Cross, lat: number): number;
  profileSlope(c: Cross, lat: number): number;
  /** Surface kind on the ribbon at (s, lat). */
  ribbonKind(c: Cross, lat: number): SurfaceKind;
  surfaceAt(p: THREE.Vector3, hint: number | undefined, out: SurfaceSample): SurfaceSample;
  wallAt(p: THREE.Vector3, radius: number, hint?: number): WallHit | null;
  /** Signed lateral of the wall face on each side; ±Infinity where open. */
  wallLateral(s: number, side: 0 | 1): number;
  wallKind(s: number, side: 0 | 1): EdgeKind;
}

export function makeSurfaceSample(): SurfaceSample {
  return {
    height: 0,
    normal: new THREE.Vector3(0, 1, 0),
    kind: "road",
    onTrack: false,
    lateral: 0,
    t: 0,
  };
}

export function makeCross(): Cross {
  return {
    s: 0,
    halfWidth: 8,
    driveL: 8,
    driveR: 8,
    lipWL: 0,
    lipHL: 0,
    lipWR: 0,
    lipHR: 0,
    kerbL: 0,
    kerbR: 0,
    crown: 0,
    seg: 0,
  };
}

export function buildSurface(curve: TrackCurve, ground: GroundField): TrackSurface {
  const count = curve.count;
  const total = curve.length;

  // --- per-station cross-section parameters --------------------------------
  const lipW = new Float32Array(count * 2);
  const lipH = new Float32Array(count * 2);
  const kerb = new Float32Array(count * 2);
  const crown = new Float32Array(count);
  const wallLat = new Float32Array(count * 2);
  const wallKindArr = new Uint8Array(count * 2);
  const EDGE_ORDER: EdgeKind[] = ["none", "rail", "barrier", "tube", "post"];

  for (let i = 0; i < count; i++) {
    const g = SEGMENTS[curve.segOf[i]];
    const L = g.lip?.left;
    const Rp = g.lip?.right;
    lipW[i * 2] = L ? L[0] : 0;
    lipH[i * 2] = L ? L[1] : 0;
    lipW[i * 2 + 1] = Rp ? Rp[0] : 0;
    lipH[i * 2 + 1] = Rp ? Rp[1] : 0;
    kerb[i * 2] = g.kerb[0] && g.road === "road" ? 1 : 0;
    kerb[i * 2 + 1] = g.kerb[1] && g.road === "road" ? 1 : 0;
    // Crown fades out as the road banks: a cambered surface on top of 40° of
    // banking is a bump, not a drainage detail.
    crown[i] = 0.11 * (1 - smoothstep(0.06, 0.4, Math.abs(curve.bank[i])));
    wallKindArr[i * 2] = EDGE_ORDER.indexOf(g.edge[0]);
    wallKindArr[i * 2 + 1] = EDGE_ORDER.indexOf(g.edge[1]);
  }

  // Blur the lip and kerb masks along the lap so features grow out of the road
  // over a car length or two instead of appearing between one frame and the next.
  blurAlong(lipW, count, 2, Math.round(14 / curve.ds));
  blurAlong(lipH, count, 2, Math.round(14 / curve.ds));
  blurAlong(kerb, count, 2, Math.round(5 / curve.ds));

  for (let i = 0; i < count; i++) {
    const hw = curve.halfWidth[i];
    for (let side = 0; side < 2; side++) {
      const k = wallKindArr[i * 2 + side];
      wallLat[i * 2 + side] = hw + lipW[i * 2 + side] + WALL_OFFSET;
      if (k === 0) wallLat[i * 2 + side] = Infinity;
    }
  }

  // --- boost panels --------------------------------------------------------
  const boostZones: BoostZone[] = [];
  for (const pad of BOOST_PADS) {
    if (pad.seg === "shortcut") continue;
    const s = placementS(pad);
    for (const lane of pad.lanes) {
      boostZones.push({ s0: s - 3, s1: s + 3, lat0: lane - 1.7, lat1: lane + 1.7 });
    }
  }

  // --- the hairpin cut -----------------------------------------------------
  const shortcut = buildShortcut(curve);

  // --- scratch -------------------------------------------------------------
  const UP = new THREE.Vector3(0, 1, 0);
  const cPos = new THREE.Vector3();
  const cFwd = new THREE.Vector3();
  const cRgt = new THREE.Vector3();
  const cUp = new THREE.Vector3();
  const sPoint = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const scratchCross = makeCross();

  function crossAt(s: number, out: Cross): Cross {
    const idx = curve.indexAt(s);
    const i0 = Math.floor(idx) % count;
    const i1 = (i0 + 1) % count;
    const w = idx - Math.floor(idx);
    const iw = 1 - w;
    out.s = s;
    out.halfWidth = curve.halfWidth[i0] * iw + curve.halfWidth[i1] * w;
    out.lipWL = lipW[i0 * 2] * iw + lipW[i1 * 2] * w;
    out.lipHL = lipH[i0 * 2] * iw + lipH[i1 * 2] * w;
    out.lipWR = lipW[i0 * 2 + 1] * iw + lipW[i1 * 2 + 1] * w;
    out.lipHR = lipH[i0 * 2 + 1] * iw + lipH[i1 * 2 + 1] * w;
    out.kerbL = kerb[i0 * 2] * iw + kerb[i1 * 2] * w;
    out.kerbR = kerb[i0 * 2 + 1] * iw + kerb[i1 * 2 + 1] * w;
    out.crown = crown[i0] * iw + crown[i1] * w;
    out.driveL = out.halfWidth + out.lipWL;
    out.driveR = out.halfWidth + out.lipWR;
    out.seg = curve.segOf[i0];
    return out;
  }

  /**
   * The cross-section. Camber, then the kerb step, then the quarter-pipe.
   *
   * The quarter-pipe is a true circular arc chosen to be tangent to the road at
   * its base — `R = (w² + h²) / 2h` — which is why the Quarry Bowl can be
   * driven straight up rather than clouted.
   */
  function profile(c: Cross, lat: number): number {
    const a = Math.abs(lat);
    const hw = c.halfWidth;
    let h = 0;
    if (hw > 0.01) {
      const n = clamp(a / hw, 0, 1);
      h += c.crown * (1 - n * n);
    }
    const kerbAmt = lat >= 0 ? c.kerbR : c.kerbL;
    if (kerbAmt > 0 && a > hw - KERB_WIDTH) {
      h += KERB_RISE * kerbAmt * smoothstep(hw - KERB_WIDTH, hw - KERB_WIDTH + 0.4, a);
    }
    const lw = lat >= 0 ? c.lipWR : c.lipWL;
    const lh = lat >= 0 ? c.lipHR : c.lipHL;
    if (lw > 0.05 && lh > 0.01 && a > hw) {
      const d = Math.min(a - hw, lw);
      const R = (lw * lw + lh * lh) / (2 * lh);
      h += R - Math.sqrt(Math.max(0, R * R - d * d));
    }
    return h;
  }

  function profileSlope(c: Cross, lat: number): number {
    const a = Math.abs(lat);
    const sign = lat >= 0 ? 1 : -1;
    const hw = c.halfWidth;
    let d = 0;
    if (hw > 0.01) {
      const n = clamp(a / hw, 0, 1);
      d += c.crown * (-2 * n) * (1 / hw);
    }
    const kerbAmt = lat >= 0 ? c.kerbR : c.kerbL;
    if (kerbAmt > 0 && a > hw - KERB_WIDTH && a < hw - KERB_WIDTH + 0.4) {
      const t = (a - (hw - KERB_WIDTH)) / 0.4;
      d += (KERB_RISE * kerbAmt * 6 * t * (1 - t)) / 0.4;
    }
    const lw = lat >= 0 ? c.lipWR : c.lipWL;
    const lh = lat >= 0 ? c.lipHR : c.lipHL;
    if (lw > 0.05 && lh > 0.01 && a > hw) {
      const dd = Math.min(a - hw, lw);
      const R = (lw * lw + lh * lh) / (2 * lh);
      const root = Math.sqrt(Math.max(1e-4, R * R - dd * dd));
      d += dd / root;
    }
    return d * sign;
  }

  function inBoost(s: number, lat: number): boolean {
    for (let i = 0; i < boostZones.length; i++) {
      const z = boostZones[i];
      if (lat < z.lat0 || lat > z.lat1) continue;
      // Wrapped containment: measure forward from the panel's leading edge.
      let d = s - z.s0;
      if (d < 0) d += total;
      if (d <= z.s1 - z.s0) return true;
    }
    return false;
  }

  function ribbonKind(c: Cross, lat: number): SurfaceKind {
    const g = SEGMENTS[c.seg];
    if (g.road === "gap") return "void";
    if (g.road === "antigrav") return "antigrav";
    if (g.road === "wood") return "wood";
    if (g.road === "metal") return "metal";
    if (inBoost(c.s, lat)) return "boost";
    const a = Math.abs(lat);
    const kerbAmt = lat >= 0 ? c.kerbR : c.kerbL;
    if (kerbAmt > 0.5 && a > c.halfWidth - KERB_WIDTH) return "rumble";
    return "road";
  }

  /** The shoulder beside a section — matches the apron geometry exactly. */
  function apronKind(seg: number): SurfaceKind {
    return apronSurface(SEGMENTS[seg].id);
  }

  /** Open country: sand near the waterline, otherwise the local shoulder mix. */
  function wildKind(seg: number, height: number): SurfaceKind {
    if (height < SEA_LEVEL + 2.2) return "sand";
    return apronKind(seg);
  }

  // --- shortcut projection -------------------------------------------------
  const scP = new THREE.Vector3();

  function projectShortcut(p: THREE.Vector3): {
    hit: boolean;
    lat: number;
    y: number;
    u: number;
    nx: number;
    ny: number;
    nz: number;
  } {
    let best = Infinity;
    let bi = 0;
    let bf = 0;
    const n = shortcut.count;
    for (let i = 0; i < n - 1; i++) {
      const ax = shortcut.pos[i * 3];
      const ay = shortcut.pos[i * 3 + 1];
      const az = shortcut.pos[i * 3 + 2];
      const vx = shortcut.pos[(i + 1) * 3] - ax;
      const vy = shortcut.pos[(i + 1) * 3 + 1] - ay;
      const vz = shortcut.pos[(i + 1) * 3 + 2] - az;
      const len2 = vx * vx + vy * vy + vz * vz || 1e-9;
      const f = clamp01(((p.x - ax) * vx + (p.y - ay) * vy + (p.z - az) * vz) / len2);
      const dx = p.x - (ax + vx * f);
      const dy = p.y - (ay + vy * f);
      const dz = p.z - (az + vz * f);
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) {
        best = d;
        bi = i;
        bf = f;
      }
    }
    const i1 = Math.min(bi + 1, n - 1);
    scP.set(
      lerp(shortcut.pos[bi * 3], shortcut.pos[i1 * 3], bf),
      lerp(shortcut.pos[bi * 3 + 1], shortcut.pos[i1 * 3 + 1], bf),
      lerp(shortcut.pos[bi * 3 + 2], shortcut.pos[i1 * 3 + 2], bf),
    );
    const rx = lerp(shortcut.rgt[bi * 3], shortcut.rgt[i1 * 3], bf);
    const rz = lerp(shortcut.rgt[bi * 3 + 2], shortcut.rgt[i1 * 3 + 2], bf);
    const lat = (p.x - scP.x) * rx + (p.z - scP.z) * rz;
    // The cut has no bank, so its normal is world up pitched back by the grade:
    // n = right × forward, which for a horizontal right is unit already.
    const fx = lerp(shortcut.fwd[bi * 3], shortcut.fwd[i1 * 3], bf);
    const fy = lerp(shortcut.fwd[bi * 3 + 1], shortcut.fwd[i1 * 3 + 1], bf);
    const fz = lerp(shortcut.fwd[bi * 3 + 2], shortcut.fwd[i1 * 3 + 2], bf);
    const fxz = Math.hypot(fx, fz) || 1e-6;
    return {
      hit: Math.abs(lat) <= shortcut.halfWidth,
      lat,
      y: scP.y,
      u: (bi + bf) / (n - 1),
      nx: (-fx * fy) / fxz,
      ny: fxz,
      nz: (-fz * fy) / fxz,
    };
  }

  // --- the query -----------------------------------------------------------
  function surfaceAt(p: THREE.Vector3, hint: number | undefined, out: SurfaceSample): SurfaceSample {
    const pr = curve.project(p, hint);
    const c = crossAt(pr.s, scratchCross);
    const g = SEGMENTS[c.seg];
    const lat = pr.lateral;
    const a = Math.abs(lat);
    const drive = lat >= 0 ? c.driveR : c.driveL;
    out.t = pr.t;
    out.lateral = lat;

    if (g.road !== "gap" && a <= drive) {
      curve.sample(pr.s, cPos, cFwd, cRgt, cUp);
      const h = profile(c, lat);
      const slope = profileSlope(c, lat);
      sPoint.copy(cPos).addScaledVector(cRgt, lat).addScaledVector(cUp, h);
      tmp.copy(cUp).addScaledVector(cRgt, -slope).normalize();
      out.normal.copy(tmp);
      out.kind = ribbonKind(c, lat);
      out.onTrack = true;
      out.height = p.y - (p.x - sPoint.x) * tmp.x - (p.y - sPoint.y) * tmp.y - (p.z - sPoint.z) * tmp.z;
      return out;
    }

    // The dirt cut across the inside of Lantern Hairpin.
    if (!shortcut.sEnterFar(pr.s) && p.x >= shortcut.min.x && p.x <= shortcut.max.x && p.z >= shortcut.min.z && p.z <= shortcut.max.z) {
      const sc = projectShortcut(p);
      if (sc.hit) {
        out.normal.set(sc.nx, sc.ny, sc.nz);
        // A strip of panels near the exit: the cut is only worth taking if you
        // get off it cleanly, and this is what pays for that.
        out.kind = sc.u >= SHORTCUT.boost[0] && sc.u <= SHORTCUT.boost[1] ? "boost" : "dirt";
        out.onTrack = true;
        out.height = sc.y;
        return out;
      }
    }

    // Graded shoulder: still drivable, and slow.
    const open = g.elevated || g.road === "antigrav" || g.road === "gap";
    if (!open && a <= drive + APRON_WIDTH) {
      curve.sample(pr.s, cPos, cFwd, cRgt, cUp);
      const edgeH = profile(c, lat >= 0 ? drive : -drive);
      sPoint.copy(cPos).addScaledVector(cRgt, lat >= 0 ? drive : -drive).addScaledVector(cUp, edgeH);
      const d = a - drive;
      const drop = 0.3 + (APRON_DROP - 0.3) * smoothstep(0, APRON_WIDTH, d);
      const y = sPoint.y - drop;
      // Blend the shoulder normal from the road's own tilt to level ground, so
      // there is no crease where the tarmac ends.
      const k = smoothstep(0, APRON_WIDTH * 0.7, d);
      tmp.copy(cUp).lerp(UP, k).normalize();
      tmp.addScaledVector(cRgt, -0.16 * Math.sign(lat) * (1 - k)).normalize();
      out.normal.copy(tmp);
      out.kind = apronKind(c.seg);
      out.onTrack = true;
      out.height = y;
      return out;
    }

    // Open country — or a very long way down.
    const gh = ground.height(p.x, p.z);
    ground.normal(p.x, p.z, out.normal);
    out.onTrack = false;
    const centreY = pr.centreY;
    if (gh < SEA_LEVEL - 1.2) {
      out.kind = "void";
      out.height = SEA_LEVEL;
      out.normal.set(0, 1, 0);
      return out;
    }
    if (centreY - gh > FALL_DEPTH) {
      out.kind = "void";
      out.height = gh;
      return out;
    }
    out.kind = gh < SEA_LEVEL + 0.35 ? "water" : wildKind(c.seg, gh);
    out.height = out.kind === "water" ? SEA_LEVEL : gh;
    if (out.kind === "water") out.normal.set(0, 1, 0);
    return out;
  }

  // --- walls ---------------------------------------------------------------
  function wallLateral(s: number, side: 0 | 1): number {
    const idx = curve.indexAt(s);
    const i0 = Math.floor(idx) % count;
    const i1 = (i0 + 1) % count;
    const a = wallLat[i0 * 2 + side];
    const b = wallLat[i1 * 2 + side];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return Math.min(a, b);
    const w = idx - Math.floor(idx);
    return a + (b - a) * w;
  }

  function wallKind(s: number, side: 0 | 1): EdgeKind {
    const i0 = Math.floor(curve.indexAt(s)) % count;
    return EDGE_ORDER[wallKindArr[i0 * 2 + side]] ?? "none";
  }

  function wallAt(p: THREE.Vector3, radius: number, hint?: number): WallHit | null {
    const pr = curve.project(p, hint);
    const side: 0 | 1 = pr.lateral >= 0 ? 1 : 0;
    const face = wallLateral(pr.s, side);
    if (!Number.isFinite(face)) return null;
    const a = Math.abs(pr.lateral);
    const depth = a + radius - face;
    if (depth <= 0) return null;
    const kind = wallKind(pr.s, side);
    if (kind === "none") return null;
    // Cleared it in the air? Then there is nothing to hit.
    const top = WALL_HEIGHT[kind];
    if (pr.above > top + radius * 0.6 || pr.above < -3) return null;

    curve.sample(pr.s, cPos, cFwd, cRgt, cUp);
    const sign = side === 1 ? 1 : -1;
    // Allocating only on an actual contact: hits are rare, and handing the same
    // mutable object to two callers in one step would be a nasty little bug.
    return {
      point: cPos
        .clone()
        .addScaledVector(cRgt, face * sign)
        .addScaledVector(cUp, clamp(pr.above, 0, top)),
      normal: cRgt.clone().multiplyScalar(-sign),
      depth,
      // Bridge posts and the anti-gravity tube rails give; concrete does not.
      solid: kind === "barrier" || kind === "rail",
    };
  }

  return {
    boostZones,
    shortcut,
    crossAt,
    profile,
    profileSlope,
    ribbonKind,
    surfaceAt,
    wallAt,
    wallLateral,
    wallKind,
  };
}

// ---------------------------------------------------------------------------
// The hairpin cut
// ---------------------------------------------------------------------------

interface ShortcutPathInternal extends ShortcutPath {
  sEnterFar(s: number): boolean;
}

/**
 * A quadratic through three points: leave the road before turn-in, cross the
 * scrub inside the loop over a blind crest, rejoin on the exit. It is a
 * separate little ribbon with its own frames rather than a lateral offset on
 * the main line, because it genuinely leaves the road.
 */
function buildShortcut(curve: TrackCurve): ShortcutPathInternal {
  const p = new THREE.Vector3();
  const f = new THREE.Vector3();
  const r = new THREE.Vector3();
  const u = new THREE.Vector3();

  const at = (seg: string, frac: number, lateral: number, extra = 0) => {
    const span = curve.spanOf(seg);
    const s = span.start + (span.end - span.start) * frac;
    curve.sample(s, p, f, r, u);
    return { v: new THREE.Vector3().copy(p).addScaledVector(r, lateral + extra), s };
  };

  const entry = at(SHORTCUT.entry.seg, SHORTCUT.entry.f, SHORTCUT.entry.lateral);
  const exit = at(SHORTCUT.exit.seg, SHORTCUT.exit.f, SHORTCUT.exit.lateral);
  const apexSpan = curve.spanOf(SHORTCUT.apex.seg);
  const apexS = apexSpan.start + (apexSpan.end - apexSpan.start) * SHORTCUT.apex.f;
  curve.sample(apexS, p, f, r, u);
  const apexHalf = curve.halfWidth[Math.floor(curve.indexAt(apexS)) % curve.count];
  const apex = new THREE.Vector3().copy(p).addScaledVector(r, apexHalf + SHORTCUT.apex.inset);

  // Bezier control point that makes the curve pass through `apex` at t = 0.5.
  const ctrl = new THREE.Vector3()
    .copy(apex)
    .multiplyScalar(2)
    .addScaledVector(entry.v, -0.5)
    .addScaledVector(exit.v, -0.5);

  const N = 34;
  const pos = new Float32Array(N * 3);
  const fwd = new Float32Array(N * 3);
  const rgt = new Float32Array(N * 3);
  const tmp = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const it = 1 - t;
    tmp
      .copy(entry.v)
      .multiplyScalar(it * it)
      .addScaledVector(ctrl, 2 * it * t)
      .addScaledVector(exit.v, t * t);
    // A crest in the middle: you cannot see the landing until you are on it.
    tmp.y += SHORTCUT.crest * Math.sin(Math.PI * t) - 0.55 * Math.sin(Math.PI * t) ** 4;
    pos[i * 3] = tmp.x;
    pos[i * 3 + 1] = tmp.y;
    pos[i * 3 + 2] = tmp.z;
  }
  let length = 0;
  for (let i = 0; i < N; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(N - 1, i + 1);
    const dx = pos[b * 3] - pos[a * 3];
    const dy = pos[b * 3 + 1] - pos[a * 3 + 1];
    const dz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const inv = 1 / (Math.hypot(dx, dy, dz) || 1e-6);
    fwd[i * 3] = dx * inv;
    fwd[i * 3 + 1] = dy * inv;
    fwd[i * 3 + 2] = dz * inv;
    const hl = Math.hypot(dx, dz) || 1e-6;
    rgt[i * 3] = -dz / hl;
    rgt[i * 3 + 2] = dx / hl;
    if (i > 0) {
      length += Math.hypot(
        pos[i * 3] - pos[(i - 1) * 3],
        pos[i * 3 + 1] - pos[(i - 1) * 3 + 1],
        pos[i * 3 + 2] - pos[(i - 1) * 3 + 2],
      );
    }
  }

  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < N; i++) {
    min.x = Math.min(min.x, pos[i * 3]);
    min.y = Math.min(min.y, pos[i * 3 + 1]);
    min.z = Math.min(min.z, pos[i * 3 + 2]);
    max.x = Math.max(max.x, pos[i * 3]);
    max.y = Math.max(max.y, pos[i * 3 + 1]);
    max.z = Math.max(max.z, pos[i * 3 + 2]);
  }
  const pad = SHORTCUT.halfWidth + 4;
  min.x -= pad;
  min.z -= pad;
  min.y -= 6;
  max.x += pad;
  max.z += pad;
  max.y += 6;

  const sEnter = entry.s;
  const sExit = exit.s;
  const total = curve.length;
  return {
    pos,
    fwd,
    rgt,
    count: N,
    length,
    halfWidth: SHORTCUT.halfWidth,
    sEnter,
    sExit,
    min,
    max,
    /** True when the query is nowhere near the hairpin and can skip the test. */
    sEnterFar(s: number): boolean {
      let d = s - sEnter;
      if (d < 0) d += total;
      const window = (sExit - sEnter + total) % total;
      return d > window + 60;
    },
  };
}

/** In-place blur of an interleaved per-station array, wrapping around the lap. */
function blurAlong(arr: Float32Array, count: number, stride: number, radius: number): void {
  const r = Math.max(1, radius);
  const src = arr.slice();
  for (let c = 0; c < stride; c++) {
    for (let i = 0; i < count; i++) {
      let acc = 0;
      let w = 0;
      for (let k = -r; k <= r; k++) {
        const weight = 1 - Math.abs(k) / (r + 1);
        const j = ((((i + k) % count) + count) % count) * stride + c;
        acc += src[j] * weight;
        w += weight;
      }
      arr[i * stride + c] = acc / w;
    }
  }
}
