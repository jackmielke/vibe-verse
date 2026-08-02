/**
 * Vibe Kart — the particle sprite foundry.
 *
 * Every particle in the game samples one 4×4 atlas. That is not a stylistic
 * choice, it is the reason the whole VFX layer is two draw calls: a batch can
 * only be a single InstancedMesh if every particle in it shares a material, and
 * a material can only have one map. So sixteen sprites go on one page and the
 * per-particle tile index picks the cell.
 *
 * Two rules the bakers all obey, and which you must keep if you add a tile:
 *
 * 1. **RGB is shading, alpha is shape.** The particle shader multiplies the
 *    per-particle colour by `texture.rgb`, so a sprite that bakes its colour in
 *    can never be tinted. Sprites are white with only the internal shading
 *    (a confetti fold, a debris bevel) written into RGB.
 *
 * 2. **Content stops at 88% of the cell.** Mipmapping an atlas bleeds
 *    neighbouring cells into each other at distance; a transparent margin plus
 *    the half-texel UV inset in the shader is what keeps a smoke puff from
 *    growing a faint square of confetti around it two hundred metres out.
 *
 * The atlas is baked once at boot (~15 ms at 1024²) and shared by every batch.
 */
import * as THREE from "three";
import type { KartQuality } from "../types";

/** Cell index of every sprite. Mirrored as `TILE_*` constants in the shader. */
export const TILE = {
  /** Soft radial glow — the workhorse core for anything additive. */
  glow: 0,
  /** Hot pinpoint with a faint cross flare — sparks, embers. */
  spark: 1,
  /** Billowing turbulent puff — tyre smoke, explosion smoke. */
  smoke: 2,
  /** Coarser, lobed puff with grit — dirt and sand plumes. */
  dust: 3,
  /** A torn grass blade. */
  blade: 4,
  /** A scatter of grains — sand, gravel. */
  grain: 5,
  /** Water droplet with a bright rim. */
  drop: 6,
  /** Four-point star flare — coins, star power, item boxes. */
  sparkle: 7,
  /** Irregular chipped solid — debris, item-box shards. */
  shard: 8,
  /** Rounded rectangle with a fold — confetti. */
  confetti: 9,
  /** Soft annulus — ripples and small rings drawn as particles. */
  ring: 10,
  /** Eroded flame tongue, hottest at the base. */
  flame: 11,
  /** Tiny twinkling ember. */
  ember: 12,
  /** Splash crown — the moment a wheel breaks the surface. */
  crown: 13,
  /** Torn streaky wisp — contrails, wind streaks, dissipating smoke. */
  wisp: 14,
  /** Hexagonal energy shard — anti-grav and metal contact. */
  hex: 15,
} as const;

export type TileName = keyof typeof TILE;

export interface ParticleAtlas {
  texture: THREE.Texture;
  /** Cells per row/column. */
  grid: number;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Canvas kit
// ---------------------------------------------------------------------------

type Ctx2D = CanvasRenderingContext2D;

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: Ctx2D } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  // willReadFrequently: every baker below ends in a getImageData pass, and
  // without the hint Chrome keeps the surface GPU-side and stalls on each read.
  const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: true });
  if (!ctx) throw new Error("[kart/fx] 2D context unavailable");
  return { canvas, ctx };
}

/** Cheap deterministic hash noise — no lattice, these are 256² sprites. */
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695040) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise built on hash2, good enough for sprite erosion. */
function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(x * f, y * f, seed + o * 97) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.06;
  }
  return sum / norm;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

/**
 * Per-pixel baker. `fn` returns RGBA in 0..1 for a point in the cell's own
 * -1..1 space, which is how every sprite below is authored — radially, with the
 * origin at the middle, so the maths reads like the shape it draws.
 */
function bakeCell(
  ctx: Ctx2D,
  ox: number,
  oy: number,
  size: number,
  fn: (nx: number, ny: number, r: number, ang: number) => void,
  out: Float32Array,
): void {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let py = 0; py < size; py++) {
    const ny = ((py + 0.5) / size) * 2 - 1;
    for (let px = 0; px < size; px++) {
      const nx = ((px + 0.5) / size) * 2 - 1;
      out[0] = out[1] = out[2] = 1;
      out[3] = 0;
      fn(nx, ny, Math.sqrt(nx * nx + ny * ny), Math.atan2(ny, nx));
      const i = (py * size + px) * 4;
      // Premultiplication is deliberately NOT done here: the shader multiplies
      // alpha itself so an additive batch and an alpha batch can share a page.
      d[i] = clamp01(out[0]) * 255;
      d[i + 1] = clamp01(out[1]) * 255;
      d[i + 2] = clamp01(out[2]) * 255;
      d[i + 3] = clamp01(out[3]) * 255;
    }
  }
  ctx.putImageData(img, ox, oy);
}

