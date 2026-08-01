/**
 * The passport is the one thing in this repo that spans every world, which
 * makes it the one thing whose breakage is hardest to notice: a stamp that
 * silently stops being written looks exactly like a world you have not visited
 * yet. These run in jsdom in about a second, unlike the browser harness.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  readPassport, stampPassport, passportRows, passportProgress, PASSPORT_WORLDS,
} from "@/lib/passport";

const KEY = "vibe.passport";

describe("passport", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.useRealTimers());

  it("starts empty and reports zero progress", () => {
    expect(readPassport().stamps).toEqual({});
    const p = passportProgress();
    expect(p.visited).toBe(0);
    expect(p.trips).toBe(0);
    expect(p.total).toBe(PASSPORT_WORLDS.length);
  });

  it("records an arrival", () => {
    stampPassport("/golf", "Vibe Golf");
    const s = readPassport().stamps["/golf"];
    expect(s.count).toBe(1);
    expect(s.name).toBe("Vibe Golf");
    expect(s.first).toBe(s.last);
    expect(passportProgress().visited).toBe(1);
  });

  /* The reason this rule exists: React strict mode double-mounts effects in
     development, and a page that remounts on resize would otherwise inflate the
     count. Two arrivals inside a minute are one arrival. */
  it("coalesces repeat arrivals inside a minute", () => {
    stampPassport("/golf", "Vibe Golf");
    stampPassport("/golf", "Vibe Golf");
    stampPassport("/golf", "Vibe Golf");
    expect(readPassport().stamps["/golf"].count).toBe(1);
  });

  it("counts a genuine return after the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    stampPassport("/golf", "Vibe Golf");
    vi.setSystemTime(new Date("2026-01-01T00:05:00Z"));
    stampPassport("/golf", "Vibe Golf");
    const s = readPassport().stamps["/golf"];
    expect(s.count).toBe(2);
    expect(s.last).toBeGreaterThan(s.first);
  });

  it("keeps worlds independent", () => {
    stampPassport("/golf", "Vibe Golf");
    stampPassport("/seafair", "Seafair 2117");
    const p = passportProgress();
    expect(p.visited).toBe(2);
    expect(p.trips).toBe(2);
  });

  it("lists every world, visited or not, in a stable order", () => {
    stampPassport("/edm-town", "EDM Town");
    const rows = passportRows();
    expect(rows).toHaveLength(PASSPORT_WORLDS.length);
    expect(rows.map((r) => r.route)).toEqual(PASSPORT_WORLDS.map((w) => w.route));
    expect(rows.find((r) => r.route === "/edm-town")!.visited).toBe(true);
    expect(rows.find((r) => r.route === "/golf")!.visited).toBe(false);
  });

  /* A stamp is never worth breaking a world over, so every failure mode here
     has to degrade to "no stamps" rather than to an exception. */
  it("survives corrupt storage", () => {
    localStorage.setItem(KEY, "{not json");
    expect(readPassport().stamps).toEqual({});
    localStorage.setItem(KEY, JSON.stringify({ version: 1 }));      // no stamps key
    expect(readPassport().stamps).toEqual({});
    localStorage.setItem(KEY, JSON.stringify(["wrong", "shape"]));
    expect(readPassport().stamps).toEqual({});
    expect(() => stampPassport("/golf", "Vibe Golf")).not.toThrow();
  });

  it("does not throw when storage refuses writes", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => stampPassport("/golf", "Vibe Golf")).not.toThrow();
    spy.mockRestore();
  });

  it("ignores an empty route rather than storing a blank stamp", () => {
    stampPassport("", "Nowhere");
    expect(Object.keys(readPassport().stamps)).toHaveLength(0);
  });

  it("keeps the curated name over whatever a caller passes", () => {
    stampPassport("/golf", "some other label");
    const row = passportRows().find((r) => r.route === "/golf")!;
    expect(row.name).toBe("Vibe Golf");
  });

  it("fits on the panel that draws it", () => {
    /* Cockpit.drawArchivePassport lays the rows out in two columns on a
       768 x 486 screen and has to cap them somewhere. It capped at ten, and
       adding an eleventh world made the grid quietly stop drawing the last row
       while the counter above it went on saying "/ 11" — the missing world
       being, of course, the new one. The cap is twelve; this is the other half
       of that pair, and it fails the moment a thirteenth is added rather than
       after somebody notices a world is missing from their own passport. */
    expect(PASSPORT_WORLDS.length).toBeLessThanOrEqual(12);
  });

  it("gives every world a distinct route", () => {
    const routes = PASSPORT_WORLDS.map((w) => w.route);
    expect(new Set(routes).size).toBe(routes.length);
    for (const r of routes) expect(r).toMatch(/^\//);
  });
});
