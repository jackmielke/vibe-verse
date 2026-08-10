/**
 * 2048's rules are four lines of prose and about six ways to get wrong, and
 * every one of them is invisible until somebody plays a long game: a tile that
 * merges twice in a move, a merge that resolves from the wrong end of the row,
 * a spawn on a square that is already taken, a "no moves left" that fires while
 * a merge is still available.
 *
 * So the rules live in a module with no DOM in it, and this plays it.
 */
import { describe, expect, it } from "vitest";
import {
  canMove, gridOf, liveTiles, move, newGame, type Dir, type GameState,
} from "@/twenty48/game";
import { hueOf, rungOf, skinFor } from "@/twenty48/palette";

/** A deterministic stand-in for Math.random, so a failure is reproducible. */
const seeded = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

/** Build a board from a picture of one. `0` is an empty square. */
function boardOf(rows: number[][]): GameState {
  const tiles = rows.flatMap((row, r) =>
    row
      .map((value, c) => ({ value, r, c }))
      .filter((t) => t.value > 0)
      .map((t, i) => ({ id: r * 100 + i + 1, value: t.value, r: t.r, c: t.c })),
  );
  return {
    size: rows.length,
    tiles,
    score: 0,
    gained: 0,
    top: Math.max(0, ...tiles.map((t) => t.value)),
    moves: 0,
    over: false,
    won: false,
    nextId: 10_000,
  };
}

/** The board as numbers again, ghosts excluded — what a player would see. */
function picture(state: GameState): number[][] {
  return gridOf(state).map((row) => row.map((t) => (t ? t.value : 0)));
}

/**
 * Move, then take the tile the game handed you back off the board.
 *
 * Every real move spawns, and a spawn lands on the first empty square under a
 * fixed random source — which is usually the square an assertion is about. So
 * these tests play the move for real and then drop the tile it gave you, and
 * what is left is only what the swipe did.
 */
const still = (state: GameState, dir: Dir): GameState => {
  const next = move(state, dir, () => 0).state;
  return { ...next, tiles: next.tiles.filter((t) => !t.born) };
};

