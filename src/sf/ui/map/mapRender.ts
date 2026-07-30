/**
 * The map renderer.
 *
 * The minimap and the full-screen map are the same drawing code at different
 * zooms, and both are drawn *vectorially from sfGeo* rather than from a
 * pre-baked image. That matters: the coastline it fills is the same
 * `LANDMASSES` polygon the terrain solver uses, and the streets it strokes
 * are the same grid `nearestStreet` tests against. A map drawn from a
 * separate source of truth is a map that lies, and a map that lies about
 * where a street is will get the player killed.
 *
 * Everything is drawn in screen space with a single view transform. Nothing
 * allocates per call beyond the two scratch points.
 */
import {
  DISTRICTS,
  EXCLUSIONS,
  GRID_NORTH,
  GRID_SOUTH,
  GRID_WEST,
  LANDMARKS,
  LANDMASSES,
  MARKET_STREET,
  WORLD,
  fromGridSpace,
  toGridSpace,
  type GridSystem,
  type Vec2,
} from "../../geo/sfGeo";
import { COLORS, rgba } from "../theme";

export interface MapView {
  /** World-space centre of the viewport. */
  cx: number;
  cz: number;
  /** Screen pixels per world metre. */
  ppm: number;
  /** Rotation in radians. 0 = north up; pass the player yaw for player-up. */
  rot: number;
  /** Canvas size in CSS pixels. */
  w: number;
  h: number;
}

const pt = { x: 0, y: 0 };
const wpt = { x: 0, z: 0 };

/** World → screen. Writes into a shared scratch and returns it. */
export function w2s(v: MapView, x: number, z: number): { x: number; y: number } {
  const dx = (x - v.cx) * v.ppm;
  const dz = (z - v.cz) * v.ppm;
  const c = Math.cos(v.rot);
  const s = Math.sin(v.rot);
  pt.x = v.w * 0.5 + dx * c - dz * s;
  pt.y = v.h * 0.5 + dx * s + dz * c;
  return pt;
}

/** Screen → world. */
export function s2w(v: MapView, sx: number, sy: number): { x: number; z: number } {
  const dx = sx - v.w * 0.5;
  const dy = sy - v.h * 0.5;
  const c = Math.cos(v.rot);
  const s = Math.sin(v.rot);
  wpt.x = v.cx + (dx * c + dy * s) / v.ppm;
  wpt.z = v.cz + (-dx * s + dy * c) / v.ppm;
  return wpt;
}

/** The world-space rectangle currently visible, with a margin. */
function visibleBounds(v: MapView, margin: number) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const corners: [number, number][] = [
    [0, 0],
    [v.w, 0],
    [v.w, v.h],
    [0, v.h],
  ];
  for (const [sx, sy] of corners) {
    const p = s2w(v, sx, sy);
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX: minX - margin, maxX: maxX + margin, minZ: minZ - margin, maxZ: maxZ + margin };
}

/* ------------------------------------------------------------------ *
 * Grid regions
 * ------------------------------------------------------------------ *
 * Three grids govern three parts of the city and they meet along Market
 * Street and a longitude line. Rather than test every candidate line against
 * `gridAt`, each grid is clipped to its own convex region once at module load
 * and the region is used as a canvas clip path.
 */

const MARKET_NX = -(MARKET_STREET.bz - MARKET_STREET.az);
const MARKET_NZ = MARKET_STREET.bx - MARKET_STREET.ax;
const MARKET_LEN = Math.hypot(MARKET_NX, MARKET_NZ) || 1;

/** Same sign convention as sfGeo's `marketSide`. */
function marketSideOf(x: number, z: number): number {
  return (
    ((x - MARKET_STREET.ax) * (MARKET_NX / MARKET_LEN) +
      (z - MARKET_STREET.az) * (MARKET_NZ / MARKET_LEN))
  );
}

