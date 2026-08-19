/**
 * The dressing layer — everything human-scale that makes The Empyrean a place
 * somebody lives rather than a block model with a nice silhouette.
 *
 * Lamps, trees, hedges, awnings, signs, market stalls, crates, string lights,
 * banners, pennants, benches, bollards, bins, cycle racks, drinking fountains,
 * notice columns, newsstands, rooftop clutter, promenade rails, telescopes,
 * wind socks and the water in the Cistern. Roughly six thousand objects.
 *
 * ## The two rules this file is built around
 *
 * **Nothing is invented.** Every position comes out of `cityplan.ts` and is
 * then *checked* with `surfaceAt()` before it is kept. A prop generator that
 * trusts its own arithmetic puts a bench in the middle of an avenue, and props
 * on the roadway is the single most obvious tell that a city was generated.
 * Every street-level placement in here goes through `onWalk()`, which accepts
 * `walk`, `plaza` and `promenade` and nothing else; lot furniture goes through
 * a point-in-polygon test against the lot it belongs to.
 *
 * **Six thousand objects, two dozen draw calls.** Three techniques, chosen per
 * family rather than globally:
 *
 * - *Instanced* for the thousands that are all the same object: the three lamp
 *   fixtures, tree trunks, tree canopies, the light pools. Per-instance colour
 *   rides on `instanceColor`, so a lamp in the Bazaar is warmer than one in
 *   the Spires without costing a second mesh.
 * - *Merged, chunked by octant* for the street dressing, where every item wants
 *   its own colours (striped awnings, painted signs, market canvas) and would
 *   need a separate InstancedMesh per colourway if it were instanced. Eight
 *   chunks, so frustum culling — which on an InstancedMesh is all-or-nothing —
 *   still does something, and so `update()` can hide the far half of the island
 *   with eight distance tests and no per-instance work at all.
 * - *One Points cloud* for every emissive dot in the city: lamp heads, string
 *   light bulbs, sign glows. Points billboard for free and clamp their own
 *   size, which is what keeps a lamp readable at a kilometre and stops the one
 *   you are standing under filling the screen.
 *
 * ## Lighting
 *
 * `MeshStandardMaterial`, lit by the scene's sun, hemisphere and rim lights, so
 * the props follow whatever `lighting.ts` does with the day cycle for free.
 * Two things are injected with `onBeforeCompile` and shared across every
 * material through one uniforms object:
 *
 * - `uNight`, which multiplies a per-vertex emissive mask. That is the dusk
 *   switch-on: lamp glass, sign faces, stall lights and the poster bands on the
 *   notice columns are ordinary painted geometry at noon and glowing above 1.0
 *   at sunset, which is what makes them bloom in `postfx`.
 * - `uTime`/`uWind`, which sway a per-vertex wind mask. Leaves and canvas move,
 *   trunks barely, stone not at all. The phase comes from the instance's own
 *   world origin, so four hundred trees are not one tree four hundred times.
 *
 * Neither costs a uniform upload per object and neither allocates per frame.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { makeRng, type Rng } from "@/shared/proc/rng";
import {
  AVENUE_A0,
  AVENUE_N,
  HALO_R,
  LANE_A0,
  LANE_N,
  RIM_R,
  RING_R,
  W,
  cityPlan,
  districtAt,
  surfaceAt,
  type DistrictId,
  type Lot,
} from "./cityplan";
import { DECKS, ISLAND_Y, PLATEAU_R } from "./config";
import { SUN_DIR } from "./sky";
import type { BuildContext, FrameContext, System } from "./types";

/* -------------------------------------------------------------------------
 * Public shape
 * ---------------------------------------------------------------------- */

/** One thing that got placed. Kept so the tests can audit the ground truth. */
export interface PropPlacement {
  kind: string;
  x: number;
  z: number;
  y: number;
}

export interface PropsHandle extends System {
  /** Small solid things the player should not walk through, if any. */
  blockers?: Array<{
    x: number;
    z: number;
    hx: number;
    hz: number;
    top: number;
    bottom: number;
  }>;
  /** Everything that was placed at street level, for tests and debugging. */
  readonly placements: readonly PropPlacement[];
  /** How many meshes the system contributes to the frame. */
  readonly drawCalls: number;
  /** Per-family counts, for tests and for tuning. */
  readonly counts: Readonly<Record<string, number>>;
}

const TAU = Math.PI * 2;

/* -------------------------------------------------------------------------
 * Palette
 *
 * Warm, optimistic, and pitched for a sunset: painted metal rather than rust,
 * cream canvas rather than grey, and greens that are still green at 18:40.
 * ---------------------------------------------------------------------- */

const C = {
  ironDark: new THREE.Color("#2f3742"),
  ironWarm: new THREE.Color("#4a4038"),
  brass: new THREE.Color("#b9884a"),
  steel: new THREE.Color("#8d99a6"),
  stone: new THREE.Color("#cfc3b0"),
  paleStone: new THREE.Color("#e4dbc9"),
  wood: new THREE.Color("#a3703f"),
  woodPale: new THREE.Color("#c69760"),
  cream: new THREE.Color("#f4ecda"),
  lampGlass: new THREE.Color("#ffcf92"),
  bulb: new THREE.Color("#ffc46b"),
  leaf: new THREE.Color("#4f8f4e"),
  leafWarm: new THREE.Color("#7fae4c"),
  leafBlue: new THREE.Color("#3f7d63"),
  blossom: new THREE.Color("#f3b6c8"),
  soil: new THREE.Color("#5b4433"),
  water: new THREE.Color("#7fd7d2"),
} as const;

/** District signal colours, straight off the plan, as THREE colours. */
const ACCENT: Record<DistrictId, THREE.Color> = {
  halo: new THREE.Color("#ffd28a"),
  core: new THREE.Color("#8fd6ff"),
  market: new THREE.Color("#ffb35c"),
  gardens: new THREE.Color("#9ce8a8"),
  rim: new THREE.Color("#c8a2ff"),
};

/** Canvas stripe colours, by district. Awnings, stalls, banners. */
const STRIPE: Record<DistrictId, THREE.Color[]> = {
  halo: [new THREE.Color("#e0a24a"), new THREE.Color("#c4553c")],
  core: [new THREE.Color("#4d7fbe"), new THREE.Color("#63a8c9")],
  market: [
    new THREE.Color("#c9502f"),
    new THREE.Color("#d98a2b"),
    new THREE.Color("#2f7d6a"),
    new THREE.Color("#8a4a86"),
  ],
  gardens: [new THREE.Color("#3f8b5c"), new THREE.Color("#87a83f")],
  rim: [new THREE.Color("#7a5fb0"), new THREE.Color("#4a7fa8")],
};

/* -------------------------------------------------------------------------
 * Geometry plumbing
 *
 * Every geometry that reaches a merge or an instance carries the same four
 * attributes — position, normal, color, aEmis, aWind — because
 * `mergeGeometries` refuses a set that disagrees, and because a missing
 * attribute is a black prop rather than an error. Only indexed primitives are
 * used (Box, Cylinder, Sphere, Plane, Circle, Torus); the polyhedra are
 * non-indexed and would poison every merge they touched.
 * ---------------------------------------------------------------------- */

type Geo = THREE.BufferGeometry;

/** Wind amplitude in metres, as a function of the vertex's local height. */
type WindFn = (y: number) => number;

const _m4 = new THREE.Matrix4();
const _eul = new THREE.Euler();

/** Colour + emissive + wind, written onto a geometry in place. */
function tag(g: Geo, col: THREE.Color, emis = 0, wind: number | WindFn = 0): Geo {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const c = new Float32Array(n * 3);
  const e = new Float32Array(n);
  const w = new Float32Array(n);
  const wf: WindFn = typeof wind === "function" ? wind : () => wind;
  for (let i = 0; i < n; i++) {
    c[i * 3] = col.r;
    c[i * 3 + 1] = col.g;
    c[i * 3 + 2] = col.b;
    e[i] = emis;
    w[i] = wf(pos.getY(i));
  }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  g.setAttribute("aEmis", new THREE.BufferAttribute(e, 1));
  g.setAttribute("aWind", new THREE.BufferAttribute(w, 1));
  g.deleteAttribute("uv");
  return g;
}

/** Position/rotate a geometry in place. Rotation order YXZ, then translate. */
function put(g: Geo, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0): Geo {
  _eul.set(rx, ry, rz, "YXZ");
  _m4.makeRotationFromEuler(_eul);
  _m4.setPosition(x, y, z);
  g.applyMatrix4(_m4);
  return g;
}

function box(w: number, h: number, d: number): Geo {
  return new THREE.BoxGeometry(w, h, d);
}

function cyl(rt: number, rb: number, h: number, seg = 6, open = false): Geo {
  return new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
}

function blob(r: number, seg = 6, rings = 4): Geo {
  return new THREE.SphereGeometry(r, seg, rings);
}

/** A single quad from four corners, wound a→b→c→d, with a flat normal. */
function quad(
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
): Geo {
  const g = new THREE.BufferGeometry();
  const p = new Float32Array([
    a.x, a.y, a.z,
    b.x, b.y, b.z,
    c.x, c.y, c.z,
    d.x, d.y, d.z,
  ]);
  const ab = new THREE.Vector3().subVectors(b, a);
  const ac = new THREE.Vector3().subVectors(c, a);
  const nrm = new THREE.Vector3().crossVectors(ab, ac).normalize();
  if (!Number.isFinite(nrm.x) || nrm.lengthSq() < 0.5) nrm.set(0, 1, 0);
  const nn = new Float32Array(12);
  for (let i = 0; i < 4; i++) {
    nn[i * 3] = nrm.x;
    nn[i * 3 + 1] = nrm.y;
    nn[i * 3 + 2] = nrm.z;
  }
  g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nn, 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/**
 * Duplicate a geometry back to front so cloth reads from both sides.
 *
 * Cheaper than a second material with `side: DoubleSide` — the merged street
 * dressing is one draw call, and splitting it in two so that the awnings could
 * be double sided would have doubled that for a few thousand triangles of
 * canvas.
 */
function twoSided(g: Geo): Geo {
  const back = g.clone();
  const idx = back.getIndex();
  if (idx) {
    const arr = idx.array as ArrayLike<number>;
    const flipped = new Uint32Array(arr.length);
    for (let i = 0; i < arr.length; i += 3) {
      flipped[i] = arr[i];
      flipped[i + 1] = arr[i + 2];
      flipped[i + 2] = arr[i + 1];
    }
    back.setIndex(new THREE.BufferAttribute(flipped, 1));
  }
  const nrm = back.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < nrm.count; i++) {
    nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i));
  }
  const out = mergeGeometries([g, back], false);
  return out ?? g;
}

/** Merge a bucket, tolerating an empty one. */
function mergeBucket(list: Geo[]): Geo | null {
  if (!list.length) return null;
  const out = list.length === 1 ? list[0] : mergeGeometries(list, false);
  if (out && out !== list[0]) for (const g of list) g.dispose();
  return out;
}

/* -------------------------------------------------------------------------
 * The shared material
 * ---------------------------------------------------------------------- */

interface Shared {
  uTime: { value: number };
  uNight: { value: number };
  uWind: { value: number };
}

const VERT_HEAD = /* glsl */ `
  attribute float aEmis;
  attribute float aWind;
  uniform float uTime;
  uniform float uWind;
  varying float vEmis;
`;

/**
 * Wind, phased on the object's own world origin.
 *
 * For an instanced set that is `instanceMatrix[3].xyz`, so every tree has its
 * own phase; for a merged chunk the geometry is already in world space, so
 * `position` serves. Getting this wrong is very visible: four hundred trees
 * leaning the same way at the same instant reads as an earthquake.
 */
const VERT_BODY = /* glsl */ `
  #include <begin_vertex>
  vEmis = aEmis;
  #ifdef USE_INSTANCING
    vec3 wOrg = instanceMatrix[3].xyz;
  #else
    vec3 wOrg = position;
  #endif
  float ph = wOrg.x * 0.19 + wOrg.z * 0.23;
  float amp = aWind * uWind;
  transformed.x += (sin(uTime * 1.15 + ph) + 0.42 * sin(uTime * 2.37 + ph * 1.7)) * amp;
  transformed.z += (cos(uTime * 0.93 + ph * 1.3) + 0.38 * sin(uTime * 1.91 + ph)) * amp * 0.8;
  transformed.y -= abs(amp) * 0.25 * (1.0 - cos(uTime * 1.15 + ph));
`;

const FRAG_HEAD = /* glsl */ `
  uniform float uNight;
  varying float vEmis;
`;

/**
 * The dusk switch-on.
 *
 * Emissive is the prop's own albedo times a per-vertex mask times `uNight`, so
 * a lamp head glows the colour it is painted and a bollard never glows at all.
 * Masks above 1 are deliberate — anything over 1.0 blooms in `postfx`, which is
 * how the string lights and the lamp glass are supposed to read.
 */
const FRAG_BODY = /* glsl */ `
  #include <emissivemap_fragment>
  totalEmissiveRadiance += diffuseColor.rgb * (vEmis * uNight);
`;

