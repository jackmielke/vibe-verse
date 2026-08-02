/**
 * The one lit material every solid object in this world uses.
 *
 * Three's own `MeshStandardMaterial` would work, and was the first thing here.
 * It was replaced for one reason: the renderer's tone mapping is switched off,
 * because every *other* material in this world is a raw `ShaderMaterial` that
 * Three would never splice its ACES chunk into. Leaving Three's materials to
 * light the aeroplane and the flight deck therefore meant two different
 * transfer curves in one frame — the world outside the windshield rolling its
 * highlights off through ACES, the panel two feet from your face clipping them
 * flat. During a lightning flash the difference was not subtle; the cockpit
 * went to paper white while the cloud outside stayed cloud.
 *
 * So everything goes through `outputColor()`, and this is the material that
 * does it for anything with a normal.
 *
 * The lighting model is four terms and no more, because at night on the inside
 * of a storm there are only four sources of light in the world:
 *
 *   1. the moon, above the overcast and gone below it,
 *   2. the city, an orange bounce from underneath,
 *   3. the lightning, from `uFlashDir`, and
 *   4. whatever lamps the object carries itself.
 */
import * as THREE from "three";
import {
  AERIAL_GLSL,
  ENV_UNIFORMS_GLSL,
  NOISE_GLSL,
  OUTPUT_GLSL,
  declareUniforms,
  withEnv,
  type EnvUniforms,
} from "./env";

export const SURFACE_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
#ifdef USE_INSTANCING
#endif
void main() {
  #ifdef USE_INSTANCING
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  #else
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normal);
  #endif
  vWorld = world.xyz;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const SURFACE_LIGHTING_GLSL = /* glsl */ `
/**
 * Shade a surface. albedo is a colour, rough 0..1, metal 0..1.
 *
 * Returns scene-linear radiance. The caller adds its own emission and then
 * calls outputColor — never the other way round, or the emission is
 * tone-mapped twice and every lit window in the world turns grey.
 */
vec3 shadeSurface(vec3 albedo, vec3 n, vec3 worldPos, float rough, float metal) {
  vec3 v = normalize(cameraPosition - worldPos);

  // How far above the overcast we are — the moon only reaches the top of it.
  float aboveDeck = smoothstep(uCloudTops - 400.0, uCloudTops + 200.0, worldPos.y);

  // 1. Moonlight, hard and blue and only up top.
  float ndl = max(dot(n, uMoonDir), 0.0);
  vec3 light = uMoonColor * ndl * 0.22 * aboveDeck;
  vec3 h = normalize(uMoonDir + v);
  float spec = pow(max(dot(n, h), 0.0), mix(8.0, 180.0, 1.0 - rough));
  light += uMoonColor * spec * (0.05 + 0.5 * (1.0 - rough)) * aboveDeck;

  // 2. The city, bouncing up off three million street lamps. Below the deck
  //    this is essentially the only ambient there is, and it comes from below,
  //    which is why an aeroplane over a city at night is lit from underneath.
  float fromBelow = max(-n.y, 0.0) * 0.75 + 0.25;
  float cityStrength = (1.0 - aboveDeck) * 0.55 + 0.08;
  light += uCityGlow * fromBelow * cityStrength * 0.42;

  // 3. Ambient from the cloud itself, which is a very large grey softbox and
  //    the only thing keeping the top of the aeroplane from being pure black
  //    in the chase view. A 707 at night really is mostly dark — what you see
  //    of one is its lights — but "mostly dark" and "not drawn" have to be
  //    distinguishable, and at 0.35 they were not.
  light += uCloudColor * (1.1 + 0.9 * (n.y * 0.5 + 0.5)) + uMoonColor * 0.012;

  // 4. Lightning. Directional, so it models the aeroplane instead of just
  //    raising its brightness — which is the entire difference between a
  //    flash that reads as weather and one that reads as a screen effect.
  float fl = max(dot(n, uFlashDir), 0.0) * 0.75 + 0.25;
  vec3 fh = normalize(uFlashDir + v);
  float fspec = pow(max(dot(n, fh), 0.0), mix(10.0, 220.0, 1.0 - rough));
  light += vec3(1.0, 0.98, 0.95) * uFlash * (fl * 1.1 + fspec * 1.4);

  // Wet: rain on a fuselage raises the specular and lowers the diffuse, which
  // is most of why a rained-on aeroplane looks the way it does.
  float wetness = uRain * 0.6;
  vec3 base = mix(albedo, albedo * 0.72, wetness);
  vec3 diffuse = base * light;
  vec3 specTint = mix(vec3(1.0), albedo, metal);
  return mix(diffuse, diffuse * 0.25 + light * specTint, metal * 0.85);
}
`;

export interface SurfaceOptions {
  /** Extra uniforms this material wants. */
  uniforms?: Record<string, THREE.IUniform>;
  /** GLSL pasted before `main`, for helpers. */
  prelude?: string;
  /**
   * The body of the fragment shader. Has `vWorld`, `vNormal`, `vUv` in scope,
   * plus everything in the env block, and must set `albedo`, `rough`, `metal`
   * and optionally `emission`.
   */
  body: string;
  side?: THREE.Side;
  transparent?: boolean;
  depthWrite?: boolean;
  /** Skip aerial perspective — for anything inside the cockpit. */
  interior?: boolean;
}

export function createSurfaceMaterial(
  env: EnvUniforms,
  opts: SurfaceOptions,
): THREE.ShaderMaterial {
  const frag = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
${ENV_UNIFORMS_GLSL}
${declareUniforms(opts.uniforms, env as unknown as Record<string, unknown>)}
${OUTPUT_GLSL}
${NOISE_GLSL}
${opts.interior ? "" : AERIAL_GLSL}
${SURFACE_LIGHTING_GLSL}
${opts.prelude ?? ""}

void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 albedo = vec3(0.5);
  float rough = 0.6;
  float metal = 0.0;
  vec3 emission = vec3(0.0);
  float alpha = 1.0;

  ${opts.body}

  vec3 col = shadeSurface(albedo, n, vWorld, rough, metal) + emission;
  ${opts.interior ? "" : "col = applyAerial(col, length(vWorld - cameraPosition), vWorld.y);"}
  gl_FragColor = vec4(outputColor(max(col, vec3(0.0))), alpha);
}
`;

  return new THREE.ShaderMaterial({
    vertexShader: SURFACE_VERT,
    fragmentShader: frag,
    uniforms: withEnv(env, opts.uniforms),
    side: opts.side ?? THREE.FrontSide,
    transparent: opts.transparent ?? false,
    depthWrite: opts.depthWrite ?? true,
  });
}
