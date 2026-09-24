/**
 * Surfaces, painted once in a canvas and shared.
 *
 * Nothing here is downloaded: every texture is drawn at startup from noise
 * and a few strokes, which is a few milliseconds and no bytes over the
 * wire. Each comes with a bump map drawn from the same strokes, so the
 * light catches grain, straw and tile edges without a normal map.
 *
 * Texture scale is in metres: `TILE[name]` is how many metres one repeat
 * covers, and `boxUV()` rewrites a box's UVs so a wall three metres wide
 * shows three metres of planks instead of one stretched plank.
 */
import * as THREE from "three";

export type SurfaceName = "plaster" | "boards" | "timber" | "thatch" | "tiles" | "stone" | "shoji" | "straw";

/** Metres covered by one repeat of each texture. */
export const TILE: Record<SurfaceName, number> = {
  plaster: 2,
  boards: 1.2,
  timber: 1.5,
  thatch: 2.5,
  tiles: 1.6,
  stone: 1.4,
  shoji: 1.2,
  straw: 1,
};

function rand(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function canvas(size = 256): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return [c, c.getContext("2d")!];
}

function speckle(ctx: CanvasRenderingContext2D, size: number, n: number, alpha: number, r: () => number, light = false) {
  for (let i = 0; i < n; i++) {
    const v = light ? 255 : 0;
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha * r()})`;
    const s = 1 + r() * 2;
    ctx.fillRect(r() * size, r() * size, s, s);
  }
}

type Painter = (ctx: CanvasRenderingContext2D, bump: CanvasRenderingContext2D, size: number, r: () => number) => void;

const PAINTERS: Record<SurfaceName, Painter> = {
  plaster(ctx, bump, n, r) {
    ctx.fillStyle = "#e9e3d3"; ctx.fillRect(0, 0, n, n);
    bump.fillStyle = "#808080"; bump.fillRect(0, 0, n, n);
    // Soft trowel clouds and a little grime toward the bottom.
    for (let i = 0; i < 60; i++) {
      const x = r() * n, y = r() * n, rad = 10 + r() * 40;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      const t = r() < 0.5 ? "rgba(200,190,170,0.12)" : "rgba(255,252,244,0.14)";
      g.addColorStop(0, t); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    const grime = ctx.createLinearGradient(0, n * 0.6, 0, n);
    grime.addColorStop(0, "rgba(90,80,60,0)"); grime.addColorStop(1, "rgba(90,80,60,0.12)");
    ctx.fillStyle = grime; ctx.fillRect(0, 0, n, n);
    speckle(ctx, n, 900, 0.08, r);
    speckle(bump, n, 1400, 0.25, r);
  },
  boards(ctx, bump, n, r) {
    // Vertical weathered cedar boards, charred dark as in yakisugi.
    const w = n / 8;
    for (let i = 0; i < 8; i++) {
      const tone = 34 + r() * 22;
      ctx.fillStyle = `rgb(${tone + 8},${tone},${tone - 6})`;
      ctx.fillRect(i * w, 0, w, n);
      bump.fillStyle = "#909090"; bump.fillRect(i * w, 0, w, n);
      for (let k = 0; k < 18; k++) {
        const x = i * w + r() * w;
        ctx.strokeStyle = `rgba(${r() < 0.5 ? "0,0,0" : "120,105,85"},${0.12 + r() * 0.15})`;
        ctx.lineWidth = 0.6 + r();
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.bezierCurveTo(x + (r() - 0.5) * 6, n / 3, x + (r() - 0.5) * 6, (2 * n) / 3, x + (r() - 0.5) * 4, n); ctx.stroke();
      }
      ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(i * w, 0, 1.5, n);
      bump.fillStyle = "#303030"; bump.fillRect(i * w, 0, 2, n);
    }
  },
  timber(ctx, bump, n, r) {
    ctx.fillStyle = "#4a3322"; ctx.fillRect(0, 0, n, n);
    bump.fillStyle = "#808080"; bump.fillRect(0, 0, n, n);
    for (let k = 0; k < 70; k++) {
      const y = r() * n;
      ctx.strokeStyle = `rgba(${r() < 0.6 ? "20,12,6" : "110,80,52"},${0.15 + r() * 0.2})`;
      ctx.lineWidth = 0.5 + r() * 1.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.bezierCurveTo(n / 3, y + (r() - 0.5) * 8, (2 * n) / 3, y + (r() - 0.5) * 8, n, y + (r() - 0.5) * 5); ctx.stroke();
      bump.strokeStyle = `rgba(0,0,0,${0.2 + r() * 0.2})`; bump.lineWidth = 1;
      bump.beginPath(); bump.moveTo(0, y); bump.lineTo(n, y + (r() - 0.5) * 6); bump.stroke();
    }
  },
  thatch(ctx, bump, n, r) {
    // Layers of straw bundles, laid in courses, sun-bleached on top.
    ctx.fillStyle = "#8c7447"; ctx.fillRect(0, 0, n, n);
    bump.fillStyle = "#606060"; bump.fillRect(0, 0, n, n);
    const courses = 6;
    for (let c = 0; c < courses; c++) {
      const y0 = (c / courses) * n;
      for (let k = 0; k < 520; k++) {
        const x = r() * n;
        const len = 10 + r() * 26;
        const y = y0 + r() * (n / courses);
        const l = 90 + r() * 70;
        ctx.strokeStyle = `rgba(${l + 40},${l + 20},${l - 30},${0.35 + r() * 0.4})`;
        ctx.lineWidth = 0.7 + r() * 0.9;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (r() - 0.5) * 3, y + len); ctx.stroke();
        bump.strokeStyle = `rgba(255,255,255,${0.12 + r() * 0.15})`; bump.lineWidth = 1;
        bump.beginPath(); bump.moveTo(x, y); bump.lineTo(x, y + len); bump.stroke();
      }
      ctx.fillStyle = "rgba(30,20,10,0.35)"; ctx.fillRect(0, y0 + n / courses - 3, n, 3);
      bump.fillStyle = "rgba(0,0,0,0.6)"; bump.fillRect(0, y0 + n / courses - 3, n, 3);
    }
    speckle(ctx, n, 400, 0.12, r);
  },
  tiles(ctx, bump, n, r) {
    // Kawara: rows of dark grey-blue fired clay, round-topped channels.
    ctx.fillStyle = "#3c434c"; ctx.fillRect(0, 0, n, n);
    const cols = 8, rows = 6;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = (col / cols) * n, y = (row / rows) * n, w = n / cols, h = n / rows;
        const tone = 50 + r() * 18;
        const g = ctx.createLinearGradient(x, 0, x + w, 0);
        g.addColorStop(0, `rgb(${tone - 18},${tone - 12},${tone - 6})`);
        g.addColorStop(0.5, `rgb(${tone + 10},${tone + 14},${tone + 20})`);
        g.addColorStop(1, `rgb(${tone - 18},${tone - 12},${tone - 6})`);
        ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
        const bg = bump.createLinearGradient(x, 0, x + w, 0);
        bg.addColorStop(0, "#202020"); bg.addColorStop(0.5, "#e0e0e0"); bg.addColorStop(1, "#202020");
        bump.fillStyle = bg; bump.fillRect(x, y, w, h);
        ctx.fillStyle = "rgba(0,0,0,0.45)"; ctx.fillRect(x, y + h - 3, w, 3);
        bump.fillStyle = "#000"; bump.fillRect(x, y + h - 3, w, 3);
      }
    }
    speckle(ctx, n, 500, 0.15, r, true);
  },
  stone(ctx, bump, n, r) {
    ctx.fillStyle = "#6f6b62"; ctx.fillRect(0, 0, n, n);
    bump.fillStyle = "#101010"; bump.fillRect(0, 0, n, n);
    // Irregular laid stones with dark mortar.
    for (let i = 0; i < 26; i++) {
      const x = r() * n, y = r() * n, rw = 18 + r() * 36, rh = 14 + r() * 24;
      const tone = 90 + r() * 50;
      ctx.fillStyle = `rgb(${tone},${tone - 4},${tone - 12})`;
      ctx.beginPath(); ctx.ellipse(x, y, rw, rh, r() * Math.PI, 0, Math.PI * 2); ctx.fill();
      bump.fillStyle = `rgb(${150 + r() * 80},${150 + r() * 80},${150 + r() * 80})`;
      bump.beginPath(); bump.ellipse(x, y, rw - 2, rh - 2, 0, 0, Math.PI * 2); bump.fill();
    }
    speckle(ctx, n, 1200, 0.2, r);
    // Moss in the lower third.
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(80,110,50,${0.1 + r() * 0.15})`;
      ctx.beginPath(); ctx.arc(r() * n, n * (0.6 + r() * 0.4), 4 + r() * 10, 0, Math.PI * 2); ctx.fill();
    }
  },
  shoji(ctx, bump, n, r) {
    // Paper in a wooden grid: the one surface that glows at night.
    ctx.fillStyle = "#f4ecd8"; ctx.fillRect(0, 0, n, n);
    bump.fillStyle = "#808080"; bump.fillRect(0, 0, n, n);
    speckle(ctx, n, 500, 0.05, r);
    ctx.fillStyle = "#5a3f28";
    bump.fillStyle = "#e0e0e0";
    const bars = 4, rows = 6;
    for (let i = 0; i <= bars; i++) { const x = (i / bars) * n - 3; ctx.fillRect(x, 0, 6, n); bump.fillRect(x, 0, 6, n); }
    for (let j = 0; j <= rows; j++) { const y = (j / rows) * n - 2; ctx.fillRect(0, y, n, 4); bump.fillRect(0, y, n, 4); }
  },
  straw(ctx, bump, n, r) {
    ctx.fillStyle = "#b99a5a"; ctx.fillRect(0, 0, n, n);
    bump.fillStyle = "#808080"; bump.fillRect(0, 0, n, n);
    for (let k = 0; k < 900; k++) {
      const x = r() * n, y = r() * n, l = 150 + r() * 60;
      ctx.strokeStyle = `rgba(${l},${l - 25},${l - 90},0.5)`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 8, y + (r() - 0.5) * 3); ctx.stroke();
    }
  },
};

