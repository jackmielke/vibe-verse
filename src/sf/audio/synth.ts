/**
 * audio/synth.ts — the DSP toolkit everything else in `src/sf/audio` is built
 * from. No sample files ship with this game; every sound in San Francisco is
 * computed.
 *
 * Two rendering strategies live here and the split is deliberate:
 *
 *   1. **Graph synthesis** (`biquad`, `percEnv`, `impactNodes`, …) builds a
 *      handful of WebAudio nodes and lets the browser's audio thread render
 *      them. Cheap per-voice, sample-accurate scheduling, but you only get the
 *      DSP the platform gives you and every voice costs node churn.
 *
 *   2. **Baking** (`bakeSync`, `bakeOffline`) renders a sound *once* into an
 *      AudioBuffer and then replays it with pitch/gain/pan jitter. Anything
 *      whose per-voice cost would be more than ~8 nodes — reverb tails,
 *      ambience loops, debris showers, modal resonator banks — is baked. A
 *      gunshot tail is 30 filters and 400 ms; rendering that 12 times a second
 *      on the audio thread is how you get crackle. Rendering it once and
 *      replaying it is free.
 *
 * The numeric side (`SVF`, `renderModal`, `fillNoise`, `renderIR`) operates on
 * Float32Arrays with a seeded RNG so a baked buffer is bit-identical on every
 * machine — the screenshot harness and the determinism rule both require it.
 *
 * Public API
 * ----------
 *   fillNoise / noiseBuffer / velvetNoise
 *   percEnv / adsr / expRamp / rampPoints / expApproach
 *   biquad / saturator / waveshaperCurve
 *   SVF / svfSweep / onePoleLowpass / dcBlock / normalize / softClip
 *   renderModal / impactNodes / MODAL_LIBRARY
 *   GranularPlayer
 *   bakeSync / bakeOffline / bakedBuffer / clearBakeCache
 *   renderIR / IrSpec
 */
import { clamp, clamp01, makeRng, type Rng } from "../math/rng";

/* ================================================================== *
 * Noise
 * ================================================================== */

export type NoiseKind = "white" | "pink" | "brown" | "blue" | "velvet";

/**
 * Fill `out` with noise of the requested spectrum, in roughly [-1, 1].
 *
 * Pink uses Paul Kellet's economical filter bank (−3 dB/oct, the spectrum of
 * almost every natural broadband sound: wind, tyres, distant traffic). Brown
 * is a leaky integrator (−6 dB/oct — rumble, explosions, chest-punch). Blue is
 * a first difference of white (+3 dB/oct — spray, sand, hiss detail).
 */
export function fillNoise(out: Float32Array, kind: NoiseKind, rng: Rng, gain = 1): void {
  const n = out.length;
  switch (kind) {
    case "white": {
      for (let i = 0; i < n; i++) out[i] = (rng.next() * 2 - 1) * gain;
      return;
    }
    case "pink": {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < n; i++) {
        const w = rng.next() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11 * gain;
        b6 = w * 0.115926;
      }
      return;
    }
    case "brown": {
      let last = 0;
      for (let i = 0; i < n; i++) {
        const w = rng.next() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        out[i] = last * 3.5 * gain;
      }
      return;
    }
    case "blue": {
      let prev = 0;
      for (let i = 0; i < n; i++) {
        const w = rng.next() * 2 - 1;
        out[i] = (w - prev) * 0.5 * gain;
        prev = w;
      }
      return;
    }
    case "velvet": {
      // Velvet noise: sparse ±1 impulses. Perceptually as dense as white but
      // with a fraction of the energy — the classic cheap diffuser, and what
      // makes the generated reverb tails smooth instead of grainy.
      out.fill(0);
      const density = 0.06;
      const stride = Math.max(1, Math.round(1 / density));
      for (let i = 0; i < n; i += stride) {
        const j = i + ((rng.next() * stride) | 0);
        if (j < n) out[j] = rng.next() < 0.5 ? -gain : gain;
      }
      return;
    }
  }
}

/** Sparse ±1 impulse train, used to diffuse tails and debris showers. */
export function velvetNoise(out: Float32Array, density: number, rng: Rng): void {
  out.fill(0);
  const stride = Math.max(1, Math.round(1 / Math.max(1e-4, density)));
  for (let i = 0; i < out.length; i += stride) {
    const j = i + ((rng.next() * stride) | 0);
    if (j < out.length) out[j] = rng.next() < 0.5 ? -1 : 1;
  }
}

/* ================================================================== *
 * Buffer cache + baking
 * ================================================================== */

const bakeCaches = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();
const bakePending = new WeakMap<BaseAudioContext, Map<string, Promise<AudioBuffer | null>>>();

function cacheFor(ctx: BaseAudioContext): Map<string, AudioBuffer> {
  let m = bakeCaches.get(ctx);
  if (!m) {
    m = new Map();
    bakeCaches.set(ctx, m);
  }
  return m;
}

