/**
 * ORBIT is the only game in the vibeverse with money on it, so it is held to
 * things the other worlds are not.
 *
 * Three properties, in rough order of how much a broken one would cost:
 *
 * 1. **Two people on the same seed fly the same sky.** A round is ten friends
 *    betting on one layout. If the layout depends on frame rate, screen size or
 *    the wall clock, the pot goes to whoever had the better laptop and the whole
 *    premise is a lie.
 * 2. **The server's cheat floor must not catch honest players.** `round_score`
 *    refuses a score that needed less than `MIN_MS_PER_GATE` per gate. That
 *    constant lives in the edge function and is *derived* from the physics in
 *    `orbit.ts` — two numbers in two files that have to stay in agreement, which
 *    is exactly the kind of pair that drifts. Here it is checked against
 *    actually-simulated runs rather than against arithmetic.
 * 3. **Nothing happens until you press.** Without that the probe hits the
 *    atmosphere in under a second and a first-time player dies before they have
 *    read the instructions — which is how it shipped the first time.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOrbit, type OrbitRun } from "@/orbit/orbit";

const FN_PATH = resolve(process.cwd(), "supabase/functions/vibe-rounds/index.ts");

/** The server's per-gate floor, read out of the deployed function's source. */
function serverMinMsPerGate(): number {
  const src = readFileSync(FN_PATH, "utf8");
  const m = src.match(/const\s+MIN_MS_PER_GATE\s*=\s*(\d+)/);
  expect(m, "MIN_MS_PER_GATE is missing from vibe-rounds").toBeTruthy();
  return Number(m![1]);
}

function serverMaxScore(): number {
  const src = readFileSync(FN_PATH, "utf8");
  const m = src.match(/const\s+ROUND_MAX_SCORE\s*=\s*(\d+)/);
  expect(m, "ROUND_MAX_SCORE is missing from vibe-rounds").toBeTruthy();
  return Number(m![1]);
}

