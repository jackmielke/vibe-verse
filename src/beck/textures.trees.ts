/**
 * Everything the forest is painted with, drawn in a canvas because nothing
 * photographic can be fetched from here: bark for five species with the
 * furrows in the normal map, foliage cards with real needle and leaf
 * silhouettes (several variants of each so no two branches read the same),
 * an understory atlas, whole-tree silhouettes for the far distance, and the
 * needle duff and moss that lie under a stand. Every generator is seeded, so
 * the wood is the same wood on every visit.
 */
import * as THREE from "three";
import { mulberry32 } from "./geo";
import type { Surface } from "./textures";

type Ctx = CanvasRenderingContext2D;

function canvas(w: number, h = w): [HTMLCanvasElement, Ctx] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
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

function cardTex(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

function normalFrom(height: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const w = height.width;
  const h = height.height;
  const src = height.getContext("2d")!.getImageData(0, 0, w, h).data;
  const [c, g] = canvas(w, h);
  const out = g.createImageData(w, h);
  const at = (x: number, y: number) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
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

const rgba = (r: number, g: number, b: number, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** A colour picked between two RGB triples, with a little noise. */
function pick(rnd: () => number, a: number[], b: number[], alpha = 1, jitter = 10): string {
  const t = rnd();
  return rgba(lerp(a[0], b[0], t) + (rnd() - 0.5) * jitter, lerp(a[1], b[1], t) + (rnd() - 0.5) * jitter, lerp(a[2], b[2], t) + (rnd() - 0.5) * jitter, alpha);
}

// ---- Bark ---------------------------------------------------------------------

export type BarkKind = "fir" | "cedar" | "alder" | "maple" | "madrona" | "stump";

/**
 * Bark for one species. The map tiles once around a trunk and a few times up
 * it; the normal map carries the furrows, which is what reads as bark at
 * arm's length when the colour alone would read as brown paint.
 */
export function barkTexture(kind: BarkKind): Surface {
  const n = 512;
  const rnd = mulberry32(kind === "fir" ? 4101 : kind === "cedar" ? 4102 : kind === "alder" ? 4103 : kind === "maple" ? 4104 : kind === "madrona" ? 4105 : 4106);
  const [c, g] = canvas(n);
  const [hc, hg] = canvas(n);
  const [rc, rg] = canvas(n);
  rg.fillStyle = "#e8e8e8";
  rg.fillRect(0, 0, n, n);
  hg.fillStyle = "#808080";
  hg.fillRect(0, 0, n, n);
  let strength = 2.5;

  if (kind === "fir" || kind === "stump") {
    // Douglas fir: thick, corky, deeply furrowed, dark grey-brown ridges with rust in the fissures.
    g.fillStyle = "#4a3f34";
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 1800; i++) {
      g.fillStyle = pick(rnd, [70, 60, 50], [95, 82, 68], 0.5, 12);
      g.fillRect(rnd() * n, rnd() * n, 3 + rnd() * 9, 2 + rnd() * 5);
    }
    // Furrows: wavy vertical fissures that wrap seamlessly (the walk starts and ends on the same x).
    const furrows = 8 + Math.floor(rnd() * 2);
    for (let f = 0; f < furrows; f++) {
      let x = (f / furrows) * n + rnd() * 20;
      const w = 9 + rnd() * 12;
      const startX = x;
      for (let y = 0; y < n; y += 3) {
        const t = y / n;
        x += (rnd() - 0.5) * 2.4;
        // Pull back to the start so the top and bottom rows meet.
        x += (startX - x) * t * 0.08;
        const ww = w * (0.6 + 0.4 * Math.sin(y * 0.05 + f));
        g.fillStyle = rgba(30 + rnd() * 10, 22 + rnd() * 8, 16 + rnd() * 6, 0.95);
        g.fillRect(x - ww / 2, y, ww, 4);
        g.fillStyle = rgba(120 + rnd() * 30, 62 + rnd() * 20, 34 + rnd() * 10, 0.55);
        g.fillRect(x - ww / 2 + 1, y, ww * 0.35, 4);
        hg.fillStyle = "#1a1a1a";
        hg.fillRect(x - ww / 2 - 1, y, ww + 2, 4);
        hg.fillStyle = "#3a3a3a";
        hg.fillRect(x - ww / 2 - 4, y, 3, 4);
        hg.fillRect(x + ww / 2 + 1, y, 3, 4);
      }
    }
    // Plate ridges between furrows: horizontal cracks and lighter corky flakes.
    for (let i = 0; i < 260; i++) {
      const x = rnd() * n;
      const y = rnd() * n;
      g.fillStyle = rgba(28, 22, 18, 0.7);
      g.fillRect(x, y, 8 + rnd() * 26, 1.5);
      hg.fillStyle = "#404040";
      hg.fillRect(x, y, 8 + rnd() * 26, 2);
    }
    for (let i = 0; i < 700; i++) {
      g.fillStyle = pick(rnd, [100, 88, 74], [125, 110, 92], 0.35, 10);
      g.fillRect(rnd() * n, rnd() * n, 2 + rnd() * 5, 1 + rnd() * 3);
    }
    strength = 3.2;
    if (kind === "stump") {
      // A springboard notch a third of the way up: every stump on the island has two.
      g.fillStyle = "#1d1611";
      g.fillRect(n * 0.3, n * 0.55, n * 0.14, n * 0.07);
      g.fillStyle = "#3a2a1c";
      g.fillRect(n * 0.3, n * 0.55, n * 0.14, n * 0.02);
      hg.fillStyle = "#101010";
      hg.fillRect(n * 0.3, n * 0.55, n * 0.14, n * 0.07);
    }
  } else if (kind === "cedar") {
    // Western red cedar: thin, fibrous, stringy bark in long vertical strips, grey outside and cinnamon under.
    g.fillStyle = "#705848";
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * n;
      const y = rnd() * n;
      const len = 30 + rnd() * 160;
      const w = 1 + rnd() * 3;
      const light = rnd() < 0.5;
      g.fillStyle = light ? pick(rnd, [130, 108, 92], [160, 138, 118], 0.55, 14) : pick(rnd, [58, 42, 32], [90, 66, 50], 0.6, 14);
      g.fillRect(x, y, w, len);
      if (y + len > n) g.fillRect(x, y - n, w, len);
      hg.fillStyle = light ? "#a0a0a0" : "#5a5a5a";
      hg.fillRect(x, y, w, len);
      if (y + len > n) hg.fillRect(x, y - n, w, len);
    }
    // Peeling strips lift away from the trunk and catch the light.
    for (let i = 0; i < 40; i++) {
      const x = rnd() * n;
      const y = rnd() * n;
      const len = 60 + rnd() * 140;
      g.fillStyle = rgba(150, 120, 96, 0.7);
      g.fillRect(x, y, 3, len);
      g.fillStyle = rgba(40, 28, 20, 0.7);
      g.fillRect(x + 3, y, 2, len);
      hg.fillStyle = "#c0c0c0";
      hg.fillRect(x, y, 3, len);
    }
    strength = 1.8;
  } else if (kind === "alder") {
    // Red alder: smooth pale grey, blotched white with lichen, dashed with horizontal lenticels.
    g.fillStyle = "#8f9088";
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 260; i++) {
      g.fillStyle = pick(rnd, [175, 178, 170], [205, 206, 198], 0.4, 8);
      g.beginPath();
      g.ellipse(rnd() * n, rnd() * n, 4 + rnd() * 14, 3 + rnd() * 10, rnd() * 3, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < 160; i++) {
      g.fillStyle = pick(rnd, [100, 102, 96], [125, 125, 118], 0.45, 8);
      g.beginPath();
      g.ellipse(rnd() * n, rnd() * n, 3 + rnd() * 12, 3 + rnd() * 8, rnd() * 3, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < 500; i++) {
      const x = rnd() * n;
      const y = rnd() * n;
      g.fillStyle = rgba(55, 55, 50, 0.6);
      g.fillRect(x, y, 4 + rnd() * 10, 1.5);
      hg.fillStyle = "#6a6a6a";
      hg.fillRect(x, y, 4 + rnd() * 10, 2);
    }
    // A little moss creeping in the shade.
    for (let i = 0; i < 90; i++) {
      g.fillStyle = pick(rnd, [80, 110, 50], [110, 140, 60], 0.35, 10);
      g.beginPath();
      g.ellipse(rnd() * n, rnd() * n, 3 + rnd() * 8, 3 + rnd() * 6, 0, 0, Math.PI * 2);
      g.fill();
    }
    strength = 0.9;
    rg.fillStyle = "#d8d8d8";
    rg.fillRect(0, 0, n, n);
  } else if (kind === "maple") {
    // Big-leaf maple: grey-brown, shallow interlacing ridges, and moss in every crevice.
    g.fillStyle = "#5c554b";
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 900; i++) {
      const x = rnd() * n;
      const y = rnd() * n;
      const len = 20 + rnd() * 90;
      const dark = rnd() < 0.5;
      g.fillStyle = dark ? pick(rnd, [40, 36, 30], [60, 54, 46], 0.7, 8) : pick(rnd, [110, 102, 90], [135, 126, 112], 0.5, 8);
      g.fillRect(x, y, 2 + rnd() * 5, len);
      hg.fillStyle = dark ? "#404040" : "#a0a0a0";
      hg.fillRect(x, y, 2 + rnd() * 5, len);
    }
    for (let i = 0; i < 260; i++) {
      g.fillStyle = pick(rnd, [70, 100, 40], [110, 140, 60], 0.35, 12);
      g.beginPath();
      g.ellipse(rnd() * n, rnd() * n, 3 + rnd() * 9, 3 + rnd() * 7, 0, 0, Math.PI * 2);
      g.fill();
    }
    strength = 1.6;
  } else {
    // Pacific madrona: smooth, orange-red, peeling in papery curls to pale green underneath.
    g.fillStyle = "#a8502c";
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 400; i++) {
      g.fillStyle = pick(rnd, [150, 70, 36], [190, 95, 50], 0.5, 12);
      g.beginPath();
      g.ellipse(rnd() * n, rnd() * n, 8 + rnd() * 30, 6 + rnd() * 20, rnd() * 3, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < 26; i++) {
      // A peel: pale green new bark showing through, with a curled papery edge.
      const x = rnd() * n;
      const y = rnd() * n;
      const w = 10 + rnd() * 34;
      const h = 6 + rnd() * 22;
      g.fillStyle = pick(rnd, [150, 160, 110], [185, 190, 135], 0.85, 12);
      g.beginPath();
      g.ellipse(x, y, w, h, rnd() * 0.6, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = rgba(220, 170, 110, 0.9);
      g.lineWidth = 3;
      g.beginPath();
      g.ellipse(x, y, w, h, rnd() * 0.6, Math.PI * 0.9, Math.PI * 1.9);
      g.stroke();
      hg.fillStyle = "#6a6a6a";
      hg.beginPath();
      hg.ellipse(x, y, w, h, 0, 0, Math.PI * 2);
      hg.fill();
      hg.strokeStyle = "#c0c0c0";
      hg.lineWidth = 3;
      hg.beginPath();
      hg.ellipse(x, y, w, h, 0, Math.PI * 0.9, Math.PI * 1.9);
      hg.stroke();
    }
    strength = 1.2;
    rg.fillStyle = "#a0a0a0";
    rg.fillRect(0, 0, n, n);
  }
  return { map: tex(c, 1, true), normalMap: tex(normalFrom(hc, strength), 1, false), roughnessMap: tex(rc, 1, false) };
}

// ---- Foliage cards --------------------------------------------------------------

/** A short stroke, the unit every needle and leaflet is built from. */
function needle(g: Ctx, x: number, y: number, ang: number, len: number, w: number, col: string) {
  g.strokeStyle = col;
  g.lineWidth = w;
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
  g.stroke();
}

/**
 * A Douglas fir spray. The twig climbs from the bottom of the cell; lateral
 * twigs alternate up it, each carrying sub-twigs, and every twig is wrapped
 * in short needles both sides so the card reads as a bottle brush, not a
 * fishbone. New growth at the tips is a lighter yellow-green and the old
 * needles further in are blue-green and dark.
 */
function drawFirSpray(g: Ctx, ox: number, oy: number, s: number, rnd: () => number, cones: boolean) {
  const dark = [38, 62, 40];
  const mid = [52, 86, 48];
  const tip = [108, 150, 70];
  const brown = [70, 52, 36];
  // Stem, curving a little.
  const bx = ox + s * 0.5;
  const top = oy + s * 0.05;
  const bottom = oy + s * 0.98;
  g.lineCap = "round";
  const stem = (t: number) => ({ x: bx + Math.sin(t * 3.1) * s * 0.03, y: lerp(bottom, top, t) });
  const needlesAlong = (x0: number, y0: number, x1: number, y1: number, density: number, len: number, w: number, k: number) => {
    const L = Math.hypot(x1 - x0, y1 - y0);
    const a = Math.atan2(y1 - y0, x1 - x0);
    for (let d = 2; d < L; d += density) {
      const px = x0 + Math.cos(a) * d;
      const py = y0 + Math.sin(a) * d;
      const fresh = d / L > 0.72 ? (d / L - 0.72) / 0.28 : 0;
      for (const side of [-1, 1]) {
        const c = rnd() < 0.5 ? dark : mid;
        const col = fresh > 0 && rnd() < fresh ? pick(rnd, mid, tip, 0.95, 10) : pick(rnd, c, mid, 0.92 + rnd() * 0.08, 10);
        needle(g, px, py, a + side * (0.95 + rnd() * 0.5), len * (0.7 + rnd() * 0.5) * k, w, col);
      }
      if (rnd() < 0.35) needle(g, px, py, a + (rnd() - 0.5) * 0.4, len * 0.9 * k, w, pick(rnd, dark, mid, 0.9, 8));
    }
  };
  // Main stem in brown then the lateral twigs.
  g.strokeStyle = rgba(brown[0], brown[1], brown[2], 1);
  g.lineWidth = s * 0.014;
  g.beginPath();
  g.moveTo(stem(0).x, stem(0).y);
  for (let t = 0; t <= 1; t += 0.1) g.lineTo(stem(t).x, stem(t).y);
  g.stroke();
  const laterals: { x0: number; y0: number; x1: number; y1: number; k: number }[] = [];
  const count = 13 + Math.floor(rnd() * 4);
  for (let i = 0; i < count; i++) {
    const t = 0.12 + (i / count) * 0.84 + (rnd() - 0.5) * 0.03;
    const p = stem(t);
    const side = i % 2 === 0 ? -1 : 1;
    const reach = s * (0.42 - t * 0.3) * (0.8 + rnd() * 0.45);
    const ang = -Math.PI / 2 + side * (0.95 + (rnd() - 0.5) * 0.3) + (t > 0.8 ? -side * 0.3 : 0);
    const x1 = p.x + Math.cos(ang) * reach;
    const y1 = p.y + Math.sin(ang) * reach;
    laterals.push({ x0: p.x, y0: p.y, x1, y1, k: 1 - t * 0.35 });
    g.strokeStyle = rgba(brown[0], brown[1], brown[2], 1);
    g.lineWidth = s * 0.008;
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(x1, y1);
    g.stroke();
    // Sub-twigs off each lateral, drooping a little then lifting at the tip.
    const subs = 2 + Math.floor(rnd() * 3);
    for (let j = 0; j < subs; j++) {
      const u = 0.3 + (j / subs) * 0.6;
      const sx = lerp(p.x, x1, u);
      const sy = lerp(p.y, y1, u);
      const sside = j % 2 === 0 ? 1 : -1;
      const sang = ang + sside * (0.7 + rnd() * 0.4);
      const sr = reach * (0.32 + rnd() * 0.22) * (1 - u * 0.4);
      const ex = sx + Math.cos(sang) * sr;
      const ey = sy + Math.sin(sang) * sr;
      g.strokeStyle = rgba(brown[0], brown[1], brown[2], 1);
      g.lineWidth = s * 0.005;
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(ex, ey);
      g.stroke();
      laterals.push({ x0: sx, y0: sy, x1: ex, y1: ey, k: 0.75 });
    }
  }
  for (const l of laterals) needlesAlong(l.x0, l.y0, l.x1, l.y1, s * 0.0075, s * 0.05, s * 0.0062, l.k);
  needlesAlong(stem(0.1).x, stem(0.1).y, stem(1).x, stem(1).y, s * 0.01, s * 0.045, s * 0.006, 1);
  // Cones hang below the mid-spray: brown with the three-pointed bracts that only a Douglas fir has.
  if (cones) {
    for (let i = 0; i < 2; i++) {
      const l = laterals[Math.floor(rnd() * Math.min(6, laterals.length))];
      const cx = lerp(l.x0, l.x1, 0.5 + rnd() * 0.4);
      const cy = lerp(l.y0, l.y1, 0.5 + rnd() * 0.4) + s * 0.03;
      const w = s * 0.012;
      const h = s * 0.03;
      g.fillStyle = "#6b4a2c";
      g.beginPath();
      g.ellipse(cx, cy + h / 2, w, h, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "#a88a5a";
      g.lineWidth = 0.8;
      for (let k = 0; k < 4; k++) {
        const yy = cy + h * 0.15 + (k / 4) * h * 1.6;
        g.beginPath();
        g.moveTo(cx - w * 0.7, yy);
        g.lineTo(cx - w * 0.5, yy + 3);
        g.moveTo(cx + w * 0.7, yy);
        g.lineTo(cx + w * 0.5, yy + 3);
        g.stroke();
      }
    }
  }
}

/**
 * A western red cedar spray: flat, lacy, drooping fans of scale leaves. The
 * branchlets fork in one plane and each carries a feathered fringe, so the
 * whole card is a soft lattice rather than a brush. A few inner sprays have
 * gone cinnamon brown, which is what every cedar does in September.
 */
function drawCedarSpray(g: Ctx, ox: number, oy: number, s: number, rnd: () => number) {
  const dark = [60, 96, 40];
  const mid = [88, 130, 52];
  const tip = [140, 175, 80];
  const brown = [120, 82, 46];
  g.lineCap = "round";
  const bx = ox + s * 0.5;
  const top = oy + s * 0.06;
  const bottom = oy + s * 0.98;
  const fringe = (x0: number, y0: number, x1: number, y1: number, k: number, old: boolean) => {
    const L = Math.hypot(x1 - x0, y1 - y0);
    const a = Math.atan2(y1 - y0, x1 - x0);
    for (let d = 1; d < L; d += s * 0.004) {
      const px = x0 + Math.cos(a) * d;
      const py = y0 + Math.sin(a) * d;
      const taper = 1 - (d / L) * 0.5;
      for (const side of [-1, 1]) {
        const c = old ? pick(rnd, brown, [150, 105, 60], 0.9, 10) : d / L > 0.75 ? pick(rnd, mid, tip, 0.95, 10) : pick(rnd, dark, mid, 0.95, 10);
        needle(g, px, py, a + side * (1.0 + rnd() * 0.4), s * 0.03 * taper * k, s * 0.006, c);
      }
    }
    g.strokeStyle = old ? rgba(120, 70, 36, 1) : rgba(75, 110, 45, 1);
    g.lineWidth = s * 0.005;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  };
  g.strokeStyle = "#5a4332";
  g.lineWidth = s * 0.012;
  g.beginPath();
  g.moveTo(bx, bottom);
  g.lineTo(bx + s * 0.02, top);
  g.stroke();
  const count = 11 + Math.floor(rnd() * 3);
  for (let i = 0; i < count; i++) {
    const t = 0.1 + (i / count) * 0.85;
    const px = bx + s * 0.02 * t;
    const py = lerp(bottom, top, t);
    const side = i % 2 === 0 ? -1 : 1;
    const reach = s * (0.44 - t * 0.28) * (0.85 + rnd() * 0.3);
    // Laterals reach out and droop: the angle bends downward along the lateral.
    const ang0 = -Math.PI / 2 + side * (1.05 + (rnd() - 0.5) * 0.25);
    const old = rnd() < 0.05 && t < 0.5;
    const segs = 3;
    let x = px;
    let y = py;
    for (let sgm = 0; sgm < segs; sgm++) {
      const ang = ang0 + side * sgm * 0.42;
      const nx = x + Math.cos(ang) * (reach / segs);
      const ny = y + Math.sin(ang) * (reach / segs);
      fringe(x, y, nx, ny, 1 - t * 0.4, old);
      // Branchlets off each segment, in the same plane, each a small drooping fan.
      for (const bside of [-1, 1]) {
        const bang = ang + bside * (0.8 + rnd() * 0.3) + side * 0.35;
        const br = reach * (0.28 + rnd() * 0.16) * (1 - sgm * 0.2);
        const ex = x + Math.cos(bang) * br;
        const ey = y + Math.sin(bang) * br;
        fringe(x, y, ex, ey, 0.7, old);
        const bang2 = bang + bside * 0.5;
        fringe(ex, ey, ex + Math.cos(bang2) * br * 0.5, ey + Math.sin(bang2) * br * 0.5, 0.5, old);
      }
      x = nx;
      y = ny;
    }
  }
}

/** A five-lobed maple leaf, the size of a dinner plate on a big-leaf maple. */
function mapleLeaf(g: Ctx, x: number, y: number, r: number, rot: number, fill: string, vein: string) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.fillStyle = fill;
  g.beginPath();
  const lobes = 5;
  for (let i = 0; i <= lobes * 2; i++) {
    const a = -Math.PI / 2 + ((i - lobes) / lobes) * 1.9;
    const rr = i % 2 === 0 ? r : r * 0.5;
    const px = Math.cos(a) * rr;
    const py = Math.sin(a) * rr + r * 0.25;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.closePath();
  g.fill();
  g.strokeStyle = vein;
  g.lineWidth = 1;
  for (let i = 0; i < lobes; i++) {
    const a = -Math.PI / 2 + ((i * 2 - lobes) / lobes) * 1.9;
    g.beginPath();
    g.moveTo(0, r * 0.35);
    g.lineTo(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9 + r * 0.25);
    g.stroke();
  }
  g.restore();
}

function ovalLeaf(g: Ctx, x: number, y: number, len: number, w: number, rot: number, fill: string, vein: string | null, serrate = false) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.fillStyle = fill;
  g.beginPath();
  if (serrate) {
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = Math.PI * t;
      const jag = i % 2 ? 1 : 0.86;
      g.lineTo(Math.cos(a) * len * 0.5 * (i === 0 || i === steps ? 1 : 1), -Math.sin(a) * w * 0.5 * jag);
    }
    for (let i = steps; i >= 0; i--) {
      const t = i / steps;
      const a = Math.PI * t;
      const jag = i % 2 ? 1 : 0.86;
      g.lineTo(Math.cos(a) * len * 0.5, Math.sin(a) * w * 0.5 * jag);
    }
  } else {
    g.ellipse(0, 0, len * 0.5, w * 0.5, 0, 0, Math.PI * 2);
  }
  g.closePath();
  g.fill();
  if (vein) {
    g.strokeStyle = vein;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(-len * 0.5, 0);
    g.lineTo(len * 0.5, 0);
    g.stroke();
  }
  g.restore();
}

/** Twigs radiating from the bottom centre, returned as end points to hang leaves on. */
function twigFan(g: Ctx, ox: number, oy: number, s: number, rnd: () => number, count: number, spread: number, col: string): { x: number; y: number; a: number; t: number }[] {
  const pts: { x: number; y: number; a: number; t: number }[] = [];
  const bx = ox + s * 0.5;
  const by = oy + s * 0.97;
  g.strokeStyle = col;
  g.lineCap = "round";
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i / (count - 1) - 0.5) * spread + (rnd() - 0.5) * 0.2;
    const len = s * (0.5 + rnd() * 0.35) / (1 + Math.abs(Math.cos(a)) * 0.6);
    g.lineWidth = s * 0.012;
    g.beginPath();
    g.moveTo(bx, by);
    const mx = bx + Math.cos(a) * len * 0.5 + (rnd() - 0.5) * s * 0.12;
    const my = by + Math.sin(a) * len * 0.5;
    const ex = bx + Math.cos(a) * len;
    const ey = by + Math.sin(a) * len;
    g.quadraticCurveTo(mx, my, ex, ey);
    g.stroke();
    for (let k = 0.3; k <= 1.0; k += 0.12) {
      // Point on the quadratic, so the leaves sit on the twig they hang from.
      const u = 1 - k;
      const px = u * u * bx + 2 * u * k * mx + k * k * ex;
      const py = u * u * by + 2 * u * k * my + k * k * ey;
      pts.push({ x: Math.min(ox + s * 0.95, Math.max(ox + s * 0.05, px + (rnd() - 0.5) * s * 0.08)), y: Math.max(oy + s * 0.06, py + (rnd() - 0.5) * s * 0.08), a, t: k });
    }
  }
  return pts;
}

