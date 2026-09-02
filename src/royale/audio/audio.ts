/**
 * DROP ZERO — audio.
 *
 * Publishes `AudioService`. There is not one audio file in this repo and there
 * never will be: every gunshot, footstep, chest chime, gull, wave and bar of
 * music below is a few hundred lines of arithmetic that gets rendered into an
 * `AudioBuffer` the first time something asks for it, then played back a
 * thousand times as a plain `BufferSourceNode`. Render once, play forever —
 * that trade is the only way a forty-voice firefight runs on a laptop with no
 * network round-trip and no binary assets in git.
 *
 * ── THE GRAPH ─────────────────────────────────────────────────────────────
 *
 *   voice ─▶ air LP ─▶ gain ─▶ panner (HRTF) ─┬─▶ sfxBus ─────────┐
 *                                             └─▶ send ─▶ revIn ──┤
 *   beds  ─▶ bed LP ─▶ bed gain ─▶ ambBus ─▶ ambDuck ─────────────┤
 *   revIn ─▶ tight/wide convolvers ─▶ revOut ─────────────────────┤
 *                                                                 ▼
 *                                          muffle LP ─▶ worldDuck ─▶ master
 *   music ─▶ stem gains ─▶ musicBus ─▶ musicDuck ─────────────────▶ master
 *   ui    ────────────────────────────────────────────────────────▶ master
 *                                             master ─▶ limiter ─▶ destination
 *
 * The limiter is not optional. Six bots opening up inside a 20 m box will
 * stack twenty transients on the same sample and the sum clips into a buzzsaw
 * without a compressor sitting across the bus. It runs hot and fast (4 ms
 * attack, 9:1) because a battle royale is a loud game and we would rather
 * hear the mix pump than hear it distort.
 *
 * ── WHAT MAKES IT READ AS A GAME AND NOT A SOUNDBOARD ─────────────────────
 *
 *  1. **Distance changes timbre, not just level.** Every positional voice
 *     runs through a lowpass whose cutoff collapses with range, and arrives
 *     late by `distance / 343`. That single pair of lines is what makes a
 *     rifle across the island read as *far* rather than as *quiet* — which is
 *     the information a player actually needs when they are trying to work
 *     out which ridge is shooting at them.
 *  2. **The room is in the cue.** Each gun renders twice: once with a long,
 *     bright, sparse slapback for outdoors, once with a short dense dark one
 *     for indoors, and `play()` picks by probing for a ceiling. A shotgun
 *     inside a house has to sound like it is inside a house.
 *  3. **Layered guns.** Every class is primer click + broadband crack + a
 *     tuned body sweep for the calibre + mechanism + environment tail. Drop
 *     any layer and it turns into a cap gun; change the four numbers and an
 *     SMG becomes a sniper. Every class is distinguishable blind.
 *  4. **Nothing repeats exactly.** Cues render 2–4 variants seeded off their
 *     own name, and every trigger jitters playback rate. Machine-gun
 *     repetition of one identical sample is the loudest "web game" tell in
 *     audio, the exact equivalent of uniform roughness in a material.
 *  5. **The bed moves.** Wind rises with fall speed, surf rises as you near
 *     the shore *and* opens its lowpass, insects hand over to crickets at
 *     dusk, birds thin out with the daylight, the storm roars louder the
 *     closer the wall gets. None of it is a static loop at a fixed gain.
 *  6. **Music is a mix, not a track.** One loop, five stems, gated by a
 *     tension value derived from circle number, players alive and how much
 *     shooting has happened near you in the last few seconds. It ducks under
 *     gunfire so it never fights the thing you need to hear.
 *
 * ── SERVICES CONSUMED (lazily, always null-checked) ───────────────────────
 * `player` (listener fallback, velocity for wind, state for glider flap),
 * `terrain` (ground height, sea level, water probe for surf), `collision`
 * (occlusion + the indoor probe), `sky` (daylight drives the day/night bed
 * crossfade), `storm` (roar level + music tension), `match` (phase + alive
 * count for tension), `loot` (nearest pickup drives the chest hum), `pois`
 * (urban weight for the ambience director and the reverb character).
 * Every one may be missing; none is touched at factory time.
 *
 * ── CONTRACT NOTES ────────────────────────────────────────────────────────
 * `AudioService` is deliberately tiny — `play`, `ambience`, `music`,
 * `setListener`, `ready`, `resume`. Everything else this module can do
 * (volume, mute, concussion) is exposed on the wider `DropZeroAudioService`
 * that we actually publish, so a caller holding the narrow interface still
 * type-checks and the HUD can reach the rest by widening.
 */
import * as THREE from "three";
import { makeRng } from "../types";
import type {
  AudioOpts,
  AudioService,
  HarvestKind,
  QualityTier,
  Rarity,
  System,
  SystemFactory,
} from "../types";

// ===========================================================================
// 1. Tunables
// ===========================================================================

/**
 * Hard ceiling on simultaneous one-shot voices. Above this we steal. An
 * uncapped BR mix locks the audio thread outright the first time a squad
 * fights over a chest — every node in the graph is real DSP work.
 */
const VOICE_CAP: Record<QualityTier, number> = { low: 16, medium: 28, high: 44, ultra: 60 };

/** Rendered variants per cue. The cheapest possible fix for repetition. */
const VARIANTS: Record<QualityTier, number> = { low: 1, medium: 2, high: 3, ultra: 4 };

/** Beds are all low-band texture; rendering them at full rate is pure waste. */
const BED_RATE: Record<QualityTier, number> = { low: 16000, medium: 22050, high: 22050, ultra: 32000 };

/** Music is tonal and wants a bit more top than a bed does. */
const MUSIC_RATE: Record<QualityTier, number> = { low: 22050, medium: 22050, high: 32000, ultra: 44100 };

/** Reverb tail lengths (tight, wide) in seconds. Convolution cost is linear. */
const IR_LEN: Record<QualityTier, [number, number]> = {
  low: [0.65, 0],
  medium: [0.95, 1.8],
  high: [1.2, 2.6],
  ultra: [1.4, 3.2],
};

/** Speed of sound, m/s. Distant events arrive late by `distance / this`. */
const SOUND_SPEED = 343;

/**
 * Cap on that delay. Physically a shot 3 km away is 8.7 s late, which reads
 * as a bug rather than as scale — 1.4 s is the most a player will accept.
 */
const MAX_TRAVEL = 1.4;

/** Seconds for the post-blast muffle to recover. */
const CONCUSSION_DECAY = 0.45;

/** How many occlusion raycasts one frame of audio may spend. */
const OCCLUSION_BUDGET = 3;

const TWO_PI = Math.PI * 2;

type Rand = () => number;

/** A synthesised cue: how to render it, and how the world should hear it. */
interface Cue {
  /** Rendered length, seconds. */
  dur: number;
  /**
   * Fills one channel, additively. `indoor` is only meaningful for cues that
   * set `env` — those render a second, differently-reverberated copy.
   */
  render(o: Float32Array, sr: number, rnd: Rand, indoor: boolean): void;
  /** Playback gain. Cues are peak-normalised, so this is pure mix balance. */
  gain?: number;
  /** Normalisation target, 0..1. Lower for background texture. */
  peak?: number;
  /** Distance (m) below which there is no attenuation. */
  ref?: number;
  /** Distance (m) at which the cue is inaudible and gets dropped outright. */
  max?: number;
  /** Inverse-distance rolloff strength. */
  roll?: number;
  /** Air-absorption scale; 0 disables the distance lowpass entirely. */
  air?: number;
  /** Reverb send scale. */
  wet?: number;
  /** Base playback rate. */
  rate?: number;
  /** ± random rate spread per trigger. Zero for anything musical. */
  jitter?: number;
  variants?: number;
  /** Render both channels from decorrelated seeds (stingers, stereo cues). */
  stereo?: boolean;
  /** UI cues bypass the world filters so they stay legible through a blast. */
  bus?: "world" | "ui";
  /** Minimum seconds between retriggers. */
  gap?: number;
  /** Maximum concurrent copies. */
  same?: number;
  /** 0..1 — who survives voice stealing. */
  prio?: number;
  /** Apply speed-of-sound delay. */
  travel?: boolean;
  /** Render an indoor variant too, and pick between them at trigger time. */
  env?: boolean;
  /** How hard this cue ducks the music bus, 0..1. */
  duck?: number;
  /** Render sample-rate override. */
  sr?: number;
}

// ===========================================================================
// 2. The DSP kit
//
// Everything here writes *additively* into a float scratch buffer, allocates
// nothing inside an inner loop, and takes all of its randomness from the
// `rnd` passed in — which is seeded per cue-variant off the cue's own name.
// A given build of the game therefore always sounds identical, which matters
// more than it sounds like: "the shotgun changed" is not a bug you want to
// chase across two machines.
// ===========================================================================

/** Exponential decay. The workhorse envelope; nine tenths of the bank uses it. */
function decay(t: number, tau: number): number {
  return Math.exp(-t / tau);
}

/** Clamp helper — used constantly by the director, so it lives up here. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

interface NoiseOpts {
  t0?: number;
  dur: number;
  amp: number;
  /** Filter cutoff at the start of the layer, Hz. */
  cut0: number;
  /** …and at the end. Swept exponentially — this is what makes noise "fall". */
  cut1?: number;
  /** Resonance. Past ~1.5 it whistles, which is exactly what a whizz wants. */
  res?: number;
  /** Decay time constant. */
  tau: number;
  /** Attack time constant. Stops transients from clicking off the DC line. */
  atk?: number;
  mode?: "low" | "band" | "high";
}

/**
 * Filtered noise through a per-sample state-variable filter. Cracks, blasts,
 * footsteps, surf, wind, dust, cloth and water are all this function with a
 * different cutoff trajectory — the *shape of the sweep* is the sound.
 */
function noiseLayer(o: Float32Array, sr: number, rnd: Rand, p: NoiseOpts): void {
  const t0 = Math.max(0, Math.round((p.t0 ?? 0) * sr));
  const n = Math.min(o.length - t0, Math.ceil(p.dur * sr));
  if (n <= 0) return;
  const tau = Math.max(1e-4, p.tau);
  const atkT = Math.max(1e-5, p.atk ?? 0.0007);
  const q = 1 / Math.max(0.35, p.res ?? 0.9);
  const mode = p.mode ?? "low";
  // The SVF goes unstable as its cutoff approaches Nyquist; 0.24 * sr is the
  // highest we can sweep to and still trust the output at 16 kHz render rates.
  const nyq = sr * 0.24;
  const c0 = Math.max(20, Math.min(nyq, p.cut0));
  const c1 = Math.max(20, Math.min(nyq, p.cut1 ?? p.cut0));
  const slope = Math.log(c1 / c0);
  // Everything that used to be a transcendental per sample is a multiply
  // instead: the cutoff sweep, the decay and the attack are all exponentials
  // in `i`, so they step by a constant factor. This function renders most of
  // the bank, so its inner loop is the whole module's render budget.
  const cutStep = Math.exp(slope / n);
  const decStep = Math.exp(-1 / (tau * sr));
  const atkStep = Math.exp(-1 / (atkT * sr));
  const amp = p.amp;
  let cut = c0;
  let env = 1;
  /** 1 - attack. Starts fully closed and multiplies toward open. */
  let atkRem = 1;
  let f = 2 * Math.sin((Math.PI * cut) / sr);
  let low = 0;
  let band = 0;
  for (let i = 0; i < n; i++) {
    // The filter coefficient only needs refreshing as the sweep moves; every
    // eighth sample is well under a cent of drift even on the steepest sweep
    // in the bank, and it removes 7 of every 8 sine calls.
    if ((i & 7) === 0) f = 2 * Math.sin((Math.PI * (cut < nyq ? cut : nyq)) / sr);
    const x = rnd() * 2 - 1;
    low += f * band;
    const high = x - low - q * band;
    band += f * high;
    const s = mode === "low" ? low : mode === "band" ? band : high;
    o[t0 + i] += s * env * (1 - atkRem) * amp;
    env *= decStep;
    atkRem *= atkStep;
    cut *= cutStep;
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
  shape?: "sine" | "tri" | "saw" | "square";
  /** FM depth in Hz and its modulator rate — grit for sirens and motors. */
  fm?: number;
  fmF?: number;
  /** Vibrato depth as a fraction of the carrier. */
  vib?: number;
  vibF?: number;
  /** Starting phase, for stacking partials that must not all start at zero. */
  phase?: number;
}

/** A damped, gliding oscillator: body thumps, sub drops, sirens, whines. */
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
  // Same trick as `noiseLayer`: the glide, the decay and the attack are all
  // geometric in `i`, so none of them needs an exp() per sample.
  const fStep = Math.exp(slope / n);
  const decStep = Math.exp(-1 / (tau * sr));
  const atkStep = Math.exp(-1 / (atkT * sr));
  const nyqLimit = sr * 0.45;
  const amp = p.amp;
  let base = f0;
  let env = 1;
  let atkRem = 1;
  let phase = p.phase ?? 0;
  let fmPhase = 0;
  let vibPhase = 0;
  for (let i = 0; i < n; i++) {
    let f = base;
    if (p.vib) {
      vibPhase += (TWO_PI * (p.vibF ?? 6)) / sr;
      f *= 1 + Math.sin(vibPhase) * p.vib;
    }
    if (p.fm) {
      fmPhase += (TWO_PI * (p.fmF ?? f * 1.4)) / sr;
      f += Math.sin(fmPhase) * p.fm;
    }
    phase += (TWO_PI * (f < 1 ? 1 : f > nyqLimit ? nyqLimit : f)) / sr;
    if (phase > TWO_PI) phase -= TWO_PI;
    const norm = phase / TWO_PI;
    let s: number;
    if (shape === "sine") s = Math.sin(phase);
    else if (shape === "tri") s = 1 - 4 * Math.abs(Math.round(norm) - norm);
    else if (shape === "square") s = norm < 0.5 ? 1 : -1;
    else s = 2 * norm - 1;
    o[t0 + i] += s * env * (1 - atkRem) * amp;
    env *= decStep;
    atkRem *= atkStep;
    base *= fStep;
  }
}

/**
 * Inharmonic partial ratios. These specific numbers are the difference
 * between "bell" (harmonic, musical) and "struck metal" (inharmonic, sour) —
 * a shell casing that rings a major triad sounds like a xylophone.
 */
const METAL_PARTIALS = [1, 2.756, 5.404, 8.933, 13.34];
/** Wood is far more harmonic and dies much faster. */
const WOOD_PARTIALS = [1, 2.12, 3.41, 5.02];
/** Glass: bright, close to harmonic, very long. */
const GLASS_PARTIALS = [1, 2.02, 3.06, 4.11, 5.4];

interface ModalOpts {
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

/** A struck resonator: casings, hull hits, glass, bolt clacks, pickaxe rings. */
function modalLayer(o: Float32Array, sr: number, rnd: Rand, p: ModalOpts): void {
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
    if (n <= 0) continue;
    const w = (TWO_PI * f) / sr;
    const ph0 = rnd() * TWO_PI;
    // A damped sinusoid is the impulse response of a two-pole resonator, so
    // the whole partial comes out of a two-term recurrence with no sin() and
    // no exp() in the loop. Chimes and casings stack a dozen of these, and
    // the naive form was the single most expensive thing in the bank.
    const r = Math.exp(-1 / (tau * sr));
    const c = 2 * r * Math.cos(w);
    const r2 = r * r;
    let y0 = amp * Math.sin(ph0);
    let y1 = amp * r * Math.sin(ph0 + w);
    o[t0] += y0;
    if (n > 1) o[t0 + 1] += y1;
    for (let i = 2; i < n; i++) {
      const y = c * y1 - r2 * y0;
      o[t0 + i] += y;
      y0 = y1;
      y1 = y;
    }
  }
}

interface GrainOpts {
  t0?: number;
  dur: number;
  count: number;
  amp: number;
  /** Grain centre-frequency range. */
  f0: number;
  f1: number;
  tau: number;
  kind?: "tick" | "ping";
  /** 0 = uniform over the window, 1 = heavily front-loaded. */
  clump?: number;
}

/** Sparse scattered micro-events: debris rain, splinters, gravel, bubbles. */
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
      modalLayer(o, sr, rnd, {
        t0: t, freq: f, amp, tau: p.tau * (0.5 + rnd()), partials: [1, 2.4], damp: 0.5,
      });
    } else {
      noiseLayer(o, sr, rnd, {
        t0: t, dur: p.tau * 6, amp, cut0: f * 1.8, cut1: f * 0.5,
        tau: p.tau * (0.4 + rnd()), res: 1.3, mode: "band",
      });
    }
  }
}

interface SlapOpts {
  /** Delay time of the first reflection, seconds. */
  delay: number;
  /** 0..0.9. How much of each reflection feeds the next. */
  feedback: number;
  /** One-pole damping cutoff inside the loop, Hz — the room's absorption. */
  damp: number;
  /** How much of the wet path is added back. */
  mix: number;
  /** Delay only starts contributing after this (the direct sound is dry). */
  t0?: number;
}

/**
 * A damped feedback comb, run in place. This is the environment baked into
 * the cue itself, so even the *dry* path has depth — the convolver on the bus
 * is a global sweetener, not the only room in the mix.
 *
 * Indoors wants a short delay with heavy feedback and a low damping cutoff
 * (a small hard box smears fast and eats treble). Outdoors wants a long
 * sparse delay with almost no feedback and much more top (a hillside answers
 * once, brightly, and then shuts up).
 */
function slapback(o: Float32Array, sr: number, p: SlapOpts): void {
  const d = Math.max(2, Math.round(p.delay * sr));
  if (d >= o.length) return;
  const line = new Float32Array(d);
  const fb = Math.max(0, Math.min(0.92, p.feedback));
  const coef = 1 - Math.exp((-TWO_PI * Math.max(120, p.damp)) / sr);
  const start = Math.max(0, Math.round((p.t0 ?? 0) * sr));
  let idx = 0;
  let lp = 0;
  for (let i = start; i < o.length; i++) {
    const y = line[idx];
    lp += (y - lp) * coef;
    line[idx] = o[i] + lp * fb;
    idx = idx + 1 >= d ? 0 : idx + 1;
    o[i] += lp * p.mix;
  }
}

/**
 * Padé approximant of tanh, exact at 0 and at ±3 where it is clamped. Within
 * 0.3% of the real thing over the whole range and about eight times faster,
 * which matters because saturation runs over every sample of every cue that
 * has any drive on it.
 */
function fastTanh(x: number): number {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/** Soft saturation. Drives transients into the ceiling instead of clipping. */
function saturate(o: Float32Array, amount: number): void {
  const k = Math.tanh(amount);
  for (let i = 0; i < o.length; i++) {
    const v = o[i];
    o[i] = Number.isFinite(v) ? fastTanh(v * amount) / k : 0;
  }
}

/**
 * One-pole DC blocker, ~3 Hz corner.
 *
 * Water is the one family in this bank that needs it. A soaker is heavily
 * lowpassed noise — the SVF's low output has a random walk in it below the
 * cutoff — driven through a saturator, and both of those bias the signal off
 * zero. One jet sitting 1% off the line is inaudible; ten of them summing on
 * the same bus during a firefight is 10% of the limiter's headroom spent on
 * silence, plus a click at every voice start and stop. Measured before and
 * after on `soak-hose`: -1.03e-2 → under 1e-4.
 */
function dcBlock(o: Float32Array, sr: number): void {
  const r = 1 - 20 / sr;
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < o.length; i++) {
    const x = o[i];
    y1 = x - x1 + r * y1;
    x1 = x;
    o[i] = y1;
  }
}

