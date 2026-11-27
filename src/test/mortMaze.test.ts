import { describe, expect, it } from "vitest";
import {
  BONUS_TILE, buildMaze, FLOOR, GATE, MAZE_H, MAZE_W, MAZES, PEN, PEN_CENTER, PEN_EXIT,
  PLAYER_START, TUNNEL_ROW, WALL,
} from "@/mortmaze/mazes";
import { autopilot, newGame, run, steer } from "@/mortmaze/game";

const wrap = (x: number) => ((x % MAZE_W) + MAZE_W) % MAZE_W;

describe("Mort's Maze mazes", () => {
  MAZES.forEach((def, index) => {
    describe(def.name, () => {
      const m = buildMaze(index);
      const at = (x: number, y: number) =>
        y < 0 || y >= MAZE_H ? WALL : m.cells[y * MAZE_W + wrap(x)];
      const floor = (x: number, y: number) => at(x, y) === FLOOR;

      it("is the right size", () => {
        expect(m.rows).toHaveLength(MAZE_H);
        for (const r of m.rows) expect(r).toHaveLength(MAZE_W);
      });

      it("has its fixed tiles where the code expects them", () => {
        expect(floor(PLAYER_START.x, PLAYER_START.y)).toBe(true);
        expect(floor(PEN_EXIT.x, PEN_EXIT.y)).toBe(true);
        expect(floor(BONUS_TILE.x, BONUS_TILE.y)).toBe(true);
        expect(at(PEN_EXIT.x, PEN_EXIT.y + 1)).toBe(GATE);
        expect(at(PEN_CENTER.x, PEN_CENTER.y)).toBe(PEN);
        expect(at(PEN_CENTER.x - 2, PEN_CENTER.y)).toBe(PEN);
        expect(at(PEN_CENTER.x + 2, PEN_CENTER.y)).toBe(PEN);
        // The tunnel really goes through.
        expect(floor(0, TUNNEL_ROW)).toBe(true);
        expect(floor(MAZE_W - 1, TUNNEL_ROW)).toBe(true);
      });

      it("has no dead ends and no open 2x2 squares", () => {
        const problems: string[] = [];
        for (let y = 0; y < MAZE_H; y++) {
          for (let x = 0; x < MAZE_W; x++) {
            if (!floor(x, y)) continue;
            const exits = [[1, 0], [-1, 0], [0, 1], [0, -1]]
              .filter(([dx, dy]) => floor(x + dx, y + dy)).length;
            if (exits < 2) problems.push(`dead end at ${x},${y}`);
            if (x + 1 < MAZE_W && floor(x + 1, y) && floor(x, y + 1) && floor(x + 1, y + 1)) {
              problems.push(`open square at ${x},${y}`);
            }
          }
        }
        expect(problems).toEqual([]);
      });

      it("is one connected floor, so every coin can be reached", () => {
        const seen = new Set<string>([`${PLAYER_START.x},${PLAYER_START.y}`]);
        const q = [[PLAYER_START.x, PLAYER_START.y]];
        while (q.length) {
          const [x, y] = q.pop()!;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = wrap(x + dx);
            const ny = y + dy;
            if (!floor(nx, ny) || seen.has(`${nx},${ny}`)) continue;
            seen.add(`${nx},${ny}`);
            q.push([nx, ny]);
          }
        }
        const missed: string[] = [];
        for (let y = 0; y < MAZE_H; y++) {
          for (let x = 0; x < MAZE_W; x++) {
            if (floor(x, y) && !seen.has(`${x},${y}`)) missed.push(`${x},${y}`);
          }
        }
        expect(missed).toEqual([]);
      });

      it("has four water balloons and plenty of coins", () => {
        const balloons = m.rows.join("").split("o").length - 1;
        expect(balloons).toBe(4);
        const coins = m.rows.join("").split(".").length - 1;
        expect(coins).toBeGreaterThan(150);
      });
    });
  });
});

describe("Mort's Maze rules", () => {
  it("opens on READY and then lets Vibey move", () => {
    const g = newGame(7);
    expect(g.phase).toBe("ready");
    run(g, 2.3);
    expect(g.phase).toBe("play");
    const x0 = g.player.x;
    run(g, 0.2);
    expect(g.player.x).toBeLessThan(x0);
  });

  it("eats coins as Vibey rolls over them", () => {
    const g = newGame(7);
    run(g, 2.3);
    const before = g.coinsLeft;
    run(g, 0.4);
    expect(g.coinsLeft).toBeLessThan(before);
    expect(g.score).toBeGreaterThan(0);
  });

  it("lets the crew out of the junkyard one by one", () => {
    const g = newGame(3);
    run(g, 2.3);
    let most = 0;
    for (let i = 0; i < 12 * 10; i++) {
      run(g, 0.1);
      most = Math.max(most, g.chasers.filter((c) => c.mode !== "pen").length);
    }
    expect(most).toBe(4);
  });

  it("soaks the crew with a balloon, and a soaked chaser can be splashed home", () => {
    const g = newGame(5);
    run(g, 2.3);
    // Put Vibey right next to a balloon, facing it.
    g.player.x = 2; g.player.y = 1; g.player.dir = 3; g.player.want = 3;
    run(g, 0.2);
    expect(g.powerT).toBeGreaterThan(0);
    const soaked = g.chasers.filter((c) => c.mode === "soaked");
    expect(soaked.length).toBeGreaterThan(0);
    // Drop a soaked chaser onto Vibey.
    const c = soaked[0];
    c.x = g.player.x; c.y = g.player.y;
    const score = g.score;
    run(g, 1 / 60);
    expect(c.mode).toBe("eyes");
    expect(g.score).toBe(score + 200);
    // And it finds its way back to the pen and out again.
    for (let i = 0; i < 100 && c.mode === "eyes"; i++) run(g, 0.1);
    expect(c.mode === "pen" || c.mode === "leaving" || c.mode === "active").toBe(true);
  });

  it("costs a life when an angry chaser catches Vibey", () => {
    const g = newGame(5);
    run(g, 2.3);
    const mort = g.chasers[0];
    mort.x = g.player.x; mort.y = g.player.y;
    run(g, 1 / 60);
    expect(g.phase).toBe("dying");
    run(g, 2);
    expect(g.lives).toBe(2);
    expect(g.phase).toBe("ready");
  });

  it("never lets anything walk through a hedge, over a long game", () => {
    const g = newGame(11);
    for (let i = 0; i < 60 * 90; i++) {
      steer(g, autopilot(g));
      run(g, 1 / 60);
      for (const m of [g.player, ...g.chasers]) {
        const k = g.maze.cells[Math.round(m.y) * MAZE_W + wrap(Math.round(m.x))];
        expect(k, `${JSON.stringify(m)} inside a hedge`).not.toBe(WALL);
      }
      if (g.phase === "over") break;
    }
    expect(g.score).toBeGreaterThan(500);
  });

  it("clears a level when every coin is gone, and moves to the next maze", () => {
    const g = newGame(2);
    run(g, 2.3);
    g.items.fill(0);
    const i = 15 * MAZE_W + 8;
    g.items[i] = 1;
    g.coinsLeft = 1;
    g.player.x = 9; g.player.y = 15; g.player.dir = 3; g.player.want = 3;
    run(g, 0.3);
    expect(g.phase).toBe("clear");
    run(g, 2.5);
    expect(g.level).toBe(2);
    expect(g.maze.def.name).toBe(MAZES[1].name);
    expect(g.coinsLeft).toBeGreaterThan(150);
  });
});
