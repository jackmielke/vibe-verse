/**
 * BLOB — the rules, checked.
 *
 * These are the tests worth having for a game like this: not "does it render"
 * (a screenshot answers that better) but "can the thing that eats you be
 * smaller than you", which no amount of playing catches reliably because the
 * case only shows up in the exact frame where it matters.
 *
 * Every one of them builds a real sim and steps it, so they are also a smoke
 * test for the loop: a sim that throws on tick 200 fails the whole file.
 */
import { describe, expect, it } from "vitest";
import {
  EAT_RATIO,
  MAX_CELLS,
  MIN_SPLIT_MASS,
  START_MASS,
  TICK,
  VIRUS_MASS,
  WORLD,
  mergeDelay,
  radiusOf,
  speedOf,
} from "@/blob/config";
import { BlobSim } from "@/blob/sim";
import { think } from "@/blob/ai";
import { Grid } from "@/blob/spatial";
import { Rng } from "@/blob/rng";
import { hueFor, pickNames } from "@/blob/names";

/** A dish with nobody in it but you, so a test can state its own scenario. */
function soloSim(): BlobSim {
  const sim = new BlobSim({ seed: 7, skill: "chill" });
  for (const p of sim.players) {
    if (p.isBot) {
      p.cells.length = 0;
      p.alive = false;
      // Far in the future, so `respawnBots` leaves the dish empty for the test.
      p.diedAt = 1e9;
    }
  }
  sim.food.length = 0;
  sim.viruses.length = 0;
  sim.respawnYou();
  return sim;
}

const run = (sim: BlobSim, seconds: number) => {
  const steps = Math.round(seconds / TICK);
  for (let i = 0; i < steps; i++) sim.step(TICK, think);
};

describe("blob maths", () => {
  it("grows radius with the square root of mass, so area is the score", () => {
    expect(radiusOf(100)).toBeCloseTo(radiusOf(25) * 2, 6);
  });

  it("makes big cells slower than small ones, but never stops them", () => {
    expect(speedOf(START_MASS)).toBeGreaterThan(speedOf(START_MASS * 10));
    expect(speedOf(100_000)).toBeGreaterThan(20);
  });

  it("caps the merge delay so a whale is not welded apart forever", () => {
    expect(mergeDelay(1e9)).toBeLessThanOrEqual(26);
    expect(mergeDelay(50)).toBeLessThan(mergeDelay(5000));
  });

  it("keeps player hues out of the virus band", () => {
    for (let i = 0; i < 40; i++) {
      const h = hueFor(i, 40);
      expect(h <= 70 || h >= 170, `hue ${h} is virus green`).toBe(true);
    }
  });

  it("never hands two bots the same name", () => {
    const rng = new Rng(3);
    const names = pickNames(60, () => rng.next());
    expect(new Set(names).size).toBe(60);
  });

  it("replays exactly from a seed", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 50; i++) expect(a.next()).toBe(b.next());
    expect(new Rng(0).next()).not.toBeNaN();
  });
});

describe("the grid", () => {
  it("finds what is inside the query and not what is outside it", () => {
    const g = new Grid<{ x: number; y: number; id: number }>(1000, 100);
    g.insert({ x: 50, y: 50, id: 1 });
    g.insert({ x: 900, y: 900, id: 2 });
    const out: { x: number; y: number; id: number }[] = [];
    g.query(50, 50, 60, out);
    expect(out.map((o) => o.id)).toEqual([1]);
    g.query(900, 900, 60, out);
    expect(out.map((o) => o.id)).toEqual([2]);
  });

  it("clamps queries that run off the edge of the world", () => {
    const g = new Grid<{ x: number; y: number }>(1000, 100);
    g.insert({ x: 5, y: 5 });
    const out: { x: number; y: number }[] = [];
    expect(() => g.query(-9000, -9000, 50, out)).not.toThrow();
    g.query(0, 0, 40, out);
    expect(out.length).toBe(1);
  });
});

