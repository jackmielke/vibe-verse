/**
 * FXAA — the always-on antialiasing.
 *
 * The renderer's own MSAA is switched off above the lowest quality tier (an
 * MSAA render target would have to be resolved before the post chain could read
 * it, and half-float MSAA resolves are not something to rely on across
 * drivers), so this pass is what keeps a kerb line from crawling.
 *
 * It runs on the *graded, display-space* image on purpose. FXAA's luma
 * threshold assumes a perceptually uniform signal; run it on linear HDR and it
 * either ignores every edge in the shadows or smears every highlight.
 *
 * The implementation is Lottes' original edge-direction estimate with a
 * subpixel term bolted on: cheap, no loops (which matters on a software
 * rasteriser, where a variable-length search is a branch nightmare), and
 * plenty for an image that is mostly large flat shapes.
 */
import * as THREE from "three";
import { PF_VERT } from "./glsl";
import { Blitter, fullscreenMaterial, type SharedUniforms } from "./targets";

const fxaaFrag = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uSubpix;
uniform float uEdgeThreshold;
uniform float uEdgeThresholdMin;
varying vec2 vUv;

// FXAA's own luma weights — NTSC, not Rec.709. Lottes chose them because the
// green-heavy weighting matches where the aliasing actually is.
float fxaaLuma(const in vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec2 t = uTexel;
  vec3 rgbM = texture2D(tInput, vUv).rgb;
  float lM = fxaaLuma(rgbM);
  float lN = fxaaLuma(texture2D(tInput, vUv + vec2(0.0, -t.y)).rgb);
  float lS = fxaaLuma(texture2D(tInput, vUv + vec2(0.0,  t.y)).rgb);
  float lW = fxaaLuma(texture2D(tInput, vUv + vec2(-t.x, 0.0)).rgb);
  float lE = fxaaLuma(texture2D(tInput, vUv + vec2( t.x, 0.0)).rgb);

  float lMin = min(lM, min(min(lN, lS), min(lW, lE)));
  float lMax = max(lM, max(max(lN, lS), max(lW, lE)));
  float range = lMax - lMin;

  // Early out on flat areas. This is most of the frame and it is the reason
  // FXAA is affordable at all.
  if (range < max(uEdgeThresholdMin, lMax * uEdgeThreshold)) {
    gl_FragColor = vec4(rgbM, 1.0);
    return;
  }

  float lNW = fxaaLuma(texture2D(tInput, vUv + vec2(-t.x, -t.y)).rgb);
  float lNE = fxaaLuma(texture2D(tInput, vUv + vec2( t.x, -t.y)).rgb);
  float lSW = fxaaLuma(texture2D(tInput, vUv + vec2(-t.x,  t.y)).rgb);
  float lSE = fxaaLuma(texture2D(tInput, vUv + vec2( t.x,  t.y)).rgb);

  // Edge direction from the corner gradients: the blur runs *along* the edge,
  // never across it, which is what stops FXAA from being a plain blur.
  vec2 dir = vec2(
    -((lNW + lNE) - (lSW + lSE)),
     ((lNW + lSW) - (lNE + lSE))
  );

  // Reduce: shorten the span on low-contrast edges so faint gradients are not
  // smeared into each other.
  float reduce = max((lNW + lNE + lSW + lSE) * 0.25 * (1.0 / 8.0), 1.0 / 128.0);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, vec2(-8.0), vec2(8.0)) * t;

  vec3 rgbA = 0.5 * (
    texture2D(tInput, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
    texture2D(tInput, vUv + dir * (2.0 / 3.0 - 0.5)).rgb
  );
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture2D(tInput, vUv + dir * -0.5).rgb +
    texture2D(tInput, vUv + dir *  0.5).rgb
  );

  // The wide (B) filter is only trusted while it stays inside the local luma
  // range; outside it, it has reached across the edge and the narrow (A)
  // filter is used instead.
  float lB = fxaaLuma(rgbB);
  vec3 result = (lB < lMin || lB > lMax) ? rgbA : rgbB;

  // Subpixel term: pull toward the neighbourhood mean in proportion to how
  // much of the contrast is sub-texel. Without it, a single bright pixel — a
  // spark, a coin's specular — flickers even though its edges are filtered.
  float lAvg = (lN + lS + lW + lE) * 0.25;
  float subpix = clamp(abs(lAvg - lM) / max(range, 1e-5), 0.0, 1.0);
  subpix = subpix * subpix * uSubpix;
  result = mix(result, rgbA, subpix);

  gl_FragColor = vec4(result, 1.0);
}
`;

export class FxaaPass {
  private readonly material: THREE.ShaderMaterial;

  constructor(shared: SharedUniforms) {
    this.material = fullscreenMaterial(
      "KartFxaa",
      fxaaFrag,
      {
        tInput: { value: null },
        uTexel: shared.uTexel,
        uSubpix: { value: 0.7 },
        uEdgeThreshold: { value: 0.166 },
        uEdgeThresholdMin: { value: 0.0625 },
      },
      PF_VERT,
    );
  }

  render(
    renderer: THREE.WebGLRenderer,
    blitter: Blitter,
    input: THREE.Texture,
    target: THREE.WebGLRenderTarget | null,
  ): void {
    this.material.uniforms.tInput.value = input;
    blitter.draw(renderer, this.material, target);
  }

  dispose(): void {
    this.material.dispose();
  }
}