function drawMapleCluster(g: Ctx, ox: number, oy: number, s: number, rnd: () => number) {
  const pts = twigFan(g, ox, oy, s, rnd, 6, 1.5, "#5a5046");
  const green = [66, 108, 44];
  const green2 = [96, 140, 58];
  const gold = [180, 160, 66];
  for (const p of pts) {
    for (let k = 0; k < 2; k++) {
      const r = s * (0.08 + rnd() * 0.05);
      const turning = rnd() < 0.16;
      const fill = turning ? pick(rnd, gold, [210, 150, 60], 1, 14) : pick(rnd, green, green2, 1, 14);
      mapleLeaf(g, p.x + (rnd() - 0.5) * s * 0.08, p.y + (rnd() - 0.5) * s * 0.08, r, p.a + Math.PI / 2 + (rnd() - 0.5) * 1.6, fill, rgba(70, 100, 40, 0.6));
    }
  }
}

function drawAlderCluster(g: Ctx, ox: number, oy: number, s: number, rnd: () => number) {
  const pts = twigFan(g, ox, oy, s, rnd, 8, 1.4, "#6b6a60");
  const green = [70, 112, 48];
  const green2 = [100, 140, 62];
  for (const p of pts) {
    for (let k = 0; k < 3; k++) {
      const len = s * (0.07 + rnd() * 0.04);
      ovalLeaf(g, p.x + (rnd() - 0.5) * s * 0.06, p.y + (rnd() - 0.5) * s * 0.06, len, len * 0.62, rnd() * Math.PI, pick(rnd, green, green2, 1, 12), rgba(60, 90, 40, 0.5), true);
    }
  }
}

