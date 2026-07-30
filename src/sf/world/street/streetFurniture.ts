/**
  * streetFurniture.ts — the furniture of the street, and the rules that place it.
 *
 * This is the module that decides a city is inhabited. Buildings give you a
 * skyline; it is the cobra-head lamps every 34 metres, the hydrant on the
 * corner, the meters in a row, the parked cars nosed into the hill and the
 * trolleybus wire crossing overhead that make a street feel like somewhere
 * people actually live.
 *
 * Two halves:
 *
 *   Geometry  — one small, deliberately low-poly, deliberately *specific* mesh
 *               per prop kind, built once and shared by every instance in the
 *               city. Specific matters more than detailed: an SF cobra head has
 *               a particular droop to its mast arm and a particular squashed
 *               teardrop luminaire, and getting that silhouette right is worth
 *               more than a thousand extra triangles on a generic lamp post.
 *
 *   Placement — pure functions of (edge seed, side, distance along), so the
 *               same hydrant is on the same corner every time the chunk streams
 *               in, and so `Sidewalks` and `Vegetation` can independently ask
 *               "where are the tree wells on this block?" and get the same
 *               answer without talking to each other.
 *
 * Everything here is data. The React component that owns the pools and the
 * frame loop is `StreetProps.tsx`.
 */
import * as THREE from "three";
import { QUALITY, type QualityTier } from "../../config";
import { clamp, clamp01, hashSeed, makeRng, type Rng } from "../../math/rng";
import { districtAt, isPark, terrainHeight } from "../../geo/sfGeo";
import { getMaterial, type MaterialKind } from "../../materials";
import {
  MeshSink,
  addBox,
  addCylinder,
  addPanel,
  addTube,
  rgb,
  type RGB,
} from "./geom";
import { InstanceBlock, blockFor, type InstanceChunk } from "./chunker";
import {
  KERB_HEIGHT,
  SIDEWALK_WIDTH,
  edgeSpan,
  roadNetwork,
  roadSurface,
  type RoadEdge,
  type RoadNode,
  type SurfacePoint,
} from "./roadNetwork";

/* ================================================================== *
 * Prop kinds
 * ================================================================== */

export type PropKind =
  | "cobra"
  | "ornate"
  | "lamp-glow"
  | "signal"
  | "signal-lens"
  | "stop-sign"
  | "blade"
  | "meter"
  | "hydrant"
  | "mailbox"
  | "bin"
  | "newsrack"
  | "shelter"
  | "shelter-glass"
  | "bench"
  | "bollard"
  | "utility-pole"
  | "car-sedan"
  | "car-suv"
  | "car-wheel"
  | "barrier"
  | "dumpster"
  | "scaffold";

/** Instance-count ceilings, scaled by the tier's crowd density. */
const CAPACITY: Record<PropKind, number> = {
  cobra: 600,
  ornate: 150,
  "lamp-glow": 1200,
  signal: 220,
  "signal-lens": 1400,
  "stop-sign": 400,
  blade: 400,
  meter: 1200,
  hydrant: 200,
  mailbox: 90,
  bin: 280,
  newsrack: 110,
  shelter: 70,
  "shelter-glass": 70,
  bench: 200,
  bollard: 500,
  "utility-pole": 260,
  "car-sedan": 700,
  "car-suv": 380,
  "car-wheel": 4400,
  barrier: 240,
  dumpster: 160,
  scaffold: 240,
};

export function capacityFor(kind: PropKind, tier: QualityTier): number {
  return Math.max(24, Math.round(CAPACITY[kind] * clamp(QUALITY[tier].crowdDensity, 0.3, 1.4)));
}

/* ================================================================== *
 * Palette
 * ================================================================== */

const GALV = rgb(0x9aa0a4);        // galvanised / powder-coated grey
const DARK_GREY = rgb(0x53575a);
const MUNI_GREEN = rgb(0x2f5a44);  // the city's dark green furniture paint
const BRONZE = rgb(0x5e5a3a);      // Path of Gold standards, oxidised
const SIGN_GREEN = rgb(0x1f6b3a);
const SIGN_WHITE = rgb(0xe8e8e4);
const SIGN_RED = rgb(0xa8221c);
const USPS_BLUE = rgb(0x2b4a7a);
const HYDRANT_RED = rgb(0xa02a22);
const HYDRANT_WHITE = rgb(0xd8d4c8);
const WOOD = rgb(0x6a5a48);
const RUST_STEEL = rgb(0x7a7168);
const ORANGE = rgb(0xc85a1e);
const GLASS = rgb(0x8fa4ad);
const BLACK_TRIM = rgb(0x25272a);
const TYRE = rgb(0x3a3a3c);

/* ================================================================== *
 * Small geometry helpers used by the prop meshes
 * ================================================================== */

/** A vertical n-gon plate (sign face), facing +Z before the yaw rotation. */
function addPlate(
  sink: MeshSink,
  cx: number, cy: number, cz: number,
  radius: number, sides: number, thickness: number,
  rotate: number, c: RGB, uv = 0.6,
): void {
  const half = thickness * 0.5;
  const pts: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rotate + (i / sides) * Math.PI * 2;
    pts.push(Math.cos(a) * radius, Math.sin(a) * radius);
  }
  const s = 1 / uv;
  // Front and back faces.
  for (const dir of [1, -1] as const) {
    const centre = sink.vert(cx, cy, cz + half * dir, 0, 0, dir, cx * s, cy * s, c.r, c.g, c.b);
    const ring: number[] = [];
    for (let i = 0; i < sides; i++) {
      const x = cx + pts[i * 2];
      const y = cy + pts[i * 2 + 1];
      ring.push(sink.vert(x, y, cz + half * dir, 0, 0, dir, x * s, y * s, c.r, c.g, c.b));
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      if (dir > 0) sink.tri(centre, ring[i], ring[j]);
      else sink.tri(centre, ring[j], ring[i]);
    }
  }
  // Rim.
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const x0 = cx + pts[i * 2];
    const y0 = cy + pts[i * 2 + 1];
    const x1 = cx + pts[j * 2];
    const y1 = cy + pts[j * 2 + 1];
    let nx = (pts[i * 2] + pts[j * 2]) * 0.5;
    let ny = (pts[i * 2 + 1] + pts[j * 2 + 1]) * 0.5;
    const l = 1 / (Math.hypot(nx, ny) || 1);
    nx *= l;
    ny *= l;
    const a = sink.vert(x0, y0, cz - half, nx, ny, 0, 0, 0, c.r, c.g, c.b);
    const b = sink.vert(x1, y1, cz - half, nx, ny, 0, 1, 0, c.r, c.g, c.b);
    const d = sink.vert(x1, y1, cz + half, nx, ny, 0, 1, 1, c.r, c.g, c.b);
    const e = sink.vert(x0, y0, cz + half, nx, ny, 0, 0, 1, c.r, c.g, c.b);
    sink.quad(a, b, d, e);
  }
}

/** A horizontal arm swept along a gentle arc — mast arms, lamp brackets. */
function addArc(
  sink: MeshSink,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  sag: number, radius: number, segs: number, c: RGB,
): void {
  const pts = new Float32Array((segs + 1) * 3);
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts[i * 3] = x0 + (x1 - x0) * t;
    pts[i * 3 + 1] = y0 + (y1 - y0) * t + Math.sin(t * Math.PI) * sag;
    pts[i * 3 + 2] = z0 + (z1 - z0) * t;
  }
  addTube(sink, pts, segs + 1, radius, 5, c, 0.5);
}

/* ================================================================== *
 * Prop meshes
 * ================================================================== *
 * Convention for every prop: origin at the base, on the ground, local +X is
 * "forward" (for a lamp, the direction the mast arm reaches; for a car, the
 * direction it is pointing; for a sign, the direction it faces).
 */

type Builder = (sink: MeshSink) => void;

