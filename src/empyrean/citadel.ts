/**
 * THE CITADEL — the island itself, and everything standing on it.
 *
 * Four parts, in the order the eye reads them in the reference painting:
 *
 *   towers  — a tight cluster of glass slabs, tallest in the middle, lit from
 *             inside rather than from outside
 *   deck    — the plaza they stand on, and the terraces stepping down off it
 *   keel    — three hundred metres of fluted rock hanging below, ending in a
 *             point, with a fringe of stalactites around the rim
 *   lamps   — the warm line of light along every terrace edge, which is the
 *             only thing in the picture that says people live here
 *
 * Two rules run through all of it.
 *
 * **Every gradient is driven by an attribute along the object's own height,
 * never by world Y.** The lake reflection in `terrain.ts` is a real second
 * copy of this group mirrored by `scale.y = -1`; a world-Y gradient survives
 * that mirroring the right way up, inside an upside-down reflection, and the
 * result is subtly, unplaceably wrong.
 *
 * **Every material is double-sided**, for the same reason: a negative scale
 * inverts winding, and the alternative is a parallel set of cloned materials
 * to keep in step forever.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { makeRng, fbm2 } from "@/shared/proc/rng";
import { ISLAND_Y, KEEL_DEPTH, PLATEAU_R, SPAWN } from "./config";

/**
 * Radius of the clear apron around the arrival point.
 *
 * There was no such thing in the first build, and the golden-angle spiral
 * duly put a forty-metre slab exactly where the player lands: you arrived
 * inside a building, with the third-person camera inside a second one, and
 * the entire first frame of the world was a white wall. The card art was
 * fine the whole time, because the card art is photographed from a kilometre
 * away — which is the argument for opening the route and looking, every time.
 */
const APRON_R = 46;

/** An axis-aligned box the player cannot walk through. World space. */
export interface Blocker {
  x: number;
  z: number;
  /** Half-extents on x and z. */
  hx: number;
  hz: number;
  /** Walkable roof. */
  top: number;
  /** Underside — you can fly beneath a building without being stopped by it. */
  bottom: number;
}

/** A flat surface you can stand on: the plaza, a terrace, a roof. */
export interface Deck {
  y: number;
  /** Circular decks carry a radius; rectangular ones carry half-extents. */
  r?: number;
  x?: number;
  z?: number;
  hx?: number;
  hz?: number;
  /** Inner radius, for the annulus a terrace actually is. */
  inner?: number;
}

export interface CitadelHandle {
  group: THREE.Group;
  blockers: Blocker[];
  decks: Deck[];
  /** Warm lamps pulse very slightly; the towers breathe. */
  update(time: number): void;
  dispose(): void;
}

/* -------------------------------------------------------------------------
 * Glass
 * ---------------------------------------------------------------------- */

