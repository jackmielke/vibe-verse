import * as THREE from "three";
import type { QualityProfile } from "../core/Settings";
import { atmosphere, ATMOSPHERE_GLSL } from "./Sky";

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
 *  - a detail-normal cascade of up to seven octaves, each on its own rotated
 *    lattice at an irrational frequency ratio and warped by the coarsest
 *    octave, so nothing tiles; each is attenuated against the world-space pixel
 *    footprint with the slope variance it loses folded back into the specular
 *    roughness (Toksvig / LEAN style);
 *  - the reflection is *prefiltered*, not point-sampled. The specular lobe is
 *    integrated over elevation with a width set by that filtered roughness,
 *    which is the only thing that stops distant water boiling into pixel noise
 *    — scaling a point sample by roughness does nothing at all;
 *  - a mirrored-camera planar reflection of the actual scene (bluff, trees,
 *    city, props), sized off `profile.waterReflectionSize` and hazed by the
 *    same aerial-perspective slab Engine uses, blended over the analytic sky;
 *  - a real microfacet sun response, so the glitter forms a scattered path
 *    toward the sun rather than one blown dot;
 *  - depth-driven absorption from a baked bathymetry map: green-brown and
 *    translucent over the shoals, steel blue-green offshore, modulated by a
 *    kilometre-scale turbidity field so the body is not one flat colour.
 *
 * COLOUR CONTRACT. The scene is scene-linear HDR and nothing here tone maps.
 * Every radiometric quantity below is driven from `atmosphere` in Sky.ts — the
 * reflected sky is literally `atmosphereRadiance()`, the same function the sky
 * dome and Engine's aerial-perspective pass evaluate, and the sun and sky
 * irradiances are integrals of that same model, evaluated once per frame on the
 * CPU. Nothing about the lake's brightness is hand-typed, so the water and the
 * sky cannot drift apart at the horizon.
 *
 * There is deliberately no fog term in this shader. The water writes depth, so
 * Engine's screen-space aerial perspective already fades it into exactly the
 * air the sky is painting behind it; a second fade here is what produced the
 * hard bright band at the horizon.
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
}

/**
 * Lake fetch, not ocean swell. Amplitude is steepness/k, so the budget has to
 * be spent on the *short* bands: a 42 m band at 0.026 steepness is 0.17 m of
 * amplitude but only 1.5 degrees of slope, whereas the 2 m band at 0.108 is
 * 3.5 cm of amplitude and 6 degrees. Significant height comes out near 0.78 m,
 * which is Lake Washington in a 10-12 kt afternoon breeze with a race course
 * full of wakes on top of it.
 */
const WAVES: WaveParam[] = [
  { dir: new THREE.Vector2(1, 0.32), steepness: 0.026, wavelength: 42 },
  { dir: new THREE.Vector2(0.72, -0.68), steepness: 0.062, wavelength: 17 },
  { dir: new THREE.Vector2(-0.34, 0.94), steepness: 0.084, wavelength: 8.4 },
  { dir: new THREE.Vector2(-0.88, -0.42), steepness: 0.1, wavelength: 4.1 },
  { dir: new THREE.Vector2(0.42, 0.9), steepness: 0.108, wavelength: 2.05 },
];
WAVES.forEach((w) => w.dir.normalize());

/**
 * A wave band is faded out once the radial grid stops resolving it. Cell size
 * is ~0.038 of range, so four samples per wavelength runs out at
 * `wavelength / (4 * 0.038)` ≈ 6.6 wavelengths. Fading later than that is what
 * turned the mid-lake into aliased normal noise.
 */
const FADE_NEAR = 7;
const FADE_FAR = 20;

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

/**
 * Anything at or behind this render order is treated as the sky dome and left
 * out of the reflection pass — re-marching the cumulus deck into a 512 px
 * target costs more than everything else in this file put together, and the
 * shader falls back to the analytic sky wherever the target holds no geometry.
 */
const SKY_RENDER_ORDER = -900;

const sstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Concentric rings of constant range make every distance-keyed fade constant
 * along a ring, which paints a bullseye across the lake. Warping the range the
 * fades see by a long, smooth, non-radial function breaks the isolines into
 * organic patches. Mirrored exactly on the CPU so buoyancy still matches.
 */
const distWarpGLSL = /* glsl */ `
float warpRange(vec2 xz, float dist) {
  return dist * (1.0 + 0.24 * sin(xz.x * 0.0037 + 1.7) * sin(xz.y * 0.0041 - 0.9));
}
`;
const warpRange = (x: number, z: number, dist: number): number =>
  dist * (1 + 0.24 * Math.sin(x * 0.0037 + 1.7) * Math.sin(z * 0.0041 - 0.9));

// ---------------------------------------------------------------------------
// CPU mirror of ATMOSPHERE_GLSL, used only to integrate irradiance once a frame
// ---------------------------------------------------------------------------

const BETA_R = [5.8e-6, 13.5e-6, 33.1e-6];
const BETA_M = 21.0e-6;
const H_R = 8400;
const H_M = 1250;
const MS_FLOOR = [0.055, 0.085, 0.135];

/** Top-of-atmosphere solar irradiance, in the scene's linear units.
 *  Chosen so that after the solar column's extinction at Seafair's 52°
 *  elevation it lands on the key light Sky.ts installs (≈3.3), which is what
 *  puts an 18% grey surface in full sun at 0.18 linear. */
const SUN_IRRADIANCE_TOA = 4.05;

