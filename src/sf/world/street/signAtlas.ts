/**
 * signAtlas.ts — every sign in the city on one texture.
 *
 * The signage layer is one material and one draw call per chunk, which means
 * every sign face has to come out of a single atlas. This module bakes it.
 *
 * Nothing here uses a font. That is deliberate: `ctx.fillText` depends on what
 * is installed on the machine, and the screenshot harness diffs frames — a
 * build box without a CJK font would silently replace all of Chinatown with
 * tofu boxes. So the glyphs are drawn as strokes. Han characters get a real
 * structural grammar (a frame, a spine, evenly spaced horizontals, a couple of
 * diagonals) rather than random scribble, because that structure is what the
 * eye recognises at thirty metres; Latin retail signage gets neon tube shapes,
 * which is what you actually read on a bar sign anyway.
 *
 * Layout, on a square atlas divided into quarters vertically:
 *   row 0   8 × (1/8 × 1/4)  vertical Chinatown neon blades
 *   row 1   3 × (1/4 × 1/4)  shop box signs, + one cell of 4×4 flat swatches
 *   row 2   2 × (1/2 × 1/4)  bar / restaurant projecting signs
 *   row 3   2 × (1/2 × 1/4)  billboards
 */
import * as THREE from "three";
import type { QualityTier } from "../../config";
import { makeRng, type Rng } from "../../math/rng";
import { canvasTexture, makeSurface, type Ctx2D } from "../../materials";

export type UVRect = [number, number, number, number];

export interface SignAtlas {
  texture: THREE.CanvasTexture;
  /** Vertical Chinatown neon blades, tall and narrow. */
  neonV: UVRect[];
  /** Flat shop signs above a ground floor. */
  shop: UVRect[];
  /** Projecting bar / restaurant signs. */
  blade: UVRect[];
  /** Big rented advertising faces. */
  billboard: UVRect[];
  /** Flat colour swatches: [frame, lanternRed, lanternGold, awningA, awningB,
   *  darkPanel, whiteTube, ...]. */
  swatch: UVRect[];
  size: number;
}

/* ------------------------------------------------------------------ *
 * Neon drawing primitives
 * ------------------------------------------------------------------ */

/**
 * A neon tube stroke: a wide soft halo, a mid glow, and a hot near-white core.
 * Three passes is the minimum that reads as *emission* rather than as a
 * coloured line, and it is what makes the night pass work — the bloom in the
 * post chain latches onto the core and blooms the halo outward.
 */
function tube(
  ctx: Ctx2D, pts: number[], width: number, color: string, coreAlpha = 1,
): void {
  if (pts.length < 4) return;
  const stroke = (w: number, style: string, alpha: number) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = style;
    ctx.lineWidth = w;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.stroke();
    ctx.restore();
  };
  stroke(width * 3.4, color, 0.16);
  stroke(width * 1.8, color, 0.42);
  stroke(width, color, 0.95 * coreAlpha);
  stroke(Math.max(1, width * 0.34), "#fffdf6", 0.8 * coreAlpha);
}

/**
 * A Han-style glyph built from strokes.
 *
 * Real characters are made of a small number of components laid out in a
 * square: an enclosing box, a vertical spine, stacks of evenly spaced
 * horizontals, and a pair of splayed diagonals at the bottom. Sampling from
 * that grammar produces marks that are not any particular character but that
 * are unmistakably of the right family — which is exactly what a sign 20 m up
 * needs to be.
 */
