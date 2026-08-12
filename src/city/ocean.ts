/**
 * The sea around Vibe City — waves, seabed and the beach they break on.
 *
 * What was here before was a flat disc with three sine waves added to its
 * vertices and a fresnel tint, and it read exactly like that: a shimmering
 * blue bedsheet that stopped dead at the kerb. The city's edge was asphalt
 * meeting water at the same height, with no shore in between, which is the
 * single clearest tell that a world was assembled rather than grown.
 *
 * Three things fix that, and they are all the same idea — **the water has to
 * know where the bottom is**:
 *
 *  - `bedHeight()` is one analytic function of (x, z) giving the height of
 *    the ground: the city plate, then a sand berm, then a beach face that
 *    dives under the waterline and keeps going. It is a pure sum of sines and
 *    a p-norm, deliberately, so it can be evaluated three times over — on the
 *    CPU to build the sand mesh, on the CPU again to let the player walk on
 *    it, and in GLSL for every water fragment — and all three agree to the
 *    centimetre. A noise-based coastline would have been prettier and would
 *    have drifted between float32 and float64, which shows up as water
 *    running a metre inland of the sand it is supposed to meet.
 *
 *  - Wave amplitude is driven by depth, not by distance from the middle. Swell
 *    grows as it shoals into ~4 m of water, then collapses to nothing at the
 *    waterline. That single curve is what makes a set of waves look like it is
 *    arriving somewhere instead of just sitting there oscillating.
 *
 *  - The sea level itself breathes near shore. `swashLift()` raises and lowers
 *    the local waterline by a third of a metre in a slow shorewards-travelling
 *    pulse, so the water's edge actually runs up the sand and drains back down
 *    it. On a 5% beach face that is thirteen metres of travel, and it is the
 *    detail that reads as "real ocean" from a standing camera.
 *
 * The city plate is a 360 m square, so the coast is a rounded square: a p-norm
 * with p=16, which tracks the plate edge to within a tenth of a metre along
 * the flats and trims about 11 m off each corner — enough to lose the four
 * hard creases a Chebyshev ring would have, not enough to bury the corner
 * block in sand.
 */
import * as THREE from "three";

/** Half-width of the city plate. Must match GRID * (BLOCK + STREET) / 2. */
export const CITY_HALF = 180;
/** Mean width of the dry sand, before the per-bay modulation below. */
const BEACH_BASE = 30;
/** Height of the dune crest behind the beach. */
const BERM = 1.15;
/** How far the waterline swings up and down the beach face, in metres of sea level. */
const SWASH = 0.3;
/** Deep-water amplitude sum of the Gerstner set — kept in sync with WAVES below. */
const SWELL_SUM = 1.66;

/**
 * The coastline's wobble, and the width of the beach at a point.
 *
 * Both are sums of world-space sines rather than noise or `atan`-harmonics.
 * World-space keeps them band-limited (so the shore does not alias into a
 * zigzag where the polar mesh thins out) and keeps them bit-comparable
 * between this file and the shader.
 */
function scallop(x: number, z: number) {
  return (
    Math.sin(x * 0.081 + z * 0.043) * 1.2 +
    Math.sin(x * 0.037 - z * 0.094 + 2.1) * 0.9 +
    Math.sin((x + z) * 0.026 + 4.3) * 0.7
  );
}

/** Signed distance out past the city plate's edge, in metres. */
export function shoreDist(x: number, z: number) {
  const qx = Math.abs(x) / CITY_HALF;
  const qz = Math.abs(z) / CITY_HALF;
  const m = Math.max(qx, qz, 1e-4);
  // p-norm normalised by the max first: (q/m)^16 can never overflow, which
  // matters because this is evaluated out at the 2.6 km horizon too.
  const n = m * Math.pow(Math.pow(qx / m, 16) + Math.pow(qz / m, 16), 0.0625);
  return (n - 1) * CITY_HALF + scallop(x, z);
}

