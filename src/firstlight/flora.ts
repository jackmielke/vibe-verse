/**
 * Reeds, grass and pines — everything that grows, and everything that moves in
 * the wind.
 *
 * All three are `InstancedMesh`, which is not an optimisation here so much as
 * the entire reason the scene is possible: 24 000 reeds as separate meshes is
 * 24 000 draw calls and a scene that never reaches a frame. As instances it is
 * three.
 *
 * ## Wind, and why it is in the shader
 *
 * The sway is a vertex displacement injected into `MeshStandardMaterial` with
 * `onBeforeCompile`, rather than per-instance matrix updates on the CPU. Moving
 * 24 000 matrices per frame costs about 4 ms and uploads 1.5 MB to the GPU
 * every frame; doing it in the vertex shader costs nothing measurable and is
 * the difference between wind being affordable and being cut.
 *
 * Patching the standard material rather than writing a custom one keeps the
 * PBR lighting and — the part that is easy to lose — the **shadow pass**.
 * A custom `ShaderMaterial` would need its own depth material or the reeds
 * would sway in the light and stand still in their own shadows.
 */
import * as THREE from "three";
import { createNoise2D } from "simplex-noise";
import { mulberry32 } from "./textures";
import { WATER_LEVEL, WORLD_SIZE, type Terrain } from "./terrain";

export interface Flora {
  group: THREE.Group;
  update(elapsed: number): void;
  dispose(): void;
}

/** Shared uniform object so one write drives every plant in the scene. */
interface WindUniforms {
  uTime: { value: number };
  uWind: { value: number };
}

/**
 * Inject sway into a standard material.
 *
 * `stiffness` is an attribute-free approximation: displacement scales with the
 * square of the height up the blade, so the root stays planted and the tip
 * carries the motion. Linear scaling makes the whole plant slide sideways,
 * which reads as the ground moving rather than the plant bending.
 */
