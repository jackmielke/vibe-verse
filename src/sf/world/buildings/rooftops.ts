/**
 * rooftops.ts — the fifth elevation.
 *
 * In a grapple game the player spends half their life on roofs, so a roof that
 * is a flat grey rectangle is half the level design missing. Every walkable
 * deck gets dressed: packaged HVAC on curbs, ducting between them, a stair
 * bulkhead, mushroom vents, the redwood water tank that sits on top of half
 * the brick buildings in this city, antenna masts, dishes, skylights, planters
 * and — on the towers — a real helipad.
 *
 * It is also load-bearing for gameplay. Every prop taller than a metre is a
 * grapple anchor and a piece of cover; the placer keeps them off the parapet
 * edge so there is always a run-up, and it leaves a clear lane across the roof
 * so you can sprint it without vaulting six air handlers.
 *
 * Public API
 * ----------
 *   dressRoofs(rec, sink, lod, originX, originZ)  decorate every walkable roof
 *   ROOF_PROP_ANCHOR_MIN_HEIGHT
 */
import { makeRng, type Rng } from "../../math/rng";
import { GeoSink, SURF } from "./geoSink";
import type { BuildingRecord, RoofSurface } from "./generator";

/** Props at least this tall are registered as grapple anchors. */
export const ROOF_PROP_ANCHOR_MIN_HEIGHT = 1.1;

/* ------------------------------------------------------------------ *
 * Occupancy — keeps props from growing through each other
 * ------------------------------------------------------------------ */

const OCC_CELL = 1.5;
const OCC_MAX = 96;
const _occ = new Uint8Array(OCC_MAX * OCC_MAX);

interface Placer {
  hw: number;
  hd: number;
  nx: number;
  nz: number;
  /** Keep-out from the parapet so there is always a walkable perimeter. */
  margin: number;
}

function beginPlacer(hw: number, hd: number, margin: number): Placer {
  const nx = Math.min(OCC_MAX, Math.max(1, Math.ceil((hw * 2) / OCC_CELL)));
  const nz = Math.min(OCC_MAX, Math.max(1, Math.ceil((hd * 2) / OCC_CELL)));
  _occ.fill(0, 0, nx * nz);
  return { hw, hd, nx, nz, margin };
}

function occFree(p: Placer, lx: number, lz: number, rx: number, rz: number): boolean {
  if (Math.abs(lx) + rx > p.hw - p.margin) return false;
  if (Math.abs(lz) + rz > p.hd - p.margin) return false;
  const i0 = Math.max(0, Math.floor(((lx - rx + p.hw) / (p.hw * 2)) * p.nx));
  const i1 = Math.min(p.nx - 1, Math.floor(((lx + rx + p.hw) / (p.hw * 2)) * p.nx));
  const j0 = Math.max(0, Math.floor(((lz - rz + p.hd) / (p.hd * 2)) * p.nz));
  const j1 = Math.min(p.nz - 1, Math.floor(((lz + rz + p.hd) / (p.hd * 2)) * p.nz));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) if (_occ[j * p.nx + i]) return false;
  }
  return true;
}

function occMark(p: Placer, lx: number, lz: number, rx: number, rz: number): void {
  const i0 = Math.max(0, Math.floor(((lx - rx + p.hw) / (p.hw * 2)) * p.nx));
  const i1 = Math.min(p.nx - 1, Math.floor(((lx + rx + p.hw) / (p.hw * 2)) * p.nx));
  const j0 = Math.max(0, Math.floor(((lz - rz + p.hd) / (p.hd * 2)) * p.nz));
  const j1 = Math.min(p.nz - 1, Math.floor(((lz + rz + p.hd) / (p.hd * 2)) * p.nz));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) _occ[j * p.nx + i] = 1;
  }
}

