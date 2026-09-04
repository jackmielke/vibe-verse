/**
 * Flow Phangan: the island, drawn.
 *
 * Everything here is built from `island.ts`, so the terrain the scooter rides
 * on and the terrain you see are the same function. Palms and jungle are two
 * instanced meshes each; every building is a handful of boxes; nothing is
 * fetched. The sky is a table of colours by the minute, and the rain is a
 * wall that walks in from the east and a cloud of points around the camera.
 *
 * No shadow maps. The sandbox renders this in software, and a real phone
 * would rather have the palms.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  CHALOKLUM,
  CHECKPOINT,
  DOGS,
  GYM,
  HAAD_RIN,
  HAAD_SALAD,
  PAD_THAI_STOPS,
  ROADS,
  ROAD_HALF_WIDTH,
  THONG_SALA,
  VILLA,
  WATERFALL,
  coastRadius,
  isLand,
  nearestRoad,
  resample,
  ringPoint,
  terrainHeight,
  type Vec2,
} from "./island";
import { mulberry32 } from "./day";
import { DARK_MINUTE, SUNSET_MINUTE } from "./day";

export interface SkyFrame {
  sky: THREE.Color;
  fog: THREE.Color;
  sun: THREE.Color;
  sunIntensity: number;
  hemiIntensity: number;
  /** Sun direction, unit length. */
  sunDir: THREE.Vector3;
  /** 0 by day, 1 at night. Drives the headlight and the villa lights. */
  night: number;
}

interface SkyKey {
  minute: number;
  sky: number;
  fog: number;
  sun: number;
  sunI: number;
  hemiI: number;
  elev: number;
}

const SKY_KEYS: SkyKey[] = [
  { minute: 16 * 60, sky: 0x86cfee, fog: 0xd6ecf6, sun: 0xfff3dc, sunI: 2.2, hemiI: 0.95, elev: 46 },
  { minute: 17 * 60 + 30, sky: 0x8fc9e8, fog: 0xe4e6d8, sun: 0xffe8c2, sunI: 1.8, hemiI: 0.85, elev: 22 },
  { minute: SUNSET_MINUTE - 15, sky: 0xe9b07a, fog: 0xffd9a8, sun: 0xffb070, sunI: 2.0, hemiI: 0.75, elev: 7 },
  { minute: SUNSET_MINUTE + 5, sky: 0xa8607a, fog: 0xe8a080, sun: 0xff8a50, sunI: 0.9, hemiI: 0.55, elev: -1 },
  { minute: 19 * 60, sky: 0x3d2f5a, fog: 0x6b4a6a, sun: 0x8f7fbf, sunI: 0.25, hemiI: 0.3, elev: -8 },
  { minute: DARK_MINUTE, sky: 0x131a33, fog: 0x1e2742, sun: 0x8fa0d8, sunI: 0.16, hemiI: 0.22, elev: -14 },
  { minute: 20 * 60 + 30, sky: 0x0a0f22, fog: 0x141b30, sun: 0x8fa0d8, sunI: 0.14, hemiI: 0.2, elev: -20 },
];

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();

/** The sky at a given minute, with the rain darkening everything toward grey. */
export function skyFor(minute: number, rain: number, out: SkyFrame): SkyFrame {
  let i = 0;
  while (i < SKY_KEYS.length - 2 && SKY_KEYS[i + 1].minute < minute) i++;
  const a = SKY_KEYS[i];
  const b = SKY_KEYS[i + 1];
  const t = Math.max(0, Math.min(1, (minute - a.minute) / (b.minute - a.minute)));
  out.sky.copy(tmpA.setHex(a.sky)).lerp(tmpB.setHex(b.sky), t);
  out.fog.copy(tmpA.setHex(a.fog)).lerp(tmpB.setHex(b.fog), t);
  out.sun.copy(tmpA.setHex(a.sun)).lerp(tmpB.setHex(b.sun), t);
  out.sunIntensity = a.sunI + (b.sunI - a.sunI) * t;
  out.hemiIntensity = a.hemiI + (b.hemiI - a.hemiI) * t;
  const elev = ((a.elev + (b.elev - a.elev) * t) * Math.PI) / 180;
  // The sun sets over the sea, which is to the west, a little north of due west in May.
  const az = -1.18 + (minute - 16 * 60) * 0.0009;
  out.sunDir.set(Math.cos(elev) * Math.sin(az), Math.sin(elev), Math.cos(elev) * Math.cos(az)).normalize();
  out.night = Math.max(0, Math.min(1, (minute - (SUNSET_MINUTE + 5)) / (DARK_MINUTE - SUNSET_MINUTE - 5)));
  if (rain > 0) {
    const grey = tmpA.setHex(0x55606c);
    out.sky.lerp(grey, rain * 0.55);
    out.fog.lerp(tmpB.setHex(0x6d7884), rain * 0.6);
    out.sunIntensity *= 1 - rain * 0.5;
    out.hemiIntensity *= 1 - rain * 0.2;
  }
  return out;
}

export function newSkyFrame(): SkyFrame {
  return {
    sky: new THREE.Color(),
    fog: new THREE.Color(),
    sun: new THREE.Color(),
    sunIntensity: 1,
    hemiIntensity: 1,
    sunDir: new THREE.Vector3(0, 1, 0),
    night: 0,
  };
}

// ---------------------------------------------------------------------------
// Terrain, sea, roads
// ---------------------------------------------------------------------------