/** Look up an already-baked buffer without triggering a bake. */
export function bakedBuffer(ctx: BaseAudioContext, key: string): AudioBuffer | null {
  return cacheFor(ctx).get(key) ?? null;
}

/**
 * Render a buffer numerically, once, and memoise it under `key`.
 *
 * Synchronous on purpose: numeric fills are microseconds-to-milliseconds and
 * making them async would force every call site to deal with "the sound is not
 * ready yet" for something that is ready by the time the next frame starts.
 * Keep individual fills under ~5 ms; anything longer belongs in `bakeOffline`
 * where the browser renders it off-thread.
 */
export function bakeSync(
  ctx: BaseAudioContext,
  key: string,
  seconds: number,
  channels: number,
  fill: (chans: Float32Array[], sampleRate: number, rng: Rng) => void,
): AudioBuffer | null {
  const cache = cacheFor(ctx);
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.round(seconds * sr));
    const buf = ctx.createBuffer(channels, len, sr);
    const chans: Float32Array[] = [];
    for (let c = 0; c < channels; c++) chans.push(buf.getChannelData(c));
    fill(chans, sr, makeRng(`sf-audio:${key}`));
    cache.set(key, buf);
    return buf;
  } catch {
    return null;
  }
}

/**
 * Render a node graph offline and memoise the result.
 *
 * Returns the same promise for concurrent callers so a sound requested twice
 * on the same frame is only rendered once. Never rejects — a browser that
 * cannot make an OfflineAudioContext just gets `null` and the caller falls
 * back to live synthesis.
 */
export function bakeOffline(
  ctx: BaseAudioContext,
  key: string,
  seconds: number,
  channels: number,
  build: (octx: OfflineAudioContext, rng: Rng) => void,
): Promise<AudioBuffer | null> {
  const cache = cacheFor(ctx);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);

  let pend = bakePending.get(ctx);
  if (!pend) {
    pend = new Map();
    bakePending.set(ctx, pend);
  }
  const running = pend.get(key);
  if (running) return running;

  const p = (async () => {
    try {
      const OAC =
        (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
      if (!OAC) return null;
      const sr = ctx.sampleRate;
      const octx = new OAC(channels, Math.max(1, Math.round(seconds * sr)), sr);
      build(octx, makeRng(`sf-audio:${key}`));
      const rendered = await octx.startRendering();
      cache.set(key, rendered);
      return rendered;
    } catch {
      return null;
    } finally {
      pend!.delete(key);
    }
  })();
  pend.set(key, p);
  return p;
}

/** Drop every cached buffer for a context (call on teardown). */
export function clearBakeCache(ctx: BaseAudioContext): void {
  bakeCaches.delete(ctx);
  bakePending.delete(ctx);
}

/** Cached noise loop. Long enough (4 s) that the loop point is inaudible. */
export function noiseBuffer(
  ctx: BaseAudioContext,
  seconds: number,
  kind: NoiseKind,
  variant = 0,
): AudioBuffer | null {
  return bakeSync(ctx, `noise:${kind}:${seconds}:${variant}`, seconds, 1, (ch, _sr, rng) => {
    fillNoise(ch[0], kind, rng);
    // Loop-safe: crossfade the last 50 ms over the first 50 ms so a looped
    // noise bed has no periodic click. Noise is stationary, so this is free.
    const xf = Math.min((ch[0].length / 2) | 0, (_sr * 0.05) | 0);
    const d = ch[0];
    for (let i = 0; i < xf; i++) {
      const t = i / xf;
      const tail = d[d.length - xf + i];
      d[i] = d[i] * t + tail * (1 - t);
    }
  });
}

/* ================================================================== *
 * Envelopes and param helpers
 * ================================================================== */

/** exponentialRamp dies on zero; every ramp in this codebase goes through here. */
export function expRamp(param: AudioParam, value: number, time: number): void {
  param.exponentialRampToValueAtTime(Math.max(1e-4, value), time);
}

export interface AdsrSpec {
  attack: number;
  decay: number;
  /** Sustain level as a fraction of peak, 0..1. */
  sustain: number;
  release: number;
}

/**
 * Schedule a full ADSR on `param`, held for `hold` seconds after the decay.
 * Returns the time the release finishes, so callers can stop their sources.
 */
export function adsr(
  param: AudioParam,
  t0: number,
  spec: AdsrSpec,
  hold: number,
  peak = 1,
): number {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(1e-4, t0);
  const tA = t0 + Math.max(0.0005, spec.attack);
  expRamp(param, peak, tA);
  const tD = tA + Math.max(0.001, spec.decay);
  const sus = Math.max(1e-4, peak * spec.sustain);
  expRamp(param, sus, tD);
  const tS = tD + Math.max(0, hold);
  param.setValueAtTime(sus, tS);
  const tR = tS + Math.max(0.002, spec.release);
  expRamp(param, 1e-4, tR);
  return tR;
}

