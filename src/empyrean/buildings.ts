/**
 * EVERY FACADE ON EVERY LOT, and the six landmarks.
 *
 * This is the visual star of The Empyrean and it has to survive two cameras
 * that want opposite things. From a kilometre out the cluster must read as the
 * reference painting — a pyramid of iridescent glass with a flat skirt,
 * backlit by a low sun. From the pavement at 1.8 m it must read as buildings
 * you could walk into: a plinth, a doorway you can see the reveal of, a sill,
 * a fascia, a cornice above. The first build got the first right and the
 * second catastrophically wrong, so everything here is checked from both.
 *
 * ## Draw calls
 *
 * 182 lots and 6 landmarks are **four draws**, not 188. Everything is
 * generated straight into four vertex buckets — glass, masonry, glazing,
 * glow — flushed into chunks and joined with `mergeGeometries`. Variety comes
 * out of per-vertex attributes rather than out of materials:
 *
 * | attribute | meaning |
 * | --- | --- |
 * | `aH` | 0..1 along **this building's own** height |
 * | `aBase` | metres above **this building's own** foot |
 * | `aSeed` | stable per-building 0..100 |
 * | `aTone` | which palette slot a face uses |
 * | `aEdge` | metres to the nearest vertical corner of the facade |
 *
 * ## The reflection rule
 *
 * This system is `reflected`. The lake copy is a `clone(true)` with
 * `scale.y = -1`, so:
 *
 * - **no gradient is driven by world Y.** `aH` and `aBase` are both measured
 *   from the object's own foot in local space, which is what survives the
 *   mirror. `vWPos` is read for XZ and for the eye vector only, never `.y`.
 * - **every material is `side: THREE.DoubleSide`**, because a negative scale
 *   inverts winding.
 * - normals are written explicitly per face rather than left to
 *   `computeVertexNormals`, so winding is cosmetic everywhere.
 *
 * ## Nothing leaves its lot
 *
 * Every building is built on `insetPoly(lot.poly, LOT_INSET)` and nothing
 * projects further than `MAX_PROJECT` from a wall, with `MAX_PROJECT <
 * LOT_INSET`. That is what makes "no building overhangs the pavement" a
 * property rather than a hope, and `src/test/empyreanBuildings.test.ts`
 * checks every vertex of every lot against its polygon.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { makeRng, type Rng } from "@/shared/proc/rng";
import { ISLAND_Y } from "./config";
import { cityPlan, type Landmark, type Lot, type LotUse, type Vec2 } from "./cityplan";
import { SUN_DIR } from "./sky";
import type { BuildContext, FrameContext, QualityTier, System } from "./types";

/* -------------------------------------------------------------------------
 * What the engine needs back
 * ---------------------------------------------------------------------- */

/** An axis-aligned box the player cannot walk through. World space. */
export interface Blocker {
  x: number;
  z: number;
  /** Half-extents on x and z. */
  hx: number;
  hz: number;
  /** Walkable roof. */
  top: number;
  /** Underside — you can fly beneath without being stopped. */
  bottom: number;
}

/** A flat surface you can stand on: a roof, a setback terrace, a platform. */
export interface Deck {
  y: number;
  /** Circular decks carry a radius; rectangular ones carry half-extents. */
  r?: number;
  x?: number;
  z?: number;
  hx?: number;
  hz?: number;
}

/** What one lot turned into. Bookkeeping for tests, tools and debug overlays. */
export interface LotBuild {
  id: string;
  use: LotUse;
  /** False for a lot deliberately left without a building. */
  built: boolean;
  /** World Y of the highest point this lot contributed. */
  top: number;
  triangles: number;
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface BuildingsHandle extends System {
  blockers: Blocker[];
  decks: Deck[];
  /** Per-lot bounds and roof heights, in plan order. */
  lots: LotBuild[];
  stats: { draws: number; triangles: number; vertices: number };
}

/* -------------------------------------------------------------------------
 * Numbers
 * ---------------------------------------------------------------------- */

/** How far a building's walls stand inside the lot boundary. */
const LOT_INSET = 1.2;
/** The furthest anything is allowed to project from a wall. Must be < LOT_INSET. */
const MAX_PROJECT = 1.0;

/** A storey. */
const FLOOR_H = 3.65;
/** The ground floor, which is where the shopfronts are and is taller. */
const GF_H = 4.5;
/** Dark stone at the foot of a tower — METRES, never a fraction of the height. */
const PLINTH_H = 25;

/** Palette slots, as the `aTone` attribute sees them. */
const T_STONE = 0;
const T_BASALT = 1;
const T_TERRA = 2;
const T_METAL = 3;
const T_TIMBER = 4;
const T_LEAF = 5;
const T_ROOF = 6;

/** Glazing kinds, as the pane shader sees them. */
const P_WINDOW = 0;
const P_SHOP = 1;
const P_DARK = 2;

/** Glow tints. */
const G_WARM = 0;
const G_COOL = 1;
const G_WHITE = 2;

const TAU = Math.PI * 2;

/* -------------------------------------------------------------------------
 * Polygon maths
 *
 * All footprints arrive from the plan as `Vec2 {x, z}` wound consistently
 * (the plan's trapezoids all come out with a negative shoelace in x/z). None
 * of this reorders vertices: `Lot.frontEdge` has to keep pointing at the same
 * edge after an inset, or every shopfront in the city faces a courtyard.
 * ---------------------------------------------------------------------- */

type P2 = Vec2;

function shoelace(poly: P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

/**
 * Outward normal of edge `i` (poly[i] → poly[i+1]).
 *
 * Derived from the polygon's own winding rather than assumed, so a plan that
 * one day winds the other way does not turn every facade inside out.
 */
function edgeNormal(poly: P2[], i: number, sign: number): P2 {
  const p = poly[i];
  const q = poly[(i + 1) % poly.length];
  const ex = q.x - p.x;
  const ez = q.z - p.z;
  const len = Math.hypot(ex, ez) || 1;
  return sign > 0 ? { x: ez / len, z: -ex / len } : { x: -ez / len, z: ex / len };
}

/**
 * Move every edge inward by its own distance and re-intersect the corners.
 *
 * Per-edge offsets rather than one number, because a civic building wants its
 * front wall set back three metres for a portico while the other three sides
 * stay where they are. Returns null when the result has collapsed or turned
 * itself inside out, which is the honest answer for a lot too small to hold
 * what was asked of it.
 */
function offsetPoly(poly: P2[], off: number | number[]): P2[] | null {
  const n = poly.length;
  const sign = Math.sign(shoelace(poly)) || 1;
  const amount = (i: number) => (typeof off === "number" ? off : off[i]);
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    const n0 = edgeNormal(poly, prev, sign);
    const n1 = edgeNormal(poly, i, sign);
    // Offset lines: dot(n, p) = c, moved inward by `amount`.
    const c0 = n0.x * poly[prev].x + n0.z * poly[prev].z - amount(prev);
    const c1 = n1.x * poly[i].x + n1.z * poly[i].z - amount(i);
    const det = n0.x * n1.z - n1.x * n0.z;
    if (Math.abs(det) < 1e-6) {
      // Collinear neighbours: slide the vertex straight along the normal.
      out.push({ x: poly[i].x - n1.x * amount(i), z: poly[i].z - n1.z * amount(i) });
      continue;
    }
    out.push({
      x: (c0 * n1.z - c1 * n0.z) / det,
      z: (n0.x * c1 - n1.x * c0) / det,
    });
  }
  const area = shoelace(out);
  if (!Number.isFinite(area) || Math.sign(area) !== sign || Math.abs(area) < 6) return null;
  // Every new vertex must be inside the original, or the "inset" bulged.
  for (const p of out) if (!insidePoly(poly, p.x, p.z, 0.02)) return null;
  return out;
}

/** Even-odd test with a tolerance band, in metres, outward. */
function insidePoly(poly: P2[], x: number, z: number, slack = 0): boolean {
  return outsideBy(poly, x, z) <= slack;
}

/**
 * How far outside the polygon a point is, in metres. Zero when inside.
 *
 * Used by the containment test, which is the only thing standing between a
 * cornice and the middle of the road.
 */
function outsideBy(poly: P2[], x: number, z: number): number {
  const sign = Math.sign(shoelace(poly)) || 1;
  let worst = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const nrm = edgeNormal(poly, i, sign);
    const d = nrm.x * (x - poly[i].x) + nrm.z * (z - poly[i].z);
    if (d > worst) worst = d;
  }
  return Math.max(0, worst);
}

function bboxOf(poly: P2[]): { cx: number; cz: number; hx: number; hz: number } {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of poly) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z;
    if (p.z > z1) z1 = p.z;
  }
  return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2 };
}

function centroidOf(poly: P2[]): P2 {
  let x = 0;
  let z = 0;
  for (const p of poly) {
    x += p.x;
    z += p.z;
  }
  return { x: x / poly.length, z: z / poly.length };
}

/**
 * The polygon, pre-chewed: normals, perimeter parameter and corner distances.
 *
 * The plan's trapezoids have their arcs subdivided into ~12 m segments, so a
 * lot fronting a ring road has three or four nearly-parallel edges making up
 * one *face*. Treating each of those as a separate building side gives a
 * shopfront four metres wide with a pilaster every twelve, so faces are found
 * by grouping edges whose normals agree, and `frontEdge` selects a face rather
 * than a segment.
 */
interface Shell {
  poly: P2[];
  n: number;
  sign: number;
  /** Outward normal per edge. */
  nrm: P2[];
  /** Edge lengths. */
  len: number[];
  /** Cumulative perimeter distance at each vertex — continuous mullion UVs. */
  u: number[];
  /** Metres along the perimeter to the nearest face corner, per vertex. */
  corner: number[];
  /** Face id per edge. Edges sharing an id are one flat-ish facade. */
  face: number[];
  faces: number;
}

const FACE_COS = Math.cos(0.5); // ~29°: an arc facet break is 7°, a corner is 90°

function shellOf(poly: P2[]): Shell {
  const n = poly.length;
  const sign = Math.sign(shoelace(poly)) || 1;
  const nrm: P2[] = [];
  const len: number[] = [];
  for (let i = 0; i < n; i++) {
    nrm.push(edgeNormal(poly, i, sign));
    const q = poly[(i + 1) % n];
    len.push(Math.hypot(q.x - poly[i].x, q.z - poly[i].z));
  }
  const u: number[] = [0];
  for (let i = 1; i < n; i++) u.push(u[i - 1] + len[i - 1]);
  const perim = u[n - 1] + len[n - 1];

  // A vertex is a corner when the two edges meeting there disagree.
  const isCorner: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const a = nrm[(i - 1 + n) % n];
    const b = nrm[i];
    isCorner.push(a.x * b.x + a.z * b.z < FACE_COS);
  }
  // Face ids: walk from a corner so a run never straddles the array seam.
  const face = new Array<number>(n).fill(-1);
  let start = isCorner.findIndex(Boolean);
  let faces = 1;
  if (start < 0) {
    face.fill(0);
    start = 0;
  } else {
    let id = 0;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (k > 0 && isCorner[i]) id++;
      face[i] = id;
    }
    faces = id + 1;
  }

  // Distance along the perimeter to the nearest corner, both ways round.
  const corner = new Array<number>(n).fill(Infinity);
  for (let i = 0; i < n; i++) if (isCorner[i]) corner[i] = 0;
  if (corner.every((c) => !Number.isFinite(c))) corner.fill(6);
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      const p = (i - 1 + n) % n;
      corner[i] = Math.min(corner[i], corner[p] + len[p]);
    }
    for (let k = n - 1; k >= 0; k--) {
      const i = (start + k) % n;
      const nx = (i + 1) % n;
      corner[i] = Math.min(corner[i], corner[nx] + len[i]);
    }
  }
  for (let i = 0; i < n; i++) corner[i] = Math.min(corner[i], perim);

  return { poly, n, sign, nrm, len, u, corner, face, faces };
}

