/**
 * Terrain relief for the full-screen map.
 *
 * San Francisco is its hills, and a map that does not show them is a map of
 * somewhere else. The shade is computed straight from `terrainHeight` — the
 * same function the terrain mesh, the physics and the spawn solver use — so
 * the map's Twin Peaks is exactly the Twin Peaks you are standing on.
 *
 * `terrainHeight` is not cheap (a signed-distance query against every
 * landmass polygon, plus sixteen hills, plus four octaves of fbm), and a
 * 256×256 grid is 65k calls. Doing that in one go would drop a third of a
 * second on the floor the first time the player opens the map. So it is
 * built in time-sliced rows on the shared rAF with a ~5 ms budget, and the
 * map simply draws without relief until it is ready.
 *
 * The result is cached for the session. The world is deterministic; there is
 * nothing to invalidate.
 */
import { terrainHeight, WORLD, WORLD_SIZE_X, WORLD_SIZE_Z } from "../../geo/sfGeo";
import { subscribeUiFrame } from "../raf";

const RES = 256;
/** Milliseconds of main-thread time the builder may use per frame. */
const BUDGET_MS = 5;
/** Sun direction for the shading, in map space. Northwest, standard for
 *  cartographic relief — brains read NW-lit relief as raised. */
const LIGHT_X = -0.62;
const LIGHT_Z = -0.62;
const LIGHT_Y = 0.48;

let canvas: HTMLCanvasElement | null = null;
let heights: Float32Array | null = null;
let row = 0;
let stop: (() => void) | null = null;
let done = false;
let started = false;

/** The relief image, or null while it is still being built. */
export function getHillshade(): HTMLCanvasElement | null {
  return done ? canvas : null;
}

/** 0..1 build progress, for a subtle "relief loading" affordance. */
export function hillshadeProgress(): number {
  return done ? 1 : row / RES;
}

/**
 * Kick off the build. Safe to call repeatedly; only the first call does
 * anything. Called when the full map is first opened, not at boot — most
 * sessions never need it, and the ones that do can wait a second.
 */
export function buildHillshade(): void {
  if (started || typeof document === "undefined") return;
  started = true;

  canvas = document.createElement("canvas");
  canvas.width = RES;
  canvas.height = RES;
  heights = new Float32Array(RES * RES);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    done = true;
    return;
  }
  const image = ctx.createImageData(RES, RES);

  const stepX = WORLD_SIZE_X / (RES - 1);
  const stepZ = WORLD_SIZE_Z / (RES - 1);

  stop = subscribeUiFrame(() => {
    const t0 = performance.now();
    // --- pass 1: sample heights -----------------------------------
    while (row < RES && performance.now() - t0 < BUDGET_MS) {
      const z = WORLD.minZ + row * stepZ;
      const base = row * RES;
      for (let i = 0; i < RES; i++) {
        heights![base + i] = terrainHeight(WORLD.minX + i * stepX, z);
      }
      row++;
    }
    if (row < RES) return;

    // --- pass 2: shade (one frame; it is only 65k cheap operations) --
    const data = image.data;
    for (let j = 0; j < RES; j++) {
      for (let i = 0; i < RES; i++) {
        const idx = j * RES + i;
        const hC = heights![idx];
        const hL = heights![j * RES + Math.max(0, i - 1)];
        const hR = heights![j * RES + Math.min(RES - 1, i + 1)];
        const hU = heights![Math.max(0, j - 1) * RES + i];
        const hD = heights![Math.min(RES - 1, j + 1) * RES + i];

        // Central-difference normal. The 2× step is the physical spacing, so
        // the slopes are true rather than resolution-dependent.
        const nx = (hL - hR) / (2 * stepX);
        const nz = (hU - hD) / (2 * stepZ);
        const inv = 1 / Math.sqrt(nx * nx + nz * nz + 1);
        const lambert = Math.max(
          0,
          (nx * LIGHT_X + nz * LIGHT_Z + LIGHT_Y) * inv,
        );

        // Below sea level contributes nothing: the bay is drawn as water and
        // relief there would just make the coastline mushy.
        const land = hC > 0.5 ? 1 : 0;
        // Elevation tint on top of the lambert term, so a lit low slope and a
        // lit summit are not the same grey.
        const elev = Math.min(1, Math.max(0, hC / 290));
        const v = land * (lambert * 0.72 + elev * 0.42);

        const o = idx * 4;
        // Warm highlights, cool shadows — the classic relief palette, kept
        // dark enough to sit under the street network.
        data[o + 0] = Math.min(255, v * 150 + elev * 40);
        data[o + 1] = Math.min(255, v * 142 + elev * 26);
        data[o + 2] = Math.min(255, v * 128);
        data[o + 3] = land ? 255 : 0;
      }
    }
    ctx.putImageData(image, 0, 0);
    done = true;
    stop?.();
    stop = null;
  });
}

/** Release the cached image. Only used by tests and hot reload. */
export function disposeHillshade(): void {
  stop?.();
  stop = null;
  canvas = null;
  heights = null;
  row = 0;
  done = false;
  started = false;
}
