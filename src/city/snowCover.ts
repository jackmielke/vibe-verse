/**
 * Snow that settles, as a property of every surface rather than as geometry.
 *
 * The obvious way to accumulate snow is to build it: a second skin of white
 * meshes over the roads, the pavements and every roof, faded in as it falls.
 * That is a lot of triangles for a thing the player looks at from six hundred
 * metres, it doubles the draw calls for the whole district, and it has to be
 * re-authored every time somebody adds a world.
 *
 * This does it in the shading instead. One uniform — how deep the fall is, 0
 * to 1 — patched into the materials that already exist, blending their albedo
 * toward snow on surfaces that face up. It costs one varying, a little noise
 * and nothing per frame, it lands on the streets, the sidewalks, the parks,
 * the roofs and the beach at the same moment, and a world added next month
 * gets it by passing its materials through `patch`.
 *
 * Two details are what stop it looking like a white wash:
 *
 *  - **It only settles on what faces the sky.** Walls, kerbs and the undersides
 *    of things stay their own colour, which is what gives a snowy city its
 *    stripes.
 *  - **It comes in patches, not as a fade.** Coverage drives a threshold
 *    against world-space noise, so a light fall is drifts in the gutters and a
 *    heavy one joins them up. Cross-fading every surface to white in lockstep
 *    reads as a colour grade, not as weather.
 */
import * as THREE from "three";

export interface SnowCover {
  /** 0 = bare, 1 = everything that faces up is white. Shared by every patched material. */
  readonly uniform: { value: number };
  /** Make a material accumulate snow. Idempotent, and safe on shared materials. */
  patch(material: THREE.Material | THREE.Material[] | null | undefined): void;
  /** Drive it: lays down while `snowing`, melts off when not. */
  update(dt: number, snowing: boolean): void;
  /** Current coverage, for anything that wants to react to it. */
  depth(): number;
}

/** Seconds from bare ground to full cover, and back. Melting is the slower half. */
const LAY_TIME = 26;
const MELT_TIME = 38;

const SNOW_PARS = /* glsl */ `
  uniform float uSnowCover;
  varying vec3 vSnowWorld;
  varying float vSnowUp;
`;

const SNOW_NOISE = /* glsl */ `
  float snowHash(vec2 p){
    p = fract(p * vec2(127.31, 311.7));
    p += dot(p, p + 34.19);
    return fract(p.x * p.y);
  }
  float snowNoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(snowHash(i), snowHash(i + vec2(1.0, 0.0)), u.x),
      mix(snowHash(i + vec2(0.0, 1.0)), snowHash(i + vec2(1.0, 1.0)), u.x),
      u.y);
  }
`;

export function createSnowCover(): SnowCover {
  const uniform = { value: 0 };
  // Materials are shared across hundreds of meshes and `onBeforeCompile` fires
  // per material, but patching twice would chain the injections and the second
  // one would not find its anchor. Cheap to guard, impossible to debug if not.
  const patched = new WeakSet<THREE.Material>();

  const patchOne = (mat: THREE.Material) => {
    if (patched.has(mat)) return;
    patched.add(mat);
    const prev = mat.onBeforeCompile?.bind(mat);
    mat.onBeforeCompile = (shader, renderer) => {
      prev?.(shader, renderer);
      shader.uniforms.uSnowCover = uniform;
      shader.vertexShader = shader.vertexShader
        .replace("void main() {", `${SNOW_PARS}\nvoid main() {`)
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          // Instanced meshes carry their placement in instanceMatrix, not in
          // modelMatrix — the street trees and the traffic are one draw call
          // each. Without this every tree in the district samples the drift
          // noise at the same point and gets identical snow.
          mat4 snowModel = modelMatrix;
          #ifdef USE_INSTANCING
            snowModel = modelMatrix * instanceMatrix;
          #endif
          vSnowWorld = (snowModel * vec4(transformed, 1.0)).xyz;
          // objectNormal is in scope by here — <beginnormal_vertex> runs well
          // before <begin_vertex> in every material three ships.
          vSnowUp = normalize(mat3(snowModel) * objectNormal).y;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("void main() {", `${SNOW_PARS}\n${SNOW_NOISE}\nvoid main() {`)
        // Hooked AFTER <color_fragment>, not after <map_fragment>. Vertex
        // colours are multiplied into the albedo between the two, so snow laid
        // down at the earlier hook gets tinted right back to whatever the mesh
        // was — which is how a beach under six inches of snow came out sand
        // yellow while the streets beside it went white.
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          // 0.35 is about a seventy-degree slope. Tighter than that and the
          // street trees — low-poly icosahedra whose top face is small — take
          // a white speck instead of a cap, and a district under a foot of
          // snow keeps a green canopy.
          float snowUp = smoothstep(0.35, 0.85, vSnowUp);
          // Two scales: drifts a few metres across, and a fine grain that
          // keeps the edge of a drift from looking cut out with scissors.
          float snowN =
            snowNoise(vSnowWorld.xz * 0.16) * 0.68 + snowNoise(vSnowWorld.xz * 0.9) * 0.32;
          // Coverage pushes the threshold past the noise. At 0 nothing clears
          // it; by 1 everything does, and the middle is patches.
          float snowAmt = smoothstep(0.0, 0.55, uSnowCover * 1.5 - 0.5 + snowN * 0.55) * snowUp;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.93, 0.98), snowAmt);`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
          // Fresh snow is matte. Leaving the asphalt's specular under the
          // white is what makes shader snow read as paint.
          roughnessFactor = mix(roughnessFactor, 0.86, snowAmt);`,
        );
    };
    mat.needsUpdate = true;
  };

  return {
    uniform,
    patch(material) {
      if (!material) return;
      if (Array.isArray(material)) material.forEach(patchOne);
      else patchOne(material);
    },
    update(dt, snowing) {
      const rate = snowing ? dt / LAY_TIME : -dt / MELT_TIME;
      uniform.value = Math.max(0, Math.min(1, uniform.value + rate));
    },
    depth: () => uniform.value,
  };
}
