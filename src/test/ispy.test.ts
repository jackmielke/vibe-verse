/**
 * I SPY — is the level possible?
 *
 * The level is designed to be unreadable on sight, which makes playtesting a
 * bad oracle: "I could not do it" and "it cannot be done" look identical from
 * the chair. So the bot flies it, at a coarse 20 Hz decision grid it shares
 * with no human advantage except knowing which spikes are real, and the build
 * fails if it cannot reach the end.
 *
 * If you edit `level.ts` and this goes red, the level is broken — not the test.
 */
import { describe, expect, it } from "vitest";
import { buildISpy } from "@/ispy/level";
import { flyLevel } from "@/ispy/bot";
import { arcHeight } from "@/ispy/build";
import { initialState, World } from "@/ispy/physics";

describe("I Spy", () => {
  const level = buildISpy();
  const world = new World(level);

  it("is beatable end to end", () => {
    const run = flyLevel(world, initialState(level));
    expect(
      run.finished,
      `bot died at x=${run.deathX?.toFixed(1)} (${((run.reached / level.length) * 100).toFixed(0)}%)`,
    ).toBe(true);
  });

  it("runs about a minute", () => {
    const run = flyLevel(world, initialState(level));
    expect(run.time).toBeGreaterThan(40);
    expect(run.time).toBeLessThan(100);
  });

  it("never lets a decoy collide", () => {
    const decoys = level.objects.filter((o) => o.decoy);
    expect(decoys.length).toBeGreaterThan(200);
    for (const d of decoys) expect(world.near(d.x)).not.toContain(level.objects.indexOf(d));
  });

  it("keeps every lethal object visible enough to learn", () => {
    for (const o of level.objects) {
      if (o.decoy || o.back) continue;
      if (o.kind !== "spike" && o.kind !== "saw") continue;
      expect(o.alpha ?? 1).toBeGreaterThanOrEqual(0.06);
    }
  });

  it("agrees with the jump arithmetic the level is authored against", () => {
    // A ground spike needs y > 1 over its whole width, which is true from
    // 0.56 to 4.65 blocks past takeoff — the window every pattern is built on.
    expect(arcHeight(0.5)).toBeLessThan(1);
    expect(arcHeight(0.6)).toBeGreaterThan(1);
    expect(arcHeight(4.6)).toBeGreaterThan(1);
    expect(arcHeight(4.7)).toBeLessThan(1);
    expect(arcHeight(2.6)).toBeCloseTo(2.6, 1);
    expect(arcHeight(5.21)).toBeCloseTo(0, 1);
  });
});
