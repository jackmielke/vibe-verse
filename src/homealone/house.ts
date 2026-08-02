/**
 * 671 Lincoln Avenue, Winnetka, Illinois — the floor plan, as data.
 *
 * The whole house exists at once: basement, ground floor and bedroom floor,
 * one continuous scene with real stairs between them. Nothing loads, nothing
 * fades, and when Marv is coming up the stairs he is genuinely on the stairs.
 * That is the same call Five Nights made about the pizzeria and it buys the
 * same things here — a burglar's footsteps are a function of a real distance,
 * and the light you left on upstairs lights the actual landing he walks onto.
 *
 * Everything is built on a grid of a dozen numbers. `X` and `Z` below are the
 * wall lines; every room is a rectangle between four of them. Keeping the plan
 * on a grid is what makes the walls close: a room whose east wall is at 2.0 and
 * a neighbour whose west wall is at 2.03 leaves a three-centimetre slot that a
 * player *will* find and fall through.
 *
 * Coordinates: +X east, +Z **south** (towards the street), Y up. The front of
 * the house faces the street, so the front door is on the +Z wall.
 */

/** Floor slab heights. Head height is 2.85 on the living floors. */
export const FLOOR = {
  basement: -2.95,
  ground: 0,
  upper: 3.15,
} as const;

export type FloorName = keyof typeof FLOOR;

/** Ceiling height above each floor's slab. */
export const CEILING: Record<FloorName, number> = {
  basement: 2.45,
  ground: 2.85,
  upper: 2.75,
};

/** The wall lines the whole plan snaps to. */
export const X = { W: -7.0, w1: -3.7, w2: -1.5, e1: 2.0, E: 7.0 } as const;
export const Z = { N: -5.6, n1: -2.6, m: 0.6, S: 5.6 } as const;

/** Exterior wall thickness, and the interior partitions. */
export const WALL_T = 0.3;
export const PART_T = 0.16;

/** Inner face of the exterior shell — every room stops here. */
export const IN = {
  W: X.W + WALL_T / 2,
  E: X.E - WALL_T / 2,
  N: Z.N + WALL_T / 2,
  S: Z.S - WALL_T / 2,
} as const;

export interface Room {
  id: RoomId;
  name: string;
  floor: FloorName;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Wallpaper index from `textures.wallpaper`. */
  paper: number;
  /** "wood" | "carpet" | "tile" | "concrete" */
  ground: "wood" | "carpet" | "tile" | "concrete";
  carpetColor?: string;
}

export type RoomId =
  | "hall"
  | "stairbay"
  | "living"
  | "den"
  | "midhall"
  | "dining"
  | "kitchen"
  | "backhall"
  | "family"
  | "corridor"
  | "bathroom"
  | "kevin"
  | "parents"
  | "buzz"
  | "guest"
  | "basement";

