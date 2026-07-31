/**
 * Screen-space ambient occlusion — contact darkening, and nothing more.
 *
 * A racer at 100 km/h has no time to admire a cavity term. What AO buys here is
 * *grounding*: the thin dark seam where a tyre meets tarmac, where a kerb meets
 * the road, where a signpost meets grass. That seam is the single strongest cue
 * that objects are sitting on the track rather than hovering above it, and it is
 * the thing a flat-lit arcade racer most often gets wrong.
 *
 * So the pass is deliberately tight: a ~1.1 m world radius, a horizon-based
 * estimator (HBAO), and a depth-aware blur. It runs at half resolution because
 * a contact seam is a low-frequency signal and nobody has ever spotted a
 * half-res one at speed.
 *
 * Two rules keep it from going muddy — the failure mode that makes SSAO look
 * like soot:
 *   · the falloff is distance-weighted, so a wall 20 m behind a kerb never
 *     contributes a halo around it;
 *   · the result is only applied to the *ambient* share of a pixel, faded out
 *     as the pixel gets brighter, so a sunlit road never darkens.
 * The second rule lives in the resolve pass; this file produces the raw term.
 */
import * as THREE from "three";
import { PF_DEPTH, PF_NOISE, PF_VERT } from "./glsl";
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

const aoFrag = /* glsl */ `
precision highp float;
${PF_DEPTH}
${PF_NOISE}

uniform vec2 uDepthTexel;
uniform float uAspect;
uniform float uRadius;
uniform float uBias;
uniform float uIntensity;
uniform float uProjScale;
uniform float uMaxRadiusUv;
uniform float uFrameIndex;
varying vec2 vUv;

/**
 * Normal from depth, picking the *closer* neighbour on each axis.
 *
 * The naive central difference smears a normal across a silhouette: at the
 * edge of a kart against the track 30 m behind it, the reconstructed normal
 * points somewhere between them and the AO term paints a bright halo. Choosing
 * the smaller depth delta keeps the normal on the near surface.
 */
vec3 aoNormal(const in vec2 uv, const in vec3 P) {
  vec3 pL = pfViewPositionAt(uv - vec2(uDepthTexel.x, 0.0));
  vec3 pR = pfViewPositionAt(uv + vec2(uDepthTexel.x, 0.0));
  vec3 pD = pfViewPositionAt(uv - vec2(0.0, uDepthTexel.y));
  vec3 pU = pfViewPositionAt(uv + vec2(0.0, uDepthTexel.y));

  vec3 dx = abs(pR.z - P.z) < abs(P.z - pL.z) ? (pR - P) : (P - pL);
  vec3 dy = abs(pU.z - P.z) < abs(P.z - pD.z) ? (pU - P) : (P - pD);

  vec3 n = normalize(cross(dx, dy));
  return dot(n, P) > 0.0 ? -n : n;
}

void main() {
  float raw = pfRawDepth(vUv);
  float viewZ = pfViewZ(raw);
  float depth = -viewZ;

  // Sky: fully unoccluded, and skip the whole march. Also writes the depth the
  // blur keys off, normalised so it survives an 8-bit buffer.
  if (pfIsSky(raw)) {
    gl_FragColor = vec4(1.0, 1.0, 0.0, 1.0);
    return;
  }

  vec3 P = pfViewPosition(vUv, viewZ);
  vec3 N = aoNormal(vUv, P);

  // World radius projected to screen. Clamping it stops a pixel two metres from
  // the lens from marching across the entire frame, which is both a cache
  // disaster and visually wrong.
  float radiusUv = min(uRadius * uProjScale / max(depth, 0.05), uMaxRadiusUv);

  float rnd = pfIGNT(gl_FragCoord.xy, uFrameIndex);
  float occlusion = 0.0;

  for (int d = 0; d < AO_DIRECTIONS; d++) {
    // Rotate the whole direction fan per pixel; the blur below turns the
    // resulting noise into a smooth field for a fraction of the sample cost.
    float angle = (float(d) + rnd) * (6.2831853 / float(AO_DIRECTIONS));
    // radiusUv is derived from P[1][1] and is therefore a *vertical* UV
    // measure; UV space is normalised per axis, so x has to be divided by the
    // aspect ratio or the sampling disk is stretched sideways in world terms
    // and the occlusion radius silently becomes 1.8 m on one axis.
    vec2 dir = vec2(cos(angle) / uAspect, sin(angle));
    float horizon = 0.0;

    for (int s = 1; s <= AO_STEPS; s++) {
      float t = (float(s) - 0.5 * rnd) / float(AO_STEPS);
      vec2 suv = vUv + dir * (t * radiusUv);
      vec3 S = pfViewPositionAt(suv);
      vec3 delta = S - P;
      float dist = length(delta);
      if (dist < 1e-4) continue;

      // sin of the elevation of the sample above the tangent plane.
      float sinH = dot(N, delta) / dist;
      // Inverse-square falloff in *world* units. This is the term that keeps a
      // distant wall from haloing a near object.
      float atten = 1.0 / (1.0 + (dist * dist) / (uRadius * uRadius));
      horizon = max(horizon, (sinH - uBias) * atten);
    }

    occlusion += horizon;
  }

  float ao = 1.0 - clamp(occlusion / float(AO_DIRECTIONS) * uIntensity, 0.0, 1.0);
  // Fade AO out into the distance: at 120 m a 1 m contact seam is a fraction of
  // a pixel and all the pass can produce there is depth-precision noise.
  ao = mix(ao, 1.0, smoothstep(60.0, 160.0, depth));

  gl_FragColor = vec4(ao, clamp(depth / uFar, 0.0, 1.0), 0.0, 1.0);
}
`;

