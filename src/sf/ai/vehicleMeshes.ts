/**
 * ai/vehicleMeshes.ts — the rolling stock, procedurally lofted.
 *
 * Thirteen vehicle types, one material, one draw call each, and no art assets.
 * Every body is a single closed loft: a sequence of cross-sections along the
 * car's length, each an ellipse-blended rounded rectangle, with the surface
 * region (paint / glass / trim / rubber / lamp) decided per vertex from where
 * that vertex sits in the section rather than from separate meshes. That is
 * what makes a Crown Victoria and a MUNI bus the same twelve lines of code with
 * different numbers, and it is why the glasshouse tapers into the bodywork
 * instead of being a box sitting on a box.
 *
 * Wheels are baked into the same geometry and spun in the vertex shader about a
 * per-vertex pivot, with the front pair also taking the steering angle. Four
 * extra floats per vertex buy rolling, steering wheels for free — the standard
 * trick, and the reason traffic can be one draw call per type rather than five.
 *
 * Lamps are emissive channels, not textures: headlights, brake lights, and the
 * two halves of a police light bar each get their own region so the sim can
 * drive them per instance. A night shot of Van Ness with two hundred pairs of
 * tail lights costs exactly as much as a day shot.
 *
 * Public API
 * ----------
 *   VEHICLE_SPECS            dimensions + behaviour hints per kind
 *   buildVehicleGeometry()
 *   VehicleBatch             instanced renderer + writer
 */
import * as THREE from "three";
import type { TrafficVehicleKind } from "./types";
import { TRAFFIC_KINDS } from "./types";

/* ================================================================== *
 * Specifications
 * ================================================================== */

export interface VehicleSpec {
  kind: TrafficVehicleKind;
  /** Overall metres. */
  length: number;
  width: number;
  height: number;
  /** Axle positions measured from the body centre, +X forward. */
  frontAxle: number;
  rearAxle: number;
  wheelRadius: number;
  wheelWidth: number;
  /** Where the greenhouse starts and ends along X. */
  cabinFront: number;
  cabinRear: number;
  /** Height of the window sill above the ground. */
  beltline: number;
  /** Roof height above the ground. */
  roof: number;
  /** 0 = wedge sports profile, 1 = upright box. */
  boxiness: number;
  /** Fitted with a light bar. */
  lightbar: boolean;
  /** Emergency vehicle — siren, right of way, others yield. */
  emergency: boolean;
  /** Mass proxy for the traffic sim, tonnes. */
  mass: number;
  /** Desired free-flow speed, m/s. */
  desiredSpeed: number;
  /** Comfortable acceleration / braking, m/s². */
  accel: number;
  brake: number;
  /** Paint palette this kind may be sprayed in, 0xRRGGBB. */
  palette: number[];
  /** Runs on a fixed route rather than free-roaming. */
  routed: boolean;
}

function spec(s: Partial<VehicleSpec> & { kind: TrafficVehicleKind }): VehicleSpec {
  const base: VehicleSpec = {
    kind: s.kind,
    length: 4.6,
    width: 1.84,
    height: 1.46,
    frontAxle: 1.42,
    rearAxle: -1.4,
    wheelRadius: 0.34,
    wheelWidth: 0.22,
    cabinFront: 0.55,
    cabinRear: -1.35,
    beltline: 1.0,
    roof: 1.46,
    boxiness: 0.35,
    lightbar: false,
    emergency: false,
    mass: 1.5,
    desiredSpeed: 13.4, // 30 mph — SF's default limit
    accel: 2.1,
    brake: 4.6,
    palette: [0x30343a, 0x9aa1a8, 0xb9bec4, 0x1c1f24, 0x6d7379, 0x2c3e50, 0x7a2f2a, 0x3f5a46, 0xd8d5cc],
    routed: false,
  };
  return { ...base, ...s };
}

