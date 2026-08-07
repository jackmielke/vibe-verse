/**
 * Water.
 *
 * Three of the eleven landable worlds have oceans in their catalogue entry —
 * Risa is a resort on a bay, Earth's site is the south anchorage of the Golden
 * Gate, Bajor's terraces look down a river valley — and all three rendered as
 * dry ground, which is the kind of gap that is invisible until you notice it
 * and then impossible to stop noticing.
 *
 * ## What makes water read
 *
 * Not the colour. A blue plane is a blue plane. Four things, in order of how
 * much they matter:
 *
 * **Fresnel.** Water is nearly a mirror at a grazing angle and nearly
 * transparent looking straight down. That one term is most of the effect: it
 * is why a lake is bright silver near the far shore and dark green at your
 * feet, and getting it the wrong way round makes the surface look like plastic.
 *
 * **The sun's glint.** A specular lobe tight enough to be a shape rather than
 * a wash, broken up by the wave normal so it scatters into a track rather than
 * a spot. On a low sun that track is the single most recognisable thing on the
 * whole surface.
 *
 * **Two wave scales, moving differently.** One octave in one direction is a
 * conveyor belt. Two, at different sizes and speeds and angles, is water. The
 * normals come from the same baked map everything else in the world uses,
 * scrolled — which means they are mipmapped, so the far water goes calm
 * instead of dissolving into aliased sparkle.
 *
 * **A shoreline.** The transition has to be *depth*-driven, not a hard edge:
 * shallow water is lighter and more transparent, and there is foam where it
 * meets land. That needs to know where the ground is, which is why the terrain
 * height field is baked into a texture here and handed to the shader — the
 * same `heightAt` the mesh, the props and the player's feet all use, so the
 * waterline cannot disagree with the beach.
 */
import * as THREE from "three";
import { surfaceMaps } from "../gfx/surfacing";

export interface SeaSpec {
  /** World Y of the surface. Everything below this is underwater. */
  level: number;
  /** Shallow colour, at the shore. */
  shallow: number;
  /** Deep colour, out where the bottom is gone. */
  deep: number;
  /** Metres of depth over which shallow becomes deep. */
  falloff?: number;
  /** Wave height in metres. Risa's bay is calm; a Bajoran river is not. */
  chop?: number;
}

export interface Water {
  mesh: THREE.Mesh;
  update(dt: number, camera: THREE.Camera): void;
  dispose(): void;
}

