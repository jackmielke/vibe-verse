/**
 * audio.smoke.test.ts — the numeric half of the audio system, under test.
 *
 * There is no AudioContext in Node, so the graph layer cannot be exercised
 * here. The *renderers* can, and they are the half that can silently produce
 * garbage: a resonator with a bad coefficient blows up to Infinity, a filter
 * sweep past Nyquist self-oscillates, a normalise on an all-zero buffer
 * divides by zero. All of those ship as silence or as a speaker-destroying
 * click, and neither is visible in a screenshot.
 *
 * So: every renderer must produce finite, bounded, non-silent audio, and must
 * produce the *same* audio twice, because the whole world is seeded.
 */
import { describe, expect, it } from "vitest";
import { makeRng } from "../math/rng";
import {
  MODAL_LIBRARY,
  SVF,
  airCutoff,
  dbToGain,
  dcBlock,
  edgeFade,
  fillNoise,
  noteHz,
  normalize,
  renderIR,
  renderModal,
  softClip,
  svfSweep,
  velvetNoise,
  waveshaperCurve,
  type NoiseKind,
} from "./synth";

const SR = 48000;

function stats(buf: Float32Array) {
  let peak = 0;
  let rms = 0;
  let bad = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    if (!Number.isFinite(v)) bad++;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    rms += v * v;
  }
  return { peak, rms: Math.sqrt(rms / buf.length), bad };
}

