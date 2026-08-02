/**
 * The shared lighting state.
 *
 * One object, created before anything else, mutated by the sky and read by
 * every material in the world. The rule it enforces is the one that separates
 * a scene that looks composed from one that looks assembled: the sky, the
 * terrain, the water, the haze on the mountains and the specular on a canopy
 * all take their sun from the same place, so they can never disagree about
 * where it is or what colour it is.
 *
 * The scattering is Preetham-flavoured single scattering — Rayleigh plus Mie
 * with an empirical air-mass fit rather than a raymarch. Closed form, no LUTs,
 * about forty flops a pixel, which matters because the screenshot harness
 * rasterises on the CPU and a ninety-tap sky would cost more than everything
 * else in the frame put together.
 */
import * as THREE from "three";

/** Seattle, early August, mid-afternoon. Seafair weather. */
export const SEAFAIR_AFTERNOON = 0.31;

export interface EnvUniforms {
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSkyColor: THREE.IUniform<THREE.Color>;
  uGroundColor: THREE.IUniform<THREE.Color>;
  uHazeColor: THREE.IUniform<THREE.Color>;
  uFogDensity: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uBetaR: THREE.IUniform<THREE.Vector3>;
  uBetaM: THREE.IUniform<THREE.Vector3>;
  uSunE: THREE.IUniform<number>;
  uNight: THREE.IUniform<number>;
  uCameraHeight: THREE.IUniform<number>;
  uExposure: THREE.IUniform<number>;
}

export function makeEnvUniforms(): EnvUniforms {
  return {
    uSunDir: { value: new THREE.Vector3(0.3, 0.72, 0.62).normalize() },
    uSunColor: { value: new THREE.Color(0xfff0d8) },
    uSkyColor: { value: new THREE.Color(0x8fbfe8) },
    uGroundColor: { value: new THREE.Color(0x3d4a3a) },
    uHazeColor: { value: new THREE.Color(0xa9c4d8) },
    // Tuned for a world 44 km across: about 12% haze at 3 km, half at 12 km,
    // and the Cascades at 70 km dissolved almost entirely into the sky.
    uFogDensity: { value: 0.0000255 },
    uTime: { value: 0 },
    uBetaR: { value: new THREE.Vector3(1.74e-5, 4.07e-5, 9.08e-5) },
    uBetaM: { value: new THREE.Vector3(2.1e-6, 2.1e-6, 2.1e-6) },
    uSunE: { value: 1000 },
    uNight: { value: 0 },
    uCameraHeight: { value: 0 },
    // Every custom shader tone-maps and encodes for itself (see OUTPUT_GLSL),
    // so this is the world's one exposure control. Calibrated by eye against a
    // real photograph of Lake Washington on a bright August afternoon: the
    // water sits around 0.28 sRGB, the dry summer grass around 0.55, and the
    // zenith around 0.42. At 1.0 everything a stop brighter than that and the
    // sky went white.
    uExposure: { value: 0.66 },
  };
}

/**
 * Where the sun is over Lake Washington on the first Sunday in August.
 *
 * `t` runs 0 (sunrise, due east) through 0.25 (local noon) to 0.5 (sunset).
 * The arc is tipped 23° south of the zenith, which is what Seattle's latitude
 * actually does to it, and is why the light comes over your left shoulder on
 * the southbound show run.
 */
export function sunDirectionFor(t: number, out = new THREE.Vector3()): THREE.Vector3 {
  const theta = t * Math.PI * 2;
  const tilt = 0.40;
  // East is +X; the arc leans south, which is +Z in this world.
  return out.set(Math.cos(theta), Math.sin(theta) * Math.cos(tilt), Math.sin(theta) * Math.sin(tilt)).normalize();
}

const _tmpColor = new THREE.Color();
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function mix(out: THREE.Color, a: number, b: number, t: number): THREE.Color {
  return out.setHex(a).lerp(_tmpColor.setHex(b), clamp01(t));
}