const airMass = (cosZenith: number): number => {
  const c = Math.max(cosZenith, -0.1);
  const zdeg = (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
  return 1 / (c + 0.15 * Math.pow(Math.max(93.885 - zdeg, 1e-3), -1.253));
};

const radTmp = [0, 0, 0];
const trTmp = [0, 0, 0];

/** Line-for-line mirror of `atmosphereRadiance` in ATMOSPHERE_GLSL. */
const atmosphereRadianceCPU = (dir: THREE.Vector3): void => {
  const a = atmosphere;
  const am = airMass(dir.y);
  const tauM = BETA_M * a.mie * H_M * am;
  const inMBase = 1 - Math.exp(-tauM);

  const c = dir.dot(a.sunDirection);
  const pr = 0.0596831 * (1 + c * c);
  const g2 = a.mieG * a.mieG;
  const d = Math.max(1 + g2 - 2 * a.mieG * c, 1e-4);
  const pm = (0.0795775 * (1 - g2)) / (d * Math.sqrt(d));

  const tint = [a.sunTint.r, a.sunTint.g, a.sunTint.b];
  for (let i = 0; i < 3; i++) {
    const tauR = BETA_R[i] * a.rayleigh * H_R * am;
    const sr = 1 - Math.exp(-tauR);
    radTmp[i] = (pr * sr + pm * inMBase + MS_FLOOR[i] * sr * 0.0125) * a.skyLuminance * tint[i];
    trTmp[i] = Math.exp(-(tauR + tauM));
  }
};

/** Fibonacci hemisphere, uniform in cos(theta) so `2π/N · Σ L·cosθ` integrates. */
const HEMI_DIRS: THREE.Vector3[] = (() => {
  const n = 24;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const y = (i + 0.5) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * golden;
    out.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
  }
  return out;
})();

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
 * cheap geometry at the horizon, no LOD popping. Both radius and angle carry a
 * deterministic per-vertex jitter — a perfect polar lattice makes the rings
 * themselves readable as arcs once anything varies with range.
 */
