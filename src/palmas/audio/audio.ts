/**
 * San Palmas — audio.
 *
 * Every sound in this game is a number. There are no audio files: each cue is
 * rendered sample-by-sample into an AudioBuffer at boot by the little DSP kit
 * in section 2, then played back as a plain BufferSource. That trade — render
 * once, play a thousand times — is what lets a gunfight run 40 concurrent
 * voices on a laptop without a single fetch.
 *
 * The signal path, from a shot leaving the barrel to the speaker:
 *
 *   voice ─▶ air-absorption lowpass ─▶ gain ─▶ panner ─┬─▶ sfxDry ──┐
 *                                                      └─▶ send ─▶ IR ┤
 *   beds  ─▶ bed lowpass ─▶ bed gain ─▶ ambBus ─▶ ambDuck ──────────┤
 *                                                                   ▼
 *                                              muffle LP ─▶ duck ─▶ world
 *   ui    ────────────────────────────────────────────────────────▶ master ─▶ limiter ─▶ out
 *
 * The three things that make it read as a game and not a soundboard:
 *   1. distance shapes timbre, not just volume — far explosions lose their
 *      crack and arrive late (speed of sound), near ones snap;
 *   2. the reverb send is driven by *where the player is standing* — a street
 *      canyon slaps, the open bay doesn't;
 *   3. a blast physically muffles the mix for a couple of seconds afterwards.
 *
 * Publishes AudioService. Never throws: browsers refuse to start an
 * AudioContext until a gesture, so every path here is a no-op until then.
 */
import * as THREE from "three";
import { makeRng } from "../types";
import type { AudioService, QualityTier, System, SystemFactory } from "../types";
import { biomeAt, districtAt, landSignedDistance, type Biome } from "../world/atlas";

// ===========================================================================
// 1. Tunables
// ===========================================================================

/** Hard ceiling on simultaneous voices. Voice stealing kicks in above this. */
const VOICE_CAP: Record<QualityTier, number> = { low: 14, medium: 26, high: 40, ultra: 56 };
/** Rendered variants per cue — the cheapest possible fix for machine-gun repetition. */
const VARIANTS: Record<QualityTier, number> = { low: 1, medium: 2, high: 3, ultra: 4 };
/** Ambience beds are all low-band content; rendering them at full rate is waste. */
const BED_RATE: Record<QualityTier, number> = { low: 16000, medium: 22050, high: 22050, ultra: 32000 };
/** Reverb tail lengths (tight, wide) in seconds. Convolution cost is linear in these. */
const IR_LEN: Record<QualityTier, [number, number]> = {
  low: [0.7, 0],
  medium: [1.0, 1.9],
  high: [1.25, 2.7],
  ultra: [1.4, 3.2],
};

/** Speed of sound, m/s. Distant events are delayed by distance / this. */
const SOUND_SPEED = 343;
/** Cap on that delay — a 2 km explosion arriving 6 seconds later reads as a bug. */
const MAX_TRAVEL = 1.6;
/** How long the mix stays muffled after a blast goes off in your face. */
const CONCUSSION_DECAY = 0.42;

const TWO_PI = Math.PI * 2;

type Rand = () => number;

/** A synthesised cue: how to render it, and how the world should hear it. */
interface Cue {
  /** Rendered length, seconds. */
  dur: number;
  /** Fills one channel. Called once per variant with a different seed. */
  render(o: Float32Array, sr: number, rnd: Rand): void;
  /** Playback gain. Cues are peak-normalised, so this is the mix balance. */
  gain?: number;
  /** Normalisation target, 0..1. Lower for beds and background texture. */
  peak?: number;
  /** Distance (m) below which there is no attenuation. */
  ref?: number;
  /** Distance (m) at which the cue is inaudible and gets dropped entirely. */
  max?: number;
  /** Inverse-distance rolloff strength. */
  roll?: number;
  /** Air-absorption scale; 0 disables the distance lowpass. */
  air?: number;
  /** Reverb send scale. */
  wet?: number;
  /** Base playback rate. */
  rate?: number;
  /** ± random rate spread per trigger. */
  jitter?: number;
  variants?: number;
  /** Render both channels with decorrelated seeds (beds, stingers). */
  stereo?: boolean;
  /** UI cues bypass the world filters so they stay readable through a blast. */
  bus?: "world" | "ui";
  /** Minimum seconds between retriggers of this cue. */
  gap?: number;
  /** Maximum concurrent copies. */
  same?: number;
  /** 0..1 — who survives voice stealing. */
  prio?: number;
  /** Apply speed-of-sound delay. */
  travel?: boolean;
  /** Render sample rate override. */
  sr?: number;
}

// ===========================================================================
// 2. The DSP kit
//
// Everything below writes *additively* into a float scratch buffer. All of it
// is deterministic: the only randomness comes from the `rnd` passed in, which
// is seeded per cue-variant, so a given build of the game always sounds the
// same. No allocation inside any inner loop.
// ===========================================================================

/** Exponential decay, the workhorse envelope. */
function decay(t: number, tau: number): number {
  return Math.exp(-t / tau);
}

interface NoiseOpts {
  t0?: number;
  dur: number;
  amp: number;
  /** Filter cutoff at the start of the layer, Hz. */
  cut0: number;
  /** …and at the end. Swept exponentially — this is what makes noise "fall". */
  cut1?: number;
  /** Resonance. >1.5 starts to whistle, which is exactly what a ricochet wants. */
  res?: number;
  /** Decay time constant. */
  tau: number;
  /** Attack time constant; keeps transients from clicking the DC line. */
  atk?: number;
  mode?: "low" | "band" | "high";
}

/**
 * Filtered noise through a per-sample state-variable filter. Nine tenths of
 * this bank is this function: gunshot cracks, explosions, footsteps, surf,
 * wind and dust are all noise with a different cutoff trajectory.
 */
function noiseLayer(o: Float32Array, sr: number, rnd: Rand, p: NoiseOpts): void {
  const t0 = Math.max(0, Math.round((p.t0 ?? 0) * sr));
  const n = Math.min(o.length - t0, Math.ceil(p.dur * sr));
  if (n <= 0) return;
  const tau = Math.max(1e-4, p.tau);
  const atkT = Math.max(1e-5, p.atk ?? 0.0007);
  const q = 1 / Math.max(0.35, p.res ?? 0.9);
  const mode = p.mode ?? "low";
  const nyq = sr * 0.24;
  const c0 = Math.max(20, Math.min(nyq, p.cut0));
  const c1 = Math.max(20, Math.min(nyq, p.cut1 ?? p.cut0));
  const slope = Math.log(c1 / c0);
  let low = 0;
  let band = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const cut = c0 * Math.exp(slope * u);
    const f = 2 * Math.sin((Math.PI * cut) / sr);
    const x = rnd() * 2 - 1;
    low += f * band;
    const high = x - low - q * band;
    band += f * high;
    const s = mode === "low" ? low : mode === "band" ? band : high;
    const t = i / sr;
    o[t0 + i] += s * decay(t, tau) * (1 - Math.exp(-t / atkT)) * p.amp;
  }
}

interface ToneOpts {
  t0?: number;
  dur: number;
  amp: number;
  /** Start frequency; glides exponentially to `f1`. */
  f0: number;
  f1?: number;
  tau: number;
  atk?: number;
  shape?: "sine" | "tri" | "saw";
  /** FM depth in Hz and its modulator rate — grit for railguns and sirens. */
  fm?: number;
  fmF?: number;
  /** Vibrato depth as a fraction of the carrier. */
  vib?: number;
  vibF?: number;
}

/** A damped, gliding oscillator. Body thumps, sub drops, sirens, whines. */
function toneLayer(o: Float32Array, sr: number, _rnd: Rand, p: ToneOpts): void {
  const t0 = Math.max(0, Math.round((p.t0 ?? 0) * sr));
  const n = Math.min(o.length - t0, Math.ceil(p.dur * sr));
  if (n <= 0) return;
  const tau = Math.max(1e-4, p.tau);
  const atkT = Math.max(1e-5, p.atk ?? 0.0009);
  const f0 = Math.max(1, p.f0);
  const f1 = Math.max(1, p.f1 ?? p.f0);
  const slope = Math.log(f1 / f0);
  const shape = p.shape ?? "sine";
  let phase = 0;
  let fmPhase = 0;
  let vibPhase = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    let f = f0 * Math.exp(slope * u);
    if (p.vib) {
      vibPhase += (TWO_PI * (p.vibF ?? 6)) / sr;
      f *= 1 + Math.sin(vibPhase) * p.vib;
    }
    if (p.fm) {
      fmPhase += (TWO_PI * (p.fmF ?? f * 1.4)) / sr;
      f += Math.sin(fmPhase) * p.fm;
    }
    phase += (TWO_PI * Math.max(1, Math.min(sr * 0.45, f))) / sr;
    if (phase > TWO_PI) phase -= TWO_PI;
    let s: number;
    if (shape === "sine") s = Math.sin(phase);
    else if (shape === "tri") s = 1 - 4 * Math.abs(Math.round(phase / TWO_PI) - phase / TWO_PI);
    else s = 2 * (phase / TWO_PI) - 1;
    const t = i / sr;
    o[t0 + i] += s * decay(t, tau) * (1 - Math.exp(-t / atkT)) * p.amp;
  }
}

/** Inharmonic partial ratios — the difference between "bell" and "struck metal". */
const METAL_PARTIALS = [1, 2.756, 5.404, 8.933, 13.34];

interface RingOpts {
  t0?: number;
  freq: number;
  amp: number;
  tau: number;
  partials?: number[];
  /** Random detune per partial, fractional. */
  detune?: number;
  /** Each successive partial decays this much faster. */
  damp?: number;
}

/** A struck resonator: shell casings, hull hits, glass, bolt clacks. */
function ringLayer(o: Float32Array, sr: number, rnd: Rand, p: RingOpts): void {
  const parts = p.partials ?? METAL_PARTIALS;
  const damp = p.damp ?? 0.62;
  const det = p.detune ?? 0.012;
  const t0 = Math.max(0, Math.round((p.t0 ?? 0) * sr));
  for (let k = 0; k < parts.length; k++) {
    const f = p.freq * parts[k] * (1 + (rnd() - 0.5) * det);
    if (f > sr * 0.45) continue;
    const tau = Math.max(2e-4, p.tau * Math.pow(damp, k));
    const amp = (p.amp / (1 + k * 0.85)) * (0.7 + rnd() * 0.6);
    const n = Math.min(o.length - t0, Math.ceil(tau * 5 * sr));
    const w = (TWO_PI * f) / sr;
    const ph0 = rnd() * TWO_PI;
    for (let i = 0; i < n; i++) {
      o[t0 + i] += Math.sin(ph0 + w * i) * decay(i / sr, tau) * amp;
    }
  }
}

interface GrainOpts {
  t0?: number;
  dur: number;
  count: number;
  amp: number;
  /** Grain centre frequency range. */
  f0: number;
  f1: number;
  tau: number;
  kind?: "tick" | "ping";
  /** 0 = uniform over the window, 1 = heavily front-loaded. */
  clump?: number;
}

/** Sparse scattered micro-events: debris rain, glass shards, gravel, bubbles. */
function grainLayer(o: Float32Array, sr: number, rnd: Rand, p: GrainOpts): void {
  const base = p.t0 ?? 0;
  const clump = p.clump ?? 0.6;
  for (let g = 0; g < p.count; g++) {
    const r = rnd();
    const u = clump > 0 ? Math.pow(r, 1 + clump * 2) : r;
    const t = base + u * p.dur;
    const amp = p.amp * (0.25 + rnd() * 0.75) * (1 - u * 0.7);
    const f = p.f0 + rnd() * (p.f1 - p.f0);
    if (p.kind === "ping") {
      ringLayer(o, sr, rnd, { t0: t, freq: f, amp, tau: p.tau * (0.5 + rnd()), partials: [1, 2.4], damp: 0.5 });
    } else {
      noiseLayer(o, sr, rnd, {
        t0: t, dur: p.tau * 6, amp, cut0: f * 1.8, cut1: f * 0.5, tau: p.tau * (0.4 + rnd()), res: 1.3, mode: "band",
      });
    }
  }
}

/** Soft saturation. Drives transients into the ceiling instead of clipping them. */
function saturate(o: Float32Array, amount: number): void {
  const k = Math.tanh(amount);
  for (let i = 0; i < o.length; i++) {
    const v = o[i];
    o[i] = Number.isFinite(v) ? Math.tanh(v * amount) / k : 0;
  }
}

/** Peak-normalise so every cue arrives at the mixer at a known level. */
function normalise(o: Float32Array, target: number): void {
  let peak = 0;
  for (let i = 0; i < o.length; i++) {
    const a = Math.abs(o[i]);
    if (a > peak) peak = a;
    if (!Number.isFinite(o[i])) o[i] = 0;
  }
  if (peak < 1e-5) return;
  const g = target / peak;
  for (let i = 0; i < o.length; i++) o[i] *= g;
}

/** Fade the last few ms so a truncated tail never pops. */
function fadeOut(o: Float32Array, sr: number, ms = 6): void {
  const n = Math.min(o.length, Math.round((ms / 1000) * sr));
  for (let i = 0; i < n; i++) o[o.length - 1 - i] *= i / n;
}

// ===========================================================================
// 3. The cue bank
//
// Recipes, not samples. Each one is a stack of the layers above; the comments
// name the physical thing each layer is standing in for, because that is how
// you debug a sound that "feels wrong".
// ===========================================================================

