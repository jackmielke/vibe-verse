/**
 * San Palmas — the bay.
 *
 * One camera-locked radial mesh covers the entire Pacific + bay: rings grow
 * exponentially outward so the surface is sub-metre dense under the player's
 * feet and kilometre-coarse at the horizon, for a single draw call.
 *
 * The surface itself is a custom ShaderMaterial:
 *   • six Gerstner waves (real directional swell, deep-water dispersion, per
 *     wave distance geomorph so short chop dies before it can alias);
 *   • Beer–Lambert depth colour — bleached sand showing through turquoise
 *     shallows, falling away to sapphire over the deep;
 *   • an exact GLSL port of the atlas coastline SDF driving the surf band, so
 *     the foam sits on the shoreline the atlas defines, not on a low-res
 *     approximation of it;
 *   • Schlick fresnel against an analytic sky, a two-lobe sun specular and a
 *     sparkle lobe riding procedurally generated normal maps;
 *   • back-face shading for when the player swims, with a Snell's-window
 *     brightening and caustic shimmer.
 *
 * NO EXTERNAL ASSETS: the wave normal map, the foam/bubble map and the bay
 * depth map are all generated here at boot (value-noise fBm, periodic Worley,
 * and a bake of `TerrainService.heightAt`).
 *
 * Reads: TerrainService (depth bake), SkyService (sun + daylight), scene
 * background/fog (sky palette + aerial perspective). All optional — the module
 * falls back to the atlas and to golden-hour defaults if a service is missing.
 */
import * as THREE from "three";
import type { QualityTier, System, SystemFactory, WorldCtx } from "../types";
import {
  LAND_RADIUS,
  SEA_LEVEL,
  STRAIT,
  WORLD_SIZE,
  hillHeight,
  landSignedDistance,
  shoreProfile,
} from "./atlas";

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

/** Radius of the water disc. Comfortably inside the camera far plane. */
const DISC_RADIUS = 11000;
/** Innermost ring radius — keeps the fan from degenerating at the camera. */
const DISC_INNER = 0.35;
/** Ring growth exponent. Higher = denser near the camera, coarser far out. */
const DISC_FALLOFF = 7.6;

/** Extent of the baked depth map, metres from the origin. Overshoots the map. */
const MAP_HALF = 3300;
/** Depth encoded in the R channel spans 0..this, metres. */
const DEPTH_RANGE = 260;
/** Depth encoded in the G channel spans 0..this — the shallows, at 16× the precision. */
const SHORE_RANGE = 16;

interface WaterTier {
  /** Radial segments around the disc. */
  segments: number;
  /** Concentric rings from the camera out to DISC_RADIUS. */
  rings: number;
  /** Baked depth map resolution (square, power of two-ish). */
  depthMap: number;
  /** Procedural normal/foam texture resolution. */
  detailMap: number;
}

const TIERS: Record<QualityTier, WaterTier> = {
  low: { segments: 96, rings: 84, depthMap: 256, detailMap: 128 },
  medium: { segments: 144, rings: 110, depthMap: 384, detailMap: 256 },
  high: { segments: 208, rings: 150, depthMap: 512, detailMap: 256 },
  ultra: { segments: 288, rings: 190, depthMap: 768, detailMap: 512 },
};

/**
 * The swell stack. `dir` is the propagation direction on the XZ plane, `amp`
 * the crest height in metres, `len` the wavelength in metres, `q` the
 * horizontal steepness (how far crests pinch toward each other).
 *
 * Wave 1 is the Pacific groundswell rolling in from the west; 2–3 are local
 * wind swell crossing it; 4–6 are chop that only exists near the camera.
 */
const WAVES: { dir: [number, number]; amp: number; len: number; q: number; speed: number }[] = [
  { dir: [1.0, 0.18], amp: 1.45, len: 150, q: 0.72, speed: 1.0 },
  { dir: [0.82, -0.57], amp: 0.8, len: 88, q: 0.62, speed: 1.04 },
  { dir: [0.55, 0.83], amp: 0.38, len: 45, q: 0.55, speed: 1.1 },
  { dir: [-0.28, 0.96], amp: 0.19, len: 24, q: 0.5, speed: 1.16 },
  { dir: [0.94, -0.34], amp: 0.095, len: 12, q: 0.42, speed: 1.25 },
  { dir: [-0.72, -0.69], amp: 0.045, len: 6, q: 0.35, speed: 1.4 },
];

const MAX_AMPLITUDE = WAVES.reduce((s, w) => s + w.amp, 0);

/* ------------------------------------------------------------------------ *
 * Procedural texture generation
 * ------------------------------------------------------------------------ */

