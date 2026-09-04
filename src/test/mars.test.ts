/**
 * Mars College is a state machine, so ten weeks can be lived a few hundred
 * times here. What is checked: every run reaches the teardown, a seed is a
 * whole run, the desert is survivable if you show up for it and sad if you
 * do not, and the storms come between two and six times.
 */
import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  DAYS,
  DAY_CARDS,
  PARTS,
  VERDICT,
  act,
  advance,
  costOf,
  newColony,
  planStorms,
  verdict,
  weekOf,
  type Action,
  type ColonyState,
} from "@/mars/colony";
import { PLACES, POOP_HEIGHT, SPAWN, groundHeight, nearestPlace, placeById, promptFor } from "@/mars/places";

const MAX_STEPS = DAYS * PARTS.length + 10;

function runUntilOver(s: ColonyState, choose: (s: ColonyState) => Action, limit = MAX_STEPS): ColonyState {
  let guard = 0;
  while (!s.over && guard++ < limit) s = act(s, choose(s));
  return s;
}

/** Somebody who shows up: builds in the morning, sees people in the afternoon, cooks at night. */
function goodChoice(s: ColonyState): Action {
  if (s.part === "morning") {
    if (s.water < 70) return "water";
    if (!s.pullupBar && s.day <= 7) return "pullup";
    if (s.shelter < 100) return s.parts < 1 ? "parts" : s.power >= 15 ? "build" : "parts";
    return s.power >= 10 ? "research" : "parts";
  }
  if (s.part === "afternoon") {
    const social: Action[] = ["hug", "run", "freeside", "nature", "run", "sunflower", "hug"];
    const pick = social[s.day % social.length];
    if (pick === "run" && s.water < 15) return "hug";
    return pick;
  }
  return "dinner";
}

describe("the storms", () => {
  it("come between two and six times a run, across 200 seeds, never in the first three days", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const days = planStorms(seed);
      expect(days.length, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      expect(days.length, `seed ${seed}`).toBeLessThanOrEqual(6);
      for (const d of days) {
        expect(d).toBeGreaterThanOrEqual(4);
        expect(d).toBeLessThanOrEqual(DAYS - 7);
      }
      for (let i = 1; i < days.length; i++) expect(days[i] - days[i - 1]).toBeGreaterThanOrEqual(4);
    }
  });

  it("are counted as survived when they happen, and zero the solar", () => {
    for (let seed = 1; seed <= 40; seed++) {
      let s = newColony(seed);
      let sawStorm = false;
      let guard = 0;
      while (!s.over && guard++ < MAX_STEPS) {
        s = advance(s);
        if (s.storm) {
          sawStorm = true;
          expect(s.power).toBe(0);
        }
      }
      expect(sawStorm).toBe(true);
      expect(s.stats.storms).toBe(s.stormDays.length);
    }
  });
});

describe("a run", () => {
  it("is deterministic for a seed", () => {
    let a = newColony(42);
    let b = newColony(42);
    for (let i = 0; i < 60; i++) {
      const choice = ACTIONS[i % ACTIONS.length];
      a = act(a, choice);
      b = act(b, choice);
    }
    expect(a).toEqual(b);
  });

  it("always reaches week ten, whatever you do, within the option", () => {
    for (let seed = 1; seed <= 60; seed++) {
      let i = 0;
      const s = runUntilOver(newColony(seed), () => ACTIONS[(i++ * 5 + seed) % ACTIONS.length], MAX_STEPS * 4);
      expect(s.over, `seed ${seed}`).toBe(true);
      expect(s.day).toBe(DAYS);
      expect(weekOf(s.day)).toBe(10);
    }
  });

  it("does not kill a player who only sleeps; it just ends sadder", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const s = runUntilOver(newColony(seed), () => "sleep");
      expect(s.over).toBe(true);
      expect(s.water).toBe(0);
      expect(s.shelter).toBe(0);
      expect(s.connection).toBeLessThan(20);
      expect(s.purpose).toBeLessThan(20);
      const avg = (s.water + s.power + s.shelter + s.connection + s.purpose) / 5;
      expect(avg, `seed ${seed}`).toBeLessThan(35);
      expect(verdict(s).line).toBe(VERDICT);
    }
  });

  it("ends with every meter above half for somebody who shows up", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const s = runUntilOver(newColony(seed), goodChoice);
      expect(s.over).toBe(true);
      for (const k of ["water", "power", "shelter", "connection", "purpose"] as const) {
        expect(s[k], `seed ${seed} ${k}`).toBeGreaterThan(50);
      }
      expect(s.stats.dinners).toBeGreaterThan(40);
      expect(s.stats.waterRuns).toBeGreaterThan(3);
      expect(s.stats.hugs).toBeGreaterThan(5);
      expect(s.longRunDone).toBe(true);
      expect(verdict(s).grade).toBe("Crazy desert era, fully lived.");
    }
  });

  it("raises the four voice-note cards in order: day one, week five, raw reflections, last day", () => {
    let s = newColony(3);
    const seen: string[] = [s.card!.id];
    let guard = 0;
    while (!s.over && guard++ < MAX_STEPS) {
      s = act(s, "sleep");
      if (s.card) seen.push(s.card.id);
    }
    expect(seen).toEqual(DAY_CARDS.map((c) => c.id));
    expect(DAY_CARDS[3].lines.at(-1)).toBe(VERDICT);
  });

  it("opens on the chapstick and the pull-up bar", () => {
    const s = newColony(1);
    expect(s.lines.join(" ")).toContain("chapstick");
    expect(s.lines.join(" ")).toContain("pull-up bar");
    expect(s.card?.id).toBe("day1");
  });
});

