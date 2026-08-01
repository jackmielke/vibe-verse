/**
 * Vibe Kart — the one-shot sound bank.
 *
 * Sixty-odd named cues, none of which is a file. Each one is either
 *
 *   · **baked** — rendered sample-by-sample into an AudioBuffer at boot, then
 *     fired as a BufferSource with a little rate jitter. Everything percussive,
 *     everything noisy, and everything that fires more than once a lap lives
 *     here: it is three nodes at trigger time instead of fifteen, and the
 *     sample-domain code can do FM, crackle and saturation that a biquad chain
 *     simply cannot; or
 *   · **live** — a small node graph built at trigger time, for cues that are
 *     really little melodies (fanfares, jingles, alerts) or that must respond
 *     to a parameter, where being able to place notes on the audio clock at
 *     arbitrary offsets is worth the nodes.
 *
 * `play()` resolves through an alias table and falls back to a generic blip,
 * because sibling systems invent cue names after this file is written and a
 * missing sound must never be a missing frame.
 */
import type { Rng } from "../types";
import type { AudioGraph } from "./graph";
import {
  bake,
  bell,
  budgeted,
  clamp,
  noiseVoice,
  noteHz,
  normalize,
  onePole,
  oneHigh,
  percEnv,
  playBuffer,
  softClip,
  svfBand,
  tone,
  type Route,
  type Vec3Like,
} from "./synth";

export interface PlayOpts {
  at?: Vec3Like | null;
  volume?: number;
  rate?: number;
  /** Explicit audio-clock time; defaults to "as soon as possible". */
  t?: number;
}

/** Scheduling this far ahead clears one render quantum plus a frame spike. */
const AHEAD = 0.02;

type Program = (g: AudioGraph, t: number, v: number, rate: number, r: Route) => void;

// ---------------------------------------------------------------------------
// Baked programs
// ---------------------------------------------------------------------------

export type BakeId =
  | "coin"
  | "tick"
  | "pop"
  | "explosion"
  | "bonk"
  | "shatter"
  | "crack"
  | "whoosh"
  | "thud"
  | "splat"
  | "slip"
  | "sparkle"
  | "cheer"
  | "clank"
  | "skid";

/**
 * Render every baked cue. Takes a bare context rather than the graph so the
 * whole sample-domain half of this file can be exercised in a test runner,
 * where there is no AudioContext but a stub with `createBuffer` is trivial.
 */