export const ROOMS: Record<RoomId, Room> = {
  /* ---- ground floor ------------------------------------------------ */
  hall: {
    id: "hall", name: "Front Hall", floor: "ground",
    x0: X.w2, x1: X.e1, z0: Z.m, z1: IN.S, paper: 0, ground: "wood",
  },
  stairbay: {
    id: "stairbay", name: "Staircase", floor: "ground",
    x0: X.w1, x1: X.w2, z0: Z.m, z1: IN.S, paper: 0, ground: "wood",
  },
  den: {
    id: "den", name: "The Den", floor: "ground",
    x0: IN.W, x1: X.w1, z0: Z.m, z1: IN.S, paper: 1, ground: "carpet", carpetColor: "#4a3b2c",
  },
  living: {
    id: "living", name: "Living Room", floor: "ground",
    x0: X.e1, x1: IN.E, z0: Z.m, z1: IN.S, paper: 0, ground: "wood",
  },
  midhall: {
    id: "midhall", name: "Back Passage", floor: "ground",
    x0: X.w2, x1: X.e1, z0: Z.n1, z1: Z.m, paper: 0, ground: "wood",
  },
  dining: {
    id: "dining", name: "Dining Room", floor: "ground",
    x0: X.e1, x1: IN.E, z0: Z.n1, z1: Z.m, paper: 1, ground: "wood",
  },
  family: {
    id: "family", name: "Family Room", floor: "ground",
    x0: IN.W, x1: X.w2, z0: Z.n1, z1: Z.m, paper: 3, ground: "carpet", carpetColor: "#6b5a46",
  },
  kitchen: {
    id: "kitchen", name: "Kitchen", floor: "ground",
    x0: X.w2, x1: IN.E, z0: IN.N, z1: Z.n1, paper: 2, ground: "tile",
  },
  backhall: {
    id: "backhall", name: "Back Hall", floor: "ground",
    x0: IN.W, x1: X.w2, z0: IN.N, z1: Z.n1, paper: 2, ground: "tile",
  },

  /* ---- bedroom floor ----------------------------------------------- */
  corridor: {
    id: "corridor", name: "Landing", floor: "upper",
    x0: IN.W, x1: IN.E, z0: -1.2, z1: 0.4, paper: 0, ground: "carpet", carpetColor: "#7a2b2b",
  },
  bathroom: {
    id: "bathroom", name: "Bathroom", floor: "upper",
    x0: IN.W, x1: X.w1, z0: 0.4, z1: IN.S, paper: 2, ground: "tile",
  },
  kevin: {
    id: "kevin", name: "Kevin's Room", floor: "upper",
    x0: X.w2, x1: 2.2, z0: 0.4, z1: IN.S, paper: 3, ground: "carpet", carpetColor: "#3e5a74",
  },
  parents: {
    id: "parents", name: "Mom & Dad's Room", floor: "upper",
    x0: 2.2, x1: IN.E, z0: 0.4, z1: IN.S, paper: 1, ground: "carpet", carpetColor: "#5b4a5e",
  },
  buzz: {
    id: "buzz", name: "Buzz's Room", floor: "upper",
    x0: 1.0, x1: IN.E, z0: IN.N, z1: -1.2, paper: 3, ground: "carpet", carpetColor: "#3c4a3a",
  },
  guest: {
    id: "guest", name: "Guest Room", floor: "upper",
    x0: IN.W, x1: 1.0, z0: IN.N, z1: -1.2, paper: 1, ground: "carpet", carpetColor: "#6a5c4a",
  },

  /* ---- basement ----------------------------------------------------- */
  basement: {
    id: "basement", name: "The Basement", floor: "basement",
    x0: IN.W, x1: 1.0, z0: IN.N, z1: -1.0, paper: 2, ground: "concrete",
  },
};

/* ------------------------------------------------------------------ *
 * STAIRS
 *
 * Both flights are ramps with step geometry sitting on top of them. The ramp
 * is the thing the player and the burglars actually stand on; the steps are
 * decoration. Doing it the other way round — stepping up seventeen 18 cm boxes
 * — means the camera bobs like a paint mixer and anything chasing you gets
 * stuck on a riser.
 * ------------------------------------------------------------------ */

export interface Ramp {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Height at the low end and the high end. */
  yLow: number;
  yHigh: number;
  /** Which axis the flight climbs along. */
  axis: "x" | "z";
  /** +1 if it climbs towards larger axis values. */
  dir: 1 | -1;
  steps: number;
}

/** Main flight: up out of the front hall, arriving at the landing. */
export const MAIN_STAIR: Ramp = {
  x0: X.w1 + PART_T / 2, x1: X.w2 - PART_T / 2,
  z0: 0.4, z1: 5.0,
  yLow: FLOOR.ground, yHigh: FLOOR.upper,
  axis: "z", dir: -1, steps: 16,
};

/** Basement flight: down along the back wall, out of the back hall. */
export const CELLAR_STAIR: Ramp = {
  x0: -6.4, x1: -2.2,
  z0: -5.25, z1: -4.05,
  yLow: FLOOR.basement, yHigh: FLOOR.ground,
  // dir: +1 — it climbs towards larger x, so the *head* of the flight is at
  // x = -2.2, right behind the cellar door, and it descends westward. Getting
  // this backwards builds a staircase whose top is in the far corner of the
  // basement and whose bottom is at the door: the geometry and the ramp agree
  // with each other and disagree with the nav graph, which is the worst of
  // both worlds and reads as burglars sinking through the floor.
  axis: "x", dir: 1, steps: 12,
};

/** Slab holes — the openings each flight punches through the floor above. */
export const STAIR_VOIDS = [
  // Bedroom floor is open over the main flight.
  { x0: X.w1, x1: X.w2, z0: 0.4, z1: IN.S, floor: "upper" as FloorName },
  // Ground floor is open over the cellar flight.
  { x0: -6.5, x1: -2.1, z0: -5.35, z1: -4.0, floor: "ground" as FloorName },
];

