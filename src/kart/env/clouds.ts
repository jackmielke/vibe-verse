/**
 * The cloud deck — two or three scrolling sheets that give the sky a ceiling.
 *
 * Clouds are the difference between "there is a gradient above the track" and
 * "there is weather above the track". They are also the cheapest parallax cue
 * available: because each sheet's UV is derived from *world* XZ rather than
 * from the mesh, the mesh itself can be re-centred on the camera every frame
 * for infinite extent while the pattern stays nailed to the world. You get
 * genuine parallax against the scenery and a sky that never runs out.
 *
 * Shading is a fake, and an old one: a thickness field decides lit-edge versus
 * shadowed-core, and a second tap displaced *toward the sun* gives the silver
 * lining along whichever side is actually facing it. Two texture fetches buys
 * a cloud that responds to time of day. A real volumetric march buys the same
 * picture for two hundred times the price, and this project has a software
 * rasteriser to feed.
 */
import * as THREE from "three";
import type { KartQuality } from "../types";
import { clamp01, fbm2D, smoothstep } from "./noise";
import type { AtmosphereState } from "./atmosphere";

// ---------------------------------------------------------------------------
// The baked field
// ---------------------------------------------------------------------------

const TEX_SIZE: Record<KartQuality, number> = { low: 128, medium: 256, high: 256, ultra: 512 };

/**
 * One tiling RGBA field shared by every layer:
 *   R  core thickness      — drives the lit/shadow ramp
 *   G  softened thickness  — the same, blurred, so shading is not noisy
 *   B  high-frequency detail — erosion and sparkle
 *   A  coverage            — the silhouette
 *
 * Sharing one bake across the layers is deliberate: each layer reads it at a
 * different scale, rotation and coverage threshold, which decorrelates them
 * completely for the cost of a single 256² upload.
 */
