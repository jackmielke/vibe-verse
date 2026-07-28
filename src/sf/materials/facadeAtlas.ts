/**
 * facadeAtlas — procedural building-facade atlases for
 * San Francisco: FREE FALL.
 *
 * A city generator can produce a hundred thousand boxes. What decides whether
 * they read as *buildings* is entirely what is painted on them: the window
 * proportions of the era, the sill and lintel that catch the sun, the cornice
 * that terminates the wall, the fire escape hanging off the front, and the
 * ground floor that is always a different animal from everything above it.
 * This module bakes all of that per `BuildingStyle` from `sfGeo`.
 *
 * Layout contract
 * ---------------
 * Each style gets one atlas, divided into `cols` full-height **panels**. A
 * panel is a complete facade slice, drawn bottom-up:
 *
 *      +-----------------+  <- top of texture (v = 1)
 *      |     crown       |    cornice / parapet / mechanical band
 *      +-----------------+
 *      |    typical      |    N identical floors — TILES VERTICALLY
 *      +-----------------+
 *      |     ground      |    retail / garage / stoop / lobby
 *      +-----------------+  <- v = 0, sits on the pavement
 *
 * A panel spans `bays * bayWidth` metres horizontally and tiles horizontally,
 * because every window is centred in its bay slot so the panel edges land
 * mid-pier.
 *
 * The building generator is expected to emit a small grid of quads per wall:
 * one row of quads for the ground band, `ceil(floors / typicalFloors)` rows
 * mapped to the `typical` rect, and one row for the crown — repeating
 * horizontally every `panelWidth` metres. That is four extra quads per wall and
 * it buys correct proportions at every building height, which no single
 * stretched texture can give you.
 *
 * Resolution: at High a panel is 512 px across 6.4 m, i.e. ~1.25 cm per texel.
 * That is enough to draw individual bricks and window muntins rather than
 * suggesting them, which is the whole point.
 */
import * as THREE from "three";
import { QUALITY, type QualityTier } from "../config";
import type { BuildingStyle } from "../geo/sfGeo";
import { clamp01, makeRng, type Rng } from "../math/rng";
import {
  aoFromHeight,
  fbmField,
  flipRaster,
  grimeField,
  makeSurface,
  normalFromHeight,
  packORM,
  rasterTexture,
  streakField,
  surfaceToField,
  type Ctx2D,
  type Field,
  type Surface,
} from "./textureGen";
import { applyDetailBlend } from "./triplanar";
import { getMacroVariationTexture } from "./materialLibrary";

/* ================================================================== *
 * Public shapes
 * ================================================================== */

/** A rectangle in atlas UV space (origin bottom-left, matching three's uv). */
export interface FacadeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FacadeVariant {
  index: number;
  style: BuildingStyle;
  /** The whole panel. */
  rect: FacadeRect;
  /** Ground-floor band. Map the building's ground storey to this. */
  ground: FacadeRect;
  /** Repeating storeys. Tiles vertically with a period of `typicalFloors`. */
  typical: FacadeRect;
  /** Cornice / parapet. Map the top of the wall to this. */
  crown: FacadeRect;
  /** Metres the panel spans horizontally; tiles at this pitch. */
  panelWidth: number;
  /** Metres represented by each band. */
  groundHeight: number;
  floorHeight: number;
  typicalFloors: number;
  crownHeight: number;
  bays: number;
  hasFireEscape: boolean;
  /** Base wall colour used for this variant — match it to a district palette. */
  wallColor: number;
}

export interface FacadeAtlas {
  style: BuildingStyle;
  tier: QualityTier;
  size: number;
  cols: number;
  variants: FacadeVariant[];
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  /** ao(.r) / roughness(.g) / metalness(.b). */
  ormMap: THREE.DataTexture;
  /** Night windows. Half resolution — window light has no high frequencies. */
  emissiveMap: THREE.DataTexture;
  dispose(): void;
}

export const FACADE_STYLES: BuildingStyle[] = [
  "highrise-glass",
  "highrise-deco",
  "midrise-brick",
  "victorian",
  "edwardian-apartment",
  "stucco-row",
  "industrial",
  "civic",
  "warehouse",
  "military",
];

/* ================================================================== *
 * Style specifications
 * ================================================================== */

type WallKind = "brick" | "stucco" | "clapboard" | "stone" | "concrete" | "metal" | "curtain";
type WindowKind =
  | "double-hung"
  | "steel-sash"
  | "picture"
  | "arched"
  | "bay"
  | "casement"
  | "ribbon";
type CorniceKind = "dentil" | "bracket" | "parapet" | "deco" | "gable" | "flat" | "mechanical";
type GroundKind = "retail" | "garage" | "stoop" | "lobby" | "dock" | "colonnade";

interface StyleSpec {
  bays: number;
  floorHeight: number;
  groundHeight: number;
  minCrown: number;
  wall: WallKind;
  window: WindowKind;
  /** Window opening as a fraction of the bay width / floor height. */
  winW: number;
  winH: number;
  sill: boolean;
  lintel: "none" | "flat" | "stone" | "arch";
  cornice: CorniceKind;
  fireEscape: boolean;
  ground: GroundKind;
  /** Per-variant wall colours. */
  wallColors: number[];
  trimColor: number;
  sashColor: number;
  glassColor: number;
  /** Base roughness of the wall. */
  wallRough: number;
  /** Fraction of windows lit at night. */
  nightLit: number;
}

/** Every panel is 6.4 m wide; the atlas aspect fixes that (see header). */
const PANEL_WIDTH = 6.4;
const PANEL_HEIGHT = 12.8;

