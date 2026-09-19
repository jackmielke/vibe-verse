/**
 * The shared valley, over the local transport.
 *
 * Realtime is blocked here, so the BroadcastChannel transport stands in for
 * it: same wire, same room logic, only the sixty lines that put bytes on a
 * socket differ. Two rooms in one process, one makes it rain, the other
 * sees rain.
 */
import { describe, expect, it } from "vitest";
import { isWire, joinRoom, type PeerPresence } from "@/magician/net";
import { DEFAULT_STATE, applyPatch, type Patch, type WorldState } from "@/magician/state";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("the wire", () => {
  it("accepts only shaped messages", () => {
    expect(isWire({ t: "p", id: "a" })).toBe(true);
    expect(isWire({ t: "x", id: "a" })).toBe(false);
    expect(isWire("hello")).toBe(false);
    expect(isWire(null)).toBe(false);
  });
});

describe("two players in one room", () => {
  it("share patches, answer hellos, and see each other", async () => {
    if (typeof BroadcastChannel === "undefined") return;
    let stateA: WorldState = applyPatch(DEFAULT_STATE, { weather: "snow" });
    let stateB: WorldState = applyPatch(DEFAULT_STATE, {});
    let peersA: PeerPresence[] = [];
    let peersB: PeerPresence[] = [];
    let fullB: WorldState | null = null;
    const roomName = "shared-" + Math.random().toString(36).slice(2);
    const a2 = await joinRoom({ mode: "local", room: roomName, name: "Ada", id: "a", onPatch: (p) => { stateA = applyPatch(stateA, p); }, onFull: () => undefined, onPeers: (l) => { peersA = l; }, currentState: () => stateA });
    const b2 = await joinRoom({ mode: "local", room: roomName, name: "Bo", id: "b", onPatch: (p) => { stateB = applyPatch(stateB, p); }, onFull: (s) => { fullB = s; }, onPeers: (l) => { peersB = l; }, currentState: () => stateB });
    await tick();
    // The newcomer got the whole world from the one already there.
    expect(fullB).not.toBeNull();
    expect((fullB as unknown as WorldState).weather).toBe("snow");
    // A patch made by one arrives at the other.
    a2.patch({ weather: "rain" });
    await tick();
    expect(stateB.weather).toBe("rain");
    // Presence builds the peer tables.
    a2.presence(1, 0, 2, 0.5, "vibey", false);
    b2.presence(3, 0, 4, 0.1, "Wizard", true);
    await tick(300); // presence rides a 125 ms timer, not the call
    expect(peersB.map((p) => p.name)).toEqual(["Ada"]);
    expect(peersA.map((p) => p.name)).toEqual(["Bo"]);
    expect(peersA[0].talking).toBe(true);
    b2.close();
    await tick(60);
    expect(peersA).toHaveLength(0);
    a2.close();
  });
  it("fails softly when there is no transport", async () => {
    const r = await joinRoom({ mode: "off", room: "x", name: "n", onPatch: () => undefined, onFull: () => undefined, onPeers: () => undefined, currentState: () => DEFAULT_STATE });
    expect(r.connected).toBe(false);
    r.patch({ weather: "rain" });
    r.close();
  });
});