/** The San Francisco cobra head. 8.2 m pole, 2.6 m arm with the characteristic
 *  shallow S, and a squashed teardrop luminaire that tilts slightly down. */
const buildCobra: Builder = (s) => {
  addCylinder(s, 0, 0, 0, 0.15, 0.13, 0.52, 8, DARK_GREY, 0.5);
  addCylinder(s, 0, 0.5, 0, 0.095, 0.062, 7.7, 8, GALV, 0.5);
  addArc(s, 0, 8.16, 0, 2.35, 8.42, 0, 0.22, 0.05, 6, GALV);
  // Luminaire: two stacked boxes give the teardrop read at a tenth of the cost.
  addBox(s, 2.72, 8.30, 0, 0.42, 0.10, 0.20, 0, DARK_GREY, 0.5);
  addBox(s, 2.68, 8.16, 0, 0.34, 0.07, 0.16, 0, rgb(0xb8b4a8), 0.5);
  // The little arm-to-head cast fitting.
  addCylinder(s, 2.35, 8.30, 0, 0.075, 0.075, 0.14, 6, DARK_GREY, 0.5);
};

/** The downtown twin-globe standard — the "Path of Gold" lamp on Market. */
const buildOrnate: Builder = (s) => {
  addCylinder(s, 0, 0, 0, 0.24, 0.20, 0.34, 7, BRONZE, 0.5, false);
  addCylinder(s, 0, 0.34, 0, 0.155, 0.145, 0.52, 7, BRONZE, 0.5, false);
  addCylinder(s, 0, 0.86, 0, 0.115, 0.078, 3.9, 7, BRONZE, 0.5, false);
  addCylinder(s, 0, 4.76, 0, 0.12, 0.10, 0.22, 7, BRONZE, 0.5, false);
  for (const side of [-1, 1] as const) {
    addArc(s, 0, 4.9, 0, 0, 5.12, side * 0.95, 0.14, 0.042, 6, BRONZE);
    addCylinder(s, 0, 5.06, side * 0.95, 0.11, 0.14, 0.16, 6, BRONZE, 0.5, false);
    // Opal globe.
    addCylinder(s, 0, 5.22, side * 0.95, 0.16, 0.19, 0.20, 7, rgb(0xd8d2c0), 0.5, false);
    addCylinder(s, 0, 5.42, side * 0.95, 0.19, 0.11, 0.20, 7, rgb(0xd8d2c0), 0.5, false);
    addCylinder(s, 0, 5.62, side * 0.95, 0.11, 0.05, 0.10, 6, BRONZE, 0.5);
  }
  // The central finial lamp.
  addCylinder(s, 0, 4.98, 0, 0.13, 0.16, 0.22, 7, rgb(0xd8d2c0), 0.5, false);
  addCylinder(s, 0, 5.20, 0, 0.16, 0.05, 0.22, 7, BRONZE, 0.5);
};

/** Mast-arm traffic signal with a pedestrian head and a push button. */
const buildSignal: Builder = (s) => {
  addCylinder(s, 0, 0, 0, 0.22, 0.19, 0.65, 8, DARK_GREY, 0.5);
  addCylinder(s, 0, 0.62, 0, 0.115, 0.085, 5.3, 8, DARK_GREY, 0.5);
  // Mast arm reaching out over the carriageway, with real sag.
  addArc(s, 0, 5.82, 0, 5.6, 5.62, 0, -0.16, 0.065, 8, DARK_GREY);
  // Vehicle head hanging near the end of the arm.
  const hx = 4.9;
  addCylinder(s, hx, 5.30, 0, 0.05, 0.05, 0.36, 6, DARK_GREY, 0.5);
  addBox(s, hx, 4.86, 0, 0.14, 0.46, 0.17, 0, DARK_GREY, 0.5, true);
  // Visors over each lens.
  for (let i = 0; i < 3; i++) {
    addBox(s, hx + 0.16, 5.16 - i * 0.30, 0, 0.03, 0.12, 0.16, 0, BLACK_TRIM, 0.5);
  }
  // A second head over the far lane.
  addCylinder(s, 2.9, 5.42, 0, 0.045, 0.045, 0.30, 6, DARK_GREY, 0.5);
  addBox(s, 2.9, 4.98, 0, 0.13, 0.44, 0.16, 0, DARK_GREY, 0.5, true);
  // Pedestrian head + push button on the pole.
  addBox(s, 0.24, 3.05, 0, 0.11, 0.22, 0.19, 0, DARK_GREY, 0.5, true);
  addBox(s, 0.20, 1.12, 0, 0.06, 0.09, 0.07, 0, rgb(0xb0b4b6), 0.5, true);
  // Controller cabinet at the base — every real signal has one.
  addBox(s, -0.55, 0.62, 0.34, 0.28, 0.60, 0.20, 0, rgb(0x6d7a6c), 0.5, true);
};

/** The stop sign, on its own slim post. */
const buildStopSign: Builder = (s) => {
  addCylinder(s, 0, 0, 0, 0.045, 0.04, 2.35, 6, GALV, 0.5);
  addPlate(s, 0, 2.66, 0.045, 0.38, 8, 0.035, Math.PI / 8, SIGN_RED, 0.6);
  // White rim, faked as a slightly larger, slightly recessed ring behind.
  addPlate(s, 0, 2.66, 0.02, 0.41, 8, 0.02, Math.PI / 8, SIGN_WHITE, 0.6);
};

/** Two street-name blades crossed at the top of a post. */
const buildBlade: Builder = (s) => {
  addCylinder(s, 0, 0, 0, 0.045, 0.038, 2.9, 6, GALV, 0.5);
  addBox(s, 0.30, 3.02, 0, 0.46, 0.115, 0.02, 0, SIGN_GREEN, 0.6);
  addBox(s, 0, 3.20, 0.30, 0.02, 0.115, 0.46, 0, SIGN_GREEN, 0.6);
  // The white top-and-bottom border stripes read from across the junction.
  addBox(s, 0.30, 3.128, 0, 0.46, 0.008, 0.021, 0, SIGN_WHITE, 0.6);
  addBox(s, 0.30, 2.912, 0, 0.46, 0.008, 0.021, 0, SIGN_WHITE, 0.6);
};

const buildMeter: Builder = (s) => {
  addCylinder(s, 0, 0, 0, 0.055, 0.042, 1.02, 6, MUNI_GREEN, 0.5);
  addBox(s, 0, 1.16, 0, 0.075, 0.14, 0.10, 0, MUNI_GREEN, 0.4, true);
  addBox(s, 0.076, 1.20, 0, 0.006, 0.055, 0.06, 0, BLACK_TRIM, 0.3);
  addCylinder(s, 0, 1.30, 0, 0.075, 0.02, 0.06, 6, MUNI_GREEN, 0.4);
};

/** SF hydrant: fat barrel, domed bonnet, two side outlets, and a bonnet colour
 *  that in this city genuinely encodes which water system feeds it. */
const buildHydrant: Builder = (s) => {
  addCylinder(s, 0, 0, 0, 0.20, 0.185, 0.10, 7, HYDRANT_RED, 0.4, false);
  addCylinder(s, 0, 0.10, 0, 0.135, 0.125, 0.50, 7, HYDRANT_RED, 0.4, false);
  addCylinder(s, 0, 0.60, 0, 0.155, 0.145, 0.10, 7, HYDRANT_RED, 0.4, false);
  addCylinder(s, 0, 0.70, 0, 0.125, 0.105, 0.16, 7, HYDRANT_WHITE, 0.4, false);
  addCylinder(s, 0, 0.86, 0, 0.115, 0.045, 0.10, 7, HYDRANT_WHITE, 0.4);
  // Side outlets and the pumper connection on the front.
  for (const side of [-1, 1] as const) {
    addBox(s, 0, 0.48, side * 0.165, 0.055, 0.055, 0.05, 0, HYDRANT_RED, 0.3, true);
    addBox(s, 0, 0.48, side * 0.20, 0.065, 0.065, 0.015, 0, rgb(0x8d8a80), 0.3, true);
  }
  addBox(s, 0.16, 0.40, 0, 0.05, 0.075, 0.075, 0, HYDRANT_RED, 0.3, true);
  addBox(s, 0.20, 0.40, 0, 0.015, 0.09, 0.09, 0, rgb(0x8d8a80), 0.3, true);
};