/**
 * Percussive envelope — instant-ish attack, exponential fall. This is the
 * shape of nearly every transient in the game: impacts, gunshot bodies, kick
 * drums, debris. `curve` > 1 makes the tail hang; < 1 snaps it off.
 */
export function percEnv(
  param: AudioParam,
  t0: number,
  peak: number,
  decay: number,
  attack = 0.0008,
  curve = 1,
): number {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(1e-4, t0);
  expRamp(param, peak, t0 + attack);
  if (curve === 1) {
    expRamp(param, 1e-4, t0 + attack + decay);
  } else {
    // Piecewise exponential so we can bend away from a pure exponential —
    // real decays in a reverberant city are convex, not straight in dB.
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      const u = i / steps;
      const t = t0 + attack + decay * Math.pow(u, curve);
      expRamp(param, peak * Math.pow(1e-4 / peak, u), t);
    }
  }
  return t0 + attack + decay;
}

/** Multi-point linear ramp: rampPoints(p, t0, [[0, 1], [0.2, 0.3], [1, 0]]). */
export function rampPoints(
  param: AudioParam,
  t0: number,
  points: readonly (readonly [number, number])[],
): void {
  if (points.length === 0) return;
  param.cancelScheduledValues(t0);
  param.setValueAtTime(points[0][1], t0 + points[0][0]);
  for (let i = 1; i < points.length; i++) {
    param.linearRampToValueAtTime(points[i][1], t0 + points[i][0]);
  }
}

/**
 * Exponential approach toward a target with a time constant — the right tool
 * for continuous controls (engine RPM, wind level) because it is frame-rate
 * independent and never overshoots.
 */
export function expApproach(param: AudioParam, target: number, tau: number, now: number): void {
  param.setTargetAtTime(target, now, Math.max(0.001, tau));
}

/* ================================================================== *
 * Filters and shaping
 * ================================================================== */

export function biquad(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  freq: number,
  q = 0.7071,
  gainDb = 0,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = clamp(freq, 10, Math.min(20000, ctx.sampleRate * 0.48));
  f.Q.value = q;
  f.gain.value = gainDb;
  return f;
}

const curveCache = new Map<string, Float32Array>();

export type ShaperKind = "tanh" | "fold" | "asym" | "crush";

/**
 * Waveshaper transfer curve. `amount` 0..1.
 *
 * "asym" is the interesting one for engines and gunshots: an asymmetric
 * transfer function generates even harmonics, which is what makes a real
 * exhaust or a blown speaker sound *thick* rather than merely fuzzy.
 */
export function waveshaperCurve(amount: number, kind: ShaperKind = "tanh", n = 2048): Float32Array {
  const a = clamp01(amount);
  const key = `${kind}:${a.toFixed(3)}:${n}`;
  const hit = curveCache.get(key);
  if (hit) return hit;
  const curve = new Float32Array(n);
  const k = 1 + a * 60;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    let y: number;
    switch (kind) {
      case "fold":
        y = Math.sin(x * (1 + a * 6) * Math.PI * 0.5);
        break;
      case "asym": {
        const xx = x + a * 0.25;
        y = Math.tanh(xx * k) - Math.tanh(a * 0.25 * k);
        break;
      }
      case "crush": {
        const levels = Math.max(2, Math.round(64 * (1 - a) + 2));
        y = Math.round(x * levels) / levels;
        break;
      }
      default:
        y = Math.tanh(x * k) / Math.tanh(k);
    }
    curve[i] = clamp(y, -1, 1);
  }
  curveCache.set(key, curve);
  return curve;
}

export function saturator(
  ctx: BaseAudioContext,
  amount: number,
  kind: ShaperKind = "tanh",
): WaveShaperNode {
  const ws = ctx.createWaveShaper();
  ws.curve = waveshaperCurve(amount, kind);
  ws.oversample = "2x";
  return ws;
}

/**
 * Chamberlin state-variable filter (numeric, for baking).
 *
 * Gives lowpass/bandpass/highpass/notch from one structure and — critically —
 * stays stable while the cutoff is swept per sample, which is exactly what a
 * gunshot body or a skid squeal needs. A BiquadFilterNode recomputes
 * coefficients on a 128-sample block boundary; this one does it per sample.
 */
export class SVF {
  private low = 0;
  private band = 0;
  private f = 0.1;
  private q = 1;
  constructor(private sampleRate: number) {}

  set(cutoff: number, resonance: number): void {
    // 2*sin(pi*fc/sr) is the standard Chamberlin tuning; clamp well below
    // Nyquist/3 where the approximation falls apart and self-oscillates.
    const fc = clamp(cutoff, 10, this.sampleRate * 0.24);
    this.f = 2 * Math.sin((Math.PI * fc) / this.sampleRate);
    this.q = 1 / clamp(resonance, 0.5, 40);
  }

