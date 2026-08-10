/**
 * Which world comes first on the front door.
 *
 * The bug this file exists to stop happening again: `/game` opened on the
 * "recently played" order for everybody, including somebody who had never been
 * anywhere. They got the registry's featured order — the right list — under a
 * heading that said it was the worlds they had played. Nothing crashed and no
 * test failed, because nothing was checking what a visitor with an empty
 * passport sees.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { WORLDS } from "@/worlds/registry";
import { updatedAt } from "@/worlds/freshness";
import {
  SORT_TABS,
  initialSort,
  rememberSort,
  sortWorlds,
  type WorldSort,
} from "@/worlds/sorting";

describe("which order the front door opens on", () => {
  beforeEach(() => localStorage.clear());

  it("shows a first-time visitor the featured order", () => {
    expect(initialSort(false, null)).toBe("featured");
  });

  it("shows a returning visitor whatever they last chose", () => {
    expect(initialSort(true, "updated")).toBe("updated");
    expect(initialSort(true, "played")).toBe("played");
  });

  it("ignores a stored order that no longer exists", () => {
    // "recent" was the old name for "updated". A rename must not wedge anybody.
    expect(initialSort(true, "recent")).toBe("featured");
    expect(initialSort(true, "{}")).toBe("featured");
  });

  it("drops a stored 'played' when the passport is empty", () => {
    /* A cleared browser or a new device. Restoring an order with nothing in it
       looks like the tab is broken. */
    expect(initialSort(false, "played")).toBe("featured");
  });

  it("round-trips a choice through storage", () => {
    rememberSort("updated");
    expect(initialSort(true)).toBe("updated");
  });

  it("survives storage being unavailable", () => {
    const real = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("The operation is insecure.");
      },
    });
    try {
      expect(() => rememberSort("played")).not.toThrow();
      expect(initialSort(true)).toBe("featured");
    } finally {
      if (real) Object.defineProperty(window, "localStorage", real);
    }
  });
});

describe("the orders themselves", () => {
  it("offers exactly the three the page knows how to render", () => {
    expect(SORT_TABS.map((t) => t.id)).toEqual(["featured", "updated", "played"]);
  });

  it("never loses or invents a world, whichever order it is in", () => {
    const keys = [...WORLDS].map((w) => w.key).sort();
    for (const sort of SORT_TABS.map((t) => t.id)) {
      const out = sortWorlds(WORLDS, sort, {});
      expect(out.map((w) => w.key).sort(), sort).toEqual(keys);
    }
  });

  it("puts the freshest first when sorted by update", () => {
    const out = sortWorlds(WORLDS, "updated", {});
    const times = out.map((w) => Date.parse(updatedAt(w.key) ?? "0"));
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1], `${out[i - 1].key} before ${out[i].key}`).toBeGreaterThanOrEqual(
        times[i],
      );
    }
  });

  it("puts the last world you played at the top, then the one before it", () => {
    const [a, b, c] = WORLDS;
    const out = sortWorlds(WORLDS, "played", {
      [a.route]: 1_000,
      [b.route]: 3_000,
      [c.route]: 2_000,
    });
    expect(out.slice(0, 3).map((w) => w.key)).toEqual([b.key, c.key, a.key]);
  });

  it("keeps every unplayed world behind the played ones rather than hiding them", () => {
    /* An order that shortens the page to four cards is a filter wearing a
       sort's clothes, and this page exists to show what is there. */
    const played = WORLDS[5];
    const out = sortWorlds(WORLDS, "played", { [played.route]: 9_000 });
    expect(out).toHaveLength(WORLDS.length);
    expect(out[0].key).toBe(played.key);
    // …and the rest are still in the featured order behind it.
    const behind = out.slice(1).map((w) => w.key);
    const featured = WORLDS.filter((w) => w.key !== played.key).map((w) => w.key);
    expect(behind).toEqual(featured);
  });

  it("is stable for a visitor who has played nothing", () => {
    const out = sortWorlds(WORLDS, "played", {});
    expect(out.map((w) => w.key)).toEqual(WORLDS.map((w) => w.key));
  });

  it("orders a filtered list, not the whole registry", () => {
    const subset = WORLDS.slice(3, 9);
    for (const sort of SORT_TABS.map((t) => t.id as WorldSort)) {
      expect(sortWorlds(subset, sort, {}), sort).toHaveLength(subset.length);
    }
  });
});
