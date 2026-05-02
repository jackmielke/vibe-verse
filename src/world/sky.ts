import * as THREE from "three";

const VERT = /* glsl */ `
  varying vec3 vWorldDir;
  void main() {
    vWorldDir = normalize((modelMatrix * vec4(position, 1.0)).xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vWorldDir;
  uniform vec3 uTopColor;
  uniform vec3 uHorizonColor;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uExposure;
  void main() {
    float h = clamp(vWorldDir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 sky = mix(uHorizonColor, uTopColor, pow(h, 1.4));
    float sun = max(dot(vWorldDir, uSunDir), 0.0);
    sky += uSunColor * pow(sun, 220.0) * 1.6;
    sky += uSunColor * pow(sun, 8.0) * 0.18;
    gl_FragColor = vec4(sky * uExposure, 1.0);
  }
`;

export interface SkyHandles {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  update: (dt: number, manualTime?: number) => void;
  setTimeOfDay: (t: number) => void;
  getTimeOfDay: () => number;
  setAuto: (auto: boolean) => void;
  fog: THREE.Fog;
  getHorizonColor: () => THREE.Color;
}

const TOP_DAY = new THREE.Color("#3aa6c7");
const TOP_DUSK = new THREE.Color("#ff7e6b");
const TOP_NIGHT = new THREE.Color("#0b1430");

const HORIZON_DAY = new THREE.Color("#ffd9a8");
const HORIZON_DUSK = new THREE.Color("#ff5a8a");
const HORIZON_NIGHT = new THREE.Color("#1a2a4a");

const SUN_DAY = new THREE.Color("#fff3c2");
const SUN_DUSK = new THREE.Color("#ffb070");
const SUN_NIGHT = new THREE.Color("#a9c0ff");

function lerpColor(a: THREE.Color, b: THREE.Color, t: number, out: THREE.Color) {
  out.r = a.r + (b.r - a.r) * t;
  out.g = a.g + (b.g - a.g) * t;
  out.b = a.b + (b.b - a.b) * t;
  return out;
}

// timeOfDay is 0..1, 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset
function paletteAt(t: number, top: THREE.Color, horizon: THREE.Color, sun: THREE.Color) {
  // Build 3 keyframes with simple ramps:
  //   night    (0.0)
  //   sunrise  (0.22)
  //   day      (0.5)
  //   sunset   (0.78)
  //   night    (1.0)
  if (t < 0.22) {
    const k = t / 0.22;
    lerpColor(TOP_NIGHT, TOP_DUSK, k, top);
    lerpColor(HORIZON_NIGHT, HORIZON_DUSK, k, horizon);
    lerpColor(SUN_NIGHT, SUN_DUSK, k, sun);
  } else if (t < 0.5) {
    const k = (t - 0.22) / (0.5 - 0.22);
    lerpColor(TOP_DUSK, TOP_DAY, k, top);
    lerpColor(HORIZON_DUSK, HORIZON_DAY, k, horizon);
    lerpColor(SUN_DUSK, SUN_DAY, k, sun);
  } else if (t < 0.78) {
    const k = (t - 0.5) / (0.78 - 0.5);
    lerpColor(TOP_DAY, TOP_DUSK, k, top);
    lerpColor(HORIZON_DAY, HORIZON_DUSK, k, horizon);
    lerpColor(SUN_DAY, SUN_DUSK, k, sun);
  } else {
    const k = (t - 0.78) / (1.0 - 0.78);
    lerpColor(TOP_DUSK, TOP_NIGHT, k, top);
    lerpColor(HORIZON_DUSK, HORIZON_NIGHT, k, horizon);
    lerpColor(SUN_DUSK, SUN_NIGHT, k, sun);
  }
}

export function createSky(scene: THREE.Scene): SkyHandles {
  const group = new THREE.Group();

  const topColor = new THREE.Color();
  const horizonColor = new THREE.Color();
  const sunColor = new THREE.Color();

  // Start at "golden hour" — the era's signature look
  let timeOfDay = 0.74;
  let auto = true;

  const sunDir = new THREE.Vector3(0.4, 0.6, 0.2).normalize();

  const skyMat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTopColor: { value: topColor },
      uHorizonColor: { value: horizonColor },
      uSunColor: { value: sunColor },
      uSunDir: { value: sunDir },
      uExposure: { value: 1.0 },
    },
    side: THREE.BackSide,
    depthWrite: false,
  });
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(1200, 24, 16), skyMat);
  group.add(skyDome);

  // Fog colored to horizon — biggest single trick for the PS2 GTA look
  const fog = new THREE.Fog(new THREE.Color("#ffb088"), 60, 480);
  scene.fog = fog;

  // Sun directional light
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -80;
  sun.shadow.camera.right = 80;
  sun.shadow.camera.top = 80;
  sun.shadow.camera.bottom = -80;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 220;
  sun.shadow.bias = -0.0008;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(0xa9c4ff, 0x2a3a2a, 0.45);
  scene.add(hemi);

  scene.add(group);

  const apply = () => {
    paletteAt(timeOfDay, topColor, horizonColor, sunColor);

    // Sun direction over the day: arc east → up → west
    const angle = (timeOfDay - 0.25) * Math.PI * 2; // sunrise at 0.25
    const sx = Math.cos(angle);
    const sy = Math.sin(angle);
    sunDir.set(sx * 0.9, Math.max(0.05, sy), 0.15).normalize();
    sun.position.copy(sunDir).multiplyScalar(120);

    // Brightness scales with sun height
    const dayness = Math.max(0, sunDir.y);
    sun.intensity = 0.2 + dayness * 1.3;
    hemi.intensity = 0.25 + dayness * 0.45;
    hemi.color.copy(topColor).lerp(new THREE.Color("#ffffff"), 0.3);
    hemi.groundColor.set("#1f2a1f");

    // Fog matches horizon
    fog.color.copy(horizonColor);
    fog.near = 80 - dayness * 20;
    fog.far = 320 + dayness * 220;

    // Sky exposure dims at night
    skyMat.uniforms.uExposure.value = 0.55 + dayness * 0.6;

    // Background color matches fog so the world dissolves into haze
    scene.background = horizonColor.clone();
  };

  apply();

  return {
    group,
    sun,
    hemi,
    fog,
    update(dt) {
      if (auto) {
        // Full cycle every ~6 minutes
        timeOfDay = (timeOfDay + dt / 360) % 1;
      }
      apply();
    },
    setTimeOfDay(t) {
      timeOfDay = ((t % 1) + 1) % 1;
      apply();
    },
    getTimeOfDay: () => timeOfDay,
    setAuto: (a) => {
      auto = a;
    },
    getHorizonColor: () => horizonColor,
  };
}
