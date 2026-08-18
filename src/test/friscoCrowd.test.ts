/**
 * The crowd, stepped without a browser.
 *
 * Same trick as `friscoTraffic.test.ts`: `CityLife` needs no WebGL context, so
 * a minute of world time runs in a couple of seconds here and takes twenty
 * minutes under the software renderer the capture harness uses.
 *
 * What is being pinned is the thing a screenshot cannot show. A walker who
 * reaches the end of a block and is quietly teleported somewhere else is a
 * person vanishing three metres from where you are standing — and the frame
 * before and the frame after both look like a street with people on it, so
 * there is no picture of the bug. The number of reseeds per person per minute
 * is the whole story.
 */
import { describe, expect, it } from "vitest";
import { CityLife } from "@/frisco/life";

/** One minute of world time at 30 Hz. */
function run(life: CityLife, seconds: number, from = 0): void {
  const n = Math.round(seconds * 30);
  for (let i = 0; i < n; i++) life.update(1 / 30, from + i / 30);
}

describe("Vibe Francisco — the crowd", () => {
  it("takes corners instead of vanishing", () => {
    const life = new CityLife();
    // Let the initial seeding settle before counting.
    run(life, 5);
    const before = life.crowd().reseeds;
    run(life, 60, 5);
    const after = life.crowd();
    const perPersonPerMinute = (after.reseeds - before) / after.walkers;
    /* At 1.5 m/s an 84 m block takes under a minute, so a crowd that reseeds
       at every corner sits around one per person per minute. With `turnCorner`
       stubbed out to return false this measures 1.35; with it, 0.005 — three
       hundred times better, and the ceiling sits between the two rather than
       just under the good number, because the interesting failure is the
       mechanism disappearing, not it getting slightly worse. */
    expect(perPersonPerMinute).toBeLessThan(0.25);
    life.dispose();
  }, 60000);

  it("sends some of them across the road, and gets them all the way over", () => {
    const life = new CityLife();
    run(life, 5);
    let sawCrossing = false;
    for (let i = 0; i < 60; i++) {
      run(life, 1, 5 + i);
      if (life.crowd().crossing > 0) sawCrossing = true;
    }
    expect(sawCrossing).toBe(true);
    // And nobody is left standing in the carriageway forever: after a long
    // quiet stretch the number mid-crossing must come back down.
    run(life, 120, 200);
    const c = life.crowd();
    expect(c.crossing).toBeLessThan(c.walkers * 0.15);
    life.dispose();
  }, 90000);

  it("keeps the whole crowd placed", () => {
    const life = new CityLife();
    run(life, 30);
    const c = life.crowd();
    expect(c.walkers).toBeGreaterThan(1200);
    life.dispose();
  }, 60000);
});
