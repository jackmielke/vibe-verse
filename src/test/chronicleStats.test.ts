/**
 * The statistics the Chronicle claims, tested against input we control.
 *
 * "The busiest day" and "the longest silence" are the two lines on that page a
 * reader will quote, and both are the kind of number that is wrong quietly:
 * an off-by-one at a boundary produces a date that is a day out, which nobody
 * can tell by looking. So they are pure functions taking the day map, and this
 * checks the edges rather than the happy path.
 */
import { describe, expect, it } from "vitest";

import {
  activity,
  bornOn,
  busiestDay,
  dayKey,
  heat,
  longestSilence,
  spanDays,
} from "@/worlds/chronicleStats";
import { COMMIT_DAYS, REPO_LIFE, WORLD_LIFE } from "@/worlds/chronicle";

const T = (d: string) => Date.parse(`${d}T12:00:00Z`);

describe("spanDays", () => {
  it("includes both ends", () => {
    expect(spanDays("2026-04-14T01:00:00+00:00", T("2026-04-17"))).toEqual([
      "2026-04-14",
      "2026-04-15",
      "2026-04-16",
      "2026-04-17",
    ]);
  });

  it("is one day for a project born today", () => {
    expect(spanDays("2026-04-14T23:59:00+00:00", T("2026-04-14"))).toEqual(["2026-04-14"]);
  });

  it("crosses a month and a leap day without drifting", () => {
    const span = spanDays("2028-02-27T00:00:00+00:00", T("2028-03-02"));
    expect(span).toEqual(["2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01", "2028-03-02"]);
  });
});

describe("busiestDay", () => {
  it("finds the peak", () => {
    expect(busiestDay({ "2026-05-01": 3, "2026-05-02": 40, "2026-05-03": 12 })).toEqual({
      day: "2026-05-02",
      commits: 40,
    });
  });

  it("breaks a tie to the earliest — the day it first happened", () => {
    expect(busiestDay({ "2026-05-09": 20, "2026-05-02": 20 })).toEqual({
      day: "2026-05-02",
      commits: 20,
    });
  });

  it("is null for a history with no commits", () => {
    expect(busiestDay({})).toBeNull();
  });
});

describe("longestSilence", () => {
  it("finds a gap between two working days", () => {
    const days = { "2026-05-01": 2, "2026-05-06": 5 };
    expect(longestSilence(days, "2026-05-01T00:00:00+00:00", T("2026-05-06"))).toEqual({
      from: "2026-05-02",
      to: "2026-05-05",
      days: 4,
    });
  });

  it("counts a silence that is still going", () => {
    /* The longest quiet stretch is very often the one you are in, and a
       function that only looked between commits would be the one thing unable
       to see it. */
    const days = { "2026-05-01": 2, "2026-05-03": 1 };
    expect(longestSilence(days, "2026-05-01T00:00:00+00:00", T("2026-05-09"))).toEqual({
      from: "2026-05-04",
      to: "2026-05-09",
      days: 6,
    });
  });

  it("is null when every day was worked", () => {
    const days = { "2026-05-01": 1, "2026-05-02": 1, "2026-05-03": 1 };
    expect(longestSilence(days, "2026-05-01T00:00:00+00:00", T("2026-05-03"))).toBeNull();
  });

  it("keeps the first of two equal silences", () => {
    const days = { "2026-05-01": 1, "2026-05-04": 1, "2026-05-07": 1 };
    const s = longestSilence(days, "2026-05-01T00:00:00+00:00", T("2026-05-07"))!;
    expect(s.days).toBe(2);
    expect(s.from).toBe("2026-05-02");
  });
});

describe("heat", () => {
  it("gives silence its own bucket", () => {
    expect(heat(0)).toBe(0);
    expect(heat(1)).toBe(1);
  });

  it("separates an ordinary day from a heroic one", () => {
    /* One real day has 196 commits and a normal one has about ten. A linear
       scale renders every ordinary day as the same near-black. */
    expect(heat(10)).toBeLessThan(heat(196));
    expect(heat(10)).toBeGreaterThan(heat(2));
  });

  it("never leaves the five buckets", () => {
    for (const n of [0, 1, 3, 4, 12, 13, 40, 41, 196, 100000]) {
      expect(heat(n)).toBeGreaterThanOrEqual(0);
      expect(heat(n)).toBeLessThanOrEqual(4);
    }
  });
});

describe("against the real history", () => {
  const now = Date.now();

  it("has a busiest day that is inside the project's life", () => {
    const b = busiestDay(COMMIT_DAYS)!;
    expect(b.commits).toBeGreaterThan(0);
    expect(b.day >= REPO_LIFE.born.slice(0, 10)).toBe(true);
    expect(b.day <= dayKey(now)).toBe(true);
  });

  it("never reports more active days than days", () => {
    const a = activity(COMMIT_DAYS, REPO_LIFE.born, now);
    expect(a.activeDays).toBeLessThanOrEqual(a.totalDays);
    expect(a.sharePct).toBeGreaterThan(0);
    expect(a.sharePct).toBeLessThanOrEqual(100);
  });

  it("agrees with the world birthdays it sits beside", () => {
    /* Every world was born on a day somebody committed. If this fails the two
       generated halves were produced from different histories — which is
       exactly what a shallow clone does to one and not the other. */
    for (const [key, life] of Object.entries(WORLD_LIFE)) {
      const day = life.born.slice(0, 10);
      expect(COMMIT_DAYS[day], `${key} born on ${day}, a day with no commits`).toBeGreaterThan(0);
    }
  });

  it("finds the worlds born on the busiest day", () => {
    const b = busiestDay(COMMIT_DAYS)!;
    expect(Array.isArray(bornOn(WORLD_LIFE, b.day))).toBe(true);
  });
});
