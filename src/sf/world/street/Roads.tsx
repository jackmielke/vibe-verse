/**
 * Roads.tsx — the carriageway.
 *
 * Everything the tyres touch: the extruded asphalt ribbon following the graded
 * road profile with its 2 % crown, the junction decks stitched to the ribbon
 * ends with no overlap and no seam, and then the layer that actually sells it —
 * the paint, the patches, the tar snakes, the polished wheel tracks and the
 * ironwork.
 *
 * The reason a procedural city reads as a model rather than as a place is
 * almost always this surface. A uniform grey ribbon with a dashed line down the
 * middle is instantly, unmistakably fake. Real asphalt is a patchwork: utility
 * cuts backfilled at a different age and a different mix, crack sealant
 * wandering across it in shiny black rivers, two dark polished bands where
 * every wheel in the city has run, oil dropped by cars idling at the lights,
 * paint worn to nothing in the wheel tracks and crisp between them. All of that
 * is here, and nearly all of it costs one float per vertex.
 *
 * Draw calls: three per near chunk (asphalt / paint / ironwork), one per far
 * chunk. The whole visible street network is roughly forty.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { QUALITY } from "../../config";
import { frame, useSfStore } from "../../state/store";
import { getMaterial, materialWorldScale } from "../../materials";
import { clamp, clamp01, gradNoise2, makeRng, smoothstep, worley2 } from "../../math/rng";
import {
  MeshSink,
  addDisc,
  addGroundQuad,
  addPolygon,
  addStrip,
  rgb,
  rgbLinear,
  type RGB,
} from "./geom";
import { ChunkStreamer, disposeObject, reportPending } from "./chunker";
import {
  KERB_HEIGHT,
  edgeSpan,
  roadNetwork,
  roadSurface,
  type RoadEdge,
  type RoadNode,
} from "./roadNetwork";

/* ------------------------------------------------------------------ *
 * Palette
 * ------------------------------------------------------------------ *
 * These are multipliers on the asphalt albedo, not colours in their own right.
 * Everything sits near 1.0 because the material already carries the aggregate,
 * the binder and the grain; the vertex layer only says "this bit is older /
 * darker / shinier than that bit".
 */
const PAINT_WHITE = rgbLinear(0xf2f0e6);
const PAINT_YELLOW = rgbLinear(0xe8b420);
/** SFMTA transit-only lane red. Not a fire-engine red — it is a brick oxide. */
const TRANSIT_RED = rgbLinear(0x8f3128);
/** The green the city paints bike conflict zones. */
const BIKE_GREEN = rgbLinear(0x1e7d45);
const IRON = rgb(0x8b8880);
const RAIL_STEEL = rgb(0xb9b4a8);

const _c: RGB = { r: 1, g: 1, b: 1 };
const _p0 = new Float32Array(3);
const _p1 = new Float32Array(3);
const _p2 = new Float32Array(3);
const _p3 = new Float32Array(3);

/* ------------------------------------------------------------------ *
 * Asphalt shading
 * ------------------------------------------------------------------ */

/**
 * The per-vertex asphalt multiplier.
 *
 * Layers, in the order they were added while staring at photographs of Folsom
 * Street:
 *   - worley cells at ~7 m: the utility-cut patchwork. Each cell gets its own
 *     age, so the patches read as separate pours rather than as noise.
 *   - two octaves of fbm at ~26 m: the slow blotching of an old surface.
 *   - wheel-track polish: the aggregate is worn smooth and the binder is
 *     pushed up, so the tracks are *darker* and, crucially, less rough — which
 *     is why a wet street shows two bright reflected stripes at night.
 *   - junction darkening: oil and rubber accumulate where cars sit and pull
 *     away, and it is heaviest in the metre or two before the stop bar.
 */
function asphaltTint(x: number, z: number, polish: number, junction: number, out: RGB): RGB {
  const cell = worley2(x * 0.145, z * 0.145, 9173);
  // Cell id → a stable per-patch brightness offset.
  const patchAge = ((cell.id % 977) / 977) * 2 - 1;
  const seam = smoothstep(0.0, 0.09, cell.f2 - cell.f1); // 0 on the patch seam
  const blotch = gradNoise2(x * 0.038, z * 0.038, 5501);
  const grain = gradNoise2(x * 0.42, z * 0.42, 881);

  let v = 1
    + patchAge * 0.085
    + blotch * 0.06
    + grain * 0.035
    - (1 - seam) * 0.14        // the joint between two pours is a dark line
    - polish * 0.17
    - junction * 0.19;

  v = clamp(v, 0.45, 1.28);
  // Fresh patches skew very slightly blue-grey, old oxidised asphalt warm.
  const warm = clamp01(0.5 - patchAge * 0.5);
  out.r = v * (1 + warm * 0.03);
  out.g = v * (1 + warm * 0.006);
  out.b = v * (1 - warm * 0.03);
  return out;
}