/** Draws nothing, refuses nothing. See the note in `arcade.test.ts`. */
function stubCtx(): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => {} };
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "createLinearGradient" || prop === "createRadialGradient") {
        return () => gradient;
      }
      if (prop === "measureText") return () => ({ width: 10 });
      if (prop in target) return target[prop as string];
      return () => {};
    },
    set(_t, prop, value) {
      target[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

interface Flight {
  score: number;
  elapsedMs: number;
  detail: string;
  frames: number;
}

/**
 * Fly a run to its end with a given policy.
 *
 * `dt` is the *wall-clock* step handed to `frame()`, deliberately variable in
 * some tests: the simulation is supposed to be fixed-timestep underneath, and
 * the only way to prove it is to feed it uneven frames and demand the same
 * answer.
 */
function fly(
  run: OrbitRun,
  policy: (frame: number, run: OrbitRun) => boolean,
  dt: number | ((frame: number) => number) = 1 / 60,
  maxFrames = 20000,
): Flight {
  const ctx = stubCtx();
  let f = 0;
  for (; f < maxFrames && !run.done; f++) {
    run.setThrust(policy(f, run));
    run.frame(ctx, typeof dt === "number" ? dt : dt(f));
  }
  return {
    score: run.done?.score ?? run.score,
    elapsedMs: run.elapsedMs,
    detail: run.done?.detail ?? "(still flying)",
    frames: f,
  };
}

/**
 * A hover: hold, release, hold, release, on a cadence that nets out to zero.
 *
 * Thrust is +360 units/s² net and gravity is −300, so a duty cycle of
 * 300/660 ≈ 0.4545 holds altitude. Five frames on, six off, is 0.4545 exactly.
 *
 * It is deliberately blind — it never asks the run where the gates are, and so
 * what it scores says something real about whether a person who has not learned
 * the layout can survive, rather than about what an oracle could do.
 */
function hover() {
  return (f: number) => f % 11 < 5;
}

describe("ORBIT", () => {
  const MIN_MS_PER_GATE = serverMinMsPerGate();

  it("does not move until the first press", () => {
    const run = createOrbit(960, 600, "armed-seed");
    const ctx = stubCtx();
    // Four seconds of frames with no input at all. Un-armed, the probe would
    // have hit the atmosphere in about eight tenths of a second.
    for (let i = 0; i < 240; i++) run.frame(ctx, 1 / 60);
    expect(run.done).toBeNull();
    expect(run.elapsedMs).toBe(0);

    run.setThrust(true);
    for (let i = 0; i < 60; i++) run.frame(ctx, 1 / 60);
    expect(run.elapsedMs).toBeGreaterThan(0);
  });

  it("counts only flown time, not the wait on the launch pad", () => {
    const run = createOrbit(960, 600, "clock-seed");
    const ctx = stubCtx();
    for (let i = 0; i < 600; i++) run.frame(ctx, 1 / 60); // 10s on the pad
    const policy = hover();
    for (let i = 0; i < 120; i++) {
      run.setThrust(policy(i));
      run.frame(ctx, 1 / 60); // 2s flown
    }
    // Two seconds, not twelve — otherwise a player could bank cheat-floor
    // headroom just by leaving the tab open before touching it.
    expect(run.elapsedMs).toBeGreaterThan(1800);
    expect(run.elapsedMs).toBeLessThan(2200);
  });

  it("has no hidden clock or randomness — a replay is bit-identical", () => {
    const policy = hover();
    const a = fly(createOrbit(960, 600, "replay"), policy);
    const b = fly(createOrbit(960, 600, "replay"), policy);
    expect(b).toEqual(a);
  });

  /**
   * Note what this does *not* claim. Thrust is sampled once per animation
   * frame, so a frame-indexed policy genuinely diverges between 24fps and
   * 144fps — that is input, not simulation, and a human pressing a key is not
   * frame-indexed anyway. What must hold is that for an input that does not
   * change, the integration lands in the same place however the frames fall.
   */
  it("integrates the same however the frames fall", () => {
    const jitter = (f: number) => (f % 7 === 0 ? 1 / 24 : f % 3 === 0 ? 1 / 144 : 1 / 60);
    const burn = () => true;
    const steady = fly(createOrbit(960, 600, "shared-sky"), burn, 1 / 60);
    const jittery = fly(createOrbit(960, 600, "shared-sky"), burn, jitter);
    expect(jittery.score).toBe(steady.score);
    expect(jittery.detail).toBe(steady.detail);
    // Fixed timestep, so simulated time lands on the same multiple of 1/120.
    expect(Math.abs(jittery.elapsedMs - steady.elapsedMs)).toBeLessThan(20);
  });

  it("gives different seeds different skies", () => {
    const policy = hover();
    const scores = ["a", "b", "c", "d", "e", "f"].map(
      (s) => fly(createOrbit(960, 600, `sky-${s}`), policy).score,
    );
    expect(new Set(scores).size).toBeGreaterThan(1);
  });

  it("does not depend on the size of the canvas", () => {
    const policy = hover();
    const wide = fly(createOrbit(1440, 900, "same-sky"), policy);
    const phone = fly(createOrbit(390, 700, "same-sky"), policy);
    expect(phone.score).toBe(wide.score);
  });

  it("is survivable, and not a walkover", () => {
    const runs = Array.from({ length: 12 }, (_, i) =>
      fly(createOrbit(960, 600, `survive-${i}`), hover()),
    );
    const best = Math.max(...runs.map((r) => r.score));
    const scored = runs.filter((r) => r.score > 0).length;

    // The floor: a blind hover — a player who has not yet learned to aim —
    // gets through gates rather than dying on the first one every time. Most
    // runs score, and the good ones reach a handful.
    expect(scored).toBeGreaterThanOrEqual(7);
    expect(best).toBeGreaterThanOrEqual(3);

    // The ceiling, and the reason this test exists in both directions: nobody
    // who cannot see the gates should be able to grind a big number. If a blind
    // policy starts clearing twenty, the gates are too wide to be worth betting
    // on and the difficulty curve needs looking at.
    expect(best).toBeLessThan(15);
  });

  it("every run ends, and ends with a reason", () => {
    for (let i = 0; i < 8; i++) {
      const run = createOrbit(960, 600, `ends-${i}`);
      const f = fly(run, hover());
      expect(run.done, `seed ends-${i} never finished`).not.toBeNull();
      expect(f.detail.length).toBeGreaterThan(8);
      expect(f.score).toBeGreaterThanOrEqual(0);
      expect(f.score).toBeLessThanOrEqual(serverMaxScore());
    }
  });

  /**
   * The one that would actually cost somebody the pot. If a legal run can clear
   * gates faster than the server believes is possible, `round_score` silently
   * files the honest player's best run down and the wrong person wins.
   */
  it("no honest run beats the server's cheat floor", () => {
    const offenders: string[] = [];
    for (let i = 0; i < 24; i++) {
      const seed = `floor-${i}`;
      // Two policies: a steady hover, and a hard climb — the fastest legal way
      // to sweep through gates is to be moving, so the aggressive one is the
      // one likely to trip the floor.
      for (const [name, policy] of [
        ["hover", hover()],
        ["climb", (f: number) => f % 4 !== 0],
        ["dive", (f: number) => f % 9 === 0],
      ] as const) {
        const f = fly(createOrbit(960, 600, seed), policy);
        if (f.score > 0 && f.elapsedMs < f.score * MIN_MS_PER_GATE) {
          offenders.push(
            `${seed}/${name}: ${f.score} gates in ${Math.round(f.elapsedMs)}ms ` +
              `(server allows ${f.score * MIN_MS_PER_GATE}ms)`,
          );
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
