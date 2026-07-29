/**
 * audio/vehicleSounds.ts — engines, tyres, sirens, rotors.
 *
 * The engine model is the reason this file is long. A car engine is not a
 * looped sample pitched up and down; it is a *pulse train*. A four-stroke V8 at
 * 3000 rpm fires 200 times a second, and everything you recognise about how an
 * engine sounds comes from that train and what the exhaust does to it:
 *
 *   firing frequency = rpm / 60 × cylinders / 2
 *
 * So the core of every engine voice here is a one-cycle firing pulse, baked
 * once per engine type, looped, and driven purely by playback rate. On top of
 * that:
 *
 *   - a **harmonic stack** of detuned saws at the firing frequency and its
 *     multiples, which fills in the tone between pulses;
 *   - an **induction** noise layer that opens with throttle — the sound of air
 *     going in, which is most of what "load" means to your ear;
 *   - a **waveshaper** whose drive tracks load, because an engine under load is
 *     nonlinear and an engine coasting is not;
 *   - **turbo whine**, a pair of high partials at ~14× firing frequency that
 *     spool with boost and blow off on lift;
 *   - **overrun burble**, randomised pops scheduled while the throttle is shut
 *     and the revs are still up — unburnt fuel igniting in a hot exhaust. It is
 *     the single most satisfying detail in car audio and almost nobody does it.
 *
 * Everything else — tyre roll over the surface type, skid squeal, suspension
 * knock, sirens, helicopter blade slap — hangs off the same per-vehicle voice
 * so a car is one pooled spatial voice, not nine.
 *
 * Public API
 * ----------
 *   vehicleAudio.acquire(id, spec) / release(id) / update(dt) / stopAll()
 *   VehicleAudioState — what you feed it each frame
 *   ENGINE_SPECS / engineSpec(kind)
 *   VehicleVoice / HelicopterVoice
 *   setSiren(id, mode)
 */
import { clamp, clamp01, makeRng, type Rng } from "../math/rng";
import { audioEngine } from "./engine";
import { Voice, voicePool, scratchOptions, distanceTo, type VoiceOptions } from "./spatial";
import {
  MODAL_LIBRARY,
  bakeSync,
  dcBlock,
  edgeFade,
  fillNoise,
  noiseBuffer,
  normalize,
  percEnv,
  renderModal,
  saturator,
  waveshaperCurve,
  type ModalSpec,
} from "./synth";

/* ================================================================== *
 * Specs
 * ================================================================== */

export type VehicleKind =
  | "sedan"
  | "sports"
  | "muscle"
  | "truck"
  | "bus"
  | "police"
  | "motorcycle"
  | "electric"
  | "helicopter";

export interface EngineSpec {
  kind: VehicleKind;
  cylinders: number;
  /** Four-stroke unless stated; two-stroke doubles the firing rate. */
  strokes: 2 | 4;
  idleRpm: number;
  maxRpm: number;
  /** Overall level. */
  level: number;
  /** How much low end the exhaust adds, 0..2. */
  exhaust: number;
  /** Turbo presence, 0..1. */
  turbo: number;
  /** Nonlinearity under load, 0..1. */
  grit: number;
  /** Brightness of the firing pulse, Hz. */
  pulseTone: number;
  /** Length of the firing pulse relative to the cycle, 0..1. */
  pulseWidth: number;
  /** Audible radius, metres. */
  loudness: number;
  /** Electric drivetrains replace the pulse train with an inverter whine. */
  electric?: boolean;
  /** Overrun burble intensity, 0..1. */
  burble: number;
  /** Rotor blade count, helicopters only. */
  blades?: number;
  /** Rotor rev/min, helicopters only. */
  rotorRpm?: number;
}

export const ENGINE_SPECS: Record<VehicleKind, EngineSpec> = {
  sedan: {
    kind: "sedan",
    cylinders: 4,
    strokes: 4,
    idleRpm: 780,
    maxRpm: 6200,
    level: 0.55,
    exhaust: 0.7,
    turbo: 0.15,
    grit: 0.3,
    pulseTone: 2600,
    pulseWidth: 0.3,
    loudness: 140,
    burble: 0.1,
  },
  sports: {
    kind: "sports",
    cylinders: 6,
    strokes: 4,
    idleRpm: 900,
    maxRpm: 8200,
    level: 0.72,
    exhaust: 1.0,
    turbo: 0.55,
    grit: 0.55,
    pulseTone: 3800,
    pulseWidth: 0.22,
    loudness: 220,
    burble: 0.65,
  },
  muscle: {
    kind: "muscle",
    cylinders: 8,
    strokes: 4,
    idleRpm: 700,
    maxRpm: 6000,
    level: 0.85,
    exhaust: 1.5,
    turbo: 0,
    grit: 0.7,
    pulseTone: 2200,
    pulseWidth: 0.36,
    loudness: 260,
    burble: 0.45,
  },
  truck: {
    kind: "truck",
    cylinders: 6,
    strokes: 4,
    idleRpm: 620,
    maxRpm: 3200,
    level: 0.8,
    exhaust: 1.3,
    turbo: 0.75,
    grit: 0.6,
    pulseTone: 1500,
    pulseWidth: 0.45,
    loudness: 240,
    burble: 0.05,
  },
  bus: {
    kind: "bus",
    cylinders: 6,
    strokes: 4,
    idleRpm: 560,
    maxRpm: 2600,
    level: 0.78,
    exhaust: 1.2,
    turbo: 0.6,
    grit: 0.5,
    pulseTone: 1200,
    pulseWidth: 0.5,
    loudness: 230,
    burble: 0.02,
  },
  police: {
    kind: "police",
    cylinders: 8,
    strokes: 4,
    idleRpm: 760,
    maxRpm: 6600,
    level: 0.75,
    exhaust: 1.1,
    turbo: 0.2,
    grit: 0.6,
    pulseTone: 2500,
    pulseWidth: 0.32,
    loudness: 250,
    burble: 0.25,
  },
  motorcycle: {
    kind: "motorcycle",
    cylinders: 2,
    strokes: 4,
    idleRpm: 1100,
    maxRpm: 11000,
    level: 0.7,
    exhaust: 0.9,
    turbo: 0,
    grit: 0.8,
    pulseTone: 4600,
    pulseWidth: 0.18,
    loudness: 230,
    burble: 0.55,
  },
  electric: {
    kind: "electric",
    cylinders: 1,
    strokes: 4,
    idleRpm: 0,
    maxRpm: 16000,
    level: 0.42,
    exhaust: 0.1,
    turbo: 0,
    grit: 0.1,
    pulseTone: 6000,
    pulseWidth: 0.5,
    loudness: 90,
    electric: true,
    burble: 0,
  },
  helicopter: {
    kind: "helicopter",
    cylinders: 1,
    strokes: 4,
    idleRpm: 0,
    maxRpm: 1,
    level: 0.95,
    exhaust: 0,
    turbo: 1,
    grit: 0.4,
    pulseTone: 900,
    pulseWidth: 0.35,
    loudness: 900,
    blades: 2,
    rotorRpm: 324,
    burble: 0,
  },
};

