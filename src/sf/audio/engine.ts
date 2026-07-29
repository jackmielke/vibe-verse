/**
 * audio/engine.ts — the mix bus, the room, and the rules.
 *
 * Everything audible in San Francisco passes through this graph:
 *
 *     voice ──► bus.input ──► bus.volume ─┬─► master.in ──► duck ──► deafen
 *                                         └─► send ──► reverb(A/B) ──┘
 *                                                                     │
 *                          ┌──────────────────────────────────────────┘
 *                          └─► busComp ──► limiter ──► masterGain ──► out
 *
 * Design notes worth the words:
 *
 *  - **Two convolvers, not one.** Swapping a ConvolverNode's buffer while it is
 *    running truncates the tail and clicks. Instead there are two, and changing
 *    environment crossfades between them over ~0.7 s — walking out of an alley
 *    onto Market Street is a transition, not a cut.
 *
 *  - **The IRs are generated, not loaded.** `renderIR` builds an early/late
 *    impulse response per environment from a physically-motivated preset. A
 *    600 KB WAV would sound no better and would cost a network round trip on a
 *    page that is already streaming a city.
 *
 *  - **Bus compressor *and* limiter.** The compressor (3:1, slow) glues the mix
 *    so a firefight feels dense; the limiter (20:1, 1 ms) exists purely so an
 *    RPG at point-blank range cannot clip the interface. Two stages, two jobs.
 *
 *  - **Autoplay.** The context is created suspended and resumed on the first
 *    real user gesture. Nothing in this file throws if audio is unavailable;
 *    `available` goes false and every entry point becomes a no-op, because a
 *    game that crashes on a locked AudioContext is worse than a silent one.
 *
 * Public API
 * ----------
 *   audioEngine (singleton)   .init() .unlock() .dispose() .update(dt)
 *   BusName / EnvironmentKind / AudioSettings
 *   audioEngine.bus(name)     the node to connect voices to
 *   audioEngine.setEnvironment / setEnvironmentAuto / setEnvironmentBlend
 *   audioEngine.setVolume / setMuted / duck / deafen / suspend / resume
 *   setOcclusionProbe / probeOcclusion
 */
import { clamp, clamp01, damp, makeRng, type Rng } from "../math/rng";
import { frame } from "../state/store";
import {
  districtAt,
  isPark,
  isWater,
  nearestStreet,
  terrainHeight,
} from "../geo/sfGeo";
import { dbToGain, renderIR, type IrSpec } from "./synth";

/* ================================================================== *
 * Types
 * ================================================================== */

export type BusName = "weapons" | "vehicles" | "world" | "voice" | "music" | "ui";

export const BUS_NAMES: readonly BusName[] = [
  "weapons",
  "vehicles",
  "world",
  "voice",
  "music",
  "ui",
];

export type EnvironmentKind =
  | "open" // hilltop, water, park — barely any reflection
  | "street" // ordinary SF block: buildings both sides, sky above
  | "canyon" // Financial District: 200 m towers, long slapback
  | "alley" // narrow, hard, strongly coloured
  | "indoor" // room with absorbent contents
  | "tunnel" // Stockton/Broadway: modal, long, dark
  | "bay"; // over open water — a very long, very quiet reflection off the city

export interface AudioSettings {
  master: number;
  weapons: number;
  vehicles: number;
  world: number;
  voice: number;
  music: number;
  ui: number;
  muted: boolean;
  /** HRTF panning is far more expensive than equal-power; off on low tiers. */
  hrtf: boolean;
  /** Hard cap on simultaneous positional voices. */
  maxVoices: number;
}

export const DEFAULT_SETTINGS: AudioSettings = {
  master: 0.9,
  weapons: 1,
  vehicles: 0.85,
  world: 0.8,
  voice: 1,
  music: 0.55,
  ui: 0.7,
  muted: false,
  hrtf: true,
  maxVoices: 48,
};

interface Bus {
  input: GainNode;
  volume: GainNode;
  send: GainNode;
  /** How wet this bus is at reverb weight 1. Music is nearly dry. */
  sendBase: number;
}

/* ================================================================== *
 * Environment presets
 * ================================================================== */

interface EnvPreset {
  ir: IrSpec;
  /** Global wet multiplier for the space. */
  wet: number;
  /** Extra lowpass applied to distant/occluded sources in this space. */
  airDamping: number;
  /** Perceived first-reflection delay, seconds — used by the gunshot tails. */
  slapback: number;
}

