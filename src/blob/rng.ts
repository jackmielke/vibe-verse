/**
 * A seeded random number generator, because "random" and "reproducible" are
 * both things this game needs.
 *
 * The tests want a dish that lays itself out the same way twice, and a match
 * you can hand somebody a seed for wants the same thing. `Math.random` gives
 * neither. Mulberry32 is thirty-two bits of state and four lines of arithmetic,
 * which is plenty for scattering pellets.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    // Zero is a fixed point for this generator — it would emit the same number
    // forever — so fold it away rather than trusting every caller to know that.
    this.s = (seed >>> 0) || 0x9e3779b9;
  }

  /** [0, 1) */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [lo, hi) */
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1 - 1e-9));
  }

  pick<T>(list: readonly T[]): T {
    return list[Math.min(list.length - 1, Math.floor(this.next() * list.length))];
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }
}