const buildMailbox: Builder = (s) => {
  addBox(s, 0, 0.62, 0, 0.30, 0.42, 0.26, 0, USPS_BLUE, 0.5, true);
  addCylinder(s, 0, 1.04, 0, 0.30, 0.26, 0.16, 8, USPS_BLUE, 0.5);
  // Pull-down hopper face.
  addBox(s, 0.30, 0.98, 0, 0.02, 0.14, 0.20, 0, rgb(0x22385e), 0.4);
  for (const side of [-1, 1] as const) {
    addBox(s, 0, 0.10, side * 0.20, 0.26, 0.10, 0.04, 0, DARK_GREY, 0.4);
  }
};

const buildBin: Builder = (s) => {
  addCylinder(s, 0, 0, 0, 0.32, 0.30, 0.86, 8, MUNI_GREEN, 0.5, false);
  addCylinder(s, 0, 0.86, 0, 0.33, 0.30, 0.14, 8, DARK_GREY, 0.5, false);
  addCylinder(s, 0, 1.00, 0, 0.30, 0.16, 0.12, 8, DARK_GREY, 0.5);
  // The chute opening.
  addBox(s, 0.29, 0.92, 0, 0.02, 0.09, 0.13, 0, BLACK_TRIM, 0.3);
};

/** A row of three chained news boxes — never one on its own. */
const buildNewsrack: Builder = (s) => {
  const cols = [rgb(0x9a2f28), rgb(0x2f4d80), rgb(0xb08a20)];
  for (let i = 0; i < 3; i++) {
    const z = (i - 1) * 0.48;
    addBox(s, 0, 0.72, z, 0.22, 0.34, 0.22, 0, cols[i], 0.4, true);
    addBox(s, 0.19, 0.86, z, 0.04, 0.17, 0.17, 0, rgb(0x7f8285), 0.3);
    for (const side of [-1, 1] as const) {
      addBox(s, side * 0.14, 0.19, z, 0.022, 0.19, 0.19, 0, DARK_GREY, 0.3);
    }
  }
};

/** Bus shelter: steel frame, cantilevered roof, ad panel at one end. */
const buildShelter: Builder = (s) => {
  const L = 3.9;
  const D = 1.5;
  for (const ex of [-1, 1] as const) {
    for (const ez of [-1, 1] as const) {
      addCylinder(s, ex * (L * 0.5 - 0.12), 0, ez * (D * 0.5 - 0.08), 0.055, 0.05, 2.55, 6, DARK_GREY, 0.5);
    }
  }
  // Roof: a shallow single-pitch slab with a fascia.
  addBox(s, 0, 2.66, 0, L * 0.5 + 0.16, 0.055, D * 0.5 + 0.22, 0, DARK_GREY, 0.6);
  addBox(s, 0, 2.60, -(D * 0.5 + 0.20), L * 0.5 + 0.16, 0.07, 0.03, 0, rgb(0xb2b6b8), 0.4);
  // Bench inside.
  addBox(s, 0, 0.46, 0.36, L * 0.5 - 0.4, 0.035, 0.19, 0, rgb(0x7d7368), 0.4);
  addBox(s, 0, 0.30, 0.52, L * 0.5 - 0.4, 0.30, 0.03, 0, DARK_GREY, 0.4);
  // Ad-panel frame at the near end.
  addBox(s, L * 0.5 - 0.02, 1.36, 0, 0.05, 1.05, D * 0.5 - 0.06, 0, DARK_GREY, 0.5, true);
};

const buildShelterGlass: Builder = (s) => {
  const L = 3.9;
  const D = 1.5;
  // Back wall + one end panel. The street side is open, as it should be.
  addPanel(s, 0, 1.42, -(D * 0.5 - 0.08), L - 0.3, 2.0, 0, GLASS, [0, 0, 1, 1], true);
  addPanel(s, -(L * 0.5 - 0.12), 1.42, 0, D - 0.2, 2.0, Math.PI / 2, GLASS, [0, 0, 1, 1], true);
};

const buildBench: Builder = (s) => {
  for (const side of [-1, 1] as const) {
    // Cast iron end frames.
    addBox(s, side * 0.72, 0.21, 0, 0.045, 0.21, 0.26, 0, BLACK_TRIM, 0.4, true);
    addBox(s, side * 0.72, 0.44, -0.02, 0.045, 0.03, 0.28, 0, BLACK_TRIM, 0.4);
    addBox(s, side * 0.72, 0.66, -0.22, 0.045, 0.25, 0.04, 0, BLACK_TRIM, 0.4);
  }
  // Slats.
  for (let i = 0; i < 4; i++) {
    addBox(s, 0, 0.47, -0.21 + i * 0.14, 0.74, 0.022, 0.055, 0, rgb(0x7a6a52), 0.4);
  }
  for (let i = 0; i < 3; i++) {
    addBox(s, 0, 0.60 + i * 0.14, -0.24, 0.74, 0.05, 0.022, 0, rgb(0x7a6a52), 0.4);
  }
};

const buildBollard: Builder = (s) => {
  addCylinder(s, 0, 0, 0, 0.11, 0.10, 0.86, 8, DARK_GREY, 0.4, false);
  addCylinder(s, 0, 0.86, 0, 0.10, 0.05, 0.09, 8, DARK_GREY, 0.4);
  addCylinder(s, 0, 0.60, 0, 0.108, 0.108, 0.05, 8, rgb(0xc8c2b2), 0.3);
};

/** Wooden utility pole with two crossarms and a transformer can. */
const buildUtilityPole: Builder = (s) => {
  addCylinder(s, 0, 0, 0, 0.19, 0.13, 10.6, 6, WOOD, 2.4);
  for (let k = 0; k < 2; k++) {
    const y = 9.1 - k * 0.85;
    addBox(s, 0, y, 0, 0.055, 0.055, 1.15, 0, WOOD, 0.6);
    for (let i = -2; i <= 2; i++) {
      if (i === 0) continue;
      addCylinder(s, 0, y + 0.055, i * 0.44, 0.035, 0.028, 0.13, 4, rgb(0x5a6a5e), 0.3);
    }
  }
  // Transformer.
  addCylinder(s, 0.30, 7.2, 0, 0.24, 0.24, 0.62, 6, rgb(0x8d9296), 0.5, false);
  addCylinder(s, 0.30, 7.82, 0, 0.24, 0.20, 0.07, 6, rgb(0x8d9296), 0.5);
  // Service drop bracket.
  addBox(s, 0.16, 6.4, 0, 0.16, 0.03, 0.03, 0, DARK_GREY, 0.3);
};

/**
 * A generic sedan. Deliberately blocky in the way a real car is blocky once you
 * remove the highlights: a low body, a greenhouse set in from it, wheel arches
 * cut as darker recesses and glass baked in as near-black gloss. It is 4.5 m
 * long at unit scale; instances stretch it between 4.1 and 4.9.
 */
