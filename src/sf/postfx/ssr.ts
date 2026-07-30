/**
 * Screen-space reflections.
 *
 * Two surfaces in this city carry the whole effect: wet asphalt after the fog
 * rolls through, and the curtain-wall glass of the Financial District. Both are
 * mirror-ish dielectrics at grazing angles, which is precisely where SSR is at
 * its best — the reflected ray stays near the screen plane and almost always
 * finds its target.
 *
 * Because there is no G-buffer to read roughness from, reflectivity is derived
 * from the reconstructed normal plus two art-directable globals:
 *   - up-facing surfaces get `wetness` (roads, plazas, rooftops after rain)
 *   - vertical, *locally planar* surfaces get `glassiness` (the planarity test
 *     is what stops Twin Peaks' rock faces turning into mirrors)
 * and Fresnel does the rest, which is why a puddle you stand over is subtle and
 * the same puddle down the street is a sheet of sky.
 *
 * Rays that leave the frame do not fade to grey — they fall back to the same
 * analytic sky the atmosphere shader produces, so the transition at the screen
 * edge is continuous rather than the usual dark band.
 */
import * as THREE from "three";
import { Effect, EffectAttribute, BlendFunction } from "postprocessing";
import { envUniforms } from "./env";
import {
  FULLSCREEN_VERT,
  GLSL_DEPTH,
  GLSL_EFFECT_DEPTH,
  GLSL_BLUE_NOISE,
  GLSL_NOISE,
  GLSL_NORMAL,
  GLSL_SKY,
} from "./glsl";
import { blit, makeHdrTarget } from "./fullscreen";

