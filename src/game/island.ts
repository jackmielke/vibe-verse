// Irregular island shape shared by terrain, water shader, spawning and movement clamps.
// islandRadius(angle) returns the shore distance from world center for a given polar angle.

export function islandRadius(angle: number): number {
  return (
    44 +
    6 * Math.sin(angle * 3 + 1.7) +
    3.5 * Math.sin(angle * 7 + 0.4) +
    2 * Math.sin(angle * 11 + 2.9)
  );
}

// Smaller outer islets scattered in the surrounding ocean. Swimmers can reach
// these; land creatures stay on the main island.
export const ISLETS: { x: number; z: number; r: number }[] = [
  { x: 72, z: -10, r: 9 },
  { x: -68, z: 22, r: 11 },
  { x: 12, z: 78, r: 8 },
  { x: -30, z: -72, r: 10 },
  { x: 80, z: 55, r: 7 },
];

export const WORLD_RADIUS = 95;

function isletSignedDistance(x: number, z: number): number {
  let best = -Infinity;
  for (const i of ISLETS) {
    const d = Math.hypot(x - i.x, z - i.z);
    const sd = i.r - d;
    if (sd > best) best = sd;
  }
  return best;
}

/** Positive when (x,z) is on land (main island or any islet), negative at sea. */
export function shoreDistance(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const a = Math.atan2(z, x);
  const main = islandRadius(a) - r;
  const islet = isletSignedDistance(x, z);
  return Math.max(main, islet);
}

/** Distance to MAIN island only (for clamping land creatures). */
function mainShoreDistance(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const a = Math.atan2(z, x);
  return islandRadius(a) - r;
}

/** Clamp a position so it stays on the MAIN island (used by land creatures). */
export function clampToIsland(x: number, z: number, margin = 2): [number, number] {
  const r = Math.hypot(x, z);
  if (r < 1e-6) return [x, z];
  const a = Math.atan2(z, x);
  const max = islandRadius(a) - margin;
  if (r > max) return [Math.cos(a) * max, Math.sin(a) * max];
  return [x, z];
}

/** Clamp to the overall world boundary (used by swimmers, who can roam the sea). */
export function clampToWorld(x: number, z: number, margin = 2): [number, number] {
  const r = Math.hypot(x, z);
  const max = WORLD_RADIUS - margin;
  if (r > max) {
    const a = Math.atan2(z, x);
    return [Math.cos(a) * max, Math.sin(a) * max];
  }
  return [x, z];
}

/** True if (x,z) is over open water (not on the main island or any islet). */
export function isInWater(x: number, z: number, margin = 0): boolean {
  return shoreDistance(x, z) < margin;
}

/** Random position safely inside the main island. */
export function randIslandPos(margin = 6): [number, number, number] {
  for (let i = 0; i < 30; i++) {
    const x = (Math.random() - 0.5) * 104;
    const z = (Math.random() - 0.5) * 104;
    if (mainShoreDistance(x, z) > margin) return [x, 0, z];
  }
  return [0, 0, 0];
}
