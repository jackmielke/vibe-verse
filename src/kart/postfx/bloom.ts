/**
 * Bloom — a progressive downsample / tent-upsample pyramid.
 *
 * The naive version ("blur everything above 0.8, add it back") is why so many
 * games look like they were filmed through a greasy window. Real bloom is a
 * point-spread function: light that should have landed on one sensel scatters
 * into its neighbours. Energy is conserved, and only values that would actually
 * clip produce a visible veil.
 *
 * The chain is the Call of Duty / Jimenez one:
 *   · a soft-knee threshold with a Karis average, which kills the single-pixel
 *     fireflies a drift spark throws off and that would otherwise strobe up the
 *     whole pyramid;
 *   · a 13-tap downsample, which is aliasing-free at a 2× ratio;
 *   · a 3×3 tent upsample accumulated back up the chain, which gives a wide,
 *     *scale-invariant* falloff instead of a stack of visible gaussians.
 *
 * Tuned for an arcade racer rather than a film: the veil is tinted warm, and
 * the threshold sits just under 1.0 so boost flames, coins, item-box glow and
 * the sun all cross it while white kerb paint does not.
 */
import * as THREE from "three";
import { PF_COLOR, PF_VERT } from "./glsl";
import { Blitter, disposeTarget, fullscreenMaterial, makeTarget, resizeTarget, type PostFxCaps } from "./targets";

const MAX_MIPS = 6;

const prefilterFrag = /* glsl */ `
precision highp float;
${PF_COLOR}
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uSoftKnee;
uniform float uClamp;
uniform float uEncode;
varying vec2 vUv;

/**
 * Karis average — weight each sub-group by 1/(1+luma) before averaging.
 *
 * Without it, one pixel of a spark at 300 nits survives every downsample and
 * pulses across a quarter of the screen. With it, that pixel contributes its
 * fair share of energy and no more.
 */
vec3 karis(const in vec3 a, const in vec3 b, const in vec3 c, const in vec3 d) {
  float wa = 1.0 / (1.0 + pfMaxC(a));
  float wb = 1.0 / (1.0 + pfMaxC(b));
  float wc = 1.0 / (1.0 + pfMaxC(c));
  float wd = 1.0 / (1.0 + pfMaxC(d));
  return (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
}

void main() {
  vec2 o = uTexel;
  // Sanitising here and only here: this is the single entry point to the
  // pyramid, so one NaN scrub protects every mip below it.
  vec3 a = pfSanitize(texture2D(tInput, vUv + vec2(-o.x, -o.y)).rgb);
  vec3 b = pfSanitize(texture2D(tInput, vUv + vec2( o.x, -o.y)).rgb);
  vec3 c = pfSanitize(texture2D(tInput, vUv + vec2(-o.x,  o.y)).rgb);
  vec3 d = pfSanitize(texture2D(tInput, vUv + vec2( o.x,  o.y)).rgb);
  vec3 color = min(karis(a, b, c, d), vec3(uClamp));

  // Soft-knee threshold. A hard cut makes bloom pop in and out as a highlight
  // drifts across the line; the quadratic knee fades it in over about a stop.
  float knee = max(uThreshold * uSoftKnee, 1e-4);
  float br = pfMaxC(color);
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contribution = max(soft, br - uThreshold) / max(br, 1e-4);

  gl_FragColor = vec4(color * contribution * uEncode, 1.0);
}
`;

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

const upsampleFrag = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uScatter;
varying vec2 vUv;