/** Every edge on the same face as the lot's street-facing one. */
function frontFace(shell: Shell, frontEdge: number): number[] {
  const id = shell.face[frontEdge % shell.n];
  const out: number[] = [];
  for (let i = 0; i < shell.n; i++) if (shell.face[i] === id) out.push(i);
  return out;
}

/* -------------------------------------------------------------------------
 * Vertex buckets
 *
 * One bucket per material. Geometry is written straight into flat arrays and
 * flushed into a chunk every 48k vertices, then the chunks are joined with
 * `mergeGeometries`. Flushing is not ceremony: a quarter of a million
 * triangles in one set of JavaScript arrays is forty megabytes of boxed
 * doubles that the garbage collector then has to walk.
 * ---------------------------------------------------------------------- */

interface Bucket {
  pos: number[];
  nrm: number[];
  uv: number[];
  h: number[];
  base: number[];
  seed: number[];
  tone: number[];
  edge: number[];
  idx: number[];
  verts: number;
  chunks: THREE.BufferGeometry[];
  triangles: number;
  vertices: number;
}

const CHUNK_VERTS = 48000;

function newBucket(): Bucket {
  return {
    pos: [],
    nrm: [],
    uv: [],
    h: [],
    base: [],
    seed: [],
    tone: [],
    edge: [],
    idx: [],
    verts: 0,
    chunks: [],
    triangles: 0,
    vertices: 0,
  };
}

function flushBucket(b: Bucket): void {
  if (b.verts === 0) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(b.nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(b.uv, 2));
  g.setAttribute("aH", new THREE.Float32BufferAttribute(b.h, 1));
  g.setAttribute("aBase", new THREE.Float32BufferAttribute(b.base, 1));
  g.setAttribute("aSeed", new THREE.Float32BufferAttribute(b.seed, 1));
  g.setAttribute("aTone", new THREE.Float32BufferAttribute(b.tone, 1));
  g.setAttribute("aEdge", new THREE.Float32BufferAttribute(b.edge, 1));
  g.setIndex(b.idx);
  b.chunks.push(g);
  b.pos.length = 0;
  b.nrm.length = 0;
  b.uv.length = 0;
  b.h.length = 0;
  b.base.length = 0;
  b.seed.length = 0;
  b.tone.length = 0;
  b.edge.length = 0;
  b.idx.length = 0;
  b.verts = 0;
}

function finishBucket(b: Bucket): THREE.BufferGeometry | null {
  flushBucket(b);
  if (!b.chunks.length) return null;
  const merged = b.chunks.length === 1 ? b.chunks[0] : mergeGeometries(b.chunks, false);
  if (b.chunks.length > 1) for (const c of b.chunks) c.dispose();
  b.chunks.length = 0;
  return merged;
}

/**
 * The pen: four buckets and the state every vertex is stamped with.
 *
 * `baseY` and `span` are the *current object's* foot and height, which is the
 * whole reflection story in two numbers — `aH` and `aBase` come out of them
 * and nothing ever reads world Y.
 */
interface Pen {
  glass: Bucket;
  stone: Bucket;
  pane: Bucket;
  glow: Bucket;
  baseY: number;
  span: number;
  seed: number;
  quality: QualityTier;
  blockers: Blocker[];
  decks: Deck[];
  /** Highest world Y written since `mark()`. */
  top: number;
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

function newPen(quality: QualityTier): Pen {
  return {
    glass: newBucket(),
    stone: newBucket(),
    pane: newBucket(),
    glow: newBucket(),
    baseY: ISLAND_Y,
    span: 1,
    seed: 0,
    quality,
    blockers: [],
    decks: [],
    top: -Infinity,
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
}

function resetBounds(pen: Pen): void {
  pen.top = -Infinity;
  pen.min.x = pen.min.y = pen.min.z = Infinity;
  pen.max.x = pen.max.y = pen.max.z = -Infinity;
}

function vertex(
  pen: Pen,
  b: Bucket,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  u: number,
  v: number,
  tone: number,
  edge: number,
): number {
  b.pos.push(x, y, z);
  b.nrm.push(nx, ny, nz);
  b.uv.push(u, v);
  const rise = y - pen.baseY;
  b.h.push(rise <= 0 ? 0 : rise >= pen.span ? 1 : rise / pen.span);
  b.base.push(rise);
  b.seed.push(pen.seed);
  b.tone.push(tone);
  b.edge.push(edge);
  if (y > pen.top) pen.top = y;
  if (x < pen.min.x) pen.min.x = x;
  if (y < pen.min.y) pen.min.y = y;
  if (z < pen.min.z) pen.min.z = z;
  if (x > pen.max.x) pen.max.x = x;
  if (y > pen.max.y) pen.max.y = y;
  if (z > pen.max.z) pen.max.z = z;
  return b.verts++;
}

/** Four corners, one normal, explicit UVs and edge distances. */
function quad(
  pen: Pen,
  b: Bucket,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
  nx: number, ny: number, nz: number,
  ua: number, va: number,
  ub: number, vb: number,
  uc: number, vc: number,
  ud: number, vd: number,
  tone: number,
  ea: number, eb: number, ec: number, ed: number,
): void {
  if (b.verts + 4 > CHUNK_VERTS) flushBucket(b);
  const i0 = vertex(pen, b, ax, ay, az, nx, ny, nz, ua, va, tone, ea);
  const i1 = vertex(pen, b, bx, by, bz, nx, ny, nz, ub, vb, tone, eb);
  const i2 = vertex(pen, b, cx, cy, cz, nx, ny, nz, uc, vc, tone, ec);
  const i3 = vertex(pen, b, dx, dy, dz, nx, ny, nz, ud, vd, tone, ed);
  b.idx.push(i0, i1, i2, i0, i2, i3);
  b.triangles += 2;
  b.vertices += 4;
}

/**
 * A vertical wall panel from XZ point A to B, between two heights.
 *
 * `u` runs in metres along the wall from `u0`, and `v` in metres above the
 * object's foot, so the shader's mullions and floor lines are real spacings
 * rather than fractions of a slab. That is the difference between a
 * twenty-metre kiosk and a four-hundred-metre spire looking like they were
 * built by the same people.
 */
function panel(
  pen: Pen,
  b: Bucket,
  ax: number, az: number,
  bx: number, bz: number,
  yLo: number, yHi: number,
  nx: number, nz: number,
  u0: number,
  tone: number,
  eA: number, eB: number,
): void {
  const len = Math.hypot(bx - ax, bz - az);
  const u1 = u0 + len;
  const v0 = yLo - pen.baseY;
  const v1 = yHi - pen.baseY;
  quad(
    pen, b,
    ax, yLo, az, bx, yLo, bz, bx, yHi, bz, ax, yHi, az,
    nx, 0, nz,
    u0, v0, u1, v0, u1, v1, u0, v1,
    tone, eA, eB, eB, eA,
  );
}

/** A horizontal quad. `up` is +1 for a roof, -1 for a soffit. */
function slab(
  pen: Pen,
  b: Bucket,
  ax: number, az: number,
  bx: number, bz: number,
  cx: number, cz: number,
  dx: number, dz: number,
  y: number,
  up: number,
  tone: number,
): void {
  quad(
    pen, b,
    ax, y, az, bx, y, bz, cx, y, cz, dx, y, dz,
    0, up, 0,
    ax, az, bx, bz, cx, cz, dx, dz,
    tone, 6, 6, 6, 6,
  );
}

const _cap2 = { pts: [] as THREE.Vector2[] };

/** Triangulated lid over a polygon. Normals are written explicitly. */
function capPoly(pen: Pen, b: Bucket, poly: P2[], y: number, up: number, tone: number): void {
  _cap2.pts.length = 0;
  for (const p of poly) _cap2.pts.push(new THREE.Vector2(p.x, p.z));
  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(_cap2.pts, []);
  } catch {
    return;
  }
  for (const f of faces) {
    if (b.verts + 3 > CHUNK_VERTS) flushBucket(b);
    const ids: number[] = [];
    for (const k of f) {
      const p = poly[k];
      ids.push(vertex(pen, b, p.x, y, p.z, 0, up, 0, p.x, p.z, tone, 6));
    }
    b.idx.push(ids[0], ids[1], ids[2]);
    b.triangles += 1;
    b.vertices += 3;
  }
}

/** Side walls of an extruded polygon, outward-facing. */
function prismWalls(pen: Pen, b: Bucket, shell: Shell, yLo: number, yHi: number, tone: number): void {
  for (let i = 0; i < shell.n; i++) {
    const p = shell.poly[i];
    const q = shell.poly[(i + 1) % shell.n];
    panel(
      pen, b, p.x, p.z, q.x, q.z, yLo, yHi,
      shell.nrm[i].x, shell.nrm[i].z, shell.u[i], tone,
      shell.corner[i], shell.corner[(i + 1) % shell.n],
    );
  }
}

/** Walls plus a lid. The workhorse. */
function prism(pen: Pen, b: Bucket, poly: P2[], yLo: number, yHi: number, tone: number, lid = true): Shell {
  const shell = shellOf(poly);
  prismWalls(pen, b, shell, yLo, yHi, tone);
  if (lid) capPoly(pen, b, poly, yHi, 1, tone);
  return shell;
}

/** An axis-aligned box, optionally spun about Y. Railings, steps, masts, vents. */
function boxAt(
  pen: Pen,
  b: Bucket,
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
  rot: number,
  tone: number,
): void {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const px = (dx: number, dz: number) => cx + dx * c - dz * s;
  const pz = (dx: number, dz: number) => cz + dx * s + dz * c;
  const corners: Array<[number, number]> = [
    [-hx, -hz],
    [hx, -hz],
    [hx, hz],
    [-hx, hz],
  ];
  const y0 = cy - hy;
  const y1 = cy + hy;
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i];
    const [bx, bz] = corners[(i + 1) % 4];
    const ex = bx - ax;
    const ez = bz - az;
    const l = Math.hypot(ex, ez) || 1;
    const nlx = ez / l;
    const nlz = -ex / l;
    panel(
      pen, b, px(ax, az), pz(ax, az), px(bx, bz), pz(bx, bz), y0, y1,
      nlx * c - nlz * s, nlx * s + nlz * c, 0, tone, 0, 0,
    );
  }
  const top: P2[] = corners.map(([dx, dz]) => ({ x: px(dx, dz), z: pz(dx, dz) }));
  slab(pen, b, top[0].x, top[0].z, top[1].x, top[1].z, top[2].x, top[2].z, top[3].x, top[3].z, y1, 1, tone);
  slab(pen, b, top[3].x, top[3].z, top[2].x, top[2].z, top[1].x, top[1].z, top[0].x, top[0].z, y0, -1, tone);
}

