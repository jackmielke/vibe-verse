/**
 * Depth of field — far field only, and mild.
 *
 * A racer is not a film. Racking focus onto the kart and letting the corner
 * ahead go soft is exactly wrong: the player is reading that corner. What DOF
 * is for here is *depth separation* — the grandstand two hundred metres away
 * should not be as crisp as the kerb the player is about to clip, because
 * equally-crisp everything is the single most reliable tell of a real-time
 * image. So: the kart and the next thirty metres are untouched, and the blur
 * only opens up beyond that.
 *
 * The blur runs at half resolution with a premultiplied circle of confusion.
 * Premultiplying is the part people skip and then wonder why a sharp kart has a
 * smeared halo: if the downsample stores plain colour, a blurry background
 * texel gathers colour from the sharp foreground next to it and drags it
 * outward. Storing `colour × coc` and `coc`, then dividing by the gathered coc,
 * means an in-focus pixel contributes exactly nothing to its blurry neighbours.
 */
import * as THREE from "three";
import { PF_COLOR, PF_DEPTH, PF_DISK, PF_NOISE, PF_VERT } from "./glsl";
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

/**
 * Circle of confusion. Exported because the composite must compute the *same*
 * coc from the same uniforms when it lerps the sharp image against the blurred
 * one — two independently tuned focus curves is how you get a visible seam
 * where the blur starts.
 */
export const PF_COC = /* glsl */ `
uniform float uFocusEnd;
uniform float uFarEnd;
uniform float uMaxCoc;

float pfCoc(const in float depth) {
  return smoothstep(uFocusEnd, uFarEnd, depth) * uMaxCoc;
}
`;

const downsampleFrag = /* glsl */ `
precision highp float;
${PF_DEPTH}
${PF_COLOR}
${PF_COC}

uniform sampler2D tScene;
uniform vec2 uSceneTexel;
varying vec2 vUv;

void main() {
  vec2 o = uSceneTexel * 0.5;
  // A 2×2 box of the full-res image, each tap weighted by its own coc. Taking
  // the depth per tap rather than once at the centre keeps the half-res texel
  // straddling a silhouette from inheriting the far surface's blur.
  vec3 sum = vec3(0.0);
  float cocSum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 duv = vec2(i == 0 || i == 2 ? -1.0 : 1.0, i < 2 ? -1.0 : 1.0);
    vec2 uv = vUv + duv * o;
    float coc = pfCoc(-pfViewZ(pfRawDepth(uv)));
    sum += pfSanitize(texture2D(tScene, uv).rgb) * coc;
    cocSum += coc;
  }

  gl_FragColor = vec4(sum * 0.25, cocSum * 0.25);
}
`;

const blurFrag = /* glsl */ `
precision highp float;
${PF_DISK}
${PF_NOISE}

uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uFrameIndex;
varying vec2 vUv;

void main() {
  vec4 center = texture2D(tInput, vUv);
  if (center.a < 0.004) {
    gl_FragColor = center;
    return;
  }

  // The spiral is rotated per pixel; without it a 14-tap disk shows its rings
  // on any large flat area of sky.
  float rot = pfIGNT(gl_FragCoord.xy, uFrameIndex) * 6.2831853;
  // Radius follows the centre's own coc so a pixel that is only slightly out of
  // focus gets a slightly wide gather, not the full aperture.
  float radius = uRadius * center.a;

  vec4 acc = center;
  for (int i = 0; i < DOF_TAPS; i++) {
    // Offsets are in pixels and converted with the buffer's own texel size,
    // which makes the gather a circle on screen. Scaling one axis by the
    // aspect ratio — the reflex — would make bokeh an ellipse.
    vec2 d = pfDisk(float(i), float(DOF_TAPS), rot) * radius;
    acc += texture2D(tInput, vUv + d * uTexel);
  }

  gl_FragColor = acc / float(DOF_TAPS + 1);
}
`;

/** A 3×3 tent to erase whatever structure the disk left behind. Cheap at half res. */
const tentFrag = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uTexel;
varying vec2 vUv;

