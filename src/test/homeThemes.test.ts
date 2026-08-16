/**
 * The bake-off's own guardrails.
 *
 * `/homes` is fifteen whole pages, which is fifteen chances for a fact about
 * the vibeverse to be written down a second time and then quietly go stale. It
 * already happened once: three themes set the world count as a spelled-out word
 * in their headline, a world was added, and all three said "fifty-three" over a
 * grid of fifty-four. This is the same failure `registry.ts` exists to prevent,
 * so it gets the same treatment — one source, and a test that says so.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HOME_THEMES, stepTheme, themeById } from "@/home/themes";
import { spellCount } from "@/home/kit";
import { WORLDS } from "@/worlds/registry";

const DIR = join(process.cwd(), "src/home/themes");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".tsx"));

/** Source with comments removed, so prose in a doc block is not mistaken for
 *  rendered copy. Crude, and sufficient: none of these files put `*​/` or `//`
 *  inside a string literal. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("spellCount", () => {
  it("spells the range a headline can plausibly hold", () => {
    expect(spellCount(0)).toBe("zero");
    expect(spellCount(7)).toBe("seven");
    expect(spellCount(13)).toBe("thirteen");
    expect(spellCount(20)).toBe("twenty");
    expect(spellCount(54)).toBe("fifty-four");
    expect(spellCount(90)).toBe("ninety");
    expect(spellCount(99)).toBe("ninety-nine");
  });

  it("capitalises only the first letter, so it can open a sentence", () => {
    expect(spellCount(54, true)).toBe("Fifty-four");
    expect(spellCount(11, true)).toBe("Eleven");
  });

  it("falls back to the numeral rather than lying", () => {
    expect(spellCount(100)).toBe("100");
    expect(spellCount(-1)).toBe("-1");
    expect(spellCount(4.5)).toBe("4.5");
  });

  it("can actually say today's number", () => {
    expect(spellCount(WORLDS.length)).not.toBe(String(WORLDS.length));
  });
});

describe("no theme hardcodes the world count", () => {
  const SPELLED = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ](one|two|three|four|five|six|seven|eight|nine)\b/i;

  it.each(FILES)("%s renders no spelled-out count", (file) => {
    const body = stripComments(readFileSync(join(DIR, file), "utf8"));
    expect(body).not.toMatch(SPELLED);
  });

  it.each(FILES)("%s renders no bare world-count numeral", (file) => {
    const body = stripComments(readFileSync(join(DIR, file), "utf8"));
    /* Specifically the current count sitting loose in markup. A numeral in a
       class name or a colour is fine; `>54 worlds<` is not. */
    expect(body).not.toMatch(new RegExp(`[>\\s]${WORLDS.length}\\s+worlds`, "i"));
  });
});

describe("the registry of front doors", () => {
  it("has a unique id and name for every entry", () => {
    expect(new Set(HOME_THEMES.map((t) => t.id)).size).toBe(HOME_THEMES.length);
    expect(new Set(HOME_THEMES.map((t) => t.name)).size).toBe(HOME_THEMES.length);
  });

  it("gives every entry a three-colour swatch and a sentence", () => {
    for (const t of HOME_THEMES) {
      expect(t.palette).toHaveLength(3);
      for (const c of t.palette) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t.note.length).toBeGreaterThan(20);
      expect(t.mood.length).toBeGreaterThan(3);
    }
  });

  it("lists every theme file, and no file it does not have", () => {
    /* A theme written and never registered is a page nobody can reach; a
       registered theme with no file is a chunk that fails to load at runtime
       and nowhere else. */
    const imported = new Set(
      readFileSync(join(process.cwd(), "src/home/themes.ts"), "utf8")
        .match(/themes\/(\w+)"/g)
        ?.map((m) => `${m.slice(7, -1)}.tsx`) ?? [],
    );
    expect([...imported].sort()).toEqual(FILES.sort());
  });

  it("steps in both directions and wraps rather than dead-ending", () => {
    const first = HOME_THEMES[0];
    const last = HOME_THEMES[HOME_THEMES.length - 1];
    expect(stepTheme(first.id, -1).id).toBe(last.id);
    expect(stepTheme(last.id, 1).id).toBe(first.id);
    for (const t of HOME_THEMES) {
      expect(stepTheme(stepTheme(t.id, 1).id, -1).id).toBe(t.id);
    }
  });

  it("resolves ids it knows and refuses ones it does not", () => {
    expect(themeById(HOME_THEMES[0].id)?.name).toBe(HOME_THEMES[0].name);
    expect(themeById("no-such-door")).toBeUndefined();
    expect(themeById(undefined)).toBeUndefined();
  });
});
