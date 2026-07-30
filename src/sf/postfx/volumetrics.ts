/**
 * Volumetric lighting — the marine layer, lit.
 *
 * San Francisco's fog is not atmosphere-as-garnish; it is the subject. A flat
 * exponential `THREE.Fog` gives you distance haze and nothing else: no shafts
 * through the gap between two towers, no glow around a streetlight, no sense
 * that the air itself is a volume you are moving through. This pass ray-marches
 * that volume properly.
 *
 * Per step: evaluate a height-based density modulated by drifting 3D noise
 * (fog arrives in banks, never as a uniform soup), sample the sun's *actual*
 * shadow map to find out whether that parcel of air is lit, accumulate
 * Henyey-Greenstein-weighted in-scattering, and attenuate transmittance. The
 * shadow map is the one `sky/Sky.tsx` already renders for the key light —
 * borrowed read-only, because rendering a second one to light the air would be
 * absurd.
 *
 * Sampling is one jittered ray per pixel at half resolution, cleaned up by a
 * temporal accumulator and a depth-aware upsample. Blue-noise-style dithering
 * of the ray start is what turns 24 steps into something that looks like 200.
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
  GLSL_PHASE,
  GLSL_SHADOW,
  GLSL_SKY,
} from "./glsl";
import { blit, makeHdrTarget } from "./fullscreen";

const marchFrag = /* glsl */ `
precision highp float;
${GLSL_DEPTH}
${GLSL_NOISE}
${GLSL_BLUE_NOISE}
${GLSL_PHASE}
${GLSL_SHADOW}
${GLSL_SKY}

uniform float uFrameIndex;
uniform float uTime;
uniform vec2 uWind;
uniform vec3 uCameraPos;
uniform float uFogDensity;
uniform float uFogHeight;     // scale height of the marine layer, metres
uniform float uFogFloor;      // altitude the layer sits on, metres
uniform float uExtinction;    // fraction of density that also blocks light
uniform float uAnisotropy;    // HG g
uniform float uMaxDistance;
uniform float uAmbient;
uniform float uShaftStrength;
uniform vec3 uSunScreen;
uniform float uIntensity;

varying vec2 vUv;

float fogAt(const in vec3 wp) {
  float h = max(wp.y - uFogFloor, 0.0);
  float base = exp(-h / uFogHeight);
  // Two octaves of drift at very different scales: big banks rolling in off
  // the Pacific, plus fine structure so a shaft has texture inside it.
  vec3 q = wp * 0.0013 + vec3(uWind.x, 0.0, uWind.y) * (uTime * 0.006);
  float bank = sfFbm3(q);
  float fine = sfValueNoise3(wp * 0.011 + vec3(uWind.x, 0.35, uWind.y) * (uTime * 0.02));
  float d = base * (0.30 + 1.35 * bank) * (0.75 + 0.5 * fine);
  return max(d, 0.0) * uFogDensity;
}

void main() {
  float wd = sfWindowDepth(sfRawDepth(vUv));
  bool sky = sfIsSky(wd);
  float viewZ = sfViewZ(wd);
  vec3 viewPos = sfViewPosition(vUv, viewZ);

  vec3 worldEnd = sfWorldFromView(viewPos);
  vec3 rayDir = worldEnd - uCameraPos;
  float sceneDist = length(rayDir);
  rayDir /= max(sceneDist, 1e-4);
  if (sky) sceneDist = uMaxDistance;
  float marchDist = min(sceneDist, uMaxDistance);

  float cosTheta = dot(rayDir, uSunDirection);
  float phase = sfHenyeyGreenstein(cosTheta, uAnisotropy);
  // A little isotropic backscatter keeps the fog from going black when you look
  // away from the sun — real fog is bright in every direction, just less so.
  phase = phase + 0.055;

  float stepLen = marchDist / float(SF_VOL_STEPS);
  float jitter = sfBlueNoise(gl_FragCoord.xy, uFrameIndex);

  vec3 scattered = vec3(0.0);
  float transmittance = 1.0;
  float t = stepLen * jitter;

  vec3 ambientColor = mix(uSkyHorizon, uSkyZenith, 0.35) * uAmbient;

  for (int i = 0; i < SF_VOL_STEPS; i++) {
    vec3 p = uCameraPos + rayDir * t;
    float density = fogAt(p);
    if (density > 1e-5) {
      float sigma = density * stepLen;
      // Bias grows with distance: shadow-map texels are metres wide out at the
      // edge of the cascade and self-shadowing acne in a volume reads as
      // horizontal banding across the whole shaft.
      float vis = sfSunVisibility(p, 0.0015 + t * 0.000012);
      vec3 inScatter = uSunRadiance * (vis * phase) + ambientColor;
      // Energy-conserving integration of a constant-density segment rather than
      // a naive rectangle sum — this is what stops thick fog from blowing out.
      float sampleT = 1.0 - exp(-sigma * uExtinction);
      scattered += transmittance * inScatter * sampleT;
      transmittance *= exp(-sigma * uExtinction);
      if (transmittance < 0.006) break;
    }
    t += stepLen;
  }

  /* ---- screen-space light shafts ---- */
  // The volumetric march only reaches as far as the shadow cascade. When the
  // sun itself is in frame, a short radial occlusion scan adds the long
  // god rays that stretch past it — cheap, and it is the shot everyone takes
  // over the Golden Gate at 19:00.
  if (uSunScreen.z > 0.5 && uShaftStrength > 0.0) {
    vec2 delta = (uSunScreen.xy - vUv) * 0.5;
    vec2 uv2 = vUv;
    float decay = 1.0;
    float illum = 0.0;
    for (int i = 0; i < 12; i++) {
      uv2 += delta * (1.0 / 12.0);
      float d = sfWindowDepth(sfRawDepth(uv2));
      illum += (d >= 0.99999 ? 1.0 : 0.0) * decay;
      decay *= 0.93;
    }
    illum /= 12.0;
    float aim = pow(max(cosTheta, 0.0), 6.0);
    scattered += uSunRadiance * illum * aim * uShaftStrength * uFogDensity;
  }

  gl_FragColor = vec4(scattered * uIntensity, transmittance);
}
`;

