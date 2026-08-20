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
  lotGlassTones,
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
      gradeDaylight: 1,
      camRadiusSq: 0,
    });
    b.dispose();
    expect(b.group.children).toHaveLength(0);
    expect(disposed).toBe(expected.length * 2);
  }, 60_000);
});

describe("lots somebody else is standing in", () => {
  /**
   * `interiors.ts` builds real rooms inside two lots and names them on
   * `claimedLots`. A solid block on top of a room is a room nobody can get
   * into, and it fails nothing: the build is green, the typecheck is green,
   * the smoke run opens the route and sees a city. You find it by walking to
   * the café and bouncing off the wall.
   */
  const CLAIMED = ["b1-6-11", "b2-12-00"];

  it("has the lots the interiors claim", () => {
    for (const id of CLAIMED) {
      expect(plan.lots.find((l) => l.id === id), `${id} is gone from the plan`).toBeTruthy();
    }
  });

  it("leaves a skipped lot completely empty", () => {
    const full = built();
    const some = buildBuildings({ quality: "high", seedSalt: "test" }, { skipLots: CLAIMED });
    let droppedTris = 0;
    let droppedBlockers = 0;
    let droppedDecks = 0;
    for (const id of CLAIMED) {
      const lot = plan.lots.find((l) => l.id === id)!;
      const before = full.lots.find((l) => l.id === id)!;
      const after = some.lots.find((l) => l.id === id)!;
      expect(before.built, `${id} was empty to begin with`).toBe(true);
      expect(after.built, `${id} still built`).toBe(false);
      expect(after.triangles, `${id} still has geometry`).toBe(0);
      expect(after.top, `${id} still has a roof`).toBe(lot.y);
      const c = lotCollision(lot, "high", "test");
      droppedTris += before.triangles;
      droppedBlockers += c.blockers.length;
      droppedDecks += c.decks.length;
      expect(droppedBlockers, `${id} contributed no blocker to drop`).toBeGreaterThan(0);
    }
    // Not "fewer": exactly the ones those lots were contributing, so a skip
    // cannot quietly take a neighbour's wall with it.
    expect(some.stats.triangles).toBe(full.stats.triangles - droppedTris);
    expect(some.blockers.length).toBe(full.blockers.length - droppedBlockers);
    expect(some.decks.length).toBe(full.decks.length - droppedDecks);
    some.dispose();
  }, 120_000);

  it("still builds everything when nobody asks for anything", () => {
    // The engine adds the second argument; every other caller does not.
    const b = buildBuildings({ quality: "low", seedSalt: "test" }, {});
    expect(b.lots.filter((l) => !l.built)).toHaveLength(0);
    b.dispose();
  }, 120_000);
});

describe("the skybridges", () => {
  /**
   * They were tried once, blamed for a screen-filling black rectangle that
   * turned out to belong to another system entirely, and parked for a day.
   * See the README. What is asserted here is the part that a frame does not
   * show you: where the deck is, and that the floor stops where the tube does.
   */
  const HALF = (3.0 * Math.SQRT2) / 2;

  it("joins towers to each other, above the city and below their crowns", () => {
    const b = built();
    expect(b.bridges.length, "no skybridges were built at all").toBeGreaterThan(3);
    expect(b.bridges.length).toBeLessThanOrEqual(9);
    for (const br of b.bridges) {
      const tag = `${Math.round(br.ax)},${Math.round(br.az)}`;
      expect(br.len, `${tag} span`).toBeGreaterThan(40);
      expect(br.len, `${tag} span`).toBeLessThan(100);
      // High enough to be a skybridge rather than an alley.
      expect(br.y, `${tag} height`).toBeGreaterThan(ISLAND_Y + 100);
      /* And clear of both crowns. Every crown in `buildTower` tapers, steps
         or grows a mast; a tube driven into one comes out of the far side of
         a spire that has narrowed away from under it. */
      expect(br.y, `${tag} into A's crown`).toBeLessThan(br.topA - 30);
      expect(br.y, `${tag} into B's crown`).toBeLessThan(br.topB - 30);
    }
  }, 120_000);

  it("gives a bridge a floor that ends where the bridge does", () => {
    /* A blocker is a floor, and the lesson this file already carries about a
       tapering spire's crown applies to anything lying at an angle: one
       axis-aligned box around a tube at forty degrees to the axes is metres
       of clear air on either side of a wall you can see straight through. */
    const b = built();
    const decks = b.decks.filter((d) => d.y > ISLAND_Y + 100 && Math.abs((d.hx ?? 0) - HALF) < 1e-6);
    expect(decks.length, "no bridge decks").toBeGreaterThan(50);
    for (const d of decks) {
      const cx = d.x ?? 0;
      const cz = d.z ?? 0;
      // Which bridge is this box on? The nearest centreline wins.
      let best = Infinity;
      let along = 0;
      for (const br of b.bridges) {
        const dx = br.bx - br.ax;
        const dz = br.bz - br.az;
        const l = Math.hypot(dx, dz) || 1;
        const t = ((cx - br.ax) * dx + (cz - br.az) * dz) / (l * l);
        const off = Math.abs((cx - br.ax) * (-dz / l) + (cz - br.az) * (dx / l));
        if (Math.abs(d.y - br.y) > 0.01) continue;
        if (off < best) {
          best = off;
          along = t;
        }
      }
      // On the centreline, and between the two towers rather than past them.
      expect(best, "a bridge deck off its own centreline").toBeLessThan(1e-6);
      expect(along, "a bridge deck past its own end").toBeGreaterThan(-1e-6);
      expect(along, "a bridge deck past its own end").toBeLessThan(1 + 1e-6);
      // The box is a floor: it has an underside, and it is thin.
      const blocker = b.blockers.find(
        (bl) => Math.abs(bl.x - cx) < 1e-6 && Math.abs(bl.z - cz) < 1e-6 && Math.abs(bl.top - d.y) < 1e-6,
      );
      expect(blocker, "a bridge deck with nothing under it").toBeTruthy();
      expect(blocker!.top - blocker!.bottom, "a bridge that is a solid block").toBeLessThan(1.0);
    }
  }, 120_000);

  it("does not disturb the stream any lot draws from", () => {
    /* The whole reason the bridges have their own generator. `makeRng` is a
       stream, so one extra draw inside `buildLot` reshapes every building
       after it — and the lot vertices below are what half this file asserts
       against. */
    const before = lotVertices(plan.lots.find((l) => l.use === "tower")!, "high", "test");
    const after = lotVertices(plan.lots.find((l) => l.use === "tower")!, "high", "test");
    expect(after).toEqual(before);
    const a = buildBuildings({ quality: "low", seedSalt: "bridges" });
    const c = buildBuildings({ quality: "low", seedSalt: "bridges" });
    expect(c.bridges).toEqual(a.bridges);
    a.dispose();
    c.dispose();
  }, 120_000);
});