const VERT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vView;
void main(){
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 mv = viewMatrix * world;
  vView = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying vec3 vView;

uniform sampler2D tNormal;   // the shared baked normal map, scrolled
uniform sampler2D tHeight;   // the terrain's own height field, R channel
uniform samplerCube tEnv;    // not used when uHasEnv is 0
uniform vec3 uShallow, uDeep, uSunDir, uSunColor, uSkyColor, uHorizonColor;
uniform float uLevel, uFalloff, uChop, uTime, uSpan, uHeightMin, uHeightRange;

vec3 sampleNormal(vec2 uv, float scale, vec2 drift){
  vec3 n = texture2D(tNormal, uv * scale + drift * uTime).xyz * 2.0 - 1.0;
  return n;
}

void main(){
  /* Depth of water at this fragment.
   *
   * The terrain height comes out of a texture baked from the very same
   * heightAt the mesh was displaced with, so the waterline lands exactly on
   * the beach. Deriving it any other way — a second noise, an approximation —
   * puts the foam a metre inland on one side of the bay and a metre out to sea
   * on the other, and that is a thing you can see from the transporter pad. */
  vec2 huv = vWorld.xz / uSpan + 0.5;
  float ground = uHeightMin + texture2D(tHeight, clamp(huv, 0.0, 1.0)).r * uHeightRange;
  float depth = uLevel - ground;
  if (depth <= 0.0) discard;   // dry land: the sea simply is not here

  /* Two wave scales, crossing. One is a conveyor belt; two is water. */
  vec2 uv = vWorld.xz;
  vec3 n1 = sampleNormal(uv, 0.055, vec2(0.011, 0.006));
  vec3 n2 = sampleNormal(uv, 0.17, vec2(-0.017, 0.023));
  vec3 n3 = sampleNormal(uv, 0.44, vec2(0.031, -0.014));
  vec3 nrm = normalize(vec3(
    (n1.x + n2.x * 0.6 + n3.x * 0.3) * uChop,
    1.0,
    (n1.y + n2.y * 0.6 + n3.y * 0.3) * uChop));

  vec3 V = normalize(vView);
  float ndv = max(dot(nrm, V), 0.0);

  /* Fresnel — Schlick, with water's real F0 of 0.02. This is most of the
     effect: a mirror at the horizon, a window at your feet. */
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  // Body colour, by how much water the light had to cross.
  float d = clamp(depth / uFalloff, 0.0, 1.0);
  vec3 body = mix(uShallow, uDeep, d);

  // What the surface reflects. Without a cube probe this is a two-stop sky,
  // which at these angles is very nearly what a real reflection would give.
  vec3 refl = mix(uHorizonColor, uSkyColor, clamp(reflect(-V, nrm).y * 1.4, 0.0, 1.0));

  /* Cap the Fresnel.
   *
   * Physically the reflectance really does go to 1 at grazing, and a bay
   * rendered that way is *exactly* the colour of the sky above it — correct,
   * and completely invisible, which is a failure of art direction rather than
   * of physics. Real water keeps some body colour at every angle because the
   * surface is not a plane; the wave slopes are always presenting a range of
   * incidences. 0.82 is what that averages to. */
  vec3 col = mix(body, refl * 0.78, min(fres, 0.74));

  /* The glint. Exponent 380 is tight enough to be a shape rather than a wash;
     the wave normal is what scatters it into a track instead of a spot, and on
     a low sun that track is the most recognisable thing on the surface. */
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(nrm, H), 0.0), 380.0);
  col += uSunColor * spec * 2.6;
  // A broader sheen under it, so the track has a base rather than floating.
  col += uSunColor * pow(max(dot(nrm, H), 0.0), 22.0) * 0.10;

  /* Foam. A band that follows the depth contour, broken up by two noises at
     different scales and pulsed so the waterline breathes. One noise gives a
     hard white stripe all the way round the bay, which is the one shape a real
     shoreline never has. */
  float band = 1.0 - smoothstep(0.0, 0.55, depth);
  float wash = texture2D(tNormal, uv * 0.07 + vec2(uTime * 0.018, 0.0)).z;
  float fret = texture2D(tNormal, uv * 0.31 - vec2(uTime * 0.04, uTime * 0.01)).x;
  float surge = 0.68 + 0.32 * sin(uTime * 0.55 + uv.x * 0.02);
  float foam = smoothstep(0.34, 0.86, band * surge * (0.45 + wash * 0.7 + fret * 0.5));
  col = mix(col, vec3(0.93, 0.96, 0.97), foam * 0.8);

  // Edge transparency, so the sea meets the sand instead of cutting into it.
  float alpha = clamp(0.35 + d * 0.65 + fres * 0.4 + foam, 0.0, 1.0);
  alpha *= smoothstep(0.0, 0.09, depth);

  gl_FragColor = vec4(col, alpha);
}
`;

export interface WaterOptions {
  sea: SeaSpec;
  /** The one true ground truth. Sampled to bake the height texture. */
  height: (x: number, z: number) => number;
  /** Width of the terrain the height texture covers, in metres. */
  span: number;
  sunDir: THREE.Vector3;
  sunColor: number;
  skyColor: number;
  horizonColor: number;
}

export function createWater(opts: WaterOptions): Water {
  const { sea, height, span } = opts;

  /* Bake the height field into a texture.
   *
   * 256² over 900 m is one texel per 3.5 m, which is coarser than the terrain
   * mesh — and it does not matter, because this is only ever used to ask "how
   * deep" and the answer is smoothed over half a metre anyway. Baking is the
   * point: the shader cannot call the JS height function, and any second
   * implementation of it would drift out of step with the beach. */
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  let lo = Infinity;
  let hi = -Infinity;
  const raw = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1) - 0.5) * span;
      const z = (j / (N - 1) - 0.5) * span;
      const h = height(x, z);
      raw[j * N + i] = h;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  const range = Math.max(1e-4, hi - lo);
  for (let k = 0; k < N * N; k++) {
    const v = Math.round(((raw[k] - lo) / range) * 255);
    data[k * 4] = v;
    data[k * 4 + 1] = v;
    data[k * 4 + 2] = v;
    data[k * 4 + 3] = 255;
  }
  const heightTex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  heightTex.wrapS = THREE.ClampToEdgeWrapping;
  heightTex.wrapT = THREE.ClampToEdgeWrapping;
  heightTex.minFilter = THREE.LinearFilter;
  heightTex.magFilter = THREE.LinearFilter;
  heightTex.needsUpdate = true;

  const normal = surfaceMaps("ice").normal;

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      tNormal: { value: normal },
      tHeight: { value: heightTex },
      tEnv: { value: null },
      uShallow: { value: new THREE.Color(sea.shallow) },
      uDeep: { value: new THREE.Color(sea.deep) },
      uSunDir: { value: opts.sunDir.clone().normalize() },
      uSunColor: { value: new THREE.Color(opts.sunColor) },
      uSkyColor: { value: new THREE.Color(opts.skyColor) },
      uHorizonColor: { value: new THREE.Color(opts.horizonColor) },
      uLevel: { value: sea.level },
      uFalloff: { value: sea.falloff ?? 6 },
      uChop: { value: sea.chop ?? 0.5 },
      uTime: { value: 0 },
      uSpan: { value: span },
      uHeightMin: { value: lo },
      uHeightRange: { value: range },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  /* The plane runs four times past the terrain, and that is not padding.
   *
   * At 900 m the sea simply *stopped* at the edge of the height field, so there
   * was no horizon line — the water ended in mid-air and what was beyond it was
   * sky. Since the height lookup clamps at the texture edge, everything past
   * the terrain samples the last depth on that bearing, which on a shore
   * bearing is deep water. So the bay runs out to the haze and meets the sky
   * where it should.
   *
   * 96 segments because the fragment shader needs interpolated world positions
   * and the Fresnel is very sensitive to the view vector; a coarse plane makes
   * the reflection band step. */
  const geo = new THREE.PlaneGeometry(span * 4, span * 4, 96, 96);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = sea.level;
  mesh.renderOrder = 2;

  let t = 0;
  return {
    mesh,
    update(dt) {
      t += dt;
      mat.uniforms.uTime.value = t;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      heightTex.dispose();
      mesh.parent?.remove(mesh);
    },
  };
}