export function engineSpec(kind: VehicleKind): EngineSpec {
  return ENGINE_SPECS[kind] ?? ENGINE_SPECS.sedan;
}

/* ================================================================== *
 * Per-frame state the game feeds in
 * ================================================================== */

export type RoadSurface = "asphalt" | "concrete" | "gravel" | "dirt" | "grass" | "sand" | "water" | "metal";

export interface VehicleAudioState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Engine speed. */
  rpm: number;
  /** 0..1 */
  throttle: number;
  /** 0..1 — how hard the engine is working (grade, mass, gear). */
  load: number;
  /** Current gear index; a change triggers the shift treatment. */
  gear: number;
  /** Ground speed, m/s. */
  speed: number;
  surface: RoadSurface;
  /** 0..1 longitudinal + lateral slip; drives the skid layer. */
  slip: number;
  grounded: boolean;
  /** Suspension compression impulse this frame, 0..1. Fires a knock. */
  suspension?: number;
  /** Facing, for the exhaust cone. */
  fx?: number;
  fy?: number;
  fz?: number;
  /** Collision impulse this frame, 0..1. */
  impact?: number;
  /** Helicopter collective, 0..1. */
  collective?: number;
}

/* ================================================================== *
 * Baked assets
 * ================================================================== */

/** Base firing frequency the pulse buffer is authored at. */
const PULSE_BASE_HZ = 50;

/**
 * One combustion cycle.
 *
 * Sharp rise, fast decay, a little ringing from the exhaust header, then
 * silence until the next cylinder. Looping this at playback rate `f/50` gives
 * a pulse train at exactly `f` Hz with none of the phase-drift artefacts you
 * get from summing oscillators.
 */
function renderFiringPulse(out: Float32Array, sr: number, spec: EngineSpec, rng: Rng): void {
  const n = out.length;
  out.fill(0);
  const pulseN = Math.max(4, Math.round(n * spec.pulseWidth));

  for (let i = 0; i < pulseN; i++) {
    const t = i / sr;
    const u = i / pulseN;
    // Asymmetric: fast attack, slower release. Symmetric pulses sound like
    // a square wave, which is exactly what an engine does not sound like.
    const env = Math.pow(1 - u, 2.2) * Math.min(1, u / 0.02 + 0.02);
    // The pulse's own tone: a decaying sine at the header resonance plus grit.
    const f = spec.pulseTone * (0.6 + 0.4 * Math.exp(-t * 400));
    out[i] = (Math.sin(2 * Math.PI * f * t) * 0.55 + (rng.next() * 2 - 1) * 0.45) * env;
  }

  // Exhaust cavity: a low resonance that rings past the pulse itself. This is
  // what makes a V8 sound like a pipe and a moped sound like a can.
  {
    const w = (2 * Math.PI * 90) / sr;
    const r = Math.pow(10, -3 / (0.06 * sr));
    const c1 = 2 * r * Math.cos(w);
    const c2 = -r * r;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < n; i++) {
      const y = out[i] * (1 - r) + c1 * y1 + c2 * y2;
      y2 = y1;
      y1 = y;
      out[i] += y * spec.exhaust * 3.2;
    }
  }

  dcBlock(out, sr, 25);
  normalize(out, 0.9);
  // No edge fade at the loop point beyond a couple of samples: the buffer must
  // butt-join seamlessly or the loop itself becomes an audible click at the
  // firing rate.
  const g = Math.min(3, n >> 2);
  for (let i = 0; i < g; i++) {
    out[i] *= i / g;
    out[n - 1 - i] *= i / g;
  }
}

function firingBuffer(spec: EngineSpec): AudioBuffer | null {
  const ctx = audioEngine.ctx;
  if (!ctx) return null;
  return bakeSync(ctx, `engine:pulse:${spec.kind}`, 1 / PULSE_BASE_HZ, 1, (ch, sr, rng) =>
    renderFiringPulse(ch[0], sr, spec, rng),
  );
}

/** Base blade-pass frequency the rotor buffer is authored at. */
const ROTOR_BASE_HZ = 11;

/**
 * One rotor blade passing.
 *
 * The characteristic "whop" is blade-vortex interaction: a sharp compression
 * pulse with a long low tail, roughly 8 % of the blade period. Two-bladed
 * rotors (Huey, Bell 206) slap; four-bladed rotors are much smoother, which
 * falls out of this automatically once the pass frequency doubles.
 */
function renderRotorSlap(out: Float32Array, sr: number, rng: Rng): void {
  const n = out.length;
  out.fill(0);
  const slapN = Math.max(8, Math.round(n * 0.16));
  for (let i = 0; i < slapN; i++) {
    const u = i / slapN;
    const t = i / sr;
    const env = Math.pow(1 - u, 1.8) * Math.min(1, u / 0.05);
    const f = 62 * (1 + 1.6 * Math.exp(-t * 120));
    out[i] = (Math.sin(2 * Math.PI * f * t) * 0.8 + (rng.next() * 2 - 1) * 0.35) * env;
  }
  // Air being displaced for the rest of the revolution — never silent.
  for (let i = 0; i < n; i++) out[i] += (rng.next() * 2 - 1) * 0.09;
  dcBlock(out, sr, 18);
  normalize(out, 0.92);
  const g = Math.min(4, n >> 2);
  for (let i = 0; i < g; i++) {
    out[i] *= i / g;
    out[n - 1 - i] *= i / g;
  }
}