describe("actions", () => {
  it("cost what they say: a water run is half a day, the mountain is free", () => {
    expect(costOf("water")).toBe(2);
    expect(costOf("poop")).toBe(0);
    let s = newColony(5);
    s = act(s, "water");
    expect(s.part).toBe("night");
    expect(s.water).toBeGreaterThan(90);
    expect(s.stats.waterRuns).toBe(1);
    const before = s.part;
    s = act(s, "poop");
    expect(s.part).toBe(before);
    expect(s.poopToday).toBe(true);
  });

  it("refuses dinner before dark and does not charge for it", () => {
    let s = newColony(5);
    s = act(s, "dinner");
    expect(s.part).toBe("morning");
    expect(s.stats.dinners).toBe(0);
    s = act(s, "sleep");
    s = act(s, "sleep");
    s = act(s, "dinner");
    expect(s.stats.dinners).toBe(1);
    expect(s.day).toBe(2);
  });

  it("needs parts and power to build, and a finished shelter halves the cold", () => {
    let s = newColony(9);
    s = { ...s, parts: 0 };
    const stuck = act(s, "build");
    expect(stuck.part).toBe("morning");
    expect(stuck.lines[0]).toContain("Tool Camp");
    s = { ...s, parts: 6, power: 100, rng: 12345 };
    let guard = 0;
    while (s.shelter < 100 && guard++ < 20) s = act({ ...s, power: 100 }, "build");
    expect(s.shelter).toBe(100);
    expect(s.stats.builds).toBeGreaterThanOrEqual(5);
  });

  it("meets the Mars Brain once, in its own words", () => {
    let s = newColony(2);
    s = act(s, "research");
    expect(s.lines[0]).toBe("Hey! I'm the Mars Brain, the collective consciousness of Mars College.");
    expect(s.metBrain).toBe(true);
    s = act(s, "research");
    expect(s.lines[0]).not.toContain("Mars Brain, the collective");
  });

  it("makes the third run the 25 kilometre one", () => {
    let s = newColony(4);
    s = { ...s, water: 100 };
    s = act(s, "run");
    s = act({ ...s, water: 100 }, "run");
    expect(s.longRunDone).toBe(false);
    s = act({ ...s, water: 100 }, "run");
    expect(s.longRunDone).toBe(true);
    expect(s.lines[0]).toContain("25 kilometres");
  });

  it("can find a scorpion under the plywood, and it costs the day", () => {
    let found: ColonyState | null = null;
    for (let seed = 1; seed <= 400 && !found; seed++) {
      let s = { ...newColony(seed), parts: 30 };
      for (let i = 0; i < 12 && !s.over; i++) {
        s = act({ ...s, power: 100 }, "build");
        if (s.stats.scorpions > 0) {
          found = s;
          break;
        }
      }
    }
    expect(found).not.toBeNull();
    expect(found!.part).toBe("morning");
    expect(found!.lines.join(" ")).toContain("scorpion");
  });
});

describe("the map", () => {
  it("has every camp, the table in the middle, and Bombay Beach a long way west", () => {
    const table = placeById("table");
    expect(table.x).toBe(0);
    expect(table.z).toBe(0);
    for (const id of ["research", "freeside", "bodywork", "tools", "nature"] as const) {
      const p = placeById(id);
      expect(Math.hypot(p.x, p.z)).toBeGreaterThan(50);
      expect(Math.hypot(p.x, p.z)).toBeLessThan(120);
    }
    expect(placeById("sunflower").x).toBeLessThan(-400);
    expect(placeById("water").x).toBeLessThan(-400);
    const ids = PLACES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("finds the place under the wheel and nothing in the open", () => {
    expect(nearestPlace(0, 1)?.id).toBe("table");
    expect(nearestPlace(74, -36)?.id).toBe("research");
    expect(nearestPlace(SPAWN.x, SPAWN.z)).toBeNull();
    expect(nearestPlace(300, 300)).toBeNull();
  });

  it("offers the pull-up bar at home in week one and the build after", () => {
    const home = placeById("home");
    const s = newColony(1);
    expect(promptFor(s, home).action).toBe("pullup");
    expect(promptFor({ ...s, pullupBar: true }, home).action).toBe("build");
    expect(promptFor({ ...s, day: 12 }, home).action).toBe("build");
    expect(promptFor(s, placeById("water")).action).toBe("water");
    expect(promptFor(s, placeById("table")).action).toBe("dinner");
  });

  it("puts Poop Mountain above the plain and keeps the camps on it", () => {
    const poop = placeById("poop");
    expect(groundHeight(poop.x, poop.z)).toBeGreaterThan(POOP_HEIGHT - 1);
    for (const p of PLACES) {
      if (p.id === "poop") continue;
      expect(Math.abs(groundHeight(p.x, p.z)), p.id).toBeLessThan(2.5);
    }
  });
});