/** A faceted cone/cylinder about a vertical axis. Masts, columns, drums. */
function tube(
  pen: Pen,
  b: Bucket,
  cx: number, cz: number,
  r0: number, r1: number,
  y0: number, y1: number,
  sides: number,
  tone: number,
  lid = true,
  phase = 0,
): void {
  for (let i = 0; i < sides; i++) {
    const a0 = phase + (i / sides) * TAU;
    const a1 = phase + ((i + 1) / sides) * TAU;
    const am = (a0 + a1) / 2;
    const x0 = cx + Math.cos(a0) * r0;
    const z0 = cz + Math.sin(a0) * r0;
    const x1 = cx + Math.cos(a1) * r0;
    const z1 = cz + Math.sin(a1) * r0;
    const x2 = cx + Math.cos(a1) * r1;
    const z2 = cz + Math.sin(a1) * r1;
    const x3 = cx + Math.cos(a0) * r1;
    const z3 = cz + Math.sin(a0) * r1;
    const u0 = ((i / sides) * TAU * Math.max(r0, r1));
    const u1 = (((i + 1) / sides) * TAU * Math.max(r0, r1));
    quad(
      pen, b,
      x0, y0, z0, x1, y0, z1, x2, y1, z2, x3, y1, z3,
      Math.cos(am), 0, Math.sin(am),
      u0, y0 - pen.baseY, u1, y0 - pen.baseY, u1, y1 - pen.baseY, u0, y1 - pen.baseY,
      tone, 0.4, 0.4, 0.4, 0.4,
    );
  }
  if (lid && r1 > 0.01) {
    const ring: P2[] = [];
    for (let i = 0; i < sides; i++) {
      const a = phase + (i / sides) * TAU;
      ring.push({ x: cx + Math.cos(a) * r1, z: cz + Math.sin(a) * r1 });
    }
    capPoly(pen, b, ring, y1, 1, tone);
  }
}

/** A shallow faceted dome. The Observatory, and nothing else so far. */
function dome(
  pen: Pen,
  b: Bucket,
  cx: number, cy: number, cz: number,
  r: number,
  rings: number,
  sides: number,
  tone: number,
  slot?: { from: number; to: number },
): void {
  for (let i = 0; i < rings; i++) {
    const t0 = i / rings;
    const t1 = (i + 1) / rings;
    const p0 = (t0 * Math.PI) / 2;
    const p1 = (t1 * Math.PI) / 2;
    const r0 = Math.cos(p0) * r;
    const r1 = Math.cos(p1) * r;
    const y0 = cy + Math.sin(p0) * r * 0.82;
    const y1 = cy + Math.sin(p1) * r * 0.82;
    for (let j = 0; j < sides; j++) {
      const a0 = (j / sides) * TAU;
      const a1 = ((j + 1) / sides) * TAU;
      if (slot) {
        const mid = (a0 + a1) / 2;
        if (mid > slot.from && mid < slot.to) continue;
      }
      const am = (a0 + a1) / 2;
      const pm = (p0 + p1) / 2;
      quad(
        pen, b,
        cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0,
        cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0,
        cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1,
        cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1,
        Math.cos(am) * Math.cos(pm), Math.sin(pm), Math.sin(am) * Math.cos(pm),
        a0 * r, y0 - pen.baseY, a1 * r, y0 - pen.baseY, a1 * r, y1 - pen.baseY, a0 * r, y1 - pen.baseY,
        tone, 3, 3, 3, 3,
      );
    }
  }
}

/**
 * A strip of light on a wall, standing two centimetres proud of it.
 *
 * Additive, and driven by `uDaylight` — this is what switches on at dusk. Two
 * centimetres because the reflected copy is the same geometry mirrored, and
 * anything coplanar z-fights in one of the two views.
 */
function glowStrip(
  pen: Pen,
  ax: number, az: number,
  bx: number, bz: number,
  yLo: number, yHi: number,
  nx: number, nz: number,
  tint: number,
): void {
  const ox = nx * 0.03;
  const oz = nz * 0.03;
  quad(
    pen, pen.glow,
    ax + ox, yLo, az + oz, bx + ox, yLo, bz + oz, bx + ox, yHi, bz + oz, ax + ox, yHi, az + oz,
    nx, 0, nz,
    0, 0, 1, 0, 1, 1, 0, 1,
    tint, 1, 1, 1, 1,
  );
}

/* -------------------------------------------------------------------------
 * Shaders
 *
 * Four fragment programs over one vertex program. Every one of them reads
 * `vH` / `vBase` — the object's own height — and never `vWPos.y`, which is
 * the single rule that makes the lake reflection correct.
 * ---------------------------------------------------------------------- */

const VERT = /* glsl */ `
attribute float aH;
attribute float aBase;
attribute float aSeed;
attribute float aTone;
attribute float aEdge;
varying float vH;
varying float vBase;
varying float vSeed;
varying float vTone;
varying float vEdge;
varying vec2 vUv;
varying vec3 vNrm;
varying vec3 vWPos;
void main() {
  vH = aH;
  vBase = aBase;
  vSeed = aSeed;
  vTone = aTone;
  vEdge = aEdge;
  vUv = uv;
  vNrm = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/**
 * The sky, cut down to what a reflection needs — the same stops `sky.ts`
 * paints. This is the single thing that makes glass read as glass rather than
 * as painted concrete: without it a slab is its own gradient and nothing else,
 * and from the plaza the city is a canyon of pink corduroy.
 */
const SKY_CHUNK = /* glsl */ `
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}
vec3 skyColor(vec3 rd, vec3 sun) {
  float t = clamp(rd.y, 0.0, 1.0);
  float sunAmt = clamp(dot(rd, sun) * 0.5 + 0.5, 0.0, 1.0);
  vec3 cRose   = vec3(1.00, 0.44, 0.60);
  vec3 cOrange = vec3(1.00, 0.56, 0.26);
  vec3 cGold   = vec3(1.00, 0.84, 0.40);
  vec3 cJade   = vec3(0.22, 0.82, 0.72);
  vec3 cSky    = vec3(0.07, 0.30, 0.72);
  vec3 cNavy   = vec3(0.020, 0.040, 0.175);
  vec3 c = mix(cOrange, cGold, smoothstep(0.010, 0.070, t));
  c = mix(c, cJade, smoothstep(0.050, 0.155, t));
  c = mix(c, cSky,  smoothstep(0.185, 0.400, t));
  c = mix(c, cNavy, smoothstep(0.360, 0.820, t));
  float low = 1.0 - smoothstep(0.0, 0.42, t);
  c = mix(c, cRose, low * (1.0 - sunAmt) * 0.62);
  c = mix(c, cGold * 1.10, low * pow(sunAmt, 2.2) * 0.75);
  c = mix(c, vec3(0.72, 0.62, 0.70), smoothstep(0.0, -0.28, rd.y) * 0.85);
  c += vec3(1.0, 0.72, 0.44) * pow(max(dot(rd, sun), 0.0), 70.0) * 1.1;
  return c;
}
`;

const HEAD = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uDaylight;
uniform vec3 uCam;
uniform vec3 uSun;
varying float vH;
varying float vBase;
varying float vSeed;
varying float vTone;
varying float vEdge;
varying vec2 vUv;
varying vec3 vNrm;
varying vec3 vWPos;
`;

/**
 * Curtain wall. Unlit on purpose — the towers in the reference are not
 * surfaces catching a sunset, they are columns of colour with the light
 * coming through them, and a standard material under a low sun gives two
 * bright faces and two black ones.
 *
 * Everything that was learned the hard way in `citadel.ts` is kept: the amber
 * lower stops rather than crimson (from the plaza, crimson is fuchsia), the
 * analytic sky in the glass at every range, and the fresnel lip faded out
 * inside thirty-five metres, because it is a silhouette effect and the first
 * build's opening frame was a white wall for want of that one smoothstep.
 *
 * What is new here is that the floors are real. `vBase` is metres, so a floor
 * line is every 3.9 m on a 90 m tower and on a 400 m one alike.
 */
const GLASS_FRAG = HEAD + SKY_CHUNK + /* glsl */ `
void main() {
  float s = vSeed;
  float warmth = hash11(s * 7.13);
  float cool   = hash11(s * 3.71 + 2.0);

  vec3 cFoot  = mix(vec3(0.10, 0.05, 0.11), vec3(0.16, 0.07, 0.09), warmth);
  vec3 cLow   = mix(vec3(1.00, 0.56, 0.30), vec3(0.92, 0.40, 0.40), warmth);
  vec3 cMid   = mix(vec3(1.00, 0.88, 0.66), vec3(1.00, 0.74, 0.74), warmth);
  vec3 cUpper = mix(vec3(0.30, 0.80, 1.00), vec3(0.66, 0.55, 1.00), cool);
  vec3 cTop   = mix(vec3(0.72, 0.92, 1.00), vec3(0.36, 0.50, 0.98), cool);

  float h = clamp(vH, 0.0, 1.0);
  float breakpoint = mix(0.42, 0.74, hash11(s * 11.7));
  vec3 col = mix(cFoot, cLow, smoothstep(0.0, 0.10, h));
  col = mix(col, cMid,   smoothstep(0.06, breakpoint, h));
  col = mix(col, cUpper, smoothstep(breakpoint, breakpoint + 0.30, h));
  col = mix(col, cTop,   smoothstep(0.80, 1.0, h));

  /* Real floors, in metres, with a spandrel panel under each one. */
  float fh = 3.7 + hash11(s * 5.5) * 0.8;
  float fl = fract(vBase / fh);
  col *= 0.86 + 0.22 * smoothstep(0.06, 0.30, fl);
  col *= 1.0 - 0.16 * smoothstep(0.90, 1.0, fl);

  /* Mullions every 2.6 m, and a structural belt every eighth floor. */
  float mull = abs(fract(vUv.x / 2.6) - 0.5) * 2.0;
  col *= 0.90 + 0.16 * mull;
  float belt = abs(fract(vBase / (fh * 8.0)) - 0.5) * 2.0;
  col *= mix(1.0, 0.72, smoothstep(0.94, 1.0, belt));

  /* Corner light: the lip that separates fifty overlapping slabs. */
  float corner = 1.0 - smoothstep(0.0, 1.5, vEdge);
  col += col * corner * 0.30;

  /* Lit windows. Sparse by day, most of the building by night. */
  vec2 cell = vec2(floor(vUv.x / 2.6), floor(vBase / fh));
  float r = hash11(cell.x * 31.7 + cell.y * 7.3 + s);
  float lit = step(mix(0.42, 0.955, uDaylight), r);
  col += vec3(1.0, 0.78, 0.42) * lit * (0.30 + 0.60 * (1.0 - uDaylight))
       * (1.0 - smoothstep(0.55, 0.98, h)) * 0.55;

  /* A dark foot for the first few metres of glass, in metres not fractions. */
  col = mix(cFoot * 1.5, col, smoothstep(0.5, 7.0, vBase));

  vec3 toEye = uCam - vWPos;
  float dist = length(toEye);
  vec3 V = toEye / max(dist, 0.001);
  vec3 N = normalize(vNrm);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.6);

  vec3 env = skyColor(reflect(-V, N), normalize(uSun));
  col = mix(col, env * 0.86, 0.12 + 0.42 * fres);

  col += mix(vec3(0.45, 0.85, 1.0), vec3(1.0, 0.72, 0.85), warmth)
       * fres * smoothstep(35.0, 220.0, dist) * 0.85;

  col *= mix(0.42, 1.0, uDaylight);
  col *= 0.94 + 0.06 * sin(uTime * 0.5 + s * 6.28);
  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Everything opaque: plinths, masonry, panels, copper, timber, hedges.
 *
 * Lit rather than emissive, because a wall you are standing next to has to
 * turn a corner. The sun is nine degrees above the horizon, so the direct
 * term rakes sideways and almost all of the fill comes from two ambients: the
 * sunset dome above and the frozen lake bouncing up from underneath. The
 * `vBase` contact shade is what keeps a street from looking like it was cut
 * out and pasted onto the pavement.
 */
const STONE_FRAG = HEAD + SKY_CHUNK + /* glsl */ `
vec3 toneColor(float t, float s) {
  float w = hash11(s * 4.13 + t * 1.7);
  if (t < 0.5) return mix(vec3(0.88, 0.80, 0.68), vec3(0.80, 0.71, 0.63), w);
  if (t < 1.5) return mix(vec3(0.21, 0.17, 0.20), vec3(0.28, 0.22, 0.22), w);
  if (t < 2.5) return mix(vec3(0.84, 0.47, 0.31), vec3(0.90, 0.66, 0.44), w);
  if (t < 3.5) return mix(vec3(0.33, 0.63, 0.57), vec3(0.44, 0.72, 0.62), w);
  if (t < 4.5) return mix(vec3(0.52, 0.33, 0.21), vec3(0.64, 0.45, 0.28), w);
  if (t < 5.5) return mix(vec3(0.20, 0.42, 0.23), vec3(0.36, 0.58, 0.29), w);
  return mix(vec3(0.74, 0.72, 0.72), vec3(0.83, 0.80, 0.77), w);
}