/** Peak-normalise so every cue arrives at the mixer at a known level. */
function normalise(o: Float32Array, target: number): void {
  let peak = 0;
  for (let i = 0; i < o.length; i++) {
    if (!Number.isFinite(o[i])) o[i] = 0;
    const a = Math.abs(o[i]);
    if (a > peak) peak = a;
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

/** …and the first few, for cues that start mid-swell. */
function fadeIn(o: Float32Array, sr: number, ms = 4): void {
  const n = Math.min(o.length, Math.round((ms / 1000) * sr));
  for (let i = 0; i < n; i++) o[i] *= i / n;
}

interface PluckOpts {
  t0: number;
  freq: number;
  amp: number;
  dur: number;
  /** 0..1 — how fast the string loses its high partials. */
  damp?: number;
  /** 0..1 — how bright the initial excitation is. */
  bright?: number;
}

/**
 * Karplus–Strong. A noise burst in a delay line with a one-pole lowpass in
 * the feedback path — thirty lines of code that sound like a plucked string,
 * which is why the music bed can afford a real arpeggio instead of a stack of
 * sine beeps. Sine-beep melodies are the audio equivalent of untextured
 * solid-colour geometry.
 */
function ksPluck(o: Float32Array, sr: number, rnd: Rand, p: PluckOpts): void {
  const n = Math.max(2, Math.round(sr / Math.max(20, p.freq)));
  const start = Math.max(0, Math.round(p.t0 * sr));
  const total = Math.min(o.length - start, Math.ceil(p.dur * sr));
  if (total <= 0) return;
  const line = new Float32Array(n);
  // Excitation: noise, pre-filtered so a dull pluck starts dull rather than
  // starting bright and being filtered afterwards.
  const bright = p.bright ?? 0.6;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const x = rnd() * 2 - 1;
    prev += (x - prev) * (0.15 + bright * 0.85);
    line[i] = prev;
  }
  const rho = 0.985 + (p.damp ?? 0.5) * 0.0145;
  let idx = 0;
  for (let i = 0; i < total; i++) {
    const cur = line[idx];
    const nxt = line[idx + 1 >= n ? 0 : idx + 1];
    const y = 0.5 * (cur + nxt) * rho;
    line[idx] = y;
    idx = idx + 1 >= n ? 0 : idx + 1;
    o[start + i] += cur * p.amp * decay(i / sr, p.dur * 0.45);
  }
}

/**
 * Snap a frequency so that a whole number of cycles fits the loop length.
 * A music loop whose oscillators do not close the loop clicks once per bar,
 * and nothing sounds cheaper than a click on the downbeat.
 */
function loopSnap(freq: number, dur: number): number {
  return Math.max(1, Math.round(freq * dur)) / dur;
}

/** Equal temperament from a root, in semitones. */
function semi(root: number, n: number): number {
  return root * Math.pow(2, n / 12);
}

// ===========================================================================
// 3. Cue recipes
//
// Factories first — a gun, an impact and a clack cover about half the bank
// between them, and keeping them as parameterised recipes is what makes nine
// weapon classes distinguishable rather than nine copies of one sound.
// ===========================================================================

interface GunSpec {
  dur: number;
  /** Muzzle blast: broadband, loudest, shortest. */
  crackAmp: number;
  crackCut: number;
  crackTau: number;
  /** Chamber body — the sine drop that *is* the calibre. */
  bodyAmp: number;
  bodyF0: number;
  bodyF1: number;
  bodyTau: number;
  /** Mechanical action: bolt, hammer, striker. */
  mechAmp: number;
  mechFreq: number;
  /** How much environment tail this weapon throws. */
  tailAmp: number;
  tailTau: number;
  tailCut: number;
  drive: number;
  /** Supersonic whipcrack after the muzzle blast — rifles have it, pistols don't. */
  whip?: number;
}

/**
 * The anatomy of a gunshot, in order of arrival:
 *
 *   0 ms   primer strike — a 1 ms high transient. Sets perceived attack speed.
 *   0 ms   muzzle blast — broadband noise whose cutoff collapses ~7:1 over
 *          30 ms. That collapse is the gas ball expanding; without the sweep
 *          it is a hiss, with it, it is a bang.
 *   1 ms   body — a sine glide down through the calibre. 158→47 Hz is a
 *          rifle; 118→33 Hz is a shotgun; 205→64 Hz is a pistol.
 *   4 ms   whipcrack — the supersonic round leaving. Only on rifles.
 *   6 ms   action — inharmonic metal, the bolt.
 *   30 ms+ environment — a damped comb, tuned by `indoor`.
 *
 * Every layer is load-bearing. Delete the body and it is a firecracker;
 * delete the tail and it is a foley recording in an anechoic chamber.
 */
function makeGun(s: GunSpec) {
  return (o: Float32Array, sr: number, rnd: Rand, indoor: boolean): void => {
    noiseLayer(o, sr, rnd, {
      dur: 0.012, amp: 0.9, cut0: sr * 0.22, cut1: 4000, tau: 0.0016, atk: 0.00004, mode: "high",
    });
    noiseLayer(o, sr, rnd, {
      dur: 0.22, amp: s.crackAmp, cut0: s.crackCut, cut1: s.crackCut * 0.14,
      tau: s.crackTau, res: 1.25, atk: 0.00012,
    });
    noiseLayer(o, sr, rnd, {
      dur: 0.15, amp: s.crackAmp * 0.5, cut0: s.crackCut * 1.6, cut1: s.crackCut * 0.6,
      tau: s.crackTau * 0.55, res: 0.8, mode: "high", atk: 0.00008,
    });
    toneLayer(o, sr, rnd, {
      dur: Math.min(s.dur, 0.5), amp: s.bodyAmp, f0: s.bodyF0, f1: s.bodyF1,
      tau: s.bodyTau, atk: 0.0004,
    });
    // Second harmonic of the body, detuned down — gives the calibre weight
    // without simply making the fundamental louder and muddier.
    toneLayer(o, sr, rnd, {
      dur: Math.min(s.dur, 0.5), amp: s.bodyAmp * 0.34, f0: s.bodyF0 * 1.98, f1: s.bodyF1 * 1.5,
      tau: s.bodyTau * 0.6, atk: 0.0004,
    });
    if (s.whip) {
      noiseLayer(o, sr, rnd, {
        t0: 0.004, dur: 0.06, amp: s.whip, cut0: 11000, cut1: 3200, tau: 0.006,
        res: 1.6, mode: "band", atk: 0.00005,
      });
    }
    if (s.mechAmp > 0) {
      modalLayer(o, sr, rnd, { t0: 0.006, freq: s.mechFreq, amp: s.mechAmp, tau: 0.024, damp: 0.55 });
    }

    // Environment. Indoors: near delay, heavy feedback, dark. Outdoors: a
    // long sparse pair of slaps off whatever is out there, much brighter.
    if (indoor) {
      slapback(o, sr, { delay: 0.019, feedback: 0.66, damp: 1500, mix: s.tailAmp * 2.3, t0: 0.002 });
      noiseLayer(o, sr, rnd, {
        t0: 0.03, dur: s.dur - 0.03, amp: s.tailAmp * 0.85, cut0: s.tailCut * 0.7,
        cut1: s.tailCut * 0.2, tau: s.tailTau * 0.7, res: 0.8, atk: 0.004,
      });
    } else {
      slapback(o, sr, { delay: 0.071, feedback: 0.34, damp: 3400, mix: s.tailAmp * 1.1, t0: 0.004 });
      const taps: [number, number][] = [[0.041, 1], [0.098, 0.6], [0.187, 0.31], [0.33, 0.15]];
      for (const [t, a] of taps) {
        if (t >= s.dur) continue;
        noiseLayer(o, sr, rnd, {
          t0: t, dur: s.dur - t, amp: s.tailAmp * a, cut0: s.tailCut * a,
          cut1: s.tailCut * 0.26 * a, tau: s.tailTau * (1.7 - a * 0.5), res: 0.7, atk: 0.005,
        });
      }
    }
    saturate(o, s.drive);
    fadeOut(o, sr, 10);
  };
}

/** One recipe covers every surface in the world; only the numbers change. */
function makeImpact(
  thumpF: number, thumpTau: number, thumpAmp: number,
  gritCut: number, gritTau: number, gritAmp: number,
  ring?: { freq: number; amp: number; tau: number; partials?: number[] },
) {
  return (o: Float32Array, sr: number, rnd: Rand): void => {
    // The click is what says "something arrived"; the rest says what it hit.
    noiseLayer(o, sr, rnd, {
      dur: 0.01, amp: 0.55, cut0: sr * 0.2, cut1: 6000, tau: 0.0014, atk: 0.00005, mode: "high",
    });
    toneLayer(o, sr, rnd, { dur: 0.3, amp: thumpAmp, f0: thumpF, f1: thumpF * 0.5, tau: thumpTau, atk: 0.0006 });
    noiseLayer(o, sr, rnd, {
      dur: 0.4, amp: gritAmp, cut0: gritCut, cut1: gritCut * 0.2, tau: gritTau, res: 1.05, atk: 0.0002,
    });
    if (ring) {
      modalLayer(o, sr, rnd, {
        t0: 0.002, freq: ring.freq, amp: ring.amp, tau: ring.tau, partials: ring.partials,
      });
    }
    saturate(o, 1.5);
    fadeOut(o, sr, 8);
  };
}

/** A dry mechanical clack — the atom of every reload and every build cue. */
function clack(o: Float32Array, sr: number, rnd: Rand, t0: number, amp: number, freq: number, tau = 0.02): void {
  noiseLayer(o, sr, rnd, {
    t0, dur: 0.03, amp: amp * 0.8, cut0: freq * 3.2, cut1: freq * 0.8,
    tau: tau * 0.4, res: 1.1, mode: "band", atk: 0.00006,
  });
  modalLayer(o, sr, rnd, { t0, freq, amp: amp * 0.7, tau, damp: 0.5, partials: [1, 2.4, 4.1] });
  // A little sub under the clack: real mechanisms are bolted to something.
  toneLayer(o, sr, rnd, { t0, dur: 0.12, amp: amp * 0.35, f0: freq * 0.16, f1: freq * 0.09, tau: 0.03 });
}

/** An ascending arpeggio of struck-bell partials. Chests, victory, pickups. */
function chime(
  o: Float32Array, sr: number, rnd: Rand,
  notes: number[], t0: number, step: number, amp: number, tau: number,
): void {
  for (let i = 0; i < notes.length; i++) {
    modalLayer(o, sr, rnd, {
      t0: t0 + i * step, freq: notes[i], amp: amp * (1 - i * 0.08),
      tau: tau * (1 + i * 0.15), partials: [1, 2.01, 3.02, 5.1], damp: 0.55, detune: 0.004,
    });
    // A sine doubling the fundamental keeps it musical rather than clangy.
    // Capped at 1.2 s: past three time constants it is 5% of its peak and
    // buried under the modal partials, so the samples are pure render cost.
    toneLayer(o, sr, rnd, {
      t0: t0 + i * step, dur: Math.min(tau * 3, 1.2), amp: amp * 0.45, f0: notes[i], f1: notes[i],
      tau: tau * 0.8, atk: 0.002,
    });
  }
}

/** A cloth/air movement: band-passed noise sweeping up then down. */
function whoosh(o: Float32Array, sr: number, rnd: Rand, dur: number, amp: number, lo: number, hi: number): void {
  noiseLayer(o, sr, rnd, {
    dur: dur * 0.6, amp, cut0: lo, cut1: hi, tau: dur * 0.32, res: 1.5, mode: "band", atk: dur * 0.08,
  });
  noiseLayer(o, sr, rnd, {
    t0: dur * 0.35, dur: dur * 0.65, amp: amp * 0.55, cut0: hi, cut1: lo * 0.8,
    tau: dur * 0.22, res: 1.4, mode: "band", atk: dur * 0.05,
  });
}

// ===========================================================================
// 3b. SPLASH ROYALE recipes
//
// A soaker is not a gun and must never be built like one. A gunshot is a
// pressure *step*: everything that matters happens in the first 30 ms and the
// rest is the room answering. A water gun is the opposite — it is a
// *sustain*, and the information lives in the middle of the sound rather than
// at the front of it. So the envelope here has a soft nose and a real body,
// and the layers stand in for five physical things:
//
//   valve   the trigger opening on a pressurised tank — a chuff of air
//   jet     the stream: band-passed noise, where the band IS the nozzle bore
//   throat  the water column still in the barrel — a low burble underneath
//   spray   droplets leaving the stream and arriving somewhere
//   mech    the plastic of the thing, because it is a toy and should sound it
//
// Every water weapon in `mode/water.ts` is those five with different numbers,
// exactly the way every firearm is `makeGun` with different numbers. Keep the
// separation on the same four axes the guns use — band centre, band width,
// burble pitch and sustain length — so a Hydro Lance and a Firehose stay
// distinguishable through 200 m of air absorption and not just up close.
// ===========================================================================

interface SoakerSpec {
  dur: number;
  /** Valve chuff: displaced air, ahead of the water. */
  valveAmp: number;
  valveCut: number;
  /** The jet. `jetCut0 → jetCut1` is the nozzle losing pressure as the pull ends. */
  jetAmp: number;
  jetCut0: number;
  jetCut1: number;
  /** Band resonance. High = a tight needle of a jet; low = a broad wash. */
  jetRes: number;
  jetTau: number;
  /** Attack. Never below ~1 ms — a firing-pin attack on water reads as a gun. */
  jetAtk: number;
  /** The column in the barrel: a low burble, FM'd so it gurgles. */
  burbleF: number;
  burbleAmp: number;
  /** Droplet count and level. */
  spray: number;
  sprayAmp: number;
  /** Plastic mechanism — modal, but on wood partials: plastic is not metal. */
  mechAmp: number;
  mechFreq: number;
  drive: number;
  /** Optional displaced-air thump. This is what makes the Pump Blaster WHUMP. */
  thumpAmp?: number;
  thumpF?: number;
  thumpTau?: number;
  /** Environment tail level. Water throws far less room than a muzzle blast. */
  tailAmp?: number;
}

function makeSoaker(s: SoakerSpec) {
  return (o: Float32Array, sr: number, rnd: Rand, indoor: boolean): void => {
    // Air first, water second. The chuff is the only fast thing in the cue and
    // it is what stops a soaker sounding like a kettle.
    noiseLayer(o, sr, rnd, {
      dur: 0.04, amp: s.valveAmp, cut0: s.valveCut, cut1: s.valveCut * 0.28,
      tau: 0.007, res: 1.1, mode: "high", atk: 0.0005,
    });
    if (s.thumpAmp) {
      toneLayer(o, sr, rnd, {
        dur: 0.35, amp: s.thumpAmp, f0: s.thumpF ?? 128, f1: (s.thumpF ?? 128) * 0.33,
        tau: s.thumpTau ?? 0.07, atk: 0.0016,
      });
    }
    // The stream itself, twice: a bright band for the hiss and a broader,
    // darker layer under it for the wet. One alone is a hiss OR a rumble; the
    // pair is water under pressure.
    noiseLayer(o, sr, rnd, {
      dur: s.dur, amp: s.jetAmp, cut0: s.jetCut0, cut1: s.jetCut1,
      tau: s.jetTau, res: s.jetRes, mode: "band", atk: s.jetAtk,
    });
    noiseLayer(o, sr, rnd, {
      dur: s.dur * 0.85, amp: s.jetAmp * 0.5, cut0: s.jetCut0 * 0.36, cut1: s.jetCut1 * 0.45,
      tau: s.jetTau * 1.25, res: 0.7, atk: s.jetAtk * 1.7,
    });
    // Throat burble. The FM is doing all the work — an unmodulated sine here
    // is a test tone, and a test tone under noise is the cheapest sound there
    // is. 43 Hz modulation is slow enough to hear as gurgle, not as timbre.
    toneLayer(o, sr, rnd, {
      dur: Math.min(s.dur, 0.55), amp: s.burbleAmp, f0: s.burbleF, f1: s.burbleF * 0.52,
      tau: s.jetTau * 0.95, atk: 0.0025, fm: s.burbleF * 0.7, fmF: 43, vib: 0.06, vibF: 17,
    });
    if (s.spray > 0) {
      grainLayer(o, sr, rnd, {
        t0: 0.012, dur: s.dur * 0.7, count: s.spray, amp: s.sprayAmp,
        f0: 900, f1: 5200, tau: 0.007, kind: "ping", clump: 0.5,
      });
    }
    if (s.mechAmp > 0) {
      modalLayer(o, sr, rnd, {
        t0: 0.002, freq: s.mechFreq, amp: s.mechAmp, tau: 0.016,
        partials: WOOD_PARTIALS, damp: 0.4, detune: 0.03,
      });
    }
    const tail = s.tailAmp ?? 0.12;
    if (indoor) {
      slapback(o, sr, { delay: 0.021, feedback: 0.6, damp: 1300, mix: tail * 2, t0: 0.004 });
    } else {
      slapback(o, sr, { delay: 0.079, feedback: 0.28, damp: 3000, mix: tail * 0.85, t0: 0.006 });
    }
    saturate(o, s.drive);
    dcBlock(o, sr);
    fadeOut(o, sr, 12);
  };
}

/**
 * Water arriving on something. The most reused shape in the mode, and the one
 * worth getting right: `size` scales the whole event, with frequencies going
 * DOWN as times go UP. That inverse relationship is the entire difference
 * between a splat and a splash — a bigger mass of water is a lower, slower,
 * wider version of the same four layers, never a louder one.
 *
 *   0.55  a droplet cluster        1.0  a water balloon
 *   1.6   a bucket                 2.4  a person coming apart into water
 */
function wetSlap(o: Float32Array, sr: number, rnd: Rand, t0: number, amp: number, size: number): void {
  const k = 1 / size;
  const t = size;
  // Contact. Broadband and immediately dark: water has no ring at all, which
  // is exactly what separates it from every impact cue above.
  noiseLayer(o, sr, rnd, {
    t0, dur: 0.32 * t, amp, cut0: 5200 * k, cut1: 300 * k, tau: 0.045 * t, res: 1.15, atk: 0.0005,
  });
  // The mass behind the contact.
  toneLayer(o, sr, rnd, {
    t0, dur: 0.4 * t, amp: amp * 0.55, f0: 168 * k, f1: 46 * k, tau: 0.075 * t, atk: 0.0014,
  });
  // The sheet fanning out sideways: a band that OPENS. A closing band would
  // read as another impact; an opening one reads as spreading.
  noiseLayer(o, sr, rnd, {
    t0: t0 + 0.02 * t, dur: 0.55 * t, amp: amp * 0.42, cut0: 520 * k, cut1: 2700 * k,
    tau: 0.17 * t, res: 0.85, mode: "band", atk: 0.014 * t,
  });
  // …and the rain of it coming back down.
  grainLayer(o, sr, rnd, {
    t0: t0 + 0.03 * t, dur: 0.6 * t, count: Math.round(15 * size), amp: amp * 0.3,
    f0: 700 * k, f1: 4400 * k, tau: 0.01 * t, kind: "ping", clump: 0.8,
  });
}

/** A gulp of water moving through a pipe or a neck. Refills, dunks, glue. */
function glug(o: Float32Array, sr: number, rnd: Rand, t0: number, amp: number, count: number, span: number): void {
  for (let i = 0; i < count; i++) {
    const t = t0 + (i / count) * span + rnd() * 0.02;
    const f = 150 + rnd() * 260;
    // A bloop is a RISING cavity resonance — the bubble closing behind itself.
    toneLayer(o, sr, rnd, { t0: t, dur: 0.1, amp: amp * (0.6 + rnd() * 0.5), f0: f, f1: f * 2.6, tau: 0.022, atk: 0.0016 });
    noiseLayer(o, sr, rnd, { t0: t, dur: 0.06, amp: amp * 0.3, cut0: 1600, cut1: 500, tau: 0.012, res: 1.4, mode: "band", atk: 0.0008 });
  }
}

/**
 * Rain on everything: the texture the Downpour is built out of. `atk` is the
 * swell — short for weather that is already here, long for weather arriving.
 */
function rainLayer(
  o: Float32Array, sr: number, rnd: Rand, t0: number, dur: number,
  amp: number, cut: number, drops: number, atk = 0.02,
): void {
  noiseLayer(o, sr, rnd, { t0, dur, amp: amp * 0.7, cut0: cut, cut1: cut * 0.75, tau: dur * 0.9, res: 0.8, atk });
  noiseLayer(o, sr, rnd, { t0, dur, amp: amp * 0.4, cut0: cut * 0.16, cut1: cut * 0.13, tau: dur * 0.95, res: 0.7, atk: atk * 2 });
  // The patter. Without discrete drops on top, broadband noise is a fan, not
  // rain — this layer is the whole read and it is cheap.
  grainLayer(o, sr, rnd, { t0, dur, count: drops, amp: amp * 0.5, f0: 1400, f1: 7000, tau: 0.004, kind: "tick", clump: 0 });
}

// ===========================================================================
// 4. The cue bank
//
// Names match what the other twelve systems already call. Comments name the
// physical thing each layer stands in for, because that is how you debug a
// sound that "feels wrong" — you ask which part of the object is missing.
// ===========================================================================

const CUES: Record<string, Cue> = {
  // --- Weapons -------------------------------------------------------------
  // Each class is separated on four axes at once — crack brightness, body
  // pitch, body decay and tail length — so they stay distinguishable through
  // a lowpass at 300 m, not just up close.
  "shot-ar": {
    dur: 0.85, gain: 1, ref: 16, max: 1500, wet: 1.1, prio: 0.85, gap: 0.02, same: 5,
    travel: true, env: true, duck: 0.5,
    render: makeGun({
      dur: 0.85, crackAmp: 1, crackCut: 8200, crackTau: 0.032, bodyAmp: 0.72,
      bodyF0: 156, bodyF1: 46, bodyTau: 0.055, mechAmp: 0.2, mechFreq: 3150,
      tailAmp: 0.26, tailTau: 0.25, tailCut: 2400, drive: 2, whip: 0.34,
    }),
  },
  "shot-smg": {
    dur: 0.55, gain: 0.82, ref: 13, max: 1100, wet: 0.9, prio: 0.8, gap: 0.014, same: 6,
    jitter: 0.07, travel: true, env: true, duck: 0.42,
    render: makeGun({
      // Smaller round: the body sits an octave up and dies in half the time,
      // and there is far more mechanism in the mix because the bolt is doing
      // most of the work at that rate of fire.
      dur: 0.55, crackAmp: 0.86, crackCut: 9400, crackTau: 0.019, bodyAmp: 0.44,
      bodyF0: 232, bodyF1: 88, bodyTau: 0.028, mechAmp: 0.34, mechFreq: 3900,
      tailAmp: 0.17, tailTau: 0.14, tailCut: 2700, drive: 1.8, whip: 0.2,
    }),
  },
  "shot-burst": {
    dur: 0.72, gain: 0.92, ref: 15, max: 1300, wet: 1, prio: 0.82, gap: 0.016, same: 5,
    travel: true, env: true, duck: 0.46,
    render: makeGun({
      dur: 0.72, crackAmp: 0.94, crackCut: 8800, crackTau: 0.026, bodyAmp: 0.6,
      bodyF0: 178, bodyF1: 58, bodyTau: 0.042, mechAmp: 0.24, mechFreq: 3400,
      tailAmp: 0.22, tailTau: 0.2, tailCut: 2500, drive: 1.95, whip: 0.3,
    }),
  },
  "shot-pistol": {
    dur: 0.58, gain: 0.84, ref: 12, max: 900, wet: 0.9, prio: 0.78, gap: 0.02, same: 4,
    travel: true, env: true, duck: 0.38,
    render: makeGun({
      dur: 0.58, crackAmp: 0.84, crackCut: 6400, crackTau: 0.025, bodyAmp: 0.5,
      bodyF0: 205, bodyF1: 64, bodyTau: 0.04, mechAmp: 0.26, mechFreq: 2450,
      tailAmp: 0.19, tailTau: 0.15, tailCut: 2000, drive: 1.7,
    }),
  },
  "shot-pump": {
    dur: 1.3, gain: 1.06, ref: 18, max: 1500, wet: 1.2, prio: 0.92, gap: 0.05, same: 3,
    travel: true, env: true, duck: 0.75,
    render: makeGun({
      // Low, fat, slow. The body is the lowest of any weapon and the tail is
      // the longest — a pump going off indoors should feel like a mistake.
      dur: 1.3, crackAmp: 0.95, crackCut: 5000, crackTau: 0.072, bodyAmp: 1,
      bodyF0: 114, bodyF1: 31, bodyTau: 0.125, mechAmp: 0.14, mechFreq: 1750,
      tailAmp: 0.35, tailTau: 0.44, tailCut: 1700, drive: 2.35,
    }),
  },
  "shot-tac": {
    dur: 1.0, gain: 0.98, ref: 16, max: 1300, wet: 1.1, prio: 0.88, gap: 0.03, same: 4,
    travel: true, env: true, duck: 0.62,
    render: makeGun({
      dur: 1.0, crackAmp: 0.92, crackCut: 6200, crackTau: 0.05, bodyAmp: 0.86,
      bodyF0: 140, bodyF1: 42, bodyTau: 0.09, mechAmp: 0.2, mechFreq: 2100,
      tailAmp: 0.3, tailTau: 0.32, tailCut: 1900, drive: 2.2,
    }),
  },
  "shot-sniper": {
    dur: 2.0, gain: 1.1, ref: 24, max: 2400, roll: 0.68, wet: 1.5, prio: 0.98, gap: 0.15,
    same: 2, travel: true, env: true, duck: 0.9,
    render: makeGun({
      // The loudest thing a player carries. Huge whipcrack, deep body, and a
      // tail that carries across the whole island — this is the cue that
      // tells everyone on the map that someone has a scope.
      dur: 2.0, crackAmp: 1, crackCut: 10500, crackTau: 0.045, bodyAmp: 0.9,
      bodyF0: 132, bodyF1: 34, bodyTau: 0.1, mechAmp: 0.18, mechFreq: 2700,
      tailAmp: 0.44, tailTau: 0.7, tailCut: 2600, drive: 2.3, whip: 0.55,
    }),
  },
  "shot-minigun": {
    dur: 0.4, gain: 0.78, ref: 14, max: 1200, wet: 0.8, prio: 0.74, gap: 0.012, same: 6,
    jitter: 0.09, travel: true, env: true, duck: 0.4,
    render: makeGun({
      dur: 0.4, crackAmp: 0.85, crackCut: 9200, crackTau: 0.016, bodyAmp: 0.45,
      bodyF0: 186, bodyF1: 74, bodyTau: 0.026, mechAmp: 0.32, mechFreq: 4200,
      tailAmp: 0.15, tailTau: 0.11, tailCut: 2600, drive: 1.8,
    }),
  },
  "shot-rocket": {
    dur: 2.0, gain: 1, ref: 22, max: 1800, wet: 1.2, prio: 0.95, gap: 0.1, same: 2,
    travel: true, duck: 0.85,
    render: (o, sr, rnd) => {
      // Ignition crack, then a pressurised hiss that *opens up* as the motor
      // clears the tube. The rising cutoff on a fading layer is the whole
      // trick — falling cutoff would read as an explosion instead.
      noiseLayer(o, sr, rnd, { dur: 0.09, amp: 0.9, cut0: 7000, cut1: 900, tau: 0.028, res: 1.2, atk: 0.0002 });
      toneLayer(o, sr, rnd, { dur: 0.6, amp: 0.85, f0: 132, f1: 38, tau: 0.16, atk: 0.001 });
      noiseLayer(o, sr, rnd, { t0: 0.02, dur: 1.7, amp: 0.75, cut0: 480, cut1: 2600, tau: 0.44, res: 0.75, atk: 0.02 });
      noiseLayer(o, sr, rnd, { t0: 0.05, dur: 1.6, amp: 0.4, cut0: 180, cut1: 90, tau: 0.55, atk: 0.03 });
      grainLayer(o, sr, rnd, { t0: 0.03, dur: 0.5, count: 14, amp: 0.18, f0: 1800, f1: 6000, tau: 0.012, kind: "tick" });
      saturate(o, 1.9);
      fadeOut(o, sr, 30);
    },
  },

  // --- Explosions ----------------------------------------------------------
  explosion: {
    dur: 3.6, gain: 1.18, ref: 45, max: 2800, roll: 0.6, wet: 1.6, prio: 1, gap: 0.03,
    same: 4, travel: true, variants: 3, duck: 1,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.02, amp: 0.9, cut0: sr * 0.22, cut1: 5000, tau: 0.003, atk: 0.00004, mode: "high" });
      noiseLayer(o, sr, rnd, { dur: 0.35, amp: 1, cut0: 9500, cut1: 1100, tau: 0.055, res: 1.2, atk: 0.00015 });
      // Fireball body — the cutoff collapse *is* the expanding gas front.
      noiseLayer(o, sr, rnd, { dur: 1.4, amp: 1, cut0: 2600, cut1: 150, tau: 0.36, res: 1.1, atk: 0.0012 });
      // Sub drop. Felt rather than heard, and the reason near blasts read big.
      toneLayer(o, sr, rnd, { dur: 1.2, amp: 0.95, f0: 98, f1: 24, tau: 0.5, atk: 0.0025 });
      toneLayer(o, sr, rnd, { t0: 0.05, dur: 1.4, amp: 0.4, f0: 56, f1: 19, tau: 0.75, atk: 0.02 });
      // The island answering back, twice, later and duller each time.
      noiseLayer(o, sr, rnd, { t0: 0.11, dur: 2.6, amp: 0.55, cut0: 260, cut1: 62, tau: 1.15, res: 0.7, atk: 0.05 });
      noiseLayer(o, sr, rnd, { t0: 0.4, dur: 3, amp: 0.3, cut0: 520, cut1: 95, tau: 1.7, res: 0.6, atk: 0.14 });
      grainLayer(o, sr, rnd, { t0: 0.14, dur: 1.6, count: 48, amp: 0.2, f0: 400, f1: 4200, tau: 0.015, kind: "tick", clump: 0.9 });
      saturate(o, 2.2);
      fadeOut(o, sr, 60);
    },
  },
  "grenade-throw": {
    dur: 0.5, gain: 0.5, ref: 5, max: 90, prio: 0.4, jitter: 0.1,
    render: (o, sr, rnd) => {
      whoosh(o, sr, rnd, 0.42, 0.55, 380, 1900);
      clack(o, sr, rnd, 0, 0.35, 2600, 0.01);
      fadeOut(o, sr, 10);
    },
  },
  "grenade-bounce": {
    dur: 0.45, gain: 0.55, ref: 5, max: 120, prio: 0.45, jitter: 0.22, same: 3,
    render: (o, sr, rnd) => {
      modalLayer(o, sr, rnd, { freq: 620, amp: 0.7, tau: 0.05, partials: METAL_PARTIALS, damp: 0.42 });
      noiseLayer(o, sr, rnd, { dur: 0.05, amp: 0.45, cut0: 4200, cut1: 900, tau: 0.008, res: 1.2, mode: "band", atk: 0.00006 });
      toneLayer(o, sr, rnd, { dur: 0.12, amp: 0.3, f0: 128, f1: 74, tau: 0.03 });
      fadeOut(o, sr, 8);
    },
  },

  // --- Impacts by material -------------------------------------------------
  "impact-concrete": {
    dur: 0.5, gain: 0.72, ref: 8, max: 280, prio: 0.5, gap: 0.015, same: 5, env: true,
    render: makeImpact(150, 0.045, 0.5, 3400, 0.075, 0.75),
  },
  "impact-metal": {
    dur: 0.6, gain: 0.72, ref: 8, max: 320, prio: 0.55, gap: 0.015, same: 5, env: true,
    render: makeImpact(240, 0.03, 0.3, 6800, 0.03, 0.55, { freq: 1720, amp: 0.5, tau: 0.16 }),
  },
  "impact-wood": {
    dur: 0.45, gain: 0.7, ref: 8, max: 240, prio: 0.45, gap: 0.015, same: 5,
    render: makeImpact(320, 0.06, 0.6, 2400, 0.05, 0.45, { freq: 470, amp: 0.3, tau: 0.09, partials: WOOD_PARTIALS }),
  },
  "impact-dirt": {
    dur: 0.4, gain: 0.62, ref: 7, max: 190, prio: 0.4, gap: 0.015, same: 5,
    render: makeImpact(96, 0.07, 0.55, 950, 0.11, 0.6),
  },
  "impact-grass": {
    dur: 0.42, gain: 0.58, ref: 7, max: 170, prio: 0.4, gap: 0.015, same: 5,
    render: (o, sr, rnd) => {
      // Softer and hissier than dirt: the blade layer on top of the soil thud.
      noiseLayer(o, sr, rnd, { dur: 0.22, amp: 0.6, cut0: 5200, cut1: 900, tau: 0.03, res: 1.1, mode: "band", atk: 0.0002 });
      toneLayer(o, sr, rnd, { dur: 0.24, amp: 0.5, f0: 88, f1: 46, tau: 0.06, atk: 0.0008 });
      grainLayer(o, sr, rnd, { dur: 0.14, count: 7, amp: 0.16, f0: 2600, f1: 7000, tau: 0.005, kind: "tick" });
      fadeOut(o, sr, 8);
    },
  },
  "impact-sand": {
    dur: 0.42, gain: 0.58, ref: 7, max: 170, prio: 0.4, gap: 0.015, same: 5,
    render: makeImpact(78, 0.05, 0.4, 1700, 0.09, 0.7),
  },
  "impact-glass": {
    dur: 0.95, gain: 0.74, ref: 8, max: 300, prio: 0.55, gap: 0.015, same: 4,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.1, amp: 0.7, cut0: 9000, cut1: 2600, tau: 0.028, res: 1.2, mode: "high", atk: 0.00006 });
      grainLayer(o, sr, rnd, { dur: 0.75, count: 24, amp: 0.6, f0: 2600, f1: 8400, tau: 0.05, kind: "ping", clump: 0.9 });
      modalLayer(o, sr, rnd, { freq: 3100, amp: 0.35, tau: 0.3, partials: GLASS_PARTIALS, damp: 0.72 });
      toneLayer(o, sr, rnd, { dur: 0.15, amp: 0.22, f0: 210, f1: 120, tau: 0.04 });
      fadeOut(o, sr, 12);
    },
  },
  "impact-water": {
    dur: 0.7, gain: 0.64, ref: 8, max: 230, prio: 0.4, gap: 0.02, same: 4,
    render: (o, sr, rnd) => {
      // A "bloop" is a *rising* resonance — the cavity closes behind the round.
      toneLayer(o, sr, rnd, { dur: 0.16, amp: 0.5, f0: 280, f1: 980, tau: 0.05, atk: 0.001 });
      noiseLayer(o, sr, rnd, { dur: 0.45, amp: 0.8, cut0: 2200, cut1: 320, tau: 0.11, res: 1.1, atk: 0.0004 });
      grainLayer(o, sr, rnd, { t0: 0.04, dur: 0.4, count: 10, amp: 0.2, f0: 700, f1: 2600, tau: 0.012, kind: "ping" });
      fadeOut(o, sr, 10);
    },
  },
  "impact-flesh": {
    dur: 0.4, gain: 0.78, ref: 6, max: 170, prio: 0.65, gap: 0.015, same: 5,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.22, amp: 0.85, cut0: 1500, cut1: 190, tau: 0.045, res: 1.35, atk: 0.0003 });
      toneLayer(o, sr, rnd, { dur: 0.2, amp: 0.6, f0: 172, f1: 62, tau: 0.05, atk: 0.0008 });
      saturate(o, 1.6);
      fadeOut(o, sr, 8);
    },
  },

  /** A round going past your head. The one cue that must never be missed. */
  whizz: {
    dur: 0.5, gain: 0.62, ref: 4, max: 90, prio: 0.85, gap: 0.03, same: 3, jitter: 0.2, bus: "ui",
    render: (o, sr, rnd) => {
      // Doppler in a single line: the band sweeps *down* through the listener
      // and the amplitude peaks in the middle rather than at the attack.
      const f = 2600 + rnd() * 1400;
      noiseLayer(o, sr, rnd, { dur: 0.22, amp: 0.9, cut0: f * 1.9, cut1: f * 0.32, tau: 0.075, res: 3.2, mode: "band", atk: 0.02 });
      toneLayer(o, sr, rnd, { dur: 0.2, amp: 0.35, f0: f * 1.2, f1: f * 0.45, tau: 0.06, atk: 0.018, vib: 0.03, vibF: 30 });
      fadeIn(o, sr, 12);
      fadeOut(o, sr, 14);
    },
  },
  ricochet: {
    dur: 0.85, gain: 0.55, ref: 9, max: 340, wet: 1.3, prio: 0.45, gap: 0.03, same: 3, jitter: 0.16,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.02, amp: 0.6, cut0: 8000, cut1: 3000, tau: 0.004, mode: "high", atk: 0.00005 });
      toneLayer(o, sr, rnd, { dur: 0.6, amp: 0.55, f0: 3600 + rnd() * 1800, f1: 700, tau: 0.22, vib: 0.05, vibF: 17, atk: 0.004 });
      noiseLayer(o, sr, rnd, { dur: 0.6, amp: 0.45, cut0: 4200, cut1: 900, tau: 0.2, res: 2.6, mode: "band", atk: 0.003 });
      fadeOut(o, sr, 14);
    },
  },

  // --- Weapon mechanics ----------------------------------------------------
  "shell-drop": {
    dur: 0.65, gain: 0.42, ref: 5, max: 95, prio: 0.2, gap: 0.012, same: 5, jitter: 0.22,
    render: (o, sr, rnd) => {
      // A casing bounces two or three times, faster and quieter each time.
      // The accelerating gaps are what make it read as brass and not as a
      // sequence of three unrelated tings.
      let t = 0;
      let amp = 0.9;
      const bounces = 2 + Math.floor(rnd() * 2);
      for (let i = 0; i <= bounces; i++) {
        modalLayer(o, sr, rnd, {
          t0: t, freq: 2400 + rnd() * 2600, amp, tau: 0.035 * (1 - i * 0.2),
          partials: [1, 2.9, 6.1], damp: 0.45,
        });
        noiseLayer(o, sr, rnd, {
          t0: t, dur: 0.02, amp: amp * 0.5, cut0: 7000, cut1: 2200, tau: 0.004, mode: "band", atk: 0.00005,
        });
        t += 0.05 + rnd() * 0.08;
        amp *= 0.55;
      }
      fadeOut(o, sr, 10);
    },
  },
  "mag-out": {
    dur: 0.42, gain: 0.55, ref: 4, max: 60, prio: 0.3,
    render: (o, sr, rnd) => {
      clack(o, sr, rnd, 0, 0.7, 1900, 0.018);
      modalLayer(o, sr, rnd, { t0: 0.03, freq: 1250, amp: 0.3, tau: 0.06, partials: [1, 3.2] });
      // The empty mag hitting the floor a beat later.
      noiseLayer(o, sr, rnd, { t0: 0.05, dur: 0.14, amp: 0.25, cut0: 3000, cut1: 900, tau: 0.05, res: 1.4, mode: "band", atk: 0.002 });
      modalLayer(o, sr, rnd, { t0: 0.21, freq: 780, amp: 0.28, tau: 0.05, partials: [1, 2.7, 4.9], damp: 0.4 });
      fadeOut(o, sr, 8);
    },
  },
  "mag-in": {
    dur: 0.48, gain: 0.62, ref: 4, max: 60, prio: 0.3,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.1, amp: 0.3, cut0: 1400, cut1: 500, tau: 0.03, res: 1.1, mode: "band", atk: 0.003 });
      clack(o, sr, rnd, 0.06, 0.95, 1150, 0.03);
      clack(o, sr, rnd, 0.16, 0.4, 2600, 0.012);
      saturate(o, 1.3);
      fadeOut(o, sr, 8);
    },
  },
  "bolt-back": {
    dur: 0.4, gain: 0.55, ref: 4, max: 70, prio: 0.3,
    render: (o, sr, rnd) => {
      // Slide travelling, then the hard stop.
      noiseLayer(o, sr, rnd, { dur: 0.11, amp: 0.35, cut0: 2200, cut1: 3600, tau: 0.07, res: 1.8, mode: "band", atk: 0.006 });
      clack(o, sr, rnd, 0.1, 0.9, 2100, 0.02);
      fadeOut(o, sr, 8);
    },
  },
  "bolt-forward": {
    dur: 0.4, gain: 0.6, ref: 4, max: 70, prio: 0.3,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.06, amp: 0.28, cut0: 3200, cut1: 2000, tau: 0.03, res: 1.6, mode: "band", atk: 0.003 });
      clack(o, sr, rnd, 0.05, 1, 1650, 0.028);
      saturate(o, 1.4);
      fadeOut(o, sr, 8);
    },
  },
  "pump-action": {
    dur: 0.6, gain: 0.66, ref: 5, max: 90, prio: 0.4,
    render: (o, sr, rnd) => {
      clack(o, sr, rnd, 0, 0.9, 1350, 0.03);
      noiseLayer(o, sr, rnd, { t0: 0.03, dur: 0.1, amp: 0.3, cut0: 1800, cut1: 2800, tau: 0.06, res: 1.6, mode: "band", atk: 0.005 });
      clack(o, sr, rnd, 0.17, 1, 1050, 0.035);
      saturate(o, 1.4);
      fadeOut(o, sr, 8);
    },
  },
  "dry-fire": {
    dur: 0.16, gain: 0.5, ref: 3, max: 40, prio: 0.35,
    render: (o, sr, rnd) => {
      clack(o, sr, rnd, 0, 0.7, 3100, 0.008);
      fadeOut(o, sr, 5);
    },
  },
  "weapon-swap": {
    dur: 0.42, gain: 0.5, ref: 3, max: 40, prio: 0.35,
    render: (o, sr, rnd) => {
      // Fabric drag off the sling, then the grip settling in the hand.
      noiseLayer(o, sr, rnd, { dur: 0.2, amp: 0.4, cut0: 900, cut1: 260, tau: 0.09, res: 0.8, atk: 0.008 });
      clack(o, sr, rnd, 0.12, 0.55, 1800, 0.014);
      fadeOut(o, sr, 8);
    },
  },
  "ads-in": {
    dur: 0.22, gain: 0.32, bus: "ui", prio: 0.4, gap: 0.05,
    render: (o, sr, rnd) => {
      // Barely there on purpose: it confirms the state change without ever
      // masking the footstep behind you.
      noiseLayer(o, sr, rnd, { dur: 0.1, amp: 0.4, cut0: 700, cut1: 240, tau: 0.035, res: 0.9, atk: 0.004 });
      toneLayer(o, sr, rnd, { dur: 0.14, amp: 0.2, f0: 420, f1: 300, tau: 0.04, atk: 0.003 });
      fadeOut(o, sr, 6);
    },
  },
  "spin-up": {
    dur: 1.0, gain: 0.55, ref: 6, max: 160, prio: 0.5, jitter: 0.03,
    render: (o, sr, rnd) => {
      // Barrel motor: a saw stack climbing an octave and a half, whir under
      // it, and a click per barrel index that speeds up as it goes.
      toneLayer(o, sr, rnd, { dur: 0.95, amp: 0.45, f0: 58, f1: 380, tau: 3, shape: "saw", atk: 0.05 });
      toneLayer(o, sr, rnd, { dur: 0.95, amp: 0.2, f0: 174, f1: 1140, tau: 3, shape: "tri", atk: 0.08 });
      noiseLayer(o, sr, rnd, { dur: 0.95, amp: 0.3, cut0: 700, cut1: 3400, tau: 3, res: 1.4, mode: "band", atk: 0.06 });
      let t = 0;
      let gapT = 0.13;
      while (t < 0.92) {
        noiseLayer(o, sr, rnd, { t0: t, dur: 0.02, amp: 0.1 + t * 0.16, cut0: 4200, cut1: 1500, tau: 0.004, mode: "band" });
        t += gapT;
        gapT *= 0.86;
      }
      fadeOut(o, sr, 25);
    },
  },
  "spin-down": {
    dur: 1.2, gain: 0.48, ref: 6, max: 160, prio: 0.4, jitter: 0.03,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 1.15, amp: 0.45, f0: 380, f1: 42, tau: 0.9, shape: "saw", atk: 0.01 });
      noiseLayer(o, sr, rnd, { dur: 1.15, amp: 0.28, cut0: 3200, cut1: 400, tau: 0.7, res: 1.3, mode: "band", atk: 0.01 });
      fadeOut(o, sr, 30);
    },
  },

  // --- Pickaxe + harvesting ------------------------------------------------
  "pickaxe-swing": {
    dur: 0.4, gain: 0.42, ref: 4, max: 55, prio: 0.3, jitter: 0.13,
    render: (o, sr, rnd) => {
      whoosh(o, sr, rnd, 0.34, 0.6, 280, 1600);
      fadeOut(o, sr, 10);
    },
  },
  "pickaxe-whoosh": {
    dur: 0.45, gain: 0.4, ref: 4, max: 55, prio: 0.25, jitter: 0.16,
    render: (o, sr, rnd) => {
      whoosh(o, sr, rnd, 0.4, 0.55, 200, 2400);
      fadeOut(o, sr, 12);
    },
  },
  /** Generic tool strike. The material layer is added on top from `dz:harvest`. */
  "pickaxe-hit": {
    dur: 0.5, gain: 0.6, ref: 6, max: 160, prio: 0.5, gap: 0.02, same: 3, jitter: 0.1,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.012, amp: 0.7, cut0: sr * 0.2, cut1: 5000, tau: 0.0018, atk: 0.00005, mode: "high" });
      toneLayer(o, sr, rnd, { dur: 0.26, amp: 0.7, f0: 190, f1: 72, tau: 0.05, atk: 0.0006 });
      noiseLayer(o, sr, rnd, { dur: 0.3, amp: 0.55, cut0: 3000, cut1: 500, tau: 0.055, res: 1.1, atk: 0.0003 });
      modalLayer(o, sr, rnd, { t0: 0.001, freq: 1180, amp: 0.22, tau: 0.05, damp: 0.5 });
      saturate(o, 1.6);
      fadeOut(o, sr, 8);
    },
  },
  "harvest-wood": {
    dur: 0.45, gain: 0.5, ref: 6, max: 150, prio: 0.4, gap: 0.02, same: 3, jitter: 0.12,
    render: (o, sr, rnd) => {
      // Fibre tearing plus the trunk's own resonance. Wood is harmonic and dry.
      modalLayer(o, sr, rnd, { freq: 260, amp: 0.7, tau: 0.1, partials: WOOD_PARTIALS, damp: 0.46 });
      noiseLayer(o, sr, rnd, { dur: 0.18, amp: 0.5, cut0: 2200, cut1: 460, tau: 0.03, res: 1.2, atk: 0.0002 });
      grainLayer(o, sr, rnd, { t0: 0.01, dur: 0.16, count: 8, amp: 0.2, f0: 900, f1: 3600, tau: 0.008, kind: "tick" });
      fadeOut(o, sr, 8);
    },
  },
  "harvest-stone": {
    dur: 0.5, gain: 0.52, ref: 6, max: 160, prio: 0.4, gap: 0.02, same: 3, jitter: 0.12,
    render: (o, sr, rnd) => {
      // Chips flying off a hard, dead surface — plenty of grit, no ring at all.
      noiseLayer(o, sr, rnd, { dur: 0.014, amp: 0.8, cut0: sr * 0.2, cut1: 6000, tau: 0.002, atk: 0.00004, mode: "high" });
      toneLayer(o, sr, rnd, { dur: 0.2, amp: 0.55, f0: 150, f1: 62, tau: 0.035, atk: 0.0005 });
      noiseLayer(o, sr, rnd, { dur: 0.34, amp: 0.7, cut0: 4600, cut1: 800, tau: 0.06, res: 1.05, atk: 0.0002 });
      grainLayer(o, sr, rnd, { t0: 0.015, dur: 0.26, count: 14, amp: 0.24, f0: 1600, f1: 6400, tau: 0.006, kind: "tick", clump: 1 });
      fadeOut(o, sr, 8);
    },
  },
  "harvest-metal": {
    dur: 0.75, gain: 0.54, ref: 6, max: 200, prio: 0.45, gap: 0.02, same: 3, jitter: 0.1,
    render: (o, sr, rnd) => {
      modalLayer(o, sr, rnd, { freq: 940, amp: 0.85, tau: 0.3, partials: METAL_PARTIALS, damp: 0.66, detune: 0.02 });
      noiseLayer(o, sr, rnd, { dur: 0.05, amp: 0.6, cut0: 8000, cut1: 2200, tau: 0.008, res: 1.3, mode: "band", atk: 0.00005 });
      toneLayer(o, sr, rnd, { dur: 0.16, amp: 0.3, f0: 170, f1: 90, tau: 0.04 });
      saturate(o, 1.5);
      fadeOut(o, sr, 12);
    },
  },
  "harvest-crit": {
    dur: 0.9, gain: 0.8, ref: 7, max: 220, prio: 0.7, gap: 0.05,
    render: (o, sr, rnd) => {
      // The weak-point hit. Same strike as a normal one plus a bright rising
      // shimmer, so it reads as a *reward* rather than as a louder swing.
      noiseLayer(o, sr, rnd, { dur: 0.014, amp: 0.85, cut0: sr * 0.2, cut1: 6000, tau: 0.002, atk: 0.00004, mode: "high" });
      toneLayer(o, sr, rnd, { dur: 0.24, amp: 0.7, f0: 210, f1: 78, tau: 0.045, atk: 0.0006 });
      chime(o, sr, rnd, [1046, 1568, 2093], 0.02, 0.045, 0.5, 0.13);
      noiseLayer(o, sr, rnd, { t0: 0.02, dur: 0.5, amp: 0.3, cut0: 3000, cut1: 9000, tau: 0.14, res: 1.6, mode: "band", atk: 0.03 });
      fadeOut(o, sr, 14);
    },
  },

  // --- Building ------------------------------------------------------------
  // A build thunk has to survive being triggered four times a second during a
  // 90-box fight: short, low, and with almost no tail.
  "build-place": {
    dur: 0.5, gain: 0.62, ref: 8, max: 200, prio: 0.6, gap: 0.02, same: 4, jitter: 0.07,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.24, amp: 0.85, f0: 170, f1: 66, tau: 0.05, atk: 0.0008 });
      noiseLayer(o, sr, rnd, { dur: 0.22, amp: 0.5, cut0: 2400, cut1: 420, tau: 0.04, res: 1, atk: 0.0004 });
      // The materialise shimmer — this is the one non-physical layer in the
      // bank, and it is what makes a wall appearing out of nothing feel legal.
      toneLayer(o, sr, rnd, { t0: 0.01, dur: 0.3, amp: 0.25, f0: 620, f1: 1240, tau: 0.08, atk: 0.006 });
      saturate(o, 1.5);
      fadeOut(o, sr, 10);
    },
  },
  "build-place-wood": {
    dur: 0.55, gain: 0.6, ref: 8, max: 200, prio: 0.55, gap: 0.02, same: 4, jitter: 0.08,
    render: (o, sr, rnd) => {
      modalLayer(o, sr, rnd, { freq: 190, amp: 0.8, tau: 0.11, partials: WOOD_PARTIALS, damp: 0.45 });
      toneLayer(o, sr, rnd, { dur: 0.2, amp: 0.5, f0: 130, f1: 60, tau: 0.045, atk: 0.0008 });
      noiseLayer(o, sr, rnd, { dur: 0.16, amp: 0.35, cut0: 1900, cut1: 380, tau: 0.03, res: 1.1, atk: 0.0004 });
      fadeOut(o, sr, 10);
    },
  },
  "build-place-stone": {
    dur: 0.55, gain: 0.64, ref: 8, max: 210, prio: 0.55, gap: 0.02, same: 4, jitter: 0.07,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.28, amp: 0.9, f0: 112, f1: 44, tau: 0.06, atk: 0.001 });
      noiseLayer(o, sr, rnd, { dur: 0.3, amp: 0.45, cut0: 2600, cut1: 340, tau: 0.05, res: 1, atk: 0.0004 });
      grainLayer(o, sr, rnd, { t0: 0.02, dur: 0.18, count: 8, amp: 0.16, f0: 1400, f1: 4800, tau: 0.005, kind: "tick" });
      saturate(o, 1.5);
      fadeOut(o, sr, 10);
    },
  },
  "build-place-metal": {
    dur: 0.7, gain: 0.62, ref: 8, max: 230, prio: 0.55, gap: 0.02, same: 4, jitter: 0.06,
    render: (o, sr, rnd) => {
      modalLayer(o, sr, rnd, { freq: 520, amp: 0.7, tau: 0.22, partials: METAL_PARTIALS, damp: 0.6, detune: 0.02 });
      toneLayer(o, sr, rnd, { dur: 0.24, amp: 0.6, f0: 140, f1: 58, tau: 0.05, atk: 0.0009 });
      noiseLayer(o, sr, rnd, { dur: 0.12, amp: 0.3, cut0: 5200, cut1: 1400, tau: 0.02, res: 1.3, mode: "band", atk: 0.0002 });
      saturate(o, 1.6);
      fadeOut(o, sr, 12);
    },
  },
  "build-hit": {
    dur: 0.4, gain: 0.5, ref: 7, max: 170, prio: 0.4, gap: 0.015, same: 5, jitter: 0.14,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.18, amp: 0.6, f0: 200, f1: 88, tau: 0.035, atk: 0.0006 });
      noiseLayer(o, sr, rnd, { dur: 0.22, amp: 0.55, cut0: 3200, cut1: 620, tau: 0.04, res: 1.1, atk: 0.0003 });
      fadeOut(o, sr, 8);
    },
  },
  "build-break": {
    dur: 1.2, gain: 0.8, ref: 10, max: 320, prio: 0.7, gap: 0.03, same: 3, variants: 3,
    render: (o, sr, rnd) => {
      // A piece coming apart: the initial failure, then the sheet falling,
      // then the debris landing. Three timescales is what sells "structure".
      noiseLayer(o, sr, rnd, { dur: 0.05, amp: 0.85, cut0: 7000, cut1: 1200, tau: 0.012, res: 1.2, atk: 0.0001 });
      toneLayer(o, sr, rnd, { dur: 0.4, amp: 0.75, f0: 128, f1: 40, tau: 0.11, atk: 0.001 });
      modalLayer(o, sr, rnd, { t0: 0.01, freq: 300, amp: 0.4, tau: 0.14, partials: WOOD_PARTIALS, damp: 0.42 });
      noiseLayer(o, sr, rnd, { t0: 0.04, dur: 0.6, amp: 0.4, cut0: 1800, cut1: 300, tau: 0.16, res: 0.9, atk: 0.004 });
      grainLayer(o, sr, rnd, { t0: 0.09, dur: 0.9, count: 26, amp: 0.32, f0: 400, f1: 3600, tau: 0.014, kind: "tick", clump: 1 });
      saturate(o, 1.8);
      fadeOut(o, sr, 20);
    },
  },
  "break-wood": {
    dur: 1.1, gain: 0.78, ref: 10, max: 300, prio: 0.65, gap: 0.03, same: 3,
    render: (o, sr, rnd) => {
      // Splintering: a burst of short inharmonic cracks, not one big one.
      for (let i = 0; i < 5; i++) {
        modalLayer(o, sr, rnd, {
          t0: i * 0.018 * (1 + rnd()), freq: 240 + rnd() * 420, amp: 0.55 - i * 0.07,
          tau: 0.07, partials: WOOD_PARTIALS, damp: 0.4, detune: 0.05,
        });
      }
      noiseLayer(o, sr, rnd, { dur: 0.3, amp: 0.6, cut0: 3200, cut1: 520, tau: 0.07, res: 1.1, atk: 0.0003 });
      toneLayer(o, sr, rnd, { dur: 0.3, amp: 0.5, f0: 130, f1: 48, tau: 0.08, atk: 0.001 });
      grainLayer(o, sr, rnd, { t0: 0.08, dur: 0.85, count: 22, amp: 0.28, f0: 500, f1: 3000, tau: 0.012, kind: "tick", clump: 1.1 });
      fadeOut(o, sr, 16);
    },
  },
  "break-stone": {
    dur: 1.3, gain: 0.82, ref: 11, max: 340, prio: 0.68, gap: 0.03, same: 3,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.06, amp: 0.9, cut0: 6000, cut1: 900, tau: 0.014, res: 1.15, atk: 0.0001 });
      toneLayer(o, sr, rnd, { dur: 0.5, amp: 0.85, f0: 96, f1: 30, tau: 0.15, atk: 0.0014 });
      noiseLayer(o, sr, rnd, { t0: 0.03, dur: 0.8, amp: 0.5, cut0: 1400, cut1: 200, tau: 0.22, res: 0.85, atk: 0.005 });
      grainLayer(o, sr, rnd, { t0: 0.1, dur: 1.1, count: 34, amp: 0.36, f0: 300, f1: 2800, tau: 0.016, kind: "tick", clump: 1.2 });
      saturate(o, 1.9);
      fadeOut(o, sr, 22);
    },
  },
  "break-metal": {
    dur: 1.5, gain: 0.8, ref: 11, max: 380, prio: 0.68, gap: 0.03, same: 3,
    render: (o, sr, rnd) => {
      // Shearing panel: a long inharmonic ring under a torn-sheet screech.
      modalLayer(o, sr, rnd, { freq: 380, amp: 0.9, tau: 0.55, partials: METAL_PARTIALS, damp: 0.72, detune: 0.03 });
      modalLayer(o, sr, rnd, { t0: 0.05, freq: 1240, amp: 0.4, tau: 0.34, damp: 0.66, detune: 0.04 });
      noiseLayer(o, sr, rnd, { dur: 0.35, amp: 0.55, cut0: 5200, cut1: 1200, tau: 0.09, res: 2.1, mode: "band", atk: 0.0004 });
      toneLayer(o, sr, rnd, { dur: 0.4, amp: 0.5, f0: 150, f1: 52, tau: 0.11, atk: 0.001 });
      grainLayer(o, sr, rnd, { t0: 0.12, dur: 1.1, count: 20, amp: 0.24, f0: 900, f1: 5200, tau: 0.014, kind: "ping", clump: 1 });
      saturate(o, 1.8);
      fadeOut(o, sr, 24);
    },
  },
  "build-deny": {
    dur: 0.2, gain: 0.4, bus: "ui", prio: 0.5, gap: 0.12,
    render: (o, sr, rnd) => {
      // A minor second. Dissonance says "no" in about 40 ms, which is faster
      // than any amount of volume can.
      toneLayer(o, sr, rnd, { dur: 0.14, amp: 0.6, f0: 220, f1: 208, tau: 0.05, atk: 0.001, shape: "square" });
      toneLayer(o, sr, rnd, { dur: 0.14, amp: 0.4, f0: 233, f1: 220, tau: 0.045, atk: 0.001, shape: "square" });
      fadeOut(o, sr, 6);
    },
  },
  "build-swap": {
    dur: 0.16, gain: 0.34, bus: "ui", prio: 0.45, gap: 0.03,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.08, amp: 0.6, f0: 1180, f1: 1560, tau: 0.02, atk: 0.0004 });
      fadeOut(o, sr, 5);
    },
  },
  "build-rotate": {
    dur: 0.14, gain: 0.3, bus: "ui", prio: 0.4, gap: 0.03,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.07, amp: 0.55, f0: 1560, f1: 1180, tau: 0.017, atk: 0.0004 });
      fadeOut(o, sr, 5);
    },
  },
  "build-edit-open": {
    dur: 0.3, gain: 0.42, bus: "ui", prio: 0.5, gap: 0.05,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.1, amp: 0.5, f0: 760, f1: 900, tau: 0.03, atk: 0.001 });
      noiseLayer(o, sr, rnd, { dur: 0.16, amp: 0.3, cut0: 2400, cut1: 6000, tau: 0.05, res: 1.4, mode: "band", atk: 0.004 });
      fadeOut(o, sr, 6);
    },
  },
  "build-edit-tick": {
    dur: 0.09, gain: 0.3, bus: "ui", prio: 0.4, gap: 0.015,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.045, amp: 0.6, f0: 2100, f1: 2050, tau: 0.01, atk: 0.0002 });
      fadeOut(o, sr, 4);
    },
  },
  "build-edit-apply": {
    dur: 0.35, gain: 0.5, ref: 6, max: 120, prio: 0.55, gap: 0.03,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.16, amp: 0.7, f0: 240, f1: 96, tau: 0.04, atk: 0.0007 });
      chime(o, sr, rnd, [880, 1320], 0.005, 0.04, 0.3, 0.07);
      fadeOut(o, sr, 8);
    },
  },

  // --- Movement ------------------------------------------------------------
  // Footsteps carry surprising tactical weight in a BR, so each surface gets
  // its own body pitch *and* its own grit band. Pitch variation comes from
  // the caller's `rate` plus this cue's own jitter.
  "step-grass": {
    dur: 0.34, gain: 0.34, ref: 3, max: 48, prio: 0.2, gap: 0.05, same: 4, jitter: 0.15,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.26, amp: 0.6, cut0: 5600, cut1: 1400, tau: 0.06, res: 0.9, mode: "band", atk: 0.003 });
      grainLayer(o, sr, rnd, { dur: 0.18, count: 9, amp: 0.22, f0: 3000, f1: 8000, tau: 0.005, kind: "tick" });
      toneLayer(o, sr, rnd, { dur: 0.12, amp: 0.2, f0: 96, f1: 58, tau: 0.045 });
      fadeOut(o, sr, 10);
    },
  },
  "step-dirt": {
    dur: 0.3, gain: 0.36, ref: 3, max: 52, prio: 0.2, gap: 0.05, same: 4, jitter: 0.14,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.2, amp: 0.7, cut0: 1600, cut1: 340, tau: 0.05, res: 0.85, atk: 0.001 });
      toneLayer(o, sr, rnd, { dur: 0.14, amp: 0.3, f0: 102, f1: 60, tau: 0.05 });
      fadeOut(o, sr, 8);
    },
  },
  "step-sand": {
    dur: 0.34, gain: 0.32, ref: 3, max: 45, prio: 0.2, gap: 0.05, same: 4, jitter: 0.16,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.24, amp: 0.75, cut0: 2600, cut1: 480, tau: 0.075, res: 0.7, atk: 0.004 });
      toneLayer(o, sr, rnd, { dur: 0.12, amp: 0.18, f0: 88, f1: 54, tau: 0.05 });
      fadeOut(o, sr, 10);
    },
  },
  "step-concrete": {
    dur: 0.3, gain: 0.38, ref: 3, max: 62, prio: 0.22, gap: 0.05, same: 4, jitter: 0.12, env: true,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.16, amp: 0.7, cut0: 4200, cut1: 800, tau: 0.026, res: 1.15, atk: 0.0004 });
      toneLayer(o, sr, rnd, { dur: 0.14, amp: 0.35, f0: 118, f1: 68, tau: 0.045 });
      grainLayer(o, sr, rnd, { t0: 0.01, dur: 0.09, count: 5, amp: 0.12, f0: 2200, f1: 6000, tau: 0.004, kind: "tick" });
      fadeOut(o, sr, 8);
    },
  },
  "step-metal": {
    dur: 0.42, gain: 0.36, ref: 3, max: 74, prio: 0.22, gap: 0.05, same: 4, jitter: 0.12,
    render: (o, sr, rnd) => {
      modalLayer(o, sr, rnd, { freq: 880, amp: 0.5, tau: 0.09, damp: 0.55 });
      noiseLayer(o, sr, rnd, { dur: 0.1, amp: 0.5, cut0: 6000, cut1: 1600, tau: 0.014, mode: "band", atk: 0.0002 });
      toneLayer(o, sr, rnd, { dur: 0.12, amp: 0.22, f0: 130, f1: 74, tau: 0.04 });
      fadeOut(o, sr, 8);
    },
  },
  "step-wood": {
    dur: 0.34, gain: 0.36, ref: 3, max: 58, prio: 0.22, gap: 0.05, same: 4, jitter: 0.13,
    render: (o, sr, rnd) => {
      modalLayer(o, sr, rnd, { freq: 340, amp: 0.45, tau: 0.055, partials: WOOD_PARTIALS, damp: 0.5 });
      noiseLayer(o, sr, rnd, { dur: 0.12, amp: 0.45, cut0: 2800, cut1: 700, tau: 0.02, res: 1.1, atk: 0.0004 });
      fadeOut(o, sr, 8);
    },
  },
  "step-glass": {
    dur: 0.4, gain: 0.36, ref: 3, max: 60, prio: 0.22, gap: 0.05, same: 4, jitter: 0.15,
    render: (o, sr, rnd) => {
      // Standing on broken glass: crunch first, tinkle after.
      noiseLayer(o, sr, rnd, { dur: 0.1, amp: 0.6, cut0: 7000, cut1: 2000, tau: 0.018, res: 1.2, mode: "band", atk: 0.0002 });
      grainLayer(o, sr, rnd, { t0: 0.005, dur: 0.28, count: 12, amp: 0.35, f0: 2800, f1: 7600, tau: 0.02, kind: "ping", clump: 1 });
      fadeOut(o, sr, 8);
    },
  },
  "step-water": {
    dur: 0.45, gain: 0.4, ref: 3, max: 58, prio: 0.22, gap: 0.05, same: 4, jitter: 0.16,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.3, amp: 0.7, cut0: 3200, cut1: 500, tau: 0.07, res: 0.9, atk: 0.002 });
      toneLayer(o, sr, rnd, { dur: 0.12, amp: 0.25, f0: 340, f1: 720, tau: 0.04, atk: 0.002 });
      grainLayer(o, sr, rnd, { t0: 0.03, dur: 0.2, count: 8, amp: 0.15, f0: 900, f1: 3000, tau: 0.008, kind: "ping" });
      fadeOut(o, sr, 10);
    },
  },
  jump: {
    dur: 0.35, gain: 0.42, ref: 3, max: 50, prio: 0.3, jitter: 0.1,
    render: (o, sr, rnd) => {
      // Gear shifting on the body plus the push-off scuff. No vocal grunt —
      // it gets old inside two minutes of a build fight.
      noiseLayer(o, sr, rnd, { dur: 0.22, amp: 0.5, cut0: 1800, cut1: 420, tau: 0.07, res: 0.7, atk: 0.006 });
      toneLayer(o, sr, rnd, { dur: 0.16, amp: 0.35, f0: 140, f1: 82, tau: 0.05 });
      grainLayer(o, sr, rnd, { dur: 0.1, count: 4, amp: 0.1, f0: 1800, f1: 5200, tau: 0.005, kind: "tick" });
      fadeOut(o, sr, 8);
    },
  },
  land: {
    dur: 0.6, gain: 0.62, ref: 4, max: 95, prio: 0.5, jitter: 0.08,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.3, amp: 0.9, f0: 132, f1: 46, tau: 0.09, atk: 0.0008 });
      noiseLayer(o, sr, rnd, { dur: 0.3, amp: 0.6, cut0: 2600, cut1: 380, tau: 0.06, res: 1, atk: 0.0006 });
      grainLayer(o, sr, rnd, { t0: 0.02, dur: 0.18, count: 8, amp: 0.16, f0: 1600, f1: 5000, tau: 0.005, kind: "tick" });
      saturate(o, 1.5);
      fadeOut(o, sr, 10);
    },
  },
  "land-hard": {
    dur: 0.9, gain: 0.8, ref: 5, max: 140, prio: 0.65, jitter: 0.05,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.5, amp: 1, f0: 108, f1: 30, tau: 0.16, atk: 0.001 });
      noiseLayer(o, sr, rnd, { dur: 0.4, amp: 0.7, cut0: 2200, cut1: 260, tau: 0.09, res: 1.05, atk: 0.0005 });
      grainLayer(o, sr, rnd, { t0: 0.03, dur: 0.4, count: 14, amp: 0.22, f0: 900, f1: 4200, tau: 0.008, kind: "tick", clump: 1 });
      saturate(o, 1.8);
      fadeOut(o, sr, 16);
    },
  },
  "splash-in": {
    dur: 1.5, gain: 0.85, ref: 6, max: 280, wet: 1.1, prio: 0.6,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.5, amp: 1, cut0: 4200, cut1: 320, tau: 0.14, res: 1.05, atk: 0.0008 });
      toneLayer(o, sr, rnd, { dur: 0.4, amp: 0.5, f0: 160, f1: 60, tau: 0.12 });
      noiseLayer(o, sr, rnd, { t0: 0.1, dur: 1, amp: 0.35, cut0: 900, cut1: 200, tau: 0.36, res: 0.8, atk: 0.02 });
      grainLayer(o, sr, rnd, { t0: 0.08, dur: 0.9, count: 24, amp: 0.22, f0: 600, f1: 3400, tau: 0.012, kind: "ping", clump: 1 });
      fadeOut(o, sr, 20);
    },
  },
  "splash-out": {
    dur: 1.1, gain: 0.7, ref: 6, max: 220, wet: 1.1, prio: 0.5,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.6, amp: 0.9, cut0: 1800, cut1: 3200, tau: 0.18, res: 0.8, atk: 0.01 });
      grainLayer(o, sr, rnd, { t0: 0.05, dur: 0.7, count: 20, amp: 0.25, f0: 800, f1: 4200, tau: 0.01, kind: "ping" });
      fadeOut(o, sr, 16);
    },
  },
  swim: {
    dur: 0.9, gain: 0.42, ref: 4, max: 60, prio: 0.2, gap: 0.2, jitter: 0.14,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.6, amp: 0.7, cut0: 1400, cut1: 380, tau: 0.16, res: 0.75, atk: 0.03 });
      grainLayer(o, sr, rnd, { t0: 0.05, dur: 0.4, count: 10, amp: 0.16, f0: 500, f1: 2200, tau: 0.01, kind: "ping" });
      fadeOut(o, sr, 12);
    },
  },
  /** Leaving the bus: the door, the rush of air, then freefall. */
  "dive-out": {
    dur: 1.6, gain: 0.8, prio: 0.8, bus: "ui", stereo: true,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.12, amp: 0.5, cut0: 900, cut1: 260, tau: 0.04, res: 1, atk: 0.002 });
      noiseLayer(o, sr, rnd, { t0: 0.05, dur: 1.45, amp: 0.85, cut0: 320, cut1: 2600, tau: 0.6, res: 0.8, atk: 0.09 });
      noiseLayer(o, sr, rnd, { t0: 0.05, dur: 1.45, amp: 0.4, cut0: 90, cut1: 180, tau: 0.7, atk: 0.14 });
      toneLayer(o, sr, rnd, { t0: 0.02, dur: 0.5, amp: 0.25, f0: 180, f1: 60, tau: 0.16, atk: 0.01 });
      fadeOut(o, sr, 90);
    },
  },
  "glider-deploy": {
    dur: 1.4, gain: 0.72, ref: 5, max: 140, prio: 0.7,
    render: (o, sr, rnd) => {
      // Canopy snap, then the fabric settling in four decreasing flaps.
      noiseLayer(o, sr, rnd, { dur: 0.13, amp: 0.95, cut0: 3800, cut1: 700, tau: 0.035, res: 0.9, atk: 0.0006 });
      toneLayer(o, sr, rnd, { dur: 0.2, amp: 0.3, f0: 170, f1: 70, tau: 0.06, atk: 0.002 });
      for (let i = 0; i < 5; i++) {
        noiseLayer(o, sr, rnd, {
          t0: 0.13 + i * 0.17, dur: 0.22, amp: 0.44 - i * 0.07, cut0: 2200 - i * 260,
          cut1: 520, tau: 0.06, res: 0.85, atk: 0.008,
        });
      }
      fadeOut(o, sr, 22);
    },
  },
  "glider-flap": {
    dur: 0.7, gain: 0.34, ref: 4, max: 70, prio: 0.25, jitter: 0.18,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.5, amp: 0.55, cut0: 1500, cut1: 420, tau: 0.13, res: 0.9, atk: 0.02 });
      noiseLayer(o, sr, rnd, { t0: 0.16, dur: 0.4, amp: 0.3, cut0: 900, cut1: 2200, tau: 0.1, res: 1.1, mode: "band", atk: 0.02 });
      fadeOut(o, sr, 16);
    },
  },

  // --- Damage + feedback ---------------------------------------------------
  // Every one of these is on the UI bus. A hitmarker that gets muffled by the
  // grenade you are standing in is a hitmarker you did not see.
  hitmarker: {
    dur: 0.14, gain: 0.5, bus: "ui", prio: 0.9, gap: 0.02, same: 4,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.06, amp: 0.8, f0: 2050, f1: 1900, tau: 0.014, atk: 0.0003 });
      toneLayer(o, sr, rnd, { t0: 0.022, dur: 0.07, amp: 0.6, f0: 2950, f1: 2800, tau: 0.016, atk: 0.0003 });
      fadeOut(o, sr, 5);
    },
  },
  "hitmarker-shield": {
    dur: 0.16, gain: 0.5, bus: "ui", prio: 0.9, gap: 0.02, same: 4,
    render: (o, sr, rnd) => {
      // Shield hits ring higher and cleaner than flesh — that difference is
      // how a player knows whether to keep pushing.
      toneLayer(o, sr, rnd, { dur: 0.07, amp: 0.75, f0: 2600, f1: 2560, tau: 0.018, atk: 0.0003 });
      toneLayer(o, sr, rnd, { t0: 0.018, dur: 0.09, amp: 0.5, f0: 3900, f1: 3840, tau: 0.02, atk: 0.0003 });
      fadeOut(o, sr, 5);
    },
  },
  headshot: {
    dur: 0.4, gain: 0.62, bus: "ui", prio: 1, gap: 0.03,
    render: (o, sr, rnd) => {
      // The classic: a bright ding a fifth above the body-shot tick, with a
      // little metallic sheen so it cuts through a full-auto burst.
      toneLayer(o, sr, rnd, { dur: 0.1, amp: 0.85, f0: 3100, f1: 3050, tau: 0.024, atk: 0.0002 });
      modalLayer(o, sr, rnd, { freq: 3100, amp: 0.35, tau: 0.11, partials: [1, 2.02, 3.4], damp: 0.6 });
      toneLayer(o, sr, rnd, { t0: 0.04, dur: 0.2, amp: 0.5, f0: 4650, f1: 4600, tau: 0.05, atk: 0.0004 });
      fadeOut(o, sr, 8);
    },
  },
  "hit-flesh": {
    dur: 0.35, gain: 0.55, ref: 6, max: 150, prio: 0.6, gap: 0.015, same: 4,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.18, amp: 0.8, cut0: 1300, cut1: 180, tau: 0.04, res: 1.3, atk: 0.0003 });
      toneLayer(o, sr, rnd, { dur: 0.18, amp: 0.55, f0: 160, f1: 60, tau: 0.045, atk: 0.0008 });
      saturate(o, 1.6);
      fadeOut(o, sr, 8);
    },
  },
  "hit-shield": {
    dur: 0.45, gain: 0.55, ref: 6, max: 160, prio: 0.6, gap: 0.015, same: 4,
    render: (o, sr, rnd) => {
      // Energy, not matter: a bright resonant ping with an FM edge on it.
      toneLayer(o, sr, rnd, { dur: 0.2, amp: 0.7, f0: 1750, f1: 1200, tau: 0.05, fm: 180, fmF: 320, atk: 0.0004 });
      noiseLayer(o, sr, rnd, { dur: 0.14, amp: 0.5, cut0: 6400, cut1: 1800, tau: 0.03, res: 2, mode: "band", atk: 0.0002 });
      modalLayer(o, sr, rnd, { t0: 0.004, freq: 2400, amp: 0.3, tau: 0.13, partials: [1, 1.61, 2.7], damp: 0.6 });
      fadeOut(o, sr, 10);
    },
  },
  "shield-break": {
    dur: 0.9, gain: 0.75, bus: "ui", prio: 0.95, gap: 0.1,
    render: (o, sr, rnd) => {
      // The shell shattering. Glassy grains falling away under a dropping tone.
      toneLayer(o, sr, rnd, { dur: 0.3, amp: 0.8, f0: 1900, f1: 420, tau: 0.09, atk: 0.0004 });
      grainLayer(o, sr, rnd, { t0: 0.02, dur: 0.6, count: 20, amp: 0.5, f0: 2200, f1: 7200, tau: 0.035, kind: "ping", clump: 0.9 });
      noiseLayer(o, sr, rnd, { dur: 0.4, amp: 0.35, cut0: 5000, cut1: 700, tau: 0.11, res: 1.4, mode: "band", atk: 0.0006 });
      fadeOut(o, sr, 14);
    },
  },
  "shield-hit": {
    dur: 0.4, gain: 0.6, bus: "ui", prio: 0.85, gap: 0.05, stereo: true,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.22, amp: 0.7, f0: 900, f1: 560, tau: 0.06, fm: 90, fmF: 210, atk: 0.0006 });
      noiseLayer(o, sr, rnd, { dur: 0.16, amp: 0.4, cut0: 4200, cut1: 1100, tau: 0.04, res: 1.8, mode: "band", atk: 0.0004 });
      fadeOut(o, sr, 10);
    },
  },
  hurt: {
    // Two variants despite being stereo: this one fires often enough in a
    // sustained fight that a single copy would start to sound like a loop.
    dur: 0.8, gain: 0.78, bus: "ui", prio: 1, gap: 0.06, stereo: true, variants: 2,
    render: (o, sr, rnd) => {
      // A tritone under a distorted slap. Two dissonant lows read as "you are
      // being hurt" faster than any amount of level does.
      toneLayer(o, sr, rnd, { dur: 0.5, amp: 0.7, f0: 92, f1: 74, tau: 0.2, atk: 0.001 });
      toneLayer(o, sr, rnd, { dur: 0.5, amp: 0.4, f0: 131, f1: 104, tau: 0.16, atk: 0.001 });
      noiseLayer(o, sr, rnd, { dur: 0.3, amp: 0.55, cut0: 2200, cut1: 260, tau: 0.05, res: 1.2, atk: 0.0004 });
      saturate(o, 2);
      fadeOut(o, sr, 14);
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
  down: {
    dur: 1.8, gain: 0.85, bus: "ui", prio: 1, stereo: true,
    render: (o, sr, rnd) => {
      // Knocked, not dead: it falls, but it resolves onto a note rather than
      // dropping into nothing, because you can still be picked up.
      toneLayer(o, sr, rnd, { dur: 1.1, amp: 0.8, f0: 220, f1: 110, tau: 0.5, atk: 0.004 });
      toneLayer(o, sr, rnd, { t0: 0.25, dur: 1.4, amp: 0.45, f0: 165, f1: 82, tau: 0.6, atk: 0.03 });
      noiseLayer(o, sr, rnd, { dur: 1.2, amp: 0.28, cut0: 1600, cut1: 200, tau: 0.45, res: 0.8, atk: 0.01 });
      fadeOut(o, sr, 60);
    },
  },
  death: {
    dur: 2.8, gain: 0.9, bus: "ui", prio: 1, stereo: true,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 2.5, amp: 0.8, f0: 128, f1: 31, tau: 1.1, atk: 0.006 });
      toneLayer(o, sr, rnd, { dur: 2.5, amp: 0.35, f0: 192, f1: 46, tau: 0.9, atk: 0.02 });
      noiseLayer(o, sr, rnd, { dur: 2.3, amp: 0.3, cut0: 1600, cut1: 120, tau: 0.8, res: 0.8, atk: 0.01 });
      fadeOut(o, sr, 60);
    },
  },
  /** Someone else died to you. The single most important cue in the game. */
  // --- BETTER FORTNITE -----------------------------------------------------
  // Everything here is a UI cue: it has to read through a firefight, so it
  // bypasses the world filters and sits an octave above the guns.
  "augment-offer": {
    dur: 1.1, gain: 0.7, bus: "ui", prio: 0.9, stereo: true,
    render: (o, sr, rnd) => {
      // Three notes for three cards, rising, unresolved: a question.
      chime(o, sr, rnd, [660, 830, 990], 0, 0.11, 0.5, 0.22);
      noiseLayer(o, sr, rnd, { dur: 0.35, amp: 0.12, cut0: 2400, cut1: 5200, tau: 0.12, atk: 0.02 });
    },
  },
  "augment-pick": {
    dur: 0.9, gain: 0.8, bus: "ui", prio: 0.95, stereo: true,
    render: (o, sr, rnd) => {
      // The answer: the fourth note lands on the octave.
      chime(o, sr, rnd, [990, 1320], 0, 0.07, 0.6, 0.24);
      toneLayer(o, sr, rnd, { dur: 0.22, amp: 0.3, f0: 240, f1: 130, tau: 0.07, atk: 0.001 });
    },
  },
  "grapple-fire": {
    dur: 0.45, gain: 0.75, bus: "ui", prio: 0.7, jitter: 0.05,
    render: (o, sr, rnd) => {
      // Pneumatic launcher: a chuff and the line paying out.
      noiseLayer(o, sr, rnd, { dur: 0.09, amp: 0.9, cut0: 1800, cut1: 400, tau: 0.03, res: 0.9, atk: 0.0006 });
      noiseLayer(o, sr, rnd, { t0: 0.05, dur: 0.38, amp: 0.35, cut0: 3200, cut1: 5600, tau: 0.2, atk: 0.01 });
      toneLayer(o, sr, rnd, { dur: 0.12, amp: 0.3, f0: 140, f1: 70, tau: 0.04, atk: 0.001 });
    },
  },
  "grapple-hit": {
    dur: 0.5, gain: 0.7, ref: 6, max: 90, prio: 0.7, jitter: 0.06,
    render: (o, sr, rnd) => {
      // Claw biting metal: a clank with a short ring.
      noiseLayer(o, sr, rnd, { dur: 0.05, amp: 0.8, cut0: 5200, cut1: 1600, tau: 0.02, res: 1.1, atk: 0.0005 });
      chime(o, sr, rnd, [1480], 0.01, 0, 0.35, 0.14);
    },
  },
  "grapple-miss": {
    dur: 0.35, gain: 0.5, bus: "ui", prio: 0.5,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.08, amp: 0.6, cut0: 1400, cut1: 300, tau: 0.03, atk: 0.0006 });
      toneLayer(o, sr, rnd, { t0: 0.04, dur: 0.25, amp: 0.25, f0: 320, f1: 180, tau: 0.09, atk: 0.003 });
    },
  },
  "grapple-release": {
    dur: 0.3, gain: 0.45, bus: "ui", prio: 0.5,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.22, amp: 0.5, cut0: 2600, cut1: 900, tau: 0.08, atk: 0.004 });
    },
  },
  "event-sting": {
    dur: 1.8, gain: 0.85, bus: "ui", prio: 1, stereo: true,
    render: (o, sr, rnd) => {
      // Two low hits and a shimmer over them: something is happening to the
      // island, and it is bigger than you.
      toneLayer(o, sr, rnd, { dur: 0.7, amp: 0.7, f0: 110, f1: 55, tau: 0.22, atk: 0.003, shape: "tri" });
      toneLayer(o, sr, rnd, { t0: 0.32, dur: 0.9, amp: 0.7, f0: 82, f1: 41, tau: 0.3, atk: 0.003, shape: "tri" });
      chime(o, sr, rnd, [1760, 2200, 2640], 0.36, 0.09, 0.28, 0.5);
      noiseLayer(o, sr, rnd, { t0: 0.3, dur: 1.4, amp: 0.18, cut0: 900, cut1: 4200, tau: 0.6, atk: 0.2 });
      fadeOut(o, sr, 120);
    },
  },
  "second-wind": {
    dur: 1.4, gain: 0.85, bus: "ui", prio: 1, stereo: true,
    render: (o, sr, rnd) => {
      // A heartbeat under a rising pad: down, but not out.
      toneLayer(o, sr, rnd, { dur: 0.18, amp: 0.8, f0: 70, f1: 50, tau: 0.06, atk: 0.002 });
      toneLayer(o, sr, rnd, { t0: 0.26, dur: 0.18, amp: 0.65, f0: 70, f1: 50, tau: 0.06, atk: 0.002 });
      toneLayer(o, sr, rnd, { t0: 0.4, dur: 1.0, amp: 0.3, f0: 330, f1: 660, tau: 0.5, atk: 0.3 });
      fadeOut(o, sr, 100);
    },
  },
  "second-wind-tick": {
    dur: 0.25, gain: 0.6, bus: "ui", prio: 0.8,
    render: (o, sr, rnd) => {
      chime(o, sr, rnd, [1320], 0, 0, 0.5, 0.09);
    },
  },
  "second-wind-launch": {
    dur: 1.3, gain: 0.9, bus: "ui", prio: 1, stereo: true,
    render: (o, sr, rnd) => {
      // The elim chime's arpeggio, inverted and faster: you are BACK.
      chime(o, sr, rnd, [660, 880, 1108, 1318, 1760], 0, 0.05, 0.55, 0.2);
      noiseLayer(o, sr, rnd, { t0: 0.1, dur: 1.1, amp: 0.4, cut0: 400, cut1: 3200, tau: 0.5, atk: 0.06 });
      fadeOut(o, sr, 90);
    },
  },
  "elim-confirm": {
    dur: 0.85, gain: 0.8, bus: "ui", prio: 1, gap: 0.05,
    render: (o, sr, rnd) => {
      // Rising major arpeggio + a clean impact. It must never be mistakable
      // for a body-shot tick, so it is longer, wider and resolves upward.
      chime(o, sr, rnd, [880, 1108, 1318, 1760], 0, 0.055, 0.55, 0.16);
      toneLayer(o, sr, rnd, { dur: 0.2, amp: 0.35, f0: 220, f1: 110, tau: 0.06, atk: 0.001 });
      noiseLayer(o, sr, rnd, { t0: 0.16, dur: 0.4, amp: 0.2, cut0: 4000, cut1: 9000, tau: 0.11, res: 1.5, mode: "band", atk: 0.02 });
      fadeOut(o, sr, 14);
    },
  },
  eliminated: {
    dur: 2.4, gain: 0.85, bus: "ui", prio: 1, stereo: true,
    render: (o, sr, rnd) => {
      // Your run is over: a falling minor third under a long dark swell.
      toneLayer(o, sr, rnd, { dur: 2.2, amp: 0.65, f0: 196, f1: 98, tau: 1.2, atk: 0.02 });
      toneLayer(o, sr, rnd, { t0: 0.3, dur: 1.9, amp: 0.45, f0: 233, f1: 116, tau: 1, atk: 0.05 });
      toneLayer(o, sr, rnd, { dur: 2.2, amp: 0.3, f0: 49, f1: 40, tau: 1.4, atk: 0.06 });
      noiseLayer(o, sr, rnd, { dur: 2, amp: 0.22, cut0: 1200, cut1: 160, tau: 0.9, res: 0.7, atk: 0.15 });
      fadeOut(o, sr, 80);
    },
  },
  victory: {
    dur: 3.0, gain: 0.9, bus: "ui", prio: 1, stereo: true,
    render: (o, sr, rnd) => {
      // Fanfare: a major triad walked up and held, with a swell underneath.
      const notes = [523.25, 659.25, 783.99, 1046.5];
      for (let i = 0; i < notes.length; i++) {
        chime(o, sr, rnd, [notes[i]], i * 0.11, 0, 0.55 - i * 0.04, 0.5);
        toneLayer(o, sr, rnd, { t0: i * 0.11, dur: 2.4, amp: 0.2, f0: notes[i] / 2, f1: notes[i] / 2, tau: 1.4, atk: 0.02 });
      }
      chime(o, sr, rnd, [1046.5, 1318.5, 1568], 0.5, 0.0, 0.5, 1.4);
      toneLayer(o, sr, rnd, { dur: 2.6, amp: 0.3, f0: 130.8, f1: 130.8, tau: 1.6, atk: 0.05, shape: "tri" });
      noiseLayer(o, sr, rnd, { dur: 0.9, amp: 0.2, cut0: 900, cut1: 8000, tau: 0.4, res: 1.2, mode: "band", atk: 0.25 });
      fadeOut(o, sr, 120);
    },
  },

  // --- Loot + inventory ----------------------------------------------------
  "item-pickup": {
    dur: 0.4, gain: 0.5, bus: "ui", prio: 0.7, gap: 0.02,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.14, amp: 0.6, f0: 880, f1: 900, tau: 0.045, atk: 0.001 });
      toneLayer(o, sr, rnd, { t0: 0.06, dur: 0.26, amp: 0.55, f0: 1320, f1: 1340, tau: 0.085, atk: 0.001 });
      fadeOut(o, sr, 8);
    },
  },
  /** Layered on top of a pickup, pitched by rarity. See `dz:pickup`. */
  "pickup-blip": {
    dur: 0.5, gain: 0.42, bus: "ui", prio: 0.7, gap: 0.02,
    render: (o, sr, rnd) => {
      chime(o, sr, rnd, [1046.5, 1568], 0, 0.06, 0.5, 0.14);
      fadeOut(o, sr, 8);
    },
  },
  "ammo-pickup": {
    dur: 0.3, gain: 0.42, bus: "ui", prio: 0.55, gap: 0.03,
    render: (o, sr, rnd) => {
      // Brass in a pouch, not a chime — ammo is not an event worth a fanfare.
      grainLayer(o, sr, rnd, { dur: 0.16, count: 7, amp: 0.5, f0: 1800, f1: 4600, tau: 0.012, kind: "ping", clump: 0.8 });
      noiseLayer(o, sr, rnd, { dur: 0.12, amp: 0.25, cut0: 2600, cut1: 800, tau: 0.04, res: 1.1, mode: "band", atk: 0.002 });
      fadeOut(o, sr, 6);
    },
  },
  "item-drop": {
    dur: 0.45, gain: 0.45, ref: 4, max: 60, prio: 0.4,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.16, amp: 0.55, f0: 620, f1: 380, tau: 0.045, atk: 0.001 });
      noiseLayer(o, sr, rnd, { t0: 0.05, dur: 0.2, amp: 0.35, cut0: 1600, cut1: 400, tau: 0.05, res: 1, atk: 0.002 });
      fadeOut(o, sr, 8);
    },
  },
  "loot-pickup": {
    dur: 0.45, gain: 0.5, ref: 5, max: 60, prio: 0.6, gap: 0.02,
    render: (o, sr, rnd) => {
      chime(o, sr, rnd, [1174, 1568], 0, 0.05, 0.5, 0.11);
      noiseLayer(o, sr, rnd, { dur: 0.1, amp: 0.2, cut0: 2600, cut1: 7000, tau: 0.04, res: 1.4, mode: "band", atk: 0.006 });
      fadeOut(o, sr, 8);
    },
  },
  "chest-open": {
    dur: 2.2, gain: 0.85, ref: 8, max: 220, wet: 1.2, prio: 0.85,
    render: (o, sr, rnd) => {
      // Lid: latch, hinge creak, wood knock. Then the ascending chime — the
      // sound a battle royale trains you to run toward.
      clack(o, sr, rnd, 0, 0.55, 1450, 0.02);
      noiseLayer(o, sr, rnd, { t0: 0.03, dur: 0.22, amp: 0.3, cut0: 700, cut1: 1600, tau: 0.08, res: 2.4, mode: "band", atk: 0.02 });
      modalLayer(o, sr, rnd, { t0: 0.24, freq: 210, amp: 0.4, tau: 0.12, partials: WOOD_PARTIALS, damp: 0.42 });
      chime(o, sr, rnd, [659.25, 783.99, 987.77, 1318.5], 0.16, 0.085, 0.6, 0.4);
      // Rising air behind it, so the arpeggio feels lifted rather than dropped in.
      noiseLayer(o, sr, rnd, { t0: 0.1, dur: 0.9, amp: 0.16, cut0: 1200, cut1: 8000, tau: 0.4, res: 1.3, mode: "band", atk: 0.12 });
      fadeOut(o, sr, 40);
    },
  },
  "chest-hum": {
    dur: 1.2, gain: 0.3, ref: 4, max: 40, prio: 0.15, jitter: 0,
    render: (o, sr, rnd) => {
      // A soft pulsing third. Only ever heard within a few metres, and the
      // reason you find the chest behind the wall instead of walking past it.
      toneLayer(o, sr, rnd, { dur: 1.15, amp: 0.5, f0: 329.6, f1: 329.6, tau: 6, atk: 0.12, vib: 0.004, vibF: 3.2 });
      toneLayer(o, sr, rnd, { dur: 1.15, amp: 0.3, f0: 493.9, f1: 493.9, tau: 6, atk: 0.2, vib: 0.005, vibF: 2.4 });
      fadeIn(o, sr, 90);
      fadeOut(o, sr, 90);
    },
  },
  "inventory-deny": {
    dur: 0.2, gain: 0.4, bus: "ui", prio: 0.5, gap: 0.1,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.13, amp: 0.6, f0: 300, f1: 190, tau: 0.04, atk: 0.0008, shape: "square" });
      fadeOut(o, sr, 6);
    },
  },
  "ui-deny": {
    dur: 0.2, gain: 0.38, bus: "ui", prio: 0.5, gap: 0.1,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.12, amp: 0.55, f0: 260, f1: 175, tau: 0.038, atk: 0.0008, shape: "square" });
      fadeOut(o, sr, 6);
    },
  },
  "ui-tick": {
    dur: 0.09, gain: 0.32, bus: "ui", prio: 0.5, gap: 0.015,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.05, amp: 0.7, f0: 1700, f1: 1650, tau: 0.011, atk: 0.0002 });
      fadeOut(o, sr, 4);
    },
  },
  /** Shield potion going down: glug, glug, glug. */
  "consume-shield-start": {
    dur: 2.6, gain: 0.6, ref: 4, max: 45, prio: 0.6,
    render: (o, sr, rnd) => {
      // Each glug is a cavity closing: a short *rising* resonance with a wet
      // noise skirt. Six of them, slowing down, is a bottle emptying.
      let t = 0.06;
      for (let i = 0; i < 6; i++) {
        const f = 220 + rnd() * 90;
        toneLayer(o, sr, rnd, { t0: t, dur: 0.13, amp: 0.65 - i * 0.03, f0: f, f1: f * 2.4, tau: 0.035, atk: 0.002 });
        noiseLayer(o, sr, rnd, { t0: t, dur: 0.1, amp: 0.28, cut0: 1400, cut1: 420, tau: 0.028, res: 1.4, mode: "band", atk: 0.002 });
        grainLayer(o, sr, rnd, { t0: t, dur: 0.09, count: 4, amp: 0.1, f0: 700, f1: 2400, tau: 0.008, kind: "ping" });
        t += 0.33 + i * 0.03;
      }
      fadeOut(o, sr, 20);
    },
  },
  "consume-shield": {
    dur: 1.4, gain: 0.7, bus: "ui", prio: 0.8,
    render: (o, sr, rnd) => {
      // The shield coming up around you: a rising shimmer resolving to a fifth.
      noiseLayer(o, sr, rnd, { dur: 0.7, amp: 0.3, cut0: 900, cut1: 8000, tau: 0.3, res: 1.5, mode: "band", atk: 0.1 });
      chime(o, sr, rnd, [587.33, 880], 0.1, 0.09, 0.55, 0.42);
      toneLayer(o, sr, rnd, { t0: 0.1, dur: 1.1, amp: 0.25, f0: 146.8, f1: 146.8, tau: 0.6, atk: 0.05, shape: "tri" });
      fadeOut(o, sr, 40);
    },
  },
  "consume-health-start": {
    dur: 2.0, gain: 0.5, ref: 4, max: 40, prio: 0.55,
    render: (o, sr, rnd) => {
      // Wrapper, then tape unwinding in three pulls.
      noiseLayer(o, sr, rnd, { dur: 0.3, amp: 0.5, cut0: 6000, cut1: 2200, tau: 0.1, res: 1.3, mode: "high", atk: 0.006 });
      for (let i = 0; i < 3; i++) {
        noiseLayer(o, sr, rnd, {
          t0: 0.45 + i * 0.42, dur: 0.34, amp: 0.45, cut0: 2400, cut1: 5200,
          tau: 0.12, res: 1.6, mode: "band", atk: 0.02,
        });
      }
      fadeOut(o, sr, 20);
    },
  },
  "consume-health": {
    dur: 1.0, gain: 0.62, bus: "ui", prio: 0.8,
    render: (o, sr, rnd) => {
      chime(o, sr, rnd, [523.25, 783.99], 0.02, 0.08, 0.5, 0.3);
      toneLayer(o, sr, rnd, { dur: 0.7, amp: 0.2, f0: 261.6, f1: 261.6, tau: 0.35, atk: 0.03, shape: "tri" });
      fadeOut(o, sr, 24);
    },
  },
  "consume-cancel": {
    dur: 0.3, gain: 0.4, bus: "ui", prio: 0.5,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.2, amp: 0.5, f0: 520, f1: 260, tau: 0.06, atk: 0.001 });
      noiseLayer(o, sr, rnd, { dur: 0.12, amp: 0.2, cut0: 1800, cut1: 500, tau: 0.04, res: 1, atk: 0.003 });
      fadeOut(o, sr, 8);
    },
  },

  // --- Match + storm -------------------------------------------------------
  "bus-horn": {
    dur: 3.0, gain: 0.6, ref: 60, max: 2200, roll: 0.5, wet: 1.6, prio: 0.6, jitter: 0.02,
    render: (o, sr, rnd) => {
      // Two detuned reeds beating against each other, plus a sub. The beat
      // frequency is the whole character — perfectly tuned reeds sound synthetic.
      toneLayer(o, sr, rnd, { dur: 2.8, amp: 0.6, f0: 108, f1: 104, tau: 2.6, shape: "saw", atk: 0.12 });
      toneLayer(o, sr, rnd, { dur: 2.8, amp: 0.45, f0: 163, f1: 158, tau: 2.4, shape: "saw", atk: 0.16 });
      toneLayer(o, sr, rnd, { dur: 2.8, amp: 0.2, f0: 54, f1: 52, tau: 2.5, atk: 0.2 });
      noiseLayer(o, sr, rnd, { dur: 2.8, amp: 0.08, cut0: 900, cut1: 400, tau: 2.2, res: 1, atk: 0.3 });
      saturate(o, 1.4);
      fadeOut(o, sr, 120);
    },
  },
  "bus-release": {
    dur: 1.6, gain: 0.6, ref: 20, max: 400, prio: 0.7,
    render: (o, sr, rnd) => {
      // Pneumatic clamps letting go, then the hatch swinging.
      noiseLayer(o, sr, rnd, { dur: 0.7, amp: 0.75, cut0: 5200, cut1: 1400, tau: 0.22, res: 1.1, mode: "high", atk: 0.004 });
      clack(o, sr, rnd, 0.02, 0.6, 900, 0.04);
      modalLayer(o, sr, rnd, { t0: 0.6, freq: 420, amp: 0.45, tau: 0.3, damp: 0.62, detune: 0.02 });
      noiseLayer(o, sr, rnd, { t0: 0.55, dur: 0.9, amp: 0.3, cut0: 1200, cut1: 300, tau: 0.3, res: 0.9, atk: 0.02 });
      fadeOut(o, sr, 24);
    },
  },
  callout: {
    dur: 0.35, gain: 0.42, bus: "ui", prio: 0.6, gap: 0.05,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.1, amp: 0.55, f0: 1046, f1: 1046, tau: 0.03, atk: 0.0006 });
      toneLayer(o, sr, rnd, { t0: 0.07, dur: 0.2, amp: 0.4, f0: 1568, f1: 1568, tau: 0.06, atk: 0.0006 });
      fadeOut(o, sr, 8);
    },
  },
  /** The phase siren. Two-tone, urgent, unmistakably a countdown. */
  "storm-warn": {
    dur: 2.6, gain: 0.5, bus: "ui", prio: 0.8, gap: 0.4,
    render: (o, sr, rnd) => {
      for (let i = 0; i < 5; i++) {
        const hi = i % 2 === 0;
        toneLayer(o, sr, rnd, {
          t0: i * 0.48, dur: 0.5, amp: 0.5, f0: hi ? 740 : 554, f1: hi ? 736 : 551,
          tau: 1.2, shape: "saw", atk: 0.025,
        });
        toneLayer(o, sr, rnd, {
          t0: i * 0.48, dur: 0.5, amp: 0.2, f0: hi ? 1480 : 1108, f1: hi ? 1472 : 1102,
          tau: 1, shape: "tri", atk: 0.03,
        });
      }
      saturate(o, 1.3);
      fadeOut(o, sr, 60);
    },
  },
  /** The wall starting to move: a long descending roar. */
  "storm-close": {
    dur: 3.4, gain: 0.62, prio: 0.8, stereo: true,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 3.2, amp: 0.75, cut0: 3400, cut1: 220, tau: 1.5, res: 0.8, atk: 0.25 });
      toneLayer(o, sr, rnd, { dur: 3.2, amp: 0.5, f0: 92, f1: 34, tau: 1.6, atk: 0.3 });
      toneLayer(o, sr, rnd, { t0: 0.4, dur: 2.6, amp: 0.22, f0: 138, f1: 51, tau: 1.2, atk: 0.4, shape: "tri" });
      grainLayer(o, sr, rnd, { t0: 0.5, dur: 2.4, count: 22, amp: 0.12, f0: 1400, f1: 6000, tau: 0.01, kind: "tick", clump: 0 });
      fadeOut(o, sr, 120);
    },
  },
  "storm-enter": {
    dur: 1.6, gain: 0.7, bus: "ui", prio: 0.9, stereo: true,
    render: (o, sr, rnd) => {
      // Crossing into it: a swell up plus the electrical crackle of the wall.
      noiseLayer(o, sr, rnd, { dur: 1.4, amp: 0.7, cut0: 500, cut1: 3200, tau: 0.55, res: 1.1, mode: "band", atk: 0.05 });
      toneLayer(o, sr, rnd, { dur: 1.2, amp: 0.4, f0: 62, f1: 110, tau: 0.5, atk: 0.03 });
      grainLayer(o, sr, rnd, { dur: 1.2, count: 26, amp: 0.2, f0: 2400, f1: 9000, tau: 0.006, kind: "tick", clump: 0 });
      fadeOut(o, sr, 40);
    },
  },
  "storm-exit": {
    dur: 1.4, gain: 0.6, bus: "ui", prio: 0.85, stereo: true,
    render: (o, sr, rnd) => {
      // Relief: everything opens up and drops away.
      noiseLayer(o, sr, rnd, { dur: 1.2, amp: 0.6, cut0: 3200, cut1: 400, tau: 0.42, res: 1, mode: "band", atk: 0.02 });
      toneLayer(o, sr, rnd, { dur: 1, amp: 0.35, f0: 130, f1: 65, tau: 0.4, atk: 0.02 });
      fadeOut(o, sr, 40);
    },
  },

  // --- Distant world texture ----------------------------------------------
  bird: {
    dur: 1.0, gain: 0.3, ref: 18, max: 260, wet: 1.2, prio: 0.2, jitter: 0.18,
    render: (o, sr, rnd) => {
      // Songbirds are frequency sweeps, not pitches: 4-6 short glides with
      // random directions is enough for the ear to call it a bird.
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
  gull: {
    dur: 1.4, gain: 0.4, ref: 25, max: 700, roll: 0.7, wet: 1.4, prio: 0.25, jitter: 0.14,
    render: (o, sr, rnd) => {
      // Two or three descending squawks. Saw carrier + a resonant formant
      // band is the whole recipe for a seabird.
      let t = 0;
      const calls = 2 + Math.floor(rnd() * 2);
      for (let i = 0; i < calls; i++) {
        const f = 900 + rnd() * 400;
        toneLayer(o, sr, rnd, {
          t0: t, dur: 0.3, amp: 0.7 - i * 0.12, f0: f * 1.35, f1: f * 0.7,
          tau: 0.085, shape: "saw", vib: 0.06, vibF: 24, atk: 0.008,
        });
        noiseLayer(o, sr, rnd, {
          t0: t, dur: 0.28, amp: 0.2, cut0: f * 3, cut1: f * 1.4, tau: 0.07, res: 2.2, mode: "band", atk: 0.01,
        });
        t += 0.28 + rnd() * 0.22;
      }
      fadeOut(o, sr, 20);
    },
  },
  "distant-fire": {
    dur: 1.8, gain: 0.28, ref: 200, max: 2400, roll: 0.45, wet: 1.8, prio: 0.2, jitter: 0.1,
    render: (o, sr, rnd) => {
      // A firefight across the island: already low-passed to nothing and
      // smeared by the terrain, which is exactly how it should arrive.
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

  // =========================================================================
  // SPLASH ROYALE
  //
  // Every name below is one another system already asks for by name — the
  // `sound`/`soundRefill`/`soundBurst` fields of `mode/water.ts`, plus the
  // handful `player.ts`, `weapons.ts`, `inventory.ts` and `vfx.ts` call
  // directly. Before this block they all fell through `resolveCue` onto
  // `generic` (and `glue-fire`, containing "fire", onto an assault rifle).
  //
  // The premise governs all of it: nobody is hurt, they get drenched. Nothing
  // here cracks, nothing rings like metal, nothing is a report. The loud
  // moments are wet and comic — a burst balloon, a bucket of water arriving —
  // and the quiet ones are plastic and rubber.
  // =========================================================================

  // --- Soakers -------------------------------------------------------------
  /** Super Soaker 9000. The reference jet: everything else is placed off it. */
  "soak-ar": {
    dur: 0.5, gain: 0.82, ref: 14, max: 620, wet: 0.85, prio: 0.8, gap: 0.02, same: 5,
    jitter: 0.06, travel: true, env: true, duck: 0.34,
    render: makeSoaker({
      dur: 0.5, valveAmp: 0.5, valveCut: 7200,
      jetAmp: 0.95, jetCut0: 3400, jetCut1: 1100, jetRes: 1.5, jetTau: 0.1, jetAtk: 0.0018,
      burbleF: 190, burbleAmp: 0.4, spray: 9, sprayAmp: 0.16,
      mechAmp: 0.16, mechFreq: 1250, drive: 1.5, tailAmp: 0.13,
    }),
  },
  /** Squirt Pistol. Small, thin, cheerful — a spritz with a trigger click. */
  "soak-pistol": {
    dur: 0.3, gain: 0.6, ref: 9, max: 320, wet: 0.7, prio: 0.7, gap: 0.02, same: 4,
    jitter: 0.09, travel: true, env: true, duck: 0.22,
    render: makeSoaker({
      dur: 0.3, valveAmp: 0.55, valveCut: 8600,
      jetAmp: 0.8, jetCut0: 4600, jetCut1: 1900, jetRes: 1.7, jetTau: 0.055, jetAtk: 0.0014,
      burbleF: 300, burbleAmp: 0.24, spray: 5, sprayAmp: 0.14,
      mechAmp: 0.26, mechFreq: 2350, drive: 1.4, tailAmp: 0.08,
    }),
  },
  /** Drizzler 500. Fast and chattery: more mechanism, less water per pull. */
  "soak-smg": {
    dur: 0.28, gain: 0.6, ref: 10, max: 380, wet: 0.7, prio: 0.72, gap: 0.014, same: 6,
    jitter: 0.1, travel: true, env: true, duck: 0.26,
    render: makeSoaker({
      dur: 0.28, valveAmp: 0.48, valveCut: 8200,
      jetAmp: 0.82, jetCut0: 4100, jetCut1: 1700, jetRes: 1.8, jetTau: 0.05, jetAtk: 0.0012,
      burbleF: 260, burbleAmp: 0.22, spray: 5, sprayAmp: 0.13,
      mechAmp: 0.3, mechFreq: 2050, drive: 1.4, tailAmp: 0.07,
    }),
  },
  /**
   * Pump Blaster. A percussive WHUMP of displaced air and water, not a hiss —
   * the thump layer is louder than the jet, which is true of nothing else in
   * the arsenal and is why this one reads as a shotgun without being one.
   */
  "soak-pump": {
    dur: 0.95, gain: 0.94, ref: 17, max: 800, wet: 1, prio: 0.9, gap: 0.05, same: 3,
    jitter: 0.05, travel: true, env: true, duck: 0.6,
    render: makeSoaker({
      dur: 0.95, valveAmp: 0.75, valveCut: 6000,
      jetAmp: 0.72, jetCut0: 2400, jetCut1: 420, jetRes: 0.95, jetTau: 0.16, jetAtk: 0.0022,
      burbleF: 120, burbleAmp: 0.5, spray: 20, sprayAmp: 0.26,
      mechAmp: 0.2, mechFreq: 820, drive: 2, tailAmp: 0.24,
      thumpAmp: 0.95, thumpF: 118, thumpTau: 0.1,
    }),
  },
  /** Tac Soaker. The wide wet wash — low resonance, lots of droplets. */
  "soak-tac": {
    dur: 0.55, gain: 0.72, ref: 12, max: 480, wet: 0.9, prio: 0.8, gap: 0.03, same: 4,
    jitter: 0.07, travel: true, env: true, duck: 0.4,
    render: makeSoaker({
      dur: 0.55, valveAmp: 0.55, valveCut: 5600,
      jetAmp: 0.9, jetCut0: 2600, jetCut1: 700, jetRes: 0.8, jetTau: 0.12, jetAtk: 0.0024,
      burbleF: 150, burbleAmp: 0.4, spray: 22, sprayAmp: 0.24,
      mechAmp: 0.16, mechFreq: 1050, drive: 1.7, tailAmp: 0.18,
      thumpAmp: 0.4, thumpF: 140, thumpTau: 0.055,
    }),
  },
  /**
   * Hydro Lance. A tight high jet: one narrow, resonant band and almost no
   * spray, because a needle of water does not scatter. It is also the only
   * soaker with any real reach, so it carries the longest tail on the mode.
   */
  "soak-lance": {
    dur: 1.1, gain: 0.9, ref: 20, max: 1600, roll: 0.7, wet: 1.2, prio: 0.95, gap: 0.15,
    same: 2, travel: true, env: true, duck: 0.7,
    render: makeSoaker({
      dur: 1.1, valveAmp: 0.8, valveCut: 10500,
      jetAmp: 0.95, jetCut0: 6200, jetCut1: 2600, jetRes: 3.1, jetTau: 0.26, jetAtk: 0.0011,
      burbleF: 240, burbleAmp: 0.22, spray: 6, sprayAmp: 0.1,
      mechAmp: 0.22, mechFreq: 1650, drive: 1.7, tailAmp: 0.3,
    }),
  },
  /**
   * The Firehose. A roaring torrent: broad, low, sustained, and deliberately
   * modest per pull — this weapon fires continuously, so the roar is built by
   * overlapping copies. Loud per shot here would be a wall of mud at 20 Hz.
   */
  "soak-hose": {
    dur: 0.42, gain: 0.52, ref: 15, max: 700, wet: 0.8, prio: 0.72, gap: 0.012, same: 6,
    jitter: 0.11, travel: true, env: true, duck: 0.34,
    render: makeSoaker({
      dur: 0.42, valveAmp: 0.34, valveCut: 4200,
      jetAmp: 1, jetCut0: 1700, jetCut1: 900, jetRes: 0.62, jetTau: 0.16, jetAtk: 0.006,
      burbleF: 88, burbleAmp: 0.5, spray: 14, sprayAmp: 0.2,
      mechAmp: 0.08, mechFreq: 700, drive: 2.1, tailAmp: 0.14,
    }),
  },
  /** Balloon Launcher firing: a hollow air-cannon pock, with a wobble on it. */
  "soak-lob": {
    dur: 0.6, gain: 0.72, ref: 13, max: 520, wet: 0.9, prio: 0.82, gap: 0.06, same: 3,
    travel: true, env: true, duck: 0.42,
    render: (o, sr, rnd, indoor) => {
      // Compressed air leaving a tube: a pitched pock, not a crack.
      toneLayer(o, sr, rnd, { dur: 0.3, amp: 0.9, f0: 230, f1: 84, tau: 0.045, atk: 0.0018 });
      noiseLayer(o, sr, rnd, { dur: 0.12, amp: 0.7, cut0: 2600, cut1: 480, tau: 0.022, res: 1.3, atk: 0.0009 });
      // The payload leaving, still sloshing.
      toneLayer(o, sr, rnd, {
        t0: 0.03, dur: 0.35, amp: 0.3, f0: 165, f1: 120, tau: 0.11, atk: 0.01, vib: 0.14, vibF: 13,
      });
      noiseLayer(o, sr, rnd, { t0: 0.02, dur: 0.4, amp: 0.28, cut0: 900, cut1: 2400, tau: 0.13, res: 1.1, mode: "band", atk: 0.02 });
      modalLayer(o, sr, rnd, { t0: 0.004, freq: 960, amp: 0.2, tau: 0.02, partials: WOOD_PARTIALS, damp: 0.4 });
      if (indoor) slapback(o, sr, { delay: 0.02, feedback: 0.58, damp: 1400, mix: 0.3, t0: 0.004 });
      else slapback(o, sr, { delay: 0.083, feedback: 0.26, damp: 3200, mix: 0.14, t0: 0.006 });
      saturate(o, 1.8);
      fadeOut(o, sr, 12);
    },
  },
  /**
   * Triple Tap. Also the base splat `vfx.soakBurst()` plays on an elimination,
   * because `mode/water.ts` points both at this one name — so it has to work
   * three times a second AND as the front half of somebody coming apart. It is
   * therefore a wet PUNCH: short, mid-weight, no long tail to stack up. The
   * big elimination layer is `soak-out`, fired off `dz:soakburst` instead.
   */
  "soak-burst": {
    dur: 0.62, gain: 0.8, ref: 13, max: 620, wet: 0.95, prio: 0.85, gap: 0.02, same: 4,
    jitter: 0.06, travel: true, env: true, duck: 0.45,
    render: (o, sr, rnd, indoor) => {
      wetSlap(o, sr, rnd, 0, 0.95, 0.75);
      noiseLayer(o, sr, rnd, { dur: 0.05, amp: 0.45, cut0: 8000, cut1: 2400, tau: 0.008, res: 1.2, mode: "high", atk: 0.0006 });
      if (indoor) slapback(o, sr, { delay: 0.018, feedback: 0.6, damp: 1400, mix: 0.34, t0: 0.003 });
      else slapback(o, sr, { delay: 0.076, feedback: 0.28, damp: 3000, mix: 0.16, t0: 0.005 });
      saturate(o, 1.8);
      fadeOut(o, sr, 12);
    },
  },
  /**
   * THE GLUE GUN, firing. Thick and gloopy: the band sweeps the wrong way for
   * a gun (up, then the strand pulls it back down) and the FM is deep enough
   * to be audibly sticky rather than merely low.
   */
  "glue-fire": {
    dur: 0.55, gain: 0.66, ref: 11, max: 380, wet: 0.75, prio: 0.78, gap: 0.05, same: 3,
    jitter: 0.07, travel: true, env: true, duck: 0.3,
    render: (o, sr, rnd) => {
      // The plunger.
      clack(o, sr, rnd, 0, 0.4, 780, 0.014);
      // Gloop leaving the nozzle: heavy FM on a low carrier is the sticky part.
      toneLayer(o, sr, rnd, {
        dur: 0.3, amp: 0.85, f0: 130, f1: 320, tau: 0.09, atk: 0.004, fm: 150, fmF: 29, vib: 0.1, vibF: 11,
      });
      noiseLayer(o, sr, rnd, { dur: 0.34, amp: 0.6, cut0: 1400, cut1: 3200, tau: 0.1, res: 1.9, mode: "band", atk: 0.006 });
      // The strand paying out behind it — thin, rising, and slightly sour.
      toneLayer(o, sr, rnd, { t0: 0.08, dur: 0.4, amp: 0.28, f0: 620, f1: 1450, tau: 0.14, atk: 0.02, vib: 0.05, vibF: 23 });
      grainLayer(o, sr, rnd, { t0: 0.05, dur: 0.3, count: 7, amp: 0.12, f0: 1200, f1: 4000, tau: 0.008, kind: "ping" });
      saturate(o, 1.6);
      // Deep FM on a low carrier is the second thing in this file that walks
      // off the zero line, so the glue gets the same treatment as the soakers.
      dcBlock(o, sr);
      fadeOut(o, sr, 12);
    },
  },

  // --- Water balloons ------------------------------------------------------
  /** The throw: an underarm wobble. Almost no attack — nothing has happened yet. */
  "balloon-throw": {
    dur: 0.55, gain: 0.5, ref: 4, max: 70, prio: 0.4, jitter: 0.12,
    render: (o, sr, rnd) => {
      whoosh(o, sr, rnd, 0.42, 0.55, 420, 1600);
      // A skin full of water does not fly quietly: it wobbles, audibly, and
      // the vibrato depth here is the difference between a balloon and a rock.
      toneLayer(o, sr, rnd, { t0: 0.02, dur: 0.4, amp: 0.4, f0: 148, f1: 118, tau: 0.14, atk: 0.02, vib: 0.19, vibF: 11 });
      // Rubber against a glove on the way out.
      noiseLayer(o, sr, rnd, { dur: 0.05, amp: 0.2, cut0: 2600, cut1: 5200, tau: 0.02, res: 2.4, mode: "band", atk: 0.004 });
      fadeOut(o, sr, 14);
    },
  },
  /** Pulling a fresh one off the belt and letting it settle in the hand. */
  "balloon-load": {
    dur: 0.5, gain: 0.46, ref: 3, max: 45, prio: 0.3, jitter: 0.1,
    render: (o, sr, rnd) => {
      // Latex stretching: a squeak is a resonant band that rises and thins.
      noiseLayer(o, sr, rnd, { dur: 0.16, amp: 0.5, cut0: 1600, cut1: 4200, tau: 0.06, res: 2.8, mode: "band", atk: 0.008 });
      glug(o, sr, rnd, 0.1, 0.35, 2, 0.14);
      toneLayer(o, sr, rnd, { t0: 0.18, dur: 0.25, amp: 0.35, f0: 132, f1: 108, tau: 0.08, atk: 0.012, vib: 0.16, vibF: 14 });
      clack(o, sr, rnd, 0.3, 0.3, 900, 0.012);
      fadeOut(o, sr, 12);
    },
  },
  /**
   * THE BURST. The best sound in the game, and it is three events inside
   * 400 ms: a latex POP that is over in 4 ms, a broad wet slap behind it, and
   * then the scatter. Get the order wrong — slap first, pop late — and it
   * turns into a splash with a click on it, which is what most games ship.
   */
  "balloon-burst": {
    dur: 1.2, gain: 0.98, ref: 12, max: 900, wet: 1.25, prio: 0.95, gap: 0.03, same: 4,
    jitter: 0.07, travel: true, env: true, duck: 0.7, variants: 3,
    render: (o, sr, rnd, indoor) => {
      // 1. The pop: latex letting go. Brutally short, and the modal ring on
      //    wood partials is what makes it *rubber* rather than a click.
      noiseLayer(o, sr, rnd, { dur: 0.012, amp: 1, cut0: sr * 0.22, cut1: 3800, tau: 0.0017, atk: 0.00004, mode: "high" });
      modalLayer(o, sr, rnd, { freq: 1450, amp: 0.42, tau: 0.012, partials: WOOD_PARTIALS, damp: 0.35, detune: 0.04 });
      // 2. The water, arriving as one mass a hair later.
      wetSlap(o, sr, rnd, 0.004, 1, 1.15);
      // 3. …and everything that used to be inside it, landing.
      grainLayer(o, sr, rnd, { t0: 0.06, dur: 0.85, count: 30, amp: 0.3, f0: 600, f1: 4600, tau: 0.011, kind: "ping", clump: 0.75 });
      if (indoor) slapback(o, sr, { delay: 0.019, feedback: 0.62, damp: 1500, mix: 0.4, t0: 0.003 });
      else slapback(o, sr, { delay: 0.081, feedback: 0.3, damp: 3200, mix: 0.2, t0: 0.006 });
      saturate(o, 2);
      fadeOut(o, sr, 16);
    },
  },

  // --- The glue gun --------------------------------------------------------
  /** A strand landing and taking hold: suction, then stretch. */
  "glue-stick": {
    dur: 0.7, gain: 0.7, ref: 8, max: 260, wet: 0.9, prio: 0.75, gap: 0.05, same: 3, jitter: 0.08,
    render: (o, sr, rnd) => {
      // Contact: a wet thock, rising like every cavity closing in this file.
      toneLayer(o, sr, rnd, { dur: 0.14, amp: 0.75, f0: 190, f1: 560, tau: 0.04, atk: 0.0014 });
      noiseLayer(o, sr, rnd, { dur: 0.2, amp: 0.7, cut0: 2200, cut1: 420, tau: 0.05, res: 1.25, atk: 0.0007 });
      // Stretch: a slow resonant climb. This is the layer that says "and now
      // you are attached to something", and it has to arrive after the thock.
      noiseLayer(o, sr, rnd, { t0: 0.08, dur: 0.5, amp: 0.45, cut0: 700, cut1: 2900, tau: 0.19, res: 2.6, mode: "band", atk: 0.03 });
      toneLayer(o, sr, rnd, { t0: 0.1, dur: 0.45, amp: 0.3, f0: 320, f1: 780, tau: 0.16, atk: 0.03, vib: 0.07, vibF: 15 });
      grainLayer(o, sr, rnd, { t0: 0.04, dur: 0.3, count: 8, amp: 0.14, f0: 900, f1: 3600, tau: 0.009, kind: "ping" });
      saturate(o, 1.5);
      fadeOut(o, sr, 14);
    },
  },
  /**
   * The strand giving way. A twang, and the honest way to get one is a real
   * plucked string — `ksPluck` already ships for the music arp, and a filtered
   * sine sweep would sound like a cartoon boing instead of like tension going.
   */
  "glue-snap": {
    dur: 0.75, gain: 0.66, ref: 7, max: 220, wet: 1, prio: 0.8, gap: 0.05, same: 3, jitter: 0.1,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.02, amp: 0.6, cut0: 7000, cut1: 2200, tau: 0.004, mode: "high", atk: 0.00006 });
      ksPluck(o, sr, rnd, { t0: 0, freq: 196, amp: 0.8, dur: 0.5, damp: 0.35, bright: 0.8 });
      // The two ends recoiling through the air.
      noiseLayer(o, sr, rnd, { t0: 0.01, dur: 0.24, amp: 0.4, cut0: 3400, cut1: 900, tau: 0.07, res: 2, mode: "band", atk: 0.003 });
      toneLayer(o, sr, rnd, { t0: 0.005, dur: 0.3, amp: 0.35, f0: 620, f1: 180, tau: 0.09, atk: 0.002 });
      fadeOut(o, sr, 14);
    },
  },
  /** Going down while glued. Indignity, not injury: a thud and a wet flop. */
  "glue-stumble": {
    dur: 0.9, gain: 0.78, ref: 6, max: 150, prio: 0.7, jitter: 0.07,
    render: (o, sr, rnd) => {
      // The scramble — two scuffs before the ground arrives.
      noiseLayer(o, sr, rnd, { dur: 0.1, amp: 0.4, cut0: 2400, cut1: 700, tau: 0.035, res: 1.1, atk: 0.004 });
      noiseLayer(o, sr, rnd, { t0: 0.07, dur: 0.1, amp: 0.35, cut0: 1900, cut1: 600, tau: 0.03, res: 1.1, atk: 0.004 });
      // Body, flat out.
      toneLayer(o, sr, rnd, { t0: 0.16, dur: 0.4, amp: 0.9, f0: 104, f1: 34, tau: 0.11, atk: 0.0012 });
      wetSlap(o, sr, rnd, 0.16, 0.6, 1.35);
      // Rubber squeak on the way down, because the whole thing is comic.
      toneLayer(o, sr, rnd, { t0: 0.02, dur: 0.16, amp: 0.16, f0: 900, f1: 420, tau: 0.05, atk: 0.008, vib: 0.1, vibF: 21 });
      saturate(o, 1.7);
      fadeOut(o, sr, 14);
    },
  },

  // --- Refills and tanks ---------------------------------------------------
  /** The stroke every soaker shares: mechanical in, water back. */
  "pump-refill": {
    dur: 0.75, gain: 0.6, ref: 5, max: 85, prio: 0.42, jitter: 0.06,
    render: (o, sr, rnd) => {
      clack(o, sr, rnd, 0, 0.75, 1150, 0.026);
      // The draw stroke: air and water climbing the tube.
      noiseLayer(o, sr, rnd, { t0: 0.03, dur: 0.22, amp: 0.5, cut0: 900, cut1: 2600, tau: 0.11, res: 1.5, mode: "band", atk: 0.01 });
      glug(o, sr, rnd, 0.06, 0.4, 3, 0.18);
      // …and the stroke home.
      clack(o, sr, rnd, 0.3, 0.9, 880, 0.032);
      noiseLayer(o, sr, rnd, { t0: 0.3, dur: 0.28, amp: 0.4, cut0: 2200, cut1: 600, tau: 0.09, res: 1.2, atk: 0.003 });
      saturate(o, 1.5);
      fadeOut(o, sr, 12);
    },
  },
  /** The Firehose spooling: a ratchet accelerating, then the line charging. */
  "hose-spool": {
    dur: 1.15, gain: 0.55, ref: 6, max: 120, prio: 0.45,
    render: (o, sr, rnd) => {
      // Ratchet: ticks whose gaps close. Uniform gaps read as a machine gun.
      // Counted, not while-t<end: a geometric gap that only ever shrinks sums
      // to 0.075/(1-0.86) = 0.54 s and never reaches 0.62, so the obvious
      // spelling of this loop is an infinite one. The offline render harness
      // caught it; nothing in the type system or the build would have.
      let t = 0;
      let gap = 0.075;
      for (let i = 0; i < 16; i++) {
        modalLayer(o, sr, rnd, { t0: t, freq: 1800 + rnd() * 700, amp: 0.42, tau: 0.007, partials: WOOD_PARTIALS, damp: 0.4 });
        t += gap;
        gap = Math.max(0.016, gap * 0.86);
      }
      // Water reaching the nozzle: pressure rising under the ratchet.
      noiseLayer(o, sr, rnd, { t0: 0.1, dur: 0.95, amp: 0.6, cut0: 340, cut1: 1500, tau: 0.4, res: 0.9, atk: 0.12 });
      toneLayer(o, sr, rnd, { t0: 0.2, dur: 0.8, amp: 0.35, f0: 62, f1: 108, tau: 0.35, atk: 0.1, fm: 40, fmF: 21 });
      glug(o, sr, rnd, 0.55, 0.3, 3, 0.3);
      saturate(o, 1.5);
      fadeOut(o, sr, 20);
    },
  },
  /** The Hydro Lance charging: pressure climbing to a valve seating hard. */
  "lance-charge": {
    dur: 1.0, gain: 0.58, ref: 5, max: 95, prio: 0.5,
    render: (o, sr, rnd) => {
      // A rising resonant band is a pump loading. The narrower it gets the
      // more it reads as pressure rather than as wind.
      noiseLayer(o, sr, rnd, { dur: 0.75, amp: 0.65, cut0: 600, cut1: 4200, tau: 0.34, res: 2.9, mode: "band", atk: 0.09 });
      toneLayer(o, sr, rnd, { dur: 0.7, amp: 0.3, f0: 120, f1: 430, tau: 0.3, atk: 0.08, fm: 60, fmF: 33 });
      // The seat: the whole reason this cue is satisfying to hold.
      clack(o, sr, rnd, 0.74, 0.9, 1450, 0.026);
      noiseLayer(o, sr, rnd, { t0: 0.74, dur: 0.14, amp: 0.4, cut0: 5200, cut1: 1200, tau: 0.035, res: 1.4, mode: "high", atk: 0.0006 });
      saturate(o, 1.5);
      fadeOut(o, sr, 16);
    },
  },
  /** Seating a fresh glue cartridge: thick, and slightly disgusting. */
  "glue-load": {
    dur: 0.6, gain: 0.55, ref: 4, max: 60, prio: 0.35,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.14, amp: 0.4, cut0: 1200, cut1: 400, tau: 0.05, res: 1.1, atk: 0.006 });
      glug(o, sr, rnd, 0.05, 0.55, 3, 0.22);
      toneLayer(o, sr, rnd, { t0: 0.08, dur: 0.3, amp: 0.3, f0: 105, f1: 190, tau: 0.1, atk: 0.01, fm: 90, fmF: 19 });
      clack(o, sr, rnd, 0.36, 0.8, 1020, 0.028);
      saturate(o, 1.4);
      fadeOut(o, sr, 12);
    },
  },
  /** Dunking the tank in a pool, a trough or the sea. All bubbles. */
  "dunk-start": {
    dur: 1.1, gain: 0.6, ref: 5, max: 110, prio: 0.5, jitter: 0.06,
    render: (o, sr, rnd) => {
      // Breaking the surface.
      noiseLayer(o, sr, rnd, { dur: 0.3, amp: 0.75, cut0: 3800, cut1: 380, tau: 0.09, res: 1.05, atk: 0.0008 });
      toneLayer(o, sr, rnd, { dur: 0.2, amp: 0.4, f0: 220, f1: 700, tau: 0.06, atk: 0.0016 });
      // Then a tank filling, which is glugs slowing down as it gets full.
      glug(o, sr, rnd, 0.16, 0.6, 7, 0.7);
      noiseLayer(o, sr, rnd, { t0: 0.15, dur: 0.85, amp: 0.3, cut0: 700, cut1: 220, tau: 0.35, res: 0.85, atk: 0.03 });
      fadeOut(o, sr, 18);
    },
  },

  // --- The Downpour --------------------------------------------------------
  /**
   * Crossing into it: a wall of rain arriving. The swell is the whole cue —
   * a rain bed that simply switches on reads as a fader move, and the point
   * of this moment is that the weather came to you.
   */
  "downpour-enter": {
    dur: 2.0, gain: 0.72, bus: "ui", prio: 0.9, stereo: true,
    render: (o, sr, rnd) => {
      // Two rain layers, sparse-then-dense, because an arrival is a change in
      // DENSITY and a level ramp alone reads as somebody moving a fader. The
      // first spits at you; the second is the sheet catching up.
      rainLayer(o, sr, rnd, 0, 0.8, 0.3, 3000, 26, 0.12);
      rainLayer(o, sr, rnd, 0.45, 1.45, 0.85, 4400, 200, 0.4);
      // Under it, the low rumble of a lot of water hitting a lot of ground.
      toneLayer(o, sr, rnd, { dur: 1.8, amp: 0.4, f0: 44, f1: 78, tau: 0.9, atk: 0.22, fm: 22, fmF: 7 });
      // The leading edge sweeping over you.
      noiseLayer(o, sr, rnd, { dur: 1.6, amp: 0.5, cut0: 700, cut1: 5200, tau: 0.7, res: 1.05, mode: "band", atk: 0.16 });
      fadeIn(o, sr, 40);
      fadeOut(o, sr, 60);
    },
  },
  /**
   * The warning. Urgent without a klaxon: three rising water-drop bloops on a
   * closing rhythm, over a rain hiss that swells under them. The urgency is
   * in the tempo and the pitch ladder, never in a sawtooth — a two-tone siren
   * in a water fight would be the one sound that breaks the premise.
   */
  "downpour-warn": {
    dur: 2.3, gain: 0.56, bus: "ui", prio: 0.85, gap: 0.4,
    render: (o, sr, rnd) => {
      const at = [0, 0.5, 0.88, 1.14];
      const f = [420, 520, 640, 800];
      for (let i = 0; i < at.length; i++) {
        toneLayer(o, sr, rnd, { t0: at[i], dur: 0.32, amp: 0.62 + i * 0.08, f0: f[i], f1: f[i] * 2.2, tau: 0.055, atk: 0.0022 });
        noiseLayer(o, sr, rnd, {
          t0: at[i], dur: 0.16, amp: 0.22, cut0: f[i] * 4, cut1: f[i] * 1.4, tau: 0.03, res: 2.2, mode: "band", atk: 0.001,
        });
      }
      // The weather answering.
      rainLayer(o, sr, rnd, 0.9, 1.35, 0.32, 3400, 90);
      toneLayer(o, sr, rnd, { t0: 1.0, dur: 1.2, amp: 0.2, f0: 52, f1: 84, tau: 0.55, atk: 0.2 });
      fadeOut(o, sr, 50);
    },
  },
  /** The wall starting to move. The water-mode counterpart of `storm-close`. */
  "downpour-close": {
    dur: 3.4, gain: 0.62, prio: 0.8, stereo: true,
    render: (o, sr, rnd) => {
      rainLayer(o, sr, rnd, 0, 3.2, 0.7, 3000, 300);
      toneLayer(o, sr, rnd, { dur: 3.2, amp: 0.45, f0: 86, f1: 33, tau: 1.5, atk: 0.35 });
      // Distant thunder, once, low enough to be felt rather than identified.
      toneLayer(o, sr, rnd, { t0: 0.6, dur: 2.2, amp: 0.3, f0: 58, f1: 30, tau: 0.9, atk: 0.25, fm: 26, fmF: 5 });
      noiseLayer(o, sr, rnd, { t0: 0.55, dur: 2.4, amp: 0.28, cut0: 260, cut1: 90, tau: 1, res: 0.8, atk: 0.3 });
      fadeOut(o, sr, 120);
    },
  },
  /** Getting out of it. Everything opens up and the patter falls away. */
  "downpour-exit": {
    dur: 1.5, gain: 0.58, bus: "ui", prio: 0.85, stereo: true,
    render: (o, sr, rnd) => {
      // Leaving is the same trick in reverse: the drops thin out before the
      // hiss does, which is what it sounds like to walk out from under it.
      rainLayer(o, sr, rnd, 0, 0.5, 0.6, 3800, 50);
      rainLayer(o, sr, rnd, 0.42, 0.75, 0.22, 2600, 14);
      // Relief is a band that opens and a level that leaves.
      noiseLayer(o, sr, rnd, { dur: 1.2, amp: 0.4, cut0: 2600, cut1: 6000, tau: 0.34, res: 1, mode: "band", atk: 0.03 });
      toneLayer(o, sr, rnd, { dur: 0.9, amp: 0.25, f0: 96, f1: 190, tau: 0.35, atk: 0.03 });
      fadeOut(o, sr, 50);
    },
  },

  // --- Getting dry ---------------------------------------------------------
  /** Pulling a poncho over your head: crinkle, then the hood settling. */
  "poncho-on-start": {
    dur: 0.7, gain: 0.5, ref: 3, max: 40, prio: 0.4, jitter: 0.08,
    render: (o, sr, rnd) => {
      // Thin plastic is a crowd of tiny events, not a swept band.
      grainLayer(o, sr, rnd, { dur: 0.45, count: 40, amp: 0.4, f0: 2600, f1: 9000, tau: 0.003, kind: "tick", clump: 0.3 });
      noiseLayer(o, sr, rnd, { dur: 0.4, amp: 0.4, cut0: 1800, cut1: 5200, tau: 0.16, res: 1.3, mode: "band", atk: 0.02 });
      fadeOut(o, sr, 12);
    },
  },
  /** …and on. The dull thump of a hood landing is the "it worked" beat. */
  "poncho-on": {
    dur: 0.75, gain: 0.58, ref: 3, max: 45, prio: 0.45,
    render: (o, sr, rnd) => {
      grainLayer(o, sr, rnd, { dur: 0.3, count: 26, amp: 0.35, f0: 2400, f1: 8000, tau: 0.003, kind: "tick", clump: 0.5 });
      noiseLayer(o, sr, rnd, { t0: 0.08, dur: 0.3, amp: 0.5, cut0: 3200, cut1: 700, tau: 0.1, res: 1.1, atk: 0.01 });
      toneLayer(o, sr, rnd, { t0: 0.2, dur: 0.3, amp: 0.4, f0: 128, f1: 62, tau: 0.08, atk: 0.004 });
      // Two rising notes: quiet, but this is a defensive item paying off.
      chime(o, sr, rnd, [784, 1046.5], 0.26, 0.1, 0.16, 0.16);
      fadeOut(o, sr, 14);
    },
  },
  /** Towelling off: friction, in three strokes that get shorter. */
  "towel-rub-start": {
    dur: 0.9, gain: 0.46, ref: 3, max: 34, prio: 0.35,
    render: (o, sr, rnd) => {
      for (let i = 0; i < 3; i++) {
        const t = i * 0.26;
        const up = i % 2 === 0;
        // A stroke is a band sweeping one way; alternating the direction is
        // what makes three of them read as rubbing rather than as three hisses.
        noiseLayer(o, sr, rnd, {
          t0: t, dur: 0.24, amp: 0.55 - i * 0.06, cut0: up ? 900 : 2600, cut1: up ? 2600 : 900,
          tau: 0.1, res: 1.15, mode: "band", atk: 0.018,
        });
      }
      fadeOut(o, sr, 14);
    },
  },
  "towel-rub": {
    dur: 0.8, gain: 0.5, ref: 3, max: 34, prio: 0.4,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.3, amp: 0.55, cut0: 2400, cut1: 900, tau: 0.12, res: 1.1, mode: "band", atk: 0.016 });
      noiseLayer(o, sr, rnd, { t0: 0.22, dur: 0.26, amp: 0.4, cut0: 1100, cut1: 3000, tau: 0.1, res: 1.2, mode: "band", atk: 0.014 });
      // A flick of the towel to finish, and a small "that's better".
      noiseLayer(o, sr, rnd, { t0: 0.44, dur: 0.1, amp: 0.45, cut0: 5200, cut1: 1400, tau: 0.026, res: 1.6, mode: "high", atk: 0.001 });
      chime(o, sr, rnd, [880], 0.48, 0.1, 0.14, 0.14);
      fadeOut(o, sr, 12);
    },
  },
  /** A hair dryer spinning up: a warm motor, not a fan. */
  "hair-dryer-start": {
    dur: 1.4, gain: 0.5, ref: 3, max: 44, prio: 0.4,
    render: (o, sr, rnd) => {
      // Motor: a saw whose harmonics glide up as it finds its speed. The FM
      // is the commutator, and without it this is a synthesiser sweep.
      toneLayer(o, sr, rnd, { dur: 1.3, amp: 0.42, f0: 88, f1: 186, tau: 0.9, atk: 0.06, shape: "saw", fm: 26, fmF: 128 });
      toneLayer(o, sr, rnd, { dur: 1.3, amp: 0.2, f0: 176, f1: 372, tau: 0.9, atk: 0.09, shape: "tri" });
      // Air through the element: hot air is a broad band, not a hiss.
      noiseLayer(o, sr, rnd, { dur: 1.3, amp: 0.6, cut0: 900, cut1: 3000, tau: 0.85, res: 0.85, atk: 0.1 });
      clack(o, sr, rnd, 0, 0.35, 1400, 0.01);
      saturate(o, 1.4);
      fadeOut(o, sr, 30);
    },
  },
  /** …and winding down, warm and finished. */
  "hair-dryer": {
    dur: 1.3, gain: 0.55, ref: 3, max: 44, prio: 0.45,
    render: (o, sr, rnd) => {
      toneLayer(o, sr, rnd, { dur: 0.9, amp: 0.42, f0: 186, f1: 62, tau: 0.4, atk: 0.02, shape: "saw", fm: 24, fmF: 120 });
      noiseLayer(o, sr, rnd, { dur: 1.0, amp: 0.55, cut0: 3000, cut1: 600, tau: 0.36, res: 0.85, atk: 0.02 });
      clack(o, sr, rnd, 0.02, 0.3, 1300, 0.01);
      // Bone dry. Three notes up, and the only unambiguously happy cue here.
      chime(o, sr, rnd, [659.25, 880, 1174.7], 0.44, 0.1, 0.22, 0.2);
      fadeOut(o, sr, 20);
    },
  },

  // --- Bodies and puddles --------------------------------------------------
  /**
   * You, at zero dryness. Not a death rattle — a slump and a squelch, which
   * means a low wet body sound with a comic bloop in it and no impact at all.
   */
  squelch: {
    dur: 1.0, gain: 0.8, ref: 5, max: 120, prio: 0.85, jitter: 0.05,
    render: (o, sr, rnd) => {
      // Sodden clothing hitting sodden ground.
      wetSlap(o, sr, rnd, 0, 0.8, 1.7);
      // The squelch proper: a low resonance that falls and then rises, which
      // is water being pushed out of fabric and then sucked back into it.
      toneLayer(o, sr, rnd, { t0: 0.06, dur: 0.45, amp: 0.5, f0: 190, f1: 78, tau: 0.16, atk: 0.012, fm: 70, fmF: 17, vib: 0.09, vibF: 6 });
      toneLayer(o, sr, rnd, { t0: 0.34, dur: 0.4, amp: 0.3, f0: 96, f1: 210, tau: 0.14, atk: 0.03, fm: 40, fmF: 13 });
      noiseLayer(o, sr, rnd, { t0: 0.3, dur: 0.5, amp: 0.3, cut0: 800, cut1: 240, tau: 0.2, res: 1.25, atk: 0.02 });
      glug(o, sr, rnd, 0.42, 0.22, 3, 0.3);
      saturate(o, 1.5);
      fadeOut(o, sr, 18);
    },
  },
  /** Losing your feet on a puddle. Friction, then an involuntary squeak. */
  skid: {
    dur: 0.6, gain: 0.55, ref: 4, max: 70, prio: 0.5, jitter: 0.14, same: 2, gap: 0.12,
    render: (o, sr, rnd) => {
      // Wet rubber on wet ground: a high resonant band that slides.
      noiseLayer(o, sr, rnd, { dur: 0.38, amp: 0.7, cut0: 2200, cut1: 5200, tau: 0.14, res: 3.2, mode: "band", atk: 0.008 });
      toneLayer(o, sr, rnd, { t0: 0.03, dur: 0.34, amp: 0.35, f0: 780, f1: 1900, tau: 0.12, atk: 0.01, vib: 0.06, vibF: 26 });
      // The water being pushed along in front of the foot.
      noiseLayer(o, sr, rnd, { dur: 0.3, amp: 0.4, cut0: 1400, cut1: 340, tau: 0.1, res: 0.9, atk: 0.006 });
      grainLayer(o, sr, rnd, { t0: 0.02, dur: 0.3, count: 9, amp: 0.16, f0: 900, f1: 3400, tau: 0.008, kind: "ping" });
      fadeOut(o, sr, 14);
    },
  },
  /**
   * THE ELIMINATION. Somebody has just come apart into water, and this is the
   * punchline of every fight in the mode, so it gets the most layers of
   * anything here: a bucket hitting pavement, scaled up by half again.
   *
   * Fired off the `dz:soakburst` event rather than by name, because
   * `mode/water.ts` already spends the name `soak-burst` on the Triple Tap.
   * Layer order is the whole sound: the mass arrives, the sheet spreads, the
   * bucket rings once (hollow, comic, gone in 90 ms), and then it rains.
   */
  "soak-out": {
    dur: 2.0, gain: 1.05, ref: 16, max: 900, wet: 1.4, prio: 0.97, gap: 0.12, same: 2,
    jitter: 0.05, travel: true, env: true, duck: 0.85, variants: 3,
    render: (o, sr, rnd, indoor) => {
      // The mass. Twice the size of a balloon and half again as slow.
      wetSlap(o, sr, rnd, 0, 1, 2.4);
      // A second slap a hair later and a size down: two arrivals read as a
      // volume of water rather than as one impact, which is the entire trick.
      wetSlap(o, sr, rnd, 0.055, 0.6, 1.4);
      // The hollow ring of the bucket itself. Brief and slightly ridiculous.
      modalLayer(o, sr, rnd, { t0: 0.006, freq: 320, amp: 0.28, tau: 0.09, partials: [1, 2.4, 3.9], damp: 0.5, detune: 0.02 });
      // Sub: the floor taking it.
      toneLayer(o, sr, rnd, { dur: 0.7, amp: 0.5, f0: 74, f1: 28, tau: 0.2, atk: 0.002 });
      // And then it rains for a second and a half.
      grainLayer(o, sr, rnd, { t0: 0.12, dur: 1.5, count: 54, amp: 0.34, f0: 500, f1: 4200, tau: 0.013, kind: "ping", clump: 0.55 });
      noiseLayer(o, sr, rnd, { t0: 0.1, dur: 1.4, amp: 0.24, cut0: 1600, cut1: 400, tau: 0.5, res: 0.9, atk: 0.05 });
      if (indoor) slapback(o, sr, { delay: 0.02, feedback: 0.66, damp: 1400, mix: 0.5, t0: 0.004 });
      else slapback(o, sr, { delay: 0.088, feedback: 0.32, damp: 3000, mix: 0.24, t0: 0.007 });
      saturate(o, 2.1);
      fadeOut(o, sr, 24);
    },
  },

  // --- Harvesting the block party ------------------------------------------
  /** Pool noodles. Foam is the most damped thing in the game: a dull thwack. */
  "harvest-foam": {
    dur: 0.4, gain: 0.6, ref: 6, max: 130, prio: 0.4, gap: 0.02, same: 4, jitter: 0.12,
    render: (o, sr, rnd) => {
      // No ring, no grit, and the cutoff collapses almost immediately — every
      // one of those absences is what says "foam" rather than "wood".
      noiseLayer(o, sr, rnd, { dur: 0.16, amp: 0.7, cut0: 1500, cut1: 260, tau: 0.028, res: 0.8, atk: 0.0012 });
      toneLayer(o, sr, rnd, { dur: 0.22, amp: 0.65, f0: 132, f1: 62, tau: 0.05, atk: 0.0016 });
      // The squeak of a hand dragging across closed-cell foam.
      noiseLayer(o, sr, rnd, { t0: 0.03, dur: 0.16, amp: 0.16, cut0: 2200, cut1: 3600, tau: 0.06, res: 2.6, mode: "band", atk: 0.01 });
      fadeOut(o, sr, 10);
    },
  },
  /** Deck planks. Dry, harmonic, and the brightest of the three. */
  "harvest-plank": {
    dur: 0.5, gain: 0.66, ref: 7, max: 170, prio: 0.42, gap: 0.02, same: 4, jitter: 0.1,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.09, amp: 0.7, cut0: 4800, cut1: 1200, tau: 0.018, res: 1.2, atk: 0.0004 });
      modalLayer(o, sr, rnd, { freq: 420, amp: 0.6, tau: 0.1, partials: WOOD_PARTIALS, damp: 0.55, detune: 0.02 });
      toneLayer(o, sr, rnd, { dur: 0.2, amp: 0.35, f0: 160, f1: 78, tau: 0.05, atk: 0.001 });
      grainLayer(o, sr, rnd, { t0: 0.01, dur: 0.16, count: 6, amp: 0.16, f0: 2200, f1: 6000, tau: 0.005, kind: "tick" });
      fadeOut(o, sr, 10);
    },
  },
  /** Corrugated tarp. Thin sheet: a rattle and a flutter, never a clang. */
  "harvest-tarp": {
    dur: 0.55, gain: 0.62, ref: 7, max: 180, prio: 0.42, gap: 0.02, same: 4, jitter: 0.12,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.12, amp: 0.7, cut0: 6200, cut1: 1600, tau: 0.02, res: 1.3, mode: "high", atk: 0.0004 });
      // A sheet is a wobble board: a low modal with a big detune, damped fast.
      modalLayer(o, sr, rnd, { freq: 210, amp: 0.45, tau: 0.13, partials: [1, 1.87, 3.14, 4.6], damp: 0.7, detune: 0.06 });
      // The flutter after the strike — amplitude wobble, cheap and unmistakable.
      noiseLayer(o, sr, rnd, { t0: 0.03, dur: 0.3, amp: 0.3, cut0: 1800, cut1: 700, tau: 0.11, res: 1.9, mode: "band", atk: 0.006 });
      toneLayer(o, sr, rnd, { t0: 0.02, dur: 0.28, amp: 0.2, f0: 138, f1: 96, tau: 0.09, atk: 0.006, vib: 0.22, vibF: 19 });
      fadeOut(o, sr, 12);
    },
  },

  // --- The safety net ------------------------------------------------------
  // Twelve systems ship independently and one of them will always ask for a
  // name nobody wrote. Silence is a worse bug than an approximate sound.
  generic: {
    dur: 0.3, gain: 0.4, ref: 6, max: 140, prio: 0.3,
    render: (o, sr, rnd) => {
      noiseLayer(o, sr, rnd, { dur: 0.2, amp: 0.6, cut0: 2400, cut1: 400, tau: 0.05, res: 0.9, atk: 0.0006 });
      toneLayer(o, sr, rnd, { dur: 0.16, amp: 0.4, f0: 180, f1: 90, tau: 0.05 });
      fadeOut(o, sr, 8);
    },
  },
};

