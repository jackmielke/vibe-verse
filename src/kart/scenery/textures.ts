/**
 * Vibe Kart — scenery textures.
 *
 * Everything trackside that is *not* a surface the karts touch gets its texture
 * from here: leaf cards, grass blades, sponsor artwork, flag designs, fabric,
 * painted metal, rock. The road-facing surfaces come from the shared material
 * library instead — this file exists for the things that library has no entry
 * for, chiefly the alpha-cut vegetation and the signage atlases.
 *
 * Two rules:
 *
 * · **Albedo goes straight to a `CanvasTexture`.** No read-back, no DataTexture
 *   round trip. It is a third of the bake cost and identical on the wire.
 *
 * · **Normals are derived from a separate height canvas.** One `getImageData`
 *   per material, Sobel over the luminance, straight into a `DataTexture`. The
 *   screenshot harness runs on SwiftShader, so nothing here asks for float
 *   textures, mip generation of NPOT sizes, or anisotropy the context lacks.
 *
 * Sizes are small on purpose. A leaf card is eight pixels tall on screen at
 * 100 km/h; spending 1024² on it buys nothing but a longer loading bar.
 */
import * as THREE from "three";
import { makeRng, TAU, type Rng } from "./util";

export type Ctx2D = CanvasRenderingContext2D;

export interface Canvas2D {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: Ctx2D;
  size: number;
}

/** Quality → texture side multiplier. Alpha cards are the last thing to shrink. */
const SCALE: Record<string, number> = { low: 0.5, medium: 0.75, high: 1, ultra: 1 };

export function textureScale(quality: string): number {
  return SCALE[quality] ?? 1;
}

export function surfaceWH(width: number, height: number): Canvas2D {
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(width, height);
  } else {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    canvas = c;
  }
  // willReadFrequently matters for the height canvases: every one of them is
  // read straight back with getImageData to derive a normal map, and without
  // the hint the browser keeps the surface GPU-side and stalls on each read.
  const ctx = (canvas as HTMLCanvasElement).getContext("2d", {
    willReadFrequently: true,
    alpha: true,
  }) as unknown as Ctx2D;
  return { canvas, ctx, size: Math.min(width, height) };
}

export function surface(size: number): Canvas2D {
  return surfaceWH(size, size);
}

function toTexture(s: Canvas2D, srgb: boolean, repeat = 1): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(s.canvas as HTMLCanvasElement);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Sobel a height canvas into a tangent-space normal map.
 *
 * `strength` is in "how much relief do you want at speed" units, not physical
 * ones — motion eats surface detail, so every value here is louder than it
 * would need to be in a turntable render.
 */
