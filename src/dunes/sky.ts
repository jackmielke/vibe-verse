/**
 * Sunset, as a function of one number.
 *
 * `elevation` runs from 1 (sun high) to 0 (sun on the horizon) to negative
 * (gone), and it is the run timer — see `world.ts`. Everything about the
 * light comes off it: the sun's colour walks white → gold → blood, the sky
 * walks blue → amber → indigo, and the horizon band that makes a desert
 * sunset look like a desert sunset widens as the sun drops into it.
 *
 * Analytic rather than a real scattering integral. A Rayleigh/Mie march
 * would cost a loop per pixel to arrive somewhere a two-term gradient and
 * a Mie lobe already get to — and this world already spends its per-pixel
 * budget on the sand.
 */
import * as THREE from "three";

export interface SkyHandle {
  mesh: THREE.Mesh;
  /** Unit vector toward the sun. */
  readonly sunDir: THREE.Vector3;
  /** Light colour at the current elevation, for the sand and the rider. */
  readonly sunColor: THREE.Color;
  /** Ambient sky colour, same. */
  readonly skyColor: THREE.Color;
  setElevation(elevation: number): void;
  update(time: number, camera: THREE.Camera): void;
  dispose(): void;
}

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSun;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform float uElevation;
uniform float uTime;
varying vec3 vDir;

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
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = rot * p * 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec3 rd = normalize(vDir);
  float up = max(rd.y, 0.0);

  // The gradient. A *small* exponent reaches the zenith colour quickly, so
  // an afternoon sky is blue a few degrees up and only a sunset lets the
  // horizon colour climb. This was the wrong way round, which painted a
  // high-noon sky the same pale gold as the sand it met — no horizon line
  // anywhere in the frame, and a dune field with no skyline at all.
  float band = mix(0.55, 3.0, clamp(1.0 - uElevation, 0.0, 1.0));
  vec3 sky = mix(uHorizon, uZenith, pow(up, band));

  // Mie: the broad glow around a low sun, and the reason the whole western
  // half of the sky goes gold rather than just the disc.
  float mu = dot(rd, uSun);
  float mie = pow(max(mu, 0.0), 8.0) * 0.55 + pow(max(mu, 0.0), 2.0) * 0.18;
  sky += uSunColor * mie * (0.6 + (1.0 - clamp(uElevation, 0.0, 1.0)) * 1.4);

  // The disc, softened — it is being seen through a lot of atmosphere and
  // a lot of airborne sand, so it has no hard edge at all down here.
  float disc = smoothstep(0.9987, 0.99955, mu);
  sky += uSunColor * disc * mix(6.0, 2.2, clamp(1.0 - uElevation, 0.0, 1.0));

  // High cloud, lit from underneath once the sun is low. Cheap: two fbm
  // octaves projected onto the dome, no volume, no motion beyond a drift.
  if (rd.y > 0.02) {
    vec2 cuv = rd.xz / (rd.y + 0.22) * 0.55 + vec2(uTime * 0.004, 0.0);
    float c = smoothstep(0.52, 0.78, fbm(cuv));
    float band2 = smoothstep(0.0, 0.35, rd.y) * smoothstep(1.0, 0.35, rd.y);
    vec3 cloudLit = mix(uHorizon * 1.2, uSunColor, 0.65);
    sky = mix(sky, cloudLit, c * band2 * 0.55);
  }

  // First stars, once the sun is under.
  if (uElevation < 0.12 && rd.y > 0.0) {
    vec2 cell = floor(rd.xz / max(rd.y + 0.3, 0.001) * 30.0);
    float h = hash21(cell);
    if (h > 0.986) {
      float fade = smoothstep(0.12, -0.08, uElevation) * smoothstep(0.0, 0.4, rd.y);
      sky += vec3(0.8, 0.85, 1.0) * fade * 1.2;
    }
  }

  gl_FragColor = vec4(sky, 1.0);
}
`;

/** Sun colour by elevation — the palette the whole world is graded from. */
function sunColorAt(elevation: number, out: THREE.Color): THREE.Color {
  const e = THREE.MathUtils.clamp(elevation, -0.2, 1);
  if (e > 0.45) {
    // Afternoon: bright, barely warm.
    return out.setRGB(1.0, 0.93, 0.82).lerp(new THREE.Color(1.0, 0.82, 0.58), (1 - e) / 0.55);
  }
  // The last of it: gold into blood, and dimming fast.
  const t = THREE.MathUtils.clamp((0.45 - e) / 0.6, 0, 1);
  out.setRGB(1.0, 0.82, 0.58).lerp(new THREE.Color(0.95, 0.28, 0.16), t);
  return out.multiplyScalar(1 - t * 0.55);
}

function skyColorAt(elevation: number, out: THREE.Color): THREE.Color {
  const e = THREE.MathUtils.clamp(elevation, -0.2, 1);
  const day = new THREE.Color(0.34, 0.52, 0.86);
  const dusk = new THREE.Color(0.42, 0.26, 0.42);
  const night = new THREE.Color(0.06, 0.07, 0.16);
  if (e > 0.25) return out.copy(night).lerp(day, THREE.MathUtils.clamp((e - 0.1) / 0.9, 0, 1));
  const t = THREE.MathUtils.clamp((0.25 - e) / 0.45, 0, 1);
  return out.copy(dusk).lerp(night, t);
}

export function buildSky(): SkyHandle {
  const sunDir = new THREE.Vector3(0, 0.5, -1).normalize();
  const sunColor = new THREE.Color();
  const skyColor = new THREE.Color();

  const material = new THREE.ShaderMaterial({
    name: "DuneSky",
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uSun: { value: sunDir },
      uSunColor: { value: sunColor },
      uZenith: { value: new THREE.Color("#2f4f9e") },
      uHorizon: { value: new THREE.Color("#ffb46a") },
      uElevation: { value: 1 },
      uTime: { value: 0 },
    },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), material);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;

  const setElevation = (elevation: number) => {
    // The sun sits due west-ish and drops straight down: azimuth fixed so
    // the dune shadows all run the same way and the field reads as one
    // lit landscape rather than a set of unrelated lumps.
    const e = elevation;
    sunDir.set(-0.86, Math.max(-0.12, e * 0.62), -0.5).normalize();
    sunColorAt(e, sunColor);
    skyColorAt(e, skyColor);
    material.uniforms.uElevation.value = e;
    (material.uniforms.uZenith.value as THREE.Color)
      .set("#2f4f9e")
      .lerp(new THREE.Color("#0a0d20"), THREE.MathUtils.clamp(1 - e * 1.6, 0, 1));
    (material.uniforms.uHorizon.value as THREE.Color)
      // Pale haze by day, gold as it drops, indigo once it is gone.
      .set("#cfd8ea")
      .lerp(new THREE.Color("#ffd9a0"), THREE.MathUtils.clamp((1 - e) * 1.5, 0, 1))
      .lerp(new THREE.Color("#c2401f"), THREE.MathUtils.clamp((1 - e) * 0.9, 0, 1))
      .lerp(new THREE.Color("#1a1030"), THREE.MathUtils.clamp(-e * 3.5, 0, 1));
  };
  setElevation(1);

  return {
    mesh,
    sunDir,
    sunColor,
    skyColor,
    setElevation,
    update(time, camera) {
      material.uniforms.uTime.value = time;
      mesh.position.copy(camera.position);
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
