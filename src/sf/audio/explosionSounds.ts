/**
 * audio/explosionSounds.ts — blasts.
 *
 * An explosion is the loudest thing in the game and therefore the one event
 * that is allowed to reshape the entire mix. Four layers plus two mix actions:
 *
 *   - **chest** — a 90 → 22 Hz pressure sweep. You do not hear this so much as
 *     get hit by it. It is the layer that separates an explosion from a
 *     large gunshot, and it needs a full second of tail.
 *   - **crack** — the shock front. Milliseconds of clipped broadband, the
 *     brightest sound in the game. Present only near the blast: it is the
 *     first thing distance takes away.
 *   - **roar** — the fireball, 400 ms of collapsing filtered noise with heavy
 *     nonlinearity. Real blasts overdrive whatever recorded them; a clean
 *     explosion sounds like a balloon.
 *   - **debris** — the two seconds afterwards, when the city comes back down.
 *     Concrete, metal and glass each fall differently, and this is the layer
 *     that tells the player *what* just got destroyed.
 *
 * And the two mix actions, which are why a nearby blast feels violent:
 *   - **duck**: everything else drops 6–14 dB and comes back over half a second.
 *   - **deafen**: the master lowpass slams shut and opens over ~2.5 s, with a
 *     tinnitus tone laid over the top. Concussion, not a filter sweep for its
 *     own sake — it decays with distance and is gone past ~25 m.
 *
 * Public API
 * ----------
 *   playExplosion(opts)
 *   playDebrisShower(kind, opts)
 *   playTinnitus(intensity)
 *   ExplosionOptions / ExplosionKind
 */
import { clamp, clamp01, makeRng } from "../math/rng";
import { audioEngine, ENVIRONMENTS, type EnvironmentKind } from "./engine";
import { playBuffer, beginOptions, distanceTo, voicePool, type VoiceOptions } from "./spatial";
import {
  MODAL_LIBRARY,
  SPEED_OF_SOUND,
  bakeOffline,
  bakeSync,
  bakedBuffer,
  dcBlock,
  edgeFade,
  fillNoise,
  normalize,
  percEnv,
  renderModal,
  softClip,
  svfSweep,
  type ModalSpec,
} from "./synth";

/* ================================================================== *
 * Sizes
 * ================================================================== */

export type ExplosionKind = "grenade" | "rocket" | "vehicle" | "fuel" | "structure";

interface BlastProfile {
  /** Chest sweep: start/end Hz and decay seconds. */
  subHi: number;
  subLo: number;
  subDecay: number;
  subLevel: number;
  /** Roar: filter sweep and decay. */
  roarHi: number;
  roarLo: number;
  roarDecay: number;
  /** Shock front level. */
  crack: number;
  /** Nonlinear drive. */
  drive: number;
  /** Audible radius, metres. */
  loudness: number;
  /** Tail length scale. */
  tailScale: number;
  /** Debris character. */
  debris: DebrisKind;
  debrisLevel: number;
  /** Concussion radius — inside this you get ducked and deafened. */
  concussion: number;
  level: number;
}

export type DebrisKind = "concrete" | "metal" | "glass" | "mixed";

