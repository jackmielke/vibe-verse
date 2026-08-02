import * as THREE from "three";
import { makeNoise2D, canvasTexture, normalFromHeight, mulberry32 } from "../core/Assets";
import { atmosphere } from "./Sky";
import type { QualityProfile } from "../core/Settings";

/**
 * The Genesee / Stan Sayres peninsula on the west shore of Lake Washington —
 * the real Seafair hydro pit location — plus the bluff rising toward Mount
 * Baker Ridge and, far to the west, the downtown plateau.
 *
 * Origin (0,0,0) is the shoreline at the pit gate. +X runs north along the
 * shore, -Z heads out into the lake, +Z climbs inland toward the city.
 *
 * COLOUR: every albedo constant in the surface shader is scene-linear
 * reflectance, not an sRGB swatch. The calibration anchor is Sky.ts's — a
 * diffuse 0.18 surface in full sun lands near 0.18 linear. Parched grass in
 * August really is about 0.20, basalt riprap about 0.07, dry sand about 0.26;
 * those numbers are what give the ground its value structure. Push them up to
 * "look nicer" in isolation and the whole frame turns to milk.
 *
 * SHADING: a high sun has nothing to shade on a plane, so what makes ground
 * read as ground is *normal* variation, not albedo variation. The near-field
 * bump octaves below (1.1 m and 0.34 m world period, strength ~4) carry most
 * of the surface; the albedo bands only tell you what material it is.
 */

export interface TerrainRig {
  mesh: THREE.Mesh;
  /** Ground height at (x, z). Below sea level means underwater. */
  height: (x: number, z: number) => number;
  /** Ground normal at (x, z). */
  normal: (x: number, z: number, out?: THREE.Vector3) => THREE.Vector3;
  /** True where the player can stand (above water, not too steep). */
  walkable: (x: number, z: number) => boolean;
  /** Shore-relative z: 0 at the waterline, positive inland. */
  shoreZ: (x: number, z: number) => number;
  dispose: () => void;
}

const EXTENT = 2400;

/**
 * Value noise on a wrapped integer lattice. Unlike the shared fBm in Assets,
 * every octave here has an integer period, so a texture drawn from it tiles
 * seamlessly — which matters because the ground detail is sampled in world
 * space at half-metre scale and any seam would show up as a visible grid.
 */
function periodicNoise(seed: number) {
  const rand = mulberry32(seed);
  const layers = [4, 8, 16, 32, 64, 128].map((g) => {
    const v = new Float32Array(g * g);
    for (let i = 0; i < v.length; i++) v[i] = rand();
    return { g, v };
  });

  const sampleLayer = (L: { g: number; v: Float32Array }, u: number, w: number): number => {
    const g = L.g;
    const x = u * g;
    const y = w * g;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    const fx = tx * tx * (3 - 2 * tx);
    const fy = ty * ty * (3 - 2 * ty);
    const i0 = ((x0 % g) + g) % g;
    const i1 = (i0 + 1) % g;
    const j0 = ((y0 % g) + g) % g;
    const j1 = (j0 + 1) % g;
    const a = L.v[j0 * g + i0];
    const b = L.v[j0 * g + i1];
    const c = L.v[j1 * g + i0];
    const d = L.v[j1 * g + i1];
    const top = a + (b - a) * fx;
    return top + (c + (d - c) * fx - top) * fy;
  };

  return (u: number, w: number, oct = 5, gain = 0.5): number => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (let i = 0; i < oct && i < layers.length; i++) {
      sum += amp * sampleLayer(layers[i], u, w);
      norm += amp;
      amp *= gain;
    }
    return sum / norm;
  };
}

// ---------------------------------------------------------------- shading ---

const SURFACE_COMMON = /* glsl */ `
varying vec3 vGroundWorld;
varying vec3 vGroundNormal;
varying float vShoreZ;
uniform sampler2D uGrainTex;
uniform sampler2D uDetailNrm;
uniform float uBumpStrength;
uniform float uNearBump;

float gHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float gNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = gHash(i);
  float b = gHash(i + vec2(1.0, 0.0));
  float c = gHash(i + vec2(0.0, 1.0));
  float d = gHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/** value + forward-difference gradient, so one noise field can drive both the
 *  albedo mottle and the bump it is supposed to belong to. */
vec3 gNoiseD(vec2 p) {
  float n = gNoise(p);
  return vec3(n, gNoise(p + vec2(0.31, 0.0)) - n, gNoise(p + vec2(0.0, 0.31)) - n);
}
`;

