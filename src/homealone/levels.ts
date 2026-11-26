/**
 * What there is to play.
 *
 * The game is the **nights**: lay traps, let them in, watch what happens, see
 * what it scored. Night `n` is level `n`, and they go on for as long as
 * somebody wants (see `nights.ts`).
 *
 * Around that sit three things that are not nights:
 *
 *   SANDBOX   every trap, no budget, and a button that sends another one in.
 *             Half the people who open a link like this want to try the
 *             springboard without reading a brief first.
 *   EXPLORE   the house with nobody in it. A walk round, and the tutorial for
 *             the stairs, without anybody calling it a tutorial.
 *   LIGHTS    a van going up and down the street, and a house that has to look
 *             occupied before it has seen enough.
 */
import { FLOOR, type RoomId } from "./house";
import { NIGHT_COUNT, nightDef, type NightDef } from "./nights";

export type LevelKind = "night" | "roam" | "explore" | "lights";

/** Level numbers for the things that are not nights. */
export const ROAM = 100;
export const EXPLORE = 101;
export const LIGHTS = 102;

export interface Beacon {
  id: string;
  /** What the compass says you are looking for. */
  label: string;
  /** The line the kid says when you get there. */
  line: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  room: RoomId;
}

export interface Level {
  n: number;
  kind: LevelKind;
  title: string;
  /** Two or three lines of brief, shown before it starts. */
  brief: string[];
  /** The one-line objective the HUD carries the whole time. */
  goal: string;
  /** Where you start, and which way you face. */
  spawn: { x: number; y: number; z: number; yaw: number };
  /** Seconds on the clock, if it has one. */
  time?: number;
  /** Which rooms are lit when it starts. `"all"`, `"none"`, or a list. */
  lit: "all" | "none" | RoomId[];
  beacons?: Beacon[];
  /** LIGHTS: rooms whose windows the van can see. */
  streetRooms?: RoomId[];
  /** Nights only: who is coming and what you have to work with. */
  night?: NightDef;
}

const U = FLOOR.upper;
const G = FLOOR.ground;

const SPECIALS: Level[] = [
  {
    n: ROAM,
    kind: "roam",
    title: "The Sandbox",
    brief: [
      "Every trap in the box and no budget. Nobody comes unless you ask.",
      "Lay something silly, then send one in and see what it does.",
    ],
    goal: "Lay anything. Send one in when you are ready",
    spawn: { x: 0.4, y: G, z: 3.0, yaw: 0 },
    lit: "all",
  },
  {
    n: EXPLORE,
    kind: "explore",
    title: "The Quiet House",
    brief: [
      "Everybody is out until Sunday and the whole house is yours.",
      "Have a look round before anybody else does.",
    ],
    goal: "Check every floor for anybody at all",
    spawn: { x: 0.2, y: U, z: 4.2, yaw: Math.PI },
    lit: "all",
    beacons: [
      {
        id: "parents", label: "Mom & Dad's room", room: "parents",
        line: "Hello? … The bed's made. They never make the bed.",
        x: 4.6, y: U, z: 3.2, radius: 1.7,
      },
      {
        id: "brother", label: "Otis's room", room: "brother",
        line: "Otis? … He left his door open. He NEVER leaves his door open.",
        x: 4.4, y: U, z: -3.4, radius: 1.7,
      },
      {
        id: "kitchen", label: "the kitchen", room: "kitchen",
        line: "Six bowls in the sink and nobody to blame for them.",
        x: 2.0, y: G, z: -3.1, radius: 1.9,
      },
      {
        id: "hall", label: "the front door", room: "hall",
        line: "The car's gone. They actually went without me.",
        x: 0.4, y: G, z: 4.6, radius: 1.6,
      },
      {
        id: "basement", label: "the basement", room: "basement",
        line: "It's a boiler. It makes that noise. It has always made that noise.",
        x: -2.4, y: FLOOR.basement, z: -2.4, radius: 2.0,
      },
    ],
  },
  {
    n: LIGHTS,
    kind: "lights",
    title: "Somebody's Home",
    brief: [
      "There is a grey van going up and down the street, slowly.",
      "A house that looks empty gets a visit. Light this one up:",
      "every room they can see from the road, before they have seen enough.",
    ],
    goal: "Switch on every room the street can see",
    spawn: { x: 0.4, y: G, z: 3.0, yaw: 0 },
    time: 150,
    lit: ["hall"],
    streetRooms: ["hall", "living", "den", "kid", "parents", "bathroom", "stairbay"],
  },
];

function nightLevel(n: number): Level {
  const def = nightDef(n);
  return {
    n: def.night,
    kind: "night",
    title: def.title,
    brief: def.brief,
    goal: "Lay your traps. They want the valuables, and each leaves by his own door",
    // In the hall, facing the front door, because that is where the first of
    // them is about to come through and it is the first thing worth knowing.
    spawn: { x: 0.4, y: G, z: 2.4, yaw: 0 },
    lit: ["hall", "living", "kitchen", "dining", "corridor"],
    night: def,
  };
}

/** The menu's list: the written nights, then the three extras. */
export const LEVELS: Level[] = [
  ...Array.from({ length: NIGHT_COUNT }, (_, i) => nightLevel(i + 1)),
  ...SPECIALS,
];

export function levelByNumber(n: number): Level {
  const special = SPECIALS.find((l) => l.n === n);
  if (special) return special;
  return nightLevel(Math.min(Math.max(1, Math.floor(n) || 1), 99));
}

/**
 * The kid talks to himself, constantly. One line at a time, on a timer, in
 * whatever room you are in, and only on the quiet levels: during a break-in
 * he has other things to say.
 */
export const ROOM_LINES: Partial<Record<RoomId, string[]>> = {
  living: [
    "A tree, and no one to look at it.",
    "Shoes on the rug. Nobody here to stop me.",
    "I could open one. Just one.",
  ],
  kitchen: ["Cereal for dinner. Who's going to say no?", "The fridge is all mine."],
  basement: ["I'm not scared. I'm not scared.", "It's a boiler. Boilers can't look at you."],
  parents: ["The suitcases are gone. All of them."],
  brother: ["Otis's room. Otis's rules. Otis isn't here.", "It smells like socks in here."],
  kid: ["My room. My house, for now."],
  bathroom: ["Dad's aftershave. …Nope. Never again."],
  den: ["Dad's desk. Nobody says I can't."],
  guest: ["Nobody's slept in here since Grandma."],
  corridor: ["Six people lived here yesterday."],
  hall: ["My house. My rules.", "Lock's on. Chain's on. Good."],
  dining: ["Six chairs. One kid."],
  family: ["The TV's still warm."],
  backhall: ["The laundry chute goes all the way down."],
  stairbay: ["Everybody always runs down these."],
  midhall: ["Quiet. Really quiet."],
};