/** Recompute every derived colour for a time of day. Not called per frame. */
export function applyTimeOfDay(env: EnvUniforms, t: number): void {
  const dir = sunDirectionFor(t, env.uSunDir.value);
  const alt = dir.y;
  const dayness = smoothstep(0, 0.75, alt);
  const night = 1 - smoothstep(-0.14, 0.03, alt);

  env.uNight.value = night;

  // The sun's own colour: deep amber on the deck, near-white overhead.
  if (alt <= 0) mix(env.uSunColor.value, 0x2c3a62, 0xff7030, clamp01((alt + 0.15) / 0.17));
  else mix(env.uSunColor.value, 0xffa051, 0xfff4e4, dayness);

  mix(env.uSkyColor.value, 0x3b4d72, 0x7fb4e8, smoothstep(-0.05, 0.4, alt));
  mix(env.uGroundColor.value, 0x14181a, 0x4a5240, smoothstep(-0.05, 0.3, alt));

  // Puget Sound haze. Deliberately a touch bluer and heavier than a physical
  // horizon would be: aerial perspective is this world's only depth cue past
  // about 5 km, and a merely pale grey haze reads as fog rather than distance.
  if (alt < 0) mix(env.uHazeColor.value, 0x0b0f18, 0xc07850, clamp01((alt + 0.13) / 0.14));
  else mix(env.uHazeColor.value, 0xe89860, 0x8fb0cc, dayness);

  env.uFogDensity.value = 0.0000205 + (1 - dayness) * 0.000012;

  // More aerosol when the sun is low, which is what makes the last hour of a
  // summer evening over the lake look the way it does.
  const turbidity = 2.2 + (1 - dayness) * 3.6;
  env.uBetaR.value.set(1.74e-5, 4.07e-5, 9.08e-5).multiplyScalar(1 + (1 - dayness) * 0.35);
  env.uBetaM.value.setScalar(1.6e-6 * turbidity);
  env.uSunE.value = 1000 * Math.max(0, 1 - Math.exp(-(Math.PI / 1.95 - Math.acos(clamp01(alt))) / 1.5));
}

/**
 * The shared uniform block, then the two function libraries that read it.
 *
 * They are split because GLSL has no include guard: a material that wants both
 * the sky kernel and aerial perspective would otherwise declare `uHazeColor`
 * twice and fail to compile, with an error message pointing at a line number
 * in a string that does not exist in any file. Uniforms are declared exactly
 * once, in `ENV_UNIFORMS_GLSL`, and every material pastes that first.
 *
 * Sharing the *source* of the scattering is not a nicety either: if the haze
 * the terrain fades into and the sky behind it disagree by even a little, the
 * horizon becomes a visible seam.
 */
/**
 * Tone mapping and output encoding, done by hand.
 *
 * This is not optional bookkeeping — it is the single biggest thing standing
 * between "a renderer" and "a picture". Three injects its ACES curve and its
 * sRGB encode into the *built-in* materials by string-splicing shader chunks
 * into them. A raw `ShaderMaterial` never sees either, so every material in
 * this world would otherwise write scene-linear radiance straight into an
 * sRGB-expecting framebuffer: no highlight roll-off, no gamma, and a picture
 * that comes out dark and contrasty no matter what you do to the lights. The
 * first version of this world compensated by cranking every light multiplier
 * to 1.35, which is the classic symptom.
 *
 * So the renderer's own tone mapping is switched off and this does the job
 * instead, in one place, for everything.
 */
export const OUTPUT_GLSL = /* glsl */ `
uniform float uExposure;

/** Narkowicz's ACES fit. Close enough to the real curve, one-tenth the cost. */
vec3 acesFilmic(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 linearToSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

/** Scene-linear radiance in, display-referred sRGB out. */
vec3 outputColor(vec3 linear) {
  return linearToSRGB(acesFilmic(linear * uExposure));
}
`;

export const ENV_UNIFORMS_GLSL = /* glsl */ `
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform vec3  uGroundColor;
uniform vec3  uHazeColor;
uniform vec3  uBetaR;
uniform vec3  uBetaM;
uniform float uSunE;
uniform float uFogDensity;
uniform float uCameraHeight;
uniform float uNight;
uniform float uTime;
`;

