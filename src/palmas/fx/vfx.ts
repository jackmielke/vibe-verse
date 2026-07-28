/**
 * San Palmas — visual effects.
 *
 * The spectacle layer. Publishes VfxService: explosions, impacts, tracers,
 * muzzle flashes and lingering smoke.
 *
 * ARCHITECTURE
 * ------------
 * Seven persistent draw calls, allocated once at boot and never grown:
 *
 *   billboardAdd   Points, additive      fire glow, flash, embers, heat haze
 *   billboardAlpha Points, alpha         fireball→smoke, dust, splinters, mist
 *   streaks        instanced quads       sparks, tracers, debris trails
 *   ringAdd        instanced flat quads  shockwave, metal ping, water ripple
 *   ringDust       instanced flat quads  ground dust ring
 *   decals         instanced quads       bullet holes, scorch, blood
 *   debris         InstancedMesh         physics chunks (the only CPU sim)
 *
 * Every one of those is a ring buffer of fixed capacity — a spawn writes a
 * handful of floats into a slot, marks a dirty span, and the GPU integrates
 * position, size, colour and fade from `spawnTime + velocity + acceleration`
 * for the rest of the particle's life. The CPU never touches a live particle
 * again. That is the whole reason a 6000-particle explosion costs ~0.1 ms of
 * main-thread time here.
 *
 * Colour over life comes from a 16-row LUT texture (`RAMPS`), so the signature
 * Just Cause fireball — white → yellow → orange → deep red → black smoke — is
 * a single texture fetch rather than per-frame colour maths.
 *
 * NO EXTERNAL ASSETS: every texture is synthesised at boot (tiling value-noise
 * fbm into DataTextures, Canvas2D for the decal atlas).
 *
 * EVENTS
 *   emits  "palmas:shake"   number 0..1 — trauma, for postfx/camera consumers
 *   emits  "palmas:distort" { point, radius, strength } — heat/shock distortion
 *   listens "palmas:shake"  any system can request camera trauma
 *   listens "palmas:depth"  a THREE.DepthTexture enables soft particles
 */
import * as THREE from "three";
import type {
  ImpactMaterial,
  QualityTier,
  System,
  SystemFactory,
  VfxService,
} from "../types";

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

interface VfxBudget {
  /** Capacity of each billboard layer (there are two). */
  billboards: number;
  streaks: number;
  rings: number;
  decals: number;
  debris: number;
  /** Pooled point lights, kept in the scene forever so shaders never relink. */
  lights: number;
  /** Decal atlas edge, px. */
  atlas: number;
  /** Multiplier applied to every burst count. */
  density: number;
}

const BUDGETS: Record<QualityTier, VfxBudget> = {
  low:    { billboards: 900,  streaks: 200,  rings: 32,  decals: 48,  debris: 16, lights: 2, atlas: 512,  density: 0.45 },
  medium: { billboards: 1800, streaks: 380,  rings: 56,  decals: 96,  debris: 32, lights: 3, atlas: 512,  density: 0.70 },
  high:   { billboards: 3600, streaks: 760,  rings: 96,  decals: 192, debris: 64, lights: 4, atlas: 1024, density: 1.00 },
  ultra:  { billboards: 6400, streaks: 1200, rings: 144, decals: 320, debris: 96, lights: 6, atlas: 1024, density: 1.35 },
};

// ---------------------------------------------------------------------------
// Colour-over-life ramps
//
// Row index doubles as a shader attribute. Rows 0-4 and 14-15 are authored for
// additive blending (they may never reach black or they vanish); rows 5-13 are
// authored for alpha blending (they may, and the fireball row deliberately
// does — that is how fire becomes smoke in one particle).
// ---------------------------------------------------------------------------

const RAMP = {
  fire: 0,
  ember: 1,
  flash: 2,
  spark: 3,
  haze: 4,
  fireSmoke: 5,
  smokeDark: 6,
  smokeLight: 7,
  dust: 8,
  concrete: 9,
  dirt: 10,
  wood: 11,
  blood: 12,
  water: 13,
  glass: 14,
  shock: 15,
} as const;

const RAMP_ROWS = 16;

/** [t, r, g, b, a] with rgb/a in 0..1. Interpolated linearly into the LUT. */
type RampStop = [number, number, number, number, number];

const RAMPS: RampStop[][] = [];
RAMPS[RAMP.fire] = [
  [0.00, 1.00, 1.00, 0.96, 1.00],
  [0.08, 1.00, 0.92, 0.58, 1.00],
  [0.26, 1.00, 0.58, 0.16, 0.92],
  [0.55, 0.86, 0.22, 0.04, 0.55],
  [1.00, 0.30, 0.05, 0.01, 0.00],
];
RAMPS[RAMP.ember] = [
  [0.00, 1.00, 0.94, 0.70, 1.00],
  [0.30, 1.00, 0.52, 0.12, 0.90],
  [0.70, 0.72, 0.14, 0.02, 0.55],
  [1.00, 0.20, 0.02, 0.00, 0.00],
];
RAMPS[RAMP.flash] = [
  [0.00, 1.00, 1.00, 1.00, 1.00],
  [0.18, 1.00, 0.97, 0.86, 0.95],
  [0.50, 1.00, 0.80, 0.45, 0.42],
  [1.00, 0.90, 0.45, 0.15, 0.00],
];
RAMPS[RAMP.spark] = [
  [0.00, 1.00, 1.00, 0.92, 1.00],
  [0.22, 1.00, 0.86, 0.36, 1.00],
  [0.60, 1.00, 0.42, 0.06, 0.80],
  [1.00, 0.55, 0.08, 0.01, 0.00],
];
RAMPS[RAMP.haze] = [
  [0.00, 0.55, 0.34, 0.18, 0.00],
  [0.20, 0.50, 0.30, 0.16, 0.16],
  [0.60, 0.40, 0.26, 0.16, 0.10],
  [1.00, 0.30, 0.22, 0.16, 0.00],
];
// The signature fireball: incandescent white through to cold black smoke.
RAMPS[RAMP.fireSmoke] = [
  [0.00, 1.00, 0.99, 0.93, 0.92],
  [0.05, 1.00, 0.86, 0.42, 1.00],
  [0.13, 1.00, 0.52, 0.10, 1.00],
  [0.24, 0.78, 0.20, 0.03, 1.00],
  [0.38, 0.34, 0.10, 0.05, 0.98],
  [0.55, 0.15, 0.13, 0.13, 0.92],
  [0.78, 0.11, 0.105, 0.10, 0.62],
  [1.00, 0.10, 0.10, 0.10, 0.00],
];
RAMPS[RAMP.smokeDark] = [
  [0.00, 0.26, 0.25, 0.24, 0.00],
  [0.07, 0.23, 0.22, 0.21, 0.82],
  [0.45, 0.19, 0.185, 0.18, 0.66],
  [1.00, 0.16, 0.16, 0.155, 0.00],
];
RAMPS[RAMP.smokeLight] = [
  [0.00, 0.86, 0.86, 0.87, 0.00],
  [0.10, 0.80, 0.80, 0.81, 0.50],
  [0.50, 0.66, 0.66, 0.68, 0.34],
  [1.00, 0.56, 0.57, 0.60, 0.00],
];
RAMPS[RAMP.dust] = [
  [0.00, 0.82, 0.74, 0.60, 0.00],
  [0.08, 0.78, 0.70, 0.56, 0.78],
  [0.45, 0.66, 0.59, 0.47, 0.48],
  [1.00, 0.55, 0.50, 0.41, 0.00],
];
RAMPS[RAMP.concrete] = [
  [0.00, 0.86, 0.86, 0.84, 0.00],
  [0.06, 0.78, 0.78, 0.76, 0.85],
  [0.40, 0.66, 0.66, 0.65, 0.52],
  [1.00, 0.58, 0.58, 0.57, 0.00],
];
RAMPS[RAMP.dirt] = [
  [0.00, 0.46, 0.35, 0.24, 0.00],
  [0.06, 0.40, 0.30, 0.20, 0.92],
  [0.45, 0.33, 0.25, 0.17, 0.62],
  [1.00, 0.28, 0.21, 0.14, 0.00],
];
RAMPS[RAMP.wood] = [
  [0.00, 0.72, 0.55, 0.33, 0.00],
  [0.06, 0.64, 0.47, 0.27, 0.95],
  [0.45, 0.50, 0.36, 0.21, 0.65],
  [1.00, 0.40, 0.29, 0.17, 0.00],
];
RAMPS[RAMP.blood] = [
  [0.00, 0.72, 0.06, 0.05, 0.00],
  [0.05, 0.58, 0.03, 0.03, 0.95],
  [0.45, 0.36, 0.02, 0.02, 0.70],
  [1.00, 0.20, 0.01, 0.01, 0.00],
];
RAMPS[RAMP.water] = [
  [0.00, 0.96, 0.99, 1.00, 0.00],
  [0.06, 0.90, 0.96, 0.98, 0.85],
  [0.45, 0.74, 0.88, 0.92, 0.50],
  [1.00, 0.66, 0.82, 0.88, 0.00],
];
RAMPS[RAMP.glass] = [
  [0.00, 1.00, 1.00, 1.00, 1.00],
  [0.25, 0.82, 0.95, 1.00, 0.85],
  [1.00, 0.55, 0.80, 0.95, 0.00],
];
RAMPS[RAMP.shock] = [
  [0.00, 1.00, 0.96, 0.88, 0.00],
  [0.08, 1.00, 0.92, 0.76, 0.95],
  [0.35, 1.00, 0.70, 0.35, 0.45],
  [1.00, 0.80, 0.40, 0.15, 0.00],
];

// ---------------------------------------------------------------------------
// Decal atlas cells (4×4)
// ---------------------------------------------------------------------------

const ATLAS_DIV = 4;
const DECAL = {
  holeConcrete: 0,
  holeConcrete2: 1,
  scuff: 2,
  holeMetal: 3,
  holeMetal2: 4,
  holeWood: 5,
  holeDirt: 6,
  glassWeb: 7,
  blood: 8,
  blood2: 9,
  scorch: 10,
  scorch2: 11,
  scorchSmall: 12,
  soot: 13,
  crackWeb: 14,
  wetSplat: 15,
} as const;

// ---------------------------------------------------------------------------
// Per-material impact recipes
// ---------------------------------------------------------------------------

interface ImpactProfile {
  puffRamp: number;
  puffCount: number;
  puffSize: number;
  puffSpeed: number;
  puffLife: number;
  puffDrag: number;
  /** Fine chips/splinters thrown as small alpha billboards. */
  chipCount: number;
  chipRamp: number;
  sparkCount: number;
  sparkRamp: number;
  sparkSpeed: number;
  sparkLife: number;
  sparkWidth: number;
  /** Additive flare brightness at the hit point; 0 = none. */
  flash: number;
  flashRamp: number;
  /** Expanding ring radius, 0 = none. */
  ring: number;
  ringRamp: number;
  ringAdditive: boolean;
  decals: number[];
  decalSize: number;
  decalTint: number;
  decalLife: number;
  sound: string;
}

