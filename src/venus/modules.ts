/**
 * Everything you can bolt onto a cloud city.
 *
 * Every module has two numbers that matter more than its cost: `mass` and
 * `lift`. Lift is quoted in tonnes *at the design altitude* (54.5 km); the sim
 * scales it by the local air density, so a city that is too heavy sinks until
 * the thicker, hotter air below holds it up. Whether you can live at that
 * altitude is the game.
 *
 * Anything full of breathable air is a balloon here, which is why the domes
 * people live in are also what keeps them up.
 */

export type ModuleId =
  | "core"
  | "dome"
  | "bladder"
  | "solar"
  | "harvester"
  | "still"
  | "moxie"
  | "greenhouse"
  | "biolab"
  | "nanofab"
  | "jazz"
  | "ballroom"
  | "skyport";

export type ResourceId = "carbon" | "water" | "air" | "power" | "science" | "culture";

export interface ModuleDef {
  id: ModuleId;
  name: string;
  /** One line, shown on the build card. */
  line: string;
  /** Longer, shown when selected. Mostly facts, some jokes. */
  detail: string;
  icon: string;
  cost: Partial<Record<ResourceId, number>>;
  /** tonnes */
  mass: number;
  /** tonnes of lift at the design altitude */
  lift: number;
  housing?: number;
  /** Feeds this many people. */
  food?: number;
  /** Per second. Power here is sustained draw (negative) or supply. */
  power?: number;
  /** Solar: scaled by daylight. */
  solar?: number;
  battery?: number;
  waterCap?: number;
  makes?: Partial<Record<ResourceId, number>>;
  /** Consumes per second (besides power). */
  uses?: Partial<Record<ResourceId, number>>;
  /** Multiplies arrivals. */
  arrivals?: number;
  /** Chance per game-second that something gets out of hand. */
  risk?: number;
  /** Population needed before it can be built. */
  unlockPop?: number;
  /** Not in the build bar. */
  hidden?: boolean;
  /** Accent for the card and the module's own lights. */
  color: string;
}

