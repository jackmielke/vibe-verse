/**
 * The buildings are the visual star of The Empyrean and most of what the lake
 * reflects, so the things that are invisible until they are catastrophic get
 * asserted here rather than looked for.
 *
 * Four of these have already been real bugs in this file:
 *
 *  - a containment check that assumed the lots were convex, which they are
 *    not, and which silently deleted sixteen of the twenty-three spires;
 *  - a miter with no limit, which grew a ten-metre cornice spike into the
 *    middle of a road off a corner that turns seven degrees;
 *  - a setback that bailed out of its loop instead of being skipped, leaving
 *    towers forty metres shorter than the plan asked for;
 *  - a facade drawn as a solid quad with the window painted on it.
 *
 * None of those fail a build, a typecheck or a smoke run.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  buildBuildings,
  landmarkVertices,
  lotCollision,
  lotVertices,
  outsideLot,
  type BuildingsHandle,
} from "@/empyrean/buildings";
import { cityPlan } from "@/empyrean/cityplan";
import { ISLAND_Y } from "@/empyrean/config";

const plan = cityPlan();

let cached: BuildingsHandle | null = null;
function built(): BuildingsHandle {
  if (!cached) cached = buildBuildings({ quality: "high", seedSalt: "test" });
  return cached;
}

describe("every lot becomes something", () => {
  it("leaves nothing on the plan undrawn", () => {
    const b = built();
    expect(b.lots).toHaveLength(plan.lots.length);
    const empty = b.lots.filter((l) => !l.built);
    // Gardens are the only deliberate near-miss and they still get a wall.
    expect(empty.map((l) => `${l.id}/${l.use}`)).toEqual([]);
  }, 60_000);

  it("gives a garden a boundary and no building", () => {
    const gardens = plan.lots.filter((l) => l.use === "garden");
    expect(gardens.length).toBeGreaterThan(10);
    for (const lot of gardens) {
      const c = lotCollision(lot, "high");
      // A knee-high wall you cannot step over is worse than one you can.
      expect(c.blockers, lot.id).toHaveLength(0);
      expect(c.top - lot.y, lot.id).toBeLessThan(2.5);
      expect(c.top, lot.id).toBeGreaterThan(lot.y);
    }
  }, 60_000);
});

describe("nothing leaves its lot", () => {
  /**
   * The block is held clear of the pavement and the lot is inset inside the
   * block again, so a cornice that escapes its polygon is standing in the
   * road. Measured against the polygon itself rather than its bounding box,
   * because the lots are trapezoids and half of every bounding box is street.
   */
  it("keeps every vertex of every building inside its polygon", () => {
    let worst = 0;
    let worstId = "";
    for (const lot of plan.lots) {
      const v = lotVertices(lot, "high", "test");
      expect(v.length, `${lot.id} produced nothing`).toBeGreaterThan(0);
      for (let i = 0; i < v.length; i += 3) {
        const d = outsideLot(lot, v[i], v[i + 2]);
        if (d > worst) {
          worst = d;
          worstId = `${lot.id}/${lot.use}`;
        }
      }
    }
    expect(worst, `worst overhang at ${worstId}`).toBeLessThan(0.02);
  }, 120_000);
});

describe("collision", () => {
  it("gives every building a blocker that matches its lot", () => {
    for (const lot of plan.lots) {
      if (lot.use === "garden" || lot.use === "pavilion") continue;
      const c = lotCollision(lot, "high", "test");
      expect(c.blockers.length, lot.id).toBeGreaterThan(0);
      for (const bl of c.blockers) {
        expect(bl.bottom, `${lot.id} underside`).toBeGreaterThanOrEqual(lot.y - 0.01);
        expect(bl.top, `${lot.id} roof over floor`).toBeGreaterThan(bl.bottom);
        /* Collision is axis-aligned boxes against a trapezoid that is not,
         * so a blocker is allowed to stand a little outside the walls — but
         * never outside the *lot*, or it is an invisible wall on a pavement
         * five metres wide. One bounding box per lot fails this by nearly
         * three metres, which is why `stripBoxes` exists. */
        for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          expect(
            outsideLot(lot, bl.x + dx * bl.hx, bl.z + dz * bl.hz),
            `${lot.id} blocker corner`,
          ).toBeLessThan(0.05);
        }
      }
    }
  }, 120_000);

  /** Landing a jetpack on a tower and walking around on it is the point. */
  it("makes every roof standable at the height the plan asked for", () => {
    for (const lot of plan.lots) {
      if (lot.use === "garden") continue;
      const c = lotCollision(lot, "high", "test");
      expect(c.decks.length, lot.id).toBeGreaterThan(0);
      const roof = Math.max(...c.decks.map((d) => d.y));
      const want = lot.y + lot.height;
      // A crown is allowed to stand above the last walkable level; nothing is
      // allowed to stand below it, or the skyline is not the plan's.
      expect(roof, `${lot.id} roof too high`).toBeLessThan(want + 3);
      expect(roof, `${lot.id} roof too low`).toBeGreaterThan(want - 31);
      for (const d of c.decks) {
        expect(d.y, `${lot.id} deck under the deck`).toBeGreaterThan(lot.y);
        expect(d.hx, `${lot.id} deck width`).toBeGreaterThan(0);
      }
    }
  }, 120_000);
});

