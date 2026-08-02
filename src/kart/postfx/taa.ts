/**
 * Temporal anti-aliasing.
 *
 * Optional, and off below `ultra` on purpose. TAA is the best AA there is when
 * it has a per-object velocity buffer; without one — and this pipeline
 * deliberately does not render a second geometry pass to build one — a kart
 * moving relative to the camera reprojects to the wrong pixel, and the only
 * thing standing between that and a visible ghost trail is the neighbourhood
 * clamp. So the clamp here is unusually tight, the disocclusion test is
 * unusually strict, and any pixel whose reprojected depth disagrees with the
 * current one is thrown away rather than blended.
 *
 * What it buys, when it is on: the jittered projection turns the stochastic
 * passes (AO's rotated direction fan, DOF's rotated spiral, the god-ray
 * dither) from noise into a converged image, and edges get a genuine 16×
 * supersample. On the offline screenshot harness — where the camera is
 * *static* and the failure mode cannot occur — that is free quality, which is
 * why `accumulate()` exists.
 */
import * as THREE from "three";
import { PF_COLOR, PF_DEPTH, PF_VERT, PF_YCOCG } from "./glsl";
import {
  Blitter,
  depthUniforms,
  disposeTarget,
  fullscreenMaterial,
  makeTarget,
  resizeTarget,
  type PostFxCaps,
  type SharedUniforms,
} from "./targets";

/** Radical inverse (van der Corput) in an arbitrary base. */
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
 * Halton(2,3) sub-pixel offsets in [-0.5, 0.5].
 *
 * Sixteen is the sweet spot: eight visibly under-samples a near-horizontal
 * kerb line, thirty-two takes too long to converge in a game that is never
 * standing still.
 */
export function makeJitterSequence(count: number): Float32Array {
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    out[i * 2 + 0] = halton(i + 1, 2) - 0.5;
    out[i * 2 + 1] = halton(i + 1, 3) - 0.5;
  }
  return out;
}

const resolveFrag = /* glsl */ `
precision highp float;
${PF_DEPTH}
${PF_COLOR}
${PF_YCOCG}

uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform vec2 uTexel;
uniform float uFeedback;
uniform float uAccumFrames;
uniform float uClampGamma;
uniform float uReset;
varying vec2 vUv;

/**
 * Catmull-Rom history fetch, five bilinear taps.
 *
 * Resampling history bilinearly at a fractional offset is a low-pass filter
 * applied once per frame, forever: a still image gets softer every frame it
 * stands still. A cubic filter puts the acutance back for four extra taps.
 */
vec4 historyCatmullRom(const in vec2 uv) {
  vec2 texSize = 1.0 / uTexel;
  vec2 samplePos = uv * texSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;

  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);

  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / max(w12, vec2(1e-5));

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
  /* ---- velocity, dilated to the closest surface in the 3×3 ----
     Taking the centre pixel's velocity tears silhouettes: the background's
     reprojection gets applied to the foreground's edge texels. */
  float closest = 1e30;
  vec2 closestUv = vUv;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * uTexel;
      float d = -pfViewZ(pfRawDepth(vUv + o));
      if (d < closest) { closest = d; closestUv = vUv + o; }
    }
  }
  vec2 velocity = pfCameraVelocity(closestUv, pfRawDepth(closestUv));
  vec2 prevUv = vUv - velocity;

  /* ---- neighbourhood statistics in tonemapped YCoCg ---- */
  vec3 m1 = vec3(0.0);
  vec3 m2 = vec3(0.0);
  vec3 nMin = vec3(1e30);
  vec3 nMax = vec3(-1e30);
  vec3 centerRgb = vec3(0.0);

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * uTexel;
      vec3 c = pfSanitize(texture2D(tCurrent, vUv + o).rgb);
      vec3 yc = pfRGBToYCoCg(pfToneWeight(c));
      m1 += yc;
      m2 += yc * yc;
      nMin = min(nMin, yc);
      nMax = max(nMax, yc);
      if (x == 0 && y == 0) centerRgb = c;
    }
  }

  vec3 mean = m1 / 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - mean * mean, 0.0));
  vec3 boxMin = max(mean - uClampGamma * sigma, nMin);
  vec3 boxMax = min(mean + uClampGamma * sigma, nMax);

  vec3 current = pfRGBToYCoCg(pfToneWeight(centerRgb));
  float currentDepth = -pfViewZ(pfRawDepth(vUv));

  /* ---- history validity ---- */
  vec4 history = historyCatmullRom(prevUv);
  float valid = 1.0;
  if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) valid = 0.0;
  // Disocclusion. Tolerance scales with distance (depth precision does) and
  // with velocity (fast motion legitimately changes depth between frames).
  float historyDepth = history.a * uFar;
  float speedPx = length(velocity / uTexel);
  float tolerance = 0.025 * currentDepth + 0.2 + speedPx * 0.015 * currentDepth;
  if (abs(historyDepth - currentDepth) > tolerance) valid = 0.0;
  valid *= 1.0 - uReset;

  /* ---- clip history into the neighbourhood AABB ---- */
  vec3 historyY = pfRGBToYCoCg(pfToneWeight(pfSanitize(history.rgb)));
  vec3 boxCenter = 0.5 * (boxMax + boxMin);
  vec3 extents = 0.5 * (boxMax - boxMin) + 1e-5;
  vec3 off = historyY - boxCenter;
  vec3 ts = abs(extents / max(abs(off), vec3(1e-5)));
  float clipT = clamp(min(min(ts.x, ts.y), ts.z), 0.0, 1.0);
  vec3 clipped = boxCenter + off * clipT;

  /* ---- blend ----
     A true running average while the history is short — it reaches the exact
     mean of the jitter sequence after n frames instead of approaching it — then
     the steady-state exponential once enough samples are in. That is why the
     offline harness gets a converged still in a dozen frames. */
  float running = 1.0 / max(uAccumFrames + 1.0, 1.0);
  float alpha = max(running, 1.0 - uFeedback);
  alpha = clamp(alpha + speedPx * 0.02, 0.0, 1.0);
  // Karis luminance weighting: one bright sample must not pump the pixel for
  // the next ten frames.
  float wc = alpha / (1.0 + current.x);
  float wh = (1.0 - alpha) / (1.0 + clipped.x);
  vec3 blended = (current * wc + clipped * wh) / max(wc + wh, 1e-5);

  vec3 resolved = pfUnToneWeight(pfYCoCgToRGB(mix(current, blended, valid)));
  gl_FragColor = vec4(max(resolved, 0.0), clamp(currentDepth / uFar, 0.0, 1.0));
}
`;