export const VEHICLE_SPECS: Record<TrafficVehicleKind, VehicleSpec> = {
  sedan: spec({ kind: "sedan" }),
  hatchback: spec({
    kind: "hatchback",
    length: 4.05,
    width: 1.76,
    height: 1.5,
    frontAxle: 1.24,
    rearAxle: -1.2,
    cabinFront: 0.5,
    cabinRear: -1.5,
    boxiness: 0.5,
    mass: 1.2,
    desiredSpeed: 13.0,
  }),
  suv: spec({
    kind: "suv",
    length: 4.9,
    width: 1.96,
    height: 1.78,
    frontAxle: 1.5,
    rearAxle: -1.48,
    wheelRadius: 0.39,
    wheelWidth: 0.26,
    cabinFront: 0.62,
    cabinRear: -1.78,
    beltline: 1.16,
    roof: 1.78,
    boxiness: 0.62,
    mass: 2.2,
    desiredSpeed: 13.2,
    accel: 1.9,
  }),
  taxi: spec({
    kind: "taxi",
    length: 4.72,
    height: 1.52,
    beltline: 1.04,
    roof: 1.52,
    palette: [0xf0b429, 0xe8a51c, 0xf5c33f],
    desiredSpeed: 14.2,
    accel: 2.4,
  }),
  van: spec({
    kind: "van",
    length: 5.4,
    width: 2.0,
    height: 2.3,
    frontAxle: 1.55,
    rearAxle: -1.6,
    wheelRadius: 0.37,
    cabinFront: 1.2,
    cabinRear: 0.1,
    beltline: 1.42,
    roof: 2.3,
    boxiness: 0.9,
    mass: 2.6,
    desiredSpeed: 12.4,
    accel: 1.6,
    brake: 4.0,
    palette: [0xe6e4df, 0xcfd2d4, 0x8d9298, 0x3a4046, 0xb0442f],
  }),
  pickup: spec({
    kind: "pickup",
    length: 5.5,
    width: 2.02,
    height: 1.86,
    frontAxle: 1.7,
    rearAxle: -1.7,
    wheelRadius: 0.41,
    wheelWidth: 0.28,
    cabinFront: 0.9,
    cabinRear: -0.5,
    beltline: 1.24,
    roof: 1.86,
    boxiness: 0.8,
    mass: 2.4,
    desiredSpeed: 13.0,
    accel: 1.9,
  }),
  bus: spec({
    kind: "bus",
    length: 12.2,
    width: 2.55,
    height: 3.2,
    frontAxle: 4.2,
    rearAxle: -3.6,
    wheelRadius: 0.5,
    wheelWidth: 0.32,
    cabinFront: 5.6,
    cabinRear: -5.6,
    beltline: 1.85,
    roof: 3.2,
    boxiness: 1,
    mass: 12,
    desiredSpeed: 10.4,
    accel: 1.0,
    brake: 3.2,
    palette: [0xb63b2e, 0xd8d5cc, 0x2f3d52],
    routed: true,
  }),
  cablecar: spec({
    kind: "cablecar",
    length: 8.6,
    width: 2.4,
    height: 3.0,
    frontAxle: 2.7,
    rearAxle: -2.7,
    wheelRadius: 0.36,
    wheelWidth: 0.14,
    cabinFront: 3.6,
    cabinRear: -3.6,
    beltline: 1.55,
    roof: 3.0,
    boxiness: 1,
    mass: 7,
    desiredSpeed: 4.2, // 9.5 mph, the real cable speed
    accel: 0.8,
    brake: 2.4,
    palette: [0x8f2f28, 0x6d2620],
    routed: true,
  }),
  police: spec({
    kind: "police",
    length: 4.95,
    width: 1.94,
    height: 1.52,
    frontAxle: 1.55,
    rearAxle: -1.5,
    cabinFront: 0.6,
    cabinRear: -1.5,
    beltline: 1.04,
    roof: 1.52,
    lightbar: true,
    emergency: true,
    mass: 1.9,
    desiredSpeed: 17.5,
    accel: 3.2,
    brake: 6.2,
    palette: [0xe8e9ea, 0x1b2430],
  }),
  swatvan: spec({
    kind: "swatvan",
    length: 6.1,
    width: 2.2,
    height: 2.6,
    frontAxle: 1.9,
    rearAxle: -1.85,
    wheelRadius: 0.42,
    wheelWidth: 0.3,
    cabinFront: 1.5,
    cabinRear: 0.3,
    beltline: 1.6,
    roof: 2.6,
    boxiness: 1,
    lightbar: true,
    emergency: true,
    mass: 4.2,
    desiredSpeed: 14.5,
    accel: 1.8,
    brake: 4.6,
    palette: [0x22282e, 0x171c21],
  }),
  ambulance: spec({
    kind: "ambulance",
    length: 6.4,
    width: 2.25,
    height: 2.75,
    frontAxle: 2.0,
    rearAxle: -1.95,
    wheelRadius: 0.42,
    cabinFront: 2.0,
    cabinRear: 0.9,
    beltline: 1.7,
    roof: 2.75,
    boxiness: 1,
    lightbar: true,
    emergency: true,
    mass: 4.0,
    desiredSpeed: 16.0,
    accel: 2.0,
    brake: 4.8,
    palette: [0xf2f3f4],
  }),
  firetruck: spec({
    kind: "firetruck",
    length: 9.4,
    width: 2.5,
    height: 3.1,
    frontAxle: 3.0,
    rearAxle: -2.8,
    wheelRadius: 0.52,
    wheelWidth: 0.34,
    cabinFront: 3.2,
    cabinRear: 1.4,
    beltline: 1.95,
    roof: 3.1,
    boxiness: 1,
    lightbar: true,
    emergency: true,
    mass: 14,
    desiredSpeed: 14.0,
    accel: 1.2,
    brake: 3.4,
    palette: [0xa8241d, 0x8f1d17],
  }),
  apc: spec({
    kind: "apc",
    length: 6.8,
    width: 2.7,
    height: 2.6,
    frontAxle: 2.2,
    rearAxle: -2.1,
    wheelRadius: 0.56,
    wheelWidth: 0.36,
    cabinFront: 1.6,
    cabinRear: -0.4,
    beltline: 1.55,
    roof: 2.6,
    boxiness: 0.95,
    lightbar: false,
    emergency: true,
    mass: 16,
    desiredSpeed: 12.0,
    accel: 1.1,
    brake: 3.0,
    palette: [0x3f4536, 0x4a4f3c, 0x35392c],
  }),
};

/* ================================================================== *
 * Regions
 * ================================================================== */
const V_PAINT = 0;
const V_GLASS = 1;
const V_TRIM = 2;
const V_TYRE = 3;
const V_INTERIOR = 4;
const V_HEADLIGHT = 5;
const V_TAILLIGHT = 6;
const V_SIREN_A = 7;
const V_SIREN_B = 8;

/* ================================================================== *
 * Geometry
 * ================================================================== */

class VBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  region: number[] = [];
  /** 0 = body, 1 = front-left, 2 = front-right, 3 = rear-left, 4 = rear-right. */
  wheel: number[] = [];
  /** Rotation pivot for wheels, ignored on body vertices. */
  pivot: number[] = [];
  idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  vert(
    x: number,
    y: number,
    z: number,
    u: number,
    v: number,
    region: number,
    wheel = 0,
    px = 0,
    py = 0,
    pz = 0,
  ): number {
    const i = this.count;
    this.pos.push(x, y, z);
    this.nrm.push(0, 0, 0);
    this.uv.push(u, v);
    this.region.push(region);
    this.wheel.push(wheel);
    this.pivot.push(px, py, pz);
    return i;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  finish(): void {
    const p = this.pos;
    const n = this.nrm;
    for (let i = 0; i < this.idx.length; i += 3) {
      const a = this.idx[i] * 3;
      const b = this.idx[i + 1] * 3;
      const c = this.idx[i + 2] * 3;
      const ax = p[b] - p[a];
      const ay = p[b + 1] - p[a + 1];
      const az = p[b + 2] - p[a + 2];
      const bx = p[c] - p[a];
      const by = p[c + 1] - p[a + 1];
      const bz = p[c + 2] - p[a + 2];
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;
      n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
      n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
      n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      n[i] /= l;
      n[i + 1] /= l;
      n[i + 2] /= l;
    }
  }
}

/** Points around one cross-section, from the bottom centre going anticlockwise. */
const SECTION_POINTS = 14;

