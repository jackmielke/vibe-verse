/**
 * generator.ts — the massing of San Francisco, one parcel at a time.
 *
 * Ten building styles, ten genuinely different shapes. A Victorian is not a
 * Financial District tower with a different colour: it is two storeys with a
 * slant-sided bay window pushed 900 mm over the sidewalk, a bracketed cornice,
 * and a stoop. A SoMa warehouse is a sawtooth roof and a loading dock. A deco
 * tower is a ziggurat with vertical piers. If those silhouettes are wrong the
 * skyline is wrong and no amount of shader work saves it.
 *
 * Sitting on the hills
 * --------------------
 * Every parcel arrives with the highest and lowest ground under its footprint.
 * The building's ground-floor slab goes on the *high* point and a board-formed
 * concrete skirt fills down to the low point, so nothing floats and nothing is
 * buried. Because each parcel does this independently, a row marching down
 * Filbert steps down with the hill — which is the single most San Franciscan
 * thing a row of buildings can do.
 *
 * Public API
 * ----------
 *   generateBuilding(lot, sink, lod, originX, originZ, out?) → BuildingRecord | null
 *   BuildingRecord, RoofSurface
 *   FLOOR_HEIGHT                per-style storey heights, metres
 */
import * as THREE from "three";
import type { BuildingStyle } from "../../geo/sfGeo";
import { districtInfluence } from "../../geo/sfGeo";
import { clamp, clamp01, makeRng, mix, type Rng } from "../../math/rng";
import { GeoSink, SURF } from "./geoSink";
import type { Lot } from "./lots";

/* ------------------------------------------------------------------ *
 * Output records — the queryable half of the building system
 * ------------------------------------------------------------------ */

export type RoofKind = "flat" | "pitched" | "sawtooth" | "dome" | "setback";

/** A surface a player can land on, walk on, or a helicopter can sit on. */
export interface RoofSurface {
  /** Centre, world metres. `cy` is the walking surface. */
  cx: number;
  cy: number;
  cz: number;
  hw: number;
  hd: number;
  yaw: number;
  kind: RoofKind;
  /** False for pitched/sawtooth roofs you slide off. */
  walkable: boolean;
  /** True once rooftops.ts has dressed it (prevents double-decoration). */
  dressed: boolean;
}

export interface BuildingRecord {
  id: number;
  style: BuildingStyle;
  districtKey: string;
  /** Footprint centre + orientation (matches the parcel). */
  cx: number;
  cz: number;
  yaw: number;
  hw: number;
  hd: number;
  /** Ground-floor slab level. */
  baseY: number;
  /** Main roof deck. */
  roofY: number;
  /** Absolute top including crown, spire and antennas. */
  topY: number;
  /** World-space AABB — what the spatial index stores. */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  roofs: RoofSurface[];
  /** Grapple anchor points, packed xyz. Ledges, masts, parapet corners. */
  anchors: Float32Array;
}

/** Storey heights by style, metres. Real numbers: they set the window rhythm. */
export const FLOOR_HEIGHT: Record<BuildingStyle, number> = {
  victorian: 3.62,
  "edwardian-apartment": 3.24,
  "stucco-row": 2.96,
  "midrise-brick": 3.85,
  "highrise-glass": 3.95,
  "highrise-deco": 3.72,
  warehouse: 5.6,
  industrial: 6.4,
  civic: 6.1,
  military: 3.35,
};

/** Which raw wall material a style is built from. */
const WALL_SURFACE: Record<BuildingStyle, number> = {
  victorian: SURF.WOOD,
  "edwardian-apartment": SURF.STUCCO,
  "stucco-row": SURF.STUCCO,
  "midrise-brick": SURF.BRICK,
  "highrise-glass": SURF.CURTAIN,
  "highrise-deco": SURF.STONE,
  warehouse: SURF.BRICK,
  industrial: SURF.CORRUGATED,
  civic: SURF.STONE,
  military: SURF.STUCCO,
};

/* ------------------------------------------------------------------ *
 * Scratch — nothing in this file allocates per building except the record
 * ------------------------------------------------------------------ */

const _wall = new THREE.Color();
const _trim = new THREE.Color();
const _roofC = new THREE.Color();
const _tmp = new THREE.Color();
const _fx: number[] = [];
const _fz: number[] = [];
const _anchors: number[] = [];

interface Ctx {
  lot: Lot;
  rng: Rng;
  sink: GeoSink;
  lod: number;
  style: BuildingStyle;
  /** Footprint centre in *chunk-local* space. */
  ox: number;
  oz: number;
  yaw: number;
  cosY: number;
  sinY: number;
  hw: number;
  hd: number;
  /** Ground-floor slab, world Y. */
  base: number;
  /** Lowest ground under the footprint, world Y. */
  low: number;
  fh: number;
  floors: number;
  /** Roof deck height above `base`. */
  height: number;
  hash: number;
  /** Window intensity per face: front, back, left, right. */
  winFront: number;
  winBack: number;
  winSide: number;
  roofs: RoofSurface[];
  top: number;
}

/** Lot-local → chunk-local world X. */
function wx(c: Ctx, lx: number, lz: number): number {
  return c.ox + lx * c.cosY - lz * c.sinY;
}
/** Lot-local → chunk-local world Z. */
function wz(c: Ctx, lx: number, lz: number): number {
  return c.oz + lx * c.sinY + lz * c.cosY;
}

function anchor(c: Ctx, lx: number, y: number, lz: number): void {
  _anchors.push(wx(c, lx, lz), y, wz(c, lx, lz));
}

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

/**
 * Pick the paint. Districts carry a palette of real San Francisco colours;
 * we pick one, jitter value and saturation a little, and — for the styles that
 * deserve it — derive a *contrasting* trim colour rather than a lighter shade.
 * A city where every building is the same colour ±5 % looks like a render.
 */
function pickColors(lot: Lot, rng: Rng, style: BuildingStyle): void {
  const pal = lot.district.palette;
  const hex = pal[rng.int(0, pal.length - 1)];
  _wall.setHex(hex, THREE.SRGBColorSpace);
  // Value + saturation jitter in HSL keeps hues plausible.
  _wall.getHSL(_hsl);
  const light = clamp(_hsl.l * rng.range(0.82, 1.16), 0.05, 0.94);
  const sat = clamp(_hsl.s * rng.range(0.7, 1.35), 0, 0.85);
  const hueShift = rng.gauss() * 0.018;
  _wall.setHSL((_hsl.h + hueShift + 1) % 1, sat, light);

  // Trim: white-ish on Victorians (the classic), stone on masonry.
  if (style === "victorian" || style === "stucco-row" || style === "military") {
    _trim.setHSL((_hsl.h + 0.5 + rng.gauss() * 0.08 + 1) % 1, sat * 0.6, clamp(light * 1.5 + 0.18, 0.2, 0.96));
  } else {
    _trim.copy(_wall).multiplyScalar(1.18);
  }

  // Built-up roofs are near black; tile roofs are terracotta; membrane is pale.
  if (style === "military") _roofC.setHex(0x9c4530, THREE.SRGBColorSpace);
  else if (rng.chance(0.16)) _roofC.setHex(0x8f8d86, THREE.SRGBColorSpace);
  else _roofC.setRGB(0.052 + rng.range(0, 0.03), 0.05 + rng.range(0, 0.028), 0.048 + rng.range(0, 0.026));
}
const _hsl = { h: 0, s: 0, l: 0 };

function setWall(c: Ctx, surf: number, win: number, col = _wall): void {
  c.sink.setSurface(surf, c.fh, c.hash, win).setColor(col.r, col.g, col.b);
}

/* ------------------------------------------------------------------ *
 * Shared parts
 * ------------------------------------------------------------------ */

/** Concrete foundation filling the drop from the slab to the low corner. */
function emitSkirt(c: Ctx): void {
  const y0 = c.low - 1.8;
  const y1 = c.base + 0.12;
  if (y1 - y0 < 0.2) return;
  c.sink.setSurface(SURF.CONCRETE, c.fh, c.hash, 0).setColor(0.30, 0.295, 0.285);
  c.sink.box(wx(c, 0, 0), (y0 + y1) * 0.5, wz(c, 0, 0), c.hw + 0.10, (y1 - y0) * 0.5, c.hd + 0.10, c.yaw, c.base, 0b001111);
}

/**
 * Register the roof deck and cap it. The cap is a real surface: the player
 * lands on it, the grapple hooks its parapet, and the AI paths across it.
 */
function flatRoof(c: Ctx, y: number, hw: number, hd: number, dx = 0, dz = 0, kind: RoofKind = "flat"): RoofSurface {
  c.sink.setSurface(SURF.ROOF, c.fh, c.hash, 0).setColor(_roofC.r, _roofC.g, _roofC.b);
  c.sink.box(wx(c, dx, dz), y - 0.06, wz(c, dx, dz), hw, 0.06, hd, c.yaw, c.base, 16);
  const rs: RoofSurface = {
    cx: wx(c, dx, dz),
    cy: y,
    cz: wz(c, dx, dz),
    hw,
    hd,
    yaw: c.yaw,
    kind,
    walkable: true,
    dressed: false,
  };
  c.roofs.push(rs);
  if (y > c.top) c.top = y;
  return rs;
}

