/**
 * Depth of field with a physically-derived circle of confusion.
 *
 * The CoC diameter on the sensor for a thin lens is
 *
 *     c = (A · f · |d − s|) / (d · (s − f))
 *
 * with aperture diameter `A = f / N`, focal length `f`, focus distance `s` and
 * subject distance `d`. Converting that to pixels needs one more number, the
 * sensor height (24 mm here, full-frame). Doing it this way rather than with an
 * ad-hoc "blur strength" means f/1.4 on a 85 mm lens behaves like f/1.4 on an
 * 85 mm lens: ADS at f/4 gives a readable background, photo mode at f/1.4 melts
 * it, and neither needed a magic number.
 *
 * Near and far fields are gathered separately. They have to be: the far field
 * must not bleed onto a sharp subject, while the near field *must* bleed over
 * everything behind it — a foreground railing at f/2 spills across the whole
 * frame, and a single-buffer blur can never do that.
 *
 * Autofocus is measured on the GPU into a 1×1 target with exponential
 * smoothing. Reading depth back to the CPU to find the focus distance would
 * stall the pipeline every frame for a single float.
 */
import * as THREE from "three";
import { Effect, EffectAttribute, BlendFunction } from "postprocessing";
import { envUniforms } from "./env";
import { FULLSCREEN_VERT, GLSL_DEPTH, GLSL_EFFECT_DEPTH, GLSL_NOISE } from "./glsl";
import { blit, makeHdrTarget } from "./fullscreen";

const focusFrag = /* glsl */ `
precision highp float;
${GLSL_DEPTH}
uniform sampler2D tPrevFocus;
uniform float uManualFocus;
uniform float uAuto;
uniform float uRate;   // 1 - exp(-k*dt), precomputed on the CPU
varying vec2 vUv;

void main() {
  // Three taps in a tight cluster at the crosshair: a single tap lands in a gap
  // between railings and the focus jumps to the horizon for one frame.
  float d0 = -sfSampleViewZ(vec2(0.5, 0.5));
  float d1 = -sfSampleViewZ(vec2(0.5 + 0.006, 0.5));
  float d2 = -sfSampleViewZ(vec2(0.5, 0.5 + 0.006));
  float measured = min(d0, min(d1, d2));
  measured = clamp(measured, 0.2, 6000.0);

  float target = mix(uManualFocus, measured, uAuto);
  float prev = texture2D(tPrevFocus, vec2(0.5)).r;
  if (prev <= 0.0) prev = target;
  gl_FragColor = vec4(mix(prev, target, uRate), 0.0, 0.0, 1.0);
}
`;

const cocFrag = /* glsl */ `
precision highp float;
${GLSL_DEPTH}
uniform sampler2D tFocus;
uniform float uAperture;      // f-number
uniform float uFocalLength;   // metres
uniform float uSensorHeight;  // metres
uniform float uViewportHeight;// pixels
uniform float uMaxCoC;        // pixels
varying vec2 vUv;

void main() {
  float wd = sfWindowDepth(sfRawDepth(vUv));
  float d = -sfViewZ(wd);
  float s = texture2D(tFocus, vec2(0.5)).r;
  float f = uFocalLength;
  float A = f / max(uAperture, 0.5);

  // Guard the degenerate cases: focus at or inside the focal length, and
  // subjects at the lens.
  float denom = max(d * (s - f), 1e-6);
  float cocMeters = (A * f * abs(d - s)) / denom;
  float cocPx = cocMeters / uSensorHeight * uViewportHeight;
  cocPx = min(cocPx, uMaxCoC);
  // Sky sits at the far plane; keep it in the far field rather than letting the
  // formula run away to a thousand-pixel circle.
  if (sfIsSky(wd)) cocPx = uMaxCoC;

  float signedCoc = (d < s) ? -cocPx : cocPx;
  gl_FragColor = vec4(signedCoc / uMaxCoC, d / uFar, 0.0, 1.0);
}
`;

