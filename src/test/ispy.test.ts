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
import { HITBOX, initialState, step, World } from "@/ispy/physics";
import { paletteAt } from "@/ispy/render";

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

  it("lands the cube flat on a face, never on a corner", () => {
    // The complaint that started this: a fixed spin rate stops wherever the
    // arc ends. Jump from flat ground and the cube must arrive at a multiple
    // of 90° — on a side — every time, at every launch strength.
    for (const holdTicks of [1, 4, 20, 60]) {
      const p = initialState(level);
      let airborne = false;
      for (let i = 0; i < 240 * 3; i++) {
        step(p, world, 1 / 240, { hold: i < holdTicks, tap: i === 0 });
        if (!p.onGround) airborne = true;
        if (airborne && p.onGround) break;
      }
      expect(airborne, `never left the ground with hold=${holdTicks}`).toBe(true);
      // One settle tick to snap any remainder, then it must be square.
      for (let i = 0; i < 30; i++) step(p, world, 1 / 240, { hold: false, tap: false });
      const offBy = Math.abs(p.rot - Math.round(p.rot / 90) * 90);
      expect(offBy, `landed ${offBy.toFixed(1)}° off a flat face`).toBeLessThan(0.5);
    }
  });

  it("turns exactly half a turn across a full-height jump", () => {
    const p = initialState(level);
    step(p, world, 1 / 240, { hold: true, tap: true });
    const start = p.rot;
    let airborne = false;
    for (let i = 0; i < 240 * 3; i++) {
      step(p, world, 1 / 240, { hold: false, tap: false });
      if (!p.onGround) airborne = true;
      else if (airborne) break;
    }
    expect(Math.abs(p.rot - start)).toBeGreaterThan(170);
    expect(Math.abs(p.rot - start)).toBeLessThan(190);
  });

  it("uses Geometry Dash's hitboxes, in Geometry Dash's units", () => {
    // 30 px to the block. Change these and the level's difficulty changes.
    expect(HITBOX.cubeSolid * 30).toBe(30);
    expect(HITBOX.cubeHazard * 30).toBeCloseTo(18, 5);
    expect(HITBOX.spike[0] * 30).toBeCloseTo(12, 5);
  });

  it("cross-fades palettes without producing colours canvas cannot parse", () => {
    // Every helper in the renderer parses colours with a hex reader, so a
    // blend that returns anything else poisons everything downstream of it
    // with NaN — which is exactly what used to happen for fourteen blocks
    // either side of all six section seams.
    const HEX = /^#[0-9a-f]{6}$/i;
    for (let x = 0; x <= level.length; x += 1) {
      const p = paletteAt(level, x);
      for (const c of [p.bg[0], p.bg[1], p.solid, p.hazard, p.accent, p.ground]) {
        expect(HEX.test(c), `x=${x} produced ${c}`).toBe(true);
      }
      expect(Number.isFinite(p.strobe)).toBe(true);
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
