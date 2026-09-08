/**
 * The ground: a heightfield from the terrain tiles at about three metres a
 * sample, resampled to one metre near the road so driveways and lawns sit on
 * it cleanly, coloured by what the land data says grows there (forest floor
 * under the wood polygons, lawn near houses, sand on the beach), and Rich
 * Passage at sea level with a shore.
 */
import * as THREE from "three";
import { pointInRing, rings, type Neighbourhood, type Terrain } from "./geo";
import { disposeSurface, forestFloor, grass, surfaceMaterial } from "./textures";

export interface Ground {
  group: THREE.Group;
  /** World height including the sea clamp. */
  heightAt(x: number, z: number): number;
  update(time: number): void;
  dispose(): void;
}

const WATER_VERT = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
varying vec2 vUv;
void main() {
  vec3 p = position;
  p.y += sin(p.x * 0.11 + uTime * 0.7) * 0.06 + sin(p.z * 0.09 - uTime * 0.5) * 0.05;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const WATER_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uCamera; uniform float uTime; uniform vec3 uSkyColor; uniform vec3 uDeep;
varying vec3 vWorld;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
void main() {
  vec3 V = normalize(uCamera - vWorld);
  // Small ripples as a normal perturbation.
  float n1 = vnoise(vWorld.xz * 0.6 + uTime * 0.15);
  float n2 = vnoise(vWorld.xz * 1.7 - uTime * 0.11);
  vec3 N = normalize(vec3((n1 - 0.5) * 0.25, 1.0, (n2 - 0.5) * 0.25));
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  vec3 col = mix(uDeep, uSkyColor, 0.35 + 0.6 * fres);
  // Sun glitter to the south-west.
  vec3 L = normalize(vec3(-0.58, 0.57, 0.58));
  vec3 H = normalize(L + V);
  col += vec3(1.0, 0.95, 0.85) * pow(max(dot(N, H), 0.0), 240.0) * 0.8;
  gl_FragColor = vec4(col, 1.0);
}
`;

export function buildGround(data: Neighbourhood, terrain: Terrain): Ground {
  const group = new THREE.Group();
  const [tl, br] = data.bbox;
  const pad = 120;
  const x0 = tl[0] - pad;
  const z0 = tl[1] - pad;
  const x1 = br[0] + pad;
  const z1 = br[1] + pad;
  const step = 2;
  const nx = Math.ceil((x1 - x0) / step) + 1;
  const nz = Math.ceil((z1 - z0) / step) + 1;

  const forest = data.land.filter((l) => l.sub === "forest" || l.sub === "shrub").flatMap((l) => rings(l.g));
  const sand = data.land.filter((l) => l.sub === "sand").flatMap((l) => rings(l.g));
  const lawnish = data.landuse.filter((l) => l.sub === "residential" || l.sub === "recreation" || l.sub === "education" || l.sub === "agriculture").flatMap((l) => rings(l.g));
  const forestBounds = forest.map((r) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of r) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
    }
    return { r, minX, maxX, minZ, maxZ };
  });
  const inAny = (x: number, z: number, list: { r: number[][]; minX: number; maxX: number; minZ: number; maxZ: number }[]) => {
    for (const b of list) if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && pointInRing(x, z, b.r)) return true;
    return false;
  };
  const sandB = sand.map((r) => ({ r, minX: Math.min(...r.map((p) => p[0])), maxX: Math.max(...r.map((p) => p[0])), minZ: Math.min(...r.map((p) => p[1])), maxZ: Math.max(...r.map((p) => p[1])) }));
  void lawnish;

  const heightAt = (x: number, z: number) => Math.max(-3, terrain.at(x, z));

  const pos = new Float32Array(nx * nz * 3);
  const uv = new Float32Array(nx * nz * 2);
  const kind = new Float32Array(nx * nz); // 0 grass, 1 forest floor, 2 sand
  const idx: number[] = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * step;
      const z = z0 + j * step;
      const k = j * nx + i;
      pos[k * 3] = x;
      pos[k * 3 + 1] = heightAt(x, z);
      pos[k * 3 + 2] = z;
      uv[k * 2] = x / 6;
      uv[k * 2 + 1] = z / 6;
      kind[k] = inAny(x, z, sandB) || pos[k * 3 + 1] < 1.2 ? 2 : inAny(x, z, forestBounds) ? 1 : 0;
    }
  }
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      idx.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("aKind", new THREE.BufferAttribute(kind, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const lawn = grass();
  const floor = forestFloor();
  const mat = surfaceMaterial(lawn);
  // Blend the forest floor and the sand in by the per-vertex kind.
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFloor = { value: floor.map };
    shader.uniforms.uFloorN = { value: floor.normalMap };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aKind; varying float vKind;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\nvKind = aKind;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D uFloor; uniform sampler2D uFloorN; varying float vKind;")
      .replace(
        "#include <map_fragment>",
        `vec4 lawnC = texture2D(map, vMapUv);
         vec4 floorC = texture2D(uFloor, vMapUv * 1.4);
         vec4 sandC = vec4(0.72, 0.66, 0.52, 1.0) * (0.85 + 0.3 * fract(sin(dot(floor(vMapUv * 90.0), vec2(12.9898, 78.233))) * 43758.5453));
         float f = clamp(vKind, 0.0, 1.0);
         float sd = clamp(vKind - 1.0, 0.0, 1.0);
         vec4 texelColor = mix(mix(lawnC, floorC, f), sandC, sd);
         diffuseColor *= texelColor;`,
      )
      .replace("#include <normal_fragment_maps>", `
        vec3 mapN = mix(texture2D(normalMap, vNormalMapUv).xyz, texture2D(uFloorN, vNormalMapUv * 1.4).xyz, clamp(vKind, 0.0, 1.0)) * 2.0 - 1.0;
        mapN.xy *= normalScale;
        normal = normalize( tbn * mapN );`);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  group.add(mesh);

  // The sea: Rich Passage, at 0 m, out to the horizon.
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(9000, 9000, 60, 60).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uCamera: { value: new THREE.Vector3() },
        uSkyColor: { value: new THREE.Color(0x9fb4c6) },
        uDeep: { value: new THREE.Color(0x1f3a48) },
      },
    }),
  );
  water.position.y = 0.05;
  water.position.set(0, 0.05, 400);
  group.add(water);

  return {
    group,
    heightAt,
    update(time) {
      (water.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      disposeSurface(lawn);
      disposeSurface(floor);
      water.geometry.dispose();
      (water.material as THREE.Material).dispose();
    },
  };
}

/** Let the water shader know where the eye is. */
export function updateWaterCamera(ground: Ground, camera: THREE.Camera): void {
  const water = ground.group.children.find((c) => (c as THREE.Mesh).material && ((c as THREE.Mesh).material as THREE.ShaderMaterial).uniforms?.uCamera) as THREE.Mesh | undefined;
  if (water) ((water.material as THREE.ShaderMaterial).uniforms.uCamera.value as THREE.Vector3).copy(camera.position);
}