const BLASTS: Record<ExplosionKind, BlastProfile> = {
  grenade: {
    subHi: 110,
    subLo: 38,
    subDecay: 0.34,
    subLevel: 0.9,
    roarHi: 5200,
    roarLo: 380,
    roarDecay: 0.16,
    crack: 0.85,
    drive: 0.72,
    loudness: 520,
    tailScale: 1,
    debris: "concrete",
    debrisLevel: 0.5,
    concussion: 14,
    level: 0.85,
  },
  rocket: {
    subHi: 100,
    subLo: 30,
    subDecay: 0.5,
    subLevel: 1.05,
    roarHi: 5600,
    roarLo: 300,
    roarDecay: 0.24,
    crack: 0.95,
    drive: 0.8,
    loudness: 780,
    tailScale: 1.2,
    debris: "mixed",
    debrisLevel: 0.7,
    concussion: 20,
    level: 0.95,
  },
  vehicle: {
    subHi: 88,
    subLo: 26,
    subDecay: 0.7,
    subLevel: 1.15,
    roarHi: 4200,
    roarLo: 240,
    roarDecay: 0.42,
    crack: 0.7,
    drive: 0.86,
    loudness: 950,
    tailScale: 1.35,
    debris: "metal",
    debrisLevel: 1,
    concussion: 26,
    level: 1,
  },
  fuel: {
    subHi: 76,
    subLo: 22,
    subDecay: 1.05,
    subLevel: 1.3,
    roarHi: 3400,
    roarLo: 180,
    roarDecay: 0.75,
    crack: 0.5,
    drive: 0.92,
    loudness: 1400,
    tailScale: 1.7,
    debris: "metal",
    debrisLevel: 1.1,
    concussion: 40,
    level: 1,
  },
  structure: {
    subHi: 70,
    subLo: 20,
    subDecay: 1.25,
    subLevel: 1.35,
    roarHi: 2800,
    roarLo: 150,
    roarDecay: 0.9,
    crack: 0.45,
    drive: 0.9,
    loudness: 1800,
    tailScale: 2,
    debris: "concrete",
    debrisLevel: 1.4,
    concussion: 52,
    level: 1,
  },
};

/* ================================================================== *
 * Baking
 * ================================================================== */

const CORE_SECONDS = 2.2;

function renderBlastCore(out: Float32Array, sr: number, p: BlastProfile, variant: number, rng: ReturnType<typeof makeRng>): void {
  const n = out.length;
  out.fill(0);
  const jit = 1 + (variant - 1) * 0.06;

  /* --- shock front ----------------------------------------------------- */
  {
    const cn = Math.round(sr * 0.03);
    const c = new Float32Array(cn);
    fillNoise(c, "white", rng);
    for (let i = 0; i < cn; i++) c[i] *= Math.exp(-i / (sr * 0.0015));
    svfSweep(c, sr, 11000 * jit, 2200, 0.9, 2, (u) => Math.pow(u, 0.3));
    for (let i = 0; i < cn; i++) out[i] += c[i] * p.crack;
  }

  /* --- roar ------------------------------------------------------------ */
  {
    const rn = Math.min(n, Math.round(sr * Math.min(1.6, p.roarDecay * 6)));
    const a = new Float32Array(rn);
    const b = new Float32Array(rn);
    fillNoise(a, "white", rng);
    fillNoise(b, "brown", rng);
    for (let i = 0; i < rn; i++) {
      const t = i / sr;
      // Fast rise (0.8 ms) then a two-stage decay: the fireball's initial
      // collapse is much faster than the burning that follows it.
      const atk = Math.min(1, t / 0.0008);
      const env = atk * (Math.exp(-t / p.roarDecay) * 0.75 + Math.exp(-t / (p.roarDecay * 4)) * 0.25);
      a[i] *= env;
      b[i] *= env * 1.2;
    }
    svfSweep(a, sr, p.roarHi * jit, p.roarLo, 0.9, 0, (u) => Math.pow(u, 0.4));
    svfSweep(b, sr, p.roarHi * 0.25, p.roarLo * 0.4, 0.7, 0, (u) => Math.pow(u, 0.7));
    for (let i = 0; i < rn; i++) out[i] += a[i] * 0.8 + b[i] * 0.9;
  }

  /* --- chest sweep ----------------------------------------------------- */
  {
    const sn = Math.min(n, Math.round(sr * Math.min(2.0, p.subDecay * 4)));
    let phase = 0;
    const logHi = Math.log(p.subHi * jit);
    const logLo = Math.log(p.subLo);
    for (let i = 0; i < sn; i++) {
      const t = i / sr;
      const u = clamp01(t / (p.subDecay * 2));
      const f = Math.exp(logHi + (logLo - logHi) * Math.pow(u, 0.45));
      phase += (2 * Math.PI * f) / sr;
      const env = Math.min(1, t / 0.002) * Math.exp(-t / p.subDecay);
      // A little third harmonic keeps it audible on speakers that cannot
      // reproduce 25 Hz at all — most of them.
      out[i] += (Math.sin(phase) + 0.3 * Math.sin(phase * 3) + 0.12 * Math.sin(phase * 5)) * env * p.subLevel;
    }
  }

  softClip(out, 1 + p.drive * 3);
  dcBlock(out, sr, 16);
  normalize(out, 0.97);
  edgeFade(out, sr, 0.05, 40);
}

