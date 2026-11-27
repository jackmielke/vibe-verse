/**
 * The weapons counter: what Vibe City's guns cost, and nothing else.
 *
 * Bought with Vibey Coins through the same `buy_cosmetic` action as a hat, so
 * a weapon is a row in `vibe_inventory` (`weapon:glock`) like everything else
 * you own, and it is yours on every device. Once bought it never runs out:
 * there is no ammo, no fuel, no reload. The price is the only gate.
 *
 * Like `cosmeticCatalog.ts`, this is the shelf label. The authority is the
 * `weapon` group of `COSMETICS` in `supabase/functions/vibe-economy`, and
 * `src/test/wardrobe.test.ts` checks the two agree.
 *
 * The rooftop rifle is not here on purpose. It is a find, not a purchase:
 * glinting on a roof in the middle of town, and you need the jetpack.
 */
export type WeaponId = "water" | "glock" | "pineapple" | "blaster";

export interface WeaponItem {
  id: WeaponId;
  name: string;
  emoji: string;
  price: number;
  /** One line for the shelf: what it is for. */
  blurb: string;
  /** Card accent. */
  color: string;
}

export const WEAPON_ITEMS: WeaponItem[] = [
  {
    id: "water",
    name: "Super Soaker",
    emoji: "💦",
    price: 60,
    blurb: "Barely scratches the paint. About one shot in three leaves a puddle, and anything that runs into it slips and spins out.",
    color: "#5ec8ff",
  },
  {
    id: "glock",
    name: "Glock 19",
    emoji: "🔫",
    price: 150,
    blurb: "The plain one. Normal damage at a steady, even rate.",
    color: "#c9d1db",
  },
  {
    id: "pineapple",
    name: "Pineapple Bombs · pack of 3",
    emoji: "🍍",
    price: 250,
    blurb: "Throw with X. Sticks to anything that moves and hurts it until it pops. Three at a time, they grow back.",
    color: "#ffd23f",
  },
  {
    id: "blaster",
    name: "Nova Blaster",
    emoji: "☄️",
    price: 500,
    blurb: "A space blaster that fires bolts as fast as you can hold the trigger.",
    color: "#ff5a4e",
  },
];

export const weaponItem = (id: string): WeaponItem | undefined => WEAPON_ITEMS.find((w) => w.id === id);

/** The weapon ids in an owned-keys list (`weapon:glock` and so on). */
export function ownedWeapons(ownedKeys: readonly string[]): WeaponId[] {
  const out: WeaponId[] = [];
  for (const w of WEAPON_ITEMS) if (ownedKeys.includes(`weapon:${w.id}`)) out.push(w.id);
  return out;
}
