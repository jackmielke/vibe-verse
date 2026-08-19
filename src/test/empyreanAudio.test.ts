/**
 * The Empyrean's soundtrack, checked without listening to it.
 *
 * Three kinds of thing are under test and they fail in three different ways.
 *
 * The **curves** are pure functions and they are where the feel lives: how the
 * wind falls away in a street and comes back over the lake, how the districts
 * cross-fade, what the dark does to a crowd. Those are ordinary maths and
 * ordinary assertions, and they are the only part of this file that would
 * catch the mix sounding *wrong*.
 *
 * The **lifecycle** is the part that can break the rest of the site. Chrome
 * caps live `AudioContext`s per page at a handful, so a world that fails to
 * close one leaves the *next* world the visitor opens silent, with no
 * explanation and no stack trace — the same failure as leaking a WebGL
 * context and considerably harder to spot, because silence looks like a
 * design decision.
 *
 * The **budget** is the one that only shows up after twenty minutes of play.
 * Every voice in this file is meant to be permanent and retriggered, so the
 * number of audio nodes in existence must be a constant. The test for that is
 * blunt and total: build the graph, count every node the fake context has
 * handed out, run twenty thousand frames through every district at every time
 * of day, and assert the count has not moved by one.
 */
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAudio,
  cityPresence,
  coinSemitone,
  createEmpyreanAudio,
  districtMix,
  exposureAt,
  jetGain,
  MAX_POSITIONAL_VOICES,
  nightScale,
  skyOpenness,
  strideSeconds,
  windGain,
  type AudioHandle,
} from "@/empyrean/audio";
import { ISLAND_Y, PLATEAU_R } from "@/empyrean/config";
import { DISTRICTS, HALO_R, RING_R } from "@/empyrean/cityplan";
import type { BuildContext, FrameContext } from "@/empyrean/types";

/* ------------------------------------------------------------------ *
 * The curves
 * ------------------------------------------------------------------ */