/**
 * A rounded-rectangle cross-section blended toward an ellipse by `boxiness`.
 * `boxiness` 0 gives a curvy 1960s coupé shoulder, 1 gives a bus.
 */
function sectionPoint(
  t: number,
  halfW: number,
  yLow: number,
  yHigh: number,
  boxiness: number,
  out: { y: number; z: number },
): void {
  const a = t * Math.PI * 2;
  const cy = (yLow + yHigh) * 0.5;
  const ry = (yHigh - yLow) * 0.5;
  const ez = Math.cos(a);
  const ey = Math.sin(a);
  // Superellipse exponent: 2 is a true ellipse, 6 is nearly a rectangle.
  const n = 2 + boxiness * 4.4;
  const inv = 2 / n;
  const bz = Math.sign(ez) * Math.pow(Math.abs(ez), inv);
  const by = Math.sign(ey) * Math.pow(Math.abs(ey), inv);
  out.z = bz * halfW;
  out.y = cy + by * ry;
}

const _sp = { y: 0, z: 0 };

/**
 * Loft the body. Sections are placed along X; each carries its half-width and
 * its lower/upper limits, so the bonnet, the glasshouse and the boot all fall
 * out of one sweep and the surface stays continuous across them.
 */
function loftBody(b: VBuilder, s: VehicleSpec): void {
  const half = s.length * 0.5;
  const sill = s.wheelRadius * 0.55;
  // Longitudinal stations, front to back. Fractions of the half-length.
  const stations: number[] = [1.0, 0.86, 0.66, 0.42, 0.12, -0.2, -0.5, -0.75, -0.92, -1.0];
  const rings: number[] = [];

  for (let i = 0; i < stations.length; i++) {
    const f = stations[i];
    const x = f * half;
    // Plan taper: full width through the middle, drawn in at the extremities.
    const taperT = Math.min(1, (1 - Math.abs(f)) * 5.5);
    const plan = 0.62 + 0.38 * Math.pow(taperT, 0.6);
    const halfW = s.width * 0.5 * plan;

    // Height profile: bonnet low at the nose, roof through the cabin, boot at
    // the tail. `mix` toward the roof only where the cabin actually is.
    const inCabin =
      x <= s.cabinFront + 0.3 && x >= s.cabinRear - 0.3
        ? 1
        : Math.max(
            0,
            1 - Math.min(Math.abs(x - s.cabinFront), Math.abs(x - s.cabinRear)) / 0.85,
          );
    const bonnet = s.beltline - 0.06;
    const yHigh = bonnet + (s.roof - bonnet) * smooth01(inCabin);
    const yLow = sill + (f > 0.92 || f < -0.92 ? 0.06 : 0);

    const start = b.count;
    for (let k = 0; k < SECTION_POINTS; k++) {
      const t = k / SECTION_POINTS;
      sectionPoint(t, halfW, yLow, yHigh, s.boxiness, _sp);
      // Region: the window band is the upper part of the section, inside the
      // cabin. Everything below the belt is paint; the very bottom is trim.
      let region = V_PAINT;
      if (_sp.y > s.beltline && inCabin > 0.55 && yHigh > s.beltline + 0.12) region = V_GLASS;
      else if (_sp.y < sill + 0.14) region = V_TRIM;
      b.vert(x, _sp.y, _sp.z, t, (i / (stations.length - 1)) as number, region);
    }
    rings.push(start);
  }

  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i];
    const c = rings[i + 1];
    for (let k = 0; k < SECTION_POINTS; k++) {
      const k2 = (k + 1) % SECTION_POINTS;
      b.quad(a + k, a + k2, c + k2, c + k);
    }
  }
  // Caps at nose and tail.
  capRing(b, rings[0], stations[0] * half, V_PAINT, true);
  capRing(b, rings[rings.length - 1], stations[stations.length - 1] * half, V_PAINT, false);
}

function smooth01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

function capRing(b: VBuilder, start: number, x: number, region: number, front: boolean): void {
  let cy = 0;
  let cz = 0;
  for (let k = 0; k < SECTION_POINTS; k++) {
    cy += b.pos[(start + k) * 3 + 1];
    cz += b.pos[(start + k) * 3 + 2];
  }
  cy /= SECTION_POINTS;
  cz /= SECTION_POINTS;
  const c = b.vert(x, cy, cz, 0.5, 0.5, region);
  for (let k = 0; k < SECTION_POINTS; k++) {
    const k2 = (k + 1) % SECTION_POINTS;
    if (front) b.tri(c, start + k2, start + k);
    else b.tri(c, start + k, start + k2);
  }
}

function vbox(
  b: VBuilder,
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  region: number,
): void {
  const s = b.count;
  const hx = sx * 0.5;
  const hy = sy * 0.5;
  const hz = sz * 0.5;
  const c: [number, number, number][] = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz],
    [-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  for (let i = 0; i < 8; i++) {
    b.vert(cx + c[i][0], cy + c[i][1], cz + c[i][2], i & 1, (i >> 2) & 1, region);
  }
  b.quad(s + 0, s + 3, s + 2, s + 1);
  b.quad(s + 4, s + 5, s + 6, s + 7);
  b.quad(s + 0, s + 1, s + 5, s + 4);
  b.quad(s + 1, s + 2, s + 6, s + 5);
  b.quad(s + 2, s + 3, s + 7, s + 6);
  b.quad(s + 3, s + 0, s + 4, s + 7);
}

