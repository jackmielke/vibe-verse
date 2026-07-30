/**
 * Temporal anti-aliasing.
 *
 * The scene is rendered with a sub-pixel jittered projection; this pass folds
 * each new sample into an accumulated history, reprojected through the velocity
 * buffer. Done properly it is not just cheap AA — it is the thing that makes
 * every stochastic effect in the pipeline (AO, SSR, volumetrics, all of which
 * are one-sample-per-pixel-per-frame) resolve to something clean.
 *
 * The three parts that separate working TAA from a smeary mess:
 *
 *  - **Neighbourhood clamping.** The history is clipped into the AABB of the
 *    current 3×3 neighbourhood in YCoCg. Chroma-separated clipping keeps
 *    saturated edges (a red tail light against grey asphalt) from either
 *    ghosting or flickering.
 *  - **Velocity dilation.** The velocity of the *closest* pixel in the
 *    neighbourhood is used, not the centre one, so silhouettes reproject with
 *    the foreground object instead of tearing.
 *  - **Disocclusion rejection.** The history carries the linear depth it was
 *    written with; when the reprojected depth disagrees, the history is
 *    discarded and the pixel restarts from the current frame.
 *
 * Convergence: for the first frames after a reset the blend weight is
 * `1/(n+1)` — a true running average, which reaches the exact mean of the
 * jitter sequence after exactly `n` frames rather than asymptotically. That is
 * why the offline screenshot harness gets a clean still after ~12 frames
 * instead of a soft one after forty.
 */
import * as THREE from "three";
import { Pass } from "postprocessing";
import { envUniforms } from "./env";
import { FULLSCREEN_VERT, GLSL_COLOR, GLSL_DEPTH } from "./glsl";
import { makeHdrTarget } from "./fullscreen";
import { postfx } from "./state";

/* ------------------------------------------------------------------ *
 * Jitter
 * ------------------------------------------------------------------ */

/** Radical-inverse (van der Corput) in an arbitrary base. */
function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/**
 * Halton(2,3) offsets in [-0.5, 0.5] pixels. Sixteen samples is the sweet spot:
 * eight is visibly under-sampled on a near-horizontal roofline, thirty-two
 * takes too long to converge for a game that is mostly in motion.
 */