function rotorBuffer(): AudioBuffer | null {
  const ctx = audioEngine.ctx;
  if (!ctx) return null;
  return bakeSync(ctx, "heli:slap", 1 / ROTOR_BASE_HZ, 1, (ch, sr, rng) =>
    renderRotorSlap(ch[0], sr, rng),
  );
}

/** Surface roughness: centre frequency, bandwidth and level of the tyre bed. */
const SURFACE_TYRE: Record<RoadSurface, { f: number; q: number; gain: number; grain: number }> = {
  asphalt: { f: 900, q: 0.55, gain: 1, grain: 0.15 },
  concrete: { f: 1300, q: 0.7, gain: 0.95, grain: 0.25 },
  gravel: { f: 2200, q: 0.4, gain: 1.35, grain: 1 },
  dirt: { f: 620, q: 0.5, gain: 0.9, grain: 0.6 },
  grass: { f: 480, q: 0.6, gain: 0.6, grain: 0.45 },
  sand: { f: 1700, q: 0.35, gain: 0.75, grain: 0.8 },
  water: { f: 700, q: 0.45, gain: 1.2, grain: 0.55 },
  metal: { f: 2600, q: 1.4, gain: 1.1, grain: 0.2 },
};

/* ================================================================== *
 * Vehicle voice
 * ================================================================== */

const shiftSpec: ModalSpec = {
  ...MODAL_LIBRARY.metal,
  modes: MODAL_LIBRARY.metal.modes.map((m) => ({ f: m.f * 0.7, decay: m.decay * 0.18, gain: m.gain })),
};

function shiftBuffer(): AudioBuffer | null {
  const ctx = audioEngine.ctx;
  if (!ctx) return null;
  return bakeSync(ctx, "vehicle:shift", 0.22, 1, (ch, sr, rng) => {
    renderModal(ch[0], sr, shiftSpec, rng);
    normalize(ch[0], 0.8);
    edgeFade(ch[0], sr, 0.3, 8);
  });
}

function knockBuffer(): AudioBuffer | null {
  const ctx = audioEngine.ctx;
  if (!ctx) return null;
  return bakeSync(ctx, "vehicle:knock", 0.3, 1, (ch, sr, rng) => {
    renderModal(
      ch[0],
      sr,
      {
        ...MODAL_LIBRARY.rubber,
        modes: [
          { f: 74, decay: 0.09, gain: 1 },
          { f: 160, decay: 0.06, gain: 0.5 },
          { f: 340, decay: 0.03, gain: 0.25 },
        ],
        noise: 0.6,
        exciter: 0.004,
      },
      rng,
    );
    normalize(ch[0], 0.9);
    edgeFade(ch[0], sr, 0.5, 10);
  });
}

function crashBuffer(): AudioBuffer | null {
  const ctx = audioEngine.ctx;
  if (!ctx) return null;
  return bakeSync(ctx, "vehicle:crash", 0.9, 1, (ch, sr, rng) => {
    const n = ch[0].length;
    const tmp = new Float32Array(n);
    // Panel deformation: a cluster of sheet-metal strikes over 120 ms plus
    // glass. A single impact reads as a hammer; a cluster reads as a car.
    for (let k = 0; k < 7; k++) {
      const t = rng.range(0, 0.14);
      const off = Math.round(t * sr);
      const len = Math.min(n - off, Math.round(sr * 0.5));
      if (len <= 16) continue;
      const mat = k % 3 === 2 ? MODAL_LIBRARY.glass : MODAL_LIBRARY.thinMetal;
      renderModal(
        tmp.subarray(0, len),
        sr,
        {
          ...mat,
          modes: mat.modes.map((m) => ({
            f: m.f * rng.range(0.6, 1.6),
            decay: m.decay * rng.range(0.15, 0.5),
            gain: m.gain,
          })),
        },
        rng,
      );
      const g = rng.range(0.3, 1) * (1 - k * 0.08);
      for (let i = 0; i < len; i++) ch[0][off + i] += tmp[i] * g;
    }
    dcBlock(ch[0], sr, 30);
    normalize(ch[0], 0.95);
    edgeFade(ch[0], sr, 0.3, 30);
  });
}

export type SirenMode = "off" | "wail" | "yelp" | "hilo" | "phaser";

/**
 * One vehicle's complete audio: engine, tyres, skid, suspension, siren.
 *
 * Node count is fixed at construction. Nothing is created or destroyed while
 * the vehicle is alive, so a chase with eight cars is eight stable graphs and
 * zero garbage.
 */
export class VehicleVoice {
  readonly id: number;
  readonly spec: EngineSpec;
  private voice: Voice | null = null;
  private ctx: AudioContext;

  /* engine */
  private pulse: AudioBufferSourceNode | null = null;
  private pulseGain: GainNode;
  private harm: OscillatorNode[] = [];
  private harmGain: GainNode[] = [];
  private harmMix: GainNode;
  private induction: AudioBufferSourceNode | null = null;
  private inductionBp: BiquadFilterNode;
  private inductionGain: GainNode;
  private turboA: OscillatorNode | null = null;
  private turboB: OscillatorNode | null = null;
  private turboGain: GainNode;
  private drive: WaveShaperNode;
  private engineLp: BiquadFilterNode;
  private engineGain: GainNode;

  /* tyres */
  private tyreSrc: AudioBufferSourceNode | null = null;
  private tyreBp: BiquadFilterNode;
  private tyreGain: GainNode;

  /* skid */
  private skidSrc: AudioBufferSourceNode | null = null;
  private skidBpA: BiquadFilterNode;
  private skidBpB: BiquadFilterNode;
  private skidGain: GainNode;
  private skidLfo: OscillatorNode | null = null;
  private skidLfoGain: GainNode;

  /* siren */
  private sirenOsc: OscillatorNode | null = null;
  private sirenSub: OscillatorNode | null = null;
  private sirenLfo: OscillatorNode | null = null;
  private sirenLfoGain: GainNode;
  private sirenGain: GainNode;
  private sirenMode: SirenMode = "off";
  private sirenPhase = 0;

  private started = false;
  private lastGear = 0;
  private burbleNext = 0;
  private rng: Rng;
  private smoothRpm: number;
  private disposed = false;

