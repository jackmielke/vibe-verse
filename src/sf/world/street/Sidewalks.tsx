/**
 * Sidewalks.tsx — the pavement, the kerb and the corner.
 *
 * The kerb is the most-looked-at 150 mm in any city game. It is at eye level
 * for a crouching player, it is what a car climbs when you clip a corner, and
 * its line is what tells you where the street ends without anyone drawing a
 * boundary. So it gets the real number — a six-inch reveal — a real gutter pan,
 * real kerb returns filleted around each corner, the diagonal wheelchair ramp
 * with its truncated-dome panel that every San Francisco corner has had since
 * the 1970s, and the driveway cuts that interrupt the kerb line roughly every
 * third house.
 *
 * The pavement itself carries a 2 % cross-fall away from the property line
 * (which is why rain runs to the gutter and not into the shops), slab joints
 * from the material's own texture at their true 1.5 m pitch, tree wells cut
 * into it at the kerb, and a grime gradient that is darkest right at the kerb
 * where the spray lands.
 *
 * A structural note: the pavement is a platform floating `ROAD_LIFT` above the
 * terrain clipmap, so its outer edge drops a skirt into the ground. Without
 * that skirt you can see under the city from any hillside.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { QUALITY } from "../../config";
import { frame, useSfStore } from "../../state/store";
import { getMaterial, materialWorldScale } from "../../materials";
import { clamp, clamp01, fbm2, gradNoise2, smoothstep } from "../../math/rng";
import { isPark, terrainHeight } from "../../geo/sfGeo";
import { MeshSink, addGroundQuad, addPolygon, rgb, rgbLinear, type RGB } from "./geom";
import { ChunkStreamer, disposeObject, reportPending } from "./chunker";
import {
  KERB_HEIGHT,
  SIDEWALK_WIDTH,
  edgeSpan,
  roadNetwork,
  roadSurface,
  type RoadEdge,
  type RoadNode,
} from "./roadNetwork";
import { drivewayCuts, treeWells } from "./streetFurniture";

/* ------------------------------------------------------------------ *
 * Constants + palette
 * ------------------------------------------------------------------ */

/** Width of the flat top of the kerb stone. */
const KERB_TOP = 0.16;
/** Width of the concrete gutter pan inside the carriageway. */
const GUTTER = 0.55;
/** Cross-fall of the pavement, away from the kerb. */
const CROSSFALL = 0.02;
/** How far the outer apron drops below the pavement to meet the terrain. */
const SKIRT = 2.4;

const _c: RGB = { r: 1, g: 1, b: 1 };
const DOME_PANEL = rgbLinear(0x9a4a32);
const SOIL = rgb(0x4c4034);

/* ------------------------------------------------------------------ *
 * Concrete shading
 * ------------------------------------------------------------------ */

/**
 * The pavement tint.
 *
 * Concrete pours are laid a few slabs at a time over decades, so the dominant
 * variation is at slab scale and it is *age*, not noise: a 1970s slab next to a
 * 2015 slab next to a patch poured around a new water service. On top of that,
 * grime accumulates in a gradient from the kerb inward (road spray) and again
 * against the building line (where nobody walks and nothing washes it).
 */
function concreteTint(x: number, z: number, edgeT: number, out: RGB): RGB {
  // Slab-scale age. 1.5 m slabs, but pours are 4–6 slabs long, so quantise.
  const px = Math.floor(x / 5.4);
  const pz = Math.floor(z / 5.4);
  const pour = ((Math.imul(px, 374761393) ^ Math.imul(pz, 668265263)) >>> 8) / 16777216;
  // Two octaves and one, not five: this runs once per pavement vertex and a
  // whole downtown chunk is thirty thousand of them.
  const macro = fbm2(x * 0.031, z * 0.031, 2, 2.1, 0.5, 4021);
  const fine = gradNoise2(x * 0.31, z * 0.31, 707);

  // edgeT: 0 at the kerb, 1 at the property line.
  const kerbGrime = (1 - smoothstep(0, 0.34, edgeT)) * 0.16;
  const wallGrime = smoothstep(0.72, 1, edgeT) * 0.09;

  let v = 1 + (pour - 0.5) * 0.15 + macro * 0.07 + fine * 0.035 - kerbGrime - wallGrime;
  v = clamp(v, 0.5, 1.24);
  // Older concrete yellows; fresh concrete is cold.
  const warm = pour;
  out.r = v * (1 + warm * 0.035);
  out.g = v * (1 + warm * 0.012);
  out.b = v * (1 - warm * 0.03);
  return out;
}

