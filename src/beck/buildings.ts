/**
 * Five hundred and seven buildings, each on its real footprint, each with a
 * roof that follows it. A footprint is split into the rectangles that carry
 * its roofs (footprint.ts): an L is two bars that cross, so it gets two gables
 * that meet in a valley and a gable end on each face, the way a cross-gabled
 * house does. Heights come from the data where they were measured; the era
 * of a house, which nothing in the data records, is drawn from a seeded hat
 * and decides everything the data does not say: a pre-war cottage gets tall
 * double-hung windows, a covered porch and a brick chimney; a seventies ranch
 * gets wide windows and a garage door on the driveway side; a newer one gets
 * board-and-batten, black window frames and a standing-seam roof. Walls have
 * windows with frames, sills and mullions; roofs have fascia, soffit, gutters
 * and downspouts; the lot's slope puts a deck on the downhill side, and the
 * stem wall meets the ground wherever the ground is. Everything static is
 * merged into one mesh per material; everything repeated is instanced.
 */
import * as THREE from "three";
import { lines, mulberry32, nearestAddress, nearestRoad, pointInRing, ringArea, rings, type Building, type Neighbourhood } from "./geo";
import { decompose, edgesOf, frameOf, normaliseRing, offsetRing, toWorld, type Edge, type Frame, type Rect } from "./footprint";
import type { Ground } from "./terrain";
import { asphaltShingle, cedarShingle, disposeSurface, lapSiding, metalRoof, surfaceMaterial, type Surface } from "./textures";
import { boardBatten, brick, concrete, deckBoards, doorFace, garageDoorFace, metalSiding, mossyShingle, verticalCedar } from "./textures.buildings";

export interface Buildings {
  group: THREE.Group;
  /** Footprint rings with their floor height, for keeping trees and the player out. */
  footprints: { ring: number[][]; y: number; h: number; cx: number; cz: number; r: number }[];
  dispose(): void;
}

type V3 = [number, number, number];

// ---- Geometry sinks: one merged mesh per material ---------------------------------

interface Mat {
  m: THREE.Material;
  /** Metres per texture tile, for the uv in the sinks. */
  tile: number;
  s?: Surface;
}

function normalOf(a: V3, b: V3, c: V3): V3 {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

class Sink {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  constructor(readonly mat: Mat) {}
  private vert(p: V3, n: V3, u: number, v: number) {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.uv.push(u / this.mat.tile, v / this.mat.tile);
  }
  /** Four corners, uvs in metres. If `want` is given the winding is flipped so the normal points that way. */
  quad(a: V3, b: V3, c: V3, d: V3, uvs: number[], want?: V3) {
    let n = normalOf(a, b, c);
    if (want && n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) {
      const t = b;
      b = d;
      d = t;
      const tu = [uvs[2], uvs[3]];
      uvs = [uvs[0], uvs[1], uvs[6], uvs[7], uvs[4], uvs[5], tu[0], tu[1]];
      n = [-n[0], -n[1], -n[2]];
    }
    const base = this.pos.length / 3;
    this.vert(a, n, uvs[0], uvs[1]);
    this.vert(b, n, uvs[2], uvs[3]);
    this.vert(c, n, uvs[4], uvs[5]);
    this.vert(d, n, uvs[6], uvs[7]);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  tri(a: V3, b: V3, c: V3, uvs: number[], want?: V3) {
    let n = normalOf(a, b, c);
    if (want && n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) {
      const t = b;
      b = c;
      c = t;
      uvs = [uvs[0], uvs[1], uvs[4], uvs[5], uvs[2], uvs[3]];
      n = [-n[0], -n[1], -n[2]];
    }
    const base = this.pos.length / 3;
    this.vert(a, n, uvs[0], uvs[1]);
    this.vert(b, n, uvs[2], uvs[3]);
    this.vert(c, n, uvs[4], uvs[5]);
    this.idx.push(base, base + 1, base + 2);
  }
  /** A box whose local x axis is (ax, 0, az) in the world; sizes are full extents. */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, ax = 1, az = 0) {
    const ex: V3 = [ax, 0, az];
    const ey: V3 = [0, 1, 0];
    const ez: V3 = [-az, 0, ax];
    const face = (r1: V3, l1: number, r2: V3, l2: number, n: V3, ln: number) => {
      const c: V3 = [cx + n[0] * ln, cy + n[1] * ln, cz + n[2] * ln];
      const P = (s1: number, s2: number): V3 => [c[0] + r1[0] * l1 * s1 + r2[0] * l2 * s2, c[1] + r1[1] * l1 * s1 + r2[1] * l2 * s2, c[2] + r1[2] * l1 * s1 + r2[2] * l2 * s2];
      this.quad(P(-1, -1), P(1, -1), P(1, 1), P(-1, 1), [0, 0, l1 * 2, 0, l1 * 2, l2 * 2, 0, l2 * 2]);
    };
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    face(ex, hx, ey, hy, ez, hz);
    face(ey, hy, ex, hx, [-ez[0], -ez[1], -ez[2]], hz);
    face(ey, hy, ez, hz, ex, hx);
    face(ez, hz, ey, hy, [-ex[0], -ex[1], -ex[2]], hx);
    face(ez, hz, ex, hx, ey, hy);
    face(ex, hx, ez, hz, [-ey[0], -ey[1], -ey[2]], hy);
  }
  build(): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// ---- Instanced units -------------------------------------------------------------------------

class Batch {
  private units = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material; list: THREE.Matrix4[]; shadow: boolean }>();
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private sc = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  register(key: string, geo: THREE.BufferGeometry, mat: THREE.Material, shadow = true) {
    this.units.set(key, { geo, mat, list: [], shadow });
  }
  has(key: string) {
    return this.units.has(key);
  }
  place(key: string, x: number, y: number, z: number, yaw: number, sx = 1, sy = 1, sz = 1) {
    const u = this.units.get(key);
    if (!u) throw new Error(`no unit ${key}`);
    this.q.setFromAxisAngle(this.up, yaw);
    this.p.set(x, y, z);
    this.sc.set(sx, sy, sz);
    this.m4.compose(this.p, this.q, this.sc);
    u.list.push(this.m4.clone());
  }
  flush(group: THREE.Group) {
    for (const u of this.units.values()) {
      if (!u.list.length) continue;
      const mesh = new THREE.InstancedMesh(u.geo, u.mat, u.list.length);
      u.list.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = u.shadow;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
  }
  dispose() {
    for (const u of this.units.values()) u.geo.dispose();
  }
}

// ---- The kit: every material and unit the neighbourhood uses ------------------------------------

const LAP = ["#e7e3d8", "#d9d3c2", "#b8bcb2", "#8d9490", "#6f7a70", "#9aa892", "#a49a86", "#5c6670", "#8a5f4a", "#2f3a4a", "#c3c8bd", "#767068", "#e0d9b8", "#a7b3bd"];
const BATTEN = ["#2e3134", "#3a4550", "#4c5a50", "#8e8a80", "#e2ded4", "#6b2f27", "#5d5a55"];
const DOORS = ["#1c1c1c", "#6b2a22", "#2f4a3a", "#7a5230"];

type WinKind = "tall" | "dh" | "wide" | "pic" | "small" | "slider";
const WIN: Record<WinKind, { w: number; h: number; sill: number; mv: boolean; mh: boolean }> = {
  tall: { w: 0.85, h: 1.7, sill: 0.75, mv: false, mh: true },
  dh: { w: 0.9, h: 1.35, sill: 0.95, mv: false, mh: true },
  wide: { w: 1.8, h: 1.3, sill: 0.95, mv: true, mh: false },
  pic: { w: 2.2, h: 1.6, sill: 0.7, mv: false, mh: false },
  small: { w: 0.65, h: 0.7, sill: 1.5, mv: false, mh: false },
  slider: { w: 1.85, h: 2.05, sill: 0, mv: true, mh: false },
};

interface RoofMat {
  main: Mat;
  /** What the north slope wears when the roof is asphalt. */
  moss?: Mat;
  metal: boolean;
}

function kit() {
  const std = (s: Surface, tile: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}): Mat => ({ m: surfaceMaterial(s, { roughness: 0.85, ...opts }), tile, s });
  const plain = (color: number, roughness = 0.8, tile = 1, extra: Partial<THREE.MeshStandardMaterialParameters> = {}): Mat => ({ m: new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, ...extra }), tile });
  const asphalt = (c: string): RoofMat => ({ main: std(asphaltShingle(c), 3), moss: std(mossyShingle(c), 3), metal: false });
  const metal = (c: string): RoofMat => ({ main: std(metalRoof(c), 3, { roughness: 0.55, metalness: 0.2 }), metal: true });
  const K = {
    lap: LAP.map((c) => std(lapSiding(c), 2.4)),
    batten: BATTEN.map((c) => std(boardBatten(c), 2.4)),
    cedar: std(cedarShingle(true), 2.4),
    cedarNew: std(cedarShingle(false), 2.4),
    vcedar: std(verticalCedar(true), 2.4),
    vcedarNew: std(verticalCedar(false), 2.4),
    metalSide: std(metalSiding("#8a8f8c"), 2.4, { roughness: 0.5, metalness: 0.3 }),
    metalSideRed: std(metalSiding("#7a3a30"), 2.4, { roughness: 0.55, metalness: 0.25 }),
    roofs: {
      charcoal: asphalt("#3d3b39"),
      brown: asphalt("#4a3f36"),
      grey: asphalt("#5a5754"),
      mGrey: metal("#474c50"),
      mGreen: metal("#3f5a48"),
      mRed: metal("#7a3a30"),
      mCharcoal: metal("#2f3235"),
    },
    concrete: std(concrete(), 2.4, { roughness: 0.95 }),
    brick: std(brick(), 1.2, { roughness: 0.95 }),
    deck: std(deckBoards(), 1.2),
    trimW: plain(0xf2f0ea, 0.6),
    trimD: plain(0x26282a, 0.55),
    wood: plain(0x7d6b58, 0.9),
    steel: plain(0x3a3d40, 0.5, 1, { metalness: 0.4 }),
    membrane: plain(0x3b3b3a, 0.95),
    ceiling: plain(0x2a2826, 1),
    reveal: plain(0x141414, 0.9),
    glass: { m: new THREE.MeshPhysicalMaterial({ color: 0x0f171d, roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1 }), tile: 1 } as Mat,
    glassCurtain: plain(0xcfc3ad, 0.85),
    glassLit: plain(0xd6b98a, 0.7, 1, { emissive: 0x5a3f14, emissiveIntensity: 0.7 }),
    glassWall: { m: new THREE.MeshPhysicalMaterial({ color: 0xdfe8ea, roughness: 0.3, metalness: 0, transparent: true, opacity: 0.45, side: THREE.DoubleSide }), tile: 1 } as Mat,
    lamp: plain(0xfff1cc, 0.4, 1, { emissive: 0xffd9a0, emissiveIntensity: 1.4 }),
    tank: plain(0x8f9a93, 0.5, 1, { metalness: 0.5 }),
    doors: DOORS.map((c) => ({ m: new THREE.MeshStandardMaterial({ map: doorFace(c), roughness: 0.6 }), tile: 1 }) as Mat),
    garage1: ["#eae7df", "#3a3c3e"].map((c) => ({ m: new THREE.MeshStandardMaterial({ map: garageDoorFace(c, 1), roughness: 0.6 }), tile: 1 }) as Mat),
    garage2: ["#eae7df", "#3a3c3e"].map((c) => ({ m: new THREE.MeshStandardMaterial({ map: garageDoorFace(c, 2), roughness: 0.6 }), tile: 1 }) as Mat),
  };
  return K;
}
type Kit = ReturnType<typeof kit>;

