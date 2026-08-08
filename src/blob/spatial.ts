/**
 * A uniform grid, which is the whole reason this game holds sixty frames a
 * second with twelve hundred things on the table.
 *
 * The naive version — every cell against every pellet — is 100 × 1150 distance
 * checks per tick, sixty times a second, and it is the only part of this game
 * that was ever slow. Bucketing by cell size turns each query into "look at the
 * nine buckets around me", which for a pellet-sized query is a handful of
 * candidates instead of the whole dish.
 *
 * Rebuilt from scratch every tick on purpose. Incremental updates would be
 * faster in theory and are a well-known source of bugs in practice — a stale
 * bucket entry is an invisible blob you get eaten by — and a thousand inserts
 * costs well under a tenth of a millisecond.
 */
export interface Point {
  x: number;
  y: number;
}

export class Grid<T extends Point> {
  private readonly cols: number;
  private readonly rows: number;
  private readonly inv: number;
  private readonly buckets: T[][];

  /**
   * @param size  side of the square world
   * @param cell  bucket side. Want it a bit bigger than the things you query
   *              with: too small and every query touches dozens of buckets,
   *              too large and each bucket is a linear scan again.
   */
  constructor(size: number, cell: number) {
    this.inv = 1 / cell;
    this.cols = Math.max(1, Math.ceil(size / cell));
    this.rows = this.cols;
    this.buckets = new Array(this.cols * this.rows);
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
  }

  clear(): void {
    for (let i = 0; i < this.buckets.length; i++) {
      if (this.buckets[i].length) this.buckets[i].length = 0;
    }
  }

  private index(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, (x * this.inv) | 0));
    const cy = Math.min(this.rows - 1, Math.max(0, (y * this.inv) | 0));
    return cy * this.cols + cx;
  }

  insert(item: T): void {
    this.buckets[this.index(item.x, item.y)].push(item);
  }

  insertAll(items: readonly T[]): void {
    for (let i = 0; i < items.length; i++) this.insert(items[i]);
  }

  /**
   * Everything in the buckets overlapping the square of side 2·`radius` around
   * (x, y). Broad phase only — the caller still does the real distance test.
   *
   * Results are appended to `out` rather than returned in a fresh array: this
   * runs a few hundred times a tick, and a few hundred short-lived arrays a
   * tick is how you hand the garbage collector a reason to stutter.
   */
  query(x: number, y: number, radius: number, out: T[]): T[] {
    out.length = 0;
    const x0 = Math.min(this.cols - 1, Math.max(0, ((x - radius) * this.inv) | 0));
    const x1 = Math.min(this.cols - 1, Math.max(0, ((x + radius) * this.inv) | 0));
    const y0 = Math.min(this.rows - 1, Math.max(0, ((y - radius) * this.inv) | 0));
    const y1 = Math.min(this.rows - 1, Math.max(0, ((y + radius) * this.inv) | 0));
    for (let cy = y0; cy <= y1; cy++) {
      const row = cy * this.cols;
      for (let cx = x0; cx <= x1; cx++) {
        const bucket = this.buckets[row + cx];
        for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
      }
    }
    return out;
  }
}
