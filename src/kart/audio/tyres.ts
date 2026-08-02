/**
 * Vibe Kart — tyres and surfaces.
 *
 * Three continuous voices that never stop and never retrigger; only their
 * gains and cutoffs move, which is what keeps a surface change sounding like a
 * kart crossing a line rather than a sample swapping.
 *
 *   · **Rolling** — one shared noise source through five parallel filter
 *     colours (body, hiss, crunch, swish, spray). Each surface is a mix of
 *     those five, and driving from tarmac onto grass is a crossfade between two
 *     mixes. The noise source's playback rate rides speed too, so the grain
 *     itself gets faster, not just louder.
 *   · **Squeal** — a high-Q band-pass on its own noise source with a vibrato
 *     LFO on the cutoff, plus a pitched core. Brightness follows slip angle;
 *     level follows slip × speed × how little grip the surface has. This is the
 *     drift sound, and it must be *continuous* — a looped squeal sample
 *     retriggering is the single most obvious tell of a cheap racing game.
 *   · **Rattle** — band-passed noise gated by a square LFO whose rate is the
 *     rib-crossing frequency: speed ÷ rib spacing. Kerbs, planks and grates.
 *
 * All three fade to silence when the wheels leave the ground, because a kart in
 * the air makes no tyre noise and the absence is a genuinely useful cue.
 */
import type { KartQuality, SurfaceKind } from "../types";
import type { AudioGraph } from "./graph";
import { clamp, clamp01 } from "./synth";

export interface TyreState {
  speed: number;
  maxSpeed: number;
  surface: SurfaceKind | string;
  drifting: boolean;
  driftCharge: number;
  /** Absolute slip angle in radians — how sideways the kart actually is. */
  slip: number;
  grounded: boolean;
}

/** Mix weights per surface: [body, hiss, crunch, swish, spray]. */
type Mix = readonly [number, number, number, number, number];

const SURFACE_MIX: Record<string, Mix> = {
  road: [0.35, 1.0, 0.05, 0.0, 0.0],
  boost: [0.4, 1.1, 0.05, 0.0, 0.0],
  rumble: [0.6, 0.7, 0.55, 0.0, 0.0],
  dirt: [0.7, 0.25, 1.0, 0.25, 0.0],
  grass: [0.5, 0.2, 0.35, 1.0, 0.0],
  sand: [0.65, 0.15, 0.85, 0.45, 0.0],
  water: [0.45, 0.35, 0.2, 0.3, 1.0],
  ice: [0.25, 0.55, 0.0, 0.0, 0.05],
  wood: [0.75, 0.45, 0.35, 0.05, 0.0],
  metal: [0.35, 0.9, 0.2, 0.0, 0.0],
  antigrav: [0.3, 0.8, 0.0, 0.0, 0.0],
  void: [0, 0, 0, 0, 0],
};

/** Rib spacing in metres for the surfaces that rattle. 0 = smooth. */
const RIB: Record<string, number> = { rumble: 0.55, wood: 1.4, metal: 0.32, dirt: 2.2 };

/** How readily a surface lets the tyres howl. Ice squeals; sand just sighs. */
const SQUEAL_GRIP: Record<string, number> = {
  road: 1,
  boost: 1,
  rumble: 0.8,
  metal: 0.95,
  antigrav: 1,
  wood: 0.7,
  ice: 0.55,
  dirt: 0.3,
  grass: 0.22,
  sand: 0.2,
  water: 0.25,
  void: 0,
};

export interface TyreRig {
  update(state: TyreState | null, dt: number): void;
  dispose(): void;
}

interface Layer {
  filter: BiquadFilterNode;
  /** Level, driven per frame. */
  gain: GainNode;
  /** Optional post-level gain for LFO amplitude modulation. */
  am: GainNode | null;
}