export const MODULES: Record<ModuleId, ModuleDef> = {
  core: {
    id: "core",
    name: "Keel Spire",
    line: "Where the founders came in.",
    detail:
      "The seed: a carbon-fibre keel, a spire, a folded envelope and twelve people. Everything else grows out from here.",
    icon: "🗼",
    cost: {},
    mass: 300,
    lift: 360,
    housing: 12,
    food: 30,
    power: 3,
    battery: 140,
    waterCap: 60,
    makes: { water: 0.15 },
    hidden: true,
    color: "#ffd9a0",
  },
  dome: {
    id: "dome",
    name: "Air Dome",
    line: "Home for 60, and it floats.",
    detail:
      "Breathable air is a lifting gas on Venus: 29 g/mol inside, 44 outside. So the house is the balloon. Sixty people, a park, and 110 t of lift.",
    icon: "🫧",
    cost: { carbon: 45, air: 30 },
    mass: 70,
    lift: 110,
    housing: 60,
    power: -0.5,
    color: "#9fe8ff",
  },
  bladder: {
    id: "bladder",
    name: "Lift Bladder",
    line: "Cheap lift. Nobody lives in it.",
    detail:
      "A bag of air on a tether. Eight tonnes of fabric holding up ninety. Build one next to anything heavy.",
    icon: "🎈",
    cost: { carbon: 15, air: 25 },
    mass: 8,
    lift: 90,
    color: "#ffe9c2",
  },
  solar: {
    id: "solar",
    name: "Solar Canopy",
    line: "Twice Earth's sunlight. Dark at night.",
    detail:
      "Venus is 0.72 AU from the Sun, so the light up here is nearly twice as strong as Earth's, and the clouds scatter it from every direction. It still sets.",
    icon: "🔆",
    cost: { carbon: 25 },
    mass: 28,
    lift: 0,
    solar: 5,
    battery: 80,
    color: "#ffd35a",
  },
  harvester: {
    id: "harvester",
    name: "Carbon Harvester",
    line: "Pulls building material out of the sky.",
    detail:
      "The atmosphere is 96% carbon dioxide. Split it and the carbon becomes fibre, which becomes more city. Heavy.",
    icon: "🌀",
    cost: { carbon: 20 },
    mass: 85,
    lift: 0,
    power: -2,
    makes: { carbon: 1.0 },
    color: "#c9a27a",
  },
  still: {
    id: "still",
    name: "Acid Still",
    line: "Water for people and greenhouses.",
    detail:
      "The clouds are sulfuric acid droplets. Crack them and you get water and sulfur. Water is also ballast: it weighs a tonne a unit.",
    icon: "💧",
    cost: { carbon: 30 },
    mass: 60,
    lift: 0,
    power: -1.5,
    waterCap: 40,
    makes: { water: 0.6 },
    color: "#7fd6ff",
  },
  moxie: {
    id: "moxie",
    name: "MOXIE Plant",
    line: "CO₂ in, breathable air out.",
    detail:
      "Named after the oxygen experiment that ran on Mars. It works better here: the feedstock is thicker than Mars's entire atmosphere.",
    icon: "🫁",
    cost: { carbon: 35 },
    mass: 55,
    lift: 0,
    power: -2,
    makes: { air: 0.7 },
    color: "#8fffd0",
  },
  greenhouse: {
    id: "greenhouse",
    name: "Greenhouse",
    line: "Feeds 90. Freezes above 60 km.",
    detail:
      "Plants love 0.9 g, carbon dioxide and a lot of light, which is exactly what is on offer. Also full of air, so it floats a little.",
    icon: "🌿",
    cost: { carbon: 35, air: 15 },
    mass: 45,
    lift: 40,
    food: 90,
    power: -1,
    uses: { water: 0.12 },
    color: "#9dff7a",
  },
  biolab: {
    id: "biolab",
    name: "Biolab",
    line: "Science, fast. Occasionally alive.",
    detail:
      "The best place in the solar system to do something reckless with biology: if it gets out of hand, cut it loose. The surface is 462 °C. The planet cleans up.",
    icon: "🧬",
    cost: { carbon: 50 },
    mass: 50,
    lift: 0,
    power: -2.5,
    makes: { science: 0.5 },
    risk: 0.0035,
    color: "#ff7ad9",
  },
  nanofab: {
    id: "nanofab",
    name: "Nanofab",
    line: "Carbon, very fast. Has opinions.",
    detail:
      "Self-assembling carbon from the air, at three times a harvester's rate. Also the reason there is a big red button next to its tether.",
    icon: "⚙️",
    cost: { carbon: 60, science: 30 },
    mass: 90,
    lift: 0,
    power: -3,
    makes: { carbon: 2.6 },
    risk: 0.003,
    color: "#b58cff",
  },
  jazz: {
    id: "jazz",
    name: "Jazz Club",
    line: "Culture. Improvised, so it lasts.",
    detail:
      "An AI can play better jazz guitar than you. It cannot play *this* set, tonight, with these people. Improv is the one art that does not care.",
    icon: "🎷",
    cost: { carbon: 30 },
    mass: 40,
    lift: 0,
    power: -0.8,
    makes: { culture: 0.15 },
    color: "#ff9a5a",
  },
  ballroom: {
    id: "ballroom",
    name: "Habsburg Ballroom",
    line: "Status by character, not by money.",
    detail:
      "Once a season the whole city goes in character as the Habsburg court for a month. On Venus nobody is rich, so status is how good your Maria Theresa is.",
    icon: "👑",
    cost: { carbon: 90, science: 20 },
    mass: 130,
    lift: 0,
    power: -1.5,
    makes: { culture: 0.45 },
    unlockPop: 150,
    color: "#f7c12e",
  },
  skyport: {
    id: "skyport",
    name: "Skyport",
    line: "Triples arrivals from Earth, Moon and Mars.",
    detail:
      "Where the mass-driver capsules come in. Earth is downhill from here in reverse: falling sunward toward Venus is cheap, which is why the capsules keep coming.",
    icon: "🛬",
    cost: { carbon: 60 },
    mass: 95,
    lift: 0,
    power: -1.5,
    arrivals: 3,
    unlockPop: 60,
    color: "#ffffff",
  },
};

export const BUILDABLE: ModuleId[] = [
  "dome",
  "bladder",
  "solar",
  "harvester",
  "still",
  "moxie",
  "greenhouse",
  "biolab",
  "jazz",
  "skyport",
  "nanofab",
  "ballroom",
];

/* ------------------------------------------------------------ the hex grid */

/**
 * Centre-to-corner of one hex, in metres. Neighbouring centres are
 * SLOT·√3 ≈ 42 m apart, and the plates touch, so the city reads as one deck.
 */
export const SLOT = 24;
export const MAX_RING = 5;

export interface Hex { q: number; r: number }

export const hexKey = (q: number, r: number) => `${q},${r}`;

export function hexToWorld(q: number, r: number): { x: number; z: number } {
  return { x: SLOT * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r), z: SLOT * 1.5 * r };
}

export function hexRing(q: number, r: number): number {
  return (Math.abs(q) + Math.abs(r) + Math.abs(-q - r)) / 2;
}

const DIRS: Hex[] = [
  { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
  { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 },
];

export function neighbours(q: number, r: number): Hex[] {
  return DIRS.map((d) => ({ q: q + d.q, r: r + d.r }));
}

/** Every slot the city could ever have, centre first, ring by ring. */
export const ALL_SLOTS: Hex[] = (() => {
  const out: Hex[] = [];
  for (let q = -MAX_RING; q <= MAX_RING; q++) {
    for (let r = -MAX_RING; r <= MAX_RING; r++) {
      if (hexRing(q, r) <= MAX_RING) out.push({ q, r });
    }
  }
  out.sort((a, b) => hexRing(a.q, a.r) - hexRing(b.q, b.r) || Math.atan2(a.r, a.q) - Math.atan2(b.r, b.q));
  return out;
})();
