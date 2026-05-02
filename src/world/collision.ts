import type { AABB, CollisionWorld } from "./types";

/**
 * Build a coarse spatial hash over static AABB obstacles for cheap
 * radius-based pushback. Buildings and trees use this; the player and
 * vehicle just call `resolve` after integrating their position.
 */
export function buildCollision(boxes: AABB[]): CollisionWorld {
  const CELL = 24;
  const grid = new Map<string, number[]>();
  const key = (cx: number, cz: number) => `${cx}|${cz}`;

  boxes.forEach((b, i) => {
    const x0 = Math.floor(b.minX / CELL);
    const x1 = Math.floor(b.maxX / CELL);
    const z0 = Math.floor(b.minZ / CELL);
    const z1 = Math.floor(b.maxZ / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = key(cx, cz);
        const arr = grid.get(k) ?? [];
        arr.push(i);
        grid.set(k, arr);
      }
    }
  });

  return {
    boxes,
    resolve(px, pz, radius) {
      const x0 = Math.floor((px - radius) / CELL);
      const x1 = Math.floor((px + radius) / CELL);
      const z0 = Math.floor((pz - radius) / CELL);
      const z1 = Math.floor((pz + radius) / CELL);
      let hit = false;
      let nx = px;
      let nz = pz;
      const seen = new Set<number>();
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const arr = grid.get(key(cx, cz));
          if (!arr) continue;
          for (const i of arr) {
            if (seen.has(i)) continue;
            seen.add(i);
            const b = boxes[i];
            // Closest point on AABB
            const cxp = Math.max(b.minX, Math.min(nx, b.maxX));
            const czp = Math.max(b.minZ, Math.min(nz, b.maxZ));
            const dx = nx - cxp;
            const dz = nz - czp;
            const d2 = dx * dx + dz * dz;
            if (d2 < radius * radius) {
              hit = true;
              if (d2 < 1e-6) {
                // Inside the box — push out along shortest axis to a face
                const distLeft = nx - b.minX;
                const distRight = b.maxX - nx;
                const distNear = nz - b.minZ;
                const distFar = b.maxZ - nz;
                const m = Math.min(distLeft, distRight, distNear, distFar);
                if (m === distLeft) nx = b.minX - radius;
                else if (m === distRight) nx = b.maxX + radius;
                else if (m === distNear) nz = b.minZ - radius;
                else nz = b.maxZ + radius;
              } else {
                const d = Math.sqrt(d2);
                const push = radius - d;
                nx += (dx / d) * push;
                nz += (dz / d) * push;
              }
            }
          }
        }
      }
      return { x: nx, z: nz, hit };
    },
  };
}
