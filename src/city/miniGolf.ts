/**
 * miniGolf — Vibe Links, six holes of mini golf on a little floating green
 * off Vibe Island's east rim, joined to the island by a rope bridge behind
 * Ninja's Palace.
 *
 * ## Playing
 *
 * Walk up to any hole's tee sign and press E (or tap the pill). The round
 * starts there and runs to hole 6. On the tee, A/D (or the stick) aims and
 * holding W (or the PUTT button) winds the putter back: the power climbs and
 * falls back again, and letting go strikes. Every hole has a par and a name:
 *
 *   1. Warm Up      a speed bump across the lane
 *   2. Dogleg       round the corner
 *   3. Windmill     time it through the turning sails
 *   4. Bank Shot    a wall straight in the way, so bounce it
 *   5. Volcano      the cup is on top; too soft rolls back down
 *   6. Bumper Bash  pinball bumpers that kick
 *
 * ## The ball
 *
 * Pure 2D physics on (x, z) with the green's own height field providing the
 * slopes (gravity along the gradient), rolling friction, and walls as line
 * segments with a little bounce. A fast ball skips over the cup; a slow one
 * drops. The page reads where the player must stand (`update` returns it)
 * and where the camera goes (`cameraShot`), the same contract as the
 * landmarks' rides.
 *
 * Built in world space, +Y up.
 */
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";

type P = [number, number];
interface HoleDef {
  name: string;
  par: number;
  /** Closed boundary, hole-local. Tee is toward +z, the cup toward -z. */
  poly: P[];
  /** Extra wall segments inside the boundary. */
  walls?: Array<[P, P]>;
  /** Round posts [x, z, r]; bumpers kick. */
  posts?: Array<[number, number, number]>;
  bumpers?: Array<[number, number, number]>;
  tee: P;
  cup: P;
  height?: (x: number, z: number) => number;
  /** A windmill whose sails block the gap at z (|x| < half) part of the time. */
  windmill?: { z: number; half: number };
}

const HOLES: HoleDef[] = [
  {
    name: "Warm Up",
    par: 2,
    poly: [[-1.8, 8], [1.8, 8], [1.8, -8], [-1.8, -8]],
    tee: [0, 6.5],
    cup: [0, -6.2],
    height: (_x, z) => 0.16 * Math.exp(-(z * z) / 1.2),
  },
  {
    name: "Dogleg",
    par: 3,
    poly: [[-6, 8.5], [-2, 8.5], [-2, -2.5], [6.5, -2.5], [6.5, -8], [-6, -8]],
    posts: [[-4, 0.5, 0.35]],
    tee: [-4, 7],
    cup: [4.5, -5.2],
  },
  {
    name: "Windmill",
    par: 3,
    poly: [[-2.6, 8], [2.6, 8], [2.6, -8], [-2.6, -8]],
    walls: [[[-2.6, 0], [-0.75, 0]], [[0.75, 0], [2.6, 0]]],
    windmill: { z: 0, half: 0.75 },
    tee: [0, 6.5],
    cup: [0, -6],
  },
  {
    name: "Bank Shot",
    par: 3,
    poly: [[-6, 8], [6, 8], [6, -8], [-6, -8]],
    walls: [[[-6, 0.5], [3.2, 0.5]]],
    posts: [[3.2, 0.5, 0.3]],
    tee: [-3.5, 6.5],
    cup: [-3.5, -5],
  },
  {
    name: "Volcano",
    par: 3,
    poly: [[-3.2, 8], [3.2, 8], [3.2, -8], [-3.2, -8]],
    tee: [0, 6.5],
    cup: [0, -3.5],
    height: (x, z) => {
      const r = Math.hypot(x, z + 3.5);
      const cone = 0.85 * Math.pow(Math.max(0, 1 - r / 3.2), 1.4);
      // A shallow crater at the top, so a ball that makes it can settle.
      const crater = r < 0.55 ? 0.12 * (1 - r / 0.55) : 0;
      return cone - crater;
    },
  },
  {
    name: "Bumper Bash",
    par: 3,
    poly: [[-5, 8], [5, 8], [5, -8], [-5, -8]],
    bumpers: [[-2.2, 2.5, 0.5], [2.2, 2.5, 0.5], [0, 0, 0.55], [-2.6, -2.8, 0.45], [2.6, -2.8, 0.45]],
    tee: [0, 6.5],
    cup: [0, -6],
  },
];

