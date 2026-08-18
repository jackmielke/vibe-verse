/**
 * The newsroom's clock and its streak.
 *
 * Both are small sums that are easy to get subtly wrong and hard to catch by
 * looking: a countdown that says "in 23 hours" during the hour the paper is
 * actually being written, or a streak that quietly resets every morning
 * because today's edition does not exist at six o'clock. Neither would look
 * broken on screen, which is exactly why they are pinned here.
 *
 * The schedule under test is the real one: pg_cron fires hourly from 13:00
 * to 20:00 UTC and the first run that finds the day unwritten writes it.
 */
import { describe, it, expect } from "vitest";
import { streak, nextRun, describeGap, describeAge, utcDay } from "@/newsroom/press";

const at = (iso: string) => new Date(iso);

describe("streak", () => {
  it("counts back from the most recent edition, not from today", () => {
    // 06:00 UTC: today's paper is hours away, and a run of four mornings is
    // still a run of four mornings.
    const dates = ["2026-08-16", "2026-08-15", "2026-08-14", "2026-08-13"];
    expect(streak(dates, at("2026-08-17T06:00:00Z"))).toBe(4);
  });

  it("includes today once the paper is out", () => {
    const dates = ["2026-08-17", "2026-08-16", "2026-08-15"];
    expect(streak(dates, at("2026-08-17T14:00:00Z"))).toBe(3);
  });

  it("stops at the first missed morning", () => {
    const dates = ["2026-08-17", "2026-08-16", "2026-08-14", "2026-08-13"];
    expect(streak(dates, at("2026-08-17T14:00:00Z"))).toBe(2);
  });

  it("is zero when the run is properly broken", () => {
    // Nothing yesterday and nothing today: whatever came before does not
    // count as unbroken.
    expect(streak(["2026-08-10", "2026-08-09"], at("2026-08-17T14:00:00Z"))).toBe(0);
  });

  it("survives an empty archive", () => {
    expect(streak([], at("2026-08-17T14:00:00Z"))).toBe(0);
  });

  it("does not double-count two editions dated the same day", () => {
    expect(streak(["2026-08-17", "2026-08-17", "2026-08-16"], at("2026-08-17T14:00:00Z"))).toBe(2);
  });
});

describe("nextRun", () => {
  it("points at the top of the hour while the window is open and the day is unwritten", () => {
    const state = nextRun(at("2026-08-17T14:20:00Z"), false);
    expect(state.imminent).toBe(true);
    expect(state.due.toISOString()).toBe("2026-08-17T15:00:00.000Z");
    expect(state.eta).toBe("in 40 minutes");
  });

  it("points at tomorrow morning once today's edition is out", () => {
    const state = nextRun(at("2026-08-17T14:20:00Z"), true);
    expect(state.imminent).toBe(false);
    expect(state.due.toISOString()).toBe("2026-08-18T13:00:00.000Z");
  });

  it("points at this morning's run before the window opens", () => {
    const state = nextRun(at("2026-08-17T06:00:00Z"), false);
    expect(state.imminent).toBe(false);
    expect(state.due.toISOString()).toBe("2026-08-17T13:00:00.000Z");
    expect(state.eta).toBe("in 7 hours");
  });

  it("points at tomorrow after the window has closed unwritten", () => {
    // 21:00 is past the last run. Nothing more will be tried today, and
    // saying "any minute now" all evening would be a lie.
    const state = nextRun(at("2026-08-17T21:00:00Z"), false);
    expect(state.imminent).toBe(false);
    expect(state.due.toISOString()).toBe("2026-08-18T13:00:00.000Z");
  });
});

describe("plain english", () => {
  it("describes gaps the way a person would", () => {
    expect(describeGap(30_000)).toBe("any minute now");
    expect(describeGap(60_000)).toBe("any minute now");
    expect(describeGap(12 * 60_000)).toBe("in 12 minutes");
    expect(describeGap(60 * 60_000)).toBe("in 1 hour");
    expect(describeGap(5 * 3600_000)).toBe("in 5 hours");
    expect(describeGap(50 * 3600_000)).toBe("in 2 days");
  });

  it("describes ages the same way, backwards", () => {
    const now = at("2026-08-17T12:00:00Z");
    expect(describeAge("2026-08-17T11:59:30Z", now)).toBe("just now");
    expect(describeAge("2026-08-17T11:30:00Z", now)).toBe("30 minutes ago");
    expect(describeAge("2026-08-17T09:00:00Z", now)).toBe("3 hours ago");
    expect(describeAge("2026-08-16T12:00:00Z", now)).toBe("yesterday");
    expect(describeAge("2026-08-14T12:00:00Z", now)).toBe("3 days ago");
  });

  it("says something rather than NaN when a timestamp is missing or junk", () => {
    const now = at("2026-08-17T12:00:00Z");
    expect(describeAge(undefined, now)).toBe("some time ago");
    expect(describeAge("not a date", now)).toBe("some time ago");
  });

  it("dates an edition by its UTC day", () => {
    expect(utcDay(at("2026-08-17T23:30:00Z"))).toBe("2026-08-17");
    expect(utcDay("2026-08-17T00:30:00Z")).toBe("2026-08-17");
  });
});
