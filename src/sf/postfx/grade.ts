/**
 * The final image: bloom composite, tonemap, colour grade, lens, and every
 * screen-space effect the game drives.
 *
 * This is deliberately one pass. Chromatic aberration, radial speed blur, the
 * underwater warp and the unsharp mask all need to sample the scene at offsets;
 * splitting them across passes would mean each one samples a different, partly
 * processed version of the image, and would cost a full-resolution HDR
 * round-trip apiece. Doing them together also fixes the ordering question once:
 * bloom is added in HDR *before* the tonemap (that is the only place it is
 * physically meaningful), and everything lens-related happens after it.
 *
 * Order of operations, and why:
 *   1. UV distortions (underwater refraction, heat of the moment radial blur)
 *   2. Scene sample with chromatic aberration — dispersion is a property of the
 *      lens, so it must act on the scene, not on the graded result
 *   3. Bloom + flare + anamorphic streak, modulated by lens dirt, added in HDR
 *   4. Exposure, then the ACES RRT/ODT fit (matching the renderer's own
 *      ACESFilmicToneMapping exactly, so nothing shifts if a pass is disabled)
 *   5. The 3D LUT, in display space where a grade is authored
 *   6. Damage, night-vision/thermal, flash
 *   7. Grain, vignette, unsharp — the "it was photographed" layer, last
 */
import * as THREE from "three";
import { Effect, EffectAttribute, BlendFunction } from "postprocessing";
import { envUniforms } from "./env";
import { GLSL_EFFECT_DEPTH, GLSL_NOISE } from "./glsl";
import { BlendableLut, LUT_SIZE } from "./lut";
import { BloomPyramid } from "./bloom";

