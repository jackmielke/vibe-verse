/**
 * San Palmas — sky, sun and atmosphere.
 *
 * Everything above the horizon lives here: an analytic Preetham scattering
 * dome, a two-layer procedural cloud deck projected onto virtual altitude
 * planes, a night side with stars and a phased moon, the key light that casts
 * the world's shadows, the PMREM environment map every PBR material in San
 * Palmas is lit by, and the aerial-perspective fog that sells the distance to
 * Twin Peaks.
 *
 * The scattering model is evaluated twice: once per-pixel in GLSL for the
 * dome, and once per time-step on the CPU for the horizon/zenith radiance we
 * hand to the fog, the clear colour and the hemisphere bounce. Both walk the
 * same constants, so the haze can never drift out of agreement with the sky
 * it is supposed to be made of.
 *
 * Publishes SkyService.
 */
import * as THREE from "three";
import type { QualityTier, SkyService, System, SystemFactory } from "../types";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Where the cycle starts: late afternoon, sun ~28° up in the west-south-west. */
const DEFAULT_TIME = 0.665;

/** Real seconds for one full 0..1 revolution. ~24 min — slow enough to sit in. */
const DAY_LENGTH = 1440;

/**
 * How far the sun's arc leans south. San Palmas sits ~20° closer to the
 * equator than San Francisco, so the arc is steep: 22° of tilt caps the sun
 * at 68° and keeps the light-space basis away from the `lookAt` singularity.
 */
const SUN_ARC_TILT = THREE.MathUtils.degToRad(22);

/**
 * Humid-tropical atmosphere. Hazier (turbidity), less deep-blue (rayleigh)
 * and with a fatter aerosol halo around the sun (mie) than the temperate
 * defaults — that halo is most of the "golden hour" read.
 */
const ATMOSPHERE = {
  turbidity: 7.5,
  rayleigh: 2.1,
  mieCoefficient: 0.011,
  mieG: 0.8,
};

/**
 * Preetham radiance is authored against ACES at exposure 0.5; the engine runs
 * at 1.0, so scale the sky by the difference. ACES applies exposure as a plain
 * pre-multiply, which makes this exactly equivalent to re-exposing.
 */
const SKY_BOOST = 0.52;

/** Cloud deck altitudes (metres above sea level) and horizontal feature size. */
const CUMULUS_HEIGHT = 2200;
const CUMULUS_SCALE = 1 / 9000;
const CIRRUS_HEIGHT = 6200;
const CIRRUS_SCALE = 1 / 26000;

/** Shadow budget per tier: map resolution and the radius of the tight cascade. */
const SHADOW_TIERS: Record<QualityTier, { size: number; radius: number }> = {
  low: { size: 1024, radius: 190 },
  medium: { size: 2048, radius: 300 },
  high: { size: 2048, radius: 420 },
  ultra: { size: 4096, radius: 560 },
};

/** Cloud shader cost per tier: fbm octaves and self-shadow taps. */
const CLOUD_TIERS: Record<QualityTier, { octaves: number; taps: number; cirrus: boolean }> = {
  low: { octaves: 2, taps: 0, cirrus: false },
  medium: { octaves: 3, taps: 1, cirrus: true },
  high: { octaves: 3, taps: 2, cirrus: true },
  ultra: { octaves: 4, taps: 2, cirrus: true },
};

/** How far the sun may travel before the environment map is stale. */
const ENV_TIME_EPSILON = 0.0016;
/** …and the wall-clock floor between regenerations, so we never thrash PMREM. */
const ENV_MIN_INTERVAL = 0.7;

/**
 * Sun tint against elevation (`sunDir.y`), in linear light units. Deep orange
 * at the horizon, bleached to near-white overhead. Never fully saturated — a
 * pure-red sun reads as a bug, not a sunset.
 */
const SUN_TINT: { y: number; c: [number, number, number] }[] = [
  { y: -0.22, c: [1.0, 0.26, 0.09] },
  { y: -0.05, c: [1.0, 0.37, 0.15] },
  { y: 0.02, c: [1.0, 0.5, 0.25] },
  { y: 0.07, c: [1.0, 0.63, 0.37] },
  { y: 0.15, c: [1.0, 0.74, 0.51] },
  { y: 0.3, c: [1.0, 0.85, 0.69] },
  { y: 0.52, c: [1.0, 0.93, 0.84] },
  { y: 0.85, c: [1.0, 0.97, 0.94] },
];

const MOON_TINT = new THREE.Color().setRGB(0.62, 0.72, 1.0);
/** Warm bounce off sand, stucco and terracotta — the hemisphere light's floor. */
const GROUND_BOUNCE = new THREE.Color().setRGB(0.17, 0.135, 0.095);

// ---------------------------------------------------------------------------
// Preetham constants — shared verbatim between the GLSL and the CPU mirror.
// ---------------------------------------------------------------------------

