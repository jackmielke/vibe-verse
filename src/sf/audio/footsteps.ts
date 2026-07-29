/**
 * audio/footsteps.ts — surfaces, and everything that touches them.
 *
 * This module owns the mapping *surface → sound*, and it owns it for
 * everybody: footsteps, landings, bullet impacts, ricochets, bodies hitting
 * the floor. One table, so a bullet into wet sand and a boot into wet sand
 * agree about what sand is. Two systems disagreeing about the material is the
 * audio equivalent of cars in walls.
 *
 * A footstep is three layers:
 *   - **strike** — the heel. A modal hit on the material, hard and short.
 *   - **scuff** — the roll onto the toe. Filtered noise with a slower attack;
 *     this is the layer that carries the *texture* of the ground.
 *   - **weight** — a 60–90 Hz body thump. Sub-audible on laptop speakers, and
 *     the reason the step feels like a person rather than a marble.
 *
 * Plus foley — cloth rustle and gear jingle — which is keyed to movement state
 * rather than to the step itself, because webbing keeps moving between steps
 * and a sprint sounds nothing like a walk even before the boots land.
 *
 * Cadence is derived from `frame` and the geometry from `sfGeo`, so nothing
 * here has to be told where the player is or what they are standing on.
 *
 * Public API
 * ----------
 *   playFootstep(surface, opts) / playLanding(surface, opts) / playJump(opts)
 *   playImpact(surface, opts) / playRicochet(surface, opts) / playBodyFall(...)
 *   playFoley(kind, intensity)
 *   updateFootsteps(dt)        — automatic cadence for the local player
 *   surfaceAt(x, z)            — geometry → surface, the single source of truth
 *   AudioSurface
 */
import { clamp, clamp01, makeRng } from "../math/rng";
import { frame } from "../state/store";
import { isPark, isRoad, isWater, terrainSlope } from "../geo/sfGeo";
import { audioEngine } from "./engine";
import { playBuffer, scratchOptions, voicePool, type VoiceOptions } from "./spatial";
import {
  MODAL_LIBRARY,
  bakeSync,
  dcBlock,
  edgeFade,
  fillNoise,
  normalize,
  renderModal,
  softClip,
  svfSweep,
  noiseBuffer,
  type ModalSpec,
} from "./synth";

/**
 * Surface names deliberately mirror the physics module's `SurfaceTag` so a
 * raycast result can be handed straight to `playImpact` with no translation
 * table in between. Unknown names fall back to concrete.
 */
export type AudioSurface =
  | "concrete"
  | "asphalt"
  | "metal"
  | "thinMetal"
  | "glass"
  | "wood"
  | "brick"
  | "stucco"
  | "stone"
  | "dirt"
  | "grass"
  | "sand"
  | "gravel"
  | "water"
  | "flesh"
  | "foliage"
  | "plastic"
  | "rubber"
  | "fabric"
  | "carpet";

interface SurfaceFoot {
  /** Modal material for the heel strike. */
  material: keyof typeof MODAL_LIBRARY;
  /** Frequency scale on that material. */
  pitch: number;
  /** Heel level. */
  strike: number;
  /** Scuff band, Hz, and its level/length. */
  scuffHi: number;
  scuffLo: number;
  scuff: number;
  scuffTime: number;
  /** Body thump level. */
  weight: number;
  /** How much of the step is water displacement. */
  splash: number;
  /** Overall level. */
  level: number;
}

const F = (
  material: keyof typeof MODAL_LIBRARY,
  pitch: number,
  strike: number,
  scuffHi: number,
  scuffLo: number,
  scuff: number,
  scuffTime: number,
  weight: number,
  level: number,
  splash = 0,
): SurfaceFoot => ({
  material,
  pitch,
  strike,
  scuffHi,
  scuffLo,
  scuff,
  scuffTime,
  weight,
  level,
  splash,
});

/**
 * The table. Numbers are what the material *is*: concrete is a hard click with
 * almost no texture, gravel is nearly all texture and no click, a steel
 * catwalk rings for half a second, grass is a soft brush with no top end.
 */