const buildSedan: Builder = (s) => {
  const bodyY = 0.66;
  // Lower body.
  addBox(s, 0, bodyY, 0, 2.25, 0.30, 0.86, 0, rgb(0xffffff), 0.7, true);
  // Shoulder.
  addBox(s, 0, bodyY + 0.28, 0, 2.20, 0.14, 0.88, 0, rgb(0xffffff), 0.7);
  // Bonnet and boot.
  addBox(s, 1.42, bodyY + 0.34, 0, 0.82, 0.06, 0.82, 0, rgb(0xffffff), 0.7);
  addBox(s, -1.52, bodyY + 0.34, 0, 0.70, 0.06, 0.82, 0, rgb(0xffffff), 0.7);
  // Greenhouse: dark glass, tapering.
  addBox(s, -0.10, bodyY + 0.60, 0, 1.02, 0.30, 0.76, 0, rgb(0x14171a), 0.6);
  addBox(s, -0.10, bodyY + 0.86, 0, 0.86, 0.05, 0.68, 0, rgb(0xffffff), 0.7);
  // A-pillar / C-pillar wedges to break the box silhouette.
  addBox(s, 0.86, bodyY + 0.56, 0, 0.24, 0.22, 0.66, 0, rgb(0x14171a), 0.6);
  addBox(s, -1.02, bodyY + 0.56, 0, 0.22, 0.22, 0.66, 0, rgb(0x14171a), 0.6);
  // Bumpers, lights, sills.
  addBox(s, 2.22, 0.55, 0, 0.06, 0.16, 0.84, 0, rgb(0x3a3d40), 0.4);
  addBox(s, -2.22, 0.55, 0, 0.06, 0.16, 0.84, 0, rgb(0x3a3d40), 0.4);
  for (const side of [-1, 1] as const) {
    addBox(s, 2.20, 0.80, side * 0.60, 0.05, 0.09, 0.20, 0, rgb(0xd8d4c4), 0.3);
    addBox(s, -2.20, 0.80, side * 0.60, 0.05, 0.09, 0.20, 0, rgb(0x8a2018), 0.3);
    addBox(s, 0, 0.40, side * 0.90, 2.05, 0.06, 0.04, 0, rgb(0x2a2c2e), 0.4);
    // Mirror.
    addBox(s, 0.80, 0.98, side * 0.96, 0.10, 0.06, 0.08, 0, rgb(0x2a2c2e), 0.3, true);
  }
};

/** The taller, boxier half of the fleet: SUVs, vans and pickups. */
const buildSuv: Builder = (s) => {
  const bodyY = 0.82;
  addBox(s, 0, bodyY, 0, 2.35, 0.40, 0.94, 0, rgb(0xffffff), 0.7, true);
  addBox(s, 0, bodyY + 0.40, 0, 2.20, 0.14, 0.94, 0, rgb(0xffffff), 0.7);
  addBox(s, 1.55, bodyY + 0.24, 0, 0.78, 0.10, 0.90, 0, rgb(0xffffff), 0.7);
  addBox(s, -0.25, bodyY + 0.72, 0, 1.62, 0.34, 0.84, 0, rgb(0x14171a), 0.6);
  addBox(s, -0.25, bodyY + 1.04, 0, 1.62, 0.05, 0.80, 0, rgb(0xffffff), 0.7);
  addBox(s, 2.32, 0.72, 0, 0.07, 0.22, 0.92, 0, rgb(0x3a3d40), 0.4);
  addBox(s, -2.32, 0.72, 0, 0.07, 0.22, 0.92, 0, rgb(0x3a3d40), 0.4);
  for (const side of [-1, 1] as const) {
    addBox(s, 2.30, 1.02, side * 0.66, 0.05, 0.10, 0.22, 0, rgb(0xd8d4c4), 0.3);
    addBox(s, -2.30, 1.10, side * 0.70, 0.05, 0.16, 0.14, 0, rgb(0x8a2018), 0.3);
    addBox(s, 0, 0.50, side * 0.98, 2.10, 0.08, 0.05, 0, rgb(0x2a2c2e), 0.4);
    // Roof rails.
    addBox(s, -0.25, bodyY + 1.12, side * 0.62, 1.40, 0.03, 0.04, 0, rgb(0x2a2c2e), 0.3);
  }
};

/**
 * A wheel. The axle runs along local +X — the same axis every other prop uses
 * for "forward" — so the placement code points it along the track direction and
 * the wheel lands on its side without a second rotation.
 */
const buildWheel: Builder = (s) => {
  const R = 0.34;
  const halfW = 0.11;
  const SEG = 6;
  const ring = (x: number, r: number, c: RGB, nxSign: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const cy = Math.cos(a);
      const cz = Math.sin(a);
      out.push(s.vert(
        x, cy * r, cz * r,
        nxSign, nxSign === 0 ? cy : 0, nxSign === 0 ? cz : 0,
        (i / SEG) * 2.2, x + 0.5,
        c.r, c.g, c.b,
      ));
    }
    return out;
  };
  const a = ring(-halfW, R, TYRE, 0);
  const b = ring(halfW, R, TYRE, 0);
  for (let i = 0; i < SEG; i++) s.quad(b[i], b[i + 1], a[i + 1], a[i]);
  // One flat face per side, tinted to the rim: at parked-car distance the
  // difference between this and a modelled rim is nil, and there are twenty
  // thousand of them.
  const rim = rgb(0x9c9ea0);
  for (const side of [-1, 1] as const) {
    const face = ring(side * halfW, R * 0.99, rim, side);
    const hub = s.vert(side * (halfW + 0.015), 0, 0, side, 0, 0, 0.5, 0.5, 0.6, 0.61, 0.62);
    for (let i = 0; i < SEG; i++) {
      if (side > 0) s.tri(hub, face[i], face[i + 1]);
      else s.tri(hub, face[i + 1], face[i]);
    }
  }
};

/** Water-filled construction barrier — the orange plastic kind. */
const buildBarrier: Builder = (s) => {
  addBox(s, 0, 0.30, 0, 0.95, 0.30, 0.19, 0, ORANGE, 0.4, true);
  addBox(s, 0, 0.66, 0, 0.95, 0.08, 0.13, 0, ORANGE, 0.4);
  addBox(s, 0, 0.13, 0, 1.00, 0.13, 0.26, 0, ORANGE, 0.4, true);
  addCylinder(s, 0, 0.74, 0, 0.055, 0.05, 0.10, 6, ORANGE, 0.3);
  // Reflective bands.
  for (const side of [-1, 1] as const) {
    addBox(s, side * 0.5, 0.42, 0, 0.02, 0.16, 0.20, 0, rgb(0xd8d2c0), 0.3);
  }
};

const buildDumpster: Builder = (s) => {
  addBox(s, 0, 0.62, 0, 0.95, 0.52, 0.72, 0, rgb(0x3f5a44), 0.7, true);
  addBox(s, 0, 1.16, 0, 0.98, 0.04, 0.75, 0, rgb(0x35503c), 0.7);
  // Lifting pockets and the corner ribs that make it read as steel.
  for (const side of [-1, 1] as const) {
    addBox(s, side * 0.62, 0.60, 0.74, 0.10, 0.50, 0.03, 0, RUST_STEEL, 0.5);
    addBox(s, side * 0.62, 0.60, -0.74, 0.10, 0.50, 0.03, 0, RUST_STEEL, 0.5);
    addCylinder(s, side * 0.72, 0, 0.55, 0.09, 0.09, 0.12, 6, BLACK_TRIM, 0.3);
    addCylinder(s, side * 0.72, 0, -0.55, 0.09, 0.09, 0.12, 6, BLACK_TRIM, 0.3);
  }
};

/** One bay of tube-and-clamp scaffolding, 2.4 × 1.3 × 2.0 m. Stacked and
 *  repeated along a facade under refurbishment. */