/**
 * Separable depth-aware blur.
 *
 * The AO buffer carries its own normalised depth in green, so the blur needs no
 * camera uniforms and no second depth fetch — and, more usefully, the weights
 * are computed against exactly the depth the AO sample was taken at, which a
 * re-fetch at a different resolution would not guarantee.
 */
const blurFrag = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform vec2 uDirection;
uniform float uDepthSigma;
varying vec2 vUv;

void main() {
  vec2 center = texture2D(tInput, vUv).rg;
  float sum = center.r * 0.2270270270;
  float wsum = 0.2270270270;

  // Five-tap gaussian at 1 and 2 texels — the linear-sampled 9-tap equivalent.
  for (int i = 1; i <= 2; i++) {
    float w = i == 1 ? 0.3162162162 : 0.0702702703;
    vec2 o = uDirection * uTexel * float(i) * 1.5;

    vec2 a = texture2D(tInput, vUv + o).rg;
    vec2 b = texture2D(tInput, vUv - o).rg;
    // Bilateral term: reject across a depth edge so the seam under a kart does
    // not bleed onto the road behind it.
    float wa = w * exp(-abs(a.g - center.g) * uDepthSigma);
    float wb = w * exp(-abs(b.g - center.g) * uDepthSigma);
    sum += a.r * wa + b.r * wb;
    wsum += wa + wb;
  }

  gl_FragColor = vec4(sum / max(wsum, 1e-4), center.g, 0.0, 1.0);
}
`;

export interface AoOptions {
  directions?: number;
  steps?: number;
  /** Occlusion radius in world metres. */
  radius?: number;
  intensity?: number;
  /** Denominator of the render scale: 2 = half resolution. */
  scale?: number;
}

export class AoPass {
  get texture(): THREE.Texture {
    return this.targetA.texture;
  }

  private readonly targetA: THREE.WebGLRenderTarget;
  private readonly targetB: THREE.WebGLRenderTarget;
  private readonly aoMaterial: THREE.ShaderMaterial;
  private readonly blurMaterial: THREE.ShaderMaterial;
  private readonly scale: number;

  constructor(caps: PostFxCaps, shared: SharedUniforms, options: AoOptions = {}) {
    this.scale = options.scale ?? 2;
    // 8-bit is plenty for a scalar visibility term, and it halves the bandwidth
    // of the two blur passes — which on a software rasteriser is the whole cost.
    this.targetA = makeTarget(1, 1, "KartAoA", caps, { ldr: true });
    this.targetB = makeTarget(1, 1, "KartAoB", caps, { ldr: true });

    this.aoMaterial = fullscreenMaterial(
      "KartAo",
      aoFrag,
      {
        ...depthUniforms(shared),
        uDepthTexel: { value: new THREE.Vector2() },
        uAspect: shared.uAspect,
        uRadius: { value: options.radius ?? 1.1 },
        uBias: { value: 0.06 },
        uIntensity: { value: options.intensity ?? 1.35 },
        uProjScale: { value: 1 },
        uMaxRadiusUv: { value: 0.075 },
        uFrameIndex: shared.uFrame,
      },
      PF_VERT,
    );
    this.aoMaterial.defines = {
      AO_DIRECTIONS: String(Math.max(3, options.directions ?? 5)),
      AO_STEPS: String(Math.max(2, options.steps ?? 4)),
    };

    this.blurMaterial = fullscreenMaterial(
      "KartAoBlur",
      blurFrag,
      {
        tInput: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uDepthSigma: { value: 160 },
      },
      PF_VERT,
    );
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / this.scale));
    const h = Math.max(1, Math.floor(height / this.scale));
    resizeTarget(this.targetA, w, h);
    resizeTarget(this.targetB, w, h);
    (this.blurMaterial.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    (this.aoMaterial.uniforms.uDepthTexel.value as THREE.Vector2).set(1 / width, 1 / height);
  }

  /** `projScale` = 0.5 * P[1][1]; converts world metres to UV at unit depth. */
  render(renderer: THREE.WebGLRenderer, blitter: Blitter, projScale: number): void {
    this.aoMaterial.uniforms.uProjScale.value = projScale;
    blitter.draw(renderer, this.aoMaterial, this.targetA);

    this.blurMaterial.uniforms.tInput.value = this.targetA.texture;
    (this.blurMaterial.uniforms.uDirection.value as THREE.Vector2).set(1, 0);
    blitter.draw(renderer, this.blurMaterial, this.targetB);

    this.blurMaterial.uniforms.tInput.value = this.targetB.texture;
    (this.blurMaterial.uniforms.uDirection.value as THREE.Vector2).set(0, 1);
    blitter.draw(renderer, this.blurMaterial, this.targetA);
  }

  dispose(): void {
    disposeTarget(this.targetA);
    disposeTarget(this.targetB);
    this.aoMaterial.dispose();
    this.blurMaterial.dispose();
  }
}
