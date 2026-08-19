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
/* The one cross-system import in this file, and it is a constant rather than
   a system: `sky.ts` owns where the sun is, and the glass has to reflect the
   same sky the dome paints or the towers are made of a different evening.
   The live value arrives in `FrameContext.sunDir`; this is only the value the
   uniforms are born with, so a first frame drawn before `update` is still
   lit. */
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

/** What the engine can ask for that the plan does not already say. */
export interface BuildingsOptions {
  /**
   * Lots to leave empty, by `Lot.id`.
   *
   * `interiors.ts` builds real rooms inside two of them — the café at
   * `b1-6-11` and the gallery at `b2-12-00` — and a solid block on top of a
   * room is a room nobody can get into. A skipped lot contributes no
   * geometry, no blocker and no deck, and comes back with `built: false`.
   *
   * The list is the engine's to pass (`interiorPlan()` and the interiors
   * handle both publish it as `claimedLots`); this file does not import it,
   * because a system that imports another system is how twelve files become
   * one module with twelve files in it.
   */
  skipLots?: readonly string[];
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

/**
 * Curtain-wall variants, as the *glass* shader reads `aTone`.
 *
 * The glass bucket has its own meaning for the attribute: which piece of a
 * tower this is, rather than what it is made of. It exists so that the one
 * large-scale change of tone on a tower lands on the setback where a real
 * building changes its cladding, instead of on a random square of wall.
 * `W_MAIN` is deliberately 0, which is what everything that predates this
 * already writes.
 */
const W_MAIN = 0;
const W_UPPER = 1;
const W_CROWN = 2;

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
    const mx = (c0 * n1.z - c1 * n0.z) / det;
    const mz = (n0.x * c1 - n1.x * c0) / det;
    /* Miter limit.
     *
     * Two nearly-collinear edges meeting at a shallow corner throw their
     * offset intersection out to `off / sin(half-angle)`, and the plan's arcs
     * are chorded every seven degrees — so a 0.55 m cornice grew a ten-metre
     * spike into the middle of the road on lots whose front is an arc. Past
     * the limit the corner is cut instead, which at seven degrees nobody can
     * see and which keeps the projection honest. */
    const cap = 1.8 * Math.max(Math.abs(amount(prev)), Math.abs(amount(i))) + 0.02;
    if (Math.hypot(mx - poly[i].x, mz - poly[i].z) > cap) {
      let ax = n0.x + n1.x;
      let az = n0.z + n1.z;
      const al = Math.hypot(ax, az) || 1;
      ax /= al;
      az /= al;
      const mean = (amount(prev) + amount(i)) / 2;
      out.push({ x: poly[i].x - ax * mean, z: poly[i].z - az * mean });
      continue;
    }
    out.push({ x: mx, z: mz });
  }
  const area = shoelace(out);
  if (!Number.isFinite(area) || Math.sign(area) !== sign || Math.abs(area) < 6) return null;
  /* Every new vertex must be inside the original — but only when this really
   * was an inset. Negative offsets are how a cornice, a base course and a
   * deep eave are made, and checking those for containment quietly turns
   * every projection in the city into a flush band. */
  let inset = Infinity;
  for (let i = 0; i < n; i++) inset = Math.min(inset, amount(i));
  if (inset >= 0) for (const p of out) if (!insidePoly(poly, p.x, p.z, 0.02)) return null;
  return out;
}

/**
 * Cut the corners off a footprint.
 *
 * Convex corners only, and the cut is capped at a third of each adjacent
 * edge. Both of those are containment, not taste: chamfering a *reflex*
 * corner moves the wall outward, and outward is the pavement.
 */
function chamferPoly(poly: P2[], amount: number): P2[] | null {
  const n = poly.length;
  if (n < 3) return null;
  const sign = Math.sign(shoelace(poly)) || 1;
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const p = poly[i];
    const next = poly[(i + 1) % n];
    const ax = p.x - prev.x;
    const az = p.z - prev.z;
    const bx = next.x - p.x;
    const bz = next.z - p.z;
    const la = Math.hypot(ax, az) || 1;
    const lb = Math.hypot(bx, bz) || 1;
    const convex = (ax * bz - az * bx) * sign;
    const d = Math.min(amount, la * 0.34, lb * 0.34);
    if (convex <= 0 || d < 0.35) {
      out.push(p);
      continue;
    }
    out.push({ x: p.x - (ax / la) * d, z: p.z - (az / la) * d });
    out.push({ x: p.x + (bx / lb) * d, z: p.z + (bz / lb) * d });
  }
  return out.length >= 3 ? out : null;
}

/** Unsigned area. Only ever used to notice that a shape has collapsed. */
function areaOf(poly: P2[]): number {
  return Math.abs(shoelace(poly));
}

/**
 * Per-edge insets that squeeze a footprint along one axis and leave the
 * others alone — a slab across a lot instead of a prism of it.
 *
 * Every offset is positive, so the result is inside the input for the same
 * reason a uniform inset is.
 */
function squeezeOffsets(poly: P2[], ang: number, extra: number, base = 0): number[] {
  const sign = Math.sign(shoelace(poly)) || 1;
  const cx = Math.cos(ang);
  const cz = Math.sin(ang);
  const out: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const nrm = edgeNormal(poly, i, sign);
    out.push(base + extra * Math.abs(nrm.x * cx + nrm.z * cz));
  }
  return out;
}

/** Inside, with a tolerance band in metres. */
function insidePoly(poly: P2[], x: number, z: number, slack = 0): boolean {
  return outsideBy(poly, x, z) <= slack;
}

/**
 * How far outside the polygon a point is, in metres. Zero when inside.
 *
 * A crossing test and a distance to the nearest segment, rather than the max
 * of the edge half-planes — which is faster, obvious, and **wrong here**. The
 * plan's lots are not convex: their inner arc is approximated by chords that
 * bulge toward the origin, so every lot in the core has two or three reflex
 * vertices. Against the half-plane version an inset corner near one of those
 * reads as "outside", `offsetPoly` refuses, and sixteen of the twenty-three
 * spires in The Spires quietly fail to exist.
 */
function outsideBy(poly: P2[], x: number, z: number): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / l2)) : 0;
    const d = Math.hypot(x - (a.x + ex * t), z - (a.z + ez * t));
    if (d < best) best = d;
  }
  return inside ? 0 : best;
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
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  h: Float32Array;
  base: Float32Array;
  seed: Float32Array;
  tone: Float32Array;
  edge: Float32Array;
  idx: Uint32Array;
  /** Vertices written into the current chunk. */
  verts: number;
  /** Indices written into the current chunk. */
  icount: number;
  chunks: THREE.BufferGeometry[];
  triangles: number;
  vertices: number;
}

/**
 * Vertices per chunk, and typed arrays rather than `number[]`.
 *
 * The city is two thirds of a million vertices at the high tier. Growing eight
 * JavaScript arrays to that size and then converting each of them costs two
 * and a half seconds of boot on a machine that renders the result at sixty
 * frames; writing into a fixed typed buffer and slicing it costs a fifth of
 * that, and the fixed buffer is why the chunking exists at all.
 */
const CHUNK_VERTS = 48000;

function newBucket(): Bucket {
  return {
    pos: new Float32Array(CHUNK_VERTS * 3),
    nrm: new Float32Array(CHUNK_VERTS * 3),
    uv: new Float32Array(CHUNK_VERTS * 2),
    h: new Float32Array(CHUNK_VERTS),
    base: new Float32Array(CHUNK_VERTS),
    seed: new Float32Array(CHUNK_VERTS),
    tone: new Float32Array(CHUNK_VERTS),
    edge: new Float32Array(CHUNK_VERTS),
    idx: new Uint32Array(CHUNK_VERTS * 2),
    verts: 0,
    icount: 0,
    chunks: [],
    triangles: 0,
    vertices: 0,
  };
}