const SURFACE_FRAGMENT = /* glsl */ `
  vec3 W = vGroundWorld;
  vec2 P = W.xz;
  float camDist = length(W - cameraPosition);
  float zs = vShoreZ;

  // Detail is faded out with distance rather than left to the mip chain: past
  // a couple of hundred metres it is smaller than a pixel and only aliases.
  float detail = 1.0 - smoothstep(70.0, 420.0, camDist);
  // The near field is where the player actually looks at the ground. Inside
  // ~20 m a pixel covers well under a centimetre, so this band carries the
  // pebble-and-clod scale that makes the surface read as a surface.
  float near = 1.0 - smoothstep(7.0, 26.0, camDist);
  float mid = 1.0 - smoothstep(30.0, 110.0, camDist);

  float gSlope = 1.0 - clamp(vGroundNormal.y, 0.0, 1.0);

  // Four bands of variation: 220 m, 70 m, 26 m, 8 m. The two coarse ones are
  // what stop the ground reading as a single flat colour from the water.
  float n220 = gNoise(P * 0.0045);
  float n70  = gNoise(P * 0.0142 + 19.0);
#if TERRAIN_FINE
  float n26  = gNoise(P * 0.0380 + 47.0);
  float n8   = gNoise(P * 0.1250 + 71.0);
  float n3   = gNoise(P * 0.3400 + 91.0);
  float fine = mix(0.5, n26 * 0.58 + n8 * 0.42, detail);
#else
  float n26  = n70;
  float n8   = n70;
  float n3   = n70;
  float fine = mix(0.5, n70, detail);
#endif
  float macro = n220 * 0.62 + n70 * 0.38;
  float varMask = macro * 0.62 + fine * 0.38;

  // Near-field surface: 1.1 m clods and 0.34 m grit, carried in BOTH the
  // albedo and the normal. At a 52-degree sun the normal is worth several
  // times the albedo, which is why these are the only two octaves that get a
  // real bump amplitude.
  // The 30 cm octave is the one that carries the surface and it is cheap
  // enough for a phone, so it is outside the quality gate; the 1 m swell and
  // the 10 cm speck are not.
  vec3 grit  = gNoiseD(P * 3.30 + 27.0);
  float veryNear = 1.0 - smoothstep(4.0, 17.0, camDist);
#if TERRAIN_FINE
  vec3 clod  = gNoiseD(P * 0.85 + 4.4);
  vec3 speck = gNoiseD(P * 9.60 + 61.0);
  float pebble = speck.x;
#else
  vec3 clod  = vec3(0.5, 0.0, 0.0);
  vec3 speck = vec3(0.5, 0.0, 0.0);
  float pebble = 0.5;
#endif

  float grainNear = texture2D(uGrainTex, P * 0.100).g;
  float grainFar  = texture2D(uGrainTex, P * 0.011 + 0.31).g;
  float grain = mix(0.5, grainNear, detail) * 0.5 + grainFar * 0.5;

  // --- scene-linear reflectances, August, west shore of Lake Washington ---
  // Dead grass spans nearly a stop between a shaded tussock and a bleached
  // crown; that spread is what stops it reading as a painted carpet.
  const vec3 C_STRAW  = vec3(0.132, 0.101, 0.034);
  const vec3 C_HAY    = vec3(0.286, 0.232, 0.090);
  const vec3 C_GREEN  = vec3(0.040, 0.074, 0.019);
  const vec3 C_DIRT   = vec3(0.116, 0.085, 0.055);
  const vec3 C_GRAVEL = vec3(0.086, 0.083, 0.079);
  const vec3 C_SAND   = vec3(0.250, 0.214, 0.147);
  const vec3 C_ROCK   = vec3(0.064, 0.062, 0.060);
  const vec3 C_LICHEN = vec3(0.124, 0.128, 0.097);
  const vec3 C_DUFF   = vec3(0.038, 0.040, 0.022);

  // Dry grass: tussocks at a couple of metres, drift at tens of metres.
  float tussock = mix(0.5, grainNear, detail);
  float bleach = clamp(varMask * 1.15 + (tussock - 0.5) * 1.05 + (grainFar - 0.5) * 0.6, 0.0, 1.0);
  vec3 col = mix(C_STRAW, C_HAY, smoothstep(0.12, 0.88, bleach));

  // Genesee Park is watered and the swales hold damp all summer, so roughly
  // half the flats stay green. The boundary is dilated with the 8 m and 3 m
  // bands: a smoothstep on a smooth field is always a clean contour, and a
  // clean contour across the frame is what reads as a painted stripe.
  float greenField = n70 * 0.42 + n26 * 0.26 + n220 * 0.20 + (n8 - 0.5) * 0.30 + (n3 - 0.5) * 0.14;
  float green = smoothstep(0.36, 0.62, greenField);
  green = max(green, smoothstep(14.0, 4.0, W.y) * 0.6 * smoothstep(0.16, 0.50, macro + (n8 - 0.5) * 0.5));
  col = mix(col, C_GREEN, green * 0.92);

  // Worn dirt where the ground gets walked and driven over.
  float worn = smoothstep(0.58, 0.86, fine * 0.5 + n70 * 0.34 + (n8 - 0.5) * 0.32) * 0.8;
  col = mix(col, C_DIRT, worn);

  // Needle duff under the bluff canopy. The forest has to be the dark anchor
  // of the frame; straw-coloured ground all the way up the ridge is what makes
  // the whole view read as one washed-out tone.
  float duff = smoothstep(7.0, 26.0, W.y) * smoothstep(0.18, 0.56, macro * 0.7 + fine * 0.3);
  col = mix(col, C_DUFF, duff * 0.92);

  // --- beach -------------------------------------------------------------
  // Driven off shore-relative distance, not elevation. An elevation threshold
  // on ground whose height varies with z is by construction an iso-z line, and
  // an iso-z line is a ruler drawn across the frame.
  float sandEdge = 30.0
                 + (gNoise(P * 0.0060 + 3.1) - 0.5) * 30.0
                 + (gNoise(P * 0.0230 + 9.4) - 0.5) * 11.0
                 + (n8 - 0.5) * 4.0
                 + (n3 - 0.5) * 1.6;
  float sandAmt = smoothstep(sandEdge, sandEdge - 7.0, zs) * smoothstep(0.40, 0.14, gSlope);
  sandAmt *= smoothstep(26.0, 12.0, W.y);
  col = mix(col, C_SAND, sandAmt);

  // --- pit apron ---------------------------------------------------------
  // Graded, compacted crushed rock. It has to be a *dark neutral*, because the
  // one thing a festival pad must not look like is the beach next to it.
  float apEx = 1.0 - abs(W.x) / (112.0 + (n70 - 0.5) * 30.0 + (n26 - 0.5) * 12.0);
  float apEz = 1.0 - abs(W.z - 62.0) / (78.0 + (n70 - 0.5) * 22.0 + (n26 - 0.5) * 9.0);
  // A graded pad has a hard edge where the blade stopped, not a soft gradient.
  float apron = smoothstep(0.0, 0.055, apEx) * smoothstep(0.0, 0.055, apEz);
  // Compaction ruts: tow vehicles run along the shore, so the ruts run in X.
  float rut = gNoise(vec2(W.x * 0.06, W.z * 1.15 + 3.0));
  float rutMask = smoothstep(0.62, 0.95, rut) * mid;
  // Fuel and rubber down the working centreline of the pad.
  float stain = smoothstep(16.0, 3.0, abs(W.z - 62.0)) * smoothstep(0.35, 0.75, gNoise(P * 0.035 + 5.0));
  vec3 apronCol = mix(C_GRAVEL, C_DIRT, smoothstep(0.30, 0.78, tussock + (n8 - 0.5) * 0.4));
  apronCol *= 1.0 - 0.30 * rutMask;
  apronCol *= 1.0 - 0.38 * stain;
  apronCol *= 0.80 + 0.55 * pebble;
  col = mix(col, apronCol, apron);

  // --- rock --------------------------------------------------------------
  float rockAmt = smoothstep(0.26, 0.56, gSlope);
  rockAmt = max(rockAmt, smoothstep(0.56, 0.86, n70) * smoothstep(24.0, 56.0, W.y) * 0.75);
  rockAmt = max(rockAmt, smoothstep(2.8, 0.5, W.y) * smoothstep(0.13, 0.34, gSlope));
  rockAmt *= 1.0 - apron;
  col = mix(col, mix(C_ROCK, C_LICHEN, smoothstep(0.42, 0.76, fine)), rockAmt);

  // --- the grass band the instanced tussocks fade into --------------------
  // Same accept test the vegetation module uses. Painting it into the ground
  // is what stops the instanced field ending at a visible line.
  float turf = smoothstep(1.9, 3.4, W.y) * smoothstep(0.42, 0.28, gSlope) * (1.0 - apron);
  turf *= smoothstep(0.30, 0.70, greenField + 0.30);
  col = mix(col, mix(C_STRAW, C_GREEN, 0.34), turf * 0.30 * (1.0 - sandAmt));

  // --- surface texture ---------------------------------------------------
  col *= 0.72 + 0.56 * grain;
  float dry = 1.0 - apron * 0.35;
  col *= 1.0 + (clod.x - 0.5) * 0.44 * near * dry;
  col *= 1.0 + (grit.x - 0.5) * 1.05 * near * dry;
  col *= 1.0 + (speck.x - 0.5) * 0.90 * veryNear * dry;
  col *= 1.0 + (n3 - 0.5) * 0.26 * mid;

  // Wet-darkened swash zone. Water soaking into sand roughly halves its
  // reflectance and drops its roughness — that contrast is most of what makes
  // a waterline read as a waterline. Applied last so nothing overwrites it.
  float wetEdge = 2.4 + (n8 - 0.5) * 2.2 + (gNoise(P * 0.05 + 2.0) - 0.5) * 2.6;
  float wet = smoothstep(wetEdge, wetEdge - 3.4, zs) * smoothstep(4.0, 0.4, W.y);
  col *= mix(1.0, 0.34, wet);

  diffuseColor.rgb = col;

  float gRough = mix(0.95, 0.90, apron);
  gRough = mix(gRough, 0.82, sandAmt);
  gRough = mix(gRough, 0.70, rockAmt);
  gRough = mix(gRough, 0.24, wet);
  float gApron = apron;
`;