const TOWER_VERT = /* glsl */ `
attribute float aH;
attribute float aBase;
attribute float aSeed;
varying float vH;
varying float vBase;
varying float vSeed;
varying vec2 vUv;
varying vec3 vNrm;
varying vec3 vWPos;
void main() {
  vH = aH;
  vBase = aBase;
  vSeed = aSeed;
  vUv = uv;
  vNrm = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/**
 * Unlit, on purpose.
 *
 * The towers in the reference are not surfaces catching a sunset, they are
 * columns of colour — the light is coming *through* them. A standard material
 * lit by a low sun gives you two bright faces and two black ones and the
 * whole cluster reads as a pile of boxes. Writing radiance directly, with the
 * gradient running up the slab and a fresnel lip on the silhouette, is both
 * closer to the painting and about a tenth of the cost at fifty draws.
 */
const TOWER_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uSun;
varying float vH;
varying float vBase;
varying float vSeed;
varying vec2 vUv;
varying vec3 vNrm;
varying vec3 vWPos;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}

/**
 * The dome's gradient, cut down to what a reflection needs — the same five
 * stops sky.ts paints and terrain.ts reflects off the ice.
 *
 * This is the single thing that makes the towers read as glass rather than as
 * painted concrete. Without it a slab is its own gradient and nothing else, so
 * from the plaza the city was a canyon of pink corduroy: correct colours,
 * correct banding, and obviously a solid. Glass has the sky in it, and the sky
 * here is a closed-form function, so it costs nine mixes and no texture.
 */
vec3 skyColor(vec3 rd, vec3 sun) {
  float t = clamp(rd.y, 0.0, 1.0);
  float sunAmt = clamp(dot(rd, sun) * 0.5 + 0.5, 0.0, 1.0);
  vec3 cRose   = vec3(1.00, 0.44, 0.60);
  vec3 cOrange = vec3(1.00, 0.56, 0.26);
  vec3 cGold   = vec3(1.00, 0.84, 0.40);
  vec3 cJade   = vec3(0.22, 0.82, 0.72);
  vec3 cSky    = vec3(0.07, 0.30, 0.72);
  vec3 cNavy   = vec3(0.020, 0.040, 0.175);
  vec3 c = mix(cOrange, cGold, smoothstep(0.010, 0.070, t));
  c = mix(c, cJade, smoothstep(0.050, 0.155, t));
  c = mix(c, cSky,  smoothstep(0.185, 0.400, t));
  c = mix(c, cNavy, smoothstep(0.360, 0.820, t));
  float low = 1.0 - smoothstep(0.0, 0.42, t);
  c = mix(c, cRose, low * (1.0 - sunAmt) * 0.62);
  c = mix(c, cGold * 1.10, low * pow(sunAmt, 2.2) * 0.75);
  // Below the horizon a tower reflects the snowfield, not the ground haze.
  c = mix(c, vec3(0.72, 0.62, 0.70), smoothstep(0.0, -0.28, rd.y) * 0.85);
  // A tight sun glint only. A broad one turns every face that happens to
  // point west into a lightbox and the canyon loses all its contrast.
  c += vec3(1.0, 0.72, 0.44) * pow(max(dot(rd, sun), 0.0), 70.0) * 1.1;
  return c;
}

void main() {
  float s = vSeed;
  float warmth = hash11(s * 7.13);       // which way this slab leans
  float cool   = hash11(s * 3.71 + 2.0);

  /* The ramp. Bottom to top: a dark warm foot where the slab meets the deck,
   * amber, then the long cream-to-cyan body, then ice at the crown. */
  vec3 cFoot  = mix(vec3(0.10, 0.05, 0.11), vec3(0.16, 0.07, 0.09), warmth);
  /* Amber and rose, not magenta.
   *
   * These two stops are the only ones you ever see from the ground, and the
   * first build put a hot crimson at the bottom of the ramp — from a
   * kilometre away it blended into the gold and looked right; standing on the
   * plaza the city was a ring of fuchsia boxes. The reference's lower storeys
   * are cream and amber with rose only in the shadows. */
  vec3 cLow   = mix(vec3(1.00, 0.56, 0.30), vec3(0.92, 0.40, 0.40), warmth);
  vec3 cMid   = mix(vec3(1.00, 0.88, 0.66), vec3(1.00, 0.74, 0.74), warmth);
  vec3 cUpper = mix(vec3(0.30, 0.80, 1.00), vec3(0.66, 0.55, 1.00), cool);
  vec3 cTop   = mix(vec3(0.72, 0.92, 1.00), vec3(0.36, 0.50, 0.98), cool);

  float h = clamp(vH, 0.0, 1.0);
  // Where the warm half gives way to the cool one, per slab. Staggering this
  // is what stops the cluster reading as one airbrushed gradient.
  float breakpoint = mix(0.42, 0.74, hash11(s * 11.7));

  vec3 col = mix(cFoot, cLow, smoothstep(0.0, 0.10, h));
  col = mix(col, cMid,   smoothstep(0.06, breakpoint, h));
  col = mix(col, cUpper, smoothstep(breakpoint, breakpoint + 0.30, h));
  col = mix(col, cTop,   smoothstep(0.80, 1.0, h));

  /* Floors. A fine horizontal banding that gets tighter toward the top, which
   * is perspective doing what perspective does and is most of why a shape
   * this simple still reads as a building. */
  float floors = 90.0 + hash11(s * 5.5) * 70.0;
  float band = abs(fract(h * floors) - 0.5) * 2.0;
  col *= 0.87 + 0.20 * smoothstep(0.15, 0.85, band);

  /* Mullions: vertical divisions, and a bright lip at the corners of the
   * slab. The corner highlight is doing the work of an edge light. */
  float mull = abs(fract(vUv.x * (5.0 + floor(hash11(s * 2.3) * 6.0))) - 0.5) * 2.0;
  col *= 0.90 + 0.16 * mull;
  float corner = smoothstep(0.40, 0.50, abs(vUv.x - 0.5));
  col += col * corner * 0.30;

  /* Lit windows. Sparse, warm, and mostly in the lower two-thirds where the
   * offices are; they are the only detail at this distance that is a person. */
  vec2 cell = vec2(floor(vUv.x * 34.0), floor(h * floors));
  float lit = step(0.955, hash11(cell.x * 31.7 + cell.y * 7.3 + s));
  col += vec3(1.0, 0.78, 0.42) * lit * (1.0 - smoothstep(0.45, 0.9, h)) * 0.40;

  /* The plinth. Thirty metres of dark stone at the foot of everything, so a
   * plaza you are standing on is not lined with magenta glass at eye level.
   * Measured in metres and not in fractions of the slab -- see withHeight. */
  col = mix(cFoot * 1.4, col, smoothstep(2.0, 34.0, vBase));

  /* Fresnel, faded out at arm's length.
   *
   * The lip is what separates fifty overlapping slabs at a kilometre. Standing
   * on the plaza with your nose against one it is a floodlight, and the first
   * build's opening frame was a white wall for exactly that reason: an effect
   * tuned entirely from the card-art camera, which is a kilometre away. It is
   * a silhouette effect, so it belongs at silhouette distance.
   */
  vec3 toEye = uCam - vWPos;
  float dist = length(toEye);
  vec3 V = toEye / max(dist, 0.001);
  vec3 N = normalize(vNrm);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.6);

  /* The sky, in the glass. Present at every range and strongest where the
   * face turns away from you, which is what glass does. */
  vec3 env = skyColor(reflect(-V, N), normalize(uSun));
  // Twelve per cent at face-on, up to about half at a grazing angle. Pushed
  // higher than this the slab stops being its own colour and the whole canyon
  // washes out to the colour of the sky it is standing in.
  col = mix(col, env * 0.86, 0.12 + 0.42 * fres);

  /* And the silhouette lip on top, faded out at arm's length. It is what
   * separates fifty overlapping slabs at a kilometre; standing with your nose
   * against one it is a floodlight, and the first build's opening frame was a
   * white wall for exactly that reason — an effect tuned entirely from the
   * card-art camera, which is a kilometre away. */
  col += mix(vec3(0.45, 0.85, 1.0), vec3(1.0, 0.72, 0.85), warmth)
       * fres * smoothstep(35.0, 220.0, dist) * 0.85;

  /* A slow breath, out of phase per slab. Barely visible and the thing that
   * stops a still frame looking like a still frame. */
  col *= 0.94 + 0.06 * sin(uTime * 0.5 + s * 6.28);

  gl_FragColor = vec4(col, 1.0);
}
`;

