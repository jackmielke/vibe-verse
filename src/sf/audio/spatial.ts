/**
 * audio/spatial.ts — positional voices, and the budget that keeps them honest.
 *
 * The whole module exists to answer one question cheaply, thousands of times a
 * minute: *given that something happened at (x, y, z), what should the player
 * hear, and can we afford to play it at all?*
 *
 * The answers:
 *
 *  - **Voices are pooled.** A `Voice` owns a permanent chain
 *    `input → occlusion LP → gain → panner → out → bus`. Playing a sound
 *    connects one AudioBufferSourceNode (the only node WebAudio forces us to
 *    allocate) and nothing else. There is no per-shot `createGain`, no
 *    `createPanner`, no closure garbage in the frame loop.
 *
 *  - **The cap is hard.** `settings.maxVoices` positional voices exist and no
 *    more will ever be created. When they are all busy, a new sound must beat
 *    an existing one on priority to be heard; if it cannot, it is dropped
 *    silently. That is what stops a 12-gauge in a crowd from turning into a
 *    thousand-node graph and a two-second stall.
 *
 *  - **Doppler is ours.** WebAudio removed doppler in 2014. Real doppler is
 *    just a playback-rate scale from the closing speed along the source→
 *    listener axis, and doing it by hand means it also works for the
 *    oscillator-based engine and rotor voices, which a PannerNode never could.
 *
 *  - **Distance is more than gain.** Every voice gets air absorption (a
 *    lowpass whose cutoff falls with range), optional propagation delay (a
 *    rifle 400 m away arrives 1.2 s late, and that delay is most of why it
 *    reads as *far*), and an occlusion lowpass driven by the engine's probe.
 *
 * Public API
 * ----------
 *   voicePool.acquire / release / update / stats / setMaxVoices / stopAll
 *   Voice (input, gain, setPosition, setOcclusion, hold, releaseAt)
 *   playBuffer / playBufferAt / stopVoice
 *   distanceTo / dopplerRate / listenerRelative
 */
import { clamp, clamp01 } from "../math/rng";
import { audioEngine, probeOcclusion, type BusName } from "./engine";
import { SPEED_OF_SOUND, airCutoff } from "./synth";

/* ================================================================== *
 * Options
 * ================================================================== */

export interface VoiceOptions {
  /** World position of the source. */
  x: number;
  y: number;
  z: number;
  /** Source velocity, m/s. Used for doppler only. */
  vx?: number;
  vy?: number;
  vz?: number;
  bus?: BusName;
  /** Linear gain at the reference distance. */
  gain?: number;
  /** Playback-rate multiplier applied on top of doppler. */
  pitch?: number;
  /**
   * 0..1. High-priority sounds steal voices from low-priority ones. Player
   * gunfire is 1; a distant seagull is 0.05.
   */
  priority?: number;
  /**
   * Audible radius in metres. Sets sensible reference/max distances in one
   * number — this is the same "loudness" the weapon registry publishes and the
   * AI uses for alerting, so gunshots are heard exactly as far as they carry.
   */
  loudness?: number;
  refDistance?: number;
  maxDistance?: number;
  rolloff?: number;
  /** Non-positional: plays in stereo at `pan`, no attenuation. First-person. */
  local?: boolean;
  pan?: number;
  /** 0..1 explicit occlusion, or omit to raycast via the engine probe. */
  occlusion?: number;
  /** Skip the occlusion probe entirely (already-muffled sounds, UI). */
  noOcclusion?: boolean;
  /** Delay the sound by distance / speed of sound. */
  propagate?: boolean;
  /** Absolute context time to start at. Defaults to `now`. */
  when?: number;
  /** Expected length; the voice self-releases after it. */
  duration?: number;
  /** Directional cone, degrees. Sirens and exhausts are directional. */
  coneInner?: number;
  coneOuter?: number;
  coneOuterGain?: number;
  /** Cone axis (normalised). */
  dx?: number;
  dy?: number;
  dz?: number;
}

/** Reusable options record for hot paths that must not allocate. */
export const scratchOptions: VoiceOptions = { x: 0, y: 0, z: 0 };

/**
 * Reset the shared scratch record and hand it back.
 *
 * Every play path in this directory starts here. Reusing one mutable options
 * object is what keeps a 900 RPM LMG from allocating fifteen objects a second,
 * but it means a field left over from the *previous* sound leaks into the
 * next one — a stale `when` schedules a footstep half a second late, a stale
 * velocity gives a stationary impact the doppler of the car that fired at it.
 * Those bugs are miserable to find by ear, so the reset is not optional and
 * not the caller's judgement call.
 */