function normalFromHeight(h: Canvas2D, strength: number): THREE.DataTexture {
  const n = h.size;
  const src = h.ctx.getImageData(0, 0, n, n).data;
  const out = new Uint8Array(n * n * 4);
  const lum = (i: number) => (src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114) / 255;
  const idx = (x: number, y: number) => ((y + n) % n) * n + ((x + n) % n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx =
        lum(idx(x + 1, y - 1)) + 2 * lum(idx(x + 1, y)) + lum(idx(x + 1, y + 1)) -
        lum(idx(x - 1, y - 1)) - 2 * lum(idx(x - 1, y)) - lum(idx(x - 1, y + 1));
      const dy =
        lum(idx(x - 1, y + 1)) + 2 * lum(idx(x, y + 1)) + lum(idx(x + 1, y + 1)) -
        lum(idx(x - 1, y - 1)) - 2 * lum(idx(x, y - 1)) - lum(idx(x + 1, y - 1));
      let nx = -dx * strength;
      let ny = -dy * strength;
      const nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      const i = (y * n + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz / l * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(out, n, n, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

function fill(s: Canvas2D, style: string): void {
  s.ctx.fillStyle = style;
  s.ctx.fillRect(0, 0, s.size, s.size);
}

/** Speckle: the cheapest thing that stops a flat fill looking like a flat fill. */
function speckle(s: Canvas2D, rng: Rng, count: number, radius: number, alpha: number, light = true): void {
  const c = s.ctx;
  for (let i = 0; i < count; i++) {
    const a = alpha * (0.35 + rng() * 0.65);
    c.fillStyle = light ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    c.beginPath();
    c.arc(rng() * s.size, rng() * s.size, radius * (0.4 + rng() * 0.9), 0, TAU);
    c.fill();
  }
}

/** A soft radial blob, wrapped so it tiles. */
function blob(s: Canvas2D, x: number, y: number, r: number, style: string): void {
  const c = s.ctx;
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const px = x + ox * s.size;
      const py = y + oy * s.size;
      if (px < -r || px > s.size + r || py < -r || py > s.size + r) continue;
      const g = c.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, style);
      g.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = g;
      c.fillRect(px - r, py - r, r * 2, r * 2);
    }
  }
}

function rgb(hex: number, alpha = 1): string {
  return `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${alpha})`;
}

// ---------------------------------------------------------------------------
// Material map sets
// ---------------------------------------------------------------------------

export interface MapSet {
  map: THREE.Texture;
  normalMap?: THREE.Texture;
  /** Registered so the pool can free them; the caller never touches this. */
  all: THREE.Texture[];
}

/**
 * Painted panel — the workhorse.
 *
 * Near-white with a faint roller texture and a wash of edge grime, so a
 * vertex-coloured prop multiplies down to a *painted object* rather than a
 * solid hex fill. Every merged prop in the directory uses this one material.
 */
export function bakePainted(size: number): MapSet {
  const rng = makeRng("kart/scenery/painted");
  const alb = surface(size);
  fill(alb, "#f3f2ef");
  // Broad tonal drift — the sun-bleach and shadow of a real painted surface.
  for (let i = 0; i < 26; i++) {
    blob(alb, rng() * size, rng() * size, size * (0.1 + rng() * 0.28), rgb(rng() < 0.5 ? 0xffffff : 0xd8d5cd, 0.3));
  }
  speckle(alb, rng, size * 3, size / 220, 0.1, false);
  speckle(alb, rng, size * 2, size / 300, 0.12, true);
  // Roller streaks, faint and vertical.
  alb.ctx.globalAlpha = 0.06;
  for (let i = 0; i < 60; i++) {
    alb.ctx.strokeStyle = rng() < 0.5 ? "#ffffff" : "#b9b5ac";
    alb.ctx.lineWidth = 1 + rng() * 2.5;
    const x = rng() * size;
    alb.ctx.beginPath();
    alb.ctx.moveTo(x, 0);
    alb.ctx.lineTo(x + (rng() - 0.5) * 8, size);
    alb.ctx.stroke();
  }
  alb.ctx.globalAlpha = 1;

  const hgt = surface(size);
  fill(hgt, "#808080");
  speckle(hgt, makeRng("kart/scenery/painted-h"), size * 5, size / 180, 0.35, true);
  speckle(hgt, makeRng("kart/scenery/painted-h2"), size * 4, size / 160, 0.3, false);

  const map = toTexture(alb, true);
  const normalMap = normalFromHeight(hgt, 2.4);
  return { map, normalMap, all: [map, normalMap] };
}

/**
 * Woven fabric for banners, canopies, flags and air dancers. The weave is
 * genuinely a weave — perpendicular thread runs at one-pixel pitch — because a
 * blurred noise field reads as dirt, not cloth.
 */
export function bakeFabric(size: number): MapSet {
  const rng = makeRng("kart/scenery/fabric");
  const alb = surface(size);
  fill(alb, "#ffffff");
  const c = alb.ctx;
  const pitch = Math.max(2, Math.round(size / 96));
  c.globalAlpha = 0.11;
  for (let x = 0; x < size; x += pitch) {
    c.fillStyle = "#000000";
    c.fillRect(x, 0, Math.max(1, pitch * 0.42), size);
  }
  for (let y = 0; y < size; y += pitch) {
    c.fillStyle = "#ffffff";
    c.fillRect(0, y, size, Math.max(1, pitch * 0.42));
  }
  c.globalAlpha = 1;
  speckle(alb, rng, size, size / 260, 0.07, false);

  const hgt = surface(size);
  fill(hgt, "#7a7a7a");
  const h = hgt.ctx;
  for (let x = 0; x < size; x += pitch) {
    h.fillStyle = "#c8c8c8";
    h.fillRect(x, 0, Math.max(1, pitch * 0.5), size);
  }
  for (let y = 0; y < size; y += pitch) {
    h.fillStyle = "#444444";
    h.fillRect(0, y, size, Math.max(1, pitch * 0.5));
  }

  const map = toTexture(alb, true);
  const normalMap = normalFromHeight(hgt, 1.5);
  return { map, normalMap, all: [map, normalMap] };
}

/** Rough rock for hills, mesas and the cliff line. Big strata, hard edges. */
export function bakeRock(size: number): MapSet {
  const rng = makeRng("kart/scenery/rock");
  const alb = surface(size);
  fill(alb, "#9a8f7e");
  for (let i = 0; i < 40; i++) {
    blob(alb, rng() * size, rng() * size, size * (0.08 + rng() * 0.25), rgb(rng() < 0.5 ? 0xb5a894 : 0x6f6656, 0.45));
  }
  // Strata: horizontal bands, slightly wavy, of alternating warm/cool stone.
  const c = alb.ctx;
  for (let i = 0; i < 14; i++) {
    const y = rng() * size;
    const th = size * (0.01 + rng() * 0.045);
    c.fillStyle = rgb(rng() < 0.5 ? 0x7d7161 : 0xc0b39c, 0.22 + rng() * 0.2);
    c.beginPath();
    c.moveTo(0, y);
    for (let x = 0; x <= size; x += size / 8) c.lineTo(x, y + Math.sin(x * 0.02 + i) * size * 0.012);
    c.lineTo(size, y + th);
    for (let x = size; x >= 0; x -= size / 8) c.lineTo(x, y + th + Math.sin(x * 0.02 + i) * size * 0.012);
    c.closePath();
    c.fill();
  }
  speckle(alb, rng, size * 4, size / 150, 0.14, false);

  const hgt = surface(size);
  fill(hgt, "#808080");
  const hr = makeRng("kart/scenery/rock-h");
  for (let i = 0; i < 60; i++) {
    blob(hgt, hr() * size, hr() * size, size * (0.03 + hr() * 0.14), `rgba(${hr() < 0.5 ? 255 : 0},${hr() < 0.5 ? 255 : 0},${hr() < 0.5 ? 255 : 0},0.4)`);
  }
  speckle(hgt, hr, size * 6, size / 120, 0.4, true);

  const map = toTexture(alb, true);
  const normalMap = normalFromHeight(hgt, 3.2);
  return { map, normalMap, all: [map, normalMap] };
}

// ---------------------------------------------------------------------------
// Alpha-cut vegetation
// ---------------------------------------------------------------------------

export type FoliageSpecies = "broadleaf" | "conifer" | "palm" | "bush";

/**
 * One leaf card. The whole silhouette of a tree comes from this image, so the
 * edge has to be *ragged* — a card whose alpha stops at a smooth ellipse gives
 * you a bush that looks like a green pill from every angle.
 *
 * Leaves are drawn back-to-front in three depth bands with the darkest first,
 * which fakes self-shadowing inside the canopy for the price of a fill style.
 */
export function bakeFoliage(size: number, species: FoliageSpecies): MapSet {
  const rng = makeRng(`kart/scenery/foliage/${species}`);
  const alb = surface(size);
  const c = alb.ctx;
  c.clearRect(0, 0, size, size);

  const palettes: Record<FoliageSpecies, number[]> = {
    // Warm, saturated, three-value ramps. Nintendo greens are yellow-leaning at
    // the highlight and blue-leaning in the core, never a single flat green.
    broadleaf: [0x2f6b2a, 0x479a34, 0x74c445, 0xa8dc55],
    conifer: [0x18402e, 0x235a3c, 0x2f7546, 0x4a9152],
    palm: [0x2c6b34, 0x46983f, 0x6dbd4b, 0x9ed45c],
    bush: [0x2c5f2c, 0x448a36, 0x69b845, 0x9bd158],
  };
  const pal = palettes[species];

  const drawLeaf = (x: number, y: number, len: number, wid: number, ang: number, colour: number, alpha: number) => {
    c.save();
    c.translate(x, y);
    c.rotate(ang);
    c.fillStyle = rgb(colour, alpha);
    c.beginPath();
    // A pointed almond, not an ellipse — the tip is what survives mip-mapping.
    c.moveTo(0, -len * 0.5);
    c.bezierCurveTo(wid * 0.62, -len * 0.18, wid * 0.55, len * 0.26, 0, len * 0.5);
    c.bezierCurveTo(-wid * 0.55, len * 0.26, -wid * 0.62, -len * 0.18, 0, -len * 0.5);
    c.closePath();
    c.fill();
    c.restore();
  };

  if (species === "conifer") {
    // A bough seen from below: a dense mat of needle sprays, laid down darkest
    // first. Density is the whole point — a sparse needle card alpha-tests into
    // isolated tufts that float in the air with no visible branch holding them,
    // which is the single worst artefact card foliage can produce.
    for (let band = 0; band < 4; band++) {
      const colour = pal[Math.min(3, band)];
      const alpha = 0.7 + band * 0.09;
      const sprays = band === 0 ? 90 : 55;
      const spread = 1 - band * 0.14;
      for (let i = 0; i < sprays; i++) {
        // Sprays radiate from the card's centre line, the way needles grow off
        // a branch, rather than from arbitrary points.
        const bx = size * (0.5 + (rng() - 0.5) * 1.15 * spread);
        const by = size * (0.5 + (rng() - 0.5) * 1.1 * spread);
        const dir = rng() * TAU;
        const len = size * (0.13 + rng() * 0.2);
        c.strokeStyle = rgb(colour, alpha);
        c.lineWidth = Math.max(1.2, size / 150);
        // The shoot itself, then the needles along it.
        c.beginPath();
        c.moveTo(bx, by);
        c.lineTo(bx + Math.cos(dir) * len, by + Math.sin(dir) * len);
        c.stroke();
        for (let k = 0; k < 14; k++) {
          const t = k / 13;
          const px = bx + Math.cos(dir) * len * t;
          const py = by + Math.sin(dir) * len * t;
          const nl = len * 0.46 * (1 - t * 0.5);
          for (const sgn of [-1, 1]) {
            c.beginPath();
            c.moveTo(px, py);
            c.lineTo(px + Math.cos(dir + sgn * 0.95) * nl, py + Math.sin(dir + sgn * 0.95) * nl);
            c.stroke();
          }
        }
      }
    }
  } else if (species === "palm") {
    // One frond fills the card: a rachis with leaflets down both sides. The
    // card is used whole, so the geometry can be a single quad per frond.
    const midY = size * 0.5;
    c.strokeStyle = rgb(0x6a5b32, 0.95);
    c.lineWidth = Math.max(2, size / 90);
    c.beginPath();
    c.moveTo(size * 0.02, midY + size * 0.16);
    c.quadraticCurveTo(size * 0.5, midY - size * 0.1, size * 0.98, midY - size * 0.02);
    c.stroke();
    for (let i = 0; i < 40; i++) {
      const t = i / 39;
      const px = size * (0.02 + t * 0.96);
      const py = midY + size * 0.16 + (-size * 0.26 * t + size * 0.08 * t * t);
      const len = size * 0.34 * Math.sin(Math.min(1, t * 1.25) * Math.PI) ** 0.6;
      const colour = pal[1 + ((i * 7) % 3)];
      for (const sgn of [-1, 1]) {
        c.save();
        c.translate(px, py);
        c.rotate(sgn * (1.15 - t * 0.35) + 0.25);
        c.fillStyle = rgb(colour, 0.92);
        c.beginPath();
        c.moveTo(0, 0);
        c.quadraticCurveTo(len * 0.3, -size * 0.012, len, -size * 0.004);
        c.quadraticCurveTo(len * 0.35, size * 0.02, 0, size * 0.012);
        c.closePath();
        c.fill();
        c.restore();
      }
    }
  } else {
    const count = species === "bush" ? 420 : 520;
    for (let band = 0; band < 4; band++) {
      const colour = pal[band];
      const alpha = 0.7 + band * 0.075;
      for (let i = 0; i < count; i++) {
        // Cluster the leaves so the card has holes in it. Uniform scatter gives
        // an even green mush; clumps give a silhouette. Small leaves and lots
        // of them: at canopy scale a 30-pixel leaf reads as a dinner plate.
        const cxk = Math.floor(rng() * 4);
        const cyk = Math.floor(rng() * 4);
        const cx = (cxk + 0.5) * (size / 4) + (rng() - 0.5) * size * 0.34;
        const cy = (cyk + 0.5) * (size / 4) + (rng() - 0.5) * size * 0.34;
        const len = size * (0.028 + rng() * 0.042) * (1 - band * 0.06);
        drawLeaf(cx, cy, len, len * (0.46 + rng() * 0.28), rng() * TAU, colour, alpha);
      }
    }
  }

  // Cut the card into a silhouette.
  //
  // This is the single most important step in the whole file. Alpha-testing a
  // card whose artwork reaches its own edge gives you an opaque *rectangle* —
  // and a tree built from opaque rectangles is instantly, unmistakably a tree
  // built from rectangles. Eroding the alpha to nothing well inside the quad is
  // what turns each card into a leaf mass or a bough.
  //
  // The palm is the exception: its artwork is one frond that already tapers to
  // a point at both ends, and an elliptical mask would amputate the tip.
  c.globalCompositeOperation = "destination-out";
  if (species === "palm") {
    const m = Math.max(2, size * 0.05);
    for (const [gx0, gy0, gx1, gy1] of [
      [0, 0, 0, m],
      [0, size, 0, size - m],
      [0, 0, m, 0],
      [size, 0, size - m, 0],
    ] as const) {
      const g = c.createLinearGradient(gx0, gy0, gx1, gy1);
      g.addColorStop(0, "rgba(0,0,0,1)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, size, size);
    }
  } else {
    // Wide and shallow for a conifer bough, round for a leaf mass.
    const rx = size * (species === "conifer" ? 0.54 : 0.5);
    const ry = size * (species === "conifer" ? 0.4 : 0.48);
    c.save();
    c.translate(size * 0.5, size * 0.5);
    c.scale(1, ry / rx);
    const g = c.createRadialGradient(0, 0, rx * 0.42, 0, 0, rx * 0.98);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(0.72, "rgba(0,0,0,0.55)");
    g.addColorStop(1, "rgba(0,0,0,1)");
    c.fillStyle = g;
    c.fillRect(-size * 2, -size * 2, size * 4, size * 4);
    c.restore();
  }
  c.globalCompositeOperation = "source-over";

  const map = toTexture(alb, true);
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  // Alpha-tested foliage mip-maps into transparency at distance; a slightly
  // biased test in the material compensates, but keeping mips is still right.
  return { map, all: [map] };
}

/** A tuft of blades filling the card bottom-up, for the roadside grass layer. */
export function bakeGrassCard(size: number): MapSet {
  const rng = makeRng("kart/scenery/grass");
  const s = surface(size);
  const c = s.ctx;
  c.clearRect(0, 0, size, size);
  const tones = [0x4f9b34, 0x63b23c, 0x7fc94a, 0x9ad95a, 0x3f8330];
  const blades = 46;
  for (let i = 0; i < blades; i++) {
    const x0 = rng() * size;
    const h = size * (0.42 + rng() * 0.55);
    const lean = (rng() - 0.5) * size * 0.32;
    const w = size * (0.016 + rng() * 0.02);
    const tone = tones[(rng() * tones.length) | 0];
    const grad = c.createLinearGradient(x0, size, x0, size - h);
    grad.addColorStop(0, rgb(tone, 0.95));
    grad.addColorStop(0.55, rgb(tone, 0.98));
    // Blade tips bleach — it is the difference between a lawn and a green mat.
    grad.addColorStop(1, rgb(0xcfe86a, 0.9));
    c.fillStyle = grad;
    c.beginPath();
    c.moveTo(x0 - w, size);
    c.quadraticCurveTo(x0 - w * 0.5 + lean * 0.4, size - h * 0.6, x0 + lean, size - h);
    c.quadraticCurveTo(x0 + w * 0.6 + lean * 0.4, size - h * 0.58, x0 + w, size);
    c.closePath();
    c.fill();
  }
  const map = toTexture(s, true);
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  return { map, all: [map] };
}

// ---------------------------------------------------------------------------
// Signage
// ---------------------------------------------------------------------------

const SPONSORS: Array<{ name: string; bg: number; ink: number; mark: "chevron" | "ring" | "bolt" | "star" | "wave" | "block" }> = [
  { name: "VIBEVERSE", bg: 0x1b2a6b, ink: 0xffe14d, mark: "star" },
  { name: "NITRO", bg: 0xe8402a, ink: 0xffffff, mark: "bolt" },
  { name: "TURBOFRUIT", bg: 0xffc21f, ink: 0x2a1a05, mark: "ring" },
  { name: "KART CO", bg: 0x17181d, ink: 0xff6a2b, mark: "chevron" },
  { name: "AQUAFLOW", bg: 0x0f8bd6, ink: 0xffffff, mark: "wave" },
  { name: "GRIPMAX", bg: 0x2c8c3f, ink: 0xf4ffe0, mark: "block" },
  { name: "BOOSTED", bg: 0x8a2be2, ink: 0xffe14d, mark: "bolt" },
  { name: "SHELL FX", bg: 0xf05a28, ink: 0x1b1b1b, mark: "ring" },
  { name: "COIN BANK", bg: 0xffd54a, ink: 0x3a2a00, mark: "star" },
  { name: "DRIFTLINE", bg: 0x101820, ink: 0x35e8ff, mark: "chevron" },
  { name: "MUSHROOM", bg: 0xf24b4b, ink: 0xfff6e5, mark: "ring" },
  { name: "ANTIGRAV", bg: 0x123a52, ink: 0x35e8ff, mark: "wave" },
  { name: "RAINBOW", bg: 0xff4fa3, ink: 0xfff2b0, mark: "star" },
  { name: "PIT LANE", bg: 0x394150, ink: 0xffcc22, mark: "block" },
  { name: "SUNPEAK", bg: 0xff8c1a, ink: 0x2b1500, mark: "bolt" },
  { name: "LAKESIDE", bg: 0x0d6b6b, ink: 0xd6fff2, mark: "wave" },
];

/** How many cells across the sponsor atlas is. Shared with the shader. */
export const SPONSOR_GRID = 4;

function drawMark(c: Ctx2D, kind: string, x: number, y: number, r: number, ink: number): void {
  c.save();
  c.translate(x, y);
  c.fillStyle = rgb(ink, 1);
  c.strokeStyle = rgb(ink, 1);
  c.lineWidth = r * 0.28;
  c.lineJoin = "round";
  switch (kind) {
    case "chevron":
      for (let i = 0; i < 3; i++) {
        c.beginPath();
        c.moveTo(-r + i * r * 0.5, r * 0.7);
        c.lineTo(-r * 0.35 + i * r * 0.5, 0);
        c.lineTo(-r + i * r * 0.5, -r * 0.7);
        c.stroke();
      }
      break;
    case "ring":
      c.beginPath();
      c.arc(0, 0, r * 0.72, 0, TAU);
      c.stroke();
      c.beginPath();
      c.arc(0, 0, r * 0.3, 0, TAU);
      c.fill();
      break;
    case "bolt":
      c.beginPath();
      c.moveTo(-r * 0.2, -r);
      c.lineTo(r * 0.5, -r * 0.12);
      c.lineTo(r * 0.06, -r * 0.05);
      c.lineTo(r * 0.42, r);
      c.lineTo(-r * 0.55, r * 0.05);
      c.lineTo(-r * 0.06, -r * 0.02);
      c.closePath();
      c.fill();
      break;
    case "star":
      c.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * TAU - Math.PI / 2;
        const rr = i % 2 === 0 ? r : r * 0.44;
        if (i === 0) c.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        else c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      c.closePath();
      c.fill();
      break;
    case "wave":
      for (let k = 0; k < 3; k++) {
        c.beginPath();
        for (let i = 0; i <= 20; i++) {
          const t = i / 20;
          const px = -r + t * r * 2;
          const py = Math.sin(t * TAU) * r * 0.3 + (k - 1) * r * 0.5;
          if (i === 0) c.moveTo(px, py);
          else c.lineTo(px, py);
        }
        c.stroke();
      }
      break;
    default:
      c.fillRect(-r, -r * 0.9, r * 0.7, r * 1.8);
      c.fillRect(-r * 0.1, -r * 0.45, r * 0.7, r * 1.35);
      c.fillRect(r * 0.55, -r * 0.9, r * 0.55, r * 1.8);
  }
  c.restore();
}

/**
 * A 4×4 atlas of trackside advertising. Every hoarding in the circuit is one
 * instance of one quad; the shader picks a cell by hashing the instance's world
 * position, so sixteen distinct sponsors cost exactly one draw call.
 */
export function bakeSponsorAtlas(size: number): MapSet {
  const s = surface(size);
  const c = s.ctx;
  const cell = size / SPONSOR_GRID;
  const rng = makeRng("kart/scenery/sponsors");
  for (let i = 0; i < SPONSORS.length; i++) {
    const sp = SPONSORS[i];
    const cx = (i % SPONSOR_GRID) * cell;
    const cy = Math.floor(i / SPONSOR_GRID) * cell;
    c.save();
    c.beginPath();
    c.rect(cx, cy, cell, cell);
    c.clip();
    c.fillStyle = rgb(sp.bg, 1);
    c.fillRect(cx, cy, cell, cell);
    // A diagonal sweep of lighter tone: the standard trackside-board look, and
    // it gives the eye something to read at a shallow angle.
    c.fillStyle = "rgba(255,255,255,0.08)";
    c.beginPath();
    c.moveTo(cx, cy + cell);
    c.lineTo(cx + cell * 0.62, cy);
    c.lineTo(cx + cell, cy);
    c.lineTo(cx + cell, cy + cell * 0.35);
    c.closePath();
    c.fill();

    drawMark(c, sp.mark, cx + cell * 0.19, cy + cell * 0.5, cell * 0.13, sp.ink);

    c.fillStyle = rgb(sp.ink, 1);
    c.textBaseline = "middle";
    c.textAlign = "left";
    let fs = cell * 0.22;
    c.font = `900 ${fs}px sans-serif`;
    while (c.measureText(sp.name).width > cell * 0.62 && fs > 6) {
      fs *= 0.92;
      c.font = `900 ${fs}px sans-serif`;
    }
    c.fillText(sp.name, cx + cell * 0.33, cy + cell * 0.47);
    c.globalAlpha = 0.55;
    c.font = `600 ${cell * 0.085}px sans-serif`;
    c.fillText("OFFICIAL PARTNER", cx + cell * 0.335, cy + cell * 0.65);
    c.globalAlpha = 1;

    // Weathering, so the boards do not all look like they went up this morning.
    c.globalAlpha = 0.1;
    for (let k = 0; k < 14; k++) {
      c.fillStyle = rng() < 0.5 ? "#ffffff" : "#000000";
      c.fillRect(cx + rng() * cell, cy + rng() * cell, cell * rng() * 0.3, cell * 0.02);
    }
    c.globalAlpha = 1;
    c.restore();
  }
  const map = toTexture(s, true);
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  return { map, all: [map] };
}

/** How many cells across the flag atlas is. */
export const FLAG_GRID = 2;

/** Four flag designs — chequer, chevrons, tricolour and the circuit roundel. */
export function bakeFlagAtlas(size: number): MapSet {
  const s = surface(size);
  const c = s.ctx;
  const cell = size / FLAG_GRID;
  const designs = [0, 1, 2, 3];
  for (const i of designs) {
    const cx = (i % FLAG_GRID) * cell;
    const cy = Math.floor(i / FLAG_GRID) * cell;
    c.save();
    c.beginPath();
    c.rect(cx, cy, cell, cell);
    c.clip();
    if (i === 0) {
      const n = 6;
      for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) {
          c.fillStyle = (x + y) % 2 === 0 ? "#f7f7f7" : "#15161a";
          c.fillRect(cx + (x * cell) / n, cy + (y * cell) / n, cell / n + 1, cell / n + 1);
        }
      }
    } else if (i === 1) {
      c.fillStyle = "#ffcc22";
      c.fillRect(cx, cy, cell, cell);
      c.fillStyle = "#e8402a";
      for (let k = -2; k < 5; k++) {
        c.beginPath();
        c.moveTo(cx + k * cell * 0.3, cy);
        c.lineTo(cx + k * cell * 0.3 + cell * 0.16, cy);
        c.lineTo(cx + k * cell * 0.3 + cell * 0.46, cy + cell);
        c.lineTo(cx + k * cell * 0.3 + cell * 0.3, cy + cell);
        c.closePath();
        c.fill();
      }
    } else if (i === 2) {
      const bands = ["#1b2a6b", "#f7f7f7", "#e8402a"];
      for (let b = 0; b < 3; b++) {
        c.fillStyle = bands[b];
        c.fillRect(cx, cy + (b * cell) / 3, cell, cell / 3 + 1);
      }
    } else {
      c.fillStyle = "#0f8bd6";
      c.fillRect(cx, cy, cell, cell);
      c.fillStyle = "#ffe14d";
      c.beginPath();
      c.arc(cx + cell * 0.5, cy + cell * 0.5, cell * 0.3, 0, TAU);
      c.fill();
      c.fillStyle = "#0f8bd6";
      c.beginPath();
      c.arc(cx + cell * 0.5, cy + cell * 0.5, cell * 0.18, 0, TAU);
      c.fill();
      c.fillStyle = "#ffe14d";
      c.font = `900 ${cell * 0.15}px sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText("VK", cx + cell * 0.5, cy + cell * 0.51);
    }
    c.restore();
  }
  const map = toTexture(s, true);
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  return { map, all: [map] };
}

/**
 * The start/finish banner. This is the one texture a player reads properly —
 * it is dead ahead at the lights and again at the flag — so it gets the widest
 * canvas and real typographic hierarchy.
 */
export function bakeGantryBanner(width: number): MapSet {
  // 8:1, both dimensions power of two: the banner fills its quad edge to edge,
  // so nothing has to fight the UV rectangle at the call site.
  const w = width;
  const h = Math.max(16, width / 8);
  const s = surfaceWH(w, h);
  const c = s.ctx;
  c.clearRect(0, 0, w, h);

  const grad = c.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#1b2a6b");
  grad.addColorStop(0.5, "#2b46a8");
  grad.addColorStop(1, "#132057");
  c.fillStyle = grad;
  c.fillRect(0, 0, w, h);

  // Chequer bands top and bottom.
  const cs = h * 0.16;
  for (let x = 0; x < w; x += cs) {
    for (const [row, y] of [[0, 0], [1, h - cs]] as const) {
      const k = Math.round(x / cs) + row;
      c.fillStyle = k % 2 === 0 ? "#f7f7f7" : "#15161a";
      c.fillRect(x, y, cs, cs);
    }
  }

  c.fillStyle = "#ffe14d";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.font = `900 ${h * 0.45}px sans-serif`;
  c.setTransform(1, 0, -0.12, 1, 0, 0);
  c.fillText("VIBE KART", w * 0.5 + h * 0.5 * 0.12, h * 0.47);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = "rgba(255,255,255,0.85)";
  c.font = `700 ${h * 0.13}px sans-serif`;
  c.fillText("GRAND PRIX  ·  SUNSET BAY CIRCUIT", w * 0.5, h * 0.74);

  // Side sponsor blocks, so the banner is not symmetric dead space.
  c.fillStyle = "#e8402a";
  c.fillRect(w * 0.02, h * 0.28, w * 0.14, h * 0.44);
  c.fillStyle = "#ffffff";
  c.font = `900 ${h * 0.17}px sans-serif`;
  c.fillText("NITRO", w * 0.09, h * 0.51);
  c.fillStyle = "#2c8c3f";
  c.fillRect(w * 0.84, h * 0.28, w * 0.14, h * 0.44);
  c.fillStyle = "#f4ffe0";
  c.fillText("GRIPMAX", w * 0.91, h * 0.51);

  const map = toTexture(s, true);
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  return { map, all: [map] };
}

/** Soft additive glow sprite — bulbs, rim lights, the blimp's night trim. */
export function bakeGlow(size: number): THREE.Texture {
  const s = surface(size);
  const c = s.ctx;
  c.clearRect(0, 0, size, size);
  const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.85)");
  g.addColorStop(0.45, "rgba(255,255,255,0.25)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  const tex = toTexture(s, true);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** Vertical stripe wrap for air dancers and inflatable arches. */
export function bakeStripes(size: number, a: number, b: number, count = 8): THREE.Texture {
  const s = surface(size);
  const c = s.ctx;
  for (let i = 0; i < count; i++) {
    c.fillStyle = rgb(i % 2 === 0 ? a : b, 1);
    c.fillRect((i * size) / count, 0, size / count + 1, size);
  }
  // A soft *horizontal* shade so the tube reads as round. Shading it vertically
  // was the bug: it washed the top of the tube to near-white and the whole prop
  // stopped reading as a striped inflatable at any distance.
  const g = c.createLinearGradient(0, 0, size, 0);
  g.addColorStop(0, "rgba(0,0,0,0.3)");
  g.addColorStop(0.35, "rgba(255,255,255,0.22)");
  g.addColorStop(0.7, "rgba(0,0,0,0.12)");
  g.addColorStop(1, "rgba(0,0,0,0.3)");
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  return toTexture(s, true);
}