const buildScaffold: Builder = (s) => {
  const W = 1.2;
  const D = 0.65;
  const H = 2.0;
  for (const ex of [-1, 1] as const) {
    for (const ez of [-1, 1] as const) {
      addCylinder(s, ex * W, 0, ez * D, 0.026, 0.026, H + 0.1, 6, RUST_STEEL, 0.4);
    }
  }
  for (const y of [0.5, 1.35, H]) {
    for (const ez of [-1, 1] as const) {
      addBox(s, 0, y, ez * D, W, 0.024, 0.024, 0, RUST_STEEL, 0.4);
    }
    addBox(s, -W, y, 0, 0.024, 0.024, D, 0, RUST_STEEL, 0.4);
  }
  // Deck boards + toe board.
  for (let i = 0; i < 3; i++) {
    addBox(s, 0, 1.42, -D + 0.22 + i * 0.22, W - 0.05, 0.018, 0.10, 0, rgb(0x8a7c62), 0.4);
  }
  addBox(s, 0, 1.55, -D + 0.06, W - 0.05, 0.10, 0.015, 0, rgb(0x8a7c62), 0.4);
  // Diagonal brace.
  addArc(s, -W, 0.1, D, W, H, D, 0, 0.022, 2, RUST_STEEL);
};

const BUILDERS: Record<PropKind, Builder | null> = {
  cobra: buildCobra,
  ornate: buildOrnate,
  "lamp-glow": null, // an icosphere; built separately
  signal: buildSignal,
  "signal-lens": null,
  "stop-sign": buildStopSign,
  blade: buildBlade,
  meter: buildMeter,
  hydrant: buildHydrant,
  mailbox: buildMailbox,
  bin: buildBin,
  newsrack: buildNewsrack,
  shelter: buildShelter,
  "shelter-glass": buildShelterGlass,
  bench: buildBench,
  bollard: buildBollard,
  "utility-pole": buildUtilityPole,
  "car-sedan": buildSedan,
  "car-suv": buildSuv,
  "car-wheel": buildWheel,
  barrier: buildBarrier,
  dumpster: buildDumpster,
  scaffold: buildScaffold,
};

/* ================================================================== *
 * Geometry + material cache
 * ================================================================== */

const geoCache = new Map<PropKind, THREE.BufferGeometry>();

export function propGeometry(kind: PropKind): THREE.BufferGeometry {
  const hit = geoCache.get(kind);
  if (hit) return hit;
  let g: THREE.BufferGeometry;
  if (kind === "lamp-glow" || kind === "signal-lens") {
    // Glow blobs. Two subdivisions is plenty for something that is pure
    // emission and never more than a metre across on screen.
    g = new THREE.IcosahedronGeometry(kind === "lamp-glow" ? 0.34 : 0.115, 1);
  } else {
    const sink = new MeshSink(2048);
    BUILDERS[kind]!(sink);
    g = sink.finalize()!;
  }
  geoCache.set(kind, g);
  return g;
}

/** Which shared material each pool renders with. */
export function propMaterialKind(kind: PropKind): string {
  switch (kind) {
    case "car-sedan":
    case "car-suv":
      return "car-paint";
    case "car-wheel":
      return "rubber-tyre";
    case "utility-pole":
      return "wood-siding";
    case "dumpster":
    case "scaffold":
      return "steel-rusted";
    case "shelter-glass":
      return "glass-curtainwall";
    default:
      return "plastic";
  }
}

const matCache = new Map<string, THREE.Material>();

export function propMaterial(kind: PropKind): THREE.Material {
  const mk = propMaterialKind(kind) as MaterialKind;
  const hit = matCache.get(mk);
  if (hit) return hit;
  // Prop UVs are authored in "tiles" already (each builder divides by a local
  // scale chosen for that object's texel density), so the repeat is 1.
  const m = getMaterial(mk, {
    vertexColors: true,
    repeat: 1,
    name: `sf/prop-${mk}`,
    detail: false,
    transparent: mk === "glass-curtainwall",
    opacity: mk === "glass-curtainwall" ? 0.38 : 1,
  });
  matCache.set(mk, m);
  return m;
}

export function disposePropGeometry(): void {
  for (const g of geoCache.values()) g.dispose();
  geoCache.clear();
  matCache.clear();
}

/* ================================================================== *
 * Placement rules
 * ================================================================== */

/**
 * Driveway cuts along a block face. Written into `out` as [start, end] pairs in
 * metres along the edge. Returns the number of pairs.
 *
 * Frequency is a zoning question: a Sunset block is a garage every 7.6 m
 * because every house has one, a Financial District block has one loading dock
 * and that is it.
 */
export function drivewayCuts(
  e: RoadEdge, side: 1 | -1, s0: number, s1: number, out: Float32Array,
): number {
  if (e.isAlley || s1 - s0 < 10) return 0;
  const d = e.district;
  const dense = d.styles[0] === "stucco-row" ? 0.55
    : d.styles[0] === "victorian" ? 0.3
    : d.styles[0] === "industrial" || d.styles[0] === "warehouse" ? 0.28
    : 0.1;
  const rng = makeRng(hashSeed(`drive|${e.seed}|${side}`));
  let n = 0;
  let s = s0 + rng.range(3, 12);
  while (s < s1 - 6 && n * 2 + 1 < out.length) {
    if (rng.chance(dense)) {
      const w = rng.range(2.8, 4.4);
      out[n * 2] = s;
      out[n * 2 + 1] = Math.min(s + w, s1 - 3);
      n++;
      s += w;
    }
    s += rng.range(6.5, 13);
  }
  return n;
}

/**
 * Street-tree wells along a block face, as distances along the edge.
 *
 * Shared with `Vegetation` so the tree and the hole it grows out of agree, and
 * with `Sidewalks` so neither draws over the other. Wells avoid driveways,
 * because a tree in a driveway is a tree that has been hit by a car.
 */
export function treeWells(
  e: RoadEdge, side: 1 | -1, s0: number, s1: number, out: Float32Array,
): number {
  if (e.isAlley) return 0;
  const walkW = (e.isAlley ? e.carriageway + 0.9 : e.halfWidth + SIDEWALK_WIDTH) - e.carriageway;
  if (walkW < 2.4) return 0;
  const d = e.district;
  // Density: the city's street-tree coverage is famously uneven.
  const cover = d.key === "sunset" || d.key === "richmond" ? 0.55
    : d.key === "fidi" || d.key === "soma" ? 0.8
    : d.key === "presidio" || d.key === "bayview" ? 0.3
    : 0.68;
  const rng = makeRng(hashSeed(`tree|${e.seed}|${side}`));
  const cutN = drivewayCuts(e, side, s0, s1, _cutScratch);
  let n = 0;
  let s = s0 + rng.range(4, 10);
  while (s < s1 - 3.5 && n < out.length) {
    let blocked = false;
    for (let i = 0; i < cutN; i++) {
      if (s > _cutScratch[i * 2] - 1.6 && s < _cutScratch[i * 2 + 1] + 1.6) blocked = true;
    }
    if (!blocked && rng.chance(cover)) out[n++] = s;
    s += rng.range(8.5, 14);
  }
  return n;
}

const _cutScratch = new Float32Array(32);

/* ================================================================== *
 * Instance placement
 * ================================================================== */

const _m = new THREE.Matrix4();
const _vx = new THREE.Vector3();
const _vy = new THREE.Vector3();
const _vz = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();

/**
 * Build an instance matrix from a forward vector. Everything in this module has
 * local +X forward and +Y up, so the basis is (forward, up, forward × up) with
 * `up` orthogonalised against the forward vector — which is what lets a parked
 * car sit *on* a 20 % grade rather than hovering over it at a jaunty angle.
 */
function basis(
  px: number, py: number, pz: number,
  fx: number, fy: number, fz: number,
  sx: number, sy: number, sz: number,
): THREE.Matrix4 {
  _vx.set(fx, fy, fz);
  if (_vx.lengthSq() < 1e-8) _vx.set(1, 0, 0);
  _vx.normalize();
  _vy.set(0, 1, 0).addScaledVector(_vx, -_vx.y);
  if (_vy.lengthSq() < 1e-8) _vy.set(0, 0, 1);
  _vy.normalize();
  _vz.crossVectors(_vx, _vy).normalize();
  _m.makeBasis(_vx, _vy, _vz);
  _scl.set(sx, sy, sz);
  _pos.set(px, py, pz);
  _m.scale(_scl);
  _m.setPosition(_pos);
  return _m;
}

