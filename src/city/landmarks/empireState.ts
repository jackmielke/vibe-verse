/**
 * The Empire State Building.
 *
 * Built in setbacks the way the real one is — podium, shaft, three tiers, the
 * mooring mast and the antenna — at the district's own floor height, so it is
 * twice the height of anything else in town rather than a model of 102
 * storeys squashed into a block. You can walk into the Art Deco lobby through
 * the south doors, take the express elevator to the 86th-floor deck, walk the
 * terrace and look through the coin binoculars.
 *
 * The elevator ride itself happens behind the HUD (`LandmarkHud.tsx` draws the
 * car and the floor dial): the shaft is inside a solid tower, so a camera that
 * followed you up it would show 100 m of facade and nothing else.
 *
 * At night the crown is floodlit and the colours change, the way the real
 * tower lights do.
 */
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";
import {
  canvas,
  flatTop,
  merge,
  prismSides,
  rng,
  signTexture,
  solid,
  tex,
  type Station,
  type Viewer,
} from "./common";

export interface EmpireState {
  group: THREE.Group;
  stations: Station[];
  viewers: Array<Viewer & { station: Station }>;
  /** The express elevator: where you board, where you get out. */
  lift: { bottom: THREE.Vector3; top: THREE.Vector3; bottomExit: THREE.Vector3; topExit: THREE.Vector3 };
  deckY: number;
  topY: number;
  indoors(p: THREE.Vector3): boolean;
  setNight(night: boolean): void;
  update(dt: number, now: number, player: THREE.Vector3): void;
  /** Materials snow may settle on. */
  roofs: THREE.Material[];
  dispose(): void;
}

// Heights, metres. See the header for why these are not 102 storeys.
const PODIUM = 12;
const LOBBY_H = 8;
const T1 = 34;
const T2 = 104;
const DECK = 117;
const STUB = 125;
const C1 = 129;
const C2 = 133;
const MAST = 150;
const CAP = 153;
const TIP = 178;

/** Limestone piers, aluminium spandrels, two window bays per tile. */
function facade(night: boolean, seed: number) {
  const W = 512;
  const H = 1024;
  const { c, x } = canvas(W, H);
  const { c: ec, x: e } = canvas(W, H);
  const r = rng(seed);
  x.fillStyle = "#d8cfbb";
  x.fillRect(0, 0, W, H);
  e.fillStyle = "#000";
  e.fillRect(0, 0, W, H);
  // Subtle stone banding.
  for (let i = 0; i < 40; i++) {
    x.fillStyle = `rgba(120,105,80,${0.03 + r() * 0.04})`;
    x.fillRect(0, r() * H, W, 1 + r() * 3);
  }
  const bays = 2;
  const bw = W / bays;
  const floors = 4;
  const fh = H / floors;
  for (let b = 0; b < bays; b++) {
    const x0 = b * bw + bw * 0.24;
    const ww = bw * 0.52;
    // The recessed strip: one continuous vertical ribbon of glass and metal,
    // which is the thing that makes the shaft read as the Empire State.
    x.fillStyle = "#7d8187";
    x.fillRect(x0, 0, ww, H);
    x.fillStyle = "rgba(255,255,255,0.18)";
    x.fillRect(x0, 0, 4, H);
    x.fillStyle = "rgba(0,0,0,0.25)";
    x.fillRect(x0 + ww - 5, 0, 5, H);
    for (let f = 0; f < floors; f++) {
      const y0 = f * fh + fh * 0.2;
      const wh = fh * 0.62;
      const lit = night && r() < 0.42;
      const g = x.createLinearGradient(0, y0, 0, y0 + wh);
      g.addColorStop(0, lit ? "#e9c98d" : "#3c4a58");
      g.addColorStop(1, lit ? "#b38a52" : "#25303b");
      x.fillStyle = g;
      x.fillRect(x0 + 6, y0, ww - 12, wh);
      // Mullion.
      x.fillStyle = "#8d9197";
      x.fillRect(x0 + ww / 2 - 2, y0, 4, wh);
      // Spandrel ornament: three little vertical flutes.
      x.fillStyle = "#9da2a8";
      for (let k = 0; k < 3; k++) x.fillRect(x0 + ww * (0.3 + k * 0.2) - 2, y0 + wh + 6, 4, fh * 0.12);
      if (lit) {
        const warm = 0.5 + r() * 0.5;
        e.fillStyle = `rgba(255,${Math.round(200 + r() * 30)},${Math.round(130 + r() * 50)},${warm})`;
        e.fillRect(x0 + 6, y0, ww - 12, wh);
      }
    }
  }
  return { map: tex(c), emissive: tex(ec) };
}