function buildTerrain(): THREE.Mesh {
  const size = 1200;
  const seg = 150;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colours = new Float32Array(pos.count * 3);
  const sand = new THREE.Color(0xe9d9a4);
  const grass = new THREE.Color(0x6fae4a);
  const jungle = new THREE.Color(0x2f6b34);
  const rock = new THREE.Color(0x7d7a66);
  const seabed = new THREE.Color(0x9fc9b4);
  const c = new THREE.Color();
  const rng = mulberry32(5);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = terrainHeight(x, z);
    pos.setY(i, h);
    const coast = coastRadius(Math.atan2(z, x));
    const s = coast - Math.hypot(x, z);
    if (s < 0) c.copy(seabed).lerp(new THREE.Color(0x3f7f8a), Math.min(1, -s / 60));
    else if (s < 14) c.copy(sand);
    else if (s < 26) c.copy(sand).lerp(grass, (s - 14) / 12);
    else {
      c.copy(grass).lerp(jungle, Math.min(1, (s - 26) / 90));
      if (h > 55) c.lerp(rock, Math.min(1, (h - 55) / 40));
    }
    const jitter = 0.94 + rng() * 0.12;
    colours[i * 3] = c.r * jitter;
    colours[i * 3 + 1] = c.g * jitter;
    colours[i * 3 + 2] = c.b * jitter;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  return new THREE.Mesh(geo, mat);
}

function buildSea(): { near: THREE.Mesh; far: THREE.Mesh; mat: THREE.MeshPhongMaterial } {
  const mat = new THREE.MeshPhongMaterial({
    color: 0x2ec4c6,
    transparent: true,
    opacity: 0.72,
    shininess: 90,
    specular: 0xffffff,
    depthWrite: false,
  });
  const near = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), mat);
  near.rotation.x = -Math.PI / 2;
  near.position.y = 0;
  const far = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshLambertMaterial({ color: 0x1b7f9c }));
  far.rotation.x = -Math.PI / 2;
  far.position.y = -0.6;
  return { near, far, mat };
}

function ribbon(points: Vec2[], halfWidth: number, lift: number, closed: boolean): THREE.BufferGeometry {
  const pts = resample(points, 5, closed);
  if (closed) pts.push(pts[0]);
  const n = pts.length;
  const verts = new Float32Array(n * 2 * 3);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[Math.min(n - 1, i + 1)];
    const o = pts[Math.max(0, i - 1)];
    let dx = q.x - o.x;
    let dz = q.z - o.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const px = -dz * halfWidth;
    const pz = dx * halfWidth;
    const y1 = terrainHeight(p.x + px, p.z + pz) + lift;
    const y2 = terrainHeight(p.x - px, p.z - pz) + lift;
    const y = Math.max(y1, y2, terrainHeight(p.x, p.z) + lift);
    verts.set([p.x + px, y, p.z + pz], i * 6);
    verts.set([p.x - px, y, p.z - pz], i * 6 + 3);
    // Wound so the normals face up: v0 is the right edge, v1 the left, v2 the next right.
    if (i < n - 1) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

interface RoadMeshes {
  group: THREE.Group;
  asphalt: THREE.MeshLambertMaterial;
  concrete: THREE.MeshLambertMaterial;
}

function buildRoads(): RoadMeshes {
  const group = new THREE.Group();
  const asphalt = new THREE.MeshLambertMaterial({ color: 0x66625c, side: THREE.DoubleSide });
  const concrete = new THREE.MeshLambertMaterial({ color: 0x9d9a90, side: THREE.DoubleSide });
  const line = new THREE.MeshBasicMaterial({ color: 0xe8c14a, side: THREE.DoubleSide });
  for (const road of ROADS) {
    const mesh = new THREE.Mesh(ribbon(road.points, road.steep ? ROAD_HALF_WIDTH * 0.8 : ROAD_HALF_WIDTH, 0.22, road.closed), road.steep ? concrete : asphalt);
    group.add(mesh);
    if (!road.steep) group.add(new THREE.Mesh(ribbon(road.points, 0.14, 0.26, road.closed), line));
  }
  return { group, asphalt, concrete };
}

// ---------------------------------------------------------------------------
// Palms and jungle
// ---------------------------------------------------------------------------

function palmCrownGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 7; i++) {
    const frond = new THREE.PlaneGeometry(0.9, 4.2, 1, 3);
    // Droop the tip.
    const p = frond.attributes.position as THREE.BufferAttribute;
    for (let v = 0; v < p.count; v++) {
      const y = p.getY(v);
      const t = (y + 2.1) / 4.2;
      p.setZ(v, -t * t * 1.6);
    }
    frond.translate(0, 2.1, 0);
    frond.rotateX(-0.55);
    frond.rotateY((i / 7) * Math.PI * 2);
    parts.push(frond);
  }
  return mergeGeometries(parts, false)!;
}

interface Instanced {
  meshes: THREE.InstancedMesh[];
}