/* -------------------------------------------------------------------------
 * Rock
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
 * The keel is lit by exactly two things and neither of them is a lamp: the
 * sun raking it from the side, and the sunset sky bouncing up off the ice
 * underneath. `aH` runs 0 at the plaza rim to 1 at the tip, so the descent
 * into darkness is along the rock rather than along world Y — which is what
 * lets the mirrored copy invert correctly.
 */
const ROCK_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSun;
uniform vec3 uCam;
varying float vH;
varying vec3 vNrm;
varying vec3 vWPos;

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

  /* Direct sun: a hard warm rake across one side. */
  vec3 col = base * (0.22 + 0.95 * max(sunlit, 0.0));
  col += vec3(1.00, 0.55, 0.30) * pow(max(sunlit, 0.0), 2.4) * 0.55;

  /* Bounce from the ice. Only on faces turned downward, and it falls off with
   * depth — this is the light that makes the underside legible instead of a
   * silhouette, and it is worth more to the picture than the sun is. */
  float down = clamp(-N.y * 0.5 + 0.5, 0.0, 1.0);
  col += vec3(0.58, 0.42, 0.66) * down * (1.0 - vH * 0.55) * 0.46;

  /* Striation. The reference's underside is combed with vertical grooves all
   * the way down; the geometry carries some of that, but the shading is what
   * actually reads at a distance. */
  float groove = abs(fract(atan(vWPos.z, vWPos.x) * 9.0) - 0.5) * 2.0;
  col *= 0.80 + 0.32 * groove;

  /* Rim from the sky behind. */
  vec3 V = normalize(uCam - vWPos);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  col += vec3(1.0, 0.62, 0.55) * fres * 0.30 * (1.0 - vH * 0.6);

  gl_FragColor = vec4(col, 1.0);
}
`;

/* -------------------------------------------------------------------------
 * Build
 * ---------------------------------------------------------------------- */

/**
 * Attach the per-vertex height ramps a shader here needs, 0 at the base.
 *
 * Two of them, and the second one matters more than it looks. `aH` is
 * normalised 0..1 along the object, which is what a gradient wants. `aBase` is
 * *metres* above the object's own foot, which is what anything measured in
 * real units wants — and the plinth is measured in real units, because a
 * twenty-metre kiosk and a four-hundred-metre spire should both be dark stone
 * for their first thirty metres and then stop being. Do it in normalised
 * space and the kiosk is entirely plinth while the spire's plinth is a line,
 * which is exactly how the first build's plaza came out magenta at eye level.
 *
 * Both are computed from local geometry, so both survive the `scale.y = -1`
 * the lake reflection applies.
 */
function withHeight(geo: THREE.BufferGeometry, lo: number, hi: number, seed?: number) {
  const pos = geo.getAttribute("position");
  const n = pos.count;
  const h = new Float32Array(n);
  const m = new Float32Array(n);
  const span = Math.max(hi - lo, 1e-4);
  for (let i = 0; i < n; i++) {
    h[i] = THREE.MathUtils.clamp((pos.getY(i) - lo) / span, 0, 1);
    m[i] = pos.getY(i) - lo;
  }
  geo.setAttribute("aH", new THREE.BufferAttribute(h, 1));
  geo.setAttribute("aBase", new THREE.BufferAttribute(m, 1));
  if (seed !== undefined) {
    const s = new Float32Array(n).fill(seed);
    geo.setAttribute("aSeed", new THREE.BufferAttribute(s, 1));
  }
  return geo;
}

/**
 * The rock: a ring-and-radial lathe with the profile pinched to a point.
 *
 * Built by hand rather than from `LatheGeometry` because every ring needs its
 * own per-angle noise — a lathe is a surface of revolution and a surface of
 * revolution is exactly what a floating island must not look like. The
 * fluting is a low-frequency angular term that persists down the whole
 * length, which is what gives the vertical striations in the reference.
 */
function buildKeel(): { geo: THREE.BufferGeometry; radiusAt: (t: number) => number } {
  const RINGS = 46;
  const SEGS = 96;
  const topY = ISLAND_Y - 62;
  const tipY = ISLAND_Y - KEEL_DEPTH;

  // The silhouette, as seen from the side. Wide and nearly flat under the
  // rim, then falling away fast — an ice-cream cone reads as a toy; this
  // profile is closer to the underside of a mountain that has been snapped off.
  /**
   * A steady inverted cone with a slight waist — and it starts *below* the
   * terraces, at very nearly their width.
   *
   * This number was wrong twice in opposite directions and both failures are
   * worth keeping. Taper from the first millimetre and the rock is always
   * narrower than the decks above it, so the base reads as a stack of discs
   * floating in the air — a flying saucer with stalactites. Hold a cosine
   * shoulder instead and it goes the other way: the rock bulges out past the
   * terraces, swallows them, and the island becomes a cauldron.
   *
   * What the reference actually has is neither. The decks form a rim; the
   * rock begins immediately under that rim at almost exactly the same width
   * and falls away to a point that is longer than the city is tall.
   */
  const profile = (t: number) => Math.pow(1 - t, 1.22) * (1 - 0.12 * Math.sin(t * Math.PI * 2.1));

  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS;
    const y = THREE.MathUtils.lerp(topY, tipY, t);
    const baseR = PLATEAU_R * 1.16 * profile(t);
    for (let j = 0; j <= SEGS; j++) {
      const a = (j / SEGS) * Math.PI * 2;
      /**
       * Three scales of shape, and they do different jobs.
       *
       * `lobe` is the only one that changes the silhouette: four broad
       * buttresses so the rock is not a circle in plan, which is the single
       * thing that stopped the first pass looking like a turned wooden cone.
       * `flute` is the vertical striation the reference has all down the
       * underside. `rough` is the surface, and it gets coarser as the rock
       * narrows because that is where it broke off.
       */
      const lobe = 1 + Math.sin(a * 4 + 0.7) * 0.10 + Math.sin(a * 3 - 2.1) * 0.06;
      const flute = 1 + Math.sin(a * 17 + t * 2.2) * 0.055 * (0.35 + t);
      const rough =
        1 +
        fbm2(Math.cos(a) * 2.6 + t * 3.1, Math.sin(a) * 2.6, 4, 2, 0.5, 404) * 0.34 * (0.3 + t * 1.1);
      const r = baseR * lobe * flute * rough;
      positions.push(Math.cos(a) * r, y, Math.sin(a) * r);
    }
  }

  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEGS; j++) {
      const a = i * (SEGS + 1) + j;
      const b = a + SEGS + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  withHeight(geo, tipY, topY);
  // aH runs 0 at the base of the ramp; here "base" is the tip, so invert it —
  // the shader wants 0 at the plaza and 1 in the dark.
  const h = geo.getAttribute("aH") as THREE.BufferAttribute;
  for (let i = 0; i < h.count; i++) h.setX(i, 1 - h.getX(i));

  return { geo, radiusAt: (t) => PLATEAU_R * 1.16 * profile(t) };
}

/** The fringe of stalactites hanging off the rim, longest at the front. */
function buildSpikes(rng: ReturnType<typeof makeRng>): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  /**
   * One dominant point, then a fringe.
   *
   * A ring of thirty similar spikes reads as a crown, which is a shape, but
   * not this one. What the reference has is a single spike longer than
   * everything else put together, hanging straight down the axis, with small
   * broken teeth scattered around the rim of the rock above it. The long one
   * is most of the island's silhouette from underneath and all of it from a
   * distance.
   */
  {
    const g = new THREE.ConeGeometry(30, 230, 6, 1, true);
    g.rotateX(Math.PI);
    const yTop = ISLAND_Y - 330;
    g.translate(0, yTop - 115, 0);
    withHeight(g, yTop - 230, yTop);
    const h = g.getAttribute("aH") as THREE.BufferAttribute;
    for (let k = 0; k < h.count; k++) h.setX(k, 1 - h.getX(k) * 0.85);
    parts.push(g);
  }

  const COUNT = 30;
  for (let i = 0; i < COUNT; i++) {
    // Chunky and uneven. Fifty thin ones at a uniform height came out as a
    // fringe of identical fangs — a curtain, not a broken rock.
    const a = (i / COUNT) * Math.PI * 2 + rng.range(-0.22, 0.22);
    const rr = PLATEAU_R * rng.range(0.28, 0.95);
    const len = rng.range(30, 140) * (1 - (rr / PLATEAU_R) * 0.28);
    const rad = rng.range(8, 24);
    // Cones, three to six sided — a smooth cone at this size reads as a spike
    // from a modelling package; a faceted one reads as rock.
    const g = new THREE.ConeGeometry(rad, len, rng.int(3, 6), 1, true);
    g.rotateX(Math.PI); // point down
    // Rooted: the top of every spike is buried inside the rock mass, so they
    // grow out of it instead of dangling below it like a mobile.
    const yTop = ISLAND_Y - 120 - Math.pow(rr / PLATEAU_R, 2.4) * 150 - rng.range(0, 70);
    g.translate(Math.cos(a) * rr, yTop - len / 2, Math.sin(a) * rr);
    withHeight(g, yTop - len, yTop);
    const h = g.getAttribute("aH") as THREE.BufferAttribute;
    // Same convention as the keel: 0 at the top, 1 at the point.
    for (let k = 0; k < h.count; k++) h.setX(k, 1 - h.getX(k) * 0.85);
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  merged.computeVertexNormals();
  return merged;
}

/** The plaza and the terraces below it, as one stone shell. */
function buildDecks(): { geo: THREE.BufferGeometry; decks: Deck[] } {
  const parts: THREE.BufferGeometry[] = [];
  const decks: Deck[] = [];

  // Plaza.
  const top = new THREE.CylinderGeometry(PLATEAU_R, PLATEAU_R * 0.99, 6, 40, 1, false);
  top.translate(0, ISLAND_Y - 3, 0);
  withHeight(top, ISLAND_Y - 6, ISLAND_Y);
  parts.push(top);
  decks.push({ y: ISLAND_Y, r: PLATEAU_R });

  // Three terraces, each wider and lower — the reference has the island
  // fanning outward as it comes down, which is the opposite of what a floating
  // rock wants to do and exactly what makes it look built.
  /**
   * Small steps out, big steps down, and faceted rather than round.
   *
   * Three wide shallow rings gave a flying saucer — three discs seen edge-on
   * as concentric ellipses, which is a shape with no architecture in it. What
   * the reference has is a cliff with terraces cut into it: the drop between
   * levels is several times the step outward, and the edge is a polygon you
   * can count the sides of.
   */
  const TERRACES = [
    { r: PLATEAU_R * 1.045, drop: 18, thick: 15 },
    { r: PLATEAU_R * 1.09, drop: 42, thick: 15 },
    { r: PLATEAU_R * 1.13, drop: 68, thick: 13 },
  ];
  for (const t of TERRACES) {
    const y = ISLAND_Y - t.drop;
    const g = new THREE.CylinderGeometry(t.r, t.r * 0.95, t.thick, 40, 1, false);
    g.translate(0, y - t.thick / 2, 0);
    withHeight(g, y - t.thick, y);
    parts.push(g);
    decks.push({ y, r: t.r, inner: 0 });
  }

  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  merged.computeVertexNormals();
  return { geo: merged, decks };
}

/** Where each tower stands, how big it is, and which way its palette leans. */
interface TowerPlan {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  rot: number;
  seed: number;
}

/** True where a tower would stand on top of the player's arrival. */
function onTheApron(x: number, z: number, pad: number): boolean {
  return Math.hypot(x - SPAWN.x, z - SPAWN.z) < APRON_R + pad;
}

function planTowers(rng: ReturnType<typeof makeRng>): TowerPlan[] {
  const plans: TowerPlan[] = [];
  const COUNT = 62;
  const SPREAD = PLATEAU_R * 0.90;

  for (let i = 0; i < COUNT; i++) {
    // Golden-angle spiral: even coverage without a grid and without the
    // clumping a plain random scatter gives at this count.
    const f = i / COUNT;
    const r = SPREAD * Math.sqrt(f) * rng.range(0.86, 1.06);
    const a = i * 2.39996 + rng.range(-0.18, 0.18);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;

    // Tallest in the middle. The falloff is the silhouette of the whole
    // cluster, so it matters more than any single tower does.
    const centrality = 1 - Math.min(1, r / SPREAD);
    /**
     * Scale, measured against the rock rather than against itself.
     *
     * The first pass topped out at 250 m against a 300 m keel and the whole
     * thing read as a saucer with glitter on it. In the reference the city is
     * the *taller* half of the silhouette — the towers out-climb the spike —
     * and getting that ratio right did more for the picture than any amount
     * of shader work on the glass.
     */
    const h = (95 + Math.pow(centrality, 0.85) * 340) * rng.range(0.62, 1.22);
    const w = rng.range(15, 40) * (0.65 + centrality * 0.55);
    const d = w * rng.range(0.55, 1.6);

    if (onTheApron(x, z, Math.max(w, d) * 0.5)) continue;
    plans.push({ x, z, w, d, h, rot: rng.range(0, Math.PI), seed: rng.next() * 100 });
  }

  // A low outer band on the terraces: arcades and blockhouses at the rim,
  // which is what stops the cluster looking like it was dropped on a plate.
  /**
   * A low outer band standing right on the lip, and a second one a step down
   * on the terraces.
   *
   * Without it there is a bare ring of stone between the last tower and the
   * edge, and at any distance that ring reads as a pale collar around the
   * city — which is most of what made the early passes look like a saucer.
   * Buildings on the rim are what turn an edge into a skyline.
   */
  const RIM = 42;
  for (let i = 0; i < RIM; i++) {
    const a = (i / RIM) * Math.PI * 2 + rng.range(-0.05, 0.05);
    const r = PLATEAU_R * rng.range(0.90, 1.00);
    const rx = Math.cos(a) * r;
    const rz = Math.sin(a) * r;
    // The apron opens on to the rim: you should be able to walk to the edge
    // and look over it without a wall in the way.
    if (onTheApron(rx, rz, 10)) continue;
    plans.push({
      x: rx,
      z: rz,
      w: rng.range(12, 26),
      d: rng.range(9, 16),
      h: rng.range(14, 48),
      rot: a,
      seed: rng.next() * 100,
    });
  }

  return plans;
}

function buildTowers(plans: TowerPlan[]): { geo: THREE.BufferGeometry; blockers: Blocker[]; decks: Deck[] } {
  const parts: THREE.BufferGeometry[] = [];
  const blockers: Blocker[] = [];
  const decks: Deck[] = [];

  for (const p of plans) {
    const g = new THREE.BoxGeometry(p.w, p.h, p.d, 1, 1, 1);
    withHeight(g, -p.h / 2, p.h / 2, p.seed);
    g.rotateY(p.rot);
    g.translate(p.x, ISLAND_Y + p.h / 2, p.z);
    parts.push(g);

    // Collision and standing are both done against an axis-aligned box, so a
    // rotated slab is approximated by its bounding square. At this density
    // the error is a metre or two and nobody has ever noticed it in a world
    // you cross with a jetpack; a real OBB test here would be ceremony.
    const half = (Math.abs(Math.cos(p.rot)) * p.w + Math.abs(Math.sin(p.rot)) * p.d) / 2;
    const halfZ = (Math.abs(Math.sin(p.rot)) * p.w + Math.abs(Math.cos(p.rot)) * p.d) / 2;
    blockers.push({
      x: p.x,
      z: p.z,
      hx: half,
      hz: halfZ,
      top: ISLAND_Y + p.h,
      bottom: ISLAND_Y,
    });
    decks.push({ y: ISLAND_Y + p.h, x: p.x, z: p.z, hx: half, hz: halfZ });
  }

  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return { geo: merged, blockers, decks };
}

/**
 * The warm line along every terrace edge.
 *
 * Rings of small emissive quads rather than lights: this world has two real
 * lights in it and adding four hundred is not a trade, it is a slideshow.
 * They are bright enough to be picked up by the bloom pass, which is what
 * actually sells them as lamps.
 */
function buildLamps(rng: ReturnType<typeof makeRng>): THREE.Points {
  const RINGS = [
    { r: PLATEAU_R * 0.99, y: ISLAND_Y + 1.6, n: 150 },
    { r: PLATEAU_R * 1.04, y: ISLAND_Y - 16.4, n: 165 },
    { r: PLATEAU_R * 1.085, y: ISLAND_Y - 40.4, n: 180 },
    { r: PLATEAU_R * 1.125, y: ISLAND_Y - 66.4, n: 195 },
  ];
  const pos: number[] = [];
  const col: number[] = [];
  const size: number[] = [];
  const warm = new THREE.Color(0xffc27a);
  const cool = new THREE.Color(0x8fd8ff);
  const c = new THREE.Color();

  for (const ring of RINGS) {
    for (let i = 0; i < ring.n; i++) {
      const a = (i / ring.n) * Math.PI * 2;
      pos.push(Math.cos(a) * ring.r, ring.y, Math.sin(a) * ring.r);
      c.copy(warm).lerp(cool, rng.chance(0.14) ? rng.range(0.5, 1) : 0);
      col.push(c.r, c.g, c.b);
      size.push(rng.range(1.3, 2.4));
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute("aSize", new THREE.Float32BufferAttribute(size, 1));

  const mat = new THREE.ShaderMaterial({
    name: "EmpyreanLamps",
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uTime: { value: 0 }, uScale: { value: 900 } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      uniform float uScale;
      varying vec3 vCol;
      void main() {
        vCol = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // Size in world units, with a floor so a lamp never vanishes at range —
        // the line of them along the rim is the read, not any one lamp.
        // Clamped at both ends. The floor keeps the line of lamps readable at
        // a kilometre; the ceiling stops a lamp you are standing next to
        // filling a quarter of the screen, which is what an unbounded
        // world-space size does the moment you land on the terrace it is on.
        gl_PointSize = clamp(aSize * uScale / max(-mv.z, 1.0), 1.6, 12.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vCol;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d) * 2.0;
        float core = smoothstep(1.0, 0.0, r);
        gl_FragColor = vec4(vCol * (0.4 + core * 1.9), core * core);
      }
    `,
  });
  mat.vertexColors = true;

  const points = new THREE.Points(geo, mat);
  points.name = "empyrean-lamps";
  points.frustumCulled = false;
  return points;
}