/** Names other modules already call that map onto a cue above. */
const ALIASES: Record<string, string> = {
  // Weapons — every plausible spelling of every class.
  gunshot: "shot-ar", shoot: "shot-ar", fire: "shot-ar", ar: "shot-ar",
  rifle: "shot-ar", assault: "shot-ar", scar: "shot-ar",
  smg: "shot-smg", "shot-uzi": "shot-smg", uzi: "shot-smg",
  pistol: "shot-pistol", "shot-revolver": "shot-pistol", deagle: "shot-pistol",
  shotgun: "shot-pump", pump: "shot-pump", "shot-shotgun": "shot-pump",
  tac: "shot-tac", sniper: "shot-sniper", "shot-bolt": "shot-sniper",
  minigun: "shot-minigun", lmg: "shot-minigun", "shot-lmg": "shot-minigun",
  rocket: "shot-rocket", rpg: "shot-rocket", launcher: "shot-rocket",
  // Explosions.
  explode: "explosion", blast: "explosion", boom: "explosion", grenade: "explosion",
  // Impacts.
  impact: "impact-concrete", hit: "impact-concrete", "bullet-hit": "impact-concrete",
  concrete: "impact-concrete", stone: "impact-concrete", metal: "impact-metal",
  wood: "impact-wood", dirt: "impact-dirt", grass: "impact-grass", sand: "impact-sand",
  glass: "impact-glass", flesh: "impact-flesh", blood: "impact-flesh",
  water: "impact-water", "impact-rock": "impact-concrete",
  // Water. `water.ts` uses the San Palmas underscore spelling.
  splash: "splash-in", dive: "splash-in", surface: "splash-out",
  // Mechanics.
  reload: "mag-in", magazine: "mag-in", bolt: "bolt-back", cock: "bolt-back",
  slide: "bolt-forward", rack: "pump-action", shell: "shell-drop", casing: "shell-drop",
  swap: "weapon-swap", equip: "weapon-swap", ads: "ads-in", "ads-out": "ads-in",
  // Movement.
  footstep: "step-dirt", step: "step-dirt", walk: "step-dirt", run: "step-dirt",
  "land-soft": "land", thud: "land", parachute: "glider-deploy", glider: "glider-deploy",
  chute: "glider-deploy", flap: "glider-flap", skydive: "dive-out", freefall: "dive-out",
  // Feedback.
  damage: "hurt", pain: "hurt", die: "death", killed: "death", knocked: "down",
  kill: "elim-confirm", elim: "elim-confirm", eliminate: "elim-confirm",
  defeat: "eliminated", "victory-royale": "victory",
  // UI + loot.
  click: "ui-tick", ui: "ui-tick", beep: "ui-tick", select: "ui-tick", tick: "ui-tick",
  deny: "ui-deny", error: "ui-deny", pickup: "item-pickup", loot: "loot-pickup",
  chest: "chest-open", potion: "consume-shield-start", bandage: "consume-health-start",
  // Building.
  build: "build-place", place: "build-place", "build-place-brick": "build-place-stone",
  harvest: "pickaxe-hit", pickaxe: "pickaxe-swing", "break": "build-break",
  // World.
  horn: "bus-horn", bus: "bus-horn", siren: "storm-warn", alarm: "storm-warn",
  storm: "storm-close", thunder: "storm-close", whoosh: "pickaxe-whoosh",
  ricochet_metal: "ricochet", whistle: "whizz", crack: "whizz",
  // SPLASH ROYALE. The left-hand names are the ones `mode/water.ts` and the
  // water systems spell; anything that is already a cue above is not repeated.
  soak: "soak-ar", soaker: "soak-ar", "water-gun": "soak-ar", squirt: "soak-pistol",
  "soak-minigun": "soak-hose", "soak-sniper": "soak-lance", "soak-rocket": "soak-lob",
  "soak-shotgun": "soak-pump", "soak-smg2": "soak-smg",
  balloon: "balloon-burst", "water-balloon": "balloon-burst", pop: "balloon-burst",
  glue: "glue-fire", strand: "glue-stick", snap: "glue-snap", stumble: "glue-stumble",
  downpour: "downpour-close", rain: "downpour-close", "downpour-loop": "downpour-close",
  drench: "squelch", soaked: "squelch", slip: "skid", slide_wet: "skid",
  towel: "towel-rub", poncho: "poncho-on", dryer: "hair-dryer", dry: "hair-dryer",
  refill: "pump-refill", dunk: "dunk-start", tank: "pump-refill",
  eliminate_water: "soak-out", "soak-elim": "soak-out", splat: "soak-out",
  "harvest-noodle": "harvest-foam", "harvest-deck": "harvest-plank",
  "harvest-sheet": "harvest-tarp",
};

