/**
 * Puget Sound light. A physical dome (Preetham scattering, the model behind
 * three's Sky, with a marine haze band along the horizon and an overcast
 * blend that turns it into a luminous grey lid) with the sun where it is over
 * Bainbridge on a September afternoon: south-west, a third of the way up.
 *
 * The dome is run through PMREM so glass, metal roofs and wet road reflect
 * the same sky, but with the sun disc switched off for that render: with the
 * disc in, the diffuse part of the environment carries the direct sun again,
 * unshadowed, and every shadow in the world fills in flat.
 *
 * Shadows come in two tiers. `sun` is the sharp one: a 4096 map on a box that
 * follows the eye and leans into the view direction. `far` is a second light
 * with zero intensity, so it lights nothing, whose 4096 map the renderer
 * still draws; the post pipeline samples that map for everything beyond the
 * near box, so the far hills keep their shadows without a visible seam.
 */
import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { atmosphere, onFrame } from "./light";

export type Weather = "sun" | "overcast";

export interface SkyRig {
  /** What every MeshStandardMaterial should set as envMapIntensity. */
  envIntensity(): number;
  sky: Sky;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  setWeather(w: Weather, renderer: THREE.WebGLRenderer, scene: THREE.Scene): void;
  dispose(): void;
}

const DOME_FRAG = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying float vSunfade;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;

uniform float mieDirectionalG;
uniform vec3 up;
uniform float uSunDisc;
uniform float uDiscBright;
uniform float uHaze;
uniform vec3 uHazeColor;
uniform float uOvercast;
uniform vec3 uOcZenith;
uniform vec3 uOcHorizon;
uniform float uOcGlow;
uniform float uCloudSeed;

const float pi = 3.141592653589793238462643383279502884197169;
const float rayleighZenithLength = 8.4E3;
const float mieZenithLength = 1.25E3;
const float sunAngularDiameterCos = 0.999956676946448443553574619906976478926848692873900859324;
const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
const float ONE_OVER_FOURPI = 0.07957747154594767;

float rayleighPhase(float cosTheta) { return THREE_OVER_SIXTEENPI * (1.0 + pow(cosTheta, 2.0)); }
float hgPhase(float cosTheta, float g) {
  float g2 = pow(g, 2.0);
  float inverse = 1.0 / pow(1.0 - 2.0 * g * cosTheta + g2, 1.5);
  return ONE_OVER_FOURPI * ((1.0 - g2) * inverse);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec2(17.3, 9.1);
    a *= 0.5;
  }
  return s;
}