  constructor(id: number, spec: EngineSpec, ctx: AudioContext) {
    this.id = id;
    this.spec = spec;
    this.ctx = ctx;
    this.rng = makeRng(`sf-audio:vehicle:${id}`);
    this.smoothRpm = spec.idleRpm;

    this.pulseGain = ctx.createGain();
    this.pulseGain.gain.value = 0;
    this.harmMix = ctx.createGain();
    this.harmMix.gain.value = 0;
    this.inductionBp = ctx.createBiquadFilter();
    this.inductionBp.type = "bandpass";
    this.inductionBp.frequency.value = 900;
    this.inductionBp.Q.value = 0.8;
    this.inductionGain = ctx.createGain();
    this.inductionGain.gain.value = 0;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;

    this.drive = saturator(ctx, spec.grit * 0.5, "asym");
    this.engineLp = ctx.createBiquadFilter();
    this.engineLp.type = "lowpass";
    this.engineLp.frequency.value = 1200;
    this.engineLp.Q.value = 0.6;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = spec.level;

    this.pulseGain.connect(this.drive);
    this.harmMix.connect(this.drive);
    this.inductionGain.connect(this.drive);
    this.drive.connect(this.engineLp);
    this.engineLp.connect(this.engineGain);
    this.turboGain.connect(this.engineGain); // turbo bypasses the drive stage

    this.tyreBp = ctx.createBiquadFilter();
    this.tyreBp.type = "bandpass";
    this.tyreBp.frequency.value = 900;
    this.tyreBp.Q.value = 0.55;
    this.tyreGain = ctx.createGain();
    this.tyreGain.gain.value = 0;
    this.tyreBp.connect(this.tyreGain);

    this.skidBpA = ctx.createBiquadFilter();
    this.skidBpA.type = "bandpass";
    this.skidBpA.frequency.value = 1150;
    this.skidBpA.Q.value = 9;
    this.skidBpB = ctx.createBiquadFilter();
    this.skidBpB.type = "bandpass";
    this.skidBpB.frequency.value = 2450;
    this.skidBpB.Q.value = 12;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    this.skidBpA.connect(this.skidGain);
    this.skidBpB.connect(this.skidGain);
    this.skidLfoGain = ctx.createGain();
    this.skidLfoGain.gain.value = 180;

    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenLfoGain = ctx.createGain();
    this.sirenLfoGain.gain.value = 260;
  }

  /** Attach to a pooled spatial voice and start every continuous source. */
  private start(state: VehicleAudioState): boolean {
    if (this.started || this.disposed) return this.started;
    const ctx = this.ctx;

    const o = scratchOptions as VoiceOptions;
    o.x = state.x;
    o.y = state.y;
    o.z = state.z;
    o.vx = state.vx;
    o.vy = state.vy;
    o.vz = state.vz;
    o.bus = "vehicles";
    o.local = false;
    o.gain = 1;
    o.pitch = 1;
    o.priority = 0.7;
    o.loudness = this.spec.loudness;
    o.propagate = false;
    o.noOcclusion = false;
    o.when = undefined;
    o.duration = 1e9;
    const v = voicePool.acquire(o);
    o.duration = undefined;
    if (!v) return false;
    v.hold = true; // engines are never stolen mid-note
    v.onSteal = () => this.stop();
    this.voice = v;

    this.engineGain.connect(v.input);
    this.tyreGain.connect(v.input);
    this.skidGain.connect(v.input);
    this.sirenGain.connect(v.input);

    const now = ctx.currentTime;

    if (!this.spec.electric) {
      const buf = firingBuffer(this.spec);
      if (buf) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.playbackRate.value = 1;
        src.connect(this.pulseGain);
        src.start(now);
        this.pulse = src;
      }
    }

    // Harmonic stack. Three partials is enough: more just muddies the pulse
    // train, which is already rich.
    const partials = this.spec.electric ? [1, 2.02, 3.98] : [1, 2, 3];
    for (let i = 0; i < partials.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = this.spec.electric ? "triangle" : i === 0 ? "sawtooth" : "square";
      osc.frequency.value = 60;
      // A few cents of detune per partial stops the stack phase-locking into
      // a buzz; real cylinders are never perfectly in step either.
      osc.detune.value = (i - 1) * this.rng.range(4, 12);
      const g = ctx.createGain();
      g.gain.value = 0;
      osc.connect(g);
      g.connect(this.harmMix);
      osc.start(now);
      this.harm.push(osc);
      this.harmGain.push(g);
    }
    this.harmMix.gain.setValueAtTime(1, now);

    const nb = noiseBuffer(ctx, 3, "pink", 1);
    if (nb) {
      const src = ctx.createBufferSource();
      src.buffer = nb;
      src.loop = true;
      src.connect(this.inductionBp);
      this.inductionBp.connect(this.inductionGain);
      src.start(now);
      this.induction = src;

      const t = ctx.createBufferSource();
      t.buffer = nb;
      t.loop = true;
      t.playbackRate.value = 0.87;
      t.connect(this.tyreBp);
      t.start(now);
      this.tyreSrc = t;

      const wb = noiseBuffer(ctx, 3, "white", 2);
      if (wb) {
        const s = ctx.createBufferSource();
        s.buffer = wb;
        s.loop = true;
        s.connect(this.skidBpA);
        s.connect(this.skidBpB);
        s.start(now);
        this.skidSrc = s;
      }
    }

    if (this.spec.turbo > 0.01 || this.spec.electric) {
      const a = ctx.createOscillator();
      a.type = "sine";
      a.frequency.value = 3000;
      const b = ctx.createOscillator();
      b.type = "triangle";
      b.frequency.value = 3060;
      a.connect(this.turboGain);
      b.connect(this.turboGain);
      a.start(now);
      b.start(now);
      this.turboA = a;
      this.turboB = b;
    }

    // Skid LFO: the squeal wobbles because the contact patch is stick-slipping
    // at tens of Hz. A steady tone sounds like a kettle.
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 23;
    lfo.connect(this.skidLfoGain);
    this.skidLfoGain.connect(this.skidBpA.frequency);
    lfo.start(now);
    this.skidLfo = lfo;

