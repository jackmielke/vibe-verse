/**
 * THE KEEL — everything below the walking surfaces.
 *
 * The rock the city stands on, the fascia of every terrace step, the soffit
 * under the deck, and the fringe of stalactites hanging off the bottom. The
 * surfaces you actually stand on belong to `streets.ts`; this is the half of
 * the island nobody walks on and everybody looks at.
 *
 * It is half of the silhouette, so it is a **reflected** system: it appears in
 * the lake as a `clone(true)` mirrored through the water plane by
 * `scale.y = -1`. That imposes two rules, and both of them are load-bearing.
 *
 *  - **Every gradient runs along an attribute measured on the object's own
 *    height, never along world Y.** Mirror a world-Y gradient and the rock
 *    comes out lit from below inside an upside-down reflection: subtly,
 *    unplaceably wrong, and invisible until somebody looks at the lake.
 *  - **Every material is double-sided**, because a negative scale inverts
 *    winding. The alternative is a parallel set of cloned materials to keep in
 *    step forever.
 *
 * ## The profile, which was wrong twice
 *
 * Taper from the first millimetre and the rock is always narrower than the
 * decks above it, so the base reads as a stack of discs floating in the air —
 * a flying saucer with stalactites. Hold a cosine shoulder instead and it goes
 * the other way: the rock bulges past the terraces, swallows them, and the
 * island becomes a cauldron. What the reference painting actually has is
 * neither: the decks form a rim, and the rock begins immediately under that
 * rim at very nearly the same width and falls away to a point longer than the
 * city is tall.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { makeRng, fbm2 } from "@/shared/proc/rng";
import type { BuildContext, FrameContext, System } from "./types";
import { DECKS, ISLAND_Y, KEEL_DEPTH, PLATEAU_R } from "./config";
import { SUN_DIR } from "./sky";

/* -------------------------------------------------------------------------
 * Shaders
 * ---------------------------------------------------------------------- */

