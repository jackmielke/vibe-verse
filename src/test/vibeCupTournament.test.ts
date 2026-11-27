import { describe, expect, it } from "vitest";
import { CLUBS, newGame, setInput, step } from "@/vibecup/game";
import { advance, FINAL_ROUND, LEAGUE_ROUNDS, myFixture, newCup, record, roundFixtures, schedule, table } from "@/vibecup/cup";

describe("Vibe Cup tournament", () => {
  it("the Paint Pads are in, with a paint bucket", () => {
    const pads = CLUBS.find((c) => c.id === "paintpads")!;
    expect(pads.name).toBe("Paint Pads");
    expect(pads.emoji).toBe("🪣");
  });

  it("everybody plays everybody exactly once, three matches a round, never twice in a round", () => {
    const clubs = CLUBS.map((c) => c.id);
    const fx = schedule(clubs, 42);
    expect(fx).toHaveLength(15);
    const pairs = new Set(fx.map((f) => [f.home, f.away].sort().join("|")));
    expect(pairs.size).toBe(15);
    for (let r = 1; r <= LEAGUE_ROUNDS; r++) {
      const these = fx.filter((f) => f.round === r);
      expect(these).toHaveLength(3);
      expect(new Set(these.flatMap((f) => [f.home, f.away])).size).toBe(6);
    }
  });

  it("plays a whole Cup: five rounds, a table, a final between the top two, a champion", () => {
    let cup = newCup("paintpads", "fw", 7);
    expect(myFixture(cup)).not.toBeNull();
    let n = 0;
    while (!cup.champion) {
      for (const f of roundFixtures(cup)) {
        // Home wins unless it is the last of the round, which is a draw (the final cannot be a draw).
        const score: [number, number] = f.stage === "final" ? [2, 1] : n++ % 3 === 2 ? [1, 1] : [3, 1];
        cup = record(cup, f.id, score);
      }
      cup = advance(cup);
    }
    expect(cup.round).toBe(FINAL_ROUND);
    const t = table(cup);
    expect(t.reduce((a, r) => a + r.p, 0)).toBe(30);
    const fin = cup.fixtures.find((f) => f.stage === "final")!;
    expect([fin.home, fin.away]).toEqual([t[0].club, t[1].club]);
    expect(cup.champion).toBe(fin.home);
    // Points: a win is three, a draw one.
    expect(t.reduce((a, r) => a + r.pts, 0)).toBe(10 * 3 + 5 * 2);
  });

  it("as one person you stay the same player all match, and calling for it gets you the ball", () => {
    const g = newGame({ seed: 3, clubs: ["paintpads", "volts"], humans: [0], lockRole: "mf" });
    const c = g.ctrls[0];
    const me = c.lock;
    expect(g.players[me].role).toBe("mf");
    let got = 0;
    for (let i = 0; i < 60 * 60; i++) {
      // Run at the ball, and shout for it whenever a team-mate has it.
      const b = g.ball;
      const p = g.players[c.active];
      const mate = b.owner >= 0 && g.players[b.owner].team === 0 && b.owner !== me;
      const dx = b.x - p.x;
      const dy = b.y - p.y;
      const l = Math.hypot(dx, dy) || 1;
      setInput(g, 0, { mx: mate ? 0 : dx / l, my: mate ? 0 : dy / l, a: mate && i % 20 < 2, b: false, sprint: true });
      step(g, 1 / 60);
      for (const e of g.events) if (e.type === "pass" && g.ball.target === me) got++;
      g.events.length = 0;
      expect(c.active).toBe(me);
    }
    expect(got).toBeGreaterThan(0);
  });
});
