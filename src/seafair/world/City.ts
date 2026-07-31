import * as THREE from "three";
import { mulberry32, cachedGeometry, canvasTexture } from "../core/Assets";
import type { QualityProfile } from "../core/Settings";
import type { TerrainRig } from "./Terrain";
import type { Collider } from "../entities/Player";

/**
 * Future Seattle skyline, seen across the lake and up the bluff. Built from
 * instanced towers with emissive window sheets so a thousand buildings cost a
 * handful of draw calls. 2117 silhouette: the existing downtown core plus
 * arcology megastructures and skybridges.
 */

export interface CityRig {
  group: THREE.Group;
  colliders: Collider[];
  update: (dt: number, elapsed: number) => void;
  dispose: () => void;
}

interface TowerSpec {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  rot: number;
  kind: "glass" | "concrete" | "arcology";
}

export function createCity(
  scene: THREE.Scene,
  profile: QualityProfile,
  terrain: TerrainRig,
): CityRig {
  const group = new THREE.Group();
  group.name = "city";
  scene.add(group);

  const rnd = mulberry32(20117);
  const specs: TowerSpec[] = [];

  // Downtown core sits north-west across the water, centred ~(-900, 1500).
  const CORE = new THREE.Vector2(-820, 1560);
  const count = Math.round(210 * THREE.MathUtils.clamp(profile.crowdDensity + 0.4, 0.5, 1.6));

  for (let i = 0; i < count; i++) {
    // Cluster density falls off from the core with a heavy tail.
    const ang = rnd() * Math.PI * 2;
    const r = Math.pow(rnd(), 0.6) * 1150;
    const x = CORE.x + Math.cos(ang) * r;
    const z = CORE.y + Math.sin(ang) * r * 0.72;

    const coreFactor = 1 - THREE.MathUtils.clamp(r / 1150, 0, 1);
    const base = 40 + Math.pow(rnd(), 2.4) * 220;
    const h = base * (0.45 + coreFactor * 1.55);

    const w = 18 + rnd() * 34 + coreFactor * 22;
    const d = 18 + rnd() * 34 + coreFactor * 22;

    const kind: TowerSpec["kind"] =
      coreFactor > 0.72 && rnd() > 0.55 ? "arcology" : rnd() > 0.42 ? "glass" : "concrete";

    specs.push({ x, z, w, d, h, rot: rnd() * Math.PI, kind });
  }

  // Hand-placed landmarks so the silhouette reads as Seattle.
  specs.push({ x: CORE.x + 40, z: CORE.y - 60, w: 62, d: 62, h: 484, rot: 0.2, kind: "glass" }); // Columbia Center
  specs.push({ x: CORE.x - 130, z: CORE.y + 30, w: 54, d: 54, h: 366, rot: 0.5, kind: "glass" });
  specs.push({ x: CORE.x + 180, z: CORE.y + 120, w: 70, d: 48, h: 312, rot: -0.3, kind: "arcology" });

  const box = cachedGeometry("tower-box", () => new THREE.BoxGeometry(1, 1, 1));

  // Window/facade texture: emissive grid that reads as lit floors at distance.
  const S = Math.min(profile.textureSize, 512);
  const facade = canvasTexture(
    "city-facade",
    S,
    (ctx, s) => {
      ctx.fillStyle = "#1b232c";
      ctx.fillRect(0, 0, s, s);
      const cols = 16;
      const rows = 24;
      const cw = s / cols;
      const ch = s / rows;
      const r2 = mulberry32(7);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const lit = r2() > 0.62;
          const v = lit ? 0.55 + r2() * 0.45 : 0.06 + r2() * 0.08;
          const warm = r2() > 0.5;
          const rr = Math.round(255 * v * (warm ? 1 : 0.72));
          const gg = Math.round(255 * v * (warm ? 0.9 : 0.86));
          const bb = Math.round(255 * v * (warm ? 0.68 : 1));
          ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
          ctx.fillRect(x * cw + cw * 0.14, y * ch + ch * 0.18, cw * 0.72, ch * 0.58);
        }
      }
      // mullion darkening
      ctx.strokeStyle = "rgba(10,14,18,0.75)";
      ctx.lineWidth = Math.max(1, s / 256);
      for (let x = 0; x <= cols; x++) {
        ctx.beginPath();
        ctx.moveTo(x * cw, 0);
        ctx.lineTo(x * cw, s);
        ctx.stroke();
      }
      for (let y = 0; y <= rows; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * ch);
        ctx.lineTo(s, y * ch);
        ctx.stroke();
      }
    },
    { repeat: 1 },
  );

  const materials: Record<TowerSpec["kind"], THREE.MeshStandardMaterial> = {
    glass: new THREE.MeshStandardMaterial({
      map: facade,
      color: 0x9fb6c9,
      roughness: 0.16,
      metalness: 0.72,
      emissive: 0x0d1a24,
      emissiveIntensity: 0.6,
      emissiveMap: facade,
    }),
    concrete: new THREE.MeshStandardMaterial({
      map: facade,
      color: 0xb3aca2,
      roughness: 0.78,
      metalness: 0.04,
      emissive: 0x120e0a,
      emissiveIntensity: 0.28,
      emissiveMap: facade,
    }),
    arcology: new THREE.MeshStandardMaterial({
      map: facade,
      color: 0x7fa2b8,
      roughness: 0.3,
      metalness: 0.55,
      emissive: 0x0a2c3d,
      emissiveIntensity: 1.05,
      emissiveMap: facade,
    }),
  };

  const byKind: Record<string, TowerSpec[]> = { glass: [], concrete: [], arcology: [] };
  specs.forEach((s) => byKind[s.kind].push(s));

  const dummy = new THREE.Object3D();
  for (const kind of Object.keys(byKind) as TowerSpec["kind"][]) {
    const list = byKind[kind];
    if (!list.length) continue;
    const inst = new THREE.InstancedMesh(box, materials[kind], list.length);
    inst.castShadow = false;
    inst.receiveShadow = false;
    list.forEach((s, i) => {
      const groundY = terrain.height(s.x, s.z);
      dummy.position.set(s.x, groundY + s.h / 2, s.z);
      dummy.rotation.set(0, s.rot, 0);
      dummy.scale.set(s.w, s.h, s.d);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = true;
    group.add(inst);
  }

  // Aircraft warning beacons on the tallest towers — subtle life at distance.
  const beaconGeo = cachedGeometry("beacon", () => new THREE.SphereGeometry(2.6, 8, 6));
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff3322, toneMapped: false });
  const tall = specs.filter((s) => s.h > 190).slice(0, 40);
  const beacons = new THREE.InstancedMesh(beaconGeo, beaconMat, tall.length);
  tall.forEach((s, i) => {
    dummy.position.set(s.x, terrain.height(s.x, s.z) + s.h + 3, s.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    beacons.setMatrixAt(i, dummy.matrix);
  });
  beacons.instanceMatrix.needsUpdate = true;
  group.add(beacons);

  let t = 0;
  const update = (dt: number) => {
    t += dt;
    // Beacons pulse together at ~0.7Hz, like real obstruction lighting.
    const pulse = 0.35 + 0.65 * Math.pow(Math.max(0, Math.sin(t * 4.4)), 6);
    beaconMat.color.setRGB(pulse, pulse * 0.16, pulse * 0.1);
  };

  return {
    group,
    colliders: [],
    update,
    dispose: () => {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      Object.values(materials).forEach((m) => m.dispose());
      beaconMat.dispose();
      scene.remove(group);
    },
  };
}
