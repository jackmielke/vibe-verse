/**
 * What is at the edge of the road: a rural mailbox for every house, on the
 * right of its driveway with the real number on the side, the county's
 * green blades and a STOP at every junction, speed limits, the school zone,
 * wooden power poles carrying three phases and a telecom line with a service
 * drop to each house, the mapped fences, hedges and gates, the hydrant, and
 * the clutter that makes a road look lived on: carts out on pickup day, a
 * boat on a trailer, a hoop at the top of a drive, a trampoline in a yard.
 *
 * Everything here is placed from the data (driveway ends, mapped poles,
 * mapped points) and where the data is silent it is decided by a seeded RNG,
 * so the same neighbourhood comes out every time. Repeated things are
 * instanced through `Batch`; everything printed shares one atlas.
 */
import * as THREE from "three";
import { lines, mulberry32, nearestOnLine, orientedBox, point, pointInRing, polyLength, resample, rings, roadWidth, signName, type Building, type Neighbourhood } from "./geo";
import type { Ground } from "./terrain";
import { backFace, bladeFace, boardFace, busStopFace, digitsFace, dogFace, flagFace, noticeFace, plaqueFace, schoolFace, SignAtlas, SignQuads, speedFace, stopFace, warningFace, type Cell } from "./street.atlas";
import {
  ARM_HALF,
  ARM_Y,
  Batch,
  bench,
  boardPosts,
  boardTexture,
  boatOnTrailer,
  bollard,
  busShelter,
  cart,
  cellTower,
  crossarm,
  DROP_Y,
  dumpster,
  farmGate,
  fencePost,
  fieldMesh,
  flagpole,
  guyAnchor,
  hedgeBlock,
  hoop,
  hydrant,
  lampPost,
  logBench,
  mailboxBody,
  mailboxFlag,
  mailboxMount,
  NEUTRAL_Y,
  padTransformer,
  paperTube,
  PIN_Y,
  POLE_H,
  poleGeometry,
  poleTexture,
  pose,
  propaneTank,
  propMaterials,
  rail,
  signPost,
  TELECOM_Y,
  tPost,
  trampoline,
  transformerCan,
  wheelbarrow,
  woodGate,
} from "./street.props";

export interface Street {
  group: THREE.Group;
  dispose(): void;
}

type Line = { l: number[][]; r: Neighbourhood["roads"][number] };
type Pt = { x: number; z: number };

const UP = new THREE.Vector3(0, 1, 0);
const MAIN = ["secondary", "tertiary", "residential"];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