/** A wheel: tyre torus-ish cylinder plus a lighter hub face, spun in-shader. */
function wheel(b: VBuilder, cx: number, cz: number, s: VehicleSpec, id: number, sides = 11): void {
  const r = s.wheelRadius;
  const w = s.wheelWidth;
  const cy = r;
  const inner = cz > 0 ? cz - w * 0.5 : cz + w * 0.5;
  const outer = cz > 0 ? cz + w * 0.5 : cz - w * 0.5;
  const ringA: number[] = [];
  const ringB: number[] = [];
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * Math.PI * 2;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    ringA.push(b.vert(px, py, inner, k / sides, 0, V_TYRE, id, cx, cy, cz));
    ringB.push(b.vert(px, py, outer, k / sides, 1, V_TYRE, id, cx, cy, cz));
  }
  for (let k = 0; k < sides; k++) {
    const k2 = (k + 1) % sides;
    b.quad(ringA[k], ringA[k2], ringB[k2], ringB[k]);
  }
  // Outer face: a hub disc in trim so the wheel reads as a wheel, not a puck.
  const hubR = r * 0.58;
  const hubRing: number[] = [];
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * Math.PI * 2;
    hubRing.push(
      b.vert(cx + Math.cos(a) * hubR, cy + Math.sin(a) * hubR, outer, 0.5, 0.5, V_TRIM, id, cx, cy, cz),
    );
  }
  const hubC = b.vert(cx, cy, outer, 0.5, 0.5, V_TRIM, id, cx, cy, cz);
  for (let k = 0; k < sides; k++) {
    const k2 = (k + 1) % sides;
    b.quad(ringB[k], ringB[k2], hubRing[k2], hubRing[k]);
    if (cz > 0) b.tri(hubC, hubRing[k], hubRing[k2]);
    else b.tri(hubC, hubRing[k2], hubRing[k]);
  }
}

/** Build the geometry for one vehicle kind. */
export function buildVehicleGeometry(s: VehicleSpec): THREE.BufferGeometry {
  const b = new VBuilder();
  loftBody(b, s);

  const half = s.length * 0.5;
  const hw = s.width * 0.5;

  // Bumpers — a dark band front and back that grounds the body.
  vbox(b, half - 0.12, s.wheelRadius * 0.85, 0, 0.22, 0.24, s.width * 0.9, V_TRIM);
  vbox(b, -half + 0.12, s.wheelRadius * 0.85, 0, 0.22, 0.24, s.width * 0.9, V_TRIM);

  // Lamps.
  const lampY = s.wheelRadius + 0.28;
  vbox(b, half - 0.04, lampY, hw * 0.62, 0.1, 0.16, 0.3, V_HEADLIGHT);
  vbox(b, half - 0.04, lampY, -hw * 0.62, 0.1, 0.16, 0.3, V_HEADLIGHT);
  vbox(b, -half + 0.04, lampY + 0.06, hw * 0.66, 0.09, 0.16, 0.26, V_TAILLIGHT);
  vbox(b, -half + 0.04, lampY + 0.06, -hw * 0.66, 0.09, 0.16, 0.26, V_TAILLIGHT);

  // Wing mirrors — tiny, and the silhouette misses them badly when absent.
  if (s.kind !== "cablecar") {
    vbox(b, s.cabinFront + 0.05, s.beltline + 0.06, hw + 0.09, 0.1, 0.09, 0.16, V_TRIM);
    vbox(b, s.cabinFront + 0.05, s.beltline + 0.06, -(hw + 0.09), 0.1, 0.09, 0.16, V_TRIM);
  }

  // Light bar.
  if (s.lightbar) {
    vbox(b, s.cabinFront - 0.55, s.roof + 0.07, 0, 0.3, 0.13, s.width * 0.78, V_TRIM);
    vbox(b, s.cabinFront - 0.55, s.roof + 0.09, s.width * 0.2, 0.26, 0.11, s.width * 0.3, V_SIREN_A);
    vbox(b, s.cabinFront - 0.55, s.roof + 0.09, -s.width * 0.2, 0.26, 0.11, s.width * 0.3, V_SIREN_B);
  }

  // Roof furniture that gives each silhouette its own read.
  if (s.kind === "taxi") {
    vbox(b, s.cabinFront - 0.35, s.roof + 0.09, 0, 0.4, 0.18, 0.6, V_HEADLIGHT);
  }
  if (s.kind === "ambulance" || s.kind === "firetruck") {
    vbox(b, -half * 0.2, s.roof + 0.12, 0, s.length * 0.4, 0.16, s.width * 0.5, V_TRIM);
  }
  if (s.kind === "cablecar") {
    // Running boards and the grip pillar — the two things that say "cable car".
    vbox(b, 0, s.wheelRadius + 0.1, hw + 0.12, s.length * 0.86, 0.1, 0.34, V_TRIM);
    vbox(b, 0, s.wheelRadius + 0.1, -(hw + 0.12), s.length * 0.86, 0.1, 0.34, V_TRIM);
    vbox(b, half * 0.45, s.beltline + 0.5, 0, 0.12, 1.1, 0.12, V_TRIM);
  }
  if (s.kind === "pickup") {
    // Bed walls, so it does not read as a very long saloon.
    vbox(b, -half * 0.45, s.beltline + 0.05, hw - 0.08, s.length * 0.42, 0.5, 0.14, V_PAINT);
    vbox(b, -half * 0.45, s.beltline + 0.05, -(hw - 0.08), s.length * 0.42, 0.5, 0.14, V_PAINT);
    vbox(b, -half + 0.16, s.beltline + 0.05, 0, 0.14, 0.5, s.width - 0.16, V_PAINT);
  }
  if (s.kind === "apc") {
    // Turret ring + a stub cupola.
    vbox(b, -0.2, s.roof + 0.2, 0, 1.3, 0.4, 1.3, V_PAINT);
    vbox(b, 0.5, s.roof + 0.28, 0, 1.5, 0.12, 0.14, V_TRIM);
  }

  // Interior: a dark slab behind the glass so windows do not look into space.
  vbox(
    b,
    (s.cabinFront + s.cabinRear) * 0.5,
    s.beltline - 0.12,
    0,
    Math.max(0.4, s.cabinFront - s.cabinRear),
    0.36,
    s.width * 0.82,
    V_INTERIOR,
  );

  // Wheels.
  const track = s.width * 0.5 - s.wheelWidth * 0.55;
  wheel(b, s.frontAxle, track, s, 1);
  wheel(b, s.frontAxle, -track, s, 2);
  wheel(b, s.rearAxle, track, s, 3);
  wheel(b, s.rearAxle, -track, s, 4);
  // Long vehicles get a second rear axle, which is what makes a bus a bus.
  if (s.length > 8) {
    wheel(b, s.rearAxle - 1.35, track, s, 3);
    wheel(b, s.rearAxle - 1.35, -track, s, 4);
  }

  b.finish();

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(b.nrm, 3));
  g.setAttribute("aUv", new THREE.Float32BufferAttribute(b.uv, 2));
  g.setAttribute("aRegion", new THREE.Float32BufferAttribute(b.region, 1));
  g.setAttribute("aWheel", new THREE.Float32BufferAttribute(b.wheel, 1));
  g.setAttribute("aPivot", new THREE.Float32BufferAttribute(b.pivot, 3));
  g.setIndex(b.idx);
  return g;
}

