/**
 * Vibe Golf — scene rendering.
 *
 * Turns the hole's 2D surface data into extruded 2.5D geometry and dresses it:
 * every `SurfaceMaterial` gets a procedurally generated albedo + normal map
 * (grass blades, sand ripples, rock strata, brushed metal, cracked ice), a lit
 * top-edge treatment, and a per-theme parallax backdrop built from silhouette
 * canvases. Water and lava are live shaders with a wavy surface, caustics and
 * foam. Also owns the ball (outline, dimples, motion trail, contact shadow),
 * the cup + flag, and the aim preview.
 *
 * Everything here is generated at runtime — no external assets. Textures are
 * cached per material for the lifetime of the system so hole reloads only cost
 * geometry, and all slabs of a given material are merged into a single draw
 * call. Budget is roughly 45-60 draws on a typical hole.
 *
 * Ordering rules that other systems depend on: surfaces live on LAYER.course,
 * liquids and the top-edge fringe just in front of them, the ball on
 * LAYER.ball, and the aim preview on LAYER.fx.
 */
import * as THREE from "three";
import type {
  BallState,
  Course,
  CourseTheme,
  GolfCtx,
  GolfQuality,
  Hole,
  Surface,
  SurfaceMaterial,
  System,
  SystemFactory,
  Vec2,
} from "../types";
import { BALL_TYPES } from "../types";
import { LAYER } from "./core";

// ---------------------------------------------------------------------------
// Material look-up tables
// ---------------------------------------------------------------------------

/** Base albedo tint per material — the generated texture is drawn over this. */
const COLORS: Record<SurfaceMaterial, number> = {
  fairway: 0x5cb63c,
  green: 0x74d24a,
  rough: 0x3d8a2a,
  sand: 0xe6d29a,
  stone: 0x6e7b8c,
  metal: 0x9aa4ad,
  wood: 0x9a6b3f,
  ice: 0xbfe9f5,
  rubber: 0xd9456b,
  water: 0x2aa5c9,
  lava: 0xf05a28,
  outOfBounds: 0x333333,
};

/** World metres per texture tile. World-space UVs mean no seams between slabs. */
const TILE: Record<SurfaceMaterial, number> = {
  fairway: 5, green: 3.6, rough: 5, sand: 3.4, stone: 6.5, metal: 4.2,
  wood: 3.4, ice: 4.4, rubber: 1.8, water: 6, lava: 6, outOfBounds: 8,
};

/** roughness, metalness, normal-map strength. */
const PBR: Record<SurfaceMaterial, [number, number, number]> = {
  fairway: [0.95, 0, 0.9], green: [0.9, 0, 0.7], rough: [0.98, 0, 1.1],
  sand: [0.96, 0, 0.7], stone: [0.86, 0.02, 1.2], metal: [0.34, 0.82, 0.45],
  wood: [0.82, 0, 0.7], ice: [0.14, 0.05, 0.55], rubber: [0.99, 0, 0.6],
  water: [0.1, 0, 0.3], lava: [0.7, 0, 0.6], outOfBounds: [1, 0, 0.3],
};

/** Small Z nudges so coplanar overlays (a green mown onto fairway) never fight. */
const Z_BIAS: Record<SurfaceMaterial, number> = {
  fairway: 0, green: 0.09, rough: 0.02, sand: 0.07, stone: 0.01, metal: 0.03,
  wood: 0.03, ice: 0.05, rubber: 0.04, water: 0, lava: 0, outOfBounds: -0.02,
};

/** Which top-edge treatment a material wears. */
type EdgeKind = "turf" | "rock" | "sand" | "hard" | "ice" | "none";
const EDGE_KIND: Record<SurfaceMaterial, EdgeKind> = {
  fairway: "turf", green: "turf", rough: "turf", sand: "sand", stone: "rock",
  metal: "hard", wood: "hard", ice: "ice", rubber: "hard", water: "none",
  lava: "none", outOfBounds: "none",
};

/** How far the fringe ribbon rises above / sinks below the play surface. */
const EDGE_EXTENT: Record<EdgeKind, [number, number]> = {
  turf: [0.62, 1.5], rock: [0.16, 1.0], sand: [0.20, 1.1],
  hard: [0.12, 0.7], ice: [0.26, 0.9], none: [0, 0],
};

/** How far below a ground strip the solid slab extends, metres. */
const SLAB_DEPTH = 90;
const EXTRUDE = 3.2;

/**
 * How far (world metres) an overlay dressing — a mown green, a bunker — fades
 * out at its left and right ends. Blitting the lighter material as a hard
 * axis-aligned edge is the single loudest "unclipped quad" artefact there is.
 */
const OVERLAY_FADE = 4.0;

// ---------------------------------------------------------------------------
// Theme dressing
// ---------------------------------------------------------------------------

interface ThemeSpec {
  skyTop: number; skyMid: number; skyBot: number;
  sun: number; sunAt: [number, number]; sunSize: number;
  key: number; keyI: number;
  hemiSky: number; hemiGround: number; hemiI: number;
  fog: number;
  /** Silhouette colours, far → near. */
  far: number; mid: number; near: number;
  /** Accent used for flags, foam, embers, neon. */
  accent: number;
  stars: boolean;
  /** Ground colour bias and how strongly it is applied. */
  tint: number; tintAmt: number;
  /** Sky cloud density (0 = clear) and the colour they are lit in. */
  clouds: number; cloudCol: number;
  /** Silhouette grammar for the parallax tiers. */
  relief: "peak" | "mesa" | "city" | "cloud";
  /** Vegetation planted along the mid / near ridges. */
  veg: "palm" | "conifer" | "canopy" | "none";
  /** Whether tier 2 is an open water plane with a hard horizon. */
  sea: boolean;
  /** Snow caps on the tallest far peaks. */
  snow: boolean;
}

const THEMES: Record<CourseTheme, ThemeSpec> = {
  seaside: {
    skyTop: 0x123f78, skyMid: 0x4691bf, skyBot: 0xffc98f, sun: 0xffd9a6,
    sunAt: [-32, 30], sunSize: 2.6, key: 0xffe3bc, keyI: 2.5,
    hemiSky: 0x9fd0ff, hemiGround: 0x24402c, hemiI: 1.1, fog: 0x64a2c4,
    far: 0x3f83ae, mid: 0x2f6d97, near: 0x235a83, accent: 0xffb44d,
    stars: false, tint: 0x8fd8ff, tintAmt: 0.05, clouds: 0.5, cloudCol: 0xf2e0cd,
    relief: "peak", veg: "palm", sea: true, snow: false,
  },
  jungle: {
    skyTop: 0x11563f, skyMid: 0x49a97a, skyBot: 0xe4f2a8, sun: 0xfff3c4,
    sunAt: [-28, 34], sunSize: 2.2, key: 0xfff0c4, keyI: 2.4,
    hemiSky: 0xa8ecc8, hemiGround: 0x1a3a20, hemiI: 1.15, fog: 0x76bb9a,
    far: 0x5aa792, mid: 0x459182, near: 0x357c6c, accent: 0xffd34d,
    stars: false, tint: 0x7fffc0, tintAmt: 0.06, clouds: 0.34, cloudCol: 0xdff0d4,
    relief: "peak", veg: "canopy", sea: false, snow: false,
  },
  canyon: {
    skyTop: 0x3c2a5e, skyMid: 0xc2734a, skyBot: 0xffd095, sun: 0xffcf90,
    sunAt: [-34, 26], sunSize: 3.0, key: 0xffd2a2, keyI: 2.6,
    hemiSky: 0xffc79a, hemiGround: 0x3a2018, hemiI: 1.0, fog: 0xc08a63,
    far: 0xb08272, mid: 0x93655c, near: 0x7a4f4c, accent: 0xffa552,
    stars: false, tint: 0xffb27a, tintAmt: 0.08, clouds: 0.36, cloudCol: 0xf0c39a,
    relief: "mesa", veg: "conifer", sea: false, snow: false,
  },
  neon: {
    skyTop: 0x05041a, skyMid: 0x211656, skyBot: 0x4d1f72, sun: 0x8be6ff,
    sunAt: [-36, 44], sunSize: 1.4, key: 0xb7e8ff, keyI: 1.7,
    hemiSky: 0x7b5bff, hemiGround: 0x140a2c, hemiI: 1.25, fog: 0x2c1a63,
    far: 0x3c2c7d, mid: 0x2f2266, near: 0x24194f, accent: 0x2ff5d0,
    stars: true, tint: 0x8fa8ff, tintAmt: 0.1, clouds: 0.24, cloudCol: 0x4a2c7a,
    relief: "city", veg: "none", sea: false, snow: false,
  },
  sky: {
    skyTop: 0x2a72d4, skyMid: 0x8fd2f6, skyBot: 0xf4fbff, sun: 0xffffff,
    sunAt: [-30, 34], sunSize: 2.4, key: 0xffffff, keyI: 2.7,
    hemiSky: 0xdcf1ff, hemiGround: 0x4a6a80, hemiI: 1.3, fog: 0xd7edfb,
    far: 0xbcdcf2, mid: 0xa4cbe9, near: 0x86b8de, accent: 0xffd166,
    stars: false, tint: 0xffffff, tintAmt: 0.04, clouds: 0.7, cloudCol: 0xffffff,
    relief: "cloud", veg: "none", sea: false, snow: false,
  },
  volcano: {
    skyTop: 0x260f1c, skyMid: 0x6d2029, skyBot: 0xff7a33, sun: 0xff9a4a,
    sunAt: [-30, 24], sunSize: 2.0, key: 0xffb583, keyI: 2.1,
    hemiSky: 0xff8a52, hemiGround: 0x2a0e08, hemiI: 1.15, fog: 0x8a3526,
    far: 0x82464b, mid: 0x6b3439, near: 0x55272e, accent: 0xff9036,
    stars: true, tint: 0xff9a6a, tintAmt: 0.1, clouds: 0.4, cloudCol: 0x7a3c2c,
    relief: "peak", veg: "conifer", sea: false, snow: false,
  },
  glacier: {
    skyTop: 0x1a4a80, skyMid: 0x7cc0e6, skyBot: 0xeaf7ff, sun: 0xe8f6ff,
    sunAt: [-30, 32], sunSize: 2.2, key: 0xe6f2ff, keyI: 2.4,
    hemiSky: 0xcfeaff, hemiGround: 0x2b4a5f, hemiI: 1.25, fog: 0xbcdcee,
    far: 0xafd6ee, mid: 0x96c4e2, near: 0x79aed2, accent: 0x7df0ff,
    stars: false, tint: 0xbfe8ff, tintAmt: 0.1, clouds: 0.42, cloudCol: 0xeaf6ff,
    relief: "peak", veg: "conifer", sea: true, snow: true,
  },
};

// ---------------------------------------------------------------------------
// Canvas helpers — everything below draws into a 2D canvas at boot only.
// ---------------------------------------------------------------------------

interface Pad { cv: HTMLCanvasElement; g: CanvasRenderingContext2D }

