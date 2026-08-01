/**
 * Vibe Kart — the audio graph.
 *
 * One AudioContext, one master chain, four buses. Everything else in this
 * folder is a customer of the objects built here.
 *
 *      voices ─┬─► sfx ────┐
 *              ├─► engine ─┤
 *              └─► music ──┼─► master ─► limiter ─► destination
 *      sends ──────────────┤
 *          └─► reverb ─► wet
 *
 * Two decisions worth explaining:
 *
 * 1. **No convolver.** A ConvolutionNode with a 2 s stereo impulse costs a
 *    real slice of the audio thread on a laptop, and a racing game already
 *    spends its budget on eight engines and a drum kit. The space here is a
 *    damped comb bank (a feedback delay network in the Schroeder sense):
 *    a handful of delay lines, each with a one-pole damper in its feedback
 *    path so the tail loses its top end the way an outdoor stadium does.
 *    Twenty-four nodes, effectively free, and for a diffuse "big outdoors"
 *    wash it is indistinguishable from a convolved tail.
 *
 * 2. **The context is built lazily and may never exist.** Browsers gate
 *    WebAudio behind a gesture, the screenshot harness is headless, and old
 *    Safari is missing half the constructors. Every entry point in this module
 *    returns null rather than throwing, and every caller treats null as
 *    "the game is silent today" — which is a cosmetic bug, not a crash.
 */
import type { KartQuality, Rng } from "../types";

/**
 * Bus trims. `master` is post-limiter headroom — the limiter does the real
 * safety work. Engine sits under sfx so a shell hit always cuts through it.
 */
export const BUS_GAIN = { master: 0.92, sfx: 0.88, engine: 0.5, music: 0.34 } as const;

export interface AudioGraph {
  ac: AudioContext;
  /** Master trim — mute and visibility ducking ride this one param. */
  master: GainNode;
  sfx: GainNode;
  engine: GainNode;
  music: GainNode;
  /** Reverb send bus; voices tap it through their own little gain. */
  send: GainNode;
  wet: GainNode;
  /** Two seconds of white noise, shared by every noise-based voice. */
  noise: AudioBuffer;
  /** PannerNode + AudioListener are usable (i.e. real 3D placement). */
  spatial: boolean;
  /** StereoPannerNode is available (very old Safari has neither). */
  stereo: boolean;
  quality: KartQuality;
  rng: Rng;
  /** Simultaneous transient voices allowed before non-critical shots drop. */
  budget: number;
  /** Decayed estimate of live voices, and the audio-clock time it was taken. */
  voices: number;
  voicesAt: number;
  /** Long-lived nodes, disconnected wholesale on dispose. */
  owned: AudioNode[];
}

type AudioCtor = typeof AudioContext;