const SPECS: Record<BuildingStyle, StyleSpec> = {
  "highrise-glass": {
    bays: 4,
    floorHeight: 3.9,
    groundHeight: 6.0,
    minCrown: 1.6,
    wall: "curtain",
    window: "ribbon",
    winW: 0.94,
    winH: 0.72,
    sill: false,
    lintel: "none",
    cornice: "mechanical",
    fireEscape: false,
    ground: "lobby",
    wallColors: [0x8f9aa4, 0x76828d],
    trimColor: 0x2f3438,
    sashColor: 0x3a4046,
    glassColor: 0x18262c,
    wallRough: 0.28,
    nightLit: 0.62,
  },
  "highrise-deco": {
    bays: 3,
    floorHeight: 3.5,
    groundHeight: 5.6,
    minCrown: 1.8,
    wall: "stone",
    window: "casement",
    winW: 0.6,
    winH: 0.66,
    sill: true,
    lintel: "stone",
    cornice: "deco",
    fireEscape: false,
    ground: "colonnade",
    wallColors: [0xc4bba6, 0xa89e8b],
    trimColor: 0x8d8471,
    sashColor: 0x4a4640,
    glassColor: 0x1c2226,
    wallRough: 0.68,
    nightLit: 0.55,
  },
  "midrise-brick": {
    bays: 2,
    floorHeight: 3.3,
    groundHeight: 4.4,
    minCrown: 1.2,
    wall: "brick",
    window: "double-hung",
    winW: 0.52,
    winH: 0.62,
    sill: true,
    lintel: "flat",
    cornice: "dentil",
    fireEscape: true,
    ground: "retail",
    wallColors: [0x8a4634, 0x6f3c2f],
    trimColor: 0xd8d2c4,
    sashColor: 0x3b3630,
    glassColor: 0x1a1f22,
    wallRough: 0.86,
    nightLit: 0.6,
  },
  victorian: {
    bays: 2,
    floorHeight: 3.4,
    groundHeight: 4.2,
    minCrown: 1.0,
    wall: "clapboard",
    window: "bay",
    winW: 0.72,
    winH: 0.7,
    sill: true,
    lintel: "flat",
    cornice: "gable",
    fireEscape: false,
    ground: "stoop",
    wallColors: [0xe8dcc2, 0xd7e0e8],
    trimColor: 0xf4efe4,
    sashColor: 0x8a3a34,
    glassColor: 0x1b2124,
    wallRough: 0.5,
    nightLit: 0.58,
  },
  "edwardian-apartment": {
    bays: 2,
    floorHeight: 3.2,
    groundHeight: 4.0,
    minCrown: 1.1,
    wall: "stucco",
    window: "double-hung",
    winW: 0.56,
    winH: 0.64,
    sill: true,
    lintel: "flat",
    cornice: "bracket",
    fireEscape: true,
    ground: "stoop",
    wallColors: [0xe0d8c8, 0xcabda6],
    trimColor: 0xf0ebe0,
    sashColor: 0x4a443c,
    glassColor: 0x1a2023,
    wallRough: 0.78,
    nightLit: 0.56,
  },
  "stucco-row": {
    bays: 2,
    floorHeight: 3.0,
    groundHeight: 3.6,
    minCrown: 0.8,
    wall: "stucco",
    window: "picture",
    winW: 0.66,
    winH: 0.54,
    sill: true,
    lintel: "none",
    cornice: "parapet",
    fireEscape: false,
    ground: "garage",
    wallColors: [0xece4d6, 0xd8cdb8],
    trimColor: 0xf6f2e8,
    sashColor: 0x5c564c,
    glassColor: 0x1c2225,
    wallRough: 0.8,
    nightLit: 0.5,
  },
  industrial: {
    bays: 2,
    floorHeight: 4.0,
    groundHeight: 4.6,
    minCrown: 0.9,
    wall: "brick",
    window: "steel-sash",
    winW: 0.78,
    winH: 0.7,
    sill: true,
    lintel: "stone",
    cornice: "parapet",
    fireEscape: true,
    ground: "dock",
    wallColors: [0x7d5040, 0x8b8b84],
    trimColor: 0x9a9184,
    sashColor: 0x40453f,
    glassColor: 0x232a2c,
    wallRough: 0.88,
    nightLit: 0.34,
  },
  civic: {
    bays: 2,
    floorHeight: 4.6,
    groundHeight: 5.6,
    minCrown: 1.8,
    wall: "stone",
    window: "arched",
    winW: 0.5,
    winH: 0.7,
    sill: true,
    lintel: "arch",
    cornice: "dentil",
    fireEscape: false,
    ground: "colonnade",
    wallColors: [0xdfd8c8, 0xcabfa9],
    trimColor: 0xefe9dc,
    sashColor: 0x4c4740,
    glassColor: 0x1a2023,
    wallRough: 0.6,
    nightLit: 0.42,
  },
  warehouse: {
    bays: 2,
    floorHeight: 4.2,
    groundHeight: 5.0,
    minCrown: 0.8,
    wall: "concrete",
    window: "steel-sash",
    winW: 0.82,
    winH: 0.66,
    sill: false,
    lintel: "flat",
    cornice: "parapet",
    fireEscape: false,
    ground: "dock",
    wallColors: [0x9a958a, 0xaba193],
    trimColor: 0x8a857a,
    sashColor: 0x44483f,
    glassColor: 0x222a2b,
    wallRough: 0.86,
    nightLit: 0.3,
  },
  military: {
    bays: 2,
    floorHeight: 3.1,
    groundHeight: 3.4,
    minCrown: 0.9,
    wall: "clapboard",
    window: "double-hung",
    winW: 0.5,
    winH: 0.58,
    sill: true,
    lintel: "flat",
    cornice: "flat",
    fireEscape: false,
    ground: "stoop",
    wallColors: [0xe8e2d4, 0xd6cfbe],
    trimColor: 0xf4f0e6,
    sashColor: 0x3e4a3c,
    glassColor: 0x1b2124,
    wallRough: 0.62,
    nightLit: 0.3,
  },
};

/* ================================================================== *
 * Drawing plumbing
 * ================================================================== */

interface Layers {
  size: number;
  alb: Surface;
  hgt: Surface;
  rgh: Surface;
  ems: Surface;
}