  reset(): void {
    this.low = 0;
    this.band = 0;
  }

  /** mode: 0 = low, 1 = band, 2 = high, 3 = notch. */
  process(x: number, mode = 0): number {
    const high = x - this.low - this.q * this.band;
    this.band += this.f * high;
    this.low += this.f * this.band;
    switch (mode) {
      case 1:
        return this.band;
      case 2:
        return high;
      case 3:
        return high + this.low;
      default:
        return this.low;
    }
  }
}

/**
 * Sweep an SVF across a buffer in place. `shape` maps 0..1 progress to 0..1
 * cutoff interpolation, letting a caller bend the sweep (gunshot bodies sweep
 * fast at the start and slowly after).
 */
export function svfSweep(
  buf: Float32Array,
  sampleRate: number,
  f0: number,
  f1: number,
  q: number,
  mode = 0,
  shape: (u: number) => number = (u) => u,
): void {
  const svf = new SVF(sampleRate);
  const n = buf.length;
  const inv = n > 1 ? 1 / (n - 1) : 1;
  const logF0 = Math.log(Math.max(10, f0));
  const logF1 = Math.log(Math.max(10, f1));
  for (let i = 0; i < n; i++) {
    const u = clamp01(shape(i * inv));
    svf.set(Math.exp(logF0 + (logF1 - logF0) * u), q);
    buf[i] = svf.process(buf[i], mode);
  }
}

/** One-pole lowpass over a buffer, in place. Cheap air/damping model. */
export function onePoleLowpass(buf: Float32Array, sampleRate: number, cutoff: number): void {
  const a = Math.exp((-2 * Math.PI * clamp(cutoff, 5, sampleRate * 0.49)) / sampleRate);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y = buf[i] * (1 - a) + y * a;
    buf[i] = y;
  }
}

/** One-pole highpass / DC blocker. Baked buffers with DC offset click on play. */
export function dcBlock(buf: Float32Array, sampleRate: number, cutoff = 18): void {
  const r = 1 - (2 * Math.PI * cutoff) / sampleRate;
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    y1 = x - x1 + r * y1;
    x1 = x;
    buf[i] = y1;
  }
}

/** Peak-normalise to `peak`. Returns the gain that was applied. */
export function normalize(buf: Float32Array, peak = 0.98): number {
  let m = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = buf[i] < 0 ? -buf[i] : buf[i];
    if (a > m) m = a;
  }
  if (m < 1e-6) return 1;
  const g = peak / m;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return g;
}

/** In-place soft clip. Baked buffers get this instead of a hard ceiling. */
export function softClip(buf: Float32Array, drive = 1): void {
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * drive);
}

/** Apply a short fade in/out so a buffer never clicks at its edges. */
export function edgeFade(buf: Float32Array, sampleRate: number, inMs = 1, outMs = 6): void {
  const a = Math.min(buf.length >> 1, Math.round((inMs / 1000) * sampleRate));
  const b = Math.min(buf.length >> 1, Math.round((outMs / 1000) * sampleRate));
  for (let i = 0; i < a; i++) buf[i] *= i / a;
  for (let i = 0; i < b; i++) buf[buf.length - 1 - i] *= i / b;
}

/* ================================================================== *
 * Modal (physical-model) impact synthesis
 * ================================================================== */

export interface ModalMode {
  /** Partial frequency, Hz. */
  f: number;
  /** T60 decay, seconds. */
  decay: number;
  /** Linear amplitude. */
  gain: number;
}

export interface ModalSpec {
  modes: readonly ModalMode[];
  /** Exciter burst length in seconds — the "hardness" of the strike. */
  exciter: number;
  /** Exciter spectrum. Hard strikes are white; soft ones are brown. */
  exciterKind?: NoiseKind;
  /** Extra broadband noise mixed under the modes (grit of the contact). */
  noise?: number;
  /** Lowpass over the whole result, Hz. */
  tone?: number;
}

/**
 * Render a struck object numerically.
 *
 * Each mode is a two-pole resonator excited by a short noise burst — the
 * textbook modal synthesis model, and the reason a shell casing on concrete
 * and a shell casing on a car bonnet are recognisably the same event on two
 * different objects. Frequencies come from the object's geometry, decays from
 * its damping, and both are what your ear identifies the material by.
 */
