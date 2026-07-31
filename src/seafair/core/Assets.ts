import * as THREE from "three";

/**
 * Procedural texture + material factory. The game ships zero binary assets, so
 * every surface is generated here on a canvas or via shader. Textures are
 * cached by key — always go through `Assets` rather than newing a canvas.
 */

export type Rng = () => number;

/** Deterministic PRNG so every player sees the same city. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2D value noise with fBm — used by most procedural textures. */
export function makeNoise2D(seed = 1337) {
  const rnd = mulberry32(seed);
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h: number, x: number, y: number) => {
    switch (h & 3) {
      case 0:
        return x + y;
      case 1:
        return -x + y;
      case 2:
        return x - y;
      default:
        return -x - y;
    }
  };

  const noise = (x: number, y: number): number => {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const aa = perm[perm[X] + Y];
    const ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y];
    const bb = perm[perm[X + 1] + Y + 1];
    const x1 = THREE.MathUtils.lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
    const x2 = THREE.MathUtils.lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
    return THREE.MathUtils.lerp(x1, x2, v);
  };

  const fbm = (x: number, y: number, octaves = 5, lac = 2.02, gain = 0.5): number => {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lac;
    }
    return sum / norm;
  };

  return { noise, fbm };
}

const texCache = new Map<string, THREE.Texture>();
let maxAniso = 8;

export function setMaxAnisotropy(n: number): void {
  maxAniso = n;
}

function finish(canvas: HTMLCanvasElement, repeat: number, srgb: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = maxAniso;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function canvasTexture(
  key: string,
  size: number,
  draw: (ctx: CanvasRenderingContext2D, size: number) => void,
  opts: { repeat?: number; srgb?: boolean } = {},
): THREE.Texture {
  const cacheKey = `${key}@${size}`;
  const hit = texCache.get(cacheKey);
  if (hit) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  draw(ctx, size);
  const tex = finish(canvas, opts.repeat ?? 1, opts.srgb ?? true);
  texCache.set(cacheKey, tex);
  return tex;
}

/**
 * Derive a tangent-space normal map from a height-producing function by
 * central differencing. Far cheaper to author than hand-painting normals.
 */
export function normalFromHeight(
  key: string,
  size: number,
  height: (x: number, y: number) => number,
  strength = 2.0,
): THREE.Texture {
  const cacheKey = `${key}:n@${size}`;
  const hit = texCache.get(cacheKey);
  if (hit) return hit;

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const inv = 1 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hL = height((x - 1) * inv, y * inv);
      const hR = height((x + 1) * inv, y * inv);
      const hD = height(x * inv, (y - 1) * inv);
      const hU = height(x * inv, (y + 1) * inv);
      let nx = (hL - hR) * strength;
      let ny = (hD - hU) * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz / len) * 0.5 * 255 + 127.5;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = finish(canvas, 1, false);
  texCache.set(cacheKey, tex);
  return tex;
}

/** Pack roughness into G and metalness into B, matching three's ORM convention. */
export function ormTexture(
  key: string,
  size: number,
  fn: (x: number, y: number) => { ao: number; rough: number; metal: number },
): THREE.Texture {
  const cacheKey = `${key}:orm@${size}`;
  const hit = texCache.get(cacheKey);
  if (hit) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = fn(x * inv, y * inv);
      const i = (y * size + x) * 4;
      d[i] = Math.round(THREE.MathUtils.clamp(v.ao, 0, 1) * 255);
      d[i + 1] = Math.round(THREE.MathUtils.clamp(v.rough, 0, 1) * 255);
      d[i + 2] = Math.round(THREE.MathUtils.clamp(v.metal, 0, 1) * 255);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = finish(canvas, 1, false);
  texCache.set(cacheKey, tex);
  return tex;
}

export function disposeAssets(): void {
  texCache.forEach((t) => t.dispose());
  texCache.clear();
}

/** Shared geometry cache — reuse across instanced props to cut memory. */
const geoCache = new Map<string, THREE.BufferGeometry>();
export function cachedGeometry(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}
