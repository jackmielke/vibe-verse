import * as THREE from "three";
import { BLOCK, BLOCKS_PER_SIDE, GRID_HALF, SIDEWALK } from "./terrain";
import type { AABB } from "./types";

export interface CityHandles {
  group: THREE.Group;
  obstacles: AABB[];
  landmarks: { name: string; x: number; z: number }[];
  setNightFactor: (n: number) => void;
}

const PALETTE = [
  "#c8a36a", // sandstone
  "#a37458", // adobe
  "#7d8aa1", // cool grey
  "#9b6a8a", // mauve
  "#5a7d6e", // sage
  "#b04e4e", // terracotta
  "#3d6b8a", // deep teal-blue
  "#8a8a3d", // ochre
];

const ACCENT = "#2dd4a8"; // EE mint

// Procedurally generated tiled window texture. Windows light up at night
// via a separate emissive canvas.
function buildWindowTextures(rng: () => number) {
  const W = 256;
  const H = 256;
  const cellsX = 6;
  const cellsY = 7;

  const day = document.createElement("canvas");
  day.width = W;
  day.height = H;
  const dctx = day.getContext("2d")!;

  const night = document.createElement("canvas");
  night.width = W;
  night.height = H;
  const nctx = night.getContext("2d")!;

  // Wall base
  dctx.fillStyle = "#ffffff";
  dctx.fillRect(0, 0, W, H);
  nctx.fillStyle = "#000000";
  nctx.fillRect(0, 0, W, H);

  const cw = W / cellsX;
  const ch = H / cellsY;
  for (let y = 0; y < cellsY; y++) {
    for (let x = 0; x < cellsX; x++) {
      const px = x * cw + cw * 0.18;
      const py = y * ch + ch * 0.18;
      const ww = cw * 0.64;
      const wh = ch * 0.55;

      // Day window — dim teal-blue glass
      dctx.fillStyle = "#1c2a3a";
      dctx.fillRect(px, py, ww, wh);
      dctx.fillStyle = "rgba(180, 220, 240, 0.25)";
      dctx.fillRect(px + 2, py + 2, ww - 4, 4);

      // Night emissive — random lit / unlit
      const lit = rng() > 0.45;
      if (lit) {
        const warm = rng() > 0.25;
        nctx.fillStyle = warm ? "#ffd58a" : "#7fe0c8";
        nctx.fillRect(px, py, ww, wh);
        nctx.fillStyle = "rgba(0,0,0,0.25)";
        // suggest curtains/silhouettes
        if (rng() > 0.6) {
          nctx.fillRect(px, py, ww * (0.2 + rng() * 0.4), wh);
        }
      }
    }
  }

  const dayTex = new THREE.CanvasTexture(day);
  const nightTex = new THREE.CanvasTexture(night);
  dayTex.wrapS = dayTex.wrapT = THREE.RepeatWrapping;
  nightTex.wrapS = nightTex.wrapT = THREE.RepeatWrapping;
  dayTex.magFilter = THREE.NearestFilter;
  nightTex.magFilter = THREE.NearestFilter;
  return { dayTex, nightTex };
}

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

interface BuildingSpec {
  cx: number;
  cz: number;
  w: number;
  d: number;
  h: number;
  color: string;
  hasSign?: string;
}

export interface CityOptions {
  buildableBlocks: { cx: number; cz: number; size: number }[];
}

const NAMED_BLOCKS: Record<string, { name: string; color: string; height: number; landmark?: "temple" | "dome" | "stage" | "fountain" }> = {
  // mapped by `${bx}|${bz}` index; placed below
};

