/**
 * audio/weaponSounds.ts — guns, synthesised.
 *
 * A gunshot is not one sound. Recorded close, it is five events inside 300 ms:
 *
 *   1. **transient** — the muzzle blast's leading edge. 1–3 ms of very bright
 *      noise. This is the layer your ear uses to judge how close it was.
 *   2. **body** — the blast wave itself: a broadband burst whose spectral
 *      centroid collapses from a few kHz down to a few hundred Hz in ~40 ms.
 *      Bore diameter and powder load decide where it starts and how fast it
 *      falls; that is the whole difference between a 9 mm and a .338.
 *   3. **thump** — the low-frequency pressure pulse, 40–120 Hz, that you feel.
 *      Without it a rifle sounds like a stapler.
 *   4. **mechanical** — the action. Slide, bolt, extractor, spring. Metal
 *      modes, 10–40 ms behind the shot, and the single strongest cue that a
 *      gun is a *machine*.
 *   5. **tail** — the reflection off everything around you.
 *
 * The tail is the point of this file. Indoors and in cities, the tail is
 * louder and longer than the shot; at 300 m down Montgomery Street the direct
 * blast is a click and the tail is *the sound*. Every game that ships a single
 * "gunshot.wav" is missing it, and that is exactly why those games sound like
 * they take place in a field.
 *
 * Implementation: cores and tails are baked once per (weapon × environment)
 * and replayed with pitch/level jitter, so firing an LMG costs two buffer
 * sources per round and nothing else.
 *
 * Public API
 * ----------
 *   playShot(bank, opts) / playDistantShot(bank, opts)
 *   playWeaponMech(bank, opts)
 *   weaponSink                 — drop-in for `setWeaponAudioSink` in weapons/bridge
 *   primeWeaponBanks()         — pre-bake so the first trigger pull is not a hitch
 *   GUN_PROFILES / gunProfile(bank)
 */
import { clamp, clamp01, makeRng, type Rng } from "../math/rng";
import { audioEngine, ENVIRONMENTS, type EnvironmentKind } from "./engine";
import { playBuffer, scratchOptions, distanceTo, type VoiceOptions } from "./spatial";
import {
  MODAL_LIBRARY,
  SPEED_OF_SOUND,
  bakeSync,
  dcBlock,
  edgeFade,
  fillNoise,
  normalize,
  onePoleLowpass,
  renderModal,
  softClip,
  svfSweep,
  type ModalSpec,
} from "./synth";

/* ================================================================== *
 * Profiles
 * ================================================================== */

export interface GunProfile {
  /** Display key, also the bake-cache namespace. */
  key: string;
  /** Where the body burst starts and ends its downward sweep, Hz. */
  bodyHi: number;
  bodyLo: number;
  /** Body decay time constant, seconds. Big bores ring longer. */
  bodyDecay: number;
  /** Resonance of the body sweep. Higher = more "crack", less "boom". */
  bodyQ: number;
  /** Low pressure pulse: start and end frequency, Hz, and its decay. */
  thumpHi: number;
  thumpLo: number;
  thumpDecay: number;
  thumpLevel: number;
  /** Nonlinear drive on the blast. Big guns overload everything. */
  drive: number;
  /** Mechanical layer: material, tuning, delay and level. */
  mech: { material: keyof typeof MODAL_LIBRARY; pitch: number; delay: number; level: number };
  /** Tail length scale and level relative to the direct sound. */
  tailScale: number;
  tailLevel: number;
  /** Audible radius in metres — matches the registry's `loudness`. */
  loudness: number;
  /** Overall level. */
  level: number;
  /** True if the round goes supersonic (adds a distinct downrange crack). */
  supersonic: boolean;
  /** Suppressed guns lose the blast and keep the machine. */
  suppressed?: boolean;
}

function profile(p: Partial<GunProfile> & { key: string }): GunProfile {
  return {
    bodyHi: 3200,
    bodyLo: 620,
    bodyDecay: 0.03,
    bodyQ: 1.1,
    thumpHi: 150,
    thumpLo: 62,
    thumpDecay: 0.07,
    thumpLevel: 0.6,
    drive: 0.4,
    mech: { material: "thinMetal", pitch: 1, delay: 0.016, level: 0.35 },
    tailScale: 1,
    tailLevel: 0.5,
    loudness: 300,
    level: 0.8,
    supersonic: true,
    ...p,
  };
}

/**
 * One entry per `WeaponDef.audio.fire` bank in the registry. Numbers are
 * chosen from what the real cartridges do: a 9 mm is a short bright snap, a
 * 12-gauge is a wide low whump, a .338 Lapua is a physical event.
 */
