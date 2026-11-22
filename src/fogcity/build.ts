/**
 * Fog City: everything that stands still.
 *
 * The budget is the point of this file. The whole city is about thirty draw
 * calls: one heightfield whose shader paints the streets, one instanced box
 * for every building, one for the roofs, one for trees, and a handful of
 * landmarks. No textures are downloaded and no post-processing runs, so the
 * first frame arrives quickly and an ordinary laptop holds sixty.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  BX, BZ, IMAX, JMAX, ROAD, WALK, GRID_X, GRID_Z, TERRAIN, terrainSamples, heightAt, deckAt,
  allBoxes, blockKind, hash2, PYRAMID, SPIRE, COIT, SUTRO, CITY_HALL, FERRY,
  GG_X, GG_Z0, GG_Z1, GG_Z2, GG_Z3, GG_DECK, GG_HALF, GG_TOWERS, SHORE_X,
} from "./world";

/** Uniforms every patched material shares; the engine drives them. */
export const shared = {
  uNight: { value: 0 },
  uSky: { value: new THREE.Color(0x9cc4e8) },
};

export interface City {
  group: THREE.Group;
  sky: THREE.Mesh;
  skyUniforms: { uTop: { value: THREE.Color }; uHorizon: { value: THREE.Color }; uSun: { value: THREE.Vector3 }; uSunColor: { value: THREE.Color }; uNight: { value: number } };
  water: THREE.Mesh;
  lamps: THREE.MeshBasicMaterial;
  dispose(): void;
}

/* ---------------------------------------------------------------- ground */

