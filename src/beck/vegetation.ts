/**
 * The forest, which on Bainbridge is most of what you see. The land data
 * maps about nine hectares of wood in a box of a hundred and seventy, so
 * the rest is inferred: anywhere that is not road, house, lawn, pitch,
 * field or beach carries second-growth Douglas fir and western red cedar at
 * a mature stand's spacing, with big-leaf maple and red alder along the
 * roads and the streams, madrona leaning out over the water, and salal,
 * sword fern, Oregon grape, huckleberry and blackberry under all of it.
 * Yards keep a few big firs, a hedge where the data has one, and the
 * rhododendrons and hydrangeas everybody plants. Every tree is built from
 * instanced pieces (a trunk, then branch cards in whorls) so no two are the
 * same, tiled so only the stands near the eye draw in full while the rest
 * of the island is a single billboard per tree, and swayed by a slow wind.
 */
import * as THREE from "three";
import { lines, mulberry32, pointInRing, resample, ringBounds, rings, roadWidth, type Neighbourhood } from "./geo";
import type { Buildings } from "./buildings";
import type { Ground } from "./terrain";
import { disposeSurface, surfaceMaterial, type Surface } from "./textures";
import { BROADLEAF, CONIFER, IMPOSTOR, UNDER, atlasCell, barkTexture, broadleafAtlas, coniferAtlas, duffAtlas, impostorAtlas, understoryAtlas, type Atlas, type BarkKind } from "./textures.trees";

export interface Vegetation {
  group: THREE.Group;
  trunks: { x: number; z: number; r: number }[];
  update(time: number, wind: number): void;
  dispose(): void;
}

type Species = "fir" | "cedar" | "maple" | "alder" | "madrona";

/** Beyond this the stand is billboards; inside it every branch draws. */
const DETAIL_RANGE = 210;
const UNDERSTORY_RANGE = 140;
const TILE = 90;

// ---- Instance buffers ------------------------------------------------------------

/** A growable list of instance matrices plus two vec4 attributes, written straight into typed arrays. */
class Writer {
  n = 0;
  mats = new Float32Array(16 * 256);
  cells = new Float32Array(4 * 256);
  trees = new Float32Array(4 * 256);
  push(m: THREE.Matrix4, cell: { u: number; v: number; su: number; sv: number }, tx: number, ty: number, tz: number, th: number) {
    if (this.n * 16 >= this.mats.length) {
      const grow = (a: Float32Array, k: number) => {
        const b = new Float32Array(a.length * 2);
        b.set(a);
        return b;
      };
      this.mats = grow(this.mats, 16);
      this.cells = grow(this.cells, 4);
      this.trees = grow(this.trees, 4);
    }
    const i = this.n++;
    m.toArray(this.mats, i * 16);
    this.cells[i * 4] = cell.u;
    this.cells[i * 4 + 1] = cell.v;
    this.cells[i * 4 + 2] = cell.su;
    this.cells[i * 4 + 3] = cell.sv;
    this.trees[i * 4] = tx;
    this.trees[i * 4 + 1] = ty;
    this.trees[i * 4 + 2] = tz;
    this.trees[i * 4 + 3] = th;
  }
  mesh(geo: THREE.BufferGeometry, mat: THREE.Material, shadow: boolean, depth?: THREE.Material): THREE.InstancedMesh | null {
    if (this.n === 0) return null;
    const g = geo.clone();
    g.setAttribute("aCell", new THREE.InstancedBufferAttribute(this.cells.subarray(0, this.n * 4), 4));
    g.setAttribute("aTree", new THREE.InstancedBufferAttribute(this.trees.subarray(0, this.n * 4), 4));
    const mesh = new THREE.InstancedMesh(g, mat, this.n);
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(this.mats.subarray(0, this.n * 16), 16);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    if (depth) mesh.customDepthMaterial = depth;
    mesh.computeBoundingSphere();
    return mesh;
  }
}

// ---- Geometry ----------------------------------------------------------------------