/** Find a free spot with a bounded number of stochastic tries. */
function findSpot(
  p: Placer,
  rng: Rng,
  rx: number,
  rz: number,
  out: { x: number; z: number },
): boolean {
  for (let t = 0; t < 12; t++) {
    const lx = rng.range(-p.hw + p.margin + rx, p.hw - p.margin - rx);
    const lz = rng.range(-p.hd + p.margin + rz, p.hd - p.margin - rz);
    if (occFree(p, lx, lz, rx + 0.35, rz + 0.35)) {
      occMark(p, lx, lz, rx + 0.35, rz + 0.35);
      out.x = lx;
      out.z = lz;
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Local frame for a roof
 * ------------------------------------------------------------------ */

interface RoofCtx {
  s: GeoSink;
  rng: Rng;
  lod: number;
  /** Roof centre in chunk-local space. */
  ox: number;
  oz: number;
  cy: number;
  yaw: number;
  cos: number;
  sin: number;
  /** vBase for the UV channel — roofs use their own deck as v = 0. */
  vBase: number;
  anchors: number[];
  originX: number;
  originZ: number;
}

const _spot = { x: 0, z: 0 };

function rx(c: RoofCtx, lx: number, lz: number): number {
  return c.ox + lx * c.cos - lz * c.sin;
}
function rz(c: RoofCtx, lx: number, lz: number): number {
  return c.oz + lx * c.sin + lz * c.cos;
}
function rAnchor(c: RoofCtx, lx: number, y: number, lz: number): void {
  c.anchors.push(rx(c, lx, lz) + c.originX, y, rz(c, lx, lz) + c.originZ);
}

/* ------------------------------------------------------------------ *
 * Individual props
 * ------------------------------------------------------------------ */

/** Packaged rooftop air handler on a raised curb, with a fan cowl. */
function hvacUnit(c: RoofCtx, lx: number, lz: number, w: number, d: number, h: number): void {
  const s = c.s;
  s.setSurface(SURF.CONCRETE, 3.4, 0.5, 0).setColor(0.14, 0.14, 0.145);
  s.box(rx(c, lx, lz), c.cy + 0.11, rz(c, lx, lz), w * 0.5 + 0.12, 0.11, d * 0.5 + 0.12, c.yaw, c.vBase, 0b011111);
  s.setSurface(SURF.METAL, 3.4, 0.5, 0).setColor(0.52, 0.53, 0.53);
  s.box(rx(c, lx, lz), c.cy + 0.22 + h * 0.5, rz(c, lx, lz), w * 0.5, h * 0.5, d * 0.5, c.yaw, c.vBase, 0b111111);
  // Fan cowls on top — the detail that says "this is machinery, not a crate".
  const fans = Math.max(1, Math.round(w / 1.5));
  s.setSurface(SURF.METAL, 3.4, 0.5, 0).setColor(0.34, 0.345, 0.35);
  for (let i = 0; i < fans; i++) {
    const fx = lx - w * 0.5 + ((i + 0.5) * w) / fans;
    s.cylinder(rx(c, fx, lz), c.cy + 0.22 + h, rz(c, fx, lz), Math.min(0.42, d * 0.35), Math.min(0.46, d * 0.38), 0.26, 10, c.vBase, true, false);
  }
  // Condenser grille on the long side.
  s.setSurface(SURF.CORRUGATED, 1.4, 0.5, 0).setColor(0.30, 0.31, 0.31);
  s.box(rx(c, lx, lz - d * 0.5 - 0.03), c.cy + 0.22 + h * 0.5, rz(c, lx, lz - d * 0.5 - 0.03), w * 0.42, h * 0.34, 0.04, c.yaw, c.vBase, 0b011111);
  if (h + 0.22 >= ROOF_PROP_ANCHOR_MIN_HEIGHT) rAnchor(c, lx, c.cy + 0.22 + h, lz);
}

/** Insulated duct run between two units. */
function ductRun(c: RoofCtx, x0: number, z0: number, x1: number, z1: number, h: number): void {
  const s = c.s;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 0.6) return;
  const ang = Math.atan2(dz, dx);
  s.setSurface(SURF.METAL, 3.4, 0.5, 0).setColor(0.60, 0.61, 0.62);
  const mx = (x0 + x1) * 0.5;
  const mz = (z0 + z1) * 0.5;
  s.box(rx(c, mx, mz), c.cy + h, rz(c, mx, mz), len * 0.5, 0.24, 0.24, c.yaw + ang, c.vBase, 0b111111);
  // Legs.
  for (const t of [0.15, 0.85]) {
    const px = x0 + dx * t;
    const pz = z0 + dz * t;
    s.box(rx(c, px, pz), c.cy + h * 0.5, rz(c, px, pz), 0.05, h * 0.5, 0.05, c.yaw, c.vBase, 0b001111);
  }
}

/** Stair bulkhead / elevator penthouse — the way onto the roof. */
function bulkhead(c: RoofCtx, lx: number, lz: number, w: number, d: number, h: number): void {
  const s = c.s;
  s.setSurface(SURF.CONCRETE, 3.0, 0.5, 0).setColor(0.42, 0.41, 0.395);
  s.box(rx(c, lx, lz), c.cy + h * 0.5, rz(c, lx, lz), w * 0.5, h * 0.5, d * 0.5, c.yaw, c.vBase, 0b011111);
  s.setSurface(SURF.ROOF, 3.0, 0.5, 0).setColor(0.07, 0.068, 0.065);
  s.box(rx(c, lx, lz), c.cy + h + 0.06, rz(c, lx, lz), w * 0.5 + 0.10, 0.06, d * 0.5 + 0.10, c.yaw, c.vBase, 0b111111);
  // Steel door.
  s.setSurface(SURF.METAL, 2.2, 0.5, 0).setColor(0.20, 0.22, 0.21);
  s.box(rx(c, lx, lz - d * 0.5 - 0.04), c.cy + 1.05, rz(c, lx, lz - d * 0.5 - 0.04), 0.45, 1.05, 0.05, c.yaw, c.vBase, 0b011111);
  rAnchor(c, lx, c.cy + h + 0.12, lz);
}

/** The redwood water tank on its steel stand. Pure San Francisco skyline. */
function waterTank(c: RoofCtx, lx: number, lz: number, r: number, h: number, legH: number): void {
  const s = c.s;
  s.setSurface(SURF.METAL, 3.4, 0.5, 0).setColor(0.16, 0.155, 0.15);
  const legR = r * 0.78;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const px = lx + Math.cos(a) * legR;
    const pz = lz + Math.sin(a) * legR;
    s.box(rx(c, px, pz), c.cy + legH * 0.5, rz(c, px, pz), 0.09, legH * 0.5, 0.09, c.yaw, c.vBase, 0b001111);
  }
  // Cross bracing at mid height.
  s.box(rx(c, lx, lz), c.cy + legH * 0.55, rz(c, lx, lz), legR, 0.05, 0.05, c.yaw, c.vBase, 0b001111);
  s.box(rx(c, lx, lz), c.cy + legH * 0.55, rz(c, lx, lz), 0.05, 0.05, legR, c.yaw, c.vBase, 0b001111);
  // Staved redwood barrel with steel hoops.
  s.setSurface(SURF.WOOD, 3.4, 0.5, 0).setColor(0.20, 0.115, 0.065);
  s.cylinder(rx(c, lx, lz), c.cy + legH, rz(c, lx, lz), r, r, h, 14, c.vBase, false, true);
  s.setSurface(SURF.METAL, 3.4, 0.5, 0).setColor(0.20, 0.19, 0.18);
  for (const t of [0.18, 0.55, 0.88]) {
    s.cylinder(rx(c, lx, lz), c.cy + legH + h * t, rz(c, lx, lz), r * 1.02, r * 1.02, 0.07, 14, c.vBase, false, false);
  }
  // Conical lid.
  s.setSurface(SURF.ROOF, 3.4, 0.5, 0).setColor(0.10, 0.095, 0.09);
  s.cylinder(rx(c, lx, lz), c.cy + legH + h, rz(c, lx, lz), r * 1.04, 0.05, r * 0.42, 14, c.vBase, true, false);
  rAnchor(c, lx, c.cy + legH + h + r * 0.42, lz);
}

/** Mushroom vent / plumbing stack. */
function vent(c: RoofCtx, lx: number, lz: number, r: number, h: number): void {
  const s = c.s;
  s.setSurface(SURF.METAL, 3.4, 0.5, 0).setColor(0.40, 0.40, 0.41);
  s.cylinder(rx(c, lx, lz), c.cy, rz(c, lx, lz), r, r, h, 8, c.vBase, false, false);
  s.cylinder(rx(c, lx, lz), c.cy + h, rz(c, lx, lz), r * 2.0, r * 1.5, 0.16, 8, c.vBase, true, false);
}

/** Guyed antenna mast with cross arms. */
function antenna(c: RoofCtx, lx: number, lz: number, h: number): void {
  const s = c.s;
  s.setSurface(SURF.METAL, 3.4, 0.5, 0).setColor(0.62, 0.24, 0.20);
  s.cylinder(rx(c, lx, lz), c.cy, rz(c, lx, lz), 0.10, 0.05, h, 6, c.vBase, true, false);
  for (const t of [0.55, 0.78]) {
    s.box(rx(c, lx, lz), c.cy + h * t, rz(c, lx, lz), 0.55, 0.03, 0.03, c.yaw, c.vBase, 0b001111);
    s.box(rx(c, lx, lz), c.cy + h * t, rz(c, lx, lz), 0.03, 0.03, 0.55, c.yaw, c.vBase, 0b001111);
  }
  // Three guy wires down to the deck.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const gx = lx + Math.cos(a) * h * 0.42;
    const gz = lz + Math.sin(a) * h * 0.42;
    const mx = (lx + gx) * 0.5;
    const mz = (lz + gz) * 0.5;
    const run = Math.hypot(gx - lx, gz - lz);
    const rise = h * 0.86;
    const len = Math.hypot(run, rise);
    const ang = Math.atan2(gz - lz, gx - lx);
    // A wire is a hair-thin box tilted in the vertical plane containing it.
    const pitch = Math.atan2(rise, run);
    const hx = Math.cos(pitch) * len * 0.5;
    const hy = Math.sin(pitch) * len * 0.5;
    const ax = rx(c, lx + Math.cos(ang) * (run * 0.5 - hx), lz + Math.sin(ang) * (run * 0.5 - hx));
    const az = rz(c, lx + Math.cos(ang) * (run * 0.5 - hx), lz + Math.sin(ang) * (run * 0.5 - hx));
    const bx = rx(c, lx + Math.cos(ang) * (run * 0.5 + hx), lz + Math.sin(ang) * (run * 0.5 + hx));
    const bz = rz(c, lx + Math.cos(ang) * (run * 0.5 + hx), lz + Math.sin(ang) * (run * 0.5 + hx));
    const y0 = c.cy + h * 0.86 - hy * 2 * 0 + (rise * 0.5 - hy);
    const y1 = y0 + hy * 2;
    s.setSurface(SURF.METAL, 3.4, 0.5, 0).setColor(0.28, 0.28, 0.29);
    s.quad(
      ax, y1, az, 0, 0,
      ax, y1 - 0.03, az, 0, 0.03,
      bx, y0 - 0.03, bz, len, 0.03,
      bx, y0, bz, len, 0,
    );
  }
  rAnchor(c, lx, c.cy + h, lz);
}

