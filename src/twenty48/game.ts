/**
 * 2048 — the rules, with no DOM in them.
 *
 * The whole game is four functions and a plain object, which is the point: the
 * page renders whatever `GameState` says and never computes a merge itself.
 * That split is what makes `src/test/twenty48.test.ts` able to play a hundred
 * moves in a millisecond without a browser.
 *
 * ## Tiles are identified, not just counted
 *
 * The naive board is `number[][]`, and it plays correctly and looks terrible:
 * every move is a jump cut, because React has no way to know the 4 that is now
 * in the corner is the *same* 4 that was in the middle. So a tile here is an
 * object with a stable `id` that survives a move, and `from` recording where it
 * came from. The page keys off the id and lets CSS do the sliding.
 *
 * ## Ghosts
 *
 * When two tiles merge, three tiles are involved: the two that slid together
 * and the one that replaces them. Drop the two immediately and the merge looks
 * like a teleport — they vanish from where they were and a new tile appears
 * somewhere else. So the two survive one render as `ghost: true`: they slide to
 * the merge square underneath the new tile, and are gone by the next move,
 * because each move builds the tile list fresh. Nothing accumulates.
 */

export type Dir = "up" | "down" | "left" | "right";

export interface Tile {
  /** Stable across moves. The page uses it as its React key. */
  id: number;
  value: number;
  /** Row and column it now occupies. */
  r: number;
  c: number;
  /** Where it was before this move, when that differs. Drives the slide. */
  from?: { r: number; c: number };
  /** Spawned by this move — pops in rather than sliding. */
  born?: boolean;
  /** Created by a merge this move — pulses. */
  merged?: boolean;
  /** One of the two tiles a merge consumed. Rendered under the new tile. */
  ghost?: boolean;
}

export interface GameState {
  size: number;
  tiles: Tile[];
  score: number;
  /** Score gained by the move that produced this state — the "+48" popup. */
  gained: number;
  /** Highest tile reached, so the page can say what you got to. */
  top: number;
  moves: number;
  /** No legal move left. */
  over: boolean;
  /** 2048 has been reached at least once. You may keep playing. */
  won: boolean;
  nextId: number;
}

/** A random source, injectable so tests are not at the mercy of Math.random. */
export type Rnd = () => number;

const VECTORS: Record<Dir, [number, number]> = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
};

/** The live tiles — ghosts are last move's bookkeeping, not board state. */
export const liveTiles = (state: GameState): Tile[] => state.tiles.filter((t) => !t.ghost);

/** `grid[r][c]` — the tile there, or null. */
export function gridOf(state: GameState): (Tile | null)[][] {
  const grid: (Tile | null)[][] = Array.from({ length: state.size }, () =>
    Array.from({ length: state.size }, () => null as Tile | null),
  );
  for (const t of liveTiles(state)) grid[t.r][t.c] = t;
  return grid;
}

const emptyCells = (state: GameState): { r: number; c: number }[] => {
  const grid = gridOf(state);
  const out: { r: number; c: number }[] = [];
  for (let r = 0; r < state.size; r++) {
    for (let c = 0; c < state.size; c++) if (!grid[r][c]) out.push({ r, c });
  }
  return out;
};

/**
 * Drop a tile on a random empty square. Mutates, and is only ever called on a
 * state that was just built — the exported API stays immutable.
 *
 * One in ten is a 4, which is the original game's ratio and the reason a board
 * occasionally refuses to cooperate.
 */
function spawn(state: GameState, rnd: Rnd, born = true): void {
  const cells = emptyCells(state);
  if (cells.length === 0) return;
  const cell = cells[Math.min(cells.length - 1, Math.floor(rnd() * cells.length))];
  state.tiles.push({
    id: state.nextId++,
    value: rnd() < 0.1 ? 4 : 2,
    r: cell.r,
    c: cell.c,
    born,
  });
}

/** A fresh board with the two opening tiles already on it. */
export function newGame(size = 4, rnd: Rnd = Math.random): GameState {
  const state: GameState = {
    size,
    tiles: [],
    score: 0,
    gained: 0,
    top: 0,
    moves: 0,
    over: false,
    won: false,
    nextId: 1,
  };
  spawn(state, rnd, false);
  spawn(state, rnd, false);
  state.top = Math.max(...state.tiles.map((t) => t.value));
  return state;
}

/**
 * The squares of one row or column, ordered from the wall the move pushes
 * toward. Compacting is then just "fill from index 0", whichever way you swiped.
 */
function lineCells(dir: Dir, i: number, n: number): { r: number; c: number }[] {
  const cells: { r: number; c: number }[] = [];
  for (let k = 0; k < n; k++) {
    switch (dir) {
      case "left":
        cells.push({ r: i, c: k });
        break;
      case "right":
        cells.push({ r: i, c: n - 1 - k });
        break;
      case "up":
        cells.push({ r: k, c: i });
        break;
      case "down":
        cells.push({ r: n - 1 - k, c: i });
        break;
    }
  }
  return cells;
}

/** Is there any legal move left? Cheap enough to run after every move. */
export function canMove(state: GameState): boolean {
  const grid = gridOf(state);
  const n = state.size;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const t = grid[r][c];
      if (!t) return true;
      for (const [dr, dc] of Object.values(VECTORS)) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= n || nc >= n) continue;
        if (grid[nr][nc]?.value === t.value) return true;
      }
    }
  }
  return false;
}

/**
 * Swipe. Returns a new state, and `moved: false` when nothing shifted — which
 * the page uses to skip the spawn and the haptic, because a move that changes
 * nothing should not hand you a free tile.
 */
export function move(state: GameState, dir: Dir, rnd: Rnd = Math.random): {
  state: GameState;
  moved: boolean;
} {
  const n = state.size;
  const grid = gridOf(state);
  const next: Tile[] = [];
  const ghosts: Tile[] = [];
  let nextId = state.nextId;
  let gained = 0;
  let moved = false;

  for (let i = 0; i < n; i++) {
    const cells = lineCells(dir, i, n);
    const line = cells.map((p) => grid[p.r][p.c]).filter((t): t is Tile => !!t);
    let placed = 0;

    for (let k = 0; k < line.length; k++) {
      const a = line[k];
      const b = line[k + 1];
      const dest = cells[placed];

      if (b && b.value === a.value) {
        // Two into one. The survivors slide to `dest` as ghosts; the tile that
        // replaces them is new, so it can pop rather than inherit an identity.
        const value = a.value * 2;
        next.push({ id: nextId++, value, r: dest.r, c: dest.c, merged: true });
        for (const src of [a, b]) {
          ghosts.push({ ...src, from: { r: src.r, c: src.c }, r: dest.r, c: dest.c, ghost: true });
        }
        gained += value;
        moved = true;
        k++; // b is spent — a tile merges at most once per move.
      } else {
        const shifted = a.r !== dest.r || a.c !== dest.c;
        next.push({
          id: a.id,
          value: a.value,
          r: dest.r,
          c: dest.c,
          ...(shifted ? { from: { r: a.r, c: a.c } } : {}),
        });
        if (shifted) moved = true;
      }
      placed++;
    }
  }

  if (!moved) return { state, moved: false };

  const out: GameState = {
    ...state,
    tiles: [...ghosts, ...next],
    score: state.score + gained,
    gained,
    moves: state.moves + 1,
    nextId,
  };
  spawn(out, rnd);
  out.top = Math.max(state.top, ...out.tiles.map((t) => t.value));
  out.won = state.won || out.top >= 2048;
  out.over = !canMove(out);
  return { state: out, moved: true };
}
