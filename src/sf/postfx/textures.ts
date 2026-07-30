/**
 * Procedurally generated lens textures for the pipeline.
 *
 * Nothing here is loaded from disk: the screenshot harness has to produce a
 * byte-identical frame on a cold machine, so every texture the post chain uses
 * is generated from the world seed. `Math.random()` is banned under `src/sf`
 * for exactly this reason.
 */
import * as THREE from "three";
import { makeRng, type Rng, clamp01, smoothstep } from "../math/rng";
import { WORLD_SEED } from "../config";

/* ------------------------------------------------------------------ *
 * Blue noise
 * ------------------------------------------------------------------ */

/**
 * Void-and-cluster blue noise.
 *
 * White noise dithering in a temporally-accumulated pipeline is a disaster: the
 * error is spatially uncorrelated, so the TAA resolve averages it into a soft
 * grey haze instead of resolving detail, and any frame you screenshot before it
 * converges is visibly grainy. Blue noise puts the error at high spatial
 * frequency where both the eye and the accumulator throw it away.
 *
 * The classic algorithm is O(n²) in pixels; we truncate the Gaussian energy
 * kernel at radius 6 (σ = 1.9, contributions below ~1e-4 are irrelevant), which
 * turns a 4096-pixel tile into ~700k operations — a few milliseconds at load.
 */
