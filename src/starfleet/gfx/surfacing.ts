/**
 * Surfacing: real texture maps, sampled triplanar, on three's own PBR.
 *
 * This is the other half of the difference between a rendered frame and
 * coloured shapes on a coloured plane — the post chain in `post.ts` was the
 * first half, and on its own it made a flat-shaded world into a *nicely
 * graded* flat-shaded world.
 *
 * ## Why maps and not shader maths
 *
 * The obvious way to add detail without assets is to compute it analytically
 * in the fragment shader: a panel grid from `fract`, cracks from a noise
 * function, grain from a hash. It looks superb in a still and it aliases
 * horribly the moment anything moves, and no amount of tuning fixes it,
 * because **MSAA antialiases triangle coverage, not shading**. It resolves one
 * shaded sample per pixel. Every analytic feature is a hard step computed
 * inside the shader with no mip chain to prefilter it, so at a grazing angle
 * fifty features fall under one pixel and you get one of them, chosen by
 * whichever way the camera happened to twitch.
 *
 * A texture has a mip chain. That is the whole difference, and it is why this
 * file spends its effort *baking* — into a canvas, at boot, once — rather than
 * evaluating.
 *
 * ## Why triplanar
 *
 * Every prop in `surface/kits.ts` is a primitive, and a primitive's UVs are
 * 0-1 per face regardless of how big the face is. Map a 2 m stone tile onto
 * them and a pillar gets two metres of stone stretched over six, while the
 * pebble next to it gets the same two metres crammed into a third of one. The
 * texel density is wrong everywhere and inconsistently wrong, which reads as
 * cheap far more loudly than no texture at all.
 *
 * Sampling from *world position* on the three cardinal planes and blending by
 * the normal fixes that permanently: one tile size, in metres, and every
 * surface in the world gets the same grain whatever shape it is and whatever
 * it was scaled by. It costs three texture fetches instead of one, which on
 * this scene is nothing.
 *
 * The patch goes in through `onBeforeCompile` rather than a hand-written
 * shader, so all of three's PBR stays: shadows, IBL, tone-mapping hooks, fog,
 * the lot. Losing those to gain a triplanar fetch would be a bad trade.
 */
import * as THREE from "three";
import { makeRng } from "../types";

/* ========================================================================== *
   Baking
 * ========================================================================== */

export type SurfaceFamily = "rock" | "sand" | "ice" | "metal" | "cloth" | "organic";

export interface SurfaceMaps {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  /** R = ambient occlusion, G = roughness, B = metalness. */
  orm: THREE.Texture;
}

interface Recipe {
  /** Metres covered by one tile. Drives the triplanar scale. */
  tile: number;
  /** Height-field octaves: [frequency, amplitude] pairs. */
  octaves: [number, number][];
  /** Sharp features — cracks, panel lines, weave. */
  detail: (x: number, y: number, h: number, rng: () => number) => number;
  /** Base roughness and how much the height field modulates it. */
  rough: [number, number];
  metal: number;
  /** How strongly height variation tints the albedo. */
  albedoVar: number;
  /** Normal strength. */
  bump: number;
}

/* One 512² bake per family. 256² on `low`, which is the difference between a
   third of a second at boot and a tenth. */
const cache = new Map<string, SurfaceMaps>();

/**
 * A tiling value-noise field.
 *
 * Tiling matters: this is sampled triplanar across an entire world, and a seam
 * every two metres in three directions is not a subtle artefact. Wrapping the
 * lattice coordinates modulo the period is what makes it seamless, and it is
 * the reason this is value noise rather than the simplex used in the planet
 * shader — simplex has no lattice to wrap.
 */