void main() {
  vec3 N = normalize(vNrm);
  vec3 base = toneColor(vTone, vSeed);

  /* Coursing and joints, on the stony tones only. Copper and foliage get
     their own grain instead — a hedge with ashlar joints in it is a very
     particular kind of wrong. */
  float stony = step(vTone, 2.5) + step(5.5, vTone);
  float course = abs(fract(vBase / 0.95) - 0.5) * 2.0;
  float joint  = abs(fract(vUv.x / 1.55) - 0.5) * 2.0;
  float mortar = min(smoothstep(0.03, 0.24, course), smoothstep(0.03, 0.18, joint));
  base *= mix(1.0, 0.88 + 0.18 * mortar, clamp(stony, 0.0, 1.0));

  float leafy = step(4.5, vTone) * step(vTone, 5.5);
  float rough = hash11(floor(vUv.x * 1.7) * 3.1 + floor(vBase * 1.9) * 7.7 + vSeed);
  base *= mix(1.0, 0.78 + 0.44 * rough, leafy);

  float coppery = step(2.5, vTone) * step(vTone, 3.5);
  float seam = abs(fract(vUv.x / 0.62) - 0.5) * 2.0;
  base *= mix(1.0, 0.92 + 0.14 * smoothstep(0.0, 0.35, seam), coppery);

  vec3 L = normalize(uSun);
  float ndl = dot(N, L);
  float up = clamp(N.y, 0.0, 1.0);
  float dn = clamp(-N.y, 0.0, 1.0);
  vec3 skyAmb = vec3(0.34, 0.40, 0.68) * (0.20 + 0.52 * up);
  vec3 iceAmb = vec3(0.64, 0.47, 0.54) * (0.09 + 0.32 * dn);
  vec3 col = base * (skyAmb + iceAmb + vec3(1.10, 0.66, 0.36) * max(ndl, 0.0) * 1.20);
  col += base * vec3(1.0, 0.60, 0.34) * pow(max(ndl, 0.0), 4.0) * 0.35;

  /* Contact shade. Measured in metres above this building's own foot, so a
     kiosk and a spire both get exactly one storey of it. */
  col *= 0.55 + 0.45 * smoothstep(0.0, 5.5, vBase);

  vec3 toEye = uCam - vWPos;
  float dist = length(toEye);
  vec3 V = toEye / max(dist, 0.001);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.2);
  col += vec3(1.0, 0.72, 0.62) * fres * 0.22 * smoothstep(30.0, 260.0, dist);

  /* Night: cold everywhere, warm where the street lamps reach. */
  col = mix(col * vec3(0.26, 0.28, 0.42), col, uDaylight);
  col += vec3(1.0, 0.55, 0.22) * (1.0 - uDaylight)
       * (1.0 - smoothstep(0.0, 15.0, vBase)) * 0.34 * (0.35 + 0.65 * up);

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Glazing set into a reveal: shop windows, punched windows, doorways.
 *
 * Opaque, and unapologetic about it. A transparent pane needs sorting against
 * two hundred thousand triangles and buys a view of an interior that is not
 * modelled; a dark pane with the sky in it and a light behind it after dusk
 * is what a window looks like from the street anyway.
 *
 * `vUv` is 0..1 across the pane here rather than metres, and `vEdge` carries
 * how many vertical divisions the pane wants.
 */
const PANE_FRAG = HEAD + SKY_CHUNK + /* glsl */ `
void main() {
  vec3 N = normalize(vNrm);
  vec3 V = normalize(uCam - vWPos);
  vec3 env = skyColor(reflect(-V, N), normalize(uSun));

  float shop = step(0.5, vTone) * step(vTone, 1.5);
  float dark = step(1.5, vTone);

  float r = hash11(vSeed * 91.7 + floor(vUv.x * 3.0) * 13.1 + floor(vBase * 0.31) * 5.3);
  float on = step(mix(0.55, 0.08, shop), r) * (1.0 - dark);
  vec3 warm = mix(vec3(1.00, 0.66, 0.32), vec3(1.00, 0.86, 0.60), hash11(vSeed * 5.9 + r));

  vec3 day = env * mix(0.52, 0.30, shop) + vec3(0.02, 0.025, 0.045);
  vec3 night = mix(vec3(0.02, 0.025, 0.05), warm * mix(1.4, 2.2, shop), on);
  vec3 col = mix(night, day + warm * on * mix(0.10, 0.55, shop), smoothstep(0.05, 0.55, uDaylight));

  /* A room behind the glass rather than a mirror: darker toward the head,
     brighter at the sill where the floor catches the light. */
  col *= mix(1.18, 0.74, vUv.y);
  /* Transoms and glazing bars. */
  float bar = abs(fract(vUv.x * max(vEdge, 1.0)) - 0.5) * 2.0;
  col *= 0.84 + 0.20 * smoothstep(0.0, 0.28, bar);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  col = mix(col, env * 0.8, fres * 0.45);

  gl_FragColor = vec4(col, 1.0);
}
`;

/** Cornice strips, signage, crown lights, the Beacon's lantern. */
const GLOW_FRAG = HEAD + /* glsl */ `
void main() {
  vec3 warm  = vec3(1.00, 0.62, 0.26);
  vec3 cool  = vec3(0.42, 0.82, 1.00);
  vec3 white = vec3(1.00, 0.92, 0.82);
  vec3 tint = mix(warm, cool, step(0.5, vTone) * step(vTone, 1.5));
  tint = mix(tint, white, step(1.5, vTone));
  float band = 1.0 - abs(vUv.y - 0.5) * 2.0;
  float a = smoothstep(0.0, 0.9, band);
  float night = 1.0 - smoothstep(0.06, 0.62, uDaylight);
  float flick = 0.94 + 0.06 * sin(uTime * 1.7 + vSeed * 6.28);
  gl_FragColor = vec4(tint * a * (0.25 + 1.9 * night) * flick, 1.0);
}
`;

/* -------------------------------------------------------------------------
 * Facades
 *
 * A window is not a pane stuck on a wall. Four reveal faces and a pane at the
 * bottom of them is what catches a low sun and puts a hard shadow line down
 * one side of every opening, and at 1.8 m on the pavement it is the whole
 * difference between a building and a billboard. Which means the wall has to
 * have a hole in it: the surround is emitted as four strips around the
 * opening rather than as one quad behind it.
 * ---------------------------------------------------------------------- */

/** One edge of a footprint, resolved into everything a facade needs. */
interface Face {
  ax: number;
  az: number;
  /** Unit tangent from A toward B. */
  tx: number;
  tz: number;
  /** Outward unit normal. */
  nx: number;
  nz: number;
  len: number;
  /** Perimeter parameter at A, for continuous mullions. */
  u0: number;
  eA: number;
  eB: number;
}

function faceOf(shell: Shell, i: number): Face {
  const p = shell.poly[i];
  const q = shell.poly[(i + 1) % shell.n];
  const len = shell.len[i] || 1;
  return {
    ax: p.x,
    az: p.z,
    tx: (q.x - p.x) / len,
    tz: (q.z - p.z) / len,
    nx: shell.nrm[i].x,
    nz: shell.nrm[i].z,
    len,
    u0: shell.u[i],
    eA: shell.corner[i],
    eB: shell.corner[(i + 1) % shell.n],
  };
}

/** Point on a face at arclength `s`, pushed `d` metres outward. */
function fx(f: Face, s: number, d = 0): number {
  return f.ax + f.tx * s + f.nx * d;
}
function fz(f: Face, s: number, d = 0): number {
  return f.az + f.tz * s + f.nz * d;
}

/** A plain rectangle of wall between two arclengths. */
function wallSpan(pen: Pen, b: Bucket, f: Face, s0: number, s1: number, yLo: number, yHi: number, tone: number): void {
  if (s1 - s0 < 1e-3 || yHi - yLo < 1e-3) return;
  const eA = f.eA + (f.eB - f.eA) * (s0 / f.len);
  const eB = f.eA + (f.eB - f.eA) * (s1 / f.len);
  panel(pen, b, fx(f, s0), fz(f, s0), fx(f, s1), fz(f, s1), yLo, yHi, f.nx, f.nz, f.u0 + s0, tone, eA, eB);
}

/**
 * An opening set into a wall: jambs, head, sill and the glazing at the back
 * of the recess. The surrounding wall is emitted as four strips so there is
 * an actual hole rather than a decal.
 */
