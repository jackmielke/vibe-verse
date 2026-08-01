/**
 * The fleet's bookkeeping.
 *
 * This sandbox cannot reach Supabase, so the socket itself is unprovable here —
 * what is provable is everything around it: that a refused connection is inert
 * rather than fatal, that a ship whose tab vanished stops being drawn, that
 * names and colours from other people are sanitised before they reach a canvas,
 * and that disposing actually lets go of the channel.
 *
 * The channel is faked at the module boundary, which also lets the presence and
 * broadcast handlers be driven directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Handler = (arg: unknown) => void;
const handlers: Record<string, Handler> = {};
let subscribeStatus = "SUBSCRIBED";
let tracked: unknown[] = [];
let sent: unknown[] = [];
let removed = 0;
let untracked = 0;
let presence: Record<string, Array<Record<string, unknown>>> = {};
let throwOnChannel = false;

vi.mock("@/integrations/supabase/client", () => {
  const channel = {
    params: { config: { presence: { key: "me-key" } } },
    on(kind: string, opts: { event: string }, cb: Handler) {
      handlers[`${kind}:${opts.event}`] = cb;
      return channel;
    },
    subscribe(cb: (s: string) => void) { cb(subscribeStatus); return channel; },
    presenceState: () => presence,
    track: (v: unknown) => { tracked.push(v); return Promise.resolve(); },
    untrack: () => { untracked++; return Promise.resolve(); },
    send: (v: unknown) => { sent.push(v); return Promise.resolve(); },
  };
  return {
    supabase: {
      channel: () => { if (throwOnChannel) throw new Error("no realtime"); return channel; },
      removeChannel: () => { removed++; return Promise.resolve(); },
    },
  };
});

const { joinFleet } = await import("@/lib/vibeverseFleet");

const sync = () => handlers["presence:sync"]?.(undefined);
const nav = (payload: Record<string, unknown>) => handlers["broadcast:nav"]?.({ payload });

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k];
  subscribeStatus = "SUBSCRIBED";
  tracked = []; sent = []; removed = 0; untracked = 0;
  presence = {}; throwOnChannel = false;
  vi.useRealTimers();
});

describe("fleet", () => {
  it("is inert when realtime is unavailable", () => {
    throwOnChannel = true;
    const f = joinFleet({ name: "Jack" });
    const snap = f.snapshot();
    expect(snap.online).toBe(false);
    expect(snap.travellers).toEqual([]);
    expect(() => f.setSystem(2, "SEAFAIR")).not.toThrow();
    expect(() => f.setPosition(1, 2, 3, 0.5)).not.toThrow();
    expect(() => f.dispose()).not.toThrow();
  });

  it("stays offline when the socket never subscribes", () => {
    subscribeStatus = "CHANNEL_ERROR";
    const f = joinFleet({ name: "Jack" });
    expect(f.snapshot().online).toBe(false);
    f.dispose();
  });

  it("tracks presence on subscribe and reports other travellers", () => {
    const f = joinFleet({ name: "Jack" });
    expect(tracked).toHaveLength(1);
    presence = {
      "other-1": [{ name: "Deca", color: "#ff2bd6", systemId: 1, systemName: "SEAFAIR" }],
    };
    sync();
    const snap = f.snapshot();
    expect(snap.travellers).toHaveLength(1);
    expect(snap.travellers[0].name).toBe("Deca");
    expect(snap.bySystem[1]).toBe(1);
    f.dispose();
  });

  it("separates who is in your system from who is merely out there", () => {
    const f = joinFleet({ name: "Jack" });
    f.setSystem(1, "SEAFAIR");
    presence = {
      a: [{ name: "Near", color: "#8fe4ff", systemId: 1, systemName: "SEAFAIR" }],
      b: [{ name: "Far", color: "#8fe4ff", systemId: 7, systemName: "Sarunmar" }],
    };
    sync();
    const snap = f.snapshot();
    expect(snap.travellers).toHaveLength(2);
    expect(snap.here.map((t) => t.name)).toEqual(["Near"]);
    f.dispose();
  });

  /* Their colour goes into a canvas fillStyle and their name onto a panel, so
     both are somebody else's input arriving over a socket. */
  it("sanitises names and colours from other people", () => {
    const f = joinFleet({ name: "Jack" });
    presence = {
      a: [{ name: "x".repeat(200), color: "javascript:alert(1)", systemId: 0 }],
      b: [{ name: null, color: "red", systemId: 0 }],
    };
    sync();
    const [t1, t2] = f.snapshot().travellers;
    expect(t1.name.length).toBeLessThanOrEqual(22);
    expect(t1.color).toBe("#8fe4ff");
    expect(t2.name).toBe("Traveller");
    expect(t2.color).toBe("#8fe4ff");
    f.dispose();
  });

  it("takes positions from broadcasts and clamps the speed", () => {
    const f = joinFleet({ name: "Jack" });
    presence = { a: [{ name: "Deca", color: "#8fe4ff", systemId: 1 }] };
    sync();
    nav({ id: "a", x: 10, y: 20, z: 30, speed: 5, systemId: 1 });
    const t = f.snapshot().travellers[0];
    expect([t.x, t.y, t.z]).toEqual([10, 20, 30]);
    expect(t.speed).toBe(1);                   // clamped from 5
    f.dispose();
  });

  it("ignores a broadcast from somebody presence has never seen", () => {
    const f = joinFleet({ name: "Jack" });
    expect(() => nav({ id: "ghost", x: 1, y: 1, z: 1 })).not.toThrow();
    expect(f.snapshot().travellers).toHaveLength(0);
    f.dispose();
  });

  /* A tab closed without a clean leave stops updating but stays in presence for
     a while. Drawing it forever is a ghost that never moves. */
  it("drops a traveller who has gone quiet", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const f = joinFleet({ name: "Jack" });
    presence = { a: [{ name: "Deca", color: "#8fe4ff", systemId: 1 }] };
    sync();
    expect(f.snapshot().travellers).toHaveLength(1);
    vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));   // a minute of silence
    expect(f.snapshot().travellers).toHaveLength(0);
    f.dispose();
  });

  it("notices arrivals and departures", () => {
    const seen: string[] = [];
    const f = joinFleet({ name: "Jack", onEvent: (t) => seen.push(t) });
    presence = { a: [{ name: "Deca", color: "#8fe4ff", systemId: 1, systemName: "SEAFAIR" }] };
    sync();
    presence = {};
    sync();
    expect(seen.some((t) => t.includes("Deca") && t.includes("flying"))).toBe(true);
    expect(seen.some((t) => t.includes("Deca") && t.includes("folded out"))).toBe(true);
    f.dispose();
  });

  it("re-tracks only when the system actually changes", () => {
    const f = joinFleet({ name: "Jack" });
    const before = tracked.length;
    f.setSystem(3, "Nyxen");
    f.setSystem(3, "Nyxen");
    f.setSystem(3, "Nyxen");
    expect(tracked.length).toBe(before + 1);
    f.dispose();
  });

  it("sends position on a timer, not per call", () => {
    vi.useFakeTimers();
    const f = joinFleet({ name: "Jack" });
    f.setSystem(1, "SEAFAIR");
    for (let i = 0; i < 100; i++) f.setPosition(i, 0, 0, 0.5);
    expect(sent).toHaveLength(0);              // nothing yet
    vi.advanceTimersByTime(1000);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThanOrEqual(5);  // ~4Hz, not 100
    f.dispose();
  });

  /* Socket callbacks run on the realtime client's own stack, so a throw inside
     one lands where nothing is catching it. And the per-frame read sits inside
     the engine's frame loop, whose own catch turns any exception into RUNTIME
     ERROR across the whole world — one malformed presence payload from a
     stranger must not be able to do that. */
  it("swallows a throw from a presence payload", () => {
    const f = joinFleet({
      name: "Jack",
      onEvent: () => { throw new Error("a listener blew up"); },
    });
    presence = { a: [{ name: "Deca", color: "#8fe4ff", systemId: 1 }] };
    expect(() => sync()).not.toThrow();
    // The world carries on, and is still readable.
    expect(() => f.snapshot()).not.toThrow();
    f.dispose();
  });

  it("swallows a throw from a nav broadcast", () => {
    const f = joinFleet({ name: "Jack" });
    presence = { a: [{ name: "Deca", color: "#8fe4ff", systemId: 1 }] };
    sync();
    expect(() => nav(null as unknown as Record<string, unknown>)).not.toThrow();
    expect(() => nav({ id: "a", x: {} as unknown as number })).not.toThrow();
    f.dispose();
  });

  it("lets go of the channel on dispose", () => {
    vi.useFakeTimers();
    const f = joinFleet({ name: "Jack" });
    f.setSystem(1, "X");
    f.dispose();
    const after = sent.length;
    vi.advanceTimersByTime(5000);
    expect(sent.length).toBe(after);           // timer stopped
    expect(untracked).toBe(1);
    expect(removed).toBe(1);
  });
});
