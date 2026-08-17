/**
 * The dance floor, tested where a screenshot cannot help.
 *
 * `scripts/floor-shot.mjs` answers "is it in a sensible place" and "does it
 * look like a dance floor", which no assertion could. What it cannot answer is
 * the claim the floor is actually making — that the light is a function of one
 * shared clock and nothing else. Two screenshots taken a second apart look
 * different whether that is true or false.
 *
 * The other half is the crowd contract: the floor's whole reason for existing
 * is that a solo player can reach the music's top layer, and that only holds
 * if enough regulars join and they arrive spread out rather than all at once.
 */
import { describe, expect, it } from "vitest";

import { crewHasJoined, panelBrightness } from "@/components/city/danceFloor";
import { musicLayerCount, nextLayerAt } from "@/lib/cityMusic";

describe("dance floor panels", () => {
  it("depends on nothing but the beat", () => {
    // The property the whole feature rests on: same absolute beat, same light,
    // on every machine. No Date.now() inside, no per-floor phase, no drift.
    for (const beat of [0, 0.37, 12.5, 1_000_000.25]) {
      const a = panelBrightness(2, 3, 0.4, beat, 1);
      const b = panelBrightness(2, 3, 0.4, beat, 1);
      expect(a).toBe(b);
    }
    // And a whole number of bars later is the same frame again.
    expect(panelBrightness(1, 4, 0.6, 8.25, 1)).toBeCloseTo(
      panelBrightness(1, 4, 0.6, 8.25 + 4, 1),
      12,
    );
  });

  it("is brightest exactly on the beat", () => {
    // If the peak drifts into the middle of the beat the floor still looks
    // busy and stops being an instrument you can read the tempo off.
    const onBeat = panelBrightness(0, 0, 0, 4, 1);
    for (const phase of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(panelBrightness(0, 0, 0, 4 + phase, 1)).toBeLessThan(onBeat);
    }
  });

  it("flips the checkerboard every beat", () => {
    // Neighbouring panels must disagree, and each must swap on the next beat,
    // or the floor is a single slab that pulses.
    const at = (i: number, j: number, beat: number) => panelBrightness(i, j, 0.9, beat, 1);
    expect(at(0, 0, 4.5)).not.toBeCloseTo(at(0, 1, 4.5), 5);
    expect(at(0, 0, 4.5)).toBeCloseTo(at(0, 1, 5.5), 5);
  });

  it("sends a ring outward from the centre", () => {
    // Early in the beat the middle is lit; later, the rim is. Checkerboard
    // parity is held constant so only the ring can be responsible.
    const early = 4.06;
    const late = 4.62;
    const centre = (b: number) => panelBrightness(0, 0, 0.05, b, 1);
    const rim = (b: number) => panelBrightness(0, 0, 0.62, b, 1);
    expect(centre(early)).toBeGreaterThan(rim(early));
    expect(rim(late)).toBeGreaterThan(centre(late));
  });

  it("idles dim and never goes dark", () => {
    // A floor at zero is a floor nobody walks over to. A floor as bright idle
    // as it is busy is one that never rewards dancing on it.
    for (const beat of [0, 0.5, 1.25, 2.75]) {
      const idle = panelBrightness(1, 1, 0.3, beat, 0.22);
      const busy = panelBrightness(1, 1, 0.3, beat, 1);
      expect(idle).toBeGreaterThan(0);
      expect(idle).toBeLessThan(busy);
    }
  });
});

describe("dance floor crew", () => {
  it("arrives one bar at a time", () => {
    // All at once reads as a cutscene rather than as a room noticing you.
    expect(crewHasJoined(0, 0)).toBe(true);
    expect(crewHasJoined(1, 0)).toBe(false);
    expect(crewHasJoined(1, 1)).toBe(true);
    expect(crewHasJoined(3, 2)).toBe(false);
    expect(crewHasJoined(3, 3)).toBe(true);
    // And nobody leaves again while the music is still going.
    for (let order = 0; order < 4; order++) {
      expect(crewHasJoined(order, 99)).toBe(true);
    }
  });

  it("carries a lone dancer all the way to the full mix", () => {
    /*
     * The reason the floor exists. One player plus the four regulars is five,
     * which is exactly the headcount the top layer needs — so the mechanic is
     * reachable by somebody playing alone at 3am, which is when most people
     * play this. If the crew ever shrinks below four, or the threshold moves,
     * this is the test that says so rather than a player quietly never hearing
     * the top of the track.
     */
    const CREW = 4;
    expect(musicLayerCount(1 + CREW)).toBe(4);
    expect(nextLayerAt(1 + CREW)).toBeNull();
    // And the build really is gradual: each bar of the stagger is another
    // layer's worth of headcount, not a single jump from one to five.
    const at = (bars: number) =>
      1 + [0, 1, 2, 3].filter((order) => crewHasJoined(order, bars)).length;
    expect(musicLayerCount(at(0))).toBeLessThan(musicLayerCount(at(3)));
    expect(at(0)).toBe(2);
    expect(at(3)).toBe(5);
  });
});