function bakeCloudField(size: number, seed: number): THREE.DataTexture {
  const n = size * size;
  const dens = new Float32Array(n);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      // Domain warp from a single low octave. Because the warp field is itself
      // periodic over the tile, warping cannot break the seam — u + w(u,v) is
      // still periodic in u.
      const wx = fbm2D(u, v, { octaves: 1, period: 2, seed: seed + 7 }) - 0.5;
      const wy = fbm2D(u + 0.37, v + 0.11, { octaves: 1, period: 2, seed: seed + 31 }) - 0.5;
      const su = u + wx * 0.2;
      const sv = v + wy * 0.2;
      // Two fields, and the split matters. Billow noise alone gives long
      // stringy creases — its fold line *is* a crease — and a deck built from
      // it reads as torn paper. The broad smooth field supplies fat continuous
      // masses; the billow field only decorates their surface.
      const mass = fbm2D(su, sv, { octaves: 3, period: 2, gain: 0.56, seed });
      const puff = fbm2D(su, sv, { octaves: 3, period: 6, gain: 0.5, billow: true, seed: seed + 53 });
      dens[y * size + x] = clamp01(mass * 0.72 + puff * 0.44);
    }
  }

  // Wrapping separable box blur — the shading ramp wants the *shape* of a
  // cloud, not its grain, and blurring here is free next to doing it in the
  // fragment shader forever.
  const soft = boxBlurWrapped(dens, size, Math.max(2, size >> 4));

  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const d = dens[i];
    const s = soft[i];
    // All four ramps are wide and overlapping on purpose. The fragment shader
    // applies its own per-layer threshold on top, so anything hard-edged baked
    // in here would leave that threshold nothing to work with.
    const alpha = smoothstep(0.3, 0.74, d);
    const core = smoothstep(0.36, 0.88, d);
    const shade = smoothstep(0.32, 0.82, s);
    const detail = clamp01(d * 1.35 - 0.18);
    data[i * 4 + 0] = (core * 255) | 0;
    data[i * 4 + 1] = (shade * 255) | 0;
    data[i * 4 + 2] = (detail * 255) | 0;
    data[i * 4 + 3] = (alpha * 255) | 0;
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  // Data, not colour: an sRGB decode here would crush the thickness ramp.
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function boxBlurWrapped(src: Float32Array, size: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const norm = 1 / (radius * 2 + 1);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += src[row + (((x + k) % size) + size) % size];
      tmp[row + x] = sum * norm;
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += tmp[((((y + k) % size) + size) % size) * size + x];
      out[y * size + x] = sum * norm;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const CLOUD_VERT = /* glsl */ `
uniform vec2 uScale;
uniform vec2 uOffset;
uniform vec2 uOffset2;
uniform vec4 uRot;      // 2x2 rotation, column-major
uniform float uCurve;

varying vec2 vUv;
varying vec2 vUv2;
varying vec3 vWorld;

void main() {
  // Bend the sheet down toward the horizon. A flat plane 430 m up and 2.6 km
  // wide stops dead at 9° of elevation, leaving a bald ring of empty sky under
  // every cloud in the frame; a parabolic drop brings the rim to within half a
  // degree of the horizon, where the haze can swallow it. Real cloud decks do
  // exactly this, for exactly the same reason — the Earth is round.
  vec3 local = position;
  local.y -= dot(local.xz, local.xz) * uCurve;

  vec4 world = modelMatrix * vec4(local, 1.0);
  vWorld = world.xyz;
  // UV comes from world XZ, never from the mesh. That is what lets the sheet
  // chase the camera for infinite extent while the pattern stays world-locked.
  vec2 p = world.xz / uScale;
  vec2 r = vec2(uRot.x * p.x + uRot.z * p.y, uRot.y * p.x + uRot.w * p.y);
  vUv = r + uOffset;
  vUv2 = r * 2.31 + uOffset2;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const CLOUD_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uMap;
uniform vec3  uShadow;
uniform vec3  uLit;
uniform vec3  uRim;
uniform vec3  uHaze;
uniform vec3  uSunDir;
uniform vec2  uSunUv;
uniform float uCoverage;
uniform float uOpacity;
uniform float uRimStrength;
uniform float uFadeNear;
uniform float uFadeFar;

varying vec2 vUv;
varying vec2 vUv2;
varying vec3 vWorld;

void main() {
  vec4 c = texture2D(uMap, vUv);
  float body = c.a;
  float shade = c.g;

#if CLOUD_DETAIL >= 1
  // A second tap of the same field at 2.3× and a different drift. It erodes
  // the silhouette, hides the tile, and makes the deck look like it is
  // slowly boiling rather than sliding past as one rigid sheet.
  vec4 d = texture2D(uMap, vUv2);
  body *= 0.52 + 0.72 * d.a;
  shade = shade * (0.6 + 0.55 * d.b);
#endif

  float cover = smoothstep(uCoverage, uCoverage + 0.34, body);
  if (cover <= 0.002) discard;

  // Thick cores sit in their own shadow; thin edges are the lit part. That
  // inversion is the whole reason a flat card reads as a volume — but the ramp
  // has to stay gentle, or the deck turns into a field of black holes.
  vec3 col = mix(uLit, uShadow, smoothstep(0.08, 0.95, shade));

#if CLOUD_DETAIL >= 1
  // Silver lining: sample toward the sun, and wherever the cloud is thinner
  // over there we are standing on the sun-facing edge.
  float sunSide = texture2D(uMap, vUv + uSunUv).a;
  float lining = clamp(c.a - sunSide, 0.0, 1.0);
  col += uRim * pow(lining, 1.25) * uRimStrength;

  // Forward scattering: thin cloud in front of the sun glows through.
  vec3 view = normalize(vWorld - cameraPosition);
  float forward = pow(max(dot(view, uSunDir), 0.0), 9.0);
  col += uRim * forward * (1.0 - cover * 0.75) * 0.55;
#endif

  // Aerial perspective. The deck has to dissolve into exactly the haze the
  // sky dome is painting at that elevation, or there is a visible lid on the
  // world where the cloud plane ends.
  vec3 rel = vWorld - cameraPosition;
  float dist = length(rel);
  float elev = rel.y / max(dist, 1.0);
  float lift = smoothstep(0.004, 0.055, elev);
  float near = 1.0 - smoothstep(uFadeNear, uFadeFar, dist);
  float aerial = lift * near;

  col = mix(uHaze, col, 0.22 + 0.78 * aerial);
  gl_FragColor = vec4(col, cover * uOpacity * aerial);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

interface LayerSpec {
  altitude: number;
  /** World metres spanned by one tile of the field. */
  scale: number;
  /** Wind in m/s, world XZ. */
  wind: [number, number];
  /** Second-tap drift, so the detail crawls relative to the body. */
  drift: [number, number];
  /** Rotation of the sample frame, radians — decorrelates the shared bake. */
  rot: number;
  coverage: number;
  opacity: number;
  rimStrength: number;
  /** Lining offset in world metres toward the sun. */
  rimReach: number;
}

/**
 * Three decks, deliberately unlike each other. The cumulus band is the hero —
 * it is the one that reads as weather — and it is the layer that survives on
 * every quality tier.
 */
const LAYERS: LayerSpec[] = [
  // 0 · cumulus deck (hero): fat, opaque, strong lining.
  {
    altitude: 430, scale: 780, wind: [12, 4.5], drift: [-2.5, 1.4], rot: 0,
    coverage: 0.34, opacity: 0.95, rimStrength: 1.0, rimReach: 22,
  },
  // 1 · cirrus veil: high, thin, fast, barely there.
  {
    altitude: 780, scale: 1700, wind: [22, 7], drift: [4, -2], rot: 1.15,
    coverage: 0.56, opacity: 0.34, rimStrength: 0.6, rimReach: 40,
  },
  // 2 · low scud: close, quick, breaks the deck's regularity from below.
  {
    altitude: 235, scale: 420, wind: [17, 6.5], drift: [-3.5, -2], rot: 2.42,
    coverage: 0.62, opacity: 0.38, rimStrength: 0.85, rimReach: 14,
  },
];

const LAYER_COUNT: Record<KartQuality, number> = { low: 1, medium: 2, high: 3, ultra: 3 };

/** Outer radius of a deck. Kept well inside the camera's 4 km far plane. */
const DECK_RADIUS = 2600;
/** World Y the curved rim of every deck lands on, i.e. how close to the horizon. */
const DECK_RIM_HEIGHT = 16;

interface Layer {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  spec: LayerSpec;
  offset: THREE.Vector2;
  offset2: THREE.Vector2;
}

export interface CloudDeck {
  root: THREE.Group;
  update(dt: number, camera: THREE.Camera): void;
  applyAtmosphere(s: AtmosphereState): void;
  dispose(): void;
}

export function createClouds(quality: KartQuality, seed: number): CloudDeck {
  const root = new THREE.Group();
  root.name = "kart-clouds";
  const field = bakeCloudField(TEX_SIZE[quality], seed);

  // One ring shared by every deck: an annulus with a pinhole at the zenith,
  // subdivided radially enough that the per-fragment horizon fade has smooth
  // geometry underneath it.
  const geometry = new THREE.RingGeometry(4, DECK_RADIUS, 96, 10);
  geometry.rotateX(-Math.PI / 2);

  const detail = quality === "low" ? 0 : 1;
  const count = LAYER_COUNT[quality];
  const layers: Layer[] = [];

  for (let i = 0; i < count; i++) {
    const spec = LAYERS[i];
    const c = Math.cos(spec.rot);
    const s = Math.sin(spec.rot);
    const material = new THREE.ShaderMaterial({
      defines: { CLOUD_DETAIL: detail },
      uniforms: {
        uMap: { value: field },
        uScale: { value: new THREE.Vector2(spec.scale, spec.scale) },
        uOffset: { value: new THREE.Vector2() },
        uOffset2: { value: new THREE.Vector2() },
        uRot: { value: new THREE.Vector4(c, -s, s, c) },
        uCurve: { value: (spec.altitude - DECK_RIM_HEIGHT) / (DECK_RADIUS * DECK_RADIUS) },
        uShadow: { value: new THREE.Color(0x6a7488) },
        uLit: { value: new THREE.Color(0xf2e6d6) },
        uRim: { value: new THREE.Color(0xffe0a8) },
        uHaze: { value: new THREE.Color(0x2a1e18) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunUv: { value: new THREE.Vector2() },
        uCoverage: { value: spec.coverage },
        uOpacity: { value: spec.opacity },
        uRimStrength: { value: spec.rimStrength },
        // The rim trim only: with the deck curved down to the horizon, the
        // elevation fade and the haze mix do nearly all of the dissolving.
        uFadeNear: { value: DECK_RADIUS * 0.78 },
        uFadeFar: { value: DECK_RADIUS * 0.998 },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      // Depth-tested but never written: hills and grandstands must occlude the
      // deck, and the deck must never occlude itself.
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: true,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `kart-cloud-${i}`;
    mesh.position.y = spec.altitude;
    mesh.frustumCulled = false;
    // Higher decks are further away at any given screen elevation, so they
    // must be painted first.
    mesh.renderOrder = -900 - Math.round(spec.altitude / 100);
    root.add(mesh);
    layers.push({ mesh, material, spec, offset: new THREE.Vector2(), offset2: new THREE.Vector2() });
  }

  const camPos = new THREE.Vector3();

  return {
    root,

    update(dt: number, camera: THREE.Camera) {
      camera.getWorldPosition(camPos);
      for (const l of layers) {
        // Scroll in world metres, converted to tiles.
        l.offset.x += (l.spec.wind[0] * dt) / l.spec.scale;
        l.offset.y += (l.spec.wind[1] * dt) / l.spec.scale;
        l.offset2.x += (l.spec.drift[0] * dt) / l.spec.scale;
        l.offset2.y += (l.spec.drift[1] * dt) / l.spec.scale;
        // Keep the offsets small forever — a float that has been accumulating
        // for twenty minutes quantises the UV into visible steps.
        l.offset.x %= 1; l.offset.y %= 1;
        l.offset2.x %= 1; l.offset2.y %= 1;
        (l.material.uniforms.uOffset.value as THREE.Vector2).copy(l.offset);
        (l.material.uniforms.uOffset2.value as THREE.Vector2).copy(l.offset2);
        l.mesh.position.set(camPos.x, l.spec.altitude, camPos.z);
      }
    },

    applyAtmosphere(s: AtmosphereState) {
      // Sun azimuth in world XZ, stepped `rimReach` metres and rotated into
      // each layer's own sample frame.
      const ax = s.direction.x;
      const az = s.direction.z;
      const len = Math.hypot(ax, az) || 1;
      for (const l of layers) {
        const u = l.material.uniforms;
        (u.uShadow.value as THREE.Color).copy(s.cloudShadow);
        (u.uLit.value as THREE.Color).copy(s.cloudLit);
        (u.uRim.value as THREE.Color).copy(s.cloudRim);
        (u.uHaze.value as THREE.Color).copy(s.hazeColor);
        (u.uSunDir.value as THREE.Vector3).copy(s.direction);
        const px = ((ax / len) * l.spec.rimReach) / l.spec.scale;
        const pz = ((az / len) * l.spec.rimReach) / l.spec.scale;
        const c = Math.cos(l.spec.rot);
        const sn = Math.sin(l.spec.rot);
        (u.uSunUv.value as THREE.Vector2).set(c * px + sn * pz, -sn * px + c * pz);
        // Overcast reads wrong at night; thin the decks out as the sun goes.
        u.uOpacity.value = l.spec.opacity * (0.35 + 0.65 * (1 - s.night));
      }
    },

    dispose() {
      for (const l of layers) {
        root.remove(l.mesh);
        l.material.dispose();
      }
      geometry.dispose();
      field.dispose();
      root.parent?.remove(root);
    },
  };
}