/* ------------------------------------------------------------------ *
 * DOORWAYS
 *
 * A doorway is a hole in a wall, described by the wall it is in. `build.ts`
 * subtracts it; the nav graph walks through it. One list, both uses — the
 * alternative is a door the AI knows about and the geometry does not.
 * ------------------------------------------------------------------ */

export interface Doorway {
  /** Which axis the wall runs along. */
  along: "x" | "z";
  /** The wall's fixed coordinate. */
  at: number;
  /** Centre of the hole on the running axis. */
  centre: number;
  width: number;
  height: number;
  floor: FloorName;
  /** A hung door leaf, if it has one. */
  leaf?: "none" | "interior" | "front" | "back" | "cellar";
  /** Which way the leaf swings open, in radians. */
  swing?: number;
}

export const DOORWAYS: Doorway[] = [
  /* ground floor */
  { along: "z", at: X.w2, centre: 3.2, width: 1.35, height: 2.15, floor: "ground", leaf: "none" }, // hall ↔ stairbay (cased opening)
  { along: "z", at: X.e1, centre: 3.4, width: 1.5, height: 2.2, floor: "ground", leaf: "none" }, // hall ↔ living
  { along: "x", at: Z.m, centre: 0.4, width: 1.2, height: 2.15, floor: "ground", leaf: "none" }, // hall ↔ midhall
  { along: "z", at: X.w1, centre: 2.4, width: 1.0, height: 2.1, floor: "ground", leaf: "interior", swing: 1.5 }, // stairbay ↔ den
  { along: "z", at: X.e1, centre: -1.0, width: 1.4, height: 2.2, floor: "ground", leaf: "none" }, // midhall ↔ dining
  { along: "z", at: X.w2, centre: -1.0, width: 1.1, height: 2.1, floor: "ground", leaf: "interior", swing: -1.5 }, // midhall ↔ family
  { along: "x", at: Z.n1, centre: 3.6, width: 1.3, height: 2.15, floor: "ground", leaf: "none" }, // dining ↔ kitchen
  { along: "x", at: Z.n1, centre: 0.4, width: 1.0, height: 2.1, floor: "ground", leaf: "none" }, // midhall ↔ kitchen
  { along: "z", at: X.w2, centre: -3.3, width: 1.0, height: 2.1, floor: "ground", leaf: "none" }, // kitchen ↔ backhall
  /* exterior doors */
  { along: "x", at: Z.S, centre: 0.4, width: 1.25, height: 2.35, floor: "ground", leaf: "front", swing: -1.7 },
  { along: "x", at: Z.N, centre: 3.2, width: 1.1, height: 2.2, floor: "ground", leaf: "back", swing: 1.6 },
  /* cellar door, at the head of the back stair */
  { along: "z", at: -2.1, centre: -4.65, width: 1.0, height: 2.1, floor: "ground", leaf: "cellar", swing: -1.5 },

  /* bedroom floor */
  { along: "x", at: 0.4, centre: -5.2, width: 0.95, height: 2.05, floor: "upper", leaf: "interior", swing: 1.4 }, // corridor ↔ bathroom
  { along: "x", at: 0.4, centre: 0.4, width: 0.95, height: 2.05, floor: "upper", leaf: "interior", swing: -1.4 }, // corridor ↔ Kevin
  { along: "x", at: 0.4, centre: 4.4, width: 0.95, height: 2.05, floor: "upper", leaf: "interior", swing: 1.4 }, // corridor ↔ parents
  { along: "x", at: -1.2, centre: 4.0, width: 0.95, height: 2.05, floor: "upper", leaf: "interior", swing: -1.4 }, // corridor ↔ Buzz
  { along: "x", at: -1.2, centre: -3.0, width: 0.95, height: 2.05, floor: "upper", leaf: "interior", swing: 1.4 }, // corridor ↔ guest
];

/* ------------------------------------------------------------------ *
 * NAVIGATION
 *
 * Twenty-six nodes and the links between them. Harry and Marv breadth-first
 * their way through this; the player ignores it entirely.
 *
 * Nodes carry a floor because the graph is the only place the three storeys
 * meet. A burglar walking from the kitchen to Kevin's room routes through the
 * stair nodes, and the stair nodes carry the ramp's height, so he climbs.
 * ------------------------------------------------------------------ */

