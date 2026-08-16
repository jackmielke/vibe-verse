/**
 * The sand: one mesh, built by sampling `duneHeight` on a radial grid.
 *
 * Radial rather than square because the player is always somewhere in a
 * circular bowl and the horizon is always the rim: a polar grid spends its
 * vertices where the camera is and thins them out toward the edge, which is
 * exactly the wrong way round for a square one. 240 rings of 220 segments
 * puts a vertex every 1.5 m near the oasis and every 9 m at the rim, for
 * about a fifth of the triangles a uniform grid would need to match it.
 *
 * Normals come from the analytic gradient rather than from the triangles,
 * so the shading is the shape of the *function* and not the shape of the
 * tessellation — the difference is visible at the rim, where a geometry
 * normal would facet into obvious rings.
 *
 * Sun visibility is a vertex attribute, recomputed on a slow cadence as the
 * sun goes down (see `refreshShadows`). It is the single most valuable
 * channel in the picture: at a low sun the lee faces go blue and the crests
 * burn, and without it a sunset dune field is an orange carpet.
 */
import * as THREE from "three";
import { duneHeight, duneNormal, sunVisibility, DUNE_RADIUS } from "./terrain";

export interface SandHandle {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  /** Re-march the sun shadows. Costly — call it a few times a minute. */
  refreshShadows(sun: THREE.Vector3): void;
  update(sun: THREE.Vector3, sunColor: THREE.Color, skyColor: THREE.Color, time: number): void;
  dispose(): void;
}

const VERT = /* glsl */ `
attribute float aSun;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vSun;
void main() {
  vWorld = position;
  vNormal = normal;
  vSun = aSun;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSun;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform float uTime;
uniform vec3 uCamera;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vSun;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}

void main() {
  vec3 V = normalize(uCamera - vWorld);
  float dist = length(uCamera.xz - vWorld.xz);
  vec3 N = normalize(vNormal);

  // ---- Wind ripples ----------------------------------------------------
  // Centimetre-scale corrugations running across the wind. They are the
  // only thing at human scale out here — without them the sand has no
  // texture at all until you hit a crest, and speed stops reading.
  float detail = exp(-dist * 0.004);
  vec2 wind = normalize(vec2(0.87, 0.49));
  vec2 acrossWind = vec2(-wind.y, wind.x);
  float ripplePhase = dot(vWorld.xz, acrossWind) * 1.15
                    + noise(vWorld.xz * 0.06) * 5.0;
  float ripple = sin(ripplePhase) * 0.5 + 0.5;
  ripple = pow(ripple, 1.6);
  vec2 slope = acrossWind * cos(ripplePhase) * 0.19 * detail;
  N = normalize(N + vec3(slope.x, 0.0, slope.y));

  // ---- Light -----------------------------------------------------------
  // Wrap lighting. Dry sand scatters so hard that a grain lit at ninety
  // degrees still throws light at you — a hard Lambert terminator makes a
  // dune field look like it is made of painted plaster.
  float ndl = max(dot(N, uSun), 0.0);
  float wrap = max((dot(N, uSun) + 0.3) / 1.3, 0.0);
  // Sand is bright, dry and rough: a wide diffuse lobe with almost no
  // specular, plus a strong forward-scatter when you look toward the sun
  // through the top millimetre of a lit crest.
  float scatter = pow(max(dot(V, -uSun), 0.0), 3.0) * pow(ndl, 0.6) * 0.55;

  vec3 lit = vec3(1.02, 0.76, 0.44);
  vec3 shade = vec3(0.31, 0.31, 0.43);
  // The colour of sand is mostly a question of how much sky it can see.
  float sky = 0.5 + 0.5 * N.y;
  // Lit sand is the sun's colour, not a constant. This shipped as a fixed
  // cream, which meant the entire sunset happened in the sky and the haze
  // while the ground stayed the colour of noon — the one thing this world
  // is about, missing from the half of the frame that is ground.
  vec3 base = mix(shade * mix(0.75, 1.0, sky), lit * uSunColor * 1.3, vSun * wrap);
  base += uSunColor * scatter * vSun;
  // The ripple has to be visible on sand the sun cannot reach, or every
  // lee face in the world is a flat blue-grey card. A shadowed dune is
  // still corrugated; it is just lit by the sky instead.
  base = mix(base, base * 1.16 + vec3(0.05, 0.035, 0.01), ripple * 0.6 * detail);
  base += uSkyColor * sky * 0.26;

  // Individual quartz grains catching the sun. Sparse, tiny, and only on
  // the lit side — this is the detail that says "sand" rather than "dune".
  float g = hash21(floor(vWorld.xz * 22.0));
  float glint = step(0.9955, g) * pow(max(dot(reflect(-uSun, N), V), 0.0), 40.0);
  base += uSunColor * glint * 3.0 * vSun * detail;

  // ---- Haze ------------------------------------------------------------
  // Blown sand in the air. Thicker toward the sun, because that is where
  // the light is being scattered from.
  float haze = 1.0 - exp(-dist * 0.00016);
  float towardSun = pow(max(dot(-V, uSun) * 0.5 + 0.5, 0.0), 3.0);
  vec3 hazeColor = mix(uSkyColor, uSunColor, towardSun * 0.7);
  // Capped: at 0.95 the far half of the field went the colour of the sky
  // and the dune field lost its skyline, which is the one thing distance
  // haze is supposed to be *creating*.
  base = mix(base, hazeColor, haze * 0.55);

  gl_FragColor = vec4(base, 1.0);
}
`;