interface GunSpec {
  dur: number;
  /** Muzzle blast: broadband crack, the loudest and shortest part. */
  crackAmp: number;
  crackCut: number;
  crackTau: number;
  /** Chamber body: the sine drop that gives a gun its calibre. */
  bodyAmp: number;
  bodyF0: number;
  bodyF1: number;
  bodyTau: number;
  /** Mechanical action — bolt, hammer, striker. */
  mechAmp: number;
  mechFreq: number;
  /** Environment slapback baked into the cue so even the dry path has depth. */
  tailAmp: number;
  tailTau: number;
  tailCut: number;
  drive: number;
}

/**
 * The anatomy of a gunshot, in order of arrival: a 1 ms transient click (the
 * primer), a broadband crack that collapses in cutoff over ~30 ms (the muzzle
 * blast expanding), a sine sweep for the calibre (the body), a metallic clack
 * (the action), then three delayed and progressively duller noise slaps (the
 * street bouncing it back at you). Drop any one of those and it turns into a
 * cap gun.
 */
function makeGun(s: GunSpec) {
  return (o: Float32Array, sr: number, rnd: Rand) => {
    // Primer strike — pure transient. Sets the perceived attack speed.
    noiseLayer(o, sr, rnd, { dur: 0.012, amp: 0.9, cut0: sr * 0.22, cut1: 4000, tau: 0.0016, atk: 0.00004, mode: "high" });
    // Muzzle blast.
    noiseLayer(o, sr, rnd, { dur: 0.2, amp: s.crackAmp, cut0: s.crackCut, cut1: s.crackCut * 0.14, tau: s.crackTau, res: 1.25, atk: 0.00012 });
    noiseLayer(o, sr, rnd, { dur: 0.14, amp: s.crackAmp * 0.5, cut0: s.crackCut * 1.6, cut1: s.crackCut * 0.6, tau: s.crackTau * 0.55, res: 0.8, mode: "high", atk: 0.00008 });
    // Body — the calibre.
    toneLayer(o, sr, rnd, { dur: Math.min(s.dur, 0.5), amp: s.bodyAmp, f0: s.bodyF0, f1: s.bodyF1, tau: s.bodyTau, atk: 0.0004 });
    toneLayer(o, sr, rnd, { dur: Math.min(s.dur, 0.5), amp: s.bodyAmp * 0.35, f0: s.bodyF0 * 1.98, f1: s.bodyF1 * 1.5, tau: s.bodyTau * 0.6, atk: 0.0004 });
    // Action.
    if (s.mechAmp > 0) {
      ringLayer(o, sr, rnd, { t0: 0.006, freq: s.mechFreq, amp: s.mechAmp, tau: 0.024, damp: 0.55 });
    }
    // Street slapback: three taps, each later, quieter and darker.
    const taps: [number, number][] = [[0.036, 1], [0.089, 0.62], [0.163, 0.34]];
    for (const [t, a] of taps) {
      noiseLayer(o, sr, rnd, {
        t0: t, dur: s.dur - t, amp: s.tailAmp * a, cut0: s.tailCut * a, cut1: s.tailCut * 0.28 * a,
        tau: s.tailTau * (1.6 - a * 0.5), res: 0.7, atk: 0.004,
      });
    }
    saturate(o, s.drive);
    fadeOut(o, sr, 10);
  };
}

/** Impact recipe factory: one function covers every surface the world has. */
function makeImpact(
  thumpF: number, thumpTau: number, thumpAmp: number,
  gritCut: number, gritTau: number, gritAmp: number,
  ring?: { freq: number; amp: number; tau: number; partials?: number[] },
) {
  return (o: Float32Array, sr: number, rnd: Rand) => {
    noiseLayer(o, sr, rnd, { dur: 0.01, amp: 0.55, cut0: sr * 0.2, cut1: 6000, tau: 0.0014, atk: 0.00005, mode: "high" });
    toneLayer(o, sr, rnd, { dur: 0.3, amp: thumpAmp, f0: thumpF, f1: thumpF * 0.5, tau: thumpTau, atk: 0.0006 });
    noiseLayer(o, sr, rnd, { dur: 0.4, amp: gritAmp, cut0: gritCut, cut1: gritCut * 0.2, tau: gritTau, res: 1.05, atk: 0.0002 });
    if (ring) ringLayer(o, sr, rnd, { t0: 0.002, freq: ring.freq, amp: ring.amp, tau: ring.tau, partials: ring.partials });
    saturate(o, 1.5);
    fadeOut(o, sr, 8);
  };
}

/** A dry mechanical clack — the atom of every reload sound. */
function clack(o: Float32Array, sr: number, rnd: Rand, t0: number, amp: number, freq: number, tau = 0.02): void {
  noiseLayer(o, sr, rnd, { t0, dur: 0.03, amp: amp * 0.8, cut0: freq * 3.2, cut1: freq * 0.8, tau: tau * 0.4, res: 1.1, mode: "band", atk: 0.00006 });
  ringLayer(o, sr, rnd, { t0, freq, amp: amp * 0.7, tau, damp: 0.5, partials: [1, 2.4, 4.1] });
  toneLayer(o, sr, rnd, { t0, dur: 0.12, amp: amp * 0.35, f0: freq * 0.16, f1: freq * 0.09, tau: 0.03 });
}