const SURFACE_NORMAL = /* glsl */ `
  vec3 nA = texture2D(uDetailNrm, vGroundWorld.xz * 0.055).xyz * 2.0 - 1.0;
  vec3 nB = texture2D(uDetailNrm, vGroundWorld.xz * 0.0075 + 0.19).xyz * 2.0 - 1.0;
  // Tangent frame for a ground plane is just world X / Z, so the tangent-space
  // xy drops straight into world xz. Graded ground keeps far less of it.
  vec2 bump = (nA.xy * detail * 0.70 + nB.xy * 0.45) * uBumpStrength;
  // The near-field octaves carry their own, much larger amplitude: at this sun
  // elevation a 2 cm ripple with a real normal outshades any albedo noise. The
  // weighting is deliberately top-heavy — the 1 m octave is a broad swell and
  // too much of it turns dry sand into a mudflat.
  bump += (clod.yz * 0.30 + grit.yz * 1.30) * uNearBump * near * mix(1.0, 0.50, gApron);
  bump += speck.yz * uNearBump * 1.15 * veryNear * mix(1.0, 0.55, gApron);
  bump *= mix(1.0, 0.5, gApron);
  vec3 wN = normalize(vGroundNormal + vec3(bump.x, 0.0, bump.y));
  normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);
  // three uses nonPerturbedNormal for shadow-side rejection and specular
  // anti-aliasing; feeding it the perturbed normal loses both.
  nonPerturbedNormal = normalize((viewMatrix * vec4(vGroundNormal, 0.0)).xyz);
`;