    this.started = true;
    return true;
  }

  /** Detach from the pool but stay reusable. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    const stopNode = (n: AudioScheduledSourceNode | null) => {
      if (!n) return;
      try {
        n.stop();
        n.disconnect();
      } catch {
        /* already stopped */
      }
    };
    stopNode(this.pulse);
    stopNode(this.induction);
    stopNode(this.tyreSrc);
    stopNode(this.skidSrc);
    stopNode(this.skidLfo);
    stopNode(this.turboA);
    stopNode(this.turboB);
    stopNode(this.sirenOsc);
    stopNode(this.sirenSub);
    stopNode(this.sirenLfo);
    for (const o of this.harm) stopNode(o);
    this.pulse = null;
    this.induction = null;
    this.tyreSrc = null;
    this.skidSrc = null;
    this.skidLfo = null;
    this.turboA = null;
    this.turboB = null;
    this.sirenOsc = null;
    this.sirenSub = null;
    this.sirenLfo = null;
    this.harm.length = 0;
    this.harmGain.length = 0;
    try {
      this.engineGain.disconnect();
      this.tyreGain.disconnect();
      this.skidGain.disconnect();
      this.sirenGain.disconnect();
    } catch {
      /* graph gone */
    }
    if (this.voice) {
      this.voice.hold = false;
      this.voice.onSteal = null;
      voicePool.release(this.voice);
      this.voice = null;
    }
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    try {
      this.drive.disconnect();
      this.engineLp.disconnect();
      this.pulseGain.disconnect();
      this.harmMix.disconnect();
      this.inductionBp.disconnect();
      this.inductionGain.disconnect();
      this.turboGain.disconnect();
      this.tyreBp.disconnect();
      this.skidBpA.disconnect();
      this.skidBpB.disconnect();
      this.skidLfoGain.disconnect();
      this.sirenLfoGain.disconnect();
    } catch {
      /* graph gone */
    }
  }

  setSiren(mode: SirenMode): void {
    if (mode === this.sirenMode) return;
    this.sirenMode = mode;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (mode === "off") {
      this.sirenGain.gain.setTargetAtTime(0, now, 0.05);
      return;
    }
    if (!this.sirenOsc && this.started) {
      // Two oscillators: the main tone plus an octave-down body. Real sirens
      // are horn-loaded and have serious low-mid weight; a bare sine reads as
      // a phone alarm.
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 750;
      const sub = ctx.createOscillator();
      sub.type = "square";
      sub.frequency.value = 375;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1400;
      bp.Q.value = 1.1;
      const subG = ctx.createGain();
      subG.gain.value = 0.22;
      osc.connect(bp);
      sub.connect(subG);
      subG.connect(bp);
      bp.connect(this.sirenGain);

      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 0.5;
      lfo.connect(this.sirenLfoGain);
      this.sirenLfoGain.connect(osc.frequency);
      lfo.start(now);
      osc.start(now);
      sub.start(now);
      this.sirenOsc = osc;
      this.sirenSub = sub;
      this.sirenLfo = lfo;
    }
    this.sirenGain.gain.setTargetAtTime(0.42, now, 0.08);
  }

  /**
   * One frame. Everything here is `setTargetAtTime` on existing params —
   * no allocation, no node creation, no garbage.
   */
  update(dt: number, s: VehicleAudioState): void {
    if (this.disposed) return;
    if (!this.started && !this.start(s)) return;
    const v = this.voice;
    const ctx = this.ctx;
    if (!v) return;
    const now = ctx.currentTime;

    v.setPosition(s.x, s.y, s.z, s.vx, s.vy, s.vz);
    if (s.fx !== undefined) v.setOrientation(s.fx, s.fy ?? 0, s.fz ?? 0);

    // Distance-driven detail culling: past ~55 m nobody can pick out induction
    // noise or turbo whine, so stop paying for the automation.
    const dist = v.distance;
    const near = dist < 60;

    /* ---- engine ---- */
    const spec = this.spec;
    // Smooth the incoming rpm: physics rpm is steppy and a stepped pulse train
    // is a very audible warble.
    const k = 1 - Math.exp(-14 * dt);
    this.smoothRpm += (clamp(s.rpm, 0, spec.maxRpm * 1.15) - this.smoothRpm) * k;
    const rpm = this.smoothRpm;
    const rpmNorm = clamp01((rpm - spec.idleRpm) / Math.max(1, spec.maxRpm - spec.idleRpm));
    const load = clamp01(s.load);
    const throttle = clamp01(s.throttle);
    const doppler = v.dopplerScale();

    if (spec.electric) {
      // Inverter whine: frequency tracks wheel speed, not rpm, and it is a
      // pure-ish tone with a switching harmonic above it.
      const f = clamp(60 + s.speed * 34, 55, 4200) * doppler;
      for (let i = 0; i < this.harm.length; i++) {
        this.harm[i].frequency.setTargetAtTime(f * (i === 0 ? 1 : i === 1 ? 4 : 9), now, 0.05);
        this.harmGain[i].gain.setTargetAtTime(
          (i === 0 ? 0.22 : i === 1 ? 0.12 : 0.05) * (0.3 + throttle * 0.7),
          now,
          0.08,
        );
      }
      this.turboGain.gain.setTargetAtTime(0.03 + throttle * 0.05, now, 0.1);
      if (this.turboA) this.turboA.frequency.setTargetAtTime(f * 16, now, 0.06);
      if (this.turboB) this.turboB.frequency.setTargetAtTime(f * 16.4, now, 0.06);
      this.engineLp.frequency.setTargetAtTime(2000 + rpmNorm * 3000, now, 0.08);
    } else {
      const firing = (rpm / 60) * (spec.cylinders / (spec.strokes === 2 ? 1 : 2));
      const rate = clamp((firing / PULSE_BASE_HZ) * doppler, 0.06, 12);
      if (this.pulse) this.pulse.playbackRate.setTargetAtTime(rate, now, 0.02);
      // Pulses dominate at low rpm; the tone stack takes over up high, exactly
      // as a real engine transitions from "thumping" to "screaming".
      this.pulseGain.gain.setTargetAtTime(
        (0.85 - rpmNorm * 0.35) * (0.35 + load * 0.65),
        now,
        0.05,
      );

      const f0 = clamp(firing, 8, 900) * doppler;
      for (let i = 0; i < this.harm.length; i++) {
        this.harm[i].frequency.setTargetAtTime(f0 * (i + 1), now, 0.03);
        const g = [0.3, 0.17, 0.09][i] ?? 0.05;
        this.harmGain[i].gain.setTargetAtTime(
          g * (0.25 + rpmNorm * 0.75) * (0.4 + load * 0.6),
          now,
          0.06,
        );
      }

      if (near) {
        this.inductionBp.frequency.setTargetAtTime(clamp(f0 * 5.5, 200, 5000), now, 0.06);
        this.inductionGain.gain.setTargetAtTime(throttle * (0.1 + rpmNorm * 0.22), now, 0.07);
      } else {
        this.inductionGain.gain.setTargetAtTime(0, now, 0.2);
      }

      // Turbo: spools with load × rpm, and its pitch rides the firing rate.
      if (this.turboA && this.turboB) {
        const boost = spec.turbo * throttle * Math.pow(rpmNorm, 0.6);
        const tf = clamp(f0 * 14 + 900, 900, 9000);
        this.turboA.frequency.setTargetAtTime(tf, now, 0.12);
        this.turboB.frequency.setTargetAtTime(tf * 1.014, now, 0.12);
        this.turboGain.gain.setTargetAtTime(near ? boost * 0.055 : 0, now, 0.15);
      }

      // Load opens the filter. This is most of "the engine is working hard".
      this.engineLp.frequency.setTargetAtTime(
        clamp(320 + rpmNorm * 3400 + load * 2600, 200, 12000),
        now,
        0.06,
      );
      this.drive.curve = waveshaperCurve(clamp01(spec.grit * (0.25 + load * 0.9)), "asym");
    }

    this.engineGain.gain.setTargetAtTime(spec.level * (s.grounded ? 1 : 0.85), now, 0.1);

    /* ---- overrun burble ---- */
    // Closed throttle, revs still high: unburnt mixture popping in the pipe.
    if (
      spec.burble > 0.02 &&
      near &&
      throttle < 0.06 &&
      rpmNorm > 0.32 &&
      !spec.electric
    ) {
      this.burbleNext -= dt;
      if (this.burbleNext <= 0) {
        this.pop(now, 0.16 * spec.burble * (0.4 + rpmNorm));
        this.burbleNext = this.rng.range(0.035, 0.16) / (0.4 + rpmNorm);
      }
    } else {
      this.burbleNext = 0.05;
    }

    /* ---- gear shift ---- */
    if (s.gear !== this.lastGear) {
      if (this.lastGear !== 0 && near) {
        // Cut the drive for 60 ms and clunk. The cut is what sells the shift;
        // the clunk just tells you what kind of gearbox it is.
        this.engineGain.gain.cancelScheduledValues(now);
        this.engineGain.gain.setValueAtTime(this.engineGain.gain.value, now);
        this.engineGain.gain.linearRampToValueAtTime(spec.level * 0.25, now + 0.012);
        this.engineGain.gain.linearRampToValueAtTime(spec.level, now + 0.11);
        this.oneShot(shiftBuffer(), 0.35, this.rng.range(0.9, 1.15));
      }
      this.lastGear = s.gear;
    }

    /* ---- tyres ---- */
    const surf = SURFACE_TYRE[s.surface] ?? SURFACE_TYRE.asphalt;
    const speedN = clamp01(s.speed / 34);
    const rollGain = s.grounded ? Math.pow(speedN, 1.35) * surf.gain * 0.32 : 0;
    this.tyreGain.gain.setTargetAtTime(rollGain, now, 0.09);
    this.tyreBp.frequency.setTargetAtTime(surf.f * (0.55 + speedN * 0.9), now, 0.1);
    this.tyreBp.Q.setTargetAtTime(surf.q, now, 0.2);
    if (this.tyreSrc) {
      // Grainy surfaces get a faster read of the noise bed, which raises the
      // apparent grain rate the way gravel actually does under a tyre.
      this.tyreSrc.playbackRate.setTargetAtTime(0.7 + speedN * 0.8 + surf.grain * 0.5, now, 0.15);
    }

    /* ---- skid ---- */
    const slip = clamp01(s.slip);
    const skid = s.grounded && s.speed > 3 ? Math.pow(slip, 1.4) * 0.5 : 0;
    this.skidGain.gain.setTargetAtTime(skid, now, skid > 0.01 ? 0.03 : 0.12);
    if (skid > 0.005) {
      const f = 900 + slip * 900 + speedN * 500;
      this.skidBpA.frequency.setTargetAtTime(f, now, 0.05);
      this.skidBpB.frequency.setTargetAtTime(f * 2.15, now, 0.05);
      this.skidLfoGain.gain.setTargetAtTime(90 + slip * 240, now, 0.08);
    }

    /* ---- suspension + impacts ---- */
    if (s.suspension && s.suspension > 0.08) {
      this.oneShot(knockBuffer(), clamp01(s.suspension) * 0.5, this.rng.range(0.85, 1.2));
    }
    if (s.impact && s.impact > 0.05) {
      this.oneShot(crashBuffer(), clamp01(s.impact) * 0.9, this.rng.range(0.8, 1.25));
    }

    /* ---- siren ---- */
    if (this.sirenMode !== "off" && this.sirenOsc && this.sirenLfo) {
      this.sirenPhase += dt;
      switch (this.sirenMode) {
        case "wail":
          this.sirenLfo.frequency.setTargetAtTime(0.36, now, 0.1);
          this.sirenLfoGain.gain.setTargetAtTime(330, now, 0.1);
          this.sirenOsc.frequency.setTargetAtTime(820 * doppler, now, 0.1);
          break;
        case "yelp":
          this.sirenLfo.frequency.setTargetAtTime(4.2, now, 0.1);
          this.sirenLfoGain.gain.setTargetAtTime(300, now, 0.1);
          this.sirenOsc.frequency.setTargetAtTime(900 * doppler, now, 0.1);
          break;
        case "hilo": {
          // European two-tone: a square wave in frequency, not a sweep.
          const hi = (this.sirenPhase % 1.0) < 0.5;
          this.sirenLfoGain.gain.setTargetAtTime(0, now, 0.02);
          this.sirenOsc.frequency.setTargetAtTime((hi ? 660 : 495) * doppler, now, 0.01);
          break;
        }
        case "phaser":
          this.sirenLfo.frequency.setTargetAtTime(11, now, 0.1);
          this.sirenLfoGain.gain.setTargetAtTime(520, now, 0.1);
          this.sirenOsc.frequency.setTargetAtTime(1100 * doppler, now, 0.1);
          break;
        default:
          break;
      }
      if (this.sirenSub) {
        this.sirenSub.frequency.setTargetAtTime(this.sirenOsc.frequency.value * 0.5, now, 0.12);
      }
    }
  }

  /** A single exhaust pop. Two nodes, self-cleaning. */
  private pop(when: number, gain: number): void {
    const ctx = this.ctx;
    const buf = noiseBuffer(ctx, 0.3, "brown", 3);
    if (!buf || !this.voice) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = this.rng.range(0.7, 1.4);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = this.rng.range(110, 260);
    bp.Q.value = 1.6;
    const g = ctx.createGain();
    percEnv(g.gain, when, gain, this.rng.range(0.03, 0.09));
    src.connect(bp);
    bp.connect(g);
    g.connect(this.engineGain);
    src.start(when);
    src.stop(when + 0.16);
    src.onended = () => {
      try {
        bp.disconnect();
        g.disconnect();
      } catch {
        /* torn down */
      }
    };
  }

  /** Fire a baked one-shot into this vehicle's own spatial voice. */
  private oneShot(buf: AudioBuffer | null, gain: number, pitch: number): void {
    if (!buf || !this.voice) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitch;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.voice.input);
    const now = ctx.currentTime;
    src.start(now);
    src.onended = () => {
      try {
        g.disconnect();
      } catch {
        /* torn down */
      }
    };
  }
}

