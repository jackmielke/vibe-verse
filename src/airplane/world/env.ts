/**
 * The shared lighting state, and the GLSL every material pastes in.
 *
 * One object, created before anything else, mutated by the sky and read by
 * everything. The rule it enforces is the one that separates a scene that
 * looks composed from one that looks assembled: the cloud base, the rain, the
 * city glow, the runway lights and the wet sheen on the nose all take their
 * light from the same place, so they cannot disagree about it.
 *
 * ## This world is at night, in a thunderstorm, and that is a gift
 *
 * A daylight world has to be *right* — the eye knows exactly what noon looks
 * like and every approximation shows. A night world has to be *dark in the
 * right places*, which is a much easier target and a much more atmospheric
 * one. Almost everything you can see out of the windshield of Flight 209 is
 * one of four things:
 *
 *   - the orange underside of an overcast, lit from below by Chicago,
 *   - a field of point lights with no geometry attached to them at all,
 *   - the inside of a cloud, which is fog,
 *   - and, for a quarter of a second at a time, everything, in white.
 *
 * The last one is the whole show. `uFlash` is read by every material in the
 * world, so a strike lights the cloud, the rain, the wing, the panel and the
 * player's own hands in the same frame, from the same direction. Lightning
 * that only lights the sky reads as a screen effect; lightning that lights the
 * *aeroplane* reads as weather.
 */
import * as THREE from "three";

export interface EnvUniforms {
  /** Direction to the moon. Only visible on top of the overcast. */
  uMoonDir: THREE.IUniform<THREE.Vector3>;
  uMoonColor: THREE.IUniform<THREE.Color>;
  /** Zenith colour above the cloud, and the colour of clear night air. */
  uSkyColor: THREE.IUniform<THREE.Color>;
  /** The sodium-orange a city throws onto the bottom of an overcast. */
  uCityGlow: THREE.IUniform<THREE.Color>;
  /** In-cloud colour. Nearly neutral, slightly warm from the city below. */
  uCloudColor: THREE.IUniform<THREE.Color>;
  uHazeColor: THREE.IUniform<THREE.Color>;
  uFogDensity: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uCameraHeight: THREE.IUniform<number>;
  uExposure: THREE.IUniform<number>;

  /** 0..1 lightning, decaying. Read by every material in the world. */
  uFlash: THREE.IUniform<number>;
  /** Where the strike was, so the flash has a direction and not just a level. */
  uFlashDir: THREE.IUniform<THREE.Vector3>;

  /** Cloud layer, metres MSL. */
  uCloudBase: THREE.IUniform<number>;
  uCloudTops: THREE.IUniform<number>;
  /** 0..1 how solid the layer is. 1 is genuine instrument conditions. */
  uOvercast: THREE.IUniform<number>;
  /** 0..1 rain. Drives the windshield, the sheen and the sound. */
  uRain: THREE.IUniform<number>;
}

/**
 * The weather over Chicago on the night Flight 209 arrives.
 *
 * Bases at 1,000 feet above the field is a Cat I approach with the decision
 * height 200 feet below it: you break out with about twenty seconds of runway
 * in sight, which is exactly the amount of drama the last minute needs. Any
 * lower and it is unfair; any higher and you can see the airport from ten
 * miles and the whole approach is a formality.
 */
export const WEATHER = {
  /** Metres MSL. Field elevation is 205, so this is 1,000 feet AGL. */
  cloudBase: 205 + 305,
  cloudTops: 4200,
  /** Where the storm's own towers reach. Above this it is clear and starry. */
  stormTops: 9800,
  surfaceWind: new THREE.Vector3(-7.5, 0, -4.5),
  /** Metres of visibility below the cloud base. */
  visibility: 6500,
} as const;

