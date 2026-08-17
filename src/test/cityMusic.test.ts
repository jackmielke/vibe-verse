/**
 * The dance track, tested where a waveform cannot help.
 *
 * `scripts/music-check.mjs` renders the real graph and draws it, which is how
 * "does it sound like anything" and "is the kick on the beat" get answered —
 * no assertion is going to do that. What it cannot answer is anything about
 * the *contract* between the parts, and that is where this feature can break
 * quietly:
 *
 *   1. an event missing the field its voice dereferences (`e.freq!`) is a
 *      runtime crash inside an audio callback, which surfaces as silence and
 *      a console line nobody is looking at;
 *   2. the HUD tells the player how many more dancers unlock the next layer
 *      while the mixer decides what actually comes in — two copies of one
 *      number, and a caption that lies is worse than no caption;
 *   3. a crowd getting bigger must never take a layer away.
 */
import { describe, expect, it } from "vitest";

import {
  MUSIC_PATTERN_STEPS,
  MUSIC_STEPS_PER_BEAT,
  mixerLevels,
  musicLayerCount,
  nextLayerAt,
  stepEvents,
  type MusicBus,
  type StepEvent,
} from "@/lib/cityMusic";

const BARS = MUSIC_PATTERN_STEPS / (4 * MUSIC_STEPS_PER_BEAT);
const allSteps = () => Array.from({ length: MUSIC_PATTERN_STEPS }, (_, i) => stepEvents(i));
const isDownbeat = (step: number) => step % MUSIC_STEPS_PER_BEAT === 0;
const beatInBar = (step: number) =>
  Math.floor((step % (4 * MUSIC_STEPS_PER_BEAT)) / MUSIC_STEPS_PER_BEAT);

describe("cityMusic arrangement", () => {
  it("is four bars of 4/4 on a sixteenth grid", () => {
    expect(MUSIC_STEPS_PER_BEAT).toBe(4);
    expect(BARS).toBe(4);
    // Pure, and periodic: the scheduler jumps straight to whatever step the
    // wall clock says it is, so step N and step N + one loop must agree.
    for (let i = 0; i < MUSIC_PATTERN_STEPS; i++) {
      expect(stepEvents(i)).toEqual(stepEvents(i + MUSIC_PATTERN_STEPS));
    }
  });

  it("puts a kick on every beat and nowhere else", () => {
    // Four-on-the-floor is the one thing a dancer locks to. A missing kick is
    // not a taste question.
    allSteps().forEach((events, step) => {
      const kicks = events.filter((e) => e.voice === "kick");
      expect(kicks.length, `step ${step}`).toBe(isDownbeat(step) ? 1 : 0);
    });
  });

  it("claps on two and four", () => {
    allSteps().forEach((events, step) => {
      const clapped = events.some((e) => e.voice === "clap");
      const want = isDownbeat(step) && (beatInBar(step) === 1 || beatInBar(step) === 3);
      expect(clapped, `step ${step}`).toBe(want);
    });
  });

  it("changes chord once a bar and comes back round", () => {
    const pads = allSteps().flatMap((events, step) =>
      events.filter((e) => e.voice === "pad").map((e) => ({ step, tones: e.tones! })),
    );
    expect(pads).toHaveLength(BARS);
    for (const p of pads) expect(p.step % (4 * MUSIC_STEPS_PER_BEAT)).toBe(0);
    // Four distinct chords, or the "progression" is one chord repeated.
    const distinct = new Set(pads.map((p) => p.tones.join(",")));
    expect(distinct.size).toBe(BARS);
  });

  it("gives every event the fields its voice reads", () => {
    // `playStep` dereferences these with `!`. A missing one throws inside the
    // scheduler, and a scheduler that throws is a track that stops.
    const needs: Record<StepEvent["voice"], (keyof StepEvent)[]> = {
      kick: [],
      clap: [],
      hat: [],
      openhat: [],
      bass: ["freq", "dur"],
      pad: ["tones"],
      pluck: ["freq", "dur", "level"],
    };
    for (const events of allSteps()) {
      for (const e of events) {
        for (const field of needs[e.voice]) {
          expect(e[field], `${e.voice}.${String(field)}`).toBeDefined();
        }
        if (e.freq !== undefined) expect(e.freq).toBeGreaterThan(20);
        if (e.dur !== undefined) expect(e.dur).toBeGreaterThan(0);
      }
    }
  });

  it("routes each voice to the bus that gates it", () => {
    // A hat on the drums bus would play for a lone dancer, and the layer
    // mechanic would silently stop being a mechanic.
    const expected: Record<StepEvent["voice"], MusicBus[]> = {
      kick: ["drums"],
      clap: ["drums"],
      hat: ["hats"],
      openhat: ["hats"],
      bass: ["bass"],
      pad: ["pad"],
      pluck: ["lead", "stabs"],
    };
    for (const events of allSteps()) {
      for (const e of events) expect(expected[e.voice]).toContain(e.bus);
    }
  });

  it("keeps something playing on every sixteenth of the loop", () => {
    for (let i = 0; i < MUSIC_PATTERN_STEPS; i++) {
      expect(stepEvents(i).length, `step ${i} is empty`).toBeGreaterThan(0);
    }
  });
});

describe("cityMusic mixer", () => {
  const BUSES: MusicBus[] = ["drums", "bass", "pad", "hats", "lead", "stabs"];

  it("is silent with nobody dancing", () => {
    const mix = mixerLevels(0);
    expect(mix.master).toBe(0);
    for (const b of BUSES) expect(mix[b]).toBe(0);
    // Negative or fractional headcounts are a caller bug, not a crash.
    expect(mixerLevels(-3).master).toBe(0);
    expect(musicLayerCount(0)).toBe(0);
  });

  it("never takes a layer away as the crowd grows", () => {
    for (let n = 1; n < 20; n++) {
      const prev = mixerLevels(n - 1);
      const cur = mixerLevels(n);
      for (const b of BUSES) {
        expect(cur[b], `bus ${b} at ${n}`).toBeGreaterThanOrEqual(prev[b]);
      }
      expect(musicLayerCount(n)).toBeGreaterThanOrEqual(musicLayerCount(n - 1));
    }
  });

  it("agrees with the readout about when the next layer lands", () => {
    // The HUD promises "N more for the next layer". This is the assertion that
    // the promise is kept — the caption and the mixer read the same thresholds
    // or the player is being told something untrue about what they can hear.
    for (let n = 0; n < 12; n++) {
      const at = nextLayerAt(n);
      if (at === null) {
        expect(musicLayerCount(n)).toBe(4);
        continue;
      }
      expect(at).toBeGreaterThan(n);
      // At the promised headcount, and not before it, the count goes up.
      expect(musicLayerCount(at)).toBeGreaterThan(musicLayerCount(n));
      expect(musicLayerCount(at - 1)).toBe(musicLayerCount(n));
    }
  });

  it("tops out at four layers and stays there", () => {
    expect(musicLayerCount(5)).toBe(4);
    expect(musicLayerCount(50)).toBe(4);
    expect(nextLayerAt(5)).toBeNull();
    const mix = mixerLevels(50);
    for (const b of BUSES) expect(mix[b]).toBe(1);
  });
});
