/**
 * VIBE HOOPS — the clubs and who plays for them.
 *
 * Every player is somebody who already lives in the Vibe Verse: Vibey, Mad
 * Mort's junkyard crew, the three samurai who guard you in Vibe City, the
 * Palm Court pirates, the code-built cast from the character picker. Nobody
 * here is a stranger and nobody belongs to a real league.
 *
 * A body is one of three kinds, and `bodies.ts` knows how to build each:
 *  - `vibey`, `mort`, `linda`, `hank`, `ray`: built in code (Vibey from
 *    `src/fnaf/vibey.ts`, the crew from Cannon Chase's `buildMort`).
 *  - a roster id from `src/lib/characters.ts`: whatever `loadCharacterRig`
 *    makes of it, file or code.
 *  - `me`: whoever the visitor picked in My Vibe, resolved by the page.
 */

export interface Baller {
  id: string;
  name: string;
  /** What to build: a crew key, a roster id, or "me". */
  body: string;
  /** 1..5, how good from deep. */
  shoot: number;
  /** 1..5, how high and how hard at the rim. */
  dunk: number;
  /** 1..5, quick hands on defence. */
  hands: number;
  num: number;
}

export interface Club {
  id: string;
  name: string;
  short: string;
  emoji: string;
  /** Main colour, second colour, text on the main colour. */
  color: string;
  trim: string;
  ink: string;
  /** Four on the roster, three on the floor. */
  roster: Baller[];
}

const b = (id: string, name: string, body: string, num: number, shoot: number, dunk: number, hands: number): Baller => ({ id, name, body, num, shoot, dunk, hands });

export const CLUBS: Club[] = [
  {
    id: "volts",
    name: "Vibe Island Volts",
    short: "VOLTS",
    emoji: "⚡",
    color: "#22d3ee",
    trim: "#facc15",
    ink: "#05232b",
    roster: [
      b("vibey", "Vibey", "vibey", 1, 4, 3, 4),
      b("flux", "Flux", "flux", 7, 3, 5, 3),
      b("toadstool", "Toadstool", "toadstool", 22, 5, 2, 3),
      b("bolt", "Bolt", "bolt", 33, 2, 4, 4),
    ],
  },
  {
    id: "junkyard",
    name: "Junkyard Dogs",
    short: "JUNKYARD",
    emoji: "🔧",
    color: "#dc2626",
    trim: "#facc15",
    ink: "#fff7d6",
    roster: [
      b("mort", "Mad Mort", "mort", 0, 2, 5, 3),
      b("linda", "Lunatic Linda", "linda", 13, 4, 3, 5),
      b("hank", "Hubcap Hank", "hank", 8, 5, 2, 3),
      b("ray", "Rusty Ray", "ray", 44, 3, 4, 3),
    ],
  },
  {
    id: "ronin",
    name: "Neon Ronin",
    short: "RONIN",
    emoji: "🗡️",
    color: "#f43f5e",
    trim: "#111827",
    ink: "#ffffff",
    roster: [
      b("kenji", "Kenji", "Kimono_Male", 1, 4, 3, 4),
      b("hana", "Hana", "Ninja_Female", 3, 5, 2, 5),
      b("goro", "Goro", "Ninja_Sand", 50, 2, 5, 2),
      b("ninja", "Shadow", "Ninja_Male", 9, 3, 4, 4),
    ],
  },
  {
    id: "pirates",
    name: "Palm Court Pirates",
    short: "PIRATES",
    emoji: "🏴‍☠️",
    color: "#f59e0b",
    trim: "#0f766e",
    ink: "#1f1300",
    roster: [
      b("anne", "Captain Anne", "Pirate_Anne", 5, 5, 2, 4),
      b("barbarossa", "Barbarossa", "Pirate_Captain_Barbarossa", 55, 2, 5, 2),
      b("mako", "Mako", "Pirate_Mako", 11, 3, 4, 4),
      b("henry", "Henry", "Pirate_Henry", 2, 4, 3, 3),
    ],
  },
  {
    id: "wizards",
    name: "Dome Wizards",
    short: "WIZARDS",
    emoji: "🧙",
    color: "#8b5cf6",
    trim: "#a7f3d0",
    ink: "#ffffff",
    roster: [
      b("mage", "The Mage", "Mage", 6, 4, 3, 4),
      b("witch", "Witch", "Witch", 13, 5, 2, 4),
      b("wizard", "Wizard", "Wizard", 77, 3, 4, 3),
      b("elf", "Elf", "Elf", 4, 4, 3, 5),
    ],
  },
  {
    id: "capes",
    name: "Sky Capes",
    short: "CAPES",
    emoji: "🦸",
    color: "#2563eb",
    trim: "#fbbf24",
    ink: "#ffffff",
    roster: [
      b("seraph", "Seraph", "seraph", 10, 4, 4, 3),
      b("voltaic", "Voltaic", "voltaic", 24, 3, 5, 3),
      b("titan", "Titan", "titan", 99, 2, 5, 2),
      b("stinger", "Stinger", "stinger", 12, 5, 2, 5),
    ],
  },
];

export const clubById = (id: string): Club => CLUBS.find((c) => c.id === id) ?? CLUBS[0];

/** You, as the visitor's own character, slotting into any club. */
export const ME_BALLER: Baller = b("me", "You", "me", 23, 4, 4, 4);

/**
 * The three on the floor for a club: the roster's first three, except that
 * `pick` (a roster id, or "me") always plays and takes the first slot it can.
 */
export function lineup(club: Club, pick?: string | null): Baller[] {
  const all = pick === "me" ? [ME_BALLER, ...club.roster] : club.roster;
  if (!pick) return all.slice(0, 3);
  const chosen = all.find((p) => p.id === pick);
  if (!chosen) return all.slice(0, 3);
  return [chosen, ...all.filter((p) => p !== chosen)].slice(0, 3);
}