/**
 * Resolve any name to something playable. Other systems shipped in parallel
 * with this one and will ask for names nobody wrote; landing on an
 * approximate cue beats silence every time, and the memo means the fuzzy
 * path runs at most once per distinct string for the life of the page.
 */
const resolveCache = new Map<string, string>();
function resolveCue(name: string): string {
  const cached = resolveCache.get(name);
  if (cached !== undefined) return cached;
  let key = "generic";
  if (CUES[name]) key = name;
  else if (ALIASES[name]) key = ALIASES[name];
  else {
    // Normalise separators first: `splash_in`, `splash in` and `Splash-In`
    // are all the same cue as far as a caller is concerned.
    const n = name.toLowerCase().replace(/[\s_]+/g, "-");
    if (CUES[n]) key = n;
    else if (ALIASES[n]) key = ALIASES[n];
    // SPLASH ROYALE first. These have to outrank the firearm rules below or
    // "glue-fire" lands on an assault rifle, which is exactly what it did
    // before this block existed — the fuzzy path is not a safety net when the
    // wrong branch is a confident match.
    else if (n.includes("soak") || n.includes("drench")) key = "soak-ar";
    else if (n.includes("balloon")) key = "balloon-burst";
    else if (n.includes("glue")) key = "glue-fire";
    else if (n.includes("downpour") || n.includes("rain")) key = "downpour-close";
    else if (n.includes("towel")) key = "towel-rub";
    else if (n.includes("poncho")) key = "poncho-on";
    else if (n.includes("dryer") || n.includes("drying")) key = "hair-dryer";
    else if (n.includes("squelch") || n.includes("squish")) key = "squelch";
    else if (n.includes("skid") || n.includes("slip")) key = "skid";
    else if (n.includes("dunk")) key = "dunk-start";
    else if (n.includes("refill")) key = "pump-refill";
    else if (n.includes("explo") || n.includes("blast") || n.includes("boom")) key = "explosion";
    else if (n.includes("rocket") || n.includes("missile")) key = "shot-rocket";
    else if (n.includes("shotgun") || n.includes("pump")) key = "shot-pump";
    else if (n.includes("sniper") || n.includes("bolt-action")) key = "shot-sniper";
    else if (n.includes("pistol") || n.includes("revolver")) key = "shot-pistol";
    else if (n.includes("minigun") || n.includes("gatling")) key = "shot-minigun";
    else if (n.includes("smg") || n.includes("submachine")) key = "shot-smg";
    else if (n.includes("shot") || n.includes("gun") || n.includes("fire")) key = "shot-ar";
    else if (n.includes("step") || n.includes("foot")) key = "step-dirt";
    else if (n.includes("glass")) key = "impact-glass";
    else if (n.includes("metal") || n.includes("clang")) key = "impact-metal";
    else if (n.includes("wood") || n.includes("plank")) key = "impact-wood";
    else if (n.includes("water") || n.includes("splash")) key = "splash-in";
    else if (n.includes("break") || n.includes("destroy")) key = "build-break";
    else if (n.includes("build") || n.includes("place")) key = "build-place";
    else if (n.includes("harvest") || n.includes("pickaxe")) key = "pickaxe-hit";
    else if (n.includes("impact") || n.includes("hit")) key = "impact-concrete";
    else if (n.includes("rico")) key = "ricochet";
    else if (n.includes("mag") || n.includes("reload")) key = "mag-in";
    else if (n.includes("chest")) key = "chest-open";
    else if (n.includes("pickup") || n.includes("loot")) key = "item-pickup";
    else if (n.includes("shield")) key = "hit-shield";
    else if (n.includes("heal") || n.includes("health")) key = "consume-health";
    else if (n.includes("storm")) key = "storm-warn";
    else if (n.includes("horn") || n.includes("bus")) key = "bus-horn";
    else if (n.includes("deny") || n.includes("error")) key = "ui-deny";
    else if (n.includes("click") || n.includes("ui") || n.includes("menu")) key = "ui-tick";
    else if (n.includes("jump")) key = "jump";
    else if (n.includes("land")) key = "land";
    else if (n.includes("glide") || n.includes("chute")) key = "glider-deploy";
    else if (n.includes("hurt") || n.includes("damage")) key = "hurt";
    else if (n.includes("death") || n.includes("die")) key = "death";
  }
  resolveCache.set(name, key);
  return key;
}

