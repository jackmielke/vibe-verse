/**
 * The Empyrean's body.
 *
 * The whole promise of this world is "Vibe City's jetpack, somewhere else",
 * and that promise is a set of numbers: hold thrust and you climb at
 * `MAX_RISE`, let go and you fall at `MAX_FALL`, and the horizontal speeds
 * are City's on the ground and City's in the air. If any of those drift the
 * world still builds, still renders, and quietly stops being the thing it
 * said it was — so they are asserted here rather than felt for by hand.
 *
 * The terraces are the other half. They are one-way: a deck catches you from
 * above and does not exist from below, because a jetpack world where you clip
 * onto the underside of every roof you fly past is unusable.
 */
import { describe, expect, it } from "vitest";
import {
  FLY_RUN_SPEED,
  FLY_SPEED,
  MAX_FALL,
  MAX_RISE,
  RUN_SPEED,
  WALK_SPEED,
} from "@/lib/worldPhysics";
import { makeFlyer, stepFlyer, jump, THRUST, type FlyerWorld } from "@/empyrean/flight";
import { groundHeight } from "@/empyrean/terrain";
import { GROUND_Y, ISLAND_Y, LAKE_R, PLATEAU_R, SPAWN } from "@/empyrean/config";

/** A flat world with one deck floating at y=100 over a 40 m square. */
const world: FlyerWorld = {
  supportAt(x, z, fromY) {
    if (fromY >= 100 && Math.abs(x) <= 20 && Math.abs(z) <= 20) return 100;
    return 0;
  },
  blockedAt: () => false,
  killY: -260,
  spawn: { x: 0, y: 0, z: 0, yaw: 0 },
};

const run = (s: ReturnType<typeof makeFlyer>, seconds: number, input: Partial<Parameters<typeof stepFlyer>[1]>) => {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    stepFlyer(s, { forward: 0, strafe: 0, run: false, jet: false, camYaw: 0, ...input }, world, dt);
  }
};

describe("the jetpack", () => {
  it("is Vibe City's: thrust out-accelerates gravity and settles at MAX_RISE", () => {
    const s = makeFlyer(world.spawn);
    run(s, 4, { jet: true });
    expect(s.velocity.y).toBeCloseTo(MAX_RISE, 5);
    expect(s.grounded).toBe(false);
    // Four seconds of hold should have cleared a good deal of air.
    expect(s.position.y).toBeGreaterThan(50);
  });

  it("has the net climb the shared constants imply", () => {
    // THRUST is City's number and gravity is the shared one; the sum of the
    // two is the thing a player actually feels, so assert on the sum.
    const NET = THRUST - 24;
    expect(NET).toBe(26);
  });

  it("falls at MAX_FALL and no faster when you let go", () => {
    const s = makeFlyer(world.spawn);
    s.position.y = 400;
    run(s, 6, {});
    expect(s.velocity.y).toBeCloseTo(-MAX_FALL, 5);
  });

  it("lands, reports the impact once, and stops", () => {
    const s = makeFlyer(world.spawn);
    s.position.y = 60;
    run(s, 5, {});
    expect(s.grounded).toBe(true);
    expect(s.position.y).toBe(0);
    expect(s.velocity.y).toBe(0);
    // `landed` is an event, not a state: it is only set on the touchdown frame.
    stepFlyer(s, { forward: 0, strafe: 0, run: false, jet: false, camYaw: 0 }, world, 1 / 60);
    expect(s.landed).toBe(0);
  });

  it("jumps at City's height from the ground and not at all from the air", () => {
    const s = makeFlyer(world.spawn);
    jump(s);
    expect(s.velocity.y).toBe(11);
    s.grounded = false;
    s.velocity.y = 0;
    jump(s);
    expect(s.velocity.y).toBe(0);
  });
});