// ---------------------------------------------------------------------------
// The sprites
// ---------------------------------------------------------------------------

/**
 * Every baker writes into a shared 4-float scratch — `o[0..2]` shading,
 * `o[3]` coverage. The margin factor `M` is the 88% content rule.
 */
const M = 0.88;

type Baker = (o: Float32Array, nx: number, ny: number, r: number, ang: number) => void;

const bakeGlow: Baker = (o, _nx, _ny, r) => {
  // A gaussian, not a linear ramp: a linear falloff has a visible circular
  // edge the moment two of them overlap, which is exactly what a glow must not.
  const t = clamp01(r / M);
  o[3] = Math.exp(-t * t * 5.2) * (1 - smoothstep(0.86, 1, t));
};

const bakeSpark: Baker = (o, nx, ny, r) => {
  const t = clamp01(r / M);
  const core = Math.exp(-t * t * 46) * 1.0;
  const halo = Math.exp(-t * t * 7.5) * 0.42;
  // A four-point flare sold at low intensity: it is what makes a spark read as
  // *hot* rather than as a small dot, and it survives being stretched.
  const ax = Math.exp(-(ny * ny) * 640) * Math.exp(-Math.abs(nx) * 4.2) * 0.5;
  const ay = Math.exp(-(nx * nx) * 640) * Math.exp(-Math.abs(ny) * 4.2) * 0.5;
  o[3] = clamp01(core + halo + ax + ay) * (1 - smoothstep(0.9, 1, t));
};

const bakeSmoke: Baker = (o, nx, ny, r) => {
  // Two fbm layers at different scales: the coarse one carves the silhouette
  // into lobes, the fine one gives the interior something to catch light on.
  const coarse = fbm(nx * 2.1 + 8, ny * 2.1 + 3, 11, 4);
  const fine = fbm(nx * 6.4 - 2, ny * 6.4 + 9, 23, 3);
  const carve = (coarse - 0.5) * 0.46;
  const t = clamp01((r + carve) / M);
  const a = (1 - smoothstep(0.28, 1.0, t)) * (0.62 + fine * 0.38);
  o[3] = clamp01(a);
  // Self-shading. Smoke lit from one side is the difference between a puff and
  // a grey circle; the gradient is baked so the tint stays a single colour.
  const lit = 0.74 + 0.26 * clamp01(0.5 - nx * 0.5 - ny * 0.55 + fine * 0.3);
  o[0] = o[1] = o[2] = lit;
};

const bakeDust: Baker = (o, nx, ny, r) => {
  const coarse = fbm(nx * 1.55 - 4, ny * 1.55 + 7, 41, 3);
  const grit = fbm(nx * 14 + 1, ny * 14 - 6, 67, 2);
  const carve = (coarse - 0.5) * 0.62;
  const t = clamp01((r + carve) / M);
  // Dust is grittier and dies harder at the edge than smoke — it is heavier.
  const a = (1 - smoothstep(0.18, 0.96, t)) * (0.5 + grit * 0.5);
  o[3] = clamp01(a * 1.05);
  o[0] = o[1] = o[2] = 0.78 + 0.22 * clamp01(0.5 - ny * 0.7 + grit * 0.4);
};

const bakeBlade: Baker = (o, nx, ny) => {
  // A torn blade: a tapered lens bent by a quadratic, drawn in the cell's
  // vertical axis so per-particle rotation scatters them naturally.
  const y = clamp01((ny + M) / (2 * M));
  const bend = (1 - y) * (1 - y) * 0.34;
  const halfWidth = 0.145 * Math.sin(Math.PI * Math.pow(y, 0.62)) * M;
  const dx = Math.abs(nx - bend * M + 0.12);
  const edge = 1 - smoothstep(halfWidth * 0.55, halfWidth, dx);
  const tipCut = 1 - smoothstep(0.93, 1.0, y);
  o[3] = clamp01(edge * tipCut);
  // A darker spine and a lighter edge — one gradient, and the blade stops
  // reading as a green sticker.
  const spine = 1 - clamp01(dx / (halfWidth + 1e-4));
  o[0] = o[1] = o[2] = 0.66 + 0.34 * (1 - spine * 0.8) + y * 0.12;
};

