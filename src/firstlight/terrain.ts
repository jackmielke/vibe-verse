/**
 * The basin. One heightfield, sampled three ways.
 *
 * The shape is a lake ringed by hills, and it is built from a *radial* basin
 * plus noise rather than from noise alone. Pure fractal noise makes convincing
 * hills and terrible lakes: the shoreline wanders off the edge of the world, or
 * closes into three ponds, and which of those you get depends on the seed. A
 * basin term guarantees exactly one body of water with a closed shore, and the
 * noise is then free to make that shore irregular without being able to break
 * it.
 *
 * `heightAt` is the single source of truth for the ground. The mesh, the
 * player's feet and every blade of grass read it, so none of them can disagree
 * about where the ground is — a class of bug that otherwise shows up as reeds
 * growing out of open water.
 */
import * as THREE from "three";
import { createNoise2D } from "simplex-noise";
import { mulberry32 } from "./textures";

export const WORLD_SIZE = 760;
export const WATER_LEVEL = 0;

export interface Terrain {
  mesh: THREE.Mesh;
  heightAt(x: number, z: number): number;
  /** Surface normal, for aligning things that sit on the ground. */
  normalAt(x: number, z: number): THREE.Vector3;
  dispose(): void;
}

/**
 * Height in metres. Deterministic and cheap enough to call per-blade at load,
 * but it is not free — 20 k reeds is 20 k calls — so callers that need it every
 * frame (the player) should call it once per frame, not once per axis.
 */
function makeHeightFn(seed: number) {
  const n1 = createNoise2D(mulberry32(seed));
  const n2 = createNoise2D(mulberry32(seed + 1));
  const n3 = createNoise2D(mulberry32(seed + 2));

  return (x: number, z: number): number => {
    const r = Math.hypot(x, z) / (WORLD_SIZE * 0.5);

    /* The basin: −7 m at the middle, climbing through zero at about 0.42 of the
       radius, then up into the ring of hills. smoothstep rather than a linear
       ramp so the lake floor is a bowl and the shore arrives gently — a conical
       lake reads as a funnel the moment you can see through the water. */
    const t = Math.min(1, Math.max(0, (r - 0.16) / 0.72));
    const basin = -7 + Math.pow(t, 1.45) * 58;

    /* Ridges: two octaves of ordinary noise, plus one "ridged" octave (the
       absolute value folded over) which is what gives hills a crest instead of
       a dome. Damped near the middle so the lake bed stays a lake bed. */
    const ridged = 1 - Math.abs(n3(x * 0.0022, z * 0.0022));
    const hills =
      n1(x * 0.0018, z * 0.0018) * 22 +
      n2(x * 0.0051, z * 0.0051) * 7 +
      ridged * ridged * 26;

    /* Detail, at a scale you notice underfoot rather than on the skyline. */
    const detail = n2(x * 0.021, z * 0.021) * 0.9 + n3(x * 0.055, z * 0.055) * 0.35;

    const hillMask = Math.pow(Math.min(1, Math.max(0, (r - 0.2) / 0.5)), 1.3);
    return basin + hills * hillMask + detail * (0.35 + hillMask * 0.65);
  };
}

export function createTerrain(opts: { seed?: number; segments: number; detailNormal: THREE.Texture }): Terrain {
  const seed = opts.seed ?? 20260815;
  const height = makeHeightFn(seed);
  const seg = opts.segments;

  const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, seg, seg);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);

  /* The palette. Sampled at dawn, so everything is desaturated and cool except
     the sand, which is the only warm note below the sky and is what stops the
     whole frame reading as a grey wash. */
  const cSand = new THREE.Color(0x9c8b6e);
  const cGrass = new THREE.Color(0x4a5b3a);
  const cGrassDry = new THREE.Color(0x6d6f47);
  const cRock = new THREE.Color(0x5d5c58);
  const cSilt = new THREE.Color(0x3a3f33);
  const tmp = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = height(x, z);
    pos.setY(i, y);

    /* Slope from finite differences. Steep ground gets rock regardless of
       height, which is what makes the hills read as eroded rather than as a
       green blanket thrown over them. */
    const e = 2.5;
    const slope = Math.min(
      1,
      Math.hypot(height(x + e, z) - height(x - e, z), height(x, z + e) - height(x, z - e)) / (e * 1.6),
    );

    if (y < WATER_LEVEL - 0.6) tmp.copy(cSilt);
    else tmp.copy(cSand);

    /* Sand only survives a narrow band either side of the waterline. */
    const grassT = Math.min(1, Math.max(0, (y - 1.1) / 3.4));
    tmp.lerp(cGrass, grassT);
    /* Higher and drier as it climbs away from the water table. */
    tmp.lerp(cGrassDry, Math.min(1, Math.max(0, (y - 16) / 26)) * 0.75);
    tmp.lerp(cRock, Math.pow(slope, 1.6) * 0.9);

    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }

  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
    normalMap: opts.detailNormal,
    /* Tiled hard, because the map is 512² over 760 m of ground. Without this
       the detail normal is a smear and the terrain lights like plastic — but
       pushed too far the tiling itself becomes the texture, and at 0.55 the
       repeat was legible as a regular weave across the hillsides once the sun
       was high enough to graze them. */
    normalScale: new THREE.Vector2(0.3, 0.3),
    dithering: true,
  });
  opts.detailNormal.repeat.set(90, 90);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  const normalAt = (x: number, z: number) => {
    const e = 1.2;
    return new THREE.Vector3(
      height(x - e, z) - height(x + e, z),
      2 * e,
      height(x, z - e) - height(x, z + e),
    ).normalize();
  };

  return {
    mesh,
    heightAt: height,
    normalAt,
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
