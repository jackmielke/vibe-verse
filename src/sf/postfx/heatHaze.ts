/**
 * Heat haze over fires, explosions and exhausts.
 *
 * Hot air has a lower refractive index than cold air, so the image behind it
 * shears — it does not glow, it does not tint, it *moves*. Which is why the
 * only correct way to do this is a per-pixel UV distortion applied before the
 * scene is sampled, driven by a noise field that rises and dissipates.
 *
 * Emitters are registered per frame in world space (`postFx.addHeatSource`),
 * projected here, and depth-tested against the scene so a fire behind a wall
 * does not warp the wall.
 */
import * as THREE from "three";
import { Effect, EffectAttribute, BlendFunction } from "postprocessing";
import { envUniforms } from "./env";
import { GLSL_EFFECT_DEPTH, GLSL_NOISE } from "./glsl";
import { MAX_HEAT_SOURCES, postfx } from "./state";

const compositeFrag = /* glsl */ `
${GLSL_EFFECT_DEPTH}
${GLSL_NOISE}

uniform vec4 heatSources[SF_HEAT_MAX];   // xyz world position, w radius (m)
uniform float heatPower[SF_HEAT_MAX];    // per-source strength
uniform float heatActive;                // number of live sources
uniform mat4 heatViewProj;
uniform float heatTime;
uniform float heatAspect;
uniform float heatAmount;
uniform vec2 heatTexel;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (heatActive < 0.5) {
    outputColor = inputColor;
    return;
  }

  float pixelDepth = sfDepthMetres(uv);
  vec2 offset = vec2(0.0);
  float total = 0.0;

  for (int i = 0; i < SF_HEAT_MAX; i++) {
    if (float(i) >= heatActive) break;
    vec4 src = heatSources[i];
    float strength = heatPower[i];
    if (strength <= 0.001) continue;

    vec4 clip = heatViewProj * vec4(src.xyz, 1.0);
    if (clip.w <= 0.0) continue;
    vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;
    float sourceDist = clip.w;

    // Anything closer to the camera than the emitter occludes it.
    if (pixelDepth < sourceDist - src.w) continue;

    // Screen radius from the world radius. Using clip.w (view distance) rather
    // than a fixed size keeps a burning car the right size from every range.
    float radius = src.w / max(sourceDist, 0.5) * 0.9;
    vec2 d = (uv - suv) * vec2(heatAspect, 1.0);
    float r = length(d) / max(radius, 1e-4);
    if (r > 1.0) continue;

    float falloff = 1.0 - r * r;
    // Convection: the column is taller than it is wide, and the noise scrolls
    // upward and dissipates with height.
    float rise = heatTime * 1.35;
    float n1 = sfValueNoise3(vec3(uv * vec2(heatAspect, 1.0) * 42.0, rise));
    float n2 = sfValueNoise3(vec3(uv * vec2(heatAspect, 1.0) * 97.0 + 13.7, rise * 1.8));
    vec2 warp = vec2(n1 - 0.5, (n2 - 0.5) * 1.9 + 0.18);

    offset += warp * (falloff * falloff * strength);
    total += falloff * strength;
  }

  if (total <= 0.0001) {
    outputColor = inputColor;
    return;
  }

  vec2 warped = uv + offset * heatAmount * heatTexel * 42.0;
  warped = clamp(warped, vec2(0.001), vec2(0.999));

  vec3 col = texture2D(inputBuffer, warped).rgb;
  // A whisper of chromatic separation: the refraction really is dispersive, and
  // it is the difference between "wobble" and "hot".
  col.r = texture2D(inputBuffer, warped + offset * heatAmount * heatTexel * 4.0).r;
  outputColor = vec4(col, inputColor.a);
}
`;

export class HeatHazeEffect extends Effect {
  private sources: THREE.Vector4[];
  private power: Float32Array;

  constructor() {
    const sources: THREE.Vector4[] = [];
    for (let i = 0; i < MAX_HEAT_SOURCES; i++) sources.push(new THREE.Vector4());
    const power = new Float32Array(MAX_HEAT_SOURCES);

    const uniforms = new Map<string, THREE.Uniform>([
      ["heatSources", new THREE.Uniform(sources)],
      ["heatPower", new THREE.Uniform(power)],
      ["heatActive", new THREE.Uniform(0)],
      ["heatViewProj", envUniforms.viewProjection],
      ["heatTime", envUniforms.time],
      ["heatAspect", new THREE.Uniform(1.777)],
      ["heatAmount", new THREE.Uniform(1)],
      ["heatTexel", envUniforms.texelSize],
      ["logFC", envUniforms.logDepthFC],
      ["camNear", envUniforms.near],
      ["camFar", envUniforms.far],
      ["invProjection", envUniforms.inverseProjection],
      ["camWorld", envUniforms.cameraMatrixWorld],
    ]);

    super("SfHeatHaze", compositeFrag, {
      attributes: EffectAttribute.CONVOLUTION | EffectAttribute.DEPTH,
      blendFunction: BlendFunction.NORMAL,
      uniforms,
      defines: new Map<string, string>([["SF_HEAT_MAX", MAX_HEAT_SOURCES.toFixed(0)]]),
    });

    this.sources = sources;
    this.power = power;
  }

  setSize(width: number, height: number): void {
    this.uniforms.get("heatAspect")!.value = width / Math.max(1, height);
  }

  /** Pull this frame's emitters out of the runtime state. */
  update(): void {
    const n = Math.min(postfx.heatCount, MAX_HEAT_SOURCES);
    for (let i = 0; i < n; i++) {
      this.sources[i].set(
        postfx.heatSources[i * 4 + 0],
        postfx.heatSources[i * 4 + 1],
        postfx.heatSources[i * 4 + 2],
        postfx.heatSources[i * 4 + 3],
      );
      this.power[i] = postfx.heatStrength[i];
    }
    for (let i = n; i < MAX_HEAT_SOURCES; i++) this.power[i] = 0;
    this.uniforms.get("heatActive")!.value = n;
  }

  /** True when at least one emitter is live — the pipeline skips the pass otherwise. */
  get active(): boolean {
    return postfx.heatCount > 0;
  }
}