function pad(w: number, h: number): Pad | null {
  if (typeof document === "undefined") return null;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d");
  return g ? { cv, g } : null;
}

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
const rgba = (n: number, a: number) =>
  `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;

const _cA = new THREE.Color();
const _cB = new THREE.Color();
const _hsl = { h: 0, s: 0, l: 0 };

/**
 * The depth contract in one function: push a silhouette colour toward the sky,
 * bleed its saturation out and lift it. Every background tier goes through
 * this, which is what stops decorative scenery from sharing the play surface's
 * value band and reading as something you could land on.
 */
function haze(base: number, sky: number, amt: number, desat: number, lift = 0): number {
  _cA.setHex(base).getHSL(_hsl);
  _cA.setHSL(_hsl.h, _hsl.s * (1 - desat), Math.min(0.92, _hsl.l + lift));
  _cA.lerp(_cB.setHex(sky), amt);
  return _cA.getHex();
}

/** Linear blend of two packed colours — used for lit / shadow face splits. */
function mixHex(a: number, b: number, t: number): number {
  return _cA.setHex(a).lerp(_cB.setHex(b), t).getHex();
}

/**
 * Blur a horizontally-tiling pad without opening a seam: the source is laid
 * down three times side by side so the kernel always has real neighbours, and
 * the bottom rows are re-solidified afterwards because a blurred alpha edge
 * there would let sky through the layer's skirt.
 */
function blurTiling(p: Pad, radius: number, bottomFill?: string): Pad {
  if (radius <= 0.05) return p;
  const W = p.cv.width;
  const H = p.cv.height;
  const wide = pad(W * 3, H);
  const soft = pad(W * 3, H);
  const out = pad(W, H);
  if (!wide || !soft || !out) return p;
  wide.g.drawImage(p.cv, 0, 0);
  wide.g.drawImage(p.cv, W, 0);
  wide.g.drawImage(p.cv, W * 2, 0);
  try {
    soft.g.filter = `blur(${radius}px)`;
  } catch {
    /* Canvas filters are optional; an unblurred layer is still correct. */
  }
  // Blur the whole triple-width image, *then* cut the middle out. Blurring a
  // source sub-rect instead would fade the kernel into transparency at the
  // crop edge and leave a visible vertical seam every tile.
  soft.g.drawImage(wide.cv, 0, 0);
  soft.g.filter = "none";
  out.g.drawImage(soft.cv, W, 0, W, H, 0, 0, W, H);
  if (bottomFill) {
    const band = Math.ceil(radius) + 2;
    out.g.fillStyle = bottomFill;
    out.g.fillRect(0, H - band, W, band);
  }
  return out;
}

/**
 * Wrapping vertical shade: light → dark → light, so a tile never shows a hard
 * seam where its bottom row meets the next tile's top row. Tiling textures on
 * a 26 m slab makes any non-wrapping gradient read as horizontal banding.
 */
function vgrad(g: CanvasRenderingContext2D, w: number, h: number, top: string, bot: string): void {
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, top);
  gr.addColorStop(0.5, bot);
  gr.addColorStop(1, top);
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
}

/**
 * Run `fn` at every wrapped copy of a feature so tiling textures have no seam.
 * Boot-time only, so the 9× cost is irrelevant.
 */
function wrapAt(x: number, y: number, r: number, S: number, fn: (x: number, y: number) => void): void {
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const px = x + ox * S;
      const py = y + oy * S;
      if (px < -r || px > S + r || py < -r || py > S + r) continue;
      fn(px, py);
    }
  }
}

/** Fine grain speckle — always seamless because it is per-pixel. */
function speckle(g: CanvasRenderingContext2D, S: number, n: number, rng: () => number, light: number, dark: number): void {
  for (let i = 0; i < n; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const s = 0.6 + rng() * 1.6;
    g.fillStyle = rng() < 0.5 ? rgba(light, 0.05 + rng() * 0.14) : rgba(dark, 0.05 + rng() * 0.16);
    g.fillRect(x, y, s, s);
  }
}

// ---------------------------------------------------------------------------
// Surface albedo generation
// ---------------------------------------------------------------------------

/** Draw the albedo for one material into an S×S seamless canvas. */
function surfaceCanvas(m: SurfaceMaterial, S: number, rng: () => number): Pad | null {
  const p = pad(S, S);
  if (!p) return null;
  const { g } = p;

  switch (m) {
    case "fairway":
    case "green":
    case "rough": {
      const top = m === "green" ? "#79d94f" : m === "rough" ? "#3f8f2b" : "#63c043";
      const bot = m === "green" ? "#5fbe3c" : m === "rough" ? "#2f7220" : "#4aa130";
      vgrad(g, S, S, top, bot);
      // Mown stripes on the green: world-space vertical bands, alternating and
      // feathered so the band edge is never a hard line on the turf.
      if (m === "green") {
        for (let i = 0; i < 4; i++) {
          const x0 = (i * S) / 4;
          const gr = g.createLinearGradient(x0, 0, x0 + S / 4, 0);
          const a = i % 2 ? "rgba(255,255,255," : "rgba(0,0,0,";
          gr.addColorStop(0, `${a}0)`);
          gr.addColorStop(0.5, `${a}${i % 2 ? 0.07 : 0.045})`);
          gr.addColorStop(1, `${a}0)`);
          g.fillStyle = gr;
          g.fillRect(x0, 0, S / 4, S);
        }
      }
      // Broad tonal patches so a big fairway isn't uniform.
      for (let i = 0; i < 26; i++) {
        const x = rng() * S, y = rng() * S, r = S * (0.05 + rng() * 0.12);
        wrapAt(x, y, r, S, (px, py) => {
          const gr = g.createRadialGradient(px, py, 0, px, py, r);
          const dark = rng() < 0.5;
          gr.addColorStop(0, dark ? "rgba(0,30,0,0.16)" : "rgba(190,255,150,0.13)");
          gr.addColorStop(1, "rgba(0,0,0,0)");
          g.fillStyle = gr;
          g.beginPath(); g.arc(px, py, r, 0, 6.2832); g.fill();
        });
      }
      // Blades: short flicked strokes, denser and longer in rough.
      const blades = m === "rough" ? (S * S) / 34 : (S * S) / 52;
      const len = m === "rough" ? S * 0.055 : S * 0.032;
      for (let i = 0; i < blades; i++) {
        const x = rng() * S, y = rng() * S;
        const l = len * (0.5 + rng());
        const lean = (rng() - 0.5) * l * 0.9;
        const lit = rng() < 0.45;
        wrapAt(x, y, l + 4, S, (px, py) => {
          g.strokeStyle = lit ? `rgba(196,255,150,${0.10 + rng() * 0.2})` : `rgba(8,44,10,${0.12 + rng() * 0.2})`;
          g.lineWidth = 0.7 + rng() * 1.1;
          g.beginPath();
          g.moveTo(px, py);
          g.quadraticCurveTo(px + lean * 0.4, py - l * 0.6, px + lean, py - l);
          g.stroke();
        });
      }
      speckle(g, S, S * 8, rng, 0xd8ffb0, 0x0b2a0c);
      break;
    }

    case "sand": {
      vgrad(g, S, S, "#f0dcaa", "#c9ac74");
      // Wind ripples: bright crest with a shadow beneath, world-horizontal.
      const rows = 13;
      for (let r = 0; r < rows; r++) {
        const y0 = ((r + 0.5) / rows) * S + (rng() - 0.5) * 3;
        const amp = 2 + rng() * 4;
        const k = 1 + Math.floor(rng() * 3);
        const ph = rng() * 6.2832;
        for (let pass = 0; pass < 2; pass++) {
          g.strokeStyle = pass ? "rgba(120,90,44,0.20)" : "rgba(255,244,214,0.42)";
          g.lineWidth = pass ? 2.0 : 1.4;
          g.beginPath();
          for (let x = 0; x <= S; x += 3) {
            const y = y0 + Math.sin((x / S) * 6.2832 * k + ph) * amp + (pass ? 2.2 : 0);
            if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
          }
          g.stroke();
        }
      }
      // Pebbles.
      for (let i = 0; i < 22; i++) {
        const x = rng() * S, y = rng() * S, r = 1 + rng() * 2.6;
        wrapAt(x, y, r + 2, S, (px, py) => {
          g.fillStyle = rgba(0x8a7048, 0.35);
          g.beginPath(); g.arc(px, py + 1, r, 0, 6.2832); g.fill();
          g.fillStyle = rgba(0xfff4d8, 0.5);
          g.beginPath(); g.arc(px, py, r * 0.85, 0, 6.2832); g.fill();
        });
      }
      speckle(g, S, S * 14, rng, 0xfff6dc, 0x8a6c40);
      break;
    }

    case "stone": {
      // Deliberately cool: a warm key plus a warm grade downstream pushes any
      // neutral grey straight to tan, and stone that reads as timber is a
      // readability failure rather than a style.
      vgrad(g, S, S, "#7d8896", "#4e5665");
      // Broad mottling first, so the strata sit on rock and not on paper.
      for (let i = 0; i < 30; i++) {
        const bx = rng() * S, by = rng() * S, br = S * (0.06 + rng() * 0.14);
        wrapAt(bx, by, br, S, (px, py) => {
          const gr = g.createRadialGradient(px, py, 0, px, py, br);
          gr.addColorStop(0, rng() < 0.5 ? "rgba(210,225,240,0.10)" : "rgba(20,26,36,0.14)");
          gr.addColorStop(1, "rgba(0,0,0,0)");
          g.fillStyle = gr;
          g.beginPath(); g.arc(px, py, br, 0, 6.2832); g.fill();
        });
      }
      // Sedimentary strata, wavy and low contrast, stacked so Y stays seamless.
      let y = 0;
      while (y < S) {
        const h = S * (0.07 + rng() * 0.16);
        const t = rng();
        g.fillStyle = t < 0.4 ? "rgba(214,230,246,0.035)" : t < 0.8 ? "rgba(18,24,34,0.055)" : "rgba(120,132,150,0.04)";
        g.beginPath();
        g.moveTo(0, y);
        const k = 1 + Math.floor(rng() * 3);
        const ph = rng() * 6.2832;
        for (let x = 0; x <= S; x += 4) g.lineTo(x, y + Math.sin((x / S) * 6.2832 * k + ph) * S * 0.018);
        for (let x = S; x >= 0; x -= 4) g.lineTo(x, y + h + Math.sin((x / S) * 6.2832 * k + ph) * S * 0.018);
        g.closePath();
        g.fill();
        y += h;
      }
      // Cracks.
      for (let i = 0; i < 26; i++) {
        const x = rng() * S, yy = rng() * S;
        const segs = 3 + Math.floor(rng() * 4);
        const dx = (rng() - 0.5) * S * 0.24;
        const dy = (rng() - 0.5) * S * 0.16;
        wrapAt(x, yy, S * 0.3, S, (px, py) => {
          g.strokeStyle = "rgba(14,18,26,0.45)";
          g.lineWidth = 0.7 + rng() * 1.3;
          g.beginPath(); g.moveTo(px, py);
          for (let s = 1; s <= segs; s++) {
            g.lineTo(px + (dx * s) / segs + (rng() - 0.5) * 5, py + (dy * s) / segs + (rng() - 0.5) * 5);
          }
          g.stroke();
        });
      }
      speckle(g, S, S * 10, rng, 0xe8f2ff, 0x1a2028);
      break;
    }

    case "metal": {
      vgrad(g, S, S, "#a9b4be", "#78838d");
      // Brushed anisotropy: dense full-width 1px streaks.
      for (let i = 0; i < S * 2.2; i++) {
        const y = rng() * S;
        g.strokeStyle = rng() < 0.5 ? `rgba(255,255,255,${rng() * 0.13})` : `rgba(20,26,34,${rng() * 0.15})`;
        g.lineWidth = 0.6 + rng() * 1.1;
        g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke();
      }
      // Plate seams down the middle of the tile, plus rivets on the seam.
      g.strokeStyle = "rgba(18,24,30,0.4)";
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, S / 2); g.lineTo(S, S / 2); g.stroke();
      g.beginPath(); g.moveTo(S / 2, 0); g.lineTo(S / 2, S); g.stroke();
      for (let i = 0; i < 8; i++) {
        const x = (i + 0.5) * (S / 8);
        for (const yy of [S / 2, 0]) {
          wrapAt(x, yy, 6, S, (px, py) => {
            const gr = g.createRadialGradient(px - 1, py - 1, 0, px, py, 3.4);
            gr.addColorStop(0, "rgba(255,255,255,0.55)");
            gr.addColorStop(1, "rgba(40,50,60,0.5)");
            g.fillStyle = gr;
            g.beginPath(); g.arc(px, py, 3.4, 0, 6.2832); g.fill();
          });
        }
      }
      break;
    }

    case "wood": {
      vgrad(g, S, S, "#a97444", "#7c5330");
      const planks = 4;
      for (let p2 = 0; p2 < planks; p2++) {
        const y0 = (p2 * S) / planks;
        g.fillStyle = `rgba(${p2 % 2 ? 255 : 0},${p2 % 2 ? 230 : 0},${p2 % 2 ? 190 : 0},0.05)`;
        g.fillRect(0, y0, S, S / planks);
        for (let i = 0; i < 9; i++) {
          const y = y0 + ((i + 0.5) / 9) * (S / planks);
          g.strokeStyle = `rgba(60,34,14,${0.1 + rng() * 0.2})`;
          g.lineWidth = 0.6 + rng() * 1.2;
          g.beginPath();
          for (let x = 0; x <= S; x += 4) {
            const yy = y + Math.sin((x / S) * 6.2832 * (1 + Math.floor(rng() * 2)) + i) * 1.6;
            if (x === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
          }
          g.stroke();
        }
        g.fillStyle = "rgba(38,22,10,0.45)";
        g.fillRect(0, y0, S, 1.6);
      }
      speckle(g, S, S * 6, rng, 0xffd9a8, 0x3a2410);
      break;
    }

    case "ice": {
      vgrad(g, S, S, "#dff4fd", "#93c9e4");
      // Facets.
      for (let i = 0; i < 26; i++) {
        const x = rng() * S, y = rng() * S, r = S * (0.05 + rng() * 0.11);
        wrapAt(x, y, r + 4, S, (px, py) => {
          g.beginPath();
          const n = 4 + Math.floor(rng() * 3);
          for (let k = 0; k < n; k++) {
            const a = (k / n) * 6.2832 + rng() * 0.4;
            const rr = r * (0.6 + rng() * 0.6);
            const vx = px + Math.cos(a) * rr, vy = py + Math.sin(a) * rr;
            if (k === 0) g.moveTo(vx, vy); else g.lineTo(vx, vy);
          }
          g.closePath();
          g.fillStyle = rng() < 0.5 ? "rgba(255,255,255,0.16)" : "rgba(60,120,170,0.13)";
          g.fill();
        });
      }
      // Cracks — branching white hairlines.
      for (let i = 0; i < 22; i++) {
        const x = rng() * S, y = rng() * S;
        wrapAt(x, y, S * 0.3, S, (px, py) => {
          g.strokeStyle = `rgba(255,255,255,${0.28 + rng() * 0.4})`;
          g.lineWidth = 0.6 + rng();
          g.beginPath(); g.moveTo(px, py);
          let cx = px, cy = py;
          const a0 = rng() * 6.2832;
          for (let s = 0; s < 5; s++) {
            cx += Math.cos(a0 + (rng() - 0.5) * 1.1) * S * 0.05;
            cy += Math.sin(a0 + (rng() - 0.5) * 1.1) * S * 0.05;
            g.lineTo(cx, cy);
          }
          g.stroke();
        });
      }
      speckle(g, S, S * 4, rng, 0xffffff, 0x4f88ad);
      break;
    }

    case "rubber": {
      vgrad(g, S, S, "#d9456b", "#8e2545");
      // Matte tread: rounded vertical bars with a soft highlight.
      const bars = 10;
      for (let i = 0; i < bars; i++) {
        const x = (i + 0.25) * (S / bars);
        const w = S / bars * 0.5;
        g.fillStyle = "rgba(0,0,0,0.16)";
        g.fillRect(x, 0, w, S);
        g.fillStyle = "rgba(255,255,255,0.07)";
        g.fillRect(x, 0, w * 0.32, S);
      }
      for (let i = 0; i < 5; i++) {
        g.fillStyle = "rgba(0,0,0,0.18)";
        g.fillRect(0, (i + 0.5) * (S / 5) - 1.5, S, 3);
      }
      speckle(g, S, S * 16, rng, 0xff9ab4, 0x3a0d1c);
      break;
    }

    case "water":
    case "lava":
    case "outOfBounds":
    default: {
      vgrad(g, S, S, hex(COLORS[m] ?? 0x555555), "#1a1d24");
      speckle(g, S, S * 4, rng, 0xffffff, 0x000000);
      break;
    }
  }
  return p;
}

/**
 * Derive a tangent-space normal map from a canvas's luminance. Cheaper and
 * more consistent than authoring a second canvas per material, and it lines up
 * with the albedo detail exactly.
 */
function normalFromPad(p: Pad, strength: number): THREE.DataTexture | null {
  const S = p.cv.width;
  let src: ImageData;
  try {
    src = p.g.getImageData(0, 0, S, S);
  } catch {
    return null;
  }
  const lum = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) {
    lum[i] = (src.data[i * 4] * 0.299 + src.data[i * 4 + 1] * 0.587 + src.data[i * 4 + 2] * 0.114) / 255;
  }
  const out = new Uint8Array(S * S * 4);
  const at = (x: number, y: number) => lum[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      // Canvas Y grows downward while UV V grows upward — flip dy.
      let nx = -dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv;
      const i = (y * S + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * inv * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(out, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The top-edge ribbon texture: soil fading in at the bottom, a hot rim line at
 * the play surface, and blades / chipped rock poking above it with alpha.
 */
function edgeCanvas(kind: EdgeKind, m: SurfaceMaterial, W: number, H: number, rng: () => number): Pad | null {
  const p = pad(W, H);
  if (!p) return null;
  const { g } = p;
  // V=1 (canvas top) is above the surface; the rim sits at `split`.
  const up = EDGE_EXTENT[kind][0];
  const split = (up / (up + EDGE_EXTENT[kind][1])) * H;
  const base = COLORS[m] ?? 0x888888;

  // Body below the rim: darkens downward, fades to transparent so it blends
  // into the slab texture instead of ending in a hard line.
  // A tight, dark contact-occlusion band immediately under the rim is what
  // separates a lit collision surface from the flat scenery behind it.
  const gr = g.createLinearGradient(0, split, 0, H);
  gr.addColorStop(0, rgba(0x000000, 0.0));
  gr.addColorStop(0.05, rgba(0x04120a, 0.46));
  gr.addColorStop(0.22, rgba(0x04120a, 0.34));
  gr.addColorStop(0.55, rgba(0x000000, 0.20));
  gr.addColorStop(1, rgba(0x000000, 0.0));
  g.fillStyle = gr;
  g.fillRect(0, split, W, H - split);

  // Hot rim — the play-surface signature. Nothing in the background wears it.
  const rimC = kind === "turf" ? 0xe6ffb4 : kind === "ice" ? 0xffffff : kind === "sand" ? 0xfff6da : 0xfff4dc;
  const rimH = Math.max(3.5, H * 0.062);
  g.fillStyle = rgba(rimC, kind === "hard" ? 0.92 : 0.86);
  g.fillRect(0, split - rimH * 0.45, W, rimH);
  // A softer bloom above the hard line so the rim reads as sunlit, not inked.
  const rg = g.createLinearGradient(0, split - rimH * 2.6, 0, split);
  rg.addColorStop(0, rgba(rimC, 0));
  rg.addColorStop(1, rgba(rimC, 0.30));
  g.fillStyle = rg;
  g.fillRect(0, split - rimH * 2.6, W, rimH * 2.6);

  if (kind === "turf") {
    // Blades above the rim, two tones for depth.
    for (let pass = 0; pass < 2; pass++) {
      const n = pass ? 200 : 150;
      for (let i = 0; i < n; i++) {
        const x = rng() * W;
        const h = split * (pass ? 0.5 + rng() * 0.5 : 0.35 + rng() * 0.5);
        const lean = (rng() - 0.5) * h * 0.8;
        const c = pass ? rgba(0x8fe36a, 0.95) : rgba(0x3f8f34, 0.9);
        wrapAt(x, split, h + 4, W, (px) => {
          g.strokeStyle = c;
          g.lineWidth = 1.3 + rng() * 1.4;
          g.lineCap = "round";
          g.beginPath();
          g.moveTo(px, split + 1);
          g.quadraticCurveTo(px + lean * 0.4, split - h * 0.6, px + lean, split - h);
          g.stroke();
        });
      }
    }
  } else if (kind === "sand") {
    for (let i = 0; i < 260; i++) {
      const x = rng() * W;
      const h = split * rng() * 0.8;
      g.fillStyle = rgba(0xfff0c8, 0.5 + rng() * 0.4);
      g.fillRect(x, split - h, 1 + rng() * 1.6, h + 1);
    }
  } else if (kind === "rock" || kind === "ice") {
    // Chipped bevel: irregular chunks sitting proud of the rim.
    const chips = 26;
    for (let i = 0; i < chips; i++) {
      const x = (i / chips) * W + rng() * (W / chips);
      const w = W / chips * (0.6 + rng() * 0.9);
      const h = split * (0.4 + rng() * 0.6);
      wrapAt(x, split, w + 4, W, (px) => {
        g.fillStyle = kind === "ice" ? rgba(0xe8fbff, 0.9) : rgba(0xb4a894, 0.92);
        g.beginPath();
        g.moveTo(px, split + 2);
        g.lineTo(px + w * 0.5, split - h);
        g.lineTo(px + w, split + 2);
        g.closePath();
        g.fill();
      });
    }
  } else if (kind === "hard") {
    g.fillStyle = rgba(0xffffff, 0.32);
    g.fillRect(0, split - H * 0.05, W, H * 0.05);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Sprite textures (ball, shadow, glow, ring)
// ---------------------------------------------------------------------------

/** Soft radial falloff, used for the contact shadow, glows and particles. */
function radialTex(size: number, inner: string, outer: string, stop = 0.0): THREE.CanvasTexture | null {
  const p = pad(size, size);
  if (!p) return null;
  const r = size / 2;
  const gr = p.g.createRadialGradient(r, r, r * stop, r, r, r);
  gr.addColorStop(0, inner);
  gr.addColorStop(0.55, inner);
  gr.addColorStop(1, outer);
  p.g.fillStyle = gr;
  p.g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(p.cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A thin bright annulus — the impact marker and the cup pulse. */
function ringTex(size: number): THREE.CanvasTexture | null {
  const p = pad(size, size);
  if (!p) return null;
  const r = size / 2;
  p.g.strokeStyle = "#ffffff";
  p.g.lineWidth = size * 0.075;
  p.g.beginPath();
  p.g.arc(r, r, r * 0.8, 0, 6.2832);
  p.g.stroke();
  const t = new THREE.CanvasTexture(p.cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Golf ball albedo. High-key by contract: the ball has to be the brightest
 * value in the frame in every state, so the dimples are the faintest possible
 * grey and the alignment marks are tinted highlights rather than the dark red
 * stripes that used to drag a 20 px ball down to mid-grey while aiming.
 */
function ballTex(size: number, rng: () => number): THREE.CanvasTexture | null {
  const p = pad(size, size * 0.5);
  if (!p) return null;
  const { g } = p;
  const W = size, H = size * 0.5;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, W, H);
  const cols = 26, rows = 13;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = ((c + (r % 2) * 0.5) / cols) * W;
      const y = ((r + 0.5) / rows) * H;
      const rad = W / cols * 0.42;
      const gr = g.createRadialGradient(x, y - rad * 0.3, 0, x, y, rad);
      gr.addColorStop(0, "rgba(255,255,255,1)");
      gr.addColorStop(0.6, "rgba(236,240,246,0.55)");
      gr.addColorStop(1, "rgba(214,220,230,0.0)");
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, rad, 0, 6.2832); g.fill();
    }
  }
  // Spin marks: warm, light, and narrow. Enough to read rotation, never enough
  // to darken the disc.
  for (const yy of [H * 0.26, H * 0.74]) {
    const gr = g.createLinearGradient(0, yy - H * 0.05, 0, yy + H * 0.05);
    gr.addColorStop(0, "rgba(255,168,150,0)");
    gr.addColorStop(0.5, "rgba(255,142,124,0.5)");
    gr.addColorStop(1, "rgba(255,168,150,0)");
    g.fillStyle = gr;
    g.fillRect(0, yy - H * 0.05, W, H * 0.1);
  }
  void rng;
  const t = new THREE.CanvasTexture(p.cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A filled chevron pointing +Y — the off-screen ball marker. */
function chevronTex(size: number): THREE.CanvasTexture | null {
  const p = pad(size, size);
  if (!p) return null;
  const { g } = p;
  const s = size;
  g.beginPath();
  g.moveTo(s * 0.5, s * 0.12);
  g.lineTo(s * 0.88, s * 0.7);
  g.lineTo(s * 0.5, s * 0.55);
  g.lineTo(s * 0.12, s * 0.7);
  g.closePath();
  g.fillStyle = "#0b1522";
  g.fill();
  g.strokeStyle = "#ffffff";
  g.lineWidth = s * 0.075;
  g.lineJoin = "round";
  g.stroke();
  const t = new THREE.CanvasTexture(p.cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A soft annulus whose bright band sits well outside the ball silhouette. */
function haloTex(size: number): THREE.CanvasTexture | null {
  const p = pad(size, size);
  if (!p) return null;
  const r = size / 2;
  const gr = p.g.createRadialGradient(r, r, 0, r, r, r);
  gr.addColorStop(0.0, "rgba(255,255,255,0)");
  gr.addColorStop(0.52, "rgba(255,255,255,0)");
  gr.addColorStop(0.68, "rgba(255,255,255,0.85)");
  gr.addColorStop(0.8, "rgba(190,230,255,0.35)");
  gr.addColorStop(1.0, "rgba(190,230,255,0)");
  p.g.fillStyle = gr;
  p.g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(p.cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------
// Parallax scenery
// ---------------------------------------------------------------------------

/** Periodic ridge height so the silhouette tiles perfectly. */
function ridgeY(x: number, W: number, harm: [number, number, number][]): number {
  let s = 0;
  for (const [k, a, ph] of harm) s += Math.sin((x / W) * 6.2832 * k + ph) * a;
  return s;
}

function fillRidge(
  g: CanvasRenderingContext2D, W: number, bottomY: number, topY: number,
  harm: [number, number, number][], style: string | CanvasGradient,
): void {
  g.beginPath();
  g.moveTo(0, bottomY);
  for (let x = 0; x <= W; x++) g.lineTo(x, topY + ridgeY(x, W, harm));
  g.lineTo(W, bottomY);
  g.closePath();
  g.fillStyle = style;
  g.fill();
}

/**
 * One summit in a range. Slope exponents differ left/right so no silhouette is
 * ever an isoceles triangle, and every summit spawns a shoulder so the profile
 * always carries at least one ridge break.
 */
interface Peak { x: number; w: number; h: number; el: number; er: number }

function makePeaks(W: number, n: number, hMin: number, hMax: number, rng: () => number): Peak[] {
  const ps: Peak[] = [];
  for (let i = 0; i < n; i++) {
    const x = ((i + 0.5) / n) * W + (rng() - 0.5) * (W / n) * 0.85;
    const h = hMin + rng() * (hMax - hMin);
    const w = h * (1.0 + rng() * 1.6);
    ps.push({ x, w, h, el: 1.0 + rng() * 0.8, er: 0.62 + rng() * 0.5 });
    const shoulders = rng() < 0.7 ? 1 : 2;
    for (let s = 0; s < shoulders; s++) {
      const side = rng() < 0.5 ? -1 : 1;
      ps.push({
        x: x + side * w * (0.5 + rng() * 0.6),
        w: w * (0.5 + rng() * 0.5),
        h: h * (0.36 + rng() * 0.34),
        el: 0.85 + rng() * 0.7,
        er: 0.7 + rng() * 0.55,
      });
    }
  }
  return ps;
}

/** Range height above the baseline at x, wrapped so the artwork tiles. */
function peakY(x: number, W: number, ps: Peak[]): number {
  let y = 0;
  for (const p of ps) {
    for (let o = -1; o <= 1; o++) {
      const dx = (x - (p.x + o * W)) / p.w;
      if (dx <= -1 || dx >= 1) continue;
      const t = dx < 0 ? Math.pow(-dx, p.el) : Math.pow(dx, p.er);
      const h = p.h * (1 - t);
      if (h > y) y = h;
    }
  }
  return y;
}

/**
 * A mountain range with a lit face and a shadow face. The key light rakes from
 * the upper left, so any flank that rises to the right is catching it. No rim
 * stroke: the crisp cream rim is reserved for collidable geometry.
 */
function drawRange(
  g: CanvasRenderingContext2D, W: number, baseY: number, bottomY: number,
  ps: Peak[], fillC: number, litC: number, snowC: number | null, snowAt: number,
): void {
  const y = new Float32Array(W + 1);
  let peakTop = baseY;
  for (let x = 0; x <= W; x++) {
    y[x] = baseY - peakY(x, W, ps);
    if (y[x] < peakTop) peakTop = y[x];
  }

  const silhouette = () => {
    g.beginPath();
    g.moveTo(0, bottomY);
    for (let x = 0; x <= W; x++) g.lineTo(x, y[x]);
    g.lineTo(W, bottomY);
    g.closePath();
  };

  silhouette();
  g.fillStyle = hex(fillC);
  g.fill();

  // Lit and shadow faces, as one soft horizontal gradient per summit clipped
  // to the silhouette. Gradients rather than bars: any band with its own edge
  // would put a hard line in the sky, and hard lines are what gave the old
  // backdrop away as unblended quads.
  g.save();
  silhouette();
  g.clip();
  for (const p of ps) {
    for (let o = -1; o <= 1; o++) {
      const cx = p.x + o * W;
      if (cx + p.w < 0 || cx - p.w > W) continue;
      const gr = g.createLinearGradient(cx - p.w, 0, cx + p.w, 0);
      gr.addColorStop(0, rgba(litC, 0));
      gr.addColorStop(0.3, rgba(litC, 0.36));
      gr.addColorStop(0.5, rgba(litC, 0));
      gr.addColorStop(0.52, rgba(0x000000, 0));
      gr.addColorStop(0.8, rgba(0x000000, 0.2));
      gr.addColorStop(1, rgba(0x000000, 0));
      g.fillStyle = gr;
      g.fillRect(cx - p.w, baseY - p.h * 1.05, p.w * 2, p.h * 1.05);
    }
  }
  // Aerial gradient inside the range: the feet of the mountains sit in haze.
  const vg = g.createLinearGradient(0, peakTop, 0, bottomY);
  vg.addColorStop(0, rgba(litC, 0.08));
  vg.addColorStop(0.55, rgba(litC, 0));
  vg.addColorStop(1, rgba(litC, 0.22));
  g.fillStyle = vg;
  g.fillRect(0, peakTop, W, bottomY - peakTop);

  if (snowC !== null) {
    // Snow above the snowline, as a filled band whose lower boundary follows
    // the crest — no per-column rectangles, so no vertical striping.
    const cap = (baseY - peakTop) * 0.2;
    g.fillStyle = rgba(snowC, 0.62);
    let x = 0;
    while (x <= W) {
      if (baseY - y[x] < snowAt) { x++; continue; }
      const start = x;
      while (x <= W && baseY - y[x] >= snowAt) x++;
      const end = x - 1;
      g.beginPath();
      for (let i = start; i <= end; i++) {
        if (i === start) g.moveTo(i, y[i]); else g.lineTo(i, y[i]);
      }
      for (let i = end; i >= start; i--) {
        g.lineTo(i, y[i] + Math.min(baseY - y[i] - snowAt, cap) + 1.5);
      }
      g.closePath();
      g.fill();
    }
  }
  g.restore();
}

/**
 * Flat-topped mesas. Strata are generated from each block's own dimensions —
 * band heights, colours and crack positions all derive from the mesa — so
 * nothing ever repeats at a fixed pixel pitch the way a tiled bitmap does.
 */
function drawMesas(
  g: CanvasRenderingContext2D, W: number, baseY: number, hRef: number,
  n: number, fillC: number, litC: number, darkC: number, rng: () => number,
): void {
  for (let i = 0; i < n; i++) {
    const x = ((i + 0.5) / n) * W + (rng() - 0.5) * (W / n) * 0.7;
    const h = hRef * (0.4 + rng() * 1.0);
    const w = h * (0.55 + rng() * 0.9);
    const bands = 4 + Math.floor(rng() * 5);
    const seeds: number[] = [];
    for (let s = 0; s < bands + 6; s++) seeds.push(rng());
    wrapAt(x, baseY, w + 8, W, (px) => {
      const top = baseY - h;
      // Body: a slight batter plus a talus skirt so it is rooted, never a
      // rectangle floating on a flat cut.
      g.beginPath();
      g.moveTo(px - w * 1.22, baseY + h * 0.1);
      g.lineTo(px - w * 0.9, baseY - h * 0.05);
      g.lineTo(px - w * 0.82, top);
      g.lineTo(px + w * 0.78, top);
      g.lineTo(px + w * 0.92, baseY - h * 0.04);
      g.lineTo(px + w * 1.26, baseY + h * 0.1);
      g.closePath();
      g.fillStyle = hex(fillC);
      g.fill();
      g.save();
      g.clip();
      // Strata: heights driven by the mesa's own h, never a fixed pitch.
      let yy = top;
      let k = 0;
      while (yy < baseY + h * 0.1 && k < bands + 6) {
        const bh = h * (0.06 + seeds[k % seeds.length] * 0.19);
        const t = seeds[(k * 3 + 1) % seeds.length];
        g.fillStyle = t < 0.42 ? rgba(litC, 0.13) : t < 0.8 ? rgba(darkC, 0.16) : rgba(darkC, 0.07);
        g.fillRect(px - w * 1.3, yy, w * 2.6, bh);
        // A thin parting line, offset by its own band so no two align.
        g.fillStyle = rgba(darkC, 0.22);
        g.fillRect(px - w * 1.3, yy + bh - 1, w * 2.6, 1.2);
        yy += bh;
        k++;
      }
      // Vertical fracture lines at irregular intervals.
      for (let c = 0; c < 3; c++) {
        const cx = px + (seeds[(c * 5 + 2) % seeds.length] - 0.5) * w * 1.5;
        g.strokeStyle = rgba(darkC, 0.2);
        g.lineWidth = 1 + seeds[(c + 3) % seeds.length];
        g.beginPath();
        g.moveTo(cx, top);
        g.lineTo(cx + (seeds[(c + 4) % seeds.length] - 0.5) * w * 0.3, baseY);
        g.stroke();
      }
      // Lit west face and the cap lip.
      const lg = g.createLinearGradient(px - w, 0, px + w, 0);
      lg.addColorStop(0, rgba(litC, 0.3));
      lg.addColorStop(0.45, rgba(litC, 0.04));
      lg.addColorStop(1, rgba(darkC, 0.22));
      g.fillStyle = lg;
      g.fillRect(px - w * 1.3, top, w * 2.6, h * 1.2);
      g.restore();
      g.fillStyle = rgba(litC, 0.5);
      g.fillRect(px - w * 0.82, top, w * 1.6, 2.5);
    });
  }
}

/** City skyline with lit windows. */
function drawSkyline(
  g: CanvasRenderingContext2D, W: number, baseY: number, bottomY: number, hRef: number,
  n: number, fillC: number, winC: string, winP: number, rng: () => number,
): void {
  g.fillStyle = hex(fillC);
  g.fillRect(0, baseY, W, bottomY - baseY);
  for (let i = 0; i < n; i++) {
    const w = (W / n) * (0.45 + rng() * 0.85);
    const x = (i / n) * W + rng() * (W / n) * 0.4;
    const h = hRef * (0.25 + rng() * 1.05);
    wrapAt(x, baseY, w + 6, W, (px) => {
      g.fillStyle = hex(fillC);
      g.fillRect(px, baseY - h, w, h);
      if (rng() < 0.3) g.fillRect(px + w * 0.45, baseY - h - hRef * 0.12, 2.5, hRef * 0.12);
      if (winP <= 0) return;
      const cols = Math.max(1, Math.floor(w / 9));
      const rows = Math.max(1, Math.floor(h / 12));
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          if (rng() > winP) continue;
          g.fillStyle = winC;
          g.fillRect(px + 3 + c * 9, baseY - h + 5 + r * 12, 3.5, 5);
        }
      }
    });
  }
}

/**
 * Open water. Band spacing compresses toward the horizon and every dash is
 * jittered in offset, length and opacity, so the plate of identical 8×2 ticks
 * is gone. A broad specular sheet sits under the sun, which is upper-left.
 */
function drawSea(
  g: CanvasRenderingContext2D, W: number, seaY: number, botY: number,
  topC: number, botC: number, foamC: number, rng: () => number,
): void {
  const depth = Math.max(1, botY - seaY);
  const sg = g.createLinearGradient(0, seaY, 0, botY);
  sg.addColorStop(0, hex(topC));
  sg.addColorStop(0.35, hex(mixHex(topC, botC, 0.5)));
  sg.addColorStop(1, hex(botC));
  g.fillStyle = sg;
  g.fillRect(0, seaY, W, depth);

  // Specular sheet: a wide soft column under the sun, brightest at the horizon.
  const glintX = W * 0.22;
  const gg = g.createRadialGradient(glintX, seaY, 0, glintX, seaY, depth * 1.5);
  gg.addColorStop(0, rgba(foamC, 0.3));
  gg.addColorStop(0.4, rgba(foamC, 0.09));
  gg.addColorStop(1, rgba(foamC, 0));
  g.fillStyle = gg;
  g.fillRect(0, seaY, W, depth);

  // Horizon line: thin, bright, and the only hard edge water is allowed.
  g.fillStyle = rgba(foamC, 0.34);
  g.fillRect(0, seaY - 1, W, 1.6);

  const rows = 26;
  for (let r = 0; r < rows; r++) {
    // Quadratic spacing: rows crowd together as they approach the horizon.
    const f = Math.pow((r + 1) / rows, 1.9);
    const y = seaY + f * depth;
    const scale = 0.25 + f * 1.5;
    const alpha = (0.05 + f * 0.22) * (0.55 + rng() * 0.6);
    const count = Math.max(2, Math.round((W / 150) * (3 + f * 5)));
    for (let i = 0; i < count; i++) {
      const dx = ((i + rng()) / count) * W;
      const len = (6 + rng() * 40) * scale;
      const dy = (rng() - 0.5) * depth * 0.035;
      const near = 1 - Math.abs(dx - glintX) / W;
      g.fillStyle = rgba(foamC, Math.min(0.55, alpha * (0.7 + near * 0.9)));
      g.fillRect(dx, y + dy, len, Math.max(1, 0.8 + f * 2.2));
    }
  }
}

/** Palms — leaning trunks with a fan of fronds, no two the same size. */
function drawPalms(
  g: CanvasRenderingContext2D, W: number, base: (x: number) => number,
  n: number, col: number, hRef: number, rng: () => number,
): void {
  for (let i = 0; i < n; i++) {
    const x = ((i + rng() * 0.9) / n) * W;
    const baseY = base(x);
    const s = 0.5 + rng() * 1.0;
    const h = hRef * s;
    const lean = (rng() - 0.5) * h * 0.55;
    const a = 0.55 + rng() * 0.45;
    wrapAt(x, baseY, h * 1.4, W, (px) => {
      g.strokeStyle = rgba(col, a);
      g.lineWidth = Math.max(1.4, h * 0.05);
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(px, baseY);
      g.quadraticCurveTo(px + lean * 0.4, baseY - h * 0.6, px + lean, baseY - h);
      g.stroke();
      const tipX = px + lean;
      const tipY = baseY - h;
      const fronds = 5 + Math.floor(rng() * 3);
      for (let f = 0; f < fronds; f++) {
        const ang = Math.PI + ((f + rng() * 0.4) / (fronds - 1)) * Math.PI;
        const L = h * (0.22 + rng() * 0.24);
        g.lineWidth = Math.max(1.1, h * 0.032);
        g.beginPath();
        g.moveTo(tipX, tipY);
        g.quadraticCurveTo(
          tipX + Math.cos(ang) * L * 0.6, tipY + Math.sin(ang) * L * 0.5 - L * 0.3,
          tipX + Math.cos(ang) * L, tipY + Math.sin(ang) * L * 0.7 + L * 0.2,
        );
        g.stroke();
      }
    });
  }
}

/** Conifers — varied heights, widths and lean along a baseline. */
function drawConifers(
  g: CanvasRenderingContext2D, W: number, base: (x: number) => number,
  n: number, col: number, hRef: number, rng: () => number,
): void {
  for (let i = 0; i < n; i++) {
    const x = ((i + rng() * 0.95) / n) * W;
    const baseY = base(x);
    const h = hRef * (0.45 + rng() * 1.15);
    const w = h * (0.26 + rng() * 0.2);
    const lean = (rng() - 0.5) * w * 0.5;
    const a = 0.5 + rng() * 0.5;
    wrapAt(x, baseY, w + 6, W, (px) => {
      g.fillStyle = rgba(col, a);
      const tiers = 3;
      for (let t = 0; t < tiers; t++) {
        const f = 1 - t / tiers;
        g.beginPath();
        g.moveTo(px + lean, baseY - h * 1.03);
        g.lineTo(px - w * f, baseY - (h * t) / tiers * 0.85);
        g.lineTo(px + w * f, baseY - (h * t) / tiers * 0.85);
        g.closePath();
        g.fill();
      }
    });
  }
}

/** Overlapping canopy blobs — jungle / broadleaf forest. */
function drawCanopy(
  g: CanvasRenderingContext2D, W: number, base: (x: number) => number,
  n: number, col: number, rRef: number, rng: () => number,
): void {
  for (let i = 0; i < n; i++) {
    const x = rng() * W;
    const baseY = base(x);
    const r = rRef * (0.45 + rng() * 1.1);
    const y = baseY - r * (0.25 + rng() * 0.55);
    g.fillStyle = rgba(col, 0.55 + rng() * 0.45);
    wrapAt(x, y, r + 6, W, (px, py) => {
      g.beginPath();
      for (let k = 0; k < 7; k++) {
        const ang = (k / 7) * 6.2832;
        g.arc(px + Math.cos(ang) * r * 0.5, py + Math.sin(ang) * r * 0.28, r * 0.55, 0, 6.2832);
      }
      g.fill();
      g.fillRect(px - r * 0.06, py, r * 0.12, baseY - py);
    });
  }
}

/** Soft cloud banks with feathered alpha — never a hard edge. */
function drawClouds(
  g: CanvasRenderingContext2D, W: number, H: number, n: number,
  col: number, rng: () => number,
): void {
  for (let i = 0; i < n; i++) {
    const x = rng() * W;
    const y = H * (0.08 + rng() * 0.55);
    const r = H * (0.09 + rng() * 0.22);
    const a = 0.18 + rng() * 0.3;
    wrapAt(x, y, r * 4, W, (px, py) => {
      for (let k = 0; k < 7; k++) {
        const bx = px + (k - 3) * r * 0.62 + (rng() - 0.5) * r * 0.3;
        const by = py + Math.sin(k * 1.7) * r * 0.26;
        const br = r * (0.5 + (k % 3) * 0.22);
        const gr = g.createRadialGradient(bx, by, 0, bx, by, br);
        gr.addColorStop(0, rgba(col, a));
        gr.addColorStop(0.55, rgba(col, a * 0.55));
        gr.addColorStop(1, rgba(col, 0));
        g.fillStyle = gr;
        g.beginPath();
        g.arc(bx, by, br, 0, 6.2832);
        g.fill();
      }
    });
  }
}

/** Per-tier atmospheric contract, furthest first. */
const TIER_HAZE = [0.6, 0.48, 0.36, 0.28];
const TIER_DESAT = [0.52, 0.44, 0.34, 0.24];
const TIER_LIFT = [0.07, 0.05, 0.03, 0.01];
const TIER_BLUR = [1.9, 1.4, 0.85, 0.4];

/**
 * One parallax layer's artwork. `tier` 0 = furthest, 3 = nearest. Every tier
 * goes through the same contract: hazed toward the sky, desaturated, softened,
 * and stripped of the cream rim light that marks collidable ground.
 */
function sceneryCanvas(theme: CourseTheme, tier: 0 | 1 | 2 | 3, W: number, H: number, rng: () => number): Pad | null {
  const p = pad(W, H);
  if (!p) return null;
  const { g } = p;
  const T = THEMES[theme];
  const sky = T.skyMid;
  const amt = TIER_HAZE[tier];
  const raw = tier === 0 ? T.far : tier === 1 ? T.mid : tier === 2 ? T.mid : T.near;

  const body = haze(raw, sky, amt, TIER_DESAT[tier], TIER_LIFT[tier]);
  const lit = haze(T.sun, sky, amt * 0.55, TIER_DESAT[tier] * 0.7, 0.06);
  const dark = haze(raw, 0x000000, 0.22 * (1 - amt), 0, -0.04);
  const deep = haze(raw, sky, amt * 0.62, TIER_DESAT[tier], -0.05);
  const px = W / 1024;

  // Baselines, as canvas fractions. Fixed per tier so the world anchoring in
  // buildScenery can guarantee no far layer's ground plane ever falls below
  // the water plane in front of it.
  const BASE = [0.76, 0.72, 0.42, 0.42][tier];
  const baseY = H * BASE;
  const bottomY = H;

  if (tier === 0 || tier === 1) {
    const n = tier === 0 ? 9 : 13;
    const hi = tier === 0 ? H * 0.38 : H * 0.3;
    const lo = tier === 0 ? H * 0.12 : H * 0.08;
    if (T.relief === "mesa") {
      g.fillStyle = hex(body);
      g.fillRect(0, baseY, W, bottomY - baseY);
      drawMesas(g, W, baseY, hi * 0.8, tier === 0 ? 5 : 8, body, lit, dark, rng);
    } else if (T.relief === "city") {
      drawSkyline(g, W, baseY, bottomY, hi, tier === 0 ? 24 : 15, body,
        tier === 0 ? "rgba(150,230,255,0.5)" : "rgba(255,205,140,0.62)", tier === 0 ? 0.14 : 0.24, rng);
    } else if (T.relief === "cloud") {
      drawClouds(g, W, H, tier === 0 ? 16 : 11, body, rng);
      g.fillStyle = rgba(body, 0.5);
      g.fillRect(0, baseY + H * 0.2, W, bottomY);
    } else {
      drawRange(g, W, baseY, bottomY, makePeaks(W, n, lo, hi, rng), body, lit,
        T.snow ? haze(0xffffff, sky, amt * 0.5, 0, 0) : null, hi * 0.66);
    }
    if (tier === 1 && T.veg === "canopy") {
      drawCanopy(g, W, () => baseY + H * 0.02, 22, deep, H * 0.1, rng);
    }
  } else if (tier === 2) {
    if (T.sea) {
      drawSea(g, W, baseY, bottomY, body, deep, haze(0xffffff, sky, amt * 0.4, 0, 0), rng);
    } else {
      const harm: [number, number, number][] = [[1, H * 0.05, 2.6], [3, H * 0.028, 0.4], [7, H * 0.012, 4.1]];
      const line = (x: number) => baseY + ridgeY(x, W, harm);
      const gr = g.createLinearGradient(0, baseY - H * 0.1, 0, bottomY);
      gr.addColorStop(0, hex(body));
      gr.addColorStop(1, hex(deep));
      fillRidge(g, W, bottomY, baseY, harm, gr);
      if (T.veg === "conifer") drawConifers(g, W, line, 30, dark, H * 0.14, rng);
      else if (T.veg === "canopy") drawCanopy(g, W, line, 26, dark, H * 0.11, rng);
    }
  } else {
    // Near bank. Deliberately a different grammar from the play surface: a
    // soft, low, hazed shoulder with no rim light and no grass texture.
    const harm: [number, number, number][] = [[1, H * 0.055, 1.9], [2, H * 0.03, 4.4], [5, H * 0.012, 0.3]];
    const line = (x: number) => baseY + ridgeY(x, W, harm);
    const gr = g.createLinearGradient(0, baseY - H * 0.08, 0, bottomY);
    gr.addColorStop(0, hex(body));
    gr.addColorStop(0.55, hex(haze(raw, sky, amt + 0.12, TIER_DESAT[tier], 0)));
    gr.addColorStop(1, hex(haze(raw, sky, Math.min(0.86, amt + 0.3), 0.7, 0.02)));
    fillRidge(g, W, bottomY, baseY, harm, gr);
    if (T.veg === "palm") {
      drawPalms(g, W, line, 9, dark, H * 0.15, rng);
      drawConifers(g, W, line, 26, dark, H * 0.06, rng);
    } else if (T.veg === "conifer") {
      drawConifers(g, W, line, 22, dark, H * 0.14, rng);
    } else if (T.veg === "canopy") {
      drawCanopy(g, W, line, 20, dark, H * 0.1, rng);
    }
  }

  // Aerial perspective inside the layer: everything sinks toward the sky
  // colour as it descends, which is what stops a big near mass from reading
  // as a solid platform you could land on.
  const hg = g.createLinearGradient(0, 0, 0, H);
  hg.addColorStop(0, rgba(sky, 0.03));
  hg.addColorStop(0.55, rgba(sky, 0.07 + tier * 0.02));
  hg.addColorStop(1, rgba(sky, 0.2 + tier * 0.04));
  g.globalCompositeOperation = "source-atop";
  g.fillStyle = hg;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = "source-over";

  // Depth-of-field: the further the tier, the softer. Also the cheapest way to
  // guarantee no background silhouette ever presents a hard straight edge.
  return blurTiling(p, TIER_BLUR[tier] * px, hex(haze(raw, sky, Math.min(0.9, amt + 0.3), 0.7, 0.02)));
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const SKY_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const SKY_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform vec3 uTop, uMid, uBot, uSunCol;
  uniform vec2 uW0, uW1, uSun;
  uniform float uSunSize, uStars, uTime, uHorizon;
  uniform vec3 uCloudCol;
  uniform float uClouds;
  float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x),
               mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  void main() {
    vec2 w = mix(uW0, uW1, vUv);
    // Anchored to the course, not the screen: the warm band sits on the
    // horizon and stays there however the camera moves.
    float t = clamp((w.y - uHorizon + 4.0) / 74.0, 0.0, 1.0);
    vec3 c = mix(uBot, uMid, smoothstep(0.0, 0.28, t));
    c = mix(c, uTop, smoothstep(0.24, 0.92, t));
    c += uBot * 0.28 * exp(-abs(w.y - uHorizon) / 9.0);
    if (uStars > 0.5) {
      vec2 cell = floor(w * 1.7);
      float r = h21(cell);
      float tw = 0.55 + 0.45 * sin(uTime * 2.2 + r * 44.0);
      c += vec3(0.72, 0.82, 1.0) * step(0.981, r) * tw * smoothstep(0.18, 0.85, t);
    }
    // Cloud banks: five octaves of value noise in world space, drifting. The
    // alpha ramp is deliberately wide — a narrow smoothstep on low-frequency
    // noise magnified across a phone screen shows up as a hard-edged smear.
    if (uClouds > 0.01) {
      vec2 cp = w * vec2(0.016, 0.042) + vec2(uTime * 0.008, 0.0);
      float n = vnoise(cp) * 0.46 + vnoise(cp * 2.1) * 0.26
              + vnoise(cp * 4.3) * 0.16 + vnoise(cp * 9.1) * 0.08
              + vnoise(cp * 17.0) * 0.04;
      float band = smoothstep(0.04, 0.34, t) * (1.0 - smoothstep(0.5, 0.98, t));
      float a = smoothstep(0.34, 0.86, n);
      c = mix(c, uCloudCol, a * a * uClouds * band);
    }
    // Aerial haze pooling on the horizon — every distant layer sinks into it.
    c = mix(c, uBot * 0.32 + uMid * 0.68, exp(-max(0.0, w.y - uHorizon + 6.0) / 22.0) * 0.2);
    float d = length(w - uSun);
    c += uSunCol * (exp(-d / (uSunSize * 11.0)) * 0.34 + smoothstep(uSunSize, uSunSize * 0.7, d) * 0.85);
    c += (h21(gl_FragCoord.xy) - 0.5) * 0.007;
    gl_FragColor = vec4(c, 1.0);
  }
`;

