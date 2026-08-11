/**
 * COIL — the rules, checked.
 *
 * The genre's whole character comes from two things a screenshot cannot show:
 * that a body is *where the head has been*, and that heads lose regardless of
 * size. Both are arithmetic, so both are tested here against a real sim with no
 * DOM anywhere near it.
 */
import { describe, expect, it } from "vitest";
import {
  ARENA_R,
  BOOST_MIN_SCORE,
  BOOST_MULT,
  SPEED,
  START_SCORE,
  TICK,
  TURN_RATE,
  lengthOf,
  radiusOf,
} from "@/coil/config";
import { Body } from "@/coil/body";
import { CoilSim } from "@/coil/sim";
import { think } from "@/coil/ai";
import { Rng } from "@/coil/rng";
import { HitGrid } from "@/coil/grid";
import { botLooks, lookFor, PORTRAIT_IDS } from "@/coil/roster";

/** An arena with nobody in it but you, so a test can state its own scenario. */
function solo(): CoilSim {
  const sim = new CoilSim({ seed: 5, skill: "cruise" });
  for (const s of sim.snakes) {
    if (s.isBot) {
      s.alive = false;
      // Far in the future, so `respawnBots` leaves the arena empty.
      s.diedAt = 1e9;
    }
  }
  sim.orbs.length = 0;
  sim.respawnYou();
  return sim;
}

const run = (sim: CoilSim, seconds: number) => {
  const steps = Math.round(seconds / TICK);
  for (let i = 0; i < steps; i++) sim.step(TICK, think);
};

describe("the body", () => {
  it("is a trail the head has already been down", () => {
    const b = new Body(0, 0);
    for (let i = 1; i <= 100; i++) b.advance(i * 5, 0);
    expect(b.headX).toBe(500);
    const p = { x: 0, y: 0 };
    expect(b.at(0, p)).toBe(true);
    expect(p.x).toBeCloseTo(500, 6);
    expect(b.at(120, p)).toBe(true);
    expect(p.x).toBeCloseTo(380, 6);
  });

  it("interpolates between samples rather than snapping to one", () => {
    const b = new Body(0, 0);
    b.advance(10, 0);
    b.advance(20, 0);
    const p = { x: 0, y: 0 };
    b.at(5, p);
    // 5 behind a head at 20 is 15, which is *between* the two stored points.
    expect(p.x).toBeCloseTo(15, 6);
  });

  it("measures by arc length, so a boosting snake is not secretly shorter", () => {
    const slow = new Body(0, 0);
    for (let i = 1; i <= 40; i++) slow.advance(i * 4, 0);
    const fast = new Body(0, 0);
    for (let i = 1; i <= 20; i++) fast.advance(i * 8, 0);
    const a = { x: 0, y: 0 };
    const c = { x: 0, y: 0 };
    slow.at(100, a);
    fast.at(100, c);
    // Same distance back along the trail, whatever the sample spacing was.
    expect(a.x).toBeCloseTo(c.x, 4);
  });

  it("ignores a head that has not moved", () => {
    const b = new Body(3, 4);
    const before = b.points;
    b.advance(3, 4);
    b.advance(3.00001, 4);
    expect(b.points).toBe(before);
  });

  it("forgets everything past the tail", () => {
    const b = new Body(0, 0);
    for (let i = 1; i <= 2000; i++) b.advance(i * 4, 0);
    b.trim(500);
    expect(b.span).toBeLessThan(1000);
    expect(b.points).toBeLessThan(300);
    // ...and what it still holds is right.
    const p = { x: 0, y: 0 };
    expect(b.at(400, p)).toBe(true);
    expect(p.x).toBeCloseTo(8000 - 400, 4);
  });

  it("throws the whole trail away on a respawn", () => {
    const b = new Body(0, 0);
    for (let i = 1; i <= 500; i++) b.advance(i * 4, 0);
    b.reset(-100, -100);
    expect(b.span).toBe(0);
    expect(b.headX).toBe(-100);
    // A respawned snake must not keep a lethal line back to where it died.
    const p = { x: 0, y: 0 };
    expect(b.at(50, p)).toBe(false);
  });

  it("walks the body at the spacing it is asked for", () => {
    const b = new Body(0, 0);
    for (let i = 1; i <= 400; i++) b.advance(i * 4, 0);
    const seen: number[] = [];
    b.walk(50, 400, (x) => seen.push(x));
    expect(seen.length).toBe(9);
    expect(seen[0]).toBeCloseTo(1600, 4);
    expect(seen[1]).toBeCloseTo(1550, 4);
  });
});

