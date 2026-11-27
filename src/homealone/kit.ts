/**
 * The trap kit: what you can lay down, and what each thing does to whoever
 * walks into it.
 *
 * This file is pure. No three.js, no engine, no clock of its own. Everything
 * that decides how a trap behaves is a function of plain numbers, so the whole
 * rule set runs in a unit test and the engine's only job is to move bodies
 * where these functions say they go.
 *
 * The one design rule: **a trap moves people.** A trap that only hurts is a
 * landmine, and a house full of landmines is a spreadsheet. A trap that slides
 * a man three metres down a corridor is a question: what is at the end of the
 * corridor? Put a springboard there, aim it at the stairs, and now three cheap
 * things are one expensive thing. That is the game.
 *
 * So every hit resolves to a `throw`: a direction and a distance. The engine
 * carries the body along it, and anything it meets on the way (another trap, a
 * wall, the top of a flight of stairs, a colleague) is the next link.
 */

export type KitKind =
  | "marbles"
  | "tripwire"
  | "honey"
  | "clock"
  | "slick"
  | "spring"
  | "mousetrap"
  | "sack"
  | "flour"
  | "rake";

export type Effect = "slide" | "trip" | "root" | "lure" | "launch" | "swat" | "blind" | "snap" | "bonk";

export interface KitDef {
  kind: KitKind;
  name: string;
  icon: string;
  /** Parts it costs to lay. Picking it back up unspent refunds all of it. */
  cost: number;
  /** One line for the kit bar. */
  blurb: string;
  effect: Effect;
  /** How close somebody has to get. Zero means it never fires on contact. */
  radius: number;
  /** How many times it goes off before it is used up. */
  uses: number;
  /** Seconds before a multi-use trap can go off again. */
  rearm: number;
  /** Throws along the way you were facing when you laid it. */
  directional: boolean;
  /** Too small to be spotted by somebody looking for traps. */
  hidden: boolean;
  /** The first night it is in the box. */
  night: number;
  /** Nerve it takes, before the chain multiplier. */
  damage: number;
  /** Seconds on the floor. */
  stun: number;
  /** Metres it moves the victim. */
  throw: number;
  /** Radius of an area effect (flour), in metres. */
  area: number;
  /** Seconds of the lingering effect (stuck, blinded). */
  linger: number;
  /** Seconds he is slowed to a hobble afterwards (honey on his boots, a trap on his toe). */
  slow: number;
  /** Colour of the ring on the floor, so a laid trap reads in the dark. */
  colour: number;
}

export const KIT: Record<KitKind, KitDef> = {
  marbles: {
    kind: "marbles", name: "Marbles", icon: "🔮", cost: 2,
    blurb: "Slip. He slides 3 m the way he was going.",
    effect: "slide", radius: 0.85, uses: 2, rearm: 2.5, directional: false, hidden: false, night: 1,
    damage: 22, stun: 2.6, throw: 3.2, area: 0, linger: 0, slow: 0, colour: 0x6fd0ff,
  },
  tripwire: {
    kind: "tripwire", name: "Tripwire", icon: "🧵", cost: 1,
    blurb: "Cheap, and nobody ever sees it. Face first.",
    effect: "trip", radius: 0.75, uses: 1, rearm: 0, directional: false, hidden: true, night: 1,
    damage: 18, stun: 2.4, throw: 1.5, area: 0, linger: 0, slow: 0, colour: 0xd8d8e0,
  },
  honey: {
    kind: "honey", name: "Honey Trap", icon: "🍯", cost: 2,
    blurb: "Stuck for 4 s and covered in it, then slow for 8 more. Hit him while he is stuck.",
    effect: "root", radius: 0.8, uses: 1, rearm: 0, directional: false, hidden: false, night: 1,
    damage: 8, stun: 0, throw: 0, area: 0, linger: 4, slow: 8, colour: 0xf2c53d,
  },
  clock: {
    kind: "clock", name: "Alarm Clock", icon: "⏰", cost: 1,
    blurb: "Ring it from anywhere. They come and look.",
    effect: "lure", radius: 0, uses: 3, rearm: 6, directional: false, hidden: true, night: 1,
    damage: 0, stun: 0, throw: 0, area: 18, linger: 0, slow: 0, colour: 0xff7a5a,
  },
  slick: {
    kind: "slick", name: "Soap Slick", icon: "🧼", cost: 3,
    blurb: "A 6 m slide, three times over. The long link in a chain.",
    effect: "slide", radius: 1.0, uses: 3, rearm: 2.0, directional: false, hidden: false, night: 2,
    damage: 14, stun: 2.2, throw: 6.0, area: 0, linger: 0, slow: 0, colour: 0x9af0e0,
  },
  spring: {
    kind: "spring", name: "Springboard", icon: "🛹", cost: 4,
    blurb: "Launches him 6 m the way YOU were facing. Aim it at something.",
    effect: "launch", radius: 0.75, uses: 2, rearm: 2.5, directional: true, hidden: false, night: 2,
    damage: 26, stun: 3.0, throw: 6.0, area: 0, linger: 0, slow: 0, colour: 0xff9a3c,
  },
  mousetrap: {
    kind: "mousetrap", name: "Mousetraps", icon: "🪤", cost: 1,
    blurb: "Snap. He hops about holding his foot, slow for 6 s. Too small to spot.",
    effect: "snap", radius: 0.7, uses: 2, rearm: 1.5, directional: false, hidden: true, night: 2,
    damage: 16, stun: 0, throw: 0, area: 0, linger: 0, slow: 6, colour: 0xc9a26b,
  },
  sack: {
    kind: "sack", name: "Swinging Sack", icon: "🥊", cost: 5,
    blurb: "A sack of potatoes on a rope. Swats him 4.5 m, twice.",
    effect: "swat", radius: 1.1, uses: 2, rearm: 3.0, directional: true, hidden: false, night: 3,
    damage: 34, stun: 3.4, throw: 4.5, area: 0, linger: 0, slow: 0, colour: 0xe06a6a,
  },
  flour: {
    kind: "flour", name: "Flour Bomb", icon: "💨", cost: 3,
    blurb: "Everyone within 2.5 m is blind for 7 s and cannot find you.",
    effect: "blind", radius: 0.9, uses: 1, rearm: 0, directional: false, hidden: false, night: 3,
    damage: 12, stun: 0, throw: 0, area: 2.5, linger: 7, slow: 0, colour: 0xf4f0e6,
  },
  rake: {
    kind: "rake", name: "Garden Rake", icon: "🧹", cost: 2,
    blurb: "He treads on the tines and the handle comes up to meet him. Out cold for 4 s, twice.",
    effect: "bonk", radius: 0.7, uses: 2, rearm: 2.5, directional: false, hidden: false, night: 3,
    damage: 28, stun: 4.0, throw: 0, area: 0, linger: 0, slow: 0, colour: 0x9bd36a,
  },
};

