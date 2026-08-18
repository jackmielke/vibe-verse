/**
 * The small ads.
 *
 * Every local paper has a column of them down the side, and this one has
 * fifty-odd worlds sitting in a registry that most readers of the front page
 * have never opened. So the classifieds are real: each ad is a world, its own
 * emoji, the first sentence of its own blurb, and the route you get there by.
 * Nothing here is written — it is the registry, set in a smaller type.
 *
 * That matters more than it sounds. The paper's whole argument is that every
 * claim in it traces to something; a column of invented ads at the bottom
 * would be the one section quietly making things up, next to a footer
 * promising it never does. Copying the blurb verbatim keeps the promise.
 *
 * The rotation is deterministic in the issue number, so:
 *   - today's paper always shows today's ads, on every reload and every device
 *   - a back issue shows the ads it ran with, not this morning's
 *   - consecutive issues do not repeat, which a random pick would
 *
 * The category headings are the joke and the only invented thing here: a
 * playable game is a SITUATION VACANT because somebody has to go and play it.
 */
import type { WorldEntry, WorldKind } from "@/worlds/registry";

export interface SmallAd {
  key: string;
  route: string;
  name: string;
  emoji: string;
  /** The heading it runs under — "PROPERTY", "SITUATIONS VACANT". */
  heading: string;
  /** The world's own first sentence, verbatim. */
  line: string;
}

const HEADINGS: Record<WorldKind, string> = {
  world: "Property",
  game: "Situations Vacant",
  hangout: "Public Notices",
  tool: "Trade",
};

/** How much of a blurb fits in a column an inch and a half wide. */
const MAX = 150;

/**
 * The first sentence of a blurb.
 *
 * Blurbs run to three or four sentences because they are written for a card
 * with room to breathe. An ad has a line.
 *
 * A full stop is only the end of a sentence if what follows starts like a new
 * one — whitespace and a capital, or nothing at all. Splitting on "a stop
 * followed by a space" instead cuts "opens at 8 a.m. sharp" down to "opens at
 * 8 a.m.", which reads as a typesetting fault rather than a summary. A blurb
 * that is one long sentence gets trimmed on a word boundary instead.
 */
export function firstSentence(blurb: string, max = MAX): string {
  const text = blurb.trim().replace(/\s+/g, " ");
  const stop = text.search(/[.!?](?=\s+["'“(]?[A-Z]|\s*$)/);
  const one = stop > 0 ? text.slice(0, stop + 1) : text;
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:—-]$/, "")}…`;
}

/**
 * Which worlds can carry an ad.
 *
 * Tools are excluded — a form does not want a classified — and so is anything
 * without a route or a blurb to quote. The paper and the newsroom are left
 * out too: a newspaper advertising itself in its own classifieds is the kind
 * of thing that reads as a mistake rather than a joke.
 */
export function advertisable(worlds: WorldEntry[]): WorldEntry[] {
  const skip = new Set(["times", "newsroom"]);
  return worlds.filter(
    (w) => w.kind !== "tool" && !skip.has(w.key) && !!w.route && !!w.blurb?.trim(),
  );
}

/**
 * `count` ads for a given issue, in a stable order.
 *
 * The window walks forward by `count` each issue and wraps, so the column
 * works its way through the whole registry over a few weeks and comes back
 * around. Asking for more ads than there are worlds returns every world once
 * rather than repeating any.
 */
export function smallAds(worlds: WorldEntry[], issue: number, count = 3): SmallAd[] {
  const list = advertisable(worlds);
  if (!list.length || count < 1) return [];
  const take = Math.min(count, list.length);
  // A negative or non-finite issue number should not throw a column of ads
  // off the front page; treat anything unusable as issue zero.
  const n = Number.isFinite(issue) ? Math.abs(Math.trunc(issue)) : 0;
  const start = (n * take) % list.length;

  return Array.from({ length: take }, (_, i) => {
    const w = list[(start + i) % list.length];
    return {
      key: w.key,
      route: w.route,
      name: w.name,
      emoji: w.emoji,
      heading: HEADINGS[w.kind] ?? "Notices",
      line: firstSentence(w.blurb),
    };
  });
}