describe("the shape of a snake", () => {
  it("grows length with score, and width much more slowly", () => {
    expect(lengthOf(200)).toBeGreaterThan(lengthOf(50));
    // Twenty times the score must not be twenty times the width.
    expect(radiusOf(1000) / radiusOf(50)).toBeLessThan(3);
  });

  it("caps both, because past a point there is nothing to see", () => {
    // Asserted as "stops growing" rather than against a literal, so a tuning
    // pass on the cap is a config change and not also a test change.
    expect(radiusOf(1e6)).toBe(radiusOf(1e9));
    expect(lengthOf(1e6)).toBe(lengthOf(1e9));
    expect(radiusOf(1e6)).toBeLessThan(200);
    expect(lengthOf(1e6)).toBeLessThan(ARENA_R * 2);
  });
});

describe("steering", () => {
  it("turns towards the target but never faster than the turn rate", () => {
    const sim = solo();
    const you = sim.you;
    you.angle = 0;
    // Ask for a full reversal; a snake must not simply snap to it.
    sim.steerAngle(0, Math.PI);
    sim.step(TICK, think);
    expect(Math.abs(you.angle)).toBeLessThanOrEqual(TURN_RATE * TICK + 1e-6);
  });

  it("takes the short way round rather than unwinding the long way", () => {
    const sim = solo();
    const you = sim.you;
    you.angle = 3.0;
    // Target just past +π, i.e. barely anticlockwise of where we are pointing.
    sim.steerAngle(0, -3.0);
    sim.step(TICK, think);
    // The short way is *up* through π, so the angle should increase.
    expect(you.angle).toBeGreaterThan(3.0);
  });

  it("moves at a constant speed, faster while boosting", () => {
    const sim = solo();
    const you = sim.you;
    you.score = 200;
    // `spawn` points a snake inwards with a jitter, so face it east *now*
    // rather than asking it to turn there — this test is about speed.
    you.angle = 0;
    sim.steerAngle(0, 0);
    const x0 = you.body.headX;
    run(sim, 1);
    const cruised = you.body.headX - x0;
    expect(cruised).toBeCloseTo(SPEED, -1);

    const x1 = you.body.headX;
    sim.setBoost(0, true);
    run(sim, 0.5);
    const boosted = (you.body.headX - x1) / 0.5;
    expect(boosted).toBeGreaterThan(SPEED * BOOST_MULT * 0.9);
  });
});

describe("boosting", () => {
  it("costs length and drops it on the floor behind you", () => {
    const sim = solo();
    const you = sim.you;
    you.score = 200;
    sim.steerAngle(0, 0);
    sim.setBoost(0, true);
    run(sim, 2);
    expect(you.score).toBeLessThan(200);
    expect(sim.orbs.length).toBeGreaterThan(3);
  });

  it("refuses to run you down to nothing", () => {
    const sim = solo();
    const you = sim.you;
    you.score = BOOST_MIN_SCORE + 2;
    sim.steerAngle(0, 0);
    sim.setBoost(0, true);
    run(sim, 4);
    expect(you.score).toBeGreaterThanOrEqual(BOOST_MIN_SCORE - 1);
    expect(you.boosting).toBe(false);
  });

  it("cannot be started below the floor at all", () => {
    const sim = solo();
    sim.you.score = BOOST_MIN_SCORE - 1;
    sim.setBoost(0, true);
    expect(sim.you.boosting).toBe(false);
  });
});

