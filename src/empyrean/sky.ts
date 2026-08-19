/**
 * The sky of The Empyrean — the whole painting, minus the rock.
 *
 * The reference this world is built from is a sunset that does four things at
 * once, and getting all four into one gradient is most of why the place reads
 * the way it does:
 *
 *  1. A deep navy zenith with real stars in it — night has already started up
 *     there while the horizon is still on fire.
 *  2. A band of teal/jade between the navy and the warm light, which is the
 *     colour nobody expects and the one that makes it look painted.
 *  3. Gold into orange into rose as you come down to the horizon, brightest
 *     around the sun's azimuth and cooling toward magenta away from it.
 *  4. Flat-bottomed cumulus catching the light from underneath.
 *
 * All of it is one inverted sphere pinned to the camera, evaluated per pixel
 * along the view ray. No geometry, nothing to cull, and it costs the same
 * whether you are standing on the plaza or three hundred metres under the
 * island looking up through the spires.
 *
 * The dome writes radiance well above 1.0 near the sun. That is deliberate —
 * `postfx.ts` is the only thing in this world that tone maps, and the bloom
 * threshold wants something to find.
 */
import * as THREE from "three";

/** Where the sun sits. Everything warm in this world points back at it. */
export const SUN_DIR = new THREE.Vector3(-0.62, 0.085, -0.78).normalize();

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec3 uSunDir;
varying vec3 vDir;

/* ---- noise ----------------------------------------------------------- */
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

/* ---- stars ------------------------------------------------------------
 * Only in the upper third, and fading out fast as the sky warms — a star
 * visible through the gold band is the tell that a gradient was faked.
 */
vec3 stars(vec3 rd) {
  float up = smoothstep(0.14, 0.50, rd.y);
  if (up <= 0.0) return vec3(0.0);
  vec2 uv = rd.xz / max(rd.y, 0.35) * 3.2;
  vec3 acc = vec3(0.0);
  for (int L = 0; L < 2; L++) {
    float scale = L == 0 ? 46.0 : 88.0;
    vec2 g = uv * scale;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    float h = hash21(id + float(L) * 31.7);
    // One star per cell at most, and most cells are empty; a dense field
    // reads as noise rather than as sky.
    if (h > 0.952) {
      vec2 off = (vec2(hash21(id + 5.1), hash21(id + 9.3)) - 0.5) * 0.7;
      float d = length(f - off);
      float tw = 0.62 + 0.38 * sin(uTime * (1.1 + h * 3.0) + h * 40.0);
      float core = smoothstep(0.055, 0.0, d) * tw;
      // Faintly coloured: cold white through to a pale amber.
      vec3 tint = mix(vec3(0.80, 0.88, 1.0), vec3(1.0, 0.94, 0.82), hash21(id + 17.0));
      acc += tint * core * (L == 0 ? 2.4 : 1.15);
    }
  }
  return acc * up;
}

/* ---- clouds -----------------------------------------------------------
 * Projected onto a flat deck rather than raymarched. Two decks at different
 * heights and speeds is enough parallax to sell it, and it costs four fbm
 * calls instead of forty.
 */
vec4 cloudDeck(vec3 rd, float height, float scale, float drift, float cover) {
  if (rd.y < 0.008) return vec4(0.0);
  vec2 p = rd.xz * (height / rd.y) * scale + vec2(uTime * drift, uTime * drift * 0.35);
  float n = fbm(p);
  n = n * 0.72 + fbm(p * 2.7 + 11.0) * 0.28;
  // Flat-bottomed: the alpha ramp is much harder on the underside of the
  // threshold than the top, which is what makes cumulus look like cumulus.
  float a = smoothstep(cover, cover + 0.20, n);
  // Fade the deck out toward the horizon so it does not terminate in a line.
  a *= smoothstep(0.010, 0.10, rd.y);
  return vec4(vec3(n), a);
}

