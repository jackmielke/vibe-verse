/**
 * The nights: who comes, through which door, after what.
 *
 * Pure data and pure functions, like `kit.ts`, and for the same reason: the
 * interesting questions ("is night four winnable with twenty parts?") should be
 * answerable without a renderer.
 *
 * Two things here turn laying traps from decoration into a plan.
 *
 * **They want something, and you know what.** Every intruder walks to a
 * valuable, picks it up and carries it out of the door he came in by. So a
 * night is a set of routes you can read before it starts, and a trap is a bet
 * about a route. Without that they only ever chase you, and the only place a
 * trap is any use is wherever you happen to be standing.
 *
 * **They are not all the same.** One of them looks where she is walking and
 * takes your traps apart, unless the room is dark or she is busy chasing you.
 * One is too heavy to throw far. One is quick and scares easily. Each is a
 * reason to lay a different thing in a different place.
 */
import type { KitKind } from "./kit";

export type Rig = "gus" | "lenny";
export type Entry = "front" | "back";

export interface IntruderKind {
  id: string;
  name: string;
  rig: Rig;
  /** One line on the brief card. */
  trait: string;
  nerve: number;
  /** Multiplier on the rig's walk and run speed. */
  speed: number;
  /** Size multiplier on the rig. */
  scale: number;
  /** Coat colour, so five people in a dark hall are five people. */
  coat: string;
  /** Spots laid traps in lit rooms and takes them apart. */
  careful: boolean;
  /** Thrown half as far. */
  heavy: boolean;
}

export const INTRUDERS: Record<string, IntruderKind> = {
  gus: {
    id: "gus", name: "Gus", rig: "gus", trait: "The one with the plan. Nothing special, and that is the problem.",
    nerve: 100, speed: 1, scale: 1, coat: "#3c5a44", careful: false, heavy: false,
  },
  lenny: {
    id: "lenny", name: "Lenny", rig: "lenny", trait: "All legs. Covers a corridor before you have turned round.",
    nerve: 90, speed: 1.06, scale: 1, coat: "#7a3f2a", careful: false, heavy: false,
  },
  skeeter: {
    id: "skeeter", name: "Skeeter", rig: "lenny", trait: "Fast and jumpy. Two good frights and he is gone.",
    nerve: 60, speed: 1.22, scale: 0.9, coat: "#2f5f7a", careful: false, heavy: false,
  },
  nell: {
    id: "nell", name: "Nell", rig: "lenny", trait: "Watches her feet. Takes traps apart if the lights are on.",
    nerve: 90, speed: 0.98, scale: 0.88, coat: "#5d3f78", careful: true, heavy: false,
  },
  moose: {
    id: "moose", name: "Moose", rig: "gus", trait: "Too big to throw far, and takes a lot of convincing.",
    nerve: 170, speed: 0.86, scale: 1.17, coat: "#4a4a50", careful: false, heavy: true,
  },
};

export interface Arrival {
  who: string;
  entry: Entry;
  /** Seconds after the doors open. */
  at: number;
  /** Set when somebody is coming back for more: the nerve he left with. */
  nerve?: number;
}

export interface NightDef {
  night: number;
  title: string;
  /** Two or three lines for the brief card. */
  brief: string[];
  parts: number;
  /** Seconds to lay traps before anybody arrives. */
  planTime: number;
  arrivals: Arrival[];
  /** How hard they push when they have seen you. */
  aggression: number;
}

