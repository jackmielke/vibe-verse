/**
 * Smoke tests for the game layer.
 *
 * These exist to catch the failure mode that costs the most time: a module
 * that builds its content at import (missions, discoveries) throwing or
 * producing nonsense because a geo lookup changed shape. They also pin the
 * economy's arithmetic, because "why is a fuel tank worth 40,000" is a very
 * annoying bug to find at 2 a.m.
 */
import { describe, expect, it } from "vitest";
import { WORLD } from "../geo/sfGeo";
import { frame, useSfStore } from "../state/store";
import { chaos, chaosRank, chaosRankIndex, installChaosEconomy } from "./chaos";
import { DISCOVERIES, discoveries } from "./discoveries";
import { MISSIONS, missions } from "./missions";
import { progression, upgrades } from "./progression";
import { director } from "./director";
import { gameHeat } from "./heat";
import { exportSave, importSave, loadGame, saveGame } from "./save";

describe("content generation", () => {
  it("builds every mission inside the world bounds", () => {
    expect(MISSIONS.length).toBeGreaterThan(25);
    for (const m of MISSIONS) {
      expect(m.x).toBeGreaterThan(WORLD.minX);
      expect(m.x).toBeLessThan(WORLD.maxX);
      expect(m.z).toBeGreaterThan(WORLD.minZ);
      expect(m.z).toBeLessThan(WORLD.maxZ);
      expect(m.objectives.length).toBeGreaterThan(0);
      expect(Number.isFinite(m.y)).toBe(true);
      for (const o of m.objectives) {
        expect(Number.isFinite(o.x + o.y + o.z)).toBe(true);
        if (o.points) for (const p of o.points) expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
      }
    }
  });

  it("covers all nine activity families", () => {
    const kinds = new Set(MISSIONS.map((m) => m.kind));
    expect(kinds.size).toBe(9);
  });

  it("gives every landmark and summit a discovery with a real blurb", () => {
    const landmarks = DISCOVERIES.filter((d) => d.kind === "landmark");
    const views = DISCOVERIES.filter((d) => d.kind === "viewpoint");
    const hidden = DISCOVERIES.filter((d) => d.kind === "hidden");
    expect(landmarks.length).toBe(22);
    expect(views.length).toBe(16);
    expect(hidden.length).toBeGreaterThan(50);
    for (const d of DISCOVERIES) expect(d.blurb.length).toBeGreaterThan(40);
  });

  it("keeps discovery keys unique", () => {
    const keys = new Set(DISCOVERIES.map((d) => d.key));
    expect(keys.size).toBe(DISCOVERIES.length);
  });
});

describe("chaos economy", () => {
  it("escalates the rank curve monotonically", () => {
    expect(chaosRankIndex(0)).toBe(0);
    expect(chaosRankIndex(599)).toBe(0);
    expect(chaosRankIndex(600)).toBe(1);
    expect(chaosRank(300000).name).toBe("FREE FALL");
  });

  it("scores base, style and combo without double counting", () => {
    const dispose = installChaosEconomy();
    useSfStore.setState({ chaos: 0 });
    chaos.reset();
    frame.movement = "grounded";
    frame.altitudeAGL = 0;
    frame.velocity.set(0, 0, 0);

    const a = chaos.report("vehicle", 0, 0, 0);
    // First event in a chain: tier 1, no style tags on the ground.
    expect(a.base).toBe(40);
    expect(a.multiplier).toBeCloseTo(1, 5);
    expect(useSfStore.getState().chaos).toBe(a.points);

    // A payout must not ride the combo multiplier.
    const before = useSfStore.getState().chaos;
    chaos.payout(1000, "test");
    expect(useSfStore.getState().chaos).toBe(before + 1000);

    dispose();
  });

  it("pays negative chaos for civilians and denies them style", () => {
    const dispose = installChaosEconomy();
    useSfStore.setState({ chaos: 0 });
    chaos.reset();
    frame.movement = "wingsuit";
    const a = chaos.report("civilian", 0, 0, 0);
    expect(a.points).toBeLessThan(0);
    expect(a.styles.length).toBe(0);
    dispose();
  });

  it("builds a combo and expires it", () => {
    const dispose = installChaosEconomy();
    useSfStore.setState({ chaos: 0 });
    chaos.reset();
    frame.movement = "grounded";
    frame.time = 100;
    for (let i = 0; i < 6; i++) chaos.report("prop", 0, 0, 0);
    expect(chaos.chain).toBe(6);
    expect(chaos.multiplier).toBeGreaterThan(1.5);
    frame.time = 120;
    chaos.tick(1 / 60);
    expect(chaos.chain).toBe(0);
    dispose();
  });
});

