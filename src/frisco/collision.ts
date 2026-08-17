/**
 * collision.ts — what you can stand on and what you cannot walk through.
 *
 * The city is nine thousand boxes and they never move, so this is a uniform
 * grid built once at load: a bucket per 48 m cell holding the indices of the
 * buildings that overlap it. Every query touches one bucket. There is no
 * broadphase to rebuild, no tree to balance and no per-frame cost at all,
 * which is the recurring benefit of a world that is a diorama rather than a
 * simulation.
 *
 * Three things about the shapes, and each of them is a bug that got reported
 * as "the physics feel wrong":
 *
 * **Buildings are oriented boxes, not axis-aligned ones.** The two street grids
 * meet at 37 degrees, so half the city is rotated relative to the other half,
 * and testing against the AABBs would put invisible walls across the pavement
 * on every SoMa corner.
 *
 * **They taper.** A collider is a frustum, not a prism: the footprint is
 * interpolated between `hw/hd` at the base and `topHw/topHd` at the roof. What
 * you *stand on* is the roof footprint, and what you *bump into* is the
 * footprint at the height of your feet. Using one number for both is what makes
 * a setback tower feel like it has a sheet of glass sticking out of it.
 *
 * **Some of them are round.** Salesforce Tower is a 42 m circle; as a 42 m
 * square its four corners were a fifth of the roof area with nothing under
 * them. Round buildings get an ellipse test and a radial push-out, which is
 * three lines and fixes landing on every cylinder in the world.
 */
import type { BuildingBox } from "./city";
import { walkHeight } from "./map";

const CELL = 48;

/** Local-frame half-extents of a building at a given world height. */
function extentsAt(b: BuildingBox, y: number): { hw: number; hd: number } {
  const topHw = b.topHw ?? b.hw;
  const topHd = b.topHd ?? b.hd;
  if (topHw === b.hw && topHd === b.hd) return { hw: b.hw, hd: b.hd };
  const span = b.roofY - b.baseY;
  const t = span <= 0 ? 1 : Math.max(0, Math.min(1, (y - b.baseY) / span));
  return { hw: b.hw + (topHw - b.hw) * t, hd: b.hd + (topHd - b.hd) * t };
}

/** Rotate a world point into a building's own frame. */
function local(x: number, z: number, b: BuildingBox): { lx: number; lz: number } {
  const c = Math.cos(-b.yaw);
  const s = Math.sin(-b.yaw);
  const dx = x - b.x;
  const dz = z - b.z;
  return { lx: dx * c - dz * s, lz: dx * s + dz * c };
}

/** Inside the footprint of extents `hw × hd`, padded? */
function within(lx: number, lz: number, hw: number, hd: number, round: boolean, pad: number): boolean {
  const ex = hw + pad;
  const ez = hd + pad;
  if (ex <= 0 || ez <= 0) return false;
  if (round) {
    const u = lx / ex;
    const v = lz / ez;
    return u * u + v * v <= 1;
  }
  return Math.abs(lx) <= ex && Math.abs(lz) <= ez;
}

export class CityCollision {
  private readonly boxes: BuildingBox[];
  private readonly cells = new Map<number, number[]>();

  /**
   * Boxes that move, tested on every query in addition to the grid.
   *
   * There are two of them — the cable cars — and that is the entire design
   * rationale for handling them this way. Putting a moving box into a uniform
   * grid means removing and re-inserting it every frame, which is a rebuild
   * cost and a whole class of stale-bucket bug, for a list short enough to scan
   * linearly a hundred thousand times a second. If this ever holds more than a
   * dozen things it wants a real broadphase; at two it wants an array.
   */
  readonly dynamic: BuildingBox[] = [];

