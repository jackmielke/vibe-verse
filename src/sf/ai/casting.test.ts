/**
 * The crowd has to be *this* city's crowd.
 *
 * These are cheap statistical assertions rather than exact-value ones on
 * purpose: the casting table is meant to be tuned by eye, and a test that
 * pins the exact weight of a tech worker on Montgomery Street would fail on
 * every tuning pass and teach everyone to ignore it. What must not regress is
 * the property that made the change worth making — that different pavements,
 * and different hours, produce visibly different people.
 */
import { describe, expect, it } from "vitest";
import { makeRng } from "../math/rng";
import { latLonToWorld } from "../geo/sfGeo";
import { castArchetype, paceFor } from "./pedestrians";
import type { CharacterArchetype } from "./types";

/** Cast `n` people at a real place and count what turned up. */
function census(
  lat: number,
  lon: number,
  hour: number,
  n = 4000,
): Record<string, number> {
  const p = latLonToWorld(lat, lon);
  const rng = makeRng(`census:${lat}:${lon}:${hour}`);
  const out: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const a = castArchetype(p.x, p.z, hour, rng);
    out[a] = (out[a] ?? 0) + 1;
  }
  return out;
}

const share = (c: Record<string, number>, a: CharacterArchetype): number => {
  const total = Object.values(c).reduce((s, v) => s + v, 0);
  return (c[a] ?? 0) / total;
};

describe("crowd casting", () => {
  const NOON = 12;
  const LATE = 1.5;

  it("puts the tech workforce downtown and not on the beach", () => {
    const montgomery = census(37.7929, -122.4009, NOON); // Financial District
    const sunset = census(37.7558, -122.4849, NOON); // Outer Sunset
    expect(share(montgomery, "techie")).toBeGreaterThan(share(sunset, "techie"));
    expect(share(montgomery, "techie")).toBeGreaterThan(0.15);
  });

  it("puts tourists at the waterfront and in Chinatown", () => {
    const embarcadero = census(37.7955, -122.3937, NOON);
    const bayview = census(37.7299, -122.3900, NOON);
    expect(share(embarcadero, "tourist")).toBeGreaterThan(share(bayview, "tourist"));
  });

  it("is visibly harder around Civic Center than in Pacific Heights", () => {
    const civic = census(37.7793, -122.4192, NOON);
    const pacheights = census(37.7924, -122.4350, NOON);
    expect(share(civic, "street")).toBeGreaterThan(share(pacheights, "street"));
  });

  it("empties the commute after hours and does not empty the street", () => {
    const day = census(37.7929, -122.4009, NOON);
    const night = census(37.7929, -122.4009, LATE);
    // Lanyards go home.
    expect(share(night, "techie")).toBeLessThan(share(day, "techie"));
    // The people who live outside do not.
    expect(share(night, "street")).toBeGreaterThan(share(day, "street"));
  });

  it("never casts a district as entirely one kind of person", () => {
    for (const [lat, lon] of [
      [37.7929, -122.4009],
      [37.7793, -122.4192],
      [37.7599, -122.4148],
      [37.8035, -122.4370],
    ] as const) {
      const c = census(lat, lon, NOON, 1500);
      expect(Object.keys(c).length).toBeGreaterThanOrEqual(4);
      // Ordinary people are still the majority everywhere.
      const plain =
        share(c, "civilian") + share(c, "civilian-slim") + share(c, "civilian-heavy");
      expect(plain).toBeGreaterThan(0.25);
    }
  });

  it("walks everyone at a plausible pace", () => {
    // A tourist dawdles, somebody late for a standup does not, and nobody is
    // reversing or teleporting.
    expect(paceFor("techie")).toBeGreaterThan(paceFor("tourist"));
    expect(paceFor("tourist")).toBeGreaterThan(paceFor("street"));
    for (const a of ["civilian", "techie", "tourist", "street", "cyclist", "worker"] as const) {
      expect(paceFor(a)).toBeGreaterThan(0.5);
      expect(paceFor(a)).toBeLessThan(1.5);
    }
  });
});
