// Procedural island heightmap shared by terrain mesh, foliage placement, and the
// character controller (so the character's feet always rest on the ground).

export const ISLAND_RADIUS = 60; // meters
export const SEA_LEVEL = 0; // y in world units
export const PEAK_HEIGHT = 9; // tallest point above sea level
export const TERRAIN_SEGMENTS = 220; // resolution of the terrain mesh

// Tiny deterministic 2D value-noise. We avoid pulling in another dependency
// for a single hash — this is good enough for an island silhouette.
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const tl = hash2(xi, yi);
  const tr = hash2(xi + 1, yi);
  const bl = hash2(xi, yi + 1);
  const br = hash2(xi + 1, yi + 1);
  const u = smoothstep(xf);
  const v = smoothstep(yf);
  return (
    tl * (1 - u) * (1 - v) +
    tr * u * (1 - v) +
    bl * (1 - u) * v +
    br * u * v
  );
}

function fbm(x: number, y: number): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < 5; i++) {
    sum += valueNoise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * Height at world (x, z). Combines a radial dome falloff with FBM detail so the
 * island has a soft coastline, gentle hills, and a couple of bumps. Values
 * below 0 are underwater; the sea plane sits at SEA_LEVEL.
 */
export function heightAt(x: number, z: number): number {
  const r = Math.sqrt(x * x + z * z);
  // Radial dome: 1 at center, 0 at ISLAND_RADIUS, slightly negative beyond
  const radial = Math.max(0, 1 - r / ISLAND_RADIUS);
  const dome = Math.pow(radial, 1.4);

  // FBM detail in the [0,1] range, biased so most of the island is gentle
  const n = fbm(x * 0.04 + 12.3, z * 0.04 + 7.7);
  const ridges = fbm(x * 0.09 - 3.1, z * 0.09 + 2.5);

  const elevation =
    dome * PEAK_HEIGHT * 0.85 +
    (n - 0.5) * dome * 5 +
    Math.max(0, ridges - 0.6) * dome * 4;

  // Beyond the radius, dip below sea level so the shoreline is clean.
  if (r > ISLAND_RADIUS) {
    const beyond = (r - ISLAND_RADIUS) / 10;
    return SEA_LEVEL - 1 - Math.min(beyond, 3);
  }

  return SEA_LEVEL + elevation;
}

/** Approximate slope steepness at (x, z) in [0,1]. Used for material blending. */
export function slopeAt(x: number, z: number): number {
  const e = 0.6;
  const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  return Math.min(1, Math.sqrt(dx * dx + dz * dz) / 1.5);
}

/** Deterministic seeded RNG so foliage placement is stable between renders. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}