const marchFrag = /* glsl */ `
precision highp float;
${GLSL_DEPTH}
${GLSL_NORMAL}
${GLSL_NOISE}
${GLSL_BLUE_NOISE}
${GLSL_SKY}

uniform sampler2D tColor;
uniform mat4 uProjection;
uniform vec2 uFullTexel;
uniform float uFrameIndex;
uniform float uWetness;
uniform float uGlassiness;
uniform float uMaxDistance;
uniform float uThickness;
uniform float uIntensity;

varying vec2 vUv;

vec2 projectToUv(const in vec3 viewPos) {
  vec4 clip = uProjection * vec4(viewPos, 1.0);
  return (clip.xy / clip.w) * 0.5 + 0.5;
}

void main() {
  float wd = sfWindowDepth(sfRawDepth(vUv));
  if (sfIsSky(wd)) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float viewZ = sfViewZ(wd);
  vec3 P = sfViewPosition(vUv, viewZ);
  vec3 N = sfNormalFromDepth(vUv, P, uFullTexel);
  vec3 V = normalize(-P);
  vec3 worldN = normalize(sfWorldDirFromView(N));

  /* ---- how reflective is this pixel? ---- */

  // Local planarity: a curtain wall's normal barely changes over four pixels;
  // a rock face or a tree's does. This is the cheapest reliable way to tell a
  // building apart from terrain without a material buffer.
  vec3 nA = sfNormalFromDepth(vUv + vec2(uFullTexel.x * 3.0, 0.0), sfViewPositionAt(vUv + vec2(uFullTexel.x * 3.0, 0.0)), uFullTexel);
  vec3 nB = sfNormalFromDepth(vUv + vec2(0.0, uFullTexel.y * 3.0), sfViewPositionAt(vUv + vec2(0.0, uFullTexel.y * 3.0)), uFullTexel);
  float planar = min(dot(N, nA), dot(N, nB));
  planar = smoothstep(0.965, 0.999, planar);

  float wet = uWetness * smoothstep(0.72, 0.96, worldN.y);
  float glass = uGlassiness * smoothstep(0.30, 0.06, abs(worldN.y)) * planar;
  float material = max(wet, glass);
  if (material < 0.01) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float f0 = mix(0.04, 0.10, glass);
  float NoV = clamp(dot(N, V), 0.0, 1.0);
  float fresnel = f0 + (1.0 - f0) * pow(1.0 - NoV, 5.0);
  float reflectivity = clamp(material * fresnel * 4.0, 0.0, 1.0) * uIntensity;
  if (reflectivity < 0.004) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float roughness = mix(0.5, 0.03, material);

  /* ---- ray ---- */

  vec3 R = reflect(-V, N);
  // Roughness-aware jitter. One perturbed sample per pixel per frame; the
  // temporal accumulator below integrates the lobe over time, which is how you
  // get a glossy reflection without a hundred taps.
  vec2 rnd = sfBlueNoise2(gl_FragCoord.xy, uFrameIndex);
  float a2 = roughness * roughness;
  vec3 tangent = normalize(abs(N.z) < 0.9 ? cross(N, vec3(0.0, 0.0, 1.0)) : cross(N, vec3(1.0, 0.0, 0.0)));
  vec3 bitangent = cross(N, tangent);
  float phi = rnd.x * 6.283185307;
  float r = a2 * sqrt(rnd.y);
  R = normalize(R + (tangent * cos(phi) + bitangent * sin(phi)) * r);
  if (dot(R, N) < 0.0) R = reflect(R, N);

  float stepLen = uMaxDistance / float(SF_SSR_STEPS);
  float jitter = sfBlueNoise(gl_FragCoord.xy, uFrameIndex);

  vec3 origin = P + N * (0.02 + -P.z * 0.0016);
  float t = stepLen * (0.35 + jitter * 0.65);
  float prevT = 0.0;
  bool hit = false;
  vec2 hitUv = vec2(0.0);

  for (int i = 0; i < SF_SSR_STEPS; i++) {
    vec3 sp = origin + R * t;
    if (sp.z > -0.001) break; // ray went behind the eye
    vec2 uv = projectToUv(sp);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;

    float sceneZ = sfSampleViewZ(uv);
    float diff = sceneZ - sp.z;
    // diff > 0 means the ray is behind the visible surface. Thickness scales
    // with distance because a 20 cm tolerance at 500 m is a single depth texel.
    float thickness = uThickness + (-sp.z) * 0.03;
    if (diff > 0.0 && diff < thickness) {
      hit = true;
      hitUv = uv;
      // Binary refinement — five halvings turn a 4 m step into 12 cm, which is
      // the difference between a reflection that sticks to the surface and one
      // that visibly floats above it.
      float lo = prevT;
      float hi = t;
      for (int b = 0; b < 5; b++) {
        float mid = (lo + hi) * 0.5;
        vec3 mp = origin + R * mid;
        vec2 muv = projectToUv(mp);
        float mz = sfSampleViewZ(muv);
        if (mz - mp.z > 0.0) { hi = mid; hitUv = muv; }
        else { lo = mid; }
      }
      t = hi;
      break;
    }
    prevT = t;
    // Geometric growth: fine near the surface where contact reflections live,
    // coarse far away where the projection compresses everything anyway.
    t += stepLen * (1.0 + t * 0.045);
    if (t > uMaxDistance) break;
  }

  vec3 worldR = normalize(sfWorldDirFromView(R));
  vec3 fallback = sfEnvironment(worldR);

  vec3 color = fallback;
  float confidence = 0.0;

  if (hit) {
    color = texture2D(tColor, hitUv).rgb;
    // Screen-edge fade. Reflections that need information from outside the
    // frame must dissolve into the environment, not clamp to the border pixel.
    vec2 edge = smoothstep(vec2(0.0), vec2(0.14), hitUv) *
                (1.0 - smoothstep(vec2(0.86), vec2(1.0), hitUv));
    confidence = edge.x * edge.y;
    // Rays travelling back toward the camera carry the least information.
    confidence *= 1.0 - smoothstep(0.25, 0.9, dot(R, V));
    // Long rays are the least trustworthy.
    confidence *= 1.0 - smoothstep(0.65, 1.0, t / uMaxDistance);
  }

  vec3 result = mix(fallback, color, confidence);
  gl_FragColor = vec4(result, reflectivity);
}
`;