/** Sutherland–Hodgman against a single half-plane; keeps `f(p) <= 0`. */
function clipHalfPlane(poly: Vec2[], f: (x: number, z: number) => number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const fa = f(a.x, a.z);
    const fb = f(b.x, b.z);
    if (fa <= 0) out.push(a);
    if ((fa <= 0) !== (fb <= 0)) {
      const t = fa / (fa - fb);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

const WORLD_RECT: Vec2[] = [
  { x: WORLD.minX, z: WORLD.minZ },
  { x: WORLD.maxX, z: WORLD.minZ },
  { x: WORLD.maxX, z: WORLD.maxZ },
  { x: WORLD.minX, z: WORLD.maxZ },
];

const WEST_REGION = clipHalfPlane(WORLD_RECT, (x) => x + 3400);
const EAST_RECT = clipHalfPlane(WORLD_RECT, (x) => -(x + 3400));
const NORTH_REGION = clipHalfPlane(EAST_RECT, (x, z) => marketSideOf(x, z));
const SOUTH_REGION = clipHalfPlane(EAST_RECT, (x, z) => -marketSideOf(x, z));

const REGIONS: { grid: GridSystem; poly: Vec2[] }[] = [
  { grid: GRID_WEST, poly: WEST_REGION },
  { grid: GRID_NORTH, poly: NORTH_REGION },
  { grid: GRID_SOUTH, poly: SOUTH_REGION },
];

/** Parks, using the same predicate sfGeo's `isPark` uses. */
const PARKS = EXCLUSIONS.filter((e) =>
  /Park|Square|Green|Plaza|Forest|Peaks|Mason|Davidson/.test(e.reason),
);

/* ------------------------------------------------------------------ *
 * Layers
 * ------------------------------------------------------------------ */

export interface MapStyle {
  /** Below this pixels-per-metre, street detail is dropped. */
  minStreetPpm: number;
  /** Draw district names. */
  districts: boolean;
  /** Draw landmark glyphs. */
  landmarks: boolean;
  /** Draw landmark names (only ever worth it on the big map). */
  landmarkLabels: boolean;
  /** Relief image, or null. Drawn under the streets, clipped to land. */
  hillshade: HTMLCanvasElement | null;
  /** Overall contrast: the minimap runs darker so HUD text stays readable. */
  dim: number;
}

export const MINIMAP_STYLE: MapStyle = {
  minStreetPpm: 0.02,
  districts: false,
  landmarks: true,
  landmarkLabels: false,
  hillshade: null,
  dim: 1,
};

export const FULLMAP_STYLE: MapStyle = {
  minStreetPpm: 0.012,
  districts: true,
  landmarks: true,
  landmarkLabels: true,
  hillshade: null,
  dim: 0.82,
};

function pathPolygon(ctx: CanvasRenderingContext2D, v: MapView, poly: Vec2[]) {
  ctx.beginPath();
  for (let i = 0; i < poly.length; i++) {
    const p = w2s(v, poly[i].x, poly[i].z);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
}

/** Land silhouette as a single path — used both to fill and to clip. */
function pathLand(ctx: CanvasRenderingContext2D, v: MapView) {
  ctx.beginPath();
  for (const lm of LANDMASSES) {
    for (let i = 0; i < lm.ring.length; i++) {
      const p = w2s(v, lm.ring[i].x, lm.ring[i].z);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  }
}

/**
 * Draw the static base map: water, land, relief, parks, streets, labels.
 * Dynamic content (player, contacts, pins) is the caller's business.
 */
export function drawBaseMap(ctx: CanvasRenderingContext2D, v: MapView, style: MapStyle): void {
  const dim = style.dim;

  // --- water ---------------------------------------------------------
  const g = ctx.createLinearGradient(0, 0, 0, v.h);
  g.addColorStop(0, COLORS.waterDeep);
  g.addColorStop(1, COLORS.water);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, v.w, v.h);

  // A faint bathymetric texture so the bay is not a dead flat field.
  ctx.save();
  ctx.globalAlpha = 0.16 * dim;
  ctx.strokeStyle = "#2a4257";
  ctx.lineWidth = 1;
  const spacing = Math.max(28, 220 * v.ppm);
  ctx.beginPath();
  for (let y = (v.h * 0.5) % spacing; y < v.h; y += spacing) {
    ctx.moveTo(0, y);
    ctx.lineTo(v.w, y);
  }
  ctx.stroke();
  ctx.restore();

  // --- land ----------------------------------------------------------
  pathLand(ctx, v);
  ctx.fillStyle = COLORS.land;
  ctx.fill("evenodd");

  // Coastline: a bright hairline plus an outer glow, which is what makes a
  // dark map read as a *place* rather than as a shape.
  ctx.save();
  ctx.lineJoin = "round";
  ctx.strokeStyle = rgba("#7fa8c4", 0.5 * dim);
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.strokeStyle = rgba("#7fa8c4", 0.12 * dim);
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.restore();

  // Everything from here is inside the coastline.
  ctx.save();
  pathLand(ctx, v);
  ctx.clip("evenodd");

  // --- relief --------------------------------------------------------
  if (style.hillshade) {
    const a = w2s(v, WORLD.minX, WORLD.minZ);
    const ax = a.x;
    const ay = a.y;
    const b = w2s(v, WORLD.maxX, WORLD.maxZ);
    const bx = b.x;
    const by = b.y;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.globalCompositeOperation = "lighter";
    if (Math.abs(v.rot) > 1e-4) {
      ctx.translate(v.w * 0.5, v.h * 0.5);
      ctx.rotate(v.rot);
      ctx.translate(-v.w * 0.5, -v.h * 0.5);
    }
    // With rotation the corner mapping above is only valid unrotated, so the
    // rotated case re-derives the rect in the rotated frame.
    if (Math.abs(v.rot) > 1e-4) {
      const noRot: MapView = { ...v, rot: 0 };
      const a2 = w2s(noRot, WORLD.minX, WORLD.minZ);
      const ax2 = a2.x;
      const ay2 = a2.y;
      const b2 = w2s(noRot, WORLD.maxX, WORLD.maxZ);
      ctx.drawImage(style.hillshade, ax2, ay2, b2.x - ax2, b2.y - ay2);
    } else {
      ctx.drawImage(style.hillshade, ax, ay, bx - ax, by - ay);
    }
    ctx.restore();
  }

  // --- parks ---------------------------------------------------------
  ctx.fillStyle = rgba(COLORS.park, 0.95);
  for (const p of PARKS) {
    const s = w2s(v, p.x, p.z);
    const r = p.radius * v.ppm;
    if (r < 2) continue;
    if (s.x + r < 0 || s.x - r > v.w || s.y + r < 0 || s.y - r > v.h) continue;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, r, r * 0.86, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- streets -------------------------------------------------------
  if (v.ppm >= style.minStreetPpm) drawStreets(ctx, v, dim);

  ctx.restore();

  // --- labels --------------------------------------------------------
  if (style.districts) drawDistrictLabels(ctx, v);
  if (style.landmarks) drawLandmarks(ctx, v, style.landmarkLabels);
}

function drawStreets(ctx: CanvasRenderingContext2D, v: MapView, dim: number): void {
  const bounds = visibleBounds(v, 160);
  // Widths in pixels, floored so a zoomed-out map still shows a network
  // rather than a grey haze.
  const wStreet = Math.max(0.5, Math.min(3.2, 9 * v.ppm));
  const wArterial = Math.max(0.7, Math.min(5.5, 15 * v.ppm));
  const wBoulevard = Math.max(1, Math.min(8, 24 * v.ppm));
  const showMinor = v.ppm > 0.05;

  ctx.lineCap = "butt";

  for (const region of REGIONS) {
    if (region.poly.length < 3) continue;
    ctx.save();
    pathPolygon(ctx, v, region.poly);
    ctx.clip();

    const g = region.grid;
    // u/v extent covering the visible rect: transform the four corners of the
    // world-space bounds into grid space.
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    const cs: [number, number][] = [
      [bounds.minX, bounds.minZ],
      [bounds.maxX, bounds.minZ],
      [bounds.maxX, bounds.maxZ],
      [bounds.minX, bounds.maxZ],
    ];
    for (const [x, z] of cs) {
      const q = toGridSpace(x, z, g);
      if (q.u < uMin) uMin = q.u;
      if (q.u > uMax) uMax = q.u;
      if (q.v < vMin) vMin = q.v;
      if (q.v > vMax) vMax = q.v;
    }

    // Two passes so arterials always sit on top of ordinary streets.
    for (let pass = 0; pass < 2; pass++) {
      const arterialPass = pass === 1;
      ctx.strokeStyle = arterialPass
        ? rgba(COLORS.roadMajor, 0.95 * dim)
        : rgba(COLORS.road, 0.85 * dim);
      ctx.lineWidth = arterialPass ? wArterial : wStreet;
      ctx.beginPath();
      for (let u = Math.floor(uMin); u <= Math.ceil(uMax); u++) {
        const isArterial = u % 4 === 0;
        if (isArterial !== arterialPass) continue;
        if (!isArterial && !showMinor) continue;
        const a = fromGridSpace(u, vMin, g);
        const b = fromGridSpace(u, vMax, g);
        const p0 = w2s(v, a.x, a.z);
        const x0 = p0.x;
        const y0 = p0.y;
        const p1 = w2s(v, b.x, b.z);
        ctx.moveTo(x0, y0);
        ctx.lineTo(p1.x, p1.y);
      }
      for (let vv = Math.floor(vMin); vv <= Math.ceil(vMax); vv++) {
        const isArterial = vv % 4 === 0;
        if (isArterial !== arterialPass) continue;
        if (!isArterial && !showMinor) continue;
        const a = fromGridSpace(uMin, vv, g);
        const b = fromGridSpace(uMax, vv, g);
        const p0 = w2s(v, a.x, a.z);
        const x0 = p0.x;
        const y0 = p0.y;
        const p1 = w2s(v, b.x, b.z);
        ctx.moveTo(x0, y0);
        ctx.lineTo(p1.x, p1.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // Market Street last: it is the seam, it is a boulevard, and it is the one
  // street every San Franciscan navigates by.
  const a = w2s(v, MARKET_STREET.ax, MARKET_STREET.az);
  const ax = a.x;
  const ay = a.y;
  const b = w2s(v, MARKET_STREET.bx, MARKET_STREET.bz);
  ctx.strokeStyle = rgba(COLORS.roadBoulevard, 0.95 * dim);
  ctx.lineWidth = wBoulevard;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function drawDistrictLabels(ctx: CanvasRenderingContext2D, v: MapView): void {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const d of DISTRICTS) {
    const rPx = d.radius * v.ppm;
    // Only label a district when its footprint is big enough to own the name.
    if (rPx < 34) continue;
    const s = w2s(v, d.x, d.z);
    if (s.x < -80 || s.x > v.w + 80 || s.y < -40 || s.y > v.h + 40) continue;
    const size = Math.max(8, Math.min(14, rPx * 0.11));
    const alpha = Math.max(0, Math.min(0.62, (rPx - 34) / 90));
    ctx.font = `600 ${size.toFixed(1)}px Sora, sans-serif`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = `rgba(0,0,0,${(alpha * 1.2).toFixed(2)})`;
    ctx.fillStyle = `rgba(226,232,240,${alpha.toFixed(2)})`;
    const label = d.name.toUpperCase();
    ctx.strokeText(label, s.x, s.y);
    ctx.fillText(label, s.x, s.y);
  }
  ctx.restore();
}

/** Landmark glyphs. Distinct silhouettes so the map is scannable by shape. */
function drawLandmarks(ctx: CanvasRenderingContext2D, v: MapView, labels: boolean): void {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const lm of LANDMARKS) {
    const s = w2s(v, lm.x, lm.z);
    if (s.x < -30 || s.x > v.w + 30 || s.y < -30 || s.y > v.h + 30) continue;
    const major = lm.navpoint;
    const r = major ? 4.6 : 3.2;

    ctx.beginPath();
    if (lm.height > 150) {
      // Towers: an upward triangle.
      ctx.moveTo(s.x, s.y - r * 1.25);
      ctx.lineTo(s.x + r, s.y + r * 0.8);
      ctx.lineTo(s.x - r, s.y + r * 0.8);
      ctx.closePath();
    } else if (lm.radius > 300) {
      // Bridges and islands: a wide lozenge.
      ctx.ellipse(s.x, s.y, r * 1.5, r * 0.75, 0, 0, Math.PI * 2);
    } else {
      // Everything else: a diamond.
      ctx.moveTo(s.x, s.y - r);
      ctx.lineTo(s.x + r, s.y);
      ctx.lineTo(s.x, s.y + r);
      ctx.lineTo(s.x - r, s.y);
      ctx.closePath();
    }
    ctx.fillStyle = major ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.55)";
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.lineWidth = 1.2;
    ctx.fill();
    ctx.stroke();

    if (labels && major && v.ppm > 0.028) {
      ctx.font = "500 9px Sora, sans-serif";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.fillStyle = "rgba(255,255,255,0.78)";
      const label = lm.name.toUpperCase();
      ctx.strokeText(label, s.x, s.y + r + 3);
      ctx.fillText(label, s.x, s.y + r + 3);
    }
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Dynamic overlays
 * ------------------------------------------------------------------ */

/** The player arrow. Always drawn last, always on top, never rotated away. */
export function drawPlayer(
  ctx: CanvasRenderingContext2D,
  v: MapView,
  x: number,
  z: number,
  yaw: number,
): void {
  const s = w2s(v, x, z);
  const sx = s.x;
  const sy = s.y;
  ctx.save();
  ctx.translate(sx, sy);
  // On a rotating map the arrow points up by definition; on a north-up map it
  // carries the heading.
  ctx.rotate(-v.rot - yaw + Math.PI);
  ctx.beginPath();
  ctx.moveTo(0, -9);
  ctx.lineTo(6.4, 7);
  ctx.lineTo(0, 3.6);
  ctx.lineTo(-6.4, 7);
  ctx.closePath();
  ctx.fillStyle = COLORS.signal;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.lineWidth = 1.4;
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // View cone — a soft wedge showing where the camera is pointed.
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(-v.rot - yaw + Math.PI);
  const cone = ctx.createRadialGradient(0, 0, 2, 0, 0, 54);
  cone.addColorStop(0, rgba(COLORS.signal, 0.3));
  cone.addColorStop(1, rgba(COLORS.signal, 0));
  ctx.fillStyle = cone;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, 54, -Math.PI / 2 - 0.52, -Math.PI / 2 + 0.52);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** A generic pin: objective, waypoint, discovery. */
export function drawPin(
  ctx: CanvasRenderingContext2D,
  v: MapView,
  x: number,
  z: number,
  color: string,
  kind: "objective" | "waypoint" | "contact" = "objective",
  pulse = 0,
): void {
  const s = w2s(v, x, z);
  drawPinAt(ctx, s.x, s.y, color, kind, pulse);
}

/**
 * The same pin, positioned in screen space. Split out because the minimap
 * clamps off-disc pins to its rim, which means it needs to draw at a screen
 * position that no longer corresponds to a world position.
 */
export function drawPinAt(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  color: string,
  kind: "objective" | "waypoint" | "contact" = "objective",
  pulse = 0,
): void {
  ctx.save();
  ctx.translate(sx, sy);
  if (pulse > 0) {
    ctx.beginPath();
    ctx.arc(0, 0, 6 + pulse * 12, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(color, (1 - pulse) * 0.7);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.beginPath();
  if (kind === "waypoint") {
    ctx.moveTo(0, -8);
    ctx.lineTo(6, 0);
    ctx.lineTo(0, 8);
    ctx.lineTo(-6, 0);
    ctx.closePath();
  } else if (kind === "contact") {
    ctx.arc(0, 0, 3.4, 0, Math.PI * 2);
  } else {
    ctx.moveTo(0, -9);
    ctx.lineTo(7, 5);
    ctx.lineTo(-7, 5);
    ctx.closePath();
  }
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.lineWidth = 1.3;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Heat/search overlay — a soft red disc where the police think you are. */
export function drawHeat(
  ctx: CanvasRenderingContext2D,
  v: MapView,
  x: number,
  z: number,
  radiusM: number,
  intensity: number,
): void {
  if (intensity <= 0) return;
  const s = w2s(v, x, z);
  const r = Math.max(12, radiusM * v.ppm);
  const g = ctx.createRadialGradient(s.x, s.y, r * 0.15, s.x, s.y, r);
  g.addColorStop(0, rgba(COLORS.heat, 0.28 * intensity));
  g.addColorStop(0.65, rgba(COLORS.heat, 0.12 * intensity));
  g.addColorStop(1, rgba(COLORS.heat, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = rgba(COLORS.heat, 0.35 * intensity);
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 6]);
  ctx.stroke();
  ctx.setLineDash([]);
}
