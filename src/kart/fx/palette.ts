/**
 * Vibe Kart — the VFX colour script.
 *
 * Particles are the one part of a racer that is allowed to be brighter than
 * white, and that licence is exactly why they need a script rather than a
 * per-effect guess. Everything here is authored as an sRGB hex — the colour a
 * human picked — and converted once into the renderer's linear working space,
 * because a spark whose RGB was never decoded is a spark that tone-maps to mud.
 *
 * Two conventions the tables below follow:
 *
 * · **Additive colours carry their own exposure.** `intensity` above 1 is what
 *   pushes a spark core past the bloom threshold; the hue stays where it was
 *   picked and only the magnitude moves. Tinting toward white to "make it
 *   brighter" desaturates the whole effect and is the classic amateur tell.
 *
 * · **Every surface owns its dust.** Dirt is warm and heavy, grass is cool and
 *   flies, sand is pale and hangs, water is near-white and falls. A single grey
 *   puff reused for all of them is the single fastest way to make a track look
 *   like it has one material.
 */
import * as THREE from "three";
import type { MiniTurboTier, SurfaceKind } from "../types";
import { TILE } from "./atlas";

/** Author in sRGB, store in linear — the only conversion point in the module. */
function lin(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
}

// ---------------------------------------------------------------------------
// Drift charge
// ---------------------------------------------------------------------------

export interface DriftTierLook {
  /** Hot core, emitted white-adjacent and pushed hard for bloom. */
  core: THREE.Color;
  /** The tier's identity colour — this is the one the player reads. */
  hue: THREE.Color;
  /** The ember it decays to before it dies. */
  ember: THREE.Color;
  /** Sparks per second at full charge. */
  rate: number;
  /** Radiance multiplier. */
  intensity: number;
  size: number;
}

/**
 * Blue → orange → purple, the genre's own language for "keep holding it".
 * Tier 0 is the pre-charge phase: a thin scatter of white grit that tells you
 * the drift has *taken* without yet promising a boost.
 */
export const DRIFT_TIERS: Record<MiniTurboTier, DriftTierLook> = {
  0: {
    core: lin(0xffffff),
    hue: lin(0xcfe4ff),
    ember: lin(0x4c6a8c),
    rate: 55,
    intensity: 1.8,
    size: 0.13,
  },
  1: {
    core: lin(0xf2fbff),
    hue: lin(0x3fb8ff),
    ember: lin(0x0a3f78),
    rate: 200,
    intensity: 3.2,
    size: 0.2,
  },
  2: {
    core: lin(0xfff4d8),
    hue: lin(0xff9c1f),
    ember: lin(0x7a2a05),
    rate: 260,
    intensity: 3.9,
    size: 0.235,
  },
  3: {
    core: lin(0xfde8ff),
    hue: lin(0xc85cff),
    ember: lin(0x460a5e),
    rate: 330,
    intensity: 4.7,
    size: 0.27,
  },
};

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export interface SurfaceLook {
  /** Sprite for the flung material itself. */
  sprayTile: number;
  /** Sprite for the airborne haze it leaves behind. */
  smokeTile: number;
  /** Flung material, lit side and shadow side. */
  sprayA: THREE.Color;
  sprayB: THREE.Color;
  /** The haze — always duller and cooler than the spray it came from. */
  smoke: THREE.Color;
  /** Particles per second at full slip and top speed. */
  rate: number;
  /** Haze puffs per second under the same conditions. */
  smokeRate: number;
  /** Base sprite diameter, metres. */
  size: number;
  /** How hard the flung material is thrown. */
  speed: number;
  /** m/s² — negative falls back to the surface, positive rises. */
  gravity: number;
  drag: number;
  /** Velocity streaking. Grit streaks, dust does not. */
  stretch: number;
  /** Tumble for anything with a shape (blades, grains, chips). */
  spin: number;
  /** Leaves a rubber mark. Tarmac and kerbs do; grass does not. */
  marks: boolean;
  /** Additive rather than alpha — only the electrical surfaces. */
  additive: boolean;
  /** Draw a ripple ring on contact (water). */
  ripple: boolean;
}