function css(hex: number, alpha = 1): string {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

function shade(hex: number, f: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((hex >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((hex >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((hex & 255) * f)));
  return (r << 16) | (g << 8) | b;
}

function gray(v: number): string {
  const n = Math.round(clamp01(v) * 255);
  return `rgb(${n},${n},${n})`;
}

/** Paint one rectangle across the albedo, height and roughness layers. */
function box(
  L: Layers,
  x: number,
  y: number,
  w: number,
  h: number,
  color: number,
  height: number,
  rough: number,
  alpha = 1,
): void {
  L.alb.ctx.fillStyle = css(color, alpha);
  L.alb.ctx.fillRect(x, y, w, h);
  if (alpha >= 1) {
    L.hgt.ctx.fillStyle = gray(height);
    L.hgt.ctx.fillRect(x, y, w, h);
    L.rgh.ctx.fillStyle = gray(rough);
    L.rgh.ctx.fillRect(x, y, w, h);
  }
}

/** Albedo-only overlay, for shading and dirt that must not disturb relief. */
function tint(
  L: Layers,
  x: number,
  y: number,
  w: number,
  h: number,
  color: number,
  alpha: number,
): void {
  L.alb.ctx.fillStyle = css(color, alpha);
  L.alb.ctx.fillRect(x, y, w, h);
}

function emissive(L: Layers, x: number, y: number, w: number, h: number, color: number): void {
  L.ems.ctx.fillStyle = css(color);
  L.ems.ctx.fillRect(x, y, w, h);
}

/** Vertical gradient on the albedo — glass reflections, awning shading. */
function vgrad(
  L: Layers,
  x: number,
  y: number,
  w: number,
  h: number,
  top: number,
  bottom: number,
): void {
  const ctx = L.alb.ctx as Ctx2D;
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, css(top));
  g.addColorStop(1, css(bottom));
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

/* ================================================================== *
 * Wall surfaces
 * ================================================================== */

function paintWall(
  L: Layers,
  x: number,
  y: number,
  w: number,
  h: number,
  spec: StyleSpec,
  color: number,
  pxPerM: number,
  rng: Rng,
): void {
  box(L, x, y, w, h, color, 0.62, spec.wallRough);
  const ctx = L.alb.ctx;
  const hctx = L.hgt.ctx;

  switch (spec.wall) {
    case "brick": {
      // Real coursing: 67 mm courses, 204 mm bricks, running bond. At the
      // resolutions we bake this is 5-6 px tall and 13 px wide, so it is drawn
      // rather than implied.
      const ch = 0.067 * pxPerM;
      const bw = 0.204 * pxPerM;
      const mortar = Math.max(0.8, 0.01 * pxPerM);
      const rows = Math.ceil(h / ch);
      for (let r = 0; r < rows; r++) {
        const by = y + r * ch;
        const off = (r & 1) * bw * 0.5;
        for (let bx = x - bw; bx < x + w; bx += bw) {
          const px = bx + off;
          const v = rng.next();
          const c = shade(color, 0.82 + v * 0.36);
          ctx.fillStyle = css(c);
          ctx.fillRect(px + mortar, by + mortar, bw - mortar, ch - mortar);
        }
        // Bed joint: recessed and much lighter than people expect.
        ctx.fillStyle = css(0xb0aa9c, 0.55);
        ctx.fillRect(x, by, w, mortar);
        hctx.fillStyle = gray(0.42);
        hctx.fillRect(x, by, w, mortar);
      }
      break;
    }
    case "clapboard": {
      // 150 mm exposure. The hard shadow under each lap is the whole read.
      const bh = 0.15 * pxPerM;
      for (let by = y; by < y + h; by += bh) {
        const v = rng.next();
        ctx.fillStyle = css(shade(color, 0.95 + v * 0.1));
        ctx.fillRect(x, by, w, bh);
        // Face ramps outward toward the lower edge, then drops.
        const g = (hctx as Ctx2D).createLinearGradient(0, by, 0, by + bh);
        g.addColorStop(0, gray(0.5));
        g.addColorStop(0.88, gray(0.78));
        g.addColorStop(1, gray(0.34));
        hctx.fillStyle = g;
        hctx.fillRect(x, by, w, bh);
        ctx.fillStyle = css(0x000000, 0.16);
        ctx.fillRect(x, by + bh - Math.max(1, bh * 0.09), w, Math.max(1, bh * 0.09));
      }
      break;
    }
    case "stone": {
      // Ashlar coursing, 600 x 300, with a fine drafted margin.
      const ch = 0.3 * pxPerM;
      const bw = 0.6 * pxPerM;
      const joint = Math.max(0.7, 0.008 * pxPerM);
      let r = 0;
      for (let by = y; by < y + h; by += ch, r++) {
        const off = (r & 1) * bw * 0.5;
        for (let bx = x - bw; bx < x + w; bx += bw) {
          const v = rng.next();
          ctx.fillStyle = css(shade(color, 0.93 + v * 0.14));
          ctx.fillRect(bx + off + joint, by + joint, bw - joint * 2, ch - joint * 2);
        }
        hctx.fillStyle = gray(0.46);
        hctx.fillRect(x, by, w, joint);
      }
      break;
    }
    case "concrete": {
      // Precast panels with a shadow gap.
      const pw = 2.4 * pxPerM;
      const ph = 1.2 * pxPerM;
      for (let by = y; by < y + h; by += ph) {
        for (let bx = x; bx < x + w; bx += pw) {
          const v = rng.next();
          ctx.fillStyle = css(shade(color, 0.95 + v * 0.1));
          ctx.fillRect(bx, by, pw - 1, ph - 1);
        }
        hctx.fillStyle = gray(0.42);
        hctx.fillRect(x, by, w, Math.max(1, 0.014 * pxPerM));
      }
      break;
    }
    case "metal": {
      const flute = 0.17 * pxPerM;
      for (let bx = x; bx < x + w; bx += flute) {
        const g = (hctx as Ctx2D).createLinearGradient(bx, 0, bx + flute, 0);
        g.addColorStop(0, gray(0.85));
        g.addColorStop(0.5, gray(0.3));
        g.addColorStop(1, gray(0.85));
        hctx.fillStyle = g;
        hctx.fillRect(bx, y, flute, h);
        ctx.fillStyle = css(0x000000, 0.1);
        ctx.fillRect(bx + flute * 0.45, y, flute * 0.18, h);
      }
      break;
    }
    case "curtain":
    case "stucco":
    default:
      // Flat base; the grain pass at the end supplies the tooth.
      break;
  }
}

/* ================================================================== *
 * Windows
 * ================================================================== */

interface WinCtx {
  spec: StyleSpec;
  pxPerM: number;
  rng: Rng;
  litChance: number;
}

function drawWindow(
  L: Layers,
  x: number,
  y: number,
  w: number,
  h: number,
  wc: WinCtx,
): void {
  const { spec, pxPerM, rng } = wc;
  const ctx = L.alb.ctx;
  const frame = Math.max(1, 0.045 * pxPerM);

  // Reveal: the opening sits back in the wall, and that shadow is what makes a
  // punched window read as a hole rather than a sticker.
  box(L, x - frame * 0.5, y - frame * 0.5, w + frame, h + frame, shade(spec.trimColor, 0.7), 0.34, spec.wallRough);

  // Head detail.
  if (spec.lintel === "stone") {
    box(L, x - frame * 1.6, y - frame * 2.4, w + frame * 3.2, frame * 2.2, spec.trimColor, 0.86, 0.62);
  } else if (spec.lintel === "flat") {
    box(L, x - frame, y - frame * 1.6, w + frame * 2, frame * 1.5, shade(spec.trimColor, 0.92), 0.8, 0.55);
  } else if (spec.lintel === "arch") {
    // Segmental arch drawn as voussoirs.
    const n = 7;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const ax = x + t * w - w / (n * 2);
      const rise = Math.sin(t * Math.PI) * frame * 2.2;
      box(L, ax, y - frame * 1.2 - rise, w / n + 1, frame * 1.4 + rise, shade(spec.trimColor, 0.96), 0.84, 0.6);
    }
  }

  // Glass. A window is never a flat dark rectangle: it is a dark interior with
  // a bright sky gradient reflected off the top of the pane.
  const gx = x + frame;
  const gy = y + frame;
  const gw = w - frame * 2;
  const gh = h - frame * 2;
  box(L, gx, gy, gw, gh, spec.glassColor, 0.3, 0.08);
  const skyTop = shade(0x6f8ba4, 0.75 + rng.next() * 0.5);
  vgrad(L, gx, gy, gw, gh * 0.55, skyTop, spec.glassColor);
  // A slanted highlight where the pane catches the sun.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(gx, gy + gh * 0.75);
  ctx.lineTo(gx + gw * 0.55, gy);
  ctx.lineTo(gx + gw, gy);
  ctx.lineTo(gx + gw, gy + gh * 0.18);
  ctx.lineTo(gx, gy + gh * 0.95);
  ctx.closePath();
  ctx.fillStyle = css(0xa8bccd, 0.14 + rng.next() * 0.12);
  ctx.fill();
  ctx.restore();

  // Sash and muntins by era.
  const bar = Math.max(1, 0.03 * pxPerM);
  ctx.fillStyle = css(spec.sashColor);
  const hctx = L.hgt.ctx;
  hctx.fillStyle = gray(0.6);
  const rctx = L.rgh.ctx;
  rctx.fillStyle = gray(0.4);
  const barRect = (bx: number, by: number, bw: number, bh: number) => {
    ctx.fillRect(bx, by, bw, bh);
    hctx.fillRect(bx, by, bw, bh);
    rctx.fillRect(bx, by, bw, bh);
  };
  // Outer sash always.
  barRect(gx, gy, gw, bar);
  barRect(gx, gy + gh - bar, gw, bar);
  barRect(gx, gy, bar, gh);
  barRect(gx + gw - bar, gy, bar, gh);

  switch (spec.window) {
    case "double-hung": {
      // Meeting rail plus a vertical muntin in each sash: the classic 2-over-2.
      barRect(gx, gy + gh * 0.5 - bar, gw, bar * 2);
      barRect(gx + gw * 0.5 - bar * 0.5, gy, bar, gh * 0.5);
      barRect(gx + gw * 0.5 - bar * 0.5, gy + gh * 0.5, bar, gh * 0.5);
      break;
    }
    case "steel-sash": {
      // Industrial multi-light: a fine grid, and the reason a warehouse reads
      // as a warehouse from 300 m.
      const cx = 4;
      const cy = 5;
      for (let i = 1; i < cx; i++) barRect(gx + (gw * i) / cx, gy, Math.max(1, bar * 0.6), gh);
      for (let j = 1; j < cy; j++) barRect(gx, gy + (gh * j) / cy, gw, Math.max(1, bar * 0.6));
      break;
    }
    case "casement": {
      barRect(gx + gw * 0.5 - bar * 0.5, gy, bar, gh);
      barRect(gx, gy + gh * 0.62, gw, bar);
      break;
    }
    case "arched": {
      barRect(gx + gw * 0.5 - bar * 0.5, gy, bar, gh);
      barRect(gx, gy + gh * 0.28, gw, bar);
      break;
    }
    case "bay":
    case "picture": {
      // Single large light with a narrow transom above.
      barRect(gx, gy + gh * 0.22, gw, bar);
      break;
    }
    case "ribbon":
    default:
      break;
  }

  // Sill: proud, light, and the source of every streak below it.
  if (spec.sill) {
    const sh = Math.max(1.5, 0.07 * pxPerM);
    box(L, x - frame * 1.4, y + h, w + frame * 2.8, sh, spec.trimColor, 0.9, 0.55);
    // Drip shadow directly under the sill.
    tint(L, x - frame * 1.4, y + h + sh, w + frame * 2.8, sh * 0.7, 0x000000, 0.2);
  }
}

/** The same window, but glowing. Drawn into the emissive layer only. */
function drawWindowLit(
  L: Layers,
  x: number,
  y: number,
  w: number,
  h: number,
  wc: WinCtx,
): void {
  const { rng, pxPerM } = wc;
  if (rng.next() > wc.litChance) return;
  const frame = Math.max(1, 0.045 * pxPerM);
  const gx = x + frame;
  const gy = y + frame;
  const gw = w - frame * 2;
  const gh = h - frame * 2;
  // Colour temperature: offices run cool, flats run warm, and a few are lit by
  // a television.
  const roll = rng.next();
  const base = roll < 0.55 ? 0xffd9a2 : roll < 0.86 ? 0xf2ece0 : 0xbcd6ff;
  const k = 0.42 + rng.next() * 0.58;
  const ctx = L.ems.ctx as Ctx2D;
  const g = ctx.createLinearGradient(gx, gy, gx, gy + gh);
  g.addColorStop(0, css(shade(base, k * 1.15)));
  g.addColorStop(1, css(shade(base, k * 0.45)));
  ctx.fillStyle = g;
  ctx.fillRect(gx, gy, gw, gh);
  // Blinds, or a silhouette in the window — anything but a uniform rectangle.
  if (rng.next() < 0.4) {
    const slats = 6 + Math.floor(rng.next() * 6);
    ctx.fillStyle = css(0x000000, 0.55);
    for (let i = 0; i < slats; i++) {
      ctx.fillRect(gx, gy + (gh * i) / slats, gw, Math.max(1, gh / slats / 2.6));
    }
  } else if (rng.next() < 0.3) {
    ctx.fillStyle = css(0x000000, 0.7);
    const bwid = gw * (0.12 + rng.next() * 0.14);
    ctx.fillRect(gx + rng.next() * (gw - bwid), gy + gh * 0.35, bwid, gh * 0.65);
  }
}

/* ================================================================== *
 * Ground floor
 * ================================================================== */

function drawGround(
  L: Layers,
  x: number,
  y: number,
  w: number,
  h: number,
  spec: StyleSpec,
  color: number,
  pxPerM: number,
  rng: Rng,
): void {
  const m = pxPerM;
  switch (spec.ground) {
    case "retail": {
      // Bulkhead, storefront glazing, transom, sign band, awning. The awning is
      // the single most valuable object on a street: it puts saturated colour
      // and a hard cast shadow at eye level.
      const signH = 0.75 * m;
      const bulk = 0.6 * m;
      box(L, x, y, w, signH, shade(color, 0.9), 0.7, spec.wallRough);
      // Sign: abstract letterforms. Deliberately not real text — glyph metrics
      // differ between machines and the screenshot harness must be bit-stable.
      const words = 1 + Math.floor(rng.next() * 2);
      const signColor = [0x2b3d4f, 0x5a2027, 0x1f4034, 0x4a3a1c][Math.floor(rng.next() * 4)];
      box(L, x + w * 0.08, y + signH * 0.18, w * 0.84, signH * 0.64, signColor, 0.74, 0.4);
      let cx = x + w * 0.14;
      for (let k = 0; k < words * 5; k++) {
        const gw2 = m * (0.09 + rng.next() * 0.11);
        if (cx + gw2 > x + w * 0.86) break;
        box(L, cx, y + signH * 0.32, gw2, signH * 0.34, 0xe8dfc8, 0.76, 0.35);
        cx += gw2 + m * 0.06;
      }
      const glassTop = y + signH;
      const glassH = h - signH - bulk;
      box(L, x, glassTop, w, glassH, spec.glassColor, 0.3, 0.09);
      vgrad(L, x, glassTop, w, glassH * 0.7, 0x76909f, spec.glassColor);
      // Interior clutter suggested with dark and warm blocks behind the glass.
      for (let k = 0; k < 5; k++) {
        const bw2 = w * (0.08 + rng.next() * 0.16);
        const bh2 = glassH * (0.2 + rng.next() * 0.4);
        tint(L, x + rng.next() * (w - bw2), glassTop + glassH - bh2, bw2, bh2, rng.next() < 0.5 ? 0x1a1512 : 0x6b563a, 0.5);
      }
      // Mullions and door.
      const bays = 3;
      for (let i = 1; i < bays; i++) {
        box(L, x + (w * i) / bays - m * 0.03, glassTop, m * 0.06, glassH, spec.sashColor, 0.62, 0.4);
      }
      const dw = w * 0.22;
      const dx = x + w * 0.62;
      box(L, dx, glassTop + glassH * 0.1, dw, glassH * 0.9, shade(spec.sashColor, 1.2), 0.56, 0.4);
      box(L, dx + m * 0.06, glassTop + glassH * 0.16, dw - m * 0.12, glassH * 0.66, spec.glassColor, 0.5, 0.1);
      box(L, x, y + h - bulk, w, bulk, shade(spec.trimColor, 0.6), 0.68, 0.7);
      // Awning over the shopfront.
      if (rng.next() < 0.75) {
        const ac = [0x7a2b2b, 0x1f4a3c, 0x24405e, 0x6d5320][Math.floor(rng.next() * 4)];
        const ah = 0.55 * m;
        const ay = glassTop + 0.1 * m;
        vgrad(L, x, ay, w, ah, shade(ac, 1.25), shade(ac, 0.72));
        L.hgt.ctx.fillStyle = gray(0.94);
        L.hgt.ctx.fillRect(x, ay, w, ah);
        L.rgh.ctx.fillStyle = gray(0.78);
        L.rgh.ctx.fillRect(x, ay, w, ah);
        // Stripes and a scalloped valance.
        for (let sx = x; sx < x + w; sx += m * 0.28) {
          tint(L, sx, ay, m * 0.14, ah, 0xffffff, 0.16);
        }
        tint(L, x, ay + ah, w, m * 0.5, 0x000000, 0.3);
      }
      break;
    }
    case "garage": {
      // The Sunset in one image: a roll-up door and a door beside it.
      const dw = w * 0.58;
      const dx = x + w * 0.06;
      box(L, x, y, w, h, color, 0.62, spec.wallRough);
      box(L, dx, y + h * 0.18, dw, h * 0.82, shade(color, 0.86), 0.5, 0.55);
      const ribs = 9;
      for (let i = 0; i < ribs; i++) {
        const ry = y + h * 0.18 + ((h * 0.82) / ribs) * i;
        box(L, dx, ry, dw, Math.max(1, (h * 0.82) / ribs - 1), shade(color, 0.9 + (i & 1) * 0.08), 0.56, 0.5);
        tint(L, dx, ry + (h * 0.82) / ribs - Math.max(1, m * 0.02), dw, Math.max(1, m * 0.02), 0x000000, 0.35);
      }
      const pdx = x + w * 0.72;
      const pdw = w * 0.2;
      box(L, pdx, y + h * 0.26, pdw, h * 0.74, shade(spec.sashColor, 1.1), 0.58, 0.42);
      box(L, pdx + m * 0.05, y + h * 0.32, pdw - m * 0.1, h * 0.26, spec.glassColor, 0.5, 0.1);
      // Steps up to the door.
      for (let s = 0; s < 3; s++) {
        box(L, pdx - m * 0.1, y + h - m * (0.18 * (s + 1)), pdw + m * 0.2, m * 0.18, shade(spec.trimColor, 0.7), 0.72 + s * 0.04, 0.8);
      }
      break;
    }
    case "stoop": {
      box(L, x, y, w, h, color, 0.62, spec.wallRough);
      // Raised entry with a balustrade — the Victorian/Edwardian signature.
      const dw = w * 0.26;
      const dx = x + w * 0.12;
      box(L, dx - m * 0.12, y + h * 0.1, dw + m * 0.24, h * 0.9, spec.trimColor, 0.72, 0.5);
      box(L, dx, y + h * 0.18, dw, h * 0.66, shade(spec.sashColor, 1.05), 0.6, 0.4);
      box(L, dx + m * 0.06, y + h * 0.24, dw - m * 0.12, h * 0.24, spec.glassColor, 0.52, 0.1);
      for (let s = 0; s < 5; s++) {
        box(
          L,
          dx - m * 0.2,
          y + h - m * (0.16 * (s + 1)),
          dw + m * 0.4,
          m * 0.16,
          shade(spec.trimColor, 0.78 - s * 0.03),
          0.76 + s * 0.03,
          0.72,
        );
      }
      // Garden window beside the entry.
      const gwx = x + w * 0.52;
      const gww = w * 0.36;
      drawWindow(L, gwx, y + h * 0.22, gww, h * 0.5, {
        spec,
        pxPerM: m,
        rng,
        litChance: 0,
      });
      break;
    }
    case "lobby": {
      // Full-height glazing with a canopy and a revolving door.
      box(L, x, y, w, h, spec.glassColor, 0.36, 0.08);
      vgrad(L, x, y, w, h * 0.75, 0x8199a8, spec.glassColor);
      for (let i = 1; i < 6; i++) {
        box(L, x + (w * i) / 6 - m * 0.04, y, m * 0.08, h, spec.sashColor, 0.6, 0.36);
      }
      // Interior warmth behind the glass — lobbies are always lit.
      tint(L, x, y + h * 0.55, w, h * 0.45, 0x6d5a3c, 0.35);
      const dw = w * 0.2;
      const dx = x + w * 0.4;
      box(L, dx, y + h * 0.42, dw, h * 0.58, shade(spec.trimColor, 0.55), 0.62, 0.3);
      box(L, dx + m * 0.08, y + h * 0.48, dw - m * 0.16, h * 0.46, 0x2a2f33, 0.55, 0.12);
      // Canopy.
      box(L, x, y + h * 0.3, w, m * 0.22, shade(spec.trimColor, 0.5), 0.96, 0.4);
      tint(L, x, y + h * 0.3 + m * 0.22, w, m * 0.5, 0x000000, 0.28);
      break;
    }
    case "dock": {
      box(L, x, y, w, h, color, 0.62, spec.wallRough);
      // Loading dock: freight door, dock leveller, bollards, tyre bumpers.
      const dw = w * 0.62;
      const dx = x + w * 0.1;
      box(L, dx - m * 0.1, y + h * 0.16, dw + m * 0.2, h * 0.7, shade(color, 0.7), 0.5, 0.8);
      const ribs = 7;
      for (let i = 0; i < ribs; i++) {
        const ry = y + h * 0.2 + ((h * 0.62) / ribs) * i;
        box(L, dx, ry, dw, (h * 0.62) / ribs - 1, shade(0x8a8478, 0.86 + (i & 1) * 0.14), 0.56, 0.6);
      }
      box(L, x, y + h * 0.86, w, h * 0.14, shade(0x76716a, 0.9), 0.8, 0.86);
      for (let b = 0; b < 3; b++) {
        box(L, x + w * (0.16 + b * 0.26), y + h * 0.78, m * 0.16, h * 0.22, 0xb8721f, 0.86, 0.7);
      }
      box(L, dx, y + h * 0.84, dw, m * 0.2, 0x1b1b1d, 0.9, 0.9);
      break;
    }
    case "colonnade":
    default: {
      // Rusticated base with deep-set arched openings.
      box(L, x, y, w, h, shade(color, 0.94), 0.62, spec.wallRough);
      const courses = 6;
      for (let i = 0; i < courses; i++) {
        const cy2 = y + (h / courses) * i;
        tint(L, x, cy2, w, Math.max(1, m * 0.03), 0x000000, 0.3);
        L.hgt.ctx.fillStyle = gray(0.4);
        L.hgt.ctx.fillRect(x, cy2, w, Math.max(1, m * 0.03));
      }
      const openings = 2;
      for (let i = 0; i < openings; i++) {
        const ow = w / openings;
        const ox = x + ow * i + ow * 0.2;
        const oww = ow * 0.6;
        const oy = y + h * 0.24;
        const ohh = h * 0.66;
        box(L, ox, oy, oww, ohh, shade(spec.glassColor, 0.9), 0.28, 0.2);
        vgrad(L, ox, oy, oww, ohh * 0.5, 0x5b6f7c, spec.glassColor);
        box(L, ox - m * 0.08, oy - m * 0.14, oww + m * 0.16, m * 0.16, spec.trimColor, 0.88, 0.55);
      }
      break;
    }
  }
}

/* ================================================================== *
 * Cornice
 * ================================================================== */

function drawCrown(
  L: Layers,
  x: number,
  y: number,
  w: number,
  h: number,
  spec: StyleSpec,
  color: number,
  pxPerM: number,
  rng: Rng,
): void {
  const m = pxPerM;
  box(L, x, y, w, h, color, 0.62, spec.wallRough);
  switch (spec.cornice) {
    case "dentil": {
      const fasciaH = h * 0.34;
      box(L, x, y + h - fasciaH, w, fasciaH, spec.trimColor, 0.7, 0.5);
      // Dentil course.
      const n = Math.max(6, Math.round(w / (0.14 * m)));
      for (let i = 0; i < n; i++) {
        const dx = x + (w * i) / n;
        box(L, dx, y + h * 0.34, (w / n) * 0.62, h * 0.24, shade(spec.trimColor, 1.02), 0.92, 0.45);
      }
      // Crown moulding, proud of everything.
      box(L, x, y, w, h * 0.3, shade(spec.trimColor, 1.05), 1.0, 0.45);
      tint(L, x, y + h * 0.3, w, h * 0.06, 0x000000, 0.35);
      break;
    }
    case "bracket": {
      box(L, x, y + h * 0.55, w, h * 0.45, spec.trimColor, 0.72, 0.5);
      const n = spec.bays * 2;
      for (let i = 0; i < n; i++) {
        const bx = x + (w * (i + 0.5)) / n - m * 0.07;
        box(L, bx, y + h * 0.3, m * 0.14, h * 0.42, shade(spec.trimColor, 0.94), 0.9, 0.5);
      }
      box(L, x, y, w, h * 0.3, shade(spec.trimColor, 1.06), 1.0, 0.45);
      tint(L, x, y + h * 0.3, w, h * 0.08, 0x000000, 0.4);
      break;
    }
    case "gable": {
      // Victorian false-front gable with a scrolled bracket each side.
      box(L, x, y + h * 0.5, w, h * 0.5, spec.trimColor, 0.74, 0.5);
      const ctx = L.alb.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, y + h * 0.55);
      ctx.lineTo(x + w * 0.5, y + h * 0.02);
      ctx.lineTo(x + w, y + h * 0.55);
      ctx.closePath();
      ctx.fillStyle = css(shade(spec.trimColor, 1.03));
      ctx.fill();
      ctx.restore();
      const hctx = L.hgt.ctx;
      hctx.save();
      hctx.beginPath();
      hctx.moveTo(x, y + h * 0.55);
      hctx.lineTo(x + w * 0.5, y + h * 0.02);
      hctx.lineTo(x + w, y + h * 0.55);
      hctx.closePath();
      hctx.fillStyle = gray(0.95);
      hctx.fill();
      hctx.restore();
      box(L, x + w * 0.42, y + h * 0.3, w * 0.16, h * 0.22, shade(spec.sashColor, 1.3), 0.6, 0.35);
      break;
    }
    case "deco": {
      // Stepped setback with chevrons — 1920s downtown.
      box(L, x, y + h * 0.62, w, h * 0.38, shade(color, 0.94), 0.7, spec.wallRough);
      box(L, x + w * 0.06, y + h * 0.32, w * 0.88, h * 0.34, shade(color, 1.03), 0.82, spec.wallRough);
      box(L, x + w * 0.16, y, w * 0.68, h * 0.36, shade(color, 1.08), 0.92, spec.wallRough);
      const n = 5;
      for (let i = 0; i < n; i++) {
        const cx = x + w * 0.2 + (w * 0.6 * i) / n;
        box(L, cx, y + h * 0.1, w * 0.035, h * 0.22, shade(spec.trimColor, 0.9), 0.98, 0.5);
      }
      break;
    }
    case "mechanical": {
      // Louvred plant band above the last glazed floor.
      box(L, x, y, w, h, shade(spec.trimColor, 0.55), 0.66, 0.6);
      const n = Math.max(8, Math.round(h / (0.09 * m)));
      for (let i = 0; i < n; i++) {
        const ly = y + (h * i) / n;
        box(L, x, ly, w, (h / n) * 0.55, shade(spec.trimColor, 0.42), 0.58, 0.55);
        tint(L, x, ly + (h / n) * 0.55, w, (h / n) * 0.45, 0x000000, 0.35);
      }
      box(L, x, y, w, m * 0.16, shade(spec.trimColor, 0.8), 0.98, 0.5);
      break;
    }
    case "parapet": {
      box(L, x, y + h * 0.3, w, h * 0.7, color, 0.64, spec.wallRough);
      box(L, x, y, w, h * 0.32, shade(spec.trimColor, 0.8), 0.96, 0.6);
      tint(L, x, y + h * 0.32, w, h * 0.08, 0x000000, 0.3);
      // A recessed panel or two so it is not a blank band.
      if (rng.next() < 0.6) {
        box(L, x + w * 0.2, y + h * 0.48, w * 0.6, h * 0.34, shade(color, 0.9), 0.5, spec.wallRough);
      }
      break;
    }
    case "flat":
    default: {
      box(L, x, y, w, h * 0.4, shade(spec.trimColor, 0.85), 0.9, 0.55);
      tint(L, x, y + h * 0.4, w, h * 0.08, 0x000000, 0.28);
      break;
    }
  }
}

/* ================================================================== *
 * Fire escape
 * ================================================================== */

/**
 * Fire escapes are baked into albedo + height rather than modelled. At any
 * distance past about 15 m the geometry is invisible anyway, and a SoMa block
 * has hundreds of them — this is thousands of draw calls saved for something
 * the player reads as a silhouette.
 */
function drawFireEscape(
  L: Layers,
  x: number,
  y: number,
  w: number,
  h: number,
  floors: number,
  floorPx: number,
  pxPerM: number,
): void {
  const m = pxPerM;
  const steel = 0x2e2b28;
  const rail = 0x3a3733;
  const stringerW = Math.max(1, m * 0.05);
  // Two stringers spanning the full run.
  box(L, x, y, stringerW, h, steel, 0.9, 0.75);
  box(L, x + w - stringerW, y, stringerW, h, steel, 0.9, 0.75);
  for (let f = 0; f < floors; f++) {
    const ly = y + f * floorPx + floorPx * 0.62;
    // Landing platform: grating, so it reads as a dark band with light through.
    box(L, x, ly, w, m * 0.1, steel, 0.94, 0.8);
    for (let gx = x; gx < x + w; gx += m * 0.06) {
      L.alb.ctx.fillStyle = css(0x000000, 0.4);
      L.alb.ctx.fillRect(gx, ly, m * 0.03, m * 0.1);
    }
    // Railing: top rail plus balusters.
    const rh = m * 0.85;
    box(L, x, ly - rh, w, Math.max(1, m * 0.035), rail, 0.92, 0.7);
    box(L, x, ly - rh * 0.5, w, Math.max(1, m * 0.025), rail, 0.9, 0.7);
    for (let bx = x; bx < x + w; bx += m * 0.12) {
      box(L, bx, ly - rh, Math.max(1, m * 0.022), rh, rail, 0.9, 0.7);
    }
    // Diagonal stair to the landing below.
    const ctx = L.alb.ctx;
    const hctx = L.hgt.ctx;
    ctx.save();
    hctx.save();
    ctx.strokeStyle = css(steel);
    hctx.strokeStyle = gray(0.9);
    ctx.lineWidth = Math.max(1, m * 0.05);
    hctx.lineWidth = ctx.lineWidth;
    ctx.beginPath();
    hctx.beginPath();
    const sx = f % 2 === 0 ? x + w * 0.15 : x + w * 0.85;
    const ex = f % 2 === 0 ? x + w * 0.7 : x + w * 0.3;
    ctx.moveTo(sx, ly);
    ctx.lineTo(ex, ly + floorPx * 0.85);
    hctx.moveTo(sx, ly);
    hctx.lineTo(ex, ly + floorPx * 0.85);
    ctx.stroke();
    hctx.stroke();
    ctx.restore();
    hctx.restore();
    // Cast shadow on the wall, offset down and to one side.
    L.alb.ctx.fillStyle = css(0x000000, 0.22);
    L.alb.ctx.fillRect(x + m * 0.18, ly + m * 0.2, w, m * 0.12);
  }
}

/* ================================================================== *
 * Panel assembly
 * ================================================================== */

interface PanelLayout {
  typicalFloors: number;
  crownHeight: number;
  groundPx: number;
  typicalPx: number;
  crownPx: number;
  floorPx: number;
  pxPerM: number;
}

function layoutFor(spec: StyleSpec, cellW: number, cellH: number): PanelLayout {
  const pxPerM = cellW / PANEL_WIDTH;
  const typicalFloors = Math.max(
    1,
    Math.floor((PANEL_HEIGHT - spec.groundHeight - spec.minCrown) / spec.floorHeight),
  );
  const crownHeight = PANEL_HEIGHT - spec.groundHeight - typicalFloors * spec.floorHeight;
  return {
    typicalFloors,
    crownHeight,
    groundPx: spec.groundHeight * pxPerM,
    typicalPx: typicalFloors * spec.floorHeight * pxPerM,
    crownPx: crownHeight * pxPerM,
    floorPx: spec.floorHeight * pxPerM,
    pxPerM,
  };
}

function paintPanel(
  L: Layers,
  spec: StyleSpec,
  variant: number,
  cellX: number,
  cellW: number,
  cellH: number,
  layout: PanelLayout,
  rng: Rng,
): FacadeVariant {
  const color = spec.wallColors[variant % spec.wallColors.length];
  const { pxPerM, floorPx, groundPx, typicalPx, crownPx, typicalFloors } = layout;
  const yCrown = 0;
  const yTypical = crownPx;
  const yGround = crownPx + typicalPx;

  // Wall base for the whole panel, then the bands on top.
  paintWall(L, cellX, 0, cellW, cellH, spec, color, pxPerM, rng.fork(`wall${variant}`));

  drawCrown(L, cellX, yCrown, cellW, crownPx, spec, color, pxPerM, rng.fork(`crown${variant}`));

  // Typical floors.
  const bayW = cellW / spec.bays;
  const wc: WinCtx = { spec, pxPerM, rng: rng.fork(`win${variant}`), litChance: spec.nightLit };
  for (let f = 0; f < typicalFloors; f++) {
    const fy = yTypical + f * floorPx;
    // A string course between floors on masonry styles.
    if (spec.wall === "brick" || spec.wall === "stone") {
      box(L, cellX, fy + floorPx - pxPerM * 0.1, cellW, pxPerM * 0.09, spec.trimColor, 0.78, 0.6);
      tint(L, cellX, fy + floorPx - pxPerM * 0.01, cellW, pxPerM * 0.06, 0x000000, 0.22);
    }
    for (let b = 0; b < spec.bays; b++) {
      const bx = cellX + b * bayW;
      const ww = bayW * spec.winW;
      const wh = floorPx * spec.winH;
      const wx = bx + (bayW - ww) * 0.5;
      const wy = fy + floorPx * 0.16;
      if (spec.window === "bay") {
        // Projecting bay window: the defining feature of a San Francisco
        // street. Faked with a lit centre face and two shaded returns.
        const proj = bayW * 0.09;
        box(L, wx - proj, wy - pxPerM * 0.12, ww + proj * 2, wh + pxPerM * 0.3, shade(color, 1.06), 0.86, spec.wallRough);
        tint(L, wx - proj, wy - pxPerM * 0.12, proj, wh + pxPerM * 0.3, 0x000000, 0.28);
        tint(L, wx + ww, wy - pxPerM * 0.12, proj, wh + pxPerM * 0.3, 0xffffff, 0.14);
        drawWindow(L, wx + ww * 0.06, wy, ww * 0.88, wh, wc);
        // The bay throws a shadow onto the wall below it.
        tint(L, wx - proj, wy + wh + pxPerM * 0.18, ww + proj * 2, pxPerM * 0.5, 0x000000, 0.24);
      } else if (spec.window === "ribbon") {
        // Continuous glazing with a spandrel panel between floors.
        const gh = floorPx * spec.winH;
        box(L, bx, fy + floorPx * 0.06, bayW, gh, spec.glassColor, 0.34, 0.07);
        vgrad(L, bx, fy + floorPx * 0.06, bayW, gh * 0.8, shade(0x7d94a6, 0.9 + rng.next() * 0.5), spec.glassColor);
        box(L, bx, fy + floorPx * 0.06 + gh, bayW, floorPx - gh - floorPx * 0.06, shade(spec.trimColor, 0.7), 0.6, 0.42);
        // Vertical mullion at every bay, horizontal transom at the head.
        box(L, bx, fy, pxPerM * 0.07, floorPx, shade(spec.trimColor, 1.1), 0.78, 0.32);
        box(L, bx, fy + floorPx * 0.06 + gh - pxPerM * 0.05, bayW, pxPerM * 0.06, shade(spec.trimColor, 0.95), 0.72, 0.32);
      } else {
        drawWindow(L, wx, wy, ww, wh, wc);
      }
    }
  }

  // Ground floor.
  drawGround(L, cellX, yGround, cellW, groundPx, spec, color, pxPerM, rng.fork(`ground${variant}`));

  // Fire escape on the second variant only, so the generator can mix clean and
  // cluttered elevations along a street.
  const hasFireEscape = spec.fireEscape && variant % 2 === 1;
  if (hasFireEscape) {
    drawFireEscape(
      L,
      cellX + cellW * 0.08,
      yTypical,
      cellW * 0.5,
      typicalPx,
      typicalFloors,
      floorPx,
      pxPerM,
    );
  }

  // Night lighting for the typical floors + a permanently lit ground floor.
  const litRng = rng.fork(`lit${variant}`);
  const lwc: WinCtx = { spec, pxPerM, rng: litRng, litChance: spec.nightLit };
  for (let f = 0; f < typicalFloors; f++) {
    const fy = yTypical + f * floorPx;
    for (let b = 0; b < spec.bays; b++) {
      const bx = cellX + b * bayW;
      const ww = bayW * spec.winW;
      const wh = floorPx * spec.winH;
      const wx = bx + (bayW - ww) * 0.5;
      const wy = fy + floorPx * 0.16;
      if (spec.window === "ribbon") {
        if (litRng.next() < spec.nightLit) {
          const gh = floorPx * spec.winH;
          const k = 0.5 + litRng.next() * 0.5;
          emissive(L, bx + pxPerM * 0.07, fy + floorPx * 0.08, bayW - pxPerM * 0.1, gh - pxPerM * 0.04, shade(0xf6ead0, k));
        }
      } else {
        drawWindowLit(L, wx, wy, ww, wh, lwc);
      }
    }
  }
  // Ground-floor glow: shopfronts and lobbies are the brightest thing on a
  // street at night and they anchor the whole night-time read of the city.
  if (spec.ground === "retail" || spec.ground === "lobby") {
    const gy = yGround + groundPx * 0.2;
    emissive(L, cellX, gy, cellW, groundPx * 0.62, spec.ground === "lobby" ? 0xc8b48c : 0xe0c894);
  } else if (spec.ground === "stoop" || spec.ground === "garage") {
    // A porch light, nothing more.
    emissive(L, cellX + cellW * 0.14, yGround + groundPx * 0.2, pxPerM * 0.22, pxPerM * 0.22, 0xffd9a0);
  }

  const size = L.size;
  const toRect = (py: number, ph: number): FacadeRect => ({
    x: cellX / size,
    y: 1 - (py + ph) / size,
    w: cellW / size,
    h: ph / size,
  });

  return {
    index: variant,
    style: "victorian", // overwritten by the caller with the real style
    rect: toRect(0, cellH),
    crown: toRect(yCrown, crownPx),
    typical: toRect(yTypical, typicalPx),
    ground: toRect(yGround, groundPx),
    panelWidth: PANEL_WIDTH,
    groundHeight: spec.groundHeight,
    floorHeight: spec.floorHeight,
    typicalFloors,
    crownHeight: layout.crownHeight,
    bays: spec.bays,
    hasFireEscape,
    wallColor: color,
  };
}

/* ================================================================== *
 * Weathering pass
 * ================================================================== */

/**
 * Everything above is clean geometry. This is where the building starts to
 * look like it has been standing in salt fog since 1907: fine surface grain in
 * the height and albedo, grime in every crevice, and rain streaks running down
 * from every sill and cornice.
 */
function weather(L: Layers, spec: StyleSpec, size: number, rng: Rng): {
  albedo: Uint8Array;
  height: Field;
  rough: Field;
} {
  const n = size * size;
  const grainF = fbmField(size, {
    period: Math.max(4, Math.round(size / 2.6)),
    octaves: 2,
    gain: 0.6,
    seed: `facade:grain:${spec.wall}`,
  });
  const midF = fbmField(size, { period: 12, octaves: 4, seed: `facade:mid:${spec.wall}` });
  const macroF = fbmField(size, { period: 3, octaves: 4, seed: `facade:macro:${spec.wall}` });

  const heightImg = L.hgt.ctx.getImageData(0, 0, size, size);
  const height = new Float32Array(n);
  const grainAmt = spec.wall === "stucco" ? 0.09 : spec.wall === "curtain" ? 0.015 : 0.055;
  for (let i = 0; i < n; i++) {
    height[i] = clamp01(heightImg.data[i * 4] / 255 + (grainF[i] - 0.5) * grainAmt);
  }

  // Streaks start at sills and cornices, which is exactly where the height
  // field steps outward — so seed them from the relief rather than at random.
  const streaks = streakField(size, {
    count: Math.round(size / 6),
    startMin: 0,
    startMax: 0.75,
    lengthMin: 0.05,
    lengthMax: 0.3,
    widthMin: 0.002,
    widthMax: 0.012,
    strength: 0.8,
    seed: `facade:streaks:${spec.wall}`,
  });
  const ledge = new Float32Array(n);
  for (let y = 1; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // Positive where the surface steps out as you move up = an upward face.
      ledge[i] = clamp01((height[i - size] - height[i]) * 5);
    }
  }
  // Smear the ledge mask downward: that is the drip.
  const drip = new Float32Array(n);
  for (let x = 0; x < size; x++) {
    let acc = 0;
    for (let y = 0; y < size; y++) {
      const i = y * size + x;
      acc = Math.max(acc * 0.985, ledge[i]);
      drip[i] = acc;
    }
  }
  const grime = grimeField(height, size, {
    seed: `facade:grime:${spec.wall}`,
    baseBias: 0.5,
    amount: 0.85,
  });

  const albImg = L.alb.ctx.getImageData(0, 0, size, size);
  const alb = albImg.data;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    // Tone drift so no two panels of the same style read identically.
    const mod = 1 + (macroF[i] - 0.5) * 0.16 + (midF[i] - 0.5) * 0.09 + (grainF[i] - 0.5) * 0.1;
    let r = alb[o] * mod;
    let g = alb[o + 1] * mod;
    let b = alb[o + 2] * mod;
    // Grime: cool, dark, and it desaturates whatever it lands on.
    const gr = grime[i] * 0.34;
    r += (42 - r) * gr;
    g += (43 - g) * gr;
    b += (41 - b) * gr;
    // Rain streaks: darker and slightly warmer than the grime.
    const st = clamp01(drip[i] * 0.75 + streaks[i] * 0.35 * drip[i] * 2) * 0.32;
    r += (58 - r) * st;
    g += (54 - g) * st;
    b += (49 - b) * st;
    alb[o] = r;
    alb[o + 1] = g;
    alb[o + 2] = b;
  }
  L.alb.ctx.putImageData(albImg, 0, 0);

  const roughImg = L.rgh.ctx.getImageData(0, 0, size, size);
  const rough = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    rough[i] = clamp01(
      roughImg.data[i * 4] / 255 + grime[i] * 0.16 + drip[i] * 0.1 + (grainF[i] - 0.5) * 0.08,
    );
  }

  const out = new Uint8Array(n * 4);
  out.set(alb);
  return { albedo: out, height, rough };
}