const ROCK_VERT = /* glsl */ `
attribute float aH;
varying float vH;
varying vec3 vNrm;
varying vec3 vWPos;
void main() {
  vH = aH;
  vNrm = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/**
 * The rock is lit by exactly two things and neither of them is a lamp: the sun
 * raking it from the side, and the sunset sky bouncing up off the ice
 * underneath. `aH` runs 0 at the rim and 1 at the tip, so the descent into
 * darkness is measured along the rock and survives the mirror.
 */
const ROCK_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSun;
uniform vec3 uCam;
uniform float uNight;
varying float vH;
varying vec3 vNrm;
varying vec3 vWPos;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1,0)), f.x),
             mix(hash21(i + vec2(0,1)), hash21(i + vec2(1,1)), f.x), f.y);
}

void main() {
  vec3 N = normalize(vNrm);
  float sunlit = clamp(dot(N, normalize(uSun)), -1.0, 1.0);

  /* Umber at the top where the soil is, cooling and darkening all the way
   * down to a near-black plum at the tip. */
  vec3 top  = vec3(0.44, 0.27, 0.19);
  vec3 mid  = vec3(0.30, 0.17, 0.15);
  vec3 deep = vec3(0.075, 0.045, 0.075);
  vec3 base = mix(top, mid, smoothstep(0.0, 0.35, vH));
  base = mix(base, deep, smoothstep(0.35, 1.0, vH));

  /* Strata. Horizontal bands of slightly different rock, warped by noise so
   * they are not rings — this is the detail that stops four hundred metres of
   * cliff reading as one smooth extruded surface at any distance. */
  float band = vH * 13.0 + vnoise(vec2(atan(vWPos.z, vWPos.x) * 3.0, vH * 8.0)) * 1.6;
  float strata = abs(fract(band) - 0.5) * 2.0;
  base *= 0.91 + 0.15 * smoothstep(0.2, 0.8, strata);

  /* Direct sun: a hard warm rake across one side. */
  vec3 col = base * (0.22 + 0.95 * max(sunlit, 0.0));
  col += vec3(1.00, 0.55, 0.30) * pow(max(sunlit, 0.0), 2.4) * 0.26;

  /* Bounce from the ice. Only on faces turned downward, and it falls off with
   * depth — this is the light that makes the underside legible instead of a
   * silhouette, and it is worth more to the picture than the sun is. */
  float down = clamp(-N.y * 0.5 + 0.5, 0.0, 1.0);
  col += vec3(0.58, 0.42, 0.66) * down * (1.0 - vH * 0.55) * 0.46;

  /* Striation, at a third of the contrast it started with.
   *
   * The reference's underside is combed with vertical grooves, and the first
   * pass rendered them as a 40% swing on top of a 4% geometric flute. Lit from
   * the side by a low sun that reads as a ring of polished golden columns
   * holding the city up — an arcade, not a rock. Rock is close to matte and
   * its shape does the work; the shading only has to hint. */
  float groove = abs(fract(atan(vWPos.z, vWPos.x) * 9.0) - 0.5) * 2.0;
  col *= 0.93 + 0.11 * groove;

  /* Rim from the sky behind. */
  vec3 V = normalize(uCam - vWPos);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  col += vec3(1.0, 0.62, 0.55) * fres * 0.30 * (1.0 - vH * 0.6);

  /* After dark the rock is lit only by the city spilling over the edge, which
   * reaches the first thirty metres and nothing below it. */
  col = mix(col, col * 0.22 + vec3(0.16, 0.10, 0.06) * (1.0 - smoothstep(0.0, 0.12, vH)), uNight);

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * The vertical face of a terrace step, and the soffit under the deck.
 *
 * This is the wall you stand against on the promenade — a hundred metres of
 * it in shot, two metres from the lens — and for a long time it was one flat
 * mauve field with a soft vertical shimmer on it, because a rhythm expressed
 * as a 22% shading swing is a rhythm you can only see from a kilometre away.
 * A retaining wall reads as masonry from three things: bays with real edges,
 * courses across them, and a base and a cornice that say which way is up.
 * All three are driven from `vH` and from arc length, never from world Y, so
 * they survive the mirror.
 */
const FASCIA_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSun;
uniform vec3 uCam;
uniform float uNight;
varying float vH;
varying vec3 vNrm;
varying vec3 vWPos;

float h21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/** A joint: dark in the groove, with a lit arris on the upper side. */
float joint(float f, float w, float aa, out float arris) {
  float d = min(f, 1.0 - f);
  arris = smoothstep(w * 2.4 + aa, w * 1.1, d) - smoothstep(w * 1.1, w - aa, d);
  return smoothstep(w + aa, w - aa, d);
}

void main() {
  vec3 N = normalize(vNrm);
  float sunlit = clamp(dot(N, normalize(uSun)), -1.0, 1.0);

  float r = length(vWPos.xz);
  float ang = atan(vWPos.z, vWPos.x);
  /* Arc length, so a bay is the same number of metres on every ring rather
     than the same number of radians — the outermost skirt is five per cent
     further out than the deck's own edge and would otherwise have wider
     bays than the wall above it. */
  float arc = ang * r;

  /* ---- the courses and the bays ---- */
  float bay = arc / 7.6;
  float course = vH * 11.0;
  float bayI = floor(bay);
  float courseI = floor(course);

  float px = max(fwidth(arc), 0.0008);
  float aaB = px / 7.6 + 0.0008;
  float aaC = max(fwidth(course), 0.0008);

  float arrisB, arrisC;
  float jb = joint(fract(bay), 0.030, aaB, arrisB);
  float jc = joint(fract(course), 0.035, aaC, arrisC);

  /* ---- the stone ----
   * Two-dimensional hash on (bay, course). A one-dimensional one on a
   * combination of the two clumps into patches, which on a wall this size is
   * a stain rather than a variation. */
  float tone = h21(vec2(bayI, courseI));
  vec3 stone = mix(vec3(0.55, 0.47, 0.44), vec3(0.44, 0.37, 0.38), tone);
  /* Darker into the shadow the deck above casts. vH is 0 at the bottom of
     the face and 1 at the top, so the darkening stays at the top when the
     whole thing is mirrored. */
  stone = mix(stone, vec3(0.28, 0.22, 0.26), smoothstep(0.62, 1.0, vH));

  /* A plinth at the foot and a cornice band under the deck: without them a
     wall of identical courses has no top and no bottom and reads as tiling. */
  float plinth = smoothstep(0.075, 0.055, vH);
  float band = smoothstep(0.90, 0.925, vH);
  stone = mix(stone, vec3(0.33, 0.27, 0.29), plinth * 0.75);
  stone = mix(stone, vec3(0.62, 0.54, 0.49), band * 0.7);

  vec3 col = stone * (0.30 + 0.85 * max(sunlit, 0.0));

  /* Pilasters: every fourth bay stands proud, which is what gives a
     five-hundred-metre circumference a scale you can read from the air. */
  float pil = step(3.5, mod(bayI, 4.0));
  col *= mix(1.0, 1.09, pil);

  /* Joints last, over everything, so the bands do not swallow them. */
  col *= 1.0 - max(jb, jc) * 0.42;
  col += vec3(1.0, 0.86, 0.72) * max(arrisB * 0.5, arrisC) * 0.10 * max(sunlit, 0.12);

  /* Sky bounce from below — the ice again. */
  float down = clamp(-N.y * 0.5 + 0.5, 0.0, 1.0);
  col += vec3(0.50, 0.38, 0.60) * down * 0.30;

  vec3 V = normalize(uCam - vWPos);
  col += vec3(1.0, 0.66, 0.58) * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0) * 0.22;

  /* At night the promenade lamps wash the top of every face. */
  col = mix(col, col * 0.3 + vec3(0.30, 0.20, 0.12) * smoothstep(0.4, 1.0, vH), uNight);

  gl_FragColor = vec4(col, 1.0);
}
`;