export function makeEnvUniforms(): EnvUniforms {
  return {
    uMoonDir: { value: new THREE.Vector3(-0.35, 0.62, 0.7).normalize() },
    uMoonColor: { value: new THREE.Color(0x9fb4d8) },
    uSkyColor: { value: new THREE.Color(0x05070f) },
    // Sodium vapour. In 1980 every street light in America was this colour,
    // and getting it orange rather than the modern LED white is most of why
    // the world reads as the right decade before anything else does.
    uCityGlow: { value: new THREE.Color(0xff9640) },
    uCloudColor: { value: new THREE.Color(0x2a2a33) },
    uHazeColor: { value: new THREE.Color(0x14161f) },
    // Tuned for a world 60 km across, at night: the skyline legible at 26 km,
    // dissolving by 45.
    uFogDensity: { value: 0.000034 },
    uTime: { value: 0 },
    uCameraHeight: { value: 0 },
    uFlash: { value: 0 },
    uFlashDir: { value: new THREE.Vector3(0, 0.4, -1).normalize() },
    uCloudBase: { value: WEATHER.cloudBase },
    uCloudTops: { value: WEATHER.cloudTops },
    uOvercast: { value: 1 },
    uRain: { value: 0.65 },
    // Every custom shader tone-maps and encodes for itself (see OUTPUT_GLSL),
    // so this is the world's one exposure control. Calibrated against a
    // photograph taken from an airliner window over a city at night: the lit
    // cloud base sits around 0.20 sRGB, an individual street light clips, and
    // the unlit sky is genuinely near black rather than dark grey.
    //
    // Night renders come out wrong far more often from being *too bright* than
    // too dark. The first pass here ran at 2.6 and produced a uniform pale
    // grey wall out of the windshield — every surface pushed past the knee of
    // the ACES curve at once, which is exactly what an over-exposed night
    // photograph looks like and is indistinguishable from a broken shader.
    uExposure: { value: 1.15 },
  };
}

/**
 * Advance the lightning.
 *
 * A real flash is not one pulse. It is a leader, a return stroke, and then two
 * or three restrikes over about a third of a second, which is why lightning
 * flickers rather than blinks — and why a single exponential decay reads as a
 * camera flash instead. The restrikes are what make it look like weather.
 */
/*
 * A note on how hard the flash hits.
 *
 * Every `uFlash` coefficient in this world was originally set so that a strike
 * blew the frame to white, on the reasoning that this is what lightning does.
 * It does — to a camera. It is the wrong choice here for two reasons: the
 * player is trying to keep a runway in sight, and a saturated frame carries no
 * information at all, so a strike went from "the storm lit up" to "the screen
 * broke" several times a minute. The coefficients now peak around 0.8 in sRGB:
 * dramatic, clearly the brightest thing that ever happens, and still a picture.
 */
export class Lightning {
  /** 0..1, what the uniform gets. */
  level = 0;
  private t = 999;
  private strength = 0;
  private strikes: number[] = [];
  readonly direction = new THREE.Vector3(0, 0.4, -1).normalize();

  strike(strength = 1, direction?: THREE.Vector3): void {
    this.t = 0;
    this.strength = strength;
    if (direction) this.direction.copy(direction).normalize();
    // Leader, return stroke, then a couple of restrikes at plausible spacing.
    this.strikes = [0, 0.045, 0.13, 0.19];
    if (strength > 0.7) this.strikes.push(0.31);
  }

  update(dt: number): number {
    this.t += dt;
    let level = 0;
    for (const s of this.strikes) {
      const age = this.t - s;
      if (age < 0 || age > 0.5) continue;
      // Each stroke: instant rise, ~60 ms fall.
      level = Math.max(level, Math.exp(-age / 0.055));
    }
    this.level = level * this.strength;
    return this.level;
  }
}