// ===========================================================================
// 5. Ambience beds
//
// Long seamless loops rendered at a reduced sample rate — they are all
// low-band texture and paying full rate for them is waste. The director in
// section 9 owns their gains and their cutoffs; a bed never plays at a fixed
// level, because a fixed level is exactly what makes a loop audible as a loop.
// ===========================================================================

interface Bed {
  dur: number;
  /** Nominal gain when fully faded in. */
  gain: number;
  /** Starting lowpass cutoff. The director moves it with distance/altitude. */
  cut: number;
  render(o: Float32Array, sr: number, rnd: Rand): void;
}

const BEDS: Record<string, Bed> = {
  /**
   * Wind. Two slowly-wandering bands plus gusts. The lowpass the director
   * puts in front of this is doing half the work: at a standstill it is a
   * dull rumble, at terminal velocity in a skydive it is a scream.
   */
  wind: {
    dur: 9, gain: 0.46, cut: 1400,
    render: (o, sr, rnd) => {
      const span = o.length / sr;
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.3, cut0: 260, cut1: 380, tau: 1e6, res: 1.1, mode: "band", atk: 0.6 });
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.2, cut0: 90, cut1: 110, tau: 1e6, res: 0.8, atk: 0.9 });
      // Gusts. Overlapping, at random offsets, so no two loops line up.
      for (let i = 0; i < 14; i++) {
        const t = rnd() * (span - 2.5);
        noiseLayer(o, sr, rnd, {
          t0: t, dur: 2.4, amp: 0.22 + rnd() * 0.3, cut0: 300, cut1: 1300,
          tau: 0.85, res: 1.6, mode: "band", atk: 0.5,
        });
      }
      // A whistle band that comes and goes — edges and eaves catching the air.
      for (let i = 0; i < 4; i++) {
        const t = rnd() * (span - 3);
        const f = 1100 + rnd() * 900;
        noiseLayer(o, sr, rnd, {
          t0: t, dur: 2.8, amp: 0.09, cut0: f, cut1: f * 1.3, tau: 1.1, res: 3.4, mode: "band", atk: 0.9,
        });
      }
    },
  },

  /** Surf: overlapping breakers, each a slow crescendo into a long hiss. */
  surf: {
    dur: 11, gain: 0.52, cut: 2600,
    render: (o, sr, rnd) => {
      const span = o.length / sr;
      // Broadband wash so the gaps between breakers are never silent.
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.22, cut0: 700, cut1: 620, tau: 1e6, res: 0.6, atk: 0.5 });
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.16, cut0: 150, cut1: 130, tau: 1e6, res: 0.7, atk: 0.8 });
      for (let i = 0; i < 9; i++) {
        const t = (i / 9) * span + rnd() * 0.7;
        // Cutoff *rises* through the break: the wave gets brighter as it
        // collapses into foam. Falling cutoff would sound like a fade-out.
        noiseLayer(o, sr, rnd, {
          t0: t, dur: 3.2, amp: 0.5 + rnd() * 0.4, cut0: 380, cut1: 2200, tau: 1.1, res: 0.65, atk: 0.55,
        });
        noiseLayer(o, sr, rnd, { t0: t + 0.35, dur: 2.4, amp: 0.28, cut0: 120, cut1: 70, tau: 0.9, atk: 0.4 });
      }
      saturate(o, 1.2);
    },
  },

  /** Leaves. Only ever audible under the treeline, and it is what sells it. */
  forest: {
    dur: 8, gain: 0.3, cut: 6000,
    render: (o, sr, rnd) => {
      const span = o.length / sr;
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.16, cut0: 2600, cut1: 3400, tau: 1e6, res: 0.8, mode: "band", atk: 0.7 });
      // Individual rustles — a branch moving, not the whole canopy at once.
      for (let i = 0; i < 22; i++) {
        const t = rnd() * (span - 1.2);
        noiseLayer(o, sr, rnd, {
          t0: t, dur: 1.1, amp: 0.1 + rnd() * 0.16, cut0: 3000 + rnd() * 3000,
          cut1: 1200, tau: 0.4, res: 1.2, mode: "band", atk: 0.16,
        });
      }
      // The odd creak of a trunk under load.
      for (let i = 0; i < 3; i++) {
        const t = rnd() * (span - 1);
        toneLayer(o, sr, rnd, { t0: t, dur: 0.6, amp: 0.05, f0: 180, f1: 150, tau: 0.35, atk: 0.12, shape: "saw", vib: 0.02, vibF: 7 });
      }
    },
  },

  /** Daytime birdsong, thinning to nothing at dusk via its director target. */
  birds: {
    dur: 10, gain: 0.26, cut: 11000,
    render: (o, sr, rnd) => {
      const span = o.length / sr;
      // Several birds, each with their own tempo, none of them in sync.
      for (let b = 0; b < 6; b++) {
        const base = 2600 + rnd() * 3000;
        const period = 1.6 + rnd() * 3.2;
        const amp = 0.16 + rnd() * 0.24;
        for (let t = rnd() * period; t < span - 0.6; t += period * (0.75 + rnd() * 0.5)) {
          const notes = 2 + Math.floor(rnd() * 4);
          let nt = t;
          for (let i = 0; i < notes; i++) {
            const f = base * (0.85 + rnd() * 0.35);
            toneLayer(o, sr, rnd, {
              t0: nt, dur: 0.07, amp, f0: f, f1: f * (0.65 + rnd() * 0.8), tau: 0.018, atk: 0.0018,
            });
            nt += 0.05 + rnd() * 0.08;
          }
        }
      }
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.04, cut0: 300, cut1: 280, tau: 1e6, atk: 1 });
    },
  },

  /** Cicada drone — amplitude-modulated high band, colonies out of phase. */
  insects: {
    dur: 7, gain: 0.3, cut: 9000,
    render: (o, sr, rnd) => {
      const n = o.length;
      for (let c = 0; c < 4; c++) {
        const centre = 4200 + rnd() * 3000;
        // 38–64 Hz AM is the buzz. Below ~25 Hz it turns into a stutter, above
        // ~80 it turns into a sideband whine; that window is what sounds alive.
        const amRate = 38 + rnd() * 26;
        const scratch = new Float32Array(n);
        noiseLayer(scratch, sr, rnd, {
          dur: n / sr, amp: 0.5, cut0: centre, cut1: centre * 1.1, tau: 1e6, res: 3.2, mode: "band", atk: 0.4,
        });
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

  /** Crickets. Discrete chirp trains, each insect on its own tempo. */
  night: {
    dur: 7, gain: 0.3, cut: 9000,
    render: (o, sr, rnd) => {
      const span = o.length / sr;
      for (let c = 0; c < 5; c++) {
        const f = 3800 + rnd() * 2400;
        const period = 0.34 + rnd() * 0.5;
        const amp = 0.25 + rnd() * 0.35;
        for (let t = rnd() * period; t < span - 0.2; t += period) {
          // Three pulses per chirp. Two sounds mechanical, four sounds like a
          // different animal entirely.
          for (let p = 0; p < 3; p++) {
            toneLayer(o, sr, rnd, { t0: t + p * 0.028, dur: 0.03, amp, f0: f, f1: f * 0.97, tau: 0.007, atk: 0.0012 });
          }
        }
      }
      // A low owl-ish hoot now and then, and the air underneath everything.
      for (let i = 0; i < 2; i++) {
        const t = rnd() * (span - 1.5);
        toneLayer(o, sr, rnd, { t0: t, dur: 0.4, amp: 0.09, f0: 380, f1: 350, tau: 0.16, atk: 0.05 });
        toneLayer(o, sr, rnd, { t0: t + 0.5, dur: 0.5, amp: 0.07, f0: 340, f1: 310, tau: 0.2, atk: 0.06 });
      }
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.08, cut0: 220, cut1: 200, tau: 1e6, atk: 1 });
    },
  },

  /** Inside a POI: air handling, a loose panel, the hum of an empty building. */
  urban: {
    dur: 9, gain: 0.3, cut: 1400,
    render: (o, sr, rnd) => {
      const span = o.length / sr;
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.3, cut0: 170, cut1: 200, tau: 1e6, res: 0.7, atk: 0.7 });
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.1, cut0: 1300, cut1: 1500, tau: 1e6, res: 0.6, atk: 0.9 });
      // Mains hum, quiet and just detuned enough not to sound like a test tone.
      toneLayer(o, sr, rnd, { dur: span, amp: 0.05, f0: loopSnap(100, span), f1: loopSnap(100, span), tau: 1e6, atk: 1.2 });
      // Loose corrugated sheet, a distant door.
      for (let i = 0; i < 5; i++) {
        const t = rnd() * (span - 1.5);
        modalLayer(o, sr, rnd, { t0: t, freq: 420 + rnd() * 500, amp: 0.05, tau: 0.28, damp: 0.6, detune: 0.03 });
      }
    },
  },

  /**
   * The storm wall. This is a *roar*, not a hiss: the low band carries it and
   * the crackle sits on top. Level and cutoff both track distance to the
   * wall, so approaching it from inside the circle is genuinely frightening.
   */
  storm: {
    dur: 8, gain: 0.5, cut: 900,
    render: (o, sr, rnd) => {
      const span = o.length / sr;
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.42, cut0: 190, cut1: 240, tau: 1e6, res: 0.8, atk: 0.5 });
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.24, cut0: 900, cut1: 1400, tau: 1e6, res: 0.9, mode: "band", atk: 0.8 });
      // Surges: the wall breathing.
      for (let i = 0; i < 7; i++) {
        const t = rnd() * (span - 3);
        noiseLayer(o, sr, rnd, {
          t0: t, dur: 3, amp: 0.2 + rnd() * 0.2, cut0: 300, cut1: 900, tau: 1.3, res: 1.2, atk: 0.8,
        });
      }
      // Electrical crackle scattered through it.
      grainLayer(o, sr, rnd, { dur: span - 0.4, count: 90, amp: 0.09, f0: 1800, f1: 8000, tau: 0.005, kind: "tick", clump: 0 });
      saturate(o, 1.25);
    },
  },

  /**
   * THE DOWNPOUR. The water-mode counterpart of `storm`, and deliberately not
   * the same bed with a filter on it: the storm wall is an electrical roar
   * carried by its low band, while rain is thousands of discrete arrivals and
   * lives in the top. Broadband hiss alone is an extractor fan — the patter
   * grains are what make it rain, and the surges are what stop it being a
   * loop. The director opens its cutoff as you approach the wall.
   */
  downpour: {
    dur: 8, gain: 0.5, cut: 1400,
    render: (o, sr, rnd) => {
      const span = o.length / sr;
      // Two hiss bands: the sheet, and the ground it is landing on.
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.32, cut0: 2600, cut1: 3200, tau: 1e6, res: 0.75, atk: 0.6 });
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.26, cut0: 800, cut1: 620, tau: 1e6, res: 0.85, atk: 0.8 });
      // Weight underneath, so it is weather and not static.
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.2, cut0: 150, cut1: 190, tau: 1e6, res: 0.8, atk: 1 });
      // The patter. 520 drops over 8 s is sparse enough to hear as individual
      // arrivals near the top of the band and dense enough to fuse below it.
      grainLayer(o, sr, rnd, { dur: span - 0.3, count: 520, amp: 0.07, f0: 1600, f1: 8000, tau: 0.004, kind: "tick", clump: 0 });
      // Gusts: rain does not fall at a constant rate for eight seconds.
      for (let i = 0; i < 6; i++) {
        const t = rnd() * (span - 3);
        noiseLayer(o, sr, rnd, {
          t0: t, dur: 3, amp: 0.12 + rnd() * 0.14, cut0: 1200, cut1: 3400, tau: 1.4, res: 1, atk: 0.9,
        });
      }
      // Fat drops off a roof edge, scattered and much slower.
      grainLayer(o, sr, rnd, { dur: span - 0.5, count: 26, amp: 0.1, f0: 400, f1: 1300, tau: 0.02, kind: "ping", clump: 0 });
      saturate(o, 1.2);
    },
  },

  /** Underwater: everything above ~400 Hz is gone. Bubbles and pressure. */
  underwater: {
    dur: 6, gain: 0.55, cut: 500,
    render: (o, sr, rnd) => {
      const span = o.length / sr;
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.5, cut0: 190, cut1: 230, tau: 1e6, res: 0.9, atk: 0.4 });
      grainLayer(o, sr, rnd, { dur: span - 0.5, count: 40, amp: 0.16, f0: 300, f1: 1400, tau: 0.02, kind: "ping", clump: 0 });
    },
  },

  /** The battle bus: turbine drone, rotor beat, hull rattle. */
  bus: {
    dur: 6, gain: 0.42, cut: 2200,
    render: (o, sr, rnd) => {
      const span = o.length / sr;
      // Snapped so the drone closes the loop exactly — an engine that clicks
      // once a loop is worse than no engine at all.
      toneLayer(o, sr, rnd, { dur: span, amp: 0.22, f0: loopSnap(58, span), f1: loopSnap(58, span), tau: 1e6, atk: 0.8, shape: "saw" });
      toneLayer(o, sr, rnd, { dur: span, amp: 0.12, f0: loopSnap(87, span), f1: loopSnap(87, span), tau: 1e6, atk: 1, shape: "saw" });
      toneLayer(o, sr, rnd, { dur: span, amp: 0.07, f0: loopSnap(29, span), f1: loopSnap(29, span), tau: 1e6, atk: 1.2 });
      noiseLayer(o, sr, rnd, { dur: span, amp: 0.3, cut0: 420, cut1: 520, tau: 1e6, res: 0.7, atk: 0.6 });
      // Rotor slap: a periodic amplitude notch across the whole bed.
      const beat = 11;
      let ph = 0;
      for (let i = 0; i < o.length; i++) {
        ph += (TWO_PI * beat) / sr;
        o[i] *= 0.78 + 0.22 * Math.sin(ph);
      }
      saturate(o, 1.3);
    },
  },
};