export function renderModal(out: Float32Array, sampleRate: number, spec: ModalSpec, rng: Rng): void {
  const n = out.length;
  out.fill(0);

  // Exciter: a short burst, so all modes are struck at once.
  const excN = Math.max(2, Math.round(spec.exciter * sampleRate));
  const exc = new Float32Array(Math.min(n, excN));
  fillNoise(exc, spec.exciterKind ?? "white", rng);
  for (let i = 0; i < exc.length; i++) {
    // Raised-cosine window: a rectangular burst has a bright click of its own
    // that masks the modes it is supposed to reveal.
    exc[i] *= 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / exc.length);
  }

  for (const m of spec.modes) {
    if (m.f <= 0 || m.f >= sampleRate * 0.48) continue;
    const w = (2 * Math.PI * m.f) / sampleRate;
    // r from T60: amplitude falls to 1e-3 over `decay` seconds.
    const r = Math.pow(10, -3 / (Math.max(0.004, m.decay) * sampleRate));
    const c1 = 2 * r * Math.cos(w);
    const c2 = -r * r;
    let y1 = 0;
    let y2 = 0;
    const g = m.gain * (1 - r); // normalise: high-Q resonators otherwise explode
    for (let i = 0; i < n; i++) {
      const x = i < exc.length ? exc[i] : 0;
      const y = x * g + c1 * y1 + c2 * y2;
      y2 = y1;
      y1 = y;
      out[i] += y;
    }
  }

  if (spec.noise) {
    // Contact grit: broadband, decaying much faster than the modes.
    const tau = Math.max(0.004, spec.exciter * 6);
    let b = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-t / tau);
      if (env < 1e-4) break;
      b = b * 0.6 + (rng.next() * 2 - 1) * 0.4;
      out[i] += b * env * spec.noise;
    }
  }

  if (spec.tone) onePoleLowpass(out, sampleRate, spec.tone);
  dcBlock(out, sampleRate);
  edgeFade(out, sampleRate, 0.2, 4);
}

/**
 * Material presets. Frequencies and decays are picked to sit where the real
 * objects sit: concrete is a dull thud with almost no ring, thin metal rings
 * for a second and a half, glass is a bright short shatter, flesh is nearly
 * all noise. These are the identity of an impact — get them wrong and every
 * surface in the city sounds like the same cardboard box.
 */
