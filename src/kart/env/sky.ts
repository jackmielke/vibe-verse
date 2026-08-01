/**
 * The sky dome.
 *
 * An inverted sphere riding on the camera, shaded by the shared atmosphere
 * kernel. Three details make it behave rather than merely exist:
 *
 * 1. `gl_Position.z = gl_Position.w` pins every fragment to the far plane, so
 *    the dome can be any radius at all without ever being clipped and without
 *    ever occluding geometry — the camera's far plane can then be tuned for
 *    the *track* rather than for the sky.
 * 2. It draws **last** among opaque objects, with the depth test on and depth
 *    writes off. Sitting at exactly the far plane it passes `LEQUAL` only
 *    where the depth buffer is still at its cleared value, i.e. only where the
 *    sky is genuinely visible. Drawing it first instead costs a full-screen
 *    evaluation of the scattering integral every frame, half of which is then
 *    painted over — measured at 35 ms a frame on the software rasteriser, and
 *    it is the single largest saving in this module.
 * 3. A hashed dither is added at the very end. A sky is the one thing in a game
 *    that is a pure low-frequency gradient across two thousand pixels, and an
 *    8-bit framebuffer will band it into stripes every single time. One
 *    sub-LSB of noise costs nothing and removes all of it.
 */
import * as THREE from "three";
import type { KartQuality } from "../types";
import { ATMOSPHERE_GLSL, makeAtmosphereUniforms } from "./atmosphere";

const SKY_VERT = /* glsl */ `
varying vec3 vDir;

void main() {
  // The dome is centred on the camera, so the local vertex position *is* the
  // view direction. No normalisation here — the fragment does it per-pixel,
  // which is what keeps the horizon straight on a coarse dome.
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w;
}
`;

// NOTE: three's fragment prefix already injects <tonemapping_pars_fragment>,
// <colorspace_pars_fragment> and `linearToOutputTexel` for every
// non-raw ShaderMaterial. Including those chunks again — or pulling in
// <common> — redefines their constants and fails to compile. Only the two
// *statement* chunks belong in the body.
const SKY_FRAG = /* glsl */ `
precision highp float;

${ATMOSPHERE_GLSL}

varying vec3 vDir;

void main() {
  vec3 col = atmosphere(normalize(vDir));

  // Sub-LSB hashed dither. Sold at the price of one sin().
  float d = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (d - 0.5) * 0.0035;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface SkyDome {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  uniforms: Record<string, THREE.IUniform>;
  /** A second mesh sharing geometry+material, for the IBL bake scene. */
  makeProxy(): THREE.Mesh;
  dispose(): void;
}

const SEGMENTS: Record<KartQuality, [number, number]> = {
  low: [24, 14],
  medium: [32, 18],
  high: [48, 26],
  ultra: [64, 32],
};

export function createSkyDome(quality: KartQuality): SkyDome {
  const [wSeg, hSeg] = SEGMENTS[quality];
  // Radius is arbitrary — the far-plane pin makes it so — but a unit-ish dome
  // keeps the interpolated direction well conditioned.
  const geometry = new THREE.SphereGeometry(1, wSeg, hSeg);
  const uniforms = makeAtmosphereUniforms();

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    fog: false,
    // Tone-mapped like every other surface in the scene. A sky that opts out
    // of the grade is a sky that stops matching the world in front of it the
    // moment anyone touches exposure.
    toneMapped: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "kart-sky";
  mesh.frustumCulled = false;
  // Last of the opaque pass — see the note at the top of the file.
  mesh.renderOrder = 900;
  mesh.matrixAutoUpdate = false;
  // The dome is re-centred on the camera once per frame, and that update lands
  // one system-order step behind whoever moved the camera. On a unit dome a
  // half-metre of lag is a half-radius of direction error and the whole sky
  // swims; at three kilometres it is 0.02% and invisible. Cheaper than caring
  // about boot order.
  mesh.scale.setScalar(3000);
  mesh.updateMatrix();

  return {
    mesh,
    material,
    uniforms,
    makeProxy() {
      const proxy = new THREE.Mesh(geometry, material);
      proxy.frustumCulled = false;
      return proxy;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