export const GUN_PROFILES: Record<string, GunProfile> = {
  pistol45: profile({
    key: "pistol45",
    bodyHi: 2900,
    bodyLo: 540,
    bodyDecay: 0.028,
    bodyQ: 1.0,
    thumpHi: 165,
    thumpLo: 70,
    thumpDecay: 0.06,
    thumpLevel: 0.55,
    drive: 0.35,
    mech: { material: "metal", pitch: 1.35, delay: 0.021, level: 0.42 },
    tailScale: 0.8,
    tailLevel: 0.42,
    loudness: 240,
    level: 0.72,
  }),
  smg9: profile({
    key: "smg9",
    bodyHi: 3600,
    bodyLo: 700,
    bodyDecay: 0.021,
    bodyQ: 1.3,
    thumpHi: 180,
    thumpLo: 84,
    thumpDecay: 0.045,
    thumpLevel: 0.42,
    drive: 0.32,
    mech: { material: "thinMetal", pitch: 1.5, delay: 0.013, level: 0.4 },
    tailScale: 0.72,
    tailLevel: 0.38,
    loudness: 300,
    level: 0.66,
  }),
  ar556: profile({
    key: "ar556",
    bodyHi: 4400,
    bodyLo: 760,
    bodyDecay: 0.026,
    bodyQ: 1.5,
    thumpHi: 210,
    thumpLo: 76,
    thumpDecay: 0.065,
    thumpLevel: 0.62,
    drive: 0.48,
    mech: { material: "metal", pitch: 1.15, delay: 0.017, level: 0.38 },
    tailScale: 1.05,
    tailLevel: 0.56,
    loudness: 460,
    level: 0.84,
  }),
  battle762: profile({
    key: "battle762",
    bodyHi: 4000,
    bodyLo: 560,
    bodyDecay: 0.036,
    bodyQ: 1.35,
    thumpHi: 190,
    thumpLo: 58,
    thumpDecay: 0.095,
    thumpLevel: 0.85,
    drive: 0.58,
    mech: { material: "metal", pitch: 0.95, delay: 0.019, level: 0.42 },
    tailScale: 1.25,
    tailLevel: 0.66,
    loudness: 620,
    level: 0.92,
  }),
  shotgun12: profile({
    key: "shotgun12",
    bodyHi: 2600,
    bodyLo: 320,
    bodyDecay: 0.055,
    bodyQ: 0.85,
    thumpHi: 150,
    thumpLo: 44,
    thumpDecay: 0.13,
    thumpLevel: 1.05,
    drive: 0.66,
    mech: { material: "metal", pitch: 0.8, delay: 0.03, level: 0.3 },
    tailScale: 1.3,
    tailLevel: 0.7,
    loudness: 700,
    level: 0.98,
    supersonic: false,
  }),
  sniper338: profile({
    key: "sniper338",
    bodyHi: 5200,
    bodyLo: 430,
    bodyDecay: 0.05,
    bodyQ: 1.6,
    thumpHi: 175,
    thumpLo: 40,
    thumpDecay: 0.16,
    thumpLevel: 1.15,
    drive: 0.72,
    mech: { material: "metal", pitch: 0.78, delay: 0.028, level: 0.34 },
    tailScale: 1.7,
    tailLevel: 0.86,
    loudness: 1100,
    level: 1,
  }),
  lmg762: profile({
    key: "lmg762",
    bodyHi: 4100,
    bodyLo: 520,
    bodyDecay: 0.038,
    bodyQ: 1.3,
    thumpHi: 195,
    thumpLo: 54,
    thumpDecay: 0.1,
    thumpLevel: 0.9,
    drive: 0.62,
    mech: { material: "metal", pitch: 0.86, delay: 0.014, level: 0.5 },
    tailScale: 1.3,
    tailLevel: 0.7,
    loudness: 780,
    level: 0.94,
  }),
  gl40: profile({
    key: "gl40",
    bodyHi: 1500,
    bodyLo: 220,
    bodyDecay: 0.05,
    bodyQ: 0.7,
    thumpHi: 120,
    thumpLo: 46,
    thumpDecay: 0.12,
    thumpLevel: 0.95,
    drive: 0.5,
    mech: { material: "metal", pitch: 0.7, delay: 0.035, level: 0.35 },
    tailScale: 1.05,
    tailLevel: 0.5,
    loudness: 560,
    level: 0.8,
    supersonic: false,
  }),
  rpg: profile({
    key: "rpg",
    // A rocket is not a gunshot: almost no transient, a huge whoosh, and the
    // motor keeps burning after it leaves the tube.
    bodyHi: 2200,
    bodyLo: 180,
    bodyDecay: 0.17,
    bodyQ: 0.6,
    thumpHi: 110,
    thumpLo: 36,
    thumpDecay: 0.28,
    thumpLevel: 1.2,
    drive: 0.7,
    mech: { material: "metal", pitch: 0.66, delay: 0.05, level: 0.25 },
    tailScale: 1.5,
    tailLevel: 0.72,
    loudness: 1400,
    level: 1,
    supersonic: false,
  }),
  sticky_launch: profile({
    key: "sticky_launch",
    bodyHi: 1800,
    bodyLo: 380,
    bodyDecay: 0.02,
    bodyQ: 0.9,
    thumpHi: 130,
    thumpLo: 72,
    thumpDecay: 0.04,
    thumpLevel: 0.35,
    drive: 0.2,
    mech: { material: "plastic", pitch: 1.2, delay: 0.02, level: 0.5 },
    tailScale: 0.5,
    tailLevel: 0.2,
    loudness: 180,
    level: 0.5,
    supersonic: false,
  }),
  grenade_throw: profile({
    key: "grenade_throw",
    bodyHi: 900,
    bodyLo: 260,
    bodyDecay: 0.05,
    bodyQ: 0.5,
    thumpHi: 90,
    thumpLo: 60,
    thumpDecay: 0.05,
    thumpLevel: 0.15,
    drive: 0.05,
    mech: { material: "fabric", pitch: 1, delay: 0.0, level: 0.6 },
    tailScale: 0.3,
    tailLevel: 0.08,
    loudness: 60,
    level: 0.3,
    supersonic: false,
  }),
};