/**
 * Wheel-track polish at a lateral offset. Every travel lane contributes two
 * tracks 1.72 m apart (the average American track width), and they overlap
 * where lanes are narrow — which is exactly what you see on a four-lane street.
 */
function polishAt(e: RoadEdge, lateral: number): number {
  let p = 0;
  for (const l of e.lanes) {
    if (l.kind === "parking" || l.kind === "bike") continue;
    for (let s = -1; s <= 1; s += 2) {
      const d = lateral - (l.offset + s * 0.86);
      p += Math.exp(-(d * d) / 0.34);
    }
  }
  return clamp01(p * 0.62);
}

/* ------------------------------------------------------------------ *
 * Carriageway ribbon
 * ------------------------------------------------------------------ */

/** Lateral stations across the carriageway, as a fraction of the half-width. */
const STATIONS_HI = [-1, -0.78, -0.52, -0.26, 0, 0.26, 0.52, 0.78, 1];
const STATIONS_LO = [-1, -0.5, 0, 0.5, 1];

function buildRibbon(sink: MeshSink, e: RoadEdge, lod: number, uvScale: number): void {
  const span = edgeSpan(e);
  if (span.len < 1.2) return;
  const stations = lod === 0 ? STATIONS_HI : STATIONS_LO;
  const step = lod === 0 ? 6.0 : 16.0;
  const rows = Math.max(2, Math.ceil(span.len / step) + 1);
  const ds = span.len / (rows - 1);
  const inv = 1 / uvScale;
  const cols = stations.length;
  const base = sink.vCount;

  for (let r = 0; r < rows; r++) {
    const s = span.s0 + r * ds;
    // Junction proximity, for the oil and rubber near the stop bars.
    const junction = clamp01(
      Math.max(
        1 - (s - span.s0) / 16,
        1 - (span.s1 - s) / 16,
      ),
    ) * (e.isAlley ? 0.3 : 1);
    for (let c = 0; c < cols; c++) {
      const lat = stations[c] * e.carriageway;
      const p = roadSurface(e, s, lat);
      const polish = lod === 0 ? polishAt(e, lat) : 0;
      asphaltTint(p.x, p.z, polish, junction * 0.7, _c);
      // Surface normal: tilt by the camber and by the longitudinal grade. The
      // crown is a real 2 % and the eye picks it up in a wet reflection.
      const camberSlope = stations[c] * 0.02 * (stations[c] < 0 ? 1 : -1);
      let nx = e.rx * camberSlope - e.dx * p.ty;
      let nz = e.rz * camberSlope - e.dz * p.ty;
      const ny = 1;
      const il = 1 / Math.hypot(nx, ny, nz);
      nx *= il;
      nz *= il;
      sink.vert(p.x, p.y, p.z, nx, ny * il, nz, p.x * inv, p.z * inv, _c.r, _c.g, _c.b);
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const i0 = base + r * cols + c;
      sink.quad(i0, i0 + 1, i0 + cols + 1, i0 + cols);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Junction deck
 * ------------------------------------------------------------------ */

const _poly = new Float32Array(48);

function buildJunction(sink: MeshSink, n: RoadNode, uvScale: number): void {
  // A degree-2 node produces exactly two kerb returns, one on each side, and
  // the deck between them is covered entirely by the two gores below — there is
  // no interior polygon to fan. Anything with three or more arms has one.
  if (n.cornerCount >= 3) buildJunctionDeck(sink, n, uvScale);
  buildJunctionGores(sink, n, uvScale);
}

function buildJunctionDeck(sink: MeshSink, n: RoadNode, uvScale: number): void {
  const cnt = Math.min(n.cornerCount, 16);
  for (let i = 0; i < cnt; i++) {
    _poly[i * 3] = n.corners[i * 3];
    _poly[i * 3 + 1] = n.corners[i * 3 + 1];
    _poly[i * 3 + 2] = n.corners[i * 3 + 2];
  }
  // Junctions are the dirtiest asphalt in the city: every car that stops here
  // drips on it and every car that leaves scrubs rubber into it.
  asphaltTint(n.x, n.z, 0.5, 0.85, _c);
  addPolygon(sink, _poly, cnt, uvScale, _c, { x: n.x, y: n.y, z: n.z });
}

/**
 * Gores. The deck polygon's edge between two adjacent kerb returns is a
ic straight chord, but the approach ribbon starts at the *furthest* of the two
 * returns — so on any junction whose arms are not symmetric there is a sliver
 * of unpaved ground between them. It is a few square metres and it is the
 * single most obvious hole in a procedural street grid.
 */
function buildJunctionGores(sink: MeshSink, n: RoadNode, uvScale: number): void {
  const deg = n.edges.length;
  if (deg < 2) return;
  for (let i = 0; i < deg; i++) {
    const e = roadNetwork.edges[n.edges[i]];
    const atA = e.a === n.id;
    const trim = atA ? e.trimA : e.trimB;
    const hw = e.carriageway;
    const left = (i - 1 + deg) % deg; // corner on the -hw side of this approach
    const cl = left * 3;
    const cr = i * 3;
    approachPoint(e, atA, trim, hw, _p2);
    approachPoint(e, atA, trim, -hw, _p3);
    asphaltTint(n.x, n.z, 0.4, 0.8, _c);
    addGroundQuad(
      sink,
      n.corners[cl], n.corners[cl + 1], n.corners[cl + 2],
      n.corners[cr], n.corners[cr + 1], n.corners[cr + 2],
      _p2[0], _p2[1], _p2[2],
      _p3[0], _p3[1], _p3[2],
      uvScale, _c,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Approach helpers
 * ------------------------------------------------------------------ */

/**
 * Convert an approach-relative coordinate — `d` metres out from the node, `lat`
 * metres to the right *of the outgoing direction* — into a road surface point.
 */
function approachPoint(
  e: RoadEdge, atA: boolean, d: number, lat: number, out: Float32Array,
): void {
  const s = atA ? d : e.length - d;
  const l = atA ? lat : -lat;
  const p = roadSurface(e, s, l);
  out[0] = p.x;
  out[1] = p.y;
  out[2] = p.z;
}

/** A quad in approach space: [d0,d1] × [lat0,lat1]. */
function approachQuad(
  sink: MeshSink, e: RoadEdge, atA: boolean,
  d0: number, d1: number, lat0: number, lat1: number,
  lift: number, uvScale: number, c: RGB,
): void {
  approachPoint(e, atA, d0, lat0, _p0);
  approachPoint(e, atA, d0, lat1, _p1);
  approachPoint(e, atA, d1, lat1, _p2);
  approachPoint(e, atA, d1, lat0, _p3);
  addGroundQuad(
    sink,
    _p0[0], _p0[1] + lift, _p0[2],
    _p1[0], _p1[1] + lift, _p1[2],
    _p2[0], _p2[1] + lift, _p2[2],
    _p3[0], _p3[1] + lift, _p3[2],
    uvScale, c,
  );
}

/* ------------------------------------------------------------------ *
 * Lane markings
 * ------------------------------------------------------------------ */

const MARK_LIFT = 0.014;

/** Longitudinal line, optionally dashed. Lengths follow the MUTCD 3:9 ratio. */
function laneLine(
  sink: MeshSink, e: RoadEdge, offset: number, width: number,
  s0: number, s1: number, dashed: boolean, c: RGB,
): void {
  const on = 3.0;
  const off = 9.0;
  if (!dashed) {
    stripe(sink, e, offset, width, s0, s1, c);
    return;
  }
  // Phase the dash pattern off absolute distance from node a so two adjacent
  // blocks do not restart the pattern at the junction.
  let s = s0 - (s0 % (on + off));
  while (s < s1) {
    const a = Math.max(s, s0);
    const b = Math.min(s + on, s1);
    if (b - a > 0.3) stripe(sink, e, offset, width, a, b, c);
    s += on + off;
  }
}

function stripe(
  sink: MeshSink, e: RoadEdge, offset: number, width: number,
  s0: number, s1: number, c: RGB,
): void {
  const len = s1 - s0;
  if (len <= 0.05) return;
  // Long lines get intermediate rows so they follow the crest of a hill.
  const rows = Math.max(2, Math.ceil(len / 8) + 1);
  const hw = width * 0.5;
  let prevL = -1;
  let prevR = -1;
  for (let i = 0; i < rows; i++) {
    const s = s0 + (len * i) / (rows - 1);
    const pl = roadSurface(e, s, offset - hw);
    const lx = pl.x;
    const ly = pl.y;
    const lz = pl.z;
    const pr = roadSurface(e, s, offset + hw);
    const a = sink.vert(lx, ly + MARK_LIFT, lz, 0, 1, 0, 0, s, c.r, c.g, c.b);
    const b = sink.vert(pr.x, pr.y + MARK_LIFT, pr.z, 0, 1, 0, width, s, c.r, c.g, c.b);
    if (prevL >= 0) sink.quad(prevL, prevR, b, a);
    prevL = a;
    prevR = b;
  }
}

/**
 * The full marking set for one block face.
 *
 * SF convention, which is US convention plus two local habits: yellow separates
 * opposing traffic, white separates same-direction lanes, transit lanes are a
 * solid red field with a white border, and bike lanes are only painted green
 * through the conflict zone at each end of the block rather than end to end.
 */
function buildMarkings(sink: MeshSink, e: RoadEdge): void {
  if (e.isAlley) return;
  const span = edgeSpan(e);
  if (span.len < 6) return;
  const s0 = span.s0 + 0.6;
  const s1 = span.s1 - 0.6;

  // Coloured lane fields first, so the white lines that border them sit on top.
  for (const l of e.lanes) {
    if (l.kind === "transit") {
      // A worn red field. The paint material's alpha cutout does the wear.
      const rows = Math.max(2, Math.ceil((s1 - s0) / 9) + 1);
      let pl = -1;
      let pr = -1;
      for (let i = 0; i < rows; i++) {
        const s = s0 + ((s1 - s0) * i) / (rows - 1);
        const a = roadSurface(e, s, l.offset - l.width * 0.5);
        const ax = a.x;
        const ay = a.y;
        const az = a.z;
        const b = roadSurface(e, s, l.offset + l.width * 0.5);
        const va = sink.vert(ax, ay + MARK_LIFT * 0.7, az, 0, 1, 0, ax, az, TRANSIT_RED.r, TRANSIT_RED.g, TRANSIT_RED.b);
        const vb = sink.vert(b.x, b.y + MARK_LIFT * 0.7, b.z, 0, 1, 0, b.x, b.z, TRANSIT_RED.r, TRANSIT_RED.g, TRANSIT_RED.b);
        if (pl >= 0) sink.quad(pl, pr, vb, va);
        pl = va;
        pr = vb;
      }
      laneLine(sink, e, l.offset - l.width * 0.5 + 0.1, 0.14, s0, s1, false, PAINT_WHITE);
      laneLine(sink, e, l.offset + l.width * 0.5 - 0.1, 0.14, s0, s1, false, PAINT_WHITE);
    } else if (l.kind === "bike") {
      // Green only through the conflict zones at each end.
      const zone = Math.min(20, (s1 - s0) * 0.35);
      for (const [za, zb] of [[s0, s0 + zone], [s1 - zone, s1]] as [number, number][]) {
        const rows = 3;
        let pl = -1;
        let pr = -1;
        for (let i = 0; i < rows; i++) {
          const s = za + ((zb - za) * i) / (rows - 1);
          const a = roadSurface(e, s, l.offset - l.width * 0.5);
          const ax = a.x;
          const ay = a.y;
          const az = a.z;
          const b = roadSurface(e, s, l.offset + l.width * 0.5);
          const va = sink.vert(ax, ay + MARK_LIFT * 0.7, az, 0, 1, 0, ax, az, BIKE_GREEN.r, BIKE_GREEN.g, BIKE_GREEN.b);
          const vb = sink.vert(b.x, b.y + MARK_LIFT * 0.7, b.z, 0, 1, 0, b.x, b.z, BIKE_GREEN.r, BIKE_GREEN.g, BIKE_GREEN.b);
          if (pl >= 0) sink.quad(pl, pr, vb, va);
          pl = va;
          pr = vb;
        }
      }
      laneLine(sink, e, l.offset - l.width * 0.5, 0.12, s0, s1, false, PAINT_WHITE);
    }
  }

  // Centreline. Two-lane streets get a single dashed yellow; anything wider
  // gets the double solid yellow that means "do not cross".
  const travel = e.lanes.filter((l) => l.kind !== "parking" && l.kind !== "bike");
  const twoWay = travel.some((l) => l.dir === 1) && travel.some((l) => l.dir === -1);
  if (twoWay) {
    if (travel.length <= 2) {
      laneLine(sink, e, 0, 0.13, s0, s1, true, PAINT_YELLOW);
    } else {
      laneLine(sink, e, -0.16, 0.12, s0, s1, false, PAINT_YELLOW);
      laneLine(sink, e, 0.16, 0.12, s0, s1, false, PAINT_YELLOW);
    }
  }

  // White dashes between same-direction travel lanes.
  for (let i = 1; i < e.lanes.length; i++) {
    const a = e.lanes[i - 1];
    const b = e.lanes[i];
    if (a.kind === "parking" || b.kind === "parking") continue;
    if (a.kind === "bike" || b.kind === "bike") continue;
    if (a.dir !== b.dir) continue;
    laneLine(sink, e, (a.offset + a.width * 0.5 + b.offset - b.width * 0.5) * 0.5, 0.12, s0, s1, true, PAINT_WHITE);
  }

  // Parking lane boundary + the tick marks that divide the stalls.
  for (const l of e.lanes) {
    if (l.kind !== "parking") continue;
    const inner = l.offset + (l.offset < 0 ? l.width * 0.5 : -l.width * 0.5);
    laneLine(sink, e, inner, 0.12, s0, s1, false, PAINT_WHITE);
    const side = l.offset < 0 ? -1 : 1;
    for (let s = s0 + 3; s < s1 - 3; s += 6.4) {
      // A short "T" at each stall division — the marking every SF block has.
      stripeAcross(sink, e, s, l.offset, l.offset + side * l.width * 0.42, 0.11, PAINT_WHITE);
    }
  }
}

/** A short transverse tick between two lateral offsets at a fixed `s`. */
function stripeAcross(
  sink: MeshSink, e: RoadEdge, s: number, lat0: number, lat1: number, width: number, c: RGB,
): void {
  const hw = width * 0.5;
  const a0 = roadSurface(e, s - hw, lat0);
  const x0 = a0.x;
  const y0 = a0.y;
  const z0 = a0.z;
  const a1 = roadSurface(e, s + hw, lat0);
  const x1 = a1.x;
  const y1 = a1.y;
  const z1 = a1.z;
  const a2 = roadSurface(e, s + hw, lat1);
  const x2 = a2.x;
  const y2 = a2.y;
  const z2 = a2.z;
  const a3 = roadSurface(e, s - hw, lat1);
  addGroundQuad(
    sink,
    x0, y0 + MARK_LIFT, z0,
    x1, y1 + MARK_LIFT, z1,
    x2, y2 + MARK_LIFT, z2,
    a3.x, a3.y + MARK_LIFT, a3.z,
    1, c,
  );
}

/* ------------------------------------------------------------------ *
 * Junction paint: crosswalks, stop bars, turn arrows
 * ------------------------------------------------------------------ */

function buildJunctionPaint(sink: MeshSink, n: RoadNode): void {
  if (n.control === "none" || n.edges.length < 3) return;
  const continental = n.control === "signal";

  for (const eid of n.edges) {
    const e = roadNetwork.edges[eid];
    if (e.isAlley) continue;
    const atA = e.a === n.id;
    const trim = atA ? e.trimA : e.trimB;
    if (trim < 3.6) continue;
    const hw = e.carriageway;

    // --- crosswalk, set just inside the kerb returns ---
    const cw1 = trim - 0.5;
    const cw0 = cw1 - (continental ? 3.0 : 2.6);
    if (continental) {
      // Continental ("ladder") bars run parallel to traffic.
      const bar = 0.55;
      const gap = 0.55;
      const usable = hw * 2 - 0.6;
      const pitch = bar + gap;
      const count = Math.max(2, Math.floor(usable / pitch));
      const start = -hw + 0.3 + (usable - count * pitch + gap) * 0.5;
      for (let i = 0; i < count; i++) {
        const l0 = start + i * pitch;
        approachQuad(sink, e, atA, cw0, cw1, l0, l0 + bar, MARK_LIFT, 1, PAINT_WHITE);
      }
    } else {
      approachQuad(sink, e, atA, cw0, cw0 + 0.16, -hw + 0.3, hw - 0.3, MARK_LIFT, 1, PAINT_WHITE);
      approachQuad(sink, e, atA, cw1 - 0.16, cw1, -hw + 0.3, hw - 0.3, MARK_LIFT, 1, PAINT_WHITE);
    }

    // --- stop bar, across the approaching half only ---
    const sb = cw0 - 1.1;
    if (sb > 0.6) {
      // The approaching half is the one whose lanes run *toward* this node.
      const towardDir: 1 | -1 = atA ? -1 : 1;
      let lo = Infinity;
      let hi = -Infinity;
      for (const l of e.lanes) {
        if (l.dir !== towardDir || l.kind === "parking") continue;
        const a = atA ? -(l.offset + l.width * 0.5) : l.offset - l.width * 0.5;
        const b = atA ? -(l.offset - l.width * 0.5) : l.offset + l.width * 0.5;
        lo = Math.min(lo, a, b);
        hi = Math.max(hi, a, b);
      }
      if (lo < hi) {
        approachQuad(sink, e, atA, sb - 0.5, sb, lo, hi, MARK_LIFT, 1, PAINT_WHITE);

        // --- turn arrows in the approach lanes ---
        if (continental && e.length - trim > 26) {
          const lanes = e.lanes.filter((l) => l.dir === towardDir && (l.kind === "travel" || l.kind === "transit"));
          for (let i = 0; i < lanes.length; i++) {
            const l = lanes[i];
            const lat = atA ? -l.offset : l.offset;
            // Leftmost approach lane turns left, rightmost turns right.
            const kind = lanes.length === 1 ? 0 : i === 0 ? -1 : i === lanes.length - 1 ? 1 : 0;
            turnArrow(sink, e, atA, sb - 5.5, lat, kind);
          }
        }
      }
    }
  }
}

/**
 * A MUTCD-ish turn arrow: 4.2 m shaft, a chevron head, and for the turning
 * variants a hooked tail. Built in approach space so it climbs the hill with
 * the road instead of floating off it.
 */
function turnArrow(
  sink: MeshSink, e: RoadEdge, atA: boolean, d: number, lat: number, dir: -1 | 0 | 1,
): void {
  const shaftW = 0.30;
  const L = 4.2;
  // Shaft
  approachQuad(sink, e, atA, d, d + L * 0.62, lat - shaftW * 0.5, lat + shaftW * 0.5, MARK_LIFT, 1, PAINT_WHITE);
  // Head: a triangle approximated by two tapering quads so it stays one strip.
  const headBase = d + L * 0.62;
  const headTip = d + L;
  const hw = 0.62;
  for (let i = 0; i < 4; i++) {
    const t0 = i / 4;
    const t1 = (i + 1) / 4;
    const w0 = hw * (1 - t0);
    const w1 = hw * (1 - t1);
    approachQuad(
      sink, e, atA,
      headBase + (headTip - headBase) * t0,
      headBase + (headTip - headBase) * t1,
      lat - w0, lat + w0, MARK_LIFT, 1, PAINT_WHITE,
    );
    void w1;
  }
  if (dir !== 0) {
    // Hooked tail sweeping out to the side.
    const steps = 5;
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps;
      const t1 = (i + 1) / steps;
      const off0 = dir * 1.5 * t0 * t0;
      const off1 = dir * 1.5 * t1 * t1;
      approachQuad(
        sink, e, atA,
        d + 0.1 + t0 * 1.6, d + 0.1 + t1 * 1.6,
        lat + off0 - shaftW * 0.5, lat + off1 + shaftW * 0.5,
        MARK_LIFT, 1, PAINT_WHITE,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * Ironwork, tar and rails
 * ------------------------------------------------------------------ */

/**
 * Manholes, drain grates and the cable car slot rails.
 *
 * Manhole placement is not random scatter: covers sit over the sewer, which
 * runs down the crown of the street, and they cluster near junctions where the
 * laterals join. Storm drains sit in the gutter at the low corner of each
 * junction, because water runs downhill and the city knows it.
 */
function buildIronwork(metal: MeshSink, asphalt: MeshSink, e: RoadEdge): void {
  const span = edgeSpan(e);
  if (span.len < 8) return;
  const rng = makeRng(e.seed ^ 0x51ed);
  const uv = materialWorldScale("steel-rusted");

  // Sewer access down the crown.
  for (let s = span.s0 + rng.range(4, 14); s < span.s1 - 3; s += rng.range(26, 48)) {
    const lat = rng.gauss() * 0.9;
    const p = roadSurface(e, s, lat);
    const px = p.x;
    const py = p.y;
    const pz = p.z;
    // The cover sits a couple of centimetres proud, with a shallow dish of
    // settled asphalt around it — the bump every SF cyclist knows.
    _c.r = 0.82; _c.g = 0.80; _c.b = 0.76;
    addDisc(metal, px, py + 0.021, pz, 0.33, 12, IRON, uv);
    addDisc(asphalt, px, py + 0.008, pz, 0.52, 12, _c, materialWorldScale("asphalt"));
    if (rng.chance(0.3)) {
      // Utility vault: the rectangular plate next to it.
      const a = rng.next() * Math.PI;
      const ca = Math.cos(a) * 0.42;
      const sa = Math.sin(a) * 0.42;
      const cb = -Math.sin(a) * 0.3;
      const sb = Math.cos(a) * 0.3;
      addGroundQuad(
        metal,
        px - ca - cb, py + 0.019, pz - sa - sb,
        px + ca - cb, py + 0.019, pz + sa - sb,
        px + ca + cb, py + 0.019, pz + sa + sb,
        px - ca + cb, py + 0.019, pz - sa + sb,
        uv, IRON,
      );
    }
  }

  // Storm drains in the gutter, both sides, near the ends of the block.
  for (const side of [-1, 1] as const) {
    for (const s of [span.s0 + 2.5, span.s1 - 2.5]) {
      const p = roadSurface(e, s, side * (e.carriageway - 0.42));
      addGroundQuad(
        metal,
        p.x - 0.45 * e.dx - 0.22 * e.rx, p.y + 0.012, p.z - 0.45 * e.dz - 0.22 * e.rz,
        p.x + 0.45 * e.dx - 0.22 * e.rx, p.y + 0.012, p.z + 0.45 * e.dz - 0.22 * e.rz,
        p.x + 0.45 * e.dx + 0.22 * e.rx, p.y + 0.012, p.z + 0.45 * e.dz + 0.22 * e.rz,
        p.x - 0.45 * e.dx + 0.22 * e.rx, p.y + 0.012, p.z - 0.45 * e.dz + 0.22 * e.rz,
        uv, IRON,
      );
    }
  }

  // Crack sealant. Tar snakes wander across the carriageway roughly transverse
  // to the direction of travel, because that is the direction thermal cracks
  // open in a strip of pavement that is long in one axis.
  const snakes = Math.floor(span.len / 14);
  _c.r = 0.30; _c.g = 0.29; _c.b = 0.29;
  for (let i = 0; i < snakes; i++) {
    const s = span.s0 + rng.range(1, span.len - 1);
    const lat0 = rng.range(-1, 1) * e.carriageway;
    const lat1 = clamp(lat0 + rng.range(-1.6, 1.6) * e.carriageway, -e.carriageway, e.carriageway);
    const wob = rng.range(1.4, 4.2);
    const segs = 6;
    let prevA = -1;
    let prevB = -1;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const lat = lat0 + (lat1 - lat0) * t;
      const ss = s + Math.sin(t * Math.PI * 2 + rng.next()) * wob * 0.25 + (t - 0.5) * wob;
      const w = 0.055 + Math.abs(Math.sin(t * 5.3)) * 0.05;
      const p = roadSurface(e, clamp(ss, span.s0, span.s1), lat);
      const a = asphalt.vert(p.x - e.dx * w, p.y + 0.011, p.z - e.dz * w, 0, 1, 0, p.x, p.z, _c.r, _c.g, _c.b);
      const b = asphalt.vert(p.x + e.dx * w, p.y + 0.011, p.z + e.dz * w, 0, 1, 0, p.x, p.z, _c.r, _c.g, _c.b);
      if (prevA >= 0) asphalt.quad(prevB, prevA, a, b);
      prevA = a;
      prevB = b;
    }
  }

  // Cable car: two rails and the slot between them. The slot is the giveaway —
  // a continuous 20 mm gap in the roadway with the moving cable underneath.
  if (e.cableCar) {
    const gauge = 1.55;
    for (const side of [-1, 1] as const) {
      railStrip(metal, e, side * gauge * 0.5, 0.075, span.s0, span.s1, RAIL_STEEL, 0.028);
    }
    _c.r = 0.10; _c.g = 0.10; _c.b = 0.10;
    railStrip(asphalt, e, 0, 0.075, span.s0, span.s1, _c, 0.002);
    // The slot rails either side of the gap.
    railStrip(metal, e, -0.075, 0.05, span.s0, span.s1, RAIL_STEEL, 0.024);
    railStrip(metal, e, 0.075, 0.05, span.s0, span.s1, RAIL_STEEL, 0.024);
  }
}

function railStrip(
  sink: MeshSink, e: RoadEdge, offset: number, width: number,
  s0: number, s1: number, c: RGB, lift: number,
): void {
  const rows = Math.max(2, Math.ceil((s1 - s0) / 6) + 1);
  const hw = width * 0.5;
  let pa = -1;
  let pb = -1;
  for (let i = 0; i < rows; i++) {
    const s = s0 + ((s1 - s0) * i) / (rows - 1);
    const p0 = roadSurface(e, s, offset - hw);
    const x0 = p0.x;
    const y0 = p0.y;
    const z0 = p0.z;
    const p1 = roadSurface(e, s, offset + hw);
    const a = sink.vert(x0, y0 + lift, z0, 0, 1, 0, 0, s, c.r, c.g, c.b);
    const b = sink.vert(p1.x, p1.y + lift, p1.z, 0, 1, 0, width, s, c.r, c.g, c.b);
    if (pa >= 0) sink.quad(pa, pb, b, a);
    pa = a;
    pb = b;
  }
}

/* ------------------------------------------------------------------ *
 * Chunk assembly
 * ------------------------------------------------------------------ */

const _edges: RoadEdge[] = [];
const _nodes: RoadNode[] = [];

export interface RoadChunkMeshes {
  meshes: THREE.Object3D[];
}

/** Exported for the offline harness and for anyone wanting to prebake. */
export function buildRoadChunk(
  x: number, z: number, size: number, lod: number,
  matAsphalt: THREE.Material, matPaint: THREE.Material, matMetal: THREE.Material,
): RoadChunkMeshes | null {
  // Inflate so every junction touching this chunk has all its arms resolved.
  roadNetwork.ensureRect(x - 300, z - 300, x + size + 300, z + size + 300);
  roadNetwork.edgesInRect(x, z, x + size, z + size, _edges);
  roadNetwork.nodesInRect(x, z, x + size, z + size, _nodes);
  if (_edges.length === 0 && _nodes.length === 0) return null;

  const asphaltUv = materialWorldScale("asphalt");
  const asphalt = new MeshSink(lod === 0 ? 9000 : 2000);
  const paint = lod === 0 ? new MeshSink(6000) : null;
  const metal = lod === 0 ? new MeshSink(2000) : null;

  for (const e of _edges) {
    buildRibbon(asphalt, e, lod, asphaltUv);
    if (paint) buildMarkings(paint, e);
    if (metal) buildIronwork(metal, asphalt, e);
  }
  for (const n of _nodes) {
    buildJunction(asphalt, n, asphaltUv);
    if (paint) buildJunctionPaint(paint, n);
  }

  const origin = { x: x + size * 0.5, y: 0, z: z + size * 0.5 };
  const meshes: THREE.Object3D[] = [];
  const push = (sink: MeshSink | null, mat: THREE.Material, name: string, cast: boolean) => {
    if (!sink) return;
    const g = sink.finalize(origin);
    if (!g) return;
    const m = new THREE.Mesh(g, mat);
    m.position.set(origin.x, origin.y, origin.z);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    m.receiveShadow = true;
    m.castShadow = cast;
    m.name = name;
    meshes.push(m);
  };
  push(asphalt, matAsphalt, "sf-road-asphalt", false);
  push(paint, matPaint, "sf-road-paint", false);
  push(metal, matMetal, "sf-road-iron", false);
  if (meshes.length === 0) return null;
  return { meshes };
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

const _cam = new THREE.Vector3();

export default function Roads() {
  const tier = useSfStore((s) => s.quality);
  const q = QUALITY[tier];
  const { camera } = useThree();
  const group = useRef<THREE.Group>(null);

  const materials = useMemo(() => {
    // Repeat is 1 because UVs are authored in world metres already divided by
    // each material's world scale — that is what keeps tiling continuous across
    // chunk boundaries instead of restarting at every seam.
    const asphalt = getMaterial("asphalt", {
      vertexColors: true,
      repeat: 1,
      name: "sf/road-asphalt",
      detail: { detailStrength: 0.55, detailNormalStrength: 0.7 },
    });
    const paint = getMaterial("road-marking-paint", {
      vertexColors: true,
      repeat: 1,
      polygonOffset: -3,
      name: "sf/road-paint",
    });
    const metal = getMaterial("steel-rusted", {
      vertexColors: true,
      repeat: 1,
      polygonOffset: -2,
      name: "sf/road-iron",
    });
    return { asphalt, paint, metal };
  }, []);

  const streamer = useRef<ChunkStreamer | null>(null);

  useEffect(() => {
    const g = group.current;
    if (!g) return;
    const s = new ChunkStreamer(
      g,
      (x, z, size, lod) => buildRoadChunk(x, z, size, lod, materials.asphalt, materials.paint, materials.metal),
      () => clamp(q.detailRadius * 0.6, 320, 820),
      () => clamp(q.impostorRadius * 0.5, 1400, 4200),
      { cell: 384, farCell: 1152, budgetMs: 3.2, warmupMs: 9 },
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
  }, [materials, q.detailRadius, q.impostorRadius]);

  useFrame(() => {
    const s = streamer.current;
    if (!s) return;
    camera.getWorldPosition(_cam);
    s.update(_cam.x, _cam.z, frame.time);
    reportPending(s.pending);
  });

  return <group ref={group} name="sf-roads" />;
}

/** Exposed so the sidewalk layer can share the kerb height constant. */
export { KERB_HEIGHT };
