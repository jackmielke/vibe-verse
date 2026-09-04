/**
 * Flow Phangan: the day is a pure state machine, so the whole loop can be
 * played here without a canvas. Every run ends at 8:30, the rain always beats
 * the bell, every secret location is on a road, and a rider who goes straight
 * to each guest and straight to the bar delivers all of them with time spare.
 */
import { describe, expect, it } from "vitest";
import {
  BEATS,
  CLOCK_END,
  DAY_SECONDS,
  GUESTS_PER_DAY,
  PLACES,
  action,
  checkpoint,
  clockLabel,
  endDay,
  hit,
  mulberry32,
  muayThaiScore,
  newDay,
  padThai,
  rainFront,
  summary,
  tick,
} from "@/phangan/day";
import {
  CHECKPOINT,
  DOGS,
  GYM,
  PAD_THAI_STOPS,
  PIN_SPOTS,
  ROAD_HALF_WIDTH,
  VILLA,
  dist2,
  isLand,
  nearestRoad,
  terrainHeight,
} from "@/phangan/island";
import { newScooter, stepScooter, SCOOTER, type Surface } from "@/phangan/scooter";
import { GUEST_POOL, SECRET_PLACES } from "@/phangan/dialogue";

const CRUISE = 19; // m/s, a sensible rider on a rental, short of the cap
const DRY: Surface = { onRoad: true, wet: false, grade: 0, energy: 100, held: false };

describe("the island", () => {
  it("puts every secret location, pin and pad thai stop on a road", () => {
    for (const p of PLACES) expect(nearestRoad(p.pos.x, p.pos.z).dist, p.name).toBeLessThan(ROAD_HALF_WIDTH * 4);
    for (const p of PIN_SPOTS) expect(nearestRoad(p.pos.x, p.pos.z).dist, p.name).toBeLessThan(ROAD_HALF_WIDTH * 2);
    for (const p of PAD_THAI_STOPS) expect(nearestRoad(p.pos.x, p.pos.z).dist, p.name).toBeLessThan(ROAD_HALF_WIDTH * 2);
    for (const d of DOGS) expect(nearestRoad(d.x, d.z).dist).toBeLessThan(ROAD_HALF_WIDTH);
    expect(nearestRoad(CHECKPOINT.pos.x, CHECKPOINT.pos.z).dist).toBeLessThan(ROAD_HALF_WIDTH);
    expect(nearestRoad(GYM.pos.x, GYM.pos.z).dist).toBeLessThan(ROAD_HALF_WIDTH * 5);
  });

  it("keeps everything on dry land, above the sea", () => {
    for (const p of [...PLACES, ...PIN_SPOTS, ...PAD_THAI_STOPS, VILLA, GYM]) {
      expect(isLand(p.pos.x, p.pos.z), p.name).toBe(true);
      expect(terrainHeight(p.pos.x, p.pos.z), p.name).toBeGreaterThan(0);
    }
    expect(terrainHeight(0, 0)).toBeGreaterThan(60);
    expect(terrainHeight(600, 600)).toBeLessThan(0);
  });

  it("has a villa on the west side, two minutes from Haad Yao", () => {
    expect(VILLA.pos.x).toBeLessThan(-180);
    expect(Math.abs(VILLA.pos.z)).toBeLessThan(120);
  });

  it("makes the shortcuts steep", () => {
    // Summit road climbs at least sixty metres between the coast and the top.
    const west = nearestRoad(-207, -16);
    expect(west.road?.steep).toBe(true);
    expect(terrainHeight(36, -36) - terrainHeight(-207, -16)).toBeGreaterThan(60);
  });
});

describe("the scooter", () => {
  it("accelerates to a cap on the road and slower off it", () => {
    let s = newScooter(0, 0, 0);
    for (let i = 0; i < 600; i++) s = stepScooter(s, { throttle: 1, lean: 0, boost: false }, DRY, 1 / 60);
    expect(s.speed).toBeGreaterThan(SCOOTER.maxSpeed * 0.8);
    expect(s.speed).toBeLessThanOrEqual(SCOOTER.maxSpeed + 0.01);
    expect(s.z).toBeLessThan(-100); // facing north, travelled north
    let g = newScooter(0, 0, 0);
    for (let i = 0; i < 600; i++) g = stepScooter(g, { throttle: 1, lean: 0, boost: false }, { ...DRY, onRoad: false }, 1 / 60);
    expect(g.speed).toBeLessThan(SCOOTER.offRoadMax + 0.01);
  });

  it("slides more in the wet", () => {
    const run = (wet: boolean) => {
      let s = newScooter(0, 0, 0);
      for (let i = 0; i < 300; i++) s = stepScooter(s, { throttle: 1, lean: 0, boost: false }, DRY, 1 / 60);
      let maxSlip = 0;
      for (let i = 0; i < 120; i++) {
        s = stepScooter(s, { throttle: 0.5, lean: 1, boost: false }, { ...DRY, wet }, 1 / 60);
        maxSlip = Math.max(maxSlip, Math.abs(s.slip));
      }
      return { maxSlip, lean: s.lean };
    };
    expect(run(true).maxSlip).toBeGreaterThan(run(false).maxSlip);
    expect(run(false).lean).toBeGreaterThan(0.1);
  });

  it("stops when held at a checkpoint and goes soft when tired", () => {
    let s = newScooter(0, 0, 0);
    for (let i = 0; i < 300; i++) s = stepScooter(s, { throttle: 1, lean: 0, boost: false }, DRY, 1 / 60);
    for (let i = 0; i < 120; i++) s = stepScooter(s, { throttle: 1, lean: 0, boost: false }, { ...DRY, held: true }, 1 / 60);
    expect(Math.abs(s.speed)).toBeLessThan(1);
    let t = newScooter(0, 0, 0);
    for (let i = 0; i < 600; i++) t = stepScooter(t, { throttle: 1, lean: 0, boost: false }, { ...DRY, energy: 0 }, 1 / 60);
    expect(t.speed).toBeLessThan(SCOOTER.maxSpeed * 0.6);
  });
});

