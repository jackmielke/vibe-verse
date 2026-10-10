/**
 * Things you cannot walk through: houses, walls, towers, columns, trunks.
 *
 * Boxes (oriented, with a vertical range) and circles, in a coarse spatial
 * hash. `solve` pushes a point out of whatever it is inside, which is all the
 * player needs: there is nothing here that moves and blocks.
 */
export interface Box { kind: "box"; x: number; z: number; hw: number; hd: number; c: number; s: number; y0: number; y1: number }
export interface Circle { kind: "circle"; x: number; z: number; r: number; y0: number; y1: number }
type Shape = Box | Circle;

const CELL = 10;

export interface Colliders {
  box(x: number, z: number, w: number, d: number, rot: number, y0: number, y1: number): void;
  circle(x: number, z: number, r: number, y0: number, y1: number): void;
  /** A wall segment from a to b, `t` thick. */
  segment(ax: number, az: number, bx: number, bz: number, t: number, y0: number, y1: number): void;
  /** Push p (feet) out of anything it overlaps, for a body of radius r. */
  solve(p: { x: number; y: number; z: number }, r?: number): void;
  /** Is a point inside something (for placement)? */
  blocked(x: number, z: number, r: number, y: number): boolean;
  count(): number;
}

export function createColliders(): Colliders {
  const cells = new Map<number, Shape[]>();
  let n = 0;
  const key = (i: number, j: number) => (i + 1000) * 4000 + (j + 1000);
  const add = (s: Shape, rad: number) => {
    n++;
    const i0 = Math.floor((s.x - rad) / CELL), i1 = Math.floor((s.x + rad) / CELL);
    const j0 = Math.floor((s.z - rad) / CELL), j1 = Math.floor((s.z + rad) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = key(i, j);
      let list = cells.get(k);
      if (!list) { list = []; cells.set(k, list); }
      list.push(s);
    }
  };
  const near = (x: number, z: number): Shape[] => cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) ?? [];

  const push = (p: { x: number; y: number; z: number }, s: Shape, r: number): boolean => {
    if (p.y < s.y0 - 0.2 || p.y > s.y1 - 0.25) return false;
    if (s.kind === "circle") {
      const dx = p.x - s.x, dz = p.z - s.z;
      const d = Math.hypot(dx, dz), m = s.r + r;
      if (d >= m) return false;
      if (d > 1e-4) { const k = (m - d) / d; p.x += dx * k; p.z += dz * k; }
      else p.x += m;
      return true;
    }
    const dx = p.x - s.x, dz = p.z - s.z;
    const lx = dx * s.c + dz * s.s, lz = -dx * s.s + dz * s.c;
    const ox = s.hw + r - Math.abs(lx), oz = s.hd + r - Math.abs(lz);
    if (ox <= 0 || oz <= 0) return false;
    let nx = lx, nz = lz;
    if (ox < oz) nx = Math.sign(lx || 1) * (s.hw + r); else nz = Math.sign(lz || 1) * (s.hd + r);
    p.x = s.x + nx * s.c - nz * s.s;
    p.z = s.z + nx * s.s + nz * s.c;
    return true;
  };

  return {
    box(x, z, w, d, rot, y0, y1) {
      add({ kind: "box", x, z, hw: w / 2, hd: d / 2, c: Math.cos(rot), s: Math.sin(rot), y0, y1 }, Math.hypot(w, d) / 2);
    },
    circle(x, z, r, y0, y1) { add({ kind: "circle", x, z, r, y0, y1 }, r); },
    segment(ax, az, bx, bz, t, y0, y1) {
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.01) return;
      const rot = Math.atan2(bz - az, bx - ax);
      this.box((ax + bx) / 2, (az + bz) / 2, len, t, rot, y0, y1);
    },
    solve(p, r = 0.35) {
      for (let iter = 0; iter < 3; iter++) {
        let moved = false;
        for (const s of near(p.x, p.z)) if (push(p, s, r)) moved = true;
        if (!moved) break;
      }
    },
    blocked(x, z, r, y) {
      const p = { x, y, z };
      for (const s of near(x, z)) {
        const q = { ...p };
        if (push(q, s, r)) return true;
      }
      return false;
    },
    count: () => n,
  };
}