const accumFrag = /* glsl */ `
precision highp float;
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tVelocity;
uniform float uFeedback;
uniform float uReset;
varying vec2 vUv;

void main() {
  vec4 cur = texture2D(tCurrent, vUv);
  vec2 vel = texture2D(tVelocity, vUv).xy;
  vec2 prevUv = vUv - vel;
  float valid = 1.0 - uReset;
  if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) valid = 0.0;
  vec4 hist = texture2D(tHistory, prevUv);
  // Volumetrics are low frequency; a generous clamp band is enough to stop
  // trailing without giving up the smoothing that makes 24 steps viable.
  vec4 clamped = clamp(hist, cur - 0.35, cur + 0.35);
  gl_FragColor = mix(cur, mix(cur, clamped, uFeedback), valid);
}
`;

const compositeFrag = /* glsl */ `
${GLSL_EFFECT_DEPTH}
uniform sampler2D volBuffer;
uniform vec2 volTexel;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // Depth-aware upsample: weight the four half-res taps by how well their depth
  // matches, so shafts do not leak across a rooftop edge into the sky.
  float centerDepth = sfDepthMetres(uv);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      vec2 o = (vec2(float(x), float(y)) - 0.5) * volTexel;
      float dz = abs(sfDepthMetres(uv + o) - centerDepth);
      float w = 1.0 / (0.01 + dz * 0.02);
      acc += texture2D(volBuffer, uv + o) * w;
      wsum += w;
    }
  }
  acc /= max(wsum, 1e-4);

  // Standard participating-media composite: attenuate what is behind the
  // volume, then add what the volume itself emitted toward the eye.
  outputColor = vec4(inputColor.rgb * clamp(acc.a, 0.0, 1.0) + acc.rgb, inputColor.a);
}
`;

export interface VolumetricOptions {
  steps?: number;
  resolutionScale?: number;
  /** Scale height of the marine layer in metres. */
  fogHeight?: number;
  /** Altitude the layer floor sits at, metres above sea level. */
  fogFloor?: number;
  /** Henyey-Greenstein anisotropy. 0.6-0.8 for water droplets. */
  anisotropy?: number;
  /** Fraction of the density that actually extinguishes light. */
  extinction?: number;
  maxDistance?: number;
  intensity?: number;
}

export class VolumetricLightEffect extends Effect {
  private marchTarget: THREE.WebGLRenderTarget;
  private accumA: THREE.WebGLRenderTarget;
  private accumB: THREE.WebGLRenderTarget;

  private marchMaterial: THREE.ShaderMaterial;
  private accumMaterial: THREE.ShaderMaterial;

  private scale: number;
  private needsReset = true;

