import * as THREE from "three";
import type { QualityProfile } from "../core/Settings";

/**
 * Sunny Seattle, early August, mid-afternoon.
 *
 * Everything here is *scene-linear HDR*. Nothing in this file tone maps or
 * gamma-encodes — the grade pass at the end of Engine's composer owns that.
 * The calibration anchor is: a diffuse 18% grey surface in full sun lands near
 * 0.18 linear, which the filmic curve maps to middle grey. Every constant
 * below is chosen relative to that anchor:
 *
 *   zenith  ~0.6 linear in blue, ~0.13 in red   — deep blue, darker than sunlit ground
 *   horizon ~1.7 linear, near-neutral           — pale hazy band over the lake
 *   sun disc ~110 linear                        — clips to white, feeds bloom
 *
 * The analytic model is shared verbatim with the screen-space aerial
 * perspective pass in Engine (see ATMOSPHERE_GLSL) so distant geometry fades
 * into exactly the colour the dome is painting behind it.
 */

/** Live atmosphere parameters. Engine's aerial-perspective pass reads this. */
export interface AtmosphereState {
  sunDirection: THREE.Vector3;
  /** spectral tint of the light entering the atmosphere */
  sunTint: THREE.Color;
  rayleigh: number;
  mie: number;
  mieG: number;
  /** master scale converting the dimensionless scattering integral to scene-linear */
  skyLuminance: number;
  /** Rayleigh multiplier for the ground-level slab used by aerial perspective */
  aerialRayleigh: number;
  /** Mie multiplier for the same slab */
  aerialMie: number;
  /** horizon colour, for fog fallback and UI */
  horizon: THREE.Color;
}

export const atmosphere: AtmosphereState = {
  sunDirection: new THREE.Vector3(0.54, 0.79, -0.29).normalize(),
  sunTint: new THREE.Color(1.0, 0.975, 0.93),
  rayleigh: 1.0,
  mie: 0.85,
  mieG: 0.76,
  skyLuminance: 23.0,
  aerialRayleigh: 6.5,
  aerialMie: 3.2,
  horizon: new THREE.Color(0.62, 0.72, 0.82),
};

/**
 * Single-scattering atmosphere. Shared by the sky dome and the aerial
 * perspective pass; both must agree or the horizon line splits.
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
uniform vec3  uSunDirection;
uniform vec3  uSunTint;
uniform float uRayleigh;
uniform float uMie;
uniform float uMieG;
uniform float uSkyLuminance;

const float ATM_PI = 3.141592653589793;

// Sea-level volume scattering coefficients, m^-1, for 680/550/440 nm.
const vec3  BETA_R = vec3(5.8e-6, 13.5e-6, 33.1e-6);
// Aerosol scattering is effectively grey; turbidity rides on uMie.
const float BETA_M = 21.0e-6;
const float H_R = 8400.0;  // Rayleigh scale height, m
const float H_M = 1250.0;  // aerosol scale height, m

float rayleighPhase(float c) { return 0.0596831 * (1.0 + c * c); }      // 3/(16pi)

float hgPhase(float c, float g) {
  float g2 = g * g;
  float d = max(1.0 + g2 - 2.0 * g * c, 1e-4);
  return 0.0795775 * (1.0 - g2) / (d * sqrt(d));                        // 1/(4pi)
}

/** Kasten-Young relative air mass — stays finite through and just below the horizon. */
float airMass(float cosZenith) {
  float c = max(cosZenith, -0.10);
  float zdeg = degrees(acos(clamp(c, -1.0, 1.0)));
  return 1.0 / (c + 0.15 * pow(max(93.885 - zdeg, 1e-3), -1.253));
}

/**
 * Radiance of the air along dir, excluding the solar disc.
 * transmittance comes back as the extinction along the same column, which
 * is what reddens the sun and the clouds as the sun drops.
 */
vec3 atmosphereRadiance(vec3 dir, out vec3 transmittance) {
  float am   = airMass(dir.y);
  vec3  tauR = BETA_R * uRayleigh * H_R * am;
  float tauM = BETA_M * uMie * H_M * am;

  float c  = dot(dir, uSunDirection);
  float pr = rayleighPhase(c);
  float pm = hgPhase(c, uMieG);

  // Each species is attenuated by its own optical depth. Averaging the two
  // extinctions before applying the phase functions (the classic Preetham
  // shortcut) drags the whole dome grey — the blue lives in the difference.
  vec3  inR = pr * (1.0 - exp(-tauR));
  float inM = pm * (1.0 - exp(-tauM));

  transmittance = exp(-(tauR + vec3(tauM)));

  // Multiple-scattering floor: real air never goes black on the anti-solar
  // side, and without it the zenith crushes as the sun swings away.
  vec3 ms = vec3(0.055, 0.085, 0.135) * (1.0 - exp(-tauR)) * 0.0125;

  return (inR + vec3(inM) + ms) * uSkyLuminance * uSunTint;
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vRayDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vRayDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w; // pin the dome to the far plane
}
`;

const SKY_FRAG = /* glsl */ `
varying vec3 vRayDir;