function buildPalms(): Instanced {
  const rng = mulberry32(11);
  const spots: { x: number; z: number; h: number; lean: number; yaw: number }[] = [];
  let tries = 0;
  while (spots.length < 520 && tries++ < 20000) {
    const th = rng() * Math.PI * 2;
    const coast = coastRadius(th);
    const s = 6 + rng() * 42;
    const r = coast - s;
    const x = Math.cos(th) * r;
    const z = Math.sin(th) * r;
    if (nearestRoad(x, z).dist < ROAD_HALF_WIDTH + 1.5) continue;
    spots.push({ x, z, h: terrainHeight(x, z), lean: (rng() - 0.5) * 0.35, yaw: rng() * Math.PI * 2 });
  }
  // A few by the villa and the pool.
  for (let i = 0; i < 10; i++) {
    const x = VILLA.pos.x + (rng() - 0.5) * 40;
    const z = VILLA.pos.z + (rng() - 0.5) * 40;
    if (nearestRoad(x, z).dist < ROAD_HALF_WIDTH + 1.5) continue;
    spots.push({ x, z, h: terrainHeight(x, z), lean: (rng() - 0.5) * 0.3, yaw: rng() * Math.PI * 2 });
  }
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.3, 8, 6);
  trunkGeo.translate(0, 4, 0);
  const trunk = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x9a7b56 }), spots.length);
  const crown = new THREE.InstancedMesh(
    palmCrownGeometry(),
    new THREE.MeshLambertMaterial({ color: 0x3f9a3c, side: THREE.DoubleSide }),
    spots.length,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const sc = new THREE.Vector3();
  const v = new THREE.Vector3();
  spots.forEach((s, i) => {
    const scale = 0.8 + rng() * 0.5;
    e.set(s.lean, s.yaw, s.lean * 0.6);
    q.setFromEuler(e);
    sc.set(scale, scale, scale);
    v.set(s.x, s.h, s.z);
    m.compose(v, q, sc);
    trunk.setMatrixAt(i, m);
    // The crown sits at the top of the leaning trunk.
    const top = new THREE.Vector3(0, 8 * scale, 0).applyQuaternion(q).add(v);
    e.set(0, s.yaw + 0.4, 0);
    q.setFromEuler(e);
    m.compose(top, q, sc);
    crown.setMatrixAt(i, m);
  });
  trunk.instanceMatrix.needsUpdate = true;
  crown.instanceMatrix.needsUpdate = true;
  return { meshes: [trunk, crown] };
}

function buildJungle(): Instanced {
  const rng = mulberry32(23);
  const spots: { x: number; z: number; h: number; s: number; c: number }[] = [];
  let tries = 0;
  while (spots.length < 900 && tries++ < 30000) {
    const x = (rng() - 0.5) * 720;
    const z = (rng() - 0.5) * 720;
    if (!isLand(x, z)) continue;
    const coast = coastRadius(Math.atan2(z, x));
    const inland = coast - Math.hypot(x, z);
    if (inland < 44) continue;
    const h = terrainHeight(x, z);
    if (h > 82) continue;
    if (nearestRoad(x, z).dist < ROAD_HALF_WIDTH + 2.5) continue;
    if (Math.hypot(x - VILLA.pos.x, z - VILLA.pos.z) < 26) continue;
    if (Math.hypot(x - GYM.pos.x, z - GYM.pos.z) < 14) continue;
    spots.push({ x, z, h, s: 0.7 + rng() * 0.8, c: rng() });
  }
  const canopyGeo = new THREE.DodecahedronGeometry(4, 0);
  canopyGeo.scale(1, 0.8, 1);
  canopyGeo.translate(0, 6.5, 0);
  const canopy = new THREE.InstancedMesh(canopyGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), spots.length);
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.4, 5, 5);
  trunkGeo.translate(0, 2.5, 0);
  const trunk = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x6b4f34 }), spots.length);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  const dark = new THREE.Color(0x24602c);
  const light = new THREE.Color(0x5aa844);
  spots.forEach((s, i) => {
    m.makeScale(s.s, s.s, s.s);
    m.setPosition(s.x, s.h, s.z);
    canopy.setMatrixAt(i, m);
    trunk.setMatrixAt(i, m);
    col.copy(dark).lerp(light, s.c);
    canopy.setColorAt(i, col);
  });
  canopy.instanceMatrix.needsUpdate = true;
  trunk.instanceMatrix.needsUpdate = true;
  if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
  return { meshes: [trunk, canopy] };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

const box = (w: number, h: number, d: number, colour: number, emissive = 0): THREE.Mesh => {
  const mat = new THREE.MeshLambertMaterial({ color: colour });
  if (emissive) {
    mat.emissive = new THREE.Color(emissive);
    mat.emissiveIntensity = 0.7;
  }
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.y = h / 2;
  return m;
};

const place = (obj: THREE.Object3D, p: Vec2, lift = 0, yaw = 0) => {
  obj.position.set(p.x, terrainHeight(p.x, p.z) + lift, p.z);
  obj.rotation.y = yaw;
  return obj;
};

function yawToward(p: Vec2, dir: Vec2): number {
  return Math.atan2(dir.x, dir.z) + Math.PI + (p.x === undefined ? 0 : 0);
}