function propMaterial(name: string, shared: Shared): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    name,
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.06,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 1,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uNight = shared.uNight;
    shader.uniforms.uWind = shared.uWind;
    shader.vertexShader = VERT_HEAD + shader.vertexShader.replace(
      "#include <begin_vertex>",
      VERT_BODY,
    );
    shader.fragmentShader = FRAG_HEAD + shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      FRAG_BODY,
    );
  };
  // Same injection everywhere, so every prop material shares one program.
  mat.customProgramCacheKey = () => "empyrean-prop-v1";
  return mat;
}

/* -------------------------------------------------------------------------
 * The pool of light under a lamp
 *
 * Not a light. Four hundred real lights is not a thing a browser will do, and
 * the read is the warm ellipse on the pavement rather than any actual falloff,
 * so it is an additive disc with a soft edge, drawn flat, fading up with
 * `uNight` exactly like the lamp glass does.
 * ---------------------------------------------------------------------- */

function poolMaterial(shared: Shared): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "EmpyreanLampPool",
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
    uniforms: { uNight: shared.uNight },
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      varying vec2 vUv;
      varying vec3 vCol;
      void main() {
        vUv = uv;
        #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
        #else
          vCol = vec3(1.0);
        #endif
        vec4 mvPosition = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      #include <fog_pars_fragment>
      uniform float uNight;
      varying vec2 vUv;
      varying vec3 vCol;
      void main() {
        float d = clamp(length(vUv - 0.5) * 2.0, 0.0, 1.0);
        float f = pow(1.0 - d, 2.2);
        gl_FragColor = vec4(vCol * f * uNight * 0.55, f * uNight);
        if (gl_FragColor.a < 0.003) discard;
        #include <fog_fragment>
      }
    `,
  });
}

/* -------------------------------------------------------------------------
 * Every emissive dot in the city, in one Points cloud
 * ---------------------------------------------------------------------- */

function glowMaterial(shared: Shared): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    name: "EmpyreanPropGlow",
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uTime: shared.uTime, uNight: shared.uNight },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aPhase;
      uniform float uTime;
      varying vec3 vCol;
      varying float vFlick;
      void main() {
        vCol = color;
        // String lights breathe; a street lamp does not. aPhase carries both:
        // a phase and, in its fractional sign, how much flicker to apply.
        float amt = step(0.5, fract(aPhase * 0.5));
        vFlick = 1.0 - amt * 0.18 * (0.5 + 0.5 * sin(uTime * 3.1 + aPhase * 6.3));
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(aSize * 620.0 / max(-mv.z, 1.0), 1.5, 26.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uNight;
      varying vec3 vCol;
      varying float vFlick;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = clamp(length(d) * 2.0, 0.0, 1.0);
        float core = pow(1.0 - r, 2.0);
        float a = core * uNight * vFlick;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vCol * (0.5 + core * 2.2) * uNight * vFlick, a);
      }
    `,
  });
  mat.vertexColors = true;
  return mat;
}

/* -------------------------------------------------------------------------
 * The Cistern
 * ---------------------------------------------------------------------- */

