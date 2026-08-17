/**
 * The soundtrack, checked without listening to it.
 *
 * Two things are being tested and they are different in kind.
 *
 * The **curves** are pure functions and they are where the feel lives: how the
 * wind comes up with speed, how the city falls away with height, how a run of
 * coins climbs. Those are ordinary maths and ordinary assertions.
 *
 * The **lifecycle** is the part that can break the rest of the site. Chrome
 * caps live `AudioContext`s per page at a handful, so a world that fails to
 * close one leaves the *next* world the visitor opens with no sound and no
 * explanation — the same failure as leaking a WebGL context, and harder to spot
 * because silence looks like a design decision. The three rules are: nothing is
 * created before a gesture, everything one-shot is stopped, and `dispose()`
 * closes the context rather than merely dropping the reference. A fake context
 * is enough to hold all three, because all three are about which calls this
 * file makes and when.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CityAudio,
  cityGain,
  coinSemitone,
  jetGain,
  strideSeconds,
  windGain,
} from "@/frisco/audio";

describe("Vibe Francisco — how the mix moves", () => {
  it("brings the wind up with speed and keeps it bounded", () => {
    expect(windGain(0, 0)).toBe(0);
    expect(windGain(12, 0)).toBeGreaterThan(0);
    expect(windGain(34, 0)).toBeGreaterThan(windGain(12, 0));
    // Bounded, always: a gain over 1 on a summed bus is distortion.
    for (const s of [0, 5, 20, 60, 400]) {
      for (const a of [0, 50, 400, 9000]) {
        const g = windGain(s, a);
        expect(g).toBeGreaterThanOrEqual(0);
        expect(g).toBeLessThanOrEqual(0.4);
      }
    }
  });

  it("gives you weather at the top of a tower even when you are still", () => {
    // Hanging motionless at 300 m should not be silent — that reads as a menu
    // screen rather than as a place with air in it.
    expect(windGain(0, 300)).toBeGreaterThan(0.05);
  });

  it("leaves the city behind as you climb", () => {
    expect(cityGain(0)).toBeGreaterThan(cityGain(60));
    expect(cityGain(60)).toBeGreaterThan(cityGain(120));
    expect(cityGain(200)).toBe(0);
  });

  it("only burns when there is fuel", () => {
    expect(jetGain(false, 1)).toBe(0);
    expect(jetGain(true, 0)).toBe(0);
    expect(jetGain(true, 1)).toBeGreaterThan(0);
    // Thinner as the tank empties, which is a fuel gauge you can hear.
    expect(jetGain(true, 0.05)).toBeLessThan(jetGain(true, 1));
  });

  it("takes shorter strides the faster you run, and none standing still", () => {
    expect(strideSeconds(0)).toBe(Infinity);
    expect(strideSeconds(9)).toBeLessThan(strideSeconds(3));
    expect(strideSeconds(60)).toBeGreaterThan(0.2);
  });

  it("plays a phrase over a run of coins rather than a siren", () => {
    const run = Array.from({ length: 8 }, (_, i) => coinSemitone(i));
    // Monotonically up over the phrase...
    for (let i = 1; i < run.length; i++) expect(run[i]).toBeGreaterThan(run[i - 1]);
    // ...and back to the root, so it never climbs out of hearing.
    expect(coinSemitone(8)).toBe(coinSemitone(0));
  });
});

/* ------------------------------------------------------------------ *
 * The lifecycle
 * ------------------------------------------------------------------ */

interface FakeNode {
  connect: (n: unknown) => unknown;
  disconnect: () => void;
}

let created = 0;
let closed = 0;
let started = 0;
let stopped = 0;

function param() {
  return {
    value: 0,
    setValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
}

function node(extra: Record<string, unknown> = {}): FakeNode {
  const n: FakeNode = {
    connect: (x: unknown) => x,
    disconnect: () => undefined,
    ...extra,
  } as FakeNode;
  return n;
}

class FakeContext {
  state = "running";
  currentTime = 0;
  sampleRate = 48000;
  destination = node();
  constructor() {
    created++;
  }
  createGain() {
    return node({ gain: param() });
  }
  createBiquadFilter() {
    return node({ type: "lowpass", frequency: param(), Q: param() });
  }
  createOscillator() {
    return node({
      type: "sine",
      frequency: param(),
      start: () => started++,
      stop: () => stopped++,
    });
  }
  createBufferSource() {
    return node({
      buffer: null,
      loop: false,
      start: () => started++,
      stop: () => stopped++,
    });
  }
  createBuffer(_ch: number, len: number) {
    return { getChannelData: () => new Float32Array(len) };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    closed++;
    this.state = "closed";
    return Promise.resolve();
  }
}

describe("Vibe Francisco — the audio context is borrowed, not kept", () => {
  beforeEach(() => {
    created = closed = started = stopped = 0;
    localStorage.clear();
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
  });
  afterEach(() => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  it("creates nothing until the first gesture", () => {
    const a = new CityAudio();
    expect(created).toBe(0);
    // And calls before `start()` are silent no-ops rather than crashes: the
    // engine loop runs from the first frame, long before anybody clicks.
    a.update(0.016, {
      speed: 10, altitude: 5, grounded: true, burning: false, fuel: 1, inWater: false,
    });
    a.cue("coin");
    expect(created).toBe(0);
    a.dispose();
  });

  it("builds the graph once, however many gestures arrive", () => {
    const a = new CityAudio();
    a.start();
    a.start();
    a.start();
    expect(created).toBe(1);
    expect(started).toBeGreaterThan(3);
    a.dispose();
  });

  it("closes the context on dispose", () => {
    const a = new CityAudio();
    a.start();
    a.dispose();
    expect(closed).toBe(1);
  });

  it("does not accumulate contexts across a mount/unmount cycle", () => {
    // The actual failure this guards: open ten worlds in a session and the
    // eleventh has no sound.
    for (let i = 0; i < 10; i++) {
      const a = new CityAudio();
      a.start();
      a.dispose();
    }
    expect(created).toBe(10);
    expect(closed).toBe(10);
  });

  it("stops every one-shot it starts", () => {
    const a = new CityAudio();
    a.start();
    const afterGraph = started - stopped;
    for (const cue of ["coin", "landmark", "ring", "finish", "jump", "land"] as const) {
      a.cue(cue);
    }
    // Each one-shot schedules its own stop. What is left running is exactly the
    // handful of permanent voices the graph started with.
    expect(started - stopped).toBe(afterGraph);
    a.dispose();
  });

  it("remembers being muted", () => {
    const a = new CityAudio();
    a.start();
    a.setMuted(true);
    a.dispose();
    expect(new CityAudio().isMuted).toBe(true);
  });

  it("survives a browser with no Web Audio at all", () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    const a = new CityAudio();
    expect(() => {
      a.start();
      a.update(0.016, {
        speed: 4, altitude: 0, grounded: true, burning: true, fuel: 0.5, inWater: false,
      });
      a.cue("coin");
      a.setMuted(true);
      a.dispose();
    }).not.toThrow();
  });
});