/**
 * Debris: 2.5 seconds of the world landing.
 *
 * Events are Poisson-ish with a density that falls as 1/(1+t·k) — everything
 * heavy lands first, then the scatter, then the last few pieces skittering.
 * Baked stereo with per-event panning so it is genuinely wide instead of a
 * mono blob shoved through a panner.
 */
function renderDebris(
  chans: Float32Array[],
  sr: number,
  kind: DebrisKind,
  rng: ReturnType<typeof makeRng>,
): void {
  const n = chans[0].length;
  for (const c of chans) c.fill(0);

  const palette: (keyof typeof MODAL_LIBRARY)[] =
    kind === "metal"
      ? ["thinMetal", "metal", "metal", "concrete"]
      : kind === "glass"
        ? ["glass", "glass", "concrete", "plastic"]
        : kind === "mixed"
          ? ["concrete", "metal", "glass", "wood", "brick"]
          : ["concrete", "brick", "stone", "gravel", "concrete"];

  const duration = n / sr;
  let t = 0.06;
  let guard = 0;
  while (t < duration && guard++ < 900) {
    const density = 70 / (1 + t * 5.5);
    t += -Math.log(1 - rng.next() * 0.999) / Math.max(1.5, density);
    if (t >= duration) break;

    const mat = rng.pick(palette);
    const base = MODAL_LIBRARY[mat];
    const pitch = Math.pow(2, rng.gauss() * 0.7);
    const spec: ModalSpec = {
      ...base,
      modes: base.modes.map((m) => ({
        f: m.f * pitch,
        decay: m.decay * rng.range(0.4, 1.1),
        gain: m.gain,
      })),
      exciter: base.exciter * rng.range(0.7, 1.5),
    };
    // Big pieces land early and loudly; late events are small and sharp.
    const size = clamp01(1 - t / duration);
    const gain = rng.range(0.15, 1) * (0.25 + size * 0.9) * (1 / (1 + pitch));
    const len = Math.min(n - Math.round(t * sr), Math.round(sr * 0.3));
    if (len <= 16) continue;
    const tmp = new Float32Array(len);
    renderModal(tmp, sr, spec, rng);
    const off = Math.round(t * sr);
    const pan = rng.range(-1, 1);
    const gl = gain * Math.sqrt((1 - pan) * 0.5);
    const gr = gain * Math.sqrt((1 + pan) * 0.5);
    for (let i = 0; i < len; i++) {
      chans[0][off + i] += tmp[i] * gl;
      if (chans.length > 1) chans[1][off + i] += tmp[i] * gr;
    }
  }

  // A bed of dust and small grit under the discrete events.
  for (let c = 0; c < chans.length; c++) {
    const d = chans[c];
    const bed = new Float32Array(n);
    fillNoise(bed, "pink", rng);
    for (let i = 0; i < n; i++) {
      const tt = i / sr;
      bed[i] *= Math.exp(-tt / 0.55) * 0.35;
    }
    svfSweep(bed, sr, 4200, 900, 0.7, 1);
    for (let i = 0; i < n; i++) d[i] += bed[i];
    dcBlock(d, sr, 40);
    normalize(d, 0.85);
    edgeFade(d, sr, 2, 80);
  }
}

/**
 * The blast's reflection tail — same idea as the gunshot tail but far longer
 * and with much more low end, because an explosion excites the whole city
 * rather than just the block you are standing on.
 */
