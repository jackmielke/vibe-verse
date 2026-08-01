/**
 * Vibe Kart — synthesis primitives.
 *
 * Two families live here and they solve different problems.
 *
 * **Node voices** (`tone`, `noiseVoice`, `bell`, `playBuffer`) build a tiny
 * throwaway graph per sound. They are the right tool when the sound needs to
 * be placed in 3D, or when it needs a parameter that is only known at trigger
 * time. They cost a handful of nodes each, which is why `takeVoices` exists.
 *
 * **Baked buffers** (`bake` and the sample-domain helpers under it) render a
 * sound sample-by-sample into an AudioBuffer once, at boot. Anything with
 * layered FM, per-sample distortion or a bespoke envelope shape is far cheaper
 * — and frankly far better sounding — baked than approximated with biquads.
 * A coin chime fires two hundred times a race; it gets baked.
 *
 * Everything takes an explicit start time `t` on the AudioContext clock.
 * Nothing here reads `currentTime` itself, because the sequencer schedules a
 * quarter of a second into the future and would be ruined by a voice that
 * quietly re-anchored itself to "now".
 */
import { createPanner, takeVoices, type AudioGraph } from "./graph";

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface Route {
  /** Destination bus; defaults to the sfx bus. */
  dest?: GainNode;
  /** Stereo position −1..1, used when no world position is given. */
  pan?: number;
  /** World position — takes precedence over `pan` when 3D audio is available. */
  at?: Vec3Like | null;
  /** Reverb send amount, 0..1. */
  wet?: number;
}

export interface ToneOpts extends Route {
  t: number;
  /** Start frequency, Hz. */
  f0: number;
  /** Optional glide target. */
  f1?: number;
  /** Glide duration; defaults to the whole envelope. */
  sweep?: number;
  type?: OscillatorType;
  wave?: PeriodicWave;
  gain: number;
  attack?: number;
  hold?: number;
  decay: number;
  /** Detune in cents — two of these an octave apart is an instant chorus. */
  detune?: number;
}

export interface NoiseOpts extends Route {
  t: number;
  gain: number;
  attack?: number;
  hold?: number;
  decay: number;
  filter?: BiquadFilterType;
  f0: number;
  f1?: number;
  q?: number;
  /** Playback rate of the noise slice — a cheap grain-size control. */
  rate?: number;
}

export interface BufferOpts extends Route {
  t: number;
  buffer: AudioBuffer;
  gain: number;
  rate?: number;
  /** Optional one-pole tilt applied to the whole shot. */
  lowpass?: number;
  highpass?: number;
  /** Fade the tail instead of letting it ring out. */
  release?: number;
}

const MIN_GAIN = 0.0002;

/** Exponential AD(H)SR on a gain param. Never touches zero — WebAudio hates it. */
export function shape(
  p: AudioParam,
  t: number,
  peak: number,
  attack: number,
  hold: number,
  decay: number,
): void {
  const g = Math.max(MIN_GAIN, peak);
  p.setValueAtTime(MIN_GAIN, t);
  p.exponentialRampToValueAtTime(g, t + Math.max(0.0008, attack));
  if (hold > 0) p.setValueAtTime(g, t + attack + hold);
  p.exponentialRampToValueAtTime(MIN_GAIN, t + attack + hold + Math.max(0.01, decay));
}

/** Pan / place / send one voice's output. Returns the node feeding the bus. */
export function route(g: AudioGraph, node: AudioNode, o: Route): AudioNode {
  let out: AudioNode = node;
  if (o.at && g.spatial) {
    const p = createPanner(g, o.at.x, o.at.y, o.at.z);
    if (p) {
      node.connect(p);
      out = p;
    }
  } else if (g.stereo && o.pan) {
    const p = g.ac.createStereoPanner();
    p.pan.value = o.pan < -1 ? -1 : o.pan > 1 ? 1 : o.pan;
    node.connect(p);
    out = p;
  }
  out.connect(o.dest ?? g.sfx);
  const wet = o.wet ?? 0.1;
  if (wet > 0) {
    const s = g.ac.createGain();
    s.gain.value = wet;
    out.connect(s);
    s.connect(g.send);
  }
  return out;
}

