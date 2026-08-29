/**
 * terraces/watercolour.ts — paint, not plastic.
 *
 * Everything else in this city is trying to be photographic: triplanar
 * albedo bakes, roughness maps, cast shadows, screen-space reflections. The
 * Terraces are trying to be a painting, and the whole reason the place reads
 * as *somewhere else* the moment you walk into it is that its surfaces are
 * shaded by a different set of rules.
 *
 * Four things separate a watercolour from a render, and all four are cheap:
 *
 *  1. **The paper is never gone.** Even in the darkest wash the tooth of the
 *     paper shows through, and the whites are not white paint — they are
 *     nothing at all. So the light end of every surface here is lifted toward
 *     one cream tone rather than toward its own colour at full brightness.
 *  2. **Pigment pools at the edges.** Water carries pigment to the boundary of
 *     a wash and leaves it there as it dries, so shapes are outlined in a
 *     darker, more saturated version of themselves. Approximated with a
 *     fresnel term, which is not what a wash edge is but lands in the same
 *     place on a rounded form.
 *  3. **Light comes in flat steps**, because a wash is either laid or it is
 *     not. The continuous falloff of a PBR light is the single most render-y
 *     thing on screen, so it is quantised — softly, so a curved surface
 *     bands rather than posterising into hard rings.
 *  4. **Granulation.** Real pigment is a suspension of particles that settle
 *     into the paper's texture, so colour is never even. Two octaves of
 *     value noise in world space, and the whole thing stops looking printed.
 *
 * Implemented as a patch on `MeshStandardMaterial` rather than a material of
 * its own, so these surfaces still take the world's real sun, the real time of
 * day and the real fog — a painting that ignored the weather would defeat the
 * other half of this change. What you get on a foggy morning is a wash that
 * has been rained on, which is exactly right.
 */
import * as THREE from "three";

/* ------------------------------------------------------------------ *
 * The patch
 * ------------------------------------------------------------------ */

const PAPER_VERT = /* glsl */ `
#include <common>
varying vec3 vWcPos;
`;

const PAPER_VERT_BODY = /* glsl */ `
#include <project_vertex>
{
  vec4 wc = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    wc = instanceMatrix * wc;
  #endif
  vWcPos = (modelMatrix * wc).xyz;
}
`;

const PAPER_FRAG = /* glsl */ `
#include <common>
varying vec3 vWcPos;
uniform vec3  uPaper;
uniform float uWash;      // 0..1 how far toward the paper the lights go
uniform float uGrain;     // 0..1 granulation strength
uniform float uEdge;      // 0..1 pigment pooling at grazing angles
uniform float uSteps;     // number of tonal steps in the wash
uniform float uFloor;     // darkest the pigment is allowed to read
uniform float uStrata;    // horizontal wash lines, 0..1

float sfHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float sfNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(sfHash(i + vec3(0,0,0)), sfHash(i + vec3(1,0,0)), f.x),
        mix(sfHash(i + vec3(0,1,0)), sfHash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(sfHash(i + vec3(0,0,1)), sfHash(i + vec3(1,0,1)), f.x),
        mix(sfHash(i + vec3(0,1,1)), sfHash(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}
`;

const PAPER_FRAG_BODY = /* glsl */ `
#include <opaque_fragment>
{
  vec3 col = gl_FragColor.rgb;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));

  /* --- flat steps ---
     Quantise the *ratio*, not the colour, so a red wall steps in brightness
     and stays red. The smoothstep across each riser keeps a curved surface
     from ringing. */
  float q = lum * uSteps;
  float band = (floor(q) + smoothstep(0.35, 0.65, fract(q))) / uSteps;
  /* The lowest band floors at zero, which multiplies the pigment out of
     existence: the shaded half of a red retaining wall came out pure black,
     which is the one thing a watercolour never does. Even the deepest wash on
     white paper is a colour. */
  band = max(band, 0.45 / uSteps);
  col *= lum > 0.0001 ? band / lum : 1.0;

  /* --- wash lines ---
     A hand-laid wash on a large area dries in bands, because the brush is
     reloaded and the edge of the previous stroke has already set. Keyed to
     world height rather than to UVs, so a 22 m retaining wall gets eight or
     nine of them and a bench gets none. */
  col *= 1.0 + sin(vWcPos.y * 2.6) * uStrata * 0.06;

  /* --- granulation ---
     Two octaves in world space: a coarse blotch where the wash pooled and a
     fine speckle where the pigment settled into the tooth. World space, so
     adjacent pieces of the same terrace share one continuous sheet of paper
     rather than each carrying its own. */
  float g = sfNoise(vWcPos * 0.22) * 0.62 + sfNoise(vWcPos * 1.9) * 0.38;
  col *= 1.0 + (g - 0.5) * uGrain;

  /* --- the paper shows through the lights ---
     Weighted by brightness, so shadows keep their pigment and highlights go
     to bare paper. This is the single biggest part of the look. */
  col = mix(col, uPaper, smoothstep(0.34, 0.98, lum) * uWash);

  /* --- pigment pools at the edge ---
     Darker and more saturated where the surface turns away. */
  /* The local 'normal', not the vNormal varying. The varying only exists when
     the material is smooth-shaded — normal_pars_fragment wraps it in
     '#ifndef FLAT_SHADED' — so reaching for it here failed to compile on
     exactly the materials that wanted faceting most (the geodesic dome, the
     snow, the stone monkey), and a fragment shader that fails to compile in
     three is a silently black mesh with the reason only in the console.
     'normal' is defined either way by normal_fragment_begin, which has already
     run by the time this chunk does.

     No backticks in here, either: this is a template literal, and a backtick
     inside a GLSL comment ends the string. */
  vec3 V = normalize(vViewPosition);
  float rim = 1.0 - abs(dot(normal, V));
  float pool = pow(clamp(rim, 0.0, 1.0), 2.2) * uEdge;
  vec3 deep = col * 0.62 + (col - vec3(lum)) * 0.5;
  col = mix(col, deep, pool);

  /* Pigment on paper has a darkest value and it is not black. The diffuse
     uniform is the material's own colour, declared by meshphysical itself, so
     this floor is per-material and a deep red stays red in shadow instead of
     going to nothing. (No backticks: template literal.) */
  col = max(col, diffuse * uFloor);

  gl_FragColor.rgb = clamp(col, 0.0, 1.6);
}
`;