/** Parapet wall around a flat roof — and the grapple's favourite ledge. */
function parapet(c: Ctx, y: number, hw: number, hd: number, h: number, thick: number, dx = 0, dz = 0): void {
  if (c.lod >= 2) return;
  const cy = y + h * 0.5;
  const col = _trim;
  c.sink.setSurface(SURF.CONCRETE, c.fh, c.hash, 0).setColor(col.r * 0.9, col.g * 0.9, col.b * 0.9);
  // Four rails; inner + outer + top faces only (nobody sees the ends).
  c.sink.box(wx(c, dx, dz - hd + thick * 0.5), cy, wz(c, dx, dz - hd + thick * 0.5), hw, h * 0.5, thick * 0.5, c.yaw, c.base, 0b011111);
  c.sink.box(wx(c, dx, dz + hd - thick * 0.5), cy, wz(c, dx, dz + hd - thick * 0.5), hw, h * 0.5, thick * 0.5, c.yaw, c.base, 0b011111);
  c.sink.box(wx(c, dx - hw + thick * 0.5, dz), cy, wz(c, dx - hw + thick * 0.5, dz), thick * 0.5, h * 0.5, hd - thick, c.yaw, c.base, 0b011111);
  c.sink.box(wx(c, dx + hw - thick * 0.5, dz), cy, wz(c, dx + hw - thick * 0.5, dz), thick * 0.5, h * 0.5, hd - thick, c.yaw, c.base, 0b011111);
  anchor(c, dx, y + h, dz - hd + thick);
  anchor(c, dx, y + h, dz + hd - thick);
}

/** Projecting cornice band — the thing that makes a masonry building read old. */
// `surf` is annotated rather than left to inference: SURF is declared `as const`,
// so a bare `surf = SURF.STONE` default would narrow the parameter to the literal
// type 2 and reject every other surface id at the call site.
function cornice(c: Ctx, y: number, hw: number, hd: number, over: number, h: number, surf: number = SURF.STONE): void {
  if (c.lod >= 2) return;
  c.sink.setSurface(surf, c.fh, c.hash, 0).setColor(_trim.r, _trim.g, _trim.b);
  /* No top face on the band itself. It is a solid slab the full size of the
     building, and most callers stand it up to (or 12 cm past) the roof line,
     so its lid was drawn over the roof deck: every flat roof on every
     corniced building in the city was a sheet of trim paint, pure white from
     the air on a painted lady. The only part of the lid anybody can see is the
     ring that overhangs the wall, so that is the only part that is built. */
  c.sink.box(wx(c, 0, 0), y + h * 0.5, wz(c, 0, 0), hw + over, h * 0.5, hd + over, c.yaw, c.base, 0b111111 & ~16);
  const lid = y + h - 0.01;
  const o2 = over * 0.5;
  c.sink.box(wx(c, 0, -hd - o2), lid, wz(c, 0, -hd - o2), hw + over, 0.01, o2, c.yaw, c.base, 16);
  c.sink.box(wx(c, 0, hd + o2), lid, wz(c, 0, hd + o2), hw + over, 0.01, o2, c.yaw, c.base, 16);
  c.sink.box(wx(c, -hw - o2, 0), lid, wz(c, -hw - o2, 0), o2, 0.01, hd, c.yaw, c.base, 16);
  c.sink.box(wx(c, hw + o2, 0), lid, wz(c, hw + o2, 0), o2, 0.01, hd, c.yaw, c.base, 16);
  if (c.lod === 0) {
    // Dentil/bracket course under the cornice: a run of small blocks. Cheap
    // geometry, and it is what your eye reads as "carved" from the sidewalk.
    const n = Math.min(28, Math.max(4, Math.floor((hw * 2) / 0.85)));
    const step = (hw * 2) / n;
    for (let i = 0; i < n; i++) {
      const lx = -hw + step * (i + 0.5);
      c.sink.box(wx(c, lx, -hd - over * 0.55), y - 0.22, wz(c, lx, -hd - over * 0.55), step * 0.28, 0.22, over * 0.55, c.yaw, c.base, 0b011111);
    }
  }
}

/**
 * Bay window — the defining San Francisco silhouette.
 *
 * Two flavours: the slant-sided (canted) bay of the 1880s Italianate and
 * Queen Anne, and the squared bay of the Edwardian flat. They project ~900 mm
 * over the property line, which is exactly why every SF street looks corrugated.
 */
function bayWindow(
  c: Ctx,
  lx: number,
  width: number,
  proj: number,
  y0: number,
  y1: number,
  slanted: boolean,
  surf: number,
): void {
  const zFace = -c.hd;
  const side = slanted ? Math.min(width * 0.28, proj * 0.95) : 0;
  const px: number[] = [
    lx - width * 0.5,
    lx - width * 0.5 + side,
    lx + width * 0.5 - side,
    lx + width * 0.5,
  ];
  const pz: number[] = [zFace, zFace - proj, zFace - proj, zFace];
  const s = c.sink;
  setWall(c, surf, 1);
  let uAcc = 0;
  for (let i = 0; i < 3; i++) {
    const ax = wx(c, px[i], pz[i]);
    const az = wz(c, px[i], pz[i]);
    const bx = wx(c, px[i + 1], pz[i + 1]);
    const bz = wz(c, px[i + 1], pz[i + 1]);
    s.wall(ax, az, bx, bz, y0, y1, c.base, uAcc);
    uAcc += Math.hypot(bx - ax, bz - az);
  }
  // Bay roof + soffit.
  s.setSurface(SURF.ROOF, c.fh, c.hash, 0).setColor(_roofC.r * 1.3, _roofC.g * 1.3, _roofC.b * 1.3);
  s.tri(
    wx(c, px[0], pz[0]), y1, wz(c, px[0], pz[0]), px[0], pz[0],
    wx(c, px[2], pz[2]), y1, wz(c, px[2], pz[2]), px[2], pz[2],
    wx(c, px[1], pz[1]), y1, wz(c, px[1], pz[1]), px[1], pz[1],
  );
  s.tri(
    wx(c, px[0], pz[0]), y1, wz(c, px[0], pz[0]), px[0], pz[0],
    wx(c, px[3], pz[3]), y1, wz(c, px[3], pz[3]), px[3], pz[3],
    wx(c, px[2], pz[2]), y1, wz(c, px[2], pz[2]), px[2], pz[2],
  );
  if (y0 > c.base + 0.4) {
    // Underside of a bay that starts above the ground floor.
    s.setSurface(SURF.WOOD, c.fh, c.hash, 0).setColor(_trim.r * 0.8, _trim.g * 0.8, _trim.b * 0.8);
    s.tri(
      wx(c, px[0], pz[0]), y0, wz(c, px[0], pz[0]), px[0], pz[0],
      wx(c, px[1], pz[1]), y0, wz(c, px[1], pz[1]), px[1], pz[1],
      wx(c, px[2], pz[2]), y0, wz(c, px[2], pz[2]), px[2], pz[2],
    );
    s.tri(
      wx(c, px[0], pz[0]), y0, wz(c, px[0], pz[0]), px[0], pz[0],
      wx(c, px[2], pz[2]), y0, wz(c, px[2], pz[2]), px[2], pz[2],
      wx(c, px[3], pz[3]), y0, wz(c, px[3], pz[3]), px[3], pz[3],
    );
  }
  anchor(c, lx, y1, -c.hd - proj);
}

/** Entry stoop: the flight of steps up to a raised parlour floor. */
function stoop(c: Ctx, lx: number, rise: number): void {
  if (c.lod > 0 || rise < 0.5) return;
  const steps = Math.max(2, Math.round(rise / 0.19));
  const run = 0.30;
  const w = 1.6;
  c.sink.setSurface(SURF.CONCRETE, c.fh, c.hash, 0).setColor(0.42, 0.41, 0.39);
  for (let i = 0; i < steps; i++) {
    const y = c.base + rise - (i + 1) * (rise / steps);
    const z = -c.hd - (i + 1) * run;
    c.sink.box(wx(c, lx, z + run * 0.5), y * 0.5 + (c.base - 0.4) * 0.5, wz(c, lx, z + run * 0.5), w * 0.5, (y - (c.base - 0.8)) * 0.5, run * 0.5, c.yaw, c.base, 0b011111);
  }
  // Cheek walls.
  c.sink.setSurface(SURF.CONCRETE, c.fh, c.hash, 0).setColor(_trim.r * 0.8, _trim.g * 0.8, _trim.b * 0.8);
  for (const sgn of [-1, 1]) {
    c.sink.box(
      wx(c, lx + sgn * (w * 0.5 + 0.12), -c.hd - steps * run * 0.5),
      c.base + rise * 0.5,
      wz(c, lx + sgn * (w * 0.5 + 0.12), -c.hd - steps * run * 0.5),
      0.12, rise * 0.55, steps * run * 0.5, c.yaw, c.base, 0b011111,
    );
  }
}