const TOTAL_RAYLEIGH: [number, number, number] = [
  5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5,
];
const MIE_CONST: [number, number, number] = [
  1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14,
];
const RAYLEIGH_ZENITH = 8.4e3;
const MIE_ZENITH = 1.25e3;
const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const SUN_EE = 1000.0;
const THREE_OVER_SIXTEENPI = 0.05968310365946075;
const ONE_OVER_FOURPI = 0.07957747154594767;

// ---------------------------------------------------------------------------
// Procedural noise — the only "asset" in this module.
// ---------------------------------------------------------------------------

/**
 * A seamless, tiling RGBA noise atlas built on a periodic value-noise lattice.
 *   R — 4-octave fbm, the cloud density base
 *   G — a decorrelated 4-octave fbm, used to domain-warp R
 *   B — 3-octave ridged noise, the wispy high-frequency detail
 * Every octave's lattice period divides the texture size, so the result tiles
 * exactly and the cloud deck has no visible repeat seam.
 */
function buildNoiseTexture(rng: () => number, size = 256): THREE.DataTexture {
  const periods = [4, 8, 16, 32];

  /** One random value table per octave, per channel. */
  const tableFor = (octave: number) => {
    const p = periods[octave];
    const t = new Float32Array(p * p);
    for (let i = 0; i < t.length; i++) t[i] = rng();
    return t;
  };
  const banks = [0, 1, 2].map(() => periods.map((_, o) => tableFor(o)));

  const fade = (t: number) => t * t * (3 - 2 * t);

  /** Value noise on a lattice that wraps every `p` cells. */
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
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  };

  const data = new Uint8Array(size * size * 4);
  const inv = 1 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * inv;
      const v = y * inv;

      let r = 0;
      let g = 0;
      let b = 0;
      let amp = 0.5;
      let norm = 0;
      for (let o = 0; o < periods.length; o++) {
        const p = periods[o];
        r += octave(banks[0][o], p, u, v) * amp;
        g += octave(banks[1][o], p, u, v) * amp;
        if (o < 3) {
          // Ridged: fold the octave about its midpoint for filament-like detail.
          const n = octave(banks[2][o], p, u, v);
          b += (1 - Math.abs(n * 2 - 1)) * amp;
        }
        norm += amp;
        amp *= 0.5;
      }
      // The ridged channel only ran three octaves — renormalise it separately.
      const bNorm = 0.5 + 0.25 + 0.125;

      const i = (y * size + x) * 4;
      data[i] = Math.max(0, Math.min(255, Math.round((r / norm) * 255)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round((g / norm) * 255)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round((b / bNorm) * 255)));
      data[i + 3] = 255;
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

// ---------------------------------------------------------------------------
// Sky dome shader
// ---------------------------------------------------------------------------

