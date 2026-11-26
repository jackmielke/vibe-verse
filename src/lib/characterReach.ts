/**
 * Where your character actually goes.
 *
 * "Pick a character and it follows you everywhere" was the promise on three
 * different pages, and it was true of about a sixth of the vibeverse. Most
 * worlds bring their own player; a few keep a separate pick of their own. The
 * profile page says which is which, and this list is what it reads.
 *
 * It was built by reading every world's source for the shared pick
 * (`useActiveCharacter`, `lobby.character`, the royale's `readActiveCharacterId`),
 * so when a world starts or stops reading it, update this too.
 * `src/test/characterReach.test.ts` checks every key still exists.
 */

export type Reach =
  /** Your character, your hat and jetpack, and your stickers. */
  | "full"
  /** Your character, nothing else. */
  | "character"
  /** Your character unless you pick that game's own suit in its Locker. */
  | "locker"
  /** The world remembers a separate pick of its own. */
  | "own";

export interface ReachEntry {
  /** A key in `src/worlds/registry.ts`. */
  key: string;
  reach: Reach;
}

export const CHARACTER_REACH: ReachEntry[] = [
  { key: "island", reach: "full" },
  { key: "city", reach: "full" },
  { key: "ski", reach: "full" },
  { key: "moon", reach: "full" },
  { key: "vibestar", reach: "full" },

  { key: "sf", reach: "character" },
  { key: "frisco", reach: "character" },
  { key: "empyrean", reach: "character" },
  { key: "dipsea", reach: "character" },
  { key: "dunes", reach: "character" },
  { key: "glass-lake", reach: "character" },
  { key: "space", reach: "character" },
  { key: "go", reach: "character" },
  { key: "coil", reach: "character" },
  { key: "lobby", reach: "character" },

  { key: "better-fortnite", reach: "locker" },
  { key: "splash-royale", reach: "locker" },
  { key: "drop-zero", reach: "locker" },

  { key: "oni", reach: "own" },
  { key: "magician", reach: "own" },
  { key: "garden", reach: "own" },
];

export const REACH_LABEL: Record<Reach, { title: string; blurb: string }> = {
  full: {
    title: "Everything you're wearing",
    blurb: "Your character, hat, jetpack, flame and stickers. Other players see all of it.",
  },
  character: {
    title: "Your character",
    blurb: "You show up as who you picked here. Hats and stickers stay behind.",
  },
  locker: {
    title: "Your character, by default",
    blurb: "Unless you pick the game's own suit in its Locker.",
  },
  own: {
    title: "Their own pick",
    blurb: "These worlds remember a separate character. Pick one when you get there.",
  },
};

export const REACH_ORDER: Reach[] = ["full", "character", "locker", "own"];