/** Cell centres on the green, islet-local, for holes 1..6. */
const CELLS: P[] = [[-17, 10], [0, 10], [17, 10], [17, -10], [0, -10], [-17, -10]];

const BALL_R = 0.13;
const CUP_R = 0.3;
const SINK_SPEED = 2.4;
const MAX_SPEED = 10;
const LIFT = 0.14; // green surface above the islet's grass
const MAX_STROKES = 8;

export interface GolfUi {
  playing: boolean;
  hole: number;
  holes: number;
  name: string;
  par: number;
  strokes: number;
  power: number;
  charging: boolean;
  rolling: boolean;
  card: number[];
  /** The round's end: total strokes, total par, coins. */
  done: { total: number; par: number; coins: number } | null;
  /** Standing at a tee sign, not playing: the hole you would start. */
  tee: { hole: number; name: string } | null;
}

export type GolfEvent =
  | { type: "putt"; strokes: number }
  | { type: "sink"; hole: number; strokes: number; par: number }
  | { type: "round"; total: number; par: number; coins: number }
  | { type: "bump" };

export interface MiniGolf {
  group: THREE.Group;
  boxes: WorldBox[];
  /** Where to land for "take me to mini golf". */
  entrance: THREE.Vector3;
  update(dt: number, now: number, ctx: { player: THREE.Vector3; steer: number; charge: boolean }): THREE.Vector3 | null;
  events(): GolfEvent[];
  /** E pressed: start a round at the tee you are standing at. */
  act(player: THREE.Vector3): boolean;
  quit(): void;
  active(): boolean;
  ui(player: THREE.Vector3): GolfUi;
  cameraShot(): { eye: THREE.Vector3; look: THREE.Vector3; fov: number } | null;
  /** Dev: strike now, at an angle (radians, 0 = toward the cup end) and power 0..1. */
  devPutt(angle: number, power: number): void;
  /** Dev: run the ball to rest without drawing. */
  devSettle(): void;
  devState(): unknown;
  dispose(): void;
}