export function buildSand(rings: number, segments: number): SandHandle {
  const geometry = new THREE.BufferGeometry();
  const vertexCount = rings * segments + 1;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const sun = new Float32Array(vertexCount);
  const n = { x: 0, y: 1, z: 0 };

  // Centre vertex, then a ring per radius. Radii are squared so the rings
  // bunch up near the oasis where the player spends the endgame.
  positions[0] = 0;
  positions[1] = duneHeight(0, 0);
  positions[2] = 0;
  duneNormal(0, 0, 0.5, n);
  normals[0] = n.x;
  normals[1] = n.y;
  normals[2] = n.z;
  sun[0] = 1;

  const radiusAt = (ring: number) => {
    const t = (ring + 1) / rings;
    return DUNE_RADIUS * 1.06 * t * t;
  };

  for (let ring = 0; ring < rings; ring++) {
    const r = radiusAt(ring);
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const i = 1 + ring * segments + s;
      positions[i * 3] = x;
      positions[i * 3 + 1] = duneHeight(x, z);
      positions[i * 3 + 2] = z;
      // Normal epsilon scales with the local vertex spacing: sampling a
      // metre apart out at the rim, where quads are nine metres wide,
      // shades detail the mesh cannot show and shimmers when you move.
      duneNormal(x, z, Math.max(0.5, r / rings), n);
      normals[i * 3] = n.x;
      normals[i * 3 + 1] = n.y;
      normals[i * 3 + 2] = n.z;
      sun[i] = 1;
    }
  }

  const indices: number[] = [];
  for (let s = 0; s < segments; s++) {
    indices.push(0, 1 + s, 1 + ((s + 1) % segments));
  }
  for (let ring = 0; ring < rings - 1; ring++) {
    const a0 = 1 + ring * segments;
    const b0 = 1 + (ring + 1) * segments;
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      indices.push(a0 + s, b0 + s, b0 + s1);
      indices.push(a0 + s, b0 + s1, a0 + s1);
    }
  }

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("aSun", new THREE.BufferAttribute(sun, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  const material = new THREE.ShaderMaterial({
    name: "DuneSand",
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uSun: { value: new THREE.Vector3(0, 0.2, -1) },
      uSunColor: { value: new THREE.Color("#ffb46a") },
      uSkyColor: { value: new THREE.Color("#8fb4ff") },
      uCamera: { value: new THREE.Vector3() },
      uTime: { value: 0 },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.name = "sand";

  const sunAttr = geometry.getAttribute("aSun") as THREE.BufferAttribute;

  return {
    mesh,
    material,

    refreshShadows(sunDir) {
      for (let i = 0; i < vertexCount; i++) {
        sunAttr.setX(
          i,
          sunVisibility(positions[i * 3], positions[i * 3 + 2], sunDir.x, sunDir.y, sunDir.z),
        );
      }
      sunAttr.needsUpdate = true;
    },

    update(sunDir, sunColor, skyColor, time) {
      // uCamera is written by the world each frame; kept here so the
      // material owns every uniform it declares.
      (material.uniforms.uSun.value as THREE.Vector3).copy(sunDir);
      (material.uniforms.uSunColor.value as THREE.Color).copy(sunColor);
      (material.uniforms.uSkyColor.value as THREE.Color).copy(skyColor);
      material.uniforms.uTime.value = time;
    },

    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
