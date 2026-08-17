/**
 * The map of Vibe Francisco has to agree with San Francisco.
 *
 * Everything in that world is a pure function of `map.ts` — where the ground
 * is, where the water starts, which way the streets run — so a sign error in
 * one of them does not produce a small visual bug, it produces a city that is
 * mostly ocean. Which is exactly what the first build was: `shoreSDF` decides
 * land from water by which side of the seawall a point falls on, and "which
 * side" is a cross product that is right or backwards with equal ease.
 *
 * These are geography tests, not unit tests. Each one names a real place and
 * asserts the thing a San Franciscan would notice.
 */
import { describe, expect, it } from "vitest";
import {
  BOUNDS,
  MARKET_ANGLE,
  alongMarket,
  districtAt,
  groundHeight,
  isRoad,
  isWater,
  ll,
  roadAt,
  shoreSDF,
  sideOfMarket,
  walkHeight,
} from "@/frisco/map";

/** A few real places, by name, so a failure reads as a place rather than a number. */
const PLACES = {
  marketAndMontgomery: ll(37.7936, -122.4014),
  transamerica: ll(37.7952, -122.4028),
  coitTower: ll(37.8024, -122.4058),
  unionSquare: ll(37.7879, -122.4075),
  chinatown: ll(37.7941, -122.4078),
  ferryBuilding: ll(37.7955, -122.3937),
  nobHill: ll(37.793, -122.4161),
  soma: ll(37.7815, -122.3968),
  // Out in the bay, where nobody has ever built anything.
  midBay: ll(37.815, -122.375),
  alcatrazWater: ll(37.82, -122.4),
};

describe("Vibe Francisco — land and water", () => {
  it("puts downtown on dry land", () => {
    for (const [name, p] of Object.entries(PLACES)) {
      if (name === "midBay" || name === "alcatrazWater") continue;
      expect(isWater(p.x, p.z), `${name} should be land`).toBe(false);
      expect(groundHeight(p.x, p.z), `${name} should be above sea level`).toBeGreaterThan(0);
    }
  });

  it("puts the bay in the bay", () => {
    for (const name of ["midBay", "alcatrazWater"] as const) {
      const p = PLACES[name];
      expect(isWater(p.x, p.z), `${name} should be water`).toBe(true);
    }
  });

  it("agrees with itself about which side of the seawall land is on", () => {
    // The sign convention is the whole ballgame: positive inland, negative wet.
    expect(shoreSDF(PLACES.unionSquare.x, PLACES.unionSquare.z)).toBeGreaterThan(0);
    expect(shoreSDF(PLACES.midBay.x, PLACES.midBay.z)).toBeLessThan(0);
  });

  it("keeps most of the map dry", () => {
    // A city that is 90% ocean is the failure this file exists to catch, and it
    // is invisible in any single sample.
    let land = 0;
    let total = 0;
    for (let x = BOUNDS.minX; x < BOUNDS.maxX; x += 40) {
      for (let z = BOUNDS.minZ; z < BOUNDS.maxZ; z += 40) {
        total++;
        if (!isWater(x, z)) land++;
      }
    }
    const ratio = land / total;
    // Downtown SF with the bay on two sides: somewhere near half, and
    // emphatically not near zero or one.
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.85);
  });

  it("never lets a walkable height fall below the sea", () => {
    for (let x = BOUNDS.minX; x < BOUNDS.maxX; x += 137) {
      for (let z = BOUNDS.minZ; z < BOUNDS.maxZ; z += 149) {
        expect(walkHeight(x, z)).toBeGreaterThanOrEqual(BOUNDS.seaLevel);
      }
    }
  });
});

describe("Vibe Francisco — hills", () => {
  it("stacks the hills in the order San Francisco stacks them", () => {
    const nob = groundHeight(PLACES.nobHill.x, PLACES.nobHill.z);
    const coit = groundHeight(PLACES.coitTower.x, PLACES.coitTower.z);
    const soma = groundHeight(PLACES.soma.x, PLACES.soma.z);
    // Nob Hill is the tallest of the three; SoMa is flat, and famously so.
    expect(nob).toBeGreaterThan(coit);
    expect(coit).toBeGreaterThan(soma + 30);
    expect(soma).toBeLessThan(24);
  });

  it("makes Nob Hill a climb rather than a bump", () => {
    const top = groundHeight(PLACES.nobHill.x, PLACES.nobHill.z);
    const bottom = groundHeight(PLACES.marketAndMontgomery.x, PLACES.marketAndMontgomery.z);
    expect(top - bottom).toBeGreaterThan(70);
  });
});