/**
 * `roadSurface` returns a shared scratch record — that is deliberate (it is
 * called tens of thousands of times per chunk and must not allocate), but it
 * means any value held across another call has to live in its own slot. These
 * are those slots.
 */
const _S1: SurfacePoint = { x: 0, y: 0, z: 0, rx: 0, rz: 0, tx: 0, ty: 0, tz: 0 };
const _S2: SurfacePoint = { x: 0, y: 0, z: 0, rx: 0, rz: 0, tx: 0, ty: 0, tz: 0 };

/** Pavement surface height at a lateral offset on an edge. */
function walkY(e: RoadEdge, s: number, side: 1 | -1, lat: number): number {
  const kerb = roadSurface(e, s, side * e.carriageway).y + KERB_HEIGHT;
  const off = Math.max(0, lat - e.carriageway - 0.16);
  return kerb + off * 0.02;
}

/** Position + pavement height in one go, into a caller-owned slot. */
function walkPoint(e: RoadEdge, s: number, side: 1 | -1, lat: number, out: SurfacePoint): SurfacePoint {
  roadSurface(e, s, side * lat, out);
  out.y = walkY(e, s, side, lat);
  return out;
}

interface PlaceCtx {
  chunk: InstanceChunk;
  tier: QualityTier;
  density: number;
  time: number;
}

function put(
  ctx: PlaceCtx, kind: PropKind,
  px: number, py: number, pz: number,
  fx: number, fy: number, fz: number,
  sx: number, sy: number, sz: number,
  c: RGB | null, meta0 = 0, meta1 = 0,
): void {
  const b: InstanceBlock = blockFor(ctx.chunk, kind);
  b.push(basis(px, py, pz, fx, fy, fz, sx, sy, sz), c ? c.r : 1, c ? c.g : 1, c ? c.b : 1, meta0, meta1);
}

/* ---------------- per-edge furniture ---------------- */

const _wells = new Float32Array(64);
const _cuts = new Float32Array(32);
const _carCol: RGB = { r: 1, g: 1, b: 1 };

/** The palette real streets are parked with: mostly monochrome, a few reds. */
const CAR_COLOURS = [
  0xb8b9bb, 0xd8d9da, 0x2c2e31, 0x54585c, 0x8f9295, 0x1d2a3a, 0x7a1f1c,
  0x1f3a2a, 0x2e4a6a, 0xa8a093, 0x6a1f2a, 0xc0c2c0, 0x35383b, 0x94989b,
];

function placeEdge(ctx: PlaceCtx, e: RoadEdge): void {
  const span = edgeSpan(e);
  if (span.len < 6) return;
  const rng = makeRng(e.seed ^ 0x7ad3);
  const d = e.district;
  const commercial = d.density > 0.8 && (d.maxHeight > 24 || d.key === "mission" || d.key === "haight");
  const park = isPark((roadNetwork.nodes[e.a].x + roadNetwork.nodes[e.b].x) * 0.5,
    (roadNetwork.nodes[e.a].z + roadNetwork.nodes[e.b].z) * 0.5);

  for (const side of [1, -1] as const) {
    const chw = e.carriageway;
    const outer = e.isAlley ? chw + 0.9 : e.halfWidth + SIDEWALK_WIDTH;
    const walkW = outer - chw;
    // Facing: props on the pavement look at the road.
    const fx = -side * e.rx;
    const fz = -side * e.rz;

    /* --- street lighting --- */
    if (!e.isAlley) {
      // Ornate twin standards downtown and along Market; cobras everywhere else.
      const ornate = e.cls === "boulevard" || (d.key === "fidi" && rng.chance(0.6)) || d.key === "embarcadero";
      const spacing = e.cls === "boulevard" ? 26 : e.cls === "arterial" ? 32 : 38;
      // Real cities stagger lamps side to side; the offset does that.
      const phase = side === 1 ? 0 : spacing * 0.5;
      for (let s = span.s0 + 4 + phase; s < span.s1 - 3; s += spacing) {
        const lat = chw + Math.min(0.75, walkW * 0.28);
        const p = walkPoint(e, s, side, lat, _S1);
        const y = p.y;
        if (ornate) {
          put(ctx, "ornate", p.x, y, p.z, fx, 0, fz, 1, 1, 1, null);
          put(ctx, "lamp-glow", p.x - fz * 0.95, y + 5.3, p.z + fx * 0.95, 1, 0, 0, 1, 1, 1, null);
          put(ctx, "lamp-glow", p.x + fz * 0.95, y + 5.3, p.z - fx * 0.95, 1, 0, 0, 1, 1, 1, null);
          put(ctx, "lamp-glow", p.x, y + 5.1, p.z, 1, 0, 0, 0.8, 0.8, 0.8, null);
        } else {
          const h = 0.9 + rng.next() * 0.16;
          put(ctx, "cobra", p.x, y, p.z, fx, 0, fz, 1, h, 1, null);
          put(ctx, "lamp-glow", p.x + fx * 2.7, y + 8.16 * h, p.z + fz * 2.7, 1, 0, 0, 1.15, 0.55, 1.0, null);
        }
      }
    }

    /* --- overhead line poles --- */
    // Wooden poles live on residential and industrial streets; downtown put its
    // wires underground in 1906 and never looked back.
    if (!e.isAlley && !park && d.maxHeight < 40 && rng.chance(0.75)) {
      const spacing = 42;
      for (let s = span.s0 + 8 + (side === 1 ? 0 : 21); s < span.s1 - 5; s += spacing) {
        if (side === -1 && !rng.chance(0.35)) continue;
        const lat = outer - 0.55;
        const p = walkPoint(e, s, side, lat, _S1);
        put(ctx, "utility-pole", p.x, p.y, p.z, fx, 0, fz, 1, 1 + rng.range(-0.06, 0.08), 1, null);
      }
    }

    /* --- parking meters --- */
    if (commercial && !e.isAlley && e.cls !== "boulevard" && walkW > 2.6) {
      const wellN = treeWells(e, side, span.s0, span.s1, _wells);
      const cutN = drivewayCuts(e, side, span.s0, span.s1, _cuts);
      for (let s = span.s0 + 3; s < span.s1 - 3; s += 6.6) {
        let blocked = false;
        for (let i = 0; i < cutN; i++) {
          if (s > _cuts[i * 2] - 1 && s < _cuts[i * 2 + 1] + 1) blocked = true;
        }
        for (let i = 0; i < wellN; i++) if (Math.abs(s - _wells[i]) < 1.1) blocked = true;
        if (blocked || !rng.chance(0.82 * ctx.density)) continue;
        const lat = chw + 0.55;
        const p = walkPoint(e, s, side, lat, _S1);
        put(ctx, "meter", p.x, p.y, p.z, fx, 0, fz, 1, 1, 1, null);
      }
    }

    /* --- hydrants --- */
    if (!e.isAlley && walkW > 1.6) {
      for (let s = span.s0 + rng.range(6, 26); s < span.s1 - 4; s += rng.range(55, 95)) {
        const lat = chw + Math.min(0.62, walkW * 0.3);
        const p = walkPoint(e, s, side, lat, _S1);
        // SF paints the bonnet by supply: white for the high-pressure AWSS,
        // red for the low, blue and black for the rest.
        const bonnet = rng.next();
        _carCol.r = 1; _carCol.g = 1; _carCol.b = 1;
        if (bonnet < 0.34) { _carCol.r = 1.15; _carCol.g = 1.12; _carCol.b = 1.05; }
        else if (bonnet < 0.6) { _carCol.r = 0.9; _carCol.g = 0.95; _carCol.b = 1.25; }
        else if (bonnet < 0.75) { _carCol.r = 0.7; _carCol.g = 0.7; _carCol.b = 0.72; }
        put(ctx, "hydrant", p.x, p.y, p.z, fx, 0, fz, 1, 1, 1, _carCol);
      }
    }

    /* --- kerbside parking --- */
    if (e.parking && !e.isAlley && !park) {
      placeParking(ctx, e, side, span.s0, span.s1, rng);
    }

    /* --- bins, racks, benches, bollards --- */
    if (!e.isAlley && walkW > 2.8) {
      for (let s = span.s0 + rng.range(5, 20); s < span.s1 - 4; s += rng.range(28, 70)) {
        const lat = chw + Math.min(0.85, walkW * 0.34);
        const p = walkPoint(e, s, side, lat, _S1);
        const y = p.y;
        const roll = rng.next();
        if (roll < 0.34) put(ctx, "bin", p.x, y, p.z, fx, 0, fz, 1, 1, 1, null);
        else if (roll < 0.5 && commercial) put(ctx, "newsrack", p.x, y, p.z, fx, 0, fz, 1, 1, 1, null);
        else if (roll < 0.62) {
          // Benches sit against the building line, facing the street.
          const bp = walkPoint(e, s, side, outer - 0.9, _S2);
          put(ctx, "bench", bp.x, bp.y, bp.z, -fz, 0, fx, 1, 1, 1, null);
        } else if (roll < 0.68 && commercial) put(ctx, "mailbox", p.x, y, p.z, fx, 0, fz, 1, 1, 1, null);
      }
    }

    /* --- alleys: the back-of-house layer --- */
    if (e.isAlley) {
      for (let s = span.s0 + rng.range(2, 8); s < span.s1 - 3; s += rng.range(11, 26)) {
        const lat = chw + 0.9;
        const p = roadSurface(e, s, side * lat, _S1);
        if (rng.chance(0.55)) put(ctx, "dumpster", p.x, p.y, p.z, fx, 0, fz, 1, 1, 1, null);
      }
    }
  }

  /* --- bus stops --- */
  if ((e.transitLane || e.trolley) && !e.isAlley && span.len > 40 && rng.chance(0.5)) {
    const side: 1 | -1 = rng.chance(0.5) ? 1 : -1;
    const s = span.s0 + span.len * rng.range(0.3, 0.7);
    const lat = e.carriageway + Math.min(2.1, (e.halfWidth + SIDEWALK_WIDTH - e.carriageway) * 0.55);
    const p = walkPoint(e, s, side, lat, _S1);
    const fx = -side * e.rx;
    const fz = -side * e.rz;
    // The shelter's long axis runs along the kerb, glass to the back.
    put(ctx, "shelter", p.x, p.y, p.z, -fz * side, 0, fx * side, 1, 1, 1, null);
    put(ctx, "shelter-glass", p.x, p.y, p.z, -fz * side, 0, fx * side, 1, 1, 1, null);
  }

  /* --- construction --- */
  if (!e.isAlley && rng.chance(0.06)) {
    const side: 1 | -1 = rng.chance(0.5) ? 1 : -1;
    const s0 = span.s0 + span.len * rng.range(0.1, 0.5);
    const runs = Math.min(6, Math.floor(span.len * 0.2 / 2.4));
    const fx = -side * e.rx;
    const fz = -side * e.rz;
    const outer = e.halfWidth + SIDEWALK_WIDTH;
    for (let i = 0; i < runs; i++) {
      const s = s0 + i * 2.4;
      if (s > span.s1 - 3) break;
      const p = walkPoint(e, s, side, outer - 0.8, _S1);
      for (let lvl = 0; lvl < 3; lvl++) {
        put(ctx, "scaffold", p.x, p.y + lvl * 2.0, p.z, -fz * side, 0, fx * side, 1, 1, 1, null);
      }
      const bp = roadSurface(e, s, side * (e.carriageway - 0.6), _S2);
      put(ctx, "barrier", bp.x, bp.y, bp.z, -fz * side, 0, fx * side, 1, 1, 1, null);
    }
  }
}

