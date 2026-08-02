/**
 * Vibe Kart — the terrain mesh, the sea and Gull Creek.
 *
 * One grid, one vertex buffer, three draw calls. The grid is sampled straight
 * out of `ground.height`, so it is the same land the karts slide across when
 * they run wide; the biome (turf / sand / rock) is decided per triangle and
 * written as geometry *groups*, which is how three renders three materials off
 * one buffer without three uploads.
 *
 * Vertex colours carry a low-frequency tone variation and a slope-darkening
 * term. That is the difference between "a tiling grass texture" and "a hillside"
 * at two hundred metres, and it is free.
 *
 * Triangles that are entirely well below the waterline are dropped: the sea
 * plane covers them, and skipping them removes about a third of the mesh.
 */
import * as THREE from "three";
import type { KartQuality } from "../types";
import { SEA_LEVEL, type GroundField } from "./ground";
import type { TrackCurve } from "./spline";
import { MeshBuilder, clamp01, fbm2, smoothstep, type MaterialResolver } from "./util";

export interface TerrainBuild {
  root: THREE.Object3D;
  geometries: THREE.BufferGeometry[];
}

const GRID: Record<KartQuality, number> = { low: 110, medium: 160, high: 224, ultra: 288 };

/** How far past the circuit's own footprint the modelled land reaches. */
const MARGIN = 330;