/**
 * Tone mapping and output encoding, done by hand.
 *
 * Not optional bookkeeping — the single biggest thing standing between "a
 * renderer" and "a picture". Three splices its ACES curve and its sRGB encode
 * into the *built-in* materials as shader chunks; a raw `ShaderMaterial` never
 * sees either, so every material here would otherwise write scene-linear
 * radiance straight into an sRGB framebuffer. The symptom is a picture that
 * comes out dark and contrasty no matter what you do to the lights, and the
 * classic wrong fix is to crank every light multiplier until it looks right —
 * at which point the highlights have no roll-off left and every lightning
 * flash blows the frame to flat white.
 */
export const OUTPUT_GLSL = /* glsl */ `
uniform float uExposure;

/** Narkowicz's ACES fit. Close enough to the real curve, a tenth of the cost. */
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

/**
 * The uniform block. Declared exactly once, pasted first by every material.
 *
 * GLSL has no include guard, so a shader that wanted both the sky kernel and
 * aerial perspective would otherwise declare `uHazeColor` twice and fail to
 * compile — with an error pointing at a line number in a string that exists in
 * no file, which is a genuinely unpleasant half hour.
 */
export const ENV_UNIFORMS_GLSL = /* glsl */ `
uniform vec3  uMoonDir;
uniform vec3  uMoonColor;
uniform vec3  uSkyColor;
uniform vec3  uCityGlow;
uniform vec3  uCloudColor;
uniform vec3  uHazeColor;
uniform float uFogDensity;
uniform float uTime;
uniform float uCameraHeight;
uniform float uFlash;
uniform vec3  uFlashDir;
uniform float uCloudBase;
uniform float uCloudTops;
uniform float uOvercast;
uniform float uRain;
`;

/** Hash and value-noise helpers, shared so the world agrees with itself. */
export const NOISE_GLSL = /* glsl */ `
float hash11(float p) { return fract(sin(p * 127.1) * 43758.5453); }
float hash12(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2  hash22(vec2 p) {
  vec2 q = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(q) * 43758.5453);
}
float hash13(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}
`;

/**
 * Aerial perspective, plus the thing that makes this world's air different
 * from a clear one: the cloud layer.
 *
 * `layerOpacity` integrates how much cloud lies along the line of sight
 * between the eye and a point, given that the cloud occupies a slab between
 * `uCloudBase` and `uCloudTops`. That single function is what makes the
 * approach work — above the layer the ground is gone entirely, inside it
 * everything past forty metres is gone, and below it the airport appears out
 * of the murk at exactly the right distance without anything being switched
 * on or off. Requires `ENV_UNIFORMS_GLSL`.
 */
export const AERIAL_GLSL = /* glsl */ `
/**
 * How much of the segment from the eye to a point at height worldY, dist
 * away, lies inside the cloud slab — as a 0..1 opacity.
 *
 * The overlap of two intervals, scaled by the slant length of the segment.
 * Exact rather than approximate because the cheap version (test the midpoint)
 * pops the entire ground plane in and out as the aeroplane crosses the base.
 */
float layerOpacity(float dist, float worldY) {
  float y0 = uCameraHeight;
  float y1 = worldY;
  float lo = min(y0, y1);
  float hi = max(y0, y1);
  float overlap = max(0.0, min(hi, uCloudTops) - max(lo, uCloudBase));
  float span = max(hi - lo, 1e-3);
  // Fraction of the vertical extent that is cloud, times the slant distance.
  float through = (overlap / span) * dist;
  // A horizontal path entirely inside the layer gets the whole distance.
  if (hi < uCloudTops && lo > uCloudBase) through = dist;
  return 1.0 - exp(-through * 0.022 * uOvercast);
}

