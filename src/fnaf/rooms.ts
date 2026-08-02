/**
 * The floor plan of Vibey Fazbear's Pizza.
 *
 * There is exactly one 3D scene. Every room in the building is really there,
 * laid out on a single floor, and the security cameras are real cameras
 * standing in it — which is the whole reason the animatronics can be watched
 * walking from one room to the next instead of teleporting between eleven
 * unrelated dioramas.
 *
 * Coordinates: +X east, -Z north, +Y up, one unit ≈ one metre. The office sits
 * at the origin because everything in this game is measured in "how far is it
 * from you".
 */

export type RoomId =
  | "office"
  | "stage"
  | "dining"
  | "cove"
  | "westHall"
  | "westCorner"
  | "supply"
  | "eastHall"
  | "eastCorner"
  | "backstage"
  | "kitchen"
  | "restrooms";

/** Axis-aligned floor footprint. Walls stand on these edges. */
export interface Bounds {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface Room {
  id: RoomId;
  /** "1A", "2B" … — what the monitor prints. */
  code: string;
  name: string;
  bounds: Bounds;
  /** Ceiling height. The halls are lower than the dining room on purpose. */
  height: number;
  /** Where this room's security camera hangs, and what it points at. */
  cam?: { pos: [number, number, number]; look: [number, number, number]; fov: number };
  /** Kitchen camera is "audio only" — the monitor shows the fault card. */
  camBroken?: boolean;
}

export const ROOM_HEIGHT = 3.1;
const HALL_HEIGHT = 2.75;

export const ROOMS: Record<RoomId, Room> = {
  office: {
    id: "office",
    code: "OFF",
    name: "Office",
    bounds: { x0: -2.7, x1: 2.7, z0: -3, z1: 3 },
    height: 2.9,
  },
  westCorner: {
    id: "westCorner",
    code: "2B",
    name: "W. Hall Corner",
    bounds: { x0: -7.2, x1: -2.7, z0: -4, z1: 0 },
    height: HALL_HEIGHT,
    cam: { pos: [-6.6, 2.4, -3.5], look: [-3.7, 1.05, -1.35], fov: 64 },
  },
  westHall: {
    id: "westHall",
    code: "2A",
    name: "West Hall",
    bounds: { x0: -7.2, x1: -2.7, z0: -13, z1: -4 },
    height: HALL_HEIGHT,
    cam: { pos: [-4.95, 2.45, -12.4], look: [-4.95, 1.0, -4.2], fov: 58 },
  },
  supply: {
    id: "supply",
    code: "3",
    name: "Supply Closet",
    bounds: { x0: -11.2, x1: -7.2, z0: -10.5, z1: -6.5 },
    height: HALL_HEIGHT,
    cam: { pos: [-7.7, 2.35, -10.1], look: [-10.4, 1.1, -7.4], fov: 66 },
  },
  dining: {
    id: "dining",
    code: "1B",
    name: "Dining Area",
    bounds: { x0: -11, x1: 11, z0: -21, z1: -13 },
    height: ROOM_HEIGHT + 0.6,
    cam: { pos: [-10.2, 3.1, -13.8], look: [3, 1.1, -18], fov: 72 },
  },
  stage: {
    id: "stage",
    code: "1A",
    name: "Show Stage",
    bounds: { x0: -6, x1: 6, z0: -29, z1: -21 },
    height: ROOM_HEIGHT + 0.6,
    cam: { pos: [0, 2.9, -21.6], look: [0, 1.45, -27], fov: 62 },
  },
  backstage: {
    id: "backstage",
    code: "5",
    name: "Backstage",
    bounds: { x0: -12, x1: -6, z0: -29, z1: -23 },
    height: HALL_HEIGHT,
    cam: { pos: [-6.6, 2.4, -23.6], look: [-10.5, 1.2, -27], fov: 68 },
  },
  cove: {
    id: "cove",
    code: "1C",
    name: "Pirate Cove",
    bounds: { x0: -17, x1: -11, z0: -19, z1: -13 },
    height: ROOM_HEIGHT,
    // Mounted in the corner by the dining-room opening, looking across the
    // room at the front of the curtain. The first version stood 0.8 m behind
    // the curtain facing its back, so 1C was a black rectangle and the cove
    // may as well not have existed.
    cam: { pos: [-11.7, 2.55, -13.35], look: [-14.2, 1.35, -16.0], fov: 68 },
  },
  eastCorner: {
    id: "eastCorner",
    code: "4B",
    name: "E. Hall Corner",
    bounds: { x0: 2.7, x1: 7.2, z0: -4, z1: 0 },
    height: HALL_HEIGHT,
    cam: { pos: [6.6, 2.4, -3.5], look: [3.7, 1.05, -1.35], fov: 64 },
  },
  eastHall: {
    id: "eastHall",
    code: "4A",
    name: "East Hall",
    bounds: { x0: 2.7, x1: 7.2, z0: -13, z1: -4 },
    height: HALL_HEIGHT,
    cam: { pos: [4.95, 2.45, -12.4], look: [4.95, 1.0, -4.2], fov: 58 },
  },
  kitchen: {
    id: "kitchen",
    code: "6",
    name: "Kitchen",
    bounds: { x0: 7.2, x1: 11.2, z0: -10.5, z1: -6.5 },
    height: HALL_HEIGHT,
    camBroken: true,
    cam: { pos: [7.7, 2.35, -10.1], look: [10.4, 1.1, -7.4], fov: 66 },
  },
  restrooms: {
    id: "restrooms",
    code: "7",
    name: "Restrooms",
    bounds: { x0: 11, x1: 17, z0: -19, z1: -13 },
    height: ROOM_HEIGHT,
    cam: { pos: [11.6, 2.5, -13.6], look: [14.6, 1.2, -17.4], fov: 66 },
  },
};

/** Monitor order — the numbers you press, in the order the map reads. */
export const CAMERA_ORDER: RoomId[] = [
  "stage",
  "dining",
  "cove",
  "westHall",
  "westCorner",
  "supply",
  "eastHall",
  "eastCorner",
  "backstage",
  "kitchen",
  "restrooms",
];

/**
 * Where the map dots sit on the monitor, in 0..1 of the map panel. Hand-placed
 * against the real floor plan above rather than derived from it: the derived
 * version put Pirate Cove underneath the West Hall label and read as a smear.
 */
export const MAP_POINTS: Record<RoomId | "office", { x: number; y: number }> = {
  stage: { x: 0.5, y: 0.08 },
  backstage: { x: 0.22, y: 0.1 },
  dining: { x: 0.5, y: 0.3 },
  cove: { x: 0.14, y: 0.36 },
  restrooms: { x: 0.86, y: 0.36 },
  supply: { x: 0.14, y: 0.58 },
  kitchen: { x: 0.86, y: 0.58 },
  westHall: { x: 0.34, y: 0.62 },
  eastHall: { x: 0.66, y: 0.62 },
  westCorner: { x: 0.34, y: 0.86 },
  eastCorner: { x: 0.66, y: 0.86 },
  office: { x: 0.5, y: 0.88 },
};

/** The two doorways out of the office — the only two ways in. */
export const DOORWAY = {
  /** Along-Z span of both openings, and how tall they are. */
  z0: -2.4,
  z1: -0.45,
  height: 2.3,
  westX: -2.7,
  eastX: 2.7,
} as const;

/** Seat pose. The guard does not get up; see the README. */
export const DESK_EYE: [number, number, number] = [0, 1.62, 1.5];
/**
 * How far the chair swivels either way, in radians. 0.78 is not a taste
 * decision: the doorways sit 43° off the desk's centreline, so anything
 * tighter means you can never put a door in the middle of the screen, and
 * checking a door is the thing you do most.
 */
export const YAW_LIMIT = 0.83;

/**
 * Which rooms touch which, and the point in the doorway between them.
 *
 * This is the building's navmesh, and it is twelve lines long because the
 * building is twelve rooms with one door each. Anything that walks routes
 * through here; without it, Bonnie crossing from the dining room to backstage
 * takes the diagonal and walks through the show stage's west wall, on camera.
 */
const LINKS: Array<[RoomId, RoomId, [number, number]]> = [
  ["office", "westCorner", [-2.7, -1.4]],
  ["office", "eastCorner", [2.7, -1.4]],
  ["westCorner", "westHall", [-4.95, -4]],
  ["eastCorner", "eastHall", [4.95, -4]],
  ["westHall", "supply", [-7.2, -8.5]],
  ["eastHall", "kitchen", [7.2, -8.5]],
  ["westHall", "dining", [-4.95, -13]],
  ["eastHall", "dining", [4.95, -13]],
  ["dining", "cove", [-11, -16]],
  ["dining", "restrooms", [11, -16]],
  ["dining", "stage", [0, -21]],
  ["stage", "backstage", [-6, -25.5]],
];

const GRAPH = new Map<RoomId, Array<{ to: RoomId; at: [number, number] }>>();
for (const [a, b, at] of LINKS) {
  if (!GRAPH.has(a)) GRAPH.set(a, []);
  if (!GRAPH.has(b)) GRAPH.set(b, []);
  GRAPH.get(a)!.push({ to: b, at });
  GRAPH.get(b)!.push({ to: a, at });
}

/**
 * Doorway waypoints from one room to another, breadth-first. Excludes the
 * start and the destination — the caller appends whatever spot in the
 * destination room it actually wants to stand on.
 */
export function pathBetween(from: RoomId, to: RoomId): Array<[number, number]> {
  if (from === to) return [];
  const prev = new Map<RoomId, { room: RoomId; at: [number, number] }>();
  const seen = new Set<RoomId>([from]);
  const queue: RoomId[] = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === to) break;
    for (const edge of GRAPH.get(cur) ?? []) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      prev.set(edge.to, { room: cur, at: edge.at });
      queue.push(edge.to);
    }
  }
  if (!seen.has(to)) return [];
  const out: Array<[number, number]> = [];
  let cur = to;
  while (cur !== from) {
    const step = prev.get(cur);
    if (!step) break;
    out.unshift(step.at);
    cur = step.room;
  }
  return out;
}

export function roomCenter(id: RoomId): [number, number, number] {
  const b = ROOMS[id].bounds;
  return [(b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2];
}
