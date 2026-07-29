/**
 * GTAO — ground-truth ambient occlusion.
 *
 * Not "SSAO with more samples". Classic SSAO integrates a hemisphere of point
 * samples and calls the ratio occlusion, which is why it haloes: a sample that
 * lands behind a thin railing counts as fully blocking. GTAO instead searches
 * for the *horizon angle* along a set of slices through the view vector and
 * evaluates the cosine-weighted visibility arc analytically. The result is
 * physically the same quantity a path tracer would compute for a distant
 * uniform environment, which is why it darkens the crease where a bay window
 * meets a wall and leaves the wall alone.
 *
 * Practical additions for a city:
 *  - A thickness heuristic, so fire escapes, cables and lamp posts stop
 *    painting themselves onto the facade thirty metres behind them.
 *  - Half-resolution evaluation, temporal accumulation through the velocity
 *    buffer, and a depth-aware separable blur — one noisy sample per pixel per
 *    frame resolves clean because TAA and this accumulator are doing the
 *    integration between them.
 */
import * as THREE from "three";
import { Effect, EffectAttribute, BlendFunction } from "postprocessing";
import { envUniforms } from "./env";
import { FULLSCREEN_VERT, GLSL_DEPTH, GLSL_EFFECT_DEPTH, GLSL_NOISE, GLSL_NORMAL } from "./glsl";
import { blit, makeHdrTarget } from "./fullscreen";

/* ------------------------------------------------------------------ *
 * Horizon search
 * ------------------------------------------------------------------ */

const aoFrag = /* glsl */ `
precision highp float;
${GLSL_DEPTH}
${GLSL_NORMAL}
${GLSL_NOISE}

uniform vec2 uTexel;       // AO target texel
uniform vec2 uFullTexel;   // full-res texel, for normal reconstruction
uniform float uProjScale;  // 0.5 * targetHeight * P[1][1]
uniform float uRadius;     // world-space sampling radius, metres
uniform float uThickness;  // assumed occluder thickness, metres
uniform float uPower;
uniform float uFrameIndex;

varying vec2 vUv;

void main() {
  float wd = sfWindowDepth(sfRawDepth(vUv));
  if (sfIsSky(wd)) {
    gl_FragColor = vec4(1.0, 1.0, 0.0, 1.0);
    return;
  }

  float viewZ = sfViewZ(wd);
  vec3 P = sfViewPosition(vUv, viewZ);
  vec3 N = sfNormalFromDepth(vUv, P, uFullTexel);
  vec3 V = normalize(-P);

  float dist = -P.z;
  // Clamped so a wall two metres from the lens does not sample a third of the
  // screen (murderously cache-hostile) and a rooftop a kilometre out does not
  // collapse to a single texel (pure noise).
  float radiusPx = clamp(uRadius * uProjScale / max(dist, 1e-3), 3.0, 84.0);

  float noise = sfIGNT(gl_FragCoord.xy, uFrameIndex);
  float stepNoise = fract(noise * 7.0 + 0.37);

  float visibility = 0.0;

  for (int s = 0; s < SF_SLICES; s++) {
    float phi = (float(s) + noise) * 3.141592653589793 / float(SF_SLICES);
    vec2 dir = vec2(cos(phi), sin(phi));
    vec3 sliceDir = vec3(dir, 0.0);

    vec3 axis = cross(sliceDir, V);
    float axisLen = length(axis);
    if (axisLen < 1e-4) continue;
    axis /= axisLen;

    // Normal projected into the slice plane, and the angle it makes with V.
    vec3 projN = N - axis * dot(N, axis);
    float projNLen = length(projN);
    if (projNLen < 1e-4) continue;
    projN /= projNLen;

    vec3 orthoDir = sliceDir - V * dot(sliceDir, V);
    float orthoLen = length(orthoDir);
    if (orthoLen < 1e-4) continue;
    orthoDir /= orthoLen;

    float cosN = clamp(dot(projN, V), -1.0, 1.0);
    float n = sign(dot(projN, orthoDir)) * acos(cosN);

    float cH0 = -1.0;
    float cH1 = -1.0;

    for (int t = 0; t < SF_STEPS; t++) {
      // Quadratic step distribution — density where contact shadows live.
      float f = (float(t) + stepNoise) / float(SF_STEPS);
      vec2 offs = dir * (f * f * radiusPx) * uTexel;

      vec3 d0 = sfViewPositionAt(vUv + offs) - P;
      vec3 d1 = sfViewPositionAt(vUv - offs) - P;

      float l0 = max(length(d0), 1e-4);
      float l1 = max(length(d1), 1e-4);

      // Distance falloff: beyond the radius an occluder is simply not part of
      // this AO term (the sky visibility it blocks belongs to the shadow map).
      float fall0 = clamp((l0 - uRadius * 0.55) / (uRadius * 0.45 + 1e-4), 0.0, 1.0);
      float fall1 = clamp((l1 - uRadius * 0.55) / (uRadius * 0.45 + 1e-4), 0.0, 1.0);

      // Thickness: a sample far in front in Z is a thin object we can see past.
      float thin0 = 1.0 - smoothstep(uThickness, uThickness * 2.5, abs(d0.z));
      float thin1 = 1.0 - smoothstep(uThickness, uThickness * 2.5, abs(d1.z));

      float c0 = dot(d0 / l0, V);
      float c1 = dot(d1 / l1, V);
      cH0 = max(cH0, mix(-1.0, c0, (1.0 - fall0) * thin0));
      cH1 = max(cH1, mix(-1.0, c1, (1.0 - fall1) * thin1));
    }

    // The GTAO arc integral. h0/h1 are the two horizon angles clamped to the
    // hemisphere around the projected normal.
    float h0 = -acos(clamp(cH1, -1.0, 1.0));
    float h1 =  acos(clamp(cH0, -1.0, 1.0));
    h0 = n + max(h0 - n, -1.5707963267948966);
    h1 = n + min(h1 - n,  1.5707963267948966);
    float sinN = sin(n);
    float cosN2 = cos(n);
    float arc = 0.25 * (
      (-cos(2.0 * h0 - n) + cosN2 + 2.0 * h0 * sinN) +
      (-cos(2.0 * h1 - n) + cosN2 + 2.0 * h1 * sinN)
    );
    visibility += projNLen * arc;
  }

  visibility /= float(SF_SLICES);
  float ao = pow(clamp(visibility, 0.0, 1.0), uPower);
  // G channel carries normalised linear depth so the accumulator and the
  // bilateral blur can reject across silhouettes without a second fetch.
  gl_FragColor = vec4(ao, dist / uFar, 0.0, 1.0);
}
`;