const SURFACE_FOOT: Record<AudioSurface, SurfaceFoot> = {
  concrete: F("concrete", 1.0, 0.9, 5200, 1500, 0.4, 0.07, 0.55, 0.55),
  asphalt: F("asphalt", 1.0, 0.7, 3600, 1000, 0.55, 0.09, 0.6, 0.55),
  metal: F("metal", 0.9, 1.0, 7000, 2200, 0.3, 0.06, 0.4, 0.6),
  thinMetal: F("thinMetal", 1.0, 1.0, 9000, 3000, 0.3, 0.05, 0.3, 0.62),
  glass: F("glass", 1.0, 0.7, 9000, 4000, 0.25, 0.04, 0.3, 0.4),
  wood: F("wood", 0.85, 0.95, 4200, 900, 0.35, 0.07, 0.7, 0.6),
  brick: F("brick", 1.0, 0.85, 4600, 1300, 0.45, 0.08, 0.55, 0.55),
  stucco: F("stucco", 1.0, 0.7, 4000, 1200, 0.5, 0.08, 0.5, 0.5),
  stone: F("stone", 0.95, 0.95, 5600, 1600, 0.4, 0.07, 0.6, 0.58),
  dirt: F("dirt", 1.0, 0.45, 2400, 500, 0.85, 0.12, 0.65, 0.5),
  grass: F("grass", 1.0, 0.25, 3600, 800, 1.0, 0.15, 0.5, 0.42),
  sand: F("sand", 1.0, 0.15, 5200, 1100, 1.15, 0.19, 0.45, 0.44),
  gravel: F("gravel", 1.0, 0.6, 6800, 1600, 1.2, 0.13, 0.5, 0.55),
  water: F("water", 1.0, 0.35, 3200, 600, 0.9, 0.2, 0.5, 0.6, 1),
  flesh: F("flesh", 1.0, 0.8, 1400, 300, 0.7, 0.08, 0.9, 0.5),
  foliage: F("foliage", 1.0, 0.15, 7000, 1800, 1.1, 0.18, 0.25, 0.4),
  plastic: F("plastic", 1.0, 0.8, 5000, 1500, 0.35, 0.06, 0.4, 0.45),
  rubber: F("rubber", 1.0, 0.7, 2000, 500, 0.4, 0.08, 0.6, 0.45),
  fabric: F("fabric", 1.0, 0.2, 3000, 700, 0.9, 0.14, 0.4, 0.35),
  carpet: F("carpet" as keyof typeof MODAL_LIBRARY, 1.0, 0.2, 2200, 500, 0.8, 0.13, 0.55, 0.34),
};

// `carpet` has no modal entry of its own; fabric is the right resonator.
const MATERIAL_ALIAS: Partial<Record<string, keyof typeof MODAL_LIBRARY>> = {
  carpet: "fabric",
};

function modalFor(name: string): ModalSpec {
  const alias = MATERIAL_ALIAS[name] ?? (name as keyof typeof MODAL_LIBRARY);
  return MODAL_LIBRARY[alias] ?? MODAL_LIBRARY.concrete;
}

export function surfaceFoot(s: string): SurfaceFoot {
  return SURFACE_FOOT[s as AudioSurface] ?? SURFACE_FOOT.concrete;
}

/* ================================================================== *
 * Geometry → surface
 * ================================================================== */

/**
 * What is under (x, z), asked of `sfGeo` and nothing else.
 *
 * Roads are asphalt, parks are grass, the bay is water, steep unbuilt slopes
 * are dirt, everything else is the sidewalk. The whole city runs off four
 * predicates, which is exactly why it never disagrees with the terrain.
 */
export function surfaceAt(x: number, z: number): AudioSurface {
  if (isWater(x, z)) return "water";
  if (isRoad(x, z)) return "asphalt";
  if (isPark(x, z)) return "grass";
  if (terrainSlope(x, z) > 0.42) return "dirt";
  return "concrete";
}

/* ================================================================== *
 * Baking
 * ================================================================== */