const gradeFrag = /* glsl */ `
${GLSL_EFFECT_DEPTH}
${GLSL_NOISE}

uniform sampler2D bloomTex;
uniform sampler2D flareTex;
uniform sampler2D streakTex;
uniform sampler2D dirtTex;
uniform sampler2D lutTex;

uniform float bloomAmount;
uniform float flareAmount;
uniform float streakAmount;
uniform float dirtAmount;

uniform float gExposure;
uniform float lutSize;
uniform float lutAmount;

uniform float grainAmount;
uniform float caAmount;
uniform float vignetteAmount;
uniform float sharpenAmount;

uniform float damageAmount;
uniform vec2 damageVec;
uniform float lowHealthAmount;
uniform float flashAmount;

uniform float speedAmount;
uniform float underwaterAmount;
uniform float nightVisionAmount;
uniform float thermalAmount;

uniform float gTime;
uniform vec2 gTexel;
uniform float gAspect;

/* ---------------- colour helpers ---------------- */

float gLuma(const in vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/**
 * ACES RRT+ODT fit, byte-for-byte the same maths three uses for
 * ACESFilmicToneMapping. Matching it matters: the renderer applies its own
 * tonemap whenever the pipeline is bypassed, and an image that shifts when you
 * toggle post-processing is impossible to art-direct against.
 */
vec3 gACES(vec3 color) {
  mat3 inputMat = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );
  mat3 outputMat = mat3(
     1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602
  );
  color = inputMat * (color / 0.6);
  vec3 a = color * (color + 0.0245786) - 0.000090537;
  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  color = outputMat * (a / b);
  return clamp(color, 0.0, 1.0);
}

vec3 gLinearToSrgb(const in vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, step(c, vec3(0.0031308)));
}

vec3 gSrgbToLinear(const in vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((max(c, vec3(0.0)) + 0.055) / 1.055, vec3(2.4));
  return mix(hi, lo, step(c, vec3(0.04045)));
}

/**
 * 32^3 lattice sampled from a horizontal strip. Two bilinear fetches plus a
 * manual blend along blue — the two slices bracket the input's blue value.
 */
vec3 gSampleLut(const in vec3 c) {
  vec3 col = clamp(c, 0.0, 1.0);
  float sz = lutSize;
  float slice = col.b * (sz - 1.0);
  float s0 = floor(slice);
  float s1 = min(s0 + 1.0, sz - 1.0);
  float f = slice - s0;

  float x = col.r * (sz - 1.0) + 0.5;
  float y = (col.g * (sz - 1.0) + 0.5) / sz;
  float invStrip = 1.0 / (sz * sz);

  vec3 a = texture2D(lutTex, vec2((s0 * sz + x) * invStrip, y)).rgb;
  vec3 b = texture2D(lutTex, vec2((s1 * sz + x) * invStrip, y)).rgb;
  return mix(a, b, f);
}

/* ---------------- sampling ---------------- */

/**
 * Chromatic aberration, at the edges only.
 *
 * A real lens is corrected on-axis; the fringing you see in a photograph grows
 * with the square of the field height. Applying a constant offset across the
 * whole frame is the classic giveaway — it puts colour fringes on a subject
 * dead centre, where no lens ever would.
 */
vec3 gSampleScene(const in vec2 uv) {
  vec2 fromCenter = uv - 0.5;
  float r2 = dot(fromCenter, fromCenter) * 4.0;
  float amount = caAmount * r2 * r2 * 0.006;
  if (amount < 1e-6) return texture2D(inputBuffer, uv).rgb;
  vec2 dir = fromCenter;
  vec3 c;
  c.r = texture2D(inputBuffer, uv - dir * amount).r;
  c.g = texture2D(inputBuffer, uv).g;
  c.b = texture2D(inputBuffer, uv + dir * amount).b;
  return c;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 suv = uv;

  /* --- underwater refraction: two crossed wave trains, as caustics are --- */
  if (underwaterAmount > 0.001) {
    float t = gTime * 0.9;
    vec2 w = vec2(
      sin(uv.y * 34.0 + t * 1.7) + sin(uv.y * 71.0 - t * 2.3) * 0.45,
      cos(uv.x * 29.0 - t * 1.4) + cos(uv.x * 63.0 + t * 2.1) * 0.45
    );
    suv += w * gTexel * 5.5 * underwaterAmount;
  }

  vec3 scene;

  /* --- radial speed blur: the wingsuit dive --- */
  if (speedAmount > 0.003) {
    vec2 toCenter = vec2(0.5) - suv;
    float edge = clamp(length(toCenter * vec2(gAspect, 1.0)) * 1.7, 0.0, 1.0);
    float strength = speedAmount * edge * edge * 0.14;
    float jitter = sfIGNT(gl_FragCoord.xy, gTime * 60.0) * 0.5;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 6; i++) {
      float k = (float(i) + jitter) / 6.0;
      acc += gSampleScene(suv + toCenter * (k * strength));
    }
    scene = acc / 6.0;
  } else {
    scene = gSampleScene(suv);
  }

  /* --- bloom, in HDR, before the tonemap --- */
  vec3 dirt = texture2D(dirtTex, uv).rgb;
  vec3 bloom = texture2D(bloomTex, uv).rgb * bloomAmount;
  bloom += texture2D(flareTex, uv).rgb * flareAmount;
  bloom += texture2D(streakTex, uv).rgb * streakAmount;
  // Dirt does not add light, it redistributes it: the veil is brighter where
  // the glass is dirty and unchanged where it is clean.
  bloom *= 1.0 + dirt * dirtAmount * 2.2;
  // Energy-conserving composite. Lerping rather than adding means a bloomy
  // highlight loses exactly as much core as its halo gains.
  vec3 color = mix(scene, bloom, clamp(bloomAmount * 0.06 + dirt.r * dirtAmount * 0.02, 0.0, 0.9));
  color += bloom * 0.045;

  /* --- underwater absorption, wavelength dependent --- */
  if (underwaterAmount > 0.001) {
    float dist = min(sfDepthMetres(uv), 120.0);
    // Beer-Lambert with red absorbed fastest. This is why everything ten metres
    // down is blue-green whatever colour it started.
    vec3 absorb = exp(-vec3(0.36, 0.09, 0.045) * dist * 0.25 * underwaterAmount);
    vec3 water = vec3(0.035, 0.13, 0.17);
    color = mix(color, color * absorb + water * (1.0 - absorb.g) * 0.7, underwaterAmount);
  }

  /* --- exposure + tonemap --- */
  color = gACES(color * gExposure);

  /* --- grade, in display space --- */
  vec3 display = gLinearToSrgb(color);
  display = mix(display, gSampleLut(display), lutAmount);

  /* --- damage --- */
  if (damageAmount > 0.001 || lowHealthAmount > 0.001) {
    vec2 d = (uv - 0.5) * vec2(gAspect, 1.0);
    float radial = clamp(length(d) * 1.55, 0.0, 1.0);
    // Directional lobe: strongest on the side the shot came from, so the
    // player can turn toward it without looking at the HUD.
    float lobe = clamp(dot(normalize(d + 1e-5), damageVec), 0.0, 1.0);
    float hit = damageAmount * pow(radial, 1.6) * (0.35 + 0.9 * pow(lobe, 2.0));
    float chronic = lowHealthAmount * pow(radial, 2.2) * (0.55 + 0.45 * sin(gTime * 3.1));
    float amount = clamp(hit + chronic * 0.55, 0.0, 1.0);
    vec3 blood = vec3(0.72, 0.045, 0.035);
    display = mix(display, blood, amount * 0.85);
    // Desaturate at the same time — pain is not colourful.
    display = mix(display, vec3(gLuma(display)), amount * 0.35);
  }

  /* --- night vision --- */
  if (nightVisionAmount > 0.001) {
    float l = gLuma(display);
    float gain = pow(clamp(l * 5.0, 0.0, 1.0), 0.62);
    vec3 nv = vec3(0.16, 1.0, 0.30) * gain;
    // Photocathode noise + horizontal scan structure.
    float n = sfHash12(gl_FragCoord.xy + gTime * 91.7);
    nv += (n - 0.5) * 0.12;
    nv *= 0.92 + 0.08 * sin(uv.y * 900.0);
    float scopeR = length((uv - 0.5) * vec2(gAspect, 1.0));
    nv *= 1.0 - smoothstep(0.42, 0.56, scopeR);
    display = mix(display, nv, nightVisionAmount);
  }

  /* --- thermal --- */
  if (thermalAmount > 0.001) {
    float l = gLuma(display);
    float d = sfDepthMetres(uv);
    // Warm things read hot; distance cools everything, as an uncooled sensor does.
    float heat = clamp(l * 1.35 - d * 0.0012, 0.0, 1.0);
    vec3 ramp = vec3(0.0);
    ramp = mix(vec3(0.02, 0.02, 0.12), vec3(0.35, 0.02, 0.55), smoothstep(0.0, 0.35, heat));
    ramp = mix(ramp, vec3(0.95, 0.28, 0.05), smoothstep(0.35, 0.7, heat));
    ramp = mix(ramp, vec3(1.0, 0.98, 0.82), smoothstep(0.7, 1.0, heat));
    display = mix(display, ramp, thermalAmount);
  }

  /* --- vignette: natural falloff plus a little art direction --- */
  vec2 v = (uv - 0.5) * vec2(gAspect, 1.0);
  float r = length(v);
  // cos^4 is the physical illumination falloff of a rectilinear lens.
  float natural = pow(cos(clamp(r * 1.15, 0.0, 1.5)), 4.0);
  float artistic = 1.0 - smoothstep(0.45, 1.05, r);
  display *= mix(1.0, mix(natural, artistic, 0.45), vignetteAmount);

  /* --- unsharp mask ---
     Four taps of the *scene* rather than the graded result, so the mask keys
     off real detail and not off vignette or grain. */
  if (sharpenAmount > 0.001) {
    float c = gLuma(texture2D(inputBuffer, uv).rgb);
    float n1 = gLuma(texture2D(inputBuffer, uv + vec2(gTexel.x, 0.0)).rgb);
    float n2 = gLuma(texture2D(inputBuffer, uv - vec2(gTexel.x, 0.0)).rgb);
    float n3 = gLuma(texture2D(inputBuffer, uv + vec2(0.0, gTexel.y)).rgb);
    float n4 = gLuma(texture2D(inputBuffer, uv - vec2(0.0, gTexel.y)).rgb);
    float highPass = c - (n1 + n2 + n3 + n4) * 0.25;
    display += clamp(highPass, -0.12, 0.12) * sharpenAmount;
  }

  /* --- film grain ---
     Real grain is strongest in the midtones: highlights are fully exposed and
     shadows have no developed silver. A uniform overlay looks like video noise. */
  if (grainAmount > 0.001) {
    float l = gLuma(display);
    float response = 4.0 * l * (1.0 - l);
    float n = sfHash12(gl_FragCoord.xy * 1.37 + fract(gTime) * 613.0) - 0.5;
    float n2 = sfHash12(gl_FragCoord.xy * 0.61 - fract(gTime * 0.7) * 271.0) - 0.5;
    display += (n * 0.7 + n2 * 0.3) * grainAmount * 0.075 * (0.25 + response);
  }

  /* --- flash --- */
  display = mix(display, vec3(1.0), clamp(flashAmount, 0.0, 1.0));

  // Back to linear: postprocessing applies the output transfer function itself
  // when this pass renders to the screen.
  outputColor = vec4(gSrgbToLinear(clamp(display, 0.0, 1.0)), inputColor.a);
}
`;