const accumFrag = /* glsl */ `
precision highp float;
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tVelocity;
uniform float uFeedback;
uniform float uReset;
uniform vec2 uTexel;
varying vec2 vUv;

void main() {
  vec4 cur = texture2D(tCurrent, vUv);
  vec2 vel = texture2D(tVelocity, vUv).xy;
  vec2 prevUv = vUv - vel;

  float valid = 1.0 - uReset;
  if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) valid = 0.0;

  vec4 hist = texture2D(tHistory, prevUv);

  // Clamp the history to the current 5-tap neighbourhood so a moving reflection
  // cannot leave a comet tail across the road.
  vec4 lo = cur;
  vec4 hi = cur;
  vec4 s0 = texture2D(tCurrent, vUv + vec2(uTexel.x, 0.0));
  vec4 s1 = texture2D(tCurrent, vUv - vec2(uTexel.x, 0.0));
  vec4 s2 = texture2D(tCurrent, vUv + vec2(0.0, uTexel.y));
  vec4 s3 = texture2D(tCurrent, vUv - vec2(0.0, uTexel.y));
  lo = min(lo, min(min(s0, s1), min(s2, s3)));
  hi = max(hi, max(max(s0, s1), max(s2, s3)));
  vec4 clamped = clamp(hist, lo - 0.05, hi + 0.05);

  gl_FragColor = mix(cur, mix(cur, clamped, uFeedback), valid);
}
`;

const blurFrag = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uDirection;
varying vec2 vUv;