function buildVilla(): THREE.Group {
  const g = new THREE.Group();
  const main = box(16, 4.2, 9, 0xf4efe4);
  g.add(main);
  const roof = box(17, 0.5, 10, 0x8a5a3c);
  roof.position.y = 4.4;
  g.add(roof);
  const upper = box(8, 3.2, 7, 0xf8f4ea);
  upper.position.set(-3, 4.6 + 1.6, 0);
  g.add(upper);
  // Forty-five feet of pool, out over the jungle.
  const deck = box(20, 0.35, 8, 0xd8c9a6);
  deck.position.set(2, 0.17, 9.5);
  g.add(deck);
  const pool = box(15, 0.3, 4.4, 0x39c2d8, 0x2aa8c4);
  pool.position.set(2, 0.42, 9.5);
  g.add(pool);
  for (let i = 0; i < 4; i++) {
    const lounger = box(0.7, 0.3, 1.8, 0xffffff);
    lounger.position.set(-5 + i * 3.2, 0.5, 13);
    g.add(lounger);
  }
  const lamp = new THREE.PointLight(0xffd9a0, 0, 60, 1.8);
  lamp.position.set(2, 3, 9.5);
  lamp.name = "villaLight";
  g.add(lamp);
  return g;
}

function buildTown(center: Vec2, count: number, seed: number, palette: number[]): THREE.Group {
  const g = new THREE.Group();
  const rng = mulberry32(seed);
  let tries = 0;
  let n = 0;
  while (n < count && tries++ < 400) {
    const x = center.x + (rng() - 0.5) * 90;
    const z = center.z + (rng() - 0.5) * 90;
    if (!isLand(x, z)) continue;
    const road = nearestRoad(x, z);
    if (road.dist < ROAD_HALF_WIDTH + 2 || road.dist > 26) continue;
    const w = 5 + rng() * 6;
    const h = 3 + rng() * 5;
    const b = box(w, h, 4 + rng() * 6, palette[Math.floor(rng() * palette.length)]);
    place(b, { x, z }, 0, Math.atan2(road.dir.x, road.dir.z));
    b.position.y += h / 2 - 0.2;
    g.add(b);
    n++;
  }
  return g;
}

function buildSevenEleven(p: Vec2, yaw: number): THREE.Group {
  const g = new THREE.Group();
  g.add(box(7, 3.4, 6, 0xf6f6f2));
  const stripe = (c: number, y: number) => {
    const s = box(7.2, 0.3, 0.2, c, c);
    s.position.set(0, y, 3.05);
    g.add(s);
  };
  stripe(0xff7a00, 3.0);
  stripe(0x1fa24a, 2.7);
  stripe(0xe4322b, 2.4);
  const light = new THREE.PointLight(0xffffff, 0, 30, 2);
  light.position.set(0, 3, 4);
  light.name = "shopLight";
  g.add(light);
  place(g, p, 0, yaw);
  return g;
}

function buildPier(p: Vec2, outward: Vec2, length: number): THREE.Group {
  const g = new THREE.Group();
  const deck = box(4, 0.5, length, 0x8d6e4c);
  deck.position.set(0, 1.2, -length / 2);
  g.add(deck);
  for (let i = 0; i < length / 8; i++) {
    const post = box(0.3, 2.4, 0.3, 0x5b4632);
    post.position.set(1.7, 0, -i * 8 - 2);
    g.add(post);
    const post2 = post.clone();
    post2.position.x = -1.7;
    g.add(post2);
  }
  g.position.set(p.x, 0, p.z);
  g.rotation.y = Math.atan2(outward.x, outward.z) + Math.PI;
  return g;
}

function buildLongtail(colour: number): THREE.Group {
  const g = new THREE.Group();
  const hull = box(1.4, 0.7, 7, colour);
  hull.position.y = 0.2;
  g.add(hull);
  const prow = box(0.5, 0.3, 2, colour);
  prow.position.set(0, 1.0, 4);
  prow.rotation.x = -0.5;
  g.add(prow);
  const pole = box(0.1, 3, 0.1, 0x3a2a1a);
  pole.position.set(0, 0.5, -2.5);
  pole.rotation.x = 0.4;
  g.add(pole);
  const lamp = box(0.3, 0.3, 0.3, 0x9dffb0, 0x66ff88);
  lamp.position.set(0, 2.2, 2);
  g.add(lamp);
  return g;
}

function buildBeachBar(p: Vec2): THREE.Group {
  const g = new THREE.Group();
  const counter = box(6, 1.1, 1.4, 0x8a5a3c);
  g.add(counter);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(5, 2.2, 8, 1, true), new THREE.MeshLambertMaterial({ color: 0xc9a65a, side: THREE.DoubleSide }));
  roof.position.y = 3.6;
  g.add(roof);
  for (let i = 0; i < 4; i++) {
    const post = box(0.2, 3, 0.2, 0x5b4632);
    post.position.set(Math.cos((i / 4) * Math.PI * 2) * 3, 0, Math.sin((i / 4) * Math.PI * 2) * 3);
    g.add(post);
  }
  for (let i = 0; i < 12; i++) {
    const bulb = box(0.18, 0.18, 0.18, 0xfff0a0, 0xffd36a);
    bulb.position.set(Math.cos((i / 12) * Math.PI * 2) * 4.2, 2.6, Math.sin((i / 12) * Math.PI * 2) * 4.2);
    g.add(bulb);
  }
  const light = new THREE.PointLight(0xffd36a, 0, 40, 1.8);
  light.position.y = 2.8;
  light.name = "barLight";
  g.add(light);
  place(g, p);
  return g;
}