export function createCity(scene: THREE.Scene, opts: CityOptions): CityHandles {
  const group = new THREE.Group();
  const obstacles: AABB[] = [];
  const landmarks: { name: string; x: number; z: number }[] = [];

  const rng = mulberry32(0xed6e);
  const { dayTex, nightTex } = buildWindowTextures(rng);

  // Materials reused across buildings
  const wallMaterials = PALETTE.map(
    (c) =>
      new THREE.MeshLambertMaterial({
        map: dayTex.clone(),
        emissiveMap: nightTex.clone(),
        emissive: new THREE.Color("#ffe1a8"),
        emissiveIntensity: 0,
        color: new THREE.Color(c),
      }),
  );
  // Each cloned tex needs needsUpdate
  wallMaterials.forEach((m) => {
    if (m.map) m.map.needsUpdate = true;
    if (m.emissiveMap) m.emissiveMap.needsUpdate = true;
  });

  const roofMat = new THREE.MeshLambertMaterial({ color: "#3a3a40" });
  const accentMat = new THREE.MeshLambertMaterial({
    color: ACCENT,
    emissive: ACCENT,
    emissiveIntensity: 0.4,
  });

  // Pick named landmark blocks (interesting positions, not edges)
  const c = BLOCKS_PER_SIDE;
  const idx = (bx: number, bz: number) => `${bx}|${bz}`;
  const named: Record<string, { name: string; landmark?: "temple" | "dome" | "stage" | "fountain" | "plaza" | "grove" }> = {
    [idx(Math.floor(c / 2), Math.floor(c / 2))]: { name: "Central Plaza", landmark: "fountain" },
    [idx(Math.floor(c / 2) - 1, Math.floor(c / 2) + 1)]: { name: "Meditation Temple", landmark: "temple" },
    [idx(Math.floor(c / 2) + 1, Math.floor(c / 2) - 1)]: { name: "Observatory", landmark: "dome" },
    [idx(1, c - 2)]: { name: "Main Stage", landmark: "stage" },
    [idx(c - 2, 1)]: { name: "The Grove", landmark: "grove" },
    [idx(2, 1)]: { name: "Hacker House" },
    [idx(c - 2, c - 2)]: { name: "Dining Hall" },
    [idx(1, 2)]: { name: "Pool Deck" },
    [idx(c - 3, 2)]: { name: "Art Studio" },
    [idx(2, c - 2)]: { name: "Co-working Barn" },
  };

  const addBoxBuilding = (b: BuildingSpec) => {
    const matIdx = Math.floor(rng() * wallMaterials.length);
    const baseMat = wallMaterials[matIdx];
    const wallMat = baseMat.clone();
    // Per-building tex repeat so windows scale with floors (1 floor = ~3.5m)
    if (wallMat.map) {
      wallMat.map = wallMat.map.clone();
      wallMat.map.needsUpdate = true;
      const floors = Math.max(1, Math.round(b.h / 3.5));
      const wraps = Math.max(1, Math.round(Math.max(b.w, b.d) / 4));
      wallMat.map.wrapS = wallMat.map.wrapT = THREE.RepeatWrapping;
      wallMat.map.repeat.set(wraps, floors);
    }
    if (wallMat.emissiveMap) {
      wallMat.emissiveMap = wallMat.emissiveMap.clone();
      wallMat.emissiveMap.needsUpdate = true;
      const floors = Math.max(1, Math.round(b.h / 3.5));
      const wraps = Math.max(1, Math.round(Math.max(b.w, b.d) / 4));
      wallMat.emissiveMap.wrapS = wallMat.emissiveMap.wrapT = THREE.RepeatWrapping;
      wallMat.emissiveMap.repeat.set(wraps, floors);
    }
    wallMat.color = new THREE.Color(b.color);

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), wallMat);
    mesh.position.set(b.cx, b.h / 2 + 0.22, b.cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    // Roof slab
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(b.w + 0.4, 0.4, b.d + 0.4),
      roofMat,
    );
    roof.position.set(b.cx, b.h + 0.4, b.cz);
    roof.castShadow = true;
    group.add(roof);

    obstacles.push({
      minX: b.cx - b.w / 2,
      maxX: b.cx + b.w / 2,
      minZ: b.cz - b.d / 2,
      maxZ: b.cz + b.d / 2,
    });

    if (b.hasSign) {
      addSign(b.cx, b.cz, b.h, b.w, b.d, b.hasSign);
    }
  };

  const addSign = (cx: number, cz: number, h: number, w: number, d: number, text: string) => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 96;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#0d1b2a";
    ctx.fillRect(0, 0, 512, 96);
    ctx.fillStyle = ACCENT;
    ctx.font = "bold 56px Sora, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text.toUpperCase(), 256, 50);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 4;
    ctx.strokeRect(8, 8, 512 - 16, 96 - 16);
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
    });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(w * 0.8, 14), 2.6), mat);
    sign.position.set(cx, h - 1.6, cz + d / 2 + 0.05);
    group.add(sign);

    // back side
    const back = sign.clone();
    back.position.z = cz - d / 2 - 0.05;
    back.rotation.y = Math.PI;
    group.add(back);
  };

  const addLandmark = (name: string, type: string, cx: number, cz: number, blockSize: number) => {
    landmarks.push({ name, x: cx, z: cz });

    if (type === "fountain") {
      // Plaza tile
      const plazaMat = new THREE.MeshLambertMaterial({ color: "#d8c8a8" });
      const plaza = new THREE.Mesh(
        new THREE.BoxGeometry(blockSize, 0.05, blockSize),
        plazaMat,
      );
      plaza.position.set(cx, 0.13, cz);
      plaza.receiveShadow = true;
      group.add(plaza);

      // Fountain ring + water
      const ring = new THREE.Mesh(
        new THREE.CylinderGeometry(5, 5.5, 1.2, 32),
        new THREE.MeshLambertMaterial({ color: "#bcbcb6" }),
      );
      ring.position.set(cx, 0.6, cz);
      ring.castShadow = true;
      ring.receiveShadow = true;
      group.add(ring);
      const water = new THREE.Mesh(
        new THREE.CylinderGeometry(4.6, 4.6, 0.1, 32),
        new THREE.MeshLambertMaterial({
          color: "#3aa6c7",
          emissive: "#1a4f6a",
          emissiveIntensity: 0.4,
        }),
      );
      water.position.set(cx, 1.2, cz);
      group.add(water);
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.6, 2.4, 12),
        accentMat,
      );
      stem.position.set(cx, 2.4, cz);
      group.add(stem);
      const top = new THREE.Mesh(
        new THREE.SphereGeometry(0.7, 16, 12),
        accentMat,
      );
      top.position.set(cx, 3.8, cz);
      group.add(top);

      obstacles.push({
        minX: cx - 5.5,
        maxX: cx + 5.5,
        minZ: cz - 5.5,
        maxZ: cz + 5.5,
      });
    } else if (type === "dome") {
      const baseH = 6;
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(7, 8, baseH, 24),
        new THREE.MeshLambertMaterial({ color: "#8a8a85" }),
      );
      base.position.set(cx, baseH / 2 + 0.22, cz);
      base.castShadow = true;
      base.receiveShadow = true;
      group.add(base);
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(7, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshLambertMaterial({
          color: "#e6e6dc",
          emissive: "#2dd4a8",
          emissiveIntensity: 0.05,
        }),
      );
      dome.position.set(cx, baseH + 0.22, cz);
      dome.castShadow = true;
      group.add(dome);
      // slit
      const slit = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 6.5, 14),
        new THREE.MeshBasicMaterial({ color: "#0d1b2a" }),
      );
      slit.position.set(cx, baseH + 3.5, cz);
      group.add(slit);
      addSign(cx, cz, baseH + 6, 16, 16, "Observatory");
      obstacles.push({ minX: cx - 8, maxX: cx + 8, minZ: cz - 8, maxZ: cz + 8 });
    } else if (type === "temple") {
      const tiers = 3;
      const tierMat = new THREE.MeshLambertMaterial({ color: "#a04a3a" });
      const wallMat = new THREE.MeshLambertMaterial({ color: "#e8d8b0" });
      const totalBase = 9;
      let y = 0.22;
      for (let i = 0; i < tiers; i++) {
        const sz = totalBase - i * 2;
        const wall = new THREE.Mesh(
          new THREE.BoxGeometry(sz, 2.6, sz),
          wallMat,
        );
        wall.position.set(cx, y + 1.3, cz);
        wall.castShadow = true;
        wall.receiveShadow = true;
        group.add(wall);
        const roof = new THREE.Mesh(
          new THREE.ConeGeometry(sz * 0.85, 1.5, 4),
          tierMat,
        );
        roof.rotation.y = Math.PI / 4;
        roof.position.set(cx, y + 2.8, cz);
        roof.castShadow = true;
        group.add(roof);
        y += 3.4;
      }
      const finial = new THREE.Mesh(
        new THREE.ConeGeometry(0.4, 1.6, 8),
        accentMat,
      );
      finial.position.set(cx, y + 0.6, cz);
      group.add(finial);
      addSign(cx, cz, y + 1.2, 14, 14, "Meditation Temple");
      obstacles.push({
        minX: cx - totalBase / 2,
        maxX: cx + totalBase / 2,
        minZ: cz - totalBase / 2,
        maxZ: cz + totalBase / 2,
      });
    } else if (type === "stage") {
      const deck = new THREE.Mesh(
        new THREE.BoxGeometry(16, 1.2, 10),
        new THREE.MeshLambertMaterial({ color: "#3d2a1a" }),
      );
      deck.position.set(cx, 0.6, cz);
      deck.castShadow = true;
      deck.receiveShadow = true;
      group.add(deck);
      // back wall
      const back = new THREE.Mesh(
        new THREE.BoxGeometry(16, 6, 0.6),
        new THREE.MeshLambertMaterial({ color: "#0d1b2a" }),
      );
      back.position.set(cx, 3, cz - 4.7);
      back.castShadow = true;
      group.add(back);
      // arch — half cylinder over the stage
      const arch = new THREE.Mesh(
        new THREE.TorusGeometry(8, 0.5, 12, 32, Math.PI),
        accentMat,
      );
      arch.rotation.x = Math.PI / 2;
      arch.rotation.z = Math.PI / 2;
      arch.position.set(cx, 1.2, cz);
      group.add(arch);
      // truss lights
      for (let i = -6; i <= 6; i += 3) {
        const lamp = new THREE.Mesh(
          new THREE.SphereGeometry(0.25, 8, 8),
          new THREE.MeshBasicMaterial({ color: "#fff3c2" }),
        );
        lamp.position.set(cx + i, 7.5, cz);
        group.add(lamp);
      }
      addSign(cx, cz, 9, 16, 0.6, "Main Stage");
      obstacles.push({ minX: cx - 8, maxX: cx + 8, minZ: cz - 5, maxZ: cz + 5 });
    } else if (type === "grove") {
      const trunkMat = new THREE.MeshLambertMaterial({ color: "#5a3a22" });
      const leafMat = new THREE.MeshLambertMaterial({ color: "#3a7a3a" });
      for (let i = 0; i < 24; i++) {
        const tx = cx + (rng() - 0.5) * (blockSize - 4);
        const tz = cz + (rng() - 0.5) * (blockSize - 4);
        const trunk = new THREE.Mesh(
          new THREE.CylinderGeometry(0.3, 0.4, 3.2, 6),
          trunkMat,
        );
        trunk.position.set(tx, 1.6, tz);
        trunk.castShadow = true;
        group.add(trunk);
        const leaves = new THREE.Mesh(
          new THREE.ConeGeometry(2 + rng(), 5 + rng() * 2, 6),
          leafMat,
        );
        leaves.position.set(tx, 5, tz);
        leaves.castShadow = true;
        group.add(leaves);
      }
      // central bench area, no obstacle needed
    }
  };

  // Place blocks
  for (let bx = 0; bx < BLOCKS_PER_SIDE; bx++) {
    for (let bz = 0; bz < BLOCKS_PER_SIDE; bz++) {
      const cx = -GRID_HALF + bx * BLOCK + BLOCK / 2;
      const cz = -GRID_HALF + bz * BLOCK + BLOCK / 2;
      const blockSize = BLOCK - (14 + SIDEWALK * 2); // matches inner

      const key = idx(bx, bz);
      const tag = named[key];

      if (tag?.landmark) {
        addLandmark(tag.name, tag.landmark, cx, cz, blockSize);
        continue;
      }

      // Decide a pattern: 1 large building, or 2-4 smaller ones
      const pattern = rng();
      const buildings: BuildingSpec[] = [];
      if (pattern < 0.35) {
        buildings.push({
          cx,
          cz,
          w: blockSize - 4,
          d: blockSize - 4,
          h: 14 + rng() * 30,
          color: PALETTE[Math.floor(rng() * PALETTE.length)],
          hasSign: tag?.name,
        });
      } else if (pattern < 0.7) {
        // 2 across
        const half = (blockSize - 6) / 2;
        const horiz = rng() > 0.5;
        for (let i = 0; i < 2; i++) {
          buildings.push({
            cx: horiz ? cx + (i === 0 ? -half / 2 - 1.5 : half / 2 + 1.5) : cx,
            cz: horiz ? cz : cz + (i === 0 ? -half / 2 - 1.5 : half / 2 + 1.5),
            w: horiz ? half : blockSize - 4,
            d: horiz ? blockSize - 4 : half,
            h: 8 + rng() * 36,
            color: PALETTE[Math.floor(rng() * PALETTE.length)],
            hasSign: i === 0 ? tag?.name : undefined,
          });
        }
      } else {
        // 4 quadrants
        const half = (blockSize - 6) / 2;
        for (let i = 0; i < 4; i++) {
          const sx = i % 2 === 0 ? -1 : 1;
          const sz = i < 2 ? -1 : 1;
          buildings.push({
            cx: cx + (sx * (half / 2 + 1.5)),
            cz: cz + (sz * (half / 2 + 1.5)),
            w: half,
            d: half,
            h: 6 + rng() * 28,
            color: PALETTE[Math.floor(rng() * PALETTE.length)],
            hasSign: i === 0 ? tag?.name : undefined,
          });
        }
      }

      buildings.forEach(addBoxBuilding);
      if (tag?.name) landmarks.push({ name: tag.name, x: cx, z: cz });
    }
  }

  scene.add(group);

  // Suppress unused-args warning when no opts passed
  void opts;

  return {
    group,
    obstacles,
    landmarks,
    setNightFactor(n: number) {
      // n in 0..1; 1 = full night
      wallMaterials.forEach((m) => {
        m.emissiveIntensity = n * 1.1;
      });
      // Update cloned materials placed on actual meshes
      group.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          const mat = mesh.material as THREE.Material | THREE.Material[];
          const list = Array.isArray(mat) ? mat : [mat];
          list.forEach((mm) => {
            if ((mm as THREE.MeshLambertMaterial).emissiveMap) {
              (mm as THREE.MeshLambertMaterial).emissiveIntensity = n * 1.1;
            }
          });
        }
      });
    },
  };
}