/* ================================================================== *
 * Atlas assembly
 * ================================================================== */

const ATLAS_SIZE: Record<QualityTier, number> = {
  low: 512,
  medium: 512,
  high: 1024,
  ultra: 2048,
};

/** Two panels per style: one clean elevation, one with the clutter. */
const ATLAS_COLS = 2;

const atlasCache = new Map<string, FacadeAtlas>();

export interface FacadeAtlasOptions {
  tier?: QualityTier;
  /** Override the fraction of windows lit at night, 0..1. */
  nightLit?: number;
}

/**
 * Build (or fetch) the atlas for a building style. Generation is not cheap —
 * budget roughly 120 ms per style at High — so drive it from `preload` with a
 * progress callback rather than lazily during play.
 */
export function getFacadeAtlas(
  style: BuildingStyle,
  o: FacadeAtlasOptions = {},
): FacadeAtlas {
  const tier = o.tier ?? "high";
  // Bucket nightLit so a district asking for 0.61 and one asking for 0.63 share
  // an atlas instead of baking two 16 MB textures.
  const litBucket = o.nightLit === undefined ? -1 : Math.round(clamp01(o.nightLit) * 4);
  const key = `${style}|${tier}|${litBucket}`;
  const hit = atlasCache.get(key);
  if (hit) return hit;

  const size = ATLAS_SIZE[tier];
  const cols = ATLAS_COLS;
  const cellW = size / cols;
  const cellH = size;
  const specBase = SPECS[style];
  const spec: StyleSpec =
    litBucket >= 0 ? { ...specBase, nightLit: clamp01(litBucket / 4) } : specBase;

  const L: Layers = {
    size,
    alb: makeSurface(size, size),
    hgt: makeSurface(size, size),
    rgh: makeSurface(size, size),
    ems: makeSurface(size, size),
  };
  // Sensible defaults before anything is drawn.
  L.hgt.ctx.fillStyle = gray(0.6);
  L.hgt.ctx.fillRect(0, 0, size, size);
  L.rgh.ctx.fillStyle = gray(spec.wallRough);
  L.rgh.ctx.fillRect(0, 0, size, size);
  L.ems.ctx.fillStyle = "rgb(0,0,0)";
  L.ems.ctx.fillRect(0, 0, size, size);

  const layout = layoutFor(spec, cellW, cellH);
  const rng = makeRng(`sf-facade:${style}:${tier}`);
  const variants: FacadeVariant[] = [];
  for (let v = 0; v < cols; v++) {
    const fv = paintPanel(L, spec, v, v * cellW, cellW, cellH, layout, rng.fork(`panel${v}`));
    fv.style = style;
    variants.push(fv);
  }

  const w = weather(L, spec, size, rng.fork("weather"));
  const aniso = QUALITY[tier].anisotropy;

  const map = rasterTexture(flipRaster(w.albedo, size), size, {
    srgb: true,
    anisotropy: aniso,
    wrap: THREE.ClampToEdgeWrapping,
    name: `sf/facade/${style}/albedo`,
  });
  // Panels tile horizontally, so U must repeat while V clamps.
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;

  const normalStrength = spec.wall === "curtain" ? 0.7 : 1.5;
  const normalMap = rasterTexture(
    flipRaster(normalFromHeight(w.height, size, normalStrength), size),
    size,
    { anisotropy: aniso, name: `sf/facade/${style}/normal` },
  );
  normalMap.wrapS = THREE.RepeatWrapping;
  normalMap.wrapT = THREE.ClampToEdgeWrapping;

  const ao = aoFromHeight(w.height, size, { strength: 1.2 });
  const metal =
    spec.wall === "curtain" || spec.wall === "metal" ? undefined : undefined;
  const ormMap = rasterTexture(packORM(size, ao, w.rough, metal ?? 0), size, {
    anisotropy: aniso,
    channel: 0,
    name: `sf/facade/${style}/orm`,
  });
  ormMap.wrapS = THREE.RepeatWrapping;
  ormMap.wrapT = THREE.ClampToEdgeWrapping;

  // Emissive at half resolution: window light has no high-frequency content
  // and this is a straight 4x memory saving on a map that is only ever bloomed.
  const emsSize = Math.max(64, size >> 1);
  const emsSmall = makeSurface(emsSize, emsSize);
  emsSmall.ctx.drawImage(L.ems.canvas as HTMLCanvasElement, 0, 0, emsSize, emsSize);
  const emsField = emsSmall.ctx.getImageData(0, 0, emsSize, emsSize);
  const emsRaster = new Uint8Array(emsField.data.buffer.slice(0));
  const emissiveMap = rasterTexture(flipRaster(emsRaster, emsSize), emsSize, {
    srgb: true,
    anisotropy: Math.min(4, aniso),
    name: `sf/facade/${style}/emissive`,
  });
  emissiveMap.wrapS = THREE.RepeatWrapping;
  emissiveMap.wrapT = THREE.ClampToEdgeWrapping;

  const atlas: FacadeAtlas = {
    style,
    tier,
    size,
    cols,
    variants,
    map,
    normalMap,
    ormMap,
    emissiveMap,
    dispose() {
      map.dispose();
      normalMap.dispose();
      ormMap.dispose();
      emissiveMap.dispose();
      atlasCache.delete(key);
    },
  };
  atlasCache.set(key, atlas);
  return atlas;
}