/** Knobs, per material. Defaults are the house wash. */
export interface WatercolourOptions {
  /** Base pigment. */
  color: number;
  /** The paper the lights go to. One tone for the whole district. */
  paper?: number;
  /** How far the lights wash out, 0..1. */
  wash?: number;
  /** Granulation, 0..1. */
  grain?: number;
  /** Edge pooling, 0..1. */
  edge?: number;
  /** Tonal steps in the wash. Fewer is more graphic. */
  steps?: number;
  /** How dark the pigment may read, as a fraction of its own colour. */
  floorLevel?: number;
  /** Horizontal wash lines, 0..1. Worth it on anything with real height. */
  strata?: number;
  roughness?: number;
  metalness?: number;
  /** Transparent washes — the pool, the glazing in the pavilion. */
  opacity?: number;
  /** Skip back-face culling: single-sided foliage cards and awnings. */
  doubleSided?: boolean;
  /** Emissive lift, for the lanterns after dark. */
  emissive?: number;
  emissiveIntensity?: number;
  /** Draw edges only — the geodesic dome's frame over its panels. */
  wireframe?: boolean;
  /** Facet the shading. The domes want it; the washes on flat decks do not. */
  flatShading?: boolean;
}

/** The paper tone the whole district washes out to. Warm, not white. */
export const PAPER = 0xf2ebdc;

const cache = new Map<string, THREE.MeshStandardMaterial>();

/**
 * A washed material. Cached by its full option set, because every one of these
 * compiles its own program and the district uses about twenty of them across
 * several thousand pieces of geometry.
 */