export function bakeSoundBank(ac: BaseAudioContext, rnd: Rng): Map<BakeId, AudioBuffer> {
  const out = new Map<BakeId, AudioBuffer>();
  /**
   * Half rate for everything whose content lives below ~10 kHz — which is
   * every noise-based cue. It halves the bake cost of the bank, and the whole
   * bank is rendered inside the click that starts the race. The bright, glassy
   * cues (the box, the tick, the item sparkle) keep full rate, because their
   * whole character is the top octave.
   */
  const half = ac.sampleRate / 2;

  // Two ascending notes, the second ringing on. The interval (a fourth) and
  // the hard 55 ms cut on the first note are the whole identity of a coin.
  out.set(
    "coin",
    bake(ac, 0.42, (d, sr) => {
      let phase = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const second = t >= 0.055;
        const f = second ? 1318.5 : 987.8;
        phase += (2 * Math.PI * f) / sr;
        const s = Math.sin(phase) + 0.4 * Math.sin(2 * phase) + 0.16 * Math.sin(3 * phase);
        const env = second ? percEnv(t - 0.055, 0.002, 0.11) : percEnv(t, 0.001, 0.05);
        d[i] = s * env * 0.5;
      }
      normalize(d, 0.9);
    }, half),
  );

  // Roulette tick: a resonant click. Short enough to machine-gun at 20 Hz
  // without smearing into a buzz.
  out.set(
    "tick",
    bake(ac, 0.05, (d, sr) => {
      const band = svfBand(sr, 9);
      let phase = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        phase += (2 * Math.PI * 1750) / sr;
        const n = band(rnd() * 2 - 1, 2600) * percEnv(t, 0.0004, 0.008);
        d[i] = (n * 1.6 + Math.sin(phase) * percEnv(t, 0.0004, 0.011) * 0.7) * 0.8;
      }
      normalize(d, 0.85);
    }),
  );

  // Item box: glass shatters into a chime. Inharmonic partials up top, a
  // spray of filtered noise underneath, both gone inside a third of a second.
  out.set(
    "pop",
    bake(ac, 0.55, (d, sr) => {
      const partials = [1860, 2510, 3320, 4180, 5560];
      const hp = oneHigh(900, sr);
      const band = svfBand(sr, 2.2);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        let s = 0;
        for (let p = 0; p < partials.length; p++) {
          s += Math.sin(2 * Math.PI * partials[p] * t) * percEnv(t, 0.0015, 0.07 + p * 0.035) * (0.5 / (p + 1));
        }
        const shard = hp(rnd() * 2 - 1) * percEnv(t, 0.001, 0.05) * 0.5;
        const air = band(rnd() * 2 - 1, 3400 - 2000 * Math.min(1, t / 0.3)) * percEnv(t, 0.004, 0.13) * 0.35;
        d[i] = s + shard + air;
      }
      normalize(d, 0.92);
    }),
  );

  // Explosion: pitch-swept body + a band-swept noise front + crackle debris,
  // saturated together so the peak flattens into a wall rather than a spike.
  out.set(
    "explosion",
    bake(ac, 1.45, (d, sr) => {
      const band = svfBand(sr, 1.1);
      const rumble = onePole(160, sr);
      let phase = 0;
      let crackle = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const f = 34 + 210 * Math.exp(-t / 0.075);
        phase += (2 * Math.PI * f) / sr;
        const body = Math.sin(phase) * percEnv(t, 0.002, 0.34) * 1.1;
        const front = band(rnd() * 2 - 1, 140 + 2600 * Math.exp(-t / 0.22)) * percEnv(t, 0.003, 0.42) * 0.9;
        const tail = rumble(rnd() * 2 - 1) * percEnv(t, 0.02, 0.62) * 0.8;
        // Debris: sparse impulses that thin out as the fireball collapses.
        if (rnd() < 0.02 * Math.exp(-t / 0.45)) crackle = (rnd() * 2 - 1) * 0.7;
        crackle *= 0.86;
        d[i] = body + front + tail + crackle * percEnv(t, 0.001, 0.5);
      }
      softClip(d, 1.55);
      normalize(d, 0.98);
    }, half),
  );

  // Shell on wall: hard, hollow, plastic. Two detuned partials and a click.
  out.set(
    "bonk",
    bake(ac, 0.2, (d, sr) => {
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const a = Math.sin(2 * Math.PI * 640 * t) * percEnv(t, 0.0008, 0.035);
        const b = Math.sin(2 * Math.PI * 968 * t) * percEnv(t, 0.0008, 0.02) * 0.6;
        const c = Math.sin(2 * Math.PI * 233 * t) * percEnv(t, 0.001, 0.055) * 0.5;
        const click = (rnd() * 2 - 1) * percEnv(t, 0.0002, 0.003) * 0.5;
        d[i] = a + b + c + click;
      }
      softClip(d, 1.25);
      normalize(d, 0.9);
    }, half),
  );

  // Shell destroyed: the bonk's inharmonic cousin with a shard tail.
  out.set(
    "shatter",
    bake(ac, 0.4, (d, sr) => {
      const hp = oneHigh(1400, sr);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        let s = 0;
        for (const [f, k] of [
          [740, 1],
          [1130, 0.6],
          [1690, 0.4],
          [2470, 0.25],
        ] as const) {
          s += Math.sin(2 * Math.PI * f * t) * percEnv(t, 0.001, 0.06 * k + 0.02) * k * 0.5;
        }
        d[i] = s + hp(rnd() * 2 - 1) * percEnv(t, 0.001, 0.09) * 0.45;
      }
      normalize(d, 0.9);
    }, half),
  );

  // Lightning: a full-band snap, a resonance falling out of it, then thunder.
  out.set(
    "crack",
    bake(ac, 1.25, (d, sr) => {
      const band = svfBand(sr, 5);
      const low = onePole(220, sr);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const n = rnd() * 2 - 1;
        const snap = n * percEnv(t, 0.0004, 0.014) * 1.2;
        const ring = band(n, 260 + 5200 * Math.exp(-t / 0.06)) * percEnv(t, 0.001, 0.19) * 0.8;
        // Thunder swells rather than decays for the first fifth of a second.
        const roll = low(n) * (1 - Math.exp(-t / 0.12)) * Math.exp(-Math.max(0, t - 0.2) / 0.45) * 1.1;
        d[i] = snap + ring + roll;
      }
      softClip(d, 1.4);
      normalize(d, 0.97);
    }, half),
  );

  // Mushroom: a band of noise sweeping up and away, with a pitched core so it
  // reads as power rather than as wind.
  out.set(
    "whoosh",
    bake(ac, 0.8, (d, sr) => {
      const band = svfBand(sr, 3.4);
      let phase = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const u = Math.min(1, t / 0.42);
        const f = 320 + 3000 * Math.sin(u * Math.PI * 0.85);
        phase += (2 * Math.PI * (180 + 620 * u)) / sr;
        const env = Math.sin(Math.min(1, t / 0.6) * Math.PI) ** 1.3;
        d[i] = band(rnd() * 2 - 1, f) * env * 1.2 + Math.sin(phase) * env * 0.22;
      }
      normalize(d, 0.9);
    }, half),
  );

  // Landing / body impact: chest-height thump with a wheel-scuff on top.
  out.set(
    "thud",
    bake(ac, 0.35, (d, sr) => {
      const lp = onePole(700, sr);
      let phase = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const f = 48 + 90 * Math.exp(-t / 0.045);
        phase += (2 * Math.PI * f) / sr;
        d[i] =
          Math.sin(phase) * percEnv(t, 0.002, 0.11) * 1.1 +
          lp(rnd() * 2 - 1) * percEnv(t, 0.003, 0.06) * 0.55;
      }
      softClip(d, 1.2);
      normalize(d, 0.95);
    }, half),
  );

  // Ink / water: wet, dark, and over immediately.
  out.set(
    "splat",
    bake(ac, 0.45, (d, sr) => {
      const band = svfBand(sr, 1.6);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const f = 1400 * Math.exp(-t / 0.06) + 180;
        d[i] = band(rnd() * 2 - 1, f) * percEnv(t, 0.002, 0.12) * 1.3;
      }
      softClip(d, 1.15);
      normalize(d, 0.9);
    }, half),
  );

  // Banana: a comedy tyre chirp that slides down as the kart loses the plot.
  out.set(
    "slip",
    bake(ac, 0.6, (d, sr) => {
      const band = svfBand(sr, 7);
      let phase = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const f = 1050 * Math.exp(-t / 0.3) + 190;
        phase += (2 * Math.PI * f * (1 + 0.04 * Math.sin(2 * Math.PI * 17 * t))) / sr;
        const env = percEnv(t, 0.006, 0.19);
        d[i] = Math.sin(phase) * env * 0.55 + band(rnd() * 2 - 1, f * 1.8) * env * 0.6;
      }
      normalize(d, 0.88);
    }, half),
  );

  // Item acquired: a four-note upward sparkle, all bell partials.
  out.set(
    "sparkle",
    bake(ac, 0.6, (d, sr) => {
      const steps = [0, 0.045, 0.09, 0.135];
      const notes = [1046.5, 1318.5, 1568, 2093];
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        let s = 0;
        for (let k = 0; k < 4; k++) {
          const dt = t - steps[k];
          if (dt < 0) continue;
          const f = notes[k];
          s +=
            (Math.sin(2 * Math.PI * f * dt) + 0.28 * Math.sin(2 * Math.PI * f * 2.01 * dt)) *
            percEnv(dt, 0.002, 0.09 + k * 0.02) *
            0.45;
        }
        d[i] = s;
      }
      normalize(d, 0.9);
    }),
  );

  // Grandstand: a roar that swells, holds, and falls away. Whistles on top
  // are what make a noise bed read as *people*.
  out.set(
    "cheer",
    bake(ac, 2.0, (d, sr) => {
      const band = svfBand(sr, 0.9);
      const body = onePole(1500, sr);
      const swellAt = (t: number): number =>
        (1 - Math.exp(-t / 0.4)) * Math.exp(-Math.max(0, t - 1.1) / 1.0);
      for (let i = 0; i < d.length; i++) {
        const swell = swellAt(i / sr);
        // Two noise colours: a mid roar and a bright wash of applause.
        d[i] = body(rnd() * 2 - 1) * swell * 1.4 + band(rnd() * 2 - 1, 2400) * swell * 0.5;
      }
      // Whistles go in as a second pass over their own short windows — running
      // sixteen of them per sample costs two million sines for no benefit.
      for (let k = 0; k < 16; k++) {
        const at = 0.15 + rnd() * 1.9;
        const f = 1700 + rnd() * 1100;
        const start = Math.floor(at * sr);
        const len = Math.min(d.length - start, Math.floor(0.4 * sr));
        for (let i = 0; i < len; i++) {
          const dt = i / sr;
          d[start + i] +=
            Math.sin(2 * Math.PI * f * dt * (1 + 0.08 * dt)) * percEnv(dt, 0.03, 0.09) * 0.16 * swellAt(at + dt);
        }
      }
      softClip(d, 1.1);
      normalize(d, 0.8);
    }, half),
  );

  // Metal: gantry strike, item block, kerb strike. Bright and inharmonic.
  out.set(
    "clank",
    bake(ac, 0.5, (d, sr) => {
      const partials = [523, 802, 1187, 1601, 2290, 3110];
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        let s = 0;
        for (let p = 0; p < partials.length; p++) {
          s += Math.sin(2 * Math.PI * partials[p] * t) * percEnv(t, 0.0008, 0.16 / (p * 0.6 + 1)) * (0.42 / (p * 0.5 + 1));
        }
        d[i] = s + (rnd() * 2 - 1) * percEnv(t, 0.0003, 0.004) * 0.4;
      }
      softClip(d, 1.15);
      normalize(d, 0.9);
    }, half),
  );

  // A single scrub of rubber — the transient the continuous squeal lacks.
  out.set(
    "skid",
    bake(ac, 0.5, (d, sr) => {
      const band = svfBand(sr, 6.5);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const f = 1500 + 700 * Math.sin(2 * Math.PI * 6 * t) - 500 * Math.min(1, t / 0.4);
        d[i] = band(rnd() * 2 - 1, f) * percEnv(t, 0.02, 0.16) * 1.3;
      }
      normalize(d, 0.85);
    }, half),
  );

  return out;
}