function renderBlastTail(
  chans: Float32Array[],
  sr: number,
  p: BlastProfile,
  env: EnvironmentKind,
  rng: ReturnType<typeof makeRng>,
): void {
  const preset = ENVIRONMENTS[env];
  const n = chans[0].length;
  const tau = Math.max(0.15, preset.ir.decay * p.tailScale * 1.6) / 6.908;

  for (let c = 0; c < chans.length; c++) {
    const d = chans[c];
    d.fill(0);
    for (let i = 0; i < n; i += 4) {
      const j = i + ((rng.next() * 4) | 0);
      if (j >= n) break;
      const t = j / sr;
      d[j] += (rng.next() < 0.5 ? -1 : 1) * Math.exp(-t / tau);
    }
    const taps = env === "canyon" ? 7 : env === "bay" ? 3 : 5;
    for (let k = 1; k <= taps; k++) {
      const t = preset.slapback * k * (1 + rng.range(-0.15, 0.35));
      const idx = Math.round(t * sr);
      if (idx >= n) break;
      const g = Math.pow(0.7, k) * 0.9 * (c === 0 ? 1 : -1);
      const w = Math.round(sr * 0.05 * (1 + k * 0.5));
      for (let i = 0; i < w && idx + i < n; i++) {
        d[idx + i] += g * (rng.next() * 2 - 1) * Math.exp(-i / (w * 0.4));
      }
    }
    svfSweep(d, sr, 1400, 220, 0.75, 0);
    // Heavy low shelf: the rumble is the point.
    {
      const a = Math.exp((-2 * Math.PI * 70) / sr);
      let y = 0;
      for (let i = 0; i < n; i++) {
        y = d[i] * (1 - a) + y * a;
        d[i] += y * 2.4;
      }
    }
    dcBlock(d, sr, 20);
    normalize(d, 0.85);
    edgeFade(d, sr, 3, 120);
  }
}

function coreBuffer(kind: ExplosionKind, variant: number): AudioBuffer | null {
  const ctx = audioEngine.ctx;
  if (!ctx) return null;
  const p = BLASTS[kind];
  return bakeSync(ctx, `blast:core:${kind}:${variant}`, CORE_SECONDS, 1, (ch, sr, rng) =>
    renderBlastCore(ch[0], sr, p, variant, rng),
  );
}

function debrisBuffer(kind: DebrisKind, variant: number): AudioBuffer | null {
  const ctx = audioEngine.ctx;
  if (!ctx) return null;
  return bakeSync(ctx, `blast:debris:${kind}:${variant}`, 2.6, 2, (ch, sr, rng) =>
    renderDebris(ch, sr, kind, rng),
  );
}

/**
 * The far-field blast — a *real* convolution, rendered offline.
 *
 * Beyond a few hundred metres what reaches you is not the blast plus some
 * reverb: it is the blast convolved with the entire city, low-passed by a
 * kilometre of air, with the direct sound almost gone. Building that as a live
 * graph would mean a ConvolverNode per explosion, which is unaffordable. So we
 * render it once per (size × environment) through an OfflineAudioContext and
 * replay the result like any other buffer.
 *
 * The first distant explosion in a new environment uses the numeric tail while
 * this renders in the background; every one after it gets the convolved
 * version. That is the correct trade — the render takes a few tens of
 * milliseconds off-thread and the fallback is already good.
 */
function farBlastBuffer(kind: ExplosionKind, env: EnvironmentKind): AudioBuffer | null {
  const ctx = audioEngine.ctx;
  if (!ctx) return null;
  const key = `blast:far:${kind}:${env}`;
  const hit = bakedBuffer(ctx, key);
  if (hit) return hit;

  const core = coreBuffer(kind, 0);
  const ir = audioEngine.impulseResponse(env);
  if (!core || !ir) return null;

  const seconds = Math.min(8, core.duration + ir.duration + 0.2);
  void bakeOffline(ctx, key, seconds, 2, (octx) => {
    const src = octx.createBufferSource();
    src.buffer = core;
    // Distance eats the top end and stretches the event; both, together, are
    // what "far away" means.
    src.playbackRate.value = 0.82;

    const air = octx.createBiquadFilter();
    air.type = "lowpass";
    air.frequency.value = 620;
    air.Q.value = 0.5;

    const shelf = octx.createBiquadFilter();
    shelf.type = "lowshelf";
    shelf.frequency.value = 120;
    shelf.gain.value = 7;

    const conv = octx.createConvolver();
    conv.normalize = true;
    conv.buffer = ir;

    // The reflected field dominates; a little direct sound keeps the onset.
    const wet = octx.createGain();
    wet.gain.value = 1;
    const dry = octx.createGain();
    dry.gain.value = 0.22;

    src.connect(air);
    air.connect(shelf);
    shelf.connect(conv);
    shelf.connect(dry);
    conv.connect(wet);
    wet.connect(octx.destination);
    dry.connect(octx.destination);
    src.start(0);
  });
  return null;
}