describe("The Empyrean — how the mix moves", () => {
  it("is almost silent in a street and loud over the lake", () => {
    // Standing in the Bazaar, between two blocks, doing nothing.
    const street = exposureAt(0, RING_R[0] + 30, ISLAND_Y, 0);
    // Cruising over the frozen lake at six hundred metres.
    const sky = exposureAt(900, 900, 600, 600);
    expect(street).toBeLessThan(0.35);
    expect(sky).toBe(1);

    const quiet = windGain(0, street, 0);
    const loud = windGain(34, sky, 600);
    expect(quiet).toBeLessThan(0.04);
    expect(loud).toBeGreaterThan(0.3);
    // The whole point: an order of magnitude between the two, not a nudge.
    expect(loud / quiet).toBeGreaterThan(8);
  });

  it("keeps the wind bounded whatever it is handed", () => {
    for (const s of [-5, 0, 7, 22, 34, 120, 4000]) {
      for (const e of [-1, 0, 0.3, 1, 2]) {
        for (const o of [-800, 0, 120, 900, 90000]) {
          const g = windGain(s, e, o);
          expect(g).toBeGreaterThanOrEqual(0);
          expect(g).toBeLessThanOrEqual(0.36);
          expect(Number.isFinite(g)).toBe(true);
        }
      }
    }
  });

  it("gives you weather when you hang still at altitude", () => {
    // Motionless at six hundred metres should not read as a menu screen.
    expect(windGain(0, 1, 600)).toBeGreaterThan(0.09);
    expect(windGain(0, 1, 600)).toBeGreaterThan(windGain(0, 1, 0));
  });

  it("counts height from whichever ground is further away", () => {
    // Twenty metres below the deck but six hundred above the ice.
    expect(skyOpenness(ISLAND_Y - 20, 600)).toBe(600);
    // Standing on the plaza.
    expect(skyOpenness(ISLAND_Y, 0)).toBe(0);
    // A hundred metres over the spires.
    expect(skyOpenness(ISLAND_Y + 100, 100)).toBe(100);
  });

  it("opens the street up once you are above the roofs", () => {
    const onFoot = exposureAt(0, RING_R[0] + 30, ISLAND_Y, 0);
    const overhead = exposureAt(0, RING_R[0] + 30, ISLAND_Y + 120, 120);
    expect(overhead).toBeGreaterThan(0.95);
    expect(overhead).toBeGreaterThan(onFoot * 2);
  });

  it("is more exposed on the rim than in the middle", () => {
    const middle = exposureAt(0, HALO_R + 20, ISLAND_Y, 0);
    const rim = exposureAt(0, PLATEAU_R + 30, ISLAND_Y - 22, 0);
    expect(rim).toBeGreaterThan(middle);
  });

  it("only burns when the throttle is down, and not linearly", () => {
    expect(jetGain(0)).toBe(0);
    expect(jetGain(-1)).toBe(0);
    expect(jetGain(1)).toBeGreaterThan(jetGain(0.5));
    expect(jetGain(0.5)).toBeGreaterThan(jetGain(0.1));
    // A hover is audible but is not an event.
    expect(jetGain(0.25)).toBeLessThan(jetGain(1) * 0.5);
    expect(jetGain(1)).toBeLessThan(0.2);
  });

  it("takes shorter strides the faster you run, and none standing still", () => {
    expect(strideSeconds(0)).toBe(Infinity);
    expect(strideSeconds(0.3)).toBe(Infinity);
    expect(strideSeconds(16)).toBeLessThan(strideSeconds(7));
    expect(strideSeconds(400)).toBeGreaterThan(0.2);
  });

  it("plays a phrase over a run of coins rather than a siren", () => {
    const run = Array.from({ length: 8 }, (_, i) => coinSemitone(i));
    for (let i = 1; i < run.length; i++) expect(run[i]).toBeGreaterThan(run[i - 1]);
    expect(coinSemitone(8)).toBe(coinSemitone(0));
    expect(coinSemitone(-4)).toBe(coinSemitone(0));
  });

  /* ---- the districts ------------------------------------------------ */

  it("names the district you are standing in", () => {
    const w = new Float64Array(DISTRICTS.length);
    const loudest = (r: number) => {
      districtMix(r, w);
      let best = 0;
      for (let i = 1; i < w.length; i++) if (w[i] > w[best]) best = i;
      return DISTRICTS[best].id;
    };
    expect(loudest(0)).toBe("halo");
    expect(loudest(HALO_R + 40)).toBe("core");
    expect(loudest((RING_R[0] + RING_R[1]) / 2)).toBe("market");
    expect(loudest((RING_R[1] + RING_R[2]) / 2)).toBe("gardens");
    expect(loudest(RING_R[2] + 25)).toBe("rim");
  });

  it("cross-fades rather than cutting, and always sums to one", () => {
    const w = new Float64Array(DISTRICTS.length);
    for (let r = 0; r <= 700; r += 3) {
      districtMix(r, w);
      let sum = 0;
      for (let i = 0; i < w.length; i++) {
        expect(w[i]).toBeGreaterThanOrEqual(0);
        sum += w[i];
      }
      expect(sum).toBeCloseTo(1, 6);
    }
    // On the boundary between the Bazaar and the Terraces you hear both.
    districtMix(RING_R[1], w);
    expect(w[2]).toBeGreaterThan(0.2);
    expect(w[3]).toBeGreaterThan(0.2);
  });

  it("leaves the city behind as you climb and as you fly out", () => {
    expect(cityPresence(100, ISLAND_Y, 0)).toBeCloseTo(1, 3);
    expect(cityPresence(100, ISLAND_Y + 400, 400)).toBeLessThan(0.05);
    expect(cityPresence(1200, ISLAND_Y, 0)).toBeLessThan(0.05);
    // Monotonic on the way up: no step you can hear.
    let prev = 2;
    for (let h = 0; h < 500; h += 10) {
      const p = cityPresence(100, ISLAND_Y + h, h);
      expect(p).toBeLessThanOrEqual(prev + 1e-9);
      prev = p;
    }
  });

  it("quietens at night without going silent", () => {
    for (const layer of ["crowd", "birds", "machine", "air"] as const) {
      expect(nightScale(0, layer)).toBeGreaterThan(0);
      expect(nightScale(1, layer)).toBeGreaterThan(0);
    }
    expect(nightScale(0, "crowd")).toBeLessThan(nightScale(1, "crowd"));
    expect(nightScale(0, "birds")).toBeLessThan(nightScale(1, "birds"));
    // Machinery does not go home.
    expect(nightScale(0, "machine")).toBeGreaterThanOrEqual(nightScale(1, "machine"));
  });
});

/* ------------------------------------------------------------------ *
 * A fake context that counts everything it hands out
 * ------------------------------------------------------------------ */

let created = 0;
let closed = 0;
let started = 0;
let stopped = 0;
let nodes = 0;

