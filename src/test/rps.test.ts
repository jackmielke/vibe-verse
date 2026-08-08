/**
 * The table takes real balances off people, so the things worth testing are
 * the ones that would quietly cost somebody money:
 *
 * 1. **The rules resolve correctly and symmetrically.** A sign error in a
 *    three-way comparison is invisible by inspection and pays the wrong person
 *    every time it fires.
 * 2. **The client and the server agree on the terms.** The stake and the payout
 *    multipliers are written twice — once here so the button can say what a
 *    hand costs before you pay, and once in the edge function which decides.
 *    Same trap as the arcade paytables, so the same trick: read the deployed
 *    function's own source and compare.
 * 3. **The house has no edge.** "Dead fair, no rake" is a promise printed on
 *    the modal, and it is one line of arithmetic away from being false.
 * 4. **The commitment check actually rejects a swapped throw.** That function
 *    is the entire reason this game is trustworthy; a `verifyCommit` that
 *    returned `true` on everything would look identical in the UI.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { webcrypto } from "node:crypto";
import {
  RPS_PAYOUT,
  RPS_DEFAULT_STAKE,
  THROWS,
  outcomeLine,
  resolve,
  shortHash,
  verifyCommit,
  type Outcome,
  type Throw,
} from "@/rps/rps";

const FN = readFileSync(
  resolvePath(process.cwd(), "supabase/functions/vibe-rounds/index.ts"),
  "utf8",
);

/** jsdom has no WebCrypto; `verifyCommit` needs a real SHA-256. */
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("rock paper scissors — the rules", () => {
  it("resolves every pairing the way the playground does", () => {
    const wins: Array<[Throw, Throw]> = [
      ["rock", "scissors"],
      ["paper", "rock"],
      ["scissors", "paper"],
    ];
    for (const [winner, loser] of wins) {
      expect(resolve(winner, loser), `${winner} should beat ${loser}`).toBe("win");
      expect(resolve(loser, winner), `${loser} should lose to ${winner}`).toBe("lose");
    }
    for (const t of THROWS) expect(resolve(t, t)).toBe("push");
  });

  it("is symmetric — nobody wins from both sides", () => {
    for (const a of THROWS) {
      for (const b of THROWS) {
        const there = resolve(a, b);
        const back = resolve(b, a);
        if (there === "push") expect(back).toBe("push");
        if (there === "win") expect(back).toBe("lose");
        if (there === "lose") expect(back).toBe("win");
      }
    }
  });

  it("has exactly one win, one loss and one push per throw", () => {
    for (const a of THROWS) {
      const tally: Record<Outcome, number> = { win: 0, lose: 0, push: 0 };
      for (const b of THROWS) tally[resolve(a, b)] += 1;
      expect(tally).toEqual({ win: 1, lose: 1, push: 1 });
    }
  });

  it("describes the result without getting the direction backwards", () => {
    expect(outcomeLine("win", "rock", "scissors")).toMatch(/^Rock takes scissors/);
    expect(outcomeLine("lose", "rock", "paper")).toMatch(/^Paper takes rock/);
    expect(outcomeLine("push", "paper", "paper")).toMatch(/Both paper/);
  });
});

describe("rock paper scissors — the house has no edge", () => {
  it("pays back exactly what it takes, over every pairing", () => {
    // Every combination, once. With a uniform house this is the whole
    // distribution, and the player's expected return must be the stake itself.
    let staked = 0;
    let returned = 0;
    for (const p of THROWS) {
      for (const h of THROWS) {
        staked += RPS_DEFAULT_STAKE;
        returned += RPS_DEFAULT_STAKE * RPS_PAYOUT[resolve(p, h)];
      }
    }
    expect(returned).toBe(staked);
  });

  it("returns the ante on a tie rather than keeping it", () => {
    // The classic silent rake. If this ever becomes 0, the house takes a third
    // of every hand and the modal's "dead fair" line becomes a lie.
    expect(RPS_PAYOUT.push).toBe(1);
  });

  it("doubles a win and zeroes a loss", () => {
    expect(RPS_PAYOUT.win).toBe(2);
    expect(RPS_PAYOUT.lose).toBe(0);
  });
});