function opening(
  pen: Pen,
  f: Face,
  cellS0: number, cellS1: number,
  cellY0: number, cellY1: number,
  s0: number, s1: number,
  y0: number, y1: number,
  depth: number,
  wallTone: number,
  paneKind: number,
  divisions: number,
): void {
  const b = pen.stone;
  /* The wall around the hole. */
  wallSpan(pen, b, f, cellS0, s0, cellY0, cellY1, wallTone);
  wallSpan(pen, b, f, s1, cellS1, cellY0, cellY1, wallTone);
  wallSpan(pen, b, f, s0, s1, cellY0, y0, wallTone);
  wallSpan(pen, b, f, s0, s1, y1, cellY1, wallTone);

  /* Reveals. Jambs face each other, the head faces down, the sill faces up
     and is tilted a hair outward so it reads as a sill and not as a shelf. */
  const jamb = (s: number, dir: number) => {
    quad(
      pen, b,
      fx(f, s), y0, fz(f, s), fx(f, s, -depth), y0, fz(f, s, -depth),
      fx(f, s, -depth), y1, fz(f, s, -depth), fx(f, s), y1, fz(f, s),
      f.tx * dir, 0, f.tz * dir,
      0, y0 - pen.baseY, depth, y0 - pen.baseY, depth, y1 - pen.baseY, 0, y1 - pen.baseY,
      wallTone, 0, 0, 0, 0,
    );
  };
  jamb(s0, 1);
  jamb(s1, -1);
  quad(
    pen, b,
    fx(f, s0), y1, fz(f, s0), fx(f, s1), y1, fz(f, s1),
    fx(f, s1, -depth), y1, fz(f, s1, -depth), fx(f, s0, -depth), y1, fz(f, s0, -depth),
    0, -1, 0,
    0, 0, s1 - s0, 0, s1 - s0, depth, 0, depth,
    wallTone, 0, 0, 0, 0,
  );
  quad(
    pen, b,
    fx(f, s0, -depth), y0, fz(f, s0, -depth), fx(f, s1, -depth), y0, fz(f, s1, -depth),
    fx(f, s1, 0.06), y0 - 0.04, fz(f, s1, 0.06), fx(f, s0, 0.06), y0 - 0.04, fz(f, s0, 0.06),
    0, 1, 0,
    0, 0, s1 - s0, 0, s1 - s0, depth, 0, depth,
    wallTone, 0, 0, 0, 0,
  );

  /* The glazing, at the back of the recess. */
  quad(
    pen, pen.pane,
    fx(f, s0, -depth), y0, fz(f, s0, -depth), fx(f, s1, -depth), y0, fz(f, s1, -depth),
    fx(f, s1, -depth), y1, fz(f, s1, -depth), fx(f, s0, -depth), y1, fz(f, s0, -depth),
    f.nx, 0, f.nz,
    0, 0, 1, 0, 1, 1, 0, 1,
    paneKind, divisions, divisions, divisions, divisions,
  );
}

interface FacadeOpts {
  floorH: number;
  bayW: number;
  winW: number;
  winH: number;
  /** Opening bottom above the floor line. */
  sill: number;
  depth: number;
  tone: number;
  paneKind: number;
  /** False → one flat quad, no openings. The low tier, and back walls. */
  detail: boolean;
}

/** A storeyed facade on one edge, punched with windows. */
function facade(pen: Pen, f: Face, yLo: number, yHi: number, o: FacadeOpts): void {
  const h = yHi - yLo;
  if (!o.detail || h < o.floorH * 0.9 || f.len < 2.6) {
    wallSpan(pen, pen.stone, f, 0, f.len, yLo, yHi, o.tone);
    return;
  }
  const nF = Math.max(1, Math.round(h / o.floorH));
  const fh = h / nF;
  const nB = Math.max(1, Math.round(f.len / o.bayW));
  const bw = f.len / nB;
  const winW = Math.min(o.winW, bw - 1.0);
  const winH = Math.min(o.winH, fh - o.sill - 0.55);
  if (winW < 0.7 || winH < 0.7) {
    wallSpan(pen, pen.stone, f, 0, f.len, yLo, yHi, o.tone);
    return;
  }
  for (let ff = 0; ff < nF; ff++) {
    const cy0 = yLo + ff * fh;
    const cy1 = cy0 + fh;
    for (let bb = 0; bb < nB; bb++) {
      const cs0 = bb * bw;
      const cs1 = cs0 + bw;
      const cs = (cs0 + cs1) / 2;
      opening(
        pen, f, cs0, cs1, cy0, cy1,
        cs - winW / 2, cs + winW / 2,
        cy0 + o.sill, cy0 + o.sill + winH,
        o.depth, o.tone, o.paneKind,
        winW > 2.2 ? 2 : 1,
      );
    }
  }
}

/**
 * The ground floor on the street-facing side: stall riser, pilasters, glazing
 * with a real sill, a recessed doorway at the doorstep, a fascia above.
 *
 * Nothing here projects more than 0.30 m between 2.6 m and 4.0 m, which is
 * where `props.ts` hangs the awnings.
 */
function shopfront(
  pen: Pen,
  f: Face,
  yLo: number,
  height: number,
  doorAt: number | null,
  frameTone: number,
  bodyTone: number,
): void {
  const b = pen.stone;
  const RISER = 0.62;
  const HEAD = Math.min(height - 0.95, 3.55);
  const FASCIA = height - 0.85;
  const bays = Math.max(1, Math.round(f.len / 3.9));
  const bw = f.len / bays;
  const PIER = Math.min(0.55, bw * 0.18);

  /* Stall riser, in dark stone, standing a little proud. */
  wallSpan(pen, b, f, 0, f.len, yLo, yLo + RISER, T_BASALT);
  quad(
    pen, b,
    fx(f, 0, 0.1), yLo, fz(f, 0, 0.1), fx(f, f.len, 0.1), yLo, fz(f, f.len, 0.1),
    fx(f, f.len, 0.1), yLo + RISER, fz(f, f.len, 0.1), fx(f, 0, 0.1), yLo + RISER, fz(f, 0, 0.1),
    f.nx, 0, f.nz, f.u0, 0, f.u0 + f.len, 0, f.u0 + f.len, RISER, f.u0, RISER,
    T_BASALT, f.eA, f.eB, f.eB, f.eA,
  );

  let doorBay = -1;
  if (doorAt !== null) doorBay = Math.min(bays - 1, Math.max(0, Math.floor(doorAt / bw)));

  for (let i = 0; i < bays; i++) {
    const s0 = i * bw;
    const s1 = s0 + bw;
    /* Pilaster at each bay edge, 0.22 m proud — an awning still clears it. */
    for (const s of [s0, s1]) {
      if (s > 0 && s < f.len - 0.01 && s !== s0) continue;
      const a = Math.max(0, s - PIER / 2);
      const c = Math.min(f.len, s + PIER / 2);
      wallSpan(pen, b, f, a, c, yLo, FASCIA, frameTone);
      quad(
        pen, b,
        fx(f, a, 0.22), yLo, fz(f, a, 0.22), fx(f, c, 0.22), yLo, fz(f, c, 0.22),
        fx(f, c, 0.22), FASCIA, fz(f, c, 0.22), fx(f, a, 0.22), FASCIA, fz(f, a, 0.22),
        f.nx, 0, f.nz, 0, 0, c - a, 0, c - a, FASCIA - yLo, 0, FASCIA - yLo,
        frameTone, 0, 0, 0, 0,
      );
    }
    if (i === bays - 1) {
      const a = Math.max(0, f.len - PIER);
      wallSpan(pen, b, f, a, f.len, yLo, FASCIA, frameTone);
    }

    const g0 = s0 + PIER / 2 + 0.08;
    const g1 = s1 - PIER / 2 - 0.08;
    if (g1 - g0 < 0.7) {
      wallSpan(pen, b, f, g0, g1, yLo, FASCIA, frameTone);
      continue;
    }

    if (i === doorBay) {
      /* The doorway: deeper, taller, floor to head, with a transom over it. */
      const dw = Math.min(2.2, g1 - g0);
      const dc = (g0 + g1) / 2;
      const d0 = dc - dw / 2;
      const d1 = dc + dw / 2;
      wallSpan(pen, b, f, g0, d0, yLo, FASCIA, frameTone);
      wallSpan(pen, b, f, d1, g1, yLo, FASCIA, frameTone);
      opening(pen, f, d0, d1, yLo, FASCIA, d0, d1, yLo + 0.03, yLo + 2.45, 0.85, frameTone, P_DARK, 2);
      opening(pen, f, d0, d1, yLo + 2.45, FASCIA, d0 + 0.12, d1 - 0.12, yLo + 2.62, Math.min(HEAD, FASCIA - 0.25), 0.35, frameTone, P_SHOP, 2);
      /* Threshold, so the door meets the pavement rather than hovering. */
      boxAt(pen, b, fx(f, dc, 0.28), yLo + 0.05, fz(f, dc, 0.28), dw / 2 + 0.15, 0.05, 0.32,
        Math.atan2(f.tz, f.tx), T_BASALT);
      continue;
    }

    /* Glazing: sill at the riser, head under the fascia. */
    wallSpan(pen, b, f, g0, g1, yLo, yLo + RISER, frameTone);
    wallSpan(pen, b, f, g0, g1, HEAD, FASCIA, frameTone);
    quad(
      pen, pen.pane,
      fx(f, g0, -0.28), yLo + RISER, fz(f, g0, -0.28), fx(f, g1, -0.28), yLo + RISER, fz(f, g1, -0.28),
      fx(f, g1, -0.28), HEAD, fz(f, g1, -0.28), fx(f, g0, -0.28), HEAD, fz(f, g0, -0.28),
      f.nx, 0, f.nz, 0, 0, 1, 0, 1, 1, 0, 1,
      P_SHOP, Math.max(2, Math.round((g1 - g0) / 1.3)), Math.max(2, Math.round((g1 - g0) / 1.3)),
      Math.max(2, Math.round((g1 - g0) / 1.3)), Math.max(2, Math.round((g1 - g0) / 1.3)),
    );
    /* Reveals around the glazing, and a sill that sheds water outward. */
    const rev = (s: number, dir: number) => {
      quad(
        pen, b,
        fx(f, s), yLo + RISER, fz(f, s), fx(f, s, -0.28), yLo + RISER, fz(f, s, -0.28),
        fx(f, s, -0.28), HEAD, fz(f, s, -0.28), fx(f, s), HEAD, fz(f, s),
        f.tx * dir, 0, f.tz * dir, 0, 0, 0.28, 0, 0.28, HEAD - yLo, 0, HEAD - yLo,
        frameTone, 0, 0, 0, 0,
      );
    };
    rev(g0, 1);
    rev(g1, -1);
    quad(
      pen, b,
      fx(f, g0, -0.28), yLo + RISER, fz(f, g0, -0.28), fx(f, g1, -0.28), yLo + RISER, fz(f, g1, -0.28),
      fx(f, g1, 0.16), yLo + RISER - 0.05, fz(f, g1, 0.16), fx(f, g0, 0.16), yLo + RISER - 0.05, fz(f, g0, 0.16),
      0, 1, 0, 0, 0, g1 - g0, 0, g1 - g0, 0.44, 0, 0.44, frameTone, 0, 0, 0, 0,
    );
    quad(
      pen, b,
      fx(f, g0), HEAD, fz(f, g0), fx(f, g1), HEAD, fz(f, g1),
      fx(f, g1, -0.28), HEAD, fz(f, g1, -0.28), fx(f, g0, -0.28), HEAD, fz(f, g0, -0.28),
      0, -1, 0, 0, 0, g1 - g0, 0, g1 - g0, 0.28, 0, 0.28, frameTone, 0, 0, 0, 0,
    );
  }

  /* Fascia: the signboard, projecting 0.30, with a lit strip on its face. */
  const fasciaTop = yLo + height;
  wallSpan(pen, b, f, 0, f.len, FASCIA, fasciaTop, bodyTone);
  quad(
    pen, b,
    fx(f, 0, 0.3), FASCIA, fz(f, 0, 0.3), fx(f, f.len, 0.3), FASCIA, fz(f, f.len, 0.3),
    fx(f, f.len, 0.3), fasciaTop, fz(f, f.len, 0.3), fx(f, 0, 0.3), fasciaTop, fz(f, 0, 0.3),
    f.nx, 0, f.nz, f.u0, 0, f.u0 + f.len, 0, f.u0 + f.len, fasciaTop - FASCIA, f.u0, fasciaTop - FASCIA,
    bodyTone, f.eA, f.eB, f.eB, f.eA,
  );
  quad(
    pen, b,
    fx(f, 0, 0.3), fasciaTop, fz(f, 0, 0.3), fx(f, f.len, 0.3), fasciaTop, fz(f, f.len, 0.3),
    fx(f, f.len, 0), fasciaTop, fz(f, f.len, 0), fx(f, 0, 0), fasciaTop, fz(f, 0, 0),
    0, 1, 0, 0, 0, f.len, 0, f.len, 0.3, 0, 0.3, bodyTone, 6, 6, 6, 6,
  );
  quad(
    pen, b,
    fx(f, 0, 0), FASCIA, fz(f, 0, 0), fx(f, f.len, 0), FASCIA, fz(f, f.len, 0),
    fx(f, f.len, 0.3), FASCIA, fz(f, f.len, 0.3), fx(f, 0, 0.3), FASCIA, fz(f, 0, 0.3),
    0, -1, 0, 0, 0, f.len, 0, f.len, 0.3, 0, 0.3, bodyTone, 6, 6, 6, 6,
  );
  if (pen.quality === "high") {
    glowStrip(pen, fx(f, 0.4, 0.31), fz(f, 0.4, 0.31), fx(f, f.len - 0.4, 0.31), fz(f, f.len - 0.4, 0.31),
      FASCIA + 0.18, fasciaTop - 0.18, f.nx, f.nz, G_WARM);
  }
}