function canvasTex(w: number, h: number, draw: (x: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Coins for a round: generous under par, never nothing. */
export function golfCoins(total: number, par: number): number {
  return Math.max(3, Math.min(40, 20 + (par - total) * 4));
}

export function buildMiniGolf(opts: { cx: number; cz: number; top: number; lowDetail?: boolean }): MiniGolf {
  const { cx, cz, top } = opts;
  const group = new THREE.Group();
  group.name = "vibe-links";
  const boxes: WorldBox[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];
  const mat = <M extends THREE.Material>(m: M) => (mats.push(m), m);
  const geo = <G extends THREE.BufferGeometry>(g: G) => (geos.push(g), g);
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const o = new THREE.Mesh(geo(g), m);
    o.position.set(x, y, z);
    o.castShadow = !opts.lowDetail;
    o.receiveShadow = true;
    group.add(o);
    return o;
  };

  const HX = 28;
  const HZ = 22;
  const grass = mat(new THREE.MeshStandardMaterial({ color: 0x6cc24a, roughness: 0.95 }));
  const rock = mat(new THREE.MeshStandardMaterial({ color: 0x8a7a66, roughness: 1, flatShading: true }));
  const green = mat(new THREE.MeshStandardMaterial({ color: 0x2fa84f, roughness: 0.9, side: THREE.DoubleSide }));
  const wood = mat(new THREE.MeshStandardMaterial({ color: 0xc98a4b, roughness: 0.7 }));
  const white = mat(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 }));
  const dark = mat(new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.8 }));
  const red = mat(new THREE.MeshStandardMaterial({ color: 0xe8384f, roughness: 0.5 }));
  const pink = mat(new THREE.MeshStandardMaterial({ color: 0xff5fc8, roughness: 0.4, emissive: 0x551040 }));
  const rope = mat(new THREE.MeshStandardMaterial({ color: 0xe4d2a8, roughness: 0.9 }));

  // ---- The islet -----------------------------------------------------------
  {
    mesh(new THREE.BoxGeometry(HX * 2, 1.2, HZ * 2), grass, cx, top - 0.6, cz);
    boxes.push({ minX: cx - HX, maxX: cx + HX, minZ: cz - HZ, maxZ: cz + HZ, base: top - 9, height: top });
    // Rocky underside: a squashed cone of stone, like the island's.
    const under = mesh(new THREE.ConeGeometry(30, 26, 9, 1), rock, cx, top - 14.2, cz);
    under.rotation.x = Math.PI;
    under.scale.set(1, 1, HZ / HX);
    // A few trees round the edge.
    const trunkG = new THREE.CylinderGeometry(0.18, 0.25, 2, 6);
    const leafG = new THREE.ConeGeometry(1.3, 3, 7);
    const leaf = mat(new THREE.MeshStandardMaterial({ color: 0x2f8a3a, roughness: 0.9, flatShading: true }));
    geo(trunkG);
    geo(leafG);
    const spots: P[] = [[-26, -20], [-8.5, -20], [8.5, -20], [26, -20], [-26, 20], [26, 20], [-8.5, 20], [8.5, 20], [26, 0], [-26, 0]];
    for (const [x, z] of spots) {
      const t = new THREE.Mesh(trunkG, wood);
      t.position.set(cx + x, top + 1, cz + z);
      group.add(t);
      const l = new THREE.Mesh(leafG, leaf);
      l.position.set(cx + x, top + 3.2, cz + z);
      group.add(l);
    }
  }

  // ---- The rope bridge to Vibe Island --------------------------------------
  // From the island's rim (r = 50, island-local x) to the islet's west edge.
  const bridgeX0 = cx - 52;
  const bridgeX1 = cx - HX + 0.5;
  {
    const len = bridgeX1 - bridgeX0;
    const plankG = geo(new THREE.BoxGeometry(0.5, 0.12, 3.2));
    for (let x = bridgeX0 + 0.3; x < bridgeX1; x += 0.6) {
      const p = new THREE.Mesh(plankG, wood);
      p.position.set(x, top - 0.06, cz);
      p.rotation.y = (Math.sin(x * 12.9) * 0.04);
      group.add(p);
    }
    boxes.push({ minX: bridgeX0 - 2, maxX: bridgeX1 + 1, minZ: cz - 1.6, maxZ: cz + 1.6, base: top - 2, height: top });
    for (const side of [-1.55, 1.55]) {
      for (let x = bridgeX0; x <= bridgeX1; x += len / 8) mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.1, 6), wood, x, top + 0.5, cz + side);
      const r = mesh(new THREE.CylinderGeometry(0.03, 0.03, len, 5).rotateZ(Math.PI / 2), rope, (bridgeX0 + bridgeX1) / 2, top + 1.0, cz + side);
      void r;
      boxes.push({ minX: bridgeX0, maxX: bridgeX1, minZ: cz + side - 0.08, maxZ: cz + side + 0.08, base: top, height: top + 1.05 });
    }
  }
  // The arch at the bridge's end.
  {
    const ax = cx - HX + 2;
    mesh(new THREE.BoxGeometry(0.4, 4, 0.4), wood, ax, top + 2, cz - 2.4);
    mesh(new THREE.BoxGeometry(0.4, 4, 0.4), wood, ax, top + 2, cz + 2.4);
    const t = canvasTex(1024, 256, (x) => {
      x.fillStyle = "#1f6b35";
      x.fillRect(0, 0, 1024, 256);
      x.strokeStyle = "#ffffff";
      x.lineWidth = 10;
      x.strokeRect(14, 14, 996, 228);
      x.fillStyle = "#ffffff";
      x.font = "900 130px system-ui, sans-serif";
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillText("⛳ VIBE LINKS", 512, 136);
    });
    texs.push(t);
    const sm = mat(new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 }));
    const s1 = mesh(new THREE.BoxGeometry(0.25, 1.3, 5.4), sm, ax, top + 4.4, cz);
    void s1;
  }
  const entrance = new THREE.Vector3(cx - HX + 4, top, cz);

  // ---- Holes ---------------------------------------------------------------
  type Seg = { ax: number; az: number; bx: number; bz: number };
  type Hole = HoleDef & {
    ox: number;
    oz: number;
    segs: Seg[];
    teeW: THREE.Vector2;
    cupW: THREE.Vector2;
    sign: THREE.Vector3;
    h: (x: number, z: number) => number;
    sails?: THREE.Group;
    bumperMeshes: THREE.Mesh[];
  };
  const holes: Hole[] = HOLES.map((d, i) => {
    const [ox0, oz0] = CELLS[i];
    const ox = cx + ox0;
    const oz = cz + oz0;
    const segs: Seg[] = [];
    for (let k = 0; k < d.poly.length; k++) {
      const a = d.poly[k];
      const b = d.poly[(k + 1) % d.poly.length];
      segs.push({ ax: ox + a[0], az: oz + a[1], bx: ox + b[0], bz: oz + b[1] });
    }
    for (const [a, b] of d.walls ?? []) segs.push({ ax: ox + a[0], az: oz + a[1], bx: ox + b[0], bz: oz + b[1] });
    const hf = d.height;
    return {
      ...d,
      ox,
      oz,
      segs,
      teeW: new THREE.Vector2(ox + d.tee[0], oz + d.tee[1]),
      cupW: new THREE.Vector2(ox + d.cup[0], oz + d.cup[1]),
      sign: new THREE.Vector3(ox + d.tee[0] + 1.6, top, oz + d.tee[1] + 1.6),
      h: hf ? (x: number, z: number) => hf(x - ox, z - oz) : () => 0,
      bumperMeshes: [],
    };
  });

  for (let i = 0; i < holes.length; i++) {
    const hl = holes[i];
    // The green: a height-field plane over the hole's bounding box for the
    // sloped ones, a flat shape for the rest.
    if (hl.height) {
      const xs = hl.poly.map((p) => p[0]);
      const zs = hl.poly.map((p) => p[1]);
      const w = Math.max(...xs) - Math.min(...xs);
      const d = Math.max(...zs) - Math.min(...zs);
      const g = new THREE.PlaneGeometry(w, d, 24, 48).rotateX(-Math.PI / 2);
      const pos = g.attributes.position as THREE.BufferAttribute;
      const mx = (Math.max(...xs) + Math.min(...xs)) / 2;
      const mz = (Math.max(...zs) + Math.min(...zs)) / 2;
      for (let k = 0; k < pos.count; k++) pos.setY(k, hl.height(pos.getX(k) + mx, pos.getZ(k) + mz));
      g.computeVertexNormals();
      mesh(g, green, hl.ox + mx, top + LIFT, hl.oz + mz);
    } else {
      const shape = new THREE.Shape(hl.poly.map(([x, z]) => new THREE.Vector2(x, -z)));
      const g = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
      mesh(g, green, hl.ox, top + LIFT, hl.oz);
    }
    // Walls along every segment.
    for (const s of hl.segs) {
      const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
      const w = mesh(new THREE.BoxGeometry(len + 0.15, 0.3, 0.15), wood, (s.ax + s.bx) / 2, top + LIFT + 0.12, (s.az + s.bz) / 2);
      w.rotation.y = -Math.atan2(s.bz - s.az, s.bx - s.ax);
    }
    for (const [x, z, r] of hl.posts ?? []) mesh(new THREE.CylinderGeometry(r, r, 0.4, 14), wood, hl.ox + x, top + LIFT + 0.2, hl.oz + z);
    for (const [x, z, r] of hl.bumpers ?? []) {
      const b = mesh(new THREE.CylinderGeometry(r, r * 1.1, 0.35, 18), pink, hl.ox + x, top + LIFT + 0.18, hl.oz + z);
      hl.bumperMeshes.push(b);
    }
    // Cup and flag.
    const cupY = top + LIFT + hl.h(hl.cupW.x, hl.cupW.y) + 0.005;
    mesh(new THREE.CircleGeometry(CUP_R, 20).rotateX(-Math.PI / 2), dark, hl.cupW.x, cupY, hl.cupW.y);
    mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.6, 6), white, hl.cupW.x, cupY + 0.8, hl.cupW.y);
    const flagT = canvasTex(128, 96, (x) => {
      x.fillStyle = "#e8384f";
      x.fillRect(0, 0, 128, 96);
      x.fillStyle = "#fff";
      x.font = "900 64px system-ui, sans-serif";
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillText(String(i + 1), 64, 52);
    });
    texs.push(flagT);
    const flag = mesh(new THREE.PlaneGeometry(0.6, 0.42), mat(new THREE.MeshStandardMaterial({ map: flagT, side: THREE.DoubleSide })), hl.cupW.x + 0.31, cupY + 1.38, hl.cupW.y);
    void flag;
    // Tee mat.
    mesh(new THREE.BoxGeometry(1, 0.02, 1), mat(new THREE.MeshStandardMaterial({ color: 0x1b5e2e })), hl.teeW.x, top + LIFT + hl.h(hl.teeW.x, hl.teeW.y) + 0.01, hl.teeW.y);
    // Sign at the tee.
    const signT = canvasTex(512, 320, (x) => {
      x.fillStyle = "#fff8e8";
      x.fillRect(0, 0, 512, 320);
      x.fillStyle = "#1f6b35";
      x.fillRect(0, 0, 512, 96);
      x.fillStyle = "#fff";
      x.font = "900 64px system-ui, sans-serif";
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillText(`HOLE ${i + 1}`, 256, 52);
      x.fillStyle = "#1a1a1a";
      x.font = "800 58px system-ui, sans-serif";
      x.fillText(hl.name.toUpperCase(), 256, 170);
      x.font = "700 44px system-ui, sans-serif";
      x.fillStyle = "#c0392b";
      x.fillText(`PAR ${hl.par}  ·  PRESS E`, 256, 260);
    });
    texs.push(signT);
    const sm = mat(new THREE.MeshStandardMaterial({ map: signT, roughness: 0.7 }));
    mesh(new THREE.BoxGeometry(0.1, 1.1, 0.1), wood, hl.sign.x, top + 0.55, hl.sign.z);
    const board = mesh(new THREE.BoxGeometry(1.4, 0.88, 0.06), sm, hl.sign.x, top + 1.5, hl.sign.z);
    board.rotation.y = 0;
    // Windmill.
    if (hl.windmill) {
      const wz = hl.oz + hl.windmill.z;
      const house = mesh(new THREE.BoxGeometry(2.2, 2.2, 1.4), red, hl.ox, top + LIFT + 1.4, wz - 0.75);
      void house;
      const roof = mesh(new THREE.ConeGeometry(1.7, 1.3, 4), wood, hl.ox, top + LIFT + 3.15, wz - 0.75);
      roof.rotation.y = Math.PI / 4;
      // The arch the ball runs under, through the house's front.
      const sails = new THREE.Group();
      sails.position.set(hl.ox, top + LIFT + 1.7, wz + 0.05);
      const sailG = geo(new THREE.BoxGeometry(0.35, 1.7, 0.05));
      for (let k = 0; k < 4; k++) {
        const arm = new THREE.Group();
        arm.rotation.z = (k * Math.PI) / 2;
        const sail = new THREE.Mesh(sailG, white);
        sail.position.y = 0.95;
        arm.add(sail);
        sails.add(arm);
      }
      group.add(sails);
      hl.sails = sails;
    }
  }

  // ---- The ball, the aim line ----------------------------------------------
  const ball = mesh(new THREE.SphereGeometry(BALL_R, 18, 12), white, 0, -100, 0);
  ball.visible = false;
  const aimG = geo(new THREE.PlaneGeometry(0.06, 1).rotateX(-Math.PI / 2).translate(0, 0, -0.5));
  const aimM = mat(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }));
  const aim = new THREE.Mesh(aimG, aimM);
  aim.visible = false;
  group.add(aim);

  // ---- State ---------------------------------------------------------------
  let playing = false;
  let hi = 0;
  let strokes = 0;
  const card: number[] = [];
  let done: GolfUi["done"] = null;
  const bp = new THREE.Vector2();
  const bv = new THREE.Vector2();
  let rolling = false;
  let aimA = 0;
  let charging = false;
  let power = 0;
  let powerT = 0;
  let sunk = 0; // seconds since the ball dropped, 0 = not sunk
  let millA = 0;
  let restT = 0;
  const evs: GolfEvent[] = [];
  const standAt = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  const cur = () => holes[hi];
  const surfY = (x: number, z: number) => top + LIFT + cur().h(x, z);
  const placeOnTee = () => {
    const h = cur();
    bp.copy(h.teeW);
    bv.set(0, 0);
    rolling = false;
    sunk = 0;
    strokes = 0;
    power = 0;
    charging = false;
    // Aim straight at the cup end of the lane to start.
    aimA = Math.atan2(h.cupW.x - h.teeW.x, h.cupW.y - h.teeW.y);
    if (h.name === "Dogleg") aimA = Math.PI;
  };
  /** Sails block the gap while one of them hangs low through it. */
  const sailsBlocking = () => {
    const a = ((millA % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    return a > Math.PI / 4 - 0.38 && a < Math.PI / 4 + 0.38;
  };

  const step = (dt: number) => {
    const h = cur();
    // Slopes: gravity along the gradient of the green.
    const e = 0.05;
    const gx = (h.h(bp.x + e, bp.y) - h.h(bp.x - e, bp.y)) / (2 * e);
    const gz = (h.h(bp.x, bp.y + e) - h.h(bp.x, bp.y - e)) / (2 * e);
    bv.x -= gx * 6.5 * dt;
    bv.y -= gz * 6.5 * dt;
    // Rolling friction.
    const sp = bv.length();
    if (sp > 0) {
      const dec = (0.75 + sp * 0.28) * dt;
      if (sp <= dec) bv.set(0, 0);
      else bv.multiplyScalar((sp - dec) / sp);
    }
    const ox = bp.x;
    const oz = bp.y;
    bp.x += bv.x * dt;
    bp.y += bv.y * dt;
    // Windmill gate.
    if (h.windmill) {
      const wz = h.oz + h.windmill.z;
      if ((oz - wz) * (bp.y - wz) <= 0 && Math.abs(bp.x - h.ox) < h.windmill.half && sailsBlocking()) {
        bp.y = oz;
        bv.y = -bv.y * 0.6;
        evs.push({ type: "bump" });
      }
    }
    // Walls.
    for (const s of h.segs) {
      const dx = s.bx - s.ax;
      const dz = s.bz - s.az;
      const L2 = dx * dx + dz * dz;
      let t = ((bp.x - s.ax) * dx + (bp.y - s.az) * dz) / L2;
      t = Math.max(0, Math.min(1, t));
      const qx = s.ax + dx * t;
      const qz = s.az + dz * t;
      const nx0 = bp.x - qx;
      const nz0 = bp.y - qz;
      const d = Math.hypot(nx0, nz0);
      if (d < BALL_R && d > 1e-6) {
        const nx = nx0 / d;
        const nz = nz0 / d;
        bp.x = qx + nx * BALL_R;
        bp.y = qz + nz * BALL_R;
        const vn = bv.x * nx + bv.y * nz;
        if (vn < 0) {
          bv.x -= 1.75 * vn * nx;
          bv.y -= 1.75 * vn * nz;
          if (vn < -1.5) evs.push({ type: "bump" });
        }
      }
    }
    const circle = (x: number, z: number, r: number, kick: number) => {
      const cxw = h.ox + x;
      const czw = h.oz + z;
      const dx = bp.x - cxw;
      const dz = bp.y - czw;
      const d = Math.hypot(dx, dz);
      if (d < r + BALL_R && d > 1e-6) {
        const nx = dx / d;
        const nz = dz / d;
        bp.x = cxw + nx * (r + BALL_R);
        bp.y = czw + nz * (r + BALL_R);
        const vn = bv.x * nx + bv.y * nz;
        if (vn < 0) {
          bv.x -= (1 + kick) * vn * nx;
          bv.y -= (1 + kick) * vn * nz;
          if (kick > 0.8) {
            bv.x += nx * 1.2;
            bv.y += nz * 1.2;
          }
          evs.push({ type: "bump" });
          return true;
        }
      }
      return false;
    };
    for (const [x, z, r] of h.posts ?? []) circle(x, z, r, 0.7);
    (h.bumpers ?? []).forEach(([x, z, r], k) => {
      if (circle(x, z, r, 1.25)) h.bumperMeshes[k].scale.setScalar(1.25);
    });
    // The cup.
    const dc = bp.distanceTo(h.cupW);
    if (dc < CUP_R) {
      const s2 = bv.length();
      if (s2 < SINK_SPEED) {
        sunk = 0.001;
        rolling = false;
        bv.set(0, 0);
        bp.copy(h.cupW);
      } else {
        // Lips out: a nudge off line.
        bv.rotateAround(new THREE.Vector2(), (Math.random() - 0.5) * 0.25);
      }
    }
  };

  const atRest = () => {
    rolling = false;
    bv.set(0, 0);
    if (strokes >= MAX_STROKES) {
      // Picked up: the max goes on the card and on we go.
      strokes = MAX_STROKES;
      sunk = 1.2;
    }
  };
  const strike = (a: number, pw: number) => {
    const sp = 0.6 + pw * (MAX_SPEED - 0.6);
    bv.set(Math.sin(a) * sp, Math.cos(a) * sp);
    rolling = true;
    restT = 0;
    strokes += 1;
    evs.push({ type: "putt", strokes });
  };

  const finishHole = () => {
    const h = cur();
    card.push(strokes);
    evs.push({ type: "sink", hole: hi + 1, strokes, par: h.par });
    if (hi >= holes.length - 1 || card.length >= holes.length) {
      const total = card.reduce((a, b) => a + b, 0);
      const par = holes.slice(holes.length - card.length).reduce((a, b) => a + b.par, 0);
      const coins = golfCoins(total, par);
      done = { total, par, coins };
      evs.push({ type: "round", total, par, coins });
      playing = false;
      ball.visible = false;
      aim.visible = false;
      return;
    }
    hi += 1;
    placeOnTee();
  };

  const update: MiniGolf["update"] = (dt, now, ctx) => {
    // Sails always turn; bumpers spring back.
    millA += dt * 1.1;
    for (const h of holes) {
      if (h.sails) h.sails.rotation.z = -millA;
      for (const b of h.bumperMeshes) b.scale.lerp(tmp.set(1, 1, 1), Math.min(1, dt * 8));
    }
    void now;
    if (!playing) return null;
    const h = cur();
    if (sunk > 0) {
      sunk += dt;
      ball.position.set(bp.x, surfY(bp.x, bp.y) - 0.1, bp.y);
      if (sunk > 1.6) finishHole();
    } else if (rolling) {
      const n = Math.max(1, Math.ceil(dt / 0.004));
      for (let k = 0; k < n && rolling && sunk === 0; k++) step(dt / n);
      if (bv.length() < 0.06) {
        restT += dt;
        if (restT > 0.25) atRest();
      } else restT = 0;
    } else {
      // Aiming and winding up.
      aimA -= ctx.steer * dt * 1.6;
      if (ctx.charge) {
        charging = true;
        powerT += dt;
        power = 0.5 - 0.5 * Math.cos(powerT * 2.6);
      } else if (charging) {
        charging = false;
        strike(aimA, power);
        powerT = 0;
      }
    }
    const by = surfY(bp.x, bp.y) + BALL_R;
    ball.visible = true;
    if (sunk === 0) ball.position.set(bp.x, by, bp.y);
    aim.visible = !rolling && sunk === 0;
    if (aim.visible) {
      aim.position.set(bp.x, by - BALL_R + 0.03, bp.y);
      aim.rotation.y = aimA + Math.PI;
      aim.scale.set(1, 1, 0.8 + power * 3.2);
      aimM.color.setHSL(0.33 - power * 0.33, 0.9, 0.6);
    }
    // Stand beside the ball, square to the aim, while aiming; stay put while
    // it rolls.
    if (!rolling && sunk === 0) {
      const sx = Math.sin(aimA);
      const sz = Math.cos(aimA);
      standAt.set(bp.x - sz * 0.55 - sx * 0.25, top + LIFT + h.h(bp.x, bp.y), bp.y + sx * 0.55 - sz * 0.25);
    }
    void ctx.player;
    return standAt;
  };

  const nearTee = (p: THREE.Vector3) => {
    if (Math.abs(p.y - top) > 2.5) return -1;
    for (let i = 0; i < holes.length; i++) {
      const h = holes[i];
      if (Math.hypot(p.x - h.teeW.x, p.z - h.teeW.y) < 2.2 || Math.hypot(p.x - h.sign.x, p.z - h.sign.z) < 2) return i;
    }
    return -1;
  };

  const camEye = new THREE.Vector3();
  const camLook = new THREE.Vector3();

  return {
    group,
    boxes,
    entrance,
    update,
    events() {
      return evs.splice(0, evs.length);
    },
    act(p) {
      if (playing) return false;
      const i = nearTee(p);
      if (i < 0) return false;
      hi = i;
      card.length = 0;
      done = null;
      playing = true;
      placeOnTee();
      return true;
    },
    quit() {
      playing = false;
      ball.visible = false;
      aim.visible = false;
      done = null;
    },
    active: () => playing,
    ui(p) {
      const h = cur();
      const t = playing ? -1 : nearTee(p);
      return {
        playing,
        hole: hi + 1,
        holes: holes.length,
        name: h.name,
        par: h.par,
        strokes,
        power,
        charging,
        rolling,
        card: [...card],
        done,
        tee: t >= 0 ? { hole: t + 1, name: holes[t].name } : null,
      };
    },
    cameraShot() {
      if (!playing) return null;
      const by = surfY(bp.x, bp.y);
      let dx = Math.sin(aimA);
      let dz = Math.cos(aimA);
      if (rolling && bv.length() > 0.5) {
        dx = bv.x / bv.length();
        dz = bv.y / bv.length();
      }
      camEye.set(bp.x - dx * 4.2, by + 2.6, bp.y - dz * 4.2);
      camLook.set(bp.x + dx * 2.5, by, bp.y + dz * 2.5);
      return { eye: camEye, look: camLook, fov: 60 };
    },
    devPutt(a, pw) {
      if (!playing || rolling || sunk > 0) return;
      aimA = a;
      strike(a, pw);
    },
    devSettle() {
      for (let k = 0; k < 6000 && rolling && sunk === 0; k++) {
        step(0.004);
        millA += 0.004 * 1.1;
        if (bv.length() < 0.06) atRest();
      }
    },
    devState() {
      const h = cur();
      return { playing, hole: hi + 1, strokes, ball: [bp.x, bp.y], cup: [h.cupW.x, h.cupW.y], tee: [h.teeW.x, h.teeW.y], rolling, sunk, card: [...card], done, aim: aimA, signs: holes.map((x) => [x.sign.x, x.sign.z]) };
    },
    dispose() {
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      texs.forEach((t) => t.dispose());
    },
  };
}