const CUES: Record<string, Cue> = {
  // --- Weapons -------------------------------------------------------------
  pistol: {
    dur: 0.62, gain: 0.85, ref: 12, max: 900, wet: 0.9, prio: 0.8, gap: 0.02, same: 4, travel: true,
    render: makeGun({ dur: 0.62, crackAmp: 0.85, crackCut: 6400, crackTau: 0.026, bodyAmp: 0.5, bodyF0: 205, bodyF1: 64, bodyTau: 0.042, mechAmp: 0.22, mechFreq: 2450, tailAmp: 0.2, tailTau: 0.16, tailCut: 2000, drive: 1.7 }),
  },
  rifle: {
    dur: 0.9, gain: 1, ref: 16, max: 1400, wet: 1.1, prio: 0.85, gap: 0.018, same: 5, travel: true,
    render: makeGun({ dur: 0.9, crackAmp: 1, crackCut: 8200, crackTau: 0.033, bodyAmp: 0.75, bodyF0: 158, bodyF1: 47, bodyTau: 0.058, mechAmp: 0.2, mechFreq: 3150, tailAmp: 0.26, tailTau: 0.26, tailCut: 2400, drive: 2 }),
  },
  shotgun: {
    dur: 1.25, gain: 1.05, ref: 18, max: 1500, wet: 1.2, prio: 0.9, gap: 0.05, same: 3, travel: true,
    render: makeGun({ dur: 1.25, crackAmp: 0.95, crackCut: 5200, crackTau: 0.07, bodyAmp: 1, bodyF0: 118, bodyF1: 33, bodyTau: 0.12, mechAmp: 0.14, mechFreq: 1800, tailAmp: 0.34, tailTau: 0.42, tailCut: 1700, drive: 2.3 }),
  },
  minigun: {
    dur: 0.45, gain: 0.8, ref: 14, max: 1200, wet: 0.8, prio: 0.75, gap: 0.012, same: 6, jitter: 0.09, travel: true,
    render: makeGun({ dur: 0.45, crackAmp: 0.85, crackCut: 9200, crackTau: 0.017, bodyAmp: 0.45, bodyF0: 182, bodyF1: 72, bodyTau: 0.028, mechAmp: 0.3, mechFreq: 4200, tailAmp: 0.16, tailTau: 0.12, tailCut: 2600, drive: 1.8 }),
  },
  rocket: {
    dur: 1.9, gain: 1, ref: 22, max: 1800, wet: 1.2, prio: 0.95, gap: 0.1, same: 2, travel: true,
    render: (o, sr, rnd) => {
      // Ignition crack, then a long pressurised hiss that opens up as the
      // motor leaves the tube — sold by the cutoff *rising* while it fades.
      noiseLayer(o, sr, rnd, { dur: 0.09, amp: 0.9, cut0: 7000, cut1: 900, tau: 0.028, res: 1.2, atk: 0.0002 });
      toneLayer(o, sr, rnd, { dur: 0.6, amp: 0.85, f0: 132, f1: 38, tau: 0.16, atk: 0.001 });
      noiseLayer(o, sr, rnd, { t0: 0.02, dur: 1.6, amp: 0.75, cut0: 480, cut1: 2600, tau: 0.42, res: 0.75, atk: 0.02 });
      noiseLayer(o, sr, rnd, { t0: 0.05, dur: 1.5, amp: 0.4, cut0: 180, cut1: 90, tau: 0.55, atk: 0.03 });
      grainLayer(o, sr, rnd, { t0: 0.03, dur: 0.5, count: 14, amp: 0.18, f0: 1800, f1: 6000, tau: 0.012, kind: "tick" });
      saturate(o, 1.9);
      fadeOut(o, sr, 30);
    },
  },
  railgun: {
    dur: 1.4, gain: 0.95, ref: 20, max: 1600, wet: 1.3, prio: 0.9, gap: 0.08, same: 2, travel: true,
    render: (o, sr, rnd) => {
      // Capacitor dump: an FM'd tone collapsing two octaves, wrapped in
      // electrical crackle, sitting on a sub drop for the recoil.
      toneLayer(o, sr, rnd, { dur: 0.5, amp: 0.9, f0: 2600, f1: 190, tau: 0.11, fm: 420, fmF: 137, atk: 0.0002 });
      toneLayer(o, sr, rnd, { dur: 0.9, amp: 0.8, f0: 96, f1: 27, tau: 0.3, atk: 0.0008 });
      noiseLayer(o, sr, rnd, { dur: 0.35, amp: 0.75, cut0: 9000, cut1: 1200, tau: 0.05, res: 1.5, mode: "band", atk: 0.0001 });
      grainLayer(o, sr, rnd, { t0: 0.01, dur: 0.55, count: 26, amp: 0.3, f0: 2400, f1: 9000, tau: 0.008, kind: "tick" });
      noiseLayer(o, sr, rnd, { t0: 0.09, dur: 1.2, amp: 0.22, cut0: 1600, cut1: 300, tau: 0.4, res: 0.8, atk: 0.01 });
      saturate(o, 2.1);
      fadeOut(o, sr, 20);
    },
  },

  // --- Explosions ----------------------------------------------------------
  explosion: {
    dur: 3.6, gain: 1.15, ref: 45, max: 2600, roll: 0.62, wet: 1.6, prio: 1, gap: 0.03, same: 4, travel: true, variants: 3,
    render: (o, sr, rnd) => {
      // Detonation front.
      noiseLayer(o, sr, rnd, { dur: 0.02, amp: 0.9, cut0: sr * 0.22, cut1: 5000, tau: 0.003, atk: 0.00004, mode: "high" });
      noiseLayer(o, sr, rnd, { dur: 0.35, amp: 1, cut0: 9500, cut1: 1100, tau: 0.055, res: 1.2, atk: 0.00015 });
      // Fireball body — the cutoff collapse *is* the expanding gas.
      noiseLayer(o, sr, rnd, { dur: 1.4, amp: 1, cut0: 2600, cut1: 150, tau: 0.36, res: 1.1, atk: 0.0012 });
      // Sub drop. Felt more than heard, and the reason near blasts read as big.
      toneLayer(o, sr, rnd, { dur: 1.2, amp: 0.95, f0: 98, f1: 24, tau: 0.5, atk: 0.0025 });
      toneLayer(o, sr, rnd, { t0: 0.05, dur: 1.4, amp: 0.4, f0: 56, f1: 19, tau: 0.75, atk: 0.02 });
      // Delayed rumble — the ground and the buildings answering back.
      noiseLayer(o, sr, rnd, { t0: 0.11, dur: 2.6, amp: 0.55, cut0: 260, cut1: 62, tau: 1.15, res: 0.7, atk: 0.05 });
      noiseLayer(o, sr, rnd, { t0: 0.38, dur: 3, amp: 0.3, cut0: 520, cut1: 95, tau: 1.7, res: 0.6, atk: 0.14 });
      // Debris rain.
      grainLayer(o, sr, rnd, { t0: 0.14, dur: 1.5, count: 46, amp: 0.2, f0: 400, f1: 4200, tau: 0.015, kind: "tick", clump: 0.9 });
      saturate(o, 2.2);
      fadeOut(o, sr, 60);
    },
  },
  debris: {
    dur: 1.6, gain: 0.6, ref: 14, max: 500, wet: 1, prio: 0.4, gap: 0.04, same: 3,
    render: (o, sr, rnd) => {
      grainLayer(o, sr, rnd, { dur: 1.3, count: 34, amp: 0.55, f0: 300, f1: 3200, tau: 0.02, kind: "tick", clump: 1.2 });
      noiseLayer(o, sr, rnd, { dur: 0.9, amp: 0.35, cut0: 1400, cut1: 220, tau: 0.3, res: 0.8, atk: 0.004 });
      fadeOut(o, sr, 20);
    },
  },

  // --- Impacts by material -------------------------------------------------
  impact_concrete: { dur: 0.5, gain: 0.7, ref: 8, max: 260, prio: 0.5, gap: 0.02, same: 4, render: makeImpact(150, 0.045, 0.5, 3400, 0.075, 0.75) },
  impact_metal: {
    dur: 0.6, gain: 0.7, ref: 8, max: 300, prio: 0.55, gap: 0.02, same: 4,
    render: makeImpact(240, 0.03, 0.3, 6800, 0.03, 0.55, { freq: 1720, amp: 0.5, tau: 0.16 }),
  },
  impact_wood: {
    dur: 0.45, gain: 0.68, ref: 8, max: 220, prio: 0.45, gap: 0.02, same: 4,
    render: makeImpact(320, 0.06, 0.6, 2400, 0.05, 0.45, { freq: 470, amp: 0.28, tau: 0.09, partials: [1, 2.1, 3.4] }),
  },
  impact_dirt: { dur: 0.4, gain: 0.6, ref: 7, max: 180, prio: 0.4, gap: 0.02, same: 4, render: makeImpact(96, 0.07, 0.55, 950, 0.11, 0.6) },
  impact_water: {
    dur: 0.7, gain: 0.62, ref: 8, max: 220, prio: 0.4, gap: 0.03, same: 3,
    render: (o, sr, rnd) => {
      // A "bloop" is a rising resonance, not a falling one — the cavity closes.
      toneLayer(o, sr, rnd, { dur: 0.16, amp: 0.5, f0: 280, f1: 980, tau: 0.05, atk: 0.001 });
      noiseLayer(o, sr, rnd, { dur: 0.45, amp: 0.8, cut0: 2200, cut1: 320, tau: 0.11, res: 1.1, atk: 0.0004 });
      grainLayer(o, sr, rnd, { t0: 0.04, dur: 0.4, count: 10, amp: 0.2, f0: 700, f1: 2600, tau: 0.012, kind: "ping" });
      fadeOut(o, sr, 10);
    },
  },
  impact_glass: {
    dur: 0.9, gain: 0.72, ref: 8, max: 280, prio: 0.5, gap: 0.02, same: 4,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.1, amp: 0.7, cut0: 9000, cut1: 2600, tau: 0.03, res: 1.2, mode: "high", atk: 0.00006 });
      grainLayer(o, sr, rnd, { dur: 0.7, count: 22, amp: 0.6, f0: 2600, f1: 8200, tau: 0.05, kind: "ping", clump: 0.9 });
      toneLayer(o, sr, rnd, { dur: 0.15, amp: 0.25, f0: 210, f1: 120, tau: 0.04 });
      fadeOut(o, sr, 12);
    },
  },
  impact_flesh: {
    dur: 0.4, gain: 0.75, ref: 6, max: 160, prio: 0.6, gap: 0.02, same: 4,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.22, amp: 0.85, cut0: 1500, cut1: 190, tau: 0.045, res: 1.35, atk: 0.0003 });
      toneLayer(o, sr, rnd, { dur: 0.2, amp: 0.6, f0: 172, f1: 62, tau: 0.05, atk: 0.0008 });
      saturate(o, 1.6);
      fadeOut(o, sr, 8);
    },
  },
  ricochet: {
    dur: 0.85, gain: 0.55, ref: 9, max: 340, wet: 1.3, prio: 0.45, gap: 0.03, same: 3, jitter: 0.16,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.02, amp: 0.6, cut0: 8000, cut1: 3000, tau: 0.004, mode: "high", atk: 0.00005 });
      // The whistle: a high resonant band falling away with vibrato on it.
      toneLayer(o, sr, rnd, { dur: 0.6, amp: 0.55, f0: 3600 + rnd() * 1800, f1: 700, tau: 0.22, vib: 0.05, vibF: 17, atk: 0.004 });
      noiseLayer(o, sr, rnd, { dur: 0.6, amp: 0.45, cut0: 4200, cut1: 900, tau: 0.2, res: 2.6, mode: "band", atk: 0.003 });
      fadeOut(o, sr, 14);
    },
  },

  // --- Weapon mechanics ----------------------------------------------------
  shellDrop: {
    dur: 0.6, gain: 0.4, ref: 5, max: 90, prio: 0.2, gap: 0.015, same: 4, jitter: 0.2,
    render: (o, sr, rnd) => {
      // A casing bounces two or three times, faster and quieter each time.
      let t = 0;
      let amp = 0.9;
      const bounces = 2 + Math.floor(rnd() * 2);
      for (let i = 0; i <= bounces; i++) {
        ringLayer(o, sr, rnd, { t0: t, freq: 2400 + rnd() * 2600, amp, tau: 0.035 * (1 - i * 0.2), partials: [1, 2.9, 6.1], damp: 0.45 });
        noiseLayer(o, sr, rnd, { t0: t, dur: 0.02, amp: amp * 0.5, cut0: 7000, cut1: 2200, tau: 0.004, mode: "band", atk: 0.00005 });
        t += 0.05 + rnd() * 0.09;
        amp *= 0.55;
      }
      fadeOut(o, sr, 10);
    },
  },
  magOut: {
    dur: 0.4, gain: 0.55, ref: 4, max: 60, prio: 0.3, render: (o, sr, rnd) => {
      clack(o, sr, rnd, 0, 0.7, 1900, 0.018);
      ringLayer(o, sr, rnd, { t0: 0.03, freq: 1250, amp: 0.3, tau: 0.06, partials: [1, 3.2] });
      noiseLayer(o, sr, rnd, { t0: 0.05, dur: 0.14, amp: 0.25, cut0: 3000, cut1: 900, tau: 0.05, res: 1.4, mode: "band", atk: 0.002 });
      fadeOut(o, sr, 8);
    },
  },
  magIn: {
    dur: 0.45, gain: 0.6, ref: 4, max: 60, prio: 0.3, render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.1, amp: 0.3, cut0: 1400, cut1: 500, tau: 0.03, res: 1.1, mode: "band", atk: 0.003 });
      clack(o, sr, rnd, 0.06, 0.95, 1150, 0.03);
      clack(o, sr, rnd, 0.15, 0.4, 2600, 0.012);
      saturate(o, 1.3);
      fadeOut(o, sr, 8);
    },
  },
  boltBack: {
    dur: 0.55, gain: 0.55, ref: 4, max: 70, prio: 0.3, render: (o, sr, rnd) => {
      // Slide travel, hard stop, spring return.
      noiseLayer(o, sr, rnd, { dur: 0.11, amp: 0.35, cut0: 2200, cut1: 3600, tau: 0.07, res: 1.8, mode: "band", atk: 0.006 });
      clack(o, sr, rnd, 0.1, 0.9, 2100, 0.02);
      clack(o, sr, rnd, 0.26, 0.75, 1650, 0.026);
      fadeOut(o, sr, 8);
    },
  },
  pump: {
    dur: 0.6, gain: 0.62, ref: 5, max: 80, prio: 0.35, render: (o, sr, rnd) => {
      clack(o, sr, rnd, 0, 0.9, 1350, 0.03);
      noiseLayer(o, sr, rnd, { t0: 0.03, dur: 0.1, amp: 0.3, cut0: 1800, cut1: 2800, tau: 0.06, res: 1.6, mode: "band", atk: 0.005 });
      clack(o, sr, rnd, 0.17, 1, 1050, 0.035);
      saturate(o, 1.4);
      fadeOut(o, sr, 8);
    },
  },
  dryFire: {
    dur: 0.16, gain: 0.45, ref: 3, max: 40, prio: 0.25, render: (o, sr, rnd) => {
      clack(o, sr, rnd, 0, 0.7, 3100, 0.008);
      fadeOut(o, sr, 5);
    },
  },
  weaponSwitch: {
    dur: 0.45, gain: 0.5, ref: 3, max: 40, prio: 0.3, render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.2, amp: 0.4, cut0: 900, cut1: 260, tau: 0.09, res: 0.8, atk: 0.008 });
      clack(o, sr, rnd, 0.13, 0.6, 1800, 0.016);
      fadeOut(o, sr, 8);
    },
  },
  spinUp: {
    dur: 1.0, gain: 0.5, ref: 6, max: 140, prio: 0.5, jitter: 0.03, render: (o, sr, rnd) => {
      // Barrel motor: a saw stack climbing an octave and a half, plus whir.
      toneLayer(o, sr, rnd, { dur: 0.95, amp: 0.45, f0: 58, f1: 380, tau: 3, shape: "saw", atk: 0.05 });
      toneLayer(o, sr, rnd, { dur: 0.95, amp: 0.2, f0: 174, f1: 1140, tau: 3, shape: "tri", atk: 0.08 });
      noiseLayer(o, sr, rnd, { dur: 0.95, amp: 0.3, cut0: 700, cut1: 3400, tau: 3, res: 1.4, mode: "band", atk: 0.06 });
      for (let i = 0; i < 12; i++) noiseLayer(o, sr, rnd, { t0: i * 0.075, dur: 0.02, amp: 0.1 + i * 0.012, cut0: 4000, cut1: 1500, tau: 0.004, mode: "band" });
      fadeOut(o, sr, 25);
    },
  },
  spinDown: {
    dur: 1.2, gain: 0.45, ref: 6, max: 140, prio: 0.4, jitter: 0.03, render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 1.15, amp: 0.45, f0: 380, f1: 42, tau: 0.9, shape: "saw", atk: 0.01 });
      noiseLayer(o, sr, rnd, { dur: 1.15, amp: 0.28, cut0: 3200, cut1: 400, tau: 0.7, res: 1.3, mode: "band", atk: 0.01 });
      fadeOut(o, sr, 30);
    },
  },
  railCharge: {
    dur: 0.95, gain: 0.55, ref: 6, max: 160, prio: 0.5, jitter: 0.02, render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.9, amp: 0.5, f0: 210, f1: 2100, tau: 4, atk: 0.04, fm: 40, fmF: 61 });
      toneLayer(o, sr, rnd, { dur: 0.9, amp: 0.22, f0: 420, f1: 4200, tau: 4, atk: 0.12 });
      noiseLayer(o, sr, rnd, { dur: 0.9, amp: 0.2, cut0: 1200, cut1: 8000, tau: 4, res: 1.7, mode: "band", atk: 0.15 });
      grainLayer(o, sr, rnd, { t0: 0.35, dur: 0.55, count: 16, amp: 0.14, f0: 3000, f1: 9000, tau: 0.006, kind: "tick", clump: -0.4 });
      fadeOut(o, sr, 18);
    },
  },

  // --- Movement ------------------------------------------------------------
  step_stone: {
    dur: 0.3, gain: 0.36, ref: 3, max: 60, prio: 0.2, gap: 0.06, same: 3, jitter: 0.13,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.16, amp: 0.7, cut0: 4200, cut1: 800, tau: 0.028, res: 1.15, atk: 0.0004 });
      toneLayer(o, sr, rnd, { dur: 0.14, amp: 0.35, f0: 118, f1: 68, tau: 0.045 });
      grainLayer(o, sr, rnd, { t0: 0.01, dur: 0.09, count: 5, amp: 0.12, f0: 2200, f1: 6000, tau: 0.004, kind: "tick" });
      fadeOut(o, sr, 8);
    },
  },
  step_sand: {
    dur: 0.34, gain: 0.32, ref: 3, max: 45, prio: 0.2, gap: 0.06, same: 3, jitter: 0.15,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.24, amp: 0.75, cut0: 2600, cut1: 480, tau: 0.075, res: 0.7, atk: 0.004 });
      toneLayer(o, sr, rnd, { dur: 0.12, amp: 0.18, f0: 88, f1: 54, tau: 0.05 });
      fadeOut(o, sr, 10);
    },
  },
  step_grass: {
    dur: 0.34, gain: 0.32, ref: 3, max: 45, prio: 0.2, gap: 0.06, same: 3, jitter: 0.15,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.26, amp: 0.6, cut0: 5600, cut1: 1400, tau: 0.06, res: 0.9, mode: "band", atk: 0.003 });
      grainLayer(o, sr, rnd, { dur: 0.18, count: 9, amp: 0.22, f0: 3000, f1: 8000, tau: 0.005, kind: "tick" });
      toneLayer(o, sr, rnd, { dur: 0.12, amp: 0.2, f0: 96, f1: 58, tau: 0.045 });
      fadeOut(o, sr, 10);
    },
  },
  step_dirt: {
    dur: 0.3, gain: 0.34, ref: 3, max: 50, prio: 0.2, gap: 0.06, same: 3, jitter: 0.14,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.2, amp: 0.7, cut0: 1600, cut1: 340, tau: 0.05, res: 0.85, atk: 0.001 });
      toneLayer(o, sr, rnd, { dur: 0.14, amp: 0.3, f0: 102, f1: 60, tau: 0.05 });
      fadeOut(o, sr, 8);
    },
  },
  step_metal: {
    dur: 0.4, gain: 0.34, ref: 3, max: 70, prio: 0.2, gap: 0.06, same: 3, jitter: 0.12,
    render: (o, sr, rnd) => {
      ringLayer(o, sr, rnd, { freq: 880, amp: 0.5, tau: 0.09, damp: 0.55 });
      noiseLayer(o, sr, rnd, { dur: 0.1, amp: 0.5, cut0: 6000, cut1: 1600, tau: 0.014, mode: "band", atk: 0.0002 });
      toneLayer(o, sr, rnd, { dur: 0.12, amp: 0.22, f0: 130, f1: 74, tau: 0.04 });
      fadeOut(o, sr, 8);
    },
  },
  step_wood: {
    dur: 0.34, gain: 0.34, ref: 3, max: 55, prio: 0.2, gap: 0.06, same: 3, jitter: 0.13,
    render: (o, sr, rnd) => {
      ringLayer(o, sr, rnd, { freq: 340, amp: 0.45, tau: 0.055, partials: [1, 2.2, 3.7], damp: 0.5 });
      noiseLayer(o, sr, rnd, { dur: 0.12, amp: 0.45, cut0: 2800, cut1: 700, tau: 0.02, res: 1.1, atk: 0.0004 });
      fadeOut(o, sr, 8);
    },
  },
  step_water: {
    dur: 0.45, gain: 0.38, ref: 3, max: 55, prio: 0.2, gap: 0.06, same: 3, jitter: 0.16,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.3, amp: 0.7, cut0: 3200, cut1: 500, tau: 0.07, res: 0.9, atk: 0.002 });
      toneLayer(o, sr, rnd, { dur: 0.12, amp: 0.25, f0: 340, f1: 720, tau: 0.04, atk: 0.002 });
      grainLayer(o, sr, rnd, { t0: 0.03, dur: 0.2, count: 8, amp: 0.15, f0: 900, f1: 3000, tau: 0.008, kind: "ping" });
      fadeOut(o, sr, 10);
    },
  },
  jump: {
    dur: 0.35, gain: 0.4, ref: 3, max: 45, prio: 0.3, jitter: 0.1,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.22, amp: 0.5, cut0: 1800, cut1: 420, tau: 0.07, res: 0.7, atk: 0.006 });
      toneLayer(o, sr, rnd, { dur: 0.16, amp: 0.35, f0: 140, f1: 82, tau: 0.05 });
      fadeOut(o, sr, 8);
    },
  },
  land: {
    dur: 0.6, gain: 0.6, ref: 4, max: 90, prio: 0.5, jitter: 0.08,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.3, amp: 0.9, f0: 132, f1: 46, tau: 0.09, atk: 0.0008 });
      noiseLayer(o, sr, rnd, { dur: 0.3, amp: 0.6, cut0: 2600, cut1: 380, tau: 0.06, res: 1, atk: 0.0006 });
      grainLayer(o, sr, rnd, { t0: 0.02, dur: 0.18, count: 8, amp: 0.16, f0: 1600, f1: 5000, tau: 0.005, kind: "tick" });
      saturate(o, 1.5);
      fadeOut(o, sr, 10);
    },
  },
  splash_in: {
    dur: 1.5, gain: 0.85, ref: 6, max: 260, wet: 1.1, prio: 0.6,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.5, amp: 1, cut0: 4200, cut1: 320, tau: 0.14, res: 1.05, atk: 0.0008 });
      toneLayer(o, sr, rnd, { dur: 0.4, amp: 0.5, f0: 160, f1: 60, tau: 0.12 });
      noiseLayer(o, sr, rnd, { t0: 0.1, dur: 1, amp: 0.35, cut0: 900, cut1: 200, tau: 0.36, res: 0.8, atk: 0.02 });
      grainLayer(o, sr, rnd, { t0: 0.08, dur: 0.9, count: 24, amp: 0.22, f0: 600, f1: 3400, tau: 0.012, kind: "ping", clump: 1 });
      fadeOut(o, sr, 20);
    },
  },
  splash_out: {
    dur: 1.1, gain: 0.7, ref: 6, max: 200, wet: 1.1, prio: 0.5,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.6, amp: 0.9, cut0: 1800, cut1: 3200, tau: 0.18, res: 0.8, atk: 0.01 });
      grainLayer(o, sr, rnd, { t0: 0.05, dur: 0.7, count: 20, amp: 0.25, f0: 800, f1: 4200, tau: 0.01, kind: "ping" });
      fadeOut(o, sr, 16);
    },
  },
  swim: {
    dur: 0.9, gain: 0.4, ref: 4, max: 60, prio: 0.2, gap: 0.2, jitter: 0.14,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.6, amp: 0.7, cut0: 1400, cut1: 380, tau: 0.16, res: 0.75, atk: 0.03 });
      grainLayer(o, sr, rnd, { t0: 0.05, dur: 0.4, count: 10, amp: 0.16, f0: 500, f1: 2200, tau: 0.01, kind: "ping" });
      fadeOut(o, sr, 12);
    },
  },
  whoosh: {
    dur: 0.8, gain: 0.5, ref: 5, max: 120, prio: 0.35, jitter: 0.12,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.7, amp: 0.8, cut0: 400, cut1: 2600, tau: 0.22, res: 1.5, mode: "band", atk: 0.05 });
      noiseLayer(o, sr, rnd, { t0: 0.16, dur: 0.5, amp: 0.4, cut0: 2600, cut1: 500, tau: 0.14, res: 1.4, mode: "band", atk: 0.02 });
      fadeOut(o, sr, 14);
    },
  },
  grapple_fire: {
    dur: 0.7, gain: 0.6, ref: 4, max: 110, prio: 0.6,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.05, amp: 0.9, cut0: 6000, cut1: 1400, tau: 0.012, res: 1.3, atk: 0.0001 });
      toneLayer(o, sr, rnd, { dur: 0.25, amp: 0.5, f0: 380, f1: 90, tau: 0.06 });
      noiseLayer(o, sr, rnd, { t0: 0.03, dur: 0.6, amp: 0.4, cut0: 1800, cut1: 5200, tau: 0.2, res: 1.9, mode: "band", atk: 0.01 });
      saturate(o, 1.6);
      fadeOut(o, sr, 10);
    },
  },
  grapple_hit: {
    dur: 0.5, gain: 0.6, ref: 4, max: 110, prio: 0.6,
    render: (o, sr, rnd) => {
      clack(o, sr, rnd, 0, 1, 1450, 0.04);
      ringLayer(o, sr, rnd, { t0: 0.004, freq: 2600, amp: 0.35, tau: 0.09 });
      noiseLayer(o, sr, rnd, { t0: 0.02, dur: 0.3, amp: 0.25, cut0: 3200, cut1: 900, tau: 0.09, res: 1.4, mode: "band", atk: 0.004 });
      fadeOut(o, sr, 10);
    },
  },
  chute: {
    dur: 1.3, gain: 0.65, ref: 4, max: 90, prio: 0.6,
    render: (o, sr, rnd) => {
      // Canopy snap: cloth crack, then the flap settling.
      noiseLayer(o, sr, rnd, { dur: 0.12, amp: 0.9, cut0: 3800, cut1: 700, tau: 0.035, res: 0.9, atk: 0.0006 });
      for (let i = 0; i < 5; i++) {
        noiseLayer(o, sr, rnd, { t0: 0.12 + i * 0.17, dur: 0.2, amp: 0.42 - i * 0.06, cut0: 2200 - i * 260, cut1: 500, tau: 0.06, res: 0.8, atk: 0.008 });
      }
      fadeOut(o, sr, 20);
    },
  },

  // --- UI / feedback -------------------------------------------------------
  hitmarker: {
    dur: 0.14, gain: 0.5, bus: "ui", prio: 0.9, gap: 0.02, same: 3,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.06, amp: 0.8, f0: 2050, f1: 1900, tau: 0.014, atk: 0.0003 });
      toneLayer(o, sr, rnd, { t0: 0.022, dur: 0.07, amp: 0.6, f0: 2950, f1: 2800, tau: 0.016, atk: 0.0003 });
      fadeOut(o, sr, 5);
    },
  },
  hitmarker_kill: {
    dur: 0.4, gain: 0.6, bus: "ui", prio: 1, gap: 0.05,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.1, amp: 0.8, f0: 3100, f1: 3050, tau: 0.02, atk: 0.0003 });
      toneLayer(o, sr, rnd, { t0: 0.05, dur: 0.12, amp: 0.7, f0: 2300, f1: 2250, tau: 0.03, atk: 0.0004 });
      toneLayer(o, sr, rnd, { t0: 0.11, dur: 0.25, amp: 0.6, f0: 1520, f1: 1480, tau: 0.06, atk: 0.0006 });
      fadeOut(o, sr, 8);
    },
  },
  damage: {
    dur: 0.8, gain: 0.75, bus: "ui", prio: 1, gap: 0.08, stereo: true,
    render: (o, sr, rnd) => {
      // A tritone under a distorted noise slap — dissonance reads as "bad"
      // faster than any amount of volume.
      toneLayer(o, sr, rnd, { dur: 0.5, amp: 0.7, f0: 92, f1: 74, tau: 0.2, atk: 0.001 });
      toneLayer(o, sr, rnd, { dur: 0.5, amp: 0.4, f0: 131, f1: 104, tau: 0.16, atk: 0.001 });
      noiseLayer(o, sr, rnd, { dur: 0.3, amp: 0.55, cut0: 2200, cut1: 260, tau: 0.05, res: 1.2, atk: 0.0004 });
      saturate(o, 2);
      fadeOut(o, sr, 14);
    },
  },
  death: {
    dur: 2.6, gain: 0.85, bus: "ui", prio: 1, stereo: true,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 2.4, amp: 0.8, f0: 128, f1: 31, tau: 1.1, atk: 0.006 });
      toneLayer(o, sr, rnd, { dur: 2.4, amp: 0.35, f0: 192, f1: 46, tau: 0.9, atk: 0.02 });
      noiseLayer(o, sr, rnd, { dur: 2.2, amp: 0.3, cut0: 1600, cut1: 120, tau: 0.8, res: 0.8, atk: 0.01 });
      fadeOut(o, sr, 60);
    },
  },
  heartbeat: {
    dur: 1.0, gain: 0.9, bus: "ui", prio: 0.8, gap: 0.3,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.35, amp: 0.9, f0: 54, f1: 27, tau: 0.1, atk: 0.004 });
      toneLayer(o, sr, rnd, { t0: 0.27, dur: 0.35, amp: 0.6, f0: 46, f1: 24, tau: 0.075, atk: 0.004 });
      noiseLayer(o, sr, rnd, { dur: 0.1, amp: 0.12, cut0: 220, cut1: 70, tau: 0.04, atk: 0.003 });
      fadeOut(o, sr, 20);
    },
  },
  pickup: {
    dur: 0.4, gain: 0.5, bus: "ui", prio: 0.7,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.16, amp: 0.6, f0: 880, f1: 900, tau: 0.05, atk: 0.001 });
      toneLayer(o, sr, rnd, { t0: 0.07, dur: 0.28, amp: 0.55, f0: 1320, f1: 1340, tau: 0.09, atk: 0.001 });
      fadeOut(o, sr, 8);
    },
  },
  ui_tick: {
    dur: 0.09, gain: 0.35, bus: "ui", prio: 0.6, gap: 0.02,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.05, amp: 0.7, f0: 1700, f1: 1650, tau: 0.011, atk: 0.0002 });
      fadeOut(o, sr, 4);
    },
  },

  // --- Distant world texture (scheduled by the ambience director) ----------
  gull: {
    dur: 1.4, gain: 0.42, ref: 25, max: 700, roll: 0.7, wet: 1.4, prio: 0.3, jitter: 0.14,
    render: (o, sr, rnd) => {
      // Two or three descending squawks. Formant band + saw = seabird.
      let t = 0;
      const calls = 2 + Math.floor(rnd() * 2);
      for (let i = 0; i < calls; i++) {
        const f = 900 + rnd() * 400;
        toneLayer(o, sr, rnd, { t0: t, dur: 0.3, amp: 0.7 - i * 0.12, f0: f * 1.35, f1: f * 0.7, tau: 0.085, shape: "saw", vib: 0.06, vibF: 24, atk: 0.008 });
        noiseLayer(o, sr, rnd, { t0: t, dur: 0.28, amp: 0.2, cut0: f * 3, cut1: f * 1.4, tau: 0.07, res: 2.2, mode: "band", atk: 0.01 });
        t += 0.28 + rnd() * 0.22;
      }
      fadeOut(o, sr, 20);
    },
  },
  bird: {
    dur: 0.9, gain: 0.3, ref: 18, max: 260, wet: 1.2, prio: 0.2, jitter: 0.18,
    render: (o, sr, rnd) => {
      let t = 0;
      const n = 3 + Math.floor(rnd() * 4);
      for (let i = 0; i < n; i++) {
        const f = 3200 + rnd() * 2600;
        toneLayer(o, sr, rnd, { t0: t, dur: 0.09, amp: 0.6, f0: f, f1: f * (0.6 + rnd() * 0.9), tau: 0.022, atk: 0.002 });
        t += 0.06 + rnd() * 0.1;
      }
      fadeOut(o, sr, 12);
    },
  },
  boathorn: {
    dur: 2.8, gain: 0.5, ref: 90, max: 2400, roll: 0.5, wet: 1.6, prio: 0.35, jitter: 0.05,
    render: (o, sr, rnd) => {
      // Two detuned low reeds beating against each other.
      toneLayer(o, sr, rnd, { dur: 2.6, amp: 0.6, f0: 108, f1: 104, tau: 2.4, shape: "saw", atk: 0.12 });
      toneLayer(o, sr, rnd, { dur: 2.6, amp: 0.45, f0: 163, f1: 158, tau: 2.2, shape: "saw", atk: 0.16 });
      toneLayer(o, sr, rnd, { dur: 2.6, amp: 0.2, f0: 54, f1: 52, tau: 2.4, atk: 0.2 });
      noiseLayer(o, sr, rnd, { dur: 2.6, amp: 0.08, cut0: 900, cut1: 400, tau: 2, res: 1, atk: 0.3 });
      saturate(o, 1.4);
      fadeOut(o, sr, 120);
    },
  },
  siren: {
    dur: 3.6, gain: 0.32, ref: 70, max: 1600, roll: 0.6, wet: 1.7, prio: 0.25, jitter: 0.04,
    render: (o, sr, rnd) => {
      // Two-tone wail, alternating every ~0.45 s.
      for (let i = 0; i < 8; i++) {
        const hi = i % 2 === 0;
        toneLayer(o, sr, rnd, {
          t0: i * 0.44, dur: 0.46, amp: 0.55, f0: hi ? 840 : 610, f1: hi ? 830 : 604,
          tau: 1.4, shape: "saw", atk: 0.03,
        });
      }
      fadeOut(o, sr, 80);
    },
  },
  horn: {
    dur: 0.9, gain: 0.45, ref: 20, max: 600, wet: 1.3, prio: 0.3, jitter: 0.08,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.75, amp: 0.6, f0: 420, f1: 415, tau: 0.7, shape: "saw", atk: 0.012 });
      toneLayer(o, sr, rnd, { dur: 0.75, amp: 0.35, f0: 512, f1: 506, tau: 0.7, shape: "saw", atk: 0.015 });
      saturate(o, 1.5);
      fadeOut(o, sr, 25);
    },
  },
  distant_fire: {
    dur: 1.6, gain: 0.3, ref: 200, max: 2200, roll: 0.45, wet: 1.8, prio: 0.2, jitter: 0.1,
    render: (o, sr, rnd) => {
      // A firefight a district away: already low-passed and smeared.
      let t = 0;
      const shots = 3 + Math.floor(rnd() * 5);
      for (let i = 0; i < shots; i++) {
        noiseLayer(o, sr, rnd, { t0: t, dur: 0.4, amp: 0.7, cut0: 900, cut1: 180, tau: 0.09, res: 1.1, atk: 0.002 });
        toneLayer(o, sr, rnd, { t0: t, dur: 0.25, amp: 0.3, f0: 90, f1: 44, tau: 0.06 });
        t += 0.09 + rnd() * 0.14;
      }
      fadeOut(o, sr, 30);
    },
  },

  // --- The safety net ------------------------------------------------------
  generic: {
    dur: 0.3, gain: 0.4, ref: 6, max: 140, prio: 0.3,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.2, amp: 0.6, cut0: 2400, cut1: 400, tau: 0.05, res: 0.9, atk: 0.0006 });
      toneLayer(o, sr, rnd, { dur: 0.16, amp: 0.4, f0: 180, f1: 90, tau: 0.05 });
      fadeOut(o, sr, 8);
    },
  },
};

