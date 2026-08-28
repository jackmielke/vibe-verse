/**
 * The clock.
 *
 * Small, but it drives the sky, nine thousand window lights, the street lamps,
 * headlights, the ambience mix and who is on the pavement — so the two things
 * that could break it quietly are worth pinning: it must wrap at midnight
 * rather than running off to hour 25, and it must never come back NaN, which
 * would take every one of those systems with it.
 */
import { describe, expect, it } from "vitest";
import { CLOCK_RATE, DAY_MINUTES, advanceClock, sanFranciscoHour } from "./config";

describe("the day", () => {
  it("takes DAY_MINUTES of real time to go round once", () => {
    let h = 0;
    // Step a whole day in one-second ticks.
    for (let i = 0; i < DAY_MINUTES * 60; i++) h = advanceClock(h, 1);
    // Back where it started, on a circle: accumulated floating point leaves it
    // a hair either side of midnight, and 23.9999 and 0.0001 are the same
    // instant. Comparing to zero directly is a test that fails for being right.
    const fromMidnight = Math.min(h, 24 - h);
    expect(fromMidnight).toBeLessThan(0.001);
  });

  it("wraps at midnight instead of running past it", () => {
    expect(advanceClock(23.999, 60)).toBeLessThan(1);
    expect(advanceClock(23.999, 60)).toBeGreaterThanOrEqual(0);
  });

  it("survives a hidden tab handing it an enormous delta", () => {
    // A backgrounded tab can return with minutes of wall clock in one frame.
    const h = advanceClock(12, 60 * 60 * 5);
    expect(Number.isFinite(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(24);
  });

  it("moves at all, in the direction of later", () => {
    expect(advanceClock(9, 120)).toBeGreaterThan(9);
    expect(CLOCK_RATE).toBeGreaterThan(0);
  });

  it("reads a real San Francisco hour, on both sides of daylight saving", () => {
    // Fixed instants: 2024-01-15 20:00 UTC is 12:00 PST; 2024-07-15 19:00 UTC
    // is 12:00 PDT. A fixed offset would get one of these wrong.
    expect(sanFranciscoHour(new Date("2024-01-15T20:00:00Z"))).toBeCloseTo(12, 5);
    expect(sanFranciscoHour(new Date("2024-07-15T19:00:00Z"))).toBeCloseTo(12, 5);
    // Midnight must be 0, not 24 — some engines format it as 24.
    expect(sanFranciscoHour(new Date("2024-01-15T08:00:00Z"))).toBeCloseTo(0, 5);
  });
});
