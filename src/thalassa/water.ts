/**
 * The sea, and the bay inside it.
 *
 * The painting's water is the brightest thing in it: pale turquoise over the
 * sand at the edges, deepening to a saturated blue in the middle of the bay
 * and to ink beyond the headlands. That gradient is the whole look, so the
 * colour is driven by real depth, read from a texture baked from the same
 * height field the ground uses. Shallow water is also partly transparent, so
 * the sand and the caustics on it show through.
 *
 * Foam is where the depth runs out: a thin lapping line inside the bay and a
 * broad broken surf against the cliffs outside it.
 *
 * No backticks inside the GLSL: it is a template literal.
 */
import * as THREE from "three";
import { EXTENT, depthTexels } from "./map";

const vert = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  float swell = sin(w.x * 0.045 + uTime * 0.7) * 0.09 + sin(w.z * 0.06 - uTime * 0.55 + 1.3) * 0.07;
  w.y += swell;
  vWorld = w.xyz;
  vec4 mvPosition = viewMatrix * w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const frag = /* glsl */ `
precision highp float;
uniform float uTime;
uniform sampler2D uDepth;
uniform float uExtent;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSky;
uniform vec3 uShallow;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform vec3 uAbyss;
varying vec3 vWorld;
#include <fog_pars_fragment>

float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), u.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float waves(vec2 p, float t) {
  float h = 0.0;
  h += wNoise(p * 0.35 + vec2(t * 0.22, t * 0.13)) * 0.5;
  h += wNoise(p * 0.9 - vec2(t * 0.31, -t * 0.27)) * 0.3;
  h += wNoise(p * 2.4 + vec2(-t * 0.5, t * 0.45)) * 0.2;
  return h;
}

void main() {
  vec2 uv = (vWorld.xz + uExtent) / (2.0 * uExtent);
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  vec4 tex = texture2D(uDepth, clamp(uv, 0.0, 1.0));
  float dn = mix(1.0, tex.r, inside);
  float depth = dn * dn * 26.0;
  float bay = tex.g * inside;

  // Surface normal from layered noise: calmer in the bay than at sea.
  float t = uTime;
  vec2 p = vWorld.xz;
  float e = 0.15;
  float amp = mix(0.55, 0.32, bay);
  float h0 = waves(p, t);
  float hx = waves(p + vec2(e, 0.0), t);
  float hz = waves(p + vec2(0.0, e), t);
  vec3 n = normalize(vec3((h0 - hx) * amp, e, (h0 - hz) * amp));

  vec3 view = normalize(cameraPosition - vWorld);
  float dist = length(cameraPosition - vWorld);

  // Colour by depth: pale over sand, turquoise, blue, ink.
  vec3 body = mix(uShallow, uMid, smoothstep(0.2, 3.2, depth));
  body = mix(body, uDeep, smoothstep(3.0, 11.0, depth));
  body = mix(body, uAbyss, smoothstep(11.0, 26.0, depth));
  // Light coming up through the water: brighter when the surface tilts to the sun.
  body *= 0.92 + 0.16 * dot(n, normalize(uSunDir + vec3(0.0, 1.0, 0.0)));

  float fres = pow(clamp(1.0 - max(dot(n, view), 0.0), 0.0, 1.0), 5.0);
  fres = mix(0.02, 0.85, fres);
  vec3 col = mix(body, uSky, fres * 0.6);

  vec3 hv = normalize(uSunDir + view);
  float spec = pow(max(dot(n, hv), 0.0), 380.0) * 5.0;
  float sheen = pow(max(dot(n, hv), 0.0), 34.0) * 0.18;
  col += uSunCol * (spec + sheen);

  // Foam: a lapping line in the bay, broken surf against the coast outside it.
  float edge = mix(1.7, 0.75, bay);
  float breakup = wNoise(p * 0.8 + vec2(t * 0.3, -t * 0.2)) * 0.6 + wNoise(p * 3.1 - t * 0.4) * 0.4;
  float pulse = sin(t * mix(1.1, 1.6, bay) - depth * 5.0) * 0.5 + 0.5;
  float line = smoothstep(edge, 0.0, depth + (breakup - 0.5) * 0.7 - pulse * 0.35);
  float foam = line * smoothstep(0.25, 0.65, breakup + line * 0.4);
  foam = max(foam, smoothstep(0.18, 0.0, depth));
  col = mix(col, vec3(0.97, 0.99, 1.0), clamp(foam, 0.0, 1.0) * 0.9);

  // Shallow water is clear.
  float alpha = mix(0.38, 0.97, smoothstep(0.0, 4.5, depth));
  alpha = max(alpha, foam * 0.9);
  alpha = mix(alpha, 1.0, smoothstep(120.0, 400.0, dist));

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface Water {
  mesh: THREE.Mesh;
  update(time: number, sunDir: THREE.Vector3): void;
  dispose(): void;
}

export function createWater(): Water {
  const size = 1024;
  const tex = new THREE.DataTexture(depthTexels(size), size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uDepth: { value: null },
      uExtent: { value: EXTENT },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color("#fff3d6") },
      uSky: { value: new THREE.Color("#bfe3f7") },
      uShallow: { value: new THREE.Color("#7ff0dc") },
      uMid: { value: new THREE.Color("#19c0cf") },
      uDeep: { value: new THREE.Color("#0f86c4") },
      uAbyss: { value: new THREE.Color("#0b4f93") },
    },
  ]);
  uniforms.uDepth.value = tex;
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  const geo = new THREE.PlaneGeometry(3600, 3600, 300, 300);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "water";
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;

  return {
    mesh,
    update(time, sunDir) {
      uniforms.uTime.value = time;
      uniforms.uSunDir.value.copy(sunDir);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      tex.dispose();
    },
  };
}
