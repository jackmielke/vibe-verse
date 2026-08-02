/**
 * Five levels, in the order the film puts them.
 *
 * Each is a different verb, and that is deliberate — the reason the movie's
 * third act lands is that you spent an hour watching a kid be *alone* in a
 * house before anybody came to take it off him. A game that opens on the
 * battle has thrown that away.
 *
 *   1  walk    an empty house, and find out it is empty
 *   2  hide    the Wet Bandits are casing the street; make it look occupied
 *   3  build   arm the traps before nine o'clock
 *   4  run     the battle. Everything you set, and two men in the house
 *   5  escape  no traps left. Out the window, down the wire, cut the rope
 *
 * There is also a sixth entry that is not a level: **free roam**. It exists
 * because half the people who open a link like this want to walk round the
 * house with the lights on and look at the tree, and telling them they have to
 * clear level 1 first is a bad way to greet a visitor.
 */
import { FLOOR, type RoomId, type TrapKind } from "./house";

export type LevelKind = "explore" | "lights" | "traps" | "battle" | "escape" | "roam";

export interface Beacon {
  id: string;
  /** What the compass says you are looking for. */
  label: string;
  /** The line Kevin says when you get there. */
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
  quote: string;
  /** Two or three lines of brief, shown before it starts. */
  brief: string[];
  /** The one-line objective the HUD carries the whole time. */
  goal: string;
  /** Where Kevin starts, and which way he faces. */
  spawn: { x: number; y: number; z: number; yaw: number };
  /** Seconds on the clock, if it has one. */
  time?: number;
  /** Which rooms are lit when it starts. `"all"`, `"none"`, or a list. */
  lit: "all" | "none" | RoomId[];
  beacons?: Beacon[];
  /** Level 2: rooms whose windows the van can see. */
  streetRooms?: RoomId[];
  /** Level 3: how many traps must be armed to move on. */
  trapsNeeded?: number;
  /** Level 4/5: how hard they push. */
  aggression?: number;
  /** Level 5: the traps that are already spent when it starts. */
  spentTraps?: TrapKind[];
}

const U = FLOOR.upper;
const G = FLOOR.ground;