export function tone(g: AudioGraph, o: ToneOpts): void {
  const attack = o.attack ?? 0.004;
  const hold = o.hold ?? 0;
  const life = attack + hold + o.decay;
  const osc = g.ac.createOscillator();
  if (o.wave) osc.setPeriodicWave(o.wave);
  else osc.type = o.type ?? "sine";
  if (o.detune) osc.detune.value = o.detune;
  osc.frequency.setValueAtTime(Math.max(8, o.f0), o.t);
  if (o.f1 !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(8, o.f1), o.t + (o.sweep ?? life));
  }
  const amp = g.ac.createGain();
  shape(amp.gain, o.t, o.gain, attack, hold, o.decay);
  osc.connect(amp);
  route(g, amp, o);
  osc.start(o.t);
  osc.stop(o.t + life + 0.05);
}

export function noiseVoice(g: AudioGraph, o: NoiseOpts): void {
  const attack = o.attack ?? 0.002;
  const hold = o.hold ?? 0;
  const life = attack + hold + o.decay;
  const src = g.ac.createBufferSource();
  src.buffer = g.noise;
  src.loop = true;
  src.playbackRate.value = o.rate ?? 1;
  const f = g.ac.createBiquadFilter();
  f.type = o.filter ?? "bandpass";
  f.Q.value = o.q ?? 1;
  f.frequency.setValueAtTime(Math.max(20, o.f0), o.t);
  if (o.f1 !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), o.t + life);
  const amp = g.ac.createGain();
  shape(amp.gain, o.t, o.gain, attack, hold, o.decay);
  src.connect(f);
  f.connect(amp);
  route(g, amp, o);
  // Random offset into the noise so repeated hits never phase-lock into a tone.
  src.start(o.t, g.rng() * 1.5);
  src.stop(o.t + life + 0.05);
}

/** Inharmonic partial stack — the backbone of coins, chimes and metal. */
export function bell(g: AudioGraph, t: number, f: number, gain: number, dur: number, r: Route): void {
  tone(g, { ...r, t, f0: f, type: "sine", gain, attack: 0.004, decay: dur });
  tone(g, { ...r, t, f0: f * 2.01, type: "sine", gain: gain * 0.32, attack: 0.003, decay: dur * 0.5 });
  tone(g, { ...r, t, f0: f * 3.83, type: "triangle", gain: gain * 0.11, attack: 0.002, decay: dur * 0.26 });
}

export function playBuffer(g: AudioGraph, o: BufferOpts): void {
  const src = g.ac.createBufferSource();
  src.buffer = o.buffer;
  src.playbackRate.value = o.rate ?? 1;
  let node: AudioNode = src;
  if (o.highpass) {
    const hp = g.ac.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = o.highpass;
    node.connect(hp);
    node = hp;
  }
  if (o.lowpass) {
    const lp = g.ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = o.lowpass;
    node.connect(lp);
    node = lp;
  }
  const amp = g.ac.createGain();
  amp.gain.value = Math.max(MIN_GAIN, o.gain);
  node.connect(amp);
  route(g, amp, o);
  src.start(o.t);
  const life = o.buffer.duration / (o.rate ?? 1);
  if (o.release && o.release < life) {
    amp.gain.setValueAtTime(Math.max(MIN_GAIN, o.gain), o.t + o.release * 0.5);
    amp.gain.exponentialRampToValueAtTime(MIN_GAIN, o.t + o.release);
    src.stop(o.t + o.release + 0.02);
  } else {
    src.stop(o.t + life + 0.02);
  }
}

/** Convenience wrapper: honour the voice budget, then fire `fn`. */
export function budgeted(g: AudioGraph, cost: number, critical: boolean, fn: () => void): void {
  if (!takeVoices(g, cost) && !critical) return;
  fn();
}

// ---------------------------------------------------------------------------
// Sample-domain baking
// ---------------------------------------------------------------------------

/**
 * Render `seconds` of mono audio with a per-sample callback. The callback gets
 * the raw Float32Array so it can do anything — feedback, waveshaping, FM —
 * that the node graph would make expensive or impossible.
 */
export function bake(
  ac: BaseAudioContext,
  seconds: number,
  fill: (data: Float32Array, sr: number) => void,
  sampleRate?: number,
): AudioBuffer {
  // An AudioBuffer may run at its own rate; the graph resamples it on playback
  // at no cost to us. Rendering the noisy, long cues at half rate halves their
  // bake time for content that has nothing above 10 kHz in it anyway, and the
  // whole bank has to fit inside the gesture that unlocks the context.
  const sr = Math.max(3000, Math.floor(sampleRate ?? ac.sampleRate));
  const buf = ac.createBuffer(1, Math.max(1, Math.ceil(seconds * sr)), sr);
  const data = buf.getChannelData(0);
  fill(data, sr);
  // Every baked sound gets a short in/out fade: a buffer that starts or ends
  // on a non-zero sample clicks, and the click is louder than the sound.
  edgeFade(data, sr);
  return buf;
}