export function buildCitadel(): CitadelHandle {
  const rng = makeRng("empyrean-citadel-v1");
  const group = new THREE.Group();
  group.name = "empyrean-citadel";

  const rockMat = new THREE.ShaderMaterial({
    name: "EmpyreanRock",
    vertexShader: ROCK_VERT,
    fragmentShader: ROCK_FRAG,
    uniforms: {
      uSun: { value: new THREE.Vector3() },
      uCam: { value: new THREE.Vector3() },
    },
    side: THREE.DoubleSide,
    fog: false,
  });

  const towerMat = new THREE.ShaderMaterial({
    name: "EmpyreanGlass",
    vertexShader: TOWER_VERT,
    fragmentShader: TOWER_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uSun: { value: new THREE.Vector3() },
    },
    side: THREE.DoubleSide,
    fog: false,
  });

  const keel = buildKeel();
  const keelMesh = new THREE.Mesh(keel.geo, rockMat);
  keelMesh.name = "empyrean-keel";
  group.add(keelMesh);

  const spikes = buildSpikes(rng);
  const spikeMesh = new THREE.Mesh(spikes, rockMat);
  spikeMesh.name = "empyrean-spikes";
  group.add(spikeMesh);

  const deckBuild = buildDecks();
  const deckMat = new THREE.ShaderMaterial({
    name: "EmpyreanStone",
    vertexShader: ROCK_VERT,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uSun;
      uniform vec3 uCam;
      varying float vH;
      varying vec3 vNrm;
      varying vec3 vWPos;
      void main() {
        vec3 N = normalize(vNrm);
        float sunlit = clamp(dot(N, normalize(uSun)), -1.0, 1.0);
        /* Pale warm stone on top, darkening down the terrace face. The face is
         * where the arcade openings would be, so it gets a fine vertical
         * banding standing in for them at any distance you actually see it. */
        vec3 col = mix(vec3(0.09, 0.06, 0.09), vec3(0.36, 0.29, 0.32), smoothstep(0.15, 0.95, vH));
        float ang = atan(vWPos.z, vWPos.x);
        float arcade = abs(fract(ang * 22.0) - 0.5) * 2.0;
        col *= mix(1.0, 0.72 + 0.4 * arcade, 1.0 - smoothstep(0.55, 0.95, vH));

        /* Paving, on the top faces only.
         *
         * From the card-art camera the plaza is four pixels of stone and any
         * detail here is invisible; from the arrival point it is most of what
         * you can see, and without it the first thing the world shows you is
         * an unbroken sheet of flat purple the size of a stadium. Concentric
         * rings and radial spokes, plus a warm inlay that picks out every
         * fifth ring — the geometry of a plaza rather than a floor.
         */
        float up = clamp(N.y, 0.0, 1.0);
        if (up > 0.5) {
          float rad = length(vWPos.xz);
          float ring = abs(fract(rad / 9.0) - 0.5) * 2.0;
          float spoke = abs(fract(ang * 12.0 / 3.14159) - 0.5) * 2.0;
          float joint = min(smoothstep(0.0, 0.10, ring), smoothstep(0.0, 0.06, spoke));
          col *= mix(0.66, 1.06, joint) ;
          float inlay = smoothstep(0.985, 1.0, abs(fract(rad / 45.0) - 0.5) * 2.0);
          col += vec3(1.0, 0.62, 0.30) * inlay * 0.55;
        }
        col *= 0.30 + 0.90 * max(sunlit, 0.0);
        col += vec3(1.0, 0.58, 0.34) * pow(max(sunlit, 0.0), 3.0) * 0.35;
        // Sky bounce on the upward faces: the plaza is lit by the whole dome.
        col += vec3(0.42, 0.36, 0.56) * clamp(N.y, 0.0, 1.0) * 0.16;
        vec3 V = normalize(uCam - vWPos);
        col += vec3(1.0, 0.68, 0.60) * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0) * 0.22;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    uniforms: {
      uSun: { value: new THREE.Vector3() },
      uCam: { value: new THREE.Vector3() },
    },
    side: THREE.DoubleSide,
    fog: false,
  });
  const deckMesh = new THREE.Mesh(deckBuild.geo, deckMat);
  deckMesh.name = "empyrean-decks";
  group.add(deckMesh);

  const plans = planTowers(rng);
  const towers = buildTowers(plans);
  const towerMesh = new THREE.Mesh(towers.geo, towerMat);
  towerMesh.name = "empyrean-towers";
  group.add(towerMesh);

  const lamps = buildLamps(rng);
  group.add(lamps);

  return {
    group,
    blockers: towers.blockers,
    decks: [...deckBuild.decks, ...towers.decks],
    update(time) {
      towerMat.uniforms.uTime.value = time;
      (lamps.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
    },
    dispose() {
      keel.geo.dispose();
      spikes.dispose();
      deckBuild.geo.dispose();
      towers.geo.dispose();
      lamps.geometry.dispose();
      (lamps.material as THREE.Material).dispose();
      rockMat.dispose();
      deckMat.dispose();
      towerMat.dispose();
    },
  };
}

/** Point the shared shader uniforms at the sun and the eye. Called once a frame. */
export function syncCitadelUniforms(group: THREE.Group, sun: THREE.Vector3, cam: THREE.Vector3) {
  group.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
    if (!m || !m.uniforms) return;
    if (m.uniforms.uSun) (m.uniforms.uSun.value as THREE.Vector3).copy(sun);
    if (m.uniforms.uCam) (m.uniforms.uCam.value as THREE.Vector3).copy(cam);
  });
}