/** Metres of dry sand between the plate edge and the mean waterline. */
function beachWidth(x: number, z: number) {
  return (
    BEACH_BASE *
    (1 +
      0.34 * Math.sin(x * 0.0121 + z * 0.0074 + 0.6) +
      0.22 * Math.sin(x * 0.0053 - z * 0.0169 + 2.4) +
      0.12 * Math.sin((x - z) * 0.0281 + 5.1))
  );
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Ground height as the *water* sees it: the city plate is dry land, so the
 * sea never renders over downtown and never fights the asphalt for the depth
 * buffer. `sandHeight` below differs only inside the plate, where the sand
 * mesh has to duck under it instead.
 */
export function bedHeight(x: number, z: number) {
  const s = shoreDist(x, z);
  if (s <= 0) return 0.8;
  const W = beachWidth(x, z);
  const u = s / W;
  // The berm: flush with the road, up to a crest around a third of the way
  // out, back to sea level exactly at the waterline.
  if (u < 1) return BERM * smoothstep(0, 0.3, u) * (1 - u) * 1.43;
  const e = s - W;
  // A 7% beach face easing into a long shelf. The first cut of this dropped
  // at 23%, which is a plunging shore break: depth went past 3 m within 25 m
  // of the sand, so the entire surf zone — where the swell shoals, steepens
  // and turns white — was a band too narrow to see from anywhere.
  return -(1.6 * (1 - Math.exp(-e / 60)) + 0.045 * e);
}

/**
 * The bed as the *water* must see it: the dune is a barrier.
 *
 * `bedHeight` alone is not enough, because the berm comes back down to road
 * level as it meets the asphalt — so the swash lift, which raises local sea
 * level by 30 cm everywhere near the coast, found the low ground on the
 * LANDWARD side of the dune and drew a strip of sea lapping at the kerb, cut
 * off from the actual ocean by a metre of sand. Water only reaches a point if
 * nothing higher stands between it and the sea, and on this profile the only
 * thing that can is the crest. So seal everything shorewards of it.
 */
export function waterBedHeight(x: number, z: number) {
  const s = shoreDist(x, z);
  if (s <= 0) return 0.8;
  // 1 landward of the crest, 0 seaward of it. Guarded rather than a bare
  // `max`, because seaward of the crest the bed is NEGATIVE and max(bed, 0)
  // would flatten the whole sea floor to the waterline.
  const seal = 1 - smoothstep(0.3, 0.44, s / beachWidth(x, z));
  const bed = bedHeight(x, z);
  return seal > 0 ? Math.max(bed, seal) : bed;
}

/** Ground height as the *sand mesh* is built: dips under the plate rather than over it. */
function sandHeight(x: number, z: number) {
  const s = shoreDist(x, z);
  if (s <= 0) return -0.15 + 0.15 * smoothstep(-5, 0, s);
  // 2 cm proud of the asphalt so the seam is a step, not a coplanar band of
  // z-fighting.
  return bedHeight(x, z) + 0.02;
}

/**
 * Walkable ground for the player, or null where the ordinary y=0 plate should
 * win. Only the dry berm is returned: past the waterline the sand is under
 * water, and `CollisionWorld` floors everything at sea level anyway, so
 * wading out stays exactly as forgiving as it was before there was a beach.
 */
export function beachHeightAt(x: number, z: number): number | null {
  const s = shoreDist(x, z);
  if (s <= 0 || s >= beachWidth(x, z)) return null;
  return Math.max(0, bedHeight(x, z));
}

/** Water depth at a point, in metres. Zero or less means dry land. */
export function waterDepthAt(x: number, z: number) {
  return -bedHeight(x, z);
}

/**
 * The sea surface, for anything that has to float on it.
 *
 * A partial mirror of the shader: the swash lift, plus the three longest
 * Gerstner waves, which between them carry about 80% of the vertical motion.
 * The short chop is left out deliberately — a swimmer bobbing to a 7 m wave
 * would judder, and nobody can see a 5 cm disagreement between where a body
 * sits and where the water is drawn.
 *
 * Kept beside the shader constants it copies, and covered by the same test, so
 * retuning the swell in one place and not the other shows up as a failure
 * rather than as a swimmer riding twenty centimetres above the water.
 */
export function seaSurfaceAt(x: number, z: number, t: number) {
  const depth = -bedHeight(x, z);
  if (depth <= 0) return 0;
  const sd = shoreDist(x, z) - beachWidth(x, z);
  let y = 0;
  const near = 1 - smoothstep(0, 90, sd);
  if (near > 0) {
    const along =
      Math.sin(x * 0.021 + z * 0.013) * 1.7 + Math.sin(x * 0.009 - z * 0.026 + 1.7) * 1.3;
    const ph = t * 0.72 - sd * 0.075 + along;
    y += SWASH * (Math.sin(ph) * 0.64 + Math.sin(ph * 0.57 + 1.7) * 0.36) * near;
  }
  // The same shoaling curve the vertex shader uses: zero at the waterline,
  // taller through the surf zone, deep-water height offshore.
  const rise = 1 + 0.55 * Math.exp(-Math.pow((depth - 4.5) / 3.2, 2));
  const att = smoothstep(0.05, 2.6, depth) * rise;
  for (let i = 0; i < 3; i++) {
    const w = WAVES[i];
    const k = (2 * Math.PI) / w.len;
    const omega = Math.sqrt(9.81 * k);
    const len = Math.hypot(w.dx, w.dz);
    const phase = k * ((w.dx / len) * x + (w.dz / len) * z) - omega * t;
    y += w.amp * att * Math.sin(phase);
  }
  // Clamped to the seabed exactly as the vertex shader clamps it. Without
  // this the swell's trough reports a surface below the sand in the shallows,
  // and anything floating on the answer is told it is standing on dry land.
  return Math.max(y, -depth + 0.09);
}

/**
 * The Gerstner set: a long swell out of the south-west with four shorter
 * trains crossing it, so no single wavelength ever reads as "the" wave.
 * Phase speed is the deep-water relation w = sqrt(g·k), which is why the
 * 118 m swell walks across the bay four times faster than the 7 m chop —
 * pick the speeds by hand and the sea looks like a scrolling texture.
 */
const WAVES: Array<{ len: number; amp: number; steep: number; dx: number; dz: number }> = [
  { len: 118, amp: 0.62, steep: 0.72, dx: 0.88, dz: 0.47 },
  { len: 71, amp: 0.4, steep: 0.75, dx: 0.55, dz: -0.84 },
  { len: 41, amp: 0.3, steep: 0.82, dx: 0.97, dz: 0.24 },
  { len: 23, amp: 0.2, steep: 0.86, dx: 0.21, dz: 0.98 },
  { len: 13, amp: 0.14, steep: 0.9, dx: -0.68, dz: 0.73 },
  // Nothing shorter than this is displaced. The mesh resolves about 2.5 m at
  // the shore, and a 7 m wave sampled that coarsely does not read as a 7 m
  // wave — it reads as slow rolling blobs, which is what the sea looked like
  // for two passes. Everything below 13 m lives in the fragment normals
  // instead, where the sampling rate is the screen.
];

/**
 * The terrain functions again, in GLSL. Same constants, same sines, same
 * order of operations — if you change one side, change the other.
 */
const TERRAIN_GLSL = /* glsl */ `
  const float CITY_HALF = ${CITY_HALF.toFixed(1)};
  const float BEACH_BASE = ${BEACH_BASE.toFixed(1)};
  const float BERM = ${BERM.toFixed(3)};
  const float SWASH = ${SWASH.toFixed(3)};

  float scallop(vec2 p){
    return sin(p.x * 0.081 + p.y * 0.043) * 1.2
         + sin(p.x * 0.037 - p.y * 0.094 + 2.1) * 0.9
         + sin((p.x + p.y) * 0.026 + 4.3) * 0.7;
  }
  float shoreDist(vec2 p){
    vec2 q = abs(p) / CITY_HALF;
    float m = max(max(q.x, q.y), 1e-4);
    float n = m * pow(pow(q.x / m, 16.0) + pow(q.y / m, 16.0), 0.0625);
    return (n - 1.0) * CITY_HALF + scallop(p);
  }
  float beachWidth(vec2 p){
    return BEACH_BASE * (1.0
      + 0.34 * sin(p.x * 0.0121 + p.y * 0.0074 + 0.6)
      + 0.22 * sin(p.x * 0.0053 - p.y * 0.0169 + 2.4)
      + 0.12 * sin((p.x - p.y) * 0.0281 + 5.1));
  }
  /**
   * Split from bedHeight so a caller that already has s and W does not pay
   * for them twice. Both shaders need the bed AND the local sea level, and
   * each of those wanted its own shoreDist (two pow, three sin) and its own
   * beachWidth (three sin) — for every vertex and every fragment of a
   * full-screen ocean.
   */
  float bedFrom(float s, float W){
    if (s <= 0.0) return 0.8;
    float u = s / W;
    if (u < 1.0) return BERM * smoothstep(0.0, 0.3, u) * (1.0 - u) * 1.43;
    float e = s - W;
    return -(1.6 * (1.0 - exp(-e / 60.0)) + 0.045 * e);
  }
  float bedHeight(vec2 p){
    return bedFrom(shoreDist(p), beachWidth(p));
  }
  /**
   * The bed as the water must see it: the dune is a barrier. The berm comes
   * back down to road level where it meets the asphalt, and the swash lift
   * duly found that low ground and drew sea lapping at the kerb, cut off from
   * the ocean by a metre of sand. Water only reaches a point if nothing higher
   * stands between it and the sea; here that is the crest, so seal everything
   * shorewards of it.
   */
  float waterBed(float s, float W){
    if (s <= 0.0) return 0.8;
    // 1 landward of the crest, 0 seaward. Guarded rather than a bare max:
    // seaward of the crest the bed is NEGATIVE, and max(bed, 0.0) would
    // flatten the entire sea floor up to the waterline.
    float seal = 1.0 - smoothstep(0.3, 0.44, s / W);
    float bed = bedFrom(s, W);
    return seal > 0.0 ? max(bed, seal) : bed;
  }

  /**
   * Where the incoming sets are, as a phase, and the local sea level that
   * follows from it. Out in the bay the sea is flat zero; within ninety
   * metres of the beach it rises and falls as each set arrives, dragging the
   * waterline up the sand and back down again.
   *
   * Keyed off shoreDist, whose iso-lines ARE the coastline — so the bands
   * this drives arrive parallel to the beach whichever way the beach faces,
   * which is the one thing that makes a surf line look refracted rather than
   * pasted on. Two beating periods give sets: a big one every few waves
   * instead of a metronome.
   */
  float surfPhase(vec2 p, float t, float sd){
    // The along-shore offset is what stops the whole coast breaking at once.
    // Without it every set arrives everywhere simultaneously and the surf
    // reads as a white halo ringing the island rather than as waves: real
    // sets land in arcs, a few hundred metres of beach at a time.
    float along = sin(p.x * 0.021 + p.y * 0.013) * 1.7
                + sin(p.x * 0.009 - p.y * 0.026 + 1.7) * 1.3;
    return t * 0.72 - sd * 0.075 + along;
  }
  float surfSwell(float ph){
    return sin(ph) * 0.64 + sin(ph * 0.57 + 1.7) * 0.36;
  }
  float seaFrom(vec2 p, float t, float sd){
    float near = 1.0 - smoothstep(0.0, 90.0, sd);
    if (near <= 0.0) return 0.0;
    return SWASH * surfSwell(surfPhase(p, t, sd)) * near;
  }

  /**
   * How tall the swell is allowed to be here. Zero at the waterline, roughly
   * double in four metres of water — the surf zone — and back to its
   * deep-water height offshore.
   */
  float shoalAtten(float depth){
    float rise = 1.0 + 0.55 * exp(-pow((depth - 4.5) / 3.2, 2.0));
    return smoothstep(0.05, 2.6, depth) * rise;
  }
`;

/** The Gerstner sum, emitted with the wave table baked in as constants. */
function gerstnerGLSL() {
  const lines = WAVES.map((w) => {
    const k = (2 * Math.PI) / w.len;
    const omega = Math.sqrt(9.81 * k);
    const len = Math.hypot(w.dx, w.dz);
    const dx = (w.dx / len).toFixed(5);
    const dz = (w.dz / len).toFixed(5);
    return `  gerstnerWave(p, t, att, lod, vec2(${dx}, ${dz}), ${k.toFixed(6)}, ${w.amp.toFixed(
      4,
    )}, ${w.steep.toFixed(3)}, ${omega.toFixed(5)}, ${w.len >= 20 ? "1.0" : "0.0"}, disp, dPdx, dPdz, fold);`;
  });
  return /* glsl */ `
  void gerstnerWave(
    vec2 p, float t, float att, float lod, vec2 dir, float k, float amp,
    float steep, float omega, float big,
    inout vec3 disp, inout vec3 dPdx, inout vec3 dPdz, inout float fold
  ){
    // Short waves are dropped in the distance rather than aliased into a
    // grey shimmer; the long swell is kept everywhere so the horizon still
    // has a shape to it.
    float a = amp * att * mix(lod, 1.0, big);
    float ph = k * dot(dir, p) - omega * t;
    float c = cos(ph), s = sin(ph);
    float qa = steep * a;
    disp += vec3(qa * dir.x * c, a * s, qa * dir.y * c);
    float ka = k * a;
    dPdx += vec3(-steep * dir.x * dir.x * ka * s, dir.x * ka * c, -steep * dir.x * dir.y * ka * s);
    dPdz += vec3(-steep * dir.x * dir.y * ka * s, dir.y * ka * c, -steep * dir.y * dir.y * ka * s);
    fold += steep * ka * s;
  }

  void gerstner(vec2 p, float t, float att, float lod, out vec3 disp, out vec3 nrm, out float fold){
    disp = vec3(0.0);
    vec3 dPdx = vec3(1.0, 0.0, 0.0);
    vec3 dPdz = vec3(0.0, 0.0, 1.0);
    fold = 0.0;
${lines.join("\n")}
    nrm = normalize(cross(dPdz, dPdx));
    // Into roughly [-1, 1]. The raw sum is Sum(Q*k*A*sin), which for this wave
    // set tops out near 0.17 — thresholding that directly is how the first
    // pass ended up with no whitecaps anywhere at all.
    fold /= 0.17;
  }
  `;
}

/**
 * A shared sky-gradient lookup, matching the dome in City.tsx exactly. The
 * water reflects the sky it is actually standing under; when the two drift
 * apart — and they did, for a while, at dusk — the horizon line turns into a
 * visible join.
 */
const SKY_GLSL = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSun;
  uniform vec3 uSunColor;
  uniform float uSunPower;
  vec3 skyColor(vec3 d){
    float up = clamp(d.y, -1.0, 1.0);
    vec3 col = up >= 0.0
      ? mix(uHorizon, uZenith, pow(up, 0.42))
      : mix(uHorizon, uGround, pow(-up, 0.6));
    float s = max(dot(d, normalize(uSun)), 0.0);
    col += uSunColor * pow(s, 6.0) * uSunPower;
    col += uSunColor * pow(s, 1.6) * uSunPower * 0.18;
    return col;
  }
`;

/**
 * Hash-based value noise, for foam lace only — never for anything the CPU also
 * computes: the hash rounds differently in float32 and float64, and anything
 * the sand mesh and the water shader BOTH depend on has to agree exactly.
 */
const noiseGLSL = (octaves: number) => /* glsl */ `
  float hash21(vec2 p){
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm(vec2 p){
    float v = 0.0, a = 0.5;
    for (int i = 0; i < ${octaves}; i++){ v += a * vnoise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
`;

export interface OceanPalette {
  shallow: string;
  deep: string;
  foam: string;
  /** Warm spill from the city's lighting onto the water at night. */
  cityGlow: string;
  /** Multiplier on the sun glitter — 1 in daylight, near nothing at night. */
  sunStrength: number;
}

export const OCEAN_DAY: OceanPalette = {
  shallow: "#43c2c6",
  deep: "#0d3454",
  foam: "#f4fbff",
  cityGlow: "#000000",
  sunStrength: 1,
};

export const OCEAN_NIGHT: OceanPalette = {
  shallow: "#0d2436",
  deep: "#01060c",
  foam: "#9fb9cf",
  cityGlow: "#1c3a4a",
  sunStrength: 0.18,
};

export interface Ocean {
  group: THREE.Group;
  /** Drive the animation. `fog` is copied in each frame so weather carries. */
  update(timeSec: number, fog: THREE.Fog | null): void;
  setPalette(p: OceanPalette): void;
  /** Sun lighting for the sand, so the beach reacts to day/night with the city. */
  setSandTint(color: THREE.ColorRepresentation): void;
  dispose(): void;
}

/**
 * A radial grid whose rings are packed where the detail is.
 *
 * Most of the sea is a flat blue nothing seen through 900 m of fog, and all of
 * the interest is in the 200 m band where the swell shoals and breaks — so the
 * rings are 2.5 m apart across the surf zone and 200 m apart at the horizon.
 * A uniform `CircleGeometry` fine enough for the shore would have been three
 * million triangles.
 */
function radialRings(lowDetail: boolean) {
  const rings: number[] = [];
  const step = (from: number, to: number, by: number) => {
    for (let r = from; r < to; r += by) rings.push(r);
  };
  step(140, 190, lowDetail ? 12 : 8);
  step(190, 380, lowDetail ? 4.5 : 2.2);
  step(380, 640, lowDetail ? 18 : 10);
  step(640, 1300, lowDetail ? 60 : 34);
  let r = 1300;
  while (r < 2600) {
    rings.push(r);
    r *= 1.14;
  }
  rings.push(2600);
  return rings;
}

/**
 * Build a mesh from a list of ring radii, with each ring's radius scaled so
 * the ring follows an iso-line of `shoreDist` rather than a circle. For the
 * sand that matters a great deal: it means the inner edge of the beach sits
 * exactly on the plate's edge all the way round instead of cutting corners.
 */
function polarGrid(
  radii: number[],
  segments: number,
  /** Given a direction, how much to scale the nominal radius by. 1 = circle. */
  radiusScale: (cos: number, sin: number) => number,
) {
  const rings = radii.length;
  const cols = segments + 1;
  const pos = new Float32Array(rings * cols * 3);
  const idx: number[] = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < cols; j++) {
      const a = (j / segments) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const r = radii[i] * radiusScale(c, s);
      const o = (i * cols + j) * 3;
      pos[o] = c * r;
      pos[o + 1] = 0;
      pos[o + 2] = s * r;
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * cols + j;
      const b = a + cols;
      // Wound so the faces point UP. Angle runs +X toward +Z, which is
      // clockwise seen from above in a Y-up right-handed frame, so the
      // obvious (a, b, a+1) order gives a downward normal — and a sea and a
      // beach that are both perfectly, invisibly back-face culled from every
      // camera anyone will ever put in this world.
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}

/** Sand grain and ripple, as one tiling canvas used for both colour and bump. */
function sandTexture() {
  const S = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const g = cv.getContext("2d")!;
  // Tileable value noise: a coarse lattice sampled with wrap-around, so the
  // tile seams do not show up as a grid from the air.
  const lattice = (n: number, seed: number) => {
    const v: number[] = [];
    let h = seed;
    for (let i = 0; i < n * n; i++) {
      h = (h * 1664525 + 1013904223) >>> 0;
      v.push(h / 4294967296);
    }
    return (x: number, y: number) => {
      const fx = x * n;
      const fy = y * n;
      const ix = Math.floor(fx) % n;
      const iy = Math.floor(fy) % n;
      const tx = fx - Math.floor(fx);
      const ty = fy - Math.floor(fy);
      const ex = (ix + 1) % n;
      const ey = (iy + 1) % n;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const a = v[iy * n + ix];
      const b = v[iy * n + ex];
      const c = v[ey * n + ix];
      const d = v[ey * n + ex];
      return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
    };
  };
  const n1 = lattice(8, 7);
  const n2 = lattice(24, 91);
  const n3 = lattice(64, 314);
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      // Ripples: a low-frequency wave field, warped by the coarse lattice so
      // the bands wander the way wind ripples actually do.
      const warp = n1(u, v) * 2 - 1;
      const ripple = Math.sin((v * 26 + warp * 2.4) * Math.PI * 2) * 0.5 + 0.5;
      const grain = n2(u, v) * 0.55 + n3(u, v) * 0.45;
      // Centred on 1.0, not on a sand colour. The hue lives in the vertex
      // colours; if the texture carries it too, the two multiply and the
      // beach comes out the same value as the asphalt next to it — which is
      // exactly how the first version managed to be invisible from the air.
      const t = 0.94 + ripple * 0.09 + (grain - 0.5) * 0.2;
      const o = (y * S + x) * 4;
      img.data[o] = Math.min(255, 255 * t);
      img.data[o + 1] = Math.min(255, 250 * t);
      img.data[o + 2] = Math.min(255, 240 * t);
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export interface OceanOptions {
  /** Shared with the sky dome so the reflection can never disagree with the sky. */
  skyUniforms: {
    uZenith: { value: THREE.Color };
    uHorizon: { value: THREE.Color };
    uGround: { value: THREE.Color };
    uSun: { value: THREE.Vector3 };
    uSunColor: { value: THREE.Color };
    uSunPower: { value: number };
  };
  /** Halve the mesh density and drop the fragment detail on small screens. */
  lowDetail?: boolean;
  /** Snow accumulation, if the world has weather — the beach takes it too. */
  snow?: { patch(m: THREE.Material | THREE.Material[] | null | undefined): void };
}

export function buildOcean({ skyUniforms, lowDetail = false, snow }: OceanOptions): Ocean {
  const group = new THREE.Group();
  const trash: Array<{ dispose(): void }> = [];
  const segments = lowDetail ? 320 : 576;

  // ---- Seabed and beach ------------------------------------------------
  // One mesh: dry dune, beach face and the shelf under the shallows, so the
  // sand you can see through the water is the same sand you walk on.
  const sandRadii: number[] = [];
  for (let s = -9; s < 78; s += lowDetail ? 3 : 1.6) sandRadii.push(s);
  for (let s = 78; s <= 210; s += lowDetail ? 16 : 9) sandRadii.push(s);
  // The ring at parameter s has to land where shoreDist == s, and shoreDist is
  // the p=16 norm — so scale each direction by the inverse of that norm.
  const pnorm = (c: number, s: number) => Math.pow(Math.pow(Math.abs(c), 16) + Math.pow(Math.abs(s), 16), 0.0625);
  const sandGeo = polarGrid(
    sandRadii.map((s) => CITY_HALF + s),
    segments,
    (c, s) => 1 / pnorm(c, s),
  );
  {
    const pos = sandGeo.getAttribute("position") as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const dry = new THREE.Color("#f0dcb0");
    const wet = new THREE.Color("#947951");
    const sunk = new THREE.Color("#31544f");
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = sandHeight(x, z);
      pos.setY(i, y);
      // Dry, damp and drowned. The damp band is narrow on purpose: a wide
      // gradient looks like a stain, a narrow one looks like the tide.
      tmp.copy(wet).lerp(dry, smoothstep(-0.05, 0.55, y));
      tmp.lerp(sunk, smoothstep(0.2, 5.5, -y));
      // A little patchiness so the ring is not one flat swatch from the air.
      const v = 1 + 0.07 * Math.sin(x * 0.13 + z * 0.09) + 0.05 * Math.sin(x * 0.041 - z * 0.057 + 2.2);
      colors[i * 3] = tmp.r * v;
      colors[i * 3 + 1] = tmp.g * v;
      colors[i * 3 + 2] = tmp.b * v;
    }
    sandGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    sandGeo.computeVertexNormals();
  }
  const sandTex = sandTexture();
  sandTex.repeat.set(0.16, 0.16);
  const sandMat = new THREE.MeshStandardMaterial({
    map: sandTex,
    bumpMap: sandTex,
    bumpScale: 0.85,
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    // The sand runs a few metres UNDER the city plate so the seam is hidden,
    // and from six hundred metres up the depth buffer cannot tell the two
    // apart — the island's whole rim shimmered. Pushed away rather than
    // pulled forward: where they overlap, the asphalt is the one that should
    // win. Out past the kerb there is nothing to fight, so it costs nothing.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 4,
  });
  // Planar UVs in world metres, so the grain does not smear along the polar
  // rings the way a radial UV would.
  {
    const pos = sandGeo.getAttribute("position") as THREE.BufferAttribute;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = pos.getX(i);
      uv[i * 2 + 1] = pos.getZ(i);
    }
    sandGeo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  }
  // Snow lies on the beach too — a white shoreline against dark water is
  // most of what says the whole world got cold, not just the streets.
  snow?.patch(sandMat);
  const sand = new THREE.Mesh(sandGeo, sandMat);
  sand.receiveShadow = true;
  group.add(sand);
  trash.push(sandGeo, sandMat, sandTex);

  // ---- The sea ---------------------------------------------------------
  const uniforms = {
    uTime: { value: 0 },
    uShallow: { value: new THREE.Color(OCEAN_DAY.shallow) },
    uDeep: { value: new THREE.Color(OCEAN_DAY.deep) },
    uFoam: { value: new THREE.Color(OCEAN_DAY.foam) },
    uCityGlow: { value: new THREE.Color(OCEAN_DAY.cityGlow) },
    uSunStrength: { value: OCEAN_DAY.sunStrength },
    uFogColor: { value: new THREE.Color("#cfe6f5") },
    uFogNear: { value: 170 },
    uFogFar: { value: 1100 },
    uDetail: { value: lowDetail ? 0.55 : 1 },
    // Shared objects, not copies: day/night and the weather system mutate
    // these in place and the sea follows without anyone wiring it up.
    uZenith: skyUniforms.uZenith,
    uHorizon: skyUniforms.uHorizon,
    uGround: skyUniforms.uGround,
    uSun: skyUniforms.uSun,
    uSunColor: skyUniforms.uSunColor,
    uSunPower: skyUniforms.uSunPower,
  };

  const waterMat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vFold;
      varying float vCrest;
      varying float vCamDist;
      ${TERRAIN_GLSL}
      ${gerstnerGLSL()}
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec2 p = wp.xz;
        float t = uTime;
        float s = shoreDist(p);
        float W = beachWidth(p);
        float sea = seaFrom(p, t, s - W);
        float bed = waterBed(s, W);
        float depth = sea - bed;
        float att = shoalAtten(depth);
        vCamDist = length(cameraPosition - vec3(p.x, 0.0, p.y));
        float lod = 1.0 - smoothstep(220.0, 1100.0, vCamDist);
        vec3 disp, nrm; float fold;
        gerstner(p, t, att, lod, disp, nrm, fold);
        wp.xz += disp.xz;
        // Never let the trough cut below the sand it is sitting on — the
        // shore would show a ring of seabed poking through the water every
        // time a set drained back out.
        wp.y = max(sea + disp.y, bed + 0.09);
        vWorld = wp.xyz;
        vNormal = nrm;
        vFold = fold;
        vCrest = att > 0.001 ? disp.y / (${SWELL_SUM.toFixed(3)} * att) : 0.0;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uShallow;
      uniform vec3 uDeep;
      uniform vec3 uFoam;
      uniform vec3 uCityGlow;
      uniform float uSunStrength;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      uniform float uDetail;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vFold;
      varying float vCrest;
      varying float vCamDist;
      ${SKY_GLSL}
      ${noiseGLSL(lowDetail ? 3 : 4)}
      ${TERRAIN_GLSL}
      void main(){
        float t = uTime;
        vec2 p = vWorld.xz;
        // Re-derived rather than interpolated: the waterline is a hard-ish
        // edge and a 2.5 m triangle's worth of lerp turns it to mush.
        float sd0 = shoreDist(p);
        float W = beachWidth(p);
        float sea = seaFrom(p, t, sd0 - W);
        float bed = waterBed(sd0, W);
        float depth = sea - bed;

        // ---- normal ----------------------------------------------------
        vec3 n = normalize(vNormal);
        // Gated on depth only enough to stop ripples appearing on wet sand.
        // The first cut faded them out below 1.6 m, which on a 7% beach face
        // is the nearest thirty metres of water — the whole foreground from a
        // camera standing in the shallows, and it came out as flat teal paint.
        // The swell genuinely does die at the shore; the surface texture does
        // not.
        float det = uDetail * (1.0 - smoothstep(70.0, 620.0, vCamDist)) * smoothstep(0.04, 0.6, depth);
        if (det > 0.001) {
          // Fine chop, as a gradient rather than displacement: it costs two
          // cosines instead of another pass over 90k vertices, and at this
          // scale nobody can tell the surface is not actually moving.
          vec2 g = vec2(0.0);
          g += vec2(0.55, 0.31) * cos(dot(p, vec2(0.55, 0.31)) - t * 2.9) * 0.105;
          g += vec2(-0.37, 0.72) * cos(dot(p, vec2(-0.37, 0.72)) + t * 3.4) * 0.088;
          g += vec2(0.94, -0.63) * cos(dot(p, vec2(0.94, -0.63)) - t * 4.2) * 0.052;
          g += vec2(1.71, 1.22) * cos(dot(p, vec2(1.71, 1.22)) + t * 5.6) * 0.026;
          g += vec2(2.9, -2.1) * cos(dot(p, vec2(2.9, -2.1)) - t * 7.4) * 0.011;
          n = normalize(n + vec3(-g.x, 0.0, -g.y) * det);
        }

        vec3 V = normalize(cameraPosition - vWorld);
        vec3 L = normalize(uSun);
        float ndv = max(dot(V, n), 0.0);

        // ---- body colour -----------------------------------------------
        vec3 body = mix(uShallow, uDeep, smoothstep(0.3, 11.0, depth));
        // Subsurface: crests lit from behind go green-gold. Weighted by how
        // high this fragment is on its wave, which is why it appears as a
        // rim along the tops of the swell rather than a flat wash.
        float back = pow(max(dot(V, -L) * 0.5 + 0.5, 0.0), 4.0);
        body += uShallow * back * max(vCrest, 0.0) * 0.5 * uSunStrength;
        // Crests catch the light, troughs sit in their own shadow. Cheap, and
        // it is most of what makes a swell read as having a shape at all from
        // a camera two metres above the water.
        body *= 1.0 + clamp(vCrest, -1.0, 1.0) * 0.2;

        // ---- reflection ------------------------------------------------
        // Sampled a good way up the dome rather than right on the horizon.
        // The horizon stop is deliberately the palest colour in the sky (it
        // has to match the fog), so a physically-honest grazing reflection
        // paints the whole bay the colour of haze — technically defensible,
        // and it looked like a photograph of nothing.
        vec3 R = reflect(-V, n);
        R.y = abs(R.y) * 0.62 + 0.14;
        vec3 refl = skyColor(R) * 0.94;
        // Distance widens the effective normal distribution — a pixel a
        // kilometre out averages hundreds of wave facets — so the far sea
        // never reaches the mirror reflectance its mean normal implies. Only
        // ever a gentle knock-down, though: the first attempt at this rolled
        // the ceiling down to 0.52 and made distant water DARKER than close
        // water, which is backwards, and turned the bay into a dark band
        // pasted under the skyline.
        float rough = smoothstep(150.0, 1600.0, vCamDist);
        float fres = clamp(0.02 + 0.98 * pow(1.0 - ndv, 5.0), 0.0, mix(0.86, 0.74, rough));
        vec3 col = mix(body, refl, fres);

        // ---- sun ---------------------------------------------------------
        // Glittered rather than a clean lobe. A 300-power highlight over
        // vertex-interpolated normals draws the mesh: the polar grid showed
        // straight through the sun path as a diamond moire. Real glitter is
        // thousands of individual facets flashing, so breaking the lobe up
        // with noise is both cheaper and more honest than chasing the
        // tessellation.
        vec3 H = normalize(V + L);
        float nh = max(dot(n, H), 0.0);
        float glint = fbm(p * 1.6 + vec2(t * 0.7, -t * 0.5));
        float spec = pow(nh, 150.0) * 2.6 * (0.35 + 1.1 * smoothstep(0.34, 0.74, glint))
                   + pow(nh, 26.0) * 0.14;
        col += uSunColor * spec * uSunStrength;

        // ---- foam ----------------------------------------------------------
        // Four things, and they read as four things: sets marching in and
        // breaking as shore-parallel lines, the broken water they leave
        // behind, the lace at the swash edge, and whitecaps tearing off steep
        // crests out in the bay.
        //
        // The noise is deliberately COARSE — 17 m and 4.5 m features. The
        // first pass sampled it at 2.4 m and finer, which from any camera
        // more than thirty metres away averages to a flat grey: the entire
        // surf zone came out as one milky band with no broken water in it at
        // all.
        float lace = fbm(p * 0.06 + vec2(t * 0.02, -t * 0.035));
        float lace2 = fbm(p * 0.22 - vec2(t * 0.05, t * 0.04));
        float swell = surfSwell(surfPhase(p, t, sd0 - W));

        // Whitecaps, stretched ALONG the dominant crest direction. Sampled
        // isotropically they come out as round confetti; a 4:1 stretch across
        // the swell turns them into the torn streaks a wind sea actually has.
        vec2 sw = vec2(0.88, 0.47);
        float capN = fbm(vec2(dot(p, sw) * 0.42, dot(p, vec2(-sw.y, sw.x)) * 0.11) + vec2(t * 0.09, 0.0));
        float caps = smoothstep(0.58, 0.98, vFold) * smoothstep(0.52, 0.76, capN) * smoothstep(2.5, 7.0, depth)
                   * (1.0 - smoothstep(700.0, 1900.0, vCamDist)); // fade out rather than alias into speckle

        // Where a set is steep enough to trip over itself: the rule of thumb
        // is that a wave breaks in about 1.3x its own height, which for this
        // swell is the 1-4 m band.
        float breakZone = smoothstep(4.2, 1.6, depth) * smoothstep(0.05, 1.0, depth);
        float line = smoothstep(0.34, 0.78, swell + vCrest * 0.35);
        float breaking = breakZone * line * (0.35 + 0.75 * lace2);

        // Whitewater keeps going after the break, thinning as it runs in.
        float trail = smoothstep(1.9, 0.12, depth) * (0.25 + 0.55 * max(swell, 0.0)) * (0.1 + 1.2 * lace);

        // The swash edge: brightest right at the instantaneous waterline,
        // torn up by the noise so it is a ragged edge, not a contour line.
        float edge = smoothstep(0.5, 0.02, abs(depth - 0.12)) * (0.22 + 1.2 * lace2);

        float foam = clamp(max(max(caps, breaking), max(edge, trail)), 0.0, 1.0);
        col = mix(col, uFoam, foam * 0.95);

        // Neon spill off the waterfront at night — the cheapest possible
        // stand-in for a reflection of the skyline, and it does most of the
        // work a real one would.
        col += uCityGlow * exp(-max(sd0, 0.0) / 55.0) * (0.35 + fres);

        // ---- shoreline and depth alpha -------------------------------------
        // Shallow water is see-through, so the beach you built underneath it
        // is visible through the swell; deep water is not.
        float alpha = mix(0.45, 1.0, smoothstep(0.15, 3.2, depth));
        alpha *= smoothstep(-0.30, 0.10, depth);
        alpha = max(alpha, foam * smoothstep(-0.30, 0.02, depth));
        if (alpha < 0.004) discard;

        float fogF = smoothstep(uFogNear, uFogFar, length(cameraPosition - vWorld));
        col = mix(col, uFogColor, fogF);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
  const waterGeo = polarGrid(radialRings(lowDetail), segments, () => 1);
  waterGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2700);
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.frustumCulled = false;
  // First in the transparent pass. The sea is the lowest and furthest thing
  // in the world, and with depthWrite off it will happily paint over any
  // transparent sprite drawn before it — clouds, glow rings, weather.
  water.renderOrder = -1;
  group.add(water);
  trash.push(waterGeo, waterMat);

  return {
    group,
    update(timeSec, fog) {
      uniforms.uTime.value = timeSec;
      if (fog) {
        uniforms.uFogColor.value.copy(fog.color);
        uniforms.uFogNear.value = fog.near;
        uniforms.uFogFar.value = fog.far;
      }
    },
    setPalette(pal) {
      uniforms.uShallow.value.set(pal.shallow);
      uniforms.uDeep.value.set(pal.deep);
      uniforms.uFoam.value.set(pal.foam);
      uniforms.uCityGlow.value.set(pal.cityGlow);
      uniforms.uSunStrength.value = pal.sunStrength;
    },
    setSandTint(color) {
      sandMat.color.set(color);
    },
    dispose() {
      trash.forEach((t) => t.dispose());
    },
  };
}