/** 1 ms in, 4 ms out. Enough to kill the discontinuity, short enough to be inaudible. */
export function edgeFade(data: Float32Array, sr: number): void {
  const inN = Math.min(data.length, Math.floor(sr * 0.001));
  const outN = Math.min(data.length, Math.floor(sr * 0.004));
  for (let i = 0; i < inN; i++) data[i] *= i / inN;
  for (let i = 0; i < outN; i++) data[data.length - 1 - i] *= i / outN;
}

/** Peak-normalise to `peak`, so a program's absolute gains stay comparable. */
export function normalize(data: Float32Array, peak = 0.95): void {
  let m = 0;
  for (let i = 0; i < data.length; i++) {
    const a = data[i] < 0 ? -data[i] : data[i];
    if (a > m) m = a;
  }
  if (m < 1e-6) return;
  const k = peak / m;
  for (let i = 0; i < data.length; i++) data[i] *= k;
}

/** Soft saturation. `drive` above 1 fattens; it is what makes an explosion big. */
export function softClip(data: Float32Array, drive = 1.5): void {
  for (let i = 0; i < data.length; i++) data[i] = Math.tanh(data[i] * drive);
}

/** Exponential decay envelope, 1 → 0 over `tau` seconds of e-folding. */
export function decayEnv(t: number, tau: number): number {
  return Math.exp(-t / tau);
}

/** Percussive envelope: linear attack, exponential decay. */
export function percEnv(t: number, attack: number, tau: number): number {
  if (t < 0) return 0;
  const a = attack > 0 ? Math.min(1, t / attack) : 1;
  return a * Math.exp(-Math.max(0, t - attack) / tau);
}

/** One-pole low-pass state, used inside bake callbacks. */
export function onePole(cutoff: number, sr: number): (x: number) => number {
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
  let y = 0;
  return (x: number) => (y += a * (x - y));
}

/** One-pole high-pass, same deal — it is a low-pass subtracted from the input. */
export function oneHigh(cutoff: number, sr: number): (x: number) => number {
  const lp = onePole(cutoff, sr);
  return (x: number) => x - lp(x);
}

/**
 * A two-pole state-variable band-pass, evaluated per sample so its cutoff can
 * be swept by an arbitrary curve (the tyre squeal and the shell whoosh both do
 * this). `q` around 4–10 is where resonance starts to sing.
 */
export function svfBand(sr: number, q: number): (x: number, f: number) => number {
  let low = 0;
  let band = 0;
  const damp = 1 / Math.max(0.5, q);
  /**
   * The Chamberlin topology is only stable while k = 2·sin(πf/sr) stays below
   * roughly 2 − damp. sr/6 keeps k under 1 with room to spare; asking for a
   * cutoff above that (which a runaway sweep will) otherwise walks the state
   * straight out to Infinity and ships as a click, or as silence.
   */
  const fMax = sr / 6;
  // k is 2·sin(πf/sr); below sr/6 the small-angle form is within a few percent
  // and saves a transcendental per sample, which matters when the whole bank
  // is baked inside a single user gesture.
  const kScale = (2 * Math.PI) / sr;
  return (x: number, f: number) => {
    const k = clamp(f, 10, fMax) * kScale;
    low += k * band;
    const high = x - low - damp * band;
    band += k * high;
    // Belt and braces: a high Q fed an impulse train can still ring hot, and a
    // NaN anywhere upstream must not poison the rest of the buffer. The
    // inverted comparison catches NaN as well as overflow.
    if (!(band > -8 && band < 8)) band = band > 0 ? 8 : -8;
    if (!(low > -8 && low < 8)) low = low > 0 ? 8 : -8;
    return band;
  };
}

/** MIDI note → Hz. A4 = 69 = 440. */
export function noteHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * A rich-but-controlled harmonic stack for the engine tone. Real four-strokes
 * are dominated by the firing order's low harmonics with a spray of upper
 * partials; a plain sawtooth is far too even and reads as a synth pad the
 * moment you sweep it.
 */
export function engineWave(ac: BaseAudioContext, harmonics: number[]): PeriodicWave {
  const n = harmonics.length + 1;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 0; i < harmonics.length; i++) imag[i + 1] = harmonics[i];
  return ac.createPeriodicWave(real, imag, { disableNormalization: false });
}
