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
  {
    id: "bolt",
    price: 400,
    tier: "epic",
    title: "Bolt",
    pitch: "A dome on a barrel, rocking along on two rigid struts and a centre foot. It cannot walk, and it knows it.",
  },
  {
    id: "pip",
    price: 400,
    tier: "epic",
    title: "Pip",
    pitch: "The body is the wheel. It rolls at the speed you are actually going, under a head that never touches it.",
  },
  {
    id: "gilt",
    price: 350,
    tier: "epic",
    title: "Gilt",
    pitch: "Polished gold with a jointed faceplate and lit bands at every seam. Fussy, and aware of it.",
  },
  {
    id: "sentry",
    price: 250,
    tier: "epic",
    title: "Sentry",
    pitch: "White armour and a helmet with a T cut into it. No face at all, which is the entire point.",
  },
  {
    id: "warden",
    price: 600,
    tier: "legendary",
    title: "Warden",
    pitch: "Black plate, a floor-length cape, and something red burning where a chest should be.",
  },
  {
    id: "bounty",
    price: 550,
    tier: "legendary",
    title: "Bounty",
    pitch: "Bright beskar-ish plating, one heavy pauldron, and a pack on the back that means business.",
  },
  {
    id: "bramble",
    price: 350,
    tier: "epic",
    title: "Bramble",
    pitch: "Shaggy enough that the outline goes soft, with two tusks and a temper.",
  },
  {
    id: "elder",
    price: 300,
    tier: "epic",
    title: "Elder",
    pitch: "Small, robed, enormous ears. Old rather than cute, which is a hard line to walk.",
  },
  {
    id: "gonk",
    price: 150,
    tier: "rare",
    title: "Gonk",
    pitch: "A walking box with one eye sweeping a slot. The joke is that it is finished.",
  },
  {
    id: "medic",
    price: 175,
    tier: "rare",
    title: "Medic",
    pitch: "Clinical white, a dome head, and one bar of light where a face would be.",
  },
  {
    id: "magnate",
    price: 650,
    tier: "legendary",
    title: "Magnate",
    pitch: "Red and gold, a lit chest, a faceplate and a pack. Flight, implied.",
  },
  {
    id: "bulwark",
    price: 400,
    tier: "epic",
    title: "Bulwark",
    pitch: "Heavy blue with a white emblem and nothing lit anywhere. It does not need to glow.",
  },
  {
    id: "emerald",
    price: 300,
    tier: "epic",
    title: "Emerald",
    pitch: "Nothing worn at all — the body is the armour, and there is a great deal of body.",
  },
  {
    id: "voltaic",
    price: 350,
    tier: "epic",
    title: "Voltaic",
    pitch: "Storm navy, gold rings that read as charge, and a cape that lags a beat behind.",
  },
  {
    id: "seraph",
    price: 600,
    tier: "legendary",
    title: "Seraph",
    pitch: "A halo, a cape, wings and a lit core. The one you buy to be looked at.",
  },
  {
    id: "vantablack",
    price: 300,
    tier: "epic",
    title: "Vantablack",
    pitch: "Matte black, thin piping, big lenses. Reads as somebody who would rather not be seen.",
  },
  {
    id: "crimson",
    price: 500,
    tier: "epic",
    title: "Crimson",
    pitch: "A long cloak over a body with no legs under it. It does not walk anywhere.",
  },
  {
    id: "stinger",
    price: 175,
    tier: "rare",
    title: "Stinger",
    pitch: "Amber and black, antennae, and wings that open when you leave the ground.",
  },
  {
    id: "titan",
    price: 550,
    tier: "legendary",
    title: "Titan",
    pitch: "Pauldrons, glowing bands and enough bulk to change the shape of a doorway.",
  },
  {
    id: "phase",
    price: 450,
    tier: "epic",
    title: "Phase",
    pitch: "Seamless mirror plating and one sweeping eye. Unsettling on purpose.",
  },
  {
    id: "cinder",
    price: 400,
    tier: "epic",
    title: "Cinder",
    pitch: "Lit from the inside, horned, and heavy at the back end.",
  },
  {
    id: "frostbite",
    price: 350,
    tier: "epic",
    title: "Frostbite",
    pitch: "Pale and spiked, with the only warm thing on it being the light.",
  },
  {
    id: "mothling",
    price: 300,
    tier: "epic",
    title: "Mothling",
    pitch: "Fuzzy, winged, and mostly eyes. The gentlest thing on the shelf.",
  },
  {
    id: "jelly",
    price: 250,
    tier: "epic",
    title: "Jelly",
    pitch: "Floats, glows, and has no bones in it anywhere.",
  },
  {
    id: "prickle",
    price: 150,
    tier: "rare",
    title: "Prickle",
    pitch: "Boxy, green, and spiked along the crown. Do not hug.",
  },
  {
    id: "toadstool",
    price: 175,
    tier: "rare",
    title: "Toadstool",
    pitch: "A cap, a soft body, and legs far too short for either.",
  },
  {
    id: "origami",
    price: 250,
    tier: "epic",
    title: "Origami",
    pitch: "Hard folds and paper colours, with wings that fold flat against the back.",
  },
  {
    id: "ridgeback",
    price: 450,
    tier: "epic",
    title: "Ridgeback",
    pitch: "Four legs, a long body and a head out front. Not a person on all fours.",
  },
  {
    id: "strider",
    price: 500,
    tier: "epic",
    title: "Strider",
    pitch: "The same four legs, built out of plate and light instead of fur.",
  },
  {
    id: "hauler",
    price: 350,
    tier: "epic",
    title: "Hauler",
    pitch: "A crate on tracks with binoculars for a head and pads on its shoulders.",
  },
  {
    id: "marshmallow",
    price: 300,
    tier: "epic",
    title: "Marshmallow",
    pitch: "Inflated rather than built: no seams, no joints, and two dots for a face.",
  },
  {
    id: "scrap",
    price: 400,
    tier: "epic",
    title: "Scrap",
    pitch: "A crate on tracks with binoculars for a head. The wheels turn at the speed you are going.",
  },
  {
    id: "ovoid",
    price: 450,
    tier: "epic",
    title: "Ovoid",
    pitch: "No legs, no arms, no seam. Floats, banks, and its hands trail behind it.",
  },
  {
    id: "tuxedo",
    price: 250,
    tier: "epic",
    title: "Tuxedo",
    pitch: "Squat and wide with legs too short to stride, so the walk is a roll.",
  },
  {
    id: "sprout",
    price: 175,
    tier: "rare",
    title: "Sprout",
    pitch: "Moss and bark on the same stubby body plan. The tail keeps swinging after it stops.",
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
