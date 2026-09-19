/**
 * The sky: a dome with a shaded gradient, a sun and a moon that travel with
 * the clock, stars that come out as it darkens, an aurora that Vibey can
 * summon, meteors, and a sheet of drifting clouds.
 *
 * Everything the shader needs arrives as uniforms eased by `Magician.ts`, so
 * a change of hour is a change of numbers, not of geometry. No backticks in
 * the GLSL: it is a template literal.
 */
import * as THREE from "three";

export interface SkyLook {
  zenith: THREE.Color;
  horizon: THREE.Color;
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  night: number;
  aurora: number;
  clouds: number;
  meteors: number;
}

export interface Sky {
  group: THREE.Group;
  apply(look: SkyLook): void;
  update(dt: number, time: number, wind: number, windDir: number): void;
  dispose(): void;
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // always at the far plane
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uNight;
uniform float uAurora;
uniform float uTime;
uniform float uClouds;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -0.1, 1.0);
  float t = pow(smoothstep(-0.05, 0.75, up), 0.6);
  vec3 col = mix(uHorizon, uZenith, t);

  // Sun disc and glow.
  float sd = max(0.0, dot(d, uSunDir));
  float glow = pow(sd, 18.0) * 0.55 + pow(sd, 250.0) * 1.8;
  float overcast = smoothstep(0.45, 0.95, uClouds);
  col += uSunColor * glow * (1.0 - uNight * 0.85) * (1.0 - overcast * 0.9);
  // Warm horizon band near the sun when it is low.
  float lowSun = 1.0 - clamp(uSunDir.y * 3.0, 0.0, 1.0);
  col += uSunColor * pow(sd, 3.0) * lowSun * 0.35 * (1.0 - up) * (1.0 - uNight);

  // Stars: a hashed grid, only where it is dark.
  vec2 sp = d.xz / max(0.15, d.y + 0.2);
  vec2 cell = floor(sp * 90.0);
  float h = hash21(cell);
  vec2 f = fract(sp * 90.0) - 0.5;
  float star = smoothstep(0.08, 0.0, length(f)) * step(0.975, h);
  float twinkle = 0.6 + 0.4 * sin(uTime * 3.0 + h * 40.0);
  col += vec3(0.9, 0.95, 1.0) * star * twinkle * uNight * smoothstep(0.0, 0.3, up);

  // Aurora: soft curtains folding above the horizon.
  if (uAurora > 0.001) {
    float band = smoothstep(0.05, 0.25, up) * (1.0 - smoothstep(0.35, 0.8, up));
    float wave = sin(d.x * 6.0 + uTime * 0.35 + sin(d.z * 4.0 + uTime * 0.2) * 1.5);
    float wave2 = sin(d.x * 11.0 - uTime * 0.5 + d.z * 3.0);
    float curtain = smoothstep(0.1, 0.9, 0.5 + 0.5 * wave) * (0.6 + 0.4 * wave2);
    vec3 auroraCol = mix(vec3(0.15, 0.95, 0.55), vec3(0.55, 0.25, 0.95), 0.5 + 0.5 * sin(d.x * 3.0 + uTime * 0.2));
    col += auroraCol * curtain * band * uAurora * (0.35 + 0.65 * uNight);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

export function createSky(): Sky {
  const group = new THREE.Group();
  const uniforms = {
    uZenith: { value: new THREE.Color("#3a7bd5") },
    uHorizon: { value: new THREE.Color("#dbe9f4") },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color("#fff1c9") },
    uNight: { value: 0 },
    uAurora: { value: 0 },
    uTime: { value: 0 },
    uClouds: { value: 0.25 },
  };
  const domeMat = new THREE.ShaderMaterial({ uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(900, 40, 24), domeMat);
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  group.add(dome);

  // Sun and moon sprites, opposite each other.
  const discTex = makeDiscTexture();
  const sunMat = new THREE.SpriteMaterial({ map: discTex, color: "#ffe9a8", transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
  const sun = new THREE.Sprite(sunMat);
  sun.scale.setScalar(26);
  group.add(sun);
  const moonMat = new THREE.SpriteMaterial({ map: discTex, color: "#d8e3ff", transparent: true, depthWrite: false, fog: false });
  const moon = new THREE.Sprite(moonMat);
  moon.scale.setScalar(14);
  group.add(moon);

  // Clouds: flat soft sprites on a high plane, recycled as they drift.
  const cloudTex = makeCloudTexture();
  const cloudMat = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, depthWrite: false, opacity: 0.8, color: "#ffffff" });
  const clouds: THREE.Sprite[] = [];
  const cloudSeeds: number[] = [];
  for (let i = 0; i < 26; i++) {
    const s = new THREE.Sprite(cloudMat);
    const r = 120 + Math.random() * 380;
    const a = Math.random() * Math.PI * 2;
    s.position.set(Math.cos(a) * r, 120 + Math.random() * 60, Math.sin(a) * r);
    const w = 90 + Math.random() * 120;
    s.scale.set(w, w * 0.38, 1);
    clouds.push(s);
    cloudSeeds.push(Math.random());
    group.add(s);
  }

  // Meteors: short streaks that fire from a random point and fall.
  const meteorGeo = new THREE.BufferGeometry();
  const meteorPos = new Float32Array(2 * 3 * 8);
  meteorGeo.setAttribute("position", new THREE.BufferAttribute(meteorPos, 3));
  const meteorMat = new THREE.LineBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.9, fog: false });
  const meteors = new THREE.LineSegments(meteorGeo, meteorMat);
  meteors.frustumCulled = false;
  group.add(meteors);
  const meteorState = Array.from({ length: 8 }, () => ({ t: 99, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0 }));

  let cloudAmount = 0.3;
  let meteorAmount = 0;
  let night = 0;

  return {
    group,
    apply(look) {
      uniforms.uZenith.value.copy(look.zenith);
      uniforms.uHorizon.value.copy(look.horizon);
      uniforms.uSunDir.value.copy(look.sunDir).normalize();
      uniforms.uSunColor.value.copy(look.sunColor);
      uniforms.uNight.value = look.night;
      uniforms.uAurora.value = look.aurora;
      uniforms.uClouds.value = look.clouds;
      night = look.night;
      cloudAmount = look.clouds;
      meteorAmount = look.meteors;
      sun.position.copy(look.sunDir).multiplyScalar(820);
      const overcast = Math.max(0, Math.min(1, (look.clouds - 0.45) / 0.5));
      sunMat.opacity = Math.max(0, look.sunDir.y + 0.08) * 3 * (1 - look.night) * (1 - overcast * 0.92);
      moon.position.copy(look.sunDir).multiplyScalar(-800);
      moon.position.y = Math.max(moon.position.y, 60);
      moonMat.opacity = look.night * 0.95 * (1 - overcast * 0.8);
      cloudMat.color.setRGB(1, 1, 1).lerp(new THREE.Color("#2a2f45"), night * 0.85);
      cloudMat.color.lerp(new THREE.Color("#8d9099"), Math.max(0, (cloudAmount - 0.6)) * 1.2 * (1 - night));
    },
    update(dt, time, wind, windDir) {
      uniforms.uTime.value = time;
      const vx = Math.sin(windDir) * (2 + wind * 14) * dt;
      const vz = Math.cos(windDir) * (2 + wind * 14) * dt;
      for (let i = 0; i < clouds.length; i++) {
        const c = clouds[i];
        c.position.x += vx;
        c.position.z += vz;
        const r = Math.hypot(c.position.x, c.position.z);
        if (r > 560) {
          c.position.x = -c.position.x * 0.9;
          c.position.z = -c.position.z * 0.9;
        }
        const show = cloudSeeds[i] < cloudAmount ? 1 : 0;
        const target = show * (0.55 + cloudAmount * 0.4);
        c.material.opacity += (target - c.material.opacity) * Math.min(1, dt * 0.5);
      }
      // Meteors
      for (let i = 0; i < meteorState.length; i++) {
        const m = meteorState[i];
        m.t += dt;
        if (m.t > 1.2 && meteorAmount > 0 && Math.random() < meteorAmount * dt * 0.9) {
          const a = Math.random() * Math.PI * 2;
          m.x = Math.cos(a) * 500; m.z = Math.sin(a) * 500; m.y = 320 + Math.random() * 200;
          m.dx = -Math.cos(a) * 260 + (Math.random() - 0.5) * 120; m.dz = -Math.sin(a) * 260; m.dy = -220 - Math.random() * 100;
          m.t = 0;
        }
        const alive = m.t < 1.2 ? 1 : 0;
        const x = m.x + m.dx * m.t, y = m.y + m.dy * m.t, z = m.z + m.dz * m.t;
        const len = 0.09;
        meteorPos.set([x, y, z, x - m.dx * len * alive, y - m.dy * len * alive, z - m.dz * len * alive], i * 6);
        if (!alive) meteorPos.set([0, -1000, 0, 0, -1000, 0], i * 6);
      }
      (meteorGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      meteorMat.opacity = 0.5 + night * 0.5;
    },
    dispose() {
      dome.geometry.dispose();
      domeMat.dispose();
      discTex.dispose();
      cloudTex.dispose();
      sunMat.dispose();
      moonMat.dispose();
      cloudMat.dispose();
      meteorGeo.dispose();
      meteorMat.dispose();
    },
  };
}

function makeDiscTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.9)");
  g.addColorStop(0.6, "rgba(255,255,255,0.25)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeCloudTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 256, 128);
  for (let i = 0; i < 26; i++) {
    const x = 30 + Math.random() * 196;
    const y = 40 + Math.random() * 50;
    const r = 18 + Math.random() * 30;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255,255,255,0.55)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Make a small soft round sprite texture for particles. */
export function makeSoftDot(color = "#ffffff"): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, color);
  g.addColorStop(0.5, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
