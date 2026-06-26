/**
 * tradersGalaxy — a floating archipelago of Trader Joe's outposts.
 * Same physics/character as the rest of the city; just another biome
 * you can fast-travel to.
 *
 * Layout: 5 small cardboard islets connected by simple plank bridges.
 *
 *           [ FROZEN AISLE ]
 *                  |
 *   [ FEARLESS ]--[ PLAZA ]--[ SNACK SHACK ]
 *                  |
 *             [ BANANA STAND ]
 */
import * as THREE from "three";
import { cardboardTexture, signTexture, type WorldBox } from "./cardboardIsland";

export interface TradersGalaxyWorld {
  group: THREE.Group;
  spawn: THREE.Vector3;
  update(dt: number, now: number): void;
}

interface Outpost {
  name: string;
  dx: number; // offset from galaxy center
  dz: number;
  islet: number; // islet radius
  body: { w: number; h: number; d: number };
  bg: string;
  fg: string;
  sub?: { lines: string[]; bg: string; fg: string; glow?: boolean };
  signLines: string[];
}

// Inner ring (5 original outposts) + outer ring of 15 themed shops.
// Bodies are tall enough that the main + sub signs never overlap;
// see the sign layout math in the build loop below.
const INNER: Outpost[] = [
  {
    name: "PLAZA",
    dx: 0, dz: 0, islet: 22,
    body: { w: 20, h: 14, d: 13 },
    bg: "#e8d9b8", fg: "#c0392b",
    sub: { lines: ["GOOD FOOD", "GOOD VIBES"], bg: "#10241a", fg: "#46e88c", glow: true },
    signLines: ["TRADER", "JOE'S"],
  },
  {
    name: "FEARLESS",
    dx: -58, dz: 0, islet: 14,
    body: { w: 13, h: 12, d: 10 },
    bg: "#d8b884", fg: "#7a2618",
    sub: { lines: ["FEARLESS", "FLYER"], bg: "#fff4d6", fg: "#7a2618" },
    signLines: ["FEARLESS", "FLYER"],
  },
  {
    name: "SNACK",
    dx: 58, dz: 0, islet: 14,
    body: { w: 13, h: 12, d: 10 },
    bg: "#b88560", fg: "#3a2412",
    sub: { lines: ["DARK CHOC", "ALMOND"], bg: "#241510", fg: "#f0c070" },
    signLines: ["SNACK", "SHACK"],
  },
  {
    name: "FROZEN",
    dx: 0, dz: -58, islet: 14,
    body: { w: 14, h: 12, d: 10 },
    bg: "#bcd9e8", fg: "#1c4a6a",
    sub: { lines: ["EVERYTHING", "BAGEL"], bg: "#0a2030", fg: "#9ae8ff", glow: true },
    signLines: ["FROZEN", "AISLE"],
  },
  {
    name: "BANANA",
    dx: 0, dz: 58, islet: 14,
    body: { w: 13, h: 11, d: 10 },
    bg: "#f2d34a", fg: "#3a2a08",
    sub: { lines: ["ORGANIC", "19¢ EACH"], bg: "#fff8c8", fg: "#3a2a08" },
    signLines: ["BANANA", "STAND"],
  },
];

