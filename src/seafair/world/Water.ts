import * as THREE from "three";
import type { QualityProfile } from "../core/Settings";

/**
 * Lake Washington.
 *
 * The lake fills most of the frame from most of the playable area, so it is
 * built like a hero surface:
 *
 *  - a camera-centred radial grid, so tessellation is sub-metre at your feet
 *    and tens of metres at the horizon instead of one uniform 35 m lattice;
 *  - sum-of-Gerstner displacement for the silhouette, faded out per wave band
 *    once the grid can no longer resolve that wavelength;
 *  - a three-scale detail-normal cascade, each octave attenuated against the
 *    world-space pixel footprint, with the slope variance it loses folded back
 *    into the specular roughness (Toksvig / LEAN style). That is what stops the
 *    distant lake boiling into white pixel noise;
 *  - a real microfacet sun response, so the glitter forms a long scattered path
 *    toward the sun rather than one blown dot;
 *  - depth-driven absorption from a baked bathymetry map: green-brown and
 *    translucent over the shoals, dark blue-green offshore, with the shoreline
 *    softened by alpha rather than a geometric seam.
 *
 * `sampleHeight` is the authoritative surface height used by boats,
 * hydroplanes and player buoyancy. It inverts the Gerstner horizontal
 * displacement and applies the same per-band distance fade as the vertex
 * shader, so what floats matches what you see.
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

/**
 * A wave band is faded out once the radial grid stops resolving it: cell size
 * grows linearly with range, so the cutoff is a multiple of the wavelength.
 */
const FADE_NEAR = 14;
const FADE_FAR = 40;

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

/** Metres of water column the bathymetry map can encode. */
const BED_MAX_DEPTH = 48;
/** Half-extent of the baked bathymetry map, in metres. */
const BED_EXTENT = 1800;

const sstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Fallback bathymetry, used when the caller has no terrain sampler to hand.
 * Mirrors the gross shape of the Genesee shoreline: the pit apron sits just
 * above the waterline, the bed drops away going -Z into the lake.
 */
const defaultBedHeight = (x: number, z: number): number => {
  const inland = sstep(-20, 420, z);
  let h = -9 + inland * 11.2;

  const padX = sstep(0, 0.35, 1 - Math.abs(x) / 190);
  const padZ = sstep(0, 0.4, 1 - Math.abs(z - 60) / 110);
  h = h + (2.4 - h) * padX * padZ * 0.94;

  h -= sstep(20, 700, -z) * 34;
  return h;
};

/**
 * Radial grid centred on the camera: ring radii grow geometrically, so the
 * cell size is a constant fraction of range. Sub-metre chop near the player,
 * cheap geometry at the horizon, no LOD popping.
 */
function radialGrid(rings: number, spokes: number, rMin: number, rMax: number): THREE.BufferGeometry {
  const cols = spokes + 1; // duplicated seam column keeps the index buffer trivial
  const pos = new Float32Array((rings + 1) * cols * 3);
  const ratio = Math.pow(rMax / rMin, 1 / (rings - 1));

  let p = 0;
  for (let i = 0; i <= rings; i++) {
    // Ring 0 collapses to the origin so the disc has no hole under the camera.
    const r = i === 0 ? 0 : rMin * Math.pow(ratio, i - 1);
    for (let j = 0; j < cols; j++) {
      const a = (j / spokes) * Math.PI * 2;
      pos[p++] = Math.cos(a) * r;
      pos[p++] = 0;
      pos[p++] = Math.sin(a) * r;
    }
  }

  const idx = new Uint32Array(rings * spokes * 6);
  let k = 0;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < spokes; j++) {
      const a = i * cols + j;
      const b = a + cols;
      idx[k++] = a;
      idx[k++] = b;
      idx[k++] = a + 1;
      idx[k++] = a + 1;
      idx[k++] = b;
      idx[k++] = b + 1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), rMax);
  return geo;
}