export const MODAL_LIBRARY: Record<string, ModalSpec> = {
  concrete: {
    exciter: 0.0018,
    exciterKind: "white",
    noise: 0.55,
    tone: 5200,
    modes: [
      { f: 210, decay: 0.055, gain: 1 },
      { f: 430, decay: 0.038, gain: 0.62 },
      { f: 880, decay: 0.026, gain: 0.4 },
      { f: 1740, decay: 0.018, gain: 0.22 },
    ],
  },
  asphalt: {
    exciter: 0.0022,
    exciterKind: "pink",
    noise: 0.7,
    tone: 3400,
    modes: [
      { f: 150, decay: 0.05, gain: 1 },
      { f: 330, decay: 0.03, gain: 0.45 },
      { f: 700, decay: 0.02, gain: 0.2 },
    ],
  },
  metal: {
    exciter: 0.0009,
    exciterKind: "white",
    noise: 0.18,
    tone: 15000,
    modes: [
      { f: 620, decay: 0.9, gain: 0.85 },
      { f: 1490, decay: 0.75, gain: 1 },
      { f: 2370, decay: 0.55, gain: 0.7 },
      { f: 3910, decay: 0.4, gain: 0.5 },
      { f: 5730, decay: 0.28, gain: 0.32 },
      { f: 8100, decay: 0.16, gain: 0.18 },
    ],
  },
  thinMetal: {
    exciter: 0.0006,
    exciterKind: "white",
    noise: 0.24,
    tone: 16000,
    modes: [
      { f: 1180, decay: 1.4, gain: 0.7 },
      { f: 2260, decay: 1.1, gain: 1 },
      { f: 3340, decay: 0.8, gain: 0.72 },
      { f: 5210, decay: 0.5, gain: 0.5 },
      { f: 7420, decay: 0.32, gain: 0.34 },
      { f: 10600, decay: 0.2, gain: 0.2 },
    ],
  },
  glass: {
    exciter: 0.0006,
    exciterKind: "blue",
    noise: 0.5,
    tone: 18000,
    modes: [
      { f: 2400, decay: 0.22, gain: 0.8 },
      { f: 3650, decay: 0.18, gain: 1 },
      { f: 5400, decay: 0.13, gain: 0.75 },
      { f: 7900, decay: 0.09, gain: 0.5 },
      { f: 11200, decay: 0.06, gain: 0.3 },
    ],
  },
  wood: {
    exciter: 0.0016,
    exciterKind: "white",
    noise: 0.4,
    tone: 6500,
    modes: [
      { f: 320, decay: 0.14, gain: 1 },
      { f: 705, decay: 0.1, gain: 0.7 },
      { f: 1190, decay: 0.07, gain: 0.45 },
      { f: 2280, decay: 0.05, gain: 0.25 },
    ],
  },
  brick: {
    exciter: 0.0018,
    exciterKind: "white",
    noise: 0.62,
    tone: 4600,
    modes: [
      { f: 260, decay: 0.05, gain: 1 },
      { f: 540, decay: 0.034, gain: 0.55 },
      { f: 1130, decay: 0.022, gain: 0.3 },
    ],
  },
  stone: {
    exciter: 0.0014,
    exciterKind: "white",
    noise: 0.45,
    tone: 7000,
    modes: [
      { f: 340, decay: 0.09, gain: 1 },
      { f: 760, decay: 0.06, gain: 0.6 },
      { f: 1520, decay: 0.04, gain: 0.35 },
      { f: 2900, decay: 0.025, gain: 0.18 },
    ],
  },
  stucco: {
    exciter: 0.0022,
    exciterKind: "pink",
    noise: 0.8,
    tone: 3800,
    modes: [
      { f: 240, decay: 0.045, gain: 1 },
      { f: 520, decay: 0.03, gain: 0.4 },
    ],
  },
  dirt: {
    exciter: 0.004,
    exciterKind: "brown",
    noise: 0.95,
    tone: 1800,
    modes: [
      { f: 120, decay: 0.05, gain: 1 },
      { f: 260, decay: 0.03, gain: 0.3 },
    ],
  },
  gravel: {
    exciter: 0.003,
    exciterKind: "white",
    noise: 1,
    tone: 6800,
    modes: [
      { f: 480, decay: 0.03, gain: 0.6 },
      { f: 1300, decay: 0.02, gain: 0.4 },
    ],
  },
  grass: {
    exciter: 0.006,
    exciterKind: "pink",
    noise: 1,
    tone: 2600,
    modes: [{ f: 180, decay: 0.03, gain: 0.4 }],
  },
  sand: {
    exciter: 0.008,
    exciterKind: "white",
    noise: 1,
    tone: 5200,
    modes: [{ f: 300, decay: 0.02, gain: 0.25 }],
  },
  water: {
    exciter: 0.005,
    exciterKind: "brown",
    noise: 0.9,
    tone: 2400,
    modes: [
      { f: 420, decay: 0.05, gain: 0.5 },
      { f: 900, decay: 0.03, gain: 0.3 },
    ],
  },
  flesh: {
    exciter: 0.004,
    exciterKind: "brown",
    noise: 1,
    tone: 1200,
    modes: [
      { f: 90, decay: 0.05, gain: 1 },
      { f: 190, decay: 0.03, gain: 0.4 },
    ],
  },
  foliage: {
    exciter: 0.01,
    exciterKind: "white",
    noise: 1,
    tone: 7200,
    modes: [{ f: 1600, decay: 0.02, gain: 0.2 }],
  },
  plastic: {
    exciter: 0.0011,
    exciterKind: "white",
    noise: 0.35,
    tone: 9000,
    modes: [
      { f: 900, decay: 0.09, gain: 1 },
      { f: 1850, decay: 0.06, gain: 0.55 },
      { f: 3300, decay: 0.04, gain: 0.28 },
    ],
  },
  rubber: {
    exciter: 0.0035,
    exciterKind: "brown",
    noise: 0.5,
    tone: 1600,
    modes: [
      { f: 145, decay: 0.06, gain: 1 },
      { f: 310, decay: 0.035, gain: 0.35 },
    ],
  },
  fabric: {
    exciter: 0.007,
    exciterKind: "pink",
    noise: 1,
    tone: 4200,
    modes: [{ f: 400, decay: 0.02, gain: 0.15 }],
  },
};

/**
 * The graph version of a modal strike, for the rare cases where the impact
 * needs live parameters (a variable-pitch resonance following a slide, say).
 * Returns the time it finishes so the caller can free its voice.
 *
 * Everything else should bake — 6 bandpasses per impact adds up fast when
 * a burst of buckshot hits a wall.
 */
export function impactNodes(
  ctx: BaseAudioContext,
  dest: AudioNode,
  spec: ModalSpec,
  when: number,
  gain: number,
  pitch = 1,
  noiseSrc: AudioBuffer | null = null,
): number {
  const out = ctx.createGain();
  out.gain.value = gain;
  out.connect(dest);

  const src = ctx.createBufferSource();
  const buf = noiseSrc ?? noiseBuffer(ctx, 0.25, spec.exciterKind ?? "white", 0);
  if (!buf) return when;
  src.buffer = buf;
  const burst = ctx.createGain();
  percEnv(burst.gain, when, 1, Math.max(0.002, spec.exciter * 3), 0.0004);
  src.connect(burst);

  let end = when + 0.05;
  for (const m of spec.modes) {
    const bp = biquad(ctx, "bandpass", m.f * pitch, Math.max(2, (m.f * m.decay) / 2));
    const g = ctx.createGain();
    const t = percEnv(g.gain, when, m.gain, m.decay);
    if (t > end) end = t;
    burst.connect(bp);
    bp.connect(g);
    g.connect(out);
  }

  src.start(when);
  src.stop(end + 0.02);
  src.onended = () => {
    try {
      out.disconnect();
    } catch {
      /* already torn down */
    }
  };
  return end;
}