export function makeBlueNoiseTexture(size = 64, rng: Rng = makeRng(`${WORLD_SEED}:bluenoise`)): THREE.DataTexture {
  const n = size * size;
  const energy = new Float32Array(n);
  const filled = new Uint8Array(n);
  const rank = new Int32Array(n);

  const R = 6;
  const sigma2 = 1.9 * 1.9;
  // Precompute the truncated kernel once.
  const kernel: { dx: number; dy: number; w: number }[] = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > R * R) continue;
      kernel.push({ dx, dy, w: Math.exp(-d2 / (2 * sigma2)) });
    }
  }

  const splat = (idx: number, sign: number) => {
    const x = idx % size;
    const y = (idx / size) | 0;
    for (let k = 0; k < kernel.length; k++) {
      const kx = (x + kernel[k].dx + size) % size;
      const ky = (y + kernel[k].dy + size) % size;
      energy[ky * size + kx] += sign * kernel[k].w;
    }
  };

  // Seed with a sparse random binary pattern, then relax it: repeatedly move
  // the tightest cluster into the largest void until it stops changing.
  const initial = Math.max(1, Math.floor(n / 10));
  const order: number[] = [];
  for (let i = 0; i < n; i++) order.push(i);
  for (let i = n - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  for (let i = 0; i < initial; i++) {
    filled[order[i]] = 1;
    splat(order[i], 1);
  }

  const findExtreme = (wantFilled: number, wantMax: boolean) => {
    let best = -1;
    let bestE = wantMax ? -Infinity : Infinity;
    for (let i = 0; i < n; i++) {
      if (filled[i] !== wantFilled) continue;
      const e = energy[i];
      if (wantMax ? e > bestE : e < bestE) {
        bestE = e;
        best = i;
      }
    }
    return best;
  };

  for (let iter = 0; iter < 64; iter++) {
    const cluster = findExtreme(1, true);
    filled[cluster] = 0;
    splat(cluster, -1);
    const voidIdx = findExtreme(0, false);
    if (voidIdx === cluster) {
      filled[cluster] = 1;
      splat(cluster, 1);
      break;
    }
    filled[voidIdx] = 1;
    splat(voidIdx, 1);
  }

  // Phase 1: remove the tightest clusters, ranking downward from the initial count.
  const snapshot = filled.slice();
  const snapshotEnergy = energy.slice();
  let count = initial;
  while (count > 0) {
    const cluster = findExtreme(1, true);
    if (cluster < 0) break;
    filled[cluster] = 0;
    splat(cluster, -1);
    rank[cluster] = --count;
  }

  // Phase 2 + 3: restore the snapshot and fill the largest voids upward.
  filled.set(snapshot);
  energy.set(snapshotEnergy);
  count = initial;
  while (count < n) {
    const voidIdx = findExtreme(0, false);
    if (voidIdx < 0) break;
    filled[voidIdx] = 1;
    splat(voidIdx, 1);
    rank[voidIdx] = count++;
  }

  // Pack four decorrelated channels by rotating the tile — the shaders want
  // independent noise per dimension (two for a disc sample, one for the ray
  // offset, one for grain) and a single channel reused four times correlates.
  const data = new Uint8Array(n * 4);
  const at = (x: number, y: number) => rank[((y % size) + size) % size * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      data[i + 0] = Math.min(255, Math.floor((at(x, y) / n) * 256));
      data[i + 1] = Math.min(255, Math.floor((at(x + 37, y + 17) / n) * 256));
      data[i + 2] = Math.min(255, Math.floor((at(y + 11, x + 29) / n) * 256));
      data[i + 3] = Math.min(255, Math.floor((at(size - 1 - x, y + 43) / n) * 256));
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.name = "SfBlueNoise";
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ *
 * Lens dirt
 * ------------------------------------------------------------------ */

/**
 * The film of grease, dust and micro-scratches on a real front element.
 *
 * Bloom modulated by a uniform white mask is the single biggest tell that a
 * game's glow is procedural. Real lenses smear their highlights through
 * whatever is on the glass, which is why a bright light source produces that
 * distinctive dirty-veiling flare. Layers here: a low-frequency smear, radial
 * cleaning-cloth scratches, and a scatter of specks that get denser toward the
 * edges where nobody wipes.
 */
export function makeLensDirtTexture(
  size = 512,
  rng: Rng = makeRng(`${WORLD_SEED}:lensdirt`),
): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const acc = new Float32Array(size * size);

  // --- smear: a few dozen soft, stretched blobs ---
  const smears = 46;
  for (let s = 0; s < smears; s++) {
    const cx = rng.next() * size;
    const cy = rng.next() * size;
    const ang = rng.next() * Math.PI * 2;
    const rx = rng.range(size * 0.03, size * 0.16);
    const ry = rx * rng.range(0.18, 0.7);
    const amp = rng.range(0.05, 0.28);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const bound = Math.ceil(Math.max(rx, ry));
    for (let dy = -bound; dy <= bound; dy++) {
      for (let dx = -bound; dx <= bound; dx++) {
        const px = Math.floor(cx + dx);
        const py = Math.floor(cy + dy);
        if (px < 0 || py < 0 || px >= size || py >= size) continue;
        const u = (dx * ca + dy * sa) / rx;
        const v = (-dx * sa + dy * ca) / ry;
        const d = u * u + v * v;
        if (d > 1) continue;
        acc[py * size + px] += amp * (1 - d) * (1 - d);
      }
    }
  }

  // --- scratches: thin arcs, the ghost of a lens cloth ---
  const scratches = 30;
  for (let s = 0; s < scratches; s++) {
    const cx = size * 0.5 + rng.gauss() * size * 0.22;
    const cy = size * 0.5 + rng.gauss() * size * 0.22;
    const radius = rng.range(size * 0.08, size * 0.6);
    const a0 = rng.next() * Math.PI * 2;
    const arc = rng.range(0.25, 1.5);
    const amp = rng.range(0.08, 0.4);
    const steps = Math.ceil(radius * arc * 2);
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (arc * i) / steps;
      const px = Math.floor(cx + Math.cos(a) * radius);
      const py = Math.floor(cy + Math.sin(a) * radius);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const qx = px + dx;
          const qy = py + dy;
          if (qx < 0 || qy < 0 || qx >= size || qy >= size) continue;
          const w = 1 / (1 + dx * dx + dy * dy);
          acc[qy * size + qx] += amp * w * (0.5 + 0.5 * Math.sin(i * 0.31 + s));
        }
      }
    }
  }

  // --- dust specks, biased to the periphery ---
  const specks = 1400;
  for (let s = 0; s < specks; s++) {
    // Sample radius with a bias toward the edge of the frame.
    const r = Math.pow(rng.next(), 0.55) * size * 0.72;
    const a = rng.next() * Math.PI * 2;
    const cx = size * 0.5 + Math.cos(a) * r;
    const cy = size * 0.5 + Math.sin(a) * r;
    const rad = rng.range(0.7, 3.4);
    const amp = rng.range(0.15, 0.9);
    const bound = Math.ceil(rad) + 1;
    for (let dy = -bound; dy <= bound; dy++) {
      for (let dx = -bound; dx <= bound; dx++) {
        const px = Math.floor(cx + dx);
        const py = Math.floor(cy + dy);
        if (px < 0 || py < 0 || px >= size || py >= size) continue;
        const d = Math.sqrt(dx * dx + dy * dy) / rad;
        if (d > 1) continue;
        acc[py * size + px] += amp * (1 - d * d);
      }
    }
  }

  // Normalise, then split into slightly decorrelated RGB so the dirt tints the
  // bloom rather than just brightening it — real grease is not neutral.
  let peak = 0;
  for (let i = 0; i < acc.length; i++) peak = Math.max(peak, acc[i]);
  const inv = peak > 0 ? 1 / peak : 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const v = clamp01(acc[i] * inv);
      // Very slight vignette on the dirt itself: the centre of the element gets
      // wiped more often than the corners.
      const nx = (x / size - 0.5) * 2;
      const ny = (y / size - 0.5) * 2;
      const edge = 0.55 + 0.45 * smoothstep(0.1, 1.2, Math.sqrt(nx * nx + ny * ny));
      const b = v * edge;
      data[i * 4 + 0] = Math.floor(clamp01(b * 1.0) * 255);
      data[i * 4 + 1] = Math.floor(clamp01(b * 0.94) * 255);
      data[i * 4 + 2] = Math.floor(clamp01(b * 0.86) * 255);
      data[i * 4 + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.name = "SfLensDirt";
  tex.needsUpdate = true;
  return tex;
}