/** Satellite dish on a short mast. */
function dish(c: RoofCtx, lx: number, lz: number, r: number): void {
  const s = c.s;
  s.setSurface(SURF.METAL, 3.4, 0.5, 0).setColor(0.34, 0.34, 0.35);
  s.cylinder(rx(c, lx, lz), c.cy, rz(c, lx, lz), 0.08, 0.08, 0.9, 6, c.vBase, true, false);
  s.setSurface(SURF.METAL, 3.4, 0.5, 0).setColor(0.78, 0.78, 0.76);
  // A shallow bowl: a squashed dome is close enough at any range you see it.
  s.dome(rx(c, lx, lz), c.cy + 0.9, rz(c, lx, lz), r, r * 0.38, 12, 3, c.vBase);
}

/** Skylight: a low glazed pyramid over a kerb. */
function skylight(c: RoofCtx, lx: number, lz: number, w: number, d: number): void {
  const s = c.s;
  s.setSurface(SURF.CONCRETE, 3.4, 0.5, 0).setColor(0.36, 0.35, 0.34);
  s.box(rx(c, lx, lz), c.cy + 0.14, rz(c, lx, lz), w * 0.5, 0.14, d * 0.5, c.yaw, c.vBase, 0b011111);
  s.setSurface(SURF.GLASS, 2.0, 0.5, 1).setColor(0.10, 0.13, 0.14);
  const h = Math.min(w, d) * 0.34;
  const px = [-w * 0.5, w * 0.5, w * 0.5, -w * 0.5];
  const pz = [-d * 0.5, -d * 0.5, d * 0.5, d * 0.5];
  const y0 = c.cy + 0.28;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) & 3;
    s.tri(
      rx(c, lx + px[i], lz + pz[i]), y0, rz(c, lx + px[i], lz + pz[i]), 0, 0,
      rx(c, lx, lz), y0 + h, rz(c, lx, lz), w * 0.5, h,
      rx(c, lx + px[j], lz + pz[j]), y0, rz(c, lx + px[j], lz + pz[j]), w, 0,
    );
  }
}

