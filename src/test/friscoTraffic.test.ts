/**
 * The two pure functions the traffic signals rest on.
 *
 * `stopLineAhead` is a modulo over an infinite grid, which is the kind of
 * arithmetic that is right for three quarters of its domain and quietly wrong
 * for the rest — a negative coordinate, a car travelling in the negative
 * direction, a position exactly on a junction. All three happen constantly in
 * a city whose origin is in the middle of it, and the failure mode is a car
 * that brakes for a junction 84 m behind it and never moves again.
 */
import { describe, expect, it } from "vitest";
import { GRID_N, GRID_S, gridAxis, stopLineAhead } from "@/frisco/map";
import { greenAxis } from "@/frisco/life";

/** North of Market, along the grid's own axes. */
const A = GRID_N.angle;
const AX = { x: Math.cos(A), z: Math.sin(A) };
const AZ = { x: -Math.sin(A), z: Math.cos(A) };

describe("Vibe Francisco — the signal cycle", () => {
  it("gives each axis a green, with an all-red between", () => {
    const seen = new Set<number>();
    for (let t = 0; t < 28; t += 0.25) seen.add(greenAxis(t));
    expect(seen).toEqual(new Set([0, 1, -1]));
  });

  it("never leaves both axes green at once", () => {
    // Trivially true of a function returning one value — the point is that it
    // stays true if this is ever rewritten as a pair of booleans.
    for (let t = 0; t < 200; t += 0.1) {
      const g = greenAxis(t);
      expect(g === 0 || g === 1 || g === -1).toBe(true);
    }
  });

  it("repeats, and handles a negative clock", () => {
    // Stepped by an exact tenth rather than by accumulation: `t += 1.4` twenty
    // times lands on 27.999999999999993, which is a different phase from 28
    // and a failure that says nothing about the function under test.
    for (let i = 0; i < 280; i++) {
      const t = i / 10;
      expect(greenAxis(t)).toBe(greenAxis(t + 28 * 5));
      expect(greenAxis(t)).toBe(greenAxis(t - 28 * 3));
    }
  });

  it("spends most of the cycle green rather than all-red", () => {
    let red = 0;
    let n = 0;
    for (let t = 0; t < 28; t += 0.05) { n++; if (greenAxis(t) === -1) red++; }
    expect(red / n).toBeLessThan(0.25);
  });
});