const FOOT_VARIANTS = 4;

function renderFootstep(
  out: Float32Array,
  sr: number,
  s: SurfaceFoot,
  hard: boolean,
  variant: number,
  rng: ReturnType<typeof makeRng>,
): void {
  const n = out.length;
  out.fill(0);
  const jit = 1 + (variant - (FOOT_VARIANTS - 1) / 2) * 0.06;

  /* --- heel strike ---- */
  {
    const base = modalFor(s.material);
    const spec: ModalSpec = {
      ...base,
      modes: base.modes.map((m) => ({
        f: m.f * s.pitch * jit * rng.range(0.94, 1.06),
        decay: m.decay * (hard ? 0.9 : 0.5),
        gain: m.gain,
      })),
      exciter: base.exciter * (hard ? 1.4 : 0.9),
      noise: (base.noise ?? 0.4) * 1.1,
    };
    const len = Math.min(n, Math.round(sr * 0.35));
    const tmp = new Float32Array(len);
    renderModal(tmp, sr, spec, rng);
    const g = s.strike * (hard ? 1.4 : 1);
    for (let i = 0; i < len; i++) out[i] += tmp[i] * g;
  }

  /* --- scuff ---- */
  // Slow attack, so it sits *behind* the strike rather than on top of it —
  // the foot rolls forward after it lands.
  {
    const len = Math.min(n, Math.round(sr * s.scuffTime * 2));
    const sc = new Float32Array(len);
    fillNoise(sc, "white", rng);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const atk = clamp01(t / (s.scuffTime * 0.35));
      sc[i] *= Math.pow(atk, 1.4) * Math.exp(-t / (s.scuffTime * 0.6));
    }
    svfSweep(sc, sr, s.scuffHi * jit, s.scuffLo, 0.85, 1, (u) => Math.pow(u, 0.7));
    for (let i = 0; i < len; i++) out[i] += sc[i] * s.scuff * 0.7;
  }

  /* --- body weight ---- */
  {
    const len = Math.min(n, Math.round(sr * 0.14));
    let phase = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const f = 96 * Math.exp(-t * 22) + 52;
      phase += (2 * Math.PI * f) / sr;
      out[i] += Math.sin(phase) * Math.exp(-t / 0.035) * s.weight * (hard ? 1.5 : 1) * 0.55;
    }
  }

  /* --- splash ---- */
  if (s.splash > 0.01) {
    const len = Math.min(n, Math.round(sr * 0.4));
    const sp = new Float32Array(len);
    fillNoise(sp, "white", rng);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      sp[i] *= Math.min(1, t / 0.004) * Math.exp(-t / 0.09);
    }
    svfSweep(sp, sr, 6000, 900, 1.1, 1, (u) => Math.pow(u, 0.5));
    // Droplets: a handful of tiny high blips after the main displacement.
    for (let k = 0; k < 9; k++) {
      const off = Math.round(rng.range(0.03, 0.3) * sr);
      const dl = Math.round(sr * 0.012);
      for (let i = 0; i < dl && off + i < len; i++) {
        sp[off + i] +=
          Math.sin((2 * Math.PI * rng.range(1800, 5200) * i) / sr) *
          Math.exp(-i / (dl * 0.25)) *
          rng.range(0.05, 0.22);
      }
    }
    for (let i = 0; i < len; i++) out[i] += sp[i] * s.splash * 0.6;
  }

  dcBlock(out, sr, 35);
  normalize(out, 0.9);
  edgeFade(out, sr, 0.3, 12);
}

function footBuffer(surface: string, hard: boolean, variant: number): AudioBuffer | null {
  const ctx = audioEngine.ctx;
  if (!ctx) return null;
  const s = surfaceFoot(surface);
  return bakeSync(
    ctx,
    `foot:${surface}:${hard ? "h" : "s"}:${variant}`,
    hard ? 0.7 : 0.5,
    1,
    (ch, sr, rng) => renderFootstep(ch[0], sr, s, hard, variant, rng),
  );
}

