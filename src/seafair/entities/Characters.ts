/**
 * The three playable bodies. Each has a distinct movement feel, silhouette,
 * viewmodel treatment and rendering cost, so players can pick on fun OR on
 * performance.
 */

export interface CharacterMeta {
  id: "spartan" | "street" | "toon";
  name: string;
  callsign: string;
  tagline: string;
  blurb: string;
  /** relative GPU cost, 1 = cheapest */
  cost: 1 | 2 | 3;
  perfNote: string;
  /** primary + secondary armour colours, used by the viewmodel + portal aura */
  colors: [string, string, string];
  stats: { speed: number; armor: number; agility: number; firepower: number };
  loadout: [string, string];
}

export const CHARACTERS: CharacterMeta[] = [
  {
    id: "spartan",
    name: "SPARTAN-B117",
    callsign: "SIERRA",
    tagline: "Classic. Heavy. Unkillable.",
    blurb:
      "MJOLNIR-pattern powered assault armour. Energy shielding recharges fast, mass carries you through crowds, and the jump is genuinely absurd for something this heavy.",
    cost: 3,
    perfNote: "Highest fidelity — layered metal, real-time shield shader",
    colors: ["#3f6b4e", "#c9a227", "#6cc7ff"],
    stats: { speed: 62, armor: 95, agility: 55, firepower: 85 },
    loadout: ["ar", "br"],
  },
  {
    id: "street",
    name: "RAINIER RUNNER",
    callsign: "DUCE",
    tagline: "No armour. All attitude.",
    blurb:
      "Bomber jacket, kevlar underlayer, borrowed rifle. Fastest on foot with the tightest air control — you trade shields for the ability to simply not be there.",
    cost: 2,
    perfNote: "Balanced — cloth shading, mid-poly",
    colors: ["#1e2b3a", "#d8552f", "#e8c07d"],
    stats: { speed: 88, armor: 45, agility: 92, firepower: 70 },
    loadout: ["ar", "sniper"],
  },
  {
    id: "toon",
    name: "SALMON BOY",
    callsign: "CHINOOK",
    tagline: "Physics are a suggestion.",
    blurb:
      "Big head, bigger jump, squash-and-stretch on every landing. Cel-shaded and cheap to draw, so it runs great on phones — and it is very funny to play.",
    cost: 1,
    perfNote: "Fastest — flat shading, no post-heavy effects",
    colors: ["#ff7a3d", "#3dd6ff", "#ffe14a"],
    stats: { speed: 95, armor: 60, agility: 98, firepower: 62 },
    loadout: ["plasma", "rocket"],
  },
];

export const getCharacter = (id: string): CharacterMeta =>
  CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