function waterMaterial(shared: Shared): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "EmpyreanFountainWater",
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    uniforms: {
      uTime: shared.uTime,
      uSun: { value: SUN_DIR.clone() },
      uNight: shared.uNight,
    },
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      attribute float aKind;   // 0 = pool surface, 1 = falling water
      attribute float aFlow;   // 0..1 along the direction of travel
      uniform float uTime;
      varying float vKind;
      varying float vFlow;
      varying vec3 vNrm;
      varying vec3 vPos;
      void main() {
        vKind = aKind;
        vFlow = aFlow;
        vec3 p = position;
        float rr = length(p.xz);
        // The pool ripples in rings from the jet; the jets only wobble.
        p.y += (1.0 - aKind) * 0.035 * sin(rr * 3.1 - uTime * 3.4)
                             * smoothstep(0.2, 2.0, rr);
        p.xz += aKind * 0.045 * vec2(
          sin(uTime * 4.1 + p.y * 2.3),
          cos(uTime * 3.7 + p.y * 2.1)
        ) * aFlow;
        vNrm = normal;
        vPos = p;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      #include <fog_pars_fragment>
      uniform float uTime;
      uniform vec3 uSun;
      uniform float uNight;
      varying float vKind;
      varying float vFlow;
      varying vec3 vNrm;
      varying vec3 vPos;
      void main() {
        vec3 N = normalize(vNrm);
        float sun = clamp(dot(N, normalize(uSun)) * 0.5 + 0.5, 0.0, 1.0);
        vec3 deep = vec3(0.09, 0.32, 0.40);
        vec3 shallow = vec3(0.55, 0.92, 0.95);
        float rr = length(vPos.xz);
        float ring = 0.5 + 0.5 * sin(rr * 5.2 - uTime * 3.4);
        vec3 pool = mix(deep, shallow, 0.25 + 0.45 * ring) * (0.5 + sun * 0.8);
        // Falling water is mostly foam, banded so it reads as moving.
        float band = 0.5 + 0.5 * sin(vFlow * 26.0 - uTime * 11.0);
        vec3 jet = mix(vec3(0.62, 0.86, 0.92), vec3(1.25, 1.32, 1.30), band);
        vec3 col = mix(pool, jet, vKind);
        float a = mix(0.74, 0.30 + 0.45 * band, vKind);
        // Lit from below at night, like every fountain worth walking to.
        col += vec3(0.30, 0.22, 0.12) * uNight * (0.6 + 0.6 * vKind);
        gl_FragColor = vec4(col, a);
        #include <fog_fragment>
      }
    `,
  });
}

/* -------------------------------------------------------------------------
 * Placement helpers
 * ---------------------------------------------------------------------- */

/** Somewhere a person can stand and a prop may therefore go. */
function onWalk(x: number, z: number): boolean {
  const k = surfaceAt(x, z).kind;
  return k === "walk" || k === "plaza" || k === "promenade";
}

function pointInPoly(poly: Array<{ x: number; z: number }>, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Shrink a polygon toward its centroid. Good enough for convex-ish lots. */
function insetPoint(
  p: { x: number; z: number },
  c: { x: number; z: number },
  metres: number,
): { x: number; z: number } {
  const dx = c.x - p.x;
  const dz = c.z - p.z;
  const d = Math.hypot(dx, dz) || 1;
  const t = Math.min(0.48, metres / d);
  return { x: p.x + dx * t, z: p.z + dz * t };
}

/** A candidate spot on a pavement: where it is and which way the road is. */
interface Spot {
  x: number;
  z: number;
  /** Unit vector pointing away from the carriageway. */
  ox: number;
  oz: number;
  /** Yaw such that -Z faces the road. */
  yaw: number;
  r: number;
  district: DistrictId;
}

function spotAt(x: number, z: number, ox: number, oz: number): Spot {
  const r = Math.hypot(x, z);
  return {
    x,
    z,
    ox,
    oz,
    // -Z is forward in this codebase, so a body facing the road has its
    // forward axis along -out.
    yaw: Math.atan2(-ox, -oz),
    r,
    district: districtAt(r).id,
  };
}

/** Pavement centreline of a ring road, one side of it. */
function ringSpots(rr: number, side: -1 | 1, spacing: number, phase: number): Spot[] {
  const wid = rr === RIM_R ? W.rim : W.ring;
  const pr = rr + side * (wid.half + wid.walk * 0.5);
  const n = Math.max(8, Math.round((TAU * pr) / spacing));
  const out: Spot[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * TAU;
    const x = Math.cos(a) * pr;
    const z = Math.sin(a) * pr;
    out.push(spotAt(x, z, Math.cos(a) * side, Math.sin(a) * side));
  }
  return out;
}

/** Pavement centreline of a radial street, one side of it. */
function radialSpots(
  a: number,
  half: number,
  walk: number,
  side: -1 | 1,
  r0: number,
  r1: number,
  spacing: number,
  phase = 0,
): Spot[] {
  const off = half + walk * 0.5;
  const px = -Math.sin(a) * off * side;
  const pz = Math.cos(a) * off * side;
  const out: Spot[] = [];
  for (let r = r0 + phase; r <= r1; r += spacing) {
    const x = Math.cos(a) * r + px;
    const z = Math.sin(a) * r + pz;
    out.push(spotAt(x, z, -Math.sin(a) * side, Math.cos(a) * side));
  }
  return out;
}

/**
 * Every pavement in the city, walked at `spacing`.
 *
 * One generator for the whole street network, because the alternative is four
 * copies of the same loop that drift apart the first time a width changes.
 */
function allPavementSpots(spacing: number, phase = 0): Spot[] {
  const out: Spot[] = [];
  for (const rr of [...RING_R, RIM_R]) {
    for (const side of [-1, 1] as const) out.push(...ringSpots(rr, side, spacing, phase * 0.11));
  }
  for (let i = 0; i < AVENUE_N; i++) {
    const a = AVENUE_A0 + (i / AVENUE_N) * TAU;
    for (const side of [-1, 1] as const) {
      out.push(
        ...radialSpots(a, W.avenue.half, W.avenue.walk, side, HALO_R + 10, RIM_R - 12, spacing, phase),
      );
    }
  }
  for (let i = 0; i < LANE_N; i++) {
    const a = LANE_A0 + (i / LANE_N) * TAU;
    for (const side of [-1, 1] as const) {
      out.push(
        ...radialSpots(a, W.lane.half, W.lane.walk, side, RING_R[0] + 12, RIM_R - 12, spacing, phase),
      );
    }
  }
  return out;
}

/** The apron ring around the Halo, which is plaza rather than pavement. */
function haloSpots(radius: number, spacing: number, phase = 0): Spot[] {
  const n = Math.max(8, Math.round((TAU * radius) / spacing));
  const out: Spot[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * TAU;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius;
    out.push(spotAt(x, z, -Math.cos(a), -Math.sin(a)));
  }
  return out;
}

/** Promenade ring centreline on one of the lower decks. */
function promenadeSpots(deck: number, spacing: number, phase = 0): Spot[] {
  const d = DECKS[deck];
  const pr = d.outer - d.width * 0.5;
  const n = Math.max(8, Math.round((TAU * pr) / spacing));
  const out: Spot[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * TAU;
    const x = Math.cos(a) * pr;
    const z = Math.sin(a) * pr;
    // "Out" on a promenade is over the edge, which is what a bench faces.
    out.push(spotAt(x, z, Math.cos(a), Math.sin(a)));
  }
  return out;
}

/* -------------------------------------------------------------------------
 * Chunking
 *
 * Eight octants, aligned to the eight avenues, so a chunk boundary falls down
 * the middle of a street rather than through a row of market stalls.
 * ---------------------------------------------------------------------- */

const CHUNKS = 8;

function chunkOf(x: number, z: number): number {
  let a = Math.atan2(z, x) - AVENUE_A0;
  a = ((a % TAU) + TAU) % TAU;
  return Math.min(CHUNKS - 1, Math.floor((a / TAU) * CHUNKS));
}

/* -------------------------------------------------------------------------
 * The kit — one builder per family, all of them world-space
 * ---------------------------------------------------------------------- */

/** Tuning that changes with the quality tier. Low cuts counts, not character. */
interface Tune {
  lamp: number;
  treeGarden: number;
  treeStreet: number;
  bollard: number;
  bench: number;
  stall: number;
  crate: number;
  gardenTreeArea: number;
  roofChance: number;
  railStep: number;
  canopySeg: number;
  stringLights: boolean;
  climbers: boolean;
}

const TUNING: Record<"low" | "high", Tune> = {
  high: {
    lamp: 27,
    treeGarden: 18,
    treeStreet: 40,
    bollard: 6,
    bench: 46,
    stall: 6.5,
    crate: 1,
    gardenTreeArea: 105,
    roofChance: 0.8,
    railStep: 6,
    canopySeg: 6,
    stringLights: true,
    climbers: true,
  },
  low: {
    lamp: 44,
    treeGarden: 30,
    treeStreet: 78,
    bollard: 11,
    bench: 90,
    stall: 12,
    crate: 0.4,
    gardenTreeArea: 260,
    roofChance: 0.3,
    railStep: 12,
    canopySeg: 4,
    stringLights: false,
    climbers: false,
  },
};

/* ---- lamp fixtures. Local space, base at the origin, arm along +X ---- */

function lampSpire(): Geo {
  // The Halo and the Spires: seven metres of very little, twin heads.
  const parts: Geo[] = [
    tag(put(cyl(0.2, 0.3, 0.35, 8), 0, 0.17, 0), C.ironDark),
    tag(put(cyl(0.07, 0.13, 6.6, 6), 0, 3.5, 0), C.ironDark),
    tag(put(box(1.5, 0.07, 0.07), 0, 6.85, 0), C.ironDark),
    tag(put(cyl(0.17, 0.1, 0.34, 6), 0.66, 6.68, 0), C.lampGlass, 3.0),
    tag(put(cyl(0.17, 0.1, 0.34, 6), -0.66, 6.68, 0), C.lampGlass, 3.0),
    tag(put(cyl(0.08, 0.14, 0.22, 6), 0, 7.02, 0), C.brass),
  ];
  return mergeBucket(parts) as Geo;
}

function lampBracket(): Geo {
  // The Bazaar: a shorter post with a shaded head over the road and a hook
  // that the pennants and the string lights hang off.
  const parts: Geo[] = [
    tag(put(cyl(0.22, 0.32, 0.4, 8), 0, 0.2, 0), C.ironWarm),
    tag(put(cyl(0.08, 0.14, 5.0, 6), 0, 2.7, 0), C.ironWarm),
    tag(put(box(0.09, 0.09, 0.09), 0, 5.2, 0), C.brass),
    tag(put(box(1.25, 0.08, 0.08), 0.62, 5.05, 0, 0, 0, 0.22), C.ironWarm),
    tag(put(cyl(0.34, 0.12, 0.4, 8), 1.2, 4.72, 0), C.brass),
    tag(put(blob(0.17, 6, 4), 1.2, 4.55, 0), C.lampGlass, 3.2),
    tag(put(box(0.06, 0.5, 0.06), -0.42, 4.9, 0), C.ironWarm),
    tag(put(cyl(0.05, 0.05, 0.3, 5), -0.42, 4.55, 0), C.brass),
  ];
  return mergeBucket(parts) as Geo;
}

function lampLantern(): Geo {
  // The Terraces and the Rim: four metres, a glass lantern and a basket of
  // trailing planting, because half the island's greenery is meant to be here.
  const parts: Geo[] = [
    tag(put(cyl(0.24, 0.34, 0.34, 8), 0, 0.17, 0), C.ironWarm),
    tag(put(cyl(0.07, 0.11, 3.9, 6), 0, 2.0, 0), C.ironWarm),
    tag(put(cyl(0.2, 0.24, 0.55, 4), 0, 4.16, Math.PI / 4), C.lampGlass, 2.6),
    tag(put(cyl(0.03, 0.24, 0.24, 4), 0, 4.52, Math.PI / 4), C.ironWarm),
    tag(put(box(0.55, 0.06, 0.06), 0.22, 3.4, 0), C.ironWarm),
    tag(put(cyl(0.24, 0.16, 0.24, 6), 0.46, 3.18, 0), C.wood),
    tag(put(blob(0.3, 6, 4), 0.46, 3.1, 0, 0, 0, 0), C.leafWarm, 0, (y) => Math.max(0, (3.3 - y) * 0.05)),
    tag(put(blob(0.13, 5, 3), 0.5, 2.85, 0.08), C.blossom, 0.4, 0.03),
  ];
  return mergeBucket(parts) as Geo;
}

/* ---- trees ---- */

function trunkGeo(rng: Rng): Geo {
  const parts: Geo[] = [
    tag(put(cyl(0.15, 0.32, 3.1, 6), 0, 1.55, 0), C.wood, 0, (y) => y * y * 0.006),
  ];
  for (let i = 0; i < 2; i++) {
    const a = rng.range(0, TAU);
    const len = rng.range(1.1, 1.8);
    const lean = rng.range(0.5, 0.85);
    const g = cyl(0.05, 0.11, len, 5);
    put(g, 0, len * 0.5, 0);
    put(g, 0, 0, 0, 0, lean, 0);
    put(
      g,
      Math.cos(a) * 0.15,
      2.4 + i * 0.28,
      Math.sin(a) * 0.15,
      a,
    );
    parts.push(tag(g, C.wood, 0, (y) => Math.max(0, y - 2) * 0.02 + 0.012));
  }
  return mergeBucket(parts) as Geo;
}

/**
 * A canopy as three overlapping deformed spheres.
 *
 * Alpha-tested leaf cards would look better up close and would have needed a
 * texture, an alpha-sorted draw and a second material; a shell is opaque, sorts
 * for free, instances for free, and at a hundred triangles a tree it is the
 * only version of this that also runs on the low tier.
 */
function canopyGeo(rng: Rng, seg: number): Geo {
  const parts: Geo[] = [];
  const lobes: Array<[number, number, number, number]> = [
    [0, 3.6, 0, 1.95],
    [0.95, 3.0, 0.55, 1.3],
    [-0.75, 3.3, -0.7, 1.2],
  ];
  for (const [lx, ly, lz, lr] of lobes) {
    const g = blob(lr, seg, Math.max(2, seg - 3));
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const s = 1 + rng.range(-0.22, 0.22);
      pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * s * 0.85, pos.getZ(i) * s);
    }
    g.computeVertexNormals();
    put(g, lx, ly, lz);
    parts.push(tag(g, C.leaf, 0, (y) => 0.06 + Math.max(0, y - 2.4) * 0.075));
  }
  return mergeBucket(parts) as Geo;
}

/* -------------------------------------------------------------------------
 * buildProps
 * ---------------------------------------------------------------------- */

export function buildProps(ctx: BuildContext): PropsHandle {
  const quality = ctx.quality === "low" ? "low" : "high";
  const T = TUNING[quality];
  const rng = makeRng(`empyrean-props-${ctx.seedSalt}`);
  const plan = cityPlan();

  const group = new THREE.Group();
  group.name = "empyrean-props";

  const shared: Shared = {
    uTime: { value: 0 },
    uNight: { value: 0 },
    uWind: { value: 1 },
  };

  const matProp = propMaterial("EmpyreanProps", shared);
  const matPool = poolMaterial(shared);
  const matGlow = glowMaterial(shared);
  const matWater = waterMaterial(shared);

  const placements: PropPlacement[] = [];
  const counts: Record<string, number> = {};
  const blockers: PropsHandle["blockers"] = [];

  const note = (kind: string, x: number, z: number, y: number) => {
    placements.push({ kind, x, z, y });
    counts[kind] = (counts[kind] ?? 0) + 1;
  };
  /* Counted but not recorded as a point, because it does not have one: a
     banner run and a string of lights *span* a street, so their midpoint is
     over the carriageway by construction. Their anchors are noted separately
     and those are the things that have to be standing on a pavement. */
  const bump = (kind: string) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
  };
  const blockAt = (x: number, z: number, hx: number, hz: number, y: number, h: number) => {
    blockers.push({ x, z, hx, hz, bottom: y, top: y + h });
  };

  /* Emissive dots, accumulated across every family and flushed once. */
  const glowPos: number[] = [];
  const glowCol: number[] = [];
  const glowSize: number[] = [];
  const glowPhase: number[] = [];
  const addGlow = (
    x: number,
    y: number,
    z: number,
    col: THREE.Color,
    size: number,
    flicker: boolean,
  ) => {
    glowPos.push(x, y, z);
    glowCol.push(col.r, col.g, col.b);
    glowSize.push(size);
    // The fractional half of aPhase carries the flicker flag; see the shader.
    glowPhase.push(rng.range(0, 6.2) + (flicker ? 1 : 0));
  };

  /* Merged buckets. Street dressing is chunked by octant so the far half of
     the island can be switched off with eight distance tests. */
  const street: Geo[][] = Array.from({ length: CHUNKS }, () => []);
  const roofs: Geo[][] = Array.from({ length: 4 }, () => []);
  const rim: Geo[][] = Array.from({ length: 4 }, () => []);
  const pushStreet = (g: Geo, x: number, z: number) => street[chunkOf(x, z)].push(g);
  const pushRoof = (g: Geo, x: number, z: number) => roofs[chunkOf(x, z) >> 1].push(g);
  const pushRim = (g: Geo, x: number, z: number) => rim[chunkOf(x, z) >> 1].push(g);

  /* Instanced sets, gathered as transform lists first. */
  interface Inst {
    m: THREE.Matrix4;
    c: THREE.Color;
  }
  const spires: Inst[] = [];
  const brackets: Inst[] = [];
  const lanterns: Inst[] = [];
  const trees: Inst[] = [];
  const pools: Inst[] = [];

  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpP = new THREE.Vector3();
  const tmpS = new THREE.Vector3();
  const inst = (
    list: Inst[],
    x: number,
    y: number,
    z: number,
    yaw: number,
    scale: number,
    col: THREE.Color,
  ) => {
    tmpP.set(x, y, z);
    tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    tmpS.set(scale, scale, scale);
    list.push({ m: new THREE.Matrix4().compose(tmpP, tmpQ, tmpS), c: col.clone() });
  };

  const DECK_Y = ISLAND_Y;

  /* Keep off the landmarks — they own their own footprints. */
  const clearOfLandmarks = (x: number, z: number, slack = 0): boolean => {
    for (const l of plan.landmarks) {
      if (Math.hypot(l.x - x, l.z - z) < l.clear + slack) return false;
    }
    return true;
  };
  /* ...and off the doorsteps, which is the one thing this system must never
     stand on. `Lot.door` is the first walkable point outward from a shopfront;
     a bin parked on it is a shop nobody can enter. */
  const doorGrid = new Map<string, Array<{ x: number; z: number }>>();
  for (const d of plan.doors) {
    const k = `${Math.floor(d.x / 20)}:${Math.floor(d.z / 20)}`;
    const l = doorGrid.get(k);
    if (l) l.push(d);
    else doorGrid.set(k, [d]);
  }
  const clearOfDoors = (x: number, z: number, metres: number): boolean => {
    const gx = Math.floor(x / 20);
    const gz = Math.floor(z / 20);
    const m2 = metres * metres;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const d of doorGrid.get(`${gx + dx}:${gz + dz}`) ?? []) {
          const ddx = d.x - x;
          const ddz = d.z - z;
          if (ddx * ddx + ddz * ddz < m2) return false;
        }
      }
    }
    return true;
  };

  /** The one gate every street-level placement goes through. */
  const ok = (x: number, z: number, doorClear = 2.2, landmarkSlack = 0): boolean =>
    onWalk(x, z) && clearOfLandmarks(x, z, landmarkSlack) && clearOfDoors(x, z, doorClear);

  /* =====================================================================
   * 1. Street lamps
   * ================================================================== */

  const lampSpots: Spot[] = [
    ...allPavementSpots(T.lamp, 3),
    ...haloSpots(HALO_R + 4.5, T.lamp * 0.9, 0.15),
  ];

  for (const s of lampSpots) {
    // Stand the lamp back from the kerb, on the building side of the walk.
    const back = s.district === "halo" ? 0 : 1.1;
    const x = s.x + s.ox * back;
    const z = s.z + s.oz * back;
    if (!ok(x, z, 2.6, -6)) continue;

    const tint = ACCENT[s.district].clone().lerp(C.cream, 0.55);
    // The arm reaches over the road, so the fixture faces -out.
    const yaw = Math.atan2(-s.ox, -s.oz) + Math.PI / 2;
    const scale = 1;
    let headY = 0;
    let headCol = C.lampGlass;

    if (s.district === "halo" || s.district === "core") {
      inst(spires, x, DECK_Y, z, yaw, scale, tint);
      addGlow(x + s.ox * -0.0 + 0.0, DECK_Y + 6.68, z, C.lampGlass, 0.55, false);
      headY = 6.68;
      note("lamp-spire", x, z, DECK_Y);
    } else if (s.district === "market") {
      inst(brackets, x, DECK_Y, z, yaw, scale, tint);
      addGlow(x - s.ox * 1.2, DECK_Y + 4.55, z - s.oz * 1.2, C.lampGlass, 0.7, false);
      headY = 4.55;
      note("lamp-bracket", x, z, DECK_Y);
    } else {
      inst(lanterns, x, DECK_Y, z, yaw, scale, tint);
      addGlow(x - s.ox * 0.0, DECK_Y + 4.16, z, C.lampGlass, 0.5, false);
      headY = 4.16;
      headCol = C.lampGlass;
      note("lamp-lantern", x, z, DECK_Y);
    }

    // The warm pool it implies on the ground.
    const poolCol = headCol.clone().lerp(ACCENT[s.district], 0.25);
    inst(pools, x - s.ox * 0.8, DECK_Y + 0.035, z - s.oz * 0.8, 0, headY * 0.72, poolCol);

    blockAt(x, z, 0.28, 0.28, DECK_Y, 4);

    /* Pennants on the post, in the districts that fly them. */
    if ((s.district === "market" || s.district === "halo") && rng.chance(0.5)) {
      const stripes = STRIPE[s.district];
      const col = rng.pick(stripes);
      const g = pennant(x, DECK_Y + 3.5, z, s.ox, s.oz, col);
      pushStreet(g, x, z);
      note("pennant", x, z, DECK_Y + 3.5);
    }
  }

  /* =====================================================================
   * 2. Trees, hedges, planting
   * ================================================================== */

  const treeAt = (x: number, z: number, y: number, scale: number, warm: number) => {
    const col = C.leaf.clone().lerp(C.leafWarm, warm).lerp(C.leafBlue, rng.range(0, 0.22));
    inst(trees, x, y, z, rng.range(0, TAU), scale, col);
    note("tree", x, z, y);
  };

  for (const s of allPavementSpots(4, 1)) {
    const spacing = s.district === "gardens" ? T.treeGarden : T.treeStreet;
    // Sample the fine walk at the family's own spacing without regenerating it.
    const step = Math.max(1, Math.round(spacing / 4));
    if ((Math.round((s.r + s.x * 0.31 + s.z * 0.17) / 4) % step) !== 0) continue;
    const back = 1.4;
    const x = s.x + s.ox * back;
    const z = s.z + s.oz * back;
    if (!ok(x, z, 3.4, -4)) continue;
    const warm = s.district === "gardens" ? rng.range(0.3, 0.9) : rng.range(0, 0.45);
    treeAt(x, z, DECK_Y, rng.range(0.78, 1.35), warm);
    blockAt(x, z, 0.34, 0.34, DECK_Y, 3);
    // A ring of soil and a low kerb around the base.
    pushStreet(
      tag(put(cyl(0.85, 0.85, 0.12, 8), x, DECK_Y + 0.05, z), C.soil),
      x,
      z,
    );
  }

  /* Garden lots: trees, beds and a hedge round the edge. */
  for (const lot of plan.lots) {
    if (lot.use !== "garden") continue;
    const area = Math.abs(polyArea(lot.poly));
    const want = Math.max(1, Math.round((area / T.gardenTreeArea) * (lot.district === "gardens" ? 1.25 : 0.8)));
    let placed = 0;
    for (let tries = 0; tries < want * 12 && placed < want; tries++) {
      const p = samplePoly(lot.poly, lot.centroid, rng, 2.4);
      if (!p) continue;
      treeAt(p.x, p.z, DECK_Y, rng.range(0.85, 1.6), rng.range(0.35, 1));
      placed++;
    }
    // Planted beds: low mounds of foliage and a few blossoms.
    const beds = Math.max(1, Math.round(area / 160));
    for (let i = 0; i < beds; i++) {
      const p = samplePoly(lot.poly, lot.centroid, rng, 2.6);
      if (!p) continue;
      pushStreet(bed(p.x, DECK_Y, p.z, rng), p.x, p.z);
      note("bed", p.x, p.z, DECK_Y);
    }
    // Hedge, with a gap left in the middle of the front edge for the way in.
    for (let i = 0; i < lot.poly.length; i++) {
      const a = insetPoint(lot.poly[i], lot.centroid, 1.1);
      const b = insetPoint(lot.poly[(i + 1) % lot.poly.length], lot.centroid, 1.1);
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1.2) continue;
      const n = Math.max(1, Math.round(len / 3.4));
      for (let k = 0; k < n; k++) {
        const t0 = k / n;
        const t1 = (k + 1) / n;
        if (i === lot.frontEdge && t0 < 0.62 && t1 > 0.38) continue;
        const mx = a.x + (b.x - a.x) * (t0 + t1) * 0.5;
        const mz = a.z + (b.z - a.z) * (t0 + t1) * 0.5;
        const seg = len * (t1 - t0);
        const yaw = Math.atan2(b.x - a.x, b.z - a.z);
        pushStreet(hedge(mx, DECK_Y, mz, seg * 0.98, yaw, rng), mx, mz);
        note("hedge", mx, mz, DECK_Y);
      }
    }
  }

  /* Climbing greenery on shopfront and block walls in the Terraces. */
  if (T.climbers) {
    for (const lot of plan.lots) {
      if (lot.district !== "gardens" && lot.district !== "rim") continue;
      if (lot.use !== "block" && lot.use !== "shop" && lot.use !== "pavilion") continue;
      if (!rng.chance(0.45)) continue;
      const g = climber(lot, rng);
      if (g) {
        pushStreet(g, lot.frontMid.x, lot.frontMid.z);
        note("climber", lot.frontMid.x, lot.frontMid.z, DECK_Y);
      }
    }
  }

  /* =====================================================================
   * 3. The Bazaar: stalls, awnings, crates, string lights
   * ================================================================== */

  const hall = plan.landmarks.find((l) => l.kind === "market-hall")!;
  const stallSpots = allPavementSpots(T.stall, 5).filter((s) => {
    if (s.district !== "market") return false;
    const near = Math.hypot(s.x - hall.x, s.z - hall.z);
    // Dense round the hall, thinning out across the rest of the district.
    const p = near < 70 ? 0.92 : near < 130 ? 0.5 : 0.24;
    return rng.chance(p);
  });

  const stallHeads: Array<{ x: number; z: number }> = [];
  for (const s of stallSpots) {
    const back = 1.5;
    const x = s.x + s.ox * back;
    const z = s.z + s.oz * back;
    if (!ok(x, z, 3.0, 2)) continue;
    const stripes = STRIPE.market;
    const g = stall(x, DECK_Y, z, s.yaw, stripes, rng, addGlow, T);
    pushStreet(g, x, z);
    note("stall", x, z, DECK_Y);
    blockAt(x, z, 1.3, 1.0, DECK_Y, 2.3);
    stallHeads.push({ x, z });

    for (let i = 0; i < Math.round(3 * T.crate); i++) {
      const cx = x + s.ox * rng.range(-0.4, 1.1) + -s.oz * rng.range(-1.5, 1.5);
      const cz = z + s.oz * rng.range(-0.4, 1.1) + s.ox * rng.range(-1.5, 1.5);
      if (!ok(cx, cz, 2.0, 2)) continue;
      pushStreet(crate(cx, DECK_Y, cz, rng), cx, cz);
      note("crate", cx, cz, DECK_Y);
    }
  }

  /* String lights strung between the market lamps, in a rough catenary. */
  if (T.stringLights) {
    const anchors = lampSpots
      .filter((s) => s.district === "market" || s.district === "halo")
      .filter((s) => ok(s.x + s.ox * 1.1, s.z + s.oz * 1.1, 2.6, -6));
    for (let i = 0; i + 1 < anchors.length; i += 2) {
      // Hung off the posts themselves, which stand 1.1 m back from the kerb —
      // a string that starts at the pavement centreline floats beside its lamp.
      const a = { x: anchors[i].x + anchors[i].ox * 1.1, z: anchors[i].z + anchors[i].oz * 1.1 };
      const b = {
        x: anchors[i + 1].x + anchors[i + 1].ox * 1.1,
        z: anchors[i + 1].z + anchors[i + 1].oz * 1.1,
      };
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d < 8 || d > 34) continue;
      const g = stringRun(a, b, DECK_Y, rng, addGlow);
      pushStreet(g, (a.x + b.x) / 2, (a.z + b.z) / 2);
      bump("string-run");
      note("string-anchor", a.x, a.z, DECK_Y + 4.6);
      note("string-anchor", b.x, b.z, DECK_Y + 4.6);
    }
  }

  /* =====================================================================
   * 4. Shopfront dressing
   * ================================================================== */

  for (const lot of plan.lots) {
    if (lot.use !== "shop" && lot.use !== "block" && lot.use !== "civic") continue;
    const stripes = STRIPE[lot.district];
    const wallY = DECK_Y;
    const fm = lot.frontMid;
    const nx = lot.frontNormal.x;
    const nz = lot.frontNormal.z;

    if (lot.use !== "civic" || rng.chance(0.4)) {
      pushStreet(awning(lot, stripes, rng, wallY), fm.x, fm.z);
      note("awning", fm.x, fm.z, wallY + 3.1);
    }
    if (rng.chance(0.72)) {
      const g = projectingSign(lot, rng, wallY, addGlow);
      pushStreet(g, fm.x, fm.z);
      note("sign", fm.x, fm.z, wallY + 4.2);
    }
    // Planters flanking the doorstep, and a menu board beside it.
    const px = lot.door.x;
    const pz = lot.door.z;
    const tx = -nz;
    const tz = nx;
    /* Nudged *outward* from the doorstep, never back toward the wall.
     * `Lot.door` is already the first walkable point outward from the
     * shopfront, so a planter set 0.35 m back from it lands in the dead strip
     * that is neither pavement nor lot — which is how this family shipped with
     * six of them in the whole city on the first pass. */
    for (const side of [-1, 1] as const) {
      for (const out of [0.5, 1.2]) {
        const bx = px + tx * side * 1.7 + nx * out;
        const bz = pz + tz * side * 1.7 + nz * out;
        if (!ok(bx, bz, 1.1)) continue;
        pushStreet(planter(bx, wallY, bz, rng), bx, bz);
        note("planter", bx, bz, wallY);
        blockAt(bx, bz, 0.42, 0.42, wallY, 1.1);
        break;
      }
    }
    if (lot.use === "shop" && rng.chance(0.55)) {
      const bx = px + tx * 2.9;
      const bz = pz + tz * 2.9;
      if (ok(bx, bz, 1.4)) {
        pushStreet(menuBoard(bx, wallY, bz, Math.atan2(-nx, -nz), rng), bx, bz);
        note("menu-board", bx, bz, wallY);
      }
    }
  }

  /* =====================================================================
   * 5. Benches, bollards, bins, racks, fountains, columns, newsstands
   * ================================================================== */

  /* Bollards line the kerb wherever the plaza meets a road, and around the
     Halo apron, which is the one place a car could otherwise drive at a crowd. */
  for (const s of haloSpots(HALO_R + 8.4, T.bollard, 0.07)) {
    if (!ok(s.x, s.z, 1.4, -8)) continue;
    pushStreet(bollard(s.x, DECK_Y, s.z, rng), s.x, s.z);
    note("bollard", s.x, s.z, DECK_Y);
    blockAt(s.x, s.z, 0.2, 0.2, DECK_Y, 0.95);
  }
  for (const s of allPavementSpots(T.bollard, 7)) {
    if (s.district !== "halo" && s.district !== "core" && s.district !== "market") continue;
    if (!rng.chance(0.34)) continue;
    // Kerbside: a metre in from the edge of the carriageway.
    const x = s.x - s.ox * (W.ring.walk * 0.5 - 0.7);
    const z = s.z - s.oz * (W.ring.walk * 0.5 - 0.7);
    if (!ok(x, z, 1.4, -8)) continue;
    pushStreet(bollard(x, DECK_Y, z, rng), x, z);
    note("bollard", x, z, DECK_Y);
    blockAt(x, z, 0.2, 0.2, DECK_Y, 0.95);
  }

  let benchN = 0;
  for (const s of allPavementSpots(T.bench, 11)) {
    const x = s.x + s.ox * 1.0;
    const z = s.z + s.oz * 1.0;
    if (!ok(x, z, 3.2, -4)) continue;
    pushStreet(bench(x, DECK_Y, z, s.yaw, rng), x, z);
    note("bench", x, z, DECK_Y);
    blockAt(x, z, 0.9, 0.35, DECK_Y, 0.9);
    benchN++;
    if (benchN % 2 === 0) {
      const bx = x + -s.oz * 1.7;
      const bz = z + s.ox * 1.7;
      if (ok(bx, bz, 2.4)) {
        pushStreet(bin(bx, DECK_Y, bz, rng), bx, bz);
        note("bin", bx, bz, DECK_Y);
        blockAt(bx, bz, 0.34, 0.34, DECK_Y, 1.0);
      }
    }
    if (benchN % 5 === 0) {
      const rx = x + -s.oz * 3.4;
      const rz = z + s.ox * 3.4;
      if (ok(rx, rz, 2.6)) {
        pushStreet(cycleRack(rx, DECK_Y, rz, s.yaw, rng), rx, rz);
        note("cycle-rack", rx, rz, DECK_Y);
      }
    }
    if (benchN % 9 === 0) {
      const fx = x + -s.oz * 5.0;
      const fz = z + s.ox * 5.0;
      if (ok(fx, fz, 2.6)) {
        pushStreet(drinkingFountain(fx, DECK_Y, fz, rng), fx, fz);
        note("drinking-fountain", fx, fz, DECK_Y);
        blockAt(fx, fz, 0.36, 0.36, DECK_Y, 1.1);
      }
    }
  }

  /* Notice columns at the junctions, newsstands on the avenues.
   *
   * The offset is the *pavement centreline* — half the carriageway plus half
   * the walk — and not the far kerb. Reaching past the walk puts the column in
   * the dead strip in front of a shopfront, `ok()` rejects it, and the family
   * silently ships with a count of zero. */
  const avWalkOff = W.avenue.half + W.avenue.walk * 0.5;
  for (let i = 0; i < AVENUE_N; i++) {
    const a = AVENUE_A0 + (i / AVENUE_N) * TAU;
    for (const rr of [HALO_R + 14, RING_R[0] - 16, RING_R[1] - 16, RING_R[2] - 16, RIM_R - 18]) {
      for (const side of [-1, 1] as const) {
        const x = Math.cos(a) * rr + -Math.sin(a) * avWalkOff * side;
        const z = Math.sin(a) * rr + Math.cos(a) * avWalkOff * side;
        if (!ok(x, z, 2.4, -6)) continue;
        if (!rng.chance(0.55)) continue;
        pushStreet(noticeColumn(x, DECK_Y, z, rng, addGlow), x, z);
        note("notice-column", x, z, DECK_Y);
        blockAt(x, z, 0.62, 0.62, DECK_Y, 3.2);
      }
    }
    for (const nr of [RING_R[0] + 20, RING_R[1] + 24]) {
      const side = nr > RING_R[1] ? -1 : 1;
      const nx2 = Math.cos(a) * nr + -Math.sin(a) * avWalkOff * side;
      const nz2 = Math.sin(a) * nr + Math.cos(a) * avWalkOff * side;
      if (!ok(nx2, nz2, 3.4)) continue;
      pushStreet(newsstand(nx2, DECK_Y, nz2, a + (side > 0 ? -Math.PI / 2 : Math.PI / 2), rng, addGlow), nx2, nz2);
      note("newsstand", nx2, nz2, DECK_Y);
      blockAt(nx2, nz2, 1.3, 0.85, DECK_Y, 2.6);
    }
  }

  /* =====================================================================
   * 6. Banners and flags
   * ================================================================== */

  for (let i = 0; i < AVENUE_N; i++) {
    const a = AVENUE_A0 + (i / AVENUE_N) * TAU;
    for (const r of [96, 152, 208, 262, 306]) {
      const off = W.avenue.half + W.avenue.walk - 0.6;
      const ax = Math.cos(a) * r + -Math.sin(a) * off;
      const az = Math.sin(a) * r + Math.cos(a) * off;
      const bx = Math.cos(a) * r + Math.sin(a) * off;
      const bz = Math.sin(a) * r - Math.cos(a) * off;
      if (!onWalk(ax, az) || !onWalk(bx, bz)) continue;
      if (!clearOfLandmarks((ax + bx) / 2, (az + bz) / 2, -8)) continue;
      const d = districtAt(r).id;
      const g = bannerRun(ax, az, bx, bz, DECK_Y, STRIPE[d], ACCENT[d], rng);
      pushStreet(g, (ax + bx) / 2, (az + bz) / 2);
      bump("banner-run");
      note("banner-mast", ax, az, DECK_Y);
      note("banner-mast", bx, bz, DECK_Y);
    }
  }

  /* The Beacon's banners, on four masts just outside its footprint — the
     Beacon itself belongs to buildings.ts and this system does not touch it. */
  {
    const beacon = plan.landmarks.find((l) => l.kind === "beacon")!;
    const mr = beacon.clear + 5;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      const x = beacon.x + Math.cos(a) * mr;
      const z = beacon.z + Math.sin(a) * mr;
      if (surfaceAt(x, z).kind === "void") continue;
      const g = beaconMast(x, DECK_Y, z, a, ACCENT.halo, rng, addGlow);
      pushStreet(g, x, z);
      note("beacon-mast", x, z, DECK_Y);
      blockAt(x, z, 0.45, 0.45, DECK_Y, 4);
    }
  }

  /* =====================================================================
   * 7. The Cistern
   * ================================================================== */

  const fountain = plan.landmarks.find((l) => l.kind === "fountain")!;
  const waterGeo = fountainWater(fountain.x, DECK_Y, fountain.z, rng);
  const waterMesh = new THREE.Mesh(waterGeo, matWater);
  waterMesh.name = "empyrean-fountain-water";
  waterMesh.renderOrder = 3;
  group.add(waterMesh);
  note("fountain", fountain.x, fountain.z, DECK_Y);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU;
    addGlow(
      fountain.x + Math.cos(a) * 5.4,
      DECK_Y + 0.35,
      fountain.z + Math.sin(a) * 5.4,
      C.water,
      0.35,
      false,
    );
  }

  /* =====================================================================
   * 8. Rooftop clutter on the mid-rise
   * ================================================================== */

  for (const lot of plan.lots) {
    if (lot.use === "garden") continue;
    if (lot.height < 7 || lot.height > 78) continue;
    if (!rng.chance(T.roofChance)) continue;
    const y = lot.y + lot.height;
    const items = rng.int(2, quality === "high" ? 6 : 3);
    for (let i = 0; i < items; i++) {
      const p = samplePoly(lot.poly, lot.centroid, rng, 2.6);
      if (!p) continue;
      const g = roofItem(p.x, y, p.z, rng, lot, addGlow);
      if (!g) continue;
      pushRoof(g, p.x, p.z);
      note("roof-item", p.x, p.z, y);
    }
  }

  /* =====================================================================
   * 9. Rim furniture
   * ================================================================== */

  for (let deck = 1; deck < DECKS.length; deck++) {
    const d = DECKS[deck];
    // Handrail just inboard of the outer edge, on top of whatever parapet
    // keel.ts put there.
    const railR = d.outer - 0.7;
    const n = Math.max(24, Math.round((TAU * railR) / T.railStep));
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * TAU;
      const a1 = ((i + 1) / n) * TAU;
      const g = railSpan(railR, a0, a1, d.y);
      const mx = Math.cos((a0 + a1) / 2) * railR;
      const mz = Math.sin((a0 + a1) / 2) * railR;
      pushRim(g, mx, mz);
    }
    counts["rail-span"] = (counts["rail-span"] ?? 0) + n;

    for (const s of promenadeSpots(deck, deck === 1 ? 34 : 44, deck * 0.4)) {
      if (surfaceAt(s.x, s.z).kind !== "promenade") continue;
      const bx = s.x - s.ox * 2.2;
      const bz = s.z - s.oz * 2.2;
      if (surfaceAt(bx, bz).kind !== "promenade") continue;
      pushRim(bench(bx, d.y, bz, Math.atan2(s.ox, s.oz), rng), bx, bz);
      note("rim-bench", bx, bz, d.y);
      blockAt(bx, bz, 0.9, 0.35, d.y, 0.9);
    }
    if (deck === 1) {
      for (const s of promenadeSpots(deck, 88, 0.9)) {
        const tx = s.x - s.ox * 1.4;
        const tz = s.z - s.oz * 1.4;
        if (surfaceAt(tx, tz).kind !== "promenade") continue;
        pushRim(telescope(tx, d.y, tz, Math.atan2(s.ox, s.oz), rng), tx, tz);
        note("telescope", tx, tz, d.y);
        blockAt(tx, tz, 0.4, 0.4, d.y, 1.6);
      }
    }
  }

  /* Telescopes and benches on the deck-level rim walk, facing out. */
  for (const s of ringSpots(RIM_R, 1, 46, 0.3)) {
    const x = s.x + s.ox * 2.4;
    const z = s.z + s.oz * 2.4;
    if (!ok(x, z, 2.6, -10)) continue;
    if (rng.chance(0.42)) {
      pushRim(telescope(x, DECK_Y, z, Math.atan2(s.ox, s.oz), rng), x, z);
      note("telescope", x, z, DECK_Y);
      blockAt(x, z, 0.4, 0.4, DECK_Y, 1.6);
    } else {
      pushRim(bench(x, DECK_Y, z, Math.atan2(s.ox, s.oz), rng), x, z);
      note("rim-bench", x, z, DECK_Y);
      blockAt(x, z, 0.9, 0.35, DECK_Y, 0.9);
    }
  }

  /* Wind socks at the Launch Terrace. */
  {
    const launch = plan.landmarks.find((l) => l.kind === "launch")!;
    /* Ringed round the terrace and *asked* rather than assumed: the Launch
       Terrace sits on an avenue, so stepping out along the landmark's own yaw
       — which is the obvious thing to write — puts every wind sock in the
       middle of the carriageway. */
    let socks = 0;
    for (let i = 0; i < 24 && socks < 4; i++) {
      const a = (i / 24) * TAU;
      const rr = launch.clear + 3.5;
      const x = launch.x + Math.cos(a) * rr;
      const z = launch.z + Math.sin(a) * rr;
      if (!onWalk(x, z)) continue;
      pushRim(windSock(x, DECK_Y, z, rng), x, z);
      note("wind-sock", x, z, DECK_Y);
      blockAt(x, z, 0.24, 0.24, DECK_Y, 5);
      socks++;
    }
    // And a telescope or two at the Observatory, facing off the edge.
    const obs = plan.landmarks.find((l) => l.kind === "observatory")!;
    for (let i = 0; i < 3; i++) {
      const a = obs.yaw + (i - 1) * 0.5;
      const rr = obs.clear + 3;
      const x = obs.x + Math.cos(a) * rr;
      const z = obs.z + Math.sin(a) * rr;
      if (!onWalk(x, z)) continue;
      pushRim(telescope(x, DECK_Y, z, a + Math.PI, rng), x, z);
      note("telescope", x, z, DECK_Y);
      blockAt(x, z, 0.4, 0.4, DECK_Y, 1.6);
    }
  }

  /* =====================================================================
   * Assemble
   * ================================================================== */

  const disposables: Array<{ dispose(): void }> = [
    matProp,
    matPool,
    matGlow,
    matWater,
    waterGeo,
  ];
  const chunkMeshes: THREE.Mesh[] = [];
  const chunkX: number[] = [];
  const chunkZ: number[] = [];
  const chunkR: number[] = [];

  const flush = (buckets: Geo[][], name: string, cullable: boolean) => {
    buckets.forEach((list, i) => {
      const merged = mergeBucket(list);
      if (!merged) return;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, matProp);
      mesh.name = `${name}-${i}`;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      group.add(mesh);
      disposables.push(merged);
      if (cullable) {
        const bs = merged.boundingSphere;
        chunkMeshes.push(mesh);
        chunkX.push(bs ? bs.center.x : 0);
        chunkZ.push(bs ? bs.center.z : 0);
        chunkR.push(bs ? bs.radius : 400);
      }
    });
  };

  flush(street, "empyrean-props-street", true);
  flush(roofs, "empyrean-props-roof", false);
  flush(rim, "empyrean-props-rim", false);

  const addInstanced = (
    list: Inst[],
    geo: Geo | null,
    name: string,
    mat: THREE.Material,
  ) => {
    if (!geo) return;
    if (!list.length) {
      geo.dispose();
      return;
    }
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    for (let i = 0; i < list.length; i++) {
      mesh.setMatrixAt(i, list[i].m);
      mesh.setColorAt(i, list[i].c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    disposables.push(geo);
  };

  addInstanced(spires, spires.length ? lampSpire() : null, "empyrean-lamp-spire", matProp);
  addInstanced(brackets, brackets.length ? lampBracket() : null, "empyrean-lamp-bracket", matProp);
  addInstanced(lanterns, lanterns.length ? lampLantern() : null, "empyrean-lamp-lantern", matProp);

  if (trees.length) {
    const trunk = trunkGeo(rng);
    const canopy = canopyGeo(rng, T.canopySeg);
    addInstanced(trees, trunk, "empyrean-tree-trunk", matProp);
    addInstanced(trees, canopy, "empyrean-tree-canopy", matProp);
  }

  if (pools.length) {
    const disc = new THREE.CircleGeometry(1, 14);
    disc.rotateX(-Math.PI / 2);
    // The pool material reads `uv`, so this one geometry keeps it.
    const mesh = new THREE.InstancedMesh(disc, matPool, pools.length);
    mesh.name = "empyrean-lamp-pools";
    mesh.renderOrder = 2;
    for (let i = 0; i < pools.length; i++) {
      mesh.setMatrixAt(i, pools[i].m);
      mesh.setColorAt(i, pools[i].c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    disposables.push(disc);
    counts["light-pool"] = pools.length;
  }

  if (glowSize.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(glowPos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(glowCol, 3));
    g.setAttribute("aSize", new THREE.Float32BufferAttribute(glowSize, 1));
    g.setAttribute("aPhase", new THREE.Float32BufferAttribute(glowPhase, 1));
    g.computeBoundingSphere();
    const pts = new THREE.Points(g, matGlow);
    pts.name = "empyrean-prop-glow";
    pts.renderOrder = 4;
    pts.frustumCulled = false;
    group.add(pts);
    disposables.push(g);
    counts["glow-point"] = glowSize.length;
  }

  let drawCalls = 0;
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) drawCalls++;
  });

  /* -------------------------------------------------------------------
   * The frame
   * ---------------------------------------------------------------- */

  const cullX = new Float32Array(chunkX);
  const cullZ = new Float32Array(chunkZ);
  const cullR = new Float32Array(chunkR);
  /** Beyond this much clear air past a chunk's own radius, hide it. */
  const CULL = quality === "high" ? 165 : 110;

  const handle: PropsHandle = {
    name: "props",
    group,
    placements,
    counts,
    drawCalls,
    blockers,
    update(f: FrameContext) {
      shared.uTime.value = f.time;
      // Dusk switch-on. Smooth, and finished before the sun is properly down,
      // so the lamps are already lit while there is still colour in the sky.
      const d = f.daylight;
      const t = d <= 0.06 ? 1 : d >= 0.42 ? 0 : 1 - (d - 0.06) / 0.36;
      shared.uNight.value = t * t * (3 - 2 * t);
      // A slow gust, so the trees and the canvas are never quite still.
      shared.uWind.value = 0.72 + 0.28 * Math.sin(f.time * 0.23) * Math.sin(f.time * 0.071);
      matWater.uniforms.uSun.value.copy(f.sunDir);

      const cx = f.camera.position.x;
      const cz = f.camera.position.z;
      for (let i = 0; i < chunkMeshes.length; i++) {
        const dx = cx - cullX[i];
        const dz = cz - cullZ[i];
        const reach = cullR[i] + CULL;
        chunkMeshes[i].visible = dx * dx + dz * dz < reach * reach;
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
      group.clear();
    },
  };
  return handle;
}

/* -------------------------------------------------------------------------
 * Family builders
 *
 * All world-space: they take a position and return geometry already sitting
 * where it belongs, because they end up in a merged chunk rather than on a
 * transform of their own.
 * ---------------------------------------------------------------------- */

function polyArea(poly: Array<{ x: number; z: number }>): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const q = poly[(i + 1) % poly.length];
    a += poly[i].x * q.z - q.x * poly[i].z;
  }
  return a / 2;
}

/** A point inside a lot, at least `inset` metres from its edge. */
function samplePoly(
  poly: Array<{ x: number; z: number }>,
  centroid: { x: number; z: number },
  rng: Rng,
  inset: number,
): { x: number; z: number } | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  for (let i = 0; i < 14; i++) {
    const x = rng.range(minX, maxX);
    const z = rng.range(minZ, maxZ);
    if (!pointInPoly(poly, x, z)) continue;
    // Pull toward the centroid until the inset is satisfied, cheaply: test the
    // four cardinal offsets rather than doing real polygon offsetting.
    if (
      pointInPoly(poly, x + inset, z) &&
      pointInPoly(poly, x - inset, z) &&
      pointInPoly(poly, x, z + inset) &&
      pointInPoly(poly, x, z - inset)
    ) {
      return { x, z };
    }
  }
  // Fall back to the centroid, which is always inside a convex-ish lot.
  return pointInPoly(poly, centroid.x, centroid.z) ? { x: centroid.x, z: centroid.z } : null;
}

function bollard(x: number, y: number, z: number, rng: Rng): Geo {
  const h = rng.range(0.78, 0.95);
  const parts = [
    tag(put(cyl(0.11, 0.14, h, 6), x, y + h / 2, z), C.ironDark),
    tag(put(blob(0.115, 6, 3), x, y + h, z), C.brass, 0.5),
  ];
  return mergeBucket(parts) as Geo;
}

function bench(x: number, y: number, z: number, yaw: number, rng: Rng): Geo {
  const woodCol = C.wood.clone().lerp(C.woodPale, rng.next());
  const parts: Geo[] = [];
  for (let i = 0; i < 4; i++) {
    parts.push(tag(put(box(1.7, 0.06, 0.11), 0, 0.44 + i * 0.005, -0.16 + i * 0.13), woodCol));
  }
  for (let i = 0; i < 3; i++) {
    parts.push(tag(put(box(1.7, 0.11, 0.06), 0, 0.62 + i * 0.15, 0.28, 0, -0.18), woodCol));
  }
  for (const s of [-1, 1]) {
    parts.push(tag(put(box(0.07, 0.44, 0.62), s * 0.74, 0.22, 0.04), C.ironDark));
    parts.push(tag(put(box(0.07, 0.55, 0.07), s * 0.74, 0.72, 0.3), C.ironDark));
  }
  const g = mergeBucket(parts) as Geo;
  return put(g, x, y, z, yaw);
}

function bin(x: number, y: number, z: number, rng: Rng): Geo {
  const parts = [
    tag(put(cyl(0.3, 0.26, 0.82, 8, true), 0, 0.45, 0), C.ironDark),
    tag(put(cyl(0.33, 0.31, 0.08, 8), 0, 0.9, 0), C.brass),
    tag(put(cyl(0.06, 0.06, 0.95, 5), 0.34, 0.47, 0), C.ironDark),
  ];
  const g = mergeBucket(parts) as Geo;
  return put(g, x, y, z, rng.range(0, TAU));
}

function cycleRack(x: number, y: number, z: number, yaw: number, rng: Rng): Geo {
  const parts: Geo[] = [];
  for (let i = 0; i < 3; i++) {
    const ox = (i - 1) * 0.75;
    parts.push(tag(put(box(0.05, 0.75, 0.05), ox - 0.28, 0.38, 0), C.steel));
    parts.push(tag(put(box(0.05, 0.75, 0.05), ox + 0.28, 0.38, 0), C.steel));
    parts.push(tag(put(box(0.61, 0.05, 0.05), ox, 0.75, 0), C.steel));
  }
  const g = mergeBucket(parts) as Geo;
  return put(g, x, y, z, yaw + rng.range(-0.1, 0.1));
}

function drinkingFountain(x: number, y: number, z: number, rng: Rng): Geo {
  const parts = [
    tag(put(cyl(0.16, 0.22, 0.95, 8), 0, 0.48, 0), C.stone),
    tag(put(cyl(0.3, 0.26, 0.14, 8), 0, 1.0, 0), C.paleStone),
    tag(put(cyl(0.04, 0.04, 0.22, 5), 0.1, 1.12, 0, 0, 0, 0.5), C.brass),
    tag(put(cyl(0.24, 0.24, 0.05, 8), 0, 1.03, 0), C.water, 0.15),
  ];
  const g = mergeBucket(parts) as Geo;
  return put(g, x, y, z, rng.range(0, TAU));
}

function planter(x: number, y: number, z: number, rng: Rng): Geo {
  const r = rng.range(0.38, 0.52);
  const h = rng.range(0.5, 0.72);
  const parts: Geo[] = [
    tag(put(cyl(r, r * 0.82, h, 8), 0, h / 2, 0), C.stone),
    tag(put(cyl(r * 1.06, r * 1.06, 0.06, 8), 0, h, 0), C.paleStone),
    tag(put(cyl(r * 0.9, r * 0.9, 0.05, 8), 0, h - 0.02, 0), C.soil),
  ];
  const n = 3;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rng.range(0, 1);
    const rr = rng.range(0.1, r * 0.6);
    const s = rng.range(0.22, 0.34);
    parts.push(
      tag(
        put(blob(s, 5, 3), Math.cos(a) * rr, h + s * 0.7, Math.sin(a) * rr),
        C.leafWarm.clone().lerp(C.leaf, rng.next()),
        0,
        0.045,
      ),
    );
  }
  if (rng.chance(0.5)) {
    parts.push(tag(put(blob(0.1, 5, 3), 0, h + 0.42, 0), C.blossom, 0.35, 0.05));
  }
  const g = mergeBucket(parts) as Geo;
  return put(g, x, y, z, rng.range(0, TAU));
}

function crate(x: number, y: number, z: number, rng: Rng): Geo {
  const parts: Geo[] = [];
  const n = rng.int(1, 3);
  let h = 0;
  for (let i = 0; i < n; i++) {
    const w = rng.range(0.5, 0.78);
    const d = rng.range(0.42, 0.62);
    const hh = rng.range(0.3, 0.45);
    const col = rng.chance(0.35)
      ? C.woodPale.clone().lerp(C.cream, rng.range(0, 0.5))
      : C.wood.clone().lerp(C.woodPale, rng.next());
    parts.push(tag(put(box(w, hh, d), rng.range(-0.08, 0.08), h + hh / 2, rng.range(-0.08, 0.08)), col));
    // Something in the crate: fruit, bolts of cloth, whatever it is.
    if (i === n - 1 && rng.chance(0.6)) {
      for (let k = 0; k < 4; k++) {
        parts.push(
          tag(
            put(
              blob(rng.range(0.07, 0.12), 5, 3),
              rng.range(-w * 0.3, w * 0.3),
              h + hh + 0.07,
              rng.range(-d * 0.3, d * 0.3),
            ),
            rng.chance(0.5) ? C.leafWarm : C.brass,
            0,
          ),
        );
      }
    }
    h += hh;
  }
  const g = mergeBucket(parts) as Geo;
  return put(g, x, y, z, rng.range(0, TAU));
}

function bed(x: number, y: number, z: number, rng: Rng): Geo {
  const r = rng.range(1.4, 2.6);
  const parts: Geo[] = [
    tag(put(cyl(r, r, 0.22, 10), 0, 0.11, 0), C.stone),
    tag(put(cyl(r * 0.92, r * 0.92, 0.06, 10), 0, 0.21, 0), C.soil),
  ];
  const n = Math.round(r * 3);
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, TAU);
    const rr = rng.range(0, r * 0.78);
    const s = rng.range(0.22, 0.46);
    parts.push(
      tag(
        put(blob(s, 5, 3), Math.cos(a) * rr, 0.24 + s * 0.6, Math.sin(a) * rr),
        rng.chance(0.22) ? C.blossom : C.leafWarm.clone().lerp(C.leaf, rng.next()),
        rng.chance(0.22) ? 0.3 : 0,
        0.05,
      ),
    );
  }
  const g = mergeBucket(parts) as Geo;
  return put(g, x, y, z, rng.range(0, TAU));
}

function hedge(x: number, y: number, z: number, len: number, yaw: number, rng: Rng): Geo {
  const h = rng.range(0.85, 1.15);
  const parts: Geo[] = [
    tag(put(box(len, h, 0.75), 0, h / 2, 0), C.leaf.clone().lerp(C.leafBlue, rng.range(0, 0.4)), 0, 0.02),
  ];
  const bumps = Math.max(1, Math.round(len / 1.2));
  for (let i = 0; i < bumps; i++) {
    const t = (i + 0.5) / bumps;
    parts.push(
      tag(
        put(blob(rng.range(0.3, 0.44), 5, 3), (t - 0.5) * len, h, rng.range(-0.1, 0.1)),
        C.leaf.clone().lerp(C.leafWarm, rng.range(0, 0.5)),
        0,
        0.035,
      ),
    );
  }
  const g = mergeBucket(parts) as Geo;
  return put(g, x, y, z, yaw);
}

/** Ivy up a shopfront wall, with tendrils that move. */
function climber(lot: Lot, rng: Rng): Geo | null {
  const fm = lot.frontMid;
  const nx = lot.frontNormal.x;
  const nz = lot.frontNormal.z;
  const tx = -nz;
  const tz = nx;
  const span = Math.min(lot.frontLen * 0.8, 12);
  const top = Math.min(lot.height * 0.55, 8.5);
  if (top < 2) return null;
  const parts: Geo[] = [];
  const n = Math.round(span * 2.2);
  for (let i = 0; i < n; i++) {
    const t = (i / Math.max(1, n - 1) - 0.5) * span;
    const cols = Math.round(rng.range(2, 5));
    for (let k = 0; k < cols; k++) {
      const hy = rng.range(0.4, top);
      const s = rng.range(0.22, 0.42);
      const x = fm.x + tx * t + nx * rng.range(0.12, 0.4);
      const z = fm.z + tz * t + nz * rng.range(0.12, 0.4);
      parts.push(
        tag(
          put(blob(s, 5, 3), x, lot.y + hy, z),
          C.leaf.clone().lerp(C.leafWarm, rng.range(0, 0.6)),
          0,
          0.02 + (hy / top) * 0.05,
        ),
      );
    }
  }
  return mergeBucket(parts);
}

/** Striped canvas over a shopfront, with a valance and two rods. */
function awning(lot: Lot, stripes: THREE.Color[], rng: Rng, y: number): Geo {
  const fm = lot.frontMid;
  const nx = lot.frontNormal.x;
  const nz = lot.frontNormal.z;
  const tx = -nz;
  const tz = nx;
  const width = Math.max(2.6, Math.min(lot.frontLen * 0.62, 8));
  const depth = rng.range(1.5, 2.2);
  const yTop = y + rng.range(3.0, 3.6);
  const yLip = yTop - rng.range(0.55, 0.9);
  const n = Math.max(4, Math.round(width / 0.7));
  const parts: Geo[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  const pick = rng.int(0, stripes.length - 1);
  for (let i = 0; i < n; i++) {
    const u0 = (i / n - 0.5) * width;
    const u1 = ((i + 1) / n - 0.5) * width;
    const col = i % 2 === 0 ? stripes[pick % stripes.length] : C.cream;
    a.set(fm.x + tx * u0 + nx * 0.06, yTop, fm.z + tz * u0 + nz * 0.06);
    b.set(fm.x + tx * u1 + nx * 0.06, yTop, fm.z + tz * u1 + nz * 0.06);
    c.set(fm.x + tx * u1 + nx * depth, yLip, fm.z + tz * u1 + nz * depth);
    d.set(fm.x + tx * u0 + nx * depth, yLip, fm.z + tz * u0 + nz * depth);
    parts.push(tag(twoSided(quad(a, b, c, d)), col, 0, 0.012));
    // The scalloped valance, hanging off the lip.
    const drop = 0.34;
    a.copy(d);
    b.copy(c);
    c.set(b.x, yLip - drop, b.z);
    d.set(a.x, yLip - drop, a.z);
    parts.push(tag(twoSided(quad(a, b, c, d)), col, 0, 0.05));
  }
  for (const s of [-1, 1]) {
    const u = s * width * 0.5;
    const rod = box(0.05, 0.05, depth);
    put(rod, 0, 0, depth * 0.5);
    // Point the rod along the outward normal.
    put(rod, fm.x + tx * u, (yTop + yLip) / 2, fm.z + tz * u, Math.atan2(nx, nz));
    parts.push(tag(rod, C.ironDark));
  }
  return mergeBucket(parts) as Geo;
}

/** A sign on a bracket, sticking out over the pavement, lit at night. */
function projectingSign(
  lot: Lot,
  rng: Rng,
  y: number,
  addGlow: (x: number, y: number, z: number, c: THREE.Color, s: number, f: boolean) => void,
): Geo {
  const fm = lot.frontMid;
  const nx = lot.frontNormal.x;
  const nz = lot.frontNormal.z;
  const tx = -nz;
  const tz = nx;
  const off = rng.range(-1, 1) * Math.min(lot.frontLen * 0.28, 4);
  const bx = fm.x + tx * off;
  const bz = fm.z + tz * off;
  const yy = y + rng.range(3.9, 5.2);
  const reach = rng.range(1.1, 1.8);
  const accent = ACCENT[lot.district];
  const parts: Geo[] = [
    tag(put(box(0.07, 0.07, reach), bx + nx * reach * 0.5, yy + 0.5, bz + nz * reach * 0.5, Math.atan2(nx, nz)), C.ironDark),
    tag(put(box(0.06, 0.5, 0.06), bx + nx * 0.1, yy + 0.25, bz + nz * 0.1), C.ironDark),
  ];
  // The board itself: a flat panel hanging under the bracket, glowing.
  const w = rng.range(0.9, 1.5);
  const h = rng.range(0.5, 0.9);
  const panel = box(0.06, h, w);
  put(panel, bx + nx * reach, yy - h * 0.5 + 0.4, bz + nz * reach, Math.atan2(nx, nz));
  parts.push(tag(panel, accent.clone().lerp(C.cream, 0.35), rng.range(1.3, 2.4), 0.02));
  addGlow(bx + nx * reach, yy - h * 0.4, bz + nz * reach, accent.clone().lerp(C.cream, 0.5), 0.5, false);
  return mergeBucket(parts) as Geo;
}

function menuBoard(x: number, y: number, z: number, yaw: number, rng: Rng): Geo {
  const parts: Geo[] = [
    tag(put(box(0.72, 1.0, 0.05), 0, 0.62, -0.12, 0, 0.16), C.ironDark),
    tag(put(box(0.72, 1.0, 0.05), 0, 0.62, 0.12, 0, -0.16), C.ironDark),
    tag(put(box(0.62, 0.86, 0.02), 0, 0.63, -0.16, 0, 0.16), C.cream, 0.25),
    tag(put(box(0.08, 0.32, 0.08), 0, 0.16, 0), C.wood),
  ];
  const g = mergeBucket(parts) as Geo;
  return put(g, x, y, z, yaw + rng.range(-0.2, 0.2));
}

function noticeColumn(
  x: number,
  y: number,
  z: number,
  rng: Rng,
  addGlow: (x: number, y: number, z: number, c: THREE.Color, s: number, f: boolean) => void,
): Geo {
  const h = rng.range(2.8, 3.4);
  const r = 0.55;
  const parts: Geo[] = [
    tag(put(cyl(r * 1.15, r * 1.3, 0.16, 10), 0, 0.08, 0), C.ironDark),
    tag(put(cyl(r, r, h, 10, true), 0, h / 2 + 0.14, 0), C.ironWarm),
  ];
  // Poster bands, which are the bit that reads at 1.8 m.
  for (let i = 0; i < 3; i++) {
    const by = 0.6 + i * 0.72;
    const col = rng.pick([ACCENT.market, ACCENT.core, ACCENT.gardens, C.cream, C.blossom]);
    parts.push(tag(put(cyl(r * 1.01, r * 1.01, 0.55, 10, true), 0, by, 0), col.clone().lerp(C.cream, 0.3), rng.range(0.5, 1.1)));
  }
  parts.push(tag(put(cyl(0.06, r * 1.2, 0.5, 10), 0, h + 0.4, 0), C.brass, 0.2));
  parts.push(tag(put(blob(0.12, 6, 4), 0, h + 0.72, 0), C.lampGlass, 2.2));
  addGlow(x, y + h + 0.72, z, C.lampGlass, 0.4, false);
  const g = mergeBucket(parts) as Geo;
  return put(g, x, y, z, rng.range(0, TAU));
}

function newsstand(
  x: number,
  y: number,
  z: number,
  yaw: number,
  rng: Rng,
  addGlow: (x: number, y: number, z: number, c: THREE.Color, s: number, f: boolean) => void,
): Geo {
  const parts: Geo[] = [
    tag(put(box(2.4, 2.2, 1.3), 0, 1.1, 0), C.ironWarm),
    tag(put(box(2.6, 0.12, 1.5), 0, 2.24, 0), C.brass),
    tag(put(box(2.0, 0.9, 0.06), 0, 1.5, 0.68), C.cream, 0.55),
    tag(put(box(2.4, 0.08, 0.5), 0, 1.02, 0.9), C.wood),
  ];
  for (let i = 0; i < 6; i++) {
    parts.push(
      tag(
        put(box(0.3, 0.05, 0.4), -0.9 + i * 0.36, 1.08 + rng.range(0, 0.05), 0.92, 0, 0.35),
        rng.pick([C.cream, ACCENT.market, ACCENT.core, C.blossom]),
        0.15,
      ),
    );
  }
  // Awning over the counter.
  const aw = twoSided(
    quad(
      new THREE.Vector3(-1.3, 2.2, 0.6),
      new THREE.Vector3(1.3, 2.2, 0.6),
      new THREE.Vector3(1.3, 1.95, 1.7),
      new THREE.Vector3(-1.3, 1.95, 1.7),
    ),
  );
  parts.push(tag(aw, STRIPE.market[0], 0, 0.02));
  parts.push(tag(put(blob(0.1, 5, 3), 0, 2.0, 0.7), C.lampGlass, 2.6));
  const g = mergeBucket(parts) as Geo;
  put(g, x, y, z, yaw);
  addGlow(x, y + 2.0, z, C.lampGlass, 0.5, false);
  return g;
}

/** A market stall: frame, counter, striped canopy, hanging goods, a lamp. */
function stall(
  x: number,
  y: number,
  z: number,
  yaw: number,
  stripes: THREE.Color[],
  rng: Rng,
  addGlow: (x: number, y: number, z: number, c: THREE.Color, s: number, f: boolean) => void,
  T: Tune,
): Geo {
  const w = rng.range(2.2, 3.0);
  const d = rng.range(1.5, 2.0);
  const h = rng.range(2.1, 2.45);
  const parts: Geo[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(tag(put(box(0.07, h, 0.07), (sx * w) / 2, h / 2, (sz * d) / 2), C.ironWarm));
    }
  }
  parts.push(tag(put(box(w, 0.06, 0.06), 0, h, -d / 2), C.ironWarm));
  parts.push(tag(put(box(w, 0.06, 0.06), 0, h, d / 2), C.ironWarm));
  // Counter and its cloth.
  parts.push(tag(put(box(w * 0.98, 0.08, d * 0.55), 0, 0.92, d * 0.16), C.wood));
  parts.push(tag(put(box(w * 0.98, 0.85, 0.05), 0, 0.47, d * 0.16 + d * 0.27), rng.pick(stripes).clone().lerp(C.cream, 0.15), 0, 0.03));
  for (let i = 0; i < 4; i++) {
    parts.push(tag(put(box(0.07, 0.9, 0.07), (i / 3 - 0.5) * w * 0.9, 0.45, d * 0.16), C.wood));
  }
  // Canopy: a pitched striped roof.
  const stripeN = Math.max(4, Math.round(w / 0.42));
  const colA = rng.pick(stripes);
  const ridge = h + 0.55;
  const eave = h + 0.08;
  const A = new THREE.Vector3();
  const B = new THREE.Vector3();
  const Cv = new THREE.Vector3();
  const D = new THREE.Vector3();
  for (let i = 0; i < stripeN; i++) {
    const u0 = (i / stripeN - 0.5) * w * 1.12;
    const u1 = ((i + 1) / stripeN - 0.5) * w * 1.12;
    const col = i % 2 === 0 ? colA : C.cream;
    for (const sz of [-1, 1] as const) {
      A.set(u0, ridge, 0);
      B.set(u1, ridge, 0);
      Cv.set(u1, eave, (sz * d) / 2 + sz * 0.3);
      D.set(u0, eave, (sz * d) / 2 + sz * 0.3);
      parts.push(tag(twoSided(sz > 0 ? quad(A, B, Cv, D) : quad(D, Cv, B, A)), col, 0, 0.02));
    }
  }
  // Hanging goods off the back rail.
  const goods = Math.round(5 * T.crate) + 2;
  for (let i = 0; i < goods; i++) {
    const u = rng.range(-w * 0.44, w * 0.44);
    const len = rng.range(0.24, 0.5);
    parts.push(
      tag(
        put(box(0.16, len, 0.1), u, h - len / 2 - 0.05, -d / 2 + 0.06),
        rng.pick([C.brass, C.leafWarm, C.blossom, C.woodPale, ACCENT.market]),
        0,
        (yy: number) => Math.max(0, h - yy) * 0.02,
      ),
    );
  }
  // The stall's own lamp.
  parts.push(tag(put(blob(0.11, 5, 3), 0, h - 0.1, 0), C.bulb, 3.0));
  const g = mergeBucket(parts) as Geo;
  put(g, x, y, z, yaw);
  addGlow(x, y + h - 0.1, z, C.bulb, 0.6, true);
  return g;
}

/** A catenary of bulbs between two lamp posts. */
function stringRun(
  a: { x: number; z: number },
  b: { x: number; z: number },
  y: number,
  rng: Rng,
  addGlow: (x: number, y: number, z: number, c: THREE.Color, s: number, f: boolean) => void,
): Geo {
  const parts: Geo[] = [];
  const y0 = y + 4.6;
  const sag = 1.1;
  const segs = 10;
  const pt = (t: number) => ({
    x: a.x + (b.x - a.x) * t,
    y: y0 - sag * 4 * t * (1 - t),
    z: a.z + (b.z - a.z) * t,
  });
  for (let i = 0; i < segs; i++) {
    const p = pt(i / segs);
    const q = pt((i + 1) / segs);
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const dz = q.z - p.z;
    const len = Math.hypot(dx, dy, dz);
    const seg = box(0.035, 0.035, len);
    put(seg, 0, 0, 0);
    put(
      seg,
      (p.x + q.x) / 2,
      (p.y + q.y) / 2,
      (p.z + q.z) / 2,
      Math.atan2(dx, dz),
      -Math.asin(dy / (len || 1)),
    );
    parts.push(tag(seg, C.ironDark, 0, 0.03));
    if (i % 1 === 0) {
      const m = pt((i + 0.5) / segs);
      const col = rng.chance(0.3) ? ACCENT.market : C.bulb;
      parts.push(tag(put(blob(0.075, 5, 3), m.x, m.y - 0.11, m.z), col, 2.8, 0.04));
      addGlow(m.x, m.y - 0.11, m.z, col, 0.34, true);
    }
  }
  return mergeBucket(parts) as Geo;
}

/** A cable across an avenue with banners hanging from it. */
function bannerRun(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  y: number,
  stripes: THREE.Color[],
  accent: THREE.Color,
  rng: Rng,
): Geo {
  const parts: Geo[] = [];
  const top = y + rng.range(7.2, 8.6);
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  // Two masts and the cable between them.
  for (const p of [
    { x: ax, z: az },
    { x: bx, z: bz },
  ]) {
    parts.push(tag(put(cyl(0.08, 0.13, top - y, 6), p.x, (top + y) / 2, p.z), C.ironDark));
  }
  const cable = box(0.05, 0.05, len);
  put(cable, (ax + bx) / 2, top - 0.3, (az + bz) / 2, Math.atan2(dx, dz));
  parts.push(tag(cable, C.ironDark));

  const n = 3;
  const A = new THREE.Vector3();
  const B = new THREE.Vector3();
  const Cv = new THREE.Vector3();
  const D = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const cx = ax + dx * t;
    const cz = az + dz * t;
    const bw = rng.range(1.6, 2.4);
    const bh = rng.range(2.6, 3.8);
    const ux = dx / len;
    const uz = dz / len;
    const col = i % 2 === 0 ? rng.pick(stripes) : accent.clone().lerp(C.cream, 0.3);
    A.set(cx - ux * bw * 0.5, top - 0.35, cz - uz * bw * 0.5);
    B.set(cx + ux * bw * 0.5, top - 0.35, cz + uz * bw * 0.5);
    Cv.set(B.x, top - 0.35 - bh, B.z);
    D.set(A.x, top - 0.35 - bh, A.z);
    parts.push(
      tag(twoSided(quad(A, B, Cv, D)), col, 0, (yy: number) => (top - 0.35 - yy) * 0.035),
    );
    // A stiffening pole at the top, so it does not read as a floating rectangle.
    const pole = box(0.05, 0.05, bw);
    put(pole, cx, top - 0.35, cz, Math.atan2(ux, uz));
    parts.push(tag(pole, C.brass));
  }
  return mergeBucket(parts) as Geo;
}

function pennant(
  x: number,
  y: number,
  z: number,
  ox: number,
  oz: number,
  col: THREE.Color,
): Geo {
  const parts: Geo[] = [];
  const w = 0.75;
  const h = 1.5;
  const tx = -oz;
  const tz = ox;
  const A = new THREE.Vector3(x, y + h, z);
  const B = new THREE.Vector3(x - tx * w, y + h, z - tz * w);
  const Cv = new THREE.Vector3(x - tx * w * 0.55, y + h * 0.2, z - tz * w * 0.55);
  const D = new THREE.Vector3(x, y, z);
  parts.push(tag(twoSided(quad(A, B, Cv, D)), col, 0, (yy: number) => (y + h - yy) * 0.05));
  parts.push(tag(put(box(0.04, 0.04, w * 1.1), x - tx * w * 0.5, y + h, z - tz * w * 0.5, Math.atan2(tx, tz)), C.brass));
  return mergeBucket(parts) as Geo;
}

/** One of the four masts flying a long banner beside the Beacon. */
function beaconMast(
  x: number,
  y: number,
  z: number,
  a: number,
  accent: THREE.Color,
  rng: Rng,
  addGlow: (x: number, y: number, z: number, c: THREE.Color, s: number, f: boolean) => void,
): Geo {
  const h = 24;
  const parts: Geo[] = [
    tag(put(cyl(0.55, 0.85, 0.7, 10), x, y + 0.35, z), C.stone),
    tag(put(cyl(0.16, 0.3, h, 8), x, y + h / 2, z), C.ironDark),
    tag(put(blob(0.28, 6, 4), x, y + h + 0.3, z), C.lampGlass, 3.2),
  ];
  const tx = -Math.sin(a);
  const tz = Math.cos(a);
  const w = 4.2;
  const bh = 15;
  const top = y + h - 1.5;
  const A = new THREE.Vector3(x, top, z);
  const B = new THREE.Vector3(x + tx * w, top, z + tz * w);
  const Cv = new THREE.Vector3(x + tx * w, top - bh, z + tz * w);
  const D = new THREE.Vector3(x, top - bh, z);
  parts.push(
    tag(twoSided(quad(A, B, Cv, D)), accent.clone().lerp(C.cream, 0.2), 0.35, (yy: number) => (top - yy) * 0.02),
  );
  const bar = box(0.07, 0.07, w);
  put(bar, x + tx * w * 0.5, top, z + tz * w * 0.5, Math.atan2(tx, tz));
  parts.push(tag(bar, C.brass));
  addGlow(x, y + h + 0.3, z, C.lampGlass, 0.9, false);
  if (rng.chance(0.5)) {
    parts.push(tag(put(blob(0.5, 6, 4), x + tx * 0.9, y + 1.4, z + tz * 0.9), C.leafWarm, 0, 0.05));
  }
  return mergeBucket(parts) as Geo;
}

/**
 * The water in the Cistern.
 *
 * One geometry, two behaviours, told apart by `aKind`: a rippling pool and
 * falling water that scrolls. The basin it sits in belongs to another system,
 * so this stays inside a five-metre radius and starts half a metre up.
 */
function fountainWater(cx: number, y: number, cz: number, rng: Rng): Geo {
  const parts: Geo[] = [];
  const setKind = (g: Geo, kind: number, flow: (p: THREE.Vector3) => number) => {
    const pos = g.attributes.position as THREE.BufferAttribute;
    const k = new Float32Array(pos.count).fill(kind);
    const f = new Float32Array(pos.count);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      f[i] = flow(v);
    }
    g.setAttribute("aKind", new THREE.BufferAttribute(k, 1));
    g.setAttribute("aFlow", new THREE.BufferAttribute(f, 1));
    g.deleteAttribute("uv");
    return g;
  };

  const pool = new THREE.CircleGeometry(5.2, 40, 0, TAU);
  pool.rotateX(-Math.PI / 2);
  pool.translate(0, 0.5, 0);
  parts.push(setKind(pool, 0, () => 0));

  // The central column and the veil falling off its lip.
  const column = cyl(0.42, 0.3, 3.4, 12, true);
  put(column, 0, 2.3, 0);
  parts.push(setKind(column, 1, (p) => (p.y - 0.6) / 3.4));

  const veil = cyl(2.2, 0.55, 2.3, 20, true);
  put(veil, 0, 1.65, 0);
  parts.push(setKind(veil, 1, (p) => 1 - (p.y - 0.5) / 2.3));

  const bowl = cyl(2.35, 1.6, 0.22, 20);
  put(bowl, 0, 2.85, 0);
  parts.push(setKind(bowl, 0, () => 0));

  // Four side jets arcing back into the pool.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + rng.range(-0.1, 0.1);
    const arc = cyl(0.09, 0.05, 2.6, 6, true);
    put(arc, 0, 1.3, 0);
    put(arc, 0, 0, 0, 0, 0, 0.55);
    put(arc, Math.cos(a) * 3.2, 0.6, Math.sin(a) * 3.2, -a);
    parts.push(setKind(arc, 1, (p) => (p.y - 0.5) / 2.6));
  }

  const g = mergeBucket(parts) as Geo;
  return put(g, cx, y, cz);
}

/** One span of promenade handrail: two posts and two rails. */
function railSpan(r: number, a0: number, a1: number, y: number): Geo {
  const x0 = Math.cos(a0) * r;
  const z0 = Math.sin(a0) * r;
  const x1 = Math.cos(a1) * r;
  const z1 = Math.sin(a1) * r;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  const yaw = Math.atan2(dx, dz);
  const parts: Geo[] = [
    tag(put(cyl(0.045, 0.055, 1.0, 6), x0, y + 0.5, z0), C.steel),
  ];
  for (const hy of [1.0, 0.62]) {
    const bar = box(0.05, 0.05, len);
    put(bar, (x0 + x1) / 2, y + hy, (z0 + z1) / 2, yaw);
    parts.push(tag(bar, C.steel));
  }
  return mergeBucket(parts) as Geo;
}

function telescope(x: number, y: number, z: number, yaw: number, rng: Rng): Geo {
  const parts: Geo[] = [
    tag(put(cyl(0.12, 0.24, 1.15, 8), 0, 0.58, 0), C.ironDark),
    tag(put(cyl(0.3, 0.34, 0.1, 8), 0, 0.05, 0), C.ironDark),
    tag(put(blob(0.16, 6, 4), 0, 1.18, 0), C.brass),
  ];
  const tube = cyl(0.11, 0.16, 0.95, 8);
  put(tube, 0, 0, 0);
  put(tube, 0, 0, 0, 0, Math.PI / 2 - rng.range(0.1, 0.5), 0);
  put(tube, 0, 1.2, 0.1);
  parts.push(tag(tube, C.brass));
  parts.push(tag(put(cyl(0.05, 0.05, 0.16, 6), 0, 1.2, -0.34, 0, Math.PI / 2), C.ironDark));
  const g = mergeBucket(parts) as Geo;
  return put(g, x, y, z, yaw);
}

function windSock(x: number, y: number, z: number, rng: Rng): Geo {
  const h = rng.range(4.6, 5.6);
  const parts: Geo[] = [
    tag(put(cyl(0.5, 0.7, 0.3, 8), x, y + 0.15, z), C.stone),
    tag(put(cyl(0.06, 0.11, h, 6), x, y + h / 2, z), C.steel),
  ];
  // The sock: four tapering rings of striped cloth, hanging off a hoop.
  const a = rng.range(0, TAU);
  const dirx = Math.cos(a);
  const dirz = Math.sin(a);
  const segs = 4;
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    const r0 = 0.42 * (1 - t0 * 0.55);
    const r1 = 0.42 * (1 - t1 * 0.55);
    const seg = cyl(r1, r0, 1.0, 8, true);
    put(seg, 0, 0, 0);
    put(seg, 0, 0, 0, 0, 0, Math.PI / 2);
    put(seg, x + dirx * (0.35 + t0 * 1.0 + 0.5), y + h - 0.25, z + dirz * (0.35 + t0 * 1.0 + 0.5), -a);
    parts.push(
      tag(seg, i % 2 === 0 ? new THREE.Color("#e2653f") : C.cream, 0.15, 0.06 + t0 * 0.14),
    );
  }
  return mergeBucket(parts) as Geo;
}

/** One piece of rooftop clutter. Tank, vents, aerial, garden or washing. */
function roofItem(
  x: number,
  y: number,
  z: number,
  rng: Rng,
  lot: Lot,
  addGlow: (x: number, y: number, z: number, c: THREE.Color, s: number, f: boolean) => void,
): Geo | null {
  const roll = rng.next();
  const parts: Geo[] = [];
  const yy = y + 0.12;
  if (roll < 0.2) {
    // Water tank on legs.
    const r = rng.range(0.9, 1.5);
    const hh = rng.range(1.6, 2.4);
    parts.push(tag(put(cyl(r, r, hh, 10), x, yy + 1.1 + hh / 2, z), C.woodPale));
    parts.push(tag(put(cyl(r * 0.55, r * 1.05, 0.5, 10), x, yy + 1.1 + hh + 0.22, z), C.ironWarm));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4;
      parts.push(
        tag(put(box(0.09, 1.15, 0.09), x + Math.cos(a) * r * 0.7, yy + 0.57, z + Math.sin(a) * r * 0.7), C.ironDark),
      );
    }
  } else if (roll < 0.4) {
    // Vents and ducting.
    for (let i = 0; i < rng.int(2, 4); i++) {
      const ox = rng.range(-1.4, 1.4);
      const oz = rng.range(-1.4, 1.4);
      parts.push(tag(put(box(rng.range(0.5, 1.0), rng.range(0.5, 0.9), rng.range(0.5, 1.0)), x + ox, yy + 0.4, z + oz), C.steel));
      parts.push(tag(put(cyl(0.18, 0.22, 0.6, 6), x + ox, yy + 1.05, z + oz), C.ironDark));
    }
  } else if (roll < 0.58) {
    // Aerial mast with crossbars.
    const hh = rng.range(3.0, 6.5);
    parts.push(tag(put(cyl(0.05, 0.1, hh, 5), x, yy + hh / 2, z), C.ironDark, 0, (v) => Math.max(0, v - y) * 0.004));
    for (let i = 0; i < 4; i++) {
      const by = yy + hh * (0.4 + i * 0.14);
      parts.push(tag(put(box(rng.range(0.6, 1.4), 0.04, 0.04), x, by, z, rng.range(0, TAU)), C.ironDark));
    }
    parts.push(tag(put(blob(0.09, 5, 3), x, yy + hh + 0.1, z), new THREE.Color("#ff6a5c"), 2.6));
    addGlow(x, yy + hh + 0.1, z, new THREE.Color("#ff8a70"), 0.35, true);
  } else if (roll < 0.78) {
    // Roof garden: planters, a hedge run, a chair.
    for (let i = 0; i < rng.int(2, 4); i++) {
      const ox = rng.range(-1.6, 1.6);
      const oz = rng.range(-1.6, 1.6);
      parts.push(planter(x + ox, yy, z + oz, rng));
    }
    if (rng.chance(0.6)) {
      parts.push(
        tag(put(box(0.5, 0.06, 0.5), x, yy + 0.42, z), C.woodPale),
      );
      parts.push(tag(put(box(0.5, 0.5, 0.06), x, yy + 0.68, z - 0.22), C.woodPale));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + 0.8;
        parts.push(tag(put(box(0.05, 0.42, 0.05), x + Math.cos(a) * 0.2, yy + 0.21, z + Math.sin(a) * 0.2), C.ironDark));
      }
    }
  } else {
    // Washing line, which is the cheapest colour on a roof there is.
    const a = rng.range(0, TAU);
    const len = rng.range(3.0, 5.0);
    const ax = x - Math.cos(a) * len * 0.5;
    const az = z - Math.sin(a) * len * 0.5;
    const bx = x + Math.cos(a) * len * 0.5;
    const bz = z + Math.sin(a) * len * 0.5;
    parts.push(tag(put(cyl(0.05, 0.07, 2.1, 5), ax, yy + 1.05, az), C.ironDark));
    parts.push(tag(put(cyl(0.05, 0.07, 2.1, 5), bx, yy + 1.05, bz), C.ironDark));
    const wire = box(0.03, 0.03, len);
    put(wire, x, yy + 1.95, z, Math.atan2(bx - ax, bz - az));
    parts.push(tag(wire, C.ironDark, 0, 0.02));
    const n = Math.max(2, Math.round(len / 0.8));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const px = ax + (bx - ax) * t;
      const pz = az + (bz - az) * t;
      const wdt = rng.range(0.4, 0.7);
      const hgt = rng.range(0.5, 0.9);
      const cloth = twoSided(
        quad(
          new THREE.Vector3(-wdt / 2, 0, 0),
          new THREE.Vector3(wdt / 2, 0, 0),
          new THREE.Vector3(wdt / 2, -hgt, 0),
          new THREE.Vector3(-wdt / 2, -hgt, 0),
        ),
      );
      put(cloth, px, yy + 1.92, pz, Math.atan2(bx - ax, bz - az));
      parts.push(
        tag(
          cloth,
          rng.pick([C.cream, ACCENT.core, ACCENT.gardens, C.blossom, ACCENT.market]),
          0,
          (v) => Math.max(0, yy + 1.92 - v) * 0.07,
        ),
      );
    }
  }
  void lot;
  return mergeBucket(parts);
}