export function watercolour(name: string, o: WatercolourOptions): THREE.MeshStandardMaterial {
  const key = `${name}|${JSON.stringify(o)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const m = new THREE.MeshStandardMaterial({
    name: `sf/terraces/${name}`,
    color: o.color,
    roughness: o.roughness ?? 0.94,
    metalness: o.metalness ?? 0.0,
    side: o.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    transparent: o.opacity !== undefined && o.opacity < 1,
    opacity: o.opacity ?? 1,
    emissive: new THREE.Color(o.emissive ?? 0x000000),
    emissiveIntensity: o.emissiveIntensity ?? 1,
    wireframe: o.wireframe ?? false,
    flatShading: o.flatShading ?? false,
    depthWrite: (o.opacity ?? 1) >= 1,
  });

  const uniforms = {
    uPaper: { value: new THREE.Color(o.paper ?? PAPER) },
    uWash: { value: o.wash ?? 0.42 },
    uGrain: { value: o.grain ?? 0.17 },
    uEdge: { value: o.edge ?? 0.32 },
    uSteps: { value: o.steps ?? 4 },
    uFloor: { value: o.floorLevel ?? 0.26 },
    uStrata: { value: o.strata ?? 0 },
  };

  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", PAPER_VERT)
      .replace("#include <project_vertex>", PAPER_VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", PAPER_FRAG)
      .replace("#include <opaque_fragment>", PAPER_FRAG_BODY);
  };
  /* Without this, three hashes the *patched* source to key its program cache,
     which is fine — but every material here patches identically apart from its
     uniforms, so they would all share one program and the first one's uniform
     block would win. Naming the key per material keeps them apart. */
  m.customProgramCacheKey = () => `sf-watercolour-${key}`;

  cache.set(key, m);
  return m;
}

/** Free every material this module has handed out. */
export function disposeWatercolour(): void {
  for (const m of cache.values()) m.dispose();
  cache.clear();
}

/* ------------------------------------------------------------------ *
 * The palette
 * ------------------------------------------------------------------ */

/**
 * Read straight off the painting, and deliberately narrow.
 *
 * The thing that makes a watercolour look like a watercolour is not any one
 * hue, it is that they all came out of the same eight pans and share a
 * temperature. Twenty ad-hoc colours would land right back in the middle of
 * the render this place is trying not to be.
 */
export const WASH = {
  /** The red earth of the base terraces. Iron oxide, thinned. */
  earth: () => watercolour("earth", { strata: 1, color: 0xb4643f, wash: 0.26, grain: 0.22, steps: 3 }),
  /** The same earth underfoot: trodden, a shade browner. */
  earthDeck: () => watercolour("earth-deck", { color: 0x9c5a3c, wash: 0.24, grain: 0.24, steps: 3 }),
  /** The middle of the mountain, where the planting is. Warm and dusty. */
  ochre: () => watercolour("ochre", { strata: 1, color: 0xcfa269, wash: 0.3, grain: 0.2, steps: 3 }),
  /** Retaining walls and the switchback path — bare paper with a shadow in it. */
  path: () => watercolour("path", { strata: 1, color: 0xe6dcc6, wash: 0.34, grain: 0.16, steps: 3 }),
  /** Terrace decks: dry grass over stone. */
  terrace: () => watercolour("terrace", { color: 0xc0b581, wash: 0.28, grain: 0.2, steps: 3 }),
  /** Under the vines: worked ground, greener than the terrace. */
  vineDeck: () => watercolour("vine-deck", { color: 0x9a9c6a, wash: 0.26, grain: 0.22, steps: 3 }),
  /** The shaded side of snow, which is blue and is never white. */
  snowShade: () => watercolour("snow-shade", { color: 0xd7dbe0, wash: 0.4, grain: 0.12, edge: 0.3, steps: 3 }),
  /** Vineyard and orchard green. Olive, not emerald — nothing here is saturated. */
  vine: () => watercolour("vine", { color: 0x7e9060, wash: 0.3, grain: 0.24, steps: 3, doubleSided: true }),
  /** The great tree's canopy. */
  canopy: () =>
    watercolour("canopy", {
      color: 0x6f8a5c, wash: 0.3, grain: 0.26, steps: 4, doubleSided: true,
      /* Faceted. A smooth ellipsoid of one green is a balloon; a mass of flat
         planes at slightly different angles is how a painter puts down a tree,
         one loaded brush at a time. */
      flatShading: true,
    }),
  /** Banana palms by the pool: yellower, thinner. */
  frond: () => watercolour("frond", { color: 0x8fa257, wash: 0.36, grain: 0.2, steps: 3, doubleSided: true }),
  /** Trunks, posts, pergola timbers. */
  timber: () => watercolour("timber", { color: 0x8a6f52, wash: 0.3, grain: 0.2, steps: 3 }),
  /** The pool. The one properly saturated thing in the painting. */
  pool: () => watercolour("pool", { color: 0x37b0ad, wash: 0.16, grain: 0.3, edge: 0.7, steps: 5, roughness: 0.28 }),
  /** Pagoda lacquer. */
  vermilion: () => watercolour("vermilion", { color: 0xc2523a, wash: 0.26, grain: 0.18, steps: 3 }),
  /** Pagoda roofs and the summit pavilion's, a blue-grey tile. */
  tile: () => watercolour("tile", { color: 0x6d7f8c, wash: 0.34, grain: 0.2, steps: 3 }),
  /** Plaster: the dome's panels, the pavilion walls. */
  plaster: () => watercolour("plaster", { color: 0xe4d9be, wash: 0.38, grain: 0.14, steps: 3 }),
  /** Snow at the summit. Almost nothing but paper. */
  snow: () => watercolour("snow", { color: 0xf6f3ec, wash: 0.5, grain: 0.1, edge: 0.3, steps: 3 }),
  /** The buttresses down the retaining walls. A shade cooler than the wall. */
  rib: () => watercolour("rib", { color: 0xbdb39a, wash: 0.3, grain: 0.18, steps: 3, strata: 1 }),
  /** The dome's struts and the solar array's frames. */
  strut: () => watercolour("strut", { color: 0x9aa0a2, wash: 0.4, grain: 0.12, steps: 3, metalness: 0.15, roughness: 0.6 }),
  /** Solar glass, seen almost edge-on from anywhere you can stand. */
  solar: () => watercolour("solar", { color: 0x2f4258, wash: 0.12, grain: 0.14, edge: 0.6, steps: 4, roughness: 0.32, metalness: 0.2 }),
  /** The miniature city, all one stone. */
  model: () => watercolour("model", { color: 0xded4c0, wash: 0.46, grain: 0.18, steps: 3 }),
  /** The model's Golden Gate, which has to be orange or it is not the bridge. */
  modelOrange: () => watercolour("model-orange", { color: 0xc0603a, wash: 0.3, grain: 0.16, steps: 3 }),
  /** Lantern paper, lit from inside after dark. */
  lantern: () =>
    watercolour("lantern", {
      color: 0xf0d9a8, wash: 0.2, grain: 0.1, steps: 3,
      emissive: 0xffc879, emissiveIntensity: 0.85,
    }),
} as const;
