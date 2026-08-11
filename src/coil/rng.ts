/**
 * Seeded random, so an arena lays itself out the same way twice.
 *
 * Same mulberry32 as `src/blob/rng.ts`. Copied rather than shared on purpose:
 * the house rule in this repo is that a world owns everything under its own
 * directory, and four lines of arithmetic is a cheaper thing to duplicate than
 * a dependency between two worlds is to maintain. If a third world wants it,
 * that is the moment it earns a home in `src/shared`.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    // Zero is a fixed point for this generator, so fold it away rather than
    // trusting every caller to know that.
    this.s = (seed >>> 0) || 0x9e3779b9;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1 - 1e-9));
  }

  pick<T>(list: readonly T[]): T {
    return list[Math.min(list.length - 1, Math.floor(this.next() * list.length))];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** A point inside a circle, evenly by area rather than by radius — without
   *  the square root everything clumps in the middle. */
  inDisc(radius: number): { x: number; y: number } {
    const a = this.next() * Math.PI * 2;
    const r = Math.sqrt(this.next()) * radius;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  }
}
