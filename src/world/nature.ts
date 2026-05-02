import * as THREE from "three";
import { GRID_HALF, WORLD_SIZE } from "./terrain";
import type { AABB } from "./types";

export interface NatureHandles {
  group: THREE.Group;
  obstacles: AABB[];
}

function rand(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x9e3779b9;
    let r = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    r = Math.imul(r ^ (r >>> 15), 0x735a2d97);
    return ((r ^ (r >>> 15)) >>> 0) / 4294967296;
  };
}

export function createNature(scene: THREE.Scene): NatureHandles {
  const group = new THREE.Group();
  const obstacles: AABB[] = [];
  const rng = rand(0x53);

  // -------- Pine forest belts (corners + edges) --------
  const pineTrunk = new THREE.MeshLambertMaterial({ color: "#3d2a1a" });
  const pineLeaves = new THREE.MeshLambertMaterial({ color: "#23552a" });
  const trunkGeom = new THREE.CylinderGeometry(0.4, 0.55, 4, 6);
  const leafGeoms = [
    new THREE.ConeGeometry(2.4, 7, 7),
    new THREE.ConeGeometry(2.0, 6, 7),
    new THREE.ConeGeometry(2.8, 8, 7),
  ];

  const treeCount = 320;
  // Trees are placed outside the city grid only
  for (let i = 0; i < treeCount; i++) {
    let x = 0;
    let z = 0;
    let tries = 0;
    do {
      x = (rng() - 0.5) * WORLD_SIZE;
      z = (rng() - 0.5) * WORLD_SIZE;
      tries++;
    } while (
      Math.abs(x) < GRID_HALF + 8 &&
      Math.abs(z) < GRID_HALF + 8 &&
      tries < 8
    );
    if (Math.abs(x) < GRID_HALF + 8 && Math.abs(z) < GRID_HALF + 8) continue;

    const trunk = new THREE.Mesh(trunkGeom, pineTrunk);
    trunk.position.set(x, 2, z);
    trunk.castShadow = true;
    group.add(trunk);

    const lg = leafGeoms[Math.floor(rng() * leafGeoms.length)];
    const leaves = new THREE.Mesh(lg, pineLeaves);
    leaves.position.set(x, 6.5 + rng() * 1.5, z);
    leaves.castShadow = true;
    group.add(leaves);

    obstacles.push({ minX: x - 1, maxX: x + 1, minZ: z - 1, maxZ: z + 1 });
  }

  // -------- Vineyards (one big patch off to the south-west) --------
  const vineMat = new THREE.MeshLambertMaterial({ color: "#5a8a4a" });
  const postMat = new THREE.MeshLambertMaterial({ color: "#7a5a3a" });
  const wireMat = new THREE.MeshBasicMaterial({ color: "#3a2a22" });

  const vineyardCenter = new THREE.Vector2(-GRID_HALF - 90, GRID_HALF + 70);
  const rows = 12;
  const rowLen = 70;
  const rowSpacing = 4;
  for (let r = 0; r < rows; r++) {
    const z = vineyardCenter.y + (r - rows / 2) * rowSpacing;
    // Trellis posts every 6m
    for (let p = -rowLen / 2; p <= rowLen / 2; p += 6) {
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.15, 1.8, 0.15),
        postMat,
      );
      post.position.set(vineyardCenter.x + p, 0.9, z);
      post.castShadow = true;
      group.add(post);
    }
    // Wire (a flat thin line)
    const wire = new THREE.Mesh(
      new THREE.BoxGeometry(rowLen, 0.04, 0.04),
      wireMat,
    );
    wire.position.set(vineyardCenter.x, 1.6, z);
    group.add(wire);
    // Vines: a chain of small green boxes along the wire
    for (let p = -rowLen / 2 + 0.5; p <= rowLen / 2; p += 1.0) {
      const leaf = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.9, 0.6),
        vineMat,
      );
      leaf.position.set(vineyardCenter.x + p, 1.2, z);
      group.add(leaf);
    }
  }

  // -------- Hill with a single redwood (cinematic) --------
  const hill = new THREE.Mesh(
    new THREE.SphereGeometry(28, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: "#3a6f3a" }),
  );
  hill.scale.y = 0.35;
  hill.position.set(GRID_HALF + 90, 0, -GRID_HALF - 90);
  hill.receiveShadow = true;
  group.add(hill);
  const redwood = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 1.4, 22, 8),
    new THREE.MeshLambertMaterial({ color: "#3d2a1a" }),
  );
  redwood.position.copy(hill.position);
  redwood.position.y = 11 + 9.8;
  redwood.castShadow = true;
  group.add(redwood);
  const redwoodLeaves = new THREE.Mesh(
    new THREE.ConeGeometry(7, 18, 8),
    new THREE.MeshLambertMaterial({ color: "#1f4a26" }),
  );
  redwoodLeaves.position.copy(hill.position);
  redwoodLeaves.position.y = 11 + 22;
  redwoodLeaves.castShadow = true;
  group.add(redwoodLeaves);

  scene.add(group);
  return { group, obstacles };
}
