/**
 * Islands — the floating landmasses of VIBE ISLAND II.
 *
 * Each island is built as a *lens*: a domed top surface you walk on, and a
 * tapering keel hanging underneath. The keel matters more than it sounds. In a
 * floating world the player spends half their time below the islands looking
 * up, so an island modelled as a flat disc with a skirt reads as a stage prop
 * the first time you glide under it.
 *
 * The mesh is polar rather than a clipped grid, because an island *is* radial:
 * a polar mesh puts its resolution where the shape is (the rim) and costs
 * nothing in the middle, and the rim ring is shared exactly between the top
 * surface and the keel so there is no seam to crack open.
 *
 * Vertex colour carries the biome. One draw call per island, and the whole
 * archipelago is a handful of meshes.
 */
import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { QUALITY } from "../config";
import { useIslandStore } from "../state/store";
import {
  ISLANDS,
  LAGOON_LEVEL,
  biomeAt,
  islandSDF,
  keelDepth,
  surfaceHeight,
  surfaceSlope,
  type Biome,
  type IslandDef,
} from "../geo/islandGeo";
import { clamp01, fbm2, smoothstep } from "@/shared/proc/rng";

/* ------------------------------------------------------------------ *
 * Palette
 * ------------------------------------------------------------------ *
 * Golden-hour tuned. Everything here is warm on the lit side and cool in
 * shadow, which is what makes the world read as sunlit rather than tinted.
 */
const BIOME_COLOR: Record<Biome, THREE.Color> = {
  cove: new THREE.Color(0.92, 0.78, 0.52),
  lagoon: new THREE.Color(0.24, 0.62, 0.58),
  meadow: new THREE.Color(0.36, 0.58, 0.18),
  jungle: new THREE.Color(0.13, 0.36, 0.12),
  terrace: new THREE.Color(0.52, 0.54, 0.22),
  stone: new THREE.Color(0.40, 0.34, 0.29),
  summit: new THREE.Color(0.58, 0.51, 0.36),
};

/** The keel is bare rock, banded by depth like a cliff face. */
const ROCK_TOP = new THREE.Color(0.46, 0.38, 0.31);
const ROCK_DEEP = new THREE.Color(0.13, 0.11, 0.14);
const ROCK_WARM = new THREE.Color(0.55, 0.31, 0.19);

function surfaceColor(x: number, z: number, out: THREE.Color): THREE.Color {
  const biome = biomeAt(x, z);
  out.copy(BIOME_COLOR[biome]);

  // Slope exposes rock through the soil — the transition that makes terrain
  // read as landscape instead of as painted geometry.
  const slope = surfaceSlope(x, z, 3);
  out.lerp(BIOME_COLOR.stone, smoothstep(0.55, 0.92, slope) * 0.9);

  // Two scales of variation so nothing is ever a flat field of one green.
  const macro = fbm2(x * 0.0026, z * 0.0026, 3, 2, 0.5, 17) * 0.5 + 0.5;
  const fine = fbm2(x * 0.032, z * 0.032, 3, 2, 0.5, 43) * 0.5 + 0.5;
  out.multiplyScalar(0.80 + macro * 0.28 + fine * 0.14);

  // Warm rim light: ground near the edge catches sky bounce from below.
  return out;
}

/* ------------------------------------------------------------------ *
 * Mesh construction
 * ------------------------------------------------------------------ */

interface BuiltIsland {
  geometry: THREE.BufferGeometry;
  isle: IslandDef;
}

/**
 * Build one island lens.
 *
 * `spokes` angular samples, `rings` radial samples. The rim radius is solved
 * per-spoke by walking outward until the SDF crosses zero, so the noisy rim
 * shape from islandGeo is reproduced exactly rather than approximated.
 */
