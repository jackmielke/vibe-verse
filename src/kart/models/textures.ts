/**
 * Vibe Kart — the character texture bakery.
 *
 * Three things are painted here, all on a 2D canvas at boot, all zero bytes of
 * download:
 *
 * · **Faces.** A driver with a blank head is a mannequin. Each character gets
 *   an eight-cell expression atlas mapped straight onto the head sphere, and the
 *   pose system slides the texture offset between cells — so a blink, a grimace
 *   under a mini-turbo and a delighted whoop on the finish line all cost one
 *   uniform update and zero extra draw calls.
 *
 * · **Liveries.** The kart body is lofted with (u = around the section,
 *   v = nose→tail) UVs, so a livery is painted in exactly the space a real
 *   vehicle wrap is cut in: u = 0.25 is the top deck, u = 0/0.5 are the flanks,
 *   u = 0.75 is the floor. Eight patterns, one per character.
 *
 * · **Plates and shadows.** The race number and the soft contact blob.
 *
 * The equirectangular caveat: the head sphere's V runs from the crown (canvas
 * row 0, because CanvasTexture keeps flipY) to the chin, and horizontal
 * distances compress toward the poles. `fx()` divides that out so an eye drawn
 * at "0.11 to the left" is 0.11 of a head-width to the left wherever it sits.
 */
import * as THREE from "three";
import { clamp01, makeRng } from "./math";
import type { FaceStyle, LiveryPattern, RacerLook } from "./roster";

// ---------------------------------------------------------------------------
// Canvas plumbing
// ---------------------------------------------------------------------------

export interface Canvas2D {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  w: number;
  h: number;
}

function makeCanvas(w: number, h = w): Canvas2D {
  if (typeof document === "undefined") throw new Error("[kart/models] no DOM canvas available");
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(4, Math.round(w));
  canvas.height = Math.max(4, Math.round(h));
  const g = canvas.getContext("2d", { alpha: true });
  if (!g) throw new Error("[kart/models] 2D context unavailable");
  return { canvas, g, w: canvas.width, h: canvas.height };
}

