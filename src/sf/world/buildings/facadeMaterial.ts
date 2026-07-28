/**
 * The facade material — one shader for every wall in San Francisco.
 *
 * WHY procedural instead of textures: a city block has ~250 buildings and a
 * dozen material families. Atlasing real facade textures at a density where
 * you can stand on a stoop and believe it would cost hundreds of megabytes and
 * still tile visibly from a helicopter. Instead every wall carries four bytes
 * of description (surface id, storey height, per-building hash, window
 * intensity) and a metre-space UV, and the fragment shader draws the brick
 * courses, the window sashes, the mullions, the clapboard, the sill dirt and
 * the lit windows at night. It is scale-correct at every distance, costs no
 * texture memory, and — the part that actually matters — it means one draw
 * call can carry an entire chunk of city.
 *
 * The shader is grafted onto MeshStandardMaterial via onBeforeCompile so it
 * keeps three's real PBR lighting, shadow cascades, fog and tone mapping. We
 * are replacing the *surface*, not the lighting model.
 *
 * Public API
 * ----------
 *   getFacadeMaterial(fading)   shared material (or a fresh fading clone)
 *   facadeUniforms              live uniform objects, shared by every instance
 *   updateFacadeUniforms(...)   call once per frame from the streaming component
 *   disposeFacadeMaterials()    tear down on unmount
 */
import * as THREE from "three";
import { clamp01, smoothstep } from "../../math/rng";

/* ------------------------------------------------------------------ *
 * Shared uniforms
 * ------------------------------------------------------------------ *
 * These objects are handed by reference to every compiled program, so writing
 * `.value` once updates the whole city. Never replace the object.
 */
export const facadeUniforms = {
  /** 0 = full daylight, 1 = fully dark. Drives lit windows and glass reflectivity. */
  uNight: { value: 0 },
  /** Probability a given window is lit at full night. */
  uNightLit: { value: 0.55 },
  uSunDir: { value: new THREE.Vector3(0.3, 0.7, 0.5) },
  uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
  uSkyZenith: { value: new THREE.Color(0.28, 0.42, 0.68) },
  uSkyHorizon: { value: new THREE.Color(0.72, 0.79, 0.86) },
  /** Marine layer 0..1 — washes out facade contrast the way real fog does. */
  uHaze: { value: 0.3 },
};

/** Per-material fade uniform, cloned per chunk during an LOD cross-fade. */
type FadeUniform = { value: number };

/* ------------------------------------------------------------------ *
 * GLSL
 * ------------------------------------------------------------------ */

const COMMON_GLSL = /* glsl */ `
uniform float uNight;
uniform float uNightLit;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyZenith;
uniform vec3  uSkyHorizon;
uniform float uHaze;
#ifdef SF_FADE
uniform float uFade;
#endif

varying vec4 vFacade;
varying vec4 vTintV;
varying vec2 vFacUv;
varying vec3 vWPos;
varying vec3 vWNrm;

float sfHash1(float n) { return fract(sin(n * 12.9898) * 43758.5453123); }
float sfHash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

float sfNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = sfHash2(i);
  float b = sfHash2(i + vec2(1.0, 0.0));
  float c = sfHash2(i + vec2(0.0, 1.0));
  float d = sfHash2(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float sfFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += sfNoise(p) * a;
    p = p * 2.03 + 17.3;
    a *= 0.5;
  }
  return s;
}

/** Anti-aliased axis-aligned rectangle coverage in a unit cell. */
float sfRect(vec2 f, vec2 c, vec2 hs, vec2 aa) {
  vec2 d = abs(f - c);
  vec2 m = vec2(1.0) - smoothstep(hs - aa, hs + aa, d);
  return m.x * m.y;
}

/** Cheap sRGB -> linear. The vertex tint is stored sRGB-encoded in 8 bits. */
vec3 sfSrgb(vec3 c) {
  return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878);
}

/** Interleaved gradient noise — the dither pattern for LOD cross-fades. */
float sfIgn(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}
`;

const VERTEX_HEAD = /* glsl */ `
attribute vec4 aFacade;
attribute vec4 aTint;
`;

const VERTEX_BODY = /* glsl */ `
  vFacade = aFacade;
  vTintV = aTint;
  vFacUv = uv;
  vec4 sfWorld = modelMatrix * vec4(transformed, 1.0);
  vWPos = sfWorld.xyz;
  vWNrm = normalize(mat3(modelMatrix) * objectNormal);
`;