// ---------------------------------------------------------------- riprap ----

/**
 * Quarried basalt. Blocky rather than rounded, subdivided once past the
 * icosahedron so the facets are chip-scale rather than 40 cm flats, with the
 * face colour baked per vertex — iron staining low, lichen on the up-faces.
 */
function makeBoulderGeometry(seed: number): THREE.BufferGeometry {
  const flat = new THREE.IcosahedronGeometry(1, 2);
  const rand = mulberry32(seed);
  const pos = flat.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();

  // Three cleavage planes give the blocky quarried look; the noise on top of
  // them is the chip scale.
  const planes = [0, 1, 2].map(() =>
    new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize(),
  );
  const depth = [0.80 + rand() * 0.16, 0.78 + rand() * 0.18, 0.82 + rand() * 0.14];
  const a = seed * 1.9;
  const b = seed * 3.3 + 0.7;
  const squash = 0.72 + rand() * 0.2;

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let r = 1;
    for (let k = 0; k < 3; k++) {
      const d = Math.max(0.35, Math.abs(v.dot(planes[k])));
      r = Math.min(r, Math.min(1, depth[k] / d));
    }
    const chip =
      0.055 * Math.sin(7.3 * v.x + a) * Math.cos(6.1 * v.y + b) +
      0.030 * Math.sin(13.1 * v.z + b) * Math.cos(11.7 * v.x + a);
    v.multiplyScalar(r * (1 + chip));
    v.y *= squash;
    pos.setXYZ(i, v.x, v.y, v.z);
  }

  flat.computeVertexNormals();
  // Icosahedron geometry is non-indexed, so computeVertexNormals gives hard
  // per-face normals — six visible flats on a boulder. Average across
  // coincident vertices and keep only a little of the facet.
  {
    const n = flat.attributes.normal as THREE.BufferAttribute;
    const acc = new Map<string, THREE.Vector3>();
    const key = (i: number) =>
      `${Math.round(pos.getX(i) * 2048)},${Math.round(pos.getY(i) * 2048)},${Math.round(pos.getZ(i) * 2048)}`;
    for (let i = 0; i < pos.count; i++) {
      const k = key(i);
      const cur = acc.get(k);
      const nv = new THREE.Vector3().fromBufferAttribute(n, i);
      if (cur) cur.add(nv);
      else acc.set(k, nv);
    }
    const smooth = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      smooth.copy(acc.get(key(i))!).normalize();
      v.fromBufferAttribute(n, i).lerp(smooth, 0.42).normalize();
      n.setXYZ(i, v.x, v.y, v.z);
    }
  }

  // Basalt is 0.05-0.09 linear with warm iron bleed in the low, wet part of
  // the block and pale lichen crust on anything that faces the sky.
  const p2 = flat.attributes.position as THREE.BufferAttribute;
  const n2 = flat.attributes.normal as THREE.BufferAttribute;
  const cols = new Float32Array(p2.count * 3);
  const nv = new THREE.Vector3();
  const base = new THREE.Color();
  for (let i = 0; i < p2.count; i++) {
    v.fromBufferAttribute(p2, i);
    nv.fromBufferAttribute(n2, i);
    const up = THREE.MathUtils.clamp(nv.y, 0, 1);
    const iron = THREE.MathUtils.clamp(0.5 - v.y, 0, 1);
    const facet = 0.5 + 0.5 * Math.sin(9.1 * v.x + 5.7 * v.z + a);
    const lich = THREE.MathUtils.smoothstep(up * facet, 0.28, 0.9);
    base.setRGB(0.042 + 0.034 * facet, 0.041 + 0.031 * facet, 0.040 + 0.027 * facet);
    base.r += iron * 0.052;
    base.g += iron * 0.022;
    base.b -= iron * 0.006;
    base.lerp(new THREE.Color(0.148, 0.156, 0.106), lich * 0.72);
    cols[i * 3] = base.r;
    cols[i * 3 + 1] = base.g;
    cols[i * 3 + 2] = base.b;
  }
  flat.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  return flat;
}

