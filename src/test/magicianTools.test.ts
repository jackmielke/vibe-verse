/**
 * The Magician's tools, run against a fake store.
 *
 * Everything the voice agent can do to the valley goes through `runTool`,
 * and none of it needs three.js, so this is where the rules live: rain puts
 * fireballs out, a forest is a forest, the spellbook turns words into the
 * same calls the model would make.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { applyPatch, DEFAULT_STATE, describeState, fireballsFizzle, lanternsOn, nightness, type Patch, type WorldState } from "@/magician/state";
import { LANDMARKS, resetPropIds, runTool, TOOL_DEFINITIONS, type MagicianStore } from "@/magician/tools";
import { castSpell } from "@/magician/spellbook";

function fakeStore() {
  let state: WorldState = applyPatch(DEFAULT_STATE, { props: [] });
  const log: string[] = [];
  const store: MagicianStore = {
    get: () => state,
    patch: (p: Patch) => { state = applyPatch(state, p); },
    playerPosition: () => ({ x: 0, z: 0, yaw: 0 }),
    teleport: (x, z, yaw) => log.push(`teleport ${x},${z},${yaw ?? "-"}`),
    emote: (c) => log.push(`emote ${c}`),
    sound: (n) => log.push(`sound ${n}`),
    burst: (k) => log.push(`burst ${k}`),
  };
  return { store, log, state: () => state };
}

let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

beforeEach(() => { resetPropIds(); seed = 1; });

describe("tool definitions", () => {
  it("every tool has a name, a description and a JSON schema object", () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.type).toBe("function");
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(20);
      expect((t.parameters as { type: string }).type).toBe("object");
    }
  });
  it("every defined tool is executable", () => {
    const { store } = fakeStore();
    for (const t of TOOL_DEFINITIONS) {
      const r = runTool(t.name, {}, store, rnd);
      expect(r.output).not.toMatch(/^Unknown tool/);
    }
  });
});

describe("the weather and the fireballs", () => {
  it("rain puts the fireballs out", () => {
    const { store, state } = fakeStore();
    runTool("fireballs", { on: true, rate: 2 }, store);
    expect(state().fireballs.on).toBe(true);
    expect(fireballsFizzle(state())).toBe(false);
    const r = runTool("set_weather", { weather: "rain" }, store);
    expect(fireballsFizzle(state())).toBe(true);
    expect(r.output).toMatch(/hissing out/);
    runTool("set_weather", { weather: "clear" }, store);
    expect(fireballsFizzle(state())).toBe(false);
  });
  it("snow and storms count as wet, fog does not", () => {
    const { store, state } = fakeStore();
    runTool("set_weather", { weather: "snow" }, store);
    expect(fireballsFizzle(state())).toBe(true);
    runTool("set_weather", { weather: "fog" }, store);
    expect(fireballsFizzle(state())).toBe(false);
    runTool("set_weather", { weather: "storm" }, store);
    expect(fireballsFizzle(state())).toBe(true);
  });
  it("rejects a weather it does not know without changing anything", () => {
    const { store, state } = fakeStore();
    const r = runTool("set_weather", { weather: "hail" }, store);
    expect(r.output).toMatch(/Unknown weather/);
    expect(state().weather).toBe("clear");
  });
});

describe("time", () => {
  it("wraps the clock and lights the lanterns at dusk", () => {
    const { store, state } = fakeStore();
    runTool("set_time", { hour: 25.5 }, store);
    expect(state().timeOfDay).toBeCloseTo(1.5);
    expect(nightness(state().timeOfDay)).toBeGreaterThan(0.9);
    expect(lanternsOn(state())).toBe(true);
    runTool("set_time", { hour: 12 }, store);
    expect(lanternsOn(state())).toBe(false);
  });
  it("can start and stop the clock without touching the hour", () => {
    const { store, state } = fakeStore();
    runTool("set_time", { hour: 9, run_clock: true }, store);
    expect(state().clockRunning).toBe(true);
    expect(state().timeOfDay).toBe(9);
  });
});

describe("conjuring", () => {
  it("spawns a forest around the player with a natural spread", () => {
    const { store, state } = fakeStore();
    const r = runTool("spawn", { kind: "sakura", count: 30, place: "around" }, store, rnd);
    expect(state().props).toHaveLength(30);
    expect(r.output).toMatch(/30 sakuras/);
    const xs = state().props.map((p) => Math.hypot(p.x, p.z));
    expect(Math.max(...xs)).toBeGreaterThan(8);
    expect(Math.max(...xs)).toBeLessThanOrEqual(10 + 30 * 0.6 + 0.01);
    expect(new Set(state().props.map((p) => p.id)).size).toBe(30);
  });
  it("puts a single thing in front of the player", () => {
    const { store, state } = fakeStore();
    runTool("spawn", { kind: "torii" }, store, rnd);
    const p = state().props[0];
    expect(p.x).toBeCloseTo(0);
    expect(p.z).toBeCloseTo(-4);
  });
  it("understands colour names and hex, and clamps scale", () => {
    const { store, state } = fakeStore();
    runTool("spawn", { kind: "crystal", color: "purple", scale: 99 }, store, rnd);
    expect(state().props[0].color).toBe("#8a4fff");
    expect(state().props[0].scale).toBeLessThanOrEqual(6 * 1.15);
    runTool("spawn", { kind: "house", color: "#ABC" }, store, rnd);
    expect(state().props[1].color).toBe("#aabbcc");
  });
  it("removes by kind, or everything, and says how many went", () => {
    const { store, state } = fakeStore();
    runTool("spawn", { kind: "pine", count: 5, place: "around" }, store, rnd);
    runTool("spawn", { kind: "lantern", count: 3, place: "around" }, store, rnd);
    const r = runTool("remove", { kind: "pine" }, store);
    expect(r.output).toMatch(/Removed 5/);
    expect(state().props.every((p) => p.kind === "lantern")).toBe(true);
    runTool("remove", { kind: "all" }, store);
    expect(state().props).toHaveLength(0);
  });
  it("caps the total at 400 so a chatty model cannot melt the GPU", () => {
    const { store, state } = fakeStore();
    for (let i = 0; i < 10; i++) runTool("spawn", { kind: "tree", count: 60, place: "around" }, store, rnd);
    expect(state().props.length).toBe(400);
  });
  it("landmarks resolve to real coordinates", () => {
    const { store, log } = fakeStore();
    runTool("teleport", { place: "shrine" }, store);
    expect(log).toContain(`teleport ${LANDMARKS.shrine.x},${LANDMARKS.shrine.z},${LANDMARKS.shrine.yaw}`);
    const r = runTool("teleport", { place: "moon" }, store);
    expect(r.output).toMatch(/Unknown place/);
  });
});

describe("the sky and the rest", () => {
  it("paints and resets the palette", () => {
    const { store, state } = fakeStore();
    runTool("paint_sky", { sky: "#3a0d7a", horizon: "#b56aff" }, store);
    expect(state().palette).toEqual({ sky: "#3a0d7a", horizon: "#b56aff", ground: "#ffffff" });
    runTool("paint_sky", { sky: "natural" }, store);
    expect(state().palette).toBeNull();
  });
  it("clamps the sky show and physics", () => {
    const { store, state } = fakeStore();
    runTool("sky_show", { aurora: 5, flood: -1 }, store);
    expect(state().aurora).toBe(1);
    expect(state().flood).toBe(0);
    runTool("set_physics", { gravity: "moon", speed: 100, giant: 0.01 }, store);
    expect(state().gravity).toBe("moon");
    expect(state().speed).toBe(4);
    expect(state().giant).toBe(0.4);
  });
  it("writes the sign, names the place, and describes itself honestly", () => {
    const { store, state } = fakeStore();
    runTool("write_sign", { text: "Beware of fireballs", title: "Kaze Valley" }, store);
    expect(state().sign).toBe("Beware of fireballs");
    expect(state().title).toBe("Kaze Valley");
    const d = describeState(state());
    expect(d).toMatch(/Kaze Valley/);
    expect(d).toMatch(/Beware of fireballs/);
    const r = runTool("look_around", {}, store);
    expect(r.output).toMatch(/Player at/);
    expect(r.toast).toBeNull();
  });
  it("reset puts everything back", () => {
    const { store, state } = fakeStore();
    runTool("spawn", { kind: "fox", count: 3 }, store, rnd);
    runTool("set_weather", { weather: "storm" }, store);
    runTool("reset_world", {}, store);
    expect(state().props).toHaveLength(0);
    expect(state().weather).toBe("clear");
    expect(state().timeOfDay).toBe(DEFAULT_STATE.timeOfDay);
  });
});

describe("the spellbook", () => {
  const names = (t: string) => castSpell(t).map((c) => c.name);
  it("turns plain words into the same calls the model would make", () => {
    expect(castSpell("make it rain")).toEqual([{ name: "set_weather", args: { weather: "rain" } }]);
    expect(names("midnight with fireflies and lanterns")).toEqual(["set_time", "set_lights", "set_lights"]);
    expect(castSpell("a cherry forest around me")[0]).toMatchObject({ name: "spawn", args: { kind: "sakura", count: 30, place: "around" } });
    expect(castSpell("attack me with fireballs")[0]).toMatchObject({ name: "fireballs", args: { on: true } });
    expect(castSpell("stop the fireballs")[0]).toMatchObject({ name: "fireballs", args: { on: false } });
    expect(names("take me to the shrine")).toContain("teleport");
    expect(castSpell("purple sky")[0]).toMatchObject({ name: "paint_sky" });
    expect(names("autumn")).toEqual(["set_season"]);
    expect(names("reset")).toEqual(["reset_world"]);
    expect(castSpell("three giant red mushrooms")[0]).toMatchObject({ name: "spawn", args: { kind: "mushroom", count: 3, scale: 3, color: "red" } });
  });
  it("does not mistake a snowman for snow, or a campfire for fireballs", () => {
    expect(names("build a snowman")).toEqual(["spawn"]);
    expect(castSpell("build a snowman")[0].args.kind).toBe("snowman");
    expect(names("fireballs please")).toEqual(["fireballs"]);
  });
  it("says nothing for words it does not know", () => {
    expect(castSpell("tell me a joke")).toEqual([]);
    expect(castSpell("")).toEqual([]);
  });
  it("every spell it produces is a real tool", () => {
    const known = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    const phrases = ["make it rain", "sunset", "snow", "a forest", "remove everything", "moon gravity", "northern lights", "flood the valley", "dance", "ring the bell", "call this place Dawnfield", "the sign says Hello there"];
    for (const p of phrases) for (const c of castSpell(p)) expect(known.has(c.name), `${p} → ${c.name}`).toBe(true);
  });
});