uniform float uTime;
uniform float uSunDiscRadiance;
uniform float uCloudCover;
uniform float uCloudDensity;
uniform float uCloudAbsorb;
uniform float uCloudSun;
uniform float uCloudBase;
uniform float uCloudTop;
uniform vec3  uCameraPos;

${ATMOSPHERE_GLSL}

// ---------------------------------------------------------------- noise ----
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), f.x),
                 mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
                 mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}

float fbm(vec3 p) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < CLOUD_OCTAVES; i++) {
    s += a * vnoise(p);
    n += a;
    p = p * 2.03 + vec3(7.1, 3.7, 11.3);
    a *= 0.5;
  }
  return s / n;
}

// --------------------------------------------------------------- clouds ----
/**
 * Fair-weather cumulus: a hard flat base where the rising air hits its
 * condensation level, billowing cauliflower tops eroded by higher-frequency
 * noise, and nothing in between.
 */
float cloudDensity(vec3 p) {
  float h = clamp((p.y - uCloudBase) / (uCloudTop - uCloudBase), 0.0, 1.0);

  vec3 q = p * 0.00034;                       // ~3 km primary cells
  q.xz += uTime * vec2(0.0022, 0.0011);       // slow westerly drift

  float base = fbm(q);
  float profile = smoothstep(0.0, 0.09, h) * smoothstep(1.0, 0.40, h);

  float d = base * profile - (1.0 - uCloudCover);
  if (d <= 0.0) return 0.0;

  // Erosion bites harder near the top, which is what makes the tops read as
  // billows instead of a lumpy ceiling.
  float er = fbm(q * 6.1 + vec3(19.0, 5.0, 31.0));
  d -= er * 0.26 * (0.30 + 0.70 * h);

  return max(d, 0.0) * uCloudDensity;
}

vec4 marchClouds(vec3 ro, vec3 rd, float cosSun, vec3 ambient, vec3 sunColour, float jitter) {
  float t0 = (uCloudBase - ro.y) / rd.y;
  float t1 = (uCloudTop  - ro.y) / rd.y;
  if (t1 <= 0.0) return vec4(0.0);
  t0 = max(t0, 0.0);

  // Grazing rays would otherwise march 100 km of slab for a two-pixel band.
  float span = min(t1 - t0, 34000.0);
  if (span <= 0.0) return vec4(0.0);

  float dt = span / float(CLOUD_STEPS);
  float lstep = (uCloudTop - uCloudBase) / float(CLOUD_LIGHT_STEPS) * 0.85;

  // Forward-scattering lobe plus a weak back lobe: the first makes the silver
  // lining, the second keeps the anti-solar side from going flat.
  float phase = 0.55 * hgPhase(cosSun, 0.72) * 4.0 + 0.45 * hgPhase(cosSun, -0.22) * 4.0;

  vec3  scattered = vec3(0.0);
  float trans = 1.0;
  float t = t0 + dt * jitter;

  for (int i = 0; i < CLOUD_STEPS; i++) {
    if (trans < 0.02) break;
    vec3 p = ro + rd * t;
    float d = cloudDensity(p);
    if (d > 0.001) {
      float lt = 0.0;
      for (int j = 0; j < CLOUD_LIGHT_STEPS; j++) {
        lt += cloudDensity(p + uSunDirection * (float(j) + 0.5) * lstep);
      }
      float sunT = exp(-lt * lstep * uCloudAbsorb);

      // Powder term: the sunward shell of a cloud is brighter than Beer alone
      // predicts because light scatters in before it is absorbed.
      float powder = 1.0 - exp(-d * dt * uCloudAbsorb * 2.4);

      float hFrac = clamp((p.y - uCloudBase) / (uCloudTop - uCloudBase), 0.0, 1.0);
      vec3 lum = sunColour * sunT * phase * (0.35 + 0.65 * powder)
               + ambient * (0.22 + 0.78 * hFrac);

      float a = 1.0 - exp(-d * dt * uCloudAbsorb);
      scattered += lum * a * trans;
      trans *= 1.0 - a;
    }
    t += dt;
  }

  return vec4(scattered, 1.0 - trans);
}

