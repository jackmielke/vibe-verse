/**
 * The celebration wire, tested where it can actually be wrong.
 *
 * This module exists so a payout can make a logo dance from three components
 * away, which means it sits directly in the path of the thing that pays people.
 * The whole design rests on one promise — **a celebration can never cost a
 * payout** — and that promise is a negative: a listener that throws would take
 * the balance update down with it, and nothing about that failure looks like a
 * confetti bug. So it is asserted rather than commented.
 *
 * The other two are the contract callers rely on: unsubscribing actually stops
 * delivery (a `VibeArc` that unmounts mid-run must not keep animating a canvas
 * that is gone), and a balance that goes *down* is not a celebration.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { celebrate, onCelebrate } from "@/lib/celebrate";
import { applyLocalDelta } from "@/lib/vibecoin";

describe("celebrate", () => {
  const offs: Array<() => void> = [];
  const sub = (fn: Parameters<typeof onCelebrate>[0]) => {
    const off = onCelebrate(fn);
    offs.push(off);
    return off;
  };

  beforeEach(() => {
    while (offs.length) offs.pop()!();
  });

  it("delivers the reason and magnitude to every listener", () => {
    const a = vi.fn();
    const b = vi.fn();
    sub(a);
    sub(b);

    celebrate("vibecoin", 12);

    expect(a).toHaveBeenCalledWith({ reason: "vibecoin", magnitude: 12 });
    expect(b).toHaveBeenCalledWith({ reason: "vibecoin", magnitude: 12 });
  });

  it("keeps paying out when a listener throws", () => {
    const boom = vi.fn(() => {
      throw new Error("canvas is gone");
    });
    const after = vi.fn();
    sub(boom);
    sub(after);

    /* The emitter is called from inside the code that credits a wallet. If a
       broken animation can throw out of here, it takes the credit with it. */
    expect(() => celebrate("vibecoin", 1)).not.toThrow();
    expect(boom).toHaveBeenCalled();
    expect(after).toHaveBeenCalled();
  });

  it("stops delivering once unsubscribed", () => {
    const fn = vi.fn();
    const off = sub(fn);

    celebrate("first");
    off();
    celebrate("second");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ reason: "first", magnitude: undefined });
  });
});

describe("the vibecoin balance is the thing that celebrates", () => {
  it("fires when the balance rises, and stays quiet otherwise", () => {
    const seen: Array<number | undefined> = [];
    const off = onCelebrate((c) => {
      if (c.reason === "vibecoin") seen.push(c.magnitude);
    });

    /* First number of the session, arriving from nothing. A cold page that
       discovers you already had 4,000 coins has nothing to celebrate — you
       earned those yesterday. */
    applyLocalDelta(10);
    applyLocalDelta(24);
    /* Spending is a thing you chose. The mark should sit still. */
    applyLocalDelta(-30);
    /* And a re-assert of the same number is not a payout — an arcade run
       trips the balance three times for one. */
    applyLocalDelta(0);

    off();

    expect(seen).toEqual([24]);
  });
});
