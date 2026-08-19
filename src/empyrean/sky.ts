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
 * whether you are standing in the Bazaar or three hundred metres under the
 * island looking up through the spires.
 *
 * ## The palette is data, and that is deliberate
 *
 * The world has a clock. `skyPalette()` turns a time of day into the eleven
 * colours the shader needs, on the CPU, once a frame — so the shader stays one
 * simple gradient rather than four gradients and a blend, and so **everything
 * else in the world can ask what colour the sky is**. The fog, the lighting
 * rig, the water's analytic reflection and the glass in the towers all read
 * from here, which is the only reason they agree at every hour instead of at
 * the one hour somebody tuned them at.
 *
 * The dome writes radiance well above 1.0 near the sun. That is deliberate —
 * `postfx.ts` is the only thing in this world that tone maps, and the bloom
 * threshold wants something to find.
 */
import * as THREE from "three";

/**
 * The hour the whole place is painted at.
 *
 * 0 is midnight, 0.25 dawn, 0.5 noon, 0.75 sunset. The world starts here and
 * drifts slowly: the reference is a sunset, and a world that leaves its best
 * light ninety seconds after you arrive has thrown away the thing it was made
 * for.
 */
export const DEFAULT_DAY_PHASE = 0.75;

/** Where the sun is at a given time of day. */
export function sunDirFor(dayPhase: number, out = new THREE.Vector3()): THREE.Vector3 {
  // One rotation a day about an axis tilted toward the south-west, so the sun
  // rises left of the Beacon and sets over the shoulder of the ranges. The
  // elevation never quite reaches the zenith — a sun straight overhead flattens
  // every facade in the city at once.
  const a = (dayPhase - 0.25) * Math.PI * 2;
  const elev = Math.sin(a) * 0.78;
  const azim = -Math.PI * 0.72 + Math.cos(a) * 0.55;
  const c = Math.cos(Math.asin(THREE.MathUtils.clamp(elev, -1, 1)));
  return out.set(Math.cos(azim) * c, elev, Math.sin(azim) * c).normalize();
}

export interface SkyPalette {
  /** The five vertical stops, horizon to zenith. */
  rose: THREE.Color;
  orange: THREE.Color;
  gold: THREE.Color;
  jade: THREE.Color;
  blue: THREE.Color;
  navy: THREE.Color;
  /** Colour and strength of the disc itself. */
  sun: THREE.Color;
  sunPower: number;
  /** 0 at noon, 1 at midnight. */
  stars: number;
  cloudLit: THREE.Color;
  cloudShade: THREE.Color;
  /** What the far terrain fades into. Matched to the below-horizon haze. */
  fog: THREE.Color;
  /** 0 at midnight, 1 at noon. Everything that switches on reads this. */
  daylight: number;
}

const _pal: SkyPalette = {
  rose: new THREE.Color(),
  orange: new THREE.Color(),
  gold: new THREE.Color(),
  jade: new THREE.Color(),
  blue: new THREE.Color(),
  navy: new THREE.Color(),
  sun: new THREE.Color(),
  sunPower: 1,
  stars: 0,
  cloudLit: new THREE.Color(),
  cloudShade: new THREE.Color(),
  fog: new THREE.Color(),
  daylight: 1,
};

/** Four keyframes; everything between them is a lerp. */
const KEYS = [
  {
    // midnight
    at: 0.0,
    rose: 0x1a1230, orange: 0x140f28, gold: 0x0e1030, jade: 0x0a1436,
    blue: 0x060c28, navy: 0x02030f,
    sun: 0x9fb6ff, sunPower: 0.15, stars: 1, daylight: 0.0,
    cloudLit: 0x2a2b52, cloudShade: 0x14152c, fog: 0x1b1836,
  },
  {
    // dawn
    at: 0.25,
    rose: 0xff8fa8, orange: 0xff9d5c, gold: 0xffd39a, jade: 0x62c8c0,
    blue: 0x2a63b8, navy: 0x0b1a4a,
    sun: 0xfff0d0, sunPower: 12, stars: 0.35, daylight: 0.45,
    cloudLit: 0xffc9b8, cloudShade: 0x6a5a86, fog: 0xf3c8c0,
  },
  {
    // noon
    at: 0.5,
    rose: 0xbfe4ff, orange: 0xc9e8ff, gold: 0xdff1ff, jade: 0x8fd6f2,
    blue: 0x3f8fe0, navy: 0x1b58c0,
    sun: 0xffffff, sunPower: 30, stars: 0, daylight: 1.0,
    cloudLit: 0xffffff, cloudShade: 0xa8b6cc, fog: 0xd8ecff,
  },
  {
    // sunset — the hour the world is painted at
    at: 0.75,
    rose: 0xff7099, orange: 0xff8f42, gold: 0xffd666, jade: 0x38d1b8,
    blue: 0x124db8, navy: 0x050a2c,
    sun: 0xffd166, sunPower: 26, stars: 0.55, daylight: 0.32,
    cloudLit: 0xffb8cc, cloudShade: 0x664d8f, fog: 0xf3bfb2,
  },
];

