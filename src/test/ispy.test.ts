/**
 * I SPY — are the levels possible?
 *
 * Every level in the registry gets flown by the solver, at a coarse 20 Hz
 * decision grid with no human advantage, and the build fails if any of them
 * cannot be finished. A hand-authored beat map is easy to make impossible by
 * accident and impossible to check by playing, because "I could not do it" and
 * "it cannot be done" look identical from the chair.
 *
 * If you add a level and this goes red, the level is broken — not the test.
 */
import { describe, expect, it } from "vitest";
import { LEVELS } from "@/ispy/levels";
import { canCollect, flyLevel } from "@/ispy/bot";
import { arcHeightAt } from "@/ispy/build";
import { CLASSIC, derive, initialState, HITBOX, step, World } from "@/ispy/physics";
import { paletteAt } from "@/ispy/render";
import { DIFFICULTIES, type Difficulty } from "@/ispy/engine";
import type { Level, Obj } from "@/ispy/types";

const built = LEVELS.map((def) => ({ def, level: def.build() }));

describe("I Spy — the kit", () => {
  it("solves a level's physics from three numbers", () => {
    // One jump is one beat is `blocksPerBeat` blocks. Given a tempo and an
    // apex height that identity forces the speed, the takeoff velocity and the
    // gravity — and feeding it the classic tuning has to reproduce exactly the
    // numbers the first level was hand-tuned to, or the derivation is wrong.
    const t = derive(CLASSIC);
    expect(t.speed).toBeCloseTo(10, 6);
    expect(t.jump).toBeCloseTo(20.8, 6);
    expect(t.gravity).toBeCloseTo(83.2, 6);
    // A jump lands exactly one beat later, whatever the tuning.
    for (const tuning of [CLASSIC, { bpm: 150, blocksPerBeat: 4, apex: 2.2 }]) {
      const d = derive(tuning);
      const airTime = (2 * d.jump) / d.gravity;
      expect(airTime).toBeCloseTo(d.beatSecs, 6);
      expect(airTime * d.speed).toBeCloseTo(tuning.blocksPerBeat, 6);
      expect(arcHeightAt(d, tuning.blocksPerBeat / 2)).toBeCloseTo(tuning.apex, 4);
    }
  });

  it("offers modes that are strictly kinder, in the same level", () => {
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

  it("gives every level a distinct id, name and world", () => {
    expect(new Set(LEVELS.map((l) => l.id)).size).toBe(LEVELS.length);
    expect(new Set(LEVELS.map((l) => l.name)).size).toBe(LEVELS.length);
    for (const l of LEVELS) {
      expect(l.tagline.length, `${l.id} needs a tagline`).toBeGreaterThan(10);
      expect(l.world.length, `${l.id} needs a world`).toBeGreaterThan(2);
    }
  });
});

describe.each(built)("$def.name", ({ level }) => {
  const world = new World(level);

  it("is beatable end to end", { timeout: 30000 }, () => {
    const run = flyLevel(world, initialState(level));
    expect(
      run.finished,
      `solver died at x=${run.deathX?.toFixed(1)} (${((run.reached / level.length) * 100).toFixed(0)}%)`,
    ).toBe(true);
  });

  it("runs between twenty seconds and two minutes", { timeout: 30000 }, () => {
    const run = flyLevel(world, initialState(level));
    expect(run.time).toBeGreaterThan(20);
    expect(run.time).toBeLessThan(120);
  });

  it("is a whole number of beats long, ending on a downbeat", () => {
    const t = derive(level.tuning);
    expect(level.length % level.tuning.blocksPerBeat).toBeCloseTo(0, 6);
    // …and one jump is one beat is blocksPerBeat blocks, still.
    const airTime = (2 * t.jump) / t.gravity;
    expect(airTime * t.speed).toBeCloseTo(level.tuning.blocksPerBeat, 4);
  });

  it("has no spike or sawblade in it that does not kill you", () => {
    expect(level.objects.filter((o) => o.kind === "spike" && o.decoy)).toEqual([]);
    expect(level.objects.filter((o) => o.kind === "saw" && o.decoy)).toEqual([]);
  });

  it("keeps every hazard out of the scenery layer", () => {
    for (const o of level.objects) {
      if (!o.back) continue;
      expect(["block", "glyph"], `a ${o.kind} is in the background layer`).toContain(o.kind);
    }
  });

  it("keeps every lethal object visible enough to learn", () => {
    for (const o of level.objects) {
      if (o.decoy || o.back) continue;
      if (o.kind !== "spike" && o.kind !== "saw") continue;
      expect(o.alpha ?? 1).toBeGreaterThanOrEqual(0.06);
    }
  });

  it("leaves nothing floating in the sky but the sawblades", () => {
    expect(floatingIn(level)).toEqual([]);
  });

  it("spawns nothing at random — every piece of scenery is on the grid", () => {
    const OFF = 0.5;
    const onGrid = (v: number) => Math.abs(v / OFF - Math.round(v / OFF)) < 1e-9;
    const strays: string[] = [];
    for (const o of level.objects) {
      if (!o.decoy || o.kind === "glyph") continue;
      if (onGrid(o.x) && onGrid(o.y) && onGrid(o.w) && onGrid(o.h) && !o.rot) continue;
      if (o.rot === 180 && onGrid(o.x) && onGrid(o.y)) continue;
      strays.push(`${o.kind} at ${o.x},${o.y} ${o.w}x${o.h}`);
    }
    expect(strays.slice(0, 6), `${strays.length} off-grid`).toEqual([]);
  });

  it("never lets scenery collide", () => {
    for (const d of level.objects.filter((o) => o.decoy)) {
      expect(world.near(d.x)).not.toContain(level.objects.indexOf(d));
    }
  });

  it("cross-fades palettes without producing colours canvas cannot parse", () => {
    const HEX = /^#[0-9a-f]{6}$/i;
    for (let x = 0; x <= level.length; x += 1) {
      const p = paletteAt(level, x);
      for (const c of [p.bg[0], p.bg[1], p.solid, p.hazard, p.accent, p.ground]) {
        expect(HEX.test(c), `x=${x} produced ${c}`).toBe(true);
      }
    }
  });

  it("lands the cube flat on a face, never on a corner", () => {
    for (const holdTicks of [1, 4, 20, 60]) {
      const p = initialState(level);
      let airborne = false;
      for (let i = 0; i < 240 * 4; i++) {
        step(p, world, 1 / 240, { hold: i < holdTicks, tap: i === 0 });
        if (p.dead) break;
        if (!p.onGround) airborne = true;
        if (airborne && p.onGround) break;
      }
      if (!airborne || p.dead) continue; // some levels do not start on foot
      for (let i = 0; i < 40 && !p.dead; i++) step(p, world, 1 / 240, { hold: false, tap: false });
      const offBy = Math.abs(p.rot - Math.round(p.rot / 90) * 90);
      expect(offBy, `landed ${offBy.toFixed(1)}° off a flat face`).toBeLessThan(0.5);
    }
  });

  it("cannot kill you in chill, whatever you do", { timeout: 30000 }, () => {
    // The one promise chill makes. Hold nothing for the whole level, then hold
    // everything for the whole level; both have to arrive.
    for (const hold of [false, true]) {
      const p = initialState(level);
      p.chill = true;
      p.hazardScale = 0;
      let ticks = 0;
      while (p.x < level.length && ticks < 240 * 240) {
        step(p, world, 1 / 240, { hold, tap: hold && ticks % 60 === 0 });
        expect(p.dead, `died at x=${p.x.toFixed(1)} with hold=${hold} in chill`).toBe(false);
        ticks++;
      }
      expect(p.x).toBeGreaterThanOrEqual(level.length);
    }
  });

  it("hides its coins off the safe line but within reach of it", { timeout: 120000 }, () => {
    const coins = level.objects.filter((o) => o.kind === "coin");
    expect(coins.length).toBeGreaterThanOrEqual(1);

    const solids = level.objects.filter(
      (o) => !o.decoy && !o.back && (o.kind === "block" || o.kind === "spike" || o.kind === "saw"),
    );
    const run = flyLevel(world, initialState(level), 200, true);

    for (const c of coins) {
      const cx = c.x + c.w / 2;
      const cy = c.y + c.h / 2;
      for (const s of solids) {
        const inside =
          cx > s.x - 0.3 && cx < s.x + s.w + 0.3 && cy > s.y - 0.3 && cy < s.y + s.h + 0.3;
        expect(inside, `coin at ${cx},${cy} is inside a ${s.kind} at ${s.x},${s.y}`).toBe(false);
      }
      let nearest = Infinity;
      for (const [px, py] of run.path) nearest = Math.min(nearest, Math.hypot(px - cx, py - cy));
      expect(nearest, `coin at ${cx},${cy} collects itself on the safe line`).toBeGreaterThan(0.9);

      const detour = canCollect(world, initialState(level), { x: cx, y: cy });
      expect(detour.got, `coin at ${cx},${cy} cannot be reached`).toBe(true);
      expect(detour.finished, `the detour to ${cx},${cy} cannot be survived`).toBe(true);
    }
  });
});

describe("I Spy — hitboxes", () => {
  it("uses Geometry Dash's, in Geometry Dash's units", () => {
    expect(HITBOX.cubeSolid * 30).toBe(30);
    expect(HITBOX.cubeHazard * 30).toBeCloseTo(18, 5);
    expect(HITBOX.spike[0] * 30).toBeCloseTo(12, 5);
  });
});

/**
 * Everything drawn as level geometry has to be standing on something or
 * hanging from something. A spike in mid-air reads as a rendering bug rather
 * than as a level. Sawblades are exempt — a sawblade hanging in mid-air is
 * what a sawblade is, and now that they kill, floating is the point of them.
 */
function floatingIn(level: Level): string[] {
  const blocks = level.objects.filter((o) => o.kind === "block");
  const overlapsX = (a: Obj, b: Obj) => b.x < a.x + a.w - 0.05 && b.x + b.w > a.x + 0.05;
  const supports = (o: Obj) =>
    o.y <= 0.01 ||
    blocks.some((bl) => bl !== o && Math.abs(bl.y + bl.h - o.y) < 0.3 && overlapsX(o, bl));
  const hangs = (o: Obj) =>
    blocks.some((bl) => bl !== o && Math.abs(bl.y - (o.y + o.h)) < 0.35 && overlapsX(o, bl));

  const floating: string[] = [];
  for (const o of level.objects) {
    if (o.kind !== "spike" && o.kind !== "block") continue;
    // Real structural geometry — tunnel roofs, wave tubes — is the level, and
    // a ceiling is supposed to be over your head. A girder spans, which is
    // what a girder does and why the teeth under it are not what floats.
    if (!o.decoy && (o.plain || o.w > 4)) continue;
    if (o.mount) continue;
    const hanging = o.rot === 180;
    if (hanging ? hangs(o) : supports(o) || (o.kind === "block" && hangs(o))) continue;
    floating.push(`${o.decoy ? "scenery " : ""}${o.kind} at ${o.x.toFixed(1)},${o.y.toFixed(1)}`);
  }
  return floating.slice(0, 8);
}
