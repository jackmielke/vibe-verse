/**
 * MORT'S MAZE — the three mazes.
 *
 * Each maze is written as its LEFT half (ten columns, the tenth being the
 * centre line) and mirrored, so every maze is symmetrical by construction and
 * nobody has to keep two halves of a hand-drawn grid in step.
 *
 *   #  hedge (wall)          .  Vibey Coin
 *   o  water balloon         -  the junkyard gate (chasers only)
 *   G  the junkyard pen      ' ' open floor, no coin
 *
 * The rules every maze must keep are checked in `src/test/mortMaze.test.ts`:
 * one connected floor, no dead ends, corridors one tile wide, a tunnel on the
 * pen row, and the fixed tiles below (start, gate, bonus) where the code
 * expects them.
 */

export const MAZE_W = 19;
export const MAZE_H = 21;

/** Where Vibey starts each life. */
export const PLAYER_START = { x: 9, y: 15 };
/** The tile above the gate: where chasers step out into the maze. */
export const PEN_EXIT = { x: 9, y: 7 };
/** The middle of the pen, where soaked chasers drip back to. */
export const PEN_CENTER = { x: 9, y: 9 };
/** The row the tunnel runs along. */
export const TUNNEL_ROW = 9;
/** Where the bonus snack appears. */
export const BONUS_TILE = { x: 9, y: 11 };

export interface MazeDef {
  name: string;
  /** Hedge colour, the one thing that makes each maze feel like a place. */
  wall: string;
  /** The darker core of the hedge. */
  wallCore: string;
  half: string[];
}

export const MAZES: MazeDef[] = [
  {
    name: "Palm Court",
    wall: "#2bd47d",
    wallCore: "#0b3a2a",
    half: [
      "##########",
      "#o...#....",
      "#.##.#.###",
      "#.........",
      "#.##.##.##",
      "#.#...#...",
      "#.#.#.###.",
      "#...#.....",
      "###.#.###-",
      "......#GGG",
      "###.#.####",
      "#...#.....",
      "#.###.###.",
      "#.........",
      "#.##.####.",
      "#o.#......",
      "##.#.#.###",
      "#....#....",
      "#.####.##.",
      "#.........",
      "##########",
    ],
  },
  {
    name: "Mort's Junkyard",
    wall: "#ff8a3d",
    wallCore: "#3a1a08",
    half: [
      "##########",
      "#o.......#",
      "#.##.###.#",
      "#.#......#",
      "#.#.##.#.#",
      "#......#..",
      "###.##.##.",
      "#...#.....",
      "#.#.#.###-",
      "..#...#GGG",
      "#.#.#.####",
      "#...#.....",
      "###.#.###.",
      "#.........",
      "#.###.#.##",
      "#o..#.#...",
      "###.#.#.#.",
      "#.....#.#.",
      "#.###.#.#.",
      "#.........",
      "##########",
    ],
  },
  {
    name: "Lighthouse Loop",
    wall: "#3ad8ff",
    wallCore: "#06283a",
    half: [
      "##########",
      "#o........",
      "#.###.###.",
      "#.#...#...",
      "#.#.#.#.##",
      "#...#.....",
      "#.###.###.",
      "#.#.......",
      "#.#.#.###-",
      "....#.#GGG",
      "###.#.####",
      "#.........",
      "#.##.####.",
      "#.#.....#.",
      "#.#.###.#.",
      "#o..#.....",
      "###.#.#.##",
      "#.....#...",
      "#.###.###.",
      "#.........",
      "##########",
    ],
  },
];

/** Cell kinds in a built maze. */
export const WALL = 0;
export const FLOOR = 1;
export const GATE = 2;
export const PEN = 3;

/** What sits on a floor tile. */
export const NOTHING = 0;
export const COIN = 1;
export const BALLOON = 2;

export interface BuiltMaze {
  def: MazeDef;
  /** Full rows, mirrored, for tests and debugging. */
  rows: string[];
  /** Cell kind per tile, row-major. */
  cells: Uint8Array;
  /** What starts on each tile. */
  items: Uint8Array;
}

export function mirror(half: string[]): string[] {
  return half.map((r) => r + r.slice(0, 9).split("").reverse().join(""));
}

export function buildMaze(index: number): BuiltMaze {
  const def = MAZES[((index % MAZES.length) + MAZES.length) % MAZES.length];
  const rows = mirror(def.half);
  const cells = new Uint8Array(MAZE_W * MAZE_H);
  const items = new Uint8Array(MAZE_W * MAZE_H);
  for (let y = 0; y < MAZE_H; y++) {
    for (let x = 0; x < MAZE_W; x++) {
      const ch = rows[y][x];
      const i = y * MAZE_W + x;
      if (ch === "#") cells[i] = WALL;
      else if (ch === "-") cells[i] = GATE;
      else if (ch === "G") cells[i] = PEN;
      else cells[i] = FLOOR;
      if (ch === ".") items[i] = COIN;
      if (ch === "o") items[i] = BALLOON;
    }
  }
  // Vibey's start tile carries no coin, so the first life never opens on a
  // free ten points and the coin count is the same every time.
  items[PLAYER_START.y * MAZE_W + PLAYER_START.x] = NOTHING;
  return { def, rows, cells, items };
}
