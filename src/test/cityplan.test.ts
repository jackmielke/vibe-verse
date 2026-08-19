/**
 * The plan is the contract six other modules build against, so the things
 * they assume have to be true: every lot has a front door on an actual
 * pavement, no building stands in a road, the nav graph is one connected
 * piece, and the skyline falls away from the middle rather than being noise.
 */
import { describe, expect, it } from "vitest";
import {
  cityPlan,
  surfaceAt,
  walkableAt,
  districtAt,
  HALO_R,
  RING_R,
  RIM_R,
  LANDMARKS,
} from "@/empyrean/cityplan";
import { ISLAND_Y, PLATEAU_R, DECKS } from "@/empyrean/config";

const plan = cityPlan();

describe("the surface", () => {
  it("is plaza in the Halo and void past the last promenade", () => {
    expect(surfaceAt(0, 0).kind).toBe("plaza");
    expect(surfaceAt(0, HALO_R - 4).kind).toBe("plaza");
    expect(surfaceAt(0, DECKS[DECKS.length - 1].outer + 5).kind).toBe("void");
  });

  /* Probed off-axis on purpose. Angle 0 is an avenue and every multiple of
     22.5 degrees is an avenue or a lane, so a test sampling along +X is
     standing in a radial road and learns nothing about the ring under it.
     PI/16 is the widest gap between two radials. */
  const OFF = Math.PI / 16;
  const at = (r: number) => [Math.cos(OFF) * r, Math.sin(OFF) * r] as const;

  it("puts a road under every ring centreline and a pavement beside it", () => {
    for (const r of RING_R) {
      expect(surfaceAt(...at(r)).kind, `ring ${r}`).toBe("road");
      expect(surfaceAt(...at(r + 10)).kind, `beside ring ${r}`).toBe("walk");
    }
    expect(surfaceAt(...at(RIM_R)).kind).toBe("road");
  });

  it("drops the roadway a kerb below the pavement", () => {
    expect(surfaceAt(...at(RING_R[0])).y).toBeLessThan(surfaceAt(...at(RING_R[0] + 10)).y);
  });

  it("gives the promenade rings a standing surface and a gap between them", () => {
    for (let i = 1; i < DECKS.length; i++) {
      const d = DECKS[i];
      const mid = d.outer - d.width / 2;
      const hit = surfaceAt(mid, 0);
      expect(hit.kind, `deck ${i}`).toBe("promenade");
      expect(hit.y).toBe(d.y);
      expect(walkableAt(mid, 0)).toBe(true);
    }
  });
});