/** Roof-access ladder with a cage, run up a bulkhead or a parapet. */
function ladder(c: RoofCtx, lx: number, lz: number, h: number): void {
  const s = c.s;
  s.setSurface(SURF.METAL, 3.4, 0.5, 0).setColor(0.44, 0.44, 0.45);
  for (const sgn of [-1, 1]) {
    s.box(rx(c, lx + sgn * 0.22, lz), c.cy + h * 0.5, rz(c, lx + sgn * 0.22, lz), 0.035, h * 0.5, 0.035, c.yaw, c.vBase, 0b001111);
  }
  const rungs = Math.max(2, Math.floor(h / 0.3));
  for (let i = 1; i < rungs; i++) {
    s.box(rx(c, lx, lz), c.cy + (i * h) / rungs, rz(c, lx, lz), 0.22, 0.02, 0.02, c.yaw, c.vBase, 0b001111);
  }
  rAnchor(c, lx, c.cy + h, lz);
}

/** Planter box with a hedge — the tech-office roof deck. */
function planter(c: RoofCtx, lx: number, lz: number, w: number, d: number): void {
  const s = c.s;
  s.setSurface(SURF.CONCRETE, 3.4, 0.5, 0).setColor(0.40, 0.39, 0.37);
  s.box(rx(c, lx, lz), c.cy + 0.3, rz(c, lx, lz), w * 0.5, 0.3, d * 0.5, c.yaw, c.vBase, 0b011111);
  s.setSurface(SURF.STUCCO, 3.4, 0.5, 0).setColor(0.075, 0.155, 0.06);
  s.box(rx(c, lx, lz), c.cy + 0.72, rz(c, lx, lz), w * 0.5 - 0.09, 0.14, d * 0.5 - 0.09, c.yaw, c.vBase, 0b111111);
}