/**
 * Fire escape — real geometry, because on a SoMa brick facade it is half of
 * what you see, and because a Just Cause player will absolutely try to stand
 * on one.
 */
function fireEscape(c: Ctx, lx: number, fromFloor: number, toFloor: number): void {
  if (c.lod > 0) return;
  const s = c.sink;
  const zf = -c.hd - 0.06;
  const depth = 1.15;
  const w = 2.4;
  s.setSurface(SURF.METAL, c.fh, c.hash, 0).setColor(0.09, 0.10, 0.105);
  for (let f = fromFloor; f <= toFloor; f++) {
    const y = c.base + f * c.fh - 0.28;
    // Landing platform.
    s.box(wx(c, lx, zf - depth * 0.5), y, wz(c, lx, zf - depth * 0.5), w * 0.5, 0.05, depth * 0.5, c.yaw, c.base, 0b111111);
    // Railing: two rails plus corner posts. Solid boxes read fine at 1 m.
    for (const h of [0.5, 1.05]) {
      s.box(wx(c, lx, zf - depth), y + h, wz(c, lx, zf - depth), w * 0.5, 0.03, 0.03, c.yaw, c.base, 0b011111);
      for (const sgn of [-1, 1]) {
        s.box(wx(c, lx + sgn * w * 0.5, zf - depth * 0.5), y + h, wz(c, lx + sgn * w * 0.5, zf - depth * 0.5), 0.03, 0.03, depth * 0.5, c.yaw, c.base, 0b011111);
      }
    }
    for (const sgn of [-1, 1]) {
      s.box(wx(c, lx + sgn * w * 0.5, zf - depth), y + 0.55, wz(c, lx + sgn * w * 0.5, zf - depth), 0.04, 0.55, 0.04, c.yaw, c.base, 0b011111);
    }
    // Diagonal stair down to the landing below.
    if (f > fromFloor) {
      const yTop = y;
      const yBot = y - c.fh;
      const x0 = lx - w * 0.35;
      const x1 = lx + w * 0.35;
      const zz = zf - depth * 0.62;
      const mxs = (x0 + x1) * 0.5;
      const midY = (yTop + yBot) * 0.5;
      const len = Math.hypot(x1 - x0, yTop - yBot);
      const ang = Math.atan2(yTop - yBot, x1 - x0);
      // Approximate the flight with a thin slab rotated in the facade plane:
      // emit it as an explicit quad pair rather than fighting the box helper.
      const hx = Math.cos(ang) * len * 0.5;
      const hy = Math.sin(ang) * len * 0.5;
      const ax = wx(c, mxs - hx, zz);
      const az = wz(c, mxs - hx, zz);
      const bx2 = wx(c, mxs + hx, zz);
      const bz2 = wz(c, mxs + hx, zz);
      const cxx = wx(c, mxs + hx, zz - 0.55);
      const czz = wz(c, mxs + hx, zz - 0.55);
      const dxx = wx(c, mxs - hx, zz - 0.55);
      const dzz = wz(c, mxs - hx, zz - 0.55);
      s.quad(
        ax, midY - hy, az, 0, 0,
        bx2, midY + hy, bz2, len, 0,
        cxx, midY + hy, czz, len, 0.55,
        dxx, midY - hy, dzz, 0, 0.55,
      );
    }
    anchor(c, lx, y + 1.1, zf - depth);
  }
}

/** Roll-up service door, recessed into the wall. */
function rollUpDoor(c: Ctx, lx: number, w: number, h: number): void {
  const s = c.sink;
  s.setSurface(SURF.CORRUGATED, 2.0, c.hash, 0).setColor(_trim.r * 0.55, _trim.g * 0.55, _trim.b * 0.58);
  s.box(wx(c, lx, -c.hd + 0.12), c.base + h * 0.5, wz(c, lx, -c.hd + 0.12), w * 0.5, h * 0.5, 0.12, c.yaw, c.base, 0b011111);
  s.setSurface(SURF.CONCRETE, c.fh, c.hash, 0).setColor(_trim.r * 0.8, _trim.g * 0.8, _trim.b * 0.8);
  s.box(wx(c, lx, -c.hd - 0.04), c.base + h + 0.16, wz(c, lx, -c.hd - 0.04), w * 0.5 + 0.18, 0.16, 0.08, c.yaw, c.base, 0b011111);
}

/** Ground-floor storefront: full-height glazing with a bulkhead and a sign band. */
function storefront(c: Ctx, hgt: number): void {
  if (c.lod >= 2) return;
  const s = c.sink;
  const inset = 0.14;
  s.setSurface(SURF.GLASS, c.fh, c.hash, 1).setColor(0.08, 0.09, 0.10);
  s.box(wx(c, 0, -c.hd + inset), c.base + hgt * 0.5 + 0.5, wz(c, 0, -c.hd + inset), c.hw - 0.35, hgt * 0.45, inset, c.yaw, c.base, 0b011111);
  // Signboard over the shopfront — the horizontal that makes a street read commercial.
  s.setSurface(SURF.METAL, c.fh, c.hash, 0).setColor(_trim.r * 0.5, _trim.g * 0.5, _trim.b * 0.55);
  s.box(wx(c, 0, -c.hd - 0.09), c.base + hgt + 0.36, wz(c, 0, -c.hd - 0.09), c.hw - 0.1, 0.36, 0.10, c.yaw, c.base, 0b011111);
}

/* ------------------------------------------------------------------ *
 * The prism helper every simple mass runs through
 * ------------------------------------------------------------------ */

/**
 * A box mass with per-face window intensity. Front (-Z) is the street facade,
 * side faces are blind where a party wall abuts. Faces are emitted separately
 * so each can carry its own window intensity — the whole reason SF row houses
 * read correctly is that their side walls are blank.
 */
function mass(
  c: Ctx,
  hw: number,
  hd: number,
  y0: number,
  y1: number,
  surf: number,
  dx = 0,
  dz = 0,
  capTop = false,
  col = _wall,
): void {
  const s = c.sink;
  const corners = [
    [dx - hw, dz - hd],
    [dx + hw, dz - hd],
    [dx + hw, dz + hd],
    [dx - hw, dz + hd],
  ];
  // Edge 0 = front (-Z), 1 = right (+X), 2 = back (+Z), 3 = left (-X).
  const winByEdge = [c.winFront, c.winSide * (c.lot.attachRight ? 0 : 1), c.winBack, c.winSide * (c.lot.attachLeft ? 0 : 1)];
  let uAcc = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) & 3];
    const ax = wx(c, a[0], a[1]);
    const az = wz(c, a[0], a[1]);
    const bx = wx(c, b[0], b[1]);
    const bz = wz(c, b[0], b[1]);
    s.setSurface(surf, c.fh, c.hash, winByEdge[i]).setColor(col.r, col.g, col.b);
    s.wall(ax, az, bx, bz, y0, y1, c.base, uAcc);
    uAcc += Math.hypot(bx - ax, bz - az);
  }
  if (capTop) flatRoof(c, y1, hw, hd, dx, dz);
}

/* ------------------------------------------------------------------ *
 * Style: victorian
 * ------------------------------------------------------------------ */

function genVictorian(c: Ctx): void {
  const { rng } = c;
  const surf = rng.chance(0.72) ? SURF.WOOD : SURF.STUCCO;
  const raised = rng.range(0.8, 1.6); // raised parlour floor over a garage
  const y0 = c.base;
  const roofY = c.base + c.height;

  mass(c, c.hw, c.hd, y0, roofY, surf);

  // Bay windows. One bay on a 25-foot lot, two on a double.
  if (c.lod < 2) {
    const bays = c.hw * 2 > 11 ? 2 : 1;
    const proj = rng.range(0.72, 1.05);
    const slanted = rng.chance(0.62);
    const bw = Math.min((c.hw * 2) / bays - 1.4, rng.range(2.6, 3.6));
    for (let i = 0; i < bays; i++) {
      const lx = -c.hw + ((i + 0.5) * (c.hw * 2)) / bays;
      // Bays start at the parlour floor and run to the cornice.
      bayWindow(c, lx, bw, proj, y0 + (rng.chance(0.72) ? c.fh : 0.2), roofY - 0.35, slanted, surf);
    }
    // Entry: door bay to one side, with its stoop.
    const doorX = c.hw * (rng.chance(0.5) ? -0.72 : 0.72);
    stoop(c, doorX, raised);
    c.sink.setSurface(SURF.WOOD, c.fh, c.hash, 0).setColor(_trim.r * 0.7, _trim.g * 0.7, _trim.b * 0.7);
    c.sink.box(wx(c, doorX, -c.hd - 0.10), c.base + raised + 1.15, wz(c, doorX, -c.hd - 0.10), 0.62, 1.15, 0.10, c.yaw, c.base, 0b011111);
  }

  cornice(c, roofY - 0.5, c.hw, c.hd, 0.34, 0.62, surf === SURF.WOOD ? SURF.WOOD : SURF.STONE);

  const roofRoll = rng.next();
  if (roofRoll < 0.58) {
    flatRoof(c, roofY, c.hw, c.hd);
    parapet(c, roofY, c.hw, c.hd, 0.55, 0.22);
  } else if (roofRoll < 0.84) {
    gableRoof(c, roofY, c.hw, c.hd, rng.range(1.6, 2.8), SURF.ROOF);
  } else {
    mansardRoof(c, roofY, c.hw, c.hd, rng.range(2.0, 3.0));
  }
}

