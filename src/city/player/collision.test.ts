/**
 * The bug these exist to prevent: for a long time "am I standing on a
 * cloud?" was answered by asking whether the surface sat between y=140
 * and y=260. That was true when it was written, and then the Moon
 * settled at 175, Moon II at 205 and Mars at 240, and every step on
 * three entire worlds launched the player 16 m/s into the sky.
 *
 * So the first block below walks a box up through every altitude the
 * world uses and asserts it is still just ground. If someone ever
 * reintroduces a height-based special case, that is the test that goes
 * red.
 */
import { describe, it, expect } from "vitest";
import { CollisionWorld } from "./collision";
import type { WorldBox } from "@/components/city/cardboardIsland";

const box = (b: Partial<WorldBox> & { height: number }): WorldBox => ({
  minX: -10, maxX: 10, minZ: -10, maxZ: 10,
  base: b.height - 5,
  ...b,
});

const world = (boxes: WorldBox[], analyticHeightAt?: (x: number, z: number) => number | null) =>
  new CollisionWorld(boxes, { radius: 0.4, analyticHeightAt });

describe("bounciness is a property of the surface, not its altitude", () => {
  // Every altitude a real world in this game sits at, plus the range
  // that used to be hard-coded as "cloud".
  const ALTITUDES = [0, 55, 85, 115, 120, 139, 140, 150, 175, 205, 240, 259, 260, 300];

  it.each(ALTITUDES)("an untagged surface at y=%i is solid ground", (y) => {
    const w = world([box({ height: y })]);
    expect(w.supportAt(0, 0, y + 5).bouncy).toBe(0);
  });

  it("reports the launch speed the cloud itself carries", () => {
    const w = world([box({ height: 175, bouncy: 16 })]);
    expect(w.supportAt(0, 0, 200)).toMatchObject({ height: 175, bouncy: 16 });
  });

  it("keeps the Cloud Kingdom's stronger launch distinct from a puff's", () => {
    const puff = world([box({ height: 200, bouncy: 16 })]);
    const kingdom = world([box({ height: 250, bouncy: 30 })]);
    expect(puff.supportAt(0, 0, 260).bouncy).toBe(16);
    expect(kingdom.supportAt(0, 0, 260).bouncy).toBe(30);
  });

  it("does not leak bounciness from a taller cloud onto the ground below it", () => {
    // Landing on the plaza while a bouncy cloud drifts overhead.
    const w = world([box({ height: 0 }), box({ height: 200, bouncy: 16 })]);
    expect(w.supportAt(0, 0, 1)).toMatchObject({ height: 0, bouncy: 0 });
  });

  it("clears bounciness left over from a previous query", () => {
    const w = world([box({ height: 200, bouncy: 16 }), box({ minX: 100, maxX: 120, height: 240 })]);
    expect(w.supportAt(0, 0, 210).bouncy).toBe(16);
    expect(w.supportAt(110, 0, 250).bouncy).toBe(0);
  });
});

describe("support selection", () => {
  it("ignores surfaces above the player, so a floating island can be flown under", () => {
    const w = world([box({ height: 120 })]);
    expect(w.supportHeightAt(0, 0, 40)).toBe(0); // street, not the island
  });

  it("picks the highest surface at or below the player", () => {
    const w = world([box({ height: 10 }), box({ height: 40 }), box({ height: 90 })]);
    expect(w.supportHeightAt(0, 0, 50)).toBe(40);
  });

  it("lets the street plate beat a box with a sunken top", () => {
    // The Gremlin Mines floor once sat directly under the plaza and the
    // player dropped 300m through downtown.
    const w = world([box({ height: -300, base: -400 })]);
    expect(w.supportHeightAt(0, 0, 2)).toBe(0);
  });

  it("drops the implicit street plate below the underworld line", () => {
    const w = world([]);
    expect(w.supportHeightAt(0, 0, -200)).toBeLessThan(-200);
  });

  it("treats analytic terrain slightly above the player as a step up", () => {
    // Walking uphill on Powder Peak should behave like stairs.
    const w = world([], () => 10.5);
    expect(w.supportHeightAt(0, 0, 10)).toBe(10.5);
  });

  it("does not treat analytic terrain far above the player as support", () => {
    const w = world([], () => 40);
    expect(w.supportHeightAt(0, 0, 10)).toBe(0);
  });

  it("never reports analytic snow as bouncy", () => {
    const w = world([box({ height: 200, bouncy: 16 })], () => 210);
    expect(w.supportAt(0, 0, 220).bouncy).toBe(0);
  });

  it("respects the player's radius at a box edge", () => {
    const w = world([box({ minX: -10, maxX: 10, height: 20 })]);
    expect(w.supportHeightAt(10.3, 0, 30)).toBe(20);  // toes still on
    expect(w.supportHeightAt(10.5, 0, 30)).toBe(0);   // stepped off
  });
});

describe("blocking and ceilings", () => {
  it("blocks a body inside a column", () => {
    const w = world([box({ height: 20, base: 0 })]);
    expect(w.isBlocked(0, 0, 5)).toBe(true);
  });

  it("does not block standing on top of that column", () => {
    const w = world([box({ height: 20, base: 0 })]);
    expect(w.isBlocked(0, 0, 20)).toBe(false);
  });

  it("lets the player step up onto a low ledge rather than walling them off", () => {
    const w = world([box({ height: 0.3, base: 0 })]);
    expect(w.isBlocked(0, 0, 0)).toBe(false);
  });

  it("catches a head rising into the underside of a floating world", () => {
    const w = world([box({ height: 130, base: 120 })]);
    expect(w.ceilingAt(0, 0, 110, 119)).toBeCloseTo(120 - 1.8);
  });

  it("leaves a clear head alone", () => {
    const w = world([box({ height: 130, base: 120 })]);
    expect(w.ceilingAt(0, 0, 100, 105)).toBeNull();
  });

  it("sees boxes that move after construction, as drifting clouds do", () => {
    const drifting = box({ height: 200, bouncy: 16 });
    const boxes = [drifting];
    const w = world(boxes);
    expect(w.supportAt(0, 0, 210).height).toBe(200);
    drifting.height = 205;
    drifting.minX = 40; drifting.maxX = 60;
    expect(w.supportAt(0, 0, 210).height).toBe(0);   // drifted away
    expect(w.supportAt(50, 0, 210).height).toBe(205); // and arrived here
  });
});