/** Hand-written aliases for names other modules already call. */
const ALIASES: Record<string, string> = {
  gunshot: "rifle", shoot: "rifle", fire: "rifle", smg: "rifle", ar: "rifle",
  sniper: "railgun", rail: "railgun", launcher: "rocket", rpg: "rocket",
  explode: "explosion", blast: "explosion", boom: "explosion", grenade: "explosion",
  impact: "impact_concrete", hit: "impact_concrete", bullet_hit: "impact_concrete",
  reload: "magIn", magazine: "magIn", bolt: "boltBack", cock: "boltBack",
  footstep: "step_stone", step: "step_stone", walk: "step_stone", run: "step_stone",
  splash: "splash_in", water: "splash_in", dive: "splash_in",
  click: "ui_tick", ui: "ui_tick", beep: "ui_tick", select: "ui_tick",
  hurt: "damage", pain: "damage", die: "death", killed: "death",
  land_hard: "land", thud: "land", crash: "impact_metal", clang: "impact_metal",
  glass: "impact_glass", wood: "impact_wood", metal: "impact_metal", dirt: "impact_dirt",
  flesh: "impact_flesh", blood: "impact_flesh",
  grapple: "grapple_fire", hook: "grapple_fire", zipline: "whoosh",
  wingsuit: "whoosh", parachute: "chute", chute_open: "chute",
  engine: "generic", vehicle: "generic", skid: "generic", tyre: "generic",
  ricochet_metal: "ricochet", whizz: "ricochet", shell: "shellDrop", casing: "shellDrop",
  kill: "hitmarker_kill", headshot: "hitmarker_kill", hitmarkerKill: "hitmarker_kill",
};