/* ------------------------------------------------------------------ *
 * Roof forms shared by several styles
 * ------------------------------------------------------------------ */

function gableRoof(c: Ctx, y: number, hw: number, hd: number, rise: number, surf: number): void {
  const s = c.sink;
  s.setSurface(surf, c.fh, c.hash, 0).setColor(_roofC.r, _roofC.g, _roofC.b);
  const over = 0.28;
  const ridgeY = y + rise;
  // Ridge runs along local X (parallel to the street), gables face the sides.
  const zn = -hd - over;
  const zp = hd + over;
  const xn = -hw - over;
  const xp = hw + over;
  const slopeLen = Math.hypot(hd + over, rise);
  // Two pitched planes.
  s.quad(
    wx(c, xn, zn), y, wz(c, xn, zn), 0, 0,
    wx(c, xn, 0), ridgeY, wz(c, xn, 0), 0, slopeLen,
    wx(c, xp, 0), ridgeY, wz(c, xp, 0), hw * 2, slopeLen,
    wx(c, xp, zn), y, wz(c, xp, zn), hw * 2, 0,
  );
  s.quad(
    wx(c, xn, 0), ridgeY, wz(c, xn, 0), 0, slopeLen,
    wx(c, xn, zp), y, wz(c, xn, zp), 0, 0,
    wx(c, xp, zp), y, wz(c, xp, zp), hw * 2, 0,
    wx(c, xp, 0), ridgeY, wz(c, xp, 0), hw * 2, slopeLen,
  );
  // Gable end walls.
  s.setSurface(WALL_SURFACE[c.style], c.fh, c.hash, 0.4).setColor(_wall.r, _wall.g, _wall.b);
  for (const sgn of [-1, 1]) {
    const lx = sgn * hw;
    // The two gable ends face opposite ways, so their triangles wind opposite.
    if (sgn < 0) {
      s.tri(
        wx(c, lx, -hd), y, wz(c, lx, -hd), 0, 0,
        wx(c, lx, hd), y, wz(c, lx, hd), hd * 2, 0,
        wx(c, lx, 0), ridgeY, wz(c, lx, 0), hd, rise,
      );
    } else {
      s.tri(
        wx(c, lx, -hd), y, wz(c, lx, -hd), 0, 0,
        wx(c, lx, 0), ridgeY, wz(c, lx, 0), hd, rise,
        wx(c, lx, hd), y, wz(c, lx, hd), hd * 2, 0,
      );
    }
  }
  c.roofs.push({
    cx: wx(c, 0, 0), cy: y + rise * 0.45, cz: wz(c, 0, 0),
    hw, hd, yaw: c.yaw, kind: "pitched", walkable: false, dressed: true,
  });
  if (ridgeY > c.top) c.top = ridgeY;
  anchor(c, 0, ridgeY, 0);
}

function mansardRoof(c: Ctx, y: number, hw: number, hd: number, rise: number): void {
  const s = c.sink;
  const inset = Math.min(hw, hd) * 0.32;
  s.setSurface(SURF.ROOF, c.fh, c.hash, 0).setColor(_roofC.r * 0.9, _roofC.g * 0.9, _roofC.b * 0.9);
  const outer: [number, number][] = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
  const inner: [number, number][] = [
    [-hw + inset, -hd + inset], [hw - inset, -hd + inset], [hw - inset, hd - inset], [-hw + inset, hd - inset],
  ];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) & 3;
    const a = outer[i];
    const b = outer[j];
    const bi = inner[j];
    const ai = inner[i];
    s.quad(
      wx(c, a[0], a[1]), y, wz(c, a[0], a[1]), 0, 0,
      wx(c, ai[0], ai[1]), y + rise, wz(c, ai[0], ai[1]), 0, rise,
      wx(c, bi[0], bi[1]), y + rise, wz(c, bi[0], bi[1]), Math.hypot(b[0] - a[0], b[1] - a[1]), rise,
      wx(c, b[0], b[1]), y, wz(c, b[0], b[1]), Math.hypot(b[0] - a[0], b[1] - a[1]), 0,
    );
  }
  flatRoof(c, y + rise, hw - inset, hd - inset);
}

/* ------------------------------------------------------------------ *
 * Style: edwardian apartment
 * ------------------------------------------------------------------ */

function genEdwardian(c: Ctx): void {
  const { rng } = c;
  const roofY = c.base + c.height;
  mass(c, c.hw, c.hd, c.base, roofY, SURF.STUCCO);

  if (c.lod < 2) {
    // Squared bays, full height, in a rhythm across the frontage.
    const bays = Math.max(1, Math.min(4, Math.round((c.hw * 2) / 4.6)));
    const proj = rng.range(0.55, 0.85);
    const bw = Math.min((c.hw * 2) / bays - 1.3, rng.range(2.8, 4.0));
    for (let i = 0; i < bays; i++) {
      const lx = -c.hw + ((i + 0.5) * (c.hw * 2)) / bays;
      bayWindow(c, lx, bw, proj, c.base + c.fh * 0.98, roofY - 0.6, false, SURF.STUCCO);
    }
    // Entry portico: two columns and an entablature.
    const doorX = rng.chance(0.5) ? -c.hw * 0.6 : c.hw * 0.6;
    const s = c.sink;
    s.setSurface(SURF.STONE, c.fh, c.hash, 0).setColor(_trim.r, _trim.g, _trim.b);
    for (const sgn of [-1, 1]) {
      s.cylinder(wx(c, doorX + sgn * 0.85, -c.hd - 0.9), c.base, wz(c, doorX + sgn * 0.85, -c.hd - 0.9), 0.16, 0.14, c.fh * 0.85, 8, c.base, false, false);
    }
    s.box(wx(c, doorX, -c.hd - 0.5), c.base + c.fh * 0.9, wz(c, doorX, -c.hd - 0.5), 1.3, 0.22, 0.6, c.yaw, c.base, 0b111111);
    // Banded base course.
    s.setSurface(SURF.STONE, c.fh, c.hash, 0).setColor(_trim.r * 0.94, _trim.g * 0.94, _trim.b * 0.94);
    s.box(wx(c, 0, 0), c.base + c.fh * 0.5, wz(c, 0, 0), c.hw + 0.07, c.fh * 0.5, c.hd + 0.07, c.yaw, c.base, 0b000001);
  }

  cornice(c, roofY - 0.7, c.hw, c.hd, 0.42, 0.7);
  flatRoof(c, roofY, c.hw, c.hd);
  parapet(c, roofY, c.hw, c.hd, 0.85, 0.24);
}

/* ------------------------------------------------------------------ *
 * Style: stucco row (the Sunset / Richmond)
 * ------------------------------------------------------------------ */

function genStuccoRow(c: Ctx): void {
  const { rng } = c;
  const roofY = c.base + c.height;
  mass(c, c.hw, c.hd, c.base, roofY, SURF.STUCCO);

  if (c.lod < 2) {
    const s = c.sink;
    // Garage under: the Sunset's whole ground floor is a door and a stair.
    rollUpDoor(c, -c.hw * 0.35, Math.min(c.hw * 1.0, 3.0), 2.25);
    s.setSurface(SURF.WOOD, c.fh, c.hash, 0).setColor(_trim.r * 0.75, _trim.g * 0.75, _trim.b * 0.75);
    s.box(wx(c, c.hw * 0.55, -c.hd - 0.08), c.base + 1.15, wz(c, c.hw * 0.55, -c.hd - 0.08), 0.5, 1.05, 0.08, c.yaw, c.base, 0b011111);
    // Single shallow bay on the upper floor — the "modernised" 1930s front.
    bayWindow(c, 0, Math.min(c.hw * 1.5, 4.2), rng.range(0.35, 0.55), c.base + c.fh, roofY - 0.45, rng.chance(0.4), SURF.STUCCO);
    // Stepped/curved parapet motif at the top of the facade.
    s.setSurface(SURF.STUCCO, c.fh, c.hash, 0).setColor(_trim.r, _trim.g, _trim.b);
    s.box(wx(c, 0, -c.hd - 0.05), roofY + 0.28, wz(c, 0, -c.hd - 0.05), c.hw * rng.range(0.4, 0.7), 0.28, 0.14, c.yaw, c.base, 0b011111);
  }

  cornice(c, roofY - 0.34, c.hw, c.hd, 0.16, 0.34, SURF.STUCCO);
  flatRoof(c, roofY, c.hw, c.hd);
  parapet(c, roofY, c.hw, c.hd, 0.5, 0.18);
}