function flushBucket(b: Bucket): void {
  if (b.verts === 0) return;
  const n = b.verts;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(b.pos.slice(0, n * 3), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(b.nrm.slice(0, n * 3), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(b.uv.slice(0, n * 2), 2));
  g.setAttribute("aH", new THREE.BufferAttribute(b.h.slice(0, n), 1));
  g.setAttribute("aBase", new THREE.BufferAttribute(b.base.slice(0, n), 1));
  g.setAttribute("aSeed", new THREE.BufferAttribute(b.seed.slice(0, n), 1));
  g.setAttribute("aTone", new THREE.BufferAttribute(b.tone.slice(0, n), 1));
  g.setAttribute("aEdge", new THREE.BufferAttribute(b.edge.slice(0, n), 1));
  g.setIndex(new THREE.BufferAttribute(b.idx.slice(0, b.icount), 1));
  b.chunks.push(g);
  b.verts = 0;
  b.icount = 0;
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
  const i = b.verts;
  b.pos[i * 3] = x;
  b.pos[i * 3 + 1] = y;
  b.pos[i * 3 + 2] = z;
  b.nrm[i * 3] = nx;
  b.nrm[i * 3 + 1] = ny;
  b.nrm[i * 3 + 2] = nz;
  b.uv[i * 2] = u;
  b.uv[i * 2 + 1] = v;
  const rise = y - pen.baseY;
  b.h[i] = rise <= 0 ? 0 : rise >= pen.span ? 1 : rise / pen.span;
  b.base[i] = rise;
  b.seed[i] = pen.seed;
  b.tone[i] = tone;
  b.edge[i] = edge;
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
  b.idx[b.icount++] = i0;
  b.idx[b.icount++] = i1;
  b.idx[b.icount++] = i2;
  b.idx[b.icount++] = i0;
  b.idx[b.icount++] = i2;
  b.idx[b.icount++] = i3;
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
    b.idx[b.icount++] = ids[0];
    b.idx[b.icount++] = ids[1];
    b.idx[b.icount++] = ids[2];
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
/**
 * Two numbers in, one well-mixed number out.
 *
 * Not a nicety. The first build hashed a grid of bays and floors with one
 * 1-D hash of bay times a plus floor times b, and such a hash is only
 * pseudo-random for inputs that are far apart: neighbouring bays land close
 * together in the input, come out close together in the output, and clump.
 * Every tower in the city was quilted with patches of same-toned cells for
 * exactly that reason. Anything indexed by (bay, floor) uses this.
 */
float hash21(vec2 c) {
  vec3 p = fract(vec3(c.x, c.y, c.x) * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
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
uniform float uSunUp;
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
 *
 * ## The quilt
 *
 * The first build of this shader lit a whole grid cell at a time — two and a
 * half metres by four — off a 1-D hash of `bay * a + floor * b`, with a floor
 * line under each one and nothing else at that scale. Adjacent cells clumped
 * (see `hash21`), and from the pavement a three-hundred-metre tower read as a
 * patchwork of tiles rather than as a building with a facade on it.
 *
 * The rule that came out of it, and the reason this function is shaped the
 * way it is:
 *
 * - **variation is per bay, per floor band, or per window.** A bay is a
 *   column of glass between two mullions; a floor band is a course. Both are
 *   one-dimensional and both are architecture. Crossing two 1-D jitters gives
 *   a weave at a metre or two. A 2-D jitter over a cell gives a patch, and a
 *   patch is what a quilt is made of.
 * - **anything that changes over more than a couple of metres is
 *   structural** — a setback carries a different glass because a real tower's
 *   setback does, and it arrives on `aTone` rather than out of a hash.
 * - **the grid fades out once it is smaller than a pixel.** An unfiltered
 *   metre-scale pattern at eight hundred metres is moire, and moire is the
 *   same quilt seen from further away.
 */
const GLASS_FRAG = HEAD + SKY_CHUNK + /* glsl */ `
void main() {
  float s = vSeed;
  float warmth = hash11(s * 7.13);
  float cool   = hash11(s * 3.71 + 2.0);
  /* Which cladding this piece of tower wears: shaft, above the setback, or
     crown. Structural, not random. */
  float upper = step(0.5, vTone);
  float crown = step(1.5, vTone);

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
  /* The genuine change of material, at the one place a building has one. */
  col = mix(col, mix(col, cTop, 0.20), upper);
  col = mix(col, mix(col, vec3(0.86, 0.91, 1.00), 0.32), crown);

  /* ---- the facade, in metres ---- */
  float fh = 3.7 + hash11(s * 5.5) * 0.8;
  float bw = mix(2.55, 3.10, upper);
  vec2 g = vec2(vUv.x / bw, vBase / fh);

  /* How much of one bay a pixel covers, and how much of the pattern is
     therefore worth drawing. Everything metre-scale below is faded into its
     own mean by 'det' rather than left to alias. */
  float px = max(fwidth(g.x), fwidth(g.y));
  float det = 1.0 - smoothstep(0.28, 0.80, px);

  vec2 f = fract(g);
  float mull  = smoothstep(0.0, 0.06, min(f.x, 1.0 - f.x));
  float trans = smoothstep(0.0, 0.05, min(f.y, 1.0 - f.y));
  /* The spandrel under every sill: the opaque metre and a half that hides a
     floor slab, and the reason a curtain wall is banded and not flat. */
  float spandrel = 1.0 - smoothstep(0.17, 0.31, f.y);
  float glazed = mull * trans * (1.0 - spandrel);
  float frame = max(1.0 - mull, 1.0 - trans);
  col *= mix(1.0, mix(mix(0.80, 1.02, glazed), 1.20, frame * 0.5), det);

  /* Per bay and per floor band, never per cell. */
  float bayJit   = hash21(vec2(floor(g.x), s * 0.37)) - 0.5;
  float floorJit = hash21(vec2(s * 0.71, floor(g.y))) - 0.5;
  col *= 1.0 + (bayJit * 0.085 + floorJit * 0.065) * det;

  /* A structural belt every eighth floor. */
  float belt = abs(fract(vBase / (fh * 8.0)) - 0.5) * 2.0;
  col *= mix(1.0, mix(1.0, 0.74, smoothstep(0.93, 1.0, belt)), det);

  /* Corner light: the lip that separates fifty overlapping slabs. */
  float corner = 1.0 - smoothstep(0.0, 1.5, vEdge);
  col += col * corner * 0.30;

  /* Lit windows — inside the glazing and nowhere else, so one of them is a
     window rather than a two-and-a-half by four metre tile. Sparse by day,
     most of the building by night, and a flat average once a bay is smaller
     than a pixel, so a distant tower keeps its warmth without speckling. */
  float coverage = 1.0 - mix(0.42, 0.955, uDaylight);
  float r = hash21(vec2(floor(g.x) + s, floor(g.y) - s));
  /* Not a switch. Ramping the lit ones across the whole range costs nothing —
     the hash is already uniform — and it is what stops a lit window reading
     as a flat bright tile with a hard edge, which is the last thing left of
     the quilt. Its mean is half the coverage, which is what the far field
     fades to. */
  float li = clamp((r - (1.0 - coverage)) / max(coverage, 0.001), 0.0, 1.0);
  float lit = mix(coverage * 0.5, li * glazed, det);
  col += vec3(1.0, 0.78, 0.42) * lit * (1.0 - crown * 0.7)
       * (0.12 + 0.88 * pow(1.0 - uDaylight, 2.0))
       * (1.0 - smoothstep(0.55, 0.98, h)) * 0.62;

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

  /* Shaded by how much sun there is, not by whether the lamps are on.
   *
   * uDaylight is the lamp switch and reads 0.32 at the hour this world is
   * painted at, so this line used to multiply every tower in the city by 0.61
   * before the grade ever saw it — at the exact moment the sky dome is the
   * brightest it will be all day and is lighting the whole facade. uSunUp
   * is 1 while the sun is above the horizon and falls away after it sets,
   * which is the quantity this actually wanted. */
  col *= mix(0.46, 1.0, uSunUp);
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

  /* Everything below is a pattern about a metre across, and every one of them
     is dropped as it approaches the size of a pixel. A metre-scale pattern
     drawn unfiltered at half a kilometre is moire, and moire on a facade
     reads as blotches — the same fault as the quilt on the towers, arriving
     from the other end of the street. */
  float det = 1.0 - smoothstep(0.30, 0.95, max(fwidth(vUv.x), fwidth(vBase)));

  /* Coursing and joints, on the stony tones only. Copper and foliage get
     their own grain instead — a hedge with ashlar joints in it is a very
     particular kind of wrong. */
  float stony = step(vTone, 2.5) + step(5.5, vTone);
  float course = abs(fract(vBase / 0.95) - 0.5) * 2.0;
  float joint  = abs(fract(vUv.x / 1.55) - 0.5) * 2.0;
  float mortar = min(smoothstep(0.03, 0.24, course), smoothstep(0.03, 0.18, joint));
  base *= mix(1.0, 0.88 + 0.18 * mortar, clamp(stony, 0.0, 1.0) * det);

  float leafy = step(4.5, vTone) * step(vTone, 5.5);
  float rough = hash21(vec2(floor(vUv.x * 1.7), floor(vBase * 1.9)) + vSeed);
  base *= mix(1.0, 0.78 + 0.44 * rough, leafy * det);

  float coppery = step(2.5, vTone) * step(vTone, 3.5);
  float seam = abs(fract(vUv.x / 0.62) - 0.5) * 2.0;
  base *= mix(1.0, 0.92 + 0.14 * smoothstep(0.0, 0.35, seam), coppery * det);

  /* ---- the light, which at this hour is three things and only one of them
   * is the sun ----
   *
   * The sunset dome is a light source the size of the sky, so a wall facing
   * away from the sun is not unlit, it is sky-lit: a vertical face still sees
   * half of the hemisphere, which is what the wrap in 'dome' is for. Under it
   * the snow, the pale paving and a frozen lake throw a warm bounce back up —
   * keel.ts runs the same term for the rock, where it is worth more to the
   * picture than the sun is. And the glow itself wraps: the bright half of
   * the sky reaches faces well past the terminator.
   *
   * The first pass had the ambient as 0.20 + 0.52 * max(N.y, 0.0), which is
   * 0.20 on every wall in the city, and the shadow side of every building
   * clipped to black with its windows floating on it. Sky bounce is not a
   * rounding error at dusk; it is most of the light. What must NOT happen is
   * the fix going the other way into flat and milky, so the lift is coloured
   * and directional — cold from above, warm from below, warmer toward the
   * sun — and the direct term is trimmed to keep the ratio near five to one.
   */
  vec3 L = normalize(uSun);
  float ndl = dot(N, L);
  float up = clamp(N.y, 0.0, 1.0);
  float dome   = 0.5 + 0.5 * N.y;
  float ground = 0.5 - 0.5 * N.y;
  float wrap   = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
  vec3 skyAmb  = vec3(0.30, 0.38, 0.66) * (0.22 + 0.78 * dome) * 0.70;
  vec3 iceAmb  = vec3(0.66, 0.47, 0.42) * (0.10 + 0.90 * ground) * 0.46;
  vec3 glowAmb = vec3(1.00, 0.62, 0.42) * pow(wrap, 2.0) * 0.30;
  vec3 col = base * (skyAmb + iceAmb + glowAmb + vec3(1.10, 0.66, 0.36) * max(ndl, 0.0) * 1.05);
  col += base * vec3(1.0, 0.60, 0.34) * pow(max(ndl, 0.0), 4.0) * 0.28;

  /* Contact shade. Measured in metres above this building's own foot, so a
     kiosk and a spire both get exactly one storey of it. Shallow, because it
     lands on the storey the player is standing next to and it compounds with
     everything else that darkens a shadowed wall. */
  col *= 0.70 + 0.30 * smoothstep(0.0, 5.5, vBase);

  vec3 toEye = uCam - vWPos;
  float dist = length(toEye);
  vec3 V = toEye / max(dist, 0.001);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.2);
  col += vec3(1.0, 0.72, 0.62) * fres * 0.22 * smoothstep(30.0, 260.0, dist);

  /* Dusk and night: cold everywhere, warm where the street lamps reach.
   *
   * uDaylight is 0.32 at the hour this world is painted at, so a straight
   * mix(col * 0.26, col, uDaylight) was multiplying every wall in the city
   * by a half before it had even been tone mapped. The dome does not switch
   * off at sunset — it is the brightest it will be all day — so the curve
   * holds most of its value through dusk and only lets go after it. */
  float night = 1.0 - smoothstep(0.02, 0.55, uSunUp);
  col *= mix(vec3(1.0), vec3(0.30, 0.33, 0.48), night);
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

  /* vUv.x is openingId + 0..1: the integer part is which window this is,
     which is the only thing distinguishing one window on a floor from the
     twenty next to it. Hashing the position across the pane instead lit whole
     floors at a time. */
  float id = floor(vUv.x);
  float u = fract(vUv.x);
  float r = hash21(vec2(id + vSeed, floor(vBase * 0.31) - vSeed));
  float on = step(mix(0.55, 0.08, shop), r) * (1.0 - dark);
  vec3 warm = mix(vec3(1.00, 0.66, 0.32), vec3(1.00, 0.86, 0.60), hash11(vSeed * 5.9 + r));

  /* The room behind an unlit pane is not a black hole: at dusk it is full of
     the same sky bounce the wall around it gets, and without that the shadow
     side of a building reads as a cut-out with a few lit rectangles on it. */
  vec3 amb = vec3(0.16, 0.19, 0.30) * 0.42 + vec3(0.20, 0.14, 0.13) * 0.24;
  vec3 day = env * mix(0.52, 0.30, shop) + amb * 0.55;
  vec3 night = mix(amb * 0.30 + vec3(0.02, 0.025, 0.05), warm * mix(1.4, 2.2, shop), on);
  vec3 col = mix(night, day + warm * on * mix(0.10, 0.55, shop), smoothstep(0.05, 0.55, uDaylight));

  /* A room behind the glass rather than a mirror: darker toward the head,
     brighter at the sill where the floor catches the light. */
  col *= mix(1.18, 0.74, vUv.y);
  /* Transoms and glazing bars, dropped once they are thinner than a pixel. */
  float bar = abs(fract(u * max(vEdge, 1.0)) - 0.5) * 2.0;
  float det = 1.0 - smoothstep(0.25, 0.75, fwidth(vUv.x) * max(vEdge, 1.0));
  col *= mix(1.0, 0.84 + 0.20 * smoothstep(0.0, 0.28, bar), det);
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

  /* The glazing, at the back of the recess.
   *
   * `u` runs from `key` to `key + 1` across the pane rather than 0 to 1: the
   * fractional part is where you are across it, and the integer part is which
   * opening this is. Without that the pane shader has nothing to tell one
   * window from the next but its height, so every window on a floor lights up
   * together and a facade comes out in stripes. */
  const key = Math.floor(f.u0 + (s0 + s1) * 0.5) % 97;
  quad(
    pen, pen.pane,
    fx(f, s0, -depth), y0, fz(f, s0, -depth), fx(f, s1, -depth), y0, fz(f, s1, -depth),
    fx(f, s1, -depth), y1, fz(f, s1, -depth), fx(f, s0, -depth), y1, fz(f, s0, -depth),
    f.nx, 0, f.nz,
    key, 0, key + 1, 0, key + 1, 1, key, 1,
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
  /* All four are **absolute world Y**, and it matters: `height` is the
     shopfront's own height, so a head at `height - 0.95` is a head 0.95 m
     below the pavement of a world whose ground is six hundred metres up.
     Every use below reads them as absolute — `FASCIA - yLo` is used as a UV
     span, which is only a height if `FASCIA` is a level — and for a while two
     of them were not. The city grew a curtain of stretched shopfront hanging
     from the underside of the island down to four metres above the ice: a
     hundred and five lots of it, visible from every viewpoint that looked at
     the rock, and mistaken for the rock twice. */
  const HEAD = yLo + Math.min(height - 0.95, 3.55);
  const FASCIA = yLo + height - 0.85;
  const SILL = yLo + RISER;
  const bays = Math.max(1, Math.round(f.len / 3.9));
  const bw = f.len / bays;
  const PIER = Math.min(0.55, bw * 0.18);

  /* Where the door goes, worked out first: the stall riser has to stop for
     it, and everything else has to start above it. Two pieces of geometry in
     the same plane is a z-fight you only ever see from the pavement, and the
     pavement is the camera this whole function exists for. */
  let doorBay = -1;
  let d0 = 0;
  let d1 = 0;
  if (doorAt !== null && bays > 0) {
    doorBay = Math.min(bays - 1, Math.max(0, Math.floor(doorAt / bw)));
    const g0 = doorBay * bw + PIER / 2 + 0.08;
    const g1 = (doorBay + 1) * bw - PIER / 2 - 0.08;
    if (g1 - g0 < 0.9) {
      doorBay = -1;
    } else {
      const dw = Math.min(2.2, g1 - g0);
      const dc = (g0 + g1) / 2;
      d0 = dc - dw / 2;
      d1 = dc + dw / 2;
    }
  }

  /* Stall riser, in dark stone, standing a little proud — broken at the door. */
  const riser = (a: number, c: number) => {
    if (c - a < 0.02) return;
    wallSpan(pen, b, f, a, c, yLo, SILL, T_BASALT);
    quad(
      pen, b,
      fx(f, a, 0.1), yLo, fz(f, a, 0.1), fx(f, c, 0.1), yLo, fz(f, c, 0.1),
      fx(f, c, 0.1), SILL, fz(f, c, 0.1), fx(f, a, 0.1), SILL, fz(f, a, 0.1),
      f.nx, 0, f.nz, f.u0 + a, 0, f.u0 + c, 0, f.u0 + c, RISER, f.u0 + a, RISER,
      T_BASALT, 0, 0, 0, 0,
    );
  };
  if (doorBay >= 0) {
    riser(0, d0);
    riser(d1, f.len);
  } else {
    riser(0, f.len);
  }

  for (let i = 0; i < bays; i++) {
    const s0 = i * bw;
    const s1 = s0 + bw;
    /* Pilaster at each bay edge, 0.22 m proud — an awning still clears it. */
    for (const s of [s0, s1]) {
      if (s !== s0 && s < f.len - 0.01) continue;
      const a = Math.max(0, s - PIER / 2);
      const c = Math.min(f.len, s + PIER / 2);
      wallSpan(pen, b, f, a, c, SILL, FASCIA, frameTone);
      quad(
        pen, b,
        fx(f, a, 0.22), yLo, fz(f, a, 0.22), fx(f, c, 0.22), yLo, fz(f, c, 0.22),
        fx(f, c, 0.22), FASCIA, fz(f, c, 0.22), fx(f, a, 0.22), FASCIA, fz(f, a, 0.22),
        f.nx, 0, f.nz, 0, 0, c - a, 0, c - a, FASCIA - yLo, 0, FASCIA - yLo,
        frameTone, 0, 0, 0, 0,
      );
    }
    const g0 = s0 + PIER / 2 + 0.08;
    const g1 = s1 - PIER / 2 - 0.08;
    if (g1 - g0 < 0.7) {
      wallSpan(pen, b, f, g0, g1, SILL, FASCIA, frameTone);
      continue;
    }

    if (i === doorBay) {
      /* Floor to head, deeply recessed, with a transom over it. */
      wallSpan(pen, b, f, g0, d0, SILL, FASCIA, frameTone);
      wallSpan(pen, b, f, d1, g1, SILL, FASCIA, frameTone);
      opening(pen, f, d0, d1, yLo, yLo + 2.45, d0, d1, yLo + 0.03, yLo + 2.45, 0.85, frameTone, P_DARK, 2);
      opening(
        pen, f, d0, d1, yLo + 2.45, FASCIA, d0 + 0.12, d1 - 0.12,
        yLo + 2.62, Math.max(yLo + 2.9, Math.min(HEAD, FASCIA - 0.25)), 0.35, frameTone, P_SHOP, 2,
      );
      /* Threshold, so the door meets the pavement rather than hovering. */
      boxAt(pen, b, fx(f, (d0 + d1) / 2, 0.28), yLo + 0.05, fz(f, (d0 + d1) / 2, 0.28),
        (d1 - d0) / 2 + 0.15, 0.05, 0.32, Math.atan2(f.tz, f.tx), T_BASALT);
      continue;
    }

    /* Glazing: sill on the riser, head under the fascia. */
    wallSpan(pen, b, f, g0, g1, HEAD, FASCIA, frameTone);
    const divs = Math.max(2, Math.round((g1 - g0) / 1.3));
    const key = Math.floor(f.u0 + (g0 + g1) * 0.5) % 97;
    quad(
      pen, pen.pane,
      fx(f, g0, -0.28), SILL, fz(f, g0, -0.28), fx(f, g1, -0.28), SILL, fz(f, g1, -0.28),
      fx(f, g1, -0.28), HEAD, fz(f, g1, -0.28), fx(f, g0, -0.28), HEAD, fz(f, g0, -0.28),
      f.nx, 0, f.nz, key, 0, key + 1, 0, key + 1, 1, key, 1,
      P_SHOP, divs, divs, divs, divs,
    );
    /* Reveals around the glazing, and a sill that sheds water outward. */
    const rev = (s: number, dir: number) => {
      quad(
        pen, b,
        fx(f, s), SILL, fz(f, s), fx(f, s, -0.28), SILL, fz(f, s, -0.28),
        fx(f, s, -0.28), HEAD, fz(f, s, -0.28), fx(f, s), HEAD, fz(f, s),
        f.tx * dir, 0, f.tz * dir, 0, 0, 0.28, 0, 0.28, HEAD - yLo, 0, HEAD - yLo,
        frameTone, 0, 0, 0, 0,
      );
    };
    rev(g0, 1);
    rev(g1, -1);
    quad(
      pen, b,
      fx(f, g0, -0.28), SILL, fz(f, g0, -0.28), fx(f, g1, -0.28), SILL, fz(f, g1, -0.28),
      fx(f, g1, 0.16), SILL - 0.05, fz(f, g1, 0.16), fx(f, g0, 0.16), SILL - 0.05, fz(f, g0, 0.16),
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

/**
 * A polygon as a handful of axis-aligned boxes that fit *inside* it.
 *
 * `world.ts` collides and stands against axis-aligned boxes, and the lots are
 * trapezoids at every angle on the compass — so one bounding box around a lot
 * sticks nearly three metres past its own walls, which on a five-metre
 * pavement is an invisible wall in the street and a roof you can stand on
 * over thin air. Three strips, each clipped to the polygon's own extent
 * across the strip, are inside the lot everywhere and within half a metre of
 * its edge. Rectangular buildings collapse back to a single box for free.
 */
function stripBoxes(poly: P2[]): Array<{ cx: number; cz: number; hx: number; hz: number }> {
  const bb = bboxOf(poly);
  if (bb.hx < 0.2 || bb.hz < 0.2) return [];
  // Cut across the long axis so each strip is as square as it can be.
  const alongX = bb.hx >= bb.hz;
  const lo = alongX ? bb.cx - bb.hx : bb.cz - bb.hz;
  const span = (alongX ? bb.hx : bb.hz) * 2;
  const strips = Math.max(2, Math.min(10, Math.round(span / 3.2)));

  /** Where the polygon starts and stops along the other axis, at `t`. */
  const cross = (t: number): [number, number] | null => {
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const p = poly[i];
      const q = poly[j];
      const p0 = alongX ? p.x : p.z;
      const q0 = alongX ? q.x : q.z;
      if (p0 > t === q0 > t) continue;
      const p1 = alongX ? p.z : p.x;
      const q1 = alongX ? q.z : q.x;
      const v = p1 + ((t - p0) / (q0 - p0)) * (q1 - p1);
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    return mx > mn ? [mn, mx] : null;
  };

  /**
   * Two intervals per strip and a bounded compromise between them.
   *
   * The intersection — what the whole strip has in common — fits strictly
   * inside the polygon and, on a trapezoid standing at forty-five degrees to
   * the axes, covers less than half of it: you could walk into the corner of
   * every building in the city. The union covers all of it and sticks out
   * into the street. So the box takes the intersection and is allowed to grow
   * `SLOP` metres toward the union, never past it — and `SLOP` is smaller than
   * the metre and a bit every building is already inset inside its lot, so the
   * overshoot lands in the dead ground behind the kerb and never on it.
   */
  const SLOP = 1.0;
  const bands: Array<{ s0: number; s1: number; mn: number; mx: number }> = [];
  for (let k = 0; k < strips; k++) {
    const s0 = lo + (span * k) / strips;
    const s1 = lo + (span * (k + 1)) / strips;
    let imn = -Infinity;
    let imx = Infinity;
    let umn = Infinity;
    let umx = -Infinity;
    let ok = false;
    for (let q = 0; q <= 4; q++) {
      const t = s0 + ((s1 - s0) * q) / 4 + (q === 0 ? 1e-3 : q === 4 ? -1e-3 : 0);
      const c = cross(t);
      if (!c) continue;
      ok = true;
      imn = Math.max(imn, c[0]);
      imx = Math.min(imx, c[1]);
      umn = Math.min(umn, c[0]);
      umx = Math.max(umx, c[1]);
    }
    if (!ok) continue;
    const mn = Math.max(umn, imn - SLOP);
    const mx = Math.min(umx, imx + SLOP);
    if (mx - mn < 0.4) continue;
    const last = bands[bands.length - 1];
    // A rectangular building collapses back to one box, for free.
    if (last && last.s1 === s0 && Math.abs(last.mn - mn) < 0.05 && Math.abs(last.mx - mx) < 0.05) {
      last.s1 = s1;
      continue;
    }
    bands.push({ s0, s1, mn, mx });
  }
  if (!bands.length) return [{ cx: bb.cx, cz: bb.cz, hx: bb.hx * 0.55, hz: bb.hz * 0.55 }];

  return bands.map((d) => {
    const cA = (d.s0 + d.s1) / 2;
    const hA = (d.s1 - d.s0) / 2;
    const cB = (d.mn + d.mx) / 2;
    const hB = (d.mx - d.mn) / 2;
    return alongX ? { cx: cA, cz: cB, hx: hA, hz: hB } : { cx: cB, cz: cA, hx: hB, hz: hA };
  });
}

function addBox(pen: Pen, poly: P2[], top: number, bottom: number): void {
  for (const b of stripBoxes(poly)) {
    pen.blockers.push({ x: b.cx, z: b.cz, hx: b.hx, hz: b.hz, top, bottom });
  }
}

function addDeck(pen: Pen, poly: P2[], y: number): void {
  for (const b of stripBoxes(poly)) {
    pen.decks.push({ y, x: b.cx, z: b.cz, hx: b.hx, hz: b.hz });
  }
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

  /* ---- the plan shape ----
   *
   * Twenty-three towers extruded straight off their lots read from the
   * pavement as a bundle of cylinders, because a chorded trapezoid seen from
   * below *is* a cylinder. A few of them being a genuinely different shape —
   * corners cut away, or a slab standing across the lot with its broad face
   * to the street — is most of what makes the group read as a skyline rather
   * than as a bundle.
   *
   * Every variant only ever shrinks the footprint, and the plinth keeps the
   * whole lot underneath it either way, so none of this can put a wall over a
   * pavement or move a shopfront.
   */
  const shape = rng.range(0, 1);
  let shaft = base;
  if (shape < 0.30) {
    const cut = chamferPoly(base, rng.range(2.4, 5.0));
    if (cut && areaOf(cut) > areaOf(base) * 0.55) shaft = cut;
  } else if (shape < 0.52) {
    const bb = bboxOf(base);
    const across = Math.atan2(lot.frontNormal.z, lot.frontNormal.x);
    const squeezed = offsetPoly(base, squeezeOffsets(base, across, Math.min(bb.hx, bb.hz) * 0.7));
    if (squeezed && areaOf(squeezed) > areaOf(base) * 0.30) shaft = squeezed;
  }

  /* ---- shaft, stepping in as it rises ---- */
  const segs = rng.int(2, 3);
  const setback = rng.range(1.3, 2.8);
  /* Half of them step back evenly and half step back toward the street, which
     is the difference between a wedding cake and a building. */
  const lean = rng.chance(0.5)
    ? squeezeOffsets(shaft, lot.a, setback * 1.4, setback * 0.45)
    : null;
  const weights = segs === 2 ? [0.66, 0.34] : [0.52, 0.31, 0.17];
  let cur = shaft;
  let yA = y0 + plinthH + 0.9;
  const span = shaftTop - yA;
  for (let k = 0; k < segs && span > 6; k++) {
    if (k > 0) {
      /* A setback that will not fit is skipped, never fatal. Bailing out of
       * the loop leaves the shaft short of `shaftTop` and the tower lands
       * forty metres below the height the plan gave it — which is invisible
       * from the pavement and obvious in the skyline the plan was written to
       * shape. */
      const next = offsetPoly(cur, lean ?? setback);
      if (next) cur = next;
    }
    const yB = k === segs - 1 ? shaftTop : yA + span * weights[k];
    const shell = shellOf(cur);
    prismWalls(pen, pen.glass, shell, yA, yB, k === 0 ? W_MAIN : W_UPPER);
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
    const inset = Math.min(6, bboxOf(cur).hx * 0.55);
    const tip = offsetPoly(cur, inset);
    if (tip) {
      loft(pen, pen.glass, cur, roofY, tip, roofY + crownH, W_CROWN);
      capPoly(pen, pen.stone, tip, roofY + crownH, 1, T_METAL);
      /* Not gated on the tier: anything with height in it is silhouette, and
       * the silhouette is what the lake shows. Only reveals, balconies and
       * signage come off at the low tier. */
      const c = centroidOf(tip);
      tube(pen, pen.glow, c.x, c.z, 0.6, 0.2, roofY + crownH, roofY + crownH + 6, 5, G_WHITE);
      /* Four slabs following the taper, rather than one box at the shaft's
         own width all the way to the tip. That box is the easy thing and it
         is a floor of clear air standing thirty metres above the roof, out
         where the spire has visibly sloped away from under you — you land on
         nothing, beside a wall that is not there. */
      let prevY = roofY;
      for (let k = 1; k <= 4; k++) {
        const slab = k === 4 ? tip : (offsetPoly(cur, (inset * k) / 4) ?? tip);
        const y = roofY + (crownH * k) / 4;
        addBox(pen, slab, y, prevY);
        prevY = y;
      }
    } else {
      cornice(pen, topShell, roofY, 1.2, 0.4, T_STONE, true);
      addBox(pen, cur, roofY + crownH, roofY);
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
    const c = centroidOf(cur);
    boxAt(pen, pen.stone, c.x, roofY + 5.6, c.z, 3.2, 1.9, 2.6, lot.a, T_ROOF);
  } else {
    let step = cur;
    let sy = roofY;
    for (let k = 0; k < 3; k++) {
      const next = offsetPoly(step, 2.1);
      if (!next) break;
      prismWalls(pen, pen.glass, shellOf(next), sy, sy + 5, W_CROWN);
      capPoly(pen, pen.stone, next, sy + 5, 1, T_ROOF);
      cornice(pen, shellOf(next), sy + 5, 0.7, 0.3, T_STONE, k === 2);
      addBox(pen, next, sy + 5, sy);
      step = next;
      sy += 5;
    }
    addDeck(pen, step, sy + 0.7);
  }
  if (crownKind === 1) addBox(pen, cur, roofY + 1.2, roofY);
  if (crownKind === 2) addBox(pen, cur, roofY + 3.7, roofY);
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
    const c = centroidOf(parapet);
    boxAt(pen, pen.stone, c.x, y0 + h + 1.2, c.z, 1.8, 1.2, 1.4, lot.a, T_ROOF);
    /* A planted roof, because this city is optimistic and half its terraces
       are gardens. */
    if (rng.chance(0.4)) capPoly(pen, pen.stone, parapet, y0 + h + 0.12, 1, T_LEAF);
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
  if (rng.chance(0.5)) {
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
    /* Outward from the wall and stacked, deepest tread at the bottom. Inward
       would bury the whole flight inside a solid podium — which is what the
       first pass did, and a civic building with no way in is a warehouse. */
    for (let k = 0; k < 3; k++) {
      const depth = (3 - k) * 0.34;
      const rise = ((k + 1) * podiumH) / 3;
      boxAt(pen, pen.stone, fx(f, s, depth / 2), y0 + rise / 2, fz(f, s, depth / 2),
        w / 2, rise / 2, depth / 2, rot, T_STONE);
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
    }
    {
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
    if (hedge) {
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

/* -------------------------------------------------------------------------
 * Landmarks
 *
 * Hand-built, every one, because that is the point of them: a procedural city
 * can make a thousand plausible buildings and not one place you would agree
 * to meet somebody. They go into the same four buckets as everything else, so
 * six landmarks cost zero extra draw calls.
 * ---------------------------------------------------------------------- */

function ngon(cx: number, cz: number, r: number, sides: number, phase = 0): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = phase + (i / sides) * TAU;
    out.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r });
  }
  return out;
}

/** A faceted tube between two arbitrary points. Ribs, telescopes, struts. */
function strut(
  pen: Pen,
  b: Bucket,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  r: number,
  sides: number,
  tone: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz) || 1;
  const ax = dx / len;
  const ay = dy / len;
  const az = dz / len;
  // Any vector not parallel to the axis gives a usable first basis vector.
  let ux = -ay;
  let uy = ax;
  let uz = 0;
  if (Math.hypot(ux, uy, uz) < 1e-4) {
    ux = 1;
    uy = 0;
    uz = 0;
  }
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = ay * uz - az * uy;
  const vy = az * ux - ax * uz;
  const vz = ax * uy - ay * ux;
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * TAU;
    const a1 = ((i + 1) / sides) * TAU;
    const c0 = Math.cos(a0);
    const s0 = Math.sin(a0);
    const c1 = Math.cos(a1);
    const s1 = Math.sin(a1);
    const nx = (ux * (c0 + c1) + vx * (s0 + s1)) / 2;
    const ny = (uy * (c0 + c1) + vy * (s0 + s1)) / 2;
    const nz = (uz * (c0 + c1) + vz * (s0 + s1)) / 2;
    const nl = Math.hypot(nx, ny, nz) || 1;
    quad(
      pen, b,
      x0 + (ux * c0 + vx * s0) * r, y0 + (uy * c0 + vy * s0) * r, z0 + (uz * c0 + vz * s0) * r,
      x0 + (ux * c1 + vx * s1) * r, y0 + (uy * c1 + vy * s1) * r, z0 + (uz * c1 + vz * s1) * r,
      x1 + (ux * c1 + vx * s1) * r, y1 + (uy * c1 + vy * s1) * r, z1 + (uz * c1 + vz * s1) * r,
      x1 + (ux * c0 + vx * s0) * r, y1 + (uy * c0 + vy * s0) * r, z1 + (uz * c0 + vz * s0) * r,
      nx / nl, ny / nl, nz / nl,
      a0 * r, 0, a1 * r, 0, a1 * r, len, a0 * r, len,
      tone, 0.4, 0.4, 0.4, 0.4,
    );
  }
}

/**
 * The Beacon. Five hundred metres, at the exact middle, and the navigational
 * anchor of the whole map — from the ice it is the one thing you can see, and
 * from anywhere on the deck it tells you which way the centre is.
 *
 * A stepped stone base, a tapering eight-sided glass shaft with collars, a
 * public gallery at 420 m that you can land a jetpack on, a flared lantern
 * and a mast.
 */
function buildBeacon(pen: Pen, lm: Landmark): void {
  const y0 = lm.y;
  const TOP = 500;
  pen.baseY = y0;
  pen.span = TOP;
  pen.seed = 42;
  const detail = pen.quality === "high";

  /* Base. */
  tube(pen, pen.stone, lm.x, lm.z, 24, 22.5, y0, y0 + 8, 8, T_BASALT, false);
  tube(pen, pen.stone, lm.x, lm.z, 21, 20, y0 + 8, y0 + 14, 8, T_STONE, true, 0.2);
  if (detail) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.4;
      const p0 = { x: lm.x + Math.cos(a) * 21.5, z: lm.z + Math.sin(a) * 21.5 };
      const a1 = a + TAU / 8;
      const p1 = { x: lm.x + Math.cos(a1) * 21.5, z: lm.z + Math.sin(a1) * 21.5 };
      const nrm = { x: Math.cos((a + a1) / 2), z: Math.sin((a + a1) / 2) };
      glowStrip(pen, p0.x, p0.z, p1.x, p1.z, y0 + 12.6, y0 + 13.6, nrm.x, nrm.z, G_WARM);
    }
  }
  addBox(pen, ngon(lm.x, lm.z, 24, 8), y0 + 14, y0);
  addDeck(pen, ngon(lm.x, lm.z, 21, 8), y0 + 14);

  /* Shaft: five tapering segments with a collar at every joint. */
  const stations = [14, 96, 190, 280, 356, 418];
  const radii = [15, 13.4, 11.2, 9.0, 7.0, 5.6];
  for (let i = 0; i + 1 < stations.length; i++) {
    tube(pen, pen.glass, lm.x, lm.z, radii[i], radii[i + 1], y0 + stations[i], y0 + stations[i + 1], 8, W_MAIN, false);
    tube(pen, pen.stone, lm.x, lm.z, radii[i + 1] + 0.7, radii[i + 1] + 0.7,
      y0 + stations[i + 1] - 1.1, y0 + stations[i + 1] + 1.1, 8, T_METAL, false);
  }
  addBox(pen, ngon(lm.x, lm.z, 15, 8), y0 + 418, y0 + 14);

  /* The gallery: a real place, with a floor and a rail. */
  const gallery = ngon(lm.x, lm.z, 13, 16);
  tube(pen, pen.stone, lm.x, lm.z, 13, 13, y0 + 418, y0 + 420, 16, T_STONE, false);
  capPoly(pen, pen.stone, gallery, y0 + 420, 1, T_ROOF);
  ringWall(pen, gallery, 0.4, y0 + 420, y0 + 421.2, T_METAL);
  addDeck(pen, gallery, y0 + 420);
  addBox(pen, ngon(lm.x, lm.z, 6.2, 8), y0 + 458, y0 + 420);
  if (detail) {
    const gs = shellOf(gallery);
    for (let i = 0; i < gs.n; i++) {
      const p = gallery[i];
      const q = gallery[(i + 1) % gs.n];
      glowStrip(pen, p.x, p.z, q.x, q.z, y0 + 418.4, y0 + 419.6, gs.nrm[i].x, gs.nrm[i].z, G_COOL);
    }
  }

  /* Lantern and mast. */
  tube(pen, pen.glass, lm.x, lm.z, 5.6, 9, y0 + 421, y0 + 440, 8, W_MAIN, false);
  tube(pen, pen.glass, lm.x, lm.z, 9, 3.6, y0 + 440, y0 + 458, 8, W_MAIN, true);
  tube(pen, pen.glow, lm.x, lm.z, 8.4, 8.4, y0 + 426, y0 + 438, 8, G_WARM, false);
  tube(pen, pen.stone, lm.x, lm.z, 1.3, 0.4, y0 + 458, y0 + TOP - 6, 6, T_METAL, false);
  tube(pen, pen.glow, lm.x, lm.z, 1.1, 0.2, y0 + TOP - 6, y0 + TOP, 5, G_WHITE, false);
}

/** A dome with a telescope in it, at the rim, pointed off the edge. */
function buildObservatory(pen: Pen, lm: Landmark): void {
  const y0 = lm.y;
  pen.baseY = y0;
  pen.span = 34;
  pen.seed = 7;
  const detail = pen.quality === "high";

  const podium = ngon(lm.x, lm.z, 16.5, 16);
  prismWalls(pen, pen.stone, shellOf(podium), y0, y0 + 1.1, T_BASALT);
  capPoly(pen, pen.stone, podium, y0 + 1.1, 1, T_STONE);

  const drum = ngon(lm.x, lm.z, 12.5, 16);
  const dShell = shellOf(drum);
  for (let i = 0; i < dShell.n; i++) {
    const f = faceOf(dShell, i);
    facade(pen, f, y0 + 1.1, y0 + 13, {
      floorH: 11.9, bayW: f.len, winW: f.len * 0.5, winH: 5.4, sill: 2.6,
      depth: 0.55, tone: T_STONE, paneKind: P_WINDOW, detail,
    });
  }
  cornice(pen, dShell, y0 + 13, 1.1, 0.8, T_STONE, true);
  capPoly(pen, pen.stone, drum, y0 + 14.1, 1, T_ROOF);

  /* Dome, with the shutter open along the landmark's own facing. */
  let a = lm.yaw % TAU;
  if (a < 0) a += TAU;
  const from = Math.max(0.001, a - 0.32);
  const to = Math.min(TAU - 0.001, a + 0.32);
  dome(pen, pen.stone, lm.x, y0 + 14.1, lm.z, 12.5, 7, 16, T_METAL, { from, to });

  /* The telescope, aimed out through the shutter and off the edge. */
  const tilt = 0.62;
  const dx = Math.cos(a);
  const dz = Math.sin(a);
  const cx = lm.x - dx * 2.5;
  const cz = lm.z - dz * 2.5;
  const cy = y0 + 17.5;
  strut(pen, pen.stone, cx, cy, cz,
    cx + dx * Math.cos(tilt) * 15, cy + Math.sin(tilt) * 15, cz + dz * Math.cos(tilt) * 15,
    1.5, 8, T_METAL);
  boxAt(pen, pen.stone, cx - dz * 3.4, cy - 1.6, cz + dx * 3.4, 0.4, 2.6, 0.4, a, T_BASALT);
  boxAt(pen, pen.stone, cx + dz * 3.4, cy - 1.6, cz - dx * 3.4, 0.4, 2.6, 0.4, a, T_BASALT);

  /* A gallery around the drum, and the rail to lean on. */
  const walk = ngon(lm.x, lm.z, 15.6, 16);
  capPoly(pen, pen.stone, walk, y0 + 1.1, 1, T_ROOF);
  ringWall(pen, walk, 0.35, y0 + 1.1, y0 + 2.2, T_METAL);
  addBox(pen, drum, y0 + 14.1, y0);
  addDeck(pen, podium, y0 + 1.1);
  addDeck(pen, drum, y0 + 14.1);
}

/** Iron and glass over a big vaulted span. Loud, warm, and open late. */
function buildMarketHall(pen: Pen, lm: Landmark): void {
  const y0 = lm.y;
  pen.baseY = y0;
  pen.span = 24;
  pen.seed = 19;
  const detail = pen.quality === "high";

  const L = 58;
  const Wd = 30;
  const WALL = 8.5;
  const VAULT = 13;
  const fxv = Math.cos(lm.yaw);
  const fzv = Math.sin(lm.yaw);
  const rxv = -Math.sin(lm.yaw);
  const rzv = Math.cos(lm.yaw);
  const at = (s: number, t: number) => ({ x: lm.x + fxv * s + rxv * t, z: lm.z + fzv * s + rzv * t });

  const rect: P2[] = [at(-L / 2, -Wd / 2), at(L / 2, -Wd / 2), at(L / 2, Wd / 2), at(-L / 2, Wd / 2)];
  const shell = shellOf(rect);
  for (let i = 0; i < shell.n; i++) {
    const f = faceOf(shell, i);
    facade(pen, f, y0, y0 + WALL, {
      floorH: WALL, bayW: 6.2, winW: 3.6, winH: 5.2, sill: 1.8,
      depth: 0.6, tone: T_TERRA, paneKind: P_SHOP, detail,
    });
  }
  cornice(pen, shell, y0 + WALL, 0.9, 0.7, T_STONE, true);

  /* The vault: iron ribs every five metres with glazing spanning between. */
  /* Constant at both tiers: the vault is the silhouette, and the
     silhouette is what the lake shows. */
  const RIBS = 13;
  const ARC = 11;
  const arcPt = (s: number, k: number) => {
    const th = (k / ARC) * Math.PI;
    return {
      p: at(s, -Math.cos(th) * (Wd / 2)),
      y: y0 + WALL + 0.9 + Math.sin(th) * VAULT,
      nx: -Math.cos(th),
      ny: Math.sin(th),
    };
  };
  for (let i = 0; i < RIBS; i++) {
    const s = -L / 2 + (L * i) / (RIBS - 1);
    for (let k = 0; k < ARC; k++) {
      const a0 = arcPt(s, k);
      const a1 = arcPt(s, k + 1);
      strut(pen, pen.stone, a0.p.x, a0.y, a0.p.z, a1.p.x, a1.y, a1.p.z, 0.24, 5, T_METAL);
    }
  }
  for (let i = 0; i + 1 < RIBS; i++) {
    const s0 = -L / 2 + (L * i) / (RIBS - 1);
    const s1 = -L / 2 + (L * (i + 1)) / (RIBS - 1);
    for (let k = 0; k < ARC; k++) {
      const a0 = arcPt(s0, k);
      const b0 = arcPt(s1, k);
      const a1 = arcPt(s0, k + 1);
      const b1 = arcPt(s1, k + 1);
      const nx = ((a0.nx + a1.nx) / 2) * rxv;
      const nz = ((a0.nx + a1.nx) / 2) * rzv;
      const ny = (a0.ny + a1.ny) / 2;
      quad(
        pen, pen.pane,
        a0.p.x, a0.y, a0.p.z, b0.p.x, b0.y, b0.p.z, b1.p.x, b1.y, b1.p.z, a1.p.x, a1.y, a1.p.z,
        nx, ny, nz,
        0, 0, 1, 0, 1, 1, 0, 1,
        P_SHOP, 3, 3, 3, 3,
      );
    }
  }
  /* Fan windows in the two gable ends. */
  for (const end of [-1, 1]) {
    const s = (end * L) / 2;
    const apex = { p: at(s, 0), y: y0 + WALL + 0.9 };
    for (let k = 0; k < ARC; k++) {
      const a0 = arcPt(s, k);
      const a1 = arcPt(s, k + 1);
      quad(
        pen, pen.pane,
        a0.p.x, a0.y, a0.p.z, a1.p.x, a1.y, a1.p.z,
        apex.p.x, apex.y + VAULT * 0.02, apex.p.z, apex.p.x, apex.y + VAULT * 0.02, apex.p.z,
        fxv * end, 0, fzv * end, 0, 0, 1, 0, 1, 1, 1, 1,
        P_SHOP, 2, 2, 2, 2,
      );
      if (detail) {
        strut(pen, pen.stone, a0.p.x, a0.y, a0.p.z, apex.p.x, apex.y, apex.p.z, 0.16, 4, T_METAL);
      }
    }
  }

  addBox(pen, rect, y0 + WALL + 0.9, y0);
  addDeck(pen, rect, y0 + WALL + 0.9);
}

/** A low control tower beside the pads. Painted circles are `streets.ts`. */
function buildLaunch(pen: Pen, lm: Landmark): void {
  const y0 = lm.y;
  pen.baseY = y0;
  pen.span = 26;
  pen.seed = 63;
  const detail = pen.quality === "high";

  const shaft = ngon(lm.x, lm.z, 5.2, 8);
  const sShell = shellOf(shaft);
  for (let i = 0; i < sShell.n; i++) {
    facade(pen, faceOf(sShell, i), y0, y0 + 13.5, {
      floorH: 4.5, bayW: 4.2, winW: 1.5, winH: 1.8, sill: 1.2,
      depth: 0.4, tone: T_STONE, paneKind: P_WINDOW, detail,
    });
  }
  /* The control room leans out over the pads, the way they always do. */
  tube(pen, pen.glass, lm.x, lm.z, 5.6, 7.6, y0 + 13.5, y0 + 18.4, 8, W_MAIN, false);
  const room = ngon(lm.x, lm.z, 7.6, 8);
  capPoly(pen, pen.stone, room, y0 + 18.4, 1, T_ROOF);
  cornice(pen, shellOf(room), y0 + 18.4, 0.6, 0.4, T_METAL, true);
  tube(pen, pen.stone, lm.x, lm.z, 0.5, 0.2, y0 + 19, y0 + 25, 5, T_METAL, false);
  tube(pen, pen.glow, lm.x, lm.z, 0.8, 0.25, y0 + 25, y0 + 27, 5, G_WARM, false);
  addBox(pen, room, y0 + 19, y0);
  addDeck(pen, room, y0 + 19);

  /* An ancillary block, at the yaw side. */
  const bx = lm.x + Math.cos(lm.yaw + Math.PI / 2) * 14;
  const bz = lm.z + Math.sin(lm.yaw + Math.PI / 2) * 14;
  const low: P2[] = [
    { x: bx - 7, z: bz - 5 }, { x: bx + 7, z: bz - 5 },
    { x: bx + 7, z: bz + 5 }, { x: bx - 7, z: bz + 5 },
  ];
  const lShell = shellOf(low);
  for (let i = 0; i < lShell.n; i++) {
    facade(pen, faceOf(lShell, i), y0, y0 + 4.6, {
      floorH: 4.6, bayW: 4.0, winW: 1.8, winH: 2.0, sill: 1.4,
      depth: 0.35, tone: T_TERRA, paneKind: P_WINDOW, detail,
    });
  }
  cornice(pen, lShell, y0 + 4.6, 0.5, 0.45, T_STONE, true);
  capPoly(pen, pen.stone, low, y0 + 5.1, 1, T_ROOF);
  addBox(pen, low, y0 + 5.1, y0);
  addDeck(pen, low, y0 + 5.1);
}

/** A platform and a canopy. The ring tram, every ninety seconds. */
function buildTram(pen: Pen, lm: Landmark): void {
  const y0 = lm.y;
  pen.baseY = y0;
  pen.span = 6;
  pen.seed = 31;
  const fxv = Math.cos(lm.yaw + Math.PI / 2);
  const fzv = Math.sin(lm.yaw + Math.PI / 2);
  const rxv = -fzv;
  const rzv = fxv;
  const at = (s: number, t: number) => ({ x: lm.x + fxv * s + rxv * t, z: lm.z + fzv * s + rzv * t });
  const L = 24;
  const Wd = 7.5;

  const plat: P2[] = [at(-L / 2, -Wd / 2), at(L / 2, -Wd / 2), at(L / 2, Wd / 2), at(-L / 2, Wd / 2)];
  prismWalls(pen, pen.stone, shellOf(plat), y0, y0 + 0.85, T_BASALT);
  capPoly(pen, pen.stone, plat, y0 + 0.85, 1, T_STONE);
  for (const end of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const p = at((end * (L / 2 + 0.4 + k * 0.4)), 0);
      boxAt(pen, pen.stone, p.x, y0 + ((3 - k) * 0.85) / 3 / 2, p.z, 0.42, ((3 - k) * 0.85) / 3 / 2, Wd / 2, lm.yaw, T_STONE);
    }
  }

  const canopyY = y0 + 4.6;
  for (const t of [-Wd / 2 + 1.1, Wd / 2 - 1.1]) {
    for (let k = 0; k < 3; k++) {
      const p = at(-L / 2 + 2.5 + ((L - 5) * k) / 2, t);
      tube(pen, pen.stone, p.x, p.z, 0.24, 0.2, y0 + 0.85, canopyY, 6, T_METAL, false);
    }
  }
  const canopy: P2[] = [at(-L / 2 - 1, -Wd / 2 - 1), at(L / 2 + 1, -Wd / 2 - 1), at(L / 2 + 1, Wd / 2 + 1), at(-L / 2 - 1, Wd / 2 + 1)];
  prismWalls(pen, pen.stone, shellOf(canopy), canopyY, canopyY + 0.5, T_METAL);
  capPoly(pen, pen.stone, canopy, canopyY + 0.5, 1, T_METAL);
  capPoly(pen, pen.stone, canopy, canopyY, -1, T_TIMBER);
  if (pen.quality === "high") {
    const cs = shellOf(canopy);
    for (let i = 0; i < cs.n; i++) {
      const p = canopy[i];
      const q = canopy[(i + 1) % cs.n];
      glowStrip(pen, p.x, p.z, q.x, q.z, canopyY - 0.35, canopyY - 0.02, cs.nrm[i].x, cs.nrm[i].z, G_WARM);
    }
  }
  addDeck(pen, plat, y0 + 0.85);
  addDeck(pen, canopy, canopyY + 0.5);
}

/** The basin and the pedestal. The water is `props.ts`. */
function buildFountain(pen: Pen, lm: Landmark): void {
  const y0 = lm.y;
  pen.baseY = y0;
  pen.span = 6;
  pen.seed = 88;

  const rim = ngon(lm.x, lm.z, 8.4, 24);
  ringWall(pen, rim, 0.7, y0, y0 + 0.85, T_STONE);
  const inner = offsetPoly(rim, 0.7);
  if (inner) capPoly(pen, pen.stone, inner, y0 + 0.18, 1, T_BASALT);
  tube(pen, pen.stone, lm.x, lm.z, 2.6, 2.2, y0 + 0.18, y0 + 1.5, 12, T_STONE);
  tube(pen, pen.stone, lm.x, lm.z, 1.5, 1.2, y0 + 1.5, y0 + 3.4, 12, T_STONE, false);
  tube(pen, pen.stone, lm.x, lm.z, 2.4, 0.6, y0 + 3.4, y0 + 4.1, 12, T_METAL);
  addDeck(pen, ngon(lm.x, lm.z, 2.6, 12), y0 + 1.5);
}

/** A pair of piers and a lintel. Nothing in the plan is a gate yet. */
function buildGate(pen: Pen, lm: Landmark): void {
  const y0 = lm.y;
  pen.baseY = y0;
  pen.span = 9;
  pen.seed = 5;
  const rx = -Math.sin(lm.yaw);
  const rz = Math.cos(lm.yaw);
  for (const s of [-4, 4]) {
    tube(pen, pen.stone, lm.x + rx * s, lm.z + rz * s, 1.3, 1.0, y0, y0 + 7, 6, T_STONE);
  }
  boxAt(pen, pen.stone, lm.x, y0 + 7.7, lm.z, 5.4, 0.7, 1.2, lm.yaw, T_STONE);
}

function buildLandmark(pen: Pen, lm: Landmark): void {
  switch (lm.kind) {
    case "beacon":
      buildBeacon(pen, lm);
      break;
    case "observatory":
      buildObservatory(pen, lm);
      break;
    case "market-hall":
      buildMarketHall(pen, lm);
      break;
    case "launch":
      buildLaunch(pen, lm);
      break;
    case "tram":
      buildTram(pen, lm);
      break;
    case "fountain":
      buildFountain(pen, lm);
      break;
    case "gate":
      buildGate(pen, lm);
      break;
  }
}

/* -------------------------------------------------------------------------
 * The system
 * ---------------------------------------------------------------------- */

function makeMaterial(name: string, frag: string, glow: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name,
    vertexShader: VERT,
    fragmentShader: frag,
    uniforms: {
      uTime: { value: 0 },
      /* Two of them, and confusing them is the trap `types.ts` documents at
       * length: `uDaylight` is the lamp switch and reads 0.32 at the hour this
       * world is painted at; `uSunUp` is how much sun there is. Windows and
       * signage want the first. Anything shading a surface wants the second. */
      uDaylight: { value: 1 },
      uSunUp: { value: 1 },
      uCam: { value: new THREE.Vector3() },
      uSun: { value: SUN_DIR.clone() },
    },
    // Every material here is double-sided, and not out of laziness: the lake
    // copy is this same geometry with scale.y = -1, which inverts winding.
    side: THREE.DoubleSide,
    // `fwidth` is core in the GLSL ES 3.00 this compiles to on WebGL2 and
    // every facade pattern in here is filtered against it; the flag only
    // matters if something ever drops back to WebGL1.
    extensions: { derivatives: true },
    fog: false,
    transparent: glow,
    depthWrite: !glow,
    blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

/**
 * Everything on every lot, and the six landmarks.
 *
 * Reflected, so read the note at the top of the file before touching a
 * gradient in here.
 */
export function buildBuildings(ctx: BuildContext, options?: BuildingsOptions): BuildingsHandle {
  const plan = cityPlan();
  const pen = newPen(ctx.quality);
  const group = new THREE.Group();
  group.name = "empyrean-buildings";
  const skip = options?.skipLots?.length ? new Set(options.skipLots) : null;

  const lots: LotBuild[] = [];
  for (const lot of plan.lots) {
    const before =
      pen.glass.triangles + pen.stone.triangles + pen.pane.triangles + pen.glow.triangles;
    resetBounds(pen);
    /* A skipped lot is not a lot built quietly: nothing is written into any
       bucket, so it contributes no geometry, and `buildLot` is where every
       blocker and deck comes from, so it contributes neither of those
       either. Somebody else is standing in this footprint. */
    if (!skip?.has(lot.id)) buildLot(pen, lot, ctx.seedSalt);
    const after =
      pen.glass.triangles + pen.stone.triangles + pen.pane.triangles + pen.glow.triangles;
    const built = after > before;
    lots.push({
      id: lot.id,
      use: lot.use,
      built,
      top: built ? pen.top : lot.y,
      triangles: after - before,
      min: built ? { ...pen.min } : { x: lot.centroid.x, y: lot.y, z: lot.centroid.z },
      max: built ? { ...pen.max } : { x: lot.centroid.x, y: lot.y, z: lot.centroid.z },
    });
  }
  for (const lm of plan.landmarks) buildLandmark(pen, lm);

  const glassMat = makeMaterial("EmpyreanGlass", GLASS_FRAG, false);
  const stoneMat = makeMaterial("EmpyreanMasonry", STONE_FRAG, false);
  const paneMat = makeMaterial("EmpyreanGlazing", PANE_FRAG, false);
  const glowMat = makeMaterial("EmpyreanSignage", GLOW_FRAG, true);

  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.ShaderMaterial[] = [glassMat, stoneMat, paneMat, glowMat];
  let triangles = 0;
  let vertices = 0;
  const addMesh = (b: Bucket, m: THREE.ShaderMaterial, name: string, order: number) => {
    const geo = finishBucket(b);
    if (!geo) return;
    triangles += b.triangles;
    vertices += b.vertices;
    const mesh = new THREE.Mesh(geo, m);
    mesh.name = name;
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    group.add(mesh);
    geos.push(geo);
  };
  addMesh(pen.stone, stoneMat, "empyrean-masonry", 0);
  addMesh(pen.glass, glassMat, "empyrean-curtainwall", 0);
  addMesh(pen.pane, paneMat, "empyrean-glazing", 0);
  addMesh(pen.glow, glowMat, "empyrean-signage", 2);

  return {
    name: "buildings",
    group,
    reflected: true,
    blockers: pen.blockers,
    decks: pen.decks,
    lots,
    stats: { draws: geos.length, triangles, vertices },
    update(frame: FrameContext) {
      for (let i = 0; i < mats.length; i++) {
        const u = mats[i].uniforms;
        u.uTime.value = frame.time;
        u.uDaylight.value = frame.daylight;
        u.uSunUp.value = frame.gradeDaylight;
        (u.uCam.value as THREE.Vector3).copy(frame.camera.position);
        (u.uSun.value as THREE.Vector3).copy(frame.sunDir);
      }
    },
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      group.clear();
    },
  };
}

/* -------------------------------------------------------------------------
 * Seams for the tests
 *
 * Rebuilding one lot into a private pen is how "no building leaves its lot"
 * becomes a property rather than a hope: the test gets every vertex the lot
 * contributed and measures it against the polygon it was given.
 * ---------------------------------------------------------------------- */

function penPositions(pen: Pen): Float32Array {
  const out: number[] = [];
  for (const b of [pen.glass, pen.stone, pen.pane, pen.glow]) {
    for (const g of b.chunks) {
      const a = g.getAttribute("position");
      for (let i = 0; i < a.count; i++) out.push(a.getX(i), a.getY(i), a.getZ(i));
    }
    for (let i = 0; i < b.verts * 3; i++) out.push(b.pos[i]);
  }
  return new Float32Array(out);
}

/** Every vertex one lot contributes, as flat xyz. */
export function lotVertices(lot: Lot, quality: QualityTier, salt = ""): Float32Array {
  const pen = newPen(quality);
  buildLot(pen, lot, salt);
  return penPositions(pen);
}

/** What one lot contributes to collision, on its own. */
export function lotCollision(
  lot: Lot,
  quality: QualityTier,
  salt = "",
): { blockers: Blocker[]; decks: Deck[]; top: number } {
  const pen = newPen(quality);
  resetBounds(pen);
  buildLot(pen, lot, salt);
  return { blockers: pen.blockers, decks: pen.decks, top: pen.top };
}

/**
 * The distinct `aTone` values one lot writes into the curtain-wall bucket.
 *
 * The tone on the glass is which *piece of tower* a face belongs to, and the
 * only large-scale change of colour a tower is allowed to have. Asserting it
 * is a short list of known slots is how "the variation is structural" stays
 * true: the moment somebody puts a hash in there, this returns two hundred
 * values and the towers are quilted again.
 */
export function lotGlassTones(lot: Lot, quality: QualityTier, salt = ""): number[] {
  const pen = newPen(quality);
  buildLot(pen, lot, salt);
  const out = new Set<number>();
  for (const g of pen.glass.chunks) {
    const a = g.getAttribute("aTone");
    for (let i = 0; i < a.count; i++) out.add(a.getX(i));
  }
  for (let i = 0; i < pen.glass.verts; i++) out.add(pen.glass.tone[i]);
  return [...out].sort((a, b) => a - b);
}

/** Every vertex one landmark contributes, as flat xyz. */
export function landmarkVertices(lm: Landmark, quality: QualityTier): Float32Array {
  const pen = newPen(quality);
  buildLandmark(pen, lm);
  return penPositions(pen);
}

/** How far outside its own lot polygon a point is, in metres. Zero is good. */
export function outsideLot(lot: Lot, x: number, z: number): number {
  return outsideBy(lot.poly, x, z);
}
