/**
 * The ground: one fine mesh over the walkable core and a coarse ring out to
 * the horizon, coloured per vertex from the map and given its detail in the
 * fragment shader (paving joints on the quay, strata in the cliffs, mottled
 * grass, and caustics on the sea bed), so there are no textures to fetch.
 *
 * No backticks inside the GLSL: it is a template literal.
 */
import * as THREE from "three";
import { EXTENT, Ground, groundType, heightAt, slopeAt, sBay, townMask } from "./map";
import { fbm2 } from "@/shared/proc/rng";

const C = {
  grass: new THREE.Color("#8cbc3e"),
  grassDry: new THREE.Color("#c2c45a"),
  grassDeep: new THREE.Color("#5e9a31"),
  dirt: new THREE.Color("#c4a06a"),
  sand: new THREE.Color("#ecdcae"),
  paving: new THREE.Color("#e6d3ab"),
  rock: new THREE.Color("#a7977c"),
  cliff: new THREE.Color("#bba98b"),
  bedShallow: new THREE.Color("#efe0b4"),
  bedDeep: new THREE.Color("#7fb0a6"),
};

const tmp = new THREE.Color();

function colourAt(x: number, z: number, h: number, out: THREE.Color): { pave: number; rock: number } {
  const slope = slopeAt(x, z);
  const g = groundType(x, z, h, slope);
  const n = fbm2(x * 0.045, z * 0.045, 3, 2, 0.5, 31);
  const n2 = fbm2(x * 0.2, z * 0.2, 2, 2, 0.5, 32);
  let pave = 0, rock = 0;
  switch (g) {
    case Ground.Sea: {
      const t = Math.min(1, -h / 9);
      out.copy(C.bedShallow).lerp(C.bedDeep, t);
      break;
    }
    case Ground.Sand: out.copy(C.sand).multiplyScalar(0.95 + n2 * 0.08); break;
    case Ground.Paving:
      out.copy(C.paving).multiplyScalar(0.93 + n2 * 0.1);
      pave = 1;
      break;
    case Ground.Dirt: out.copy(C.dirt).multiplyScalar(0.94 + n2 * 0.1); break;
    case Ground.Rock: out.copy(C.rock).multiplyScalar(0.9 + n2 * 0.12); rock = 0.6; break;
    case Ground.Cliff: out.copy(C.cliff).multiplyScalar(0.88 + n2 * 0.14); rock = 1; break;
    default: {
      // Sunny meadow: deep green in the hollows, dry gold on the tops.
      out.copy(C.grass);
      if (n > 0.1) out.lerp(C.grassDry, Math.min(1, (n - 0.1) * 2.2));
      else out.lerp(C.grassDeep, Math.min(1, (0.1 - n) * 2.4));
      out.multiplyScalar(0.94 + n2 * 0.08);
      // High mountain grass is cooler.
      if (h > 45) out.lerp(tmp.set("#7aa452"), Math.min(1, (h - 45) / 60) * 0.6);
    }
  }
  // Soften the line where grass meets rock.
  if (g === Ground.Grass && slope > 0.6) out.lerp(C.rock, Math.min(1, (slope - 0.6) / 0.2) * 0.5);
  // A paved town terrace is lighter than the quay.
  if (g === Ground.Paving && townMask(x, z) > 0.5 && -sBay(x, z) > 30) out.multiplyScalar(1.03);
  return { pave, rock };
}