void main() {
  vec2 o = uTexel;
  vec4 s = texture2D(tInput, vUv + vec2(-o.x,  o.y));
  s += texture2D(tInput, vUv + vec2( 0.0,  o.y)) * 2.0;
  s += texture2D(tInput, vUv + vec2( o.x,  o.y));
  s += texture2D(tInput, vUv + vec2(-o.x,  0.0)) * 2.0;
  s += texture2D(tInput, vUv) * 4.0;
  s += texture2D(tInput, vUv + vec2( o.x,  0.0)) * 2.0;
  s += texture2D(tInput, vUv + vec2(-o.x, -o.y));
  s += texture2D(tInput, vUv + vec2( 0.0, -o.y)) * 2.0;
  s += texture2D(tInput, vUv + vec2( o.x, -o.y));
  gl_FragColor = s * (1.0 / 16.0);
}
`;

export interface DofOptions {
  taps?: number;
  /** Blur radius in half-res pixels at full coc. */
  radius?: number;
  /** Everything nearer than this stays perfectly crisp, in metres. */
  focusEnd?: number;
  /** Distance at which the blur reaches full strength, in metres. */
  farEnd?: number;
  maxCoc?: number;
}

export class DofPass {
  get texture(): THREE.Texture {
    return this.targetA.texture;
  }

  /** Uniforms the composite shares so its coc lerp matches this pass exactly. */
  readonly coc: {
    uFocusEnd: { value: number };
    uFarEnd: { value: number };
    uMaxCoc: { value: number };
  };

  private readonly targetA: THREE.WebGLRenderTarget;
  private readonly targetB: THREE.WebGLRenderTarget;
  private readonly downsampleMaterial: THREE.ShaderMaterial;
  private readonly blurMaterial: THREE.ShaderMaterial;
  private readonly tentMaterial: THREE.ShaderMaterial;

  constructor(caps: PostFxCaps, shared: SharedUniforms, options: DofOptions = {}) {
    this.coc = {
      uFocusEnd: { value: options.focusEnd ?? 34 },
      uFarEnd: { value: options.farEnd ?? 190 },
      uMaxCoc: { value: options.maxCoc ?? 0.85 },
    };

    this.targetA = makeTarget(1, 1, "KartDofA", caps);
    this.targetB = makeTarget(1, 1, "KartDofB", caps);

    this.downsampleMaterial = fullscreenMaterial(
      "KartDofDownsample",
      downsampleFrag,
      {
        ...depthUniforms(shared),
        ...this.coc,
        tScene: { value: null },
        uSceneTexel: shared.uTexel,
      },
      PF_VERT,
    );

    this.blurMaterial = fullscreenMaterial(
      "KartDofBlur",
      blurFrag,
      {
        tInput: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: options.radius ?? 5.5 },
        uFrameIndex: shared.uFrame,
      },
      PF_VERT,
    );
    this.blurMaterial.defines = { DOF_TAPS: String(Math.max(6, options.taps ?? 14)) };

    this.tentMaterial = fullscreenMaterial(
      "KartDofTent",
      tentFrag,
      { tInput: { value: null }, uTexel: { value: new THREE.Vector2() } },
      PF_VERT,
    );
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, width >> 1);
    const h = Math.max(1, height >> 1);
    resizeTarget(this.targetA, w, h);
    resizeTarget(this.targetB, w, h);
    (this.blurMaterial.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    (this.tentMaterial.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
  }

  render(renderer: THREE.WebGLRenderer, blitter: Blitter, scene: THREE.Texture): void {
    this.downsampleMaterial.uniforms.tScene.value = scene;
    blitter.draw(renderer, this.downsampleMaterial, this.targetA);

    this.blurMaterial.uniforms.tInput.value = this.targetA.texture;
    blitter.draw(renderer, this.blurMaterial, this.targetB);

    this.tentMaterial.uniforms.tInput.value = this.targetB.texture;
    blitter.draw(renderer, this.tentMaterial, this.targetA);
  }

  dispose(): void {
    disposeTarget(this.targetA);
    disposeTarget(this.targetB);
    this.downsampleMaterial.dispose();
    this.blurMaterial.dispose();
    this.tentMaterial.dispose();
  }
}