/* ================================================================== *
 * Materials
 * ================================================================== */

const facadeMaterialCache = new Map<string, THREE.MeshStandardMaterial>();

export interface FacadeMaterialOptions extends FacadeAtlasOptions {
  /** Tint applied through material.color — use the district palette. */
  color?: THREE.ColorRepresentation;
  /** 0 by day, up to ~3 at night. Drive this from the time-of-day system. */
  emissiveIntensity?: number;
  /** Skip the cache (per-building tints that would thrash it). */
  unique?: boolean;
}

/**
 * A ready-to-use material for a building style.
 *
 * Note there is no detail layer: atlas UVs are not tileable, so sampling the
 * albedo at a higher frequency would fetch a neighbouring panel. The macro
 * variation map *is* applied — it has its own tileable source — and that is
 * what stops a row of identical Sunset houses from reading as a photocopy.
 */
export function getFacadeMaterial(
  style: BuildingStyle,
  o: FacadeMaterialOptions = {},
): THREE.MeshStandardMaterial {
  const tier = o.tier ?? "high";
  const colorHex = o.color !== undefined ? new THREE.Color(o.color).getHex() : 0xffffff;
  const emi = o.emissiveIntensity ?? 0;
  const key = `${style}|${tier}|${o.nightLit ?? -1}|${colorHex.toString(16)}|${emi}`;
  if (!o.unique) {
    const hit = facadeMaterialCache.get(key);
    if (hit) return hit;
  }
  const atlas = getFacadeAtlas(style, o);
  const mat = new THREE.MeshStandardMaterial({
    name: `sf/facade/${style}`,
    map: atlas.map,
    normalMap: atlas.normalMap,
    roughnessMap: atlas.ormMap,
    metalnessMap: atlas.ormMap,
    aoMap: atlas.ormMap,
    emissiveMap: atlas.emissiveMap,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: emi,
    roughness: 1,
    metalness: 1,
    color: new THREE.Color(colorHex),
    dithering: true,
  });
  applyDetailBlend(mat, {
    detailScale: 1, // disabled — see the note above
    macroMap: getMacroVariationTexture(tier),
    macroWorldScale: 0.37, // ~2.7 atlas widths, so it drifts across a block
    macroStrength: 0.3,
  });
  if (!o.unique) facadeMaterialCache.set(key, mat);
  return mat;
}

/** Panel layout for a style without generating the atlas — for planners. */
export function facadePanelMetrics(style: BuildingStyle): {
  panelWidth: number;
  panelHeight: number;
  groundHeight: number;
  floorHeight: number;
  typicalFloors: number;
  crownHeight: number;
  bays: number;
} {
  const spec = SPECS[style];
  const typicalFloors = Math.max(
    1,
    Math.floor((PANEL_HEIGHT - spec.groundHeight - spec.minCrown) / spec.floorHeight),
  );
  return {
    panelWidth: PANEL_WIDTH,
    panelHeight: PANEL_HEIGHT,
    groundHeight: spec.groundHeight,
    floorHeight: spec.floorHeight,
    typicalFloors,
    crownHeight: PANEL_HEIGHT - spec.groundHeight - typicalFloors * spec.floorHeight,
    bays: spec.bays,
  };
}

export function disposeFacadeAtlases(): void {
  for (const m of facadeMaterialCache.values()) m.dispose();
  facadeMaterialCache.clear();
  for (const a of Array.from(atlasCache.values())) a.dispose();
  atlasCache.clear();
}