function tailBuffer(kind: ExplosionKind, env: EnvironmentKind): AudioBuffer | null {
  const ctx = audioEngine.ctx;
  if (!ctx) return null;
  const p = BLASTS[kind];
  const seconds = clamp(ENVIRONMENTS[env].ir.decay * p.tailScale * 1.6 + 0.8, 1, 6);
  return bakeSync(ctx, `blast:tail:${kind}:${env}`, seconds, 2, (ch, sr, rng) =>
    renderBlastTail(ch, sr, p, env, rng),
  );
}

/* ================================================================== *
 * Playback
 * ================================================================== */

export interface ExplosionOptions {
  x: number;
  y: number;
  z: number;
  kind?: ExplosionKind;
  /** Blast radius in metres; scales pitch, level and concussion. */
  radius?: number;
  volume?: number;
  /** What got blown up, for the debris layer. */
  debris?: DebrisKind;
  /** Suppress the mix ducking (useful for scripted background explosions). */
  noDuck?: boolean;
}

const blastRng = makeRng("sf-audio:blasts");
let blastVariant = 0;

/**
 * Detonate.
 *
 * Everything is scheduled relative to the arrival time of the shock front,
 * which for a blast 300 m away is nearly a second after the flash. That delay
 * is not a nicety — seeing a fireball across the bay and hearing it a beat
 * later is one of the strongest scale cues an open world has.
 */
export function playExplosion(opts: ExplosionOptions): void {
  if (!audioEngine.available || audioEngine.settings.muted) return;
  const ctx = audioEngine.ctx;
  if (!ctx) return;

  const kind = opts.kind ?? "grenade";
  const p = BLASTS[kind];
  const radius = opts.radius ?? 8;
  const dist = distanceTo(opts.x, opts.y, opts.z);
  if (dist > p.loudness * 1.4) return;

  // Bigger charge → lower pitch. One buffer covers a whole size class this way.
  const scale = clamp(radius / 8, 0.55, 2.2);
  const pitch = clamp(Math.pow(scale, -0.42) * blastRng.range(0.95, 1.05), 0.5, 1.6);
  const vol = (opts.volume ?? 1) * p.level * clamp(Math.pow(scale, 0.35), 0.6, 1.6);
  const travel = dist / SPEED_OF_SOUND;
  const now = ctx.currentTime;

  const variant = blastVariant++ % 3;
  const env = audioEngine.environment;

  // Past ~320 m the offline-convolved version is the whole sound; use it if it
  // has finished rendering, and kick off the render if it has not.
  const far = dist > 320 ? farBlastBuffer(kind, env) : null;

  const o = beginOptions();
  o.x = opts.x;
  o.y = opts.y;
  o.z = opts.z;
  o.vx = 0;
  o.vy = 0;
  o.vz = 0;
  o.bus = "weapons";
  o.local = false;
  o.gain = far ? vol * 1.4 : vol;
  o.pitch = pitch;
  o.priority = 1;
  o.loudness = p.loudness * scale;
  o.propagate = true;
  o.noOcclusion = false;
  o.when = undefined;
  o.duration = undefined;
  playBuffer(far ?? coreBuffer(kind, variant), o);

  /* ---- reflections ---- */
  // The convolved far-field already contains the reflections.
  const tail = far ? null : tailBuffer(kind, env);
  if (tail) {
    const preset = ENVIRONMENTS[env];
    const distFactor = 0.55 + clamp01(dist / 220) * 1.2;
    o.gain = vol * preset.wet * distFactor * 1.6;
    o.pitch = pitch * 0.98;
    o.priority = 0.85;
    o.when = now + travel + preset.slapback * 0.6;
    o.noOcclusion = true;
    o.propagate = false;
    playBuffer(tail, o);
  }

  /* ---- debris ---- */
  const debrisKind = opts.debris ?? p.debris;
  const dl = p.debrisLevel * clamp(scale, 0.6, 1.6) * (opts.volume ?? 1);
  if (dl > 0.05) {
    playDebrisShower(debrisKind, {
      x: opts.x,
      y: opts.y,
      z: opts.z,
      volume: dl * 0.8,
      delay: travel + 0.18,
      loudness: p.loudness * 0.5,
    });
  }

  /* ---- mix reaction ---- */
  if (opts.noDuck) return;
  const proximity = clamp01(1 - dist / (p.concussion * scale * 2.2));
  if (proximity <= 0.001) return;
  // Duck arrives with the sound, not with the event.
  const duckDelay = Math.max(0, travel - 0.02);
  const amount = 0.28 + proximity * 0.5;
  if (duckDelay < 0.03) {
    audioEngine.duck(amount, 0.015, 0.12 + proximity * 0.2, 0.45 + proximity * 0.5);
  } else {
    scheduleDuck(amount, duckDelay, proximity);
  }

  if (proximity > 0.35) {
    const intensity = clamp01((proximity - 0.35) / 0.65);
    if (duckDelay < 0.05) {
      audioEngine.deafen(intensity * 0.9, 1.4 + intensity * 2.2);
      playTinnitus(intensity);
    } else {
      scheduleDeafen(intensity, duckDelay);
    }
  }
}