// ===========================================================================
// 6. Music
//
// One loop per track, split into five stems that are started together,
// sample-locked, and mixed in and out by a single `tension` scalar. Circle 1
// is a pad and a sparse arpeggio; circle 6 with twelve players left is all
// five stems including a driving bass and a kick, and the whole thing ducks
// under gunfire so it never argues with the information you need.
//
// Loops close cleanly because every sustained oscillator frequency is snapped
// with `loopSnap` and every percussive tail is short enough to die inside the
// bar. There is deliberately no fade at the loop boundary: a fade is a dip,
// and a dip once per bar is more obvious than a click.
// ===========================================================================

type StemName = "pad" | "sub" | "arp" | "bass" | "perc" | "hats" | "lead" | "swell";

interface MusicMeta {
  /** Seconds per beat and per bar. */
  beat: number;
  bar: number;
  /** Total loop length, seconds. */
  dur: number;
  bars: number;
  /** Root frequency of the tonic, in the bass octave. */
  root: number;
  /** Scale degrees in semitones from the root. */
  scale: number[];
}

/** One layer of a track: what it plays, and when it fades in. */
interface MusicStem {
  name: StemName;
  /** Tension at which this stem starts coming up. */
  enter: number;
  /** Tension at which it is at full level. */
  full: number;
  gain: number;
}

interface MusicTrack {
  bpm: number;
  bars: number;
  root: number;
  scale: number[];
  loop: boolean;
  stems: MusicStem[];
}

/** Natural minor. The whole soundtrack lives here — it is a survival game. */
const MINOR = [0, 2, 3, 5, 7, 8, 10];
/** …except the win screen. */
const MAJOR = [0, 2, 4, 5, 7, 9, 11];