  constructor(boxes: BuildingBox[]) {
    this.boxes = boxes;
    boxes.forEach((b, i) => {
      // A conservative AABB of the oriented box: big enough is correct here,
      // exact would only save a handful of misses per query. The widest of base
      // and roof, because a building can flare outward as well as taper in.
      const r = Math.hypot(Math.max(b.hw, b.topHw ?? b.hw), Math.max(b.hd, b.topHd ?? b.hd));
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
   *
   * Tested against the ROOF footprint, which is the surface in question. Doing
   * it against the base footprint is the bug that puts you standing in mid-air
   * beside a tapered tower, and it is the one that gets reported.
   */
  supportAt(x: number, z: number, ceiling: number): number {
    let best = walkHeight(x, z);
    const test = (b: BuildingBox) => {
      if (b.roofY > ceiling || b.roofY <= best) return;
      const { lx, lz } = local(x, z, b);
      const top = extentsAt(b, b.roofY);
      if (!within(lx, lz, top.hw, top.hd, b.round === true, 0)) return;
      best = b.roofY;
    };
    for (const i of this.near(x, z, this.scratch)) test(this.boxes[i]);
    for (const b of this.dynamic) test(b);
    return best;
  }

  /**
   * Which dynamic box, if any, is holding up a character standing at this
   * height — the question "am I on the cable car".
   *
   * A small tolerance rather than an exact match because the player's Y is set
   * from `supportAt` on the previous frame and the platform has moved since.
   */
  standingOn(x: number, y: number, z: number): BuildingBox | null {
    for (const b of this.dynamic) {
      if (Math.abs(y - b.roofY) > 0.45) continue;
      const { lx, lz } = local(x, z, b);
      const top = extentsAt(b, b.roofY);
      if (within(lx, lz, top.hw, top.hd, b.round === true, 0.1)) return b;
    }
    return null;
  }

  /**
   * Slide a position out of any building it has entered.
   *
   * Least-penetration along the box's own axes for a rectangular building — it
   * is what makes running into a wall at an angle slide you along it instead of
   * stopping you dead, and what stops a corner from flinging you across the
   * street. For a round one it is a push along the radius, which is the same
   * idea and simpler.
   *
   * The footprint is taken at the height of the FEET, so walking around a
   * tapered tower at the fortieth floor tests the fortieth floor's outline
   * rather than the ground floor's.
   */
  resolve(pos: { x: number; z: number }, feetY: number, radius: number): boolean {
    let hit = false;
    const list = this.scratch;
    this.near(pos.x, pos.z, list);
    const total = list.length + this.dynamic.length;
    for (let n = 0; n < total; n++) {
      const b = n < list.length ? this.boxes[list[n]] : this.dynamic[n - list.length];
      // Standing on the roof is not colliding with the building.
      if (feetY > b.roofY - 0.4) continue;
      if (feetY + 2.2 < b.baseY) continue;
      const { lx, lz } = local(pos.x, pos.z, b);
      const at = extentsAt(b, feetY);
      const ex = at.hw + radius;
      const ez = at.hd + radius;
      if (ex <= 0 || ez <= 0) continue;

      let nlx = lx;
      let nlz = lz;
      if (b.round === true) {
        const u = lx / ex;
        const v = lz / ez;
        const d = Math.hypot(u, v);
        if (d >= 1 || d === 0) continue;
        // Out along the radius to the ellipse. Scaling the normalised
        // coordinates keeps the push perpendicular to the wall in the space the
        // wall is a circle in, which is what "slide around a tower" needs.
        nlx = (u / d) * ex;
        nlz = (v / d) * ez;
      } else {
        const penX = ex - Math.abs(lx);
        const penZ = ez - Math.abs(lz);
        if (penX <= 0 || penZ <= 0) continue;
        if (penX < penZ) nlx = lx >= 0 ? ex : -ex;
        else nlz = lz >= 0 ? ez : -ez;
      }

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
    const test = (b: BuildingBox) => {
      if (y < b.baseY - 1 || y > b.roofY) return false;
      const { lx, lz } = local(x, z, b);
      const at = extentsAt(b, y);
      return within(lx, lz, at.hw, at.hd, b.round === true, 0.2);
    };
    for (const i of this.near(x, z, this.scratch)) if (test(this.boxes[i])) return true;
    /* Dynamic boxes are deliberately NOT tested here. `occupied` is what keeps
       the third-person camera out of walls, and a cable car is the one solid
       thing in the world you are expected to be standing *on* — treating it as
       a wall shoves the camera onto the back of your head for the whole ride,
       which is the worst view of the best thing here. You collide with the car
       (`resolve`) and stand on it (`supportAt`); the camera sees through it. */
    return false;
  }

  /** Roof height directly over a point, or null. */
  roofOver(x: number, z: number): number | null {
    let best: number | null = null;
    for (const i of this.near(x, z, this.scratch)) {
      const b = this.boxes[i];
      const { lx, lz } = local(x, z, b);
      const top = extentsAt(b, b.roofY);
      if (!within(lx, lz, top.hw, top.hd, b.round === true, 0)) continue;
      if (best === null || b.roofY > best) best = b.roofY;
    }
    return best;
  }
}

function key(cx: number, cz: number): number {
  return ((cx + 4096) << 13) | (cz + 4096);
}