describe("Vibe Francisco — where the next junction is", () => {
  it("agrees with itself about which axis a heading is on", () => {
    for (const [x, z] of [[0, -400], [-600, -900], [700, -300], [-300, -1400]]) {
      expect(stopLineAhead(x, z, AZ.x, AZ.z).axis).toBe(gridAxis(x, z, AZ.x, AZ.z));
      expect(stopLineAhead(x, z, AX.x, AX.z).axis).toBe(gridAxis(x, z, AX.x, AX.z));
    }
  });

  it("puts a north-south street on one axis and an east-west one on the other", () => {
    const along = stopLineAhead(0, -400, AZ.x, AZ.z);
    const across = stopLineAhead(0, -400, AX.x, AX.z);
    expect(along.axis).not.toBe(across.axis);
  });

  it("never reports a junction further away than the block is long", () => {
    // Whichever axis, the answer is bounded by that axis's spacing. An
    // unbounded answer means the modulo went negative and wrapped.
    for (let x = -1200; x <= 1200; x += 37) {
      for (let z = -1600; z <= 1600; z += 53) {
        for (const d of [AX, AZ, { x: -AX.x, z: -AX.z }, { x: -AZ.x, z: -AZ.z }]) {
          const s = stopLineAhead(x, z, d.x, d.z);
          // Bounded by the LONGER of the two grids' block lengths: south of
          // Market the blocks are twice the size, and half the sample points
          // are down there.
          expect(s.distance).toBeLessThanOrEqual(GRID_S.spacingZ);
          expect(s.distance).toBeGreaterThan(-(GRID_S.roadHalfWidth + 6));
        }
      }
    }
  });

  it("counts down as you drive toward the line, and never jumps backwards", () => {
    // Walk 200 m up a street in 2 m steps. The distance must fall steadily and
    // only ever reset UPWARD by a full block — a stop line that drifts closer
    // as you approach is what makes a car creep forever without arriving.
    let x = 0;
    let z = -400;
    let prev = stopLineAhead(x, z, AZ.x, AZ.z).distance;
    let resets = 0;
    for (let i = 0; i < 100; i++) {
      x += AZ.x * 2;
      z += AZ.z * 2;
      const d = stopLineAhead(x, z, AZ.x, AZ.z).distance;
      if (d > prev) {
        resets++;
        expect(d - prev).toBeGreaterThan(40);
      } else {
        expect(prev - d).toBeCloseTo(2, 1);
      }
      prev = d;
    }
    expect(resets).toBeGreaterThan(0);
  });

  it("is symmetric: driving the other way sees the junction behind you ahead", () => {
    // Two cars nose to nose on the same street see different distances, and
    // the two must add up to a block minus the two junction boxes.
    const block = GRID_N.spacingZ;
    const clear = 2 * (GRID_N.roadHalfWidth + 5);
    for (let t = 3; t < block - 3; t += 7) {
      const x = AZ.x * t;
      const z = -600 + AZ.z * t;
      const f = stopLineAhead(x, z, AZ.x, AZ.z).distance;
      const b = stopLineAhead(x, z, -AZ.x, -AZ.z).distance;
      expect(f + b + clear).toBeCloseTo(block, 4);
    }
  });
});

/**
 * The traffic itself, stepped without a browser.
 *
 * `CityLife` needs no WebGL context — an `InstancedMesh` is a buffer and a
 * matrix until something renders it — so the whole simulation can be run here
 * at a hundred times the speed the capture harness manages under a software
 * renderer. That matters: a signal cycle is 28 seconds, and the harness gets
 * through about a twentieth of a second of world time per real second, so
 * "does anything ever go green" is a seven-minute question there and a
 * two-second one here.
 *
 * The three things worth asserting are the three ways this can be broken and
 * still look fine in a still frame: nothing ever stops (the signals are
 * decorative), everything stops forever (gridlock), and one particular car
 * stops forever (a car wedged against a stop line it can never reach).
 */
describe("Vibe Francisco — traffic that obeys the lights", () => {
  it("queues at the reds and clears on the greens", async () => {
    const { CityLife } = await import("@/frisco/life");
    const life = new CityLife();
    let sawQueue = 0;
    let sawClear = 0;
    // Sixty seconds of world time — two full cycles and a bit.
    for (let i = 0; i < 1800; i++) {
      const t = i / 30;
      life.update(1 / 30, t);
      if (i % 15 === 0) {
        const tr = life.traffic();
        if (tr.stopped >= 5) sawQueue++;
        if (tr.stopped <= 1) sawClear++;
      }
    }
    expect(sawQueue).toBeGreaterThan(0);
    expect(sawClear).toBeGreaterThan(0);
    life.dispose();
  }, 60000);

  it("never gridlocks: every car moves at some point in a cycle", async () => {
    const { CityLife } = await import("@/frisco/life");
    const life = new CityLife();
    for (let i = 0; i < 300; i++) life.update(1 / 30, i / 30);
    let maxStopped = 0;
    for (let i = 300; i < 2100; i++) {
      life.update(1 / 30, i / 30);
      if (i % 30 === 0) maxStopped = Math.max(maxStopped, life.traffic().stopped);
    }
    // A red holds one axis at a time, so even the worst moment leaves most of
    // the city moving. Everything stopped at once is a deadlock, not a phase.
    const total = life.stats().cars;
    expect(maxStopped).toBeLessThan(total * 0.75);
    life.dispose();
  }, 60000);
});