/* Scheduled mix reactions. A tiny fixed-size ring so a wave of explosions
 * cannot spawn unbounded timers. */
interface PendingReaction {
  at: number;
  duck: number;
  proximity: number;
  deafen: number;
}
const pending: PendingReaction[] = [];
const MAX_PENDING = 8;

function scheduleDuck(amount: number, delay: number, proximity: number): void {
  if (pending.length >= MAX_PENDING) return;
  pending.push({ at: audioEngine.now + delay, duck: amount, proximity, deafen: 0 });
}

function scheduleDeafen(intensity: number, delay: number): void {
  if (pending.length >= MAX_PENDING) return;
  pending.push({ at: audioEngine.now + delay, duck: 0, proximity: 0, deafen: intensity });
}

/** Drain scheduled mix reactions. Called once a frame by the audio component. */
export function updateExplosions(): void {
  if (pending.length === 0) return;
  const now = audioEngine.now;
  for (let i = pending.length - 1; i >= 0; i--) {
    const r = pending[i];
    if (now < r.at) continue;
    if (r.duck > 0) {
      audioEngine.duck(r.duck, 0.015, 0.12 + r.proximity * 0.2, 0.45 + r.proximity * 0.5);
    }
    if (r.deafen > 0) {
      audioEngine.deafen(r.deafen * 0.9, 1.4 + r.deafen * 2.2);
      playTinnitus(r.deafen);
    }
    pending.splice(i, 1);
  }
}

export interface DebrisOptions {
  x: number;
  y: number;
  z: number;
  volume?: number;
  /** Seconds to wait before it starts. */
  delay?: number;
  loudness?: number;
}

/** Rubble landing. Also useful on its own for collapsing scenery. */
export function playDebrisShower(kind: DebrisKind, opts: DebrisOptions): void {
  if (!audioEngine.available) return;
  const ctx = audioEngine.ctx;
  if (!ctx) return;
  const buf = debrisBuffer(kind, (blastVariant + 1) % 2);
  if (!buf) return;
  const o = beginOptions();
  o.x = opts.x;
  o.y = opts.y;
  o.z = opts.z;
  o.bus = "world";
  o.local = false;
  o.gain = (opts.volume ?? 1) * 0.75;
  o.pitch = blastRng.range(0.9, 1.12);
  o.priority = 0.55;
  o.loudness = opts.loudness ?? 260;
  o.propagate = false;
  o.noOcclusion = false;
  o.when = ctx.currentTime + (opts.delay ?? 0);
  playBuffer(buf, o);
}

/* ================================================================== *
 * Tinnitus
 * ================================================================== */

let tinnitusVoice: ReturnType<typeof voicePool.acquire> = null;
let tinnitusUntil = 0;

/**
 * The ring.
 *
 * Two close, slightly detuned high sines beating against each other — a single
 * tone reads as a test signal, two reads as damage. Local (non-positional),
 * because it is happening inside the player's head.
 */
