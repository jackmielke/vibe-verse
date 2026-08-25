/**
 * Bloom, lens flare and anamorphic streaks.
 *
 * The cheap version of this effect — blur everything above 0.7 and add it back
 * — is why so many games look like they were shot through a dirty sock. Real
 * bloom is a *point spread function*: light that should have landed on one
 * sensel scatters into its neighbours, so the total energy is conserved and
 * only genuinely over-range values (above 1.0 in HDR, i.e. things that would
 * actually clip) produce a visible veil.
 *
 * The chain here is the Call of Duty / Jimenez one:
 *   - a soft-knee threshold at 1.0 with a Karis average, which kills the
 *     single-pixel fireflies that a specular highlight on a wet road throws off
 *     and that would otherwise strobe through the whole pyramid;
 *   - a 13-tap downsample pyramid;
 *   - a 3×3 tent upsample accumulating back up the chain, which gives a wide,
 *     smooth, *scale-invariant* falloff instead of a stack of visible gaussians.
 *
 * Plus two optional extras, both driven from the same thresholded buffer:
 * chromatically-dispersed ghosts and a halo (a real lens's internal
 * reflections), and a horizontal anamorphic streak for muzzle flashes and the
 * sun.
 */
import * as THREE from "three";
import { FULLSCREEN_VERT } from "./glsl";
import { blit, makeHdrTarget } from "./fullscreen";

const MAX_MIPS = 7;

const prefilterFrag = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uSoftKnee;
uniform float uClamp;
varying vec2 vUv;

float maxComponent(const in vec3 c) { return max(c.r, max(c.g, c.b)); }

/**
 * Karis average: weight each sub-group by 1/(1+luma) before averaging. Without
 * it a single pixel at 400 nits survives every downsample and pulses across the
 * screen; with it, the same pixel contributes its fair share and no more.
 */