/* ================================================================== *
 * Helicopter
 * ================================================================== */

/**
 * Rotor + turbine.
 *
 * Blade-pass frequency is `rotorRpm / 60 × blades` — 10.8 Hz for a two-bladed
 * Huey, which is below hearing and is felt as a thump rate rather than a pitch.
 * That is why a helicopter is audible from a mile away through buildings: the
 * energy is almost all under 200 Hz and nothing absorbs it.
 */
export class HelicopterVoice {
  readonly id: number;
  private ctx: AudioContext;
  private voice: Voice | null = null;
  private slap: AudioBufferSourceNode | null = null;
  private slapGain: GainNode;
  private slapLp: BiquadFilterNode;
  private turbineA: OscillatorNode | null = null;
  private turbineB: OscillatorNode | null = null;
  private turbineGain: GainNode;
  private wash: AudioBufferSourceNode | null = null;
  private washBp: BiquadFilterNode;
  private washGain: GainNode;
  private started = false;
  private spec: EngineSpec;

  constructor(id: number, ctx: AudioContext, spec = ENGINE_SPECS.helicopter) {
    this.id = id;
    this.ctx = ctx;
    this.spec = spec;
    this.slapGain = ctx.createGain();
    this.slapGain.gain.value = 0;
    this.slapLp = ctx.createBiquadFilter();
    this.slapLp.type = "lowpass";
    this.slapLp.frequency.value = 900;
    this.slapLp.Q.value = 0.8;
    this.slapGain.connect(this.slapLp);
    this.turbineGain = ctx.createGain();
    this.turbineGain.gain.value = 0;
    this.washBp = ctx.createBiquadFilter();
    this.washBp.type = "bandpass";
    this.washBp.frequency.value = 700;
    this.washBp.Q.value = 0.5;
    this.washGain = ctx.createGain();
    this.washGain.gain.value = 0;
    this.washBp.connect(this.washGain);
  }