// ---------------------------------------------------------------- terrain ---

export function createTerrain(scene: THREE.Scene, profile: QualityProfile): TerrainRig {
  const { fbm } = makeNoise2D(90210);

  /**
   * Shore-relative z. 0 is the waterline, positive inland. The meander is
   * large — 70 m of bay-and-point over a 250 m period — because 20 m of wander
   * across a 400 m view is three degrees of angular change and simply is not
   * visible. It is damped to nothing across the pit frontage, which in the
   * real world is a built, revetted bank.
   */
  const shoreOffset = (x: number): number => {
    const wild = THREE.MathUtils.smoothstep(Math.abs(x), 105, 300);
    return (
      fbm(x * 0.0040, 3.7, 3) * 74 * wild +
      fbm(x * 0.0165, 11.1, 2) * 22 * wild +
      // Near-shore scallops. These are the ones that curve inside the frame.
      fbm(x * 0.055, 21.3, 2) * 7.5
    );
  };

  const height = (x: number, z: number): number => {
    const zs = z + shoreOffset(x);

    // Cross-shore profile. zs = 0 is the waterline; the strand climbs to the
    // park bench in ~30 m and the bed falls to -29 m by 400 m out, which is
    // roughly the real bathymetry off the Stan Sayres pits.
    const strand = THREE.MathUtils.smoothstep(zs, -1.5, 30) * 2.5;
    const bed =
      -(THREE.MathUtils.smoothstep(-zs, 0, 62) * 9 +
        THREE.MathUtils.smoothstep(-zs, 62, 420) * 20);
    let h = strand + bed;

    // Storm berm above the high-water mark with a shallow swale behind it.
    // Without the berm a beach reads as a ramp rather than a beach.
    const bermT = Math.exp(-Math.pow((zs - 19) / 11, 2));
    h += bermT * (0.30 + 0.55 * (fbm(x * 0.02, 5.3, 2) * 0.5 + 0.5));

    // Park flats, the bluff up to Mount Baker Ridge, then the downtown
    // plateau far inland. The ridge crest is only ~600 m back from the water,
    // which is what makes it loom over the pits instead of receding.
    h += THREE.MathUtils.smoothstep(z, 30, 250) * 2.6;
    h += THREE.MathUtils.smoothstep(z, 235, 520) * 78;
    h += THREE.MathUtils.smoothstep(z, 470, 1000) * 46;
    h += THREE.MathUtils.smoothstep(z, 1050, 1900) * 20;

    // Drainage down the bluff face. Ridge-and-gully at ~55 m spacing, stretched
    // downslope: at 300 m wavelength the same term is a broad swell and the
    // face reads as a smooth ramp, which is what it did before.
    const bluffBand =
      THREE.MathUtils.smoothstep(z, 200, 340) * (1 - THREE.MathUtils.smoothstep(z, 820, 1250));
    const gullyPhase = x * 0.0182 + fbm(x * 0.004, z * 0.0015, 2) * 1.6 + z * 0.0016;
    const gully = Math.pow(Math.abs(Math.sin(gullyPhase)), 0.65);
    h -= bluffBand * gully * (7 + 10 * (fbm(x * 0.0031 + 21, z * 0.0021 + 7, 3) * 0.5 + 0.5));
    // Spurs between the gullies, so the crest line is not a ruled horizontal.
    h += bluffBand * fbm(x * 0.0075 + 13, z * 0.0042 + 31, 3) * 16;

    // Ground form at four scales. A high sun has nothing to shade on a plane,
    // so this is what makes the flats read as land at all.
    const deepFade = 1 - THREE.MathUtils.smoothstep(-zs, 60, 400) * 0.6;
    const swell = fbm(x * 0.0068 + 4.1, z * 0.0068 - 2.3, 3) * 2.4 * deepFade;
    const knoll = fbm(x * 0.021 + 9.2, z * 0.021 + 3.5, 3) * 1.25;
    const tuft = fbm(x * 0.075 + 2.7, z * 0.075 + 8.1, 2) * 0.42;
    const hummock = fbm(x * 0.26 + 5.4, z * 0.26 + 1.9, 2) * 0.105;

    // The pit apron is graded ground: it keeps the underlying slope but loses
    // nearly all of its texture.
    const wob = fbm(x * 0.0085, 17.9, 3) * 24;
    const apron =
      THREE.MathUtils.smoothstep(1 - Math.abs(x) / (112 + wob), 0, 0.1) *
      THREE.MathUtils.smoothstep(1 - Math.abs(z - 62) / (78 + wob * 0.6), 0, 0.1);

    // Even graded ground keeps a quarter of its ripple — a mathematically flat
    // pad has no shading at all under a high sun, which is how it ends up
    // reading as a carpet.
    h += swell * (1 - apron * 0.5) + (knoll + tuft + hummock) * (1 - apron * 0.78);

    return h;
  };

  const normal = (x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 => {
    const e = 0.9;
    return out
      .set(height(x - e, z) - height(x + e, z), 2 * e, height(x, z - e) - height(x, z + e))
      .normalize();
  };

  const walkable = (x: number, z: number): boolean => {
    const h = height(x, z);
    if (h < 0.35) return false;
    const n = normal(x, z);
    return n.y > 0.66;
  };

  const shoreZ = (x: number, z: number): number => z + shoreOffset(x);

  // --- geometry ---
  const segs = profile.tier === "low" ? 220 : profile.tier === "medium" ? 340 : 470;
  const geo = new THREE.PlaneGeometry(EXTENT * 2, EXTENT * 2, segs, segs);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const shoreAttr = new Float32Array(pos.count);

  // Push vertices toward the origin logarithmically so the playable area gets
  // most of the triangles while the mesh still reaches the horizon. 1.7 rather
  // than 1.9: the bluff at 250-550 m is the silhouette of the whole frame and
  // it needs triangles small enough to hold a 55 m gully.
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if (r > 1) {
      const warped = Math.pow(r / EXTENT, 1.7) * EXTENT;
      x *= warped / r;
      z *= warped / r;
      pos.setX(i, x);
      pos.setZ(i, z);
    }
    pos.setY(i, height(x, z));
    shoreAttr[i] = z + shoreOffset(x);
  }
  pos.needsUpdate = true;
  geo.setAttribute("aShoreZ", new THREE.BufferAttribute(shoreAttr, 1));
  geo.computeVertexNormals();

  // --- surface detail maps, tileable in world space ---
  const S = Math.min(profile.textureSize, 1024);
  const grainNoise = periodicNoise(4242);

  const grain = canvasTexture(
    "terrain-grain",
    S,
    (c2d, s) => {
      const img = c2d.createImageData(s, s);
      const d = img.data;
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const n = grainNoise(x / s, y / s, 5);
          const v = Math.round(THREE.MathUtils.clamp(n, 0, 1) * 255);
          const i = (y * s + x) * 4;
          d[i] = d[i + 1] = d[i + 2] = v;
          d[i + 3] = 255;
        }
      }
      c2d.putImageData(img, 0, 0);
    },
    { srgb: false },
  );

  const detailNrm = normalFromHeight(
    "terrain-ground",
    Math.min(S, 512),
    (x, y) => grainNoise(x, y, 6),
    3.4,
  );

  const uniforms = {
    uGrainTex: { value: grain },
    uDetailNrm: { value: detailNrm },
    uBumpStrength: { value: profile.tier === "low" ? 0.8 : 1.35 },
    uNearBump: { value: profile.tier === "low" ? 2.0 : 2.9 },
  };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0,
    dithering: true,
  });

  mat.defines = { TERRAIN_FINE: profile.tier === "low" ? 0 : 1 };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute float aShoreZ;\nvarying vec3 vGroundWorld;\nvarying vec3 vGroundNormal;\nvarying float vShoreZ;",
      )
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
        vGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vGroundNormal = normalize(mat3(modelMatrix) * objectNormal);
        vShoreZ = aShoreZ;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${SURFACE_COMMON}`)
      .replace("#include <map_fragment>", SURFACE_FRAGMENT)
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = gRough;")
      .replace("#include <normal_fragment_maps>", SURFACE_NORMAL);
  };
  mat.customProgramCacheKey = () => `seafair-ground-${profile.tier}`;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = "terrain";
  scene.add(mesh);

  // --- riprap: the armoured shore between the bluff toe and the water ---
  const rockCount = Math.round(320 * (0.5 + 0.5 * profile.crowdDensity));
  const rockVariants = profile.tier === "low" ? 3 : 5;
  const rockGeos = Array.from({ length: rockVariants }, (_, i) => makeBoulderGeometry(7717 + i * 131));
  const rockMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.88,
    metalness: 0,
  });

  const rockMeshes: THREE.InstancedMesh[] = [];
  const rockShadows: Array<{ x: number; y: number; z: number; s: number }> = [];
  {
    const rand = mulberry32(5150);
    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();
    const per = Math.ceil(rockCount / rockVariants);
    const counts = new Array(rockVariants).fill(0);
    const insts = rockGeos.map((g, i) => {
      const im = new THREE.InstancedMesh(g, rockMat, per);
      im.name = `shore-riprap-${i}`;
      im.castShadow = profile.shadowMapSize > 0;
      im.receiveShadow = true;
      im.count = 0;
      return im;
    });

    let placed = 0;
    // Riprap is dumped by the truckload, so it arrives in piles rather than an
    // even sprinkle down the whole shore.
    let pileX = 0;
    for (let guard = 0; guard < rockCount * 14 && placed < rockCount; guard++) {
      if (placed % 9 === 0) pileX = (rand() * 2 - 1) * 470;
      const x = pileX + (rand() - 0.5) * 18;
      // Walk inland until the ground clears the water, then scatter about the
      // crossing so the boulders straddle the swash line the way riprap does.
      let z = -110;
      while (z < 90 && height(x, z) < 0.55) z += 1.5;
      if (z >= 90) continue;
      const zr = z + (rand() - 0.45) * 11;
      const y = height(x, zr);
      if (y < -1.6 || y > 3.2) continue;
      const gi = placed % rockVariants;
      if (counts[gi] >= per) continue;
      const s = 0.55 + rand() * rand() * 2.5;
      dummy.position.set(x, y - s * 0.34, zr);
      dummy.rotation.set((rand() - 0.5) * 0.7, rand() * Math.PI * 2, (rand() - 0.5) * 0.7);
      dummy.scale.set(s * (0.8 + rand() * 0.5), s, s * (0.8 + rand() * 0.5));
      dummy.updateMatrix();
      const k = counts[gi];
      insts[gi].setMatrixAt(k, dummy.matrix);
      // Wet rock below the swash line is much darker than dry rock above it.
      const wetK = THREE.MathUtils.smoothstep(y, 1.4, 0.0);
      const v = (0.82 + rand() * 0.42) * THREE.MathUtils.lerp(1, 0.55, wetK);
      tint.setRGB(v * (0.96 + rand() * 0.12), v, v * (0.94 + rand() * 0.10));
      insts[gi].setColorAt(k, tint);
      rockShadows.push({ x, y, z: zr, s });
      counts[gi] = k + 1;
      placed++;
    }

    insts.forEach((im, i) => {
      im.count = counts[i];
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      if (counts[i] === 0) {
        im.dispose();
        return;
      }
      im.computeBoundingSphere();
      scene.add(im);
      rockMeshes.push(im);
    });
  }

  // --- riprap ground shadows -------------------------------------------
  // The renderer's shadow map is not currently producing occlusion for this
  // scene (see 10-vegetation.ts for the bisect), and a boulder with no shadow
  // reads as a sticker. These are laid down the real anti-solar azimuth so
  // they agree with the sun shading rather than fighting it.
  const sunD = atmosphere.sunDirection;
  const runPer = 1 / Math.max(0.25, sunD.y);
  const sdx = -sunD.x * runPer;
  const sdz = -sunD.z * runPer;
  const sdLen = Math.hypot(sdx, sdz) || 1;
  const rockShadowYaw = Math.atan2(-sdz / sdLen, sdx / sdLen);

  const rockShTex = canvasTexture(
    "terrain-rock-shadow",
    64,
    (c2d, sz) => {
      const g = c2d.createRadialGradient(sz / 2, sz / 2, 0, sz / 2, sz / 2, sz / 2);
      g.addColorStop(0, "#3c3c3c");
      g.addColorStop(0.40, "#484848");
      g.addColorStop(0.78, "#b0b0b0");
      g.addColorStop(1, "#ffffff");
      c2d.fillStyle = g;
      c2d.fillRect(0, 0, sz, sz);
    },
    { srgb: false },
  );
  const rockShGeo = new THREE.CircleGeometry(1, 10).rotateX(-Math.PI / 2);
  const rockShMat = new THREE.MeshBasicMaterial({
    map: rockShTex,
    transparent: true,
    blending: THREE.MultiplyBlending,
    depthWrite: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -6,
  });
  const rockShadowMesh = new THREE.InstancedMesh(rockShGeo, rockShMat, Math.max(1, rockShadows.length));
  rockShadowMesh.name = "riprap-shadow";
  rockShadowMesh.renderOrder = 2;
  {
    const d = new THREE.Object3D();
    const nrmTmp = new THREE.Vector3();
    let n = 0;
    for (const r of rockShadows) {
      const run = r.s * 0.9 * sdLen;
      const cx = r.x + (sdx / sdLen) * run * 0.45;
      const cz = r.z + (sdz / sdLen) * run * 0.45;
      const gy = height(cx, cz);
      if (gy < 0.05) continue;
      normal(cx, cz, nrmTmp);
      d.position.set(cx, gy + 0.035, cz);
      d.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rockShadowYaw);
      d.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), nrmTmp));
      d.scale.set(run * 0.5 + r.s * 0.85, 1, r.s * 0.8);
      d.updateMatrix();
      rockShadowMesh.setMatrixAt(n++, d.matrix);
    }
    rockShadowMesh.count = n;
    rockShadowMesh.instanceMatrix.needsUpdate = true;
    rockShadowMesh.computeBoundingSphere();
    if (n > 0) scene.add(rockShadowMesh);
  }

  return {
    mesh,
    height,
    normal,
    walkable,
    shoreZ,
    dispose: () => {
      geo.dispose();
      mat.dispose();
      rockGeos.forEach((g) => g.dispose());
      rockMat.dispose();
      rockMeshes.forEach((m) => {
        m.dispose();
        scene.remove(m);
      });
      rockShGeo.dispose();
      rockShMat.dispose();
      rockShadowMesh.dispose();
      scene.remove(rockShadowMesh);
      scene.remove(mesh);
    },
  };
}