const LIQUID_VERT = /* glsl */ `
  varying vec2 vW;
  void main() { vW = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const LIQUID_FRAG = /* glsl */ `
  varying vec2 vW;
  uniform float uTime;
  uniform vec2 uRange;
  uniform vec3 uA, uB, uC;
  void main() {
    float span = max(0.6, uRange.x - uRange.y);
    #ifdef LAVA
      float w = sin(vW.x * 0.5 + uTime * 0.65) * 0.17 + sin(vW.x * 1.3 - uTime * 0.4) * 0.09;
    #else
      float w = sin(vW.x * 0.9 + uTime * 1.7) * 0.12
              + sin(vW.x * 2.4 - uTime * 2.3) * 0.06
              + sin(vW.x * 0.33 + uTime * 0.8) * 0.17;
    #endif
    float surf = uRange.x + w;
    if (vW.y > surf) discard;
    float d = clamp((surf - vW.y) / span, 0.0, 1.0);
    vec3 col; float alpha;
    #ifdef LAVA
      float v = sin(vW.x * 0.8 + sin(vW.y * 1.3 + uTime * 0.6) * 1.7 + uTime * 0.85);
      float v2 = sin(vW.x * 2.1 - uTime * 1.25 + sin(vW.y * 0.9) * 2.0);
      float crust = smoothstep(0.12, 0.9, v * 0.5 + 0.5) * smoothstep(0.08, 0.92, v2 * 0.5 + 0.5);
      col = mix(uB, uA, crust);
      col += uC * pow(max(0.0, v * 0.5 + 0.5), 5.0) * 1.15;
      col = mix(col, uC, smoothstep(0.34, 0.0, surf - vW.y) * 0.85);
      alpha = 0.97;
    #else
      col = mix(uA, uB, pow(d, 0.45));
      // Caustics as narrow crossing shafts rather than blobs — they have to
      // sparkle without ever competing with the ball for attention.
      float s1 = sin(vW.x * 1.5 + vW.y * 2.6 + uTime * 1.0) * 0.5 + 0.5;
      float s2 = sin(vW.x * 2.9 - vW.y * 3.4 - uTime * 1.5) * 0.5 + 0.5;
      col += uC * pow(s1 * s2, 4.0) * (1.0 - d * 0.55) * 0.34;
      // Ripple lines riding just under the surface.
      float below = surf - vW.y;
      float rip = sin(below * 8.5 - uTime * 2.4) * 0.5 + 0.5;
      col += uC * smoothstep(0.72, 1.0, rip) * exp(-below * 1.6) * 0.22;
      float foam = smoothstep(0.26, 0.0, below);
      col = mix(col, uC, foam * 0.85);
      alpha = mix(0.42, 0.84, d) + foam * 0.5;
    #endif
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }
`;

const EMBER_VERT = /* glsl */ `
  attribute float aSeed;
  uniform float uTime, uPx, uTop, uRise;
  uniform vec2 uSpan;
  varying float vA;
  void main() {
    float sp = 0.55 + fract(aSeed * 7.13) * 0.9;
    float life = fract(uTime * 0.17 * sp + aSeed);
    float x = mix(uSpan.x, uSpan.y, fract(aSeed * 13.77)) + sin(life * 6.2832 + aSeed * 21.0) * 0.7;
    float y = uTop + life * uRise;
    vA = (1.0 - life) * smoothstep(0.0, 0.1, life);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(x, y, 0.0, 1.0);
    gl_PointSize = clamp(uPx * mix(0.16, 0.035, life), 1.0, 40.0);
  }