/** Suppressed variants are derived, not authored — same gun, no blast. */
function suppressedOf(p: GunProfile): GunProfile {
  return {
    ...p,
    key: `${p.key}_sup`,
    bodyHi: p.bodyHi * 0.42,
    bodyLo: p.bodyLo * 0.55,
    bodyDecay: p.bodyDecay * 0.55,
    bodyQ: p.bodyQ * 0.7,
    thumpHi: p.thumpHi * 0.8,
    thumpLo: p.thumpLo * 0.9,
    thumpLevel: p.thumpLevel * 0.35,
    drive: p.drive * 0.35,
    mech: { ...p.mech, level: p.mech.level * 2.0 },
    tailScale: p.tailScale * 0.45,
    tailLevel: p.tailLevel * 0.2,
    loudness: p.loudness * 0.28,
    level: p.level * 0.42,
    suppressed: true,
  };
}

const suppressedCache = new Map<string, GunProfile>();

/**
 * Resolve a bank key to a profile. Unknown keys fall back to the assault
 * rifle rather than to silence — a weapon added tomorrow makes a plausible
 * noise today.
 */
export function gunProfile(bank: string, suppressed = false): GunProfile {
  const base = bank.replace(/_(far|distant|sup|suppressed)$/, "");
  const p = GUN_PROFILES[base] ?? GUN_PROFILES.ar556;
  if (!suppressed && !/_sup|_suppressed/.test(bank)) return p;
  let s = suppressedCache.get(p.key);
  if (!s) {
    s = suppressedOf(p);
    suppressedCache.set(p.key, s);
  }
  return s;
}

/* ================================================================== *
 * Baking — the close shot
 * ================================================================== */

const CORE_SECONDS = 0.42;
const CORE_VARIANTS = 3;

function renderShotCore(
  out: Float32Array,
  sr: number,
  p: GunProfile,
  variant: number,
  rng: Rng,
): void {
  const n = out.length;
  out.fill(0);
  const jitter = 1 + (variant - (CORE_VARIANTS - 1) / 2) * 0.045;

  /* --- 1. transient ---------------------------------------------------- */
  // 2 ms of bright noise, highpassed. This is the leading edge of the blast
  // wave and it is what makes a shot sound *near*.
  {
    const tn = Math.round(sr * 0.004);
    const t = new Float32Array(tn);
    fillNoise(t, "white", rng);
    for (let i = 0; i < tn; i++) t[i] *= Math.exp(-i / (sr * 0.00042));
    svfSweep(t, sr, 9000 * jitter, 4200, 0.9, 2);
    const g = p.suppressed ? 0.18 : 0.62;
    for (let i = 0; i < tn; i++) out[i] += t[i] * g;
  }

  /* --- 2. body --------------------------------------------------------- */
  // Two decorrelated noise layers swept at different rates. One layer alone
  // reads as synthetic; two, slightly detuned, read as a real blast because
  // real blasts are not a single resonance.
  {
    const bn = Math.min(n, Math.round(sr * Math.min(0.3, p.bodyDecay * 7)));
    const a = new Float32Array(bn);
    const b = new Float32Array(bn);
    fillNoise(a, "white", rng);
    fillNoise(b, "pink", rng);
    for (let i = 0; i < bn; i++) {
      const t = i / sr;
      // Sharp attack over 0.4 ms then exponential collapse.
      const atk = Math.min(1, t / 0.0004);
      const env = atk * Math.exp(-t / p.bodyDecay);
      a[i] *= env;
      b[i] *= env * 0.8;
    }
    // Fast sweep first, then a long slow drift — the spectral centroid of a
    // muzzle blast falls almost instantly and then crawls.
    svfSweep(a, sr, p.bodyHi * jitter, p.bodyLo, p.bodyQ, 1, (u) => Math.pow(u, 0.35));
    svfSweep(b, sr, p.bodyHi * 0.55 * jitter, p.bodyLo * 0.7, p.bodyQ * 0.8, 1, (u) =>
      Math.pow(u, 0.6),
    );
    for (let i = 0; i < bn; i++) out[i] += a[i] * 0.85 + b[i] * 0.7;
  }

  /* --- 3. thump -------------------------------------------------------- */
  {
    const tn = Math.min(n, Math.round(sr * Math.min(0.5, p.thumpDecay * 6)));
    let phase = 0;
    const logHi = Math.log(p.thumpHi);
    const logLo = Math.log(p.thumpLo);
    for (let i = 0; i < tn; i++) {
      const t = i / sr;
      const u = clamp01(t / (p.thumpDecay * 2.5));
      const f = Math.exp(logHi + (logLo - logHi) * Math.pow(u, 0.5));
      phase += (2 * Math.PI * f) / sr;
      const env = Math.min(1, t / 0.0012) * Math.exp(-t / p.thumpDecay);
      // Slight second harmonic: a pure sine sounds like a test tone.
      out[i] += (Math.sin(phase) + 0.22 * Math.sin(phase * 2)) * env * p.thumpLevel;
    }
  }

  /* --- 4. mechanical --------------------------------------------------- */
  {
    const base = MODAL_LIBRARY[p.mech.material] ?? MODAL_LIBRARY.metal;
    const spec: ModalSpec = {
      ...base,
      modes: base.modes.map((m) => ({
        f: m.f * p.mech.pitch * jitter,
        decay: m.decay * 0.35,
        gain: m.gain,
      })),
      noise: (base.noise ?? 0.2) * 1.4,
    };
    const off = Math.round((p.mech.delay + rng.range(-0.002, 0.002)) * sr);
    const mn = Math.min(n - off, Math.round(sr * 0.18));
    if (mn > 8) {
      const m = new Float32Array(mn);
      renderModal(m, sr, spec, rng);
      for (let i = 0; i < mn; i++) out[off + i] += m[i] * p.mech.level;
    }
  }

  /* --- 5. supersonic crack --------------------------------------------- */
  // The N-wave of the bullet passing. Heard by *anyone downrange*, so it is
  // baked into the core and simply mixed lower for the shooter.
  if (p.supersonic && !p.suppressed) {
    const cn = Math.round(sr * 0.006);
    const c = new Float32Array(cn);
    fillNoise(c, "white", rng);
    for (let i = 0; i < cn; i++) c[i] *= Math.exp(-i / (sr * 0.0009));
    svfSweep(c, sr, 6800, 2600, 2.4, 1);
    const off = Math.round(sr * 0.0015);
    for (let i = 0; i < cn && off + i < n; i++) out[off + i] += c[i] * 0.3;
  }

  softClip(out, 1 + p.drive * 2.2);
  dcBlock(out, sr, 22);
  normalize(out, 0.95);
  edgeFade(out, sr, 0.05, 8);
}