/* ---- bullet impacts ---- */

/**
 * A bullet impact is a footstep with the energy turned up an order of
 * magnitude: the same modal material, but excited by a much shorter, much
 * harder impulse, plus spall — material being thrown off the surface.
 */
function renderImpact(
  out: Float32Array,
  sr: number,
  surface: string,
  variant: number,
  rng: ReturnType<typeof makeRng>,
): void {
  const n = out.length;
  out.fill(0);
  const base = modalFor(surface);
  const jit = 1 + (variant - 1.5) * 0.09;

  const spec: ModalSpec = {
    ...base,
    modes: base.modes.map((m) => ({
      f: m.f * jit * rng.range(0.9, 1.12),
      decay: m.decay * rng.range(0.55, 1.05),
      gain: m.gain,
    })),
    exciter: base.exciter * 0.45,
    noise: (base.noise ?? 0.4) * 1.5,
  };
  const len = Math.min(n, Math.round(sr * 0.5));
  const tmp = new Float32Array(len);
  renderModal(tmp, sr, spec, rng);
  for (let i = 0; i < len; i++) out[i] += tmp[i] * 1.15;

  // Spall / spatter: a fast bright burst thrown off the surface.
  {
    const sl = Math.min(n, Math.round(sr * 0.12));
    const sp = new Float32Array(sl);
    fillNoise(sp, "white", rng);
    for (let i = 0; i < sl; i++) {
      const t = i / sr;
      sp[i] *= Math.min(1, t / 0.0004) * Math.exp(-t / 0.014);
    }
    const wet = surface === "flesh" || surface === "water";
    svfSweep(sp, sr, wet ? 2600 : 8500, wet ? 500 : 1800, 1.0, 1, (u) => Math.pow(u, 0.4));
    for (let i = 0; i < sl; i++) out[i] += sp[i] * (wet ? 0.7 : 0.45);
  }

  // The punch. Even a 9 mm into drywall has a low thud.
  {
    const tl = Math.min(n, Math.round(sr * 0.1));
    let phase = 0;
    for (let i = 0; i < tl; i++) {
      const t = i / sr;
      const f = 190 * Math.exp(-t * 40) + 65;
      phase += (2 * Math.PI * f) / sr;
      out[i] += Math.sin(phase) * Math.exp(-t / 0.022) * 0.5;
    }
  }

  softClip(out, 1.4);
  dcBlock(out, sr, 30);
  normalize(out, 0.94);
  edgeFade(out, sr, 0.1, 12);
}

function impactBuffer(surface: string, variant: number): AudioBuffer | null {
  const ctx = audioEngine.ctx;
  if (!ctx) return null;
  return bakeSync(ctx, `impact:${surface}:${variant}`, 0.6, 1, (ch, sr, rng) =>
    renderImpact(ch[0], sr, surface, variant, rng),
  );
}

/**
 * The whine. A ricochet is a resonance sweeping *upwards* as the deformed,
 * spinning round loses energy — a downward sweep sounds like a cartoon.
 */
function renderRicochet(
  out: Float32Array,
  sr: number,
  variant: number,
  rng: ReturnType<typeof makeRng>,
): void {
  const n = out.length;
  out.fill(0);
  fillNoise(out, "white", rng);
  const f0 = 900 * (1 + variant * 0.24);
  const f1 = f0 * rng.range(3.2, 5.5);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] *= Math.min(1, t / 0.0008) * Math.exp(-t / 0.12);
  }
  svfSweep(out, sr, f0, f1, 14, 1, (u) => Math.pow(u, 0.7));
  // A little vibrato from the round tumbling.
  {
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      d[i] = out[i] * (1 + 0.35 * Math.sin(2 * Math.PI * 37 * t));
    }
    out.set(d);
  }
  dcBlock(out, sr, 200);
  normalize(out, 0.8);
  edgeFade(out, sr, 0.2, 20);
}

