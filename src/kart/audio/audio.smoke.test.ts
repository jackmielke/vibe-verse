/**
 * audio.smoke.test.ts — the half of the audio system that can be tested.
 *
 * There is no AudioContext in jsdom, so the node graph cannot run here. Two
 * things can, and they are exactly the two that fail silently in a browser:
 *
 *  1. **The baked renderers.** A resonator with a bad coefficient runs away to
 *     Infinity, a filter swept past Nyquist self-oscillates, and a normalise
 *     over an all-zero buffer divides by zero. Each of those ships as either
 *     silence or a speaker-destroying click, and neither is visible in a
 *     screenshot. Every baked cue must be finite, bounded, audible — and
 *     identical when rendered twice from the same seed, because the whole game
 *     is deterministic.
 *  2. **The degradation path.** With no WebAudio at all the system must still
 *     boot, publish its service, absorb every event the race throws at it and
 *     dispose cleanly. That is the path the screenshot harness takes.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { makeKartInput, makeRng, type KartCtx, type RacerState } from "../types";
import { bakeSoundBank } from "./bank";
import { bakeKit } from "./music";
import { createGraph } from "./graph";
import { clamp, noteHz, normalize, onePole, oneHigh, percEnv, svfBand } from "./synth";
import createAudio from "./index";

const SR = 48000;

/** The only two things the bakers ask of a context. */
function stubContext(): BaseAudioContext {
  return {
    sampleRate: SR,
    createBuffer(channels: number, length: number, sampleRate: number) {
      const data = new Float32Array(length);
      return {
        length,
        duration: length / sampleRate,
        sampleRate,
        numberOfChannels: channels,
        getChannelData: () => data,
      };
    },
  } as unknown as BaseAudioContext;
}

function stats(buf: Float32Array) {
  let peak = 0;
  let energy = 0;
  let bad = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    if (!Number.isFinite(v)) bad++;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    energy += v * v;
  }
  return { peak, rms: Math.sqrt(energy / Math.max(1, buf.length)), bad };
}

describe("baked sound bank", () => {
  const bank = bakeSoundBank(stubContext(), makeRng(1234));

  for (const [id, buffer] of bank) {
    it(`${id} is finite, bounded and audible`, () => {
      const s = stats(buffer.getChannelData(0));
      expect(s.bad).toBe(0);
      expect(s.peak).toBeGreaterThan(0.05);
      expect(s.peak).toBeLessThanOrEqual(1.001);
      expect(s.rms).toBeGreaterThan(0.001);
    });

    it(`${id} starts and ends at silence`, () => {
      const d = buffer.getChannelData(0);
      expect(Math.abs(d[0])).toBeLessThan(0.02);
      expect(Math.abs(d[d.length - 1])).toBeLessThan(0.02);
    });
  }

  it("is deterministic for a given seed", () => {
    const a = bakeSoundBank(stubContext(), makeRng(99));
    const b = bakeSoundBank(stubContext(), makeRng(99));
    for (const [id, buf] of a) {
      const other = b.get(id);
      expect(other).toBeTruthy();
      const x = buf.getChannelData(0);
      const y = other!.getChannelData(0);
      expect(x.length).toBe(y.length);
      // Spot-check rather than compare a million samples one by one.
      for (let i = 0; i < x.length; i += 977) expect(x[i]).toBe(y[i]);
    }
  });
});

describe("drum kit", () => {
  const kit = bakeKit(stubContext(), makeRng(7));
  for (const name of Object.keys(kit)) {
    it(`${name} is finite, bounded and audible`, () => {
      const s = stats(kit[name].getChannelData(0));
      expect(s.bad).toBe(0);
      expect(s.peak).toBeGreaterThan(0.05);
      expect(s.peak).toBeLessThanOrEqual(1.001);
    });
  }
});

