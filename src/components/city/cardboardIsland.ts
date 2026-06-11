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
  {
    lines: ["JERRY'S", "PLAZA"],
    x: 8, z: 30, w: 10, h: 6, d: 8,
    bg: "#bcd6e8", fg: "#2a5a8a",
  },
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
    { lines: ["WELCOME TO", "CARDBOARD ISLAND"], y: 4.7, w: 7, h: 2.9, bg: "#e8d9b8", fg: "#5a3a1a" },
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
    },
    starSpots,
  };
}
