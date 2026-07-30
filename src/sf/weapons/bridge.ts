/**
 * weapons/bridge.ts — the seams to systems this module does not own.
 *
 * Weapons need to make noise, spawn effects, hurt entities and know where
 * those entities were a fifth of a second ago. Three of those four belong to
 * other subsystems (`@/sf/audio`, `@/sf/vfx`, the AI/entity layer) which may or
 * may not exist yet in any given build of the game. Rather than import them —
 * which would make the whole weapon stack fail to compile the day someone
 * renames a file — everything crosses this boundary through a registered sink.
 *
 * The contract, in both directions:
 *   - If nobody registers, weapons still work. Every sink has a working
 *     built-in fallback, including a procedural gunshot synthesiser. A pistol
 *     shot with no audio system attached still cracks and still echoes off the
 *     Financial District.
 *   - A sink can be registered at any time, from anywhere, without weapons
 *     re-mounting: `setWeaponAudioSink(sfAudio.weaponSink)` in an effect is
 *     the whole integration.
 *   - We also sniff `globalThis.__sfAudio` / `__sfVfx` once, because that is
 *     the pattern the debug harness already uses (`window.__sf`) and it lets a
 *     late-loading system attach without touching this file.
 *
 * Public API
 * ----------
 *   setWeaponAudioSink / setWeaponVfxSink / setWeaponDamageSink
 *   setHitboxProvider / hitboxProvider
 *   playWeaponSound(...)     routed to the sink or the fallback synth
 *   emitVfx(...)             routed to the sink; returns false if unhandled
 *   applyEntityDamage(...)   routed to the sink or to the physics ref
 *   environmentEcho(...)     cached reverb estimate from the surrounding city
 *   primeWeaponAudio()       unlock the AudioContext on a user gesture
 */
import { makeRayHit, raycast, type PhysicsObject } from "../physics";
import { makeRng } from "../math/rng";
import { clamp, clamp01 } from "../math/rng";
import type { HitboxProvider, WeaponDef, WeaponHit } from "./types";

/* ------------------------------------------------------------------ *
 * Sink interfaces
 * ------------------------------------------------------------------ */

export interface WeaponSoundOpts {
  /** World position of the source. */
  x: number;
  y: number;
  z: number;
  /** Linear gain multiplier, 1 = the bank's authored level. */
  volume?: number;
  /** Playback rate multiplier. */
  pitch?: number;
  /** Metres at which the sound becomes inaudible — also the AI alert radius. */
  loudness?: number;
  /** First-person sounds bypass distance attenuation entirely. */
  local?: boolean;
  /** Reverb hint, 0..1, from `environmentEcho`. */
  wet?: number;
  /** Pre-delay of the first slapback, seconds. */
  echoDelay?: number;
}

export interface WeaponAudioSink {
  play(bank: string, opts: WeaponSoundOpts): void;
}

/** Effect events a dedicated VFX system may want to take over from us. */
export type WeaponVfxEvent =
  | "muzzleFlash"
  | "tracer"
  | "impact"
  | "casing"
  | "smoke"
  | "explosion"
  | "hitmarker";

export interface WeaponVfxSink {
  /** Return true if the sink handled the event; false falls back to ours. */
  emit(event: WeaponVfxEvent, data: Record<string, number | string | boolean>): boolean;
}

/**
 * Damage against a gameplay entity. Return the damage actually applied (so the
 * weapon can decide whether to show a hitmarker) and whether it was lethal.
 */
export type WeaponDamageSink = (
  target: PhysicsObject | null,
  targetId: number,
  amount: number,
  hit: WeaponHit,
  def: WeaponDef,
) => { applied: number; killed: boolean } | void;

let audioSink: WeaponAudioSink | null = null;
let vfxSink: WeaponVfxSink | null = null;
let damageSink: WeaponDamageSink | null = null;
let hitboxes: HitboxProvider | null = null;