function audioCtor(): AudioCtor | null {
  if (typeof window === "undefined") return null;
  if (typeof AudioContext !== "undefined") return AudioContext;
  const legacy = (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  return legacy ?? null;
}

/** Voice budget by quality — a phone cannot afford a forty-voice pile-up. */
function budgetFor(quality: KartQuality): number {
  switch (quality) {
    case "low":
      return 14;
    case "medium":
      return 22;
    case "high":
      return 30;
    default:
      return 38;
  }
}

/**
 * Damped comb bank. `times` are in seconds and deliberately mutually prime-ish
 * so the modes never line up into a ringing pitch; `rt60` is the time the tail
 * takes to fall 60 dB, from which each line's feedback gain follows directly.
 */
function combBank(
  ac: AudioContext,
  input: AudioNode,
  output: AudioNode,
  times: number[],
  rt60: number,
  damp: number,
  owned: AudioNode[],
): void {
  for (const d of times) {
    const delay = ac.createDelay(0.2);
    delay.delayTime.value = d;
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = damp;
    lp.Q.value = 0.0001;
    const fb = ac.createGain();
    // g = 10^(-3·d/rt60) is the textbook comb feedback for a target decay.
    fb.gain.value = Math.min(0.92, Math.pow(10, (-3 * d) / rt60));
    input.connect(delay);
    delay.connect(lp);
    lp.connect(fb);
    fb.connect(delay);
    delay.connect(output);
    owned.push(delay, lp, fb);
  }
}

export function createGraph(quality: KartQuality, rng: Rng): AudioGraph | null {
  const Ctor = audioCtor();
  if (!Ctor) return null;
  let ac: AudioContext;
  try {
    ac = new Ctor({ latencyHint: "interactive" });
  } catch {
    return null;
  }

  const owned: AudioNode[] = [];

  // A limiter, not a colour compressor: high ratio, fast attack, slow enough
  // release that a burst of shell hits does not audibly pump the music.
  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.22;
  limiter.connect(ac.destination);

  const master = ac.createGain();
  master.gain.value = BUS_GAIN.master;
  master.connect(limiter);

  const sfx = ac.createGain();
  sfx.gain.value = BUS_GAIN.sfx;
  sfx.connect(master);

  const engine = ac.createGain();
  engine.gain.value = BUS_GAIN.engine;
  engine.connect(master);

  const music = ac.createGain();
  music.gain.value = 0; // faded in by the sequencer
  music.connect(master);

  // --- Space -------------------------------------------------------------
  const send = ac.createGain();
  send.gain.value = 1;
  const wet = ac.createGain();
  wet.gain.value = 0.26;

  // A short pre-delay separates the direct sound from the wash, which is what
  // makes a wet mix still read as "close" rather than "underwater".
  const pre = ac.createDelay(0.1);
  pre.delayTime.value = 0.014;
  send.connect(pre);

  const merge = ac.createChannelMerger(2);
  const lean = quality === "low" || quality === "medium";
  const left = lean ? [0.0297, 0.0411] : [0.0297, 0.0371, 0.0411, 0.0437];
  const right = lean ? [0.0313, 0.0427] : [0.0307, 0.0389, 0.0419, 0.0451];
  const lSum = ac.createGain();
  const rSum = ac.createGain();
  lSum.gain.value = 1 / left.length;
  rSum.gain.value = 1 / right.length;
  combBank(ac, pre, lSum, left, 1.7, 4200, owned);
  combBank(ac, pre, rSum, right, 1.75, 3800, owned);
  lSum.connect(merge, 0, 0);
  rSum.connect(merge, 0, 1);

  // Trim the extremes off the tail: rumble in a reverb is mud, and hiss up
  // top fights the tyres for the same band.
  const hp = ac.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 260;
  const lp = ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 6500;
  merge.connect(hp);
  hp.connect(lp);
  lp.connect(wet);
  wet.connect(master);
  owned.push(limiter, master, sfx, engine, music, send, wet, pre, merge, lSum, rSum, hp, lp);

  // Two seconds of noise. Every hiss, crunch, crash and snare slices this.
  const n = Math.max(1, Math.floor(ac.sampleRate * 2));
  const noise = ac.createBuffer(1, n, ac.sampleRate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < n; i++) nd[i] = rng() * 2 - 1;

  return {
    ac,
    master,
    sfx,
    engine,
    music,
    send,
    wet,
    noise,
    spatial: typeof ac.createPanner === "function" && !!ac.listener,
    stereo: typeof ac.createStereoPanner === "function",
    quality,
    rng,
    budget: budgetFor(quality),
    voices: 0,
    voicesAt: 0,
    owned,
  };
}

/**
 * Claim `cost` transient voices. Returns false when the mixer is already
 * saturated, which the caller uses to drop cosmetic sounds (a fourth
 * simultaneous kerb rattle) while critical ones ignore the answer.
 */
export function takeVoices(g: AudioGraph, cost = 1): boolean {
  const t = g.ac.currentTime;
  // Voices retire at roughly 26/s of wall time; decay against the audio clock
  // and never the frame clock, which stalls exactly when the mixer is busiest.
  g.voices = Math.max(0, g.voices - Math.max(0, t - g.voicesAt) * 26);
  g.voicesAt = t;
  if (g.voices >= g.budget) return false;
  g.voices += cost;
  return true;
}

/** World-space listener pose, taken straight off the camera's world matrix. */
export function updateListener(g: AudioGraph, m: ArrayLike<number>): void {
  if (!g.spatial) return;
  const l = g.ac.listener;
  const px = m[12];
  const py = m[13];
  const pz = m[14];
  // Three's camera looks down its local -Z; +Y of the matrix is its up.
  const fx = -m[8];
  const fy = -m[9];
  const fz = -m[10];
  const ux = m[4];
  const uy = m[5];
  const uz = m[6];
  const t = g.ac.currentTime;
  if (l.positionX) {
    // A 30 ms glide stops a camera cut from clicking through the panners.
    l.positionX.setTargetAtTime(px, t, 0.03);
    l.positionY.setTargetAtTime(py, t, 0.03);
    l.positionZ.setTargetAtTime(pz, t, 0.03);
    l.forwardX.setTargetAtTime(fx, t, 0.03);
    l.forwardY.setTargetAtTime(fy, t, 0.03);
    l.forwardZ.setTargetAtTime(fz, t, 0.03);
    l.upX.setTargetAtTime(ux, t, 0.03);
    l.upY.setTargetAtTime(uy, t, 0.03);
    l.upZ.setTargetAtTime(uz, t, 0.03);
    return;
  }
  // Pre-2018 Safari: the deprecated setters are the only path there is.
  const legacy = l as unknown as {
    setPosition?: (x: number, y: number, z: number) => void;
    setOrientation?: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void;
  };
  legacy.setPosition?.(px, py, pz);
  legacy.setOrientation?.(fx, fy, fz, ux, uy, uz);
}

/**
 * A panner tuned for a race track: full level inside a kart length, audible
 * across the field, gone by the far side of the circuit. `equalpower` rather
 * than HRTF — HRTF convolves per source and we have eight of them.
 */
export function createPanner(g: AudioGraph, x: number, y: number, z: number): PannerNode | null {
  if (!g.spatial) return null;
  const p = g.ac.createPanner();
  p.panningModel = "equalpower";
  p.distanceModel = "inverse";
  p.refDistance = 9;
  p.maxDistance = 320;
  p.rolloffFactor = 0.85;
  setPannerPosition(g, p, x, y, z, 0);
  return p;
}

/** `smooth` > 0 glides instead of jumping — used by the rival engine voices. */
export function setPannerPosition(
  g: AudioGraph,
  p: PannerNode,
  x: number,
  y: number,
  z: number,
  smooth: number,
): void {
  const t = g.ac.currentTime;
  if (p.positionX) {
    if (smooth > 0) {
      p.positionX.setTargetAtTime(x, t, smooth);
      p.positionY.setTargetAtTime(y, t, smooth);
      p.positionZ.setTargetAtTime(z, t, smooth);
    } else {
      p.positionX.setValueAtTime(x, t);
      p.positionY.setValueAtTime(y, t);
      p.positionZ.setValueAtTime(z, t);
    }
    return;
  }
  (p as unknown as { setPosition?: (x: number, y: number, z: number) => void }).setPosition?.(x, y, z);
}

/** Free everything. After this the graph object must not be used again. */
export function disposeGraph(g: AudioGraph): void {
  for (const node of g.owned) {
    try {
      node.disconnect();
    } catch {
      /* already gone */
    }
  }
  g.owned.length = 0;
  try {
    void g.ac.close();
  } catch {
    /* closing a closed context throws on some builds */
  }
}