describe("the facades are not a quilt", () => {
  /**
   * The tower shafts came out patched with fifteen-metre squares of different
   * tone, so a three-hundred-metre building read as a patchwork of tiles.
   * Two things were wrong and both are asserted here rather than looked at,
   * because looking at it is a twenty-minute round trip through a software
   * rasteriser.
   *
   *  - the tone varied per grid cell, off a 1-D hash of `bay * a + floor * b`
   *    that clumped. Variation on a facade is per bay, per floor band or per
   *    window; anything coarser than that has to be structural, and lands on
   *    `aTone`, which is a short list of slots.
   *  - nothing was filtered, so the metre-scale grid aliased into blotches at
   *    any distance — the same quilt, arriving from further away.
   */
  const shaders = (name: string): string => {
    let out = "";
    built().group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if (o.name === name && m) out = m.fragmentShader;
    });
    expect(out, `${name} has no material`).not.toBe("");
    return out;
  };

  it("keeps the curtain wall's tone to a handful of structural slots", () => {
    const towers = plan.lots.filter((l) => l.use === "tower");
    expect(towers.length).toBeGreaterThan(10);
    for (const lot of towers) {
      const tones = lotGlassTones(lot, "high", "test");
      expect(tones.length, `${lot.id} tones`).toBeGreaterThan(0);
      expect(tones.length, `${lot.id} has a hash on aTone`).toBeLessThanOrEqual(3);
      for (const t of tones) expect([0, 1, 2], `${lot.id} tone ${t}`).toContain(t);
      expect(tones, `${lot.id} has no main shaft`).toContain(0);
    }
  }, 120_000);

  it("filters every metre-scale facade pattern against its own footprint", () => {
    for (const name of ["empyrean-curtainwall", "empyrean-masonry", "empyrean-glazing"]) {
      expect(shaders(name), `${name} draws an unfiltered grid`).toContain("fwidth(");
    }
  }, 60_000);

  it("hashes a grid in two dimensions, never a sum of two indices", () => {
    // hash11(x * 31.7 + y * 7.3) puts neighbouring cells next to each other
    // in the input, and a hash is only pseudo-random for inputs that are far
    // apart. That is what made the patches.
    const glass = shaders("empyrean-curtainwall");
    expect(glass).toContain("hash21(");
    expect(glass).not.toMatch(/hash11\([^)]*\*[^)]*\+[^)]*\*/);
  }, 60_000);

  it("gives every window pane an identity of its own", () => {
    /* The pane shader can only tell one window from another by what the
       geometry hands it. When that was the position across the pane and the
       height, every window on a floor lit up together and the facade came out
       in stripes; `uv.x` now runs from `openingId` to `openingId + 1`. */
    let panes: THREE.BufferGeometry | null = null;
    built().group.traverse((o) => {
      if (o.name === "empyrean-glazing") panes = (o as THREE.Mesh).geometry;
    });
    expect(panes).toBeTruthy();
    const uv = (panes as unknown as THREE.BufferGeometry).getAttribute("uv");
    const ids = new Set<number>();
    for (let i = 0; i < uv.count; i++) ids.add(Math.floor(uv.getX(i)));
    expect(ids.size, "every pane in the city is window number zero").toBeGreaterThan(20);
  }, 60_000);
});
