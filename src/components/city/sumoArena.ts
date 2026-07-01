/**
 * sumoArena — SPLASH SUMO: a circular ring on stilts over the open ocean
 * south of the city. Last one standing wins.
 *
 * Rules (enforced by City.tsx):
 *   - Jetpacks die inside the arena zone — Space becomes a plain jump.
 *   - Shoving uses the existing multiplayer bump mechanics: run into
 *     people (pushFrom) and remote bumps shove you back.
 *   - Fall off and you SPLASH into the water: KO + respawn on the
 *     spectator dock next door. Walk of shame, rematch, repeat.
 *
 * The module only builds geometry + colliders; the KO/no-jetpack logic
 * lives with the rest of the physics in City.tsx.
 */
import * as THREE from "three";
import type { WorldBox } from "./cardboardIsland";

export const SUMO_X = 0;
export const SUMO_Z = 430;
export const SUMO_TOP = 12; // ring surface Y
export const SUMO_RING_R = 13; // playable circle
/** Radius of the "no jetpack" bubble around the ring (checked with y < 40). */
export const SUMO_ZONE_R = 44;
/** Respawn point on the spectator dock after a splash KO in the zone. */
export const SUMO_RESPAWN = new THREE.Vector3(0, SUMO_TOP + 2, SUMO_Z + 24);

export interface SumoArenaWorld {
  group: THREE.Group;
  update(dt: number, now: number): void;
}

