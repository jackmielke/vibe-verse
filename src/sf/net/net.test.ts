/**
 * The netcode, over an in-process loopback.
 *
 * There is no network in the sandbox this is developed in — Supabase Realtime
 * is blocked outright — so none of this could be verified by opening the game
 * and looking. Everything that could possibly be pure was therefore made pure,
 * and this is the payment for that: the wire format, the peer table, the
 * timeout sweep and the interpolator are all exercised here without a socket,
 * a canvas or a clock.
 */
import { describe, expect, it } from "vitest";
import {
  INTERP_DELAY_MS,
  MAX_PEERS,
  MOTION_IDLE,
  MOTION_RUN,
  MOTION_WALK,
  PEER_TIMEOUT_MS,
  cleanName,
  isWire,
  type StateMsg,
} from "./protocol";
import { PeerTable, lerpAngle, type PeerPose } from "./peers";

function state(id: string, x: number, z: number, extra: Partial<StateMsg> = {}): StateMsg {
  return {
    t: "s",
    i: id,
    n: "Ada",
    c: "vibey",
    p: [x, 10, z],
    a: 0,
    m: MOTION_WALK,
    ...extra,
  };
}

/** Read one peer's pose, or null if it is not being drawn. */
function poseOf(table: PeerTable, id: string, now: number): PeerPose | null {
  let found: PeerPose | null = null;
  table.forEach(now, (p) => {
    if (p.id === id) found = { ...p };
  });
  return found;
}

describe("wire validation", () => {
  it("accepts a well-formed state and a goodbye", () => {
    expect(isWire(state("a", 1, 2))).toBe(true);
    expect(isWire({ t: "q", i: "a" })).toBe(true);
  });

  it("rejects anything a stranger could put on a public channel", () => {
    // The channel is joinable by anyone. None of these may reach a frame loop.
    expect(isWire(null)).toBe(false);
    expect(isWire("hello")).toBe(false);
    expect(isWire({ t: "s" })).toBe(false);
    expect(isWire({ ...state("a", 1, 2), p: [1, 2] })).toBe(false);
    expect(isWire({ ...state("a", 1, 2), p: [1, NaN, 2] })).toBe(false);
    expect(isWire({ ...state("a", 1, 2), a: Infinity })).toBe(false);
    expect(isWire({ ...state("a", 1, 2), i: "" })).toBe(false);
    expect(isWire({ ...state("a", 1, 2), i: "x".repeat(500) })).toBe(false);
    expect(isWire({ ...state("a", 1, 2), n: 42 })).toBe(false);
    expect(isWire({ ...state("a", 1, 2), v: 7 })).toBe(false);
  });

  it("keeps a name short enough to sit over a head", () => {
    expect(cleanName("  Ada   Lovelace  ")).toBe("Ada Lovelace");
    expect(cleanName("")).toBe("Someone");
    expect(cleanName("x".repeat(60)).length).toBeLessThanOrEqual(18);
  });
});

describe("angles", () => {
  it("takes the short way round the wrap", () => {
    // The whole point: 179° to −179° is 2° of turn, not 358°.
    const a = Math.PI - 0.02;
    const b = -Math.PI + 0.02;
    const mid = lerpAngle(a, b, 0.5);
    expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(0.01);
  });
});