function buildGym(): THREE.Group {
  const g = new THREE.Group();
  const floor = box(7, 0.6, 7, 0x2b4a8a);
  g.add(floor);
  for (const [x, z] of [
    [-3.4, -3.4],
    [3.4, -3.4],
    [-3.4, 3.4],
    [3.4, 3.4],
  ]) {
    const post = box(0.18, 2.2, 0.18, 0xe8e8e8);
    post.position.set(x, 0.6, z);
    g.add(post);
  }
  for (let r = 0; r < 3; r++) {
    for (const side of [0, 1, 2, 3]) {
      const rope = box(side % 2 === 0 ? 6.8 : 0.06, 0.06, side % 2 === 0 ? 0.06 : 6.8, [0xe63946, 0xffffff, 0x2b6cd8][r]);
      rope.position.set(side === 1 ? 3.4 : side === 3 ? -3.4 : 0, 1.3 + r * 0.5, side === 0 ? -3.4 : side === 2 ? 3.4 : 0);
      g.add(rope);
    }
  }
  const roof = box(9, 0.3, 9, 0x8a5a3c);
  roof.position.y = 4.4;
  g.add(roof);
  for (const [x, z] of [
    [-4.3, -4.3],
    [4.3, -4.3],
    [-4.3, 4.3],
    [4.3, 4.3],
  ]) {
    const post = box(0.25, 4.4, 0.25, 0x5b4632);
    post.position.set(x, 0, z);
    g.add(post);
  }
  const bag = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.3, 8), new THREE.MeshLambertMaterial({ color: 0xc8322e }));
  bag.position.set(5.2, 2.2, 0);
  g.add(bag);
  const light = new THREE.PointLight(0xfff0c0, 0, 30, 1.8);
  light.position.y = 4;
  light.name = "gymLight";
  g.add(light);
  place(g, GYM.pos, 0, 0.3);
  return g;
}

function buildWaterfall(): THREE.Group {
  const g = new THREE.Group();
  const rock = box(14, 18, 6, 0x5f5a50);
  rock.position.set(0, 9, -6);
  g.add(rock);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 17), new THREE.MeshLambertMaterial({ color: 0xe8f6ff, emissive: 0xbfe6ff, emissiveIntensity: 0.4, transparent: true, opacity: 0.85 }));
  water.position.set(0, 9, -2.9);
  g.add(water);
  const pool = new THREE.Mesh(new THREE.CircleGeometry(5, 16), new THREE.MeshLambertMaterial({ color: 0x3aa6a8, transparent: true, opacity: 0.8 }));
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.35;
  g.add(pool);
  const road = nearestRoad(WATERFALL.pos.x, WATERFALL.pos.z);
  const px = -road.dir.z;
  const pz = road.dir.x;
  const p = { x: WATERFALL.pos.x + px * 12, z: WATERFALL.pos.z + pz * 12 };
  place(g, p, 0, Math.atan2(px, pz) + Math.PI);
  return g;
}

function buildCheckpoint(): THREE.Group {
  const g = new THREE.Group();
  const hut = box(3, 2.6, 2.4, 0xe8e2d0);
  hut.position.set(5.5, 1.3, 0);
  g.add(hut);
  const roof = box(3.4, 0.2, 2.8, 0x8b2f2f);
  roof.position.set(5.5, 2.7, 0);
  g.add(roof);
  const bar = box(6.5, 0.18, 0.18, 0xffffff);
  bar.position.set(0.8, 1.05, 0);
  g.add(bar);
  for (let i = 0; i < 4; i++) {
    const s = box(0.7, 0.2, 0.2, 0xe63946);
    s.position.set(-1.6 + i * 1.6, 1.05, 0);
    g.add(s);
  }
  const cone = (x: number, z: number) => {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.7, 6), new THREE.MeshLambertMaterial({ color: 0xff7a1a }));
    c.position.set(x, 0.35, z);
    g.add(c);
  };
  cone(-2.8, 1.6);
  cone(-2.8, -1.6);
  const beacon = box(0.3, 0.3, 0.3, 0x3b7bff, 0x3b7bff);
  beacon.position.set(5.5, 3, 0);
  beacon.name = "blue";
  g.add(beacon);
  const road = nearestRoad(CHECKPOINT.pos.x, CHECKPOINT.pos.z);
  place(g, CHECKPOINT.pos, 0, Math.atan2(road.dir.x, road.dir.z));
  return g;
}

function buildDog(p: Vec2, seed: number): THREE.Group {
  const g = new THREE.Group();
  const rng = mulberry32(seed);
  const colour = [0xc9a06a, 0x8b6b48, 0xe8dcc8][Math.floor(rng() * 3)];
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.7, 3, 8), new THREE.MeshLambertMaterial({ color: colour }));
  body.rotation.z = Math.PI / 2;
  body.rotation.x = 0.5;
  body.position.y = 0.22;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), body.material);
  head.position.set(0.55, 0.2, 0.15);
  g.add(head);
  place(g, p, 0.24, rng() * Math.PI * 2);
  return g;
}

function buildPadThaiStop(p: Vec2, yaw: number): THREE.Group {
  const g = new THREE.Group();
  const cart = box(2.2, 1.1, 1.1, 0xd9d3c4);
  g.add(cart);
  const wok = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x333333 }));
  wok.rotation.x = Math.PI;
  wok.position.set(0.4, 1.4, 0);
  g.add(wok);
  const umbrella = new THREE.Mesh(new THREE.ConeGeometry(1.6, 0.7, 8, 1, true), new THREE.MeshLambertMaterial({ color: 0xe63946, side: THREE.DoubleSide }));
  umbrella.position.y = 2.5;
  g.add(umbrella);
  const pole = box(0.06, 2.4, 0.06, 0x444444);
  g.add(pole);
  const sign = box(1.2, 0.5, 0.05, 0xfff2b0, 0xffe070);
  sign.position.set(0, 1.5, 0.55);
  g.add(sign);
  const road = nearestRoad(p.x, p.z);
  const px = -road.dir.z;
  const pz = road.dir.x;
  place(g, { x: p.x + px * 5.5, z: p.z + pz * 5.5 }, 0, yaw);
  return g;
}

