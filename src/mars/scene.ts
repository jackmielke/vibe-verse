/**
 * Mars College, the place. Everything that does not move.
 *
 * A flat pale desert, the Salton Sea as a dull silver line to the west, low
 * mountains to the east, and six camps of pallet racks, plywood, shade cloth,
 * solar panels and trailers around one table. Bombay Beach is a few blocks of
 * odd art a couple of minutes' ride to the south-west. All of it is boxes,
 * cylinders and cones, merged per camp into a handful of draw calls so the
 * whole thing is cheap enough to ride through on a phone.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BOMBAY, PLACES, SEA_X, groundHeight, placeById, type Place } from "./places";

// ---------------------------------------------------------------------------
// A tiny kit: pieces accumulate per material, then merge into one mesh each.
// ---------------------------------------------------------------------------

const MATS = {
  steel: new THREE.MeshStandardMaterial({ color: 0x4b5058, roughness: 0.6, metalness: 0.5 }),
  ply: new THREE.MeshStandardMaterial({ color: 0xc9a86a, roughness: 0.95 }),
  cloth: new THREE.MeshStandardMaterial({ color: 0x2e3238, roughness: 1, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
  solar: new THREE.MeshStandardMaterial({ color: 0x1d2b4a, roughness: 0.3, metalness: 0.6 }),
  white: new THREE.MeshStandardMaterial({ color: 0xe8e6df, roughness: 0.7 }),
  blue: new THREE.MeshStandardMaterial({ color: 0x2f6fd6, roughness: 0.6 }),
  rust: new THREE.MeshStandardMaterial({ color: 0x8a4a2a, roughness: 0.9 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x6e4a2e, roughness: 0.9 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x22232a, roughness: 0.8 }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xf2c53d, roughness: 0.7 }),
  green: new THREE.MeshStandardMaterial({ color: 0x4f7a3a, roughness: 0.9 }),
  pink: new THREE.MeshStandardMaterial({ color: 0xe9a3b8, roughness: 0.8 }),
  teal: new THREE.MeshStandardMaterial({ color: 0x3fa39a, roughness: 0.8 }),
  sand: new THREE.MeshStandardMaterial({ color: 0xbfae8a, roughness: 1 }),
  warm: new THREE.MeshBasicMaterial({ color: 0xffd58a }),
} as const;
type MatKey = keyof typeof MATS;

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UNIT_CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
const UNIT_PLANE = new THREE.PlaneGeometry(1, 1);
const UNIT_CONE = new THREE.ConeGeometry(0.5, 1, 4);
const UNIT_SPHERE = new THREE.SphereGeometry(0.5, 10, 8);

class Kit {
  private parts = new Map<MatKey, THREE.BufferGeometry[]>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();

  add(
    mat: MatKey,
    base: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    ry = 0,
    rx = 0,
    rz = 0,
  ): void {
    const g = base.clone();
    this.e.set(rx, ry, rz);
    this.q.setFromEuler(this.e);
    this.p.set(x, y, z);
    this.s.set(sx, sy, sz);
    this.m.compose(this.p, this.q, this.s);
    g.applyMatrix4(this.m);
    let list = this.parts.get(mat);
    if (!list) this.parts.set(mat, (list = []));
    list.push(g);
  }

  box(mat: MatKey, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0, rx = 0, rz = 0): void {
    this.add(mat, UNIT_BOX, x, y, z, sx, sy, sz, ry, rx, rz);
  }

  build(into: THREE.Group): void {
    for (const [key, list] of this.parts) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, MATS[key]);
      into.add(mesh);
    }
    this.parts.clear();
  }
}

// A small deterministic RNG so the camps are the same camps every visit.
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 100000) / 100000;
  };
}

// ---------------------------------------------------------------------------
// Signs
// ---------------------------------------------------------------------------

function signTexture(name: string, tag: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#c9a86a";
  ctx.fillRect(0, 0, 512, 256);
  ctx.strokeStyle = "#7a5a30";
  ctx.lineWidth = 10;
  ctx.strokeRect(12, 12, 488, 232);
  ctx.fillStyle = "#2b1d0e";
  ctx.font = "bold 54px Georgia, serif";
  ctx.textAlign = "center";
  ctx.fillText(name.toUpperCase(), 256, 118);
  ctx.font = "italic 30px Georgia, serif";
  ctx.fillStyle = "#4a3418";
  ctx.fillText(tag, 256, 178);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeSign(place: Place, ry: number, into: THREE.Group, disposables: THREE.Texture[]): void {
  const tex = signTexture(place.name, place.tag);
  disposables.push(tex);
  const g = new THREE.Group();
  const board = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.6), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, side: THREE.DoubleSide }));
  board.position.y = 2.2;
  g.add(board);
  const post = new THREE.Mesh(UNIT_BOX, MATS.wood);
  post.scale.set(0.12, 2.4, 0.12);
  post.position.set(-1.3, 1.2, -0.05);
  const post2 = post.clone();
  post2.position.x = 1.3;
  g.add(post, post2);
  const y = groundHeight(place.x, place.z);
  // Off to one side of the place, facing the middle.
  const off = 0.75 * place.radius;
  g.position.set(place.x + Math.sin(ry) * off, y, place.z + Math.cos(ry) * off);
  g.rotation.y = ry + Math.PI;
  into.add(g);
}

// ---------------------------------------------------------------------------
// Camps
// ---------------------------------------------------------------------------

function palletRack(kit: Kit, x: number, z: number, ry: number, levels: number, r: () => number): void {
  const w = 2.4;
  const d = 1.0;
  const h = 1.1 * levels + 0.3;
  const cos = Math.cos(ry);
  const sin = Math.sin(ry);
  const at = (lx: number, lz: number): [number, number] => [x + lx * cos + lz * sin, z - lx * sin + lz * cos];
  for (const [lx, lz] of [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [-w / 2, d / 2],
    [w / 2, d / 2],
  ]) {
    const [px, pz] = at(lx, lz);
    kit.box("steel", px, groundHeight(px, pz) + h / 2, pz, 0.08, h, 0.08, ry);
  }
  for (let l = 0; l < levels; l++) {
    const y = groundHeight(x, z) + 0.35 + l * 1.1;
    for (const lz of [-d / 2, d / 2]) {
      const [px, pz] = at(0, lz);
      kit.box("rust", px, y, pz, w, 0.1, 0.07, ry);
    }
    if (r() < 0.7) kit.box("ply", x, y + 0.06, z, w - 0.1, 0.04, d, ry);
    // Something on the shelf: a crate, a box, a jerry can.
    if (r() < 0.6) {
      const [px, pz] = at((r() - 0.5) * 1.6, 0);
      kit.box(r() < 0.5 ? "blue" : "white", px, y + 0.3, pz, 0.5, 0.45, 0.5, ry + r());
    }
  }
}

function shadeCloth(kit: Kit, x: number, z: number, w: number, d: number, h: number, ry: number): void {
  const y = groundHeight(x, z);
  kit.add("cloth", UNIT_PLANE, x, y + h, z, w, d, 1, ry, -Math.PI / 2 + 0.06, 0);
  const cos = Math.cos(ry);
  const sin = Math.sin(ry);
  for (const [lx, lz] of [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [-w / 2, d / 2],
    [w / 2, d / 2],
  ]) {
    const px = x + lx * cos + lz * sin;
    const pz = z - lx * sin + lz * cos;
    kit.box("steel", px, groundHeight(px, pz) + h / 2, pz, 0.06, h, 0.06);
  }
}

function solarRow(kit: Kit, x: number, z: number, n: number, ry: number): void {
  for (let i = 0; i < n; i++) {
    const px = x + Math.cos(ry) * i * 1.9;
    const pz = z - Math.sin(ry) * i * 1.9;
    const y = groundHeight(px, pz);
    kit.add("solar", UNIT_PLANE, px, y + 1.1, pz, 1.7, 1.1, 1, ry, -0.55, 0);
    kit.box("steel", px, y + 0.5, pz + 0.3, 0.05, 1.0, 0.05, ry);
    kit.box("steel", px, y + 0.35, pz - 0.3, 0.05, 0.7, 0.05, ry);
  }
}

function trailer(kit: Kit, x: number, z: number, ry: number, len = 6): void {
  const y = groundHeight(x, z);
  kit.box("white", x, y + 1.55, z, len, 2.3, 2.4, ry);
  kit.box("dark", x, y + 2.75, z, len - 0.4, 0.15, 2.2, ry);
  const cos = Math.cos(ry);
  const sin = Math.sin(ry);
  for (const side of [-1.15, 1.15]) {
    const px = x + side * sin;
    const pz = z + side * cos;
    kit.add("dark", UNIT_CYL, px, y + 0.4, pz, 0.8, 0.25, 0.8, ry, 0, Math.PI / 2);
  }
  // Tongue and a step.
  kit.box("steel", x + cos * (len / 2 + 0.6), y + 0.5, z - sin * (len / 2 + 0.6), 1.2, 0.08, 0.08, ry);
  kit.box("ply", x - sin * 1.5, y + 0.2, z - cos * 1.5, 0.8, 0.4, 0.5, ry);
}

function plyBox(kit: Kit, x: number, z: number, ry: number, w: number, h: number, d: number): void {
  kit.box("ply", x, groundHeight(x, z) + h / 2, z, w, h, d, ry);
}

function buildCamp(place: Place, seed: number, kit: Kit, into: THREE.Group): void {
  const r = rng(seed);
  const { x, z } = place;
  const R = place.radius;
  // Racks in a rough horseshoe, opening toward the table.
  const open = Math.atan2(-x, -z);
  const n = 5 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const a = open + Math.PI + (i / (n - 1) - 0.5) * Math.PI * 1.3;
    const rad = R * (0.55 + r() * 0.3);
    palletRack(kit, x + Math.sin(a) * rad, z + Math.cos(a) * rad, -a + (r() - 0.5) * 0.3, 2 + Math.floor(r() * 2), r);
  }
  for (let i = 0; i < 4 + Math.floor(r() * 3); i++) {
    const a = r() * Math.PI * 2;
    const rad = R * (0.15 + r() * 0.5);
    const big = r() < 0.5;
    plyBox(kit, x + Math.sin(a) * rad, z + Math.cos(a) * rad, r() * Math.PI, big ? 2.4 : 1.2, big ? 1.2 : 2.4, big ? 1.2 : 1.2);
  }
  for (let i = 0; i < 2 + Math.floor(r() * 2); i++) {
    const a = r() * Math.PI * 2;
    const rad = R * (0.2 + r() * 0.45);
    shadeCloth(kit, x + Math.sin(a) * rad, z + Math.cos(a) * rad, 5 + r() * 3, 5 + r() * 3, 2.8 + r() * 0.6, r() * Math.PI);
  }
  const sa = open + Math.PI / 2 + (r() - 0.5);
  solarRow(kit, x + Math.sin(sa) * R * 0.95, z + Math.cos(sa) * R * 0.95, 3 + Math.floor(r() * 3), sa + Math.PI / 2);
  const ta = open + Math.PI + (r() - 0.5) * 0.8;
  trailer(kit, x + Math.sin(ta) * R * 1.15, z + Math.cos(ta) * R * 1.15, ta + Math.PI / 2, 5 + r() * 3);
  if (r() < 0.5) trailer(kit, x + Math.sin(ta + 1.1) * R * 1.2, z + Math.cos(ta + 1.1) * R * 1.2, ta + 1.1 + Math.PI / 2, 4.5);

  // Each camp gets its own thing.
  const gy = groundHeight(x, z);
  switch (place.id) {
    case "research": {
      // The totem's pole; the wireframe dodecahedron itself is animated and lives in the world.
      kit.add("steel", UNIT_CYL, x, gy + 2, z, 0.18, 4, 0.18);
      kit.box("ply", x + 3, gy + 0.75, z + 1, 2.2, 0.06, 0.9, 0.3);
      kit.box("dark", x + 3, gy + 0.85, z + 1, 0.5, 0.03, 0.35, 0.3);
      kit.box("dark", x + 2.5, gy + 0.85, z + 1.3, 0.5, 0.03, 0.35, 0.3);
      break;
    }
    case "freeside": {
      // A hammock between two poles, and a couch that has seen things.
      kit.add("steel", UNIT_CYL, x - 2, gy + 1, z + 2, 0.08, 2, 0.08);
      kit.add("steel", UNIT_CYL, x + 2, gy + 1, z + 2, 0.08, 2, 0.08);
      kit.add("pink", UNIT_PLANE, x, gy + 1.0, z + 2, 3.6, 0.9, 1, 0, -Math.PI / 2 - 0.2, 0);
      kit.box("teal", x + 1, gy + 0.35, z - 2, 2.4, 0.7, 1, 0.4);
      kit.box("teal", x + 1 - Math.sin(0.4) * 0.5, gy + 0.85, z - 2 - Math.cos(0.4) * 0.5, 2.4, 0.5, 0.25, 0.4);
      break;
    }
    case "bodywork": {
      kit.box("white", x, gy + 0.7, z, 1.9, 0.12, 0.7, 0.5);
      for (const [lx, lz] of [[-0.8, -0.25], [0.8, -0.25], [-0.8, 0.25], [0.8, 0.25]]) kit.box("steel", x + lx, gy + 0.32, z + lz, 0.05, 0.64, 0.05, 0.5);
      for (let i = 0; i < 6; i++) kit.add("pink", UNIT_SPHERE, x + Math.sin(i) * 2.2, gy + 0.25, z + Math.cos(i * 1.7) * 2.2, 0.7, 0.4, 0.7);
      break;
    }
    case "tools": {
      // Stacks of plywood, a workbench, and a second row of racks.
      for (let i = 0; i < 3; i++) kit.box("ply", x + 3 + i * 1.6, gy + 0.3 + i * 0.05, z + 3, 1.2, 0.6 + i * 0.1, 2.4, 0.1 * i);
      kit.box("wood", x - 3, gy + 0.9, z + 3, 2.4, 0.1, 1, 0.2);
      for (const lx of [-1.1, 1.1]) kit.box("wood", x - 3 + lx, gy + 0.42, z + 3, 0.1, 0.85, 0.9, 0.2);
      kit.box("yellow", x - 3, gy + 1.05, z + 3, 0.3, 0.2, 0.25, 0.9);
      for (let i = 0; i < 3; i++) palletRack(kit, x + (i - 1) * 3, z - 5, 0, 3, r);
      break;
    }
    case "nature": {
      kit.add("steel", UNIT_CYL, x, gy + 0.6, z, 0.05, 1.2, 0.05);
      kit.add("white", UNIT_CYL, x, gy + 1.35, z, 0.16, 1.0, 0.16, 0, 0.9, 0);
      for (let i = 0; i < 4; i++) kit.box("white", x + 2 + i * 0.5, gy + 0.9, z - 2, 0.25, 0.35, 0.25);
      kit.box("ply", x + 2.75, gy + 0.7, z - 2, 2.6, 0.06, 0.8);
      for (let i = 0; i < 5; i++) kit.add("green", UNIT_SPHERE, x - 3 + i * 0.8, gy + 0.3, z + 3, 0.6, 0.6, 0.6);
      break;
    }
    case "sunflower": {
      for (let i = 0; i < 7; i++) {
        const sx = x + Math.sin(i * 1.3) * 4;
        const sz = z + Math.cos(i * 2.1) * 4;
        const h = 2.4 + (i % 3) * 0.4;
        const y = groundHeight(sx, sz);
        kit.add("green", UNIT_CYL, sx, y + h / 2, sz, 0.06, h, 0.06);
        kit.add("yellow", UNIT_CYL, sx, y + h, sz + 0.05, 0.9, 0.06, 0.9, 0, Math.PI / 2, 0);
        kit.add("wood", UNIT_CYL, sx, y + h, sz + 0.1, 0.35, 0.08, 0.35, 0, Math.PI / 2, 0);
      }
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// The table in the middle
// ---------------------------------------------------------------------------

function buildTable(kit: Kit, into: THREE.Group): { light: THREE.PointLight; bulbs: THREE.Mesh } {
  const t = placeById("table");
  const y = groundHeight(t.x, t.z);
  kit.box("wood", t.x, y + 0.78, t.z, 9, 0.08, 1.2);
  for (const lx of [-4, 0, 4]) for (const lz of [-0.45, 0.45]) kit.box("wood", t.x + lx, y + 0.37, t.z + lz, 0.1, 0.74, 0.1);
  for (const lz of [-1.1, 1.1]) {
    kit.box("ply", t.x, y + 0.45, t.z + lz, 9, 0.06, 0.35);
    for (const lx of [-4, 0, 4]) kit.box("wood", t.x + lx, y + 0.22, t.z + lz, 0.08, 0.44, 0.3);
  }
  // Plates, a pot, hot sauce.
  for (let i = 0; i < 10; i++) kit.add("white", UNIT_CYL, t.x - 4 + i * 0.9, y + 0.83, t.z + (i % 2 ? 0.3 : -0.3), 0.3, 0.02, 0.3);
  kit.add("dark", UNIT_CYL, t.x, y + 0.95, t.z, 0.5, 0.3, 0.5);
  kit.box("rust", t.x + 1.2, y + 0.9, t.z, 0.08, 0.2, 0.08);
  // String lights on two poles.
  for (const lx of [-5.5, 5.5]) kit.add("steel", UNIT_CYL, t.x + lx, y + 1.6, t.z, 0.06, 3.2, 0.06);
  kit.box("dark", t.x, y + 3.05, t.z, 11, 0.02, 0.02);
  const bulbGeo: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 14; i++) {
    const g = UNIT_SPHERE.clone();
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(t.x - 5 + i * 0.77, y + 2.95 - Math.sin((i / 13) * Math.PI) * 0.35, t.z),
      new THREE.Quaternion(),
      new THREE.Vector3(0.1, 0.1, 0.1),
    );
    g.applyMatrix4(m);
    bulbGeo.push(g);
  }
  const bulbs = new THREE.Mesh(mergeGeometries(bulbGeo, false)!, new THREE.MeshBasicMaterial({ color: 0xffd58a }));
  for (const g of bulbGeo) g.dispose();
  into.add(bulbs);
  const light = new THREE.PointLight(0xffc98a, 0, 26, 1.8);
  light.position.set(t.x, y + 2.6, t.z);
  into.add(light);
  return { light, bulbs };
}

// ---------------------------------------------------------------------------
// Home: a trailer, the shelter you build, the pull-up bar
// ---------------------------------------------------------------------------

function buildHome(kit: Kit, into: THREE.Group): { stages: THREE.Group[]; pullup: THREE.Group } {
  const h = placeById("home");
  const y = groundHeight(h.x, h.z);
  trailer(kit, h.x + 5, h.z + 2, 0.15, 5);
  kit.box("ply", h.x - 2, y + 0.25, h.z + 4, 0.5, 0.5, 0.5, 0.4);
  kit.box("blue", h.x - 1.2, y + 0.25, h.z + 4.3, 0.35, 0.5, 0.25, 0.1);
  // A pile of parts waiting to become walls.
  kit.box("ply", h.x - 4, y + 0.12, h.z - 1, 1.2, 0.24, 2.4, 0.3);
  kit.box("steel", h.x - 4.5, y + 0.06, h.z - 3, 0.08, 0.08, 3.2, 0.6);

  // The shelter, five stages, toggled by the meter.
  const stages: THREE.Group[] = [];
  const sx = h.x - 2;
  const sz = h.z - 2.5;
  const stage = (fn: (k: Kit) => void) => {
    const g = new THREE.Group();
    const k = new Kit();
    fn(k);
    k.build(g);
    g.visible = false;
    into.add(g);
    stages.push(g);
  };
  // 1: four uprights.
  stage((k) => {
    for (const [lx, lz] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) k.box("steel", sx + lx, y + 1.4, sz + lz, 0.09, 2.8, 0.09);
  });
  // 2: beams and a floor.
  stage((k) => {
    for (const lz of [-1.5, 1.5]) k.box("rust", sx, y + 2.7, sz + lz, 3.1, 0.1, 0.08);
    for (const lx of [-1.5, 1.5]) k.box("rust", sx + lx, y + 2.7, sz, 0.08, 0.1, 3.1);
    k.box("ply", sx, y + 0.12, sz, 3.1, 0.06, 3.1);
  });
  // 3: two walls.
  stage((k) => {
    k.box("ply", sx, y + 1.4, sz - 1.5, 3.0, 2.6, 0.04);
    k.box("ply", sx - 1.5, y + 1.4, sz, 0.04, 2.6, 3.0);
  });
  // 4: the other two, one with a door.
  stage((k) => {
    k.box("ply", sx + 1.5, y + 1.4, sz, 0.04, 2.6, 3.0);
    k.box("ply", sx + 0.8, y + 1.4, sz + 1.5, 1.4, 2.6, 0.04);
    k.box("ply", sx - 1.0, y + 2.2, sz + 1.5, 1.0, 1.0, 0.04);
  });
  // 5: roof and shade cloth.
  stage((k) => {
    k.box("ply", sx, y + 2.8, sz, 3.3, 0.05, 3.3);
    k.add("cloth", UNIT_PLANE, sx, y + 3.4, sz, 5, 5, 1, 0.2, -Math.PI / 2 + 0.08, 0);
    for (const [lx, lz] of [[-2.4, -2.4], [2.4, -2.4], [-2.4, 2.4], [2.4, 2.4]]) k.box("steel", sx + lx, y + 1.7, sz + lz, 0.05, 3.4, 0.05);
  });

  const pullup = new THREE.Group();
  const pk = new Kit();
  const px = h.x + 1;
  const pz = h.z - 5;
  pk.box("steel", px - 0.7, y + 1.15, pz, 0.08, 2.3, 0.08);
  pk.box("steel", px + 0.7, y + 1.15, pz, 0.08, 2.3, 0.08);
  pk.box("steel", px, y + 2.25, pz, 1.5, 0.06, 0.06);
  pk.box("ply", px, y + 0.05, pz, 2.0, 0.1, 0.6);
  pk.build(pullup);
  pullup.visible = false;
  into.add(pullup);
  return { stages, pullup };
}

// ---------------------------------------------------------------------------
// Poop Mountain
// ---------------------------------------------------------------------------

function buildPoop(kit: Kit): void {
  const p = placeById("poop");
  const y = groundHeight(p.x, p.z);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const px = p.x + Math.sin(a) * 2.2;
    const pz = p.z + Math.cos(a) * 2.2;
    const py = groundHeight(px, pz);
    kit.box("blue", px, py + 1.15, pz, 1.1, 2.3, 1.1, -a);
    kit.box("white", px, py + 2.35, pz, 1.2, 0.12, 1.2, -a);
  }
  kit.add("steel", UNIT_CYL, p.x, y + 3.2, p.z, 0.06, 6.4, 0.06);
  kit.add("pink", UNIT_PLANE, p.x + 0.7, y + 6, p.z, 1.4, 0.6, 1, Math.PI / 2, 0, 0);
  kit.add("yellow", UNIT_PLANE, p.x + 0.6, y + 5.3, p.z, 1.2, 0.5, 1, Math.PI / 2, 0, 0);
  kit.add("teal", UNIT_PLANE, p.x + 0.5, y + 4.7, p.z, 1.0, 0.45, 1, Math.PI / 2, 0, 0);
}

// ---------------------------------------------------------------------------
// Bombay Beach
// ---------------------------------------------------------------------------

function buildBombay(kit: Kit): void {
  const r = rng(99);
  const paints: MatKey[] = ["white", "pink", "teal", "sand", "yellow", "white", "rust"];
  // Blocks of small houses on a grid, most of them leaning slightly.
  for (let ix = 0; ix < 6; ix++) {
    for (let iz = 0; iz < 5; iz++) {
      if (r() < 0.18) continue;
      const x = BOMBAY.x - 42 + ix * 16 + (r() - 0.5) * 3;
      const z = BOMBAY.z - 36 + iz * 17 + (r() - 0.5) * 3;
      const w = 5 + r() * 4;
      const d = 5 + r() * 4;
      const h = 2.6 + r() * 1.2;
      const y = groundHeight(x, z);
      kit.box(paints[Math.floor(r() * paints.length)], x, y + h / 2, z, w, h, d, (r() - 0.5) * 0.15, 0, (r() - 0.5) * 0.06);
      kit.box("dark", x, y + h + 0.1, z, w + 0.4, 0.2, d + 0.4, (r() - 0.5) * 0.15);
      if (r() < 0.4) kit.box("rust", x + w / 2 + 1.5, y + 0.6, z, 3.6, 1.2, 1.7, r());
    }
  }
  // The art. A pyramid, a giant frame, a drive-in with no screen, TVs on poles, a ship.
  const ax = BOMBAY.x + 60;
  const az = BOMBAY.z - 10;
  kit.add("sand", UNIT_CONE, ax, groundHeight(ax, az) + 5, az, 14, 10, 14, Math.PI / 4);
  const fx = BOMBAY.x - 60;
  const fz = BOMBAY.z + 55;
  const fy = groundHeight(fx, fz);
  kit.box("yellow", fx, fy + 6.5, fz, 9, 0.5, 0.5);
  kit.box("yellow", fx, fy + 1.0, fz, 9, 0.5, 0.5);
  kit.box("yellow", fx - 4.25, fy + 3.75, fz, 0.5, 6, 0.5);
  kit.box("yellow", fx + 4.25, fy + 3.75, fz, 0.5, 6, 0.5);
  const dx = BOMBAY.x + 10;
  const dz = BOMBAY.z + 70;
  for (let i = 0; i < 6; i++) {
    const cx = dx - 15 + i * 6;
    const cy = groundHeight(cx, dz);
    kit.box(i % 2 ? "rust" : "teal", cx, cy + 0.7, dz, 4.2, 1.2, 2.0, (r() - 0.5) * 0.2);
    kit.box(i % 2 ? "rust" : "teal", cx - 0.3, cy + 1.5, dz, 2.2, 0.6, 1.8, (r() - 0.5) * 0.2);
  }
  const sy = groundHeight(dx, dz - 14);
  kit.box("white", dx, sy + 5, dz - 14, 16, 8, 0.3);
  kit.box("steel", dx - 6, sy + 2.5, dz - 13.7, 0.2, 5, 0.2);
  kit.box("steel", dx + 6, sy + 2.5, dz - 13.7, 0.2, 5, 0.2);
  for (let i = 0; i < 7; i++) {
    const tx = BOMBAY.x - 20 + i * 5;
    const tz = BOMBAY.z - 70;
    const ty = groundHeight(tx, tz);
    const h = 3 + (i % 3);
    kit.add("steel", UNIT_CYL, tx, ty + h / 2, tz, 0.12, h, 0.12);
    kit.box("dark", tx, ty + h + 0.35, tz, 0.9, 0.7, 0.6, i * 0.4);
  }
  const shx = BOMBAY.x - 110;
  const shz = BOMBAY.z + 10;
  const shy = groundHeight(shx, shz);
  kit.box("rust", shx, shy + 1.5, shz, 18, 3, 5, 0.3, 0, 0.12);
  kit.add("steel", UNIT_CYL, shx, shy + 7, shz, 0.15, 10, 0.15);
  kit.add("white", UNIT_PLANE, shx + 2, shy + 8.5, shz, 4, 5, 1, 0.3, 0, 0);

  // Sunflower Lab's yellow trailer and the water station.
  const s = placeById("sunflower");
  trailer(kit, s.x + 6, s.z - 4, 0.2, 6);
  // A yellow band round the trailer, so it reads as theirs from the road.
  kit.box("yellow", s.x + 6, groundHeight(s.x + 6, s.z - 4) + 1.55, s.z - 4, 6.05, 1.6, 2.45, 0.2);
  const w = placeById("water");
  const wy = groundHeight(w.x, w.z);
  kit.add("white", UNIT_CYL, w.x, wy + 3.4, w.z, 5, 4.4, 5);
  for (const [lx, lz] of [[-1.8, -1.8], [1.8, -1.8], [-1.8, 1.8], [1.8, 1.8]]) kit.box("steel", w.x + lx, wy + 0.6, w.z + lz, 0.12, 1.2, 0.12);
  kit.box("blue", w.x + 2.8, wy + 0.5, w.z, 0.3, 1.0, 0.3);
  kit.box("steel", w.x + 2.8, wy + 1.05, w.z, 0.8, 0.08, 0.08);
  for (let i = 0; i < 5; i++) kit.box("blue", w.x - 3 + i * 0.6, wy + 0.25, w.z + 3, 0.35, 0.5, 0.25);
}

// ---------------------------------------------------------------------------
// The land
// ---------------------------------------------------------------------------

function buildGround(): THREE.Mesh {
  const size = 4400;
  const seg = 150;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colours = new Float32Array(pos.count * 3);
  const sand = new THREE.Color(0xd9c7a3);
  const shore = new THREE.Color(0xbdb39a);
  const mound = new THREE.Color(0xc4ad86);
  const hill = new THREE.Color(0xb59b80);
  const c = new THREE.Color();
  const poop = placeById("poop");
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = groundHeight(x, z);
    pos.setY(i, y);
    c.copy(sand);
    const tone = 0.95 + Math.sin(x * 0.031) * Math.cos(z * 0.027) * 0.035 + Math.sin(x * 0.11 + z * 0.07) * 0.02;
    c.multiplyScalar(tone);
    if (x < SEA_X + 120) c.lerp(shore, Math.min(1, (SEA_X + 120 - x) / 100));
    if (x > 300) c.lerp(hill, Math.min(1, (x - 300) / 700));
    const d = Math.hypot(x - poop.x, z - poop.z);
    if (d < 18) c.lerp(mound, 1 - d / 18);
    colours[i * 3] = c.r;
    colours[i * 3 + 1] = c.g;
    colours[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(-200, 0, 0);
  // The plane is centred at -200 so the sea side gets more of it. Heights
  // were sampled in world space above, so shift the geometry back.
  geo.translate(200, 0, 0);
  mesh.position.set(0, 0, 0);
  return mesh;
}

function buildSea(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(3600, 4400);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc8cbc9, roughness: 0.25, metalness: 0.75 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(SEA_X - 1800 + 40, -1.3, 0);
  return mesh;
}

function buildMountains(): THREE.Mesh {
  const r = rng(5);
  const parts: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  const add = (x: number, z: number, rad: number, h: number) => {
    const g = new THREE.ConeGeometry(rad, h, 7, 1);
    m.compose(new THREE.Vector3(x, h / 2 - 30, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, r() * Math.PI, 0)), new THREE.Vector3(1, 1, 1 + r() * 0.6));
    g.applyMatrix4(m);
    parts.push(g);
  };
  for (let i = 0; i < 22; i++) add(1000 + r() * 500, -1700 + i * 160 + r() * 80, 180 + r() * 220, 120 + r() * 260);
  for (let i = 0; i < 8; i++) add(-800 + i * 260, -1700 - r() * 200, 240 + r() * 200, 90 + r() * 120);
  for (let i = 0; i < 8; i++) add(-800 + i * 260, 1700 + r() * 200, 240 + r() * 200, 90 + r() * 120);
  const merged = mergeGeometries(parts, false)!;
  for (const g of parts) g.dispose();
  return new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color: 0x8f7d78 }));
}

function scatter(count: number, seed: number, geo: THREE.BufferGeometry, mat: THREE.Material, size: [number, number], squash: number): THREE.InstancedMesh {
  const r = rng(seed);
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  let placed = 0;
  let guard = 0;
  while (placed < count && guard++ < count * 6) {
    const x = -900 + r() * 1700;
    const z = -1000 + r() * 2000;
    if (x < SEA_X + 30) continue;
    let near = false;
    for (const pl of PLACES) if (Math.hypot(pl.x - x, pl.z - z) < pl.radius + 8) near = true;
    if (Math.abs(x - BOMBAY.x) < 130 && Math.abs(z - BOMBAY.z) < 110) near = true;
    if (near) continue;
    const sc = size[0] + r() * (size[1] - size[0]);
    p.set(x, groundHeight(x, z), z);
    q.setFromEuler(new THREE.Euler(0, r() * Math.PI * 2, 0));
    s.set(sc, sc * squash, sc * (0.8 + r() * 0.4));
    m.compose(p, q, s);
    mesh.setMatrixAt(placed++, m);
  }
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Sky, stars, dust
// ---------------------------------------------------------------------------

const SKY_VERT = `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const SKY_FRAG = `
uniform vec3 top;
uniform vec3 horizon;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float haze;
varying vec3 vWorld;
void main() {
  vec3 d = normalize(vWorld - cameraPosition);
  float t = smoothstep(-0.02, 0.5, d.y);
  vec3 col = mix(horizon, top, t);
  float s = max(0.0, dot(d, sunDir));
  col += sunColor * (pow(s, 90.0) * 1.2 + pow(s, 6.0) * 0.18);
  col = mix(col, horizon, haze * (1.0 - smoothstep(0.0, 0.35, d.y)));
  gl_FragColor = vec4(col, 1.0);
}`;

export interface SkyUniforms {
  top: { value: THREE.Color };
  horizon: { value: THREE.Color };
  sunDir: { value: THREE.Vector3 };
  sunColor: { value: THREE.Color };
  haze: { value: number };
}

export interface MarsScene {
  group: THREE.Group;
  sky: THREE.Mesh;
  skyUniforms: SkyUniforms;
  stars: THREE.Points;
  dustWall: THREE.Mesh;
  dust: THREE.Points;
  dustPositions: Float32Array;
  /** Everything that comes down at the end, in the order it comes down. */
  structures: THREE.Object3D[];
  shelterStages: THREE.Group[];
  pullupBar: THREE.Group;
  dodeca: THREE.Mesh;
  tableLight: THREE.PointLight;
  bulbs: THREE.Mesh;
  dispose(): void;
}