void main() {
  vec2 o = uTexel;
  vec3 s = texture2D(tInput, vUv + vec2(-o.x,  o.y)).rgb;
  s += texture2D(tInput, vUv + vec2( 0.0,  o.y)).rgb * 2.0;
  s += texture2D(tInput, vUv + vec2( o.x,  o.y)).rgb;
  s += texture2D(tInput, vUv + vec2(-o.x,  0.0)).rgb * 2.0;
  s += texture2D(tInput, vUv).rgb * 4.0;
  s += texture2D(tInput, vUv + vec2( o.x,  0.0)).rgb * 2.0;
  s += texture2D(tInput, vUv + vec2(-o.x, -o.y)).rgb;
  s += texture2D(tInput, vUv + vec2( 0.0, -o.y)).rgb * 2.0;
  s += texture2D(tInput, vUv + vec2( o.x, -o.y)).rgb;
  gl_FragColor = vec4(s * (1.0 / 16.0) * uScatter, 1.0);
}
`;

export interface BloomOptions {
  /** HDR threshold. At or just under 1.0 — that is the whole point of HDR. */
  threshold?: number;
  /** Knee width as a fraction of the threshold. */
  softKnee?: number;
  /** Upsample scatter 0..1. Higher is wider and softer. */
  scatter?: number;
  /** Hard ceiling on input radiance, so one insane sample cannot dominate. */
  clamp?: number;
  /** Number of mips; each is half the linear size of the one above. */
  mips?: number;
}

export class BloomPyramid {
  /** The finished veil, at half resolution. */
  get texture(): THREE.Texture {
    return this.mips[0].texture;
  }
  /** Multiply this back in at composite time — see `PostFxCaps.bloomEncode`. */
  readonly decode: number;

  private readonly prefilterTarget: THREE.WebGLRenderTarget;
  private readonly mips: THREE.WebGLRenderTarget[] = [];
  private readonly prefilterMaterial: THREE.ShaderMaterial;
  private readonly downsampleMaterial: THREE.ShaderMaterial;
  private readonly upsampleMaterial: THREE.ShaderMaterial;
  private readonly mipCount: number;
  private activeMips = 2;

  constructor(caps: PostFxCaps, options: BloomOptions = {}) {
    this.mipCount = Math.max(2, Math.min(MAX_MIPS, options.mips ?? 6));
    this.decode = 1 / caps.bloomEncode;

    this.prefilterTarget = makeTarget(1, 1, "KartBloomPrefilter", caps);
    for (let i = 0; i < this.mipCount; i++) {
      this.mips.push(makeTarget(1, 1, `KartBloomMip${i}`, caps));
    }

    this.prefilterMaterial = fullscreenMaterial(
      "KartBloomPrefilter",
      prefilterFrag,
      {
        tInput: { value: null },
        uTexel: { value: new THREE.Vector2() },
        // An 8-bit chain has to threshold lower: three never tone maps into a
        // render target, so an LDR scene buffer clips at 1.0 and there is no
        // "above white" left to find.
        uThreshold: { value: options.threshold ?? (caps.halfFloat ? 1.0 : 0.62) },
        uSoftKnee: { value: options.softKnee ?? 0.6 },
        uClamp: { value: options.clamp ?? 48 },
        uEncode: { value: caps.bloomEncode },
      },
      PF_VERT,
    );

    this.downsampleMaterial = fullscreenMaterial(
      "KartBloomDownsample",
      downsampleFrag,
      { tInput: { value: null }, uTexel: { value: new THREE.Vector2() } },
      PF_VERT,
    );

    this.upsampleMaterial = fullscreenMaterial(
      "KartBloomUpsample",
      upsampleFrag,
      {
        tInput: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uScatter: { value: options.scatter ?? 0.76 },
      },
      PF_VERT,
    );
    // Additive accumulation back up the pyramid. One-one blending is exact on a
    // half-float target; on 8-bit it is why `uEncode` exists.
    this.upsampleMaterial.blending = THREE.CustomBlending;
    this.upsampleMaterial.blendEquation = THREE.AddEquation;
    this.upsampleMaterial.blendSrc = THREE.OneFactor;
    this.upsampleMaterial.blendDst = THREE.OneFactor;
  }

  set threshold(v: number) {
    this.prefilterMaterial.uniforms.uThreshold.value = v;
  }

  set scatter(v: number) {
    this.upsampleMaterial.uniforms.uScatter.value = v;
  }

  setSize(width: number, height: number): void {
    let w = Math.max(1, width >> 1);
    let h = Math.max(1, height >> 1);
    resizeTarget(this.prefilterTarget, w, h);

    this.activeMips = 1;
    for (let i = 0; i < this.mipCount; i++) {
      resizeTarget(this.mips[i], w, h);
      // Stop pyramiding once a mip is smaller than a tent kernel — below about
      // 8 px the upsample reads mostly clamped edge texels and the veil starts
      // to acquire a visible square.
      if (w > 8 && h > 8) this.activeMips = i + 1;
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    this.activeMips = Math.max(2, Math.min(this.mipCount, this.activeMips));
  }

  render(
    renderer: THREE.WebGLRenderer,
    blitter: Blitter,
    input: THREE.Texture,
    inputWidth: number,
    inputHeight: number,
  ): void {
    this.prefilterMaterial.uniforms.tInput.value = input;
    (this.prefilterMaterial.uniforms.uTexel.value as THREE.Vector2).set(
      1 / Math.max(1, inputWidth),
      1 / Math.max(1, inputHeight),
    );
    blitter.draw(renderer, this.prefilterMaterial, this.prefilterTarget);

    let src = this.prefilterTarget;
    for (let i = 0; i < this.activeMips; i++) {
      this.downsampleMaterial.uniforms.tInput.value = src.texture;
      (this.downsampleMaterial.uniforms.uTexel.value as THREE.Vector2).set(
        1 / src.width,
        1 / src.height,
      );
      blitter.draw(renderer, this.downsampleMaterial, this.mips[i]);
      src = this.mips[i];
    }

    for (let i = this.activeMips - 1; i > 0; i--) {
      const from = this.mips[i];
      this.upsampleMaterial.uniforms.tInput.value = from.texture;
      (this.upsampleMaterial.uniforms.uTexel.value as THREE.Vector2).set(
        1 / from.width,
        1 / from.height,
      );
      blitter.draw(renderer, this.upsampleMaterial, this.mips[i - 1]);
    }
  }

  dispose(): void {
    disposeTarget(this.prefilterTarget);
    for (const m of this.mips) disposeTarget(m);
    this.prefilterMaterial.dispose();
    this.downsampleMaterial.dispose();
    this.upsampleMaterial.dispose();
  }
}