/** The window, door and garage-door units, each built once and instanced. */
function registerUnits(K: Kit, batch: Batch) {
  const unitSink = () => new Sink({ m: K.trimW.m, tile: 1 });
  for (const kind of Object.keys(WIN) as WinKind[]) {
    const { w, h, mv, mh } = WIN[kind];
    const fw = 0.09;
    const frame = unitSink();
    // Jambs, head, and the sill and drip cap that stand proud of them.
    frame.box(-(w / 2 + fw / 2), 0, 0.03, fw, h + fw * 2, 0.06);
    frame.box(w / 2 + fw / 2, 0, 0.03, fw, h + fw * 2, 0.06);
    frame.box(0, h / 2 + fw / 2, 0.03, w, fw, 0.06);
    frame.box(0, -(h / 2 + fw / 2), 0.03, w, fw, 0.06);
    frame.box(0, -(h / 2 + fw) - 0.02, 0.06, w + 0.22, 0.05, 0.12);
    frame.box(0, h / 2 + fw + 0.035, 0.04, w + 0.22, 0.07, 0.08);
    if (mv) frame.box(0, 0, 0.03, 0.06, h, 0.035);
    if (mh) frame.box(0, 0.05, 0.03, w, 0.07, 0.035);
    const reveal = unitSink();
    const rw = 0.04;
    reveal.box(-(w / 2 - rw / 2), 0, 0.015, rw, h, 0.03);
    reveal.box(w / 2 - rw / 2, 0, 0.015, rw, h, 0.03);
    reveal.box(0, h / 2 - rw / 2, 0.015, w, rw, 0.03);
    reveal.box(0, -(h / 2 - rw / 2), 0.015, w, rw, 0.03);
    const glass = new THREE.BoxGeometry(w - 0.02, h - 0.02, 0.012);
    glass.translate(0, 0, 0.011);
    const fg = frame.build()!;
    const rg = reveal.build()!;
    batch.register(`win:${kind}:frameW`, fg, K.trimW.m);
    batch.register(`win:${kind}:frameD`, fg, K.trimD.m);
    batch.register(`win:${kind}:reveal`, rg, K.reveal.m, false);
    batch.register(`win:${kind}:glass`, glass, K.glass.m, false);
    batch.register(`win:${kind}:curtain`, glass, K.glassCurtain.m, false);
    batch.register(`win:${kind}:lit`, glass, K.glassLit.m, false);
  }
  // Front door: slab, trim, and the porch light beside it. Origin at the floor.
  const doorSlab = new THREE.BoxGeometry(0.95, 2.05, 0.05);
  doorSlab.translate(0, 1.025, 0.03);
  K.doors.forEach((d, i) => batch.register(`door:${i}`, doorSlab, d.m));
  const df = unitSink();
  df.box(-0.525, 1.075, 0.035, 0.1, 2.15, 0.07);
  df.box(0.525, 1.075, 0.035, 0.1, 2.15, 0.07);
  df.box(0, 2.1, 0.035, 1.15, 0.1, 0.07);
  const dfg = df.build()!;
  batch.register("door:frameW", dfg, K.trimW.m);
  batch.register("door:frameD", dfg, K.trimD.m);
  const lamp = unitSink();
  lamp.box(0.78, 2.15, 0.07, 0.14, 0.22, 0.14);
  batch.register("lamp", lamp.build()!, K.lamp.m, false);
  // Garage doors, one and two bays.
  for (const [bays, w] of [
    [1, 2.7],
    [2, 4.9],
  ] as const) {
    const slab = new THREE.BoxGeometry(w, 2.15, 0.06);
    slab.translate(0, 1.075, 0.03);
    const mats = bays === 1 ? K.garage1 : K.garage2;
    mats.forEach((m, i) => batch.register(`garage:${bays}:${i}`, slab, m.m));
    const gf = unitSink();
    gf.box(-(w / 2 + 0.06), 1.1, 0.04, 0.12, 2.2, 0.08);
    gf.box(w / 2 + 0.06, 1.1, 0.04, 0.12, 2.2, 0.08);
    gf.box(0, 2.24, 0.04, w + 0.24, 0.12, 0.08);
    const gfg = gf.build()!;
    batch.register(`garage:${bays}:frameW`, gfg, K.trimW.m);
    batch.register(`garage:${bays}:frameD`, gfg, K.trimD.m);
  }
  // Unit boxes, scaled into posts, rails, gutters, downspouts, steps and balusters.
  const box = new THREE.BoxGeometry(1, 1, 1);
  batch.register("box:white", box, K.trimW.m);
  batch.register("box:dark", box, K.trimD.m);
  batch.register("box:wood", box, K.wood.m);
  batch.register("box:concrete", box, K.concrete.m);
  batch.register("box:steel", box, K.steel.m);
  const flue = new THREE.CylinderGeometry(0.14, 0.14, 1, 10);
  flue.translate(0, 0.5, 0);
  batch.register("flue", flue, K.steel.m);
  const cap = new THREE.CylinderGeometry(0.24, 0.2, 0.18, 10);
  batch.register("flueCap", cap, K.steel.m);
}

// ---- Styles ------------------------------------------------------------------------------------

type Era = "old" | "mid" | "modern" | "shed" | "barn" | "school" | "lodge" | "industrial" | "church" | "greenhouse";
type RoofKind = "gable" | "hip" | "shed" | "flat";

interface Style {
  era: Era;
  siding: Mat;
  trim: Mat;
  dark: boolean;
  roof: RoofMat;
  roofKind: RoofKind;
  win: WinKind;
  winAlt: WinKind;
  gap: number;
  door: number;
  porch: boolean;
  chimney: "brick" | "flue" | "none";
  garage: boolean;
  deck: boolean;
  pitch: [number, number];
  gutters: boolean;
}