/** Helipad: painted deck, perimeter lights, and the H. */
function helipad(c: RoofCtx, lx: number, lz: number, r: number): void {
  const s = c.s;
  s.setSurface(SURF.ASPHALT, 3.4, 0.5, 0).setColor(0.055, 0.06, 0.058);
  s.cylinder(rx(c, lx, lz), c.cy + 0.02, rz(c, lx, lz), r, r, 0.10, 24, c.vBase, true, false);
  // Circle + H in white paint, drawn as flat quads a few millimetres proud.
  s.setSurface(SURF.CONCRETE, 3.4, 0.5, 0).setColor(0.80, 0.80, 0.78);
  const ring = r * 0.78;
  const segs = 28;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const y = c.cy + 0.13;
    const r0 = ring - 0.16;
    const r1 = ring + 0.16;
    s.quad(
      rx(c, lx + Math.cos(a0) * r0, lz + Math.sin(a0) * r0), y, rz(c, lx + Math.cos(a0) * r0, lz + Math.sin(a0) * r0), 0, 0,
      rx(c, lx + Math.cos(a1) * r0, lz + Math.sin(a1) * r0), y, rz(c, lx + Math.cos(a1) * r0, lz + Math.sin(a1) * r0), 1, 0,
      rx(c, lx + Math.cos(a1) * r1, lz + Math.sin(a1) * r1), y, rz(c, lx + Math.cos(a1) * r1, lz + Math.sin(a1) * r1), 1, 1,
      rx(c, lx + Math.cos(a0) * r1, lz + Math.sin(a0) * r1), y, rz(c, lx + Math.cos(a0) * r1, lz + Math.sin(a0) * r1), 0, 1,
    );
  }
  const hh = r * 0.42;
  const hw2 = r * 0.28;
  const bar = 0.18;
  s.box(rx(c, lx - hw2, lz), c.cy + 0.13, rz(c, lx - hw2, lz), bar, 0.015, hh, c.yaw, c.vBase, 16);
  s.box(rx(c, lx + hw2, lz), c.cy + 0.13, rz(c, lx + hw2, lz), bar, 0.015, hh, c.yaw, c.vBase, 16);
  s.box(rx(c, lx, lz), c.cy + 0.13, rz(c, lx, lz), hw2, 0.015, bar, c.yaw, c.vBase, 16);
  // Perimeter lights.
  s.setSurface(SURF.METAL, 3.4, 0.5, 0).setColor(0.55, 0.42, 0.10);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    s.box(rx(c, lx + Math.cos(a) * r * 0.97, lz + Math.sin(a) * r * 0.97), c.cy + 0.19, rz(c, lx + Math.cos(a) * r * 0.97, lz + Math.sin(a) * r * 0.97), 0.07, 0.07, 0.07, c.yaw, c.vBase, 0b111111);
  }
  rAnchor(c, lx, c.cy + 0.2, lz);
}