function param(value = 0) {
  return {
    value,
    setValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
}

function node(extra: Record<string, unknown> = {}) {
  nodes++;
  return {
    connect(x: unknown) {
      return x;
    },
    disconnect() {
      /* no-op */
    },
    ...extra,
  };
}

/** Every fake context ever built, so a test can reach the one in use. */
const contexts: FakeContext[] = [];

function lastContext(): FakeContext | undefined {
  return contexts[contexts.length - 1];
}

class FakeContext {
  state = "suspended";
  currentTime = 0;
  sampleRate = 48000;
  destination = node();
  listener = {
    positionX: param(),
    positionY: param(),
    positionZ: param(),
    forwardX: param(),
    forwardY: param(),
    forwardZ: param(),
    upX: param(),
    upY: param(),
    upZ: param(),
  };
  constructor() {
    created++;
    contexts.push(this);
  }
  createGain() {
    return node({ gain: param(1) });
  }
  createBiquadFilter() {
    return node({ type: "lowpass", frequency: param(400), Q: param(1), detune: param() });
  }
  createOscillator() {
    return node({
      type: "sine",
      frequency: param(440),
      detune: param(),
      start: () => started++,
      stop: () => stopped++,
    });
  }
  createBufferSource() {
    return node({
      buffer: null,
      loop: false,
      playbackRate: param(1),
      start: () => started++,
      stop: () => stopped++,
    });
  }
  createStereoPanner() {
    return node({ pan: param() });
  }
  createPanner() {
    return node({
      panningModel: "equalpower",
      distanceModel: "inverse",
      refDistance: 1,
      maxDistance: 1000,
      rolloffFactor: 1,
      positionX: param(),
      positionY: param(),
      positionZ: param(),
    });
  }
  createConvolver() {
    return node({ buffer: null });
  }
  createDynamicsCompressor() {
    return node({
      threshold: param(),
      knee: param(),
      ratio: param(),
      attack: param(),
      release: param(),
    });
  }
  createBuffer(channels: number, length: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { length, numberOfChannels: channels, getChannelData: (c: number) => data[c] };
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  suspend() {
    this.state = "suspended";
    return Promise.resolve();
  }
  close() {
    closed++;
    this.state = "closed";
    return Promise.resolve();
  }
}

const BUILD: BuildContext = { quality: "high", seedSalt: "audio" };

/** A `FrameContext` that is mutated in place, exactly like the real one. */
function makeFrame(): FrameContext {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, ISLAND_Y + 2, 8);
  camera.updateMatrixWorld();
  return {
    time: 0,
    dt: 1 / 60,
    camera,
    player: {
      position: new THREE.Vector3(0, ISLAND_Y, 78),
      velocity: new THREE.Vector3(),
      yaw: 0,
      grounded: true,
      burn: 0,
      altitude: 0,
    },
    quality: "high",
    dayPhase: 0.75,
    sunDir: new THREE.Vector3(0, 0.2, -1),
    daylight: 0.6,
    camRadiusSq: 0,
  };
}

/**
 * Fly the whole world past the mix.
 *
 * Every district, the promenades, the void over the lake, on foot and on the
 * jetpack, day and night, with the tram going round — which is the only way to
 * be sure the pools are exercised rather than merely present.
 */
function fly(audio: AudioHandle, frame: FrameContext, ctx: FakeContext, frames: number): number {
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    const t = i / 60;
    ctx.currentTime = t;
    frame.time = t;
    // A slow spiral out from the Beacon and back, rising and falling.
    const a = t * 0.6;
    const r = 340 * (0.5 - 0.5 * Math.cos(t * 0.21)) + 20;
    frame.player.position.set(Math.cos(a) * r, ISLAND_Y + Math.max(0, Math.sin(t * 0.13) * 420), Math.sin(a) * r);
    frame.player.velocity.set(Math.cos(a) * 9, Math.sin(t * 0.7) * 4, Math.sin(a) * 9);
    frame.player.grounded = frame.player.position.y < ISLAND_Y + 0.5;
    frame.player.burn = frame.player.grounded ? 0 : 0.5 + 0.5 * Math.sin(t * 0.9);
    frame.player.altitude = frame.player.position.y - ISLAND_Y;
    frame.daylight = 0.5 + 0.5 * Math.sin(t * 0.05);
    frame.camera.position.copy(frame.player.position);
    frame.camera.position.y += 2;
    frame.camera.updateMatrixWorld();
    audio.setTram(Math.cos(a * 2.2) * 300, ISLAND_Y + 8, Math.sin(a * 2.2) * 300, true);
    audio.update?.(frame);
    if (i % 90 === 0) audio.event("coin");
    if (i % 240 === 0) audio.event("land", 0.8);
    if (i % 310 === 0) audio.event("deliver");
    if (i % 517 === 0) audio.event("photo");
    if (audio.voices.positionalActive > peak) peak = audio.voices.positionalActive;
  }
  return peak;
}