const STEM_RENDER: Record<StemName, (o: Float32Array, sr: number, rnd: Rand, m: MusicMeta) => void> = {
  /**
   * Pad: a snapped saw stack an octave and a fifth wide, filtered dark. This
   * is the floor of the mix and it is present at every tension.
   */
  pad(o, sr, rnd, m) {
    const voices = [0, 7, 12, 15, 19];
    for (let i = 0; i < voices.length; i++) {
      const f = loopSnap(semi(m.root * 2, voices[i]), m.dur);
      // Two detuned copies per voice. The beating between them is the entire
      // difference between "pad" and "one sawtooth".
      toneLayer(o, sr, rnd, { dur: m.dur, amp: 0.1 / (1 + i * 0.35), f0: f, f1: f, tau: 1e6, atk: 0.6, shape: "saw" });
      const f2 = loopSnap(f * 1.004, m.dur);
      toneLayer(o, sr, rnd, {
        dur: m.dur, amp: 0.08 / (1 + i * 0.35), f0: f2, f1: f2, tau: 1e6, atk: 0.7, shape: "saw", phase: 1.7,
      });
    }
    // Slow filter movement, hand-rolled so it is periodic over the loop.
    const n = o.length;
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const cut = 420 + 520 * (0.5 - 0.5 * Math.cos(TWO_PI * u));
      const coef = 1 - Math.exp((-TWO_PI * cut) / sr);
      lp += (o[i] - lp) * coef;
      o[i] = lp;
    }
  },

  /** Sub: the tonic, one note per bar, felt more than heard. */
  sub(o, sr, rnd, m) {
    for (let b = 0; b < m.bars; b++) {
      const f = loopSnap(m.root, m.dur);
      toneLayer(o, sr, rnd, { t0: b * m.bar, dur: m.bar, amp: 0.5, f0: f, f1: f, tau: m.bar * 0.55, atk: 0.02 });
    }
  },

  /** Arp: eighth-note plucks walking the scale. Sparse, and the first thing
   *  a player consciously notices when the circle starts moving. */
  arp(o, sr, rnd, m) {
    const pattern = [0, 4, 2, 4, 7, 4, 2, 4];
    const step = m.beat * 0.5;
    const steps = Math.round(m.dur / step);
    for (let i = 0; i < steps; i++) {
      const deg = pattern[i % pattern.length];
      const oct = i % 16 >= 8 ? 12 : 0;
      const f = semi(m.root * 4, m.scale[deg % m.scale.length] + oct + Math.floor(deg / m.scale.length) * 12);
      ksPluck(o, sr, rnd, { t0: i * step, freq: f, amp: 0.32, dur: step * 2.2, damp: 0.55, bright: 0.5 });
    }
  },

  /** Bass: driving offbeat eighths on the root and fifth. Tension only. */
  bass(o, sr, rnd, m) {
    const step = m.beat * 0.5;
    const steps = Math.round(m.dur / step);
    const walk = [0, 0, 0, 3, 0, 0, 5, 3];
    for (let i = 0; i < steps; i++) {
      const deg = walk[i % walk.length];
      const f = semi(m.root, m.scale[deg % m.scale.length]);
      // Square, not saw: it keeps its identity under the kick where a saw
      // would just add mud.
      toneLayer(o, sr, rnd, {
        t0: i * step, dur: step * 0.95, amp: 0.34, f0: f, f1: f * 0.99,
        tau: step * 0.42, atk: 0.004, shape: "square",
      });
      toneLayer(o, sr, rnd, { t0: i * step, dur: step * 0.6, amp: 0.16, f0: f * 2, f1: f * 2, tau: step * 0.25, atk: 0.004 });
    }
    saturate(o, 1.5);
  },

  /** Kick + snare. The moment this enters, the match has become a fight. */
  perc(o, sr, rnd, m) {
    for (let b = 0; b < m.bars * 4; b++) {
      const t = b * m.beat;
      // Kick on 1 and 3, plus a pickup before the bar turns over.
      if (b % 4 === 0 || b % 4 === 2) {
        toneLayer(o, sr, rnd, { t0: t, dur: 0.3, amp: 0.85, f0: 128, f1: 42, tau: 0.075, atk: 0.0009 });
        noiseLayer(o, sr, rnd, { t0: t, dur: 0.02, amp: 0.28, cut0: 3200, cut1: 900, tau: 0.004, mode: "band", atk: 0.00006 });
      }
      // Snare on 2 and 4 — noise plus two detuned tones for the shell.
      if (b % 4 === 1 || b % 4 === 3) {
        noiseLayer(o, sr, rnd, { t0: t, dur: 0.24, amp: 0.5, cut0: 4200, cut1: 1200, tau: 0.055, res: 1.1, mode: "band", atk: 0.0004 });
        toneLayer(o, sr, rnd, { t0: t, dur: 0.12, amp: 0.24, f0: 205, f1: 180, tau: 0.03, atk: 0.0006 });
        toneLayer(o, sr, rnd, { t0: t, dur: 0.12, amp: 0.16, f0: 288, f1: 250, tau: 0.028, atk: 0.0006 });
      }
    }
    saturate(o, 1.4);
  },

  /** Sixteenth hats with an accent pattern, so it swings rather than machine-guns. */
  hats(o, sr, rnd, m) {
    const step = m.beat * 0.25;
    const steps = Math.round(m.dur / step);
    for (let i = 0; i < steps; i++) {
      const accent = i % 4 === 0 ? 1 : i % 2 === 0 ? 0.6 : 0.35;
      noiseLayer(o, sr, rnd, {
        t0: i * step, dur: 0.05, amp: 0.22 * accent, cut0: 9000, cut1: 6000,
        tau: 0.008 + (i % 8 === 4 ? 0.03 : 0), res: 1.2, mode: "high", atk: 0.00008,
      });
    }
  },

  /** Lead: a two-bar ostinato that only shows up in the last few circles. */
  lead(o, sr, rnd, m) {
    const fig = [7, 5, 4, 5, 7, 9, 7, 5];
    const step = m.beat * 0.5;
    for (let i = 0; i < Math.round(m.dur / step); i++) {
      const deg = fig[i % fig.length];
      const f = semi(m.root * 8, m.scale[deg % m.scale.length] + Math.floor(deg / m.scale.length) * 12);
      toneLayer(o, sr, rnd, {
        t0: i * step, dur: step * 1.6, amp: 0.16, f0: f, f1: f, tau: step * 0.5, atk: 0.01, shape: "tri",
      });
      // Fifth above, quieter — a bare single line sounds thin next to the bass.
      toneLayer(o, sr, rnd, {
        t0: i * step, dur: step * 1.4, amp: 0.07, f0: f * 1.4983, f1: f * 1.4983, tau: step * 0.4, atk: 0.014, shape: "tri",
      });
    }
  },

  /** A noise swell that crests on the downbeat. Momentum, not melody. */
  swell(o, sr, rnd, m) {
    for (let b = 0; b < m.bars; b++) {
      noiseLayer(o, sr, rnd, {
        t0: b * m.bar, dur: m.bar * 0.98, amp: 0.28, cut0: 400, cut1: 5200,
        tau: m.bar * 0.6, res: 1.2, mode: "band", atk: m.bar * 0.4,
      });
    }
  },
};

/**
 * The four beds. `victory` and `defeat` are non-looping stings that the match
 * system fires once; everything else runs until the phase changes.
 *
 * Tension thresholds are the whole design: `drop-in` never gets percussion no
 * matter what, because the bus is not tense; `combat` gets everything by
 * circle five. The player should be able to tell how far into the match they
 * are with their eyes shut.
 */
const MUSIC: Record<string, MusicTrack> = {
  "drop-in": {
    bpm: 84, bars: 4, root: 55, scale: MINOR, loop: true,
    stems: [
      { name: "pad", enter: 0, full: 0.2, gain: 0.9 },
      { name: "sub", enter: 0.05, full: 0.4, gain: 0.7 },
      { name: "arp", enter: 0.15, full: 0.55, gain: 0.55 },
      { name: "hats", enter: 0.55, full: 0.9, gain: 0.3 },
    ],
  },
  drop: {
    bpm: 124, bars: 2, root: 55, scale: MINOR, loop: true,
    stems: [
      { name: "pad", enter: 0, full: 0.15, gain: 0.75 },
      { name: "swell", enter: 0, full: 0.3, gain: 0.6 },
      { name: "sub", enter: 0.1, full: 0.35, gain: 0.7 },
      { name: "arp", enter: 0.1, full: 0.4, gain: 0.6 },
      { name: "hats", enter: 0.3, full: 0.6, gain: 0.4 },
      { name: "perc", enter: 0.45, full: 0.8, gain: 0.5 },
    ],
  },
  combat: {
    bpm: 138, bars: 2, root: 58.27, scale: MINOR, loop: true,
    stems: [
      { name: "pad", enter: 0, full: 0.1, gain: 0.7 },
      { name: "sub", enter: 0, full: 0.2, gain: 0.75 },
      { name: "arp", enter: 0.12, full: 0.4, gain: 0.5 },
      { name: "hats", enter: 0.25, full: 0.5, gain: 0.38 },
      { name: "perc", enter: 0.35, full: 0.6, gain: 0.6 },
      { name: "bass", enter: 0.45, full: 0.72, gain: 0.6 },
      { name: "lead", enter: 0.72, full: 0.95, gain: 0.5 },
    ],
  },
  victory: {
    bpm: 96, bars: 2, root: 65.41, scale: MAJOR, loop: false,
    stems: [
      { name: "pad", enter: 0, full: 0, gain: 1 },
      { name: "sub", enter: 0, full: 0, gain: 0.8 },
      { name: "lead", enter: 0, full: 0, gain: 0.7 },
      { name: "swell", enter: 0, full: 0, gain: 0.5 },
    ],
  },
  defeat: {
    bpm: 72, bars: 2, root: 49, scale: MINOR, loop: false,
    stems: [
      { name: "pad", enter: 0, full: 0, gain: 1 },
      { name: "sub", enter: 0, full: 0, gain: 0.9 },
    ],
  },
};

/** Music names other systems might reasonably use. */
const MUSIC_ALIASES: Record<string, string> = {
  lobby: "drop-in", bus: "drop-in", warmup: "drop-in", menu: "drop-in",
  dropping: "drop", deploy: "drop", skydive: "drop",
  live: "combat", fight: "combat", endgame: "combat", tension: "combat",
  win: "victory", "victory-royale": "victory",
  lose: "defeat", eliminated: "defeat", death: "defeat",
};

// ===========================================================================
// 7. The service
// ===========================================================================

/**
 * What we actually publish. `AudioService` is the narrow contract every other
 * system codes against; the extras below exist for the HUD, the pause menu
 * and the combat system's blast handling. Nothing in `types.ts` needed to
 * change to accommodate them — a caller holding the narrow type simply
 * cannot see them.
 */
export interface DropZeroAudioService extends AudioService {
  /** 0..1 master volume. */
  setVolume(v: number): void;
  getVolume(): number;
  setMuted(m: boolean): void;
  isMuted(): boolean;
  /** Momentarily muffle the world. 1 = a grenade in your lap. */
  concussion(strength: number): void;
  /** Current music tension, 0..1 — the HUD debug overlay reads this. */
  readonly tension: number;
}

/** A live one-shot. The wrapper is pooled; the nodes are not (they can't be). */
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

/** One ambience bed's live state. */
interface BedVoice {
  src: AudioBufferSourceNode | null;
  filt: BiquadFilterNode | null;
  gain: GainNode | null;
  /** Director target, before overrides. */
  target: number;
  current: number;
  cutTarget: number;
  cutCurrent: number;
  started: boolean;
}

/** One music stem's live state. */
interface StemVoice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  stem: MusicStem;
}