function lerpKey(a: (typeof KEYS)[number], b: (typeof KEYS)[number], t: number): SkyPalette {
  const c = (k: "rose" | "orange" | "gold" | "jade" | "blue" | "navy" | "sun" | "cloudLit" | "cloudShade" | "fog") =>
    _pal[k].setHex(a[k]).lerp(new THREE.Color(b[k]), t);
  c("rose"); c("orange"); c("gold"); c("jade"); c("blue"); c("navy");
  c("sun"); c("cloudLit"); c("cloudShade"); c("fog");
  _pal.sunPower = THREE.MathUtils.lerp(a.sunPower, b.sunPower, t);
  _pal.stars = THREE.MathUtils.lerp(a.stars, b.stars, t);
  _pal.daylight = THREE.MathUtils.lerp(a.daylight, b.daylight, t);
  return _pal;
}

/**
 * The sky, as eleven colours and three numbers.
 *
 * Returns a **shared, mutated** object — it is read once a frame by four
 * systems and allocating a palette per frame per system is a garbage
 * collector pause you can see. Copy anything you intend to keep.
 */
export function skyPalette(dayPhase: number): SkyPalette {
  const p = ((dayPhase % 1) + 1) % 1;
  // Wrap: after sunset comes midnight again.
  const seq = [...KEYS, { ...KEYS[0], at: 1.0 }];
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = seq[i];
    const b = seq[i + 1];
    if (p >= a.at && p <= b.at) {
      const t = (p - a.at) / Math.max(b.at - a.at, 1e-6);
      // Smoothstep between keyframes, so dusk arrives rather than being ramped.
      return lerpKey(a, b, t * t * (3 - 2 * t));
    }
  }
  return lerpKey(KEYS[3], KEYS[0], 0);
}

/**
 * The sun at the world's default hour.
 *
 * Kept as a constant because several systems want a sun direction at build
 * time, before there is a clock to ask.
 */
export const SUN_DIR = sunDirFor(DEFAULT_DAY_PHASE);

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
uniform vec3 cRose, cOrange, cGold, cJade, cBlue, cNavy;
uniform vec3 cSun, cCloudLit, cCloudShade, cFog;
uniform float uSunPower;
uniform float uStars;
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
 * Only in the upper sky, and gated by the palette's own star strength — a
 * star visible through a noon sky is the tell that a gradient was faked.
 */
vec3 stars(vec3 rd) {
  if (uStars <= 0.01) return vec3(0.0);
  float up = smoothstep(0.06, 0.46, rd.y);
  if (up <= 0.0) return vec3(0.0);
  vec2 uv = rd.xz / max(rd.y, 0.35) * 3.2;
  vec3 acc = vec3(0.0);
  for (int L = 0; L < 2; L++) {
    float scale = L == 0 ? 46.0 : 88.0;
    vec2 g = uv * scale;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    float h = hash21(id + float(L) * 31.7);
    if (h > 0.952) {
      vec2 off = (vec2(hash21(id + 5.1), hash21(id + 9.3)) - 0.5) * 0.7;
      float d = length(f - off);
      float tw = 0.62 + 0.38 * sin(uTime * (1.1 + h * 3.0) + h * 40.0);
      float core = smoothstep(0.055, 0.0, d) * tw;
      vec3 tint = mix(vec3(0.80, 0.88, 1.0), vec3(1.0, 0.94, 0.82), hash21(id + 17.0));
      acc += tint * core * (L == 0 ? 2.4 : 1.15);
    }
  }
  return acc * up * uStars;
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
  a *= smoothstep(0.010, 0.10, rd.y);
  return vec4(vec3(n), a);
}