/* ------------------------------------------------------------------ *
 * Kerb height profile
 * ------------------------------------------------------------------ */

/**
 * Kerb reveal at distance `s` along an edge, on `side`.
 *
 * Full six inches everywhere except through a driveway cut, where it ramps down
 * to almost nothing over 1.1 m, sits flat across the apron, and comes back up.
 * Those interruptions are what stop a block face reading as an extruded profile.
 */
function kerbAt(cuts: Float32Array, count: number, s: number): number {
  let h = 1;
  for (let i = 0; i < count; i++) {
    const c0 = cuts[i * 2];
    const c1 = cuts[i * 2 + 1];
    if (s < c0 - 1.15 || s > c1 + 1.15) continue;
    if (s >= c0 && s <= c1) return 0.13;
    const d = s < c0 ? (c0 - s) / 1.15 : (s - c1) / 1.15;
    h = Math.min(h, 0.13 + (1 - 0.13) * smoothstep(0, 1, d));
  }
  return h;
}

/* ------------------------------------------------------------------ *
 * Block-face pavement
 * ------------------------------------------------------------------ */

const _cutBuf = new Float32Array(24);
const _wellBuf = new Float32Array(64);

function outerWidthOf(e: RoadEdge): number {
  return e.isAlley ? e.carriageway + 0.9 : e.halfWidth + SIDEWALK_WIDTH;
}