export interface TaaOptions {
  feedback?: number;
  clampGamma?: number;
  sampleCount?: number;
}

export class TaaPass {
  readonly sampleCount: number;
  private readonly jitter: Float32Array;
  private readonly material: THREE.ShaderMaterial;
  private historyA: THREE.WebGLRenderTarget;
  private historyB: THREE.WebGLRenderTarget;
  private accumFrames = 0;
  private needsReset = true;

  constructor(caps: PostFxCaps, shared: SharedUniforms, options: TaaOptions = {}) {
    this.sampleCount = options.sampleCount ?? 16;
    this.jitter = makeJitterSequence(this.sampleCount);

    this.historyA = makeTarget(1, 1, "KartTaaHistoryA", caps);
    this.historyB = makeTarget(1, 1, "KartTaaHistoryB", caps);

    this.material = fullscreenMaterial(
      "KartTaaResolve",
      resolveFrag,
      {
        ...depthUniforms(shared),
        tCurrent: { value: null },
        tHistory: { value: null },
        uTexel: shared.uTexel,
        uFeedback: { value: options.feedback ?? 0.9 },
        uAccumFrames: { value: 0 },
        // Tighter than a film pipeline would use. Without object velocities the
        // clamp is the *only* thing catching a mis-reprojected kart.
        uClampGamma: { value: options.clampGamma ?? 1.0 },
        uReset: { value: 1 },
      },
      PF_VERT,
    );
  }

  /** Sub-pixel offset in pixels for this frame, written into `out`. */
  jitterInto(frameIndex: number, out: THREE.Vector2): THREE.Vector2 {
    const i = (frameIndex % this.sampleCount) * 2;
    return out.set(this.jitter[i], this.jitter[i + 1]);
  }

  /** Drop the history — respawns, camera cuts, resizes, quality changes. */
  reset(): void {
    this.needsReset = true;
    this.accumFrames = 0;
  }

  /** Frames of valid history; the harness waits on this before shooting. */
  get frames(): number {
    return this.accumFrames;
  }

  /**
   * Offline mode: with a static camera there is no reprojection error to make,
   * so the history can be trusted absolutely and convergence is pure gain.
   */
  accumulate(enabled: boolean): void {
    this.material.uniforms.uFeedback.value = enabled ? 0.97 : 0.9;
    this.material.uniforms.uClampGamma.value = enabled ? 2.5 : 1.0;
  }

  setSize(width: number, height: number): void {
    resizeTarget(this.historyA, width, height);
    resizeTarget(this.historyB, width, height);
    this.reset();
  }

  /** Resolves into the write history and returns it — no extra output copy. */
  render(renderer: THREE.WebGLRenderer, blitter: Blitter, current: THREE.Texture): THREE.Texture {
    const u = this.material.uniforms;
    u.tCurrent.value = current;
    u.tHistory.value = this.historyA.texture;
    u.uAccumFrames.value = this.accumFrames;
    u.uReset.value = this.needsReset ? 1 : 0;

    blitter.draw(renderer, this.material, this.historyB);

    const resolved = this.historyB.texture;
    const tmp = this.historyA;
    this.historyA = this.historyB;
    this.historyB = tmp;

    this.needsReset = false;
    this.accumFrames = Math.min(this.accumFrames + 1, this.sampleCount * 4);
    return resolved;
  }

  dispose(): void {
    disposeTarget(this.historyA);
    disposeTarget(this.historyB);
    this.material.dispose();
  }
}