  private start(s: VehicleAudioState): boolean {
    if (this.started) return true;
    const ctx = this.ctx;
    const o = scratchOptions as VoiceOptions;
    o.x = s.x;
    o.y = s.y;
    o.z = s.z;
    o.vx = s.vx;
    o.vy = s.vy;
    o.vz = s.vz;
    o.bus = "vehicles";
    o.local = false;
    o.gain = 1;
    o.pitch = 1;
    o.priority = 0.85;
    o.loudness = this.spec.loudness;
    o.propagate = false;
    // Rotor noise diffracts around buildings far better than a gunshot; a
    // full occlusion lowpass would make helicopters vanish behind a facade,
    // which is the opposite of what they do.
    o.noOcclusion = true;
    o.duration = 1e9;
    const v = voicePool.acquire(o);
    o.duration = undefined;
    o.noOcclusion = false;
    if (!v) return false;
    v.hold = true;
    v.onSteal = () => this.stop();
    this.voice = v;

    this.slapLp.connect(v.input);
    this.turbineGain.connect(v.input);
    this.washGain.connect(v.input);

    const now = ctx.currentTime;
    const rb = rotorBuffer();
    if (rb) {
      const src = ctx.createBufferSource();
      src.buffer = rb;
      src.loop = true;
      src.connect(this.slapGain);
      src.start(now);
      this.slap = src;
    }
    const nb = noiseBuffer(ctx, 3, "pink", 4);
    if (nb) {
      const src = ctx.createBufferSource();
      src.buffer = nb;
      src.loop = true;
      src.connect(this.washBp);
      src.start(now);
      this.wash = src;
    }
    const a = ctx.createOscillator();
    a.type = "sawtooth";
    a.frequency.value = 1180;
    const b = ctx.createOscillator();
    b.type = "sine";
    b.frequency.value = 2380;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2000;
    bp.Q.value = 2.2;
    a.connect(bp);
    b.connect(bp);
    bp.connect(this.turbineGain);
    a.start(now);
    b.start(now);
    this.turbineA = a;
    this.turbineB = b;

    this.started = true;
    return true;
  }

