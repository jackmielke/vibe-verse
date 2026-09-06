/**
 * Coast Road, everything that stands still, twice.
 *
 * One road table, two looks. "painted" is the anime frame: a saturated sky
 * with a cumulus stack, cel-shaded hills, a bay with white surf lines and a
 * town at the bottom. "lens" is the action-camera frame: a wide, slightly
 * grey suburban descent with a double yellow line, eucalyptus and houses.
 * Both are built from `road.ts`, so the road under your wheels is the same
 * road either way and only the paint changes.
 */
import * as THREE from "three";
import {
  LENGTH,
  ROAD_HALF,
  SAMPLE,
  coastAt,
  fbm,
  makeCourse,
  mulberry32,
  roadPos,
  roadTable,
  terrainAt,
  terrainAtXZ,
  type Course,
  type Style,
} from "./road";

export interface Scenery {
  group: THREE.Group;
  course: Course;
  sun: THREE.Vector3;
  /** Per-frame: sky follows the camera, grass and water animate, wind drives both. */
  update(time: number, camera: THREE.Camera, wind: number, windLat: number, riderPos: THREE.Vector3): void;
  dispose(): void;
}

const PALETTE = {
  painted: {
    zenith: 0x1c4fb6,
    horizon: 0xb7e0f7,
    grass: 0x8fcf4a,
    grassDark: 0x4f9a33,
    hill: 0x3f7f2d,
    sand: 0xf0dfb0,
    road: 0xd2ccbc,
    roadEdge: 0xbdb5a3,
    shallow: 0x2fb7e6,
    deep: 0x0c3fa8,
    trunk: 0x6b4a2e,
    crown: 0x5fb545,
    crown2: 0x3e9a3a,
    fog: 0xbfe2f6,
  },
  lens: {
    zenith: 0x7fb1e2,
    horizon: 0xe4edf3,
    grass: 0x74924a,
    grassDark: 0x4f6b32,
    hill: 0x5f7d40,
    sand: 0xd9cfae,
    road: 0x6f6f6f,
    roadEdge: 0x8a8a84,
    shallow: 0x6fa9c6,
    deep: 0x3d6f95,
    trunk: 0x8a7a66,
    crown: 0x4f6f3a,
    crown2: 0x3c5a2c,
    fog: 0xdbe6ee,
  },
} as const;

