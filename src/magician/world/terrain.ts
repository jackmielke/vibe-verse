/**
 * The ground, the water, and the paths, built once from `heightAt`.
 *
 * Colour lives in the vertices (grass by height and slope, dirt on the
 * paths, sand at the water's edge) and a `uSnow` uniform blends the whole
 * thing toward white for winter, so a season change is a single number
 * rather than a rebuild of 130k vertices.
 */
import * as THREE from "three";
import { fbm, heightAt, riverDistance, WATER_LEVEL, WORLD_HALF } from "./noise";

export interface Terrain {
  group: THREE.Group;
  /** 0–1 snow cover. */
  setSnow(v: number): void;
  /** Multiplied into every ground colour. */
  setTint(c: THREE.Color): void;
  /** Flood height offset in metres. */
  setWater(level: number): void;
  /** Wet ground darkens and shines a little. */
  setWet(v: number): void;
  update(dt: number, time: number): void;
  dispose(): void;
}

const grassLow = new THREE.Color("#6faa4e");
const grassHigh = new THREE.Color("#8fbb62");
const rockCol = new THREE.Color("#7c7469");
const sandCol = new THREE.Color("#c9b98a");
const dirtCol = new THREE.Color("#9c7d55");
const paddyCol = new THREE.Color("#5f9a3d");

/** Whether a point is on one of the valley's dirt paths. */
export function pathAt(x: number, z: number): number {
  // Main road: village to bridge to paddies, gently curving.
  const road1 = Math.abs(z - (Math.sin(x * 0.03) * 6 - 4)) - 2.2;
  // Path up to the shrine.
  const t = Math.max(0, Math.min(1, (-(x) - 8) / 40));
  const sx = -8 - t * 38;
  const sz = -6 - t * 56 + Math.sin(t * 6) * 4;
  const road2 = Math.hypot(x - sx, z - sz) - 2;
  // Path north to the torii.
  const road3 = Math.abs(x - (-30 + Math.sin(z * 0.08) * 3)) - 1.6;
  const zOk = z < -6 && z > -34;
  const d = Math.min(road1, road2, zOk ? road3 : 99);
  return Math.max(0, Math.min(1, 1 - d / 1.4));
}

export function createTerrain(): Terrain {
  const group = new THREE.Group();
  const size = WORLD_HALF * 2;
  const segs = 190;
  const geo = new THREE.PlaneGeometry(size, size, segs, segs);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = heightAt(x, z);
    pos.setY(i, h);
    // Slope from neighbours.
    const dx = heightAt(x + 1.5, z) - heightAt(x - 1.5, z);
    const dz = heightAt(x, z + 1.5) - heightAt(x, z - 1.5);
    const slope = Math.min(1, Math.hypot(dx, dz) / 3);
    const n = fbm(x * 0.05 + 9, z * 0.05 + 2, 2);
    c.copy(grassLow).lerp(grassHigh, Math.min(1, h / 40 + n * 0.5));
    if (slope > 0.45) c.lerp(rockCol, Math.min(1, (slope - 0.45) * 2.2));
    if (h > 70) c.lerp(rockCol, Math.min(1, (h - 70) / 40));
    if (h > 118) c.lerp(new THREE.Color("#e8ecef"), Math.min(1, (h - 118) / 25));
    const rd = riverDistance(x, z);
    if (rd < 11) c.lerp(sandCol, Math.max(0, 1 - rd / 11) * 0.8);
    const p = pathAt(x, z);
    if (p > 0) c.lerp(dirtCol, p);
    const pd = Math.hypot((x - 42) / 1.4, z - 30);
    if (pd < 33) c.lerp(paddyCol, 0.6);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const uniforms = { uSnow: { value: 0 }, uWet: { value: 0 } };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSnow = uniforms.uSnow;
    shader.uniforms.uWet = uniforms.uWet;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;\nvarying float vUp;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvUp = normalize(mat3(modelMatrix) * objectNormal).y;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uSnow;\nuniform float uWet;\nvarying vec3 vWorldPos;\nvarying float vUp;")
      .replace(
        "#include <color_fragment>",
        [
          "#include <color_fragment>",
          "vec2 cellA = floor(vWorldPos.xz * 3.0); vec2 cellB = floor(vWorldPos.xz * 0.7);",
          "float speck = fract(sin(dot(cellA, vec2(12.9898, 78.233))) * 43758.5453);",
          "float patch = fract(sin(dot(cellB, vec2(39.3468, 11.135))) * 24634.6345);",
          "diffuseColor.rgb *= 0.9 + 0.16 * speck + 0.1 * patch - 0.08;",
          "float snowMask = smoothstep(0.55, 0.9, vUp) * uSnow;",
          "diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), snowMask);",
          "diffuseColor.rgb *= 1.0 - uWet * 0.28;",
        ].join("\n"),
      )
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.35, uWet);");
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = "terrain";
  group.add(mesh);

  // Water: one big plane just below the valley floor. The river channel and
  // the lake bed dip under it; the flood raises it over everything.
  const waterGeo = new THREE.PlaneGeometry(size, size, 1, 1);
  waterGeo.rotateX(-Math.PI / 2);
  const waterMat = new THREE.MeshPhysicalMaterial({
    color: "#3f86a8",
    transparent: true,
    opacity: 0.78,
    roughness: 0.12,
    metalness: 0.15,
    transmission: 0,
    emissive: new THREE.Color("#0c2733"),
    emissiveIntensity: 0.25,
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.y = WATER_LEVEL;
  water.name = "water";
  water.receiveShadow = true;
  group.add(water);

  // Paddies: thin sheets of water on the terraces, each its own level.
  const paddyMat = new THREE.MeshPhysicalMaterial({ color: "#5aa0b8", transparent: true, opacity: 0.6, roughness: 0.1, metalness: 0.2 });
  for (let row = -3; row <= 3; row++) {
    const z0 = 30 + row * 9;
    const g = new THREE.PlaneGeometry(58, 7.6, 1, 1);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, paddyMat);
    m.position.set(42, 0.6 + (row + 3) * 0.35 + 0.1, z0 + 4.5);
    group.add(m);
    // Paddy bund (the earth wall between terraces).
    const bund = new THREE.Mesh(new THREE.BoxGeometry(58, 0.5, 0.7), new THREE.MeshStandardMaterial({ color: "#7d6a48", roughness: 1 }));
    bund.position.set(42, 0.6 + (row + 3) * 0.35 + 0.05, z0);
    group.add(bund);
  }

  const tintColor = new THREE.Color(1, 1, 1);
  let floodLevel = 0;
  let t = 0;
  return {
    group,
    setSnow(v) { uniforms.uSnow.value = v; },
    setTint(col) { tintColor.copy(col); mat.color.copy(col); },
    setWater(level) { floodLevel = level; },
    setWet(v) { uniforms.uWet.value = v; },
    update(dt, time) {
      t += dt;
      const target = WATER_LEVEL + floodLevel;
      water.position.y += (target - water.position.y) * Math.min(1, dt * 0.8);
      water.position.y += Math.sin(time * 0.9) * 0.002;
      waterMat.opacity = 0.7 + Math.sin(time * 0.5) * 0.04;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      waterGeo.dispose();
      waterMat.dispose();
      paddyMat.dispose();
    },
  };
}
