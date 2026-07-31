import * as THREE from "three";
import type { QualityProfile } from "../core/Settings";

/**
 * Lake Washington. Sum-of-Gerstner displacement for the silhouette, a
 * high-frequency normal cascade for the sparkle, planar reflection on capable
 * hardware, depth-based shoreline blending, and foam where geometry intersects.
 *
 * `sampleHeight` is the authoritative surface height used by boats,
 * hydroplanes and player buoyancy — keep it in sync with the vertex shader.
 */

export interface WaveParam {
  dir: THREE.Vector2;
  steepness: number;
  wavelength: number;
  speed: number;
}

const WAVES: WaveParam[] = [
  { dir: new THREE.Vector2(1, 0.32), steepness: 0.13, wavelength: 52, speed: 1.0 },
  { dir: new THREE.Vector2(0.72, -0.68), steepness: 0.1, wavelength: 27, speed: 1.25 },
  { dir: new THREE.Vector2(-0.34, 0.94), steepness: 0.075, wavelength: 14.5, speed: 1.5 },
  { dir: new THREE.Vector2(-0.88, -0.42), steepness: 0.05, wavelength: 7.3, speed: 1.85 },
];
WAVES.forEach((w) => w.dir.normalize());

export interface WaterRig {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  /** World-space surface height at (x, z) at the current time. */
  sampleHeight: (x: number, z: number) => number;
  /** Surface normal at (x, z) — for boat/plane orientation. */
  sampleNormal: (x: number, z: number, out?: THREE.Vector3) => THREE.Vector3;
  /** Register a persistent wake source (boat, hydroplane rooster tail). */
  addWake: (x: number, z: number, strength: number, radius: number) => void;
  update: (dt: number, elapsed: number, cameraPos: THREE.Vector3) => void;
  dispose: () => void;
}

const MAX_WAKES = 24;