function hex(c: number): string {
  return `#${(c >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
}

function rgba(c: number, a: number): string {
  return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
}

/** Lighten (t > 0) or darken (t < 0) a packed colour. */
function shade(c: number, t: number): number {
  const r = (c >> 16) & 255;
  const g = (c >> 8) & 255;
  const b = c & 255;
  const f = (v: number) => Math.round(t >= 0 ? v + (255 - v) * t : v * (1 + t));
  return (f(r) << 16) | (f(g) << 8) | f(b);
}

function texture(c: Canvas2D, opts: { srgb?: boolean; wrapU?: THREE.Wrapping; wrapV?: THREE.Wrapping; aniso?: number } = {}): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c.canvas);
  tex.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  tex.wrapS = opts.wrapU ?? THREE.ClampToEdgeWrapping;
  tex.wrapT = opts.wrapV ?? THREE.ClampToEdgeWrapping;
  tex.anisotropy = opts.aniso ?? 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Rounded rectangle path. Written out rather than using `ctx.roundRect`, which
 * is still missing on enough headless and embedded 2D contexts that a bare call
 * is a coin flip — and a thrown TypeError here would cost the whole bake.
 */
function roundRectPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr);
  g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr);
  g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}

/** Draw a pattern three times so anything crossing the U seam is continuous. */
function wrapX(g: CanvasRenderingContext2D, w: number, draw: () => void): void {
  for (const dx of [-w, 0, w]) {
    g.save();
    g.translate(dx, 0);
    draw();
    g.restore();
  }
}

// ---------------------------------------------------------------------------
// Faces
// ---------------------------------------------------------------------------

export const EXPRESSIONS = [
  "neutral",
  "blink",
  "smile",
  "cheer",
  "focus",
  "strain",
  "shock",
  "hurt",
] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export const FACE_COLS = 4;
export const FACE_ROWS = 2;

/** UV offset of an expression cell, for `texture.offset`. */
export function faceOffset(e: Expression): { x: number; y: number } {
  const i = EXPRESSIONS.indexOf(e);
  const col = i % FACE_COLS;
  const row = Math.floor(i / FACE_COLS);
  // Row 0 of the atlas is the *top* of the canvas, which is V = 1.
  return { x: col / FACE_COLS, y: 1 - (row + 1) / FACE_ROWS };
}

interface Cell {
  g: CanvasRenderingContext2D;
  ox: number;
  oy: number;
  s: number;
}

/** Cell-space X, with the equirect longitude stretch divided back out. */
function fx(c: Cell, dx: number, cy: number): number {
  return c.ox + (0.5 + dx / Math.max(0.4, Math.sin(Math.PI * cy))) * c.s;
}

function fy(c: Cell, cy: number): number {
  return c.oy + cy * c.s;
}

function fdisc(c: Cell, dx: number, cy: number, rx: number, ry: number, rot = 0): void {
  const k = 1 / Math.max(0.4, Math.sin(Math.PI * cy));
  c.g.beginPath();
  c.g.ellipse(fx(c, dx, cy), fy(c, cy), rx * k * c.s, ry * c.s, rot, 0, Math.PI * 2);
}

/** A stroked arc, used for closed eyes, brows and every smile in the game. */
function farc(c: Cell, dx: number, cy: number, rx: number, ry: number, a0: number, a1: number, width: number, color: number): void {
  const k = 1 / Math.max(0.4, Math.sin(Math.PI * cy));
  c.g.save();
  c.g.lineCap = "round";
  c.g.lineWidth = width * c.s;
  c.g.strokeStyle = hex(color);
  c.g.beginPath();
  c.g.ellipse(fx(c, dx, cy), fy(c, cy), rx * k * c.s, ry * c.s, 0, a0, a1);
  c.g.stroke();
  c.g.restore();
}

// Feature scale is set by the chase camera, not by anatomy: a driver's head is
// forty pixels tall for most of a race, so the eyes are drawn nearly twice the
// size a realistic face would use. Shrink these and the cast goes blank.
const EYE_Y = 0.55;
const EYE_DX = 0.135;

function drawEye(c: Cell, style: FaceStyle, expr: Expression, side: -1 | 1): void {
  const g = c.g;
  const dx = EYE_DX * side;
  const shapes: Record<FaceStyle["eye"], { rx: number; ry: number }> = {
    round: { rx: 0.076, ry: 0.092 },
    oval: { rx: 0.068, ry: 0.088 },
    slit: { rx: 0.086, ry: 0.055 },
    bead: { rx: 0.054, ry: 0.058 },
    goggle: { rx: 0.09, ry: 0.09 },
    led: { rx: 0.095, ry: 0.044 },
  };
  const sh = shapes[style.eye];

  if (expr === "blink" || expr === "smile" || expr === "cheer") {
    // Closed and happy: an upward arc. The single most valuable expression in
    // the whole atlas — it is what makes a character look *pleased*.
    farc(c, dx, EYE_Y + 0.012, sh.rx * 1.15, sh.ry * 0.95, Math.PI * 1.08, Math.PI * 1.92, 0.02, shade(style.iris, -0.45));
    return;
  }
  if (expr === "hurt") {
    const px = fx(c, dx, EYE_Y);
    const py = fy(c, EYE_Y);
    const r = sh.rx * c.s * 1.1;
    g.save();
    g.strokeStyle = hex(shade(style.iris, -0.5));
    g.lineWidth = 0.022 * c.s;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(px - r, py - r);
    g.lineTo(px + r, py + r);
    g.moveTo(px + r, py - r);
    g.lineTo(px - r, py + r);
    g.stroke();
    g.restore();
    return;
  }

  const wide = expr === "shock" ? 1.35 : 1;
  const squint = expr === "focus" ? 0.66 : expr === "strain" ? 0.5 : 1;

  if (style.eye === "led") {
    // The robot has no sclera: a glowing bar with a hot core.
    fdisc(c, dx, EYE_Y, sh.rx * wide, sh.ry * squint);
    g.fillStyle = hex(shade(style.iris, -0.25));
    g.fill();
    fdisc(c, dx, EYE_Y, sh.rx * 0.7 * wide, sh.ry * 0.55 * squint);
    g.fillStyle = hex(shade(style.iris, 0.55));
    g.fill();
    return;
  }

  // Sclera, with a faint upper shadow so the eye sits *in* the head.
  fdisc(c, dx, EYE_Y, sh.rx * wide, sh.ry * squint);
  g.fillStyle = "#fdfdff";
  g.fill();
  g.save();
  fdisc(c, dx, EYE_Y, sh.rx * wide, sh.ry * squint);
  g.clip();
  g.fillStyle = rgba(0x0a0d18, 0.16);
  g.fillRect(fx(c, dx, EYE_Y) - c.s * 0.1, fy(c, EYE_Y) - c.s * 0.1, c.s * 0.2, c.s * 0.055);
  g.restore();

  // Iris + pupil, looking very slightly inwards — dead-ahead eyes read as
  // vacant, a couple of degrees of convergence reads as attention.
  const irisR = expr === "shock" ? sh.rx * 0.4 : sh.rx * 0.66;
  const gaze = -side * 0.012;
  fdisc(c, dx + gaze, EYE_Y + 0.006, irisR, irisR * 1.05);
  g.fillStyle = hex(style.iris);
  g.fill();
  fdisc(c, dx + gaze, EYE_Y + 0.008, irisR * 0.55, irisR * 0.6);
  g.fillStyle = hex(shade(style.iris, -0.7));
  g.fill();
  fdisc(c, dx + gaze - 0.014, EYE_Y - 0.014, irisR * 0.32, irisR * 0.32);
  g.fillStyle = "rgba(255,255,255,0.95)";
  g.fill();

  if (expr === "focus" || expr === "strain") {
    // Lower lid pushed up — the whole "trying very hard" read.
    g.save();
    g.fillStyle = hex(style.crown === 0 ? 0xcc9977 : shade(style.crown, -0.1));
    fdisc(c, dx, EYE_Y + sh.ry * squint * 0.9, sh.rx * 1.25, sh.ry * 0.5);
    g.fill();
    g.restore();
  }
}

function drawBrow(c: Cell, style: FaceStyle, expr: Expression, side: -1 | 1): void {
  if (style.brow === "none") return;
  const dx = EYE_DX * side;
  const lift =
    expr === "shock" ? -0.045 : expr === "cheer" ? -0.02 : expr === "focus" || expr === "strain" ? 0.028 : 0;
  const tilt =
    style.brow === "angry" || expr === "focus" || expr === "strain"
      ? side * 0.22
      : expr === "shock"
        ? side * -0.12
        : style.brow === "arch"
          ? side * -0.06
          : 0;
  const y = EYE_Y - 0.105 + lift;
  const g = c.g;
  g.save();
  g.strokeStyle = hex(style.browColor);
  g.lineWidth = 0.032 * c.s;
  g.lineCap = "round";
  const k = 1 / Math.max(0.4, Math.sin(Math.PI * y));
  const px = fx(c, dx, y);
  const py = fy(c, y);
  const half = 0.07 * k * c.s;
  g.beginPath();
  g.moveTo(px - half, py + tilt * c.s * 0.5);
  g.quadraticCurveTo(px, py - (style.brow === "arch" ? 0.03 : 0.012) * c.s, px + half, py - tilt * c.s * 0.5);
  g.stroke();
  g.restore();
}

function drawMouth(c: Cell, style: FaceStyle, expr: Expression): void {
  const g = c.g;
  const y = 0.7;
  const ink = shade(style.crown, -0.6);
  switch (expr) {
    case "cheer": {
      // Open whoop: a filled arc with a tongue. Reads from 30 metres.
      fdisc(c, 0, y + 0.01, 0.094, 0.086);
      g.fillStyle = hex(0x5a2230);
      g.fill();
      g.save();
      fdisc(c, 0, y + 0.01, 0.094, 0.086);
      g.clip();
      fdisc(c, 0, y + 0.08, 0.058, 0.052);
      g.fillStyle = hex(0xe8607a);
      g.fill();
      g.restore();
      break;
    }
    case "shock": {
      fdisc(c, 0, y + 0.015, 0.04, 0.05);
      g.fillStyle = hex(0x5a2230);
      g.fill();
      break;
    }
    case "strain": {
      // Gritted teeth: a filled bar with vertical splits.
      const k = 1 / Math.max(0.4, Math.sin(Math.PI * y));
      const px = fx(c, 0, y);
      const py = fy(c, y);
      const w = 0.118 * k * c.s;
      const h = 0.046 * c.s;
      g.save();
      g.fillStyle = hex(0x4a1c28);
      roundRectPath(g, px - w, py - h * 0.5, w * 2, h, h * 0.35);
      g.fill();
      g.fillStyle = "#f6f1e6";
      roundRectPath(g, px - w * 0.92, py - h * 0.34, w * 1.84, h * 0.68, h * 0.2);
      g.fill();
      g.strokeStyle = rgba(0x4a1c28, 0.7);
      g.lineWidth = 0.008 * c.s;
      for (let i = -2; i <= 2; i++) {
        const x = px + i * w * 0.36;
        g.beginPath();
        g.moveTo(x, py - h * 0.34);
        g.lineTo(x, py + h * 0.34);
        g.stroke();
      }
      g.restore();
      break;
    }
    case "hurt": {
      const k = 1 / Math.max(0.4, Math.sin(Math.PI * y));
      const px = fx(c, 0, y);
      const py = fy(c, y);
      const w = 0.085 * k * c.s;
      g.save();
      g.strokeStyle = hex(ink);
      g.lineWidth = 0.022 * c.s;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(px - w, py);
      for (let i = 1; i <= 4; i++) {
        g.lineTo(px - w + (i / 4) * w * 2, py + (i % 2 ? 0.022 : -0.022) * c.s);
      }
      g.stroke();
      g.restore();
      break;
    }
    case "focus":
    case "neutral": {
      if (style.mouth === "line" || expr === "focus") {
        farc(c, 0, y - 0.03, 0.072, 0.066, Math.PI * 0.18, Math.PI * 0.82, 0.024, ink);
      } else if (style.mouth === "smirk") {
        farc(c, 0.02, y - 0.03, 0.066, 0.06, Math.PI * 0.1, Math.PI * 0.72, 0.024, ink);
      } else {
        farc(c, 0, y - 0.035, 0.075, 0.072, Math.PI * 0.16, Math.PI * 0.84, 0.024, ink);
      }
      break;
    }
    default: {
      // neutral-happy family: smile and blink share the friendly curve.
      const wide = expr === "smile" ? 1.25 : 1;
      farc(c, 0, y - 0.04, 0.082 * wide, 0.084, Math.PI * 0.14, Math.PI * 0.86, 0.026, ink);
      break;
    }
  }
}

function drawFaceCell(c: Cell, look: RacerLook, expr: Expression, rng: () => number): void {
  const g = c.g;
  const style = look.driver.face;
  const skin = look.preset.driver.skin;

  g.save();
  g.beginPath();
  g.rect(c.ox, c.oy, c.s, c.s);
  g.clip();

  // 1. Crown / hair / shell over the whole head, then the face oval punched
  //    back out in skin. Two flat shapes: the graphic read a stylised character
  //    lives or dies on.
  g.fillStyle = hex(style.crown);
  g.fillRect(c.ox, c.oy, c.s, c.s);

  fdisc(c, 0, 0.585, 0.26, 0.278);
  g.fillStyle = hex(skin);
  g.fill();

  // A softer skin wedge up the middle of the forehead stops the hairline from
  // looking like a bowl cut on every single character.
  g.save();
  fdisc(c, 0, 0.585, 0.26, 0.278);
  g.clip();
  fdisc(c, 0, 0.38, 0.12, 0.12);
  g.fillStyle = hex(skin);
  g.fill();
  g.restore();

  // 2. Form shading: warm under the chin, cool at the temples. Very light —
  //    the PBR lighting does the real work, this only stops the flat fill from
  //    reading as paper.
  const gy = g.createLinearGradient(0, c.oy + c.s * 0.32, 0, c.oy + c.s * 0.9);
  gy.addColorStop(0, rgba(0xffffff, 0.1));
  gy.addColorStop(0.5, rgba(0xffffff, 0));
  gy.addColorStop(1, rgba(0x2a1a20, 0.22));
  g.fillStyle = gy;
  g.fillRect(c.ox, c.oy, c.s, c.s);

  // 3. Marks that sit under the features.
  if (style.mark === "stripe") {
    g.save();
    fdisc(c, 0, 0.585, 0.26, 0.278);
    g.clip();
    g.fillStyle = hex(style.markColor);
    g.beginPath();
    g.moveTo(fx(c, -0.05, 0.34), fy(c, 0.34));
    g.lineTo(fx(c, 0.05, 0.34), fy(c, 0.34));
    g.lineTo(fx(c, 0.03, 0.78), fy(c, 0.78));
    g.lineTo(fx(c, -0.03, 0.78), fy(c, 0.78));
    g.closePath();
    g.fill();
    g.restore();
  } else if (style.mark === "swirl") {
    g.save();
    g.strokeStyle = rgba(style.markColor, 0.85);
    g.lineWidth = 0.018 * c.s;
    g.beginPath();
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const a = t * Math.PI * 3;
      const r = 0.02 + t * 0.08;
      const px = fx(c, -0.17 + Math.cos(a) * r, 0.42 + Math.sin(a) * r);
      const py = fy(c, 0.42 + Math.sin(a) * r);
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();
    g.restore();
  } else if (style.mark === "plate") {
    g.save();
    g.fillStyle = rgba(style.markColor, 0.9);
    fdisc(c, 0, 0.79, 0.15, 0.075);
    g.fill();
    g.strokeStyle = rgba(0x000000, 0.25);
    g.lineWidth = 0.01 * c.s;
    g.stroke();
    g.restore();
  }

  // 4. Blush before the eyes so the eyes sit on top of it.
  if (style.blush > 0) {
    for (const side of [-1, 1] as const) {
      const px = fx(c, 0.185 * side, 0.655);
      const py = fy(c, 0.655);
      const r = 0.075 * c.s;
      const rg = g.createRadialGradient(px, py, 0, px, py, r);
      rg.addColorStop(0, rgba(0xff6b8a, 0.55 * style.blush));
      rg.addColorStop(1, rgba(0xff6b8a, 0));
      g.fillStyle = rg;
      g.beginPath();
      g.arc(px, py, r, 0, Math.PI * 2);
      g.fill();
    }
  }

  // 5. Speckles — freckles, rivets, moss, sprinkles. Character in four lines.
  if (style.speckle !== "none") {
    const n = style.speckle === "sprinkle" ? 26 : 14;
    for (let i = 0; i < n; i++) {
      const dx = (rng() - 0.5) * 0.42;
      const cy = 0.42 + rng() * 0.34;
      const r = (style.speckle === "rivet" ? 0.011 : 0.008) * (0.7 + rng() * 0.8);
      g.save();
      if (style.speckle === "sprinkle") {
        g.translate(fx(c, dx, cy), fy(c, cy));
        g.rotate(rng() * Math.PI);
        g.fillStyle = hex(i % 3 === 0 ? style.speckleColor : i % 3 === 1 ? 0xffd23f : 0x8affc9);
        g.fillRect(-r * c.s * 2, -r * c.s * 0.5, r * c.s * 4, r * c.s);
      } else {
        fdisc(c, dx, cy, r, r);
        g.fillStyle = rgba(style.speckleColor, style.speckle === "moss" ? 0.75 : 0.55);
        g.fill();
        if (style.speckle === "rivet") {
          fdisc(c, dx - r * 0.3, cy - r * 0.3, r * 0.4, r * 0.4);
          g.fillStyle = rgba(0xffffff, 0.5);
          g.fill();
        }
      }
      g.restore();
    }
  }

  drawEye(c, style, expr, -1);
  drawEye(c, style, expr, 1);

  if (style.mark === "eyepatch") {
    g.save();
    g.fillStyle = rgba(style.markColor, 0.92);
    fdisc(c, -EYE_DX, EYE_Y, 0.1, 0.055);
    g.fill();
    g.restore();
  }

  drawBrow(c, style, expr, -1);
  drawBrow(c, style, expr, 1);
  drawMouth(c, style, expr);

  // 6. A nose: two dots of shadow. Any more and a stylised face gets literal.
  g.fillStyle = rgba(0x000000, 0.14);
  fdisc(c, 0, 0.635, 0.022, 0.014);
  g.fill();

  g.restore();
}

export interface FaceAtlas {
  texture: THREE.CanvasTexture;
  /** Sub-rect size, already applied to `texture.repeat`. */
  repeat: { x: number; y: number };
}

/** Bake the eight-expression head texture for one character. */
export function bakeFaceAtlas(look: RacerLook, cellSize: number): FaceAtlas {
  const c2d = makeCanvas(cellSize * FACE_COLS, cellSize * FACE_ROWS);
  for (let i = 0; i < EXPRESSIONS.length; i++) {
    const col = i % FACE_COLS;
    const row = Math.floor(i / FACE_COLS);
    // The same speckle layout in every cell: a face whose freckles move when it
    // blinks is a face that is obviously a texture swap.
    const cellRng = makeRng(`face:${look.preset.id}:speckle`);
    drawFaceCell(
      { g: c2d.g, ox: col * cellSize, oy: row * cellSize, s: cellSize },
      look,
      EXPRESSIONS[i],
      cellRng,
    );
  }
  const tex = texture(c2d, { wrapU: THREE.RepeatWrapping, wrapV: THREE.ClampToEdgeWrapping });
  tex.repeat.set(1 / FACE_COLS, 1 / FACE_ROWS);
  const off = faceOffset("neutral");
  tex.offset.set(off.x, off.y);
  return { texture: tex, repeat: { x: 1 / FACE_COLS, y: 1 / FACE_ROWS } };
}

// ---------------------------------------------------------------------------
// Liveries
// ---------------------------------------------------------------------------

/** U of the top deck and of the two flanks, in loft profile space. */
const U_TOP = 0.25;
const U_BOTTOM = 0.75;

/**
 * Paint the body wrap. Everything is authored in normalised (u, v) and scaled
 * to pixels at the end, so the same code bakes a 256² texture on `low` and a
 * 1024² on `ultra` with identical proportions.
 */
export function bakeLivery(look: RacerLook, size: number): THREE.CanvasTexture {
  const c = makeCanvas(size, size);
  const g = c.g;
  const W = size;
  const H = size;
  const rng = makeRng(`livery:${look.preset.id}`);
  const body = look.preset.colors.body;
  const accent = look.preset.colors.accent;
  const trim = look.preset.colors.trim;
  const pattern = look.kart.livery;

  // Canvas row 0 is V = 1 (the tail), because CanvasTexture keeps flipY.
  const vy = (v: number) => (1 - v) * H;
  const ux = (u: number) => u * W;

  g.fillStyle = hex(body);
  g.fillRect(0, 0, W, H);

  // Large-scale mottle. A wrap is never a perfectly even fill, and a perfectly
  // even fill is the fastest way to make a car look like a shaded cube.
  for (let i = 0; i < 26; i++) {
    const px = rng() * W;
    const py = rng() * H;
    const r = (0.1 + rng() * 0.3) * W;
    const rg = g.createRadialGradient(px, py, 0, px, py, r);
    const up = rng() > 0.5;
    rg.addColorStop(0, rgba(up ? 0xffffff : 0x000000, 0.035));
    rg.addColorStop(1, rgba(up ? 0xffffff : 0x000000, 0));
    g.fillStyle = rg;
    g.fillRect(px - r, py - r, r * 2, r * 2);
  }

  // The floor pan is never body colour on a real kart, and darkening it gives
  // the whole vehicle a grounded base tone from every angle.
  const floor = g.createLinearGradient(ux(U_BOTTOM - 0.2), 0, ux(U_BOTTOM + 0.2), 0);
  floor.addColorStop(0, rgba(0x000000, 0));
  floor.addColorStop(0.5, rgba(0x0a0c12, 0.55));
  floor.addColorStop(1, rgba(0x000000, 0));
  g.fillStyle = floor;
  g.fillRect(0, 0, W, H);

  const stripeBand = (u0: number, u1: number, color: number, alpha = 1) => {
    wrapX(g, W, () => {
      g.fillStyle = rgba(color, alpha);
      g.fillRect(ux(u0), 0, ux(u1 - u0), H);
    });
  };

  switch (pattern) {
    case "stripe": {
      // Twin racing stripes over the deck, split by a hairline of trim.
      stripeBand(U_TOP - 0.075, U_TOP - 0.012, accent);
      stripeBand(U_TOP + 0.012, U_TOP + 0.075, accent);
      stripeBand(U_TOP - 0.006, U_TOP + 0.006, trim);
      break;
    }
    case "bolt": {
      // A lightning zig down each flank — sharp angles for the sharp character.
      for (const u of [0.0, 0.5]) {
        wrapX(g, W, () => {
          g.fillStyle = hex(accent);
          g.beginPath();
          const p: Array<[number, number]> = [
            [u - 0.05, 0.06],
            [u + 0.02, 0.06],
            [u - 0.012, 0.45],
            [u + 0.055, 0.42],
            [u - 0.035, 0.98],
            [u - 0.01, 0.5],
            [u - 0.075, 0.53],
          ];
          p.forEach(([pu, pv], i) => (i ? g.lineTo(ux(pu), vy(pv)) : g.moveTo(ux(pu), vy(pv))));
          g.closePath();
          g.fill();
        });
      }
      break;
    }
    case "bubble": {
      for (let i = 0; i < 46; i++) {
        const u = rng();
        const v = rng();
        const r = (0.012 + rng() * 0.05) * W;
        wrapX(g, W, () => {
          g.fillStyle = rgba(accent, 0.85);
          g.beginPath();
          g.arc(ux(u), vy(v), r, 0, Math.PI * 2);
          g.fill();
          g.strokeStyle = rgba(0xffffff, 0.5);
          g.lineWidth = r * 0.14;
          g.beginPath();
          g.arc(ux(u) - r * 0.25, vy(v) - r * 0.25, r * 0.55, Math.PI * 0.9, Math.PI * 1.7);
          g.stroke();
        });
      }
      break;
    }
    case "flame": {
      // Tongues licking back from the nose (v = 0) along both flanks.
      for (const u of [0.0, 0.5]) {
        wrapX(g, W, () => {
          for (let k = 0; k < 5; k++) {
            const off = (k - 2) * 0.035;
            const len = 0.32 + rng() * 0.34;
            g.fillStyle = rgba(k % 2 ? accent : shade(accent, 0.35), 0.95);
            g.beginPath();
            g.moveTo(ux(u + off - 0.03), vy(0));
            g.quadraticCurveTo(ux(u + off + 0.05), vy(len * 0.55), ux(u + off + 0.005), vy(len));
            g.quadraticCurveTo(ux(u + off - 0.03), vy(len * 0.5), ux(u + off + 0.03), vy(0));
            g.closePath();
            g.fill();
          }
        });
      }
      break;
    }
    case "wave": {
      wrapX(g, W, () => {
        g.fillStyle = rgba(accent, 0.92);
        g.beginPath();
        g.moveTo(0, vy(0.38));
        for (let i = 0; i <= 64; i++) {
          const u = i / 64;
          g.lineTo(ux(u), vy(0.38 + Math.sin(u * Math.PI * 4) * 0.09));
        }
        for (let i = 64; i >= 0; i--) {
          const u = i / 64;
          g.lineTo(ux(u), vy(0.2 + Math.sin(u * Math.PI * 4 + 0.7) * 0.07));
        }
        g.closePath();
        g.fill();
      });
      break;
    }
    case "check": {
      // Chequer band around the tail. Two rows, offset — one row reads as a
      // dashed line, two read as a flag.
      const cell = 1 / 16;
      for (let i = 0; i < 16; i++) {
        for (let r = 0; r < 2; r++) {
          if ((i + r) % 2) continue;
          g.fillStyle = hex(accent);
          g.fillRect(ux(i * cell), vy(0.9 - r * cell * 2.2), ux(cell), (cell * 2.2) * H);
        }
      }
      break;
    }
    case "swirl": {
      for (let i = 0; i < 7; i++) {
        const v0 = i / 7;
        wrapX(g, W, () => {
          g.strokeStyle = rgba(i % 2 ? accent : trim, 0.6);
          g.lineWidth = H * 0.035;
          g.beginPath();
          for (let k = 0; k <= 40; k++) {
            const u = k / 40;
            const v = v0 + u * 0.28;
            if (k === 0) g.moveTo(ux(u), vy(v));
            else g.lineTo(ux(u), vy(v));
          }
          g.stroke();
        });
      }
      break;
    }
    case "plate": {
      // Riveted armour: panel seams, weld beads, a hazard chevron block.
      g.strokeStyle = rgba(0x000000, 0.4);
      g.lineWidth = H * 0.006;
      for (let i = 1; i < 5; i++) {
        g.beginPath();
        g.moveTo(0, vy(i / 5));
        g.lineTo(W, vy(i / 5));
        g.stroke();
      }
      for (let i = 0; i < 4; i++) {
        g.beginPath();
        g.moveTo(ux(i / 4), 0);
        g.lineTo(ux(i / 4), H);
        g.stroke();
      }
      for (let i = 0; i < 60; i++) {
        const u = rng();
        const v = rng();
        g.fillStyle = rgba(0xffffff, 0.28);
        g.beginPath();
        g.arc(ux(u), vy(v), W * 0.006, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = rgba(0x000000, 0.3);
        g.beginPath();
        g.arc(ux(u) + W * 0.004, vy(v) + W * 0.004, W * 0.005, 0, Math.PI * 2);
        g.fill();
      }
      wrapX(g, W, () => {
        for (let i = 0; i < 8; i++) {
          g.fillStyle = i % 2 ? hex(accent) : hex(look.preset.colors.trim);
          g.save();
          g.beginPath();
          g.rect(ux(0.44), vy(0.86), ux(0.12), H * 0.1);
          g.clip();
          g.translate(ux(0.44) + i * W * 0.018, vy(0.86));
          g.rotate(-0.5);
          g.fillRect(-W * 0.02, -H * 0.05, W * 0.012, H * 0.2);
          g.restore();
        }
      });
      break;
    }
  }

  // Shared furniture: a trim pinstripe along the shoulder line and a roundel on
  // each flank. It is the small consistent detail across eight different wraps
  // that makes them feel like one product.
  wrapX(g, W, () => {
    g.strokeStyle = rgba(trim, 0.9);
    g.lineWidth = H * 0.012;
    for (const u of [U_TOP - 0.13, U_TOP + 0.13]) {
      g.beginPath();
      g.moveTo(ux(u), vy(0.05));
      g.lineTo(ux(u), vy(0.95));
      g.stroke();
    }
  });
  for (const u of [0.0, 0.5]) {
    wrapX(g, W, () => {
      const px = ux(u);
      const py = vy(0.62);
      const r = W * 0.06;
      g.fillStyle = rgba(0xffffff, 0.92);
      g.beginPath();
      g.arc(px, py, r, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = hex(trim);
      g.lineWidth = r * 0.18;
      g.stroke();
      g.fillStyle = hex(accent);
      g.beginPath();
      g.arc(px, py, r * 0.45, 0, Math.PI * 2);
      g.fill();
    });
  }

  // Metallic flake, faint. The clearcoat + envmap does the sparkle; this just
  // stops large flat panels from banding.
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 10;
    d[i] = clamp01((d[i] + n) / 255) * 255;
    d[i + 1] = clamp01((d[i + 1] + n) / 255) * 255;
    d[i + 2] = clamp01((d[i + 2] + n) / 255) * 255;
  }
  g.putImageData(img, 0, 0);

  return texture(c, { wrapU: THREE.RepeatWrapping, wrapV: THREE.RepeatWrapping, aniso: 8 });
}

// ---------------------------------------------------------------------------
// Number plates
// ---------------------------------------------------------------------------

/** Race number, on a plate with the character's trim colour as the frame. */
export function bakeNumberPlate(n: number, colors: { body: number; accent: number; trim: number }, size: number): THREE.CanvasTexture {
  const c = makeCanvas(size, Math.round(size * 0.6));
  const g = c.g;
  const W = c.w;
  const H = c.h;

  g.fillStyle = hex(colors.trim);
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#f7f4ec";
  const inset = W * 0.06;
  roundRectPath(g, inset, inset, W - inset * 2, H - inset * 2, W * 0.07);
  g.fill();

  // A wash of the accent behind the digit, so a plate glimpsed at speed still
  // carries the character's colour.
  const rg = g.createLinearGradient(0, inset, 0, H - inset);
  rg.addColorStop(0, rgba(colors.accent, 0.28));
  rg.addColorStop(1, rgba(colors.accent, 0));
  g.fillStyle = rg;
  roundRectPath(g, inset, inset, W - inset * 2, H - inset * 2, W * 0.07);
  g.fill();

  const label = String(n);
  g.textAlign = "center";
  g.textBaseline = "middle";
  // System font stack only — nothing is downloaded. The heavy stroke means a
  // metric difference between platforms costs nothing legible.
  g.font = `900 ${Math.round(H * 0.72)}px "Arial Black", Impact, system-ui, sans-serif`;
  g.lineWidth = H * 0.09;
  g.lineJoin = "round";
  g.strokeStyle = hex(colors.trim);
  g.strokeText(label, W / 2, H * 0.54);
  g.fillStyle = hex(0x1a1e28);
  g.fillText(label, W / 2, H * 0.54);

  return texture(c);
}

// ---------------------------------------------------------------------------
// Contact shadow
// ---------------------------------------------------------------------------

/**
 * The blob. A shadow map alone leaves a kart looking like it is hovering a
 * centimetre off the tarmac — the penumbra is too soft right at the contact
 * patch. This sits underneath every racer and does the last centimetre.
 */
export function bakeBlobShadow(size: number): THREE.CanvasTexture {
  const c = makeCanvas(size, size);
  const g = c.g;
  const r = size / 2;
  const rg = g.createRadialGradient(r, r, 0, r, r, r);
  rg.addColorStop(0, "rgba(0,0,0,0.85)");
  rg.addColorStop(0.42, "rgba(0,0,0,0.6)");
  rg.addColorStop(0.72, "rgba(0,0,0,0.22)");
  rg.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = rg;
  g.fillRect(0, 0, size, size);
  // Squash it slightly along the kart's length so the blob reads as a vehicle
  // rather than a beach ball.
  const tex = texture(c, { srgb: false });
  return tex;
}

export { hex as colorHex, shade as shadeColor };