/**
 * Cars along the kerb.
 *
 * Two things matter and both are about hills. First, cars park *along* the
 * grade, so the instance basis comes from the road tangent including its
 * vertical component — a car on Filbert Street points 17° up. Second, San
 * Francisco law requires wheels curbed on any grade over 3 %, so on a steep
 * block the noses are turned a few degrees into the kerb. Nobody will
 * consciously notice; everybody would notice its absence.
 */
function placeParking(
  ctx: PlaceCtx, e: RoadEdge, side: 1 | -1, s0: number, s1: number, rng: Rng,
): void {
  const lane = e.lanes.find((l) => l.kind === "parking" && (side === 1 ? l.offset > 0 : l.offset < 0));
  if (!lane) return;
  const cutN = drivewayCuts(e, side, s0, s1, _cuts);
  const occupancy = clamp01(0.42 + e.district.density * 0.45) * ctx.density;
  const steep = Math.abs(e.grade) > 0.03;

  let s = s0 + rng.range(2, 6);
  while (s < s1 - 5.4) {
    const len = rng.range(4.4, 5.4);
    let blocked = false;
    for (let i = 0; i < cutN; i++) {
      if (s + len > _cuts[i * 2] - 1.2 && s < _cuts[i * 2 + 1] + 1.2) blocked = true;
    }
    if (!blocked && rng.chance(occupancy)) {
      const suv = rng.chance(0.36);
      const p = roadSurface(e, s + len * 0.5, lane.offset, _S1);
      // Forward vector along the road, uphill or downhill at random.
      const dir = rng.chance(0.5) ? 1 : -1;
      let fx = p.tx * dir;
      const fy = p.ty * dir;
      let fz = p.tz * dir;
      if (steep) {
        // Wheels to the kerb: yaw the nose a few degrees toward the pavement.
        const turn = (Math.sign(e.grade) * dir > 0 ? 1 : -1) * side * 0.09;
        const c = Math.cos(turn);
        const sn = Math.sin(turn);
        const nx = fx * c + fz * sn;
        const nz = -fx * sn + fz * c;
        fx = nx;
        fz = nz;
      }
      const hex = CAR_COLOURS[rng.int(0, CAR_COLOURS.length - 1)];
      rgb(hex, _carCol);
      const lenScale = (suv ? rng.range(0.96, 1.08) : rng.range(0.92, 1.06));
      const widScale = rng.range(0.94, 1.05);
      const kind: PropKind = suv ? "car-suv" : "car-sedan";
      // Sit the body on its wheels: the geometry's origin is at ground level.
      put(ctx, kind, p.x, p.y, p.z, fx, fy, fz, lenScale, lenScale, widScale, _carCol);
      // Four wheels, laid on their sides at the axle positions.
      const wheelBase = (suv ? 1.42 : 1.36) * lenScale;
      const track = (suv ? 0.86 : 0.82) * widScale;
      // Local axes in world space.
      const ax = fx;
      const az = fz;
      const rxw = -az;
      const rzw = ax;
      for (const fw of [1, -1] as const) {
        for (const sw of [1, -1] as const) {
          const wx = p.x + ax * wheelBase * fw + rxw * track * sw;
          const wz = p.z + az * wheelBase * fw + rzw * track * sw;
          const wy = p.y + 0.34 * lenScale;
          // The wheel's local +Y is the axle, so "forward" for the basis is the
          // track direction; that lays the cylinder on its side.
          put(ctx, "car-wheel", wx, wy, wz, rxw * sw, 0, rzw * sw, lenScale, lenScale, lenScale, null);
        }
      }
    }
    s += len + rng.range(0.4, 1.4);
  }
}

/* ---------------- per-node furniture ---------------- */