/* ------------------------------------------------------------------ *
 * Style: midrise brick
 * ------------------------------------------------------------------ */

function genMidriseBrick(c: Ctx): void {
  const { rng } = c;
  const roofY = c.base + c.height;
  mass(c, c.hw, c.hd, c.base, roofY, SURF.BRICK);

  if (c.lod < 2) {
    storefront(c, c.fh * 0.86);
    // Brick pilasters between the window bays give the facade its relief.
    const s = c.sink;
    const n = Math.max(2, Math.min(9, Math.round((c.hw * 2) / 5.2)));
    s.setSurface(SURF.BRICK, c.fh, c.hash, 0).setColor(_wall.r * 1.05, _wall.g * 1.05, _wall.b * 1.05);
    for (let i = 0; i <= n; i++) {
      const lx = -c.hw + ((c.hw * 2) * i) / n;
      s.box(wx(c, lx, -c.hd - 0.07), c.base + c.fh + (c.height - c.fh) * 0.5, wz(c, lx, -c.hd - 0.07), 0.30, (c.height - c.fh) * 0.5, 0.09, c.yaw, c.base, 0b011111);
    }
    if (c.floors >= 3 && rng.chance(0.75)) {
      fireEscape(c, rng.chance(0.5) ? -c.hw * 0.45 : c.hw * 0.45, 1, c.floors - 1);
    }
  }

  // Corbelled cornice: two bands, the upper projecting further.
  cornice(c, roofY - 1.05, c.hw, c.hd, 0.20, 0.42, SURF.BRICK);
  cornice(c, roofY - 0.6, c.hw, c.hd, 0.46, 0.6, SURF.STONE);
  flatRoof(c, roofY, c.hw, c.hd);
  parapet(c, roofY, c.hw, c.hd, 1.0, 0.30);
}

/* ------------------------------------------------------------------ *
 * Style: highrise glass
 * ------------------------------------------------------------------ */

function genHighriseGlass(c: Ctx): void {
  const { rng } = c;
  const s = c.sink;
  // Podium: the first two or three floors are a different, heavier material,
  // and they hold the tower's footprint out to the property line.
  const podFloors = rng.int(2, 3);
  const podY = c.base + podFloors * c.fh;
  setWall(c, SURF.STONE, 0.55, _trim);
  mass(c, c.hw, c.hd, c.base, podY, SURF.STONE, 0, 0, false, _trim);
  if (c.lod < 2) {
    storefront(c, c.fh * 1.5);
    flatRoof(c, podY, c.hw, c.hd, 0, 0, "setback");
    parapet(c, podY, c.hw, c.hd, 1.1, 0.3);
  }

  // Tower: one to three setbacks, each stage smaller, optionally chamfered.
  const stages = rng.int(1, 3);
  const chamfer = rng.chance(0.45) ? rng.range(1.2, 3.4) : 0;
  let hw = c.hw * rng.range(0.72, 0.92);
  let hd = c.hd * rng.range(0.72, 0.94);
  let y = podY;
  const remain = c.base + c.height - podY;
  let dx = 0;
  let dz = 0;
  for (let i = 0; i < stages; i++) {
    const frac = i === stages - 1 ? 1 : rng.range(0.35, 0.62);
    const stageH = (c.base + c.height - y) * frac;
    if (stageH < c.fh) break;
    buildFootprint(c, hw, hd, dx, dz, chamfer, _fx, _fz);
    setWall(c, SURF.CURTAIN, 1);
    s.extrude(_fx, _fz, y, y + stageH, c.base, false, true);
    y += stageH;
    if (i < stages - 1) {
      // Setback terrace — a real, landable roof deck.
      flatRoof(c, y, hw, hd, dx, dz, "setback");
      parapet(c, y, hw, hd, 1.05, 0.26, dx, dz);
      const shrink = rng.range(0.72, 0.9);
      // Setbacks in this city are asymmetric far more often than not.
      const nhw = hw * shrink;
      const nhd = hd * rng.range(0.78, 0.95);
      dx += (hw - nhw) * rng.range(-0.6, 0.6);
      dz += (hd - nhd) * rng.range(-0.6, 0.6);
      hw = nhw;
      hd = nhd;
    }
  }
  void remain;

  // Crown: mechanical penthouse, a stepped cap, and a mast.
  const roofY = y;
  flatRoof(c, roofY, hw, hd, dx, dz);
  parapet(c, roofY, hw, hd, 1.3, 0.3, dx, dz);
  if (c.lod < 2) {
    const mh = rng.range(3.2, 6.5);
    s.setSurface(SURF.CONCRETE, c.fh, c.hash, 0).setColor(_trim.r * 0.8, _trim.g * 0.8, _trim.b * 0.8);
    s.box(wx(c, dx, dz), roofY + mh * 0.5, wz(c, dx, dz), hw * 0.6, mh * 0.5, hd * 0.6, c.yaw, c.base, 0b111111);
    if (rng.chance(0.55)) {
      const mh2 = rng.range(2.0, 4.5);
      s.box(wx(c, dx, dz), roofY + mh + mh2 * 0.5, wz(c, dx, dz), hw * 0.34, mh2 * 0.5, hd * 0.34, c.yaw, c.base, 0b111111);
      c.top = Math.max(c.top, roofY + mh + mh2);
    }
    const mastH = rng.range(6, 22);
    s.setSurface(SURF.METAL, c.fh, c.hash, 0).setColor(0.16, 0.17, 0.18);
    s.cylinder(wx(c, dx, dz), roofY + mh, wz(c, dx, dz), 0.34, 0.12, mastH, 6, c.base, true, false);
    anchor(c, dx, roofY + mh + mastH, dz);
    c.top = Math.max(c.top, roofY + mh + mastH);
  }
}

/** Rectangular footprint with optional 45° corner chamfers, into _fx/_fz. */
function buildFootprint(
  c: Ctx,
  hw: number,
  hd: number,
  dx: number,
  dz: number,
  chamfer: number,
  ox: number[],
  oz: number[],
): void {
  ox.length = 0;
  oz.length = 0;
  const ch = Math.min(chamfer, hw * 0.45, hd * 0.45);
  const pts: [number, number][] = [];
  if (ch > 0.05) {
    pts.push([dx - hw + ch, dz - hd], [dx + hw - ch, dz - hd],
      [dx + hw, dz - hd + ch], [dx + hw, dz + hd - ch],
      [dx + hw - ch, dz + hd], [dx - hw + ch, dz + hd],
      [dx - hw, dz + hd - ch], [dx - hw, dz - hd + ch]);
  } else {
    pts.push([dx - hw, dz - hd], [dx + hw, dz - hd], [dx + hw, dz + hd], [dx - hw, dz + hd]);
  }
  for (const p of pts) {
    ox.push(wx(c, p[0], p[1]));
    oz.push(wz(c, p[0], p[1]));
  }
}

/* ------------------------------------------------------------------ *
 * Style: highrise deco
 * ------------------------------------------------------------------ */