function buildFace(
  walk: MeshSink, kerb: MeshSink, e: RoadEdge, side: 1 | -1, lod: number,
): void {
  const span = edgeSpan(e);
  if (span.len < 2) return;
  const chw = e.carriageway;
  const outer = outerWidthOf(e);
  const walkW = outer - chw - KERB_TOP;
  if (walkW < 0.5) return;

  const cutCount = drivewayCuts(e, side, span.s0, span.s1, _cutBuf);
  const step = lod === 0 ? 4.5 : 12.0;
  const rows = Math.max(2, Math.ceil(span.len / step) + 1);
  const ds = span.len / (rows - 1);
  const walkUv = materialWorldScale("concrete-sidewalk");
  const kerbUv = materialWorldScale("concrete-cast");

  // Column lateral positions measured outward from the carriageway edge.
  const cols = lod === 0
    ? [0, KERB_TOP, KERB_TOP + walkW * 0.5, KERB_TOP + walkW]
    : [0, KERB_TOP, KERB_TOP + walkW];

  const baseWalk = walk.vCount;
  const nCols = cols.length;
  // Rows × cols of pavement, plus the kerb face and the outer skirt as strips.
  let prevFaceLo = -1;
  let prevFaceHi = -1;
  let prevSkirtHi = -1;
  let prevSkirtLo = -1;

  for (let r = 0; r < rows; r++) {
    const s = span.s0 + r * ds;
    const kerbScale = kerbAt(_cutBuf, cutCount, s);
    const kh = KERB_HEIGHT * kerbScale;
    const road = roadSurface(e, s, side * chw);
    const roadX = road.x;
    const roadY = road.y;
    const roadZ = road.z;
    const kerbTop = roadY + kh;

    // --- pavement row ---
    for (let ci = 0; ci < nCols; ci++) {
      const lat = side * (chw + cols[ci]);
      const p = roadSurface(e, s, lat);
      // Beyond the carriageway `roadSurface` stops adding camber, so the
      // pavement is flat across and only the cross-fall tilts it.
      const off = Math.max(0, cols[ci] - KERB_TOP);
      const y = kerbTop + off * CROSSFALL;
      const t = walkW > 0 ? off / walkW : 0;
      concreteTint(p.x, p.z, t, _c);
      const nx = -e.rx * side * CROSSFALL;
      const nz = -e.rz * side * CROSSFALL;
      walk.vert(p.x, y, p.z, nx, 1, nz, p.x / walkUv, p.z / walkUv, _c.r, _c.g, _c.b);
    }

    // --- kerb face (vertical) + gutter pan ---
    {
      concreteTint(roadX, roadZ, 0, _c);
      _c.r *= 0.92; _c.g *= 0.92; _c.b *= 0.9;
      const nx = -e.rx * side;
      const nz = -e.rz * side;
      const lo = kerb.vert(roadX, roadY, roadZ, nx, 0.06, nz, roadX / kerbUv, roadY / kerbUv, _c.r, _c.g, _c.b);
      const hi = kerb.vert(roadX, kerbTop, roadZ, nx, 0.06, nz, roadX / kerbUv, kerbTop / kerbUv, _c.r, _c.g, _c.b);
      if (prevFaceLo >= 0) {
        if (side === 1) kerb.quad(prevFaceLo, prevFaceHi, hi, lo);
        else kerb.quad(lo, hi, prevFaceHi, prevFaceLo);
      }
      prevFaceLo = lo;
      prevFaceHi = hi;
    }

    // --- outer apron skirt, dropped into the terrain ---
    {
      const p = roadSurface(e, s, side * outer);
      const topY = kerbTop + walkW * CROSSFALL;
      const ground = terrainHeight(p.x, p.z);
      const botY = Math.min(ground - 0.4, topY - 0.25) - SKIRT * 0.35;
      concreteTint(p.x, p.z, 1, _c);
      _c.r *= 0.7; _c.g *= 0.7; _c.b *= 0.7;
      const nx = e.rx * side;
      const nz = e.rz * side;
      const hi = kerb.vert(p.x, topY, p.z, nx, 0.05, nz, p.x / kerbUv, topY / kerbUv, _c.r, _c.g, _c.b);
      const lo = kerb.vert(p.x, botY, p.z, nx, 0.05, nz, p.x / kerbUv, botY / kerbUv, _c.r, _c.g, _c.b);
      if (prevSkirtHi >= 0) {
        if (side === 1) kerb.quad(lo, hi, prevSkirtHi, prevSkirtLo);
        else kerb.quad(prevSkirtLo, prevSkirtHi, hi, lo);
      }
      prevSkirtHi = hi;
      prevSkirtLo = lo;
    }
  }

  // Stitch the pavement grid.
  for (let r = 0; r < rows - 1; r++) {
    for (let ci = 0; ci < nCols - 1; ci++) {
      const i0 = baseWalk + r * nCols + ci;
      if (side === 1) walk.quad(i0, i0 + 1, i0 + nCols + 1, i0 + nCols);
      else walk.quad(i0 + nCols, i0 + nCols + 1, i0 + 1, i0);
    }
  }

  // --- gutter pan: cast concrete inside the carriageway edge ---
  {
    let pa = -1;
    let pb = -1;
    for (let r = 0; r < rows; r++) {
      const s = span.s0 + r * ds;
      const a = roadSurface(e, s, side * (chw - GUTTER));
      const ax = a.x;
      const ay = a.y;
      const az = a.z;
      const b = roadSurface(e, s, side * chw);
      // The pan is always in shadow of the kerb and always wet: a flat, dark,
      // slightly green-grey concrete that does not need its own noise lookup.
      _c.r = 0.70; _c.g = 0.71; _c.b = 0.69;
      const va = kerb.vert(ax, ay + 0.012, az, 0, 1, 0, ax / kerbUv, az / kerbUv, _c.r, _c.g, _c.b);
      const vb = kerb.vert(b.x, b.y + 0.012, b.z, 0, 1, 0, b.x / kerbUv, b.z / kerbUv, _c.r, _c.g, _c.b);
      if (pa >= 0) {
        if (side === 1) kerb.quad(pa, pb, vb, va);
        else kerb.quad(va, vb, pb, pa);
      }
      pa = va;
      pb = vb;
    }
  }

  if (lod !== 0) return;

  // --- driveway aprons: the concrete wedge that crosses the pavement ---
  for (let i = 0; i < cutCount; i++) {
    const c0 = _cutBuf[i * 2];
    const c1 = _cutBuf[i * 2 + 1];
    const p0 = roadSurface(e, c0, side * chw);
    const y0 = p0.y;
    const p0x = p0.x;
    const p0z = p0.z;
    const y1 = roadSurface(e, c1, side * chw).y;
    concreteTint(p0x, p0z, 0.2, _c);
    _c.r *= 1.05; _c.g *= 1.05; _c.b *= 1.05;
    // A slightly proud slab so the apron reads as its own pour.
    quadOnFace(kerb, e, side, c0, c1, chw + KERB_TOP, chw + KERB_TOP + walkW * 0.55,
      (y0 + y1) * 0.5 + KERB_HEIGHT * 0.13 + 0.012, kerbUv, _c);
  }

  // --- tree wells ---
  const wellCount = treeWells(e, side, span.s0, span.s1, _wellBuf);
  for (let i = 0; i < wellCount; i++) {
    const s = _wellBuf[i];
    const p = roadSurface(e, s, side * chw);
    const kh = KERB_HEIGHT * kerbAt(_cutBuf, cutCount, s);
    const y = p.y + kh;
    // Soil, recessed 60 mm inside a 1.4 m opening set 0.25 m back from the kerb.
    quadOnFace(kerb, e, side, s - 0.7, s + 0.7, chw + KERB_TOP + 0.25, chw + KERB_TOP + 1.65,
      y - 0.055, kerbUv, SOIL);
  }
}