const bakeGrain: Baker = (o, nx, ny) => {
  // Nine grains at fixed hashed positions: one sprite that already looks like
  // a handful of sand, so a sand plume needs a third of the particle count.
  let a = 0;
  let shade = 0;
  for (let i = 0; i < 9; i++) {
    const gx = (hash2(i, 3, 5) * 2 - 1) * 0.6 * M;
    const gy = (hash2(i, 7, 9) * 2 - 1) * 0.6 * M;
    const gr = 0.07 + hash2(i, 11, 13) * 0.11;
    const d = Math.sqrt((nx - gx) * (nx - gx) + (ny - gy) * (ny - gy));
    const g = 1 - smoothstep(gr * 0.45, gr, d);
    if (g > a) shade = 0.72 + hash2(i, 17, 19) * 0.28;
    a = Math.max(a, g);
  }
  o[3] = a;
  o[0] = o[1] = o[2] = shade || 1;
};

const bakeDrop: Baker = (o, nx, ny) => {
  // Teardrop: a circle whose radius shrinks as it climbs, plus a specular
  // pip. Water without a highlight is a grey blob at any resolution.
  const y = (ny + M) / (2 * M);
  const w = 0.42 * M * Math.pow(clamp01(1 - y * 0.95), 0.42);
  const cy = -M + y * 2 * M;
  const d = Math.sqrt(nx * nx + (ny - cy) * (ny - cy));
  void d;
  const body = 1 - smoothstep(w * 0.72, w, Math.abs(nx));
  const cap = 1 - smoothstep(0.82, 1.0, y);
  const base = 1 - smoothstep(0.94, 1.0, 1 - y);
  const a = body * cap * base;
  o[3] = clamp01(a);
  const rim = smoothstep(w * 0.4, w, Math.abs(nx)) * 0.5;
  const spec = Math.exp(-((nx + 0.16) * (nx + 0.16) + (ny + 0.3) * (ny + 0.3)) * 60) * 0.9;
  o[0] = o[1] = o[2] = clamp01(0.6 + rim + spec);
};

const bakeSparkle: Baker = (o, nx, ny, r) => {
  // The classic four-point flare. The spikes are `exp(-x²)` ridges rather than
  // drawn lines so they stay soft at every mip level.
  const t = clamp01(r / M);
  const sx = Math.exp(-(ny * ny) * 300) * Math.exp(-Math.abs(nx) * 2.6);
  const sy = Math.exp(-(nx * nx) * 300) * Math.exp(-Math.abs(ny) * 2.6);
  const dx = (nx + ny) * 0.7071;
  const dy = (nx - ny) * 0.7071;
  const dgA = Math.exp(-(dy * dy) * 900) * Math.exp(-Math.abs(dx) * 5.5) * 0.4;
  const dgB = Math.exp(-(dx * dx) * 900) * Math.exp(-Math.abs(dy) * 5.5) * 0.4;
  const core = Math.exp(-t * t * 62);
  o[3] = clamp01(core + sx + sy + dgA + dgB) * (1 - smoothstep(0.88, 1, t));
};

const bakeShard: Baker = (o, nx, ny, r, ang) => {
  // An irregular convex chip: the radius is a low-frequency function of angle,
  // so every rotation of the sprite reads as a different piece of debris.
  const wob =
    0.62 +
    Math.sin(ang * 3 + 0.7) * 0.13 +
    Math.sin(ang * 5 - 1.9) * 0.09 +
    Math.sin(ang * 2 + 2.4) * 0.07;
  const edge = wob * M;
  o[3] = 1 - smoothstep(edge - 0.035, edge, r);
  // Bevel: bright on the upper-left face, dark on the lower-right. This is the
  // whole reason debris reads as solid rather than as a flat paper cutout.
  const facet = clamp01(0.5 - nx * 0.55 - ny * 0.6);
  const rim = smoothstep(edge - 0.16, edge, r);
  o[0] = o[1] = o[2] = clamp01(0.42 + facet * 0.72 + rim * 0.22);
};

const bakeConfetti: Baker = (o, nx, ny) => {
  const hx = 0.34 * M;
  const hy = 0.62 * M;
  const rx = 1 - smoothstep(hx - 0.05, hx, Math.abs(nx));
  const ry = 1 - smoothstep(hy - 0.05, hy, Math.abs(ny));
  o[3] = rx * ry;
  // A crease down the middle. Confetti tumbles, and a flat card catches no
  // light at all when it turns edge-on.
  const fold = 1 - Math.abs(nx) / hx;
  o[0] = o[1] = o[2] = clamp01(0.55 + fold * 0.62);
};