describe("the day", () => {
  it("is the same day for the same seed", () => {
    const a = newDay(42);
    const b = newDay(42);
    expect(a.place.key).toBe(b.place.key);
    expect(a.guests.map((g) => g.def.name)).toEqual(b.guests.map((g) => g.def.name));
    expect(a.rainAt).toBe(b.rainAt);
    const r = mulberry32(9);
    expect(r()).toBe(mulberry32(9)());
  });

  it("draws six distinct guests from the pool and every secret place eventually", () => {
    const places = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const d = newDay(seed);
      expect(d.guests.length).toBe(GUESTS_PER_DAY);
      expect(new Set(d.guests.map((g) => g.def.name)).size).toBe(GUESTS_PER_DAY);
      expect(new Set(d.guests.map((g) => g.spot)).size).toBe(GUESTS_PER_DAY);
      for (const g of d.guests) expect(dist2(g.pos, d.place.pos)).toBeGreaterThan(60);
      places.add(d.place.key);
    }
    expect(places.size).toBe(SECRET_PLACES.length);
    expect(GUEST_POOL.length).toBeGreaterThanOrEqual(GUESTS_PER_DAY + 2);
  });

  it("always rains before 8:30, and never before you have found your feet", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const d = newDay(seed);
      expect(d.rainAt).toBeGreaterThan(60);
      expect(d.rainAt).toBeLessThan(DAY_SECONDS - 40);
    }
  });

  it("ends at 8:30 whatever happens, then Muay Thai, then done", () => {
    const d = newDay(7);
    let sunsetSeen = false;
    for (let i = 0; i < DAY_SECONDS * 10 + 50 && d.phase === "ride"; i++) {
      tick(d, 0.1, { climb: 0, boosting: false, speed: 0 });
      if (d.sunset) sunsetSeen = true;
    }
    expect(d.phase).toBe("muaythai");
    expect(d.minute).toBe(CLOCK_END);
    expect(d.raining).toBe(true);
    expect(sunsetSeen).toBe(true);
    expect(d.dark).toBe(true);
    expect(clockLabel(d.minute)).toBe("8:30 pm");
    expect(rainFront(d)).toBe(1);
    for (let i = 0; i < 400 && d.phase !== "done"; i++) tick(d, 0.1, { climb: 0, boosting: false, speed: 0 });
    expect(d.phase).toBe("done");
    expect(d.rhythm?.beats.filter((b) => b.result === "miss").length).toBe(BEATS);
  });

  it("delivers every guest on a perfect scripted run, with time to spare", () => {
    for (const seed of [1, 2, 3, 11, 23, 99]) {
      const d = newDay(seed);
      let pos = { ...VILLA.pos };
      const ride = (to: { x: number; z: number }) => {
        // Roads bend, so the straight line is short by about a third.
        const seconds = (dist2(pos, to) * 1.35) / CRUISE;
        for (let t = 0; t < seconds; t += 0.1) tick(d, 0.1, { climb: 0.02, boosting: false, speed: CRUISE });
        pos = { ...to };
      };
      const order = [...d.guests].sort((a, b) => dist2(a.pos, d.place.pos) - dist2(b.pos, d.place.pos));
      for (const g of order) {
        ride(g.pos);
        expect(action(d, pos)).toBe("picked");
        expect(d.riding).toBe(g.id);
        ride(d.place.pos);
        expect(action(d, pos)).toBe("delivered");
      }
      expect(d.phase).toBe("ride");
      expect(d.guests.every((g) => g.phase === "delivered")).toBe(true);
      expect(d.t, `seed ${seed} took ${d.t.toFixed(0)}s`).toBeLessThan(DAY_SECONDS * 0.8);
      const s = summary(d);
      expect(s.delivered).toBe(GUESTS_PER_DAY);
      expect(s.fullStories + s.fastRides).toBe(GUESTS_PER_DAY);
    }
  });

  it("can be lost: sit still and nobody gets there", () => {
    const d = newDay(5);
    endDay(d);
    for (let i = 0; i < 400 && d.phase !== "done"; i++) tick(d, 0.1, { climb: 0, boosting: false, speed: 0 });
    const s = summary(d);
    expect(s.delivered).toBe(0);
    expect(s.beatRain).toBe(false);
    expect(s.muayThai).toBe(0);
    expect(s.line).toContain("Nobody");
    expect(s.outro).toBe("We are in paradise, now build.");
  });

  it("tells the story one line at a time and keeps the punchline for the bar", () => {
    const d = newDay(3);
    const g = d.guests[0];
    action(d, g.pos);
    expect(d.bubble?.text).toBe(g.def.hop);
    const lines: string[] = [];
    for (let t = 0; t < 40; t += 0.1) {
      tick(d, 0.1, { climb: 0, boosting: false, speed: 10 });
      const b = d.bubble?.text;
      if (b && lines[lines.length - 1] !== b) lines.push(b);
    }
    expect(lines.slice(1)).toEqual(g.def.story);
    expect(action(d, d.place.pos)).toBe("delivered");
    expect(g.heardInFull).toBe(true);
    expect(g.fast).toBe(false);
    expect(d.bubble?.text).toBe(g.def.arrival);
  });

  it("gives the bonus for beating the story, and lets a guest off anywhere", () => {
    const d = newDay(3);
    const g = d.guests[1];
    action(d, g.pos);
    tick(d, 1, { climb: 0, boosting: false, speed: 10 });
    expect(action(d, { x: 0, z: 0 })).toBe("dropped");
    expect(g.phase).toBe("waiting");
    expect(dist2(g.pos, { x: 0, z: 0 })).toBeLessThan(5);
    expect(action(d, g.pos)).toBe("picked");
    expect(action(d, d.place.pos)).toBe("delivered");
    expect(g.fast).toBe(true);
    expect(d.bubble?.text).toBe(g.def.early);
    expect(action(d, d.place.pos)).toBe("nothing");
  });

  it("drains energy on hills and in the rain, and pad thai puts it back", () => {
    const d = newDay(8);
    for (let i = 0; i < 100; i++) tick(d, 0.1, { climb: 0.25, boosting: true, speed: 12 });
    const afterHill = d.energy;
    expect(afterHill).toBeLessThan(100);
    const flat = newDay(8);
    for (let i = 0; i < 100; i++) tick(flat, 0.1, { climb: 0, boosting: false, speed: 12 });
    expect(flat.energy).toBeGreaterThan(afterHill);
    const parked = newDay(8);
    for (let i = 0; i < 100; i++) tick(parked, 0.1, { climb: 0, boosting: false, speed: 0 });
    expect(parked.energy).toBe(100);
    expect(padThai(d, PAD_THAI_STOPS[0].pos)).toBe(true);
    expect(d.energy).toBe(100);
    expect(d.padThai).toBe(1);
    expect(padThai(d, PAD_THAI_STOPS[0].pos)).toBe(false);
    expect(padThai(d, { x: 0, z: 0 })).toBe(false);
  });

  it("stops you at the checkpoint only with a guest on the back", () => {
    const d = newDay(4);
    expect(checkpoint(d)).toBe(false);
    action(d, d.guests[0].pos);
    expect(checkpoint(d)).toBe(true);
    expect(d.checkpointStops).toBe(1);
    expect(checkpoint(d)).toBe(false);
  });

  it("scores the Muay Thai by how close to the beat you hit", () => {
    const d = newDay(12);
    endDay(d);
    const r = d.rhythm!;
    expect(r.beats.length).toBe(BEATS);
    for (let i = 1; i < r.beats.length; i++) expect(r.beats[i].at).toBeGreaterThan(r.beats[i - 1].at);
    // Perfect run: hit every beat exactly.
    let idx = 0;
    while (d.phase !== "done") {
      tick(d, 0.01, { climb: 0, boosting: false, speed: 0 });
      if (idx < r.beats.length && r.t >= r.beats[idx].at) {
        expect(hit(d)).toBe("perfect");
        idx++;
      }
    }
    expect(muayThaiScore(r)).toBe(BEATS);
    expect(summary(d).ready).toContain("Ready");
    expect(hit(d)).toBeNull();
    // A late but not hopeless hit is good.
    const e = newDay(12);
    endDay(e);
    while (e.rhythm!.t < e.rhythm!.beats[0].at + 0.15) tick(e, 0.01, { climb: 0, boosting: false, speed: 0 });
    expect(hit(e)).toBe("good");
  });
});