/** Integer hash → [0,1). Cheap, well-mixed, and stable across platforms. */
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smoothstep-interpolated value noise on a wrapping lattice, so it tiles. */
function periodicValueNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** Tiling fBm. `basePeriod` is in lattice cells across the full [0,1) tile. */
function periodicFbm(u: number, v: number, basePeriod: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += periodicValueNoise(u * period, v * period, period, seed + o * 7919) * amp;
    norm += amp;
    amp *= 0.52;
    period *= 2;
  }
  return sum / norm;
}

/** Tiling Worley F1 distance in [0,1). Gives foam its organic clumping. */
function periodicWorley(u: number, v: number, cells: number, seed: number): number {
  const cx = Math.floor(u * cells);
  const cy = Math.floor(v * cells);
  let best = 4;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const gx = cx + ox;
      const gy = cy + oy;
      const wx = ((gx % cells) + cells) % cells;
      const wy = ((gy % cells) + cells) % cells;
      const px = (gx + hash2(wx, wy, seed)) / cells;
      const py = (gy + hash2(wx, wy, seed + 4451)) / cells;
      const dx = px - u;
      const dy = py - v;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best) * cells);
}

/**
 * Wave detail normal map. A height field of tiling fBm, stretched slightly
 * along X so the ripples read as wind-driven rather than isotropic mush, then
 * finite-differenced into a tangent-space normal. Alpha carries the height so
 * the fragment shader can pick out micro-crests for sparkle.
 */