export interface NavNode {
  id: string;
  x: number;
  y: number;
  z: number;
  room: RoomId | "outside";
}

const g = (id: string, x: number, z: number, room: RoomId | "outside"): NavNode => ({ id, x, y: FLOOR.ground, z, room });
const u = (id: string, x: number, z: number, room: RoomId): NavNode => ({ id, x, y: FLOOR.upper, z, room });

export const NAV: NavNode[] = [
  /* outside */
  { id: "out_front", x: 0.4, y: 0, z: 8.6, room: "outside" },
  { id: "out_side", x: -9.5, y: 0, z: 0.0, room: "outside" },
  { id: "out_back", x: 3.2, y: 0, z: -8.2, room: "outside" },

  /* ground */
  g("g_front", 0.4, 4.6, "hall"),
  g("g_hall", 0.4, 2.6, "hall"),
  g("g_hall_n", 0.4, 1.1, "hall"),
  g("g_stairfoot", -2.6, 4.4, "stairbay"),
  g("g_stairbay", -2.6, 2.6, "stairbay"),
  g("g_den_door", -3.9, 2.4, "den"),
  g("g_den", -5.4, 3.4, "den"),
  g("g_living_door", 2.2, 3.4, "living"),
  g("g_living", 4.4, 3.0, "living"),
  g("g_midhall", 0.4, -0.6, "midhall"),
  g("g_midhall_n", 0.4, -2.2, "midhall"),
  g("g_dining_door", 2.2, -1.0, "dining"),
  g("g_dining", 4.6, -1.2, "dining"),
  g("g_family_door", -1.7, -1.0, "family"),
  g("g_family", -4.2, -1.2, "family"),
  g("g_kitchen_e", 3.6, -3.4, "kitchen"),
  g("g_kitchen_w", 0.2, -3.6, "kitchen"),
  g("g_backdoor", 3.2, -4.8, "kitchen"),
  g("g_backhall", -1.9, -3.3, "backhall"),
  g("g_cellar_head", -1.9, -4.65, "backhall"),

  /* main stair — three nodes so a burglar is genuinely mid-flight */
  { id: "s_low", x: -2.6, y: FLOOR.ground + 0.05, z: 4.7, room: "stairbay" },
  { id: "s_mid", x: -2.6, y: (FLOOR.ground + FLOOR.upper) / 2, z: 2.7, room: "stairbay" },
  { id: "s_high", x: -2.6, y: FLOOR.upper, z: 0.55, room: "stairbay" },

  /* cellar stair */
  { id: "c_high", x: -2.5, y: FLOOR.ground, z: -4.65, room: "backhall" },
  { id: "c_mid", x: -4.3, y: (FLOOR.basement + FLOOR.ground) / 2, z: -4.65, room: "basement" },
  { id: "c_low", x: -6.1, y: FLOOR.basement, z: -4.65, room: "basement" },
  { id: "b_floor", x: -4.4, y: FLOOR.basement, z: -3.0, room: "basement" },
  { id: "b_furnace", x: -1.4, y: FLOOR.basement, z: -2.0, room: "basement" },

  /* upper */
  u("u_landing", -2.6, -0.4, "corridor"),
  u("u_corr_w", -5.0, -0.4, "corridor"),
  u("u_corr_m", 0.4, -0.4, "corridor"),
  u("u_corr_e", 4.4, -0.4, "corridor"),
  u("u_bath", -5.2, 2.4, "bathroom"),
  u("u_kevin", 0.4, 3.2, "kevin"),
  u("u_parents", 4.6, 3.0, "parents"),
  u("u_buzz", 4.0, -3.4, "buzz"),
  u("u_guest", -3.0, -3.4, "guest"),
];

