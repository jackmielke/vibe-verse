/**
 * House Rules, the half that needs no renderer.
 *
 * The interesting questions about this game ("does a slide into a springboard
 * count as two?", "can night one be afforded?", "does anybody walk round the
 * outside of the house?") are all answerable from pure functions, so they are
 * answered here. Whole raids are `tools/homealone-play.mjs`.
 */
import { describe, expect, it } from "vitest";
import {
  CHAIN_WINDOW,
  KIT,
  KIT_ORDER,
  MIN_SPACING,
  chainMult,
  kitForNight,
  linkScore,
  placeProblem,
  resolveTrap,
  resolveTrick,
  scoreNight,
  type Placed,
} from "@/homealone/kit";
import { INTRUDERS, LOOT, NIGHT_COUNT, castOf, newKitOn, nightDef } from "@/homealone/nights";
import { NAV, pathBetween, pathLength } from "@/homealone/house";
import { LEVELS, ROAM, levelByNumber } from "@/homealone/levels";
import { entryNode } from "@/homealone/ai";

const victim = { hx: 0, hz: -1, heavy: false, rooted: false, chain: 0 };
const laid = (kind: Placed["kind"], x: number, z: number): Placed => ({
  id: 1, kind, x, y: 0, z, yaw: 0, usesLeft: 1, cool: 0, firing: 0,
});

describe("the kit", () => {
  it("lists every trap once, and night three has all of them", () => {
    expect(new Set(KIT_ORDER).size).toBe(Object.keys(KIT).length);
    expect(kitForNight(1).length).toBeGreaterThanOrEqual(3);
    expect(kitForNight(3)).toEqual(KIT_ORDER);
  });

  it("refuses a trap you cannot afford or that crowds another", () => {
    expect(placeProblem("spring", { x: 0, y: 0, z: 0 }, [], KIT.spring.cost - 1)).toBe("parts");
    expect(placeProblem("marbles", { x: 0, y: 0, z: 0 }, [laid("glue", MIN_SPACING * 0.5, 0)], 99)).toBe("crowded");
    expect(placeProblem("marbles", { x: 0, y: 0, z: 0 }, [laid("glue", MIN_SPACING * 2, 0)], 99)).toBeNull();
  });

  it("slides somebody the way he was walking", () => {
    const out = resolveTrap(KIT.marbles, 0, victim);
    expect([out.tx, out.tz]).toEqual([0, -1]);
    expect(out.dist).toBeCloseTo(KIT.marbles.throw);
    expect(out.mode).toBe("slide");
    expect(out.chain).toBe(1);
  });

  it("launches somebody the way the springboard was aimed, not the way he was going", () => {
    const out = resolveTrap(KIT.spring, Math.PI / 2, victim);
    expect(out.tx).toBeCloseTo(1);
    expect(out.tz).toBeCloseTo(0);
    expect(out.mode).toBe("fly");
  });

  it("throws a heavy man half as far", () => {
    const light = resolveTrap(KIT.slick, 0, victim);
    const heavy = resolveTrap(KIT.slick, 0, { ...victim, heavy: true });
    expect(heavy.dist).toBeCloseTo(light.dist / 2);
  });

  it("hits harder for every link, and for somebody stuck in glue", () => {
    const first = resolveTrap(KIT.marbles, 0, victim);
    const third = resolveTrap(KIT.marbles, 0, { ...victim, chain: 2 });
    const stuck = resolveTrap(KIT.marbles, 0, { ...victim, rooted: true });
    expect(third.chain).toBe(3);
    expect(third.damage).toBeGreaterThan(first.damage);
    expect(stuck.damage).toBeGreaterThan(first.damage);
    expect(stuck.tricks).toContain("STUCK SHOT");
  });

  it("glue roots and flour blinds, and neither throws anybody", () => {
    const glue = resolveTrap(KIT.glue, 0, victim);
    const flour = resolveTrap(KIT.flour, 0, victim);
    expect(glue.root).toBeGreaterThan(0);
    expect(glue.dist).toBe(0);
    expect(flour.blind).toBeGreaterThan(0);
    expect(flour.dist).toBe(0);
  });

  it("caps the multiplier and the score of a runaway chain", () => {
    expect(chainMult(1)).toBe(1);
    expect(chainMult(50)).toBe(2.5);
    expect(linkScore(20, 0)).toBe(linkScore(6, 0));
    expect(linkScore(3, 0)).toBeGreaterThan(linkScore(2, 0));
    expect(resolveTrick("WALL SLAM", 1).chain).toBe(2);
    expect(CHAIN_WINDOW).toBeGreaterThan(KIT.marbles.stun);
  });
});