export const ENVIRONMENTS: Record<EnvironmentKind, EnvPreset> = {
  open: {
    wet: 0.16,
    airDamping: 1,
    slapback: 0.09,
    ir: {
      seconds: 1.1,
      decay: 0.75,
      predelay: 0.02,
      earlyTaps: 5,
      earlySpread: 0.12,
      earlyGain: 0.25,
      damping: 6500,
      dampingSlope: 0.6,
      width: 0.9,
      lowBoost: 0.1,
      resonance: 0,
      resonanceHz: 200,
    },
  },
  street: {
    wet: 0.34,
    airDamping: 0.95,
    slapback: 0.055,
    ir: {
      seconds: 1.9,
      decay: 1.25,
      predelay: 0.011,
      earlyTaps: 14,
      earlySpread: 0.11,
      earlyGain: 0.6,
      damping: 5200,
      dampingSlope: 0.55,
      width: 0.8,
      lowBoost: 0.28,
      resonance: 0.06,
      resonanceHz: 140,
    },
  },
  canyon: {
    // Montgomery at Pine: the buildings are 60 storeys of glass and stone and
    // a gunshot comes back at you four times.
    wet: 0.52,
    airDamping: 0.92,
    slapback: 0.13,
    ir: {
      seconds: 3.4,
      decay: 2.3,
      predelay: 0.026,
      earlyTaps: 22,
      earlySpread: 0.34,
      earlyGain: 0.78,
      damping: 6200,
      dampingSlope: 0.42,
      width: 0.95,
      lowBoost: 0.34,
      resonance: 0.1,
      resonanceHz: 96,
    },
  },
  alley: {
    wet: 0.62,
    airDamping: 0.8,
    slapback: 0.014,
    ir: {
      seconds: 1.5,
      decay: 0.95,
      predelay: 0.004,
      earlyTaps: 26,
      earlySpread: 0.045,
      earlyGain: 0.95,
      damping: 4200,
      dampingSlope: 0.6,
      width: 0.45,
      lowBoost: 0.4,
      resonance: 0.3,
      resonanceHz: 320,
    },
  },
  indoor: {
    wet: 0.44,
    airDamping: 0.72,
    slapback: 0.009,
    ir: {
      seconds: 1.2,
      decay: 0.62,
      predelay: 0.005,
      earlyTaps: 18,
      earlySpread: 0.035,
      earlyGain: 0.7,
      damping: 3000,
      dampingSlope: 0.75,
      width: 0.6,
      lowBoost: 0.22,
      resonance: 0.14,
      resonanceHz: 190,
    },
  },
  tunnel: {
    wet: 0.7,
    airDamping: 0.6,
    slapback: 0.03,
    ir: {
      seconds: 3.0,
      decay: 2.1,
      predelay: 0.008,
      earlyTaps: 30,
      earlySpread: 0.09,
      earlyGain: 0.85,
      damping: 2600,
      dampingSlope: 0.5,
      width: 0.35,
      lowBoost: 0.55,
      resonance: 0.45,
      resonanceHz: 128,
    },
  },
  bay: {
    wet: 0.22,
    airDamping: 1,
    slapback: 0.55,
    ir: {
      seconds: 4.2,
      decay: 2.8,
      predelay: 0.09,
      earlyTaps: 8,
      earlySpread: 0.9,
      earlyGain: 0.3,
      damping: 3400,
      dampingSlope: 0.7,
      width: 1,
      lowBoost: 0.3,
      resonance: 0,
      resonanceHz: 110,
    },
  },
};

/* ================================================================== *
 * Occlusion
 * ================================================================== */

/**
 * A probe returns 0 (clear line of sight) .. 1 (fully occluded) between a
 * source and the listener. The physics module owns the real answer; wire it in
 * from the integrator with `setOcclusionProbe`, e.g.
 *
 *   setOcclusionProbe((sx, sy, sz, lx, ly, lz) => {
 *     const dx = lx - sx, dy = ly - sy, dz = lz - sz;
 *     const d = Math.hypot(dx, dy, dz);
 *     return raycast(sx, sy, sz, dx, dy, dz, d, scratchHit, LOS_OPTS) ? 1 : 0;
 *   });
 *
 * Until then the built-in probe samples terrain along the ray, which already
 * gets the big one right: Nob Hill really does eat a firefight in the Tenderloin.
 */