const LINKS: Array<[string, string]> = [
  ["out_front", "g_front"],
  ["out_front", "out_side"],
  ["out_side", "out_back"],
  ["out_back", "g_backdoor"],
  ["g_front", "g_hall"],
  ["g_hall", "g_hall_n"],
  ["g_hall", "g_stairfoot"],
  ["g_hall", "g_living_door"],
  ["g_stairfoot", "g_stairbay"],
  ["g_stairbay", "g_den_door"],
  ["g_den_door", "g_den"],
  ["g_living_door", "g_living"],
  ["g_hall_n", "g_midhall"],
  ["g_midhall", "g_midhall_n"],
  ["g_midhall", "g_dining_door"],
  ["g_midhall", "g_family_door"],
  ["g_dining_door", "g_dining"],
  ["g_family_door", "g_family"],
  ["g_dining", "g_kitchen_e"],
  ["g_midhall_n", "g_kitchen_w"],
  ["g_kitchen_w", "g_kitchen_e"],
  ["g_kitchen_e", "g_backdoor"],
  ["g_kitchen_w", "g_backhall"],
  ["g_backhall", "g_cellar_head"],
  ["g_family", "g_backhall"],
  /* main stair */
  ["g_stairfoot", "s_low"],
  ["s_low", "s_mid"],
  ["s_mid", "s_high"],
  ["s_high", "u_landing"],
  /* cellar stair */
  ["g_cellar_head", "c_high"],
  ["c_high", "c_mid"],
  ["c_mid", "c_low"],
  ["c_low", "b_floor"],
  ["b_floor", "b_furnace"],
  /* upper */
  ["u_landing", "u_corr_w"],
  ["u_landing", "u_corr_m"],
  ["u_corr_m", "u_corr_e"],
  ["u_corr_w", "u_bath"],
  ["u_corr_m", "u_kevin"],
  ["u_corr_e", "u_parents"],
  ["u_corr_e", "u_buzz"],
  ["u_landing", "u_guest"],
];

const NODE_BY_ID = new Map(NAV.map((n) => [n.id, n]));
const ADJ = new Map<string, string[]>();
for (const n of NAV) ADJ.set(n.id, []);
for (const [a, b] of LINKS) {
  ADJ.get(a)!.push(b);
  ADJ.get(b)!.push(a);
}

export function node(id: string): NavNode {
  const n = NODE_BY_ID.get(id);
  if (!n) throw new Error(`[home alone] no nav node "${id}"`);
  return n;
}

/** Nearest node to a point, weighting vertical distance heavily so a burglar
 *  on the landing never decides he is standing in the hall below. */
export function nearestNode(x: number, y: number, z: number): NavNode {
  let best = NAV[0];
  let bestD = Infinity;
  for (const n of NAV) {
    const dy = (n.y - y) * 4;
    const d = (n.x - x) ** 2 + (n.z - z) ** 2 + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/** Breadth-first route between two nodes, inclusive of both ends. */
export function pathBetween(from: string, to: string): NavNode[] {
  if (from === to) return [node(from)];
  const prev = new Map<string, string>();
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of ADJ.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, cur);
      if (next === to) {
        const out: NavNode[] = [];
        let step: string | undefined = to;
        while (step) {
          out.unshift(node(step));
          step = prev.get(step);
        }
        return out;
      }
      queue.push(next);
    }
  }
  return [node(from)];
}