/**
 * The far-field core: everything above ~2 kHz has been eaten by 300 m of air,
 * the blast has smeared into a boom, and what is left is the thump plus the
 * downrange crack. Baked separately because it is not the near sound with a
 * lowpass on it — the *envelope* is different too.
 */
function renderDistantCore(out: Float32Array, sr: number, p: GunProfile, rng: Rng): void {
  const n = out.length;
  out.fill(0);

  if (p.supersonic && !p.suppressed) {
    const cn = Math.round(sr * 0.02);
    const c = new Float32Array(cn);
    fillNoise(c, "white", rng);
    for (let i = 0; i < cn; i++) c[i] *= Math.exp(-i / (sr * 0.0028));
    svfSweep(c, sr, 3400, 900, 1.6, 1);
    for (let i = 0; i < cn; i++) out[i] += c[i] * 0.55;
  }

  const bn = Math.min(n, Math.round(sr * 0.35));
  const b = new Float32Array(bn);
  fillNoise(b, "brown", rng);
  for (let i = 0; i < bn; i++) {
    const t = i / sr;
    b[i] *= Math.min(1, t / 0.006) * Math.exp(-t / (p.thumpDecay * 2.4));
  }
  svfSweep(b, sr, 700, 130, 0.8, 0, (u) => Math.pow(u, 0.5));
  const off = Math.round(sr * 0.012);
  for (let i = 0; i < bn && off + i < n; i++) out[off + i] += b[i] * 1.2 * p.thumpLevel;

  onePoleLowpass(out, sr, 2400);
  dcBlock(out, sr, 20);
  normalize(out, 0.85);
  edgeFade(out, sr, 0.5, 20);
}

/* ================================================================== *
 * Baking — the city tail
 * ================================================================== */

/**
 * Render the reflection tail for a weapon in a given space.
 *
 * Not a reverb send: a genuine, separately-authored layer. The send-based
 * reverb handles the room's response to *everything*; this is the specific,
 * much louder late energy of a 160 dB impulse bouncing off six city blocks,
 * with discrete slapbacks at plausible geometric delays and a spectrum that
 * has already lost its top end to two or three hundred metres of travel.
 */
function renderShotTail(
  chans: Float32Array[],
  sr: number,
  p: GunProfile,
  env: EnvironmentKind,
  rng: Rng,
): void {
  const preset = ENVIRONMENTS[env];
  const n = chans[0].length;
  const decay = preset.ir.decay * p.tailScale * 1.25;
  const tau = Math.max(0.05, decay) / 6.908;

  for (let c = 0; c < chans.length; c++) {
    const d = chans[c];
    d.fill(0);

    // Diffuse late field.
    const stride = 5;
    for (let i = 0; i < n; i += stride) {
      const j = i + ((rng.next() * stride) | 0);
      if (j >= n) break;
      const t = j / sr;
      d[j] += (rng.next() < 0.5 ? -1 : 1) * Math.exp(-t / tau);
    }

    // Discrete slapbacks. In a canyon the same blast comes back off the far
    // facade, then off the one behind you, then off the cross street — three
    // or four clearly separable returns before the diffuse field takes over.
    const slap = preset.slapback;
    if (slap > 0.004) {
      const taps = env === "bay" ? 2 : env === "canyon" ? 5 : env === "alley" ? 8 : 4;
      for (let k = 1; k <= taps; k++) {
        const t = slap * k * (1 + rng.range(-0.18, 0.28));
        const idx = Math.round(t * sr);
        if (idx >= n) break;
        const g = Math.pow(0.62, k) * preset.ir.earlyGain * (c === 0 ? 1 : -1) * (0.8 + rng.next() * 0.4);
        // Each return is a smeared burst, not an impulse: the facade it came
        // off is 40 m wide and every part of it arrives at a different time.
        const w = Math.round(sr * 0.018 * (1 + k * 0.4));
        for (let i = 0; i < w && idx + i < n; i++) {
          d[idx + i] += g * (rng.next() * 2 - 1) * Math.exp(-i / (w * 0.35));
        }
      }
    }

    // The tail has travelled: bandlimit it. Low end survives, top is gone.
    svfSweep(d, sr, 2600, 420, 0.8, 0, (u) => u);
    // Restore a little chest weight — a big shot's tail has real low energy.
    {
      const a = Math.exp((-2 * Math.PI * 90) / sr);
      let y = 0;
      for (let i = 0; i < n; i++) {
        y = d[i] * (1 - a) + y * a;
        d[i] += y * 1.6;
      }
    }
    dcBlock(d, sr, 28);
    normalize(d, 0.8);
    edgeFade(d, sr, 1.5, 60);
  }
}