/** A tube up +y from 0 to 1 with a radius profile, optional fluting at the base, optional caps. */
function tube(profile: (t: number) => number, segs: number, ringsN: number, flute: number, fluteN: number, caps: boolean): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= ringsN; j++) {
    const t = j / ringsN;
    const base = profile(t);
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const r = base * (1 + flute * Math.cos(a * fluteN) * Math.pow(1 - t, 5));
      pos.push(Math.cos(a) * r, t, Math.sin(a) * r);
      uv.push(i / segs, t);
    }
  }
  for (let j = 0; j < ringsN; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i;
      idx.push(a, a + 1, a + segs + 1, a + 1, a + segs + 2, a + segs + 1);
    }
  }
  if (caps) {
    for (const t of [0, 1]) {
      const c = pos.length / 3;
      pos.push(0, t, 0);
      uv.push(0.5, 0.5);
      const r = profile(t);
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        pos.push(Math.cos(a) * r, t, Math.sin(a) * r);
        uv.push(0.5 + Math.cos(a) * 0.3, 0.5 + Math.sin(a) * 0.3);
      }
      for (let i = 0; i < segs; i++) {
        if (t === 1) idx.push(c, c + 1 + i, c + 2 + i);
        else idx.push(c, c + 2 + i, c + 1 + i);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A branch: a fan of three bent planes sharing the branch axis (+y from the
 * origin, one unit long, one unit wide). The roll-zero plane is the flat
 * spray itself; the two at sixty degrees give it depth from every side. The
 * bend is a droop along the branch and an upturn at the tip, in local +z.
 */
function branchGeometry(droop: number, upturn: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const segsL = 4;
  for (const roll of [0, 1.05, -1.05]) {
    const cx = Math.cos(roll);
    const sx = Math.sin(roll);
    const start = pos.length / 3;
    for (let j = 0; j <= segsL; j++) {
      const t = j / segsL;
      const bend = -droop * Math.sin(Math.PI * t) + upturn * t * t * t;
      for (const x of [-0.5, 0.5]) {
        pos.push(x * cx, t, x * sx + bend);
        uv.push(x + 0.5, t);
      }
    }
    for (let j = 0; j < segsL; j++) {
      const a = start + j * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Two crossed vertical planes, one unit wide and tall, pivot at the bottom centre. */
function crossGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const roll of [0, Math.PI / 2]) {
    const cx = Math.cos(roll);
    const sx = Math.sin(roll);
    const s = pos.length / 3;
    for (const y of [0, 1]) {
      for (const x of [-0.5, 0.5]) {
        pos.push(x * cx, y, x * sx);
        uv.push(x + 0.5, y);
      }
    }
    idx.push(s, s + 1, s + 2, s + 1, s + 3, s + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function quadGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  g.translate(0, 0.5, 0);
  return g;
}

function flatGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

// ---- Shaders --------------------------------------------------------------------------

type Shader = { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> };

const ATTRS = "attribute vec4 aCell; attribute vec4 aTree; uniform float uTime; uniform float uWind;";

/** Atlas cell lookup, wind and a foliage normal, patched into a standard or depth material. */
function patchFoliage(shader: Shader, uTime: THREE.IUniform, uWind: THREE.IUniform, lit: boolean) {
  shader.uniforms.uTime = uTime;
  shader.uniforms.uWind = uWind;
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${ATTRS}\nvarying float vDepthK;`)
    .replace("#include <uv_vertex>", "#include <uv_vertex>\nvMapUv = aCell.xy + uv * aCell.zw;")
    .replace(
      "#include <defaultnormal_vertex>",
      `#include <defaultnormal_vertex>
      vec3 iwp = (instanceMatrix * vec4(position, 1.0)).xyz;
      vec3 outw = normalize(vec3(iwp.x - aTree.x, 0.0, iwp.z - aTree.z) + vec3(0.001, 0.0, 0.0));
      vec3 fn = normalize(outw * 0.75 + vec3(0.0, 1.0, 0.0));
      transformedNormal = normalize(normalMatrix * fn * 0.85 + transformedNormal * 0.3);`,
    )
    .replace(
      "#include <project_vertex>",
      `vec4 mvPosition = instanceMatrix * vec4(transformed, 1.0);
      float hf = clamp((mvPosition.y - aTree.y) / max(aTree.w, 1.0), 0.0, 1.0);
      float ph = aTree.x * 0.13 + aTree.z * 0.09;
      float sw = (sin(uTime * 0.9 + ph) * 0.6 + sin(uTime * 2.1 + ph * 1.7) * 0.4) * uWind;
      mvPosition.x += sw * hf * hf * 0.7 + sin(uTime * 3.3 + ph + position.y * 2.0) * uWind * 0.05 * uv.y;
      mvPosition.z += sw * hf * hf * 0.45;
      mvPosition = modelViewMatrix * mvPosition;
      vDepthK = -mvPosition.z;
      gl_Position = projectionMatrix * mvPosition;`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\nvarying float vDepthK;")
    // Thicken the cut-out with distance so mip-mapped foliage does not thin to nothing.
    .replace("#include <alphatest_fragment>", "diffuseColor.a *= 1.0 + vDepthK * 0.012;\n#include <alphatest_fragment>");
  if (lit) {
    shader.fragmentShader = shader.fragmentShader
      // Two-sided leaves lit the same from both sides: keep the foliage normal, never flip it.
      .replace("#include <normal_fragment_begin>", "float faceDirection = gl_FrontFacing ? 1.0 : -1.0;\nvec3 normal = normalize(vNormal);\nvec3 nonPerturbedNormal = normal;")
      // A hint of light through the leaf.
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.05;");
  }
}

function foliageMaterial(atlas: Atlas, uTime: THREE.IUniform, uWind: THREE.IUniform, roughness = 0.85): { mat: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial } {
  const mat = new THREE.MeshStandardMaterial({ map: atlas.tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness, metalness: 0 });
  mat.onBeforeCompile = (s) => patchFoliage(s as Shader, uTime, uWind, true);
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas.tex, alphaTest: 0.45, side: THREE.DoubleSide });
  depth.onBeforeCompile = (s) => patchFoliage(s as Shader, uTime, uWind, false);
  return { mat, depth };
}

/** Bark with moss on the north side and around the foot, and the map scaled to the trunk's real size. */
function barkMaterial(s: Surface, mossy: number, roughness = 1): THREE.MeshStandardMaterial {
  const mat = surfaceMaterial(s, { roughness, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMoss = { value: mossy };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWN; varying float vTrunkY;")
      .replace(
        "#include <uv_vertex>",
        `#include <uv_vertex>
        float ir = length(instanceMatrix[0].xyz);
        float ih = length(instanceMatrix[1].xyz);
        vMapUv = vec2(uv.x * max(1.0, floor(6.2832 * ir / 1.4 + 0.5)), uv.y * ih / 1.4);
        vNormalMapUv = vMapUv;
        vRoughnessMapUv = vMapUv;
        vWN = normalize(mat3(modelMatrix) * (instanceMatrix * vec4(normal, 0.0)).xyz);
        vTrunkY = (instanceMatrix * vec4(position, 1.0)).y - instanceMatrix[3].y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWN; varying float vTrunkY; uniform float uMoss;")
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        float north = smoothstep(0.0, 0.7, -vWN.z);
        float foot = 1.0 - smoothstep(0.2, 3.0, vTrunkY);
        float speck = fract(sin(dot(floor(vMapUv * 28.0), vec2(12.9898, 78.233))) * 43758.5453);
        float mossA = clamp(north * 0.6 * (1.0 - smoothstep(2.0, 14.0, vTrunkY)) + foot * 0.5, 0.0, 0.85) * uMoss * (0.55 + 0.9 * speck);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.22, 0.32, 0.10) * (0.7 + 0.6 * speck), clamp(mossA, 0.0, 0.9));`,
      );
  };
  return mat;
}

// ---- Spatial hashes -----------------------------------------------------------------------

interface Seg {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  w: number;
}

class SegGrid {
  private cells = new Map<number, Seg[]>();
  constructor(private size: number) {}
  add(s: Seg, pad: number) {
    const minX = Math.min(s.x0, s.x1) - pad;
    const maxX = Math.max(s.x0, s.x1) + pad;
    const minZ = Math.min(s.z0, s.z1) - pad;
    const maxZ = Math.max(s.z0, s.z1) + pad;
    for (let i = Math.floor(minX / this.size); i <= Math.floor(maxX / this.size); i++) {
      for (let j = Math.floor(minZ / this.size); j <= Math.floor(maxZ / this.size); j++) {
        const k = i * 100003 + j;
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(s);
      }
    }
  }
  /** Distance to the nearest segment edge (its half width subtracted); large when nothing is near. */
  dist(x: number, z: number): number {
    const l = this.cells.get(Math.floor(x / this.size) * 100003 + Math.floor(z / this.size));
    if (!l) return 1e9;
    let best = 1e9;
    for (const s of l) {
      const dx = s.x1 - s.x0;
      const dz = s.z1 - s.z0;
      const l2 = dx * dx + dz * dz || 1e-9;
      let t = ((x - s.x0) * dx + (z - s.z0) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(s.x0 + dx * t - x, s.z0 + dz * t - z) - s.w;
      if (d < best) best = d;
    }
    return best;
  }
}

class PointGrid {
  private cells = new Map<number, { x: number; z: number; r: number }[]>();
  constructor(private size: number) {}
  add(x: number, z: number, r: number, pad: number) {
    for (let i = Math.floor((x - r - pad) / this.size); i <= Math.floor((x + r + pad) / this.size); i++) {
      for (let j = Math.floor((z - r - pad) / this.size); j <= Math.floor((z + r + pad) / this.size); j++) {
        const k = i * 100003 + j;
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push({ x, z, r });
      }
    }
  }
  /** Distance outside the nearest disc; negative inside. */
  dist(x: number, z: number): number {
    const l = this.cells.get(Math.floor(x / this.size) * 100003 + Math.floor(z / this.size));
    if (!l) return 1e9;
    let best = 1e9;
    for (const p of l) {
      const d = Math.hypot(p.x - x, p.z - z) - p.r;
      if (d < best) best = d;
    }
    return best;
  }
}

interface Poly {
  ring: number[][];
  b: { minX: number; maxX: number; minZ: number; maxZ: number };
}
function polys(features: { g: Parameters<typeof rings>[0] }[]): Poly[] {
  return features.flatMap((f) => rings(f.g).map((ring) => ({ ring, b: ringBounds(ring) })));
}
function inAny(x: number, z: number, ps: Poly[]): boolean {
  for (const p of ps) {
    if (x < p.b.minX || x > p.b.maxX || z < p.b.minZ || z > p.b.maxZ) continue;
    if (pointInRing(x, z, p.ring)) return true;
  }
  return false;
}

// ---- The build -------------------------------------------------------------------------------

export function buildVegetation(data: Neighbourhood, ground: Ground, buildings: Buildings): Vegetation {
  const group = new THREE.Group();
  const rnd = mulberry32(7331);
  const trunks: Vegetation["trunks"] = [];

  // ---- What the land is, where ----------------------------------------------------------
  const roads = new SegGrid(30);
  const drives = new SegGrid(30);
  for (const r of data.roads) {
    if (r.cls === "footway" || r.cls === "path") continue;
    const w = roadWidth(r.cls) / 2 + (r.cls === "service" || r.cls === "track" ? 0.6 : 2.2);
    for (const l of lines(r.g)) for (let i = 0; i < l.length - 1; i++) (r.cls === "service" || r.cls === "track" ? drives : roads).add({ x0: l[i][0], z0: l[i][1], x1: l[i + 1][0], z1: l[i + 1][1], w }, 18);
  }
  const streams = new SegGrid(30);
  for (const w of data.water) if (w.sub === "stream") for (const l of lines(w.g)) for (let i = 0; i < l.length - 1; i++) streams.add({ x0: l[i][0], z0: l[i][1], x1: l[i + 1][0], z1: l[i + 1][1], w: 0 }, 16);
  const houses = new PointGrid(30);
  for (const f of buildings.footprints) houses.add(f.cx, f.cz, f.r, 24);
  const placed = new PointGrid(12);

  const forest = polys(data.land.filter((l) => l.sub === "forest"));
  const scrub = polys(data.land.filter((l) => l.sub === "shrub"));
  const lawnCls = new Set(["pitch", "grass", "playground", "recreation_ground", "school", "farmland", "animal_keeping", "construction", "parking", "residential"]);
  const lawn = polys([...data.land.filter((l) => l.sub === "grass" || l.sub === "sand"), ...data.landuse.filter((l) => l.cls && lawnCls.has(l.cls)), ...data.infra.filter((f) => f.cls === "parking"), ...data.water.filter((w) => w.g.t === "pg" || w.g.t === "mpg")]);
  const garden = polys(data.landuse.filter((l) => l.cls === "garden"));
  const orchard = polys(data.landuse.filter((l) => l.cls === "orchard"));

  const roadD = (x: number, z: number) => Math.min(roads.dist(x, z), drives.dist(x, z) + 0.4);
  const clear = (x: number, z: number, margin: number) => roadD(x, z) > margin && houses.dist(x, z) > margin && ground.heightAt(x, z) > 1.6;
  const nearShore = (x: number, z: number) => ground.heightAt(x + 40, z) < 1.5 || ground.heightAt(x - 40, z) < 1.5 || ground.heightAt(x, z + 40) < 1.5 || ground.heightAt(x, z - 40) < 1.5 || ground.heightAt(x + 28, z + 28) < 1.5 || ground.heightAt(x - 28, z + 28) < 1.5;

  // ---- Materials and geometry ----------------------------------------------------------
  const uTime: THREE.IUniform = { value: 0 };
  const uWind: THREE.IUniform = { value: 0.5 };
  const conifer = coniferAtlas();
  const broad = broadleafAtlas();
  const under = understoryAtlas();
  const impostor = impostorAtlas();
  const duff = duffAtlas();
  const coniferM = foliageMaterial(conifer, uTime, uWind, 0.9);
  const broadM = foliageMaterial(broad, uTime, uWind, 0.8);
  const underM = foliageMaterial(under, uTime, uWind, 0.85);
  const barks: Record<BarkKind, Surface> = { fir: barkTexture("fir"), cedar: barkTexture("cedar"), alder: barkTexture("alder"), maple: barkTexture("maple"), madrona: barkTexture("madrona"), stump: barkTexture("stump") };
  const barkMats: Record<BarkKind, THREE.MeshStandardMaterial> = {
    fir: barkMaterial(barks.fir, 0.9),
    cedar: barkMaterial(barks.cedar, 0.8),
    alder: barkMaterial(barks.alder, 0.35, 0.9),
    maple: barkMaterial(barks.maple, 1.3),
    madrona: barkMaterial(barks.madrona, 0.15, 0.55),
    stump: barkMaterial(barks.stump, 1.6),
  };
  const duffMat = new THREE.MeshStandardMaterial({ map: duff.tex, alphaTest: 0.35, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  duffMat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace("#include <common>", "#include <common>\nattribute vec4 aCell; attribute vec4 aTree;").replace("#include <uv_vertex>", "#include <uv_vertex>\nvMapUv = aCell.xy + uv * aCell.zw;");
  };
  const uEye = { value: new THREE.Vector3(0, 1e6, 0) };
  const impostorMat = new THREE.MeshStandardMaterial({ map: impostor.tex, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
  impostorMat.onBeforeCompile = (s) => {
    s.uniforms.uEye = uEye;
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 aCell; attribute vec4 aTree; uniform vec3 uEye; varying float vFade;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\nvMapUv = aCell.xy + uv * aCell.zw;")
      .replace(
        "#include <defaultnormal_vertex>",
        `vec3 ibase = instanceMatrix[3].xyz;
        vec3 toCam = normalize(uEye - ibase);
        vec3 transformedNormal = normalMatrix * normalize(toCam + vec3(0.0, 0.9, 0.0));`,
      )
      .replace(
        "#include <project_vertex>",
        `float iw = length(instanceMatrix[0].xyz);
        float ih = length(instanceMatrix[1].xyz);
        vec3 bright = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
        vec3 bup = normalize(cross(toCam, bright));
        vec3 wp = ibase + bright * position.x * iw + bup * position.y * ih;
        vFade = smoothstep(${(DETAIL_RANGE - 45).toFixed(1)}, ${(DETAIL_RANGE - 5).toFixed(1)}, distance(uEye, ibase));
        vec4 mvPosition = modelViewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;`,
      );
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vFade;")
      .replace("#include <alphatest_fragment>", "#include <alphatest_fragment>\nif (vFade < fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453) + 0.001) discard;")
      .replace("#include <normal_fragment_begin>", "float faceDirection = 1.0;\nvec3 normal = normalize(vNormal);\nvec3 nonPerturbedNormal = normal;");
  };

  const firBranchGeo = branchGeometry(0.1, 0.12);
  const cedarBranchGeo = branchGeometry(0.22, 0.06);
  const crossGeo = crossGeometry();
  const quadGeo = quadGeometry();
  const flatGeo = flatGeometry();
  // Trunk profiles: radius one at the foot, the shape of each species going up.
  const firTrunkGeo = tube((t) => (t < 0.05 ? 1.25 - 5 * t : 1 - 0.86 * (t - 0.05)) , 9, 6, 0.06, 5, false);
  const cedarTrunkGeo = tube((t) => (t < 0.08 ? 1.9 - 11 * t : t < 0.16 ? 1.02 - 0.25 * (t - 0.08) : 1 - 0.85 * (t - 0.16)), 10, 8, 0.3, 6, false);
  const alderTrunkGeo = tube((t) => 1 - 0.8 * t, 7, 3, 0, 1, false);
  const limbGeo = tube((t) => 1 - 0.65 * t, 7, 3, 0, 1, false);
  const stumpGeo = tube((t) => (t < 0.2 ? 1.45 - 2.25 * t : 1 - 0.12 * t), 10, 5, 0.28, 6, true);
  const logGeo = tube((t) => 1 - 0.25 * t, 8, 2, 0.08, 4, true);

  // ---- Tiles ---------------------------------------------------------------------------------
  interface Tile {
    cx: number;
    cz: number;
    conifer: Writer;
    cedar: Writer;
    broad: Writer;
    under: Writer;
    duff: Writer;
  }
  const tiles = new Map<number, Tile>();
  const tileAt = (x: number, z: number): Tile => {
    const i = Math.floor(x / TILE);
    const j = Math.floor(z / TILE);
    const k = i * 100003 + j;
    let t = tiles.get(k);
    if (!t) tiles.set(k, (t = { cx: (i + 0.5) * TILE, cz: (j + 0.5) * TILE, conifer: new Writer(), cedar: new Writer(), broad: new Writer(), under: new Writer(), duff: new Writer() }));
    return t;
  };
  const trunkW: Record<BarkKind, Writer> = { fir: new Writer(), cedar: new Writer(), alder: new Writer(), maple: new Writer(), madrona: new Writer(), stump: new Writer() };
  const limbW: Record<"maple" | "madrona" | "alder", Writer> = { maple: new Writer(), madrona: new Writer(), alder: new Writer() };
  const logW = new Writer();
  const impostorW = new Writer();
  const noCell = { u: 0, v: 0, su: 1, sv: 1 };

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const ax = new THREE.Vector3();
  const ay = new THREE.Vector3();
  const az = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  /** A card whose +y runs along direction d from p (the branch axis), with its flat plane held level. */
  const alongCard = (w: Writer, geo: "conifer" | "broad", p: THREE.Vector3, d: THREE.Vector3, len: number, wid: number, cell: { u: number; v: number; su: number; sv: number }, tx: number, ty: number, tz: number, th: number) => {
    ay.copy(d).normalize();
    ax.crossVectors(ay, up);
    if (ax.lengthSq() < 1e-4) ax.set(1, 0, 0);
    ax.normalize();
    az.crossVectors(ax, ay).normalize();
    m4.makeBasis(ax.multiplyScalar(wid), ay.multiplyScalar(len), az.multiplyScalar(geo === "conifer" ? len : wid));
    m4.setPosition(p);
    w.push(m4, cell, tx, ty, tz, th);
  };
  const trunk = (w: Writer, x: number, y: number, z: number, r: number, h: number, lean: number, leanDir: number, roll = 0) => {
    e.set(lean * Math.cos(leanDir), roll, lean * Math.sin(leanDir), "XYZ");
    q.setFromEuler(e);
    m4.compose(v.set(x, y, z), q, sc.set(r, h, r));
    w.push(m4, noCell, x, y, z, h);
  };
  const impostorOf = (x: number, y: number, z: number, h: number, wRatio: number, cell: number) => {
    m4.compose(v.set(x, y, z), q.identity(), sc.set(h * wRatio, h, 1));
    impostorW.push(m4, atlasCell(impostor, cell), x, y, z, h);
  };
  const understory = (x: number, z: number, cell: number, wid: number, h: number, yaw = rnd() * Math.PI) => {
    const y = ground.heightAt(x, z) - 0.05;
    e.set(0, yaw, 0);
    q.setFromEuler(e);
    m4.compose(v.set(x, y, z), q, sc.set(wid, h, wid));
    tileAt(x, z).under.push(m4, atlasCell(under, cell), x, y, z, h);
  };
  /** A garden shrub: two crossed cards from the broadleaf atlas, standing on the ground. */
  const shrub = (x: number, z: number, cell: number, wid: number, h: number) => {
    const y = ground.heightAt(x, z) - 0.05;
    e.set(0, rnd() * Math.PI, 0);
    q.setFromEuler(e);
    m4.compose(v.set(x, y, z), q, sc.set(wid, h, wid));
    tileAt(x, z).broad.push(m4, atlasCell(broad, cell), x, y, z, h);
  };
  const duffPatch = (x: number, z: number, r: number, mossy: boolean) => {
    // Fit the patch to the slope so it lies on the ground rather than through it.
    const gx = (ground.heightAt(x + 1, z) - ground.heightAt(x - 1, z)) / 2;
    const gz = (ground.heightAt(x, z + 1) - ground.heightAt(x, z - 1)) / 2;
    az.set(-gx, 1, -gz).normalize();
    ax.set(1, 0, 0).cross(az).cross(az).negate().normalize();
    ay.crossVectors(az, ax).normalize();
    const y = ground.heightAt(x, z) + 0.06;
    m4.makeBasis(ax.multiplyScalar(r * 2), az.multiplyScalar(1), ay.multiplyScalar(r * 2));
    m4.setPosition(x, y, z);
    tileAt(x, z).duff.push(m4, atlasCell(duff, mossy ? 1 : 0), x, y, z, 1);
  };

  // ---- Species -----------------------------------------------------------------------------------
  const tp = new THREE.Vector3();
  const td = new THREE.Vector3();

  function fir(x: number, z: number, k: number) {
    const y = ground.heightAt(x, z) - 0.3;
    const h = 34 * k * (0.9 + rnd() * 0.2);
    const r0 = 0.42 + 0.4 * k;
    trunk(trunkW.fir, x, y, z, r0, h * 0.985, rnd() * 0.03, rnd() * 6.3, rnd() * 6.3);
    trunks.push({ x, z, r: r0 * 0.9 });
    const tile = tileAt(x, z);
    const crownBase = h * (0.3 + rnd() * 0.12);
    const whorls = 9 + Math.floor(k * 3 + rnd() * 2);
    const reachMax = 3.4 + 2.2 * k;
    const spin = rnd() * 6.3;
    const cells = [atlasCell(conifer, CONIFER.firA), atlasCell(conifer, CONIFER.firB), atlasCell(conifer, CONIFER.firC)];
    for (let w = 0; w < whorls; w++) {
      const t = w / (whorls - 1);
      const yy = y + crownBase + (h - crownBase) * t;
      const reach = reachMax * Math.pow(1 - t, 0.8) * (0.7 + rnd() * 0.6) + 0.9;
      const per = t < 0.45 ? 4 : 3;
      for (let a = 0; a < per; a++) {
        if (rnd() < 0.12) continue;
        const ang = (a / per) * Math.PI * 2 + spin + w * 1.9 + rnd() * 0.7;
        const pitch = -0.28 + t * 0.45 + (rnd() - 0.5) * 0.2;
        td.set(Math.cos(ang) * Math.cos(pitch), Math.sin(pitch), Math.sin(ang) * Math.cos(pitch));
        tp.set(x + Math.cos(ang) * r0 * 0.4, yy, z + Math.sin(ang) * r0 * 0.4);
        alongCard(tile.conifer, "conifer", tp, td, reach, reach * 0.62, cells[Math.floor(rnd() * 3)], x, y, z, h);
      }
    }
    td.set((rnd() - 0.5) * 0.3, 1, (rnd() - 0.5) * 0.3);
    tp.set(x, y + h - 1.6, z);
    alongCard(tile.conifer, "conifer", tp, td, 2.2, 1.3, cells[0], x, y, z, h);
    impostorOf(x, y, z, h, 0.42, rnd() < 0.5 ? IMPOSTOR.firA : IMPOSTOR.firB);
    if (rnd() < 0.8) duffPatch(x + (rnd() - 0.5) * 2, z + (rnd() - 0.5) * 2, 2.5 + rnd() * 2.5, false);
  }

  function cedar(x: number, z: number, k: number) {
    const y = ground.heightAt(x, z) - 0.3;
    const h = 25 * k * (0.9 + rnd() * 0.2);
    const r0 = 0.5 + 0.45 * k;
    trunk(trunkW.cedar, x, y, z, r0, h * 0.98, rnd() * 0.02, rnd() * 6.3, rnd() * 6.3);
    trunks.push({ x, z, r: r0 * 1.1 });
    const tile = tileAt(x, z);
    const crownBase = h * (0.08 + rnd() * 0.06);
    const whorls = 10 + Math.floor(k * 3 + rnd() * 2);
    const reachMax = 3.0 + 2.4 * k;
    const spin = rnd() * 6.3;
    const cells = [atlasCell(conifer, CONIFER.cedarA), atlasCell(conifer, CONIFER.cedarB), atlasCell(conifer, CONIFER.cedarC)];
    for (let w = 0; w < whorls; w++) {
      const t = w / (whorls - 1);
      const yy = y + crownBase + (h - crownBase) * t;
      const reach = reachMax * Math.pow(1 - t, 0.95) * (0.8 + rnd() * 0.4) + 0.7;
      const per = 3;
      for (let a = 0; a < per; a++) {
        if (rnd() < 0.08) continue;
        const ang = (a / per) * Math.PI * 2 + spin + w * 2.1 + rnd() * 0.6;
        const pitch = -0.5 + t * 0.35 + (rnd() - 0.5) * 0.15;
        td.set(Math.cos(ang) * Math.cos(pitch), Math.sin(pitch), Math.sin(ang) * Math.cos(pitch));
        tp.set(x + Math.cos(ang) * r0 * 0.3, yy, z + Math.sin(ang) * r0 * 0.3);
        alongCard(tile.cedar, "conifer", tp, td, reach, reach * 0.7, cells[Math.floor(rnd() * 3)], x, y, z, h);
      }
    }
    td.set((rnd() - 0.5) * 0.4, 1, (rnd() - 0.5) * 0.4);
    tp.set(x, y + h - 1.8, z);
    alongCard(tile.cedar, "conifer", tp, td, 2.4, 1.4, cells[1], x, y, z, h);
    impostorOf(x, y, z, h, 0.5, rnd() < 0.5 ? IMPOSTOR.cedarA : IMPOSTOR.cedarB);
    duffPatch(x + (rnd() - 0.5) * 2, z + (rnd() - 0.5) * 2, 3 + rnd() * 2.5, true);
  }

  /** A trunk that forks into limbs carrying leaf cards: maple, madrona, or the small garden trees. */
  function broadleaf(x: number, z: number, k: number, kind: "maple" | "madrona" | "jmaple" | "apple") {
    const y = ground.heightAt(x, z) - 0.25;
    const tile = tileAt(x, z);
    const h = (kind === "maple" ? 17 : kind === "madrona" ? 11 : kind === "jmaple" ? 4.5 : 5) * k;
    const r0 = (kind === "maple" ? 0.4 + 0.3 * k : kind === "madrona" ? 0.22 + 0.16 * k : 0.06 + 0.05 * k);
    const bark: BarkKind = kind === "madrona" ? "madrona" : "maple";
    // Lean downslope for the madrona, which grows out toward the light over the bank.
    const gx = ground.heightAt(x + 2, z) - ground.heightAt(x - 2, z);
    const gz = ground.heightAt(x, z + 2) - ground.heightAt(x, z - 2);
    const leanDir = kind === "madrona" ? Math.atan2(-gz, -gx) + Math.PI / 2 + (rnd() - 0.5) * 0.6 : rnd() * 6.3;
    const lean = kind === "madrona" ? 0.18 + rnd() * 0.2 : rnd() * 0.05;
    const fork = h * (kind === "maple" ? 0.32 : kind === "madrona" ? 0.4 : 0.35);
    trunk(trunkW[bark], x, y, z, r0, fork + 0.3, lean, leanDir);
    trunks.push({ x, z, r: r0 });
    // Fork point in world space: the trunk leans, so its top moves. The trunk's matrix is still in m4.
    tp.set(0, fork / (fork + 0.3), 0).applyMatrix4(m4);
    const topX = tp.x;
    const topZ = tp.z;
    const limbs = kind === "maple" ? 3 + Math.floor(rnd() * 2) : kind === "madrona" ? 2 + Math.floor(rnd() * 2) : 3;
    const spin = rnd() * 6.3;
    const cells =
      kind === "maple" ? [atlasCell(broad, BROADLEAF.mapleA), atlasCell(broad, BROADLEAF.mapleB)] : kind === "madrona" ? [atlasCell(broad, BROADLEAF.madrona)] : kind === "jmaple" ? [atlasCell(broad, BROADLEAF.jmaple)] : [atlasCell(broad, BROADLEAF.apple)];
    const limbW2 = kind === "madrona" ? limbW.madrona : limbW.maple;
    const cardSize = kind === "maple" ? 3.2 + 1.6 * k : kind === "madrona" ? 2.4 + 0.8 * k : kind === "jmaple" ? 1.8 + 0.6 * k : 2.0 + 0.6 * k;
    for (let i = 0; i < limbs; i++) {
      const ang = (i / limbs) * Math.PI * 2 + spin + (rnd() - 0.5) * 0.8;
      const tilt = (kind === "maple" ? 0.55 : kind === "madrona" ? 0.7 : 0.6) + (rnd() - 0.5) * 0.4;
      const len = (h - fork) * (0.75 + rnd() * 0.35);
      // Limb: a tube from the fork, tilted outward.
      e.set(tilt * Math.sin(ang), 0, -tilt * Math.cos(ang), "XYZ");
      q.setFromEuler(e);
      m4.compose(v.set(topX, y + fork, topZ), q, sc.set(r0 * 0.6, len, r0 * 0.6));
      limbW2.push(m4, noCell, x, y, z, h);
      // Leaf cards along the outer half of the limb, fanning outward and up.
      const dirX = Math.cos(ang) * Math.sin(tilt);
      const dirZ = Math.sin(ang) * Math.sin(tilt);
      const dirY = Math.cos(tilt);
      const cards = kind === "maple" ? 5 : 3;
      for (let c = 0; c < cards; c++) {
        const u = 0.3 + (c / cards) * 0.7;
        tp.set(topX + dirX * len * u, y + fork + dirY * len * u, topZ + dirZ * len * u);
        const ca = ang + (rnd() - 0.5) * 1.6;
        const cp = 0.25 + rnd() * 0.6;
        td.set(Math.cos(ca) * Math.cos(cp), Math.sin(cp), Math.sin(ca) * Math.cos(cp));
        const s = cardSize * (0.8 + rnd() * 0.4);
        alongCard(tile.broad, "broad", tp, td, s, s * 0.95, cells[Math.floor(rnd() * cells.length)], x, y, z, h);
      }
    }
    // A card or two over the crown so it closes from above.
    for (let c = 0; c < (kind === "maple" ? 3 : 2); c++) {
      tp.set(topX + (rnd() - 0.5) * cardSize, y + h * (0.78 + rnd() * 0.15), topZ + (rnd() - 0.5) * cardSize);
      td.set((rnd() - 0.5) * 0.8, 1, (rnd() - 0.5) * 0.8);
      const s = cardSize * (0.8 + rnd() * 0.3);
      alongCard(tile.broad, "broad", tp, td, s, s, cells[Math.floor(rnd() * cells.length)], x, y, z, h);
    }
    impostorOf(x, y, z, h, kind === "maple" ? 0.9 : kind === "madrona" ? 0.8 : 1.0, kind === "maple" ? IMPOSTOR.maple : kind === "madrona" ? IMPOSTOR.madrona : IMPOSTOR.small);
  }

  function alder(x: number, z: number, k: number) {
    const y = ground.heightAt(x, z) - 0.25;
    const tile = tileAt(x, z);
    const h = 16 * k * (0.9 + rnd() * 0.2);
    const r0 = 0.15 + 0.15 * k;
    trunk(trunkW.alder, x, y, z, r0, h * 0.9, rnd() * 0.06, rnd() * 6.3);
    trunks.push({ x, z, r: r0 });
    const cell = atlasCell(broad, BROADLEAF.alder);
    const n = 6 + Math.floor(rnd() * 3);
    const spin = rnd() * 6.3;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const yy = y + h * (0.5 + t * 0.42);
      const ang = spin + i * 2.4 + rnd() * 0.5;
      const pitch = 0.35 + rnd() * 0.5;
      td.set(Math.cos(ang) * Math.cos(pitch), Math.sin(pitch), Math.sin(ang) * Math.cos(pitch));
      tp.set(x, yy, z);
      const s = (2.4 + 1.2 * k) * (1 - t * 0.3);
      alongCard(tile.broad, "broad", tp, td, s, s * 0.8, cell, x, y, z, h);
    }
    impostorOf(x, y, z, h, 0.45, IMPOSTOR.alder);
  }

  function stump(x: number, z: number, r: number, h: number) {
    trunk(trunkW.stump, x, ground.heightAt(x, z) - 0.15, z, r, h, 0, 0, rnd() * 6.3);
    trunks.push({ x, z, r });
  }
  function log(x: number, z: number, r: number, len: number, yaw: number) {
    const x1 = x + Math.cos(yaw) * len;
    const z1 = z + Math.sin(yaw) * len;
    const y0 = ground.heightAt(x, z) + r * 0.7;
    const y1 = ground.heightAt(x1, z1) + r * 0.7;
    ay.set(x1 - x, y1 - y0, z1 - z).normalize();
    ax.crossVectors(ay, up).normalize();
    az.crossVectors(ax, ay).normalize();
    m4.makeBasis(ax.multiplyScalar(r), ay.multiplyScalar(Math.hypot(x1 - x, y1 - y0, z1 - z)), az.multiplyScalar(r));
    m4.setPosition(x, y0, z);
    logW.push(m4, noCell, x, y0, z, r);
  }

  /** The stuff under a canopy tree, within a few metres of it. */
  function floor(x: number, z: number, sp: Species) {
    const wet = streams.dist(x, z) < 12;
    for (let i = 0; i < 3; i++) {
      const fx = x + (rnd() - 0.5) * 8;
      const fz = z + (rnd() - 0.5) * 8;
      if (!clear(fx, fz, 0.8)) continue;
      const r = rnd();
      const k = 0.8 + rnd() * 0.6;
      if (wet && r < 0.3) understory(fx, fz, UNDER.nettle, 1.2 * k, 1.1 * k);
      else if (r < 0.42) understory(fx, fz, rnd() < 0.5 ? UNDER.fernA : UNDER.fernB, 1.7 * k, 1.1 * k);
      else if (r < 0.7) understory(fx, fz, UNDER.salal, 1.8 * k, 1.2 * k);
      else if (r < 0.82) understory(fx, fz, UNDER.huckleberry, 1.6 * k, 1.8 * k);
      else if (r < 0.92) understory(fx, fz, UNDER.oregonGrape, 1.3 * k, 0.9 * k);
      else understory(fx, fz, UNDER.blackberry, 2.2 * k, 1.4 * k);
    }
    // Logging left stumps everywhere and the wind has left logs since.
    if (sp !== "alder" && rnd() < 0.11) {
      const sx = x + (rnd() - 0.5) * 9;
      const sz = z + (rnd() - 0.5) * 9;
      if (clear(sx, sz, 1.2)) stump(sx, sz, 0.5 + rnd() * 0.5, 0.7 + rnd() * 1.2);
    }
    if (rnd() < 0.07) {
      const lx = x + (rnd() - 0.5) * 8;
      const lz = z + (rnd() - 0.5) * 8;
      const yaw = rnd() * 6.3;
      const len = 5 + rnd() * 7;
      if (clear(lx, lz, 1) && clear(lx + Math.cos(yaw) * len, lz + Math.sin(yaw) * len, 1)) log(lx, lz, 0.28 + rnd() * 0.3, len, yaw);
    }
  }

  function plant(x: number, z: number, sp: Species, k: number, withFloor: boolean) {
    placed.add(x, z, 0, 0);
    if (sp === "fir") fir(x, z, k);
    else if (sp === "cedar") cedar(x, z, k);
    else if (sp === "maple") broadleaf(x, z, k, "maple");
    else if (sp === "alder") alder(x, z, k);
    else broadleaf(x, z, k, "madrona");
    if (withFloor) floor(x, z, sp);
  }

  // ---- Placement: the inferred forest ----------------------------------------------------------------------
  const [tl, br] = data.bbox;
  const step = 6.6;
  let canopy = 0;
  for (let gz = tl[1] + step * 0.5; gz < br[1]; gz += step) {
    for (let gx = tl[0] + step * 0.5; gx < br[0]; gx += step) {
      const x = gx + (rnd() - 0.5) * step * 0.9;
      const z = gz + (rnd() - 0.5) * step * 0.9;
      const gy = ground.heightAt(x, z);
      if (gy < 2.2) continue;
      const rd = roadD(x, z);
      if (rd < 0.6) continue;
      const hd = houses.dist(x, z);
      if (hd < 2.5) continue;
      if (inAny(x, z, lawn)) continue;
      const inForest = inAny(x, z, forest);
      const inScrub = !inForest && inAny(x, z, scrub);
      const inGarden = !inForest && !inScrub && inAny(x, z, garden);
      // Probability of a canopy tree in this ~44 m2 cell: a stand is one per 45 to 65 m2, a yard far fewer.
      let p = inForest ? 0.95 : inScrub ? 0.14 : inGarden ? 0.26 : 0.74;
      if (hd < 13) p *= inForest ? 0.65 : 0.45;
      if (rd < 3) p *= 0.55;
      if (rnd() > p) continue;
      const shore = gy < 45 && nearShore(x, z);
      if (shore && gy < 9 && (ground.heightAt(x + 16, z) < 1.5 || ground.heightAt(x - 16, z) < 1.5 || ground.heightAt(x, z + 16) < 1.5 || ground.heightAt(x, z - 16) < 1.5)) continue;
      const wet = streams.dist(x, z) < 9;
      const edge = rd < 9 || hd < 13;
      const r = rnd();
      let sp: Species;
      if (shore) sp = r < 0.42 ? "madrona" : r < 0.75 ? "fir" : r < 0.88 ? "cedar" : "maple";
      else if (wet) sp = r < 0.55 ? "alder" : r < 0.82 ? "cedar" : "maple";
      else if (inScrub) sp = r < 0.7 ? "alder" : "maple";
      else if (edge) sp = r < 0.32 ? "maple" : r < 0.55 ? "alder" : r < 0.83 ? "fir" : "cedar";
      else sp = r < 0.53 ? "fir" : r < 0.82 ? "cedar" : r < 0.94 ? "maple" : "alder";
      const k = (hd < 13 && sp === "fir" ? 1.0 : 0.75) + rnd() * (hd < 13 ? 0.35 : 0.5);
      plant(x, z, sp, k, !inGarden && !inScrub);
      canopy++;
    }
  }

  // Mapped single trees are the notable ones: big firs and maples in yards. Tree rows are cedar.
  for (const t of data.land) {
    if (t.sub !== "tree") continue;
    if (t.g.t === "pt") {
      const [x, z] = t.g.c;
      if (ground.heightAt(x, z) > 1.6 && placed.dist(x, z) > 3) plant(x, z, rnd() < 0.55 ? "fir" : "maple", 1.15 + rnd() * 0.25, false);
    } else {
      for (const l of lines(t.g)) for (const p of resample(l, 5)) if (clear(p.x, p.z, 0.5)) plant(p.x, p.z, "cedar", 0.7 + rnd() * 0.3, false);
    }
  }

  // ---- Scrub polygons: blackberry and salal thickets ----------------------------------------------------------
  for (const s of scrub) {
    for (let z = s.b.minZ; z < s.b.maxZ; z += 3) {
      for (let x = s.b.minX; x < s.b.maxX; x += 3) {
        const px = x + (rnd() - 0.5) * 2.5;
        const pz = z + (rnd() - 0.5) * 2.5;
        if (!pointInRing(px, pz, s.ring) || !clear(px, pz, 0.5)) continue;
        const r = rnd();
        const k = 0.9 + rnd() * 0.5;
        if (r < 0.55) understory(px, pz, UNDER.blackberry, 2.6 * k, 1.6 * k);
        else if (r < 0.8) understory(px, pz, UNDER.salal, 2.0 * k, 1.3 * k);
        else understory(px, pz, UNDER.grass, 1.4 * k, 0.9 * k);
      }
    }
  }

  // ---- Road edges: the shoulder is bramble, salal, fern and rank grass -------------------------------------------
  for (const r of data.roads) {
    if (r.cls === "footway" || r.cls === "path") continue;
    const drive = r.cls === "service" || r.cls === "track";
    const half = roadWidth(r.cls) / 2;
    for (const l of lines(r.g)) {
      for (const p of resample(l, drive ? 4.5 : 2.6)) {
        for (const side of [-1, 1]) {
          if (drive && rnd() < 0.55) continue;
          const off = half + (drive ? 0.9 : 1.6) + rnd() * (drive ? 1.2 : 2.6);
          const x = p.x - p.tz * off * side;
          const z = p.z + p.tx * off * side;
          if (ground.heightAt(x, z) < 1.8 || houses.dist(x, z) < 1 || inAny(x, z, lawn)) continue;
          if (roadD(x, z) < 0.2) continue;
          const yaw = Math.atan2(p.tz, p.tx) + (rnd() - 0.5) * 0.8;
          const q2 = rnd();
          const k = 0.85 + rnd() * 0.5;
          if (drive) {
            if (q2 < 0.45) understory(x, z, rnd() < 0.5 ? UNDER.fernA : UNDER.fernB, 1.5 * k, 1.0 * k, yaw);
            else if (q2 < 0.8) understory(x, z, UNDER.salal, 1.6 * k, 1.1 * k, yaw);
            else understory(x, z, UNDER.grass, 1.2 * k, 0.8 * k, yaw);
          } else if (q2 < 0.34) understory(x, z, UNDER.blackberry, 2.6 * k, 1.5 * k, yaw);
          else if (q2 < 0.56) understory(x, z, UNDER.salal, 1.9 * k, 1.2 * k, yaw);
          else if (q2 < 0.82) understory(x, z, UNDER.grass, 1.5 * k, 0.9 * k, yaw);
          else understory(x, z, rnd() < 0.5 ? UNDER.fernA : UNDER.fernB, 1.6 * k, 1.0 * k, yaw);
        }
      }
    }
  }

  // ---- Hedges and fence lines --------------------------------------------------------------------------------------------
  for (const f of data.infra) {
    if (f.cls === "hedge") {
      const laurel = rnd() < 0.55;
      for (const l of lines(f.g)) {
        for (const p of resample(l, laurel ? 1.1 : 0.85)) {
          if (ground.heightAt(p.x, p.z) < 1.6) continue;
          const yaw = Math.atan2(p.tz, p.tx);
          if (laurel) understory(p.x, p.z, UNDER.laurel, 1.9, 2.1 + rnd() * 0.3, yaw + (rnd() - 0.5) * 0.3);
          else understory(p.x, p.z, UNDER.arborvitae, 1.3, 3.0 + rnd() * 0.6, yaw + rnd() * 3);
        }
      }
    } else if (f.cls === "fence" && f.g.t === "ls") {
      for (const p of resample(f.g.c, 5)) {
        if (rnd() > 0.45 || !clear(p.x, p.z, 0.3)) continue;
        const yaw = Math.atan2(p.tz, p.tx);
        understory(p.x + (rnd() - 0.5) * 0.8, p.z + (rnd() - 0.5) * 0.8, UNDER.blackberry, 2.4 + rnd(), 1.4 + rnd() * 0.5, yaw);
      }
    }
  }

  // ---- The orchard ------------------------------------------------------------------------------------------------------
  for (const o of orchard) {
    for (let z = o.b.minZ + 3; z < o.b.maxZ; z += 6) {
      for (let x = o.b.minX + 3; x < o.b.maxX; x += 6) {
        const px = x + (rnd() - 0.5) * 1.5;
        const pz = z + (rnd() - 0.5) * 1.5;
        if (pointInRing(px, pz, o.ring) && clear(px, pz, 1)) broadleaf(px, pz, 0.85 + rnd() * 0.4, "apple");
      }
    }
  }

  // ---- Yard planting by the houses ---------------------------------------------------------------------------------------
  for (const f of buildings.footprints) {
    if (f.r < 4 || f.r > 18) continue;
    const n = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const ang = rnd() * Math.PI * 2;
      const d = f.r + 1.2 + rnd() * 3.5;
      const x = f.cx + Math.cos(ang) * d;
      const z = f.cz + Math.sin(ang) * d;
      if (ground.heightAt(x, z) < 1.8 || roadD(x, z) < 0.8 || houses.dist(x, z) < 0.6 || placed.dist(x, z) < 2.5) continue;
      const r = rnd();
      if (r < 0.45) shrub(x, z, BROADLEAF.rhodo, 2.4 + rnd() * 1.2, 2.0 + rnd() * 0.8);
      else if (r < 0.75) shrub(x, z, BROADLEAF.hydrangea, 1.5 + rnd() * 0.6, 1.2 + rnd() * 0.4);
      else broadleaf(x, z, 0.8 + rnd() * 0.5, "jmaple");
    }
  }

  let cards = 0;
  for (const t of tiles.values()) cards += t.conifer.n + t.cedar.n + t.broad.n + t.under.n + t.duff.n;
  console.info(`[beck] vegetation: ${canopy} canopy trees, ${impostorW.n} billboards, ${cards} cards in ${tiles.size} tiles, ${trunks.length} trunks`);

  // ---- Meshes ----------------------------------------------------------------------------------------------------------------
  const tileMeshes: { mesh: THREE.InstancedMesh; cx: number; cz: number; r: number; range: number }[] = [];
  const addTile = (mesh: THREE.InstancedMesh | null, t: Tile, range: number) => {
    if (!mesh) return;
    mesh.frustumCulled = true;
    mesh.visible = false;
    group.add(mesh);
    const bs = mesh.boundingSphere!;
    tileMeshes.push({ mesh, cx: bs.center.x, cz: bs.center.z, r: bs.radius, range });
  };
  for (const t of tiles.values()) {
    addTile(t.conifer.mesh(firBranchGeo, coniferM.mat, true, coniferM.depth), t, DETAIL_RANGE);
    addTile(t.cedar.mesh(cedarBranchGeo, coniferM.mat, true, coniferM.depth), t, DETAIL_RANGE);
    addTile(t.broad.mesh(crossGeo, broadM.mat, true, broadM.depth), t, DETAIL_RANGE);
    addTile(t.under.mesh(crossGeo, underM.mat, false, underM.depth), t, UNDERSTORY_RANGE);
    addTile(t.duff.mesh(flatGeo, duffMat, false), t, UNDERSTORY_RANGE);
  }
  const global = (mesh: THREE.InstancedMesh | null, shadow: boolean) => {
    if (!mesh) return null;
    mesh.frustumCulled = false;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const trunkMesh = global(trunkW.fir.mesh(firTrunkGeo, barkMats.fir, true), true);
  global(trunkW.cedar.mesh(cedarTrunkGeo, barkMats.cedar, true), true);
  global(trunkW.alder.mesh(alderTrunkGeo, barkMats.alder, true), true);
  global(trunkW.maple.mesh(limbGeo, barkMats.maple, true), true);
  global(trunkW.madrona.mesh(limbGeo, barkMats.madrona, true), true);
  global(trunkW.stump.mesh(stumpGeo, barkMats.stump, true), true);
  global(limbW.maple.mesh(limbGeo, barkMats.maple, true), true);
  global(limbW.madrona.mesh(limbGeo, barkMats.madrona, true), true);
  global(logW.mesh(logGeo, barkMats.stump, true), true);
  const impostorMesh = global(impostorW.mesh(quadGeo, impostorMat, false), false);
  if (impostorMesh) impostorMesh.receiveShadow = false;

  // The eye: read off the camera when the trunks draw, used next frame to choose which tiles draw in full.
  const eye = new THREE.Vector3(0, 1e6, 0);
  let eyeKnown = false;
  const probe = trunkMesh ?? impostorMesh;
  if (probe) {
    probe.onBeforeRender = (_r, _s, camera) => {
      if (!(camera as THREE.Camera).isCamera) return;
      camera.getWorldPosition(eye);
      uEye.value.copy(eye);
      eyeKnown = true;
    };
  }
  let lastX = NaN;
  let lastZ = NaN;
  let lastY = NaN;

  return {
    group,
    trunks,
    update(time, wind) {
      uTime.value = time;
      uWind.value = wind;
      if (!eyeKnown) return;
      if (Math.abs(eye.x - lastX) < 2 && Math.abs(eye.z - lastZ) < 2 && Math.abs(eye.y - lastY) < 2) return;
      lastX = eye.x;
      lastZ = eye.z;
      lastY = eye.y;
      for (const t of tileMeshes) {
        const d = Math.hypot(t.cx - eye.x, t.cz - eye.z) - t.r;
        t.mesh.visible = d < t.range;
      }
    },
    dispose() {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      for (const k of Object.keys(barks) as BarkKind[]) {
        disposeSurface(barks[k]);
        barkMats[k].dispose();
      }
      for (const m of [coniferM, broadM, underM]) {
        m.mat.dispose();
        m.depth.dispose();
      }
      duffMat.dispose();
      impostorMat.dispose();
      for (const a of [conifer, broad, under, impostor, duff]) a.tex.dispose();
    },
  };
}