// ---- Shaders -----------------------------------------------------------------

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const NOISE = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.02 + vec2(17.0, 9.0); a *= 0.5; }
  return s;
}
`;

const SKY_FRAG_PAINTED = /* glsl */ `
precision highp float;
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uSun; uniform float uTime;
varying vec3 vDir;
${NOISE}
void main() {
  vec3 rd = normalize(vDir);
  float up = clamp(rd.y, 0.0, 1.0);
  vec3 sky = mix(uHorizon, uZenith, pow(up, 0.5));
  float mu = max(dot(rd, uSun), 0.0);
  sky += vec3(1.0, 0.95, 0.8) * pow(mu, 200.0) * 0.8;
  // Cumulus: two cloud decks projected onto planes above the viewer.
  vec3 col = sky;
  if (rd.y > 0.02) {
    vec2 p1 = rd.xz / (rd.y + 0.08) * 1.6 + vec2(uTime * 0.004, 0.0);
    float d1 = fbm(p1 * 0.9);
    float cover1 = smoothstep(0.60, 0.70, d1);
    float lit1 = smoothstep(0.55, 0.85, fbm(p1 * 0.9 + vec2(0.35, -0.25)));
    float shade = floor((0.35 + 0.65 * lit1) * 3.0) / 3.0; // cel bands
    vec3 cloud = mix(vec3(0.72, 0.78, 0.9), vec3(1.0, 1.0, 0.98), shade);
    col = mix(col, cloud, cover1 * smoothstep(0.02, 0.12, rd.y));
    vec2 p2 = rd.xz / (rd.y + 0.15) * 0.7 + vec2(-uTime * 0.002, uTime * 0.001);
    float d2 = fbm(p2 * 1.3 + 40.0);
    float cover2 = smoothstep(0.63, 0.72, d2) * 0.9;
    float lit2 = smoothstep(0.5, 0.8, fbm(p2 * 1.3 + vec2(40.3, 39.8)));
    vec3 cloud2 = mix(vec3(0.8, 0.84, 0.94), vec3(1.0), floor((0.4 + 0.6 * lit2) * 3.0) / 3.0);
    col = mix(col, cloud2, cover2 * smoothstep(0.03, 0.2, rd.y));
  }
  // The horizon haze band, warm.
  float band = exp(-abs(rd.y) * 7.0) * 0.55;
  col = mix(col, vec3(0.93, 0.96, 1.0), band);
  gl_FragColor = vec4(col, 1.0);
}
`;

const SKY_FRAG_LENS = /* glsl */ `
precision highp float;
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uSun; uniform float uTime;
varying vec3 vDir;
${NOISE}
void main() {
  vec3 rd = normalize(vDir);
  float up = clamp(rd.y, 0.0, 1.0);
  vec3 sky = mix(uHorizon, uZenith, pow(up, 0.7));
  float mu = max(dot(rd, uSun), 0.0);
  sky += vec3(1.0, 0.97, 0.9) * pow(mu, 600.0) * 1.2;
  sky += vec3(1.0, 0.95, 0.85) * pow(mu, 8.0) * 0.18;
  if (rd.y > 0.0) {
    vec2 p = rd.xz / (rd.y + 0.2) * 2.2 + vec2(uTime * 0.003, 0.0);
    float c = fbm(p) ;
    float wisp = smoothstep(0.52, 0.72, c) * 0.35 * smoothstep(0.0, 0.25, rd.y);
    sky = mix(sky, vec3(0.97, 0.98, 1.0), wisp);
  }
  float band = exp(-abs(rd.y) * 5.0) * 0.5;
  sky = mix(sky, vec3(0.9, 0.93, 0.96), band);
  gl_FragColor = vec4(sky, 1.0);
}
`;

const WATER_VERT = /* glsl */ `
uniform float uTime;
attribute float aDepth;
varying float vDepth;
varying vec3 vPos;
void main() {
  vec3 p = position;
  p.y += sin(p.x * 0.05 + uTime * 0.8) * 0.25 + sin(p.z * 0.07 - uTime * 0.6) * 0.2;
  vDepth = aDepth;
  vPos = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const WATER_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uShallow; uniform vec3 uDeep; uniform float uTime; uniform float uPainted;
varying float vDepth; varying vec3 vPos;
${NOISE}
void main() {
  float d = max(vDepth, 0.0);
  vec3 col = mix(uShallow, uDeep, smoothstep(0.0, 26.0, d));
  // Surf: lines that roll toward the shore, brightest where it is shallow.
  float roll = sin(d * 0.9 - uTime * 1.4 + vnoise(vPos.xz * 0.05) * 3.0);
  float surf = smoothstep(0.55, 0.95, roll) * smoothstep(9.0, 1.0, d) * 0.9;
  float caps = smoothstep(0.72, 0.9, fbm(vPos.xz * 0.06 + vec2(uTime * 0.05, 0.0))) * 0.35 * smoothstep(4.0, 20.0, d);
  float wash = smoothstep(1.6, 0.0, d) * 0.7;
  float foam = clamp(surf + caps + wash, 0.0, 1.0) * step(-0.5, vDepth);
  if (uPainted > 0.5) foam = floor(foam * 3.0 + 0.5) / 3.0;
  col = mix(col, vec3(1.0), foam);
  // A little sky sparkle far out.
  col += vec3(0.05) * smoothstep(30.0, 200.0, d);
  gl_FragColor = vec4(col, 1.0);
}
`;

const GRASS_VERT = /* glsl */ `
uniform float uTime; uniform float uWind; uniform float uWindLat; uniform vec3 uRider;
varying vec2 vUv; varying float vShade;
void main() {
  vUv = uv;
  vec4 wp = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float phase = wp.x * 0.35 + wp.z * 0.21;
  float sway = sin(uTime * 2.1 + phase) * 0.5 + sin(uTime * 3.7 + phase * 1.7) * 0.25 + sin(uTime * 0.9 + phase * 0.3) * 0.25;
  float bend = uv.y * uv.y;
  vec3 p = position;
  p.x += bend * (sway * (0.25 + 0.9 * uWind) + uWindLat * 0.9);
  p.z += bend * (sin(uTime * 1.3 + phase * 0.6) * 0.2 * uWind);
  vec4 world = instanceMatrix * vec4(p, 1.0);
  // The rider parts the grass at the edge of the road.
  float dr = distance(world.xz, uRider.xz);
  float push = smoothstep(2.2, 0.0, dr) * bend * 0.6;
  world.xz += normalize(world.xz - uRider.xz + vec2(0.001)) * push;
  world = modelMatrix * world;
  vShade = 0.6 + 0.4 * uv.y + 0.12 * sway;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const GRASS_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor; uniform vec3 uColorDark; uniform float uPainted;
varying vec2 vUv; varying float vShade;
void main() {
  // A blade: taper toward the tip.
  float hw = 0.5 - vUv.y * 0.42;
  if (abs(vUv.x - 0.5) > hw) discard;
  float sh = vShade;
  if (uPainted > 0.5) sh = floor(sh * 3.0 + 0.5) / 3.0;
  vec3 c = mix(uColorDark, uColor, sh);
  gl_FragColor = vec4(c, 1.0);
}
`;

// ---- Helpers -----------------------------------------------------------------

function toonGradient(): THREE.DataTexture {
  const data = new Uint8Array([70, 70, 70, 255, 160, 160, 160, 255, 255, 255, 255, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

function roadTexture(style: Style): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d")!;
  const pal = PALETTE[style];
  g.fillStyle = "#" + pal.road.toString(16).padStart(6, "0");
  g.fillRect(0, 0, 256, 256);
  // Grain.
  const rnd = mulberry32(3);
  for (let i = 0; i < 2600; i++) {
    const v = style === "lens" ? 90 + rnd() * 50 : 190 + rnd() * 40;
    g.fillStyle = `rgba(${v},${v},${v - 6},${style === "lens" ? 0.35 : 0.22})`;
    g.fillRect(rnd() * 256, rnd() * 256, 1.5, 1.5);
  }
  if (style === "lens") {
    // Double yellow down the middle, white lines at the edges. u runs across the road.
    g.fillStyle = "#e3b322";
    g.fillRect(122, 0, 4, 256);
    g.fillRect(130, 0, 4, 256);
    g.fillStyle = "rgba(240,240,236,0.9)";
    g.fillRect(6, 0, 3, 256);
    g.fillRect(247, 0, 3, 256);
    // Tar snakes.
    g.strokeStyle = "rgba(40,40,40,0.55)";
    g.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      g.beginPath();
      let x = rnd() * 256;
      let y = rnd() * 256;
      g.moveTo(x, y);
      for (let k = 0; k < 5; k++) {
        x += (rnd() - 0.5) * 40;
        y += rnd() * 30;
        g.lineTo(x, y);
      }
      g.stroke();
    }
  } else {
    // Concrete seams every tile, soft.
    g.fillStyle = "rgba(120,110,95,0.35)";
    g.fillRect(0, 0, 256, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const LATS = [-170, -130, -100, -76, -56, -40, -28, -19, -12.5, -8, -5.6, -4.5, 4.5, 5.6, 8, 12.5, 19, 28, 40, 56, 76, 100, 130, 170, 230, 320];

function buildTerrain(style: Style): THREE.Mesh {
  const rows = Math.floor(LENGTH / 8) + 2;
  const cols = LATS.length;
  const pos = new Float32Array(rows * cols * 3);
  const col = new Float32Array(rows * cols * 3);
  const idx: number[] = [];
  const pal = PALETTE[style];
  const grass = new THREE.Color(pal.grass);
  const grassDark = new THREE.Color(pal.grassDark);
  const hill = new THREE.Color(pal.hill);
  const sand = new THREE.Color(pal.sand);
  const tmp = { x: 0, y: 0, z: 0 };
  const c = new THREE.Color();
  for (let r = 0; r < rows; r++) {
    const s = Math.min(LENGTH, r * 8);
    for (let k = 0; k < cols; k++) {
      const lat = LATS[k];
      roadPos(s, lat, tmp);
      const h = terrainAt(s, lat, tmp.x, tmp.z);
      const i = (r * cols + k) * 3;
      pos[i] = tmp.x;
      pos[i + 1] = h;
      pos[i + 2] = tmp.z;
      // Colour by height and steepness, banded in the painted look.
      const n = fbm(tmp.x * 0.02, tmp.z * 0.02, 2) * 0.5 + 0.5;
      if (h < 1.6) c.copy(sand);
      else if (lat < 0 && Math.abs(lat) > 30) c.copy(hill).lerp(grassDark, n * 0.6);
      else c.copy(grassDark).lerp(grass, style === "painted" ? Math.round(n * 2) / 2 : n);
      if (Math.abs(lat) <= 4.5) c.copy(new THREE.Color(pal.roadEdge));
      col[i] = c.r;
      col[i + 1] = c.g;
      col[i + 2] = c.b;
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let k = 0; k < cols - 1; k++) {
      const a = r * cols + k;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat =
    style === "painted"
      ? new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() })
      : new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = false;
  return mesh;
}

function buildRoad(style: Style): THREE.Mesh {
  const t = roadTable();
  const n = t.length;
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const idx: number[] = [];
  const tmp = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < n; i++) {
    const s = i * SAMPLE;
    for (let side = 0; side < 2; side++) {
      const lat = side === 0 ? ROAD_HALF : -ROAD_HALF;
      roadPos(s, lat, tmp);
      const j = (i * 2 + side) * 3;
      pos[j] = tmp.x;
      pos[j + 1] = tmp.y + 0.03;
      pos[j + 2] = tmp.z;
      uv[(i * 2 + side) * 2] = side;
      uv[(i * 2 + side) * 2 + 1] = s / 7;
    }
    if (i < n - 1) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const tex = roadTexture(style);
  const mat =
    style === "painted"
      ? new THREE.MeshToonMaterial({ map: tex, gradientMap: toonGradient() })
      : new THREE.MeshLambertMaterial({ map: tex });
  return new THREE.Mesh(geo, mat);
}

function worldBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const t = roadTable();
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of t) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { minX, maxX, minZ, maxZ };
}

function buildOcean(style: Style): { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } {
  const b = worldBounds();
  const pad = 1400;
  const x0 = b.minX - pad;
  const x1 = b.maxX + pad;
  const z0 = b.minZ - pad;
  const z1 = b.maxZ + pad;
  const step = 22;
  const nx = Math.ceil((x1 - x0) / step) + 1;
  const nz = Math.ceil((z1 - z0) / step) + 1;
  const pos = new Float32Array(nx * nz * 3);
  const depth = new Float32Array(nx * nz);
  const idx: number[] = [];
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = x0 + ix * step;
      const z = z0 + iz * step;
      const i = iz * nx + ix;
      pos[i * 3] = x;
      pos[i * 3 + 1] = 0.25;
      pos[i * 3 + 2] = z;
      // Depth below the surface. Far from the road the terrain function is sea floor anyway.
      const near = Math.abs(x - (b.minX + b.maxX) / 2) < (b.maxX - b.minX) / 2 + 500 && Math.abs(z - (b.minZ + b.maxZ) / 2) < (b.maxZ - b.minZ) / 2 + 500;
      depth[i] = near ? -terrainAtXZ(x, z) : 60;
    }
  }
  for (let iz = 0; iz < nz - 1; iz++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iz * nx + ix;
      idx.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aDepth", new THREE.BufferAttribute(depth, 1));
  geo.setIndex(idx);
  const pal = PALETTE[style];
  const mat = new THREE.ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uShallow: { value: new THREE.Color(pal.shallow) },
      uDeep: { value: new THREE.Color(pal.deep) },
      uPainted: { value: style === "painted" ? 1 : 0 },
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return { mesh, mat };
}

function buildGrass(style: Style): { mesh: THREE.InstancedMesh; mat: THREE.ShaderMaterial } {
  // A clump: three crossed blades.
  const blade = new THREE.PlaneGeometry(0.28, 0.85, 1, 3);
  blade.translate(0, 0.425, 0);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const g = blade.clone();
    g.rotateY((i / 3) * Math.PI);
    parts.push(g);
  }
  const geo = mergeGeometries(parts);
  const pal = PALETTE[style];
  const mat = new THREE.ShaderMaterial({
    vertexShader: GRASS_VERT,
    fragmentShader: GRASS_FRAG,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uWind: { value: 0.5 },
      uWindLat: { value: 0 },
      uRider: { value: new THREE.Vector3() },
      uColor: { value: new THREE.Color(pal.grass).multiplyScalar(style === "lens" ? 0.92 : 1) },
      uColorDark: { value: new THREE.Color(pal.grassDark) },
      uPainted: { value: style === "painted" ? 1 : 0 },
    },
  });
  const rnd = mulberry32(21);
  const count = Math.floor(LENGTH / 1.15) * 2;
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const tmp = { x: 0, y: 0, z: 0 };
  let i = 0;
  for (let s = 2; s < LENGTH && i < count; s += 1.15) {
    for (const side of [1, -1]) {
      if (i >= count) break;
      const lat = side * (4.9 + Math.pow(rnd(), 1.6) * 13);
      roadPos(s, lat, tmp);
      const h = terrainAt(s, lat, tmp.x, tmp.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI);
      const k = 0.7 + rnd() * 0.6;
      sc.set(k, k * (0.7 + rnd() * 0.6), k);
      m.compose(new THREE.Vector3(tmp.x, h, tmp.z), q, sc);
      mesh.setMatrixAt(i++, m);
    }
  }
  mesh.count = i;
  mesh.frustumCulled = false;
  return { mesh, mat };
}

/** Merge geometries with identical attribute sets (position, normal, uv). */
function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let off = 0;
  for (const g of list) {
    const p = g.getAttribute("position");
    const u = g.getAttribute("uv");
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      uv.push(u.getX(i), u.getY(i));
    }
    const ind = g.getIndex();
    if (ind) for (let i = 0; i < ind.count; i++) idx.push(ind.getX(i) + off);
    off += p.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

function buildTrees(style: Style, group: THREE.Group): THREE.Object3D[] {
  const pal = PALETTE[style];
  const rnd = mulberry32(5);
  const spots: { x: number; y: number; z: number; tall: boolean; k: number }[] = [];
  const tmp = { x: 0, y: 0, z: 0 };
  const gap = style === "painted" ? 34 : 16;
  for (let s = 30; s < LENGTH - 60; s += gap + rnd() * gap) {
    const hillSide = rnd() < (style === "painted" ? 0.6 : 0.72);
    const lat = hillSide ? -(8 + rnd() * 26) : 7 + rnd() * 18;
    roadPos(s, lat, tmp);
    const h = terrainAt(s, lat, tmp.x, tmp.z);
    if (h < 1.2) continue;
    spots.push({ x: tmp.x, y: h, z: tmp.z, tall: rnd() < (style === "painted" ? 0.3 : 0.55), k: 0.8 + rnd() * 0.8 });
  }
  const gradient = toonGradient();
  const trunkMat = style === "painted" ? new THREE.MeshToonMaterial({ color: pal.trunk, gradientMap: gradient }) : new THREE.MeshLambertMaterial({ color: pal.trunk });
  const crownMat = style === "painted" ? new THREE.MeshToonMaterial({ color: pal.crown, gradientMap: gradient }) : new THREE.MeshLambertMaterial({ color: pal.crown });
  const crownMat2 = style === "painted" ? new THREE.MeshToonMaterial({ color: pal.crown2, gradientMap: gradient }) : new THREE.MeshLambertMaterial({ color: pal.crown2 });
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.4, 1, 6);
  trunkGeo.translate(0, 0.5, 0);
  const roundGeo = style === "painted" ? new THREE.SphereGeometry(1, 10, 8) : new THREE.IcosahedronGeometry(1, 1);
  const tallGeo = new THREE.ConeGeometry(1, 2.6, 7);
  tallGeo.translate(0, 1.3, 0);
  const trunk = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
  const round = new THREE.InstancedMesh(roundGeo, crownMat, spots.length * 2);
  const tall = new THREE.InstancedMesh(tallGeo, crownMat2, spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  let ri = 0;
  let ti = 0;
  spots.forEach((sp, i) => {
    const th = sp.tall ? 5 + sp.k * 5 : 2.2 + sp.k * 2;
    m.compose(new THREE.Vector3(sp.x, sp.y - 0.3, sp.z), q, new THREE.Vector3(sp.k, th, sp.k));
    trunk.setMatrixAt(i, m);
    if (sp.tall) {
      const w = 1.4 + sp.k * 1.3;
      m.compose(new THREE.Vector3(sp.x, sp.y + th * 0.55, sp.z), q, new THREE.Vector3(w, th * 0.42 + 1.5, w));
      tall.setMatrixAt(ti++, m);
    } else {
      const w = 2.2 + sp.k * 2.2;
      m.compose(new THREE.Vector3(sp.x, sp.y + th + w * 0.5, sp.z), q, new THREE.Vector3(w, w * 0.85, w));
      round.setMatrixAt(ri++, m);
      m.compose(new THREE.Vector3(sp.x + w * 0.35, sp.y + th + w * 0.35, sp.z + w * 0.2), q, new THREE.Vector3(w * 0.7, w * 0.6, w * 0.7));
      round.setMatrixAt(ri++, m);
    }
  });
  round.count = ri;
  tall.count = ti;
  group.add(trunk, round, tall);
  return [trunk, round, tall];
}

function buildHouses(style: Style, group: THREE.Group): void {
  const rnd = mulberry32(9);
  const wall = style === "painted" ? new THREE.MeshToonMaterial({ color: 0xf4efe6, gradientMap: toonGradient() }) : new THREE.MeshLambertMaterial({ color: 0xe9e3d6 });
  const roof = style === "painted" ? new THREE.MeshToonMaterial({ color: 0xd8694a, gradientMap: toonGradient() }) : new THREE.MeshLambertMaterial({ color: 0x6f5a4c });
  const door = new THREE.MeshLambertMaterial({ color: 0xf6f6f6 });
  const box = new THREE.BoxGeometry(1, 1, 1);
  const gable = new THREE.CylinderGeometry(0, 0.75, 1, 4, 1);
  gable.rotateY(Math.PI / 4);
  const tmp = { x: 0, y: 0, z: 0 };
  if (style === "lens") {
    // A suburb up the hill side: every so often a house set back from the road.
    for (let s = 60; s < LENGTH - 120; s += 45 + rnd() * 70) {
      const lat = -(11 + rnd() * 9);
      roadPos(s, lat, tmp);
      const h = terrainAt(s, lat, tmp.x, tmp.z);
      const w = 9 + rnd() * 5;
      const d = 8 + rnd() * 4;
      const hh = 3.2 + rnd() * 1.4;
      const g = new THREE.Group();
      const b = new THREE.Mesh(box, wall);
      b.scale.set(w, hh, d);
      b.position.y = hh / 2;
      const r = new THREE.Mesh(gable, roof);
      r.scale.set(w * 1.05, 2.2, d * 1.05);
      r.position.y = hh + 1.1;
      const gd = new THREE.Mesh(box, door);
      gd.scale.set(3.2, 2.4, 0.2);
      gd.position.set(w * 0.2, 1.2, d / 2 + 0.05);
      g.add(b, r, gd);
      g.position.set(tmp.x, h - 0.2, tmp.z);
      g.rotation.y = Math.atan2(-tmp.x, -tmp.z) + rnd() * 0.4;
      group.add(g);
    }
  } else {
    // The town at the bottom, on the flat by the bay.
    const cols = [0xf6f1e8, 0xf9dcc4, 0xd9e7f4, 0xe8f2d8, 0xf4e6a8];
    for (let i = 0; i < 160; i++) {
      const s = LENGTH - 60 - rnd() * 520;
      const lat = 26 + rnd() * 110;
      roadPos(s, lat, tmp);
      const h = terrainAt(s, lat, tmp.x, tmp.z);
      if (h < 0.6) continue;
      const w = 4 + rnd() * 5;
      const d = 4 + rnd() * 5;
      const hh = 3 + rnd() * 4;
      const m = new THREE.MeshToonMaterial({ color: cols[Math.floor(rnd() * cols.length)], gradientMap: toonGradient() });
      const b = new THREE.Mesh(box, m);
      b.scale.set(w, hh, d);
      b.position.set(tmp.x, h + hh / 2 - 0.2, tmp.z);
      b.rotation.y = rnd() * 0.5;
      const r = new THREE.Mesh(gable, roof);
      r.scale.set(w * 1.1, 1.6, d * 1.1);
      r.position.set(tmp.x, h + hh + 0.6, tmp.z);
      r.rotation.y = b.rotation.y;
      group.add(b, r);
    }
  }
}

function buildIslands(group: THREE.Group): void {
  // The headland across the bay and two islands, painted look only.
  const mat = new THREE.MeshToonMaterial({ color: 0x4f9e3c, gradientMap: toonGradient() });
  const beach = new THREE.MeshToonMaterial({ color: 0xf0dfb0, gradientMap: toonGradient() });
  const geo = new THREE.SphereGeometry(1, 18, 12);
  const tmp = { x: 0, y: 0, z: 0 };
  const spots: [number, number, number, number, number][] = [
    // s along road, lat seaward, scale x, y, z
    [LENGTH * 0.75, 520, 520, 90, 260],
    [LENGTH * 0.45, 720, 260, 55, 180],
    [LENGTH * 0.95, 900, 180, 40, 140],
    [LENGTH * 0.2, 640, 140, 30, 90],
  ];
  for (const [s, lat, sx, sy, sz] of spots) {
    roadPos(s, lat, tmp);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(tmp.x, -sy * 0.55, tmp.z);
    m.scale.set(sx, sy, sz);
    m.rotation.y = 0.4;
    group.add(m);
    const b = new THREE.Mesh(geo, beach);
    b.position.set(tmp.x, -sy * 0.62, tmp.z);
    b.scale.set(sx * 1.06, sy * 0.9, sz * 1.06);
    group.add(b);
  }
}

function buildClouds(group: THREE.Group): THREE.Group {
  const clouds = new THREE.Group();
  const mat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: toonGradient() });
  const geo = new THREE.SphereGeometry(1, 12, 9);
  const rnd = mulberry32(31);
  const b = worldBounds();
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  for (let c = 0; c < 9; c++) {
    const ang = rnd() * Math.PI * 2;
    const dist = 700 + rnd() * 1400;
    const px = cx + Math.cos(ang) * dist;
    const pz = cz + Math.sin(ang) * dist;
    const py = 260 + rnd() * 320;
    const n = 12 + Math.floor(rnd() * 14);
    const spread = 90 + rnd() * 160;
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(geo, mat);
      const r = 30 + rnd() * 60;
      const ox = (rnd() - 0.5) * spread;
      const oz = (rnd() - 0.5) * spread * 0.6;
      const oy = Math.abs(rnd() - 0.2) * spread * 0.55 * (1 - Math.hypot(ox, oz) / spread);
      m.position.set(px + ox, py + oy, pz + oz);
      m.scale.set(r, r * 0.72, r);
      clouds.add(m);
    }
    // A flat base so the stack sits on something.
    const base = new THREE.Mesh(geo, mat);
    base.position.set(px, py - 10, pz);
    base.scale.set(spread * 0.6, 22, spread * 0.42);
    clouds.add(base);
  }
  group.add(clouds);
  return clouds;
}

// ---- Build -------------------------------------------------------------------

export function buildScenery(style: Style): Scenery {
  const group = new THREE.Group();
  const pal = PALETTE[style];
  const course = makeCourse(style);
  const sun = new THREE.Vector3(0.35, 0.72, -0.6).normalize();

  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: style === "painted" ? SKY_FRAG_PAINTED : SKY_FRAG_LENS,
    uniforms: {
      uZenith: { value: new THREE.Color(pal.zenith) },
      uHorizon: { value: new THREE.Color(pal.horizon) },
      uSun: { value: sun.clone() },
      uTime: { value: 0 },
    },
    side: THREE.BackSide,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(2600, 32, 20), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  group.add(sky);

  const terrain = buildTerrain(style);
  const road = buildRoad(style);
  const ocean = buildOcean(style);
  const grass = buildGrass(style);
  group.add(terrain, road, ocean.mesh, grass.mesh);
  const trees = buildTrees(style, group);
  buildHouses(style, group);
  let clouds: THREE.Group | null = null;
  if (style === "painted") {
    buildIslands(group);
    clouds = buildClouds(group);
  }

  // Obstacles on the tarmac.
  const obGeo = new THREE.PlaneGeometry(1, 1);
  obGeo.rotateX(-Math.PI / 2);
  const crackMat = new THREE.MeshBasicMaterial({ color: style === "painted" ? 0x8b8272 : 0x2a2a2a, transparent: true, opacity: 0.85 });
  const leafMat = new THREE.MeshBasicMaterial({ color: style === "painted" ? 0xe8a44a : 0x9a6b2f, transparent: true, opacity: 0.9 });
  const puddleMat = new THREE.MeshBasicMaterial({ color: 0x4f5c66, transparent: true, opacity: 0.55 });
  const tmp = { x: 0, y: 0, z: 0 };
  for (const ob of course.obstacles) {
    roadPos(ob.s, ob.lat, tmp);
    const p = roadTable()[Math.min(roadTable().length - 1, Math.round(ob.s / SAMPLE))];
    const m = new THREE.Mesh(obGeo, ob.type === "crack" ? crackMat : ob.type === "leaves" ? leafMat : puddleMat);
    m.position.set(tmp.x, tmp.y + 0.06, tmp.z);
    m.scale.set(ob.width, 1, ob.type === "crack" ? 0.35 : 1.6);
    m.rotation.y = Math.atan2(p.tx, p.tz);
    group.add(m);
  }

  // Light.
  const hemi = new THREE.HemisphereLight(pal.horizon, pal.grassDark, style === "painted" ? 0.9 : 0.75);
  const dir = new THREE.DirectionalLight(0xfff4e0, style === "painted" ? 1.6 : 1.25);
  dir.position.copy(sun).multiplyScalar(400);
  group.add(hemi, dir);

  const disposables: THREE.Object3D[] = [sky, terrain, road, ocean.mesh, grass.mesh, ...trees];

  return {
    group,
    course,
    sun,
    update(time, camera, wind, windLat, riderPos) {
      sky.position.copy((camera as THREE.PerspectiveCamera).position);
      skyMat.uniforms.uTime.value = time;
      ocean.mat.uniforms.uTime.value = time;
      grass.mat.uniforms.uTime.value = time;
      grass.mat.uniforms.uWind.value = wind;
      grass.mat.uniforms.uWindLat.value = windLat;
      (grass.mat.uniforms.uRider.value as THREE.Vector3).copy(riderPos);
      if (clouds) clouds.position.x = time * 0.6;
    },
    dispose() {
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      void disposables;
    },
  };
}

export { PALETTE, coastAt };
