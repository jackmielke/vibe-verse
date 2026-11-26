/**
 * Thanksgiving on Vibe Island: when it is on, where the parade goes, and how
 * the turkey flies. The look is checked in a browser; these pin the parts a
 * screenshot cannot.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { thanksgivingOn, isThanksgivingSeason, saveThanksgiving, paradeAt, PARADE, TURKEY_REST } from "@/city/thanksgiving";
import { MOUNT_TUNE, stepMount, type FlightState } from "@/components/city/mountFlight";
import { ROAD, PLAZA, SITE } from "@/components/city/islandPlan";

describe("when Thanksgiving is on", () => {
  beforeEach(() => localStorage.clear());

  it("turns itself on in Thanksgiving week and off the rest of the year", () => {
    expect(isThanksgivingSeason(new Date(2026, 10, 26))).toBe(true);
    expect(isThanksgivingSeason(new Date(2026, 10, 20))).toBe(true);
    expect(isThanksgivingSeason(new Date(2026, 10, 19))).toBe(false);
    expect(isThanksgivingSeason(new Date(2026, 11, 1))).toBe(false);
    expect(thanksgivingOn("", new Date(2026, 10, 26))).toBe(true);
    expect(thanksgivingOn("", new Date(2026, 6, 4))).toBe(false);
  });

  it("remembers somebody switching it off, and the URL beats both", () => {
    saveThanksgiving(false);
    expect(thanksgivingOn("", new Date(2026, 10, 26))).toBe(false);
    expect(thanksgivingOn("?thanksgiving", new Date(2026, 10, 26))).toBe(true);
    saveThanksgiving(true);
    expect(thanksgivingOn("", new Date(2026, 6, 4))).toBe(true);
    expect(thanksgivingOn("?thanksgiving=off", new Date(2026, 10, 26))).toBe(false);
  });
});

describe("the parade", () => {
  const lap = 2 * (PARADE.z1 - PARADE.z0) + 2 * Math.PI * PARADE.half;

  it("is one smooth closed loop", () => {
    let prev = paradeAt(0);
    for (let d = 0.25; d <= lap + 0.01; d += 0.25) {
      const p = paradeAt(d);
      expect(Math.hypot(p.x - prev.x, p.z - prev.z)).toBeLessThan(0.3);
      prev = p;
    }
    const end = paradeAt(lap), start = paradeAt(0);
    expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeLessThan(1e-6);
  });

  it("faces the way it is going", () => {
    for (let d = 0; d < lap; d += 1.7) {
      const a = paradeAt(d), b = paradeAt(d + 0.05);
      const dir = Math.atan2(b.x - a.x, b.z - a.z);
      const err = Math.atan2(Math.sin(dir - a.yaw), Math.cos(dir - a.yaw));
      expect(Math.abs(err)).toBeLessThan(0.15);
    }
  });

  it("stays on the High Street, off the plaza and away from the zipline", () => {
    for (let d = 0; d < lap; d += 0.5) {
      const p = paradeAt(d);
      // A 3 m wide float on the 8 m road.
      expect(Math.abs(p.x) + 1.5).toBeLessThan(ROAD.half + 0.01);
      expect(Math.hypot(p.x, p.z)).toBeGreaterThan(PLAZA.r);
      expect(Math.hypot(p.x, p.z) + 3).toBeLessThan(ROAD.ring.r - ROAD.ring.half);
      expect(p.z + 3).toBeLessThan(SITE.characterStudio.z);
    }
  });
});

describe("the turkey", () => {
  it("waits off the road, clear of Pegasus and the dragon", () => {
    expect(Math.abs(TURKEY_REST.x)).toBeGreaterThan(ROAD.half + 1);
    for (const [x, z] of [[-12, 8], [12, 8]]) {
      expect(Math.hypot(TURKEY_REST.x - x, TURKEY_REST.z - z)).toBeGreaterThan(14);
    }
  });

  it("flies slower than the others and sinks the moment you stop flapping", () => {
    expect(MOUNT_TUNE.turkey.cruise).toBeLessThan(MOUNT_TUNE.pegasus.cruise);
    expect(MOUNT_TUNE.turkey.sink).toBeLessThan(MOUNT_TUNE.pegasus.sink);
    const fly = (kind: "turkey" | "pegasus") => {
      const s: FlightState = { x: 0, y: 50, z: 0, yaw: 0, speed: 10, lift: 0, bank: 0 };
      for (let i = 0; i < 180; i++) stepMount(s, { throttle: 0, steer: 0, flap: false, dive: false }, 1 / 60, 0, kind);
      return s;
    };
    const t = fly("turkey"), p = fly("pegasus");
    expect(t.y).toBeLessThan(p.y);
    expect(t.z).toBeLessThan(p.z);
  });
});