void main() {
  vec3 rd = normalize(vRayDir);

  vec3 Fex;
  vec3 col = atmosphereRadiance(rd, Fex);

  // ---- solar disc, 0.53 deg across, with Eddington limb darkening ----
  float cosSun = dot(rd, uSunDirection);
  float ang = acos(min(cosSun, 1.0));
  const float SUN_ANG = 0.00465;                       // 0.266 deg mean radius
  float disc = 1.0 - smoothstep(SUN_ANG * 0.80, SUN_ANG * 1.25, ang);
  float mu = sqrt(max(0.0, 1.0 - (ang / SUN_ANG) * (ang / SUN_ANG)));
  vec3 limb = vec3(1.0) - vec3(0.40, 0.51, 0.66) * (1.0 - mu);
  col += uSunDiscRadiance * uSunTint * limb * Fex * disc;

  // ---- cumulus deck ----
  if (rd.y > 0.012) {
    vec3 zenithTr;
    vec3 ambient = atmosphereRadiance(vec3(0.0, 1.0, 0.0), zenithTr) * 0.85;
    // Cloud tops sit above most of the aerosol column, so they see a stronger,
    // less reddened sun than the ground does.
    vec3 sunColour = uSunTint * uCloudSun * mix(vec3(1.0), Fex, 0.35);

    float jitter = hash13(vec3(gl_FragCoord.xy, 1.0));
    vec4 cl = marchClouds(uCameraPos, rd, cosSun, ambient, sunColour, jitter);

    // Fade the deck into the haze band rather than letting it clip the horizon.
    float band = smoothstep(0.012, 0.075, rd.y);
    float a = cl.a * band;
    col = col * (1.0 - a) + cl.rgb * band;
  }

  // ---- below the horizon: the dome shows through under the lake edge ----
  float below = smoothstep(0.0, -0.06, rd.y);
  col = mix(col, col * vec3(0.52, 0.60, 0.66), below);

  // Ordered dither at ~1/1000 of a stop kills the banding a 16-bit target
  // still shows across a 90-degree gradient.
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  col += dither * 0.002;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

export interface SkyRig {
  mesh: THREE.Mesh;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  bounce: THREE.DirectionalLight;
  sunDirection: THREE.Vector3;
  update: (dt: number, elapsed: number, cameraPos: THREE.Vector3) => void;
  setSunElevation: (deg: number, azimuthDeg: number) => void;
}

/** TS mirror of `atmosphereRadiance`, so the light rig tracks the painted sky. */
function skyRadiance(dir: THREE.Vector3, out: THREE.Color): THREE.Color {
  const a = atmosphere;
  const c = Math.max(dir.y, -0.1);
  const zdeg = (Math.acos(THREE.MathUtils.clamp(c, -1, 1)) * 180) / Math.PI;
  const am = 1 / (c + 0.15 * Math.pow(Math.max(93.885 - zdeg, 1e-3), -1.253));

  const betaR = [5.8e-6, 13.5e-6, 33.1e-6];
  const tauM = 21e-6 * a.mie * 1250 * am;
  const cosT = dir.dot(a.sunDirection);
  const pr = 0.0596831 * (1 + cosT * cosT);
  const g2 = a.mieG * a.mieG;
  const d = Math.max(1 + g2 - 2 * a.mieG * cosT, 1e-4);
  const pm = (0.0795775 * (1 - g2)) / (d * Math.sqrt(d));

  const ms = [0.055, 0.085, 0.135];
  const rgb = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const tauR = betaR[i] * a.rayleigh * 8400 * am;
    const sr = 1 - Math.exp(-tauR);
    rgb[i] = (pr * sr + pm * (1 - Math.exp(-tauM)) + ms[i] * sr * 0.0125) * a.skyLuminance;
  }
  return out.setRGB(
    rgb[0] * a.sunTint.r,
    rgb[1] * a.sunTint.g,
    rgb[2] * a.sunTint.b,
  );
}

/** Cloud budget per tier — the raymarch is the only expensive thing in the sky. */
function cloudDefines(profile: QualityProfile): Record<string, string> {
  const steps = { low: 6, medium: 11, high: 16, ultra: 24 }[profile.tier];
  const light = { low: 2, medium: 3, high: 4, ultra: 6 }[profile.tier];
  const oct = { low: 3, medium: 3, high: 4, ultra: 5 }[profile.tier];
  return {
    CLOUD_STEPS: String(steps),
    CLOUD_LIGHT_STEPS: String(light),
    CLOUD_OCTAVES: String(oct),
  };
}

