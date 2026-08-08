/**
 * Who else is in the dish.
 *
 * The names matter more than they look like they should. A leaderboard full of
 * `Bot 14` reads as a benchmark; a leaderboard with SNACKFE and Jerry on it
 * reads as a place, and when the thing that eats you has a name you recognise
 * from another world, losing is funnier. They are drawn from the rest of the
 * vibeverse on purpose — the island's cafe, the ship, the kart grid, the
 * characters people have already met.
 */
export const BOT_NAMES: readonly string[] = [
  "Vibey",
  "Jerry",
  "SNACKFE",
  "Unit-7",
  "Blorp",
  "Nibbles",
  "Cosmo",
  "Mitosis",
  "Agar Smith",
  "The Ooze",
  "Pipette",
  "Petri",
  "Plasmo",
  "Squish",
  "Bubbly",
  "Gloop",
  "Amoeba Lisa",
  "Wobbler",
  "Big Gulp",
  "Pseudopod",
  "Zoop",
  "Chomp",
  "Kartle",
  "Hydro",
  "Seafair",
  "Rainier",
  "Redline",
  "Mister Fizz",
  "Cell Phone",
  "Yeet",
  "Slorp",
  "Vacuole",
  "Flagella",
  "Cytoplasm",
  "Osmosis Jones",
  "Bloop",
  "Dot Matrix",
  "Grommet",
  "Puddle",
  "Tapioca",
  "Boba",
  "Marshmallow",
  "Meringue",
  "Custard",
  "Jellybean",
  "Nucleus",
  "Ribosome",
  "Golgi",
  "Mitochondria",
  "Paramecium",
];

/**
 * The default name for whoever is playing.
 *
 * Not "Player": the whole point of the genre is watching a name climb a
 * leaderboard, and a name you did not choose is a name you do not care about.
 * The page lets you change it and remembers what you picked.
 */
export const DEFAULT_NAME = "you";

/** Names the leaderboard should never show twice. */
export function pickNames(count: number, rnd: () => number): string[] {
  const pool = [...BOT_NAMES];
  // Fisher–Yates, so a short roster is not always the first N of the list.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    // More bots than names is a legal setting, so wrap with a suffix rather
    // than handing two blobs the same label.
    out.push(i < pool.length ? pool[i] : `${pool[i % pool.length]} ${Math.floor(i / pool.length) + 1}`);
  }
  return out;
}

/**
 * Hues, spread around the wheel and skipping the greens.
 *
 * Green belongs to the viruses. A player wearing virus green is a player who
 * gets eaten because they misread their own blob for cover, which is a bad way
 * to lose and an easy thing to design out.
 */
export function hueFor(index: number, total: number): number {
  // 70°–170° is the virus band, so the usable wheel is 260° with a hole in it.
  const t = (index / Math.max(1, total)) * 260;
  return t < 70 ? t : t + 100;
}