function genHighriseDeco(c: Ctx): void {
  const { rng } = c;
  const s = c.sink;
  const stages = rng.int(3, 5);
  let hw = c.hw;
  let hd = c.hd;
  let y = c.base;
  const total = c.height;

  // Rusticated base, two storeys.
  const baseH = c.fh * 2;
  mass(c, hw, hd, y, y + baseH, SURF.STONE, 0, 0, false, _trim);
  y += baseH;
  if (c.lod < 2) storefront(c, c.fh * 1.4);

  for (let i = 0; i < stages; i++) {
    const remaining = c.base + total - y;
    if (remaining < c.fh * 1.5) break;
    const stageH = i === stages - 1 ? remaining : remaining * rng.range(0.34, 0.55);
    setWall(c, SURF.STONE, 1);
    mass(c, hw, hd, y, y + stageH, SURF.STONE);

    // Vertical piers: the deco trick of pulling the eye up. Continuous strips
    // of stone standing proud of the window bays, all the way to the setback.
    if (c.lod === 0) {
      const n = Math.max(3, Math.min(14, Math.round((hw * 2) / 3.6)));
      s.setSurface(SURF.STONE, c.fh, c.hash, 0).setColor(_trim.r, _trim.g, _trim.b);
      for (let k = 0; k <= n; k++) {
        const lx = -hw + ((hw * 2) * k) / n;
        s.box(wx(c, lx, -hd - 0.11), y + stageH * 0.5, wz(c, lx, -hd - 0.11), 0.34, stageH * 0.5, 0.13, c.yaw, c.base, 0b011111);
        s.box(wx(c, lx, hd + 0.11), y + stageH * 0.5, wz(c, lx, hd + 0.11), 0.34, stageH * 0.5, 0.13, c.yaw, c.base, 0b011111);
      }
    }
    y += stageH;
    // Stone band capping the stage, then the setback.
    cornice(c, y - 0.55, hw, hd, 0.3, 0.55);
    if (i < stages - 1) {
      flatRoof(c, y, hw, hd, 0, 0, "setback");
      parapet(c, y, hw, hd, 1.0, 0.28);
      hw *= rng.range(0.74, 0.88);
      hd *= rng.range(0.74, 0.88);
    }
  }

  const roofY = y;
  flatRoof(c, roofY, hw, hd);
  parapet(c, roofY, hw, hd, 1.2, 0.3);
  if (c.lod < 2) {
    // Ziggurat crown + spire — the 1930s silhouette.
    let ch = hw;
    let cd = hd;
    let cy = roofY;
    const steps = rng.int(2, 4);
    s.setSurface(SURF.STONE, c.fh, c.hash, 0).setColor(_trim.r, _trim.g, _trim.b);
    for (let i = 0; i < steps; i++) {
      const h = rng.range(1.6, 3.4);
      ch *= rng.range(0.6, 0.78);
      cd *= rng.range(0.6, 0.78);
      s.box(wx(c, 0, 0), cy + h * 0.5, wz(c, 0, 0), ch, h * 0.5, cd, c.yaw, c.base, 0b111111);
      cy += h;
    }
    const spire = rng.range(4, 16);
    s.setSurface(SURF.METAL, c.fh, c.hash, 0).setColor(0.32, 0.30, 0.26);
    s.cylinder(wx(c, 0, 0), cy, wz(c, 0, 0), Math.min(ch, cd) * 0.5, 0.06, spire, 8, c.base, true, false);
    c.top = Math.max(c.top, cy + spire);
    anchor(c, 0, cy + spire, 0);
  }
}

/* ------------------------------------------------------------------ *
 * Style: warehouse
 * ------------------------------------------------------------------ */

function genWarehouse(c: Ctx): void {
  const { rng } = c;
  const s = c.sink;
  const roofY = c.base + c.height;
  const surf = rng.chance(0.6) ? SURF.BRICK : SURF.CONCRETE;
  mass(c, c.hw, c.hd, c.base, roofY, surf);

  if (c.lod < 2) {
    // Loading dock: raised platform, roll-up doors, a canopy over them.
    const dockH = 1.15;
    s.setSurface(SURF.CONCRETE, c.fh, c.hash, 0).setColor(0.33, 0.325, 0.31);
    s.box(wx(c, 0, -c.hd - 1.5), c.base + dockH * 0.5, wz(c, 0, -c.hd - 1.5), c.hw * 0.85, dockH * 0.5, 1.5, c.yaw, c.base, 0b111111);
    const doors = Math.max(1, Math.min(5, Math.floor((c.hw * 2) / 5.5)));
    for (let i = 0; i < doors; i++) {
      const lx = -c.hw * 0.8 + ((i + 0.5) * (c.hw * 1.6)) / doors;
      rollUpDoor(c, lx, 3.2, 3.6);
    }
    s.setSurface(SURF.METAL, c.fh, c.hash, 0).setColor(_trim.r * 0.55, _trim.g * 0.55, _trim.b * 0.6);
    s.box(wx(c, 0, -c.hd - 1.2), c.base + 4.3, wz(c, 0, -c.hd - 1.2), c.hw * 0.9, 0.12, 1.3, c.yaw, c.base, 0b111111);

    // Monitor roof: a raised central strip with clerestory glazing on both
    // sides. Nineteenth-century daylighting, and a great grapple perch.
    const mw = c.hw * rng.range(0.3, 0.5);
    const mh = rng.range(1.6, 2.6);
    setWall(c, SURF.GLASS, 1, _trim);
    s.setSurface(SURF.GLASS, 2.4, c.hash, 1).setColor(0.09, 0.11, 0.12);
    s.box(wx(c, 0, 0), roofY + mh * 0.5, wz(c, 0, 0), mw, mh * 0.5, c.hd * 0.92, c.yaw, c.base, 0b001111);
    flatRoof(c, roofY + mh, mw, c.hd * 0.92);
  }

  cornice(c, roofY - 0.85, c.hw, c.hd, 0.35, 0.5, surf);
  flatRoof(c, roofY, c.hw, c.hd);
  parapet(c, roofY, c.hw, c.hd, 1.1, 0.34);
}

/* ------------------------------------------------------------------ *
 * Style: industrial
 * ------------------------------------------------------------------ */

