/**
 * The classifieds column.
 *
 * Two things are worth pinning here. One: the rotation must be a function of
 * the issue number and nothing else, because a back issue that shows this
 * morning's ads is a back issue that has been quietly rewritten — and because
 * a column that reshuffles on every render is a column nobody can read.
 *
 * Two: every word in an ad has to come from the registry. The paper's footer
 * promises that nothing in it is invented except the forecast, and a set of
 * ads assembled from templates would be the exception sitting directly above
 * the promise.
 */
import { describe, it, expect } from "vitest";
import { WORLDS } from "@/worlds/registry";
import { advertisable, firstSentence, smallAds } from "@/lib/smallAds";

describe("firstSentence", () => {
  it("takes one sentence out of a blurb written for a card", () => {
    expect(firstSentence("Sink eight kilometres. Then read what you find. Twelve animals.")).toBe(
      "Sink eight kilometres.",
    );
  });

  it("keeps a blurb that is already one sentence", () => {
    expect(firstSentence("Drive a kart round an island")).toBe("Drive a kart round an island");
  });

  it("trims a long one on a word boundary rather than mid-word", () => {
    const long = `${"word ".repeat(60)}end.`;
    const out = firstSentence(long, 40);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/wor…$/);
  });

  it("does not cut a decimal or an abbreviation in half", () => {
    expect(firstSentence("Opens at 8 a.m. sharp. Bring a coat.")).toBe("Opens at 8 a.m. sharp.");
  });

  it("survives whitespace and newlines in the source", () => {
    expect(firstSentence("  A place\n   to be.  And another. ")).toBe("A place to be.");
  });
});

describe("smallAds", () => {
  it("never advertises a tool, the paper, or the newsroom", () => {
    const keys = advertisable(WORLDS).map((w) => w.key);
    expect(keys).not.toContain("times");
    expect(keys).not.toContain("newsroom");
    expect(advertisable(WORLDS).every((w) => w.kind !== "tool")).toBe(true);
  });

  it("is a pure function of the issue number", () => {
    expect(smallAds(WORLDS, 13)).toEqual(smallAds(WORLDS, 13));
  });

  it("does not run the same world twice in one issue", () => {
    const ads = smallAds(WORLDS, 7, 4);
    expect(new Set(ads.map((a) => a.key)).size).toBe(ads.length);
  });

  it("does not repeat yesterday's column", () => {
    const today = smallAds(WORLDS, 13).map((a) => a.key);
    const yesterday = smallAds(WORLDS, 12).map((a) => a.key);
    expect(today.some((k) => yesterday.includes(k))).toBe(false);
  });

  it("quotes the registry rather than writing anything", () => {
    for (const ad of smallAds(WORLDS, 21, 5)) {
      const world = WORLDS.find((w) => w.key === ad.key)!;
      expect(ad.name).toBe(world.name);
      expect(ad.route).toBe(world.route);
      // The line is the blurb's own opening, character for character, up to
      // the point it was trimmed.
      expect(world.blurb.replace(/\s+/g, " ")).toContain(ad.line.replace(/…$/, ""));
    }
  });

  it("hands back every world once when asked for more than exist", () => {
    const all = advertisable(WORLDS).length;
    const ads = smallAds(WORLDS, 3, all + 10);
    expect(ads).toHaveLength(all);
    expect(new Set(ads.map((a) => a.key)).size).toBe(all);
  });

  it("returns nothing rather than throwing on nonsense", () => {
    expect(smallAds([], 4)).toEqual([]);
    expect(smallAds(WORLDS, 4, 0)).toEqual([]);
    expect(smallAds(WORLDS, Number.NaN)).toHaveLength(3);
    expect(smallAds(WORLDS, -6)).toEqual(smallAds(WORLDS, 6));
  });
});
