/**
 * The ten people who live in Vibe City's streets.
 *
 * Each has a body from the roster, a place they hang out, and a routine: a
 * loop of spots to walk (or jog) to and how long to linger at each. Walk up
 * to one and press T (or tap Talk) and they will chat, through a small AI in
 * `supabase/functions/folk-chat`, which holds their personalities. The lines
 * here are what they say when that is out of reach, so talking always works.
 *
 * Coordinates are world metres. The plaza is the block at the origin; the
 * streets run down x and z = ±20, ±60, ±100, ±140; a sidewalk is about 12.8 m
 * from a block's centre. Keep routes on sidewalks, the plaza or the beach.
 */
export interface FolkStep {
  to: [number, number];
  /** Seconds to linger on arrival. */
  wait?: number;
  /** Emoji to pop while lingering. */
  emote?: string;
}

export interface FolkDef {
  id: string;
  name: string;
  /** Roster character id, see src/lib/characters.ts. */
  char: string;
  /** One line under the name in the chat panel. */
  role: string;
  /** Height of the ground they walk on. */
  y: number;
  /** m/s. */
  speed: number;
  /** Lines when the AI is unreachable, picked in order then at random. */
  lines: string[];
  routine: FolkStep[];
}

const S = 0.15; // sidewalk and plaza top

/** Corners of a block's sidewalk loop, clockwise from the north-west. */
const loop = (cx: number, cz: number, inset = 12.8): FolkStep[] => [
  { to: [cx - inset, cz - inset] },
  { to: [cx + inset, cz - inset] },
  { to: [cx + inset, cz + inset] },
  { to: [cx - inset, cz + inset] },
];

export const FOLK: FolkDef[] = [
  {
    id: "rosa",
    name: "Rosa",
    char: "tabby",
    role: "Runs the hot dog stand on the plaza",
    y: S,
    speed: 1.2,
    lines: [
      "Hot dogs! Best on the plaza, only one on the plaza, so also best.",
      "You look hungry. You look like someone who drives cars into the sea.",
      "My secret is the mustard. And the relish. And I sing to the buns.",
    ],
    routine: [
      { to: [9, 9], wait: 14, emote: "🌭" },
      { to: [11, 6], wait: 4 },
      { to: [9, 9], wait: 18, emote: "🎵" },
    ],
  },
  {
    id: "dex",
    name: "Dex",
    char: "bolt",
    role: "Skater, always mid-lap",
    y: S,
    speed: 3.4,
    lines: [
      "Yo! Three laps of the plaza block before lunch, that's the rule.",
      "Somebody parked a monster truck in my line again.",
      "If you see a rail, tell me. This city needs more rails.",
    ],
    routine: loop(0, 0),
  },
  {
    id: "marisol",
    name: "Marisol",
    char: "sprout",
    role: "Paints the skyline every evening",
    y: S,
    speed: 1.1,
    lines: [
      "Hold still, you're in my painting now.",
      "Come back at sunset. The towers go copper and I run out of orange.",
      "On a rainy night the street is a second sky. I paint that one too.",
    ],
    routine: [
      { to: [-9, -10], wait: 25, emote: "🎨" },
      { to: [-4, -11], wait: 6 },
      { to: [-9, -10], wait: 25, emote: "🖌️" },
    ],
  },
  {
    id: "lou",
    name: "Lou",
    char: "elder",
    role: "Feeds the plaza pigeons, knows them all by name",
    y: S,
    speed: 0.8,
    lines: [
      "That one's Gerald. He's the bossy one.",
      "Walk slow round the birds, they spook. Like my nephew.",
      "Forty years on this plaza. Used to be a parking lot, you know.",
    ],
    routine: [
      { to: [2, -5], wait: 20, emote: "🐦" },
      { to: [-3, -2], wait: 15, emote: "🍞" },
      { to: [4, 1], wait: 15 },
    ],
  },
  {
    id: "priya",
    name: "Priya",
    char: "strider",
    role: "Training for the Vibe City marathon",
    y: S,
    speed: 3.8,
    lines: [
      "Can't stop, heart rate zone two!",
      "Lap of the downtown blocks is two kilometres. I checked. Twice.",
      "The Eiffel Tower stairs are leg day.",
    ],
    routine: [
      { to: [-12.8, -52.8] },
      { to: [12.8, -52.8] },
      { to: [12.8, 52.8], wait: 3, emote: "💦" },
      { to: [-12.8, 52.8] },
    ],
  },
  {
    id: "kenji",
    name: "Kenji",
    char: "pixel",
    role: "Plays guitar on the corner for tips",
    y: S,
    speed: 1.2,
    lines: [
      "This next one's for you. It's about a guy whose car fell off a pier.",
      "Tips go in the hat. Vibes also accepted.",
      "I know four chords and all of them are emotional.",
    ],
    routine: [
      { to: [27.2, -27.2], wait: 40, emote: "🎸" },
      { to: [27.2, -20.5], wait: 5 },
      { to: [27.2, -27.2], wait: 40, emote: "🎶" },
    ],
  },
  {
    id: "zara",
    name: "Zara",
    char: "pip",
    role: "A tourist seeing every landmark in one day",
    y: S,
    speed: 1.5,
    lines: [
      "Is this the Empire State or the Space Needle? I've done both and I'm confused.",
      "I came for the Eiffel Tower, stayed for the hot dogs.",
      "Can you take my picture? No? That's fine. I'll ask a pigeon.",
    ],
    routine: [
      { to: [-27.2, -52.8], wait: 10, emote: "📸" },
      { to: [-27.2, -27.2] },
      { to: [27.2, -27.2] },
      { to: [52.8, -27.2], wait: 10, emote: "📸" },
      { to: [52.8, 27.2] },
      { to: [12.8, 52.8], wait: 10, emote: "😍" },
      { to: [-12.8, 12.8] },
    ],
  },
  {
    id: "benny",
    name: "Benny",
    char: "eddie",
    role: "Sells the Vibe Times on the corner",
    y: S,
    speed: 1.0,
    lines: [
      "Extra, extra! Local pilot crashes jetpack into own house!",
      "Paper's free. The gossip costs extra.",
      "Word is there's an island out in the bay nobody's supposed to go to.",
    ],
    routine: [
      { to: [-27.2, 27.2], wait: 22, emote: "📰" },
      { to: [-20.5, 27.2], wait: 6 },
      { to: [-27.2, 27.2], wait: 22, emote: "🗞️" },
    ],
  },
  {
    id: "gus",
    name: "Old Gus",
    char: "barnacle",
    role: "Retired sailor, sits on the beach telling stories",
    y: 0.2,
    speed: 0.7,
    lines: [
      "Seen a lot from this beach, kid. Seen a kart sink with the radio still on.",
      "Out past the marina the water goes deep and cold. Respect it.",
      "Sun goes down right there over the Pacific. Never gets old.",
    ],
    routine: [
      { to: [-190, 36], wait: 45, emote: "⚓" },
      { to: [-186, 30], wait: 8 },
      { to: [-190, 36], wait: 45, emote: "🌊" },
    ],
  },
  {
    id: "juno",
    name: "Juno",
    char: "aurora",
    role: "Astronomer, waits for the aurora",
    y: 0.2,
    speed: 1.0,
    lines: [
      "Switch the sky to Aurora and look north. Trust me.",
      "Those green curtains are oxygen glowing a hundred kilometres up.",
      "Best view's from the beach, away from the neon.",
    ],
    routine: [
      { to: [-188, -18], wait: 30, emote: "🔭" },
      { to: [-192, -8], wait: 20, emote: "✨" },
    ],
  },
];