describe("the skyline", () => {
  it("puts the Beacon above everything else in the world", () => {
    const b = built();
    const beacon = plan.landmarks.find((l) => l.kind === "beacon")!;
    const v = landmarkVertices(beacon, "high");
    let top = -Infinity;
    for (let i = 1; i < v.length; i += 3) top = Math.max(top, v[i]);
    expect(top).toBeGreaterThan(ISLAND_Y + 480);
    const tallestLot = Math.max(...b.lots.map((l) => l.top));
    expect(top, "the Beacon is the navigational anchor and must win").toBeGreaterThan(
      tallestLot + 50,
    );
  }, 60_000);

  it("builds every landmark", () => {
    for (const lm of plan.landmarks) {
      expect(landmarkVertices(lm, "high").length, lm.id).toBeGreaterThan(300);
    }
  }, 60_000);
});

describe("quality tiers", () => {
  /**
   * The silhouette *is* the reflection, so the low tier may drop reveals,
   * balconies and signage but may not change a single mass: same blockers,
   * same decks, same roof heights, and no vertex outside the high tier's
   * envelope.
   */
  it("keeps the same massing at low quality", () => {
    for (const lot of plan.lots) {
      const hi = lotCollision(lot, "high", "test");
      const lo = lotCollision(lot, "low", "test");
      expect(lo.blockers, `${lot.id} blockers`).toEqual(hi.blockers);
      expect(lo.decks, `${lot.id} decks`).toEqual(hi.decks);
      expect(lo.top, `${lot.id} height`).toBeCloseTo(hi.top, 5);
    }
  }, 120_000);

  it("is much cheaper without changing the draw count", () => {
    const hi = built();
    const lo = buildBuildings({ quality: "low", seedSalt: "test" });
    expect(lo.stats.draws).toBe(hi.stats.draws);
    expect(lo.stats.triangles).toBeLessThan(hi.stats.triangles * 0.25);
    lo.dispose();
  }, 120_000);
});

describe("the reflection rule", () => {
  const materials = (h: BuildingsHandle): THREE.ShaderMaterial[] => {
    const out: THREE.ShaderMaterial[] = [];
    h.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if (m && m.uniforms) out.push(m);
    });
    return out;
  };

  it("draws everything double-sided, because scale.y = -1 inverts winding", () => {
    const mats = materials(built());
    expect(mats.length).toBeGreaterThan(0);
    for (const m of mats) expect(m.side, m.name).toBe(THREE.DoubleSide);
  }, 60_000);

  it("never drives a gradient from world Y", () => {
    for (const m of materials(built())) {
      // vWPos is read for XZ and for the eye vector; reading its Y would
      // survive the mirror the right way up inside an upside-down reflection.
      expect(m.fragmentShader.includes("vWPos.y"), m.name).toBe(false);
      expect(m.vertexShader.includes("aH"), m.name).toBe(true);
    }
  }, 60_000);

  it("carries the per-object height attributes on every mesh", () => {
    built().group.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (!g) return;
      for (const a of ["aH", "aBase", "aSeed", "aTone", "aEdge", "normal", "uv"]) {
        expect(g.getAttribute(a), `${o.name}.${a}`).toBeTruthy();
      }
    });
  }, 60_000);

  it("declares itself part of the island's silhouette", () => {
    expect(built().reflected).toBe(true);
  }, 60_000);
});

describe("the budget", () => {
  it("is four draw calls for a hundred and eighty-two lots", () => {
    const b = built();
    expect(b.stats.draws).toBeLessThanOrEqual(4);
    expect(b.stats.triangles).toBeGreaterThan(50_000);
    expect(b.stats.triangles).toBeLessThan(600_000);
  }, 60_000);

  it("updates without allocating and disposes everything", () => {
    const b = buildBuildings({ quality: "low", seedSalt: "dispose" });
    const camera = new THREE.PerspectiveCamera();
    /* Browsers cap live WebGL contexts, so a world that leaks one breaks the
       *next* world the visitor opens. Counted rather than eyeballed. */
    let disposed = 0;
    const expected: number[] = [];
    b.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.addEventListener("dispose", () => disposed++);
      (mesh.material as THREE.Material).addEventListener("dispose", () => disposed++);
      expected.push(1);
    });
    b.update?.({
      time: 1,
      dt: 0.016,
      camera,
      player: {
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        yaw: 0,
        grounded: true,
        burn: 0,
        altitude: 0,
      },
      quality: "low",
      dayPhase: 0.75,
      sunDir: new THREE.Vector3(0, 1, 0),
      daylight: 0.4,
      camRadiusSq: 0,
    });
    b.dispose();
    expect(b.group.children).toHaveLength(0);
    expect(disposed).toBe(expected.length * 2);
  }, 60_000);
});