/* ================================================================== *
 * Bank access
 * ================================================================== */

function coreBuffer(p: GunProfile, variant: number): AudioBuffer | null {
  const ctx = audioEngine.ctx;
  if (!ctx) return null;
  return bakeSync(ctx, `gun:core:${p.key}:${variant}`, CORE_SECONDS, 1, (ch, sr, rng) =>
    renderShotCore(ch[0], sr, p, variant, rng),
  );
}

function distantBuffer(p: GunProfile): AudioBuffer | null {
  const ctx = audioEngine.ctx;
  if (!ctx) return null;
  return bakeSync(ctx, `gun:far:${p.key}`, 0.55, 1, (ch, sr, rng) =>
    renderDistantCore(ch[0], sr, p, rng),
  );
}

function tailBuffer(p: GunProfile, env: EnvironmentKind): AudioBuffer | null {
  const ctx = audioEngine.ctx;
  if (!ctx) return null;
  const seconds = clamp(ENVIRONMENTS[env].ir.decay * p.tailScale * 1.4 + 0.4, 0.5, 4.2);
  return bakeSync(ctx, `gun:tail:${p.key}:${env}`, seconds, 2, (ch, sr, rng) =>
    renderShotTail(ch, sr, p, env, rng),
  );
}

/* ================================================================== *
 * Mechanical banks (reloads, bolts, dry fire)
 * ================================================================== */

interface MechEvent {
  /** Seconds from the start of the bank. */
  t: number;
  material: keyof typeof MODAL_LIBRARY;
  /** Frequency scale on the material's modes. */
  pitch: number;
  gain: number;
  /** Shorten (or lengthen) the modal decays. */
  damp: number;
}

interface MechBank {
  seconds: number;
  events: MechEvent[];
  /** Cloth/hand foley mixed under, 0..1. */
  cloth: number;
  /** Spring ring, 0..1 — magazine springs and recoil springs. */
  spring: number;
  level: number;
}

const M = (
  t: number,
  material: keyof typeof MODAL_LIBRARY,
  pitch: number,
  gain: number,
  damp = 0.4,
): MechEvent => ({ t, material, pitch, gain, damp });

/**
 * Reload sounds are choreography. A magazine change is: catch button, mag
 * falls free and clatters, hand slaps a fresh one in, it seats with a click,
 * then the bolt goes forward. Five distinct impacts with real spacing — get
 * the *timing* right and it is convincing even with crude timbres.
 */