/**
 * The surface itself. Runs in place of `<map_fragment>`; publishes roughness,
 * metalness and emissive through globals that later chunks pick up.
 */
const SURFACE_GLSL = /* glsl */ `
  float sid = floor(vFacade.x * 255.0 + 0.5);
  float fh = max(vFacade.y * 8.0, 2.2);
  float bh = vFacade.z;
  float winI = vFacade.w;
  vec2 P = vFacUv;

  vec3 albedo = sfSrgb(vTintV.rgb);
  sfRough = 0.90;
  sfMetal = 0.0;
  sfEmis = vec3(0.0);

  // Texel footprint in metres — everything high-frequency fades out with it,
  // which is the difference between "detailed" and "a shimmering mess".
  float px = max(fwidth(P.x), fwidth(P.y)) + 1e-5;
  float dFine = 1.0 - smoothstep(0.010, 0.075, px);
  float dMid  = 1.0 - smoothstep(0.055, 0.290, px);
  float dWin  = 1.0 - smoothstep(0.300, 1.300, px);

  float grime = sfFbm(P * 0.33 + bh * 41.0);
  float macro = sfFbm(P * 0.041 + bh * 13.0);

  float glassLike = 0.0;
  vec2 cellId = vec2(floor(P.x * 0.31), floor(P.y / fh));
  vec3 glassTint = vec3(0.045, 0.058, 0.068);
  float isWall = 1.0;

  /* -------------------------------------------------- windowed masonry */
  if (sid < 2.5 || abs(sid - 6.0) < 0.5) {
    float bw = mix(2.55, 4.35, sfHash1(bh * 91.7 + 3.0));
    float ci = floor(P.x / bw);
    float cf = fract(P.x / bw);
    float ri = floor(P.y / fh);
    float rf = fract(P.y / fh);
    cellId = vec2(ci, ri);

    float ww = mix(0.36, 0.58, sfHash1(bh * 13.0 + ci * 0.1137));
    float sill = 0.28;
    float head = 0.84;
    // Ground floor is commercial in almost all of this city: full-height glass,
    // or a garage door out in the avenues.
    if (ri < 0.5) { ww = 0.76; sill = 0.09; head = 0.80; }

    vec2 f = vec2(cf, rf);
    vec2 wc = vec2(0.5, (sill + head) * 0.5);
    vec2 wh = vec2(ww * 0.5, (head - sill) * 0.5);
    vec2 aa = vec2(fwidth(cf), fwidth(rf)) * 1.1 + 0.0035;

    float opening = sfRect(f, wc, wh, aa) * winI * dWin;

    // Surround: trim board (wood), moulded architrave (stone), soldier course
    // (brick). Same geometry, different colour treatment below.
    float surround = (sfRect(f, wc, wh + vec2(0.055, 0.045), aa) - opening) * winI * dMid;
    // Reveal shadow: the head and the left jamb are always in shade.
    float reveal = (sfRect(f, wc + vec2(0.012, -0.014), wh, aa) - opening) * winI * dMid;

    // Muntins split the sash — the single cue that reads "old window".
    float muntin = max(
      1.0 - smoothstep(0.009, 0.016, abs(cf - 0.5)),
      1.0 - smoothstep(0.007, 0.013, abs(rf - (sill + head) * 0.5))
    ) * opening * dMid;

    if (sid < 0.5) {
      // Stucco: fine orange-peel grain, hairline cracks in the macro noise.
      albedo *= 0.93 + 0.14 * sfNoise(P * 22.0) * dFine + 0.10 * macro;
      albedo = mix(albedo, albedo * 1.10, surround);
      sfRough = 0.94;
    } else if (sid < 1.5) {
      // Brick: real 8"x2.25" courses with a running bond and per-brick colour.
      float ch = 0.077;
      float bl = 0.205;
      float row = floor(P.y / ch);
      float ux = P.x / bl + mod(row, 2.0) * 0.5;
      float bx = fract(ux);
      float by = fract(P.y / ch);
      float mj = 1.0 - (smoothstep(0.0, 0.055, bx) * (1.0 - smoothstep(0.945, 1.0, bx)));
      float bj = 1.0 - (smoothstep(0.0, 0.10, by) * (1.0 - smoothstep(0.90, 1.0, by)));
      float mortar = clamp(max(mj, bj), 0.0, 1.0) * dFine;
      float brickVar = sfHash2(vec2(floor(ux), row));
      albedo *= 0.84 + 0.32 * brickVar * dFine;
      albedo = mix(albedo, albedo * 0.62 + vec3(0.115, 0.108, 0.098), mortar * 0.85);
      albedo = mix(albedo, albedo * 1.06 + vec3(0.02), surround);
      sfRough = 0.93;
    } else if (sid < 2.5) {
      // Cut stone / terracotta: ashlar joints, heavier rustication at the base.
      float bandH = 1.12;
      float jv = 1.0 - smoothstep(0.012, 0.030, abs(fract(P.y / bandH) - 0.5) * bandH);
      float rust = smoothstep(9.0, 5.0, P.y);
      float jh = 1.0 - smoothstep(0.014, 0.034, abs(fract(P.x / 1.8) - 0.5) * 1.8);
      float joint = clamp(jv + jh * rust, 0.0, 1.0) * dFine;
      albedo *= 0.96 + 0.08 * sfNoise(P * 5.5) + 0.06 * macro;
      albedo = mix(albedo, albedo * 0.74, joint * 0.8);
      albedo = mix(albedo, albedo * 1.12, surround);
      sfRough = 0.88;
    } else {
      // Victorian wood: clapboard, and paint that has taken thirty winters.
      float lap = 0.145;
      float ly = fract(P.y / lap);
      float lapShade = mix(0.80, 1.06, smoothstep(0.0, 0.55, ly));
      float lapLine = 1.0 - smoothstep(0.0, 0.055, ly);
      albedo *= mix(1.0, lapShade, dFine);
      albedo = mix(albedo, albedo * 0.66, lapLine * dFine * 0.8);
      albedo *= 0.95 + 0.11 * macro;
      // Trim on a painted lady is a *different* colour, not a shade.
      vec3 trimCol = mix(vec3(0.93, 0.90, 0.84), albedo * 1.5 + vec3(0.05), sfHash1(bh * 7.3));
      albedo = mix(albedo, trimCol, surround * 0.9);
      sfRough = 0.86;
    }

    albedo = mix(albedo, albedo * 0.58, reveal * 0.7);
    albedo = mix(albedo, glassTint, opening);
    albedo = mix(albedo, vec3(0.86, 0.85, 0.82), muntin * 0.9);
    glassLike = opening * (1.0 - muntin);

    // Sill dirt: rain runs off the sill and stains the wall below it. This one
    // detail does more for "real building" than any amount of extra geometry.
    float belowSill = smoothstep(sill, sill - 0.30, rf) * step(0.5, ri);
    float streak = sfNoise(vec2(P.x * 6.0 + bh * 31.0, P.y * 0.09));
    albedo *= 1.0 - belowSill * streak * 0.22 * dMid * (0.4 + 0.6 * winI);

  /* -------------------------------------------------- curtain wall */
  } else if (abs(sid - 3.0) < 0.5) {
    float mw = mix(1.42, 1.72, sfHash1(bh * 57.0));
    float fx = fract(P.x / mw);
    float fy = fract(P.y / fh);
    cellId = vec2(floor(P.x / mw), floor(P.y / fh));
    float dMullV = min(fx, 1.0 - fx) * mw;
    float dMullH = min(fy, 1.0 - fy) * fh;
    float mullV = (1.0 - smoothstep(0.030, 0.072, dMullV)) * dMid;
    // Spandrel: the opaque panel hiding the floor slab and the plenum.
    float spandrelH = mix(0.85, 1.25, sfHash1(bh * 23.0));
    float spandrel = 1.0 - smoothstep(spandrelH * 0.5, spandrelH * 0.5 + 0.30, dMullH);
    float mullH = (1.0 - smoothstep(0.030, 0.070, dMullH)) * dMid;

    vec3 mullionCol = mix(vec3(0.14, 0.145, 0.15), vec3(0.55, 0.56, 0.58), sfHash1(bh * 3.1));
    vec3 spandrelCol = albedo * mix(0.35, 0.75, sfHash1(bh * 5.7));
    glassTint = mix(vec3(0.035, 0.055, 0.075), vec3(0.05, 0.075, 0.062), sfHash1(bh * 17.0));

    albedo = glassTint;
    albedo = mix(albedo, spandrelCol, spandrel);
    albedo = mix(albedo, mullionCol, max(mullV, mullH));
    glassLike = (1.0 - spandrel) * (1.0 - max(mullV, mullH));
    sfRough = 0.34;
    isWall = 1.0;

  /* -------------------------------------------------- built-up roof */
  } else if (abs(sid - 4.0) < 0.5) {
    isWall = 0.0;
    float gravel = sfNoise(P * 9.0) * dFine + sfFbm(P * 1.3) * 0.9;
    albedo *= 0.62 + 0.55 * gravel;
    // Cap-sheet seams every 0.95 m, and pale patches where it has been redone.
    float seam = 1.0 - smoothstep(0.03, 0.075, abs(fract(P.x / 0.95) - 0.5) * 0.95);
    albedo = mix(albedo, albedo * 0.72, seam * dFine * 0.8);
    float patch = smoothstep(0.56, 0.70, sfFbm(P * 0.13 + bh * 61.0));
    albedo = mix(albedo, albedo * 1.55 + vec3(0.03), patch * 0.7);
    // Ponding water — dead flat roofs never drain properly.
    float pond = smoothstep(0.62, 0.78, sfFbm(P * 0.09 + 91.0 * bh));
    sfRough = mix(0.95, 0.18, pond);
    albedo = mix(albedo, albedo * 0.55, pond * 0.6);

  /* -------------------------------------------------- metal */
  } else if (abs(sid - 5.0) < 0.5) {
    albedo *= 0.88 + 0.24 * sfNoise(P * 14.0) * dFine + 0.10 * macro;
    float rust = smoothstep(0.60, 0.82, sfFbm(vec2(P.x * 1.4, P.y * 0.25) + bh * 7.0));
    albedo = mix(albedo, vec3(0.24, 0.11, 0.055), rust * 0.55);
    sfRough = mix(0.45, 0.85, rust);
    sfMetal = 0.0;

  /* -------------------------------------------------- clay tile roof */
  } else if (abs(sid - 7.0) < 0.5) {
    isWall = 0.0;
    float pitchU = P.x / 0.185;
    float rib = sin(fract(pitchU) * 6.28318);
    float course = fract(P.y / 0.34);
    albedo *= 0.78 + 0.30 * (rib * 0.5 + 0.5) * dFine;
    albedo *= 0.90 + 0.20 * sfHash2(vec2(floor(pitchU), floor(P.y / 0.34)));
    albedo = mix(albedo, albedo * 0.62, (1.0 - smoothstep(0.0, 0.09, course)) * dFine);
    albedo = mix(albedo, albedo * vec3(0.85, 0.95, 0.85), smoothstep(0.66, 0.85, sfFbm(P * 0.5)) * 0.5);
    sfRough = 0.86;

  /* -------------------------------------------------- corrugated steel */
  } else if (abs(sid - 8.0) < 0.5) {
    float rib = sin(P.x / 0.112 * 6.28318);
    albedo *= 0.80 + 0.34 * (rib * 0.5 + 0.5) * dFine;
    float rust = smoothstep(0.52, 0.80, sfFbm(vec2(P.x * 0.9, P.y * 0.18) + bh * 3.0) + (1.0 - smoothstep(0.0, 3.0, P.y)) * 0.25);
    albedo = mix(albedo, vec3(0.26, 0.12, 0.06), rust * 0.6);
    sfRough = mix(0.40, 0.88, rust);

  /* -------------------------------------------------- plain glazing */
  } else if (abs(sid - 9.0) < 0.5) {
    float mw = 1.35;
    float fx = fract(P.x / mw);
    float fy = fract(P.y / 2.6);
    cellId = vec2(floor(P.x / mw), floor(P.y / 2.6));
    float frame = max(
      1.0 - smoothstep(0.022, 0.055, min(fx, 1.0 - fx) * mw),
      1.0 - smoothstep(0.022, 0.055, min(fy, 1.0 - fy) * 2.6)
    ) * dMid;
    albedo = mix(glassTint, vec3(0.20, 0.20, 0.21), frame);
    glassLike = 1.0 - frame;
    sfRough = 0.16;

  /* -------------------------------------------------- concrete */
  } else if (abs(sid - 10.0) < 0.5) {
    albedo *= 0.90 + 0.16 * sfNoise(P * 17.0) * dFine + 0.12 * macro;
    // Board-form lines and snap-tie holes: concrete remembers its formwork.
    float board = 1.0 - smoothstep(0.008, 0.020, abs(fract(P.y / 0.204) - 0.5) * 0.204);
    albedo = mix(albedo, albedo * 0.84, board * dFine * 0.7);
    float tie = sfRect(vec2(fract(P.x / 0.61), fract(P.y / 0.82)), vec2(0.5), vec2(0.035), vec2(0.02));
    albedo = mix(albedo, albedo * 0.62, tie * dFine);
    float stain = smoothstep(0.55, 0.85, sfFbm(vec2(P.x * 0.8, P.y * 0.12) + bh * 5.0));
    albedo *= 1.0 - stain * 0.18;
    sfRough = 0.95;

  /* -------------------------------------------------- asphalt / deck */
  } else {
    isWall = 0.0;
    albedo *= 0.70 + 0.42 * sfNoise(P * 11.0) * dFine + 0.18 * sfFbm(P * 0.7);
    sfRough = 0.97;
  }

  /* -------------------------------------------------- shared weathering */
  // Ambient occlusion into the street: the bottom few metres of every wall in
  // a dense city sit in a permanent shadow gradient.
  albedo *= mix(0.66, 1.0, smoothstep(-1.0, 5.0, P.y)) * isWall + (1.0 - isWall);
  albedo *= 0.92 + 0.16 * macro;
  // Fog bleaches contrast on the seaward faces.
  albedo = mix(albedo, vec3(dot(albedo, vec3(0.33))) * 1.06, uHaze * 0.14);

  /* -------------------------------------------------- glazing response */
  if (glassLike > 0.002) {
    vec3 V = normalize(cameraPosition - vWPos);
    vec3 Nw = normalize(vWNrm);
    float ndv = clamp(dot(Nw, V), 0.0, 1.0);
    float fres = pow(1.0 - ndv, 4.0);
    vec3 R = reflect(-V, Nw);
    vec3 sky = mix(uSkyHorizon, uSkyZenith, clamp(R.y * 0.5 + 0.5, 0.0, 1.0));
    float glint = pow(max(dot(R, uSunDir), 0.0), 160.0);
    // No env map in this renderer, so the sky reflection is added as emission.
    // It is a lie, but it is the *right* lie: glass towers in this city are
    // mostly a mirror of the sky, and without it they read as grey cardboard.
    vec3 refl = sky * (0.14 + fres * 1.05) + uSunColor * glint * 2.4;
    sfEmis += refl * glassLike * (1.0 - uNight * 0.62) * (1.0 - uHaze * 0.35);
    sfRough = mix(sfRough, 0.08, glassLike * 0.85);

    // Night: a scatter of lit floors, warm tungsten with a few cold offices.
    float lh = sfHash2(cellId + vec2(bh * 137.0, bh * 71.0));
    float lit = step(1.0 - uNightLit * uNight * (0.55 + 0.9 * bh), lh);
    vec3 warm = mix(vec3(1.0, 0.74, 0.42), vec3(0.78, 0.88, 1.0), step(0.78, fract(lh * 17.0)));
    // Flicker-free, but not uniform: each window has its own brightness.
    sfEmis += warm * lit * glassLike * uNight * (1.1 + 1.6 * fract(lh * 53.0));
    albedo = mix(albedo, albedo + warm * 0.06, lit * uNight);
  }

  diffuseColor.rgb = albedo;
`;