/** Max-filter the near-field CoC so foreground blur spreads past its silhouette. */
const dilateFrag = /* glsl */ `
precision highp float;
uniform sampler2D tCoC;
uniform vec2 uTexel;
varying vec2 vUv;

void main() {
  vec2 center = texture2D(tCoC, vUv).rg;
  float nearMax = -min(center.r, 0.0);
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 s = texture2D(tCoC, vUv + vec2(float(x), float(y)) * uTexel).rg;
      nearMax = max(nearMax, -min(s.r, 0.0));
    }
  }
  gl_FragColor = vec4(center.r, center.g, nearMax, 1.0);
}
`;

const gatherFrag = /* glsl */ `
precision highp float;
${GLSL_NOISE}
uniform sampler2D tColor;
uniform sampler2D tCoC;
uniform vec2 uTexel;        // full-resolution texel
uniform float uMaxCoC;
uniform float uFar;
uniform float uFrameIndex;
uniform float uNearField;
varying vec2 vUv;

void main() {
  vec3 center = texture2D(tColor, vUv).rgb;
  vec3 cocSample = texture2D(tCoC, vUv).rgb;
  float signedCoc = cocSample.r * uMaxCoC;
  float centerDepth = cocSample.g * uFar;

  float radius = uNearField > 0.5 ? cocSample.b * uMaxCoC : max(signedCoc, 0.0);
  if (radius < 1.0) {
    gl_FragColor = vec4(center, uNearField > 0.5 ? 0.0 : 1.0);
    return;
  }

  float rot = sfIGNT(gl_FragCoord.xy, uFrameIndex) * 6.283185307;

  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  float coverage = 0.0;

  for (int i = 0; i < SF_DOF_SAMPLES; i++) {
    float fi = float(i) + 0.5;
    // Golden-angle spiral: uniform disc coverage with no visible structure,
    // which is what makes the bokeh read as a lens rather than as a kernel.
    float r = sqrt(fi / float(SF_DOF_SAMPLES));
    float theta = fi * 2.39996323 + rot;
    vec2 dir = vec2(cos(theta), sin(theta));
    vec2 offs = dir * r * radius * uTexel;

    vec3 s = texture2D(tColor, vUv + offs).rgb;
    vec3 sc = texture2D(tCoC, vUv + offs).rgb;

    float dist = r * radius;
    float w;
    if (uNearField > 0.5) {
      // Near field: a sample contributes wherever *its* near CoC reaches here.
      float sNear = sc.b * uMaxCoC;
      w = clamp(sNear - dist + 1.0, 0.0, 1.0);
      coverage += w;
    } else {
      float sCoc = max(sc.r, 0.0) * uMaxCoC;
      w = clamp(sCoc - dist + 1.0, 0.0, 1.0);
      // Reject samples in front of the shading point: a sharp subject must not
      // smear into the defocused background behind it.
      w *= step(centerDepth - 1.0, sc.g * uFar);
    }
    // Bokeh weighting: brighter samples dominate, which is what produces the
    // characteristic bright discs instead of a uniform mush.
    float bokeh = 1.0 / (1.0 + max(max(s.r, s.g), s.b) * 0.22);
    sum += s * (w * bokeh);
    wsum += w * bokeh;
  }

  vec3 result = wsum > 1e-4 ? sum / wsum : center;
  float alpha = uNearField > 0.5 ? clamp(coverage / float(SF_DOF_SAMPLES) * 2.4, 0.0, 1.0) : 1.0;
  gl_FragColor = vec4(result, alpha);
}
`;

const compositeFrag = /* glsl */ `
${GLSL_EFFECT_DEPTH}
uniform sampler2D cocBuffer;
uniform sampler2D farBuffer;
uniform sampler2D nearBuffer;
uniform float dofBlend;
uniform float dofMaxCoC;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 coc = texture2D(cocBuffer, uv).rgb;
  float farCoc = max(coc.r, 0.0) * dofMaxCoC;
  vec4 farColor = texture2D(farBuffer, uv);
  vec4 nearColor = texture2D(nearBuffer, uv);

  // Fade the far field in over the first couple of pixels of CoC so there is no
  // visible ring where "sharp" becomes "blurred".
  float farBlend = smoothstep(0.6, 2.6, farCoc);
  vec3 col = mix(inputColor.rgb, farColor.rgb, farBlend);
  col = mix(col, nearColor.rgb, clamp(nearColor.a, 0.0, 1.0));

  outputColor = vec4(mix(inputColor.rgb, col, dofBlend), inputColor.a);
}
`;

