/**
 * The cosmetics catalog — ids, names and **prices**, and nothing else.
 *
 * Split out of `components/city/cosmetics.ts` for the same reason `art.ts` is
 * split out of `registry.ts`: that module imports Three and builds real
 * geometry for every hat, and the shop is a grid of cards that needs to know
 * what a crown costs, not how to extrude one. Importing the builders to read a
 * number would put a 3D engine in the bundle of a 2D page.
 *
 * It is also the file to look at when money is involved. These prices are
 * mirrored in `ARCADE`-style fashion inside `supabase/functions/vibe-economy`
 * — the server's copy is the authority and is what actually charges you, this
 * one draws the shelf label. `src/test/wardrobe.test.ts` reads the edge
 * function's source and asserts the two agree on every item, so a price that
 * drifts fails a test instead of a customer.
 */

export type CosmeticKind = "hat" | "flame" | "jetpack";

export interface CosmeticItem {
  id: string;
  name: string;
  emoji: string;
  /** Vibecoin. Zero means stock issue: never bought, always yours. */
  price: number;
}

export interface FlameItem extends CosmeticItem {
  /** Plume colour. */
  color: string;
  /** Inner core / light tint. */
  core: string;
}

export interface JetpackItem extends CosmeticItem {
  /** When false the pack is hidden and thrust is disabled. */
  equipped: boolean;
  body: string;
  trim: string;
}

export const HAT_ITEMS: CosmeticItem[] = [
  { id: "none",      name: "No Hat",       emoji: "🙅", price: 0 },
  { id: "cap",       name: "Mint Cap",     emoji: "🧢", price: 25 },
  { id: "beanie",    name: "Pom Beanie",   emoji: "🤠", price: 35 },
  { id: "party",     name: "Party Cone",   emoji: "🥳", price: 60 },
  { id: "tophat",    name: "Top Hat",      emoji: "🎩", price: 75 },
  { id: "propeller", name: "Propeller",    emoji: "🚁", price: 90 },
  { id: "crown",     name: "Crown",        emoji: "👑", price: 250 },
  { id: "halo",      name: "Halo",         emoji: "😇", price: 400 },
  { id: "sticker",   name: "Holo Sticker", emoji: "✨", price: 0 },
];

export const FLAME_ITEMS: FlameItem[] = [
  { id: "mint",    name: "Mint Stock",   emoji: "🌿", price: 0,   color: "#7dfce0", core: "#7dfce0" },
  { id: "fire",    name: "Fire Boost",   emoji: "🔥", price: 50,  color: "#ff8a3d", core: "#ffd166" },
  { id: "violet",  name: "Violet Pulse", emoji: "💜", price: 80,  color: "#c084fc", core: "#f0abfc" },
  { id: "magma",   name: "Magma Roar",   emoji: "🌋", price: 120, color: "#e85d75", core: "#ffd166" },
  { id: "ion",     name: "Ion Cyan",     emoji: "⚡", price: 150, color: "#5db8e8", core: "#baffe9" },
  { id: "rainbow", name: "Rainbow",      emoji: "🌈", price: 300, color: "#ffffff", core: "#ffffff" },
];

export const JETPACK_ITEMS: JetpackItem[] = [
  { id: "stock",  name: "Stock Pack",  emoji: "🎒", price: 0,   equipped: true,  body: "#1d2733", trim: "#2dd4a8" },
  { id: "sunset", name: "Sunset Pack", emoji: "🌅", price: 80,  equipped: true,  body: "#3a1f2b", trim: "#ff8a3d" },
  { id: "violet", name: "Violet Pack", emoji: "💜", price: 110, equipped: true,  body: "#2a1a44", trim: "#c084fc" },
  { id: "ion",    name: "Ion Pack",    emoji: "⚡", price: 140, equipped: true,  body: "#0f2530", trim: "#5db8e8" },
  { id: "magma",  name: "Magma Pack",  emoji: "🌋", price: 180, equipped: true,  body: "#2d1414", trim: "#e85d75" },
  { id: "gold",   name: "Gold Pack",   emoji: "✨", price: 260, equipped: true,  body: "#2a220a", trim: "#ffd166" },
  { id: "none",   name: "Return Pack", emoji: "🚫", price: 0,   equipped: false, body: "#000000", trim: "#000000" },
];

/** Everything, by kind — the shop iterates this rather than three arrays. */
export const CATALOG: Record<CosmeticKind, CosmeticItem[]> = {
  hat: HAT_ITEMS,
  flame: FLAME_ITEMS,
  jetpack: JETPACK_ITEMS,
};

export const itemOf = (kind: CosmeticKind, id: string): CosmeticItem | undefined =>
  CATALOG[kind]?.find((i) => i.id === id);

export const priceOf = (kind: CosmeticKind, id: string): number => itemOf(kind, id)?.price ?? 0;
