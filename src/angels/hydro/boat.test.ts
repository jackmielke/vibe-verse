/**
 * The hydroplane, checked against the four things that make it one.
 *
 * Every number here is either a published fact about the class — race weight,
 * course length, straightaway speed — or a behaviour anybody who has watched a
 * Seafair final would recognise. None of it is a golden-value test of the
 * implementation against itself.
 */
import { describe, expect, it } from "vitest";
import {
  UNLIMITED,
  createBoatState,
  placeBoat,
  rudderAuthority,
  stepBoat,
  type BoatControls,
  type BoatEnvironment,
} from "./boat";

const DT = 1 / 120;

const OPEN: BoatEnvironment = { wake: () => 0, onWater: () => true };
const ROUGH: BoatEnvironment = { wake: () => 1, onWater: () => true };

function run(
  seconds: number,
  controls: Partial<BoatControls> = {},
  env: BoatEnvironment = OPEN,
  opts: { speed?: number } = {},
) {
  const s = createBoatState();
  placeBoat(s, 0, 0, 0, 0);
  s.speed = opts.speed ?? 0;
  const c: BoatControls = { throttle: 1, steer: 0, ...controls };
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) stepBoat(s, UNLIMITED, c, env, DT);
  return s;
}

describe("an unlimited gets up and goes", () => {
  it("reaches something like its real straightaway speed", () => {
    const s = run(60);
    const kmh = s.speed * 3.6;
    // Unlimiteds run about 320 km/h down the straight. Anywhere in this band is
    // the right aeroplane; outside it and the thrust or the drag is wrong.
    expect(kmh).toBeGreaterThan(285);
    expect(kmh).toBeLessThan(355);
  });

  it("climbs onto the plane, and the drag halves when it does", () => {
    const early = run(2.5);
    const late = run(45);
    expect(early.planing).toBeLessThan(0.5);
    expect(late.planing).toBeGreaterThan(0.95);
    // The point of planing is that it is a different vehicle above and below.
    expect(UNLIMITED.dragPlaning).toBeLessThan(UNLIMITED.dragPlowing * 0.6);
  });

  it("takes a while to get there, because three tonnes does", () => {
    const s = run(6);
    expect(s.speed * 3.6).toBeLessThan(200);
    expect(s.speed).toBeGreaterThan(12);
  });
});

describe("it steers on the water", () => {
  it("does nothing at all when it is stopped", () => {
    expect(rudderAuthority(0)).toBe(0);
    const s = run(1.5, { throttle: 0, steer: 1 });
    expect(Math.abs(s.heading)).toBeLessThan(0.02);
  });

  it("turns best in the middle of the range, not at the top", () => {
    const mid = rudderAuthority(30);
    const fast = rudderAuthority(88);
    expect(mid).toBeGreaterThan(0.5);
    expect(fast).toBeLessThan(mid * 0.6);
  });

  it("comes round to the right on right steer", () => {
    const s = run(4, { steer: 1 }, OPEN, { speed: 40 });
    expect(s.heading).toBeGreaterThan(0.4);
  });

  it("leans out of the corner rather than into it", () => {
    // A hydroplane rolls *away* from the turn: the outboard sponson is the one
    // carrying the load. Leaning in would make it a motorcycle.
    const s = run(4, { steer: 1 }, OPEN, { speed: 40 });
    expect(s.yawRate).toBeGreaterThan(0);
    expect(s.roll).toBeLessThan(-0.05);
  });

  it("scrubs speed in a corner", () => {
    const straight = run(10, { steer: 0 }, OPEN, { speed: 60 });
    const cornering = run(10, { steer: 1 }, OPEN, { speed: 60 });
    expect(cornering.speed).toBeLessThan(straight.speed - 8);
  });
});

describe("and it can blow over", () => {
  it("stays on the water flat out in clean air", () => {
    // Being unable to use the throttle is not a hazard, it is a broken boat.
    // Clean air at full noise has to be survivable, and merely uncomfortable.
    const s = run(50, { throttle: 1 }, OPEN);
    expect(s.blownOver).toBe(false);
    expect(s.lift).toBeGreaterThan(0.3);
    expect(s.lift).toBeLessThan(0.8);
  });

  it("goes over backwards at full noise in somebody else's rooster tail", () => {
    const s = run(50, { throttle: 1 }, ROUGH);
    expect(s.blownOver).toBe(true);
  });

  it("does not blow over at low speed however rough it is", () => {
    // Lift goes as the square of the speed. Rough water at twenty knots is a
    // bad ride, not an accident.
    const s = run(30, { throttle: 0.2 }, ROUGH);
    expect(s.speed * 3.6).toBeLessThan(180);
    expect(s.blownOver).toBe(false);
  });

  it("keeps flying once it has gone, and nothing brings it back", () => {
    const s = createBoatState();
    placeBoat(s, 0, 0, 0, 0);
    s.speed = 80;
    s.blownOver = true;
    const before = s.pitch;
    for (let i = 0; i < 120; i++) stepBoat(s, UNLIMITED, { throttle: 1, steer: 0 }, OPEN, DT);
    expect(s.blownOver).toBe(true);
    expect(s.pitch).toBeGreaterThan(before + 1);
  });
});

describe("it stays on the lake", () => {
  it("does not drive up the beach", () => {
    const bank: BoatEnvironment = { wake: () => 0, onWater: (_x, z) => z > -400 };
    const s = createBoatState();
    placeBoat(s, 0, 0, 0, 0); // heading north, which is -Z
    s.speed = 70;
    for (let i = 0; i < 120 * 30; i++)
      stepBoat(s, UNLIMITED, { throttle: 1, steer: 0 }, bank, DT);
    expect(s.z).toBeGreaterThan(-401);
  });
});

describe("numbers stay finite", () => {
  it("survives two minutes of nonsense", () => {
    const s = createBoatState();
    placeBoat(s, 0, 0, 0, 0);
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 120 * 120; i++) {
      stepBoat(
        s,
        UNLIMITED,
        { throttle: rnd(), steer: rnd() * 2 - 1 },
        { wake: () => rnd(), onWater: () => true },
        DT,
      );
    }
    for (const v of [s.x, s.z, s.speed, s.heading, s.yawRate, s.roll, s.pitch, s.lift]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