export function setWeaponAudioSink(s: WeaponAudioSink | null): void {
  audioSink = s;
}
export function setWeaponVfxSink(s: WeaponVfxSink | null): void {
  vfxSink = s;
}
export function setWeaponDamageSink(s: WeaponDamageSink | null): void {
  damageSink = s;
}
export function setHitboxProvider(p: HitboxProvider | null): void {
  hitboxes = p;
}
export function hitboxProvider(): HitboxProvider | null {
  return hitboxes;
}

/**
 * Late-binding discovery. Called once per frame from the weapon component (it
 * is two property reads); a system that boots after us is picked up on its
 * first frame rather than never.
 */
export function pollGlobalSinks(): void {
  if (typeof globalThis === "undefined") return;
  const g = globalThis as Record<string, unknown>;
  if (!audioSink) {
    const a = g.__sfAudio as { weaponSink?: WeaponAudioSink; play?: unknown } | undefined;
    if (a?.weaponSink) audioSink = a.weaponSink;
    else if (a && typeof a.play === "function") audioSink = a as unknown as WeaponAudioSink;
  }
  if (!vfxSink) {
    const v = g.__sfVfx as { weaponSink?: WeaponVfxSink; emit?: unknown } | undefined;
    if (v?.weaponSink) vfxSink = v.weaponSink;
    else if (v && typeof v.emit === "function") vfxSink = v as unknown as WeaponVfxSink;
  }
}

/* ------------------------------------------------------------------ *
 * VFX + damage routing
 * ------------------------------------------------------------------ */

const _vfxData: Record<string, number | string | boolean> = {};

export function emitVfx(
  event: WeaponVfxEvent,
  fill: (d: Record<string, number | string | boolean>) => void,
): boolean {
  if (!vfxSink) return false;
  for (const k in _vfxData) delete _vfxData[k];
  fill(_vfxData);
  try {
    return vfxSink.emit(event, _vfxData) === true;
  } catch {
    // A misbehaving VFX system must never take the gun offline.
    vfxSink = null;
    return false;
  }
}

/**
 * Hurt whatever we hit.
 *
 * Order: the registered sink wins; failing that we look for an `applyDamage`
 * on the physics object's gameplay ref, which is the convention the entity
 * layer already uses. Destructibles are handled by the caller through
 * `destruction.applyDamage`, not here — they are not entities.
 */
export function applyEntityDamage(
  target: PhysicsObject | null,
  targetId: number,
  amount: number,
  hit: WeaponHit,
  def: WeaponDef,
): { applied: number; killed: boolean } {
  if (damageSink) {
    const r = damageSink(target, targetId, amount, hit, def);
    if (r) return r;
    return { applied: amount, killed: false };
  }
  const ref = target?.ref as { applyDamage?: (n: number, h: WeaponHit) => unknown } | null;
  if (ref && typeof ref.applyDamage === "function") {
    const killed = ref.applyDamage(amount, hit) === true;
    return { applied: amount, killed };
  }
  return { applied: 0, killed: false };
}

/* ------------------------------------------------------------------ *
 * Environmental reverb estimate
 * ------------------------------------------------------------------ */

export interface EchoEstimate {
  /** Seconds to the first reflection. */
  delay: number;
  /** 0..1 reflected energy — a canyon of glass towers is near 1, Ocean Beach 0. */
  wet: number;
  /** 0..1 brightness of the tail; open water and parks eat the highs. */
  brightness: number;
}

const echo: EchoEstimate = { delay: 0.09, wet: 0.35, brightness: 0.5 };
const _echoHit = makeRayHit();
let echoStamp = -1e9;
let echoX = 1e9;
let echoZ = 1e9;

/**
 * Estimate the report tail by asking the world how enclosed we are.
 *
 * Eight rays on a horizontal ring, one up. Cheap, and re-run at most twice a
 * second or when the listener has moved 10 m — a gunfight in one alley does
 * not need this recomputed 900 times. The result is what makes a shot in the
 * Financial District ring for half a second and the same shot on Ocean Beach
 * die instantly, which is most of what sells a gun's power.
 */