/* ------------------------------------------------------------------ *
 * The police helicopter
 * ------------------------------------------------------------------ *
 * Not a road vehicle, so it lives outside `VEHICLE_SPECS` and gets its own
 * batch — but it shares the material, the shader and the whole region scheme,
 * with two extra rotation slots for the main and tail rotors.
 */
export function buildHelicopterGeometry(): THREE.BufferGeometry {
  const b = new VBuilder();

  // Fuselage: a fat teardrop, nose forward (+X), lofted like a car body.
  const stations: [number, number, number, number][] = [
    // x, halfWidth, yLow, yHigh
    [3.1, 0.24, 1.05, 1.5],
    [2.5, 0.66, 0.72, 1.72],
    [1.5, 0.92, 0.55, 1.98],
    [0.2, 0.98, 0.5, 2.1],
    [-1.1, 0.86, 0.62, 2.02],
    [-2.2, 0.5, 0.95, 1.8],
    [-3.0, 0.26, 1.15, 1.6],
  ];
  const rings: number[] = [];
  for (let i = 0; i < stations.length; i++) {
    const [x, hw, lo, hiY] = stations[i];
    const start = b.count;
    for (let k = 0; k < SECTION_POINTS; k++) {
      const t = k / SECTION_POINTS;
      sectionPoint(t, hw, lo, hiY, 0.25, _sp);
      // The whole nose is glass — it is a police helicopter, you look down.
      const region = x > 1.2 && _sp.y > 0.9 ? V_GLASS : V_PAINT;
      b.vert(x, _sp.y, _sp.z, t, i / (stations.length - 1), region);
    }
    rings.push(start);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < SECTION_POINTS; k++) {
      const k2 = (k + 1) % SECTION_POINTS;
      b.quad(rings[i] + k, rings[i] + k2, rings[i + 1] + k2, rings[i + 1] + k);
    }
  }
  capRing(b, rings[0], stations[0][0], V_GLASS, true);
  capRing(b, rings[rings.length - 1], stations[stations.length - 1][0], V_PAINT, false);

  // Tail boom and fin.
  vbox(b, -4.6, 1.55, 0, 3.4, 0.34, 0.3, V_PAINT);
  vbox(b, -6.1, 2.0, 0, 0.5, 1.1, 0.12, V_PAINT);
  vbox(b, -6.1, 2.55, 0, 1.4, 0.16, 0.1, V_PAINT);

  // Skids.
  for (const sgn of [1, -1] as const) {
    vbox(b, 0.1, 0.06, sgn * 1.05, 3.6, 0.12, 0.12, V_TRIM);
    vbox(b, 1.2, 0.42, sgn * 0.75, 0.12, 0.75, 0.5, V_TRIM);
    vbox(b, -0.9, 0.42, sgn * 0.75, 0.12, 0.75, 0.5, V_TRIM);
  }

  // Rotor mast + main rotor: four blades on slot 5, spun about Y in-shader.
  vbox(b, -0.2, 2.32, 0, 0.4, 0.5, 0.4, V_TRIM);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const bx = -0.2 + Math.cos(a) * 3.1;
    const bz = Math.sin(a) * 3.1;
    const s = b.count;
    // A blade is a thin plank; four of them at 300 rpm is a disc.
    const hw = 0.16;
    const len = 3.1;
    const dxu = Math.cos(a);
    const dzu = Math.sin(a);
    const nxu = -dzu;
    const nzu = dxu;
    const cx = -0.2 + dxu * len * 0.5;
    const cz = dzu * len * 0.5;
    const pts: [number, number, number][] = [
      [cx - dxu * len * 0.5 - nxu * hw, 2.6, cz - dzu * len * 0.5 - nzu * hw],
      [cx + dxu * len * 0.5 - nxu * hw, 2.6, cz + dzu * len * 0.5 - nzu * hw],
      [cx + dxu * len * 0.5 + nxu * hw, 2.6, cz + dzu * len * 0.5 + nzu * hw],
      [cx - dxu * len * 0.5 + nxu * hw, 2.6, cz - dzu * len * 0.5 + nzu * hw],
    ];
    for (const p of pts) b.vert(p[0], p[1], p[2], 0, 0, V_TRIM, 5, -0.2, 2.6, 0);
    for (const p of pts) b.vert(p[0], p[1] - 0.05, p[2], 1, 1, V_TRIM, 5, -0.2, 2.6, 0);
    b.quad(s + 0, s + 1, s + 2, s + 3);
    b.quad(s + 7, s + 6, s + 5, s + 4);
    b.quad(s + 0, s + 4, s + 5, s + 1);
    b.quad(s + 2, s + 6, s + 7, s + 3);
    void bx;
    void bz;
  }

  // Tail rotor: slot 6, spun about X.
  for (let i = 0; i < 2; i++) {
    const a = (i / 2) * Math.PI;
    const s = b.count;
    const dy = Math.cos(a);
    const dz = Math.sin(a);
    const len = 0.95;
    for (const sgn of [1, -1] as const) {
      b.vert(-6.35, 2.0 + dy * len * 0.5 + -dz * 0.09 * sgn, dz * len * 0.5 + dy * 0.09 * sgn, 0, 0, V_TRIM, 6, -6.35, 2.0, 0);
      b.vert(-6.35, 2.0 - dy * len * 0.5 + -dz * 0.09 * sgn, -dz * len * 0.5 + dy * 0.09 * sgn, 1, 1, V_TRIM, 6, -6.35, 2.0, 0);
    }
    b.quad(s + 0, s + 1, s + 3, s + 2);
    b.quad(s + 2, s + 3, s + 1, s + 0);
  }

  // Searchlight under the nose, and the strobes.
  vbox(b, 2.2, 0.62, 0, 0.4, 0.3, 0.4, V_HEADLIGHT);
  vbox(b, -0.4, 0.42, 0.6, 0.24, 0.14, 0.24, V_SIREN_A);
  vbox(b, -0.4, 0.42, -0.6, 0.24, 0.14, 0.24, V_SIREN_B);
  vbox(b, -0.2, 2.18, 0, 0.24, 0.12, 0.24, V_SIREN_A);

  b.finish();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(b.nrm, 3));
  g.setAttribute("aUv", new THREE.Float32BufferAttribute(b.uv, 2));
  g.setAttribute("aRegion", new THREE.Float32BufferAttribute(b.region, 1));
  g.setAttribute("aWheel", new THREE.Float32BufferAttribute(b.wheel, 1));
  g.setAttribute("aPivot", new THREE.Float32BufferAttribute(b.pivot, 3));
  g.setIndex(b.idx);
  return g;
}