function buildTerrain(): THREE.Mesh {
  const { x0, z0, step, nx, nz } = TERRAIN;
  const h = terrainSamples();
  const pos = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = (j * nx + i) * 3;
      pos[k] = x0 + i * step;
      pos[k + 1] = h[j * nx + i];
      pos[k + 2] = z0 + j * step;
    }
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let n = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx[n++] = a; idx[n++] = c; idx[n++] = b;
      idx[n++] = b; idx[n++] = c; idx[n++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();

  // One texel per block: what kind of ground the block is.
  const w = IMAX * 2;
  const d = JMAX * 2;
  const data = new Uint8Array(w * d * 4);
  for (let j = 0; j < d; j++) {
    for (let i = 0; i < w; i++) {
      const kind = blockKind(i - IMAX, j - JMAX);
      const v = kind === "park" ? 255 : kind === "forest" ? 200 : kind === "plaza" ? 100 : kind === "homes" ? 40 : 0;
      data[(j * w + i) * 4] = v;
      data[(j * w + i) * 4 + 3] = 255;
    }
  }
  const kinds = new THREE.DataTexture(data, w, d, THREE.RGBAFormat);
  kinds.magFilter = THREE.NearestFilter;
  kinds.minFilter = THREE.NearestFilter;
  kinds.needsUpdate = true;

  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uKinds = { value: kinds };
    shader.uniforms.uNight = shared.uNight;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWp;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec3 vWp;
uniform sampler2D uKinds;
uniform float uNight;
float fcPool = 0.0;
float fcHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float fcNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fcHash(i), fcHash(i + vec2(1.0, 0.0)), f.x), mix(fcHash(i + vec2(0.0, 1.0)), fcHash(i + vec2(1.0, 1.0)), f.x), f.y);
}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
{
  vec2 p = vWp.xz;
  float dist = length(vWp - cameraPosition);
  float near = 1.0 - smoothstep(160.0, 420.0, dist);
  float grain = fcNoise(p * 0.9) * 0.5 + fcNoise(p * 0.11) * 0.5;
  // Wild ground: dry grass on the hills, sand at the water.
  vec3 grass = mix(vec3(0.42, 0.44, 0.24), vec3(0.30, 0.40, 0.20), fcNoise(p * 0.02));
  vec3 col = mix(vec3(0.72, 0.66, 0.50), grass, smoothstep(1.2, 5.0, vWp.y));
  col *= 0.88 + 0.24 * grain;
  bool inGrid = abs(p.x) < ${(GRID_X + WALK).toFixed(1)} && abs(p.y) < ${(GRID_Z + WALK).toFixed(1)};
  // The bridge approaches are road too.
  bool approach = abs(p.x - (${GG_X.toFixed(1)})) < ${ROAD.toFixed(1)} && ((p.y < ${(-GRID_Z).toFixed(1)} && p.y > ${GG_Z1.toFixed(1)}) || (p.y < ${GG_Z2.toFixed(1)} && p.y > ${(GG_Z3 - 30).toFixed(1)}));
  if (inGrid || approach) {
    float dx = abs(mod(p.x + ${(BX / 2).toFixed(1)}, ${BX.toFixed(1)}) - ${(BX / 2).toFixed(1)});
    float dz = abs(mod(p.y + ${(BZ / 2).toFixed(1)}, ${BZ.toFixed(1)}) - ${(BZ / 2).toFixed(1)});
    if (approach) dz = 99.0;
    float dr = min(dx, dz);
    // Pools of sodium light under the lamps on each corner.
    vec2 lampD = vec2(dx - 7.9, dz - 7.9);
    fcPool = exp(-dot(lampD, lampD) / 150.0) * (approach ? 0.0 : 1.0);
    if (dr < ${ROAD.toFixed(1)}) {
      // Asphalt, patched and worn along the wheel tracks.
      col = vec3(0.115, 0.118, 0.125) * (0.82 + 0.36 * grain);
      col *= 0.92 + 0.08 * fcNoise(p * vec2(0.3, 3.0));
      bool ns = dx < dz;
      float across = ns ? dx : dz;
      float along = ns ? p.y : p.x;
      float cross = ns ? dz : dx;
      float paint = 0.0;
      vec3 paintCol = vec3(0.86, 0.86, 0.82);
      if (cross > ${(WALK + 4).toFixed(1)}) {
        // Double yellow down the middle, dashed white between lanes.
        if (across > 0.10 && across < 0.32) { paint = 1.0; paintCol = vec3(0.85, 0.66, 0.12); }
        if (abs(across - 3.5) < 0.09 && mod(along, 9.0) < 3.2) paint = 1.0;
      } else if (cross > ${(ROAD + 0.8).toFixed(1)} && cross < ${(ROAD + 3.6).toFixed(1)}) {
        // Zebra crossing.
        if (mod(across, 1.3) < 0.62) paint = 1.0;
      }
      col = mix(col, paintCol * (0.8 + 0.2 * grain), paint * near * 0.9);
    } else if (dr < ${WALK.toFixed(1)}) {
      // Pavement: slabs, a kerb line, expansion joints.
      col = vec3(0.56, 0.55, 0.53) * (0.9 + 0.2 * grain);
      float joint = step(0.94, fract(dx * 0.5)) + step(0.94, fract(dz * 0.5));
      col *= 1.0 - 0.16 * min(joint, 1.0) * near;
      col = mix(col, vec3(0.70, 0.69, 0.66), step(dr, ${(ROAD + 0.28).toFixed(2)}));
    } else {
      vec2 cell = floor(vec2(p.x / ${BX.toFixed(1)}, p.y / ${BZ.toFixed(1)}));
      float k = texture2D(uKinds, (cell + vec2(${IMAX.toFixed(1)}, ${JMAX.toFixed(1)}) + 0.5) / vec2(${(IMAX * 2).toFixed(1)}, ${(JMAX * 2).toFixed(1)})).r;
      if (k > 0.7) {
        col = mix(vec3(0.24, 0.42, 0.16), vec3(0.34, 0.50, 0.20), fcNoise(p * 0.05)) * (0.86 + 0.28 * grain);
        // A gravel path round the park.
        float edge = min(abs(dx - ${(WALK + 5).toFixed(1)}), abs(dz - ${(WALK + 5).toFixed(1)}));
        col = mix(col, vec3(0.62, 0.56, 0.44), (1.0 - smoothstep(0.9, 1.3, edge)) * 0.8);
      } else if (k > 0.3) {
        float tile = step(0.92, fract(p.x * 0.25)) + step(0.92, fract(p.y * 0.25));
        col = vec3(0.66, 0.63, 0.58) * (0.92 + 0.14 * grain) * (1.0 - 0.12 * min(tile, 1.0) * near);
      } else if (k > 0.1) {
        // Back yards.
        col = mix(vec3(0.36, 0.40, 0.26), vec3(0.50, 0.47, 0.40), fcNoise(p * 0.3)) * (0.9 + 0.2 * grain);
      } else {
        col = vec3(0.40, 0.40, 0.40) * (0.9 + 0.2 * grain);
      }
    }
  }
  diffuseColor.rgb = col;
}`)
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.72, 0.38) * fcPool * uNight * 1.6;");
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = "ground";
  return mesh;
}

/* ---------------------------------------------------------------- buildings */

function facadeMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = shared.uNight;
    shader.uniforms.uSky = shared.uSky;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 aStyle;\nvarying vec3 vWp;\nvarying vec3 vNo;\nvarying vec2 vStyle;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWp = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;\nvNo = normal;\nvStyle = aStyle;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWp;\nvarying vec3 vNo;\nvarying vec2 vStyle;\nuniform float uNight;\nuniform vec3 uSky;")
      .replace("#include <color_fragment>", `#include <color_fragment>