const bakeRing: Baker = (o, _nx, _ny, r) => {
  const t = clamp01(r / M);
  // Asymmetric annulus — sharp on the leading (outer) edge, soft inside, the
  // way an expanding pressure front actually reads. The band is deliberately
  // narrow: a wide one is a disc, and a disc reads as a decal, not a wave.
  const inner = smoothstep(0.74, 0.93, t);
  const outer = 1 - smoothstep(0.95, 1.0, t);
  // A faint inner haze so the front has something trailing it.
  const wake = smoothstep(0.35, 0.9, t) * 0.16;
  o[3] = clamp01(inner * outer + wake * outer);
};

const bakeFlame: Baker = (o, nx, ny) => {
  // Tongue shape: widest a third of the way up, pinched at the tip, eroded by
  // fbm so no two rotations of it look the same.
  const y = clamp01((ny + M) / (2 * M));
  const profile = Math.pow(Math.sin(Math.PI * Math.pow(1 - y, 0.72)), 0.85);
  const w = 0.5 * M * profile;
  const erode = (fbm(nx * 3.4 + 5, ny * 2.2 - 3 + y * 2.5, 83, 3) - 0.5) * 0.34;
  const a = 1 - smoothstep(w * 0.35, w + erode * 0.4, Math.abs(nx));
  const capBase = 1 - smoothstep(0.93, 1.0, 1 - y);
  const capTip = 1 - smoothstep(0.86, 1.0, y);
  o[3] = clamp01(a * capBase * capTip);
  // Hotter at the base and along the spine: the additive batch turns this into
  // a white-hot core with a coloured mantle for free.
  const spine = 1 - clamp01(Math.abs(nx) / (w + 1e-4));
  o[0] = o[1] = o[2] = clamp01(0.5 + spine * 0.9 * (1 - y) + (1 - y) * 0.4);
};

const bakeEmber: Baker = (o, nx, ny, r) => {
  const t = clamp01(r / M);
  const core = Math.exp(-t * t * 90);
  const halo = Math.exp(-t * t * 16) * 0.3;
  const twinkle = Math.exp(-(nx * nx) * 220) * 0.25 + Math.exp(-(ny * ny) * 220) * 0.25;
  o[3] = clamp01(core + halo + twinkle * Math.exp(-t * t * 6)) * (1 - smoothstep(0.86, 1, t));
};

const bakeCrown: Baker = (o, nx, ny) => {
  // A splash crown: a thin arc with droplet beads on top. Emitted once at the
  // contact point, it does the work five hundred droplets would.
  const y = (ny + M) / (2 * M);
  const arcR = 0.72 * M;
  const d = Math.sqrt(nx * nx + (ny - M * 0.55) * (ny - M * 0.55));
  const band = 1 - smoothstep(0.06, 0.17, Math.abs(d - arcR));
  const upper = 1 - smoothstep(0.42, 0.72, y);
  let beads = 0;
  for (let i = 0; i < 7; i++) {
    const a = Math.PI * (0.08 + (i / 6) * 0.84);
    const bx = -Math.cos(a) * arcR;
    const by = M * 0.55 - Math.sin(a) * arcR * (0.98 + hash2(i, 2, 4) * 0.16);
    const br = 0.07 + hash2(i, 5, 8) * 0.06;
    const bd = Math.sqrt((nx - bx) * (nx - bx) + (ny - by) * (ny - by));
    beads = Math.max(beads, 1 - smoothstep(br * 0.4, br, bd));
  }
  o[3] = clamp01(band * (1 - upper * 0.85) + beads);
  o[0] = o[1] = o[2] = 0.82 + beads * 0.18;
};

const bakeWisp: Baker = (o, nx, ny) => {
  // A horizontal torn streak. Stretched along velocity in the shader it makes
  // both the world-space wind streaks and the tail of dissipating smoke.
  const streak = fbm(nx * 1.4 + 12, ny * 5.5 - 4, 131, 3);
  const core = 1 - smoothstep(0.06, 0.42 * M, Math.abs(ny + (streak - 0.5) * 0.22));
  const taperL = smoothstep(-M, -M * 0.35, nx);
  const taperR = 1 - smoothstep(M * 0.35, M, nx);
  o[3] = clamp01(core * taperL * taperR * (0.55 + streak * 0.6));
  o[0] = o[1] = o[2] = 0.86 + streak * 0.14;
};