/* ================================================================== *
 * Shader
 * ================================================================== */

const V_HELPERS = /* glsl */ `
attribute float aRegion;
attribute float aWheel;
attribute vec3  aPivot;
attribute vec2  aUv;

attribute vec3 iPos;
attribute vec3 iRot;     // yaw, pitch, roll
attribute vec4 iState;   // wheel spin, steer, brake 0..1, siren phase
attribute vec4 iPaint;   // rgb + damage 0..1
attribute vec2 iLamp;    // headlights 0..1, seed

varying float vRegion;
varying vec3 vPaint;
varying float vDamage;
varying float vSeed;
varying vec2 vSurfUv;
varying float vBrake;
varying float vHead;
varying float vSirenA;
varying float vSirenB;

vec3 vRotY(vec3 p, vec3 piv, float a) {
  vec3 d = p - piv;
  float c = cos(a), s = sin(a);
  return piv + vec3(d.x * c + d.z * s, d.y, -d.x * s + d.z * c);
}
vec3 vRotZ(vec3 p, vec3 piv, float a) {
  vec3 d = p - piv;
  float c = cos(a), s = sin(a);
  return piv + vec3(d.x * c - d.y * s, d.x * s + d.y * c, d.z);
}
vec3 vRotX(vec3 p, vec3 piv, float a) {
  vec3 d = p - piv;
  float c = cos(a), s = sin(a);
  return piv + vec3(d.x, d.y * c - d.z * s, d.y * s + d.z * c);
}
`;

const V_POSE = /* glsl */ `
  vec3 vp = position;
  if (aWheel > 0.5) {
    if (aWheel < 4.5) {
      // Road wheels: steering first (about the kingpin), then roll (about the
      // axle). Slots 1–2 are the front pair and are the only ones that steer.
      if (aWheel < 2.5) vp = vRotY(vp, aPivot, iState.y);
      vp = vRotZ(vp, aPivot, iState.x);
    } else if (aWheel < 5.5) {
      vp = vRotY(vp, aPivot, iState.x * 5.0);      // main rotor
    } else {
      vp = vRotX(vp, aPivot, iState.x * 8.0);      // tail rotor
    }
  }
  // Body attitude: pitch and roll about the contact patch height, then yaw.
  vp = vRotZ(vp, vec3(0.0), iRot.y);
  vp = vRotX(vp, vec3(0.0), iRot.z);
  float vcy = cos(iRot.x);
  float vsy = sin(iRot.x);
  vec3 vWorld = vec3(vp.x * vcy - vp.z * vsy, vp.y, vp.x * vsy + vp.z * vcy);
  vWorld += iPos;
`;

const V_NORMAL = /* glsl */ `
  vec3 vn = objectNormal;
  if (aWheel > 0.5) {
    if (aWheel < 4.5) {
      if (aWheel < 2.5) vn = vRotY(vn, vec3(0.0), iState.y);
      vn = vRotZ(vn, vec3(0.0), iState.x);
    } else if (aWheel < 5.5) {
      vn = vRotY(vn, vec3(0.0), iState.x * 5.0);
    } else {
      vn = vRotX(vn, vec3(0.0), iState.x * 8.0);
    }
  }
  vn = vRotZ(vn, vec3(0.0), iRot.y);
  vn = vRotX(vn, vec3(0.0), iRot.z);
  objectNormal = vec3(vn.x * vcy - vn.z * vsy, vn.y, vn.x * vsy + vn.z * vcy);
`;

const V_VARY = /* glsl */ `
  vRegion = aRegion;
  vPaint = iPaint.rgb;
  vDamage = iPaint.a;
  vSeed = iLamp.y;
  vSurfUv = aUv;
  vBrake = iState.z;
  vHead = iLamp.x;
  // Two-tone alternating flash, 2.6 Hz, offset per instance so a convoy is not
  // a chorus line.
  float sp = iState.w;
  vSirenA = step(0.5, fract(sp));
  vSirenB = 1.0 - vSirenA;
  vSirenA *= step(0.001, sp);
  vSirenB *= step(0.001, sp);
`;

