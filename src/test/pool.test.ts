/**
 * 8-Ball Club: the physics and rules that decide every game, run headless.
 */
import { describe, expect, it } from "vitest";
import { POCKETS, R, cloneBalls, makeBall, simulate, strike, emptyRecord } from "@/pool/physics";
import { newGame, resolveShot, cloneState, legalTargets, onEight, type PoolState } from "@/pool/rules";
import { planNow } from "@/pool/ai";

const shot = (balls: ReturnType<typeof makeBall>[], angle: number, speed: number, spinX = 0, spinY = 0) => {
  strike(balls[0], { angle, speed, spinX, spinY });
  return simulate(balls);
};

describe("the cloth", () => {
  it("draws the cue ball back with low spin and follows with top", () => {
    // A straight pot into the corner, so the object ball is gone and cannot
    // roll back into the cue ball. Measure how far along the line it ends.
    const p = POCKETS[1];
    const ob = { x: 0.55, y: 0.22 };
    const a = Math.atan2(p.my - ob.y, p.mx - ob.x);
    const run = (sy: number) => {
      const b = [makeBall(0, ob.x - Math.cos(a) * 0.35, ob.y - Math.sin(a) * 0.35), makeBall(1, ob.x, ob.y)];
      shot(b, a, 1.6, 0, sy);
      return (b[0].x - ob.x) * Math.cos(a) + (b[0].y - ob.y) * Math.sin(a);
    };
    const draw = run(-0.9);
    const stun = run(0);
    const follow = run(0.9);
    expect(draw).toBeLessThan(-0.15);
    expect(follow).toBeGreaterThan(stun);
    expect(stun).toBeGreaterThan(draw);
  });

  it("pots a straight-in ball in the corner", () => {
    const p = POCKETS[1];
    const ob = { x: 0.6, y: 0.25 };
    const a = Math.atan2(p.my - ob.y, p.mx - ob.x);
    const b = [makeBall(0, ob.x - Math.cos(a) * 0.5, ob.y - Math.sin(a) * 0.5), makeBall(1, ob.x, ob.y)];
    const rec = shot(b, a, 1.5, 0, -0.5);
    expect(rec.potted.map((x) => x.ball)).toContain(1);
    expect(rec.firstHit).toBe(1);
  });

  it("brings a break to rest with every ball still on or in a pocket", () => {
    const s = newGame(3);
    const balls = cloneBalls(s.balls);
    const rec = shot(balls, 0, 6.6);
    for (const b of balls) {
      if (b.on) {
        expect(Math.abs(b.x)).toBeLessThan(0.99 - R + 1e-3);
        expect(Math.abs(b.y)).toBeLessThan(0.495 - R + 1e-3);
      }
    }
    expect(rec.railBalls.length).toBeGreaterThan(3);
  });
});

describe("the rules", () => {
  const after = (s: PoolState, mutate: (b: PoolState["balls"]) => void, rec: Partial<ReturnType<typeof emptyRecord>>) => {
    const balls = cloneBalls(s.balls);
    mutate(balls);
    return resolveShot(s, balls, { ...emptyRecord(), ...rec });
  };
  const open = (): PoolState => { const s = newGame(1); s.isBreak = false; s.ballInHand = false; s.kitchen = false; return s; };

  it("racks the 8 in the middle and a solid and stripe in the back corners", () => {
    const s = newGame(9);
    const byX = [...s.balls].filter((b) => b.id).sort((a, b) => a.x - b.x || a.y - b.y);
    expect(byX[4].id).toBe(8);
    const back = byX.slice(10);
    const corners = [back[0], back[4]].map((b) => (b.id < 8 ? "s" : "t")).sort().join("");
    expect(corners).toBe("st");
  });

  it("claims a group for whoever pots first on an open table", () => {
    const s = open();
    const { state, outcome } = after(s, (b) => { b[3].on = false; }, { firstHit: 3, railAfterContact: true, potted: [{ ball: 3, pocket: 0 }] });
    expect(state.groups).toEqual(["solids", "stripes"]);
    expect(outcome.again).toBe(true);
    expect(state.turn).toBe(0);
  });

  it("hands over ball in hand on a scratch", () => {
    const s = open();
    const { state } = after(s, (b) => { b[0].on = false; }, { firstHit: 2, potted: [{ ball: 0, pocket: 1 }] });
    expect(state.turn).toBe(1);
    expect(state.ballInHand).toBe(true);
    expect(state.balls[0].on).toBe(true);
  });

  it("fouls the wrong group first", () => {
    const s = open();
    s.groups = ["solids", "stripes"];
    const { outcome } = after(s, () => {}, { firstHit: 12, railAfterContact: true });
    expect(outcome.foul).toBe("Wrong ball first");
  });

  it("loses on the 8 early, wins on the 8 in the called pocket", () => {
    const s = open();
    s.groups = ["solids", "stripes"];
    expect(after(s, (b) => { b[8].on = false; }, { firstHit: 1, potted: [{ ball: 8, pocket: 2 }] }).state.winner).toBe(1);
    for (let i = 1; i <= 7; i++) s.balls[i].on = false;
    expect(onEight(s)).toBe(true);
    expect(legalTargets(s)).toEqual([8]);
    s.called = 4;
    expect(after(s, (b) => { b[8].on = false; }, { firstHit: 8, potted: [{ ball: 8, pocket: 4 }] }).state.winner).toBe(0);
    expect(after(s, (b) => { b[8].on = false; }, { firstHit: 8, potted: [{ ball: 8, pocket: 1 }] }).state.winner).toBe(1);
  });

  it("respots the 8 when it drops on the break", () => {
    const s = newGame(2);
    const { state } = after(s, (b) => { b[8].on = false; }, { firstHit: 1, potted: [{ ball: 8, pocket: 1 }] });
    expect(state.winner).toBeNull();
    expect(state.balls[8].on).toBe(true);
  });
});

describe("the computer", () => {
  it("finishes a whole game against itself", () => {
    let s = newGame(4);
    let n = 0;
    while (s.phase !== "over" && n < 150) {
      const p = planNow(s, "hard");
      const before = cloneState(s);
      before.called = p.called;
      if (p.place) { before.balls[0].x = p.place.x; before.balls[0].y = p.place.y; }
      const balls = cloneBalls(before.balls);
      strike(balls[0], p);
      s = resolveShot(before, balls, simulate(balls)).state;
      n++;
    }
    expect(s.winner).not.toBeNull();
  }, 60000);
});