  update(_dt: number, s: VehicleAudioState): void {
    if (!this.started && !this.start(s)) return;
    const v = this.voice;
    if (!v) return;
    const now = this.ctx.currentTime;
    v.setPosition(s.x, s.y, s.z, s.vx, s.vy, s.vz);

    const doppler = v.dopplerScale();
    const collective = clamp01(s.collective ?? 0.6);
    const rotorRpm = (this.spec.rotorRpm ?? 324) * (0.9 + collective * 0.14);
    const bladePass = (rotorRpm / 60) * (this.spec.blades ?? 2);
    const rate = clamp((bladePass / ROTOR_BASE_HZ) * doppler, 0.3, 3);
    if (this.slap) this.slap.playbackRate.setTargetAtTime(rate, now, 0.08);

    // Pulling collective loads the blades and the slap gets violent — that
    // hard "whop-whop" is a helicopter working, not one cruising.
    this.slapGain.gain.setTargetAtTime(0.55 + collective * 0.65, now, 0.15);
    this.slapLp.frequency.setTargetAtTime(500 + collective * 1400, now, 0.15);

    this.turbineGain.gain.setTargetAtTime(v.distance < 220 ? 0.05 + collective * 0.06 : 0, now, 0.3);
    if (this.turbineA) this.turbineA.frequency.setTargetAtTime(1180 * doppler, now, 0.1);
    if (this.turbineB) this.turbineB.frequency.setTargetAtTime(2380 * doppler, now, 0.1);

    this.washGain.gain.setTargetAtTime(v.distance < 120 ? 0.16 * (0.4 + collective) : 0.02, now, 0.25);
    this.washBp.frequency.setTargetAtTime(600 + collective * 700, now, 0.2);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    const kill = (n: AudioScheduledSourceNode | null) => {
      if (!n) return;
      try {
        n.stop();
        n.disconnect();
      } catch {
        /* stopped */
      }
    };
    kill(this.slap);
    kill(this.wash);
    kill(this.turbineA);
    kill(this.turbineB);
    this.slap = null;
    this.wash = null;
    this.turbineA = null;
    this.turbineB = null;
    try {
      this.slapLp.disconnect();
      this.turbineGain.disconnect();
      this.washGain.disconnect();
    } catch {
      /* graph gone */
    }
    if (this.voice) {
      this.voice.hold = false;
      this.voice.onSteal = null;
      voicePool.release(this.voice);
      this.voice = null;
    }
  }

  dispose(): void {
    this.stop();
    try {
      this.slapGain.disconnect();
      this.washBp.disconnect();
    } catch {
      /* graph gone */
    }
  }
}

/* ================================================================== *
 * Manager
 * ================================================================== */

interface Entry {
  voice: VehicleVoice | HelicopterVoice;
  heli: boolean;
  /** Set every frame the caller reports this vehicle; stale entries are reaped. */
  seen: number;
  distance: number;
}

/**
 * Keeps at most `maxVehicles` engines sounding, always the closest ones.
 *
 * Engines are expensive (a dozen nodes each) and there is no point running the
 * eleventh-nearest sedan. The manager reaps anything the game stops reporting,
 * so a despawned car cannot leak a voice.
 */
class VehicleAudioManager {
  private entries = new Map<number, Entry>();
  private frameId = 0;
  maxVehicles = 8;
  maxHelicopters = 3;

  /** Report a vehicle this frame. Creates its voice on first sight. */
  update(id: number, spec: EngineSpec, state: VehicleAudioState, dt: number): void {
    const ctx = audioEngine.ctx;
    if (!ctx || !audioEngine.available) return;

    const dist = distanceTo(state.x, state.y, state.z);
    let e = this.entries.get(id);
    const heli = spec.kind === "helicopter";
    const budget = heli ? this.maxHelicopters : this.maxVehicles;

    if (!e) {
      if (dist > spec.loudness * 1.2) return;
      let count = 0;
      let farthest: Entry | null = null;
      let farthestId = -1;
      for (const [k, v] of this.entries) {
        if (v.heli !== heli) continue;
        count++;
        if (!farthest || v.distance > farthest.distance) {
          farthest = v;
          farthestId = k;
        }
      }
      if (count >= budget) {
        // Only displace a further-away vehicle; otherwise skip entirely.
        if (!farthest || farthest.distance <= dist) return;
        farthest.voice.dispose();
        this.entries.delete(farthestId);
      }
      e = {
        voice: heli ? new HelicopterVoice(id, ctx, spec) : new VehicleVoice(id, spec, ctx),
        heli,
        seen: this.frameId,
        distance: dist,
      };
      this.entries.set(id, e);
    }

    e.seen = this.frameId;
    e.distance = dist;
    e.voice.update(dt, state);
  }

  setSiren(id: number, mode: SirenMode): void {
    const e = this.entries.get(id);
    if (e && !e.heli) (e.voice as VehicleVoice).setSiren(mode);
  }

  /** Call once per frame *after* every vehicle has reported. */
  endFrame(): void {
    for (const [id, e] of this.entries) {
      if (e.seen !== this.frameId) {
        e.voice.dispose();
        this.entries.delete(id);
      }
    }
    this.frameId++;
  }

  release(id: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.voice.dispose();
    this.entries.delete(id);
  }

  stopAll(): void {
    for (const e of this.entries.values()) e.voice.dispose();
    this.entries.clear();
  }

  get count(): number {
    return this.entries.size;
  }
}

export const vehicleAudio = new VehicleAudioManager();

/** One-shot car horn — used by traffic AI, not tied to a vehicle voice. */
export function playHorn(x: number, y: number, z: number, kind = 0, duration = 0.4): void {
  const ctx = audioEngine.ctx;
  if (!ctx || !audioEngine.available) return;
  const o = scratchOptions as VoiceOptions;
  o.x = x;
  o.y = y;
  o.z = z;
  o.bus = "vehicles";
  o.local = false;
  o.gain = 0.5;
  o.pitch = 1;
  o.priority = 0.5;
  o.loudness = 180;
  o.propagate = false;
  o.noOcclusion = false;
  o.duration = duration + 0.2;
  const v = voicePool.acquire(o);
  o.duration = undefined;
  if (!v) return;

  const now = ctx.currentTime;
  // Real horns are two horns, a musical third or fourth apart, both buzzing.
  const roots = [[370, 466], [311, 415], [440, 554]];
  const pair = roots[kind % roots.length];
  const oscs: OscillatorNode[] = [];
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.55, now + 0.012);
  g.gain.setValueAtTime(0.55, now + duration);
  g.gain.exponentialRampToValueAtTime(0.0001, now + duration + 0.06);
  const shaper = saturator(ctx, 0.5, "tanh");
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 4200;
  g.connect(shaper);
  shaper.connect(lp);
  lp.connect(v.input);
  for (const f of pair) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = f;
    osc.connect(g);
    osc.start(now);
    osc.stop(now + duration + 0.1);
    oscs.push(osc);
  }
  oscs[oscs.length - 1].onended = () => {
    try {
      g.disconnect();
      shaper.disconnect();
      lp.disconnect();
    } catch {
      /* torn down */
    }
  };
  v.onSteal = () => {
    for (const o2 of oscs) {
      try {
        o2.stop();
      } catch {
        /* not started */
      }
    }
  };
  v.endsAt = now + duration + 0.15;
}