export type OcclusionProbe = (
  sx: number,
  sy: number,
  sz: number,
  lx: number,
  ly: number,
  lz: number,
) => number;

let occlusionProbe: OcclusionProbe | null = null;

export function setOcclusionProbe(p: OcclusionProbe | null): void {
  occlusionProbe = p;
}

/** Terrain-only fallback: how much of SF's topography is in the way. */
function terrainOcclusion(
  sx: number,
  sy: number,
  sz: number,
  lx: number,
  ly: number,
  lz: number,
): number {
  const dx = lx - sx;
  const dz = lz - sz;
  const dist = Math.hypot(dx, dz);
  if (dist < 8) return 0;
  const steps = clamp(Math.round(dist / 25), 3, 12);
  let blocked = 0;
  for (let i = 1; i < steps; i++) {
    const u = i / steps;
    const h = terrainHeight(sx + dx * u, sz + dz * u);
    const rayY = sy + (ly - sy) * u;
    if (h > rayY + 1.5) blocked += clamp01((h - rayY) / 18);
  }
  return clamp01(blocked / Math.max(1, steps - 1));
}

export function probeOcclusion(
  sx: number,
  sy: number,
  sz: number,
  lx: number,
  ly: number,
  lz: number,
): number {
  if (occlusionProbe) {
    try {
      return clamp01(occlusionProbe(sx, sy, sz, lx, ly, lz));
    } catch {
      occlusionProbe = null; // a throwing probe is unregistered, not retried
    }
  }
  return terrainOcclusion(sx, sy, sz, lx, ly, lz);
}

/* ================================================================== *
 * The engine
 * ================================================================== */

type Ctor = typeof AudioContext;

