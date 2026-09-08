/**
 * Puget Sound light. A physical sky (three's Sky) with the sun where it is over
 * Bainbridge on a September afternoon, run through PMREM so every material sees
 * the same sky for its reflections, plus a soft overcast option because most
 * days here are that. The directional light casts the only shadows.
 */
import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";

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

export function buildSky(scene: THREE.Scene, renderer: THREE.WebGLRenderer): SkyRig {
  const sky = new Sky();
  sky.scale.setScalar(6000);
  scene.add(sky);
  const sun = new THREE.DirectionalLight(0xfff2dc, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 900;
  sun.shadow.camera.left = -220;
  sun.shadow.camera.right = 220;
  sun.shadow.camera.top = 220;
  sun.shadow.camera.bottom = -220;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.06;
  sun.shadow.radius = 2;
  scene.add(sun);
  scene.add(sun.target);
  const hemi = new THREE.HemisphereLight(0xcfd9e6, 0x3d4a2f, 0.5);
  scene.add(hemi);
  let pmrem: THREE.PMREMGenerator | null = null;
  let envTex: THREE.Texture | null = null;
  let envIntensity = 0.55;

  function setWeather(w: Weather, r: THREE.WebGLRenderer, s: THREE.Scene) {
    // Bainbridge, 15:30 in September: sun in the south-west, about 35 degrees up.
    const elevation = w === "sun" ? 35 : 28;
    const azimuth = 225;
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    const dir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    const u = sky.material.uniforms;
    u.sunPosition.value.copy(dir);
    if (w === "sun") {
      u.turbidity.value = 4.5;
      u.rayleigh.value = 2.2;
      u.mieCoefficient.value = 0.006;
      u.mieDirectionalG.value = 0.8;
      sun.intensity = 3.0;
      sun.color.set(0xfff1d6);
      hemi.intensity = 0.45;
      s.fog = new THREE.FogExp2(0xcfd8e2, 0.0011);
    } else {
      u.turbidity.value = 20;
      u.rayleigh.value = 0.6;
      u.mieCoefficient.value = 0.02;
      u.mieDirectionalG.value = 0.95;
      sun.intensity = 1.1;
      sun.color.set(0xe8ecf2);
      hemi.intensity = 0.9;
      s.fog = new THREE.FogExp2(0xc9d0d6, 0.0019);
    }
    sun.position.copy(dir).multiplyScalar(500);
    sun.target.position.set(0, 0, 0);
    pmrem ??= new THREE.PMREMGenerator(r);
    envTex?.dispose();
    envTex = pmrem.fromScene(sky as unknown as THREE.Scene, 0, 1, 20000).texture;
    s.environment = envTex;
    envIntensity = w === "sun" ? 0.55 : 0.8;
  }
  setWeather("sun", renderer, scene);
  return {
    sky,
    sun,
    hemi,
    envIntensity: () => envIntensity,
    setWeather,
    dispose() {
      envTex?.dispose();
      pmrem?.dispose();
      sky.material.dispose();
      sky.geometry.dispose();
    },
  };
}