export const KIT_ORDER: KitKind[] = [
  "marbles", "tripwire", "honey", "clock", "slick", "spring", "mousetrap", "sack", "flour", "rake",
];

/** What is in the box on a given night. Night 3 onwards is everything. */
export function kitForNight(night: number): KitKind[] {
  return KIT_ORDER.filter((k) => KIT[k].night <= night);
}

/* ------------------------------------------------------------------ *
 * Laying
 * ------------------------------------------------------------------ */

export interface Placed {
  id: number;
  kind: KitKind;
  x: number;
  y: number;
  z: number;
  /** The way the player was facing. Only directional traps use it. */
  yaw: number;
  usesLeft: number;
  /** Seconds until it can fire again. */
  cool: number;
  /** Counts down from 1 while it is going off, for the animation. */
  firing: number;
  /** Laid on a flight of stairs: how far it leans, about the world X and Z axes. */
  tiltX?: number;
  tiltZ?: number;
}

/** Two traps closer than this are one trap, and nobody can tell which. */
export const MIN_SPACING = 0.9;

export type PlaceProblem = "parts" | "crowded" | "wall" | "air" | "busy" | null;

export const PLACE_PROBLEM_TEXT: Record<Exclude<PlaceProblem, null>, string> = {
  parts: "Not enough parts",
  crowded: "Too close to another trap",
  wall: "Something is in the way",
  air: "Needs a floor",
  busy: "Not with one of them this close",
};

