/**
 * The worlds on the chart, and the galaxy that has to survive them.
 *
 * Two separate things are pinned here.
 *
 * The first is the *contested* world — a world with no route, which is a shape
 * this codebase did not have until Redline. Four of the five worlds are doors:
 * land and the browser navigates. The fifth is not, and the flag that keeps the
 * handoff from firing on it is one falsy check deep inside Game._maybeHandOff.
 * A `route: ''` typo'd into `route: '/'` there would teleport a player out of a
 * firefight and into the hub's lobby.
 *
 * The second is the draw sequence. Every rnd() call in generate.js is a
 * position in one deterministic stream, so a world system that *skips* a draw
 * — rather than rolling it and throwing the result away — regenerates every
 * system after it, and the whole galaxy silently rearranges the day somebody
 * adds a sixth world. The names and seeds below were captured from the galaxy
 * as it stood with four worlds on the chart, and they still hold with five.
 * If adding a world changes them, the world was added wrongly.
 */
import { describe, it, expect } from "vitest";
import { VIBE_WORLDS, worldFor, stampRouteFor } from "@/longsilence/world/vibeworlds.js";
import { PASSPORT_WORLDS } from "@/lib/passport";
import { generateGalaxy, generateSystem } from "@/longsilence/world/generate.js";

describe("the chart", () => {
  it("gives every world a unique key, name and place", () => {
    const keys = VIBE_WORLDS.map((w) => w.key);
    const names = VIBE_WORLDS.map((w) => w.name);
    const spots = VIBE_WORLDS.map((w) => `${w.chart.x},${w.chart.y}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(spots).size).toBe(spots.length);
  });

  it("finds a world by key, and by route when it has one", () => {
    expect(worldFor("seafair")?.name).toBe("SEAFAIR");
    expect(worldFor("/seafair")?.name).toBe("SEAFAIR");
    expect(worldFor("redline")?.name).toBe("REDLINE");
    expect(worldFor("nothing-here")).toBeNull();
  });

  it("keeps exactly one world contested, and gives it no route", () => {
    const contested = VIBE_WORLDS.filter((w) => w.contested);
    expect(contested).toHaveLength(1);
    expect(contested[0].key).toBe("redline");
    // Falsy, and it has to stay falsy: `_maybeHandOff` returns on `!route`.
    expect(contested[0].route).toBeFalsy();
  });

  it("files every world's stamp under an identifier the passport lists", () => {
    /* The chart matches worlds against the passport by this, not by `.route`.
       Redline's route is null and `r.route === null` can only ever be false —
       which would have made the one world you fight for the one world the map
       never admits you have held. The two lists have to agree. */
    const known = new Set(PASSPORT_WORLDS.map((w) => w.route));
    for (const w of VIBE_WORLDS) {
      const s = stampRouteFor(w);
      expect(s, w.key).toBeTruthy();
      expect(known.has(s!), `${w.key} -> ${s} is in PASSPORT_WORLDS`).toBe(true);
    }
    expect(stampRouteFor(VIBE_WORLDS.find((w) => w.contested))).toBe("/vibeverse/redline");
    expect(stampRouteFor(null)).toBeNull();
  });

  it("leaves every other world a working door", () => {
    for (const w of VIBE_WORLDS) {
      if (w.contested) continue;
      expect(w.route, w.key).toMatch(/^\//);
    }
  });

  it("keeps sea levels inside the ranges the terrain generator was tuned for", () => {
    /* The landing site is picked by direction, not by looking for dry ground.
       A sea level above what Surface.js was built against is how you set down
       underwater on your own hub world. */
    for (const w of VIBE_WORLDS) {
      expect(w.planet.sea, w.key).toBeGreaterThan(0.3);
      expect(w.planet.sea, w.key).toBeLessThanOrEqual(0.66);
    }
  });
});

describe("the contested planet, once generated", () => {
  /** The system Redline lives in, built the way the game builds it. */
  const redlineSystem = () => {
    const idx = VIBE_WORLDS.findIndex((w) => w.key === "redline");
    const stub = generateGalaxy(1337, 14)[idx];
    return generateSystem(stub);
  };

  it("carries the flags the ground code reads, and no route", () => {
    const p = redlineSystem().planets.find((b) => b.worldKey === "redline");
    expect(p, "redline planet is in its own system").toBeTruthy();
    expect(p.contested).toBe(true);
    expect(p.worldRoute).toBeFalsy();
    expect(p.name).toBe("REDLINE");
  });

  it("is not a garden — troopers have to be visible on it", () => {
    const p = redlineSystem().planets.find((b) => b.worldKey === "redline");
    expect(p.garden).toBe(false);
  });

  it("leaves the four routed worlds gardens with routes", () => {
    for (const w of VIBE_WORLDS) {
      if (w.contested) continue;
      const idx = VIBE_WORLDS.indexOf(w);
      const sys = generateSystem(generateGalaxy(1337, 14)[idx]);
      const p = sys.planets.find((b) => b.worldKey === w.key);
      expect(p, w.key).toBeTruthy();
      expect(p.worldRoute, w.key).toBe(w.route);
      expect(p.garden, w.key).toBe(true);
      expect(p.contested, w.key).toBe(false);
    }
  });
});

/**
 * `worldRoute` means "landing here changes the URL". `worldKey` means "this
 * planet is one of ours". They were the same predicate for as long as every
 * authored world was a door, and Redline separated them — so every place that
 * asked "is this one of our worlds?" by testing the route quietly stopped
 * seeing the fifth one. Three of them shipped that way before this was written:
 *
 *   - `jumpToWorld` in-system: pressing 5 while already at Redline did nothing.
 *   - the star map: matched the passport on `.route`, which for a routeless
 *     world can only ever compare false, so it would never say HELD.
 *   - the arrival: `sys.planets.find(p => p.worldRoute)` picks what you come out
 *     of a fold looking at, and with no match it fell through to "the most
 *     interesting body" — you folded to Redline and arrived beside a gas giant.
 *     Found by driving the landing in a browser, not by reading the code.
 *
 * This reads the engine source, which is blunt, but the alternative is booting a
 * WebGL context in jsdom. What it protects is the distinction itself.
 */
describe("worldKey versus worldRoute", () => {
  const src = () =>
    import("node:fs").then((m) => m.readFileSync("src/longsilence/game/Game.js", "utf8"));

  it("finds the planet to arrive at by key", async () => {
    expect(await src()).toContain("sys.planets.find((p) => p.worldKey)");
  });

  it("finds the planet to fly to by key", async () => {
    expect(await src()).toContain("b.spec.worldKey === key");
  });

  it("still gates the handoff on the route, which is the one thing it means", async () => {
    // The navigation itself must stay route-based: no route, no navigation.
    expect(await src()).toContain("const route = b.spec && b.spec.worldRoute;");
  });

  it("marks worlds in the sky by key and hostility, not by route", async () => {
    const hud = await import("node:fs")
      .then((m) => m.readFileSync("src/longsilence/ui/HUD.js", "utf8"));
    expect(hud).toContain("const isWorld = !!b.spec?.worldKey;");
    expect(hud).not.toContain("const isWorld = !!b.spec?.worldRoute;");
  });

  it("matches the star map against the passport through stampRouteFor", async () => {
    const map = await import("node:fs")
      .then((m) => m.readFileSync("src/longsilence/ship/HoloMap.js", "utf8"));
    expect(map).toContain("stampRouteFor(sys.world)");
    expect(map).not.toMatch(/r\.route === sys\.world\.route/);
  });
});

describe("the draw sequence", () => {
  /* Captured from the galaxy with four worlds on the chart, before Redline
     existed. Adding the fifth rolled its name, position, class and designation
     exactly as before and then overrode them, so everything downstream is
     untouched — including the per-system seed, which is what every planet,
     moon, belt and station in that system is built from. */
  const AFTER_THE_WORLDS: [number, string, number][] = [
    [5, "Nyxiththu", 53449862],
    [6, "Quelalmar", 867951923],
    [7, "Elealthu", 376327493],
    [8, "Sareavek", 485714044],
    [9, "Tanuxsil", 122888325],
    [10, "Lumeavek", 881877218],
    [11, "Myraedra", 371152887],
    [12, "Heshea", 808156362],
    [13, "Ithunmar", 831682099],
  ];

  it("does not move a single system when a world is added", () => {
    const g = generateGalaxy(1337, 14);
    for (const [i, name, seed] of AFTER_THE_WORLDS) {
      expect(g[i].name, `system ${i}`).toBe(name);
      expect(g[i].seed, `system ${i}`).toBe(seed);
    }
  });

  it("puts every authored world in its own system, in order", () => {
    const g = generateGalaxy(1337, 14);
    VIBE_WORLDS.forEach((w, i) => {
      expect(g[i].world?.key, `slot ${i}`).toBe(w.key);
      expect(g[i].name).toBe(w.name);
      expect(g[i].x).toBe(w.chart.x);
      expect(g[i].y).toBe(w.chart.y);
    });
    // ...and nothing beyond them claims to be one.
    for (let i = VIBE_WORLDS.length; i < g.length; i++) expect(g[i].world).toBeNull();
  });
});
