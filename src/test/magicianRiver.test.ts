/**
 * The river under the drum bridge: wish lanterns and koi.
 *
 * A lantern is world state (so everyone sees it) and where it is is a pure
 * function of the wall clock since it was released (so a newcomer sees it
 * where it really is). These pin both halves down.
 */
import { describe, expect, it } from "vitest";
import { applyPatch, DEFAULT_STATE, type Patch, type WorldState } from "@/magician/state";
import { runTool, type MagicianStore } from "@/magician/tools";
import { castSpell } from "@/magician/spellbook";
import { wishPosition } from "@/magician/world/bridge";
import { heightAt, riverCentre, WATER_LEVEL } from "@/magician/world/noise";

function store() {
  let state: WorldState = applyPatch(DEFAULT_STATE, {});
  const log: string[] = [];
  const s: MagicianStore = {
    get: () => state,
    patch: (p: Patch) => { state = applyPatch(state, p); },
    playerPosition: () => ({ x: 0, z: 0, yaw: 0 }),
    teleport: () => undefined,
    emote: () => undefined,
    sound: (n) => log.push(n),
    burst: () => undefined,
    become: () => undefined,
    game: { start: () => undefined, stop: () => undefined, active: () => null, status: () => "", shield: () => "", blast: () => "" },
  };
  return { s, log, state: () => state };
}

describe("wish lanterns", () => {
  it("release_lantern puts the words on the river for everyone", () => {
    const { s, state, log } = store();
    const r = runTool("release_lantern", { wish: "for grandma", count: 2 }, s);
    expect(state().wishes).toHaveLength(2);
    expect(state().wishes.every((w) => w.text === "for grandma")).toBe(true);
    expect(r.output).toMatch(/for grandma/);
    expect(log).toContain("chime");
  });
  it("a reset keeps lanterns already on the water", () => {
    const { s, state } = store();
    runTool("release_lantern", { wish: "hello" }, s);
    runTool("reset_world", {}, s);
    expect(state().wishes).toHaveLength(1);
  });
  it("old lanterns are gone after five minutes, and the river holds forty", () => {
    const now = Date.now();
    const many = Array.from({ length: 60 }, (_, i) => ({ id: i, text: "x", born: now }));
    const stale = { id: 999, text: "old", born: now - 400_000 };
    const next = applyPatch(DEFAULT_STATE, { wishes: [stale, ...many] });
    expect(next.wishes).toHaveLength(40);
    expect(next.wishes.find((w) => w.id === 999)).toBeUndefined();
  });
  it("drifts downstream, on the water, and fades out", () => {
    const w = { id: 7, text: "x", born: 0 };
    const a = wishPosition(w, 10_000, -6)!;
    const b = wishPosition(w, 60_000, -6)!;
    expect(b.z).toBeGreaterThan(a.z);
    for (const p of [a, b]) expect(heightAt(p.x, p.z)).toBeLessThan(WATER_LEVEL);
    expect(wishPosition(w, 301_000, -6)).toBeNull();
  });
  it("the spellbook hears wishes and koi", () => {
    expect(castSpell("I wish for a quiet summer")).toEqual([{ name: "release_lantern", args: { wish: "a quiet summer", count: 1 } }]);
    expect(castSpell("float three lanterns on the river")[0].name).toBe("release_lantern");
    expect(castSpell("feed the koi")[0].name).toBe("feed_koi");
    // The village lights and a stone lantern are still what they were.
    expect(castSpell("light the lanterns")[0].name).toBe("set_lights");
    expect(castSpell("make a lantern here")[0].name).toBe("spawn");
  });
});

describe("the river", () => {
  it("has water in it all the way from the bridge to the lake", () => {
    for (let z = -30; z <= 60; z += 3) expect(heightAt(riverCentre(z), z)).toBeLessThan(WATER_LEVEL - 0.3);
  });
});