export const MECH_BANKS: Record<string, MechBank> = {
  mag_out_pistol: {
    seconds: 0.5,
    level: 0.5,
    cloth: 0.3,
    spring: 0.15,
    events: [M(0, "metal", 2.4, 0.35, 0.18), M(0.045, "plastic", 1.5, 0.5), M(0.2, "metal", 1.1, 0.4, 0.7)],
  },
  mag_in_pistol: {
    seconds: 0.42,
    level: 0.55,
    cloth: 0.35,
    spring: 0.2,
    events: [M(0.02, "plastic", 1.3, 0.4), M(0.14, "metal", 1.25, 0.75, 0.3)],
  },
  mag_out_smg: {
    seconds: 0.6,
    level: 0.55,
    cloth: 0.3,
    spring: 0.2,
    events: [M(0, "metal", 2.1, 0.35, 0.2), M(0.05, "thinMetal", 1.1, 0.55), M(0.24, "metal", 0.9, 0.45, 0.8)],
  },
  mag_in_smg: {
    seconds: 0.45,
    level: 0.6,
    cloth: 0.35,
    spring: 0.25,
    events: [M(0.02, "plastic", 1.1, 0.4), M(0.15, "metal", 1.05, 0.8, 0.3)],
  },
  mag_out_rifle: {
    seconds: 0.7,
    level: 0.6,
    cloth: 0.35,
    spring: 0.2,
    events: [M(0, "metal", 1.9, 0.4, 0.2), M(0.06, "thinMetal", 0.95, 0.6), M(0.3, "metal", 0.8, 0.5, 0.9)],
  },
  mag_in_rifle: {
    seconds: 0.5,
    level: 0.66,
    cloth: 0.4,
    spring: 0.3,
    events: [M(0.02, "plastic", 0.95, 0.45), M(0.17, "metal", 0.9, 0.9, 0.32)],
  },
  belt_out: {
    seconds: 0.9,
    level: 0.6,
    cloth: 0.5,
    spring: 0.1,
    events: [
      M(0, "metal", 1.4, 0.4, 0.25),
      M(0.09, "thinMetal", 1.8, 0.3, 0.3),
      M(0.19, "thinMetal", 1.6, 0.28, 0.3),
      M(0.31, "thinMetal", 2.0, 0.26, 0.3),
      M(0.46, "metal", 0.85, 0.45, 0.9),
    ],
  },
  belt_in: {
    seconds: 0.85,
    level: 0.62,
    cloth: 0.5,
    spring: 0.15,
    events: [
      M(0.02, "thinMetal", 1.7, 0.3, 0.3),
      M(0.13, "thinMetal", 1.5, 0.32, 0.3),
      M(0.26, "metal", 1.0, 0.5, 0.4),
      M(0.42, "metal", 0.82, 0.8, 0.35),
    ],
  },
  shell_in: {
    seconds: 0.34,
    level: 0.5,
    cloth: 0.45,
    spring: 0.1,
    events: [M(0.01, "plastic", 1.0, 0.5, 0.35), M(0.1, "metal", 1.15, 0.55, 0.3)],
  },
  pump: {
    seconds: 0.44,
    level: 0.8,
    cloth: 0.2,
    spring: 0.4,
    events: [
      M(0, "metal", 0.9, 0.7, 0.28),
      M(0.05, "plastic", 0.8, 0.3, 0.5),
      M(0.15, "metal", 1.05, 0.85, 0.25),
    ],
  },
  slide_release: {
    seconds: 0.28,
    level: 0.8,
    cloth: 0.1,
    spring: 0.45,
    events: [M(0, "metal", 1.5, 0.55, 0.2), M(0.028, "metal", 1.15, 1.0, 0.22)],
  },
  bolt_release: {
    seconds: 0.32,
    level: 0.85,
    cloth: 0.1,
    spring: 0.5,
    events: [M(0, "metal", 1.2, 0.5, 0.2), M(0.035, "metal", 0.95, 1.0, 0.24)],
  },
  bolt_smg: {
    seconds: 0.3,
    level: 0.78,
    cloth: 0.12,
    spring: 0.5,
    events: [M(0, "thinMetal", 1.4, 0.5, 0.2), M(0.03, "metal", 1.2, 0.95, 0.22)],
  },
  bolt_heavy: {
    seconds: 0.55,
    level: 0.9,
    cloth: 0.15,
    spring: 0.4,
    events: [
      M(0, "metal", 0.8, 0.6, 0.3),
      M(0.11, "metal", 0.7, 0.5, 0.4),
      M(0.24, "metal", 0.75, 1.0, 0.28),
    ],
  },
  breech_open: {
    seconds: 0.5,
    level: 0.7,
    cloth: 0.2,
    spring: 0.3,
    events: [M(0, "metal", 0.85, 0.7, 0.35), M(0.18, "metal", 1.6, 0.35, 0.5)],
  },
  breech_close: {
    seconds: 0.4,
    level: 0.8,
    cloth: 0.15,
    spring: 0.25,
    events: [M(0.02, "metal", 0.9, 0.5, 0.4), M(0.13, "metal", 0.72, 1.0, 0.3)],
  },
  tube_out: {
    seconds: 0.6,
    level: 0.6,
    cloth: 0.55,
    spring: 0.1,
    events: [M(0, "metal", 0.6, 0.5, 0.6), M(0.22, "plastic", 0.7, 0.4, 0.5)],
  },
  tube_in: {
    seconds: 0.55,
    level: 0.7,
    cloth: 0.5,
    spring: 0.15,
    events: [M(0.05, "plastic", 0.65, 0.4, 0.5), M(0.26, "metal", 0.58, 0.9, 0.5)],
  },
  draw_light: {
    seconds: 0.4,
    level: 0.42,
    cloth: 0.9,
    spring: 0.1,
    events: [M(0.06, "fabric", 1, 0.5), M(0.2, "metal", 1.4, 0.3, 0.35)],
  },
  draw_rifle: {
    seconds: 0.55,
    level: 0.5,
    cloth: 1,
    spring: 0.15,
    events: [M(0.05, "fabric", 1, 0.6), M(0.24, "metal", 1.0, 0.4, 0.4), M(0.34, "thinMetal", 1.6, 0.25, 0.3)],
  },
  draw_heavy: {
    seconds: 0.7,
    level: 0.55,
    cloth: 1,
    spring: 0.1,
    events: [M(0.06, "fabric", 0.9, 0.7), M(0.3, "metal", 0.75, 0.5, 0.5)],
  },
  dry_click: {
    seconds: 0.16,
    level: 0.55,
    cloth: 0.05,
    spring: 0.2,
    events: [M(0, "metal", 2.2, 0.9, 0.12)],
  },
  pin_pull: {
    seconds: 0.3,
    level: 0.6,
    cloth: 0.3,
    spring: 0.35,
    events: [M(0, "metal", 2.6, 0.5, 0.15), M(0.06, "metal", 1.9, 0.8, 0.18)],
  },
  pouch: {
    seconds: 0.4,
    level: 0.35,
    cloth: 1,
    spring: 0,
    events: [M(0.05, "fabric", 1, 0.8)],
  },
  sticky_arm: {
    seconds: 0.32,
    level: 0.5,
    cloth: 0.1,
    spring: 0.1,
    events: [M(0, "plastic", 1.8, 0.6, 0.2), M(0.09, "plastic", 2.4, 0.4, 0.15)],
  },
  casing_light: {
    seconds: 0.5,
    level: 0.3,
    cloth: 0,
    spring: 0,
    events: [
      M(0, "thinMetal", 3.2, 0.5, 0.35),
      M(0.09, "thinMetal", 3.0, 0.3, 0.3),
      M(0.16, "thinMetal", 3.4, 0.18, 0.25),
      M(0.23, "thinMetal", 3.1, 0.1, 0.2),
    ],
  },
  casing_heavy: {
    seconds: 0.7,
    level: 0.36,
    cloth: 0,
    spring: 0,
    events: [
      M(0, "metal", 2.1, 0.5, 0.5),
      M(0.12, "metal", 1.9, 0.32, 0.45),
      M(0.24, "thinMetal", 2.3, 0.2, 0.35),
      M(0.37, "thinMetal", 2.5, 0.11, 0.3),
    ],
  },
};