/** A little flag on a pole at the secret location, and a beam of light you can see from the hill. */
export function buildBeacon(): THREE.Group {
  const g = new THREE.Group();
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(1.4, 3.5, 90, 10, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffd36a, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
  );
  beam.position.y = 45;
  g.add(beam);
  const pole = box(0.12, 4, 0.12, 0xffffff);
  g.add(pole);
  const flag = box(1.4, 0.9, 0.05, 0xffd36a, 0xffb84a);
  flag.position.set(0.75, 3.4, 0);
  g.add(flag);
  const light = new THREE.PointLight(0xffd36a, 0, 50, 1.6);
  light.position.y = 3;
  light.name = "beaconLight";
  g.add(light);
  return g;
}

// ---------------------------------------------------------------------------
// People, pins, the scooter
// ---------------------------------------------------------------------------

/** A soft vertical streak, so a rain point reads as a drop and not a square. */
function rainStreak(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 16;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.9)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(6, 0, 4, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

const faceCache = new Map<string, THREE.CanvasTexture>();

function faceTexture(colour: string): THREE.CanvasTexture {
  const hit = faceCache.get(colour);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#f1c8a0";
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, 128, 34);
  ctx.fillStyle = "#222";
  ctx.beginPath();
  ctx.arc(46, 60, 6, 0, Math.PI * 2);
  ctx.arc(82, 60, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#222";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(64, 74, 16, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  faceCache.set(colour, t);
  return t;
}

export interface Person {
  group: THREE.Group;
  head: THREE.Mesh;
  body: THREE.Mesh;
  setColour(colour: string): void;
}

/** A person, in code: a shirt, a head with a face, and a hat colour to tell them apart at speed. */
export function buildPerson(colour: string, helmet = false): Person {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(colour) });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.21, 0.62, 4, 10), bodyMat);
  body.position.y = 0.95;
  const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.5, 3, 8), new THREE.MeshLambertMaterial({ color: 0x3c4a66 }));
  legs.position.y = 0.42;
  const headMat = new THREE.MeshLambertMaterial({ map: faceTexture(colour) });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), headMat);
  head.position.y = 1.55;
  head.rotation.y = -Math.PI / 2;
  group.add(legs, body, head);
  if (helmet) {
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.23, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xf2f2f2 }));
    h.position.y = 1.58;
    group.add(h);
  }
  return {
    group,
    head,
    body,
    setColour(c: string) {
      bodyMat.color.set(c);
      headMat.map = faceTexture(c);
      headMat.needsUpdate = true;
    },
  };
}

/** The map pin over a waiting guest's head. */
export function buildPin(colour: string): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(colour) });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), mat);
  ball.position.y = 0.9;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.8, 10), mat);
  tip.rotation.x = Math.PI;
  tip.position.y = 0.3;
  g.add(ball, tip);
  g.userData.mat = mat;
  return g;
}

export interface Scooter {
  group: THREE.Group;
  wheels: THREE.Mesh[];
  headlight: THREE.SpotLight;
  lamp: THREE.Mesh;
  /** Where the rider sits, in the scooter's frame. */
  seat: THREE.Vector3;
  /** Where the passenger sits. */
  pillion: THREE.Vector3;
}

/** A 125cc rental. Forward is -z. */
export function buildScooter(colour = 0xd8433a): Scooter {
  const group = new THREE.Group();
  const paint = new THREE.MeshLambertMaterial({ color: colour });
  const black = new THREE.MeshLambertMaterial({ color: 0x1e1e22 });
  const chrome = new THREE.MeshLambertMaterial({ color: 0xcfd4dc });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.34, 1.05), paint);
  body.position.set(0, 0.62, 0.15);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.08, 0.7), black);
  floor.position.set(0, 0.3, -0.1);
  const shield = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.7, 0.1), paint);
  shield.position.set(0, 0.72, -0.62);
  shield.rotation.x = -0.25;
  const bars = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.04, 0.04), chrome);
  bars.position.set(0, 1.04, -0.55);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.12, 0.8), black);
  seat.position.set(0, 0.84, 0.2);
  const rack = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.03, 0.3), chrome);
  rack.position.set(0, 0.86, 0.72);
  const wheelGeo = new THREE.CylinderGeometry(0.27, 0.27, 0.11, 14);
  wheelGeo.rotateZ(Math.PI / 2);
  const front = new THREE.Mesh(wheelGeo, black);
  front.position.set(0, 0.27, -0.72);
  const rear = new THREE.Mesh(wheelGeo, black);
  rear.position.set(0, 0.27, 0.68);
  const fork = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.6, 0.06), chrome);
  fork.position.set(0, 0.5, -0.72);
  fork.rotation.x = 0.3;
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshLambertMaterial({ color: 0xfff3c0, emissive: 0xffe9a0, emissiveIntensity: 0 }));
  lamp.position.set(0, 0.9, -0.7);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 0.04), new THREE.MeshLambertMaterial({ color: 0xff3030, emissive: 0xff2020, emissiveIntensity: 0.6 }));
  tail.position.set(0, 0.7, 0.7);
  const headlight = new THREE.SpotLight(0xfff0c0, 0, 60, 0.62, 0.6, 1.4);
  headlight.position.set(0, 0.9, -0.7);
  headlight.target.position.set(0, 0, -14);
  group.add(body, floor, shield, bars, seat, rack, front, rear, fork, lamp, tail, headlight, headlight.target);
  return {
    group,
    wheels: [front, rear],
    headlight,
    lamp,
    seat: new THREE.Vector3(0, 0.55, 0.05),
    pillion: new THREE.Vector3(0, 0.6, 0.55),
  };
}

