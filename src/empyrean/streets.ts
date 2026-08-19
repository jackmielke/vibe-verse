/**
 * THE GROUND — everything in The Empyrean a person walks or drives on.
 *
 * The deck slab, the eight avenues, the three ring roads, the eight lanes, the
 * rim road, the pavements each side of all of them, their kerbs, gutters and
 * crossings, the Halo at the middle, the parapet round the edge, the stairs
 * down to the promenade rings and the promenades themselves.
 *
 * ## Everything here is read out of the plan
 *
 * Not one radius, angle or width in this file is invented. `cityplan.ts` says
 * where the streets are and `surfaceAt` says what is under any point; this
 * module's whole job is to turn that answer into triangles. Where a query is
 * duplicated — `roadTop`, the crossing zones — it is written from the same
 * exported constants, so a change to `W.avenue.half` moves the road, the kerb,
 * the centre line and the zebra together or moves none of them.
 *
 * ## Why it is one draw call
 *
 * A street system is thousands of small flat pieces, which is the exact shape
 * of problem that kills a frame budget one `Mesh` at a time. So there are no
 * small pieces: every quad in here — deck, kerb, parapet, stair tread, tram
 * rail — is appended to one interleaved vertex buffer and drawn with one
 * `ShaderMaterial`. Variation that would otherwise be a second material is a
 * per-vertex `aKind` byte instead, and *all* the surface detail — paving
 * joints, district palettes, road markings, zebras, gully gratings, the tram
 * line, the painted circles on the Launch Terrace — is computed in the
 * fragment shader from world XZ. There are no textures in this world and there
 * is no image budget to spend, which turns out to be a gift: a procedural
 * paving pattern in polar coordinates costs nothing, never repeats, and lands
 * exactly on the streets because it is built from the same radii they are.
 *
 * ## The near ground is the whole job
 *
 * From a body standing on the pavement at 1.8 m you can see maybe forty metres
 * of ground and it is most of the frame. So the kerb is 0.21 m of real
 * geometry with a real vertical face, the roadway is crowned and falls into a
 * gutter at each side, the paving is laid in courses that change at every
 * district boundary, and the low sun rakes all of it. The far ground gets a
 * distance fade and nothing else — detail past a hundred metres is aliasing
 * with extra steps.
 *
 * ## What this system is not
 *
 * Not reflected. The lake shows the island's silhouette, and a kerb is not a
 * silhouette; it is detail, and detail in the mirror is a second draw of forty
 * thousand triangles that resolve to nothing at a kilometre and a half.
 */
import * as THREE from "three";
import type { BuildContext, FrameContext, QualityTier, System } from "./types";
import { DECKS, ISLAND_Y, PARAPET_H, PLATEAU_R } from "./config";
import {
  AVENUE_A0,
  AVENUE_N,
  DISTRICTS,
  HALO_R,
  KERB_H,
  LANE_A0,
  LANE_N,
  RIM_R,
  RING_R,
  W,
  cityPlan,
  districtAt,
  surfaceAt,
} from "./cityplan";
import { SUN_DIR } from "./sky";

const TAU = Math.PI * 2;

/* -------------------------------------------------------------------------
 * The armature, re-shaped for drawing
 *
 * Same numbers as the plan, arranged the way a mesher wants them rather than
 * the way a point query wants them.
 * ---------------------------------------------------------------------- */

interface RingRoad {
  r: number;
  half: number;
  walk: number;
  /** 1 = ordinary ring, 2 = the tram ring, 3 = the rim road. */
  kind: number;
}

interface RadialRoad {
  a0: number;
  n: number;
  half: number;
  walk: number;
  /** Radials do not exist inside this radius. */
  rMin: number;
}

const RINGS: RingRoad[] = [
  ...RING_R.map((r, i) => ({
    r,
    half: W.ring.half,
    walk: W.ring.walk,
    // Ring 2 (index 1) carries the tram, per the plan's Halo Station landmark.
    kind: i === 1 ? 2 : 1,
  })),
  { r: RIM_R, half: W.rim.half, walk: W.rim.walk, kind: 3 },
];

const RADIALS: RadialRoad[] = [
  { a0: AVENUE_A0, n: AVENUE_N, half: W.avenue.half, walk: W.avenue.walk, rMin: HALO_R },
  { a0: LANE_A0, n: LANE_N, half: W.lane.half, walk: W.lane.walk, rMin: RING_R[0] },
];

/* Road cross-section. A carriageway is not flat and a player standing on the
   pavement can see that it is not: it crowns at the centre line and falls into
   a shallow channel at each kerb, which is where the water goes and where the
   light pools when the sun is this low. */
/** Width of the drainage channel at each kerb, metres. */
const GUTTER_W = 0.5;
/** How far the crown stands above the kerb line. */
const CROWN = 0.085;
/** How far the bottom of the channel sits below the kerb line. */
const GUTTER_D = 0.05;
/** Total reveal of a kerb face: the sunk roadway plus the channel. */
const KERB_FACE = KERB_H + GUTTER_D;

/* Crossings. One set of numbers, used by the shader that paints the zebra and
   by the mesher that drops the kerb under it — they have to agree or you get a
   crossing that walks you into a 210 mm step. */
/** Clear of the junction before the crossing starts. */
const CROSS_IN = 1.2;
/** Depth of the crossing band, along the road. */
const CROSS_W = 3.6;

/** Thickness of the rim parapet — matches `surfaceAt`'s parapet band exactly. */
const PARAPET_T = 1.4;

/* -------------------------------------------------------------------------
 * Surface queries this module needs and the plan does not export
 * ---------------------------------------------------------------------- */

/** Shortest angular distance from `a` to the nearest multiple of `step`. */
function angleToNearest(a: number, step: number, offset: number): number {
  let d = (a - offset) % step;
  if (d < 0) d += step;
  return Math.min(d, step - d);
}

/** The road's cross-section, as a height relative to the kerb line. */
function roadProfile(t: number, half: number): number {
  const tg = 1 - Math.min(GUTTER_W / half, 0.6);
  if (t <= tg) {
    const u = t / tg;
    return CROWN * (1 - u * u);
  }
  return (-GUTTER_D * (t - tg)) / (1 - tg);
}

/**
 * Height of the carriageway at a point, or the deck if it is not carriageway.
 *
 * At a junction two roads overlap and the answer is the higher of the two
 * crowns — which is what a junction actually looks like, and which makes the
 * kerb wall shrink to nothing by itself as it runs into the corner.
 */
function roadTop(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const a = Math.atan2(z, x);
  let best = -Infinity;
  for (const ring of RINGS) {
    const d = Math.abs(r - ring.r);
    if (d <= ring.half + 1e-4) best = Math.max(best, roadProfile(Math.min(d / ring.half, 1), ring.half));
  }
  for (const rad of RADIALS) {
    if (r < rad.rMin) continue;
    const d = angleToNearest(a, TAU / rad.n, rad.a0) * r;
    if (d <= rad.half + 1e-4) best = Math.max(best, roadProfile(Math.min(d / rad.half, 1), rad.half));
  }
  if (best === -Infinity) return ISLAND_Y;
  return ISLAND_Y - KERB_H + best;
}

/** True inside a painted crossing. Mirrored exactly in the fragment shader. */
function inCrossing(x: number, z: number): boolean {
  const r = Math.hypot(x, z);
  const a = Math.atan2(z, x);
  for (const ring of RINGS) {
    if (Math.abs(r - ring.r) > ring.half + 0.75) continue;
    for (const rad of RADIALS) {
      if (r < rad.rMin) continue;
      const d = angleToNearest(a, TAU / rad.n, rad.a0) * r;
      if (d > rad.half + CROSS_IN && d < rad.half + CROSS_IN + CROSS_W) return true;
    }
  }
  for (const rad of RADIALS) {
    if (r < rad.rMin) continue;
    const d = angleToNearest(a, TAU / rad.n, rad.a0) * r;
    if (d > rad.half + 0.75) continue;
    for (const ring of RINGS) {
      const dr = Math.abs(r - ring.r);
      if (dr > ring.half + CROSS_IN && dr < ring.half + CROSS_IN + CROSS_W) return true;
    }
  }
  return false;
}

/* -------------------------------------------------------------------------
 * Vertex kinds
 *
 * One material, ten surfaces. The shader branches on this and nothing else.
 * ---------------------------------------------------------------------- */