function renderMech(out: Float32Array, sr: number, bank: MechBank, rng: Rng): void {
  const n = out.length;
  out.fill(0);

  for (const e of bank.events) {
    const base = MODAL_LIBRARY[e.material] ?? MODAL_LIBRARY.metal;
    const spec: ModalSpec = {
      ...base,
      modes: base.modes.map((m) => ({
        f: m.f * e.pitch * rng.range(0.985, 1.015),
        decay: m.decay * e.damp,
        gain: m.gain,
      })),
    };
    const off = Math.round(e.t * sr);
    const len = Math.min(n - off, Math.round(sr * 0.5));
    if (len <= 8) continue;
    const tmp = new Float32Array(len);
    renderModal(tmp, sr, spec, rng);
    for (let i = 0; i < len; i++) out[off + i] += tmp[i] * e.gain;
  }

  // Cloth: filtered brown noise, slow attack. Hands and webbing.
  if (bank.cloth > 0.001) {
    const cn = Math.min(n, Math.round(sr * bank.seconds * 0.8));
    const c = new Float32Array(cn);
    fillNoise(c, "brown", rng);
    for (let i = 0; i < cn; i++) {
      const u = i / cn;
      // Two overlapping rustles, because a hand moving is not one event.
      c[i] *= (Math.exp(-Math.pow((u - 0.18) * 5.5, 2)) + 0.6 * Math.exp(-Math.pow((u - 0.55) * 4, 2)));
    }
    svfSweep(c, sr, 1800, 900, 0.8, 1);
    for (let i = 0; i < cn; i++) out[i] += c[i] * bank.cloth * 0.5;
  }

  // Spring: a high, fast-decaying resonance with a touch of vibrato — the
  // sound of a coil letting go inside a metal tube.
  if (bank.spring > 0.001) {
    const sn = Math.min(n, Math.round(sr * 0.22));
    let phase = 0;
    for (let i = 0; i < sn; i++) {
      const t = i / sr;
      const f = 2400 * (1 + 0.05 * Math.sin(2 * Math.PI * 42 * t));
      phase += (2 * Math.PI * f) / sr;
      out[i] += Math.sin(phase) * Math.exp(-t / 0.035) * bank.spring * 0.18;
    }
  }

  dcBlock(out, sr, 40);
  normalize(out, 0.9);
  edgeFade(out, sr, 0.3, 10);
}

function mechBuffer(key: string): AudioBuffer | null {
  const ctx = audioEngine.ctx;
  if (!ctx) return null;
  const bank = MECH_BANKS[key];
  if (!bank) return null;
  return bakeSync(ctx, `mech:${key}`, bank.seconds, 1, (ch, sr, rng) =>
    renderMech(ch[0], sr, bank, rng),
  );
}

/* ================================================================== *
 * Playback
 * ================================================================== */

export interface ShotOptions {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  /** Linear gain multiplier over the bank's authored level. */
  volume?: number;
  pitch?: number;
  loudness?: number;
  /** First-person: no attenuation, no propagation delay. */
  local?: boolean;
  suppressed?: boolean;
  /** Reverb hint, 0..1. Overrides the environment's own wetness for the tail. */
  wet?: number;
  /** Pre-delay of the first slapback, seconds. */
  echoDelay?: number;
}

const shotRng = makeRng("sf-audio:shots");
let variantCursor = 0;

/**
 * Fire a gun.
 *
 * Chooses near vs. far rendering from range, schedules propagation delay,
 * and always lays the city tail underneath. The tail is *louder in relative
 * terms* the further away the shot is — the direct blast attenuates with
 * distance but the reflected energy arrives from every facade at once, which
 * is why distant gunfire in a city is all rumble and no crack.
 */