function ricochetBuffer(variant: number): AudioBuffer | null {
  const ctx = audioEngine.ctx;
  if (!ctx) return null;
  return bakeSync(ctx, `ric:${variant}`, 0.4, 1, (ch, sr, rng) =>
    renderRicochet(ch[0], sr, variant, rng),
  );
}

/* ---- foley ---- */

export type FoleyKind = "cloth" | "gear" | "harness" | "land";

function renderFoley(
  out: Float32Array,
  sr: number,
  kind: FoleyKind,
  variant: number,
  rng: ReturnType<typeof makeRng>,
): void {
  const n = out.length;
  out.fill(0);

  if (kind === "gear" || kind === "harness") {
    // Metal on metal: carabiners, magazine pouches, a rifle sling swivel.
    const count = kind === "gear" ? 3 : 5;
    for (let k = 0; k < count; k++) {
      const t = rng.range(0, kind === "gear" ? 0.09 : 0.16);
      const off = Math.round(t * sr);
      const len = Math.min(n - off, Math.round(sr * 0.3));
      if (len <= 16) continue;
      const base = MODAL_LIBRARY.thinMetal;
      const tmp = new Float32Array(len);
      renderModal(
        tmp,
        sr,
        {
          ...base,
          modes: base.modes.map((m) => ({
            f: m.f * rng.range(1.3, 2.8),
            decay: m.decay * rng.range(0.1, 0.3),
            gain: m.gain,
          })),
          exciter: 0.0004,
          noise: 0.1,
        },
        rng,
      );
      const g = rng.range(0.25, 1);
      for (let i = 0; i < len; i++) out[off + i] += tmp[i] * g;
    }
  }

  if (kind === "cloth" || kind === "harness" || kind === "land") {
    const len = Math.min(n, Math.round(sr * 0.3));
    const c = new Float32Array(len);
    fillNoise(c, "brown", rng);
    const peak = rng.range(0.25, 0.5);
    for (let i = 0; i < len; i++) {
      const u = i / len;
      c[i] *= Math.exp(-Math.pow((u - peak) * 4.2, 2)) * (kind === "land" ? 1.4 : 1);
    }
    svfSweep(c, sr, rng.range(1400, 2600), rng.range(600, 1100), 0.8, 1);
    for (let i = 0; i < len; i++) out[i] += c[i] * 0.8;
  }

  dcBlock(out, sr, 60);
  normalize(out, 0.75);
  edgeFade(out, sr, 0.5, 12);
}

function foleyBuffer(kind: FoleyKind, variant: number): AudioBuffer | null {
  const ctx = audioEngine.ctx;
  if (!ctx) return null;
  return bakeSync(ctx, `foley:${kind}:${variant}`, 0.4, 1, (ch, sr, rng) =>
    renderFoley(ch[0], sr, kind, variant, rng),
  );
}

/* ================================================================== *
 * Playback
 * ================================================================== */

export interface FootstepOptions {
  x: number;
  y: number;
  z: number;
  /** 0..1 — walk to sprint. Louder, harder, brighter. */
  effort?: number;
  /** First-person steps bypass attenuation. */
  local?: boolean;
  volume?: number;
  pitch?: number;
  /** Heavier characters (police in armour) get a lower, weightier step. */
  weight?: number;
}

const footRng = makeRng("sf-audio:foot");
let footVariant = 0;

export function playFootstep(surface: string, opts: FootstepOptions): void {
  if (!audioEngine.available) return;
  const s = surfaceFoot(surface);
  const effort = clamp01(opts.effort ?? 0.4);
  const hard = effort > 0.55;
  const variant = footVariant++ % FOOT_VARIANTS;
  const buf = footBuffer(surface, hard, variant);
  if (!buf) return;

  const o = scratchOptions as VoiceOptions;
  o.x = opts.x;
  o.y = opts.y;
  o.z = opts.z;
  o.vx = 0;
  o.vy = 0;
  o.vz = 0;
  o.bus = "world";
  o.local = opts.local ?? false;
  o.pan = footRng.range(-0.12, 0.12);
  o.gain = (opts.volume ?? 1) * s.level * (0.42 + effort * 0.75) * (opts.local ? 0.72 : 1);
  // Heavier weight → lower pitch. One buffer covers everyone this way.
  o.pitch = (opts.pitch ?? 1) * footRng.range(0.93, 1.08) * Math.pow(opts.weight ?? 1, -0.28);
  o.priority = opts.local ? 0.5 : 0.25;
  o.loudness = 40 + effort * 45;
  o.propagate = false;
  o.noOcclusion = !!opts.local;
  o.when = undefined;
  playBuffer(buf, o);
  o.local = false;
  o.noOcclusion = false;
}

