/**
 * THE BASEMENT, tested where a photograph runs out.
 *
 * `scripts/club-shot.mjs` is how the room gets judged — whether it reads as a
 * place is not a thing an assertion can answer, and every fix so far came from
 * looking at a frame. What a frame is bad at is the arithmetic underneath the
 * crowd, and two properties there are worth holding forever:
 *
 *   1. nobody stands inside anybody else. Two dancers occupying one square
 *      metre is the single most immersion-breaking thing a room can do, it is
 *      easy to reintroduce by changing one radius, and from most camera angles
 *      you cannot see it.
 *   2. the room reaches the music's top layer on its own. That is the whole
 *      argument for building a venue rather than another patch of plaza.
 */
import { describe, expect, it } from "vitest";

import { crewHasJoined, ringSpots } from "@/components/city/danceCrowd";
import { musicLayerCount, nextLayerAt } from "@/lib/cityMusic";

/** The club's own call, so this tests the room rather than a hypothetical. */
const clubSpots = () => {
  const DOOR_Z = 13 - 4;
  return ringSpots({
    count: 26,
    radius: 9.5,
    designs: ["a", "b", "c", "d"],
    stageBias: 0.55,
    minGap: 1.6,
    seed: 3,
  })
    .map((s) => ({ ...s, z: s.z + 1.5 }))
    .filter((s) => Math.hypot(s.x, s.z - DOOR_Z) > 4.5)
    .slice(0, 20);
};

describe("club crowd placement", () => {
  it("fills the room without anybody standing inside anybody", () => {
    const spots = clubSpots();
    expect(spots).toHaveLength(20);
    let closest = Infinity;
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        closest = Math.min(closest, Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z));
      }
    }
    // A person is about 0.6m across. Under a metre apart and they intersect.
    expect(closest).toBeGreaterThan(1.0);
  });

  it("leaves the doorway clear", () => {
    // Arriving used to put a dancer inside the player and another on the exit
    // pad: you walked in wearing somebody.
    for (const s of clubSpots()) {
      expect(Math.hypot(s.x, s.z - 9)).toBeGreaterThan(4.5);
    }
  });

  it("keeps everybody inside the walls", () => {
    // The room is 34 × 26 with the floor offset 1.5 toward the crowd.
    for (const s of clubSpots()) {
      expect(Math.abs(s.x)).toBeLessThan(16);
      expect(Math.abs(s.z)).toBeLessThan(12);
    }
  });

  it("is not a lattice", () => {
    /*
     * People do not stand on a grid. If every dancer shares an x or a z with
     * another one, the room reads as furniture from the first overhead glance
     * — which is exactly what the first version looked like.
     */
    const xs = new Set(clubSpots().map((s) => s.x.toFixed(2)));
    const zs = new Set(clubSpots().map((s) => s.z.toFixed(2)));
    expect(xs.size).toBe(20);
    expect(zs.size).toBe(20);
  });

  it("is the same room every visit", () => {
    expect(clubSpots()).toEqual(clubSpots());
  });
});

describe("club as a venue", () => {
  it("gets a lone visitor to the full mix on its own", () => {
    // Twenty regulars plus you. The point of a room rather than a patch of
    // plaza: you do not unlock the top of the track, you walk into it.
    expect(musicLayerCount(1 + 20)).toBe(4);
    expect(nextLayerAt(1 + 20)).toBeNull();
  });

  it("fills up over a few bars rather than all at once", () => {
    // Orders are assigned `i % 6`, so the room is full six bars after the
    // first dancer — twelve seconds at the city's tempo.
    const orders = clubSpots().map((_, i) => i % 6);
    const dancingAt = (bars: number) => orders.filter((o) => crewHasJoined(o, bars)).length;
    expect(dancingAt(0)).toBeLessThan(orders.length);
    expect(dancingAt(0)).toBeGreaterThan(0);
    expect(dancingAt(6)).toBe(orders.length);
  });
});
