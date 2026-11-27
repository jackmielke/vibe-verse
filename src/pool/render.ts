/**
 * Drawing the table. Canvas 2D, top down, with the table turned upright on a
 * portrait screen.
 *
 * The balls are shaded per pixel, every frame they move: each pixel of the
 * disc is a point on a sphere, turned back through the ball's orientation, so
 * the stripes and the number circles roll exactly the way the physics spins
 * them. The cue ball carries six small dots for the same reason real practice
 * balls do: you can see the draw and the side working.
 *
 * Everything that does not move (rails, cloth, pockets) is drawn once into an
 * offscreen layer and blitted.
 */
import {
  type Ball, CUSHIONS, CORNER_MOUTH, HEAD_STRING, FOOT_SPOT, L, POCKETS, R, SIDE_MOUTH, W,
} from "./physics";
import { BALL_COLORS, type PoolTheme } from "./themes";

export const FRAME = 0.115; // rail plus cushion, metres

export interface View {
  width: number;
  height: number;
  dpr: number;
  s: number; // css px per metre
  cx: number;
  cy: number;
  portrait: boolean;
}

export function fitView(width: number, height: number, dpr: number): View {
  const portrait = height > width * 1.05;
  const tw = (portrait ? W : L) + FRAME * 2;
  const th = (portrait ? L : W) + FRAME * 2;
  const s = Math.min(width / tw, height / th);
  return { width, height, dpr, s, cx: width / 2, cy: height / 2, portrait };
}

export function toScreen(v: View, x: number, y: number): [number, number] {
  return v.portrait ? [v.cx - y * v.s, v.cy - x * v.s] : [v.cx + x * v.s, v.cy - y * v.s];
}

export function toTable(v: View, X: number, Y: number): [number, number] {
  return v.portrait ? [-(Y - v.cy) / v.s, -(X - v.cx) / v.s] : [(X - v.cx) / v.s, -(Y - v.cy) / v.s];
}