describe("sliding", () => {
  it("packs a row against the wall it is pushed toward", () => {
    const s = still(boardOf([
      [0, 2, 0, 4],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]), "left");
    expect(picture(s)[0].slice(0, 2)).toEqual([2, 4]);
  });

  it("keeps order when packing the other way", () => {
    const s = still(boardOf([
      [2, 4, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]), "right");
    expect(picture(s)[0].slice(2)).toEqual([2, 4]);
  });

  it("reports a move that changes nothing, and does not spawn for it", () => {
    const board = boardOf([
      [2, 4, 8, 16],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const { state, moved } = move(board, "left", () => 0);
    expect(moved).toBe(false);
    expect(state).toBe(board);
  });

  it("hands you exactly one new tile per move that moved", () => {
    const before = boardOf([
      [0, 0, 0, 2],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const after = move(before, "left", seeded(7)).state;
    expect(liveTiles(after)).toHaveLength(2);
  });
});

describe("merging", () => {
  it("doubles a pair and scores what it made", () => {
    const s = still(boardOf([
      [2, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]), "left");
    expect(picture(s)[0][0]).toBe(4);
    expect(s.score).toBe(4);
    expect(s.gained).toBe(4);
  });

  it("never merges the same tile twice in one move", () => {
    // The classic bug: 2,2,2,2 left becomes 8 in the corner if the pass runs
    // over its own output. It is 4,4.
    const s = still(boardOf([
      [2, 2, 2, 2],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]), "left");
    expect(picture(s)[0]).toEqual([4, 4, 0, 0]);
    expect(s.score).toBe(8);
  });

  it("resolves from the wall the swipe pushes toward", () => {
    // 4,2,2 pushed left is 4,4 — the two 2s meet. Pushed right it is 4,4 too,
    // but the pair lands at the far end.
    expect(picture(still(boardOf([
      [4, 2, 2, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]), "left"))[0]).toEqual([4, 4, 0, 0]);

    expect(picture(still(boardOf([
      [0, 2, 2, 4],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]), "right"))[0]).toEqual([0, 0, 4, 4]);
  });

  it("picks the far pair when three of a kind line up", () => {
    // 2,2,2 left is 4,2 — the pair nearest the wall goes first.
    expect(picture(still(boardOf([
      [2, 2, 2, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]), "left"))[0]).toEqual([4, 2, 0, 0]);
  });

  it("merges down columns as well as along rows", () => {
    const s = still(boardOf([
      [2, 0, 0, 0],
      [2, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]), "down");
    expect(picture(s).map((row) => row[0])).toEqual([0, 0, 0, 4]);
  });

  it("leaves the two consumed tiles behind as ghosts, for one move only", () => {
    /* The animation depends on this: the survivors have to slide to the merge
       square, so they cannot be deleted the instant the merge resolves. What
       they must not do is pile up. */
    const first = still(boardOf([
      [2, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]), "left");
    const ghosts = first.tiles.filter((t) => t.ghost);
    expect(ghosts).toHaveLength(2);
    expect(ghosts.every((g) => g.r === 0 && g.c === 0)).toBe(true);
    // They are not board state — the player sees one tile there.
    expect(liveTiles(first)).toHaveLength(1);

    const second = still(first, "right");
    expect(second.tiles.filter((t) => t.ghost)).toHaveLength(0);
  });

  it("carries a tile's identity across a slide so it can be animated", () => {
    const before = boardOf([
      [0, 0, 0, 2],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const id = before.tiles[0].id;
    const after = still(before, "left");
    const same = after.tiles.find((t) => t.id === id);
    expect(same, "the tile that slid is a different tile now").toBeTruthy();
    expect(same!.from).toEqual({ r: 0, c: 3 });
  });
});

describe("the end of a game", () => {
  it("does not call a full board over while a merge is left", () => {
    const board = boardOf([
      [2, 4, 8, 16],
      [4, 8, 16, 32],
      [8, 16, 32, 64],
      [16, 32, 64, 64],
    ]);
    expect(canMove(board)).toBe(true);
  });

  it("calls it over when nothing touches anything like it", () => {
    const board = boardOf([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ]);
    expect(canMove(board)).toBe(false);
  });

  it("notices the win the move it happens, and keeps playing", () => {
    const s = still(boardOf([
      [1024, 1024, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]), "left");
    expect(s.won).toBe(true);
    expect(s.top).toBe(2048);
    expect(s.over).toBe(false);
  });
});

describe("a whole game", () => {
  it("never overlaps two tiles, whatever you do to it", () => {
    const rnd = seeded(20_48);
    const dirs: Dir[] = ["up", "right", "down", "left"];
    for (let size of [4, 5]) {
      let state = newGame(size, rnd);
      for (let i = 0; i < 400 && !state.over; i++) {
        state = move(state, dirs[Math.floor(rnd() * 4)], rnd).state;
        const seen = new Set<string>();
        for (const t of liveTiles(state)) {
          const at = `${t.r},${t.c}`;
          expect(seen.has(at), `two tiles on ${at}`).toBe(false);
          seen.add(at);
          expect(t.r >= 0 && t.r < size && t.c >= 0 && t.c < size).toBe(true);
        }
        expect(liveTiles(state).length).toBeLessThanOrEqual(size * size);
      }
    }
  });

  it("opens with two tiles and no score", () => {
    const g = newGame(4, seeded(3));
    expect(liveTiles(g)).toHaveLength(2);
    expect(g.score).toBe(0);
    expect(g.over).toBe(false);
    expect(g.tiles.every((t) => t.value === 2 || t.value === 4)).toBe(true);
  });
});

describe("the palette", () => {
  it("puts the 2 on BLOB's own cyan and spends green on the 2048", () => {
    expect(hueOf(2)).toBe(194);
    // 148 is the virus green BLOB paints its hazards, held back until the tile
    // the whole game is named after.
    expect(hueOf(2048)).toBe(148);
    for (const v of [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]) {
      expect(hueOf(v), `${v} wears the win colour`).not.toBe(148);
    }
  });

  it("counts rungs off powers of two", () => {
    expect(rungOf(2)).toBe(0);
    expect(rungOf(2048)).toBe(10);
  });

  it("has a skin for a tile past the end of the ladder", () => {
    const skin = skinFor(131_072);
    expect(skin.background).toContain("radial-gradient");
    expect(skin.fontSize).toContain("clamp");
  });
});