const SKY_VERT = /* glsl */ `
varying vec3 vDir;

void main() {
  // Object space direction: the dome is a plain sphere with no rotation, so
  // this is the view ray for the fragment regardless of the dome's radius or
  // where we have parked it this frame.
  vDir = position;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // Pin to the far plane so the dome can never be clipped, at any radius.
  clip.z = clip.w;
  gl_Position = clip;
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;

uniform vec3  uSunDir;
uniform vec3  uMoonDir;
uniform float uTurbidity;
uniform float uRayleigh;
uniform float uMieCoefficient;
uniform float uMieG;
uniform float uSkyBoost;
uniform float uSunDiscCos;
uniform float uNight;
uniform vec3  uNightZenith;
uniform vec3  uNightHorizon;
uniform float uMoonRadius;
uniform float uMoonCos;
uniform float uTime;
uniform sampler2D uNoise;

varying vec3 vDir;

const float PI = 3.141592653589793;
const vec3  UPV = vec3(0.0, 1.0, 0.0);
const vec3  TOTAL_RAYLEIGH = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
const vec3  MIE_CONST = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);
const float RAYLEIGH_ZENITH = 8.4E3;
const float MIE_ZENITH = 1.25E3;
const float CUTOFF_ANGLE = 1.6110731556870734;
const float STEEPNESS = 1.5;
const float EE = 1000.0;
const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
const float ONE_OVER_FOURPI = 0.07957747154594767;

/** Preetham's earth-shadow hack: the sun's power falls off past the terminator. */
float sunIntensity(float zenithAngleCos) {
  zenithAngleCos = clamp(zenithAngleCos, -1.0, 1.0);
  return EE * max(0.0, 1.0 - exp(-((CUTOFF_ANGLE - acos(zenithAngleCos)) / STEEPNESS)));
}

vec3 totalMie(float T) {
  float c = (0.2 * T) * 10E-18;
  return 0.434 * c * MIE_CONST;
}

float rayleighPhase(float cosTheta) {
  return THREE_OVER_SIXTEENPI * (1.0 + cosTheta * cosTheta);
}

float hgPhase(float cosTheta, float g) {
  float g2 = g * g;
  float denom = pow(max(1e-4, 1.0 - 2.0 * g * cosTheta + g2), 1.5);
  return ONE_OVER_FOURPI * ((1.0 - g2) / denom);
}

float hash13(vec3 p) {
  p = fract(p * vec3(0.1031, 0.11369, 0.13787));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

/**
 * Star field. A 3D cell grid sampled along the view direction; roughly one in
 * seventy cells holds a star, so the density stays believable while the whole
 * field costs four hashes and no texture fetch.
 */
vec3 starField(vec3 d, float twinkle) {
  vec3 g = d * 190.0;
  vec3 id = floor(g);
  vec3 f = fract(g) - 0.5;

  float pick = hash13(id);
  if (pick < 0.986) return vec3(0.0);

  vec3 jitter = vec3(hash13(id + 11.3), hash13(id + 27.7), hash13(id + 43.1)) - 0.5;
  float dist = length(f - jitter * 0.62);
  float core = smoothstep(0.30, 0.02, dist);

  float mag = hash13(id + 61.9);
  float bright = pow(mag, 3.4) * 2.6 + 0.12;
  // Cool blue-white through to amber giants.
  vec3 tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.84, 0.62), pow(hash13(id + 83.7), 1.6));
  float flicker = 0.78 + 0.22 * sin(twinkle * (2.0 + mag * 7.0) + mag * 40.0);

  return tint * core * bright * flicker;
}

void main() {
  vec3 dir = normalize(vDir);
  float sunUp = dot(uSunDir, UPV);

  // ---- Analytic single-scattering (Preetham) ------------------------------
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

  // ---- Sun disc -----------------------------------------------------------
  vec3 L0 = vec3(0.1) * Fex;
  float disc = smoothstep(uSunDiscCos, uSunDiscCos + 0.000035, cosTheta);
  L0 += (sunE * 19000.0 * Fex) * disc;

  vec3 texColor = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
  vec3 color = pow(texColor, vec3(1.0 / (1.2 + 1.2 * sunfade))) * uSkyBoost;

  // ---- Night --------------------------------------------------------------
  if (uNight > 0.001) {
    float h = clamp(dir.y, 0.0, 1.0);
    vec3 night = mix(uNightHorizon, uNightZenith, pow(h, 0.55));

    // Extinction near the horizon kills the low stars first, as it should.
    float starMask = smoothstep(-0.02, 0.22, dir.y);

    // A faint galactic band, offset from the zenith so it reads as a feature
    // rather than a gradient. Two texture taps, no extra geometry.
    vec3 galaxyAxis = normalize(vec3(0.42, 0.36, -0.83));
    float bandT = dot(dir, galaxyAxis);
    float band = exp(-bandT * bandT * 12.0);
    vec2 bandUv = vec2(atan(dir.z, dir.x) * 0.159154 + 0.5, dir.y * 0.5 + 0.5);
    float dust = texture2D(uNoise, bandUv * vec2(2.0, 1.0)).r * 0.6
               + texture2D(uNoise, bandUv * vec2(6.0, 3.0) + 0.37).b * 0.4;
    night += vec3(0.055, 0.052, 0.075) * band * dust * starMask;

    night += starField(dir, uTime) * starMask * 0.55;

    // ---- Moon -------------------------------------------------------------
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
        // Maria and craters straight out of the noise atlas.
        float surf = 0.72
          + 0.34 * texture2D(uNoise, luv * 0.42 + 0.5).r
          - 0.22 * texture2D(uNoise, luv * 0.15 + 0.31).b;
        float edge = 1.0 - smoothstep(0.94, 1.0, sqrt(r2));
        night += vec3(1.0, 0.98, 0.93) * surf * (0.04 + 1.35 * lambert) * edge * moonUp;
      }
    }
    // Halo: a tight corona plus the broad atmospheric bloom around it.
    float mg = max(md, 0.0);
    night += vec3(0.72, 0.80, 1.0) * (pow(mg, 1400.0) * 0.55 + pow(mg, 70.0) * 0.028) * moonUp;

    color += night * uNight;
  }

  gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);

  // Raw ShaderMaterials get no grading for free — pull in the same ACES +
  // sRGB path every other material in San Palmas is authored against.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Cloud deck shader
// ---------------------------------------------------------------------------

const CLOUD_VERT = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Clouds are shaded on a dome, but sampled on a *plane*: every view ray is
 * intersected with a horizontal slab at the deck's altitude and the noise is
 * read at that world position. That buys real parallax (clouds slide past as
 * you fly, and pile up toward the horizon) for the price of a dome, and the
 * mip chain of the noise atlas handles the aliasing at grazing angles for free.
 */
function buildCloudFragment(tier: { octaves: number; taps: number; cirrus: boolean }): string {
  const weights = [0.52, 0.27, 0.14, 0.07].slice(0, tier.octaves);
  const norm = weights.reduce((a, b) => a + b, 0);
  return /* glsl */ `