function genIndustrial(c: Ctx): void {
  const { rng } = c;
  const s = c.sink;
  const roofY = c.base + c.height;
  mass(c, c.hw, c.hd, c.base, roofY, SURF.CORRUGATED);

  // Sawtooth roof: north-facing glazed faces, south-facing opaque slopes.
  const teeth = Math.max(2, Math.min(8, Math.round((c.hd * 2) / 7)));
  const pitch = (c.hd * 2) / teeth;
  const rise = pitch * 0.42;
  for (let i = 0; i < teeth; i++) {
    const z0 = -c.hd + i * pitch;
    const z1 = z0 + pitch;
    // Sloping opaque plane rising from z0 to z1.
    s.setSurface(SURF.CORRUGATED, c.fh, c.hash, 0).setColor(_roofC.r * 1.9 + 0.06, _roofC.g * 1.9 + 0.06, _roofC.b * 1.9 + 0.06);
    s.quad(
      wx(c, -c.hw, z0), roofY, wz(c, -c.hw, z0), 0, 0,
      wx(c, -c.hw, z1), roofY + rise, wz(c, -c.hw, z1), 0, Math.hypot(pitch, rise),
      wx(c, c.hw, z1), roofY + rise, wz(c, c.hw, z1), c.hw * 2, Math.hypot(pitch, rise),
      wx(c, c.hw, z0), roofY, wz(c, c.hw, z0), c.hw * 2, 0,
    );
    // Vertical clerestory dropping back down.
    s.setSurface(SURF.GLASS, 2.2, c.hash, 1).setColor(0.10, 0.12, 0.13);
    s.quad(
      wx(c, -c.hw, z1), roofY + rise, wz(c, -c.hw, z1), 0, rise,
      wx(c, c.hw, z1), roofY + rise, wz(c, c.hw, z1), c.hw * 2, rise,
      wx(c, c.hw, z1), roofY, wz(c, c.hw, z1), c.hw * 2, 0,
      wx(c, -c.hw, z1), roofY, wz(c, -c.hw, z1), 0, 0,
    );
    // End walls of the tooth.
    s.setSurface(SURF.CORRUGATED, c.fh, c.hash, 0).setColor(_wall.r, _wall.g, _wall.b);
    for (const sgn of [-1, 1]) {
      if (sgn < 0) {
        s.tri(
          wx(c, -c.hw, z0), roofY, wz(c, -c.hw, z0), 0, 0,
          wx(c, -c.hw, z1), roofY, wz(c, -c.hw, z1), pitch, 0,
          wx(c, -c.hw, z1), roofY + rise, wz(c, -c.hw, z1), pitch, rise,
        );
      } else {
        s.tri(
          wx(c, c.hw, z0), roofY, wz(c, c.hw, z0), 0, 0,
          wx(c, c.hw, z1), roofY + rise, wz(c, c.hw, z1), pitch, rise,
          wx(c, c.hw, z1), roofY, wz(c, c.hw, z1), pitch, 0,
        );
      }
    }
  }
  c.roofs.push({
    cx: wx(c, 0, 0), cy: roofY + rise * 0.5, cz: wz(c, 0, 0),
    hw: c.hw, hd: c.hd, yaw: c.yaw, kind: "sawtooth", walkable: false, dressed: true,
  });
  c.top = Math.max(c.top, roofY + rise);

  if (c.lod < 2) {
    const doors = Math.max(1, Math.min(4, Math.floor((c.hw * 2) / 6)));
    for (let i = 0; i < doors; i++) {
      rollUpDoor(c, -c.hw * 0.75 + ((i + 0.5) * (c.hw * 1.5)) / doors, 4.0, 4.4);
    }
    // Stack / vent pipe.
    if (rng.chance(0.6)) {
      const h = rng.range(4, 11);
      s.setSurface(SURF.METAL, c.fh, c.hash, 0).setColor(0.22, 0.20, 0.19);
      s.cylinder(wx(c, c.hw * 0.6, c.hd * 0.5), roofY + rise, wz(c, c.hw * 0.6, c.hd * 0.5), 0.42, 0.40, h, 8, c.base, true, false);
      c.top = Math.max(c.top, roofY + rise + h);
      anchor(c, c.hw * 0.6, roofY + rise + h, c.hd * 0.5);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Style: civic
 * ------------------------------------------------------------------ */

function genCivic(c: Ctx): void {
  const { rng } = c;
  const s = c.sink;
  const roofY = c.base + c.height;
  const baseH = Math.min(c.fh * 1.3, c.height * 0.3);

  // Rusticated base.
  mass(c, c.hw, c.hd, c.base, c.base + baseH, SURF.STONE, 0, 0, false, _trim);
  mass(c, c.hw, c.hd, c.base + baseH, roofY, SURF.STONE);

  if (c.lod < 2) {
    // Grand steps up to the portico.
    const steps = 7;
    s.setSurface(SURF.STONE, c.fh, c.hash, 0).setColor(_trim.r * 0.95, _trim.g * 0.95, _trim.b * 0.95);
    for (let i = 0; i < steps; i++) {
      const d = 0.36 * (steps - i);
      s.box(wx(c, 0, -c.hd - d * 0.5), c.base + (i * baseH) / steps * 0.5, wz(c, 0, -c.hd - d * 0.5), c.hw * 0.55, (i * baseH) / steps * 0.5 + 0.02, d * 0.5, c.yaw, c.base, 0b011111);
    }
    // Colonnade: real columns with a plinth and an entablature over them.
    const cols = Math.max(4, Math.min(12, Math.round((c.hw * 1.1) / 2.6)));
    const colH = c.height - baseH - 1.6;
    s.setSurface(SURF.STONE, c.fh, c.hash, 0).setColor(_trim.r, _trim.g, _trim.b);
    for (let i = 0; i < cols; i++) {
      const lx = -c.hw * 0.55 + ((i + 0.5) * (c.hw * 1.1)) / cols;
      s.cylinder(wx(c, lx, -c.hd - 1.5), c.base + baseH, wz(c, lx, -c.hd - 1.5), 0.5, 0.42, colH, 10, c.base, false, false);
      s.box(wx(c, lx, -c.hd - 1.5), c.base + baseH + colH + 0.2, wz(c, lx, -c.hd - 1.5), 0.62, 0.2, 0.62, c.yaw, c.base, 0b111111);
    }
    s.box(wx(c, 0, -c.hd - 1.5), c.base + baseH + colH + 0.85, wz(c, 0, -c.hd - 1.5), c.hw * 0.62, 0.65, 0.95, c.yaw, c.base, 0b111111);
    // Pediment: the triangle over the entrance.
    const pedR = c.hw * 0.24;
    const pedY = c.base + baseH + colH + 1.5;
    // Front tympanum faces the street; the rear one faces back into the block.
    s.tri(
      wx(c, -c.hw * 0.62, -c.hd - 2.4), pedY, wz(c, -c.hw * 0.62, -c.hd - 2.4), 0, 0,
      wx(c, 0, -c.hd - 2.4), pedY + pedR, wz(c, 0, -c.hd - 2.4), c.hw * 0.62, pedR,
      wx(c, c.hw * 0.62, -c.hd - 2.4), pedY, wz(c, c.hw * 0.62, -c.hd - 2.4), c.hw * 1.24, 0,
    );
    s.tri(
      wx(c, -c.hw * 0.62, -c.hd - 0.6), pedY, wz(c, -c.hw * 0.62, -c.hd - 0.6), 0, 0,
      wx(c, c.hw * 0.62, -c.hd - 0.6), pedY, wz(c, c.hw * 0.62, -c.hd - 0.6), c.hw * 1.24, 0,
      wx(c, 0, -c.hd - 0.6), pedY + pedR, wz(c, 0, -c.hd - 0.6), c.hw * 0.62, pedR,
    );
    c.top = Math.max(c.top, pedY + pedR);
  }

  cornice(c, roofY - 1.1, c.hw, c.hd, 0.6, 1.0);
  flatRoof(c, roofY, c.hw, c.hd);
  parapet(c, roofY, c.hw, c.hd, 1.0, 0.4);

  // A dome on the important ones.
  if (rng.chance(0.35) && c.lod < 2) {
    const r = Math.min(c.hw, c.hd) * rng.range(0.4, 0.6);
    const drumH = rng.range(3, 7);
    s.setSurface(SURF.STONE, c.fh, c.hash, 0.6).setColor(_trim.r, _trim.g, _trim.b);
    s.cylinder(wx(c, 0, 0), roofY, wz(c, 0, 0), r * 1.12, r * 1.12, drumH, 20, c.base, false, false);
    s.setSurface(SURF.METAL, c.fh, c.hash, 0).setColor(0.24, 0.36, 0.31);
    s.dome(wx(c, 0, 0), roofY + drumH, wz(c, 0, 0), r, r * 1.25, 20, 7, c.base);
    const lantern = r * 0.9;
    s.setSurface(SURF.STONE, c.fh, c.hash, 0).setColor(_trim.r, _trim.g, _trim.b);
    s.cylinder(wx(c, 0, 0), roofY + drumH + r * 1.25, wz(c, 0, 0), r * 0.22, r * 0.16, lantern, 10, c.base, true, false);
    c.top = Math.max(c.top, roofY + drumH + r * 1.25 + lantern);
    c.roofs.push({
      cx: wx(c, 0, 0), cy: roofY + drumH + r * 0.6, cz: wz(c, 0, 0),
      hw: r, hd: r, yaw: c.yaw, kind: "dome", walkable: false, dressed: true,
    });
    anchor(c, 0, roofY + drumH + r * 1.25 + lantern, 0);
  }
}

/* ------------------------------------------------------------------ *
 * Style: military (Presidio / Fort Mason)
 * ------------------------------------------------------------------ */

function genMilitary(c: Ctx): void {
  const { rng } = c;
  const s = c.sink;
  const roofY = c.base + c.height;
  mass(c, c.hw, c.hd, c.base, roofY, SURF.STUCCO);

  if (c.lod < 2) {
    // Full-width veranda with turned posts — the Presidio barracks signature.
    const vd = 1.9;
    s.setSurface(SURF.WOOD, c.fh, c.hash, 0).setColor(_trim.r * 0.9, _trim.g * 0.9, _trim.b * 0.9);
    s.box(wx(c, 0, -c.hd - vd * 0.5), c.base + 0.25, wz(c, 0, -c.hd - vd * 0.5), c.hw, 0.12, vd * 0.5, c.yaw, c.base, 0b111111);
    const posts = Math.max(3, Math.round((c.hw * 2) / 2.8));
    for (let i = 0; i <= posts; i++) {
      const lx = -c.hw + ((c.hw * 2) * i) / posts;
      s.box(wx(c, lx, -c.hd - vd), c.base + 1.65, wz(c, lx, -c.hd - vd), 0.09, 1.55, 0.09, c.yaw, c.base, 0b011111);
    }
    s.box(wx(c, 0, -c.hd - vd * 0.5), c.base + 3.3, wz(c, 0, -c.hd - vd * 0.5), c.hw, 0.14, vd * 0.5, c.yaw, c.base, 0b111111);
    if (c.floors > 1) {
      // Upper balcony.
      s.box(wx(c, 0, -c.hd - vd * 0.5), c.base + c.fh * 2 + 0.1, wz(c, 0, -c.hd - vd * 0.5), c.hw, 0.10, vd * 0.5, c.yaw, c.base, 0b111111);
    }
  }

  // Hipped clay-tile roof.
  const rise = Math.min(c.hd, 3.4);
  s.setSurface(SURF.TILE, c.fh, c.hash, 0).setColor(_roofC.r, _roofC.g, _roofC.b);
  const over = 0.55;
  const ridgeInset = Math.min(c.hd * 0.75, c.hw * 0.5);
  const rx = c.hw - ridgeInset;
  const pts: [number, number][] = [[-c.hw - over, -c.hd - over], [c.hw + over, -c.hd - over], [c.hw + over, c.hd + over], [-c.hw - over, c.hd + over]];
  const ridge: [number, number][] = [[-rx, 0], [rx, 0], [rx, 0], [-rx, 0]];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) & 3;
    const a = pts[i];
    const b = pts[j];
    const ra = ridge[i];
    const rb = ridge[j];
    const slope = Math.hypot(c.hd + over, rise);
    s.quad(
      wx(c, a[0], a[1]), roofY, wz(c, a[0], a[1]), 0, 0,
      wx(c, ra[0], ra[1]), roofY + rise, wz(c, ra[0], ra[1]), Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.5 - rx, slope,
      wx(c, rb[0], rb[1]), roofY + rise, wz(c, rb[0], rb[1]), Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.5 + rx, slope,
      wx(c, b[0], b[1]), roofY, wz(c, b[0], b[1]), Math.hypot(b[0] - a[0], b[1] - a[1]), 0,
    );
  }
  // Dormers on the street side.
  if (c.lod === 0 && c.hw > 5) {
    const n = Math.max(1, Math.round(c.hw / 3.4));
    for (let i = 0; i < n; i++) {
      const lx = -c.hw + ((i + 0.5) * (c.hw * 2)) / n;
      const dz = -c.hd * 0.55;
      s.setSurface(SURF.STUCCO, 2.4, c.hash, 1).setColor(_wall.r, _wall.g, _wall.b);
      s.box(wx(c, lx, dz), roofY + rise * 0.5, wz(c, lx, dz), 0.75, rise * 0.42, 0.8, c.yaw, c.base, 0b001111);
      s.setSurface(SURF.TILE, c.fh, c.hash, 0).setColor(_roofC.r, _roofC.g, _roofC.b);
      s.box(wx(c, lx, dz), roofY + rise * 0.92, wz(c, lx, dz), 0.9, 0.09, 0.95, c.yaw, c.base, 0b111111);
    }
  }
  c.roofs.push({
    cx: wx(c, 0, 0), cy: roofY + rise * 0.5, cz: wz(c, 0, 0),
    hw: c.hw, hd: c.hd, yaw: c.yaw, kind: "pitched", walkable: false, dressed: true,
  });
  c.top = Math.max(c.top, roofY + rise);
}

/* ------------------------------------------------------------------ *
 * LOD 2 — massing only
 * ------------------------------------------------------------------ */

/**
 * The far-but-still-real tier. One prism, one crown, one roof cap, and the
 * same shader, so a building does not change colour or window rhythm when it
 * crosses the LOD boundary — only its profile simplifies.
 */
function genCoarse(c: Ctx): void {
  const surf = WALL_SURFACE[c.style];
  const roofY = c.base + c.height;
  const skirtY = c.low - 1.5;
  mass(c, c.hw, c.hd, skirtY, roofY, surf);
  flatRoof(c, roofY, c.hw, c.hd);
  const tall = c.height > 55;
  if (tall) {
    const s = c.sink;
    s.setSurface(SURF.CONCRETE, c.fh, c.hash, 0).setColor(_trim.r * 0.8, _trim.g * 0.8, _trim.b * 0.8);
    const mh = Math.min(7, c.height * 0.06);
    s.box(wx(c, 0, 0), roofY + mh * 0.5, wz(c, 0, 0), c.hw * 0.55, mh * 0.5, c.hd * 0.55, c.yaw, c.base, 0b111111);
    c.top = Math.max(c.top, roofY + mh);
  }
}

/* ------------------------------------------------------------------ *
 * Height model
 * ------------------------------------------------------------------ */

/**
 * How tall does this parcel build?
 *
 * Zoning first (the district's range), then a power-law so most buildings sit
 * near the bottom of the range and a handful spike — that skew is what makes a
 * skyline instead of a plateau. Then: prominence (an arterial corner builds
 * taller than a mid-block back lot), parcel size (you cannot put a tower on a
 * 25-foot lot), and district influence so heights fall off toward the edges
 * rather than stepping at the district boundary.
 */
function chooseHeight(lot: Lot, rng: Rng, style: BuildingStyle, fh: number): number {
  const d = lot.district;
  const infl = clamp01(districtInfluence(lot.cx, lot.cz, d) * 1.15);
  const area = lot.hw * lot.hd * 4;

  let lo = d.minHeight;
  let hi = d.maxHeight;

  // A style caps its own plausible height regardless of zoning: a Victorian is
  // never 60 m and a curtain-wall tower is never 9 m.
  switch (style) {
    case "victorian": lo = Math.max(lo, 7.2); hi = Math.min(hi, 13.5); break;
    case "stucco-row": lo = Math.max(lo, 6.5); hi = Math.min(hi, 11.5); break;
    case "edwardian-apartment": lo = Math.max(lo, 9); hi = Math.min(hi, 26); break;
    case "midrise-brick": lo = Math.max(lo, 11); hi = Math.min(hi, 58); break;
    case "warehouse": lo = Math.max(lo, 8); hi = Math.min(hi, 22); break;
    case "industrial": lo = Math.max(lo, 7); hi = Math.min(hi, 18); break;
    case "military": lo = Math.max(lo, 7); hi = Math.min(hi, 13); break;
    case "civic": lo = Math.max(lo, 16); hi = Math.min(hi, 74); break;
    case "highrise-deco": lo = Math.max(lo, 34); break;
    case "highrise-glass": lo = Math.max(lo, 30); break;
  }
  if (hi < lo) hi = lo * 1.2;

  // Power-law skew. Bigger exponent = more low buildings, rarer spikes.
  const t = Math.pow(rng.next(), 2.6);
  let h = mix(lo, hi, t);

  // A tower needs a footprint. 800 m² is roughly the smallest real SF tower site.
  const areaCap = 12 + Math.pow(clamp(area, 40, 4000), 0.63) * 1.35;
  h = Math.min(h, areaCap);

  h *= mix(0.72, 1.0, infl);
  h *= mix(0.86, 1.16, lot.prominence);
  if (lot.corner) h *= rng.range(1.0, 1.18);

  const floors = Math.max(1, Math.round(h / fh));
  return floors * fh;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

let nextBuildingId = 1;

/**
 * Generate one building from one parcel.
 *
 * @param lod      0 = full detail, 1 = medium, 2 = massing only
 * @param originX  chunk origin; geometry is written in chunk-local X/Z
 * @returns the record for the spatial index, or null if nothing was built
 */
export function generateBuilding(
  lot: Lot,
  sink: GeoSink,
  lod: number,
  originX: number,
  originZ: number,
): BuildingRecord | null {
  const rng = makeRng(lot.seed);
  // 70 % of a block follows the block's dominant style; the rest is the
  // in-fill that every real block has.
  let style = lot.blockStyle;
  if (rng.chance(0.3)) {
    const d = lot.district;
    style = d.styles[rng.int(0, d.styles.length - 1)];
  }
  const fh = FLOOR_HEIGHT[style];
  const height = chooseHeight(lot, rng, style, fh);
  if (height < 2.5) return null;

  pickColors(lot, rng, style);

  const c: Ctx = {
    lot,
    rng,
    sink,
    lod,
    style,
    ox: lot.cx - originX,
    oz: lot.cz - originZ,
    yaw: lot.yaw,
    cosY: Math.cos(lot.yaw),
    sinY: Math.sin(lot.yaw),
    hw: lot.hw,
    hd: lot.hd,
    base: lot.groundHigh + 0.16,
    low: lot.groundLow,
    fh,
    floors: Math.max(1, Math.round(height / fh)),
    height,
    hash: (lot.seed % 1024) / 1024,
    winFront: 1,
    winBack: lot.alley ? 0.8 : 0.55,
    winSide: 0.85,
    roofs: [],
    top: 0,
  };
  c.top = c.base + height;

  _anchors.length = 0;

  emitSkirt(c);

  if (lod >= 2) {
    genCoarse(c);
  } else {
    switch (style) {
      case "victorian": genVictorian(c); break;
      case "edwardian-apartment": genEdwardian(c); break;
      case "stucco-row": genStuccoRow(c); break;
      case "midrise-brick": genMidriseBrick(c); break;
      case "highrise-glass": genHighriseGlass(c); break;
      case "highrise-deco": genHighriseDeco(c); break;
      case "warehouse": genWarehouse(c); break;
      case "industrial": genIndustrial(c); break;
      case "civic": genCivic(c); break;
      case "military": genMilitary(c); break;
      default: genCoarse(c); break;
    }
  }

  // World-space AABB from the rotated footprint plus the deepest projection
  // (bays and cornices push ~1 m past the property line).
  const ext = 1.3;
  const ax = Math.abs(c.cosY) * (lot.hw + ext) + Math.abs(c.sinY) * (lot.hd + ext);
  const az = Math.abs(c.sinY) * (lot.hw + ext) + Math.abs(c.cosY) * (lot.hd + ext);

  const rec: BuildingRecord = {
    id: nextBuildingId++,
    style,
    districtKey: lot.district.key,
    cx: lot.cx,
    cz: lot.cz,
    yaw: lot.yaw,
    hw: lot.hw,
    hd: lot.hd,
    baseY: c.base,
    roofY: c.base + height,
    topY: Math.max(c.top, c.base + height),
    minX: lot.cx - ax,
    maxX: lot.cx + ax,
    minZ: lot.cz - az,
    maxZ: lot.cz + az,
    roofs: c.roofs,
    anchors: new Float32Array(_anchors),
  };
  // Anchors were written in chunk-local space; the index wants world.
  for (let i = 0; i < rec.anchors.length; i += 3) {
    rec.anchors[i] += originX;
    rec.anchors[i + 2] += originZ;
  }
  void _tmp;
  return rec;
}