/** 8-bit bathymetry map. Depth is stored square-rooted for precision in the shallows. */
function bakeBedTexture(size: number, bedHeight: (x: number, z: number) => number, seaLevel: number) {
  const data = new Uint8Array(size * size);
  const step = (BED_EXTENT * 2) / (size - 1);
  for (let j = 0; j < size; j++) {
    const z = -BED_EXTENT + j * step;
    for (let i = 0; i < size; i++) {
      const x = -BED_EXTENT + i * step;
      const d = Math.min(1, Math.max(0, (seaLevel - bedHeight(x, z)) / BED_MAX_DEPTH));
      data[j * size + i] = Math.round(Math.sqrt(d) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export function createWater(
  scene: THREE.Scene,
  profile: QualityProfile,
  seaLevel = 0,
  bedHeight: (x: number, z: number) => number = defaultBedHeight,
): WaterRig {
  // Reach past the far plane: the disc edge is then clipped rather than
  // showing as a horizon seam. Fog has saturated long before it.
  const radius = Math.max(profile.drawDistance * 1.3, 6000);
  const rings = profile.tier === "low" ? 96 : profile.tier === "medium" ? 160 : 256;
  const spokes = profile.tier === "low" ? 96 : profile.tier === "medium" ? 160 : 256;

  const geo = radialGrid(rings, spokes, 0.45, radius);

  const bedTex = bakeBedTexture(
    Math.min(512, Math.max(128, profile.textureSize)),
    bedHeight,
    seaLevel,
  );

  const wakeData = new Float32Array(MAX_WAKES * 4); // x, z, strength, radius
  const wakeFoam = new Float32Array(MAX_WAKES);

  const uniforms = {
    uTime: { value: 0 },
    uSunDirection: { value: new THREE.Vector3(0.54, 0.79, -0.29).normalize() },
    // Sun colour and irradiance in the same linear units as the sky below;
    // the scene is graded by ACES at the end of the post chain.
    uSunColor: { value: new THREE.Color(1.0, 0.93, 0.82) },
    uSunIntensity: { value: 13.0 },
    uZenithColor: { value: new THREE.Color(0.085, 0.20, 0.50) },
    uHorizonColor: { value: new THREE.Color(0.70, 0.82, 0.99) },
    uSkyIntensity: { value: 1.25 },
    // Beer-Lambert absorption per metre of lake water. Green survives
    // longest — Lake Washington is a green lake, not a tropical blue one.
    uAbsorb: { value: new THREE.Vector3(0.58, 0.16, 0.24) },
    uScatterColor: { value: new THREE.Color(0.055, 0.155, 0.135) },
    uShallowColor: { value: new THREE.Color(0.13, 0.19, 0.10) },
    uSssColor: { value: new THREE.Color(0.09, 0.30, 0.16) },
    uFoamColor: { value: new THREE.Color(0.92, 0.96, 0.98) },
    uWakes: { value: wakeData },
    uWakeFoam: { value: wakeFoam },
    uWakeCount: { value: 0 },
    uCameraPos: { value: new THREE.Vector3() },
    uNormalScale: { value: 1.0 },
    uRoughness: { value: 0.038 },
    uVarianceGain: { value: 1.35 },
    uWindStrength: { value: 1.0 },
    uReflection: { value: null as THREE.Texture | null },
    uHasReflection: { value: 0 },
    uReflectionMatrix: { value: new THREE.Matrix4() },
    uWaveA: { value: new THREE.Vector4(WAVES[0].dir.x, WAVES[0].dir.y, WAVES[0].steepness, WAVES[0].wavelength) },
    uWaveB: { value: new THREE.Vector4(WAVES[1].dir.x, WAVES[1].dir.y, WAVES[1].steepness, WAVES[1].wavelength) },
    uWaveC: { value: new THREE.Vector4(WAVES[2].dir.x, WAVES[2].dir.y, WAVES[2].steepness, WAVES[2].wavelength) },
    uWaveD: { value: new THREE.Vector4(WAVES[3].dir.x, WAVES[3].dir.y, WAVES[3].steepness, WAVES[3].wavelength) },
    uFogColor: { value: new THREE.Color(0xbdd7ea) },
    uFogDensity: { value: 0.00042 },
    uBedMap: { value: bedTex },
    uBedExtent: { value: BED_EXTENT },
    uBedMaxDepth: { value: BED_MAX_DEPTH },
    uSeaLevel: { value: seaLevel },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    defines: {
      DETAIL_OCTAVES: profile.tier === "low" ? 2 : 3,
      FADE_NEAR: FADE_NEAR.toFixed(1),
      FADE_FAR: FADE_FAR.toFixed(1),
    },
    side: THREE.FrontSide,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: true,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec4 uWaveA, uWaveB, uWaveC, uWaveD;
      uniform vec4 uWakes[${MAX_WAKES}];
      uniform float uWakeFoam[${MAX_WAKES}];
      uniform int uWakeCount;
      uniform vec3 uCameraPos;

      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vFoam;
      varying float vDistance;
      varying float vCrest;

      const float G = 9.81;

      vec3 gerstner(vec4 w, vec2 p, float fade, inout vec3 tangent, inout vec3 binormal,
                    inout vec3 jac) {
        float k = 6.283185 / w.w;
        float c = sqrt(G / k);
        vec2 d = normalize(w.xy);
        float f = k * (dot(d, p) - c * uTime);
        float steep = w.z * fade;
        float a = steep / k;
        float sf = sin(f), cf = cos(f);

        // Fading amplitude and slope together keeps the shaded normal honest.
        tangent  += vec3(-d.x * d.x * steep * sf, d.x * steep * cf, -d.x * d.y * steep * sf);
        binormal += vec3(-d.x * d.y * steep * sf, d.y * steep * cf, -d.y * d.y * steep * sf);
        jac += vec3(-d.x * d.x * steep * sf, -d.y * d.y * steep * sf, -d.x * d.y * steep * sf);

        return vec3(d.x * a * cf, a * sf, d.y * a * cf);
      }

      float bandFade(float wavelength, float dist) {
        return 1.0 - smoothstep(wavelength * FADE_NEAR, wavelength * FADE_FAR, dist);
      }

      void main() {
        vec3 origin = (modelMatrix * vec4(position, 1.0)).xyz;
        float dist = distance(origin.xz, uCameraPos.xz);

        vec3 tangent = vec3(1.0, 0.0, 0.0);
        vec3 binormal = vec3(0.0, 0.0, 1.0);

        vec3 jac = vec3(0.0);
        vec3 p = origin;
        p += gerstner(uWaveA, origin.xz, bandFade(uWaveA.w, dist), tangent, binormal, jac);
        p += gerstner(uWaveB, origin.xz, bandFade(uWaveB.w, dist), tangent, binormal, jac);
        p += gerstner(uWaveC, origin.xz, bandFade(uWaveC.w, dist), tangent, binormal, jac);
        p += gerstner(uWaveD, origin.xz, bandFade(uWaveD.w, dist), tangent, binormal, jac);

        // Horizontal compression of the Gerstner map — the crests where a real
        // wave would break and throw whitecaps.
        float jacobian = (1.0 + jac.x) * (1.0 + jac.y) - jac.z * jac.z;
        vCrest = clamp(1.0 - jacobian, 0.0, 1.0);

        float foam = 0.0;
        for (int i = 0; i < ${MAX_WAKES}; i++) {
          if (i >= uWakeCount) break;
          vec4 wk = uWakes[i];
          float r = distance(origin.xz, wk.xy);
          if (r < wk.w) {
            float t = 1.0 - r / wk.w;
            float ring = sin(r * 1.15 - uTime * 5.2) * t * t;
            p.y += ring * wk.z * 0.55;
            foam += t * t * uWakeFoam[i];
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
      uniform float uSunIntensity, uSkyIntensity, uRoughness, uVarianceGain, uWindStrength;
      uniform float uBedExtent, uBedMaxDepth, uSeaLevel;
      uniform vec3 uSunDirection, uSunColor, uZenithColor, uHorizonColor;
      uniform vec3 uAbsorb, uScatterColor, uShallowColor, uSssColor, uFoamColor;
      uniform vec3 uCameraPos, uFogColor;
      uniform sampler2D uReflection;
      uniform sampler2D uBedMap;

      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vFoam;
      varying float vDistance;
      varying float vCrest;

      const float PI = 3.141592653589793;

      vec2 hash2(vec2 p) {
        p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
        return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
      }

      /** Gradient noise with analytic derivative: (value, d/dx, d/dy). */
      vec3 noised(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
        vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

        vec2 ga = hash2(i), gb = hash2(i + vec2(1.0, 0.0));
        vec2 gc = hash2(i + vec2(0.0, 1.0)), gd = hash2(i + vec2(1.0, 1.0));

        float va = dot(ga, f);
        float vb = dot(gb, f - vec2(1.0, 0.0));
        float vc = dot(gc, f - vec2(0.0, 1.0));
        float vd = dot(gd, f - vec2(1.0, 1.0));

        float v = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd);
        vec2 g = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
               + du * (vec2(u.y, u.x) * (va - vb - vc + vd) + vec2(vb, vc) - va);
        return vec3(v, g);
      }

      /**
       * One band of wind chop. The amplitude is expressed as a slope, so octaves
       * sum straight into the surface gradient. Anything finer than the pixel
       * footprint is dropped and its slope variance handed to the roughness —
       * filtering the specular instead of letting it alias.
       */
      void chop(vec2 xz, float invL, float amp, vec2 flow, float fp,
                inout vec2 slope, inout float lostVar) {
        float atten = 1.0 - smoothstep(0.16, 0.60, fp * invL);
        if (atten > 0.004) {
          vec3 n = noised(xz * invL + flow * uTime);
          slope += n.yz * (amp * atten);
        }
        lostVar += (1.0 - atten * atten) * amp * amp * 0.5;
      }

      /** Clumped foam coverage; loses its texture into a flat wash as it goes sub-pixel. */
      float foamTexture(vec2 xz, float fp) {
        float a1 = 1.0 - smoothstep(0.16, 0.60, fp * 0.22);
        float a2 = 1.0 - smoothstep(0.16, 0.60, fp * 0.9);
        float n = 0.5;
        n += noised(xz * 0.22 + vec2(0.05, -0.03) * uTime).x * 0.62 * a1;
        n += noised(xz * 0.9 - vec2(0.09, 0.06) * uTime).x * 0.38 * a2;
        return clamp(n, 0.0, 1.0);
      }

      /**
       * Analytic sky radiance for reflections and aerial perspective. Same
       * linear scale as the rest of the frame — the horizon sits near 1.0 so
       * ACES lands it just under white instead of clipping.
       */
      vec3 skyRadiance(vec3 dir, float rough) {
        float y = max(dir.y, 0.0);
        float t = pow(1.0 - y, 5.0);
        vec3 col = mix(uZenithColor, uHorizonColor, t);

        float cosT = max(dot(dir, uSunDirection), 0.0);
        float glow = mix(9.0, 2.0, clamp(rough * 3.0, 0.0, 1.0));
        col += uSunColor * (0.42 * pow(cosT, glow) + 0.11 * pow(cosT, 2.0)) * (0.3 + 0.7 * t);

        // Below the horizon a wave face sees haze and the far shore, not sky.
        col = mix(uHorizonColor * 0.55, col, smoothstep(-0.09, 0.015, dir.y));
        return col * uSkyIntensity;
      }

      float D_GGX(float NdH, float a) {
        float a2 = a * a;
        float d = NdH * NdH * (a2 - 1.0) + 1.0;
        return a2 / max(PI * d * d, 1e-7);
      }

      float V_SmithGGX(float NdV, float NdL, float a) {
        float a2 = a * a;
        float lv = NdL * sqrt(NdV * NdV * (1.0 - a2) + a2);
        float ll = NdV * sqrt(NdL * NdL * (1.0 - a2) + a2);
        return 0.5 / max(lv + ll, 1e-5);
      }

      float bedDepth(vec2 xz) {
        vec2 uv = xz / (2.0 * uBedExtent) + 0.5;
        float s = texture2D(uBedMap, clamp(uv, 0.0, 1.0)).r;
        return s * s * uBedMaxDepth;
      }

      void main() {
        vec3 P = vWorldPos;
        vec3 V = normalize(uCameraPos - P);
        vec3 L = normalize(uSunDirection);

        // World-space size of this pixel. Every filtering decision keys off it.
        vec2 ddx = dFdx(P.xz), ddy = dFdy(P.xz);
        float fp = max(length(ddx), length(ddy));

        // --- detail normal cascade: swell, wind chop, capillary ---
        vec2 slope = vec2(0.0);
        float lostVar = 0.0;
        float w = uWindStrength;
        chop(P.xz, 1.0 / 17.0, 0.085 * w, vec2(0.05, 0.02), fp, slope, lostVar);
        chop(P.xz, 1.0 / 4.3,  0.115 * w, vec2(-0.13, 0.07), fp, slope, lostVar);
        #if DETAIL_OCTAVES > 2
        chop(P.xz, 1.0 / 1.15, 0.105 * w, vec2(0.21, 0.28), fp, slope, lostVar);
        #endif

        vec3 geoN = normalize(vNormal);
        vec2 geoSlope = -geoN.xz / max(geoN.y, 0.05);
        vec2 total = geoSlope + slope * uNormalScale;
        vec3 N = normalize(vec3(-total.x, 1.0, -total.y));

        // Roughness = base + the slope variance we just filtered away + the
        // variance of the interpolated mesh normal itself. This is the whole
        // reason distant water settles instead of flickering.
        vec2 gfw = fwidth(geoSlope);
        float sigma2 = lostVar * uVarianceGain + dot(gfw, gfw) * 0.10;
        float alpha = clamp(sqrt(uRoughness * uRoughness + 2.0 * sigma2), 0.012, 0.85);

        float NdV = clamp(dot(N, V), 1e-3, 1.0);
        float NdL = clamp(dot(N, L), 0.0, 1.0);

        // Roughness-aware Fresnel: a hazy surface never reaches mirror at grazing.
        float F0 = 0.02;
        float F = F0 + (max(1.0 - alpha, F0) - F0) * pow(1.0 - NdV, 5.0);

        // --- reflection ---
        vec3 R = reflect(-V, N);
        R.y = max(R.y, 0.006);
        vec3 refl = skyRadiance(R, alpha);
        if (uHasReflection > 0.5) {
          vec2 ruv = gl_FragCoord.xy / vec2(textureSize(uReflection, 0));
          ruv += N.xz * 0.045;
          vec3 planar = texture2D(uReflection, clamp(ruv, 0.001, 0.999)).rgb;
          refl = mix(refl, planar, 0.72 * (1.0 - alpha));
        }

        // --- sun: microfacet specular, widened by the solar disc ---
        vec3 H = normalize(L + V);
        float NdH = clamp(dot(N, H), 0.0, 1.0);
        // 0.0047 rad ≈ the sun's angular radius; below it the highlight is a
        // disc image, not a delta, so widen and renormalise energy.
        float aSun = clamp(alpha + 0.0047, 0.006, 1.0);
        float norm = (alpha / aSun) * (alpha / aSun);
        float spec = D_GGX(NdH, aSun) * V_SmithGGX(NdV, NdL, aSun) * norm * NdL;
        vec3 sunSpec = uSunColor * uSunIntensity * min(spec * F, 2.2);

        // --- body: Beer-Lambert through the water column ---
        float depth = bedDepth(P.xz);
        float flatNdV = clamp(V.y, 0.10, 1.0);
        float path = depth / flatNdV;
        vec3 trans = exp(-uAbsorb * path);
        float opacity = 1.0 - dot(trans, vec3(0.26, 0.48, 0.26));

        vec3 skyAmbient = mix(uZenithColor, uHorizonColor, 0.55) * uSkyIntensity;
        vec3 sunIrr = uSunColor * uSunIntensity * max(L.y, 0.0);

        // In-scatter from the column, tinted toward silt green over the shoals.
        vec3 scatterTint = mix(uScatterColor, uShallowColor, exp(-depth * 0.32));
        vec3 body = scatterTint * (skyAmbient * 0.55 + sunIrr * 0.055) * (1.0 - trans);

        // --- sub-surface: sun through the back of a crest ---
        float crestLift = clamp((P.y - uSeaLevel) * 0.7 + 0.25, 0.0, 1.0);
        float backlit = pow(clamp(dot(V, -L), 0.0, 1.0), 4.0);
        float thin = pow(clamp(0.5 - 0.5 * dot(L, N), 0.0, 1.0), 2.5);
        vec3 sss = uSssColor * sunIrr * (backlit * 4.0 + 0.12) * thin * crestLift;
        sss *= 1.0 - smoothstep(2.0, 9.0, depth) * 0.35;

        vec3 col = mix(body + sss, refl, F) + sunSpec;

        // --- foam: whitecaps on steep crests, wake trails, and a surf line ---
        float caps = smoothstep(0.09, 0.25, vCrest) * uWindStrength;
        float surf = smoothstep(1.5, 0.15, depth) * (0.35 + 0.65 * crestLift);
        float coverage = clamp(caps * 0.85 + vFoam + surf * 0.55, 0.0, 1.0);
        float foam = 0.0;
        if (coverage > 0.002) {
          float tex = foamTexture(P.xz, fp);
          foam = smoothstep(0.5 - coverage * 0.5, 1.0 - coverage * 0.5, tex);
          foam *= smoothstep(0.0, 0.06, coverage);
        }

        vec3 foamLit = uFoamColor * (sunIrr * 0.075 + skyAmbient * 0.42);
        col = mix(col, foamLit, foam * 0.94);
        float alphaOut = mix(clamp(opacity, 0.0, 1.0), 1.0, foam);

        // --- aerial perspective, matched to the scene fog ---
        float fogAmt = clamp(1.0 - exp(-uFogDensity * uFogDensity * vDistance * vDistance), 0.0, 1.0);
        vec3 haze = mix(uFogColor, skyRadiance(normalize(vec3(-V.x, 0.02, -V.z)), 0.5), 0.6);
        col = mix(col, haze, fogAmt);
        alphaOut = mix(alphaOut, 1.0, fogAmt);

        // Premultiplied: what is behind the surface survives as (1 - alpha).
        gl_FragColor = vec4(max(col, 0.0), clamp(alphaOut, 0.0, 1.0));
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.position.y = seaLevel;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  // First in the transparent queue: opaque geometry has already laid down
  // depth, and nothing else in the scene should sort behind the lake.
  mesh.renderOrder = -5;
  scene.add(mesh);

  // --- CPU-side wave evaluation, mirrors the vertex shader exactly ---
  const G = 9.81;
  const wakes: Array<{
    x: number;
    z: number;
    strength: number;
    foam: number;
    radius: number;
    life: number;
  }> = [];
  let time = 0;
  const camXZ = new THREE.Vector2();
  const param = new THREE.Vector2();

  const bandFade = (wavelength: number, dist: number): number =>
    1 - sstep(wavelength * FADE_NEAR, wavelength * FADE_FAR, dist);

  /**
   * Gerstner moves points horizontally, so the surface above (x, z) is not the
   * wave evaluated at (x, z). Newton-ish fixed point: three passes converge
   * well below a centimetre at these steepnesses.
   */
  const solveParam = (x: number, z: number, out: THREE.Vector2): THREE.Vector2 => {
    out.set(x, z);
    for (let iter = 0; iter < 3; iter++) {
      let dx = 0;
      let dz = 0;
      for (const w of WAVES) {
        const k = (2 * Math.PI) / w.wavelength;
        const fade = bandFade(w.wavelength, Math.hypot(out.x - camXZ.x, out.y - camXZ.y));
        const a = (w.steepness * fade) / k;
        const f = k * (w.dir.x * out.x + w.dir.y * out.y - Math.sqrt(G / k) * time);
        const cf = Math.cos(f);
        dx += w.dir.x * a * cf;
        dz += w.dir.y * a * cf;
      }
      out.set(x - dx, z - dz);
    }
    return out;
  };

  const waveHeightAt = (px: number, pz: number): number => {
    const dist = Math.hypot(px - camXZ.x, pz - camXZ.y);
    let y = 0;
    for (const w of WAVES) {
      const k = (2 * Math.PI) / w.wavelength;
      const f = k * (w.dir.x * px + w.dir.y * pz - Math.sqrt(G / k) * time);
      y += ((w.steepness * bandFade(w.wavelength, dist)) / k) * Math.sin(f);
    }
    for (const wk of wakes) {
      const r = Math.hypot(px - wk.x, pz - wk.z);
      if (r < wk.radius) {
        const t = 1 - r / wk.radius;
        y += Math.sin(r * 1.15 - time * 5.2) * t * t * wk.strength * 0.55;
      }
    }
    return y;
  };

  const sampleHeight = (x: number, z: number): number => {
    const p = solveParam(x, z, param);
    return waveHeightAt(p.x, p.y) + seaLevel;
  };

  const sampleNormal = (x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 => {
    const p = solveParam(x, z, param);
    const px = p.x;
    const pz = p.y;
    const dist = Math.hypot(px - camXZ.x, pz - camXZ.y);

    // Analytic tangent/binormal at the solved parameter — same accumulation as
    // the vertex shader, so shading and physics agree on which way is up.
    let tx = 1;
    let ty = 0;
    let tz = 0;
    let bx = 0;
    let by = 0;
    let bz = 1;
    for (const w of WAVES) {
      const k = (2 * Math.PI) / w.wavelength;
      const steep = w.steepness * bandFade(w.wavelength, dist);
      const f = k * (w.dir.x * px + w.dir.y * pz - Math.sqrt(G / k) * time);
      const sf = Math.sin(f);
      const cf = Math.cos(f);
      tx += -w.dir.x * w.dir.x * steep * sf;
      ty += w.dir.x * steep * cf;
      tz += -w.dir.x * w.dir.y * steep * sf;
      bx += -w.dir.x * w.dir.y * steep * sf;
      by += w.dir.y * steep * cf;
      bz += -w.dir.y * w.dir.y * steep * sf;
    }
    return out
      .set(by * tz - bz * ty, bz * tx - bx * tz, bx * ty - by * tx)
      .normalize();
  };

  const addWake = (x: number, z: number, strength: number, radius: number) => {
    wakes.push({ x, z, strength, foam: Math.min(1, strength * 0.55), radius, life: 0 });
    if (wakes.length > MAX_WAKES) wakes.shift();
  };

  const update = (dt: number, elapsed: number, cameraPos: THREE.Vector3) => {
    time = elapsed;
    uniforms.uTime.value = elapsed;
    uniforms.uCameraPos.value.copy(cameraPos);
    camXZ.set(cameraPos.x, cameraPos.z);

    // The disc rides with the camera; snapping keeps the tessellation from
    // crawling under slow movement.
    mesh.position.x = Math.round(cameraPos.x * 4) * 0.25;
    mesh.position.z = Math.round(cameraPos.z * 4) * 0.25;

    for (let i = wakes.length - 1; i >= 0; i--) {
      const wk = wakes[i];
      wk.life += dt;
      wk.strength *= 1 - Math.min(dt * 0.85, 0.9);
      // Foam outlives the swell it rode in on — a hydroplane leaves a scar.
      wk.foam *= 1 - Math.min(dt * 0.16, 0.9);
      wk.radius += dt * 5.5;
      if ((wk.strength < 0.02 && wk.foam < 0.03) || wk.life > 22) wakes.splice(i, 1);
    }

    const n = Math.min(wakes.length, MAX_WAKES);
    for (let i = 0; i < n; i++) {
      wakeData[i * 4 + 0] = wakes[i].x;
      wakeData[i * 4 + 1] = wakes[i].z;
      wakeData[i * 4 + 2] = wakes[i].strength;
      wakeData[i * 4 + 3] = wakes[i].radius;
      wakeFoam[i] = wakes[i].foam;
    }
    uniforms.uWakeCount.value = n;
    uniforms.uWakes.value = wakeData;
    uniforms.uWakeFoam.value = wakeFoam;
  };

  const dispose = () => {
    geo.dispose();
    material.dispose();
    bedTex.dispose();
    scene.remove(mesh);
  };

  return { mesh, material, sampleHeight, sampleNormal, addWake, update, dispose };
}