void main() {
  vec3 direction = normalize(vWorldPosition - cameraPosition);

  float zenithAngle = acos(max(0.0, dot(up, direction)));
  float inverse = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));
  float sR = rayleighZenithLength * inverse;
  float sM = mieZenithLength * inverse;
  vec3 Fex = exp(-(vBetaR * sR + vBetaM * sM));

  float cosTheta = dot(direction, vSunDirection);
  float rPhase = rayleighPhase(cosTheta * 0.5 + 0.5);
  vec3 betaRTheta = vBetaR * rPhase;
  float mPhase = hgPhase(cosTheta, mieDirectionalG);
  vec3 betaMTheta = vBetaM * mPhase;

  vec3 Lin = pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * (1.0 - Fex), vec3(1.5));
  Lin *= mix(vec3(1.0), pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * Fex, vec3(1.0 / 2.0)), clamp(pow(1.0 - dot(up, vSunDirection), 5.0), 0.0, 1.0));

  vec3 L0 = vec3(0.1) * Fex;
  vec3 texColor = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
  vec3 clear = pow(texColor, vec3(1.0 / (1.2 + (1.2 * vSunfade))));

  // Marine haze: the air over the Sound whitens the low sky, more so toward the sun.
  float h = clamp(direction.y, 0.0, 1.0);
  float band = pow(1.0 - h, 12.0);
  float toward = 0.5 + 0.5 * cosTheta;
  clear = mix(clear, uHazeColor * (0.7 + 0.35 * toward), uHaze * band);

  // The sun itself, at a sane radiance for the bloom, with a soft corona.
  float sundisk = smoothstep(sunAngularDiameterCos - 0.00003, sunAngularDiameterCos + 0.00002, cosTheta);
  clear += uSunDisc * Fex * (uDiscBright * sundisk + 0.7 * pow(max(cosTheta, 0.0), 3000.0));

  // Overcast: a luminous lid, a little brighter overhead than at the horizon,
  // mottled stratus that smears out toward the horizon, and a brighter patch
  // where the sun is behind it.
  vec2 cp = direction.xz / (max(direction.y, 0.0) + 0.12);
  float cl = fbm(cp * 1.6 + uCloudSeed);
  float grad = smoothstep(-0.1, 0.7, direction.y);
  vec3 oc = mix(uOcHorizon, uOcZenith, grad);
  oc *= 1.0 + 0.3 * (cl - 0.5) * 2.0 * (0.3 + 0.7 * grad);
  oc += uOcGlow * pow(max(cosTheta, 0.0), 12.0);

  gl_FragColor = vec4(mix(clear, oc, uOvercast), 1.0);
}
`;

/** Unit vector toward the sun for a compass bearing (from north, clockwise) and an elevation, both in degrees. North is -z, east is +x. */
function sunVector(azimuthDeg: number, elevationDeg: number): THREE.Vector3 {
  const a = THREE.MathUtils.degToRad(azimuthDeg);
  const e = THREE.MathUtils.degToRad(elevationDeg);
  return new THREE.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)).normalize();
}

export function buildSky(scene: THREE.Scene, renderer: THREE.WebGLRenderer): SkyRig {
  const sky = new Sky();
  sky.scale.setScalar(6000);
  const base = Sky.SkyShader as { vertexShader: string; uniforms: Record<string, THREE.IUniform> };
  const uniforms: Record<string, THREE.IUniform> = {
    ...THREE.UniformsUtils.clone(base.uniforms),
    uSunDisc: { value: 1 },
    uDiscBright: { value: 10 },
    uHaze: { value: 0.55 },
    uHazeColor: { value: new THREE.Color(0.78, 0.84, 0.94) },
    uOvercast: { value: 0 },
    uOcZenith: { value: new THREE.Color(0.8, 0.84, 0.9) },
    uOcHorizon: { value: new THREE.Color(0.66, 0.69, 0.73) },
    uOcGlow: { value: 0.35 },
    uCloudSeed: { value: 3.7 },
  };
  sky.material.dispose();
  sky.material = new THREE.ShaderMaterial({
    name: "BeckDome",
    uniforms,
    vertexShader: base.vertexShader,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
  });
  scene.add(sky);

  // Near tier: sharp, follows the eye.
  const sun = new THREE.DirectionalLight(0xfff0d8, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.near = 280;
  sun.shadow.camera.far = 720;
  sun.shadow.bias = -0.00015;
  sun.shadow.normalBias = 0.045;
  sun.shadow.radius = 2;
  scene.add(sun);
  scene.add(sun.target);

  // Far tier: a light that lights nothing but whose map the renderer draws;
  // the post pipeline samples it beyond the near box.
  const FAR_HALF = 520;
  const far = new THREE.DirectionalLight(0xffffff, 0);
  far.castShadow = true;
  far.shadow.mapSize.set(4096, 4096);
  far.shadow.camera.near = 600;
  far.shadow.camera.far = 2200;
  far.shadow.camera.left = -FAR_HALF;
  far.shadow.camera.right = FAR_HALF;
  far.shadow.camera.top = FAR_HALF;
  far.shadow.camera.bottom = -FAR_HALF;
  far.shadow.bias = -0.0004;
  far.shadow.normalBias = 0.3;
  scene.add(far);
  scene.add(far.target);

  const hemi = new THREE.HemisphereLight(0xd6e2f0, 0x4a5838, 0.5);
  scene.add(hemi);

  atmosphere.nearLight = sun;
  atmosphere.farLight = far;

  let pmrem: THREE.PMREMGenerator | null = null;
  let envTex: THREE.Texture | null = null;
  let envIntensity = 0.6;
  const sunDir = new THREE.Vector3();

  // The shadow boxes follow the eye and lean into the view.
  const fwd = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const rel = new THREE.Vector3();
  const ax = new THREE.Vector3();
  const ay = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const placeBox = (light: THREE.DirectionalLight, eye: THREE.Vector3, distance: number, half: number, lean: number) => {
    light.target.position.copy(eye);
    light.position.copy(eye).addScaledVector(sunDir, distance);
    ax.crossVectors(UP, sunDir).normalize();
    ay.crossVectors(sunDir, ax).normalize();
    centre.copy(eye).addScaledVector(fwd, lean);
    rel.subVectors(centre, light.position);
    const cx = rel.dot(ax);
    const cy = rel.dot(ay);
    const cam = light.shadow.camera;
    cam.left = cx - half;
    cam.right = cx + half;
    cam.bottom = cy - half;
    cam.top = cy + half;
    cam.updateProjectionMatrix();
  };
  const offFrame = onFrame((camera) => {
    camera.updateMatrixWorld();
    const eye = camera.position;
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    // A walker gets a 140 m box, 3.4 cm a texel; flying higher widens it.
    const nearHalf = 70 + 0.6 * Math.max(0, eye.y - 45);
    sun.shadow.camera.near = 500 - nearHalf * 1.2 - 140;
    sun.shadow.camera.far = 500 + nearHalf * 1.2 + 140;
    placeBox(sun, eye, 500, nearHalf, nearHalf * 0.45);
    placeBox(far, eye, 1400, FAR_HALF, FAR_HALF * 0.3);
  });

  function tintWater(s: THREE.Scene, skyColor: THREE.Color, deep: THREE.Color) {
    // The sea is somebody else's shader; if it exposes its sky and deep colours, hand it this sky's.
    s.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      const u = m && (m as THREE.ShaderMaterial).isShaderMaterial ? m.uniforms : null;
      if (!u || !u.uSkyColor || !u.uDeep) return;
      const a = u.uSkyColor.value as { set?: (r: number, g: number, b: number) => unknown };
      const b = u.uDeep.value as { set?: (r: number, g: number, b: number) => unknown };
      if (typeof a?.set === "function") a.set(skyColor.r, skyColor.g, skyColor.b);
      if (typeof b?.set === "function") b.set(deep.r, deep.g, deep.b);
    });
  }

  function setWeather(w: Weather, r: THREE.WebGLRenderer, s: THREE.Scene) {
    // Bainbridge, mid-September, late afternoon: the sun is in the south-west,
    // about a third of the way up the sky.
    const elevation = w === "sun" ? 33 : 30;
    const azimuth = 228;
    sunDir.copy(sunVector(azimuth, elevation));
    const u = sky.material.uniforms;
    u.sunPosition.value.copy(sunDir);
    atmosphere.weather = w;
    atmosphere.sunDir.copy(sunDir);
    if (w === "sun") {
      u.turbidity.value = 2.7;
      u.rayleigh.value = 1.7;
      u.mieCoefficient.value = 0.0045;
      u.mieDirectionalG.value = 0.82;
      u.uHaze.value = 0.5;
      u.uOvercast.value = 0;
      sun.intensity = 3.6;
      sun.color.set(0xfff0d8);
      hemi.color.set(0xcfdff2);
      hemi.groundColor.set(0x4d5a3a);
      hemi.intensity = 0.4;
      envIntensity = 0.5;
      atmosphere.sunColor.set(1, 0.92, 0.8);
      atmosphere.hazeColor.set(0.62, 0.7, 0.82);
      atmosphere.hazeDensity = 0.00055;
      atmosphere.hazeGlow = 0.6;
      atmosphere.mistDensity = 0;
      atmosphere.farShadowStrength = 0.72;
      atmosphere.exposure = 0.66;
      atmosphere.bloom = 0.2;
      atmosphere.grain = 0.028;
      atmosphere.saturation = 1.08;
      atmosphere.shadowTint.set(-0.004, 0.0, 0.012);
      atmosphere.ao = 1.0;
      tintWater(s, new THREE.Color(0.55, 0.64, 0.74), new THREE.Color(0.06, 0.11, 0.14));
    } else {
      u.turbidity.value = 12;
      u.rayleigh.value = 0.8;
      u.mieCoefficient.value = 0.02;
      u.mieDirectionalG.value = 0.9;
      u.uHaze.value = 0.8;
      u.uOvercast.value = 1;
      sun.intensity = 0.32;
      sun.color.set(0xe6ecf4);
      hemi.color.set(0xd4dae2);
      hemi.groundColor.set(0x55604e);
      hemi.intensity = 1.55;
      envIntensity = 1.0;
      atmosphere.sunColor.set(0.9, 0.92, 0.95);
      atmosphere.hazeColor.set(0.68, 0.71, 0.75);
      atmosphere.hazeDensity = 0.0013;
      atmosphere.hazeGlow = 0.2;
      atmosphere.mistColor.set(0.72, 0.74, 0.76);
      atmosphere.mistDensity = 0.0012;
      atmosphere.mistHeight = 6;
      atmosphere.mistFalloff = 0.07;
      atmosphere.farShadowStrength = 0.16;
      atmosphere.exposure = 0.78;
      atmosphere.bloom = 0.1;
      atmosphere.grain = 0.035;
      atmosphere.saturation = 0.9;
      atmosphere.shadowTint.set(-0.006, 0.0, 0.01);
      atmosphere.ao = 1.15;
      tintWater(s, new THREE.Color(0.5, 0.53, 0.56), new THREE.Color(0.1, 0.12, 0.14));
    }
    // Haze lives in the post pipeline, where it also reaches the sea and
    // anything else drawn by a shader that does not read scene.fog.
    s.fog = null;
    // The world tone maps in its output pass; exposure is applied there from
    // `atmosphere.exposure`, so the renderer's own stays neutral.
    r.toneMappingExposure = 1;
    pmrem ??= new THREE.PMREMGenerator(r);
    envTex?.dispose();
    u.uSunDisc.value = 0;
    envTex = pmrem.fromScene(sky as unknown as THREE.Scene, 0, 1, 20000).texture;
    u.uSunDisc.value = 1;
    s.environment = envTex;
  }
  setWeather("sun", renderer, scene);
  return {
    sky,
    sun,
    hemi,
    envIntensity: () => envIntensity,
    setWeather,
    dispose() {
      offFrame();
      atmosphere.nearLight = null;
      atmosphere.farLight = null;
      envTex?.dispose();
      pmrem?.dispose();
      sun.shadow.dispose();
      far.shadow.dispose();
      sky.material.dispose();
      sky.geometry.dispose();
    },
  };
}
