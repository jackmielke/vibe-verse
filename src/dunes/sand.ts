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
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
  material: THREE.ShaderMaterial;
  setProbe(mode: "off" | "front" | "double"): void;
  /**
   * Re-march every vertex against the sun. Seconds of work on a phone —
   * only for the capture harness and tests, never on the play path.
   */
  refreshShadows(sun: THREE.Vector3): void;
  /**
   * March a slice of the vertices and move the cursor on. Called every
   * frame with a small budget so the whole field is re-shadowed every
   * couple of seconds without a single long frame anywhere.
   */
  stepShadows(sun: THREE.Vector3, budget: number): void;
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
  // The warp used to be ×5, which swung the phase by five radians over
  // sixteen metres and scrambled a 5.5 m corrugation into noise — visible
  // as nothing at all. It is a wander, not a scramble.
  float ripplePhase = dot(vWorld.xz, acrossWind) * 1.15
                    + noise(vWorld.xz * 0.045) * 1.3;
  float ripple = sin(ripplePhase) * 0.5 + 0.5;
  ripple = pow(ripple, 1.6);
  vec2 slope = acrossWind * cos(ripplePhase) * 0.13 * detail;
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
  float scatter = pow(max(dot(V, -uSun), 0.0), 3.0) * pow(ndl, 0.6) * 0.25;

  vec3 lit = vec3(1.05, 0.72, 0.38);
  // Sand in shadow is lit by the sky, so it is genuinely blue — but at
  // (0.13, 0.14, 0.24) against a near-white lit tone the whole field read
  // as snow at dawn. Warmer and closer together: still cool, still sand.
  vec3 shade = vec3(0.125, 0.115, 0.165);
  // The colour of sand is mostly a question of how much sky it can see.
  float sky = 0.5 + 0.5 * N.y;
  // Lit sand is the sun's colour, not a constant. This shipped as a fixed
  // cream, which meant the entire sunset happened in the sky and the haze
  // while the ground stayed the colour of noon — the one thing this world
  // is about, missing from the half of the frame that is ground.
  // 0.55, not 1.3.
  //
  // This is the whole reason the field looked flat. Lit sand was landing at
  // about (1.36, 1.10, 0.92) in linear — every channel already past white
  // before the tone mapper saw it — so ACES compressed the entire dune
  // field into the top of its shoulder and every crest, face and ripple
  // came out the same cream. Dialling the veil out did not help, because
  // the veil was never the problem: the picture was overexposed at source.
  // Sitting the lit tone near 0.5 puts the variation back in the part of
  // the curve that can carry it.
  vec3 base = mix(shade * mix(0.75, 1.0, sky), lit * uSunColor * 0.78, vSun * wrap);
  base += uSunColor * scatter * vSun;
  // The ripple has to be visible on sand the sun cannot reach, or every
  // lee face in the world is a flat blue-grey card. A shadowed dune is
  // still corrugated; it is just lit by the sky instead.
  base = mix(base, base * 1.16 + vec3(0.05, 0.035, 0.01), ripple * 0.42 * detail);
  base += uSkyColor * sky * 0.14;

  // Individual quartz grains catching the sun. Sparse, tiny, and only on
  // the lit side — this is the detail that says "sand" rather than "dune".
  float g = hash21(floor(vWorld.xz * 22.0));
  float glint = step(0.9955, g) * pow(max(dot(reflect(-uSun, N), V), 0.0), 40.0);
  base += uSunColor * glint * 1.6 * vSun * detail;

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

  // Winding, and it is worth being explicit about which way round.
  //
  // Rings run anticlockwise in (x, z) — x = cos a, z = sin a — and with y
  // up that is *clockwise* seen from above, so the naive order gives every
  // triangle a downward face normal. Three culls back faces by default, so
  // the entire ground you stand on was invisible: what rendered was only
  // the slopes angled away from the camera, and the rest of the frame was
  // the sky dome showing through the floor. It reads exactly like a flat,
  // washed-out desert, which is why it survived so many passes at the
  // lighting — every one of them was tuning a shader on a surface that was
  // not being drawn.
  const indices: number[] = [];
  for (let s = 0; s < segments; s++) {
    indices.push(0, 1 + ((s + 1) % segments), 1 + s);
  }
  for (let ring = 0; ring < rings - 1; ring++) {
    const a0 = 1 + ring * segments;
    const b0 = 1 + (ring + 1) * segments;
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      indices.push(a0 + s, b0 + s1, b0 + s);
      indices.push(a0 + s, a0 + s1, b0 + s1);
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

  const mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> = new THREE.Mesh(
    geometry,
    material,
  );
  mesh.frustumCulled = false;
  mesh.name = "sand";

  /** Test aid: paint the mesh flat, one side or both, to tell a shading
      problem from a winding one. */
  const probeMat = new THREE.MeshBasicMaterial({ color: "#ff00aa" });
  const setProbe = (mode: "off" | "front" | "double") => {
    if (mode === "off") {
      mesh.material = material;
      return;
    }
    probeMat.side = mode === "double" ? THREE.DoubleSide : THREE.FrontSide;
    mesh.material = probeMat;
  };

  const sunAttr = geometry.getAttribute("aSun") as THREE.BufferAttribute;
  let shadowCursor = 0;

  return {
    mesh,
    material,
    setProbe,

    refreshShadows(sunDir) {
      for (let i = 0; i < vertexCount; i++) {
        sunAttr.setX(
          i,
          sunVisibility(positions[i * 3], positions[i * 3 + 2], sunDir.x, sunDir.y, sunDir.z),
        );
      }
      sunAttr.needsUpdate = true;
    },

    stepShadows(sunDir, budget) {
      // Incremental, and deliberately so. Marching all 44,000 vertices in
      // one go costs whole seconds on a phone: it froze the first frame and
      // then hitched every six seconds, for ever, which is what "it does
      // not work" looks like from the outside. Spread over ~90 frames it is
      // invisible, and the sun is allowed to be a second or two ahead of
      // its own shadows — nobody has ever noticed that outdoors either.
      const n = Math.min(budget, vertexCount);
      for (let k = 0; k < n; k++) {
        const i = shadowCursor;
        shadowCursor = (shadowCursor + 1) % vertexCount;
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
      probeMat.dispose();
    },
  };
}