/** Which room contains a point, if any. Used for the HUD's room name. */
export function roomAt(x: number, y: number, z: number): Room | null {
  let best: Room | null = null;
  for (const r of Object.values(ROOMS)) {
    const fy = FLOOR[r.floor];
    if (y < fy - 1.0 || y > fy + CEILING[r.floor]) continue;
    if (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1) continue;
    best = r;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * TRAPS
 *
 * Eight stations, in the order the movie uses them. Each is a fixed spot in
 * the house with a radius; arm it in the setup phase and it fires when a
 * burglar walks through during the battle.
 *
 * They are fixed rather than free-placed on purpose. Free placement sounds
 * better and plays worse: on a phone, aiming a trap at a stair tread is
 * miserable, and the fun of this sequence was never the aiming — it is
 * knowing the iron is waiting at the top of the cellar steps and running that
 * way on purpose.
 * ------------------------------------------------------------------ */

export type TrapKind =
  | "cars"
  | "tar"
  | "iron"
  | "torch"
  | "paint"
  | "ornaments"
  | "glue"
  | "doorknob";

export interface TrapSpot {
  kind: TrapKind;
  name: string;
  /** One line, in Kevin's voice, shown when you arm it. */
  quip: string;
  x: number;
  y: number;
  z: number;
  floor: FloorName;
  radius: number;
  /** Seconds the victim spends on the floor. */
  stun: number;
  /** How much of a burglar's nerve it takes. Two hits and one of them leaves. */
  damage: number;
  room: RoomId;
}

export const TRAPS: TrapSpot[] = [
  {
    kind: "cars", name: "Micro Machines", quip: "Cars on the floor. Nobody walks in here.",
    x: 0.4, y: FLOOR.ground, z: 3.6, floor: "ground", radius: 1.5, stun: 3.4, damage: 34, room: "hall",
  },
  {
    kind: "doorknob", name: "Red-Hot Doorknob", quip: "Charcoal starter, one doorknob. Grab that.",
    x: 3.2, y: FLOOR.ground, z: -4.9, floor: "ground", radius: 1.3, stun: 3.0, damage: 30, room: "kitchen",
  },
  {
    kind: "torch", name: "Blowtorch Over the Door", quip: "Right over the back door. Hats off.",
    x: 3.2, y: FLOOR.ground, z: -4.2, floor: "ground", radius: 1.4, stun: 3.2, damage: 32, room: "kitchen",
  },
  {
    kind: "iron", name: "The Iron on a String", quip: "Down the laundry chute. Bombs away.",
    x: -1.9, y: FLOOR.ground, z: -4.65, floor: "ground", radius: 1.3, stun: 3.6, damage: 40, room: "backhall",
  },
  {
    kind: "tar", name: "Tar and a Nail", quip: "Tar on every step. Take your shoes off, Marv.",
    x: -4.3, y: (FLOOR.basement + FLOOR.ground) / 2, z: -4.65, floor: "basement", radius: 1.7, stun: 4.0, damage: 42, room: "basement",
  },
  {
    kind: "ornaments", name: "Ornaments Under the Window", quip: "Glass, on the floor, in the dark.",
    x: -4.2, y: FLOOR.ground, z: -1.6, floor: "ground", radius: 1.6, stun: 3.4, damage: 34, room: "family",
  },
  {
    kind: "paint", name: "Paint Cans on a Rope", quip: "Two cans, one rope, straight down the stairs.",
    x: -2.6, y: FLOOR.ground + 1.0, z: 3.2, floor: "ground", radius: 1.6, stun: 4.2, damage: 46, room: "stairbay",
  },
  {
    kind: "glue", name: "Glue and Feathers", quip: "Feathers stick to glue. That's just science.",
    x: 0.4, y: FLOOR.upper, z: 1.2, floor: "upper", radius: 1.5, stun: 3.2, damage: 32, room: "kevin",
  },
];

/* ------------------------------------------------------------------ *
 * THE NEIGHBOURHOOD
 * ------------------------------------------------------------------ */

/** Where the street, the kerb and the lawn sit, in +Z from the house front. */
export const STREET = { kerb: 12.0, centre: 15.5, far: 19.0 };

/** The treehouse across the back yard, and the zipline's two ends. */
export const TREEHOUSE = { x: -10.5, z: -15.0, deckY: 3.15 };
/** The guest-room window, and the deck it runs down to. A zipline has to fall,
 *  so the deck sits a metre below the sill — not level with it. */
export const ZIP_START = { x: -3.0, y: FLOOR.upper + 0.95, z: Z.N - 0.35 };
export const ZIP_END = { x: TREEHOUSE.x, y: TREEHOUSE.deckY + 0.45, z: TREEHOUSE.z };

/** The neighbours. `lit` is how many of their windows are on. */
export const NEIGHBOURS = [
  { x: -21.0, z: 1.0, rot: 0.06, w: 11, d: 9, storeys: 2, hue: "#7a6a5c", lit: 0.55 },
  { x: 21.5, z: -0.5, rot: -0.05, w: 12, d: 9.5, storeys: 2, hue: "#6b5f6a", lit: 0.4 },
  { x: -20.0, z: 26.0, rot: 3.2, w: 11, d: 9, storeys: 2, hue: "#6a6558", lit: 0.7 },
  { x: 2.0, z: 27.5, rot: 3.14, w: 13, d: 10, storeys: 2, hue: "#755c50", lit: 0.5 },
  { x: 23.0, z: 27.0, rot: 3.1, w: 11, d: 9, storeys: 2, hue: "#5f5f6b", lit: 0.35 },
];

/** Streetlights, in world XZ. Sodium orange, and they are the only thing
 *  lighting the street, which is what makes the snow read as night snow. */
export const STREETLIGHTS = [
  { x: -14.0, z: 12.6 },
  { x: 6.0, z: 12.6 },
  { x: 26.0, z: 12.6 },
];