export function buildStreet(data: Neighbourhood, ground: Ground): Street {
  const group = new THREE.Group();
  const rnd = mulberry32(4242);
  const atlas = new SignAtlas(2048, 4096);
  const quads = new SignQuads();
  const mats = propMaterials();
  const batch = new Batch(mats);
  const wirePos: number[] = [];
  const disposables: (THREE.Material | THREE.Texture | THREE.BufferGeometry)[] = [];
  const H = (x: number, z: number) => ground.heightAt(x, z);

  const mainLines: Line[] = data.roads.filter((r) => MAIN.includes(r.cls)).flatMap((r) => lines(r.g).map((l) => ({ l, r })));
  const allLines: Line[] = data.roads.flatMap((r) => lines(r.g).map((l) => ({ l, r })));
  const serviceLines: Line[] = data.roads.filter((r) => r.cls === "service").flatMap((r) => lines(r.g).map((l) => ({ l, r })));
  const nearestMain = (x: number, z: number) => {
    let best: { d: number; x: number; z: number; tx: number; tz: number; line: Line } | null = null;
    for (const ml of mainLines) {
      const n = nearestOnLine(x, z, ml.l);
      if (!best || n.d < best.d) best = { ...n, line: ml };
    }
    return best!;
  };
  const nearestAny = (x: number, z: number) => {
    let best: { d: number; x: number; z: number; tx: number; tz: number; line: Line } | null = null;
    for (const ml of allLines) {
      const n = nearestOnLine(x, z, ml.l);
      if (!best || n.d < best.d) best = { ...n, line: ml };
    }
    return best!;
  };
  const roadDist = (x: number, z: number) => nearestAny(x, z).d;

  // The props, built once each.
  const P = {
    mount: mailboxMount(),
    body: mailboxBody(),
    flagDown: mailboxFlag(false),
    flagUp: mailboxFlag(true),
    tube: paperTube(),
    cart: cart(),
    boat: boatOnTrailer(),
    hoop: hoop(),
    barrowGreen: wheelbarrow(0x2f5f3a),
    barrowRust: wheelbarrow(0x8a4a2a),
    tramp: trampoline(),
    hydrant: hydrant(),
    tank: propaneTank(),
    pad: padTransformer(),
    dumpster: dumpster(),
    arm: crossarm(),
    can: transformerCan(),
    anchor: guyAnchor(),
    post: signPost(),
    fencePost: fencePost(),
    rail: rail(),
    hedge: hedgeBlock(),
    tPost: tPost(),
    mesh: fieldMesh(),
    farmGate: farmGate(),
    woodGate: woodGate(),
    bench: bench(),
    log: logBench(),
    shelter: busShelter(),
    board: boardPosts(),
    flagpole: flagpole(),
    lamp: lampPost(),
    bollard: bollard(),
    tower: cellTower(),
  };

  // ---- Sign helpers ---------------------------------------------------------------
  type Face = { cell: Cell; back?: Cell; w: number; h: number; mirrorBack?: boolean; along?: [number, number] };
  /** A post at x,z with faces stacked from `top` down. `facing` is the normal of the printed side. */
  function sign(x: number, z: number, facing: [number, number], faces: Face[], top = 2.9): void {
    const y = H(x, z);
    batch.add(P.post, pose(x, y, z, Math.atan2(facing[0], facing[1]), 1, top, 1));
    let yTop = top;
    for (const f of faces) {
      const fx = f.along ? f.along[0] : facing[0];
      const fz = f.along ? f.along[1] : facing[1];
      // A blade lies along its road; anything else faces the traffic.
      const n = f.along ? new THREE.Vector3(-fz, 0, fx) : new THREE.Vector3(fx, 0, fz);
      const right = new THREE.Vector3().crossVectors(UP, n);
      const c = new THREE.Vector3(x + n.x * 0.04, y + yTop - f.h / 2, z + n.z * 0.04);
      if (f.back) quads.addTwoSided(c, right, UP, f.w, f.h, f.cell, f.back, !!f.mirrorBack);
      else quads.add(c, right, UP, f.w, f.h, f.cell);
      yTop -= f.h + 0.06;
    }
  }
  const stopCell = stopFace(atlas);
  const backOct = backFace(atlas, "oct");
  const backRect = backFace(atlas, "rect");
  const backDiamond = backFace(atlas, "diamond");
  const backPent = backFace(atlas, "pent");
  const blade = (name: string, along: [number, number]): Face => {
    const cell = bladeFace(atlas, signName(name));
    return { cell, back: cell, w: 0.95, h: 0.24, mirrorBack: true, along };
  };

  // ---- Driveway gates: where a drive meets a county road ----------------------------
  interface Gate {
    rx: number;
    rz: number;
    tx: number;
    tz: number;
    dx: number;
    dz: number;
    halfW: number;
    line: number[][];
    far: number[];
    addrs: { n: string; d: number }[];
  }
  const gates: Gate[] = [];
  const gateOf = new Map<number[][], Gate>();
  for (const s of serviceLines) {
    if (polyLength(s.l) < 6) continue;
    for (const end of [s.l[0], s.l[s.l.length - 1]]) {
      const n = nearestMain(end[0], end[1]);
      if (n.d > 12) continue;
      const far = end === s.l[0] ? s.l[Math.min(2, s.l.length - 1)] : s.l[Math.max(0, s.l.length - 3)];
      let dx = far[0] - n.x;
      let dz = far[1] - n.z;
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl;
      dz /= dl;
      // A drive that runs along the road rather than off it is a lane, not a driveway.
      if (Math.abs(dx * n.tx + dz * n.tz) > 0.85) continue;
      if (gates.some((g) => Math.hypot(g.rx - n.x, g.rz - n.z) < 5)) continue;
      const g: Gate = { rx: n.x, rz: n.z, tx: n.tx, tz: n.tz, dx, dz, halfW: roadWidth(n.line.r.cls) / 2, line: s.l, far: end === s.l[0] ? s.l[s.l.length - 1] : s.l[0], addrs: [] };
      gates.push(g);
      gateOf.set(s.l, g);
    }
  }
  // Which drives touch which: a house on a shared drive gets its box at the road.
  const touches = (a: number[][], b: number[][]) => {
    for (const e of [a[0], a[a.length - 1]]) if (nearestOnLine(e[0], e[1], b).d < 3) return true;
    for (const e of [b[0], b[b.length - 1]]) if (nearestOnLine(e[0], e[1], a).d < 3) return true;
    return false;
  };
  const adjacent = new Map<number[][], number[][][]>();
  for (let i = 0; i < serviceLines.length; i++) {
    for (let j = i + 1; j < serviceLines.length; j++) {
      const a = serviceLines[i].l;
      const b = serviceLines[j].l;
      if (!touches(a, b)) continue;
      (adjacent.get(a) ?? adjacent.set(a, []).get(a)!).push(b);
      (adjacent.get(b) ?? adjacent.set(b, []).get(b)!).push(a);
    }
  }
  const gateFor = (line: number[][]): Gate | null => {
    const seen = new Set<number[][]>([line]);
    let frontier = [line];
    for (let depth = 0; depth < 4 && frontier.length; depth++) {
      const next: number[][][] = [];
      for (const l of frontier) {
        const g = gateOf.get(l);
        if (g) return g;
        for (const s of adjacent.get(l) ?? []) if (!seen.has(s)) (seen.add(s), next.push(s));
      }
      frontier = next;
    }
    return null;
  };
  const beckDrive = new Map<string, Gate>();
  for (const a of data.addresses) {
    const p = point(a.g);
    if (!p) continue;
    let best: { d: number; l: number[][] } | null = null;
    for (const s of serviceLines) {
      const n = nearestOnLine(p[0], p[1], s.l);
      if (n.d < 35 && (!best || n.d < best.d)) best = { d: n.d, l: s.l };
    }
    let g = best ? gateFor(best.l) : null;
    if (!g) {
      // No mapped drive: the nearest gate within 60 m, else the road edge if the house fronts it.
      let bd = 60;
      for (const c of gates) {
        const d = Math.hypot(c.rx - p[0], c.rz - p[1]);
        if (d < bd) (bd = d), (g = c);
      }
    }
    if (!g) {
      const n = nearestMain(p[0], p[1]);
      if (n.d < 28) {
        const side = Math.sign((p[0] - n.x) * -n.tz + (p[1] - n.z) * n.tx) || 1;
        const dx = -n.tz * side;
        const dz = n.tx * side;
        g = { rx: n.x, rz: n.z, tx: n.tx, tz: n.tz, dx, dz, halfW: roadWidth(n.line.r.cls) / 2, line: [[n.x, n.z], p], far: p, addrs: [] };
        gates.push(g);
      }
    }
    if (!g) continue;
    g.addrs.push({ n: a.n, d: Math.hypot(g.rx - p[0], g.rz - p[1]) });
    if (a.st && a.st.toUpperCase().includes("BECK")) beckDrive.set(a.n, g);
  }

  // ---- Mailboxes ------------------------------------------------------------------------
  const BOX_COLOURS: [THREE.ColorRepresentation, boolean][] = [
    [0x141414, true],
    [0x141414, true],
    [0x141414, true],
    [0x1a1a1a, true],
    [0x9da3a6, false],
    [0x9da3a6, false],
    [0x2b4a33, true],
    [0xe6e6e0, false],
  ];
  for (const g of gates) {
    if (!g.addrs.length) continue;
    const boxes = g.addrs.sort((a, b) => a.d - b.d).slice(0, 4);
    const rightX = -g.dz;
    const rightZ = g.dx;
    const cx = g.rx + g.dx * (g.halfW + 1.0) + rightX * (roadWidth("service") / 2 + 0.6);
    const cz = g.rz + g.dz * (g.halfW + 1.0) + rightZ * (roadWidth("service") / 2 + 0.6);
    const yaw = Math.atan2(-g.dx, -g.dz);
    const n = boxes.length;
    const pitch = 0.32;
    if (n > 1) {
      // Two or three boxes on one rail between a pair of posts.
      const span = (n - 1) * pitch + 0.5;
      for (const s of [-1, 1]) {
        const px = cx + rightX * s * (span / 2);
        const pz = cz + rightZ * s * (span / 2);
        batch.add(P.fencePost, pose(px, H(px, pz), pz, yaw, 0.8, 1.02, 0.8));
      }
      const ax = cx - rightX * (span / 2);
      const az = cz - rightZ * (span / 2);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(ax, H(cx, cz) + 1.0, az), new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(rightX, rightZ)), new THREE.Vector3(1.6, 0.6, span));
      batch.add(P.rail, m);
    }
    boxes.forEach((b, i) => {
      const off = (i - (n - 1) / 2) * pitch;
      const bx = cx + rightX * off;
      const bz = cz + rightZ * off;
      const y = H(cx, cz);
      const m = pose(bx, y, bz, yaw);
      if (n === 1) batch.add(P.mount, m);
      const [colour, dark] = BOX_COLOURS[Math.floor(rnd() * BOX_COLOURS.length)];
      batch.add(P.body, m, colour);
      batch.add(rnd() < 0.15 ? P.flagUp : P.flagDown, m);
      if (n === 1 && rnd() < 0.35) batch.add(P.tube, m);
      // Digits on both long sides, reading toward the road on each.
      const cell = digitsFace(atlas, b.n, dark);
      for (const s of [-1, 1]) {
        // Outward normal (rightX, rightZ) * s; the quad's normal is right x up, so right = (dx, dz) * s.
        const nx = rightX * s;
        const nz = rightZ * s;
        const c = new THREE.Vector3(bx + nx * 0.096, y + 1.15, bz + nz * 0.096);
        const right = new THREE.Vector3(g.dx * s, 0, g.dz * s);
        quads.add(c, right, UP, 0.3, 0.075, cell);
      }
    });
  }

  // ---- Carts on pickup day, and the top-of-the-drive clutter ---------------------------------
  const barrowTaken: Gate[] = [];
  const hoopGates = new Set<Gate>();
  const beck8368 = beckDrive.get("8368");
  if (beck8368) hoopGates.add(beck8368);
  for (const g of gates) {
    if (!g.addrs.length) continue;
    const leftX = g.dz;
    const leftZ = -g.dx;
    if (rnd() < 0.4) {
      const bx = g.rx + g.dx * (g.halfW + 1.1) + leftX * 1.7;
      const bz = g.rz + g.dz * (g.halfW + 1.1) + leftZ * 1.7;
      const yaw = Math.atan2(-g.dx, -g.dz) + (rnd() - 0.5) * 0.5;
      batch.add(P.cart, pose(bx, H(bx, bz), bz, yaw), 0x4a4d50);
      if (rnd() < 0.65) {
        const rx = bx + leftX * 0.75;
        const rz = bz + leftZ * 0.75;
        batch.add(P.cart, pose(rx, H(rx, rz), rz, yaw + (rnd() - 0.5) * 0.4), 0x1f5fae);
      }
    }
    if (rnd() < 0.045) hoopGates.add(g);
    if (rnd() < 0.03 && barrowTaken.length < 4) barrowTaken.push(g);
  }
  // At the top of the drive: the last leg of the driveway, where it meets the house.
  const topOfDrive = (g: Gate) => {
    const l = g.line;
    const far = g.far;
    const prev = far === l[0] ? l[Math.min(1, l.length - 1)] : l[Math.max(0, l.length - 2)];
    let dx = far[0] - prev[0];
    let dz = far[1] - prev[1];
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    return { x: far[0], z: far[1], dx, dz };
  };
  for (const g of hoopGates) {
    const t = topOfDrive(g);
    const x = t.x - t.dx * 3 + t.dz * 2.4;
    const z = t.z - t.dz * 3 - t.dx * 2.4;
    // Faces the drive.
    batch.add(P.hoop, pose(x, H(x, z), z, Math.atan2(-t.dz, t.dx)));
  }
  barrowTaken.forEach((g, i) => {
    const t = topOfDrive(g);
    const x = t.x - t.dx * 2 - t.dz * 3.5;
    const z = t.z - t.dz * 2 + t.dx * 3.5;
    batch.add(i % 2 ? P.barrowRust : P.barrowGreen, pose(x, H(x, z), z, rnd() * Math.PI * 2));
  });
  const houses = data.buildings.filter((b) => !["shed", "greenhouse", "roof", "storage_tank", "school", "church", "industrial"].includes(b.cls || "") && rings(b.g).length);
  const inFootprint = (x: number, z: number) => houses.some((b) => rings(b.g).some((r) => pointInRing(x, z, r)));
  // The boat lives at 8330, parked in the yard between the house and Beck Road, bow to the trees.
  const home = point(data.addresses.find((a) => a.n === "8330" && (a.st || "").toUpperCase().includes("BECK"))?.g ?? { t: "pt", c: [0, 0] })!;
  {
    const n = nearestMain(home[0], home[1]);
    let tx = n.x - home[0];
    let tz = n.z - home[1];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    for (const side of [1, -1]) {
      const x = home[0] + tx * tl * 0.5 + -tz * side * 9;
      const z = home[1] + tz * tl * 0.5 + tx * side * 9;
      if (inFootprint(x, z) || roadDist(x, z) < 5) continue;
      batch.add(P.boat, pose(x, H(x, z), z, Math.atan2(-tx, -tz) + 0.35));
      break;
    }
  }

  // ---- Trampolines: behind a house, on grass, off every road and footprint ---------------------
  let tramps = 0;
  for (let i = 0; i < houses.length && tramps < 3; i++) {
    const b = houses[Math.floor(rnd() * houses.length)];
    const c = point(b.g)!;
    const n = nearestMain(c[0], c[1]);
    if (n.d > 90) continue;
    let ax = c[0] - n.x;
    let az = c[1] - n.z;
    const al = Math.hypot(ax, az) || 1;
    ax /= al;
    az /= al;
    const x = c[0] + ax * 13;
    const z = c[1] + az * 13;
    if (inFootprint(x, z) || roadDist(x, z) < 6) continue;
    batch.add(P.tramp, pose(x, H(x, z), z, rnd() * Math.PI));
    tramps++;
  }

  // ---- Intersections: blades, stop signs, dead ends ---------------------------------------------
  const rank = (c: string) => (c === "secondary" ? 3 : c === "tertiary" ? 2 : 1);
  const placed: number[][] = [];
  const freeEnd = (a: Line, end: number[]) => !mainLines.some((b) => b !== a && b.r.name !== a.r.name && nearestOnLine(end[0], end[1], b.l).d < 3) && !mainLines.some((b) => b !== a && b.r.name === a.r.name && (Math.hypot(b.l[0][0] - end[0], b.l[0][1] - end[1]) < 1 || Math.hypot(b.l[b.l.length - 1][0] - end[0], b.l[b.l.length - 1][1] - end[1]) < 1));
  const sameRoad = (a: string | null, b: string | null) => {
    if (!a || !b) return true;
    if (a === b) return true;
    const fa = a.split(" ")[0];
    const fb = b.split(" ")[0];
    return a === fb || b === fa;
  };
  const deadEnds = new Set<string>();
  for (const a of mainLines) {
    if (!a.r.name || a.r.cls === "secondary") continue;
    for (const end of [a.l[0], a.l[a.l.length - 1]]) if (freeEnd(a, end)) deadEnds.add(a.r.name);
  }
  // A junction is every place a line of one road ends on a line of another. Where two roads of
  // equal class cross, the one the neighbourhood treats as the through road (Beck) gets the right of way.
  const priority = (l: Line) => rank(l.r.cls) + ((l.r.name || "").toLowerCase().includes("beck road") ? 0.5 : 0);
  type Junction = { a: Line; b: Line; end: number[]; n: { tx: number; tz: number } };
  const junctions: Junction[] = [];
  for (const a of mainLines) {
    for (const end of [a.l[0], a.l[a.l.length - 1]]) {
      for (const b of mainLines) {
        if (b === a || sameRoad(a.r.name, b.r.name)) continue;
        const n = nearestOnLine(end[0], end[1], b.l);
        if (n.d > 3) continue;
        junctions.push({ a, b, end, n });
      }
    }
  }
  // Interior junctions per road, for the dead-end rule: a court has one junction and a free end.
  const junctionCount = new Map<string, number>();
  for (const j of junctions) {
    for (const nm of [j.a.r.name, j.b.r.name]) {
      if (!nm) continue;
      if (placed.some((p) => Math.hypot(p[0] - j.end[0], p[1] - j.end[1]) < 10 && p[2] === hash(nm))) continue;
      placed.push([j.end[0], j.end[1], hash(nm)]);
      junctionCount.set(nm, (junctionCount.get(nm) ?? 0) + 1);
    }
  }
  placed.length = 0;
  junctions.sort((p, q) => priority(p.a) - priority(q.a));
  for (const j of junctions) {
    const { a, b, end, n } = j;
    if (placed.some((p) => Math.hypot(p[0] - end[0], p[1] - end[1]) < 10)) continue;
    placed.push(end);
    // dir: from the junction into a. The approaching driver on a travels -dir and keeps right.
    const nxt = end === a.l[0] ? a.l[1] : a.l[a.l.length - 2];
    let dx = nxt[0] - end[0];
    let dz = nxt[1] - end[1];
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    const rightX = dz;
    const rightZ = -dx;
    const x = end[0] + dx * (roadWidth(b.r.cls) / 2 + 2.0) + rightX * (roadWidth(a.r.cls) / 2 + 1.2);
    const z = end[1] + dz * (roadWidth(b.r.cls) / 2 + 2.0) + rightZ * (roadWidth(a.r.cls) / 2 + 1.2);
    const faces: Face[] = [];
    if (b.r.name) faces.push(blade(b.r.name, [n.tx, n.tz]));
    if (a.r.name) faces.push(blade(a.r.name, [dx, dz]));
    const stop = priority(b) >= priority(a);
    if (stop) faces.push({ cell: stopCell, back: backOct, w: 0.76, h: 0.76 });
    if (a.r.name && deadEnds.has(a.r.name) && (junctionCount.get(a.r.name) ?? 0) <= 1) faces.push({ cell: warningFace(atlas, ["DEAD", "END"]), back: backDiamond, w: 0.76, h: 0.76 });
    sign(x, z, [dx, dz], faces, stop ? 3.35 : 2.75);
  }

  // ---- Private roads and no outlets at the longer driveways -------------------------------------
  for (const g of gates) {
    const len = polyLength(g.line);
    if (len < 110 || g.addrs.length < 2) continue;
    const rightX = -g.dz;
    const rightZ = g.dx;
    const x = g.rx + g.dx * (g.halfW + 1.6) + rightX * (roadWidth("service") / 2 + 1.6);
    const z = g.rz + g.dz * (g.halfW + 1.6) + rightZ * (roadWidth("service") / 2 + 1.6);
    const priv = hash(g.line[0].join(",")) < 0.5;
    const face: Face = priv ? { cell: noticeFace(atlas, ["PRIVATE", "ROAD"]), back: backRect, w: 0.45, h: 0.6 } : { cell: warningFace(atlas, ["NO", "OUTLET"]), back: backDiamond, w: 0.6, h: 0.6 };
    sign(x, z, [-g.dx, -g.dz], [face], 2.3);
  }

  // ---- Speed limits: 25 on the county roads, 35 on Blakely ----------------------------------------
  const speedAt: { x: number; z: number; name: string }[] = [];
  for (const ml of mainLines) {
    if (!ml.r.name) continue;
    const len = polyLength(ml.l);
    if (len < 140) continue;
    const mph = ml.r.cls === "secondary" ? 35 : 25;
    const pts = resample(ml.l, 1);
    for (const s of [45, len - 45]) {
      const p = pts[Math.min(pts.length - 1, Math.round(s))];
      if (speedAt.some((q) => q.name === ml.r.name && Math.hypot(q.x - p.x, q.z - p.z) < 120)) continue;
      // Traffic entering from this end travels away from it; the sign faces them, on their right.
      const fwd = s === 45 ? [p.tx, p.tz] : [-p.tx, -p.tz];
      const rightX = -fwd[1];
      const rightZ = fwd[0];
      const x = p.x + rightX * (roadWidth(ml.r.cls) / 2 + 1.5);
      const z = p.z + rightZ * (roadWidth(ml.r.cls) / 2 + 1.5);
      speedAt.push({ x, z, name: ml.r.name });
      sign(x, z, [-fwd[0], -fwd[1]], [{ cell: speedFace(atlas, mph), back: backRect, w: 0.6, h: 0.76 }], 2.9);
    }
  }

  // ---- Crossings: painted bars, a walker sign each way, and the school zone on Blakely ------------
  const barPos: number[] = [];
  const barIdx: number[] = [];
  const crossings = data.infra.filter((f) => f.cls === "crossing").map((f) => point(f.g)!).filter(Boolean);
  const schoolPt = point(data.places.find((p) => (p.name || "").toLowerCase().includes("elementary"))?.g ?? { t: "pt", c: [282, -660] })!;
  let schoolCrossing: { x: number; z: number; line: Line } | null = null;
  const nearestDrivable = (x: number, z: number) => {
    let best: { d: number; x: number; z: number; tx: number; tz: number; line: Line } | null = null;
    for (const ml of allLines) {
      if (["footway", "path", "track"].includes(ml.r.cls)) continue;
      const n = nearestOnLine(x, z, ml.l);
      if (!best || n.d < best.d) best = { ...n, line: ml };
    }
    return best!;
  };
  for (const c of crossings) {
    const n = nearestDrivable(c[0], c[1]);
    if (n.d > 8) continue;
    const w = roadWidth(n.line.r.cls);
    const nx = -n.tz;
    const nz = n.tx;
    for (const off of [-0.9, -0.3, 0.3, 0.9]) {
      const v = barPos.length / 3;
      for (const [a, b] of [
        [-0.2, -1],
        [0.2, -1],
        [0.2, 1],
        [-0.2, 1],
      ]) {
        const x = n.x + n.tx * (off + a) + nx * b * (w / 2 - 0.25);
        const z = n.z + n.tz * (off + a) + nz * b * (w / 2 - 0.25);
        barPos.push(x, H(x, z) + 0.078, z);
      }
      barIdx.push(v, v + 2, v + 1, v, v + 3, v + 2);
    }
    if (!MAIN.includes(n.line.r.cls)) continue;
    if (Math.hypot(c[0] - schoolPt[0], c[1] - schoolPt[1]) < 220 && !schoolCrossing) schoolCrossing = { x: n.x, z: n.z, line: n.line };
    for (const s of [-1, 1]) {
      // The sign faces traffic travelling -f, which arrives from the +f side and keeps right.
      const fx = n.tx * s;
      const fz = n.tz * s;
      const rightX = fz;
      const rightZ = -fx;
      const x = n.x + fx * 1.5 + rightX * (w / 2 + 1.4);
      const z = n.z + fz * 1.5 + rightZ * (w / 2 + 1.4);
      sign(x, z, [fx, fz], [{ cell: schoolFace(atlas, "WALK"), back: backPent, w: 0.76, h: 0.76 }, { cell: plaqueFace(atlas, ["ARROW"], "#c8f000"), back: backRect, w: 0.5, h: 0.32 }], 2.9);
    }
  }
  // The school zone is signed on the road the school fronts, either side of its crossing.
  const frontage = mainLines.filter((m) => m.r.cls === "secondary").sort((p, q) => nearestOnLine(schoolPt[0], schoolPt[1], p.l).d - nearestOnLine(schoolPt[0], schoolPt[1], q.l).d)[0];
  if (schoolCrossing && frontage) {
    const ml = frontage;
    const pts = resample(ml.l, 1);
    let k0 = 0;
    let kd = Infinity;
    pts.forEach((p, i) => {
      const d = Math.hypot(p.x - schoolCrossing!.x, p.z - schoolCrossing!.z);
      if (d < kd) (kd = d), (k0 = i);
    });
    for (const s of [-1, 1]) {
      const k = Math.max(0, Math.min(pts.length - 1, k0 + s * 150));
      if (Math.abs(k - k0) < 60) continue;
      const p = pts[k];
      // Traffic at k travelling toward the crossing moves in direction -s * tangent.
      const fwd = [-p.tx * s, -p.tz * s];
      const rightX = -fwd[1];
      const rightZ = fwd[0];
      const w = roadWidth(ml.r.cls);
      const x = p.x + rightX * (w / 2 + 1.5);
      const z = p.z + rightZ * (w / 2 + 1.5);
      sign(x, z, [-fwd[0], -fwd[1]], [{ cell: schoolFace(atlas, "SCHOOL"), back: backPent, w: 0.76, h: 0.76 }, { cell: plaqueFace(atlas, ["SPEED LIMIT 20", "WHEN CHILDREN", "ARE PRESENT"], "#f6f6f0"), back: backRect, w: 0.6, h: 0.42 }], 3.1);
    }
  }
  if (barPos.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(barPos, 3));
    geo.setIndex(barIdx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0xe8e6dc, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    disposables.push(geo, mat);
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 5;
    m.receiveShadow = true;
    group.add(m);
  }

  // ---- The school bus loop and the transit stops ------------------------------------------------
  const loop = serviceLines.filter((s) => s.l.length > 12 && s.l.some((p) => Math.hypot(p[0] - schoolPt[0], p[1] - schoolPt[1]) < 140)).sort((a, b) => polyLength(b.l) - polyLength(a.l))[0];
  if (loop) {
    const pts = resample(loop.l, 1);
    for (const f of [0.2, 0.5, 0.8]) {
      const p = pts[Math.floor(pts.length * f)];
      const x = p.x + -p.tz * 2.6;
      const z = p.z + p.tx * 2.6;
      sign(x, z, [p.tz, -p.tx], [{ cell: noticeFace(atlas, ["BUS", "LOADING", "ZONE", "NO PARKING"], "#b01e23"), back: backRect, w: 0.45, h: 0.6 }], 2.3);
    }
  }
  const busCell = busStopFace(atlas);
  const stops = data.infra.filter((f) => f.cls === "stop").map((f) => point(f.g)!).filter(Boolean);
  let shelterDone = false;
  for (const s of stops) {
    const n = nearestMain(s[0], s[1]);
    const nearSchool = Math.hypot(s[0] - schoolPt[0], s[1] - schoolPt[1]) < 220;
    // Off the shoulder, on the side the stop is mapped on.
    const side = Math.sign((s[0] - n.x) * -n.tz + (s[1] - n.z) * n.tx) || 1;
    const off = roadWidth(n.line.r.cls) / 2 + 1.3;
    const x = n.x + -n.tz * side * off;
    const z = n.z + n.tx * side * off;
    sign(x, z, [n.tx, n.tz], [{ cell: busCell, back: busCell, w: 0.4, h: 0.53, mirrorBack: true }], 2.5);
    if (nearSchool && !shelterDone) {
      shelterDone = true;
      const sx = n.x + -n.tz * side * (off + 3.2) + n.tx * 4;
      const sz = n.z + n.tx * side * (off + 3.2) + n.tz * 4;
      batch.add(P.shelter, pose(sx, H(sx, sz), sz, Math.atan2(n.tz * side, -n.tx * side)));
    }
  }

  // ---- Power: mapped poles first, then every 46 m along the roads that carry lines ----------------
  interface Pole {
    x: number;
    z: number;
    y: number;
    ax: number;
    az: number;
    mapped: boolean;
  }
  const poles: Pole[] = [];
  const runs: Pole[][] = [];
  const links: [Pole, Pole][] = [];
  const mapped = data.infra.filter((f) => f.cls === "power_pole" || f.cls === "utility_pole").map((f) => ({ p: point(f.g)!, used: false })).filter((m) => m.p);
  const findPole = (x: number, z: number, r: number) => {
    let best: Pole | null = null;
    let bd = r;
    for (const p of poles) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) (bd = d), (best = p);
    }
    return best;
  };
  const makePole = (x: number, z: number): Pole => {
    // Snap to a mapped pole nearby, and share a pole that is already there.
    let isMapped = false;
    for (const m of mapped) {
      if (!m.used && Math.hypot(m.p[0] - x, m.p[1] - z) < 14) {
        m.used = true;
        x = m.p[0];
        z = m.p[1];
        isMapped = true;
        break;
      }
    }
    const existing = findPole(x, z, 9);
    if (existing) return existing;
    const p: Pole = { x, z, y: H(x, z), ax: 1, az: 0, mapped: isMapped };
    poles.push(p);
    return p;
  };
  const runFrom = (pts: Pt[]) => {
    const run: Pole[] = [];
    for (const p of pts) {
      const pole = makePole(p.x, p.z);
      if (!run.includes(pole)) run.push(pole);
    }
    if (run.length) runs.push(run);
  };
  const underground = new Set<string>();
  for (const f of data.infra) {
    if (f.cls !== "minor_line") continue;
    for (const l of lines(f.g)) runFrom(resample(l, 45));
  }
  for (const ml of mainLines) {
    const name = ml.r.name || "";
    if (polyLength(ml.l) < 24) continue;
    if (ml.r.cls === "residential" && !name.toLowerCase().includes("beck") && hash(name) < 0.3) {
      underground.add(name);
      continue;
    }
    const side = hash(name + "side") < 0.5 ? -1 : 1;
    const w = roadWidth(ml.r.cls) / 2 + 2.4;
    // A pole must not stand in the mouth of a crossing road: slide it along its own road until clear.
    const clearOfOthers = (x: number, z: number) => !mainLines.some((o) => o !== ml && nearestOnLine(x, z, o.l).d < roadWidth(o.r.cls) / 2 + 1.6);
    const pts: Pt[] = [];
    for (const p of resample(ml.l, 46)) {
      for (const shift of [0, 8, -8, 14, -14]) {
        const x = p.x + p.tx * shift + -p.tz * side * w;
        const z = p.z + p.tz * shift + p.tx * side * w;
        if (clearOfOthers(x, z)) {
          pts.push({ x, z });
          break;
        }
      }
    }
    runFrom(pts);
  }
  for (const m of mapped) {
    if (m.used) continue;
    m.used = true;
    const near = findPole(m.p[0], m.p[1], 90);
    const p: Pole = { x: m.p[0], z: m.p[1], y: H(m.p[0], m.p[1]), ax: 1, az: 0, mapped: true };
    poles.push(p);
    if (near) links.push([near, p]);
  }
  // Arms lie across the line: perpendicular to the direction between a pole's neighbours.
  const neighbours = new Map<Pole, Pole[]>();
  const link = (a: Pole, b: Pole) => {
    (neighbours.get(a) ?? neighbours.set(a, []).get(a)!).push(b);
    (neighbours.get(b) ?? neighbours.set(b, []).get(b)!).push(a);
  };
  for (const run of runs) for (let i = 0; i < run.length - 1; i++) link(run[i], run[i + 1]);
  for (const [a, b] of links) link(a, b);
  for (const p of poles) {
    const ns = neighbours.get(p) ?? [];
    let dx = 0;
    let dz = 0;
    if (ns.length >= 2) {
      dx = ns[ns.length - 1].x - ns[0].x;
      dz = ns[ns.length - 1].z - ns[0].z;
    } else if (ns.length === 1) {
      dx = ns[0].x - p.x;
      dz = ns[0].z - p.z;
    } else {
      const n = nearestMain(p.x, p.z);
      dx = n.tx;
      dz = n.tz;
    }
    const dl = Math.hypot(dx, dz) || 1;
    p.ax = -dz / dl;
    p.az = dx / dl;
  }
  const poleGeo = poleGeometry();
  const poleTex = poleTexture();
  const poleMat = new THREE.MeshStandardMaterial({ map: poleTex, roughness: 0.95 });
  disposables.push(poleGeo, poleTex, poleMat);
  const poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, Math.max(1, poles.length));
  poles.forEach((p, i) => {
    // Local +x is (cos yaw, -sin yaw): the arm lies along (ax, az).
    const yaw = Math.atan2(-p.az, p.ax);
    poleMesh.setMatrixAt(i, pose(p.x, p.y - 0.2, p.z, yaw));
    batch.add(P.arm, pose(p.x, p.y + ARM_Y, p.z, yaw));
  });
  poleMesh.count = poles.length;
  poleMesh.castShadow = true;
  group.add(poleMesh);
  // Transformer cans where there are houses to feed: about one pole in three.
  for (const p of poles) {
    const nearHouse = houses.some((b) => {
      const c = point(b.g)!;
      return Math.hypot(c[0] - p.x, c[1] - p.z) < 55;
    });
    if (nearHouse && rnd() < 0.32) batch.add(P.can, pose(p.x, p.y + 8.0, p.z, Math.atan2(-p.az, p.ax)));
  }
  // Wires: three phases on the arm and top pin, a neutral and a telecom cable below.
  const catenary = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, sag: number, segs = 10) => {
    for (let k = 0; k < segs; k++) {
      const t0 = k / segs;
      const t1 = (k + 1) / segs;
      const s = (t: number) => -4 * t * (1 - t) * sag;
      wirePos.push(ax + (bx - ax) * t0, ay + (by - ay) * t0 + s(t0), az + (bz - az) * t0, ax + (bx - ax) * t1, ay + (by - ay) * t1 + s(t1), az + (bz - az) * t1);
    }
  };
  const span = (a: Pole, b: Pole) => {
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 2 || L > 120) return;
    const sag = 0.16 + L * 0.013;
    for (const off of [-ARM_HALF, ARM_HALF]) catenary(a.x + a.ax * off, a.y + ARM_Y + 0.24, a.z + a.az * off, b.x + b.ax * off, b.y + ARM_Y + 0.24, b.z + b.az * off, sag);
    catenary(a.x, a.y + PIN_Y, a.z, b.x, b.y + PIN_Y, b.z, sag);
    catenary(a.x + a.ax * 0.22, a.y + NEUTRAL_Y, a.z + a.az * 0.22, b.x + b.ax * 0.22, b.y + NEUTRAL_Y, b.z + b.az * 0.22, sag * 1.1);
    catenary(a.x + a.ax * 0.14, a.y + TELECOM_Y, a.z + a.az * 0.14, b.x + b.ax * 0.14, b.y + TELECOM_Y, b.z + b.az * 0.14, sag * 1.5, 8);
  };
  for (const run of runs) for (let i = 0; i < run.length - 1; i++) span(run[i], run[i + 1]);
  for (const [a, b] of links) span(a, b);
  // Guy wires at the end of every run, if the anchor lands on grass.
  for (const run of runs) {
    if (run.length < 2) continue;
    for (const [p, q] of [
      [run[0], run[1]],
      [run[run.length - 1], run[run.length - 2]],
    ]) {
      let dx = p.x - q.x;
      let dz = p.z - q.z;
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl;
      dz /= dl;
      const gx = p.x + dx * 5.5;
      const gz = p.z + dz * 5.5;
      if (roadDist(gx, gz) < 3.6 || inFootprint(gx, gz)) continue;
      const gy = H(gx, gz);
      catenary(p.x, p.y + POLE_H - 0.4, p.z, gx, gy + 0.6, gz, 0, 1);
      batch.add(P.anchor, pose(gx, gy, gz, Math.atan2(-dx, -dz)));
    }
  }
  // A service drop to each house from the nearest pole.
  const eaveOf = (b: Building) => {
    if (b.h && b.h > 2.2) {
      const floors = Math.max(1, Math.min(3, Math.round((b.h - 1.5) / 3.1)));
      return Math.max(2.5, Math.min(b.h - 1.2, floors * 3.0 + 0.4));
    }
    if (b.fl && b.fl > 0) return b.fl * 3.0 + 0.4;
    return 3.4;
  };
  for (const b of houses) {
    const ring = rings(b.g)[0];
    if (Math.abs(ringAreaOf(ring)) < 40) continue;
    const c = point(b.g)!;
    const pole = findPole(c[0], c[1], 85);
    if (!pole) continue;
    // The corner of the house nearest the pole, at the eave, plus a short mast.
    let best = ring[0];
    let bd = Infinity;
    for (const v of ring) {
      const d = Math.hypot(v[0] - pole.x, v[1] - pole.z);
      if (d < bd) (bd = d), (best = v);
    }
    const hx = best[0] + (c[0] - best[0]) * 0.08;
    const hz = best[1] + (c[1] - best[1]) * 0.08;
    const hy = H(c[0], c[1]) + eaveOf(b) + 0.7;
    catenary(pole.x + pole.ax * 0.16, pole.y + DROP_Y, pole.z + pole.az * 0.16, hx, hy, hz, 0.35 + bd * 0.006, 8);
  }
  // Where a residential road has no poles the power is underground: a green cabinet at its head.
  for (const name of underground) {
    const ml = mainLines.find((m) => m.r.name === name);
    if (!ml) continue;
    const pts = resample(ml.l, 1);
    const p = pts[Math.min(pts.length - 1, 12)];
    const x = p.x + -p.tz * (roadWidth(ml.r.cls) / 2 + 3.4);
    const z = p.z + p.tx * (roadWidth(ml.r.cls) / 2 + 3.4);
    if (roadDist(x, z) < 3) continue;
    batch.add(P.pad, pose(x, H(x, z), z, Math.atan2(p.tx, p.tz)));
  }

  // ---- Fences, hedges, gates, field fence ---------------------------------------------------------
  const boardTex = boardTexture();
  const boardMat = new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.9, side: THREE.DoubleSide });
  disposables.push(boardTex, boardMat);
  const boardPos: number[] = [];
  const boardUv: number[] = [];
  const boardIdx: number[] = [];
  const railMatrix = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, sx: number, sy: number) => {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const hl = Math.hypot(dx, dz);
    const len = Math.hypot(hl, dy);
    const e = new THREE.Euler(-Math.atan2(dy, hl), Math.atan2(dx, dz), 0, "YXZ");
    return new THREE.Matrix4().compose(new THREE.Vector3(ax, ay, az), new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(sx, sy, len));
  };
  const fenceRun = (l: number[][], style: "rail" | "board" | "field", skipNear?: Pt) => {
    const pts = resample(l, style === "field" ? 3 : 2.4);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const ay = H(a.x, a.z);
      if (style === "rail") batch.add(P.fencePost, pose(a.x, ay, a.z, Math.atan2(a.tx, a.tz), 1, 1.15, 1));
      else if (style === "board") batch.add(P.fencePost, pose(a.x, ay, a.z, Math.atan2(a.tx, a.tz), 1, 1.85, 1));
      else batch.add(P.tPost, pose(a.x, ay, a.z, 0));
      if (i === pts.length - 1) break;
      const b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.3) continue;
      if (skipNear && Math.hypot((a.x + b.x) / 2 - skipNear.x, (a.z + b.z) / 2 - skipNear.z) < 2.6) continue;
      const by = H(b.x, b.z);
      if (style === "rail") {
        batch.add(P.rail, railMatrix(a.x, ay + 0.55, a.z, b.x, by + 0.55, b.z, 1, 1));
        batch.add(P.rail, railMatrix(a.x, ay + 0.98, a.z, b.x, by + 0.98, b.z, 1, 1));
      } else if (style === "field") {
        batch.add(P.mesh, railMatrix(a.x, ay, a.z, b.x, by, b.z, 1, 1));
        wirePos.push(a.x, ay + 1.25, a.z, b.x, by + 1.25, b.z);
      } else {
        const v = boardPos.length / 3;
        boardPos.push(a.x, ay + 0.05, a.z, b.x, by + 0.05, b.z, b.x, by + 1.8, b.z, a.x, ay + 1.8, a.z);
        boardUv.push(0, 0, len / 1.2, 0, len / 1.2, 1, 0, 1);
        boardIdx.push(v, v + 1, v + 2, v, v + 2, v + 3);
        batch.add(P.rail, railMatrix(a.x, ay + 1.82, a.z, b.x, by + 1.82, b.z, 1.4, 0.4));
      }
    }
  };
  for (const f of data.infra) {
    if (f.cls === "fence") {
      const ls = f.g.t === "pg" || f.g.t === "mpg" ? rings(f.g) : lines(f.g);
      for (const l of ls) fenceRun(l, f.g.t === "pg" || f.g.t === "mpg" || polyLength(l) < 45 ? "board" : "rail");
    } else if (f.cls === "hedge") {
      for (const l of lines(f.g)) {
        const pts = resample(l, 1.6);
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          if (len < 0.2) continue;
          const y = (H(a.x, a.z) + H(b.x, b.z)) / 2;
          const h = 1.4 + rnd() * 0.6;
          batch.add(P.hedge, pose((a.x + b.x) / 2, y - 0.05, (a.z + b.z) / 2, Math.atan2(b.x - a.x, b.z - a.z), 1.0 + rnd() * 0.3, h, len + 0.5));
        }
      }
    }
  }
  const farm = data.landuse.filter((f) => f.cls === "farmland" || f.cls === "animal_keeping");
  let farmGateDone = false;
  for (const f of farm) {
    for (const ring of rings(f.g)) {
      let gate: Pt | undefined;
      if (!farmGateDone) {
        let bd = 14;
        let bi = -1;
        ring.forEach((v, i) => {
          const d = roadDist(v[0], v[1]);
          if (d < bd && d > 3) (bd = d), (bi = i);
        });
        if (bi >= 0) {
          farmGateDone = true;
          const v = ring[bi];
          const n = ring[(bi + 1) % ring.length];
          gate = { x: v[0] + (n[0] - v[0]) * 0.5, z: v[1] + (n[1] - v[1]) * 0.5 };
          const dx = n[0] - v[0];
          const dz = n[1] - v[1];
          const gl = Math.hypot(dx, dz) || 1;
          batch.add(P.farmGate, pose(gate.x, H(gate.x, gate.z), gate.z, Math.atan2(-dz / gl, dx / gl)));
        }
      }
      fenceRun(ring, "field", gate);
    }
  }
  const dogCell = dogFace(atlas);
  const farmCentres = farm.map((f) => point(f.g)!);
  data.infra
    .filter((f) => f.cls === "gate")
    .forEach((f, i) => {
      const p = point(f.g);
      if (!p) return;
      const n = nearestAny(p[0], p[1]);
      const isFarm = farmCentres.some((c) => Math.hypot(c[0] - p[0], c[1] - p[1]) < 150);
      const yaw = Math.atan2(-n.tx, -n.tz);
      batch.add(isFarm ? P.farmGate : P.woodGate, pose(p[0], H(p[0], p[1]), p[1], yaw));
      if (i === 5 || i === 9) {
        const c = new THREE.Vector3(p[0] + n.tx * 0.05, H(p[0], p[1]) + 1.0, p[1] + n.tz * 0.05);
        const nrm = new THREE.Vector3(n.tx, 0, n.tz);
        quads.addTwoSided(c, new THREE.Vector3().crossVectors(UP, nrm), UP, 0.36, 0.24, dogCell, dogCell, true);
      }
    });
  if (boardPos.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(boardPos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(boardUv, 2));
    geo.setIndex(boardIdx);
    geo.computeVertexNormals();
    disposables.push(geo);
    const m = new THREE.Mesh(geo, boardMat);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }

  // ---- The mapped points: hydrant, tanks, lamps, bollards, the beach ---------------------------------
  for (const f of data.infra) {
    const p = point(f.g);
    if (!p) continue;
    const y = () => H(p[0], p[1]);
    if (f.cls === "fire_hydrant") batch.add(P.hydrant, pose(p[0], y(), p[1], 0));
    else if (f.cls === "storage_tank") {
      const ring = rings(f.g)[0];
      const angle = ring ? orientedBox(ring).angle : 0;
      batch.add(P.tank, pose(p[0], y(), p[1], -angle));
    } else if (f.cls === "waste_disposal") batch.add(P.dumpster, pose(p[0], y(), p[1], 0.3));
    else if (f.cls === "mobile_phone_tower") batch.add(P.tower, pose(p[0], y(), p[1], 0));
    else if (f.cls === "street_lamp") {
      const n = nearestAny(p[0], p[1]);
      batch.add(P.lamp, pose(p[0], y(), p[1], Math.atan2(n.x - p[0], n.z - p[1])));
    } else if (f.cls === "bollard") {
      for (const l of lines(f.g)) for (const q of resample(l, 1.6)) batch.add(P.bollard, pose(q.x, H(q.x, q.z), q.z, 0));
      if (f.g.t === "pt") batch.add(P.bollard, pose(p[0], y(), p[1], 0));
    } else if (f.cls === "barrier" && f.g.t === "ls") {
      // A log across the end of the beach lane.
      for (const l of lines(f.g)) {
        const a = l[0];
        const b = l[l.length - 1];
        const cx = (a[0] + b[0]) / 2;
        const cz = (a[1] + b[1]) / 2;
        batch.add(P.log, pose(cx, H(cx, cz), cz, Math.atan2(-(b[1] - a[1]), b[0] - a[0]), 1.3, 1, 1));
      }
    } else if (f.cls === "bench") {
      // Benches at the beach look at the water, which is south.
      const idx = data.infra.filter((g) => g.cls === "bench").indexOf(f);
      if (idx % 2 === 0) batch.add(P.bench, pose(p[0], y(), p[1], 0));
      else batch.add(P.log, pose(p[0], y(), p[1], 0.2 * (idx - 2)));
    } else if (f.cls === "information") {
      // The access board faces back up the lane, toward whoever is walking down to the water.
      const n = nearestMain(p[0], p[1]);
      const end = n.line.l[n.line.l.length - 1];
      const start = n.line.l[0];
      const endIsHere = Math.hypot(end[0] - n.x, end[1] - n.z) < Math.hypot(start[0] - n.x, start[1] - n.z);
      const fx = endIsHere ? -n.tx : n.tx;
      const fz = endIsHere ? -n.tz : n.tz;
      batch.add(P.board, pose(p[0], y(), p[1], Math.atan2(fx, fz)));
      const cell = boardFace(atlas, "LYTLE BEACH", ["PUBLIC SHORELINE ACCESS", "City of Bainbridge Island", "Please pack out what you pack in"]);
      const nrm = new THREE.Vector3(fx, 0, fz);
      quads.addTwoSided(new THREE.Vector3(p[0], y() + 1.45, p[1]), new THREE.Vector3().crossVectors(UP, nrm), UP, 1.5, 0.95, cell, backRect, false);
    }
  }

  // ---- The school's front door: its name at the entrance drive, and the flagpole -------------------
  const schoolName = data.places.find((p) => (p.name || "").toLowerCase().includes("elementary"))?.name || "Blakely Elementary School";
  const entrance = gates.filter((g) => nearestOnLine(schoolPt[0], schoolPt[1], g.line).d < 70).sort((a, b) => Math.hypot(a.rx - schoolPt[0], a.rz - schoolPt[1]) - Math.hypot(b.rx - schoolPt[0], b.rz - schoolPt[1]))[0];
  if (entrance) {
    const g = entrance;
    // On the lawn to the left of the drive as you enter, set in from the road, angled to the corner.
    const rightX = g.dz;
    const rightZ = -g.dx;
    const bx = g.rx + g.dx * (g.halfW + 8) + rightX * (roadWidth("service") / 2 + 2.5);
    const bz = g.rz + g.dz * (g.halfW + 8) + rightZ * (roadWidth("service") / 2 + 2.5);
    if (!inFootprint(bx, bz) && roadDist(bx, bz) > 3.5) {
      let nx = -g.dx + rightX * 0.6;
      let nz = -g.dz + rightZ * 0.6;
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl;
      nz /= nl;
      const by = H(bx, bz);
      batch.add(P.board, pose(bx, by, bz, Math.atan2(nx, nz), 1.6, 1.3, 1));
      const parts = schoolName.split(" Elementary");
      const cell = boardFace(atlas, "BLAKELY", [parts[0].toUpperCase(), "ELEMENTARY SCHOOL", "Bainbridge Island School District"], "#f4f4ee", "#1b3f7a");
      const nrm = new THREE.Vector3(nx, 0, nz);
      quads.addTwoSided(new THREE.Vector3(bx, by + 1.8, bz), new THREE.Vector3().crossVectors(UP, nrm), UP, 2.4, 1.2, cell, backRect, false);
      const fx = bx + g.dx * 5 + rightX * 2;
      const fz = bz + g.dz * 5 + rightZ * 2;
      const fy = H(fx, fz);
      batch.add(P.flagpole, pose(fx, fy, fz, 0));
      const flag = flagFace(atlas);
      quads.addTwoSided(new THREE.Vector3(fx + 0.8, fy + 8.5, fz), new THREE.Vector3(1, 0, 0), UP, 1.5, 0.8, flag, flag, true);
    }
  }

  // ---- Assemble ---------------------------------------------------------------------------------------
  batch.build(group);
  const signGeo = quads.build();
  const signMat = new THREE.MeshStandardMaterial({ map: atlas.texture, roughness: 0.5, metalness: 0.05, alphaTest: 0.5 });
  disposables.push(signGeo, signMat);
  const signMesh = new THREE.Mesh(signGeo, signMat);
  signMesh.frustumCulled = false;
  group.add(signMesh);
  const wireGeo = new THREE.BufferGeometry();
  wireGeo.setAttribute("position", new THREE.Float32BufferAttribute(wirePos, 3));
  const wireMat = new THREE.LineBasicMaterial({ color: 0x141414 });
  disposables.push(wireGeo, wireMat);
  const wires = new THREE.LineSegments(wireGeo, wireMat);
  wires.frustumCulled = false;
  group.add(wires);

  return {
    group,
    dispose() {
      batch.dispose();
      atlas.dispose();
      poleMesh.dispose();
      for (const d of disposables) d.dispose();
      for (const m of Object.values(mats)) m.dispose();
    },
  };
}

function ringAreaOf(r: number[][]): number {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i];
    const q = r[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