describe("rock paper scissors — client and server agree", () => {
  it("opens the picker on the same default the server would use", () => {
    const m = FN.match(/const\s+RPS_DEFAULT_STAKE\s*=\s*(\d+)/);
    expect(m, "RPS_DEFAULT_STAKE is missing from vibe-rounds").toBeTruthy();
    expect(Number(m![1])).toBe(RPS_DEFAULT_STAKE);
  });

  it("bounds the stake on the server, where the client cannot reach it", () => {
    /* The player names the stake now, which moves a number out of a constant
       and into a request body. If these bounds ever disappear, a hand for a
       hundred million becomes a valid request — and the check that the house
       can cover it is the only thing standing between that and a drained
       bankroll. */
    const lo = FN.match(/const\s+RPS_MIN_STAKE\s*=\s*(\d+)/);
    const hi = FN.match(/const\s+RPS_MAX_STAKE\s*=\s*(\d+)/);
    expect(lo, "RPS_MIN_STAKE is missing from vibe-rounds").toBeTruthy();
    expect(hi, "RPS_MAX_STAKE is missing from vibe-rounds").toBeTruthy();
    expect(Number(lo![1])).toBeGreaterThan(0);
    expect(Number(hi![1])).toBeGreaterThan(Number(lo![1]));
    // And the stake actually goes through the cleaner rather than the body.
    expect(FN).toMatch(/const stake = cleanStake\(b\.stake/);
    expect(FN).toMatch(/if \(n < RPS_MIN_STAKE\)/);
    expect(FN).toMatch(/if \(n > RPS_MAX_STAKE\)/);
  });

  it("still refuses to deal a hand the house could not pay out", () => {
    // Net exposure is one stake: the ante comes in, at most 2x goes out.
    expect(FN).toMatch(/if \(float < stake\)/);
  });

  it("pays the same multipliers the modal promises", () => {
    const m = FN.match(/const\s+RPS_PAYOUT\s*=\s*\{([^}]+)\}/);
    expect(m, "RPS_PAYOUT is missing from vibe-rounds").toBeTruthy();
    const server: Record<string, number> = {};
    for (const pair of m![1].matchAll(/(\w+)\s*:\s*([\d.]+)/g)) {
      server[pair[1]] = Number(pair[2]);
    }
    expect(server).toEqual({ win: RPS_PAYOUT.win, push: RPS_PAYOUT.push, lose: RPS_PAYOUT.lose });
  });

  it("resolves the same way on the server", () => {
    // The server's table of what beats what, pulled back out of its source.
    const m = FN.match(/const beats: Record<Throw, Throw> = \{([^}]+)\}/);
    expect(m, "the server's beats table is missing").toBeTruthy();
    for (const pair of m![1].matchAll(/(\w+)\s*:\s*"(\w+)"/g)) {
      expect(resolve(pair[1] as Throw, pair[2] as Throw)).toBe("win");
    }
  });

  it("keeps the house on a wallet kind the balances table allows", () => {
    // vibe_balances.owner_kind is CHECKed to ('user','agent'). A 'system'
    // house would fail on the very first ante, in production, at the table.
    const m = FN.match(/const\s+RPS_HOUSE_KIND\s*=\s*"(\w+)"/);
    expect(m, "RPS_HOUSE_KIND is missing from vibe-rounds").toBeTruthy();
    expect(["user", "agent"]).toContain(m![1]);
  });
});

describe("rock paper scissors — the commitment", () => {
  it("accepts a reveal that matches what was sealed", async () => {
    const commit = await sha256Hex("rock:deadbeefdeadbeef");
    expect(await verifyCommit("rock", "deadbeefdeadbeef", commit)).toBe(true);
  });

  it("rejects a house that swapped its throw after seeing yours", async () => {
    // The attack the whole scheme exists to stop: commit to rock, then claim
    // paper because the player threw scissors.
    const commit = await sha256Hex("rock:deadbeefdeadbeef");
    expect(await verifyCommit("paper", "deadbeefdeadbeef", commit)).toBe(false);
  });

  it("rejects a tampered nonce", async () => {
    const commit = await sha256Hex("scissors:abc123");
    expect(await verifyCommit("scissors", "abc124", commit)).toBe(false);
  });

  it("says 'cannot check' rather than 'cheated' with no WebCrypto", async () => {
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    try {
      expect(await verifyCommit("rock", "x", "y")).toBeNull();
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: real, configurable: true });
    }
  });

  it("hashes the same way the server does", async () => {
    // Both sides must agree on the exact preimage, separator included — a
    // mismatch here would flag every honest hand as tampered.
    expect(FN).toContain('sha256Hex(`${houseThrow}:${nonce}`)');
    const commit = await sha256Hex("paper:0011aabb");
    expect(await verifyCommit("paper", "0011aabb", commit)).toBe(true);
  });

  it("shortens a hash without hiding whether two differ", () => {
    const a = "a".repeat(64);
    const b = "a".repeat(58) + "bbbbbb";
    expect(shortHash(a)).not.toBe(shortHash(b));
    expect(shortHash("short")).toBe("short");
  });
});
