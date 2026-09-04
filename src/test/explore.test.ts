/**
 * Exploring pays, which means three numbers now exist in two places each, and
 * a fourth thing has to be true that nothing else in the repo would notice
 * breaking.
 *
 * The duplication is the same deliberate arrangement the arcade paytable has:
 * `lib/explore.ts` carries a copy of the rates so the passport can draw a
 * progress bar and print "425 ✦ still out there" without a round trip, and
 * `supabase/functions/vibe-explore/index.ts` carries the copy that actually
 * pays. Two copies of a number that pays people is exactly the kind of thing
 * that drifts quietly — the page advertises a 1,000 ✦ rank and the server
 * credits 400, and nobody finds out from a stack trace.
 *
 * The fourth thing is subtler and is the reason this file is worth more than
 * its parity checks: the server accepts a world key only if it matches
 * `WORLD_KEY`, and it has no roster to check it against. So a registry key with
 * a capital letter or an underscore is not an error anywhere — it is a world
 * that silently never pays, forever, and looks exactly like a world nobody has
 * visited.
 *
 * Reads the edge function as text rather than importing it, for the reason the
 * arcade test does: it is Deno, it imports from `jsr:` and `esm.sh`, and it
 * will not load in vitest.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_PER_WORLD, MILESTONES, rankFor } from "@/lib/explore";
import {
  markSettled,
  mergeServerVisits,
  readPassport,
  readSettled,
  stampPassport,
  stampsForSync,
  unsettledStamps,
} from "@/lib/passport";
import { PASSPORT_ROUTES } from "@/worlds/registry";

const FN = readFileSync(
  resolve(process.cwd(), "supabase/functions/vibe-explore/index.ts"),
  "utf8",
);

const num = (name: string): number => {
  const m = FN.match(new RegExp(`const ${name} = (\\d+)`));
  expect(m, `${name} is missing from the edge function`).toBeTruthy();
  return Number(m![1]);
};

describe("explore — the client and the server agree", () => {
  it("pays the same per world", () => {
    expect(DEFAULT_PER_WORLD).toBe(num("EXPLORE_PER_WORLD"));
  });

  it("has the same milestones, in the same order, for the same bonuses", () => {
    const block = FN.split("const EXPLORE_MILESTONES")[1];
    expect(block, "EXPLORE_MILESTONES is missing").toBeTruthy();
    const body = block.slice(0, block.indexOf("\n];"));
    const server = [...body.matchAll(
      /\{\s*at:\s*(\d+),\s*bonus:\s*(\d+),\s*title:\s*"([^"]+)"\s*\}/g,
    )].map((m) => ({ at: Number(m[1]), bonus: Number(m[2]), title: m[3] }));

    expect(server.length).toBeGreaterThan(0);
    expect(MILESTONES).toEqual(server);
  });

  it("states a ceiling the arithmetic actually supports", () => {
    // The function's own docblock promises "80 × 25 + 1,700 = 3,700" as the
    // most any wallet can ever mint from exploring. That claim is load-bearing
    // — it is the entire answer to "what is the worst a faked client can do" —
    // so it gets checked rather than trusted.
    const maxWorlds = num("EXPLORE_MAX_WORLDS");
    const bonuses = MILESTONES.reduce((t, m) => t + m.bonus, 0);
    expect(bonuses).toBe(1700);
    expect(maxWorlds * DEFAULT_PER_WORLD + bonuses).toBe(3700);
    // And the ceiling has to stay comfortably clear of the real roster, or
    // adding a few worlds starts silently costing people their payout.
    expect(maxWorlds).toBeGreaterThan(PASSPORT_ROUTES.length + 15);
  });
});

describe("explore — every world can actually be paid for", () => {
  /** The exact regex the edge function guards on, pulled from its source. */
  const serverKeyRe = (() => {
    const m = FN.match(/const WORLD_KEY = \/(.+?)\/;/);
    expect(m, "WORLD_KEY is missing from the edge function").toBeTruthy();
    return new RegExp(m![1]);
  })();

  it("gives every passport world a key the server will accept", () => {
    const rejected = PASSPORT_ROUTES.filter((w) => !serverKeyRe.test(w.key));
    expect(
      rejected.map((w) => `${w.name} (${w.key})`),
      "these worlds would be silently dropped by vibe-explore and never pay",
    ).toEqual([]);
  });

  it("gives every passport world a key, and no two the same", () => {
    const keys = PASSPORT_ROUTES.map((w) => w.key);
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("rankFor", () => {
  it("has no rank below the first threshold", () => {
    expect(rankFor(0).earned).toBeNull();
    expect(rankFor(4).earned).toBeNull();
    expect(rankFor(0).next?.title).toBe("Wanderer");
  });

  it("promotes exactly on the threshold, not after it", () => {
    expect(rankFor(5).earned?.title).toBe("Wanderer");
    expect(rankFor(5).next?.title).toBe("Voyager");
  });

  it("holds the rank between thresholds", () => {
    expect(rankFor(19).earned?.title).toBe("Voyager");
    expect(rankFor(20).earned?.title).toBe("Pathfinder");
  });

  it("runs out of ranks at the top rather than inventing one", () => {
    expect(rankFor(30).earned?.title).toBe("Cartographer");
    expect(rankFor(999).next).toBeNull();
  });
});

describe("what gets sent to the ledger", () => {
  beforeEach(() => localStorage.clear());

  const someWorld = PASSPORT_ROUTES.find((w) => !w.earned)!;

  it("converts a stamp's route into the registry key the server records", () => {
    stampPassport(someWorld.route, someWorld.name);
    expect(stampsForSync()).toEqual([{ key: someWorld.key, name: someWorld.name }]);
  });

  it("drops a stamp for a route that is no longer a world", () => {
    // Routes move. A stamp left over from one that did is unpayable rather
    // than an error — the server would not know what it was.
    stampPassport("/somewhere-that-moved", "Gone");
    expect(stampsForSync()).toEqual([]);
  });

  it("stops offering a world once it has been settled", () => {
    stampPassport(someWorld.route, someWorld.name);
    expect(unsettledStamps()).toHaveLength(1);
    markSettled([someWorld.key]);
    expect(unsettledStamps()).toHaveLength(0);
    // …but it is still part of the book, and still sent on a full sync.
    expect(stampsForSync()).toHaveLength(1);
  });

  it("survives a corrupt settled-list rather than losing the passport", () => {
    localStorage.setItem("vibe.passport.paid", "{not json");
    expect(readSettled().size).toBe(0);
  });
});

describe("a passport arriving from another device", () => {
  beforeEach(() => localStorage.clear());

  const a = PASSPORT_ROUTES[0];
  const b = PASSPORT_ROUTES[1];

  it("writes worlds the browser has never seen", () => {
    mergeServerVisits([a.key], { [a.key]: 1_700_000_000_000 });
    const s = readPassport().stamps[a.route];
    expect(s?.name).toBe(a.name);
    expect(s?.first).toBe(1_700_000_000_000);
  });

  it("never overwrites a local stamp, which knows more than the server does", () => {
    stampPassport(b.route, b.name);
    stampPassport(b.route, b.name); // a second, later arrival
    const before = readPassport().stamps[b.route];
    mergeServerVisits([b.key], { [b.key]: 1 });
    const after = readPassport().stamps[b.route];
    expect(after.first).toBe(before.first);
    expect(after.count).toBe(before.count);
  });

  it("ignores a key that is not a world here", () => {
    mergeServerVisits(["not-a-real-world"], {});
    expect(Object.keys(readPassport().stamps)).toEqual([]);
  });
});