/**
 * Resolve an arbitrary cue name to something we can actually play. Other
 * modules ship before this bank does and will ask for names that don't exist;
 * silence is a worse bug than an approximate sound, so we always land on
 * *something*. Results are memoised — the fuzzy path only runs once per name.
 */
const resolveCache = new Map<string, string>();
function resolveCue(name: string): string {
  const cached = resolveCache.get(name);
  if (cached) return cached;
  let key = "generic";
  if (CUES[name]) key = name;
  else if (ALIASES[name]) key = ALIASES[name];
  else {
    const n = name.toLowerCase().replace(/[\s-]+/g, "_");
    if (CUES[n]) key = n;
    else if (ALIASES[n]) key = ALIASES[n];
    else if (n.includes("explo") || n.includes("blast") || n.includes("boom")) key = "explosion";
    else if (n.includes("rocket") || n.includes("missile")) key = "rocket";
    else if (n.includes("shotgun")) key = "shotgun";
    else if (n.includes("pistol")) key = "pistol";
    else if (n.includes("minigun") || n.includes("gatling")) key = "minigun";
    else if (n.includes("rail")) key = "railgun";
    else if (n.includes("shot") || n.includes("gun") || n.includes("fire")) key = "rifle";
    else if (n.includes("step") || n.includes("foot")) key = "step_stone";
    else if (n.includes("glass")) key = "impact_glass";
    else if (n.includes("metal") || n.includes("clang")) key = "impact_metal";
    else if (n.includes("wood")) key = "impact_wood";
    else if (n.includes("water") || n.includes("splash")) key = "splash_in";
    else if (n.includes("impact") || n.includes("hit")) key = "impact_concrete";
    else if (n.includes("rico")) key = "ricochet";
    else if (n.includes("shell") || n.includes("casing")) key = "shellDrop";
    else if (n.includes("mag") || n.includes("reload")) key = "magIn";
    else if (n.includes("click") || n.includes("ui") || n.includes("menu")) key = "ui_tick";
    else if (n.includes("whoosh") || n.includes("wind") || n.includes("swoosh")) key = "whoosh";
    else if (n.includes("horn")) key = "horn";
    else if (n.includes("siren") || n.includes("alarm")) key = "siren";
    else if (n.includes("jump")) key = "jump";
    else if (n.includes("land")) key = "land";
    else if (n.includes("damage") || n.includes("hurt")) key = "damage";
  }
  resolveCache.set(name, key);
  return key;
}

// ===========================================================================
// 4. Ambience beds
//
// Long seamless loops, rendered at a reduced sample rate (they're all
// low-band texture) and crossfaded by the director in section 9.
// ===========================================================================

interface Bed {
  dur: number;
  /** Nominal gain when fully faded in. */
  gain: number;
  /** Starting lowpass cutoff; the director moves it with distance/altitude. */
  cut: number;
  render(o: Float32Array, sr: number, rnd: Rand): void;
}

const BEDS: Record<string, Bed> = {
  /** Pacific surf: overlapping swells, each one a slow noise crescendo. */
  surf: {
    dur: 11, gain: 0.5, cut: 2600,
    render: (o, sr, rnd) => {
      const n = o.length;
      // Bed of broadband wash so the gaps between breakers aren't silent.
      noiseLayer(o, sr, rnd, { dur: n / sr, amp: 0.22, cut0: 700, cut1: 620, tau: 1e6, res: 0.6, atk: 0.5 });
      noiseLayer(o, sr, rnd, { dur: n / sr, amp: 0.16, cut0: 150, cut1: 130, tau: 1e6, res: 0.7, atk: 0.8 });
      // Individual breakers: sharp-ish rise, long hiss-out.
      for (let i = 0; i < 9; i++) {
        const t = (i / 9) * (n / sr) + rnd() * 0.7;
        noiseLayer(o, sr, rnd, { t0: t, dur: 3.2, amp: 0.5 + rnd() * 0.4, cut0: 380, cut1: 2200, tau: 1.1, res: 0.65, atk: 0.55 });
        noiseLayer(o, sr, rnd, { t0: t + 0.35, dur: 2.4, amp: 0.28, cut0: 120, cut1: 70, tau: 0.9, atk: 0.4 });
      }
      saturate(o, 1.2);
    },
  },
  /** Wind: a bandpass wandering slowly, with gusts layered over it. */
  wind: {
    dur: 9, gain: 0.42, cut: 1400,
    render: (o, sr, rnd) => {
      const n = o.length;
      noiseLayer(o, sr, rnd, { dur: n / sr, amp: 0.3, cut0: 260, cut1: 380, tau: 1e6, res: 1.1, mode: "band", atk: 0.6 });
      noiseLayer(o, sr, rnd, { dur: n / sr, amp: 0.2, cut0: 90, cut1: 110, tau: 1e6, res: 0.8, atk: 0.9 });
      for (let i = 0; i < 12; i++) {
        const t = rnd() * (n / sr - 2.5);
        noiseLayer(o, sr, rnd, { t0: t, dur: 2.4, amp: 0.22 + rnd() * 0.3, cut0: 300, cut1: 1300, tau: 0.85, res: 1.6, mode: "band", atk: 0.5 });
      }
    },
  },
  /** Cicadas: amplitude-modulated high band, several colonies out of phase. */
  insects: {
    dur: 7, gain: 0.3, cut: 9000,
    render: (o, sr, rnd) => {
      const n = o.length;
      const colonies = 4;
      for (let c = 0; c < colonies; c++) {
        const centre = 4200 + rnd() * 3000;
        const amRate = 38 + rnd() * 26;
        const scratch = new Float32Array(n);
        noiseLayer(scratch, sr, rnd, { dur: n / sr, amp: 0.5, cut0: centre, cut1: centre * 1.1, tau: 1e6, res: 3.2, mode: "band", atk: 0.4 });
        // Ring-modulate for the buzz, and swell the colony in and out.
        let ph = rnd() * TWO_PI;
        const swellRate = 0.11 + rnd() * 0.16;
        let sw = rnd() * TWO_PI;
        for (let i = 0; i < n; i++) {
          ph += (TWO_PI * amRate) / sr;
          sw += (TWO_PI * swellRate) / sr;
          const am = 0.55 + 0.45 * Math.sin(ph);
          const swell = Math.max(0, 0.35 + 0.65 * Math.sin(sw));
          o[i] += scratch[i] * am * swell * 0.5;
        }
      }
    },
  },
  /** Crickets: discrete chirp trains, each insect on its own tempo. */
  crickets: {
    dur: 7, gain: 0.28, cut: 9000,
    render: (o, sr, rnd) => {
      const n = o.length;
      const span = n / sr;
      for (let c = 0; c < 5; c++) {
        const f = 3800 + rnd() * 2400;
        const period = 0.34 + rnd() * 0.5;
        const amp = 0.25 + rnd() * 0.35;
        for (let t = rnd() * period; t < span - 0.2; t += period) {
          for (let p = 0; p < 3; p++) {
            toneLayer(o, sr, rnd, { t0: t + p * 0.028, dur: 0.03, amp, f0: f, f1: f * 0.97, tau: 0.007, atk: 0.0012 });
          }
        }
      }
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.08, cut0: 220, cut1: 200, tau: 1e6, atk: 1 });
    },
  },
  /** City: tyre rumble, a distant road, air handling. */
  city: {
    dur: 9, gain: 0.34, cut: 1200,
    render: (o, sr, rnd) => {
      const n = o.length;
      const span = n / sr;
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.34, cut0: 170, cut1: 200, tau: 1e6, res: 0.7, atk: 0.7 });
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.12, cut0: 1300, cut1: 1500, tau: 1e6, res: 0.6, atk: 0.9 });
      // Passing vehicles: a band sweeping up then down as they go by.
      for (let i = 0; i < 7; i++) {
        const t = rnd() * (span - 3);
        noiseLayer(o, sr, rnd, { t0: t, dur: 1.5, amp: 0.2 + rnd() * 0.2, cut0: 260, cut1: 900, tau: 1.4, res: 1.3, mode: "band", atk: 0.5 });
        noiseLayer(o, sr, rnd, { t0: t + 1.4, dur: 1.7, amp: 0.18, cut0: 900, cut1: 220, tau: 0.9, res: 1.3, mode: "band", atk: 0.2 });
      }
    },
  },
  /** Underwater: everything above 400 Hz is gone; bubbles and pressure. */
  underwater: {
    dur: 6, gain: 0.55, cut: 500,
    render: (o, sr, rnd) => {
      const span = o.length / sr;
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.5, cut0: 190, cut1: 230, tau: 1e6, res: 0.9, atk: 0.4 });
      grainLayer(o, sr, rnd, { dur: span - 0.5, count: 40, amp: 0.16, f0: 300, f1: 1400, tau: 0.02, kind: "ping", clump: 0 });
    },
  },
};

// ===========================================================================
// 5. The system
// ===========================================================================

/** The published service, plus the extras the HUD and debug menu can use. */
export interface PalmasAudioService extends AudioService {
  /** 0..1 master volume. */
  setVolume(v: number): void;
  getVolume(): number;
  setMuted(m: boolean): void;
  isMuted(): boolean;
  /** Momentarily muffle the world — 1 = point-blank blast. */
  concussion(strength: number): void;
  /** True once the browser has actually let us make noise. */
  readonly ready: boolean;
}

/** A live one-shot. Pooled: the wrapper is reused, the nodes are not. */
interface Voice {
  src: AudioBufferSourceNode | null;
  gain: GainNode | null;
  pan: PannerNode | null;
  filt: BiquadFilterNode | null;
  send: GainNode | null;
  key: string;
  level: number;
  prio: number;
  endsAt: number;
  active: boolean;
}