const V_FRAG_HEAD = /* glsl */ `
varying float vRegion;
varying vec3 vPaint;
varying float vDamage;
varying float vSeed;
varying vec2 vSurfUv;
varying float vBrake;
varying float vHead;
varying float vSirenA;
varying float vSirenB;

float vHash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vNoise2(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(vHash2(i), vHash2(i + vec2(1.0, 0.0)), f.x),
             mix(vHash2(i + vec2(0.0, 1.0)), vHash2(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

const V_FRAG_BODY = /* glsl */ `
  {
    float reg = vRegion;
    vec3 tint = vPaint;
    float rough = 0.32;
    float metal = 0.75;
    vec3 emis = vec3(0.0);

    float dirt = vNoise2(vSurfUv * 12.0 + vSeed * 9.0);
    float flake = vNoise2(vSurfUv * 180.0 + vSeed);

    if (reg < 0.5) {
      // Paint: metallic flake, clearcoat-ish roughness, road film low down.
      tint *= 0.94 + flake * 0.1;
      tint *= 1.0 - dirt * 0.1;
      rough = 0.24 + dirt * 0.12;
      metal = 0.72;
    } else if (reg < 1.5) {
      // Glass: dark, smooth, slightly green, and never fully opaque-looking.
      tint = vec3(0.045, 0.055, 0.06) * (0.7 + dirt * 0.5);
      rough = 0.06;
      metal = 0.1;
    } else if (reg < 2.5) {
      tint = mix(vec3(0.07, 0.075, 0.08), vPaint * 0.4, 0.25) * (0.8 + dirt * 0.5);
      rough = 0.42 + dirt * 0.2;
      metal = 0.55;
    } else if (reg < 3.5) {
      // Tyre: matte carbon black with sidewall dust.
      tint = vec3(0.028, 0.028, 0.03) * (1.0 + dirt * 0.8);
      rough = 0.92;
      metal = 0.0;
    } else if (reg < 4.5) {
      tint = vec3(0.035, 0.036, 0.04);
      rough = 0.8;
      metal = 0.0;
    } else if (reg < 5.5) {
      // Headlamp: glass lens, emissive only when lit.
      tint = vec3(0.55, 0.56, 0.6);
      rough = 0.08;
      metal = 0.2;
      emis = vec3(1.0, 0.96, 0.86) * vHead * 2.4;
    } else if (reg < 6.5) {
      tint = vec3(0.32, 0.03, 0.025);
      rough = 0.14;
      metal = 0.1;
      emis = vec3(1.0, 0.08, 0.04) * (0.35 + vBrake * 2.2) * max(vHead, vBrake);
    } else if (reg < 7.5) {
      tint = vec3(0.3, 0.02, 0.02);
      rough = 0.12;
      emis = vec3(1.0, 0.05, 0.03) * vSirenA * 6.0;
    } else {
      tint = vec3(0.02, 0.06, 0.3);
      rough = 0.12;
      emis = vec3(0.06, 0.25, 1.0) * vSirenB * 6.0;
    }

    // Collision damage: crumples read as darkened, roughened, desaturated paint.
    float crum = vNoise2(vSurfUv * 7.0 + vSeed * 3.0);
    float dmg = vDamage * smoothstep(0.35, 0.9, crum);
    tint = mix(tint, tint * 0.35 + vec3(0.05, 0.04, 0.035), dmg);
    rough = mix(rough, 0.85, dmg);

    diffuseColor.rgb *= tint;
    roughnessFactor = rough;
    metalnessFactor = metal;
    totalEmissiveRadiance += emis;
  }
`;

function injectVehicleVertex(shader: { vertexShader: string; fragmentShader: string }): void {
  shader.vertexShader = V_HELPERS + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace(
    "#include <beginnormal_vertex>",
    `#include <beginnormal_vertex>\n${V_POSE}\n${V_NORMAL}`,
  );
  shader.vertexShader = shader.vertexShader.replace(
    "#include <begin_vertex>",
    `vec3 transformed = vWorld;\n${V_VARY}`,
  );
}

export function makeVehicleMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.3,
    metalness: 0.7,
    emissive: 0x000000,
    dithering: true,
  });
  m.customProgramCacheKey = () => "sf-vehicle-v1";
  m.onBeforeCompile = (shader) => {
    injectVehicleVertex(shader);
    shader.fragmentShader = V_FRAG_HEAD + shader.fragmentShader;
    // `totalEmissiveRadiance` exists from the emissivemap chunk onward, and
    // both factors are declared by then.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>\n${V_FRAG_BODY}`,
    );
  };
  return m;
}

/**
 * Depth material for the shadow pass. As with the crowd, the pose goes at
 * `begin_vertex` rather than `beginnormal_vertex`, because in `depth_vert` the
 * latter lives inside an `#ifdef USE_DISPLACEMENTMAP` that is never defined.
 */
export function makeVehicleDepthMaterial(): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.customProgramCacheKey = () => "sf-vehicle-depth-v1";
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = V_HELPERS + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `${V_POSE}\n  vec3 transformed = vWorld;\n${V_VARY}`,
    );
  };
  return m;
}

/* ================================================================== *
 * The batch
 * ================================================================== */

interface KindBuffers {
  pos: Float32Array;
  rot: Float32Array;
  state: Float32Array;
  paint: Float32Array;
  lamp: Float32Array;
  geometry: THREE.InstancedBufferGeometry;
  mesh: THREE.Mesh;
  count: number;
}

/**
 * One instanced mesh per vehicle kind, all sharing a material. Thirteen draw
 * calls for every car, bus, cable car and armoured personnel carrier in San
 * Francisco, which is cheaper than a single unbatched hero vehicle.
 */
export class VehicleBatch {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  readonly depthMaterial: THREE.MeshDepthMaterial;
  private kinds = new Map<TrafficVehicleKind, KindBuffers>();

  constructor(perKindMax: Partial<Record<TrafficVehicleKind, number>> = {}, defaultMax = 48) {
    this.material = makeVehicleMaterial();
    this.depthMaterial = makeVehicleDepthMaterial();
    this.group.name = "sf-traffic";
    for (const kind of TRAFFIC_KINDS) {
      const max = perKindMax[kind] ?? defaultMax;
      const kb = this.makeKind(kind, max);
      this.kinds.set(kind, kb);
      this.group.add(kb.mesh);
    }
  }