/* ================================================================== *
 * Granular playback
 * ================================================================== */

export interface GrainSpec {
  /** Grain length, seconds. */
  size: number;
  /** Grains per second. */
  density: number;
  /** Randomisation of the read head, seconds. */
  jitter: number;
  /** Playback-rate spread, ±. */
  detune: number;
  /** Stereo spread of grain pans, 0..1. */
  spread: number;
  gain: number;
}

/**
 * Overlapping-grain scheduler over a source buffer.
 *
 * Used for debris showers, rain on metal, crowd murmur and rubble — anything
 * that is "many small events" rather than one sound. Grains are scheduled in
 * lookahead blocks, so the main thread wakes up rarely rather than 60 times a
 * second, and nothing is allocated once the pool is warm.
 */
export class GranularPlayer {
  private nodes: { src: AudioBufferSourceNode; env: GainNode; pan: StereoPannerNode }[] = [];
  private nextGrain = 0;
  private running = false;

  readonly out: GainNode;

  constructor(
    private ctx: BaseAudioContext,
    private buffer: AudioBuffer,
    private spec: GrainSpec,
    private rng: Rng,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = spec.gain;
  }

  start(when: number): void {
    this.running = true;
    this.nextGrain = Math.max(when, this.ctx.currentTime);
  }

  stop(): void {
    this.running = false;
    for (const n of this.nodes) {
      try {
        n.src.stop();
      } catch {
        /* not started */
      }
    }
    this.nodes.length = 0;
  }

  setDensity(d: number): void {
    this.spec.density = Math.max(0.1, d);
  }

  /** Schedule grains up to `horizon` seconds ahead of now. Call ~10 Hz. */
  pump(horizon = 0.2): void {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    const until = now + horizon;
    if (this.nextGrain < now) this.nextGrain = now;
    let guard = 0;
    while (this.nextGrain < until && guard++ < 64) {
      this.grain(this.nextGrain);
      this.nextGrain += 1 / this.spec.density;
    }
  }

  private grain(at: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    const dur = this.buffer.duration;
    const offset = clamp(this.rng.next() * dur, 0, Math.max(0, dur - this.spec.size));
    src.playbackRate.value = Math.pow(2, this.rng.gauss() * this.spec.detune);

    const env = ctx.createGain();
    // Hann-ish window via two ramps; a rectangular grain buzzes at the grain
    // rate, which is the classic "granular done wrong" artefact.
    env.gain.setValueAtTime(1e-4, at);
    env.gain.linearRampToValueAtTime(1, at + this.spec.size * 0.5);
    env.gain.linearRampToValueAtTime(1e-4, at + this.spec.size);

    const pan = ctx.createStereoPanner();
    pan.pan.value = (this.rng.next() * 2 - 1) * this.spec.spread;

    src.connect(env);
    env.connect(pan);
    pan.connect(this.out);
    src.start(at, offset, this.spec.size * 1.05);
    src.stop(at + this.spec.size * 1.1);
    src.onended = () => {
      try {
        env.disconnect();
        pan.disconnect();
      } catch {
        /* torn down */
      }
    };
  }
}

/* ================================================================== *
 * Impulse responses
 * ================================================================== */

export interface IrSpec {
  /** Total tail length, seconds. */
  seconds: number;
  /** T60 of the diffuse tail, seconds. */
  decay: number;
  /** Gap before the first reflection, seconds. Big rooms have big pre-delay. */
  predelay: number;
  /** Number of discrete early reflections. */
  earlyTaps: number;
  /** Time window the early taps land in, seconds. */
  earlySpread: number;
  /** Level of the early reflections relative to the tail. */
  earlyGain: number;
  /** HF absorption: lowpass cutoff at the start of the tail, Hz. */
  damping: number;
  /** How fast damping closes over the tail, 0..1. */
  dampingSlope: number;
  /** Stereo decorrelation, 0..1. */
  width: number;
  /** Extra low-frequency energy (concrete canyons boom). */
  lowBoost: number;
  /** Comb-like modal colouration, 0..1. Corridors and tunnels have a lot. */
  resonance: number;
  /** Resonant frequency for `resonance`, Hz. */
  resonanceHz: number;
}

/**
 * Generate a stereo impulse response.
 *
 * Structure is the standard early/late split, because that split is what your
 * ear actually uses: the discrete early reflections tell you the size and
 * shape of the space, the diffuse exponential tail tells you how absorbent it
 * is. An IR that is only a decaying noise burst sounds like "reverb"; one with
 * proper early taps sounds like *a place*.
 */