/* ------------------------------------------------------------------ *
 * Temporal accumulation
 * ------------------------------------------------------------------ */

const accumFrag = /* glsl */ `
precision highp float;
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tVelocity;
uniform vec2 uTexel;
uniform float uFar;
uniform float uFeedback;
uniform float uReset;
varying vec2 vUv;

void main() {
  vec2 cur = texture2D(tCurrent, vUv).rg;
  vec2 vel = texture2D(tVelocity, vUv).xy;
  vec2 prevUv = vUv - vel;

  float valid = 1.0 - uReset;
  if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) valid = 0.0;

  vec2 hist = texture2D(tHistory, prevUv).rg;
  float curDepth = cur.g * uFar;
  float histDepth = hist.g * uFar;
  if (abs(curDepth - histDepth) > 0.04 * curDepth + 0.35) valid = 0.0;

  // Clamp history into the current neighbourhood: AO ghosts badly around a
  // moving car otherwise, and a lagging dark smear reads as a shadow bug.
  float a = texture2D(tCurrent, vUv + vec2(uTexel.x, 0.0)).r;
  float b = texture2D(tCurrent, vUv - vec2(uTexel.x, 0.0)).r;
  float c = texture2D(tCurrent, vUv + vec2(0.0, uTexel.y)).r;
  float d = texture2D(tCurrent, vUv - vec2(0.0, uTexel.y)).r;
  float lo = min(min(a, b), min(min(c, d), cur.r));
  float hi = max(max(a, b), max(max(c, d), cur.r));
  float h = clamp(hist.r, lo - 0.08, hi + 0.08);

  float ao = mix(cur.r, mix(cur.r, h, uFeedback), valid);
  gl_FragColor = vec4(ao, cur.g, 0.0, 1.0);
}
`;