/** An axis-aligned patch in (along, lateral) space at a fixed height. */
function quadOnFace(
  sink: MeshSink, e: RoadEdge, side: 1 | -1,
  s0: number, s1: number, lat0: number, lat1: number,
  y: number, uv: number, c: RGB,
): void {
  const a = roadSurface(e, s0, side * lat0);
  const ax = a.x;
  const az = a.z;
  const b = roadSurface(e, s0, side * lat1);
  const bx = b.x;
  const bz = b.z;
  const d = roadSurface(e, s1, side * lat1);
  const dx = d.x;
  const dz = d.z;
  const f = roadSurface(e, s1, side * lat0);
  addGroundQuad(sink, ax, y, az, bx, y, bz, dx, y, dz, f.x, y, f.z, uv, c);
}

/* ------------------------------------------------------------------ *
 * Corners
 * ------------------------------------------------------------------ */

const _arcX = new Float32Array(9);
const _arcY = new Float32Array(9);
const _arcZ = new Float32Array(9);
const _cornerPoly = new Float32Array(48);

/**
 * The kerb return.
 *
 * A real corner is not two kerbs meeting at a point; it is an arc of about
 * 4.5 m radius, and the pavement wraps around it. The arc here is a quadratic
 * Bezier from where one kerb line stops, through the geometric corner, to where
 * the other starts — which gives exactly the right shape for free and works at
 * any junction angle, including the acute wedges where the western grid runs
 * into the downtown one.
 *
 * At the apex the kerb drops to a 20 mm lip and the pavement slopes down to
 * meet it: the diagonal ramp. The truncated-dome warning panel goes on it,
 * because a ramp without one looks subtly, uncannily wrong to anyone who has
 * ever crossed a street in America.
 */