function buildIsland(isle: IslandDef, spokes: number, rings: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const c = new THREE.Color();

  // --- solve the rim radius for each spoke ---
  const rimR = new Float32Array(spokes);
  for (let s = 0; s < spokes; s++) {
    const a = (s / spokes) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    // Coarse march outward, then bisect — the rim is monotonic enough in
    // practice and this is far cheaper than a fine march.
    let lo = 0;
    let hi = isle.radius * 1.3;
    let step = isle.radius * 0.05;
    for (let r = 0; r <= hi; r += step) {
      if (islandSDF(isle.x + dx * r, isle.z + dz * r, isle) <= 0) {
        lo = Math.max(0, r - step);
        hi = r;
        break;
      }
    }
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) * 0.5;
      if (islandSDF(isle.x + dx * mid, isle.z + dz * mid, isle) > 0) lo = mid;
      else hi = mid;
    }
    rimR[s] = lo;
  }

  const vid = (ring: number, spoke: number, layer: 0 | 1) =>
    layer * spokes * rings + ring * spokes + (spoke % spokes);

  // --- top surface + keel share the same (ring, spoke) lattice ---
  for (let layer = 0 as 0 | 1; layer <= 1; layer++) {
    for (let ring = 0; ring < rings; ring++) {
      // Bias samples toward the rim, where all the shape detail lives.
      const t = Math.pow(ring / (rings - 1), 0.78);
      for (let s = 0; s < spokes; s++) {
        const a = (s / spokes) * Math.PI * 2;
        // Pull in a hair so we sample strictly inside the rim.
        const r = rimR[s] * t * 0.9995;
        const x = isle.x + Math.cos(a) * r;
        const z = isle.z + Math.sin(a) * r;

        let y: number;
        if (layer === 0) {
          y = surfaceHeight(x, z) ?? isle.elevation;
          surfaceColor(x, z, c);
        } else {
          y = keelDepth(x, z) ?? isle.elevation - isle.keel;
          // Rock banding by how far below the rim we are.
          const depth = clamp01((isle.elevation - y) / Math.max(1, isle.keel));
          c.copy(ROCK_TOP).lerp(ROCK_DEEP, Math.pow(depth, 0.7));
          c.lerp(ROCK_WARM, (fbm2(x * 0.012, z * 0.012, 3, 2, 0.5, 71) * 0.5 + 0.5) * 0.30);
          const grain = fbm2(x * 0.09, z * 0.09, 2, 2, 0.5, 13) * 0.5 + 0.5;
          c.multiplyScalar(0.78 + grain * 0.34);
        }

        positions.push(x, y, z);
        colors.push(c.r, c.g, c.b);
      }
    }
  }

  // --- triangulate the top surface ---
  for (let ring = 0; ring < rings - 1; ring++) {
    for (let s = 0; s < spokes; s++) {
      const a = vid(ring, s, 0);
      const b = vid(ring, s + 1, 0);
      const d = vid(ring + 1, s, 0);
      const e = vid(ring + 1, s + 1, 0);
      if (ring === 0) {
        indices.push(a, d, e); // fan at the pole
      } else {
        indices.push(a, d, b, b, d, e);
      }
    }
  }

  // --- the keel, wound the other way so it faces outward from below ---
  for (let ring = 0; ring < rings - 1; ring++) {
    for (let s = 0; s < spokes; s++) {
      const a = vid(ring, s, 1);
      const b = vid(ring, s + 1, 1);
      const d = vid(ring + 1, s, 1);
      const e = vid(ring + 1, s + 1, 1);
      if (ring === 0) {
        indices.push(a, e, d);
      } else {
        indices.push(a, b, d, b, e, d);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export default function Islands() {
  const tier = useIslandStore((s) => s.quality);
  const q = QUALITY[tier];

  const built = useMemo<BuiltIsland[]>(() => {
    return ISLANDS.map((isle) => {
      // Scale mesh density with the island's size so a shard is not carrying
      // the same vertex count as the heart.
      const scale = clamp01(isle.radius / ISLANDS[0].radius) * 0.75 + 0.25;
      const spokes = Math.max(48, Math.round(q.terrainSegments * scale));
      const rings = Math.max(14, Math.round(q.terrainSegments * 0.42 * scale));
      return { geometry: buildIsland(isle, spokes, rings), isle };
    });
  }, [q.terrainSegments]);

  useLayoutEffect(() => {
    return () => {
      for (const b of built) b.geometry.dispose();
    };
  }, [built]);

  return (
    <group name="islands">
      {built.map((b) => (
        <mesh
          key={b.isle.key}
          geometry={b.geometry}
          castShadow
          receiveShadow
          name={`island-${b.isle.key}`}
        >
          <meshStandardMaterial vertexColors roughness={0.93} metalness={0.02} dithering />
        </mesh>
      ))}
    </group>
  );
}

/** Exported so the lagoon and the falls can agree with the terrain. */
export { LAGOON_LEVEL };
