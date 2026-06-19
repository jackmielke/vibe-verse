import { createNoise2D } from "simplex-noise";

// Deterministic seeded RNG so the island is the same every reload.
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ISLAND_SIZE = 120; // world units (square plane side)
export const ISLAND_RADIUS = 42; // playable radius before falloff
const noise2D = createNoise2D(mulberry32(1337));

/**
 * Returns terrain height (Y) at world (x,z).
 * Positive above water, negative below.
 */
export function heightAt(x: number, z: number): number {
  const dist = Math.sqrt(x * x + z * z);
  // Smooth circular falloff: high in middle, plunges below 0 outside ISLAND_RADIUS.
  const falloff = 1 - Math.min(1, dist / ISLAND_RADIUS);
  const islandShape = Math.pow(falloff, 1.6) * 8.0; // base elevation

  // Multi-octave noise for hills/dunes.
  const n =
    noise2D(x * 0.04, z * 0.04) * 1.0 +
    noise2D(x * 0.09, z * 0.09) * 0.5 +
    noise2D(x * 0.18, z * 0.18) * 0.25;

  const h = islandShape + n * 1.4 * Math.max(0, falloff);
  // Push the outside down so it's clearly underwater.
  return h - 1.2;
}

export function isOnLand(x: number, z: number) {
  return heightAt(x, z) > 0.05;
}
