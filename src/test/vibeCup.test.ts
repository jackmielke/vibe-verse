import { describe, expect, it } from "vitest";
import {
  autopilot, BALL_R, CLUBS, GOAL_W, L, MATCH_SECONDS, GOLDEN_SECONDS, newGame, passTarget, setInput, step, type Game,
} from "@/vibecup/game";

const run = (g: Game, seconds: number, each?: (g: Game) => void) => {
  for (let t = 0; t < seconds; t += 1 / 60) {
    each?.(g);
    step(g, 1 / 60);
    g.events.length = 0;
  }
};

describe("Vibe Cup", () => {
  it("has six original clubs with distinct shirts", () => {
    expect(CLUBS).toHaveLength(6);
    expect(new Set(CLUBS.map((c) => c.shirt)).size).toBe(6);
  });

  it("kicks off with the ball at the forward's feet and ten players on the pitch", () => {
    const g = newGame({ seed: 3 });
    expect(g.players).toHaveLength(10);
    expect(g.ball.owner).toBeGreaterThanOrEqual(0);
    expect(g.players[g.ball.owner].role).toBe("fw");
    expect(g.phase).toBe("kickoff");
  });

  it("a watched match between two computer sides produces goals, saves and a result", () => {
    let goals = 0;
    let saves = 0;
    for (const seed of [1, 2, 3, 4]) {
      const g = newGame({ seed, humans: [] });
      for (let t = 0; t < MATCH_SECONDS + GOLDEN_SECONDS + 10 && g.phase !== "over"; t += 1 / 60) {
        step(g, 1 / 60);
        for (const e of g.events) {
          if (e.type === "goal") goals++;
          if (e.type === "save") saves++;
        }
        g.events.length = 0;
        // Never escapes the cage.
        expect(Math.abs(g.ball.y)).toBeLessThanOrEqual(16.1);
        expect(Math.abs(g.ball.x)).toBeLessThanOrEqual(L / 2 + 2.5);
        expect(g.ball.z).toBeGreaterThanOrEqual(BALL_R - 1e-6);
      }
      expect(g.phase).toBe("over");
    }
    // Four matches: plenty of goals, and keepers who do something.
    expect(goals).toBeGreaterThanOrEqual(4);
    expect(goals).toBeLessThan(80);
    expect(saves).toBeGreaterThan(0);
  });

  it("a hard shot from close range into an empty net is a goal", () => {
    const g = newGame({ seed: 5 });
    run(g, 1.5);
    const p = g.players[g.ctrls[0].active];
    // Move the keeper out of the way and put the ball at our forward's feet near goal.
    const keeper = g.players.find((k) => k.team === 1 && k.role === "gk")!;
    keeper.y = 12;
    keeper.x = 10;
    for (const o of g.players) if (o.team === 1 && o !== keeper) o.x = -20;
    p.x = L / 2 - 8;
    p.y = 0;
    p.face = 0;
    g.ball.owner = p.i;
    g.phase = "play";
    setInput(g, 0, { b: true, mx: 1, my: 0 });
    run(g, 0.4);
    setInput(g, 0, { b: false });
    let scored = false;
    for (let t = 0; t < 2 && !scored; t += 1 / 60) {
      step(g, 1 / 60);
      if (g.events.some((e) => e.type === "goal" && e.team === 0)) scored = true;
      g.events.length = 0;
    }
    expect(scored).toBe(true);
    expect(g.score[0]).toBe(1);
  });

  it("a tap of A passes to the team-mate the stick points at, and control follows", () => {
    const g = newGame({ seed: 9 });
    run(g, 1.5);
    const c = g.ctrls[0];
    const p = g.players[c.active];
    g.ball.owner = p.i;
    const target = passTarget(g, p, Math.PI);
    expect(target).not.toBeNull();
    setInput(g, 0, { a: true, mx: -1, my: 0 });
    step(g, 1 / 60);
    setInput(g, 0, { a: false, mx: 0, my: 0 });
    step(g, 1 / 60);
    expect(g.ball.owner).toBe(-1);
    expect(c.active).toBe(target!.i);
  });

  it("a slide into the carrier knocks the ball loose and the carrier over", () => {
    const g = newGame({ seed: 11 });
    run(g, 1.5);
    g.phase = "play";
    const c = g.ctrls[0];
    const me = g.players[c.active];
    const them = g.players.find((p) => p.team === 1 && p.role === "mf")!;
    g.ball.owner = them.i;
    them.x = 0;
    them.y = 0;
    me.x = -2.2;
    me.y = 0;
    me.cool = 0;
    setInput(g, 0, { b: true, mx: 1, my: 0 });
    step(g, 1 / 60);
    setInput(g, 0, { b: false, mx: 0 });
    let won = false;
    for (let i = 0; i < 30 && !won; i++) {
      step(g, 1 / 60);
      if (g.events.some((e) => e.type === "tackle" && e.team === 0)) won = true;
      g.events.length = 0;
    }
    expect(won).toBe(true);
    expect(them.stun).toBeGreaterThan(0);
  });

  it("goes to golden goal when level at full time", () => {
    const g = newGame({ seed: 2, humans: [] });
    g.phase = "play";
    g.clock = MATCH_SECONDS - 0.01;
    g.score = [1, 1];
    step(g, 1 / 30);
    expect(g.golden).toBe(true);
    expect(g.phase).toBe("play");
  });

  it("two people can play: each controller drives its own team", () => {
    const g = newGame({ seed: 4, humans: [0, 1] });
    expect(g.ctrls.map((c) => c.team)).toEqual([0, 1]);
    run(g, 20, (g) => {
      setInput(g, 0, autopilot(g, 0));
      setInput(g, 1, autopilot(g, 1));
    });
    for (const c of g.ctrls) expect(g.players[c.active].team).toBe(c.team);
  });

  it("the autopilot scores against the computer on easy", () => {
    let goals = 0;
    for (const seed of [21, 22]) {
      const g = newGame({ seed, difficulty: "easy" });
      run(g, 70, (g) => setInput(g, 0, autopilot(g, 0)));
      goals += g.score[0];
    }
    expect(goals).toBeGreaterThan(0);
  });

  it("goal mouth is wide enough to be fair", () => {
    expect(GOAL_W).toBeGreaterThan(5);
  });
});
