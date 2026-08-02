/**
 * The geography is the load-bearing claim this world makes: that it is Seattle,
 * not a city. These tests pin the handful of facts that carry that claim, in
 * the terms a Seattleite would state them — the Needle is north-west of
 * downtown, Mercer Island sits between the two floating bridges, Rainier is
 * ninety-odd kilometres away on a south-south-east bearing.
 *
 * They also pin the height field, because the flight model asks it where the
 * ground is a hundred and twenty times a second and a lake that is not at 4.9 m
 * is a lake nobody can land on.
 */
import { describe, expect, it } from "vitest";
import {
  BRIDGES,
  EXTENT,
  LAKE_LEVEL,
  LANDMARKS,
  PEAKS,
  SHOW_CENTRE,
  headingBetween,
  latToZ,
  lonToX,
  trueToMagnetic,
} from "./geo";
import {
  SURFACE_LAND,
  SURFACE_LAKE,
  SURFACE_SOUND,
  buildHeightField,
  sampleHeight,
  sampleSurface,
  sampleSurfaceHeight,
} from "./field";

const at = (lat: number, lon: number) => ({ x: lonToX(lon), z: latToZ(lat) });
const landmark = (id: string) => {
  const lm = LANDMARKS.find((l) => l.id === id);
  if (!lm) throw new Error(`no landmark "${id}"`);
  return { ...lm, ...at(lm.at[0], lm.at[1]) };
};

describe("the projection", () => {
  it("puts the origin at downtown Seattle", () => {
    const o = at(47.6062, -122.3321);
    expect(Math.hypot(o.x, o.z)).toBeLessThan(1);
  });

  it("runs +X east and -Z north", () => {
    expect(lonToX(-122.2)).toBeGreaterThan(0); // Bellevue is east
    expect(latToZ(47.7)).toBeLessThan(0); // Kenmore is north
  });

  it("keeps the whole city inside the box", () => {
    for (const lm of LANDMARKS) {
      const p = at(lm.at[0], lm.at[1]);
      expect(Math.abs(p.x)).toBeLessThan(EXTENT);
      expect(Math.abs(p.z)).toBeLessThan(EXTENT);
    }
  });

  it("converts true heading to magnetic with Seattle's variation", () => {
    // Boeing Field's 14R is 159.6 true, and it is painted "14".
    expect(Math.round(trueToMagnetic(159.6) / 10)).toBe(14);
  });
});

describe("the landmarks are where Seattle put them", () => {
  it("has the Space Needle north-west of Columbia Center", () => {
    const needle = landmark("needle");
    const columbia = landmark("columbia");
    expect(needle.z).toBeLessThan(columbia.z); // north
    expect(needle.x).toBeLessThan(columbia.x); // west
    // And about 2.5 km apart, which is the walk everyone underestimates.
    const d = Math.hypot(needle.x - columbia.x, needle.z - columbia.z);
    expect(d).toBeGreaterThan(1800);
    expect(d).toBeLessThan(3200);
  });

  it("makes Columbia Center the tallest thing in the state", () => {
    const tallest = LANDMARKS.reduce((a, b) => (b.height > a.height ? b : a));
    expect(tallest.id).toBe("columbia");
    expect(tallest.height).toBeGreaterThan(280);
  });

  it("puts Bellevue about ten kilometres east across the lake", () => {
    const bellevue = landmark("bellevue600");
    expect(bellevue.x).toBeGreaterThan(9000);
    expect(bellevue.x).toBeLessThan(12000);
  });

  it("puts Boeing Field within a few kilometres of show centre", () => {
    const show = at(SHOW_CENTRE[0], SHOW_CENTRE[1]);
    const bfi = at(47.53, -122.3019);
    const range = Math.hypot(show.x - bfi.x, show.z - bfi.z);
    // The team really does stage 5 km out on an 035 heading.
    expect(range).toBeGreaterThan(3500);
    expect(range).toBeLessThan(7000);
    const bearing = (headingBetween(bfi.x, bfi.z, show.x, show.z) + 360) % 360;
    expect(bearing).toBeGreaterThan(10);
    expect(bearing).toBeLessThan(60);
  });
});