/** Landing after a fall. `impact` is the vertical speed in m/s. */
export function playLanding(surface: string, opts: FootstepOptions & { impact?: number }): void {
  if (!audioEngine.available) return;
  const impact = clamp(opts.impact ?? 5, 0, 40);
  const strength = clamp01(impact / 18);
  playFootstep(surface, {
    ...opts,
    effort: 0.7 + strength * 0.3,
    volume: (opts.volume ?? 1) * (0.9 + strength * 1.1),
    weight: (opts.weight ?? 1) * (1 + strength * 0.5),
  });
  playFoley("land", 0.4 + strength * 0.6, opts.local ?? false, opts.x, opts.y, opts.z);
  // A hard landing is felt as well as heard: a short duck sells the jolt.
  if (strength > 0.6) audioEngine.duck(0.12 * strength, 0.01, 0.05, 0.28);
}

export function playJump(opts: FootstepOptions): void {
  playFoley("cloth", 0.6, opts.local ?? false, opts.x, opts.y, opts.z);
  playFootstep(surfaceAt(opts.x, opts.z), { ...opts, effort: 0.35, volume: 0.5 });
}

export interface ImpactOptions {
  x: number;
  y: number;
  z: number;
  /** 0..1 — round energy. Scales level and brightness. */
  power?: number;
  volume?: number;
  loudness?: number;
  local?: boolean;
}

let impactVariant = 0;

/**
 * A round hitting something. This is the single most-called sound in a
 * firefight, so it is one buffer play and nothing else.
 */
export function playImpact(surface: string, opts: ImpactOptions): void {
  if (!audioEngine.available) return;
  const variant = impactVariant++ % 4;
  const buf = impactBuffer(surface, variant);
  if (!buf) return;
  const power = clamp01(opts.power ?? 0.6);

  const o = scratchOptions as VoiceOptions;
  o.x = opts.x;
  o.y = opts.y;
  o.z = opts.z;
  o.vx = 0;
  o.vy = 0;
  o.vz = 0;
  o.bus = "weapons";
  o.local = opts.local ?? false;
  o.gain = (opts.volume ?? 1) * (0.35 + power * 0.85);
  o.pitch = footRng.range(0.86, 1.18) * (1.15 - power * 0.3);
  o.priority = 0.45 + power * 0.2;
  o.loudness = opts.loudness ?? 90 + power * 90;
  o.propagate = true;
  o.noOcclusion = false;
  o.when = undefined;
  playBuffer(buf, o);
}

/** Skip off a hard surface. Only fire this when the ballistics say it happened. */
export function playRicochet(opts: ImpactOptions): void {
  if (!audioEngine.available) return;
  const buf = ricochetBuffer(footVariant++ % 3);
  if (!buf) return;
  const o = scratchOptions as VoiceOptions;
  o.x = opts.x;
  o.y = opts.y;
  o.z = opts.z;
  o.bus = "weapons";
  o.local = false;
  o.gain = (opts.volume ?? 1) * 0.55;
  o.pitch = footRng.range(0.75, 1.4);
  o.priority = 0.5;
  o.loudness = opts.loudness ?? 200;
  o.propagate = true;
  o.noOcclusion = false;
  playBuffer(buf, o);
}