/* -------------------------------------------------------------------------
 * Geometry
 * ---------------------------------------------------------------------- */

/** Attach the 0..1 ramp along the object's own height that the shaders read. */
function withHeight(geo: THREE.BufferGeometry, lo: number, hi: number, invert = false) {
  const pos = geo.getAttribute("position");
  const n = pos.count;
  const h = new Float32Array(n);
  const span = Math.max(hi - lo, 1e-4);
  for (let i = 0; i < n; i++) {
    const t = THREE.MathUtils.clamp((pos.getY(i) - lo) / span, 0, 1);
    h[i] = invert ? 1 - t : t;
  }
  geo.setAttribute("aH", new THREE.BufferAttribute(h, 1));
  return geo;
}

/**
 * The rock: a ring-and-radial lathe with the profile pinched to a point.
 *
 * Built by hand rather than from `LatheGeometry` because every ring needs its
 * own per-angle noise — a lathe is a surface of revolution and a surface of
 * revolution is exactly what a floating island must not look like.
 */
function buildRock(rings: number, segs: number): THREE.BufferGeometry {
  const topY = DECKS[DECKS.length - 1].y - 6;
  const tipY = ISLAND_Y - KEEL_DEPTH;
  const topR = DECKS[DECKS.length - 1].outer * 0.99;

  /* A steady inverted cone with a slight waist. See the note at the top of
   * the file for the two ways this was wrong before. */
  const profile = (t: number) =>
    Math.pow(1 - t, 1.22) * (1 - 0.12 * Math.sin(t * Math.PI * 2.1));

  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const y = THREE.MathUtils.lerp(topY, tipY, t);
    const baseR = topR * profile(t);
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      /* Three scales of shape, each doing a different job.
       *
       * `lobe` is the only one that changes the silhouette: four broad
       * buttresses so the rock is not a circle in plan, which is the single
       * thing that stopped an early pass looking like a turned wooden cone.
       * `flute` is the vertical striation the reference has all down the
       * underside. `rough` is the surface, and it gets coarser as the rock
       * narrows, because that is where it broke off. */
      const lobe = 1 + Math.sin(a * 4 + 0.7) * 0.10 + Math.sin(a * 3 - 2.1) * 0.06;
      const flute = 1 + Math.sin(a * 17 + t * 2.2) * 0.022 * (0.35 + t);
      const rough =
        1 +
        fbm2(Math.cos(a) * 2.6 + t * 3.1, Math.sin(a) * 2.6, 4, 2, 0.5, 404) *
          0.34 *
          (0.3 + t * 1.1);
      const r = baseR * lobe * flute * rough;
      positions.push(Math.cos(a) * r, y, Math.sin(a) * r);
    }
  }

  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * (segs + 1) + j;
      const b = a + segs + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  // 0 at the rim, 1 in the dark.
  withHeight(geo, tipY, topY, true);
  return geo;
}

/**
 * One dominant point, then a fringe.
 *
 * A ring of thirty similar spikes reads as a crown, which is a shape, but not
 * this one. The reference has a single spike longer than everything else put
 * together hanging straight down the axis, with small broken teeth scattered
 * around the rock above it.
 */