function drawMadronaCluster(g: Ctx, ox: number, oy: number, s: number, rnd: () => number) {
  const pts = twigFan(g, ox, oy, s, rnd, 5, 1.6, "#9a4a2a");
  const green = [40, 78, 40];
  const green2 = [70, 110, 56];
  for (const p of pts) {
    for (let k = 0; k < 3; k++) {
      const len = s * (0.1 + rnd() * 0.06);
      const old = rnd() < 0.1;
      ovalLeaf(g, p.x + (rnd() - 0.5) * s * 0.07, p.y + (rnd() - 0.5) * s * 0.07, len, len * 0.42, p.a + (rnd() - 0.5) * 1.6, old ? pick(rnd, [200, 120, 50], [220, 160, 60], 1, 10) : pick(rnd, green, green2, 1, 10), rgba(130, 170, 110, 0.5));
    }
    if (p.t > 0.8 && rnd() < 0.4) {
      // Berry clusters, going orange.
      for (let b = 0; b < 8; b++) {
        g.fillStyle = pick(rnd, [200, 110, 40], [230, 70, 40], 1, 12);
        g.beginPath();
        g.arc(p.x + (rnd() - 0.5) * s * 0.05, p.y + (rnd() - 0.5) * s * 0.05, s * 0.006, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
}

function drawJapaneseMaple(g: Ctx, ox: number, oy: number, s: number, rnd: () => number) {
  const pts = twigFan(g, ox, oy, s, rnd, 6, 2.0, "#4a3a3a");
  const red = [120, 36, 40];
  const red2 = [170, 60, 45];
  for (const p of pts) {
    for (let k = 0; k < 2; k++) {
      const r = s * (0.045 + rnd() * 0.03);
      mapleLeaf(g, p.x + (rnd() - 0.5) * s * 0.05, p.y + (rnd() - 0.5) * s * 0.05, r, rnd() * Math.PI * 2, pick(rnd, red, red2, 1, 14), rgba(60, 20, 20, 0.5));
    }
  }
}

function drawAppleCluster(g: Ctx, ox: number, oy: number, s: number, rnd: () => number) {
  const pts = twigFan(g, ox, oy, s, rnd, 6, 1.8, "#5a4a3a");
  const green = [80, 120, 50];
  const green2 = [110, 150, 70];
  for (const p of pts) {
    for (let k = 0; k < 3; k++) {
      const len = s * (0.07 + rnd() * 0.04);
      ovalLeaf(g, p.x + (rnd() - 0.5) * s * 0.06, p.y + (rnd() - 0.5) * s * 0.06, len, len * 0.6, rnd() * Math.PI, pick(rnd, green, green2, 1, 12), rgba(70, 100, 50, 0.5));
    }
    if (rnd() < 0.3) {
      g.fillStyle = pick(rnd, [190, 60, 40], [220, 120, 60], 1, 12);
      g.beginPath();
      g.arc(p.x, p.y + s * 0.02, s * 0.022, 0, Math.PI * 2);
      g.fill();
    }
  }
}

/** Sword fern: a dozen fronds arching from one crown, each a stalk with a pinna every few pixels. */
function drawFern(g: Ctx, ox: number, oy: number, s: number, rnd: () => number) {
  const bx = ox + s * 0.5;
  const by = oy + s * 0.97;
  const count = 11 + Math.floor(rnd() * 4);
  g.lineCap = "round";
  for (let f = 0; f < count; f++) {
    const a = -Math.PI / 2 + (f / (count - 1) - 0.5) * 2.0 + (rnd() - 0.5) * 0.2;
    const len = s * (0.6 + rnd() * 0.3) * (1 - Math.abs(Math.cos(a)) * 0.35);
    const droop = 0.2 + rnd() * 0.25;
    const pts: number[][] = [];
    for (let t = 0; t <= 1; t += 0.08) {
      const ang = a + Math.sin(a + Math.PI / 2) * 0 + (a < -Math.PI / 2 ? -1 : 1) * droop * t * t;
      pts.push([bx + Math.cos(ang) * len * t, by + Math.sin(ang) * len * t]);
    }
    g.strokeStyle = "#4b6a2a";
    g.lineWidth = s * 0.006;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts) g.lineTo(p[0], p[1]);
    g.stroke();
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const seg = Math.hypot(x1 - x0, y1 - y0);
      const sa = Math.atan2(y1 - y0, x1 - x0);
      const t = i / pts.length;
      const pw = s * 0.05 * (1 - t * 0.8) * (0.4 + Math.min(1, t * 3));
      for (let d = 0; d < seg; d += s * 0.012) {
        const px = x0 + Math.cos(sa) * d;
        const py = y0 + Math.sin(sa) * d;
        const col = pick(rnd, [55, 100, 42], [95, 140, 60], 0.97, 12);
        needle(g, px, py, sa + 1.15, pw, s * 0.007, col);
        needle(g, px, py, sa - 1.15, pw, s * 0.007, col);
      }
    }
  }
}

function drawSalal(g: Ctx, ox: number, oy: number, s: number, rnd: () => number) {
  const bx = ox + s * 0.5;
  const by = oy + s * 0.97;
  g.lineCap = "round";
  const green = [40, 80, 36];
  const green2 = [78, 120, 50];
  for (let st = 0; st < 13; st++) {
    const a = -Math.PI / 2 + (rnd() - 0.5) * 2.0;
    const len = s * (0.4 + rnd() * 0.4);
    g.strokeStyle = "#7a4a3a";
    g.lineWidth = s * 0.007;
    g.beginPath();
    g.moveTo(bx, by);
    let x = bx;
    let y = by;
    for (let k = 0; k < 6; k++) {
      x += Math.cos(a + (k % 2 ? 0.35 : -0.35)) * (len / 6);
      y += Math.sin(a + (k % 2 ? 0.35 : -0.35)) * (len / 6);
      g.lineTo(x, y);
    }
    g.stroke();
    x = bx;
    y = by;
    for (let k = 0; k < 6; k++) {
      x += Math.cos(a + (k % 2 ? 0.35 : -0.35)) * (len / 6);
      y += Math.sin(a + (k % 2 ? 0.35 : -0.35)) * (len / 6);
      const ll = s * (0.11 + rnd() * 0.06);
      ovalLeaf(g, x + (rnd() - 0.5) * s * 0.03, y, ll, ll * 0.7, a + (k % 2 ? 1.1 : -1.1) + (rnd() - 0.5) * 0.5, pick(rnd, green, green2, 1, 10), rgba(140, 180, 120, 0.55));
      if (rnd() < 0.15) {
        g.fillStyle = "#2a1a30";
        for (let b = 0; b < 5; b++) {
          g.beginPath();
          g.arc(x + (rnd() - 0.5) * s * 0.04, y + s * 0.03 + rnd() * s * 0.02, s * 0.007, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
  }
}

function drawOregonGrape(g: Ctx, ox: number, oy: number, s: number, rnd: () => number) {
  const pts = twigFan(g, ox, oy, s, rnd, 5, 1.6, "#5a4030");
  for (const p of pts) {
    if (p.t < 0.4) continue;
    // Pinnate leaf: a row of spiny holly-like leaflets each side of a stalk.
    const stalkA = p.a + (rnd() - 0.5) * 0.9;
    const L = s * 0.18;
    for (let k = 0; k < 5; k++) {
      const u = (k + 1) / 6;
      const x = p.x + Math.cos(stalkA) * L * u;
      const y = p.y + Math.sin(stalkA) * L * u;
      const red = rnd() < 0.12;
      const fill = red ? pick(rnd, [150, 50, 40], [190, 90, 40], 1, 10) : pick(rnd, [36, 72, 36], [70, 110, 50], 1, 10);
      for (const side of [-1, 1]) {
        const len = s * 0.085;
        ovalLeaf(g, x, y, len, len * 0.5, stalkA + side * 1.0, fill, rgba(140, 180, 120, 0.5), true);
      }
    }
    if (rnd() < 0.2) {
      for (let b = 0; b < 7; b++) {
        g.fillStyle = pick(rnd, [70, 80, 130], [100, 110, 160], 1, 10);
        g.beginPath();
        g.arc(p.x + (rnd() - 0.5) * s * 0.04, p.y + (rnd() - 0.5) * s * 0.04, s * 0.008, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
}

function drawHuckleberry(g: Ctx, ox: number, oy: number, s: number, rnd: () => number) {
  const pts = twigFan(g, ox, oy, s, rnd, 9, 2.0, "#8a4a3a");
  for (const p of pts) {
    for (let k = 0; k < 4; k++) {
      const len = s * (0.03 + rnd() * 0.02);
      ovalLeaf(g, p.x + (rnd() - 0.5) * s * 0.07, p.y + (rnd() - 0.5) * s * 0.07, len, len * 0.55, rnd() * Math.PI, pick(rnd, [45, 90, 40], [90, 140, 60], 1, 10), null);
    }
  }
}

function drawBlackberry(g: Ctx, ox: number, oy: number, s: number, rnd: () => number) {
  const bx = ox + s * 0.5;
  const by = oy + s * 0.97;
  g.lineCap = "round";
  for (let cane = 0; cane < 7; cane++) {
    // Arching canes: up and over, thorny, with leaves along them.
    const a0 = -Math.PI / 2 + (rnd() - 0.5) * 2.4;
    const len = s * (0.4 + rnd() * 0.3);
    const pts: number[][] = [];
    for (let t = 0; t <= 1; t += 0.06) {
      const ang = a0 + (a0 < -Math.PI / 2 ? -1 : 1) * 1.4 * t * t;
      pts.push([bx + Math.cos(ang) * len * t, by + Math.sin(ang) * len * t]);
    }
    g.strokeStyle = rnd() < 0.5 ? "#5a3a2a" : "#6a5a3a";
    g.lineWidth = s * 0.009;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts) g.lineTo(p[0], p[1]);
    g.stroke();
    for (let i = 2; i < pts.length; i += 2) {
      const [x, y] = pts[i];
      // A palmate leaf of three to five leaflets.
      const n = rnd() < 0.5 ? 3 : 5;
      const base = rnd() * Math.PI * 2;
      for (let k = 0; k < n; k++) {
        const la = base + (k / n) * Math.PI * 2;
        const ll = s * (0.06 + rnd() * 0.035);
        const fill = rnd() < 0.15 ? pick(rnd, [150, 60, 40], [180, 110, 50], 1, 10) : pick(rnd, [50, 92, 40], [95, 135, 58], 1, 12);
        ovalLeaf(g, x + Math.cos(la) * ll * 0.5, y + Math.sin(la) * ll * 0.5, ll, ll * 0.5, la, fill, rgba(150, 190, 130, 0.5), true);
      }
      if (rnd() < 0.3) {
        for (let b = 0; b < 4; b++) {
          g.fillStyle = rnd() < 0.7 ? "#1a1018" : "#7a2a3a";
          g.beginPath();
          g.arc(x + (rnd() - 0.5) * s * 0.03, y + (rnd() - 0.5) * s * 0.03, s * 0.009, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
  }
}

function drawNettle(g: Ctx, ox: number, oy: number, s: number, rnd: () => number) {
  const bx = ox + s * 0.5;
  const by = oy + s * 0.97;
  for (let st = 0; st < 5; st++) {
    const x0 = bx + (rnd() - 0.5) * s * 0.5;
    const lean = (rnd() - 0.5) * 0.3;
    const h = s * (0.6 + rnd() * 0.35);
    g.strokeStyle = "#5a7a3a";
    g.lineWidth = s * 0.008;
    g.beginPath();
    g.moveTo(x0, by);
    g.lineTo(x0 + Math.sin(lean) * h, by - h);
    g.stroke();
    for (let k = 0.25; k < 1; k += 0.13) {
      const x = x0 + Math.sin(lean) * h * k;
      const y = by - h * k;
      for (const side of [-1, 1]) {
        const ll = s * (0.09 - k * 0.04);
        ovalLeaf(g, x + side * ll * 0.45, y, ll, ll * 0.5, side * 0.35 + (rnd() - 0.5) * 0.3, pick(rnd, [60, 100, 44], [96, 140, 62], 1, 10), rgba(40, 70, 30, 0.6), true);
      }
    }
  }
}

function drawRhodo(g: Ctx, ox: number, oy: number, s: number, rnd: () => number) {
  const pts = twigFan(g, ox, oy, s, rnd, 7, 2.2, "#6a5a4a");
  for (const p of pts) {
    if (p.t < 0.55) continue;
    // Leaves in a whorl around the twig end.
    const n = 5 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const la = (k / n) * Math.PI * 2 + rnd() * 0.4;
      const ll = s * (0.12 + rnd() * 0.05);
      ovalLeaf(g, p.x + Math.cos(la) * ll * 0.45, p.y + Math.sin(la) * ll * 0.45, ll, ll * 0.36, la, pick(rnd, [36, 72, 38], [70, 110, 52], 1, 10), rgba(150, 180, 130, 0.6));
    }
  }
}

function drawHydrangea(g: Ctx, ox: number, oy: number, s: number, rnd: () => number) {
  const pts = twigFan(g, ox, oy, s, rnd, 7, 2.2, "#7a6a4a");
  for (const p of pts) {
    if (p.t < 0.5) continue;
    for (let k = 0; k < 3; k++) {
      const ll = s * (0.11 + rnd() * 0.04);
      ovalLeaf(g, p.x + (rnd() - 0.5) * s * 0.08, p.y + (rnd() - 0.5) * s * 0.08, ll, ll * 0.75, rnd() * Math.PI, pick(rnd, [70, 120, 50], [110, 150, 70], 1, 10), rgba(60, 90, 40, 0.5), true);
    }
    if (p.t > 0.9 && rnd() < 0.8) {
      // A mophead gone antique for September: dusty rose, lilac and green.
      const cx = p.x;
      const cy = p.y - s * 0.03;
      const R = s * (0.1 + rnd() * 0.04);
      const a = [190, 140, 150];
      const b = rnd() < 0.5 ? [160, 150, 190] : [170, 175, 130];
      for (let f = 0; f < 110; f++) {
        const r = Math.sqrt(rnd()) * R;
        const ang = rnd() * Math.PI * 2;
        g.fillStyle = pick(rnd, a, b, 1, 16);
        g.beginPath();
        g.arc(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, s * 0.012, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
}

function drawLaurel(g: Ctx, ox: number, oy: number, s: number, rnd: () => number) {
  // A hedge segment: leaves edge to edge, bigger and glossier than anything native.
  for (let i = 0; i < 90; i++) {
    const x = ox + rnd() * s;
    const y = oy + s * 0.04 + rnd() * s * 0.94;
    const ll = s * (0.16 + rnd() * 0.06);
    ovalLeaf(g, x, y, ll, ll * 0.5, rnd() * Math.PI, pick(rnd, [50, 100, 40], [95, 150, 55], 1, 12), rgba(170, 210, 140, 0.6));
  }
}

function drawArborvitae(g: Ctx, ox: number, oy: number, s: number, rnd: () => number) {
  // A sheared column: dense flat sprays, yellow-green, narrowing to a point.
  const bx = ox + s * 0.5;
  for (let y = oy + s * 0.04; y < oy + s * 0.98; y += s * 0.012) {
    const t = (y - oy) / s;
    const half = s * 0.5 * Math.min(1, t * 2.2 + 0.05) * 0.92;
    for (let k = 0; k < 34; k++) {
      const x = bx + (rnd() - 0.5) * 2 * half;
      const edge = Math.abs(x - bx) / half;
      if (rnd() < edge * edge * 0.6) continue;
      const col = pick(rnd, [80, 120, 45], [140, 170, 70], 0.95, 12);
      needle(g, x, y, (rnd() - 0.5) * 0.8 - Math.PI / 2 + (x > bx ? 0.6 : -0.6), s * 0.03, s * 0.006, col);
    }
  }
}

function drawGrassTuft(g: Ctx, ox: number, oy: number, s: number, rnd: () => number) {
  const bx = ox + s * 0.5;
  const by = oy + s * 0.98;
  g.lineCap = "round";
  for (let i = 0; i < 70; i++) {
    const a = -Math.PI / 2 + (rnd() - 0.5) * 1.6;
    const len = s * (0.3 + rnd() * 0.55);
    const col = rnd() < 0.3 ? pick(rnd, [150, 140, 80], [190, 170, 100], 0.95, 10) : pick(rnd, [80, 120, 50], [120, 150, 70], 0.95, 10);
    g.strokeStyle = col;
    g.lineWidth = s * 0.006;
    g.beginPath();
    g.moveTo(bx + (rnd() - 0.5) * s * 0.2, by);
    const bend = (a < -Math.PI / 2 ? -1 : 1) * 0.5;
    g.quadraticCurveTo(bx + Math.cos(a) * len * 0.6, by + Math.sin(a) * len * 0.6, bx + Math.cos(a + bend) * len, by + Math.sin(a + bend) * len);
    g.stroke();
  }
}


/** Run a cell painter clipped to its cell, so nothing bleeds into the neighbour. */
function inCell(g: Ctx, ox: number, oy: number, w: number, h: number, paint: () => void) {
  g.save();
  g.beginPath();
  g.rect(ox, oy, w, h);
  g.clip();
  paint();
  g.restore();
}

export interface Atlas {
  tex: THREE.CanvasTexture;
  cols: number;
  rows: number;
}

/** Cell index -> uv offset and scale for a `cols` x `rows` atlas (row 0 at the top of the canvas). */
export function atlasCell(a: Atlas, i: number): { u: number; v: number; su: number; sv: number } {
  const col = i % a.cols;
  const row = Math.floor(i / a.cols);
  return { u: col / a.cols, v: 1 - (row + 1) / a.rows, su: 1 / a.cols, sv: 1 / a.rows };
}

/** Conifer sprays: fir A, fir B (with cones), fir C, cedar A, cedar B, cedar C. Three columns by two rows. */
export const CONIFER = { firA: 0, firB: 1, firC: 2, cedarA: 3, cedarB: 4, cedarC: 5 };
export function coniferAtlas(): Atlas {
  const cell = 512;
  const cols = 3;
  const rows = 2;
  const [c, g] = canvas(cell * cols, cell * rows);
  g.clearRect(0, 0, c.width, c.height);
  inCell(g, 0, 0, cell, cell, () => drawFirSpray(g, 0, 0, cell, mulberry32(9101), false));
  inCell(g, cell, 0, cell, cell, () => drawFirSpray(g, cell, 0, cell, mulberry32(9102), true));
  inCell(g, cell * 2, 0, cell, cell, () => drawFirSpray(g, cell * 2, 0, cell, mulberry32(9103), false));
  inCell(g, 0, cell, cell, cell, () => drawCedarSpray(g, 0, cell, cell, mulberry32(9201)));
  inCell(g, cell, cell, cell, cell, () => drawCedarSpray(g, cell, cell, cell, mulberry32(9202)));
  inCell(g, cell * 2, cell, cell, cell, () => drawCedarSpray(g, cell * 2, cell, cell, mulberry32(9203)));
  return { tex: cardTex(c), cols, rows };
}

/** Broadleaf clusters: maple A, maple B, alder, madrona, Japanese maple, apple, rhododendron, hydrangea. Four by two. */
export const BROADLEAF = { mapleA: 0, mapleB: 1, alder: 2, madrona: 3, jmaple: 4, apple: 5, rhodo: 6, hydrangea: 7 };
export function broadleafAtlas(): Atlas {
  const cell = 512;
  const cols = 4;
  const rows = 2;
  const [c, g] = canvas(cell * cols, cell * rows);
  g.clearRect(0, 0, c.width, c.height);
  inCell(g, 0, 0, cell, cell, () => drawMapleCluster(g, 0, 0, cell, mulberry32(9301)));
  inCell(g, cell, 0, cell, cell, () => drawMapleCluster(g, cell, 0, cell, mulberry32(9302)));
  inCell(g, cell * 2, 0, cell, cell, () => drawAlderCluster(g, cell * 2, 0, cell, mulberry32(9303)));
  inCell(g, cell * 3, 0, cell, cell, () => drawMadronaCluster(g, cell * 3, 0, cell, mulberry32(9304)));
  inCell(g, 0, cell, cell, cell, () => drawJapaneseMaple(g, 0, cell, cell, mulberry32(9305)));
  inCell(g, cell, cell, cell, cell, () => drawAppleCluster(g, cell, cell, cell, mulberry32(9306)));
  inCell(g, cell * 2, cell, cell, cell, () => drawRhodo(g, cell * 2, cell, cell, mulberry32(9307)));
  inCell(g, cell * 3, cell, cell, cell, () => drawHydrangea(g, cell * 3, cell, cell, mulberry32(9308)));
  return { tex: cardTex(c), cols, rows };
}

/** Understory: fern A, fern B, salal, Oregon grape, huckleberry, blackberry, nettle, grass, laurel, arborvitae. Five by two. */
export const UNDER = { fernA: 0, fernB: 1, salal: 2, oregonGrape: 3, huckleberry: 4, blackberry: 5, nettle: 6, grass: 7, laurel: 8, arborvitae: 9 };
export function understoryAtlas(): Atlas {
  const cell = 384;
  const cols = 5;
  const rows = 2;
  const [c, g] = canvas(cell * cols, cell * rows);
  g.clearRect(0, 0, c.width, c.height);
  inCell(g, 0, 0, cell, cell, () => drawFern(g, 0, 0, cell, mulberry32(9401)));
  inCell(g, cell, 0, cell, cell, () => drawFern(g, cell, 0, cell, mulberry32(9402)));
  inCell(g, cell * 2, 0, cell, cell, () => drawSalal(g, cell * 2, 0, cell, mulberry32(9403)));
  inCell(g, cell * 3, 0, cell, cell, () => drawOregonGrape(g, cell * 3, 0, cell, mulberry32(9404)));
  inCell(g, cell * 4, 0, cell, cell, () => drawHuckleberry(g, cell * 4, 0, cell, mulberry32(9405)));
  inCell(g, 0, cell, cell, cell, () => drawBlackberry(g, 0, cell, cell, mulberry32(9406)));
  inCell(g, cell, cell, cell, cell, () => drawNettle(g, cell, cell, cell, mulberry32(9407)));
  inCell(g, cell * 2, cell, cell, cell, () => drawGrassTuft(g, cell * 2, cell, cell, mulberry32(9408)));
  inCell(g, cell * 3, cell, cell, cell, () => drawLaurel(g, cell * 3, cell, cell, mulberry32(9409)));
  inCell(g, cell * 4, cell, cell, cell, () => drawArborvitae(g, cell * 4, cell, cell, mulberry32(9410)));
  return { tex: cardTex(c), cols, rows };
}

/**
 * Whole trees for the far distance, drawn as a profile filled with scribbled
 * foliage so the edge is ragged: fir (two), cedar (two), maple, alder,
 * madrona and a small round orchard tree. Eight columns, each twice as tall
 * as it is wide.
 */
export const IMPOSTOR = { firA: 0, firB: 1, cedarA: 2, cedarB: 3, maple: 4, alder: 5, madrona: 6, small: 7 };
export function impostorAtlas(): Atlas {
  const w = 192;
  const h = 384;
  const cols = 8;
  const [c, g] = canvas(w * cols, h);
  g.clearRect(0, 0, c.width, h);
  const fill = (col: number, profile: (t: number) => number, trunkTop: number, trunkCol: string, trunkW: number, colA: number[], colB: number[], stroke: number, density: number, rnd: () => number, lean = 0) => {
    const ox = col * w;
    const cx = ox + w / 2;
    // Trunk from the ground up to where the crown takes over.
    g.strokeStyle = trunkCol;
    g.lineWidth = trunkW;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(cx, h - 2);
    g.lineTo(cx + lean * h, h * (1 - trunkTop));
    g.stroke();
    for (let y = 2; y < h; y += 1.5) {
      const t = 1 - y / h;
      const half = profile(t) * w * 0.5;
      if (half <= 0) continue;
      const shade = 0.55 + 0.45 * t;
      for (let k = 0; k < density; k++) {
        const u = (rnd() * 2 - 1);
        const x = cx + lean * h * t + u * half;
        // Thin toward the edge so the silhouette is ragged rather than cut.
        if (rnd() < Math.abs(u) ** 4 * 0.8) continue;
        const cc = rnd() < 0.5 ? colA : colB;
        const side = 0.85 + 0.3 * (0.5 - u * 0.5);
        g.strokeStyle = rgba(cc[0] * shade * side, cc[1] * shade * side, cc[2] * shade * side, 0.9 + rnd() * 0.1);
        g.lineWidth = 1.6;
        const ang = u > 0 ? 0.35 : Math.PI - 0.35;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(ang) * stroke * (0.5 + rnd()), y + Math.sin(ang) * stroke * 0.5);
        g.stroke();
      }
    }
  };
  // Douglas fir: bare trunk for the lower third, a crown that is widest just above that and ragged at the top.
  const firProfile = (rnd: () => number) => (t: number) => (t < 0.33 ? 0 : (0.75 * Math.pow((1 - t) / 0.67, 0.7) * (0.78 + 0.22 * Math.sin(t * 40 + rnd() * 6)) + (t > 0.95 ? -0.15 : 0)) * 0.95);
  fill(0, firProfile(mulberry32(11)), 0.98, "#4a3a30", 7, [46, 78, 46], [62, 96, 52], 18, 16, mulberry32(21));
  fill(1, firProfile(mulberry32(12)), 0.98, "#4a3a30", 7, [42, 74, 44], [70, 104, 56], 18, 16, mulberry32(22));
  // Cedar: conical from near the ground, wider, softer and yellower.
  const cedarProfile = (rnd: () => number) => (t: number) => (t < 0.08 ? 0 : Math.pow(1 - t, 1.15) * (0.85 + 0.15 * Math.sin(t * 30 + rnd() * 6)));
  fill(2, cedarProfile(mulberry32(13)), 0.98, "#5a4436", 8, [66, 104, 46], [96, 134, 60], 20, 18, mulberry32(23));
  fill(3, cedarProfile(mulberry32(14)), 0.98, "#5a4436", 8, [60, 98, 44], [104, 140, 64], 20, 18, mulberry32(24));
  // Big-leaf maple: a broad dome on a short trunk.
  fill(4, (t) => (t < 0.2 ? 0 : Math.sin(Math.min(1, (t - 0.2) / 0.8) * Math.PI) * 0.6 + 0.4 * Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.6) / 0.4, 2)))), 0.45, "#5a5046", 10, [90, 132, 54], [130, 165, 70], 14, 18, mulberry32(25));
  // Alder: tall and thin, a narrow crown high up on a pale trunk.
  fill(5, (t) => (t < 0.4 ? 0 : 0.5 * Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.72) / 0.32, 2)))), 0.75, "#9a9a90", 5, [72, 114, 50], [104, 144, 64], 10, 12, mulberry32(26));
  // Madrona: leaning, with dark rounded clumps and a red trunk.
  fill(6, (t) => (t < 0.35 ? 0 : 0.7 * Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.7) / 0.32, 2)))), 0.6, "#8a4426", 6, [40, 76, 40], [66, 106, 54], 12, 16, mulberry32(27), 0.06);
  // A small orchard or garden tree.
  fill(7, (t) => (t < 0.3 ? 0 : 0.9 * Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.65) / 0.36, 2)))), 0.4, "#5a4a3a", 8, [80, 120, 50], [116, 152, 66], 12, 18, mulberry32(28));
  return { tex: cardTex(c), cols, rows: 1 };
}