describe("Vibe Francisco — the two grids", () => {
  it("runs Market from the Ferry Building toward the south-west", () => {
    // The bearing is what both grids are built off; if it drifts, the whole
    // downtown shears.
    expect(MARKET_ANGLE).toBeGreaterThan(2.2);
    expect(MARKET_ANGLE).toBeLessThan(2.7);
  });

  it("puts the Financial District north of Market and SoMa south of it", () => {
    expect(sideOfMarket(PLACES.transamerica.x, PLACES.transamerica.z)).toBeGreaterThan(0);
    expect(sideOfMarket(PLACES.chinatown.x, PLACES.chinatown.z)).toBeGreaterThan(0);
    expect(sideOfMarket(PLACES.soma.x, PLACES.soma.z)).toBeLessThan(0);
  });

  it("orders the city along Market the way the street runs", () => {
    // The Ferry Building is at the foot of Market; Union Square is up it.
    const ferry = alongMarket(PLACES.ferryBuilding.x, PLACES.ferryBuilding.z);
    const union = alongMarket(PLACES.unionSquare.x, PLACES.unionSquare.z);
    expect(union).toBeGreaterThan(ferry);
  });

  it("finds a road under a reasonable share of downtown", () => {
    let onRoad = 0;
    let total = 0;
    for (let x = -600; x < 600; x += 11) {
      for (let z = -600; z < 600; z += 11) {
        if (isWater(x, z)) continue;
        total++;
        if (isRoad(x, z)) onRoad++;
      }
    }
    const ratio = onRoad / total;
    // A dense downtown is roughly a fifth to a third asphalt. Zero means the
    // grid is not where the blocks are; one means everything is a road.
    expect(ratio).toBeGreaterThan(0.12);
    expect(ratio).toBeLessThan(0.5);
  });

  it("gives every point a road direction that is a unit vector", () => {
    for (let x = -500; x < 500; x += 97) {
      for (let z = -500; z < 500; z += 89) {
        const r = roadAt(x, z);
        expect(Math.hypot(r.dir.x, r.dir.z)).toBeCloseTo(1, 5);
      }
    }
  });
});

describe("Vibe Francisco — districts", () => {
  it("names the district you are standing in", () => {
    expect(districtAt(PLACES.chinatown.x, PLACES.chinatown.z).district.key).toBe("chinatown");
    expect(districtAt(PLACES.unionSquare.x, PLACES.unionSquare.z).district.key).toBe("union");
    expect(districtAt(PLACES.soma.x, PLACES.soma.z).district.key).toBe("soma");
  });

  it("builds taller in the Financial District than in North Beach", () => {
    const fin = districtAt(PLACES.transamerica.x, PLACES.transamerica.z).district;
    const beach = districtAt(ll(37.8003, -122.4104).x, ll(37.8003, -122.4104).z).district;
    expect(fin.maxH).toBeGreaterThan(beach.maxH * 3);
  });
});

/**
 * The depth range, which is a rendering concern that belongs in a map test
 * because it is a property of how big the world is.
 *
 * Vibe Francisco spent a day rendering as a black screen with a few slivers in
 * it. Everything measurable was correct — geometry, indices, colours, camera,
 * culling, lights, materials — and 218 000 triangles were being submitted every
 * frame. The fault was that a 2.4 km world seen with a 0.4 m near plane puts
 * everything past a hundred metres into the last quarter of one percent of a
 * conventional depth buffer, and on a renderer without 24 bits to spare the
 * entire city collapses to one depth value and vanishes.
 *
 * The engine now asks for a logarithmic depth buffer, which makes the ratio a
 * non-issue. This guards the assumption behind that decision: if the map ever
 * grows, or the near plane is ever pulled in, the numbers below are what make
 * the choice necessary rather than incidental.
 */
describe("Vibe Francisco — the depth range", () => {
  it("needs more depth range than a conventional buffer would give it", () => {
    const near = 0.4;
    const far = 4200;
    const span = Math.hypot(BOUNDS.maxX - BOUNDS.minX, BOUNDS.maxZ - BOUNDS.minZ);
    expect(far).toBeGreaterThan(span);
    // The ratio is the thing. Anything over a few thousand to one is where a
    // 16-bit depth buffer stops being able to tell the far half of the world
    // apart from the far plane.
    expect(far / near).toBeGreaterThan(3000);
  });

  it("keeps the sky dome inside the far plane", () => {
    // A dome outside the far plane is clipped away and the sky renders as the
    // clear colour, which reads as "the world failed to load".
    const DOME_RADIUS = 3800;
    expect(DOME_RADIUS).toBeLessThan(4200);
    // ...and outside the world, so you can never fly to the edge of it.
    expect(DOME_RADIUS).toBeGreaterThan(
      Math.hypot(BOUNDS.maxX - BOUNDS.minX, BOUNDS.maxZ - BOUNDS.minZ),
    );
  });
});