void main() {
  vec3 rd = normalize(vDir);
  vec3 sun = normalize(uSunDir);
  float up = clamp(rd.y, -1.0, 1.0);
  float sunAmt = clamp(dot(rd, sun) * 0.5 + 0.5, 0.0, 1.0);

  float t = clamp(up, 0.0, 1.0);
  vec3 col = mix(cOrange, cGold, smoothstep(0.010, 0.070, t));
  // The jade band is the colour nobody expects and the one that makes the
  // gradient read as painted rather than as a default sunset.
  col = mix(col, cJade, smoothstep(0.050, 0.155, t));
  col = mix(col, cBlue, smoothstep(0.185, 0.400, t));
  col = mix(col, cNavy, smoothstep(0.360, 0.820, t));

  /* The warm half and the cool half. The reference is not radially symmetric:
   * the side the sun is on is gold and the far side is a cold magenta-violet,
   * and that split is doing as much work as the vertical ramp. */
  float low = 1.0 - smoothstep(0.0, 0.42, t);
  col = mix(col, cRose, low * (1.0 - sunAmt) * 0.62);
  col = mix(col, cGold * 1.10, low * pow(sunAmt, 2.2) * 0.75);

  /* Below the horizon: the haze the terrain fog fades into, so the seam
   * between the two is a colour match rather than an edge. */
  float below = smoothstep(0.0, -0.16, up);
  col = mix(col, cFog, below * 0.78);

  /* The sun: a disc that is genuinely blown out, plus a tight glow for the
   * bloom pass to catch and a very wide one that lifts the whole quadrant. */
  float d = max(dot(rd, sun), 0.0);
  col += cSun * pow(d, 240.0) * uSunPower;
  col += cSun * pow(d, 14.0) * uSunPower * 0.052;
  col += cRose * pow(d, 3.2) * uSunPower * 0.012;

  /* Clouds, lit from below and behind. */
  vec4 hi = cloudDeck(rd, 1.0, 0.55, 0.0022, 0.62);
  vec4 lo = cloudDeck(rd, 0.34, 0.95, 0.0055, 0.63);

  vec3 lit = mix(cCloudShade, cCloudLit, 0.55);
  lit = mix(lit, cCloudLit * 1.1, pow(sunAmt, 2.0));

  vec3 hiCol = mix(cCloudShade, lit, clamp(hi.x * 1.5, 0.0, 1.0));
  vec3 loCol = mix(cCloudShade * 0.9, lit * 1.06, clamp(lo.x * 1.5, 0.0, 1.0));
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
  /** Repaint for a time of day. Returns the palette it used. */
  setDayPhase(dayPhase: number): SkyPalette;
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
      cRose: { value: new THREE.Color() },
      cOrange: { value: new THREE.Color() },
      cGold: { value: new THREE.Color() },
      cJade: { value: new THREE.Color() },
      cBlue: { value: new THREE.Color() },
      cNavy: { value: new THREE.Color() },
      cSun: { value: new THREE.Color() },
      cCloudLit: { value: new THREE.Color() },
      cCloudShade: { value: new THREE.Color() },
      cFog: { value: new THREE.Color() },
      uSunPower: { value: 26 },
      uStars: { value: 0.55 },
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

  const u = material.uniforms;
  const setDayPhase = (dayPhase: number) => {
    const pal = skyPalette(dayPhase);
    (u.cRose.value as THREE.Color).copy(pal.rose);
    (u.cOrange.value as THREE.Color).copy(pal.orange);
    (u.cGold.value as THREE.Color).copy(pal.gold);
    (u.cJade.value as THREE.Color).copy(pal.jade);
    (u.cBlue.value as THREE.Color).copy(pal.blue);
    (u.cNavy.value as THREE.Color).copy(pal.navy);
    (u.cSun.value as THREE.Color).copy(pal.sun);
    (u.cCloudLit.value as THREE.Color).copy(pal.cloudLit);
    (u.cCloudShade.value as THREE.Color).copy(pal.cloudShade);
    (u.cFog.value as THREE.Color).copy(pal.fog);
    u.uSunPower.value = pal.sunPower;
    u.uStars.value = pal.stars;
    sunDirFor(dayPhase, u.uSunDir.value as THREE.Vector3);
    return pal;
  };
  setDayPhase(DEFAULT_DAY_PHASE);

  return {
    mesh,
    setDayPhase,
    update(time, camera) {
      u.uTime.value = time;
      mesh.position.copy(camera.position);
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