const IMPACTS: Record<ImpactMaterial, ImpactProfile> = {
  concrete: {
    puffRamp: RAMP.concrete, puffCount: 7, puffSize: 0.42, puffSpeed: 2.4, puffLife: 0.85, puffDrag: 3.2,
    chipCount: 5, chipRamp: RAMP.concrete,
    sparkCount: 2, sparkRamp: RAMP.spark, sparkSpeed: 7, sparkLife: 0.22, sparkWidth: 0.03,
    flash: 0.5, flashRamp: RAMP.flash,
    ring: 0, ringRamp: RAMP.dust, ringAdditive: false,
    decals: [DECAL.holeConcrete, DECAL.holeConcrete2, DECAL.scuff], decalSize: 0.34,
    decalTint: 0xffffff, decalLife: 26, sound: "impact_concrete",
  },
  metal: {
    puffRamp: RAMP.smokeLight, puffCount: 2, puffSize: 0.24, puffSpeed: 1.6, puffLife: 0.5, puffDrag: 4,
    chipCount: 0, chipRamp: RAMP.concrete,
    sparkCount: 14, sparkRamp: RAMP.spark, sparkSpeed: 13, sparkLife: 0.5, sparkWidth: 0.028,
    flash: 1.9, flashRamp: RAMP.flash,
    ring: 0.85, ringRamp: RAMP.shock, ringAdditive: true,
    decals: [DECAL.holeMetal, DECAL.holeMetal2], decalSize: 0.3,
    decalTint: 0xffffff, decalLife: 26, sound: "impact_metal",
  },
  wood: {
    puffRamp: RAMP.wood, puffCount: 5, puffSize: 0.34, puffSpeed: 2.0, puffLife: 0.7, puffDrag: 3.4,
    chipCount: 9, chipRamp: RAMP.wood,
    sparkCount: 0, sparkRamp: RAMP.spark, sparkSpeed: 6, sparkLife: 0.2, sparkWidth: 0.03,
    flash: 0.25, flashRamp: RAMP.flash,
    ring: 0, ringRamp: RAMP.dust, ringAdditive: false,
    decals: [DECAL.holeWood, DECAL.holeWood, DECAL.scuff], decalSize: 0.32,
    decalTint: 0xd9c2a0, decalLife: 26, sound: "impact_wood",
  },
  dirt: {
    puffRamp: RAMP.dirt, puffCount: 8, puffSize: 0.55, puffSpeed: 2.6, puffLife: 1.0, puffDrag: 2.6,
    chipCount: 8, chipRamp: RAMP.dirt,
    sparkCount: 0, sparkRamp: RAMP.spark, sparkSpeed: 6, sparkLife: 0.2, sparkWidth: 0.03,
    flash: 0.15, flashRamp: RAMP.flash,
    ring: 0, ringRamp: RAMP.dust, ringAdditive: false,
    decals: [DECAL.holeDirt, DECAL.holeDirt, DECAL.soot], decalSize: 0.5,
    decalTint: 0xffffff, decalLife: 22, sound: "impact_dirt",
  },
  water: {
    puffRamp: RAMP.water, puffCount: 10, puffSize: 0.5, puffSpeed: 3.4, puffLife: 0.8, puffDrag: 2.2,
    chipCount: 0, chipRamp: RAMP.water,
    sparkCount: 12, sparkRamp: RAMP.water, sparkSpeed: 6.5, sparkLife: 0.75, sparkWidth: 0.045,
    flash: 0, flashRamp: RAMP.flash,
    ring: 1.7, ringRamp: RAMP.water, ringAdditive: false,
    decals: [], decalSize: 0, decalTint: 0xffffff, decalLife: 0, sound: "impact_water",
  },
  glass: {
    puffRamp: RAMP.smokeLight, puffCount: 3, puffSize: 0.3, puffSpeed: 2.2, puffLife: 0.5, puffDrag: 3.5,
    chipCount: 6, chipRamp: RAMP.smokeLight,
    sparkCount: 14, sparkRamp: RAMP.glass, sparkSpeed: 8.5, sparkLife: 0.9, sparkWidth: 0.035,
    flash: 1.1, flashRamp: RAMP.glass,
    ring: 0.5, ringRamp: RAMP.glass, ringAdditive: true,
    decals: [DECAL.glassWeb, DECAL.crackWeb], decalSize: 0.75,
    decalTint: 0xffffff, decalLife: 30, sound: "impact_glass",
  },
  flesh: {
    puffRamp: RAMP.blood, puffCount: 9, puffSize: 0.3, puffSpeed: 3.0, puffLife: 0.55, puffDrag: 4.5,
    chipCount: 0, chipRamp: RAMP.blood,
    sparkCount: 7, sparkRamp: RAMP.blood, sparkSpeed: 5.5, sparkLife: 0.6, sparkWidth: 0.035,
    flash: 0, flashRamp: RAMP.flash,
    ring: 0, ringRamp: RAMP.blood, ringAdditive: false,
    decals: [DECAL.blood, DECAL.blood2], decalSize: 0.85,
    decalTint: 0xffffff, decalLife: 20, sound: "impact_flesh",
  },
};

/**
 * Sprite shape used for each material's surface puff. Gritty surfaces get the
 * wispy dust sprite; liquids get round droplets; metal and glass only wisp.
 * Values index SPRITE, declared with the texture synthesis below.
 */
const IMPACT_PUFF_SPRITE: Record<ImpactMaterial, number> = {
  concrete: 3,
  metal: 2,
  wood: 3,
  dirt: 3,
  water: 0,
  glass: 2,
  flesh: 0,
};

// ---------------------------------------------------------------------------
// Procedural texture synthesis
// ---------------------------------------------------------------------------

/** Integer hash → 0..1. Deterministic, no Math.random anywhere. */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);

/** Tiling value noise on a `period`-cell lattice. */
function valueNoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const w = (a: number) => ((a % period) + period) % period;
  const x0 = w(ix);
  const x1 = w(ix + 1);
  const y0 = w(iy);
  const y1 = w(iy + 1);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  const u = fade(fx);
  const v = fade(fy);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Tiling fbm, `oct` octaves, unit domain 0..1. */
function fbm(x: number, y: number, oct: number, base: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let per = base;
  for (let i = 0; i < oct; i++) {
    sum += valueNoise(x * per, y * per, per, seed + i * 131) * amp;
    norm += amp;
    amp *= 0.5;
    per *= 2;
  }
  return sum / norm;
}