precision highp float;

uniform sampler2D uNoise;
uniform vec2  uCamXZ;
uniform float uCamY;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uAmbientColor;
uniform vec3  uHorizonColor;
uniform float uTime;
uniform float uCover;
uniform float uOpacity;
uniform float uCirrusAmount;

varying vec3 vDir;

#define OCTAVES ${tier.octaves}
#define TAPS ${tier.taps}
#define FBM_NORM ${norm.toFixed(4)}
${tier.cirrus ? "#define CIRRUS" : ""}

const float ONE_OVER_FOURPI = 0.07957747154594767;

float hgPhase(float cosTheta, float g) {
  float g2 = g * g;
  float denom = pow(max(1e-4, 1.0 - 2.0 * g * cosTheta + g2), 1.5);
  return ONE_OVER_FOURPI * ((1.0 - g2) / denom);
}

/** Multi-octave density from the tiling atlas. Roughly 0..1. */
float fbm(vec2 p) {
  float v = texture2D(uNoise, p).r * ${weights[0].toFixed(3)};
  #if OCTAVES > 1
  v += texture2D(uNoise, p * 2.13 + vec2(0.317, 0.113)).g * ${(weights[1] ?? 0).toFixed(3)};
  #endif
  #if OCTAVES > 2
  v += texture2D(uNoise, p * 4.41 + vec2(0.771, 0.529)).r * ${(weights[2] ?? 0).toFixed(3)};
  #endif
  #if OCTAVES > 3
  v += texture2D(uNoise, p * 8.73 + vec2(0.219, 0.887)).b * ${(weights[3] ?? 0).toFixed(3)};
  #endif
  return v / FBM_NORM;
}

void main() {
  vec3 d = normalize(vDir);
  if (d.y < 0.008) discard;

  // The deck is always kept overhead: if the player climbs into it, it lifts.
  // Cheaper and far more robust than swapping to a downward-facing dome.
  float cumulusH = max(${CUMULUS_HEIGHT.toFixed(1)} - uCamY, 320.0);
  float cirrusH  = max(${CIRRUS_HEIGHT.toFixed(1)} - uCamY, 900.0);

  float horizonFade = smoothstep(0.008, 0.085, d.y);
  vec2 wind = vec2(0.62, -0.24) * uTime;

  vec3 col = uHorizonColor;
  float alpha = 0.0;

  // ---- High cirrus: thin, stretched, backlit -----------------------------
  #ifdef CIRRUS
  {
    vec2 q = (uCamXZ + d.xz * (cirrusH / d.y)) * ${CIRRUS_SCALE.toExponential(6)};
    q.x *= 0.34;
    q += wind * 0.00022;
    float n = fbm(q);
    float c = smoothstep(0.50, 0.86, n) * uCirrusAmount;
    float glow = 1.0 + 2.2 * hgPhase(dot(d, uSunDir), 0.62);
    col = mix(uAmbientColor * 0.9, uSunColor * glow * 0.55 + uAmbientColor * 0.5, 0.72);
    alpha = c * horizonFade;
  }
  #endif

  // ---- Cumulus deck -------------------------------------------------------
  {
    vec2 p = (uCamXZ + d.xz * (cumulusH / d.y)) * ${CUMULUS_SCALE.toExponential(6)};
    p += wind * 0.00035;

    // Domain warp: the single cheapest way to stop fbm looking like fbm.
    vec2 warp = (texture2D(uNoise, p * 0.31 + wind * 0.00012).gb - 0.5) * 0.42;
    vec2 sp = p + warp;

    float n = fbm(sp);
    float cover = smoothstep(uCover, uCover + 0.24, n);

    // Self-shadowing: march a couple of taps toward the sun and treat the
    // density we accumulate as optical depth. Two taps is enough to give the
    // deck a lit crown and a bruised underside.
    float lit = 1.0;
    #if TAPS > 0
    vec2 sdir = normalize(uSunDir.xz + vec2(1e-4, 1e-4));
    float occ = max(0.0, fbm(sp + sdir * 0.055) - n);
    #if TAPS > 1
    occ += max(0.0, fbm(sp + sdir * 0.135) - n) * 0.7;
    #endif
    lit = exp(-occ * 7.0);
    #endif

    // Forward-scattered silver lining, strongest when you look at the sun.
    float silver = 1.0 + 3.4 * hgPhase(dot(d, uSunDir), 0.74);
    // Powder: thin edges transmit, so they blow out relative to the core.
    float powder = 1.0 + 0.85 * (1.0 - cover);

    vec3 shaded = uAmbientColor * 0.85 + uHorizonColor * 0.22;
    vec3 sunlit = uSunColor * lit * silver * 0.34 * powder;
    vec3 cumCol = shaded + sunlit;

    float cumA = cover * horizonFade;
    col = mix(col, cumCol, cumA);
    alpha = cumA + alpha * (1.0 - cumA);
  }

  // Fade the deck into the haze at the horizon so it never ends in a hard line.
  col = mix(uHorizonColor, col, mix(0.35, 1.0, horizonFade));

  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0) * uOpacity);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
}