// 15 more outposts arranged in a wide outer ring at radius ~120.
const OUTER_SPECS: Array<Omit<Outpost, "dx" | "dz" | "islet">> = [
  { name: "WINE",     body: { w: 12, h: 11, d: 9 }, bg: "#722f3a", fg: "#fde7c6",
    sub: { lines: ["TWO BUCK", "CHUCK"], bg: "#1a0a0e", fg: "#ff8aa0", glow: true },
    signLines: ["WINE", "SHOP"] },
  { name: "FLOWERS",  body: { w: 12, h: 11, d: 9 }, bg: "#e89bb6", fg: "#3a1428",
    sub: { lines: ["CHEAP", "BOUQUETS"], bg: "#fff0f5", fg: "#a83265" },
    signLines: ["FLOWER", "STAND"] },
  { name: "CHEESE",   body: { w: 12, h: 11, d: 9 }, bg: "#f2c14a", fg: "#5a3a08",
    sub: { lines: ["UNEXPECTED", "CHEDDAR"], bg: "#fff8c8", fg: "#7a4a08" },
    signLines: ["CHEESE", "CAVE"] },
  { name: "COFFEE",   body: { w: 12, h: 11, d: 9 }, bg: "#3a2412", fg: "#f0c070",
    sub: { lines: ["JOE", "COFFEE"], bg: "#1a0e08", fg: "#ffb066", glow: true },
    signLines: ["COFFEE", "BAR"] },
  { name: "PIZZA",    body: { w: 12, h: 11, d: 9 }, bg: "#c0392b", fg: "#fff4d6",
    sub: { lines: ["CAULI", "CRUST"], bg: "#fff4d6", fg: "#c0392b" },
    signLines: ["PIZZA", "HUT"] },
  { name: "DUMPLING", body: { w: 12, h: 11, d: 9 }, bg: "#e8a87c", fg: "#3a1a08",
    sub: { lines: ["GYOZA", "TIME"], bg: "#1a0e08", fg: "#ffc888", glow: true },
    signLines: ["DUMPLING", "DOCK"] },
  { name: "SAMPLES",  body: { w: 12, h: 11, d: 9 }, bg: "#fff4d6", fg: "#c0392b",
    sub: { lines: ["FREE", "SAMPLES"], bg: "#10241a", fg: "#46e88c", glow: true },
    signLines: ["SAMPLE", "STAND"] },
  { name: "HAWAII",   body: { w: 12, h: 11, d: 9 }, bg: "#26a69a", fg: "#fff4d6",
    sub: { lines: ["ALOHA", "FRIEND"], bg: "#fff4d6", fg: "#26a69a" },
    signLines: ["HAWAIIAN", "HUT"] },
  { name: "SPICE",    body: { w: 12, h: 11, d: 9 }, bg: "#d2691e", fg: "#fff8c8",
    sub: { lines: ["EVERYTHING", "BAGEL"], bg: "#241510", fg: "#f4c068" },
    signLines: ["SPICE", "BAZAAR"] },
  { name: "PARKING",  body: { w: 12, h: 11, d: 9 }, bg: "#666666", fg: "#fff4d6",
    sub: { lines: ["ALWAYS", "FULL"], bg: "#000000", fg: "#ffcc44", glow: true },
    signLines: ["PARKING", "LOT"] },
  { name: "CARTS",    body: { w: 12, h: 11, d: 9 }, bg: "#b8c0c8", fg: "#1c2a3a",
    sub: { lines: ["MINI", "CARTS"], bg: "#1c2a3a", fg: "#b8c0c8" },
    signLines: ["CART", "CORRAL"] },
  { name: "RETURNS",  body: { w: 12, h: 11, d: 9 }, bg: "#f0ece2", fg: "#2a2a2a",
    sub: { lines: ["NO RECEIPT", "NEEDED"], bg: "#2a2a2a", fg: "#9ae8ff", glow: true },
    signLines: ["RETURNS", "DESK"] },
  { name: "CHECKOUT", body: { w: 12, h: 11, d: 9 }, bg: "#e8d9b8", fg: "#c0392b",
    sub: { lines: ["ALOHA", "SHIRTS"], bg: "#26a69a", fg: "#fff4d6" },
    signLines: ["CHECK", "OUT"] },
  { name: "BAKERY",   body: { w: 12, h: 11, d: 9 }, bg: "#caa05e", fg: "#3a1a08",
    sub: { lines: ["FRESH", "SOURDOUGH"], bg: "#fff8c8", fg: "#7a4a18" },
    signLines: ["BAKERY", "STAND"] },
  { name: "JOEJOES",  body: { w: 12, h: 11, d: 9 }, bg: "#3a2412", fg: "#f4c068",
    sub: { lines: ["COOKIE", "LAND"], bg: "#f4c068", fg: "#3a2412" },
    signLines: ["JOE", "JOE'S"] },
];

const OUTER_RADIUS = 120;
const OUTPOSTS: Outpost[] = [
  ...INNER,
  ...OUTER_SPECS.map((spec, i) => {
    const angle = (i / OUTER_SPECS.length) * Math.PI * 2 + Math.PI / OUTER_SPECS.length;
    return {
      ...spec,
      dx: Math.cos(angle) * OUTER_RADIUS,
      dz: Math.sin(angle) * OUTER_RADIUS,
      islet: 13,
    } as Outpost;
  }),
];

