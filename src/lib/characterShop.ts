/**
 * The arcade's character shop — what is for sale, and what it costs.
 *
 * ## Why only six things are on the shelf
 *
 * There are sixty-odd characters in `src/lib/characters.ts` and every one of
 * them is already free in the Character Portal. Putting a price on the Wizard
 * would not be adding a shop, it would be taking the Wizard away from the
 * people already playing as him. So the stock is six designs that did not
 * exist before the shop did: code-built, no model file, no licence, drawn from
 * the same rig as Flux and defined in `PILOT_DESIGNS`. Buying one adds
 * something to the vibeverse; nothing was removed to make room for it.
 *
 * That is also the rule the server runs on, and it is worth stating plainly
 * because it inverts the usual one: **in this table means you must own it,
 * absent means it is free.** The edge function does not enumerate the free
 * roster — it is a glob over a folder of GLBs, and a copy of that list on the
 * server would be a second place to forget one.
 *
 * ## Prices
 *
 * The arcade will not pay out more than 400 a day, so a tier is really a
 * number of good days: rare is most of one, epic is a bit under a week of
 * casual play, legendary is something you decide to go and get. Nothing here
 * is priced as a wall — the whole point of a sink is that people reach it.
 *
 * These numbers are mirrored in `supabase/functions/vibe-economy/index.ts`
 * under `COSMETICS.character`, which is the copy that actually charges you.
 * `src/test/characterShop.test.ts` reads that file and asserts the two agree,
 * so a price that drifts fails a test rather than a customer.
 */

export type CharacterTier = "rare" | "epic" | "legendary";

export interface ShopCharacter {
  /** Matches a `CharSpec.id` in `src/lib/characters.ts`. */
  id: string;
  /** Vibecoin. Always above zero — anything free simply is not in here. */
  price: number;
  tier: CharacterTier;
  /** The name the ledger records. Kept in step with the server's copy. */
  title: string;
  /** One line on the card, about the look rather than the stats. */
  pitch: string;
}

export const TIER_STYLE: Record<
  CharacterTier,
  { label: string; color: string; blurb: string }
> = {
  rare: {
    label: "Rare",
    color: "#5db8e8",
    blurb: "About a day of good play.",
  },
  epic: {
    label: "Epic",
    color: "#c084fc",
    blurb: "A few days, or one very good one.",
  },
  legendary: {
    label: "Legendary",
    color: "#ffd166",
    blurb: "Something you go and get on purpose.",
  },
};

export const SHOP_CHARACTERS: ShopCharacter[] = [
  {
    id: "pixel",
    price: 150,
    tier: "rare",
    title: "Pixel",
    pitch: "Hot pink, cat ears, and lenses that take up most of the face.",
  },
  {
    id: "bumble",
    price: 150,
    tier: "rare",
    title: "Bumble",
    pitch: "Amber and black, with antennae that arrive a beat after the rest of it.",
  },
  {
    id: "sable",
    price: 300,
    tier: "epic",
    title: "Sable",
    pitch: "Midnight and gold. Bat ears over a muzzle, and a tail that counterweights the turns.",
  },
  {
    id: "chrome",
    price: 300,
    tier: "epic",
    title: "Chrome",
    pitch: "Mirror plating, a burnt-orange visor, and a solid metal tail with weight in it.",
  },
  {
    id: "grimlock",
    price: 600,
    tier: "legendary",
    title: "Grimlock",
    pitch: "Black armour, horns, a magenta emblem, and a cape to the floor.",
  },
  {
    id: "aurora",
    price: 600,
    tier: "legendary",
    title: "Aurora",
    pitch: "A halo that trails a beat behind, and wings that open when you leave the ground.",
  },
  {
    id: "eddie",
    price: 200,
    tier: "epic",
    title: "Eddie",
    pitch: "Brass and teal, antennae that bob a beat late, and a reactor in the chest.",
  },
  {
    id: "vibe-police",
    price: 350,
    tier: "epic",
    title: "Vibe Police",
    pitch: "A corgi in uniform, unimpressed by all of this. Cap, badge, and a tail that disagrees with the face.",
  },
  {
    id: "space-rex",
    price: 450,
    tier: "epic",
    title: "Space Rex",
    pitch: "A green dinosaur in a white suit, under a glass bubble with a gleam across it.",
  },
];

/** `character:aurora`. Same namespacing as the hats — see `wardrobe.ts`. */
export const characterKey = (id: string) => `character:${id}`;

export const shopCharacter = (id: string | null | undefined): ShopCharacter | undefined =>
  SHOP_CHARACTERS.find((c) => c.id === id);

/** Is this one bought, or is it part of the free roster? */
export const isForSale = (id: string | null | undefined): boolean => !!shopCharacter(id);

/** Zero for the free roster, which is the honest answer rather than undefined. */
export const characterPrice = (id: string | null | undefined): number =>
  shopCharacter(id)?.price ?? 0;

/** Cheapest first inside a tier, cheapest tier first. The shelf order. */
export const TIER_ORDER: CharacterTier[] = ["rare", "epic", "legendary"];

export const byShelfOrder = (a: ShopCharacter, b: ShopCharacter): number =>
  TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.price - b.price;
