/**
 * The Dipsea — everything that stands still.
 *
 * The mountain, the trail cut into it, the redwoods in the creek and the
 * scrub on the ridge, the ocean at the end, and a sky that is mostly marine
 * layer. Built once from `trail.ts` and never touched again; the only thing
 * that animates here is the water and the fog colour.
 */
import * as THREE from "three";
import { COURSE_MILES, TRAIL, fbm, groundHeight, sectionAt } from "./trail";

export interface Scenery {
  group: THREE.Group;
  /** Tree trunks, for the "touch a tree" mechanic. World positions. */
  trees: { x: number; y: number; z: number; big: boolean }[];
  /** Move the sky with the camera and advance the water. */
  update(time: number, camera: THREE.Camera, fogColor: THREE.Color): void;
  dispose(): void;
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSun;
uniform float uHaze;
varying vec3 vDir;
void main() {
  vec3 rd = normalize(vDir);
  float up = clamp(rd.y, 0.0, 1.0);
  vec3 sky = mix(uHorizon, uZenith, pow(up, 0.55));
  float mu = max(dot(rd, uSun), 0.0);
  sky += vec3(1.0, 0.92, 0.75) * pow(mu, 48.0) * 0.6;
  sky += vec3(1.0, 0.85, 0.6) * pow(mu, 6.0) * 0.12;
  // Marine layer: a bright white band that eats the horizon.
  float band = exp(-abs(rd.y) * 9.0) * uHaze;
  sky = mix(sky, vec3(0.92, 0.94, 0.96), band);
  gl_FragColor = vec4(sky, 1.0);
}
`;

const WATER_VERT = /* glsl */ `
uniform float uTime;
varying vec2 vXZ;
void main() {
  vec3 p = position;
  vXZ = p.xz;
  float w = sin(p.x * 0.08 + uTime * 0.9) * 0.25 + sin(p.z * 0.11 - uTime * 0.7) * 0.2;
  p.y += w;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const WATER_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec3 uFog;
uniform vec3 uCam;
varying vec2 vXZ;
void main() {
  float d = distance(uCam.xz, vXZ);
  float f = 1.0 - exp(-d * 0.0022);
  float shimmer = sin(vXZ.x * 0.6 + uTime * 2.0) * sin(vXZ.y * 0.5 - uTime * 1.6);
  vec3 deep = vec3(0.10, 0.28, 0.36);
  vec3 lit = vec3(0.35, 0.55, 0.60);
  vec3 c = mix(deep, lit, 0.5 + 0.5 * shimmer * 0.4);
  // Foam where the beach is: the shore sits near x = 0 in the water plane's
  // own frame, which is placed at the beach edge.
  float foam = smoothstep(18.0, 2.0, abs(vXZ.x)) * (0.5 + 0.5 * sin(uTime * 1.3 + vXZ.y * 0.15));
  c = mix(c, vec3(0.9, 0.93, 0.94), foam * 0.7);
  c = mix(c, uFog, f);
  gl_FragColor = vec4(c, 1.0);
}
`;

const TERRAIN_HALF = 900;
const TERRAIN_X0 = -300;
const TERRAIN_X1 = TRAIL.length + 500;

function biomeColour(mile: number, height: number, slope: number, out: THREE.Color) {
  const sec = sectionAt(mile);
  const grass = new THREE.Color(0x7a8a3f);
  const scrub = new THREE.Color(0x8b8a4a);
  const duff = new THREE.Color(0x4b3a26);
  const rock = new THREE.Color(0x8a8378);
  const gold = new THREE.Color(0xb8a25a);
  const sand = new THREE.Color(0xd9c9a3);
  let base: THREE.Color;
  switch (sec.biome) {
    case "redwoods":
    case "creek":
      base = duff;
      break;
    case "ravine":
      base = duff.clone().lerp(grass, 0.5);
      break;
    case "ridge":
      base = gold;
      break;
    case "beach":
      base = sand;
      break;
    case "town":
    case "stairs":
      base = grass;
      break;
    default:
      base = scrub;
  }
  out.copy(base);
  // Steep faces go to rock, high ground goes to summer gold.
  out.lerp(rock, Math.min(1, Math.max(0, (slope - 0.8) * 1.4)));
  out.lerp(gold, Math.min(0.5, Math.max(0, (height - 70) / 120)));
  if (height < 0.5) out.copy(sand);
}

function buildTerrain(): THREE.Mesh {
  const nx = 220;
  const nz = 130;
  const geo = new THREE.PlaneGeometry(
    TERRAIN_X1 - TERRAIN_X0,
    TERRAIN_HALF * 2,
    nx,
    nz,
  );
  geo.rotateX(-Math.PI / 2);
  geo.translate((TERRAIN_X0 + TERRAIN_X1) / 2, 0, 0);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colours = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const heights = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = groundHeight(x, z);
    heights[i] = h;
    pos.setY(i, h);
  }
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const slope = 1 - nrm.getY(i);
    const { point } = TRAIL.nearest(x, z);
    biomeColour(point.mile, heights[i], slope * 3, c);
    // A little grain so a hillside is not one flat tone.
    const g = (fbm(x * 0.05, z * 0.05, 2) - 0.5) * 0.12;
    colours[i * 3] = c.r + g;
    colours[i * 3 + 1] = c.g + g;
    colours[i * 3 + 2] = c.b + g;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

/** The trail itself: a ribbon of dust laid a hand's width over the ground. */
function buildRibbon(): THREE.Mesh {
  const step = 3;
  const count = Math.floor(TRAIL.length / step);
  const verts: number[] = [];
  const idx: number[] = [];
  const colours: number[] = [];
  const dust = new THREE.Color(0xb59a72);
  const stair = new THREE.Color(0x6e6a62);
  for (let i = 0; i <= count; i++) {
    const p = TRAIL.at(i * step);
    const nx = -p.dz;
    const nz = p.dx;
    const w = 1.15;
    const sec = sectionAt(p.mile);
    const col = sec.biome === "stairs" ? stair : dust;
    verts.push(p.x + nx * w, p.y + 0.12, p.z + nz * w, p.x - nx * w, p.y + 0.12, p.z - nz * w);
    colours.push(col.r, col.g, col.b, col.r, col.g, col.b);
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  return new THREE.Mesh(geo, mat);
}

/** The 688 steps, or enough of them to read as stairs from a runner's height. */
function buildStairs(): THREE.InstancedMesh {
  const s0 = 0.2 * TRAIL.metresPerMile;
  const s1 = 0.75 * TRAIL.metresPerMile;
  const rise = 0.45;
  const n = Math.floor((s1 - s0) / rise);
  const geo = new THREE.BoxGeometry(3.2, 0.2, 0.5);
  const mat = new THREE.MeshLambertMaterial({ color: 0x6b675f });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < n; i++) {
    const p = TRAIL.at(s0 + i * rise);
    q.setFromAxisAngle(up, Math.atan2(p.dx, p.dz));
    m.compose(new THREE.Vector3(p.x, p.y + 0.05, p.z), q, new THREE.Vector3(1, 1, 1));
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

interface TreeSet {
  trunk: THREE.InstancedMesh;
  crown: THREE.InstancedMesh;
}

function makeTrees(
  n: number,
  trunkGeo: THREE.BufferGeometry,
  crownGeo: THREE.BufferGeometry,
  trunkColor: number,
  crownColor: number,
): TreeSet {
  const trunk = new THREE.InstancedMesh(
    trunkGeo,
    new THREE.MeshLambertMaterial({ color: trunkColor }),
    n,
  );
  const crown = new THREE.InstancedMesh(
    crownGeo,
    new THREE.MeshLambertMaterial({ color: crownColor }),
    n,
  );
  trunk.castShadow = true;
  crown.castShadow = true;
  return { trunk, crown };
}

export function buildScenery(): Scenery {
  const group = new THREE.Group();

  // Sky.
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: {
      uZenith: { value: new THREE.Color(0x4f86c6) },
      uHorizon: { value: new THREE.Color(0xd8e3ea) },
      uSun: { value: new THREE.Vector3(-0.5, 0.45, -0.3).normalize() },
      uHaze: { value: 0.75 },
    },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(4000, 24, 16), skyMat);
  sky.renderOrder = -10;
  group.add(sky);

  // Ground and trail.
  const terrain = buildTerrain();
  group.add(terrain);
  group.add(buildRibbon());
  group.add(buildStairs());

  // Ocean, its origin on the beach edge so the foam knows where the shore is.
  const waterMat = new THREE.ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uFog: { value: new THREE.Color(0xd8e3ea) },
      uCam: { value: new THREE.Vector3() },
    },
    fog: false,
  });
  const waterGeo = new THREE.PlaneGeometry(2400, 2600, 80, 80);
  waterGeo.rotateX(-Math.PI / 2);
  waterGeo.translate(1200 - 40, 0, 0);
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.set(TRAIL.length + 10, -0.6, 0);
  group.add(water);
  // The bay behind the start.
  const bayGeo = new THREE.PlaneGeometry(1200, 2600, 20, 20);
  bayGeo.rotateX(-Math.PI / 2);
  bayGeo.translate(-600 - 40, 0, 0);
  const bay = new THREE.Mesh(bayGeo, waterMat);
  bay.position.set(-130, -0.6, 0);
  group.add(bay);

  // Trees. Redwoods where the trail is low and in the creek, oaks and bay
  // trees in the chaparral, nothing on the ridge top and the beach.
  const redwoodN = 1400;
  const oakN = 1100;
  const redwoods = makeTrees(
    redwoodN,
    new THREE.CylinderGeometry(0.5, 0.9, 1, 6),
    new THREE.ConeGeometry(3.2, 1, 7),
    0x5a3a24,
    0x2d5a33,
  );
  const oaks = makeTrees(
    oakN,
    new THREE.CylinderGeometry(0.25, 0.4, 1, 5),
    new THREE.IcosahedronGeometry(1, 1),
    0x4a3b2a,
    0x5f7a34,
  );
  const trees: Scenery["trees"] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const place = (set: TreeSet, count: number, big: boolean) => {
    let placed = 0;
    let tries = 0;
    while (placed < count && tries < count * 40) {
      tries++;
      const s = rnd() * TRAIL.length;
      const p = TRAIL.at(s);
      const sec = sectionAt(p.mile);
      const wantRedwood = sec.biome === "redwoods" || sec.biome === "creek" || sec.biome === "ravine";
      const wantOak =
        sec.biome === "chaparral" || sec.biome === "town" || sec.biome === "stairs" || sec.biome === "ravine";
      if (big && !wantRedwood) continue;
      if (!big && !wantOak && !(sec.biome === "redwoods" && rnd() < 0.15)) continue;
      const side = rnd() < 0.5 ? -1 : 1;
      const off = 4 + rnd() * (big ? 70 : 50);
      const along = (rnd() - 0.5) * 6;
      const x = p.x - p.dz * side * off + p.dx * along;
      const z = p.z + p.dx * side * off + p.dz * along;
      const y = groundHeight(x, z);
      if (y < 1) continue;
      const h = big ? 14 + rnd() * 22 : 3.5 + rnd() * 4;
      q.setFromAxisAngle(up, rnd() * Math.PI * 2);
      const trunkH = big ? h * 0.7 : h * 0.45;
      pos.set(x, y + trunkH / 2, z);
      scl.set(big ? 1 + rnd() * 0.5 : 1, trunkH, big ? 1 + rnd() * 0.5 : 1);
      m.compose(pos, q, scl);
      set.trunk.setMatrixAt(placed, m);
      const crownH = big ? h * 0.65 : h * 0.6;
      pos.set(x, y + trunkH * 0.85 + crownH / 2, z);
      scl.set(big ? 0.9 + rnd() * 0.5 : 2.2 + rnd() * 1.4, crownH, big ? 0.9 + rnd() * 0.5 : 2.2 + rnd() * 1.4);
      m.compose(pos, q, scl);
      set.crown.setMatrixAt(placed, m);
      trees.push({ x, y, z, big });
      placed++;
    }
    set.trunk.count = placed;
    set.crown.count = placed;
    set.trunk.instanceMatrix.needsUpdate = true;
    set.crown.instanceMatrix.needsUpdate = true;
  };
  place(redwoods, redwoodN, true);
  place(oaks, oakN, false);
  group.add(redwoods.trunk, redwoods.crown, oaks.trunk, oaks.crown);

  // Mile markers: a post every mile, numbered by height so you can count.
  const postGeo = new THREE.BoxGeometry(0.25, 1.4, 0.25);
  const postMat = new THREE.MeshLambertMaterial({ color: 0xe8e0c8 });
  for (let mile = 1; mile < COURSE_MILES; mile++) {
    const p = TRAIL.at(mile * TRAIL.metresPerMile);
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(p.x - p.dz * 2.4, p.y + 0.7, p.z + p.dx * 2.4);
    group.add(post);
  }

  // Water: a fountain at Redwood Creek and one at the beach.
  const tapGeo = new THREE.CylinderGeometry(0.35, 0.45, 1.1, 8);
  const tapMat = new THREE.MeshLambertMaterial({ color: 0x3b8ad9, emissive: 0x1a3d66 });
  for (const mile of [2.05, 7.2]) {
    const p = TRAIL.at(mile * TRAIL.metresPerMile);
    const tap = new THREE.Mesh(tapGeo, tapMat);
    tap.position.set(p.x + p.dz * 2.2, p.y + 0.55, p.z - p.dx * 2.2);
    group.add(tap);
  }

  // A house or two in Mill Valley, and the beach town at the far end.
  const houseGeo = new THREE.BoxGeometry(6, 4, 7);
  const roofGeo = new THREE.ConeGeometry(5.2, 2.6, 4);
  const houseMat = new THREE.MeshLambertMaterial({ color: 0xe9e2d0 });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x8a5a44 });
  const houses: [number, number][] = [
    [-30, 20], [-48, -14], [-22, -40], [-60, 30],
    [TRAIL.length - 15, 40], [TRAIL.length - 34, 60], [TRAIL.length - 10, -35], [TRAIL.length - 40, -55],
  ];
  for (const [x, z] of houses) {
    const y = groundHeight(x, z);
    if (y < 0) continue;
    const h = new THREE.Mesh(houseGeo, houseMat);
    h.position.set(x, y + 2, z);
    const r = new THREE.Mesh(roofGeo, roofMat);
    r.position.set(x, y + 5.3, z);
    r.rotation.y = Math.PI / 4;
    group.add(h, r);
  }

  const dispose = () => {
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
  };

  return {
    group,
    trees,
    update(time, camera, fogColor) {
      sky.position.copy(camera.position);
      waterMat.uniforms.uTime.value = time;
      waterMat.uniforms.uFog.value.copy(fogColor);
      waterMat.uniforms.uCam.value.copy(camera.position);
      skyMat.uniforms.uHorizon.value.copy(fogColor);
    },
    dispose,
  };
}