/* ------------------------------------------------------------------ *
 * Material construction
 * ------------------------------------------------------------------ */

function patch(mat: THREE.MeshStandardMaterial, fading: boolean, fadeUniform?: FadeUniform): void {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, facadeUniforms);
    if (fading && fadeUniform) shader.uniforms.uFade = fadeUniform as { value: number };

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_HEAD}\n${COMMON_GLSL}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${VERTEX_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>\n${COMMON_GLSL}\nfloat sfRough;\nfloat sfMetal;\nvec3 sfEmis;`,
      )
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
        #ifdef SF_FADE
          if (uFade < 0.999) {
            // Dithered LOD cross-fade. Screen-door beats alpha blending here:
            // no sort order, no transparency pass, and TAA resolves the noise
            // into a clean dissolve.
            if (uFade < sfIgn(gl_FragCoord.xy)) discard;
          }
        #endif`,
      )
      .replace("#include <map_fragment>", SURFACE_GLSL)
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = clamp(sfRough, 0.03, 1.0);")
      .replace("#include <metalnessmap_fragment>", "float metalnessFactor = sfMetal;")
      .replace(
        "#include <emissivemap_fragment>",
        "totalEmissiveRadiance = sfEmis + totalEmissiveRadiance;",
      );
  };
  // Every variant compiles to the same program family; without this three
  // would recompile per material instance and stall on every LOD transition.
  mat.customProgramCacheKey = () => (fading ? "sf-facade-fade" : "sf-facade");
  if (fading) mat.defines = { ...(mat.defines ?? {}), SF_FADE: "" };
}