export const ATMOSPHERE_GLSL = /* glsl */ `
const float PI_A = 3.141592653589793;
const float RAYLEIGH_PHASE_K = 0.0596831036594607;
const float RAYLEIGH_ZENITH = 8400.0;
const float MIE_ZENITH = 1250.0;
const float MIE_G = 0.78;

float pow15(float x) { return x * sqrt(x); }
vec3  pow15(vec3 x)  { return x * sqrt(x); }

float miePhase(float cosT) {
  float g2 = MIE_G * MIE_G;
  return (1.0 - g2) / (4.0 * PI_A * pow15(max(1.0 + g2 - 2.0 * MIE_G * cosT, 1e-4)));
}

float starField(vec3 dir) {
  vec3 p = dir * 240.0;
  vec3 cell = floor(p);
  float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  if (h < 0.9962) return 0.0;
  vec3 f = fract(p) - 0.5;
  float twinkle = 0.6 + 0.4 * sin(uTime * (1.1 + h * 7.0) + h * 90.0);
  return smoothstep(0.34, 0.0, length(f)) * twinkle;
}

/** Radiance looking along 'dir', render-linear. */
vec3 skyRadiance(vec3 dir) {
  float upness = clamp(dir.y, -0.08, 1.0);
  float zenith = acos(clamp(upness, -1.0, 1.0));
  float airMass = 1.0 / (upness + 0.15 * pow(max(93.885 - degrees(zenith), 0.001), -1.253));

  vec3 extinction = exp(-(uBetaR * RAYLEIGH_ZENITH + uBetaM * MIE_ZENITH) * airMass);

  float cosT = dot(dir, uSunDir);
  vec3 numer = uBetaR * (RAYLEIGH_PHASE_K * (1.0 + cosT * cosT)) + uBetaM * miePhase(cosT);
  vec3 betaTotal = numer / max(uBetaR + uBetaM, vec3(1e-9));

  vec3 inscatter = pow15(max(uSunE * betaTotal * (1.0 - extinction), vec3(0.0)));
  float grazing = clamp(pow(1.0 - max(uSunDir.y, 0.0), 5.0), 0.0, 1.0);
  inscatter *= mix(vec3(1.0), sqrt(max(uSunE * betaTotal * extinction, vec3(0.0))), grazing);

  float sunward = max(cosT, 0.0);
  float aureole = pow(sunward, 380.0) * 1.25 + pow(sunward, 20.0) * 0.20;

  float discTerm = 0.0;
  float e = sqrt(2.0 * max(0.0, 1.0 - cosT)) / 0.017;
  if (e < 1.05) {
    float limb = sqrt(max(1.0 - e * e, 0.0));
    discTerm = (1.0 - smoothstep(0.88, 1.02, e)) * (0.32 + 0.68 * pow(limb, 0.45));
  }

  // Radiance → render-linear. Derived rather than guessed: at this scale a
  // mid-blue zenith lands near 0.09 linear, which the ACES curve resolves to
  // about 0.42 sRGB — a real summer sky, not a white one.
  vec3 col = inscatter * 0.0034
           + vec3(1.0, 0.96, 0.90) * (discTerm * 11.0 + aureole) * extinction * (1.0 - uNight);

  col = mix(col, uGroundColor * 0.4, smoothstep(0.015, -0.10, dir.y));

  // The haze band. Narrower and much weaker than the first pass: at 0.34 rad
  // and 72% it read as a grey stripe painted across the sky rather than as air.
  float band = pow(1.0 - smoothstep(0.0, 0.20, abs(dir.y)), 2.2);
  col = mix(col, uHazeColor * 0.34, band * 0.55);

  if (uNight > 0.004) {
    vec3 nightCol = vec3(0.004, 0.006, 0.014)
                  + vec3(0.85, 0.9, 1.0) * starField(dir) * (1.0 - band);
    col = mix(col, nightCol + col * 0.2, uNight);
  }
  return max(col, vec3(0.0));
}
`;

/**
 * Aerial perspective. Requires `ENV_UNIFORMS_GLSL`.
 *
 * Distance haze is doing more work in this world than anywhere else in the
 * vibeverse. When the only things between you and a mountain are ninety
 * kilometres of air, the *amount* of air is the only cue you have for how far
 * away it is, and getting that curve right is the difference between a horizon
 * that recedes and a matte painting.
 */
export const AERIAL_GLSL = /* glsl */ `
vec3 applyAerial(vec3 color, float dist, float worldY) {
  // Air thins with height, so haze accumulated along a slant path is scaled by
  // the density at the average height of that path. Without this the view down
  // from 20,000 feet is as murky as the view along the deck, which it is not.
  float meanY = max(0.0, (uCameraHeight + worldY) * 0.5);
  float scale = exp(-meanY / 2400.0);
  float f = 1.0 - exp(-dist * uFogDensity * scale);
  return mix(color, uHazeColor, clamp(f, 0.0, 1.0));
}
`;