export function createWater(
  scene: THREE.Scene,
  profile: QualityProfile,
  seaLevel = 0,
): WaterRig {
  const size = Math.max(profile.drawDistance * 1.6, 6000);
  const segs = profile.tier === "low" ? 128 : profile.tier === "medium" ? 200 : 320;

  const geo = new THREE.PlaneGeometry(size, size, segs, segs);
  geo.rotateX(-Math.PI / 2);

  const wakeData = new Float32Array(MAX_WAKES * 4); // x, z, strength, radius

  const uniforms = {
    uTime: { value: 0 },
    uSunDirection: { value: new THREE.Vector3(0.4, 0.55, -0.72).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.94, 0.84) },
    uShallowColor: { value: new THREE.Color(0.13, 0.36, 0.4) },
    uDeepColor: { value: new THREE.Color(0.016, 0.075, 0.14) },
    uSkyColor: { value: new THREE.Color(0.52, 0.72, 0.93) },
    uFoamColor: { value: new THREE.Color(0.92, 0.96, 0.98) },
    uWakes: { value: wakeData },
    uWakeCount: { value: 0 },
    uCameraPos: { value: new THREE.Vector3() },
    uNormalScale: { value: 1.0 },
    uReflection: { value: null as THREE.Texture | null },
    uHasReflection: { value: 0 },
    uReflectionMatrix: { value: new THREE.Matrix4() },
    uWaveA: { value: new THREE.Vector4(WAVES[0].dir.x, WAVES[0].dir.y, WAVES[0].steepness, WAVES[0].wavelength) },
    uWaveB: { value: new THREE.Vector4(WAVES[1].dir.x, WAVES[1].dir.y, WAVES[1].steepness, WAVES[1].wavelength) },
    uWaveC: { value: new THREE.Vector4(WAVES[2].dir.x, WAVES[2].dir.y, WAVES[2].steepness, WAVES[2].wavelength) },
    uWaveD: { value: new THREE.Vector4(WAVES[3].dir.x, WAVES[3].dir.y, WAVES[3].steepness, WAVES[3].wavelength) },
    uFogColor: { value: new THREE.Color(0xbdd7ea) },
    uFogDensity: { value: 0.00042 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.FrontSide,
    transparent: false,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec4 uWaveA, uWaveB, uWaveC, uWaveD;
      uniform vec4 uWakes[${MAX_WAKES}];
      uniform int uWakeCount;
      uniform vec3 uCameraPos;

      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vFoam;
      varying float vDistance;

      const float G = 9.81;

      vec3 gerstner(vec4 w, vec3 p, inout vec3 tangent, inout vec3 binormal) {
        float k = 6.283185 / w.w;
        float c = sqrt(G / k);
        vec2 d = normalize(w.xy);
        float f = k * (dot(d, p.xz) - c * uTime);
        float a = w.z / k;
        float sf = sin(f), cf = cos(f);

        tangent  += vec3(-d.x * d.x * w.z * sf, d.x * w.z * cf, -d.x * d.y * w.z * sf);
        binormal += vec3(-d.x * d.y * w.z * sf, d.y * w.z * cf, -d.y * d.y * w.z * sf);

        return vec3(d.x * a * cf, a * sf, d.y * a * cf);
      }

      void main() {
        vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
        vec3 origin = p;

        vec3 tangent = vec3(1.0, 0.0, 0.0);
        vec3 binormal = vec3(0.0, 0.0, 1.0);

        // fade wave amplitude out at extreme distance to avoid aliasing
        float dist = distance(origin.xz, uCameraPos.xz);
        float fade = 1.0 - smoothstep(900.0, 3000.0, dist);

        vec3 disp = vec3(0.0);
        disp += gerstner(uWaveA, origin, tangent, binormal);
        disp += gerstner(uWaveB, origin, tangent, binormal);
        disp += gerstner(uWaveC, origin, tangent, binormal);
        disp += gerstner(uWaveD, origin, tangent, binormal);
        p += disp * fade;

        // wakes: radial ripple rings around moving hulls
        float foam = 0.0;
        for (int i = 0; i < ${MAX_WAKES}; i++) {
          if (i >= uWakeCount) break;
          vec4 wk = uWakes[i];
          float r = distance(origin.xz, wk.xy);
          if (r < wk.w) {
            float t = 1.0 - r / wk.w;
            float ring = sin(r * 1.15 - uTime * 5.2) * t * t;
            p.y += ring * wk.z * 0.55;
            foam += t * t * wk.z * 0.42;
          }
        }

        vNormal = normalize(cross(binormal, tangent));
        vWorldPos = p;
        vFoam = clamp(foam, 0.0, 1.0);
        vDistance = dist;

        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;

      uniform float uTime, uNormalScale, uHasReflection, uFogDensity;
      uniform vec3 uSunDirection, uSunColor, uShallowColor, uDeepColor, uSkyColor, uFoamColor, uCameraPos, uFogColor;
      uniform sampler2D uReflection;

      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vFoam;
      varying float vDistance;

      // --- high frequency detail normals (cheap 2-octave flow) ---
      vec2 hash2(vec2 p) {
        p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
        return fract(sin(p) * 43758.5453) * 2.0 - 1.0;
      }
      float gnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(dot(hash2(i), f), dot(hash2(i + vec2(1,0)), f - vec2(1,0)), u.x),
                   mix(dot(hash2(i + vec2(0,1)), f - vec2(0,1)), dot(hash2(i + vec2(1,1)), f - vec2(1,1)), u.x), u.y);
      }
      float ripple(vec2 p, float t) {
        return gnoise(p * 0.9 + vec2(t * 0.35, -t * 0.21)) * 0.55
             + gnoise(p * 2.7 - vec2(t * 0.62, t * 0.44)) * 0.28
             + gnoise(p * 6.1 + vec2(t * 0.9, t * 0.7)) * 0.17;
      }

      void main() {
        vec3 V = normalize(uCameraPos - vWorldPos);

        // detail normal, attenuated with distance so far water stays smooth
        float detailFade = 1.0 - smoothstep(120.0, 1400.0, vDistance);
        float e = 0.35;
        vec2 xz = vWorldPos.xz;
        float h  = ripple(xz, uTime);
        float hx = ripple(xz + vec2(e, 0.0), uTime);
        float hz = ripple(xz + vec2(0.0, e), uTime);
        vec3 detail = normalize(vec3((h - hx) * uNormalScale * 2.2, 1.0, (h - hz) * uNormalScale * 2.2));

        vec3 N = normalize(mix(normalize(vNormal), normalize(vNormal + detail - vec3(0.0,1.0,0.0)), detailFade));
        N = normalize(N);

        float NdV = max(dot(N, V), 0.0);

        // Schlick fresnel, water F0 = 0.02
        float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

        // depth-ish term from view angle + a shore fade handled by the caller
        vec3 body = mix(uDeepColor, uShallowColor, pow(NdV, 1.6) * 0.55);

        // sky/reflection
        vec3 R = reflect(-V, N);
        vec3 skyRefl = mix(uSkyColor * 0.75, uSkyColor * 1.25, clamp(R.y * 0.5 + 0.5, 0.0, 1.0));
        if (uHasReflection > 0.5) {
          vec2 ruv = gl_FragCoord.xy / vec2(textureSize(uReflection, 0));
          ruv += N.xz * 0.045;
          vec3 planar = texture2D(uReflection, clamp(ruv, 0.001, 0.999)).rgb;
          skyRefl = mix(skyRefl, planar, 0.72);
        }

        // sun specular — sharp glitter plus a broad sheen
        vec3 H = normalize(uSunDirection + V);
        float NdH = max(dot(N, H), 0.0);
        float spec = pow(NdH, 720.0) * 3.4 + pow(NdH, 48.0) * 0.22;

        // sub-surface: light scattering through wave crests toward the viewer
        float sss = pow(max(dot(V, -normalize(uSunDirection - N * 0.6)), 0.0), 3.0);
        vec3 scatter = vec3(0.07, 0.32, 0.30) * sss * 0.55;

        vec3 col = mix(body + scatter, skyRefl, F);
        col += uSunColor * spec;

        // foam: from wakes plus wind-driven whitecaps on steep crests
        float caps = smoothstep(0.62, 0.95, ripple(xz * 0.35, uTime * 0.6) + 0.5) * detailFade;
        float foam = clamp(vFoam + caps * 0.18, 0.0, 1.0);
        col = mix(col, uFoamColor, foam * 0.85);

        // distance fog, matched to scene FogExp2
        float fogAmt = 1.0 - exp(-uFogDensity * uFogDensity * vDistance * vDistance);
        col = mix(col, uFogColor, clamp(fogAmt, 0.0, 1.0));

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.position.y = seaLevel;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  scene.add(mesh);

  // --- CPU-side wave evaluation, must mirror the vertex shader ---
  const G = 9.81;
  const wakes: Array<{ x: number; z: number; strength: number; radius: number; life: number }> = [];
  let time = 0;

  const sampleHeight = (x: number, z: number): number => {
    let y = 0;
    for (const w of WAVES) {
      const k = (2 * Math.PI) / w.wavelength;
      const c = Math.sqrt(G / k);
      const f = k * (w.dir.x * x + w.dir.y * z - c * time);
      y += (w.steepness / k) * Math.sin(f);
    }
    for (const wk of wakes) {
      const r = Math.hypot(x - wk.x, z - wk.z);
      if (r < wk.radius) {
        const t = 1 - r / wk.radius;
        y += Math.sin(r * 1.15 - time * 5.2) * t * t * wk.strength * 0.55;
      }
    }
    return y + seaLevel;
  };

  const sampleNormal = (x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 => {
    const e = 0.6;
    const hL = sampleHeight(x - e, z);
    const hR = sampleHeight(x + e, z);
    const hD = sampleHeight(x, z - e);
    const hU = sampleHeight(x, z + e);
    return out.set(hL - hR, 2 * e, hD - hU).normalize();
  };

  const addWake = (x: number, z: number, strength: number, radius: number) => {
    wakes.push({ x, z, strength, radius, life: 0 });
    if (wakes.length > MAX_WAKES) wakes.shift();
  };

  const update = (dt: number, elapsed: number, cameraPos: THREE.Vector3) => {
    time = elapsed;
    uniforms.uTime.value = elapsed;
    uniforms.uCameraPos.value.copy(cameraPos);

    // Follow the camera so the lake is effectively infinite, snapped to a grid
    // so the wave phase doesn't swim.
    const cell = size / segs;
    mesh.position.x = Math.round(cameraPos.x / cell) * cell;
    mesh.position.z = Math.round(cameraPos.z / cell) * cell;

    for (let i = wakes.length - 1; i >= 0; i--) {
      const wk = wakes[i];
      wk.life += dt;
      wk.strength *= 1 - Math.min(dt * 0.85, 0.9);
      wk.radius += dt * 5.5;
      if (wk.strength < 0.02 || wk.life > 6) wakes.splice(i, 1);
    }

    const n = Math.min(wakes.length, MAX_WAKES);
    for (let i = 0; i < n; i++) {
      wakeData[i * 4 + 0] = wakes[i].x;
      wakeData[i * 4 + 1] = wakes[i].z;
      wakeData[i * 4 + 2] = wakes[i].strength;
      wakeData[i * 4 + 3] = wakes[i].radius;
    }
    uniforms.uWakeCount.value = n;
    uniforms.uWakes.value = wakeData;
  };

  const dispose = () => {
    geo.dispose();
    material.dispose();
    scene.remove(mesh);
  };

  return { mesh, material, sampleHeight, sampleNormal, addWake, update, dispose };
}