export const LEVELS: Level[] = [
  {
    n: 1,
    kind: "explore",
    title: "Did I Make My Family Disappear?",
    quote: "“I'm not afraid any more. I said I'm not afraid.”",
    brief: [
      "You slept in. The house is very quiet.",
      "Go and find out how quiet.",
    ],
    goal: "Search the house for anybody at all",
    spawn: { x: 0.2, y: U, z: 4.2, yaw: Math.PI },
    lit: "all",
    beacons: [
      {
        id: "parents", label: "Mom & Dad's room", room: "parents",
        line: "Mom? … Dad? The bed's not even made.",
        x: 4.6, y: U, z: 3.2, radius: 1.7,
      },
      {
        id: "buzz", label: "Buzz's room", room: "buzz",
        line: "Buzz? … Buzz, your spider's still here. Gross.",
        x: 4.4, y: U, z: -3.4, radius: 1.7,
      },
      {
        id: "kitchen", label: "the kitchen", room: "kitchen",
        line: "Nobody. Nine people ate breakfast here and nobody's home.",
        x: 2.0, y: G, z: -3.1, radius: 1.9,
      },
      {
        id: "hall", label: "the front door", room: "hall",
        line: "They're gone. They all went to France… and they left me.",
        x: 0.4, y: G, z: 4.6, radius: 1.6,
      },
      {
        id: "basement", label: "the basement", room: "basement",
        line: "You can just shut up. You're a furnace. I'm not scared of you.",
        x: -2.4, y: FLOOR.basement, z: -2.4, radius: 2.0,
      },
    ],
  },
  {
    n: 2,
    kind: "lights",
    title: "The Wet Bandits",
    quote: "“This is my house. I have to defend it.”",
    brief: [
      "There is a grey van going up and down Lincoln Avenue.",
      "An empty-looking house gets robbed. Light this one up —",
      "every room they can see from the street, before they've seen enough.",
    ],
    goal: "Switch on every room the street can see",
    spawn: { x: 0.4, y: G, z: 3.0, yaw: 0 },
    time: 150,
    lit: ["hall"],
    streetRooms: ["hall", "living", "den", "kevin", "parents", "bathroom", "stairbay"],
  },
  {
    n: 3,
    kind: "traps",
    title: "This Is My House",
    quote: "“I'm gonna give you 'til the count of ten.”",
    brief: [
      "They said nine o'clock. It is ten past eight.",
      "Every trap you arm is one you get to use later,",
      "and every one you skip is a room with nothing in it.",
    ],
    goal: "Arm the traps before nine o'clock",
    spawn: { x: 0.4, y: G, z: 3.0, yaw: Math.PI },
    time: 180,
    lit: ["hall", "living", "kitchen", "corridor"],
    trapsNeeded: 4,
  },
  {
    n: 4,
    kind: "battle",
    title: "The Battle of the McCallister House",
    quote: "“Hey, I'm up here, you big horse's ass! Come and get me!”",
    brief: [
      "Harry is coming through the front. Marv has the back door.",
      "You cannot fight them and you cannot outrun them.",
      "What you can do is stand somewhere you set up earlier and SHOUT,",
      "and make them come to you. Buzz's BB gun is still on his dresser.",
    ],
    goal: "Break their nerve. Lead them onto everything you armed",
    // In the living room by the tree, not in the hall — the hall is a straight
    // line from the front door and Harry comes through the front door.
    spawn: { x: 4.4, y: G, z: 3.0, yaw: Math.PI * 0.75 },
    lit: ["hall", "living", "kitchen"],
    aggression: 0.45,
  },
  {
    n: 5,
    kind: "escape",
    title: "Merry Christmas, Ya Filthy Animal",
    quote: "“I'm not scared. I'm gonna get you.”",
    brief: [
      "Everything is spent and they are both still standing.",
      "Guest room, back of the house, window over the yard.",
      "Take the wire to the treehouse — then cut the rope.",
      "And if they get hold of you… somebody is out there shovelling.",
    ],
    goal: "Reach the guest-room window and ride the zipline",
    spawn: { x: 0.4, y: G, z: 3.4, yaw: Math.PI },
    lit: ["hall", "corridor", "guest"],
    aggression: 0.85,
    beacons: [
      {
        id: "window", label: "the guest-room window", room: "guest",
        line: "Out the window. Do not look down.",
        x: -3.0, y: U, z: -4.9, radius: 1.5,
      },
    ],
  },
  {
    n: 6,
    kind: "roam",
    title: "Free Roam",
    quote: "“Look what you did, you little jerk.”",
    brief: [
      "No burglars, no clock. Every light on and the tree lit.",
      "Walk the house, go out in the snow, climb the treehouse.",
    ],
    goal: "Have a look round",
    spawn: { x: 0.4, y: G, z: 8.6, yaw: Math.PI },
    lit: "all",
  },
];

export const LEVEL_COUNT = 5;

export function levelByNumber(n: number): Level {
  return LEVELS.find((l) => l.n === n) ?? LEVELS[0];
}

/**
 * Kevin talks to himself, constantly, and it is most of why the first half of
 * the film works. One line at a time, on a timer, in whatever room you are in.
 */
export const ROOM_LINES: Partial<Record<RoomId, string[]>> = {
  living: [
    "A tree, and no one to look at it.",
    "Dad'd kill me if he saw me in here with shoes on.",
    "Angels with Filthy Souls. Nobody said I couldn't.",
  ],
  kitchen: ["I made my family disappear.", "Cheese pizza. A whole one. Just for me."],
  basement: ["I'm not scared. I'm not scared.", "That furnace is not looking at me. Furnaces can't look."],
  parents: ["Mom's suitcase is gone. Everything's gone."],
  buzz: ["Buzz's room. Buzz's spider. Buzz's problem.", "Buzz, your spider — is it still alive?"],
  kevin: ["This is my room. This is my house."],
  bathroom: ["Aftershave. …Aaaaaah!"],
  den: ["Dad's desk. Nobody says I can't."],
  guest: ["Nobody's slept in here since Grandma."],
  corridor: ["Nine people lived here yesterday."],
  hall: ["This is my house. I have to defend it.", "Keep the change, ya filthy animal."],
  dining: ["Nine chairs. One kid."],
  family: ["The TV's still warm."],
  backhall: ["The laundry chute goes all the way down."],
  stairbay: ["Everybody always runs down these."],
  midhall: ["Quiet. Really quiet."],
};