function pickStyle(K: Kit, era: Era, rnd: () => number, near: number): Style {
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const R = K.roofs;
  switch (era) {
    case "old":
      return {
        era,
        siding: rnd() < 0.25 ? K.cedar : pick([K.lap[0], K.lap[1], K.lap[12], K.lap[10], K.lap[5], K.lap[2]]),
        trim: K.trimW,
        dark: false,
        roof: pick([R.charcoal, R.brown, R.grey, R.mGrey, R.mRed]),
        roofKind: near < 1.35 ? (rnd() < 0.6 ? "hip" : "gable") : "gable",
        win: "tall",
        winAlt: "dh",
        gap: 1.5,
        door: pick([0, 1, 2, 3]),
        porch: rnd() < 0.8,
        chimney: "brick",
        garage: false,
        deck: rnd() < 0.5,
        pitch: [0.5, 0.85],
        gutters: true,
      };
    case "mid":
      return {
        era,
        siding: rnd() < 0.2 ? K.cedar : pick([K.lap[2], K.lap[3], K.lap[4], K.lap[6], K.lap[7], K.lap[11], K.lap[13], K.lap[8], K.lap[1]]),
        trim: K.trimW,
        dark: false,
        roof: pick([R.charcoal, R.brown, R.grey, R.charcoal, R.mGrey]),
        roofKind: near < 1.3 ? (rnd() < 0.5 ? "hip" : "gable") : rnd() < 0.85 ? "gable" : "hip",
        win: rnd() < 0.5 ? "wide" : "dh",
        winAlt: rnd() < 0.5 ? "dh" : "small",
        gap: 1.7,
        door: pick([0, 1, 2, 3]),
        porch: rnd() < 0.2,
        chimney: rnd() < 0.5 ? "brick" : "flue",
        garage: true,
        deck: rnd() < 0.75,
        pitch: [0.33, 0.6],
        gutters: true,
      };
    case "modern":
      return {
        era,
        siding: rnd() < 0.3 ? (rnd() < 0.5 ? K.vcedarNew : K.vcedar) : pick([K.batten[0], K.batten[1], K.batten[2], K.batten[3], K.batten[4], K.batten[6], K.lap[9]]),
        trim: K.trimD,
        dark: true,
        roof: pick([R.mCharcoal, R.mGrey, R.mGreen, R.charcoal]),
        roofKind: rnd() < 0.85 ? "gable" : "hip",
        win: rnd() < 0.5 ? "pic" : "wide",
        winAlt: rnd() < 0.5 ? "wide" : "tall",
        gap: 1.9,
        door: pick([0, 3]),
        porch: false,
        chimney: "flue",
        garage: true,
        deck: rnd() < 0.85,
        pitch: [0.2, 0.45],
        gutters: true,
      };
    case "barn":
      return {
        era,
        siding: pick([K.batten[5], K.vcedar, K.batten[5], K.metalSideRed, K.batten[3]]),
        trim: K.trimW,
        dark: false,
        roof: pick([R.mGrey, R.mGrey, R.mRed, R.grey]),
        roofKind: "gable",
        win: "small",
        winAlt: "small",
        gap: 3,
        door: 3,
        porch: false,
        chimney: "none",
        garage: true,
        deck: false,
        pitch: [0.45, 0.7],
        gutters: false,
      };
    case "lodge":
      return {
        era,
        siding: rnd() < 0.5 ? K.vcedarNew : K.batten[2],
        trim: K.trimD,
        dark: true,
        roof: pick([R.mGreen, R.mCharcoal]),
        roofKind: "gable",
        win: "pic",
        winAlt: "wide",
        gap: 1.6,
        door: 3,
        porch: false,
        chimney: "flue",
        garage: false,
        deck: true,
        pitch: [0.35, 0.55],
        gutters: true,
      };
    case "industrial":
      return { era, siding: K.metalSide, trim: K.trimD, dark: true, roof: R.mGrey, roofKind: "gable", win: "small", winAlt: "small", gap: 4, door: 0, porch: false, chimney: "none", garage: true, deck: false, pitch: [0.15, 0.25], gutters: false };
    case "church":
      return { era, siding: K.lap[0], trim: K.trimW, dark: false, roof: R.charcoal, roofKind: "gable", win: "tall", winAlt: "tall", gap: 1.6, door: 1, porch: false, chimney: "none", garage: false, deck: false, pitch: [0.8, 1.0], gutters: true };
    case "school":
      return { era, siding: K.vcedarNew, trim: K.trimD, dark: true, roof: R.mGrey, roofKind: "flat", win: "wide", winAlt: "wide", gap: 1.2, door: 0, porch: false, chimney: "none", garage: false, deck: false, pitch: [0.15, 0.2], gutters: false };
    case "greenhouse":
      return { era, siding: K.glassWall, trim: K.trimW, dark: false, roof: { main: K.glassWall, metal: false }, roofKind: "gable", win: "small", winAlt: "small", gap: 9, door: 0, porch: false, chimney: "none", garage: false, deck: false, pitch: [0.4, 0.5], gutters: false };
    default:
      return {
        era: "shed",
        siding: pick([K.batten[3], K.batten[6], K.vcedar, K.batten[4], K.lap[11], K.batten[5], K.cedar]),
        trim: K.trimW,
        dark: false,
        roof: pick([R.mGrey, R.charcoal, R.grey, R.mGreen]),
        roofKind: rnd() < 0.3 ? "shed" : "gable",
        win: "small",
        winAlt: "small",
        gap: 2.5,
        door: 3,
        porch: false,
        chimney: "none",
        garage: false,
        deck: false,
        pitch: [0.3, 0.55],
        gutters: false,
      };
  }
}

/** Houses with a known history along Beck Road: the era their style should match. */
const KNOWN: { n: string; era: Era; floors?: number; porch?: boolean }[] = [
  { n: "8330", era: "old", floors: 1, porch: true },
  { n: "8285", era: "old", floors: 1, porch: true },
  { n: "8368", era: "old", floors: 1, porch: true },
  { n: "8407", era: "mid", floors: 2 },
  { n: "8416", era: "modern", floors: 1 },
  { n: "8490", era: "modern", floors: 2 },
];

// ---- Massing ------------------------------------------------------------------------------------

interface Massing {
  eave: number;
  pitch: number;
  floors: number;
}

function massing(b: Building, style: Style, area: number, hv: number, rnd: () => number, floorsWanted?: number): Massing {
  const [pLo, pHi] = style.pitch;
  const clamp = (v: number, a: number, c: number) => Math.max(a, Math.min(c, v));
  const h = b.h && b.h > 2.2 ? b.h : null;
  if (style.era === "shed" || style.era === "greenhouse") {
    const eave = h ? clamp(h - hv * pLo, 2.2, 2.8) : 2.4;
    const pitch = h ? clamp((h - eave) / hv, pLo, pHi) : (pLo + pHi) / 2;
    return { eave, pitch, floors: 1 };
  }
  if (style.era === "barn" || style.era === "industrial") {
    const eave = h ? clamp(h - hv * pLo, 3.2, 5.5) : 4.2;
    const pitch = h ? clamp((h - eave) / hv, pLo, pHi) : (pLo + pHi) / 2;
    return { eave, pitch, floors: 1 };
  }
  if (style.era === "school") return { eave: h ? Math.max(3.8, h) : 4.2, pitch: 0.15, floors: 1 };
  if (style.roofKind === "flat") return { eave: h ?? 3.4, pitch: 0, floors: h && h > 5.5 ? 2 : 1 };
  const eaveOne = style.era === "old" ? 3.0 : style.era === "modern" ? 3.4 : 3.1;
  const eaveTwo = style.era === "old" ? 5.7 : 5.9;
  if (floorsWanted === 2) {
    const eave = h ? clamp(h - hv * pLo, 5.4, 6.3) : eaveTwo;
    return { eave, pitch: h ? clamp((h - eave) / hv, pLo, pHi) : (pLo + pHi) / 2, floors: 2 };
  }
  if (floorsWanted === 1) {
    const eave = h ? clamp(h - hv * pLo, 2.8, 4.4) : eaveOne;
    return { eave, pitch: h ? clamp((h - eave) / hv, pLo, pHi) : (pLo + pHi) / 2, floors: 1 };
  }
  if (h) {
    // Two storeys if the measured ridge allows a real second floor under a sane pitch.
    const p2 = (h - eaveTwo) / hv;
    if (p2 >= pLo * 0.8 && area > 60) return { eave: h - clamp(p2, pLo, pHi) * hv, pitch: clamp(p2, pLo, pHi), floors: 2 };
    const eave = clamp(h - hv * (pLo + pHi) * 0.5, 2.8, 4.4);
    return { eave, pitch: clamp((h - eave) / hv, pLo, pHi), floors: 1 };
  }
  const two = area > 100 && rnd() < 0.45;
  return { eave: two ? eaveTwo : eaveOne, pitch: pLo + rnd() * (pHi - pLo), floors: two ? 2 : 1 };
}

// ---- Build ------------------------------------------------------------------------------------