const K_ROAD = 0;
const K_WALK = 1;
const K_PLAZA = 2;
const K_LOT = 3;
const K_KERB = 4;
const K_PROM = 5;
const K_WALL = 6;
const K_CAP = 7;
const K_TREAD = 8;
const K_RISER = 9;

/* -------------------------------------------------------------------------
 * The mesher
 * ---------------------------------------------------------------------- */

/**
 * One interleaved buffer for the entire street system.
 *
 * Deliberately not a pile of `BufferGeometry` objects handed to
 * `mergeGeometries`: merging builds every part twice — once as its own typed
 * arrays and again as the copy — and there are several thousand parts here.
 * Appending straight into plain arrays and typing them once at the end is the
 * same result for a fraction of the peak memory, and it is what merging would
 * have produced anyway.
 */
class Mesher {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly kin: number[] = [];
  readonly hgt: number[] = [];
  readonly idx: number[] = [];
  private v = 0;

  /** A planar quad, wound p0→p1→p2→p3. `h` is the per-vertex 0..1 local axis. */
  quad(
    p0: readonly number[],
    p1: readonly number[],
    p2: readonly number[],
    p3: readonly number[],
    kind: number,
    h0 = 1,
    h1 = 1,
    h2 = 1,
    h3 = 1,
  ): void {
    const ex = p1[0] - p0[0];
    const ey = p1[1] - p0[1];
    const ez = p1[2] - p0[2];
    const fx = p3[0] - p0[0];
    const fy = p3[1] - p0[1];
    const fz = p3[2] - p0[2];
    let nx = ey * fz - ez * fy;
    let ny = ez * fx - ex * fz;
    let nz = ex * fy - ey * fx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-9)) return; // degenerate: a sliver nobody would have seen
    nx /= len;
    ny /= len;
    nz /= len;

    const base = this.v;
    const push = (p: readonly number[], h: number) => {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(nx, ny, nz);
      this.kin.push(kind);
      this.hgt.push(h);
      this.v++;
    };
    push(p0, h0);
    push(p1, h1);
    push(p2, h2);
    push(p3, h3);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  tri(
    p0: readonly number[],
    p1: readonly number[],
    p2: readonly number[],
    kind: number,
    h = 1,
  ): void {
    this.quad(p0, p1, p2, p2, kind, h, h, h, h);
  }

  get triangles(): number {
    return this.idx.length / 3;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("aKind", new THREE.Float32BufferAttribute(this.kin, 1));
    g.setAttribute("aH", new THREE.Float32BufferAttribute(this.hgt, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Polar → world. Allocates a 3-array; build-time only, never per frame. */
function P(r: number, a: number, y: number): number[] {
  return [Math.cos(a) * r, y, Math.sin(a) * r];
}

/* -------------------------------------------------------------------------
 * Quality
 * ---------------------------------------------------------------------- */

interface Budget {
  /** Deepest a deck cell may be, radially. */
  radialStep: number;
  /** Longest arc a deck cell may span, in the gaps between streets. */
  arcStep: number;
  /** Cut the gutter as real geometry rather than only as paint. */
  gutters: boolean;
  /** Segments around the Halo, the parapets and the promenade rings. */
  ringSegs: number;
  /** Every avenue end gets stairs, or every other one. */
  stairStride: number;
  /** Riser height. Steeper on a phone is a tenth of the triangles. */
  riser: number;
}

function budgetFor(tier: QualityTier): Budget {
  if (tier === "low") {
    return {
      radialStep: 15,
      arcStep: 20,
      gutters: false,
      ringSegs: 72,
      stairStride: 2,
      riser: 0.46,
    };
  }
  return {
    radialStep: 7,
    arcStep: 9,
    gutters: true,
    ringSegs: 168,
    stairStride: 1,
    riser: 0.28,
  };
}

/* -------------------------------------------------------------------------
 * The deck: a polar grid whose cells are cut on the streets
 *
 * Radially the breakpoints are every edge of every ring road; angularly they
 * are every edge of every avenue and lane, expressed as *metres* of arc so a
 * street is the same width at every radius, which is the one thing a radial
 * plan gets wrong if you write it in radians.
 * ---------------------------------------------------------------------- */

/** An angular breakpoint: `base` radians plus `m` metres of arc at radius r. */
interface ABreak {
  base: number;
  m: number;
}

function angleOf(b: ABreak, r: number): number {
  return b.base + b.m / r;
}

function radialBreaks(q: Budget): number[] {
  const set = new Set<number>();
  const push = (r: number) => {
    if (r > HALO_R + 1e-3 && r < PLATEAU_R - 1e-3) set.add(Math.round(r * 1000) / 1000);
  };
  // The plaza apron: past this radius a lot is a lot, inside it it is plaza.
  push(HALO_R + 9);
  for (const ring of RINGS) {
    push(ring.r - ring.half - ring.walk);
    push(ring.r - ring.half);
    if (q.gutters) push(ring.r - ring.half + GUTTER_W);
    push(ring.r);
    if (q.gutters) push(ring.r + ring.half - GUTTER_W);
    push(ring.r + ring.half);
    push(ring.r + ring.half + ring.walk);
  }
  push(PLATEAU_R - PARAPET_T);
  return [HALO_R, ...Array.from(set).sort((a, b) => a - b), PLATEAU_R];
}

function angularBreaks(r: number, q: Budget): ABreak[] {
  const raw: ABreak[] = [];
  for (const rad of RADIALS) {
    if (r < rad.rMin) continue;
    const step = TAU / rad.n;
    const offs = q.gutters
      ? [
          -(rad.half + rad.walk),
          -rad.half,
          -(rad.half - GUTTER_W),
          0,
          rad.half - GUTTER_W,
          rad.half,
          rad.half + rad.walk,
        ]
      : [-(rad.half + rad.walk), -rad.half, 0, rad.half, rad.half + rad.walk];
    for (let k = 0; k < rad.n; k++) {
      const base = rad.a0 + k * step;
      for (const m of offs) raw.push({ base, m });
    }
  }
  // Nothing radial at all this far in: a plain fan will do.
  if (raw.length === 0) {
    const n = Math.max(24, Math.min(q.ringSegs, Math.round((TAU * r) / q.arcStep)));
    const out: ABreak[] = [];
    for (let i = 0; i <= n; i++) out.push({ base: (i / n) * TAU, m: 0 });
    return out;
  }

  // Normalise every base so its angle at this radius lands in [0, TAU).
  for (const b of raw) {
    const ang = angleOf(b, r);
    b.base -= Math.floor(ang / TAU) * TAU;
  }
  raw.sort((x, y) => angleOf(x, r) - angleOf(y, r));

  // Drop coincident breaks — they make zero-area cells and nothing else.
  const uniq: ABreak[] = [];
  for (const b of raw) {
    if (uniq.length === 0 || angleOf(b, r) - angleOf(uniq[uniq.length - 1], r) > 1e-4) uniq.push(b);
  }
  // Close the circle.
  uniq.push({ base: uniq[0].base + TAU, m: uniq[0].m });

  // Fill the long gaps between streets so the arcs stay round. A fill point is
  // a lerp of its two neighbours in *both* fields, which is exact: the angle
  // is linear in `base` and in `m` at every radius, so the fill tracks the
  // street edges as they converge inward instead of drifting off them.
  const out: ABreak[] = [];
  for (let i = 0; i + 1 < uniq.length; i++) {
    const a = uniq[i];
    const b = uniq[i + 1];
    out.push(a);
    const arc = (angleOf(b, r) - angleOf(a, r)) * r;
    const n = Math.min(24, Math.ceil(arc / q.arcStep));
    for (let j = 1; j < n; j++) {
      const t = j / n;
      out.push({ base: a.base + (b.base - a.base) * t, m: a.m + (b.m - a.m) * t });
    }
  }
  out.push(uniq[uniq.length - 1]);
  return out;
}

function kindOf(x: number, z: number): number {
  switch (surfaceAt(x, z).kind) {
    case "road":
      return K_ROAD;
    case "walk":
      return K_WALK;
    case "plaza":
      return K_PLAZA;
    case "promenade":
      return K_PROM;
    case "parapet":
      return K_WALK;
    default:
      return K_LOT;
  }
}

function buildDeck(m: Mesher, q: Budget): void {
  const rb = radialBreaks(q);
  const EPS = 0.3;

  for (let bi = 0; bi + 1 < rb.length; bi++) {
    const R0 = rb[bi];
    const R1 = rb[bi + 1];
    if (R1 - R0 < 1e-3) continue;
    const nSub = Math.max(1, Math.ceil((R1 - R0) / q.radialStep));
    for (let s = 0; s < nSub; s++) {
      const r0 = R0 + ((R1 - R0) * s) / nSub;
      const r1 = R0 + ((R1 - R0) * (s + 1)) / nSub;
      const rm = (r0 + r1) / 2;
      const br = angularBreaks(rm, q);

      for (let i = 0; i + 1 < br.length; i++) {
        const A = br[i];
        const B = br[i + 1];
        const aA0 = angleOf(A, r0);
        const aA1 = angleOf(A, r1);
        const aB0 = angleOf(B, r0);
        const aB1 = angleOf(B, r1);
        const am = (angleOf(A, rm) + angleOf(B, rm)) / 2;
        const cx = Math.cos(am) * rm;
        const cz = Math.sin(am) * rm;
        const kind = kindOf(cx, cz);

        const c00 = P(r0, aA0, 0);
        const c01 = P(r0, aB0, 0);
        const c11 = P(r1, aB1, 0);
        const c10 = P(r1, aA1, 0);
        if (kind === K_ROAD) {
          c00[1] = roadTop(c00[0], c00[2]);
          c01[1] = roadTop(c01[0], c01[2]);
          c11[1] = roadTop(c11[0], c11[2]);
          c10[1] = roadTop(c10[0], c10[2]);
        } else {
          c00[1] = ISLAND_Y;
          c01[1] = ISLAND_Y;
          c11[1] = ISLAND_Y;
          c10[1] = ISLAND_Y;
        }
        m.quad(c00, c01, c11, c10, kind);

        if (kind === K_ROAD) continue;

        /* Kerbs. Asked for rather than derived: probe just across each of the
           four edges and put a wall there if the answer is carriageway. That
           stays right when a width changes, and it puts a kerb round the
           inside of a junction without anybody having to enumerate junctions. */
        const wall = (
          e0: number[],
          e1: number[],
          px: number,
          pz: number,
        ) => {
          if (surfaceAt(px, pz).kind !== "road") return;
          const b0 = roadTop(e0[0], e0[2]);
          const b1 = roadTop(e1[0], e1[2]);
          // A dropped kerb where the crossing lands, so the crossing is a
          // crossing rather than a painted stripe up against a 210 mm step.
          const mx = (e0[0] + e1[0]) / 2;
          const mz = (e0[2] + e1[2]) / 2;
          const drop = inCrossing(mx, mz) ? 0.16 : 1;
          const y0 = ISLAND_Y - (ISLAND_Y - b0) * drop;
          const y1 = ISLAND_Y - (ISLAND_Y - b1) * drop;
          if (ISLAND_Y - Math.min(y0, y1) < 0.01) return;
          m.quad(
            [e0[0], y0, e0[2]],
            [e1[0], y1, e1[2]],
            [e1[0], ISLAND_Y, e1[2]],
            [e0[0], ISLAND_Y, e0[2]],
            K_KERB,
            0,
            0,
            1,
            1,
          );
        };

        wall(c00, c01, Math.cos(am) * (r0 - EPS), Math.sin(am) * (r0 - EPS));
        wall(c10, c11, Math.cos(am) * (r1 + EPS), Math.sin(am) * (r1 + EPS));
        const aAm = angleOf(A, rm) - EPS / rm;
        wall(c00, c10, Math.cos(aAm) * rm, Math.sin(aAm) * rm);
        const aBm = angleOf(B, rm) + EPS / rm;
        wall(c01, c11, Math.cos(aBm) * rm, Math.sin(aBm) * rm);
      }
    }
  }
}

/* -------------------------------------------------------------------------
 * The Halo
 *
 * The middle of the city, and the first thing anybody sees: the spawn is at
 * the south end of it looking up the avenue at the Beacon.
 *
 * The relief is deliberately tiny — three courses of 60 mm rising to the
 * Beacon's plinth, and a 50 mm band under the ring of light. The plan says
 * the whole plaza is flat at `ISLAND_Y` and every body in the world is stood
 * on that answer, so anything you could actually trip over here is something
 * the player walks *through*. Sixty millimetres is below the noise, and it is
 * enough: with the sun five degrees off the horizon a vertical face is lit
 * twelve times as hard as a horizontal one, so a step that low still draws a
 * bright line right round the dais.
 * ---------------------------------------------------------------------- */

/** Radii where the plaza changes height. The rise itself is `plazaLift`. */
const HALO_RELIEF = [8, 14, 20, 38.5, 41.5];

function plazaLift(r: number): number {
  if (r < 8) return 0.18;
  if (r < 14) return 0.12;
  if (r < 20) return 0.06;
  if (r >= 38.5 && r <= 41.5) return 0.05;
  return 0;
}

function buildHalo(m: Mesher, q: Budget): void {
  const n = q.ringSegs;
  const radii = [
    0, 2.4, 5, 8, 11, 14, 17, 20, 24, 28, 32, 35.5, 38.5, 40, 41.5, 44.5, 48, 52, HALO_R,
  ];
  const y = (r: number) => ISLAND_Y + plazaLift(r);

  for (let i = 0; i + 1 < radii.length; i++) {
    const r0 = radii[i];
    const r1 = radii[i + 1];
    const y0 = y((r0 + r1) / 2);
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * TAU;
      const a1 = ((k + 1) / n) * TAU;
      if (r0 < 1e-4) {
        m.tri(P(0, 0, y0), P(r1, a0, y0), P(r1, a1, y0), K_PLAZA);
      } else {
        m.quad(P(r0, a0, y0), P(r0, a1, y0), P(r1, a1, y0), P(r1, a0, y0), K_PLAZA);
      }
    }
  }

  // The risers between courses. Their faces are what the low sun actually hits.
  for (const rr of HALO_RELIEF) {
    const inner = ISLAND_Y + plazaLift(rr - 0.05);
    const outer = ISLAND_Y + plazaLift(rr + 0.05);
    if (Math.abs(inner - outer) < 1e-4) continue;
    const lo = Math.min(inner, outer);
    const hi = Math.max(inner, outer);
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * TAU;
      const a1 = ((k + 1) / n) * TAU;
      m.quad(P(rr, a0, lo), P(rr, a1, lo), P(rr, a1, hi), P(rr, a0, hi), K_KERB, 0, 0, 1, 1);
    }
  }
}

/* -------------------------------------------------------------------------
 * The rim: parapet, fascia, promenades, stairs
 * ---------------------------------------------------------------------- */

type Opening = [number, number];

function inOpening(a: number, openings: Opening[]): boolean {
  let x = a % TAU;
  if (x < 0) x += TAU;
  for (const [s, e] of openings) {
    if (x >= s && x <= e) return true;
    if (x + TAU >= s && x + TAU <= e) return true;
  }
  return false;
}

/**
 * A parapet as a ring of wall with holes in it.
 *
 * Waist-high on a 1.8 m body, which is the height at which a rail stops being
 * a fence and starts being something to lean on — and the reason to build a
 * city on a floating rock at all is to stand at the edge of it.
 */
function buildParapet(
  m: Mesher,
  rOuter: number,
  thick: number,
  yBase: number,
  h: number,
  openings: Opening[],
  segs: number,
): void {
  const rIn = rOuter - thick;
  const top = yBase + h;
  let prevSolid = false;
  for (let k = 0; k < segs; k++) {
    const a0 = (k / segs) * TAU;
    const a1 = ((k + 1) / segs) * TAU;
    const solid = !inOpening((a0 + a1) / 2, openings);
    if (solid) {
      // Outer face, inner face, coping.
      m.quad(P(rOuter, a0, yBase), P(rOuter, a1, yBase), P(rOuter, a1, top), P(rOuter, a0, top), K_WALL, 0, 0, 1, 1);
      m.quad(P(rIn, a0, yBase), P(rIn, a1, yBase), P(rIn, a1, top), P(rIn, a0, top), K_WALL, 0, 0, 1, 1);
      m.quad(P(rIn, a0, top), P(rIn, a1, top), P(rOuter, a1, top), P(rOuter, a0, top), K_CAP);
    }
    // Close the ends where a run stops at an opening.
    if (solid !== prevSolid) {
      m.quad(P(rIn, a0, yBase), P(rOuter, a0, yBase), P(rOuter, a0, top), P(rIn, a0, top), K_WALL, 0, 0, 1, 1);
    }
    prevSolid = solid;
  }
}

/** A vertical skirt under a deck edge, so the slab reads as a slab. */
function buildFascia(m: Mesher, r: number, yTop: number, depth: number, segs: number): void {
  for (let k = 0; k < segs; k++) {
    const a0 = (k / segs) * TAU;
    const a1 = ((k + 1) / segs) * TAU;
    m.quad(
      P(r, a0, yTop - depth),
      P(r, a1, yTop - depth),
      P(r, a1, yTop),
      P(r, a0, yTop),
      K_WALL,
      0,
      0,
      1,
      1,
    );
  }
}

interface Flight {
  rStart: number;
  rEnd: number;
  yTop: number;
  yBot: number;
  a0: number;
  sweep: number;
  steps: number;
  width: number;
}

/**
 * Where the stairs go, and why they run sideways.
 *
 * The first promenade is twenty-two metres below the deck and four metres
 * outboard of it. A stair that took that drop radially would be a ladder, so
 * each flight descends *along the rim*, spiralling gently outward until it
 * lands in the middle of the ring below. Three flights from the deck to the
 * bottom promenade, at each of the eight avenue ends, so wherever you are on
 * the city the way down is at the end of the street you are standing in.
 */
function stairFlights(k: number, q: Budget): Flight[] {
  const A = AVENUE_A0 + (k / AVENUE_N) * TAU;
  const going = 0.32;
  const rStart = [PLATEAU_R + 3, DECKS[1].outer - 6, DECKS[2].outer - 6];
  const rEnd = [
    DECKS[1].outer - DECKS[1].width / 2,
    DECKS[2].outer - DECKS[2].width / 2,
    DECKS[3].outer - DECKS[3].width / 2,
  ];
  const out: Flight[] = [];
  let off = 5.5 / PLATEAU_R;
  for (let i = 0; i < 3; i++) {
    const yTop = DECKS[i].y;
    const yBot = DECKS[i + 1].y;
    const steps = Math.max(6, Math.round((yTop - yBot) / q.riser));
    const dr = (rEnd[i] - rStart[i]) / steps;
    const tang = Math.sqrt(Math.max(going * going - dr * dr, 0.02));
    const rMid = (rStart[i] + rEnd[i]) / 2;
    const sweep = (steps * tang) / rMid;
    out.push({ rStart: rStart[i], rEnd: rEnd[i], yTop, yBot, a0: A + off, sweep, steps, width: 7 });
    off += sweep + 7 / rMid;
  }
  return out;
}

function buildFlight(m: Mesher, f: Flight): void {
  const n = f.steps;
  const rise = (f.yTop - f.yBot) / n;
  const hw = f.width / 2;
  const railEvery = Math.max(2, Math.round(n / 14));
  const railPts: Array<{ a: number; r: number; y: number }> = [];

  for (let s = 0; s < n; s++) {
    const t0 = s / n;
    const t1 = (s + 1) / n;
    const a0 = f.a0 + f.sweep * t0;
    const a1 = f.a0 + f.sweep * t1;
    const rc0 = f.rStart + (f.rEnd - f.rStart) * t0;
    const rc1 = f.rStart + (f.rEnd - f.rStart) * t1;
    const yUp = f.yTop - s * rise;
    const yDn = f.yTop - (s + 1) * rise;

    // Tread. aH runs 0 at the back of the step to 1 at the nosing.
    m.quad(
      P(rc0 - hw, a0, yDn),
      P(rc0 + hw, a0, yDn),
      P(rc1 + hw, a1, yDn),
      P(rc1 - hw, a1, yDn),
      K_TREAD,
      0,
      0,
      1,
      1,
    );
    // Riser.
    m.quad(
      P(rc0 - hw, a0, yDn),
      P(rc0 + hw, a0, yDn),
      P(rc0 + hw, a0, yUp),
      P(rc0 - hw, a0, yUp),
      K_RISER,
      0,
      0,
      1,
      1,
    );
    // Soffit, so the flight is a solid thing when you fly under it.
    m.quad(
      P(rc0 - hw, a0, yUp - 0.9),
      P(rc1 - hw, a1, yDn - 0.9),
      P(rc1 + hw, a1, yDn - 0.9),
      P(rc0 + hw, a0, yUp - 0.9),
      K_WALL,
      0.4,
      0.4,
      0.4,
      0.4,
    );

    if (s % railEvery === 0 || s === n - 1) railPts.push({ a: a0, r: rc0 + hw, y: yDn });
  }

  // A raked rail on the outboard side. Sampled, because a rail is a straight
  // incline and there is no reason to spend a quad per step on it.
  for (let i = 0; i + 1 < railPts.length; i++) {
    const p = railPts[i];
    const s = railPts[i + 1];
    const rp = p.r + 0.2;
    const rs = s.r + 0.2;
    const top = 0.95;
    m.quad(P(rp, p.a, p.y), P(rs, s.a, s.y), P(rs, s.a, s.y + top), P(rp, p.a, p.y + top), K_WALL, 0, 0, 1, 1);
    m.quad(
      P(rp - 0.3, p.a, p.y),
      P(rs - 0.3, s.a, s.y),
      P(rs - 0.3, s.a, s.y + top),
      P(rp - 0.3, p.a, p.y + top),
      K_WALL,
      0,
      0,
      1,
      1,
    );
    m.quad(
      P(rp - 0.3, p.a, p.y + top),
      P(rs - 0.3, s.a, s.y + top),
      P(rs, s.a, s.y + top),
      P(rp, p.a, p.y + top),
      K_CAP,
    );
  }
}

function buildRim(m: Mesher, q: Budget): void {
  const segs = q.ringSegs * 2;

  /* ---- the promenade rings ---- */
  for (let i = 1; i < DECKS.length; i++) {
    const d = DECKS[i];
    const inner = d.outer - d.width;
    for (let k = 0; k < segs; k++) {
      const a0 = (k / segs) * TAU;
      const a1 = ((k + 1) / segs) * TAU;
      m.quad(P(inner, a0, d.y), P(inner, a1, d.y), P(d.outer, a1, d.y), P(d.outer, a0, d.y), K_PROM);
    }
    buildFascia(m, d.outer, d.y, 1.6, segs);
  }

  /* ---- the deck's own edge ---- */
  buildFascia(m, PLATEAU_R, ISLAND_Y, 2.4, segs);

  /* ---- stairs, and the parapet openings they need ---- */
  const openDeck: Opening[] = [];
  const openProm: Opening[][] = [[], [], []];
  const norm = (a: number) => {
    let x = a % TAU;
    if (x < 0) x += TAU;
    return x;
  };

  for (let k = 0; k < AVENUE_N; k += q.stairStride) {
    const flights = stairFlights(k, q);
    const A = AVENUE_A0 + (k / AVENUE_N) * TAU;

    /* The landing that bridges the parapet out over the first promenade. You
       walk out of the city through the gap in the parapet onto a balcony, and
       the stair goes down off the end of it — the drop to the first promenade
       is twenty-two metres over four of clearance, so nothing else fits. */
    const wl = 5 / PLATEAU_R;
    for (let j = 0; j < 6; j++) {
      const a0 = A - wl + ((2 * wl) / 6) * j;
      const a1 = A - wl + ((2 * wl) / 6) * (j + 1);
      m.quad(
        P(PLATEAU_R, a0, ISLAND_Y),
        P(PLATEAU_R, a1, ISLAND_Y),
        P(PLATEAU_R + 7, a1, ISLAND_Y),
        P(PLATEAU_R + 7, a0, ISLAND_Y),
        K_PROM,
      );
      // Its own edge and soffit, so it is a balcony and not a sheet of paper.
      m.quad(
        P(PLATEAU_R + 7, a0, ISLAND_Y - 1.4),
        P(PLATEAU_R + 7, a1, ISLAND_Y - 1.4),
        P(PLATEAU_R + 7, a1, ISLAND_Y),
        P(PLATEAU_R + 7, a0, ISLAND_Y),
        K_WALL,
        0,
        0,
        1,
        1,
      );
      m.quad(
        P(PLATEAU_R, a0, ISLAND_Y - 1.4),
        P(PLATEAU_R + 7, a0, ISLAND_Y - 1.4),
        P(PLATEAU_R + 7, a1, ISLAND_Y - 1.4),
        P(PLATEAU_R, a1, ISLAND_Y - 1.4),
        K_WALL,
        0.3,
        0.3,
        0.3,
        0.3,
      );
    }
    // A rail down each side of the landing, so the balcony has edges.
    for (const side of [-1, 1]) {
      const aa = A + wl * side;
      m.quad(
        P(PLATEAU_R, aa, ISLAND_Y),
        P(PLATEAU_R + 7, aa, ISLAND_Y),
        P(PLATEAU_R + 7, aa, ISLAND_Y + PARAPET_H),
        P(PLATEAU_R, aa, ISLAND_Y + PARAPET_H),
        K_WALL,
        0,
        0,
        1,
        1,
      );
    }
    openDeck.push([norm(A - wl - 0.002), norm(A - wl - 0.002) + 2 * wl + 0.004]);

    for (let i = 0; i < flights.length; i++) {
      buildFlight(m, flights[i]);
      if (i > 0) {
        // Where the flight leaves the promenade above it, the parapet stops.
        const f = flights[i];
        const rr = DECKS[i].outer;
        const cross = (rr - f.rStart) / Math.max(f.rEnd - f.rStart, 1e-3);
        const at = f.a0 + f.sweep * Math.max(cross, 0);
        const w = 6 / rr;
        openProm[i - 1].push([norm(at - w), norm(at - w) + 2 * w + f.sweep * 0.25]);
      }
    }
  }

  /* ---- the parapets ---- */
  buildParapet(m, PLATEAU_R, PARAPET_T, ISLAND_Y, PARAPET_H, openDeck, segs);
  for (let i = 1; i < DECKS.length; i++) {
    buildParapet(m, DECKS[i].outer, 0.5, DECKS[i].y, PARAPET_H, openProm[i - 1] ?? [], segs);
  }
}

/* -------------------------------------------------------------------------
 * The shader
 *
 * One material for every surface above. Everything you can see on the ground —
 * the paving courses, the district palettes, the road markings, the zebras,
 * the tram rails, the gully gratings, the Halo's ring of light, the painted
 * circles on the Launch Terrace — is computed here from world XZ, because
 * there are no textures in this world and a polar pattern built from the same
 * radii as the streets lands exactly on them for free.
 * ---------------------------------------------------------------------- */

const f4 = (n: number) => n.toFixed(4);

function shaderDefines(): string {
  const launch = cityPlan().landmarks.find((l) => l.kind === "launch");
  const lx = launch ? launch.x : 0;
  const lz = launch ? launch.z : 0;
  return /* glsl */ `
#define TAU 6.283185307179586
#define HALO_R ${f4(HALO_R)}
#define RING0 ${f4(RING_R[0])}
#define RING1 ${f4(RING_R[1])}
#define RING2 ${f4(RING_R[2])}
#define RIMR ${f4(RIM_R)}
#define RING_HALF ${f4(W.ring.half)}
#define RIM_HALF ${f4(W.rim.half)}
#define AV_HALF ${f4(W.avenue.half)}
#define AV_WALK ${f4(W.avenue.walk)}
#define LN_HALF ${f4(W.lane.half)}
#define LN_WALK ${f4(W.lane.walk)}
#define AV_A0 ${f4(AVENUE_A0)}
#define LN_A0 ${f4(LANE_A0)}
#define AV_STEP ${f4(TAU / AVENUE_N)}
#define LN_STEP ${f4(TAU / LANE_N)}
#define PLATEAU_R ${f4(PLATEAU_R)}
#define ISLAND_Y ${f4(ISLAND_Y)}
#define KERB_FACE ${f4(KERB_FACE)}
#define CROSS_IN ${f4(CROSS_IN)}
#define CROSS_W ${f4(CROSS_W)}
#define D0 ${f4(DISTRICTS[0].r1)}
#define D1 ${f4(DISTRICTS[1].r1)}
#define D2 ${f4(DISTRICTS[2].r1)}
#define D3 ${f4(DISTRICTS[3].r1)}
#define LAUNCH_X ${f4(lx)}
#define LAUNCH_Z ${f4(lz)}
#define K_ROAD ${K_ROAD}
#define K_WALK ${K_WALK}
#define K_PLAZA ${K_PLAZA}
#define K_LOT ${K_LOT}
#define K_KERB ${K_KERB}
#define K_PROM ${K_PROM}
#define K_WALL ${K_WALL}
#define K_CAP ${K_CAP}
#define K_TREAD ${K_TREAD}
#define K_RISER ${K_RISER}
`;
}

/**
 * The one place this file is not self-contained: three's shadow chunks.
 *
 * A raw `ShaderMaterial` computes its own light and therefore receives no
 * shadows at all, and the ground is the single worst surface in the world to
 * have that be true of — `lighting.ts` exists to put "the shadow of a bench, a
 * lamp post, a parapet, a market stall" somewhere, and *here* is where they
 * land. So the standard chunks are grafted on and the direct sun term is
 * multiplied by `getShadowMask()`, which is exactly what a `MeshStandardMaterial`
 * does. The cost is `lights: true` and the `UniformsLib.lights` merge below;
 * without both of those the program links and every shadow uniform is garbage.
 *
 * Everything else — ambient, the specular streak, all of the albedo — stays
 * hand-written, because none of it is anything three's lighting model does.
 */
const VERT = /* glsl */ `
#include <common>
#include <shadowmap_pars_vertex>
attribute float aKind;
attribute float aH;
varying vec3 vWPos;
varying vec3 vNrm;
varying float vKind;
varying float vH;
void main() {
  vKind = aKind;
  vH = aH;
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <project_vertex>
  #include <worldpos_vertex>
  #include <shadowmap_vertex>
  vec4 wpos = modelMatrix * vec4(transformed, 1.0);
  vWPos = wpos.xyz;
  vNrm = normalize(mat3(modelMatrix) * objectNormal);
}
`;

const FRAG = /* glsl */ `
precision highp float;

#include <common>
#include <packing>
// Declared by lights_pars_begin for three's own materials, and uploaded per
// object by the renderer whether or not the program has it. Including that
// whole chunk to get one bool would drag in every light struct in the engine;
// getShadowMask reads this and nothing else from it.
uniform bool receiveShadow;
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>

uniform vec3 uSun;
uniform vec3 uCam;
uniform float uDusk;
uniform vec3 uAccent[5];

varying vec3 vWPos;
varying vec3 vNrm;
varying float vKind;
varying float vH;

/* ---- small change ---------------------------------------------------- */

float h21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = h21(i);
  float b = h21(i + vec2(1.0, 0.0));
  float c = h21(i + vec2(0.0, 1.0));
  float d = h21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  return vnoise(p) * 0.55 + vnoise(p * 2.07) * 0.28 + vnoise(p * 4.13) * 0.17;
}

/** Signed angular offset to the nearest spoke of a family. */
float angSigned(float a, float stp, float off) {
  float d = mod(a - off, stp);
  if (d > stp * 0.5) d -= stp;
  return d;
}

float band(float x, float centre, float half_, float aa) {
  return smoothstep(half_ + aa, half_ - aa, abs(x - centre));
}

/* ---- the paving ------------------------------------------------------
 *
 * Polar, always: courses at fixed radial pitch and slabs at fixed arc pitch
 * within each course, so the joints run round the city and out from the
 * middle exactly the way the streets do. Alternate courses are staggered
 * half a slab, which is what stops it reading as a grid drawn on a disc.
 */
float paving(float r, float a, float course, float slab, float jw, float px, out float sid) {
  float ringI = floor(r / course);
  float rMid = (ringI + 0.5) * course;
  float n = max(8.0, floor(TAU * rMid / slab + 0.5));
  float stag = mod(ringI, 2.0) * 0.5;
  float t = (a / TAU + 0.5) * n + stag;
  sid = h21(vec2(ringI, floor(mod(t, n))));
  float fr = fract(r / course);
  float ft = fract(t);
  float dr = min(fr, 1.0 - fr) * course;
  float da = min(ft, 1.0 - ft) * (TAU * rMid / n);
  return smoothstep(0.0, jw + px * 1.2, min(dr, da));
}

/* ---- districts -------------------------------------------------------
 *
 * The core is cut stone and precise. The Bazaar is small warm setts, laid
 * long ago and walked on ever since. The Terraces go soft and green because
 * half the island's planting is there. The Rim is big plain slabs, because
 * nobody detailing a city spends the budget four hundred metres out.
 */
void districtStone(float r, out vec3 base, out float course, out float slab,
                   out float jw, out float wear, out vec3 accent) {
  if (r < D0) {
    base = vec3(0.52, 0.47, 0.41); course = 1.40; slab = 1.20; jw = 0.020; wear = 0.10; accent = uAccent[0];
  } else if (r < D1) {
    base = vec3(0.43, 0.45, 0.48); course = 1.30; slab = 1.05; jw = 0.016; wear = 0.06; accent = uAccent[1];
  } else if (r < D2) {
    base = vec3(0.47, 0.36, 0.27); course = 0.62; slab = 0.54; jw = 0.030; wear = 0.42; accent = uAccent[2];
  } else if (r < D3) {
    base = vec3(0.40, 0.43, 0.34); course = 1.00; slab = 0.86; jw = 0.026; wear = 0.28; accent = uAccent[3];
  } else {
    base = vec3(0.45, 0.44, 0.45); course = 1.90; slab = 1.55; jw = 0.018; wear = 0.12; accent = uAccent[4];
  }
}

/* ---- which road, and where across it --------------------------------- */

float gRingR, gRingHalf, gRingType, gRingCross;
float gAvCross, gLnCross;
float gOnRing, gOnAv, gOnLn;

void roadCoords(float r, float a) {
  gRingR = 0.0; gRingHalf = 1.0; gRingType = 0.0; gRingCross = 1e9;
  float bestOut = 1e9;
  #define RTRY(RR, HH, TT) { float d = abs(r - (RR)) - (HH); if (d < bestOut) { bestOut = d; gRingR = (RR); gRingHalf = (HH); gRingType = (TT); gRingCross = r - (RR); } }
  RTRY(RING0, RING_HALF, 1.0)
  RTRY(RING1, RING_HALF, 2.0)
  RTRY(RING2, RING_HALF, 1.0)
  RTRY(RIMR, RIM_HALF, 3.0)
  #undef RTRY
  gOnRing = step(bestOut, 0.0);

  gAvCross = angSigned(a, AV_STEP, AV_A0) * r;
  gOnAv = step(abs(gAvCross), AV_HALF) * step(HALO_R, r);
  gLnCross = angSigned(a, LN_STEP, LN_A0) * r;
  gOnLn = step(abs(gLnCross), LN_HALF) * step(RING0, r);
}

/** Metres from a point to the nearest carriageway edge. Negative on the road. */
float distToKerb(float r) {
  float d = 1e9;
  d = min(d, abs(gRingCross) - gRingHalf);
  d = min(d, abs(gAvCross) - AV_HALF);
  if (r > RING0) d = min(d, abs(gLnCross) - LN_HALF);
  return d;
}

/** True inside a painted crossing. Mirrors inCrossing() in the mesher. */
float crossingMask(float r) {
  float m = 0.0;
  if (abs(gRingCross) <= gRingHalf + 0.75) {
    float da = abs(gAvCross);
    m = max(m, step(AV_HALF + CROSS_IN, da) * step(da, AV_HALF + CROSS_IN + CROSS_W));
    if (r > RING0) {
      float dl = abs(gLnCross);
      m = max(m, step(LN_HALF + CROSS_IN, dl) * step(dl, LN_HALF + CROSS_IN + CROSS_W));
    }
  }
  float onRadial = step(abs(gAvCross), AV_HALF + 0.75) * step(HALO_R, r)
                 + step(abs(gLnCross), LN_HALF + 0.75) * step(RING0, r);
  if (onRadial > 0.5) {
    float dr = abs(gRingCross);
    m = max(m, step(gRingHalf + CROSS_IN, dr) * step(dr, gRingHalf + CROSS_IN + CROSS_W));
  }
  return m;
}

/* ---- the carriageway -------------------------------------------------- */

vec3 roadShade(float r, float a, float px, float detail, out float gloss, out vec3 emis) {
  emis = vec3(0.0);

  // Which road we are on, and the coordinates along and across it.
  float crs, hlf, along, typ;
  if (gOnRing > 0.5) {
    crs = gRingCross; hlf = gRingHalf; along = a * gRingR; typ = gRingType;
  } else if (gOnAv > 0.5) {
    crs = gAvCross; hlf = AV_HALF; along = r; typ = 4.0;
  } else {
    crs = gLnCross; hlf = LN_HALF; along = r; typ = 5.0;
  }
  // At a junction the two carriageways are one piece of ground, and no line
  // on either of them survives crossing the other.
  float junction = 0.0;
  if (gOnRing > 0.5) {
    junction = max(step(abs(gAvCross), AV_HALF + 0.9), step(abs(gLnCross), LN_HALF + 0.9) * step(RING0, r));
  } else {
    junction = step(abs(gRingCross), gRingHalf + 0.9);
  }
  float ac = abs(crs);

  /* Surface. A pale warm composite, not tarmac.
   *
   * Real asphalt is about 7% reflectance and the first pass used it, which is
   * correct and wrong: under a five-degree sun and a sky that is doing most of
   * the lighting, every street in the city came out near black and the place
   * read as a wet European city at 2 a.m. This is a city of glass on a rock
   * that never landed and the argument it is making is an optimistic one, so
   * the carriageway is a light stone composite at about 20% and the picture
   * changes completely. */
  float grit = fbm(vWPos.xz * 5.5) * 0.5 + fbm(vWPos.xz * 22.0) * 0.5;
  vec3 col = mix(vec3(0.175, 0.168, 0.172), vec3(0.228, 0.212, 0.196), grit * detail);
  col *= 1.0 + (fbm(vWPos.xz * 0.35) - 0.5) * 0.22;

  // Wheel tracks: polished where the traffic runs, coarser between them.
  float lane = hlf * 0.5;
  float w1 = exp(-pow((ac - lane * 0.55) / 0.85, 2.0));
  float w2 = exp(-pow((ac - lane * 1.45) / 0.85, 2.0));
  gloss = 0.30 + (w1 + w2) * 0.22 * detail;
  col *= 1.0 + (w1 + w2) * 0.10 * detail;

  // The channel at each kerb, and a gully every so often along it.
  float gut = smoothstep(hlf - 0.62, hlf - 0.16, ac);
  col *= mix(1.0, 0.72, gut * detail);
  gloss += gut * 0.30 * detail;
  float gullyRun = step(fract(along / 24.0), 0.045);
  float gully = gullyRun * step(hlf - 0.66, ac) * step(ac, hlf - 0.14);
  float slots = step(0.5, fract((ac - hlf) / 0.09));
  col = mix(col, vec3(0.055, 0.052, 0.056) * (0.6 + slots * 0.9), gully * detail);
  gloss = mix(gloss, 0.05, gully * detail);

  /* ---- paint ---- */
  float white = 0.0;
  float amber = 0.0;
  float aa = px * 1.2 + 0.012;

  // Centre line, dashed. Not on the tram ring, which has rails down its spine.
  if (typ != 2.0) {
    float dash = step(fract(along / 9.0), 0.52);
    white += band(ac, 0.0, 0.09, aa) * dash * (1.0 - junction);
  }
  // Lane edges, solid, a metre in from the kerb.
  white += band(ac, hlf - 1.05, 0.065, aa) * (1.0 - junction);

  // The tram, down ring 2. Standard gauge, a concrete bed, and rails that
  // catch the sun as two unbroken lines all the way round the city.
  if (typ == 2.0) {
    float bed = smoothstep(1.75, 1.55, ac);
    col = mix(col, vec3(0.30, 0.29, 0.30), bed * 0.85);
    float sleeper = step(0.55, fract(along / 0.72)) * bed;
    col *= 1.0 - sleeper * 0.16 * detail;
    float rail = band(ac, 0.7175, 0.040, aa);
    col = mix(col, vec3(0.58, 0.56, 0.52), rail);
    gloss = mix(gloss, 0.92, rail);
    white += band(ac, 1.62, 0.055, aa) * (1.0 - junction);
  }

  /* Zebras, just clear of every junction. The bars run *across* the road, so
     the coordinate they repeat along is the one that runs along it: radius on
     a ring road, arc on an avenue. Getting those two the wrong way round
     paints a crossing you would drive down rather than walk over. */
  float cross = crossingMask(r);
  if (cross > 0.5) {
    /* Repeat the bars outward from the junction they belong to rather than
       from an absolute coordinate. An arc coordinate wraps at ±pi — and ±pi
       is an avenue, so an absolute seam would land on a crossing on every
       single ring road. */
    float dJ;
    if (gOnRing > 0.5) {
      float da = abs(gAvCross) - AV_HALF;
      float dl = abs(gLnCross) - LN_HALF;
      dJ = (r > RING0 && dl < da) ? dl : da;
    } else {
      dJ = abs(gRingCross) - gRingHalf;
    }
    float bar = step(fract((dJ - CROSS_IN) / 1.15), 0.60);
    white = max(white, bar * step(ac, hlf - 0.30));
  }

  white = clamp(white, 0.0, 1.0) * (0.55 + 0.45 * detail);
  amber = clamp(amber, 0.0, 1.0) * (0.55 + 0.45 * detail);
  // Paint wears where the wheels run.
  float worn = 1.0 - (w1 + w2) * 0.22;
  col = mix(col, vec3(0.78, 0.75, 0.68) * worn, white);
  col = mix(col, vec3(0.86, 0.52, 0.20) * worn, amber);
  gloss = mix(gloss, 0.14, max(white, amber));
  emis += vec3(1.0, 0.62, 0.28) * amber * uDusk * 0.25;
  return col;
}

/* ---- pavement, plaza, promenade, lots -------------------------------- */

vec3 stoneShade(float r, float a, float px, float detail, int k, out float gloss, out vec3 emis) {
  vec3 base, accent;
  float course, slab, jw, wear;
  districtStone(r, base, course, slab, jw, wear, accent);
  emis = vec3(0.0);
  gloss = 0.12;

  if (k == K_PROM) { base = vec3(0.44, 0.43, 0.46); course = 1.80; slab = 1.50; jw = 0.020; wear = 0.10; }
  if (k == K_LOT) {
    /* The two or three metres of dead ground between a kerb and a shopfront,
       and, in the Terraces, the gardens the district is named for. Not all of
       it: a band where every single lot is lawn reads from the air as a green
       ring somebody painted on, so the planting is broken up by the same noise
       that varies everything else. */
    if (r >= D2 && r < D3) {
      float green = smoothstep(0.42, 0.62, fbm(vWPos.xz * 0.035));
      base = mix(mix(base, vec3(0.40, 0.38, 0.34), 0.5), vec3(0.20, 0.27, 0.16), green);
    } else {
      base = mix(base, vec3(0.40, 0.38, 0.35), 0.55);
    }
    course *= 1.6; slab *= 1.6; wear = min(wear + 0.2, 1.0);
  }

  float sid;
  float joint = paving(r, a, course, slab, jw, px, sid);
  // Every slab is its own stone, and the older the district the less they
  // agree with each other.
  vec3 col = base * (1.0 + (sid - 0.5) * (0.10 + wear * 0.34));
  col *= mix(0.60, 1.05, mix(1.0, joint, detail));
  col *= 1.0 + (fbm(vWPos.xz * 0.9) - 0.5) * (0.10 + wear * 0.22);
  col *= 1.0 - fbm(vWPos.xz * 9.0) * 0.10 * detail;

  // Moss in the joints, but only where the gardens are.
  if (r >= D2 && r < D3) col = mix(col, vec3(0.16, 0.26, 0.14), (1.0 - joint) * 0.55 * detail);

  if (k == K_WALK || k == K_LOT) {
    // The course of big granite setts that always runs beside a kerb.
    float dk = distToKerb(r);
    float edge = smoothstep(0.62, 0.10, dk) * step(0.0, dk);
    col = mix(col, vec3(0.40, 0.40, 0.42) * (0.9 + sid * 0.2), edge * 0.8);
    // Tactile paving where a crossing meets the pavement. Faded out with the
    // rest of the high-frequency half — a buff blister pattern at four hundred
    // metres is one pixel of noise flickering at every junction in the city.
    float pad = crossingMask(r) * step(dk, 1.25) * step(0.0, dk) * detail;
    float blister = step(0.55, fract(r / 0.28)) * step(0.55, fract(a * r / 0.28));
    col = mix(col, vec3(0.56, 0.44, 0.26) * (0.80 + blister * 0.35), pad * 0.75);
  }

  if (k == K_PLAZA) {
    // Eight broad inlay bands, one down the middle of every avenue, so the
    // plaza tells you which way out is even with your eyes on your feet.
    float spoke = abs(angSigned(a, AV_STEP, AV_A0)) * r;
    float bandM = smoothstep(3.4, 2.6, spoke) * step(6.0, r);
    col = mix(col, vec3(0.60, 0.55, 0.47), bandM * 0.7);

    // The Halo: a ring of warm light set into the stone. It is the thing the
    // district is named for and it is what you are standing in.
    float ring = smoothstep(0.52, 0.20, abs(r - 40.0));
    vec3 warm = uAccent[0];
    col = mix(col, warm * 0.7, ring * 0.8);
    emis += warm * ring * (0.22 + uDusk * 1.15);

    // A compass rose under the Beacon, sixteen points, with the middle lit.
    if (r < 24.0) {
      float ray = abs(angSigned(a, TAU / 16.0, 0.0)) * max(r, 1.0);
      float rose = smoothstep(0.9, 0.2, ray) * smoothstep(23.0, 21.0, r) * step(2.6, r);
      col = mix(col, vec3(0.60, 0.56, 0.50), rose * 0.8);
      float core = smoothstep(2.3, 1.9, r);
      col = mix(col, warm * 0.8, core);
      emis += warm * core * (0.35 + uDusk * 1.6);
      // The three courses of the dais, picked out at their edges.
      col *= 1.0 - smoothstep(0.30, 0.02, abs(r - 8.0)) * 0.18;
      col *= 1.0 - smoothstep(0.30, 0.02, abs(r - 14.0)) * 0.18;
      col *= 1.0 - smoothstep(0.30, 0.02, abs(r - 20.0)) * 0.18;
    }
  }

  if (k == K_PROM) {
    // A warm line down the middle of every promenade, which is the only thing
    // out here at night once the city is behind you.
    float m = 1e9;
    m = min(m, abs(r - ${f4(DECKS[1].outer - DECKS[1].width / 2)}));
    m = min(m, abs(r - ${f4(DECKS[2].outer - DECKS[2].width / 2)}));
    m = min(m, abs(r - ${f4(DECKS[3].outer - DECKS[3].width / 2)}));
    float line = smoothstep(0.24, 0.07, m);
    col = mix(col, uAccent[4] * 0.7, line * 0.7);
    emis += uAccent[4] * line * (0.14 + uDusk * 0.85);
  }

  return col;
}

/* ---- the Launch Terrace ----------------------------------------------
 *
 * Painted circles, a wind sock, and the start of every race — and paint does
 * not stop at a kerb. This runs over whatever is underneath it, road and
 * pavement alike, which is the only way a pad that straddles the end of an
 * avenue reads as one pad rather than as three unrelated arcs.
 */
void launchPaint(float aa, float detail, inout vec3 col, inout vec3 emis, inout float gloss) {
  vec2 d2 = vWPos.xz - vec2(LAUNCH_X, LAUNCH_Z);
  float dl = length(d2);
  if (dl > 19.0) return;
  // Everything here is measured about the pad, not about the city. Reaching
  // for the city's own angle put a wedge of paint straight through it,
  // because the pad stands on an avenue and the avenue is where that angle
  // reads zero.
  float al = atan(d2.y, d2.x);
  float amber = 0.0;
  float white = 0.0;
  amber = max(amber, band(dl, 16.0, 0.22, aa));
  amber = max(amber, band(dl, 11.0, 0.30, aa));
  white = max(white, band(dl, 6.4, 0.18, aa));
  white = max(white, smoothstep(2.5, 2.1, dl));
  float spoke = abs(angSigned(al, TAU / 8.0, 0.0)) * dl;
  amber = max(amber, band(spoke, 0.0, 0.26, aa) * smoothstep(16.4, 16.0, dl) * step(11.4, dl));
  amber *= 0.5 + 0.5 * detail;
  white *= 0.5 + 0.5 * detail;
  col = mix(col, vec3(0.86, 0.52, 0.20), amber);
  col = mix(col, vec3(0.80, 0.77, 0.70), white);
  gloss = mix(gloss, 0.16, max(amber, white));
  emis += vec3(1.0, 0.60, 0.26) * amber * uDusk * 0.20;
}

/* ---------------------------------------------------------------------- */

void main() {
  vec3 N = normalize(vNrm);
  if (!gl_FrontFacing) N = -N;

  float r = length(vWPos.xz);
  float a = atan(vWPos.z, vWPos.x);
  float dist = length(vWPos - uCam);
  float px = max(fwidth(vWPos.x), fwidth(vWPos.z));
  /* The near ground is the frame. Past a hundred metres a paving joint is
     narrower than the pixel it is drawn in and every one of them is a moiré
     pattern, so the whole high-frequency half is faded out by distance and
     what is left is the palette. */
  float detail = exp(-dist * 0.0075);

  roadCoords(r, a);

  int k = int(vKind + 0.5);
  vec3 albedo;
  vec3 emis = vec3(0.0);
  float gloss = 0.12;

  if (k == K_ROAD) {
    albedo = roadShade(r, a, px, detail, gloss, emis);
  } else if (k == K_KERB) {
    // Granite, set on edge. Wet and dark in the channel, bleached on top.
    float sid = h21(vec2(floor(r / 0.9), floor(a * r / 0.9)));
    vec3 c = vec3(0.46, 0.45, 0.44) * (0.88 + sid * 0.24);
    c *= mix(0.55, 1.10, vH);
    float jointR = min(fract(r / 0.9), 1.0 - fract(r / 0.9)) * 0.9;
    float jointA = min(fract(a * r / 0.9), 1.0 - fract(a * r / 0.9)) * 0.9;
    c *= mix(0.62, 1.0, smoothstep(0.0, 0.022 + px, min(jointR, jointA)));
    albedo = c;
    gloss = mix(0.42, 0.14, vH);
  } else if (k == K_RISER) {
    float sid = h21(vec2(floor(r * 1.2), floor(a * r * 1.2)));
    albedo = vec3(0.44, 0.42, 0.42) * (0.90 + sid * 0.18) * mix(0.66, 1.06, vH);
    gloss = 0.14;
  } else if (k == K_TREAD) {
    float sid = h21(vec2(floor(r * 0.8), floor(a * r * 0.8)));
    albedo = vec3(0.47, 0.45, 0.44) * (0.92 + sid * 0.14);
    // A nosing at the front edge of every step, so a flight reads as steps
    // from above rather than as a ramp with lines on it.
    albedo = mix(albedo, vec3(0.62, 0.55, 0.42), smoothstep(0.86, 0.97, vH) * 0.8);
    gloss = 0.18;
  } else if (k == K_WALL) {
    // Coursed ashlar. A gradient up the face rather than along world Y —
    // habit worth keeping even in a system that is never mirrored.
    float sid = h21(vec2(floor(a * r / 1.1), floor(vH * 9.0)));
    vec3 c = vec3(0.46, 0.44, 0.43) * (0.90 + sid * 0.18);
    c *= mix(0.62, 1.08, vH);
    float band_ = min(fract(vH * 9.0), 1.0 - fract(vH * 9.0));
    c *= mix(0.74, 1.0, smoothstep(0.0, 0.08, band_));
    albedo = c;
    gloss = 0.10;
  } else if (k == K_CAP) {
    float sid = h21(vec2(floor(r / 1.6), floor(a * r / 1.6)));
    albedo = vec3(0.52, 0.49, 0.45) * (0.92 + sid * 0.16);
    float j = min(fract(a * r / 1.6), 1.0 - fract(a * r / 1.6)) * 1.6;
    albedo *= mix(0.70, 1.0, smoothstep(0.0, 0.03 + px, j));
    gloss = 0.22;
  } else {
    albedo = stoneShade(r, a, px, detail, k, gloss, emis);
  }

  if (k <= K_LOT || k == K_PROM) launchPaint(px * 1.2 + 0.012, detail, albedo, emis, gloss);

  /* ---- light ----
   * Two sources and neither is a lamp: a sun five degrees off the horizon,
   * which means a vertical face is lit an order of magnitude harder than the
   * ground, and the whole sunset dome, which is what is actually lighting the
   * pavement. That ratio is the entire look of this world at ground level. */
  vec3 L = normalize(uSun);
  vec3 V = normalize(uCam - vWPos);
  float ndl = max(dot(N, L), 0.0);

  vec3 sunCol = vec3(1.55, 0.86, 0.44);
  vec3 skyUp = vec3(0.30, 0.34, 0.52);
  /* Downward faces — soffits, the underside of a stair, a fascia — are lit by
     fifteen hundred metres of frozen lake six hundred metres below, which is
     the brightest thing in the picture after the sun. Treating them as
     unlit-and-black is technically defensible and turns every flight of stairs
     on the rim into a silhouette. */
  vec3 skyDn = vec3(0.31, 0.25, 0.27);
  vec3 amb = mix(skyDn, skyUp, N.y * 0.5 + 0.5);

  /* The sun's weight is set against the citadel's stone, not chosen: a
     horizontal face here has to land where the plaza next to it lands or the
     streets read as a different material family from the deck they are cut
     into. That fixes the multiplier, and the low sun does the rest — a
     vertical face sees ten times the direct light a horizontal one does, so
     every kerb, riser and parapet in the city draws itself in warm light
     against ground that is lit almost entirely by the sky. */
  /* The one thing the ground borrows from three: whether the sun reaches it.
     A shadow that lands on a bench and stops at the pavement is worse than no
     shadow at all. Only the direct term is masked — the sky is not occluded by
     a market stall. */
  float sunMask = getShadowMask();
  vec3 col = albedo * (sunCol * ndl * 1.18 * sunMask + amb * 1.0);

  // The long specular streak a low sun lays down a wet road. This is the one
  // effect that makes tarmac look like tarmac, and it only exists because the
  // sun is where it is.
  vec3 H = normalize(L + V);
  float sh = mix(24.0, 260.0, gloss);
  float spec = pow(max(dot(N, H), 0.0), sh) * gloss * sunMask;
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
  col += sunCol * spec * (0.8 + fres * 2.4);

  // Sky bounce along grazing angles, which is what keeps the far deck from
  // going flat grey as it recedes.
  col += vec3(0.36, 0.34, 0.48) * fres * 0.16;

  col += emis;

  // A floor. The ground at dusk is never darker than the sky behind it.
  col = max(col, vec3(0.055, 0.050, 0.070));

  // Ordered-ish dither: a four-hundred-metre gradient banded visibly without.
  col += (h21(gl_FragCoord.xy) - 0.5) * 0.0035;

  gl_FragColor = vec4(col, 1.0);
}
`;

/* -------------------------------------------------------------------------
 * The system
 * ---------------------------------------------------------------------- */

export interface StreetsHandle extends System {
  /** What it cost. Read by the tests and worth knowing when budgeting. */
  readonly stats: { triangles: number; draws: number };
}

export function buildStreets(ctx: BuildContext): StreetsHandle {
  const q = budgetFor(ctx.quality);

  const m = new Mesher();
  buildHalo(m, q);
  buildDeck(m, q);
  buildRim(m, q);

  const geo = m.geometry();
  const triangles = m.triangles;

  // `lights: true` is only half of what a shadow-receiving ShaderMaterial
  // needs: the light uniforms have to be present in `material.uniforms` too,
  // or the program links against nothing and every shadow lookup reads noise.
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.lights]);
  uniforms.uSun = { value: SUN_DIR.clone() };
  uniforms.uCam = { value: new THREE.Vector3() };
  uniforms.uDusk = { value: 0.35 };
  uniforms.uAccent = { value: DISTRICTS.map((d) => new THREE.Color(d.accent)) };

  const material = new THREE.ShaderMaterial({
    name: "EmpyreanStreets",
    vertexShader: VERT,
    fragmentShader: shaderDefines() + FRAG,
    uniforms,
    lights: true,
    side: THREE.DoubleSide,
    fog: false,
    // `fwidth` is core in the GLSL ES 3.00 this compiles to on WebGL2; the
    // flag only matters if something ever drops back to WebGL1.
    extensions: { derivatives: true },
    // Whatever else ends up drawing a disc at ISLAND_Y — the keel's deck, a
    // terrace cap — this is the ground, and it wins the depth test.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = "empyrean-streets";
  // The ground is what the city's shadows are for. It casts too — the parapet
  // and the stairs are in this mesh and both throw a shape worth having.
  mesh.receiveShadow = true;
  mesh.castShadow = true;

  const group = new THREE.Group();
  group.name = "empyrean-streets";
  group.add(mesh);

  return {
    name: "streets",
    group,
    stats: { triangles, draws: 1 },
    update(f: FrameContext) {
      const u = material.uniforms;
      (u.uSun.value as THREE.Vector3).copy(f.sunDir);
      (u.uCam.value as THREE.Vector3).copy(f.camera.position);
      u.uDusk.value = 1 - f.daylight;
    },
    dispose() {
      geo.dispose();
      material.dispose();
      group.remove(mesh);
    },
  };
}