export function playTinnitus(intensity: number): void {
  const ctx = audioEngine.ctx;
  if (!ctx || !audioEngine.available) return;
  const i = clamp01(intensity);
  if (i < 0.06) return;

  const seconds = 2.5 + i * 5.5;
  const now = ctx.currentTime;
  if (tinnitusVoice && now < tinnitusUntil) return; // do not stack rings

  const o = beginOptions();
  o.x = 0;
  o.y = 0;
  o.z = 0;
  o.local = true;
  o.pan = 0;
  o.bus = "voice";
  o.gain = 1;
  o.pitch = 1;
  o.priority = 0.95;
  o.noOcclusion = true;
  o.propagate = false;
  o.duration = seconds + 0.3;
  o.when = undefined;
  const v = voicePool.acquire(o);
  if (!v) return;

  tinnitusVoice = v;
  tinnitusUntil = now + seconds;

  const level = 0.055 + i * 0.1;
  const oscs: OscillatorNode[] = [];
  for (const [f, g] of [
    [6100, 1],
    [6420, 0.55],
    [4180, 0.32],
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = f * (0.94 + i * 0.1);
    const g2 = ctx.createGain();
    g2.gain.value = 0;
    // Slam up in 20 ms, then a long exponential fade back to nothing.
    g2.gain.setValueAtTime(0.0001, now);
    g2.gain.exponentialRampToValueAtTime(level * g, now + 0.02);
    g2.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
    osc.connect(g2);
    g2.connect(v.input);
    osc.start(now);
    osc.stop(now + seconds + 0.05);
    osc.onended = () => {
      try {
        g2.disconnect();
        osc.disconnect();
      } catch {
        /* torn down */
      }
    };
    oscs.push(osc);
  }
  v.onSteal = () => {
    for (const osc of oscs) {
      try {
        osc.stop();
      } catch {
        /* not started */
      }
    }
    tinnitusVoice = null;
  };
  v.endsAt = now + seconds + 0.1;
}

/** Warm the blast banks during loading. */
export async function primeExplosionBanks(): Promise<void> {
  if (!audioEngine.ctx) return;
  const env = audioEngine.environment;
  for (const k of Object.keys(BLASTS) as ExplosionKind[]) {
    for (let v = 0; v < 3; v++) coreBuffer(k, v);
    tailBuffer(k, env);
    await Promise.resolve();
  }
  for (const d of ["concrete", "metal", "glass", "mixed"] as DebrisKind[]) {
    debrisBuffer(d, 0);
    debrisBuffer(d, 1);
    await Promise.resolve();
  }
}

/* Small helper kept here rather than in synth: the only consumer is the
 * fallback path below, and inlining it would obscure the envelope. */
function shortNoiseBurst(
  ctx: BaseAudioContext,
  dest: AudioNode,
  when: number,
  gain: number,
  freq: number,
  decay: number,
): void {
  const buf = bakeSync(ctx, "burst:white:0.3", 0.3, 1, (ch, _sr, rng) =>
    fillNoise(ch[0], "white", rng),
  );
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = freq;
  f.Q.value = 1.1;
  const g = ctx.createGain();
  percEnv(g.gain, when, gain, decay);
  src.connect(f);
  f.connect(g);
  g.connect(dest);
  src.start(when);
  src.stop(when + decay + 0.05);
  src.onended = () => {
    try {
      f.disconnect();
      g.disconnect();
    } catch {
      /* torn down */
    }
  };
}

/**
 * A one-off "whoomp" for anything that catches fire without a full detonation
 * — a fuel spill igniting, a gas main going up. Cheap, graph-only.
 */
export function playIgnition(x: number, y: number, z: number, volume = 1): void {
  const ctx = audioEngine.ctx;
  if (!ctx || !audioEngine.available) return;
  const o = beginOptions();
  o.x = x;
  o.y = y;
  o.z = z;
  o.bus = "world";
  o.local = false;
  o.gain = volume;
  o.pitch = 1;
  o.priority = 0.6;
  o.loudness = 220;
  o.propagate = false;
  o.duration = 1.2;
  const v = voicePool.acquire(o);
  if (!v) return;
  const now = ctx.currentTime;
  shortNoiseBurst(ctx, v.input, now, 0.9, 320, 0.55);
  shortNoiseBurst(ctx, v.input, now + 0.02, 0.5, 1400, 0.3);
  v.endsAt = now + 1.1;
}