// ---------------------------------------------------------------------------
// Cue table
// ---------------------------------------------------------------------------

/**
 * Alias resolution, in order: an exact program, then this table, then the
 * generic blip. Keys on the left are what other systems actually call.
 */
const ALIAS: Record<string, string> = {
  itemBreak: "shatter",
  shellDestroy: "shatter",
  bananaHit: "bananaSlip",
  bananaSlip: "bananaSlip",
  shellHit: "shellHit",
  blueShellHit: "blueShellHit",
  bobomb: "explosion",
  bomb: "explosion",
  hit: "bump",
  wall: "bump",
  collide: "bump",
  land: "landing",
  jump: "hop",
  trick: "trickSpin",
  boostPad: "boost",
  miniTurbo: "boost",
  mushroomBoost: "mushroom",
  rocketStart: "boost",
  offroad: "kerb",
  countdown: "count",
  go: "countGo",
  lapChime: "lap",
  final: "finalLap",
  fanfare: "finish",
  crowd: "cheer",
  crowdCheer: "cheer",
  applause: "cheer",
  pause: "uiBack",
  unpause: "uiSelect",
  select: "uiSelect",
  move: "uiMove",
  back: "uiBack",
};

export interface Bank {
  play(id: string, o?: PlayOpts): void;
  /** Names the bank knows about — handy from the console. */
  has(id: string): boolean;
  dispose(): void;
}