export function buildScene(): MarsScene {
  const group = new THREE.Group();
  const disposables: THREE.Texture[] = [];
  const structures: THREE.Object3D[] = [];

  group.add(buildGround(), buildSea(), buildMountains());
  const bushGeo = new THREE.IcosahedronGeometry(1, 1);
  const bushMat = new THREE.MeshLambertMaterial({ color: 0x5b6a3a });
  const rockGeo = new THREE.DodecahedronGeometry(0.5, 0);
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x9a8a78 });
  group.add(scatter(700, 11, bushGeo, bushMat, [0.9, 2.2], 0.6));
  group.add(scatter(320, 23, rockGeo, rockMat, [0.5, 1.6], 0.7));

  // Camps, each its own group so it can come down on its own.
  const camps: Place[] = ["research", "freeside", "bodywork", "tools", "nature", "sunflower"].map((id) => placeById(id as Place["id"]));
  camps.forEach((place, i) => {
    const g = new THREE.Group();
    const kit = new Kit();
    buildCamp(place, 100 + i * 17, kit, g);
    kit.build(g);
    group.add(g);
    structures.push(g);
  });

  const tableGroup = new THREE.Group();
  const tableKit = new Kit();
  const { light, bulbs } = buildTable(tableKit, tableGroup);
  tableKit.build(tableGroup);
  group.add(tableGroup);
  structures.push(tableGroup);

  const homeGroup = new THREE.Group();
  const homeKit = new Kit();
  const { stages, pullup } = buildHome(homeKit, homeGroup);
  homeKit.build(homeGroup);
  group.add(homeGroup);
  structures.push(homeGroup);

  const poopGroup = new THREE.Group();
  const poopKit = new Kit();
  buildPoop(poopKit);
  poopKit.build(poopGroup);
  group.add(poopGroup);
  structures.push(poopGroup);

  const bombayGroup = new THREE.Group();
  const bombayKit = new Kit();
  buildBombay(bombayKit);
  bombayKit.build(bombayGroup);
  group.add(bombayGroup);

  // The dodecahedron, the unofficial symbol, on its pole at Mars Research.
  const research = placeById("research");
  const dodeca = new THREE.Mesh(
    new THREE.DodecahedronGeometry(2.0, 0),
    new THREE.MeshBasicMaterial({ color: 0xff9a5c, wireframe: true }),
  );
  dodeca.position.set(research.x, groundHeight(research.x, research.z) + 6.2, research.z);
  group.add(dodeca);
  structures.push(dodeca);

  // Signs at every place, facing the middle of the map.
  const signs = new THREE.Group();
  for (const p of PLACES) {
    const toward = Math.atan2(-p.x, -p.z);
    makeSign(p, toward, signs, disposables);
  }
  group.add(signs);
  structures.push(signs);

  // A trailhead cairn.
  const th = placeById("trailhead");
  const cairn = new THREE.Group();
  const ck = new Kit();
  for (let i = 0; i < 6; i++) ck.add("sand", UNIT_SPHERE, th.x, groundHeight(th.x, th.z) + 0.3 + i * 0.32, th.z, 1.2 - i * 0.15, 0.5, 1.2 - i * 0.15);
  ck.build(cairn);
  group.add(cairn);

  // Sky dome, following the camera.
  const skyUniforms: SkyUniforms = {
    top: { value: new THREE.Color(0xcfe0ea) },
    horizon: { value: new THREE.Color(0xefe9dc) },
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
    sunColor: { value: new THREE.Color(0xfff2d0) },
    haze: { value: 0 },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(2600, 24, 12),
    new THREE.ShaderMaterial({ uniforms: skyUniforms as unknown as Record<string, THREE.IUniform>, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false }),
  );
  sky.renderOrder = -10;
  group.add(sky);

  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(900 * 3);
  const sr = rng(77);
  for (let i = 0; i < 900; i++) {
    const a = sr() * Math.PI * 2;
    const e = Math.asin(sr() * 0.98 + 0.02);
    starPos[i * 3] = Math.cos(a) * Math.cos(e) * 2400;
    starPos[i * 3 + 1] = Math.sin(e) * 2400;
    starPos[i * 3 + 2] = Math.sin(a) * Math.cos(e) * 2400;
  }
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  stars.renderOrder = -9;
  group.add(stars);

  // The brown wall on the horizon, and the dust in your teeth.
  const dustWall = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1, 40, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xa97c4e, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, fog: false }),
  );
  dustWall.renderOrder = -8;
  group.add(dustWall);

  const DUST = 1400;
  const dustPositions = new Float32Array(DUST * 3);
  const dr = rng(31);
  for (let i = 0; i < DUST; i++) {
    dustPositions[i * 3] = (dr() - 0.5) * 90;
    dustPositions[i * 3 + 1] = dr() * 24;
    dustPositions[i * 3 + 2] = (dr() - 0.5) * 90;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0xc09a68, size: 0.2, transparent: true, opacity: 0, depthWrite: false }));
  group.add(dust);

  return {
    group,
    sky,
    skyUniforms,
    stars,
    dustWall,
    dust,
    dustPositions,
    structures,
    shelterStages: stages,
    pullupBar: pullup,
    dodeca,
    tableLight: light,
    bulbs,
    dispose() {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
        for (const m of mats) {
          const tex = (m as THREE.MeshStandardMaterial).map;
          if (tex) tex.dispose();
          // The shared kit materials are module-level and reused across visits.
          if (!Object.values(MATS).includes(m as never)) m.dispose();
        }
      });
      for (const t of disposables) t.dispose();
      bushGeo.dispose();
      rockGeo.dispose();
      bushMat.dispose();
      rockMat.dispose();
    },
  };
}