function tilingNoise(seed: number) {
  const hash = (xi: number, yi: number, p: number): number => {
    const x = ((xi % p) + p) % p;
    const y = ((yi % p) + p) % p;
    let h = (x * 374761393 + y * 668265263 + seed) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  return (x: number, y: number, period: number): number => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi, period);
    const b = hash(xi + 1, yi, period);
    const c = hash(xi, yi + 1, period);
    const d = hash(xi + 1, yi + 1, period);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

const RECIPES: Record<SurfaceFamily, Recipe> = {
  /* Weathered stone: broad erosion, then cracks that follow it. */
  /* Weathered stone.
   *
   * The frequencies are the whole recipe and they were wrong by a factor of
   * four on the first bake: two cycles across a 2.4 m tile is a 1.2 m blob,
   * and a plaza of pillars covered in metre-wide light and dark patches reads
   * as mould rather than as rock. Stone detail lives at five to twenty
   * centimetres — eight to a hundred and twenty-eight cycles across a two
   * metre tile — and the albedo swing has to be small, because most of what
   * the eye reads as "stone" is the *normal*, not the colour. */
  rock: {
    tile: 2.0,
    octaves: [[8, 0.45], [16, 0.26], [32, 0.16], [64, 0.09], [128, 0.05]],
    detail: (x, y, h) => {
      // Cracks: a ridged band thresholded hard, biased into the low ground so
      // they read as erosion rather than as a net thrown over the surface.
      const r = 1 - Math.abs(h * 2 - 1);
      const crack = Math.max(0, r - 0.82) * 2.0;
      return -crack * (0.6 + (1 - h) * 0.7);
    },
    rough: [0.94, 0.14],
    metal: 0.0,
    albedoVar: 0.2,
    bump: 1.15,
  },
  /* Fine grain with wind ripples. Almost flat, and the ripples are the only
     thing that gives a dune a direction. */
  sand: {
    tile: 1.4,
    octaves: [[12, 0.35], [24, 0.22], [48, 0.14], [96, 0.08], [192, 0.04]],
    detail: (x, y, h) => Math.sin((x * 9 + h * 3) * Math.PI * 2) * 0.09,
    rough: [0.98, 0.06],
    metal: 0.0,
    albedoVar: 0.13,
    bump: 0.7,
  },
  /* Ice: smooth, with deep fracture planes and a low roughness in the flats. */
  ice: {
    tile: 3.0,
    octaves: [[6, 0.5], [14, 0.24], [30, 0.13], [60, 0.07], [120, 0.04]],
    detail: (x, y, h) => {
      const r = 1 - Math.abs(h * 2 - 1);
      return -Math.max(0, r - 0.74) * 3.0;
    },
    rough: [0.34, 0.42],
    metal: 0.0,
    albedoVar: 0.11,
    bump: 0.95,
  },
  /* Hull plate: a panel grid, weld beads at the seams, scratches, rivets. */
  metal: {
    tile: 2.0,
    octaves: [[20, 0.12], [44, 0.07], [90, 0.04], [180, 0.02]],
    detail: (x, y, h, rng) => {
      // Panel seams on a 1/4-tile grid, plus a bead that stands proud of them.
      const gx = Math.abs(((x * 4) % 1) - 0.5);
      const gy = Math.abs(((y * 4) % 1) - 0.5);
      const seam = Math.min(gx, gy);
      const groove = seam < 0.022 ? -1.0 : 0;
      const bead = seam > 0.022 && seam < 0.045 ? 0.35 : 0;
      // Rivets, one per panel corner.
      const rx = ((x * 4) % 1) - 0.5;
      const ry = ((y * 4) % 1) - 0.5;
      const rd = Math.hypot(rx, ry);
      const rivet = rd > 0.44 && rd < 0.48 ? 0.5 : 0;
      // Brushed grain along x.
      const brush = (rng() - 0.5) * 0.06;
      return groove + bead + rivet + brush;
    },
    rough: [0.42, 0.34],
    metal: 0.85,
    albedoVar: 0.1,
    bump: 1.25,
  },
  /* Woven cloth: a warp/weft grid at high frequency plus slow drape. */
  cloth: {
    tile: 0.45,
    octaves: [[6, 0.4], [14, 0.2], [30, 0.1]],
    detail: (x, y) => {
      const wx = Math.sin(x * Math.PI * 2 * 64);
      const wy = Math.sin(y * Math.PI * 2 * 64);
      return wx * wy * 0.22;
    },
    rough: [0.92, 0.1],
    metal: 0.0,
    albedoVar: 0.1,
    bump: 0.6,
  },
  /* Foliage and hide — soft, irregular, matte. */
  organic: {
    tile: 1.0,
    octaves: [[10, 0.4], [22, 0.24], [46, 0.14], [92, 0.08]],
    detail: () => 0,
    rough: [0.9, 0.16],
    metal: 0.0,
    albedoVar: 0.28,
    bump: 0.8,
  },
};

/** Build (or fetch) the three maps for a family. Shared across every world. */
export function surfaceMaps(family: SurfaceFamily, size = 512): SurfaceMaps {
  const key = `${family}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const rec = RECIPES[family];
  const rng = makeRng(family.length * 7919 + size);
  const noise = tilingNoise(family.charCodeAt(0) * 31 + family.length);

  const N = size;
  const height = new Float32Array(N * N);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      let h = 0;
      let norm = 0;
      for (const [f, a] of rec.octaves) {
        h += noise(u * f, v * f, f) * a;
        norm += a;
      }
      h /= norm;
      h += rec.detail(u, v, h, rng);
      height[y * N + x] = h;
    }
  }

  // Normalise so every family lands in 0-1 and `bump` means the same thing.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < height.length; i++) {
    if (height[i] < lo) lo = height[i];
    if (height[i] > hi) hi = height[i];
  }
  const span = Math.max(1e-5, hi - lo);
  for (let i = 0; i < height.length; i++) height[i] = (height[i] - lo) / span;

  const albedo = new Uint8Array(N * N * 4);
  const normal = new Uint8Array(N * N * 4);
  const orm = new Uint8Array(N * N * 4);

  const at = (x: number, y: number) => height[((y + N) % N) * N + ((x + N) % N)];

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      const h = height[y * N + x];

      /* Albedo: white, modulated by height. The *colour* comes from the
         material's own `color`, multiplied in — one set of maps then dresses
         eleven differently-coloured worlds. */
      const shade = 1 - rec.albedoVar * (1 - h);
      const grain = 1 + (rng() - 0.5) * 0.05;
      const c = Math.max(0, Math.min(255, Math.round(shade * grain * 255)));
      albedo[i] = c;
      albedo[i + 1] = c;
      albedo[i + 2] = c;
      albedo[i + 3] = 255;

      /* Normal, from the central difference. Tangent space, +Y up. */
      const dx = (at(x + 1, y) - at(x - 1, y)) * rec.bump * N * 0.012;
      const dy = (at(x, y + 1) - at(x, y - 1)) * rec.bump * N * 0.012;
      let nx = -dx;
      let ny = -dy;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      normal[i] = Math.round((nx * 0.5 + 0.5) * 255);
      normal[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normal[i + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
      normal[i + 3] = 255;

      /* Cavity AO: how far below its own neighbourhood this texel sits. Cheap,
         and it is what puts dirt in the grooves rather than a uniform wash. */
      let around = 0;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        around += at(x + Math.round(Math.cos(a) * 3), y + Math.round(Math.sin(a) * 3));
      }
      around /= 8;
      const cav = Math.max(0, Math.min(1, 1 - (around - h) * 2.2));
      orm[i] = Math.round(cav * 255);
      orm[i + 1] = Math.round(Math.max(0, Math.min(1, rec.rough[0] + (h - 0.5) * rec.rough[1] * 2)) * 255);
      orm[i + 2] = Math.round(rec.metal * 255);
      orm[i + 3] = 255;
    }
  }

  const tex = (data: Uint8Array, srgb: boolean): THREE.DataTexture => {
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    // The whole point of baking rather than evaluating. Without mipmaps this
    // aliases exactly as badly as the analytic version it replaced.
    t.generateMipmaps = true;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };

  const maps: SurfaceMaps = {
    albedo: tex(albedo, true),
    normal: tex(normal, false),
    orm: tex(orm, false),
  };
  cache.set(key, maps);
  return maps;
}

export function disposeSurfaceCache(): void {
  for (const m of cache.values()) {
    m.albedo.dispose();
    m.normal.dispose();
    m.orm.dispose();
  }
  cache.clear();
}

/* ========================================================================== *
   Triplanar
 * ========================================================================== */

export interface SurfacedOptions {
  color: number;
  family: SurfaceFamily;
  /** Metres per tile. Defaults to the family's own. */
  tile?: number;
  roughness?: number;
  metalness?: number;
  /** Multiplies the baked normal. 0 flattens it. */
  bump?: number;
  emissive?: number;
  emissiveIntensity?: number;
  flatShading?: boolean;
  side?: THREE.Side;
  /** Extra colour variation keyed off world position, at a much larger scale
   *  than the tile. Stops a whole plaza of pillars being one shade. */
  macro?: number;
}

/**
 * A `MeshStandardMaterial` that samples its maps triplanar from world space.
 *
 * The patch replaces four of three's own chunks. Everything else about the
 * material — shadows, IBL, fog, three's lighting model — is untouched, which
 * is the entire reason for doing it this way rather than writing the shader.
 */
export function surfaced(opts: SurfacedOptions, size = 512): THREE.MeshStandardMaterial {
  const maps = surfaceMaps(opts.family, size);
  const tile = opts.tile ?? RECIPES[opts.family].tile;

  const mat = new THREE.MeshStandardMaterial({
    color: opts.color,
    roughness: opts.roughness ?? 1.0,
    metalness: opts.metalness ?? (opts.family === "metal" ? 0.85 : 0.0),
    side: opts.side ?? THREE.FrontSide,
    flatShading: opts.flatShading ?? false,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
  });

  const uniforms = {
    tAlbedo: { value: maps.albedo },
    tNormalMap: { value: maps.normal },
    tORM: { value: maps.orm },
    uTile: { value: 1 / tile },
    uBump: { value: opts.bump ?? 1 },
    uMacro: { value: opts.macro ?? 0.11 },
  };
  mat.userData.triplanar = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec3 vTriPos;
         varying vec3 vTriNrm;`,
      )
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
         vTriPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vTriNrm = normalize(mat3(modelMatrix) * objectNormal);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec3 vTriPos;
         varying vec3 vTriNrm;
         uniform sampler2D tAlbedo;
         uniform sampler2D tNormalMap;
         uniform sampler2D tORM;
         uniform float uTile;
         uniform float uBump;
         uniform float uMacro;

         /* Blend weights, sharpened. A linear |n| blend leaves a visible
            mush band 30 degrees wide on every corner; the fourth power puts
            the transition inside about eight degrees, which reads as a seam
            you have to go looking for. */
         vec3 triWeights(vec3 n){
           vec3 w = abs(n);
           w = max(w - 0.28, 0.0);
           w = w * w * w * w;
           return w / max(w.x + w.y + w.z, 1e-5);
         }

         vec4 triSample(sampler2D t, vec3 p, vec3 w){
           return texture2D(t, p.zy * uTile) * w.x
                + texture2D(t, p.xz * uTile) * w.y
                + texture2D(t, p.xy * uTile) * w.z;
         }`,
      )
      .replace(
        "#include <map_fragment>",
        `vec3 triW = triWeights(vTriNrm);
         vec4 triAlb = triSample(tAlbedo, vTriPos, triW);
         diffuseColor.rgb *= triAlb.rgb;
         // Macro variation: one low-frequency sample of the same map at a very
         // large scale, so a row of identical pillars is not identical.
         float macro = texture2D(tAlbedo, vTriPos.xz * uTile * 0.045).r;
         diffuseColor.rgb *= 1.0 - uMacro * (1.0 - macro);`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `float roughnessFactor = roughness;
         vec3 triORM = triSample(tORM, vTriPos, triW).rgb;
         roughnessFactor *= triORM.g;`,
      )
      .replace(
        "#include <metalnessmap_fragment>",
        `float metalnessFactor = metalness * mix(1.0, triORM.b, step(0.01, metalness));`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `/* Whiteout normal blend. Unpacking each plane's tangent normal and
            re-basing it onto the geometric normal keeps the detail pointing
            the right way on all six faces of a box — the naive version flips
            the lighting on three of them. */
         vec3 nx = triSample(tNormalMap, vTriPos, vec3(1.0, 0.0, 0.0)).xyz * 2.0 - 1.0;
         vec3 ny = triSample(tNormalMap, vTriPos, vec3(0.0, 1.0, 0.0)).xyz * 2.0 - 1.0;
         vec3 nz = triSample(tNormalMap, vTriPos, vec3(0.0, 0.0, 1.0)).xyz * 2.0 - 1.0;
         nx.xy *= uBump; ny.xy *= uBump; nz.xy *= uBump;
         vec3 gn = normalize(vTriNrm);
         vec3 sgn = sign(gn);
         vec3 bx = normalize(vec3(nx.z * sgn.x, nx.y, nx.x));
         vec3 by = normalize(vec3(ny.x, ny.z * sgn.y, ny.y));
         vec3 bz = normalize(vec3(nz.x, nz.y, nz.z * sgn.z));
         vec3 triN = normalize(bx * triW.x + by * triW.y + bz * triW.z + gn * 0.35);
         normal = normalize(mix(normal, triN, 0.9));`,
      )
      .replace(
        "#include <aomap_fragment>",
        `#include <aomap_fragment>
         // The baked cavity term. Applied to indirect only, which is where
         // occlusion belongs — multiplying the direct light by it turns a
         // groove into a painted black line.
         reflectedLight.indirectDiffuse *= mix(1.0, triORM.r, 0.85);`,
      );
  };

  // Two materials with different patches must not share a compiled program.
  mat.customProgramCacheKey = () =>
    `snw-tri:${opts.family}:${tile.toFixed(3)}:${(opts.bump ?? 1).toFixed(2)}:${(opts.macro ?? 0.11).toFixed(2)}`;

  return mat;
}
