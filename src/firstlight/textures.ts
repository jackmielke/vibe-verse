/**
 * Every texture in First Light is generated at load, not fetched.
 *
 * Two reasons, and the second is the one that decided it. A lake needs a
 * *tiling* water normal map, a detail normal for the ground, and a soft mask
 * for the mist — perhaps 3 MB of PNG if they were shipped, on a route whose
 * whole argument is that it opens on an empty shore in a couple of seconds.
 * And a tiling normal map that was authored once cannot follow the art: the
 * ripple scale here was changed six times while the water was being tuned, and
 * each change is a number rather than a trip through an image editor.
 *
 * They are built on `DataTexture` rather than a 2D canvas because canvas
 * readback is synchronous, surprisingly slow at 512², and returns premultiplied
 * bytes that make a normal map subtly wrong in a way nobody ever tracks down.
 */
import * as THREE from "three";
import { createNoise2D } from "simplex-noise";

/** Deterministic PRNG so the lake looks the same on every visit. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Value noise on a **wrapped integer lattice** — periodic by construction.
 *
 * The first version of this sampled 3-D simplex noise around a pair of circles,
 * on the theory that a closed path comes back periodic. It does, but the two
 * circles are not independent, and the correlation between them showed up on
 * the terrain as a diagonal corduroy — a regular directional weave over the
 * whole basin that no amount of tuning the octaves removed. It is visible in
 * the first capture of this world and it is the reason this is now a lattice.
 *
 * Wrapping the lattice indices modulo the period makes the tile exact in both
 * axes with no correlation between them, and value noise is smooth enough for a
 * normal map at these frequencies. Quintic interpolation rather than cubic
 * because the *second* derivative is what a normal map differentiates, and
 * smoothstep leaves visible creases along the lattice lines.
 */
function lattice(seed: number) {
  return (ix: number, iy: number, period: number): number => {
    const x = ((ix % period) + period) % period;
    const y = ((iy % period) + period) % period;
    let h = x * 374761393 + y * 668265263 + seed * 2246822519;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
}

/** Quintic fade, 6t⁵−15t⁴+10t³ — flat in both derivatives at the lattice. */
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

function tileableValueNoise(seed: number) {
  const h = lattice(seed);
  /** u, v in [0,1); `period` lattice cells across that range. */
  return (u: number, v: number, period: number): number => {
    const x = u * period;
    const y = v * period;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = fade(x - x0);
    const fy = fade(y - y0);
    const a = h(x0, y0, period);
    const b = h(x0 + 1, y0, period);
    const c = h(x0, y0 + 1, period);
    const d = h(x0 + 1, y0 + 1, period);
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  };
}

/**
 * A seamlessly tiling normal map built from that noise.
 *
 * `octaves` are given as lattice periods rather than frequencies, because the
 * period is what has to be an integer for the tile to close.
 */
export function tilingNormalMap(
  size: number,
  octaves: { period: number; amp: number }[],
  seed = 1,
  strength = 1,
): THREE.DataTexture {
  const noise = tileableValueNoise(seed);
  const h = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let sum = 0;
      for (const o of octaves) sum += o.amp * (noise(u, v, o.period) - 0.5);
      h[y * size + x] = sum;
    }
  }

  /* Central differences on the wrapped field. Wrapping the *lookup* keeps the
     derivative continuous across the seam too — periodic heights with
     non-periodic slopes leave a crease that only shows under a specular. */
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
  const n = new THREE.Vector3();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength * size * 0.02;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength * size * 0.02;
      n.set(-dx, -dy, 1).normalize();
      const i = (y * size + x) * 4;
      data[i] = (n.x * 0.5 + 0.5) * 255;
      data[i + 1] = (n.y * 0.5 + 0.5) * 255;
      data[i + 2] = (n.z * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Soft round alpha blob — mist billboards, light shafts, the sun's bloom. */
export function radialAlpha(size: number, falloff = 2.2): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / c;
      const a = Math.pow(Math.max(0, 1 - d), falloff);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.min(255, a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * A wispy, tiling cloud/mist mask — used to break up the fog banks so they read
 * as weather rather than as the grey rectangle that a uniform fog plane looks
 * like from any angle.
 */
export function tilingCloudAlpha(size: number, seed = 7): THREE.DataTexture {
  const noise = tileableValueNoise(seed);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let a = 0;
      let amp = 0.6;
      for (let o = 0; o < 4; o++) {
        a += amp * noise(u, v, 2 << o);
        amp *= 0.5;
      }
      /* Biased hard toward transparent: a mist layer that averages half opaque
         is a wall, and what reads as mist is the edges. */
      const alpha = Math.pow(Math.max(0, Math.min(1, a * 1.15)), 2.6);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = alpha * 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export { createNoise2D };