/**
 * A cornice: a band standing proud of the wall with a soffit under it and a
 * lit strip tucked into the shadow. Also does the job of a plinth cap and a
 * setback parapet coping.
 */
function cornice(pen: Pen, shell: Shell, y: number, height: number, out: number, tone: number, lit: boolean): void {
  const wide = offsetPoly(shell.poly, -out);
  if (!wide) {
    prismWalls(pen, pen.stone, shell, y, y + height, tone);
    return;
  }
  const outer = shellOf(wide);
  prismWalls(pen, pen.stone, outer, y, y + height, tone);
  for (let i = 0; i < shell.n; i++) {
    const p = shell.poly[i];
    const q = shell.poly[(i + 1) % shell.n];
    const P = wide[i];
    const Q = wide[(i + 1) % shell.n];
    slab(pen, pen.stone, p.x, p.z, q.x, q.z, Q.x, Q.z, P.x, P.z, y, -1, tone);
    slab(pen, pen.stone, P.x, P.z, Q.x, Q.z, q.x, q.z, p.x, p.z, y + height, 1, tone);
    if (lit && pen.quality === "high") {
      glowStrip(pen, p.x + outer.nrm[i].x * (out - 0.05), p.z + outer.nrm[i].z * (out - 0.05),
        q.x + outer.nrm[i].x * (out - 0.05), q.z + outer.nrm[i].z * (out - 0.05),
        y - 0.5, y - 0.05, outer.nrm[i].x, outer.nrm[i].z, G_WARM);
    }
  }
}

/** A hollow wall around a lot: garden boundaries, parapets, basin rims. */
function ringWall(pen: Pen, poly: P2[], thickness: number, yLo: number, yHi: number, tone: number, skip?: Set<number>): void {
  const inner = offsetPoly(poly, thickness);
  const shell = shellOf(poly);
  if (!inner) {
    prism(pen, pen.stone, poly, yLo, yHi, tone);
    return;
  }
  const inShell = shellOf(inner);
  for (let i = 0; i < shell.n; i++) {
    if (skip?.has(i)) continue;
    const p = shell.poly[i];
    const q = shell.poly[(i + 1) % shell.n];
    const P = inner[i];
    const Q = inner[(i + 1) % shell.n];
    panel(pen, pen.stone, p.x, p.z, q.x, q.z, yLo, yHi, shell.nrm[i].x, shell.nrm[i].z, shell.u[i], tone, shell.corner[i], shell.corner[(i + 1) % shell.n]);
    panel(pen, pen.stone, Q.x, Q.z, P.x, P.z, yLo, yHi, -inShell.nrm[i].x, -inShell.nrm[i].z, 0, tone, 0, 0);
    slab(pen, pen.stone, p.x, p.z, q.x, q.z, Q.x, Q.z, P.x, P.z, yHi, 1, tone);
  }
}

/** A tapered wall between two polygons with the same vertex count. */
function loft(pen: Pen, b: Bucket, a: P2[], yA: number, c: P2[], yC: number, tone: number): void {
  const shell = shellOf(a);
  for (let i = 0; i < a.length; i++) {
    const j = (i + 1) % a.length;
    const rise = yC - yA;
    const run = Math.hypot(c[i].x - a[i].x, c[i].z - a[i].z);
    const lean = Math.hypot(rise, run) || 1;
    const nx = (shell.nrm[i].x * rise) / lean;
    const nz = (shell.nrm[i].z * rise) / lean;
    const ny = run / lean;
    quad(
      pen, b,
      a[i].x, yA, a[i].z, a[j].x, yA, a[j].z, c[j].x, yC, c[j].z, c[i].x, yC, c[i].z,
      nx, ny, nz,
      shell.u[i], yA - pen.baseY, shell.u[i] + shell.len[i], yA - pen.baseY,
      shell.u[i] + shell.len[i], yC - pen.baseY, shell.u[i], yC - pen.baseY,
      tone, shell.corner[i], shell.corner[j], shell.corner[j], shell.corner[i],
    );
  }
}

function addBox(pen: Pen, poly: P2[], top: number, bottom: number): void {
  const bb = bboxOf(poly);
  pen.blockers.push({ x: bb.cx, z: bb.cz, hx: bb.hx, hz: bb.hz, top, bottom });
}

function addDeck(pen: Pen, poly: P2[], y: number): void {
  const bb = bboxOf(poly);
  pen.decks.push({ y, x: bb.cx, z: bb.cz, hx: bb.hx, hz: bb.hz });
}

/** Arclength along an edge of the nearest point to a world position. */
function projectOnFace(f: Face, p: Vec2): number {
  const s = (p.x - f.ax) * f.tx + (p.z - f.az) * f.tz;
  return Math.min(f.len - 1.2, Math.max(1.2, s));
}

/* -------------------------------------------------------------------------
 * The uses
 * ---------------------------------------------------------------------- */

/**
 * A glass spire: dark stone plinth, two or three setbacks, a crown that is
 * different from its neighbours', and a lobby you can stand in front of.
 *
 * The plinth is `PLINTH_H` **metres**, not a fraction of the height. Do it in
 * normalised space and an eighty-metre tower is nothing but plinth while a
 * three-hundred-metre one gets a dark line at its foot — which is exactly how
 * the first build's plaza came out magenta at eye level.
 */
function buildTower(pen: Pen, lot: Lot, rng: Rng): void {
  const base = offsetPoly(lot.poly, LOT_INSET);
  if (!base) return;
  const y0 = lot.y;
  const h = lot.height;
  const plinthH = Math.min(PLINTH_H, h * 0.34);
  const crownKind = rng.int(0, 3);
  const crownH = crownKind === 0 ? rng.range(14, 30) : crownKind === 3 ? 15 : rng.range(4, 9);
  const shaftTop = y0 + h - crownH;
  const detail = pen.quality === "high";

  pen.span = Math.max(h, 1);

  /* ---- plinth ---- */
  const pShell = shellOf(base);
  const front = new Set(frontFace(pShell, lot.frontEdge));
  const lobbyH = Math.min(6.6, plinthH - 1.5);
  for (let i = 0; i < pShell.n; i++) {
    const f = faceOf(pShell, i);
    if (front.has(i) && f.len > 5 && lobbyH > 3.5) {
      shopfront(pen, f, y0, lobbyH, i === lot.frontEdge ? projectOnFace(f, lot.frontMid) : null, T_BASALT, T_BASALT);
      facade(pen, f, y0 + lobbyH, y0 + plinthH, {
        floorH: 4.4, bayW: 5.5, winW: 2.4, winH: 2.6, sill: 0.9,
        depth: 0.4, tone: T_BASALT, paneKind: P_WINDOW, detail,
      });
    } else {
      facade(pen, f, y0, y0 + plinthH, {
        floorH: 4.6, bayW: 6.0, winW: 2.2, winH: 2.8, sill: 1.1,
        depth: 0.45, tone: T_BASALT, paneKind: P_WINDOW, detail,
      });
    }
  }
  cornice(pen, pShell, y0 + plinthH, 0.9, 0.55, T_STONE, true);
  capPoly(pen, pen.stone, base, y0 + plinthH + 0.9, 1, T_ROOF);
  addBox(pen, base, y0 + plinthH + 0.9, y0);
  addDeck(pen, base, y0 + plinthH + 0.9);

  /* ---- shaft, stepping in as it rises ---- */
  const segs = rng.int(2, 3);
  const setback = rng.range(1.3, 2.8);
  const weights = segs === 2 ? [0.66, 0.34] : [0.52, 0.31, 0.17];
  let cur = base;
  let yA = y0 + plinthH + 0.9;
  const span = shaftTop - yA;
  for (let k = 0; k < segs && span > 6; k++) {
    if (k > 0) {
      const next = offsetPoly(cur, setback);
      if (!next) break;
      cur = next;
    }
    const yB = k === segs - 1 ? shaftTop : yA + span * weights[k];
    const shell = shellOf(cur);
    prismWalls(pen, pen.glass, shell, yA, yB, T_STONE);
    capPoly(pen, pen.stone, cur, yB, 1, T_ROOF);
    addBox(pen, cur, yB, yA);
    if (k < segs - 1) {
      /* The setback ledge is a place, so it gets a parapet and a light. */
      cornice(pen, shell, yB, 1.15, 0.35, T_STONE, true);
      addDeck(pen, cur, yB + 1.15);
    }
    yA = yB;
  }

  /* ---- crown ---- */
  const topShell = shellOf(cur);
  const roofY = yA;
  if (crownKind === 0) {
    const tip = offsetPoly(cur, Math.min(6, bboxOf(cur).hx * 0.55));
    if (tip) {
      loft(pen, pen.glass, cur, roofY, tip, roofY + crownH, T_STONE);
      capPoly(pen, pen.stone, tip, roofY + crownH, 1, T_METAL);
      if (detail) {
        const c = centroidOf(tip);
        tube(pen, pen.glow, c.x, c.z, 0.6, 0.2, roofY + crownH, roofY + crownH + 6, 5, G_WHITE);
      }
    } else {
      cornice(pen, topShell, roofY, 1.2, 0.4, T_STONE, true);
    }
    addDeck(pen, cur, roofY);
  } else if (crownKind === 1) {
    cornice(pen, topShell, roofY, 1.2, 0.4, T_STONE, true);
    const c = centroidOf(cur);
    const mastH = rng.range(18, 46);
    tube(pen, pen.stone, c.x, c.z, 1.5, 0.45, roofY, roofY + mastH, 6, T_METAL);
    tube(pen, pen.glow, c.x, c.z, 0.9, 0.3, roofY + mastH, roofY + mastH + 5, 5, G_WARM);
    addDeck(pen, cur, roofY + 1.2);
  } else if (crownKind === 2) {
    cornice(pen, topShell, roofY, 2.6, 0.9, T_STONE, true);
    cornice(pen, topShell, roofY + 2.6, 1.1, 0.35, T_ROOF, false);
    addDeck(pen, cur, roofY + 3.7);
    if (detail) {
      const c = centroidOf(cur);
      boxAt(pen, pen.stone, c.x, roofY + 5.6, c.z, 3.2, 1.9, 2.6, lot.a, T_ROOF);
    }
  } else {
    let step = cur;
    let sy = roofY;
    for (let k = 0; k < 3; k++) {
      const next = offsetPoly(step, 2.1);
      if (!next) break;
      prismWalls(pen, pen.glass, shellOf(next), sy, sy + 5, T_STONE);
      capPoly(pen, pen.stone, next, sy + 5, 1, T_ROOF);
      cornice(pen, shellOf(next), sy + 5, 0.7, 0.3, T_STONE, k === 2);
      step = next;
      sy += 5;
    }
    addDeck(pen, step, sy + 0.7);
  }
  addBox(pen, cur, roofY + (crownKind === 1 ? 1.2 : crownKind === 2 ? 3.7 : crownKind === 0 ? crownH : 15), yA);
}