export function beginOptions(): VoiceOptions {
  const o = scratchOptions;
  o.x = 0;
  o.y = 0;
  o.z = 0;
  o.vx = 0;
  o.vy = 0;
  o.vz = 0;
  o.bus = "world";
  o.gain = 1;
  o.pitch = 1;
  o.priority = 0.5;
  o.loudness = undefined;
  o.refDistance = undefined;
  o.maxDistance = undefined;
  o.rolloff = undefined;
  o.local = false;
  o.pan = 0;
  o.occlusion = undefined;
  o.noOcclusion = false;
  o.propagate = false;
  o.when = undefined;
  o.duration = undefined;
  o.coneInner = undefined;
  o.coneOuter = undefined;
  o.coneOuterGain = undefined;
  o.dx = undefined;
  o.dy = undefined;
  o.dz = undefined;
  return o;
}

/* ================================================================== *
 * Voice
 * ================================================================== */

let voiceSerial = 0;

export class Voice {
  readonly id = ++voiceSerial;

  /** Connect your sources here. */
  input: GainNode;
  /** Envelope/level for the whole voice; callers own its automation. */
  gain: GainNode;

  private lp: BiquadFilterNode;
  private panner: PannerNode | null;
  private stereo: StereoPannerNode | null;
  private out: GainNode;
  private connectedBus: BusName | null = null;
  private usingPanner = false;
  /**
   * Head-locked voices (ambience beds, music, first-person foley) are exempt
   * from distance, air absorption and occlusion entirely. Without this flag a
   * bed anchored at the world origin gets muffled as the player walks away
   * from Montgomery & Market, which is both wrong and extremely confusing to
   * debug — it sounds like the mix is broken rather than the geometry.
   */
  private isLocal = false;

  /** Housekeeping, read by the pool. */
  active = false;
  /** Persistent voices (engines, ambience beds) are never auto-released. */
  hold = false;
  priority = 0;
  startedAt = 0;
  endsAt = 0;
  /** Earliest context time this voice can produce sound (post-steal fade). */
  readyAt = 0;

  /** Last known source position — kept for occlusion re-probing. */
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;

  /** Metres to the listener, refreshed by the pool. */
  distance = 0;
  /** 0..1 as last probed. */
  occlusion = 0;
  private occlusionTarget = 0;
  private probeAccum = 0;
  private probeEnabled = true;
  private loudness = 200;
  private baseGain = 1;

  /** Called by the pool when this voice is stolen, so owners can forget it. */
  onSteal: (() => void) | null = null;

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.lp = ctx.createBiquadFilter();
    this.lp.type = "lowpass";
    this.lp.frequency.value = 20000;
    this.lp.Q.value = 0.4;
    this.gain = ctx.createGain();
    this.gain.gain.value = 1;
    this.out = ctx.createGain();
    this.out.gain.value = 1;

    this.input.connect(this.lp);
    this.lp.connect(this.gain);

