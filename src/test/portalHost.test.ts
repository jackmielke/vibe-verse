/**
 * The bridge, tested where it can actually be wrong.
 *
 * Everything about the portal that matters is a *negative*: what a stranger's
 * game does NOT get. Negatives do not fail loudly — a leaked session id looks
 * exactly like a working feature until somebody drains a budget with it. So
 * these are the four things that must stay true, asserted rather than
 * commented:
 *
 *   1. a message from the wrong origin is ignored;
 *   2. a message from the wrong window is ignored, even on the right origin;
 *   3. the session id never appears in anything sent INTO the frame;
 *   4. a game supplying its own session id is spending the host's, not its own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveOrigin, startBridge } from "@/portal/host";
import type { PortalSession } from "@/portal/api";

const awardFromPortal = vi.hoisted(() => vi.fn());
vi.mock("@/portal/api", () => ({ awardFromPortal }));

const SESSION_ID = "3f1a9c7e-1111-4222-8333-444455556666";

const SESSION: PortalSession = {
  sessionId: SESSION_ID,
  game: {
    slug: "somebody-elses",
    title: "Somebody Else's Game",
    tagline: null,
    author: "A stranger",
    authorUrl: null,
    embedUrl: "https://games.example.com/g/",
    origin: "https://games.example.com",
    maxAward: 10,
  },
  headroom: 40,
  remainingToday: 900,
};

/** A stand-in for the frame's `contentWindow` that records what it is sent. */
function fakeFrame() {
  const sent: unknown[] = [];
  const contentWindow = {
    postMessage: (msg: unknown) => {
      sent.push(msg);
    },
  };
  return { frame: { contentWindow } as unknown as HTMLIFrameElement, sent, contentWindow };
}

/** Deliver a message as if it had come from `source` at `origin`. */
function deliver(origin: string, source: unknown, data: unknown) {
  const e = new MessageEvent("message", { data, origin });
  // jsdom will not let `source` be an arbitrary object through the
  // constructor, so it is defined onto the event directly.
  Object.defineProperty(e, "source", { value: source });
  window.dispatchEvent(e);
}

function callbacks() {
  return { onAward: vi.fn(), onExit: vi.fn(), onReady: vi.fn() };
}

describe("resolveOrigin", () => {
  it("keeps a real origin exactly as approved", () => {
    expect(resolveOrigin("https://games.example.com")).toBe("https://games.example.com");
  });

  it("resolves `self` to wherever the vibeverse is running", () => {
    // One row works in dev, preview and production — which is the point of
    // storing a keyword instead of three copies of a URL that can drift.
    expect(resolveOrigin("self")).toBe(window.location.origin);
  });
});

