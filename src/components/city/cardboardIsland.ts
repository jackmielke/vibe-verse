/**
 * cardboardIsland — the kids' cardboard city, floating off the east
 * edge of Vibe City.
 *
 * Based on the real cardboard-island build: hand-painted signs,
 * kraft-paper buildings (Trader Joe's Island Outpost, Cardboard Café,
 * Ninja's Palace, the Hospital, the Wish Wall), the Dream Tree in the
 * middle, a spinning windmill, palm trees from the pirate kit, and a
 * light beam so pilots can find it from the city.
 *
 * Everything is procedural canvas textures + boxes except the palms
 * (small Quaternius GLBs). The island registers real collision boxes
 * — including its own platform — so you can land on it, walk between
 * the shops, and step off the edge for a 120 m drop into the city.
 *
 * This module is the template for adding more worlds to the city:
 * build a group, push collision boxes, return update/dispose.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import palm1Url from "@/assets/glb/kits/pirate/environment/PalmTree_1.glb";
import palm2Url from "@/assets/glb/kits/pirate/environment/PalmTree_2.glb";
import palm3Url from "@/assets/glb/kits/pirate/environment/PalmTree_3.glb";

/** Structurally matches City's BuildingBox. */
export interface WorldBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  base: number;
  height: number;
}

export interface IslandWorld {
  group: THREE.Group;
  update(dt: number, now: number): void;
  /** Sweet spots for collectible stars, in world coordinates. */
  starSpots: THREE.Vector3[];
  /** The zipline cable loop, in world coordinates. */
  zipline: { x: number; z: number; y: number; radius: number };
  /** Where Jerry the snail sits, in world coordinates. */
  jerry: THREE.Vector3;
  /** Where the SnackFe cafe counter sits, in world coordinates. */
  snackfe: THREE.Vector3;
  /** Ground point right in front of the swing — used for proximity. */
  swingMount: THREE.Vector3;
  /** The swing seat, parented to the swinging pivot. Read its world
   *  position each frame to ride along with the swing. */
  swingSeat: THREE.Object3D;
  /** Current pendulum angle in radians (signed). */
  swingAngle(): number;
  /** Feed the cardboard TV a list of photo URLs to slideshow. */
  setTvPhotos(urls: string[]): void;
}

const ISLAND_RADIUS = 55;