/** A body hitting the ground. Heavier and wetter than a footstep. */
export function playBodyFall(
  surface: string,
  x: number,
  y: number,
  z: number,
  force = 1,
): void {
  const f = clamp01(force);
  playFootstep(surface, {
    x,
    y,
    z,
    effort: 0.9,
    volume: 0.7 + f * 0.6,
    weight: 2.2,
    pitch: 0.72,
  });
  playImpact("flesh", { x, y, z, power: 0.35 + f * 0.4, volume: 0.5 + f * 0.4, loudness: 70 });
  playFoley("cloth", 0.8, false, x, y, z);
}

export function playFoley(
  kind: FoleyKind,
  intensity: number,
  local: boolean,
  x: number,
  y: number,
  z: number,
): void {
  if (!audioEngine.available) return;
  const i = clamp01(intensity);
  if (i < 0.03) return;
  const buf = foleyBuffer(kind, footVariant % 3);
  if (!buf) return;
  const o = scratchOptions as VoiceOptions;
  o.x = x;
  o.y = y;
  o.z = z;
  o.bus = "world";
  o.local = local;
  o.pan = footRng.range(-0.25, 0.25);
  o.gain = i * (local ? 0.3 : 0.42);
  o.pitch = footRng.range(0.9, 1.15);
  o.priority = 0.18;
  o.loudness = 26;
  o.propagate = false;
  o.noOcclusion = local;
  playBuffer(buf, o);
  o.local = false;
  o.noOcclusion = false;
}

/* ================================================================== *
 * Automatic cadence for the local player
 * ================================================================== */

/**
 * Stride length is roughly constant for a given gait and it is *distance*,
 * not time, that triggers a step. Driving the cadence off accumulated
 * horizontal distance means the footsteps stay locked to the animation at any
 * speed and never double up when the player stops on a slope.
 */
const cadence = {
  /** Metres travelled since the last step. */
  accum: 0,
  /** Which foot; alternates the pan and the pitch slightly. */
  foot: 0,
  wasGrounded: true,
  lastMovement: "grounded" as string,
  /** Continuous foley timer. */
  foleyAccum: 0,
  /** Peak downward speed while airborne, for the landing. */
  fallSpeed: 0,
};

/**
 * Advance the local player's foley. Call once a frame from `Audio.tsx`.
 *
 * Reads `frame` directly — position, velocity, movement state — and asks
 * `sfGeo` what the ground is. Nothing else needs to tell it anything.
 */
export function updateFootsteps(dt: number): void {
  if (!audioEngine.available || frame.paused) return;
  const p = frame.position;
  const v = frame.velocity;
  const grounded = frame.grounded;
  const horizontal = Math.hypot(v.x, v.z);

  if (!grounded) {
    cadence.fallSpeed = Math.max(cadence.fallSpeed, -v.y);
    cadence.accum = 0;
  } else {
    if (!cadence.wasGrounded) {
      const surface = surfaceAt(p.x, p.z);
      playLanding(surface, {
        x: p.x,
        y: p.y - 1.5,
        z: p.z,
        local: true,
        impact: cadence.fallSpeed,
      });
      cadence.fallSpeed = 0;
      cadence.accum = 0;
    } else if (frame.movement === "grounded" && horizontal > 0.4) {
      // Stride grows with speed but not proportionally — you take longer
      // strides *and* more of them when you sprint.
      const stride = clamp(0.85 + horizontal * 0.085, 0.8, 1.85);
      cadence.accum += horizontal * dt;
      if (cadence.accum >= stride) {
        cadence.accum -= stride;
        cadence.foot ^= 1;
        const effort = clamp01((horizontal - 1.2) / 7);
        const surface = surfaceAt(p.x, p.z);
        playFootstep(surface, {
          x: p.x,
          y: p.y - 1.5,
          z: p.z,
          local: true,
          effort,
          pitch: cadence.foot ? 1.03 : 0.97,
        });
        // Gear only jingles when you are actually moving fast enough to
        // swing it. At a walk, webbing is silent.
        if (effort > 0.3 && footRng.chance(0.45)) {
          playFoley("gear", effort * 0.7, true, p.x, p.y, p.z);
        }
      }
    }
  }

  // Cloth: a continuous, speed-driven rustle that is not tied to steps —
  // wingsuit, parachute, climbing and falling all move fabric.
  const moving = horizontal + Math.abs(v.y) * 0.5;
  cadence.foleyAccum -= dt;
  if (cadence.foleyAccum <= 0 && moving > 2.5) {
    cadence.foleyAccum = clamp(1.6 - moving * 0.06, 0.28, 1.6) * footRng.range(0.7, 1.3);
    const airborne = frame.movement !== "grounded";
    playFoley("cloth", clamp01(moving / 18) * (airborne ? 0.7 : 0.5), true, p.x, p.y, p.z);
  }

  // Entering wingsuit or parachute snaps a lot of fabric at once.
  if (frame.movement !== cadence.lastMovement) {
    if (frame.movement === "parachute" || frame.movement === "wingsuit") {
      playFoley("harness", 1, true, p.x, p.y, p.z);
      playCanopy(frame.movement === "parachute");
    }
    cadence.lastMovement = frame.movement;
  }

  cadence.wasGrounded = grounded;
}