  private makeKind(kind: TrafficVehicleKind, max: number): KindBuffers {
    const src = buildVehicleGeometry(VEHICLE_SPECS[kind]);
    const g = new THREE.InstancedBufferGeometry();
    g.index = src.index;
    for (const key of ["position", "normal", "aUv", "aRegion", "aWheel", "aPivot"]) {
      const a = src.getAttribute(key);
      if (a) g.setAttribute(key, a);
    }
    const b: KindBuffers = {
      pos: new Float32Array(max * 3),
      rot: new Float32Array(max * 3),
      state: new Float32Array(max * 4),
      paint: new Float32Array(max * 4),
      lamp: new Float32Array(max * 2),
      geometry: g,
      mesh: null as unknown as THREE.Mesh,
      count: 0,
    };
    g.setAttribute("iPos", new THREE.InstancedBufferAttribute(b.pos, 3));
    g.setAttribute("iRot", new THREE.InstancedBufferAttribute(b.rot, 3));
    g.setAttribute("iState", new THREE.InstancedBufferAttribute(b.state, 4));
    g.setAttribute("iPaint", new THREE.InstancedBufferAttribute(b.paint, 4));
    g.setAttribute("iLamp", new THREE.InstancedBufferAttribute(b.lamp, 2));
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    g.boundingBox = new THREE.Box3(
      new THREE.Vector3(-1e5, -1e4, -1e5),
      new THREE.Vector3(1e5, 1e4, 1e5),
    );
    const mesh = new THREE.Mesh(g, this.material);
    mesh.name = `sf-traffic-${kind}`;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = this.depthMaterial;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    b.mesh = mesh;
    // Not disposed on purpose — the instanced geometry now owns these buffers.
    return b;
  }

  begin(): void {
    this.kinds.forEach((b) => {
      b.count = 0;
    });
  }

  push(
    kind: TrafficVehicleKind,
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    roll: number,
    wheelSpin: number,
    steer: number,
    brake: number,
    sirenPhase: number,
    r: number,
    g: number,
    bcol: number,
    damage: number,
    headlights: number,
    seed: number,
  ): boolean {
    const b = this.kinds.get(kind);
    if (!b) return false;
    const i = b.count;
    if ((i + 1) * 3 > b.pos.length) return false;
    b.count++;
    const p3 = i * 3;
    const p4 = i * 4;
    const p2 = i * 2;
    b.pos[p3] = x;
    b.pos[p3 + 1] = y;
    b.pos[p3 + 2] = z;
    b.rot[p3] = yaw;
    b.rot[p3 + 1] = pitch;
    b.rot[p3 + 2] = roll;
    b.state[p4] = wheelSpin;
    b.state[p4 + 1] = steer;
    b.state[p4 + 2] = brake;
    b.state[p4 + 3] = sirenPhase;
    b.paint[p4] = r;
    b.paint[p4 + 1] = g;
    b.paint[p4 + 2] = bcol;
    b.paint[p4 + 3] = damage;
    b.lamp[p2] = headlights;
    b.lamp[p2 + 1] = seed;
    return true;
  }

  commit(): void {
    this.kinds.forEach((b) => {
      b.geometry.instanceCount = b.count;
      if (b.count === 0) return;
      const attrs = b.geometry.attributes as Record<string, THREE.InstancedBufferAttribute>;
      for (const key of ["iPos", "iRot", "iState", "iPaint", "iLamp"]) {
        const a = attrs[key];
        if (!a) continue;
        a.clearUpdateRanges();
        a.addUpdateRange(0, b.count * a.itemSize);
        a.needsUpdate = true;
      }
    });
  }

  dispose(): void {
    this.kinds.forEach((b) => b.geometry.dispose());
    this.kinds.clear();
    this.material.dispose();
    this.depthMaterial.dispose();
    this.group.clear();
  }
}

/**
 * A tiny instanced batch for the police helicopter, sharing the traffic
 * material so the whole air wing is one extra draw call.
 */
export class HelicopterBatch {
  readonly mesh: THREE.Mesh;
  private geometry: THREE.InstancedBufferGeometry;
  private pos: Float32Array;
  private rot: Float32Array;
  private state: Float32Array;
  private paint: Float32Array;
  private lamp: Float32Array;
  private n = 0;

  constructor(max: number, material: THREE.Material, depthMaterial: THREE.Material) {
    const src = buildHelicopterGeometry();
    const g = new THREE.InstancedBufferGeometry();
    g.index = src.index;
    for (const key of ["position", "normal", "aUv", "aRegion", "aWheel", "aPivot"]) {
      const a = src.getAttribute(key);
      if (a) g.setAttribute(key, a);
    }
    this.pos = new Float32Array(max * 3);
    this.rot = new Float32Array(max * 3);
    this.state = new Float32Array(max * 4);
    this.paint = new Float32Array(max * 4);
    this.lamp = new Float32Array(max * 2);
    g.setAttribute("iPos", new THREE.InstancedBufferAttribute(this.pos, 3));
    g.setAttribute("iRot", new THREE.InstancedBufferAttribute(this.rot, 3));
    g.setAttribute("iState", new THREE.InstancedBufferAttribute(this.state, 4));
    g.setAttribute("iPaint", new THREE.InstancedBufferAttribute(this.paint, 4));
    g.setAttribute("iLamp", new THREE.InstancedBufferAttribute(this.lamp, 2));
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.geometry = g;
    const mesh = new THREE.Mesh(g, material);
    mesh.name = "sf-helicopters";
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.customDepthMaterial = depthMaterial;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.mesh = mesh;
  }

  begin(): void {
    this.n = 0;
  }

  push(
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    roll: number,
    rotor: number,
    siren: number,
    light: number,
  ): void {
    const i = this.n;
    if ((i + 1) * 3 > this.pos.length) return;
    this.n++;
    const p3 = i * 3;
    const p4 = i * 4;
    const p2 = i * 2;
    this.pos[p3] = x;
    this.pos[p3 + 1] = y;
    this.pos[p3 + 2] = z;
    this.rot[p3] = yaw;
    this.rot[p3 + 1] = pitch;
    this.rot[p3 + 2] = roll;
    this.state[p4] = rotor;
    this.state[p4 + 1] = 0;
    this.state[p4 + 2] = 0;
    this.state[p4 + 3] = siren;
    this.paint[p4] = 0.02;
    this.paint[p4 + 1] = 0.03;
    this.paint[p4 + 2] = 0.05;
    this.paint[p4 + 3] = 0;
    this.lamp[p2] = light;
    this.lamp[p2 + 1] = 0.4;
  }

  commit(): void {
    this.geometry.instanceCount = this.n;
    if (this.n === 0) return;
    const attrs = this.geometry.attributes as Record<string, THREE.InstancedBufferAttribute>;
    for (const key of ["iPos", "iRot", "iState", "iPaint", "iLamp"]) {
      const a = attrs[key];
      if (!a) continue;
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * a.itemSize);
      a.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
  }
}