float fcLit = 0.0;
{
  float side = step(abs(vNo.y), 0.5);
  vec2 fu = abs(vNo.x) > 0.5 ? vec2(vWp.z, vWp.y) : vec2(vWp.x, vWp.y);
  float glassy = vStyle.y;
  vec2 cellSz = mix(vec2(3.3, 3.5), vec2(2.4, 3.8), glassy);
  vec2 c = fu / cellSz;
  vec2 id = floor(c);
  vec2 f = fract(c);
  vec2 lo = mix(vec2(0.24, 0.30), vec2(0.07, 0.14), glassy);
  vec2 hi = mix(vec2(0.76, 0.82), vec2(0.93, 0.90), glassy);
  float win = step(lo.x, f.x) * step(f.x, hi.x) * step(lo.y, f.y) * step(f.y, hi.y);
  float cover = (hi.x - lo.x) * (hi.y - lo.y);
  float dist = length(vWp - cameraPosition);
  // Fade on the size of a window on screen, not only on distance: a wall seen
  // edge-on runs out of pixels long before a wall seen square does.
  float fw = max(fwidth(c.x), fwidth(c.y));
  float far = max(smoothstep(180.0, 560.0, dist), smoothstep(0.22, 0.7, fw));
  // The seed is rounded first. It is constant per building, but it arrives as
  // an interpolated varying, and a hash turns the last bit of that into static.
  float sd = floor(vStyle.x * 997.0 + 0.5);
  float h = fract(sin(dot(mod(id, 251.0) + sd * 0.37, vec2(12.9898, 78.233))) * 43758.5453);
  // Up close a window is a window. Far away it is its average, which is what
  // stops a tower shimmering as you drive toward it.
  float w = mix(win, cover, far) * side;
  vec3 glass = mix(vec3(0.05, 0.08, 0.12), uSky * 0.6, 0.35 + 0.35 * h);
  // A band of plain wall at each floor line and a darker ground floor.
  diffuseColor.rgb *= 0.9 + 0.1 * step(0.08, f.y);
  diffuseColor.rgb = mix(diffuseColor.rgb, glass, w * 0.92);
  diffuseColor.rgb *= mix(0.42, 1.0, side);
  float on = step(1.0 - 0.42 * uNight, h);
  fcLit = mix(win * on, cover * 0.42, far) * side * uNight;
}`)
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += mix(vec3(1.0, 0.74, 0.42), vec3(0.8, 0.9, 1.0), step(0.8, fract(vStyle.x * 37.0))) * fcLit * 0.85;");
  };
  return mat;
}

function buildBuildings(group: THREE.Group, disposables: Array<{ dispose(): void }>): void {
  const all = allBoxes().filter((b) => b.seed >= 0);
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const mat = facadeMaterial();
  const mesh = new THREE.InstancedMesh(boxGeo, mat, all.length);
  const style = new Float32Array(all.length * 2);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();
  all.forEach((b, i) => {
    m.compose(
      new THREE.Vector3((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2),
      q,
      new THREE.Vector3(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0),
    );
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, col.setHex(b.color));
    style[i * 2] = b.seed;
    style[i * 2 + 1] = b.glass;
  });
  boxGeo.setAttribute("aStyle", new THREE.InstancedBufferAttribute(style, 2));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.name = "buildings";
  group.add(mesh);
  disposables.push(boxGeo, mat);

  // Gables: a prism per pitched roof, ridge along z in its own space.
  const gabled = all.filter((b) => b.gable !== 0);
  const prism = new THREE.BufferGeometry();
  // prettier-ignore
  const pv = new Float32Array([
    -0.5, 0, -0.5,  0.5, 0, -0.5,  0, 1, -0.5,
     0.5, 0, 0.5,  -0.5, 0, 0.5,   0, 1, 0.5,
    -0.5, 0, 0.5,  -0.5, 0, -0.5,  0, 1, -0.5,   -0.5, 0, 0.5,  0, 1, -0.5,  0, 1, 0.5,
     0.5, 0, -0.5,  0.5, 0, 0.5,   0, 1, 0.5,     0.5, 0, -0.5, 0, 1, 0.5,   0, 1, -0.5,
  ]);
  prism.setAttribute("position", new THREE.BufferAttribute(pv, 3));
  prism.computeVertexNormals();
  const roofMat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const roofs = new THREE.InstancedMesh(prism, roofMat, gabled.length);
  const ROOF = [0x4a4442, 0x5b4a44, 0x3d4248, 0x6a5148, 0x44403c];
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  gabled.forEach((b, i) => {
    const w = b.x1 - b.x0;
    const d = b.z1 - b.z0;
    const alongX = b.gable === 1;
    m.compose(
      new THREE.Vector3((b.x0 + b.x1) / 2, b.y1, (b.z0 + b.z1) / 2),
      alongX ? turn : q,
      new THREE.Vector3((alongX ? d : w) + 0.5, (alongX ? d : w) * 0.42, (alongX ? w : d) + 0.5),
    );
    roofs.setMatrixAt(i, m);
    roofs.setColorAt(i, col.setHex(ROOF[Math.floor(b.seed * 97) % ROOF.length]));
  });
  roofs.castShadow = true;
  roofs.frustumCulled = false;
  group.add(roofs);
  disposables.push(prism, roofMat);
}

/* ---------------------------------------------------------------- trees and lamps */

function buildTrees(group: THREE.Group, disposables: Array<{ dispose(): void }>): THREE.MeshBasicMaterial {
  const spots: Array<{ x: number; z: number; s: number; palm: boolean }> = [];
  for (let i = -IMAX; i < IMAX; i++) {
    for (let j = -JMAX; j < JMAX; j++) {
      const kind = blockKind(i, j);
      const x0 = i * BX;
      const z0 = j * BZ;
      const r = (n: number): number => hash2(i * 13 + n * 7 + 1, j * 29 + n * 11 + 2);
      if (kind === "park" || kind === "forest") {
        const n = kind === "forest" ? 16 : 9;
        for (let k = 0; k < n; k++) {
          spots.push({ x: x0 + 16 + r(k) * (BX - 32), z: z0 + 16 + r(k + 40) * (BZ - 32), s: 0.9 + r(k + 80) * 0.9, palm: false });
        }
      } else if (kind === "homes") {
        // Street trees on the pavement, and one in the yards.
        for (let k = 0; k < 3; k++) {
          if (r(k + 5) < 0.5) spots.push({ x: x0 + 20 + k * 26, z: z0 + WALK - 1.4, s: 0.6 + r(k) * 0.3, palm: false });
        }
        spots.push({ x: x0 + 20 + r(9) * 50, z: z0 + BZ / 2, s: 0.7 + r(10) * 0.4, palm: false });
      } else if (kind === "plaza") {
        for (let k = 0; k < 6; k++) spots.push({ x: x0 + 18 + k * 12, z: z0 + 15, s: 0.7, palm: true });
      }
    }
  }
  // Palms down the Embarcadero.
  for (let z = -GRID_Z + 20; z < GRID_Z; z += 24) spots.push({ x: IMAX * BX + ROAD + 1.6, z, s: 0.9, palm: true });

  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 1, 5);
  trunkGeo.translate(0, 0.5, 0);
  const crownGeo = new THREE.IcosahedronGeometry(1, 0);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a4636 });
  const crownMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();
  spots.forEach((t, i) => {
    const y = heightAt(t.x, t.z);
    const th = t.palm ? 8 * t.s : 3.4 * t.s;
    m.compose(new THREE.Vector3(t.x, y - 0.2, t.z), q, new THREE.Vector3(t.palm ? 1.1 : 1.4 * t.s, th, t.palm ? 1.1 : 1.4 * t.s));
    trunks.setMatrixAt(i, m);
    const cr = t.palm ? 2.2 : 2.6 * t.s;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash2(i, 7) * 6.28);
    m.compose(new THREE.Vector3(t.x, y + th + (t.palm ? 0 : cr * 0.55), t.z), q, new THREE.Vector3(cr, t.palm ? cr * 0.45 : cr * (0.9 + hash2(i, 3) * 0.5), cr));
    q.identity();
    crowns.setMatrixAt(i, m);
    const g = hash2(i, 11);
    crowns.setColorAt(i, t.palm ? col.setRGB(0.22, 0.42, 0.2) : col.setRGB(0.16 + g * 0.12, 0.34 + g * 0.16, 0.14 + g * 0.06));
  });
  crowns.castShadow = true;
  trunks.frustumCulled = false;
  crowns.frustumCulled = false;
  group.add(trunks, crowns);
  disposables.push(trunkGeo, crownGeo, trunkMat, crownMat);

  // Street lamps: a pole and a head on two corners of every junction.
  const poles: Array<[number, number]> = [];
  for (let i = -IMAX; i <= IMAX; i++) {
    for (let j = -JMAX; j <= JMAX; j++) {
      poles.push([i * BX + ROAD + 0.9, j * BZ + ROAD + 0.9], [i * BX - ROAD - 0.9, j * BZ - ROAD - 0.9]);
    }
  }
  const poleGeo = new THREE.BoxGeometry(0.16, 7, 0.16);
  poleGeo.translate(0, 3.5, 0);
  const headGeo = new THREE.BoxGeometry(0.5, 0.22, 0.9);
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x2c3036 });
  const headMat = new THREE.MeshBasicMaterial({ color: 0x33302a });
  const poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, poles.length);
  const headMesh = new THREE.InstancedMesh(headGeo, headMat, poles.length);
  poles.forEach(([x, z], i) => {
    const y = heightAt(x, z);
    m.makeTranslation(x, y, z);
    poleMesh.setMatrixAt(i, m);
    m.makeTranslation(x, y + 7, z);
    headMesh.setMatrixAt(i, m);
  });
  poleMesh.frustumCulled = false;
  headMesh.frustumCulled = false;
  group.add(poleMesh, headMesh);
  disposables.push(poleGeo, headGeo, poleMat, headMat);
  return headMat;
}

/* ---------------------------------------------------------------- landmarks */

const ORANGE = 0xc0412c;

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** A suspension bridge along -z from z = 0, built in its own space. */
function suspensionBridge(length: number, towers: number[], deckY: number, color: number, half: number): THREE.Group {
  const g = new THREE.Group();
  const paint = new THREE.MeshLambertMaterial({ color });
  const parts: THREE.BufferGeometry[] = [];
  const towerTop = deckY + 150;
  for (const tz of towers) {
    for (const sx of [-1, 1]) {
      parts.push(box(6, towerTop + 12, 7, sx * (half + 3.5), (towerTop - 12) / 2, tz));
    }
    for (const y of [deckY - 14, deckY + 42, deckY + 86, deckY + 128, towerTop - 4]) {
      parts.push(box(half * 2 + 7, 7, 5, 0, y, tz));
    }
  }
  // Deck: a truss box under a thin road.
  parts.push(box(half * 2 + 2.4, 5, length, 0, deckY - 3.2, -length / 2));
  // Railings.
  for (const sx of [-1, 1]) parts.push(box(0.5, 1.3, length, sx * (half + 0.6), deckY + 0.6, -length / 2));
  // Main cables and suspenders. The cable is a catenary between towers and a
  // straight run down to the anchorages.
  const cableY = (z: number): number => {
    const [a, b] = towers;
    if (z > a) return deckY + 3 + (towerTop - deckY - 3) * Math.pow(Math.max(0, 1 - (z - a) / (0 - a)), 1.6);
    if (z < b) return deckY + 3 + (towerTop - deckY - 3) * Math.pow(Math.max(0, 1 - (b - z) / (b + length)), 1.6);
    const m = (z - b) / (a - b);
    return deckY + 8 + (towerTop - deckY - 8) * Math.pow(Math.abs(m * 2 - 1), 2);
  };
  for (const sx of [-1, 1]) {
    const x = sx * (half + 3.5);
    const step = 14;
    for (let z = 0; z > -length; z -= step) {
      const y0 = cableY(z);
      const y1 = cableY(z - step);
      const seg = new THREE.BoxGeometry(1.1, 1.1, Math.hypot(step, y1 - y0));
      seg.rotateX(Math.atan2(y1 - y0, step));
      seg.translate(x, (y0 + y1) / 2, z - step / 2);
      parts.push(seg);
      const hang = y0 - deckY;
      if (hang > 2) parts.push(box(0.22, hang, 0.22, x, deckY + hang / 2, z));
    }
  }
  const merged = mergeGeometries(parts.map((p) => p.toNonIndexed()), false)!;
  parts.forEach((p) => p.dispose());
  const mesh = new THREE.Mesh(merged, paint);
  mesh.castShadow = false;
  g.add(mesh);
  const road = new THREE.Mesh(new THREE.BoxGeometry(half * 2, 0.5, length), new THREE.MeshLambertMaterial({ color: 0x5c5e62 }));
  road.position.set(0, deckY - 0.3, -length / 2);
  g.add(road);
  const line = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.54, length), new THREE.MeshLambertMaterial({ color: 0xd9a92a }));
  line.position.copy(road.position);
  g.add(line);
  return g;
}

function buildLandmarks(group: THREE.Group, disposables: Array<{ dispose(): void }>): void {
  const white = new THREE.MeshLambertMaterial({ color: 0xe9e6de });
  const stone = new THREE.MeshLambertMaterial({ color: 0xcfc6b4 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x3a3f46 });
  disposables.push(white, stone, dark);

  // The Pyramid: four sides to a point, with its two "ears" and a spire.
  {
    const y = heightAt(PYRAMID.x, PYRAMID.z);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(PYRAMID.half * 1.42, PYRAMID.h, 4, 1), white);
    cone.rotation.y = Math.PI / 4;
    cone.position.set(PYRAMID.x, y + PYRAMID.h / 2, PYRAMID.z);
    cone.castShadow = true;
    const ears = new THREE.Mesh(mergeGeometries([box(5, 70, 9, PYRAMID.x - 13, y + 150, PYRAMID.z), box(5, 70, 9, PYRAMID.x + 13, y + 150, PYRAMID.z)])!, white);
    group.add(cone, ears);
  }
  // The tall one gets a rounded crown.
  {
    const y = heightAt(SPIRE.x, SPIRE.z) + SPIRE.h;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(8, SPIRE.half * 1.2, 34, 4, 1), new THREE.MeshLambertMaterial({ color: 0x9ab6c8 }));
    cap.rotation.y = Math.PI / 4;
    cap.position.set(SPIRE.x, y + 15, SPIRE.z);
    group.add(cap);
  }
  // Coit Tower: a fluted column with an arcaded crown.
  {
    const y = heightAt(COIT.x, COIT.z);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(COIT.r * 0.82, COIT.r, COIT.h, 18), stone);
    shaft.position.set(COIT.x, y + COIT.h / 2, COIT.z);
    shaft.castShadow = true;
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(COIT.r * 0.7, COIT.r * 0.7, 9, 18, 1, true), stone);
    crown.position.set(COIT.x, y + COIT.h + 4.5, COIT.z);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(COIT.r * 1.7, COIT.r * 1.9, 5, 18), stone);
    base.position.set(COIT.x, y + 2, COIT.z);
    group.add(shaft, crown, base);
  }
  // Sutro Tower: three legs, three waists, three masts, red and white.
  {
    const y = heightAt(SUTRO.x, SUTRO.z);
    const red = new THREE.MeshLambertMaterial({ color: 0xc8402e });
    disposables.push(red);
    const parts: THREE.BufferGeometry[] = [];
    const whites: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      const leg = new THREE.CylinderGeometry(1.2, 2.2, 110, 5);
      leg.translate(Math.cos(a) * 15, 55, Math.sin(a) * 15);
      (k % 2 ? whites : parts).push(leg);
      const mast = new THREE.CylinderGeometry(0.5, 1.0, 46, 4);
      mast.translate(Math.cos(a) * 13, 110 + 23, Math.sin(a) * 13);
      (k % 2 ? parts : whites).push(mast);
    }
    for (const yy of [38, 74, 108]) {
      const ring = new THREE.TorusGeometry(15, 0.9, 4, 3);
      ring.rotateX(Math.PI / 2);
      ring.translate(0, yy, 0);
      (yy === 74 ? whites : parts).push(ring);
    }
    const a = new THREE.Mesh(mergeGeometries(parts)!, red);
    const b = new THREE.Mesh(mergeGeometries(whites)!, white);
    a.position.set(SUTRO.x, y, SUTRO.z);
    b.position.copy(a.position);
    group.add(a, b);
  }
  // City Hall: a long block, a drum and a dome.
  {
    const y = heightAt(CITY_HALL.x, CITY_HALL.z);
    const body = new THREE.Mesh(mergeGeometries([box(52, 18, 24, 0, 9, 0), box(22, 24, 30, 0, 12, 0)])!, stone);
    body.position.set(CITY_HALL.x, y, CITY_HALL.z);
    body.castShadow = true;
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(8, 9, 14, 20), stone);
    drum.position.set(CITY_HALL.x, y + 31, CITY_HALL.z);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(8.4, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x8fa39a }));
    dome.scale.y = 1.25;
    dome.position.set(CITY_HALL.x, y + 38, CITY_HALL.z);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(1.2, 9, 8), new THREE.MeshLambertMaterial({ color: 0xd8b25a }));
    tip.position.set(CITY_HALL.x, y + 52, CITY_HALL.z);
    group.add(body, drum, dome, tip);
  }
  // The Ferry Building: a long shed and a clock tower.
  {
    const hall = new THREE.Mesh(box(14, 15, 120, FERRY.x, 8.5, FERRY.z), stone);
    hall.castShadow = true;
    const tower = new THREE.Mesh(mergeGeometries([box(8, FERRY.h, 8, FERRY.x, FERRY.h / 2 + 1, FERRY.z), box(6, 10, 6, FERRY.x, FERRY.h + 6, FERRY.z)])!, white);
    tower.castShadow = true;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(3.4, 10, 4), dark);
    tip.rotation.y = Math.PI / 4;
    tip.position.set(FERRY.x, FERRY.h + 16, FERRY.z);
    const clock = new THREE.Mesh(new THREE.CircleGeometry(2.6, 20), new THREE.MeshBasicMaterial({ color: 0xf3ead2 }));
    clock.position.set(FERRY.x - 4.06, FERRY.h - 6, FERRY.z);
    clock.rotation.y = -Math.PI / 2;
    group.add(hall, tower, tip, clock);
  }
  // Alcatraz: a cell block, a lighthouse, a water tower.
  {
    const y = heightAt(230, -1680);
    const rock = new THREE.Mesh(mergeGeometries([box(70, 12, 22, 230, y + 4, -1680), box(24, 9, 16, 190, y + 1, -1650)])!, stone);
    const light = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.4, 26, 8), white);
    light.position.set(262, y + 16, -1668);
    group.add(rock, light);
  }
  // The Golden Gate. The deck is drivable; see `deckAt` in world.ts.
  {
    const len = GG_Z1 - GG_Z2;
    const gg = suspensionBridge(len, GG_TOWERS.map((z) => z - GG_Z1), GG_DECK, ORANGE, GG_HALF);
    gg.position.set(GG_X, 0, GG_Z1);
    group.add(gg);
    // The approaches: road ribbons from the bluff up to the deck, each end.
    const ribbon = (za: number, zb: number): void => {
      const n = 14;
      const pos: number[] = [];
      for (let k = 0; k <= n; k++) {
        const z = za + ((zb - za) * k) / n;
        const yy = deckAt(GG_X, z) + 0.05;
        pos.push(GG_X - GG_HALF, yy, z, GG_X + GG_HALF, yy, z);
      }
      const idx: number[] = [];
      for (let k = 0; k < n; k++) {
        const a = k * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x5c5e62, side: THREE.DoubleSide }));
      group.add(mesh);
      disposables.push(geo);
    };
    ribbon(GG_Z0, GG_Z1);
    ribbon(GG_Z2, GG_Z3);
  }
  // The Bay Bridge, off to the east. Scenery: it leaves from the waterfront
  // and goes into the haze.
  {
    const bay = suspensionBridge(1500, [-380, -1060], 48, 0x9ea4a8, 8);
    bay.rotation.y = -Math.PI / 2;
    bay.position.set(SHORE_X - 4, 0, 2.5 * BZ);
    group.add(bay);
  }
}

/* ---------------------------------------------------------------- sky and water */

function buildSky(): { mesh: THREE.Mesh; uniforms: City["skyUniforms"] } {
  const uniforms = {
    uTop: { value: new THREE.Color(0x3f78c4) },
    uHorizon: { value: new THREE.Color(0xb9d4ea) },
    uSun: { value: new THREE.Vector3(0.3, 0.8, 0.2) },
    uSunColor: { value: new THREE.Color(0xfff2d8) },
    uNight: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: "varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `
varying vec3 vDir;
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSun; uniform vec3 uSunColor; uniform float uNight;
float h3(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float t = pow(clamp(1.0 - max(d.y, 0.0), 0.0, 1.0), 2.6);
  vec3 col = mix(uTop, uHorizon, t);
  float mu = max(dot(d, uSun), 0.0);
  // A wide warm bloom toward the sun, a tight halo, then the disc.
  col += uSunColor * (pow(mu, 6.0) * 0.22 + pow(mu, 64.0) * 0.5 + smoothstep(0.9993, 0.9997, mu) * 6.0) * (1.0 - uNight);
  vec3 g = floor(d * 260.0);
  float s = step(0.997, h3(g)) * smoothstep(0.05, 0.4, d.y);
  col += vec3(0.9, 0.95, 1.0) * s * uNight;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(4500, 24, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return { mesh, uniforms };
}

export function buildCity(): City {
  const group = new THREE.Group();
  const disposables: Array<{ dispose(): void }> = [];

  group.add(buildTerrain());
  buildBuildings(group, disposables);
  const lamps = buildTrees(group, disposables);
  buildLandmarks(group, disposables);

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(16000, 16000),
    new THREE.MeshStandardMaterial({ color: 0x2b5b78, roughness: 0.28, metalness: 0.35 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0;
  group.add(water);

  const { mesh: sky, uniforms } = buildSky();
  group.add(sky);

  return {
    group,
    sky,
    skyUniforms: uniforms,
    water,
    lamps,
    dispose() {
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      disposables.forEach((d) => d.dispose());
    },
  };
}
