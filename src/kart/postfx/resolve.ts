/**
 * The resolve pass: ambient occlusion applied, and motion blur.
 *
 * These two live in one pass because both need a full-resolution read of the
 * scene and a full-resolution write, and on a software rasteriser a second
 * round trip through a 1080p half-float buffer costs more than everything else
 * in this file put together.
 *
 * **Motion blur.** There is no per-object velocity buffer: rendering the whole
 * field a second time with an override material to learn how fast a kart is
 * moving is not a trade worth making for an effect that is, at its best,
 * invisible. What there *is*:
 *
 *   · camera reprojection velocity from depth, which is exact for the world —
 *     the track, the crowd, the scenery, i.e. the 95% of the frame the eye
 *     reads as "speed";
 *   · a radial term from the vanishing point, ramped by speed and hard-ramped
 *     by boost, which is the arcade-racer language for going fast;
 *   · two masks that keep the player's kart out of it entirely — a near-depth
 *     mask (the kart sits 5-9 m from the chase camera) and a radial mask around
 *     the vanishing point (the kart sits within a few degrees of it). Camera
 *     reprojection is *wrong* for anything travelling with the camera, so
 *     without these the kart is the one thing in frame that smears, which is
 *     both incorrect and the exact thing the player is looking at.
 */
import * as THREE from "three";
import { PF_COLOR, PF_DEPTH, PF_NOISE, PF_VERT } from "./glsl";
import {
  Blitter,
  depthUniforms,
  disposeTarget,
  fullscreenMaterial,
  makeTarget,
  makeWhiteTexture,
  resizeTarget,
  type PostFxCaps,
  type SharedUniforms,
} from "./targets";

const resolveFrag = /* glsl */ `
precision highp float;
${PF_DEPTH}
${PF_COLOR}
${PF_NOISE}

uniform sampler2D tScene;
uniform sampler2D tAo;
uniform float uAspect;
uniform float uAoIntensity;
uniform float uShutter;
uniform float uRadial;
uniform vec2 uVanish;
uniform float uMaxBlur;
uniform float uNearStart;
uniform float uNearEnd;
uniform float uFrameIndex;
varying vec2 vUv;

void main() {
  float raw = pfRawDepth(vUv);
  float depth = -pfViewZ(raw);

  /* ---- blur vector ---- */
  vec2 blur = vec2(0.0);
  if (uShutter > 1e-4 || uRadial > 1e-4) {
    // Camera velocity is meaningless for sky texels (infinite depth makes the
    // reprojection explode), so pin them to the rotation-only term by sampling
    // at a finite distance.
    float sampleRaw = pfIsSky(raw) ? 0.9995 : raw;
    vec2 velocity = pfCameraVelocity(vUv, sampleRaw) * uShutter;

    vec2 fromVanish = vUv - uVanish;
    vec2 radial = fromVanish * uRadial;

    blur = velocity + radial;

    // Keep the player's kart crisp: near depth, and the few degrees around the
    // vanishing point where a chase camera parks it.
    float nearMask = smoothstep(uNearStart, uNearEnd, depth);
    float centreMask = smoothstep(0.05, 0.30, length(fromVanish * vec2(uAspect, 1.0)));
    blur *= nearMask * mix(0.35, 1.0, centreMask);

    // Absolute ceiling. An unclamped reprojection during a respawn teleport
    // produces a 4000-pixel smear and a one-frame white screen.
    float len = length(blur);
    if (len > uMaxBlur) blur *= uMaxBlur / len;
  }

  /* ---- accumulate ---- */
  vec3 color;
  if (dot(blur, blur) < 1e-9) {
    color = pfSanitize(texture2D(tScene, vUv).rgb);
  } else {
    // Jitter the tap offsets per pixel: eight uniformly spaced taps across a
    // 30-pixel smear reads as eight ghosts, the same eight dithered reads as
    // a smear. The dither is what makes a cheap tap count survivable.
    float jitter = pfIGNT(gl_FragCoord.xy, uFrameIndex) - 0.5;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < MB_TAPS; i++) {
      float t = (float(i) + 0.5 + jitter) / float(MB_TAPS) - 0.5;
      acc += pfSanitize(texture2D(tScene, vUv + blur * t).rgb);
    }
    color = acc / float(MB_TAPS);
  }

  /* ---- ambient occlusion ----
     Applied *after* the blur so a moving contact seam smears with its surface,
     and weighted down as the pixel gets brighter: AO is a visibility term on
     the ambient contribution only, and multiplying it into a sunlit road is
     what turns SSAO into soot. */
  if (uAoIntensity > 1e-4) {
    float ao = texture2D(tAo, vUv).r;
    float lit = smoothstep(0.35, 1.6, pfLuma(color));
    color *= mix(1.0, ao, uAoIntensity * (1.0 - lit * 0.75));
  }

  gl_FragColor = vec4(color, 1.0);
}
`;

export interface ResolveOptions {
  taps?: number;
}

export class ResolvePass {
  readonly target: THREE.WebGLRenderTarget;
  private readonly material: THREE.ShaderMaterial;
  private readonly white: THREE.DataTexture;

  constructor(caps: PostFxCaps, shared: SharedUniforms, options: ResolveOptions = {}) {
    this.target = makeTarget(1, 1, "KartResolve", caps);
    this.white = makeWhiteTexture();

    this.material = fullscreenMaterial(
      "KartResolve",
      resolveFrag,
      {
        ...depthUniforms(shared),
        tScene: { value: null },
        tAo: { value: this.white },
        uAspect: shared.uAspect,
        uAoIntensity: { value: 0 },
        uShutter: { value: 0 },
        uRadial: { value: 0 },
        uVanish: { value: new THREE.Vector2(0.5, 0.5) },
        uMaxBlur: { value: 0.035 },
        // The chase camera keeps the kart between roughly 5 and 9 metres out.
        uNearStart: { value: 7 },
        uNearEnd: { value: 20 },
        uFrameIndex: shared.uFrame,
      },
      PF_VERT,
    );
    this.material.defines = { MB_TAPS: String(Math.max(3, options.taps ?? 8)) };
  }

  setSize(width: number, height: number): void {
    resizeTarget(this.target, width, height);
  }

  /** Bind the AO term, or `null` to switch the multiply off entirely. */
  setAo(texture: THREE.Texture | null, intensity: number): void {
    this.material.uniforms.tAo.value = texture ?? this.white;
    this.material.uniforms.uAoIntensity.value = texture ? intensity : 0;
  }

  setMotion(shutter: number, radial: number, vanish: THREE.Vector2): void {
    this.material.uniforms.uShutter.value = shutter;
    this.material.uniforms.uRadial.value = radial;
    (this.material.uniforms.uVanish.value as THREE.Vector2).copy(vanish);
  }

  render(renderer: THREE.WebGLRenderer, blitter: Blitter, scene: THREE.Texture): void {
    this.material.uniforms.tScene.value = scene;
    blitter.draw(renderer, this.material, this.target);
  }

  dispose(): void {
    disposeTarget(this.target);
    this.material.dispose();
    this.white.dispose();
  }
}
