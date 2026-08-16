/**
 * The night, as one inverted sphere.
 *
 * Nothing here is geometry: the dome is a unit sphere drawn from the inside
 * with depth writes off, and every pixel is the aurora function, the star
 * field and the moon evaluated along the view ray. It is pinned to the
 * camera each frame, so it is always exactly as far away as the sky is.
 */
import * as THREE from "three";
import { glslLibrary } from "./glsl";

export interface SkyHandle {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  /** Aurora energy, 0..1 — how much of the God-light has been recovered. */
  setEnergy(e: number): void;
  update(time: number, camera: THREE.Camera): void;
  dispose(): void;
}

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  // World-space ray for this vertex. The dome is centred on the camera, so
  // the local position *is* the direction.
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = (lib: string) => /* glsl */ `
precision highp float;
${lib}
uniform float uTime;
uniform float uEnergy;
uniform vec3 uMoonDir;
varying vec3 vDir;

void main() {
  vec3 rd = normalize(vDir);

  // The base sky: deep navy at the zenith, warming very slightly toward the
  // horizon where the last of the dusk still sits under the pines.
  float up = max(rd.y, 0.0);
  vec3 sky = mix(vec3(0.020, 0.031, 0.062), vec3(0.004, 0.007, 0.020), sqrt(up));
  sky += vec3(0.030, 0.045, 0.075) * pow(1.0 - up, 8.0);

  sky += glStars(rd, uTime) * (1.0 - uEnergy * 0.35);
  sky += glMoon(rd, normalize(uMoonDir));
  // The camera sits a metre or two off the ice; the aurora is a kilometre
  // up, so the exact eye height is noise. Origin keeps the parallax honest
  // between the dome and the reflection in the ice without a uniform.
  sky += glAurora(vec3(0.0, 2.0, 0.0), rd, uTime, uEnergy, glDither(gl_FragCoord.xy));

  gl_FragColor = vec4(sky, 1.0);
}
`;

export function buildSky(auroraSteps: number): SkyHandle {
  const material = new THREE.ShaderMaterial({
    name: "GlassLakeSky",
    vertexShader: VERT,
    fragmentShader: FRAG(glslLibrary(auroraSteps)),
    uniforms: {
      uTime: { value: 0 },
      uEnergy: { value: 0 },
      uMoonDir: { value: new THREE.Vector3(-0.42, 0.16, -0.9).normalize() },
    },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), material);
  // Drawn first, and never occluded by anything, so it can sit at radius 1
  // inside the near plane and let every other object win the depth test.
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.name = "sky";

  return {
    mesh,
    material,
    setEnergy(e) {
      material.uniforms.uEnergy.value = e;
    },
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