describe("dying", () => {
  it("kills a head that reaches somebody else's body, however long it is", () => {
    const sim = solo();
    const you = sim.you;
    // A whale, pointed at a minnow's tail.
    you.score = 900;
    you.body.reset(0, 0);
    you.angle = 0;
    sim.steerAngle(0, 0);

    const victim = sim.snakes[1];
    victim.alive = true;
    victim.diedAt = -1;
    /* Long enough that the stretch the whale crosses is still *on* it: only
       `lengthOf(score)` of trail counts as body, and a line longer than that
       is a line whose far end has already been forgotten. */
    victim.score = 200;
    victim.body.reset(200, -400);
    // Lay a line of body straight across the whale's path.
    for (let i = 1; i <= 200; i++) victim.body.advance(200, -400 + i * 4);
    victim.angle = Math.PI / 2;
    victim.targetAngle = Math.PI / 2;
    victim.brain = undefined;

    run(sim, 1.2);
    expect(you.alive).toBe(false);
    // ...and the minnow is fine.
    expect(victim.alive).toBe(true);
  });

  it("never kills a snake on its own body", () => {
    const sim = solo();
    const you = sim.you;
    you.score = 600;
    you.body.reset(0, 0);
    you.angle = 0;
    // Hold the tightest possible turn for long enough to lap the loop several
    // times. Crossing your own line is legal, and this proves it stays legal.
    for (let i = 0; i < 60 / TICK; i++) {
      sim.steerAngle(0, you.angle + 1);
      sim.step(TICK, think);
      if (!you.alive) break;
    }
    expect(you.alive).toBe(true);
  });

  it("kills both when two heads meet in the same tick", () => {
    const sim = solo();
    /* Trails are laid *behind* each head: `reset` places the tail and every
       `advance` moves the head forwards. Building them the other way round
       leaves both heads a body-length further apart than intended, which is a
       mistake that reads as a passing test right up until it does not. */
    const a = sim.you;
    a.score = 100;
    a.body.reset(-190, 0);
    for (let i = 1; i <= 40; i++) a.body.advance(-190 + i * 4, 0);
    a.angle = 0;
    sim.steerAngle(0, 0);

    const b = sim.snakes[1];
    b.alive = true;
    b.diedAt = -1;
    b.score = 100;
    b.body.reset(190, 0);
    for (let i = 1; i <= 40; i++) b.body.advance(190 - i * 4, 0);
    b.angle = Math.PI;
    b.targetAngle = Math.PI;
    b.brain = undefined;

    run(sim, 0.4);
    expect(a.alive).toBe(false);
    expect(b.alive).toBe(false);
  });

  it("kills you on the wall", () => {
    const sim = solo();
    const you = sim.you;
    you.body.reset(ARENA_R - 60, 0);
    you.angle = 0;
    sim.steerAngle(0, 0);
    run(sim, 1.2);
    expect(you.alive).toBe(false);
  });

  it("turns a corpse into orbs worth having", () => {
    const sim = solo();
    const you = sim.you;
    you.score = 400;
    you.body.reset(0, 0);
    for (let i = 1; i <= 400; i++) you.body.advance(i * 4, 0);
    const before = sim.orbs.length;

    const victim = sim.snakes[1];
    victim.alive = true;
    victim.diedAt = -1;
    victim.score = 30;
    victim.body.reset(-500, 0);
    victim.brain = undefined;
    // Drive the victim's head into the whale's line.
    victim.body.reset(600, -30);
    victim.angle = Math.PI / 2;
    victim.targetAngle = Math.PI / 2;
    run(sim, 0.6);

    expect(victim.alive).toBe(false);
    const spill = sim.orbs.length - before;
    expect(spill).toBeGreaterThan(3);
    const value = sim.orbs.slice(before).reduce((t, o) => t + o.value, 0);
    expect(value).toBeGreaterThan(10);
  });
});

describe("eating", () => {
  it("turns orbs into length", () => {
    const sim = solo();
    const you = sim.you;
    you.body.reset(0, 0);
    you.angle = 0;
    sim.steerAngle(0, 0);
    const before = you.score;
    for (let i = 0; i < 6; i++) {
      sim.orbs.push({
        id: 90000 + i,
        x: 30 + i * 20,
        y: 0,
        value: 3,
        r: 6,
        hue: 200,
        phase: 0,
      });
    }
    run(sim, 1.2);
    expect(you.score).toBeCloseTo(before + 18, 4);
    expect(sim.orbs.some((o) => o.id >= 90000 && o.id < 90006)).toBe(false);
  });

  it("restocks the arena as it is grazed", () => {
    const sim = new CoilSim({ seed: 3, skill: "cruise" });
    const target = sim.orbs.length;
    sim.orbs.length = target - 300;
    run(sim, 6);
    expect(sim.orbs.length).toBeGreaterThan(target - 300);
  });
});