    // Both panners exist for the lifetime of the voice; we only ever switch
    // which one the gain feeds. Creating a PannerNode costs an HRTF table
    // lookup and is not something to do 30 times a second.
    try {
      this.panner = ctx.createPanner();
      this.panner.panningModel = "HRTF";
      this.panner.distanceModel = "inverse";
      this.panner.refDistance = 6;
      this.panner.maxDistance = 3000;
      this.panner.rolloffFactor = 1;
      this.panner.coneInnerAngle = 360;
      this.panner.coneOuterAngle = 360;
      this.panner.coneOuterGain = 1;
      this.panner.connect(this.out);
    } catch {
      this.panner = null;
    }
    try {
      this.stereo = ctx.createStereoPanner();
      this.stereo.connect(this.out);
    } catch {
      this.stereo = null;
    }
    if (!this.panner && !this.stereo) {
      // Ancient browser: straight through, mono, still audible.
      this.gain.connect(this.out);
    }
  }

  /** Wire this voice to a bus and configure it for a play. */
  begin(opts: VoiceOptions, ctx: BaseAudioContext): void {
    const bus = opts.bus ?? "world";
    const busNode = audioEngine.bus(bus);
    if (busNode && this.connectedBus !== bus) {
      try {
        this.out.disconnect();
      } catch {
        /* was not connected */
      }
      this.out.connect(busNode);
      this.connectedBus = bus;
    }

    const local = !!opts.local;
    this.isLocal = local;
    const wantPanner = !local && !!this.panner;
    if (wantPanner !== this.usingPanner || !this.active) {
      try {
        this.gain.disconnect();
      } catch {
        /* fresh */
      }
      if (wantPanner && this.panner) this.gain.connect(this.panner);
      else if (this.stereo) this.gain.connect(this.stereo);
      else this.gain.connect(this.out);
      this.usingPanner = wantPanner;
    }

    this.baseGain = opts.gain ?? 1;
    this.priority = opts.priority ?? 0.5;
    this.loudness = opts.loudness ?? 220;
    this.probeEnabled = !opts.noOcclusion && !local;
    this.probeAccum = 0;

    if (local) {
      if (this.stereo) this.stereo.pan.value = clamp(opts.pan ?? 0, -1, 1);
      this.lp.frequency.value = 20000;
      this.occlusion = 0;
      this.occlusionTarget = 0;
      this.distance = 0;
      const t0 = ctx.currentTime;
      this.out.gain.cancelScheduledValues(t0);
      this.out.gain.setValueAtTime(this.out.gain.value, t0);
      this.out.gain.linearRampToValueAtTime(1, t0 + 0.004);
    } else {
      const ref = opts.refDistance ?? clamp(this.loudness * 0.035, 2.5, 40);
      const max = opts.maxDistance ?? Math.max(ref * 4, this.loudness);
      const roll = opts.rolloff ?? 1.05;
      const p = this.panner;
      if (p) {
        p.refDistance = ref;
        p.maxDistance = max;
        p.rolloffFactor = roll;
        p.panningModel = audioEngine.settings.hrtf ? "HRTF" : "equalpower";
        if (opts.coneInner !== undefined) {
          p.coneInnerAngle = opts.coneInner;
          p.coneOuterAngle = opts.coneOuter ?? 360;
          p.coneOuterGain = opts.coneOuterGain ?? 0.4;
        } else {
          p.coneInnerAngle = 360;
          p.coneOuterAngle = 360;
          p.coneOuterGain = 1;
        }
      }
      this.setPosition(opts.x, opts.y, opts.z, opts.vx ?? 0, opts.vy ?? 0, opts.vz ?? 0);
      if (opts.dx !== undefined && p) this.setOrientation(opts.dx, opts.dy ?? 0, opts.dz ?? 0);
      this.occlusionTarget = opts.occlusion ?? (this.probeEnabled ? this.probe() : 0);
      this.occlusion = this.occlusionTarget;
      this.applyFilter(true);
    }

    this.gain.gain.cancelScheduledValues(ctx.currentTime);
    this.gain.gain.value = this.baseGain;
    this.active = true;
    this.hold = false;
    this.startedAt = ctx.currentTime;
    this.endsAt = this.startedAt + (opts.duration ?? 2);
  }

  setPosition(x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.vx = vx;
    this.vy = vy;
    this.vz = vz;
    const p = this.panner;
    if (!p) return;
    const t = audioEngine.now;
    const px = (p as PannerNode & { positionX?: AudioParam }).positionX;
    if (px) {
      // setTargetAtTime rather than setValueAtTime: a helicopter moving 60 m/s
      // jumps a metre per frame, and stepping a panner position produces
      // audible zipper artefacts on the HRTF convolution.
      const pp = p as unknown as Record<string, AudioParam>;
      pp.positionX.setTargetAtTime(x, t, 0.015);
      pp.positionY.setTargetAtTime(y, t, 0.015);
      pp.positionZ.setTargetAtTime(z, t, 0.015);
    } else {
      (p as PannerNode & { setPosition?: (a: number, b: number, c: number) => void }).setPosition?.(
        x,
        y,
        z,
      );
    }
  }

  setOrientation(dx: number, dy: number, dz: number): void {
    const p = this.panner;
    if (!p) return;
    const t = audioEngine.now;
    const ox = (p as PannerNode & { orientationX?: AudioParam }).orientationX;
    if (ox) {
      const pp = p as unknown as Record<string, AudioParam>;
      pp.orientationX.setTargetAtTime(dx, t, 0.03);
      pp.orientationY.setTargetAtTime(dy, t, 0.03);
      pp.orientationZ.setTargetAtTime(dz, t, 0.03);
    } else {
      (
        p as PannerNode & { setOrientation?: (a: number, b: number, c: number) => void }
      ).setOrientation?.(dx, dy, dz);
    }
  }

  /** Explicit occlusion override, 0..1. Disables the automatic probe. */
  setOcclusion(v: number): void {
    this.probeEnabled = false;
    this.occlusionTarget = clamp01(v);
  }

  private probe(): number {
    const l = audioEngine.listener;
    return probeOcclusion(this.x, this.y, this.z, l.x, l.y, l.z);
  }

  /**
   * Fold distance, air absorption, occlusion and the environment's damping
   * into one lowpass cutoff.
   *
   * Occlusion is modelled as a lowpass rather than an attenuation because that
   * is what a wall actually does — low frequencies diffract around and through
   * it, high ones do not. Turning the volume down instead is the single most
   * common mistake in game audio and it always sounds like the source moved
   * away rather than went behind something.
   */
  private applyFilter(immediate: boolean): void {
    if (this.isLocal) return;
    const air = airCutoff(this.distance) * audioEngine.env.airDamping;
    const occ = this.occlusion;
    const occCut = 20000 * Math.pow(0.028, occ * occ);
    const cut = clamp(Math.min(air, occCut), 180, 20000);
    const t = audioEngine.now;
    // Guard on change: 48 voices × 2 params × 60 Hz is 5,760 automation events
    // a second, almost all of them setting a value to what it already is.
    if (immediate) {
      this.lp.frequency.cancelScheduledValues(t);
      this.lp.frequency.setValueAtTime(cut, t);
    } else if (Math.abs(this.lp.frequency.value - cut) > cut * 0.02) {
      this.lp.frequency.setTargetAtTime(cut, t, 0.12);
    }

    // Occlusion also loses a little level — a wall absorbs, it does not only
    // filter. Modest, because the filter is doing the heavy lifting.
    const level = 1 - occ * 0.45;
    if (immediate) {
      // Ramp rather than jump: this voice may still be fading out from a steal.
      this.out.gain.cancelScheduledValues(t);
      this.out.gain.setValueAtTime(this.out.gain.value, t);
      this.out.gain.linearRampToValueAtTime(level, t + 0.004);
    } else if (Math.abs(this.out.gain.value - level) > 0.01) {
      this.out.gain.setTargetAtTime(level, t, 0.12);
    }
  }

  /** Per-frame maintenance, driven by the pool. */
  tick(dt: number): void {
    if (this.isLocal) return;
    const l = audioEngine.listener;
    const dx = this.x - l.x;
    const dy = this.y - l.y;
    const dz = this.z - l.z;
    this.distance = Math.hypot(dx, dy, dz);

    if (this.probeEnabled) {
      // Re-probing every frame per voice would be dozens of raycasts a frame.
      // Distant sources move slowly in angular terms and can be probed lazily;
      // close ones matter and get probed at ~10 Hz.
      this.probeAccum -= dt;
      if (this.probeAccum <= 0) {
        this.occlusionTarget = this.probe();
        this.probeAccum = this.distance < 40 ? 0.1 : this.distance < 200 ? 0.25 : 0.6;
      }
    }
    const rate = 1 - Math.exp(-6 * dt);
    this.occlusion += (this.occlusionTarget - this.occlusion) * rate;
    this.applyFilter(false);
  }

  /** Doppler playback-rate scale for this voice's current motion. */
  dopplerScale(): number {
    return dopplerRate(this.x, this.y, this.z, this.vx, this.vy, this.vz);
  }

  /** Schedule the voice to be recycled at absolute context time `t`. */
  releaseAt(t: number): void {
    this.endsAt = t;
    this.hold = false;
  }

  /** Immediately silence and recycle. */
  reset(fade = 0.006): void {
    const ctx = audioEngine.ctx;
    if (ctx) {
      const now = ctx.currentTime;
      try {
        this.out.gain.cancelScheduledValues(now);
        this.out.gain.setValueAtTime(this.out.gain.value, now);
        // Fade to silence and stay there. `begin` ramps back up when this
        // slot is reused, so a recycled voice never inherits a stale level.
        this.out.gain.linearRampToValueAtTime(0, now + fade);
      } catch {
        /* context closing */
      }
      // Sever whatever the previous owner attached without touching its nodes;
      // they finish playing into nothing and are collected when they stop.
      try {
        this.input.disconnect();
      } catch {
        /* already clean */
      }
      this.input.connect(this.lp);
      this.readyAt = now + fade + 0.002;
    }
    this.active = false;
    this.hold = false;
    this.isLocal = false;
    this.priority = 0;
    this.onSteal = null;
  }

  /** Tear down permanently. */
  destroy(): void {
    try {
      this.input.disconnect();
      this.lp.disconnect();
      this.gain.disconnect();
      this.panner?.disconnect();
      this.stereo?.disconnect();
      this.out.disconnect();
    } catch {
      /* context gone */
    }
  }
}