/**
 * What lies under a stand: needle duff with cones and twigs under the firs,
 * a moss and cedar-litter carpet under the cedars. Two cells, each a disc
 * that feathers out to nothing at the edge so it lies on any ground.
 */
export function duffAtlas(): Atlas {
  const cell = 512;
  const [c, g] = canvas(cell * 2, cell);
  g.clearRect(0, 0, c.width, cell);
  const disc = (ox: number, rnd: () => number, base: number[], litterA: number[], litterB: number[], mossy: boolean) => {
    const cx = ox + cell / 2;
    const cy = cell / 2;
    const R = cell * 0.48;
    for (let i = 0; i < 2400; i++) {
      const r = Math.sqrt(rnd()) * R;
      const a = rnd() * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      const edge = r / R;
      const alpha = edge < 0.6 ? 1 : Math.max(0, 1 - (edge - 0.6) / 0.4 - rnd() * 0.3);
      if (alpha <= 0) continue;
      g.fillStyle = pick(rnd, base, litterA, alpha * 0.9, 10);
      g.beginPath();
      g.ellipse(x, y, 6 + rnd() * 16, 5 + rnd() * 12, rnd() * 3, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < 3000; i++) {
      const r = Math.sqrt(rnd()) * R * 0.95;
      const a = rnd() * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      const edge = r / R;
      const alpha = edge < 0.65 ? 1 : Math.max(0, 1 - (edge - 0.65) / 0.35);
      if (rnd() > alpha) continue;
      if (mossy) {
        g.fillStyle = pick(rnd, litterA, litterB, 0.85, 14);
        g.beginPath();
        g.arc(x, y, 1.5 + rnd() * 3, 0, Math.PI * 2);
        g.fill();
      } else {
        needle(g, x, y, rnd() * Math.PI * 2, 5 + rnd() * 9, 1.2, pick(rnd, litterA, litterB, 0.9, 14));
      }
    }
    // Twigs and cones.
    for (let i = 0; i < 40; i++) {
      const r = Math.sqrt(rnd()) * R * 0.8;
      const a = rnd() * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (rnd() < 0.5) needle(g, x, y, rnd() * Math.PI * 2, 12 + rnd() * 30, 2.2, rgba(60, 46, 34, 0.95));
      else {
        g.fillStyle = mossy ? "#5a4a3a" : "#6b4a2c";
        g.beginPath();
        g.ellipse(x, y, 4, 8, rnd() * 3, 0, Math.PI * 2);
        g.fill();
      }
    }
  };
  disc(0, mulberry32(9501), [56, 44, 36], [104, 76, 50], [82, 58, 40], false);
  disc(cell, mulberry32(9502), [50, 48, 34], [78, 110, 44], [110, 140, 60], true);
  const t = cardTex(c);
  return { tex: t, cols: 2, rows: 1 };
}
