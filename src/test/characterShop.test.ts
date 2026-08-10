/**
 * The character shop is priced twice — once in `src/lib/characterShop.ts` so
 * the shelf can draw a label, and once in `supabase/functions/vibe-economy` because
 * a browser cannot be trusted to name the price of the thing it is buying.
 * Same trick as `wardrobe.test.ts`: read the edge function's source and check
 * the two agree, because a card that says 600 while the server charges 60 is a
 * failure nobody finds from a stack trace.
 *
 * It also guards the rule that makes this group different from the hats. For a
 * hat, an id missing from the server table is an error. For a character it
 * means *free* — there are sixty-odd GLBs behind an `import.meta.glob` and the
 * server does not enumerate them. That inversion is load-bearing and easy to
 * undo by accident, so it is asserted here rather than left in a comment.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SHOP_CHARACTERS,
  TIER_STYLE,
  TIER_ORDER,
  characterKey,
  characterPrice,
  isForSale,
  shopCharacter,
} from "@/lib/characterShop";
import { CHARACTERS } from "@/lib/characters";
import { PILOT_DESIGNS } from "@/components/city/proceduralPilot";
import { itemKey } from "@/lib/wardrobe";

const FN_PATH = resolve(process.cwd(), "supabase/functions/vibe-economy/index.ts");
const SRC = readFileSync(FN_PATH, "utf8");

/** Pull the `character:` group back out of `COSMETICS`. */
function readServerCharacters(): Record<string, { price: number; title: string }> {
  const marker = "const COSMETICS:";
  expect(SRC.includes(marker), "COSMETICS is missing from the edge function").toBe(true);
  const block = SRC.slice(SRC.indexOf(marker));
  const group = /^ {2}character:\s*\{$([\s\S]*?)^ {2}\},$/m.exec(block);
  expect(group, "no `character` group in the edge function's COSMETICS").not.toBeNull();

  const out: Record<string, { price: number; title: string }> = {};
  // Keys may be quoted, because an id with a hyphen in it — `space-rex` — is
  // not a bare JS identifier. The first version of this regex matched `\w+`
  // only, so adding that character silently dropped it from the parsed table
  // and every assertion below went quiet about it rather than failing loudly.
  const itemRe = /"?([\w-]+)"?:\s*\{\s*price:\s*(\d+),\s*title:\s*"([^"]*)"\s*\}/g;
  for (const m of (group as RegExpExecArray)[1].matchAll(itemRe)) {
    out[m[1]] = { price: Number(m[2]), title: m[3] };
  }
  return out;
}

describe("character prices", () => {
  const server = readServerCharacters();

  it("parses a character catalog out of the edge function at all", () => {
    // Guards the parser: a regex that matched nothing would make every
    // assertion below vacuously true.
    expect(Object.keys(server).length).toBe(SHOP_CHARACTERS.length);
    expect(Object.keys(server).length).toBeGreaterThan(3);
  });

  it("offers exactly the same characters on both sides", () => {
    expect(Object.keys(server).sort()).toEqual(SHOP_CHARACTERS.map((c) => c.id).sort());
  });

  it("charges what the shelf label says", () => {
    for (const c of SHOP_CHARACTERS) {
      expect(server[c.id].price, c.id).toBe(c.price);
    }
  });

  it("records the same name in the ledger as the one on the card", () => {
    for (const c of SHOP_CHARACTERS) {
      expect(server[c.id].title, c.id).toBe(c.title);
    }
  });
});

describe("the free roster stays free", () => {
  it("keeps the inversion: an unlisted character is free, not an error", () => {
    /* `pickCharacter` is what lets a Wizard be equipped without the server
       having ever heard of him. If someone ever routes characters through the
       strict `cosmeticSpec` path instead, sixty characters become unequippable
       the moment this file is redeployed — and nothing else would catch it. */
    expect(SRC).toMatch(/const pickCharacter =/);
    expect(SRC).toMatch(/pickCharacter\(b\.character, current\.character\)/);
    // The lookup has to be the optional one, not the throwing one.
    expect(SRC).toMatch(/const spec = COSMETICS\.character\[id\];/);
  });

  it("still refuses to equip a priced character you have not bought", () => {
    expect(SRC).toMatch(/if \(spec && spec\.price > 0 && !owned\.has\(itemKey\("character", id\)\)\)/);
  });

  it("does not put a price on anything that was free before the shop existed", () => {
    /* Every priced character must be one of the code-built originals. If a
       Quaternius GLB ever appears in the shop it means something that used to
       be free has had a padlock put on it, which is the one thing the shop is
       not allowed to do. */
    for (const c of SHOP_CHARACTERS) {
      const spec = CHARACTERS.find((s) => s.id === c.id);
      expect(spec, `${c.id} is not in the roster at all`).toBeDefined();
      expect(spec?.url, `${c.id} is a model file, not an original`).toBe("");
      expect(PILOT_DESIGNS[c.id], `${c.id} has no design table entry`).toBeDefined();
    }
  });

  it("writes the loadout to char_id, not to a column named `character`", () => {
    // CHARACTER is a SQL keyword and the column is `char_id`; a spread of the
    // loadout object here would post a column that does not exist.
    expect(SRC).toMatch(/char_id: next\.character/);
    expect(SRC).toMatch(/char_id: guestLook\.character/);
    expect(SRC).toMatch(/select\("hat, flame, jetpack, char_id"\)/);
  });
});

describe("the shop catalog itself", () => {
  it("has no duplicate ids", () => {
    const ids = SHOP_CHARACTERS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("prices everything above zero — free things are simply not in here", () => {
    for (const c of SHOP_CHARACTERS) expect(c.price, c.id).toBeGreaterThan(0);
  });

  it("gives every character a tier that has a style", () => {
    for (const c of SHOP_CHARACTERS) {
      expect(TIER_STYLE[c.tier], c.id).toBeDefined();
      expect(TIER_ORDER).toContain(c.tier);
    }
  });

  it("keeps the dearest within a few days of the arcade's daily ceiling", () => {
    // The arcade pays at most 400 a day. A character nobody can reach is not a
    // goal, it is a wall — legendary sits at a day and a half.
    const dearest = Math.max(...SHOP_CHARACTERS.map((c) => c.price));
    expect(dearest).toBeLessThanOrEqual(400 * 3);
  });

  it("charges more for a rarer tier than a commoner one", () => {
    const cheapest = (t: string) =>
      Math.min(...SHOP_CHARACTERS.filter((c) => c.tier === t).map((c) => c.price));
    const dearest = (t: string) =>
      Math.max(...SHOP_CHARACTERS.filter((c) => c.tier === t).map((c) => c.price));
    for (let i = 1; i < TIER_ORDER.length; i++) {
      expect(cheapest(TIER_ORDER[i])).toBeGreaterThan(dearest(TIER_ORDER[i - 1]));
    }
  });

  it("namespaces the inventory key the same way the wardrobe does", () => {
    // Two spellings of `character:aurora` would mean a character you bought
    // and a character you own being different rows.
    expect(characterKey("aurora")).toBe(itemKey("character", "aurora"));
  });

  it("answers honestly about the free roster", () => {
    expect(isForSale("aurora")).toBe(true);
    expect(isForSale("Wizard")).toBe(false);
    expect(isForSale(null)).toBe(false);
    expect(characterPrice("Wizard")).toBe(0);
    expect(characterPrice("grimlock")).toBe(600);
    expect(shopCharacter("nope")).toBeUndefined();
  });
});