/* ------------------------------------------------------------------ *
 * Depth-aware separable blur
 * ------------------------------------------------------------------ */

const blurFrag = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uDirection;   // texel-scaled step
uniform float uFar;
uniform float uSharpness;
varying vec2 vUv;

void main() {
  vec2 center = texture2D(tInput, vUv).rg;
  float centerDepth = center.g * uFar;

  float sum = center.r;
  float wsum = 1.0;

  // Five taps each side with a Gaussian spatial term and a depth range term —
  // the range term is what keeps occlusion from bleeding across a rooftop edge.
  for (int i = 1; i <= 5; i++) {
    float fi = float(i);
    float spatial = exp(-fi * fi * 0.18);
    for (int sgn = 0; sgn < 2; sgn++) {
      vec2 o = uDirection * fi * (sgn == 0 ? 1.0 : -1.0);
      vec2 s = texture2D(tInput, vUv + o).rg;
      float dz = abs(s.g * uFar - centerDepth);
      float range = exp(-dz * dz * uSharpness);
      float w = spatial * range;
      sum += s.r * w;
      wsum += w;
    }
  }

  gl_FragColor = vec4(sum / wsum, center.g, 0.0, 1.0);
}
`;

/* ------------------------------------------------------------------ *
 * Composite
 * ------------------------------------------------------------------ */

const compositeFrag = /* glsl */ `
${GLSL_EFFECT_DEPTH}
uniform sampler2D aoBuffer;
uniform vec2 aoTexel;
uniform float intensity;
uniform float aoFar;

