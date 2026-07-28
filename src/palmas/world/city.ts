/**
 * San Palmas — the city.
 *
 * Street grid, Victorians, downtown towers, piers. Publishes CollisionService.
 *
 * STUB: placeholder implementation. Replaced by the dedicated module author.
 */
import * as THREE from "three";
import type { CollisionService, RayHit, System, SystemFactory } from "../types";

const createCity: SystemFactory = (ctx) => {
  const boxes: { box: THREE.Box3; tag?: string }[] = [];

  const service: CollisionService = {
    addBox(box, opts) { boxes.push({ box: box.clone(), tag: opts?.tag }); },
    resolveCapsule(pos, radius, height) {
      let hit = false;
      for (const { box } of boxes) {
        if (pos.x < box.min.x - radius || pos.x > box.max.x + radius) continue;
        if (pos.z < box.min.z - radius || pos.z > box.max.z + radius) continue;
        if (pos.y + height < box.min.y || pos.y > box.max.y) continue;
        // Push out along the shallowest axis.
        const dxMin = pos.x - (box.min.x - radius);
        const dxMax = box.max.x + radius - pos.x;
        const dzMin = pos.z - (box.min.z - radius);
        const dzMax = box.max.z + radius - pos.z;
        const m = Math.min(dxMin, dxMax, dzMin, dzMax);
        if (m === dxMin) pos.x = box.min.x - radius;
        else if (m === dxMax) pos.x = box.max.x + radius;
        else if (m === dzMin) pos.z = box.min.z - radius;
        else pos.z = box.max.z + radius;
        hit = true;
      }
      return hit;
    },
    raycast(origin, dir, maxDist): RayHit | null {
      const ray = new THREE.Ray(origin.clone(), dir.clone().normalize());
      let best: RayHit | null = null;
      const p = new THREE.Vector3();
      for (const { box, tag } of boxes) {
        if (!ray.intersectBox(box, p)) continue;
        const d = origin.distanceTo(p);
        if (d > maxDist || (best && d >= best.distance)) continue;
        const n = new THREE.Vector3(0, 1, 0);
        const c = box.getCenter(new THREE.Vector3());
        const local = p.clone().sub(c);
        const size = box.getSize(new THREE.Vector3());
        const ax = Math.abs(local.x) / size.x, ay = Math.abs(local.y) / size.y, az = Math.abs(local.z) / size.z;
        if (ax > ay && ax > az) n.set(Math.sign(local.x), 0, 0);
        else if (az > ay) n.set(0, 0, Math.sign(local.z));
        else n.set(0, Math.sign(local.y), 0);
        best = { point: p.clone(), normal: n, distance: d, tag };
      }
      return best;
    },
  };
  ctx.services.collision = service;

  const sys: System = { name: "city" };
  return sys;
};

export default createCity;