export interface GradeOptions {
  lut?: BlendableLut;
  dirtTexture?: THREE.Texture | null;
  /**
   * The bloom pyramid. It lives here rather than in its own pass because it
   * must read exactly the buffer this effect is about to grade — the
   * defocused, motion-blurred, temporally-resolved one — and because running it
   * from `update()` costs no extra full-resolution round trip.
   */
  bloom?: BloomPyramid | null;
}

/**
 * A 1x1 black texture. A `sampler2D` uniform left at null is undefined
 * behaviour in WebGL, not "reads as black" — on some drivers it samples
 * whatever texture happened to be bound to that unit last.
 */
function makeBlackTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

export class GradeEffect extends Effect {
  readonly lut: BlendableLut;
  readonly bloom: BloomPyramid | null;
  private readonly black: THREE.DataTexture;

  private width = 1;
  private height = 1;

  constructor(options: GradeOptions = {}) {
    const lut = options.lut ?? new BlendableLut(LUT_SIZE);

    const uniforms = new Map<string, THREE.Uniform>([
      ["bloomTex", new THREE.Uniform(null)],
      ["flareTex", new THREE.Uniform(null)],
      ["streakTex", new THREE.Uniform(null)],
      ["dirtTex", new THREE.Uniform(options.dirtTexture ?? null)],
      ["lutTex", new THREE.Uniform(lut.texture)],

      ["bloomAmount", new THREE.Uniform(1)],
      ["flareAmount", new THREE.Uniform(0.5)],
      ["streakAmount", new THREE.Uniform(0.35)],
      ["dirtAmount", new THREE.Uniform(0.5)],

      ["gExposure", new THREE.Uniform(1)],
      ["lutSize", new THREE.Uniform(lut.size)],
      ["lutAmount", new THREE.Uniform(1)],

      ["grainAmount", new THREE.Uniform(0.55)],
      ["caAmount", new THREE.Uniform(0.6)],
      ["vignetteAmount", new THREE.Uniform(0.65)],
      ["sharpenAmount", new THREE.Uniform(0.25)],

      ["damageAmount", new THREE.Uniform(0)],
      ["damageVec", new THREE.Uniform(new THREE.Vector2(0, -1))],
      ["lowHealthAmount", new THREE.Uniform(0)],
      ["flashAmount", new THREE.Uniform(0)],

      ["speedAmount", new THREE.Uniform(0)],
      ["underwaterAmount", new THREE.Uniform(0)],
      ["nightVisionAmount", new THREE.Uniform(0)],
      ["thermalAmount", new THREE.Uniform(0)],

      ["gTime", envUniforms.time],
      ["gTexel", envUniforms.texelSize],
      ["gAspect", new THREE.Uniform(1.777)],

      ["logFC", envUniforms.logDepthFC],
      ["camNear", envUniforms.near],
      ["camFar", envUniforms.far],
      ["invProjection", envUniforms.inverseProjection],
      ["camWorld", envUniforms.cameraMatrixWorld],
    ]);

    super("SfGrade", gradeFrag, {
      // CONVOLUTION because chromatic aberration, the speed blur and the
      // unsharp mask all reach outside the current texel. DEPTH for the
      // underwater absorption and the thermal falloff.
      attributes: EffectAttribute.CONVOLUTION | EffectAttribute.DEPTH,
      blendFunction: BlendFunction.NORMAL,
      uniforms,
    });

    this.lut = lut;
    this.bloom = options.bloom ?? null;
    this.black = makeBlackTexture();
    if (!this.bloom) {
      // Bloom disabled by the quality tier: bind something valid and turn the
      // composite off rather than leaving three samplers dangling.
      this.uniforms.get("bloomTex")!.value = this.black;
      this.uniforms.get("flareTex")!.value = this.black;
      this.uniforms.get("streakTex")!.value = this.black;
      this.uniforms.get("bloomAmount")!.value = 0;
      this.uniforms.get("flareAmount")!.value = 0;
      this.uniforms.get("streakAmount")!.value = 0;
    }
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.uniforms.get("gAspect")!.value = width / Math.max(1, height);
    if (this.bloom) this.bloom.setSize(width, height);
  }

  update(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget): void {
    if (!this.bloom) return;
    this.bloom.update(renderer, inputBuffer.texture, this.width, this.height);
    // The flare and streak buffers are optional; when they are off we point the
    // samplers at the bloom texture and zero their amounts, because a null
    // sampler2D is undefined behaviour, not "black".
    const bloomTexture = this.bloom.texture;
    this.uniforms.get("bloomTex")!.value = bloomTexture;
    this.uniforms.get("flareTex")!.value = this.bloom.flareTexture ?? bloomTexture;
    this.uniforms.get("streakTex")!.value = this.bloom.streakTexture ?? bloomTexture;
    if (!this.bloom.flareTexture) this.uniforms.get("flareAmount")!.value = 0;
    if (!this.bloom.streakTexture) this.uniforms.get("streakAmount")!.value = 0;
  }

  /** Convenience accessor used by the pipeline's per-frame sync. */
  u(name: string): THREE.Uniform {
    return this.uniforms.get(name)!;
  }

  dispose(): void {
    this.lut.dispose();
    this.bloom?.dispose();
    this.black.dispose();
    super.dispose();
  }
}