export function createBank(g: AudioGraph): Bank {
  const baked = bakeSoundBank(g.ac, g.rng);

  /** Fire a baked buffer with per-shot rate jitter so repeats never machine-gun. */
  const shot =
    (id: BakeId, gain: number, jitter = 0.06, wet = 0.12, cost = 2): Program =>
    (gr, t, v, rate, r) => {
      const buf = baked.get(id);
      if (!buf) return;
      budgeted(gr, cost, false, () => {
        playBuffer(gr, {
          ...r,
          t,
          buffer: buf,
          gain: gain * v,
          rate: rate * (1 + (gr.rng() * 2 - 1) * jitter),
          wet: r.wet ?? wet,
        });
      });
    };

  const PROGRAMS: Record<string, Program> = {
    // --- Items: pickup -----------------------------------------------------
    itemBox: shot("pop", 0.85, 0.05, 0.2),
    itemGet: shot("sparkle", 0.6, 0.02, 0.16),
    coin: shot("coin", 0.5, 0.03, 0.14),
    itemTick: shot("tick", 0.32, 0.1, 0.05, 1),

    /** Roulette start — a warble that rises into the tick loop. */
    itemRoulette: (gr, t, v, rate, r) => {
      budgeted(gr, 3, false, () => {
        tone(gr, { ...r, t, f0: 380 * rate, f1: 900 * rate, type: "square", gain: 0.1 * v, attack: 0.01, decay: 0.26, wet: 0.12 });
        tone(gr, { ...r, t, f0: 760 * rate, f1: 1800 * rate, type: "triangle", gain: 0.06 * v, attack: 0.01, decay: 0.24, wet: 0.12 });
      });
    },

    // --- Items: throwing and hitting --------------------------------------
    /** Shell throw: a short air-shear with a pitched core that flies away. */
    itemThrow: (gr, t, v, rate, r) => {
      budgeted(gr, 3, false, () => {
        noiseVoice(gr, { ...r, t, gain: 0.4 * v, filter: "bandpass", f0: 700 * rate, f1: 2600 * rate, q: 2.4, attack: 0.008, decay: 0.18, wet: 0.14 });
        tone(gr, { ...r, t, f0: 460 * rate, f1: 1150 * rate, type: "sawtooth", gain: 0.11 * v, attack: 0.006, decay: 0.16, wet: 0.12 });
      });
    },
    shellBounce: shot("bonk", 0.7, 0.09, 0.18),
    fireballBounce: shot("bonk", 0.4, 0.14, 0.16),
    shellHit: (gr, t, v, rate, r) => {
      shot("bonk", 0.9, 0.05, 0.18)(gr, t, v, rate, r);
      shot("thud", 0.8, 0.05, 0.2)(gr, t + 0.012, v, rate * 0.92, r);
    },
    itemBreak: shot("shatter", 0.6, 0.08, 0.18),
    shellUnlock: (gr, t, v, rate, r) => {
      budgeted(gr, 2, false, () => {
        tone(gr, { ...r, t, f0: 900 * rate, f1: 1500 * rate, type: "triangle", gain: 0.1 * v, attack: 0.004, decay: 0.12, wet: 0.16 });
      });
    },
    starDeflect: (gr, t, v, rate, r) => {
      shot("clank", 0.7, 0.06, 0.24)(gr, t, v, rate * 1.25, r);
      bell(gr, t + 0.02, 1760 * rate, 0.12 * v, 0.3, { ...r, wet: 0.24 });
    },
    itemBlock: shot("clank", 0.6, 0.08, 0.2),

    // --- Items: hazards ----------------------------------------------------
    bananaLand: (gr, t, v, rate, r) => {
      budgeted(gr, 2, false, () => {
        tone(gr, { ...r, t, f0: 220 * rate, f1: 120 * rate, type: "sine", gain: 0.26 * v, attack: 0.003, decay: 0.09, wet: 0.1 });
        noiseVoice(gr, { ...r, t, gain: 0.16 * v, filter: "lowpass", f0: 900, f1: 300, decay: 0.07, wet: 0.08 });
      });
    },
    bananaSlip: shot("slip", 0.75, 0.05, 0.16),
    explosion: (gr, t, v, rate, r) => {
      // Never budget-dropped: an explosion you cannot hear is a lie about the
      // state of the race.
      const buf = baked.get("explosion");
      if (!buf) return;
      budgeted(gr, 3, true, () => {
        playBuffer(gr, { ...r, t, buffer: buf, gain: 0.95 * v, rate: rate * (1 + (gr.rng() * 2 - 1) * 0.07), wet: r.wet ?? 0.3 });
      });
    },
    blueShellLaunch: (gr, t, v, rate, r) => {
      budgeted(gr, 4, true, () => {
        // A siren that climbs: the sound the whole field learns to dread.
        tone(gr, { ...r, t, f0: 300 * rate, f1: 1500 * rate, type: "sawtooth", gain: 0.14 * v, attack: 0.02, sweep: 0.7, decay: 0.8, wet: 0.28 });
        tone(gr, { ...r, t, f0: 452 * rate, f1: 2260 * rate, type: "square", gain: 0.07 * v, attack: 0.03, sweep: 0.7, decay: 0.78, wet: 0.28 });
        noiseVoice(gr, { ...r, t, gain: 0.16 * v, filter: "bandpass", f0: 1200, f1: 4200, q: 1.6, attack: 0.05, decay: 0.7, wet: 0.3 });
      });
    },
    blueShellHit: (gr, t, v, rate, r) => {
      PROGRAMS.explosion(gr, t, v, rate * 0.8, r);
      budgeted(gr, 3, true, () => {
        noiseVoice(gr, { ...r, t: t + 0.03, gain: 0.3 * v, filter: "highpass", f0: 3000, f1: 800, decay: 0.5, wet: 0.34 });
      });
    },
    lightning: (gr, t, v, rate, r) => {
      const buf = baked.get("crack");
      if (!buf) return;
      budgeted(gr, 3, true, () => {
        playBuffer(gr, { ...r, t, buffer: buf, gain: 0.95 * v, rate, wet: r.wet ?? 0.35 });
      });
    },
    inkSplat: shot("splat", 0.85, 0.05, 0.18),
    blooper: (gr, t, v, rate, r) => {
      budgeted(gr, 3, false, () => {
        // A squelchy descending burble.
        tone(gr, { ...r, t, f0: 640 * rate, f1: 180 * rate, type: "triangle", gain: 0.14 * v, attack: 0.01, decay: 0.34, wet: 0.2 });
        noiseVoice(gr, { ...r, t, gain: 0.12 * v, filter: "bandpass", f0: 1800, f1: 400, q: 3, decay: 0.3, wet: 0.2 });
      });
    },
    fireball: (gr, t, v, rate, r) => {
      budgeted(gr, 2, false, () => {
        noiseVoice(gr, { ...r, t, gain: 0.28 * v, filter: "bandpass", f0: 2400 * rate, f1: 700 * rate, q: 1.4, attack: 0.004, decay: 0.16, wet: 0.16 });
        tone(gr, { ...r, t, f0: 380 * rate, f1: 160 * rate, type: "sawtooth", gain: 0.07 * v, decay: 0.14, wet: 0.14 });
      });
    },
    itemSteal: (gr, t, v, rate, r) => {
      budgeted(gr, 3, false, () => {
        // Downward glissando: something of yours just left.
        tone(gr, { ...r, t, f0: 1400 * rate, f1: 340 * rate, type: "triangle", gain: 0.1 * v, attack: 0.005, decay: 0.3, wet: 0.22 });
        noiseVoice(gr, { ...r, t, gain: 0.1 * v, filter: "bandpass", f0: 3000, f1: 600, q: 2, decay: 0.28, wet: 0.2 });
      });
    },

    // --- Items: power-ups --------------------------------------------------
    mushroom: (gr, t, v, rate, r) => {
      shot("whoosh", 0.8, 0.04, 0.18)(gr, t, v, rate, r);
      budgeted(gr, 2, false, () => {
        tone(gr, { ...r, t, f0: 300 * rate, f1: 760 * rate, type: "square", gain: 0.07 * v, attack: 0.01, sweep: 0.25, decay: 0.3, wet: 0.16 });
      });
    },
    boost: (gr, t, v, rate, r) => {
      budgeted(gr, 3, false, () => {
        // Mini-turbo: a bright chirp riding a short blast of air.
        noiseVoice(gr, { ...r, t, gain: 0.3 * v, filter: "bandpass", f0: 900 * rate, f1: 3400 * rate, q: 1.8, attack: 0.005, decay: 0.24, wet: 0.16 });
        tone(gr, { ...r, t, f0: 520 * rate, f1: 1560 * rate, type: "sawtooth", gain: 0.1 * v, attack: 0.004, sweep: 0.16, decay: 0.22, wet: 0.14 });
      });
    },
    star: (gr, t, v, rate, r) => {
      // The pickup flourish; the invincibility loop itself lives in music.ts.
      const notes = [0, 4, 7, 12, 16, 19];
      budgeted(gr, 4, true, () => {
        for (let i = 0; i < notes.length; i++) {
          tone(gr, {
            ...r,
            t: t + i * 0.045,
            f0: noteHz(72 + notes[i]) * rate,
            type: "square",
            gain: 0.075 * v,
            attack: 0.004,
            decay: 0.16,
            wet: 0.24,
          });
        }
      });
    },
    boo: (gr, t, v, rate, r) => {
      budgeted(gr, 3, false, () => {
        // Wobbling, hollow, slightly seasick.
        tone(gr, { ...r, t, f0: 520 * rate, f1: 240 * rate, type: "sine", gain: 0.13 * v, attack: 0.05, sweep: 0.5, decay: 0.6, wet: 0.4 });
        tone(gr, { ...r, t: t + 0.06, f0: 392 * rate, f1: 196 * rate, type: "triangle", gain: 0.08 * v, attack: 0.06, sweep: 0.5, decay: 0.55, wet: 0.42 });
      });
    },
    booEnd: (gr, t, v, rate, r) => {
      budgeted(gr, 2, false, () => {
        tone(gr, { ...r, t, f0: 260 * rate, f1: 720 * rate, type: "sine", gain: 0.1 * v, attack: 0.02, decay: 0.28, wet: 0.3 });
      });
    },
    bulletStart: (gr, t, v, rate, r) => {
      budgeted(gr, 4, true, () => {
        tone(gr, { ...r, t, f0: 180 * rate, f1: 900 * rate, type: "sawtooth", gain: 0.13 * v, attack: 0.03, sweep: 0.3, decay: 0.5, wet: 0.2 });
        noiseVoice(gr, { ...r, t, gain: 0.34 * v, filter: "bandpass", f0: 500, f1: 4000, q: 1.2, attack: 0.04, decay: 0.45, wet: 0.22 });
      });
    },
    bulletEnd: (gr, t, v, rate, r) => {
      budgeted(gr, 2, false, () => {
        noiseVoice(gr, { ...r, t, gain: 0.24 * v, filter: "bandpass", f0: 3200, f1: 500, q: 1.2, attack: 0.01, decay: 0.35, wet: 0.2 });
      });
    },

    // --- Driving -----------------------------------------------------------
    hop: (gr, t, v, rate, r) => {
      budgeted(gr, 2, false, () => {
        tone(gr, { ...r, t, f0: 300 * rate, f1: 620 * rate, type: "sine", gain: 0.12 * v, attack: 0.002, sweep: 0.05, decay: 0.09, wet: 0.08 });
        noiseVoice(gr, { ...r, t, gain: 0.1 * v, filter: "highpass", f0: 1800, decay: 0.05, wet: 0.06 });
      });
    },
    landing: (gr, t, v, rate, r) => {
      shot("thud", 0.85, 0.06, 0.14)(gr, t, v, rate, r);
      if (v > 0.6) shot("skid", 0.35, 0.1, 0.12)(gr, t + 0.02, v * 0.6, rate, r);
    },
    bump: (gr, t, v, rate, r) => {
      shot("thud", 0.7, 0.08, 0.16)(gr, t, v, rate * 1.15, r);
      budgeted(gr, 2, false, () => {
        noiseVoice(gr, { ...r, t, gain: 0.16 * v, filter: "bandpass", f0: 1400, f1: 400, q: 1.2, decay: 0.08, wet: 0.12 });
      });
    },
    spinOut: (gr, t, v, rate, r) => {
      shot("skid", 0.7, 0.06, 0.16)(gr, t, v, rate * 0.9, r);
      budgeted(gr, 3, false, () => {
        // The dizzy wobble under a spin-out.
        tone(gr, { ...r, t, f0: 700 * rate, f1: 300 * rate, type: "triangle", gain: 0.09 * v, attack: 0.01, decay: 0.5, wet: 0.2 });
      });
    },
    respawn: (gr, t, v, rate, r) => {
      budgeted(gr, 3, false, () => {
        // Lakitu drops you back in: a rising whirr and a settle.
        tone(gr, { ...r, t, f0: 200 * rate, f1: 620 * rate, type: "triangle", gain: 0.1 * v, attack: 0.03, sweep: 0.4, decay: 0.45, wet: 0.24 });
        tone(gr, { ...r, t: t + 0.42, f0: 880 * rate, type: "sine", gain: 0.09 * v, attack: 0.004, decay: 0.2, wet: 0.22 });
      });
    },
    kerb: (gr, t, v, rate, r) => {
      budgeted(gr, 1, false, () => {
        noiseVoice(gr, { ...r, t, gain: 0.2 * v, filter: "bandpass", f0: 260 * rate, q: 1.6, attack: 0.001, decay: 0.035, wet: 0.06 });
      });
    },
    trickSpin: (gr, t, v, rate, r) => {
      budgeted(gr, 3, false, () => {
        noiseVoice(gr, { ...r, t, gain: 0.2 * v, filter: "bandpass", f0: 600, f1: 2600, q: 2.2, attack: 0.02, decay: 0.22, wet: 0.16 });
        tone(gr, { ...r, t, f0: 620 * rate, f1: 1240 * rate, type: "triangle", gain: 0.07 * v, attack: 0.01, decay: 0.2, wet: 0.18 });
      });
    },
    horn: (gr, t, v, rate, r) => {
      budgeted(gr, 3, false, () => {
        // Two-tone parp — a minor third apart, like every small car ever made.
        for (const [f, k] of [
          [392, 1],
          [466, 0.7],
        ] as const) {
          tone(gr, { ...r, t, f0: f * rate, type: "sawtooth", gain: 0.09 * v * k, attack: 0.012, hold: 0.16, decay: 0.09, wet: 0.16 });
        }
      });
    },

    // --- Race furniture ----------------------------------------------------
    /** Countdown: three low beeps and one high one. `rate` picks the pitch. */
    count: (gr, t, v, rate, r) => {
      budgeted(gr, 3, true, () => {
        tone(gr, { ...r, t, f0: 440 * rate, type: "square", gain: 0.1 * v, attack: 0.004, hold: 0.1, decay: 0.14, wet: 0.2 });
        tone(gr, { ...r, t, f0: 880 * rate, type: "sine", gain: 0.05 * v, attack: 0.004, hold: 0.08, decay: 0.12, wet: 0.2 });
      });
    },
    countGo: (gr, t, v, rate, r) => {
      budgeted(gr, 5, true, () => {
        for (const [f, k, d] of [
          [880, 1, 0.5],
          [1320, 0.6, 0.45],
          [1760, 0.35, 0.4],
        ] as const) {
          tone(gr, { ...r, t, f0: f * rate, type: "square", gain: 0.09 * v * k, attack: 0.004, hold: 0.12, decay: d, wet: 0.26 });
        }
      });
    },
    lap: (gr, t, v, rate, r) => {
      budgeted(gr, 4, true, () => {
        // Perfect fifth, struck twice — unmistakable over an engine.
        bell(gr, t, 1174.7 * rate, 0.11 * v, 0.6, { ...r, wet: 0.3 });
        bell(gr, t + 0.13, 1760 * rate, 0.1 * v, 0.8, { ...r, wet: 0.32 });
      });
    },
    finalLap: (gr, t, v, rate, r) => {
      budgeted(gr, 6, true, () => {
        // Three rising stabs: the "get on with it" motif.
        const notes = [76, 79, 84];
        for (let i = 0; i < notes.length; i++) {
          const at = t + i * 0.15;
          tone(gr, { ...r, t: at, f0: noteHz(notes[i]) * rate, type: "square", gain: 0.09 * v, attack: 0.005, hold: 0.07, decay: 0.2, wet: 0.24 });
          tone(gr, { ...r, t: at, f0: noteHz(notes[i] - 12) * rate, type: "sawtooth", gain: 0.05 * v, attack: 0.005, hold: 0.07, decay: 0.18, wet: 0.2 });
        }
      });
    },
    finish: (gr, t, v, rate, r) => {
      budgeted(gr, 10, true, () => {
        // A two-bar tonic fanfare in C: I–V–I with a triad landing.
        const line: Array<[number, number, number]> = [
          [0, 72, 0.12],
          [0.12, 76, 0.12],
          [0.24, 79, 0.12],
          [0.36, 84, 0.34],
          [0.72, 83, 0.16],
          [0.88, 84, 0.7],
        ];
        for (const [dt, n, dur] of line) {
          tone(gr, { ...r, t: t + dt, f0: noteHz(n) * rate, type: "square", gain: 0.085 * v, attack: 0.006, hold: dur * 0.5, decay: dur, wet: 0.3 });
          tone(gr, { ...r, t: t + dt, f0: noteHz(n - 12) * rate, type: "sawtooth", gain: 0.045 * v, attack: 0.006, hold: dur * 0.5, decay: dur, wet: 0.24 });
        }
        for (const n of [60, 64, 67, 72]) {
          tone(gr, { ...r, t: t + 0.88, f0: noteHz(n) * rate, type: "triangle", gain: 0.05 * v, attack: 0.02, hold: 0.5, decay: 0.9, wet: 0.34 });
        }
      });
    },
    cheer: (gr, t, v, rate, r) => {
      const buf = baked.get("cheer");
      if (!buf) return;
      budgeted(gr, 2, false, () => {
        playBuffer(gr, { ...r, t, buffer: buf, gain: 0.5 * v, rate: rate * (0.94 + gr.rng() * 0.12), wet: r.wet ?? 0.4 });
      });
    },

    // --- UI ----------------------------------------------------------------
    uiMove: (gr, t, v, rate, r) => {
      budgeted(gr, 1, false, () => {
        tone(gr, { ...r, t, f0: 880 * rate, type: "triangle", gain: 0.06 * v, attack: 0.002, decay: 0.06, wet: 0.1 });
      });
    },
    uiSelect: (gr, t, v, rate, r) => {
      budgeted(gr, 2, false, () => {
        tone(gr, { ...r, t, f0: 660 * rate, type: "square", gain: 0.06 * v, attack: 0.002, decay: 0.07, wet: 0.12 });
        tone(gr, { ...r, t: t + 0.06, f0: 990 * rate, type: "square", gain: 0.05 * v, attack: 0.002, decay: 0.12, wet: 0.14 });
      });
    },
    uiBack: (gr, t, v, rate, r) => {
      budgeted(gr, 2, false, () => {
        tone(gr, { ...r, t, f0: 520 * rate, f1: 330 * rate, type: "triangle", gain: 0.06 * v, attack: 0.002, decay: 0.12, wet: 0.12 });
      });
    },

    /** Last resort. Something happened; the player should hear *something*. */
    blip: (gr, t, v, rate, r) => {
      budgeted(gr, 1, false, () => {
        tone(gr, { ...r, t, f0: 620 * rate, type: "triangle", gain: 0.05 * v, attack: 0.003, decay: 0.09, wet: 0.1 });
      });
    },
  };

  function resolve(id: string): Program {
    const direct = PROGRAMS[id];
    if (direct) return direct;
    const alias = ALIAS[id];
    if (alias && PROGRAMS[alias]) return PROGRAMS[alias];
    return PROGRAMS.blip;
  }

  return {
    play(id, o) {
      const ac = g.ac;
      if (ac.state !== "running") return; // suspended: shots would pile on one instant
      const t = Math.max(o?.t ?? 0, ac.currentTime + AHEAD);
      const v = clamp(o?.volume ?? 1, 0, 4);
      if (v <= 0.001) return;
      const rate = clamp(o?.rate ?? 1, 0.25, 4);
      resolve(id)(g, t, v, rate, { at: o?.at ?? null });
    },
    has(id) {
      return !!PROGRAMS[id] || !!ALIAS[id];
    },
    dispose() {
      baked.clear();
    },
  };
}
