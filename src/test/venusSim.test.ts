/**
 * Venus Rising, without a renderer.
 *
 * The sim is pure so that all of this can run here. Three things are pinned:
 * the atmosphere is the real one (the whole premise is a fact about it), the
 * buoyancy does what the story says it does, and the game is winnable by a
 * player who does nothing cleverer than keep the city in the band.
 */
import { describe, it, expect } from "vitest";
import { airAt, equilibriumAlt, BAND, DESIGN_ALT } from "@/venus/atmosphere";
import { VenusSim, freshSave } from "@/venus/sim";
import { EVENTS } from "@/venus/events";
import { MODULES, BUILDABLE, type ModuleId } from "@/venus/modules";

describe("the air of Venus", () => {
  it("is hell at the surface", () => {
    const a = airAt(0);
    expect(a.tempC).toBeGreaterThan(450);
    expect(a.pressure).toBeGreaterThan(90);
  });

  it("is one bar at fifty kilometres and room temperature a few above", () => {
    expect(airAt(50).pressure).toBeCloseTo(1.07, 1);
    const t = airAt(DESIGN_ALT).tempC;
    expect(t).toBeGreaterThan(25);
    expect(t).toBeLessThan(40);
  });

  it("floats breathable air", () => {
    expect(airAt(DESIGN_ALT).liftPerM3).toBeGreaterThan(0.2);
  });

  it("sinks a heavier city and raises a lighter one", () => {
    const even = equilibriumAlt(1000, 1000);
    expect(even).toBeCloseTo(DESIGN_ALT, 1);
    expect(equilibriumAlt(1000, 1300)).toBeLessThan(even);
    expect(equilibriumAlt(1000, 700)).toBeGreaterThan(even);
  });
});

describe("the city", () => {
  it("starts inside the band", () => {
    const sim = new VenusSim(freshSave());
    expect(sim.d.eqAlt).toBeGreaterThan(BAND.low);
    expect(sim.d.eqAlt).toBeLessThan(BAND.high);
  });

  it("goes down when you build heavy and up when you cut loose", () => {
    const sim = new VenusSim(freshSave());
    sim.s.res.carbon = 500;
    const slots = sim.freeSlots();
    const before = sim.d.eqAlt;
    sim.build("harvester", slots[0].q, slots[0].r);
    sim.build("harvester", slots[1].q, slots[1].r);
    expect(sim.d.eqAlt).toBeLessThan(before);
    const heavy = sim.d.eqAlt;
    sim.cutLoose(slots[0].q, slots[0].r);
    expect(sim.d.eqAlt).toBeGreaterThan(heavy);
  });

  it("dumps ballast to rise", () => {
    const sim = new VenusSim(freshSave());
    sim.s.res.water = 60;
    sim.derive();
    const before = sim.d.eqAlt;
    sim.dumpBallast();
    expect(sim.d.eqAlt).toBeGreaterThan(before);
  });

  it("falls to the surface if you pile on weight and do nothing", () => {
    const sim = new VenusSim(freshSave());
    sim.s.res.carbon = 2000;
    for (let i = 0; i < 8; i++) {
      const [slot] = sim.freeSlots();
      sim.build("harvester", slot.q, slot.r);
    }
    let fell = false;
    for (let i = 0; i < 4000 && !fell; i++) {
      sim.step(0.25);
      if (sim.event) { sim.choose(0); sim.dismiss(); }
      fell = sim.s.fallen;
    }
    expect(fell).toBe(true);
  });

  it("refuses to build out of thin air, or off the edge", () => {
    const sim = new VenusSim(freshSave());
    sim.s.res.carbon = 0;
    expect(sim.whyNot("dome")).toMatch(/carbon/);
    sim.s.res.carbon = 500;
    expect(sim.build("dome", 4, 0)).toBe(false);
  });

  it("drops anything left hanging when its neighbour is cut", () => {
    const sim = new VenusSim(freshSave());
    sim.s.res.carbon = 500;
    sim.s.res.air = 400;
    expect(sim.build("bladder", 1, 0)).toBe(true);
    expect(sim.build("bladder", 2, 0)).toBe(true);
    sim.cutLoose(1, 0);
    expect(sim.tileAt(2, 0)).toBeUndefined();
  });
});