export function makeJitterSequence(count: number): Float32Array {
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    out[i * 2 + 0] = halton(i + 1, 2) - 0.5;
    out[i * 2 + 1] = halton(i + 1, 3) - 0.5;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Resolve
 * ------------------------------------------------------------------ */

const resolveFrag = /* glsl */ `
precision highp float;
${GLSL_DEPTH}
${GLSL_COLOR}

uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tVelocity;
uniform vec2 uTexel;
uniform float uFeedback;      // steady-state history weight
uniform float uAccumFrames;   // frames of valid history
uniform float uClampGamma;    // neighbourhood variance width
uniform float uReset;         // 1 = ignore history entirely

varying vec2 vUv;

/**
 * Catmull-Rom history fetch, five bilinear taps.
 *
 * Sampling the history bilinearly at a fractional offset is a low-pass filter
 * applied once per frame, forever: the image gets softer every frame it stands
 * still. A cubic filter puts the sharpness back without the cost of nine taps.
 */
vec4 sampleHistoryCatmullRom(const in vec2 uv) {
  vec2 texSize = 1.0 / uTexel;
  vec2 samplePos = uv * texSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;

  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);

  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / w12;

  vec2 texPos0 = (texPos1 - 1.0) * uTexel;
  vec2 texPos3 = (texPos1 + 2.0) * uTexel;
  vec2 texPos12 = (texPos1 + offset12) * uTexel;

  vec4 result = vec4(0.0);
  result += texture2D(tHistory, vec2(texPos12.x, texPos0.y)) * (w12.x * w0.y);
  result += texture2D(tHistory, vec2(texPos0.x, texPos12.y)) * (w0.x * w12.y);
  result += texture2D(tHistory, vec2(texPos12.x, texPos12.y)) * (w12.x * w12.y);
  result += texture2D(tHistory, vec2(texPos3.x, texPos12.y)) * (w3.x * w12.y);
  result += texture2D(tHistory, vec2(texPos12.x, texPos3.y)) * (w12.x * w3.y);
  float total = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return result / max(total, 1e-5);
}

void main() {
  vec2 uv = vUv;

  /* ---- velocity dilation: take the closest surface in the 3x3 ---- */
  float closestDepth = 1e30;
  vec2 closestOffset = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * uTexel;
      float d = -sfSampleViewZ(uv + o);
      if (d < closestDepth) {
        closestDepth = d;
        closestOffset = o;
      }
    }
  }
  vec2 velocity = texture2D(tVelocity, uv + closestOffset).xy;
  vec2 prevUv = uv - velocity;

  /* ---- current neighbourhood statistics in YCoCg ---- */
  vec3 m1 = vec3(0.0);
  vec3 m2 = vec3(0.0);
  vec3 neighbourMin = vec3(1e30);
  vec3 neighbourMax = vec3(-1e30);
  vec4 centerSample = vec4(0.0);

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * uTexel;
      vec4 c = texture2D(tCurrent, uv + o);
      // Weight in a tonemapped space so a single fireflying HDR sample cannot
      // drag the whole neighbourhood's variance to infinity.
      vec3 ycocg = sfRGBToYCoCg(sfToneWeight(max(c.rgb, 0.0)));
      m1 += ycocg;
      m2 += ycocg * ycocg;
      neighbourMin = min(neighbourMin, ycocg);
      neighbourMax = max(neighbourMax, ycocg);
      if (x == 0 && y == 0) centerSample = c;
    }
  }

  vec3 mean = m1 / 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - mean * mean, 0.0));
  vec3 boxMin = max(mean - uClampGamma * sigma, neighbourMin);
  vec3 boxMax = min(mean + uClampGamma * sigma, neighbourMax);

  vec3 current = sfRGBToYCoCg(sfToneWeight(max(centerSample.rgb, 0.0)));
  float currentDepth = -sfSampleViewZ(uv);

  /* ---- history validity ---- */
  vec4 history = sampleHistoryCatmullRom(prevUv);
  float valid = 1.0;
  // Off-screen last frame.
  if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) valid = 0.0;
  // Disocclusion: the surface under this pixel is not the surface that was
  // there. Tolerance scales with distance because depth precision does, and
  // with velocity because fast motion legitimately changes depth.
  float historyDepth = history.a * uFar;
  float tolerance = 0.03 * currentDepth + 0.25 + length(velocity / uTexel) * 0.02 * currentDepth;
  if (abs(historyDepth - currentDepth) > tolerance) valid *= 0.0;
  valid *= 1.0 - uReset;

  vec3 historyY = sfRGBToYCoCg(sfToneWeight(max(history.rgb, 0.0)));

  /* ---- clip history into the neighbourhood AABB ---- */
  vec3 center = 0.5 * (boxMax + boxMin);
  vec3 extents = 0.5 * (boxMax - boxMin) + 1e-5;
  vec3 offsetFromCenter = historyY - center;
  vec3 ts = abs(extents / max(abs(offsetFromCenter), vec3(1e-5)));
  float t = clamp(min(min(ts.x, ts.y), ts.z), 0.0, 1.0);
  vec3 clipped = center + offsetFromCenter * t;

  /* ---- blend weight ---- */
  // Running average while the history is short (exact convergence), decaying
  // into the steady-state exponential once enough samples are in.
  float runningAverage = 1.0 / max(uAccumFrames + 1.0, 1.0);
  float alpha = max(runningAverage, 1.0 - uFeedback);
  // Fast motion trusts the current frame more; there is nothing useful in a
  // history that has travelled thirty pixels.
  float speedPx = length(velocity / uTexel);
  alpha = clamp(alpha + speedPx * 0.012, 0.0, 1.0);
  // Karis luminance weighting: reduce the influence of very bright samples so
  // one specular sparkle does not pump the whole pixel for ten frames.
  float wc = alpha / (1.0 + current.x);
  float wh = (1.0 - alpha) / (1.0 + clipped.x);
  float wsum = max(wc + wh, 1e-5);

  vec3 resolvedY = mix(current, (current * wc + clipped * wh) / wsum, valid);
  vec3 resolved = sfUnToneWeight(sfYCoCgToRGB(resolvedY));

  gl_FragColor = vec4(max(resolved, 0.0), currentDepth / uFar);
}
`;

/**
 * Resolve-to-output copy with a contrast-adaptive sharpen.
 *
 * TAA always costs a little acutance; putting a *clamped* unsharp mask here
 * (never allowed to exceed the local min/max, so no ringing halos) buys it back
 * for free, since we have to touch every pixel to copy anyway.
 */
const outputFrag = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uSharpness;
varying vec2 vUv;

void main() {
  vec3 c = texture2D(tInput, vUv).rgb;
  if (uSharpness <= 0.001) {
    gl_FragColor = vec4(c, 1.0);
    return;
  }
  vec3 n = texture2D(tInput, vUv + vec2(0.0, uTexel.y)).rgb;
  vec3 s = texture2D(tInput, vUv - vec2(0.0, uTexel.y)).rgb;
  vec3 e = texture2D(tInput, vUv + vec2(uTexel.x, 0.0)).rgb;
  vec3 w = texture2D(tInput, vUv - vec2(uTexel.x, 0.0)).rgb;

  vec3 lo = min(min(min(n, s), min(e, w)), c);
  vec3 hi = max(max(max(n, s), max(e, w)), c);

  vec3 sharpened = c + (c * 4.0 - (n + s + e + w)) * (uSharpness * 0.25);
  gl_FragColor = vec4(clamp(sharpened, lo, hi), 1.0);
}
`;

export interface TaaOptions {
  /** Steady-state history weight. 0.92 is a good balance for a fast game. */
  feedback?: number;
  /** Neighbourhood clamp width in standard deviations. */
  clampGamma?: number;
  /** Number of jitter samples. */
  sampleCount?: number;
}

export class TaaPass extends Pass {
  readonly jitter: Float32Array;
  readonly sampleCount: number;

  private readonly resolveMaterial: THREE.ShaderMaterial;
  private readonly outputMaterial: THREE.ShaderMaterial;
  private historyA: THREE.WebGLRenderTarget;
  private historyB: THREE.WebGLRenderTarget;
  private accumFrames = 0;
  private needsReset = true;

  constructor(velocityTexture: THREE.Texture | null, options: TaaOptions = {}) {
    super("SfTaaPass");
    this.needsSwap = true;
    this.needsDepthTexture = true;

    this.sampleCount = options.sampleCount ?? 16;
    this.jitter = makeJitterSequence(this.sampleCount);

    this.historyA = makeHdrTarget(1, 1, "SfTaaHistoryA");
    this.historyB = makeHdrTarget(1, 1, "SfTaaHistoryB");

    this.resolveMaterial = new THREE.ShaderMaterial({
      name: "SfTaaResolve",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: resolveFrag,
      uniforms: {
        tCurrent: { value: null as THREE.Texture | null },
        tHistory: { value: null as THREE.Texture | null },
        tVelocity: { value: velocityTexture },
        tDepth: { value: null as THREE.Texture | null },
        uTexel: envUniforms.texelSize,
        uNear: envUniforms.near,
        uFar: envUniforms.far,
        uLogFC: envUniforms.logDepthFC,
        uInverseProjection: envUniforms.inverseProjection,
        uCameraMatrixWorld: envUniforms.cameraMatrixWorld,
        uFeedback: { value: options.feedback ?? 0.92 },
        uAccumFrames: { value: 0 },
        uClampGamma: { value: options.clampGamma ?? 1.25 },
        uReset: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.outputMaterial = new THREE.ShaderMaterial({
      name: "SfTaaOutput",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: outputFrag,
      uniforms: {
        tInput: { value: null as THREE.Texture | null },
        uTexel: envUniforms.texelSize,
        uSharpness: { value: 0.35 },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.fullscreenMaterial = this.resolveMaterial;
  }

  /** The velocity buffer is created by another pass; wire it after construction. */
  setVelocityTexture(texture: THREE.Texture): void {
    this.resolveMaterial.uniforms.tVelocity.value = texture;
  }

  setSharpness(v: number): void {
    this.outputMaterial.uniforms.uSharpness.value = v;
  }

  /** Drop the history — call on teleports, respawns and quality changes. */
  reset(): void {
    this.needsReset = true;
    this.accumFrames = 0;
  }

  /**
   * Sub-pixel offset for this frame, in pixels, written into `out`.
   * Writing into a caller-owned vector rather than returning a tuple keeps the
   * frame loop allocation-free.
   */
  jitterInto(frameIndex: number, out: THREE.Vector2): THREE.Vector2 {
    const i = (frameIndex % this.sampleCount) * 2;
    return out.set(this.jitter[i], this.jitter[i + 1]);
  }

  setDepthTexture(depthTexture: THREE.Texture): void {
    this.resolveMaterial.uniforms.tDepth.value = depthTexture;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this.historyA.setSize(w, h);
    this.historyB.setSize(w, h);
    this.reset();
  }

  render(
    renderer: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget,
    outputBuffer: THREE.WebGLRenderTarget,
  ): void {
    const u = this.resolveMaterial.uniforms;
    u.tCurrent.value = inputBuffer.texture;
    u.tHistory.value = this.historyA.texture;
    u.uAccumFrames.value = this.accumFrames;
    u.uReset.value = this.needsReset ? 1 : 0;

    // Resolve into the write history.
    this.fullscreenMaterial = this.resolveMaterial;
    renderer.setRenderTarget(this.historyB);
    renderer.render(this.scene, this.camera);

    // Publish, sharpening on the way out.
    this.outputMaterial.uniforms.tInput.value = this.historyB.texture;
    this.fullscreenMaterial = this.outputMaterial;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);

    // Swap history.
    const tmp = this.historyA;
    this.historyA = this.historyB;
    this.historyB = tmp;

    this.needsReset = false;
    this.accumFrames = Math.min(this.accumFrames + 1, this.sampleCount * 4);
    postfx.taaFrames = this.accumFrames;
  }

  dispose(): void {
    this.historyA.dispose();
    this.historyB.dispose();
    this.resolveMaterial.dispose();
    this.outputMaterial.dispose();
    super.dispose();
  }
}