/**
 * Bilateral upsample from the half-resolution AO. A plain bilinear fetch
 * bleeds occlusion across silhouettes and produces the classic one-pixel dark
 * outline around every foreground object.
 */
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  float centerDepth = sfDepthMetres(uv);

  float ao = 0.0;
  float wsum = 0.0;
  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      vec2 o = (vec2(float(x), float(y)) - 0.5) * aoTexel;
      vec2 s = texture2D(aoBuffer, uv + o).rg;
      float dz = abs(s.g * aoFar - centerDepth);
      float w = 1.0 / (0.004 + dz * 0.2);
      ao += s.r * w;
      wsum += w;
    }
  }
  ao = wsum > 0.0 ? ao / wsum : 1.0;

  float k = mix(1.0, ao, intensity);
  outputColor = vec4(inputColor.rgb * k, inputColor.a);
}
`;

export interface GtaoOptions {
  /** Directional slices. 2 is fine with TAA, 3-4 for ultra. */
  slices?: number;
  /** Horizon steps per slice direction. */
  steps?: number;
  /** World-space sampling radius in metres. */
  radius?: number;
  /** Assumed occluder thickness in metres. */
  thickness?: number;
  /** Occlusion contrast. >1 darkens creases faster. */
  power?: number;
  /** 0..1 how much of the AO is applied. */
  intensity?: number;
  /** Fraction of full resolution the AO is evaluated at. */
  resolutionScale?: number;
}

export class GtaoEffect extends Effect {
  private aoTarget: THREE.WebGLRenderTarget;
  private accumA: THREE.WebGLRenderTarget;
  private accumB: THREE.WebGLRenderTarget;
  private blurTarget: THREE.WebGLRenderTarget;

  private aoMaterial: THREE.ShaderMaterial;
  private accumMaterial: THREE.ShaderMaterial;
  private blurMaterial: THREE.ShaderMaterial;

  private scale: number;
  private width = 1;
  private height = 1;
  private needsReset = true;

  constructor(options: GtaoOptions = {}) {
    const slices = options.slices ?? 2;
    const steps = options.steps ?? 6;
    const uniforms = new Map<string, THREE.Uniform>([
      ["aoBuffer", new THREE.Uniform(null)],
      ["aoTexel", new THREE.Uniform(new THREE.Vector2(1, 1))],
      ["intensity", new THREE.Uniform(options.intensity ?? 0.9)],
      ["aoFar", envUniforms.far],
      ["logFC", envUniforms.logDepthFC],
      ["camNear", envUniforms.near],
      ["camFar", envUniforms.far],
      ["invProjection", envUniforms.inverseProjection],
      ["camWorld", envUniforms.cameraMatrixWorld],
    ]);

    super("SfGTAO", compositeFrag, {
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.NORMAL,
      uniforms,
    });

    this.scale = options.resolutionScale ?? 0.5;

    this.aoTarget = makeHdrTarget(1, 1, "SfGtaoRaw");
    this.accumA = makeHdrTarget(1, 1, "SfGtaoAccumA");
    this.accumB = makeHdrTarget(1, 1, "SfGtaoAccumB");
    this.blurTarget = makeHdrTarget(1, 1, "SfGtaoBlur");

    this.aoMaterial = new THREE.ShaderMaterial({
      name: "SfGtaoHorizon",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: aoFrag,
      defines: { SF_SLICES: slices.toFixed(0), SF_STEPS: steps.toFixed(0) },
      uniforms: {
        tDepth: { value: null as THREE.Texture | null },
        uNear: envUniforms.near,
        uFar: envUniforms.far,
        uLogFC: envUniforms.logDepthFC,
        uInverseProjection: envUniforms.inverseProjection,
        uCameraMatrixWorld: envUniforms.cameraMatrixWorld,
        uTexel: { value: new THREE.Vector2(1, 1) },
        uFullTexel: envUniforms.texelSize,
        uProjScale: { value: 500 },
        uRadius: { value: options.radius ?? 2.2 },
        uThickness: { value: options.thickness ?? 0.55 },
        uPower: { value: options.power ?? 1.35 },
        uFrameIndex: envUniforms.frameIndex,
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.accumMaterial = new THREE.ShaderMaterial({
      name: "SfGtaoAccum",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: accumFrag,
      uniforms: {
        tCurrent: { value: null as THREE.Texture | null },
        tHistory: { value: null as THREE.Texture | null },
        tVelocity: { value: null as THREE.Texture | null },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uFar: envUniforms.far,
        uFeedback: { value: 0.88 },
        uReset: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.blurMaterial = new THREE.ShaderMaterial({
      name: "SfGtaoBlur",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: blurFrag,
      uniforms: {
        tInput: { value: null as THREE.Texture | null },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uFar: envUniforms.far,
        uSharpness: { value: 0.35 },
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
    this.aoMaterial.uniforms.tDepth.value = texture;
  }

  set intensity(v: number) {
    this.uniforms.get("intensity")!.value = v;
  }
  get intensity(): number {
    return this.uniforms.get("intensity")!.value as number;
  }

  set radius(v: number) {
    this.aoMaterial.uniforms.uRadius.value = v;
  }

  reset(): void {
    this.needsReset = true;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width * this.scale));
    const h = Math.max(1, Math.round(height * this.scale));
    this.width = w;
    this.height = h;
    this.aoTarget.setSize(w, h);
    this.accumA.setSize(w, h);
    this.accumB.setSize(w, h);
    this.blurTarget.setSize(w, h);
    (this.aoMaterial.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    (this.accumMaterial.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    (this.uniforms.get("aoTexel")!.value as THREE.Vector2).set(1 / w, 1 / h);
    this.needsReset = true;
  }

  update(renderer: THREE.WebGLRenderer): void {
    // Screen-space radius conversion needs the vertical projection scale of the
    // buffer we are actually rendering into.
    this.aoMaterial.uniforms.uProjScale.value =
      0.5 * this.height * envUniforms.projectionMatrix.value.elements[5];

    blit(renderer, this.aoMaterial, this.aoTarget);

    this.accumMaterial.uniforms.tCurrent.value = this.aoTarget.texture;
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
    blit(renderer, this.blurMaterial, this.aoTarget);

    this.uniforms.get("aoBuffer")!.value = this.aoTarget.texture;

    // Swap accumulation buffers: accumA is always "the history".
    const tmp = this.accumA;
    this.accumA = this.accumB;
    this.accumB = tmp;
  }

  dispose(): void {
    this.aoTarget.dispose();
    this.accumA.dispose();
    this.accumB.dispose();
    this.blurTarget.dispose();
    this.aoMaterial.dispose();
    this.accumMaterial.dispose();
    this.blurMaterial.dispose();
    super.dispose();
  }
}