describe("speeds", () => {
  it("walks and runs at City's ground speeds", () => {
    const s = makeFlyer(world.spawn);
    run(s, 3, { forward: 1 });
    expect(Math.hypot(s.velocity.x, s.velocity.z)).toBeCloseTo(WALK_SPEED, 2);

    const r = makeFlyer(world.spawn);
    run(r, 3, { forward: 1, run: true });
    expect(Math.hypot(r.velocity.x, r.velocity.z)).toBeCloseTo(RUN_SPEED, 2);
  });

  it("cruises and boosts at City's air speeds", () => {
    const s = makeFlyer(world.spawn);
    run(s, 6, { forward: 1, jet: true });
    expect(Math.hypot(s.velocity.x, s.velocity.z)).toBeCloseTo(FLY_SPEED, 1);

    const b = makeFlyer(world.spawn);
    run(b, 6, { forward: 1, jet: true, run: true });
    expect(Math.hypot(b.velocity.x, b.velocity.z)).toBeCloseTo(FLY_RUN_SPEED, 1);
  });

  it("moves where the camera is pointing, not where the world is", () => {
    const s = makeFlyer(world.spawn);
    // Camera yawed a quarter turn: "forward" is now -X.
    run(s, 2, { forward: 1, camYaw: Math.PI / 2 });
    expect(s.position.x).toBeLessThan(-5);
    expect(Math.abs(s.position.z)).toBeLessThan(0.5);
  });
});

describe("the terraces", () => {
  it("catch you from above", () => {
    const s = makeFlyer(world.spawn);
    s.position.set(0, 140, 0);
    run(s, 6, {});
    expect(s.position.y).toBe(100);
    expect(s.grounded).toBe(true);
  });

  it("are not there from underneath — you fly up past a deck, not onto it", () => {
    const s = makeFlyer(world.spawn);
    s.position.set(0, 20, 0);
    run(s, 8, { jet: true });
    // Straight through where the deck is, and well above it.
    expect(s.position.y).toBeGreaterThan(140);
    expect(s.grounded).toBe(false);
  });
});

describe("the ground", () => {
  it("is flat inside the lake, because a mirror with dunes in it is not a mirror", () => {
    for (const [x, z] of [[0, 0], [300, -120], [-700, 400]]) {
      expect(groundHeight(x, z)).toBe(GROUND_Y);
    }
  });

  it("climbs into real mountains outside it", () => {
    let peak = -Infinity;
    for (let a = 0; a < Math.PI * 2; a += 0.05) {
      for (let r = LAKE_R * 1.2; r < 7000; r += 90) {
        peak = Math.max(peak, groundHeight(Math.cos(a) * r, Math.sin(a) * r));
      }
    }
    // Real mountains — but never taller than the plaza, because a peak that
    // out-climbs the island turns the picture from "a city in the sky" into
    // "a landscape with a building in it".
    expect(peak).toBeGreaterThan(320);
    expect(peak).toBeLessThan(ISLAND_Y);
  });

  it("puts the spawn on the plaza, inside its rim", () => {
    expect(SPAWN.y).toBeGreaterThan(ISLAND_Y);
    expect(Math.hypot(SPAWN.x, SPAWN.z)).toBeLessThan(PLATEAU_R);
  });
});

describe("falling out of the world", () => {
  it("puts you back on the plaza rather than leaving you in the void", () => {
    // A world with no floor at all. The Empyrean itself has ground everywhere
    // — the lake is walkable ice — so this is a net that should never be hit
    // in play, and this is the only place it can be shown to work.
    const void_: FlyerWorld = { ...world, spawn: SPAWN, supportAt: () => -Infinity };
    const s = makeFlyer(SPAWN);
    s.position.set(0, -300, 0);
    stepFlyer(s, { forward: 0, strafe: 0, run: false, jet: false, camYaw: 0 }, void_, 1 / 60);
    expect(s.position.y).toBe(SPAWN.y);
    expect(s.velocity.length()).toBe(0);
  });
});