function grid(half: number, segs: number, hole: number): THREE.BufferGeometry {
  const n = segs + 1;
  const pos = new Float32Array(n * n * 3);
  const col = new Float32Array(n * n * 3);
  const extra = new Float32Array(n * n * 2);
  const c = new THREE.Color();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -half + (i / segs) * half * 2;
      const z = -half + (j / segs) * half * 2;
      const h = heightAt(x, z);
      const k = j * n + i;
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      const e = colourAt(x, z, h, c);
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
      extra[k * 2] = e.pave; extra[k * 2 + 1] = e.rock;
    }
  }
  const index: number[] = [];
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const x0 = -half + (i / segs) * half * 2, x1 = -half + ((i + 1) / segs) * half * 2;
      const z0 = -half + (j / segs) * half * 2, z1 = -half + ((j + 1) / segs) * half * 2;
      if (hole > 0 && Math.max(Math.abs(x0), Math.abs(x1)) <= hole && Math.max(Math.abs(z0), Math.abs(z1)) <= hole) continue;
      const a = j * n + i, b = a + 1, d = a + n, e = d + 1;
      index.push(a, d, b, b, d, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("aSurf", new THREE.BufferAttribute(extra, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

const VERT_HEAD = /* glsl */ `
attribute vec2 aSurf;
varying vec2 vSurf;
varying vec3 vWorld;
`;
const VERT_BODY = /* glsl */ `
#include <worldpos_vertex>
vSurf = aSurf;
vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const FRAG_HEAD = /* glsl */ `
uniform float uTime;
varying vec2 vSurf;
varying vec3 vWorld;
float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x), mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float caustic(vec2 p, float t) {
  float c = 0.0;
  vec2 q = p;
  for (int i = 0; i < 3; i++) {
    q = vec2(q.x + sin(q.y * 1.3 + t * 0.9), q.y + cos(q.x * 1.1 - t * 0.7));
    c += 0.5 / (0.25 + abs(sin(q.x + q.y * 0.5)));
  }
  return c / 3.0;
}
`;

const FRAG_COLOR = /* glsl */ `
#include <color_fragment>
{
  vec2 wp = vWorld.xz;
  float fine = tNoise(wp * 2.3) * 0.5 + tNoise(wp * 7.1) * 0.5;
  // Paving: rows of flagstones with offset joints.
  if (vSurf.x > 0.5) {
    vec2 f = wp / vec2(1.6, 1.05);
    f.x += step(1.0, mod(floor(f.y), 2.0)) * 0.5;
    vec2 g = fract(f);
    float joint = min(min(g.x, 1.0 - g.x) * 1.6, min(g.y, 1.0 - g.y) * 1.05);
    float j = smoothstep(0.0, 0.035, joint);
    float tone = 0.9 + tHash(floor(f)) * 0.16;
    diffuseColor.rgb *= mix(0.72, tone, j);
  }
  // Rock: strata, so cliffs read as layered limestone.
  if (vSurf.y > 0.2) {
    float s = sin(vWorld.y * 2.6 + tNoise(wp * 0.3) * 4.0);
    diffuseColor.rgb *= mix(1.0, 0.86 + 0.16 * smoothstep(-0.4, 0.8, s), vSurf.y);
  }
  diffuseColor.rgb *= 0.92 + fine * 0.14;
  // The sea bed: caustics where the light still reaches.
  if (vWorld.y < -0.1) {
    float depth = -vWorld.y;
    float c = caustic(wp * 0.55, uTime);
    diffuseColor.rgb += vec3(0.55, 0.62, 0.5) * pow(c * 0.42, 3.0) * exp(-depth * 0.35);
  }
}
`;

export interface Terrain {
  group: THREE.Group;
  /** The fine mesh, for pointing at in VR. */
  core: THREE.Mesh;
  update(time: number): void;
  dispose(): void;
}

export function createTerrain(opts: { coreSegs?: number } = {}): Terrain {
  const group = new THREE.Group();
  group.name = "terrain";
  const uniforms = { uTime: { value: 0 } };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + VERT_HEAD)
      .replace("#include <worldpos_vertex>", VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + FRAG_HEAD)
      .replace("#include <color_fragment>", FRAG_COLOR);
  };
  mat.customProgramCacheKey = () => "thalassa-terrain";

  const CORE = 236;
  const core = new THREE.Mesh(grid(CORE, opts.coreSegs ?? 336, 0), mat);
  core.receiveShadow = true;
  core.castShadow = true;
  core.name = "terrain-core";
  const far = new THREE.Mesh(grid(EXTENT, 130, CORE - 4), mat);
  far.receiveShadow = true;
  far.name = "terrain-far";
  // Tucked under the fine mesh where the two overlap.
  far.position.y = -0.35;
  group.add(core, far);

  return {
    group,
    core,
    update(time) { uniforms.uTime.value = time; },
    dispose() {
      core.geometry.dispose();
      far.geometry.dispose();
      mat.dispose();
    },
  };
}