function hanGlyph(ctx: Ctx2D, cx: number, cy: number, size: number, rng: Rng, color: string): void {
  const h = size * 0.5;
  const w = Math.max(1.4, size * 0.075);
  const variant = rng.int(0, 5);
  const L = cx - h;
  const R = cx + h;
  const T = cy - h;
  const B = cy + h;

  if (variant === 0 || variant === 3) {
    // Enclosing box (口, 国, 田 family).
    tube(ctx, [L, T, R, T, R, B, L, B, L, T], w, color);
    const inner = rng.int(1, 2);
    for (let i = 1; i <= inner; i++) {
      const y = T + ((B - T) * i) / (inner + 1);
      tube(ctx, [L, y, R, y], w * 0.85, color);
    }
    if (rng.chance(0.5)) tube(ctx, [cx, T, cx, B], w * 0.85, color);
  } else if (variant === 1) {
    // Roof over a stack (安, 家 family).
    tube(ctx, [cx, T, cx, T + size * 0.12], w, color);
    tube(ctx, [L - size * 0.05, T + size * 0.16, R + size * 0.05, T + size * 0.16], w, color);
    tube(ctx, [L + size * 0.08, T + size * 0.16, L + size * 0.02, T + size * 0.34], w * 0.8, color);
    tube(ctx, [R - size * 0.08, T + size * 0.16, R - size * 0.02, T + size * 0.34], w * 0.8, color);
    const rows = rng.int(2, 3);
    for (let i = 0; i < rows; i++) {
      const y = T + size * 0.44 + (i * size * 0.42) / rows;
      tube(ctx, [L + size * 0.14, y, R - size * 0.14, y], w * 0.85, color);
    }
    tube(ctx, [cx, T + size * 0.4, cx, B], w * 0.85, color);
  } else if (variant === 2) {
    // Left radical + right body (酒, 楼 family).
    tube(ctx, [L + size * 0.1, T + size * 0.1, L + size * 0.1, B - size * 0.05], w * 0.85, color);
    tube(ctx, [L, T + size * 0.28, L + size * 0.2, T + size * 0.2], w * 0.7, color);
    tube(ctx, [L, T + size * 0.55, L + size * 0.2, T + size * 0.47], w * 0.7, color);
    const bx = cx + size * 0.06;
    tube(ctx, [bx - size * 0.2, T + size * 0.08, R, T + size * 0.08], w * 0.85, color);
    tube(ctx, [bx, T + size * 0.08, bx, B - size * 0.1], w * 0.85, color);
    for (let i = 0; i < 2; i++) {
      const y = T + size * 0.34 + i * size * 0.26;
      tube(ctx, [bx - size * 0.2, y, R, y], w * 0.8, color);
    }
  } else if (variant === 4) {
    // Horizontal stack with splayed legs (茶, 東 family).
    tube(ctx, [L, T + size * 0.14, R, T + size * 0.14], w, color);
    tube(ctx, [L + size * 0.12, T + size * 0.34, R - size * 0.12, T + size * 0.34], w * 0.85, color);
    tube(ctx, [cx, T + size * 0.04, cx, B - size * 0.28], w * 0.9, color);
    tube(ctx, [cx - size * 0.04, B - size * 0.3, L + size * 0.06, B], w * 0.8, color);
    tube(ctx, [cx + size * 0.04, B - size * 0.3, R - size * 0.06, B], w * 0.8, color);
  } else {
    // Dense grid (龍, 鳳 family) — busy, which is how the big ones read.
    const rows = rng.int(3, 4);
    for (let i = 0; i < rows; i++) {
      const y = T + size * 0.1 + (i * size * 0.8) / (rows - 1);
      tube(ctx, [L + (i % 2) * size * 0.06, y, R - ((i + 1) % 2) * size * 0.06, y], w * 0.8, color);
    }
    tube(ctx, [cx - size * 0.2, T, cx - size * 0.2, B], w * 0.8, color);
    tube(ctx, [cx + size * 0.24, T + size * 0.06, cx + size * 0.24, B - size * 0.04], w * 0.8, color);
  }
}

/** A neon "word": tube shapes with letter-like rhythm, no font required. */
function neonWord(
  ctx: Ctx2D, x0: number, y: number, width: number, height: number, rng: Rng, color: string,
): void {
  const w = Math.max(1.6, height * 0.13);
  let x = x0;
  const end = x0 + width;
  while (x < end - height * 0.3) {
    const lw = height * rng.range(0.32, 0.62);
    const kind = rng.int(0, 4);
    const t = y - height * 0.5;
    const b = y + height * 0.5;
    if (kind === 0) tube(ctx, [x, b, x, t, x + lw, t, x + lw, y, x, y], w, color);
    else if (kind === 1) tube(ctx, [x, b, x, t, x + lw, t, x + lw, b], w, color);
    else if (kind === 2) tube(ctx, [x + lw, t, x, t, x, y, x + lw, y, x + lw, b, x, b], w, color);
    else if (kind === 3) tube(ctx, [x, t, x, b, x + lw, b], w, color);
    else tube(ctx, [x, t, x + lw * 0.5, b, x + lw, t], w, color);
    x += lw + height * rng.range(0.14, 0.26);
  }
}