describe("the cast", () => {
  it("draws every snake from the vibeverse's own characters", () => {
    const sim = new CoilSim({ seed: 9, skill: "standard" });
    for (const s of sim.snakes) {
      expect(s.charId, `${s.name} has no character`).toBeTruthy();
      expect(s.color).toMatch(/^#|^rgb/);
    }
  });

  it("never seats the same character twice, or the player's", () => {
    const rng = new Rng(11);
    const looks = botLooks(20, "pixel", rng);
    expect(looks.some((l) => l.charId === "pixel")).toBe(false);
    expect(new Set(looks.map((l) => l.name)).size).toBe(20);
  });

  it("keeps a name for every bot even past the end of the portrait roster", () => {
    const rng = new Rng(12);
    const looks = botLooks(PORTRAIT_IDS.length + 6, "pixel", rng);
    expect(new Set(looks.map((l) => l.name)).size).toBe(looks.length);
  });

  it("falls back to an emoji for a character with no portrait", () => {
    // The free roster is GLBs with no 2D art; a snake wearing one still needs
    // a face.
    const look = lookFor("definitely-not-a-character");
    expect(look.emoji.length).toBeGreaterThan(0);
    expect(look.color).toBeTruthy();
  });
});

describe("the grid", () => {
  it("finds what is inside the query and not what is outside", () => {
    const g = new HitGrid(1000, 100);
    g.insert({ x: -400, y: -400, snake: 1, r: 8 });
    g.insert({ x: 400, y: 400, snake: 2, r: 8 });
    const out: { snake: number }[] = [];
    g.query(-400, -400, 50, out as never);
    expect(out.map((o) => o.snake)).toEqual([1]);
  });

  it("clamps a query that runs off the edge of the arena", () => {
    const g = new HitGrid(1000, 100);
    g.insert({ x: 0, y: 0, snake: 1, r: 8 });
    const out: unknown[] = [];
    expect(() => g.query(-99999, 99999, 50, out as never)).not.toThrow();
  });
});

describe("the bots", () => {
  it("plays a whole match without throwing or emptying the arena", () => {
    const sim = new CoilSim({ seed: 4, skill: "swarm" });
    run(sim, 30);
    expect(sim.aliveCount()).toBeGreaterThan(6);
    for (const s of sim.snakes) {
      expect(Number.isFinite(s.body.headX), `${s.name} left the plane`).toBe(true);
      expect(s.score).toBeGreaterThan(0);
    }
  });

  it("keeps them inside the arena most of the time", () => {
    const sim = new CoilSim({ seed: 6, skill: "standard" });
    run(sim, 25);
    // Some deaths on the wall are legitimate — bots get driven into it. What
    // would be broken is the whole field steering into it.
    const inside = sim.snakes.filter(
      (s) => s.alive && Math.hypot(s.body.headX, s.body.headY) < ARENA_R,
    );
    expect(inside.length).toBeGreaterThan(6);
  });

  it("turns away from a wall it is pointed at", () => {
    const sim = new CoilSim({ seed: 7, skill: "standard" });
    const bot = sim.snakes[1];
    bot.alive = true;
    bot.diedAt = -1;
    bot.body.reset(ARENA_R - 200, 0);
    bot.angle = 0;
    bot.targetAngle = 0;
    bot.brain!.commitUntil = 0;
    // One tick so the broad phase is rebuilt around the body just placed.
    sim.step(TICK, think);
    think(sim, bot);
    // Anything but "straight on into it".
    expect(Math.abs(bot.brain!.want)).toBeGreaterThan(0.25);
  });

  it("gets somewhere — a leader that never grows means the arena is starving", () => {
    /* Not "total score goes up": unlike BLOB, a death here *recycles* — the
       snake resets to the starting length and most of what it was carrying
       becomes orbs. The field's total is therefore a balance, not a ramp, and
       asserting on it tests the weather. What must be true is that somebody is
       getting long. */
    const sim = new CoilSim({ seed: 8, skill: "standard" });
    run(sim, 45);
    expect(sim.standings(1)[0].score).toBeGreaterThan(START_SCORE * 4);
    expect(sim.orbs.length).toBeGreaterThan(1000);
  });
});

describe("standings", () => {
  it("ranks by length and leaves the dead out", () => {
    const sim = new CoilSim({ seed: 21, skill: "cruise" });
    const rows = sim.standings(10);
    expect(rows.length).toBeGreaterThan(1);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].score).toBeGreaterThanOrEqual(rows[i].score);
    }
    // You have not pressed play, so you are not on the board.
    expect(rows.some((r) => r.id === 0)).toBe(false);
    expect(sim.leader()).toBeTruthy();
  });

  it("puts you back at the starting length when you respawn", () => {
    const sim = solo();
    sim.you.score = 900;
    sim.respawnYou();
    expect(sim.you.score).toBe(START_SCORE);
    expect(sim.you.alive).toBe(true);
    expect(Math.hypot(sim.you.body.headX, sim.you.body.headY)).toBeLessThan(ARENA_R);
  });
});