function makeWaveNormalTexture(size: number, seed: number): THREE.DataTexture {
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Two lobes with different anisotropy make crossing ripple trains.
      const a = periodicFbm(u, v, 8, 5, seed);
      const b = periodicFbm(v * 0.98 + 0.13, u * 1.02, 12, 4, seed + 131);
      height[y * size + x] = a * 0.62 + b * 0.38;
    }
  }

  const data = new Uint8Array(size * size * 4);
  // Slope scale: how much of a bump the height field represents.
  const scale = size * 0.055;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = height[y * size + ((x - 1 + size) % size)];
      const xr = height[y * size + ((x + 1) % size)];
      const yd = height[((y - 1 + size) % size) * size + x];
      const yu = height[((y + 1) % size) * size + x];
      let nx = (xl - xr) * scale;
      let ny = (yd - yu) * scale;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      const i = (y * size + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      data[i + 3] = Math.round(height[y * size + x] * 255);
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Foam map. R is clumpy surf (Worley, inverted, contrast-pushed), G is fine
 * bubble speckle, B is a slow large-scale mask that breaks the surf line into
 * patches so it never reads as a painted stripe.
 */
function makeFoamTexture(size: number, seed: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Warp the Worley lookup so the cells stop looking like cells.
      const wx = u + (periodicFbm(u, v, 6, 3, seed + 11) - 0.5) * 0.14;
      const wy = v + (periodicFbm(u + 0.37, v + 0.71, 6, 3, seed + 23) - 0.5) * 0.14;
      const clump = 1 - periodicWorley(((wx % 1) + 1) % 1, ((wy % 1) + 1) % 1, 10, seed);
      const bubbles = periodicFbm(u, v, 26, 3, seed + 57);
      const patch = periodicFbm(u, v, 3, 3, seed + 91);
      const i = (y * size + x) * 4;
      data[i] = Math.round(Math.min(1, Math.pow(clump, 1.6) * 1.35) * 255);
      data[i + 1] = Math.round(Math.min(1, Math.pow(bubbles, 1.9) * 1.8) * 255);
      data[i + 2] = Math.round(patch * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Bake the bay floor once at boot.
 *   R = depth / DEPTH_RANGE   (the whole water column, coarse)
 *   G = depth / SHORE_RANGE   (the shallows, 16× the precision)
 *   B = seabed slope, 0..1    (gentle beaches get a wider surf band)
 *
 * Prefers `TerrainService.heightAt` so the water agrees with whatever the
 * terrain module actually built; falls back to the atlas profile so we still
 * look right if terrain hasn't published yet.
 */
function bakeDepthTexture(ctx: WorldCtx, size: number): THREE.DataTexture {
  const terrain = ctx.services.terrain;
  const sea = terrain?.seaLevel ?? SEA_LEVEL;
  const heightAt = terrain
    ? (x: number, z: number) => terrain.heightAt(x, z)
    : (x: number, z: number) => shoreProfile(landSignedDistance(x, z)) + hillHeight(x, z);

  const data = new Uint8Array(size * size * 4);
  const step = (MAP_HALF * 2) / (size - 1);

  // One row of heights is reused as the previous row for the slope difference.
  const row = new Float32Array(size);
  const prev = new Float32Array(size);

  for (let j = 0; j < size; j++) {
    const z = -MAP_HALF + j * step;
    for (let i = 0; i < size; i++) {
      row[i] = heightAt(-MAP_HALF + i * step, z);
    }
    for (let i = 0; i < size; i++) {
      const h = row[i];
      const depth = Math.max(0, sea - h);
      const dx = (row[Math.min(size - 1, i + 1)] - row[Math.max(0, i - 1)]) / (2 * step);
      const dz = j === 0 ? 0 : (h - prev[i]) / step;
      const slope = Math.min(1, Math.hypot(dx, dz) * 3.2);
      const k = (j * size + i) * 4;
      data[k] = Math.round(Math.min(1, depth / DEPTH_RANGE) * 255);
      data[k + 1] = Math.round(Math.min(1, depth / SHORE_RANGE) * 255);
      data[k + 2] = Math.round(slope * 255);
      data[k + 3] = 255;
    }
    prev.set(row);
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------------ *
 * Geometry — a camera-locked radial LOD disc
 * ------------------------------------------------------------------------ */

/**
 * Concentric rings whose radii grow exponentially. Ring spacing is ~0.5 m at
 * the camera and ~600 m at the horizon, which puts the vertex budget exactly
 * where the waves are legible. Waves are evaluated in world space in the
 * shader, so the disc can slide with the camera without the swell sliding
 * with it.
 */
function buildDisc(segments: number, rings: number): THREE.BufferGeometry {
  const vertexCount = 1 + rings * segments;
  const positions = new Float32Array(vertexCount * 3);
  const expDenom = Math.exp(DISC_FALLOFF) - 1;

  // Centre vertex.
  positions[0] = 0;
  positions[1] = 0;
  positions[2] = 0;

  let p = 3;
  for (let r = 0; r < rings; r++) {
    const t = (r + 1) / rings;
    const radius = DISC_INNER + (DISC_RADIUS - DISC_INNER) * ((Math.exp(t * DISC_FALLOFF) - 1) / expDenom);
    // Twist each ring slightly so the radial spokes don't line up into a
    // visible star pattern under grazing specular.
    const twist = r * 0.37;
    for (let s = 0; s < segments; s++) {
      const a = ((s + 0.5) / segments) * Math.PI * 2 + twist;
      positions[p++] = Math.cos(a) * radius;
      positions[p++] = 0;
      positions[p++] = Math.sin(a) * radius;
    }
  }

  const triCount = segments + (rings - 1) * segments * 2;
  const indices = vertexCount > 65535 ? new Uint32Array(triCount * 3) : new Uint16Array(triCount * 3);
  let ix = 0;

  // Centre fan. Wound so the +Y face is the front face — the surface renders
  // DoubleSide, but nothing downstream should have to guess which way is up.
  for (let s = 0; s < segments; s++) {
    indices[ix++] = 0;
    indices[ix++] = 1 + ((s + 1) % segments);
    indices[ix++] = 1 + s;
  }

  // Ring bands.
  for (let r = 0; r < rings - 1; r++) {
    const a0 = 1 + r * segments;
    const b0 = 1 + (r + 1) * segments;
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      indices[ix++] = a0 + s;
      indices[ix++] = a0 + s1;
      indices[ix++] = b0 + s;
      indices[ix++] = a0 + s1;
      indices[ix++] = b0 + s1;
      indices[ix++] = b0 + s;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  // The disc is repositioned every frame and displaced in the shader; there is
  // nothing sensible to cull against.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), DISC_RADIUS * 2);
  return geo;
}

/* ------------------------------------------------------------------------ *
 * Shaders
 * ------------------------------------------------------------------------ */

/**
 * An exact GLSL transcription of `landSignedDistance` from the atlas. Keeping
 * it verbatim is the whole point: the surf line lands on the atlas coastline
 * at pixel precision, no matter what resolution the depth bake ran at.
 * If the atlas coastline ever changes, this must change with it.
 */
const COAST_SDF_GLSL = /* glsl */ `
float landSDF(vec2 p) {
  float r = length(vec2(p.x, (p.y + 120.0) * 0.86));
  float d = ${LAND_RADIUS.toFixed(1)} - r;
  float bay = 1180.0 - length(vec2((p.x - 980.0) * 0.78, (p.y + 900.0) * 1.05));
  d = min(d, -bay);
  if (p.y > ${STRAIT.zFrom.toFixed(1)} && p.y < ${STRAIT.zTo.toFixed(1)}) {
    float channel = ${STRAIT.halfWidth.toFixed(1)} - abs(p.x - (${STRAIT.x.toFixed(1)}));
    float endFade = min(1.0, min(p.y - (${STRAIT.zFrom.toFixed(1)}), ${STRAIT.zTo.toFixed(1)} - p.y) / 160.0);
    d = min(d, -channel * endFade);
  }
  d = min(d, p.x + 1560.0);
  float wob = sin(p.x * 0.0034 + p.y * 0.0021) * 52.0
            + sin(p.x * 0.0091 - p.y * 0.0072) * 24.0
            + sin(p.y * 0.0157 + 1.7) * 11.0;
  return d + wob;
}
`;

/** Shared depth-map decode. Blends the fine shallow channel into the coarse one. */
const DEPTH_SAMPLE_GLSL = /* glsl */ `
uniform sampler2D uDepthMap;
uniform vec2 uMapOrigin;
uniform float uMapInvSize;

// x = depth in metres, y = seabed slope 0..1
vec2 sampleSeabed(vec2 worldXZ) {
  vec2 uv = (worldXZ - uMapOrigin) * uMapInvSize;
  // Outside the baked map it is open ocean all the way down.
  vec2 c = clamp(uv, vec2(0.0), vec2(1.0));
  // Ramp hard to the abyss past the map edge so the open Pacific never
  // inherits the shelf colour clamped in from the border texel.
  float outside = min(length(uv - c) * 3000.0, ${DEPTH_RANGE.toFixed(1)});
  vec4 s = texture2D(uDepthMap, c);
  float fine = s.g * ${SHORE_RANGE.toFixed(1)};
  float coarse = s.r * ${DEPTH_RANGE.toFixed(1)};
  float depth = mix(fine, max(coarse, ${SHORE_RANGE.toFixed(1)}), smoothstep(0.88, 1.0, s.g));
  return vec2(depth + outside, s.b);
}
`;

const WATER_VERT = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uSeaLevel;
uniform vec4  uWaveA[6];   // xy = direction, z = amplitude, w = wavelength
uniform vec2  uWaveB[6];   // x = steepness, y = speed multiplier
uniform float uWaveGain;

varying vec3  vWorldPos;
varying vec3  vWaveNormal;
varying float vDepth;
varying float vSeabedSlope;
varying float vShoreDist;
varying float vCrest;
varying float vFold;
varying float vViewDist;

${DEPTH_SAMPLE_GLSL}
${COAST_SDF_GLSL}

#include <fog_pars_vertex>

void main() {
  vec3 base = (modelMatrix * vec4(position, 1.0)).xyz;
  base.y = uSeaLevel;

  float viewDist = length(base.xz - cameraPosition.xz);
  vViewDist = viewDist;

  vec2 seabed = sampleSeabed(base.xz);
  float depth = seabed.x;
  vDepth = depth;
  vSeabedSlope = seabed.y;

  float sdf = landSDF(base.xz);
  vShoreDist = -sdf;

  // Shoaling: swell collapses as the bottom comes up, and we hard-mute it at
  // the waterline so crests can never punch up through the beach.
  float shoal = smoothstep(0.4, 15.0, depth);
  // NB: edge0 < edge1 — smoothstep with reversed edges is undefined in GLSL.
  float landMute = 1.0 - smoothstep(-55.0, -4.0, sdf);
  float gain = uWaveGain * mix(0.05, 1.0, min(shoal, landMute));

  vec3 displaced = base;
  vec3 n = vec3(0.0, 1.0, 0.0);
  float fold = 0.0;
  float crest = 0.0;

  for (int i = 0; i < 6; i++) {
    vec2 dir = normalize(uWaveA[i].xy);
    float amp = uWaveA[i].z * gain;
    float len = uWaveA[i].w;
    float steep = uWaveB[i].x;
    float speedMul = uWaveB[i].y;

    // Per-wave geomorph: a wave fades out once the ring spacing can no longer
    // resolve it. Short chop is gone by a few hundred metres; the groundswell
    // survives to the horizon. This is what keeps the distance free of
    // shimmering vertex noise.
    float fade = 1.0 - smoothstep(len * 11.0, len * 38.0, viewDist);
    if (fade <= 0.001) continue;

    float k = 6.2831853 / len;
    float c = sqrt(9.81 / k) * speedMul;      // deep-water dispersion
    float phase = k * dot(dir, base.xz) - c * k * uTime;
    float sinP = sin(phase);
    float cosP = cos(phase);
    float a = amp * fade;
    float wa = k * a;

    displaced.xz += dir * (steep * a * cosP);
    displaced.y  += a * sinP;

    n.x -= dir.x * wa * cosP;
    n.z -= dir.y * wa * cosP;
    fold += steep * wa * sinP;
    crest += a * sinP;
  }

  n.y = 1.0 - fold;
  vWaveNormal = normalize(n);
  vFold = fold;
  vCrest = clamp(crest / max(0.001, ${MAX_AMPLITUDE.toFixed(3)} * gain), -1.0, 1.0);
  vWorldPos = displaced;

  vec4 mvPosition = viewMatrix * vec4(displaced, 1.0);
  #ifdef USE_FOG
    vFogDepth = -mvPosition.z;
  #endif
  gl_Position = projectionMatrix * mvPosition;
}
`;

const WATER_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uSeaLevel;
uniform sampler2D uWaveNormalMap;
uniform sampler2D uFoamMap;

uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uZenithColor;
uniform vec3  uHorizonColor;
uniform vec3  uHazeColor;
uniform float uDaylight;

uniform vec3  uShallowColor;
uniform vec3  uMidColor;
uniform vec3  uDeepColor;
uniform vec3  uSandColor;
uniform vec3  uFoamColor;

uniform float uDetailStrength;
uniform float uFoamWidth;

varying vec3  vWorldPos;
varying vec3  vWaveNormal;
varying float vDepth;
varying float vSeabedSlope;
varying float vShoreDist;
varying float vCrest;
varying float vFold;
varying float vViewDist;

${DEPTH_SAMPLE_GLSL}
${COAST_SDF_GLSL}

#include <fog_pars_fragment>

float sat(float x) { return clamp(x, 0.0, 1.0); }

/** Analytic sky used for the fresnel reflection. Matches the sky module's palette. */
vec3 skyRadiance(vec3 dir) {
  float up = clamp(dir.y, -1.0, 1.0);
  vec3 col = mix(uHorizonColor, uZenithColor, pow(sat(up), 0.55));
  // Warm haze packed against the horizon — the aerial-perspective anchor.
  col = mix(col, uHazeColor, exp(-sat(up) * 13.0) * 0.7);
  float sd = sat(dot(dir, uSunDir));
  col += uSunColor * (pow(sd, 900.0) * 26.0 + pow(sd, 40.0) * 0.55 + pow(sd, 5.0) * 0.10);
  // Anything reflecting below the horizon just gets more haze.
  return mix(uHazeColor * 0.72, col, smoothstep(-0.14, 0.03, up));
}

/** Two scrolling octaves of the procedural ripple map, distance-attenuated. */
vec3 detailNormal(vec2 p, float fadeFine, float fadeCoarse) {
  vec2 a = texture2D(uWaveNormalMap, p * 0.0092 + vec2(0.0062, 0.0037) * uTime).xy * 2.0 - 1.0;
  vec2 b = texture2D(uWaveNormalMap, p * 0.0410 - vec2(0.0135, 0.0190) * uTime).xy * 2.0 - 1.0;
  vec2 c = texture2D(uWaveNormalMap, p * 0.1700 + vec2(0.0310, -0.0240) * uTime).xy * 2.0 - 1.0;
  vec2 slope = a * fadeCoarse + b * (0.65 * mix(fadeFine, fadeCoarse, 0.4)) + c * (0.38 * fadeFine);
  return vec3(slope.x, 0.0, slope.y);
}

void main() {
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float viewDist = vViewDist;

  // ---- Normal --------------------------------------------------------------
  // Fine ripples die within a kilometre so the horizon cannot alias; the
  // coarse octave survives far enough to keep distant water from going glassy.
  float fadeFine = 1.0 - smoothstep(70.0, 850.0, viewDist);
  float fadeCoarse = 1.0 - smoothstep(600.0, 4200.0, viewDist);
  float rippleMute = mix(0.25, 1.0, smoothstep(0.2, 6.0, vDepth));
  vec3 detail = detailNormal(vWorldPos.xz, fadeFine, fadeCoarse);
  vec3 N = normalize(vWaveNormal + detail * uDetailStrength * rippleMute);

  // Which side are we on? Derived from the camera rather than gl_FrontFacing:
  // the disc is DoubleSide and the answer has to stay stable no matter how the
  // rings happen to be wound.
  bool below = cameraPosition.y < uSeaLevel;
  if (below) N = -N;

  float ndv = sat(dot(N, viewDir));

  // ---- Lighting basis ------------------------------------------------------
  float sunUp = smoothstep(-0.06, 0.10, uSunDir.y);   // only fades as the sun sets
  vec3 ambient = mix(vec3(0.10, 0.15, 0.26), vec3(1.0), sat(uDaylight));
  float diffuse = 0.55 + 0.45 * sat(dot(N, uSunDir));

  // ==========================================================================
  // Underwater: the player is swimming and we are looking at the underside.
  // ==========================================================================
  if (below) {
    // Snell's window — a bright cone straight up, total internal reflection
    // everywhere else.
    float snell = smoothstep(0.55, 0.94, ndv);
    vec3 through = skyRadiance(normalize(vec3(viewDir.x * 0.4, abs(viewDir.y) + 0.45, viewDir.z * 0.4)));
    vec3 tir = uDeepColor * 2.2 + uMidColor * 0.35;
    vec3 col = mix(tir, through, snell);

    // Caustic shimmer crawling across the underside.
    float caus = texture2D(uWaveNormalMap, vWorldPos.xz * 0.055 + uTime * vec2(0.02, -0.013)).a
               * texture2D(uWaveNormalMap, vWorldPos.xz * 0.031 - uTime * vec2(0.016, 0.021)).a;
    col += uSunColor * pow(sat(caus * 2.4 - 0.55), 2.5) * 0.9 * sat(uDaylight);
    col *= ambient;

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
    return;
  }

  // ==========================================================================
  // Above water
  // ==========================================================================

  // ---- Depth colour (Beer–Lambert-ish, hand-graded for the tropics) --------
  float d = vDepth;
  vec3 body = mix(uShallowColor, uMidColor, smoothstep(0.0, 9.0, d));
  body = mix(body, uDeepColor, smoothstep(8.0, 70.0, d));

  // Bleached sand transmitting through the shallows — the single strongest
  // "tropical" cue in the whole frame.
  float sandVis = exp(-d * 0.34);
  // Ripple caustics dancing on the sandbars.
  float caustic = texture2D(uWaveNormalMap, vWorldPos.xz * 0.075 + uTime * vec2(0.015, 0.011)).a
                * texture2D(uWaveNormalMap, vWorldPos.xz * 0.049 - uTime * vec2(0.010, 0.017)).a;
  vec3 sand = uSandColor * (0.85 + pow(sat(caustic * 2.3 - 0.5), 2.0) * 1.1);
  body = mix(body, mix(sand, body, 0.30), sandVis * 0.88);

  body *= ambient * diffuse;

  // ---- Sub-surface scatter through the crests ------------------------------
  // Sun behind a wave lights the water up green-teal along the crest line.
  float backlit = pow(sat(-dot(viewDir, uSunDir) * 0.5 + 0.5), 3.0);
  float crestUp = sat(vCrest);
  body += uShallowColor * uSunColor * backlit * crestUp * 0.55 * sat(uDaylight) * (1.0 - smoothstep(400.0, 2000.0, viewDist));

  // ---- Fresnel reflection --------------------------------------------------
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  fres = clamp(fres, 0.02, 0.92);
  vec3 R = normalize(reflect(-viewDir, N));
  R.y = abs(R.y) * 0.85 + 0.02;             // never sample the underside
  R = normalize(R);
  vec3 reflection = skyRadiance(R);

  vec3 col = mix(body, reflection, fres);

  // ---- Sun specular: a tight disc lobe plus a broad glitter path -----------
  float spec = sat(dot(R, uSunDir));
  // As the fine normals fade out with distance the sub-pixel roughness has to
  // come back as a wider lobe, or the glitter path collapses to a hard line.
  float tight = pow(spec, mix(160.0, 1100.0, fadeFine));
  float broad = pow(spec, mix(14.0, 70.0, fadeFine));
  col += uSunColor * (tight * 3.4 + broad * 0.30) * sat(uDaylight) * sunUp;

  // ---- Sparkle: micro-facets that only exist up close ----------------------
  float sparkNoise = texture2D(uWaveNormalMap, vWorldPos.xz * 0.62 + uTime * vec2(0.09, -0.07)).a;
  float spark = pow(sat(sparkNoise * 1.7 - 0.72), 3.0) * pow(spec, 26.0);
  col += uSunColor * spark * 5.0 * fadeFine * sat(uDaylight);

  // ==========================================================================
  // Foam
  // ==========================================================================
  vec3 foamTint = uFoamColor * ambient * (0.55 + 0.45 * diffuse);

  vec4 foamTex = texture2D(uFoamMap, vWorldPos.xz * 0.030);
  vec4 foamFine = texture2D(uFoamMap, vWorldPos.xz * 0.115);

  // ---- Shoreline surf ------------------------------------------------------
  // Only the coastal strip pays for the SDF gradient. The branch is spatially
  // coherent, so whole warps take the cheap path out over the open bay.
  float surf = 0.0;
  if (vShoreDist < 260.0 && vDepth < 14.0) {
    // Direction the swell runs up the beach: the gradient of the coastline SDF.
    vec2 g = vec2(
      landSDF(vWorldPos.xz + vec2(6.0, 0.0)) - landSDF(vWorldPos.xz - vec2(6.0, 0.0)),
      landSDF(vWorldPos.xz + vec2(0.0, 6.0)) - landSDF(vWorldPos.xz - vec2(0.0, 6.0))
    );
    vec2 shoreDir = normalize(g + vec2(0.00001, 0.00001));

    // Gentle beaches spread the surf wide; steep rock keeps it tight.
    float width = uFoamWidth * mix(2.1, 0.55, vSeabedSlope);

    float shoreT = 1.0 - smoothstep(0.0, width, max(vShoreDist, 0.0));
    // Gate on the baked depth too, so the surf can never appear over open water
    // if terrain and atlas ever drift apart.
    shoreT *= 1.0 - smoothstep(1.0, 11.0, vDepth);

    // Sets of breakers marching in, each one steepening as it lands.
    float march = vShoreDist * 0.085 + uTime * 0.55;
    float pulse = pow(sin(march) * 0.5 + 0.5, 2.2);
    float pulse2 = pow(sin(march * 0.47 + 1.7) * 0.5 + 0.5, 3.0);

    // The foam sheet drifts shoreward rather than sitting pinned to the world.
    vec4 drift = texture2D(uFoamMap, vWorldPos.xz * 0.030 - shoreDir * (uTime * 0.020));
    vec4 driftFine = texture2D(uFoamMap, vWorldPos.xz * 0.115 + shoreDir * (uTime * 0.010));

    surf = shoreT * (0.30 + 0.70 * max(pulse, pulse2 * 0.8));
    surf *= mix(0.45, 1.25, drift.r) * mix(0.7, 1.3, drift.b);
    // The very last metres of wash are almost solid white.
    surf = max(surf, shoreT * shoreT * shoreT * 1.15 * mix(0.6, 1.0, driftFine.g));
    surf = sat(surf);
  }

  // ---- Whitecaps on open-water crests --------------------------------------
  float capDrive = sat(vCrest * 0.72 + vFold * 0.9 - 0.30);
  float caps = smoothstep(0.20, 0.62, capDrive) * smoothstep(3.0, 20.0, vDepth);
  caps *= mix(0.25, 1.0, foamTex.r) * mix(0.4, 1.0, foamFine.g);
  caps *= 1.0 - smoothstep(1500.0, 5000.0, viewDist);

  float foam = sat(max(surf, caps * 0.85));
  col = mix(col, foamTint, foam);

  // ---- Horizon resolve -----------------------------------------------------
  // Past the fog the disc edge must not be a visible rim. Fold the last few
  // kilometres into the haze by hand in case the sky runs without fog.
  col = mix(col, uHazeColor, smoothstep(6000.0, 10400.0, viewDist) * 0.94);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/* ------------------------------------------------------------------------ *
 * System
 * ------------------------------------------------------------------------ */

const createWater: SystemFactory = (ctx) => {
  const tier = TIERS[ctx.quality] ?? TIERS.high;
  const seaLevel = ctx.services.terrain?.seaLevel ?? SEA_LEVEL;
  const seed = Math.floor(ctx.rng() * 0xffffff);

  const waveNormalMap = makeWaveNormalTexture(tier.detailMap, seed);
  const foamMap = makeFoamTexture(tier.detailMap, seed + 977);
  const depthMap = bakeDepthTexture(ctx, tier.depthMap);

  const maxAniso = ctx.renderer.capabilities.getMaxAnisotropy?.() ?? 1;
  waveNormalMap.anisotropy = Math.min(8, maxAniso);
  foamMap.anisotropy = Math.min(8, maxAniso);

  // Golden-hour defaults. Overwritten every frame from the sky service and the
  // scene's own background/fog, so we track whatever the sky module does.
  const sunDir = new THREE.Vector3(0.52, 0.42, 0.34).normalize();
  const sunColor = new THREE.Color(0xffd9a0);
  const horizonColor = new THREE.Color(0x9fd6ea);
  const zenithColor = new THREE.Color(0x2f7fc9);
  const hazeColor = new THREE.Color(0xbfe0ea);

  const uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uSeaLevel: { value: seaLevel },

    uWaveA: {
      value: WAVES.map((w) => new THREE.Vector4(w.dir[0], w.dir[1], w.amp, w.len)),
    },
    uWaveB: { value: WAVES.map((w) => new THREE.Vector2(w.q, w.speed)) },
    uWaveGain: { value: 1 },

    uDepthMap: { value: depthMap },
    uMapOrigin: { value: new THREE.Vector2(-MAP_HALF, -MAP_HALF) },
    uMapInvSize: { value: 1 / (MAP_HALF * 2) },

    uWaveNormalMap: { value: waveNormalMap },
    uFoamMap: { value: foamMap },

    uSunDir: { value: sunDir },
    uSunColor: { value: sunColor },
    uZenithColor: { value: zenithColor },
    uHorizonColor: { value: horizonColor },
    uHazeColor: { value: hazeColor },
    uDaylight: { value: 1 },

    // Graded against ACES + sRGB output. Shallows read turquoise, the deep
    // reads sapphire, and the sand is bleached rather than yellow.
    uShallowColor: { value: new THREE.Color(0x36d6c2) },
    uMidColor: { value: new THREE.Color(0x0d6f9a) },
    uDeepColor: { value: new THREE.Color(0x04203f) },
    uSandColor: { value: new THREE.Color(0xe6d7b0) },
    uFoamColor: { value: new THREE.Color(0xf2fbff) },

    uDetailStrength: { value: ctx.quality === "low" ? 0.55 : 0.85 },
    uFoamWidth: { value: 26 },

    // Populated by the renderer when scene.fog is present (material.fog = true).
    fogColor: { value: new THREE.Color(0x9fd6ea) },
    fogNear: { value: 500 },
    fogFar: { value: 4200 },
    fogDensity: { value: 0.00025 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    // Rendered from below when the player swims, so both faces must shade.
    side: THREE.DoubleSide,
    fog: true,
    // Opaque: the water plane terminates exactly where the terrain rises
    // through it, which is a clean depth-buffer intersection. Going
    // transparent here would only buy sorting bugs against the vegetation.
    transparent: false,
    depthWrite: true,
  });

  const geometry = buildDisc(tier.segments, tier.rings);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "palmas:water";
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = true;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  // Draw after the opaque terrain/city so most of the bay is already
  // depth-rejected by the time this enormous surface is shaded.
  mesh.renderOrder = 1;
  mesh.position.set(0, seaLevel, 0);
  ctx.scene.add(mesh);

  const tmpColor = new THREE.Color();
  let wasSubmerged = false;

  const sys: System = {
    name: "water",

    lateUpdate(dt, c) {
      uniforms.uTime.value = c.elapsed;

      // Slide the disc under the camera. Waves are evaluated in world space in
      // the vertex shader, so the swell stays anchored to the world while the
      // vertex density stays anchored to the viewer.
      mesh.position.set(c.camera.position.x, seaLevel, c.camera.position.z);

      // ---- Sun -----------------------------------------------------------
      const sky = c.services.sky;
      if (sky) {
        sunDir.copy(sky.sunDirection).normalize();
        sunColor.copy(sky.sunColor);
        uniforms.uDaylight.value = sky.daylight;
        // Swell calms down overnight — small, but it stops the night bay from
        // looking like the same frame with the lights off.
        uniforms.uWaveGain.value = 0.72 + 0.28 * THREE.MathUtils.clamp(sky.daylight, 0, 1);
      }

      // ---- Sky palette, tracked from whatever the sky module set ----------
      const fog = c.scene.fog;
      if (fog) hazeColor.copy(fog.color);
      const bg = c.scene.background;
      if (bg && (bg as THREE.Color).isColor) {
        horizonColor.copy(bg as THREE.Color);
      } else if (fog) {
        // A real sky mesh / cube background gives us no colour to read, so the
        // fog is the next best proxy for where the horizon sits.
        horizonColor.copy(fog.color).multiplyScalar(1.05);
      }
      // Zenith is the horizon pushed deeper and bluer — cheap, and it keeps the
      // reflection consistent with the sky even as the time of day moves.
      zenithColor.copy(horizonColor).multiply(tmpColor.setRGB(0.42, 0.66, 1.06));

      // ---- Submersion notification ---------------------------------------
      const submerged = c.camera.position.y < seaLevel;
      if (submerged !== wasSubmerged) {
        wasSubmerged = submerged;
        c.emit("palmas:submerged", submerged);
        c.services.audio?.play(submerged ? "splash_in" : "splash_out", { volume: 0.6 });
      }
    },

    dispose() {
      ctx.scene.remove(mesh);
      geometry.dispose();
      material.dispose();
      waveNormalMap.dispose();
      foamMap.dispose();
      depthMap.dispose();
    },
  };

  return sys;
};

export default createWater;

/** Re-exported for anything that wants to know how tall the swell can get. */
export const WATER_MAX_WAVE_HEIGHT = MAX_AMPLITUDE;
/** Half-extent the depth bake covers, for debugging overlays. */
export const WATER_MAP_HALF = Math.min(MAP_HALF, WORLD_SIZE + 300);
