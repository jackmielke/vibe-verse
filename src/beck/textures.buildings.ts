/**
 * The building materials that textures.ts does not have: board-and-batten
 * and vertical cedar for the newer houses, brick for the chimneys, poured
 * concrete for the stem walls, greyed deck boards, a mossier asphalt shingle
 * for the north slopes, and the two things that are drawn once rather than
 * tiled: a raised-panel garage door and a front door. Same recipe as the
 * rest of the world: a colour map painted in a canvas, a height field turned
 * into a normal map, a roughness map, no photographs.
 */
import * as THREE from "three";
import { mulberry32 } from "./geo";
import type { Surface } from "./textures";

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function tex(c: HTMLCanvasElement, srgb: boolean, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function normalFrom(height: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const n = height.width;
  const src = height.getContext("2d")!.getImageData(0, 0, n, n).data;
  const [c, g] = canvas(n);
  const out = g.createImageData(n, n);
  const h = (x: number, y: number) => src[(((y + n) % n) * n + ((x + n) % n)) * 4] / 255;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * n + x) * 4;
      out.data[i] = ((-dx / l) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      out.data[i + 2] = (1 / l) * 255;
      out.data[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  return c;
}

function grain(g: CanvasRenderingContext2D, n: number, rnd: () => number, count: number, vertical: boolean, alpha: number) {
  for (let i = 0; i < count; i++) {
    const v = rnd() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${alpha * (0.4 + rnd())})`;
    const len = 2 + rnd() * 40;
    if (vertical) g.fillRect(rnd() * n, rnd() * n, 1, len);
    else g.fillRect(rnd() * n, rnd() * n, len, 1);
  }
}

function roughness(n: number, base: string, rnd: () => number, spread: number): HTMLCanvasElement {
  const [rc, rg] = canvas(n);
  rg.fillStyle = base;
  rg.fillRect(0, 0, n, n);
  for (let i = 0; i < 1500; i++) {
    const v = Math.round(200 + (rnd() - 0.5) * spread);
    rg.fillStyle = `rgba(${v},${v},${v},0.5)`;
    const s = 3 + rnd() * 8;
    rg.fillRect(rnd() * n, rnd() * n, s, s);
  }
  return rc;
}

function surface(c: HTMLCanvasElement, hc: HTMLCanvasElement, rc: HTMLCanvasElement, strength: number): Surface {
  return { map: tex(c, true), normalMap: tex(normalFrom(hc, strength), false), roughnessMap: tex(rc, false) };
}

/** Board-and-batten: wide boards with a batten over every joint, the siding on the newer houses and most of the barns. */
export function boardBatten(colour: string, metresPerTile = 2.4): Surface {
  const n = 512;
  const rnd = mulberry32(1201 + colour.length * 7);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = colour;
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#909090";
  hg.fillRect(0, 0, n, n);
  const battens = Math.round(metresPerTile / 0.3);
  const bw = n / battens;
  const battenPx = (0.06 / metresPerTile) * n;
  for (let i = 0; i < battens; i++) {
    const x = i * bw;
    // Board colour varies a touch between boards.
    const dv = (rnd() - 0.5) * 18;
    g.fillStyle = `rgba(${dv > 0 ? 255 : 0},${dv > 0 ? 255 : 0},${dv > 0 ? 255 : 0},${Math.abs(dv) / 200})`;
    g.fillRect(x, 0, bw, n);
    // Shadow to the right of the batten, a highlight on its left edge.
    g.fillStyle = "rgba(0,0,0,0.30)";
    g.fillRect(x + battenPx, 0, 3, n);
    g.fillStyle = "rgba(255,255,255,0.10)";
    g.fillRect(x, 0, 1.5, n);
    g.fillStyle = "rgba(0,0,0,0.10)";
    g.fillRect(x + battenPx - 1.5, 0, 1.5, n);
    hg.fillStyle = "#c8c8c8";
    hg.fillRect(x, 0, battenPx, n);
  }
  grain(g, n, rnd, 5000, true, 0.06);
  return surface(c, hc, roughness(n, "#b0b0b0", rnd, 60), 1.8);
}

/** Vertical cedar boards, tight-knot, either oiled and warm or left to go silver. */
export function verticalCedar(weathered: boolean, metresPerTile = 2.4): Surface {
  const n = 512;
  const rnd = mulberry32(weathered ? 1302 : 1303);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = weathered ? "#8c877a" : "#9c6a3e";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#909090";
  hg.fillRect(0, 0, n, n);
  const boardPx = (0.14 / metresPerTile) * n;
  for (let x = 0; x < n; x += boardPx) {
    const v = weathered ? 118 + rnd() * 50 : 120 + rnd() * 70;
    g.fillStyle = weathered ? `rgb(${v},${v - 4},${v - 14})` : `rgb(${v + 45},${v - 5},${v - 55})`;
    g.fillRect(x, 0, boardPx - 2, n);
    g.fillStyle = "rgba(0,0,0,0.45)";
    g.fillRect(x + boardPx - 2, 0, 2, n);
    hg.fillStyle = "#2a2a2a";
    hg.fillRect(x + boardPx - 2, 0, 2, n);
    // Knots.
    if (rnd() < 0.5) {
      g.fillStyle = weathered ? "rgba(70,60,50,0.6)" : "rgba(90,50,25,0.7)";
      g.beginPath();
      g.ellipse(x + boardPx / 2 + (rnd() - 0.5) * 6, rnd() * n, 3 + rnd() * 3, 5 + rnd() * 5, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  grain(g, n, rnd, 9000, true, 0.07);
  return surface(c, hc, roughness(n, weathered ? "#c0c0c0" : "#a0a0a0", rnd, 50), 1.6);
}

/** Common brick in running bond, the chimneys. One tile is `metresPerTile` square. */
export function brick(metresPerTile = 1.2): Surface {
  const n = 256;
  const rnd = mulberry32(1404);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = "#a89a8c";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#606060";
  hg.fillRect(0, 0, n, n);
  const bh = (0.07 / metresPerTile) * n;
  const bw = (0.21 / metresPerTile) * n;
  const rows = Math.round(n / bh);
  for (let r = 0; r < rows; r++) {
    const y = r * bh;
    const off = r % 2 ? bw / 2 : 0;
    for (let x = -off; x < n; x += bw) {
      const v = rnd();
      const rr = 118 + v * 50;
      g.fillStyle = `rgb(${rr},${68 + v * 30 + rnd() * 10},${52 + v * 20})`;
      g.fillRect(x + 1.5, y + 1.5, bw - 3, bh - 3);
      const hv = 150 + rnd() * 40;
      hg.fillStyle = `rgb(${hv},${hv},${hv})`;
      hg.fillRect(x + 1.5, y + 1.5, bw - 3, bh - 3);
    }
  }
  return surface(c, hc, roughness(n, "#e8e8e8", rnd, 30), 2.0);
}

/** Poured concrete stem wall: form-board lines, tie holes, damp stains near the ground. */
export function concrete(metresPerTile = 2.4): Surface {
  const n = 512;
  const rnd = mulberry32(1505);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = "#9d9a93";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#808080";
  hg.fillRect(0, 0, n, n);
  for (let i = 0; i < 14000; i++) {
    const v = 130 + rnd() * 60;
    g.fillStyle = `rgba(${v},${v - 2},${v - 6},0.35)`;
    const s = 1 + rnd() * 5;
    g.fillRect(rnd() * n, rnd() * n, s, s);
  }
  // Form-board lines every 0.3 m and a tie hole every 0.6 m across.
  const line = (0.3 / metresPerTile) * n;
  for (let y = 0; y < n; y += line) {
    g.fillStyle = "rgba(0,0,0,0.12)";
    g.fillRect(0, y, n, 1.5);
    hg.fillStyle = "#606060";
    hg.fillRect(0, y, n, 1.5);
  }
  const tie = (0.6 / metresPerTile) * n;
  for (let y = line * 2; y < n; y += line * 4) {
    for (let x = tie / 2; x < n; x += tie) {
      g.fillStyle = "rgba(40,38,36,0.7)";
      g.beginPath();
      g.arc(x, y, 2.2, 0, Math.PI * 2);
      g.fill();
      hg.fillStyle = "#303030";
      hg.beginPath();
      hg.arc(x, y, 2.2, 0, Math.PI * 2);
      hg.fill();
    }
  }
  // Damp and algae at the bottom of the tile (the wall's uv puts the ground at v=0).
  const grad = g.createLinearGradient(0, n, 0, n * 0.7);
  grad.addColorStop(0, "rgba(60,70,50,0.35)");
  grad.addColorStop(1, "rgba(60,70,50,0)");
  g.fillStyle = grad;
  g.fillRect(0, n * 0.7, n, n * 0.3);
  return surface(c, hc, roughness(n, "#f0f0f0", rnd, 20), 1.2);
}

/** Deck boards, 2x6 cedar gone grey, running along u. One tile is `metresPerTile` square. */
export function deckBoards(metresPerTile = 1.2): Surface {
  const n = 256;
  const rnd = mulberry32(1606);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = "#7d6f5c";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#909090";
  hg.fillRect(0, 0, n, n);
  const bh = (0.14 / metresPerTile) * n;
  for (let y = 0; y < n; y += bh) {
    const v = 100 + rnd() * 50;
    g.fillStyle = `rgb(${v + 12},${v},${v - 18})`;
    g.fillRect(0, y, n, bh - 2);
    g.fillStyle = "rgba(0,0,0,0.6)";
    g.fillRect(0, y + bh - 2, n, 2);
    hg.fillStyle = "#202020";
    hg.fillRect(0, y + bh - 2, n, 2);
  }
  grain(g, n, rnd, 6000, false, 0.08);
  return surface(c, hc, roughness(n, "#d8d8d8", rnd, 40), 1.6);
}

/** Asphalt shingle with the moss the north slopes carry: a green-grey bloom along every course. */
export function mossyShingle(colour = "#4a4744", metresPerTile = 3): Surface {
  const n = 512;
  const rnd = mulberry32(1707);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = colour;
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#808080";
  hg.fillRect(0, 0, n, n);
  const courses = Math.round(metresPerTile / 0.14);
  const ch = n / courses;
  for (let i = 0; i < courses; i++) {
    const y = i * ch;
    let x = -rnd() * 40;
    while (x < n) {
      const w = 20 + rnd() * 40;
      const v = -18 + rnd() * 36;
      g.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 100})`;
      g.fillRect(x, y, w - 1, ch);
      x += w;
    }
    g.fillStyle = "rgba(0,0,0,0.4)";
    g.fillRect(0, y, n, 2.5);
    hg.fillStyle = "#3a3a3a";
    hg.fillRect(0, y, n, 2.5);
    // Moss grows along the butt of each course, where the water sits.
    for (let k = 0; k < 14; k++) {
      g.fillStyle = `rgba(${80 + rnd() * 40},${115 + rnd() * 45},${45 + rnd() * 25},${0.35 + rnd() * 0.4})`;
      g.beginPath();
      g.ellipse(rnd() * n, y + 3 + rnd() * 4, 6 + rnd() * 22, 2 + rnd() * 3, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  for (let i = 0; i < 9000; i++) {
    const v = 60 + rnd() * 140;
    g.fillStyle = `rgba(${v},${v},${v},0.2)`;
    g.fillRect(rnd() * n, rnd() * n, 1.2, 1.2);
  }
  for (let i = 0; i < 140; i++) {
    g.fillStyle = `rgba(${70 + rnd() * 40},${110 + rnd() * 40},${40 + rnd() * 20},${0.2 + rnd() * 0.35})`;
    g.beginPath();
    g.ellipse(rnd() * n, rnd() * n, 6 + rnd() * 24, 3 + rnd() * 8, 0, 0, Math.PI * 2);
    g.fill();
  }
  return surface(c, hc, roughness(n, "#e8e8e8", rnd, 20), 1.4);
}

/** Corrugated or ribbed metal siding for the pole barns and the one industrial shed. */
export function metalSiding(colour = "#8a8f8c", metresPerTile = 2.4): Surface {
  const n = 256;
  const rnd = mulberry32(1808);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = colour;
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#808080";
  hg.fillRect(0, 0, n, n);
  const rib = (0.23 / metresPerTile) * n;
  for (let x = 0; x < n; x += rib) {
    g.fillStyle = "rgba(255,255,255,0.14)";
    g.fillRect(x, 0, 2, n);
    g.fillStyle = "rgba(0,0,0,0.22)";
    g.fillRect(x + 3, 0, 2, n);
    hg.fillStyle = "#d0d0d0";
    hg.fillRect(x, 0, 3, n);
  }
  // Rust streaks under the fasteners.
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(120,70,40,${0.08 + rnd() * 0.15})`;
    g.fillRect(rnd() * n, rnd() * n, 1.5, 10 + rnd() * 40);
  }
  return surface(c, hc, roughness(n, "#909090", rnd, 40), 1.4);
}

/** A raised-panel garage door, drawn once. `bays` is one or two. */
export function garageDoorFace(colour: string, bays: number): THREE.CanvasTexture {
  const w = bays === 2 ? 512 : 288;
  const h = 256;
  const [c, g] = canvas(w, h);
  const rnd = mulberry32(1909);
  g.fillStyle = colour;
  g.fillRect(0, 0, w, h);
  const rows = 4;
  const cols = bays === 2 ? 8 : 4;
  const rh = h / rows;
  const cw = w / cols;
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const x = k * cw + cw * 0.12;
      const y = r * rh + rh * 0.18;
      const pw = cw * 0.76;
      const ph = rh * 0.64;
      // Bevel: light top-left, dark bottom-right, then the raised field.
      g.fillStyle = "rgba(255,255,255,0.25)";
      g.fillRect(x, y, pw, ph);
      g.fillStyle = "rgba(0,0,0,0.28)";
      g.fillRect(x + 3, y + 3, pw - 3, ph - 3);
      g.fillStyle = colour;
      g.fillRect(x + 3, y + 3, pw - 6, ph - 6);
      // Windows in the top row of an older door.
      if (r === 0 && rnd() < 0.5 && k % 2 === 0) {
        g.fillStyle = "#1e262c";
        g.fillRect(x + 6, y + 6, pw - 12, ph - 12);
      }
    }
    g.fillStyle = "rgba(0,0,0,0.35)";
    g.fillRect(0, r * rh, w, 2);
  }
  g.fillStyle = "rgba(0,0,0,0.1)";
  g.fillRect(0, 0, w, 4);
  return tex(c, true, false);
}

/** A front door with four panels and a light at the top, drawn once. */
export function doorFace(colour: string): THREE.CanvasTexture {
  const w = 128;
  const h = 256;
  const [c, g] = canvas(w, h);
  g.fillStyle = colour;
  g.fillRect(0, 0, w, h);
  const panel = (x: number, y: number, pw: number, ph: number) => {
    g.fillStyle = "rgba(0,0,0,0.35)";
    g.fillRect(x, y, pw, ph);
    g.fillStyle = "rgba(255,255,255,0.18)";
    g.fillRect(x + 3, y + 3, pw - 3, ph - 3);
    g.fillStyle = colour;
    g.fillRect(x + 4, y + 4, pw - 8, ph - 8);
  };
  // A light across the top, two tall panels, two short panels.
  g.fillStyle = "#1c242a";
  g.fillRect(16, 14, w - 32, 44);
  g.fillStyle = "rgba(255,255,255,0.08)";
  g.fillRect(16, 14, w - 32, 12);
  panel(16, 72, 40, 96);
  panel(72, 72, 40, 96);
  panel(16, 180, 40, 58);
  panel(72, 180, 40, 58);
  // Handle.
  g.fillStyle = "#b8b0a0";
  g.fillRect(104, 128, 6, 18);
  return tex(c, true, false);
}