describe("eating", () => {
  it("lets a big cell swallow a small one it is on top of", () => {
    const sim = soloSim();
    const you = sim.you;
    const me = you.cells[0];
    me.mass = 400;
    me.r = radiusOf(400);
    me.x = 3000;
    me.y = 3000;
    me.px = me.x;
    me.py = me.y;

    const victim = sim.players[1];
    victim.alive = true;
    victim.diedAt = -1;
    victim.cells = [
      {
        id: 9001,
        owner: victim.id,
        x: 3010,
        y: 3000,
        px: 3010,
        py: 3000,
        vx: 0,
        vy: 0,
        mass: 40,
        r: radiusOf(40),
        mergeAt: 0,
        bornAt: 0,
      },
    ];
    sim.setAim(you.id, me.x, me.y);
    sim.step(TICK, think);

    expect(victim.cells.length).toBe(0);
    expect(victim.alive).toBe(false);
    expect(sim.massOf(you)).toBeGreaterThan(430);
    expect(sim.events.some((e) => e.type === "kill")).toBe(true);
  });

  it("does not let a cell eat something it is barely bigger than", () => {
    const sim = soloSim();
    const me = sim.you.cells[0];
    me.mass = 100;
    me.r = radiusOf(100);
    me.x = 3000;
    me.y = 3000;

    const other = sim.players[1];
    other.alive = true;
    other.diedAt = -1;
    // Inside the ratio (100 < 90 * 1.18), so the overlap must not matter.
    const mass = 100 / EAT_RATIO + 1;
    other.cells = [
      {
        id: 9002,
        owner: other.id,
        x: 3000,
        y: 3000,
        px: 3000,
        py: 3000,
        vx: 0,
        vy: 0,
        mass,
        r: radiusOf(mass),
        mergeAt: 0,
        bornAt: 0,
      },
    ];
    sim.step(TICK, think);
    expect(other.cells.length).toBe(1);
  });

  it("requires real overlap, not a graze", () => {
    const sim = soloSim();
    const me = sim.you.cells[0];
    me.mass = 900;
    me.r = radiusOf(900);
    me.x = 3000;
    me.y = 3000;
    sim.setAim(sim.you.id, me.x, me.y);

    const other = sim.players[1];
    other.alive = true;
    other.diedAt = -1;
    other.cells = [
      {
        id: 9003,
        owner: other.id,
        // Touching rims: distance is exactly the sum of the radii.
        x: 3000 + radiusOf(900) + radiusOf(30),
        y: 3000,
        px: 0,
        py: 0,
        vx: 0,
        vy: 0,
        mass: 30,
        r: radiusOf(30),
        mergeAt: 0,
        bornAt: 0,
      },
    ];
    other.aimX = other.cells[0].x + 500;
    other.aimY = other.cells[0].y;
    other.brain = undefined;
    sim.step(TICK, think);
    expect(other.cells.length).toBe(1);
  });

  it("turns pellets into mass", () => {
    const sim = soloSim();
    const me = sim.you.cells[0];
    const before = me.mass;
    for (let i = 0; i < 5; i++) {
      sim.food.push({
        id: 5000 + i,
        x: me.x + i,
        y: me.y,
        mass: 2,
        hue: 100,
        phase: 0,
      });
    }
    sim.setAim(sim.you.id, me.x, me.y);
    sim.step(TICK, think);
    expect(sim.you.cells[0].mass).toBeCloseTo(before + 10, 4);
    // Not `food.length === 0`: the dish regrows a pellet on the same tick it
    // loses one, so the thing to check is that *these* five are gone.
    expect(sim.food.filter((f) => f.id >= 5000 && f.id < 5005)).toEqual([]);
  });
});