const TABLE: NightDef[] = [
  {
    night: 1,
    title: "Two at the Door",
    brief: [
      "Two of them. Gus is coming in the front and Lenny has the back door.",
      "They are after the valuables, and each one leaves the way he came in.",
      "Lay traps where they have to walk. Then make some noise.",
    ],
    parts: 12, planTime: 75, aggression: 0.4,
    arrivals: [
      { who: "gus", entry: "front", at: 0 },
      { who: "lenny", entry: "back", at: 7 },
    ],
  },
  {
    night: 2,
    title: "They Brought a Friend",
    brief: [
      "Three tonight. Skeeter is quick, and he comes in last.",
      "New in the box: the Soap Slick and the Springboard.",
      "A slide that ends on a springboard is worth more than both.",
    ],
    parts: 15, planTime: 80, aggression: 0.5,
    arrivals: [
      { who: "gus", entry: "front", at: 0 },
      { who: "lenny", entry: "back", at: 6 },
      { who: "skeeter", entry: "front", at: 26 },
    ],
  },
  {
    night: 3,
    title: "Lights Out",
    brief: [
      "Nell looks where she walks. A trap in a lit room is a trap she takes apart.",
      "Turn the lights off, or give her something to chase.",
      "New in the box: the Swinging Sack and the Flour Bomb.",
    ],
    parts: 18, planTime: 85, aggression: 0.55,
    arrivals: [
      { who: "nell", entry: "back", at: 0 },
      { who: "gus", entry: "front", at: 5 },
      { who: "lenny", entry: "front", at: 24 },
      { who: "skeeter", entry: "back", at: 40 },
    ],
  },
  {
    night: 4,
    title: "The Big One",
    brief: [
      "Moose comes through the front and he does not fly far.",
      "Stairs do not care how big he is.",
      "Five of them, in two lots. Keep something back for the second.",
    ],
    parts: 22, planTime: 90, aggression: 0.62,
    arrivals: [
      { who: "moose", entry: "front", at: 0 },
      { who: "lenny", entry: "back", at: 4 },
      { who: "nell", entry: "back", at: 22 },
      { who: "gus", entry: "front", at: 38 },
      { who: "skeeter", entry: "front", at: 52 },
    ],
  },
  {
    night: 5,
    title: "The Whole Crew",
    brief: [
      "Everybody, through both doors, and they have stopped being polite.",
      "You know what each of them does by now.",
      "Three stars means nothing leaves the house and something chains.",
    ],
    parts: 26, planTime: 90, aggression: 0.72,
    arrivals: [
      { who: "gus", entry: "front", at: 0 },
      { who: "nell", entry: "back", at: 0 },
      { who: "skeeter", entry: "front", at: 16 },
      { who: "moose", entry: "back", at: 24 },
      { who: "lenny", entry: "front", at: 40 },
      { who: "skeeter", entry: "back", at: 56 },
    ],
  },
];

export const NIGHT_COUNT = TABLE.length;

/**
 * Any night you like. One to five are written by hand; after that it is the
 * whole crew again with one more body, less nerve to spare and a few more
 * parts, for as long as somebody wants to keep going.
 */
export function nightDef(night: number): NightDef {
  const n = Math.max(1, Math.floor(night));
  if (n <= TABLE.length) return TABLE[n - 1];
  const extra = n - TABLE.length;
  const cast = ["skeeter", "lenny", "nell", "moose", "gus"];
  const base = TABLE[TABLE.length - 1];
  const arrivals = base.arrivals.map((a) => ({ ...a }));
  for (let i = 0; i < Math.min(extra, 4); i++) {
    arrivals.push({ who: cast[i % cast.length], entry: i % 2 ? "back" : "front", at: 70 + i * 12 });
  }
  return {
    night: n,
    title: `Night ${n}`,
    brief: [
      `${arrivals.length} of them, and they have done this before.`,
      "Nothing new in the box. Just more of them.",
    ],
    parts: base.parts + Math.min(extra, 6) * 2,
    planTime: 90,
    aggression: Math.min(0.95, base.aggression + extra * 0.05),
    arrivals,
  };
}

/** Everybody on a night's list, once each, in the order they arrive. */
export function castOf(def: NightDef): IntruderKind[] {
  const seen = new Set<string>();
  const out: IntruderKind[] = [];
  for (const a of def.arrivals) {
    if (seen.has(a.who)) continue;
    seen.add(a.who);
    out.push(INTRUDERS[a.who]);
  }
  return out;
}

/** The traps that are new on this night, for the brief card. */
export function newKitOn(night: number, kit: Record<KitKind, { night: number }>): KitKind[] {
  return (Object.keys(kit) as KitKind[]).filter((k) => kit[k].night === night && night > 1);
}

/* ------------------------------------------------------------------ *
 * The valuables
 * ------------------------------------------------------------------ */

export interface LootSpot {
  id: string;
  name: string;
  /** The nav node an intruder walks to in order to take it. */
  node: string;
}

/**
 * Six things worth carrying out, spread over two floors so that both doors and
 * the stairs all matter. Each sits on a nav node, which is by construction a
 * spot somebody can stand on.
 */
export const LOOT: LootSpot[] = [
  { id: "presents", name: "the presents", node: "g_living" },
  { id: "silver", name: "the silver", node: "g_dining" },
  { id: "tv", name: "the television", node: "g_family" },
  { id: "desk", name: "the desk drawer", node: "g_den" },
  { id: "jewels", name: "the jewellery box", node: "u_parents" },
  { id: "piggy", name: "your piggy bank", node: "u_kid" },
];