describe("dsp primitives", () => {
  it("svfBand stays bounded when swept past Nyquist", () => {
    const band = svfBand(SR, 12);
    const rng = makeRng(5);
    let peak = 0;
    for (let i = 0; i < SR; i++) {
      // Deliberately absurd: a cutoff request well above half the sample rate.
      const y = band(rng() * 2 - 1, 100 + i * 4);
      expect(Number.isFinite(y)).toBe(true);
      peak = Math.max(peak, Math.abs(y));
    }
    expect(peak).toBeLessThan(30);
  });

  it("one-pole filters converge on their input", () => {
    const lp = onePole(200, SR);
    let y = 0;
    for (let i = 0; i < SR; i++) y = lp(1);
    expect(y).toBeGreaterThan(0.99);
    const hp = oneHigh(200, SR);
    let z = 0;
    for (let i = 0; i < SR; i++) z = hp(1);
    expect(Math.abs(z)).toBeLessThan(0.01);
  });

  it("normalise leaves silence alone", () => {
    const d = new Float32Array(64);
    normalize(d);
    for (const v of d) expect(v).toBe(0);
  });

  it("percEnv is bounded and decays", () => {
    expect(percEnv(-1, 0.01, 0.1)).toBe(0);
    expect(percEnv(0.01, 0.01, 0.1)).toBeCloseTo(1, 5);
    expect(percEnv(0.5, 0.01, 0.1)).toBeLessThan(0.02);
  });

  it("noteHz and clamp behave", () => {
    expect(noteHz(69)).toBeCloseTo(440, 6);
    expect(noteHz(81)).toBeCloseTo(880, 6);
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
  });
});

function fakeCtx(): KartCtx {
  const listeners = new Map<string, Set<(p: never) => void>>();
  return {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000),
    renderer: {} as unknown as THREE.WebGLRenderer,
    services: {},
    input: makeKartInput(),
    elapsed: 0,
    dt: 1 / 60,
    quality: "high",
    rng: makeRng(42),
    viewport: { width: 1280, height: 720, aspect: 16 / 9, dpr: 1 },
    emit(event, payload) {
      for (const fn of listeners.get(String(event)) ?? []) (fn as (p: unknown) => void)(payload);
    },
    on(event, fn) {
      const key = String(event);
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(fn);
      return () => set!.delete(fn);
    },
  };
}

describe("with no WebAudio at all", () => {
  it("createGraph reports unavailability instead of throwing", () => {
    expect(createGraph("high", makeRng(1))).toBeNull();
  });

  it("boots, absorbs the whole race, and disposes", () => {
    const ctx = fakeCtx();
    const system = createAudio(ctx);
    const audio = ctx.services.audio;
    expect(audio).toBeTruthy();

    const racer = {
      id: 0,
      isPlayer: true,
      speed: 18,
      maxSpeed: 28,
      rpm: 0.6,
      boost: 0,
      grounded: true,
      stun: 0,
      star: 0,
      surface: "road",
      drifting: true,
      driftCharge: 0.4,
      airTime: 0,
      position: new THREE.Vector3(1, 0, 2),
    } as unknown as RacerState;

    expect(() => {
      audio!.unlock();
      audio!.music("race");
      audio!.engine(racer);
      audio!.play("itemBox", new THREE.Vector3(0, 1, 0), { volume: 0.8 });
      audio!.play("a name nobody has ever used");
      audio!.setMuted(true);
      audio!.setMuted(false);
      for (const [event, payload] of [
        ["race:countdown", { count: 3 }],
        ["race:countdown", { count: 0 }],
        ["race:start", {}],
        ["race:lap", { racer: 0, lap: 2 }],
        ["race:finalLap", { racer: 0, isPlayer: true }],
        ["kart:boost", { racer: 0, source: "miniTurbo" }],
        ["kart:hit", { racer: 0, by: "banana", spin: true }],
        ["kart:land", { racer: 0, impact: 0.9 }],
        ["race:finish", { racer: 0, place: 1 }],
        ["ui:pause", {}],
      ] as const) {
        ctx.emit(event, payload);
      }
      system.lateUpdate?.(1 / 60, ctx);
      system.dispose?.();
    }).not.toThrow();

    expect(ctx.services.audio).toBeUndefined();
  });
});