describe("the scorecard", () => {
  const base = { lootKept: 6, lootTotal: 6, points: 500, bestChain: 3, routed: 2, intruders: 2, heartsLeft: 3, partsLeft: 1 };
  it("gives three stars for keeping everything and landing a chain", () => {
    expect(scoreNight(base).stars).toBe(3);
  });
  it("takes a star for anything that left, and another for no chain", () => {
    expect(scoreNight({ ...base, lootKept: 4 }).stars).toBe(2);
    expect(scoreNight({ ...base, lootKept: 4, bestChain: 2 }).stars).toBe(1);
  });
  it("is a loss with no hearts or nothing left", () => {
    expect(scoreNight({ ...base, heartsLeft: 0 }).won).toBe(false);
    expect(scoreNight({ ...base, lootKept: 0 }).won).toBe(false);
  });
});

describe("the nights", () => {
  it("only sends people who exist, through doors that exist, in order", () => {
    for (let n = 1; n <= NIGHT_COUNT + 6; n++) {
      const def = nightDef(n);
      expect(def.arrivals.length).toBeGreaterThan(0);
      for (const a of def.arrivals) {
        expect(INTRUDERS[a.who], `${a.who} on night ${n}`).toBeDefined();
        expect(["front", "back"]).toContain(a.entry);
      }
      expect(castOf(def).length).toBeGreaterThan(0);
    }
  });

  it("gets harder: more people and more parts, never fewer", () => {
    for (let n = 2; n <= NIGHT_COUNT + 6; n++) {
      expect(nightDef(n).arrivals.length).toBeGreaterThanOrEqual(nightDef(n - 1).arrivals.length);
      expect(nightDef(n).parts).toBeGreaterThanOrEqual(nightDef(n - 1).parts);
    }
  });

  it("can afford at least four traps on night one", () => {
    const cheapest = Math.min(...kitForNight(1).map((k) => KIT[k].cost));
    expect(nightDef(1).parts / cheapest).toBeGreaterThanOrEqual(4);
  });

  it("introduces every trap on a night whose brief can announce it", () => {
    const announced = new Set<string>(kitForNight(1));
    for (let n = 2; n <= NIGHT_COUNT; n++) for (const k of newKitOn(n, KIT)) announced.add(k);
    expect([...announced].sort()).toEqual([...KIT_ORDER].sort());
  });

  it("has levels for every written night, and the sandbox", () => {
    expect(LEVELS.filter((l) => l.kind === "night").length).toBe(NIGHT_COUNT);
    expect(levelByNumber(ROAM).kind).toBe("roam");
    expect(levelByNumber(NIGHT_COUNT + 3).night?.arrivals.length).toBeGreaterThan(0);
  });
});

describe("the routes", () => {
  it("puts every valuable on a real node, reachable from both doors", () => {
    const ids = new Set(NAV.map((n) => n.id));
    for (const l of LOOT) {
      expect(ids.has(l.node), l.id).toBe(true);
      for (const door of ["front", "back"] as const) {
        const path = pathBetween(entryNode(door), l.node);
        expect(path[path.length - 1].id, `${door} to ${l.id}`).toBe(l.node);
      }
    }
  });

  it("goes through the house, not round the outside of it", () => {
    // The silver is in the dining room. From the front door that is a walk
    // down the hall, and by hop count it used to be a lap of the garden.
    const silver = LOOT.find((l) => l.id === "silver")!;
    const path = pathBetween(entryNode("front"), silver.node);
    expect(pathLength(path)).toBeLessThan(22);
  });
});