describe("splitting", () => {
  it("halves a cell and throws the new half at the aim", () => {
    const sim = soloSim();
    const me = sim.you.cells[0];
    me.mass = 200;
    me.r = radiusOf(200);
    sim.setAim(0, me.x + 1000, me.y);
    sim.requestSplit(0);

    expect(sim.you.cells.length).toBe(2);
    for (const c of sim.you.cells) expect(c.mass).toBeCloseTo(100, 6);
    const child = sim.you.cells[1];
    expect(child.vx).toBeGreaterThan(0);
    expect(Math.abs(child.vy)).toBeLessThan(1e-6);
  });

  it("refuses to split a cell that is too small", () => {
    const sim = soloSim();
    sim.you.cells[0].mass = MIN_SPLIT_MASS - 1;
    sim.requestSplit(0);
    expect(sim.you.cells.length).toBe(1);
  });

  it("never exceeds the cell cap, however many times you press it", () => {
    const sim = soloSim();
    const me = sim.you.cells[0];
    me.mass = 40_000;
    me.r = radiusOf(40_000);
    for (let i = 0; i < 12; i++) {
      sim.requestSplit(0);
      run(sim, 0.4);
    }
    expect(sim.you.cells.length).toBeLessThanOrEqual(MAX_CELLS);
  });

  it("merges the halves back together once the timer is up, keeping the mass", () => {
    const sim = soloSim();
    const me = sim.you.cells[0];
    // Under the decay floor on purpose: this test is about conservation, and a
    // cell heavy enough to rot loses a percent over the twenty seconds it takes
    // to merge, which would make the assertion about decay instead.
    me.mass = 200;
    me.r = radiusOf(200);
    sim.setAim(0, me.x + 400, me.y);
    sim.requestSplit(0);
    const total = sim.massOf(sim.you);
    expect(sim.you.cells.length).toBe(2);

    // Steer both halves at one point and wait out the merge delay.
    sim.setAim(0, me.x, me.y);
    run(sim, mergeDelay(100) + 8);
    expect(sim.you.cells.length).toBe(1);
    expect(sim.massOf(sim.you)).toBeCloseTo(total, 3);
  });

  it("keeps split halves from sitting inside each other", () => {
    const sim = soloSim();
    const me = sim.you.cells[0];
    me.mass = 600;
    me.r = radiusOf(600);
    sim.setAim(0, me.x + 400, me.y);
    sim.requestSplit(0);
    run(sim, 2);
    const [a, b] = sim.you.cells;
    // Not merged yet, so they must be visibly two blobs.
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(Math.max(a.r, b.r) * 0.5);
  });
});

describe("viruses", () => {
  it("bursts a cell that is bigger than the virus", () => {
    const sim = soloSim();
    const me = sim.you.cells[0];
    me.mass = 1200;
    me.r = radiusOf(1200);
    me.x = 3000;
    me.y = 3000;
    sim.setAim(0, me.x, me.y);
    sim.viruses.push({
      id: 8000,
      x: 3000,
      y: 3000,
      vx: 0,
      vy: 0,
      mass: VIRUS_MASS,
      fed: 0,
      feedAngle: 0,
      spin: 0,
    });
    sim.step(TICK, think);
    expect(sim.you.cells.length).toBeGreaterThan(1);
    expect(sim.events.some((e) => e.type === "pop")).toBe(true);
    // The virus is gone, and the dish restocked to keep the count constant.
    expect(sim.viruses.some((v) => v.id === 8000)).toBe(false);
  });

  it("leaves a small cell alone — that is what makes it cover", () => {
    const sim = soloSim();
    const me = sim.you.cells[0];
    me.x = 3000;
    me.y = 3000;
    me.mass = VIRUS_MASS - 10;
    me.r = radiusOf(me.mass);
    sim.viruses.push({
      id: 8001,
      x: 3000,
      y: 3000,
      vx: 0,
      vy: 0,
      mass: VIRUS_MASS,
      fed: 0,
      feedAngle: 0,
      spin: 0,
    });
    sim.step(TICK, think);
    expect(sim.you.cells.length).toBe(1);
  });

  it("shoots a new virus once it has been fed enough", () => {
    const sim = soloSim();
    sim.viruses.push({
      id: 8002,
      x: 3000,
      y: 3000,
      vx: 0,
      vy: 0,
      mass: VIRUS_MASS,
      fed: 0,
      feedAngle: 0,
      spin: 0,
    });
    const before = sim.viruses.length;
    for (let i = 0; i < 7; i++) {
      sim.pellets.push({
        id: 7000 + i,
        x: 3000,
        y: 3000,
        vx: 200,
        vy: 0,
        mass: 14,
        hue: 0,
        from: 0,
        bornAt: -10,
      });
    }
    sim.step(TICK, think);
    expect(sim.viruses.length).toBe(before + 1);
    expect(sim.pellets.length).toBe(0);
  });
});

