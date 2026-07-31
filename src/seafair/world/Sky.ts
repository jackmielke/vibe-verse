import * as THREE from "three";
import type { QualityProfile } from "../core/Settings";

/**
 * Physically-motivated sky: Preetham-style analytic scattering on a hemisphere
 * dome, a sun disc with limb darkening, layered procedural cumulus, and the
 * matching light rig (key sun + sky hemi + bounce). Sunny Seattle August
 * afternoon: high sun, deep blue zenith, hazy horizon over the lake.
 */

const SkyShader = {
  uniforms: {
    uSunDirection: { value: new THREE.Vector3(0.4, 0.55, -0.72).normalize() },
    uRayleigh: { value: 1.45 },
    uTurbidity: { value: 2.6 },
    uMieCoefficient: { value: 0.0045 },
    uMieDirectionalG: { value: 0.82 },
    uTime: { value: 0 },
    uCloudCover: { value: 0.34 },
    uCloudSharpness: { value: 0.55 },
    uHorizonHaze: { value: new THREE.Color(0.72, 0.83, 0.95) },
    uExposure: { value: 0.42 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vWorldPosition;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPosition = wp.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_Position.z = gl_Position.w; // force to far plane
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec3 vWorldPosition;

    uniform vec3 uSunDirection;
    uniform float uRayleigh, uTurbidity, uMieCoefficient, uMieDirectionalG;
    uniform float uTime, uCloudCover, uCloudSharpness, uExposure;
    uniform vec3 uHorizonHaze;

    const float PI = 3.141592653589793;
    const vec3 lambda = vec3(680e-9, 550e-9, 450e-9);
    const vec3 K = vec3(0.686, 0.678, 0.666);
    const float v = 4.0;
    const float n = 1.0003;
    const float N = 2.545e25;
    const float pn = 0.035;

    vec3 totalRayleigh(vec3 l) {
      return (8.0 * pow(PI, 3.0) * pow(n * n - 1.0, 2.0) * (6.0 + 3.0 * pn)) /
             (3.0 * N * pow(l, vec3(4.0)) * (6.0 - 7.0 * pn));
    }

    vec3 totalMie(vec3 l, vec3 k, float T) {
      float c = 0.2 * T * 10e-18;
      return 0.434 * c * PI * pow((2.0 * PI) / l, vec3(v - 2.0)) * k;
    }

    float rayleighPhase(float cosT) { return (3.0 / (16.0 * PI)) * (1.0 + pow(cosT, 2.0)); }

    float hgPhase(float cosT, float g) {
      float g2 = pow(g, 2.0);
      float inv = 1.0 / max(1e-4, pow(1.0 - 2.0 * g * cosT + g2, 1.5));
      return (1.0 / (4.0 * PI)) * ((1.0 - g2) * inv);
    }

    // --- procedural clouds ---
    float hash(vec3 p) {
      p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float vnoise(vec3 x) {
      vec3 i = floor(x); vec3 f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                     mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                 mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                     mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
    }
    float fbm(vec3 p) {
      float s = 0.0, a = 0.5;
      for (int i = 0; i < 6; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
      return s;
    }

    void main() {
      vec3 dir = normalize(vWorldPosition);
      float up = max(dir.y, 0.0);

      // --- analytic scattering ---
      float sunE = 1000.0;
      vec3 betaR = totalRayleigh(lambda) * uRayleigh;
      vec3 betaM = totalMie(lambda, K, uTurbidity) * uMieCoefficient;

      float zenithAngle = acos(max(0.0, dot(vec3(0.0, 1.0, 0.0), dir)));
      float inv = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - (zenithAngle * 180.0 / PI), -1.253));
      float sR = 8.4e3 * inv;
      float sM = 1.25e3 * inv;

      vec3 Fex = exp(-(betaR * sR + betaM * sM));

      float cosTheta = dot(dir, uSunDirection);
      vec3 betaRTheta = betaR * rayleighPhase(cosTheta * 0.5 + 0.5);
      vec3 betaMTheta = betaM * hgPhase(cosTheta, uMieDirectionalG);

      float sunfade = 1.0 - clamp(1.0 - exp(uSunDirection.y), 0.0, 1.0);
      vec3 Lin = pow(sunE * ((betaRTheta + betaMTheta) / (betaR + betaM)) * (1.0 - Fex),
                     vec3(1.5));
      Lin *= mix(vec3(1.0),
                 pow(sunE * ((betaRTheta + betaMTheta) / (betaR + betaM)) * Fex, vec3(0.5)),
                 clamp(pow(1.0 - dot(vec3(0.0,1.0,0.0), uSunDirection), 5.0), 0.0, 1.0));

      // sun disc with soft limb
      float sunAngular = 0.9998;
      float sundisk = smoothstep(sunAngular, sunAngular + 0.00006, cosTheta);
      vec3 L0 = vec3(0.1) * Fex + sunE * 19000.0 * Fex * sundisk;

      vec3 col = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
      col = pow(col * uExposure, vec3(1.0 / (1.2 + 1.2 * sunfade)));

      // --- clouds on a virtual plane at 2200m ---
      if (dir.y > 0.008) {
        float t = 2200.0 / dir.y;
        vec3 cp = dir * t * 0.00042;
        cp.xz += uTime * vec2(0.0045, 0.0022);
        float d = fbm(cp * 1.4);
        float d2 = fbm(cp * 3.1 + 11.3);
        float cloud = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + uCloudSharpness, d * 0.75 + d2 * 0.25);
        // fade with distance to horizon
        cloud *= smoothstep(0.008, 0.14, dir.y);
        // cheap self-shadow: sample toward the sun
        float lit = fbm((cp + uSunDirection * 0.06) * 1.4);
        float shade = clamp(0.55 + (d - lit) * 2.4, 0.35, 1.0);
        vec3 cloudCol = mix(vec3(0.52, 0.57, 0.66), vec3(1.06, 1.03, 0.99), shade);
        // silver lining near the sun
        cloudCol += pow(max(cosTheta, 0.0), 24.0) * 0.75;
        col = mix(col, cloudCol, cloud * 0.92);
      }

      // horizon haze band over Lake Washington
      float haze = pow(1.0 - clamp(up * 5.2, 0.0, 1.0), 2.6);
      col = mix(col, uHorizonHaze * (0.72 + 0.4 * pow(max(cosTheta, 0.0), 3.0)), haze * 0.62);

      // subtle dithering to kill banding in the gradient
      float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      col += dither * 0.0025;

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export interface SkyRig {
  mesh: THREE.Mesh;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  bounce: THREE.DirectionalLight;
  sunDirection: THREE.Vector3;
  update: (dt: number, elapsed: number, cameraPos: THREE.Vector3) => void;
  setSunElevation: (deg: number, azimuthDeg: number) => void;
}

export function createSky(scene: THREE.Scene, profile: QualityProfile): SkyRig {
  const uniforms = THREE.UniformsUtils.clone(SkyShader.uniforms);

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SkyShader.vertexShader,
    fragmentShader: SkyShader.fragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), mat);
  mesh.scale.setScalar(profile.drawDistance * 0.92);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  scene.add(mesh);

  const sunDirection = new THREE.Vector3();

  // Key light — the sun. Warm, high, strong.
  const sun = new THREE.DirectionalLight(0xfff2dd, 3.35);
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

  // Sky fill — blue from above, lake-reflected green-blue from below.
  const hemi = new THREE.HemisphereLight(0x9ccdf5, 0x4a6b62, 1.05);
  scene.add(hemi);

  // Bounce light off the water, cool and low-intensity.
  const bounce = new THREE.DirectionalLight(0x8fc4e0, 0.42);
  bounce.position.set(-0.4, -0.5, 0.6);
  scene.add(bounce);

  scene.fog = new THREE.FogExp2(0xbdd7ea, 0.00042);

  const setSunElevation = (elevationDeg: number, azimuthDeg: number) => {
    const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
    const theta = THREE.MathUtils.degToRad(azimuthDeg);
    sunDirection.setFromSphericalCoords(1, phi, theta);
    uniforms.uSunDirection.value.copy(sunDirection);
    sun.position.copy(sunDirection).multiplyScalar(400);

    // Grade the key light colour with elevation — golden near the horizon.
    const t = THREE.MathUtils.clamp(elevationDeg / 55, 0, 1);
    sun.color.setRGB(
      THREE.MathUtils.lerp(1.0, 1.0, t),
      THREE.MathUtils.lerp(0.78, 0.95, t),
      THREE.MathUtils.lerp(0.55, 0.87, t),
    );
    sun.intensity = THREE.MathUtils.lerp(1.4, 3.5, t);
    hemi.intensity = THREE.MathUtils.lerp(0.55, 1.1, t);
  };

  // Seafair: early August, ~3pm, sun high in the south-west.
  setSunElevation(52, 118);

  const update = (_dt: number, elapsed: number, cameraPos: THREE.Vector3) => {
    uniforms.uTime.value = elapsed;
    mesh.position.copy(cameraPos);
    // Keep the shadow frustum centred on the player so it stays crisp.
    sun.target.position.copy(cameraPos);
    sun.position.copy(cameraPos).addScaledVector(sunDirection, 380);
    sun.target.updateMatrixWorld();
  };

  return { mesh, sun, hemi, bounce, sunDirection, update, setSunElevation };
}
