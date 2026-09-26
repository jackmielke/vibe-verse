/**
 * The Magic Screen: the parts that can be checked without a browser.
 *
 * The sandbox itself (an opaque-origin iframe and a worker) only exists in
 * a browser and is exercised by driving /magician in Chromium; here are the
 * rules around it: what the coder's reply is cleaned into, how words reach
 * the screen, and that every built-in channel is a program that compiles
 * in the scope the runtime gives it.
 */
import { describe, expect, it } from "vitest";
import { applyPatch, DEFAULT_STATE, describeState, type Patch, type WorldState } from "@/magician/state";
import { runTool, type MagicianStore } from "@/magician/tools";
import { castSpell } from "@/magician/spellbook";
import { CHANNELS, findChannel } from "@/magician/screen/library";
import { cleanCode, titleOf } from "@/magician/screen/coder";

function store() {
  let state: WorldState = applyPatch(DEFAULT_STATE, {});
  const asked: Array<[string, boolean]> = [];
  const s: MagicianStore = {
    get: () => state,
    patch: (p: Patch) => { state = applyPatch(state, p); },
    playerPosition: () => ({ x: 0, z: 0, yaw: 0 }),
    teleport: () => undefined, emote: () => undefined, sound: () => undefined, burst: () => undefined, become: () => undefined,
    game: { start: () => undefined, stop: () => undefined, active: () => null, status: () => "", shield: () => "", blast: () => "" },
    programScreen: (r, c) => { asked.push([r, c]); return "writing"; },
  };
  return { s, asked, state: () => state };
}

describe("the coder's reply", () => {
  it("loses markdown fences and prose around the code", () => {
    expect(cleanCode("```js\n// Title: X\nfunction draw(){}\n```")).toBe("// Title: X\nfunction draw(){}");
    expect(cleanCode("Here you go:\n```javascript\nfunction draw(){}\n```\nEnjoy!")).toBe("function draw(){}");
    expect(cleanCode("function draw(){}")).toBe("function draw(){}");
  });
  it("names itself from its first comment", () => {
    expect(titleOf("// Title: Koi Pond\nfunction draw(){}", "fallback")).toBe("Koi Pond");
    expect(titleOf("function draw(){}", "a game")).toBe("a game");
  });
});

describe("words to the screen", () => {
  it("program_screen asks the world, with change when asked for one", () => {
    const { s, asked } = store();
    runTool("program_screen", { request: "a game of snake" }, s);
    runTool("program_screen", { request: "make it faster", change: true }, s);
    expect(asked).toEqual([["a game of snake", false], ["make it faster", true]]);
  });
  it("the spellbook sends screen talk to the screen and travel to the place", () => {
    expect(castSpell("put fireworks on the screen")[0]).toMatchObject({ name: "program_screen", args: { change: false } });
    expect(castSpell("make it faster on the screen")[0]).toMatchObject({ name: "program_screen", args: { change: true } });
    expect(castSpell("take me to the screen")[0]).toEqual({ name: "teleport", args: { place: "screen" } });
  });
  it("the state says what is on it", () => {
    const { s, state } = store();
    s.patch({ screen: { code: "function draw(){}", title: "Koi Pond", request: "koi", at: 1 } });
    expect(describeState(state())).toMatch(/Magic Screen .*"Koi Pond"/);
  });
});

describe("built-in channels", () => {
  it("each compiles where the runtime runs it, and is findable by its words", () => {
    for (const c of CHANNELS) {
      // The runtime wraps a program in a function, with these in scope.
      const make = new Function("ctx", "W", "H", "input", "rand", "beep", "state", "canvas",
        `${c.code}\n;return { setup: typeof setup === "function" ? setup : null, draw: typeof draw === "function" ? draw : null };`);
      // Top-level code may already call into the context (createImageData).
      const ctx = new Proxy({}, { get: () => () => ({ data: new Uint8ClampedArray(4) }) });
      const prog = make(ctx, 480, 270, {}, Math.random, () => undefined, {}, {});
      expect(typeof prog.draw, c.id).toBe("function");
    }
    expect(findChannel("put pong on the screen")?.id).toBe("pong");
    expect(findChannel("a koi pond please")?.id).toBe("koi");
    expect(findChannel("something nobody has made")).toBeNull();
  });
});

describe("spellbook: stopping the weather", () => {
  it("hears 'stop the rain' as clear skies, not as rain", async () => {
    const { castSpell: spellbook } = await import("@/magician/spellbook");
    for (const said of ["stop the rain", "stop the rain, make it night and light the lanterns", "no more snow", "enough rain please"]) {
      const w = spellbook(said).filter((c) => c.name === "set_weather").map((c) => c.args.weather);
      expect(w, said).toEqual(["clear"]);
    }
    expect(spellbook("make it rain").find((c) => c.name === "set_weather")?.args.weather).toBe("rain");
  });
});