vec3 karis(const in vec3 a, const in vec3 b, const in vec3 c, const in vec3 d) {
  float wa = 1.0 / (1.0 + maxComponent(a));
  float wb = 1.0 / (1.0 + maxComponent(b));
  float wc = 1.0 / (1.0 + maxComponent(c));
  float wd = 1.0 / (1.0 + maxComponent(d));
  return (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
}

void main() {
  vec2 o = uTexel;
  vec3 a = texture2D(tInput, vUv + vec2(-o.x, -o.y)).rgb;
  vec3 b = texture2D(tInput, vUv + vec2( o.x, -o.y)).rgb;
  vec3 c = texture2D(tInput, vUv + vec2(-o.x,  o.y)).rgb;
  vec3 d = texture2D(tInput, vUv + vec2( o.x,  o.y)).rgb;
  vec3 color = karis(a, b, c, d);
  color = min(color, vec3(uClamp));

  // Soft-knee threshold. A hard cut at 1.0 makes the bloom pop in and out as a
  // highlight crosses the line; the quadratic knee fades it in over a stop.
  float knee = max(uThreshold * uSoftKnee, 1e-4);
  float br = maxComponent(color);
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contribution = max(soft, br - uThreshold) / max(br, 1e-4);

  gl_FragColor = vec4(color * contribution, 1.0);
}
`;

/** The 13-tap "dual filter" downsample — no aliasing, no ringing, 13 taps. */
const downsampleFrag = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uTexel;
varying vec2 vUv;

void main() {
  vec2 o = uTexel;
  vec3 a = texture2D(tInput, vUv + vec2(-2.0 * o.x,  2.0 * o.y)).rgb;
  vec3 b = texture2D(tInput, vUv + vec2( 0.0,        2.0 * o.y)).rgb;
  vec3 c = texture2D(tInput, vUv + vec2( 2.0 * o.x,  2.0 * o.y)).rgb;
  vec3 d = texture2D(tInput, vUv + vec2(-2.0 * o.x,  0.0)).rgb;
  vec3 e = texture2D(tInput, vUv).rgb;
  vec3 f = texture2D(tInput, vUv + vec2( 2.0 * o.x,  0.0)).rgb;
  vec3 g = texture2D(tInput, vUv + vec2(-2.0 * o.x, -2.0 * o.y)).rgb;
  vec3 h = texture2D(tInput, vUv + vec2( 0.0,       -2.0 * o.y)).rgb;
  vec3 i = texture2D(tInput, vUv + vec2( 2.0 * o.x, -2.0 * o.y)).rgb;
  vec3 j = texture2D(tInput, vUv + vec2(-o.x,  o.y)).rgb;
  vec3 k = texture2D(tInput, vUv + vec2( o.x,  o.y)).rgb;
  vec3 l = texture2D(tInput, vUv + vec2(-o.x, -o.y)).rgb;
  vec3 m = texture2D(tInput, vUv + vec2( o.x, -o.y)).rgb;

  vec3 result = e * 0.125;
  result += (a + c + g + i) * 0.03125;
  result += (b + d + f + h) * 0.0625;
  result += (j + k + l + m) * 0.125;
  gl_FragColor = vec4(result, 1.0);
}
`;

/** 3×3 tent upsample, additively accumulated into the next-larger mip. */
const upsampleFrag = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uScatter;
varying vec2 vUv;

void main() {
  vec2 o = uTexel;
  vec3 s = texture2D(tInput, vUv + vec2(-o.x,  o.y)).rgb * 1.0;
  s += texture2D(tInput, vUv + vec2( 0.0,  o.y)).rgb * 2.0;
  s += texture2D(tInput, vUv + vec2( o.x,  o.y)).rgb * 1.0;
  s += texture2D(tInput, vUv + vec2(-o.x,  0.0)).rgb * 2.0;
  s += texture2D(tInput, vUv).rgb * 4.0;
  s += texture2D(tInput, vUv + vec2( o.x,  0.0)).rgb * 2.0;
  s += texture2D(tInput, vUv + vec2(-o.x, -o.y)).rgb * 1.0;
  s += texture2D(tInput, vUv + vec2( 0.0, -o.y)).rgb * 2.0;
  s += texture2D(tInput, vUv + vec2( o.x, -o.y)).rgb * 1.0;
  gl_FragColor = vec4(s * (1.0 / 16.0) * uScatter, 1.0);
}
`;

/**
 * Ghosts and halo.
 *
 * A real lens produces ghosts by reflecting the image between element surfaces:
 * the ghost is the *inverted* image scaled toward the optical axis, and each
 * bounce disperses slightly differently per wavelength. Sampling the same
 * thresholded buffer at inverted, scaled UVs with a small per-channel offset
 * reproduces that almost exactly, for the cost of a handful of taps.
 */
const flareFrag = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uDispersal;
uniform float uHaloWidth;
uniform float uChroma;
uniform float uStrength;
varying vec2 vUv;

vec3 sampleChromatic(const in vec2 uv, const in vec2 dir, const in float amount) {
  vec3 c;
  c.r = texture2D(tInput, uv + dir * amount).r;
  c.g = texture2D(tInput, uv).g;
  c.b = texture2D(tInput, uv - dir * amount).b;
  return c;
}

void main() {
  vec2 uv = 1.0 - vUv; // the ghost image is inverted through the optical axis
  vec2 toCenter = vec2(0.5) - uv;
  vec2 ghostVec = toCenter * uDispersal;
  vec2 chromaDir = normalize(toCenter + 1e-6) * uChroma;

  vec3 result = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    vec2 offset = fract(uv + ghostVec * float(i));
    // Weight ghosts by how close they are to the centre — the further out the
    // reflection lands, the more it has spread and the dimmer it is.
    float w = length(vec2(0.5) - offset) / length(vec2(0.5));
    w = pow(1.0 - w, 8.0);
    result += sampleChromatic(offset, chromaDir, 1.0) * w;
  }

  // Halo: a single ring-shaped ghost at fixed radius.
  vec2 haloVec = normalize(toCenter + 1e-6) * uHaloWidth;
  float halo = length(vec2(0.5) - fract(uv + haloVec)) / length(vec2(0.5));
  halo = pow(1.0 - halo, 6.0);
  result += sampleChromatic(fract(uv + haloVec), chromaDir, 1.0) * halo;

  gl_FragColor = vec4(result * uStrength, 1.0);
}
`;

/** Wide horizontal-only blur — the anamorphic streak off a bright source. */
const streakFrag = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uStride;
uniform vec3 uTint;
varying vec2 vUv;

void main() {
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = -8; i <= 8; i++) {
    float fi = float(i);
    float w = exp(-fi * fi * 0.045);
    sum += texture2D(tInput, vUv + vec2(uTexel.x * fi * uStride, 0.0)).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum / wsum * uTint, 1.0);
}
`;

export interface BloomOptions {
  /** HDR threshold. Keep it at or just below 1.0 — that is the point. */
  threshold?: number;
  /** Knee width as a fraction of the threshold. */
  softKnee?: number;
  /** Upsample scatter, 0..1. Higher = wider, softer veil. */
  scatter?: number;
  /** Hard clamp on input radiance, to bound a single insane sample. */
  clamp?: number;
  mips?: number;
  lensFlare?: boolean;
  anamorphic?: boolean;
}

/**
 * The pyramid itself. Deliberately *not* an `Effect`: the final grade owns the
 * composite so that chromatic aberration, speed lines and the tonemap all
 * operate on an image that already contains the bloom, instead of each of them
 * silently sampling a pre-bloom buffer.
 */
export class BloomPyramid {
  /** Full-strength bloom at half resolution. */
  get texture(): THREE.Texture {
    return this.mips[0].texture;
  }
  /** Lens-flare ghosts + halo, quarter resolution. Null when disabled. */
  get flareTexture(): THREE.Texture | null {
    return this.flareEnabled ? this.flareTarget.texture : null;
  }
  /** Anamorphic streak, quarter resolution. Null when disabled. */
  get streakTexture(): THREE.Texture | null {
    return this.streakEnabled ? this.streakA.texture : null;
  }

  private prefilterTarget: THREE.WebGLRenderTarget;
  private mips: THREE.WebGLRenderTarget[] = [];
  private flareTarget: THREE.WebGLRenderTarget;
  private streakA: THREE.WebGLRenderTarget;
  private streakB: THREE.WebGLRenderTarget;

  private prefilterMaterial: THREE.ShaderMaterial;
  private downsampleMaterial: THREE.ShaderMaterial;
  private upsampleMaterial: THREE.ShaderMaterial;
  private flareMaterial: THREE.ShaderMaterial;
  private streakMaterial: THREE.ShaderMaterial;

  private mipCount: number;
  private activeMips = 1;
  private flareEnabled: boolean;
  private streakEnabled: boolean;

  constructor(options: BloomOptions = {}) {
    this.mipCount = Math.min(MAX_MIPS, options.mips ?? 6);
    this.flareEnabled = options.lensFlare ?? true;
    this.streakEnabled = options.anamorphic ?? true;

    this.prefilterTarget = makeHdrTarget(1, 1, "SfBloomPrefilter");
    for (let i = 0; i < this.mipCount; i++) {
      this.mips.push(makeHdrTarget(1, 1, `SfBloomMip${i}`));
    }
    this.flareTarget = makeHdrTarget(1, 1, "SfBloomFlare");
    this.streakA = makeHdrTarget(1, 1, "SfBloomStreakA");
    this.streakB = makeHdrTarget(1, 1, "SfBloomStreakB");

    this.prefilterMaterial = new THREE.ShaderMaterial({
      name: "SfBloomPrefilter",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: prefilterFrag,
      uniforms: {
        tInput: { value: null as THREE.Texture | null },
        uTexel: { value: new THREE.Vector2() },
        uThreshold: { value: options.threshold ?? 1.0 },
        uSoftKnee: { value: options.softKnee ?? 0.55 },
        uClamp: { value: options.clamp ?? 64 },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.downsampleMaterial = new THREE.ShaderMaterial({
      name: "SfBloomDownsample",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: downsampleFrag,
      uniforms: {
        tInput: { value: null as THREE.Texture | null },
        uTexel: { value: new THREE.Vector2() },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.upsampleMaterial = new THREE.ShaderMaterial({
      name: "SfBloomUpsample",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: upsampleFrag,
      uniforms: {
        tInput: { value: null as THREE.Texture | null },
        uTexel: { value: new THREE.Vector2() },
        uScatter: { value: options.scatter ?? 0.72 },
      },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      // Additive accumulation back up the pyramid. One-one blending on a
      // half-float target is exact; no intermediate copy needed.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });

    this.flareMaterial = new THREE.ShaderMaterial({
      name: "SfBloomFlare",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: flareFrag,
      uniforms: {
        tInput: { value: null as THREE.Texture | null },
        uTexel: { value: new THREE.Vector2() },
        uDispersal: { value: 0.31 },
        uHaloWidth: { value: 0.46 },
        uChroma: { value: 0.012 },
        /* The ghost image is the thresholded frame inverted through the optical
           axis, so a bright sky at the top of the screen ghosts to the *bottom*
           of it — which in a third-person game is exactly where the car you are
           driving is. At 0.55 that put a blown white blob and a rainbow arc
           across the vehicle on any street facing the sun, which reads as a
           rendering fault rather than as a lens. Kept, because a real lens does
           this, but at a strength where it flatters the frame instead of
           eating it. */
        uStrength: { value: 0.18 },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.streakMaterial = new THREE.ShaderMaterial({
      name: "SfBloomStreak",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: streakFrag,
      uniforms: {
        tInput: { value: null as THREE.Texture | null },
        uTexel: { value: new THREE.Vector2() },
        uStride: { value: 1 },
        uTint: { value: new THREE.Vector3(0.55, 0.72, 1.4) },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
  }

  set threshold(v: number) {
    this.prefilterMaterial.uniforms.uThreshold.value = v;
  }
  set scatter(v: number) {
    this.upsampleMaterial.uniforms.uScatter.value = v;
  }
  set flareStrength(v: number) {
    this.flareMaterial.uniforms.uStrength.value = v;
  }

  setSize(width: number, height: number): void {
    let w = Math.max(1, width >> 1);
    let h = Math.max(1, height >> 1);
    this.prefilterTarget.setSize(w, h);

    this.activeMips = 1;
    for (let i = 0; i < this.mipCount; i++) {
      this.mips[i].setSize(Math.max(1, w), Math.max(1, h));
      if (w > 8 && h > 8) this.activeMips = i + 1;
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    this.activeMips = Math.max(2, Math.min(this.mipCount, this.activeMips));

    const qw = Math.max(1, width >> 2);
    const qh = Math.max(1, height >> 2);
    this.flareTarget.setSize(qw, qh);
    this.streakA.setSize(qw, qh);
    this.streakB.setSize(qw, qh);
  }

  update(renderer: THREE.WebGLRenderer, input: THREE.Texture, inputWidth: number, inputHeight: number): void {
    // --- threshold ---
    this.prefilterMaterial.uniforms.tInput.value = input;
    (this.prefilterMaterial.uniforms.uTexel.value as THREE.Vector2).set(
      1 / inputWidth,
      1 / inputHeight,
    );
    blit(renderer, this.prefilterMaterial, this.prefilterTarget);

    // --- downsample chain ---
    let src = this.prefilterTarget;
    for (let i = 0; i < this.activeMips; i++) {
      this.downsampleMaterial.uniforms.tInput.value = src.texture;
      (this.downsampleMaterial.uniforms.uTexel.value as THREE.Vector2).set(
        1 / src.width,
        1 / src.height,
      );
      blit(renderer, this.downsampleMaterial, this.mips[i]);
      src = this.mips[i];
    }

    // --- upsample chain, additive ---
    for (let i = this.activeMips - 1; i > 0; i--) {
      const from = this.mips[i];
      const to = this.mips[i - 1];
      this.upsampleMaterial.uniforms.tInput.value = from.texture;
      (this.upsampleMaterial.uniforms.uTexel.value as THREE.Vector2).set(
        1 / from.width,
        1 / from.height,
      );
      blit(renderer, this.upsampleMaterial, to);
    }

    // --- lens flare from the thresholded buffer ---
    if (this.flareEnabled) {
      this.flareMaterial.uniforms.tInput.value = this.mips[1].texture;
      (this.flareMaterial.uniforms.uTexel.value as THREE.Vector2).set(
        1 / this.mips[1].width,
        1 / this.mips[1].height,
      );
      blit(renderer, this.flareMaterial, this.flareTarget);
    }

    // --- anamorphic streak: two horizontal passes at increasing stride ---
    if (this.streakEnabled) {
      this.streakMaterial.uniforms.tInput.value = this.mips[1].texture;
      (this.streakMaterial.uniforms.uTexel.value as THREE.Vector2).set(
        1 / this.streakA.width,
        1 / this.streakA.height,
      );
      this.streakMaterial.uniforms.uStride.value = 2;
      blit(renderer, this.streakMaterial, this.streakB);
      this.streakMaterial.uniforms.tInput.value = this.streakB.texture;
      this.streakMaterial.uniforms.uStride.value = 9;
      blit(renderer, this.streakMaterial, this.streakA);
    }
  }

  dispose(): void {
    this.prefilterTarget.dispose();
    for (const m of this.mips) m.dispose();
    this.flareTarget.dispose();
    this.streakA.dispose();
    this.streakB.dispose();
    this.prefilterMaterial.dispose();
    this.downsampleMaterial.dispose();
    this.upsampleMaterial.dispose();
    this.flareMaterial.dispose();
    this.streakMaterial.dispose();
  }
}