describe("the mountains", () => {
  it("puts Rainier 90-odd kilometres away, south-south-east", () => {
    const rainier = PEAKS.find((p) => p.name === "Mount Rainier")!;
    const p = at(rainier.at[0], rainier.at[1]);
    const range = Math.hypot(p.x, p.z) / 1000;
    expect(range).toBeGreaterThan(88);
    expect(range).toBeLessThan(100);
    const bearing = (headingBetween(0, 0, p.x, p.z) + 360) % 360;
    expect(bearing).toBeGreaterThan(145);
    expect(bearing).toBeLessThan(162);
    expect(rainier.height).toBeGreaterThan(4300);
  });

  it("puts Baker to the north and the Olympics to the west", () => {
    const baker = PEAKS.find((p) => p.name === "Mount Baker")!;
    const olympus = PEAKS.find((p) => p.name === "Mount Olympus")!;
    expect(latToZ(baker.at[0])).toBeLessThan(-100000);
    expect(lonToX(olympus.at[1])).toBeLessThan(-90000);
  });
});

describe("the bridges", () => {
  it("lays I-90 and SR-520 parallel across the lake", () => {
    const i90 = BRIDGES.find((b) => b.id === "i90")!;
    const sr520 = BRIDGES.find((b) => b.id === "sr520")!;
    const bearing = (b: typeof i90) =>
      (headingBetween(
        lonToX(b.from[1]),
        latToZ(b.from[0]),
        lonToX(b.to[1]),
        latToZ(b.to[0]),
      ) +
        360) %
      360;
    // Both run essentially due east, within a couple of degrees of each other.
    expect(Math.abs(bearing(i90) - bearing(sr520))).toBeLessThan(6);
    expect(bearing(i90)).toBeGreaterThan(80);
    expect(bearing(i90)).toBeLessThan(100);
    // SR-520 is the longer of the two — it is the longest on Earth.
    const span = (b: typeof i90) =>
      Math.hypot(lonToX(b.to[1]) - lonToX(b.from[1]), latToZ(b.to[0]) - latToZ(b.from[0]));
    expect(span(sr520)).toBeGreaterThan(span(i90));
    expect(span(sr520)).toBeGreaterThan(2000);
  });

  it("puts SR-520 north of I-90", () => {
    const i90 = BRIDGES.find((b) => b.id === "i90")!;
    const sr520 = BRIDGES.find((b) => b.id === "sr520")!;
    expect(latToZ(sr520.from[0])).toBeLessThan(latToZ(i90.from[0]));
  });
});

describe("the height field", () => {
  // 96 is coarse, but every claim below is about kilometre-scale geography.
  const field = buildHeightField(96);

  it("holds the lakes five metres above the sea", () => {
    const lake = at(47.6, -122.26); // mid Lake Washington
    expect(sampleSurface(field, lake.x, lake.z)).toBe(SURFACE_LAKE);
    expect(sampleSurfaceHeight(field, lake.x, lake.z)).toBeCloseTo(LAKE_LEVEL, 1);

    const sound = at(47.62, -122.42); // Puget Sound off Magnolia
    expect(sampleSurface(field, sound.x, sound.z)).toBe(SURFACE_SOUND);
    expect(sampleSurfaceHeight(field, sound.x, sound.z)).toBeCloseTo(0, 1);
  });

  it("digs the lake bed well below the surface", () => {
    const lake = at(47.6, -122.26);
    expect(sampleHeight(field, lake.x, lake.z)).toBeLessThan(-20);
  });

  it("keeps Mercer Island dry", () => {
    const mercer = at(47.57, -122.23);
    expect(sampleSurface(field, mercer.x, mercer.z)).toBe(SURFACE_LAND);
    expect(sampleHeight(field, mercer.x, mercer.z)).toBeGreaterThan(0);
  });

  it("raises the hills and flattens the Duwamish", () => {
    const westSeattle = at(47.5495, -122.376);
    const duwamish = at(47.555, -122.335);
    expect(sampleHeight(field, westSeattle.x, westSeattle.z)).toBeGreaterThan(60);
    expect(sampleHeight(field, duwamish.x, duwamish.z)).toBeLessThan(30);
  });

  it("never returns a value that would break the flight model", () => {
    for (let i = 0; i < 400; i++) {
      const x = ((i * 8191) % (EXTENT * 4)) - EXTENT * 2;
      const z = ((i * 6151) % (EXTENT * 4)) - EXTENT * 2;
      const h = sampleSurfaceHeight(field, x, z);
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeGreaterThan(-500);
      expect(h).toBeLessThan(3000);
    }
  });
});
