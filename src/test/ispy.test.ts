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
import { DIFFICULTIES, type Difficulty } from "@/ispy/engine";

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

  it("spawns nothing at random — every decoy is on the authoring grid", () => {
    // The level's decoration used to come out of a seeded PRNG. It was
    // reproducible and it still looked like debris, because a scatter is not a
    // decision: three towers in a row, then forty empty blocks, saying
    // nothing. It is all hand-drawn now — four bars of dressing in `level.ts`,
    // tiled — and this is what keeps it that way. Anything placed by a random
    // number lands on an arbitrary coordinate; anything placed by a person
    // lands on the grid they were drawing on.
    const OFF = 0.5;
    const strays: string[] = [];
    for (const o of level.objects) {
      if (!o.decoy) continue;
      if (o.kind === "glyph") continue;
      const onGrid = (v: number) => Math.abs(v / OFF - Math.round(v / OFF)) < 1e-9;
      if (onGrid(o.x) && onGrid(o.y) && onGrid(o.w) && onGrid(o.h) && !o.rot) continue;
      if (o.rot === 180 && onGrid(o.x) && onGrid(o.y)) continue;
      strays.push(`${o.kind} at ${o.x},${o.y} ${o.w}x${o.h} rot=${o.rot ?? 0}`);
    }
    expect(strays.slice(0, 6), `${strays.length} off-grid`).toEqual([]);
  });

  it("has no spike in it that does not kill you", () => {
    // The level used to be built on painted spikes: rows that looked exactly
    // like the lethal ones and were not. They are gone. Every spike on screen
    // is a real one, and the only scenery left is architecture, because
    // nobody has ever mistaken a building for a spike.
    const painted = level.objects.filter((o) => o.kind === "spike" && o.decoy);
    expect(painted).toEqual([]);

    // Sawblades kill too, now, so none of those may be paint either.
    const paintedSaws = level.objects.filter((o) => o.kind === "saw" && o.decoy);
    expect(paintedSaws).toEqual([]);
  });

  it("keeps every hazard out of the scenery layer", () => {
    // Anything drawn behind the play field is non-colliding by construction,
    // so nothing that can kill you is allowed to live there — a lethal object
    // you cannot reach reads as a bug, and a dimmed one reads as unfair.
    for (const o of level.objects) {
      if (!o.back) continue;
      // Buildings and question marks. Nothing that has a hitbox.
      expect(["block", "glyph"], `a ${o.kind} is in the background layer`).toContain(o.kind);
    }
  });

  it("never lets scenery collide", () => {
    const scenery = level.objects.filter((o) => o.decoy);
    expect(scenery.length).toBeGreaterThan(100);
    for (const d of scenery) expect(world.near(d.x)).not.toContain(level.objects.indexOf(d));
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

  it("puts every hazard on a beat", () => {
    // A hazard off the beat would be a hazard the music does not announce.
    const spikes = level.objects.filter((o) => o.kind === "spike" && o.w === 1);
    let onGrid = 0;
    for (const o of spikes) if (Number.isInteger(o.x)) onGrid++;
    expect(spikes.length).toBeGreaterThan(50);
    expect(onGrid / spikes.length).toBeGreaterThan(0.99);

    // Sawblades are placed by hand, one at a time, and every one of them is
    // lethal — so none of them may be left to a loop's arithmetic either.
    const saws = level.objects.filter((o) => o.kind === "saw");
    expect(saws.length).toBeGreaterThan(5);
    for (const o of saws) {
      expect(Math.abs(o.x * 2 - Math.round(o.x * 2)), `saw at ${o.x} is off-grid`).toBeLessThan(1e-9);
    }
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

  it("offers modes that are strictly kinder, in the same level", () => {
    // The easier settings must not be a different level. `rate` scales the
    // simulation and the tempo together, so every arc is identical in space
    // and only the clock changes; `hazard` shrinks the player's lethal box.
    // Neither can add a hazard or move a block.
    const order: Difficulty[] = ["chill", "easy", "normal"];
    let lastRate = 0;
    let lastHazard = -1;
    for (const d of order) {
      const r = DIFFICULTIES[d];
      expect(r.rate, `${d} rate`).toBeGreaterThan(lastRate);
      expect(r.rate).toBeLessThanOrEqual(1);
      expect(r.hazard, `${d} hazard`).toBeGreaterThan(lastHazard);
      expect(r.hazard).toBeLessThanOrEqual(1);
      lastRate = r.rate;
      lastHazard = r.hazard;
    }
    expect(DIFFICULTIES.normal.rate).toBe(1);
    expect(DIFFICULTIES.normal.hazard).toBe(1);
    // Nothing that cannot kill you is allowed to bank a coin.
    expect(DIFFICULTIES.chill.coinsCount).toBe(false);
  });

  it("cannot kill you in chill, even if you do nothing at all", () => {
    // The point of the mode. Hold no buttons for the entire level and you
    // still arrive: hazards do not touch you, walls are not there, and the
    // wave stops dying on contact. If this ever goes red, chill has a hole in
    // it, and a mode whose only promise is "you cannot die" has exactly one
    // thing it must not get wrong.
    const p = initialState(level);
    p.chill = true;
    p.hazardScale = 0;
    let ticks = 0;
    while (p.x < level.length && ticks < 240 * 200) {
      step(p, world, 1 / 240, { hold: false, tap: false });
      expect(p.dead, `died at x=${p.x.toFixed(1)} doing nothing in chill`).toBe(false);
      ticks++;
    }
    expect(p.x).toBeGreaterThanOrEqual(level.length);
  });

  it("still gets to the end on chill while holding the button down", () => {
    // The other way someone plays a sightseeing mode: leaning on the button.
    const p = initialState(level);
    p.chill = true;
    p.hazardScale = 0;
    let ticks = 0;
    while (p.x < level.length && ticks < 240 * 200) {
      step(p, world, 1 / 240, { hold: true, tap: ticks % 60 === 0 });
      expect(p.dead, `died at x=${p.x.toFixed(1)} holding jump in chill`).toBe(false);
      ticks++;
    }
    expect(p.x).toBeGreaterThanOrEqual(level.length);
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