function buildCorner(
  walk: MeshSink, kerb: MeshSink, n: RoadNode, i: number,
): void {
  const deg = n.edges.length;
  if (deg < 2) return;
  const j = (i + 1) % deg;
  const eA = roadNetwork.edges[n.edges[i]];
  const eB = roadNetwork.edges[n.edges[j]];
  if (eA.id === eB.id) return;
  const atA_A = eA.a === n.id;
  const atA_B = eB.a === n.id;
  const dA = atA_A ? eA.trimA : eA.trimB;
  const dB = atA_B ? eB.trimA : eB.trimB;
  const hwA = eA.carriageway;
  const hwB = eB.carriageway;
  const outA = outerWidthOf(eA);
  const outB = outerWidthOf(eB);

  const Ain = ptOf(eA, atA_A, dA, hwA);
  const Aout = ptOf(eA, atA_A, dA, outA);
  const Bin = ptOf(eB, atA_B, dB, -hwB);
  const Bout = ptOf(eB, atA_B, dB, -outB);
  const cx = n.corners[i * 3];
  const cy = n.corners[i * 3 + 1];
  const cz = n.corners[i * 3 + 2];

  // Kerb-top heights at each end of the arc.
  const kerbA = Ain[1] + KERB_HEIGHT;
  const kerbB = Bin[1] + KERB_HEIGHT;

  const N = 7;
  for (let k = 0; k < N; k++) {
    const t = k / (N - 1);
    const mt = 1 - t;
    const w0 = mt * mt;
    const w1 = 2 * mt * t;
    const w2 = t * t;
    _arcX[k] = w0 * Ain[0] + w1 * cx + w2 * Bin[0];
    _arcZ[k] = w0 * Ain[2] + w1 * cz + w2 * Bin[2];
    const roadY = w0 * Ain[1] + w1 * cy + w2 * Bin[1];
    // The ramp: the reveal collapses to a 20 mm lip across the middle third of
    // the return and comes back up at each end.
    const flat = 1 - smoothstep(0.10, 0.30, Math.abs(t - 0.5));
    const reveal = KERB_HEIGHT * (1 - flat) + 0.02 * flat;
    _arcY[k] = roadY + reveal;
    if (k === 0) _arcY[k] = kerbA;
    if (k === N - 1) _arcY[k] = kerbB;
  }

  // Outer property-line corner: intersect the two building lines.
  const adx = atA_A ? eA.dx : -eA.dx;
  const adz = atA_A ? eA.dz : -eA.dz;
  const bdx = atA_B ? eB.dx : -eB.dx;
  const bdz = atA_B ? eB.dz : -eB.dz;
  const O = lineIntersect(Aout[0], Aout[2], adx, adz, Bout[0], Bout[2], bdx, bdz);
  const ox = O ? O.x : (Aout[0] + Bout[0]) * 0.5;
  const oz = O ? O.z : (Aout[2] + Bout[2]) * 0.5;
  const oy = Math.max(Aout[1], Bout[1]);

  // --- pavement polygon: arc → B side → block corner → A side ---
  let pc = 0;
  const push = (x: number, y: number, z: number) => {
    if (pc >= 16) return;
    _cornerPoly[pc * 3] = x;
    _cornerPoly[pc * 3 + 1] = y;
    _cornerPoly[pc * 3 + 2] = z;
    pc++;
  };
  for (let k = 0; k < N; k++) push(_arcX[k], _arcY[k], _arcZ[k]);
  push(Bout[0], Bout[1] + KERB_HEIGHT + (outB - hwB) * CROSSFALL, Bout[2]);
  push(ox, oy + KERB_HEIGHT + 0.09, oz);
  push(Aout[0], Aout[1] + KERB_HEIGHT + (outA - hwA) * CROSSFALL, Aout[2]);
  concreteTint(cx, cz, 0.4, _c);
  addPolygon(walk, _cornerPoly, pc, materialWorldScale("concrete-sidewalk"), _c);

  // --- kerb face around the arc ---
  const kerbUv = materialWorldScale("concrete-cast");
  concreteTint(cx, cz, 0, _c);
  _c.r *= 0.9; _c.g *= 0.9; _c.b *= 0.88;
  let pLo = -1;
  let pHi = -1;
  for (let k = 0; k < N; k++) {
    const t = k / (N - 1);
    const mt = 1 - t;
    const roadY = mt * mt * Ain[1] + 2 * mt * t * cy + t * t * Bin[1];
    // Outward normal of the arc, from the node.
    let nx = _arcX[k] - n.x;
    let nz = _arcZ[k] - n.z;
    const il = 1 / (Math.hypot(nx, nz) || 1);
    nx *= il;
    nz *= il;
    const lo = kerb.vert(_arcX[k], roadY, _arcZ[k], -nx, 0.06, -nz, _arcX[k] / kerbUv, roadY / kerbUv, _c.r, _c.g, _c.b);
    const hi = kerb.vert(_arcX[k], _arcY[k], _arcZ[k], -nx, 0.06, -nz, _arcX[k] / kerbUv, _arcY[k] / kerbUv, _c.r, _c.g, _c.b);
    if (pLo >= 0) kerb.quad(pLo, pHi, hi, lo);
    pLo = lo;
    pHi = hi;
  }

  // --- truncated dome warning panel on the ramp apex ---
  const apex = (N - 1) >> 1;
  if (apex > 0 && apex < N - 1) {
    const axp = _arcX[apex];
    const azp = _arcZ[apex];
    const ayp = _arcY[apex];
    let dx = _arcX[apex + 1] - _arcX[apex - 1];
    let dz = _arcZ[apex + 1] - _arcZ[apex - 1];
    const dl = 1 / (Math.hypot(dx, dz) || 1);
    dx *= dl;
    dz *= dl;
    const inx = (n.x - axp);
    const inz = (n.z - azp);
    const inl = 1 / (Math.hypot(inx, inz) || 1);
    const bx = -inx * inl;
    const bz = -inz * inl;
    const hw = 0.62;
    const dp = 0.85;
    addGroundQuad(
      kerb,
      axp - dx * hw + bx * 0.12, ayp + 0.02, azp - dz * hw + bz * 0.12,
      axp + dx * hw + bx * 0.12, ayp + 0.02, azp + dz * hw + bz * 0.12,
      axp + dx * hw + bx * dp, ayp + 0.10, azp + dz * hw + bz * dp,
      axp - dx * hw + bx * dp, ayp + 0.10, azp - dz * hw + bz * dp,
      0.35, DOME_PANEL,
    );
  }
}