let baseMaterial: THREE.MeshStandardMaterial | null = null;
const fadingMaterials: THREE.MeshStandardMaterial[] = [];

function makeBase(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0.0,
    vertexColors: false,
    dithering: true,
    side: THREE.FrontSide,
  });
  // Emissive must be non-black or three strips the emissive code path.
  m.emissive = new THREE.Color(0.0004, 0.0004, 0.0004);
  return m;
}

/**
 * The one material every non-fading chunk shares.
 */
export function getFacadeMaterial(): THREE.MeshStandardMaterial {
  if (!baseMaterial) {
    baseMaterial = makeBase();
    patch(baseMaterial, false);
  }
  return baseMaterial;
}

/**
 * A fresh material for a chunk that is mid-cross-fade. Cheap: it shares the
 * compiled program (see customProgramCacheKey) and every uniform except uFade.
 * Call `releaseFadeMaterial` when the transition finishes.
 */
export function createFadeMaterial(): {
  material: THREE.MeshStandardMaterial;
  fade: FadeUniform;
} {
  const fade: FadeUniform = { value: 0 };
  const m = makeBase();
  patch(m, true, fade);
  fadingMaterials.push(m);
  return { material: m, fade };
}

export function releaseFadeMaterial(m: THREE.MeshStandardMaterial): void {
  const i = fadingMaterials.indexOf(m);
  if (i >= 0) fadingMaterials.splice(i, 1);
  m.dispose();
}

