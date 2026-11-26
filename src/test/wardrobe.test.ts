/**
 * Cosmetic prices are written twice — once in `src/lib/cosmeticCatalog.ts` so
 * the shop can draw a shelf label without importing a 3D engine, and once in
 * `supabase/functions/vibe-economy/index.ts` because the browser cannot be
 * trusted to name the price of the thing it is buying.
 *
 * Two copies of a number that takes money off people is exactly the
 * duplication that drifts, and the failure is silent in the worst direction:
 * the card says 250, the server charges 25, and nobody finds out from a stack
 * trace. So this reads the deployed source of the edge function, pulls the
 * catalog back out of it, and checks every id and every price.
 *
 * Same trick as `arcade.test.ts`, and for the same reason — the edge function
 * is Deno and will not import into vitest, so the honest options are "parse it"
 * or "hope".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CATALOG,
  HAT_ITEMS,
  FLAME_ITEMS,
  JETPACK_ITEMS,
  itemOf,
  priceOf,
  type CosmeticKind,
} from "@/lib/cosmeticCatalog";
import { WEAPON_ITEMS, ownedWeapons } from "@/lib/weaponCatalog";
import { bombFuse, BOMB_MAX_FUSE, BOUGHT_GUNS } from "@/city/mayhem";

const FN_PATH = resolve(process.cwd(), "supabase/functions/vibe-economy/index.ts");

/** Pull `COSMETICS` back out of the edge function's source. */
function readServerCatalog(): Record<string, Record<string, number>> {
  const src = readFileSync(FN_PATH, "utf8");
  const marker = "const COSMETICS:";
  expect(src.includes(marker), "COSMETICS is missing from the edge function").toBe(true);
  const body = src.slice(src.indexOf(marker));
  // Up to the closing `};` of the top-level object literal.
  const block = body.slice(0, body.indexOf("\n};"));

  const out: Record<string, Record<string, number>> = {};
  // Each `kind: { ... }` group, then each `id: { price: N, title: "..." }`.
  const groupRe = /^\s{2}(\w+):\s*\{$([\s\S]*?)^\s{2}\},$/gm;
  for (const g of block.matchAll(groupRe)) {
    const kind = g[1];
    out[kind] = {};
    const itemRe = /(\w+):\s*\{\s*price:\s*(\d+),\s*title:\s*"([^"]*)"\s*\}/g;
    for (const m of g[2].matchAll(itemRe)) {
      out[kind][m[1]] = Number(m[2]);
    }
  }
  return out;
}

describe("cosmetic prices", () => {
  const server = readServerCatalog();

  it("parses a catalog out of the edge function at all", () => {
    // Guards the parser itself: a regex that silently matches nothing would
    // make every assertion below vacuously pass.
    //
    // `character` is a fourth group in the same object but it is not a
    // cosmetic — it follows the opposite rule about unlisted ids and is
    // checked by `characterShop.test.ts`. Asserted as present rather than
    // ignored, so deleting it from the server fails a test somewhere.
    expect(Object.keys(server).sort()).toEqual(["character", "flame", "hat", "jetpack", "weapon"]);
    for (const kind of ["hat", "flame", "jetpack"]) {
      expect(Object.keys(server[kind]).length).toBeGreaterThan(3);
    }
  });

  for (const kind of ["hat", "flame", "jetpack"] as CosmeticKind[]) {
    describe(kind, () => {
      it("offers exactly the same items on both sides", () => {
        expect(Object.keys(server[kind]).sort()).toEqual(
          CATALOG[kind].map((i) => i.id).sort(),
        );
      });

      it("charges what the shelf label says", () => {
        for (const item of CATALOG[kind]) {
          expect(server[kind][item.id], `${kind}/${item.id}`).toBe(item.price);
        }
      });
    });
  }
});

describe("the catalog itself", () => {
  it("has no duplicate ids within a kind", () => {
    for (const kind of ["hat", "flame", "jetpack"] as CosmeticKind[]) {
      const ids = CATALOG[kind].map((i) => i.id);
      expect(new Set(ids).size, kind).toBe(ids.length);
    }
  });

  it("keeps a free default in every kind", () => {
    /* Every kind needs something priced 0, or a brand new wallet cannot equip
       anything at all in that slot — and the loadout defaults would point at
       an item the server refuses to equip. */
    for (const kind of ["hat", "flame", "jetpack"] as CosmeticKind[]) {
      expect(CATALOG[kind].some((i) => i.price === 0), kind).toBe(true);
    }
  });

  it("gives the loadout defaults away for free", () => {
    // `DEFAULT_LOADOUT` in wardrobe.ts is none/mint/stock. If any of those ever
    // gained a price, every new player would start wearing something the
    // server would refuse to let them re-equip.
    expect(priceOf("hat", "none")).toBe(0);
    expect(priceOf("flame", "mint")).toBe(0);
    expect(priceOf("jetpack", "stock")).toBe(0);
  });

  it("prices nothing above a day's honest earnings by more than a few days", () => {
    /* The arcade caps winnings at 400/day. A cosmetic that costs more than a
       few days of good play is not a goal, it is a wall — and the halo at 400
       is deliberately right at one full day. */
    const dearest = Math.max(
      ...[...HAT_ITEMS, ...FLAME_ITEMS, ...JETPACK_ITEMS].map((i) => i.price),
    );
    expect(dearest).toBeLessThanOrEqual(400 * 3);
  });

  it("looks items up by kind and id", () => {
    expect(itemOf("hat", "crown")?.name).toBe("Crown");
    expect(itemOf("hat", "nope")).toBeUndefined();
    expect(priceOf("jetpack", "gold")).toBe(260);
  });
});

describe("Vibe City weapons", () => {
  const server = readServerCatalog();

  it("sells exactly the same weapons on both sides, at the shelf price", () => {
    expect(Object.keys(server.weapon).sort()).toEqual(WEAPON_ITEMS.map((w) => w.id).sort());
    for (const w of WEAPON_ITEMS) expect(server.weapon[w.id], w.id).toBe(w.price);
  });

  it("charges for every one of them, and the blaster is the dearest", () => {
    for (const w of WEAPON_ITEMS) expect(w.price, w.id).toBeGreaterThan(0);
    const dearest = [...WEAPON_ITEMS].sort((a, b) => b.price - a.price)[0];
    expect(dearest.id).toBe("blaster");
  });

  it("every bought gun in the city has a shelf entry", () => {
    for (const g of BOUGHT_GUNS) expect(WEAPON_ITEMS.some((w) => w.id === g), g).toBe(true);
  });

  it("reads weapons out of the inventory keys and nothing else", () => {
    expect(ownedWeapons(["hat:crown", "weapon:glock", "weapon:pineapple", "character:pixel"])).toEqual([
      "glock",
      "pineapple",
    ]);
  });

  it("holds a stuck pineapple between an instant and about 27 seconds", () => {
    expect(bombFuse(0)).toBe(0);
    expect(bombFuse(1)).toBe(BOMB_MAX_FUSE);
    expect(BOMB_MAX_FUSE).toBe(27);
    expect(bombFuse(0.5)).toBeLessThan(BOMB_MAX_FUSE / 2);
  });
});