/* --------------------------------------------------------------- table */

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** The static layer: rails, cloth, cushions, pockets, sights. */
export function drawTable(v: View, theme: PoolTheme): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.round(v.width * v.dpr);
  c.height = Math.round(v.height * v.dpr);
  const ctx = c.getContext("2d")!;
  ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  const P = (x: number, y: number) => toScreen(v, x, y);
  const hx = L / 2;
  const hy = W / 2;

  // The rail frame.
  const [ax, ay] = P(-hx - FRAME, hy + FRAME);
  const [bx, by] = P(hx + FRAME, -hy - FRAME);
  const x0 = Math.min(ax, bx);
  const y0 = Math.min(ay, by);
  const fw = Math.abs(bx - ax);
  const fh = Math.abs(by - ay);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 12;
  roundRect(ctx, x0, y0, fw, fh, FRAME * v.s * 0.55);
  ctx.fillStyle = theme.rail[1];
  ctx.fill();
  ctx.restore();
  // Bevel: a gradient from the outside in.
  const inset = FRAME * v.s;
  for (let i = 0; i < 3; i++) {
    const k = i / 3;
    roundRect(ctx, x0 + inset * k * 0.45, y0 + inset * k * 0.45, fw - inset * k * 0.9, fh - inset * k * 0.9, FRAME * v.s * (0.55 - k * 0.3));
    ctx.fillStyle = theme.rail[i];
    ctx.fill();
  }
  // Wood grain, or brushed metal: thin lines along the rails.
  ctx.save();
  roundRect(ctx, x0, y0, fw, fh, FRAME * v.s * 0.55);
  ctx.clip();
  ctx.globalAlpha = 0.08;
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    const t = rnd();
    ctx.beginPath();
    if (rnd() < 0.5) {
      const yy = y0 + t * fh;
      ctx.moveTo(x0, yy);
      ctx.bezierCurveTo(x0 + fw * 0.3, yy + rnd() * 4 - 2, x0 + fw * 0.7, yy + rnd() * 4 - 2, x0 + fw, yy);
    } else {
      const xx = x0 + t * fw;
      ctx.moveTo(xx, y0);
      ctx.bezierCurveTo(xx + rnd() * 4 - 2, y0 + fh * 0.3, xx + rnd() * 4 - 2, y0 + fh * 0.7, xx, y0 + fh);
    }
    ctx.stroke();
  }
  ctx.restore();
  // A highlight line round the top of the rail.
  ctx.save();
  roundRect(ctx, x0 + 2, y0 + 2, fw - 4, fh - 4, FRAME * v.s * 0.5);
  ctx.strokeStyle = theme.railLine;
  ctx.lineWidth = 1.2;
  if (theme.glow) { ctx.shadowColor = theme.glow; ctx.shadowBlur = 10; }
  ctx.stroke();
  ctx.restore();

  // Cloth, out to the back of the cushions.
  const C = 0.042; // cushion depth
  const [cx0, cy0] = P(-hx - C, hy + C);
  const [cx1, cy1] = P(hx + C, -hy - C);
  const clothX = Math.min(cx0, cx1);
  const clothY = Math.min(cy0, cy1);
  const clothW = Math.abs(cx1 - cx0);
  const clothH = Math.abs(cy1 - cy0);
  const g = ctx.createRadialGradient(v.cx, v.cy, 0, v.cx, v.cy, Math.max(clothW, clothH) * 0.62);
  g.addColorStop(0, theme.clothLight);
  g.addColorStop(0.55, theme.cloth);
  g.addColorStop(1, theme.clothDark);
  ctx.fillStyle = g;
  ctx.fillRect(clothX, clothY, clothW, clothH);
  // Nap: faint speckle.
  ctx.save();
  ctx.beginPath();
  ctx.rect(clothX, clothY, clothW, clothH);
  ctx.clip();
  const dots = Math.round(clothW * clothH * 0.05);
  for (let i = 0; i < dots; i++) {
    ctx.fillStyle = rnd() < 0.5 ? "rgba(255,255,255,0.035)" : "rgba(0,0,0,0.05)";
    ctx.fillRect(clothX + rnd() * clothW, clothY + rnd() * clothH, 1, 1);
  }
  if (theme.sparkle) {
    for (let i = 0; i < 160; i++) {
      const r = rnd();
      ctx.globalAlpha = 0.15 + r * 0.55;
      ctx.fillStyle = theme.sparkle;
      ctx.beginPath();
      ctx.arc(clothX + rnd() * clothW, clothY + rnd() * clothH, 0.4 + r * r * 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // Cushions: the strip between each nose and the back of the cloth.
  const J = 0.05;
  const cushionPolys: [number, number][][] = [];
  for (const sy of [1, -1]) {
    const y = sy * hy;
    const back = y + sy * C;
    // Left and right halves of each long rail.
    cushionPolys.push([
      [-hx + CORNER_MOUTH - J * 0.8, back], [-hx + CORNER_MOUTH, y], [-SIDE_MOUTH, y], [-SIDE_MOUTH + 0.012 * 0.84, back],
    ]);
    cushionPolys.push([
      [SIDE_MOUTH - 0.012 * 0.84, back], [SIDE_MOUTH, y], [hx - CORNER_MOUTH, y], [hx - CORNER_MOUTH + J * 0.8, back],
    ]);
  }
  for (const sx of [1, -1]) {
    const x = sx * hx;
    const back = x + sx * C;
    cushionPolys.push([
      [back, -hy + CORNER_MOUTH - J * 0.8], [x, -hy + CORNER_MOUTH], [x, hy - CORNER_MOUTH], [back, hy - CORNER_MOUTH + J * 0.8],
    ]);
  }
  for (const poly of cushionPolys) {
    ctx.beginPath();
    poly.forEach(([px, py], i) => {
      const [X, Y] = P(px, py);
      if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    });
    ctx.closePath();
    ctx.fillStyle = theme.cushion;
    ctx.fill();
    // The nose catches the light.
    const [n1x, n1y] = P(poly[1][0], poly[1][1]);
    const [n2x, n2y] = P(poly[2][0], poly[2][1]);
    ctx.beginPath();
    ctx.moveTo(n1x, n1y);
    ctx.lineTo(n2x, n2y);
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(n1x, n1y);
    ctx.lineTo(n2x, n2y);
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 3;
    ctx.globalCompositeOperation = "destination-over";
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
  }
  void CUSHIONS;

  // Pockets.
  for (const p of POCKETS) {
    const [X, Y] = P(p.x, p.y);
    const rad = (p.corner ? 0.054 : 0.05) * v.s;
    ctx.save();
    ctx.beginPath();
    ctx.arc(X, Y, rad * 1.1, 0, Math.PI * 2);
    ctx.fillStyle = hexA(theme.pocketRim, 0.7);
    if (theme.glow) { ctx.shadowColor = theme.pocketRim; ctx.shadowBlur = 12; }
    ctx.fill();
    ctx.restore();
    const pg = ctx.createRadialGradient(X, Y, rad * 0.2, X, Y, rad);
    pg.addColorStop(0, "#000");
    pg.addColorStop(0.75, theme.pocket);
    pg.addColorStop(1, "rgba(40,40,40,1)");
    ctx.beginPath();
    ctx.arc(X, Y, rad, 0, Math.PI * 2);
    ctx.fillStyle = pg;
    ctx.fill();
  }

  // Sights on the rails: three between each pair of pockets.
  const dotAt = (x: number, y: number) => {
    const [X, Y] = P(x, y);
    ctx.beginPath();
    ctx.arc(X, Y, Math.max(1.6, 0.0075 * v.s), 0, Math.PI * 2);
    ctx.fillStyle = theme.diamond;
    if (theme.glow) { ctx.shadowColor = theme.diamond; ctx.shadowBlur = 8; }
    ctx.fill();
    ctx.shadowBlur = 0;
  };
  const rail = hy + C + (FRAME - C) * 0.5;
  for (let i = 1; i < 8; i++) {
    if (i === 4) continue;
    const x = -hx + (L / 8) * i;
    dotAt(x, rail);
    dotAt(x, -rail);
  }
  const railX = hx + C + (FRAME - C) * 0.5;
  for (let i = 1; i < 4; i++) {
    const y = -hy + (W / 4) * i;
    dotAt(railX, y);
    dotAt(-railX, y);
  }

  // Head string and spots, barely there.
  const [h1x, h1y] = P(HEAD_STRING, hy);
  const [h2x, h2y] = P(HEAD_STRING, -hy);
  ctx.beginPath();
  ctx.moveTo(h1x, h1y);
  ctx.lineTo(h2x, h2y);
  ctx.strokeStyle = "rgba(255,255,255,0.09)";
  ctx.lineWidth = 1;
  ctx.stroke();
  for (const sp of [FOOT_SPOT, { x: HEAD_STRING, y: 0 }]) {
    const [X, Y] = P(sp.x, sp.y);
    ctx.beginPath();
    ctx.arc(X, Y, 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fill();
  }
  return c;
}

/* --------------------------------------------------------------- balls */

const LIGHT = (() => {
  const v = [-0.38, -0.55, 0.74];
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
})();

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const RGB: Record<number, [number, number, number]> = Object.fromEntries(
  Object.entries(BALL_COLORS).map(([k, v]) => [Number(k), hexRgb(v)]),
);
const IVORY: [number, number, number] = [247, 244, 234];
const DOT: [number, number, number] = [214, 38, 52];

/** Rotate v by the inverse of q (world to ball). */
function toBody(q: [number, number, number, number], x: number, y: number, z: number): [number, number, number] {
  const w = q[0];
  const qx = -q[1];
  const qy = -q[2];
  const qz = -q[3];
  // v' = q* v q*^-1, with q* the conjugate.
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + w * tx + (qy * tz - qz * ty),
    y + w * ty + (qz * tx - qx * tz),
    z + w * tz + (qx * ty - qy * tx),
  ];
}

/** Rotate v by q (ball to world). */
function toWorld(q: [number, number, number, number], x: number, y: number, z: number): [number, number, number] {
  const w = q[0];
  const qx = q[1];
  const qy = q[2];
  const qz = q[3];
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + w * tx + (qy * tz - qz * ty),
    y + w * ty + (qz * tx - qx * tz),
    z + w * tz + (qx * ty - qy * tx),
  ];
}

interface Sprite { canvas: HTMLCanvasElement; key: string }
const sprites = new Map<number, Sprite>();

const SPOT_COS = Math.cos(0.5);
const DOT_COS = Math.cos(0.16);

function shadeBall(id: number, q: [number, number, number, number], rpx: number, portrait: boolean): HTMLCanvasElement {
  const size = Math.ceil(rpx * 2) + 2;
  const key = `${q[0].toFixed(4)},${q[1].toFixed(4)},${q[2].toFixed(4)},${q[3].toFixed(4)},${rpx.toFixed(2)},${portrait}`;
  const cached = sprites.get(id);
  if (cached && cached.key === key) return cached.canvas;
  const canvas = cached?.canvas ?? document.createElement("canvas");
  if (canvas.width !== size) { canvas.width = size; canvas.height = size; }
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const c = size / 2;
  const base = RGB[id];
  const stripe = id >= 9;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sx = (px + 0.5 - c) / rpx;
      const sy = (py + 0.5 - c) / rpx;
      const r2 = sx * sx + sy * sy;
      if (r2 > 1.08) continue;
      const rr = Math.sqrt(r2);
      const edge = Math.max(0, Math.min(1, (1 - rr) * rpx + 0.5));
      if (edge <= 0) continue;
      const nz = Math.sqrt(Math.max(0, 1 - Math.min(1, r2)));
      // Screen normal to table normal.
      const tx = portrait ? -sy : sx;
      const ty = portrait ? -sx : -sy;
      const [bx, by, bz] = toBody(q, tx, ty, nz);
      let col: [number, number, number];
      if (id === 0) {
        const m = Math.max(Math.abs(bx), Math.abs(by), Math.abs(bz));
        col = m > DOT_COS ? DOT : IVORY;
      } else if (Math.abs(bx) > SPOT_COS) {
        col = IVORY; // the number circle
      } else if (stripe) {
        col = Math.abs(bz) < 0.52 ? base : IVORY;
      } else {
        col = base;
      }
      const lam = Math.max(0, sx * LIGHT[0] + sy * LIGHT[1] + nz * LIGHT[2]);
      const shade = 0.3 + 0.78 * lam;
      // A touch of the cloth bouncing back up into the underside.
      const rim = Math.pow(rr, 6) * 0.25;
      const i = (py * size + px) * 4;
      d[i] = Math.min(255, col[0] * shade * (1 - rim));
      d[i + 1] = Math.min(255, col[1] * shade * (1 - rim));
      d[i + 2] = Math.min(255, col[2] * shade * (1 - rim));
      d[i + 3] = 255 * edge;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Numbers, on whichever circles face us.
  if (id !== 0) {
    for (const sgn of [1, -1]) {
      const [nx, ny, nz] = toWorld(q, sgn, 0, 0);
      if (nz < 0.2) continue;
      const [ex, ey] = toWorld(q, 0, 1, 0);
      const [fx, fy] = toWorld(q, 0, 0, 1);
      // Table to screen for in-plane vectors.
      const scr = (x: number, y: number): [number, number] => (portrait ? [-y, -x] : [x, -y]);
      const [cX, cY] = scr(nx, ny);
      const [eX, eY] = scr(ex, ey);
      const [fX, fY] = scr(fx, fy);
      const k = rpx * 0.0052;
      ctx.save();
      ctx.globalAlpha = Math.min(1, (nz - 0.2) * 3);
      ctx.setTransform(eX * k * sgn, eY * k * sgn, -fX * k, -fY * k, c + cX * rpx, c + cY * rpx);
      ctx.font = "900 100px system-ui, -apple-system, Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#151515";
      ctx.fillText(String(id), 0, 6);
      ctx.restore();
    }
  }
  // Gloss.
  const hx = c + LIGHT[0] * rpx * 0.52;
  const hy = c + LIGHT[1] * rpx * 0.52;
  const gl = ctx.createRadialGradient(hx, hy, 0, hx, hy, rpx * 0.55);
  gl.addColorStop(0, "rgba(255,255,255,0.95)");
  gl.addColorStop(0.25, "rgba(255,255,255,0.35)");
  gl.addColorStop(1, "rgba(255,255,255,0)");
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = gl;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = "source-over";
  sprites.set(id, { canvas, key });
  return canvas;
}

export interface Drop {
  id: number;
  x: number;
  y: number;
  pocket: number;
  t: number; // seconds since it fell
}

/** A ball sprite at a screen point, for the HUD and the table. */
export function drawBallAt(ctx: CanvasRenderingContext2D, v: View, b: Ball, X: number, Y: number, scale = 1, alpha = 1) {
  const rpx = R * v.s * v.dpr * scale;
  const spr = shadeBall(b.id, b.q, rpx, v.portrait);
  ctx.save();
  ctx.globalAlpha = alpha;
  const sz = spr.width / v.dpr;
  ctx.drawImage(spr, X - sz / 2, Y - sz / 2, sz, sz);
  ctx.restore();
}

/* ----------------------------------------------------------- overlays */

export interface Guide {
  /** Where the cue ball's path ends: a ball contact or a cushion. */
  end: { x: number; y: number };
  hit: number | null;
  /** Object ball's line, unit vector. */
  obj?: { x: number; y: number };
  /** Cue ball's line after contact (stun), unit vector, scaled by how full. */
  cue?: { x: number; y: number; k: number };
  /** Reflection off a cushion, when the first thing hit is the rail. */
  bounce?: { x: number; y: number };
}

export function aimGuide(balls: Ball[], angle: number): Guide {
  const cue = balls[0];
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let best = Infinity;
  let hit: number | null = null;
  for (const b of balls) {
    if (!b.on || b.id === 0) continue;
    const ox = b.x - cue.x;
    const oy = b.y - cue.y;
    const t = ox * dx + oy * dy;
    if (t <= 0) continue;
    const perp2 = ox * ox + oy * oy - t * t;
    const rr = 4 * R * R;
    if (perp2 > rr) continue;
    const tt = t - Math.sqrt(rr - perp2);
    if (tt < best) { best = tt; hit = b.id; }
  }
  // The cushion box the cue ball's centre can reach.
  const hx = L / 2 - R;
  const hy = W / 2 - R;
  let tw = Infinity;
  let nx = 0;
  let ny = 0;
  if (dx > 1e-9) { const t = (hx - cue.x) / dx; if (t < tw) { tw = t; nx = -1; ny = 0; } }
  if (dx < -1e-9) { const t = (-hx - cue.x) / dx; if (t < tw) { tw = t; nx = 1; ny = 0; } }
  if (dy > 1e-9) { const t = (hy - cue.y) / dy; if (t < tw) { tw = t; nx = 0; ny = -1; } }
  if (dy < -1e-9) { const t = (-hy - cue.y) / dy; if (t < tw) { tw = t; nx = 0; ny = 1; } }
  if (hit !== null && best < tw) {
    const gx = cue.x + dx * best;
    const gy = cue.y + dy * best;
    const b = balls[hit];
    const ox = b.x - gx;
    const oy = b.y - gy;
    const on = Math.hypot(ox, oy) || 1;
    const ux = ox / on;
    const uy = oy / on;
    const full = dx * ux + dy * uy;
    let cx = dx - full * ux;
    let cy = dy - full * uy;
    const cn = Math.hypot(cx, cy);
    if (cn > 1e-6) { cx /= cn; cy /= cn; }
    return { end: { x: gx, y: gy }, hit, obj: { x: ux, y: uy }, cue: cn > 1e-6 ? { x: cx, y: cy, k: Math.sqrt(1 - full * full) } : undefined };
  }
  const ex = cue.x + dx * tw;
  const ey = cue.y + dy * tw;
  const dot = dx * nx + dy * ny;
  return { end: { x: ex, y: ey }, hit: null, bounce: { x: dx - 2 * dot * nx, y: dy - 2 * dot * ny } };
}

export interface Overlay {
  aim: number | null;
  /** 0..1, how far the cue is drawn back. */
  pull: number;
  guide: boolean;
  /** Draw the guide's object line this long, in metres. */
  guideLen: number;
  ballInHand: boolean;
  kitchen: boolean;
  called: number | null;
  /** Pockets the shooter may call, flashing, when on the 8. */
  calling: boolean;
  time: number;
  /** Tip offset, for the little dot on the cue ball. */
  spinX: number;
  spinY: number;
}

function drawCue(ctx: CanvasRenderingContext2D, v: View, theme: PoolTheme, X: number, Y: number, ux: number, uy: number, pull: number) {
  const s = v.s;
  const gap = R * s + 0.012 * s + pull * 0.22 * s;
  const len = 1.42 * s;
  ctx.save();
  ctx.translate(X, Y);
  ctx.rotate(Math.atan2(uy, ux) + Math.PI);
  // Shadow on the cloth.
  ctx.save();
  ctx.translate(6, 9);
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.moveTo(gap, -0.006 * s);
  ctx.lineTo(gap + len, -0.016 * s);
  ctx.lineTo(gap + len, 0.016 * s);
  ctx.lineTo(gap, 0.006 * s);
  ctx.closePath();
  ctx.filter = "blur(3px)";
  ctx.fill();
  ctx.restore();
  const w0 = 0.0062 * s;
  const w1 = 0.0155 * s;
  const at = (f: number) => w0 + (w1 - w0) * f;
  const piece = (f0: number, f1: number, fill: string | CanvasGradient) => {
    ctx.beginPath();
    ctx.moveTo(gap + len * f0, -at(f0));
    ctx.lineTo(gap + len * f1, -at(f1));
    ctx.lineTo(gap + len * f1, at(f1));
    ctx.lineTo(gap + len * f0, at(f0));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  piece(0, 0.008, "#3a7bd5"); // chalked tip
  piece(0.008, 0.022, "#f4f1e8"); // ferrule
  piece(0.022, 0.55, theme.cue.shaft);
  piece(0.55, 0.565, theme.cue.ring);
  const butt = ctx.createLinearGradient(gap + len * 0.565, 0, gap + len, 0);
  butt.addColorStop(0, theme.cue.butt);
  butt.addColorStop(1, theme.cue.buttDark);
  piece(0.565, 0.72, butt);
  piece(0.72, 0.9, theme.cue.wrap);
  piece(0.9, 0.995, butt);
  piece(0.995, 1, theme.cue.ring);
  // Roundness: a light stripe along the top.
  const sh = ctx.createLinearGradient(0, -w1, 0, w1);
  sh.addColorStop(0, "rgba(255,255,255,0)");
  sh.addColorStop(0.3, "rgba(255,255,255,0.45)");
  sh.addColorStop(0.5, "rgba(255,255,255,0.05)");
  sh.addColorStop(1, "rgba(0,0,0,0.35)");
  piece(0, 1, sh);
  ctx.restore();
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  v: View,
  theme: PoolTheme,
  table: HTMLCanvasElement,
  balls: Ball[],
  drops: Drop[],
  o: Overlay,
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.drawImage(table, 0, 0);
  ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  const P = (x: number, y: number) => toScreen(v, x, y);
  const rp = R * v.s;

  // Called pocket for the 8, and the others when choosing.
  POCKETS.forEach((p, i) => {
    const chosen = o.called === i;
    if (!chosen && !o.calling) return;
    const [X, Y] = P(p.mx, p.my);
    const pulse = 0.5 + 0.5 * Math.sin(o.time * 5);
    ctx.beginPath();
    ctx.arc(X, Y, (chosen ? 0.05 : 0.04) * v.s + pulse * 2, 0, Math.PI * 2);
    ctx.strokeStyle = chosen ? theme.accent : "rgba(255,255,255,0.35)";
    ctx.lineWidth = chosen ? 3 : 1.5;
    ctx.setLineDash(chosen ? [] : [4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (chosen) {
      ctx.fillStyle = theme.accent;
      ctx.font = `900 ${Math.max(10, 0.03 * v.s)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const [IX, IY] = P(p.mx * 0.9, p.my * 0.82);
      ctx.fillText("8", IX, IY);
    }
  });

  // Kitchen, while placing the break.
  if (o.ballInHand && o.kitchen) {
    const [a1, b1] = P(-L / 2, W / 2);
    const [a2, b2] = P(HEAD_STRING, -W / 2);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(Math.min(a1, a2), Math.min(b1, b2), Math.abs(a2 - a1), Math.abs(b2 - b1));
    const [l1x, l1y] = P(HEAD_STRING, W / 2);
    const [l2x, l2y] = P(HEAD_STRING, -W / 2);
    ctx.beginPath();
    ctx.moveTo(l1x, l1y);
    ctx.lineTo(l2x, l2y);
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Shadows first, so no ball's shadow lands on another ball.
  const shadowAt = (X: number, Y: number, k = 1) => {
    const g = ctx.createRadialGradient(X + rp * 0.3, Y + rp * 0.42, rp * 0.2, X + rp * 0.3, Y + rp * 0.42, rp * 1.25 * k);
    g.addColorStop(0, "rgba(0,0,0,0.5)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(X + rp * 0.3, Y + rp * 0.42, rp * 1.25 * k, 0, Math.PI * 2);
    ctx.fill();
  };
  for (const b of balls) {
    if (!b.on) continue;
    const [X, Y] = P(b.x, b.y);
    shadowAt(X, Y);
  }

  // The guide.
  const cue = balls[0];
  if (o.aim !== null && cue.on && o.guide) {
    const g = aimGuide(balls, o.aim);
    const [cX, cY] = P(cue.x, cue.y);
    const [eX, eY] = P(g.end.x, g.end.y);
    ctx.save();
    ctx.strokeStyle = theme.guide;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 6]);
    ctx.lineDashOffset = -o.time * 18;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(cX, cY);
    ctx.lineTo(eX, eY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // Ghost ball.
    ctx.beginPath();
    ctx.arc(eX, eY, rp, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fill();
    if (g.obj && g.hit !== null) {
      const b = balls[g.hit];
      const [bX, bY] = P(b.x, b.y);
      const [tX, tY] = P(b.x + g.obj.x * o.guideLen, b.y + g.obj.y * o.guideLen);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = theme.accent;
      ctx.beginPath();
      ctx.moveTo(bX, bY);
      ctx.lineTo(tX, tY);
      ctx.stroke();
      if (g.cue) {
        const n = o.guideLen * 0.6 * Math.max(0.25, g.cue.k);
        const [qX, qY] = P(g.end.x + g.cue.x * n, g.end.y + g.cue.y * n);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = theme.guide;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.moveTo(eX, eY);
        ctx.lineTo(qX, qY);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    } else if (g.bounce) {
      const n = o.guideLen * 0.6;
      const [qX, qY] = P(g.end.x + g.bounce.x * n, g.end.y + g.bounce.y * n);
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(eX, eY);
      ctx.lineTo(qX, qY);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // Balls falling into pockets.
  for (const d of drops) {
    const k = Math.min(1, d.t / 0.22);
    const p = POCKETS[d.pocket];
    const x = d.x + (p.x - d.x) * k;
    const y = d.y + (p.y - d.y) * k;
    const [X, Y] = P(x, y);
    drawBallAt(ctx, v, balls[d.id], X, Y, 1 - 0.35 * k, 1 - k * 0.9);
  }

  // Balls.
  for (const b of balls) {
    if (!b.on) continue;
    const [X, Y] = P(b.x, b.y);
    drawBallAt(ctx, v, b, X, Y);
  }

  // Ball in hand: a pulsing ring.
  if (o.ballInHand && cue.on) {
    const [X, Y] = P(cue.x, cue.y);
    const pulse = 0.5 + 0.5 * Math.sin(o.time * 4);
    ctx.beginPath();
    ctx.arc(X, Y, rp * (1.6 + pulse * 0.35), 0, Math.PI * 2);
    ctx.strokeStyle = theme.accent;
    ctx.globalAlpha = 0.5 + pulse * 0.4;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // The cue.
  if (o.aim !== null && cue.on) {
    const [X, Y] = P(cue.x, cue.y);
    const [aX, aY] = P(cue.x + Math.cos(o.aim), cue.y + Math.sin(o.aim));
    const ux = aX - X;
    const uy = aY - Y;
    const n = Math.hypot(ux, uy) || 1;
    // The tip sits where the spin control says on the ball.
    const px = -uy / n;
    const py = ux / n;
    const off = o.spinX * rp * 0.45;
    drawCue(ctx, v, theme, X + px * off, Y + py * off, ux / n, uy / n, o.pull);
  }
}

export function clearSprites() {
  sprites.clear();
}

export { hexA };