function bridge(fromX: number, fromZ: number, toX: number, toZ: number): {
  mesh: THREE.Mesh;
  box: { minX: number; maxX: number; minZ: number; maxZ: number };
} {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const len = Math.hypot(dx, dz);
  const width = 4;
  const geo = new THREE.BoxGeometry(len, 0.6, width);
  const mat = new THREE.MeshStandardMaterial({ color: "#a98455", roughness: 0.95 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set((fromX + toX) / 2, -0.3, (fromZ + toZ) / 2);
  mesh.rotation.y = -Math.atan2(dz, dx);
  return {
    mesh,
    box: {
      minX: Math.min(fromX, toX) - width / 2,
      maxX: Math.max(fromX, toX) + width / 2,
      minZ: Math.min(fromZ, toZ) - width / 2,
      maxZ: Math.max(fromZ, toZ) + width / 2,
    },
  };
}

export function buildTradersGalaxy(opts: {
  centerX: number;
  centerZ: number;
  topY: number;
  boxes: WorldBox[];
}): TradersGalaxyWorld {
  const { centerX, centerZ, topY, boxes } = opts;
  const group = new THREE.Group();
  group.position.set(centerX, topY, centerZ);

  const cardMap = cardboardTexture();
  const cardboardMat = new THREE.MeshStandardMaterial({ map: cardMap, roughness: 0.92 });
  const cardboardDark = new THREE.MeshStandardMaterial({ color: "#9a7a4e", roughness: 0.95 });

  const twinkles: { mat: THREE.MeshBasicMaterial; phase: number }[] = [];

  // ---- Islets + outposts ----
  for (const o of OUTPOSTS) {
    // Islet platform (cylinder)
    const top = new THREE.Mesh(
      new THREE.CylinderGeometry(o.islet, o.islet + 2, 5, 28),
      cardboardMat,
    );
    top.position.set(o.dx, -2.5, o.dz);
    group.add(top);
    const under = new THREE.Mesh(
      new THREE.ConeGeometry(o.islet + 0.5, 20, 24),
      cardboardDark,
    );
    under.rotation.x = Math.PI;
    under.position.set(o.dx, -15, o.dz);
    group.add(under);

    // Collision box for islet
    boxes.push({
      minX: centerX + o.dx - o.islet * 0.85,
      maxX: centerX + o.dx + o.islet * 0.85,
      minZ: centerZ + o.dz - o.islet * 0.85,
      maxZ: centerZ + o.dz + o.islet * 0.85,
      base: topY - 6,
      height: topY,
    });

    // Building body
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(o.body.w, o.body.h, o.body.d),
      cardboardMat,
    );
    body.position.set(o.dx, o.body.h / 2, o.dz - 2);
    group.add(body);
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(o.body.w + 1.4, 0.5, o.body.d + 1.4),
      cardboardDark,
    );
    roof.position.set(o.dx, o.body.h + 0.25, o.dz - 2);
    roof.rotation.z = 0.03;
    group.add(roof);

    // Building collision (so you can roof-hop like Cardboard Island)
    boxes.push({
      minX: centerX + o.dx - o.body.w / 2,
      maxX: centerX + o.dx + o.body.w / 2,
      minZ: centerZ + o.dz - 2 - o.body.d / 2,
      maxZ: centerZ + o.dz - 2 + o.body.d / 2,
      base: topY,
      height: topY + o.body.h,
    });

    // Front sign on the body
    const tex = signTexture(o.signLines, o.bg, o.fg);
    const aspect = (tex.image as HTMLCanvasElement).height / (tex.image as HTMLCanvasElement).width;
    const signW = o.body.w * 0.85;
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(signW, signW * aspect),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }),
    );
    sign.position.set(o.dx, o.body.h - 1.4, o.dz - 2 + o.body.d / 2 + 0.05);
    group.add(sign);

    // Sub neon sign
    if (o.sub) {
      const stex = signTexture(o.sub.lines, o.sub.bg, o.sub.fg, !!o.sub.glow);
      const sa = (stex.image as HTMLCanvasElement).height / (stex.image as HTMLCanvasElement).width;
      const sw = o.body.w * 0.55;
      const sub = new THREE.Mesh(
        new THREE.PlaneGeometry(sw, sw * sa),
        new THREE.MeshBasicMaterial({ map: stex, side: THREE.DoubleSide, transparent: true }),
      );
      sub.position.set(o.dx, o.body.h * 0.45, o.dz - 2 + o.body.d / 2 + 0.08);
      group.add(sub);
    }

    // Twinkle lights strung across the roof front edge
    const stringCount = 14;
    for (let i = 0; i < stringCount; i++) {
      const t = i / (stringCount - 1);
      const x = o.dx - o.body.w / 2 + t * o.body.w;
      const mat = new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? "#fff2a8" : "#ffb066",
      });
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), mat);
      bulb.position.set(x, o.body.h + 0.6, o.dz - 2 + o.body.d / 2 + 0.3);
      group.add(bulb);
      twinkles.push({ mat, phase: Math.random() * Math.PI * 2 });
    }
  }

  // ---- Bridges between plaza and each outer islet ----
  const plaza = OUTPOSTS[0];
  for (let i = 1; i < OUTPOSTS.length; i++) {
    const o = OUTPOSTS[i];
    // Pull each bridge endpoint into the islet rim so it visually sits on the disc.
    const dirX = o.dx - plaza.dx;
    const dirZ = o.dz - plaza.dz;
    const dist = Math.hypot(dirX, dirZ);
    const ux = dirX / dist;
    const uz = dirZ / dist;
    const fromX = plaza.dx + ux * (plaza.islet - 1);
    const fromZ = plaza.dz + uz * (plaza.islet - 1);
    const toX = o.dx - ux * (o.islet - 1);
    const toZ = o.dz - uz * (o.islet - 1);
    const b = bridge(fromX, fromZ, toX, toZ);
    group.add(b.mesh);
    boxes.push({
      minX: centerX + b.box.minX,
      maxX: centerX + b.box.maxX,
      minZ: centerZ + b.box.minZ,
      maxZ: centerZ + b.box.maxZ,
      base: topY - 1,
      height: topY,
    });
  }

  // ---- A giant banana on the banana islet, just for vibes ----
  const banana = new THREE.Mesh(
    new THREE.TorusGeometry(3, 0.9, 10, 18, Math.PI * 1.05),
    new THREE.MeshStandardMaterial({ color: "#f4d23a", roughness: 0.7 }),
  );
  banana.position.set(0, 9, 56);
  banana.rotation.set(0, Math.PI / 2, Math.PI / 6);
  group.add(banana);

  // ---- Warm sunset point light ----
  const sun = new THREE.PointLight("#ffb070", 1.4, 220, 1.4);
  sun.position.set(0, 40, 0);
  group.add(sun);

  // ---- Plaza marker arch so you know where you spawn ----
  const archMat = new THREE.MeshStandardMaterial({ color: "#c0392b", roughness: 0.6 });
  const archL = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7, 0.6), archMat);
  archL.position.set(-3, 3.5, plaza.islet - 2);
  group.add(archL);
  const archR = archL.clone();
  archR.position.x = 3;
  group.add(archR);
  const archTop = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.7, 0.7), archMat);
  archTop.position.set(0, 7.3, plaza.islet - 2);
  group.add(archTop);
  const archSignTex = signTexture(["TJ'S GALAXY"], "#fff4d6", "#c0392b");
  const ar = (archSignTex.image as HTMLCanvasElement).height / (archSignTex.image as HTMLCanvasElement).width;
  const archSign = new THREE.Mesh(
    new THREE.PlaneGeometry(6.4, 6.4 * ar),
    new THREE.MeshBasicMaterial({ map: archSignTex, side: THREE.DoubleSide }),
  );
  archSign.position.set(0, 8.4, plaza.islet - 2);
  group.add(archSign);

  // Spawn just inside the arch.
  const spawn = new THREE.Vector3(
    centerX,
    topY + 4,
    centerZ + plaza.islet - 6,
  );

  return {
    group,
    spawn,
    update(_dt: number, now: number) {
      for (const t of twinkles) {
        const k = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(now * 0.003 + t.phase));
        t.mat.opacity = k;
        t.mat.transparent = true;
        (t.mat.color as THREE.Color).setRGB(1, 0.85 * k + 0.1, 0.5 * k + 0.1);
      }
    },
  };
}
