/**
 * The sky over Vibe Summit: a gradient dome with a sun, a deck of clouds
 * below the Skyway, and stars that come out the higher you climb.
 *
 * `space` (0..1) is altitude driven: on the mountain it is a bright alpine
 * blue, and up on the Prism Skyway the dome deepens to violet and the stars
 * show, so the rainbow road reads as being somewhere else entirely.
 */
import * as THREE from "three";

export interface Sky {
  group: THREE.Group;
  clouds: THREE.Group;
  update(camera: THREE.Camera, space: number, t: number): void;
  horizon: THREE.Color;
  sunDir: THREE.Vector3;
  dispose(): void;
}

export function buildSky(): Sky {
  const group = new THREE.Group();
  const sunDir = new THREE.Vector3(-0.45, 0.42, 0.78).normalize();

  const uniforms = {
    uSpace: { value: 0 },
    uSun: { value: sunDir.clone() },
    uTime: { value: 0 },
  };
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(9000, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * p;
          gl_Position.z = gl_Position.w * 0.9999;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uSpace;
        uniform vec3 uSun;
        uniform float uTime;
        varying vec3 vDir;
        float h21(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
        void main() {
          vec3 d = normalize(vDir);
          float up = clamp(d.y, -0.2, 1.0);
          vec3 dayTop = vec3(0.20, 0.45, 0.86);
          vec3 dayHor = vec3(0.78, 0.88, 0.98);
          vec3 nightTop = vec3(0.07, 0.03, 0.20);
          vec3 nightHor = vec3(0.55, 0.30, 0.62);
          float k = pow(max(up, 0.0), 0.55);
          vec3 day = mix(dayHor, dayTop, k);
          vec3 night = mix(nightHor, nightTop, k);
          vec3 col = mix(day, night, uSpace);
          float s = max(dot(d, uSun), 0.0);
          col += vec3(1.0, 0.92, 0.75) * (pow(s, 900.0) * 6.0 + pow(s, 12.0) * 0.18) * (1.0 - 0.6 * uSpace);
          // Stars, only once you are high.
          vec2 cell = floor(vec2(atan(d.z, d.x) * 180.0, d.y * 260.0));
          float st = h21(cell);
          float tw = 0.6 + 0.4 * sin(uTime * 2.0 + st * 40.0);
          col += vec3(1.0) * step(0.9965, st) * smoothstep(0.0, 0.25, up) * uSpace * tw * 1.4;
          // A faint ribbon of aurora-ish colour high in the space sky.
          float band = exp(-pow((d.y - 0.42 - 0.05 * sin(atan(d.z, d.x) * 3.0 + uTime * 0.1)) * 9.0, 2.0));
          col += vec3(0.2, 0.9, 0.6) * band * 0.25 * uSpace;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  group.add(dome);

  // ---- Clouds: soft sprites in a deck at about 2,100 m -------------------
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  for (let i = 0; i < 9; i++) {
    const x = 30 + Math.random() * 68, y = 44 + Math.random() * 40, r = 22 + Math.random() * 24;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, "rgba(255,255,255,0.95)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
  }
  const cloudTex = new THREE.CanvasTexture(c);
  cloudTex.colorSpace = THREE.SRGBColorSpace;
  const cloudMat = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, depthWrite: false, fog: false, opacity: 0.9 });
  const clouds = new THREE.Group();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    const s = new THREE.Sprite(cloudMat);
    const a = rnd() * Math.PI * 2, r = 400 + rnd() * 3800;
    s.position.set(Math.cos(a) * r, 2050 + rnd() * 220, Math.sin(a) * r - 600);
    const k = 380 + rnd() * 520;
    s.scale.set(k * 1.8, k * 0.8, 1);
    clouds.add(s);
  }
  group.add(clouds);

  const horizon = new THREE.Color();
  const dayHor = new THREE.Color(0.80, 0.88, 0.97);
  const nightHor = new THREE.Color(0.38, 0.22, 0.48);

  return {
    group,
    clouds,
    sunDir,
    horizon,
    update(camera, space, t) {
      dome.position.copy(camera.position);
      uniforms.uSpace.value = space;
      uniforms.uTime.value = t;
      horizon.copy(dayHor).lerp(nightHor, space);
      cloudMat.color.setRGB(1 - space * 0.25, 1 - space * 0.35, 1 - space * 0.1);
    },
    dispose() {
      dome.geometry.dispose();
      (dome.material as THREE.Material).dispose();
      cloudTex.dispose();
      cloudMat.dispose();
    },
  };
}