/** A troop of monkeys that crosses the road. */
export function buildMonkeys(n: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0x8a6a4a });
  for (let i = 0; i < n; i++) {
    const m = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), mat);
    body.position.y = 0.3;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), mat);
    head.position.set(0, 0.56, 0.12);
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.02, 0.6, 5), mat);
    tail.position.set(0, 0.55, -0.25);
    tail.rotation.x = 0.7;
    m.add(body, head, tail);
    m.position.x = (i - n / 2) * 0.9;
    g.add(m);
  }
  return g;
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

export interface Scenery {
  group: THREE.Group;
  sunLight: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sunDisc: THREE.Mesh;
  seaMat: THREE.MeshPhongMaterial;
  roads: RoadMeshes;
  rain: THREE.Points;
  rainWall: THREE.Mesh;
  nightLights: THREE.PointLight[];
  /** Advance the weather and the sky. `rainHere` is 0..1 at the camera. */
  update(dt: number, camera: THREE.Camera, sky: SkyFrame, rainHere: number, wallX: number): void;
  dispose(): void;
}

export function buildScenery(): Scenery {
  const group = new THREE.Group();
  const terrain = buildTerrain();
  group.add(terrain);
  const sea = buildSea();
  group.add(sea.near, sea.far);
  const roads = buildRoads();
  group.add(roads.group);
  const palms = buildPalms();
  const jungle = buildJungle();
  for (const m of [...palms.meshes, ...jungle.meshes]) group.add(m);

  const nightLights: THREE.PointLight[] = [];
  const collect = (g: THREE.Object3D) => {
    g.traverse((o) => {
      if ((o as THREE.PointLight).isPointLight) nightLights.push(o as THREE.PointLight);
    });
    group.add(g);
  };

  const villa = buildVilla();
  const villaRoad = nearestRoad(VILLA.pos.x, VILLA.pos.z);
  place(villa, VILLA.pos, 0, Math.atan2(villaRoad.dir.x, villaRoad.dir.z));
  collect(villa);

  group.add(buildTown(THONG_SALA.pos, 16, 31, [0xf1e3c8, 0xdfe7ea, 0xf7d9c4, 0xe6efd8, 0xf4f0e6]));
  group.add(buildTown(CHALOKLUM.pos, 7, 32, [0xf1e3c8, 0xdfe7ea, 0xf7d9c4]));
  group.add(buildTown(HAAD_RIN.pos, 9, 33, [0xf7d9c4, 0xe6efd8, 0xf4f0e6]));

  const outward = (p: Vec2): Vec2 => {
    const l = Math.hypot(p.x, p.z) || 1;
    return { x: p.x / l, z: p.z / l };
  };
  const pierAt = (m: Vec2, len: number) => {
    const o = outward(m);
    const coast = coastRadius(Math.atan2(m.z, m.x));
    const start = { x: o.x * (coast - 6), z: o.z * (coast - 6) };
    group.add(buildPier(start, o, len));
    return { start, o };
  };
  const tsPier = pierAt(THONG_SALA.pos, 70);
  const clPier = pierAt(CHALOKLUM.pos, 40);
  collect(buildBeachBar(HAAD_SALAD.pos));
  collect(buildGym());
  group.add(buildWaterfall());
  collect(buildCheckpoint());
  for (let i = 0; i < DOGS.length; i++) group.add(buildDog(DOGS[i], 100 + i));
  for (const stop of PAD_THAI_STOPS) {
    const road = nearestRoad(stop.pos.x, stop.pos.z);
    group.add(buildPadThaiStop(stop.pos, Math.atan2(road.dir.x, road.dir.z)));
  }
  for (const b of [279, 236, 143, 356]) {
    const p = ringPoint(b, -9);
    const road = nearestRoad(p.x, p.z);
    collect(buildSevenEleven(p, Math.atan2(road.dir.x, road.dir.z)));
  }

  // Longtails: in the bays, and a few tied up at the piers.
  const rng = mulberry32(77);
  const boatColours = [0x2b6cd8, 0xe63946, 0xf2b134, 0x2a9d8f, 0xffffff];
  for (let i = 0; i < 12; i++) {
    const b = [280, 300, 310, 140, 150, 355, 0, 240, 236, 236, 358, 60][i];
    const p = ringPoint(b);
    const o = outward(p);
    const coast = coastRadius(Math.atan2(p.z, p.x));
    const r = coast + 14 + rng() * 30;
    const boat = buildLongtail(boatColours[i % boatColours.length]);
    boat.position.set(o.x * r + (rng() - 0.5) * 20, 0.1, o.z * r + (rng() - 0.5) * 20);
    boat.rotation.y = Math.atan2(o.x, o.z) + (rng() - 0.5) * 0.8;
    group.add(boat);
  }
  void tsPier;
  void clPier;
  void yawToward;

  // Sky things.
  const sunLight = new THREE.DirectionalLight(0xfff3dc, 2);
  sunLight.position.set(-300, 400, 100);
  const hemi = new THREE.HemisphereLight(0xbfe3f5, 0x4a6a3a, 0.9);
  const ambient = new THREE.AmbientLight(0x3a4a70, 0);
  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(52, 16, 12), new THREE.MeshBasicMaterial({ color: 0xfff1c8, fog: false }));
  group.add(sunLight, hemi, ambient, sunDisc);
  const moonDir = new THREE.Vector3(0.35, 0.75, -0.55).normalize();

  // Rain: a cloud of points that lives around the camera.
  const RAIN_N = 1400;
  const rainPos = new Float32Array(RAIN_N * 3);
  for (let i = 0; i < RAIN_N; i++) {
    rainPos[i * 3] = (rng() - 0.5) * 70;
    rainPos[i * 3 + 1] = rng() * 40;
    rainPos[i * 3 + 2] = (rng() - 0.5) * 70;
  }
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPos, 3));
  const rainMat = new THREE.PointsMaterial({ color: 0xd8e6f2, size: 0.6, map: rainStreak(), transparent: true, opacity: 0, depthWrite: false, alphaTest: 0.05 });
  const rain = new THREE.Points(rainGeo, rainMat);
  rain.frustumCulled = false;
  group.add(rain);

  // The wall: a dark curtain that walks in from the east.
  const rainWall = new THREE.Mesh(
    new THREE.PlaneGeometry(2400, 320),
    new THREE.MeshBasicMaterial({ color: 0x2a3340, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, fog: false }),
  );
  rainWall.rotation.y = Math.PI / 2;
  rainWall.position.set(900, 150, 0);
  rainWall.visible = false;
  group.add(rainWall);

  const dryAsphalt = new THREE.Color(0x66625c);
  const wetAsphalt = new THREE.Color(0x2c2c30);
  const dryConcrete = new THREE.Color(0x9d9a90);
  const wetConcrete = new THREE.Color(0x5e5e62);
  const daySea = new THREE.Color(0x2ec4c6);
  const nightSea = new THREE.Color(0x0d3a52);
  const rainSea = new THREE.Color(0x3d6a78);
  let rainAnim = 0;

  return {
    group,
    sunLight,
    hemi,
    sunDisc,
    seaMat: sea.mat,
    roads,
    rain,
    rainWall,
    nightLights,
    update(dt, camera, sky, rainHere, wallX) {
      // Once the sun is under the sea, the key light is the moon: high, blue, from the east.
      const moon = sky.sunDir.y < 0.04;
      sunLight.color.copy(moon ? new THREE.Color(0x9fb0e0) : sky.sun);
      sunLight.intensity = moon ? Math.max(sky.sunIntensity, 0.55) : sky.sunIntensity;
      sunLight.position.copy(moon ? moonDir : sky.sunDir).multiplyScalar(600);
      hemi.intensity = Math.max(0.42, sky.hemiIntensity);
      // Dusk needs a little fill: a low sun lights nothing flat, and the beach should still read as a beach.
      const dusk = Math.max(0, Math.min(1, 1 - Math.abs(sky.sunDir.y - 0.05) / 0.2));
      ambient.intensity = sky.night * 0.9 + rainHere * 0.35 + dusk * 0.5;
      hemi.color.copy(sky.sky).lerp(new THREE.Color(0xffffff), 0.3);
      sunDisc.position.copy(sky.sunDir).multiplyScalar(2600).add(camera.position);
      sunDisc.visible = sky.sunDir.y > -0.03 && rainHere < 0.6;
      (sunDisc.material as THREE.MeshBasicMaterial).color.copy(sky.sun).lerp(new THREE.Color(0xffffff), 0.5);

      roads.asphalt.color.copy(dryAsphalt).lerp(wetAsphalt, rainHere);
      roads.concrete.color.copy(dryConcrete).lerp(wetConcrete, rainHere);
      sea.mat.color.copy(daySea).lerp(nightSea, sky.night).lerp(rainSea, rainHere * 0.7);
      sea.mat.opacity = 0.72 + sky.night * 0.2;

      for (const l of nightLights) l.intensity = Math.max(sky.night, rainHere * 0.6) * 160;

      rainMat.opacity = rainHere * 0.7;
      rain.visible = rainHere > 0.01;
      if (rain.visible) {
        rainAnim += dt;
        const p = rain.geometry.attributes.position as THREE.BufferAttribute;
        const fall = 26 * dt;
        for (let i = 0; i < RAIN_N; i++) {
          let y = p.getY(i) - fall;
          if (y < 0) y += 40;
          p.setY(i, y);
        }
        p.needsUpdate = true;
        rain.position.set(camera.position.x, camera.position.y - 20, camera.position.z);
      }
      rainWall.visible = wallX > -800 && wallX < 900;
      rainWall.position.x = wallX;
      rainWall.position.z = camera.position.z;
    },
    dispose() {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
        for (const m of mats) {
          (m as THREE.MeshLambertMaterial).map?.dispose();
          m.dispose();
        }
      });
      for (const t of faceCache.values()) t.dispose();
      faceCache.clear();
    },
  };
}