/* ------------------------------------------------------------------ *
 * Cell painters
 * ------------------------------------------------------------------ */

const NEON_COLOURS = ["#ff2d4a", "#ffc022", "#2fe0ff", "#54ff8a", "#ff6bd0", "#ffffff"];

function paintVerticalNeon(ctx: Ctx2D, x: number, y: number, w: number, h: number, rng: Rng): void {
  // Sheet-metal backing plate, dark and slightly warm.
  ctx.fillStyle = rng.chance(0.5) ? "#1a1116" : "#141a20";
  ctx.fillRect(x, y, w, h);
  // A painted border and a hairline of bare metal at the edges.
  ctx.strokeStyle = "#3a2f2a";
  ctx.lineWidth = Math.max(1, w * 0.03);
  ctx.strokeRect(x + w * 0.04, y + h * 0.02, w * 0.92, h * 0.96);

  const colour = NEON_COLOURS[rng.int(0, NEON_COLOURS.length - 1)];
  const accent = NEON_COLOURS[rng.int(0, NEON_COLOURS.length - 1)];
  const n = rng.int(3, 5);
  const cell = (h * 0.9) / n;
  const size = Math.min(cell * 0.78, w * 0.66);
  for (let i = 0; i < n; i++) {
    hanGlyph(
      ctx,
      x + w * 0.5,
      y + h * 0.05 + cell * (i + 0.5),
      size,
      rng,
      i === 0 ? accent : colour,
    );
  }
  // Chase-light border, the other half of every Chinatown sign.
  if (rng.chance(0.6)) {
    const bulbs = Math.round(h / (w * 0.22));
    for (let i = 0; i < bulbs; i++) {
      const t = (i + 0.5) / bulbs;
      for (const bx of [x + w * 0.075, x + w * 0.925]) {
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = i % 2 === 0 ? "#fff0c0" : "#ffb040";
        ctx.beginPath();
        ctx.arc(bx, y + h * 0.03 + t * h * 0.94, Math.max(1, w * 0.028), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }
}

function paintShop(ctx: Ctx2D, x: number, y: number, w: number, h: number, rng: Rng): void {
  // Internally-lit box sign: a coloured field, a lighter panel, neon lettering.
  const bg = ["#1c2430", "#2a1a20", "#101418", "#241c12"][rng.int(0, 3)];
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  const panel = ["#e8e2d0", "#c8d8e0", "#e0c8a8", "#1a1a1e"][rng.int(0, 3)];
  ctx.fillStyle = panel;
  ctx.fillRect(x + w * 0.05, y + h * 0.16, w * 0.9, h * 0.5);
  // Grime and the uneven backlight every one of these has.
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, "rgba(0,0,0,0.28)");
  g.addColorStop(0.45, "rgba(255,255,255,0.06)");
  g.addColorStop(1, "rgba(0,0,0,0.42)");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  const dark = panel === "#1a1a1e";
  neonWord(
    ctx, x + w * 0.1, y + h * 0.41, w * 0.8, h * 0.26, rng,
    dark ? NEON_COLOURS[rng.int(0, NEON_COLOURS.length - 1)] : "#20242a",
  );
  // Secondary line: hours, phone, "OPEN".
  neonWord(ctx, x + w * 0.14, y + h * 0.8, w * 0.5, h * 0.12, rng, "#ff3a2a");
}

function paintBlade(ctx: Ctx2D, x: number, y: number, w: number, h: number, rng: Rng): void {
  ctx.fillStyle = "#120e10";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#48382c";
  ctx.lineWidth = Math.max(1.5, h * 0.03);
  ctx.strokeRect(x + w * 0.015, y + h * 0.04, w * 0.97, h * 0.92);
  const colour = NEON_COLOURS[rng.int(0, NEON_COLOURS.length - 1)];
  neonWord(ctx, x + w * 0.06, y + h * 0.4, w * 0.88, h * 0.4, rng, colour);
  // The martini glass / arrow / star that every North Beach sign has.
  const cy = y + h * 0.82;
  const cx = x + w * 0.5;
  const s = h * 0.13;
  const glyph = rng.int(0, 2);
  const accent = NEON_COLOURS[rng.int(0, NEON_COLOURS.length - 1)];
  if (glyph === 0) {
    tube(ctx, [cx - s, cy - s, cx + s, cy - s, cx, cy + s * 0.3, cx - s, cy - s], h * 0.02, accent);
    tube(ctx, [cx, cy + s * 0.3, cx, cy + s], h * 0.02, accent);
    tube(ctx, [cx - s * 0.5, cy + s, cx + s * 0.5, cy + s], h * 0.02, accent);
  } else if (glyph === 1) {
    tube(ctx, [cx - s * 1.6, cy, cx + s * 1.6, cy], h * 0.025, accent);
    tube(ctx, [cx + s * 0.7, cy - s * 0.7, cx + s * 1.6, cy, cx + s * 0.7, cy + s * 0.7], h * 0.025, accent);
  } else {
    const pts: number[] = [];
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? s : s * 0.45;
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    tube(ctx, pts, h * 0.02, accent);
  }
}

function paintBillboard(ctx: Ctx2D, x: number, y: number, w: number, h: number, rng: Rng): void {
  // Advertising, abstracted: a bold field, a photographic-looking gradient
  // mass, a block of text and a logo lockup in the corner. No real brands.
  const base = ["#c8342c", "#1d3f7a", "#e8b220", "#1a1a1c", "#0f6a52", "#d8d4c8"][rng.int(0, 5)];
  ctx.fillStyle = base;
  ctx.fillRect(x, y, w, h);
  const g = ctx.createRadialGradient(
    x + w * rng.range(0.2, 0.5), y + h * 0.6, h * 0.05,
    x + w * 0.5, y + h * 0.5, w * 0.7,
  );
  g.addColorStop(0, "rgba(255,255,255,0.42)");
  g.addColorStop(1, "rgba(0,0,0,0.25)");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  // Subject mass.
  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.fillStyle = rng.chance(0.5) ? "#101014" : "#f0ece0";
  ctx.beginPath();
  const bx = x + w * rng.range(0.12, 0.4);
  ctx.ellipse(bx, y + h * 0.62, w * 0.16, h * 0.36, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Headline bars.
  const light = base === "#d8d4c8" || base === "#e8b220";
  ctx.fillStyle = light ? "rgba(20,20,24,0.9)" : "rgba(245,242,232,0.92)";
  let ty = y + h * 0.24;
  for (let i = 0; i < 3; i++) {
    ctx.fillRect(x + w * 0.48, ty, w * rng.range(0.2, 0.44), h * 0.09);
    ty += h * 0.15;
  }
  // Logo lockup.
  ctx.fillStyle = light ? "rgba(20,20,24,0.85)" : "rgba(245,242,232,0.85)";
  ctx.fillRect(x + w * 0.48, y + h * 0.76, w * 0.1, h * 0.1);
  ctx.fillRect(x + w * 0.60, y + h * 0.79, w * 0.16, h * 0.045);
  // Weathering: the paper always lifts at one corner.
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = "#0a0a0c";
  ctx.beginPath();
  ctx.moveTo(x + w, y + h);
  ctx.lineTo(x + w - w * 0.09, y + h);
  ctx.lineTo(x + w, y + h - h * 0.2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** 16 flat swatches used for frames, lanterns, awnings and dark backers. */
const SWATCH_COLOURS = [
  "#3d4145", // 0 painted steel frame
  "#b8231c", // 1 lantern red
  "#d8a92c", // 2 lantern gold
  "#8f2b2b", // 3 awning A
  "#1f4a3a", // 4 awning B
  "#14161a", // 5 dark backer
  "#f2efe4", // 6 white tube / bulb
  "#7a6a52", // 7 timber
  "#2a2e33", // 8 dark steel
  "#c4c0b4", // 9 pale panel
  "#e8d8a8", // 10 warm lit window
  "#5a3a22", // 11 rust
  "#20242a", // 12 near black
  "#ff8a2a", // 13 sodium glow
  "#3c6a8f", // 14 blue panel
  "#9a9488", // 15 concrete
];

/* ------------------------------------------------------------------ *
 * Bake
 * ------------------------------------------------------------------ */

let cached: SignAtlas | null = null;
let cachedTier: QualityTier | null = null;

export function getSignAtlas(tier: QualityTier = "high"): SignAtlas {
  if (cached && cachedTier === tier) return cached;
  disposeSignAtlas();
  const size = tier === "low" ? 512 : 1024;
  const s = makeSurface(size, size);
  const ctx = s.ctx;
  const rng = makeRng("sf-sign-atlas");

  ctx.fillStyle = "#0a0a0c";
  ctx.fillRect(0, 0, size, size);

  const q = size / 4;
  const uv = (x: number, y: number, w: number, h: number): UVRect => {
    // Canvas y is down; three samples with flipY = true by default on
    // CanvasTexture, so v = 1 - (y / size) at the *bottom* of the rect.
    const u0 = x / size;
    const u1 = (x + w) / size;
    const v1 = 1 - y / size;
    const v0 = 1 - (y + h) / size;
    // Half-texel inset stops the atlas bleeding at mip levels.
    const e = 0.6 / size;
    return [u0 + e, v0 + e, u1 - e, v1 - e];
  };

  const neonV: UVRect[] = [];
  const cw = size / 8;
  for (let i = 0; i < 8; i++) {
    paintVerticalNeon(ctx, i * cw, 0, cw, q, rng);
    neonV.push(uv(i * cw, 0, cw, q));
  }

  const shop: UVRect[] = [];
  for (let i = 0; i < 3; i++) {
    paintShop(ctx, i * q, q, q, q, rng);
    shop.push(uv(i * q, q, q, q));
  }

  const swatch: UVRect[] = [];
  const sw = q / 4;
  for (let i = 0; i < 16; i++) {
    const sx = 3 * q + (i % 4) * sw;
    const sy = q + Math.floor(i / 4) * sw;
    ctx.fillStyle = SWATCH_COLOURS[i];
    ctx.fillRect(sx, sy, sw, sw);
    // A little noise so a flat swatch is never mathematically flat.
    ctx.save();
    ctx.globalAlpha = 0.10;
    for (let k = 0; k < 26; k++) {
      ctx.fillStyle = rng.chance(0.5) ? "#ffffff" : "#000000";
      const rx = sx + rng.next() * sw;
      const ry = sy + rng.next() * sw;
      ctx.fillRect(rx, ry, sw * 0.09, sw * 0.09);
    }
    ctx.restore();
    // Inset hard so a swatch never samples its neighbour.
    const inset = sw * 0.18;
    swatch.push(uv(sx + inset, sy + inset, sw - inset * 2, sw - inset * 2));
  }

  const blade: UVRect[] = [];
  for (let i = 0; i < 2; i++) {
    paintBlade(ctx, i * (size / 2), 2 * q, size / 2, q, rng);
    blade.push(uv(i * (size / 2), 2 * q, size / 2, q));
  }

  const billboard: UVRect[] = [];
  for (let i = 0; i < 2; i++) {
    paintBillboard(ctx, i * (size / 2), 3 * q, size / 2, q, rng);
    billboard.push(uv(i * (size / 2), 3 * q, size / 2, q));
  }

  const texture = canvasTexture(s, {
    srgb: true,
    anisotropy: 8,
    wrap: THREE.ClampToEdgeWrapping,
    name: "sf/sign-atlas",
  });

  cached = { texture, neonV, shop, blade, billboard, swatch, size };
  cachedTier = tier;
  return cached;
}

export function disposeSignAtlas(): void {
  if (cached) cached.texture.dispose();
  cached = null;
  cachedTier = null;
}