  constructor(options: VolumetricOptions = {}) {
    const uniforms = new Map<string, THREE.Uniform>([
      ["volBuffer", new THREE.Uniform(null)],
      ["volTexel", new THREE.Uniform(new THREE.Vector2(1, 1))],
      ["logFC", envUniforms.logDepthFC],
      ["camNear", envUniforms.near],
      ["camFar", envUniforms.far],
      ["invProjection", envUniforms.inverseProjection],
      ["camWorld", envUniforms.cameraMatrixWorld],
    ]);

    super("SfVolumetrics", compositeFrag, {
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.NORMAL,
      uniforms,
    });

    this.scale = options.resolutionScale ?? 0.5;

    this.marchTarget = makeHdrTarget(1, 1, "SfVolMarch");
    this.accumA = makeHdrTarget(1, 1, "SfVolAccumA");
    this.accumB = makeHdrTarget(1, 1, "SfVolAccumB");

    this.marchMaterial = new THREE.ShaderMaterial({
      name: "SfVolumetricMarch",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: marchFrag,
      defines: { SF_VOL_STEPS: (options.steps ?? 48).toFixed(0) },
      uniforms: {
        tDepth: { value: null as THREE.Texture | null },
        uNear: envUniforms.near,
        uFar: envUniforms.far,
        uLogFC: envUniforms.logDepthFC,
        uInverseProjection: envUniforms.inverseProjection,
        uCameraMatrixWorld: envUniforms.cameraMatrixWorld,
        uSkyZenith: envUniforms.skyZenith,
        uSkyHorizon: envUniforms.skyHorizon,
        uGroundAlbedo: envUniforms.groundAlbedo,
        uSunDirection: envUniforms.sunDirection,
        uSunRadiance: envUniforms.sunRadiance,
        uShadowMap: envUniforms.shadowMap,
        uShadowMatrix: envUniforms.shadowMatrix,
        uShadowValid: envUniforms.shadowValid,
        uSunScreen: envUniforms.sunScreen,
        uCameraPos: envUniforms.cameraPosition,
        uFrameIndex: envUniforms.frameIndex,
        tBlueNoise: envUniforms.blueNoise,
        uBlueNoiseTexel: envUniforms.blueNoiseTexel,
        uTime: envUniforms.time,
        uWind: envUniforms.wind,
        uFogDensity: envUniforms.fogDensity,
        uFogHeight: { value: options.fogHeight ?? 170 },
        uFogFloor: { value: options.fogFloor ?? -10 },
        uExtinction: { value: options.extinction ?? 0.0042 },
        uAnisotropy: { value: options.anisotropy ?? 0.72 },
        uMaxDistance: { value: options.maxDistance ?? 2400 },
        uAmbient: { value: 0.5 },
        uShaftStrength: { value: 0.55 },
        uIntensity: { value: options.intensity ?? 1 },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.accumMaterial = new THREE.ShaderMaterial({
      name: "SfVolAccum",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: accumFrag,
      uniforms: {
        tCurrent: { value: null as THREE.Texture | null },
        tHistory: { value: null as THREE.Texture | null },
        tVelocity: { value: null as THREE.Texture | null },
        uFeedback: { value: 0.9 },
        uReset: { value: 1 },
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

  set intensity(v: number) {
    this.marchMaterial.uniforms.uIntensity.value = v;
  }

  /** How strong the screen-space god rays are on top of the march. */
  set shaftStrength(v: number) {
    this.marchMaterial.uniforms.uShaftStrength.value = v;
  }

  reset(): void {
    this.needsReset = true;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width * this.scale));
    const h = Math.max(1, Math.round(height * this.scale));
    this.marchTarget.setSize(w, h);
    this.accumA.setSize(w, h);
    this.accumB.setSize(w, h);
    (this.uniforms.get("volTexel")!.value as THREE.Vector2).set(1 / w, 1 / h);
    this.needsReset = true;
  }

  update(renderer: THREE.WebGLRenderer): void {
    blit(renderer, this.marchMaterial, this.marchTarget);

    this.accumMaterial.uniforms.tCurrent.value = this.marchTarget.texture;
    this.accumMaterial.uniforms.tHistory.value = this.accumA.texture;
    this.accumMaterial.uniforms.uReset.value = this.needsReset ? 1 : 0;
    blit(renderer, this.accumMaterial, this.accumB);
    this.needsReset = false;

    this.uniforms.get("volBuffer")!.value = this.accumB.texture;

    const tmp = this.accumA;
    this.accumA = this.accumB;
    this.accumB = tmp;
  }

  dispose(): void {
    this.marchTarget.dispose();
    this.accumA.dispose();
    this.accumB.dispose();
    this.marchMaterial.dispose();
    this.accumMaterial.dispose();
    super.dispose();
  }
}