const NO_SPRAY: SurfaceLook = {
  sprayTile: TILE.dust,
  smokeTile: TILE.smoke,
  sprayA: lin(0xffffff),
  sprayB: lin(0x8f97a3),
  smoke: lin(0xb8c0cc),
  rate: 0,
  smokeRate: 0,
  size: 0.3,
  speed: 2,
  gravity: -4,
  drag: 2.4,
  stretch: 0,
  spin: 0,
  marks: false,
  additive: false,
  ripple: false,
};

export const SURFACE_LOOKS: Record<SurfaceKind, SurfaceLook> = {
  // Tarmac throws nothing; all it does is burn rubber, and the smoke is the
  // pale blue-grey of hot polymer rather than the brown of soil.
  road: {
    ...NO_SPRAY,
    smokeTile: TILE.smoke,
    smoke: lin(0xdfe6ef),
    smokeRate: 34,
    size: 0.5,
    gravity: 0.55,
    drag: 1.4,
    marks: true,
  },
  rumble: {
    ...NO_SPRAY,
    sprayTile: TILE.grain,
    sprayA: lin(0xf3ede0),
    sprayB: lin(0xb0a89a),
    smoke: lin(0xd8d2c6),
    rate: 26,
    smokeRate: 20,
    size: 0.2,
    speed: 3.2,
    gravity: -12,
    drag: 3.2,
    spin: 7,
    marks: true,
  },
  // Boost plating: no debris, just ionised air coming off the strip.
  boost: {
    ...NO_SPRAY,
    sprayTile: TILE.hex,
    smokeTile: TILE.glow,
    sprayA: lin(0x9ff0ff),
    sprayB: lin(0x2c86ff),
    smoke: lin(0x6ad4ff),
    rate: 64,
    smokeRate: 18,
    size: 0.28,
    speed: 5,
    gravity: 3.5,
    drag: 2.6,
    spin: 3,
    additive: true,
    marks: true,
  },
  dirt: {
    ...NO_SPRAY,
    sprayTile: TILE.dust,
    smokeTile: TILE.dust,
    sprayA: lin(0xc79a67),
    sprayB: lin(0x6b4a2c),
    smoke: lin(0xa78a68),
    rate: 74,
    smokeRate: 40,
    size: 0.52,
    speed: 5.5,
    gravity: -9,
    drag: 2.1,
    stretch: 0.006,
    spin: 2.4,
  },
  grass: {
    ...NO_SPRAY,
    sprayTile: TILE.blade,
    smokeTile: TILE.dust,
    sprayA: lin(0x8ede5e),
    sprayB: lin(0x2f7a2b),
    smoke: lin(0x93a67e),
    rate: 88,
    smokeRate: 26,
    size: 0.26,
    speed: 7.5,
    gravity: -13,
    drag: 2.6,
    spin: 13,
  },
  sand: {
    ...NO_SPRAY,
    sprayTile: TILE.grain,
    smokeTile: TILE.dust,
    sprayA: lin(0xf3dfa8),
    sprayB: lin(0xb99a5c),
    smoke: lin(0xe0cb96),
    rate: 96,
    smokeRate: 54,
    size: 0.46,
    speed: 5,
    gravity: -8,
    // Sand hangs. Low drag on the grains, high on the haze, and the plume
    // stays in the air behind you for a second and a half.
    drag: 1.5,
    spin: 5,
  },
  water: {
    ...NO_SPRAY,
    sprayTile: TILE.drop,
    smokeTile: TILE.smoke,
    sprayA: lin(0xffffff),
    sprayB: lin(0x9fd6f5),
    smoke: lin(0xd6ecfa),
    rate: 130,
    smokeRate: 30,
    size: 0.2,
    speed: 8,
    gravity: -18,
    drag: 1.2,
    stretch: 0.012,
    spin: 2,
    ripple: true,
  },
  ice: {
    ...NO_SPRAY,
    sprayTile: TILE.grain,
    smokeTile: TILE.smoke,
    sprayA: lin(0xffffff),
    sprayB: lin(0xa8d8f0),
    smoke: lin(0xe6f3ff),
    rate: 44,
    smokeRate: 16,
    size: 0.16,
    speed: 4,
    gravity: -10,
    drag: 2.8,
    spin: 9,
    marks: true,
  },
  wood: {
    ...NO_SPRAY,
    sprayTile: TILE.grain,
    smokeTile: TILE.dust,
    sprayA: lin(0xd8ab72),
    sprayB: lin(0x7a5330),
    smoke: lin(0xbfa88a),
    rate: 34,
    smokeRate: 22,
    size: 0.22,
    speed: 4,
    gravity: -11,
    drag: 3,
    spin: 8,
    marks: true,
  },
  metal: {
    ...NO_SPRAY,
    sprayTile: TILE.spark,
    smokeTile: TILE.smoke,
    sprayA: lin(0xfff0c0),
    sprayB: lin(0xff6a12),
    smoke: lin(0xb9bec7),
    rate: 110,
    smokeRate: 10,
    size: 0.13,
    speed: 11,
    gravity: -16,
    drag: 1.1,
    stretch: 0.022,
    additive: true,
    marks: true,
  },
  antigrav: {
    ...NO_SPRAY,
    sprayTile: TILE.hex,
    smokeTile: TILE.glow,
    sprayA: lin(0xc9f6ff),
    sprayB: lin(0x2f7bff),
    smoke: lin(0x7fd8ff),
    rate: 70,
    smokeRate: 14,
    size: 0.26,
    speed: 4.5,
    gravity: 2.5,
    drag: 2.2,
    spin: 2,
    additive: true,
    marks: true,
  },
  void: NO_SPRAY,
};