/** Rouge marble with gold veining, for the lobby walls. */
function marble() {
  const { c, x } = canvas(512);
  const r = rng(86);
  const g = x.createLinearGradient(0, 0, 512, 512);
  g.addColorStop(0, "#6b3b2a");
  g.addColorStop(0.5, "#7d4a33");
  g.addColorStop(1, "#5d3324");
  x.fillStyle = g;
  x.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 26; i++) {
    x.strokeStyle = `rgba(${200 + r() * 55},${160 + r() * 60},${110 + r() * 50},${0.12 + r() * 0.2})`;
    x.lineWidth = 0.6 + r() * 2;
    x.beginPath();
    let px = r() * 512;
    let py = r() * 512;
    x.moveTo(px, py);
    for (let k = 0; k < 8; k++) {
      px += (r() - 0.3) * 90;
      py += (r() - 0.5) * 70;
      x.lineTo(px, py);
    }
    x.stroke();
  }
  // Panel joints every quarter.
  x.strokeStyle = "rgba(30,15,10,0.5)";
  x.lineWidth = 2;
  for (let k = 0; k <= 512; k += 256) {
    x.beginPath();
    x.moveTo(k, 0);
    x.lineTo(k, 512);
    x.stroke();
  }
  return tex(c);
}

/** The gold-leaf ceiling: Art Deco sunbursts and gears. */
function ceiling() {
  const { c, x } = canvas(1024, 512);
  x.fillStyle = "#8a6420";
  x.fillRect(0, 0, 1024, 512);
  const cells = 4;
  const cw = 1024 / cells;
  for (let i = 0; i < cells; i++) {
    const cx = cw * (i + 0.5);
    const cy = 256;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      x.strokeStyle = k % 2 ? "#f6d27a" : "#c99a3a";
      x.lineWidth = 6;
      x.beginPath();
      x.moveTo(cx, cy);
      x.lineTo(cx + Math.cos(a) * cw * 0.48, cy + Math.sin(a) * cw * 0.48);
      x.stroke();
    }
    x.fillStyle = "#fde7a5";
    x.beginPath();
    x.arc(cx, cy, 26, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = "#5a3e10";
    x.lineWidth = 4;
    x.strokeRect(i * cw + 8, 8, cw - 16, 512 - 16);
  }
  return tex(c);
}

/** The famous relief over the elevators: the tower itself, in gold, with rays. */
function mural() {
  const W = 1024;
  const H = 640;
  const { c, x } = canvas(W, H);
  x.fillStyle = "#24140e";
  x.fillRect(0, 0, W, H);
  // Rays.
  for (let k = 0; k < 28; k++) {
    const a = Math.PI + (k / 27) * Math.PI;
    x.strokeStyle = k % 2 ? "rgba(246,210,122,0.55)" : "rgba(201,154,58,0.35)";
    x.lineWidth = 9;
    x.beginPath();
    x.moveTo(W / 2, H * 0.16);
    x.lineTo(W / 2 + Math.cos(a) * W, H * 0.16 + Math.sin(a) * -W);
    x.stroke();
  }
  // The building, in tiers, centre bottom up.
  const gold = x.createLinearGradient(0, 0, 0, H);
  gold.addColorStop(0, "#fff1b8");
  gold.addColorStop(1, "#c08b2c");
  x.fillStyle = gold;
  const tiers: Array<[number, number]> = [
    [260, 0.94],
    [200, 0.82],
    [150, 0.32],
    [110, 0.24],
    [70, 0.19],
    [44, 0.16],
  ];
  let top = H;
  for (const [w, yTop] of tiers) {
    const y = H * yTop;
    x.fillRect(W / 2 - w / 2, y, w, top - y);
    top = y;
  }
  x.fillRect(W / 2 - 6, H * 0.02, 12, H * 0.16);
  // Vertical lines on the shaft.
  x.fillStyle = "rgba(90,60,20,0.6)";
  for (let k = -3; k <= 3; k++) x.fillRect(W / 2 + k * 24 - 2, H * 0.32, 4, H * 0.5);
  x.strokeStyle = "#c99a3a";
  x.lineWidth = 12;
  x.strokeRect(6, 6, W - 12, H - 12);
  return tex(c, false);
}

/** A vertical gradient for the floodlights: bright where the lamps sit. */
function floodGradient() {
  const { c, x } = canvas(4, 256);
  const g = x.createLinearGradient(0, 256, 0, 0);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.55, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0.08)");
  x.fillStyle = g;
  x.fillRect(0, 0, 4, 256);
  return tex(c, false, false);
}