function makeWindMaterial(base: THREE.MeshStandardMaterial, wind: WindUniforms, amount: number) {
  base.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = wind.uTime;
    shader.uniforms.uWind = wind.uWind;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         uniform float uTime;
         uniform float uWind;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         {
           /* Instance world position seeds the phase, so neighbours are not in
              lockstep — a field where every blade agrees reads as a flag. */
           vec3 iOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
           float phase = iOrigin.x * 0.09 + iOrigin.z * 0.13;
           /* Two frequencies: a slow gust that travels across the field and a
              faster flutter on top of it. */
           float gust = sin(uTime * 0.55 + phase) * 0.65 + sin(uTime * 1.9 + phase * 2.1) * 0.35;
           float up = clamp(transformed.y / ${amount.toFixed(2)}, 0.0, 1.0);
           float bend = up * up * uWind * gust;
           transformed.x += bend;
           transformed.z += bend * 0.45;
         }`,
      );
  };
  /* Changing onBeforeCompile after a material has been compiled does nothing
     unless the program is invalidated, and a cached key collision would silently
     hand us somebody else's shader. */
  base.customProgramCacheKey = () => `firstlight-wind-${amount}`;
  return base;
}

/** A tapered blade: cheap, two-sided, and shaped rather than a flat quad. */
function bladeGeometry(height: number, width: number, segments = 4): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(width, height, 1, segments);
  g.translate(0, height / 2, 0);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / height;
    /* Taper to a point, and lean the tip over so a still blade is not a
       perfectly straight line — nothing in nature is. */
    pos.setX(i, pos.getX(i) * (1 - t * 0.85));
    pos.setZ(i, pos.getZ(i) + t * t * height * 0.16);
  }
  g.computeVertexNormals();
  return g;
}

/** A pine, built from two stacked cones. Read at 60 m; it does not need more. */
function pineGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.16, 0.26, 2.4, 5);
  trunk.translate(0, 1.2, 0);
  parts.push(trunk);
  for (let i = 0; i < 3; i++) {
    const r = 1.9 - i * 0.45;
    const h = 3.4 - i * 0.5;
    const c = new THREE.ConeGeometry(r, h, 7);
    c.translate(0, 2.4 + i * 1.75 + h / 2 - 0.6, 0);
    parts.push(c);
  }
  const merged = mergeSimple(parts);
  parts.forEach((p) => p.dispose());
  return merged;
}

/**
 * Minimal geometry merge. `BufferGeometryUtils` would do this, but it is a
 * 40 kB import for four cones and it insists every input carries an identical
 * attribute set — which these do not, since cones and cylinders differ on uv.
 */
function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vertCount = 0;
  let idxCount = 0;
  for (const g of geos) {
    vertCount += g.attributes.position.count;
    idxCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const position = new Float32Array(vertCount * 3);
  const normal = new Float32Array(vertCount * 3);
  const index = new Uint32Array(idxCount);
  let vo = 0;
  let io = 0;
  for (const g of geos) {
    const p = g.attributes.position as THREE.BufferAttribute;
    const n = g.attributes.normal as THREE.BufferAttribute;
    position.set(p.array as Float32Array, vo * 3);
    normal.set(n.array as Float32Array, vo * 3);
    const gi = g.index;
    if (gi) {
      for (let i = 0; i < gi.count; i++) index[io + i] = gi.getX(i) + vo;
      io += gi.count;
    } else {
      for (let i = 0; i < p.count; i++) index[io + i] = i + vo;
      io += p.count;
    }
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(position, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  return out;
}

export function createFlora(opts: { terrain: Terrain; density: number; castShadows: boolean }): Flora {
  const { terrain } = opts;
  const group = new THREE.Group();
  const rng = mulberry32(90210);
  const clump = createNoise2D(mulberry32(31337));
  const wind: WindUniforms = { uTime: { value: 0 }, uWind: { value: 0.16 } };

  const disposables: { dispose(): void }[] = [];
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();

  /* ---- reeds: the shallows, and the thing that sells the waterline -------- */
  const reedCount = Math.floor(42000 * opts.density);
  const reedGeo = bladeGeometry(1.5, 0.085, 5);
  const reedMat = makeWindMaterial(
    new THREE.MeshStandardMaterial({
      color: 0x8a9455,
      roughness: 0.82,
      side: THREE.DoubleSide,
      vertexColors: true,
      /* A cheap stand-in for the light that passes *through* a reed. They are
         edge-on to a low sun and one blade thick, so in life they glow; without
         this they render as black wire against a bright lake, which is what the
         first captures of the shoreline looked like. */
      emissive: new THREE.Color(0x2a2410),
      emissiveIntensity: 1,
    }),
    wind,
    1.5,
  );
  const reeds = new THREE.InstancedMesh(reedGeo, reedMat, reedCount);
  reeds.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(reedCount * 3), 3);
  let placed = 0;
  /* Rejection sampling against the height field. Cheaper and far simpler than
     solving for the shoreline, and the shore is a closed curve by construction
     (see terrain.ts) so this always terminates. */
  for (let attempt = 0; attempt < reedCount * 40 && placed < reedCount; attempt++) {
    const a = rng() * Math.PI * 2;
    const r = (0.17 + Math.sqrt(rng()) * 0.28) * WORLD_SIZE * 0.5;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = terrain.heightAt(x, z);
    /* Reeds stand in the shallows: ankle-deep to just above the line. The band
       started at 1.5 m below the surface, which put whole stands of them out in
       open water looking like burnt matchsticks — reeds root where they can
       still reach the light, so the deep end is much shallower than instinct
       suggests. */
    if (y < WATER_LEVEL - 0.55 || y > WATER_LEVEL + 0.45) continue;
    /* Clump, so the bank has stands of reed and bare patches rather than an
       even lawn of them. */
    /* Stands, not a hedge. An even scatter along the waterline reads as a
       picket fence — what breaks it is a low threshold on a coarse noise, so
       most of the shore is bare and the reeds are concentrated where they are.*/
    if (clump(x * 0.028, z * 0.028) < 0.12) continue;

    /* Squared, so most reeds are short and a few are tall. A uniform
       distribution gives every blade the same height and the stand reads as
       something manufactured. */
    const s = 0.42 + rng() * rng() * 1.55;
    dummy.position.set(x, y - 0.15, z);
    dummy.rotation.set((rng() - 0.5) * 0.12, rng() * Math.PI * 2, (rng() - 0.5) * 0.12);
    dummy.scale.set(1, s, 1);
    dummy.updateMatrix();
    reeds.setMatrixAt(placed, dummy.matrix);
    tint.setHSL(0.15 + rng() * 0.07, 0.3 + rng() * 0.2, 0.36 + rng() * 0.2);
    reeds.setColorAt(placed, tint);
    placed++;
  }
  reeds.count = placed;
  reeds.instanceMatrix.needsUpdate = true;
  if (reeds.instanceColor) reeds.instanceColor.needsUpdate = true;
  reeds.castShadow = opts.castShadows;
  reeds.receiveShadow = true;
  /* The bounding sphere is computed from instance 0 only, so with the origin at
     the lake centre three frustum-culls the whole field the moment you look
     away from the middle. */
  reeds.frustumCulled = false;
  group.add(reeds);
  disposables.push(reedGeo, reedMat);

  /* ---- grass: the banks ------------------------------------------------- */
  const grassCount = Math.floor(26000 * opts.density);
  const grassGeo = bladeGeometry(0.85, 0.055, 3);
  const grassMat = makeWindMaterial(
    new THREE.MeshStandardMaterial({
      color: 0x5c6b3f,
      roughness: 0.92,
      side: THREE.DoubleSide,
      vertexColors: true,
    }),
    wind,
    0.85,
  );
  const grass = new THREE.InstancedMesh(grassGeo, grassMat, grassCount);
  grass.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(grassCount * 3), 3);
  let gPlaced = 0;
  for (let attempt = 0; attempt < grassCount * 30 && gPlaced < grassCount; attempt++) {
    const a = rng() * Math.PI * 2;
    const r = (0.2 + Math.sqrt(rng()) * 0.5) * WORLD_SIZE * 0.5;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = terrain.heightAt(x, z);
    if (y < WATER_LEVEL - 0.1 || y > 26) continue;
    const n = terrain.normalAt(x, z);
    /* Nothing grows on a cliff. */
    if (n.y < 0.82) continue;

    dummy.position.set(x, y - 0.05, z);
    dummy.rotation.set(0, rng() * Math.PI * 2, 0);
    dummy.scale.setScalar(0.6 + rng() * 0.9);
    dummy.updateMatrix();
    grass.setMatrixAt(gPlaced, dummy.matrix);
    tint.setHSL(0.22 + rng() * 0.06, 0.2 + rng() * 0.18, 0.26 + rng() * 0.18);
    grass.setColorAt(gPlaced, tint);
    gPlaced++;
  }
  grass.count = gPlaced;
  grass.instanceMatrix.needsUpdate = true;
  if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
  grass.castShadow = false; // 26k shadow casters for 0.8 m blades is not worth a millisecond
  grass.receiveShadow = true;
  grass.frustumCulled = false;
  group.add(grass);
  disposables.push(grassGeo, grassMat);

  /* ---- pines: the ridge line -------------------------------------------- */
  const pineCount = Math.floor(1400 * opts.density);
  const pineGeo = pineGeometry();
  const pineMat = new THREE.MeshStandardMaterial({
    color: 0x2f3a2c,
    roughness: 0.95,
    vertexColors: true,
    flatShading: true,
  });
  const pines = new THREE.InstancedMesh(pineGeo, pineMat, pineCount);
  pines.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(pineCount * 3), 3);
  let pPlaced = 0;
  for (let attempt = 0; attempt < pineCount * 40 && pPlaced < pineCount; attempt++) {
    const a = rng() * Math.PI * 2;
    const r = (0.3 + Math.sqrt(rng()) * 0.68) * WORLD_SIZE * 0.5;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = terrain.heightAt(x, z);
    if (y < 7 || y > 52) continue;
    const n = terrain.normalAt(x, z);
    if (n.y < 0.74) continue;
    /* A treeline: thinning out with altitude rather than stopping dead. */
    if (rng() > 1 - Math.min(0.85, (y - 7) / 46)) continue;

    dummy.position.set(x, y - 0.3, z);
    dummy.rotation.set(0, rng() * Math.PI * 2, 0);
    dummy.scale.setScalar(0.75 + rng() * 0.8);
    dummy.updateMatrix();
    pines.setMatrixAt(pPlaced, dummy.matrix);
    tint.setHSL(0.28 + rng() * 0.05, 0.18 + rng() * 0.14, 0.13 + rng() * 0.09);
    pines.setColorAt(pPlaced, tint);
    pPlaced++;
  }
  pines.count = pPlaced;
  pines.instanceMatrix.needsUpdate = true;
  if (pines.instanceColor) pines.instanceColor.needsUpdate = true;
  pines.castShadow = opts.castShadows;
  pines.receiveShadow = true;
  pines.frustumCulled = false;
  group.add(pines);
  disposables.push(pineGeo, pineMat);

  return {
    group,
    update(elapsed) {
      wind.uTime.value = elapsed;
      /* The wind itself breathes — it gets up and drops away over about half a
         minute, which is what stops a constant sway reading as a loop. */
      wind.uWind.value = 0.11 + Math.sin(elapsed * 0.13) * 0.05 + Math.sin(elapsed * 0.041) * 0.04;
    },
    dispose() {
      for (const d of disposables) d.dispose();
      group.clear();
    },
  };
}