function radialGrid(rings: number, spokes: number, rMin: number, rMax: number): THREE.BufferGeometry {
  const cols = spokes + 1; // duplicated seam column keeps the index buffer trivial
  const count = (rings + 1) * cols;
  const pos = new Float32Array(count * 3);
  // Flat up-normals. The shader never reads them, but the depth-normal prepass
  // the AO pass runs does, via an override material — without the attribute it
  // gets undefined normals and buries the whole lake in ambient occlusion.
  const nrm = new Float32Array(count * 3);
  const ratio = Math.pow(rMax / rMin, 1 / (rings - 1));
  const dAngle = (Math.PI * 2) / spokes;

  const hash = (i: number, j: number): number => {
    const s = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
    return s - Math.floor(s) - 0.5;
  };

  let p = 0;
  for (let i = 0; i <= rings; i++) {
    // Ring 0 collapses to the origin so the disc has no hole under the camera.
    const r0 = i === 0 ? 0 : rMin * Math.pow(ratio, i - 1);
    for (let j = 0; j < cols; j++) {
      // Seam column must land exactly on column 0 or the disc cracks open.
      const jw = j % spokes;
      const h1 = hash(i, jw);
      const h2 = hash(i + 71, jw + 137);
      // Kept well under the 3.8% ring spacing so rings can never cross.
      const r = r0 * (1 + h1 * 0.026);
      const a = jw * dAngle + h2 * dAngle * 0.34;
      nrm[p + 1] = 1;
      pos[p++] = Math.cos(a) * r;
      pos[p++] = 0;
      pos[p++] = Math.sin(a) * r;
    }
  }

  // Spokes advance from +X toward +Z, so this is the winding whose face normal
  // points +Y. Reversed, the whole disc is back-face culled from above and the
  // lake simply is not drawn — which reads on screen as a blown-out lakebed,
  // not as a winding bug.
  const idx = new Uint32Array(rings * spokes * 6);
  let k = 0;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < spokes; j++) {
      const a = i * cols + j;
      const b = a + cols;
      idx[k++] = a;
      idx[k++] = a + 1;
      idx[k++] = b;
      idx[k++] = a + 1;
      idx[k++] = b + 1;
      idx[k++] = b;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
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
  // showing as a horizon seam. Aerial perspective has saturated long before it.
  const radius = Math.max(profile.drawDistance * 1.3, 6000);
  const rings = profile.tier === "low" ? 96 : profile.tier === "medium" ? 160 : 256;
  const spokes = profile.tier === "low" ? 96 : profile.tier === "medium" ? 160 : 256;

  const geo = radialGrid(rings, spokes, 0.45, radius);

  const bedTex = bakeBedTexture(
    Math.min(512, Math.max(128, profile.textureSize)),
    bedHeight,
    seaLevel,
  );

  // --- planar reflection target -------------------------------------------
  // waterReflectionSize is 0 on a phone, where the analytic sky alone has to do.
  const reflSize = profile.waterReflectionSize;
  const useReflection = reflSize > 0;
  /** Frames between reflection renders. Half rate below high tier. */
  const reflInterval = profile.tier === "medium" ? 2 : 1;

  let reflRT: THREE.WebGLRenderTarget | null = null;
  if (useReflection) {
    const depthTex = new THREE.DepthTexture(reflSize, reflSize);
    depthTex.format = THREE.DepthFormat;
    depthTex.type = THREE.UnsignedIntType;
    depthTex.minFilter = THREE.NearestFilter;
    depthTex.magFilter = THREE.NearestFilter;
    reflRT = new THREE.WebGLRenderTarget(reflSize, reflSize, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      depthTexture: depthTex,
      stencilBuffer: false,
    });
  }
  const reflCam = new THREE.PerspectiveCamera();

  const wakeData = new Float32Array(MAX_WAKES * 4); // x, z, strength, radius
  const wakeFoam = new Float32Array(MAX_WAKES);

  const uniforms = {
    uTime: { value: 0 },

    // --- atmosphere, mirrored from Sky.ts every frame ---
    uSunDirection: { value: atmosphere.sunDirection.clone() },
    uSunTint: { value: new THREE.Vector3(1, 1, 1) },
    uRayleigh: { value: atmosphere.rayleigh },
    uMie: { value: atmosphere.mie },
    uMieG: { value: atmosphere.mieG },
    uSkyLuminance: { value: atmosphere.skyLuminance },
    uAerialR: { value: atmosphere.aerialRayleigh },
    uAerialM: { value: atmosphere.aerialMie },
    /** Solar irradiance on a sun-facing surface, after the solar column. */
    uSunIrradiance: { value: new THREE.Vector3(3.3, 3.1, 2.7) },
    /** Hemispherical irradiance from the sky dome, integrated on the CPU. */
    uSkyIrradiance: { value: new THREE.Vector3(2.0, 2.4, 3.0) },

    // Beer-Lambert absorption per metre of lake water: red is gone inside two
    // metres, green survives longest. Lake Washington carries enough CDOM that
    // blue dies faster than it would in the open ocean — it is a green lake,
    // but not so green that the body reads as a swimming pool.
    uAbsorb: { value: new THREE.Vector3(0.58, 0.105, 0.145) },
    // Effective water-leaving reflectance of the column. Green still leads, but
    // blue is lifted close to it so the deep body sits as a desaturated steel
    // blue-green once the grade's 1.28 look-saturation has had its way with it.
    uScatterDeep: { value: new THREE.Vector3(0.011, 0.05, 0.058) },
    uScatterShallow: { value: new THREE.Vector3(0.115, 0.145, 0.1) },
    uSssColor: { value: new THREE.Vector3(0.045, 0.16, 0.125) },
    /** Foam is a dense bubble raft — very high albedo, faintly cool. */
    uFoamAlbedo: { value: new THREE.Vector3(0.8, 0.85, 0.88) },

    uWakes: { value: wakeData },
    uWakeFoam: { value: wakeFoam },
    uWakeCount: { value: 0 },
    uCameraPos: { value: new THREE.Vector3() },
    uNormalScale: { value: 1.0 },
    /** Roughness of everything finer than the last resolved capillary octave. */
    uRoughness: { value: 0.03 },
    uVarianceGain: { value: 1.35 },
    uWindStrength: { value: 1.0 },
    /** Metres of domain warp the coarsest chop octave applies to the rest. */
    uWarp: { value: 3.2 },
    uWaveA: { value: new THREE.Vector4() },
    uWaveB: { value: new THREE.Vector4() },
    uWaveC: { value: new THREE.Vector4() },
    uWaveD: { value: new THREE.Vector4() },
    uWaveE: { value: new THREE.Vector4() },
    uBedMap: { value: bedTex },
    uBedExtent: { value: BED_EXTENT },
    uBedMaxDepth: { value: BED_MAX_DEPTH },
    uSeaLevel: { value: seaLevel },

    // --- planar reflection ---
    uReflMap: { value: reflRT ? reflRT.texture : null },
    uReflDepth: { value: reflRT ? reflRT.depthTexture : null },
    uReflViewProj: { value: new THREE.Matrix4() },
    uReflInvViewProj: { value: new THREE.Matrix4() },
    uReflValid: { value: 0 },
  };

  const waveUniforms = [
    uniforms.uWaveA,
    uniforms.uWaveB,
    uniforms.uWaveC,
    uniforms.uWaveD,
    uniforms.uWaveE,
  ];
  WAVES.forEach((w, i) => {
    waveUniforms[i].value.set(w.dir.x, w.dir.y, w.steepness, w.wavelength);
  });

  const detailOctaves =
    profile.tier === "low" ? 3 : profile.tier === "medium" ? 5 : profile.tier === "high" ? 7 : 8;

  const material = new THREE.ShaderMaterial({
    uniforms,
    defines: {
      DETAIL_OCTAVES: detailOctaves,
      PLANAR_REFLECTION: useReflection ? 1 : 0,
      FADE_NEAR: FADE_NEAR.toFixed(1),
      FADE_FAR: FADE_FAR.toFixed(1),
    },
    side: THREE.FrontSide,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: true,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec4 uWaveA, uWaveB, uWaveC, uWaveD, uWaveE;
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

      ${distWarpGLSL}

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
        float rawDist = distance(origin.xz, uCameraPos.xz);
        float dist = warpRange(origin.xz, rawDist);

        vec3 tangent = vec3(1.0, 0.0, 0.0);
        vec3 binormal = vec3(0.0, 0.0, 1.0);

        vec3 jac = vec3(0.0);
        vec3 p = origin;
        p += gerstner(uWaveA, origin.xz, bandFade(uWaveA.w, dist), tangent, binormal, jac);
        p += gerstner(uWaveB, origin.xz, bandFade(uWaveB.w, dist), tangent, binormal, jac);
        p += gerstner(uWaveC, origin.xz, bandFade(uWaveC.w, dist), tangent, binormal, jac);
        p += gerstner(uWaveD, origin.xz, bandFade(uWaveD.w, dist), tangent, binormal, jac);
        p += gerstner(uWaveE, origin.xz, bandFade(uWaveE.w, dist), tangent, binormal, jac);

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
        vDistance = rawDist;

        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;

      uniform float uTime, uNormalScale, uWarp;
      uniform float uRoughness, uVarianceGain, uWindStrength;
      uniform float uBedExtent, uBedMaxDepth, uSeaLevel;
      uniform float uAerialR, uAerialM;
      uniform vec3 uSunIrradiance, uSkyIrradiance;
      uniform vec3 uAbsorb, uScatterDeep, uScatterShallow, uSssColor, uFoamAlbedo;
      uniform vec3 uCameraPos;
      uniform sampler2D uBedMap;

      #if PLANAR_REFLECTION
      uniform sampler2D uReflMap;
      uniform sampler2D uReflDepth;
      uniform mat4 uReflViewProj;
      uniform mat4 uReflInvViewProj;
      uniform float uReflValid;
      #endif

      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vFoam;
      varying float vDistance;
      varying float vCrest;

      ${ATMOSPHERE_GLSL}

      const float PI = 3.141592653589793;
      /** Mean angular radius of the solar disc, radians. */
      const float SUN_ANG = 0.00465;

      /**
       * The radiance of the solar disc that is *consistent* with the irradiance
       * this same model delivers: E / (pi * SUN_ANG^2) ≈ 4.8e4. The sky dome
       * paints the disc at an artistic 105 so the bloom kernel stays sane;
       * clamping the glitter there as well is what kept sun glitter from ever
       * out-shining the horizon haze. The microfacet integral below already
       * carries the right energy, so this only has to stop a single near-mirror
       * facet from becoming a bloom bomb.
       */
      const float SUN_DISC_RADIANCE = 6000.0;

      // Eight detail octaves, each on its own lattice rotated by an irrational
      // angle and at a 2.35x frequency ratio, so no two ever beat against each
      // other into a visible weave. The cascade has to reach 8 cm features or
      // the water two metres from your eye has nothing in it at all: at that
      // range a 60 cm ripple is a third of the screen.
      const mat2 MR0 = mat2( 1.00000,  0.00000,  0.00000, 1.00000);
      const mat2 MR1 = mat2( 0.75383,  0.65706, -0.65706, 0.75383);
      const mat2 MR2 = mat2(-0.73610,  0.67680, -0.67680,-0.73610);
      const mat2 MR3 = mat2(-0.56360, -0.82600,  0.82600,-0.56360);
      const mat2 MR4 = mat2( 0.05880,  0.99827, -0.99827, 0.05880);
      const mat2 MR5 = mat2(-0.99164, -0.12904,  0.12904,-0.99164);
      const mat2 MR6 = mat2( 0.31250, -0.94990,  0.94990, 0.31250);
      const mat2 MR7 = mat2( 0.91309,  0.40776, -0.40776, 0.91309);

      vec2 hash2(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
        p3 += dot(p3, p3.yzx + 33.33);
        return -1.0 + 2.0 * fract((p3.xx + p3.yz) * p3.zy);
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
       * One band of wind chop on its own rotated lattice. The amplitude is
       * expressed as a slope, so octaves sum straight into the surface
       * gradient. Anything finer than the pixel footprint is dropped and its
       * slope variance handed to the roughness — filtering the specular instead
       * of letting it alias. The near/far thresholds are staggered per octave:
       * the footprint is nearly constant along a screen row over a water plane,
       * so a shared threshold makes the whole cascade switch off in one
       * horizontal band across the frame.
       */
      void chop(vec2 xz, mat2 rot, float invL, float amp, vec2 flow, float fp,
                float nearT, float farT, inout vec2 slope, inout float lostVar) {
        float atten = 1.0 - smoothstep(nearT, farT, fp * invL);
        if (atten > 0.004) {
          vec3 n = noised((rot * xz) * invL + flow * uTime);
          slope += (n.yz * rot) * (amp * atten);
        }
        lostVar += (1.0 - atten * atten) * amp * amp * 0.5;
      }

      /** Clumped foam. Keeps structure down to ~10 cm so a 3 m surf strip is
       *  not one flat plate, and dissolves to a wash as it goes sub-pixel. */
      float foamTexture(vec2 xz, float fp) {
        float n = 0.5;
        n += noised(xz * 0.16 + vec2(0.05, -0.03) * uTime).x * 0.46
           * (1.0 - smoothstep(0.09, 0.85, fp * 0.16));
        n += noised((MR2 * xz) * 0.55 - vec2(0.09, 0.06) * uTime).x * 0.30
           * (1.0 - smoothstep(0.09, 0.85, fp * 0.55));
        n += noised((MR4 * xz) * 2.4 + vec2(0.22, 0.13) * uTime).x * 0.22
           * (1.0 - smoothstep(0.09, 0.85, fp * 2.4));
        n += noised((MR5 * xz) * 7.0 - vec2(0.4, 0.31) * uTime).x * 0.16
           * (1.0 - smoothstep(0.09, 0.85, fp * 7.0));
        return clamp(n, 0.0, 1.0);
      }

      /**
       * Radiance arriving along dir. Above the horizon this is the identical
       * single-scattering integral the sky dome paints, so the lake and the sky
       * agree exactly where they meet. Below the horizon the facet is looking
       * at more lake: at grazing that second bounce hands back nearly the whole
       * sky, steeply down it only returns the dark body.
       */
      vec3 skyRadiance(vec3 dir) {
        vec3 tr;
        vec3 up = normalize(vec3(dir.x, max(dir.y, 0.0035), dir.z));
        vec3 c = atmosphereRadiance(up, tr);
        return c * mix(0.14, 1.0, smoothstep(-0.30, -0.004, dir.y));
      }

      /**
       * Prefiltered environment reflection. This is the load-bearing one: the
       * sky is a 1.7-to-0.6-linear gradient in elevation, so point-sampling it
       * down a mirror direction that wobbles a couple of degrees per pixel is
       * binary white/dark speckle no matter how much you scale the result.
       * Integrating the lobe over elevation with a width set by the filtered
       * roughness is what makes the far lake settle into a sheen.
       */
      vec3 reflectedSky(vec3 R, float alpha, float NdV) {
        float spread = min(alpha, 0.45);
        vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), R) + vec3(1e-4, 0.0, 0.0));
        vec3 tang = cross(R, side);
        vec3 c = skyRadiance(R) * 0.5
               + skyRadiance(normalize(R + tang * spread)) * 0.25
               + skyRadiance(normalize(R - tang * spread)) * 0.25;
        // As the lobe widens toward a hemisphere it has to converge on the
        // sky's mean radiance rather than keep sampling its extremes — but only
        // where the lobe really is a cone. At grazing it is a thin sliver along
        // the horizon band and averaging it there is what darkened the horizon.
        float toMean = smoothstep(0.14, 0.60, alpha) * smoothstep(0.12, 0.5, NdV);
        return mix(c, uSkyIrradiance / PI, toMean * 0.65);
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

        // Cat's-paws: the wind arrives in patches hundreds of metres across, so
        // the lake is ruffled unevenly instead of uniformly textured to the
        // horizon. Without this the whole surface reads as one tiled swatch.
        float g1 = noised(P.xz * (1.0 / 1300.0) + vec2(0.004, -0.002) * uTime).x;
        float g2 = noised((MR3 * P.xz) * (1.0 / 380.0) + vec2(0.011, -0.006) * uTime).x;
        float gust = uWindStrength * clamp(0.62 + 1.5 * g1 + 0.85 * g2, 0.25, 1.7);

        // --- detail normal cascade -------------------------------------------
        vec2 slope = vec2(0.0);
        float lostVar = 0.0;

        // Octave 0 is also the domain warp for everything below it: offsetting
        // the finer lattices by the coarse gradient is what breaks the residual
        // diagonal weave that rotation alone leaves behind.
        const float INV0 = 1.0 / 31.0;
        float att0 = 1.0 - smoothstep(0.05, 1.05, fp * INV0);
        vec2 warp = vec2(0.0);
        if (att0 > 0.004) {
          vec3 n0 = noised((MR0 * P.xz) * INV0 + vec2(0.017, 0.009) * uTime);
          vec2 g0 = n0.yz * MR0;
          slope += g0 * (0.030 * gust * att0);
          warp = g0 * uWarp;
        }
        lostVar += (1.0 - att0 * att0) * 0.030 * 0.030 * gust * gust * 0.5;

        // Flow rates are the deep-water phase speed sqrt(g L / 2pi) expressed in
        // each octave's own scaled coordinates and taken at about half strength,
        // so the fine ripples ride forward rather than boiling in place.
        vec2 W = P.xz + warp;
        chop(W, MR1, 1.0 / 13.2,  0.048 * gust, vec2( 0.15, -0.08), fp, 0.055, 1.15, slope, lostVar);
        chop(W, MR2, 1.0 / 5.61,  0.066 * gust, vec2(-0.20,  0.17), fp, 0.065, 1.32, slope, lostVar);
        #if DETAIL_OCTAVES > 3
        chop(W, MR3, 1.0 / 2.39,  0.078 * gust, vec2( 0.31,  0.25), fp, 0.075, 1.50, slope, lostVar);
        #endif
        #if DETAIL_OCTAVES > 4
        chop(W, MR4, 1.0 / 1.016, 0.080 * gust, vec2(-0.44,  0.44), fp, 0.085, 1.70, slope, lostVar);
        #endif
        #if DETAIL_OCTAVES > 5
        // Capillary ripple: only ever resolved within a few metres of the eye,
        // and it is what keeps the water at your feet from looking moulded.
        chop(W, MR5, 1.0 / 0.432, 0.075 * gust, vec2( 0.72, -0.62), fp, 0.095, 1.90, slope, lostVar);
        #endif
        #if DETAIL_OCTAVES > 6
        chop(W, MR6, 1.0 / 0.184, 0.066 * gust, vec2(-1.05, -1.02), fp, 0.105, 2.15, slope, lostVar);
        #endif
        #if DETAIL_OCTAVES > 7
        chop(W, MR7, 1.0 / 0.078, 0.055 * gust, vec2( 1.55,  1.62), fp, 0.115, 2.40, slope, lostVar);
        #endif

        vec3 geoN = normalize(vNormal);
        vec2 geoSlope = -geoN.xz / max(geoN.y, 0.05);
        vec2 total = geoSlope + slope * uNormalScale;
        vec3 N = normalize(vec3(-total.x, 1.0, -total.y));

        // Roughness = base + the slope variance we just filtered away + the
        // variance of the interpolated mesh normal itself. Allowed to run all
        // the way to 1: capping it is what left the far field still sampling
        // the sky's extremes through a footprint metres across.
        vec2 gfw = fwidth(geoSlope);
        vec2 sfw = fwidth(slope);
        float sigma2 = lostVar * uVarianceGain + dot(gfw, gfw) * 0.45 + dot(sfw, sfw) * 0.45;
        float alpha = clamp(sqrt(uRoughness * uRoughness + 2.0 * sigma2), 0.010, 1.0);

        float NdV = clamp(dot(N, V), 1e-3, 1.0);
        float NdL = clamp(dot(N, L), 0.0, 1.0);

        // Plain Schlick. Capping the grazing limit by roughness (the usual IBL
        // trick) is wrong here: it is exactly the near-mirror band at the far
        // end of the lake, and dimming it flattens the whole surface.
        float F0 = 0.02;
        float F = F0 + (1.0 - F0) * pow(1.0 - NdV, 5.0);

        // --- reflection: prefiltered sky, then the real scene over the top ---
        vec3 R = reflect(-V, N);
        vec3 refl = reflectedSky(R, alpha, NdV);

        #if PLANAR_REFLECTION
        if (uReflValid > 0.5 && R.y > 0.004) {
          // The mirror camera renders the real scene, so unprojecting its depth
          // gives real world positions. First tap at the flat-plane UV to
          // measure how far away the reflected geometry is, then re-sample
          // along the actual perturbed reflection ray at that range — which is
          // where the wave distortion comes from, for free and to scale.
          vec4 c0 = uReflViewProj * vec4(P, 1.0);
          if (c0.w > 0.0) {
            vec2 uv0 = c0.xy / c0.w * 0.5 + 0.5;
            float d0 = texture2D(uReflDepth, clamp(uv0, 0.0, 1.0)).x;
            float hitT = 120.0;
            if (d0 < 0.999999) {
              vec4 wp0 = uReflInvViewProj * vec4(uv0 * 2.0 - 1.0, d0 * 2.0 - 1.0, 1.0);
              hitT = length(wp0.xyz / wp0.w - P);
            }

            vec2 uv = uv0;
            vec4 c1 = uReflViewProj * vec4(P + R * hitT, 1.0);
            if (c1.w > 0.0) uv += clamp(c1.xy / c1.w * 0.5 + 0.5 - uv0, -0.10, 0.10);

            float d1 = texture2D(uReflDepth, clamp(uv, 0.0, 1.0)).x;
            if (d1 < 0.999999) {
              vec4 wp1 = uReflInvViewProj * vec4(uv * 2.0 - 1.0, d1 * 2.0 - 1.0, 1.0);
              vec3 X = wp1.xyz / wp1.w;
              float path = length(X - P);

              // Aerial perspective along the reflected path, using the same
              // ground-level slab Engine's atmosphere pass runs, or a reflected
              // skyline comes back far darker and harder than the real one.
              vec3 rd = (X - P) / max(path, 1e-3);
              vec3 tauR = BETA_R * uRayleigh * uAerialR * path;
              float tauM = BETA_M * uMie * uAerialM * path;
              float cs = dot(rd, uSunDirection);
              vec3 inscatter = (rayleighPhase(cs) * (1.0 - exp(-tauR))
                              + vec3(hgPhase(cs, uMieG) * (1.0 - exp(-tauM))))
                              * uSkyLuminance * uSunTint;
              vec3 hit = texture2D(uReflMap, uv).rgb * exp(-(tauR + vec3(tauM))) + inscatter;

              // Only geometry that is genuinely above the waterline can be
              // mirrored; the mirror camera also sees the lake bed.
              vec2 e = smoothstep(vec2(0.0), vec2(0.05), uv)
                     * smoothstep(vec2(1.0), vec2(0.95), uv);
              float w = e.x * e.y
                      * smoothstep(-0.05, 0.55, X.y - uSeaLevel)
                      * (1.0 - smoothstep(0.45, 1.0, alpha));
              refl = mix(refl, hit, w * 0.94);
            }
          }
        }
        #endif

        // --- sun: microfacet specular, convolved with the solar disc ---
        // Widening by the disc's angular radius is the whole convolution: it
        // caps the peak on glassy water instead of leaving a delta function.
        vec3 H = normalize(L + V);
        float NdH = clamp(dot(N, H), 0.0, 1.0);
        float VdH = clamp(dot(V, H), 0.0, 1.0);
        float aSun = sqrt(alpha * alpha + SUN_ANG * SUN_ANG);
        float Fs = F0 + (1.0 - F0) * pow(1.0 - VdH, 5.0);
        float spec = D_GGX(NdH, aSun) * V_SmithGGX(NdV, NdL, aSun) * NdL;
        vec3 sunSpec = Fs * min(uSunIrradiance * spec, vec3(SUN_DISC_RADIANCE));

        // --- body: Beer-Lambert through the water column ---
        float depth = bedDepth(P.xz);
        // Snell bends the view ray toward vertical, so even a grazing look only
        // ever sees ~48.6 degrees down into the water.
        float cosV = clamp(V.y, 0.02, 1.0);
        float cosRefr = sqrt(max(1.0 - (1.0 - cosV * cosV) / 1.769, 0.04));
        float pathUp = depth / cosRefr;
        float pathDown = depth / max(L.y, 0.25);

        vec3 trUp = exp(-uAbsorb * pathUp);
        vec3 trThrough = trUp * exp(-uAbsorb * pathDown);

        // Downwelling irradiance just under the surface; ~4% is lost to the
        // Fresnel reflection on the way in. Keyed off the facet's own cosine,
        // not the flat plane's — at near-normal view Fresnel is 2% and this is
        // the only thing left that can carry wave shape into the near field.
        vec3 Edown = (uSunIrradiance * NdL + uSkyIrradiance) * 0.96;

        // A real lake is not one colour. Suspended silt off the creek mouths
        // and late-summer algae drift in patches hundreds of metres across; the
        // offshore column is otherwise constant depth and would shade flat.
        float t1 = noised(P.xz * (1.0 / 620.0) + vec2(0.0016, -0.0009) * uTime).x;
        float t2 = noised((MR1 * P.xz) * (1.0 / 205.0)).x;
        float turb = clamp(0.5 + 0.85 * t1 + 0.45 * t2, 0.0, 1.0);

        vec3 albedo = mix(uScatterDeep, uScatterShallow, exp(-depth * 0.30));
        albedo *= mix(0.70, 1.40, turb);
        albedo.g *= mix(0.90, 1.14, turb);
        vec3 body = albedo * Edown * (1.0 - trUp) / PI;

        // --- sub-surface: sun through the back of a crest ---
        float crestLift = clamp((P.y - uSeaLevel) * 0.9 + 0.2, 0.0, 1.0);
        float backlit = pow(clamp(dot(V, -L), 0.0, 1.0), 4.0);
        float thin = pow(clamp(0.5 - 0.5 * dot(L, N), 0.0, 1.0), 2.5);
        vec3 sss = uSssColor * uSunIrradiance * (backlit * 0.35 + 0.02) * thin * crestLift;
        sss *= 1.0 - smoothstep(2.0, 9.0, depth) * 0.4;

        // No masking scalar on the reflection. A flat (1 - k*roughness) factor
        // survives at grazing where Fresnel goes to one, so the water at the
        // horizon ends up measurably darker than the sky it is mirroring — a
        // visible step exactly where the two have to dissolve into each other.
        vec3 col = (1.0 - F) * (body + sss) + F * refl + sunSpec;

        // What is behind the lake survives as (1 - alphaOut): the bed in the
        // shallows, nothing at all once the column is deep. This is also the
        // shoreline blend — as the column thins the water simply stops being
        // opaque, so there is no geometric seam to see.
        float through = dot(trThrough, vec3(0.30, 0.45, 0.25));
        float alphaOut = 1.0 - (1.0 - F) * through;

        // --- foam: whitecaps on steep crests, wake trails, and a surf line ---
        // 1 - jacobian tops out near 0.34 for this spectrum and clears 0.26 on
        // about 1.5% of the surface, which is what whitecap coverage actually
        // looks like in a fresh breeze. Thresholding lower painted the lake in
        // continuous white streaks along every crest.
        float caps = smoothstep(0.255, 0.335, vCrest) * smoothstep(0.85, 1.35, gust);

        // Swash: the waterline advances and retreats with the dominant band's
        // period (T = sqrt(2 pi L / g) ≈ 3.3 s for the 17 m band), with a long
        // alongshore phase so the whole beach does not pulse as one. Gated on
        // real water column so the wash can never climb onto dry sand — the
        // bathymetry map is metres per texel and cannot be trusted below that.
        float swash = sin(uTime * 1.90 + P.x * 0.045 + P.z * 0.031) * 0.30;
        float surf = smoothstep(1.5, 0.15, depth - swash)
                   * smoothstep(0.05, 0.35, depth)
                   * (0.4 + 0.6 * crestLift);
        float coverage = clamp(caps * 0.85 + vFoam + surf * 0.8, 0.0, 1.0);
        float foam = 0.0;
        if (coverage > 0.002) {
          float tex = foamTexture(P.xz, fp);
          foam = smoothstep(0.5 - coverage * 0.5, 1.0 - coverage * 0.5, tex);
          foam *= smoothstep(0.0, 0.06, coverage);
        }
        // Foam thins out with the water it is floating on.
        foam *= smoothstep(0.04, 0.6, depth);

        vec3 foamLit = uFoamAlbedo * (uSunIrradiance * max(L.y, 0.0) * 0.8 + uSkyIrradiance) / PI;
        col = mix(col, foamLit, foam * 0.9);
        // The output is premultiplied, so anything added to the colour has to
        // buy matching opacity or it simply glows over whatever is behind it —
        // which is exactly how the surf ended up as a snowdrift on dry sand.
        alphaOut = max(alphaOut, foam * 0.9);

        // Premultiplied: what is behind the surface survives as (1 - alpha).
        // No fog term — Engine's aerial-perspective pass owns the distance fade,
        // which is what keeps the horizon a single continuous gradient.
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

  // --- planar reflection render -------------------------------------------
  // Driven from onBeforeRender because that is the only hook this module has on
  // the renderer and the live camera. Mirroring the camera about the lake plane
  // by reflecting its position, target and up (rather than by a determinant -1
  // matrix) keeps the winding order intact, and the sample lookup below uses
  // the same virtual camera, so the two flips cancel for points on the plane.
  const dbSize = new THREE.Vector2();
  const camPos = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const camUp = new THREE.Vector3();
  const hiddenSky: THREE.Object3D[] = [];
  let framesSinceRefl = 1e9;
  let reflPending = false;

  const renderReflection = (
    renderer: THREE.WebGLRenderer,
    renderScene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) => {
    if (!reflRT) return;
    camPos.setFromMatrixPosition(camera.matrixWorld);
    // Below the surface there is nothing to mirror; fall back to the sky.
    if (camPos.y <= seaLevel + 0.05) {
      uniforms.uReflValid.value = 0;
      return;
    }

    renderer.getDrawingBufferSize(dbSize);
    const w = reflSize;
    const h = Math.max(16, Math.round((reflSize * dbSize.y) / Math.max(dbSize.x, 1)));
    if (reflRT.width !== w || reflRT.height !== h) reflRT.setSize(w, h);

    lookTarget.set(0, 0, -1).transformDirection(camera.matrixWorld).multiplyScalar(64).add(camPos);
    camUp.set(0, 1, 0).transformDirection(camera.matrixWorld);

    reflCam.position.set(camPos.x, 2 * seaLevel - camPos.y, camPos.z);
    reflCam.up.set(camUp.x, -camUp.y, camUp.z);
    reflCam.lookAt(lookTarget.x, 2 * seaLevel - lookTarget.y, lookTarget.z);
    reflCam.near = camera.near;
    reflCam.far = camera.far;
    reflCam.updateMatrixWorld(true);
    reflCam.projectionMatrix.copy(camera.projectionMatrix);
    reflCam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);

    uniforms.uReflViewProj.value
      .multiplyMatrices(reflCam.projectionMatrix, reflCam.matrixWorldInverse);
    uniforms.uReflInvViewProj.value
      .multiplyMatrices(reflCam.matrixWorld, reflCam.projectionMatrixInverse);

    const prevTarget = renderer.getRenderTarget();
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;

    mesh.visible = false;
    hiddenSky.length = 0;
    for (const child of renderScene.children) {
      if (child.visible && child !== mesh && child.renderOrder <= SKY_RENDER_ORDER) {
        hiddenSky.push(child);
        child.visible = false;
      }
    }

    // This runs re-entrantly inside another module's draw call, so a throw here
    // would leave the lake and the sky dome invisible for the rest of the frame.
    try {
      renderer.setRenderTarget(reflRT);
      renderer.render(renderScene, reflCam);
      uniforms.uReflValid.value = 1;
    } finally {
      for (const child of hiddenSky) child.visible = true;
      hiddenSky.length = 0;
      mesh.visible = true;
      renderer.setRenderTarget(prevTarget);
      renderer.shadowMap.autoUpdate = prevShadowAuto;
    }
  };

  if (useReflection) {
    mesh.onBeforeRender = (renderer, renderScene, camera) => {
      if (!reflPending) return;
      const cam = camera as THREE.PerspectiveCamera;
      if (!cam.isPerspectiveCamera) return;
      reflPending = false;
      renderReflection(renderer, renderScene as THREE.Scene, cam);
    };
  }

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

  const fadeRange = (x: number, z: number): number =>
    warpRange(x, z, Math.hypot(x - camXZ.x, z - camXZ.y));

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
      const dist = fadeRange(out.x, out.y);
      for (const w of WAVES) {
        const k = (2 * Math.PI) / w.wavelength;
        const a = (w.steepness * bandFade(w.wavelength, dist)) / k;
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
    const dist = fadeRange(px, pz);
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
    const dist = fadeRange(px, pz);

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

  const skyIrr = new THREE.Vector3();

  /**
   * Pull every radiometric quantity out of `atmosphere` so the lake can never
   * disagree with the sky about how bright the sun is. The sky irradiance is a
   * 24-direction cosine-weighted quadrature of the same scattering integral.
   */
  const syncAtmosphere = () => {
    uniforms.uSunDirection.value.copy(atmosphere.sunDirection);
    uniforms.uSunTint.value.set(atmosphere.sunTint.r, atmosphere.sunTint.g, atmosphere.sunTint.b);
    uniforms.uRayleigh.value = atmosphere.rayleigh;
    uniforms.uMie.value = atmosphere.mie;
    uniforms.uMieG.value = atmosphere.mieG;
    uniforms.uSkyLuminance.value = atmosphere.skyLuminance;
    uniforms.uAerialR.value = atmosphere.aerialRayleigh;
    uniforms.uAerialM.value = atmosphere.aerialMie;

    atmosphereRadianceCPU(atmosphere.sunDirection);
    uniforms.uSunIrradiance.value.set(
      SUN_IRRADIANCE_TOA * atmosphere.sunTint.r * trTmp[0],
      SUN_IRRADIANCE_TOA * atmosphere.sunTint.g * trTmp[1],
      SUN_IRRADIANCE_TOA * atmosphere.sunTint.b * trTmp[2],
    );

    skyIrr.set(0, 0, 0);
    for (const d of HEMI_DIRS) {
      atmosphereRadianceCPU(d);
      skyIrr.x += radTmp[0] * d.y;
      skyIrr.y += radTmp[1] * d.y;
      skyIrr.z += radTmp[2] * d.y;
    }
    uniforms.uSkyIrradiance.value.copy(skyIrr).multiplyScalar((2 * Math.PI) / HEMI_DIRS.length);
  };

  syncAtmosphere();

  const update = (dt: number, elapsed: number, cameraPos: THREE.Vector3) => {
    time = elapsed;
    uniforms.uTime.value = elapsed;
    uniforms.uCameraPos.value.copy(cameraPos);
    camXZ.set(cameraPos.x, cameraPos.z);
    syncAtmosphere();

    if (useReflection) {
      framesSinceRefl++;
      if (framesSinceRefl >= reflInterval) {
        framesSinceRefl = 0;
        reflPending = true;
      }
    }

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
    mesh.onBeforeRender = () => {};
    geo.dispose();
    material.dispose();
    bedTex.dispose();
    reflRT?.depthTexture?.dispose();
    reflRT?.dispose();
    scene.remove(mesh);
  };

  return { mesh, material, sampleHeight, sampleNormal, addWake, update, dispose };
}