void main() {
  vec3 rd = normalize(vDir);
  vec3 sun = normalize(uSunDir);
  float up = clamp(rd.y, -1.0, 1.0);
  float sunAmt = clamp(dot(rd, sun) * 0.5 + 0.5, 0.0, 1.0);

  /* ---- the vertical ramp ----
   * Five stops, matched off the reference by eye and then by eyedropper:
   * rose at the horizon, orange, gold, jade, navy. Mixed in a chain rather
   * than as a texture so the band edges can each have their own softness.
   */
  vec3 cRose   = vec3(1.00, 0.44, 0.60);
  vec3 cOrange = vec3(1.00, 0.56, 0.26);
  vec3 cGold   = vec3(1.00, 0.84, 0.40);
  vec3 cJade   = vec3(0.22, 0.82, 0.72);
  vec3 cSky    = vec3(0.07, 0.30, 0.72);
  vec3 cNavy   = vec3(0.020, 0.040, 0.175);

  float t = clamp(up, 0.0, 1.0);
  vec3 col = cGold;
  col = mix(cOrange, cGold,  smoothstep(0.010, 0.070, t));
  // The jade band is the colour nobody expects and the one that makes the
  // gradient read as painted rather than as a default sunset. It was a
  // ten-degree sliver in the first pass and effectively invisible; it wants
  // to be a band you can point at.
  col = mix(col,     cJade,  smoothstep(0.050, 0.155, t));
  col = mix(col,     cSky,   smoothstep(0.185, 0.400, t));
  col = mix(col,     cNavy,  smoothstep(0.360, 0.820, t));

  /* The warm half and the cool half.
   *
   * The reference is not radially symmetric: the side the sun is on is gold
   * and the far side is a cold magenta-violet, and that split is doing as
   * much work as the vertical ramp. Weighted by how low you are looking, so
   * the zenith stays one colour all the way round.
   */
  float low = 1.0 - smoothstep(0.0, 0.42, t);
  col = mix(col, cRose, low * (1.0 - sunAmt) * 0.62);
  col = mix(col, cGold * 1.10, low * pow(sunAmt, 2.2) * 0.75);

  /* Below the horizon: the ground haze the terrain fog fades into, so the
   * seam between the two is a colour match rather than an edge. */
  float below = smoothstep(0.0, -0.16, up);
  col = mix(col, vec3(0.95, 0.72, 0.68), below * 0.72);

  /* ---- the sun ----
   * A disc that is genuinely blown out, plus two glows: a tight one for the
   * bloom pass to catch and a very wide one that lifts the whole quadrant.
   */
  float d = max(dot(rd, sun), 0.0);
  col += cGold * pow(d, 240.0) * 26.0;
  col += vec3(1.0, 0.72, 0.44) * pow(d, 14.0) * 1.35;
  col += vec3(1.0, 0.55, 0.42) * pow(d, 3.2) * 0.30;

  /* ---- clouds ----
   * Lit from below and behind — the sun is nearly on the horizon, so their
   * undersides are the bright part and their tops are the shadow.
   */
  vec4 hi = cloudDeck(rd, 1.0, 0.55, 0.0022, 0.62);
  vec4 lo = cloudDeck(rd, 0.34, 0.95, 0.0055, 0.63);

  vec3 cloudLit = mix(vec3(0.70, 0.42, 0.62), vec3(1.0, 0.72, 0.80), 0.55);
  cloudLit = mix(cloudLit, vec3(1.0, 0.86, 0.66), pow(sunAmt, 2.0));
  vec3 cloudShade = vec3(0.40, 0.30, 0.56);

  vec3 hiCol = mix(cloudShade, cloudLit, clamp(hi.x * 1.5, 0.0, 1.0));
  vec3 loCol = mix(cloudShade * 0.9, cloudLit * 1.06, clamp(lo.x * 1.5, 0.0, 1.0));
  // Rim: cloud edges nearest the sun get a bright lip.
  hiCol += cGold * pow(sunAmt, 5.0) * hi.w * 0.55;
  loCol += cGold * pow(sunAmt, 5.0) * lo.w * 0.75;

  col = mix(col, hiCol, hi.w * 0.72);
  col = mix(col, loCol, lo.w * 0.80);

  col += stars(rd) * (1.0 - smoothstep(0.0, 0.55, sunAmt) * 0.6);

  gl_FragColor = vec4(col, 1.0);
}
`;

export interface SkyHandle {
  mesh: THREE.Mesh;
  update(time: number, camera: THREE.Camera): void;
  dispose(): void;
}

export function buildSky(): SkyHandle {
  const material = new THREE.ShaderMaterial({
    name: "EmpyreanSky",
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: SUN_DIR.clone() },
    },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });

  // Radius 1, drawn first, depth test off: it can sit inside the near plane
  // and every other object still wins.
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), material);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.name = "empyrean-sky";

  return {
    mesh,
    update(time, camera) {
      material.uniforms.uTime.value = time;
      mesh.position.copy(camera.position);
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