describe("the lots", () => {
  it("makes a city's worth of them", () => {
    expect(plan.lots.length).toBeGreaterThan(80);
    expect(plan.lots.length).toBeLessThan(400);
  });

  it("never puts a building in a road or on the void", () => {
    for (const lot of plan.lots) {
      for (const p of lot.poly) {
        const s = surfaceAt(p.x, p.z);
        expect(s.kind, `${lot.id} corner on ${s.kind}`).not.toBe("road");
        expect(s.kind, `${lot.id} corner on ${s.kind}`).not.toBe("void");
      }
    }
  });

  it("puts every doorstep on ground a person can stand on", () => {
    for (const lot of plan.lots) {
      const probe = surfaceAt(lot.door.x, lot.door.z);
      expect(["walk", "plaza", "road"], `${lot.id} opens onto ${probe.kind}`).toContain(probe.kind);
    }
  });

  it("keeps the doorstep within reach of its own wall", () => {
    for (const lot of plan.lots) {
      const d = Math.hypot(lot.door.x - lot.frontMid.x, lot.door.z - lot.frontMid.z);
      expect(d, `${lot.id} doorstep is ${d.toFixed(1)} m from its wall`).toBeLessThan(9.5);
    }
  });

  it("puts every doorstep near a nav node, so somebody can actually walk to it", () => {
    for (const lot of plan.lots) {
      let best = Infinity;
      for (const n of plan.nav) {
        best = Math.min(best, Math.hypot(n.x - lot.door.x, n.z - lot.door.z));
      }
      expect(best, `${lot.id} doorstep is ${best.toFixed(1)} m from the pavement graph`).toBeLessThan(16);
    }
  });

  it("leaves the landmarks their clearance", () => {
    for (const l of LANDMARKS) {
      for (const lot of plan.lots) {
        const d = Math.hypot(l.x - lot.centroid.x, l.z - lot.centroid.z);
        expect(d, `${lot.id} is inside ${l.id}`).toBeGreaterThan(l.clear);
      }
    }
  });

  it("builds a pyramid, not a hedge — the middle is far taller than the rim", () => {
    const inner = plan.lots.filter((l) => l.r < RING_R[0]);
    const outer = plan.lots.filter((l) => l.r > RING_R[1]);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
    const hi = mean(inner.map((l) => l.height));
    const lo = mean(outer.map((l) => l.height));
    expect(hi).toBeGreaterThan(lo * 3);
    // And nothing out at the rim is allowed to compete with the Beacon.
    expect(Math.max(...outer.map((l) => l.height))).toBeLessThan(90);
  });

  it("keeps every building inside the parapet", () => {
    for (const lot of plan.lots) {
      for (const p of lot.poly) {
        expect(Math.hypot(p.x, p.z), lot.id).toBeLessThan(PLATEAU_R - 1);
      }
    }
  });

  it("stands them all on the city deck", () => {
    for (const lot of plan.lots) expect(lot.y).toBe(ISLAND_Y);
  });
});

describe("the nav graph", () => {
  it("covers the island", () => {
    expect(plan.nav.length).toBeGreaterThan(400);
  });

  /* "Walkable" is not enough here, and that gap hid a real bug.
     `walkableAt` means "not the void and not the parapet", and the inside of
     a building is neither — so 244 rim nodes sat in the lots and the test was
     green. A pedestrian node has to be on a pavement, a plaza, a promenade or
     (at a crossing) a road. */
  const PEDESTRIAN = ["walk", "plaza", "promenade", "road"];

  it("stands every node on ground a pedestrian can actually be on", () => {
    const bad = plan.nav
      .filter((n) => !PEDESTRIAN.includes(surfaceAt(n.x, n.z).kind))
      .map((n) => `${n.x.toFixed(0)},${n.z.toFixed(0)} on ${surfaceAt(n.x, n.z).kind}`);
    expect(bad.slice(0, 10), `${bad.length} nodes off the pavement`).toEqual([]);
  });

  it("never links two nodes through a building", () => {
    const bad: string[] = [];
    for (const n of plan.nav) {
      for (const l of n.links) {
        const m = plan.nav[l];
        for (let t = 1; t <= 5; t++) {
          const f = t / 6;
          const k = surfaceAt(n.x + (m.x - n.x) * f, n.z + (m.z - n.z) * f).kind;
          if (k === "lot" || k === "void") bad.push(`${n.id}->${l} crosses ${k}`);
        }
      }
    }
    expect(bad.slice(0, 10), `${bad.length} edges cut through geometry`).toEqual([]);
  });

  it("is one connected piece — an island in the graph is a crowd that never arrives", () => {
    const seen = new Set<number>([0]);
    const queue = [0];
    while (queue.length) {
      const n = plan.nav[queue.pop()!];
      for (const l of n.links) if (!seen.has(l)) { seen.add(l); queue.push(l); }
    }
    expect(seen.size).toBe(plan.nav.length);
  });

  it("links every node to at least one other", () => {
    expect(plan.nav.filter((n) => n.links.length === 0)).toEqual([]);
  });
});

describe("districts", () => {
  it("names the band you are standing in", () => {
    expect(districtAt(10).id).toBe("halo");
    expect(districtAt(HALO_R + 10).id).toBe("core");
    expect(districtAt(RING_R[0] + 10).id).toBe("market");
    expect(districtAt(RING_R[1] + 10).id).toBe("gardens");
    expect(districtAt(RING_R[2] + 10).id).toBe("rim");
  });
});