export function buildTerrain(
  curve: TrackCurve,
  ground: GroundField,
  mats: MaterialResolver,
  quality: KartQuality,
): TerrainBuild {
  const root = new THREE.Group();
  root.name = "track/terrain";
  const geometries: THREE.BufferGeometry[] = [];

  // --- extents -------------------------------------------------------------
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < curve.count; i++) {
    minX = Math.min(minX, curve.pos[i * 3]);
    maxX = Math.max(maxX, curve.pos[i * 3]);
    minZ = Math.min(minZ, curve.pos[i * 3 + 2]);
    maxZ = Math.max(maxZ, curve.pos[i * 3 + 2]);
  }
  const cx = (minX + maxX) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const half = Math.max(maxX - minX, maxZ - minZ) * 0.5 + MARGIN;
  const n = GRID[quality] ?? 224;
  const step = (half * 2) / n;
  // One shared UV attribute cannot carry three different tile sizes, so the
  // grid is authored at the turf's scale and sand and rock ride along. Both are
  // noise at this distance and nobody has ever noticed.
  const uvTile = mats.tile("grass");

  // --- sample --------------------------------------------------------------
  const verts = (n + 1) * (n + 1);
  const height = new Float32Array(verts);
  for (let j = 0; j <= n; j++) {
    const z = cz - half + j * step;
    for (let i = 0; i <= n; i++) {
      height[j * (n + 1) + i] = ground.height(cx - half + i * step, z);
    }
  }

  const position = new Float32Array(verts * 3);
  const normal = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const color = new Float32Array(verts * 3);
  /** 0 = turf, 1 = sand, 2 = rock. */
  const biome = new Uint8Array(verts);

  const at = (i: number, j: number): number =>
    height[Math.max(0, Math.min(n, j)) * (n + 1) + Math.max(0, Math.min(n, i))];

  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const k = j * (n + 1) + i;
      const x = cx - half + i * step;
      const z = cz - half + j * step;
      const h = height[k];
      position[k * 3] = x;
      position[k * 3 + 1] = h;
      position[k * 3 + 2] = z;

      // Central differences straight off the grid: cheaper and smoother than
      // re-evaluating the height function three more times per vertex.
      const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * step);
      const dz = (at(i, j + 1) - at(i, j - 1)) / (2 * step);
      const inv = 1 / Math.sqrt(dx * dx + dz * dz + 1);
      normal[k * 3] = -dx * inv;
      normal[k * 3 + 1] = inv;
      normal[k * 3 + 2] = -dz * inv;

      // World-space UVs so neighbouring cells never disagree about the pattern.
      uv[k * 2] = x / uvTile;
      uv[k * 2 + 1] = z / uvTile;

      const slope = Math.sqrt(dx * dx + dz * dz);
      const shore = h < SEA_LEVEL + 2.4;
      // Rock only where the land is genuinely cliff-steep (>44°). A lower
      // threshold speckles pale stone across every hillside like a leopard,
      // and an altitude term on top of it caps every hill with what reads as
      // snow on a course that is meant to be warm.
      const rock = slope > 0.98;
      biome[k] = shore ? 1 : rock ? 2 : 0;

      // Tone: a broad wash plus a little darkening in the hollows. Kept inside
      // 0.8–1.12 so it reads as light and damp ground rather than paint.
      const wash = fbm2(x * 0.0085, z * 0.0085, 3, 91);
      const fine = fbm2(x * 0.045, z * 0.045, 2, 17);
      const cavity = 1 - smoothstep(0.15, 0.85, slope) * 0.18;
      const tone = clamp01(0.82 + wash * 0.26 + fine * 0.08) * cavity;
      // Turf greens up where it is flat and damp; rock and sand stay neutral.
      const green = biome[k] === 0 ? 1 + (1 - clamp01(slope * 2)) * 0.06 : 1;
      color[k * 3] = tone;
      color[k * 3 + 1] = tone * green;
      color[k * 3 + 2] = tone * (biome[k] === 1 ? 0.97 : 1);
    }
  }

  // --- index, grouped by biome --------------------------------------------
  const buckets: number[][] = [[], [], []];
  const DROP = SEA_LEVEL - 3.5;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + (n + 1);
      const d = c + 1;
      if (height[a] < DROP && height[b] < DROP && height[c] < DROP && height[d] < DROP) continue;
      // Split along the shorter diagonal: it keeps ridge lines crisp instead of
      // stair-stepping them across the grid.
      const flip = Math.abs(height[a] - height[d]) > Math.abs(height[b] - height[c]);
      const tris = flip
        ? [
            [a, c, b],
            [b, c, d],
          ]
        : [
            [a, c, d],
            [a, d, b],
          ];
      for (const t of tris) {
        const bi = Math.max(biome[t[0]], biome[t[1]], biome[t[2]]) === 2
          ? 2
          : biome[t[0]] === 1 || biome[t[1]] === 1 || biome[t[2]] === 1
            ? 1
            : 0;
        buckets[bi].push(t[0], t[1], t[2]);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.name = "track/terrain";
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("color", new THREE.BufferAttribute(color, 3));
  const index: number[] = [];
  const order: Array<{ mat: number; start: number; count: number }> = [];
  for (let bi = 0; bi < 3; bi++) {
    if (!buckets[bi].length) continue;
    order.push({ mat: bi, start: index.length, count: buckets[bi].length });
    for (const v of buckets[bi]) index.push(v);
  }
  geo.setIndex(index);
  for (const grp of order) geo.addGroup(grp.start, grp.count, grp.mat);
  geo.computeBoundingSphere();
  geometries.push(geo);

  const terrainMats = ["grass", "sand", "stone"].map((name) =>
    mats.variant(name, "terrain", (m) => {
      m.vertexColors = true;
    }),
  );

  const mesh = new THREE.Mesh(geo, terrainMats);
  mesh.name = "track/terrain";
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  root.add(mesh);

  // --- the sea -------------------------------------------------------------
  {
    const size = Math.max(3200, half * 6);
    const seg = quality === "low" ? 1 : 24;
    const g = new THREE.PlaneGeometry(size, size, seg, seg);
    g.rotateX(-Math.PI / 2);
    // Metre UVs again, so the water material's scroll reads at a believable
    // scale rather than one enormous wave across the whole bay.
    const wtile = mats.tile("water");
    const guv = g.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < guv.count; i++) {
      guv.setXY(i, (guv.getX(i) * size) / wtile, (guv.getY(i) * size) / wtile);
    }
    guv.needsUpdate = true;
    geometries.push(g);
    const sea = new THREE.Mesh(g, mats.get("water"));
    sea.name = "track/sea";
    sea.position.set(cx, SEA_LEVEL, cz);
    sea.receiveShadow = false;
    sea.renderOrder = -1;
    root.add(sea);
  }

  // --- Gull Creek ----------------------------------------------------------
  {
    const creek = ground.anchors.creek;
    const mb = new MeshBuilder();
    const STEPS = 26;
    const HALF = 7.5;
    const dx = creek.bx - creek.ax;
    const dz = creek.bz - creek.az;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const wtile = mats.tile("water");
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const x = creek.ax + dx * t;
      const z = creek.az + dz * t;
      // The water surface sits just over the carved floor and never above the
      // land, so where the gully shallows out the stream simply disappears.
      const floor = creek.floor + fbm2(x * 0.02, z * 0.02, 2, 41) * 1.5;
      const y = Math.min(floor + 1.1, ground.height(x, z) + 0.4);
      const w = HALF * (0.55 + 0.45 * Math.sin(Math.PI * clamp01(t * 1.15)));
      for (let c = 0; c < 2; c++) {
        const o = c === 0 ? -w : w;
        mb.vertex(x + nx * o, y, z + nz * o, 0, 1, 0, o / wtile, (t * len) / wtile);
      }
    }
    mb.grid(0, STEPS + 1, 2, false);
    const g = mb.toGeometry("track/creek");
    geometries.push(g);
    const water = new THREE.Mesh(g, mats.get("water"));
    water.name = "track/creek";
    root.add(water);
  }

  return { root, geometries };
}
