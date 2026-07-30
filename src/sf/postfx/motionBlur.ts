/**
 * Camera + per-object motion blur, reconstructed from the velocity buffer.
 *
 * Implements the McGuire/Guertin tile-based reconstruction filter, which is
 * still the right answer for a game: a naive "sample along this pixel's own
 * velocity" blur cannot smear a fast object *outside* its own silhouette, so a
 * car doing 40 m/s past the camera stays crisply outlined inside a soft
 * interior — the exact opposite of what a shutter does.
 *
 * The fix is the tile pass. Velocity is reduced to the maximum over each 20×20
 * tile, then to the maximum over each tile's 3×3 neighbourhood; every pixel
 * then gathers along *that* dominant direction and weights each tap by whether
 * the sample could plausibly have moved onto it (depth ordering + a cone
 * falloff). Background pixels next to a fast object therefore pick up its
 * colour, which is what makes the blur read as motion rather than as blur.
 */
import * as THREE from "three";
import { Effect, EffectAttribute, BlendFunction } from "postprocessing";
import { envUniforms } from "./env";
import { FULLSCREEN_VERT, GLSL_EFFECT_DEPTH, GLSL_NOISE } from "./glsl";
import { blit, makeHdrTarget } from "./fullscreen";

/** Separable tile reduction — 2×K taps instead of K². */
const tileMaxFrag = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uStep;
varying vec2 vUv;

void main() {
  vec2 best = vec2(0.0);
  float bestLen = -1.0;
  for (int i = 0; i < SF_TILE_SIZE; i++) {
    vec2 v = texture2D(tInput, vUv + uStep * (float(i) + 0.5)).xy;
    float l = dot(v, v);
    if (l > bestLen) { bestLen = l; best = v; }
  }
  gl_FragColor = vec4(best, 0.0, 1.0);
}
`;

const neighbourMaxFrag = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uTexel;
varying vec2 vUv;

void main() {
  vec2 best = vec2(0.0);
  float bestLen = -1.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 v = texture2D(tInput, vUv + vec2(float(x), float(y)) * uTexel).xy;
      float l = dot(v, v);
      if (l > bestLen) { bestLen = l; best = v; }
    }
  }
  gl_FragColor = vec4(best, 0.0, 1.0);
}
`;

const compositeFrag = /* glsl */ `
${GLSL_EFFECT_DEPTH}
${GLSL_NOISE}
uniform sampler2D velocityBuffer;
uniform sampler2D neighbourMax;
uniform vec2 mbTexel;
uniform float mbScale;
uniform float mbFrame;
uniform float mbMaxPixels;

float mbCone(const in float dist, const in float speed) {
  return clamp(1.0 - dist / max(speed, 1e-4), 0.0, 1.0);
}

float mbCylinder(const in float dist, const in float speed) {
  return 1.0 - smoothstep(0.95 * speed, 1.05 * speed, dist);
}

/** 1 when a is in front of b by more than the soft-z band. */
float mbSoftDepth(const in float a, const in float b) {
  return clamp(1.0 - (a - b) / 1.5, 0.0, 1.0);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 vN = texture2D(neighbourMax, uv).xy * mbScale;
  float speedPx = length(vN / mbTexel);
  if (speedPx < 1.5) {
    outputColor = inputColor;
    return;
  }
  // Bound the smear: a teleport or a one-frame hitch must not turn the screen
  // into a streak the width of the display.
  if (speedPx > mbMaxPixels) {
    vN *= mbMaxPixels / speedPx;
    speedPx = mbMaxPixels;
  }

  vec2 vC = texture2D(velocityBuffer, uv).xy * mbScale;
  float speedC = max(length(vC / mbTexel), 0.5);
  float depthC = sfDepthMetres(uv);

  float jitter = sfIGNT(gl_FragCoord.xy, mbFrame) - 0.5;

  // The centre tap gets weight from its own velocity cone, which is what keeps
  // a stationary pixel sharp even when a fast neighbour dominates the tile.
  float wsum = 1.0 / speedC;
  vec3 sum = inputColor.rgb * wsum;

  for (int i = 0; i < SF_MB_SAMPLES; i++) {
    float t = (float(i) + 0.5 + jitter) / float(SF_MB_SAMPLES) * 2.0 - 1.0;
    vec2 offs = vN * t * 0.5;
    vec2 suv = uv + offs;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;

    float distPx = abs(t) * 0.5 * speedPx;
    float depthS = sfDepthMetres(suv);
    vec2 vS = texture2D(velocityBuffer, suv).xy * mbScale;
    float speedS = max(length(vS / mbTexel), 0.5);

    // Foreground sample blurring over us, background we are blurring over, and
    // the "both moving together" case.
    float f = mbSoftDepth(depthC, depthS);
    float b = mbSoftDepth(depthS, depthC);
    float w = f * mbCone(distPx, speedS)
            + b * mbCone(distPx, speedC)
            + 2.0 * mbCylinder(distPx, min(speedC, speedS));

    sum += texture2D(inputBuffer, suv).rgb * w;
    wsum += w;
  }

  outputColor = vec4(sum / max(wsum, 1e-4), inputColor.a);
}
`;