/* ================================================================== *
 * Pool
 * ================================================================== */

class VoicePool {
  private voices: Voice[] = [];
  private ctx: BaseAudioContext | null = null;
  private max = 48;

  /** Counters for the debug overlay. */
  readonly stats = { active: 0, held: 0, stolen: 0, dropped: 0, peak: 0 };

  ensure(): boolean {
    const ctx = audioEngine.ctx;
    if (!ctx) return false;
    if (this.ctx !== ctx) {
      // Context replaced (dispose + re-init). Old voices belong to a dead
      // graph; drop them wholesale rather than trying to migrate nodes.
      for (const v of this.voices) v.destroy();
      this.voices.length = 0;
      this.ctx = ctx;
    }
    this.max = audioEngine.settings.maxVoices;
    return true;
  }

  setMaxVoices(n: number): void {
    this.max = clamp(Math.round(n), 8, 128);
    audioEngine.settings.maxVoices = this.max;
    while (this.voices.length > this.max) {
      const v = this.voices.pop();
      v?.destroy();
    }
  }

  /**
   * Get a voice, or null if this sound does not deserve one.
   *
   * Order of preference: an idle voice, then growing the pool if under budget,
   * then stealing the *least important* live voice — where importance is
   * priority first and remaining lifetime second, so we steal a nearly-finished
   * background sound before a fresh important one.
   */
  acquire(opts: VoiceOptions): Voice | null {
    if (!audioEngine.available || audioEngine.settings.muted) return null;
    if (!this.ensure()) return null;
    const ctx = this.ctx!;

    for (const v of this.voices) {
      if (!v.active) {
        v.begin(opts, ctx);
        return v;
      }
    }

    if (this.voices.length < this.max) {
      const v = new Voice(ctx);
      this.voices.push(v);
      v.begin(opts, ctx);
      if (this.voices.length > this.stats.peak) this.stats.peak = this.voices.length;
      return v;
    }

    const wantPriority = opts.priority ?? 0.5;
    let victim: Voice | null = null;
    let worst = Number.POSITIVE_INFINITY;
    const now = ctx.currentTime;
    for (const v of this.voices) {
      if (v.hold) continue; // engines and ambience beds are never stolen
      const remaining = Math.max(0, v.endsAt - now);
      const score = v.priority * 100 + Math.min(remaining, 3);
      if (score < worst) {
        worst = score;
        victim = v;
      }
    }
    if (!victim || victim.priority > wantPriority + 0.001) {
      this.stats.dropped++;
      return null;
    }
    victim.onSteal?.();
    victim.reset();
    this.stats.stolen++;
    victim.begin(opts, ctx);
    return victim;
  }

