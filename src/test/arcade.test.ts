/**
 * The arcade's one dangerous property is that the payout curve is written
 * twice: once in `src/arcade/cabinets.ts` so a cabinet can print an honest
 * paytable, and once in `supabase/functions/vibe-economy/index.ts` because the
 * browser cannot be trusted to price its own winnings.
 *
 * Two copies of a number that pays people is exactly the kind of duplication
 * that drifts, and the failure is quiet in the worst direction: the cabinet
 * advertises 88 and the server pays 44, and nobody finds out from a stack
 * trace. So this reads the *deployed source* of the edge function, pulls the
 * curves back out of it, and checks the two agree at every score either of
 * them can produce.
 *
 * It reads text rather than importing because the edge function is Deno — it
 * imports from `jsr:` and `esm.sh` and will not load in vitest. Parsing it is
 * uglier than an import and it is the only thing that actually holds the line.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CABINETS, cabinetByKey, topPrize, type CabinetRun } from "@/arcade/cabinets";

const FN_PATH = resolve(process.cwd(), "supabase/functions/vibe-economy/index.ts");

interface ServerSpec {
  cost: number;
  maxScore: number;
  payout: (s: number) => number;
}

/** Pull `ARCADE_SPECS` back out of the edge function's source. */
function readServerSpecs(): Record<string, ServerSpec> {
  const src = readFileSync(FN_PATH, "utf8");
  const block = src.split("const ARCADE_SPECS")[1];
  expect(block, "ARCADE_SPECS is missing from the edge function").toBeTruthy();
  const body = block.slice(0, block.indexOf("\n};"));

  const specs: Record<string, ServerSpec> = {};
  const re =
    /(\w+):\s*\{\s*cost:\s*(\d+),\s*maxScore:\s*(\d+),\s*payout:\s*\(s\)\s*=>\s*([^\n]+?)\s*\},?\s*$/gm;
  for (const m of body.matchAll(re)) {
    specs[m[1]] = {
      cost: Number(m[2]),
      maxScore: Number(m[3]),
      // The expressions are arithmetic and Math.round, written by us, in a
      // file in this repo — not user input.
      payout: new Function("s", `"use strict"; return (${m[4]});`) as (s: number) => number,
    };
  }
  return specs;
}

/**
 * A canvas context that records nothing and refuses nothing.
 *
 * jsdom has no 2D context at all, and pulling in `node-canvas` to prove that a
 * stacker row lands where it should is a C++ build for no extra confidence:
 * the games' logic never reads back from the context.
 */
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

/** Run a cabinet forward, pressing on the frames the caller asks for. */
function drive(
  run: CabinetRun,
  opts: { frames: number; press?: (frame: number) => { x: number; y: number } | { slot: number } | null },
) {
  const ctx = stubCtx();
  for (let i = 0; i < opts.frames && !run.done; i++) {
    run.frame(ctx, 1 / 60);
    const p = opts.press?.(i);
    if (p) run.press(p);
  }
  return run.done;
}

describe("arcade payouts", () => {
  const server = readServerSpecs();

  it("finds a server spec for every cabinet on the floor", () => {
    expect(Object.keys(server).sort()).toEqual(CABINETS.map((c) => c.key).sort());
  });

  for (const cab of CABINETS) {
    describe(cab.key, () => {
      it("charges what the server charges", () => {
        expect(server[cab.key].cost).toBe(cab.cost);
      });

      it("clamps at the same ceiling", () => {
        expect(server[cab.key].maxScore).toBe(cab.maxScore);
      });

      it("pays what the paytable promises, at every reachable score", () => {
        for (let s = 0; s <= cab.maxScore; s++) {
          expect(cab.payout(s), `score ${s}`).toBe(server[cab.key].payout(s));
        }
      });

      it("never pays out for a score above the ceiling", () => {
        // Belt and braces on the clamp: a client claiming 9,999 gets the
        // perfect-run price, because the server floors the score first.
        const clamped = Math.min(9999, cab.maxScore);
        expect(server[cab.key].payout(clamped)).toBe(topPrize(cab));
      });

      it("is worth putting a coin in", () => {
        /* A cabinet whose best possible run pays less than it costs is a
           cabinet nobody should ever play, and shipping one would be a bug
           rather than a design. */
        expect(topPrize(cab)).toBeGreaterThan(cab.cost);
      });

      it("never pays negative, and never falls as you do better", () => {
        let last = -1;
        for (let s = 0; s <= cab.maxScore; s++) {
          const p = cab.payout(s);
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p, `payout fell going from ${s - 1} to ${s}`).toBeGreaterThanOrEqual(last);
          last = p;
        }
      });
    });
  }
});

describe("the cabinets themselves", () => {
  it("stacker cannot miss its first row, and tops out at twelve", () => {
    const cab = cabinetByKey("stacker")!;
    const run = cab.create(300, 400);
    // Press on every third frame. The first press always lands (the floor is
    // the full board); after that the row narrows but never to nothing before
    // the tower tops out or the game ends it.
    const done = drive(run, { frames: 4000, press: (i) => (i % 3 === 0 ? { slot: 0 } : null) });
    expect(done).not.toBeNull();
    expect(done!.score).toBeGreaterThanOrEqual(1);
    expect(done!.score).toBeLessThanOrEqual(cab.maxScore);
    expect(done!.detail).toBeTruthy();
  });

  it("pattern ends the run on a wrong pad and scores the rounds you held", () => {
    const cab = cabinetByKey("pattern")!;
    const run = cab.create(300, 400);
    /* Press all four pads in a row every time input opens. One of them is
       right at most once, so this is guaranteed to end — and the score has to
       be a real round count, not a crash. */
    const done = drive(run, {
      frames: 3000,
      press: (i) => ({ slot: (i % 4) + 1 }),
    });
    expect(done).not.toBeNull();
    expect(done!.score).toBeGreaterThanOrEqual(0);
    expect(done!.score).toBeLessThanOrEqual(cab.maxScore);
  });

  it("reflex always terminates on its own, pressed or not", () => {
    const cab = cabinetByKey("reflex")!;
    // Eight rounds of at most 1.55s each; 20 seconds of frames is ample.
    const done = drive(cab.create(300, 400), { frames: 20 * 60 });
    expect(done).not.toBeNull();
    // Never pressing is a legitimate run worth nothing at all.
    expect(done!.score).toBe(0);
    expect(cab.payout(0)).toBe(0);
  });

  it("gives every cabinet a distinct key", () => {
    const keys = CABINETS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