const createAudio: SystemFactory = (ctx) => {
  const quality = ctx.quality;
  // A private deterministic stream. Seeded from the world RNG once so runtime
  // audio jitter never perturbs worldgen's draw order.
  const rng = makeRng(((ctx.rng() * 0xffffffff) >>> 0) ^ 0x9e3779b9);

  // -------------------------------------------------------------------------
  // 5a. Graph
  // -------------------------------------------------------------------------
  let actx: AudioContext | null = null;
  let master: GainNode | null = null;
  let limiter: DynamicsCompressorNode | null = null;
  let worldBus: GainNode | null = null;
  let muffle: BiquadFilterNode | null = null;
  let duck: GainNode | null = null;
  let sfxDry: GainNode | null = null;
  let uiBus: GainNode | null = null;
  let ambBus: GainNode | null = null;
  let ambDuck: GainNode | null = null;
  let revIn: GainNode | null = null;
  let revOut: GainNode | null = null;
  let convTight: ConvolverNode | null = null;
  let convWide: ConvolverNode | null = null;
  let tightGain: GainNode | null = null;
  let wideGain: GainNode | null = null;
  let tinnitus: OscillatorNode | null = null;
  let tinGain: GainNode | null = null;
  let listenerCam: THREE.Camera = ctx.camera;

  let volume = 0.85;
  let muted = false;
  let ready = false;
  let broken = false;

  const AC: typeof AudioContext | undefined =
    typeof window !== "undefined"
      ? window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;

  /**
   * Build the context and the whole bus topology. Safe to call before any
   * gesture — the context just starts life suspended and every play() bails
   * out until it isn't.
   */
  function buildGraph(): void {
    if (actx || broken || !AC) return;
    try {
      actx = new AC({ latencyHint: "interactive" });
    } catch {
      broken = true;
      return;
    }
    const a = actx;

    master = a.createGain();
    master.gain.value = muted ? 0 : volume;
    limiter = a.createDynamicsCompressor();
    limiter.threshold.value = -7;
    limiter.knee.value = 8;
    limiter.ratio.value = 9;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.24;
    master.connect(limiter);
    limiter.connect(a.destination);

    duck = a.createGain();
    duck.gain.value = 1;
    duck.connect(master);

    // One shared lowpass carries both the post-blast muffle and the
    // underwater filter — they're the same physical idea, so one node.
    muffle = a.createBiquadFilter();
    muffle.type = "lowpass";
    muffle.frequency.value = 21000;
    muffle.Q.value = 0.55;
    muffle.connect(duck);

    worldBus = a.createGain();
    worldBus.gain.value = 1;
    worldBus.connect(muffle);

    sfxDry = a.createGain();
    sfxDry.gain.value = 1;
    sfxDry.connect(worldBus);

    ambBus = a.createGain();
    ambBus.gain.value = 1;
    ambDuck = a.createGain();
    ambDuck.gain.value = 1;
    ambBus.connect(ambDuck);
    ambDuck.connect(worldBus);

    // UI bypasses the world filters: a hitmarker must stay legible through
    // a blast that has just muffled everything else.
    uiBus = a.createGain();
    uiBus.gain.value = 1;
    uiBus.connect(master);

    // Reverb: two generated impulse responses, crossfaded by environment.
    revIn = a.createGain();
    revIn.gain.value = 1;
    revOut = a.createGain();
    revOut.gain.value = 0.9;
    revOut.connect(worldBus);

    const [tightLen, wideLen] = IR_LEN[quality];
    convTight = a.createConvolver();
    convTight.normalize = true;
    convTight.buffer = renderIR(a, tightLen, 0.012, 3200, 0.9);
    tightGain = a.createGain();
    tightGain.gain.value = 0.6;
    revIn.connect(tightGain);
    tightGain.connect(convTight);
    convTight.connect(revOut);

    if (wideLen > 0) {
      convWide = a.createConvolver();
      convWide.normalize = true;
      convWide.buffer = renderIR(a, wideLen, 0.045, 1500, 0.35);
      wideGain = a.createGain();
      wideGain.gain.value = 0.4;
      revIn.connect(wideGain);
      wideGain.connect(convWide);
      convWide.connect(revOut);
    }

    // Tinnitus tone — silent until something goes off next to your head.
    try {
      tinnitus = a.createOscillator();
      tinnitus.type = "sine";
      tinnitus.frequency.value = 4380;
      tinGain = a.createGain();
      tinGain.gain.value = 0;
      tinnitus.connect(tinGain);
      tinGain.connect(master);
      tinnitus.start();
    } catch {
      tinnitus = null;
    }

    if (a.state === "running") ready = true;
  }

  /**
   * Impulse response generator. Early reflections as discrete taps (that's
   * what tells you the size of the room) over an exponentially decaying,
   * band-limited noise tail. Channels are decorrelated for stereo width.
   */
  function renderIR(a: AudioContext, seconds: number, preDelay: number, tone: number, density: number): AudioBuffer {
    // ConvolverNode rejects any buffer whose rate differs from the context's,
    // so the IR has to be rendered at the context rate — not a cheaper one.
    const sr = a.sampleRate;
    const n = Math.max(64, Math.ceil(seconds * sr));
    const buf = a.createBuffer(2, n, sr);
    const irRng = makeRng(0x1e3e3eb ^ Math.round(seconds * 1000));
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      const pd = Math.round(preDelay * sr * (1 + c * 0.13));
      // Tail: noise with a fast one-pole lowpass, decaying exponentially.
      const coef = 1 - Math.exp((-TWO_PI * tone) / sr);
      let lp = 0;
      for (let i = pd; i < n; i++) {
        const t = (i - pd) / sr;
        const x = irRng() * 2 - 1;
        lp += (x - lp) * coef;
        // Density ramp: the tail thickens then thins, like a real room.
        const build = Math.min(1, t / (seconds * 0.08));
        d[i] = lp * Math.exp((-6.9 * t) / seconds) * build * density;
      }
      // Early reflections.
      const taps = 9;
      for (let k = 0; k < taps; k++) {
        const t = pd + Math.round((0.004 + irRng() * seconds * 0.16) * sr);
        if (t >= n) continue;
        d[t] += (irRng() * 2 - 1) * 0.75 * Math.exp(-k * 0.28);
      }
      normalise(d, 0.85);
    }
    return buf;
  }

  // -------------------------------------------------------------------------
  // 5b. Gesture unlock
  // -------------------------------------------------------------------------
  function resume(): void {
    if (broken) return;
    if (!actx) buildGraph();
    if (!actx) return;
    if (actx.state === "running") {
      if (!ready) {
        ready = true;
        ctx.emit("palmas:audio", { ready, muted, volume });
      }
      return;
    }
    actx.resume().then(
      () => {
        ready = actx?.state === "running";
        ctx.emit("palmas:audio", { ready, muted, volume });
      },
      () => {
        /* still gated — the next gesture will try again */
      },
    );
  }

  const unlock = () => resume();
  const onVisibility = () => {
    if (!actx || broken) return;
    // Suspending on a hidden tab keeps a backgrounded game from burning a
    // core on six convolvers nobody is listening to.
    if (document.hidden) actx.suspend().catch(() => {});
    else if (ready) actx.resume().catch(() => {});
  };

  if (typeof window !== "undefined") {
    buildGraph();
    for (const ev of ["pointerdown", "mousedown", "keydown", "touchstart", "click"]) {
      window.addEventListener(ev, unlock, { passive: true });
    }
    document.addEventListener("visibilitychange", onVisibility);
  }

  // -------------------------------------------------------------------------
  // 5c. Bank: render on demand, prebuild in the background
  // -------------------------------------------------------------------------
  const bank = new Map<string, AudioBuffer[]>();
  const bedBuffers = new Map<string, AudioBuffer>();

  /** Cheap string hash so a cue's variants are seeded stably by name. */
  function hashKey(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function buildCue(key: string): AudioBuffer[] | null {
    const cached = bank.get(key);
    if (cached) return cached;
    const cue = CUES[key];
    if (!cue || !actx) return null;
    const a = actx;
    const sr = cue.sr ?? (quality === "low" ? 24000 : a.sampleRate);
    const count = Math.max(1, Math.min(cue.variants ?? 3, VARIANTS[quality]));
    const frames = Math.max(16, Math.ceil(cue.dur * sr));
    const out: AudioBuffer[] = [];
    for (let v = 0; v < count; v++) {
      let buf: AudioBuffer;
      try {
        buf = a.createBuffer(cue.stereo ? 2 : 1, frames, sr);
      } catch {
        break;
      }
      const ch = buf.getChannelData(0);
      cue.render(ch, sr, makeRng(hashKey(key) ^ (v * 0x9e3779b1)));
      normalise(ch, cue.peak ?? 0.9);
      if (cue.stereo) {
        // Second channel rendered from an independent seed — natural width
        // without a stereo widener.
        const r = buf.getChannelData(1);
        cue.render(r, sr, makeRng((hashKey(key) ^ (v * 0x9e3779b1)) + 0x5bf03635));
        normalise(r, cue.peak ?? 0.9);
      }
      out.push(buf);
    }
    if (out.length === 0) return null;
    bank.set(key, out);
    return out;
  }

  function buildBed(key: string): AudioBuffer | null {
    const cached = bedBuffers.get(key);
    if (cached) return cached;
    const bed = BEDS[key];
    if (!bed || !actx) return null;
    const a = actx;
    const sr = BED_RATE[quality];
    const xfade = Math.round(sr * 0.6);
    const n = Math.ceil(bed.dur * sr);
    let buf: AudioBuffer;
    try {
      buf = a.createBuffer(2, n, sr);
    } catch {
      return null;
    }
    const scratch = new Float32Array(n + xfade);
    for (let c = 0; c < 2; c++) {
      scratch.fill(0);
      bed.render(scratch, sr, makeRng(hashKey(key) ^ (c * 0x27d4eb2d)));
      // Wrap the tail into the head so the loop point is inaudible.
      for (let i = 0; i < xfade; i++) {
        const w = i / xfade;
        scratch[i] = scratch[i] * w + scratch[n + i] * (1 - w);
      }
      const d = buf.getChannelData(c);
      d.set(scratch.subarray(0, n));
      normalise(d, 0.62);
    }
    bedBuffers.set(key, buf);
    return buf;
  }

  // Prebuild order: the things a player hears in the first ten seconds first.
  const prebuild: string[] = [
    "rifle", "impact_concrete", "step_stone", "hitmarker", "land", "jump",
    "pistol", "shotgun", "explosion", "impact_metal", "impact_dirt", "damage",
    "shellDrop", "magOut", "magIn", "boltBack", "ricochet", "step_grass",
    "minigun", "rocket", "railgun", "impact_wood", "impact_glass", "impact_water",
    "impact_flesh", "step_sand", "step_dirt", "step_metal", "step_wood", "step_water",
    "debris", "splash_in", "splash_out", "swim", "whoosh", "pump", "dryFire",
    "weaponSwitch", "spinUp", "spinDown", "railCharge", "grapple_fire", "grapple_hit",
    "chute", "hitmarker_kill", "heartbeat", "death", "pickup", "ui_tick", "generic",
    "gull", "bird", "boathorn", "siren", "horn", "distant_fire",
    "@bed:surf", "@bed:wind", "@bed:city", "@bed:insects", "@bed:crickets", "@bed:underwater",
  ];
  let prebuildAt = 0;

  /** Drain the prebuild queue under a wall-clock budget so we never hitch. */
  function pumpPrebuild(budgetMs: number): void {
    if (!actx || prebuildAt >= prebuild.length) return;
    const t0 = performance.now();
    while (prebuildAt < prebuild.length && performance.now() - t0 < budgetMs) {
      const key = prebuild[prebuildAt++];
      try {
        if (key.startsWith("@bed:")) buildBed(key.slice(5));
        else buildCue(key);
      } catch {
        /* a single bad recipe must not stall the queue */
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5d. Voices
  // -------------------------------------------------------------------------
  const voices: Voice[] = [];
  const pool: Voice[] = [];
  const lastPlay = new Map<string, number>();
  const sameCount = new Map<string, number>();
  const cap = VOICE_CAP[quality];
  const hrtf = quality === "high" || quality === "ultra";

  function takeVoice(): Voice {
    const v = pool.pop();
    if (v) return v;
    return { src: null, gain: null, pan: null, filt: null, send: null, key: "", level: 0, prio: 0, endsAt: 0, active: false };
  }

  function releaseVoice(v: Voice): void {
    if (!v.active) return;
    v.active = false;
    try {
      v.src?.disconnect();
      v.filt?.disconnect();
      v.gain?.disconnect();
      v.pan?.disconnect();
      v.send?.disconnect();
    } catch {
      /* already torn down */
    }
    sameCount.set(v.key, Math.max(0, (sameCount.get(v.key) ?? 1) - 1));
    v.src = null;
    v.gain = null;
    v.pan = null;
    v.filt = null;
    v.send = null;
    const i = voices.indexOf(v);
    if (i >= 0) voices.splice(i, 1);
    if (pool.length < 64) pool.push(v);
  }

  /** Steal the quietest voice when we're at the cap. Returns false to drop. */
  function makeRoom(level: number, prio: number): boolean {
    if (voices.length < cap) return true;
    let worst: Voice | null = null;
    let worstScore = Infinity;
    for (const v of voices) {
      const score = v.level * (0.3 + v.prio);
      if (score < worstScore) {
        worstScore = score;
        worst = v;
      }
    }
    if (!worst || worstScore >= level * (0.3 + prio)) return false;
    try {
      worst.src?.stop();
    } catch {
      /* already stopped */
    }
    releaseVoice(worst);
    return true;
  }

  // -------------------------------------------------------------------------
  // 5e. Listener + environment state
  // -------------------------------------------------------------------------
  const listenerPos = new THREE.Vector3();
  const fwd = new THREE.Vector3(0, 0, -1);
  const upv = new THREE.Vector3(0, 1, 0);
  const tmpDir = new THREE.Vector3();
  const tmpNormal = new THREE.Vector3();
  const tmpVec = new THREE.Vector3();

  /** Mix state the director drives; every field is a smoothed 0..1 unless noted. */
  const env = {
    shore: 999,
    altitude: 0,
    inCity: 0,
    inJungle: 0,
    night: 0,
    indoor: 0,
    submerged: 0,
    overWater: 0,
    biome: "jungle" as Biome,
    /** Target reverb wetness and its tight/wide balance. */
    wet: 0.2,
    tight: 0.6,
  };

  let concussion = 0;
  let duckAmt = 0;
  let occlusionBudget = 3;

  function setParam(p: AudioParam | undefined, value: number, smooth: number): void {
    if (!p || !actx) return;
    if (smooth <= 0) p.value = value;
    else p.setTargetAtTime(value, actx.currentTime, smooth);
  }

  /**
   * Air absorption. High frequencies die with distance far faster than lows —
   * this single curve is what makes a rifle 400 m away read as *far* rather
   * than *quiet*.
   */
  function airCutoff(dist: number, scale: number): number {
    if (scale <= 0) return 21000;
    return Math.max(280, 20000 * Math.pow(0.5, (dist * scale) / 62));
  }

  /** Inverse-square-ish rolloff with a hard fade to nothing at `max`. */
  function distanceGain(dist: number, ref: number, roll: number, max: number): number {
    if (dist <= ref) return 1;
    if (dist >= max) return 0;
    const g = ref / (ref + roll * (dist - ref));
    // Taper the last third so nothing ever cuts out abruptly.
    const edge = Math.min(1, (max - dist) / (max * 0.35));
    return g * edge * edge;
  }

  // -------------------------------------------------------------------------
  // 5f. play()
  // -------------------------------------------------------------------------
  function play(name: string, opts?: { position?: THREE.Vector3; volume?: number; rate?: number }): void {
    if (!ready || !actx || broken || muted) return;
    const a = actx;
    const key = resolveCue(name);
    const cue = CUES[key];
    if (!cue) return;

    const now = a.currentTime;
    const gap = cue.gap ?? 0.01;
    const last = lastPlay.get(key) ?? -99;
    if (now - last < gap) return;

    const pos = opts?.position;
    let dist = 0;
    if (pos) {
      dist = listenerPos.distanceTo(pos);
      const maxD = cue.max ?? 400;
      if (dist > maxD) return;
    }

    // Level before we commit any nodes — voice stealing needs it, and a
    // sound that would be inaudible anyway shouldn't cost a graph.
    const baseVol = (opts?.volume ?? 1) * (cue.gain ?? 1);
    let level = baseVol;
    if (pos) level *= distanceGain(dist, cue.ref ?? 9, cue.roll ?? 1, cue.max ?? 400);
    if (level < 0.004) return;

    const prio = cue.prio ?? 0.5;
    const running = sameCount.get(key) ?? 0;
    if (running >= (cue.same ?? 2) && prio < 0.9) return;
    if (!makeRoom(level, prio)) return;

    const bufs = buildCue(key);
    if (!bufs || bufs.length === 0) return;
    const buf = bufs.length === 1 ? bufs[0] : bufs[(rng() * bufs.length) | 0];

    let src: AudioBufferSourceNode;
    let gain: GainNode;
    try {
      src = a.createBufferSource();
      gain = a.createGain();
    } catch {
      return;
    }
    src.buffer = buf;
    const jitter = cue.jitter ?? 0.05;
    const rate = (opts?.rate ?? 1) * (cue.rate ?? 1) * (1 + (rng() * 2 - 1) * jitter);
    src.playbackRate.value = Math.max(0.35, Math.min(2.6, rate));

    const v = takeVoice();
    v.key = key;
    v.level = level;
    v.prio = prio;
    v.active = true;
    v.src = src;
    v.gain = gain;

    let tail: AudioNode = src;

    // Occlusion + air absorption, both expressed as one lowpass.
    let cutoff = 21000;
    if (pos && dist > 4) {
      cutoff = airCutoff(dist, cue.air ?? 1);
      if (occlusionBudget > 0 && dist > 14 && ctx.services.collision) {
        occlusionBudget--;
        tmpDir.subVectors(pos, listenerPos);
        const len = tmpDir.length();
        if (len > 0.001) {
          tmpDir.divideScalar(len);
          const hit = ctx.services.collision.raycast(listenerPos, tmpDir, len - 1.5);
          if (hit) {
            // Something solid in the way: darker and quieter, not silent.
            cutoff = Math.min(cutoff, 900);
            level *= 0.55;
          }
        }
      }
    }
    if (cutoff < 19000) {
      const filt = a.createBiquadFilter();
      filt.type = "lowpass";
      filt.frequency.value = cutoff;
      filt.Q.value = 0.5;
      tail.connect(filt);
      tail = filt;
      v.filt = filt;
    }

    gain.gain.value = level;
    tail.connect(gain);
    tail = gain;

    if (pos && cue.bus !== "ui") {
      const pan = a.createPanner();
      pan.panningModel = hrtf ? "HRTF" : "equalpower";
      pan.distanceModel = "inverse";
      // We do our own distance curve; the panner only handles direction.
      pan.rolloffFactor = 0;
      pan.refDistance = 1;
      setPannerPos(pan, pos);
      tail.connect(pan);
      tail = pan;
      v.pan = pan;
    }

    if (cue.bus === "ui") {
      if (uiBus) tail.connect(uiBus);
    } else {
      if (sfxDry) tail.connect(sfxDry);
      // Reverb send: farther is wetter, which is the other half of distance.
      if (revIn) {
        const send = a.createGain();
        const distWet = pos ? 1 + Math.min(1.4, dist / 160) : 1;
        send.gain.value = Math.min(1.6, level * env.wet * (cue.wet ?? 1) * distWet);
        tail.connect(send);
        send.connect(revIn);
        v.send = send;
      }
    }

    // Speed of sound. A blast on the far ridge should reach you late — this
    // one line does more for scale than any amount of reverb.
    let when = now;
    if (pos && cue.travel && dist > 25) when += Math.min(MAX_TRAVEL, dist / SOUND_SPEED);

    try {
      src.start(when);
    } catch {
      releaseVoice(v);
      return;
    }
    v.endsAt = when + buf.duration / Math.max(0.35, src.playbackRate.value) + 0.15;
    src.onended = () => releaseVoice(v);
    voices.push(v);
    lastPlay.set(key, now);
    sameCount.set(key, running + 1);

    // A blast in your lap muffles the world and rings your ears.
    if (key === "explosion" && (!pos || dist < 60)) {
      const near = pos ? 1 - Math.min(1, dist / 60) : 1;
      applyConcussion(near * near * (opts?.volume ?? 1));
    }
  }

  function setPannerPos(pan: PannerNode, p: THREE.Vector3): void {
    const px = pan.positionX as AudioParam | undefined;
    if (px && actx) {
      px.value = p.x;
      pan.positionY.value = p.y;
      pan.positionZ.value = p.z;
    } else {
      // Deprecated path, still the only one on older Safari.
      (pan as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(p.x, p.y, p.z);
    }
  }

  function applyConcussion(strength: number): void {
    concussion = Math.min(1, concussion + strength * 0.9);
    duckAmt = Math.max(duckAmt, Math.min(0.75, strength * 0.8));
  }

  // -------------------------------------------------------------------------
  // 5g. Ambience beds
  // -------------------------------------------------------------------------
  interface BedVoice {
    src: AudioBufferSourceNode | null;
    filt: BiquadFilterNode | null;
    gain: GainNode | null;
    target: number;
    current: number;
    cutTarget: number;
    cutCurrent: number;
    started: boolean;
  }
  const bedVoices = new Map<string, BedVoice>();
  /** Explicit ambience() overrides: true = force on, false = force off. */
  const bedOverride = new Map<string, boolean>();

  function bedVoice(key: string): BedVoice {
    let b = bedVoices.get(key);
    if (!b) {
      b = { src: null, filt: null, gain: null, target: 0, current: 0, cutTarget: BEDS[key]?.cut ?? 8000, cutCurrent: BEDS[key]?.cut ?? 8000, started: false };
      bedVoices.set(key, b);
    }
    return b;
  }

  /** Start a bed lazily — a loop nobody can hear shouldn't cost a node. */
  function startBed(key: string): void {
    const b = bedVoice(key);
    if (b.started || !actx || !ambBus) return;
    const buf = buildBed(key);
    if (!buf) return;
    const a = actx;
    try {
      const src = a.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      // Detune each bed slightly so two players never hear the same phase.
      src.playbackRate.value = 0.97 + rng() * 0.06;
      const filt = a.createBiquadFilter();
      filt.type = "lowpass";
      filt.frequency.value = b.cutCurrent;
      filt.Q.value = 0.4;
      const gain = a.createGain();
      gain.gain.value = 0;
      src.connect(filt);
      filt.connect(gain);
      gain.connect(ambBus);
      src.start(a.currentTime + rng() * 0.2);
      b.src = src;
      b.filt = filt;
      b.gain = gain;
      b.started = true;
    } catch {
      /* out of nodes; the bed just stays silent */
    }
  }

  function mixBeds(dt: number): void {
    if (!actx) return;
    for (const key of Object.keys(BEDS)) {
      const b = bedVoice(key);
      const override = bedOverride.get(key);
      const target = override === false ? 0 : override === true ? Math.max(b.target, BEDS[key].gain) : b.target;
      // Slew: 2.5 s to cross a full fade, which is slow enough to be invisible.
      b.current += (target - b.current) * Math.min(1, dt * 0.9);
      if (b.current > 0.002 && !b.started) startBed(key);
      if (!b.started) continue;
      if (b.gain) setParam(b.gain.gain, b.current, 0.15);
      if (b.filt && Math.abs(b.cutTarget - b.cutCurrent) > b.cutCurrent * 0.04) {
        b.cutCurrent += (b.cutTarget - b.cutCurrent) * Math.min(1, dt * 1.2);
        setParam(b.filt.frequency, b.cutCurrent, 0.2);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5h. Sparse world events
  // -------------------------------------------------------------------------
  const evtPos = new THREE.Vector3();
  const timers = { gull: 6, bird: 9, horn: 30, siren: 45, fire: 25 };

  /** Fire a one-shot at a random offset around the player. */
  function ambientAt(name: string, dist: number, height: number, vol: number): void {
    const ang = rng() * TWO_PI;
    evtPos.set(
      listenerPos.x + Math.cos(ang) * dist,
      listenerPos.y + height,
      listenerPos.z + Math.sin(ang) * dist,
    );
    play(name, { position: evtPos, volume: vol });
  }

  function tickAmbientEvents(dt: number): void {
    const day = 1 - env.night;
    // Gulls hang around the coast in daylight.
    timers.gull -= dt;
    if (timers.gull <= 0) {
      const near = Math.abs(env.shore) < 320 ? 1 : 0;
      if (near && day > 0.35 && rng() < 0.8) ambientAt("gull", 40 + rng() * 130, 18 + rng() * 40, 0.5 + rng() * 0.4);
      timers.gull = 7 + rng() * 16;
    }
    // Jungle birds by day, in the trees.
    timers.bird -= dt;
    if (timers.bird <= 0) {
      if (env.inJungle > 0.4 && day > 0.3 && rng() < 0.75) ambientAt("bird", 12 + rng() * 45, 6 + rng() * 12, 0.4 + rng() * 0.4);
      timers.bird = 6 + rng() * 14;
    }
    // Traffic horns downtown.
    timers.horn -= dt;
    if (timers.horn <= 0) {
      if (env.inCity > 0.45 && rng() < 0.6) ambientAt("horn", 40 + rng() * 180, -2, 0.35 + rng() * 0.35);
      timers.horn = 18 + rng() * 40;
    }
    // A siren somewhere across the district, and a boat out on the water.
    timers.siren -= dt;
    if (timers.siren <= 0) {
      if (rng() < 0.5) {
        if (env.inCity > 0.3) ambientAt("siren", 320 + rng() * 500, 4, 0.5);
        else if (env.shore < 240) ambientAt("boathorn", 500 + rng() * 900, 2, 0.6);
      }
      timers.siren = 45 + rng() * 90;
    }
    // Cartel business, elsewhere. Sells the island as inhabited.
    timers.fire -= dt;
    if (timers.fire <= 0) {
      if (rng() < 0.45) ambientAt("distant_fire", 400 + rng() * 900, 6, 0.4 + rng() * 0.4);
      timers.fire = 30 + rng() * 70;
    }
  }

  // -------------------------------------------------------------------------
  // 5i. The ambience director — samples the world, sets every bed target
  // -------------------------------------------------------------------------
  let envTimer = 0;
  let indoorTimer = 0;

  function sampleEnvironment(): void {
    const player = ctx.services.player;
    const terrain = ctx.services.terrain;
    const sky = ctx.services.sky;
    const p = player?.position ?? listenerPos;
    const x = p.x;
    const z = p.z;

    const signed = landSignedDistance(x, z);
    env.shore = signed;
    env.overWater = signed < 0 ? 1 : 0;

    const gy = terrain?.heightAt(x, z) ?? 0;
    env.altitude = Math.max(0, p.y - gy);

    let slope = 0;
    if (terrain) {
      terrain.normalAt(x, z, tmpNormal);
      slope = 1 - Math.max(-1, Math.min(1, tmpNormal.y));
    }
    env.biome = biomeAt(x, z, gy, slope);

    const district = districtAt(x, z);
    const cityWeight: Record<string, number> = {
      downtown: 1, chinatown: 0.85, wharf: 0.7, victorian: 0.55,
      mission: 0.65, industrial: 0.75, resort: 0.4,
    };
    const cityBase = district ? cityWeight[district.kind] ?? 0.6 : 0;
    // The city drops away as you climb above it.
    env.inCity = cityBase * (1 - Math.min(0.85, env.altitude / 190));
    env.inJungle = env.biome === "jungle" || env.biome === "hillside" ? 1 - env.inCity : 0;

    env.night = sky ? 1 - Math.max(0, Math.min(1, sky.daylight)) : 0;
    env.submerged = player?.state === "water" || p.y < (terrain?.seaLevel ?? 0) ? 1 : 0;

    // --- Bed targets -------------------------------------------------------
    // Surf: loudest at the waterline, audible for half a kilometre inland,
    // and it goes dull as you move away rather than merely quiet.
    const shoreAbs = Math.abs(signed);
    const surf = Math.max(0, 1 - shoreAbs / 620) * (signed < 0 ? 1 : 0.92);
    const surfBed = bedVoice("surf");
    surfBed.target = BEDS.surf.gain * Math.pow(surf, 1.4) * (1 - env.submerged * 0.7);
    surfBed.cutTarget = 400 + 3400 * Math.max(0, 1 - shoreAbs / 260);

    // Wind: altitude and airspeed. Wingsuiting should be loud.
    const speed = player ? Math.min(1, player.velocity.length() / 55) : 0;
    const flying = player?.state === "wingsuit" || player?.state === "parachute";
    const windAmt = Math.min(1, env.altitude / 260) * 0.7 + speed * (flying ? 0.9 : 0.35);
    const windBed = bedVoice("wind");
    windBed.target = BEDS.wind.gain * Math.min(1, 0.12 + windAmt) * (1 - env.submerged);
    windBed.cutTarget = 500 + 3200 * Math.min(1, windAmt);

    // City hum.
    const cityBed = bedVoice("city");
    cityBed.target = BEDS.city.gain * env.inCity * (0.55 + (1 - env.night) * 0.45) * (1 - env.submerged);
    cityBed.cutTarget = 350 + 1400 * env.inCity;

    // Cicadas by day, crickets by night. They never overlap much, which is
    // what makes dusk in this game read as dusk.
    const insectBed = bedVoice("insects");
    insectBed.target = BEDS.insects.gain * (1 - env.night) * env.inJungle * Math.max(0, 1 - env.altitude / 220) * (1 - env.submerged);
    const cricketBed = bedVoice("crickets");
    cricketBed.target = BEDS.crickets.gain * env.night * Math.max(env.inJungle, 0.35 * (1 - env.inCity)) * Math.max(0, 1 - env.altitude / 200) * (1 - env.submerged);

    const underBed = bedVoice("underwater");
    underBed.target = BEDS.underwater.gain * env.submerged;

    // --- Reverb character --------------------------------------------------
    // Indoors slaps, a street canyon slaps a bit less, the open bay barely at
    // all, and altitude kills it entirely.
    const altFade = Math.max(0, 1 - env.altitude / 320);
    if (env.indoor > 0.5) {
      env.wet = 0.5;
      env.tight = 0.9;
    } else if (env.inCity > 0.3) {
      env.wet = (0.2 + env.inCity * 0.22) * altFade;
      env.tight = 0.78;
    } else if (signed < 0 || env.biome === "beach") {
      env.wet = 0.1 * altFade;
      env.tight = 0.2;
    } else {
      env.wet = 0.17 * altFade;
      env.tight = 0.34;
    }
    if (env.submerged) env.wet *= 0.35;

    if (tightGain) setParam(tightGain.gain, 0.25 + env.tight * 0.75, 0.4);
    if (wideGain) setParam(wideGain.gain, 0.15 + (1 - env.tight) * 0.85, 0.4);
  }

  /** Cheap indoor test: is there a ceiling directly overhead? */
  function probeIndoor(): void {
    const col = ctx.services.collision;
    if (!col) {
      env.indoor = 0;
      return;
    }
    tmpDir.set(0, 1, 0);
    const hit = col.raycast(listenerPos, tmpDir, 9);
    const want = hit ? 1 : 0;
    env.indoor += (want - env.indoor) * 0.5;
  }

  // -------------------------------------------------------------------------
  // 5j. Footsteps — generated here rather than by the player controller, so
  // surface, cadence and volume all stay a single audio concern.
  // -------------------------------------------------------------------------
  let stride = 0;
  let lastState: string = "ground";
  let swimTimer = 0;

  function surfaceCue(): string {
    if (env.submerged || (ctx.services.terrain?.isWater(listenerPos.x, listenerPos.z) ?? false)) return "step_water";
    switch (env.biome) {
      case "beach": return "step_sand";
      case "city": return "step_stone";
      case "jungle": return "step_grass";
      case "hillside": return "step_dirt";
      case "cliff": return "step_dirt";
      default: return "step_stone";
    }
  }

  function tickFootsteps(dt: number): void {
    const player = ctx.services.player;
    if (!player) return;
    const state = player.state;

    if (state === "water") {
      swimTimer -= dt;
      const moving = Math.hypot(player.velocity.x, player.velocity.z) > 0.9;
      if (swimTimer <= 0 && moving) {
        play("swim", { volume: 0.5 + rng() * 0.2 });
        swimTimer = 0.75 + rng() * 0.35;
      }
      stride = 0;
    } else if (state === "ground") {
      const sp = Math.hypot(player.velocity.x, player.velocity.z);
      if (sp > 1.1) {
        stride += sp * dt;
        // Roughly constant stride length: faster movement just steps sooner.
        const strideLen = ctx.input.crouch ? 1.35 : sp > 8 ? 2.35 : 1.95;
        if (stride >= strideLen) {
          stride = 0;
          const loud = Math.min(1, sp / 11);
          play(surfaceCue(), { volume: (ctx.input.crouch ? 0.35 : 0.6) * (0.55 + loud * 0.65) });
        }
      } else {
        stride = Math.max(0, stride - dt * 2);
      }
    } else {
      stride = 0;
    }

    // Transition cues the other modules don't cover.
    if (state !== lastState) {
      if (state === "wingsuit") play("whoosh", { volume: 0.7 });
      else if (state === "parachute") play("chute", { volume: 0.8 });
      else if (state === "grapple") play("grapple_fire", { volume: 0.7 });
      lastState = state;
    }
  }

  // -------------------------------------------------------------------------
  // 5k. Health feedback
  // -------------------------------------------------------------------------
  let heartTimer = 0;
  let lastHealth = 100;

  function tickHealth(dt: number): void {
    const player = ctx.services.player;
    if (!player) return;
    const hp = player.health / Math.max(1, player.maxHealth);
    if (hp > 0 && hp < 0.35) {
      heartTimer -= dt;
      if (heartTimer <= 0) {
        // The closer to death, the faster and louder — the one piece of state
        // the player must never have to read a number for.
        const urgency = 1 - hp / 0.35;
        play("heartbeat", { volume: 0.35 + urgency * 0.5, rate: 0.9 + urgency * 0.35 });
        heartTimer = 1.15 - urgency * 0.5;
      }
    } else {
      heartTimer = 0;
    }
    lastHealth = player.health;
  }

  // -------------------------------------------------------------------------
  // 5l. Event wiring
  // -------------------------------------------------------------------------
  const unsubs: (() => void)[] = [];

  unsubs.push(
    ctx.on("palmas:damage", (p) => {
      const amount = (p as { amount?: number })?.amount ?? 10;
      play("damage", { volume: Math.min(1, 0.35 + amount / 45) });
      // Taking a hit briefly ducks the world so the sting cuts through.
      duckAmt = Math.max(duckAmt, Math.min(0.35, amount / 90));
    }),
  );
  unsubs.push(
    ctx.on("palmas:death", () => {
      play("death", { volume: 1 });
      applyConcussion(0.85);
    }),
  );
  unsubs.push(
    ctx.on("palmas:submerged", (p) => {
      env.submerged = p ? 1 : 0;
    }),
  );
  unsubs.push(
    ctx.on("palmas:mute", (p) => {
      setMuted(typeof p === "boolean" ? p : !muted);
    }),
  );
  unsubs.push(
    ctx.on("palmas:volume", (p) => {
      if (typeof p === "number") setVolume(p);
    }),
  );

  function setVolume(v: number): void {
    volume = Math.max(0, Math.min(1, v));
    if (master) setParam(master.gain, muted ? 0 : volume, 0.03);
    ctx.emit("palmas:audio", { ready, muted, volume });
  }

  function setMuted(m: boolean): void {
    muted = m;
    if (master) setParam(master.gain, muted ? 0 : volume, 0.03);
    ctx.emit("palmas:audio", { ready, muted, volume });
  }

  // -------------------------------------------------------------------------
  // 5m. Service
  // -------------------------------------------------------------------------
  const service: PalmasAudioService = {
    play,
    ambience(name: string, on: boolean) {
      if (name === "all" || name === "*") {
        if (on) bedOverride.clear();
        else for (const k of Object.keys(BEDS)) bedOverride.set(k, false);
        return;
      }
      if (name === "auto") {
        bedOverride.clear();
        return;
      }
      const key = BEDS[name] ? name : name === "day" ? "insects" : name === "night" ? "crickets" : name === "ocean" ? "surf" : name === "jungle" ? "insects" : "";
      if (!key) return;
      bedOverride.set(key, on);
      if (on) startBed(key);
    },
    setListener(camera: THREE.Camera) {
      listenerCam = camera ?? ctx.camera;
    },
    setVolume,
    getVolume: () => volume,
    setMuted,
    isMuted: () => muted,
    concussion: applyConcussion,
    get ready() {
      return ready;
    },
  };
  ctx.services.audio = service;

  // -------------------------------------------------------------------------
  // 5n. Frame
  // -------------------------------------------------------------------------
  const sys: System = {
    name: "audio",

    update(dt) {
      occlusionBudget = 3;
      if (broken) return;

      // M toggles mute. `pressed` is edge-triggered, so this fires once.
      if (ctx.input.pressed.has("KeyM")) setMuted(!muted);

      if (!actx) return;
      // Spend more time building the bank while the world is still settling.
      pumpPrebuild(ctx.elapsed < 4 ? 4 : 1.2);
      if (!ready) return;

      // Environment at 8 Hz — none of it changes fast enough to matter more.
      envTimer -= dt;
      if (envTimer <= 0) {
        envTimer = 0.125;
        sampleEnvironment();
      }
      indoorTimer -= dt;
      if (indoorTimer <= 0) {
        indoorTimer = 0.4;
        probeIndoor();
      }

      mixBeds(dt);
      tickAmbientEvents(dt);
      tickFootsteps(dt);
      tickHealth(dt);

      // --- Concussion / underwater muffle ----------------------------------
      concussion = Math.max(0, concussion - dt / (CONCUSSION_DECAY + concussion * 1.8));
      duckAmt = Math.max(0, duckAmt - dt * 1.6);
      // The muffle filter is shared: take whichever influence is strongest.
      let cut = 21000;
      if (concussion > 0.001) cut = Math.min(cut, 21000 * Math.pow(0.02, concussion));
      if (env.submerged > 0.5) cut = Math.min(cut, 420);
      else if (env.indoor > 0.5) cut = Math.min(cut, 9000);
      setParam(muffle?.frequency, Math.max(260, cut), 0.06);
      setParam(duck?.gain, 1 - duckAmt * 0.6, 0.05);
      setParam(ambDuck?.gain, 1 - concussion * 0.75, 0.12);
      setParam(tinGain?.gain, concussion > 0.05 ? concussion * 0.02 : 0, 0.15);

      // Safety sweep: a dropped `onended` must not leak a voice slot.
      const now = actx.currentTime;
      for (let i = voices.length - 1; i >= 0; i--) {
        if (voices[i].endsAt < now - 0.5) releaseVoice(voices[i]);
      }
    },

    /**
     * Listener runs in lateUpdate: the player controller writes the camera in
     * update(), and a listener a frame behind smears every pan.
     */
    lateUpdate() {
      if (!actx || !ready) return;
      const cam = listenerCam ?? ctx.camera;
      cam.getWorldPosition(listenerPos);
      cam.getWorldDirection(tmpDir);
      upv.set(0, 1, 0).applyQuaternion(cam.getWorldQuaternion(cam.quaternion.clone()));

      const L = actx.listener;
      const t = actx.currentTime;
      const lp = L.positionX as AudioParam | undefined;
      if (lp) {
        // Small smoothing constant: enough to kill zipper noise, not enough
        // to lag the head.
        lp.setTargetAtTime(listenerPos.x, t, 0.012);
        L.positionY.setTargetAtTime(listenerPos.y, t, 0.012);
        L.positionZ.setTargetAtTime(listenerPos.z, t, 0.012);
        L.forwardX.setTargetAtTime(tmpDir.x, t, 0.012);
        L.forwardY.setTargetAtTime(tmpDir.y, t, 0.012);
        L.forwardZ.setTargetAtTime(tmpDir.z, t, 0.012);
        L.upX.setTargetAtTime(upv.x, t, 0.05);
        L.upY.setTargetAtTime(upv.y, t, 0.05);
        L.upZ.setTargetAtTime(upv.z, t, 0.05);
      } else {
        const legacy = L as unknown as {
          setPosition(x: number, y: number, z: number): void;
          setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
        };
        legacy.setPosition(listenerPos.x, listenerPos.y, listenerPos.z);
        legacy.setOrientation(tmpDir.x, tmpDir.y, tmpDir.z, upv.x, upv.y, upv.z);
      }
      fwd.copy(tmpDir);
      tmpVec.copy(listenerPos);
    },

    dispose() {
      for (const u of unsubs) u();
      unsubs.length = 0;
      if (typeof window !== "undefined") {
        for (const ev of ["pointerdown", "mousedown", "keydown", "touchstart", "click"]) {
          window.removeEventListener(ev, unlock);
        }
        document.removeEventListener("visibilitychange", onVisibility);
      }
      for (let i = voices.length - 1; i >= 0; i--) {
        try {
          voices[i].src?.stop();
        } catch {
          /* already ended */
        }
        releaseVoice(voices[i]);
      }
      for (const b of bedVoices.values()) {
        try {
          b.src?.stop();
        } catch {
          /* already ended */
        }
        b.src?.disconnect();
        b.filt?.disconnect();
        b.gain?.disconnect();
      }
      bedVoices.clear();
      bank.clear();
      bedBuffers.clear();
      try {
        tinnitus?.stop();
      } catch {
        /* never started */
      }
      actx?.close().catch(() => {});
      actx = null;
      ready = false;
      if (ctx.services.audio === service) ctx.services.audio = undefined;
    },
  };

  return sys;
};

export default createAudio;