export function createSky(scene: THREE.Scene, profile: QualityProfile): SkyRig {
  const uniforms = {
    uSunDirection: { value: atmosphere.sunDirection.clone() },
    uSunTint: { value: new THREE.Vector3(atmosphere.sunTint.r, atmosphere.sunTint.g, atmosphere.sunTint.b) },
    uRayleigh: { value: atmosphere.rayleigh },
    uMie: { value: atmosphere.mie },
    uMieG: { value: atmosphere.mieG },
    uSkyLuminance: { value: atmosphere.skyLuminance },
    uTime: { value: 0 },
    uCameraPos: { value: new THREE.Vector3() },
    // Bright enough to clip hard and drive the bloom threshold; not so bright
    // that the bloom kernel smears a white disc across a quarter of the frame.
    uSunDiscRadiance: { value: 105 },
    uCloudCover: { value: 0.52 },
    uCloudDensity: { value: 1.35 },
    uCloudAbsorb: { value: 0.0042 },
    uCloudSun: { value: 3.1 },
    uCloudBase: { value: 1500 },
    uCloudTop: { value: 3300 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    defines: cloudDefines(profile),
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), mat);
  mesh.scale.setScalar(profile.drawDistance * 0.92);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  scene.add(mesh);

  const sunDirection = atmosphere.sunDirection;

  // Key light. Calibrated so a 0.18-albedo surface in full sun lands near 0.18
  // linear, which the filmic curve in Engine maps to middle grey.
  const sun = new THREE.DirectionalLight(0xfff4e2, 3.35);
  sun.castShadow = profile.shadowMapSize > 0;
  if (sun.castShadow) {
    sun.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
    const d = 130;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 620;
    sun.shadow.bias = -0.00035;
    sun.shadow.normalBias = 0.035;
    sun.shadow.radius = 2.2;
  }
  sun.target.position.set(0, 0, 0);
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(0x9ccdf5, 0x4a6b62, 1.0);
  scene.add(hemi);

  // Bounce off the lake, cool and low.
  const bounce = new THREE.DirectionalLight(0x8fc4e0, 0.34);
  bounce.position.set(-0.4, -0.5, 0.6);
  scene.add(bounce);

  // The screen-space aerial perspective pass does the distance work; this is
  // only a short-range contact haze so nothing reads glued to the camera.
  const fog = new THREE.FogExp2(0xbcd4e8, 0.00004);
  scene.fog = fog;

  const zenithCol = new THREE.Color();
  const horizonCol = new THREE.Color();
  const tmpDir = new THREE.Vector3();

  const setSunElevation = (elevationDeg: number, azimuthDeg: number) => {
    const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
    const theta = THREE.MathUtils.degToRad(azimuthDeg);
    sunDirection.setFromSphericalCoords(1, phi, theta);
    uniforms.uSunDirection.value.copy(sunDirection);

    // Turbidity climbs as the sun drops: the same haze depth over a longer path.
    const t = THREE.MathUtils.clamp(elevationDeg / 55, 0, 1);
    atmosphere.mie = THREE.MathUtils.lerp(1.6, 0.85, t);
    uniforms.uMie.value = atmosphere.mie;

    // Direct sunlight reddens through the thickening column.
    sun.color.setRGB(
      1.0,
      THREE.MathUtils.lerp(0.72, 0.955, t),
      THREE.MathUtils.lerp(0.46, 0.885, t),
    );
    sun.intensity = THREE.MathUtils.lerp(1.1, 3.35, t);

    // Ambient from the actual dome: zenith above, and the horizon band which
    // is what really lights the undersides of things over open water.
    skyRadiance(tmpDir.set(0, 1, 0), zenithCol);
    skyRadiance(tmpDir.copy(sunDirection).setY(0.06).normalize(), horizonCol);
    atmosphere.horizon.copy(horizonCol);

    const zl = Math.max(zenithCol.r, zenithCol.g, zenithCol.b, 1e-4);
    hemi.color.setRGB(zenithCol.r / zl, zenithCol.g / zl, zenithCol.b / zl);
    hemi.intensity = THREE.MathUtils.lerp(0.4, 1.05, t);

    fog.color.copy(horizonCol).multiplyScalar(0.5);
    bounce.intensity = THREE.MathUtils.lerp(0.14, 0.34, t);
  };

  // Seafair: early August, ~3pm, sun high in the south-west.
  setSunElevation(52, 118);

  const update = (_dt: number, elapsed: number, cameraPos: THREE.Vector3) => {
    uniforms.uTime.value = elapsed;
    uniforms.uCameraPos.value.copy(cameraPos);
    mesh.position.copy(cameraPos);
    // Keep the shadow frustum centred on the player so it stays crisp.
    sun.target.position.copy(cameraPos);
    sun.position.copy(cameraPos).addScaledVector(sunDirection, 380);
    sun.target.updateMatrixWorld();
  };

  return { mesh, sun, hemi, bounce, sunDirection, update, setSunElevation };
}
