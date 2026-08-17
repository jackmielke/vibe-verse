/**
 * collision.ts — what you can stand on and what you cannot walk through.
 *
 * The city is eleven hundred boxes and they never move, so this is a uniform
 * grid built once at load: a bucket per 48 m cell holding the indices of the
 * buildings that overlap it. Every query touches one bucket. There is no
 * broadphase to rebuild, no tree to balance and no per-frame cost at all,
 * which is the recurring benefit of a world that is a diorama rather than a
 * simulation.
 *
 * Buildings are oriented boxes, not axis-aligned ones — the two street grids
 * meet at 37 degrees, so half the city is rotated relative to the other half,
 * and testing against the AABBs would put invisible walls across the pavement
 * on every SoMa corner.
 */
import type { BuildingBox } from "./city";
import { walkHeight } from "./map";

const CELL = 48;

export class CityCollision {
  private readonly boxes: BuildingBox[];
  private readonly cells = new Map<number, number[]>();

  constructor(boxes: BuildingBox[]) {
    this.boxes = boxes;
    boxes.forEach((b, i) => {
      // A conservative AABB of the oriented box: big enough is correct here,
      // exact would only save a handful of misses per query.
      const r = Math.hypot(b.hw, b.hd);
      const x0 = Math.floor((b.x - r) / CELL);
      const x1 = Math.floor((b.x + r) / CELL);
      const z0 = Math.floor((b.z - r) / CELL);
      const z1 = Math.floor((b.z + r) / CELL);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = key(cx, cz);
          let list = this.cells.get(k);
          if (!list) this.cells.set(k, (list = []));
          list.push(i);
        }
      }
    });
  }

  private near(x: number, z: number, out: number[]): number[] {
    out.length = 0;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const list = this.cells.get(key(cx + i, cz + j));
        if (list) out.push(...list);
      }
    }
    return out;
  }

  private scratch: number[] = [];

  /**
   * The highest surface at or below `ceiling` a character could stand on:
   * a roof if they are over one, the ground otherwise.
   *
   * The ceiling is what stops walking down a street from teleporting you onto
   * the roof beside you — only surfaces within a step are candidates while
   * grounded — and while falling, the feet pass down through the candidates in
   * order and land on the first one.
   */
  supportAt(x: number, z: number, ceiling: number): number {
    let best = walkHeight(x, z);
    for (const i of this.near(x, z, this.scratch)) {
      const b = this.boxes[i];
      if (b.roofY > ceiling || b.roofY <= best) continue;
      if (!inside(x, z, b, 0)) continue;
      best = b.roofY;
    }
    return best;
  }

  /**
   * Slide a position out of any building it has entered.
   *
   * Least-penetration along the box's own axes: it is what makes running into
   * a wall at an angle slide you along it instead of stopping you dead, and
   * what stops a corner from flinging you across the street.
   */
  resolve(pos: { x: number; z: number }, feetY: number, radius: number): boolean {
    let hit = false;
    for (const i of this.near(pos.x, pos.z, this.scratch)) {
      const b = this.boxes[i];
      // Standing on the roof is not colliding with the building.
      if (feetY > b.roofY - 0.4) continue;
      if (feetY + 2.2 < b.baseY) continue;
      const c = Math.cos(-b.yaw);
      const s = Math.sin(-b.yaw);
      const dx = pos.x - b.x;
      const dz = pos.z - b.z;
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      const ex = b.hw + radius;
      const ez = b.hd + radius;
      const penX = ex - Math.abs(lx);
      const penZ = ez - Math.abs(lz);
      if (penX <= 0 || penZ <= 0) continue;
      let nlx = lx;
      let nlz = lz;
      if (penX < penZ) nlx = lx >= 0 ? ex : -ex;
      else nlz = lz >= 0 ? ez : -ez;
      const ci = Math.cos(b.yaw);
      const si = Math.sin(b.yaw);
      pos.x = b.x + (nlx * ci - nlz * si);
      pos.z = b.z + (nlx * si + nlz * ci);
      hit = true;
    }
    return hit;
  }

  /** Is this point inside a building? Used to keep the camera out of walls. */
  occupied(x: number, y: number, z: number): boolean {
    if (y < walkHeight(x, z) + 0.4) return true;
    for (const i of this.near(x, z, this.scratch)) {
      const b = this.boxes[i];
      if (y < b.baseY - 1 || y > b.roofY) continue;
      if (inside(x, z, b, 0.2)) return true;
    }
    return false;
  }

  /** Roof height directly over a point, or null. Used by the ring courses. */
  roofOver(x: number, z: number): number | null {
    let best: number | null = null;
    for (const i of this.near(x, z, this.scratch)) {
      const b = this.boxes[i];
      if (!inside(x, z, b, 0)) continue;
      if (best === null || b.roofY > best) best = b.roofY;
    }
    return best;
  }
}

function key(cx: number, cz: number): number {
  return ((cx + 4096) << 13) | (cz + 4096);
}

function inside(x: number, z: number, b: BuildingBox, pad: number): boolean {
  const c = Math.cos(-b.yaw);
  const s = Math.sin(-b.yaw);
  const dx = x - b.x;
  const dz = z - b.z;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= b.hw + pad && Math.abs(lz) <= b.hd + pad;
}