export function playShot(bank: string, opts: ShotOptions): void {
  if (!audioEngine.available || audioEngine.settings.muted) return;
  const ctx = audioEngine.ctx;
  if (!ctx) return;

  const p = gunProfile(bank, opts.suppressed);
  const local = !!opts.local;
  const dist = local ? 0 : distanceTo(opts.x, opts.y, opts.z);
  const loudness = opts.loudness ?? p.loudness;
  if (!local && dist > loudness * 1.3) return;

  const vol = (opts.volume ?? 1) * p.level;
  const pitch = (opts.pitch ?? 1) * shotRng.range(0.975, 1.025);
  const far = !local && dist > 110;

  const variant = variantCursor++ % CORE_VARIANTS;
  const core = far ? distantBuffer(p) : coreBuffer(p, variant);

  const o = scratchOptions as VoiceOptions;
  o.x = opts.x;
  o.y = opts.y;
  o.z = opts.z;
  o.vx = opts.vx ?? 0;
  o.vy = opts.vy ?? 0;
  o.vz = opts.vz ?? 0;
  o.bus = "weapons";
  o.local = local;
  o.pan = 0;
  o.gain = vol * (far ? 1.25 : 1);
  o.pitch = pitch;
  o.priority = local ? 1 : clamp01(0.85 - dist / (loudness * 2));
  o.loudness = loudness;
  o.propagate = !local;
  o.noOcclusion = local;
  o.when = undefined;
  o.duration = undefined;
  playBuffer(core, o);

  /* ---- the tail ---- */
  const env = audioEngine.environment;
  const tail = tailBuffer(p, env);
  if (!tail) return;

  const preset = ENVIRONMENTS[env];
  const wet = opts.wet ?? preset.wet;
  // Near: the tail is a supporting layer. Far: it *is* the sound.
  const distFactor = local ? 0.75 : 0.6 + clamp01(dist / 160) * 1.1;
  const tailGain = vol * p.tailLevel * wet * distFactor * 1.5;
  if (tailGain < 0.004) return;

  const delay = opts.echoDelay ?? preset.slapback * 0.5;
  const when = ctx.currentTime + delay + (local ? 0 : dist / SPEED_OF_SOUND);

  o.gain = tailGain;
  o.pitch = pitch;
  o.priority = (o.priority as number) * 0.6;
  o.when = when;
  // Tails are already diffuse — probing occlusion on them wastes rays and
  // sounds wrong, because reflected energy reaches you around the corner
  // even when the muzzle does not.
  o.noOcclusion = true;
  o.propagate = false;
  o.local = local || dist < 25;
  playBuffer(tail, o);
  o.when = undefined;
  o.local = false;
  o.noOcclusion = false;
}

/** Explicitly play the far-field version (used for scripted distant gunfire). */
export function playDistantShot(bank: string, opts: ShotOptions): void {
  if (!audioEngine.available) return;
  const p = gunProfile(bank, opts.suppressed);
  const o = scratchOptions as VoiceOptions;
  o.x = opts.x;
  o.y = opts.y;
  o.z = opts.z;
  o.bus = "weapons";
  o.local = false;
  o.gain = (opts.volume ?? 1) * p.level * 0.8;
  o.pitch = opts.pitch ?? 1;
  o.priority = 0.3;
  o.loudness = opts.loudness ?? p.loudness;
  o.propagate = true;
  o.noOcclusion = false;
  playBuffer(distantBuffer(p), o);
}

/** Reloads, bolts, draws, dry fire — anything mechanical. */
export function playWeaponMech(bank: string, opts: ShotOptions): void {
  if (!audioEngine.available) return;
  const buf = mechBuffer(bank);
  if (!buf) return;
  const b = MECH_BANKS[bank];
  const o = scratchOptions as VoiceOptions;
  o.x = opts.x;
  o.y = opts.y;
  o.z = opts.z;
  o.bus = "weapons";
  o.local = opts.local ?? false;
  o.gain = (opts.volume ?? 1) * (b?.level ?? 0.6);
  o.pitch = (opts.pitch ?? 1) * shotRng.range(0.97, 1.03);
  o.priority = opts.local ? 0.8 : 0.4;
  o.loudness = opts.loudness ?? 45;
  o.propagate = !opts.local;
  o.noOcclusion = !!opts.local;
  o.when = undefined;
  playBuffer(buf, o);
}

/** An ejected case hitting the ground. Tiny, but it sells the machine. */
export function playCasing(heavy: boolean, opts: ShotOptions): void {
  playWeaponMech(heavy ? "casing_heavy" : "casing_light", {
    ...opts,
    volume: (opts.volume ?? 1) * 0.6,
  });
}

/**
 * The sink object `weapons/bridge.ts` looks for.
 *
 * Bank naming does the routing: `*_far` is a distant shot, a key in
 * `GUN_PROFILES` is a gunshot, anything else is mechanical. This means the
 * weapon registry can add a gun and get correct audio with no change here.
 */
export const weaponSink = {
  play(bank: string, opts: ShotOptions): void {
    if (!bank) return;
    if (/_far$|_distant$/.test(bank)) {
      playDistantShot(bank, opts);
      return;
    }
    const base = bank.replace(/_(sup|suppressed)$/, "");
    if (GUN_PROFILES[base]) {
      playShot(bank, opts);
      return;
    }
    playWeaponMech(bank, opts);
  },
};

/**
 * Pre-bake the expensive banks.
 *
 * Called once from the loading screen. Baking a tail is a few milliseconds;
 * doing it on the first trigger pull of a firefight is a visible hitch, and
 * doing all of them at once is a visible freeze — so this yields between
 * weapons via the microtask queue and finishes well inside the load.
 */
export async function primeWeaponBanks(keys?: readonly string[]): Promise<void> {
  if (!audioEngine.ctx) return;
  const list = keys ?? Object.keys(GUN_PROFILES);
  const env = audioEngine.environment;
  for (const k of list) {
    const p = GUN_PROFILES[k];
    if (!p) continue;
    for (let v = 0; v < CORE_VARIANTS; v++) coreBuffer(p, v);
    distantBuffer(p);
    tailBuffer(p, env);
    await Promise.resolve();
  }
  for (const k of Object.keys(MECH_BANKS)) {
    mechBuffer(k);
    await Promise.resolve();
  }
}

/**
 * Warm the tails for a space before the player walks into it. Optional; the
 * lazy path is correct, this just moves the cost off the first shot.
 */
export function primeTailsFor(env: EnvironmentKind): void {
  for (const k of Object.keys(GUN_PROFILES)) tailBuffer(GUN_PROFILES[k], env);
}