export interface DofOptions {
  samples?: number;
  /** Maximum circle of confusion in pixels. Caps the cost. */
  maxCoC?: number;
  /** Sensor height in metres. 0.024 = full frame. */
  sensorHeight?: number;
  resolutionScale?: number;
}

export class DepthOfFieldEffect extends Effect {
  private cocTarget: THREE.WebGLRenderTarget;
  private dilateTarget: THREE.WebGLRenderTarget;
  private farTarget: THREE.WebGLRenderTarget;
  private nearTarget: THREE.WebGLRenderTarget;
  private focusA: THREE.WebGLRenderTarget;
  private focusB: THREE.WebGLRenderTarget;

  private focusMaterial: THREE.ShaderMaterial;
  private cocMaterial: THREE.ShaderMaterial;
  private dilateMaterial: THREE.ShaderMaterial;
  private gatherMaterial: THREE.ShaderMaterial;

  private scale: number;

  constructor(options: DofOptions = {}) {
    const maxCoC = options.maxCoC ?? 26;
    const uniforms = new Map<string, THREE.Uniform>([
      ["cocBuffer", new THREE.Uniform(null)],
      ["farBuffer", new THREE.Uniform(null)],
      ["nearBuffer", new THREE.Uniform(null)],
      ["dofBlend", new THREE.Uniform(1)],
      ["dofMaxCoC", new THREE.Uniform(maxCoC)],
      ["logFC", envUniforms.logDepthFC],
      ["camNear", envUniforms.near],
      ["camFar", envUniforms.far],
      ["invProjection", envUniforms.inverseProjection],
      ["camWorld", envUniforms.cameraMatrixWorld],
    ]);

    super("SfDepthOfField", compositeFrag, {
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.NORMAL,
      uniforms,
    });

    this.scale = options.resolutionScale ?? 0.5;

    this.cocTarget = makeHdrTarget(1, 1, "SfDofCoC");
    this.dilateTarget = makeHdrTarget(1, 1, "SfDofCoCDilated");
    this.farTarget = makeHdrTarget(1, 1, "SfDofFar");
    this.nearTarget = makeHdrTarget(1, 1, "SfDofNear");
    this.focusA = makeHdrTarget(1, 1, "SfDofFocusA");
    this.focusB = makeHdrTarget(1, 1, "SfDofFocusB");
    this.focusA.texture.minFilter = THREE.NearestFilter;
    this.focusA.texture.magFilter = THREE.NearestFilter;
    this.focusB.texture.minFilter = THREE.NearestFilter;
    this.focusB.texture.magFilter = THREE.NearestFilter;

    const depthUniforms = {
      tDepth: { value: null as THREE.Texture | null },
      uNear: envUniforms.near,
      uFar: envUniforms.far,
      uLogFC: envUniforms.logDepthFC,
      uInverseProjection: envUniforms.inverseProjection,
      uCameraMatrixWorld: envUniforms.cameraMatrixWorld,
    };

    this.focusMaterial = new THREE.ShaderMaterial({
      name: "SfDofFocus",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: focusFrag,
      uniforms: {
        ...depthUniforms,
        tPrevFocus: { value: null as THREE.Texture | null },
        uManualFocus: { value: 12 },
        uAuto: { value: 1 },
        uRate: { value: 0.12 },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.cocMaterial = new THREE.ShaderMaterial({
      name: "SfDofCoC",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: cocFrag,
      uniforms: {
        ...depthUniforms,
        tFocus: { value: null as THREE.Texture | null },
        uAperture: { value: 4 },
        uFocalLength: { value: 0.035 },
        uSensorHeight: { value: options.sensorHeight ?? 0.024 },
        uViewportHeight: { value: 1080 },
        uMaxCoC: { value: maxCoC },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.dilateMaterial = new THREE.ShaderMaterial({
      name: "SfDofDilate",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: dilateFrag,
      uniforms: {
        tCoC: { value: null as THREE.Texture | null },
        uTexel: { value: new THREE.Vector2() },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.gatherMaterial = new THREE.ShaderMaterial({
      name: "SfDofGather",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: gatherFrag,
      defines: { SF_DOF_SAMPLES: (options.samples ?? 32).toFixed(0) },
      uniforms: {
        tColor: { value: null as THREE.Texture | null },
        tCoC: { value: null as THREE.Texture | null },
        uTexel: envUniforms.texelSize,
        uMaxCoC: { value: maxCoC },
        uFar: envUniforms.far,
        uFrameIndex: envUniforms.frameIndex,
        uNearField: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
  }

  setDepthTexture(texture: THREE.Texture): void {
    this.focusMaterial.uniforms.tDepth.value = texture;
    this.cocMaterial.uniforms.tDepth.value = texture;
  }

  /**
   * Configure the virtual lens.
   * @param focus metres
   * @param aperture f-number
   * @param focalLength millimetres
   * @param blend 0..1 master mix
   * @param auto whether the focus distance is measured from the centre tap
   * @param dt frame delta, for the focus pull rate
   */
  setLens(
    focus: number,
    aperture: number,
    focalLength: number,
    blend: number,
    auto: boolean,
    dt: number,
  ): void {
    this.focusMaterial.uniforms.uManualFocus.value = focus;
    this.focusMaterial.uniforms.uAuto.value = auto ? 1 : 0;
    // A ~0.35 s focus pull. Instant refocus reads as a bug; anything slower
    // reads as a broken autofocus motor.
    this.focusMaterial.uniforms.uRate.value = 1 - Math.exp(-3.2 * Math.max(dt, 1e-4));
    this.cocMaterial.uniforms.uAperture.value = aperture;
    this.cocMaterial.uniforms.uFocalLength.value = focalLength * 0.001;
    this.uniforms.get("dofBlend")!.value = blend;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width * this.scale));
    const h = Math.max(1, Math.round(height * this.scale));
    this.cocTarget.setSize(w, h);
    this.dilateTarget.setSize(w, h);
    this.farTarget.setSize(w, h);
    this.nearTarget.setSize(w, h);
    (this.dilateMaterial.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    this.cocMaterial.uniforms.uViewportHeight.value = height;
  }

  update(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget): void {
    // 1x1 autofocus with history.
    this.focusMaterial.uniforms.tPrevFocus.value = this.focusA.texture;
    blit(renderer, this.focusMaterial, this.focusB);
    const tmp = this.focusA;
    this.focusA = this.focusB;
    this.focusB = tmp;

    this.cocMaterial.uniforms.tFocus.value = this.focusA.texture;
    blit(renderer, this.cocMaterial, this.cocTarget);

    this.dilateMaterial.uniforms.tCoC.value = this.cocTarget.texture;
    blit(renderer, this.dilateMaterial, this.dilateTarget);

    this.gatherMaterial.uniforms.tColor.value = inputBuffer.texture;
    this.gatherMaterial.uniforms.tCoC.value = this.dilateTarget.texture;

    this.gatherMaterial.uniforms.uNearField.value = 0;
    blit(renderer, this.gatherMaterial, this.farTarget);

    this.gatherMaterial.uniforms.uNearField.value = 1;
    blit(renderer, this.gatherMaterial, this.nearTarget);

    this.uniforms.get("cocBuffer")!.value = this.dilateTarget.texture;
    this.uniforms.get("farBuffer")!.value = this.farTarget.texture;
    this.uniforms.get("nearBuffer")!.value = this.nearTarget.texture;
  }

  dispose(): void {
    this.cocTarget.dispose();
    this.dilateTarget.dispose();
    this.farTarget.dispose();
    this.nearTarget.dispose();
    this.focusA.dispose();
    this.focusB.dispose();
    this.focusMaterial.dispose();
    this.cocMaterial.dispose();
    this.dilateMaterial.dispose();
    this.gatherMaterial.dispose();
    super.dispose();
  }
}