/**
 * Mid-rise. Masonry body, punched windows with a real reveal, a cornice and a
 * parapet you can walk behind, balconies on some floors, and a shopfront
 * across the whole street-facing face and nowhere else.
 */
function buildBlock(pen: Pen, lot: Lot, rng: Rng): void {
  const base = offsetPoly(lot.poly, LOT_INSET);
  if (!base) return;
  const y0 = lot.y;
  const h = lot.height;
  const detail = pen.quality === "high";
  pen.span = Math.max(h, 1);

  const shell = shellOf(base);
  const front = new Set(frontFace(shell, lot.frontEdge));
  const bodyTone = rng.chance(0.45) ? T_TERRA : T_STONE;
  const gfTop = y0 + GF_H;
  const corniceY = y0 + h - 1.4;

  /* Base course. */
  const wide = offsetPoly(base, -0.3);
  if (wide) prismWalls(pen, pen.stone, shellOf(wide), y0, y0 + 1.0, T_BASALT);

  for (let i = 0; i < shell.n; i++) {
    const f = faceOf(shell, i);
    if (front.has(i) && f.len > 4.5) {
      shopfront(pen, f, y0, GF_H, i === lot.frontEdge ? projectOnFace(f, lot.frontMid) : null, T_TIMBER, bodyTone);
    } else {
      facade(pen, f, y0, gfTop, {
        floorH: GF_H, bayW: 5.0, winW: 2.0, winH: 2.6, sill: 1.1,
        depth: 0.35, tone: bodyTone, paneKind: P_WINDOW, detail,
      });
    }
    facade(pen, f, gfTop, corniceY, {
      floorH: FLOOR_H, bayW: 4.6, winW: 1.6, winH: 2.1, sill: 0.85,
      depth: 0.32, tone: bodyTone, paneKind: P_WINDOW, detail,
    });
  }

  /* Balconies. High tier only, and only where the sun can find them: the
     street face and one flank, never the back of a light well. */
  if (detail) {
    const floors = Math.max(1, Math.round((corniceY - gfTop) / FLOOR_H));
    for (let i = 0; i < shell.n; i++) {
      if (!front.has(i) && !rng.chance(0.25)) continue;
      const f = faceOf(shell, i);
      if (f.len < 5) continue;
      const rot = Math.atan2(f.tz, f.tx);
      for (let ff = 1; ff < floors; ff++) {
        if (!rng.chance(0.42)) continue;
        const y = gfTop + ff * ((corniceY - gfTop) / floors);
        const w = Math.min(3.4, f.len - 1.6);
        const s = f.len / 2 + rng.range(-1, 1) * ((f.len - w - 1.2) / 2);
        const cx = fx(f, s, 0.44);
        const cz = fz(f, s, 0.44);
        boxAt(pen, pen.stone, cx, y + 0.09, cz, w / 2, 0.09, 0.46, rot, T_STONE);
        boxAt(pen, pen.stone, fx(f, s, 0.86), y + 0.62, fz(f, s, 0.86), w / 2, 0.44, 0.05, rot, T_METAL);
        boxAt(pen, pen.stone, fx(f, s - w / 2, 0.46), y + 0.62, fz(f, s - w / 2, 0.46), 0.05, 0.44, 0.44, rot, T_METAL);
        boxAt(pen, pen.stone, fx(f, s + w / 2, 0.46), y + 0.62, fz(f, s + w / 2, 0.46), 0.05, 0.44, 0.44, rot, T_METAL);
      }
    }
  }

  cornice(pen, shell, corniceY, 1.4, 0.5, T_STONE, true);
  capPoly(pen, pen.stone, base, y0 + h, 1, T_ROOF);
  const parapet = offsetPoly(base, 0.35);
  if (parapet) {
    ringWall(pen, base, 0.35, y0 + h, y0 + h + 1.0, T_STONE);
    if (detail) {
      const c = centroidOf(parapet);
      boxAt(pen, pen.stone, c.x, y0 + h + 1.2, c.z, 1.8, 1.2, 1.4, lot.a, T_ROOF);
      /* A planted roof, because this city is optimistic and half its
         terraces are gardens. */
      if (rng.chance(0.4)) capPoly(pen, pen.stone, parapet, y0 + h + 0.12, 1, T_LEAF);
    }
  }
  addBox(pen, base, y0 + h, y0);
  addDeck(pen, base, y0 + h);
}

/**
 * One to three storeys, and mostly shopfront. Nothing projects into the strip
 * between 2.6 m and 4.0 m where `props.ts` hangs the awnings.
 */
function buildShop(pen: Pen, lot: Lot, rng: Rng): void {
  const base = offsetPoly(lot.poly, LOT_INSET);
  if (!base) return;
  const y0 = lot.y;
  const h = Math.max(lot.height, 5.5);
  const detail = pen.quality === "high";
  pen.span = h;

  const shell = shellOf(base);
  const front = new Set(frontFace(shell, lot.frontEdge));
  const bodyTone = rng.chance(0.55) ? T_TERRA : T_STONE;
  const gf = Math.min(GF_H, h - 0.8);
  const eave = y0 + h - 0.7;

  for (let i = 0; i < shell.n; i++) {
    const f = faceOf(shell, i);
    if (front.has(i) && f.len > 3.5 && gf > 3.4) {
      shopfront(pen, f, y0, gf, i === lot.frontEdge ? projectOnFace(f, lot.frontMid) : null, T_TIMBER, bodyTone);
    } else {
      facade(pen, f, y0, y0 + gf, {
        floorH: gf, bayW: 4.4, winW: 1.7, winH: 2.2, sill: 1.0,
        depth: 0.3, tone: bodyTone, paneKind: P_WINDOW, detail,
      });
    }
    if (eave > y0 + gf + 1.5) {
      facade(pen, f, y0 + gf, eave, {
        floorH: FLOOR_H, bayW: 4.2, winW: 1.5, winH: 1.9, sill: 0.8,
        depth: 0.3, tone: bodyTone, paneKind: P_WINDOW, detail,
      });
    }
  }
  cornice(pen, shell, eave, 0.7, 0.45, T_STONE, true);
  capPoly(pen, pen.stone, base, y0 + h, 1, T_ROOF);
  ringWall(pen, base, 0.3, y0 + h, y0 + h + 0.7, T_STONE);
  if (detail && rng.chance(0.5)) {
    const c = centroidOf(base);
    boxAt(pen, pen.stone, c.x, y0 + h + 0.8, c.z, 1.1, 0.8, 0.9, lot.a, T_METAL);
  }
  addBox(pen, base, y0 + h, y0);
  addDeck(pen, base, y0 + h);
}

/** A hipped or pyramidal roof over a footprint. Emitted as gable triangles. */
function pyramid(pen: Pen, b: Bucket, poly: P2[], y0: number, apexY: number, tone: number): void {
  const c = centroidOf(poly);
  const shell = shellOf(poly);
  for (let i = 0; i < shell.n; i++) {
    const p = shell.poly[i];
    const q = shell.poly[(i + 1) % shell.n];
    const run = Math.hypot(c.x - (p.x + q.x) / 2, c.z - (p.z + q.z) / 2);
    const rise = apexY - y0;
    const lean = Math.hypot(rise, run) || 1;
    quad(
      pen, b,
      p.x, y0, p.z, q.x, y0, q.z, c.x, apexY, c.z, c.x, apexY, c.z,
      (shell.nrm[i].x * rise) / lean, run / lean, (shell.nrm[i].z * rise) / lean,
      0, 0, shell.len[i], 0, shell.len[i] / 2, lean, shell.len[i] / 2, lean,
      tone, 3, 3, 3, 3,
    );
  }
}

/**
 * Something with a portico: a podium, steps down to the pavement at the
 * front, a colonnade, an entablature, a pediment and a copper roof.
 *
 * The steps go *outward from the wall and downward*, stacked from the podium
 * edge inward, so the whole entrance stays inside the lot. A flight that
 * marches out over the pavement is the classic way a civic building ends up
 * standing in the road.
 */