  /** Recycle a voice explicitly. */
  release(v: Voice | null): void {
    if (!v) return;
    v.reset();
  }

  /** Per-frame: tick live voices and reap expired ones. */
  update(dt: number): void {
    if (!audioEngine.available) return;
    const ctx = audioEngine.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    let active = 0;
    let held = 0;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (!v.active) continue;
      active++;
      if (v.hold) held++;
      else if (now >= v.endsAt) {
        v.reset(0.004);
        active--;
        continue;
      }
      v.tick(dt);
    }
    this.stats.active = active;
    this.stats.held = held;
  }

  /** Kill everything (level transition, mute, teardown). */
  stopAll(): void {
    for (const v of this.voices) {
      if (v.active) {
        v.onSteal?.();
        v.reset(0.01);
      }
    }
    this.stats.active = 0;
    this.stats.held = 0;
  }

  dispose(): void {
    for (const v of this.voices) v.destroy();
    this.voices.length = 0;
    this.ctx = null;
  }

  get size(): number {
    return this.voices.length;
  }
}

export const voicePool = new VoicePool();

/* ================================================================== *
 * Helpers
 * ================================================================== */

export function distanceTo(x: number, y: number, z: number): number {
  const l = audioEngine.listener;
  return Math.hypot(x - l.x, y - l.y, z - l.z);
}