export interface Surface {
  map: THREE.CanvasTexture;
  bump: THREE.CanvasTexture;
}

const cache = new Map<SurfaceName, Surface>();

export function surface(name: SurfaceName): Surface {
  const hit = cache.get(name);
  if (hit) return hit;
  const size = name === "thatch" || name === "tiles" ? 256 : 256;
  const [c, ctx] = canvas(size);
  const [b, bctx] = canvas(size);
  PAINTERS[name](ctx, bctx, size, rand(name.length * 7919 + name.charCodeAt(0)));
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 4;
  const bump = new THREE.CanvasTexture(b);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  const s = { map, bump };
  cache.set(name, s);
  return s;
}

/** A material on a shared surface. Callers own the material, not the textures. */
export function surfaceMaterial(name: SurfaceName, opts: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const s = surface(name);
  return new THREE.MeshStandardMaterial({ map: s.map, bumpMap: s.bump, bumpScale: 0.6, roughness: 0.88, metalness: 0, ...opts });
}

/**
 * Rewrite a BoxGeometry's UVs so each face is textured by its size in
 * metres divided by `tile`: faces are +x, -x, +y, -y, +z, -z, four vertices
 * each, in three's order.
 */
export function boxUV(geo: THREE.BufferGeometry, w: number, h: number, d: number, tile: number): THREE.BufferGeometry {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const dims: Array<[number, number]> = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [a, b] = dims[f];
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * (a / tile), uv.getY(i) * (b / tile));
    }
  }
  uv.needsUpdate = true;
  return geo;
}

export function disposeSurfaces(): void {
  for (const s of cache.values()) { s.map.dispose(); s.bump.dispose(); }
  cache.clear();
}
