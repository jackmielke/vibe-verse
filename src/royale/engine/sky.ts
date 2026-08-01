/**
 * DROP ZERO — sky, sun, clouds and aerial perspective.
 *
 * Everything above the island lives here, and everything below it is lit from
 * here:
 *
 *  - An analytic Preetham scattering dome, graded toward the deep saturated
 *    blue / warm horizon Fortnite reads as, with a real limb-darkened sun disc.
 *  - A three-slab pseudo-volumetric cumulus deck evaluated inside the dome
 *    shader — domain-warped FBM sampled at three altitudes, self-shadowed
 *    toward the sun, so the tops are warm and the bases are cool and bruised.
 *  - A ring of large billboarded cumulus at mid altitude with real world
 *    positions, so the deck has parallax when you sprint and when you drop.
 *  - The key sun: one DirectionalLight on an adaptive, texel-snapped shadow
 *    cascade that reshapes itself for on-foot / elevated / skydiving framing.
 *  - A hemisphere fill (cool sky, warm sand bounce) and a cool anti-sun rim
 *    light that fakes the sky's wrap-around bounce on shadowed faces.
 *  - Exp² fog whose colour is re-sampled from the sky *in the view direction*
 *    every frame. Look toward the sun and the haze goes gold; look away and it
 *    goes blue. That single behaviour is most of what reads as "AAA landscape".
 *  - A PMREM environment map regenerated from the live dome, because a
 *    stylised-PBR world with no IBL specular is a plastic world.
 *
 * The scattering model is written twice — once in GLSL for the dome, once on
 * the CPU for the fog / hemisphere / cloud tints — and both walk the same
 * constants, so the haze can never disagree with the sky it is made of.
 *
 * Publishes `ctx.services.sky`.
 */
import * as THREE from "three";
import type { QualityTier, SkyService, System, SystemFactory } from "../types";

// ---------------------------------------------------------------------------
// Contract note
// ---------------------------------------------------------------------------

/**
 * `SkyService` in types.ts has no slot for the sun's screen-space position,
 * which post-processing needs for light shafts, and no slot for the fog the
 * quality governor may want to bias. Rather than edit the shared contract —
 * other systems are being authored against it right now — this module widens
 * it locally. Anything reading `ctx.services.sky` as a plain `SkyService`
 * still works; a consumer that wants god rays narrows to this type or listens
 * for the `dz:sun` event, which carries the same payload every frame.
 */
export interface DropZeroSkyService extends SkyService {
  /** Sun position in 0..1 screen UV. Only meaningful while `sunOnScreen`. */
  readonly sunScreen: THREE.Vector2;
  /** True when the sun is in front of the camera and above the horizon. */
  sunOnScreen: boolean;
  /** 0..1 — how strongly a shaft pass should push, folds in altitude + haze. */
  shaftStrength: number;
  /** Horizon radiance the fog is currently sampling. Read-only for consumers. */
  readonly horizonColor: THREE.Color;
  /** Zenith radiance, for anything that wants a sky-coloured tint. */
  readonly zenithColor: THREE.Color;
  /** Seconds per full 0..1 day. 0 (the default) freezes time of day. */
  timeScale: number;
}