function buildCivic(pen: Pen, lot: Lot, rng: Rng): void {
  const base = offsetPoly(lot.poly, LOT_INSET);
  if (!base) return;
  const y0 = lot.y;
  const h = lot.height;
  const detail = pen.quality === "high";
  pen.span = Math.max(h, 1);

  const podiumH = 1.05;
  const podium = shellOf(base);
  const front = new Set(frontFace(podium, lot.frontEdge));

  /* Podium. */
  prismWalls(pen, pen.stone, podium, y0, y0 + podiumH, T_BASALT);
  capPoly(pen, pen.stone, base, y0 + podiumH, 1, T_STONE);

  /* Steps: three treads stacked from the podium face inward. */
  for (const i of front) {
    const f = faceOf(podium, i);
    if (f.len < 5) continue;
    const w = Math.min(f.len - 1.6, Math.max(6, f.len * 0.62));
    const s = projectOnFace(f, lot.frontMid);
    const rot = Math.atan2(f.tz, f.tx);
    for (let k = 0; k < 3; k++) {
      const depth = (3 - k) * 0.34;
      boxAt(pen, pen.stone, fx(f, s, -depth / 2), y0 + ((k + 1) * podiumH) / 3 / 2, fz(f, s, -depth / 2),
        w / 2, ((k + 1) * podiumH) / 3 / 2, depth / 2, rot, T_STONE);
    }
  }

  /* Body, set back on the street face to leave room for the colonnade. */
  const offs = new Array<number>(podium.n).fill(0);
  for (const i of front) offs[i] = 3.4;
  const body = offsetPoly(base, offs) ?? base;
  const bodyShell = shellOf(body);
  const eave = y0 + podiumH + h;
  for (let i = 0; i < bodyShell.n; i++) {
    const f = faceOf(bodyShell, i);
    facade(pen, f, y0 + podiumH, eave - 2.2, {
      floorH: Math.max(4.5, (eave - 2.2 - y0 - podiumH) / Math.max(1, Math.round((eave - y0) / 5.2))),
      bayW: 5.4, winW: 2.0, winH: 3.4, sill: 1.2,
      depth: 0.5, tone: T_STONE, paneKind: P_WINDOW, detail,
    });
  }

  /* Colonnade on the podium, under an entablature. */
  const colTop = Math.min(eave - 2.4, y0 + podiumH + 11);
  for (const i of front) {
    const f = faceOf(podium, i);
    if (f.len < 5) continue;
    const n = Math.max(2, Math.round(f.len / 4.2));
    for (let k = 0; k <= n; k++) {
      const s = 0.9 + ((f.len - 1.8) * k) / n;
      tube(pen, pen.stone, fx(f, s, -1.5), fz(f, s, -1.5), 0.62, 0.52, y0 + podiumH, colTop, 8, T_STONE, false);
      tube(pen, pen.stone, fx(f, s, -1.5), fz(f, s, -1.5), 0.85, 0.85, colTop, colTop + 0.35, 8, T_STONE);
    }
    const rot = Math.atan2(f.tz, f.tx);
    boxAt(pen, pen.stone, fx(f, f.len / 2, -1.5), colTop + 1.1, fz(f, f.len / 2, -1.5),
      f.len / 2, 0.75, 1.05, rot, T_STONE);
    if (detail) {
      glowStrip(pen, fx(f, 1, -0.4), fz(f, 1, -0.4), fx(f, f.len - 1, -0.4), fz(f, f.len - 1, -0.4),
        colTop + 0.4, colTop + 0.7, f.nx, f.nz, G_WARM);
      /* Pediment: a shallow gable over the colonnade. */
      const rise = 2.3;
      quad(
        pen, pen.stone,
        fx(f, 0.4, -1.5), colTop + 1.85, fz(f, 0.4, -1.5),
        fx(f, f.len - 0.4, -1.5), colTop + 1.85, fz(f, f.len - 0.4, -1.5),
        fx(f, f.len / 2, -1.5), colTop + 1.85 + rise, fz(f, f.len / 2, -1.5),
        fx(f, f.len / 2, -1.5), colTop + 1.85 + rise, fz(f, f.len / 2, -1.5),
        f.nx, 0.25, f.nz, 0, 0, f.len, 0, f.len / 2, rise, f.len / 2, rise,
        T_STONE, 0, 0, 0, 0,
      );
    }
  }

  /* A bigger roof: deep eaves and a copper pyramid. */
  cornice(pen, bodyShell, eave - 2.2, 1.3, 0.95, T_STONE, true);
  const roofBase = offsetPoly(body, -0.6) ?? body;
  capPoly(pen, pen.stone, roofBase, eave - 0.9, 1, T_ROOF);
  pyramid(pen, pen.stone, roofBase, eave - 0.9, eave + Math.min(9, h * 0.3), T_METAL);
  addBox(pen, base, eave - 0.9, y0);
  addDeck(pen, base, eave - 0.9);
}

/** Small, open, a roof on columns. Somewhere to stand out of the wind. */
function buildPavilion(pen: Pen, lot: Lot, rng: Rng): void {
  const base = offsetPoly(lot.poly, LOT_INSET + 1.5);
  if (!base) return;
  const y0 = lot.y;
  const h = Math.max(lot.height, 4.2);
  pen.span = h + 2.5;

  prismWalls(pen, pen.stone, shellOf(base), y0, y0 + 0.42, T_STONE);
  capPoly(pen, pen.stone, base, y0 + 0.42, 1, T_STONE);

  const cols = offsetPoly(base, 0.55) ?? base;
  const shell = shellOf(cols);
  for (let i = 0; i < shell.n; i++) {
    const f = faceOf(shell, i);
    const n = Math.max(1, Math.round(f.len / 3.6));
    for (let k = 0; k < n; k++) {
      const s = (f.len * (k + 0.5)) / n;
      tube(pen, pen.stone, fx(f, s), fz(f, s), 0.28, 0.24, y0 + 0.42, y0 + h, 6, T_TIMBER, false);
    }
  }
  /* Entablature ring and a shallow copper roof. */
  const eaves = offsetPoly(base, -0.8) ?? base;
  prismWalls(pen, pen.stone, shellOf(eaves), y0 + h, y0 + h + 0.45, T_TIMBER);
  capPoly(pen, pen.stone, eaves, y0 + h + 0.45, 1, T_METAL);
  pyramid(pen, pen.stone, eaves, y0 + h + 0.45, y0 + h + 2.4, T_METAL);
  if (pen.quality === "high") {
    for (let i = 0; i < shell.n; i++) {
      const f = faceOf(shell, i);
      glowStrip(pen, fx(f, 0.3, 0.2), fz(f, 0.3, 0.2), fx(f, f.len - 0.3, 0.2), fz(f, f.len - 0.3, 0.2),
        y0 + h - 0.45, y0 + h - 0.1, f.nx, f.nz, G_WARM);
    }
  }
  addDeck(pen, base, y0 + 0.42);
  addDeck(pen, eaves, y0 + h + 0.45);
  void rng;
}

/**
 * No building. A low wall, a hedge inside it, an opening on the street, and
 * the soil — `props.ts` puts the trees in.
 *
 * No blocker either: a knee-high wall you cannot step over is more annoying
 * than one you can, and the gardens are where the crowd and the props live.
 */
function buildGarden(pen: Pen, lot: Lot, rng: Rng): void {
  const base = offsetPoly(lot.poly, LOT_INSET);
  if (!base) return;
  const y0 = lot.y;
  pen.span = 2;

  const shell = shellOf(base);
  const front = frontFace(shell, lot.frontEdge);
  const gate = new Set<number>([front[Math.floor(front.length / 2)]]);
  ringWall(pen, base, 0.45, y0, y0 + 0.62, T_STONE, gate);

  /* Gate piers where the wall stops. */
  for (const i of gate) {
    const f = faceOf(shell, i);
    const rot = Math.atan2(f.tz, f.tx);
    for (const s of [0.35, f.len - 0.35]) {
      boxAt(pen, pen.stone, fx(f, s, -0.22), y0 + 0.55, fz(f, s, -0.22), 0.32, 0.55, 0.32, rot, T_BASALT);
    }
  }

  const soil = offsetPoly(base, 0.45);
  if (soil) {
    capPoly(pen, pen.stone, soil, y0 + 0.22, 1, T_LEAF);
    /* A hedge inside the wall, broken where the gate is. */
    const hedge = offsetPoly(soil, 0.5);
    if (hedge && pen.quality === "high") {
      const hShell = shellOf(hedge);
      for (let i = 0; i < hShell.n; i++) {
        if (gate.has(i)) continue;
        const f = faceOf(hShell, i);
        const rot = Math.atan2(f.tz, f.tx);
        boxAt(pen, pen.stone, fx(f, f.len / 2, -0.3), y0 + 0.62 + rng.range(0.3, 0.5), fz(f, f.len / 2, -0.3),
          f.len / 2, rng.range(0.3, 0.5), 0.42, rot, T_LEAF);
      }
    }
  }
}

/** A shed with big doors. Nothing in the current plan is one; it still works. */
function buildHangar(pen: Pen, lot: Lot, rng: Rng): void {
  const base = offsetPoly(lot.poly, LOT_INSET);
  if (!base) return;
  const y0 = lot.y;
  const h = Math.max(lot.height, 8);
  pen.span = h + 4;
  const shell = shellOf(base);
  const front = new Set(frontFace(shell, lot.frontEdge));

  for (let i = 0; i < shell.n; i++) {
    const f = faceOf(shell, i);
    if (front.has(i) && f.len > 6) {
      /* The doors: two leaves, deeply recessed, with a lintel over them. */
      const w = Math.min(f.len - 2, f.len * 0.8);
      const s = f.len / 2;
      opening(pen, f, 0, f.len, y0, y0 + h, s - w / 2, s + w / 2, y0 + 0.1, y0 + h * 0.72, 0.6, T_METAL, P_DARK, 8);
    } else {
      facade(pen, f, y0, y0 + h, {
        floorH: h, bayW: 6, winW: 2.2, winH: 1.4, sill: h - 2.6,
        depth: 0.3, tone: T_METAL, paneKind: P_WINDOW, detail: pen.quality === "high",
      });
    }
  }
  const ridge = offsetPoly(base, Math.min(4, bboxOf(base).hz * 0.7));
  capPoly(pen, pen.stone, base, y0 + h, 1, T_METAL);
  if (ridge) {
    loft(pen, pen.stone, base, y0 + h, ridge, y0 + h + 3.2, T_METAL);
    capPoly(pen, pen.stone, ridge, y0 + h + 3.2, 1, T_METAL);
  }
  addBox(pen, base, y0 + h, y0);
  addDeck(pen, base, y0 + h);
  void rng;
}

/** One lot, into the pen. The only place `Lot.use` is switched on. */
function buildLot(pen: Pen, lot: Lot, salt: string): void {
  if (lot.landmark) return;
  const rng = makeRng(`empyrean-buildings:${salt}:${lot.id}`);
  pen.baseY = lot.y;
  pen.span = Math.max(lot.height, 1);
  pen.seed = lot.seed * 100;
  switch (lot.use) {
    case "tower":
      buildTower(pen, lot, rng);
      break;
    case "block":
      buildBlock(pen, lot, rng);
      break;
    case "shop":
      buildShop(pen, lot, rng);
      break;
    case "civic":
      buildCivic(pen, lot, rng);
      break;
    case "pavilion":
      buildPavilion(pen, lot, rng);
      break;
    case "garden":
      buildGarden(pen, lot, rng);
      break;
    case "hangar":
      buildHangar(pen, lot, rng);
      break;
  }
}