/**
 * Canopy deployment: a hard crack of fabric filling, then flutter. Graph-only
 * because it is rare and needs a longer, evolving envelope than a baked
 * one-shot would give.
 */
function playCanopy(parachute: boolean): void {
  const ctx = audioEngine.ctx;
  if (!ctx) return;
  const o = scratchOptions as VoiceOptions;
  o.x = 0;
  o.y = 0;
  o.z = 0;
  o.local = true;
  o.pan = 0;
  o.bus = "world";
  o.gain = 1;
  o.pitch = 1;
  o.priority = 0.8;
  o.noOcclusion = true;
  o.propagate = false;
  o.duration = 1.6;
  const v = voicePool.acquire(o);
  o.local = false;
  o.noOcclusion = false;
  o.duration = undefined;
  if (!v) return;

  const nb = noiseBuffer(ctx, 2, "white", 5);
  if (!nb) {
    voicePool.release(v);
    return;
  }
  const now = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = nb;
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(parachute ? 2400 : 3200, now);
  bp.frequency.exponentialRampToValueAtTime(parachute ? 480 : 900, now + 1.2);
  bp.Q.value = 0.7;
  const g = ctx.createGain();
  // Crack, then a decaying flutter that a tremolo LFO gives shape to.
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(parachute ? 0.85 : 0.5, now + 0.03);
  g.gain.exponentialRampToValueAtTime(0.08, now + 0.45);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 1.5);
  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = parachute ? 7 : 12;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.35;
  lfo.connect(lfoGain);
  lfoGain.connect(g.gain);
  src.connect(bp);
  bp.connect(g);
  g.connect(v.input);
  src.start(now);
  src.stop(now + 1.6);
  lfo.start(now);
  lfo.stop(now + 1.6);
  src.onended = () => {
    try {
      bp.disconnect();
      g.disconnect();
      lfoGain.disconnect();
    } catch {
      /* torn down */
    }
  };
  v.onSteal = () => {
    try {
      src.stop();
      lfo.stop();
    } catch {
      /* not started */
    }
  };
  v.endsAt = now + 1.6;
}

/** Pre-bake the surfaces the player is most likely to walk on. */
export async function primeFootstepBanks(): Promise<void> {
  if (!audioEngine.ctx) return;
  const common: AudioSurface[] = ["concrete", "asphalt", "grass", "metal", "wood", "water", "dirt"];
  for (const s of common) {
    for (let v = 0; v < FOOT_VARIANTS; v++) {
      footBuffer(s, false, v);
      footBuffer(s, true, v);
    }
    await Promise.resolve();
  }
  for (const s of ["concrete", "metal", "glass", "wood", "flesh", "water", "dirt"]) {
    for (let v = 0; v < 4; v++) impactBuffer(s, v);
    await Promise.resolve();
  }
  for (let v = 0; v < 3; v++) {
    ricochetBuffer(v);
    foleyBuffer("cloth", v);
    foleyBuffer("gear", v);
    foleyBuffer("harness", v);
    foleyBuffer("land", v);
  }
}