/** Payload shape emitted on `dz:sun` once per frame. */
export interface SunScreenEvent {
  x: number;
  y: number;
  visible: boolean;
  strength: number;
  daylight: number;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Where the match starts. 0.25 is sunrise due east, 0.5 noon, 0.75 sunset —
 * so 0.30 puts the sun ~18° up in the east-south-east: full golden hour, long
 * raking shadows across the island, warm rim on every silhouette. It is the
 * most flattering light a first screenshot can be taken in and it is the
 * single highest-leverage constant in this file.
 */
const DEFAULT_TIME = 0.3;

/**
 * Time of day does NOT advance by default. A battle royale match is fifteen
 * minutes long; a sun that crawls across it makes every fight look different
 * from the last for no gameplay gain, and forces a PMREM rebuild every second.
 * `dz:timeScale` (seconds per full day) turns it on for anyone who wants it.
 */
const DEFAULT_TIME_SCALE = 0;

/**
 * The sun's arc leans south. 24° caps the sun at 66° at local noon, which
 * keeps some direction in the shadows all day and — more practically — keeps
 * the light-space basis well away from the `lookAt` singularity at the zenith,
 * where the shadow matrix degenerates and the whole map flips.
 */
const SUN_ARC_TILT = THREE.MathUtils.degToRad(24);

/**
 * Clear maritime air over a tropical island: markedly less turbid than a city
 * haze, which is what lets the zenith go deep blue instead of milky. Rayleigh
 * is pushed above physical because the target is Fortnite's sky, not a
 * photometer's. The Mie term is the golden-hour halo and does most of the
 * "warm horizon" work on its own.
 */
const ATMOSPHERE = {
  turbidity: 4.6,
  rayleigh: 3.4,
  mieCoefficient: 0.0085,
  mieG: 0.8,
};

/**
 * Preetham radiance is enormous in absolute terms. This exposure lands a
 * golden-hour zenith near sRGB(62,116,196) and a noon zenith near
 * sRGB(96,150,224) once ACES and the engine's 1.0 exposure have had their say.
 * ACES applies exposure as a plain pre-multiply, so scaling here is exactly
 * equivalent to re-exposing the entire sky — change it and re-grade nothing else.
 */
const SKY_BOOST = 0.29;

/**
 * The grade that turns "physically plausible" into "Fortnite". Preetham gives
 * a slightly grey-green zenith and a horizon that washes out too early; this
 * pushes saturation up, cools the zenith and warms the last few degrees above
 * the horizon. Applied identically in GLSL and on the CPU.
 */
const GRADE = {
  saturation: 1.2,
  /** Multiplier at the horizon (warm) and at the zenith (cool, deep). */
  horizonTint: [1.07, 1.0, 0.95] as [number, number, number],
  zenithTint: [0.86, 0.95, 1.16] as [number, number, number],
};

/** Cumulus deck geometry, in metres above sea level. */
const CLOUD_BASE = 1500;
const CLOUD_THICK = 900;
/** Horizontal feature size: 1/6500 puts a cloud mass at roughly 3–4 km across. */
const CLOUD_SCALE = 1 / 6500;
/** Cirrus sheet, far above the deck and moving three times as fast. */
const CIRRUS_HEIGHT = 7200;
const CIRRUS_SCALE = 1 / 24000;
/** Trade wind, m/s, applied to the deck's world-space sample position. */
const CLOUD_WIND = 11;

/**
 * Sun angular radius, radians. The real sun is 0.00465 — about seven pixels
 * across at 1600×900 and an 80° fov, which is far too small to survive
 * downsampling, read as a body, or give a bloom pass anything to work with.
 * 4.5× real is the size that still reads as "the sun" and not "a lens flare".
 */
const SUN_ANGULAR_RADIUS = 0.021;

/**
 * Fog. Exp² over a 3 km island: at 800 m the far treeline is ~20% hazed, at
 * 2 km it is ~70%, at the map edge it is nearly gone. That gradient is what
 * makes the island read as kilometres across rather than as a diorama.
 */
const FOG_DENSITY_DAY = 0.00034;
/** Golden hour and dusk thicken the air — more aerosol, longer light path. */
const FOG_DENSITY_LOW_SUN = 0.00021;

/**
 * Warm bounce off sand, grass and terracotta — the hemisphere light's floor.
 * Its sky colour is not a constant; it is re-derived from the live zenith
 * radiance every time the sun moves, so the fill can never disagree with the
 * dome above it.
 */
const HEMI_GROUND = new THREE.Color().setRGB(0.34, 0.26, 0.17);

const MOON_TINT = new THREE.Color().setRGB(0.66, 0.75, 1.0);

// ---------------------------------------------------------------------------
// Quality tiers
// ---------------------------------------------------------------------------

/**
 * Shadow cascades. One DirectionalLight, three fitted framings — see
 * `pickCascade`. Three *lights* is the textbook CSM, but vanilla three@0.160
 * has no per-cascade shadow selection in its lighting chunks: three
 * simultaneous directional lights each contribute full irradiance and each
 * returns "lit" for fragments outside its own frustum, so a shadow can never
 * get darker than 2/3. Making it work means patching every material in the
 * world with onBeforeCompile, and this system does not own those materials.
 * Refitting one light per frame gives crisper near shadows than a 3-split
 * would at the same map size, and past the last cascade the aerial haze is
 * already doing the occlusion work.
 */
interface Cascade {
  /** Half-extent of the ortho frustum, metres. */
  radius: number;
  /** How far along the view direction to push the centre, as a fraction. */
  lead: number;
  /** Camera height above the focus point at which this cascade takes over. */
  altitude: number;
}

const CASCADE_TIERS: Record<QualityTier, Cascade[]> = {
  low: [
    { radius: 90, lead: 0.5, altitude: 0 },
    { radius: 260, lead: 0.45, altitude: 45 },
    { radius: 780, lead: 0.35, altitude: 240 },
  ],
  medium: [
    { radius: 110, lead: 0.52, altitude: 0 },
    { radius: 300, lead: 0.46, altitude: 50 },
    { radius: 820, lead: 0.36, altitude: 260 },
  ],
  high: [
    { radius: 135, lead: 0.55, altitude: 0 },
    { radius: 340, lead: 0.48, altitude: 55 },
    { radius: 900, lead: 0.38, altitude: 280 },
  ],
  ultra: [
    { radius: 170, lead: 0.55, altitude: 0 },
    { radius: 430, lead: 0.48, altitude: 60 },
    { radius: 1100, lead: 0.38, altitude: 300 },
  ],
};

/** Cloud shader cost. `levels` is the vertical march through the deck. */
const CLOUD_TIERS: Record<QualityTier, {
  octaves: number;
  levels: number;
  taps: number;
  cirrus: boolean;
  sprites: number;
  domeSegments: number;
}> = {
  low: { octaves: 2, levels: 1, taps: 0, cirrus: false, sprites: 8, domeSegments: 24 },
  medium: { octaves: 3, levels: 2, taps: 1, cirrus: true, sprites: 16, domeSegments: 32 },
  high: { octaves: 4, levels: 3, taps: 2, cirrus: true, sprites: 26, domeSegments: 48 },
  ultra: { octaves: 4, levels: 4, taps: 2, cirrus: true, sprites: 38, domeSegments: 64 },
};

/** How far the sun may travel before the environment map is considered stale. */
const ENV_TIME_EPSILON = 0.0018;
/** …and the wall-clock floor between regenerations, so PMREM never thrashes. */
const ENV_MIN_INTERVAL = 1.1;

// ---------------------------------------------------------------------------
// Preetham constants — shared verbatim between the GLSL and the CPU mirror.
// ---------------------------------------------------------------------------

const TOTAL_RAYLEIGH: [number, number, number] = [
  5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5,
];
/** Mie primaries with Preetham's 1e-17 aerosol term folded in (see the GLSL). */
const MIE_SCALED: [number, number, number] = [
  1.8399918514433978e-3, 2.779802391966053e-3, 4.079047954386109e-3,
];
const RAYLEIGH_ZENITH = 8.4e3;
const MIE_ZENITH = 1.25e3;
const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const SUN_EE = 1000.0;
const THREE_OVER_SIXTEENPI = 0.05968310365946075;
const ONE_OVER_FOURPI = 0.07957747154594767;

// ---------------------------------------------------------------------------
// Procedural noise
// ---------------------------------------------------------------------------

/**
 * A seamless, tiling RGBA noise atlas on a periodic value-noise lattice. Every
 * octave's period divides the texture size, so it wraps exactly and the cloud
 * deck has no repeat seam no matter how far you sample.
 *
 *   R — 4-octave fbm, the cloud density base
 *   G — a decorrelated 4-octave fbm, used to domain-warp R
 *   B — 3-octave ridged noise, the wispy filament detail
 *   A — 2-octave fbm at the lowest frequencies, the *coverage* field. This is
 *       the channel that gives the sky big blue holes between cloud masses
 *       instead of an even grey blanket, and it is the difference between a
 *       sky that looks authored and one that looks like an fbm test.
 */
function buildNoiseTexture(rng: () => number, size: number): THREE.DataTexture {
  const periods = [4, 8, 16, 32];

  const tableFor = (octave: number) => {
    const p = periods[octave];
    const t = new Float32Array(p * p);
    for (let i = 0; i < t.length; i++) t[i] = rng();
    return t;
  };
  const banks = [0, 1, 2, 3].map(() => periods.map((_, o) => tableFor(o)));

  const fade = (t: number) => t * t * (3 - 2 * t);

  const lattice = (table: Float32Array, p: number, xi: number, yi: number) => {
    const x = ((xi % p) + p) % p;
    const y = ((yi % p) + p) % p;
    return table[y * p + x];
  };

  const octave = (table: Float32Array, p: number, u: number, v: number) => {
    const x = u * p;
    const y = v * p;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = fade(x - xi);
    const fy = fade(y - yi);
    const a = lattice(table, p, xi, yi);
    const b = lattice(table, p, xi + 1, yi);
    const c = lattice(table, p, xi, yi + 1);
    const d = lattice(table, p, xi + 1, yi + 1);
    const top = a + (b - a) * fx;
    const bot = c + (d - c) * fx;
    return top + (bot - top) * fy;
  };

  const data = new Uint8Array(size * size * 4);
  const inv = 1 / size;
  const rgbNorm = 0.5 + 0.25 + 0.125 + 0.0625;
  const ridgedNorm = 0.5 + 0.25 + 0.125;
  const coverNorm = 0.62 + 0.38;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * inv;
      const v = y * inv;

      let r = 0;
      let g = 0;
      let b = 0;
      let amp = 0.5;
      for (let o = 0; o < periods.length; o++) {
        const p = periods[o];
        r += octave(banks[0][o], p, u, v) * amp;
        g += octave(banks[1][o], p, u, v) * amp;
        if (o < 3) {
          // Ridged: fold the octave about its midpoint for filament-like detail.
          const n = octave(banks[2][o], p, u, v);
          b += (1 - Math.abs(n * 2 - 1)) * amp;
        }
        amp *= 0.5;
      }

      // Coverage rides only the two coarsest lattices — anything finer would
      // punch holes *inside* a cloud instead of between clouds.
      const cover =
        (octave(banks[3][0], periods[0], u, v) * 0.62 +
          octave(banks[3][1], periods[1], u, v) * 0.38) /
        coverNorm;

      const i = (y * size + x) * 4;
      data[i] = clamp255((r / rgbNorm) * 255);
      data[i + 1] = clamp255((g / rgbNorm) * 255);
      data[i + 2] = clamp255((b / ridgedNorm) * 255);
      data[i + 3] = clamp255(cover * 255);
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * The billboard cumulus atlas: a 2×2 grid of four cloud impostors.
 *
 * Each cell stores a *thickness* field built from overlapping blobs, eroded at
 * the silhouette by high-frequency noise so the edges are ragged rather than
 * airbrushed, then packed as:
 *
 *   RG — the XY of the impostor-space surface normal, [-1,1] → [0,1]
 *   B  — the Z of that normal (always toward the viewer)
 *   A  — density / coverage
 *
 * Baking the normal here rather than deriving it from four extra texture taps
 * in the shader is what lets each sprite respond to the real sun direction:
 * the terminator crosses an individual cloud, tops go warm and undersides go
 * cool, and the whole deck stops looking like decals stuck on the sky.
 */
function buildCloudAtlas(rng: () => number, size: number): THREE.CanvasTexture | null {
  // The billboards are a luxury, not a dependency. A headless or SSR pass gets
  // the shader deck and nothing else rather than taking the world down.
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) return null;

  g.fillStyle = "#000";
  g.fillRect(0, 0, size, size);

  const cell = size / 2;
  g.globalCompositeOperation = "lighter";

  for (let cy = 0; cy < 2; cy++) {
    for (let cx = 0; cx < 2; cx++) {
      const ox = cx * cell;
      const oy = cy * cell;
      // Cumulus silhouette: a wide flat base with a stack of lobes above it,
      // lobe radius falling with height. Six to nine lobes is the sweet spot —
      // fewer reads as a blob, more averages back into an ellipse.
      const lobes = 6 + Math.floor(rng() * 4);
      for (let i = 0; i < lobes; i++) {
        const t = i / (lobes - 1);
        // Base lobes spread horizontally, crown lobes cluster near the middle.
        const spread = 0.34 * (1 - t * 0.55);
        const x = ox + cell * (0.5 + (rng() - 0.5) * 2 * spread);
        const y = oy + cell * (0.66 - t * 0.34 + (rng() - 0.5) * 0.08);
        const r = cell * (0.30 - t * 0.13) * (0.75 + rng() * 0.5);
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        // A soft shoulder rather than a linear falloff: linear gradients stack
        // into visible ridges where lobes overlap.
        grad.addColorStop(0, "rgba(255,255,255,0.95)");
        grad.addColorStop(0.45, "rgba(255,255,255,0.62)");
        grad.addColorStop(0.78, "rgba(255,255,255,0.20)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grad;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  g.globalCompositeOperation = "source-over";

  const img = g.getImageData(0, 0, size, size);
  const src = img.data;

  // Height field, with a cheap 4-octave value noise erosion so the silhouette
  // frays. Sampled on its own lattice so it does not correlate with the atlas.
  const height = new Float32Array(size * size);
  const nSeed = () => rng() * 1000;
  const s0 = nSeed();
  const s1 = nSeed();

  const vnoise = (x: number, y: number, freq: number, seed: number) => {
    const xf = x * freq + seed;
    const yf = y * freq + seed * 0.7;
    const xi = Math.floor(xf);
    const yi = Math.floor(yf);
    const fx = xf - xi;
    const fy = yf - yi;
    const h = (a: number, b: number) => {
      const n = Math.sin(a * 127.1 + b * 311.7 + seed) * 43758.5453;
      return n - Math.floor(n);
    };
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = h(xi, yi);
    const b = h(xi + 1, yi);
    const c = h(xi, yi + 1);
    const d = h(xi + 1, yi + 1);
    const top = a + (b - a) * sx;
    const bot = c + (d - c) * sx;
    return top + (bot - top) * sy;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      let h = src[i * 4] / 255;
      const frayA = vnoise(x, y, 0.055, s0);
      const frayB = vnoise(x, y, 0.14, s1);
      // Erode by up to 30% of the fray field, weighted toward the silhouette:
      // the core must stay solid or the cloud goes translucent in the middle.
      const edge = 1 - Math.min(1, h * 1.6);
      h -= (frayA * 0.62 + frayB * 0.38) * 0.42 * edge;
      height[i] = Math.max(0, Math.min(1, h));
    }
  }

  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const xm = x > 0 ? x - 1 : x;
      const xp = x < size - 1 ? x + 1 : x;
      const ym = y > 0 ? y - 1 : y;
      const yp = y < size - 1 ? y + 1 : y;
      const dx = height[y * size + xp] - height[y * size + xm];
      // Canvas Y runs down, world Y runs up — flip so a lobe's top faces up.
      const dy = height[ym * size + x] - height[yp * size + x];

      // Bulge toward the viewer at the core. The +0.22 floor keeps the normal
      // from degenerating to pure sideways at the fringe, which would make thin
      // edges flip between fully lit and fully black as the sun moves.
      const nz = Math.sqrt(Math.max(0, height[i])) + 0.22;
      const nx = -dx * 5.5;
      const ny = -dy * 5.5;
      const len = Math.hypot(nx, ny, nz) || 1;

      const o = i * 4;
      out[o] = clamp255(((nx / len) * 0.5 + 0.5) * 255);
      out[o + 1] = clamp255(((ny / len) * 0.5 + 0.5) * 255);
      out[o + 2] = clamp255((nz / len) * 255);
      // Density curve: the shoulder starts early so the fringe is genuinely
      // wispy, and saturates well before the core so the middle is opaque.
      const d = THREE.MathUtils.smoothstep(height[i], 0.035, 0.42);
      out[o + 3] = clamp255(d * 255);
    }
  }

  g.putImageData(new ImageData(out, size, size), 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  // Normal + density, not colour — this must never be sRGB-decoded.
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Sky dome shader
// ---------------------------------------------------------------------------

const SKY_VERT = /* glsl */ `
varying vec3 vDir;

void main() {
  // Object space direction: the dome is an unrotated sphere parked on the
  // camera, so object position IS the view ray for this fragment at any radius.
  vDir = position;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // Pin to the far plane. The dome then needs no depth range of its own and
  // can never be clipped, at any radius, from any altitude.
  clip.z = clip.w;
  gl_Position = clip;
}
`;

interface CloudTier {
  octaves: number;
  levels: number;
  taps: number;
  cirrus: boolean;
}

/**
 * The dome fragment shader is generated rather than written once, because the
 * cloud march's octave count, slab count and self-shadow taps all have to be
 * compile-time constants for GLSL ES 1.0's loop rules — and because a `low`
 * machine should not pay for branches it will never take.
 */
function buildSkyFragment(tier: CloudTier): string {
  const weights = [0.52, 0.26, 0.14, 0.08].slice(0, tier.octaves);
  const norm = weights.reduce((a, b) => a + b, 0);
  const levelStep = tier.levels > 1 ? 1 / (tier.levels - 1) : 0;
  // With a single slab there is no base-to-crown gradient to walk, so park that
  // one sample two thirds of the way up: a `low` machine gets the lit crown
  // rather than the bruised underside, which is the half that reads.
  const levelBase = tier.levels > 1 ? 0 : 0.66;

  return /* glsl */ `
precision highp float;

uniform vec3  uSunDir;
uniform vec3  uMoonDir;
uniform float uTurbidity;
uniform float uRayleigh;
uniform float uMieCoefficient;
uniform float uMieG;
uniform float uSkyBoost;
uniform vec3  uSunTint;
uniform float uSunRadius;
uniform float uNight;
uniform vec3  uNightZenith;
uniform vec3  uNightHorizon;
uniform float uMoonRadius;
uniform float uMoonCos;
uniform float uTime;
uniform sampler2D uNoise;

uniform vec2  uCamXZ;
uniform float uCamY;
uniform vec3  uCloudSun;
uniform vec3  uCloudAmbient;
uniform vec3  uHorizonColor;
uniform float uCover;
uniform float uCloudOpacity;
uniform float uCirrusAmount;
uniform float uWind;

varying vec3 vDir;

#define LEVELS ${tier.levels}
#define TAPS ${tier.taps}
#define OCTAVES ${tier.octaves}
${tier.cirrus ? "#define CIRRUS" : ""}
#define LEVEL_STEP ${levelStep.toFixed(6)}
#define LEVEL_BASE ${levelBase.toFixed(6)}
#define FBM_NORM ${norm.toFixed(4)}

#define CLOUD_BASE ${CLOUD_BASE.toFixed(1)}
#define CLOUD_THICK ${CLOUD_THICK.toFixed(1)}
#define CLOUD_SCALE ${CLOUD_SCALE.toExponential(8)}
#define CIRRUS_HEIGHT ${CIRRUS_HEIGHT.toFixed(1)}
#define CIRRUS_SCALE ${CIRRUS_SCALE.toExponential(8)}

const vec3  UPV = vec3(0.0, 1.0, 0.0);
const vec3  TOTAL_RAYLEIGH = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
// Preetham's mie primaries with the 1E-17 aerosol term already folded in, so
// nothing in this shader ever has to hold a 1E14 intermediate.
const vec3  MIE_SCALED = vec3(1.8399918514433978E-3, 2.7798023919660528E-3, 4.0790479543861094E-3);
const float RAYLEIGH_ZENITH = 8.4E3;
const float MIE_ZENITH = 1.25E3;
const float CUTOFF_ANGLE = 1.6110731556870734;
const float STEEPNESS = 1.5;
const float EE = 1000.0;
const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
const float ONE_OVER_FOURPI = 0.07957747154594767;

const vec3 GRADE_HORIZON = vec3(${GRADE.horizonTint.map((v) => v.toFixed(4)).join(", ")});
const vec3 GRADE_ZENITH = vec3(${GRADE.zenithTint.map((v) => v.toFixed(4)).join(", ")});
const float GRADE_SAT = ${GRADE.saturation.toFixed(4)};

/** Preetham's earth-shadow hack: the sun's power dies past the terminator. */
float sunIntensity(float zenithAngleCos) {
  zenithAngleCos = clamp(zenithAngleCos, -1.0, 1.0);
  return EE * max(0.0, 1.0 - exp(-((CUTOFF_ANGLE - acos(zenithAngleCos)) / STEEPNESS)));
}

vec3 totalMie(float T) {
  return 0.434 * (0.2 * T) * MIE_SCALED;
}

float rayleighPhase(float cosTheta) {
  return THREE_OVER_SIXTEENPI * (1.0 + cosTheta * cosTheta);
}

float hgPhase(float cosTheta, float g) {
  float g2 = g * g;
  float denom = pow(max(1e-4, 1.0 - 2.0 * g * cosTheta + g2), 1.5);
  return ONE_OVER_FOURPI * ((1.0 - g2) / denom);
}

/**
 * The stylisation pass. Preetham alone gives a slightly grey-green zenith and
 * a horizon that desaturates a few degrees too early; this pushes chroma,
 * cools the deep sky and warms the last band above the horizon. Mirrored
 * exactly on the CPU so the fog is graded the same way the sky is.
 */
vec3 gradeSky(vec3 c, float upness) {
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(lum), c, GRADE_SAT);
  c *= mix(GRADE_HORIZON, GRADE_ZENITH, upness);
  return max(c, vec3(0.0));
}

float hash13(vec3 p) {
  p = fract(p * vec3(0.1031, 0.11369, 0.13787));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

/**
 * Star field. A 3D cell grid sampled along the view direction; roughly one in
 * seventy cells holds a star, so the density stays believable while the field
 * costs four hashes and no texture fetch.
 */
vec3 starField(vec3 d, float twinkle) {
  vec3 g = d * 210.0;
  vec3 id = floor(g);
  vec3 f = fract(g) - 0.5;

  float pick = hash13(id);
  if (pick < 0.986) return vec3(0.0);

  vec3 jitter = vec3(hash13(id + 11.3), hash13(id + 27.7), hash13(id + 43.1)) - 0.5;
  float dist = length(f - jitter * 0.62);
  float core = smoothstep(0.30, 0.02, dist);

  float mag = hash13(id + 61.9);
  float bright = pow(mag, 3.4) * 2.6 + 0.12;
  vec3 tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.84, 0.62), pow(hash13(id + 83.7), 1.6));
  float flicker = 0.78 + 0.22 * sin(twinkle * (2.0 + mag * 7.0) + mag * 40.0);

  return tint * core * bright * flicker;
}

/** Multi-octave density from the tiling atlas. Roughly 0..1. */
float cloudFbm(vec2 p) {
  float v = texture2D(uNoise, p).r * ${weights[0].toFixed(3)};
#if OCTAVES > 1
  v += texture2D(uNoise, p * 2.07 + vec2(0.317, 0.113)).g * ${(weights[1] ?? 0).toFixed(3)};
#endif
#if OCTAVES > 2
  v += texture2D(uNoise, p * 4.19 + vec2(0.771, 0.529)).r * ${(weights[2] ?? 0).toFixed(3)};
#endif
#if OCTAVES > 3
  v += texture2D(uNoise, p * 8.37 + vec2(0.219, 0.887)).b * ${(weights[3] ?? 0).toFixed(3)};
#endif
  // Summing decorrelated octaves pulls the distribution hard toward its mean,
  // which gives a uniformly milky sky. Expand the contrast back out so the
  // deck breaks into real cloud and real blue instead of grey soup.
  return (v / FBM_NORM - 0.5) * 2.25 + 0.5;
}

/**
 * Coverage: the slow, kilometre-scale field that decides where cloud IS at all.
 * 0.26 puts its coarsest feature at roughly 6 km, so you get two or three
 * distinct cloud masses across the visible sky with real blue between them —
 * which is the thing a single fbm can never give you.
 */
float coverField(vec2 p) {
  return texture2D(uNoise, p * 0.26 + vec2(0.05, 0.62)).a;
}

void main() {
  vec3 dir = normalize(vDir);
  float sunUp = dot(uSunDir, UPV);

  // ---- Analytic single scattering (Preetham) ------------------------------
  float sunE = sunIntensity(sunUp);
  float sunfade = 1.0 - clamp(1.0 - exp(sunUp * 0.889), 0.0, 1.0);

  float rayleighCoefficient = max(0.05, uRayleigh - (1.0 - sunfade));
  vec3 betaR = TOTAL_RAYLEIGH * rayleighCoefficient;
  vec3 betaM = totalMie(uTurbidity) * uMieCoefficient;

  // Optical depth through a spherical shell, from Preetham's fit.
  float zenithAngle = acos(max(0.0, dot(UPV, dir)));
  float denom = cos(zenithAngle) + 0.15 * pow(max(1e-3, 93.885 - degrees(zenithAngle)), -1.253);
  float sR = RAYLEIGH_ZENITH / denom;
  float sM = MIE_ZENITH / denom;
  vec3 Fex = exp(-(betaR * sR + betaM * sM));

  float cosTheta = dot(dir, uSunDir);
  vec3 betaTheta = betaR * rayleighPhase(cosTheta * 0.5 + 0.5) + betaM * hgPhase(cosTheta, uMieG);
  vec3 betaSum = betaR + betaM;

  vec3 Lin = pow(sunE * (betaTheta / betaSum) * (1.0 - Fex), vec3(1.5));
  Lin *= mix(
    vec3(1.0),
    pow(sunE * (betaTheta / betaSum) * Fex, vec3(0.5)),
    clamp(pow(1.0 - sunUp, 5.0), 0.0, 1.0)
  );

  // ---- Sun disc, with limb darkening --------------------------------------
  // The disc is not a flat white circle: a real photosphere is ~35% dimmer and
  // markedly redder at the limb than at the centre, because the line of sight
  // grazes cooler upper layers. Those per-channel exponents are the standard
  // fit; they are why the disc reads as a body rather than as a decal.
  vec3 L0 = vec3(0.1) * Fex;
  float ang = acos(clamp(cosTheta, -1.0, 1.0));
  // The soft edge is deliberately ~15% of the radius wide. At an 80° fov a
  // pixel spans ~0.0016 rad, so a mathematically exact limb would land inside
  // one pixel and crawl; this puts the transition across two or three.
  float discMask = 1.0 - smoothstep(uSunRadius * 0.86, uSunRadius * 1.05, ang);
  if (discMask > 0.0) {
    float rN = min(ang / uSunRadius, 1.0);
    float mu = sqrt(max(0.0, 1.0 - rN * rN));
    vec3 limb = pow(vec3(mu), vec3(0.397, 0.503, 0.652));
    L0 += uSunTint * limb * discMask * sunE * 21000.0 * Fex;
  }
  // Corona on top of the Mie halo: a tight 2° ring and a broad ~10° bloom.
  // Both exist so a downstream bloom/shaft pass has a bright, tightly bounded
  // source to bite on — the Mie term alone is too diffuse to threshold cleanly.
  float g = max(cosTheta, 0.0);
  L0 += uSunTint * sunE * Fex * (pow(g, 2400.0) * 620.0 + pow(g, 300.0) * 2.2);

  vec3 texColor = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
  float upness = clamp(dir.y, 0.0, 1.0);
  vec3 color = pow(texColor, vec3(1.0 / (1.2 + 1.2 * sunfade))) * uSkyBoost;
  color = gradeSky(color, smoothstep(0.0, 0.55, upness));

  // ---- Clouds --------------------------------------------------------------
  float horizonFade = smoothstep(0.010, 0.075, dir.y);
  if (horizonFade > 0.0) {
    // Forward scattering: cloud edges facing the sun blow out, which is the
    // "silver lining" and the single most recognisable thing about real cloud.
    float silver = 1.0 + 2.6 * hgPhase(cosTheta, 0.76);
    vec2 windOff = vec2(1.0, -0.42) * uWind * CLOUD_SCALE;

#ifdef CIRRUS
    {
      float t = max(CIRRUS_HEIGHT - uCamY, 900.0) / dir.y;
      vec2 q = (uCamXZ + dir.xz * t) * CIRRUS_SCALE;
      // Cirrus is sheared into filaments by the jet stream; squashing one axis
      // is the whole trick, and it runs ~3× the deck's wind speed.
      q.x *= 0.30;
      q += windOff * 3.1;
      float n = cloudFbm(q);
      float c = smoothstep(0.56, 0.86, n) * uCirrusAmount * horizonFade;
      // Thin ice cloud is lit from behind more than from in front.
      vec3 cirrusCol = mix(uCloudAmbient * 1.05, uCloudSun * (0.32 + 0.30 * silver), 0.62);
      cirrusCol = mix(uHorizonColor, cirrusCol, smoothstep(0.02, 0.34, dir.y));
      color = mix(color, cirrusCol, clamp(c, 0.0, 1.0));
    }
#endif

    // Cumulus: a vertical march through the slab. Each level is a horizontal
    // plane intersected with the view ray, so the deck has real parallax — it
    // slides past as you run, piles up toward the horizon, and the levels shear
    // against each other, which is what makes flat noise read as volume.
    {
      float baseH = max(CLOUD_BASE - uCamY, 220.0);
      vec2 sdir = normalize(uSunDir.xz + vec2(1e-4, 1e-4));
      vec3 accum = vec3(0.0);
      float trans = 1.0;

      for (int i = 0; i < LEVELS; i++) {
        float f = LEVEL_BASE + float(i) * LEVEL_STEP;
        float t = (baseH + f * CLOUD_THICK) / dir.y;
        vec2 w = (uCamXZ + dir.xz * t) * CLOUD_SCALE;
        // Wind shear: the crown runs faster than the base, so a cloud leans.
        w += windOff * (1.0 + f * 0.32);

        // Domain warp. The cheapest way to stop fbm looking like fbm, and the
        // warp field drifts on its own clock so the deck evolves as well as moves.
        vec2 warp = (texture2D(uNoise, w * 0.29 + windOff * 0.11).gb - 0.5) * 0.62;
        vec2 sp = w + warp;

        float n = cloudFbm(sp);
        float clump = coverField(w);
        // Threshold climbs with altitude, so the mass narrows into a cauliflower
        // crown over a flat sheared base. Subtracting the coverage field opens
        // real holes of blue between separate cloud masses.
        float th = uCover + f * 0.18 - (clump - 0.5) * 0.34;
        float dens = smoothstep(th, th + 0.19, n);
        if (dens <= 0.001) continue;

        // Height alone already darkens the base; the taps add the real thing.
        float lit = mix(0.26, 1.0, f);
#if TAPS > 0
        float occ = max(0.0, cloudFbm(sp + sdir * 0.045) - n);
#if TAPS > 1
        occ += max(0.0, cloudFbm(sp + sdir * 0.110) - n) * 0.65;
#endif
        lit *= exp(-occ * 7.5);
#endif
        // Powder: thin edges transmit light, so they read brighter than the core.
        float powder = 1.0 + 0.9 * (1.0 - dens);
        vec3 shaded = uCloudAmbient * mix(0.42, 1.0, f);
        vec3 sunlit = uCloudSun * lit * silver * powder * 0.30;
        accum += (shaded + sunlit) * dens * trans;
        trans *= 1.0 - dens;
      }

      // Aerial perspective on the deck itself: cloud near the horizon is tens
      // of kilometres away and has to sit *in* the haze, not on top of it.
      float opacity = (1.0 - trans);
      accum = mix(uHorizonColor * opacity, accum, smoothstep(0.015, 0.30, dir.y));

      float k = uCloudOpacity * horizonFade;
      color = color * (1.0 - opacity * k) + accum * k;
    }
  }

  // ---- Night ---------------------------------------------------------------
  if (uNight > 0.001) {
    float h = clamp(dir.y, 0.0, 1.0);
    vec3 night = mix(uNightHorizon, uNightZenith, pow(h, 0.55));

    // Extinction near the horizon kills the low stars first, as it should.
    float starMask = smoothstep(-0.02, 0.22, dir.y);

    vec3 galaxyAxis = normalize(vec3(0.42, 0.36, -0.83));
    float bandT = dot(dir, galaxyAxis);
    float band = exp(-bandT * bandT * 12.0);
    vec2 bandUv = vec2(atan(dir.z, dir.x) * 0.159154 + 0.5, dir.y * 0.5 + 0.5);
    float dust = texture2D(uNoise, bandUv * vec2(2.0, 1.0)).r * 0.6
               + texture2D(uNoise, bandUv * vec2(6.0, 3.0) + 0.37).b * 0.4;
    night += vec3(0.055, 0.052, 0.075) * band * dust * starMask;
    night += starField(dir, uTime) * starMask * 0.55;

    float md = dot(dir, uMoonDir);
    float moonUp = smoothstep(-0.08, 0.06, uMoonDir.y);
    if (md > uMoonCos && moonUp > 0.0) {
      vec3 mt = normalize(cross(uMoonDir, UPV));
      vec3 mb = cross(mt, uMoonDir);
      vec2 luv = vec2(dot(dir, mt), dot(dir, mb)) / uMoonRadius;
      float r2 = dot(luv, luv);
      if (r2 < 1.0) {
        // Reconstruct the near-side surface normal: it points back at us.
        vec3 n = luv.x * mt + luv.y * mb - sqrt(max(0.0, 1.0 - r2)) * uMoonDir;
        float lambert = max(0.0, dot(n, uSunDir));
        float surf = 0.72
          + 0.34 * texture2D(uNoise, luv * 0.42 + 0.5).r
          - 0.22 * texture2D(uNoise, luv * 0.15 + 0.31).b;
        float edge = 1.0 - smoothstep(0.94, 1.0, sqrt(r2));
        night += vec3(1.0, 0.98, 0.93) * surf * (0.04 + 1.35 * lambert) * edge * moonUp;
      }
    }
    float mg = max(md, 0.0);
    night += vec3(0.72, 0.80, 1.0) * (pow(mg, 1400.0) * 0.55 + pow(mg, 70.0) * 0.028) * moonUp;

    color += night * uNight;
  }

  gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);

  // ShaderMaterial gets no grading for free — pull in the same ACES + sRGB path
  // every other material in Drop Zero is authored against.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
}

// ---------------------------------------------------------------------------
// Billboard cumulus shader
// ---------------------------------------------------------------------------

/**
 * View-space billboarding with a per-instance roll. Position/scale ride in
 * `instanceMatrix`; three declares that attribute for any ShaderMaterial on an
 * InstancedMesh. `instanceColor` smuggles three per-instance scalars: an
 * animation phase, the atlas cell, and the roll angle.
 */
const SPRITE_VERT = /* glsl */ `
uniform float uTime;

varying vec2 vUv;
varying float vCell;
varying vec3 vCenter;
varying float vFade;

void main() {
  vUv = uv;
  float phase = instanceColor.r * 6.2831853;
  vCell = floor(instanceColor.g * 3.0 + 0.5);
  float roll = (instanceColor.b - 0.5) * 0.55;

  vec3 center = instanceMatrix[3].xyz;
  vec2 scl = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
  // Slow breathing. A cloud deck that is perfectly static reads as a painting
  // the moment you stand still, and this is two ALU ops.
  scl *= 1.0 + 0.035 * sin(uTime * 0.06 + phase);

  float cr = cos(roll);
  float sr = sin(roll);
  vec2 local = vec2(position.x * cr - position.y * sr, position.x * sr + position.y * cr);

  vCenter = center;
  vec4 mv = modelViewMatrix * vec4(center, 1.0);
  mv.xy += local * scl;

  // Fade out anything the camera is about to fly through — a billboard that
  // intersects the near plane pops a hard-edged rectangle across the screen.
  vFade = smoothstep(90.0, 320.0, -mv.z);

  gl_Position = projectionMatrix * mv;
}
`;

const SPRITE_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uAtlas;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uHorizon;
uniform float uOpacity;

varying vec2 vUv;
varying float vCell;
varying vec3 vCenter;
varying float vFade;

void main() {
  // 2×2 atlas, inset so the mip chain cannot bleed a neighbour's cloud in.
  vec2 idx = vec2(mod(vCell, 2.0), floor(vCell * 0.5));
  vec2 uvi = mix(vec2(0.014), vec2(0.986), vUv);
  vec4 tex = texture2D(uAtlas, (idx + uvi) * 0.5);

  float density = tex.a;
  if (density < 0.004) discard;

  // The billboard's basis in world space is the camera's, read straight out of
  // the view matrix rows. Rebuilding the impostor normal against it is what
  // makes a flat quad hold a moving terminator.
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 fwd   = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec3 nl = vec3(tex.rg * 2.0 - 1.0, tex.b);
  vec3 n = normalize(nl.x * right + nl.y * up + nl.z * fwd);

  vec3 viewDir = normalize(vCenter - cameraPosition);

  // Wrapped diffuse. Cloud is so forward-scattering that light bleeds well past
  // the geometric terminator; a hard N·L makes a billboard look like a rock.
  float ndl = dot(n, uSunDir);
  float wrap = clamp((ndl + 0.5) / 1.5, 0.0, 1.0);
  float upness = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);

  // Thin fringes transmit; the dense core does not.
  float powder = 1.0 + 0.75 * (1.0 - density);
  vec3 col = uAmbient * mix(0.48, 1.0, upness);
  col += uSunColor * pow(wrap, 1.3) * powder * mix(0.30, 1.0, upness) * 0.85;

  // Silver lining: looking through a thin edge toward the sun.
  float towardSun = max(dot(viewDir, uSunDir), 0.0);
  col += uSunColor * pow(towardSun, 7.0) * (1.0 - density) * 0.55;

  // Sit in the same haze the terrain does.
  float dist = length(vCenter - cameraPosition);
  col = mix(col, uHorizon, clamp(dist / 14000.0, 0.0, 0.55));

  gl_FragColor = vec4(col, density * uOpacity * vFade);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// CPU mirror of the scattering model
// ---------------------------------------------------------------------------

const cpuBetaR: [number, number, number] = [0, 0, 0];
const cpuBetaM: [number, number, number] = [0, 0, 0];
const cpuOut: [number, number, number] = [0, 0, 0];

/**
 * Evaluates the same radiance the dome shader does, for one view direction.
 * Only the zenith angle and the angle to the sun matter, so the caller passes
 * scalars. Returns graded linear RGB (no sun disc, no night term).
 */
function skyRadiance(
  dirY: number,
  cosTheta: number,
  sunUp: number,
  turbidity: number,
): [number, number, number] {
  const sunE =
    SUN_EE *
    Math.max(
      0,
      1 -
        Math.exp(
          -((CUTOFF_ANGLE - Math.acos(THREE.MathUtils.clamp(sunUp, -1, 1))) / STEEPNESS),
        ),
    );
  const sunfade = 1 - THREE.MathUtils.clamp(1 - Math.exp(sunUp * 0.889), 0, 1);
  const rc = Math.max(0.05, ATMOSPHERE.rayleigh - (1 - sunfade));

  const mieBase = 0.434 * (0.2 * turbidity) * ATMOSPHERE.mieCoefficient;
  for (let i = 0; i < 3; i++) {
    cpuBetaR[i] = TOTAL_RAYLEIGH[i] * rc;
    cpuBetaM[i] = MIE_SCALED[i] * mieBase;
  }

  const zenithAngle = Math.acos(Math.max(0, dirY));
  const denom =
    Math.cos(zenithAngle) +
    0.15 * Math.pow(Math.max(1e-3, 93.885 - (zenithAngle * 180) / Math.PI), -1.253);
  const sR = RAYLEIGH_ZENITH / denom;
  const sM = MIE_ZENITH / denom;

  const rPhaseArg = cosTheta * 0.5 + 0.5;
  const rPhase = THREE_OVER_SIXTEENPI * (1 + rPhaseArg * rPhaseArg);
  const g2 = ATMOSPHERE.mieG * ATMOSPHERE.mieG;
  const mPhase =
    ONE_OVER_FOURPI *
    ((1 - g2) / Math.pow(Math.max(1e-4, 1 - 2 * ATMOSPHERE.mieG * cosTheta + g2), 1.5));

  const floorTerm = [0, 0.0003, 0.00075];
  const gamma = 1 / (1.2 + 1.2 * sunfade);
  const inScatterMix = THREE.MathUtils.clamp(Math.pow(Math.max(0, 1 - sunUp), 5), 0, 1);

  for (let i = 0; i < 3; i++) {
    const Fex = Math.exp(-(cpuBetaR[i] * sR + cpuBetaM[i] * sM));
    const betaTheta = cpuBetaR[i] * rPhase + cpuBetaM[i] * mPhase;
    const ratio = betaTheta / (cpuBetaR[i] + cpuBetaM[i]);
    let Lin = Math.pow(Math.max(0, sunE * ratio * (1 - Fex)), 1.5);
    const horizonTerm = Math.pow(Math.max(0, sunE * ratio * Fex), 0.5);
    Lin *= 1 + (horizonTerm - 1) * inScatterMix;
    const tex = (Lin + 0.1 * Fex) * 0.04 + floorTerm[i];
    cpuOut[i] = Math.pow(Math.max(0, tex), gamma) * SKY_BOOST;
  }

  // Same grade the dome applies, so fog can never describe a different sky.
  const upness = THREE.MathUtils.clamp(
    THREE.MathUtils.smoothstep(Math.max(0, dirY), 0, 0.55),
    0,
    1,
  );
  const lum = cpuOut[0] * 0.2126 + cpuOut[1] * 0.7152 + cpuOut[2] * 0.0722;
  for (let i = 0; i < 3; i++) {
    const sat = lum + (cpuOut[i] - lum) * GRADE.saturation;
    const tint = GRADE.horizonTint[i] + (GRADE.zenithTint[i] - GRADE.horizonTint[i]) * upness;
    cpuOut[i] = Math.max(0, sat * tint);
  }
  return cpuOut;
}

/**
 * Planckian locus, Tanner Helland's piecewise fit, normalised so the brightest
 * channel is 1. The sun's *apparent* colour temperature is not 5778 K at
 * ground level — atmospheric extinction strips the short wavelengths first, so
 * a horizon sun measures near 2000 K and only reaches ~6000 K well up. Driving
 * the key light off this rather than a hand-picked ramp is what keeps the
 * warm/cool relationship honest at every time of day.
 */
function blackbody(kelvin: number, out: THREE.Color): THREE.Color {
  const t = THREE.MathUtils.clamp(kelvin, 1000, 20000) / 100;
  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;

  r = THREE.MathUtils.clamp(r, 0, 255);
  g = THREE.MathUtils.clamp(g, 0, 255);
  b = THREE.MathUtils.clamp(b, 0, 255);
  const m = Math.max(r, g, b) || 1;
  return out.setRGB(r / m, g / m, b / m);
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

const createSky: SystemFactory = (ctx) => {
  const quality = ctx.quality;
  const cascades = CASCADE_TIERS[quality] ?? CASCADE_TIERS.high;
  const cloudTier = CLOUD_TIERS[quality] ?? CLOUD_TIERS.high;
  const shadowSize = Math.max(512, ctx.shadowMapSize || 2048);

  // -------------------------------------------------------------- service
  // Published first, before any of the expensive generation below, so a system
  // that boots later can always find it even if a texture build throws.
  const sunDir = new THREE.Vector3(0, 1, 0);
  const moonDir = new THREE.Vector3(0, -1, 0);
  const zenithColor = new THREE.Color(0.25, 0.45, 0.85);
  const horizonColor = new THREE.Color(0.75, 0.78, 0.8);
  const sunScreen = new THREE.Vector2(0.5, 0.5);

  const key = new THREE.DirectionalLight(0xffffff, 3.6);

  const service: DropZeroSkyService = {
    time: DEFAULT_TIME,
    sunDirection: sunDir,
    sunColor: new THREE.Color(1, 0.92, 0.82),
    daylight: 1,
    sun: key,
    sunScreen,
    sunOnScreen: false,
    shaftStrength: 0,
    horizonColor,
    zenithColor,
    timeScale: DEFAULT_TIME_SCALE,
    setTime(t: number) {
      applyTime(t);
      // Instant, not lerped: a screenshot harness poses the light and expects
      // the very next frame to be correct, environment map included.
      refreshEnvironment();
    },
    focus(point: THREE.Vector3) {
      focusPoint.copy(point);
      focusValid = true;
    },
  };
  ctx.services.sky = service;

  // -------------------------------------------------------------- textures
  const noise = buildNoiseTexture(ctx.rng, quality === "low" ? 128 : 256);
  try {
    noise.anisotropy = Math.min(4, ctx.renderer.capabilities.getMaxAnisotropy());
  } catch {
    /* headless or stub renderer — the default of 1 is fine. */
  }

  let atlas: THREE.CanvasTexture | null = null;
  try {
    atlas = buildCloudAtlas(ctx.rng, quality === "low" ? 256 : 512);
  } catch (err) {
    console.warn("[Drop Zero] cloud atlas generation failed; sky runs without billboards", err);
  }

  // -------------------------------------------------------------- sky dome
  const skyUniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uTurbidity: { value: ATMOSPHERE.turbidity },
    uRayleigh: { value: ATMOSPHERE.rayleigh },
    uMieCoefficient: { value: ATMOSPHERE.mieCoefficient },
    uMieG: { value: ATMOSPHERE.mieG },
    uSkyBoost: { value: SKY_BOOST },
    uSunTint: { value: new THREE.Color(1, 1, 1) },
    uSunRadius: { value: SUN_ANGULAR_RADIUS },
    uNight: { value: 0 },
    uNightZenith: { value: new THREE.Color().setRGB(0.005, 0.011, 0.032) },
    uNightHorizon: { value: new THREE.Color().setRGB(0.026, 0.042, 0.076) },
    uMoonRadius: { value: 0.021 },
    uMoonCos: { value: Math.cos(0.0235) },
    uTime: { value: 0 },
    uNoise: { value: noise },
    uCamXZ: { value: new THREE.Vector2() },
    uCamY: { value: 0 },
    uCloudSun: { value: new THREE.Color(1, 0.9, 0.78) },
    uCloudAmbient: { value: new THREE.Color(0.35, 0.46, 0.66) },
    uHorizonColor: { value: new THREE.Color(0.72, 0.76, 0.8) },
    uCover: { value: 0.5 },
    uCloudOpacity: { value: 0.95 },
    uCirrusAmount: { value: 0.4 },
    uWind: { value: 0 },
  };

  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: SKY_VERT,
    fragmentShader: buildSkyFragment(cloudTier),
    side: THREE.BackSide,
    depthWrite: false,
    // Depth-TESTED and drawn LAST of the opaque queue, not first. The cloud
    // march is by far the most expensive shader in the frame; running it only
    // on pixels the island did not already cover is most of the sky's cost back
    // when you are stood inside a POI. `clip.z = clip.w` puts every fragment at
    // depth 1.0, which passes LessEqual against a cleared buffer and fails
    // against anything real. `scene.background` is kept in sync with the horizon
    // radiance so that if this ever stops passing, the failure is a flat sky —
    // not a black screen.
    depthTest: true,
    fog: false,
    toneMapped: true,
  });

  const skyGeometry = new THREE.SphereGeometry(
    1,
    cloudTier.domeSegments,
    Math.max(12, cloudTier.domeSegments >> 1),
  );
  const skyMesh = new THREE.Mesh(skyGeometry, skyMaterial);
  skyMesh.name = "dz:sky";
  skyMesh.scale.setScalar(6000);
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = 1000;
  ctx.scene.add(skyMesh);

  // ------------------------------------------------------- cloud billboards
  const spriteUniforms = {
    uAtlas: { value: atlas },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 0.9, 0.78) },
    uAmbient: { value: new THREE.Color(0.35, 0.46, 0.66) },
    uHorizon: { value: new THREE.Color(0.72, 0.76, 0.8) },
    uOpacity: { value: 0.95 },
    uTime: { value: 0 },
  };

  let spriteMaterial: THREE.ShaderMaterial | null = null;
  let spriteGeometry: THREE.PlaneGeometry | null = null;
  let sprites: THREE.InstancedMesh | null = null;

  interface SpriteDef {
    pos: THREE.Vector3;
    sx: number;
    sy: number;
    phase: number;
    cellV: number;
    roll: number;
  }
  const spriteDefs: SpriteDef[] = [];
  const spriteOrder: number[] = [];

  if (atlas && cloudTier.sprites > 0) {
    spriteMaterial = new THREE.ShaderMaterial({
      uniforms: spriteUniforms,
      vertexShader: SPRITE_VERT,
      fragmentShader: SPRITE_FRAG,
      transparent: true,
      depthWrite: false,
      // Depth-tested against the world: a ridgeline in front of a cloud must
      // occlude it, and it costs nothing.
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: true,
    });
    spriteGeometry = new THREE.PlaneGeometry(1, 1);
    sprites = new THREE.InstancedMesh(spriteGeometry, spriteMaterial, cloudTier.sprites);
    sprites.name = "dz:cloud-sprites";
    // The quad is billboarded in the vertex shader, so the bounds three would
    // compute describe a 1×1 plane at the origin and would cull the whole deck
    // the moment you walked away from world zero.
    sprites.frustumCulled = false;
    // First of the transparent queue. They are the furthest transparent thing
    // in the world by a wide margin, and every tracer, muzzle flash and water
    // surface has to composite on top of them.
    sprites.renderOrder = -100;

    // Scattered across ±7 km — well past the 3 km island, so the deck still
    // reaches the horizon and you never run out from under it. Rejection
    // sampling for separation, because two overlapping billboards composite in
    // whatever order the instance buffer happens to be in.
    const MIN_SEP = 900;
    let guard = 0;
    while (spriteDefs.length < cloudTier.sprites && guard < cloudTier.sprites * 60) {
      guard++;
      const x = (ctx.rng() - 0.5) * 14000;
      const z = (ctx.rng() - 0.5) * 14000;
      const y = 620 + ctx.rng() * 780;
      let ok = true;
      for (const d of spriteDefs) {
        const dx = d.pos.x - x;
        const dz = d.pos.z - z;
        if (dx * dx + dz * dz < MIN_SEP * MIN_SEP) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const sx = 700 + ctx.rng() * 900;
      spriteDefs.push({
        pos: new THREE.Vector3(x, y, z),
        sx,
        // Cumulus is wider than it is tall; 0.55–0.72 is the ratio that reads.
        sy: sx * (0.55 + ctx.rng() * 0.17),
        phase: ctx.rng(),
        cellV: Math.floor(ctx.rng() * 4) / 3,
        roll: ctx.rng(),
      });
    }

    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();
    for (let i = 0; i < spriteDefs.length; i++) {
      const d = spriteDefs[i];
      dummy.position.copy(d.pos);
      dummy.scale.set(d.sx, d.sy, 1);
      dummy.updateMatrix();
      sprites.setMatrixAt(i, dummy.matrix);
      tint.setRGB(d.phase, d.cellV, d.roll);
      sprites.setColorAt(i, tint);
      spriteOrder.push(i);
    }
    sprites.count = spriteDefs.length;
    sprites.instanceMatrix.needsUpdate = true;
    if (sprites.instanceColor) sprites.instanceColor.needsUpdate = true;
    ctx.scene.add(sprites);
  }

  // ---------------------------------------------------------------- lights
  key.castShadow = true;
  key.shadow.mapSize.set(shadowSize, shadowSize);
  key.name = "dz:sun";

  /** How far up the sun light sits from its focus. Must clear the tallest POI. */
  const KEY_DISTANCE = 2200;
  const shadowCam = key.shadow.camera;

  /**
   * A cool, non-shadowing rim from roughly the anti-sun bearing. Real skylight
   * wraps all the way around a subject; a hemisphere light alone puts a flat
   * value on every shadowed face and everything reads as cardboard. This is a
   * cheap stand-in for that wrap and it is worth its one draw of cost.
   */
  const fill = new THREE.DirectionalLight(0x9fc6ff, 0.55);
  fill.castShadow = false;

  const hemi = new THREE.HemisphereLight(0x8fb8ff, 0x574434, 0.5);

  ctx.scene.add(key, key.target, fill, fill.target, hemi);

  // ------------------------------------------------------------ environment
  // A miniature copy of the dome rendered to a PMREM cubemap. Without this,
  // every MeshStandardMaterial on the island has no specular horizon and no sky
  // bounce, and the whole world reads as plastic no matter how good the albedo.
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(skyGeometry, skyMaterial);
  envSky.scale.setScalar(30);
  envSky.frustumCulled = false;
  envScene.add(envSky);

  let pmrem: THREE.PMREMGenerator | null = null;
  let envTarget: THREE.WebGLRenderTarget | null = null;
  /** Whatever `materials` may have parked here; restored on teardown. */
  const priorEnvironment = ctx.scene.environment;

  try {
    pmrem = new THREE.PMREMGenerator(ctx.renderer);
    pmrem.compileEquirectangularShader();
  } catch {
    pmrem = null;
  }

  function refreshEnvironment(): void {
    if (!pmrem) return;
    try {
      const next = pmrem.fromScene(envScene, 0, 1, 200);
      // Swap before disposing so the scene is never briefly un-lit.
      ctx.scene.environment = next.texture;
      envTarget?.dispose();
      envTarget = next;
    } catch {
      // Context loss or a stub renderer — keep whatever we had and stop trying.
      pmrem = null;
    }
  }

  // ------------------------------------------------------------------- fog
  const fog = new THREE.FogExp2(0xa8c8dc, FOG_DENSITY_DAY);
  const priorFog = ctx.scene.fog;
  ctx.scene.fog = fog;
  const background = new THREE.Color(0x8fc4e8);
  const priorBackground = ctx.scene.background;
  ctx.scene.background = background;

  // ------------------------------------------------------------ time of day
  const UP_AXIS = new THREE.Vector3(0, 1, 0);
  const EAST_AXIS = new THREE.Vector3(1, 0, 0);
  const NIGHT_HORIZON = new THREE.Color().setRGB(0.028, 0.044, 0.078);
  const NIGHT_ZENITH = new THREE.Color().setRGB(0.007, 0.013, 0.032);

  const keyDirection = new THREE.Vector3(0, 1, 0);
  const ambientColor = new THREE.Color();
  const lightColor = new THREE.Color();
  const horizonSample = new THREE.Vector3();
  const azimuth = new THREE.Vector3();
  const scratch = new THREE.Color();

  /**
   * Horizon radiance, averaged over four bearings and weighted toward the sun
   * and anti-sun — those are where the eye actually looks and where the haze is
   * most strongly coloured.
   */
  function computeHorizon(out: THREE.Color, turbidity: number): void {
    const weights = [0.32, 0.18, 0.32, 0.18];
    let r = 0;
    let g = 0;
    let b = 0;
    azimuth.set(sunDir.x, 0, sunDir.z);
    if (azimuth.lengthSq() < 1e-6) azimuth.set(1, 0, 0);
    azimuth.normalize();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      horizonSample
        .set(azimuth.x * cs - azimuth.z * sn, 0.035, azimuth.x * sn + azimuth.z * cs)
        .normalize();
      const c = skyRadiance(horizonSample.y, horizonSample.dot(sunDir), sunDir.y, turbidity);
      r += c[0] * weights[i];
      g += c[1] * weights[i];
      b += c[2] * weights[i];
    }
    out.setRGB(Math.min(r, 3), Math.min(g, 3), Math.min(b, 3));
  }

  /** Turbidity currently in force. Shared by the dome and every CPU sample. */
  let liveTurbidity = ATMOSPHERE.turbidity;
  let night = 0;

  /** Recomputes every derived quantity for a normalised time of day. */
  function applyTime(t: number): void {
    const time = t - Math.floor(t);
    service.time = time;

    // Rises due east at 0.25, sets due west at 0.75; the arc leans south.
    const a = (time - 0.25) * Math.PI * 2;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    sunDir.set(cosA, sinA * Math.cos(SUN_ARC_TILT), sinA * Math.sin(SUN_ARC_TILT)).normalize();

    // The moon rides roughly opposite the sun, rolled off the anti-solar point
    // so it shows a gibbous phase instead of a flat full disc.
    moonDir.copy(sunDir).negate();
    moonDir.applyAxisAngle(UP_AXIS, 0.44);
    moonDir.applyAxisAngle(EAST_AXIS, 0.16);
    moonDir.normalize();

    const y = sunDir.y;
    const daylight = THREE.MathUtils.clamp(THREE.MathUtils.smoothstep(y, -0.08, 0.2), 0, 1);
    night = 1 - THREE.MathUtils.clamp(THREE.MathUtils.smoothstep(y, -0.16, 0.03), 0, 1);
    service.daylight = daylight;

    // Apparent colour temperature of the disc: ~1900 K on the horizon through
    // ~6100 K well up. The exponent biases the ramp low so the golden hour
    // stays golden rather than snapping to white the moment the sun clears.
    const warmth = THREE.MathUtils.clamp(THREE.MathUtils.smoothstep(y, -0.06, 0.62), 0, 1);
    blackbody(1900 + 4200 * Math.pow(warmth, 0.85), service.sunColor);
    // Pull 10% toward white: a fully saturated key reads as a bug, not a sunset.
    service.sunColor.lerp(scratch.setRGB(1, 1, 1), 0.1);

    // The air thickens as the sun drops — more aerosol, longer path. Whatever
    // is chosen here goes to the dome AND to every CPU sample below.
    liveTurbidity = ATMOSPHERE.turbidity + (1 - daylight) * 2.8;

    skyUniforms.uSunDir.value.copy(sunDir);
    skyUniforms.uMoonDir.value.copy(moonDir);
    skyUniforms.uNight.value = night;
    skyUniforms.uTurbidity.value = liveTurbidity;
    skyUniforms.uSunTint.value.copy(service.sunColor);

    const zen = skyRadiance(1, y, y, liveTurbidity);
    zenithColor.setRGB(zen[0], zen[1], zen[2]);
    computeHorizon(horizonColor, liveTurbidity);
    if (night > 0) {
      horizonColor.lerp(NIGHT_HORIZON, night);
      zenithColor.lerp(NIGHT_ZENITH, night);
    }

    background.copy(horizonColor);

    // ---- Key light ---------------------------------------------------------
    // Intensity climbs with elevation but never falls to nothing while the disc
    // is up: a 4° sun still throws a hard, long shadow, and losing it is what
    // makes most web sunsets look like someone turned the lights off.
    const sunIntensity =
      THREE.MathUtils.clamp(THREE.MathUtils.smoothstep(y, -0.05, 0.14), 0, 1) *
      (2.9 + 2.1 * Math.max(0, y));
    const moonIntensity =
      0.28 *
      night *
      THREE.MathUtils.clamp(THREE.MathUtils.smoothstep(moonDir.y, -0.04, 0.12), 0, 1);

    if (sunIntensity >= moonIntensity) {
      keyDirection.copy(sunDir);
      lightColor.copy(service.sunColor);
      key.intensity = sunIntensity;
    } else {
      keyDirection.copy(moonDir);
      lightColor.copy(MOON_TINT);
      key.intensity = moonIntensity;
    }
    key.color.copy(lightColor);
    key.visible = key.intensity > 0.002;

    // ---- Ambient -----------------------------------------------------------
    // scene.environment carries the IBL for standard materials; the hemisphere
    // exists for everything else (Lambert props, particles, foliage) and is
    // deliberately weak so the two do not double-count into a washed-out image.
    ambientColor.copy(zenithColor).lerp(horizonColor, 0.32);
    hemi.color.copy(ambientColor).multiplyScalar(1.45);
    hemi.groundColor.copy(HEMI_GROUND).multiplyScalar(0.22 + 0.78 * daylight);
    hemi.intensity = 0.14 + 0.42 * daylight;

    // The rim sits opposite the sun on the ground plane and slightly above it,
    // tinted with the sky rather than the sun. It is what puts an edge on a
    // shadowed wall.
    fill.color.copy(zenithColor).lerp(scratch.setRGB(0.62, 0.76, 1.0), 0.55);
    fill.intensity = 0.18 + 0.5 * daylight;

    // ---- Clouds ------------------------------------------------------------
    // The deck is lit by the key, but never goes fully black at night: high
    // cloud catches light long after the ground has lost it.
    const cloudLight = Math.max(sunIntensity, moonIntensity * 1.8) * 0.34 + 0.05;
    skyUniforms.uCloudSun.value.copy(lightColor).multiplyScalar(cloudLight);
    skyUniforms.uCloudAmbient.value.copy(ambientColor).multiplyScalar(0.95);
    skyUniforms.uHorizonColor.value.copy(horizonColor);
    // Higher uCover = LESS sky covered. Trade-wind cumulus builds through the
    // afternoon and thins overnight, so the minimum lands around t = 0.62.
    skyUniforms.uCover.value = 0.55 + 0.07 * Math.cos((time - 0.62) * Math.PI * 2);
    skyUniforms.uCirrusAmount.value = 0.3 + 0.22 * daylight;

    spriteUniforms.uSunDir.value.copy(keyDirection);
    spriteUniforms.uSunColor.value.copy(lightColor).multiplyScalar(
      Math.max(sunIntensity, moonIntensity * 1.8) * 0.42 + 0.06,
    );
    spriteUniforms.uAmbient.value.copy(ambientColor).multiplyScalar(1.05);
    spriteUniforms.uHorizon.value.copy(horizonColor);
  }

  // ------------------------------------------------------- shadow cascade
  const focusPoint = new THREE.Vector3();
  let focusValid = false;
  let cascadeIndex = 0;
  let cascadeTexel = (cascades[0].radius * 2) / shadowSize;

  const shadowCenter = new THREE.Vector3();
  const shadowBasis = new THREE.Matrix4();
  const shadowQuat = new THREE.Quaternion();
  const shadowQuatInv = new THREE.Quaternion();
  const tmpVec = new THREE.Vector3();
  const camForward = new THREE.Vector3();

  /**
   * Applies a cascade's ortho extents. Called only when the cascade actually
   * changes — `updateProjectionMatrix` invalidates the shadow matrix and three
   * re-uploads it, and there is no reason to pay that every frame.
   */
  function applyCascade(index: number): void {
    cascadeIndex = index;
    const c = cascades[index];
    shadowCam.left = -c.radius;
    shadowCam.right = c.radius;
    shadowCam.top = c.radius;
    shadowCam.bottom = -c.radius;
    shadowCam.near = Math.max(1, KEY_DISTANCE - c.radius - 700);
    // Deep enough that a 200 m tower still projects onto the ground at a 10° sun.
    shadowCam.far = KEY_DISTANCE + c.radius * 2.2 + 1200;
    shadowCam.updateProjectionMatrix();

    cascadeTexel = (c.radius * 2) / shadowSize;

    // Bias, landed by walking a POI at a 15° sun and looking at the contact
    // shadow under a wall:
    //  - normalBias is in WORLD units and does the heavy lifting. 1.7 texels is
    //    the smallest value that kills acne on a 45° roof at every cascade.
    //  - depth bias then only has to cover the flat cases, so it can stay tiny
    //    and peter-panning never appears. -0.32 m expressed in the shadow
    //    camera's normalised depth range.
    key.shadow.normalBias = THREE.MathUtils.clamp(cascadeTexel * 1.7, 0.03, 1.1);
    key.shadow.bias = -0.32 / (shadowCam.far - shadowCam.near);
  }

  /**
   * Cascade selection. Framing, not distance splitting: on foot you want the
   * tightest possible map around your feet, and from the bus at 600 m you want
   * one that covers the whole POI you are falling toward. Hysteresis on the
   * thresholds so a jump or a ramp cannot make the whole map flicker between
   * two resolutions.
   */
  function pickCascade(altitude: number): number {
    const current = cascadeIndex;
    let next = 0;
    for (let i = cascades.length - 1; i >= 0; i--) {
      if (altitude >= cascades[i].altitude) {
        next = i;
        break;
      }
    }
    if (next === current) return current;
    // 25% dead band around whichever threshold we are crossing.
    if (next > current) {
      if (altitude < cascades[next].altitude * 1.25) return current;
    } else {
      if (altitude > cascades[current].altitude * 0.75) return current;
    }
    return next;
  }

  /**
   * Parks the cascade around the focus point, pushed forward along the view so
   * most of its area lands in front of the camera rather than behind it, then
   * snaps the centre to whole shadow texels in light space. Without the snap
   * the map re-rasterises on a sub-texel grid every frame and every shadow edge
   * crawls as you walk — the single most obvious "web game" tell there is.
   */
  function updateShadowFrustum(): void {
    const player = ctx.services.player;
    const anchor = focusValid ? focusPoint : (player?.position ?? ctx.camera.position);

    // Ground height under the anchor, so the frustum hugs the terrain rather
    // than the camera's altitude. Terrain may not have booted — fall back to 0.
    const terrain = ctx.services.terrain;
    const groundY = terrain ? terrain.heightAt(anchor.x, anchor.z) : 0;
    const altitude = Math.max(0, ctx.camera.position.y - groundY);

    const wanted = pickCascade(altitude);
    if (wanted !== cascadeIndex) applyCascade(wanted);
    const c = cascades[cascadeIndex];

    ctx.camera.getWorldDirection(camForward);
    camForward.y = 0;
    if (camForward.lengthSq() > 1e-6) camForward.normalize();
    else camForward.set(0, 0, -1);

    shadowCenter.copy(anchor).addScaledVector(camForward, c.radius * c.lead);
    // Keep the centre near the ground: half the ortho depth is wasted otherwise
    // when the player is on a build tower.
    shadowCenter.y = groundY + Math.min(altitude, c.radius * 0.5);

    // Light-space basis, built exactly the way DirectionalLightShadow builds
    // it, so the snap grid IS the shadow map's own texel grid.
    tmpVec.copy(shadowCenter).add(keyDirection);
    shadowBasis.lookAt(tmpVec, shadowCenter, UP_AXIS);
    shadowQuat.setFromRotationMatrix(shadowBasis);
    shadowQuatInv.copy(shadowQuat).invert();

    tmpVec.copy(shadowCenter).applyQuaternion(shadowQuatInv);
    tmpVec.x = Math.round(tmpVec.x / cascadeTexel) * cascadeTexel;
    tmpVec.y = Math.round(tmpVec.y / cascadeTexel) * cascadeTexel;
    tmpVec.applyQuaternion(shadowQuat);
    shadowCenter.copy(tmpVec);

    key.position.copy(shadowCenter).addScaledVector(keyDirection, KEY_DISTANCE);
    key.target.position.copy(shadowCenter);
    key.target.updateMatrixWorld();

    // The rim sits opposite the key on the ground plane, lifted 25° so it
    // reaches under eaves and overhangs instead of raking along the floor.
    fill.position.set(
      shadowCenter.x - keyDirection.x * 900,
      shadowCenter.y + 420,
      shadowCenter.z - keyDirection.z * 900,
    );
    fill.target.position.copy(shadowCenter);
    fill.target.updateMatrixWorld();

    // Consumed — the next frame must ask again, so a spectate cam handing back
    // control does not leave the cascade stranded on a dead player.
    focusValid = false;
  }

  // -------------------------------------------------------------- aerial fog
  const viewDir = new THREE.Vector3();
  const fogTarget = new THREE.Color();

  /**
   * Aerial perspective. `FogExp2` has exactly one colour, so the trick is to
   * re-derive that colour every frame from the sky radiance along the *camera's
   * own view direction*: turn toward the sun and the distant treeline tints
   * gold, turn away and it tints blue. It is one CPU evaluation of the same
   * scattering model the dome runs, and it is the biggest single "this is a
   * real landscape" cue in the whole world.
   */
  function updateFog(dt: number): void {
    ctx.camera.getWorldDirection(viewDir);
    // Sample a little above the true view ray: distant terrain sits near the
    // horizon, and sampling straight down a ground-facing camera would grab a
    // patch of sky that has nothing to do with the haze in front of you.
    const sampleY = THREE.MathUtils.clamp(viewDir.y * 0.35 + 0.05, 0.015, 0.5);
    const len = Math.hypot(viewDir.x, viewDir.z) || 1;
    const nx = (viewDir.x / len) * Math.sqrt(Math.max(0, 1 - sampleY * sampleY));
    const nz = (viewDir.z / len) * Math.sqrt(Math.max(0, 1 - sampleY * sampleY));
    const cosSun = nx * sunDir.x + sampleY * sunDir.y + nz * sunDir.z;

    const c = skyRadiance(sampleY, cosSun, sunDir.y, liveTurbidity);
    fogTarget.setRGB(Math.min(c[0], 3), Math.min(c[1], 3), Math.min(c[2], 3));
    if (night > 0) fogTarget.lerp(NIGHT_HORIZON, night);
    // Pull a third of the way back toward the omnidirectional horizon so a fast
    // spin does not swing the whole world's colour. Directional, but damped.
    fogTarget.lerp(horizonColor, 0.34);

    // Temporal smoothing on top. 6 Hz: fast enough to keep up with a turn,
    // slow enough that it never reads as a colour pop.
    const k = 1 - Math.exp(-dt * 6);
    fog.color.lerp(fogTarget, k);

    // Low sun means a long path through the aerosol layer: thicker haze, and
    // the golden-hour depth cue that comes with it.
    const lowSun = 1 - THREE.MathUtils.clamp(THREE.MathUtils.smoothstep(sunDir.y, 0.05, 0.45), 0, 1);
    fog.density = FOG_DENSITY_DAY + FOG_DENSITY_LOW_SUN * lowSun;
  }

  // ------------------------------------------------------ sun screen position
  const sunWorld = new THREE.Vector3();
  const sunEvent: SunScreenEvent = { x: 0.5, y: 0.5, visible: false, strength: 0, daylight: 1 };

  function updateSunScreen(): void {
    // Far enough out that the projection is indistinguishable from a direction,
    // close enough to stay inside the camera's far plane.
    sunWorld.copy(ctx.camera.position).addScaledVector(sunDir, 6000);
    sunWorld.project(ctx.camera);
    sunScreen.set(sunWorld.x * 0.5 + 0.5, sunWorld.y * 0.5 + 0.5);

    ctx.camera.getWorldDirection(viewDir);
    const facing = viewDir.dot(sunDir);
    const onScreen =
      facing > 0 &&
      sunWorld.z < 1 &&
      sunScreen.x > -0.35 &&
      sunScreen.x < 1.35 &&
      sunScreen.y > -0.35 &&
      sunScreen.y < 1.35;

    // Shafts want to fade out when the sun is off-axis, below the horizon or
    // just about to leave the frame — otherwise the pass pops.
    const offAxis = Math.max(Math.abs(sunScreen.x - 0.5), Math.abs(sunScreen.y - 0.5));
    const edge = THREE.MathUtils.clamp(1 - offAxis * 1.4, 0, 1);
    const above = THREE.MathUtils.clamp(THREE.MathUtils.smoothstep(sunDir.y, -0.02, 0.16), 0, 1);
    const strength = onScreen ? edge * above * Math.pow(Math.max(facing, 0), 1.5) : 0;

    service.sunOnScreen = onScreen;
    service.shaftStrength = strength;

    sunEvent.x = sunScreen.x;
    sunEvent.y = sunScreen.y;
    sunEvent.visible = onScreen;
    sunEvent.strength = strength;
    sunEvent.daylight = service.daylight;
    ctx.emit("dz:sun", sunEvent);
  }

  // ------------------------------------------------------------- sprite sort
  const sortMatrix = new THREE.Matrix4();
  const sortColor = new THREE.Color();
  const sortPos = new THREE.Vector3();

  /**
   * Transparent instances cannot be sorted by the renderer — it sees one
   * object. With only a few dozen billboards, re-writing the instance buffers
   * back-to-front is cheaper than the artefact of getting it wrong (a near
   * cloud punching a hole in a far one).
   */
  function sortSprites(): void {
    if (!sprites || spriteDefs.length < 2) return;
    const cam = ctx.camera.position;
    spriteOrder.sort((a, b) => {
      const da = spriteDefs[a].pos.distanceToSquared(cam);
      const db = spriteDefs[b].pos.distanceToSquared(cam);
      return db - da;
    });
    for (let i = 0; i < spriteOrder.length; i++) {
      const d = spriteDefs[spriteOrder[i]];
      sortPos.copy(d.pos);
      sortMatrix.makeScale(d.sx, d.sy, 1);
      sortMatrix.setPosition(sortPos);
      sprites.setMatrixAt(i, sortMatrix);
      sortColor.setRGB(d.phase, d.cellV, d.roll);
      sprites.setColorAt(i, sortColor);
    }
    sprites.instanceMatrix.needsUpdate = true;
    if (sprites.instanceColor) sprites.instanceColor.needsUpdate = true;
  }

  // -------------------------------------------------------------------- boot
  applyCascade(0);
  applyTime(DEFAULT_TIME);
  updateShadowFrustum();
  fog.color.copy(horizonColor);
  refreshEnvironment();

  let envAge = 0;
  let envTime = service.time;
  let sortAge = 0;
  let windDistance = 0;

  const offSetTime = ctx.on("dz:setTime", (payload) => {
    const t = typeof payload === "number" ? payload : (payload as { time?: number })?.time;
    if (typeof t === "number" && Number.isFinite(t)) service.setTime(t);
  });
  const offTimeScale = ctx.on("dz:timeScale", (payload) => {
    const s = typeof payload === "number" ? payload : (payload as { scale?: number })?.scale;
    if (typeof s === "number" && Number.isFinite(s)) service.timeScale = s;
  });

  const sys: System = {
    name: "sky",

    update(dt) {
      if (service.timeScale > 0) applyTime(service.time + dt / service.timeScale);
      envAge += dt;
      sortAge += dt;
      // Wind is integrated rather than derived from elapsed time, so changing
      // the wind speed never teleports the deck.
      windDistance += dt * CLOUD_WIND;
    },

    lateUpdate(dt, c) {
      const cam = c.camera;

      // The dome rides the camera so it stays at optical infinity.
      skyMesh.position.copy(cam.position);

      skyUniforms.uTime.value = c.elapsed;
      skyUniforms.uWind.value = windDistance;
      skyUniforms.uCamXZ.value.set(cam.position.x, cam.position.z);
      skyUniforms.uCamY.value = cam.position.y;
      spriteUniforms.uTime.value = c.elapsed;

      updateShadowFrustum();
      updateFog(dt);
      updateSunScreen();

      // A few dozen instances is cheap, but not free — 12 Hz is well past the
      // rate at which a sorting error would be visible.
      if (sortAge > 1 / 12) {
        sortAge = 0;
        sortSprites();
      }

      // The environment map only has to keep up with the sun, not the frame
      // rate. With a static time of day this never fires again after boot.
      if (
        pmrem &&
        envAge >= ENV_MIN_INTERVAL &&
        Math.abs(service.time - envTime) > ENV_TIME_EPSILON
      ) {
        envTime = service.time;
        envAge = 0;
        refreshEnvironment();
      }
    },

    dispose() {
      offSetTime();
      offTimeScale();

      ctx.scene.remove(skyMesh, key, key.target, fill, fill.target, hemi);
      if (sprites) ctx.scene.remove(sprites);

      envScene.remove(envSky);
      skyGeometry.dispose();
      skyMaterial.dispose();
      spriteGeometry?.dispose();
      spriteMaterial?.dispose();
      sprites?.dispose();
      noise.dispose();
      atlas?.dispose();
      // DirectionalLight.dispose() releases the shadow map render target, which
      // is the one thing here that would otherwise survive a scene teardown.
      key.dispose();
      fill.dispose();
      hemi.dispose();

      if (ctx.scene.environment === envTarget?.texture) ctx.scene.environment = priorEnvironment;
      envTarget?.dispose();
      pmrem?.dispose();

      if (ctx.scene.fog === fog) ctx.scene.fog = priorFog;
      if (ctx.scene.background === background) ctx.scene.background = priorBackground;
    },
  };

  return sys;
};

export default createSky;
