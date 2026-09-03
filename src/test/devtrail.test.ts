/**
 * Developer Trail is a state machine, so it can be played a thousand times
 * here. What is checked is not who wins but that every run *ends*, that the
 * deck is honest, and that the endings people will read are reachable.
 */
import { describe, expect, it } from "vitest";
import {
  CARDS,
  MONTHS,
  PHASES,
  TOWNS,
  TYPES,
  newGame,
  overallProgress,
  step,
  type Pace,
} from "@/devtrail/game";

const PACES: Pace[] = ["careful", "steady", "push"];

describe("the deck", () => {
  it("has unique ids and only names phases and towns that exist", () => {
    const ids = CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CARDS) {
      for (const p of c.phases ?? []) expect(PHASES).toContain(p);
      for (const t of c.towns ?? []) expect(TOWNS).toContain(t);
      expect(c.weight).toBeGreaterThan(0);
    }
  });

  it("carries the cavern under lot four", () => {
    const cavern = CARDS.find((c) => c.id === "cavern");
    expect(cavern?.cash).toBe(-55000);
    expect(cavern?.phases).toEqual(["Build"]);
  });
});

describe("a run", () => {
  it("always ends, for every type, town and pace, within the option", () => {
    for (const type of TYPES) {
      for (const town of TOWNS) {
        for (const pace of PACES) {
          for (let seed = 1; seed <= 12; seed++) {
            let s = newGame(type, town, seed);
            let guard = 0;
            while (!s.over && guard++ < 200) s = step(s, pace);
            expect(s.over, `${type} ${town} ${pace} #${seed}`).not.toBeNull();
            expect(s.month).toBeLessThanOrEqual(MONTHS + 3);
          }
        }
      }
    }
  });

  it("is deterministic for a seed", () => {
    let a = newGame("Emerging", "Bend", 99);
    let b = newGame("Emerging", "Bend", 99);
    for (let i = 0; i < 20; i++) {
      a = step(a, "steady");
      b = step(b, "steady");
    }
    expect(a.cash).toBe(b.cash);
    expect(a.log.map((l) => l.text)).toEqual(b.log.map((l) => l.text));
  });

  it("can be won", () => {
    // A mature developer in the cheapest town, working steadily, should
    // sell out in some seeds. If nobody ever wins, the tuning is wrong.
    let wins = 0;
    for (let seed = 1; seed <= 60; seed++) {
      let s = newGame("Mature", "Port Orchard", seed);
      let guard = 0;
      while (!s.over && guard++ < 200) s = step(s, s.energy < 35 ? "careful" : "steady");
      if (s.over?.won) wins++;
    }
    expect(wins).toBeGreaterThan(5);
  });

  it("can be lost by pushing an aspiring developer flat out", () => {
    let losses = 0;
    for (let seed = 1; seed <= 30; seed++) {
      let s = newGame("Aspiring", "Healdsburg", seed);
      let guard = 0;
      while (!s.over && guard++ < 200) s = step(s, "push");
      if (!s.over?.won) losses++;
    }
    expect(losses).toBeGreaterThan(20);
  });

  it("reports progress between 0 and 1 and never goes backwards past a phase", () => {
    let s = newGame("Developing", "Bainbridge Island", 7);
    let lastPhase = 0;
    while (!s.over) {
      s = step(s, "steady");
      const p = overallProgress(s);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      expect(s.phase).toBeGreaterThanOrEqual(lastPhase);
      lastPhase = s.phase;
    }
  });

  it("does nothing after the end", () => {
    let s = newGame("Aspiring", "Healdsburg", 3);
    while (!s.over) s = step(s, "push");
    const after = step(s, "push");
    expect(after).toBe(s);
  });
});
