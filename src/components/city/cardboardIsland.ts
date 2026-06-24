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
  /** The shop counter (modern kiosk behind the TV), in world coordinates. */
  shop: THREE.Vector3;
  /** Vibe Maker portal — players walk up to spawn 3D shapes that save
   *  to the database and appear for everyone on the island. */
  portal: THREE.Vector3;
  /** Avatar Hologram portal — players walk up to change their character. */
  avatarPortal: THREE.Vector3;
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
  // Moved off the plaza so it no longer crowds the spawn camera; tucked
  // into the NE lawn between the welcome path and the snack stand.
  const TREE_X = -14;
  const TREE_Z = 26;
  const tree = new THREE.Group();
  tree.position.set(TREE_X, 0, TREE_Z);
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
  starSpots.push(new THREE.Vector3(centerX + TREE_X, topY + 14.5, centerZ + TREE_Z));

  // ---- Welcome sign ------------------------------------------------
  // Sits on the far (north) side of the plaza so it reads as a backdrop
  // when you spawn looking across at Jerry. Two short side-posts hold
  // the boards up — no central pole crossing through the lettering.
  const welcome = new THREE.Group();
  welcome.position.set(0, 0, -18);
  // Two slim cardboard posts at the edges of the lower board, just tall
  // enough to meet its underside.
  [-2.4, 2.4].forEach((px) => {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.14, 1.3, 8),
      cardboardDark,
    );
    post.position.set(px, 0.65, 0);
    welcome.add(post);
  });
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
    // Face the spawn point at +z, so visitors read it across the plaza.
    board.rotation.y = 0;
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
  // Marker that rides with the seat — child positioned just above it
  // so a player parented/snapped here sits naturally on the plank.
  const swingSeatMarker = new THREE.Object3D();
  swingSeatMarker.position.y = -2.45;
  swingPivot.add(swingSeatMarker);
  swing.add(swingPivot);
  group.add(swing);
  let currentSwingAngle = 0;

  // ---- Jerry's Plaza ----------------------------------------------------
  // A real cardboard plaza built AROUND Jerry — modeled after the kids'
  // hand-painted reference: green-painted base, white cross paths, a blue
  // lily pond, planters of vines, benches, lanterns, and a JERRY'S PLAZA
  // archway you walk through to enter.
  const PLAZA_CX = 0;
  const PLAZA_CZ = 0;
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
    // West path entrance — rotated 90° from the south so the sign no
    // longer blocks the spawn camera's view of the player.
    archGroup.position.set(-(PLAZA_R + 0.3), 0, 0);
    archGroup.rotation.y = Math.PI / 2;
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
  jerryGroup.position.set(PLAZA_CX, 0.18, PLAZA_CZ); // sit at the center of the plaza pad
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
    // Tiny name plaque pinned to the front of the shell — small enough
    // that it doesn't tower over Jerry or block the plaza signs behind.
    const jerrySign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 0.42),
      new THREE.MeshBasicMaterial({
        map: signTexture(["JERRY"], "#eaa7c0", "#6a2c42"),
        side: THREE.DoubleSide,
      }),
    );
    jerrySign.position.set(0.68, 1.55, 0);
    jerrySign.rotation.y = Math.PI / 2; // face forward, same way as Jerry's head
    jerryGroup.add(jerrySign);
  }
  group.add(jerryGroup);

  // Jerry is solid — players (and roaming agents) bump off him instead
  // of walking through the snail mayor.
  {
    const JR = 1.8; // half-width footprint
    const JH = 2.6; // shell + head height
    boxes.push({
      minX: centerX + PLAZA_CX - JR,
      maxX: centerX + PLAZA_CX + JR,
      minZ: centerZ + PLAZA_CZ - JR,
      maxZ: centerZ + PLAZA_CZ + JR,
      base: topY,
      height: topY + JH,
    });
  }

  // ---- Cardboard TV: the island photo gallery ---------------------------
  const tv = new THREE.Group();
  tv.position.set(18, 0, 22);
  tv.rotation.y = Math.atan2(0 - 18, 0 - 22); // screen faces the plaza center
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

  // ---- Vibe Shop: a modern neon kiosk tucked behind the TV ------------
  // Sleek dark counter with mint signage. Player walks up to it from
  // the back-island side; proximity opens the shop dialog in /city.
  // Sits just to the right of SnackFae (from a player approaching the counter)
  // so you can see both at once when you walk up to grab a snack.
  const SHOP_X = 2;
  const SHOP_Z = 28;
  {
    const shopGroup = new THREE.Group();
    shopGroup.position.set(SHOP_X, 0, SHOP_Z);
    shopGroup.rotation.y = Math.PI; // counter faces -Z, same as SnackFae, toward island center

  const shopBody = new THREE.MeshStandardMaterial({ color: "#10141c", roughness: 0.4, metalness: 0.35 });
  const shopMint = new THREE.MeshStandardMaterial({
    color: "#2dd4a8",
    emissive: "#2dd4a8",
    emissiveIntensity: 1.4,
    roughness: 0.3,
  });
  const shopMagenta = new THREE.MeshStandardMaterial({
    color: "#e85d75",
    emissive: "#e85d75",
    emissiveIntensity: 1.2,
    roughness: 0.3,
  });
  // Counter
  const shopCounter = new THREE.Mesh(new THREE.BoxGeometry(5.2, 1.1, 1.8), shopBody);
  shopCounter.position.set(0, 0.55, 0);
  shopGroup.add(shopCounter);
  // Mint edge strip across the front of the counter
  const edge = new THREE.Mesh(new THREE.BoxGeometry(5.0, 0.08, 0.06), shopMint);
  edge.position.set(0, 0.5, 0.92);
  shopGroup.add(edge);
  // Back display wall
  const wall = new THREE.Mesh(new THREE.BoxGeometry(5.2, 3.0, 0.18), shopBody);
  wall.position.set(0, 2.6, -0.85);
  shopGroup.add(wall);
  // Awning roof
  const roof = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.18, 2.2), shopBody);
  roof.position.set(0, 4.15, 0);
  shopGroup.add(roof);
  // Roof underside neon strip
  const roofGlow = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.04, 0.08), shopMagenta);
  roofGlow.position.set(0, 4.04, 0.6);
  shopGroup.add(roofGlow);
  // Two display shelves on the back wall
  for (let i = 0; i < 2; i++) {
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.06, 0.5), shopBody);
    shelf.position.set(0, 2.0 + i * 1.0, -0.55);
    shopGroup.add(shelf);
  }
  // Floating "SHOP" sign (canvas texture)
  const signCanvas = document.createElement("canvas");
  signCanvas.width = 512;
  signCanvas.height = 128;
  const sctx = signCanvas.getContext("2d")!;
  sctx.fillStyle = "rgba(15, 18, 28, 0)";
  sctx.fillRect(0, 0, 512, 128);
  sctx.font = "bold 88px system-ui, sans-serif";
  sctx.textAlign = "center";
  sctx.textBaseline = "middle";
  sctx.shadowColor = "#2dd4a8";
  sctx.shadowBlur = 36;
  sctx.fillStyle = "#baffe9";
  sctx.fillText("VIBE SHOP", 256, 64);
  const signTex = new THREE.CanvasTexture(signCanvas);
  signTex.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(3.6, 0.9),
    new THREE.MeshBasicMaterial({ map: signTex, transparent: true, depthWrite: false }),
  );
  sign.position.set(0, 4.6, -0.7);
  shopGroup.add(sign);
  // Soft uplight inside the kiosk
  const shopLight = new THREE.PointLight(0x2dd4a8, 22, 14, 2);
  shopLight.position.set(0, 2.4, 0.3);
  shopGroup.add(shopLight);
  // Two little display pedestal items
  const pedHat = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.3, 16), shopBody);
  pedHat.position.set(-1.4, 2.18, -0.55);
  shopGroup.add(pedHat);
  const tinyHat = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.32, 18), shopMagenta);
  tinyHat.position.set(-1.4, 2.55, -0.55);
  shopGroup.add(tinyHat);
  const pedFlame = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.3, 16), shopBody);
  pedFlame.position.set(1.4, 2.18, -0.55);
  shopGroup.add(pedFlame);
  const tinyFlame = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.5, 12),
    new THREE.MeshBasicMaterial({ color: "#7dfce0", transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }),
  );
  tinyFlame.position.set(1.4, 2.6, -0.55);
  tinyFlame.rotation.x = Math.PI;
  shopGroup.add(tinyFlame);

    group.add(shopGroup);
  }

  // ---- Vibe Maker portal: a glowing ring tucked next to the shop -----
  // Walk up to it to open a mini "vibe coding" panel that spawns 3D
  // primitives saved to public.island_spawns. Everyone on the island
  // sees what you make; only you can delete your own creations.
  const PORTAL_X = -10;
  const PORTAL_Z = 26;
  const portalGroup = new THREE.Group();
  portalGroup.position.set(PORTAL_X, 0, PORTAL_Z);
  {
    const baseMat = new THREE.MeshStandardMaterial({
      color: "#0d1014",
      roughness: 0.55,
      metalness: 0.25,
    });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.8, 0.4, 24), baseMat);
    base.position.y = 0.2;
    portalGroup.add(base);

    const ringMat = new THREE.MeshBasicMaterial({
      color: "#b78aff",
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.13, 16, 48), ringMat);
    ring.position.y = 1.9;
    ring.rotation.x = Math.PI / 2;
    portalGroup.add(ring);

    const innerMat = new THREE.MeshBasicMaterial({
      color: "#2dd4a8",
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const inner = new THREE.Mesh(new THREE.CircleGeometry(1.22, 36), innerMat);
    inner.position.y = 1.9;
    inner.rotation.x = Math.PI / 2;
    portalGroup.add(inner);

    const portalLight = new THREE.PointLight(0xb78aff, 14, 12, 1.8);
    portalLight.position.set(0, 2, 0);
    portalGroup.add(portalLight);

    // Floating "VIBE MAKER" sign above the portal.
    const sc = document.createElement("canvas");
    sc.width = 512;
    sc.height = 128;
    const sx = sc.getContext("2d")!;
    sx.fillStyle = "rgba(0,0,0,0)";
    sx.fillRect(0, 0, 512, 128);
    sx.font = "bold 70px 'Sora', system-ui, sans-serif";
    sx.textAlign = "center";
    sx.textBaseline = "middle";
    sx.shadowColor = "#b78aff";
    sx.shadowBlur = 32;
    sx.fillStyle = "#f0e1ff";
    sx.fillText("VIBE MAKER", 256, 56);
    sx.shadowBlur = 0;
    sx.font = "22px 'Manrope', sans-serif";
    sx.fillStyle = "#2dd4a8";
    sx.fillText("spawn anything · saved for everyone", 256, 104);
    const signTex = new THREE.CanvasTexture(sc);
    signTex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 0.85),
      new THREE.MeshBasicMaterial({ map: signTex, transparent: true, depthWrite: false }),
    );
    sign.position.set(0, 3.7, 0);
    portalGroup.add(sign);
    // Make the sign always face the player-ish (billboard at update time).
    (portalGroup as unknown as { __sign: THREE.Mesh }).__sign = sign;
    (portalGroup as unknown as { __ring: THREE.Mesh }).__ring = ring;
    (portalGroup as unknown as { __inner: THREE.Mesh }).__inner = inner;
    (portalGroup as unknown as { __light: THREE.PointLight }).__light = portalLight;
  }
  group.add(portalGroup);

  // ---- Avatar Hologram portal: change your character ------------------
  // A glowing pedestal that projects a holographic figure made of stacked
  // glowing rings + scrolling scanlines. Walk up to it to open the
  // character picker. Sits on the opposite side of the Vibe Shop from
  // the Vibe Maker so the three form a little plaza row.
  // Perched on the roof of Trader Joe's (see SHOPS[0] at x=-30, z=-8, h=9).
  const AVATAR_X = -30;
  const AVATAR_Z = -8;
  const AVATAR_Y = 9; // Trader Joe's roof height (matches SHOPS[0].h)
  const avatarPortalGroup = new THREE.Group();
  avatarPortalGroup.position.set(AVATAR_X, AVATAR_Y, AVATAR_Z);
  const avatarHoloRings: THREE.Mesh[] = [];
  const avatarRingMats: THREE.MeshBasicMaterial[] = [];
  let avatarBeamMat!: THREE.MeshBasicMaterial;
  let avatarScanMat!: THREE.MeshBasicMaterial;
  let avatarOrbitRingA!: THREE.Mesh;
  let avatarOrbitRingB!: THREE.Mesh;
  let avatarPedestalLight!: THREE.PointLight;
  let avatarFigureGroup!: THREE.Group;
  {
    // Dark pedestal with a glowing mint top rim.
    const padMat = new THREE.MeshStandardMaterial({
      color: "#0a0f14",
      roughness: 0.4,
      metalness: 0.55,
    });
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.95, 0.5, 32), padMat);
    pad.position.y = 0.25;
    avatarPortalGroup.add(pad);

    const rimMat = new THREE.MeshBasicMaterial({
      color: "#2dd4a8",
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.05, 12, 64), rimMat);
    rim.position.y = 0.52;
    rim.rotation.x = Math.PI / 2;
    avatarPortalGroup.add(rim);

    // Vertical "projection beam" — translucent cyan cone pointing up.
    avatarBeamMat = new THREE.MeshBasicMaterial({
      color: "#7af0ff",
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const beam = new THREE.Mesh(new THREE.ConeGeometry(1.4, 4.2, 32, 1, true), avatarBeamMat);
    beam.position.y = 2.6;
    avatarPortalGroup.add(beam);

    // Scrolling scanline cylinder around the figure — gives it that
    // "data being projected" feel.
    const scanCanvas = document.createElement("canvas");
    scanCanvas.width = 16;
    scanCanvas.height = 256;
    const sctx = scanCanvas.getContext("2d")!;
    sctx.fillStyle = "rgba(0,0,0,0)";
    sctx.fillRect(0, 0, 16, 256);
    for (let y = 0; y < 256; y += 4) {
      sctx.fillStyle = `rgba(122, 240, 255, ${0.12 + Math.random() * 0.18})`;
      sctx.fillRect(0, y, 16, 1.5);
    }
    const scanTex = new THREE.CanvasTexture(scanCanvas);
    scanTex.wrapS = scanTex.wrapT = THREE.RepeatWrapping;
    scanTex.repeat.set(2, 1);
    avatarScanMat = new THREE.MeshBasicMaterial({
      map: scanTex,
      color: "#7af0ff",
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const scanCyl = new THREE.Mesh(
      new THREE.CylinderGeometry(1.05, 1.05, 3.6, 32, 1, true),
      avatarScanMat,
    );
    scanCyl.position.y = 2.3;
    avatarPortalGroup.add(scanCyl);

    // Holographic "figure" silhouette built from stacked discs of
    // varying radius — reads as a humanoid form without modelling one.
    avatarFigureGroup = new THREE.Group();
    avatarFigureGroup.position.y = 0.55;
    const figureSlices: Array<{ r: number; y: number }> = [
      { r: 0.42, y: 0.05 }, // feet
      { r: 0.55, y: 0.35 },
      { r: 0.65, y: 0.75 }, // hips
      { r: 0.72, y: 1.15 },
      { r: 0.78, y: 1.55 }, // chest
      { r: 0.72, y: 1.9 },
      { r: 0.55, y: 2.15 }, // shoulders
      { r: 0.35, y: 2.4 },
      { r: 0.42, y: 2.7 }, // head
      { r: 0.38, y: 2.95 },
    ];
    figureSlices.forEach((s, i) => {
      const mat = new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? "#7af0ff" : "#b78aff",
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      const disc = new THREE.Mesh(new THREE.TorusGeometry(s.r, 0.045, 10, 36), mat);
      disc.position.y = s.y;
      disc.rotation.x = Math.PI / 2;
      avatarFigureGroup.add(disc);
      avatarHoloRings.push(disc);
      avatarRingMats.push(mat);
    });
    avatarPortalGroup.add(avatarFigureGroup);

    // Two orbiting rings around the figure for that sci-fi UI vibe.
    const orbitMatA = new THREE.MeshBasicMaterial({
      color: "#2dd4a8",
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    avatarOrbitRingA = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.04, 10, 64), orbitMatA);
    avatarOrbitRingA.position.y = 1.8;
    avatarOrbitRingA.rotation.x = Math.PI / 2.3;
    avatarPortalGroup.add(avatarOrbitRingA);

    const orbitMatB = new THREE.MeshBasicMaterial({
      color: "#b78aff",
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    avatarOrbitRingB = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.03, 10, 64), orbitMatB);
    avatarOrbitRingB.position.y = 2.1;
    avatarOrbitRingB.rotation.x = Math.PI / 1.6;
    avatarPortalGroup.add(avatarOrbitRingB);

    avatarPedestalLight = new THREE.PointLight(0x7af0ff, 16, 14, 1.8);
    avatarPedestalLight.position.set(0, 1.6, 0);
    avatarPortalGroup.add(avatarPedestalLight);

    // Floating "AVATAR" sign above the beam.
    const ac = document.createElement("canvas");
    ac.width = 512;
    ac.height = 128;
    const ax = ac.getContext("2d")!;
    ax.fillStyle = "rgba(0,0,0,0)";
    ax.fillRect(0, 0, 512, 128);
    ax.font = "bold 70px 'Sora', system-ui, sans-serif";
    ax.textAlign = "center";
    ax.textBaseline = "middle";
    ax.shadowColor = "#7af0ff";
    ax.shadowBlur = 32;
    ax.fillStyle = "#e6fbff";
    ax.fillText("AVATAR", 256, 56);
    ax.shadowBlur = 0;
    ax.font = "22px 'Manrope', sans-serif";
    ax.fillStyle = "#2dd4a8";
    ax.fillText("step in to change your look", 256, 104);
    const aSignTex = new THREE.CanvasTexture(ac);
    aSignTex.colorSpace = THREE.SRGBColorSpace;
    const aSign = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 0.85),
      new THREE.MeshBasicMaterial({ map: aSignTex, transparent: true, depthWrite: false }),
    );
    aSign.position.set(0, 5.1, 0);
    avatarPortalGroup.add(aSign);
    (avatarPortalGroup as unknown as { __sign: THREE.Mesh }).__sign = aSign;
    (avatarPortalGroup as unknown as { __scanTex: THREE.CanvasTexture }).__scanTex = scanTex;
  }
  group.add(avatarPortalGroup);





  // ---- SnackFe: modern neon cafe ---------------------------------------
  // A sleek modern micro-cafe with alternating mint/magenta string lights
  // along the front awning. Walk up to it to order a snack.
  const SNACK_X = 12;
  const SNACK_Z = 28;
  const SNACK_W = 9;
  const SNACK_D = 6;
  const SNACK_H = 4.4;
  const snackGroup = new THREE.Group();
  snackGroup.position.set(SNACK_X, 0, SNACK_Z);
  // Rotate so the service window faces inward toward the plaza/center.
  snackGroup.rotation.y = Math.PI;

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
      currentSwingAngle = Math.sin(now * 0.0013) * 0.52;
      swingPivot.rotation.x = currentSwingAngle;
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

      // Vibe Maker portal: ring spin + light pulse.
      const pg = portalGroup as unknown as {
        __ring: THREE.Mesh;
        __inner: THREE.Mesh;
        __light: THREE.PointLight;
      };
      pg.__ring.rotation.z += dt * 0.6;
      pg.__inner.rotation.z -= dt * 0.3;
      pg.__light.intensity = 12 + Math.sin(now * 0.003) * 4;

      // Avatar Hologram portal: orbiting rings + figure float + scanline scroll.
      avatarOrbitRingA.rotation.z += dt * 0.9;
      avatarOrbitRingB.rotation.z -= dt * 0.5;
      avatarOrbitRingB.rotation.x = Math.PI / 1.6 + Math.sin(now * 0.0012) * 0.25;
      const aFloat = Math.sin(now * 0.0022) * 0.08;
      avatarFigureGroup.position.y = 0.55 + aFloat;
      avatarFigureGroup.rotation.y = now * 0.0006;
      const aPulse = 0.45 + (Math.sin(now * 0.004) * 0.5 + 0.5) * 0.3;
      avatarRingMats.forEach((m, i) => {
        m.opacity = 0.35 + aPulse + (i % 3) * 0.04;
      });
      avatarBeamMat.opacity = 0.1 + (Math.sin(now * 0.0025) * 0.5 + 0.5) * 0.12;
      avatarPedestalLight.intensity = 14 + Math.sin(now * 0.003) * 5;
      const apg = avatarPortalGroup as unknown as { __scanTex: THREE.CanvasTexture };
      apg.__scanTex.offset.y = -(now * 0.00035) % 1;
      avatarScanMat.opacity = 0.45 + Math.sin(now * 0.0035) * 0.18;



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
    jerry: new THREE.Vector3(centerX, topY, centerZ),
    snackfe: new THREE.Vector3(centerX + SNACK_X, topY, centerZ + SNACK_Z - SNACK_D / 2 - 1.4),
    swingMount: new THREE.Vector3(centerX + -13, topY, centerZ + -12 + 2.5),
    swingSeat: swingSeatMarker,
    swingAngle: () => currentSwingAngle,
    shop: new THREE.Vector3(centerX + SHOP_X, topY, centerZ + SHOP_Z - 2.3),
    portal: new THREE.Vector3(centerX + PORTAL_X, topY, centerZ + PORTAL_Z),
    avatarPortal: new THREE.Vector3(centerX + AVATAR_X, topY, centerZ + AVATAR_Z),
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