describe("the portal bridge", () => {
  beforeEach(() => {
    awardFromPortal.mockReset();
    awardFromPortal.mockResolvedValue({
      amount: 6, balance: 106, capped: true, headroom: 34, asked: 999,
    });
  });

  it("answers a handshake from the approved origin", () => {
    const { frame, sent, contentWindow } = fakeFrame();
    const cb = callbacks();
    const bridge = startBridge(frame, SESSION, cb);

    deliver("https://games.example.com", contentWindow, { type: "vibeverse:ready" });

    expect(cb.onReady).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    bridge.stop();
  });

  it("ignores a game on the wrong origin", () => {
    const { frame, sent, contentWindow } = fakeFrame();
    const cb = callbacks();
    const bridge = startBridge(frame, SESSION, cb);

    // The approved origin with one extra label — the shape of a real attack,
    // and the reason this is an equality check and not a `startsWith`.
    deliver("https://games.example.com.evil.test", contentWindow, { type: "vibeverse:ready" });
    deliver("https://games.example.com.evil.test", contentWindow, { type: "vibeverse:award", amount: 5 });
    deliver("https://games.example.com.evil.test", contentWindow, { type: "vibeverse:exit" });

    expect(cb.onReady).not.toHaveBeenCalled();
    expect(cb.onExit).not.toHaveBeenCalled();
    expect(awardFromPortal).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    bridge.stop();
  });

  it("ignores the right origin from the wrong window", () => {
    // A second frame on an approved origin, or the host page talking to
    // itself. Origin alone would wave both of these through.
    const { frame, contentWindow } = fakeFrame();
    const cb = callbacks();
    const bridge = startBridge(frame, SESSION, cb);

    deliver("https://games.example.com", { notTheFrame: true }, { type: "vibeverse:exit" });
    deliver("https://games.example.com", window, { type: "vibeverse:exit" });

    expect(cb.onExit).not.toHaveBeenCalled();

    // …and the real frame still works, so this is a check and not a wall.
    deliver("https://games.example.com", contentWindow, { type: "vibeverse:exit" });
    expect(cb.onExit).toHaveBeenCalledOnce();
    bridge.stop();
  });

  it("never sends the session id into the frame", async () => {
    const { frame, sent, contentWindow } = fakeFrame();
    const bridge = startBridge(frame, SESSION, callbacks());

    deliver("https://games.example.com", contentWindow, { type: "vibeverse:ready" });
    deliver("https://games.example.com", contentWindow, {
      type: "vibeverse:award", id: "x1", amount: 3,
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    // The one capability that can move money stays on this side of the fence.
    // Serialised whole rather than key-by-key, so a future field that happens
    // to carry it cannot slip past.
    expect(JSON.stringify(sent)).not.toContain(SESSION_ID);
    bridge.stop();
  });

  it("spends the host's session, not the one the game supplied", async () => {
    const { frame, contentWindow } = fakeFrame();
    const bridge = startBridge(frame, SESSION, callbacks());

    deliver("https://games.example.com", contentWindow, {
      type: "vibeverse:award",
      id: "x2",
      amount: 4,
      // A game that has read the docs and guessed at the protocol.
      sessionId: "00000000-0000-0000-0000-000000000000",
    });

    await vi.waitFor(() => expect(awardFromPortal).toHaveBeenCalled());
    expect(awardFromPortal).toHaveBeenCalledWith(SESSION_ID, 4, undefined);
    bridge.stop();
  });

  it("refuses an amount that is not a positive number, without asking the server", async () => {
    const { frame, sent, contentWindow } = fakeFrame();
    const bridge = startBridge(frame, SESSION, callbacks());

    deliver("https://games.example.com", contentWindow, { type: "vibeverse:award", id: "n", amount: -50 });
    deliver("https://games.example.com", contentWindow, { type: "vibeverse:award", id: "s", amount: "lots" });

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(awardFromPortal).not.toHaveBeenCalled();
    for (const m of sent) expect((m as { ok: boolean }).ok).toBe(false);
    bridge.stop();
  });

  it("reports what was paid, not what was asked", async () => {
    const { frame, sent, contentWindow } = fakeFrame();
    const cb = callbacks();
    const bridge = startBridge(frame, SESSION, cb);

    deliver("https://games.example.com", contentWindow, { type: "vibeverse:award", id: "big", amount: 999 });
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    // The whole reason `award()` resolves with an object instead of nothing:
    // a game that draws the number it asked for lies to the player the first
    // time a budget bites.
    const reply = sent[0] as { amount: number; asked: number; capped: boolean };
    expect(reply.amount).toBe(6);
    expect(reply.asked).toBe(999);
    expect(reply.capped).toBe(true);
    expect(cb.onAward).toHaveBeenCalledOnce();
    bridge.stop();
  });

  it("stops listening after stop()", () => {
    const { frame, contentWindow } = fakeFrame();
    const cb = callbacks();
    startBridge(frame, SESSION, cb).stop();

    deliver("https://games.example.com", contentWindow, { type: "vibeverse:exit" });
    expect(cb.onExit).not.toHaveBeenCalled();
  });
});