/** Can this go here? Returns what is wrong, or null. */
export function placeProblem(
  kind: KitKind,
  at: { x: number; y: number; z: number },
  placed: ReadonlyArray<Pick<Placed, "x" | "y" | "z">>,
  parts: number,
): PlaceProblem {
  if (KIT[kind].cost > parts) return "parts";
  for (const p of placed) {
    if (Math.abs(p.y - at.y) > 1.2) continue;
    if (Math.hypot(p.x - at.x, p.z - at.z) < MIN_SPACING) return "crowded";
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * What a hit does
 * ------------------------------------------------------------------ */

export interface Victim {
  /** Unit vector of the way he is travelling (or being thrown). */
  hx: number;
  hz: number;
  /** Too big to throw far. */
  heavy: boolean;
  /** Currently stuck in glue. */
  rooted: boolean;
  /** Links already in the chain he is part of. */
  chain: number;
}

export type Trick = "STUCK SHOT" | "WALL SLAM" | "TUMBLE" | "BOWLING" | "BATTERED";

export interface Outcome {
  damage: number;
  stun: number;
  /** Seconds stuck to the floor. */
  root: number;
  /** Seconds unable to see. */
  blind: number;
  /** Seconds slowed to a hobble. */
  slow: number;
  /** Unit direction and distance he is thrown; zero distance is no throw. */
  tx: number;
  tz: number;
  dist: number;
  /** A slide stays on the floor; a flight arcs. Both stop at a wall. */
  mode: "slide" | "fly" | null;
  /** The link this hit is. 1 is a plain hit. */
  chain: number;
  tricks: Trick[];
  score: number;
}

/** A chain is live for this long after its last link. */
export const CHAIN_WINDOW = 4.5;

/** Each further link hits harder: 1, 1.3, 1.6, 1.9, and no more than 2.5. */
export function chainMult(chain: number): number {
  return Math.min(2.5, 1 + 0.3 * Math.max(0, chain - 1));
}

/**
 * Points for one link. Chains are worth far more than their parts, up to six
 * links: three people falling down the same stairs will happily count to
 * fifteen, and an uncapped square makes that one pile-up the whole score.
 */
export function linkScore(chain: number, tricks: number): number {
  const c = Math.min(6, chain);
  return 50 * c * c + 75 * tricks;
}

/** Extra nerve a trick takes, on top of whatever caused it. */
export const TRICK_DAMAGE: Record<Trick, number> = {
  "STUCK SHOT": 0, // paid as a multiplier instead
  "WALL SLAM": 14,
  TUMBLE: 18,
  BOWLING: 14,
  BATTERED: 0, // flour on honey: paid as a longer blind instead
};

export function resolveTrap(def: KitDef, trapYaw: number, v: Victim): Outcome {
  const chain = v.chain + 1;
  const tricks: Trick[] = [];
  let mult = chainMult(chain);
  // Somebody glued to the floor cannot roll with it.
  if (
    v.rooted &&
    (def.effect === "launch" || def.effect === "swat" || def.effect === "slide" || def.effect === "trip" || def.effect === "bonk")
  ) {
    mult *= 1.5;
    tricks.push("STUCK SHOT");
  }

  let tx = 0;
  let tz = 0;
  let dist = 0;
  let mode: Outcome["mode"] = null;
  switch (def.effect) {
    case "slide":
      tx = v.hx; tz = v.hz; dist = def.throw; mode = "slide";
      break;
    case "trip":
      tx = v.hx; tz = v.hz; dist = def.throw; mode = "fly";
      break;
    case "launch":
    case "swat":
      tx = Math.sin(trapYaw); tz = Math.cos(trapYaw); dist = def.throw; mode = "fly";
      break;
    default:
      break;
  }
  if (v.heavy) dist *= 0.5;
  // No heading at all (standing dead still on a slick): nowhere to slide to.
  if (dist > 0 && Math.hypot(tx, tz) < 1e-3) {
    dist = 0;
    mode = null;
  }

  return {
    damage: Math.round(def.damage * mult),
    stun: def.stun,
    root: def.effect === "root" ? def.linger : 0,
    blind: def.effect === "blind" ? def.linger : 0,
    slow: def.slow,
    tx, tz, dist, mode,
    chain,
    tricks,
    score: linkScore(chain, tricks.length),
  };
}

/** A trick lands on somebody already in a chain: a slam, a tumble, a collision. */
export function resolveTrick(trick: Trick, chain: number): { damage: number; chain: number; score: number } {
  const next = chain + 1;
  return {
    damage: Math.round(TRICK_DAMAGE[trick] * chainMult(next)),
    chain: next,
    score: linkScore(next, 1),
  };
}

/* ------------------------------------------------------------------ *
 * The scorecard
 * ------------------------------------------------------------------ */

export interface NightTally {
  lootKept: number;
  lootTotal: number;
  /** Points from hits and chains. */
  points: number;
  /** The longest chain landed. */
  bestChain: number;
  /** Intruders who ran out of nerve and ran. */
  routed: number;
  intruders: number;
  heartsLeft: number;
  partsLeft: number;
}

export interface NightResult {
  won: boolean;
  stars: 0 | 1 | 2 | 3;
  score: number;
  /** One line per star, said plainly, earned or not. */
  lines: Array<{ text: string; earned: boolean }>;
}

export function scoreNight(t: NightTally): NightResult {
  const won = t.heartsLeft > 0 && t.lootKept > 0;
  const all = t.lootKept === t.lootTotal;
  const chained = t.bestChain >= 3;
  const stars = (won ? 1 + (all ? 1 : 0) + (chained ? 1 : 0) : 0) as NightResult["stars"];
  const score = won
    ? t.points + t.lootKept * 150 + t.routed * 200 + t.heartsLeft * 100 + t.partsLeft * 20
    : Math.round(t.points / 2);
  return {
    won,
    stars,
    score,
    lines: [
      { text: "Kept something and stayed out of their hands", earned: won },
      { text: "Nothing left the house", earned: won && all },
      { text: "Landed a chain of three or more", earned: won && chained },
    ],
  };
}