function buildSpikes(rng: ReturnType<typeof makeRng>, count: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const tipY = ISLAND_Y - KEEL_DEPTH;

  const cone = (radius: number, len: number, sides: number, x: number, yTop: number, z: number) => {
    const g = new THREE.ConeGeometry(radius, len, sides, 1, true);
    g.rotateX(Math.PI); // point down
    g.translate(x, yTop - len / 2, z);
    withHeight(g, yTop - len, yTop, true);
    // Squash the ramp so a spike is never as dark as the very tip of the keel.
    const h = g.getAttribute("aH") as THREE.BufferAttribute;
    for (let k = 0; k < h.count; k++) h.setX(k, 0.15 + h.getX(k) * 0.85);
    parts.push(g);
  };

  // The long one, continuing the axis of the whole island.
  cone(40, 330, 6, 0, tipY + 300, 0);

  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng.range(-0.22, 0.22);
    const rr = PLATEAU_R * rng.range(0.24, 0.9);
    const len = rng.range(45, 200) * (1 - (rr / PLATEAU_R) * 0.28);
    // Rooted: the top of every spike is buried inside the rock mass, so they
    // grow out of it instead of dangling below it like a mobile.
    const yTop = ISLAND_Y - 190 - Math.pow(rr / PLATEAU_R, 2.4) * 220 - rng.range(0, 90);
    cone(rng.range(9, 30), len, rng.int(3, 6), Math.cos(a) * rr, yTop, Math.sin(a) * rr);
  }

  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  merged.computeVertexNormals();
  return merged;
}

/**
 * The vertical faces: the deck's own edge and the fascia of each terrace step.
 *
 * Each is an open cylinder standing on the deck below it, so the steps read as
 * cut masonry rather than as the top surfaces floating with nothing holding
 * them up — which is what you get if you only build the walking surfaces, and
 * it is glaring from any camera below the rim.
 */
function buildFascias(segs: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  for (let i = 0; i < DECKS.length; i++) {
    const d = DECKS[i];
    // Down to the next deck's surface, or a generous skirt for the last one.
    const below = i + 1 < DECKS.length ? DECKS[i + 1].y : d.y - 26;
    const h = d.y - below;
    if (h <= 0) continue;
    const g = new THREE.CylinderGeometry(d.outer, d.outer * 0.985, h, segs, 1, true);
    g.translate(0, d.y - h / 2, 0);
    withHeight(g, below, d.y);
    parts.push(g);
  }

  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  merged.computeVertexNormals();
  return merged;
}

/* -------------------------------------------------------------------------
 * The system
 * ---------------------------------------------------------------------- */

export interface KeelHandle extends System {
  readonly reflected: true;
}

export function buildKeel(ctx: BuildContext): KeelHandle {
  const rng = makeRng(`empyrean-keel-${ctx.seedSalt}`);
  const low = ctx.quality === "low";
  const group = new THREE.Group();
  group.name = "empyrean-keel";

  const uniforms = () => ({
    uSun: { value: SUN_DIR.clone() },
    uCam: { value: new THREE.Vector3() },
    uNight: { value: 0 },
  });

  const rockMat = new THREE.ShaderMaterial({
    name: "EmpyreanRock",
    vertexShader: ROCK_VERT,
    fragmentShader: ROCK_FRAG,
    uniforms: uniforms(),
    side: THREE.DoubleSide,
  });
  const fasciaMat = new THREE.ShaderMaterial({
    name: "EmpyreanFascia",
    vertexShader: ROCK_VERT,
    fragmentShader: FASCIA_FRAG,
    uniforms: uniforms(),
    side: THREE.DoubleSide,
    // `fwidth` is core in the GLSL ES 3.00 this compiles to on WebGL2; the
    // flag is what keeps it compiling on a WebGL1 context.
    extensions: { derivatives: true },
  });

  const rock = buildRock(low ? 30 : 54, low ? 72 : 128);
  const rockMesh = new THREE.Mesh(rock, rockMat);
  rockMesh.name = "keel-rock";
  group.add(rockMesh);

  const spikes = buildSpikes(rng, low ? 16 : 30);
  const spikeMesh = new THREE.Mesh(spikes, rockMat);
  spikeMesh.name = "keel-spikes";
  group.add(spikeMesh);

  const fascias = buildFascias(low ? 72 : 128);
  const fasciaMesh = new THREE.Mesh(fascias, fasciaMat);
  fasciaMesh.name = "keel-fascias";
  group.add(fasciaMesh);

  const mats = [rockMat, fasciaMat];

  return {
    name: "keel",
    group,
    reflected: true,
    update(frame: FrameContext) {
      for (const m of mats) {
        (m.uniforms.uSun.value as THREE.Vector3).copy(frame.sunDir);
        (m.uniforms.uCam.value as THREE.Vector3).copy(frame.camera.position);
        m.uniforms.uNight.value = 1 - frame.daylight;
      }
    },
    dispose() {
      rock.dispose();
      spikes.dispose();
      fascias.dispose();
      rockMat.dispose();
      fasciaMat.dispose();
    },
  };
}