/* ------------------------------------------------------------------ *
 * Per-frame uniform update
 * ------------------------------------------------------------------ */

const _sunDir = new THREE.Vector3();
const _sunCol = new THREE.Color();
const _skyCol = new THREE.Color();

/**
 * Push the current sky state into the facade shader. Called once per frame by
 * the streaming component; allocates nothing.
 *
 * @param sunDir   normalised sun direction (from sky/Sky.tsx `sunDirection`)
 * @param sunColor key light colour
 * @param skyFill  ambient/sky colour
 * @param hour     local time of day, 0..24
 * @param fog      marine-layer density 0..1
 */
export function updateFacadeUniforms(
  sunDir: THREE.Vector3,
  sunColor: THREE.Color,
  skyFill: THREE.Color,
  hour: number,
  fog: number,
): void {
  facadeUniforms.uSunDir.value.copy(sunDir);
  facadeUniforms.uSunColor.value.copy(sunColor);
  // Horizon is the sky fill warmed toward the sun; zenith is the fill cooled.
  facadeUniforms.uSkyHorizon.value.copy(skyFill).lerp(sunColor, 0.35).multiplyScalar(1.15);
  facadeUniforms.uSkyZenith.value.copy(skyFill).multiplyScalar(0.85);
  facadeUniforms.uSkyZenith.value.b = Math.min(1.2, facadeUniforms.uSkyZenith.value.b * 1.25);

  // Windows come on at dusk and go off through the small hours — offices empty
  // out, apartments do not.
  const elev = sunDir.y;
  const night = clamp01(1 - smoothstep(-0.12, 0.10, elev));
  facadeUniforms.uNight.value = night;
  const late = hour > 23 || hour < 5 ? 0.45 : 1.0;
  facadeUniforms.uNightLit.value = 0.5 * late;
  facadeUniforms.uHaze.value = clamp01(fog);
  void _sunDir;
  void _sunCol;
  void _skyCol;
}

/** Free the shared materials. Called when the buildings system unmounts. */
export function disposeFacadeMaterials(): void {
  if (baseMaterial) {
    baseMaterial.dispose();
    baseMaterial = null;
  }
  for (const m of fadingMaterials.splice(0)) m.dispose();
}