void main() {
  // Small tent blur. SSR is stochastic in the roughness lobe; a couple of texels
  // of spatial filtering plus the temporal accumulator gets glossy reflections
  // that read as glossy instead of as noise.
  vec4 sum = texture2D(tInput, vUv) * 0.34;
  sum += texture2D(tInput, vUv + uDirection) * 0.24;
  sum += texture2D(tInput, vUv - uDirection) * 0.24;
  sum += texture2D(tInput, vUv + uDirection * 2.0) * 0.09;
  sum += texture2D(tInput, vUv - uDirection * 2.0) * 0.09;
  gl_FragColor = sum;
}
`;

const compositeFrag = /* glsl */ `
${GLSL_EFFECT_DEPTH}
uniform sampler2D ssrBuffer;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (sfSkyAt(uv)) {
    outputColor = inputColor;
    return;
  }
  vec4 s = texture2D(ssrBuffer, uv);
  outputColor = vec4(mix(inputColor.rgb, s.rgb, clamp(s.a, 0.0, 1.0)), inputColor.a);
}
`;

export interface SsrOptions {
  steps?: number;
  maxDistance?: number;
  thickness?: number;
  intensity?: number;
  resolutionScale?: number;
}

export class SsrEffect extends Effect {
  private marchTarget: THREE.WebGLRenderTarget;
  private accumA: THREE.WebGLRenderTarget;
  private accumB: THREE.WebGLRenderTarget;
  private blurTarget: THREE.WebGLRenderTarget;

  private marchMaterial: THREE.ShaderMaterial;
  private accumMaterial: THREE.ShaderMaterial;
  private blurMaterial: THREE.ShaderMaterial;

  private scale: number;
  private width = 1;
  private height = 1;
  private needsReset = true;

  constructor(options: SsrOptions = {}) {
    const uniforms = new Map<string, THREE.Uniform>([
      ["ssrBuffer", new THREE.Uniform(null)],
      ["logFC", envUniforms.logDepthFC],
      ["camNear", envUniforms.near],
      ["camFar", envUniforms.far],
      ["invProjection", envUniforms.inverseProjection],
      ["camWorld", envUniforms.cameraMatrixWorld],
    ]);

    super("SfSSR", compositeFrag, {
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.NORMAL,
      uniforms,
    });

    this.scale = options.resolutionScale ?? 0.5;

    this.marchTarget = makeHdrTarget(1, 1, "SfSsrMarch");
    this.accumA = makeHdrTarget(1, 1, "SfSsrAccumA");
    this.accumB = makeHdrTarget(1, 1, "SfSsrAccumB");
    this.blurTarget = makeHdrTarget(1, 1, "SfSsrBlur");

    this.marchMaterial = new THREE.ShaderMaterial({
      name: "SfSsrMarch",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: marchFrag,
      defines: { SF_SSR_STEPS: (options.steps ?? 26).toFixed(0) },
      uniforms: {
        tDepth: { value: null as THREE.Texture | null },
        tColor: { value: null as THREE.Texture | null },
        uNear: envUniforms.near,
        uFar: envUniforms.far,
        uLogFC: envUniforms.logDepthFC,
        uInverseProjection: envUniforms.inverseProjection,
        uCameraMatrixWorld: envUniforms.cameraMatrixWorld,
        uProjection: envUniforms.projectionMatrix,
        uFullTexel: envUniforms.texelSize,
        uFrameIndex: envUniforms.frameIndex,
        tBlueNoise: envUniforms.blueNoise,
        uBlueNoiseTexel: envUniforms.blueNoiseTexel,
        uSkyZenith: envUniforms.skyZenith,
        uSkyHorizon: envUniforms.skyHorizon,
        uGroundAlbedo: envUniforms.groundAlbedo,
        uSunDirection: envUniforms.sunDirection,
        uSunRadiance: envUniforms.sunRadiance,
        uWetness: { value: 0.28 },
        uGlassiness: { value: 0.85 },
        uMaxDistance: { value: options.maxDistance ?? 180 },
        uThickness: { value: options.thickness ?? 0.6 },
        uIntensity: { value: options.intensity ?? 1 },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.accumMaterial = new THREE.ShaderMaterial({
      name: "SfSsrAccum",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: accumFrag,
      uniforms: {
        tCurrent: { value: null as THREE.Texture | null },
        tHistory: { value: null as THREE.Texture | null },
        tVelocity: { value: null as THREE.Texture | null },
        uFeedback: { value: 0.9 },
        uReset: { value: 1 },
        uTexel: { value: new THREE.Vector2(1, 1) },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.blurMaterial = new THREE.ShaderMaterial({
      name: "SfSsrBlur",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: blurFrag,
      uniforms: {
        tInput: { value: null as THREE.Texture | null },
        uDirection: { value: new THREE.Vector2(1, 0) },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
  }

  setVelocityTexture(texture: THREE.Texture): void {
    this.accumMaterial.uniforms.tVelocity.value = texture;
  }

  setDepthTexture(texture: THREE.Texture): void {
    this.marchMaterial.uniforms.tDepth.value = texture;
  }

  /** 0..1 — how wet the horizontal surfaces are. */
  set wetness(v: number) {
    this.marchMaterial.uniforms.uWetness.value = v;
  }
  /** 0..1 — how mirror-like vertical planar surfaces are. */
  set glassiness(v: number) {
    this.marchMaterial.uniforms.uGlassiness.value = v;
  }

  reset(): void {
    this.needsReset = true;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width * this.scale));
    const h = Math.max(1, Math.round(height * this.scale));
    this.width = w;
    this.height = h;
    this.marchTarget.setSize(w, h);
    this.accumA.setSize(w, h);
    this.accumB.setSize(w, h);
    this.blurTarget.setSize(w, h);
    (this.accumMaterial.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    this.needsReset = true;
  }

  update(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget): void {
    this.marchMaterial.uniforms.tColor.value = inputBuffer.texture;
    blit(renderer, this.marchMaterial, this.marchTarget);

    this.accumMaterial.uniforms.tCurrent.value = this.marchTarget.texture;
    this.accumMaterial.uniforms.tHistory.value = this.accumA.texture;
    this.accumMaterial.uniforms.uReset.value = this.needsReset ? 1 : 0;
    blit(renderer, this.accumMaterial, this.accumB);
    this.needsReset = false;

    const dir = this.blurMaterial.uniforms.uDirection.value as THREE.Vector2;
    this.blurMaterial.uniforms.tInput.value = this.accumB.texture;
    dir.set(1 / this.width, 0);
    blit(renderer, this.blurMaterial, this.blurTarget);

    this.blurMaterial.uniforms.tInput.value = this.blurTarget.texture;
    dir.set(0, 1 / this.height);
    blit(renderer, this.blurMaterial, this.marchTarget);

    this.uniforms.get("ssrBuffer")!.value = this.marchTarget.texture;

    const tmp = this.accumA;
    this.accumA = this.accumB;
    this.accumB = tmp;
  }

  dispose(): void {
    this.marchTarget.dispose();
    this.accumA.dispose();
    this.accumB.dispose();
    this.blurTarget.dispose();
    this.marchMaterial.dispose();
    this.accumMaterial.dispose();
    this.blurMaterial.dispose();
    super.dispose();
  }
}