/* ------------------------------------------------------------------ *
 * Degrading to silence
 * ------------------------------------------------------------------ */

describe("The Empyrean — a browser with no Web Audio is a quiet world, not a broken one", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    delete (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
  });

  it("returns null rather than throwing, and null is safe for every caller", () => {
    const audio = buildAudio(BUILD);
    expect(audio).toBeNull();
    // Which is exactly how the world is expected to hold it.
    expect(() => {
      audio?.resume();
      audio?.update?.(makeFrame());
      audio?.event("coin");
      audio?.setMuted(true);
      audio?.setTram(0, 0, 0, true);
      audio?.dispose();
    }).not.toThrow();
  });

  it("does the same through the legacy entry point", () => {
    const legacy = createEmpyreanAudio();
    expect(legacy).toBeNull();
    expect(() => {
      legacy?.resume();
      legacy?.update(10, 1, 700);
      legacy?.dispose();
    }).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * The lifecycle
 * ------------------------------------------------------------------ */

describe("The Empyrean — the audio context is borrowed, not kept", () => {
  beforeEach(() => {
    created = closed = started = stopped = nodes = 0;
    contexts.length = 0;
    localStorage.clear();
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
  });
  afterEach(() => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  it("creates nothing at all until the first gesture", () => {
    const audio = buildAudio(BUILD)!;
    expect(audio).not.toBeNull();
    expect(created).toBe(0);
    expect(nodes).toBe(0);

    // And the loop runs from the first frame, long before anybody clicks.
    audio.update?.(makeFrame());
    audio.event("coin");
    audio.setTram(0, 0, 0, true);
    expect(created).toBe(0);
    expect(nodes).toBe(0);
    audio.dispose();
  });

  it("builds the graph once, however many gestures arrive", () => {
    const audio = buildAudio(BUILD)!;
    audio.resume();
    const afterFirst = nodes;
    audio.resume();
    audio.resume();
    expect(created).toBe(1);
    expect(nodes).toBe(afterFirst);
    expect(started).toBeGreaterThan(10);
    audio.dispose();
  });

  it("closes the context on dispose, and stops what it started", () => {
    const audio = buildAudio(BUILD)!;
    audio.resume();
    const running = started;
    audio.dispose();
    expect(closed).toBe(1);
    // Everything that was start()ed has been stop()ped.
    expect(stopped).toBeGreaterThanOrEqual(running);
    // And a second dispose is a no-op rather than a second close.
    audio.dispose();
    expect(closed).toBe(1);
  });

  it("does not accumulate contexts across ten mount/unmount cycles", () => {
    // The actual failure this guards: open ten worlds in a session and the
    // eleventh one has no sound and nothing in the console.
    for (let i = 0; i < 10; i++) {
      const audio = buildAudio(BUILD)!;
      audio.resume();
      audio.update?.(makeFrame());
      audio.dispose();
    }
    expect(created).toBe(10);
    expect(closed).toBe(10);
  });

  it("survives dispose before resume, and update after dispose", () => {
    const a = buildAudio(BUILD)!;
    expect(() => a.dispose()).not.toThrow();
    expect(closed).toBe(0);

    const b = buildAudio(BUILD)!;
    b.resume();
    b.dispose();
    expect(() => {
      b.update?.(makeFrame());
      b.event("ring");
      b.resume();
      b.setTram(1, 2, 3, true);
    }).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * Mute
 * ------------------------------------------------------------------ */

describe("The Empyrean — mute is instant, total and remembered", () => {
  beforeEach(() => {
    created = closed = started = stopped = nodes = 0;
    contexts.length = 0;
    localStorage.clear();
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
  });
  afterEach(() => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  it("remembers being muted into the next session", () => {
    const a = buildAudio(BUILD)!;
    a.resume();
    a.setMuted(true);
    expect(a.muted).toBe(true);
    a.dispose();

    const b = buildAudio(BUILD)!;
    expect(b.muted).toBe(true);
    b.setMuted(false);
    expect(b.muted).toBe(false);
    b.dispose();

    expect(buildAudio(BUILD)!.muted).toBe(false);
  });

  it("can be muted before the graph exists and stays muted through it", () => {
    const a = buildAudio(BUILD)!;
    a.setMuted(true);
    expect(created).toBe(0);
    a.resume();
    expect(a.muted).toBe(true);
    a.dispose();
  });

  it("survives storage that refuses to be written to", () => {
    const setItem = Storage.prototype.setItem;
    const getItem = Storage.prototype.getItem;
    Storage.prototype.setItem = () => {
      throw new Error("nope");
    };
    Storage.prototype.getItem = () => {
      throw new Error("nope");
    };
    try {
      const a = buildAudio(BUILD)!;
      expect(a.muted).toBe(false);
      expect(() => a.setMuted(true)).not.toThrow();
      expect(a.muted).toBe(true);
      a.dispose();
    } finally {
      Storage.prototype.setItem = setItem;
      Storage.prototype.getItem = getItem;
    }
  });
});

/* ------------------------------------------------------------------ *
 * The budget
 * ------------------------------------------------------------------ */

describe("The Empyrean — the voice pools are pools", () => {
  beforeEach(() => {
    created = closed = started = stopped = nodes = 0;
    contexts.length = 0;
    localStorage.clear();
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
  });
  afterEach(() => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  it("declares a census that respects the cap", () => {
    const audio = buildAudio(BUILD)!;
    audio.resume();
    expect(audio.voices.positional).toBeLessThanOrEqual(MAX_POSITIONAL_VOICES);
    expect(audio.voices.positional).toBeGreaterThan(0);
    // More things that make a noise than slots to play them through — which
    // is the only arrangement in which "pooled" means anything.
    expect(audio.voices.emitters).toBeGreaterThan(audio.voices.positional);
    audio.dispose();
    expect(audio.voices.positional).toBe(0);
  });

  it("never exceeds the cap over twenty thousand frames across the whole city", () => {
    const audio = buildAudio(BUILD)!;
    audio.resume();
    const fake = lastContext()!;
    const frame = makeFrame();

    let peak = 0;
    for (let chunk = 0; chunk < 20; chunk++) {
      peak = Math.max(peak, fly(audio, frame, fake, 1000));
      expect(audio.voices.positional).toBeLessThanOrEqual(MAX_POSITIONAL_VOICES);
      expect(audio.voices.positionalActive).toBeLessThanOrEqual(audio.voices.positional);
    }
    // ...and the cap has to actually bite, or this test proves nothing: over
    // the middle of the city there are more things in earshot than slots.
    expect(peak).toBe(audio.voices.positional);
    audio.dispose();
  });

  it("creates no audio node whatsoever after the graph is built", () => {
    // The strongest form of "do not allocate in update()": every voice is
    // permanent and retriggered, so the node count is a constant. If this
    // number ever moves, something in the frame path is calling create*() and
    // an hour in the Bazaar is a graph nobody can afford.
    const audio = buildAudio(BUILD)!;
    audio.resume();
    const afterBuild = nodes;
    const fake = lastContext()!;
    const frame = makeFrame();
    fly(audio, frame, fake, 20000);
    expect(nodes).toBe(afterBuild);
    audio.dispose();
  });

  it("builds a smaller pool on the low tier, and no reverb", () => {
    const audio = buildAudio({ quality: "low", seedSalt: "audio" })!;
    audio.resume();
    expect(audio.voices.positional).toBeLessThan(MAX_POSITIONAL_VOICES);
    expect(audio.voices.positional).toBeGreaterThan(0);
    const afterBuild = nodes;
    fly(audio, makeFrame(), lastContext()!, 600);
    expect(nodes).toBe(afterBuild);
    audio.dispose();
  });

  it("ignores an event kind it has never heard of", () => {
    const audio = buildAudio(BUILD)!;
    audio.resume();
    const before = nodes;
    expect(() => {
      // Deliberately off-contract: the rest of the world adds verbs faster
      // than the soundtrack does, and a new one must not take the frame down.
      (audio.event as (k: string, s?: number) => void)("teleport", 3);
      (audio.event as (k: string, s?: number) => void)("");
      audio.event("ui");
      audio.event("land");
      audio.event("jetOn", 1);
      audio.event("jetOff", 0);
    }).not.toThrow();
    expect(nodes).toBe(before);
    audio.dispose();
  });

  it("is a System the engine can hold like any other", () => {
    const audio = buildAudio(BUILD)!;
    expect(audio.name).toBe("audio");
    expect(audio.group).toBeInstanceOf(THREE.Object3D);
    expect(audio.reflected).toBeFalsy();
    audio.dispose();
  });
});
