/**
 * Surfaces for the roads and the ground, painted at world scale: a tile is a
 * known number of metres across, so a chip is a chip and not a cobble. Each
 * generator returns a colour map and a normal map (from a painted height
 * field) and the metres one tile covers. Used by roads.ts and terrain.ts only.
 */
import * as THREE from "three";
import { mulberry32 } from "./geo";

export interface WorldSurface {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  /** Metres one repeat covers. */
  tile: number;
}

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d", { willReadFrequently: true })!];
}

function tex(c: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Height (grey canvas) to a tangent-space normal map; the height wraps so the tile does. */
function normalFrom(height: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const w = height.width;
  const hh = height.height;
  const src = height.getContext("2d")!.getImageData(0, 0, w, hh).data;
  const [c, g] = canvas(w, hh);
  const out = g.createImageData(w, hh);
  const h = (x: number, y: number) => src[(((y + hh) % hh) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      out.data[i] = ((-dx / l) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      out.data[i + 2] = (1 / l) * 255;
      out.data[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  return c;
}

/** Tileable value noise, four octaves, as a float grid in 0..1. */
function fbm(n: number, seed: number, octaves = 4, base = 4): Float32Array {
  const rnd = mulberry32(seed);
  const out = new Float32Array(n * n);
  let amp = 1;
  let total = 0;
  let cells = base;
  for (let o = 0; o < octaves; o++) {
    const lat = new Float32Array(cells * cells);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    for (let y = 0; y < n; y++) {
      const fy = (y / n) * cells;
      const j = Math.floor(fy);
      const v = fy - j;
      const sv = v * v * (3 - 2 * v);
      for (let x = 0; x < n; x++) {
        const fx = (x / n) * cells;
        const i = Math.floor(fx);
        const u = fx - i;
        const su = u * u * (3 - 2 * u);
        const a = lat[(j % cells) * cells + (i % cells)];
        const b = lat[(j % cells) * cells + ((i + 1) % cells)];
        const c = lat[((j + 1) % cells) * cells + (i % cells)];
        const d = lat[((j + 1) % cells) * cells + ((i + 1) % cells)];
        out[y * n + x] += amp * (a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv);
      }
    }
    total += amp;
    amp *= 0.5;
    cells *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/**
 * Three independent noises in R, G and B, for the ground shader to break up
 * the lawn, feather the shoulder and place the dry patches. Tile is whatever
 * the shader divides by.
 */
export function noiseTexture(): THREE.CanvasTexture {
  const n = 256;
  const r = fbm(n, 11, 5, 3);
  const g = fbm(n, 12, 5, 5);
  const b = fbm(n, 13, 4, 8);
  const [c, ctx] = canvas(n);
  const img = ctx.createImageData(n, n);
  for (let i = 0; i < n * n; i++) {
    img.data[i * 4] = r[i] * 255;
    img.data[i * 4 + 1] = g[i] * 255;
    img.data[i * 4 + 2] = b[i] * 255;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return tex(c, false);
}

/** Stones scattered in a binder. Sizes and spacing in pixels; the caller sets what a pixel is. */
function stones(g: CanvasRenderingContext2D, hg: CanvasRenderingContext2D, n: number, rnd: () => number, o: { count: number; min: number; max: number; tone: [number, number]; warm: number; height: [number, number]; sat?: number }) {
  for (let i = 0; i < o.count; i++) {
    const x = rnd() * n;
    const y = rnd() * n;
    const s = o.min + rnd() * (o.max - o.min);
    const v = o.tone[0] + rnd() * (o.tone[1] - o.tone[0]);
    const w = rnd() < 0.5 ? o.warm : -o.warm * 0.5;
    const sat = o.sat ?? 1;
    g.fillStyle = `rgb(${v + w * sat},${v + w * 0.55 * sat},${v - w * 0.4 * sat})`;
    g.beginPath();
    g.ellipse(x, y, s, s * (0.55 + rnd() * 0.45), rnd() * Math.PI, 0, Math.PI * 2);
    g.fill();
    const hv = o.height[0] + rnd() * (o.height[1] - o.height[0]);
    hg.fillStyle = `rgb(${hv},${hv},${hv})`;
    hg.beginPath();
    hg.ellipse(x, y, s * 0.9, s * 0.7, 0, 0, Math.PI * 2);
    hg.fill();
  }
}

/** Chip seal: a single layer of 3/8" chips rolled into dark binder. Tile 2 m, so a chip is 8 mm. */
export function chipSealWorld(): WorldSurface {
  const n = 1024;
  const rnd = mulberry32(7001);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = "#3a3733";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#606060";
  hg.fillRect(0, 0, n, n);
  // Chips: grey basalt with some tan and pale quartz, near-touching.
  stones(g, hg, n, rnd, { count: 62000, min: 1.6, max: 3.2, tone: [88, 158], warm: 12, height: [150, 235] });
  stones(g, hg, n, rnd, { count: 2600, min: 1.4, max: 2.4, tone: [150, 190], warm: 14, height: [200, 240] });
  // Binder bleeding over some chips, which is what a hot summer does to it.
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(35,32,30,${0.25 + rnd() * 0.35})`;
    g.beginPath();
    g.ellipse(rnd() * n, rnd() * n, 3 + rnd() * 9, 2 + rnd() * 6, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  return { map: tex(c, true), normalMap: tex(normalFrom(hc, 1.1), false), tile: 2 };
}

/** Hot-mix asphalt, the county arterial: finer aggregate, darker, smoother. Tile 2 m. */
export function asphaltWorld(): WorldSurface {
  const n = 1024;
  const rnd = mulberry32(7002);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = "#3f3d38";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#707070";
  hg.fillRect(0, 0, n, n);
  stones(g, hg, n, rnd, { count: 90000, min: 0.8, max: 2.0, tone: [62, 118], warm: 5, height: [120, 200] });
  stones(g, hg, n, rnd, { count: 4000, min: 1.5, max: 2.6, tone: [105, 145], warm: 8, height: [170, 215] });
  return { map: tex(c, true), normalMap: tex(normalFrom(hc, 0.8), false), tile: 2 };
}

/** Crushed rock, 3/4" minus, with tan fines packed between. Tile 1.5 m. */
export function gravelWorld(): WorldSurface {
  const n = 1024;
  const rnd = mulberry32(7003);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = "#8f877a";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#707070";
  hg.fillRect(0, 0, n, n);
  // Fines: mottled tan-grey.
  for (let i = 0; i < 4000; i++) {
    const v = 120 + rnd() * 50;
    g.fillStyle = `rgba(${v + 10},${v + 2},${v - 12},0.5)`;
    g.beginPath();
    g.ellipse(rnd() * n, rnd() * n, 6 + rnd() * 26, 4 + rnd() * 16, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  stones(g, hg, n, rnd, { count: 30000, min: 2, max: 6.5, tone: [95, 175], warm: 10, height: [140, 240] });
  stones(g, hg, n, rnd, { count: 1200, min: 5, max: 10, tone: [110, 165], warm: 6, height: [200, 250] });
  return { map: tex(c, true), normalMap: tex(normalFrom(hc, 1.6), false), tile: 1.5 };
}

/** An old asphalt driveway: faded, alligator-cracked, moss in the cracks. Tile 3 m. */
export function oldAsphaltWorld(): WorldSurface {
  const n = 1024;
  const rnd = mulberry32(7004);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = "#5d5a55";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#808080";
  hg.fillRect(0, 0, n, n);
  stones(g, hg, n, rnd, { count: 50000, min: 0.7, max: 1.8, tone: [80, 130], warm: 6, height: [110, 170] });
  // Alligator cracks: a loose polygonal net.
  g.strokeStyle = "rgba(30,28,25,0.75)";
  hg.strokeStyle = "#404040";
  g.lineWidth = 2;
  hg.lineWidth = 3;
  for (let i = 0; i < 120; i++) {
    let x = rnd() * n;
    let y = rnd() * n;
    g.beginPath();
    hg.beginPath();
    g.moveTo(x, y);
    hg.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += (rnd() - 0.5) * 90;
      y += (rnd() - 0.5) * 90;
      g.lineTo(x, y);
      hg.lineTo(x, y);
    }
    g.stroke();
    hg.stroke();
  }
  // Moss and patches.
  for (let i = 0; i < 140; i++) {
    g.fillStyle = `rgba(${60 + rnd() * 30},${90 + rnd() * 40},${40 + rnd() * 20},${0.15 + rnd() * 0.3})`;
    g.beginPath();
    g.ellipse(rnd() * n, rnd() * n, 5 + rnd() * 20, 3 + rnd() * 10, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  for (let i = 0; i < 12; i++) {
    g.fillStyle = `rgba(${40 + rnd() * 20},${40 + rnd() * 18},${38 + rnd() * 16},0.6)`;
    g.fillRect(rnd() * n, rnd() * n, 60 + rnd() * 200, 40 + rnd() * 160);
  }
  return { map: tex(c, true), normalMap: tex(normalFrom(hc, 1.0), false), tile: 3 };
}

/** Broom-finished concrete with a joint every three metres. Tile 3 m. */
export function concreteWorld(): WorldSurface {
  const n = 1024;
  const rnd = mulberry32(7005);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = "#b3aea4";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#909090";
  hg.fillRect(0, 0, n, n);
  for (let i = 0; i < 14000; i++) {
    const v = 150 + rnd() * 50;
    g.fillStyle = `rgba(${v},${v - 3},${v - 10},0.35)`;
    g.fillRect(rnd() * n, rnd() * n, 1 + rnd() * 3, 1 + rnd() * 3);
  }
  // Broom lines across.
  for (let y = 0; y < n; y += 3) {
    g.fillStyle = `rgba(0,0,0,${0.03 + rnd() * 0.06})`;
    g.fillRect(0, y, n, 1);
    hg.fillStyle = `rgba(0,0,0,${0.1 + rnd() * 0.15})`;
    hg.fillRect(0, y, n, 1);
  }
  // Stains and a little moss at the edge.
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(${70 + rnd() * 40},${65 + rnd() * 30},${55 + rnd() * 20},${0.08 + rnd() * 0.15})`;
    g.beginPath();
    g.ellipse(rnd() * n, rnd() * n, 20 + rnd() * 80, 10 + rnd() * 40, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  // Control joints: one across per tile, one down the middle.
  g.fillStyle = "rgba(40,38,35,0.8)";
  g.fillRect(0, 0, n, 4);
  g.fillRect(n / 2 - 2, 0, 4, n);
  hg.fillStyle = "#303030";
  hg.fillRect(0, 0, n, 5);
  hg.fillRect(n / 2 - 2, 0, 5, n);
  return { map: tex(c, true), normalMap: tex(normalFrom(hc, 1.4), false), tile: 3 };
}

/** Packed earth of a trail or a track: brown, needles and small stones, roots. Tile 2 m. */
export function dirtWorld(): WorldSurface {
  const n = 512;
  const rnd = mulberry32(7006);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = "#6b5c48";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#808080";
  hg.fillRect(0, 0, n, n);
  for (let i = 0; i < 6000; i++) {
    const v = 70 + rnd() * 60;
    g.fillStyle = `rgba(${v + 15},${v},${v - 20},0.5)`;
    g.beginPath();
    g.ellipse(rnd() * n, rnd() * n, 4 + rnd() * 14, 3 + rnd() * 8, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  stones(g, hg, n, rnd, { count: 2500, min: 1, max: 3, tone: [90, 150], warm: 12, height: [150, 220] });
  for (let i = 0; i < 5000; i++) {
    g.fillStyle = `rgba(${120 + rnd() * 40},${90 + rnd() * 30},${50 + rnd() * 20},0.55)`;
    g.save();
    g.translate(rnd() * n, rnd() * n);
    g.rotate(rnd() * Math.PI);
    g.fillRect(0, 0, 4 + rnd() * 8, 1);
    g.restore();
  }
  return { map: tex(c, true), normalMap: tex(normalFrom(hc, 1.2), false), tile: 2 };
}

/** Puget Sound beach: grey-tan sand with pebbles, shell bits and darker damp patches. Tile 2 m. */
export function sandWorld(): WorldSurface {
  const n = 1024;
  const rnd = mulberry32(7007);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = "#9c917e";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#808080";
  hg.fillRect(0, 0, n, n);
  for (let i = 0; i < 60000; i++) {
    const v = 120 + rnd() * 70;
    g.fillStyle = `rgba(${v + 8},${v},${v - 16},0.5)`;
    g.fillRect(rnd() * n, rnd() * n, 1.5, 1.5);
  }
  for (let i = 0; i < 300; i++) {
    g.fillStyle = `rgba(${100 + rnd() * 30},${92 + rnd() * 25},${75 + rnd() * 20},${0.15 + rnd() * 0.3})`;
    g.beginPath();
    g.ellipse(rnd() * n, rnd() * n, 15 + rnd() * 60, 8 + rnd() * 25, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  stones(g, hg, n, rnd, { count: 2600, min: 1.5, max: 5, tone: [90, 170], warm: 10, height: [160, 230] });
  stones(g, hg, n, rnd, { count: 300, min: 2, max: 4, tone: [190, 235], warm: 4, height: [170, 220], sat: 0.3 });
  // Ripples and footprints in the height only.
  for (let i = 0; i < 40; i++) {
    hg.fillStyle = `rgba(0,0,0,${0.15 + rnd() * 0.2})`;
    hg.beginPath();
    hg.ellipse(rnd() * n, rnd() * n, 12 + rnd() * 12, 6 + rnd() * 8, rnd() * 3, 0, Math.PI * 2);
    hg.fill();
  }
  return { map: tex(c, true), normalMap: tex(normalFrom(hc, 1.0), false), tile: 2 };
}

/**
 * Large-scale wear for a road: patches, transverse cracks, tar snakes, oil.
 * R is a brightness multiplier around 0.5, G is unused warmth around 0.5,
 * B is a roughness multiplier around 0.5 (tar is glossier). Tile 16 m along,
 * 8 m across.
 */
export function roadMacro(seed = 7008): THREE.CanvasTexture {
  const n = 1024;
  const rnd = mulberry32(seed);
  const [c, g] = canvas(n);
  g.fillStyle = "rgb(128,128,128)";
  g.fillRect(0, 0, n, n);
  // Broad tonal drift.
  const drift = fbm(128, seed + 1, 3, 2);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const v = 128 + (drift[y * 128 + x] - 0.5) * 50;
      g.fillStyle = `rgb(${v},128,128)`;
      g.fillRect(x * 8, y * 8, 8, 8);
    }
  }
  // Patches: rectangles of slightly different tone with feathered edges.
  for (let i = 0; i < 7; i++) {
    const w = 120 + rnd() * 380;
    const h = 60 + rnd() * 200;
    const x = rnd() * n;
    const y = rnd() * n;
    const v = rnd() < 0.5 ? 100 + rnd() * 16 : 138 + rnd() * 16;
    g.fillStyle = `rgba(${v},128,${rnd() < 0.5 ? 110 : 140},0.75)`;
    g.fillRect(x, y, w, h);
    g.fillRect(x - n, y, w, h);
    g.fillRect(x, y - n, w, h);
  }
  // Transverse and longitudinal cracks, some filled with tar (dark, glossy).
  for (let i = 0; i < 26; i++) {
    const tar = rnd() < 0.55;
    g.strokeStyle = tar ? "rgb(70,128,60)" : "rgb(88,128,150)";
    g.lineWidth = tar ? 3 + rnd() * 4 : 1.5;
    g.lineCap = "round";
    let x = rnd() * n;
    let y = rnd() * n;
    const across = rnd() < 0.5;
    g.beginPath();
    g.moveTo(x, y);
    for (let k = 0; k < 10; k++) {
      x += across ? (rnd() - 0.2) * 70 : (rnd() - 0.5) * 30;
      y += across ? (rnd() - 0.5) * 30 : (rnd() - 0.2) * 70;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  // Oil drips down the lanes, faint.
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(90,128,90,${0.15 + rnd() * 0.2})`;
    g.beginPath();
    g.ellipse(rnd() * n, rnd() * n, 3 + rnd() * 8, 8 + rnd() * 30, 0, 0, Math.PI * 2);
    g.fill();
  }
  return tex(c, false);
}

/** A painted line, 6 m along per tile, worn through here and there (alpha). */
export function paintTexture(colour: string): THREE.CanvasTexture {
  const n = 256;
  const rnd = mulberry32(7009 + colour.length);
  const [c, g] = canvas(64, n);
  g.clearRect(0, 0, 64, n);
  g.fillStyle = colour;
  g.fillRect(0, 0, 64, n);
  for (let i = 0; i < 260; i++) {
    g.clearRect(rnd() * 64, rnd() * n, 1 + rnd() * 4, 1 + rnd() * 4);
  }
  for (let i = 0; i < 6; i++) {
    g.fillStyle = `rgba(60,58,55,${0.2 + rnd() * 0.3})`;
    g.fillRect(0, rnd() * n, 64, 2 + rnd() * 10);
  }
  const t = tex(c, true);
  return t;
}

/** Silvered driftwood: grey with dark grain, the odd split. Tile is the log's length. */
export function driftwood(): WorldSurface {
  const n = 256;
  const rnd = mulberry32(7010);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = "#77716a";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#808080";
  hg.fillRect(0, 0, n, n);
  for (let y = 0; y < n; y += 2 + rnd() * 4) {
    const v = 70 + rnd() * 75;
    g.fillStyle = `rgba(${v},${v - 4},${v - 12},0.55)`;
    g.fillRect(0, y, n, 1 + rnd() * 2);
    hg.fillStyle = `rgba(0,0,0,${rnd() * 0.3})`;
    hg.fillRect(0, y, n, 1);
  }
  for (let i = 0; i < 12; i++) {
    g.fillStyle = "rgba(40,36,32,0.7)";
    g.fillRect(rnd() * n, rnd() * n, 20 + rnd() * 120, 1.5);
  }
  return { map: tex(c, true), normalMap: tex(normalFrom(hc, 1.2), false), tile: 1 };
}

export function disposeWorldSurface(s: WorldSurface): void {
  s.map.dispose();
  s.normalMap.dispose();
}