describe("noise generators", () => {
  const kinds: NoiseKind[] = ["white", "pink", "brown", "blue", "velvet"];
  for (const kind of kinds) {
    it(`${kind} is finite, bounded and audible`, () => {
      const buf = new Float32Array(SR / 4);
      fillNoise(buf, kind, makeRng(`t:${kind}`));
      const s = stats(buf);
      expect(s.bad).toBe(0);
      expect(s.peak).toBeGreaterThan(0.01);
      expect(s.peak).toBeLessThan(4);
      expect(s.rms).toBeGreaterThan(0.0005);
    });
  }

  it("is deterministic for a given seed", () => {
    const a = new Float32Array(2048);
    const b = new Float32Array(2048);
    fillNoise(a, "pink", makeRng("same"));
    fillNoise(b, "pink", makeRng("same"));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("velvet noise is sparse and ternary", () => {
    const buf = new Float32Array(10000);
    velvetNoise(buf, 0.05, makeRng("v"));
    let nonZero = 0;
    for (const v of buf) {
      expect(v === 0 || v === 1 || v === -1).toBe(true);
      if (v !== 0) nonZero++;
    }
    expect(nonZero).toBeGreaterThan(300);
    expect(nonZero).toBeLessThan(700);
  });
});

describe("filters", () => {
  it("SVF stays stable at extreme settings", () => {
    const svf = new SVF(SR);
    // Deliberately absurd: right at the clamp, maximum resonance, full-scale
    // input. A Chamberlin SVF driven past fc = sr/6 diverges; the clamp in
    // `set` is the only thing standing between us and Infinity.
    svf.set(1e9, 100);
    let worst = 0;
    for (let i = 0; i < SR; i++) {
      const y = svf.process(i % 2 ? 1 : -1, 1);
      expect(Number.isFinite(y)).toBe(true);
      if (Math.abs(y) > worst) worst = Math.abs(y);
    }
    expect(worst).toBeLessThan(200);
  });

  it("lowpass sweep removes high frequencies", () => {
    const hi = new Float32Array(SR / 2);
    for (let i = 0; i < hi.length; i++) hi[i] = Math.sin((2 * Math.PI * 9000 * i) / SR);
    const before = stats(hi).rms;
    svfSweep(hi, SR, 300, 300, 0.7, 0);
    const after = stats(hi).rms;
    expect(after).toBeLessThan(before * 0.2);
  });

  it("dcBlock removes a constant offset", () => {
    const buf = new Float32Array(SR / 4).fill(0.5);
    dcBlock(buf, SR, 20);
    // Only the tail matters; the filter needs time to settle.
    const tail = buf.subarray(buf.length - 1000);
    expect(Math.abs(stats(tail).rms)).toBeLessThan(0.02);
  });

  it("normalize is safe on silence", () => {
    const buf = new Float32Array(256);
    expect(() => normalize(buf, 0.9)).not.toThrow();
    expect(stats(buf).bad).toBe(0);
  });

  it("softClip bounds its output", () => {
    const buf = new Float32Array(1024);
    for (let i = 0; i < buf.length; i++) buf[i] = (i - 512) * 4;
    softClip(buf, 3);
    expect(stats(buf).peak).toBeLessThanOrEqual(1.0001);
  });

  it("edgeFade zeroes the edges", () => {
    const buf = new Float32Array(SR / 10).fill(1);
    edgeFade(buf, SR, 1, 6);
    expect(Math.abs(buf[0])).toBeLessThan(1e-6);
    expect(Math.abs(buf[buf.length - 1])).toBeLessThan(1e-6);
  });
});

describe("waveshaper curves", () => {
  for (const kind of ["tanh", "fold", "asym", "crush"] as const) {
    it(`${kind} is monotone-bounded and finite`, () => {
      const c = waveshaperCurve(0.7, kind);
      expect(c.length).toBe(2048);
      for (const v of c) {
        expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(v)).toBeLessThanOrEqual(1.0001);
      }
    });
  }

  it("caches identical requests", () => {
    expect(waveshaperCurve(0.5, "tanh")).toBe(waveshaperCurve(0.5, "tanh"));
  });
});

describe("modal impact synthesis", () => {
  it("every material in the library renders cleanly", () => {
    for (const [name, spec] of Object.entries(MODAL_LIBRARY)) {
      const buf = new Float32Array(SR / 2);
      renderModal(buf, SR, spec, makeRng(`m:${name}`));
      const s = stats(buf);
      expect(s.bad, `${name} produced non-finite samples`).toBe(0);
      expect(s.peak, `${name} was silent`).toBeGreaterThan(1e-4);
      expect(s.peak, `${name} exploded`).toBeLessThan(50);
    }
  });

  it("a long decay actually rings longer than a short one", () => {
    const energy = (decay: number) => {
      const buf = new Float32Array(SR);
      renderModal(
        buf,
        SR,
        { exciter: 0.001, noise: 0, modes: [{ f: 800, decay, gain: 1 }] },
        makeRng("ring"),
      );
      // Measure well past the exciter so we are looking at the resonator.
      return stats(buf.subarray(SR / 4)).rms;
    };
    expect(energy(1.5)).toBeGreaterThan(energy(0.05) * 5);
  });

  it("mode frequency lands where it was asked to", () => {
    const buf = new Float32Array(SR / 2);
    renderModal(
      buf,
      SR,
      { exciter: 0.0008, noise: 0, tone: 20000, modes: [{ f: 1000, decay: 0.9, gain: 1 }] },
      makeRng("f"),
    );
    // Zero-crossing count over a steady window → frequency estimate.
    const win = buf.subarray(SR / 8, SR / 8 + SR / 8);
    let crossings = 0;
    for (let i = 1; i < win.length; i++) {
      if (win[i - 1] <= 0 && win[i] > 0) crossings++;
    }
    const hz = crossings / (win.length / SR);
    expect(hz).toBeGreaterThan(900);
    expect(hz).toBeLessThan(1100);
  });
});

describe("impulse responses", () => {
  it("renders a decaying, finite, stereo tail", () => {
    const n = SR * 2;
    const chans = [new Float32Array(n), new Float32Array(n)];
    renderIR(
      chans,
      SR,
      {
        seconds: 2,
        decay: 1.4,
        predelay: 0.012,
        earlyTaps: 14,
        earlySpread: 0.12,
        earlyGain: 0.6,
        damping: 5000,
        dampingSlope: 0.5,
        width: 0.8,
        lowBoost: 0.3,
        resonance: 0.1,
        resonanceHz: 140,
      },
      makeRng("ir"),
    );
    for (const d of chans) {
      const s = stats(d);
      expect(s.bad).toBe(0);
      expect(s.peak).toBeGreaterThan(0.1);
      expect(s.peak).toBeLessThanOrEqual(1);
      // Energy must fall off: the second half is far quieter than the first.
      const first = stats(d.subarray(0, n / 4)).rms;
      const last = stats(d.subarray((n * 3) / 4)).rms;
      expect(last).toBeLessThan(first * 0.5);
    }
    // The two channels must not be identical, or the reverb is mono.
    let diff = 0;
    for (let i = 0; i < n; i += 97) diff += Math.abs(chans[0][i] - chans[1][i]);
    expect(diff).toBeGreaterThan(0.5);
  });

  it("starts silent so the dry path owns the direct sound", () => {
    const n = SR;
    const chans = [new Float32Array(n), new Float32Array(n)];
    renderIR(
      chans,
      SR,
      {
        seconds: 1,
        decay: 0.8,
        predelay: 0.02,
        earlyTaps: 8,
        earlySpread: 0.1,
        earlyGain: 0.5,
        damping: 6000,
        dampingSlope: 0.5,
        width: 0.9,
        lowBoost: 0.1,
        resonance: 0,
        resonanceHz: 200,
      },
      makeRng("ir2"),
    );
    expect(Math.abs(chans[0][0])).toBeLessThan(1e-5);
  });
});

describe("acoustic helpers", () => {
  it("air absorption falls monotonically with distance", () => {
    let prev = Number.POSITIVE_INFINITY;
    for (const d of [0, 10, 50, 200, 800, 3000]) {
      const c = airCutoff(d);
      expect(c).toBeLessThanOrEqual(prev);
      expect(c).toBeGreaterThanOrEqual(320);
      prev = c;
    }
  });

  it("dB and note conversions are right", () => {
    expect(dbToGain(0)).toBeCloseTo(1, 6);
    expect(dbToGain(-6)).toBeCloseTo(0.5012, 3);
    expect(noteHz(69)).toBeCloseTo(440, 6);
    expect(noteHz(81)).toBeCloseTo(880, 6);
  });
});
