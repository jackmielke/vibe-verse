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
import { canCollect, flyLevel } from "@/ispy/bot";
import { arcHeight } from "@/ispy/build";
import { BEAT, BPM, JUMP_WINDOW } from "@/ispy/build";
import { CUBE_GRAVITY, CUBE_JUMP, HITBOX, initialState, SPEEDS, step, World } from "@/ispy/physics";
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

  it("leaves nothing floating in the sky but the gears", () => {
    // The complaint that prompted this: decoy spikes and blocks hanging in
    // mid-air read as a rendering bug rather than as a lie. Everything that
    // is drawn as level geometry now has to be standing on something, or
    // hanging from something. Sawblades are exempt, because a sawblade
    // hanging in mid-air is what a sawblade is.
    const blocks = level.objects.filter((o) => o.kind === "block");
    const supports = (o: (typeof level.objects)[number]) => {
      if (o.y <= 0.01) return true;
      return blocks.some(
        (bl) =>
          bl !== o &&
          Math.abs(bl.y + bl.h - o.y) < 0.3 &&
          bl.x < o.x + o.w - 0.05 &&
          bl.x + bl.w > o.x + 0.05,
      );
    };
    const hangs = (o: (typeof level.objects)[number]) =>
      blocks.some(
        (bl) =>
          Math.abs(bl.y - (o.y + o.h)) < 0.35 &&
          bl.x < o.x + o.w - 0.05 &&
          bl.x + bl.w > o.x + 0.05,
      );

    const floating: string[] = [];
    for (const o of level.objects) {
      if (o.kind === "saw" || o.kind === "glyph") continue;
      if (o.kind !== "spike" && o.kind !== "block") continue;
      // Real structural geometry — tunnel roofs, wave tubes — is the level,
      // and a ceiling is supposed to be over your head.
      if (!o.decoy && (o.plain || o.w > 4)) continue;
      // A girder spans; that is what a girder does. It is the reason the
      // teeth bolted under it are not the thing floating.
      if (o.mount) continue;
      const hanging = o.rot === 180;
      // A block may stand on something *or* hang off something — the upper
      // half of a ship gate is bolted to the tunnel roof, not to the floor.
      if (hanging ? hangs(o) : supports(o) || (o.kind === "block" && hangs(o))) continue;
      floating.push(`${o.decoy ? "decoy " : ""}${o.kind} at ${o.x.toFixed(1)},${o.y.toFixed(1)}`);
    }
    expect(floating.slice(0, 8), `${floating.length} floating`).toEqual([]);
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

  it("is cut to its music: one jump, one beat, five blocks", () => {
    // The spine of the level. A 1x jump hangs half a second, which at 120 BPM
    // is one beat, which at 10 blocks/second is five blocks. Break any one of
    // the three and every rhythm in `level.ts` is a lie.
    expect(BPM).toBe(120);
    expect(BEAT).toBe(5);
    expect(SPEEDS.one * (60 / BPM)).toBeCloseTo(BEAT, 6);
    // Air time, from the physics rather than from arithmetic in a comment.
    const air = (2 * CUBE_JUMP) / CUBE_GRAVITY;
    expect(air * SPEEDS.one).toBeCloseTo(BEAT, 1);
    // …and the level is a whole number of beats long, so it ends on a downbeat.
    expect(level.length % BEAT).toBe(0);
    expect(level.length / SPEEDS.one).toBeCloseTo(60, 5);
  });

  it("puts every hazard on a beat, decoys included", () => {
    // A decoy off the beat would be audible, and the level would solve itself.
    const spikes = level.objects.filter((o) => o.kind === "spike" && !o.back && o.w === 1);
    let onGrid = 0;
    for (const o of spikes) if (Number.isInteger(o.x)) onGrid++;
    expect(spikes.length).toBeGreaterThan(200);
    expect(onGrid / spikes.length).toBeGreaterThan(0.99);
  });

  // Three full solver runs with a coin-seeking policy. Slow, and worth it:
  // it is the difference between "the coin looks reachable" and "here is a
  // line that takes it and still finishes".
  it("hides three coins off the safe line but within reach of it", { timeout: 60000 }, () => {
    const coins = level.objects.filter((o) => o.kind === "coin");
    expect(coins).toHaveLength(3);

    const solids = level.objects.filter(
      (o) => !o.decoy && !o.back && (o.kind === "block" || o.kind === "spike" || o.kind === "saw"),
    );
    const run = flyLevel(world, initialState(level), 200, true);
    expect(run.finished).toBe(true);

    for (const c of coins) {
      const cx = c.x + c.w / 2;
      const cy = c.y + c.h / 2;

      // Not buried in the level.
      for (const s of solids) {
        const inside =
          cx > s.x - 0.3 && cx < s.x + s.w + 0.3 && cy > s.y - 0.3 && cy < s.y + s.h + 0.3;
        expect(inside, `coin at ${cx},${cy} is inside a ${s.kind} at ${s.x},${s.y}`).toBe(false);
      }

      // Off the safe line: a run that is not trying to collect it does not.
      let nearest = Infinity;
      for (const [px, py] of run.path) nearest = Math.min(nearest, Math.hypot(px - cx, py - cy));
      expect(nearest, `coin at ${cx},${cy} collects itself on the safe line`)
        .toBeGreaterThan(0.9);

      // …and reachable: a solver that wants it, gets it, and still finishes.
      const detour = canCollect(world, initialState(level), { x: cx, y: cy });
      expect(detour.got, `coin at ${cx},${cy} cannot be reached`).toBe(true);
      expect(detour.finished, `the detour to ${cx},${cy} cannot be survived`).toBe(true);
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
    // 0.54 to 4.47 blocks past takeoff — the window every pattern is built on.
    expect(arcHeight(0.5)).toBeLessThan(1);
    expect(arcHeight(0.6)).toBeGreaterThan(1);
    expect(arcHeight(4.4)).toBeGreaterThan(1);
    expect(arcHeight(4.6)).toBeLessThan(1);
    expect(arcHeight(JUMP_WINDOW.apex)).toBeCloseTo(2.6, 1);
    expect(arcHeight(5.01)).toBeCloseTo(0, 1);

    // And the run of three the level leans on — at offset 1, so 1.5 / 2.5 /
    // 3.5 blocks out — clears with room to spare rather than on hitbox slack.
    for (const d of [1.5, 2.5, 3.5]) expect(arcHeight(d)).toBeGreaterThan(1.2);
  });
});
