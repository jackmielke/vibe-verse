/**
 * Materials made in a canvas, because nothing photographic could be fetched
 * from here. Each generator paints a colour map and a height field and turns
 * the height into a normal map, so the surfaces catch light the way the real
 * ones do: chip-seal aggregate, the flat sheen of asphalt shingles, cedar lap
 * siding with a shadow line under every course, moss in the bark.
 */
import * as THREE from "three";
import { mulberry32 } from "./geo";

export interface Surface {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  return [c, c.getContext("2d")!];
}

function tex(c: HTMLCanvasElement, repeat: number, srgb: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Height (0..1 grey canvas) to a tangent-space normal map. */
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

function noiseFill(g: CanvasRenderingContext2D, n: number, rnd: () => number, base: number, spread: number, count: number, size: number, alpha: number) {
  for (let i = 0; i < count; i++) {
    const v = Math.round(base + (rnd() - 0.5) * spread);
    g.fillStyle = `rgba(${v},${v},${v},${alpha})`;
    const s = size * (0.5 + rnd());
    g.fillRect(rnd() * n, rnd() * n, s, s);
  }
}

/** Chip-seal county road: grey aggregate in a dark binder, a little oil in the wheel tracks. */
export function chipSeal(): Surface {
  const n = 512;
  const rnd = mulberry32(101);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = "#5e5c58";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#808080";
  hg.fillRect(0, 0, n, n);
  for (let i = 0; i < 26000; i++) {
    const x = rnd() * n;
    const y = rnd() * n;
    const s = 1 + rnd() * 2.6;
    const v = 70 + rnd() * 110;
    const warm = rnd() < 0.3 ? 8 : 0;
    g.fillStyle = `rgb(${v + warm},${v + warm * 0.6},${v})`;
    g.fillRect(x, y, s, s);
    const hv = 110 + rnd() * 120;
    hg.fillStyle = `rgb(${hv},${hv},${hv})`;
    hg.fillRect(x, y, s, s);
  }
  // Wheel tracks: darker, smoother bands across u (the road is mapped across u).
  const grad = g.createLinearGradient(0, 0, n, 0);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(0.28, "rgba(20,18,16,0.28)");
  grad.addColorStop(0.36, "rgba(0,0,0,0)");
  grad.addColorStop(0.64, "rgba(0,0,0,0)");
  grad.addColorStop(0.72, "rgba(20,18,16,0.28)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, n, n);
  // Cracks and patches.
  g.strokeStyle = "rgba(30,28,26,0.7)";
  g.lineWidth = 1.5;
  for (let i = 0; i < 9; i++) {
    g.beginPath();
    let x = rnd() * n;
    let y = rnd() * n;
    g.moveTo(x, y);
    for (let k = 0; k < 8; k++) {
      x += (rnd() - 0.5) * 60;
      y += (rnd() - 0.3) * 50;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  const [rc, rg] = canvas(n);
  rg.fillStyle = "#c8c8c8";
  rg.fillRect(0, 0, n, n);
  noiseFill(rg, n, rnd, 195, 60, 4000, 3, 0.6);
  return { map: tex(c, 1, true), normalMap: tex(normalFrom(hc, 2.2), 1, false), roughnessMap: tex(rc, 1, false) };
}

/** Gravel: crushed rock driveways, grey with tan fines. */
export function gravel(): Surface {
  const n = 512;
  const rnd = mulberry32(202);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = "#9a9284";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#707070";
  hg.fillRect(0, 0, n, n);
  for (let i = 0; i < 16000; i++) {
    const x = rnd() * n;
    const y = rnd() * n;
    const s = 2 + rnd() * 5;
    const v = 105 + rnd() * 110;
    g.fillStyle = `rgb(${v},${v - 4},${v - 12})`;
    g.beginPath();
    g.ellipse(x, y, s, s * (0.6 + rnd() * 0.5), rnd() * 3, 0, Math.PI * 2);
    g.fill();
    const hv = 90 + rnd() * 150;
    hg.fillStyle = `rgb(${hv},${hv},${hv})`;
    hg.beginPath();
    hg.ellipse(x, y, s, s * 0.8, 0, 0, Math.PI * 2);
    hg.fill();
  }
  // Tyre tracks where the fines are pressed flat.
  const grad = g.createLinearGradient(0, 0, n, 0);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(0.3, "rgba(120,110,95,0.35)");
  grad.addColorStop(0.4, "rgba(0,0,0,0)");
  grad.addColorStop(0.6, "rgba(0,0,0,0)");
  grad.addColorStop(0.7, "rgba(120,110,95,0.35)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, n, n);
  const [rc, rg] = canvas(n);
  rg.fillStyle = "#e0e0e0";
  rg.fillRect(0, 0, n, n);
  return { map: tex(c, 1, true), normalMap: tex(normalFrom(hc, 1.8), 1, false), roughnessMap: tex(rc, 1, false) };
}

/** Painted lap siding: horizontal courses, a shadow under each, paint wear. */
export function lapSiding(colour: string, courseM = 0.15, metresPerTile = 2.4): Surface {
  const n = 512;
  const rnd = mulberry32(303 + colour.length);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = colour;
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#909090";
  hg.fillRect(0, 0, n, n);
  const courses = Math.round(metresPerTile / courseM);
  const ch = n / courses;
  for (let i = 0; i < courses; i++) {
    const y = i * ch;
    // Shadow line at the bottom of the course above.
    const grad = g.createLinearGradient(0, y, 0, y + ch);
    grad.addColorStop(0, "rgba(0,0,0,0.32)");
    grad.addColorStop(0.18, "rgba(0,0,0,0.06)");
    grad.addColorStop(0.9, "rgba(255,255,255,0.05)");
    grad.addColorStop(1, "rgba(0,0,0,0.12)");
    g.fillStyle = grad;
    g.fillRect(0, y, n, ch);
    const hgrad = hg.createLinearGradient(0, y, 0, y + ch);
    hgrad.addColorStop(0, "#404040");
    hgrad.addColorStop(0.12, "#a0a0a0");
    hgrad.addColorStop(1, "#b8b8b8");
    hg.fillStyle = hgrad;
    hg.fillRect(0, y, n, ch);
  }
  // Grain and weathering.
  for (let i = 0; i < 6000; i++) {
    const v = rnd() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${0.03 + rnd() * 0.05})`;
    g.fillRect(rnd() * n, rnd() * n, 1 + rnd() * 30, 1);
  }
  const [rc, rg] = canvas(n);
  rg.fillStyle = "#a8a8a8";
  rg.fillRect(0, 0, n, n);
  noiseFill(rg, n, rnd, 170, 60, 2000, 6, 0.5);
  return { map: tex(c, 1, true), normalMap: tex(normalFrom(hc, 1.6), 1, false), roughnessMap: tex(rc, 1, false) };
}

/** Cedar shingle siding, silvered with age. */
export function cedarShingle(weathered = true, metresPerTile = 2.4): Surface {
  const n = 512;
  const rnd = mulberry32(404);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  const courses = Math.round(metresPerTile / 0.18);
  const ch = n / courses;
  g.fillStyle = weathered ? "#8a8578" : "#a8784a";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#808080";
  hg.fillRect(0, 0, n, n);
  for (let i = 0; i < courses; i++) {
    const y = i * ch;
    let x = -rnd() * 30;
    while (x < n) {
      const w = 14 + rnd() * 26;
      const v = weathered ? 110 + rnd() * 60 : 130 + rnd() * 70;
      g.fillStyle = weathered ? `rgb(${v},${v - 3},${v - 12})` : `rgb(${v + 40},${v},${v - 40})`;
      g.fillRect(x, y, w - 1.5, ch);
      const hv = 120 + rnd() * 60;
      hg.fillStyle = `rgb(${hv},${hv},${hv})`;
      hg.fillRect(x, y, w - 1.5, ch);
      x += w;
    }
    g.fillStyle = "rgba(0,0,0,0.35)";
    g.fillRect(0, y, n, 3);
    hg.fillStyle = "#303030";
    hg.fillRect(0, y, n, 3);
  }
  const [rc, rg] = canvas(n);
  rg.fillStyle = "#d8d8d8";
  rg.fillRect(0, 0, n, n);
  return { map: tex(c, 1, true), normalMap: tex(normalFrom(hc, 2.0), 1, false), roughnessMap: tex(rc, 1, false) };
}

/** Architectural asphalt shingles, the roof on most of the island. */
export function asphaltShingle(colour = "#4a4744", metresPerTile = 3): Surface {
  const n = 512;
  const rnd = mulberry32(505);
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
  }
  // Granule speckle.
  for (let i = 0; i < 9000; i++) {
    const v = 60 + rnd() * 140;
    g.fillStyle = `rgba(${v},${v},${v},0.25)`;
    g.fillRect(rnd() * n, rnd() * n, 1.2, 1.2);
  }
  // Moss in the shade side, Bainbridge roofs grow it.
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `rgba(${70 + rnd() * 40},${110 + rnd() * 40},${40 + rnd() * 20},${0.12 + rnd() * 0.25})`;
    g.beginPath();
    g.ellipse(rnd() * n, rnd() * n, 4 + rnd() * 18, 2 + rnd() * 5, 0, 0, Math.PI * 2);
    g.fill();
  }
  const [rc, rg] = canvas(n);
  rg.fillStyle = "#e4e4e4";
  rg.fillRect(0, 0, n, n);
  return { map: tex(c, 1, true), normalMap: tex(normalFrom(hc, 1.4), 1, false), roughnessMap: tex(rc, 1, false) };
}

/** Standing-seam metal roof, the other roof on the island. */
export function metalRoof(colour = "#4f5a52", metresPerTile = 3): Surface {
  const n = 256;
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = colour;
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#808080";
  hg.fillRect(0, 0, n, n);
  const seams = Math.round(metresPerTile / 0.4);
  const sw = n / seams;
  for (let i = 0; i < seams; i++) {
    const x = i * sw;
    g.fillStyle = "rgba(255,255,255,0.12)";
    g.fillRect(x, 0, 2, n);
    g.fillStyle = "rgba(0,0,0,0.25)";
    g.fillRect(x + 2, 0, 2, n);
    hg.fillStyle = "#e0e0e0";
    hg.fillRect(x, 0, 3, n);
  }
  const [rc, rg] = canvas(n);
  rg.fillStyle = "#6a6a6a";
  rg.fillRect(0, 0, n, n);
  return { map: tex(c, 1, true), normalMap: tex(normalFrom(hc, 1.2), 1, false), roughnessMap: tex(rc, 1, false) };
}

/** Forest floor: needles, moss, salal litter. */
export function forestFloor(): Surface {
  const n = 512;
  const rnd = mulberry32(606);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = "#4a3e2c";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#808080";
  hg.fillRect(0, 0, n, n);
  for (let i = 0; i < 20000; i++) {
    const v = rnd();
    g.fillStyle = v < 0.5 ? `rgba(${60 + rnd() * 50},${45 + rnd() * 30},${25 + rnd() * 15},0.6)` : `rgba(${50 + rnd() * 40},${80 + rnd() * 50},${30 + rnd() * 20},0.5)`;
    g.save();
    g.translate(rnd() * n, rnd() * n);
    g.rotate(rnd() * Math.PI);
    g.fillRect(0, 0, 2 + rnd() * 10, 1.2);
    g.restore();
  }
  noiseFill(hg, n, rnd, 128, 120, 6000, 4, 0.5);
  const [rc, rg] = canvas(n);
  rg.fillStyle = "#f0f0f0";
  rg.fillRect(0, 0, n, n);
  return { map: tex(c, 1, true), normalMap: tex(normalFrom(hc, 1.5), 1, false), roughnessMap: tex(rc, 1, false) };
}

/** Lawn and pasture: PNW grass is never one green. */
export function grass(): Surface {
  const n = 512;
  const rnd = mulberry32(707);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = "#5d7a3a";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#808080";
  hg.fillRect(0, 0, n, n);
  for (let i = 0; i < 30000; i++) {
    const t = rnd();
    const r = 70 + t * 50;
    const gg = 105 + t * 50;
    const b = 40 + t * 20;
    g.fillStyle = `rgba(${r},${gg},${b},0.7)`;
    g.save();
    g.translate(rnd() * n, rnd() * n);
    g.rotate((rnd() - 0.5) * 0.8);
    g.fillRect(0, 0, 1.2, 3 + rnd() * 6);
    g.restore();
  }
  // Clover and dry patches.
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(${140 + rnd() * 40},${140 + rnd() * 30},${70 + rnd() * 20},${0.1 + rnd() * 0.2})`;
    g.beginPath();
    g.ellipse(rnd() * n, rnd() * n, 10 + rnd() * 40, 6 + rnd() * 20, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  noiseFill(hg, n, rnd, 128, 80, 8000, 2, 0.5);
  const [rc, rg] = canvas(n);
  rg.fillStyle = "#e8e8e8";
  rg.fillRect(0, 0, n, n);
  return { map: tex(c, 1, true), normalMap: tex(normalFrom(hc, 1.0), 1, false), roughnessMap: tex(rc, 1, false) };
}

/** Douglas fir bark: deep furrows, moss on the north side. */
export function bark(): Surface {
  const n = 256;
  const rnd = mulberry32(808);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  g.fillStyle = "#4f4238";
  g.fillRect(0, 0, n, n);
  hg.fillStyle = "#808080";
  hg.fillRect(0, 0, n, n);
  for (let x = 0; x < n; x += 6 + rnd() * 10) {
    const w = 3 + rnd() * 8;
    g.fillStyle = `rgba(${20 + rnd() * 20},${16 + rnd() * 14},${12 + rnd() * 10},0.8)`;
    g.fillRect(x, 0, w, n);
    hg.fillStyle = "#282828";
    hg.fillRect(x, 0, w, n);
    g.fillStyle = `rgba(${110 + rnd() * 40},${90 + rnd() * 30},${70 + rnd() * 20},0.5)`;
    g.fillRect(x + w, 0, 2, n);
  }
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `rgba(${70 + rnd() * 40},${110 + rnd() * 50},${40 + rnd() * 20},${0.15 + rnd() * 0.3})`;
    g.fillRect(rnd() * n * 0.5, rnd() * n, 2 + rnd() * 6, 2 + rnd() * 4);
  }
  const [rc, rg] = canvas(n);
  rg.fillStyle = "#f4f4f4";
  rg.fillRect(0, 0, n, n);
  return { map: tex(c, 1, true), normalMap: tex(normalFrom(hc, 2.5), 1, false), roughnessMap: tex(rc, 1, false) };
}

/** A conifer frond card: a dense spray of needled twigs, drawn once, instanced everywhere. */
export function firFrond(): THREE.CanvasTexture {
  const n = 256;
  const rnd = mulberry32(909);
  const [c, g] = canvas(n);
  g.clearRect(0, 0, n, n);
  // The branch runs up the middle; side twigs fan out and carry needle tufts.
  g.strokeStyle = "#3b2f24";
  g.lineWidth = 5;
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(n / 2, n);
  g.lineTo(n / 2, 10);
  g.stroke();
  for (let y = 14; y < n - 4; y += 5 + rnd() * 5) {
    const reach = (1 - y / n) * 0.6 + 0.4;
    for (const side of [-1, 1]) {
      const len = (34 + rnd() * 80) * reach;
      const slope = 0.28 + rnd() * 0.2;
      g.strokeStyle = `rgba(${55 + rnd() * 25},${45 + rnd() * 20},${30 + rnd() * 15},0.95)`;
      g.lineWidth = 2.2;
      g.beginPath();
      g.moveTo(n / 2, y);
      g.lineTo(n / 2 + side * len, y + len * slope);
      g.stroke();
      // Needle tufts: short fat strokes either side of the twig, dense enough to read as foliage.
      for (let k = 4; k < len; k += 3) {
        const px = n / 2 + side * k;
        const py = y + k * slope;
        const gr = 62 + rnd() * 50;
        g.strokeStyle = `rgba(${28 + rnd() * 26},${gr},${30 + rnd() * 18},${0.85 + rnd() * 0.15})`;
        g.lineWidth = 2.6;
        for (const dir of [-1, 1]) {
          g.beginPath();
          g.moveTo(px, py);
          g.lineTo(px + side * (3 + rnd() * 4), py + dir * (6 + rnd() * 7));
          g.stroke();
        }
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Salal / sword fern understory card. */
export function fernCard(): THREE.CanvasTexture {
  const n = 256;
  const rnd = mulberry32(1010);
  const [c, g] = canvas(n);
  g.clearRect(0, 0, n, n);
  for (let f = 0; f < 9; f++) {
    const ang = -Math.PI / 2 + (f - 4) * 0.28 + (rnd() - 0.5) * 0.2;
    const len = 90 + rnd() * 60;
    g.strokeStyle = "#3f5a2a";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(n / 2, n - 4);
    const ex = n / 2 + Math.cos(ang) * len;
    const ey = n - 4 + Math.sin(ang) * len;
    g.lineTo(ex, ey);
    g.stroke();
    for (let k = 10; k < len; k += 5) {
      const px = n / 2 + Math.cos(ang) * k;
      const py = n - 4 + Math.sin(ang) * k;
      const w = (1 - k / len) * 14 + 3;
      g.fillStyle = `rgba(${50 + rnd() * 30},${95 + rnd() * 50},${35 + rnd() * 20},0.95)`;
      g.beginPath();
      g.ellipse(px, py, w, 2.2, ang + Math.PI / 2, 0, Math.PI * 2);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A sign face drawn to a canvas, non-repeating. */
export function signFace(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, w = 512, h = 128): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function surfaceMaterial(s: Surface, opts: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map: s.map, normalMap: s.normalMap, roughnessMap: s.roughnessMap, roughness: 1, metalness: 0, ...opts });
}

export function disposeSurface(s: Surface): void {
  s.map.dispose();
  s.normalMap.dispose();
  s.roughnessMap.dispose();
}