/** Rubber colour and weight by surface — what a skid actually deposits. */
export const SKID_LOOKS: Partial<Record<SurfaceKind, { color: THREE.Color; opacity: number }>> = {
  road: { color: lin(0x14161c), opacity: 0.62 },
  rumble: { color: lin(0x2a2118), opacity: 0.42 },
  boost: { color: lin(0x101828), opacity: 0.3 },
  metal: { color: lin(0x1a1d24), opacity: 0.4 },
  wood: { color: lin(0x2e2013), opacity: 0.34 },
  ice: { color: lin(0xdff2ff), opacity: 0.3 },
  antigrav: { color: lin(0x0d1c33), opacity: 0.3 },
};

// ---------------------------------------------------------------------------
// One-shot palettes
// ---------------------------------------------------------------------------

export const FX_COLORS = {
  /** Exhaust flame: white core, orange mantle, sooty tail. */
  flameCore: lin(0xfff6e0),
  flameMid: lin(0xff9c2a),
  flameTail: lin(0x7a1e04),
  /** Boost-specific blue afterburner, used on a mini-turbo release. */
  turboCore: lin(0xf0fbff),
  turboMid: lin(0x39a8ff),
  turboTail: lin(0x0b2a63),
  /** Collision sparks — hot steel, not "yellow". */
  impactCore: lin(0xfff4cf),
  impactHue: lin(0xffa02c),
  impactEmber: lin(0x7d2a00),
  /** Explosion fireball, from flash to soot. */
  blastFlash: lin(0xfffdf2),
  blastCore: lin(0xffcc55),
  blastMid: lin(0xff5f18),
  blastSmokeA: lin(0x6a6259),
  blastSmokeB: lin(0x2a2724),
  blastDebris: lin(0x4a4640),
  /** Landing dust — neutral, it takes its tint from the surface. */
  landing: lin(0xd8cfc0),
  /** Coins and item boxes. */
  coin: lin(0xffd23f),
  coinCore: lin(0xfff6d0),
  boxA: lin(0x59e6ff),
  boxB: lin(0xffe14d),
  /** Star power. */
  starCore: lin(0xffffff),
  /** Wind streaks past the camera at speed. */
  wind: lin(0xdcecff),
  /** Confetti — the finish-line palette, deliberately not a random hue wheel. */
  confetti: [
    lin(0xff3b58),
    lin(0xffd23f),
    lin(0x3fd0ff),
    lin(0x5ce06a),
    lin(0xff7ac2),
    lin(0xffffff),
    lin(0x9b6bff),
  ] as THREE.Color[],
} as const;

/** Rainbow sample for the star trail — hue cycles, saturation does not. */
const rainbowScratch = new THREE.Color();
export function rainbowAt(phase: number): THREE.Color {
  rainbowScratch.setHSL(phase - Math.floor(phase), 0.85, 0.6);
  return rainbowScratch;
}