function audioContextCtor(): Ctor | null {
  const g = globalThis as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

const GESTURES: readonly string[] = [
  "pointerdown",
  "mousedown",
  "touchstart",
  "keydown",
  "click",
];

class AudioEngine {
  /** Null until `init()` succeeds. */
  ctx: AudioContext | null = null;
  /** True once the graph exists. Every public method no-ops when false. */
  available = false;
  /** True while the context is suspended by the autoplay policy. */
  blocked = false;

  settings: AudioSettings = { ...DEFAULT_SETTINGS };

  private buses: Partial<Record<BusName, Bus>> = {};
  private masterIn: GainNode | null = null;
  private duckGain: GainNode | null = null;
  private deafenFilter: BiquadFilterNode | null = null;
  private busComp: DynamicsCompressorNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private masterGain: GainNode | null = null;
  private reverbIn: GainNode | null = null;
  private convA: ConvolverNode | null = null;
  private convB: ConvolverNode | null = null;
  private wetA: GainNode | null = null;
  private wetB: GainNode | null = null;
  private usingA = true;

  private irCache = new Map<EnvironmentKind, AudioBuffer>();

  /** Current environment, and the one we are crossfading toward. */
  environment: EnvironmentKind = "street";
  /** 0..1 extra wetness applied on top of the preset (e.g. indoors). */
  wetScale = 1;
  private envWet = ENVIRONMENTS.street.wet;
  private envWetTarget = ENVIRONMENTS.street.wet;

  /** Listener position, kept here so every module reads one source of truth. */
  readonly listener = {
    x: 0,
    y: 0,
    z: 0,
    fx: 0,
    fy: 0,
    fz: -1,
    ux: 0,
    uy: 1,
    uz: 0,
    vx: 0,
    vy: 0,
    vz: 0,
  };

  /** Set true while the whole simulation is paused. */
  private suspended = false;
  private gestureBound = false;
  private deafenUntil = 0;
  private disposed = false;

  /* ---------------- lifecycle ---------------- */

  /**
   * Build the graph. Idempotent, synchronous, and safe to call before any user
   * gesture — the context is simply created suspended and resumed later.
   */
  init(settings?: Partial<AudioSettings>): boolean {
    if (this.available) {
      if (settings) this.applySettings(settings);
      return true;
    }
    if (this.disposed) this.disposed = false;
    const Ctor = audioContextCtor();
    if (!Ctor) return false;

    try {
      const ctx = new Ctor({ latencyHint: "interactive" });
      this.ctx = ctx;

      // ---- master chain, built output-first so nothing is ever connected to
      // a node that does not exist yet.
      const masterGain = ctx.createGain();
      masterGain.gain.value = 0; // faded up on unlock; avoids a boot click
      masterGain.connect(ctx.destination);

      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -1.5;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.06;
      limiter.connect(masterGain);

      const busComp = ctx.createDynamicsCompressor();
      busComp.threshold.value = -20;
      busComp.knee.value = 14;
      busComp.ratio.value = 2.6;
      busComp.attack.value = 0.012;
      busComp.release.value = 0.26;
      busComp.connect(limiter);

      // Tinnitus / concussion filter. Normally wide open; an explosion at
      // 4 m slams it down to 700 Hz and lets it open over a couple of seconds.
      const deafen = ctx.createBiquadFilter();
      deafen.type = "lowpass";
      deafen.frequency.value = 20000;
      deafen.Q.value = 0.5;
      deafen.connect(busComp);

      const duck = ctx.createGain();
      duck.gain.value = 1;
      duck.connect(deafen);

      const masterIn = ctx.createGain();
      masterIn.gain.value = 1;
      masterIn.connect(duck);

      // ---- reverb: two convolvers, crossfaded
      const reverbIn = ctx.createGain();
      reverbIn.gain.value = 1;

      const convA = ctx.createConvolver();
      const convB = ctx.createConvolver();
      convA.normalize = true;
      convB.normalize = true;
      const wetA = ctx.createGain();
      const wetB = ctx.createGain();
      wetA.gain.value = 1;
      wetB.gain.value = 0;
      reverbIn.connect(convA);
      reverbIn.connect(convB);
      convA.connect(wetA);
      convB.connect(wetB);
      wetA.connect(masterIn);
      wetB.connect(masterIn);

      this.masterGain = masterGain;
      this.limiter = limiter;
      this.busComp = busComp;
      this.deafenFilter = deafen;
      this.duckGain = duck;
      this.masterIn = masterIn;
      this.reverbIn = reverbIn;
      this.convA = convA;
      this.convB = convB;
      this.wetA = wetA;
      this.wetB = wetB;

      // ---- buses
      const sendBase: Record<BusName, number> = {
        weapons: 1,
        vehicles: 0.55,
        world: 0.35,
        voice: 0.7,
        music: 0.12,
        ui: 0,
      };
      for (const name of BUS_NAMES) {
        const input = ctx.createGain();
        const volume = ctx.createGain();
        const send = ctx.createGain();
        input.connect(volume);
        volume.connect(masterIn);
        volume.connect(send);
        send.connect(reverbIn);
        send.gain.value = sendBase[name] * ENVIRONMENTS.street.wet;
        this.buses[name] = { input, volume, send, sendBase: sendBase[name] };
      }

      this.available = true;
      this.applySettings(settings ?? {});
      this.installIR("street", true);
      this.bindGestures();
      this.blocked = ctx.state !== "running";
      if (!this.blocked) this.fadeUp();
      else void this.tryResume();
      return true;
    } catch {
      this.ctx = null;
      this.available = false;
      return false;
    }
  }

  private bindGestures(): void {
    if (this.gestureBound || typeof window === "undefined") return;
    this.gestureBound = true;
    const handler = () => {
      void this.unlock();
    };
    for (const ev of GESTURES) {
      window.addEventListener(ev, handler, { passive: true });
    }
    // Also retry when the tab comes back — Safari suspends on background.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !this.suspended) void this.tryResume();
    });
    this.gestureHandler = handler;
  }

  private gestureHandler: (() => void) | null = null;

  /** Resume the context. Call from any user gesture; safe to spam. */
  async unlock(): Promise<boolean> {
    if (!this.available) this.init();
    return this.tryResume();
  }

  private async tryResume(): Promise<boolean> {
    const ctx = this.ctx;
    if (!ctx) return false;
    try {
      if (ctx.state === "suspended") await ctx.resume();
      const running = ctx.state === "running";
      this.blocked = !running;
      if (running) {
        this.fadeUp();
        this.unbindGestures();
      }
      return running;
    } catch {
      this.blocked = true;
      return false;
    }
  }

  private unbindGestures(): void {
    if (!this.gestureHandler || typeof window === "undefined") return;
    for (const ev of GESTURES) window.removeEventListener(ev, this.gestureHandler);
    this.gestureHandler = null;
    this.gestureBound = false;
  }

  private fadeUp(): void {
    const ctx = this.ctx;
    const g = this.masterGain;
    if (!ctx || !g) return;
    const now = ctx.currentTime;
    const target = this.settings.muted ? 0 : this.settings.master;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(target, now + 0.25);
  }

  dispose(): void {
    this.unbindGestures();
    const ctx = this.ctx;
    this.available = false;
    this.disposed = true;
    this.irCache.clear();
    this.buses = {};
    this.masterIn = null;
    this.masterGain = null;
    this.reverbIn = null;
    this.convA = null;
    this.convB = null;
    this.wetA = null;
    this.wetB = null;
    this.duckGain = null;
    this.deafenFilter = null;
    this.busComp = null;
    this.limiter = null;
    this.ctx = null;
    if (ctx) {
      try {
        void ctx.close();
      } catch {
        /* already closed */
      }
    }
  }

  /* ---------------- mixing ---------------- */

  /** The node a voice should connect to for a given bus. */
  bus(name: BusName): AudioNode | null {
    return this.buses[name]?.input ?? null;
  }

  /** `ctx.currentTime`, or 0 when audio is unavailable. */
  get now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  get sampleRate(): number {
    return this.ctx ? this.ctx.sampleRate : 48000;
  }

  applySettings(patch: Partial<AudioSettings>): void {
    Object.assign(this.settings, patch);
    if (!this.available || !this.ctx) return;
    const now = this.ctx.currentTime;
    for (const name of BUS_NAMES) {
      const b = this.buses[name];
      if (!b) continue;
      const v = clamp01(this.settings[name] as number);
      b.volume.gain.setTargetAtTime(v, now, 0.02);
    }
    if (this.masterGain) {
      const target = this.settings.muted ? 0 : clamp01(this.settings.master);
      // Muting is instant and total: no ramp, no residual tail. Unmuting gets
      // a short ramp so it does not thump.
      if (this.settings.muted) {
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setValueAtTime(0, now);
      } else {
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
        this.masterGain.gain.linearRampToValueAtTime(target, now + 0.06);
      }
    }
  }

  setVolume(name: BusName | "master", v: number): void {
    this.applySettings({ [name]: clamp01(v) } as Partial<AudioSettings>);
  }

  setMuted(muted: boolean): void {
    this.applySettings({ muted });
  }

  get muted(): boolean {
    return this.settings.muted;
  }

  toggleMute(): boolean {
    this.setMuted(!this.settings.muted);
    return this.settings.muted;
  }

  /** Freeze audio with the simulation. Cheaper than muting: no DSP runs. */
  suspend(): void {
    this.suspended = true;
    if (this.ctx && this.ctx.state === "running") {
      try {
        void this.ctx.suspend();
      } catch {
        /* ignore */
      }
    }
  }

  resume(): void {
    this.suspended = false;
    void this.tryResume();
  }

  /* ---------------- environment ---------------- */

  private irFor(kind: EnvironmentKind): AudioBuffer | null {
    const hit = this.irCache.get(kind);
    if (hit) return hit;
    const ctx = this.ctx;
    if (!ctx) return null;
    try {
      const preset = ENVIRONMENTS[kind];
      const sr = ctx.sampleRate;
      const len = Math.max(64, Math.round(preset.ir.seconds * sr));
      const buf = ctx.createBuffer(2, len, sr);
      // Deterministic per environment: the same alley sounds the same on
      // every machine, which the screenshot harness depends on.
      const rng = makeIrRng(kind);
      renderIR([buf.getChannelData(0), buf.getChannelData(1)], sr, preset.ir, rng);
      this.irCache.set(kind, buf);
      return buf;
    } catch {
      return null;
    }
  }

  private installIR(kind: EnvironmentKind, immediate: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.convA || !this.convB || !this.wetA || !this.wetB) return;
    const buf = this.irFor(kind);
    if (!buf) return;
    const now = ctx.currentTime;
    if (immediate) {
      this.convA.buffer = buf;
      this.convB.buffer = buf;
      this.wetA.gain.setValueAtTime(1, now);
      this.wetB.gain.setValueAtTime(0, now);
      this.usingA = true;
      return;
    }
    // Load the *idle* convolver, then crossfade. Never touch the buffer of the
    // convolver that is currently sounding — that truncates its tail.
    const incoming = this.usingA ? this.convB : this.convA;
    const inGain = this.usingA ? this.wetB : this.wetA;
    const outGain = this.usingA ? this.wetA : this.wetB;
    incoming.buffer = buf;
    const t = 0.7;
    inGain.gain.cancelScheduledValues(now);
    outGain.gain.cancelScheduledValues(now);
    inGain.gain.setValueAtTime(inGain.gain.value, now);
    outGain.gain.setValueAtTime(outGain.gain.value, now);
    inGain.gain.linearRampToValueAtTime(1, now + t);
    outGain.gain.linearRampToValueAtTime(0, now + t);
    this.usingA = !this.usingA;
  }

  /** Switch the reverb space. Crossfades unless `immediate`. */
  setEnvironment(kind: EnvironmentKind, immediate = false): void {
    if (!this.available) {
      this.environment = kind;
      return;
    }
    if (kind === this.environment) return;
    this.environment = kind;
    this.envWetTarget = ENVIRONMENTS[kind].wet;
    this.installIR(kind, immediate);
  }

  /** Nudge wetness without changing the space — e.g. under a freeway deck. */
  setEnvironmentBlend(wetScale: number): void {
    this.wetScale = clamp(wetScale, 0, 2.5);
  }

  /**
   * Classify the listener's surroundings from the world geometry.
   *
   * This is a heuristic over `sfGeo` and nothing else — one source of truth for
   * where things are. Height above ground dominates (nothing reflects at 300 m),
   * then water, then park, then the district's density against the width of the
   * nearest street. A 30 m alley off Kearny is a very different room from
   * Market Street two blocks away and the mix should say so.
   */
  autoEnvironment(x: number, y: number, z: number): EnvironmentKind {
    const agl = y - terrainHeight(x, z);
    if (isWater(x, z)) return agl > 60 ? "open" : "bay";
    if (agl > 140) return "open";
    if (isPark(x, z)) return "open";

    const d = districtAt(x, z);
    const street = nearestStreet(x, z);
    const density = d.density;
    const tall = d.maxHeight;

    // Tall + dense + close to the street centreline = you are standing in the
    // slot between two towers.
    if (tall > 120 && density > 0.7 && agl < 90) {
      return street.distance < 26 ? "canyon" : "alley";
    }
    if (density > 0.85 && street.distance > 22 && agl < 30) return "alley";
    if (agl > 70) return "open";
    if (density < 0.35) return "open";
    return "street";
  }

  /** Convenience: classify + apply, with hysteresis handled by `update`. */
  setEnvironmentAuto(x: number, y: number, z: number): EnvironmentKind {
    const kind = this.autoEnvironment(x, y, z);
    this.pendingEnv = kind;
    return kind;
  }

  private pendingEnv: EnvironmentKind = "street";
  private envHold = 0;

  /** Preset data for the current space — the sound modules read this. */
  get env(): EnvPreset {
    return ENVIRONMENTS[this.environment];
  }

  /* ---------------- listener ---------------- */

  /**
   * Position the listener. Velocity is supplied separately because WebAudio
   * dropped doppler support years ago and we compute it ourselves per voice.
   */
  setListener(
    px: number,
    py: number,
    pz: number,
    fx: number,
    fy: number,
    fz: number,
    ux: number,
    uy: number,
    uz: number,
    vx = 0,
    vy = 0,
    vz = 0,
  ): void {
    const l = this.listener;
    l.x = px;
    l.y = py;
    l.z = pz;
    l.fx = fx;
    l.fy = fy;
    l.fz = fz;
    l.ux = ux;
    l.uy = uy;
    l.uz = uz;
    l.vx = vx;
    l.vy = vy;
    l.vz = vz;
    const ctx = this.ctx;
    if (!ctx) return;
    const li = ctx.listener as AudioListener & {
      positionX?: AudioParam;
      forwardX?: AudioParam;
      setPosition?: (x: number, y: number, z: number) => void;
      setOrientation?: (
        fx: number,
        fy: number,
        fz: number,
        ux: number,
        uy: number,
        uz: number,
      ) => void;
    };
    const t = ctx.currentTime;
    try {
      if (li.positionX) {
        // Ramping rather than setting stops zipper noise when the camera
        // teleports a few metres between frames (grapple, vehicle entry).
        const p = li as unknown as Record<string, AudioParam>;
        p.positionX.setTargetAtTime(px, t, 0.012);
        p.positionY.setTargetAtTime(py, t, 0.012);
        p.positionZ.setTargetAtTime(pz, t, 0.012);
        p.forwardX.setTargetAtTime(fx, t, 0.012);
        p.forwardY.setTargetAtTime(fy, t, 0.012);
        p.forwardZ.setTargetAtTime(fz, t, 0.012);
        p.upX.setTargetAtTime(ux, t, 0.012);
        p.upY.setTargetAtTime(uy, t, 0.012);
        p.upZ.setTargetAtTime(uz, t, 0.012);
      } else {
        li.setPosition?.(px, py, pz);
        li.setOrientation?.(fx, fy, fz, ux, uy, uz);
      }
    } catch {
      /* older Safari throws on some of these; the mix still works in stereo */
    }
  }

  /* ---------------- dynamics ---------------- */

  /**
   * Duck the whole mix. Used by explosions (everything else gets out of the
   * way of the blast) and by mission voice-over.
   */
  duck(amount: number, attack = 0.02, hold = 0.25, release = 0.6): void {
    const ctx = this.ctx;
    const g = this.duckGain;
    if (!ctx || !g) return;
    const now = ctx.currentTime;
    const target = clamp(1 - amount, 0.02, 1);
    // Only deepen an existing duck; a second explosion should not *raise* the
    // mix because its own duck is shallower.
    if (target >= g.gain.value - 1e-3 && g.gain.value < 0.999) return;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(target, now + attack);
    g.gain.setValueAtTime(target, now + attack + hold);
    g.gain.linearRampToValueAtTime(1, now + attack + hold + release);
  }

  /**
   * Concussion: everything goes muffled and distant for a moment. `intensity`
   * 0..1 sets how far the master lowpass closes; `seconds` how long it takes
   * to open back up.
   */
  deafen(intensity: number, seconds = 2.2): void {
    const ctx = this.ctx;
    const f = this.deafenFilter;
    if (!ctx || !f) return;
    const i = clamp01(intensity);
    if (i < 0.02) return;
    const now = ctx.currentTime;
    const cutoff = 20000 * Math.pow(0.032, i); // 20 kHz → ~640 Hz at full
    if (now < this.deafenUntil && f.frequency.value < cutoff) return;
    this.deafenUntil = now + seconds;
    f.frequency.cancelScheduledValues(now);
    f.frequency.setValueAtTime(Math.max(200, f.frequency.value), now);
    f.frequency.exponentialRampToValueAtTime(Math.max(200, cutoff), now + 0.02);
    f.frequency.exponentialRampToValueAtTime(20000, now + seconds);
  }

  /* ---------------- per-frame ---------------- */

  /**
   * Called once a frame. Cheap: it moves two smoothed scalars and, at most
   * once every 0.6 s, swaps the reverb. Everything here is allocation-free.
   */
  update(dt: number): void {
    if (!this.available || !this.ctx) return;

    // Environment hysteresis. Classification flips on the boundary between an
    // alley and a street; without a hold you get a reverb that stutters as the
    // player strafes across a doorway.
    this.envHold -= dt;
    if (this.pendingEnv !== this.environment && this.envHold <= 0) {
      this.setEnvironment(this.pendingEnv);
      this.envHold = 0.8;
    }

    this.envWetTarget = ENVIRONMENTS[this.environment].wet * this.wetScale;
    this.envWet = damp(this.envWet, this.envWetTarget, 3, dt);
    const now = this.ctx.currentTime;
    for (const name of BUS_NAMES) {
      const b = this.buses[name];
      if (!b) continue;
      const want = b.sendBase * this.envWet;
      if (Math.abs(b.send.gain.value - want) > 0.002) {
        b.send.gain.setTargetAtTime(want, now, 0.08);
      }
    }
  }

  /** Debug readout for the overlay. */
  stats(): {
    state: string;
    environment: EnvironmentKind;
    wet: number;
    blocked: boolean;
    muted: boolean;
  } {
    return {
      state: this.ctx?.state ?? "none",
      environment: this.environment,
      wet: this.envWet,
      blocked: this.blocked,
      muted: this.settings.muted,
    };
  }
}

/* Deterministic RNG per environment — the same alley must render the same
 * impulse response on every machine and in the screenshot harness. */
function makeIrRng(kind: EnvironmentKind): Rng {
  return makeRng(`sf-audio:ir:${kind}`);
}

/** The one engine. Import it; do not construct another. */
export const audioEngine = new AudioEngine();

/**
 * Update the environment classification from the player's own frame state.
 * Called by `Audio.tsx`; exposed so a cutscene can force it too.
 */
export function updateEnvironmentFromFrame(): EnvironmentKind {
  return audioEngine.setEnvironmentAuto(frame.position.x, frame.position.y, frame.position.z);
}