`;

const EMBER_FRAG = /* glsl */ `
  varying float vA;
  uniform vec3 uColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    gl_FragColor = vec4(uColor, vA * smoothstep(0.5, 0.05, d));
  }
`;

const AIM_VERT = /* glsl */ `
  attribute float aT;
  uniform float uPx;
  varying float vT;
  void main() {
    vT = aT;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(uPx * mix(0.34, 0.13, aT), 2.0, 40.0);
  }
`;

const AIM_FRAG = /* glsl */ `
  varying float vT;
  uniform vec3 uNear, uFar;
  uniform float uFade;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    vec3 c = mix(uNear, uFar, vT);
    float a = (1.0 - vT * 0.5) * uFade * smoothstep(0.5, 0.15, d);
    gl_FragColor = vec4(c, a);
  }
`;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Concatenate position/normal/uv/color geometries into one indexed buffer.
 * Colours are RGBA: the alpha channel is what lets an overlay dressing (a mown
 * green, a bunker) feather out at its ends instead of ending in the hard
 * axis-aligned seam that reads as an unclipped quad.
 */
function mergePNU(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  let nv = 0;
  let ni = 0;
  for (const g of list) {
    const c = g.attributes.position.count;
    nv += c;
    ni += g.index ? g.index.count : c;
  }
  if (!nv) return null;
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const col = new Float32Array(nv * 4).fill(1);
  const uv = new Float32Array(nv * 2);
  const idx = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array as ArrayLike<number>, vo * 3);
    const na = g.attributes.normal;
    if (na) nor.set(na.array as ArrayLike<number>, vo * 3);
    const ca = g.attributes.color;
    if (ca) {
      const src = ca.array as ArrayLike<number>;
      const n = ca.itemSize;
      for (let i = 0; i < c; i++) {
        const o = (vo + i) * 4;
        col[o] = src[i * n];
        col[o + 1] = src[i * n + 1];
        col[o + 2] = src[i * n + 2];
        col[o + 3] = n > 3 ? src[i * n + 3] : 1;
      }
    }
    const ua = g.attributes.uv;
    if (ua) uv.set(ua.array as ArrayLike<number>, vo * 2);
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo;
    } else {
      for (let i = 0; i < c; i++) idx[io++] = vo + i;
    }
    vo += c;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("color", new THREE.BufferAttribute(col, 4));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/**
 * Depth rows for a ground curtain, metres below the play surface. Packed
 * tightly near the top because that is where the shading has to be accurate.
 */
const CURTAIN_ROWS = [0, 0.3, 0.85, 1.9, 3.6, 6.4, 11, 19];

/** Materials that are a thin dressing on top of other ground, not a mass. */
const OVERLAY_DEPTH: Partial<Record<SurfaceMaterial, number>> = { green: 2.4, sand: 3.0 };

/**
 * Painting order for butt-jointed ground bands. Where two bands meet, the
 * higher number is drawn over the lower one with a feathered alpha ramp and
 * the lower one is extended a couple of metres underneath, so a change of
 * material never shows up as a razor-straight vertical edge in the turf.
 */
const PAINT: Partial<Record<SurfaceMaterial, number>> = {
  rough: 0, fairway: 1, wood: 1, stone: 1, metal: 2, ice: 2, rubber: 2, sand: 3, green: 4,
};
const paintOf = (m: SurfaceMaterial): number => PAINT[m] ?? 1;

/** Alpha ramp bounds: [riseFrom, riseTo, fallFrom, fallTo] in world X. */
type Ramp = readonly [number, number, number, number];

function rampAlpha(f: Ramp | null, x: number): number {
  if (!f) return 1;
  const a = Number.isFinite(f[0]) ? THREE.MathUtils.smoothstep(x, f[0], f[1]) : 1;
  const b = Number.isFinite(f[2]) ? 1 - THREE.MathUtils.smoothstep(x, f[2], f[3]) : 1;
  return Math.min(a, b);
}

/** Warm soil the underside of a slab leans toward. */
const EARTH = new THREE.Color(0x241d18);

/** Height of the play surface at a given x — used to shade slab depth. */
function makeTopY(s: Surface): (x: number) => number {
  const P = s.points;
  if (s.closed || P.length < 2) {
    let m = -Infinity;
    for (const p of P) m = Math.max(m, p.y);
    return () => m;
  }
  const asc = P[P.length - 1].x >= P[0].x;
  const Q = asc ? P : P.slice().reverse();
  return (x: number) => {
    if (x <= Q[0].x) return Q[0].y;
    const last = Q.length - 1;
    if (x >= Q[last].x) return Q[last].y;
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (Q[mid].x <= x) lo = mid; else hi = mid;
    }
    const a = Q[lo];
    const b = Q[hi];
    return a.y + ((b.y - a.y) * (x - a.x)) / Math.max(1e-6, b.x - a.x);
  };
}

interface EdgeVert { x: number; y: number; nx: number; ny: number }

/**
 * The stretches of a surface that face upward — where the fringe ribbon goes.
 * Open strips are wound left-to-right so the left-hand perpendicular is up;
 * closed shapes use their signed area to find the outward normal.
 */
function topRuns(s: Surface): EdgeVert[][] {
  const P = s.points;
  const n = P.length;
  const runs: EdgeVert[][] = [];
  if (n < 2) return runs;

  if (!s.closed) {
    const run: EdgeVert[] = [];
    for (let i = 0; i < n; i++) {
      const a = P[Math.max(0, i - 1)];
      const b = P[Math.min(n - 1, i + 1)];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      run.push({ x: P[i].x, y: P[i].y, nx: -dy / L, ny: dx / L });
    }
    runs.push(run);
    return runs;
  }

  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = P[i];
    const b = P[(i + 1) % n];
    area += a.x * b.y - b.x * a.y;
  }
  const ccw = area > 0;
  let cur: EdgeVert[] = [];
  for (let i = 0; i < n; i++) {
    const a = P[i];
    const b = P[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    const nx = ccw ? dy / L : -dy / L;
    const ny = ccw ? -dx / L : dx / L;
    if (ny > 0.35) {
      if (!cur.length) cur.push({ x: a.x, y: a.y, nx, ny });
      cur.push({ x: b.x, y: b.y, nx, ny });
    } else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/** Ribbon strip along a run: `up` above the surface, `down` below it. */
function ribbonInto(
  run: EdgeVert[], up: number, down: number, tile: number, z: number,
  pos: number[], uvs: number[], cols: number[], fade: Ramp | null,
): void {
  if (run.length < 2) return;
  const alphaAt = (x: number) => rampAlpha(fade, x);
  let u = 0;
  const tx: number[] = [];
  const ty: number[] = [];
  const bx: number[] = [];
  const by: number[] = [];
  const us: number[] = [];
  for (let i = 0; i < run.length; i++) {
    if (i > 0) u += Math.hypot(run[i].x - run[i - 1].x, run[i].y - run[i - 1].y) / tile;
    tx.push(run[i].x + run[i].nx * up);
    ty.push(run[i].y + run[i].ny * up);
    bx.push(run[i].x - run[i].nx * down);
    by.push(run[i].y - run[i].ny * down);
    us.push(u);
  }
  for (let i = 0; i < run.length - 1; i++) {
    const j = i + 1;
    const ai = alphaAt(run[i].x);
    const aj = alphaAt(run[j].x);
    // two triangles: (b_i, b_j, t_j) and (b_i, t_j, t_i)
    pos.push(bx[i], by[i], z, bx[j], by[j], z, tx[j], ty[j], z);
    uvs.push(us[i], 0, us[j], 0, us[j], 1);
    cols.push(1, 1, 1, ai, 1, 1, 1, aj, 1, 1, 1, aj);
    pos.push(bx[i], by[i], z, tx[j], ty[j], z, tx[i], ty[i], z);
    uvs.push(us[i], 0, us[j], 1, us[i], 1);
    cols.push(1, 1, 1, ai, 1, 1, 1, aj, 1, 1, 1, ai);
  }
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

const MAX_TRAIL = 42;
const MAX_BALLS = 5;
const AIM_DOTS = 30;

const createRender: SystemFactory = (ctx: GolfCtx) => {
  const q: GolfQuality = ctx.quality;
  const TEX = q === "low" ? 128 : 256;
  /** Canvas pixels per world metre of scenery artwork. */
  const SCEN_PX = q === "low" ? 5 : q === "medium" ? 9 : 13;
  const LAYERS = q === "low" ? 3 : 4;
  const useNormals = q !== "low";

  const root = new THREE.Group();
  root.name = "golf-render";
  ctx.scene.add(root);

  // Deterministic per-system stream so texture noise is reproducible.
  const rng = ctx.rng;

  // --- Lighting -----------------------------------------------------------
  // Warm key raking from the upper left, cool sky fill. The key mostly points
  // down -Z so what shadows there are read as contact, not long stripes.
  // No shadow map: with an ortho camera and everything sitting at z≈0, a
  // directional shadow lands as a second, offset blob beside the ball's own
  // contact shadow. Two shadows read worse than one, and dropping the pass is
  // most of a millisecond back on a phone. Height is sold by the blob instead.
  const key = new THREE.DirectionalLight(0xfff2d8, 2.4);
  key.position.set(-24, 40, 90);
  const fill = new THREE.HemisphereLight(0xbfe4ff, 0x2b3f22, 1.15);
  const rim = new THREE.DirectionalLight(0x9fd8ff, 0.55);
  rim.position.set(60, -20, 40);
  ctx.scene.add(key, fill, rim, key.target);

  // --- Sky ----------------------------------------------------------------
  const skyMat = new THREE.ShaderMaterial({
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x2f7fc4) },
      uMid: { value: new THREE.Color(0x8fd3e8) },
      uBot: { value: new THREE.Color(0xffd9a8) },
      uSunCol: { value: new THREE.Color(0xffd9a6) },
      uW0: { value: new THREE.Vector2(-1, -1) },
      uW1: { value: new THREE.Vector2(1, 1) },
      uSun: { value: new THREE.Vector2(0, 40) },
      uSunSize: { value: 2.5 },
      uStars: { value: 0 },
      uCloudCol: { value: new THREE.Color(0xffcb96) },
      uClouds: { value: 0.5 },
      uTime: { value: 0 },
      uHorizon: { value: 10 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
  });
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  ctx.scene.add(sky);

  const fog = new THREE.Fog(0x3a6f92, 520, 1050);
  ctx.scene.fog = fog;

  // --- Texture caches -----------------------------------------------------
  interface MatSet { mat: THREE.MeshStandardMaterial; edge?: THREE.MeshBasicMaterial }
  const matCache = new Map<string, MatSet>();
  const ownedTex: THREE.Texture[] = [];

  function surfaceMaterial(m: SurfaceMaterial, theme: CourseTheme, overlay = false): MatSet {
    const k = `${m}|${theme}|${overlay ? "o" : "s"}`;
    const hit = matCache.get(k);
    if (hit) return hit;

    const T = THEMES[theme];
    const base = new THREE.Color(COLORS[m] ?? 0x888888);
    base.lerp(new THREE.Color(T.tint), T.tintAmt);
    const [rough, metal, nstr] = PBR[m] ?? [0.9, 0, 0.8];
    const mat = new THREE.MeshStandardMaterial({
      color: base, roughness: rough, metalness: metal, vertexColors: true,
      transparent: overlay, depthWrite: !overlay,
    });

    try {
      const p = surfaceCanvas(m, TEX, rng);
      if (p) {
        const map = new THREE.CanvasTexture(p.cv);
        map.wrapS = map.wrapT = THREE.RepeatWrapping;
        map.colorSpace = THREE.SRGBColorSpace;
        map.anisotropy = q === "high" ? 4 : 1;
        map.repeat.set(1 / TILE[m], 1 / TILE[m]);
        mat.map = map;
        // The map already carries the hue; keep the base as a gentle tint.
        mat.color = new THREE.Color(0xffffff).lerp(base, 0.42);
        ownedTex.push(map);
        if (useNormals) {
          const nm = normalFromPad(p, nstr * 2.2);
          if (nm) {
            nm.repeat.set(1 / TILE[m], 1 / TILE[m]);
            mat.normalMap = nm;
            mat.normalScale = new THREE.Vector2(1, 1);
            ownedTex.push(nm);
          }
        }
      }
    } catch (err) {
      console.warn("[golf/render] surface texture failed", m, err);
    }

    let edge: THREE.MeshBasicMaterial | undefined;
    const kind = EDGE_KIND[m];
    if (kind !== "none") {
      try {
        const ep = edgeCanvas(kind, m, 256, 128, rng);
        if (ep) {
          const et = new THREE.CanvasTexture(ep.cv);
          et.wrapS = THREE.RepeatWrapping;
          et.wrapT = THREE.ClampToEdgeWrapping;
          et.colorSpace = THREE.SRGBColorSpace;
          ownedTex.push(et);
          edge = new THREE.MeshBasicMaterial({
            map: et, transparent: true, depthWrite: false, toneMapped: true,
            vertexColors: true,
            color: new THREE.Color(0xffffff).lerp(base, 0.25),
          });
        }
      } catch (err) {
        console.warn("[golf/render] edge texture failed", m, err);
      }
    }

    const set: MatSet = { mat, edge };
    matCache.set(k, set);
    return set;
  }

  // --- Scenery ------------------------------------------------------------
  interface Layer { mesh: THREE.Mesh; kx: number; ky: number; tileW: number; anchor: number }
  let layers: Layer[] = [];
  const sceneryGeo = new THREE.PlaneGeometry(1, 1);

  function clearScenery(): void {
    for (const l of layers) {
      root.remove(l.mesh);
      const m = l.mesh.material as THREE.MeshBasicMaterial;
      m.map?.dispose();
      m.dispose();
    }
    layers = [];
  }

  /**
   * Four tiers with real scroll separation. `kx`/`ky` are how much of the
   * camera's motion the layer *keeps*, so apparent world speed is 1-kx:
   * 0.06 / 0.20 / 0.42 / 0.72. `top` is the world Y of the artwork band's top
   * edge, relative to the hole's horizon.
   *
   * The vertical anchoring is deliberate, not decorative: the sea plane in
   * tier 2 sits at its canvas fraction 0.42, and tiers 0-2 share a `ky`, so a
   * far mountain's baseline can never drift below the water plane in front of
   * it however the camera moves.
   */
  const TIERS: Array<{ tier: 0 | 1 | 2 | 3; z: number; kx: number; ky: number; h: number; top: number; tileW: number }> = [
    { tier: 0, z: LAYER.farScenery, kx: 0.94, ky: 0.9, h: 26, top: 25, tileW: 130 },
    { tier: 1, z: (LAYER.farScenery + LAYER.midScenery) * 0.5, kx: 0.8, ky: 0.9, h: 20, top: 18.4, tileW: 92 },
    { tier: 2, z: LAYER.midScenery, kx: 0.58, ky: 0.9, h: 16, top: 10.2, tileW: 68 },
    { tier: 3, z: LAYER.backdrop, kx: 0.28, ky: 0.72, h: 13, top: 7, tileW: 44 },
  ];

  function buildScenery(theme: CourseTheme, horizon: number): void {
    clearScenery();
    const specs = TIERS.slice(4 - LAYERS);

    for (const s of specs) {
      let tex: THREE.CanvasTexture | null = null;
      try {
        const cw = Math.min(2048, Math.round(s.tileW * SCEN_PX));
        const ch = Math.max(64, Math.round(cw * (s.h / s.tileW)));
        const p = sceneryCanvas(theme, s.tier, cw, ch, rng);
        if (p) {
          tex = new THREE.CanvasTexture(p.cv);
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.minFilter = THREE.LinearFilter;
          tex.generateMipmaps = false;
        }
      } catch (err) {
        console.warn("[golf/render] scenery failed", theme, s.tier, err);
      }
      if (!tex) continue;
      const W = 420;
      // The quad hangs well below the artwork; ClampToEdge repeats the canvas's
      // bottom row down the skirt, so a layer's lower edge can never show up as
      // a straight line across the sky.
      const SKIRT = 6;
      const H2 = s.h * SKIRT;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
      const mesh = new THREE.Mesh(sceneryGeo, mat);
      mesh.scale.set(W, H2, 1);
      mesh.position.z = s.z;
      mesh.renderOrder = -900 + s.tier;
      mesh.frustumCulled = false;
      tex.repeat.set(W / s.tileW, SKIRT);
      tex.offset.y = 1 - SKIRT;
      root.add(mesh);
      layers.push({ mesh, kx: s.kx, ky: s.ky, tileW: s.tileW, anchor: horizon + s.top - H2 * 0.5 });
    }
  }

  // --- Hole geometry ------------------------------------------------------
  let holeGroup: THREE.Group | null = null;
  const liquidMats: THREE.ShaderMaterial[] = [];
  const emberMats: THREE.ShaderMaterial[] = [];
  let theme: CourseTheme = "seaside";
  let horizonY = 10;
  /** Colour the underside of a slab fades to. Re-tinted per theme. */
  const deepShade = new THREE.Color(0x0a1622);

  function disposeHole(): void {
    if (!holeGroup) return;
    root.remove(holeGroup);
    holeGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && m.geometry !== sceneryGeo) m.geometry.dispose();
      const mm = m.material as THREE.Material | THREE.Material[] | undefined;
      if (!mm) return;
      for (const x of Array.isArray(mm) ? mm : [mm]) {
        // Shared cached materials must survive the rebuild.
        if (x.userData?.own) x.dispose();
      }
    });
    holeGroup = null;
    liquidMats.length = 0;
    emberMats.length = 0;
  }

  /**
   * A ground strip as a subdivided curtain hanging from its profile. An
   * extruded shape would work too, but its cap triangulation fans out to the
   * corners, so a baked depth gradient interpolates into mush. Explicit rows
   * give an exact, controllable falloff for a third of the vertices.
   */
  function curtainGeo(s: Surface, floorY: number, capOK: boolean, fade: Ramp | null): THREE.BufferGeometry | null {
    const P = s.points;
    const n = P.length;
    if (n < 2) return null;
    const cap = capOK ? OVERLAY_DEPTH[s.material] : undefined;
    const rows: number[] = [];
    for (const d of CURTAIN_ROWS) if (cap === undefined || d < cap) rows.push(d);
    rows.push(cap ?? Number.POSITIVE_INFINITY);
    const R = rows.length;

    const vc = n * R;
    const pos = new Float32Array(vc * 3);
    const nor = new Float32Array(vc * 3);
    const uv = new Float32Array(vc * 2);
    const col = new Float32Array(vc * 4);
    const z = EXTRUDE * 0.5;
    const c = new THREE.Color();

    for (let r = 0; r < R; r++) {
      const d = rows[r];
      // The lip catches the key light; the deepest rows tilt away from it.
      const tilt = r === 0 ? 0.8 : r === 1 ? 0.32 : 0;
      const droop = r >= R - 2 ? -0.35 : 0;
      const shade = Number.isFinite(d) ? d : 60;
      const k = THREE.MathUtils.smoothstep(shade, 0.4, 9);
      // Clamped well short of black: the mass has to stay a readable mid value
      // so the lower half of a tall slab still carries material information.
      c.setRGB(1, 1, 1).lerp(deepShade, k * 0.6);
      for (let i = 0; i < n; i++) {
        const a = P[Math.max(0, i - 1)];
        const b = P[Math.min(n - 1, i + 1)];
        let nx = -(b.y - a.y);
        let ny = b.x - a.x;
        const L = Math.hypot(nx, ny) || 1;
        nx /= L; ny /= L;
        const vx = nx * tilt;
        const vy = ny * tilt + droop;
        const iv = 1 / Math.hypot(vx, vy, 1);
        const o = r * n + i;
        const y = Number.isFinite(d) ? P[i].y - d : floorY;
        const alpha = rampAlpha(fade, P[i].x);
        pos[o * 3] = P[i].x; pos[o * 3 + 1] = y; pos[o * 3 + 2] = z;
        nor[o * 3] = vx * iv; nor[o * 3 + 1] = vy * iv; nor[o * 3 + 2] = iv;
        uv[o * 2] = P[i].x; uv[o * 2 + 1] = y;
        col[o * 4] = c.r; col[o * 4 + 1] = c.g; col[o * 4 + 2] = c.b; col[o * 4 + 3] = alpha;
      }
    }

    const idx = new Uint32Array((R - 1) * (n - 1) * 6);
    let w = 0;
    for (let r = 0; r < R - 1; r++) {
      for (let i = 0; i < n - 1; i++) {
        const a = r * n + i;
        const b = a + 1;
        const cc = a + n;
        const dd = cc + 1;
        idx[w++] = a; idx[w++] = cc; idx[w++] = dd;
        idx[w++] = a; idx[w++] = dd; idx[w++] = b;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 4));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    return geo;
  }

  /** Build the geometry for one surface, in world coordinates. */
  function slabGeo(s: Surface, floorY: number, capOK: boolean, fade: Ramp | null): THREE.BufferGeometry | null {
    if (s.points.length < 2) return null;
    if (!s.closed) return curtainGeo(s, floorY, capOK, fade);
    const shape = new THREE.Shape();
    shape.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) shape.lineTo(s.points[i].x, s.points[i].y);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: EXTRUDE,
      bevelEnabled: true,
      bevelThickness: 0.16,
      bevelSize: 0.16,
      bevelSegments: 1,
      curveSegments: 1,
    });
    geo.translate(0, 0, -EXTRUDE * 0.5);

    // Bake a depth shade into vertex colours: the play surface stays bright,
    // the mass below sinks into a cool dark. This is what stops a 26 m slab
    // reading as a wall of tiled texture, and it costs nothing at runtime.
    const topAt = makeTopY(s);
    const pa = geo.attributes.position as THREE.BufferAttribute;
    const cols = new Float32Array(pa.count * 4);
    const c = new THREE.Color();
    for (let i = 0; i < pa.count; i++) {
      // Blocks are objects, not earth: shade them, but never so far that the
      // material stops reading.
      const d = topAt(pa.getX(i)) - pa.getY(i);
      const k = THREE.MathUtils.smoothstep(d, 0.3, 12);
      c.setRGB(1, 1, 1).lerp(deepShade, k * 0.52);
      const alpha = rampAlpha(fade, pa.getX(i));
      cols[i * 4] = c.r; cols[i * 4 + 1] = c.g; cols[i * 4 + 2] = c.b; cols[i * 4 + 3] = alpha;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 4));
    return geo;
  }

  /** Flat shape for a liquid body, plus its vertical range. */
  function liquidMesh(s: Surface, floorY: number): THREE.Object3D | null {
    if (s.points.length < 3) return null;
    const shape = new THREE.Shape();
    shape.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) shape.lineTo(s.points[i].x, s.points[i].y);
    if (!s.closed) {
      const last = s.points[s.points.length - 1];
      shape.lineTo(last.x, floorY);
      shape.lineTo(s.points[0].x, floorY);
    }
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    let top = -Infinity, bot = Infinity, minX = Infinity, maxX = -Infinity;
    for (const p of s.points) {
      top = Math.max(top, p.y); bot = Math.min(bot, p.y);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    }
    if (!s.closed) bot = floorY;

    const lava = s.material === "lava";
    const T = THEMES[theme];
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      defines: lava ? { LAVA: "" } : {},
      uniforms: {
        uTime: { value: 0 },
        uRange: { value: new THREE.Vector2(top, bot) },
        uA: { value: new THREE.Color(lava ? 0xff8a2a : 0x39b8d8) },
        uB: { value: new THREE.Color(lava ? 0x360a06 : 0x07253f) },
        uC: { value: new THREE.Color(lava ? 0xffe07a : 0xdff6ff) },
      },
      vertexShader: LIQUID_VERT,
      fragmentShader: LIQUID_FRAG,
    });
    mat.userData.own = true;
    liquidMats.push(mat);

    const group = new THREE.Group();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = LAYER.props - 0.1;
    mesh.renderOrder = 4;
    group.add(mesh);

    // Embers rise off lava; water gets a glint band from the shader alone.
    if (lava && q !== "low") {
      const n = q === "high" ? 64 : 32;
      const seeds = new Float32Array(n);
      const dummy = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) seeds[i] = rng();
      const pg = new THREE.BufferGeometry();
      pg.setAttribute("position", new THREE.BufferAttribute(dummy, 3));
      pg.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
      pg.boundingSphere = new THREE.Sphere(new THREE.Vector3((minX + maxX) / 2, top + 4, 0), (maxX - minX) / 2 + 12);
      const pm = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 }, uPx: { value: 20 }, uTop: { value: top },
          uRise: { value: 9 }, uSpan: { value: new THREE.Vector2(minX, maxX) },
          uColor: { value: new THREE.Color(T.accent) },
        },
        vertexShader: EMBER_VERT,
        fragmentShader: EMBER_FRAG,
      });
      pm.userData.own = true;
      emberMats.push(pm);
      const pts = new THREE.Points(pg, pm);
      pts.position.z = LAYER.props + 0.4;
      pts.frustumCulled = false;
      group.add(pts);
    }
    return group;
  }

  function buildHole(hole: Hole): void {
    disposeHole();
    theme = hole.theme ?? "seaside";
    const T = THEMES[theme];
    horizonY = (hole.tee.y + hole.cup.y) * 0.5;

    // Sky + light + fog dressing for the theme.
    skyMat.uniforms.uTop.value.setHex(T.skyTop);
    skyMat.uniforms.uMid.value.setHex(T.skyMid);
    skyMat.uniforms.uBot.value.setHex(T.skyBot);
    skyMat.uniforms.uSunCol.value.setHex(T.sun);
    skyMat.uniforms.uSunSize.value = T.sunSize;
    skyMat.uniforms.uStars.value = T.stars ? 1 : 0;
    skyMat.uniforms.uClouds.value = T.clouds;
    // Pulled toward the sky it sits in: a fully saturated warm cloud colour on
    // a cool sky reads as a smudge on the lens, not as weather.
    skyMat.uniforms.uCloudCol.value.setHex(T.cloudCol).lerp(new THREE.Color(T.skyMid), 0.34);
    skyMat.uniforms.uHorizon.value = horizonY;
    key.color.setHex(T.key);
    key.intensity = T.keyI;
    fill.color.setHex(T.hemiSky);
    fill.groundColor.setHex(T.hemiGround);
    fill.intensity = T.hemiI;
    rim.color.setHex(T.accent);
    fog.color.setHex(T.fog);
    // Dark enough that the mass reads as ground rather than more play surface,
    // light enough that the material still reads all the way down the slab —
    // a terrain face that bottoms out at black carries no information at all.
    deepShade.setHex(T.fog).multiplyScalar(0.5).lerp(EARTH, 0.45);
    ctx.renderer.setClearColor(T.fog, 1);

    buildScenery(theme, horizonY);

    const g = new THREE.Group();
    const floorY = hole.bounds.min.y - SLAB_DEPTH;

    // Bucket by material so each one is a single merged draw call. Overlay
    // dressings get their own bucket because they need the transparent
    // material variant that carries the end-fade alpha.
    const slabs = new Map<string, { m: SurfaceMaterial; overlay: boolean; list: THREE.BufferGeometry[] }>();
    const fringe = new Map<string, { m: SurfaceMaterial; overlay: boolean; pos: number[]; uv: number[]; col: number[] }>();

    // A green or bunker is only a thin dressing if real ground runs under it.
    // Authored as a standalone strip it has to be a full slab, or the hole
    // gets a window straight through the terrain.
    const xSpan = (s: Surface) => {
      let a = Infinity;
      let b = -Infinity;
      for (const p of s.points) { a = Math.min(a, p.x); b = Math.max(b, p.x); }
      return [a, b] as const;
    };
    const bases = hole.surfaces
      .filter((s) => !s.closed && OVERLAY_DEPTH[s.material] === undefined
        && s.material !== "water" && s.material !== "lava")
      .map(xSpan);
    const supported = (s: Surface) => {
      const [a, b] = xSpan(s);
      return bases.some(([p, q]) => p <= a + 0.5 && q >= b - 0.5);
    };

    // Butt-jointed ground bands. Every joint between two materials becomes a
    // cross-fade: the lower-painting band grows a couple of metres under its
    // neighbour, and the higher-painting one is drawn over it with a feathered
    // alpha. That is what turns "lighter rectangle pasted on the hillside"
    // into a mown green that actually sits in the turf.
    interface Band { s: Surface; pts: Vec2[]; lo: number; hi: number }
    const bands: Band[] = [];
    for (const s of hole.surfaces) {
      if (s.closed || s.points.length < 2) continue;
      if (s.material === "water" || s.material === "lava") continue;
      const P = s.points;
      const pts = P[P.length - 1].x >= P[0].x ? P.slice() : P.slice().reverse();
      bands.push({ s, pts, lo: pts[0].x, hi: pts[pts.length - 1].x });
    }
    /** `count` metres of a neighbour's profile, walking away from the joint. */
    const walk = (pts: Vec2[], fromStart: boolean, dist: number): Vec2[] => {
      const out: Vec2[] = [];
      if (fromStart) {
        const x0 = pts[0].x;
        for (let i = 1; i < pts.length; i++) {
          out.push(pts[i]);
          if (pts[i].x - x0 >= dist) break;
        }
      } else {
        const x0 = pts[pts.length - 1].x;
        for (let i = pts.length - 2; i >= 0; i--) {
          out.unshift(pts[i]);
          if (x0 - pts[i].x >= dist) break;
        }
      }
      return out;
    };
    const JOINT = 1.2;
    const shaped = new Map<Surface, { pts: Vec2[]; ramp: Ramp | null }>();
    for (const b of bands) {
      let pts = b.pts;
      let r0 = -Infinity, r1 = -Infinity, r2 = Infinity, r3 = Infinity;
      const mine = paintOf(b.s.material);
      for (const o of bands) {
        if (o === b || o.s.material === b.s.material) continue;
        const theirs = paintOf(o.s.material);
        if (theirs === mine) continue;
        if (Math.abs(o.lo - b.hi) < JOINT) {
          if (theirs > mine) pts = pts.concat(walk(o.pts, true, OVERLAY_FADE));
          else { r2 = b.hi - OVERLAY_FADE; r3 = b.hi; }
        }
        if (Math.abs(o.hi - b.lo) < JOINT) {
          if (theirs > mine) pts = walk(o.pts, false, OVERLAY_FADE).concat(pts);
          else { r0 = b.lo; r1 = b.lo + OVERLAY_FADE; }
        }
      }
      const ramp: Ramp | null = Number.isFinite(r0) || Number.isFinite(r2)
        ? [r0, r1, r2, r3] as const : null;
      shaped.set(b.s, { pts, ramp });
    }

    for (const s0 of hole.surfaces) {
      if (s0.material === "water" || s0.material === "lava") {
        const lm = liquidMesh(s0, floorY);
        if (lm) g.add(lm);
        continue;
      }
      const shape = shaped.get(s0);
      const s: Surface = shape ? { ...s0, points: shape.pts } : s0;
      const fade = shape?.ramp ?? null;
      const sup = supported(s0);
      // A faded band has to sit in the transparent pass so its ramp composites
      // over the neighbour that was extended underneath it.
      const overlay = fade !== null;
      const key = `${s.material}|${overlay ? "o" : "s"}`;
      const geo = slabGeo(s, floorY, sup, fade);
      if (geo) {
        let b = slabs.get(key);
        if (!b) slabs.set(key, (b = { m: s.material, overlay, list: [] }));
        b.list.push(geo);
      }
      const kind = EDGE_KIND[s.material];
      if (kind === "none") continue;
      const [up, down] = EDGE_EXTENT[kind];
      let f = fringe.get(key);
      if (!f) fringe.set(key, (f = { m: s.material, overlay, pos: [], uv: [], col: [] }));
      const z = EXTRUDE * 0.5 + 0.08;
      for (const run of topRuns(s)) ribbonInto(run, up, down, 3.2, z, f.pos, f.uv, f.col, fade);
    }

    for (const b of slabs.values()) {
      const merged = mergePNU(b.list);
      if (!merged) continue;
      const set = surfaceMaterial(b.m, theme, b.overlay);
      const mesh = new THREE.Mesh(merged, set.mat);
      // Faded bands must clear every opaque band, whatever their material's
      // own bias, or the depth test eats the cross-fade.
      mesh.position.z = b.overlay
        ? LAYER.course + 0.4 + paintOf(b.m) * 0.02
        : LAYER.course + (Z_BIAS[b.m] ?? 0);
      if (b.overlay) mesh.renderOrder = 1;
      g.add(mesh);
    }

    for (const f of fringe.values()) {
      const set = surfaceMaterial(f.m, theme, f.overlay);
      if (!set.edge || !f.pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(f.pos), 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(f.uv), 2));
      geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(f.col), 4));
      const mesh = new THREE.Mesh(geo, set.edge);
      mesh.position.z = (f.overlay
        ? LAYER.course + 0.4 + paintOf(f.m) * 0.02
        : LAYER.course + (Z_BIAS[f.m] ?? 0)) + 0.05;
      mesh.renderOrder = 3;
      g.add(mesh);
    }

    root.add(g);
    holeGroup = g;

    cupGroup.position.set(hole.cup.x, hole.cup.y, LAYER.props);
    (flagCloth.material as THREE.MeshStandardMaterial).color.setHex(T.accent);
    (cupBeam.material as THREE.MeshBasicMaterial).color.setHex(T.accent);
  }

  // --- Ball ---------------------------------------------------------------
  const ballGeo = new THREE.SphereGeometry(1, q === "low" ? 16 : 24, q === "low" ? 12 : 18);
  const ballTexture = ballTex(256, rng);
  if (ballTexture) ownedTex.push(ballTexture);
  const outlineGeo = new THREE.SphereGeometry(1, 14, 10);
  const outlineMat = new THREE.MeshBasicMaterial({ color: 0x0c1826, side: THREE.BackSide, fog: false });
  const glowTex = radialTex(128, "rgba(255,255,255,0.55)", "rgba(255,255,255,0)");
  if (glowTex) ownedTex.push(glowTex);
  const shadowTex = radialTex(128, "rgba(0,0,0,0.85)", "rgba(0,0,0,0)");
  if (shadowTex) ownedTex.push(shadowTex);
  const ringTexture = ringTex(128);
  if (ringTexture) ownedTex.push(ringTexture);
  const haloTexture = haloTex(128);
  if (haloTexture) ownedTex.push(haloTexture);
  const chevronTexture = chevronTex(64);
  if (chevronTexture) ownedTex.push(chevronTexture);
  const quad = new THREE.PlaneGeometry(1, 1);

  interface BallVis {
    mesh: THREE.Mesh;
    outline: THREE.Mesh;
    glow: THREE.Mesh;
    halo: THREE.Mesh;
    shadow: THREE.Mesh;
    trail: THREE.Mesh;
    trailPos: Float32Array;
    trailCol: Float32Array;
    fade: number;
  }
  const trailIdx = new Uint16Array((MAX_TRAIL - 1) * 6);
  for (let i = 0; i < MAX_TRAIL - 1; i++) {
    const o = i * 6;
    trailIdx[o] = i * 2; trailIdx[o + 1] = i * 2 + 1; trailIdx[o + 2] = i * 2 + 3;
    trailIdx[o + 3] = i * 2; trailIdx[o + 4] = i * 2 + 3; trailIdx[o + 5] = i * 2 + 2;
  }

  function makeBallVis(): BallVis {
    // High-key by contract. The emissive floor is what guarantees the ball is
    // the brightest value in frame even sitting in the terrain's own shadow,
    // which is exactly the moment — addressing the ball — the player needs it.
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.5, metalness: 0.0,
      map: ballTexture ?? undefined,
      emissive: new THREE.Color(0x666666),
    });
    const mesh = new THREE.Mesh(ballGeo, mat);
    mesh.position.z = LAYER.ball;
    const outline = new THREE.Mesh(outlineGeo, outlineMat);
    outline.position.z = LAYER.ball;
    const glow = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({
      map: glowTex ?? undefined, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0.5, fog: false,
    }));
    glow.position.z = LAYER.ball - 0.6;
    // Drawn above everything, but as an annulus that starts outside the ball
    // silhouette — it can never darken or overlap the ball itself.
    const halo = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({
      map: haloTexture ?? undefined, transparent: true, depthWrite: false,
      depthTest: false, blending: THREE.AdditiveBlending, opacity: 0.5, fog: false,
    }));
    halo.position.z = LAYER.fx;
    halo.renderOrder = 40;
    const shadow = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({
      map: shadowTex ?? undefined, transparent: true, depthWrite: false,
      color: 0x0a1320, opacity: 0.5, fog: false,
    }));
    shadow.position.z = LAYER.props + 0.7;

    const trailPos = new Float32Array(MAX_TRAIL * 2 * 3);
    const trailCol = new Float32Array(MAX_TRAIL * 2 * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
    tg.setAttribute("color", new THREE.BufferAttribute(trailCol, 3));
    tg.setIndex(new THREE.BufferAttribute(trailIdx, 1));
    tg.setDrawRange(0, 0);
    const trail = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false,
    }));
    trail.frustumCulled = false;
    trail.position.z = LAYER.ball - 0.3;

    root.add(mesh, outline, glow, halo, shadow, trail);
    return { mesh, outline, glow, halo, shadow, trail, trailPos, trailCol, fade: 0 };
  }

  const balls: BallVis[] = [];
  for (let i = 0; i < MAX_BALLS; i++) balls.push(makeBallVis());

  // Safety net: if the ball ever leaves the frame, a chevron on the edge of
  // the viewport says which way it went.
  const chevron = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({
    map: chevronTexture ?? undefined, transparent: true, depthWrite: false,
    depthTest: false, fog: false, opacity: 0.95,
  }));
  chevron.position.z = LAYER.fx;
  chevron.renderOrder = 41;
  chevron.visible = false;
  root.add(chevron);

  // --- Cup + flag ---------------------------------------------------------
  const cupGroup = new THREE.Group();
  // A bright lip ellipse with a darker one on top reads as a hole in the turf
  // from straight on, and costs two quads instead of a torus.
  const cupLip = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({
    map: shadowTex ?? undefined, color: 0xf6fbff, transparent: true,
    depthWrite: false, opacity: 0.85, fog: false,
  }));
  cupLip.scale.set(2.0, 0.95, 1);
  cupLip.position.set(0, 0.04, 0.24);
  const cupHole = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({
    map: shadowTex ?? undefined, color: 0x040d0a, transparent: true,
    depthWrite: false, opacity: 0.98, fog: false,
  }));
  cupHole.scale.set(1.7, 0.78, 1);
  cupHole.position.set(0, 0, 0.3);
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.08, 4.6, 6),
    new THREE.MeshStandardMaterial({ color: 0xf7fafc, roughness: 0.45, metalness: 0.2 }),
  );
  pole.position.y = 2.3;
  const finial = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }),
  );
  finial.position.y = 4.6;
  const flagGeo = new THREE.PlaneGeometry(2.0, 1.15, 10, 1);
  flagGeo.translate(1.0, 0, 0);
  const flagCloth = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({
    color: 0xfb4d5c, side: THREE.DoubleSide, roughness: 0.85,
    emissive: new THREE.Color(0x3a1010),
  }));
  flagCloth.position.set(0.06, 3.9, 0.02);
  const flagBase = new Float32Array(flagGeo.attributes.position.array as ArrayLike<number>);
  const cupBeam = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({
    map: glowTex ?? undefined, color: 0xffb44d, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.1, fog: false,
  }));
  cupBeam.scale.set(2.6, 11, 1);
  cupBeam.position.set(0, 3.2, -0.4);
  const cupRing = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({
    map: ringTexture ?? undefined, color: 0xffffff, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.4, fog: false,
  }));
  cupRing.position.set(0, 0.05, 0.2);
  cupGroup.add(cupBeam, cupLip, cupHole, cupRing, pole, finial, flagCloth);
  cupGroup.position.z = LAYER.props;
  root.add(cupGroup);

  // --- Aim preview --------------------------------------------------------
  const aimGeo = new THREE.BufferGeometry();
  const aimPos = new Float32Array(AIM_DOTS * 3);
  const aimT = new Float32Array(AIM_DOTS);
  for (let i = 0; i < AIM_DOTS; i++) aimT[i] = i / (AIM_DOTS - 1);
  aimGeo.setAttribute("position", new THREE.BufferAttribute(aimPos, 3));
  aimGeo.setAttribute("aT", new THREE.BufferAttribute(aimT, 1));
  aimGeo.setDrawRange(0, AIM_DOTS);
  const aimMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uPx: { value: 20 },
      uNear: { value: new THREE.Color(0xfff3d0) },
      uFar: { value: new THREE.Color(0x35e0c0) },
      uFade: { value: 1 },
    },
    vertexShader: AIM_VERT,
    fragmentShader: AIM_FRAG,
  });
  const aimDots = new THREE.Points(aimGeo, aimMat);
  aimDots.visible = false;
  aimDots.frustumCulled = false;
  aimDots.position.z = LAYER.fx;
  aimDots.renderOrder = 20;
  root.add(aimDots);

  const impact = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({
    map: ringTexture ?? undefined, color: 0xfff0c0, transparent: true,
    depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, opacity: 0.85, fog: false,
  }));
  impact.scale.setScalar(2.2);
  impact.position.z = LAYER.fx;
  impact.renderOrder = 21;
  impact.visible = false;
  root.add(impact);

  interface AimState {
    aiming: boolean;
    power: number;
    from?: { x: number; y: number };
    dir?: { x: number; y: number };
  }
  let aimState: AimState = { aiming: false, power: 0 };
  const offAim = ctx.on("golf:aim", (p) => {
    aimState = (p as AimState) ?? { aiming: false, power: 0 };
  });

  const offHole = ctx.on("golf:hole", (payload) => {
    const data = payload as { hole?: Hole; course?: Course };
    if (!data?.hole) return;
    try {
      buildHole(data.hole);
    } catch (err) {
      console.error("[golf/render] hole build failed", err);
    }
  });

  // --- Per-frame ----------------------------------------------------------
  const tmpColor = new THREE.Color();
  const WHITE = new THREE.Color(0xffffff);
  const drawSize = new THREE.Vector2();

  /** Update one ball's visual set from its physics state. */
  function dressBall(vis: BallVis, b: BallState | undefined, dt: number, pxPerM: number): void {
    if (!b) {
      vis.mesh.visible = vis.outline.visible = vis.glow.visible = false;
      vis.halo.visible = vis.shadow.visible = vis.trail.visible = false;
      vis.fade = 0;
      return;
    }
    const tint = BALL_TYPES[b.type]?.tint ?? 0xffffff;
    // Never let the ball shrink below a readable size on screen. The camera
    // pulls back to 0.5× on long holes, which would otherwise leave an 8 px
    // dot — the one thing the player must never lose track of.
    const px = Math.max(1, pxPerM);
    const r = Math.min(b.radius * 2.2, Math.max(b.radius, 13 / px));
    vis.mesh.visible = vis.outline.visible = vis.glow.visible = true;
    vis.mesh.position.set(b.pos.x, b.pos.y, LAYER.ball);
    vis.mesh.scale.setScalar(r);
    vis.mesh.rotation.z -= b.spin * dt;
    const mm = vis.mesh.material as THREE.MeshStandardMaterial;
    mm.color.setHex(tint);
    // Lift a coloured ball back toward white so no ball type is ever a dark
    // object on a light backdrop.
    mm.color.lerp(WHITE, 0.45);
    mm.emissive.setHex(tint).lerp(WHITE, 0.5).multiplyScalar(0.52);

    // Outline shell sized in device pixels: a crisp ~1.8 px contact rim, not
    // the fat dark donut that used to swallow the ball at rest.
    vis.outline.position.copy(vis.mesh.position);
    vis.outline.scale.setScalar(r + 1.4 / px);

    vis.glow.position.set(b.pos.x, b.pos.y, LAYER.ball - 0.6);
    vis.glow.scale.setScalar(r * 5);
    (vis.glow.material as THREE.MeshBasicMaterial).color.setHex(tint).lerp(WHITE, 0.5);
    (vis.glow.material as THREE.MeshBasicMaterial).opacity = b.resting ? 0.34 : 0.2;

    // Addressable-ball ring: sits outside the silhouette, pulses gently, and
    // is drawn over every other layer so the golfer, a club, a pickup glow or
    // a power-up skin can never hide the one object that matters.
    const hm = vis.halo.material as THREE.MeshBasicMaterial;
    vis.halo.visible = true;
    vis.halo.position.set(b.pos.x, b.pos.y, LAYER.fx);
    const grow = b.resting ? 1 + Math.sin(ctx.elapsed * 3.1) * 0.05 : 1;
    vis.halo.scale.setScalar(r * 6.2 * grow);
    hm.color.setHex(tint).lerp(WHITE, 0.35);
    hm.opacity = b.resting ? 0.5 : 0.22;

    // Contact shadow: probe for the nearest surface below and tighten as the
    // ball approaches it. This is the main height cue in a flat side view.
    const phys = ctx.services.physics;
    const hit = phys?.probe({ x: b.pos.x, y: b.pos.y }, 7.5) ?? null;
    if (hit && hit.normal.y > 0.15) {
      const h = Math.max(0, Math.hypot(b.pos.x - hit.point.x, b.pos.y - hit.point.y) - r);
      const t = Math.min(1, h / 6);
      vis.shadow.visible = true;
      vis.shadow.position.set(hit.point.x + hit.normal.x * 0.05, hit.point.y + hit.normal.y * 0.05, LAYER.props + 0.7);
      vis.shadow.rotation.z = Math.atan2(hit.normal.y, hit.normal.x) - Math.PI / 2;
      vis.shadow.scale.set(r * (5.0 + t * 8), r * (2.4 + t * 4), 1);
      (vis.shadow.material as THREE.MeshBasicMaterial).opacity = 0.72 * (1 - t) + 0.05;
    } else {
      vis.shadow.visible = false;
    }

    // Motion trail, tapered and fading once the ball settles.
    const t = b.trail;
    const n = Math.min(t.length, MAX_TRAIL);
    vis.fade = b.resting ? Math.max(0, vis.fade - dt * 3.2) : 1;
    if (n < 3 || vis.fade <= 0.01) {
      vis.trail.visible = false;
    } else {
      vis.trail.visible = true;
      const off = t.length - n;
      tmpColor.setHex(tint);
      for (let i = 0; i < n; i++) {
        const p = t[off + i];
        const a = t[off + Math.max(0, i - 1)];
        const c = t[off + Math.min(n - 1, i + 1)];
        let dx = c.x - a.x;
        let dy = c.y - a.y;
        const L = Math.hypot(dx, dy) || 1;
        dx /= L; dy /= L;
        const f = i / (n - 1);
        const w = r * 0.85 * f * f;
        const o = i * 6;
        vis.trailPos[o] = p.x - -dy * w; vis.trailPos[o + 1] = p.y - dx * w; vis.trailPos[o + 2] = 0;
        vis.trailPos[o + 3] = p.x + -dy * w; vis.trailPos[o + 4] = p.y + dx * w; vis.trailPos[o + 5] = 0;
        const g2 = f * f * 0.62 * vis.fade;
        vis.trailCol[o] = tmpColor.r * g2; vis.trailCol[o + 1] = tmpColor.g * g2; vis.trailCol[o + 2] = tmpColor.b * g2;
        vis.trailCol[o + 3] = vis.trailCol[o]; vis.trailCol[o + 4] = vis.trailCol[o + 1]; vis.trailCol[o + 5] = vis.trailCol[o + 2];
      }
      const geo = vis.trail.geometry;
      (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
      geo.setDrawRange(0, (n - 1) * 6);
    }
  }

  const sys: System = {
    name: "render",
    lateUpdate(dt) {
      const cam = ctx.camera;
      const phys = ctx.services.physics;
      const t = ctx.elapsed;
      const T = THEMES[theme];

      // Sky quad exactly covers the view; the shader works in world space so
      // the horizon stays pinned to the course instead of sliding with us.
      const halfW = (cam.right - cam.left) * 0.5;
      const halfH = (cam.top - cam.bottom) * 0.5;
      sky.scale.set(halfW * 2.1, halfH * 2.1, 1);
      sky.position.set(cam.position.x, cam.position.y, LAYER.sky);
      skyMat.uniforms.uW0.value.set(cam.position.x - halfW * 1.05, cam.position.y - halfH * 1.05);
      skyMat.uniforms.uW1.value.set(cam.position.x + halfW * 1.05, cam.position.y + halfH * 1.05);
      skyMat.uniforms.uSun.value.set(
        cam.position.x * 0.92 + T.sunAt[0],
        cam.position.y * 0.9 + horizonY + T.sunAt[1],
      );
      skyMat.uniforms.uTime.value = t;

      // Parallax: each layer sits on the camera and scrolls its own texture,
      // so a 260 m quad covers any zoom without a single extra draw call.
      for (const l of layers) {
        l.mesh.position.x = cam.position.x;
        // Anchored on the hole's horizon, not on world zero: at the resting
        // camera height each tier sits exactly where it was authored, and only
        // deviation from that height produces vertical parallax.
        l.mesh.position.y = l.anchor + (cam.position.y - horizonY) * l.ky;
        const map = (l.mesh.material as THREE.MeshBasicMaterial).map;
        if (map) map.offset.x = (cam.position.x * l.kx) / l.tileW;
      }

      // Keep the key light and its shadow frustum over the action.
      key.position.set(cam.position.x - 24, cam.position.y + 40, 90);
      key.target.position.set(cam.position.x, cam.position.y, 0);
      key.target.updateMatrixWorld();

      // Device pixels per world metre — needed for point sizes.
      ctx.renderer.getDrawingBufferSize(drawSize);
      const pxPerM = drawSize.y / Math.max(0.001, cam.top - cam.bottom);
      aimMat.uniforms.uPx.value = pxPerM;
      for (const m of liquidMats) m.uniforms.uTime.value = t;
      for (const m of emberMats) {
        m.uniforms.uTime.value = t;
        m.uniforms.uPx.value = pxPerM;
      }

      // Flag flutter — 22 vertices, cheaper than a shader variant.
      const fp = flagGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < fp.count; i++) {
        const x0 = flagBase[i * 3];
        const y0 = flagBase[i * 3 + 1];
        const w = x0 / 1.6;
        fp.setXYZ(i, x0, y0 + Math.sin(x0 * 3.1 - t * 6.5) * 0.14 * w, Math.sin(x0 * 2.4 - t * 6.5) * 0.3 * w);
      }
      fp.needsUpdate = true;
      const pulse = 0.42 + Math.sin(t * 2.2) * 0.12;
      (cupRing.material as THREE.MeshBasicMaterial).opacity = pulse * 0.7;
      cupRing.scale.setScalar(2.0 + Math.sin(t * 2.2) * 0.22);

      if (!phys) return;
      const live = phys.balls.filter((b) => b.active);
      for (let i = 0; i < balls.length; i++) dressBall(balls[i], live[i], dt, pxPerM);

      // Off-screen ball chevron. Clamped to the viewport edge and rotated to
      // point at the ball, so the player is never hunting a frame for it.
      const lead = live[0];
      if (lead) {
        const mx = halfW - 2.2;
        const my = halfH - 2.2;
        const dx = lead.pos.x - cam.position.x;
        const dy = lead.pos.y - cam.position.y;
        const off = Math.abs(dx) > mx || Math.abs(dy) > my;
        chevron.visible = off;
        if (off) {
          const cx = Math.max(-mx, Math.min(mx, dx));
          const cy = Math.max(-my, Math.min(my, dy));
          chevron.position.set(cam.position.x + cx, cam.position.y + cy, LAYER.fx);
          chevron.rotation.z = Math.atan2(dy, dx) - Math.PI / 2;
          chevron.scale.setScalar(Math.max(1.1, 34 / Math.max(1, pxPerM)));
        }
      } else {
        chevron.visible = false;
      }

      // Aim preview: integrate the real launch under gravity, and sweep each
      // step so the first impact is marked. Both are what the shot will do.
      const primary = live[0];
      if (aimState.aiming && aimState.from && aimState.dir && primary) {
        aimDots.visible = true;
        const g = phys.gravity;
        const speed = 6 + aimState.power * 46 * (BALL_TYPES[primary.type]?.power ?? 1);
        let px = aimState.from.x;
        let py = aimState.from.y;
        let vx = aimState.dir.x * speed;
        let vy = aimState.dir.y * speed;
        const h2 = 0.042;
        let hitAt: Vec2 | null = null;
        let shown = AIM_DOTS;
        for (let i = 0; i < AIM_DOTS; i++) {
          const fx = px;
          const fy = py;
          for (let k = 0; k < 3; k++) {
            vx += g.x * h2; vy += g.y * h2;
            px += vx * h2; py += vy * h2;
          }
          if (!hitAt && q !== "low") {
            const hit = phys.sweep({ x: fx, y: fy }, { x: px, y: py }, primary.radius);
            if (hit) {
              hitAt = hit.point;
              px = hit.point.x + hit.normal.x * primary.radius;
              py = hit.point.y + hit.normal.y * primary.radius;
              shown = i + 1;
            }
          }
          aimPos[i * 3] = px;
          aimPos[i * 3 + 1] = py;
          aimPos[i * 3 + 2] = 0;
          if (hitAt) break;
        }
        for (let i = shown; i < AIM_DOTS; i++) {
          aimPos[i * 3] = px; aimPos[i * 3 + 1] = py; aimPos[i * 3 + 2] = 0;
        }
        aimGeo.setDrawRange(0, shown);
        (aimGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        aimMat.uniforms.uFade.value = 0.6 + aimState.power * 0.4;
        // Hot at low power, alarming at full power.
        aimMat.uniforms.uNear.value.setHex(0xfff6de);
        tmpColor.setHex(0x35e0c0).lerp(new THREE.Color(0xff6b57), aimState.power);
        aimMat.uniforms.uFar.value.copy(tmpColor);
        impact.visible = Boolean(hitAt);
        if (hitAt) {
          impact.position.set(hitAt.x, hitAt.y, LAYER.fx);
          impact.scale.setScalar(1.9 + Math.sin(t * 9) * 0.16);
        }
      } else {
        aimDots.visible = false;
        impact.visible = false;
      }
    },
    dispose() {
      offAim();
      offHole();
      disposeHole();
      clearScenery();
      sceneryGeo.dispose();
      quad.dispose();
      ballGeo.dispose();
      outlineGeo.dispose();
      outlineMat.dispose();
      flagGeo.dispose();
      aimGeo.dispose();
      aimMat.dispose();
      skyMat.dispose();
      sky.geometry.dispose();
      for (const tex of ownedTex) tex.dispose();
      for (const set of matCache.values()) {
        set.mat.dispose();
        set.edge?.dispose();
      }
      matCache.clear();
      for (const b of balls) {
        (b.mesh.material as THREE.Material).dispose();
        (b.glow.material as THREE.Material).dispose();
        (b.halo.material as THREE.Material).dispose();
        (b.shadow.material as THREE.Material).dispose();
        (b.trail.material as THREE.Material).dispose();
        b.trail.geometry.dispose();
      }
      (chevron.material as THREE.Material).dispose();
      cupGroup.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry && m.geometry !== quad && m.geometry !== flagGeo) m.geometry.dispose();
        const mm = m.material as THREE.Material | undefined;
        mm?.dispose?.();
      });
      ctx.scene.fog = null;
      ctx.scene.remove(root, sky, key, fill, rim, key.target);
    },
  };

  return sys;
};

export default createRender;