export function environmentEcho(x: number, y: number, z: number): EchoEstimate {
  const now = typeof performance !== "undefined" ? performance.now() * 0.001 : 0;
  const moved = Math.abs(x - echoX) + Math.abs(z - echoZ) > 10;
  if (!moved && now - echoStamp < 0.5) return echo;
  echoStamp = now;
  echoX = x;
  echoZ = z;

  const MAX = 90;
  let sum = 0;
  let hits = 0;
  let nearest = MAX;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    if (raycast(x, y, z, dx, 0.06, dz, MAX, _echoHit, { skipSurface: true })) {
      sum += _echoHit.distance;
      hits++;
      if (_echoHit.distance < nearest) nearest = _echoHit.distance;
    } else {
      sum += MAX;
    }
  }
  const mean = sum / 8;
  const enclosure = clamp01(hits / 8);
  // Speed of sound: the slapback is the round trip to the mean reflector.
  echo.delay = clamp((2 * Math.max(4, mean)) / 343, 0.02, 0.42);
  echo.wet = clamp01(enclosure * (1 - mean / MAX) * 1.6);
  // Close hard walls keep the highs; distant soft ones (foliage, water) don't.
  echo.brightness = clamp01(0.25 + 0.75 * (1 - nearest / MAX));
  return echo;
}

/* ------------------------------------------------------------------ *
 * Fallback procedural gunshot synthesiser
 * ------------------------------------------------------------------ */

/**
 * A small WebAudio synth so the guns are never silent.
 *
 * This is not a stand-in for a real audio system — it has no mixing buses, no
 * occlusion, no music ducking. It is here because "layer everything" includes
 * sound, and a muzzle flash with no crack feels broken in a way no amount of
 * particle work fixes. Structure of a shot:
 *
 *   crack  — 2 ms of white noise through a high bandpass, the supersonic snap
 *   body   — a fast pitch-dropping sine, the chamber pressure
 *   tail   — noise through a lowpass with an exponential decay, length and
 *            brightness driven by `environmentEcho`
 *   slaps  — two delayed, filtered copies of the tail: the buildings
 *
 * Everything is built from one shared, deterministically-generated noise
 * buffer, so no per-shot allocation beyond the (unavoidable) node graph.
 */
class FallbackGunAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private failed = false;
  /** Shots started in the current 100 ms window — hard-limits the node churn. */
  private recent = 0;
  private recentStamp = 0;

  private ensure(): boolean {
    if (this.failed) return false;
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
      return true;
    }
    try {
      const Ctor =
        (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
          .AudioContext ??
        (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        this.failed = true;
        return false;
      }
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);

      // 1.5 s of deterministic pink-ish noise, shared by every shot.
      const len = Math.floor(ctx.sampleRate * 1.5);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      const rng = makeRng("sf-weapon-noise");
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      for (let i = 0; i < len; i++) {
        const white = rng.next() * 2 - 1;
        // Paul Kellet's economy pink filter — white noise alone sounds like
        // a hiss, pink sounds like a gunshot tail.
        b0 = 0.99765 * b0 + white * 0.0990460;
        b1 = 0.96300 * b1 + white * 0.2965164;
        b2 = 0.57000 * b2 + white * 1.0526913;
        data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.32;
      }

      this.ctx = ctx;
      this.master = master;
      this.noise = buf;
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }

  prime(): void {
    this.ensure();
  }

  /** Unlock a suspended context; call from a real user gesture. */
  resume(): void {
    if (this.ctx && this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => undefined);
    }
  }

  private budgetOk(t: number): boolean {
    if (t - this.recentStamp > 0.1) {
      this.recentStamp = t;
      this.recent = 0;
    }
    return this.recent++ < 6;
  }

  private noiseSource(t: number, dur: number, offset: number): AudioBufferSourceNode | null {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    try {
      src.start(t, offset % 1.4, dur);
    } catch {
      return null;
    }
    src.stop(t + dur + 0.02);
    return src;
  }

  /**
   * `weight` 0..1 maps a .22 to a 40 mm: it moves the body pitch, the tail
   * length and the low-end thump together, which is how calibre actually
   * reads to an ear.
   */
  shot(weight: number, gain: number, pitch: number, e: EchoEstimate, seed: number): void {
    if (!this.ensure()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.005;
    if (!this.budgetOk(t)) return;

    const rng = makeRng(seed);
    const w = clamp01(weight);
    const bus = ctx.createGain();
    bus.gain.value = clamp(gain, 0, 2);
    bus.connect(this.master!);

    /* ---- crack: the supersonic snap, very short, very bright ---- */
    const crackDur = 0.012 + w * 0.01;
    const crack = this.noiseSource(t, crackDur + 0.02, rng.next() * 1.3);
    if (crack) {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = (2600 - w * 900) * pitch;
      bp.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1.1, t + 0.0015);
      g.gain.exponentialRampToValueAtTime(0.0008, t + crackDur);
      crack.connect(bp).connect(g).connect(bus);
    }

    /* ---- body: chamber pressure, a fast downward sine ---- */
    const osc = ctx.createOscillator();
    osc.type = "sine";
    const f0 = (170 + (1 - w) * 260) * pitch;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(28, f0 * 0.24), t + 0.09 + w * 0.1);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.55 + w * 0.75, t + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0008, t + 0.11 + w * 0.16);
    osc.connect(og).connect(bus);
    osc.start(t);
    osc.stop(t + 0.35 + w * 0.2);

    /* ---- tail: the report itself ---- */
    const tailDur = 0.09 + w * 0.24 + e.wet * (0.25 + w * 0.55);
    const tail = this.noiseSource(t, tailDur + 0.05, rng.next() * 1.3);
    if (tail) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime((5200 - w * 1600) * pitch, t);
      lp.frequency.exponentialRampToValueAtTime(320 + e.brightness * 900, t + tailDur);
      lp.Q.value = 0.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.75 + w * 0.5, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0006, t + tailDur);
      tail.connect(lp).connect(g).connect(bus);
    }

    /* ---- slapbacks: San Francisco answering ---- */
    if (e.wet > 0.04) {
      for (let i = 0; i < 2; i++) {
        const delay = e.delay * (1 + i * 1.62) + rng.next() * 0.012;
        const dur = 0.12 + w * 0.3 + e.wet * 0.4;
        const src = this.noiseSource(t + delay, dur + 0.05, rng.next() * 1.3);
        if (!src) continue;
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 400 + e.brightness * (1500 - i * 500);
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 90;
        const g = ctx.createGain();
        const amp = e.wet * (0.34 - i * 0.15) * (0.5 + w * 0.7);
        g.gain.setValueAtTime(0.0001, t + delay);
        g.gain.exponentialRampToValueAtTime(Math.max(0.002, amp), t + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0004, t + delay + dur);
        src.connect(hp).connect(lp).connect(g).connect(bus);
      }
    }
  }

  /** Short mechanical noises: slide, bolt, magazine, pin, dry fire. */
  mech(kind: string, gain: number, seed: number): void {
    if (!this.ensure()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.004;
    if (!this.budgetOk(t)) return;
    const rng = makeRng(seed);

    const heavy = /bolt|belt|breech|tube|pump|slide/.test(kind);
    const metallic = !/pouch|fabric/.test(kind);
    const dur = heavy ? 0.09 : 0.055;

    const src = this.noiseSource(t, dur + 0.04, rng.next() * 1.3);
    if (!src) return;
    const bp = ctx.createBiquadFilter();
    bp.type = metallic ? "bandpass" : "lowpass";
    bp.frequency.value = metallic ? (heavy ? 1500 : 2700) * (0.9 + rng.next() * 0.2) : 900;
    bp.Q.value = metallic ? 2.4 : 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain * (heavy ? 0.5 : 0.32), t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    src.connect(bp).connect(g).connect(this.master!);

    // A metal "clack" needs a pitched partial or it reads as a hiss.
    if (metallic) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      const f = (heavy ? 220 : 480) * (0.9 + rng.next() * 0.25);
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * 0.6, t + dur);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(gain * 0.22, t + 0.002);
      og.gain.exponentialRampToValueAtTime(0.0003, t + dur);
      osc.connect(og).connect(this.master!);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
  }

  /** Impacts, casings, ricochets — short, surface-coloured transients. */
  impact(bank: string, gain: number, pitch: number, seed: number): void {
    if (!this.ensure()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.003;
    if (!this.budgetOk(t)) return;
    const rng = makeRng(seed);

    const cfg = IMPACT_VOICE[bank] ?? IMPACT_VOICE.concrete;
    const dur = cfg.dur * (0.85 + rng.next() * 0.3);
    const src = this.noiseSource(t, dur + 0.04, rng.next() * 1.3);
    if (src) {
      const f = ctx.createBiquadFilter();
      f.type = cfg.type;
      f.frequency.value = cfg.freq * pitch * (0.88 + rng.next() * 0.24);
      f.Q.value = cfg.q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.002, gain * cfg.gain), t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0003, t + dur);
      src.connect(f).connect(g).connect(this.master!);
    }
    // Ricochet whine: a falling, resonant partial. Only metal and stone.
    if (cfg.whine > 0 && rng.chance(cfg.whine)) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      const f0 = 1400 + rng.next() * 1800;
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.28, t + 0.42);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = f0 * 0.7;
      bp.Q.value = 9;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain * 0.16, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0003, t + 0.45);
      osc.connect(bp).connect(g).connect(this.master!);
      osc.start(t);
      osc.stop(t + 0.5);
    }
  }

  explosion(radius: number, gain: number, seed: number): void {
    if (!this.ensure()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.004;
    const rng = makeRng(seed);
    const w = clamp01(radius / 14);

    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(78 - w * 30, t);
    sub.frequency.exponentialRampToValueAtTime(24, t + 0.6 + w * 0.5);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(gain * 1.4, t + 0.01);
    sg.gain.exponentialRampToValueAtTime(0.0006, t + 0.8 + w * 0.7);
    sub.connect(sg).connect(this.master!);
    sub.start(t);
    sub.stop(t + 1.6);

    const dur = 0.9 + w * 1.1;
    const src = this.noiseSource(t, dur + 0.1, rng.next() * 1.2);
    if (!src) return;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(4200, t);
    lp.frequency.exponentialRampToValueAtTime(160, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain * 1.1, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    src.connect(lp).connect(g).connect(this.master!);
  }

  dispose(): void {
    try {
      this.ctx?.close();
    } catch {
      /* already closed */
    }
    this.ctx = null;
    this.master = null;
    this.noise = null;
  }
}

interface ImpactVoice {
  type: BiquadFilterType;
  freq: number;
  q: number;
  gain: number;
  dur: number;
  whine: number;
}

/** Per-surface voicing for the fallback impact synth. */
const IMPACT_VOICE: Record<string, ImpactVoice> = {
  concrete:  { type: "bandpass", freq: 1100, q: 1.2, gain: 0.5,  dur: 0.11, whine: 0.1 },
  asphalt:   { type: "lowpass",  freq: 900,  q: 0.8, gain: 0.44, dur: 0.1,  whine: 0.06 },
  metal:     { type: "bandpass", freq: 3200, q: 3.5, gain: 0.62, dur: 0.14, whine: 0.55 },
  thinMetal: { type: "bandpass", freq: 2400, q: 2.2, gain: 0.7,  dur: 0.2,  whine: 0.4 },
  glass:     { type: "highpass", freq: 3600, q: 1.0, gain: 0.72, dur: 0.4,  whine: 0 },
  wood:      { type: "bandpass", freq: 700,  q: 1.4, gain: 0.5,  dur: 0.13, whine: 0 },
  brick:     { type: "bandpass", freq: 1300, q: 1.1, gain: 0.52, dur: 0.12, whine: 0.12 },
  stucco:    { type: "lowpass",  freq: 1500, q: 0.7, gain: 0.46, dur: 0.12, whine: 0.04 },
  stone:     { type: "bandpass", freq: 1700, q: 1.6, gain: 0.56, dur: 0.13, whine: 0.22 },
  dirt:      { type: "lowpass",  freq: 520,  q: 0.6, gain: 0.4,  dur: 0.12, whine: 0 },
  grass:     { type: "lowpass",  freq: 620,  q: 0.6, gain: 0.32, dur: 0.1,  whine: 0 },
  sand:      { type: "lowpass",  freq: 700,  q: 0.5, gain: 0.34, dur: 0.13, whine: 0 },
  gravel:    { type: "bandpass", freq: 1500, q: 1.0, gain: 0.44, dur: 0.13, whine: 0.08 },
  water:     { type: "lowpass",  freq: 1400, q: 0.6, gain: 0.5,  dur: 0.26, whine: 0 },
  flesh:     { type: "lowpass",  freq: 380,  q: 0.9, gain: 0.66, dur: 0.1,  whine: 0 },
  foliage:   { type: "highpass", freq: 2600, q: 0.6, gain: 0.28, dur: 0.13, whine: 0 },
  plastic:   { type: "bandpass", freq: 1900, q: 1.6, gain: 0.42, dur: 0.09, whine: 0 },
  rubber:    { type: "lowpass",  freq: 460,  q: 0.8, gain: 0.4,  dur: 0.1,  whine: 0 },
  fabric:    { type: "lowpass",  freq: 700,  q: 0.5, gain: 0.26, dur: 0.09, whine: 0 },
  casing:    { type: "bandpass", freq: 4200, q: 5.0, gain: 0.2,  dur: 0.09, whine: 0 },
};

const fallbackAudio = new FallbackGunAudio();

/** Call from a click/keydown so the browser lets us make noise. */
export function primeWeaponAudio(): void {
  fallbackAudio.prime();
  fallbackAudio.resume();
}

export function disposeWeaponAudio(): void {
  fallbackAudio.dispose();
}

/* ------------------------------------------------------------------ *
 * Sound routing
 * ------------------------------------------------------------------ */

let soundSeed = 0x9e3779b9;
function nextSeed(): number {
  soundSeed = (soundSeed * 1664525 + 1013904223) >>> 0;
  return soundSeed;
}

/**
 * Play a weapon sound. If a real audio system is attached it gets the bank key
 * and the spatial parameters and we do nothing else; otherwise the fallback
 * synth voices it from the category encoded in the bank name.
 */
export function playWeaponSound(bank: string, opts: WeaponSoundOpts): void {
  if (audioSink) {
    try {
      audioSink.play(bank, opts);
      return;
    } catch {
      audioSink = null;
    }
  }
  const gain = (opts.volume ?? 1) * (opts.local ? 1 : 0.7);
  fallbackAudio.mech(bank, gain, nextSeed());
}

/** The main event. `weight` is the calibre feel, 0..1. */
export function playGunshot(
  bank: string,
  weight: number,
  opts: WeaponSoundOpts,
  e: EchoEstimate,
): void {
  if (audioSink) {
    try {
      audioSink.play(bank, { ...opts, wet: e.wet, echoDelay: e.delay });
      return;
    } catch {
      audioSink = null;
    }
  }
  fallbackAudio.shot(weight, opts.volume ?? 1, opts.pitch ?? 1, e, nextSeed());
}

export function playImpactSound(bank: string, opts: WeaponSoundOpts): void {
  if (audioSink) {
    try {
      audioSink.play(`impact_${bank}`, opts);
      return;
    } catch {
      audioSink = null;
    }
  }
  fallbackAudio.impact(bank, opts.volume ?? 1, opts.pitch ?? 1, nextSeed());
}

export function playExplosionSound(radius: number, opts: WeaponSoundOpts): void {
  if (audioSink) {
    try {
      audioSink.play("explosion", { ...opts, volume: (opts.volume ?? 1) * (0.6 + radius / 20) });
      return;
    } catch {
      audioSink = null;
    }
  }
  fallbackAudio.explosion(radius, opts.volume ?? 1, nextSeed());
}