/**
 * Doppler playback rate for a source at (x,y,z) moving at (vx,vy,vz).
 *
 * f' = f * (c + v_listener·r̂) / (c + v_source·r̂), clamped hard: a stray
 * velocity of 300 m/s from a physics glitch must not produce a rate of 8 and
 * a burst of white noise. Real cars top out around ±6 %.
 */
export function dopplerRate(
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
): number {
  const l = audioEngine.listener;
  let rx = x - l.x;
  let ry = y - l.y;
  let rz = z - l.z;
  const d = Math.hypot(rx, ry, rz);
  if (d < 0.5) return 1;
  const inv = 1 / d;
  rx *= inv;
  ry *= inv;
  rz *= inv;
  // Positive = source receding from listener along r̂.
  const vs = vx * rx + vy * ry + vz * rz;
  const vl = l.vx * rx + l.vy * ry + l.vz * rz;
  const c = SPEED_OF_SOUND;
  const rate = (c - vl) / Math.max(c * 0.35, c - vs);
  return clamp(rate, 0.68, 1.55);
}

/** Fill `out` with the listener-relative offset. Allocation-free. */
export function listenerRelative(
  x: number,
  y: number,
  z: number,
  out: { x: number; y: number; z: number },
): number {
  const l = audioEngine.listener;
  out.x = x - l.x;
  out.y = y - l.y;
  out.z = z - l.z;
  return Math.hypot(out.x, out.y, out.z);
}

/**
 * The workhorse: play a baked buffer at a world position.
 *
 * Returns the voice so the caller can keep automating it, or null if the
 * sound was culled (out of range, over budget, muted, audio blocked).
 */
export function playBuffer(buffer: AudioBuffer | null, opts: VoiceOptions): Voice | null {
  if (!buffer) return null;
  const ctx = audioEngine.ctx;
  if (!ctx || !audioEngine.available) return null;

  // Range cull before we spend a voice on something inaudible.
  let dist = 0;
  if (!opts.local) {
    dist = distanceTo(opts.x, opts.y, opts.z);
    const maxAudible = opts.maxDistance ?? opts.loudness ?? 400;
    if (dist > maxAudible * 1.15) return null;
  }

  const rate = (opts.pitch ?? 1) * (opts.local ? 1 : dopplerRate(
    opts.x,
    opts.y,
    opts.z,
    opts.vx ?? 0,
    opts.vy ?? 0,
    opts.vz ?? 0,
  ));

  const dur = buffer.duration / Math.max(0.05, rate);
  const prev = opts.duration;
  opts.duration = dur + 0.05;
  const voice = voicePool.acquire(opts);
  opts.duration = prev;
  if (!voice) return null;

  let when = opts.when ?? ctx.currentTime;
  if (opts.propagate && dist > 12) when += dist / SPEED_OF_SOUND;
  when = Math.max(when, voice.readyAt, ctx.currentTime);
  voice.endsAt = when + dur + 0.08;

  try {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(voice.input);
    src.start(when);
    src.onended = () => {
      try {
        src.disconnect();
      } catch {
        /* torn down */
      }
    };
    voice.onSteal = () => {
      try {
        src.stop();
      } catch {
        /* not started */
      }
    };
  } catch {
    voicePool.release(voice);
    return null;
  }
  return voice;
}

/** Play a buffer at an explicit context time (used by the music scheduler). */
export function playBufferAt(
  buffer: AudioBuffer | null,
  when: number,
  bus: BusName,
  gain: number,
  pitch = 1,
  pan = 0,
): Voice | null {
  const o = beginOptions();
  o.local = true;
  o.bus = bus;
  o.gain = gain;
  o.pitch = pitch;
  o.pan = pan;
  o.priority = 0.4;
  o.when = when;
  o.noOcclusion = true;
  return playBuffer(buffer, o);
}

/** Stop and recycle a voice you are holding. */
export function stopVoice(v: Voice | null, fade = 0.05): void {
  if (!v) return;
  const ctx = audioEngine.ctx;
  if (ctx) {
    const now = ctx.currentTime;
    try {
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(v.gain.gain.value, now);
      v.gain.gain.linearRampToValueAtTime(0.0001, now + fade);
    } catch {
      /* ignore */
    }
    v.hold = false;
    v.endsAt = now + fade + 0.01;
  } else {
    v.reset();
  }
}