describe("the dish", () => {
  it("keeps every cell inside the world", () => {
    const sim = new BlobSim({ seed: 11, skill: "standard" });
    run(sim, 6);
    for (const p of sim.players) {
      for (const c of p.cells) {
        expect(c.x).toBeGreaterThanOrEqual(-1);
        expect(c.x).toBeLessThanOrEqual(WORLD + 1);
        expect(c.y).toBeGreaterThanOrEqual(-1);
        expect(c.y).toBeLessThanOrEqual(WORLD + 1);
      }
    }
  });

  it("restocks pellets as they are eaten", () => {
    const sim = new BlobSim({ seed: 12, skill: "chill" });
    const target = sim.food.length;
    sim.food.length = target - 200;
    run(sim, 6);
    expect(sim.food.length).toBeGreaterThan(target - 200);
  });

  it("rots the biggest cells so a leader cannot park in a corner", () => {
    const sim = soloSim();
    const me = sim.you.cells[0];
    me.mass = 5000;
    me.r = radiusOf(5000);
    sim.setAim(0, me.x, me.y);
    run(sim, 10);
    expect(sim.you.cells[0].mass).toBeLessThan(5000);
  });

  it("does not rot a small cell", () => {
    const sim = soloSim();
    sim.setAim(0, sim.you.cells[0].x, sim.you.cells[0].y);
    run(sim, 5);
    expect(sim.you.cells[0].mass).toBeCloseTo(START_MASS, 5);
  });
});

describe("the bots", () => {
  it("plays a whole match without throwing or losing everybody", () => {
    const sim = new BlobSim({ seed: 5, skill: "frenzy" });
    run(sim, 30);
    const alive = sim.players.filter((p) => p.alive && p.isBot);
    expect(alive.length).toBeGreaterThan(4);
    for (const p of sim.players) {
      for (const c of p.cells) {
        expect(Number.isFinite(c.x) && Number.isFinite(c.y), `${p.name} left the plane`).toBe(true);
        expect(c.mass).toBeGreaterThan(0);
      }
    }
  });

  it("grows the field over time — a dish of bots that only shrinks is broken", () => {
    const sim = new BlobSim({ seed: 8, skill: "standard" });
    const before = sim.players.reduce((m, p) => m + sim.massOf(p), 0);
    run(sim, 40);
    const after = sim.players.reduce((m, p) => m + sim.massOf(p), 0);
    expect(after).toBeGreaterThan(before);
  });

  it("runs away from something that can eat it", () => {
    const sim = soloSim();
    const bot = sim.players[1];
    bot.alive = true;
    bot.diedAt = -1;
    bot.cells = [
      {
        id: 9100,
        owner: bot.id,
        x: 3000,
        y: 3000,
        px: 3000,
        py: 3000,
        vx: 0,
        vy: 0,
        mass: 40,
        r: radiusOf(40),
        mergeAt: 0,
        bornAt: 0,
      },
    ];
    // A whale directly to the east, close enough to be terrifying.
    const me = sim.you.cells[0];
    me.mass = 4000;
    me.r = radiusOf(4000);
    me.x = 3000 + me.r + 120;
    me.y = 3000;
    me.px = me.x;
    me.py = me.y;
    sim.setAim(0, me.x, me.y);

    // One tick with no brains attached, purely so the broad phase is rebuilt
    // around the bodies this test just placed by hand.
    sim.step(TICK, () => {});
    think(sim, bot);
    expect(bot.brain!.tx).toBeLessThan(3000);
  });

  it("stays inside the dish rather than steering into the wall", () => {
    const sim = soloSim();
    const bot = sim.players[2];
    bot.alive = true;
    bot.diedAt = -1;
    bot.cells = [
      {
        id: 9200,
        owner: bot.id,
        x: 40,
        y: 40,
        px: 40,
        py: 40,
        vx: 0,
        vy: 0,
        mass: 60,
        r: radiusOf(60),
        mergeAt: 0,
        bornAt: 0,
      },
    ];
    sim.step(TICK, () => {});
    think(sim, bot);
    expect(bot.brain!.tx).toBeGreaterThan(40);
    expect(bot.brain!.ty).toBeGreaterThan(40);
  });
});

describe("standings", () => {
  it("ranks by mass and leaves the dead out of it", () => {
    const sim = new BlobSim({ seed: 21, skill: "chill" });
    const rows = sim.standings(10);
    expect(rows.length).toBeGreaterThan(1);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].mass).toBeGreaterThanOrEqual(rows[i].mass);
    }
    // You have not pressed play, so you are not on the board.
    expect(rows.some((r) => r.id === 0)).toBe(false);
  });

  it("has somebody to point the title-screen camera at", () => {
    const sim = new BlobSim({ seed: 22, skill: "chill" });
    expect(sim.leader()).toBeTruthy();
  });
});