describe("progression", () => {
  it("recomputes upgrade values from unlocks", () => {
    progression.reset();
    const base = upgrades.grappleRange;
    expect(upgrades.maxTethers).toBe(2);
    progression.grant("grapple-tether-3");
    progression.grant("grapple-range-2");
    expect(upgrades.maxTethers).toBe(3);
    expect(upgrades.grappleRange).toBeGreaterThan(base);
    progression.reset();
    expect(upgrades.maxTethers).toBe(2);
  });

  it("records only improved best times", () => {
    progression.reset();
    expect(progression.recordTime("m", 40)).toBe(true);
    expect(progression.recordTime("m", 41)).toBe(false);
    expect(progression.recordTime("m", 39)).toBe(true);
    expect(progression.bestTime("m")).toBe(39);
  });
});

describe("missions runtime", () => {
  it("starts, publishes objectives and aborts cleanly", () => {
    const off = missions.install();
    useSfStore.setState({ objectives: [] });
    const target = MISSIONS.find((m) => m.kind === "wingsuit-course")!;
    expect(missions.start(target.id)).toBe(true);
    missions.tick(1 / 60);
    expect(useSfStore.getState().objectives.length).toBeGreaterThan(0);
    missions.abort("test");
    expect(missions.state).toBe("failed");
    expect(useSfStore.getState().objectives.length).toBe(0);
    off();
  });
});

describe("director", () => {
  it("ranks offers and never returns duplicates", () => {
    director.reset();
    useSfStore.setState({ chaos: 200000 });
    const offers = director.rankOffers();
    expect(offers.length).toBeGreaterThan(0);
    const ids = new Set(offers.map((o) => o.def.id));
    expect(ids.size).toBe(offers.length);
  });

  it("moves through phases and enforces a cooldown", () => {
    director.reset();
    gameHeat.reset();
    // No intensity: it should sit in calm.
    for (let i = 0; i < 40; i++) director.tick(0.3);
    expect(director.phase).toBe("calm");
  });
});

describe("save", () => {
  it("round-trips without throwing when storage is hostile", () => {
    expect(() => saveGame("test")).not.toThrow();
    expect(() => loadGame()).not.toThrow();
    const text = exportSave();
    expect(text.length).toBeGreaterThan(10);
    expect(importSave("not json at all")).toBe(false);
    expect(importSave(text)).toBe(true);
  });
});

describe("heat", () => {
  it("keeps district pressure bounded and decaying", () => {
    gameHeat.reset();
    gameHeat.bumpPressure(0, 0, 400);
    const hot = gameHeat.pressureAt(0, 0);
    expect(hot).toBeGreaterThan(0);
    expect(hot).toBeLessThanOrEqual(1);
    for (let i = 0; i < 200; i++) gameHeat.tick(1, 1000 + i);
    expect(gameHeat.pressureAt(0, 0)).toBeLessThan(hot);
  });
});

describe("discoveries", () => {
  it("unlocks on proximity and is idempotent", () => {
    discoveries.reset();
    useSfStore.setState({ discovered: [], chaos: 0 });
    const d = DISCOVERIES[0];
    discoveries.unlock(d);
    discoveries.unlock(d);
    expect(discoveries.found).toBe(1);
    expect(useSfStore.getState().discovered.length).toBe(1);
  });
});