/** RGBA DataTexture from a per-pixel callback. `out` is [r,g,b,a] in 0..1. */
function dataTexture(
  size: number,
  fn: (u: number, v: number, out: Float32Array) => void,
  opts: { mips?: boolean; srgb?: boolean; wrap?: THREE.Wrapping; height?: number } = {},
): THREE.DataTexture {
  const h = opts.height ?? size;
  const data = new Uint8Array(size * h * 4);
  const out = new Float32Array(4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < size; x++) {
      out[0] = out[1] = out[2] = out[3] = 0;
      fn((x + 0.5) / size, (y + 0.5) / h, out);
      const i = (y * size + x) * 4;
      data[i] = Math.max(0, Math.min(255, out[0] * 255)) | 0;
      data[i + 1] = Math.max(0, Math.min(255, out[1] * 255)) | 0;
      data[i + 2] = Math.max(0, Math.min(255, out[2] * 255)) | 0;
      data[i + 3] = Math.max(0, Math.min(255, out[3] * 255)) | 0;
    }
  }
  const tex = new THREE.DataTexture(data, size, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = opts.wrap ?? THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = opts.mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.generateMipmaps = !!opts.mips;
  if (opts.srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Sprite cells inside the particle atlas. */
const SPRITE = {
  /** Round soft core — fire glow, embers, droplets, chips. */
  glow: 0,
  /** Hot core with anisotropic spikes — muzzle and detonation flash. */
  flare: 1,
  /** Turbulent lumpy puff — smoke and the fireball body. */
  smoke: 2,
  /** Wispy low-contrast puff — dust and grit. */
  dust: 3,
} as const;

/** UV origin of a sprite cell in the 2×2 atlas. */
const SPRITE_U = [0, 0.5, 0, 0.5];
const SPRITE_V = [0, 0, 0.5, 0.5];

/**
 * All four particle sprites in one 2×2 atlas, so the additive and alpha
 * billboard layers can each pick a shape per particle without paying for a
 * second draw call or a second texture bind.
 *
 * DataTexture is flipY:false, so data row 0 sits at v=0 and the cell layout
 * below matches SPRITE_U / SPRITE_V directly.
 */
function makeSpriteAtlas(seed: number): THREE.DataTexture {
  return dataTexture(256, (u, v, out) => {
    const cx = u < 0.5 ? 0 : 1;
    const cy = v < 0.5 ? 0 : 1;
    const cell = cy * 2 + cx;
    const lu = (u - cx * 0.5) * 2;
    const lv = (v - cy * 0.5) * 2;
    const dx = lu - 0.5;
    const dy = lv - 0.5;
    const r = Math.hypot(dx, dy) * 2;

    let a = 0;
    if (cell === SPRITE.glow) {
      a = Math.pow(Math.max(0, 1 - r), 2.4) * 0.85 + Math.exp(-r * r * 11) * 0.75;
    } else if (cell === SPRITE.flare) {
      const ang = Math.atan2(dy, dx);
      a = Math.exp(-r * r * 30) + Math.exp(-r * r * 4.2) * 0.5;
      for (let k = 0; k < 3; k++) {
        const s = Math.abs(Math.cos(ang - (k * Math.PI) / 3));
        a += Math.pow(s, 90) * Math.exp(-r * 3.2) * 0.75;
      }
    } else if (cell === SPRITE.smoke) {
      const n = fbm(lu, lv, 4, 4, seed);
      // Warp the falloff with noise so the silhouette is lumpy, not a disc.
      const edge = 1 - Math.min(1, r / (0.62 + n * 0.5));
      a = Math.pow(Math.max(0, edge), 1.5) * (0.42 + n * 0.9);
    } else {
      const n = fbm(lu, lv, 3, 3, seed + 613) * 0.75 + fbm(lu * 1.9, lv * 1.9, 2, 6, seed + 7) * 0.35;
      const edge = 1 - Math.min(1, r / (0.78 + n * 0.28));
      a = Math.pow(Math.max(0, edge), 2.1) * (0.35 + n * 0.8);
    }

    // Hard transparent gutter past the inscribed circle: without it a mip
    // level would smear one sprite into the cell next door.
    a *= Math.max(0, Math.min(1, (1.04 - r) * 9));
    out[0] = out[1] = out[2] = 1;
    out[3] = Math.min(1, a);
  }, { mips: true });
}

/** Streak sprite: bright head, soft tail, rounded caps. */
function makeStreakTexture(): THREE.DataTexture {
  return dataTexture(64, (u, v, out) => {
    // v is across the ribbon, u runs tail(0) → head(1).
    const across = 1 - Math.abs(v - 0.5) * 2;
    const cap = Math.min(1, Math.min(u, 1 - u) * 14 + 0.15);
    const head = Math.pow(u, 2.2) * 0.9 + 0.1;
    out[0] = out[1] = out[2] = 1;
    out[3] = Math.min(1, Math.pow(Math.max(0, across), 1.6) * head * cap);
  }, { height: 16 });
}

/** Tiling fbm used to break up shockwave rings. */
function makeRingNoiseTexture(seed: number): THREE.DataTexture {
  return dataTexture(64, (u, v, out) => {
    const n = fbm(u, v, 4, 4, seed);
    out[0] = out[1] = out[2] = n;
    out[3] = 1;
  }, { wrap: THREE.RepeatWrapping, mips: true });
}

/** 16-row colour-over-life LUT baked from RAMPS. */
function makeRampTexture(): THREE.DataTexture {
  const w = 128;
  return dataTexture(w, (u, v, out) => {
    const row = Math.min(RAMP_ROWS - 1, Math.floor(v * RAMP_ROWS));
    const stops = RAMPS[row] ?? RAMPS[RAMP.smokeDark];
    let i = 0;
    while (i < stops.length - 2 && stops[i + 1][0] < u) i++;
    const a = stops[i];
    const b = stops[Math.min(i + 1, stops.length - 1)];
    const span = Math.max(1e-4, b[0] - a[0]);
    const t = Math.max(0, Math.min(1, (u - a[0]) / span));
    out[0] = a[1] + (b[1] - a[1]) * t;
    out[1] = a[2] + (b[2] - a[2]) * t;
    out[2] = a[3] + (b[3] - a[3]) * t;
    out[3] = a[4] + (b[4] - a[4]) * t;
  }, { height: RAMP_ROWS, srgb: true });
}

/**
 * Decal atlas — the only Canvas2D texture in the module. Cracks, splinters and
 * blood spatter are far cheaper to draw with a path API than to evaluate
 * per-pixel. Falls back to a blank texture if 2D canvas is unavailable
 * (headless test runs), so boot never throws.
 */
function makeDecalAtlas(edge: number, rng: () => number): THREE.Texture {
  const cell = edge / ATLAS_DIV;
  let g: CanvasRenderingContext2D | null = null;
  let canvas: HTMLCanvasElement | null = null;
  if (typeof document !== "undefined") {
    canvas = document.createElement("canvas");
    canvas.width = edge;
    canvas.height = edge;
    g = canvas.getContext("2d");
  }
  if (!g || !canvas) {
    return dataTexture(4, (_u, _v, out) => { out[0] = out[1] = out[2] = 1; out[3] = 0; });
  }

  g.clearRect(0, 0, edge, edge);
  const rr = (a: number, b: number) => a + (b - a) * rng();

  /** Run `draw` with the origin at the centre of cell `i`, unit radius = 1. */
  const inCell = (i: number, draw: (c: CanvasRenderingContext2D, r: number) => void) => {
    const cx = (i % ATLAS_DIV) * cell;
    const cy = Math.floor(i / ATLAS_DIV) * cell;
    g!.save();
    g!.beginPath();
    g!.rect(cx + 1, cy + 1, cell - 2, cell - 2);
    g!.clip();
    g!.translate(cx + cell / 2, cy + cell / 2);
    draw(g!, cell * 0.5);
    g!.restore();
  };

  const softDisc = (c: CanvasRenderingContext2D, r: number, inner: string, outer: string, p = 0.35) => {
    const grad = c.createRadialGradient(0, 0, r * p * 0.1, 0, 0, r);
    grad.addColorStop(0, inner);
    grad.addColorStop(p, inner);
    grad.addColorStop(1, outer);
    c.fillStyle = grad;
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.fill();
  };

  /** Lumpy blob built from overlapping discs — reads as an organic edge. */
  const blob = (c: CanvasRenderingContext2D, r: number, n: number, spread: number, fill: string) => {
    c.fillStyle = fill;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const d = Math.pow(rng(), 0.6) * r * spread;
      c.beginPath();
      c.arc(Math.cos(a) * d, Math.sin(a) * d, r * rr(0.1, 0.34), 0, Math.PI * 2);
      c.fill();
    }
  };

  const cracks = (c: CanvasRenderingContext2D, r: number, n: number, len: number, style: string, width: number) => {
    c.strokeStyle = style;
    c.lineCap = "round";
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rr(-0.35, 0.35);
      let x = Math.cos(a) * r * 0.1;
      let y = Math.sin(a) * r * 0.1;
      let ang = a;
      c.lineWidth = width * rr(0.6, 1.4);
      c.beginPath();
      c.moveTo(x, y);
      const segs = 3 + ((rng() * 3) | 0);
      for (let s = 0; s < segs; s++) {
        ang += rr(-0.4, 0.4);
        const step = (r * len) / segs;
        x += Math.cos(ang) * step;
        y += Math.sin(ang) * step;
        c.lineTo(x, y);
      }
      c.stroke();
    }
  };

  // --- Concrete bullet holes ------------------------------------------------
  for (const id of [DECAL.holeConcrete, DECAL.holeConcrete2]) {
    inCell(id, (c, r) => {
      softDisc(c, r * 0.95, "rgba(196,192,184,0.00)", "rgba(196,192,184,0.00)");
      // Dust bloom around the crater.
      softDisc(c, r * 0.9, "rgba(214,210,200,0.42)", "rgba(214,210,200,0)", 0.15);
      cracks(c, r, 7, 0.72, "rgba(46,44,42,0.5)", r * 0.035);
      softDisc(c, r * 0.3, "rgba(18,16,15,0.95)", "rgba(30,28,26,0)", 0.45);
      c.fillStyle = "rgba(236,233,226,0.5)";
      for (let i = 0; i < 14; i++) {
        const a = rng() * Math.PI * 2;
        const d = rr(0.3, 0.9) * r;
        c.fillRect(Math.cos(a) * d, Math.sin(a) * d, r * 0.05, r * 0.05);
      }
    });
  }

  inCell(DECAL.scuff, (c, r) => {
    softDisc(c, r * 0.9, "rgba(120,118,112,0.35)", "rgba(120,118,112,0)", 0.1);
    cracks(c, r, 5, 0.6, "rgba(70,68,64,0.28)", r * 0.03);
  });

  // --- Metal dings ----------------------------------------------------------
  for (const id of [DECAL.holeMetal, DECAL.holeMetal2]) {
    inCell(id, (c, r) => {
      softDisc(c, r * 0.85, "rgba(30,28,26,0.62)", "rgba(30,28,26,0)", 0.2);
      c.strokeStyle = "rgba(255,246,226,0.75)";
      c.lineWidth = r * 0.045;
      c.lineCap = "round";
      for (let i = 0; i < 9; i++) {
        const a = rng() * Math.PI * 2;
        const d0 = rr(0.12, 0.3) * r;
        const d1 = rr(0.45, 0.92) * r;
        c.beginPath();
        c.moveTo(Math.cos(a) * d0, Math.sin(a) * d0);
        c.lineTo(Math.cos(a) * d1, Math.sin(a) * d1);
        c.stroke();
      }
      softDisc(c, r * 0.22, "rgba(12,11,10,0.96)", "rgba(12,11,10,0)", 0.55);
    });
  }

  // --- Wood ----------------------------------------------------------------
  inCell(DECAL.holeWood, (c, r) => {
    softDisc(c, r * 0.8, "rgba(46,30,16,0.55)", "rgba(46,30,16,0)", 0.22);
    c.fillStyle = "rgba(214,182,132,0.72)";
    for (let i = 0; i < 12; i++) {
      const a = rng() * Math.PI * 2;
      const len = rr(0.35, 0.95) * r;
      const w = r * rr(0.03, 0.08);
      c.save();
      c.rotate(a);
      c.beginPath();
      c.moveTo(r * 0.12, -w);
      c.lineTo(len, 0);
      c.lineTo(r * 0.12, w);
      c.closePath();
      c.fill();
      c.restore();
    }
    softDisc(c, r * 0.24, "rgba(16,10,5,0.95)", "rgba(16,10,5,0)", 0.5);
  });

  // --- Dirt ----------------------------------------------------------------
  inCell(DECAL.holeDirt, (c, r) => {
    softDisc(c, r * 0.95, "rgba(52,38,24,0.66)", "rgba(52,38,24,0)", 0.28);
    blob(c, r, 16, 0.7, "rgba(38,27,16,0.5)");
    softDisc(c, r * 0.34, "rgba(24,17,10,0.85)", "rgba(24,17,10,0)", 0.4);
  });

  // --- Glass ---------------------------------------------------------------
  for (const id of [DECAL.glassWeb, DECAL.crackWeb]) {
    inCell(id, (c, r) => {
      cracks(c, r, 11, 0.92, "rgba(255,255,255,0.72)", r * 0.02);
      // Concentric fracture arcs.
      c.strokeStyle = "rgba(230,244,255,0.35)";
      for (let k = 1; k <= 3; k++) {
        c.lineWidth = r * 0.014;
        c.beginPath();
        c.arc(0, 0, r * (0.2 + k * 0.22), rr(0, 1), rr(3.4, 6.0));
        c.stroke();
      }
      softDisc(c, r * 0.18, "rgba(255,255,255,0.8)", "rgba(255,255,255,0)", 0.3);
    });
  }

  // --- Blood ---------------------------------------------------------------
  for (const id of [DECAL.blood, DECAL.blood2]) {
    inCell(id, (c, r) => {
      blob(c, r * 0.8, 14, 0.55, "rgba(96,6,6,0.82)");
      blob(c, r * 0.55, 10, 0.5, "rgba(140,10,8,0.6)");
      c.fillStyle = "rgba(110,7,6,0.7)";
      for (let i = 0; i < 22; i++) {
        const a = rng() * Math.PI * 2;
        const d = rr(0.45, 1.0) * r;
        c.beginPath();
        c.arc(Math.cos(a) * d, Math.sin(a) * d, r * rr(0.015, 0.06), 0, Math.PI * 2);
        c.fill();
      }
    });
  }

  // --- Scorch --------------------------------------------------------------
  for (const id of [DECAL.scorch, DECAL.scorch2, DECAL.scorchSmall, DECAL.soot]) {
    const small = id === DECAL.scorchSmall || id === DECAL.soot;
    inCell(id, (c, r) => {
      softDisc(c, r * (small ? 0.72 : 0.96), "rgba(10,9,8,0.9)", "rgba(14,12,10,0)", small ? 0.2 : 0.34);
      blob(c, r * (small ? 0.7 : 0.95), 20, 0.72, "rgba(9,8,7,0.32)");
      // Warm inner rim — soot is never neutral black up close.
      c.strokeStyle = "rgba(70,40,20,0.28)";
      c.lineWidth = r * 0.09;
      c.beginPath();
      c.arc(0, 0, r * (small ? 0.42 : 0.58), 0, Math.PI * 2);
      c.stroke();
      // Radial streaks of ejecta.
      cracks(c, r, 10, 0.95, "rgba(10,9,8,0.35)", r * 0.05);
    });
  }

  inCell(DECAL.wetSplat, (c, r) => {
    softDisc(c, r * 0.9, "rgba(20,26,30,0.4)", "rgba(20,26,30,0)", 0.3);
    blob(c, r * 0.85, 12, 0.6, "rgba(24,32,38,0.22)");
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Shared shader fragments
// ---------------------------------------------------------------------------

/** Fog + tonemap + output-colourspace tail, so VFX grade like every material. */
const FOG_PARS = /* glsl */ `
uniform vec3  uFogColor;
uniform vec3  uFogParams;  // near, far, density
uniform float uFogKind;    // 0 none, 1 linear, 2 exp2
float fogFactor(float viewZ) {
  if (uFogKind > 1.5) return 1.0 - exp(-uFogParams.z * uFogParams.z * viewZ * viewZ);
  if (uFogKind > 0.5) return smoothstep(uFogParams.x, uFogParams.y, viewZ);
  return 0.0;
}
`;

/** Rotates a quaternion onto a vector — used by every oriented-quad layer. */
const QUAT_ROTATE = /* glsl */ `
vec3 qrot(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}
`;

const SOFT_PARS = /* glsl */ `
#ifdef SOFT
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform vec2 uCamRange;
uniform float uSoftness;
#endif
`;

/** Applies the depth-buffer fade when the soft-particle path is compiled in. */
const SOFT_APPLY = /* glsl */ `
#ifdef SOFT
{
  vec2 suv = gl_FragCoord.xy / uResolution;
  float rawDepth = texture2D(uDepth, suv).x;
  float sceneDist = -perspectiveDepthToViewZ(rawDepth, uCamRange.x, uCamRange.y);
  a *= clamp((sceneDist - vViewZ) / uSoftness, 0.0, 1.0);
}
#endif
`;

// ---------------------------------------------------------------------------
// Billboard particle layer (GPU-integrated THREE.Points)
// ---------------------------------------------------------------------------

const BILLBOARD_VERT = /* glsl */ `
uniform float uTime;
uniform float uPixelScale;
uniform vec3  uWind;

attribute vec3 aVel;
attribute vec4 aLife;    // spawn, lifetime, seed, drag
attribute vec4 aStyle;   // size0, size1, rampRow, brightness
attribute vec4 aMotion;  // buoyancy (m/s^2), spin (rad/s), atlas cell u, v

varying float vT;
varying float vRow;
varying float vBright;
varying float vRot;
varying float vViewZ;
varying vec2 vCell;

void main() {
  float age = uTime - aLife.x;
  float t = age / max(aLife.y, 0.0001);
  float dead = step(1.0, t) + step(age, -0.00001);

  // Exponential drag has a closed form, so the whole trajectory is a function
  // of age — no per-frame CPU integration anywhere.
  float k = aLife.w;
  float damp = k > 0.001 ? (1.0 - exp(-k * age)) / k : age;
  vec3 p = position + aVel * damp;
  p.y += 0.5 * aMotion.x * age * age;
  p += uWind * (0.5 * age * age) * clamp(k * 0.5, 0.0, 1.2);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;

  float size = mix(aStyle.x, aStyle.y, clamp(t, 0.0, 1.0));
  gl_PointSize = min(size * uPixelScale / max(vViewZ, 0.05), 1400.0);

  if (dead > 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
  }

  vT = clamp(t, 0.0, 1.0);
  vRow = aStyle.z;
  vBright = aStyle.w;
  vRot = aLife.z * 6.28318 + aMotion.y * age;
  vCell = aMotion.zw;
}
`;

const BILLBOARD_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uRamp;
uniform vec3 uTint;

varying float vT;
varying float vRow;
varying float vBright;
varying float vRot;
varying float vViewZ;
varying vec2 vCell;

#include <packing>
${FOG_PARS}
${SOFT_PARS}

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float c = cos(vRot);
  float s = sin(vRot);
  uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c) + 0.5;
  // Clamp before folding into the atlas cell: a rotated corner must sample the
  // cell's own transparent gutter, never the sprite next door.
  uv = clamp(uv, 0.0, 1.0) * 0.5 + vCell;

  vec4 tex = texture2D(uMap, uv);
  vec4 ramp = texture2D(uRamp, vec2(vT, vRow));
  float a = tex.a * ramp.a;
  if (a < 0.004) discard;

  vec3 col = ramp.rgb * uTint * vBright;
  ${SOFT_APPLY}

  float f = fogFactor(vViewZ);
  #ifdef ADDITIVE
    col *= (1.0 - f);
  #else
    col = mix(col, uFogColor, f);
  #endif

  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Velocity-aligned streaks (sparks, tracers)
// ---------------------------------------------------------------------------

const STREAK_VERT = /* glsl */ `
uniform float uTime;

attribute vec3 iPos;
attribute vec3 iVel;
attribute vec3 iAcc;
attribute vec4 iLife;   // spawn, lifetime, width, length
attribute vec2 iStyle;  // rampRow, brightness

varying vec2 vUv;
varying float vT;
varying float vRow;
varying float vBright;
varying float vViewZ;

void main() {
  float age = uTime - iLife.x;
  float t = age / max(iLife.y, 0.0001);
  float dead = step(1.0, t) + step(age, -0.00001);

  vec3 head = iPos + iVel * age + 0.5 * iAcc * age * age;
  vec3 vel = iVel + iAcc * age;
  float sp = length(vel);
  vec3 dir = sp > 0.0001 ? vel / sp : vec3(0.0, 1.0, 0.0);
  // Faster sparks stretch longer — the classic trail-length cue.
  float len = iLife.w * clamp(sp / 26.0, 0.22, 1.0);
  vec3 tail = head - dir * len;

  vec4 hv = viewMatrix * vec4(head, 1.0);
  vec4 tv = viewMatrix * vec4(tail, 1.0);
  vec3 c = mix(tv.xyz, hv.xyz, position.x);

  vec2 d = hv.xy - tv.xy;
  vec2 ax = length(d) > 0.00001 ? normalize(d) : vec2(1.0, 0.0);
  c.xy += vec2(-ax.y, ax.x) * position.y * iLife.z;

  vViewZ = -c.z;
  gl_Position = projectionMatrix * vec4(c, 1.0);
  if (dead > 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

  vUv = vec2(position.x, position.y + 0.5);
  vT = clamp(t, 0.0, 1.0);
  vRow = iStyle.x;
  vBright = iStyle.y;
}
`;

const STREAK_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uRamp;

varying vec2 vUv;
varying float vT;
varying float vRow;
varying float vBright;
varying float vViewZ;

${FOG_PARS}

void main() {
  vec4 tex = texture2D(uMap, vUv);
  vec4 ramp = texture2D(uRamp, vec2(vT, vRow));
  float a = tex.a * ramp.a;
  if (a < 0.004) discard;
  vec3 col = ramp.rgb * vBright * (1.0 - fogFactor(vViewZ));
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Surface-hugging expanding rings (shockwave, dust, ripple, metal ping)
// ---------------------------------------------------------------------------

const RING_VERT = /* glsl */ `
uniform float uTime;

attribute vec3 iPos;
attribute vec4 iQuat;
attribute vec4 iLife;   // spawn, lifetime, r0, r1
attribute vec3 iStyle;  // rampRow, brightness, innerRadius

varying vec2 vUv;
varying float vT;
varying float vRow;
varying float vBright;
varying float vInner;
varying float vViewZ;
varying vec2 vNoiseUv;

${QUAT_ROTATE}

void main() {
  float age = uTime - iLife.x;
  float t = age / max(iLife.y, 0.0001);
  float dead = step(1.0, t) + step(age, -0.00001);

  // Ease-out expansion: violent first frames, then coasting.
  float e = 1.0 - pow(1.0 - clamp(t, 0.0, 1.0), 2.6);
  float r = mix(iLife.z, iLife.w, e);

  vec3 local = vec3(position.xy * 2.0 * r, 0.0);
  vec3 world = iPos + qrot(iQuat, local);
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
  if (dead > 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

  vUv = uv;
  vT = clamp(t, 0.0, 1.0);
  vRow = iStyle.x;
  vBright = iStyle.y;
  vInner = iStyle.z;
  vNoiseUv = uv * 2.4 + vec2(iLife.x * 0.37, iLife.x * 0.19);
}
`;

const RING_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform sampler2D uRamp;
uniform vec3 uTint;

varying vec2 vUv;
varying float vT;
varying float vRow;
varying float vBright;
varying float vInner;
varying float vViewZ;
varying vec2 vNoiseUv;

${FOG_PARS}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  // Analytic annulus: inner ramp-in, hard-ish outer edge.
  float a = smoothstep(vInner - 0.3, vInner + 0.04, r) * (1.0 - smoothstep(0.82, 1.0, r));
  float n = texture2D(uNoise, vNoiseUv).r;
  a *= 0.45 + n * 1.05;

  vec4 ramp = texture2D(uRamp, vec2(vT, vRow));
  a *= ramp.a;
  if (a < 0.004) discard;

  vec3 col = ramp.rgb * vBright;
  float f = fogFactor(vViewZ);
  #ifdef ADDITIVE
    col *= (1.0 - f);
  #else
    col *= uTint;
    col = mix(col, uFogColor, f);
  #endif
  gl_FragColor = vec4(col, min(a, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Decals
// ---------------------------------------------------------------------------

const DECAL_VERT = /* glsl */ `
uniform float uTime;
uniform float uCellScale;

attribute vec3 dPos;
attribute vec4 dQuat;
attribute vec4 dLife;   // spawn, lifetime, size, alphaMul
attribute vec2 dCell;
attribute vec3 dTint;

varying vec2 vUv;
varying float vFade;
varying vec3 vTint;
varying float vViewZ;

${QUAT_ROTATE}

void main() {
  float age = uTime - dLife.x;
  float t = age / max(dLife.y, 0.0001);
  float dead = step(1.0, t) + step(age, -0.00001);

  vec3 world = dPos + qrot(dQuat, vec3(position.xy * dLife.z, 0.0));
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
  if (dead > 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

  vUv = uv * uCellScale + dCell;
  // Snap in, then fade over the last quarter of life.
  vFade = dLife.w * (1.0 - smoothstep(0.72, 1.0, t));
  vTint = dTint;
}
`;

const DECAL_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uTint;

varying vec2 vUv;
varying float vFade;
varying vec3 vTint;
varying float vViewZ;

${FOG_PARS}

void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vFade;
  if (a < 0.006) discard;
  vec3 col = tex.rgb * vTint * uTint;
  col = mix(col, uFogColor, fogFactor(vViewZ));
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Pool plumbing
// ---------------------------------------------------------------------------

/**
 * Fixed-capacity ring allocator with a dirty span. Oldest slot is silently
 * recycled — under a heavy firefight the newest effects always win, which is
 * exactly the behaviour you want when the budget is exhausted.
 */
class Ring {
  private cursor = 0;
  lo = Infinity;
  hi = -1;

  constructor(readonly cap: number) {}

  next(): number {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.cap;
    if (i < this.lo) this.lo = i;
    if (i > this.hi) this.hi = i;
    return i;
  }

  /** Uploads only the slots written since the last flush. */
  flush(attrs: THREE.BufferAttribute[]): void {
    if (this.hi < 0) return;
    const count = this.hi - this.lo + 1;
    for (const a of attrs) {
      a.addUpdateRange(this.lo * a.itemSize, count * a.itemSize);
      a.needsUpdate = true;
    }
    this.lo = Infinity;
    this.hi = -1;
  }
}

/** Four verts / six indices in XY. `x0..x1` lets streaks anchor at their tail. */
function quadArrays(x0: number, x1: number) {
  return {
    position: new Float32Array([x0, -0.5, 0, x1, -0.5, 0, x1, 0.5, 0, x0, 0.5, 0]),
    uv: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    index: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
}

const NO_RAYCAST = () => {};
const INFINITE_SPHERE = () => new THREE.Sphere(new THREE.Vector3(), Infinity);

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

const createVfx: SystemFactory = (ctx) => {
  const rng = ctx.rng;
  const budget = BUDGETS[ctx.quality] ?? BUDGETS.high;
  const D = budget.density;
  const noiseSeed = (rng() * 0x7fffffff) | 0;

  const rr = (a: number, b: number) => a + (b - a) * rng();
  /** Scales a burst count by the quality density, never below 1 when asked for >0. */
  const cnt = (n: number) => (n <= 0 ? 0 : Math.max(1, Math.round(n * D)));

  // --- Textures (generated once, reused forever) ---------------------------
  const texSprites = makeSpriteAtlas(noiseSeed);
  const texStreak = makeStreakTexture();
  const texRingNoise = makeRingNoiseTexture(noiseSeed + 4021);
  const texRamp = makeRampTexture();
  const texDecals = makeDecalAtlas(budget.atlas, rng);

  // --- Shared uniforms -----------------------------------------------------
  const uTime = { value: 0 };
  const uWind = { value: new THREE.Vector3(0.28, 0, -0.16) };
  const uFogColor = { value: new THREE.Color(0x9fd6ea) };
  const uFogParams = { value: new THREE.Vector3(500, 4200, 0.0006) };
  const uFogKind = { value: 1 };
  const uPixelScale = { value: 600 };
  const uResolution = { value: new THREE.Vector2(1, 1) };
  const uCamRange = { value: new THREE.Vector2(0.08, 12000) };
  /** Sun-driven tint applied to everything lit rather than emissive. */
  const uLitTint = { value: new THREE.Color(1, 1, 1) };

  const materials: THREE.ShaderMaterial[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const textures: THREE.Texture[] = [
    texSprites, texStreak, texRingNoise, texRamp, texDecals,
  ];

  // =========================================================================
  // Billboard layers
  // =========================================================================

  interface BillboardLayer {
    points: THREE.Points;
    ring: Ring;
    attrs: THREE.BufferAttribute[];
    pos: Float32Array;
    vel: Float32Array;
    life: Float32Array;
    style: Float32Array;
    motion: Float32Array;
    material: THREE.ShaderMaterial;
  }

  function makeBillboardLayer(
    cap: number,
    additive: boolean,
    order: number,
    name: string,
  ): BillboardLayer {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(cap * 3);
    const vel = new Float32Array(cap * 3);
    const life = new Float32Array(cap * 4);
    const style = new Float32Array(cap * 4);
    const motion = new Float32Array(cap * 4);
    // Dead until spawned: lifetime 0 pushes t to +inf on the first frame.
    for (let i = 0; i < cap; i++) life[i * 4] = -1e9;

    const aPos = new THREE.BufferAttribute(pos, 3);
    const aVel = new THREE.BufferAttribute(vel, 3);
    const aLife = new THREE.BufferAttribute(life, 4);
    const aStyle = new THREE.BufferAttribute(style, 4);
    const aMotion = new THREE.BufferAttribute(motion, 4);
    for (const a of [aPos, aVel, aLife, aStyle, aMotion]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", aPos);
    geo.setAttribute("aVel", aVel);
    geo.setAttribute("aLife", aLife);
    geo.setAttribute("aStyle", aStyle);
    geo.setAttribute("aMotion", aMotion);
    geo.boundingSphere = INFINITE_SPHERE();

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime, uWind, uPixelScale, uFogColor, uFogParams, uFogKind,
        uResolution, uCamRange,
        uMap: { value: texSprites },
        uRamp: { value: texRamp },
        uTint: additive ? { value: new THREE.Color(1, 1, 1) } : uLitTint,
        uDepth: { value: null as THREE.Texture | null },
        uSoftness: { value: additive ? 1.6 : 2.6 },
      },
      vertexShader: BILLBOARD_VERT,
      fragmentShader: BILLBOARD_FRAG,
      defines: additive ? { ADDITIVE: "1" } : {},
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    const points = new THREE.Points(geo, material);
    points.name = name;
    points.frustumCulled = false;
    points.matrixAutoUpdate = false;
    points.renderOrder = order;
    points.raycast = NO_RAYCAST;
    ctx.scene.add(points);
    materials.push(material);
    geometries.push(geo);

    return {
      points, ring: new Ring(cap), pos, vel, life, style, motion, material,
      attrs: [aPos, aVel, aLife, aStyle, aMotion],
    };
  }

  // Both layers sample the same sprite atlas; only blend mode and ramp range
  // differ, which is what keeps this at exactly two draw calls.
  const bbAdd = makeBillboardLayer(budget.billboards, true, 24, "vfx.billboards.additive");
  const bbAlpha = makeBillboardLayer(budget.billboards, false, 22, "vfx.billboards.alpha");

  /**
   * Spawn a billboard. Positional args on purpose: this is the hottest call in
   * the module and an options object here would allocate thousands of times a
   * second during a firefight.
   */
  function emitBillboard(
    layer: BillboardLayer,
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    life: number, size0: number, size1: number,
    ramp: number, bright: number,
    buoyancy: number, drag: number, spin: number,
    sprite: number = SPRITE.smoke,
    delay = 0,
  ): void {
    const i = layer.ring.next();
    const i3 = i * 3;
    const i4 = i * 4;
    layer.pos[i3] = px; layer.pos[i3 + 1] = py; layer.pos[i3 + 2] = pz;
    layer.vel[i3] = vx; layer.vel[i3 + 1] = vy; layer.vel[i3 + 2] = vz;
    layer.life[i4] = uTime.value + delay;
    layer.life[i4 + 1] = life;
    layer.life[i4 + 2] = rng();
    layer.life[i4 + 3] = drag;
    layer.style[i4] = size0;
    layer.style[i4 + 1] = size1;
    layer.style[i4 + 2] = (ramp + 0.5) / RAMP_ROWS;
    layer.style[i4 + 3] = bright;
    layer.motion[i4] = buoyancy;
    layer.motion[i4 + 1] = spin;
    layer.motion[i4 + 2] = SPRITE_U[sprite];
    layer.motion[i4 + 3] = SPRITE_V[sprite];
  }

  // =========================================================================
  // Streaks
  // =========================================================================

  const streakCap = budget.streaks;
  const streakRing = new Ring(streakCap);
  const sPos = new Float32Array(streakCap * 3);
  const sVel = new Float32Array(streakCap * 3);
  const sAcc = new Float32Array(streakCap * 3);
  const sLife = new Float32Array(streakCap * 4);
  const sStyle = new Float32Array(streakCap * 2);
  for (let i = 0; i < streakCap; i++) sLife[i * 4] = -1e9;

  const streakGeo = new THREE.InstancedBufferGeometry();
  {
    const q = quadArrays(0, 1);
    streakGeo.setIndex(new THREE.BufferAttribute(q.index, 1));
    streakGeo.setAttribute("position", new THREE.BufferAttribute(q.position, 3));
    streakGeo.setAttribute("uv", new THREE.BufferAttribute(q.uv, 2));
  }
  const sAttrs = [
    new THREE.InstancedBufferAttribute(sPos, 3),
    new THREE.InstancedBufferAttribute(sVel, 3),
    new THREE.InstancedBufferAttribute(sAcc, 3),
    new THREE.InstancedBufferAttribute(sLife, 4),
    new THREE.InstancedBufferAttribute(sStyle, 2),
  ];
  const sNames = ["iPos", "iVel", "iAcc", "iLife", "iStyle"];
  sAttrs.forEach((a, i) => {
    a.setUsage(THREE.DynamicDrawUsage);
    streakGeo.setAttribute(sNames[i], a);
  });
  streakGeo.instanceCount = streakCap;
  streakGeo.boundingSphere = INFINITE_SPHERE();

  const streakMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime, uFogColor, uFogParams, uFogKind,
      uMap: { value: texStreak },
      uRamp: { value: texRamp },
    },
    vertexShader: STREAK_VERT,
    fragmentShader: STREAK_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const streakMesh = new THREE.Mesh(streakGeo, streakMat);
  streakMesh.name = "vfx.streaks";
  streakMesh.frustumCulled = false;
  streakMesh.matrixAutoUpdate = false;
  streakMesh.renderOrder = 25;
  streakMesh.raycast = NO_RAYCAST;
  ctx.scene.add(streakMesh);
  materials.push(streakMat);
  geometries.push(streakGeo);

  function emitStreak(
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    ax: number, ay: number, az: number,
    life: number, width: number, length: number,
    ramp: number, bright: number,
    delay = 0,
  ): void {
    const i = streakRing.next();
    const i3 = i * 3;
    const i4 = i * 4;
    const i2 = i * 2;
    sPos[i3] = px; sPos[i3 + 1] = py; sPos[i3 + 2] = pz;
    sVel[i3] = vx; sVel[i3 + 1] = vy; sVel[i3 + 2] = vz;
    sAcc[i3] = ax; sAcc[i3 + 1] = ay; sAcc[i3 + 2] = az;
    sLife[i4] = uTime.value + delay;
    sLife[i4 + 1] = life;
    sLife[i4 + 2] = width;
    sLife[i4 + 3] = length;
    sStyle[i2] = (ramp + 0.5) / RAMP_ROWS;
    sStyle[i2 + 1] = bright;
  }

  // =========================================================================
  // Rings
  // =========================================================================

  interface RingLayer {
    ring: Ring;
    pos: Float32Array;
    quat: Float32Array;
    life: Float32Array;
    style: Float32Array;
    attrs: THREE.InstancedBufferAttribute[];
    mesh: THREE.Mesh;
  }

  function makeRingLayer(cap: number, additive: boolean, order: number, name: string): RingLayer {
    const pos = new Float32Array(cap * 3);
    const quat = new Float32Array(cap * 4);
    const life = new Float32Array(cap * 4);
    const style = new Float32Array(cap * 3);
    for (let i = 0; i < cap; i++) {
      life[i * 4] = -1e9;
      quat[i * 4 + 3] = 1;
    }
    const geo = new THREE.InstancedBufferGeometry();
    const q = quadArrays(-0.5, 0.5);
    geo.setIndex(new THREE.BufferAttribute(q.index, 1));
    geo.setAttribute("position", new THREE.BufferAttribute(q.position, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(q.uv, 2));
    const attrs = [
      new THREE.InstancedBufferAttribute(pos, 3),
      new THREE.InstancedBufferAttribute(quat, 4),
      new THREE.InstancedBufferAttribute(life, 4),
      new THREE.InstancedBufferAttribute(style, 3),
    ];
    const names = ["iPos", "iQuat", "iLife", "iStyle"];
    attrs.forEach((a, i) => {
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(names[i], a);
    });
    geo.instanceCount = cap;
    geo.boundingSphere = INFINITE_SPHERE();

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime, uFogColor, uFogParams, uFogKind,
        uNoise: { value: texRingNoise },
        uRamp: { value: texRamp },
        uTint: uLitTint,
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      defines: additive ? { ADDITIVE: "1" } : {},
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = order;
    mesh.raycast = NO_RAYCAST;
    ctx.scene.add(mesh);
    materials.push(mat);
    geometries.push(geo);
    return { ring: new Ring(cap), pos, quat, life, style, attrs, mesh };
  }

  const ringAdd = makeRingLayer(Math.max(8, Math.round(budget.rings * 0.45)), true, 20, "vfx.rings.additive");
  const ringDust = makeRingLayer(Math.max(8, Math.round(budget.rings * 0.55)), false, 19, "vfx.rings.dust");

  const tmpQuat = new THREE.Quaternion();
  const tmpQuat2 = new THREE.Quaternion();
  const tmpVec = new THREE.Vector3();
  const tmpVec2 = new THREE.Vector3();
  const tmpVec3 = new THREE.Vector3();
  const surfaceNormal = new THREE.Vector3();
  const UNIT_Z = new THREE.Vector3(0, 0, 1);
  const UNIT_Y = new THREE.Vector3(0, 1, 0);

  /** Builds the quaternion that lays a +Z quad flat against `n`, with roll. */
  function orientTo(n: THREE.Vector3, roll: number): THREE.Quaternion {
    tmpVec.copy(n);
    if (tmpVec.lengthSq() < 1e-8) tmpVec.copy(UNIT_Y);
    tmpVec.normalize();
    tmpQuat.setFromUnitVectors(UNIT_Z, tmpVec);
    tmpQuat2.setFromAxisAngle(UNIT_Z, roll);
    return tmpQuat.multiply(tmpQuat2);
  }

  function emitRing(
    layer: RingLayer,
    px: number, py: number, pz: number,
    n: THREE.Vector3,
    life: number, r0: number, r1: number,
    ramp: number, bright: number, inner: number,
    delay = 0,
  ): void {
    const i = layer.ring.next();
    const i3 = i * 3;
    const i4 = i * 4;
    const q = orientTo(n, rng() * Math.PI * 2);
    layer.pos[i3] = px; layer.pos[i3 + 1] = py; layer.pos[i3 + 2] = pz;
    layer.quat[i4] = q.x; layer.quat[i4 + 1] = q.y; layer.quat[i4 + 2] = q.z; layer.quat[i4 + 3] = q.w;
    layer.life[i4] = uTime.value + delay;
    layer.life[i4 + 1] = life;
    layer.life[i4 + 2] = r0;
    layer.life[i4 + 3] = r1;
    layer.style[i3] = (ramp + 0.5) / RAMP_ROWS;
    layer.style[i3 + 1] = bright;
    layer.style[i3 + 2] = inner;
  }

  // =========================================================================
  // Decals
  // =========================================================================

  const decalCap = budget.decals;
  const decalRing = new Ring(decalCap);
  const dPos = new Float32Array(decalCap * 3);
  const dQuat = new Float32Array(decalCap * 4);
  const dLife = new Float32Array(decalCap * 4);
  const dCell = new Float32Array(decalCap * 2);
  const dTint = new Float32Array(decalCap * 3);
  for (let i = 0; i < decalCap; i++) {
    dLife[i * 4] = -1e9;
    dQuat[i * 4 + 3] = 1;
  }
  const decalGeo = new THREE.InstancedBufferGeometry();
  {
    const q = quadArrays(-0.5, 0.5);
    decalGeo.setIndex(new THREE.BufferAttribute(q.index, 1));
    decalGeo.setAttribute("position", new THREE.BufferAttribute(q.position, 3));
    decalGeo.setAttribute("uv", new THREE.BufferAttribute(q.uv, 2));
  }
  const dAttrs = [
    new THREE.InstancedBufferAttribute(dPos, 3),
    new THREE.InstancedBufferAttribute(dQuat, 4),
    new THREE.InstancedBufferAttribute(dLife, 4),
    new THREE.InstancedBufferAttribute(dCell, 2),
    new THREE.InstancedBufferAttribute(dTint, 3),
  ];
  const dNames = ["dPos", "dQuat", "dLife", "dCell", "dTint"];
  dAttrs.forEach((a, i) => {
    a.setUsage(THREE.DynamicDrawUsage);
    decalGeo.setAttribute(dNames[i], a);
  });
  decalGeo.instanceCount = decalCap;
  decalGeo.boundingSphere = INFINITE_SPHERE();

  const decalMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime, uFogColor, uFogParams, uFogKind,
      uMap: { value: texDecals },
      uCellScale: { value: 1 / ATLAS_DIV },
      uTint: uLitTint,
    },
    vertexShader: DECAL_VERT,
    fragmentShader: DECAL_FRAG,
    transparent: true,
    depthWrite: false,
    // Decals sit millimetres off their surface; polygon offset stops the
    // z-fight that a pure position nudge leaves on grazing angles.
    polygonOffset: true,
    polygonOffsetFactor: -6,
    polygonOffsetUnits: -6,
    side: THREE.DoubleSide,
  });
  const decalMesh = new THREE.Mesh(decalGeo, decalMat);
  decalMesh.name = "vfx.decals";
  decalMesh.frustumCulled = false;
  decalMesh.matrixAutoUpdate = false;
  decalMesh.renderOrder = 6;
  decalMesh.raycast = NO_RAYCAST;
  ctx.scene.add(decalMesh);
  materials.push(decalMat);
  geometries.push(decalGeo);

  const tintColor = new THREE.Color();

  function emitDecal(
    px: number, py: number, pz: number,
    n: THREE.Vector3,
    size: number, cell: number, life: number,
    tintHex = 0xffffff, alpha = 1,
  ): void {
    if (size <= 0 || decalCap === 0) return;
    const i = decalRing.next();
    const i3 = i * 3;
    const i4 = i * 4;
    const i2 = i * 2;
    const q = orientTo(n, rng() * Math.PI * 2);
    // Lift off the surface so the quad never sinks into the wall it marks.
    dPos[i3] = px + tmpVec.x * 0.025;
    dPos[i3 + 1] = py + tmpVec.y * 0.025;
    dPos[i3 + 2] = pz + tmpVec.z * 0.025;
    dQuat[i4] = q.x; dQuat[i4 + 1] = q.y; dQuat[i4 + 2] = q.z; dQuat[i4 + 3] = q.w;
    dLife[i4] = uTime.value;
    dLife[i4 + 1] = life;
    dLife[i4 + 2] = size;
    dLife[i4 + 3] = alpha;
    dCell[i2] = (cell % ATLAS_DIV) / ATLAS_DIV;
    // CanvasTexture is flipY, so atlas row 0 lives at the top of UV space.
    dCell[i2 + 1] = 1 - (Math.floor(cell / ATLAS_DIV) + 1) / ATLAS_DIV;
    tintColor.setHex(tintHex, THREE.SRGBColorSpace);
    dTint[i3] = tintColor.r;
    dTint[i3 + 1] = tintColor.g;
    dTint[i3 + 2] = tintColor.b;
  }

  // =========================================================================
  // Debris (the only CPU-simulated layer — chunks need to bounce)
  // =========================================================================

  interface Chunk {
    pos: THREE.Vector3;
    vel: THREE.Vector3;
    axis: THREE.Vector3;
    quat: THREE.Quaternion;
    spin: number;
    size: number;
    life: number;
    maxLife: number;
    hot: number;
    trail: number;
    rest: boolean;
  }

  const debrisCap = budget.debris;
  const chunkGeo = new THREE.IcosahedronGeometry(0.5, 0);
  {
    // Jitter the hull so chunks read as rubble rather than dice.
    const p = chunkGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      p.setXYZ(i, p.getX(i) * rr(0.55, 1.5), p.getY(i) * rr(0.55, 1.5), p.getZ(i) * rr(0.55, 1.5));
    }
    chunkGeo.computeVertexNormals();
  }
  const chunkMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.05,
    flatShading: true,
  });
  const debrisMesh = new THREE.InstancedMesh(chunkGeo, chunkMat, Math.max(1, debrisCap));
  debrisMesh.name = "vfx.debris";
  debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  debrisMesh.frustumCulled = false;
  debrisMesh.raycast = NO_RAYCAST;
  debrisMesh.castShadow = ctx.quality === "ultra";
  ctx.scene.add(debrisMesh);
  geometries.push(chunkGeo);

  const chunks: Chunk[] = [];
  const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
  const tmpMatrix = new THREE.Matrix4();
  const tmpScale = new THREE.Vector3();
  const chunkColor = new THREE.Color();
  for (let i = 0; i < debrisCap; i++) {
    chunks.push({
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      axis: new THREE.Vector3(0, 1, 0),
      quat: new THREE.Quaternion(),
      spin: 0, size: 0, life: 0, maxLife: 1, hot: 0, trail: 0, rest: false,
    });
    debrisMesh.setMatrixAt(i, zeroMatrix);
    debrisMesh.setColorAt(i, chunkColor.setHex(0x808080));
  }
  debrisMesh.instanceMatrix.needsUpdate = true;
  if (debrisMesh.instanceColor) debrisMesh.instanceColor.needsUpdate = true;
  let debrisCursor = 0;
  let debrisLive = 0;

  function emitDebris(
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    size: number, colorHex: number, hot: number, life: number,
  ): void {
    if (debrisCap === 0) return;
    const slot = debrisCursor;
    const c = chunks[slot];
    debrisCursor = (debrisCursor + 1) % debrisCap;
    if (c.life <= 0) debrisLive++;
    c.pos.set(px, py, pz);
    c.vel.set(vx, vy, vz);
    c.axis.set(rr(-1, 1), rr(-1, 1), rr(-1, 1)).normalize();
    c.quat.set(0, 0, 0, 1);
    c.spin = rr(6, 22);
    c.size = size;
    c.maxLife = life;
    c.life = life;
    c.hot = hot;
    c.trail = 0;
    c.rest = false;
    debrisMesh.setColorAt(slot, chunkColor.setHex(colorHex, THREE.SRGBColorSpace));
    if (debrisMesh.instanceColor) debrisMesh.instanceColor.needsUpdate = true;
  }

  // =========================================================================
  // Light pool — allocated once and left in the scene at zero intensity so
  // three never has to relink every material's program mid-firefight.
  // =========================================================================

  interface FlashLight {
    light: THREE.PointLight;
    life: number;
    dur: number;
    peak: number;
    flicker: number;
  }
  const lights: FlashLight[] = [];
  for (let i = 0; i < budget.lights; i++) {
    const l = new THREE.PointLight(0xffb060, 0, 30, 2);
    l.castShadow = false;
    l.visible = true;
    ctx.scene.add(l);
    lights.push({ light: l, life: 0, dur: 1, peak: 0, flicker: 0 });
  }

  /** Grabs the dimmest slot so a new blast never steals a brighter one. */
  function flashLight(
    x: number, y: number, z: number,
    colorHex: number, peak: number, distance: number, duration: number, flicker = 0,
  ): void {
    if (lights.length === 0) return;
    let best = lights[0];
    let bestScore = Infinity;
    for (const fl of lights) {
      const score = fl.life <= 0 ? -1 : fl.light.intensity;
      if (score < bestScore) {
        bestScore = score;
        best = fl;
      }
    }
    best.light.position.set(x, y, z);
    best.light.color.setHex(colorHex, THREE.SRGBColorSpace);
    best.light.distance = distance;
    best.peak = peak;
    best.dur = duration;
    best.life = duration;
    best.flicker = flicker;
    best.light.intensity = peak;
  }

  // =========================================================================
  // Camera feedback: trauma-based shake + FOV punch
  // =========================================================================

  let trauma = 0;
  let fovPunch = 0;
  let fovApplied = 0;
  const shakeOffset = new THREE.Vector3();

  /** Anyone can request shake by emitting "palmas:shake" with a 0..1 number. */
  const offShake = ctx.on("palmas:shake", (payload) => {
    const amount =
      typeof payload === "number"
        ? payload
        : ((payload as { amount?: number })?.amount ?? 0);
    trauma = Math.min(1, trauma + Math.max(0, amount));
  });

  /** Adds trauma scaled by distance from the player — near blasts hit hardest. */
  function shakeFrom(point: THREE.Vector3, strength: number, range: number): void {
    const cam = ctx.services.player?.camera ?? ctx.camera;
    const d = cam.position.distanceTo(point);
    const falloff = Math.max(0, 1 - d / range);
    if (falloff <= 0) return;
    const amount = strength * falloff * falloff;
    ctx.emit("palmas:shake", amount);
    fovPunch = Math.min(9, fovPunch + amount * 7);
  }

  // Soft particles need a scene depth texture; postfx publishes one if it has
  // it. Until then we simply render hard-edged, which is correct-looking, just
  // less forgiving where smoke meets the ground.
  const offDepth = ctx.on("palmas:depth", (payload) => {
    const tex = payload as THREE.Texture | null;
    for (const layer of [bbAdd, bbAlpha]) {
      layer.material.uniforms.uDepth.value = tex ?? null;
      const want = tex ? "1" : undefined;
      if (want && !layer.material.defines.SOFT) {
        layer.material.defines.SOFT = "1";
        layer.material.needsUpdate = true;
      } else if (!want && layer.material.defines.SOFT) {
        delete layer.material.defines.SOFT;
        layer.material.needsUpdate = true;
      }
    }
  });

  // =========================================================================
  // Helpers shared by the effect recipes
  // =========================================================================

  /** Ground height under a point, falling back to the point itself. */
  function groundY(x: number, z: number, fallback: number): number {
    const t = ctx.services.terrain;
    return t ? t.heightAt(x, z) : fallback;
  }

  /** Terrain normal, defaulting to straight up. */
  function groundNormal(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const t = ctx.services.terrain;
    if (t) return t.normalAt(x, z, out);
    return out.set(0, 1, 0);
  }

  /** Audio is another module's business; never let a missing bank throw here. */
  function safeAudio(name: string, position: THREE.Vector3, volume: number, rate = 1): void {
    const a = ctx.services.audio;
    if (!a) return;
    try {
      a.play(name, { position, volume, rate });
    } catch {
      /* a stub audio bank that doesn't know this cue is not our problem */
    }
  }

  /** Random unit vector, biased toward the hemisphere around `n` when given. */
  function scatter(out: THREE.Vector3, n?: THREE.Vector3, spread = 1): THREE.Vector3 {
    const a = rng() * Math.PI * 2;
    const z = rr(-1, 1);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out.set(Math.cos(a) * r, z, Math.sin(a) * r);
    if (n) {
      // Fold into the normal's hemisphere first — lerping an exactly opposed
      // direction would cancel to zero and normalize() would hand back NaN.
      if (out.dot(n) < 0) out.negate();
      out.lerp(n, 1 - spread * 0.5);
      if (out.lengthSq() < 1e-8) out.copy(n);
      out.normalize();
    }
    return out;
  }

  // How many explosions have gone off this frame — a chain reaction must not
  // be allowed to blow the whole particle budget in a single tick.
  let blastsThisFrame = 0;

  // =========================================================================
  // VfxService
  // =========================================================================

  const service: VfxService = {
    /**
     * The signature effect. Layered, in order of what the eye reads first:
     *   1. flash core + point light (the physical cue that light was emitted)
     *   2. fireball (alpha, cools white→yellow→orange→red→black smoke)
     *   3. additive glow riding on top of the fireball for the first moments
     *   4. shockwave ring + ground dust ring, laid on the terrain normal
     *   5. radial sparks and debris with trails
     *   6. lingering smoke column and heat haze, spawned on GPU-side delays
     */
    explosion(point: THREE.Vector3, scale = 1) {
      const s = THREE.MathUtils.clamp(scale, 0.3, 7);
      blastsThisFrame++;
      // Chain reactions taper hard after the third blast in one frame.
      const busy = blastsThisFrame > 3 ? 0.35 : blastsThisFrame > 1 ? 0.7 : 1;
      const q = D * busy;
      const n = (v: number) => Math.max(1, Math.round(v * q));

      const px = point.x;
      const py = point.y;
      const pz = point.z;

      const terrain = ctx.services.terrain;
      const gy = groundY(px, pz, py);
      const nearGround = py - gy < 4.5 * s;
      const sea = terrain?.seaLevel ?? 0;
      const inWater = !!terrain?.isWater(px, pz) && py < sea + 2.5 * s;
      const gn = groundNormal(px, pz, surfaceNormal);

      // --- 1. Flash core ----------------------------------------------------
      emitBillboard(bbAdd, px, py, pz, 0, 0, 0,
        0.11 + 0.04 * s, 2.6 * s, 13 * s, RAMP.flash, 4.2, 0, 0, rr(-3, 3), SPRITE.flare);
      for (let i = 0; i < n(3); i++) {
        scatter(tmpVec2);
        emitBillboard(bbAdd,
          px + tmpVec2.x * s, py + tmpVec2.y * s * 0.6, pz + tmpVec2.z * s,
          tmpVec2.x * 6 * s, tmpVec2.y * 5 * s, tmpVec2.z * 6 * s,
          0.16 + 0.05 * s, 1.6 * s, 7 * s, RAMP.flash, 2.6, 0, 2.2, rr(-4, 4), SPRITE.glow);
      }

      // --- 2. Fireball, cooling into smoke ---------------------------------
      const ballCount = n(10 + 7 * s);
      for (let i = 0; i < ballCount; i++) {
        scatter(tmpVec2);
        const sp = rr(2.5, 9) * Math.pow(s, 0.75);
        const up = rr(0.15, 1.0);
        emitBillboard(bbAlpha,
          px + tmpVec2.x * s * 0.6, py + tmpVec2.y * s * 0.4 + 0.4 * s, pz + tmpVec2.z * s * 0.6,
          tmpVec2.x * sp, tmpVec2.y * sp * 0.55 + up * sp * 0.6, tmpVec2.z * sp,
          rr(1.5, 2.8) * Math.pow(s, 0.35),
          2.0 * s, rr(7, 11) * s,
          RAMP.fireSmoke, 1.05,
          2.6, 1.5, rr(-1.6, 1.6), SPRITE.smoke);
      }
      // Incandescent glow riding on the same volume — additive, dies fast.
      for (let i = 0; i < n(7 + 4 * s); i++) {
        scatter(tmpVec2);
        const sp = rr(2, 8) * Math.pow(s, 0.7);
        emitBillboard(bbAdd,
          px + tmpVec2.x * s * 0.5, py + tmpVec2.y * s * 0.35 + 0.3 * s, pz + tmpVec2.z * s * 0.5,
          tmpVec2.x * sp, tmpVec2.y * sp * 0.5 + sp * 0.5, tmpVec2.z * sp,
          rr(0.4, 0.85), 2.2 * s, 6.5 * s, RAMP.fire, 2.0, 3.4, 1.9, rr(-2, 2), SPRITE.glow);
      }
      // Rising fire column — the part that keeps burning after the flash.
      for (let i = 0; i < n(3 + 2 * s); i++) {
        emitBillboard(bbAlpha,
          px + rr(-0.5, 0.5) * s, py + rr(0.2, 1.4) * s, pz + rr(-0.5, 0.5) * s,
          rr(-1, 1) * s, rr(2, 5) * s, rr(-1, 1) * s,
          rr(2.4, 3.6), 2.6 * s, rr(9, 14) * s,
          RAMP.fireSmoke, 0.95, 3.2, 1.1, rr(-1, 1), SPRITE.smoke, i * 0.045);
      }

      // --- 3. Point light ---------------------------------------------------
      // Tuned against the sky module's directional sun (intensity ~2.6): a
      // blast should visibly out-light the sun for a fraction of a second.
      flashLight(px, py + 0.6 * s, pz, 0xffb367, 620 * s * s, 34 * s, 0.55 + 0.22 * s, 0.35);

      // --- 4. Ground interaction -------------------------------------------
      if (inWater) {
        const wy = sea + 0.05;
        emitRing(ringAdd, px, wy, pz, UNIT_Y, 1.3 + 0.3 * s, 1.2 * s, 16 * s, RAMP.water, 1.1, 0.78);
        emitRing(ringDust, px, wy, pz, UNIT_Y, 2.2 + 0.4 * s, 1.6 * s, 24 * s, RAMP.water, 0.9, 0.86);
        for (let i = 0; i < n(16 + 8 * s); i++) {
          const a = rng() * Math.PI * 2;
          const rad = rr(0.2, 1.4) * s;
          const sp = rr(6, 20) * Math.pow(s, 0.6);
          emitStreak(px + Math.cos(a) * rad, wy, pz + Math.sin(a) * rad,
            Math.cos(a) * sp * 0.45, sp * rr(0.8, 1.5), Math.sin(a) * sp * 0.45,
            0, -24, 0, rr(0.8, 1.6), 0.06 * s, 2.2 * s, RAMP.water, 1.4);
        }
        for (let i = 0; i < n(12 + 6 * s); i++) {
          const a = rng() * Math.PI * 2;
          emitBillboard(bbAlpha, px + Math.cos(a) * rr(0, 2) * s, wy, pz + Math.sin(a) * rr(0, 2) * s,
            Math.cos(a) * rr(2, 9) * s, rr(4, 13) * s, Math.sin(a) * rr(2, 9) * s,
            rr(1.4, 2.6), 1.4 * s, 5 * s, RAMP.water, 1.0, -3.5, 1.2, rr(-1, 1), SPRITE.glow);
        }
      } else if (nearGround) {
        // Fast white shockwave, then the slow dust wall behind it.
        emitRing(ringAdd, px, gy + 0.08, pz, gn, 0.34 + 0.08 * s, 1.0 * s, 22 * s, RAMP.shock, 2.2, 0.9);
        emitRing(ringDust, px, gy + 0.06, pz, gn, 1.15 + 0.35 * s, 1.6 * s, 19 * s, RAMP.dust, 1.0, 0.5);
        emitRing(ringDust, px, gy + 0.05, pz, gn, 1.9 + 0.4 * s, 3 * s, 27 * s, RAMP.dust, 0.7, 0.72,
          0.18);

        // Dust hugging the deck, thrown outward and low.
        for (let i = 0; i < n(12 + 6 * s); i++) {
          const a = rng() * Math.PI * 2;
          const sp = rr(7, 18) * Math.pow(s, 0.6);
          emitBillboard(bbAlpha,
            px + Math.cos(a) * s * 0.8, gy + rr(0.1, 0.8) * s, pz + Math.sin(a) * s * 0.8,
            Math.cos(a) * sp, rr(0.4, 2.4), Math.sin(a) * sp,
            rr(1.6, 3.2), 1.6 * s, rr(7, 12) * s,
            RAMP.dust, 1.0, 0.9, 2.4, rr(-1, 1), SPRITE.dust);
        }
        // Scorch the ground.
        emitDecal(px, gy, pz, gn,
          rr(3.2, 4.6) * s,
          s > 1.6 ? (rng() < 0.5 ? DECAL.scorch : DECAL.scorch2) : DECAL.scorchSmall,
          40, 0xffffff, 0.92);
        if (s > 1.2) {
          for (let i = 0; i < n(3); i++) {
            const a = rng() * Math.PI * 2;
            const d = rr(1.5, 4) * s;
            emitDecal(px + Math.cos(a) * d, groundY(px + Math.cos(a) * d, pz + Math.sin(a) * d, gy),
              pz + Math.sin(a) * d, gn, rr(1.2, 2.4) * s, DECAL.soot, 34, 0xffffff, 0.55);
          }
        }
      }

      // --- 5. Sparks + debris ----------------------------------------------
      for (let i = 0; i < n(18 + 10 * s); i++) {
        scatter(tmpVec2);
        const sp = rr(12, 42) * Math.pow(s, 0.45);
        emitStreak(px, py, pz,
          tmpVec2.x * sp, Math.abs(tmpVec2.y) * sp * 0.9 + rr(2, 9), tmpVec2.z * sp,
          0, -26, 0,
          rr(0.45, 1.35), rr(0.03, 0.07), rr(2.2, 4.5),
          RAMP.spark, rr(1.6, 3.0));
      }
      const chunkN = Math.min(debrisCap, n(4 + 4 * s));
      for (let i = 0; i < chunkN; i++) {
        scatter(tmpVec2);
        const sp = rr(9, 26) * Math.pow(s, 0.5);
        emitDebris(px, py + 0.4 * s, pz,
          tmpVec2.x * sp, Math.abs(tmpVec2.y) * sp * 0.8 + rr(4, 12), tmpVec2.z * sp,
          rr(0.14, 0.42) * Math.pow(s, 0.4),
          rng() < 0.4 ? 0x2a2724 : 0x6a625a,
          rng() < 0.55 ? 1 : 0,
          rr(3.5, 6.5));
      }

      // --- 6. Lingering smoke + heat haze -----------------------------------
      const smokeN = n(6 + 4 * s);
      for (let i = 0; i < smokeN; i++) {
        scatter(tmpVec2);
        emitBillboard(bbAlpha,
          px + tmpVec2.x * s * 1.2, py + rr(0.3, 2.2) * s, pz + tmpVec2.z * s * 1.2,
          tmpVec2.x * rr(0.6, 2.6), rr(1.2, 3.4), tmpVec2.z * rr(0.6, 2.6),
          rr(4.5, 8.5), 3.5 * s, rr(13, 20) * s,
          RAMP.smokeDark, 1.0, 0.55, 0.75, rr(-0.5, 0.5),
          SPRITE.smoke, 0.25 + i * 0.09);
      }
      // Heat shimmer: a faint warm additive wobble over the fire. A real
      // screen-space refraction lives in postfx — see "palmas:distort" below.
      for (let i = 0; i < n(2 + s); i++) {
        emitBillboard(bbAdd,
          px + rr(-1, 1) * s, py + rr(0.5, 2) * s, pz + rr(-1, 1) * s,
          rr(-0.6, 0.6), rr(1.5, 3.5), rr(-0.6, 0.6),
          rr(1.2, 2.2), 3 * s, 10 * s, RAMP.haze, 1.0, 2.2, 0.9, rr(-0.6, 0.6),
          SPRITE.dust);
      }
      // Slow embers drifting up out of the fire.
      for (let i = 0; i < n(6 + 3 * s); i++) {
        scatter(tmpVec2);
        emitBillboard(bbAdd,
          px + tmpVec2.x * s, py + rr(0, 1.5) * s, pz + tmpVec2.z * s,
          tmpVec2.x * rr(1, 5), rr(1.5, 6), tmpVec2.z * rr(1, 5),
          rr(1.4, 3.4), rr(0.1, 0.26) * s, rr(0.04, 0.1) * s,
          RAMP.ember, rr(1.8, 3.2), 1.2, 1.1, 0, SPRITE.glow);
      }

      // --- Player feedback ---------------------------------------------------
      shakeFrom(point, 0.55 + 0.2 * s, 46 * s);
      ctx.emit("palmas:distort", {
        point: [px, py, pz],
        radius: 20 * s,
        strength: Math.min(1, 0.35 * s),
        duration: 0.45,
      });
      safeAudio("debris", point, Math.min(1, 0.4 * s), rr(0.9, 1.1));
    },

    /**
     * Surface-specific hit. Every branch leaves a decal (except water) so a
     * firefight writes its history onto the level.
     */
    impact(point: THREE.Vector3, normal: THREE.Vector3, material: ImpactMaterial = "concrete") {
      const p = IMPACTS[material] ?? IMPACTS.concrete;
      const px = point.x;
      const py = point.y;
      const pz = point.z;
      const n = tmpVec3.copy(normal);
      if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
      n.normalize();

      // --- Hit flash: the readability cue that something was struck ---------
      if (p.flash > 0) {
        emitBillboard(bbAdd,
          px + n.x * 0.05, py + n.y * 0.05, pz + n.z * 0.05,
          0, 0, 0, 0.06, 0.35 * p.flash, 0.9 * p.flash,
          p.flashRamp, 2.4 * p.flash, 0, 0, rr(-3, 3), SPRITE.flare);
      }

      // --- Surface puff -----------------------------------------------------
      const puffSprite = IMPACT_PUFF_SPRITE[material] ?? SPRITE.dust;
      for (let i = 0; i < cnt(p.puffCount); i++) {
        scatter(tmpVec2, n, 0.75);
        const sp = p.puffSpeed * rr(0.5, 1.5);
        emitBillboard(bbAlpha,
          px + n.x * 0.06, py + n.y * 0.06, pz + n.z * 0.06,
          tmpVec2.x * sp, tmpVec2.y * sp + 0.6, tmpVec2.z * sp,
          p.puffLife * rr(0.7, 1.4),
          p.puffSize * rr(0.5, 0.9), p.puffSize * rr(2.4, 4.2),
          p.puffRamp, 1.0, material === "water" ? -1.5 : 0.35, p.puffDrag, rr(-2, 2),
          puffSprite);
      }

      // --- Chips / splinters -------------------------------------------------
      for (let i = 0; i < cnt(p.chipCount); i++) {
        scatter(tmpVec2, n, 0.9);
        const sp = rr(3, 9);
        emitBillboard(bbAlpha,
          px + n.x * 0.05, py + n.y * 0.05, pz + n.z * 0.05,
          tmpVec2.x * sp, tmpVec2.y * sp + rr(0.5, 3), tmpVec2.z * sp,
          rr(0.5, 1.1), rr(0.02, 0.06), rr(0.015, 0.04),
          p.chipRamp, 1.0, -14, 0.6, rr(-9, 9), SPRITE.glow);
      }

      // --- Sparks / droplets / shards ---------------------------------------
      for (let i = 0; i < cnt(p.sparkCount); i++) {
        scatter(tmpVec2, n, 0.85);
        const sp = p.sparkSpeed * rr(0.45, 1.6);
        emitStreak(px + n.x * 0.04, py + n.y * 0.04, pz + n.z * 0.04,
          tmpVec2.x * sp, tmpVec2.y * sp + rr(0, 3), tmpVec2.z * sp,
          0, material === "water" ? -18 : -24, 0,
          p.sparkLife * rr(0.6, 1.4), p.sparkWidth * rr(0.7, 1.4), rr(1.4, 3.2),
          p.sparkRamp, rr(1.3, 2.6));
      }

      // --- Ring: metal ping, glass flash, water ripple ------------------------
      if (p.ring > 0) {
        const layer = p.ringAdditive ? ringAdd : ringDust;
        if (material === "water") {
          const sea = ctx.services.terrain?.seaLevel ?? py;
          emitRing(layer, px, sea + 0.03, pz, UNIT_Y, 1.5, 0.25, p.ring * 3.2,
            p.ringRamp, 0.8, 0.86);
          emitRing(layer, px, sea + 0.03, pz, UNIT_Y, 2.4, 0.4, p.ring * 5.5,
            p.ringRamp, 0.5, 0.9, 0.22);
        } else {
          emitRing(layer, px + n.x * 0.03, py + n.y * 0.03, pz + n.z * 0.03, n,
            0.28, 0.06, p.ring, p.ringRamp, 1.8, 0.7);
        }
      }

      // --- Decal -------------------------------------------------------------
      if (p.decals.length > 0) {
        const cell = p.decals[(rng() * p.decals.length) | 0];
        emitDecal(px, py, pz, n, p.decalSize * rr(0.8, 1.35), cell, p.decalLife,
          p.decalTint, rr(0.7, 1));
      }

      safeAudio(p.sound, point, 0.35, rr(0.88, 1.15));
    },

    /**
     * Tracer: a stretched additive bolt that flies the path in a few frames.
     * The bolt curves very slightly — real tracers droop, and a dead-straight
     * line reads as a laser.
     */
    tracer(from: THREE.Vector3, to: THREE.Vector3) {
      tmpVec.subVectors(to, from);
      const dist = tmpVec.length();
      if (dist < 2.5) return;
      const life = THREE.MathUtils.clamp(dist / 460, 0.028, 0.42);

      // Perpendicular sag, chosen so the bolt still lands exactly on `to`:
      //   p(t) = from + v t + ½ a t²  with  v = (to-from)/life - ½ a life.
      tmpVec2.copy(tmpVec).normalize();
      tmpVec3.set(-tmpVec2.z, 0, tmpVec2.x);
      if (tmpVec3.lengthSq() < 1e-6) tmpVec3.set(1, 0, 0);
      tmpVec3.normalize();
      const sag = rr(-1, 1) * dist * 0.35;
      const ax = tmpVec3.x * sag;
      const ay = -9;
      const az = tmpVec3.z * sag;
      const vx = tmpVec.x / life - 0.5 * ax * life;
      const vy = tmpVec.y / life - 0.5 * ay * life;
      const vz = tmpVec.z / life - 0.5 * az * life;

      const len = Math.min(dist * 0.55, 7 + dist * 0.045);
      emitStreak(from.x, from.y, from.z, vx, vy, vz, ax, ay, az,
        life, 0.055, len, RAMP.spark, 2.6);
      // A wider, dimmer core sells the glow without needing bloom.
      emitStreak(from.x, from.y, from.z, vx, vy, vz, ax, ay, az,
        life, 0.16, len * 0.7, RAMP.spark, 0.55);
    },

    /**
     * Muzzle flash. `matrix` is the muzzle transform; three's convention puts
     * an object's forward on -Z, so that is the direction we throw gases.
     */
    muzzleFlash(matrix: THREE.Matrix4, scale = 1) {
      const e = matrix.elements;
      const px = e[12];
      const py = e[13];
      const pz = e[14];
      // -Z basis column, normalised (the matrix may carry scale).
      tmpVec.set(-e[8], -e[9], -e[10]);
      const fl = tmpVec.length();
      if (fl < 1e-6) tmpVec.set(0, 0, -1);
      else tmpVec.divideScalar(fl);
      const s = THREE.MathUtils.clamp(scale, 0.25, 4);

      // Star flare, random roll each shot so repeat fire never strobes.
      emitBillboard(bbAdd, px + tmpVec.x * 0.12, py + tmpVec.y * 0.12, pz + tmpVec.z * 0.12,
        tmpVec.x * 2, tmpVec.y * 2, tmpVec.z * 2,
        0.045, 0.75 * s, 1.15 * s, RAMP.flash, 4.5, 0, 0, rr(-8, 8), SPRITE.flare);
      emitBillboard(bbAdd, px + tmpVec.x * 0.3, py + tmpVec.y * 0.3, pz + tmpVec.z * 0.3,
        tmpVec.x * 6, tmpVec.y * 6, tmpVec.z * 6,
        0.07, 0.3 * s, 0.85 * s, RAMP.fire, 3.0, 0, 3, rr(-6, 6), SPRITE.glow);

      // Burnt propellant pushed down the barrel line.
      for (let i = 0; i < cnt(3); i++) {
        scatter(tmpVec2, tmpVec, 0.4);
        const sp = rr(3, 9) * s;
        emitBillboard(bbAlpha,
          px + tmpVec.x * 0.2, py + tmpVec.y * 0.2, pz + tmpVec.z * 0.2,
          tmpVec2.x * sp, tmpVec2.y * sp + 0.4, tmpVec2.z * sp,
          rr(0.35, 0.9), 0.1 * s, rr(0.5, 0.9) * s,
          RAMP.smokeLight, 1.0, 0.9, 3.4, rr(-2, 2), SPRITE.smoke);
      }
      // Unburnt powder sparks.
      for (let i = 0; i < cnt(5); i++) {
        scatter(tmpVec2, tmpVec, 0.55);
        const sp = rr(5, 17) * s;
        emitStreak(px + tmpVec.x * 0.15, py + tmpVec.y * 0.15, pz + tmpVec.z * 0.15,
          tmpVec2.x * sp, tmpVec2.y * sp, tmpVec2.z * sp,
          0, -22, 0, rr(0.12, 0.32), 0.022, rr(0.8, 1.8), RAMP.spark, rr(1.4, 2.6));
      }

      flashLight(px + tmpVec.x * 0.3, py + tmpVec.y * 0.3, pz + tmpVec.z * 0.3,
        0xffd9a0, 34 * s * s, 13 * s, 0.055);
    },

    /**
     * Lingering smoke. Staggered spawn delays turn a single call into a plume
     * that keeps feeding for a second or two — one call, no timers.
     */
    smoke(point: THREE.Vector3, amount = 1) {
      const a = THREE.MathUtils.clamp(amount, 0.1, 6);
      const count = cnt(3 + a * 3);
      for (let i = 0; i < count; i++) {
        scatter(tmpVec2);
        emitBillboard(bbAlpha,
          point.x + tmpVec2.x * 0.5 * a, point.y + rr(0, 0.8) * a, point.z + tmpVec2.z * 0.5 * a,
          tmpVec2.x * rr(0.2, 1.1) * a, rr(0.8, 2.2) * a, tmpVec2.z * rr(0.2, 1.1) * a,
          rr(4, 9), rr(0.8, 1.6) * a, rr(4.5, 9) * a,
          RAMP.smokeLight, 1.0, 0.5, 0.9, rr(-0.4, 0.4),
          SPRITE.smoke, i * rr(0.08, 0.24));
      }
    },
  };

  ctx.services.vfx = service;

  // =========================================================================
  // Frame
  // =========================================================================

  const drawSize = new THREE.Vector2();
  const windPhase = { v: rng() * 100 };
  const nightTint = new THREE.Color(0x2c3a55);
  const sunTint = new THREE.Color();

  const sys: System = {
    name: "vfx",

    update(dt) {
      uTime.value = ctx.elapsed;
      blastsThisFrame = 0;

      // --- Uniform sync -----------------------------------------------------
      const cam = ctx.camera;
      ctx.renderer.getDrawingBufferSize(drawSize);
      // gl_PointSize is in framebuffer pixels: worldSize * f / viewZ * h/2.
      uPixelScale.value = drawSize.y * 0.5 * cam.projectionMatrix.elements[5];
      uResolution.value.set(drawSize.x, drawSize.y);
      uCamRange.value.set(cam.near, cam.far);

      const fog = ctx.scene.fog;
      if (!fog) {
        uFogKind.value = 0;
      } else if ((fog as THREE.FogExp2).isFogExp2) {
        uFogKind.value = 2;
        uFogColor.value.copy(fog.color);
        uFogParams.value.z = (fog as THREE.FogExp2).density;
      } else {
        uFogKind.value = 1;
        uFogColor.value.copy(fog.color);
        uFogParams.value.set((fog as THREE.Fog).near, (fog as THREE.Fog).far, 0);
      }

      // Smoke, dust and decals are lit surfaces, not emitters — tint them by
      // the sun so the same puff reads warm at noon and cold blue at night.
      const sky = ctx.services.sky;
      const daylight = THREE.MathUtils.clamp(sky?.daylight ?? 1, 0, 1);
      sunTint.copy(sky?.sunColor ?? sunTint.setHex(0xfff3e0));
      uLitTint.value.copy(nightTint).lerp(sunTint, daylight);
      uLitTint.value.multiplyScalar(0.42 + 0.72 * daylight);

      // Lazy wind: a slow lissajous so plumes never drift in a dead-straight
      // line, and every smoke column in the district agrees on the direction.
      windPhase.v += dt * 0.08;
      const wx = Math.sin(windPhase.v) * 0.22 + Math.sin(windPhase.v * 0.37) * 0.12 + 0.26;
      const wz = Math.cos(windPhase.v * 0.71) * 0.2 - 0.14;
      uWind.value.set(wx, 0, wz);

      // --- Debris physics (the only per-frame CPU sim) -----------------------
      if (debrisLive > 0) {
        const terrain = ctx.services.terrain;
        for (let i = 0; i < debrisCap; i++) {
          const c = chunks[i];
          if (c.life <= 0) continue;
          c.life -= dt;
          if (c.life <= 0) {
            debrisLive--;
            debrisMesh.setMatrixAt(i, zeroMatrix);
            // A puff where it finally settles hides the pop-out.
            emitBillboard(bbAlpha, c.pos.x, c.pos.y, c.pos.z, 0, 0.3, 0,
              0.9, c.size * 2, c.size * 7, RAMP.dust, 1, 0.4, 2.4, rr(-1, 1), SPRITE.dust);
            continue;
          }

          if (!c.rest) {
            c.vel.y -= 24 * dt;
            const drag = 1 - Math.min(0.6, 0.55 * dt);
            c.vel.multiplyScalar(drag);
            c.pos.addScaledVector(c.vel, dt);
            c.quat.multiply(tmpQuat2.setFromAxisAngle(c.axis, c.spin * dt));

            const gy = terrain ? terrain.heightAt(c.pos.x, c.pos.z) : -Infinity;
            if (c.pos.y - c.size < gy) {
              c.pos.y = gy + c.size;
              const impactSpeed = -c.vel.y;
              c.vel.y = Math.abs(c.vel.y) * 0.3;
              c.vel.x *= 0.62;
              c.vel.z *= 0.62;
              c.spin *= 0.55;
              if (impactSpeed > 4) {
                emitBillboard(bbAlpha, c.pos.x, gy + 0.05, c.pos.z,
                  rr(-1, 1), rr(0.4, 1.6), rr(-1, 1),
                  rr(0.5, 1.0), c.size * 1.5, c.size * 8, RAMP.dust, 1, 0.3, 3, rr(-2, 2), SPRITE.dust);
              }
              if (c.vel.lengthSq() < 1.6) {
                c.rest = true;
                c.vel.set(0, 0, 0);
              }
            }

            // Hot chunks leave an ember trail — the tell that debris came out
            // of a fire and not out of a spawner.
            if (c.hot > 0) {
              c.trail -= dt;
              if (c.trail <= 0) {
                c.trail = 0.045;
                emitStreak(c.pos.x, c.pos.y, c.pos.z,
                  c.vel.x * 0.25, c.vel.y * 0.25 + 0.6, c.vel.z * 0.25,
                  0, -3, 0, rr(0.25, 0.6), 0.03, 1.2, RAMP.ember, rr(1.2, 2.2));
                if (rng() < 0.5) {
                  emitBillboard(bbAlpha, c.pos.x, c.pos.y, c.pos.z, 0, 0.7, 0,
                    rr(0.7, 1.5), c.size * 1.6, c.size * 7,
                    RAMP.smokeDark, 1, 0.9, 1.4, rr(-1, 1), SPRITE.smoke);
                }
              }
            }
          }

          tmpScale.setScalar(c.size * 2);
          tmpMatrix.compose(c.pos, c.quat, tmpScale);
          debrisMesh.setMatrixAt(i, tmpMatrix);
        }
        debrisMesh.instanceMatrix.needsUpdate = true;
      }

      // --- Light decay -------------------------------------------------------
      for (const fl of lights) {
        if (fl.life <= 0) {
          if (fl.light.intensity !== 0) fl.light.intensity = 0;
          continue;
        }
        fl.life -= dt;
        const remain = Math.max(0, fl.life / fl.dur);
        // Sharp peak, long ember tail — the shape of an actual fireball.
        let k = remain * remain * (0.35 + 0.65 * remain);
        if (fl.flicker > 0) {
          k *= 1 + fl.flicker * Math.sin(ctx.elapsed * 47 + fl.dur * 13);
        }
        fl.light.intensity = Math.max(0, fl.peak * k);
      }

      // --- Upload only what changed -------------------------------------------
      bbAdd.ring.flush(bbAdd.attrs);
      bbAlpha.ring.flush(bbAlpha.attrs);
      streakRing.flush(sAttrs);
      ringAdd.ring.flush(ringAdd.attrs);
      ringDust.ring.flush(ringDust.attrs);
      decalRing.flush(dAttrs);
    },

    /**
     * Camera feedback runs after the player has written its transform, so we
     * layer shake and FOV punch on top instead of fighting the controller.
     */
    lateUpdate(dt) {
      const camera = ctx.services.player?.camera ?? ctx.camera;

      if (trauma > 0) {
        trauma = Math.max(0, trauma - dt * 1.7);
        // Squared trauma: small hits barely register, big ones are violent.
        const k = trauma * trauma;
        const t = ctx.elapsed;
        const rotX = Math.sin(t * 47.3) * 0.5 + Math.sin(t * 91.7) * 0.5;
        const rotY = Math.sin(t * 53.9 + 2.1) * 0.5 + Math.sin(t * 79.1 + 1.3) * 0.5;
        const rotZ = Math.sin(t * 61.7 + 4.7) * 0.5 + Math.sin(t * 103.3 + 0.7) * 0.5;
        camera.rotation.x += rotX * k * 0.055;
        camera.rotation.y += rotY * k * 0.055;
        camera.rotation.z += rotZ * k * 0.085;
        shakeOffset.set(rotY, rotZ, rotX).multiplyScalar(k * 0.22);
        camera.position.add(shakeOffset);
      }

      // FOV punch is applied as a delta so the player controller's own FOV lerp
      // pulls it back out naturally instead of being overwritten.
      if (fovPunch > 0.001 || Math.abs(fovApplied) > 0.001) {
        fovPunch = Math.max(0, fovPunch - dt * fovPunch * 9 - dt * 0.4);
        const delta = fovPunch - fovApplied;
        fovApplied = fovPunch;
        if (Math.abs(delta) > 0.0005) {
          camera.fov += delta;
          camera.updateProjectionMatrix();
        }
      }
    },

    resize(width, height) {
      uResolution.value.set(width, height);
    },

    dispose() {
      offShake();
      offDepth();
      for (const obj of [
        bbAdd.points, bbAlpha.points, streakMesh, decalMesh, debrisMesh,
        ringAdd.mesh, ringDust.mesh,
      ] as THREE.Object3D[]) {
        obj.parent?.remove(obj);
      }
      for (const fl of lights) fl.light.parent?.remove(fl.light);
      for (const m of materials) m.dispose();
      for (const g of geometries) g.dispose();
      for (const t of textures) t.dispose();
      chunkMat.dispose();
      debrisMesh.dispose();
    },
  };

  return sys;
};

export default createVfx;