describe("the post", () => {
  it("every event opens and every choice runs", () => {
    for (const e of EVENTS) {
      for (let c = 0; c < 3; c++) {
        const sim = new VenusSim(freshSave());
        sim.s.res = { carbon: 500, water: 30, air: 300, power: 100, science: 100, culture: 10 };
        sim.s.pop = 200;
        sim.s.res.carbon = 500;
        const slot = sim.freeSlots()[0];
        sim.build(e.trigger === "nanofab" ? "bladder" : "bladder", slot.q, slot.r);
        expect(sim.open(e.id, slot), e.id).toBe(true);
        const ev = sim.event!;
        expect(ev.title.length, e.id).toBeGreaterThan(0);
        if (c >= ev.choices.length || ev.choices[c].disabled) continue;
        sim.choose(c);
        expect(sim.event!.outcome, `${e.id}#${c}`).toBeTruthy();
        sim.dismiss();
        expect(sim.event).toBeNull();
      }
    }
  });
});

/**
 * A player with one rule — build what the city is short of, and keep it
 * in the band — should be able to reach utopia. If this test starts failing
 * after a tuning change, the game got harder than it looks.
 */
function autopilot(sim: VenusSim): ModuleId | null {
  const s = sim.s, d = sim.d;
  const tryOrder: ModuleId[] = [];
  const need = (id: ModuleId) => tryOrder.push(id);
  const heavyMargin = d.lift - d.mass;
  if (d.eqAlt < DESIGN_ALT - 1 || heavyMargin < 40) need("bladder");
  if (d.rates.power < 1 || (d.sun < 0.3 && s.res.power < 30)) need("solar");
  if (sim.count("harvester") < 1 + Math.floor(s.pop / 250)) need("harvester");
  if (sim.count("moxie") < 1 + Math.floor(s.pop / 300)) need("moxie");
  if (sim.count("still") < 1) need("still");
  if (d.food - s.pop < 20) need("greenhouse");
  if (d.housing - s.pop < 20) need("dome");
  if (sim.count("jazz") < 1 + Math.floor(s.pop / 400)) need("jazz");
  if (s.pop >= 60 && sim.count("skyport") < 1) need("skyport");
  if (s.pop >= 150 && sim.count("ballroom") < 1 + Math.floor(s.pop / 700)) need("ballroom");
  need("dome");
  const full = sim.freeSlots().length === 0;
  for (const id of tryOrder) {
    if (!full && !sim.whyNot(id)) return id;
    if (full && sim.s.tiles.some((x) => x.id === id && !sim.whyNotUpgrade(x.q, x.r))) return id;
  }
  return null;
}

describe("the long game", () => {
  it("is winnable by keeping the city in the band", () => {
    const sim = new VenusSim(freshSave(7));
    let t = 0;
    const maxT = 60 * 60 * 2; // two hours of game time, worst case
    while (!sim.s.won && !sim.s.fallen && t < maxT) {
      if (sim.event) {
        const ev = sim.event;
        if (!ev.outcome) {
          const i = ev.choices.findIndex((c) => !c.disabled);
          sim.choose(Math.max(0, i));
        }
        sim.dismiss();
      }
      const id = autopilot(sim);
      if (id) {
        const [slot] = sim.freeSlots();
        if (slot) sim.build(id, slot.q, slot.r);
        else {
          // Out of room: grow what is there instead.
          const t = sim.s.tiles.find((x) => x.id === id && !sim.whyNotUpgrade(x.q, x.r));
          if (t) sim.upgrade(t.q, t.r);
        }
      }
      if (sim.d.eqAlt < BAND.low + 0.5 && sim.s.res.water > 10) sim.dumpBallast();
      sim.step(0.5);
      t += 0.5;
    }
    // eslint-disable-next-line no-console
    console.log(`autopilot: won=${sim.s.won} fallen=${sim.s.fallen} t=${Math.round(t)}s pop=${Math.round(sim.s.pop)} culture=${Math.round(sim.s.res.culture)} happy=${sim.d.happiness.toFixed(2)} tiles=${sim.s.tiles.length} alt=${sim.s.alt.toFixed(1)}`);
    expect(sim.s.fallen).toBe(false);
    expect(sim.s.won).toBe(true);
    // And not trivially: it should take a proper session.
    expect(t).toBeGreaterThan(15 * 60);
  });

  it("offers every buildable module in the bar", () => {
    for (const id of BUILDABLE) expect(MODULES[id].hidden).toBeFalsy();
  });
});