const bakeHex: Baker = (o, nx, ny, r) => {
  // Hex distance field: max of three axis projections. Drawn as a ring with a
  // faint fill, which is the visual language the anti-grav plating uses.
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const hexD = Math.max(ax * 0.866 + ay * 0.5, ay);
  const edge = 0.72 * M;
  const ring = 1 - smoothstep(0.055, 0.13, Math.abs(hexD - edge));
  const fill = (1 - smoothstep(edge * 0.2, edge, hexD)) * 0.22;
  o[3] = clamp01(ring + fill) * (1 - smoothstep(0.95, 1.05, r));
  o[0] = o[1] = o[2] = clamp01(0.75 + ring * 0.35);
};

const BAKERS: Baker[] = [
  bakeGlow,
  bakeSpark,
  bakeSmoke,
  bakeDust,
  bakeBlade,
  bakeGrain,
  bakeDrop,
  bakeSparkle,
  bakeShard,
  bakeConfetti,
  bakeRing,
  bakeFlame,
  bakeEmber,
  bakeCrown,
  bakeWisp,
  bakeHex,
];

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Cell resolution by quality — the atlas is 4× this on a side. */
function cellSize(quality: KartQuality): number {
  return quality === "low" ? 64 : quality === "medium" ? 128 : 256;
}

export function createParticleAtlas(quality: KartQuality, aniso: number): ParticleAtlas {
  const grid = 4;
  const cell = cellSize(quality);
  const { canvas, ctx } = makeCanvas(cell * grid);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const scratch = new Float32Array(4);
  for (let i = 0; i < BAKERS.length; i++) {
    const cx = (i % grid) * cell;
    const cy = Math.floor(i / grid) * cell;
    const baker = BAKERS[i];
    bakeCell(
      ctx,
      cx,
      cy,
      cell,
      (nx, ny, r, ang) => baker(scratch, nx, ny, r, ang),
      scratch,
    );
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = "kart/fx/atlas";
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = aniso;
  texture.needsUpdate = true;

  return {
    texture,
    grid,
    dispose() {
      texture.dispose();
      canvas.width = canvas.height = 1;
    },
  };
}

// ---------------------------------------------------------------------------
// Ancillary textures
// ---------------------------------------------------------------------------

/**
 * The skid-mark strip: a soft-edged band of tread grain that tiles along the
 * length of a trail. Baked separately from the atlas because it wraps in U and
 * the atlas cannot.
 */
export function createSkidTexture(quality: KartQuality): THREE.Texture {
  const w = quality === "low" ? 64 : 128;
  const h = 32;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("[kart/fx] 2D context unavailable");
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    // Across the tyre: full black in the middle, feathered at the shoulders.
    const v = (y + 0.5) / h;
    const across = 1 - smoothstep(0.3, 0.5, Math.abs(v - 0.5));
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      // Tread ribs plus grain. The ribs must wrap, hence the integer periods.
      const ribs = 0.88 + 0.12 * Math.abs(Math.sin(u * Math.PI * 6));
      const grain = 0.6 + 0.4 * hash2(x, y, 7);
      const streak = 0.7 + 0.3 * vnoise(u * 8, v * 3.1, 19);
      const a = clamp01(across * ribs * grain * streak);
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.name = "kart/fx/skid";
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The star-power gradient: a 1-D rainbow ramp with a white hot centre band,
 * scrolled along the trail's V so the ribbon shimmers rather than strobes.
 */
export function createRainbowTexture(): THREE.Texture {
  const w = 128;
  const h = 8;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("[kart/fx] 2D context unavailable");
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const col = new THREE.Color();
  for (let x = 0; x < w; x++) {
    const u = x / w;
    // Saturation pulled off 1.0 and lightness lifted: a pure HSV rainbow is a
    // programmer-art tell. This is closer to an oil sheen.
    col.setHSL(u, 0.92, 0.55);
    for (let y = 0; y < h; y++) {
      const v = (y + 0.5) / h;
      // Bright core down the ribbon's spine, feathered shoulders.
      const across = 1 - smoothstep(0.18, 0.5, Math.abs(v - 0.5));
      const core = Math.exp(-Math.pow((v - 0.5) * 5.2, 2));
      const i = (y * w + x) * 4;
      // A restrained white core: enough to give the ribbon a spine, not so
      // much that the additive blend eats the hue it exists to show.
      d[i] = clamp01(col.r + core * 0.3) * 255;
      d[i + 1] = clamp01(col.g + core * 0.3) * 255;
      d[i + 2] = clamp01(col.b + core * 0.3) * 255;
      d[i + 3] = clamp01(across * (0.6 + core * 0.5)) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.name = "kart/fx/rainbow";
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
