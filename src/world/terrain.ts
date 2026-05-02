import * as THREE from "three";

export const WORLD_SIZE = 800;
export const BLOCK = 90; // block + road repeat
export const ROAD = 14; // road width (drivable)
export const SIDEWALK = 4; // sidewalk inside each block edge

// Even count of blocks across so origin is an intersection
export const BLOCKS_PER_SIDE = 6;
export const GRID_HALF = (BLOCKS_PER_SIDE * BLOCK) / 2;

export interface TerrainHandles {
  group: THREE.Group;
  isOnRoad: (x: number, z: number) => boolean;
  buildableBlocks: { cx: number; cz: number; size: number }[];
}

function buildGrassTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  // base
  ctx.fillStyle = "#3a6f3a";
  ctx.fillRect(0, 0, 256, 256);
  // dapples
  for (let i = 0; i < 1400; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const r = Math.random() * 3 + 1;
    const shade = Math.random();
    ctx.fillStyle =
      shade < 0.4 ? "#2c5b2c" : shade < 0.75 ? "#4a8a4a" : "#6fb56f";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(WORLD_SIZE / 8, WORLD_SIZE / 8);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.anisotropy = 4;
  return tex;
}

function buildRoadTexture() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#2a2a2e";
  ctx.fillRect(0, 0, 64, 256);
  // asphalt noise
  for (let i = 0; i < 600; i++) {
    ctx.fillStyle =
      Math.random() < 0.5 ? "rgba(255,255,255,0.025)" : "rgba(0,0,0,0.04)";
    ctx.fillRect(Math.random() * 64, Math.random() * 256, 1, 1);
  }
  // center dashed line
  ctx.fillStyle = "#f4d35e";
  for (let y = 0; y < 256; y += 32) {
    ctx.fillRect(31, y, 2, 16);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  return tex;
}

function buildSidewalkTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#bcbcb6";
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = "#8a8a85";
  ctx.lineWidth = 2;
  for (let i = 0; i <= 64; i += 16) {
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(64, i);
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 64);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

export function createTerrain(scene: THREE.Scene): TerrainHandles {
  const group = new THREE.Group();

  // Ground (grass)
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE),
    new THREE.MeshLambertMaterial({ map: buildGrassTexture() }),
  );
  grass.rotation.x = -Math.PI / 2;
  grass.receiveShadow = true;
  group.add(grass);

  // Road plane covering the city footprint, then we cut-out blocks above it
  // by overlaying sidewalks + lifted block ground
  const cityCover = BLOCKS_PER_SIDE * BLOCK;
  const roadTex = buildRoadTexture();
  roadTex.repeat.set(cityCover / 8, cityCover / 8);
  const roadPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(cityCover, cityCover),
    new THREE.MeshLambertMaterial({ map: roadTex }),
  );
  roadPlane.rotation.x = -Math.PI / 2;
  roadPlane.position.y = 0.02;
  roadPlane.receiveShadow = true;
  group.add(roadPlane);

  // Block ground (sidewalks + interior pavement)
  const sidewalkTex = buildSidewalkTexture();
  sidewalkTex.repeat.set(2, 2);
  const sidewalkMat = new THREE.MeshLambertMaterial({ map: sidewalkTex });
  const interiorMat = new THREE.MeshLambertMaterial({ color: "#557a3f" });

  const buildableBlocks: { cx: number; cz: number; size: number }[] = [];
  const blockInner = BLOCK - ROAD;

  for (let bx = 0; bx < BLOCKS_PER_SIDE; bx++) {
    for (let bz = 0; bz < BLOCKS_PER_SIDE; bz++) {
      const cx = -GRID_HALF + bx * BLOCK + BLOCK / 2;
      const cz = -GRID_HALF + bz * BLOCK + BLOCK / 2;

      // Sidewalk slab (full block minus road border)
      const sw = new THREE.Mesh(
        new THREE.BoxGeometry(blockInner, 0.2, blockInner),
        sidewalkMat,
      );
      sw.position.set(cx, 0.1, cz);
      sw.receiveShadow = true;
      group.add(sw);

      // Slightly inset green/garden interior so buildings sit on a curb edge
      const innerSize = blockInner - SIDEWALK * 2;
      if (innerSize > 4) {
        const inner = new THREE.Mesh(
          new THREE.BoxGeometry(innerSize, 0.21, innerSize),
          interiorMat,
        );
        inner.position.set(cx, 0.115, cz);
        inner.receiveShadow = true;
        group.add(inner);
        buildableBlocks.push({ cx, cz, size: innerSize });
      }
    }
  }

  scene.add(group);

  const isOnRoad = (x: number, z: number) => {
    if (Math.abs(x) > GRID_HALF || Math.abs(z) > GRID_HALF) return false;
    // Distance from nearest grid line
    const dx = Math.abs(((x + GRID_HALF) % BLOCK) - BLOCK / 2);
    const dz = Math.abs(((z + GRID_HALF) % BLOCK) - BLOCK / 2);
    return dx > (blockInner / 2) - 0.01 || dz > (blockInner / 2) - 0.01;
  };

  return { group, isOnRoad, buildableBlocks };
}