export function createTyreRig(g: AudioGraph): TyreRig {
  const ac = g.ac;
  const t0 = ac.currentTime;
  const owned: AudioNode[] = [];
  const lean: boolean = g.quality === "low";

  const bus = ac.createGain();
  bus.gain.value = 0.9;
  bus.connect(g.sfx);
  const send = ac.createGain();
  send.gain.value = 0.12;
  bus.connect(send).connect(g.send);
  owned.push(bus, send);

  // --- Rolling -------------------------------------------------------------
  const roll = ac.createBufferSource();
  roll.buffer = g.noise;
  roll.loop = true;
  const rollBus = ac.createGain();
  rollBus.gain.value = 0.0001;
  rollBus.connect(bus);
  owned.push(rollBus);

  /**
   * `modulated` inserts a second gain after the level control for an LFO to
   * chew on. The modulation must NOT ride the level param itself: an LFO
   * summed onto a param we also drive to silence just swings it negative,
   * which is a phase inversion, not a fade — the layer stays audible when it
   * is supposed to be gone.
   */
  function layer(type: BiquadFilterType, freq: number, q: number, modulated = false): Layer {
    const filter = ac.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ac.createGain();
    gain.gain.value = 0.0001;
    roll.connect(filter).connect(gain);
    let am: GainNode | null = null;
    if (modulated) {
      am = ac.createGain();
      am.gain.value = 0.6;
      gain.connect(am).connect(rollBus);
      owned.push(am);
    } else {
      gain.connect(rollBus);
    }
    owned.push(filter, gain);
    return { filter, gain, am };
  }

  const layers: Layer[] = [
    layer("lowpass", 240, 0.9), // body — the weight of a wheel on a surface
    layer("highpass", 2600, 0.7), // hiss — tarmac at speed
    layer("bandpass", 1150, 1.4, true), // crunch — gravel and grit
    layer("lowpass", 620, 1.1), // swish — vegetation
    layer("bandpass", 3200, 0.8), // spray — water off the tread
  ];

  // The crunch layer gets amplitude modulation: real gravel is a stream of
  // discrete impacts, and a steady band of noise never sells that.
  let crunchLfo: OscillatorNode | null = null;
  if (!lean) {
    crunchLfo = ac.createOscillator();
    crunchLfo.type = "triangle";
    crunchLfo.frequency.value = 26;
    const depth = ac.createGain();
    depth.gain.value = 0.4;
    const am = layers[2].am;
    if (am) crunchLfo.connect(depth).connect(am.gain);
    crunchLfo.start(t0);
    owned.push(depth);
  }

  roll.start(t0, g.rng() * 1.5);

  // --- Squeal --------------------------------------------------------------
  const squealSrc = ac.createBufferSource();
  squealSrc.buffer = g.noise;
  squealSrc.loop = true;
  squealSrc.playbackRate.value = 1.15;
  const squealBp = ac.createBiquadFilter();
  squealBp.type = "bandpass";
  squealBp.frequency.value = 1400;
  squealBp.Q.value = 8.5;
  const squealPeak = ac.createBiquadFilter();
  squealPeak.type = "peaking";
  squealPeak.frequency.value = 2600;
  squealPeak.Q.value = 4;
  squealPeak.gain.value = 8;
  const squealGain = ac.createGain();
  squealGain.gain.value = 0.0001;
  squealSrc.connect(squealBp).connect(squealPeak).connect(squealGain).connect(bus);
  squealSrc.start(t0, g.rng() * 1.5);
  owned.push(squealBp, squealPeak, squealGain);

  // A pitched core an octave under the band gives the squeal a note to hang
  // on; pure filtered noise reads as wind, not rubber.
  const squealTone = ac.createOscillator();
  squealTone.type = "sawtooth";
  squealTone.frequency.value = 700;
  const squealToneGain = ac.createGain();
  squealToneGain.gain.value = 0.05;
  const squealToneLp = ac.createBiquadFilter();
  squealToneLp.type = "lowpass";
  squealToneLp.frequency.value = 2400;
  squealTone.connect(squealToneGain).connect(squealToneLp).connect(squealGain);
  squealTone.start(t0);
  owned.push(squealToneGain, squealToneLp);

  // Vibrato on the band: tyres howl, they do not hold a pitch.
  let squealLfo: OscillatorNode | null = null;
  if (!lean) {
    squealLfo = ac.createOscillator();
    squealLfo.type = "sine";
    squealLfo.frequency.value = 6.5;
    const depth = ac.createGain();
    depth.gain.value = 90;
    squealLfo.connect(depth).connect(squealBp.frequency);
    squealLfo.start(t0);
    owned.push(depth);
  }

  // --- Rattle --------------------------------------------------------------
  let rattleGain: GainNode | null = null;
  let rattleGate: GainNode | null = null;
  let rattleLfo: OscillatorNode | null = null;
  let rattleBp: BiquadFilterNode | null = null;
  let rattleSrc: AudioBufferSourceNode | null = null;
  if (!lean) {
    const src = ac.createBufferSource();
    rattleSrc = src;
    src.buffer = g.noise;
    src.loop = true;
    src.playbackRate.value = 0.8;
    rattleBp = ac.createBiquadFilter();
    rattleBp.type = "bandpass";
    rattleBp.frequency.value = 320;
    rattleBp.Q.value = 1.8;
    rattleGate = ac.createGain();
    rattleGate.gain.value = 0.5; // LFO swings this ±0.5 → a 0..1 gate
    rattleGain = ac.createGain();
    rattleGain.gain.value = 0.0001;
    rattleLfo = ac.createOscillator();
    rattleLfo.type = "square";
    rattleLfo.frequency.value = 12;
    const depth = ac.createGain();
    depth.gain.value = 0.5;
    rattleLfo.connect(depth).connect(rattleGate.gain);
    src.connect(rattleBp).connect(rattleGate).connect(rattleGain).connect(bus);
    src.start(t0, g.rng() * 1.5);
    rattleLfo.start(t0);
    owned.push(rattleBp, rattleGate, rattleGain, depth, src);
  }

  const sources: AudioScheduledSourceNode[] = [roll, squealSrc, squealTone];
  if (crunchLfo) sources.push(crunchLfo);
  if (squealLfo) sources.push(squealLfo);
  if (rattleLfo) sources.push(rattleLfo);
  if (rattleSrc) sources.push(rattleSrc);

  let mixSmooth: number[] = [0, 0, 0, 0, 0];

  function update(state: TyreState | null, dt: number): void {
    const t = ac.currentTime;
    if (!state || !state.grounded) {
      rollBus.gain.setTargetAtTime(0.0001, t, 0.08);
      squealGain.gain.setTargetAtTime(0.0001, t, 0.06);
      rattleGain?.gain.setTargetAtTime(0.0001, t, 0.06);
      return;
    }

    const top = Math.max(6, state.maxSpeed || 28);
    const speed = Math.abs(state.speed || 0);
    const u = clamp01(speed / top);
    const surface = String(state.surface || "road");
    const mix = SURFACE_MIX[surface] ?? SURFACE_MIX.road;

    // Crossfade the surface mix in the frame domain as well as with
    // setTargetAtTime: two stages of smoothing means even a surface that
    // flickers between road and kerb on a painted line never chatters.
    const k = Math.min(1, dt * 6);
    for (let i = 0; i < 5; i++) mixSmooth[i] += (mix[i] - mixSmooth[i]) * k;

    // Rolling noise starts around walking pace and is loudest near the limit.
    const rollLevel = Math.pow(u, 0.75) * 0.38;
    rollBus.gain.setTargetAtTime(Math.max(0.0001, rollLevel), t, 0.05);
    roll.playbackRate.setTargetAtTime(0.7 + u * 0.85, t, 0.08);
    for (let i = 0; i < layers.length; i++) {
      const target = mixSmooth[i] * (i === 1 ? 0.5 + u * 0.6 : 1);
      layers[i].gain.gain.setTargetAtTime(Math.max(0.0001, target * 0.5), t, 0.06);
    }
    layers[1].filter.frequency.setTargetAtTime(1800 + u * 2600, t, 0.1);
    if (crunchLfo) crunchLfo.frequency.setTargetAtTime(14 + u * 46, t, 0.08);

    // Squeal: slip angle is the honest signal, but a charging drift squeals
    // even when the physics has settled into a stable slide, so take the max.
    const slip = clamp01(Math.abs(state.slip) / 0.5);
    const drift = state.drifting ? 0.45 + 0.55 * clamp01(state.driftCharge) : 0;
    const howl = Math.max(slip, drift) * (SQUEAL_GRIP[surface] ?? 0.6);
    const squealLevel = howl * clamp01((u - 0.12) / 0.4) * 0.3;
    squealGain.gain.setTargetAtTime(Math.max(0.0001, squealLevel), t, howl > 0.05 ? 0.04 : 0.09);
    // Brightness follows slip: a light scrub sings high, a full slide roars.
    const band = 900 + howl * 1500 + u * 500;
    squealBp.frequency.setTargetAtTime(clamp(band, 400, 4200), t, 0.06);
    squealPeak.frequency.setTargetAtTime(clamp(band * 1.9, 800, 7000), t, 0.08);
    squealTone.frequency.setTargetAtTime(clamp(band * 0.5, 180, 1400), t, 0.06);
    squealSrc.playbackRate.setTargetAtTime(0.9 + howl * 0.5, t, 0.08);

    // Rattle: rib-crossing frequency, capped so it stays a rattle and does not
    // turn into a pitch as the kart hits top speed.
    if (rattleGain && rattleLfo && rattleBp) {
      const spacing = RIB[surface] ?? 0;
      const rate = spacing > 0 ? clamp(speed / spacing, 4, 70) : 4;
      rattleLfo.frequency.setTargetAtTime(rate, t, 0.04);
      rattleBp.frequency.setTargetAtTime(220 + u * 260, t, 0.08);
      const level = spacing > 0 ? clamp01((u - 0.08) / 0.3) * 0.16 : 0;
      rattleGain.gain.setTargetAtTime(Math.max(0.0001, level), t, level > 0.001 ? 0.03 : 0.08);
    }
  }

  return {
    update,
    dispose() {
      const t = ac.currentTime;
      for (const s of sources) {
        try {
          s.stop(t);
        } catch {
          /* already stopped */
        }
      }
      for (const n of owned) {
        try {
          n.disconnect();
        } catch {
          /* already gone */
        }
      }
      owned.length = 0;
      mixSmooth = [0, 0, 0, 0, 0];
    },
  };
}

/** Exposed for the debug overlay: which surfaces this rig knows how to voice. */
export function knownSurfaces(): string[] {
  return Object.keys(SURFACE_MIX);
}

/** Quality gate helper, kept next to the rig it governs. */
export function tyreDetail(q: KartQuality): "lean" | "full" {
  return q === "low" ? "lean" : "full";
}