// ------------------------------------------------------------------
// Canvas helpers — everything on the island is "drawn by hand".
// ------------------------------------------------------------------
function cardboardTexture(): THREE.CanvasTexture {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#c8a570";
  ctx.fillRect(0, 0, S, S);
  // Corrugation lines.
  ctx.strokeStyle = "rgba(122, 92, 50, 0.22)";
  ctx.lineWidth = 1.5;
  for (let y = 0; y < S; y += 7) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(S, y);
    ctx.stroke();
  }
  // Packing-tape strips.
  ctx.fillStyle = "rgba(190, 170, 130, 0.5)";
  ctx.fillRect(0, S * 0.3, S, 9);
  ctx.fillRect(S * 0.62, 0, 9, S);
  // Kid doodles.
  const doodles = ["#e85d75", "#5db8e8", "#8cd16a", "#f2b134", "#b78ae0"];
  for (let i = 0; i < 9; i++) {
    ctx.strokeStyle = doodles[i % doodles.length];
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2.2;
    const x = (i * 73 + 20) % S;
    const y = (i * 47 + 30) % S;
    ctx.beginPath();
    if (i % 3 === 0) {
      ctx.arc(x, y, 7, 0, Math.PI * 2); // sun/flower head
    } else if (i % 3 === 1) {
      ctx.moveTo(x - 7, y + 5);
      ctx.lineTo(x, y - 7);
      ctx.lineTo(x + 7, y + 5); // little roof / mountain
    } else {
      ctx.moveTo(x - 8, y);
      ctx.quadraticCurveTo(x, y - 9, x + 8, y); // rainbow arc
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function islandGroundTexture(): THREE.CanvasTexture {
  const S = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#d8c39a"; // sandy base
  ctx.fillRect(0, 0, S, S);
  // Green patches around the rim.
  ctx.fillStyle = "rgba(106, 158, 88, 0.75)";
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    const r = S * 0.34 + ((i * 37) % 60);
    const x = S / 2 + Math.cos(a) * r * 0.5;
    const y = S / 2 + Math.sin(a) * r * 0.5;
    ctx.beginPath();
    ctx.ellipse(x, y, 26 + ((i * 13) % 20), 16 + ((i * 7) % 14), a, 0, Math.PI * 2);
    ctx.fill();
  }
  // Stone path cross through the middle.
  ctx.fillStyle = "rgba(160, 150, 134, 0.9)";
  for (let i = -8; i <= 8; i++) {
    ctx.beginPath();
    ctx.ellipse(S / 2 + i * 26, S / 2, 11, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(S / 2, S / 2 + i * 26, 8, 11, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Flowers.
  const petals = ["#e85d75", "#f2b134", "#b78ae0", "#ffffff"];
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = petals[i % petals.length];
    const x = (i * 131 + 40) % S;
    const y = (i * 89 + 60) % S;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function signTexture(lines: string[], bg: string, fg: string, glow = false): THREE.CanvasTexture {
  const W = 512;
  const H = 128 + lines.length * 96;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(70, 50, 25, 0.65)";
  ctx.lineWidth = 10;
  ctx.strokeRect(7, 7, W - 14, H - 14);
  ctx.font = "bold 72px 'Comic Sans MS', 'Segoe Print', 'Chalkboard SE', cursive, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = fg;
  if (glow) {
    ctx.shadowColor = fg;
    ctx.shadowBlur = 22;
  }
  lines.forEach((line, i) => {
    const y = H / 2 + (i - (lines.length - 1) / 2) * 92;
    // A tiny per-line tilt sells "kid with a paintbrush".
    ctx.save();
    ctx.translate(W / 2, y);
    ctx.rotate((i % 2 === 0 ? -1 : 1) * 0.012);
    ctx.fillText(line, 0, 0, W - 60);
    ctx.restore();
  });
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------------
// Builders
// ------------------------------------------------------------------
interface ShopSpec {
  lines: string[];
  x: number; // relative to island center
  z: number;
  w: number;
  h: number;
  d: number;
  bg: string;
  fg: string;
  sub?: { lines: string[]; bg: string; fg: string; glow?: boolean };
  cross?: boolean; // hospital
  tier?: { w: number; h: number; d: number }; // pagoda top
}

const SHOPS: ShopSpec[] = [
  {
    lines: ["TRADER", "JOE'S"],
    x: -30, z: -8, w: 15, h: 9, d: 11,
    bg: "#e8d9b8", fg: "#c0392b",
    sub: { lines: ["GOOD FOOD", "GOOD VIBES"], bg: "#10241a", fg: "#46e88c", glow: true },
  },
  {
    lines: ["NINJA'S", "PALACE"],
    x: 26, z: -18, w: 13, h: 10, d: 11,
    bg: "#7d4ea8", fg: "#f2a134",
    tier: { w: 8, h: 6, d: 7 },
  },
  {
    lines: ["HOSPITAL"],
    x: 30, z: 16, w: 12, h: 8, d: 9,
    bg: "#f0ece2", fg: "#cc3333",
    cross: true,
  },
  {
    lines: ["CARDBOARD", "CAFE"],
    x: -24, z: 20, w: 11, h: 7, d: 8,
    bg: "#caa05e", fg: "#5a3a1a",
  },
  {
    lines: ["WISH", "WALL"],
    x: -4, z: -32, w: 13, h: 6, d: 2.5,
    bg: "#eaa7c0", fg: "#8a2c52",
  },
  // JERRY'S PLAZA is now a real plaza built around Jerry, not a building.
];

export function buildCardboardIsland(opts: {
  centerX: number;
  centerZ: number;
  topY: number;
  boxes: WorldBox[];
}): IslandWorld {
  const { centerX, centerZ, topY, boxes } = opts;
  const group = new THREE.Group();
  group.position.set(centerX, topY, centerZ); // group origin = island surface center
  const spinners: THREE.Object3D[] = [];
  const starSpots: THREE.Vector3[] = [];

  const cardboard = cardboardTexture();
  const cardboardMat = new THREE.MeshStandardMaterial({ map: cardboard, roughness: 0.92 });
  const cardboardDark = new THREE.MeshStandardMaterial({ color: "#9a7a4e", roughness: 0.95 });

  // ---- Island body -------------------------------------------------
  // Cylinder material order is [side, top, bottom].
  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(ISLAND_RADIUS, ISLAND_RADIUS + 3, 7, 40),
    [
      cardboardDark,
      new THREE.MeshStandardMaterial({ map: islandGroundTexture(), roughness: 0.9 }),
      cardboardDark,
    ],
  );
  top.position.y = -3.5;
  group.add(top);
  const under = new THREE.Mesh(new THREE.ConeGeometry(ISLAND_RADIUS + 1, 34, 36), cardboardMat);
  under.rotation.x = Math.PI;
  under.position.y = -24;
  group.add(under);

  // Platform collision: a square inset into the round island so the
  // visual edge slightly overhangs. Flying under it stays clear.
  const half = ISLAND_RADIUS * 0.74;
  boxes.push({
    minX: centerX - half, maxX: centerX + half,
    minZ: centerZ - half, maxZ: centerZ + half,
    base: topY - 9,
    height: topY,
  });

  // ---- Shops -------------------------------------------------------
  const signMats: THREE.MeshBasicMaterial[] = [];
  for (const s of SHOPS) {
    const shop = new THREE.Group();
    shop.position.set(s.x, 0, s.z);
    const body = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.d), cardboardMat);
    body.position.y = s.h / 2;
    shop.add(body);
    // Wonky cardboard roof slab.
    const roof = new THREE.Mesh(new THREE.BoxGeometry(s.w + 1.4, 0.5, s.d + 1.4), cardboardDark);
    roof.position.y = s.h + 0.25;
    roof.rotation.z = 0.025;
    shop.add(roof);
    if (s.tier) {
      const tier = new THREE.Mesh(
        new THREE.BoxGeometry(s.tier.w, s.tier.h, s.tier.d),
        cardboardMat,
      );
      tier.position.y = s.h + 0.5 + s.tier.h / 2;
      shop.add(tier);
      const tierRoof = new THREE.Mesh(
        new THREE.BoxGeometry(s.tier.w + 1.6, 0.5, s.tier.d + 1.6),
        cardboardDark,
      );
      tierRoof.position.y = s.h + 0.5 + s.tier.h + 0.25;
      tierRoof.rotation.z = -0.04;
      shop.add(tierRoof);
    }

    // Sign facing the Dream Tree at the island center.
    const towardCenter = Math.abs(s.x) > Math.abs(s.z)
      ? { x: -Math.sign(s.x), z: 0, rotY: Math.sign(s.x) < 0 ? Math.PI / 2 : -Math.PI / 2 }
      : { x: 0, z: -Math.sign(s.z), rotY: Math.sign(s.z) < 0 ? 0 : Math.PI };
    const addBoard = (
      lines: string[], bg: string, fg: string, glow: boolean, width: number, y: number, out: number,
    ) => {
      const tex = signTexture(lines, bg, fg, glow);
      const ratio = (tex.image as HTMLCanvasElement).height / (tex.image as HTMLCanvasElement).width;
      const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
      signMats.push(mat);
      const board = new THREE.Mesh(new THREE.PlaneGeometry(width, width * ratio), mat);
      board.position.set(
        towardCenter.x * (Math.abs(s.x) > Math.abs(s.z) ? s.w / 2 + out : 0),
        y,
        towardCenter.z * (Math.abs(s.x) > Math.abs(s.z) ? 0 : s.d / 2 + out),
      );
      board.rotation.y = towardCenter.rotY;
      shop.add(board);
    };
    addBoard(s.lines, s.bg, s.fg, false, Math.min(s.w * 0.85, 11), s.h * 0.72, 0.12);
    if (s.sub) addBoard(s.sub.lines, s.sub.bg, s.sub.fg, s.sub.glow ?? false, 5.5, s.h * 0.3, 0.18);
    if (s.cross) {
      const crossMat = new THREE.MeshBasicMaterial({ color: "#cc3333" });
      const barA = new THREE.Mesh(new THREE.BoxGeometry(0.8, 2.4, 0.3), crossMat);
      const barB = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.8, 0.3), crossMat);
      const cy = s.h + 1.8;
      barA.position.set(0, cy, 0);
      barB.position.set(0, cy, 0);
      shop.add(barA, barB);
    }
    group.add(shop);

    // Collision (main body; the pagoda tier is landable too).
    boxes.push({
      minX: centerX + s.x - s.w / 2, maxX: centerX + s.x + s.w / 2,
      minZ: centerZ + s.z - s.d / 2, maxZ: centerZ + s.z + s.d / 2,
      base: topY,
      height: topY + s.h + 0.5,
    });
    if (s.tier) {
      boxes.push({
        minX: centerX + s.x - s.tier.w / 2, maxX: centerX + s.x + s.tier.w / 2,
        minZ: centerZ + s.z - s.tier.d / 2, maxZ: centerZ + s.z + s.tier.d / 2,
        base: topY + s.h + 0.5,
        height: topY + s.h + 0.5 + s.tier.h + 0.5,
      });
      starSpots.push(new THREE.Vector3(
        centerX + s.x, topY + s.h + s.tier.h + 3, centerZ + s.z,
      ));
    }
  }

  // ---- Dream Tree --------------------------------------------------
  const tree = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 1.4, 9, 10),
    new THREE.MeshStandardMaterial({ color: "#7a5230", roughness: 0.9 }),
  );
  trunk.position.y = 4.5;
  tree.add(trunk);
  const leafMat = new THREE.MeshStandardMaterial({ color: "#4a9e58", roughness: 0.85 });
  [
    [0, 10.5, 0, 4.2],
    [-2.6, 9, 1.4, 2.8],
    [2.4, 9.4, -1.2, 3.0],
  ].forEach(([x, y, z, r]) => {
    const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), leafMat);
    blob.position.set(x, y, z);
    tree.add(blob);
  });
  const treeSign = new THREE.Mesh(
    new THREE.PlaneGeometry(5.5, 2.4),
    new THREE.MeshBasicMaterial({ map: signTexture(["DREAM TREE"], "#f2e2b8", "#3a7a4a"), side: THREE.DoubleSide }),
  );
  treeSign.position.set(0, 6.4, 1.8);
  tree.add(treeSign);
  group.add(tree);
  starSpots.push(new THREE.Vector3(centerX, topY + 14.5, centerZ));

  // ---- Welcome sign ------------------------------------------------
  const welcome = new THREE.Group();
  welcome.position.set(0, 0, 14);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 5.6, 8), cardboardDark);
  post.position.y = 2.8;
  welcome.add(post);
  const boards: Array<{ lines: string[]; y: number; w: number; h: number; bg: string; fg: string }> = [
    { lines: ["WELCOME TO", "EDGE ISLAND"], y: 4.7, w: 7, h: 2.9, bg: "#e8d9b8", fg: "#5a3a1a" },
    { lines: ["BE KIND · REUSE", "DREAM BIG"], y: 2.2, w: 5.6, h: 2.1, bg: "#cfe6c2", fg: "#2a6a3a" },
  ];
  boards.forEach((b) => {
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(b.w, b.h),
      new THREE.MeshBasicMaterial({
        map: signTexture(b.lines, b.bg, b.fg),
        side: THREE.DoubleSide,
      }),
    );
    board.position.y = b.y;
    board.rotation.y = Math.PI; // face approaching pilots from the city
    welcome.add(board);
  });
  group.add(welcome);

  // ---- Windmill ----------------------------------------------------
  const mill = new THREE.Group();
  mill.position.set(14, 0, 2);
  const towerH = 15;
  const tower = new THREE.Mesh(new THREE.BoxGeometry(4.5, towerH, 4.5), cardboardMat);
  tower.position.y = towerH / 2;
  mill.add(tower);
  const hub = new THREE.Group();
  hub.position.set(0, towerH + 1, 2.6);
  const bladeMat = new THREE.MeshStandardMaterial({
    color: "#e8e0c8",
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 7.5), bladeMat);
    blade.position.y = 0; // pivot at hub; offset via geometry translate
    blade.geometry.translate(0, 4.4, 0);
    blade.rotation.z = (i * Math.PI) / 2;
    hub.add(blade);
  }
  mill.add(hub);
  spinners.push(hub);
  group.add(mill);
  boxes.push({
    minX: centerX + 14 - 2.25, maxX: centerX + 14 + 2.25,
    minZ: centerZ + 2 - 2.25, maxZ: centerZ + 2 + 2.25,
    base: topY,
    height: topY + towerH,
  });

  // ---- Paper lantern + palms + beacon -------------------------------
  const lantern = new THREE.Mesh(
    new THREE.SphereGeometry(1.4, 14, 14),
    new THREE.MeshStandardMaterial({
      color: "#f2762a",
      emissive: "#f2762a",
      emissiveIntensity: 0.9,
      roughness: 0.6,
    }),
  );
  lantern.position.set(-21, 11, 12);
  group.add(lantern);
  // Warm pool of light so the island stays welcoming after dark.
  const lanternLight = new THREE.PointLight(0xf2a25c, 55, 70, 1.7);
  lanternLight.position.set(-8, 14, 6);
  group.add(lanternLight);

  const loader = new GLTFLoader();
  [palm1Url, palm2Url, palm3Url].forEach((url, i) => {
    loader.load(url, (gltf) => {
      const palm = gltf.scene;
      palm.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const std = mesh.material as THREE.MeshStandardMaterial;
        if (std && "metalness" in std) {
          std.metalness = Math.min(std.metalness, 0.2);
          std.roughness = Math.max(std.roughness, 0.6);
        }
      });
      const box = new THREE.Box3().setFromObject(palm);
      const size = new THREE.Vector3();
      box.getSize(size);
      const fit = 9 / Math.max(size.x, size.y, size.z, 0.0001);
      // Two clones of each variant, ringed around the island edge.
      for (let c = 0; c < 2; c++) {
        const inst = palm.clone();
        const a = ((i * 2 + c) / 6) * Math.PI * 2 + 0.4;
        inst.scale.setScalar(fit * (0.85 + ((i + c) % 3) * 0.12));
        inst.position.set(Math.cos(a) * (ISLAND_RADIUS - 7), 0, Math.sin(a) * (ISLAND_RADIUS - 7));
        inst.rotation.y = a * 2.3;
        group.add(inst);
      }
    });
  });

  // ---- The Firewall ---------------------------------------------------
  // A literal wall of fire, kid-style: painted cardboard with FIREWALL
  // across the top and a row of flickering flame cones along the edge.
  // No collision — you're meant to jetpack straight through it.
  const firewall = new THREE.Group();
  firewall.position.set(-17, 0, -20);
  {
    const tex = (() => {
      const c = document.createElement("canvas");
      c.width = 512;
      c.height = 192;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#c8a570";
      ctx.fillRect(0, 0, 512, 192);
      const colors = ["#e03e1f", "#f2762a", "#ffc02e"];
      colors.forEach((col, layer) => {
        ctx.fillStyle = col;
        const h = 130 - layer * 38;
        ctx.beginPath();
        ctx.moveTo(0, 192);
        for (let x = 0; x <= 512; x += 32) {
          ctx.lineTo(x + 16, 192 - h - (x * 7919 % 23));
          ctx.lineTo(x + 32, 192);
        }
        ctx.closePath();
        ctx.fill();
      });
      ctx.font = "bold 52px 'Comic Sans MS', 'Segoe Print', cursive, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#5a2410";
      ctx.fillText("FIREWALL", 256, 44);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(10, 3.4, 0.5),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }),
    );
    wall.position.y = 1.7;
    firewall.add(wall);
  }
  const firewallFlames: THREE.Mesh[] = [];
  const fireMat = new THREE.MeshBasicMaterial({
    color: "#ff8a2a",
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  for (let i = 0; i < 8; i++) {
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.4, 6), fireMat);
    flame.position.set(-4.4 + i * 1.26, 3.8, 0);
    firewall.add(flame);
    firewallFlames.push(flame);
  }
  group.add(firewall);

  // ---- The swing -------------------------------------------------------
  const swing = new THREE.Group();
  swing.position.set(-13, 0, -12);
  {
    const legGeo = new THREE.CylinderGeometry(0.12, 0.16, 3.8, 8);
    [-1.3, 1.3].forEach((x) => {
      [-0.5, 0.5].forEach((tilt) => {
        const leg = new THREE.Mesh(legGeo, cardboardDark);
        leg.position.set(x, 1.8, tilt * 0.7);
        leg.rotation.x = tilt * 0.36;
        swing.add(leg);
      });
    });
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.9, 8), cardboardDark);
    bar.rotation.z = Math.PI / 2;
    bar.position.y = 3.5;
    swing.add(bar);
  }
  const swingPivot = new THREE.Group();
  swingPivot.position.y = 3.5;
  {
    const ropeGeo = new THREE.CylinderGeometry(0.035, 0.035, 2.5, 6);
    const ropeMat = new THREE.MeshStandardMaterial({ color: "#a8835a", roughness: 0.95 });
    [-0.45, 0.45].forEach((x) => {
      const rope = new THREE.Mesh(ropeGeo, ropeMat);
      rope.position.set(x, -1.25, 0);
      swingPivot.add(rope);
    });
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.09, 0.42), cardboardMat);
    seat.position.y = -2.52;
    swingPivot.add(seat);
  }
  swing.add(swingPivot);
  group.add(swing);

  // ---- Jerry's Plaza ----------------------------------------------------
  // A real cardboard plaza built AROUND Jerry — modeled after the kids'
  // hand-painted reference: green-painted base, white cross paths, a blue
  // lily pond, planters of vines, benches, lanterns, and a JERRY'S PLAZA
  // archway you walk through to enter.
  const PLAZA_CX = 2;
  const PLAZA_CZ = 22;
  const PLAZA_R = 11; // plaza disk radius

  const plazaGroup = new THREE.Group();
  plazaGroup.position.set(PLAZA_CX, 0, PLAZA_CZ);

  // Painted green base disk (the cardboard pad).
  const plazaPadTex = (() => {
    const S = 512;
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const ctx = c.getContext("2d")!;
    // Green paint with brushy variation.
    ctx.fillStyle = "#3f8c45";
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = "rgba(70, 160, 80, 0.55)";
    for (let i = 0; i < 80; i++) {
      const x = Math.random() * S;
      const y = Math.random() * S;
      ctx.beginPath();
      ctx.ellipse(x, y, 18 + Math.random() * 30, 8 + Math.random() * 16, Math.random() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    // White cross paths.
    ctx.fillStyle = "#f1ecdd";
    ctx.fillRect(S * 0.42, 0, S * 0.16, S);
    ctx.fillRect(0, S * 0.42, S, S * 0.16);
    // Painted speckles (confetti dots).
    const dots = ["#e85d75", "#ffd166", "#5db8e8", "#b78ae0", "#ffffff"];
    for (let i = 0; i < 120; i++) {
      ctx.fillStyle = dots[i % dots.length];
      ctx.beginPath();
      ctx.arc(Math.random() * S, Math.random() * S, 2 + Math.random() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // Blue pond.
    ctx.fillStyle = "#7fc8e8";
    ctx.beginPath();
    ctx.ellipse(S * 0.74, S * 0.28, 34, 24, 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#4aa6d8";
    ctx.beginPath();
    ctx.ellipse(S * 0.76, S * 0.30, 16, 10, 0.3, 0, Math.PI * 2);
    ctx.fill();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const plazaPad = new THREE.Mesh(
    new THREE.CylinderGeometry(PLAZA_R, PLAZA_R, 0.18, 48),
    [
      new THREE.MeshStandardMaterial({ color: "#9a7a4e", roughness: 0.95 }), // side (cardboard edge)
      new THREE.MeshStandardMaterial({ map: plazaPadTex, roughness: 0.9 }),  // top
      new THREE.MeshStandardMaterial({ color: "#9a7a4e", roughness: 0.95 }), // bottom
    ],
  );
  plazaPad.position.y = 0.09;
  plazaGroup.add(plazaPad);

  // Low cardboard planter wall around the rim (segments, with gaps for paths).
  {
    const seg = 24;
    const wallMat = new THREE.MeshStandardMaterial({ map: cardboard, roughness: 0.95 });
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      // Leave 4 gaps aligned with the cross paths (N/S/E/W).
      const nearAxis =
        Math.min(
          Math.abs(((a + Math.PI / 2) % Math.PI) - Math.PI / 2),
          Math.abs((a % Math.PI) - Math.PI / 2),
        );
      if (nearAxis < 0.18) continue;
      const segLen = (Math.PI * 2 * PLAZA_R) / seg - 0.25;
      const w = new THREE.Mesh(
        new THREE.BoxGeometry(0.45, 0.7, segLen),
        wallMat,
      );
      w.position.set(Math.cos(a) * PLAZA_R, 0.45, Math.sin(a) * PLAZA_R);
      w.rotation.y = -a + Math.PI / 2;
      plazaGroup.add(w);
    }
  }

  // Flower-pot planters around the perimeter.
  {
    const potCount = 8;
    for (let i = 0; i < potCount; i++) {
      const a = (i / potCount) * Math.PI * 2 + 0.2;
      const r = PLAZA_R - 1.2;
      const pot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.42, 0.85, 12),
        new THREE.MeshStandardMaterial({ color: "#c0683a", roughness: 0.85 }),
      );
      pot.position.set(Math.cos(a) * r, 0.55, Math.sin(a) * r);
      plazaGroup.add(pot);
      // Foliage tuft.
      const tuftColor = ["#5aa84a", "#7cc46a", "#46a886"][i % 3];
      const tuft = new THREE.Mesh(
        new THREE.SphereGeometry(0.65, 12, 10),
        new THREE.MeshStandardMaterial({ color: tuftColor, roughness: 0.9 }),
      );
      tuft.position.set(Math.cos(a) * r, 1.25, Math.sin(a) * r);
      tuft.scale.set(1, 0.75, 1);
      plazaGroup.add(tuft);
      // Tiny flowers.
      const flowerColors = ["#e85d75", "#ffd166", "#b78ae0", "#ffffff"];
      for (let f = 0; f < 4; f++) {
        const flower = new THREE.Mesh(
          new THREE.SphereGeometry(0.12, 6, 6),
          new THREE.MeshBasicMaterial({ color: flowerColors[(i + f) % flowerColors.length] }),
        );
        const fa = (f / 4) * Math.PI * 2;
        flower.position.set(
          Math.cos(a) * r + Math.cos(fa) * 0.45,
          1.55,
          Math.sin(a) * r + Math.sin(fa) * 0.45,
        );
        plazaGroup.add(flower);
      }
    }
  }

  // Benches facing Jerry, on the diagonals.
  {
    const benchMat = new THREE.MeshStandardMaterial({ map: cardboard, roughness: 0.92 });
    const diagonals = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
    diagonals.forEach((a) => {
      const r = PLAZA_R - 2.6;
      const bx = Math.cos(a) * r;
      const bz = Math.sin(a) * r;
      const bench = new THREE.Group();
      bench.position.set(bx, 0, bz);
      bench.rotation.y = -a + Math.PI / 2; // face center
      const seat = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.18, 0.7), benchMat);
      seat.position.y = 0.65;
      bench.add(seat);
      const back = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 0.12), benchMat);
      back.position.set(0, 1.0, -0.3);
      bench.add(back);
      [-0.95, 0.95].forEach((lx) => {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.65, 0.6), cardboardDark);
        leg.position.set(lx, 0.33, 0);
        bench.add(leg);
      });
      plazaGroup.add(bench);
    });
  }

  // Lily pond (raised, animated ripple via shader-free vertical offset).
  const pondGroup = new THREE.Group();
  pondGroup.position.set(6.5, 0, -5);
  {
    const pondRim = new THREE.Mesh(
      new THREE.TorusGeometry(1.6, 0.22, 10, 32),
      new THREE.MeshStandardMaterial({ color: "#a8835a", roughness: 0.9 }),
    );
    pondRim.rotation.x = Math.PI / 2;
    pondRim.position.y = 0.22;
    pondGroup.add(pondRim);
    const pondWater = new THREE.Mesh(
      new THREE.CircleGeometry(1.55, 32),
      new THREE.MeshStandardMaterial({
        color: "#4aa6d8",
        transparent: true,
        opacity: 0.92,
        roughness: 0.3,
        metalness: 0.2,
      }),
    );
    pondWater.rotation.x = -Math.PI / 2;
    pondWater.position.y = 0.24;
    pondGroup.add(pondWater);
    // Lily pads.
    [0.5, -0.6, 0.2].forEach((px, i) => {
      const pad = new THREE.Mesh(
        new THREE.CircleGeometry(0.32, 12),
        new THREE.MeshStandardMaterial({ color: "#4f9a4a", roughness: 0.85 }),
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(px, 0.26, [-0.4, 0.3, 0.7][i]);
      pondGroup.add(pad);
    });
  }
  plazaGroup.add(pondGroup);

  // JERRY'S PLAZA archway — kids' painted cardboard sign on two posts at the south entrance.
  {
    const archGroup = new THREE.Group();
    archGroup.position.set(0, 0, PLAZA_R + 0.3); // south path entrance
    const postMat = new THREE.MeshStandardMaterial({ map: cardboard, roughness: 0.95 });
    [-2.4, 2.4].forEach((px) => {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.45, 5, 0.45), postMat);
      post.position.set(px, 2.5, 0);
      archGroup.add(post);
    });
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(5.4, 1.8),
      new THREE.MeshBasicMaterial({
        map: signTexture(["JERRY'S", "PLAZA"], "#d9c081", "#1f4ba0"),
        side: THREE.DoubleSide,
      }),
    );
    sign.position.set(0, 4.5, 0);
    archGroup.add(sign);
    // Cardboard "beam" on top.
    const beamTop = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.35, 0.45), postMat);
    beamTop.position.set(0, 5.45, 0);
    archGroup.add(beamTop);
    plazaGroup.add(archGroup);
  }

  // Paper lanterns on the planter wall — gentle glow at night.
  const plazaLanterns: THREE.Mesh[] = [];
  {
    const lanternPositions = [
      Math.PI / 4,
      (3 * Math.PI) / 4,
      (5 * Math.PI) / 4,
      (7 * Math.PI) / 4,
    ];
    lanternPositions.forEach((a) => {
      const r = PLAZA_R + 0.1;
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.09, 2.6, 8),
        cardboardDark,
      );
      pole.position.set(Math.cos(a) * r, 1.3, Math.sin(a) * r);
      plazaGroup.add(pole);
      const lantern = new THREE.Mesh(
        new THREE.SphereGeometry(0.32, 14, 10),
        new THREE.MeshBasicMaterial({ color: "#ffd98a" }),
      );
      lantern.position.set(Math.cos(a) * r, 2.55, Math.sin(a) * r);
      plazaGroup.add(lantern);
      plazaLanterns.push(lantern);
    });
  }

  group.add(plazaGroup);

  // ---- Jerry the snail --------------------------------------------------
  // Mayor of Jerry's Plaza. Hand-built cardboard snail: slug body, a
  // shell with a painted spiral, googly eye stalks, a JERRY sign.
  const jerryGroup = new THREE.Group();
  jerryGroup.position.set(2, 0.18, 22); // sit on top of the plaza pad
  jerryGroup.rotation.y = Math.PI + 0.5; // face the welcome path
  const jerryParts = { stalks: [] as THREE.Mesh[] };
  {
    const bodyMat = new THREE.MeshStandardMaterial({ color: "#d9c36b", roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), bodyMat);
    body.scale.set(1.5, 0.55, 0.75);
    body.position.y = 0.55;
    jerryGroup.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.48, 14, 12), bodyMat);
    head.position.set(1.25, 1.05, 0);
    jerryGroup.add(head);
    // Shell: sphere with a painted spiral.
    const shellTex = (() => {
      const c = document.createElement("canvas");
      c.width = c.height = 256;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#c08a4e";
      ctx.fillRect(0, 0, 256, 256);
      ctx.strokeStyle = "#6a4520";
      ctx.lineWidth = 10;
      ctx.beginPath();
      for (let a = 0; a < Math.PI * 7; a += 0.1) {
        const r = 4 + a * 5.4;
        const x = 128 + Math.cos(a) * r;
        const y = 128 + Math.sin(a) * r;
        if (a === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(1.15, 18, 14),
      new THREE.MeshStandardMaterial({ map: shellTex, roughness: 0.75 }),
    );
    shell.position.set(-0.5, 1.5, 0);
    shell.rotation.z = 0.25;
    jerryGroup.add(shell);
    // Googly eye stalks.
    [-0.22, 0.22].forEach((z) => {
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.75, 6), bodyMat);
      stalk.position.set(1.45, 1.65, z);
      stalk.rotation.z = -0.25;
      jerryGroup.add(stalk);
      jerryParts.stalks.push(stalk);
      const eye = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 10, 8),
        new THREE.MeshBasicMaterial({ color: "#ffffff" }),
      );
      eye.position.set(1.55, 2.05, z);
      jerryGroup.add(eye);
      const pupil = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 8, 6),
        new THREE.MeshBasicMaterial({ color: "#1a1a1a" }),
      );
      pupil.position.set(1.68, 2.07, z);
      jerryGroup.add(pupil);
    });
    const jerrySign = new THREE.Mesh(
      new THREE.PlaneGeometry(2.2, 1),
      new THREE.MeshBasicMaterial({
        map: signTexture(["JERRY"], "#eaa7c0", "#6a2c42"),
        side: THREE.DoubleSide,
      }),
    );
    jerrySign.position.set(0, 3.1, 0);
    jerryGroup.add(jerrySign);
  }
  group.add(jerryGroup);

  // ---- Cardboard TV: the island photo gallery ---------------------------
  const tv = new THREE.Group();
  tv.position.set(18, 0, 22);
  tv.rotation.y = Math.atan2(-18, -22); // screen faces the Dream Tree
  const tvTextures: THREE.Texture[] = [];
  let tvIndex = 0;
  let tvTimer = 0;
  const tvFallback = (() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 320;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#101418";
    ctx.fillRect(0, 0, 512, 320);
    const bars = ["#2dd4a8", "#ffd166", "#e85d75", "#5db8e8", "#b78ae0"];
    bars.forEach((b, i) => {
      ctx.fillStyle = b;
      ctx.fillRect(26 + i * 95, 190, 70, 90);
    });
    ctx.font = "bold 54px 'Comic Sans MS', 'Segoe Print', cursive, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#baffe9";
    ctx.fillText("VIBE TV", 256, 90);
    ctx.font = "26px sans-serif";
    ctx.fillStyle = "#8aa";
    ctx.fillText("tuning the village photo feed…", 256, 145);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const tvScreenMat = new THREE.MeshBasicMaterial({ map: tvFallback });
  {
    const body = new THREE.Mesh(new THREE.BoxGeometry(4.4, 3.1, 0.7), cardboardMat);
    body.position.y = 2.5;
    tv.add(body);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.3), tvScreenMat);
    screen.position.set(0, 2.5, 0.38);
    tv.add(screen);
    [-1.5, 1.5].forEach((x) => {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 1, 8), cardboardDark);
      leg.position.set(x, 0.5, 0);
      tv.add(leg);
    });
    [-0.4, 0.4].forEach((tilt) => {
      const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6), cardboardDark);
      antenna.position.set(tilt * 1.2, 4.7, 0);
      antenna.rotation.z = tilt;
      tv.add(antenna);
    });
  }
  group.add(tv);

  // ---- SnackFe: modern neon cafe ---------------------------------------
  // A sleek modern micro-cafe with alternating mint/magenta string lights
  // along the front awning. Walk up to it to order a snack.
  const SNACK_X = 8;
  const SNACK_Z = -10;
  const SNACK_W = 9;
  const SNACK_D = 6;
  const SNACK_H = 4.4;
  const snackGroup = new THREE.Group();
  snackGroup.position.set(SNACK_X, 0, SNACK_Z);

  // Dark matte concrete body — contrast against cardboard kid-world.
  const snackBody = new THREE.Mesh(
    new THREE.BoxGeometry(SNACK_W, SNACK_H, SNACK_D),
    new THREE.MeshStandardMaterial({ color: "#1c1f26", roughness: 0.55, metalness: 0.15 }),
  );
  snackBody.position.y = SNACK_H / 2;
  snackGroup.add(snackBody);

  // Warm wood front panel under the service window.
  const snackPanel = new THREE.Mesh(
    new THREE.BoxGeometry(SNACK_W * 0.92, SNACK_H * 0.38, 0.12),
    new THREE.MeshStandardMaterial({ color: "#8b5e34", roughness: 0.75 }),
  );
  snackPanel.position.set(0, SNACK_H * 0.22, SNACK_D / 2 + 0.06);
  snackGroup.add(snackPanel);

  // Service window cutout (a glowing rectangle).
  const snackWindow = new THREE.Mesh(
    new THREE.PlaneGeometry(SNACK_W * 0.7, SNACK_H * 0.34),
    new THREE.MeshBasicMaterial({ color: "#fff2c8" }),
  );
  snackWindow.position.set(0, SNACK_H * 0.62, SNACK_D / 2 + 0.07);
  snackGroup.add(snackWindow);

  // Interior warm glow that spills out of the window.
  const snackInteriorLight = new THREE.PointLight(0xffd28a, 22, 18, 1.8);
  snackInteriorLight.position.set(0, SNACK_H * 0.6, SNACK_D / 2 - 0.6);
  snackGroup.add(snackInteriorLight);

  // Flat modern roof slab with slight overhang.
  const snackRoof = new THREE.Mesh(
    new THREE.BoxGeometry(SNACK_W + 1.6, 0.28, SNACK_D + 2.2),
    new THREE.MeshStandardMaterial({ color: "#0d1014", roughness: 0.6 }),
  );
  snackRoof.position.set(0, SNACK_H + 0.14, 0.6);
  snackGroup.add(snackRoof);

  // Neon "SnackFe" sign mounted above the window.
  const snackSignTex = (() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 160;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#0d1014";
    ctx.fillRect(0, 0, 512, 160);
    ctx.font = "bold 96px 'Sora', 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "#46e88c";
    ctx.shadowBlur = 28;
    ctx.fillStyle = "#46e88c";
    ctx.fillText("SnackFe", 256, 82);
    ctx.shadowBlur = 0;
    ctx.font = "20px 'Manrope', sans-serif";
    ctx.fillStyle = "#e94f8a";
    ctx.fillText("· open late · vibes inside ·", 256, 138);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const snackSign = new THREE.Mesh(
    new THREE.PlaneGeometry(5.6, 1.75),
    new THREE.MeshBasicMaterial({ map: snackSignTex, transparent: true }),
  );
  snackSign.position.set(0, SNACK_H + 1.1, SNACK_D / 2 + 0.08);
  snackGroup.add(snackSign);

  // Alternating string lights along the front roof edge.
  const snackLights: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; hue: 0 | 1 }[] = [];
  const LIGHT_COUNT = 11;
  for (let i = 0; i < LIGHT_COUNT; i++) {
    const t = i / (LIGHT_COUNT - 1);
    const x = (-SNACK_W / 2 - 0.6) + t * (SNACK_W + 1.2);
    const hue: 0 | 1 = (i % 2) as 0 | 1;
    const mat = new THREE.MeshBasicMaterial({
      color: hue === 0 ? "#46e88c" : "#e94f8a",
      transparent: true,
      opacity: 0.95,
    });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), mat);
    bulb.position.set(x, SNACK_H + 0.05, SNACK_D / 2 + 1.05);
    snackGroup.add(bulb);
    snackLights.push({ mesh: bulb, mat, hue });
  }
  // Sagging cable that the bulbs hang from.
  {
    const cablePts: THREE.Vector3[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const x = (-SNACK_W / 2 - 0.6) + t * (SNACK_W + 1.2);
      const sag = Math.sin(t * Math.PI) * 0.18;
      cablePts.push(new THREE.Vector3(x, SNACK_H + 0.22 - sag, SNACK_D / 2 + 1.05));
    }
    const cableGeo = new THREE.BufferGeometry().setFromPoints(cablePts);
    const cableMat = new THREE.LineBasicMaterial({ color: "#222" });
    snackGroup.add(new THREE.Line(cableGeo, cableMat));
  }

  // Outdoor counter + two stools.
  const counter = new THREE.Mesh(
    new THREE.BoxGeometry(SNACK_W * 0.7, 0.22, 0.7),
    new THREE.MeshStandardMaterial({ color: "#d4a574", roughness: 0.7 }),
  );
  counter.position.set(0, 1.05, SNACK_D / 2 + 0.55);
  snackGroup.add(counter);
  [-1.6, 1.6].forEach((sx) => {
    const stoolPole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 0.9, 8),
      new THREE.MeshStandardMaterial({ color: "#222", roughness: 0.6, metalness: 0.4 }),
    );
    stoolPole.position.set(sx, 0.45, SNACK_D / 2 + 1.35);
    snackGroup.add(stoolPole);
    const stoolSeat = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.32, 0.1, 16),
      new THREE.MeshStandardMaterial({ color: "#46e88c", roughness: 0.5, emissive: "#1a3a26", emissiveIntensity: 0.4 }),
    );
    stoolSeat.position.set(sx, 0.95, SNACK_D / 2 + 1.35);
    snackGroup.add(stoolSeat);
  });

  // Small floor mat with neon outline.
  const mat = new THREE.Mesh(
    new THREE.PlaneGeometry(SNACK_W * 0.85, 1.8),
    new THREE.MeshBasicMaterial({ color: "#0d1014" }),
  );
  mat.rotation.x = -Math.PI / 2;
  mat.position.set(0, 0.02, SNACK_D / 2 + 1.4);
  snackGroup.add(mat);

  group.add(snackGroup);

  // Collision: the cafe body itself.
  boxes.push({
    minX: centerX + SNACK_X - SNACK_W / 2,
    maxX: centerX + SNACK_X + SNACK_W / 2,
    minZ: centerZ + SNACK_Z - SNACK_D / 2,
    maxZ: centerZ + SNACK_Z + SNACK_D / 2,
    base: topY,
    height: topY + SNACK_H + 0.3,
  });


  // ---- Zipline: a cable loop riding the island's perimeter ----------
  // Grab it under any stretch of cable and it carries you around the
  // whole cardboard city. Poles sit just outside the cable so riders
  // glide past them, not through them.
  const ZIP_RADIUS = 42;
  const ZIP_HEIGHT = 5;
  const cable = new THREE.Mesh(
    new THREE.TorusGeometry(ZIP_RADIUS, 0.08, 6, 96),
    new THREE.MeshBasicMaterial({ color: "#46392b" }),
  );
  cable.rotation.x = Math.PI / 2;
  cable.position.y = ZIP_HEIGHT;
  group.add(cable);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.33;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.32, ZIP_HEIGHT + 0.8, 8),
      cardboardDark,
    );
    pole.position.set(Math.cos(a) * (ZIP_RADIUS + 1.1), (ZIP_HEIGHT + 0.8) / 2, Math.sin(a) * (ZIP_RADIUS + 1.1));
    group.add(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.18, 0.18), cardboardDark);
    arm.position.set(Math.cos(a) * (ZIP_RADIUS + 0.5), ZIP_HEIGHT + 0.25, Math.sin(a) * (ZIP_RADIUS + 0.5));
    arm.rotation.y = -a;
    group.add(arm);
  }

  // Light beam: visible from the city day or night, fog-exempt.
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.1, 320, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color: "#ffd166",
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    }),
  );
  beam.position.set(0, 40, -38);
  group.add(beam);
  spinners.push(beam);

  // A few starting star spots on the lawn ring.
  starSpots.push(
    new THREE.Vector3(centerX - 14, topY + 2, centerZ - 14),
    new THREE.Vector3(centerX + 16, topY + 2, centerZ + 14),
    new THREE.Vector3(centerX, topY + 2, centerZ - 22),
  );

  return {
    group,
    update(dt, now) {
      spinners[0].rotation.z += dt * 1.1; // windmill
      const beamMesh = spinners[1] as THREE.Mesh;
      (beamMesh.material as THREE.MeshBasicMaterial).opacity =
        0.28 + Math.sin(now * 0.0016) * 0.12;
      lantern.position.y = 11 + Math.sin(now * 0.0012) * 0.4;

      // Firewall flames flicker; the swing sways; Jerry wiggles.
      firewallFlames.forEach((f, i) => {
        const s = 0.75 + Math.abs(Math.sin(now * 0.011 + i * 1.7)) * 0.5;
        f.scale.set(s, 0.8 + Math.random() * 0.55, s);
      });
      swingPivot.rotation.x = Math.sin(now * 0.0013) * 0.52;
      jerryGroup.rotation.y = Math.PI + 0.5 + Math.sin(now * 0.0008) * 0.12;
      jerryParts.stalks.forEach((s, i) => {
        s.rotation.x = Math.sin(now * 0.0027 + i * 2.1) * 0.16;
      });

      // Plaza ambience: pond bob + lantern glow pulse.
      pondGroup.position.y = Math.sin(now * 0.0015) * 0.03;
      plazaLanterns.forEach((l, i) => {
        const s = 1 + Math.sin(now * 0.002 + i * 1.3) * 0.08;
        l.scale.set(s, s, s);
      });

      // SnackFe alternating string-light pulse: even-index bulbs glow
      // out of phase with odd-index bulbs, giving that vibey twinkle.
      snackLights.forEach((b) => {
        const phase = b.hue === 0 ? 0 : Math.PI;
        const k = 0.6 + (Math.sin(now * 0.004 + phase) * 0.5 + 0.5) * 0.55;
        b.mat.opacity = 0.55 + k * 0.45;
        b.mesh.scale.setScalar(0.9 + k * 0.35);
      });
      snackInteriorLight.intensity = 18 + Math.sin(now * 0.0015) * 4;

      // Cardboard TV slideshow.
      tvTimer += dt;
      if (tvTimer > 7 && tvTextures.length > 0) {
        tvTimer = 0;
        tvIndex = (tvIndex + 1) % tvTextures.length;
        tvScreenMat.map = tvTextures[tvIndex];
        tvScreenMat.needsUpdate = true;
      }
    },
    starSpots,
    zipline: { x: centerX, z: centerZ, y: topY + ZIP_HEIGHT, radius: ZIP_RADIUS },
    jerry: new THREE.Vector3(centerX + 2, topY, centerZ + 22),
    snackfe: new THREE.Vector3(centerX + SNACK_X, topY, centerZ + SNACK_Z + SNACK_D / 2 + 1.4),
    setTvPhotos(urls) {
      const loader2 = new THREE.TextureLoader();
      loader2.setCrossOrigin("anonymous");
      urls.slice(0, 16).forEach((url) => {
        loader2.load(url, (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          tvTextures.push(t);
          // First photo takes over from the test pattern right away.
          if (tvTextures.length === 1) {
            tvScreenMat.map = t;
            tvScreenMat.needsUpdate = true;
          }
        });
      });
    },
  };
}