describe("peer table", () => {
  it("ignores our own broadcast even if a transport echoes it", () => {
    const t = new PeerTable();
    t.selfId = "me";
    t.ingest(state("me", 5, 5), 1000);
    expect(t.size).toBe(0);
  });

  it("holds the first sample rather than running backwards to meet it", () => {
    const t = new PeerTable();
    t.ingest(state("a", 100, 200), 1000);
    // Rendering is INTERP_DELAY_MS behind, so at t=1000 the target time is
    // before the only sample we hold. Show them where they said they were.
    const p = poseOf(t, "a", 1000);
    expect(p).not.toBeNull();
    expect(p!.x).toBe(100);
    expect(p!.z).toBe(200);
  });

  it("interpolates between two real samples", () => {
    const t = new PeerTable();
    t.ingest(state("a", 0, 0), 1000);
    t.ingest(state("a", 10, 0), 1200);
    // Target 1100 sits exactly halfway between the two.
    const p = poseOf(t, "a", 1100 + INTERP_DELAY_MS);
    expect(p!.x).toBeCloseTo(5, 5);
  });

  it("holds position when a peer goes quiet instead of gliding onward", () => {
    const t = new PeerTable();
    t.ingest(state("a", 0, 0), 1000);
    t.ingest(state("a", 10, 0), 1200);
    // Two seconds after the last word. Extrapolation would put them at x=110.
    const p = poseOf(t, "a", 3200);
    expect(p!.x).toBe(10);
    // And they should have stopped walking on the spot.
    expect(p!.motion).toBe(MOTION_IDLE);
  });

  it("drops a sample that arrives out of order", () => {
    const t = new PeerTable();
    t.ingest(state("a", 0, 0), 1000);
    t.ingest(state("a", 10, 0), 1200);
    t.ingest(state("a", 999, 0), 1100); // late straggler
    const p = poseOf(t, "a", 1200 + INTERP_DELAY_MS);
    expect(p!.x).toBe(10);
  });

  it("takes the newer of two discrete states rather than blending them", () => {
    const t = new PeerTable();
    t.ingest(state("a", 0, 0, { m: MOTION_WALK }), 1000);
    t.ingest(state("a", 10, 0, { m: MOTION_RUN, v: "sedan" }), 1200);
    // Past halfway, so the newer sample wins outright — there is no state
    // between walking and driving to blend to.
    const p = poseOf(t, "a", 1180 + INTERP_DELAY_MS);
    expect(p!.motion).toBe(MOTION_RUN);
    expect(p!.vehicle).toBe("sedan");
  });

  it("cuts to a teleport instead of skiing across the city", () => {
    const t = new PeerTable();
    t.ingest(state("a", 0, 0), 1000);
    t.ingest(state("a", 8, 0), 1100);
    // Somebody used the Go menu. Interpolating this would slide their body
    // three kilometres through the Financial District over the next tenth of
    // a second, which everybody else would watch happen.
    t.ingest(state("a", 3000, 0), 1200);
    const p = poseOf(t, "a", 1200 + INTERP_DELAY_MS);
    expect(p!.x).toBe(3000);
  });

  it("still interpolates a fast car, which is not a teleport", () => {
    const t = new PeerTable();
    // 40 m/s over a ninth of a second is about 4.5 m between samples.
    t.ingest(state("a", 0, 0), 1000);
    t.ingest(state("a", 4.5, 0), 1110);
    const p = poseOf(t, "a", 1055 + INTERP_DELAY_MS);
    expect(p!.x).toBeGreaterThan(0);
    expect(p!.x).toBeLessThan(4.5);
  });

  it("forgets a peer that stops talking, and one that says goodbye", () => {
    const t = new PeerTable();
    t.ingest(state("a", 0, 0), 1000);
    t.ingest(state("b", 0, 0), 1000);
    expect(t.size).toBe(2);

    t.ingest({ t: "q", i: "b" }, 1100);
    expect(t.size).toBe(1);

    expect(t.prune(1000 + PEER_TIMEOUT_MS - 1)).toEqual([]);
    expect(t.prune(1000 + PEER_TIMEOUT_MS + 1)).toEqual(["a"]);
    expect(t.size).toBe(0);
  });

  it("refuses newcomers past the cap instead of churning the regulars", () => {
    const t = new PeerTable();
    for (let i = 0; i < MAX_PEERS + 10; i++) t.ingest(state(`p${i}`, i, 0), 1000);
    expect(t.size).toBe(MAX_PEERS);
    // The first arrivals are the ones still here.
    expect(poseOf(t, "p0", 1000)).not.toBeNull();
    expect(poseOf(t, `p${MAX_PEERS + 5}`, 1000)).toBeNull();
  });

  it("survives a burst after a silence, which is the real network's failure mode", () => {
    const t = new PeerTable();
    t.ingest(state("a", 0, 0), 1000);
    // Three seconds of nothing, then four packets at once.
    for (let i = 0; i < 4; i++) t.ingest(state("a", 10 + i, 0), 4000 + i);
    const p = poseOf(t, "a", 4200);
    expect(p).not.toBeNull();
    expect(Number.isFinite(p!.x)).toBe(true);
    expect(p!.x).toBeGreaterThanOrEqual(0);
    expect(p!.x).toBeLessThanOrEqual(13);
  });
});
