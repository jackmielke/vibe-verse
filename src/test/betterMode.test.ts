/**
 * BETTER FORTNITE's data, checked without a renderer.
 *
 * `mode/better.ts` is pure on purpose so that everything a designer can get
 * wrong in it — a duplicate id, an offer that hands you a perk you already
 * own, an event pointed at a circle that never comes — fails here, in a
 * millisecond, rather than forty minutes into a capture run.
 */
import { describe, it, expect } from "vitest";
import {
  AUGMENTS,
  ISLAND_EVENTS,
  OFFER_SCHEDULE,
  bonusOf,
  eventForCircle,
  factorOf,
  rollOffer,
} from "@/royale/mode/better";
import { modeForLocation } from "@/royale/mode/route";

/** Deterministic LCG so a failure replays. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("augments", () => {
  it("have unique ids and something to say", () => {
    const ids = new Set<string>();
    for (const a of AUGMENTS) {
      expect(ids.has(a.id), `duplicate id ${a.id}`).toBe(false);
      ids.add(a.id);
      expect(a.name.length).toBeGreaterThan(0);
      expect(a.blurb.length).toBeGreaterThan(0);
      expect(a.icon.length).toBeGreaterThan(0);
      // Every augment must DO something, or it is a card with nothing behind it.
      const does = Object.keys(a.factors ?? {}).length + Object.keys(a.bonuses ?? {}).length;
      expect(does, `${a.id} changes nothing`).toBeGreaterThan(0);
    }
  });

  it("are enough to fill every offer a match can make", () => {
    const most = OFFER_SCHEDULE.max + OFFER_SCHEDULE.elimMilestones.length;
    // After taking one per offer, the last offer still needs `cards` to choose from.
    expect(AUGMENTS.length).toBeGreaterThanOrEqual(most - 1 + OFFER_SCHEDULE.cards);
  });

  it("never offers what you own, and never the same card twice in a hand", () => {
    const rng = lcg(7);
    for (let trial = 0; trial < 200; trial++) {
      const owned = AUGMENTS.map((a) => a.id).filter(() => rng() < 0.4);
      const hand = rollOffer(owned, rng);
      expect(new Set(hand).size).toBe(hand.length);
      for (const id of hand) expect(owned.includes(id), `offered owned ${id}`).toBe(false);
      expect(hand.length).toBe(Math.min(OFFER_SCHEDULE.cards, AUGMENTS.length - owned.length));
    }
  });

  it("compose: factors multiply, bonuses add, nothing is 1 or 0", () => {
    expect(factorOf([], "reload")).toBe(1);
    expect(bonusOf([], "airJumps")).toBe(0);
    expect(factorOf(["quickhands"], "reload")).toBeCloseTo(0.6);
    expect(factorOf(["quickhands", "sprinter"], "reload")).toBeCloseTo(0.6);
    expect(factorOf(["sprinter"], "speed")).toBeCloseTo(1.15);
    expect(bonusOf(["spring", "bulwark"], "airJumps")).toBe(1);
    expect(bonusOf(["spring", "bulwark"], "maxShield")).toBe(50);
    expect(factorOf(["feather"], "fallDamage")).toBe(0);
    expect(factorOf(["stormwalker"], "stormDamage")).toBeCloseTo(0.35);
  });

  it("keeps the schedule inside a match", () => {
    // Circle one waits 100 s and closes over 90; the fourth offer has to land
    // before the match is realistically over at ~12 minutes.
    const last = OFFER_SCHEDULE.firstAt + OFFER_SCHEDULE.every * (OFFER_SCHEDULE.max - 1);
    expect(last).toBeLessThan(12 * 60);
    expect(OFFER_SCHEDULE.firstAt).toBeGreaterThan(30);
  });
});

describe("island events", () => {
  it("one per circle, each circle at most once, in the storm's range", () => {
    const circles = new Set<number>();
    for (const e of ISLAND_EVENTS) {
      expect(circles.has(e.circle), `two events on circle ${e.circle}`).toBe(false);
      circles.add(e.circle);
      expect(e.circle).toBeGreaterThanOrEqual(2);
      expect(e.circle).toBeLessThanOrEqual(7);
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.duration).toBeGreaterThanOrEqual(0);
    }
    // Circle one is the drop; nothing should fire on it.
    expect(eventForCircle(1)).toBeNull();
    expect(eventForCircle(2)?.id).toBe("supply-storm");
  });

  it("keeps sudden death last", () => {
    const sd = ISLAND_EVENTS.find((e) => e.id === "sudden-death");
    expect(sd).toBeTruthy();
    for (const e of ISLAND_EVENTS) if (e !== sd) expect(e.circle).toBeLessThan(sd!.circle);
  });
});

describe("the route decides the game", () => {
  it("boots better on its own paths and aliases, and nowhere else", () => {
    for (const p of ["/better-fortnite", "/better", "/bf", "/better-royale", "/better/", "/bf?room=X"]) {
      expect(modeForLocation(p.split("?")[0], p.includes("?") ? p.slice(p.indexOf("?")) : ""), p).toBe("better");
    }
    expect(modeForLocation("/drop-zero", "")).toBe("water");
    expect(modeForLocation("/drop-zero", "?mode=classic")).toBe("classic");
    expect(modeForLocation("/splash-royale", "?mode=classic")).toBe("classic");
    // A path that merely starts with the letters is not the game.
    expect(modeForLocation("/betterment", "")).toBe("water");
    expect(modeForLocation("/bfs", "")).toBe("water");
  });
});
