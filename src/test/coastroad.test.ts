import { describe, expect, it } from "vitest";
import {
  LENGTH,
  ROAD_HALF,
  coastAt,
  elevationAt,
  makeCourse,
  newRide,
  roadAt,
  roadTable,
  stepRide,
  terrainAt,
  type RideInput,
} from "@/coastroad/road";

function autopilot(style: "painted" | "lens", jump: boolean, maxSeconds = 600) {
  const course = makeCourse(style);
  const st = newRide();
  const input: RideInput = { steer: 0, jump: false, tuck: true, brake: false };
  const dt = 1 / 60;
  let t = 0;
  while (!st.finished && t < maxSeconds) {
    const p = roadAt(st.s + 6);
    input.steer = Math.max(-1, Math.min(1, p.curve * 150 - st.lat * 0.7));
    const ob = course.obstacles[st.nextObstacle];
    input.jump = jump && !!ob && ob.s - st.s < 3.5 && ob.s - st.s > 1.5 && Math.abs(ob.lat - st.lat) < ob.width / 2 + 0.3;
    stepRide(st, input, course, dt);
    t += dt;
  }
  return { st, course, t };
}

describe("the road", () => {
  it("is a continuous table that runs the whole length and ends on the sand", () => {
    const t = roadTable();
    expect(t.length).toBeGreaterThan(1000);
    for (let i = 1; i < t.length; i++) {
      const d = Math.hypot(t[i].x - t[i - 1].x, t[i].z - t[i - 1].z);
      expect(d).toBeGreaterThan(1.5);
      expect(d).toBeLessThan(2.5);
    }
    expect(elevationAt(0)).toBeGreaterThan(150);
    expect(elevationAt(LENGTH)).toBeLessThan(4);
  });

  it("is downhill on average and never a cliff", () => {
    let up = 0;
    for (let s = 0; s < LENGTH; s += 2) {
      const g = roadAt(s).grade;
      expect(Math.abs(g)).toBeLessThan(0.2);
      if (g > 0) up += 2;
    }
    expect(up / LENGTH).toBeLessThan(0.2);
  });

  it("keeps the road bed flat and puts the sea on the left", () => {
    for (const s of [10, 500, 1300, 2200]) {
      const p = roadAt(s);
      expect(terrainAt(s, 0, p.x, p.z)).toBeCloseTo(p.y - 0.06, 3);
      expect(coastAt(s)).toBeGreaterThan(20);
      expect(terrainAt(s, coastAt(s) + 60, p.x, p.z)).toBeLessThan(0);
      expect(terrainAt(s, -60, p.x, p.z)).toBeGreaterThan(p.y);
    }
  });
});

describe("the ride", () => {
  it("gets to the beach in both looks, in a few minutes", () => {
    for (const style of ["painted", "lens"] as const) {
      const { st, t } = autopilot(style, true);
      expect(st.finished).toBe(true);
      expect(t).toBeGreaterThan(90);
      expect(t).toBeLessThan(420);
      expect(st.topSpeed).toBeGreaterThan(10);
      expect(st.hits + st.jumped).toBeGreaterThan(0);
    }
  });

  it("is deterministic", () => {
    const a = autopilot("painted", true);
    const b = autopilot("painted", true);
    expect(a.st.flow).toBeCloseTo(b.st.flow, 6);
    expect(a.st.elapsed).toBeCloseTo(b.st.elapsed, 6);
  });

  it("clears cracks in the air and finds them on the ground", () => {
    const flying = autopilot("painted", true);
    const rolling = autopilot("painted", false);
    expect(flying.st.jumped).toBeGreaterThan(rolling.st.jumped);
    expect(rolling.st.hits).toBeGreaterThan(0);
    expect(flying.st.flow).toBeGreaterThan(rolling.st.flow);
  });

  it("never leaves the verge and never dies", () => {
    const course = makeCourse("lens");
    const st = newRide();
    const input: RideInput = { steer: 1, jump: false, tuck: false, brake: false };
    for (let i = 0; i < 60 * 120 && !st.finished; i++) stepRide(st, input, course, 1 / 60);
    expect(Math.abs(st.lat)).toBeLessThanOrEqual(ROAD_HALF + 1.6 + 1e-6);
    expect(st.speed).toBeGreaterThanOrEqual(0);
    expect(st.onGrass).toBe(true);
  });

  it("has gusts, and they lean on you", () => {
    const { st, course } = autopilot("painted", true);
    expect(course.gusts.length).toBeGreaterThan(5);
    expect(st.nextGust).toBe(course.gusts.length);
  });

  it("is faster in a tuck", () => {
    const course = makeCourse("painted");
    const a = newRide();
    const b = newRide();
    for (let i = 0; i < 60 * 40; i++) {
      stepRide(a, { steer: 0, jump: false, tuck: true, brake: false }, course, 1 / 60);
      stepRide(b, { steer: 0, jump: false, tuck: false, brake: false }, course, 1 / 60);
    }
    expect(a.s).toBeGreaterThan(b.s);
  });
});