/** Prism sides with v running 0..1 bottom to top, for the flood shells. */
function shell(w: number, d: number, y0: number, y1: number, grow = 0.08) {
  const g = prismSides(w + grow, d + grow, y0, y1, 1, 1);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setY(i, (uv.getY(i) - y0) / (y1 - y0));
  return g;
}

/** Tower-light colours, cycled at night. Warm in Thanksgiving week. */
const PALETTES: string[][] = [
  ["#ffffff", "#ffffff", "#ffffff"],
  ["#ff8a1f", "#ffc24a", "#ffefc2"],
  ["#2dd4a8", "#7dfce0", "#ffffff"],
  ["#ff2d55", "#ffffff", "#3b82f6"],
  ["#c026d3", "#f472b6", "#fde68a"],
];

export function buildEmpireState(opts: { boxes: WorldBox[]; cx: number; cz: number; lowDetail: boolean }): EmpireState {
  const { boxes, cx, cz } = opts;
  const group = new THREE.Group();
  group.position.set(cx, 0, cz);
  const trash: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(t: T) => (trash.push(t), t);

  const day = facade(false, 350);
  const night = facade(true, 350);
  trash.push(day.map, day.emissive, night.map, night.emissive);
  const TU = 6.4;
  const TV = 12.8;
  const facadeMat = keep(
    new THREE.MeshStandardMaterial({
      map: day.map,
      emissive: new THREE.Color("#ffffff"),
      emissiveMap: day.emissive,
      emissiveIntensity: 0,
      roughness: 0.82,
      metalness: 0.05,
    }),
  );
  const roofMat = keep(new THREE.MeshStandardMaterial({ color: "#b3ab9a", roughness: 0.95 }));
  const stoneMat = keep(new THREE.MeshStandardMaterial({ color: "#d6ccb6", roughness: 0.9 }));

  // ---- Massing -----------------------------------------------------------
  const tiers: Array<[number, number, number, number]> = [
    [22, 19, PODIUM, T1],
    [18, 15, T1, T2],
    [15, 13, T2, DECK],
    [9, 7, DECK, STUB],
    [7, 5.6, STUB, C1],
    [5.4, 4.4, C1, C2],
  ];
  const sides: THREE.BufferGeometry[] = [];
  const tops: THREE.BufferGeometry[] = [];
  const parapets: THREE.BufferGeometry[] = [];
  const parapet = (w: number, d: number, y: number, h = 0.9, t = 0.35) => {
    parapets.push(prismSides(w, d, y, y + h, 4, 4));
    parapets.push(prismSides(w - t * 2, d - t * 2, y, y + h, 4, 4));
    parapets.push(flatTop(w, t, y + h, 0, d / 2 - t / 2), flatTop(w, t, y + h, 0, -d / 2 + t / 2));
    parapets.push(flatTop(t, d, y + h, w / 2 - t / 2, 0), flatTop(t, d, y + h, -w / 2 + t / 2, 0));
  };
  for (const [w, d, y0, y1] of tiers) {
    sides.push(prismSides(w, d, y0, y1, TU, TV));
    tops.push(flatTop(w, d, y1 + 0.01));
    if (y1 !== DECK) parapet(w, d, y1);
    solid(boxes, cx, cz, w, d, y0, y1);
  }

  // The podium, with a door in its south face.
  const PW = 26;
  const PD = 24;
  const DOOR_W = 4.4;
  const DOOR_H = 5.2;
  {
    // East, west and north faces whole.
    const all = prismSides(PW, PD, 0, PODIUM, TU, TV);
    // Drop the first face (+z) from the prism; it is rebuilt round the door.
    const idx = all.index!.array as ArrayLike<number>;
    const keepIdx: number[] = [];
    for (let i = 6; i < idx.length; i++) keepIdx.push(idx[i]);
    all.setIndex(keepIdx);
    sides.push(all);
    const front = (x0: number, x1: number, y0: number, y1: number) => {
      const g = new THREE.PlaneGeometry(x1 - x0, y1 - y0);
      g.translate((x0 + x1) / 2, (y0 + y1) / 2, PD / 2);
      const uv = g.attributes.uv as THREE.BufferAttribute;
      const pos = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) + PW / 2) / TU, pos.getY(i) / TV);
      sides.push(g);
    };
    front(-PW / 2, -DOOR_W / 2, 0, PODIUM);
    front(DOOR_W / 2, PW / 2, 0, PODIUM);
    front(-DOOR_W / 2, DOOR_W / 2, DOOR_H, PODIUM);
    tops.push(flatTop(PW, PD, PODIUM + 0.01));
    parapet(PW, PD, PODIUM);
  }
  // Podium collision: solid round a hollow lobby.
  const LX = 8.6; // lobby half-width
  const LZ0 = -10; // back wall
  const LZ1 = PD / 2 - 0.4; // front wall inner face
  solid(boxes, cx - (PW / 2 + LX) / 2, cz, PW / 2 - LX, PD, 0, PODIUM);
  solid(boxes, cx + (PW / 2 + LX) / 2, cz, PW / 2 - LX, PD, 0, PODIUM);
  solid(boxes, cx, cz + (LZ0 - PD / 2) / 2, LX * 2, LZ0 + PD / 2, 0, PODIUM);
  solid(boxes, cx - (LX + DOOR_W / 2) / 2, cz + PD / 2 - 0.2, LX - DOOR_W / 2, 0.4, 0, PODIUM);
  solid(boxes, cx + (LX + DOOR_W / 2) / 2, cz + PD / 2 - 0.2, LX - DOOR_W / 2, 0.4, 0, PODIUM);
  solid(boxes, cx, cz + PD / 2 - 0.2, DOOR_W, 0.4, DOOR_H, PODIUM);
  solid(boxes, cx, cz + (LZ0 + LZ1) / 2, LX * 2, LZ1 - LZ0, LOBBY_H, PODIUM);

  const facadeMesh = new THREE.Mesh(keep(merge(sides)), facadeMat);
  facadeMesh.castShadow = true;
  facadeMesh.receiveShadow = true;
  group.add(facadeMesh);
  const roofMesh = new THREE.Mesh(keep(merge(tops)), roofMat);
  roofMesh.receiveShadow = true;
  group.add(roofMesh);
  const parMesh = new THREE.Mesh(keep(merge(parapets)), stoneMat);
  parMesh.castShadow = true;
  group.add(parMesh);

  // ---- Mast, cap and antenna -----------------------------------------------
  const metal = keep(new THREE.MeshStandardMaterial({ color: "#c9cdd2", roughness: 0.35, metalness: 0.7 }));
  const mastGeo = keep(new THREE.CylinderGeometry(1.7, 2.5, MAST - C2, 8, 1));
  mastGeo.translate(0, (C2 + MAST) / 2, 0);
  const mast = new THREE.Mesh(mastGeo, metal);
  mast.castShadow = true;
  group.add(mast);
  // The ribs up the mast, the vertical fins that catch the light.
  const ribs: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const g = new THREE.BoxGeometry(0.28, MAST - C2 + 2, 0.7);
    g.translate(0, 0, 0);
    g.rotateY(-a);
    const rr = 2.15;
    g.translate(Math.cos(a) * rr, (C2 + MAST) / 2 - 1, Math.sin(a) * rr);
    ribs.push(g);
  }
  // The four wings at the foot of the mast.
  for (const [wx, wz, ww, wd] of [
    [0, 2.6, 2.2, 1.0],
    [0, -2.6, 2.2, 1.0],
    [2.9, 0, 1.0, 2.2],
    [-2.9, 0, 1.0, 2.2],
  ]) {
    const g = new THREE.BoxGeometry(ww, 5, wd);
    g.translate(wx, C2 + 2.5, wz);
    ribs.push(g);
  }
  const ribMesh = new THREE.Mesh(keep(merge(ribs)), stoneMat);
  ribMesh.castShadow = true;
  group.add(ribMesh);
  const capGeo = keep(new THREE.CylinderGeometry(0.9, 1.5, CAP - MAST, 8));
  capGeo.translate(0, (MAST + CAP) / 2, 0);
  group.add(new THREE.Mesh(capGeo, metal));
  const antGeo = keep(new THREE.CylinderGeometry(0.07, 0.42, TIP - CAP, 6));
  antGeo.translate(0, (CAP + TIP) / 2, 0);
  group.add(new THREE.Mesh(antGeo, metal));
  solid(boxes, cx, cz, 4.4, 4.4, C2, CAP);
  const beaconMat = keep(new THREE.MeshBasicMaterial({ color: "#ff2a2a" }));
  const beacon = new THREE.Mesh(keep(new THREE.SphereGeometry(0.45, 10, 8)), beaconMat);
  beacon.position.set(0, TIP + 0.2, 0);
  group.add(beacon);

  // ---- Tower lights ----------------------------------------------------------
  // Additive shells just outside the crown, so the floodlights are a wash of
  // colour over the stone rather than a second texture on it.
  const flood = keep(floodGradient());
  const floodMats: THREE.MeshBasicMaterial[] = [];
  const floods: Array<[THREE.BufferGeometry, number]> = [
    [shell(15, 13, T2, DECK), 0],
    [shell(9, 7, DECK, STUB), 1],
    [shell(7, 5.6, STUB, C1), 1],
    [shell(5.4, 4.4, C1, C2), 2],
  ];
  const mastShell = new THREE.CylinderGeometry(1.85, 2.7, MAST - C2, 8, 1, true);
  mastShell.translate(0, (C2 + MAST) / 2, 0);
  {
    const uv = mastShell.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i));
  }
  floods.push([mastShell, 2]);
  const floodGroup = new THREE.Group();
  for (const [g, band] of floods) {
    const m = keep(
      new THREE.MeshBasicMaterial({
        color: "#ffffff",
        map: flood,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    m.userData.band = band;
    floodMats.push(m);
    keep(g);
    floodGroup.add(new THREE.Mesh(g, m));
  }
  floodGroup.visible = false;
  group.add(floodGroup);

  // ---- The 86th-floor deck ---------------------------------------------------
  // Walkway round the stub, a stone parapet, and the tall iron fence that
  // curls inward at the top.
  const DW = 15;
  const DD = 13;
  solid(boxes, cx, cz + DD / 2 - 0.25, DW, 0.5, DECK, DECK + 2.8);
  solid(boxes, cx, cz - DD / 2 + 0.25, DW, 0.5, DECK, DECK + 2.8);
  solid(boxes, cx + DW / 2 - 0.25, cz, 0.5, DD, DECK, DECK + 2.8);
  solid(boxes, cx - DW / 2 + 0.25, cz, 0.5, DD, DECK, DECK + 2.8);
  const deckParts: THREE.BufferGeometry[] = [];
  deckParts.push(prismSides(DW, DD, DECK, DECK + 1.1, 4, 4), prismSides(DW - 0.7, DD - 0.7, DECK, DECK + 1.1, 4, 4));
  deckParts.push(
    flatTop(DW, 0.35, DECK + 1.1, 0, DD / 2 - 0.17),
    flatTop(DW, 0.35, DECK + 1.1, 0, -DD / 2 + 0.17),
    flatTop(0.35, DD, DECK + 1.1, DW / 2 - 0.17, 0),
    flatTop(0.35, DD, DECK + 1.1, -DW / 2 + 0.17, 0),
  );
  group.add(new THREE.Mesh(keep(merge(deckParts)), stoneMat));
  // Deck paving, a touch warmer than the roofs.
  const paving = keep(new THREE.MeshStandardMaterial({ color: "#9c958a", roughness: 0.92 }));
  const pave = new THREE.Mesh(keep(flatTop(DW - 0.6, DD - 0.6, DECK + 0.03)), paving);
  pave.receiveShadow = true;
  group.add(pave);
  // The fence: a cutout texture on four vertical bands and a tilted lip.
  {
    const { c, x } = canvas(256, 256);
    x.clearRect(0, 0, 256, 256);
    x.fillStyle = "#2b2f33";
    for (let k = 0; k < 256; k += 32) x.fillRect(k, 0, 6, 256);
    x.fillRect(0, 0, 256, 8);
    x.fillRect(0, 124, 256, 6);
    const fenceTex = keep(tex(c));
    const fenceMat = keep(
      new THREE.MeshStandardMaterial({ map: fenceTex, alphaTest: 0.5, transparent: false, side: THREE.DoubleSide, metalness: 0.4, roughness: 0.5 }),
    );
    const band = prismSides(DW - 0.2, DD - 0.2, DECK + 1.1, DECK + 2.7, 1.2, 1.6);
    const lip = prismSides(DW - 1.2, DD - 1.2, DECK + 2.7, DECK + 3.2, 1.2, 0.5);
    // Lean the lip inward by moving its top ring in (already smaller) and its
    // bottom ring out to the band.
    const lp = lip.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < lp.count; i++) {
      if (lp.getY(i) < DECK + 2.8) {
        lp.setX(i, lp.getX(i) * ((DW - 0.2) / (DW - 1.2)));
        lp.setZ(i, lp.getZ(i) * ((DD - 0.2) / (DD - 1.2)));
      }
    }
    group.add(new THREE.Mesh(keep(merge([band, lip])), fenceMat));
  }

  // ---- The lobby ---------------------------------------------------------------
  const marbleTex = keep(marble());
  const marbleMat = keep(
    new THREE.MeshStandardMaterial({ map: marbleTex, roughness: 0.35, metalness: 0.05, side: THREE.BackSide, emissive: "#3a1c10", emissiveIntensity: 0.6 }),
  );
  {
    // Inner walls: three whole sides and the front round the door.
    const w = LX * 2;
    const d = LZ1 - LZ0;
    const zc = (LZ0 + LZ1) / 2;
    const inner = prismSides(w, d, 0, LOBBY_H, 4, 4, 0, zc);
    const idx = inner.index!.array as ArrayLike<number>;
    const k: number[] = [];
    for (let i = 6; i < idx.length; i++) k.push(idx[i]);
    inner.setIndex(k);
    const fronts: THREE.BufferGeometry[] = [inner];
    const frontPanel = (x0: number, x1: number, y0: number, y1: number) => {
      const g = new THREE.PlaneGeometry(x1 - x0, y1 - y0);
      // Faces +z, out of the lobby, so the BackSide material shows it from inside.
      g.translate((x0 + x1) / 2, (y0 + y1) / 2, LZ1);
      fronts.push(g);
    };
    frontPanel(-LX, -DOOR_W / 2, 0, LOBBY_H);
    frontPanel(DOOR_W / 2, LX, 0, LOBBY_H);
    frontPanel(-DOOR_W / 2, DOOR_W / 2, DOOR_H, LOBBY_H);
    group.add(new THREE.Mesh(keep(merge(fronts)), marbleMat));
  }
  // Floor: polished terrazzo with a brass inlay.
  {
    const { c, x } = canvas(512);
    x.fillStyle = "#d9cdb4";
    x.fillRect(0, 0, 512, 512);
    const r = rng(5);
    for (let i = 0; i < 1600; i++) {
      x.fillStyle = `rgba(${90 + r() * 80},${70 + r() * 60},${50 + r() * 40},0.35)`;
      x.fillRect(r() * 512, r() * 512, 2, 2);
    }
    x.strokeStyle = "#b38a3a";
    x.lineWidth = 6;
    x.strokeRect(24, 24, 464, 464);
    x.beginPath();
    x.moveTo(256, 24);
    x.lineTo(488, 256);
    x.lineTo(256, 488);
    x.lineTo(24, 256);
    x.closePath();
    x.stroke();
    const floorTex = keep(tex(c));
    const floorMat = keep(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.2, metalness: 0.1 }));
    const floor = new THREE.Mesh(keep(flatTop(LX * 2, LZ1 - LZ0, 0.04, 0, (LZ0 + LZ1) / 2, 5.2)), floorMat);
    floor.receiveShadow = true;
    group.add(floor);
  }
  // Ceiling.
  {
    const ceilTex = keep(ceiling());
    ceilTex.repeat.set(1, 1);
    const ceilMat = keep(
      new THREE.MeshStandardMaterial({ map: ceilTex, emissive: "#ffcf73", emissiveMap: ceilTex, emissiveIntensity: 0.55, metalness: 0.6, roughness: 0.4 }),
    );
    const g = new THREE.PlaneGeometry(LX * 2, LZ1 - LZ0);
    g.rotateX(Math.PI / 2);
    g.translate(0, LOBBY_H - 0.02, (LZ0 + LZ1) / 2);
    group.add(new THREE.Mesh(keep(g), ceilMat));
  }
  // The mural over the elevators, and the elevator doors under it.
  {
    const muralTex = keep(mural());
    const muralMat = keep(
      new THREE.MeshStandardMaterial({ map: muralTex, emissive: "#ffffff", emissiveMap: muralTex, emissiveIntensity: 0.35, metalness: 0.5, roughness: 0.45 }),
    );
    const g = new THREE.PlaneGeometry(8, 5);
    g.translate(0, 5.4, LZ0 + 0.03);
    group.add(new THREE.Mesh(keep(g), muralMat));
  }
  const brass = keep(new THREE.MeshStandardMaterial({ color: "#c79a45", metalness: 0.85, roughness: 0.28, emissive: "#3a2508", emissiveIntensity: 0.5 }));
  const doorGeo = keep(new THREE.BoxGeometry(1.2, 2.9, 0.08));
  const doorL = new THREE.Mesh(doorGeo, brass);
  const doorR = new THREE.Mesh(doorGeo, brass);
  doorL.position.set(-0.6, 1.45, LZ0 + 0.06);
  doorR.position.set(0.6, 1.45, LZ0 + 0.06);
  group.add(doorL, doorR);
  const carBack = new THREE.Mesh(keep(new THREE.PlaneGeometry(2.4, 2.9)), keep(new THREE.MeshBasicMaterial({ color: "#2a1a0c" })));
  carBack.position.set(0, 1.45, LZ0 + 0.02);
  group.add(carBack);
  // Door frame and the floor dial over it.
  {
    const parts: THREE.BufferGeometry[] = [];
    const frame = (w: number, h: number, x: number, y: number) => {
      const g = new THREE.BoxGeometry(w, h, 0.2);
      g.translate(x, y, LZ0 + 0.1);
      parts.push(g);
    };
    frame(0.25, 3.2, -1.32, 1.6);
    frame(0.25, 3.2, 1.32, 1.6);
    frame(2.9, 0.3, 0, 3.05);
    const dial = new THREE.CircleGeometry(0.42, 24, 0, Math.PI);
    dial.translate(0, 3.25, LZ0 + 0.21);
    parts.push(dial);
    group.add(new THREE.Mesh(keep(merge(parts)), brass));
  }
  // Side elevator banks, closed: brass doors along both side walls.
  {
    const parts: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      for (const z of [-6, -1.5, 3]) {
        const g = new THREE.BoxGeometry(0.08, 2.9, 2.2);
        g.translate(side * (LX - 0.05), 1.45, z);
        parts.push(g);
      }
    }
    group.add(new THREE.Mesh(keep(merge(parts)), brass));
  }
  // The information desk: walnut and brass, and solid.
  {
    const walnut = keep(new THREE.MeshStandardMaterial({ color: "#4a2b18", roughness: 0.5 }));
    const g = new THREE.BoxGeometry(4.2, 1.1, 1.2);
    g.translate(0, 0.55, 2.2);
    group.add(new THREE.Mesh(keep(g), walnut));
    const top = new THREE.BoxGeometry(4.4, 0.08, 1.4);
    top.translate(0, 1.14, 2.2);
    group.add(new THREE.Mesh(keep(top), brass));
    solid(boxes, cx, cz + 2.2, 4.2, 1.2, 0, 1.1);
    const sign = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(2.6, 0.5)),
      keep(new THREE.MeshBasicMaterial({ map: keep(signTexture([{ text: "INFORMATION", size: 110, color: "#f3d48a" }], "#1a0f08", 1024, 200)) })),
    );
    sign.position.set(0, 1.7, 2.2);
    group.add(sign);
    const post = new THREE.CylinderGeometry(0.04, 0.04, 0.6, 6);
    post.translate(0, 1.4, 2.2);
    group.add(new THREE.Mesh(keep(post), brass));
  }

  // ---- The entrance --------------------------------------------------------------
  {
    const canopy = new THREE.BoxGeometry(DOOR_W + 3, 0.35, 2.4);
    canopy.translate(0, DOOR_H + 0.4, PD / 2 + 1.2);
    group.add(new THREE.Mesh(keep(canopy), brass));
    const signTex = keep(
      signTexture(
        [
          { text: "THE EMPIRE STATE BUILDING", size: 74, color: "#f6d27a" },
          { text: "OBSERVATORY · 86TH FLOOR", size: 44, color: "#e9e2cf", font: "400" },
        ],
        "#120c08",
        1280,
        256,
        "#c99a3a",
      ),
    );
    const sign = new THREE.Mesh(keep(new THREE.PlaneGeometry(9, 1.8)), keep(new THREE.MeshBasicMaterial({ map: signTex })));
    sign.position.set(0, DOOR_H + 1.6, PD / 2 + 0.05);
    group.add(sign);
    // Glass doors, open.
    const glass = keep(new THREE.MeshStandardMaterial({ color: "#9fc3d6", transparent: true, opacity: 0.25, metalness: 0.2, roughness: 0.05 }));
    for (const s of [-1, 1]) {
      const g = new THREE.BoxGeometry(0.06, DOOR_H - 0.2, 1.6);
      g.translate(s * (DOOR_W / 2 - 0.1), (DOOR_H - 0.2) / 2, PD / 2 - 0.6);
      group.add(new THREE.Mesh(keep(g), glass));
    }
  }

  // ---- Stations ----------------------------------------------------------------------
  const W = (x: number, y: number, z: number) => new THREE.Vector3(cx + x, y, cz + z);
  const lift = {
    bottom: W(0, 0.05, LZ0 + 1.6),
    bottomExit: W(0, 0.05, LZ0 + 3.2),
    top: W(0, DECK + 0.05, 7 / 2 + 1.0),
    topExit: W(0, DECK + 0.05, 7 / 2 + 1.8),
  };
  // The elevator doors up on the deck, in the stub's south face.
  {
    const g = new THREE.BoxGeometry(2.2, 2.8, 0.1);
    g.translate(0, DECK + 1.4, 7 / 2 + 0.04);
    group.add(new THREE.Mesh(keep(g), brass));
    const signTex = keep(signTexture([{ text: "▼ ELEVATORS ▼", size: 90, color: "#f6d27a" }], "#120c08", 1024, 180));
    const s = new THREE.Mesh(keep(new THREE.PlaneGeometry(2.6, 0.45)), keep(new THREE.MeshBasicMaterial({ map: signTex })));
    s.position.set(0, DECK + 3.2, 7 / 2 + 0.06);
    group.add(s);
  }

  const stations: Station[] = [];
  const viewers: Array<Viewer & { station: Station }> = [];
  // Coin binoculars on the deck corners, facing out.
  const scopeMat = keep(new THREE.MeshStandardMaterial({ color: "#3d6fb6", metalness: 0.6, roughness: 0.35 }));
  const scopes: Array<[number, number]> = [
    [-6.2, 5.2],
    [6.2, 5.2],
    [6.2, -5.2],
  ];
  for (const [x, z] of scopes) {
    const s = buildBinoculars(scopeMat, trash);
    s.position.set(x, DECK, z);
    // Face outward: the scope's front is +z in its own space.
    const out = new THREE.Vector3(Math.sign(x), 0, Math.sign(z)).normalize();
    s.rotation.y = Math.atan2(out.x, out.z);
    group.add(s);
    const pos = W(x, DECK, z);
    // The eye sits out past the fence: through the bars is honest and also
    // a picture of bars.
    const eye = W(x + out.x * 1.7, DECK + 1.75, z + out.z * 1.7);
    const v = { eye, yaw: Math.atan2(-out.x, -out.z) } as Viewer;
    const station: Station = {
      id: `empire-scope-${x}-${z}`,
      label: "Look through the binoculars",
      emoji: "🔭",
      pos,
      radius: 1.3,
      act: () => {},
    };
    viewers.push({ ...v, station });
    stations.push(station);
  }

  const doorOpen = { t: 0 };
  return {
    group,
    stations,
    viewers,
    lift,
    deckY: DECK,
    topY: TIP,
    roofs: [roofMat, paving],
    indoors(p) {
      const lx = p.x - cx;
      const lz = p.z - cz;
      // The lobby, and the deck: a 3 m terrace with the stub on one side and
      // the fence on the other leaves a chase camera nowhere to stand.
      const lobby = p.y < LOBBY_H && Math.abs(lx) < LX && lz > LZ0 && lz < LZ1 + 0.4;
      const deck = p.y > DECK - 0.5 && p.y < STUB && Math.abs(lx) < DW / 2 && Math.abs(lz) < DD / 2;
      return lobby || deck;
    },
    setNight(n) {
      facadeMat.map = n ? night.map : day.map;
      facadeMat.emissiveMap = n ? night.emissive : day.emissive;
      facadeMat.emissiveIntensity = n ? 1 : 0;
      facadeMat.needsUpdate = true;
      floodGroup.visible = n;
      beacon.visible = n;
    },
    update(dt, now, player) {
      // Doors slide open when somebody walks up.
      const near = Math.hypot(player.x - lift.bottom.x, player.z - lift.bottom.z) < 4.5 && player.y < 3;
      doorOpen.t = THREE.MathUtils.clamp(doorOpen.t + (near ? dt : -dt) * 1.6, 0, 1);
      const o = doorOpen.t * 1.1;
      doorL.position.x = -0.6 - o;
      doorR.position.x = 0.6 + o;
      if (floodGroup.visible) {
        // Cycle palettes every 24 s, blending over the last 4.
        const t = now / 1000 / 24;
        const i = Math.floor(t) % PALETTES.length;
        const j = (i + 1) % PALETTES.length;
        const f = THREE.MathUtils.smoothstep(t % 1, 0.83, 1);
        for (const m of floodMats) {
          const band = m.userData.band as number;
          m.color.set(PALETTES[i][band]).lerp(new THREE.Color(PALETTES[j][band]), f);
        }
      }
      beaconMat.color.setRGB(Math.sin(now * 0.004) > 0.2 ? 1 : 0.15, 0.08, 0.08);
    },
    dispose() {
      trash.forEach((t) => t.dispose());
    },
  };
}

/** The coin-operated tower viewer, the blue one everybody has photographed. */
export function buildBinoculars(mat: THREE.Material, trash: Array<{ dispose(): void }>) {
  const g = new THREE.Group();
  const post = new THREE.CylinderGeometry(0.09, 0.14, 1.15, 10);
  post.translate(0, 0.575, 0);
  const foot = new THREE.CylinderGeometry(0.3, 0.34, 0.08, 14);
  foot.translate(0, 0.04, 0);
  const head = new THREE.BoxGeometry(0.46, 0.34, 0.42);
  head.translate(0, 1.38, 0);
  const lensL = new THREE.CylinderGeometry(0.1, 0.12, 0.26, 12);
  lensL.rotateX(Math.PI / 2);
  lensL.translate(-0.12, 1.4, 0.3);
  const lensR = lensL.clone();
  lensR.translate(0.24, 0, 0);
  const eyes = new THREE.BoxGeometry(0.4, 0.1, 0.1);
  eyes.translate(0, 1.44, -0.25);
  const geo = merge([post, foot, head, lensL, lensR, eyes]);
  trash.push(geo);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  g.add(m);
  return g;
}