vec3 applyAerial(vec3 color, float dist, float worldY) {
  // Air thins with height, so haze accumulated along a slant path is scaled by
  // the density at the mean height of that path. Without this the view down
  // from 30,000 feet is as murky as the view along the deck, which it is not.
  float meanY = max(0.0, (uCameraHeight + worldY) * 0.5);
  float scale = exp(-meanY / 2600.0);
  float f = 1.0 - exp(-dist * uFogDensity * scale);
  vec3 haze = uHazeColor + uCityGlow * 0.010;
  color = mix(color, haze, clamp(f, 0.0, 1.0));

  // Then the cloud, which is much stronger and much more local.
  //
  // Its colour has to agree with what the sky dome is drawing, because the
  // ground plane fading into cloud and the dome above it meet along the
  // horizon and any disagreement is a hard seam across the whole frame. Above
  // the deck that means moonlit grey; below it, the city's orange. Getting
  // this wrong put a rust-brown rectangle under a silver-grey sky and the join
  // was the most visible thing in the picture.
  float aboveDeck = smoothstep(uCloudTops - 300.0, uCloudTops + 200.0, uCameraHeight);
  float cloud = layerOpacity(dist, worldY);
  vec3 lit = uCloudColor * (0.35 + 0.65 * uOvercast)
           + uCityGlow * 0.030 * (1.0 - aboveDeck)
           + uMoonColor * 0.075 * aboveDeck
           + vec3(1.0) * uFlash * 0.55;
  return mix(color, lit, clamp(cloud, 0.0, 1.0));
}
`;

const _tmp = new THREE.Color();
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Attach the shared uniforms to a material's own uniform block.
 *
 * Three does not share uniform objects between materials unless you hand it
 * the same object, which is exactly what this does — so a single write to
 * `env.uFlash.value` reaches every shader in the world in the same frame.
 */
export function withEnv(
  env: EnvUniforms,
  own: Record<string, THREE.IUniform> = {},
): Record<string, THREE.IUniform> {
  return { ...(env as unknown as Record<string, THREE.IUniform>), ...own };
}

/**
 * GLSL `uniform` declarations for a uniform block, inferred from the values.
 *
 * Three declares uniforms automatically for the materials it wrote and *not*
 * for a raw `ShaderMaterial` — you hand it a uniform object and it will
 * happily upload every value in it to a shader that never declared any of
 * them. The failure mode is a compile error naming an "undeclared identifier"
 * that is sitting right there in the uniforms you passed, which reads like a
 * Three bug and is not one.
 *
 * The env block is skipped: those are declared once, by hand, in
 * `ENV_UNIFORMS_GLSL`, and declaring them twice fails to compile just as hard.
 */
export function declareUniforms(
  own: Record<string, THREE.IUniform> | undefined,
  skip: Record<string, unknown>,
): string {
  if (!own) return "";
  const lines: string[] = [];
  for (const [name, uniform] of Object.entries(own)) {
    if (name in skip) continue;
    const v = uniform?.value as unknown;
    let type: string | null = null;
    if (typeof v === "number") type = "float";
    else if (typeof v === "boolean") type = "bool";
    else if (v instanceof THREE.Color || v instanceof THREE.Vector3) type = "vec3";
    else if (v instanceof THREE.Vector2) type = "vec2";
    else if (v instanceof THREE.Vector4 || v instanceof THREE.Quaternion) type = "vec4";
    else if (v instanceof THREE.Matrix4) type = "mat4";
    else if (v instanceof THREE.Matrix3) type = "mat3";
    else if (v && (v as THREE.Texture).isTexture) type = "sampler2D";
    if (!type) {
      console.warn(`[Flight 209] cannot infer a GLSL type for uniform "${name}"`);
      continue;
    }
    lines.push(`uniform ${type} ${name};`);
  }
  return lines.join("\n");
}

/** Recompute the derived colours. Cheap, but not called per frame. */
export function applyStormIntensity(env: EnvUniforms, storm: number): void {
  const s = clamp01(storm);
  env.uOvercast.value = 0.55 + 0.45 * s;
  env.uRain.value = clamp01(s * 1.1 - 0.1);
  env.uFogDensity.value = 0.000026 + s * 0.000022;
  env.uCloudColor.value.setHex(0x33333d).lerp(_tmp.setHex(0x1c1c24), s);
}