export interface MotionBlurOptions {
  samples?: number;
  /** Tile size in pixels for the velocity reduction. */
  tileSize?: number;
  /** Shutter scale — 1.0 is a 180° shutter at the current frame rate. */
  intensity?: number;
  /** Hard cap on the smear length in pixels. */
  maxPixels?: number;
}

export class MotionBlurEffect extends Effect {
  private tileX: THREE.WebGLRenderTarget;
  private tileXY: THREE.WebGLRenderTarget;
  private neighbour: THREE.WebGLRenderTarget;

  private tileMaterial: THREE.ShaderMaterial;
  private neighbourMaterial: THREE.ShaderMaterial;

  private tileSize: number;

  constructor(velocityTexture: THREE.Texture | null, options: MotionBlurOptions = {}) {
    const uniforms = new Map<string, THREE.Uniform>([
      ["velocityBuffer", new THREE.Uniform(velocityTexture)],
      ["neighbourMax", new THREE.Uniform(null)],
      ["mbTexel", envUniforms.texelSize],
      ["mbScale", new THREE.Uniform(options.intensity ?? 1)],
      ["mbFrame", envUniforms.frameIndex],
      ["mbMaxPixels", new THREE.Uniform(options.maxPixels ?? 90)],
      ["logFC", envUniforms.logDepthFC],
      ["camNear", envUniforms.near],
      ["camFar", envUniforms.far],
      ["invProjection", envUniforms.inverseProjection],
      ["camWorld", envUniforms.cameraMatrixWorld],
    ]);

    super("SfMotionBlur", compositeFrag, {
      attributes: EffectAttribute.CONVOLUTION | EffectAttribute.DEPTH,
      blendFunction: BlendFunction.NORMAL,
      uniforms,
      defines: new Map<string, string>([["SF_MB_SAMPLES", (options.samples ?? 12).toFixed(0)]]),
    });

    this.tileSize = options.tileSize ?? 20;

    this.tileX = makeHdrTarget(1, 1, "SfMbTileX");
    this.tileXY = makeHdrTarget(1, 1, "SfMbTileXY");
    this.neighbour = makeHdrTarget(1, 1, "SfMbNeighbour");
    for (const rt of [this.tileX, this.tileXY, this.neighbour]) {
      rt.texture.minFilter = THREE.NearestFilter;
      rt.texture.magFilter = THREE.NearestFilter;
    }

    this.tileMaterial = new THREE.ShaderMaterial({
      name: "SfMbTileMax",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: tileMaxFrag,
      defines: { SF_TILE_SIZE: this.tileSize.toFixed(0) },
      uniforms: {
        tInput: { value: velocityTexture },
        uStep: { value: new THREE.Vector2() },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.neighbourMaterial = new THREE.ShaderMaterial({
      name: "SfMbNeighbourMax",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: neighbourMaxFrag,
      uniforms: {
        tInput: { value: null as THREE.Texture | null },
        uTexel: { value: new THREE.Vector2() },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
  }

  setVelocityTexture(texture: THREE.Texture): void {
    this.uniforms.get("velocityBuffer")!.value = texture;
    this.tileMaterial.uniforms.tInput.value = texture;
  }

  set intensity(v: number) {
    this.uniforms.get("mbScale")!.value = v;
  }

  setSize(width: number, height: number): void {
    const tw = Math.max(1, Math.ceil(width / this.tileSize));
    const th = Math.max(1, Math.ceil(height / this.tileSize));
    this.tileX.setSize(tw, height);
    this.tileXY.setSize(tw, th);
    this.neighbour.setSize(tw, th);
    (this.neighbourMaterial.uniforms.uTexel.value as THREE.Vector2).set(1 / tw, 1 / th);
    this.fullWidth = width;
    this.fullHeight = height;
  }

  private fullWidth = 1;
  private fullHeight = 1;

  update(renderer: THREE.WebGLRenderer): void {
    const step = this.tileMaterial.uniforms.uStep.value as THREE.Vector2;

    // Horizontal reduction: sample the full-res velocity buffer.
    this.tileMaterial.uniforms.tInput.value = this.uniforms.get("velocityBuffer")!.value;
    step.set(1 / this.fullWidth, 0);
    blit(renderer, this.tileMaterial, this.tileX);

    // Vertical reduction over the intermediate.
    this.tileMaterial.uniforms.tInput.value = this.tileX.texture;
    step.set(0, 1 / this.fullHeight);
    blit(renderer, this.tileMaterial, this.tileXY);

    this.neighbourMaterial.uniforms.tInput.value = this.tileXY.texture;
    blit(renderer, this.neighbourMaterial, this.neighbour);

    this.uniforms.get("neighbourMax")!.value = this.neighbour.texture;
  }

  dispose(): void {
    this.tileX.dispose();
    this.tileXY.dispose();
    this.neighbour.dispose();
    this.tileMaterial.dispose();
    this.neighbourMaterial.dispose();
    super.dispose();
  }
}
