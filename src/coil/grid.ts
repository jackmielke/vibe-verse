/**
 * A uniform grid over the arena, and the reason this holds sixty frames.
 *
 * The thing being indexed here is not snakes, it is *body points*: thirty
 * snakes at full length are about six thousand lethal circles, and a head has
 * to be checked against all of them sixty times a second. The naive version is
 * a hundred and eighty thousand distance tests per tick.
 *
 * Rebuilt from scratch each tick. Incremental updates would be faster in theory
 * and are a well-known source of bugs in practice — a stale entry here is an
 * invisible wall you die on — and six thousand inserts costs well under a tenth
 * of a millisecond.
 */
export interface Hit {
  x: number;
  y: number;
  /** Which snake this piece of body belongs to. */
  snake: number;
  /** Body radius here, so the head knows how much of it to clear. */
  r: number;
}

export class HitGrid {
  private readonly cols: number;
  private readonly inv: number;
  private readonly buckets: Hit[][];
  /** Half the world's width, since the arena is centred on the origin. */
  private readonly half: number;

  constructor(size: number, cell: number) {
    this.half = size / 2;
    this.inv = 1 / cell;
    this.cols = Math.max(1, Math.ceil(size / cell));
    this.buckets = new Array(this.cols * this.cols);
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
  }

  clear(): void {
    for (let i = 0; i < this.buckets.length; i++) {
      if (this.buckets[i].length) this.buckets[i].length = 0;
    }
  }

  private col(v: number): number {
    const c = ((v + this.half) * this.inv) | 0;
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  insert(h: Hit): void {
    this.buckets[this.col(h.y) * this.cols + this.col(h.x)].push(h);
  }

  /** Everything in the buckets overlapping the square around (x, y). Broad
   *  phase only — the caller still does the real distance test. Results are
   *  appended to `out` so this can run a few hundred times a tick without
   *  handing the garbage collector a reason to stutter. */
  query(x: number, y: number, radius: number, out: Hit[]): Hit[] {
    out.length = 0;
    const x0 = this.col(x - radius);
    const x1 = this.col(x + radius);
    const y0 = this.col(y - radius);
    const y1 = this.col(y + radius);
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
