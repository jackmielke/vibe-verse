import { describe, expect, it } from "vitest";
import { drain, newGame, setAuto, step, type Game, type GameEvent } from "@/hoops/game";

function play(g: Game, seconds: number, dt = 1 / 60): GameEvent[] {
  const all: GameEvent[] = [];
  for (let t = 0; t < seconds && g.phase !== "over"; t += dt) {
    step(g, dt);
    all.push(...drain(g));
  }
  return all;
}

describe("Vibe Hoops", () => {
  it("plays a whole game, computer against computer, to a winner", () => {
    const g = newGame({ seed: 7, skipIntro: true });
    const ev = play(g, 400);
    expect(g.phase).toBe("over");
    expect(g.score[0] + g.score[1]).toBeGreaterThan(20);
    expect(g.score[0]).not.toBe(g.score[1]);
    expect(ev.some((e) => e.type === "final")).toBe(true);
  });

  it("is the same game from the same seed", () => {
    const a = newGame({ seed: 42, skipIntro: true });
    const b = newGame({ seed: 42, skipIntro: true });
    play(a, 60);
    play(b, 60);
    expect(a.score).toEqual(b.score);
    expect(a.players[3].x).toBeCloseTo(b.players[3].x, 6);
  });

  it("scores every kind of basket and blocks and steals over a few games", () => {
    const kinds = new Set<string>();
    let blocks = 0;
    let steals = 0;
    let threes = 0;
    for (let s = 1; s <= 6; s++) {
      const g = newGame({ seed: s * 31, skipIntro: true });
      for (const e of play(g, 400)) {
        if (e.type === "score") kinds.add(e.kind);
        if (e.type === "score" && e.pts === 3) threes++;
        if (e.type === "block") blocks++;
        if (e.type === "steal") steals++;
      }
    }
    expect([...kinds].sort()).toEqual(["dunk", "jumper", "layup"]);
    expect(threes).toBeGreaterThan(0);
    expect(blocks).toBeGreaterThan(0);
    expect(steals).toBeGreaterThan(0);
  });

  it("a person on autopilot plays like anybody else", () => {
    const g = newGame({ seed: 5, skipIntro: true, humans: [{ team: 0, pick: "vibey" }] });
    expect(g.players[g.ctrls[0].player].who.id).toBe("vibey");
    setAuto(g, 0, true);
    play(g, 400);
    expect(g.phase).toBe("over");
  });

  it("a person who stands still with the ball never breaks the game", () => {
    const g = newGame({ seed: 9, skipIntro: true, humans: [{ team: 0 }] });
    const ev = play(g, 120);
    expect(ev.some((e) => e.type === "turnover" && e.why === "shotclock") || g.score[1] > 0).toBe(true);
  });
});