export function buildBuildings(data: Neighbourhood, ground: Ground): Buildings {
  const group = new THREE.Group();
  const K = kit();
  const batch = new Batch();
  registerUnits(K, batch);
  const sinks = new Map<THREE.Material, Sink>();
  const sink = (m: Mat) => {
    let s = sinks.get(m.m);
    if (!s) {
      s = new Sink(m);
      sinks.set(m.m, s);
    }
    return s;
  };
  const footprints: Buildings["footprints"] = [];

  // Driveway ends and farm polygons, for garages and barns.
  const driveEnds: number[][] = [];
  for (const r of data.roads) {
    if (r.cls !== "service" && r.cls !== "track") continue;
    for (const l of lines(r.g)) {
      if (l.length < 2) continue;
      driveEnds.push(l[0], l[l.length - 1]);
    }
  }
  const farmRings: number[][][] = [];
  for (const l of data.landuse) if (l.cls === "farmland" || l.cls === "animal_keeping" || l.cls === "orchard") for (const r of rings(l.g)) farmRings.push(r);
  const schoolRings: number[][][] = [];
  for (const l of data.landuse) if (l.cls === "school") for (const r of rings(l.g)) schoolRings.push(r);
  const known = new Map<number, (typeof KNOWN)[number]>();
  for (const k of KNOWN) {
    const a = data.addresses.find((x) => x.n === k.n && x.st && x.st.toLowerCase().includes("beck"));
    if (!a || a.g.t !== "pt") continue;
    let best = -1;
    let bestD = 20;
    data.buildings.forEach((b, i) => {
      for (const r of rings(b.g)) {
        let cx = 0;
        let cz = 0;
        for (const p of r) {
          cx += p[0];
          cz += p[1];
        }
        cx /= r.length;
        cz /= r.length;
        const d = Math.hypot(cx - (a.g as { c: number[] }).c[0], cz - (a.g as { c: number[] }).c[1]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    });
    if (best >= 0) known.set(best, k);
  }

  data.buildings.forEach((b, index) => {
    for (const raw of rings(b.g)) {
      const ring = normaliseRing(raw);
      if (ring.length < 3) continue;
      const area = Math.abs(ringArea(ring));
      if (area < 6) continue;
      const rnd = mulberry32(2026 + index * 7919);
      const f = frameOf(ring);
      const cls = (b.cls || "").toLowerCase();
      const name = (b.name || "").toLowerCase();
      const cx = f.cx;
      const cz = f.cz;
      let onFarm = false;
      for (const r of farmRings) if (pointInRing(cx, cz, r)) onFarm = true;
      let onSchool = false;
      for (const r of schoolRings) if (pointInRing(cx, cz, r)) onSchool = true;

      // What is it?
      let era: Era;
      const override = known.get(index);
      if (cls === "school" || (onSchool && area > 900)) era = "school";
      else if (cls === "storage_tank") era = "industrial";
      else if (cls === "greenhouse") era = "greenhouse";
      else if (cls === "church") era = "church";
      else if (cls === "industrial") era = "industrial";
      else if (cls === "barn" || (onFarm && area > 70 && rnd() < 0.7)) era = "barn";
      else if (b.name && !cls) era = "lodge";
      else if (override) era = override.era;
      else if (cls === "shed" || cls === "garage" || cls === "roof" || area < 42) era = "shed";
      else {
        const r = rnd();
        era = r < 0.22 ? "old" : r < 0.65 ? "mid" : "modern";
      }
      const isGarage = cls === "garage" || (era === "shed" && area >= 28 && area < 75 && rnd() < 0.6);
      const isCarport = cls === "roof";
      const near = f.w / Math.max(0.5, f.d);
      const style = pickStyle(K, era, rnd, near);
      if (override?.porch !== undefined) style.porch = override.porch;
      if (era === "shed" && isGarage) style.garage = true;

      // Ground under the footprint; the floor sits on the high side, the stem wall takes up the rest.
      let top = -Infinity;
      let low = Infinity;
      for (const p of ring) {
        const h = ground.heightAt(p[0], p[1]);
        if (h > top) top = h;
        if (h < low) low = h;
      }
      const slab = era === "shed" || era === "barn" || era === "industrial" || era === "greenhouse" || era === "school";
      const y = top + (slab ? 0.12 : 0.45);

      const dec = decompose(ring, f, era === "school" ? 14 : 6);
      const primary = dec.rects[0];
      const m = massing(b, style, area, Math.min(primary.hu, primary.hv), rnd, override?.floors);
      let eave = m.eave;
      const pitch = m.pitch;
      const floors = m.floors;
      const roofKind: RoofKind = cls === "storage_tank" ? "flat" : style.roofKind;
      const edges = edgesOf(ring);

      if (cls === "storage_tank") {
        const r = Math.sqrt(area / Math.PI);
        const g = new THREE.CylinderGeometry(r, r, eave, 24);
        g.translate(cx, y + eave / 2, cz);
        const mesh = new THREE.Mesh(g, K.tank.m);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
        footprints.push({ ring, y, h: eave, cx, cz, r: r + 1 });
        continue;
      }

      // ---- Walls and stem wall ------------------------------------------------------------
      // The siding runs down to a hand above the ground on the downhill side (skirting the
      // crawlspace, the way the raised houses here are finished) and the stem wall shows a
      // constant band of concrete above the grade wherever the grade is.
      const wallTop = y + eave;
      const skirt = (x: number, z: number) => Math.min(y - 0.06, ground.heightAt(x, z) + 0.38);
      if (!isCarport) {
        const ws = sink(style.siding);
        let run = 0;
        for (const e of edges) {
          const ya = skirt(e.ax, e.az);
          const yb = skirt(e.bx, e.bz);
          ws.quad([e.ax, ya, e.az], [e.bx, yb, e.bz], [e.bx, wallTop, e.bz], [e.ax, wallTop, e.az], [run, ya, run + e.len, yb, run + e.len, wallTop, run, wallTop]);
          run += e.len;
        }
      }
      {
        const cs = sink(K.concrete);
        const outer = offsetRing(ring, 0.04);
        const oe = edgesOf(outer);
        let run = 0;
        for (const e of oe) {
          const ya = isCarport ? y + 0.1 : Math.min(y - 0.02, ground.heightAt(e.ax, e.az) + 0.42);
          const yb = isCarport ? y + 0.1 : Math.min(y - 0.02, ground.heightAt(e.bx, e.bz) + 0.42);
          cs.quad([e.ax, low - 0.8, e.az], [e.bx, low - 0.8, e.bz], [e.bx, yb, e.bz], [e.ax, ya, e.az], [run, 0, run + e.len, 0, run + e.len, yb - low + 0.8, run, ya - low + 0.8]);
          run += e.len;
        }
        // Slab top for the carport.
        if (isCarport) capRing(cs, ring, y + 0.1);
      }
      // A ceiling under the roofs, so a notch the rectangles missed is closed.
      if (era !== "greenhouse") capRing(sink(K.ceiling), ring, wallTop - 0.05);

      // ---- Roofs ----------------------------------------------------------------------------
      let ridgeTop = wallTop;
      const overhang = era === "shed" ? 0.3 : era === "school" ? 0.2 : 0.5;
      const rake = era === "shed" ? 0.25 : 0.35;
      const gutterKey = style.dark ? "box:dark" : "box:white";
      if (roofKind === "flat" || era === "school") {
        // Membrane on the whole ring and a parapet.
        capRing(sink(K.membrane), ring, wallTop + 0.05);
        const ps = sink(style.siding);
        const cap = sink(style.trim);
        let run = 0;
        for (const e of edges) {
          ps.quad([e.ax, wallTop, e.az], [e.bx, wallTop, e.bz], [e.bx, wallTop + 0.5, e.bz], [e.ax, wallTop + 0.5, e.az], [run, wallTop, run + e.len, wallTop, run + e.len, wallTop + 0.5, run, wallTop + 0.5]);
          cap.quad([e.ax, wallTop + 0.5, e.az], [e.bx, wallTop + 0.5, e.bz], [e.bx + e.nx * 0.12, wallTop + 0.5, e.bz + e.nz * 0.12], [e.ax + e.nx * 0.12, wallTop + 0.5, e.az + e.nz * 0.12], [0, 0, e.len, 0, e.len, 0.12, 0, 0.12], [0, 1, 0]);
          run += e.len;
        }
        ridgeTop = wallTop + 0.5;
        if (era === "school") {
          // The gym: the squarest big block stands taller under a low metal gable.
          let gym: Rect | null = null;
          for (const r of dec.rects) if (Math.min(r.hu, r.hv) > 8 && (!gym || Math.min(r.hu, r.hv) > Math.min(gym.hu, gym.hv))) gym = r;
          if (gym) {
            const g: Rect = { cu: gym.cu, cv: gym.cv, hu: gym.hu - 0.15, hv: gym.hv - 0.15 };
            const gEave = y + 8.2;
            const gs = sink(K.batten[0]);
            const corners = [toWorld(f, g.cu - g.hu, g.cv - g.hv), toWorld(f, g.cu + g.hu, g.cv - g.hv), toWorld(f, g.cu + g.hu, g.cv + g.hv), toWorld(f, g.cu - g.hu, g.cv + g.hv)];
            let run = 0;
            for (let i = 0; i < 4; i++) {
              const a = corners[i];
              const c = corners[(i + 1) % 4];
              const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
              const gc = toWorld(f, g.cu, g.cv);
              const ox = (a[0] + c[0]) / 2 - gc[0];
              const oz = (a[1] + c[1]) / 2 - gc[1];
              const ol = Math.hypot(ox, oz) || 1;
              const out: V3 = [ox / ol, 0, oz / ol];
              gs.quad([a[0], wallTop - 0.2, a[1]], [c[0], wallTop - 0.2, c[1]], [c[0], gEave, c[1]], [a[0], gEave, a[1]], [run, 0, run + len, 0, run + len, gEave - wallTop, run, gEave - wallTop], out);
              run += len;
            }
            const r = pitchedRoof(sink, batch, f, g, gEave, 0.18, "gable", 0.4, 0.3, style.roof, K, style, rnd, false, gutterKey, ground);
            ridgeTop = Math.max(ridgeTop, r);
          }
          eave = 4.2;
        }
      } else {
        for (let i = 0; i < dec.rects.length; i++) {
          const r = pitchedRoof(sink, batch, f, dec.rects[i], wallTop, pitch, roofKind, overhang, rake, style.roof, K, style, rnd, i === 0 || dec.rectilinear, gutterKey, ground);
          if (i === 0) ridgeTop = r;
        }
      }
      if (isCarport) {
        // Posts at the corners and along the long sides.
        const hu = primary.hu - 0.3;
        const hv = primary.hv - 0.3;
        const n = Math.max(1, Math.round(hu / 3));
        for (let k = 0; k <= n; k++) {
          for (const sv of [-1, 1]) {
            const u = -hu + (2 * hu * k) / n;
            const p = toWorld(f, primary.cu + u, primary.cv + sv * hv);
            const g = ground.heightAt(p[0], p[1]);
            batch.place("box:wood", p[0], (g + wallTop) / 2, p[1], 0, 0.14, wallTop - g, 0.14);
          }
        }
        footprints.push({ ring, y, h: eave, cx, cz, r: Math.max(f.w, f.d) / 2 + 1 });
        continue;
      }

      // ---- Openings ---------------------------------------------------------------------
      // The house fronts the street in its address, or the nearest road when no address is near.
      const ROAD_CLASSES = ["residential", "tertiary", "secondary", "unclassified"];
      const addr = nearestAddress(data, cx, cz);
      const road = (addr && addr.d < 35 && addr.address.st ? nearestRoad(data, cx, cz, ROAD_CLASSES, addr.address.st) : null) ?? nearestRoad(data, cx, cz, ROAD_CLASSES);
      const toRoad = road ? [road.x - cx, road.z - cz] : [0, 1];
      const rl = Math.hypot(toRoad[0], toRoad[1]) || 1;
      toRoad[0] /= rl;
      toRoad[1] /= rl;
      const score = (e: Edge, dir: number[]) => (e.nx * dir[0] + e.nz * dir[1]) * Math.sqrt(Math.min(e.len, 9));
      let front: Edge | null = null;
      for (const e of edges) if (e.len >= 2.6 && (!front || score(e, toRoad) > score(front, toRoad))) front = e;
      if (front && score(front, toRoad) < 0.2) front = edges.reduce((a, e) => (e.len > a.len ? e : a), edges[0]);

      // Garage: the wall that faces the nearest driveway end, if it is long enough for a door.
      let garageWall: Edge | null = null;
      let garageT = 0;
      let garageBays = 0;
      const wantsGarage = style.garage && !isCarport && (era === "shed" ? isGarage : area > 130 || era === "barn" || era === "industrial");
      if (wantsGarage) {
        let bestD = Infinity;
        let bestEnd: number[] | null = null;
        const reach = Math.max(f.w, f.d) / 2 + 16;
        for (const p of driveEnds) {
          const d = Math.hypot(p[0] - cx, p[1] - cz);
          if (d < bestD && d < reach) {
            bestD = d;
            bestEnd = p;
          }
        }
        const target = bestEnd ?? (era === "shed" || era === "barn" ? [cx + toRoad[0] * 20, cz + toRoad[1] * 20] : null);
        if (target) {
          const dir = [target[0] - cx, target[1] - cz];
          const dl = Math.hypot(dir[0], dir[1]) || 1;
          dir[0] /= dl;
          dir[1] /= dl;
          for (const e of edges) {
            const minLen = era === "shed" ? 3.4 : 5.6;
            if (e.len < minLen) continue;
            if (e.nx * dir[0] + e.nz * dir[1] < 0.5) continue;
            // Wall must sit above ground within reach of a car: no garage door over a drop.
            const gm = ground.heightAt((e.ax + e.bx) / 2 + e.nx * 3, (e.az + e.bz) / 2 + e.nz * 3);
            if (y - gm > 1.2) continue;
            if (!garageWall || score(e, dir) > score(garageWall, dir)) garageWall = e;
          }
          if (garageWall) {
            garageBays = garageWall.len >= 8.5 && era !== "shed" ? 2 : 1;
            const gw = garageBays === 2 ? 4.9 : 2.7;
            // Slide the door toward the driveway end along the wall.
            const t = ((target[0] - garageWall.ax) * garageWall.tx + (target[1] - garageWall.az) * garageWall.tz) / garageWall.len;
            garageT = Math.max(gw / 2 + 0.5, Math.min(garageWall.len - gw / 2 - 0.5, t * garageWall.len));
          }
        }
      }

      // Deck: the downhill wall, not the front, where the ground drops away (or a low one on a flat lot).
      let deckWall: Edge | null = null;
      let deckDrop = 0;
      if (style.deck && area > 70 && floors >= 1) {
        let bestH = Infinity;
        for (const e of edges) {
          if (e === front || e === garageWall || e.len < 3.6) continue;
          const mx = (e.ax + e.bx) / 2;
          const mz = (e.az + e.bz) / 2;
          const h = ground.heightAt(mx + e.nx * 2.6, mz + e.nz * 2.6);
          const c1 = [e.ax + e.nx * 3.2 + e.tx * 0.5, e.az + e.nz * 3.2 + e.tz * 0.5];
          const c2 = [e.bx + e.nx * 3.2 - e.tx * 0.5, e.bz + e.nz * 3.2 - e.tz * 0.5];
          if (pointInRing(c1[0], c1[1], ring) || pointInRing(c2[0], c2[1], ring)) continue;
          if (h < bestH) {
            bestH = h;
            deckWall = e;
          }
        }
        if (deckWall) {
          deckDrop = y - bestH;
          if (deckDrop < 0.6 && rnd() < 0.6) deckWall = null;
        }
      }

      // Porch on the front wall for the older houses.
      const porchWall = style.porch && front && front.len >= 5 && front !== garageWall && floors >= 1 ? front : null;

      const winKey = (kind: WinKind, x: number, wy: number, z: number, yaw: number) => {
        batch.place(style.dark ? `win:${kind}:frameD` : `win:${kind}:frameW`, x, wy, z, yaw);
        batch.place(`win:${kind}:reveal`, x, wy, z, yaw);
        const r = rnd();
        batch.place(r < 0.08 ? `win:${kind}:lit` : r < 0.3 ? `win:${kind}:curtain` : `win:${kind}:glass`, x, wy, z, yaw);
      };
      const at = (e: Edge, t: number, out = 0): [number, number] => [e.ax + e.tx * t + e.nx * out, e.az + e.tz * t + e.nz * out];

      let doorPlaced = false;
      for (const e of edges) {
        if (e.len < 1.6) continue;
        const reserved: { t: number; w: number }[] = [];
        const isFront = e === front;
        const isGarage = e === garageWall;
        const isDeck = e === deckWall;
        if (isGarage) {
          const gw = garageBays === 2 ? 4.9 : 2.7;
          const p = at(e, garageT, 0.0);
          batch.place(`garage:${garageBays}:${style.dark || era === "barn" ? 1 : 0}`, p[0], y, p[1], e.yaw);
          batch.place(`garage:${garageBays}:${style.dark ? "frameD" : "frameW"}`, p[0], y, p[1], e.yaw);
          reserved.push({ t: garageT, w: gw + 0.5 });
          // Apron: a concrete pad in front of the door.
          const ap = at(e, garageT, 1.5);
          const g = ground.heightAt(ap[0], ap[1]);
          batch.place("box:concrete", ap[0], Math.min(y, g) - 0.02, ap[1], e.yaw, gw + 0.6, 0.1, 3);
        }
        if (isFront && !doorPlaced && era !== "greenhouse") {
          // The door sits at the middle, or beside the garage door.
          let t = e.len / 2;
          if (isGarage) {
            const gw = garageBays === 2 ? 4.9 : 2.7;
            const left = garageT - gw / 2 - 0.5;
            const right = e.len - (garageT + gw / 2 + 0.5);
            if (Math.max(left, right) >= 1.8) t = left > right ? left / 2 + 0.2 : e.len - right / 2 - 0.2;
            else t = -1;
          }
          if (t > 0.7 && t < e.len - 0.7) {
            const p = at(e, t, 0);
            batch.place(`door:${style.door}`, p[0], y, p[1], e.yaw);
            batch.place(style.dark ? "door:frameD" : "door:frameW", p[0], y, p[1], e.yaw);
            batch.place("lamp", p[0], y, p[1], e.yaw);
            reserved.push({ t, w: era === "shed" ? 1.3 : 1.7 });
            doorPlaced = true;
            // Steps down to the ground unless a porch carries the floor out.
            if (!porchWall) {
              const g = ground.heightAt(p[0] + e.nx * 0.8, p[1] + e.nz * 0.8);
              const n = Math.min(10, Math.ceil((y - g) / 0.17));
              for (let k = 0; k < n; k++) {
                const sp = at(e, t, 0.18 + 0.34 * k);
                batch.place("box:concrete", sp[0], y - 0.085 - 0.17 * k, sp[1], e.yaw, 1.3, 0.17, 0.36);
              }
            }
          }
        }
        if (isDeck) {
          const t = e.len / 2;
          const p = at(e, t, 0);
          winKey("slider", p[0], y + WIN.slider.h / 2, p[1], e.yaw);
          reserved.push({ t, w: WIN.slider.w + 0.7 });
        }
        // Windows in the free spans on every floor.
        if (era === "greenhouse") continue;
        const north = e.nz < -0.6;
        for (let fl = 0; fl < floors; fl++) {
          const floorY = y + fl * (floors === 2 ? (eave - 0.5) / 2 : 0);
          let kind: WinKind = fl === 0 ? style.win : style.winAlt === "small" ? "dh" : style.winAlt;
          if (era === "shed" || era === "barn") kind = "small";
          if (era === "school") kind = "wide";
          const spec = WIN[kind];
          const top = floorY + spec.sill + spec.h;
          if (top > wallTop - 0.3) {
            kind = "small";
            if (floorY + WIN.small.sill + WIN.small.h > wallTop - 0.25) continue;
          }
          const ww = WIN[kind].w;
          const gap = style.gap;
          const margin = 0.55;
          // Free spans along the wall.
          const cuts = (fl === 0 ? reserved.slice() : []).sort((a, b) => a.t - b.t);
          let cursor = margin;
          const spans: [number, number][] = [];
          for (const c of cuts) {
            const t0 = c.t - c.w / 2;
            if (t0 - cursor >= ww) spans.push([cursor, t0]);
            cursor = Math.max(cursor, c.t + c.w / 2);
          }
          if (e.len - margin - cursor >= ww) spans.push([cursor, e.len - margin]);
          const density = era === "shed" || era === "barn" ? 0.35 : north ? 0.6 : 0.88;
          for (const [t0, t1] of spans) {
            const W = t1 - t0;
            const n = Math.max(1, Math.floor((W + gap) / (ww + gap)));
            if (n === 1 && rnd() > density) continue;
            for (let k = 0; k < n; k++) {
              if (n > 1 && rnd() > density) continue;
              const t = t0 + (W * (k + 0.5)) / n;
              const p = at(e, t, 0);
              winKey(kind, p[0], floorY + WIN[kind].sill + WIN[kind].h / 2, p[1], e.yaw);
            }
          }
        }
      }

      // ---- Deck ----------------------------------------------------------------------------
      if (deckWall) {
        const e = deckWall;
        const dw = Math.min(7, e.len - 1.0);
        const dd = 3.2;
        const tc = e.len / 2;
        const ds = sink(K.deck);
        const c = at(e, tc, dd / 2);
        ds.box(c[0], y - 0.12, c[1], dw, 0.24, dd, e.tx, e.tz);
        // Posts to the ground along the outer edge, railing on three sides.
        const outer = [-dw / 2 + 0.15, dw / 2 - 0.15];
        for (let k = 1; k < dw / 2.4; k++) outer.push(-dw / 2 + (dw * k) / Math.ceil(dw / 2.4));
        for (const o of outer) {
          const p = at(e, tc + o, dd - 0.15);
          const g = ground.heightAt(p[0], p[1]);
          if (y - 0.2 - g > 0.05) batch.place("box:wood", p[0], (g - 0.2 + y - 0.2) / 2, p[1], e.yaw, 0.14, y - 0.2 - g + 0.2, 0.14);
        }
        const railY = y + 0.95;
        const rail = (a: [number, number], b: [number, number]) => {
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const ax = (b[0] - a[0]) / len;
          const az = (b[1] - a[1]) / len;
          ds.box((a[0] + b[0]) / 2, railY, (a[1] + b[1]) / 2, len, 0.06, 0.1, ax, az);
          ds.box((a[0] + b[0]) / 2, y + 0.12, (a[1] + b[1]) / 2, len, 0.05, 0.05, ax, az);
          const posts = Math.max(1, Math.round(len / 1.8));
          for (let k = 0; k <= posts; k++) {
            const t = k / posts;
            batch.place("box:wood", a[0] + (b[0] - a[0]) * t, y + 0.5, a[1] + (b[1] - a[1]) * t, Math.atan2(ax, az), 0.1, 1.0, 0.1);
          }
          const bal = Math.floor(len / 0.14);
          for (let k = 1; k < bal; k++) {
            const t = k / bal;
            batch.place("box:wood", a[0] + (b[0] - a[0]) * t, y + 0.52, a[1] + (b[1] - a[1]) * t, Math.atan2(ax, az), 0.035, 0.8, 0.035);
          }
        };
        const c0 = at(e, tc - dw / 2 + 0.05, 0.05);
        const c1 = at(e, tc - dw / 2 + 0.05, dd - 0.06);
        const c2 = at(e, tc + dw / 2 - 0.05, dd - 0.06);
        const c3 = at(e, tc + dw / 2 - 0.05, 0.05);
        rail(c0, c1);
        rail(c2, c3);
        // Stairs come off one end of the outer edge; the rail leaves a gap for them.
        const stairAt = at(e, tc + dw / 2 - 0.7, dd);
        const g = ground.heightAt(stairAt[0] + e.nx * 1.5, stairAt[1] + e.nz * 1.5);
        const steps = Math.min(14, Math.max(0, Math.ceil((y - g) / 0.18)));
        if (steps > 0 && steps < 14) {
          rail(c1, at(e, tc + dw / 2 - 1.3, dd - 0.06));
          for (let k = 0; k < steps; k++) {
            const sp = at(e, tc + dw / 2 - 0.7, dd + 0.14 + 0.28 * k);
            batch.place("box:wood", sp[0], y - 0.09 - 0.18 * k, sp[1], e.yaw, 1.1, 0.05, 0.3);
          }
        } else rail(c1, c2);
      }

      // ---- Porch ----------------------------------------------------------------------------
      if (porchWall) {
        const e = porchWall;
        const pw = Math.min(8, e.len - 1.0);
        const pd = 2.3;
        const tc = e.len / 2;
        const ds = sink(K.deck);
        const c = at(e, tc, pd / 2);
        ds.box(c[0], y - 0.1, c[1], pw, 0.2, pd, e.tx, e.tz);
        const attach = Math.min(wallTop - 0.12, y + 3.05);
        const outerY = attach - 0.5;
        // Posts.
        const posts = Math.max(1, Math.round(pw / 2.6));
        for (let k = 0; k <= posts; k++) {
          const p = at(e, tc - pw / 2 + 0.12 + (pw - 0.24) * (k / posts), pd - 0.12);
          batch.place("box:white", p[0], (y + outerY) / 2, p[1], e.yaw, 0.14, outerY - y, 0.14);
          const g = ground.heightAt(p[0], p[1]);
          if (y - 0.2 - g > 0.05) batch.place("box:wood", p[0], (g + y - 0.2) / 2, p[1], e.yaw, 0.14, y - 0.2 - g, 0.14);
        }
        // Rail between the posts on either side of the steps.
        const gapHalf = 0.9;
        for (const side of [-1, 1]) {
          const a = at(e, tc + side * gapHalf, pd - 0.12);
          const bq = at(e, tc + side * (pw / 2 - 0.12), pd - 0.12);
          const len = Math.hypot(bq[0] - a[0], bq[1] - a[1]);
          if (len < 0.5) continue;
          ds.box((a[0] + bq[0]) / 2, y + 0.9, (a[1] + bq[1]) / 2, len, 0.06, 0.08, e.tx, e.tz);
          const bal = Math.floor(len / 0.14);
          for (let k = 1; k < bal; k++) {
            const t = k / bal;
            batch.place("box:white", a[0] + (bq[0] - a[0]) * t, y + 0.47, a[1] + (bq[1] - a[1]) * t, e.yaw, 0.035, 0.8, 0.035);
          }
          // Side rails.
          const s0 = at(e, tc + side * (pw / 2 - 0.12), 0.1);
          ds.box((s0[0] + bq[0]) / 2, y + 0.9, (s0[1] + bq[1]) / 2, 0.08, 0.06, pd - 0.22, e.tx, e.tz);
        }
        // Skirting closes the crawlspace under the porch, in the house's siding, on the three open sides.
        {
          const ss = sink(style.siding);
          const skirtQuad = (a: [number, number], bq: [number, number], out: [number, number]) => {
            const ga = ground.heightAt(a[0], a[1]) + 0.05;
            const gb = ground.heightAt(bq[0], bq[1]) + 0.05;
            const topY = y - 0.18;
            if (topY - Math.min(ga, gb) < 0.3) return;
            const len = Math.hypot(bq[0] - a[0], bq[1] - a[1]);
            ss.quad([a[0], ga, a[1]], [bq[0], gb, bq[1]], [bq[0], topY, bq[1]], [a[0], topY, a[1]], [0, ga, len, gb, len, topY, 0, topY], [out[0], 0, out[1]]);
          };
          const k0 = at(e, tc - pw / 2, 0.02);
          const k1 = at(e, tc - pw / 2, pd - 0.02);
          const k2 = at(e, tc + pw / 2, pd - 0.02);
          const k3 = at(e, tc + pw / 2, 0.02);
          skirtQuad(k0, k1, [-e.tx, -e.tz]);
          skirtQuad(k1, k2, [e.nx, e.nz]);
          skirtQuad(k2, k3, [e.tx, e.tz]);
        }
        // Steps.
        const g = ground.heightAt(c[0] + e.nx * (pd / 2 + 0.6), c[1] + e.nz * (pd / 2 + 0.6));
        const n = Math.min(10, Math.ceil((y - g) / 0.17));
        for (let k = 0; k < n; k++) {
          const sp = at(e, tc, pd + 0.17 + 0.34 * k);
          batch.place("box:wood", sp[0], y - 0.085 - 0.17 * k, sp[1], e.yaw, 1.6, 0.17, 0.36);
        }
        // Shed roof off the wall, with fascia and soffit.
        const rs = sink(style.roof.main);
        const ts = sink(style.trim);
        const ov = 0.3;
        const A = at(e, tc - pw / 2 - ov, -0.02);
        const B = at(e, tc + pw / 2 + ov, -0.02);
        const C = at(e, tc + pw / 2 + ov, pd + ov);
        const D = at(e, tc - pw / 2 - ov, pd + ov);
        rs.quad([A[0], attach + 0.04, A[1]], [B[0], attach + 0.04, B[1]], [C[0], outerY - ov * (0.5 / pd) + 0.04, C[1]], [D[0], outerY - ov * (0.5 / pd) + 0.04, D[1]], [0, 0, pw + 2 * ov, 0, pw + 2 * ov, pd + ov, 0, pd + ov], [0, 1, 0]);
        const fy = outerY - ov * (0.5 / pd);
        ts.quad([D[0], fy - 0.18, D[1]], [C[0], fy - 0.18, C[1]], [C[0], fy + 0.04, C[1]], [D[0], fy + 0.04, D[1]], [0, 0, pw, 0, pw, 0.22, 0, 0.22], [e.nx, 0, e.nz]);
        ts.quad([A[0], attach - 0.18, A[1]], [B[0], attach - 0.18, B[1]], [C[0], fy - 0.18, C[1]], [D[0], fy - 0.18, D[1]], [0, 0, pw, 0, pw, pd, 0, pd], [0, -1, 0]);
        for (const [P0, P1] of [
          [A, D],
          [B, C],
        ]) {
          ts.quad([P0[0], attach - 0.18, P0[1]], [P1[0], fy - 0.18, P1[1]], [P1[0], fy + 0.04, P1[1]], [P0[0], attach + 0.04, P0[1]], [0, 0, pd, 0, pd, 0.22, 0, 0.22], [P0 === A ? -e.tx : e.tx, 0, P0 === A ? -e.tz : e.tz]);
        }
      }

      // ---- Chimney or flue ------------------------------------------------------------------
      if (style.chimney !== "none" && area > 60 && roofKind !== "flat" && rnd() < (style.chimney === "brick" ? 0.7 : 0.6)) {
        const r = primary;
        const u = r.cu + (rnd() < 0.5 ? -1 : 1) * r.hu * 0.35;
        const v = r.cv + (rnd() < 0.5 ? -0.55 : 0.55);
        const p = toWorld(f, u, v);
        if (style.chimney === "brick") {
          const bs = sink(K.brick);
          const h = ridgeTop + 0.9 - (wallTop - 0.6);
          bs.box(p[0], wallTop - 0.6 + h / 2, p[1], 0.65, h, 0.65, f.c, f.s);
          sink(K.concrete).box(p[0], ridgeTop + 0.93, p[1], 0.8, 0.07, 0.8, f.c, f.s);
        } else {
          const h = ridgeTop + 0.9 - (wallTop - 0.3);
          batch.place("flue", p[0], wallTop - 0.3, p[1], 0, 1, h, 1);
          batch.place("flueCap", p[0], ridgeTop + 0.75, p[1], 0);
        }
      }

      // ---- The school's covered walkway and entrance -----------------------------------------
      if (era === "school") {
        const svc = nearestRoad(data, cx, cz, ["service"]);
        if (svc) {
          const dir = [svc.x - cx, svc.z - cz];
          const dl = Math.hypot(dir[0], dir[1]) || 1;
          dir[0] /= dl;
          dir[1] /= dl;
          const ts = sink(K.trimD);
          let entrance: Edge | null = null;
          for (const e of edges) {
            if (e.len < 9) continue;
            const mx = (e.ax + e.bx) / 2;
            const mz = (e.az + e.bz) / 2;
            const d = Math.hypot(mx - svc.x, mz - svc.z);
            if (e.nx * dir[0] + e.nz * dir[1] < 0.5 || d > 60) continue;
            if (!entrance || e.len > entrance.len) entrance = e;
            // Canopy: a flat slab on steel posts, 2.6 m out from the wall.
            const w = 2.6;
            const c = at(e, e.len / 2, w / 2);
            ts.box(c[0], y + 2.9, c[1], e.len - 0.4, 0.22, w + 0.3, e.tx, e.tz);
            const n = Math.max(1, Math.round(e.len / 3.6));
            for (let k = 0; k <= n; k++) {
              const p = at(e, 0.3 + (e.len - 0.6) * (k / n), w - 0.15);
              const g = ground.heightAt(p[0], p[1]);
              batch.place("box:steel", p[0], (g + y + 2.8) / 2, p[1], e.yaw, 0.15, y + 2.8 - g, 0.15);
            }
          }
          if (entrance) {
            for (const dt of [-0.55, 0.55]) {
              const p = at(entrance, entrance.len / 2 + dt, 0);
              batch.place("door:0", p[0], y, p[1], entrance.yaw);
            }
            const p = at(entrance, entrance.len / 2, 0);
            batch.place("door:frameD", p[0], y, p[1], entrance.yaw, 2.1, 1, 1);
          }
        }
      }

      footprints.push({ ring, y, h: eave, cx, cz, r: Math.max(f.w, f.d) / 2 + 1 });
    }
  });

  for (const s of sinks.values()) {
    const g = s.build();
    if (!g) continue;
    const mesh = new THREE.Mesh(g, s.mat.m);
    mesh.castShadow = s.mat !== K.ceiling && s.mat !== K.membrane;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  batch.flush(group);

  return {
    group,
    footprints,
    dispose() {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      batch.dispose();
      const seen = new Set<THREE.Material>();
      const kill = (m: Mat) => {
        if (seen.has(m.m)) return;
        seen.add(m.m);
        m.m.dispose();
        if (m.s) disposeSurface(m.s);
        const mm = m.m as THREE.MeshStandardMaterial;
        if (mm.map && !m.s) mm.map.dispose();
      };
      for (const m of [...K.lap, ...K.batten, K.cedar, K.cedarNew, K.vcedar, K.vcedarNew, K.metalSide, K.metalSideRed, K.concrete, K.brick, K.deck, K.trimW, K.trimD, K.wood, K.steel, K.membrane, K.ceiling, K.reveal, K.glass, K.glassCurtain, K.glassLit, K.glassWall, K.lamp, K.tank, ...K.doors, ...K.garage1, ...K.garage2]) kill(m);
      for (const r of Object.values(K.roofs)) {
        kill(r.main);
        if (r.moss) kill(r.moss);
      }
    },
  };
}

/** A flat cap over a ring at height y, facing up. */
function capRing(s: Sink, ring: number[][], y: number) {
  const pts = ring.map((p) => new THREE.Vector2(p[0], p[1]));
  const tris = THREE.ShapeUtils.triangulateShape(pts, []);
  for (const t of tris) {
    const a = ring[t[0]];
    const b = ring[t[1]];
    const c = ring[t[2]];
    s.tri([a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], [a[0], a[1], b[0], b[1], c[0], c[1]], [0, 1, 0]);
  }
}

/**
 * One rectangle's roof in the footprint frame: gable, hip or shed at the
 * given pitch, with the eave overhang and rake, fascia and soffit in the
 * trim colour, gable ends in the siding, gutters along the eaves and a
 * downspout at two corners. Returns the ridge height.
 */
function pitchedRoof(sink: (m: Mat) => Sink, batch: Batch, f: Frame, r: Rect, eaveY: number, pitch: number, kind: RoofKind, o: number, rake: number, roof: RoofMat, K: Kit, style: Style, rnd: () => number, gableEnds: boolean, gutterKey: string, ground: Ground): number {
  const P = (u: number, v: number, y: number): V3 => {
    const w = toWorld(f, r.cu + u, r.cv + v);
    return [w[0], y, w[1]];
  };
  const hu = r.hu;
  const hv = r.hv;
  const edgeY = eaveY - o * pitch;
  const ridgeY = eaveY + hv * pitch;
  const ts = sink(style.trim);
  const ss = sink(style.siding);
  const uAxis: V3 = [f.c, 0, f.s];
  const vAxis: V3 = [-f.s, 0, f.c];
  const slopeSink = (n: V3) => {
    const north = n[2] < -0.35;
    return sink(north && roof.moss && rnd() < 0.85 ? roof.moss : roof.main);
  };
  const slopeLen = Math.hypot(hv + o, (hv + o) * pitch);
  if (kind === "shed") {
    // High side at -v.
    const yAt = (v: number) => eaveY + (hv - v) * pitch;
    const a = P(-(hu + rake), hv + o, yAt(hv + o));
    const b = P(hu + rake, hv + o, yAt(hv + o));
    const c = P(hu + rake, -(hv + o), yAt(-(hv + o)));
    const d = P(-(hu + rake), -(hv + o), yAt(-(hv + o)));
    const n = normalOf(a, b, c);
    slopeSink(n[1] < 0 ? [-n[0], -n[1], -n[2]] : n).quad(a, b, c, d, [0, 0, 2 * (hu + rake), 0, 2 * (hu + rake), 2 * slopeLen, 0, 2 * slopeLen], [0, 1, 0]);
    // Back wall and end triangles up to the high edge.
    const high = yAt(-hv);
    ss.quad(P(-hu, -hv, eaveY), P(hu, -hv, eaveY), P(hu, -hv, high), P(-hu, -hv, high), [0, eaveY, 2 * hu, eaveY, 2 * hu, high, 0, high], [-vAxis[0], 0, -vAxis[2]]);
    for (const su of [-1, 1]) {
      ss.tri(P(su * hu, hv, eaveY), P(su * hu, -hv, eaveY), P(su * hu, -hv, high), [0, eaveY, 2 * hv, eaveY, 2 * hv, high], [su * uAxis[0], 0, su * uAxis[2]]);
      // Sloped fascia along the ends.
      const u = su * (hu + rake);
      ts.quad(P(u, hv + o, yAt(hv + o) - 0.18), P(u, -(hv + o), yAt(-(hv + o)) - 0.18), P(u, -(hv + o), yAt(-(hv + o)) + 0.03), P(u, hv + o, yAt(hv + o) + 0.03), [0, 0, 2 * hv, 0, 2 * hv, 0.2, 0, 0.2], [su * uAxis[0], 0, su * uAxis[2]]);
    }
    for (const sv of [-1, 1]) {
      const v = sv * (hv + o);
      const yy = yAt(v);
      ts.quad(P(-(hu + rake), v, yy - 0.18), P(hu + rake, v, yy - 0.18), P(hu + rake, v, yy + 0.03), P(-(hu + rake), v, yy + 0.03), [0, 0, 2 * hu, 0, 2 * hu, 0.2, 0, 0.2], [sv * vAxis[0], 0, sv * vAxis[2]]);
    }
    return high;
  }
  if (kind === "hip") {
    const rh = Math.max(0, hu - hv);
    const cA = P(-(hu + o), -(hv + o), edgeY);
    const cB = P(hu + o, -(hv + o), edgeY);
    const cC = P(hu + o, hv + o, edgeY);
    const cD = P(-(hu + o), hv + o, edgeY);
    const rA = P(-rh, 0, ridgeY);
    const rB = P(rh, 0, ridgeY);
    const s1 = normalOf(cA, cB, rB);
    slopeSink(s1[1] < 0 ? [-s1[0], -s1[1], -s1[2]] : s1).quad(cA, cB, rB, rA, [0, 0, 2 * (hu + o), 0, 2 * (hu + o) - (hv + o), slopeLen, hv + o, slopeLen], [0, 1, 0]);
    const s2 = normalOf(cC, cD, rA);
    slopeSink(s2[1] < 0 ? [-s2[0], -s2[1], -s2[2]] : s2).quad(cC, cD, rA, rB, [0, 0, 2 * (hu + o), 0, 2 * (hu + o) - (hv + o), slopeLen, hv + o, slopeLen], [0, 1, 0]);
    const e1 = normalOf(cB, cC, rB);
    slopeSink(e1[1] < 0 ? [-e1[0], -e1[1], -e1[2]] : e1).tri(cB, cC, rB, [0, 0, 2 * (hv + o), 0, hv + o, slopeLen], [0, 1, 0]);
    const e2 = normalOf(cD, cA, rA);
    slopeSink(e2[1] < 0 ? [-e2[0], -e2[1], -e2[2]] : e2).tri(cD, cA, rA, [0, 0, 2 * (hv + o), 0, hv + o, slopeLen], [0, 1, 0]);
    // Fascia and soffit all round.
    const sides: [V3, V3, V3][] = [
      [cA, cB, [-vAxis[0], 0, -vAxis[2]]],
      [cB, cC, uAxis],
      [cC, cD, vAxis],
      [cD, cA, [-uAxis[0], 0, -uAxis[2]]],
    ];
    for (const [a, b, n] of sides) {
      const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
      ts.quad([a[0], edgeY - 0.18, a[2]], [b[0], edgeY - 0.18, b[2]], [b[0], edgeY + 0.03, b[2]], [a[0], edgeY + 0.03, a[2]], [0, 0, len, 0, len, 0.21, 0, 0.21], n);
      const ai: V3 = [a[0] - n[0] * o, edgeY - 0.18, a[2] - n[2] * o];
      const bi: V3 = [b[0] - n[0] * o, edgeY - 0.18, b[2] - n[2] * o];
      ts.quad([a[0], edgeY - 0.18, a[2]], [b[0], edgeY - 0.18, b[2]], bi, ai, [0, 0, len, 0, len, o, 0, o], [0, -1, 0]);
      if (style.gutters) {
        const mx = (a[0] + b[0]) / 2 + n[0] * 0.07;
        const mz = (a[2] + b[2]) / 2 + n[2] * 0.07;
        batch.place(gutterKey, mx, edgeY - 0.08, mz, Math.atan2(b[0] - a[0], b[2] - a[2]), 0.11, 0.1, len);
      }
    }
    if (style.gutters) downspouts(batch, f, r, hu, hv, edgeY, gutterKey, ground);
    return ridgeY;
  }
  // Gable: ridge along u, slopes to +v and -v, gable ends at +u and -u.
  const rA = P(-(hu + rake), 0, ridgeY);
  const rB = P(hu + rake, 0, ridgeY);
  for (const sv of [-1, 1]) {
    const a = P(-(hu + rake), sv * (hv + o), edgeY);
    const b = P(hu + rake, sv * (hv + o), edgeY);
    const n = normalOf(a, b, rB);
    slopeSink(n[1] < 0 ? [-n[0], -n[1], -n[2]] : n).quad(a, b, rB, rA, [0, 0, 2 * (hu + rake), 0, 2 * (hu + rake), slopeLen, 0, slopeLen], [0, 1, 0]);
    // Eave fascia, soffit, gutter.
    const nn: V3 = [sv * vAxis[0], 0, sv * vAxis[2]];
    ts.quad([a[0], edgeY - 0.18, a[2]], [b[0], edgeY - 0.18, b[2]], [b[0], edgeY + 0.03, b[2]], [a[0], edgeY + 0.03, a[2]], [0, 0, 2 * (hu + rake), 0, 2 * (hu + rake), 0.21, 0, 0.21], nn);
    const ai = P(-(hu + rake), sv * hv, edgeY - 0.18);
    const bi = P(hu + rake, sv * hv, edgeY - 0.18);
    ts.quad([a[0], edgeY - 0.18, a[2]], [b[0], edgeY - 0.18, b[2]], bi, ai, [0, 0, 2 * (hu + rake), 0, 2 * (hu + rake), o, 0, o], [0, -1, 0]);
    if (style.gutters) {
      const mx = (a[0] + b[0]) / 2 + nn[0] * 0.07;
      const mz = (a[2] + b[2]) / 2 + nn[2] * 0.07;
      batch.place(gutterKey, mx, edgeY - 0.08, mz, Math.atan2(b[0] - a[0], b[2] - a[2]), 0.11, 0.1, 2 * (hu + rake));
    }
  }
  for (const su of [-1, 1]) {
    const nn: V3 = [su * uAxis[0], 0, su * uAxis[2]];
    if (gableEnds) {
      // The gable end in siding, its courses continuing the wall's.
      ss.tri(P(su * hu, -hv, eaveY - 0.02), P(su * hu, hv, eaveY - 0.02), P(su * hu, 0, ridgeY), [0, eaveY, 2 * hv, eaveY, hv, ridgeY], nn);
    }
    // Rake boards along the sloped edges and the soffit under the rake overhang.
    const u = su * (hu + rake);
    for (const sv of [-1, 1]) {
      const lo = P(u, sv * (hv + o), edgeY);
      const hi = P(u, 0, ridgeY);
      ts.quad([lo[0], lo[1] - 0.2, lo[2]], [hi[0], hi[1] - 0.2, hi[2]], [hi[0], hi[1] + 0.03, hi[2]], [lo[0], lo[1] + 0.03, lo[2]], [0, 0, slopeLen, 0, slopeLen, 0.23, 0, 0.23], nn);
      const loI = P(su * hu, sv * (hv + o), edgeY - 0.2);
      const hiI = P(su * hu, 0, ridgeY - 0.2);
      ts.quad([lo[0], lo[1] - 0.2, lo[2]], [hi[0], hi[1] - 0.2, hi[2]], hiI, loI, [0, 0, slopeLen, 0, slopeLen, rake, 0, rake], [0, -1, 0]);
    }
  }
  if (style.gutters) downspouts(batch, f, r, hu, hv, edgeY, gutterKey, ground);
  return ridgeY;
}

function downspouts(batch: Batch, f: Frame, r: Rect, hu: number, hv: number, edgeY: number, key: string, ground: Ground) {
  for (const [su, sv] of [
    [-1, 1],
    [1, -1],
  ]) {
    const p = toWorld(f, r.cu + su * (hu - 0.2), r.cv + sv * (hv + 0.09));
    const g = ground.heightAt(p[0], p[1]);
    const top = edgeY - 0.12;
    if (top - g < 1) continue;
    batch.place(key, p[0], (g + top) / 2, p[1], 0, 0.08, top - g, 0.08);
  }
}