function placeNode(ctx: PlaceCtx, n: RoadNode): void {
  const deg = n.edges.length;
  if (deg < 2) return;
  const rng = makeRng(n.seed ^ 0x22b1);

  for (let i = 0; i < deg; i++) {
    const e = roadNetwork.edges[n.edges[i]];
    if (e.isAlley) continue;
    const atA = e.a === n.id;
    const outDx = atA ? e.dx : -e.dx;
    const outDz = atA ? e.dz : -e.dz;
    const trim = atA ? e.trimA : e.trimB;
    const chw = e.carriageway;
    const outer = e.halfWidth + SIDEWALK_WIDTH;
    // Kerbside position just outside the crossing on the near-side corner.
    const side: 1 | -1 = 1;
    const lat = chw + Math.min(1.0, (outer - chw) * 0.35);
    const d = Math.max(trim + 1.2, 3.0);
    const s = clamp(atA ? d : e.length - d, 0, e.length);
    const p = walkPoint(e, s, atA ? side : (-side as 1 | -1), lat, _S1);
    const y = p.y;

    if (n.control === "signal") {
      // The mast arm reaches out across this approach's carriageway.
      put(ctx, "signal", p.x, y, p.z, -outDx, 0, -outDz, 1, 1, 1, null);
      // Three lenses on the far head, three on the near head, one ped head.
      const group = n.phaseOf[i] ?? 0;
      const armX = -outDx;
      const armZ = -outDz;
      for (const [hx, scale] of [[4.9, 1], [2.9, 0.94]] as [number, number][]) {
        for (let k = 0; k < 3; k++) {
          put(
            ctx, "signal-lens",
            p.x + armX * hx, y + (5.16 - k * 0.30) * scale, p.z + armZ * hx,
            armX, 0, armZ, 1, 1, 1, null,
            n.id, group * 4 + k,
          );
        }
      }
      put(ctx, "signal-lens", p.x + armX * 0.28, y + 3.05, p.z + armZ * 0.28, armX, 0, armZ, 1.4, 1.4, 0.6, null, n.id, group * 4 + 3);
    } else if (n.control === "stop" && rng.chance(0.85)) {
      put(ctx, "stop-sign", p.x, y, p.z, -outDx, 0, -outDz, 1, 1, 1, null);
    }

    // Street-name blades: one post per corner, on the higher-class approach.
    if (i === 0 || (deg >= 3 && i === 1)) {
      put(ctx, "blade", p.x + outDx * 0.9, y, p.z + outDz * 0.9, -outDx, 0, -outDz, 1, 1, 1, null);
    }

    // Bollards protecting the kerb return on wide junctions.
    if (n.cls === "boulevard" && rng.chance(0.5)) {
      for (let k = 0; k < 3; k++) {
        const bp = roadSurface(e, clamp(s + (atA ? 1 : -1) * k * 1.4, 0, e.length), atA ? lat + 0.7 : -(lat + 0.7), _S2);
        put(ctx, "bollard", bp.x, y, bp.z, -outDx, 0, -outDz, 1, 1, 1, null);
      }
    }
  }
}

/* ================================================================== *
 * Chunk build
 * ================================================================== */

const _edges: RoadEdge[] = [];
const _nodes: RoadNode[] = [];

/**
 * Bake every instance in a chunk. The result is a set of flat Float32Arrays the
 * pools memcpy straight into their instance buffers.
 */
export function buildPropChunk(
  x: number, z: number, size: number, tier: QualityTier,
): InstanceChunk {
  const chunk: InstanceChunk = new Map();
  roadNetwork.ensureRect(x - 300, z - 300, x + size + 300, z + size + 300);
  roadNetwork.edgesInRect(x, z, x + size, z + size, _edges);
  roadNetwork.nodesInRect(x, z, x + size, z + size, _nodes);
  const ctx: PlaceCtx = {
    chunk,
    tier,
    density: clamp(QUALITY[tier].crowdDensity, 0.3, 1.4),
    time: 0,
  };
  for (const e of _edges) placeEdge(ctx, e);
  for (const n of _nodes) placeNode(ctx, n);
  return chunk;
}

/* ================================================================== *
 * Overhead wire geometry
 * ================================================================== */

/**
 * Trolleybus catenary and the utility drop wires.
 *
 * A trolleybus needs *two* wires 0.6 m apart (it has no rails to return the
 * current through), suspended about 5.6 m up and hung from span wires that
 * cross the street. Getting the pair right is the whole read: a single wire
 * says "tram", two wires says "San Francisco".
 */
export function buildWireChunk(
  x: number, z: number, size: number,
): THREE.BufferGeometry | null {
  roadNetwork.ensureRect(x - 300, z - 300, x + size + 300, z + size + 300);
  roadNetwork.edgesInRect(x, z, x + size, z + size, _edges);
  const sink = new MeshSink(3000);
  const wire = rgb(0x2e2b28);
  const pts = new Float32Array(3 * 9);

  for (const e of _edges) {
    const span = edgeSpan(e);
    if (span.len < 8) continue;

    if (e.trolley) {
      for (const off of [-0.3, 0.3]) {
        const n = 8;
        for (let i = 0; i <= n; i++) {
          const s = span.s0 + (span.len * i) / n;
          const p = roadSurface(e, s, off);
          const t = i / n;
          pts[i * 3] = p.x;
          // Catenary sag between the span wires at each junction.
          pts[i * 3 + 1] = p.y + 5.75 - Math.sin(t * Math.PI) * 0.22;
          pts[i * 3 + 2] = p.z;
        }
        addTube(sink, pts, 9, 0.028, 4, wire, 1);
      }
      // Span wire across the street at each end.
      for (const s of [span.s0 + 1.5, span.s1 - 1.5]) {
        const a = roadSurface(e, s, -(e.halfWidth + 1.5));
        const ax = a.x;
        const ay = a.y;
        const az = a.z;
        const b = roadSurface(e, s, e.halfWidth + 1.5);
        for (let i = 0; i <= 6; i++) {
          const t = i / 6;
          pts[i * 3] = ax + (b.x - ax) * t;
          pts[i * 3 + 1] = ay + 7.2 + (b.y - ay) * t - Math.sin(t * Math.PI) * 0.5;
          pts[i * 3 + 2] = az + (b.z - az) * t;
        }
        addTube(sink, pts, 7, 0.022, 4, wire, 1);
      }
    }

    // Utility drops: the sagging low-voltage bundle that crosses every
    // residential street in the city and that nobody ever models.
    if (!e.isAlley && !e.trolley && e.district.maxHeight < 40) {
      const rng = makeRng(e.seed ^ 0x9911);
      if (!rng.chance(0.7)) continue;
      const side = rng.chance(0.5) ? 1 : -1;
      const lat = side * (e.halfWidth + SIDEWALK_WIDTH - 0.55);
      const spacing = 42;
      for (let s = span.s0 + 8; s + spacing < span.s1 - 5; s += spacing) {
        const a = roadSurface(e, s, lat);
        const ax = a.x;
        const ay = a.y;
        const az = a.z;
        const b = roadSurface(e, s + spacing, lat);
        for (let k = 0; k < 3; k++) {
          const dz = (k - 1) * 0.34;
          for (let i = 0; i <= 6; i++) {
            const t = i / 6;
            pts[i * 3] = ax + (b.x - ax) * t - e.rx * side * dz;
            pts[i * 3 + 1] = ay + 8.4 + (b.y - ay) * t - Math.sin(t * Math.PI) * 1.15;
            pts[i * 3 + 2] = az + (b.z - az) * t - e.rz * side * dz;
          }
          addTube(sink, pts, 7, 0.019, 4, wire, 1);
        }
      }
    }
  }
  return sink.finalize({ x: x + size * 0.5, y: 0, z: z + size * 0.5 });
}

/** Ground height helper re-exported for the vegetation placer. */
export { terrainHeight, districtAt };
