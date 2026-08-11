/**
 * COIL — the body.
 *
 * A snake is a head with a memory. The head is the only thing that is actually
 * simulated; the body is *where the head has been*, sampled backwards along a
 * trail. Everything about how this game feels comes out of that one idea: you
 * cannot move your tail, only outlive it, and the line you drew ten seconds ago
 * is still lying there being lethal to everybody including the person who drew
 * it around you.
 *
 * ## The shape of the data
 *
 * Three parallel arrays and a running arc length. Points go on the **end** as
 * the head moves, which is O(1); the front is dropped in chunks once it falls
 * off the tail, which is O(n) but happens rarely enough to be free. The
 * alternative — prepending the newest point at index 0 — reads more naturally
 * and copies the whole body every frame.
 *
 * `ss` is cumulative distance from the start of the buffer and only ever
 * increases, so "the point 400 pixels behind the head" is a binary search
 * rather than a walk. That matters because the spacing between points is *not*
 * uniform: a boosting snake lays them down almost twice as far apart, and code
 * that assumed uniform spacing would quietly shorten every boosting snake's
 * hitbox.
 */

/** How much slack to keep past the tail before compacting. Trimming one point
 *  at a time would memmove the whole array sixty times a second. */
const SLACK = 400;

export class Body {
  private xs: number[] = [];
  private ys: number[] = [];
  /** Cumulative arc length at each point, monotonically increasing. */
  private ss: number[] = [];
  /** Arc length at the head — the largest value in `ss`. */
  private headS = 0;

  constructor(x: number, y: number) {
    this.xs.push(x);
    this.ys.push(y);
    this.ss.push(0);
  }

  get headX(): number {
    return this.xs[this.xs.length - 1];
  }

  get headY(): number {
    return this.ys[this.ys.length - 1];
  }

  /** Total arc length currently held in the buffer. */
  get span(): number {
    return this.headS - this.ss[0];
  }

  get points(): number {
    return this.xs.length;
  }

  /** Extend the trail to a new head position. */
  advance(x: number, y: number): void {
    const dx = x - this.headX;
    const dy = y - this.headY;
    const d = Math.hypot(dx, dy);
    // A head that has not moved must not add a zero-length step: a run of them
    // would make the binary search below ambiguous and cost memory for nothing.
    if (d < 1e-4) return;
    this.headS += d;
    this.xs.push(x);
    this.ys.push(y);
    this.ss.push(this.headS);
  }

  /**
   * Teleport the whole body to a point — a respawn, not a move.
   *
   * Without this a respawned snake keeps a trail stretching back to wherever it
   * died, which is both a lethal line nobody can see the owner of and a body
   * that appears to be several thousand pixels long.
   */
  reset(x: number, y: number): void {
    this.xs.length = 0;
    this.ys.length = 0;
    this.ss.length = 0;
    this.headS = 0;
    this.xs.push(x);
    this.ys.push(y);
    this.ss.push(0);
  }

  /** Drop everything further back than `keep` pixels behind the head. */
  trim(keep: number): void {
    const cut = this.headS - keep - SLACK;
    if (cut <= this.ss[0]) return;
    let i = 0;
    while (i < this.ss.length - 2 && this.ss[i + 1] < cut) i++;
    if (i <= 0) return;
    this.xs.splice(0, i);
    this.ys.splice(0, i);
    this.ss.splice(0, i);
  }

  /** Index of the last point at or before arc length `s`. */
  private indexAt(s: number): number {
    let lo = 0;
    let hi = this.ss.length - 1;
    if (s <= this.ss[0]) return 0;
    if (s >= this.ss[hi]) return hi;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.ss[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /**
   * The point `dist` pixels back along the trail from the head.
   *
   * Interpolated between the two straddling samples rather than snapped to the
   * nearer one: at speed the samples are four pixels apart, and snapping makes
   * every body circle visibly shuffle back and forth along the trail.
   */
  at(dist: number, out: { x: number; y: number }): boolean {
    const s = this.headS - Math.max(0, dist);
    if (s < this.ss[0]) return false;
    const i = this.indexAt(s);
    if (i >= this.ss.length - 1) {
      out.x = this.xs[i];
      out.y = this.ys[i];
      return true;
    }
    const span = this.ss[i + 1] - this.ss[i];
    const t = span > 1e-6 ? (s - this.ss[i]) / span : 0;
    out.x = this.xs[i] + (this.xs[i + 1] - this.xs[i]) * t;
    out.y = this.ys[i] + (this.ys[i + 1] - this.ys[i]) * t;
    return true;
  }

  /**
   * Walk the body from the head backwards, emitting a point every `spacing`.
   *
   * One call serves both the renderer (fine spacing, for the tube) and the
   * collision pass (coarse, one circle per body width). `skipHead` exists
   * because a snake must not collide with the first stretch of its own neck,
   * which is by definition always touching its head.
   */
  walk(
    spacing: number,
    length: number,
    cb: (x: number, y: number, dist: number) => void,
    skipHead = 0,
  ): void {
    const step = Math.max(1, spacing);
    const end = Math.min(length, this.span);
    const probe = { x: 0, y: 0 };
    for (let d = skipHead; d <= end; d += step) {
      if (!this.at(d, probe)) break;
      cb(probe.x, probe.y, d);
    }
  }
}
