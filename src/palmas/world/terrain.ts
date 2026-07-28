/**
 * San Palmas — terrain.
 *
 * The San Palmas landmass: SF hills, coastline and bay floor. Publishes TerrainService.
 *
 * STUB: placeholder implementation. Replaced by the dedicated module author.
 */
import * as THREE from "three";
import type { System, SystemFactory, TerrainService } from "../types";

const WORLD_SIZE = 3000;
const SEA_LEVEL = 0;

const createTerrain: SystemFactory = (ctx) => {
  const heightAt = (x: number, z: number) => {
    // Placeholder hills so the world is walkable before the real heightfield lands.
    const h = Math.sin(x * 0.0016) * Math.cos(z * 0.0014) * 55 + Math.sin(x * 0.006 + z * 0.004) * 8;
    const coast = Math.max(0, 1 - Math.hypot(x, z) / WORLD_SIZE);
    return h * coast + coast * 30 - 12;
  };

  const seg = 256;
  const geo = new THREE.PlaneGeometry(WORLD_SIZE * 2, WORLD_SIZE * 2, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  }
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x5f7f4a, roughness: 0.95 }));
  mesh.receiveShadow = true;
  ctx.scene.add(mesh);

  const service: TerrainService = {
    heightAt,
    normalAt(x, z, out = new THREE.Vector3()) {
      const e = 1.5;
      const hL = heightAt(x - e, z), hR = heightAt(x + e, z);
      const hD = heightAt(x, z - e), hU = heightAt(x, z + e);
      return out.set(hL - hR, 2 * e, hD - hU).normalize();
    },
    isWater(x, z) { return heightAt(x, z) < SEA_LEVEL; },
    worldSize: WORLD_SIZE,
    seaLevel: SEA_LEVEL,
  };
  ctx.services.terrain = service;

  const sys: System = { name: "terrain", dispose() { geo.dispose(); (mesh.material as THREE.Material).dispose(); } };
  return sys;
};

export default createTerrain;