/* ------------------------------------------------------------------ *
 * The dresser
 * ------------------------------------------------------------------ */

/**
 * Decorate every walkable roof on a building.
 *
 * Prop budget scales with roof area and falls off with LOD; at LOD 1 only the
 * big silhouette items survive (bulkhead, tank, mast, helipad), because those
 * are the ones you can still read from three hundred metres.
 *
 * Returns a new anchor array combining the building's existing anchors with
 * everything added here.
 */
export function dressRoofs(
  rec: BuildingRecord,
  sink: GeoSink,
  lod: number,
  originX: number,
  originZ: number,
): void {
  if (lod >= 2) return;
  const extra: number[] = [];

  for (let ri = 0; ri < rec.roofs.length; ri++) {
    const roof = rec.roofs[ri];
    if (!roof.walkable || roof.dressed) continue;
    roof.dressed = true;
    const area = roof.hw * roof.hd * 4;
    if (area < 14) continue;

    const rng = makeRng((rec.id * 2654435761 + ri * 40503) >>> 0);
    const c: RoofCtx = {
      s: sink,
      rng,
      lod,
      ox: roof.cx - originX,
      oz: roof.cz - originZ,
      cy: roof.cy,
      yaw: roof.yaw,
      cos: Math.cos(roof.yaw),
      sin: Math.sin(roof.yaw),
      vBase: roof.cy,
      anchors: extra,
      originX,
      originZ,
    };
    const p = beginPlacer(roof.hw, roof.hd, Math.min(1.1, Math.min(roof.hw, roof.hd) * 0.22));
    const big = lod === 0 ? 1 : 0;

    // 1. Stair bulkhead — every roof you can reach from inside has one.
    if (roof.hw > 3.2 && roof.hd > 3.2 && rng.chance(0.82)) {
      const w = Math.min(rng.range(2.4, 4.2), roof.hw * 0.8);
      const d = Math.min(rng.range(2.2, 3.6), roof.hd * 0.8);
      if (findSpot(p, rng, w * 0.5, d * 0.5, _spot)) {
        bulkhead(c, _spot.x, _spot.z, w, d, rng.range(2.4, 3.4));
        if (big) ladder(c, _spot.x + w * 0.5 + 0.3, _spot.z, rng.range(2.6, 3.4));
      }
    }

    // 2. Helipad — only where a helicopter could actually land: high, big, flat.
    const helipadOk = roof.cy - rec.baseY > 70 && Math.min(roof.hw, roof.hd) > 9;
    if (helipadOk && rng.chance(0.42)) {
      const r = Math.min(roof.hw, roof.hd) * 0.62;
      if (findSpot(p, rng, r, r, _spot)) helipad(c, _spot.x, _spot.z, r);
    }

    // 3. Water tank — brick and midrise buildings, the classic silhouette.
    const tankOk = rec.style === "midrise-brick" || rec.style === "warehouse" || rec.style === "edwardian-apartment";
    if (tankOk && Math.min(roof.hw, roof.hd) > 3.4 && rng.chance(0.4)) {
      const r = Math.min(rng.range(1.3, 2.1), Math.min(roof.hw, roof.hd) * 0.34);
      if (findSpot(p, rng, r * 1.2, r * 1.2, _spot)) {
        waterTank(c, _spot.x, _spot.z, r, rng.range(2.2, 3.4), rng.range(1.6, 3.4));
      }
    }

    // 4. HVAC. Density from area, then ducts tying pairs together.
    const units = Math.min(9, Math.floor(area / 95) + (rng.chance(0.6) ? 1 : 0));
    let lastX = 0;
    let lastZ = 0;
    let haveLast = false;
    for (let i = 0; i < units; i++) {
      const w = rng.range(1.5, 3.4);
      const d = rng.range(1.1, 2.2);
      const h = rng.range(0.9, 2.0);
      if (!findSpot(p, rng, w * 0.5, d * 0.5, _spot)) continue;
      hvacUnit(c, _spot.x, _spot.z, w, d, h);
      if (haveLast && lod === 0 && rng.chance(0.55)) {
        ductRun(c, lastX, lastZ, _spot.x, _spot.z, rng.range(0.5, 1.1));
      }
      lastX = _spot.x;
      lastZ = _spot.z;
      haveLast = true;
    }

    if (lod > 0) continue;

    // 5. Vents and stacks — dozens on a real roof; a handful reads the same.
    const vents = Math.min(14, Math.floor(area / 42));
    for (let i = 0; i < vents; i++) {
      if (!findSpot(p, rng, 0.3, 0.3, _spot)) continue;
      vent(c, _spot.x, _spot.z, rng.range(0.09, 0.2), rng.range(0.5, 1.5));
    }

    // 6. Comms.
    if (rng.chance(0.3) && Math.min(roof.hw, roof.hd) > 3) {
      if (findSpot(p, rng, 0.6, 0.6, _spot)) antenna(c, _spot.x, _spot.z, rng.range(3, 11));
    }
    const dishes = rng.int(0, roof.cy - rec.baseY > 25 ? 3 : 1);
    for (let i = 0; i < dishes; i++) {
      if (!findSpot(p, rng, 0.8, 0.8, _spot)) continue;
      dish(c, _spot.x, _spot.z, rng.range(0.45, 1.1));
    }

    // 7. Skylights — warehouses and brick lofts are full of them.
    if (rec.style === "warehouse" || rec.style === "midrise-brick" || rec.style === "industrial") {
      const sky = Math.min(6, Math.floor(area / 110));
      for (let i = 0; i < sky; i++) {
        const w = rng.range(1.6, 3.0);
        const d = rng.range(1.2, 2.2);
        if (!findSpot(p, rng, w * 0.5, d * 0.5, _spot)) continue;
        skylight(c, _spot.x, _spot.z, w, d);
      }
    }

    // 8. Roof deck / garden on the nicer addresses.
    const gardenOk = area > 70 && (rec.style === "highrise-glass" || rec.style === "edwardian-apartment" || rec.districtKey === "soma");
    if (gardenOk && rng.chance(0.35)) {
      const n = rng.int(2, 5);
      for (let i = 0; i < n; i++) {
        const w = rng.range(1.2, 3.2);
        const d = rng.range(0.7, 1.2);
        if (!findSpot(p, rng, w * 0.5, d * 0.5, _spot)) continue;
        planter(c, _spot.x, _spot.z, w, d);
      }
    }
  }

  if (extra.length) {
    const merged = new Float32Array(rec.anchors.length + extra.length);
    merged.set(rec.anchors, 0);
    merged.set(extra, rec.anchors.length);
    rec.anchors = merged;
  }
}

/** Re-export so callers touching roofs need only one import. */
export type { RoofSurface };
