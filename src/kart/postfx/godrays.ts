/**
 * Screen-space sun shafts.
 *
 * The classic radial-occlusion trick (Mitchell, GPU Gems 3), which is still the
 * right one for a bright outdoor racer: build a mask of "light that reaches the
 * camera", then smear it along the line from each pixel to the sun. It costs a
 * quarter-resolution mask and one 24-tap gather, and it produces the single
 * strongest atmospheric cue in the game — shafts breaking between grandstands
 * as the track swings the sun across the frame.
 *
 * The mask is *not* a luminance threshold on the scene. Thresholding makes the
 * white kerb paint and the chrome on the karts throw shafts, which is nonsense
 * and looks it. The mask is: sky texels only, weighted by proximity to the sun
 * disc. Everything the geometry wrote is an occluder, full stop.
 */
import * as THREE from "three";
import { PF_COLOR, PF_DEPTH, PF_NOISE, PF_VERT } from "./glsl";
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

const maskFrag = /* glsl */ `
precision highp float;
${PF_DEPTH}
${PF_COLOR}

uniform sampler2D tScene;
uniform vec2 uSunUv;
uniform float uAspect;
uniform float uDiscSize;
varying vec2 vUv;

void main() {
  float raw = pfRawDepth(vUv);
  if (!pfIsSky(raw)) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Only sky *near the sun* is a light source. The falloff is generous — the
  // aureole around a low sun is what makes the shafts read as atmosphere
  // rather than as a spotlight.
  vec2 d = (vUv - uSunUv) * vec2(uAspect, 1.0);
  float r = length(d);
  float disc = exp(-r * r / max(uDiscSize * uDiscSize, 1e-5));

  // Modulated by the sky's own colour so a golden-hour sun throws golden
  // shafts and an overcast one throws almost none, with no extra plumbing.
  vec3 sky = pfSanitize(texture2D(tScene, vUv).rgb);
  gl_FragColor = vec4(sky * disc, 1.0);
}
`;

const radialFrag = /* glsl */ `
precision highp float;
${PF_NOISE}

uniform sampler2D tInput;
uniform vec2 uSunUv;
uniform float uDensity;
uniform float uDecay;
uniform float uWeight;
uniform float uFrameIndex;
varying vec2 vUv;

void main() {
  vec2 delta = (vUv - uSunUv) * (uDensity / float(GR_TAPS));
  // Start each ray at a dithered offset. Undithered, a 24-tap march on a hard
  // occluder edge produces 24 visible stair steps along every shaft.
  vec2 uv = vUv - delta * pfIGNT(gl_FragCoord.xy, uFrameIndex);

  vec3 acc = vec3(0.0);
  float illumination = 1.0;
  for (int i = 0; i < GR_TAPS; i++) {
    uv -= delta;
    acc += texture2D(tInput, clamp(uv, 0.0, 1.0)).rgb * illumination;
    illumination *= uDecay;
  }

  gl_FragColor = vec4(acc * (uWeight / float(GR_TAPS)), 1.0);
}
`;

export interface GodRayOptions {
  taps?: number;
  /** How far along the sun ray the march reaches, in UV. */
  density?: number;
  decay?: number;
  /** Denominator of the render scale: 4 = quarter resolution. */
  scale?: number;
}

export class GodRayPass {
  get texture(): THREE.Texture {
    return this.targetB.texture;
  }

  private readonly targetA: THREE.WebGLRenderTarget;
  private readonly targetB: THREE.WebGLRenderTarget;
  private readonly maskMaterial: THREE.ShaderMaterial;
  private readonly radialMaterial: THREE.ShaderMaterial;
  private readonly scale: number;

  constructor(caps: PostFxCaps, shared: SharedUniforms, options: GodRayOptions = {}) {
    this.scale = options.scale ?? 4;
    this.targetA = makeTarget(1, 1, "KartGodRayMask", caps);
    this.targetB = makeTarget(1, 1, "KartGodRayBlur", caps);

    this.maskMaterial = fullscreenMaterial(
      "KartGodRayMask",
      maskFrag,
      {
        ...depthUniforms(shared),
        tScene: { value: null },
        uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
        uAspect: shared.uAspect,
        uDiscSize: { value: 0.42 },
      },
      PF_VERT,
    );

    this.radialMaterial = fullscreenMaterial(
      "KartGodRayRadial",
      radialFrag,
      {
        tInput: { value: null },
        uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
        uDensity: { value: options.density ?? 0.72 },
        uDecay: { value: options.decay ?? 0.965 },
        uWeight: { value: 1 },
        uFrameIndex: shared.uFrame,
      },
      PF_VERT,
    );
    this.radialMaterial.defines = { GR_TAPS: String(Math.max(8, options.taps ?? 24)) };
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / this.scale));
    const h = Math.max(1, Math.floor(height / this.scale));
    resizeTarget(this.targetA, w, h);
    resizeTarget(this.targetB, w, h);
  }

  /**
   * `weight` folds in every reason the shafts should fade — sun below the
   * horizon, sun off screen, night — so the composite can add the buffer
   * unconditionally and a fully faded pass costs one texture fetch of black.
   */
  render(
    renderer: THREE.WebGLRenderer,
    blitter: Blitter,
    scene: THREE.Texture,
    sunUv: THREE.Vector2,
    weight: number,
  ): void {
    (this.maskMaterial.uniforms.uSunUv.value as THREE.Vector2).copy(sunUv);
    (this.radialMaterial.uniforms.uSunUv.value as THREE.Vector2).copy(sunUv);
    this.radialMaterial.uniforms.uWeight.value = weight;

    this.maskMaterial.uniforms.tScene.value = scene;
    blitter.draw(renderer, this.maskMaterial, this.targetA);

    this.radialMaterial.uniforms.tInput.value = this.targetA.texture;
    blitter.draw(renderer, this.radialMaterial, this.targetB);
  }

  dispose(): void {
    disposeTarget(this.targetA);
    disposeTarget(this.targetB);
    this.maskMaterial.dispose();
    this.radialMaterial.dispose();
  }
}