// ---------------------------------------------------------------------------
// CPU mirror of the scattering model
// ---------------------------------------------------------------------------

const cpuBetaR: [number, number, number] = [0, 0, 0];
const cpuBetaM: [number, number, number] = [0, 0, 0];
const cpuOut: [number, number, number] = [0, 0, 0];

/**
 * Evaluates the same radiance the dome shader does, for one view direction.
 * Only the zenith angle and the angle to the sun matter, so the caller passes
 * scalars. Returns linear RGB (no sun disc, no night term).
 */
function skyRadiance(dirY: number, cosTheta: number, sunUp: number): [number, number, number] {
  const sunE =
    SUN_EE *
    Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(THREE.MathUtils.clamp(sunUp, -1, 1))) / STEEPNESS)));
  const sunfade = 1 - THREE.MathUtils.clamp(1 - Math.exp(sunUp * 0.889), 0, 1);
  const rc = Math.max(0.05, ATMOSPHERE.rayleigh - (1 - sunfade));

  const mieBase = 0.434 * (0.2 * ATMOSPHERE.turbidity * 1e-17) * ATMOSPHERE.mieCoefficient;
  for (let i = 0; i < 3; i++) {
    cpuBetaR[i] = TOTAL_RAYLEIGH[i] * rc;
    cpuBetaM[i] = MIE_CONST[i] * mieBase;
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
  return cpuOut;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

const createSky: SystemFactory = (ctx) => {
  const shadowTier = SHADOW_TIERS[ctx.quality] ?? SHADOW_TIERS.high;
  const cloudTier = CLOUD_TIERS[ctx.quality] ?? CLOUD_TIERS.high;

  const noise = buildNoiseTexture(ctx.rng, ctx.quality === "low" ? 128 : 256);
  try {
    noise.anisotropy = Math.min(4, ctx.renderer.capabilities.getMaxAnisotropy());
  } catch {
    /* headless / stub renderer — the default of 1 is fine. */
  }

  // ---- Sky dome ------------------------------------------------------------
  const skyUniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uTurbidity: { value: ATMOSPHERE.turbidity },
    uRayleigh: { value: ATMOSPHERE.rayleigh },
    uMieCoefficient: { value: ATMOSPHERE.mieCoefficient },
    uMieG: { value: ATMOSPHERE.mieG },
    uSkyBoost: { value: SKY_BOOST },
    // ~0.72° half-angle: a touch fatter than the real sun so it survives
    // downsampling and gives the bloom pass something to bite on.
    uSunDiscCos: { value: 0.99992 },
    uNight: { value: 0 },
    uNightZenith: { value: new THREE.Color().setRGB(0.006, 0.012, 0.03) },
    uNightHorizon: { value: new THREE.Color().setRGB(0.028, 0.045, 0.078) },
    uMoonRadius: { value: 0.021 },
    uMoonCos: { value: Math.cos(0.0235) },
    uTime: { value: 0 },
    uNoise: { value: noise },
  };

  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: true,
  });

  const skyGeometry = new THREE.SphereGeometry(1, 48, 24);
  const skyMesh = new THREE.Mesh(skyGeometry, skyMaterial);
  skyMesh.name = "palmas:sky";
  skyMesh.scale.setScalar(8000);
  skyMesh.frustumCulled = false;
  // First thing drawn; writes no depth, so everything else lands on top of it.
  skyMesh.renderOrder = -1000;
  ctx.scene.add(skyMesh);

  // ---- Cloud deck ----------------------------------------------------------
  const cloudUniforms = {
    uNoise: { value: noise },
    uCamXZ: { value: new THREE.Vector2() },
    uCamY: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uAmbientColor: { value: new THREE.Color(0.4, 0.5, 0.6) },
    uHorizonColor: { value: new THREE.Color(0.6, 0.7, 0.8) },
    uTime: { value: 0 },
    uCover: { value: 0.47 },
    uOpacity: { value: 0.92 },
    uCirrusAmount: { value: 0.42 },
  };

  const cloudMaterial = new THREE.ShaderMaterial({
    uniforms: cloudUniforms,
    vertexShader: CLOUD_VERT,
    fragmentShader: buildCloudFragment(cloudTier),
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    // Depth-tested against the real world: the deck sits 7.5 km out, so hills,
    // towers and the bridge all occlude it correctly and early-Z rejects the
    // covered pixels before the fbm ever runs.
    depthTest: true,
    fog: false,
    blending: THREE.NormalBlending,
  });

  const cloudGeometry = new THREE.SphereGeometry(7500, 40, 20, 0, Math.PI * 2, 0, Math.PI * 0.52);
  const cloudMesh = new THREE.Mesh(cloudGeometry, cloudMaterial);
  cloudMesh.name = "palmas:clouds";
  cloudMesh.frustumCulled = false;
  cloudMesh.renderOrder = -900;
  ctx.scene.add(cloudMesh);

  // ---- Lights --------------------------------------------------------------
  // One key light. It is the sun by day and swings to the moon after dusk, so
  // the world keeps a single shadow map and night still has directional form.
  const key = new THREE.DirectionalLight(0xffffff, 3.4);
  key.castShadow = true;
  key.shadow.mapSize.set(shadowTier.size, shadowTier.size);

  const KEY_DISTANCE = 1800;
  const shadowCam = key.shadow.camera as THREE.OrthographicCamera;
  shadowCam.left = -shadowTier.radius;
  shadowCam.right = shadowTier.radius;
  shadowCam.top = shadowTier.radius;
  shadowCam.bottom = -shadowTier.radius;
  shadowCam.near = 10;
  // Deep enough that a 300 m tower still projects onto the ground at a 15° sun.
  shadowCam.far = KEY_DISTANCE + shadowTier.radius * 2.5 + 900;
  shadowCam.updateProjectionMatrix();

  // Bias in metres, converted into the shadow camera's normalised depth range.
  // normalBias does the heavy lifting (it is measured in world units), so the
  // depth bias can stay small enough to avoid peter-panning entirely.
  const shadowTexel = (shadowTier.radius * 2) / shadowTier.size;
  key.shadow.bias = -0.28 / (shadowCam.far - shadowCam.near);
  key.shadow.normalBias = Math.max(0.05, shadowTexel * 1.45);

  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x4a3b28, 0.5);

  ctx.scene.add(key, key.target, hemi);

  // ---- Environment (IBL) ---------------------------------------------------
  // A miniature copy of the dome + deck, rendered to a PMREM cubemap. Without
  // this every MeshStandardMaterial in San Palmas has no specular horizon and
  // no sky bounce, and the whole world reads as plastic.
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(skyGeometry, skyMaterial);
  envSky.scale.setScalar(30);
  envSky.renderOrder = -1000;
  envSky.frustumCulled = false;
  const envClouds = new THREE.Mesh(new THREE.SphereGeometry(24, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), cloudMaterial);
  envClouds.renderOrder = -900;
  envClouds.frustumCulled = false;
  envScene.add(envSky, envClouds);

  let pmrem: THREE.PMREMGenerator | null = null;
  let envTarget: THREE.WebGLRenderTarget | null = null;
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
      // A context loss or a stub renderer — keep whatever we had.
      pmrem = null;
    }
  }

  // ---- Time of day ---------------------------------------------------------
  const UP_AXIS = new THREE.Vector3(0, 1, 0);
  const EAST_AXIS = new THREE.Vector3(1, 0, 0);
  /** Night floor for fog/background — matches the dome's own night gradient. */
  const NIGHT_HORIZON = new THREE.Color().setRGB(0.03, 0.048, 0.082);
  const NIGHT_ZENITH = new THREE.Color().setRGB(0.008, 0.014, 0.034);

  const sunDir = new THREE.Vector3();
  const moonDir = new THREE.Vector3();
  /** Unit vector pointing at whichever body is currently the key light. */
  const keyDirection = new THREE.Vector3(0, 1, 0);
  const zenithColor = new THREE.Color();
  const horizonColor = new THREE.Color();
  const ambientColor = new THREE.Color();
  const lightColor = new THREE.Color();

  const fog = new THREE.FogExp2(0x9fd6ea, 0.0003);
  ctx.scene.fog = fog;
  const background = new THREE.Color(0x8fd0e8);
  ctx.scene.background = background;

  const service: SkyService = {
    time: DEFAULT_TIME,
    sunDirection: sunDir,
    sunColor: new THREE.Color(1, 1, 1),
    daylight: 1,
    setTime(t: number) {
      applyTime(t);
      // Instant, not lerped: the screenshot harness poses the light and expects
      // the very next frame to be correct, environment map included.
      refreshEnvironment();
    },
  };

  /** Piecewise-linear lookup into SUN_TINT. */
  function sampleSunTint(y: number, out: THREE.Color): THREE.Color {
    if (y <= SUN_TINT[0].y) return out.setRGB(...SUN_TINT[0].c);
    for (let i = 1; i < SUN_TINT.length; i++) {
      const a = SUN_TINT[i - 1];
      const b = SUN_TINT[i];
      if (y <= b.y) {
        const t = (y - a.y) / (b.y - a.y);
        return out.setRGB(
          a.c[0] + (b.c[0] - a.c[0]) * t,
          a.c[1] + (b.c[1] - a.c[1]) * t,
          a.c[2] + (b.c[2] - a.c[2]) * t,
        );
      }
    }
    const last = SUN_TINT[SUN_TINT.length - 1];
    return out.setRGB(...last.c);
  }

  const horizonSample = new THREE.Vector3();
  const azimuth = new THREE.Vector3();

  /**
   * Horizon radiance, averaged over four azimuths and weighted toward the sun
   * and anti-sun bearings — those are where the eye actually looks, and where
   * the haze is most strongly coloured.
   */
  function computeHorizon(out: THREE.Color): void {
    // Sun bearing, +90°, anti-sun, -90°.
    const weights = [0.3, 0.2, 0.3, 0.2];
    let r = 0;
    let g = 0;
    let b = 0;
    // Sun bearing on the ground plane; degenerate only at exact zenith, which
    // the 22° arc tilt makes unreachable.
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
      const c = skyRadiance(horizonSample.y, horizonSample.dot(sunDir), sunDir.y);
      r += c[0] * weights[i];
      g += c[1] * weights[i];
      b += c[2] * weights[i];
    }
    out.setRGB(Math.min(r, 3), Math.min(g, 3), Math.min(b, 3));
  }

  /** Recomputes every derived quantity for a normalised time of day. */
  function applyTime(t: number): void {
    const time = t - Math.floor(t);
    service.time = time;

    // ---- Sun position ------------------------------------------------------
    // Rises due east at 0.25, sets due west at 0.75; the whole arc leans south.
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
    const night = 1 - THREE.MathUtils.clamp(THREE.MathUtils.smoothstep(y, -0.16, 0.03), 0, 1);
    service.daylight = daylight;

    sampleSunTint(y, service.sunColor);

    // ---- Sky uniforms ------------------------------------------------------
    skyUniforms.uSunDir.value.copy(sunDir);
    skyUniforms.uMoonDir.value.copy(moonDir);
    skyUniforms.uNight.value = night;
    // The air thickens as the sun drops: more aerosol scatter, warmer horizon.
    skyUniforms.uTurbidity.value = ATMOSPHERE.turbidity + (1 - daylight) * 2.4;

    // ---- Derived sky colours ----------------------------------------------
    const zen = skyRadiance(1, y, y);
    zenithColor.setRGB(zen[0], zen[1], zen[2]);
    computeHorizon(horizonColor);

    // Night floor, matching the dome's own night gradient so the fog cannot
    // pull away from the sky it is meant to be part of.
    if (night > 0) {
      horizonColor.lerp(NIGHT_HORIZON, night);
      zenithColor.lerp(NIGHT_ZENITH, night);
    }

    // ---- Fog ---------------------------------------------------------------
    fog.color.copy(horizonColor);
    // Tropical haze: thickest at the golden hours when the light rakes through
    // the most air, thinnest under a clear night sky.
    fog.density = 0.00026 + (1 - daylight) * 0.00013 - night * 0.00011;
    background.copy(horizonColor);

    // ---- Key light ---------------------------------------------------------
    const sunIntensity = THREE.MathUtils.clamp(THREE.MathUtils.smoothstep(y, -0.04, 0.16), 0, 1) *
      (2.6 + 2.2 * Math.max(0, y));
    const moonIntensity = 0.26 * night * THREE.MathUtils.clamp(THREE.MathUtils.smoothstep(moonDir.y, -0.04, 0.12), 0, 1);

    if (sunIntensity > moonIntensity) {
      keyDirection.copy(sunDir);
      lightColor.copy(service.sunColor);
      key.intensity = sunIntensity;
    } else {
      keyDirection.copy(moonDir);
      lightColor.copy(MOON_TINT);
      key.intensity = moonIntensity;
    }
    key.color.copy(lightColor);

    // ---- Ambient bounce ----------------------------------------------------
    // scene.environment carries the IBL for standard materials; the hemisphere
    // light exists for everything else (Lambert/Phong props, particles) and is
    // deliberately weak so the two do not double-count.
    ambientColor.copy(zenithColor).lerp(horizonColor, 0.35);
    hemi.color.copy(ambientColor).multiplyScalar(1.6);
    hemi.groundColor.copy(GROUND_BOUNCE).multiplyScalar(0.25 + 0.75 * daylight);
    hemi.intensity = 0.12 + 0.46 * daylight;

    // ---- Cloud lighting ----------------------------------------------------
    cloudUniforms.uSunDir.value.copy(keyDirection);
    cloudUniforms.uSunColor.value.copy(lightColor).multiplyScalar(Math.max(sunIntensity, moonIntensity * 1.6));
    cloudUniforms.uAmbientColor.value.copy(ambientColor).multiplyScalar(0.9);
    cloudUniforms.uHorizonColor.value.copy(horizonColor);
    cloudUniforms.uOpacity.value = 0.94;
    // Tropical afternoons build cumulus; dawn is thinner and higher.
    cloudUniforms.uCover.value = 0.44 + 0.06 * Math.cos((time - 0.62) * Math.PI * 2);
    cloudUniforms.uCirrusAmount.value = 0.34 + 0.2 * daylight;
  }

  // ---- Shadow frustum ------------------------------------------------------
  const shadowCenter = new THREE.Vector3();
  const shadowBasis = new THREE.Matrix4();
  const shadowQuat = new THREE.Quaternion();
  const shadowQuatInv = new THREE.Quaternion();
  const tmpVec = new THREE.Vector3();
  const camForward = new THREE.Vector3();

  /**
   * Parks the single cascade around the player, pushed forward along the view
   * so most of its area lands in front of the camera rather than behind it,
   * then snaps the centre to whole shadow texels. Without the snap the map
   * re-rasterises on a sub-texel grid every frame and every shadow edge crawls.
   */
  function updateShadowFrustum(): void {
    const p = ctx.services.player?.position ?? ctx.camera.position;
    ctx.camera.getWorldDirection(camForward);
    camForward.y = 0;
    if (camForward.lengthSq() > 1e-6) camForward.normalize();
    else camForward.set(0, 0, -1);

    shadowCenter
      .copy(p)
      .addScaledVector(camForward, shadowTier.radius * 0.42);

    // Light-space basis, built exactly the way DirectionalLightShadow builds
    // it, so our snap grid is the shadow map's own texel grid.
    tmpVec.copy(shadowCenter).add(keyDirection);
    shadowBasis.lookAt(tmpVec, shadowCenter, UP_AXIS);
    shadowQuat.setFromRotationMatrix(shadowBasis);
    shadowQuatInv.copy(shadowQuat).invert();

    tmpVec.copy(shadowCenter).applyQuaternion(shadowQuatInv);
    tmpVec.x = Math.round(tmpVec.x / shadowTexel) * shadowTexel;
    tmpVec.y = Math.round(tmpVec.y / shadowTexel) * shadowTexel;
    tmpVec.applyQuaternion(shadowQuat);
    shadowCenter.copy(tmpVec);

    key.position.copy(shadowCenter).addScaledVector(keyDirection, KEY_DISTANCE);
    key.target.position.copy(shadowCenter);
    key.target.updateMatrixWorld();
  }

  // ---- Boot ----------------------------------------------------------------
  applyTime(DEFAULT_TIME);
  updateShadowFrustum();
  refreshEnvironment();

  let cycleSpeed = 1 / DAY_LENGTH;
  let envAge = 0;
  let envTime = service.time;

  const offSetTime = ctx.on("palmas:setTime", (payload) => {
    const t = typeof payload === "number" ? payload : (payload as { time?: number })?.time;
    if (typeof t === "number" && Number.isFinite(t)) service.setTime(t);
  });
  const offSpeed = ctx.on("palmas:timeScale", (payload) => {
    const s = typeof payload === "number" ? payload : (payload as { scale?: number })?.scale;
    if (typeof s === "number" && Number.isFinite(s)) cycleSpeed = s / DAY_LENGTH;
  });

  const sys: System = {
    name: "sky",

    update(dt) {
      if (cycleSpeed !== 0) applyTime(service.time + dt * cycleSpeed);
      envAge += dt;
    },

    lateUpdate(_dt, c) {
      const cam = c.camera;

      // Both domes ride the camera so they stay at optical infinity.
      skyMesh.position.copy(cam.position);
      cloudMesh.position.copy(cam.position);

      skyUniforms.uTime.value = c.elapsed;
      cloudUniforms.uTime.value = c.elapsed;
      cloudUniforms.uCamXZ.value.set(cam.position.x, cam.position.z);
      cloudUniforms.uCamY.value = cam.position.y;

      updateShadowFrustum();

      // The environment map only has to keep up with the sun, not the frame
      // rate — regenerate when the sky has materially moved and never more
      // often than ENV_MIN_INTERVAL.
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
      offSpeed();
      ctx.scene.remove(skyMesh, cloudMesh, key, key.target, hemi);
      envScene.remove(envSky, envClouds);
      envClouds.geometry.dispose();
      skyGeometry.dispose();
      cloudGeometry.dispose();
      skyMaterial.dispose();
      cloudMaterial.dispose();
      noise.dispose();
      key.dispose();
      hemi.dispose();
      if (ctx.scene.environment === envTarget?.texture) ctx.scene.environment = null;
      envTarget?.dispose();
      pmrem?.dispose();
      ctx.scene.fog = null;
      ctx.scene.background = null;
    },
  };

  ctx.services.sky = service;
  return sys;
};

export default createSky;