const createAudio: SystemFactory = (ctx) => {
  const quality = ctx.quality;
  /**
   * The seam, read once: the mode cannot change inside a match, and this is
   * consulted from the bed director at 8 Hz. It only ever chooses *which*
   * sound to make — every cue in the bank stays available in both modes, so a
   * caller that asks for a soaker in classic still gets one.
   */
  const waterMode = ctx.mode === "water";
  // A private deterministic stream, seeded once off the world RNG so that
  // runtime audio jitter can never perturb worldgen's draw order.
  const rng = makeRng(((ctx.rng() * 0xffffffff) >>> 0) ^ 0x5f356495);

  // ------------------------------------------------------------------ state
  let actx: AudioContext | null = null;
  let master: GainNode | null = null;
  let limiter: DynamicsCompressorNode | null = null;
  let worldDuck: GainNode | null = null;
  let muffle: BiquadFilterNode | null = null;
  let sfxBus: GainNode | null = null;
  let ambBus: GainNode | null = null;
  let ambDuck: GainNode | null = null;
  let uiBus: GainNode | null = null;
  let musicBus: GainNode | null = null;
  let musicDuck: GainNode | null = null;
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
  /** Set when the browser has no usable AudioContext at all. Then we no-op. */
  let broken = false;

  let concussionAmt = 0;
  let worldDuckAmt = 0;
  /** Recent gunfire, 0..1. Drives the music duck and part of the tension. */
  let heat = 0;
  let tension = 0.1;

  const AC: typeof AudioContext | undefined =
    typeof window !== "undefined"
      ? window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;

  // ---------------------------------------------------------------- service
  // Published before anything expensive happens — and before the context
  // exists at all, since we must not create one until a gesture. Every method
  // below is a hoisted function declaration, so this is safe here.
  const service: DropZeroAudioService = {
    play,
    ambience,
    music,
    setListener(camera: THREE.Camera) {
      listenerCam = camera ?? ctx.camera;
    },
    resume,
    setVolume,
    getVolume: () => volume,
    setMuted,
    isMuted: () => muted,
    concussion: applyConcussion,
    get ready() {
      return ready;
    },
    get tension() {
      return tension;
    },
  };
  ctx.services.audio = service;

  // =========================================================================
  // 7a. Graph
  // =========================================================================

  /**
   * Build the context and the whole bus topology. Only ever called from
   * `resume()`, i.e. from a real user gesture — constructing an AudioContext
   * before one gets the page a console warning on every browser and a
   * permanently-suspended context on some.
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

    // The limiter. Non-negotiable: twenty transients landing on one sample
    // during a five-way build fight will clip the output stage into a
    // buzzsaw without it, and clipping is the one artefact a player will
    // describe as "the game is broken" rather than "the mix is loud".
    limiter = a.createDynamicsCompressor();
    limiter.threshold.value = -7;
    limiter.knee.value = 6;
    limiter.ratio.value = 9;
    // 4 ms is slow enough to let a gunshot's initial crack through intact and
    // fast enough to catch the body behind it.
    limiter.attack.value = 0.004;
    limiter.release.value = 0.22;
    master.connect(limiter);
    limiter.connect(a.destination);

    worldDuck = a.createGain();
    worldDuck.gain.value = 1;
    worldDuck.connect(master);

    // One shared lowpass carries the post-blast muffle, the underwater filter
    // and the indoor damping — they are the same physical idea, so one node.
    muffle = a.createBiquadFilter();
    muffle.type = "lowpass";
    muffle.frequency.value = 21000;
    muffle.Q.value = 0.55;
    muffle.connect(worldDuck);

    sfxBus = a.createGain();
    sfxBus.gain.value = 1;
    sfxBus.connect(muffle);

    ambBus = a.createGain();
    ambBus.gain.value = 1;
    ambDuck = a.createGain();
    ambDuck.gain.value = 1;
    ambBus.connect(ambDuck);
    ambDuck.connect(muffle);

    musicBus = a.createGain();
    musicBus.gain.value = 0;
    musicDuck = a.createGain();
    musicDuck.gain.value = 1;
    musicBus.connect(musicDuck);
    // Music bypasses the world muffle. A soundtrack that goes underwater with
    // the player sounds like a bug, not like immersion.
    musicDuck.connect(master);

    // UI bypasses everything world-shaped so a hitmarker stays legible
    // through the blast that has just muffled the rest of the mix.
    uiBus = a.createGain();
    uiBus.gain.value = 1;
    uiBus.connect(master);

    // Reverb: two generated impulse responses, crossfaded by environment.
    revIn = a.createGain();
    revIn.gain.value = 1;
    revOut = a.createGain();
    revOut.gain.value = 0.9;
    revOut.connect(muffle);

    const [tightLen, wideLen] = IR_LEN[quality];
    convTight = a.createConvolver();
    convTight.normalize = true;
    convTight.buffer = renderIR(a, tightLen, 0.011, 3200, 0.9);
    tightGain = a.createGain();
    tightGain.gain.value = 0.6;
    revIn.connect(tightGain);
    tightGain.connect(convTight);
    convTight.connect(revOut);

    if (wideLen > 0) {
      convWide = a.createConvolver();
      convWide.normalize = true;
      convWide.buffer = renderIR(a, wideLen, 0.05, 1400, 0.35);
      wideGain = a.createGain();
      wideGain.gain.value = 0.4;
      revIn.connect(wideGain);
      wideGain.connect(convWide);
      convWide.connect(revOut);
    }

    // Ear ring. Silent until something detonates next to your head.
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
   * Impulse response generator. Discrete early reflections — which are what
   * actually tell the ear the size of the room — laid over an exponentially
   * decaying, band-limited noise tail, with the two channels decorrelated for
   * width. Rendered at the context rate because ConvolverNode rejects any
   * buffer that isn't, so there is no cheaper option here.
   */
  function renderIR(a: AudioContext, seconds: number, preDelay: number, tone: number, density: number): AudioBuffer {
    const sr = a.sampleRate;
    const n = Math.max(64, Math.ceil(seconds * sr));
    const buf = a.createBuffer(2, n, sr);
    const irRng = makeRng(0x2c1a77 ^ Math.round(seconds * 1000));
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      const pd = Math.round(preDelay * sr * (1 + c * 0.13));
      const coef = 1 - Math.exp((-TWO_PI * tone) / sr);
      let lp = 0;
      for (let i = pd; i < n; i++) {
        const t = (i - pd) / sr;
        const x = irRng() * 2 - 1;
        lp += (x - lp) * coef;
        // Density ramp: a real tail thickens before it thins.
        const build = Math.min(1, t / (seconds * 0.08));
        d[i] = lp * Math.exp((-6.9 * t) / seconds) * build * density;
      }
      for (let k = 0; k < 9; k++) {
        const t = pd + Math.round((0.004 + irRng() * seconds * 0.16) * sr);
        if (t >= n) continue;
        d[t] += (irRng() * 2 - 1) * 0.75 * Math.exp(-k * 0.28);
      }
      normalise(d, 0.85);
    }
    return buf;
  }

  // =========================================================================
  // 7b. Gesture unlock
  // =========================================================================

  function resume(): void {
    if (broken) return;
    if (!actx) buildGraph();
    if (!actx) return;
    if (actx.state === "running") {
      if (!ready) {
        ready = true;
        ctx.emit("dz:audio", { ready, muted, volume });
      }
      return;
    }
    actx.resume().then(
      () => {
        ready = actx?.state === "running";
        ctx.emit("dz:audio", { ready, muted, volume });
      },
      () => {
        /* still gated; the next gesture tries again */
      },
    );
  }

  const unlock = (): void => resume();
  const onVisibility = (): void => {
    if (!actx || broken) return;
    // A backgrounded tab must not burn a core on two convolvers and ten
    // looping beds nobody can hear.
    if (document.hidden) actx.suspend().catch(() => {});
    else if (ready) actx.resume().catch(() => {});
  };

  const GESTURES: string[] = ["pointerdown", "mousedown", "keydown", "touchstart", "click"];
  if (typeof window !== "undefined") {
    for (const ev of GESTURES) window.addEventListener(ev, unlock, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
  }

  // =========================================================================
  // 7c. The bank — render on demand, prebuild in the background
  // =========================================================================
  const bank = new Map<string, AudioBuffer[]>();
  const bedBuffers = new Map<string, AudioBuffer>();
  const musicBuffers = new Map<string, AudioBuffer>();

  /** FNV-1a. Seeds a cue's variants stably off its own name. */
  function hashKey(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function buildCue(key: string, indoor: boolean): AudioBuffer[] | null {
    const cue = CUES[key];
    if (!cue || !actx) return null;
    const wantIndoor = indoor && cue.env === true;
    const bankKey = wantIndoor ? `${key}#i` : key;
    const cached = bank.get(bankKey);
    if (cached) return cached;
    const a = actx;
    // Low tier renders at 24 kHz: the top octave of a gunshot is the first
    // thing air absorption eats anyway, so it costs almost nothing audible.
    const sr = cue.sr ?? (quality === "low" ? 24000 : a.sampleRate);
    // Variants are a repetition fix, and repetition is only a problem for
    // things you hear often. A three-second stereo sting plays once a match:
    // rendering three of it costs 40 ms of a frame to solve nothing.
    const wanted = cue.variants ?? (cue.stereo ? 1 : cue.dur > 1.4 ? 2 : 3);
    const count = Math.max(1, Math.min(wanted, VARIANTS[quality]));
    const frames = Math.max(16, Math.ceil(cue.dur * sr));
    const out: AudioBuffer[] = [];
    for (let v = 0; v < count; v++) {
      let buf: AudioBuffer;
      try {
        buf = a.createBuffer(cue.stereo ? 2 : 1, frames, sr);
      } catch {
        break;
      }
      const seed = hashKey(bankKey) ^ (v * 0x9e3779b1);
      const ch = buf.getChannelData(0);
      cue.render(ch, sr, makeRng(seed), wantIndoor);
      normalise(ch, cue.peak ?? 0.9);
      if (cue.stereo) {
        // Second channel from an independent seed. Natural width, no widener.
        const r = buf.getChannelData(1);
        cue.render(r, sr, makeRng(seed + 0x5bf03635), wantIndoor);
        normalise(r, cue.peak ?? 0.9);
      }
      out.push(buf);
    }
    if (out.length === 0) return null;
    bank.set(bankKey, out);
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
      // Wrap the overhang back into the head so the loop point vanishes.
      // Beds are noise-dominated, so a 600 ms crossfade is inaudible; music
      // could not get away with this, which is why it uses `loopSnap`.
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

  function buildStem(trackName: string, track: MusicTrack, stem: MusicStem): AudioBuffer | null {
    const key = `${trackName}:${stem.name}`;
    const cached = musicBuffers.get(key);
    if (cached) return cached;
    if (!actx) return null;
    const a = actx;
    const sr = MUSIC_RATE[quality];
    const beat = 60 / track.bpm;
    const bar = beat * 4;
    const dur = bar * track.bars;
    const meta: MusicMeta = { beat, bar, dur, bars: track.bars, root: track.root, scale: track.scale };
    const n = Math.ceil(dur * sr);
    let buf: AudioBuffer;
    try {
      buf = a.createBuffer(1, n, sr);
    } catch {
      return null;
    }
    const ch = buf.getChannelData(0);
    STEM_RENDER[stem.name](ch, sr, makeRng(hashKey(key)), meta);
    normalise(ch, 0.82);
    // Non-looping stings get a tail fade; loops must not have one.
    if (!track.loop) fadeOut(ch, sr, 220);
    musicBuffers.set(key, buf);
    return buf;
  }

  /**
   * Prebuild order: what a player hears in the first thirty seconds, first.
   * Everything else renders on its first trigger, which costs a few ms once.
   */
  const prebuild: string[] = [
    "shot-ar", "impact-concrete", "step-grass", "step-dirt", "hitmarker", "land", "jump",
    "build-place", "build-hit", "pickaxe-hit", "pickaxe-swing", "item-pickup", "chest-open",
    "@bed:wind", "@bed:surf",
    "shot-smg", "shot-pump", "shot-pistol", "shot-sniper", "explosion", "impact-metal",
    "impact-dirt", "impact-wood", "impact-flesh", "hurt", "shell-drop", "mag-out", "mag-in",
    "bolt-back", "bolt-forward", "pump-action", "whizz", "hit-flesh", "hit-shield", "headshot",
    "@bed:birds", "@bed:forest", "@bed:insects",
    "build-break", "build-deny", "harvest-wood", "harvest-stone", "harvest-metal", "harvest-crit",
    "step-concrete", "step-metal", "step-wood", "step-sand", "step-water", "glider-deploy",
    "glider-flap", "dive-out", "splash-in", "splash-out", "loot-pickup", "chest-hum",
    "@bed:night", "@bed:urban", "@bed:storm", "@bed:underwater", "@bed:bus",
    "shot-tac", "shot-burst", "shot-minigun", "shot-rocket", "impact-glass", "impact-water",
    "impact-grass", "impact-sand", "break-wood", "break-stone", "break-metal", "build-place-wood",
    "build-place-stone", "build-place-metal", "consume-shield-start", "consume-shield",
    "consume-health-start", "consume-health", "elim-confirm", "eliminated", "victory",
    "storm-warn", "storm-close", "storm-enter", "storm-exit", "bus-horn", "bus-release",
    "bird", "gull", "distant-fire", "generic",
    // Indoor renders of the cues most likely to first fire inside a POI —
    // otherwise the first shot in a house pays for its own room.
    "@in:shot-ar", "@in:shot-pump", "@in:shot-smg", "@in:impact-concrete",
    "@in:impact-metal", "@in:step-concrete", "@in:shot-pistol", "@in:shot-sniper",
  ];
  if (waterMode) {
    // Water mode hears its own arsenal in the first thirty seconds and never
    // hears a firearm, so the soakers go to the FRONT of the queue rather than
    // the back. The classic list below them still renders — a few hundred
    // milliseconds of idle work over the bus ride, and it keeps one queue.
    prebuild.unshift(
      "soak-ar", "soak-pistol", "soak-smg", "soak-pump", "soak-tac",
      "balloon-burst", "balloon-throw", "soak-burst", "squelch", "skid",
      "pump-refill", "harvest-foam", "harvest-plank", "harvest-tarp",
      "@bed:downpour", "soak-out", "soak-lance", "soak-hose", "soak-lob",
      "glue-fire", "glue-stick", "glue-snap", "glue-stumble",
      "downpour-warn", "downpour-enter", "downpour-close", "downpour-exit",
      "towel-rub", "towel-rub-start", "poncho-on", "poncho-on-start",
      "hair-dryer", "hair-dryer-start", "dunk-start", "balloon-load",
      "glue-load", "lance-charge", "hose-spool",
      "@in:soak-ar", "@in:soak-pump", "@in:balloon-burst",
    );
  }
  let prebuildAt = 0;
  /** Milliseconds we owe the frame budget after an item overran it. */
  let prebuildDebt = 0;

  /**
   * Drain the prebuild queue under a wall-clock budget. The budget can only
   * be checked *between* items — a single cue is not interruptible — so an
   * expensive one (a three-second stereo sting is ~30 ms) is paid back by
   * sitting the next several frames out. Without the debt the queue would
   * hitch once per frame instead of averaging out to the budget.
   */
  function pumpPrebuild(budgetMs: number): void {
    if (!actx || prebuildAt >= prebuild.length) return;
    if (prebuildDebt > 0) {
      prebuildDebt = Math.max(0, prebuildDebt - budgetMs);
      return;
    }
    const t0 = performance.now();
    while (prebuildAt < prebuild.length) {
      const key = prebuild[prebuildAt++];
      try {
        if (key.startsWith("@bed:")) buildBed(key.slice(5));
        else if (key.startsWith("@in:")) buildCue(key.slice(4), true);
        else buildCue(key, false);
      } catch {
        /* one bad recipe must not stall the queue */
      }
      if (performance.now() - t0 >= budgetMs) break;
    }
    prebuildDebt = Math.max(0, performance.now() - t0 - budgetMs);
  }

  // =========================================================================
  // 7d. Voices
  // =========================================================================
  const voices: Voice[] = [];
  const pool: Voice[] = [];
  const lastPlay = new Map<string, number>();
  const sameCount = new Map<string, number>();
  const cap = VOICE_CAP[quality];
  // HRTF is meaningfully more expensive per voice; below "high" the
  // equal-power panner is the right trade, since those machines need the CPU
  // for the frame more than they need elevation cues.
  const hrtf = quality === "high" || quality === "ultra";

  function takeVoice(): Voice {
    const v = pool.pop();
    if (v) return v;
    return {
      src: null, gain: null, pan: null, filt: null, send: null,
      key: "", level: 0, prio: 0, endsAt: 0, active: false,
    };
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
    if (pool.length < 96) pool.push(v);
  }

  /**
   * Steal the least valuable voice when we are at the cap, where "value" is
   * audible level weighted by priority — so a distant footstep loses to a
   * near shotgun, but a hitmarker never loses to anything.
   */
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

  // =========================================================================
  // 7e. Listener + environment state
  // =========================================================================
  const listenerPos = new THREE.Vector3();
  const listenerFwd = new THREE.Vector3(0, 0, -1);
  const listenerUp = new THREE.Vector3(0, 1, 0);
  const tmpDir = new THREE.Vector3();
  const tmpVec = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const evtPos = new THREE.Vector3();

  /** Everything the ambience director samples. All 0..1 unless noted. */
  const env = {
    /** Metres to the nearest water, or 999 when nothing was found. */
    shore: 999,
    /** Metres above the ground directly below. */
    altitude: 0,
    urban: 0,
    forest: 0,
    open: 1,
    night: 0,
    indoor: 0,
    submerged: 0,
    /** Metres from the storm wall; negative means inside the safe zone. */
    stormDist: 9999,
    inStorm: 0,
    /** Target reverb wetness and its tight/wide balance. */
    wet: 0.17,
    tight: 0.4,
  };

  function setParam(p: AudioParam | undefined | null, value: number, smooth: number): void {
    if (!p || !actx) return;
    if (smooth <= 0) p.value = value;
    else p.setTargetAtTime(value, actx.currentTime, smooth);
  }

  /**
   * Air absorption. High frequencies die with distance far faster than lows.
   * This single curve is what makes a rifle 400 m away read as *far* rather
   * than merely *quiet*, and it is the cheapest realism in the whole module.
   */
  function airCutoff(dist: number, scale: number): number {
    if (scale <= 0) return 21000;
    return Math.max(260, 20000 * Math.pow(0.5, (dist * scale) / 60));
  }

  /** Inverse-distance-ish rolloff with a taper so nothing ever cuts out. */
  function distanceGain(dist: number, ref: number, roll: number, max: number): number {
    if (dist <= ref) return 1;
    if (dist >= max) return 0;
    const g = ref / (ref + roll * (dist - ref));
    const edge = Math.min(1, (max - dist) / (max * 0.35));
    return g * edge * edge;
  }

  let occlusionBudget = OCCLUSION_BUDGET;

  // =========================================================================
  // 7f. play()
  // =========================================================================

  /**
   * Fire a one-shot. Everything cheap and disqualifying happens before a
   * single node is allocated — retrigger gap, distance cull, level estimate,
   * concurrency limit, voice stealing — because the expensive part of a web
   * audio one-shot is the graph, not the buffer.
   */
  function play(name: string, opts?: AudioOpts): void {
    if (!ready || !actx || broken || muted) return;
    const a = actx;
    let key = resolveCue(name);

    // Placement takes the material the player is actually building with; it
    // is the only per-material information the build system does not pass.
    if (key === "build-place" && buildMaterial) {
      const variant = `build-place-${buildMaterial}`;
      if (CUES[variant]) key = variant;
    }

    const cue = CUES[key];
    if (!cue) return;

    const now = a.currentTime;
    const gap = cue.gap ?? 0.01;
    const last = lastPlay.get(key) ?? -99;
    if (now - last < gap) return;

    const pos = opts?.position;
    const maxD = opts?.maxDistance ?? cue.max ?? 400;
    let dist = 0;
    if (pos) {
      dist = listenerPos.distanceTo(pos);
      if (dist > maxD) return;
    }

    const baseVol = (opts?.volume ?? 1) * (cue.gain ?? 1);
    let level = baseVol;
    if (pos) level *= distanceGain(dist, cue.ref ?? 9, cue.roll ?? 1, maxD);
    if (level < 0.004) return;

    const prio = cue.prio ?? 0.5;
    const running = sameCount.get(key) ?? 0;
    if (running >= (cue.same ?? 2) && prio < 0.9) return;
    if (!makeRoom(level, prio)) return;

    const indoor = env.indoor > 0.5;
    const bufs = buildCue(key, indoor);
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

    // Air absorption and occlusion are the same node: one lowpass, whichever
    // influence is darker wins.
    let cutoff = 21000;
    if (pos && dist > 4) {
      cutoff = airCutoff(dist, cue.air ?? 1);
      const col = ctx.services.collision;
      if (occlusionBudget > 0 && dist > 12 && col) {
        occlusionBudget--;
        tmpDir.subVectors(pos, listenerPos);
        const len = tmpDir.length();
        if (len > 0.001) {
          tmpDir.divideScalar(len);
          const hit = col.raycast(listenerPos, tmpDir, len - 1.5);
          if (hit) {
            // Something solid in the way: much darker and a little quieter,
            // never silent — a wall is not a mute button, and a player
            // shooting through your build must still be locatable.
            cutoff = Math.min(cutoff, 850);
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
      // Our own curve already handled distance; the panner only does
      // direction. Letting it also roll off would double-attenuate.
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
      if (sfxBus) tail.connect(sfxBus);
      if (revIn) {
        // Farther is wetter. That ratio is the other half of distance
        // perception — level alone reads as a volume slider, not as space.
        const send = a.createGain();
        const distWet = pos ? 1 + Math.min(1.4, dist / 150) : 1;
        send.gain.value = Math.min(1.6, level * env.wet * (cue.wet ?? 1) * distWet);
        tail.connect(send);
        send.connect(revIn);
        v.send = send;
      }
    }

    // Speed of sound. One line, and it does more for the sense of scale of a
    // 3 km island than any amount of reverb could.
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

    // Gunfire heat: drives the music duck and part of the tension curve.
    if (cue.duck) {
      const near = pos ? 1 - Math.min(1, dist / 90) : 1;
      heat = Math.min(1, heat + cue.duck * (0.25 + near * 0.75) * 0.5);
    }

    // A blast in your lap muffles the world and rings your ears.
    if (key === "explosion" && (!pos || dist < 55)) {
      const near = pos ? 1 - Math.min(1, dist / 55) : 1;
      applyConcussion(near * near * (opts?.volume ?? 1));
    }
  }

  function setPannerPos(pan: PannerNode, p: THREE.Vector3): void {
    const px = pan.positionX as AudioParam | undefined;
    if (px) {
      px.value = p.x;
      pan.positionY.value = p.y;
      pan.positionZ.value = p.z;
    } else {
      // Deprecated path; still the only one on older Safari.
      (pan as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(p.x, p.y, p.z);
    }
  }

  function applyConcussion(strength: number): void {
    concussionAmt = Math.min(1, concussionAmt + strength * 0.9);
    worldDuckAmt = Math.max(worldDuckAmt, Math.min(0.75, strength * 0.8));
  }

  function setVolume(v: number): void {
    volume = Math.max(0, Math.min(1, v));
    setParam(master?.gain, muted ? 0 : volume, 0.03);
    ctx.emit("dz:audio", { ready, muted, volume });
  }

  function setMuted(m: boolean): void {
    muted = m;
    setParam(master?.gain, muted ? 0 : volume, 0.03);
    ctx.emit("dz:audio", { ready, muted, volume });
  }

  // =========================================================================
  // 7g. Ambience beds
  // =========================================================================
  const bedVoices = new Map<string, BedVoice>();
  /** Explicit `ambience()` requests, by bed name. */
  const bedRequest = new Map<string, number>();

  function bedVoice(key: string): BedVoice {
    let b = bedVoices.get(key);
    if (!b) {
      const cut = BEDS[key]?.cut ?? 8000;
      b = { src: null, filt: null, gain: null, target: 0, current: 0, cutTarget: cut, cutCurrent: cut, started: false };
      bedVoices.set(key, b);
    }
    return b;
  }

  /** Start a bed lazily. A loop nobody can hear should not cost three nodes. */
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
      // Detune slightly so two beds of the same family never phase-lock.
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
      src.start(a.currentTime + rng() * 0.25);
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
      const req = bedRequest.get(key);
      // An explicit request is a *floor*, never a ceiling: the director knows
      // whether wind should be blowing where the player is standing, and a
      // caller that stops asking for wind (the player system does this the
      // instant a glide ends) should fall back to it rather than to silence.
      const target = req !== undefined ? Math.max(b.target, req) : b.target;
      // ~1.1 s to cross a full fade. Slow enough to be invisible, fast enough
      // that ducking into a building actually changes what you hear.
      b.current += (target - b.current) * Math.min(1, dt * 0.9);
      if (b.current > 0.002 && !b.started) startBed(key);
      if (!b.started) continue;
      setParam(b.gain?.gain, b.current, 0.15);
      if (b.filt && Math.abs(b.cutTarget - b.cutCurrent) > b.cutCurrent * 0.04) {
        b.cutCurrent += (b.cutTarget - b.cutCurrent) * Math.min(1, dt * 1.2);
        setParam(b.filt.frequency, b.cutCurrent, 0.2);
      }
    }
  }

  /** Map the loose names callers use onto the beds we actually have. */
  function bedName(name: string): string | null {
    if (BEDS[name]) return name;
    switch (name.toLowerCase()) {
      case "ocean": case "sea": case "waves": case "shore": return "surf";
      case "trees": case "leaves": case "woods": case "jungle": return "forest";
      case "day": case "cicadas": return "insects";
      case "crickets": case "evening": return "night";
      case "city": case "interior": case "poi": return "urban";
      case "birdsong": return "birds";
      case "engine": case "aircraft": return "bus";
      case "water": case "submerged": return "underwater";
      case "air": case "gust": return "wind";
      // `WATER.downpour.ambience` is "downpour-loop"; match.ts passes it
      // straight through, and before this line it fell out as null.
      case "downpour-loop": case "downpour": case "rain": return "downpour";
      default: return null;
    }
  }

  /**
   * `AudioService.ambience`. `on` with a volume raises a floor under the
   * director's own target; `on: false` withdraws the request and hands the
   * bed back to the director. `"all"`/`"auto"` clears every request.
   */
  function ambience(name: string, on: boolean, vol?: number): void {
    if (name === "all" || name === "*" || name === "auto") {
      bedRequest.clear();
      return;
    }
    const key = bedName(name);
    if (!key) return;
    if (!on) {
      bedRequest.delete(key);
      return;
    }
    bedRequest.set(key, (vol ?? 1) * BEDS[key].gain);
    if (ready) startBed(key);
  }

  // =========================================================================
  // 7h. Music
  // =========================================================================
  let musicName: string | null = null;
  let musicVol = 0.6;
  let musicStems: StemVoice[] = [];
  /** Set while the outgoing track is fading; blocks a second start. */
  let musicFadeOut = 0;
  /** Every pending timer, so dispose can cancel them rather than leak them. */
  const timerIds = new Set<number>();

  function later(fn: () => void, ms: number): void {
    const id = window.setTimeout(() => {
      timerIds.delete(id);
      fn();
    }, ms);
    timerIds.add(id);
  }

  function stopMusic(fade: number): void {
    if (!actx) return;
    const a = actx;
    const stems = musicStems;
    musicStems = [];
    musicName = null;
    for (const s of stems) {
      setParam(s.gain.gain, 0, fade * 0.35);
      const when = a.currentTime + fade;
      try {
        s.src.stop(when);
      } catch {
        /* already stopped */
      }
      // Disconnect a beat after the stop so the fade actually gets to run.
      later(() => {
        try {
          s.src.disconnect();
          s.gain.disconnect();
        } catch {
          /* gone */
        }
      }, (fade + 0.25) * 1000);
    }
  }

  /**
   * `AudioService.music`. Starting a track renders every stem, then starts
   * them all at one shared context time — they must be sample-locked or the
   * kick drifts off the bass inside a minute.
   */
  function music(name: string | null, vol?: number): void {
    if (vol !== undefined) musicVol = Math.max(0, Math.min(1, vol));
    if (!name) {
      stopMusic(1.4);
      return;
    }
    const key = MUSIC[name] ? name : MUSIC_ALIASES[name] ?? null;
    if (!key || !MUSIC[key]) return;
    if (key === musicName) return;
    if (!ready || !actx || !musicBus) {
      // Remember the intent; the update loop starts it once audio unlocks.
      pendingMusic = key;
      return;
    }
    pendingMusic = null;
    stopMusic(0.9);
    const track = MUSIC[key];
    const a = actx;
    const built: StemVoice[] = [];
    // 120 ms of headroom: enough for every source to be scheduled before the
    // first one is due, so they start on the same sample.
    const when = a.currentTime + 0.12;
    for (const stem of track.stems) {
      const buf = buildStem(key, track, stem);
      if (!buf) continue;
      try {
        const src = a.createBufferSource();
        src.buffer = buf;
        src.loop = track.loop;
        const gain = a.createGain();
        gain.gain.value = 0;
        src.connect(gain);
        gain.connect(musicBus);
        src.start(when);
        built.push({ src, gain, stem });
      } catch {
        /* out of nodes; this stem simply never plays */
      }
    }
    if (built.length === 0) return;
    musicStems = built;
    musicName = key;
    musicFadeOut = 0;
    // Stings play at their written balance regardless of tension.
    if (!track.loop) {
      for (const s of built) setParam(s.gain.gain, s.stem.gain, 0.05);
      // Clear the slot once the sting is over so the next track can start.
      const dur = (60 / track.bpm) * 4 * track.bars + 0.4;
      later(() => {
        if (musicName === key) {
          musicStems = [];
          musicName = null;
        }
      }, dur * 1000);
    }
  }

  let pendingMusic: string | null = null;

  /**
   * Tension: circle number is the spine of it, players-alive bends it, and
   * recent gunfire near you spikes it. A player should be able to guess how
   * deep into the match they are with their eyes shut.
   */
  let lobbyMax = 0;
  function computeTension(dt: number): void {
    const storm = ctx.services.storm;
    const match = ctx.services.match;
    let want = 0.08;
    if (storm) {
      want = Math.max(want, clamp01((storm.circle - 1) / 7) * 0.72 + (storm.closing ? 0.1 : 0));
      // Being caught outside the wall is the most tense state in the game.
      if (!storm.isSafe(listenerPos)) want = Math.max(want, 0.85);
    }
    if (match) {
      if (match.alive > lobbyMax) lobbyMax = match.alive;
      if (lobbyMax > 2) {
        want = Math.max(want, (1 - clamp01((match.alive - 1) / (lobbyMax - 1))) * 0.8);
      }
      if (match.phase === "warmup" || match.phase === "bus") want = Math.min(want, 0.25);
    }
    want = clamp01(want + heat * 0.3);
    // Tension rises fast and falls slowly: dropping the music the instant a
    // fight ends is far more noticeable than letting it ride down.
    const rate = want > tension ? 1.6 : 0.28;
    tension += (want - tension) * Math.min(1, dt * rate);
  }

  function mixMusic(dt: number): void {
    if (!actx || musicStems.length === 0) return;
    const track = musicName ? MUSIC[musicName] : null;
    if (!track) return;
    for (const s of musicStems) {
      const span = Math.max(0.001, s.stem.full - s.stem.enter);
      const w = track.loop ? clamp01((tension - s.stem.enter) / span) : 1;
      // Equal-power-ish curve: a linear stem fade sounds like it dips in the
      // middle when several stems cross at once.
      setParam(s.gain.gain, Math.sin(w * Math.PI * 0.5) * s.stem.gain * musicVol, 0.35);
    }
    musicFadeOut = Math.max(0, musicFadeOut - dt);
  }

  // =========================================================================
  // 7i. The chest hum
  //
  // A looping voice parked on the nearest pickup. It exists because in a
  // battle royale the thing you cannot see is often the thing you most need
  // to find, and a hum through a wall is how the game tells you.
  // =========================================================================
  let humSrc: AudioBufferSourceNode | null = null;
  let humGain: GainNode | null = null;
  let humPan: PannerNode | null = null;
  let humLevel = 0;

  function ensureHum(): void {
    if (humSrc || !actx || !sfxBus) return;
    const bufs = buildCue("chest-hum", false);
    if (!bufs || bufs.length === 0) return;
    const a = actx;
    try {
      humSrc = a.createBufferSource();
      humSrc.buffer = bufs[0];
      humSrc.loop = true;
      humGain = a.createGain();
      humGain.gain.value = 0;
      humPan = a.createPanner();
      humPan.panningModel = hrtf ? "HRTF" : "equalpower";
      humPan.distanceModel = "inverse";
      humPan.rolloffFactor = 0;
      humPan.refDistance = 1;
      humSrc.connect(humGain);
      humGain.connect(humPan);
      humPan.connect(sfxBus);
      humSrc.start();
    } catch {
      humSrc = null;
    }
  }

  const HUM_RANGE = 20;
  function tickHum(dt: number): void {
    const loot = ctx.services.loot;
    let want = 0;
    if (loot && ready) {
      const near = loot.nearest(listenerPos, HUM_RANGE);
      if (near) {
        ensureHum();
        if (humPan) setPannerPos(humPan, near.position);
        const d = listenerPos.distanceTo(near.position);
        want = Math.pow(1 - clamp01(d / HUM_RANGE), 1.6);
      }
    }
    humLevel += (want - humLevel) * Math.min(1, dt * 3);
    if (humGain) setParam(humGain.gain, humLevel * 0.5, 0.1);
  }

  // =========================================================================
  // 7j. The ambience director
  // =========================================================================
  let shorePhase = 0;

  /**
   * Distance to water, by ring probe. Coarse on purpose: surf is a bed whose
   * level changes over hundreds of metres, and 42 `isWater` calls twice a
   * second is nothing next to the alternative of a distance field.
   */
  const SHORE_RADII = [10, 26, 55, 100, 175, 280, 430];
  function probeShore(x: number, z: number): number {
    const t = ctx.services.terrain;
    if (!t) return 999;
    if (t.isWater(x, z)) return 0;
    shorePhase += 0.7;
    for (const r of SHORE_RADII) {
      for (let i = 0; i < 6; i++) {
        const ang = shorePhase + (i * TWO_PI) / 6;
        if (t.isWater(x + Math.cos(ang) * r, z + Math.sin(ang) * r)) return r;
      }
    }
    return 999;
  }

  /** Cheap indoor test: is there a ceiling directly overhead? */
  function probeIndoor(): void {
    const col = ctx.services.collision;
    if (!col) {
      env.indoor = 0;
      return;
    }
    tmpDir.set(0, 1, 0);
    const hit = col.raycast(listenerPos, tmpDir, 8);
    const want = hit ? 1 : 0;
    // Smoothed, because walking under a doorway lintel should not slam the
    // whole mix into "indoors" for two frames.
    env.indoor += (want - env.indoor) * 0.5;
  }

  function sampleEnvironment(): void {
    const player = ctx.services.player;
    const terrain = ctx.services.terrain;
    const sky = ctx.services.sky;
    const storm = ctx.services.storm;
    const p = player?.position ?? listenerPos;
    const x = p.x;
    const z = p.z;

    env.shore = probeShore(x, z);
    const groundY = terrain?.heightAt(x, z) ?? 0;
    env.altitude = Math.max(0, p.y - groundY);
    env.night = sky ? 1 - clamp01(sky.daylight) : 0;

    if (terrain) {
      const sea = terrain.seaLevel;
      env.submerged = p.y < sea - 0.4 && terrain.isWater(x, z) ? 1 : env.submerged * 0.5;
    }

    // Urban weight from the POI registry: inside a named place you get the
    // building hum, out on the hillside you get the trees.
    let urban = 0;
    const pois = ctx.services.pois;
    if (pois) {
      for (const poi of pois) {
        const d = Math.hypot(poi.center.x - x, poi.center.z - z);
        const w = clamp01(1 - d / Math.max(20, poi.radius * 1.35));
        if (w > urban) urban = w;
      }
    }
    // The city drops away as you climb above it — at 200 m up you are hearing
    // wind, not air conditioning.
    env.urban = urban * (1 - Math.min(0.9, env.altitude / 180));

    const mat = terrain?.materialAt(x, z);
    const vegetated = mat === "grass" ? 1 : mat === "dirt" ? 0.55 : 0;
    env.forest = vegetated * (1 - env.urban) * Math.max(0, 1 - env.altitude / 140);
    env.open = clamp01(1 - env.urban - env.forest * 0.5);

    if (storm) {
      env.stormDist = listenerPos.distanceTo(storm.center) - storm.radius;
      env.inStorm = env.stormDist > 0 ? 1 : 0;
    } else {
      env.stormDist = 9999;
      env.inStorm = 0;
    }

    // ---- Bed targets ------------------------------------------------------
    const shoreAbs = env.shore;
    // Surf carries a long way inland but goes *dull* rather than merely
    // quiet, which is the difference between "distant sea" and "quiet sea".
    const surfAmt = Math.max(0, 1 - shoreAbs / 620);
    const surfBed = bedVoice("surf");
    surfBed.target = BEDS.surf.gain * Math.pow(surfAmt, 1.4) * (1 - env.submerged * 0.7) * (1 - env.indoor * 0.55);
    surfBed.cutTarget = 380 + 3200 * Math.max(0, 1 - shoreAbs / 240);

    // Wind: altitude plus airspeed. A 700 m skydive should be deafening.
    const vel = player?.velocity;
    const speed = vel ? vel.length() : 0;
    const fall = vel ? Math.max(0, -vel.y) : 0;
    const windAmt = clamp01(env.altitude / 300) * 0.35 + clamp01(speed / 55) * 0.45 + clamp01(fall / 60) * 0.5;
    const windBed = bedVoice("wind");
    windBed.target = BEDS.wind.gain * Math.min(1, 0.14 + windAmt) * (1 - env.submerged) * (1 - env.indoor * 0.7);
    // The cutoff is what turns "wind" into "speed" — level alone reads as a
    // fader move, cutoff reads as air.
    windBed.cutTarget = 420 + 4200 * Math.min(1, windAmt);

    const forestBed = bedVoice("forest");
    forestBed.target = BEDS.forest.gain * env.forest * (1 - env.submerged) * (1 - env.indoor * 0.6) * (0.5 + windAmt * 0.8);

    const birdBed = bedVoice("birds");
    // Birds thin out through dusk and are gone at night — this crossfade with
    // the cricket bed is the single clearest read of time of day in the mix.
    const day = 1 - env.night;
    birdBed.target = BEDS.birds.gain * Math.pow(day, 1.5) * Math.max(env.forest, 0.35 * (1 - env.urban))
      * Math.max(0, 1 - env.altitude / 220) * (1 - env.submerged) * (1 - env.indoor * 0.7);

    const insectBed = bedVoice("insects");
    insectBed.target = BEDS.insects.gain * day * env.forest * Math.max(0, 1 - env.altitude / 200) * (1 - env.submerged);

    const nightBed = bedVoice("night");
    nightBed.target = BEDS.night.gain * env.night * Math.max(env.forest, 0.4 * (1 - env.urban))
      * Math.max(0, 1 - env.altitude / 200) * (1 - env.submerged);

    const urbanBed = bedVoice("urban");
    urbanBed.target = BEDS.urban.gain * Math.max(env.urban, env.indoor * 0.6) * (1 - env.submerged);
    urbanBed.cutTarget = 340 + 1500 * env.urban;

    // Storm roar: audible from ~180 m outside the wall, and everything once
    // you are in it. Squared so it comes up under you rather than switching on.
    const stormNear = clamp01(1 - Math.max(0, -env.stormDist) / 180);
    // Same geometry, different weather. In SPLASH ROYALE the wall is rain, and
    // a rain bed indoors keeps more of its top than a storm roar does — you
    // hear it *on the roof*, which is the read that makes shelter feel like
    // shelter. The unused bed is never started, so this costs one render.
    const wallBedName = waterMode ? "downpour" : "storm";
    const stormBed = bedVoice(wallBedName);
    const stormAmt = env.inStorm ? 1 : stormNear * stormNear;
    stormBed.target = BEDS[wallBedName].gain * stormAmt
      * (waterMode ? 0.45 + 0.55 * (1 - env.indoor * 0.3) : 0.35 + 0.65 * (1 - env.indoor * 0.5));
    stormBed.cutTarget = waterMode
      ? 700 + 5200 * (env.inStorm ? 1 : stormNear)
      : 380 + 2600 * (env.inStorm ? 1 : stormNear);

    bedVoice("underwater").target = BEDS.underwater.gain * env.submerged;

    // ---- Reverb character -------------------------------------------------
    // Indoors slaps hard, a POI street slaps a bit, open ground barely at all,
    // and altitude kills it — there is nothing up there to reflect off.
    const altFade = Math.max(0, 1 - env.altitude / 300);
    if (env.indoor > 0.5) {
      env.wet = 0.5;
      env.tight = 0.9;
    } else if (env.urban > 0.3) {
      env.wet = (0.2 + env.urban * 0.22) * altFade;
      env.tight = 0.76;
    } else if (env.shore < 40) {
      env.wet = 0.09 * altFade;
      env.tight = 0.18;
    } else if (env.forest > 0.4) {
      env.wet = 0.14 * altFade;
      env.tight = 0.42;
    } else {
      env.wet = 0.17 * altFade;
      env.tight = 0.32;
    }
    if (env.submerged > 0.5) env.wet *= 0.35;

    setParam(tightGain?.gain, 0.25 + env.tight * 0.75, 0.4);
    setParam(wideGain?.gain, 0.15 + (1 - env.tight) * 0.85, 0.4);
  }

  // =========================================================================
  // 7k. Sparse world events + movement cues the other systems don't own
  // =========================================================================
  const timers = { gull: 5, bird: 8, fire: 24, flap: 0 };

  /** Fire a one-shot at a random bearing around the listener. */
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
      if (env.shore < 260 && day > 0.35 && env.submerged < 0.5 && rng() < 0.75) {
        ambientAt("gull", 40 + rng() * 140, 16 + rng() * 40, 0.45 + rng() * 0.4);
      }
      timers.gull = 8 + rng() * 16;
    }

    // Songbirds in the treeline, by day only.
    timers.bird -= dt;
    if (timers.bird <= 0) {
      if (env.forest > 0.4 && day > 0.3 && env.indoor < 0.5 && rng() < 0.7) {
        ambientAt("bird", 10 + rng() * 40, 5 + rng() * 12, 0.35 + rng() * 0.4);
      }
      timers.bird = 6 + rng() * 13;
    }

    // A firefight somewhere else on the island. Only once the match is live —
    // gunfire during the warm-up would be a lie about where the players are.
    timers.fire -= dt;
    if (timers.fire <= 0) {
      const phase = ctx.services.match?.phase;
      if ((phase === "live" || phase === undefined) && rng() < 0.4) {
        ambientAt("distant-fire", 420 + rng() * 900, 6, 0.35 + rng() * 0.4);
      }
      timers.fire = 26 + rng() * 60;
    }

    // Glider flaps. The player system owns deploy; the rhythm of the canopy
    // afterwards is an audio concern and nothing else knows to ask for it.
    const player = ctx.services.player;
    if (player?.state === "glide") {
      timers.flap -= dt;
      if (timers.flap <= 0) {
        const fall = Math.max(0, -player.velocity.y);
        play("glider-flap", { volume: 0.3 + clamp01(fall / 22) * 0.4, rate: 0.9 + rng() * 0.25 });
        timers.flap = 0.85 + rng() * 0.7;
      }
    } else {
      timers.flap = 0.3;
    }
  }

  /** Low-health heartbeat. The one piece of state a player must never read. */
  let heartTimer = 0;
  function tickHealth(dt: number): void {
    const player = ctx.services.player;
    if (!player || player.state === "dead") {
      heartTimer = 0;
      return;
    }
    const hp = player.health / Math.max(1, player.maxHealth);
    if (hp > 0 && hp < 0.35) {
      heartTimer -= dt;
      if (heartTimer <= 0) {
        const urgency = 1 - hp / 0.35;
        play("heartbeat", { volume: 0.3 + urgency * 0.5, rate: 0.9 + urgency * 0.35 });
        heartTimer = 1.15 - urgency * 0.5;
      }
    } else {
      heartTimer = 0;
    }
  }

  // =========================================================================
  // 7l. Event wiring
  // =========================================================================
  const unsubs: (() => void)[] = [];

  /** The build material, learned from `dz:build`, used to pick the thunk. */
  let buildMaterial: HarvestKind | null = null;

  /** Rarity → playback rate for the pickup blip. Legendary is a fifth up. */
  const RARITY_RATE: Record<Rarity, number> = {
    common: 0.84,
    uncommon: 0.94,
    rare: 1.06,
    epic: 1.19,
    legendary: 1.34,
  };

  unsubs.push(
    ctx.on("dz:lock", (p) => {
      // Pointer lock is the entry gesture for this game; nothing else is a
      // more reliable "the player has actually clicked into the world".
      if (p) resume();
    }),
  );

  unsubs.push(
    ctx.on("dz:build", (p) => {
      const m = (p as { material?: HarvestKind } | null)?.material;
      if (m === "wood" || m === "stone" || m === "metal") buildMaterial = m;
    }),
  );

  unsubs.push(
    ctx.on("dz:harvest", (p) => {
      // Layered on top of the generic tool strike the build system already
      // played, because the material is only known here. Two cues arriving on
      // the same frame read as one sound with a material in it.
      const kind = (p as { kind?: HarvestKind; crit?: boolean } | null)?.kind;
      if (kind !== "wood" && kind !== "stone" && kind !== "metal") return;
      play(`harvest-${kind}`, { volume: 0.55, rate: 0.94 + rng() * 0.13 });
    }),
  );

  unsubs.push(
    ctx.on("dz:pickup", (p) => {
      const rarity = (p as { rarity?: Rarity } | null)?.rarity;
      if (!rarity) return;
      play("pickup-blip", { volume: rarity === "legendary" ? 0.6 : 0.42, rate: RARITY_RATE[rarity] ?? 1 });
    }),
  );

  unsubs.push(
    ctx.on("dz:hit", (p) => {
      // Taking damage briefly ducks the world so the sting cuts through.
      const amount = (p as { amount?: number } | null)?.amount ?? 10;
      worldDuckAmt = Math.max(worldDuckAmt, Math.min(0.35, amount / 90));
    }),
  );

  unsubs.push(
    ctx.on("dz:death", () => {
      applyConcussion(0.7);
    }),
  );

  unsubs.push(
    ctx.on("dz:underwater", (p) => {
      env.submerged = p ? 1 : 0;
    }),
  );

  /**
   * The elimination. `vfx.soakBurst()` already plays `soak-burst` by name, but
   * `mode/water.ts` spends that same name on the Triple Tap's per-pull cue, so
   * it cannot also be the two-second bucket of water a player comes apart
   * into. `vfx.ts` anticipated exactly this and emits `dz:soakburst` with the
   * position and scale — "the beat the audio system should build the real
   * elimination sound on" — so the big layer is fired from here instead.
   *
   * Position is rebuilt into a scratch vector rather than allocated: an
   * elimination is rare, but so is every other reason to leak a Vector3 into
   * a hot service, and the pattern is the one the rest of this file uses.
   */
  unsubs.push(
    ctx.on("dz:soakburst", (p) => {
      const e = p as { x?: number; y?: number; z?: number; scale?: number } | null;
      if (!e || typeof e.x !== "number" || typeof e.y !== "number" || typeof e.z !== "number") return;
      const scale = typeof e.scale === "number" && e.scale > 0 ? e.scale : 1;
      evtPos.set(e.x, e.y, e.z);
      // Bigger bursts land lower and louder — the same size-scales-pitch rule
      // `wetSlap` is built on, applied once more at playback.
      play("soak-out", {
        position: evtPos,
        volume: Math.min(1, 0.55 + 0.3 * scale),
        rate: 1.06 - Math.min(0.22, scale * 0.12),
      });
    }),
  );

  unsubs.push(
    ctx.on("dz:mute", (p) => {
      setMuted(typeof p === "boolean" ? p : !muted);
    }),
  );

  unsubs.push(
    ctx.on("dz:volume", (p) => {
      if (typeof p === "number") setVolume(p);
    }),
  );

  // =========================================================================
  // 7m. Frame
  // =========================================================================
  let envTimer = 0;
  let indoorTimer = 0;
  let humTimer = 0;

  const sys: System = {
    name: "audio",

    update(dt) {
      occlusionBudget = OCCLUSION_BUDGET;
      if (broken) return;

      // M toggles mute. `pressed` is edge-triggered, so this fires once.
      if (ctx.input.pressed.has("KeyM")) setMuted(!muted);

      if (!actx) return;
      // Spend more of the frame on the bank while the world is still settling
      // — a hitch during the bus ride costs nothing, one mid-fight costs a lot.
      pumpPrebuild(ctx.elapsed < 6 ? 4 : 1.2);
      if (!ready) return;

      if (pendingMusic) {
        const want = pendingMusic;
        pendingMusic = null;
        music(want);
      }

      // The environment at 8 Hz. None of it moves fast enough to want more,
      // and the shore probe is the most expensive thing this module does.
      envTimer -= dt;
      if (envTimer <= 0) {
        envTimer = 0.125;
        sampleEnvironment();
      }
      indoorTimer -= dt;
      if (indoorTimer <= 0) {
        indoorTimer = 0.35;
        probeIndoor();
      }
      humTimer -= dt;
      if (humTimer <= 0) {
        humTimer = 0.12;
        tickHum(0.12);
      }

      mixBeds(dt);
      tickAmbientEvents(dt);
      tickHealth(dt);

      heat = Math.max(0, heat - dt * 0.85);
      computeTension(dt);
      mixMusic(dt);

      // --- Concussion, ducking, underwater ---------------------------------
      concussionAmt = Math.max(0, concussionAmt - dt / (CONCUSSION_DECAY + concussionAmt * 1.8));
      worldDuckAmt = Math.max(0, worldDuckAmt - dt * 1.6);
      // One shared filter, so take whichever influence is darkest.
      let cut = 21000;
      if (concussionAmt > 0.001) cut = Math.min(cut, 21000 * Math.pow(0.02, concussionAmt));
      if (env.submerged > 0.5) cut = Math.min(cut, 420);
      else if (env.indoor > 0.5) cut = Math.min(cut, 9500);
      setParam(muffle?.frequency, Math.max(260, cut), 0.06);
      setParam(worldDuck?.gain, 1 - worldDuckAmt * 0.6, 0.05);
      setParam(ambDuck?.gain, 1 - concussionAmt * 0.75, 0.12);
      setParam(tinGain?.gain, concussionAmt > 0.05 ? concussionAmt * 0.02 : 0, 0.15);
      // Music ducks under gunfire and under a blast. It is the one bus that
      // has no business competing with information.
      setParam(musicDuck?.gain, 1 - Math.min(0.65, heat * 0.55 + concussionAmt * 0.5), 0.12);

      // Safety sweep: a dropped `onended` must never leak a voice slot.
      const now = actx.currentTime;
      for (let i = voices.length - 1; i >= 0; i--) {
        if (voices[i].endsAt < now - 0.5) releaseVoice(voices[i]);
      }
    },

    /**
     * The listener runs in lateUpdate: the player controller writes the
     * camera during update(), and a listener one frame behind smears every
     * pan into mush on fast turns — which is most of them, in this game.
     */
    lateUpdate() {
      if (!actx || !ready) return;
      const cam = listenerCam ?? ctx.camera;
      cam.getWorldPosition(listenerPos);
      cam.getWorldQuaternion(tmpQuat);
      listenerFwd.set(0, 0, -1).applyQuaternion(tmpQuat);
      listenerUp.set(0, 1, 0).applyQuaternion(tmpQuat);

      const L = actx.listener;
      const t = actx.currentTime;
      const lp = L.positionX as AudioParam | undefined;
      if (lp) {
        // 12 ms smoothing: enough to kill zipper noise on the position ramp,
        // not enough for the head to lag behind the camera perceptibly.
        lp.setTargetAtTime(listenerPos.x, t, 0.012);
        L.positionY.setTargetAtTime(listenerPos.y, t, 0.012);
        L.positionZ.setTargetAtTime(listenerPos.z, t, 0.012);
        L.forwardX.setTargetAtTime(listenerFwd.x, t, 0.012);
        L.forwardY.setTargetAtTime(listenerFwd.y, t, 0.012);
        L.forwardZ.setTargetAtTime(listenerFwd.z, t, 0.012);
        L.upX.setTargetAtTime(listenerUp.x, t, 0.05);
        L.upY.setTargetAtTime(listenerUp.y, t, 0.05);
        L.upZ.setTargetAtTime(listenerUp.z, t, 0.05);
      } else {
        const legacy = L as unknown as {
          setPosition(x: number, y: number, z: number): void;
          setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
        };
        legacy.setPosition(listenerPos.x, listenerPos.y, listenerPos.z);
        legacy.setOrientation(
          listenerFwd.x, listenerFwd.y, listenerFwd.z,
          listenerUp.x, listenerUp.y, listenerUp.z,
        );
      }
      tmpVec.copy(listenerPos);
    },

    dispose() {
      for (const u of unsubs) u();
      unsubs.length = 0;
      for (const id of timerIds) window.clearTimeout(id);
      timerIds.clear();
      if (typeof window !== "undefined") {
        for (const ev of GESTURES) window.removeEventListener(ev, unlock);
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
      voices.length = 0;
      pool.length = 0;

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
      bedRequest.clear();

      for (const s of musicStems) {
        try {
          s.src.stop();
        } catch {
          /* already ended */
        }
        s.src.disconnect();
        s.gain.disconnect();
      }
      musicStems = [];
      musicName = null;

      try {
        humSrc?.stop();
      } catch {
        /* never started */
      }
      humSrc?.disconnect();
      humGain?.disconnect();
      humPan?.disconnect();
      humSrc = null;
      humGain = null;
      humPan = null;

      try {
        tinnitus?.stop();
      } catch {
        /* never started */
      }
      tinnitus?.disconnect();
      tinGain?.disconnect();

      // Disconnect the fixed graph explicitly. close() is asynchronous and a
      // node still wired into a destination can outlive the promise.
      for (const n of [
        master, limiter, worldDuck, muffle, sfxBus, ambBus, ambDuck, uiBus,
        musicBus, musicDuck, revIn, revOut, convTight, convWide, tightGain, wideGain,
      ]) {
        try {
          n?.disconnect();
        } catch {
          /* already gone */
        }
      }

      bank.clear();
      bedBuffers.clear();
      musicBuffers.clear();
      resolveCache.clear();

      actx?.close().catch(() => {});
      actx = null;
      master = null;
      limiter = null;
      worldDuck = null;
      muffle = null;
      sfxBus = null;
      ambBus = null;
      ambDuck = null;
      uiBus = null;
      musicBus = null;
      musicDuck = null;
      revIn = null;
      revOut = null;
      convTight = null;
      convWide = null;
      tightGain = null;
      wideGain = null;
      tinnitus = null;
      tinGain = null;
      ready = false;
      if (ctx.services.audio === service) ctx.services.audio = undefined;
    },
  };

  return sys;
};

export default createAudio;