export function renderIR(chans: Float32Array[], sampleRate: number, spec: IrSpec, rng: Rng): void {
  const n = chans[0].length;
  const preN = Math.round(spec.predelay * sampleRate);

  for (let c = 0; c < chans.length; c++) {
    const d = chans[c];
    d.fill(0);

    // --- diffuse tail: velvet noise, exponentially damped -----------------
    const dens = 0.16;
    const stride = Math.max(1, Math.round(1 / dens));
    const tau = Math.max(0.02, spec.decay) / 6.908; // ln(1000)
    for (let i = preN; i < n; i += stride) {
      const j = i + ((rng.next() * stride) | 0);
      if (j >= n) break;
      const t = (j - preN) / sampleRate;
      const env = Math.exp(-t / tau);
      d[j] += (rng.next() < 0.5 ? -1 : 1) * env;
    }

    // Progressive HF damping: air and soft surfaces eat the top of the tail
    // long before the bottom. A single static lowpass over the whole IR is the
    // difference between "a room" and "a cassette".
    const seg = Math.max(256, Math.round(sampleRate * 0.02));
    let carry = 0;
    for (let s = preN; s < n; s += seg) {
      const u = clamp01((s - preN) / Math.max(1, n - preN));
      const cutoff = clamp(
        spec.damping * Math.pow(1 - spec.dampingSlope * 0.92, u * 8),
        200,
        sampleRate * 0.45,
      );
      const a = Math.exp((-2 * Math.PI * cutoff) / sampleRate);
      const end = Math.min(n, s + seg);
      for (let i = s; i < end; i++) {
        carry = d[i] * (1 - a) + carry * a;
        d[i] = carry;
      }
    }

    // --- early reflections ------------------------------------------------
    // Placed on a slightly irregular grid: perfectly even taps comb-filter
    // into a metallic ring, which is what cheap algorithmic reverb sounds
    // like. Alternating sign decorrelates the two channels for free.
    for (let k = 0; k < spec.earlyTaps; k++) {
      const u = (k + rng.next() * 0.7) / spec.earlyTaps;
      const t = spec.predelay + Math.pow(u, 1.35) * spec.earlySpread;
      const idx = Math.round(t * sampleRate);
      if (idx >= n) continue;
      const g =
        spec.earlyGain *
        Math.pow(0.72, k * 0.6) *
        (rng.next() < 0.5 ? -1 : 1) *
        (1 - spec.width * 0.4 * c * rng.next());
      d[idx] += g;
      // Each tap is itself a small diffuse smear, not a naked click.
      const smear = Math.round(sampleRate * 0.0012);
      for (let i = 1; i < smear && idx + i < n; i++) {
        d[idx + i] += g * 0.35 * Math.exp(-i / (smear * 0.4)) * (rng.next() * 2 - 1);
      }
    }

    // --- modal colouration ------------------------------------------------
    // Tunnels and narrow alleys have strong axial modes. One resonator over
    // the whole IR is enough to hear the space is narrow.
    if (spec.resonance > 0.001) {
      const w = (2 * Math.PI * spec.resonanceHz) / sampleRate;
      const r = Math.pow(10, -3 / (Math.max(0.05, spec.decay * 0.5) * sampleRate));
      const c1 = 2 * r * Math.cos(w);
      const c2 = -r * r;
      let y1 = 0;
      let y2 = 0;
      const g = spec.resonance * (1 - r) * 3;
      for (let i = 0; i < n; i++) {
        const y = d[i] * g + c1 * y1 + c2 * y2;
        y2 = y1;
        y1 = y;
        d[i] += y;
      }
    }

    // --- low end ----------------------------------------------------------
    if (spec.lowBoost > 0.001) {
      const a = Math.exp((-2 * Math.PI * 180) / sampleRate);
      let y = 0;
      for (let i = 0; i < n; i++) {
        y = d[i] * (1 - a) + y * a;
        d[i] += y * spec.lowBoost * 2.2;
      }
    }

    dcBlock(d, sampleRate, 25);
    // Direct sound belongs to the dry path, so the IR starts at zero.
    for (let i = 0; i < Math.min(preN, n); i++) d[i] *= i / Math.max(1, preN);
    normalize(d, 0.7);
    edgeFade(d, sampleRate, 0.1, 12);
  }
}

/* ================================================================== *
 * Misc helpers used across the audio modules
 * ================================================================== */

/** dB → linear. */
export const dbToGain = (db: number): number => Math.pow(10, db / 20);
/** linear → dB. */
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(1e-6, g));
/** MIDI note → Hz, A4 = 440. */
export const noteHz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

/** Speed of sound at sea level in the SF marine layer, m/s. */
export const SPEED_OF_SOUND = 341;

/**
 * Air absorption: how much of the top end survives `metres` of travel.
 * Returns a lowpass cutoff in Hz. Real HF absorption is ~1 dB/100 m at 4 kHz
 * and rises steeply with frequency, which is why a rifle 600 m away is all
 * thump and no crack.
 */
export function airCutoff(metres: number, humidity = 0.75): number {
  const d = Math.max(0, metres);
  const k = 1 + (1 - humidity) * 0.6;
  return clamp(20000 / (1 + (d * k) / 22), 320, 20000);
}