export function buildSumoArena({ boxes }: { boxes: WorldBox[] }): SumoArenaWorld {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x9a7146, roughness: 0.95 });
  const woodDark = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 1 });

  // ---- The ring: a clay-topped drum on wooden stilts -----------------
  const drum = new THREE.Mesh(
    new THREE.CylinderGeometry(SUMO_RING_R, SUMO_RING_R * 0.92, 2.2, 36),
    new THREE.MeshStandardMaterial({ color: 0xc8a15f, roughness: 0.9 }),
  );
  drum.position.set(SUMO_X, SUMO_TOP - 1.1, SUMO_Z);
  drum.castShadow = true;
  drum.receiveShadow = true;
  g.add(drum);

  // Painted boundary circle (step over it at your peril).
  const boundary = new THREE.Mesh(
    new THREE.RingGeometry(SUMO_RING_R - 1.6, SUMO_RING_R - 0.9, 48),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }),
  );
  boundary.rotation.x = -Math.PI / 2;
  boundary.position.set(SUMO_X, SUMO_TOP + 0.02, SUMO_Z);
  g.add(boundary);
  const innerMark = new THREE.Mesh(
    new THREE.CircleGeometry(1.1, 24),
    new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.8 }),
  );
  innerMark.rotation.x = -Math.PI / 2;
  innerMark.position.set(SUMO_X, SUMO_TOP + 0.02, SUMO_Z);
  g.add(innerMark);

  // Stilts down into the sea.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const r = SUMO_RING_R * 0.7;
    const stilt = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, SUMO_TOP + 2, 8), woodDark);
    stilt.position.set(SUMO_X + Math.cos(a) * r, (SUMO_TOP - 2) / 2, SUMO_Z + Math.sin(a) * r);
    g.add(stilt);
  }

  // Corner rope posts with sagging ropes (decor only — the whole point
  // is that there's nothing stopping you going over the edge).
  const ropeMat = new THREE.MeshStandardMaterial({ color: 0xd8cbb0, roughness: 1 });
  const postPts: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const px = SUMO_X + Math.cos(a) * (SUMO_RING_R - 0.6);
    const pz = SUMO_Z + Math.sin(a) * (SUMO_RING_R - 0.6);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 1.4, 6), woodDark);
    post.position.set(px, SUMO_TOP + 0.7, pz);
    g.add(post);
    postPts.push(new THREE.Vector3(px, SUMO_TOP + 1.3, pz));
  }
  for (let i = 0; i < 4; i++) {
    const a0 = postPts[i];
    const a1 = postPts[(i + 1) % 4];
    const mid = a0.clone().lerp(a1, 0.5);
    mid.y -= 0.25; // sag
    const curve = new THREE.QuadraticBezierCurve3(a0, mid, a1);
    const rope = new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.05, 5), ropeMat);
    g.add(rope);
  }

  // ---- Spectator dock (and post-splash respawn spot) -----------------
  const dock = new THREE.Mesh(new THREE.BoxGeometry(8, 0.5, 12), wood);
  dock.position.set(SUMO_X, SUMO_TOP - 0.25, SUMO_Z + 26);
  dock.receiveShadow = true;
  g.add(dock);
  // Plank bridge from dock to ring.
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.3, 8), wood);
  bridge.position.set(SUMO_X, SUMO_TOP - 0.15, SUMO_Z + 16.5);
  g.add(bridge);
  for (const [bx, bz] of [[-3, 20], [3, 20], [-3, 32], [3, 32]] as const) {
    const stilt = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, SUMO_TOP + 2, 6), woodDark);
    stilt.position.set(SUMO_X + bx, (SUMO_TOP - 2) / 2, SUMO_Z + bz);
    g.add(stilt);
  }

  // ---- Sign: SPLASH SUMO, canvas-painted like the city marquee -------
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 160;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#2a1c10";
  ctx.fillRect(0, 0, 512, 160);
  ctx.strokeStyle = "#c8a15f";
  ctx.lineWidth = 10;
  ctx.strokeRect(8, 8, 496, 144);
  ctx.fillStyle = "#ffd35c";
  ctx.font = "bold 64px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("SPLASH SUMO", 256, 62);
  ctx.fillStyle = "#e8dcc8";
  ctx.font = "28px system-ui, sans-serif";
  ctx.fillText("no jetpacks · last one dry wins", 256, 118);
  const signTex = new THREE.CanvasTexture(canvas);
  signTex.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Mesh(
    new THREE.BoxGeometry(7, 2.2, 0.25),
    [
      woodDark, woodDark, woodDark, woodDark,
      new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.7 }),
      woodDark,
    ],
  );
  sign.position.set(SUMO_X, SUMO_TOP + 4.2, SUMO_Z + 31);
  g.add(sign);
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 3.4, 6), woodDark);
    leg.position.set(SUMO_X + side * 3, SUMO_TOP + 1.7, SUMO_Z + 31);
    g.add(leg);
  }

  // Torch posts on the dock corners with a warm flicker.
  const flames: THREE.MeshStandardMaterial[] = [];
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 2.4, 6), woodDark);
    post.position.set(SUMO_X + side * 3.4, SUMO_TOP + 1.2, SUMO_Z + 21);
    g.add(post);
    const flameMat = new THREE.MeshStandardMaterial({
      color: 0xffcf6e,
      emissive: 0xff8a1e,
      emissiveIntensity: 1.6,
    });
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.7, 7), flameMat);
    flame.position.set(SUMO_X + side * 3.4, SUMO_TOP + 2.7, SUMO_Z + 21);
    g.add(flame);
    flames.push(flameMat);
  }

  // ---- Colliders (height = ABSOLUTE top Y) ---------------------------
  // Ring: a square inset inside the circle so the last step really is air.
  const ringHalf = SUMO_RING_R * 0.72;
  boxes.push({
    minX: SUMO_X - ringHalf,
    maxX: SUMO_X + ringHalf,
    minZ: SUMO_Z - ringHalf,
    maxZ: SUMO_Z + ringHalf,
    base: SUMO_TOP - 2.2,
    height: SUMO_TOP,
  });
  // Dock + bridge.
  boxes.push({
    minX: SUMO_X - 4,
    maxX: SUMO_X + 4,
    minZ: SUMO_Z + 20,
    maxZ: SUMO_Z + 32,
    base: SUMO_TOP - 0.5,
    height: SUMO_TOP,
  });
  boxes.push({
    minX: SUMO_X - 1.1,
    maxX: SUMO_X + 1.1,
    minZ: SUMO_Z + 12.5,
    maxZ: SUMO_Z + 20.5,
    base: SUMO_TOP - 0.4,
    height: SUMO_TOP,
  });

  return {
    group: g,
    update(_dt, now) {
      const t = now * 0.001;
      for (let i = 0; i < flames.length; i++) {
        flames[i].emissiveIntensity = 1.6 + Math.sin(t * 9 + i * 2.4) * 0.5;
      }
    },
  };
}
