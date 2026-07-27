import { describe, expect, it } from "vitest";
import {
  PLACES,
  dealRounds,
  haversineKm,
  scoreFor,
  ROUNDS_PER_GAME,
} from "@/lib/globetrotterPlaces";

describe("globetrotter geography", () => {
  it("measures known real-world distances accurately", () => {
    const sf = { lat: 37.7955, lng: -122.3937 };
    const lisbon = { lat: 38.7118, lng: -9.1287 };
    // SF → Lisbon is ~9,150 km great-circle. Allow 2% slack.
    const d = haversineKm(sf, lisbon);
    expect(d).toBeGreaterThan(8900);
    expect(d).toBeLessThan(9400);
  });

  it("returns zero distance for the same point", () => {
    const p = { lat: 38.6108, lng: -122.87007 };
    expect(haversineKm(p, p)).toBeCloseTo(0, 6);
  });

  it("handles antimeridian pairs without blowing up", () => {
    // Just west and just east of the date line — physically close.
    const a = { lat: 0, lng: 179.9 };
    const b = { lat: 0, lng: -179.9 };
    expect(haversineKm(a, b)).toBeLessThan(30);
  });

  it("scores a bullseye at the maximum and decays with distance", () => {
    expect(scoreFor(0)).toBe(5000);
    expect(scoreFor(100)).toBeLessThan(5000);
    expect(scoreFor(2000)).toBeLessThan(scoreFor(750));
    expect(scoreFor(20000)).toBeLessThanOrEqual(5);
    // Monotonic: further is never worth more.
    for (let km = 0; km < 15000; km += 500) {
      expect(scoreFor(km + 500)).toBeLessThanOrEqual(scoreFor(km));
    }
  });

  it("deals the requested number of unique rounds", () => {
    for (let i = 0; i < 40; i++) {
      const deal = dealRounds(ROUNDS_PER_GAME);
      expect(deal).toHaveLength(ROUNDS_PER_GAME);
      expect(new Set(deal.map((p) => p.id)).size).toBe(ROUNDS_PER_GAME);
    }
  });

  it("always includes at least one studio hub", () => {
    for (let i = 0; i < 60; i++) {
      expect(dealRounds(ROUNDS_PER_GAME).some((p) => p.tier === "hub")).toBe(true);
    }
  });

  it("has valid coordinates and camera framing for every place", () => {
    for (const p of PLACES) {
      expect(p.lat).toBeGreaterThanOrEqual(-90);
      expect(p.lat).toBeLessThanOrEqual(90);
      expect(p.lng).toBeGreaterThanOrEqual(-180);
      expect(p.lng).toBeLessThanOrEqual(180);
      expect(p.pitch).toBeGreaterThanOrEqual(0);
      expect(p.pitch).toBeLessThanOrEqual(85); // mapbox hard limit
      expect(p.zoom).toBeGreaterThan(10);
      expect(p.name.trim()).not.toBe("");
      expect(p.blurb.trim()).not.toBe("");
    }
  });

  it("has no duplicate place ids", () => {
    expect(new Set(PLACES.map((p) => p.id)).size).toBe(PLACES.length);
  });

  it("has enough places to deal a game without repeats", () => {
    expect(PLACES.length).toBeGreaterThanOrEqual(ROUNDS_PER_GAME * 3);
  });
});