const _ptBuf = [new Float32Array(3), new Float32Array(3), new Float32Array(3), new Float32Array(3)];
let _ptSlot = 0;
function ptOf(e: RoadEdge, atA: boolean, d: number, lat: number): Float32Array {
  const out = _ptBuf[_ptSlot++ & 3];
  const s = clamp(atA ? d : e.length - d, 0, e.length);
  const p = roadSurface(e, s, atA ? lat : -lat);
  out[0] = p.x;
  out[1] = p.y;
  out[2] = p.z;
  return out;
}

function lineIntersect(
  px: number, pz: number, dx: number, dz: number,
  qx: number, qz: number, ex: number, ez: number,
): { x: number; z: number } | null {
  const cross = dx * ez - dz * ex;
  if (Math.abs(cross) < 0.06) return null;
  const t = ((qx - px) * ez - (qz - pz) * ex) / cross;
  if (Math.abs(t) > 400) return null;
  return { x: px + dx * t, z: pz + dz * t };
}

/* ------------------------------------------------------------------ *
 * Chunk assembly
 * ------------------------------------------------------------------ */

const _edges: RoadEdge[] = [];
const _nodes: RoadNode[] = [];

/** Exported for the offline harness and for anyone wanting to prebake. */
export function buildSidewalkChunk(
  x: number, z: number, size: number, lod: number,
  matWalk: THREE.Material, matKerb: THREE.Material,
): { meshes: THREE.Object3D[] } | null {
  roadNetwork.ensureRect(x - 300, z - 300, x + size + 300, z + size + 300);
  roadNetwork.edgesInRect(x, z, x + size, z + size, _edges);
  roadNetwork.nodesInRect(x, z, x + size, z + size, _nodes);
  if (_edges.length === 0 && _nodes.length === 0) return null;

  const walk = new MeshSink(lod === 0 ? 8000 : 2000);
  const kerb = new MeshSink(lod === 0 ? 6000 : 1500);

  for (const e of _edges) {
    // Park drives have a rolled shoulder, not a kerb — and no pavement at all.
    const a = roadNetwork.nodes[e.a];
    const b = roadNetwork.nodes[e.b];
    if (isPark((a.x + b.x) * 0.5, (a.z + b.z) * 0.5)) continue;
    buildFace(walk, kerb, e, 1, lod);
    buildFace(walk, kerb, e, -1, lod);
  }
  if (lod === 0) {
    for (const n of _nodes) {
      if (isPark(n.x, n.z)) continue;
      for (let i = 0; i < n.edges.length; i++) buildCorner(walk, kerb, n, i);
    }
  }

  const origin = { x: x + size * 0.5, y: 0, z: z + size * 0.5 };
  const meshes: THREE.Object3D[] = [];
  const push = (sink: MeshSink, mat: THREE.Material, name: string) => {
    const g = sink.finalize(origin);
    if (!g) return;
    const m = new THREE.Mesh(g, mat);
    m.position.set(origin.x, origin.y, origin.z);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    m.receiveShadow = true;
    m.castShadow = false;
    m.name = name;
    meshes.push(m);
  };
  push(walk, matWalk, "sf-sidewalk");
  push(kerb, matKerb, "sf-kerb");
  if (meshes.length === 0) return null;
  return { meshes };
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

const _cam = new THREE.Vector3();

export default function Sidewalks() {
  const tier = useSfStore((s) => s.quality);
  const q = QUALITY[tier];
  const { camera } = useThree();
  const group = useRef<THREE.Group>(null);

  const materials = useMemo(() => {
    const walk = getMaterial("concrete-sidewalk", {
      vertexColors: true,
      repeat: 1,
      name: "sf/sidewalk",
      detail: { detailStrength: 0.5 },
    });
    const kerbMat = getMaterial("concrete-cast", {
      vertexColors: true,
      repeat: 1,
      name: "sf/kerb",
    });
    return { walk, kerb: kerbMat };
  }, []);

  const streamer = useRef<ChunkStreamer | null>(null);

  useEffect(() => {
    const g = group.current;
    if (!g) return;
    const s = new ChunkStreamer(
      g,
      (x, z, size, lod) => buildSidewalkChunk(x, z, size, lod, materials.walk, materials.kerb),
      () => clamp(q.detailRadius * 0.5, 260, 700),
      () => clamp(q.detailRadius * 1.9, 620, 2200),
      { cell: 256, farCell: 768, budgetMs: 3.0, warmupMs: 9 },
    );
    streamer.current = s;
    return () => {
      s.dispose();
      streamer.current = null;
      for (const c of g.children.slice()) {
        g.remove(c);
        disposeObject(c);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materials, q.detailRadius]);

  useFrame(() => {
    const s = streamer.current;
    if (!s) return;
    camera.getWorldPosition(_cam);
    s.update(_cam.x, _cam.z, frame.time);
    reportPending(s.pending);
  });

  return <group ref={group} name="sf-sidewalks" />;
}

// Re-exported so consumers do not need a second import for the kerb constants.
export { KERB_HEIGHT, SIDEWALK_WIDTH };
