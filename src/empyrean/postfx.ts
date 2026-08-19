/**
 * The final image.
 *
 * ```
 *  scene ─▶ HDR + depth ─┬─▶ AO ½ ─▶ bilateral H ─▶ bilateral V ────────┐
 *                        │                                              │
 *                        ├─▶ prefilter ¼ ─▶ ⅛ ─▶ 1/16 ─▶ 1/32 ─▶ 1/64   │
 *                        │        ▲──── tent ──┴──── tent ──┴─ tent ─┘  │
 *                        │                                              │
 *                        ├─▶ shaft source ⅛ ─▶ radial blur ⅛ ───────────┤
 *                        │                                              ▼
 *                        └──────────────────────────────────────▶ grade ─▶ screen
 * ```
 *
 * Hand-assembled rather than pulled from `EffectComposer` for the reason
 * `glasslake/postfx.ts` gives and this world needs several times over: not one
 * pass in that diagram wants to run at full resolution, and the composer's are
 * all full-size. Nine small draws beat two big ones by more than the plumbing
 * costs to write.
 *
 * `renderer.toneMapping` is left at `NoToneMapping` so the grade is the only
 * place in this world where the mapping happens, exactly once. Every buffer
 * before it is scene-linear radiance: the sky writes 26× white into the sun's
 * disc, the glass slabs and four hundred terrace lamps write well over 1, and
 * the bloom is the only thing that knows what to do about that.
 *
 * ## What changed, and the one number to know about
 *
 * **The chain now encodes sRGB.** It did not before, and could not have: a
 * `RawShaderMaterial` gets no prefix from three, so `linearToOutputTexel` is
 * not in scope and nothing was converting. Linear values were being written
 * straight into an sRGB framebuffer, which is a gamma-2.2 crush of the
 * midtones — survivable at noon, and the reason a night grade was impossible,
 * because everything below 20% went to black and stayed there.
 *
 * Fixing it would have brightened the whole world, so the fix comes with its
 * inverse: exposure drops from 0.94 to 0.62 and a post-tonemap gamma of 1.45
 * goes in behind it. Those two numbers are not taste, they are a curve fit —
 * `encode(aces(0.62·L)^1.45)` tracks the old `aces(0.94·L)` to within two
 * points across the whole range (0.10 → 0.14, 0.5 → 0.597, 2.0 → 0.89) while
 * being a correct pipeline with shadow detail in it. `setExposure` and
 * `setContrast` are the two knobs; move exposure first.
 *
 * ## What is in the chain and why
 *
 * - **SSAO, half resolution, from depth alone.** The single biggest realism
 *   win available here and the one that pays for the shadow rig's small
 *   footprint: corners, colonnades, under awnings, the line where a body meets
 *   the deck. McGuire's SAO estimator, whose `(r² − |v|²)³` falloff is what
 *   keeps it from haloing — the usual range-check AO puts a bright rim around
 *   every tower against the sky and that is far more visible than the AO. It
 *   reads the depth buffer only; there is no normal pass, normals are
 *   reconstructed from the closer of each pair of depth neighbours, which is
 *   the trick that stops silhouettes bleeding into the sky. It multiplies into
 *   *linear* radiance, before the tone map, and it is masked off anything
 *   already brighter than white so it never dims a lit window.
 * - **A real bloom chain.** Prefilter to ¼ with a Karis average (four taps
 *   weighted by 1/(1+luma) — without it one 26× sun texel becomes a flickering
 *   lozenge the size of a building), then five progressively halved mips down
 *   and a 9-tap tent back up, accumulating. A single blur at a single scale
 *   gives a hard disc with an edge; this gives the wide soft falloff that
 *   makes a sun look like a sun.
 * - **God rays.** Nearly free here, because the sky dome draws with
 *   `depthWrite: false` and therefore leaves the cleared depth of 1.0 behind
 *   it — so "is this pixel sky" is one comparison, and the occlusion mask the
 *   effect normally needs a separate render for is already in the buffer. The
 *   sun sits on the horizon behind a city of slabs for the entire signature
 *   hour, which is the exact geometry the effect exists for.
 * - **Rejected: depth of field.** The far field here is mountains capped below
 *   the deck and a sky with stars in it, and a far-field blur that catches the
 *   sky takes the stars and the jade band with it. The fog is already doing
 *   aerial perspective and doing it in colour, which is what this reference
 *   wants.
 * - **Rejected: motion blur.** Per-object velocity needs a velocity buffer and
 *   a second pass over every material in the world; camera-only motion blur on
 *   a third-person rig that lerps toward its target smears the frame every time
 *   you turn, and this world is played by turning.
 * - **Not done, worth knowing:** nothing here anti-aliases. The scene target
 *   is single-sampled, and a city of thin glass slabs against a bright sky is
 *   the worst case for it. `samples` in the options turns on MSAA where WebGL2
 *   has it, and is off by default because a half-float 4× target at devicePixel
 *   ratio 2 on a 1440p panel is most of half a gigabyte.
 */
import * as THREE from "three";

/* -------------------------------------------------------------------------
 * Shaders
 * ---------------------------------------------------------------------- */

const VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const LUMA = "const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);";

/* ---- ambient occlusion ------------------------------------------------ */

const AO = /* glsl */ `
precision highp float;
uniform sampler2D uDepth;
uniform vec2 uTexel;     // 1 / AO buffer size
uniform vec2 uClip;      // (1/m00, 1/m11) — view ray from ndc
uniform vec2 uProj;      // (m00, m11)     — world metres to ndc
uniform vec2 uNearFar;
uniform float uRadius;   // metres
uniform float uIntensity;
uniform float uRange;    // metres the packed depth spans
varying vec2 vUv;

const int SAMPLES = 12;

/** Positive distance along -z. */
float viewDist(float d) {
  return (uNearFar.x * uNearFar.y) / (uNearFar.y - d * (uNearFar.y - uNearFar.x));
}

vec3 viewPos(vec2 uv, float dist) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * uClip.x, ndc.y * uClip.y, -1.0) * dist;
}

/* 24 bits of linear depth across the G, B and A channels. The bilateral blur
 * that follows needs the depth of every tap, and re-reading and re-linearising
 * the full-res depth buffer for each one costs more than carrying it. */
vec3 packDepth(float v) {
  vec3 e = fract(vec3(1.0, 255.0, 65025.0) * v);
  e -= e.yzx * vec3(1.0 / 255.0, 1.0 / 255.0, 0.0);
  return e;
}

void main() {
  float d0 = texture2D(uDepth, vUv).x;
  if (d0 >= 0.999999) {
    // Sky. Unoccluded, and pinned to the far end so the blur will not drag
    // the horizon's occlusion out over it.
    gl_FragColor = vec4(1.0, packDepth(1.0));
    return;
  }
  float z0 = viewDist(d0);
  vec3 P = viewPos(vUv, z0);

  /* Normals from depth. Taking the *closer* of each opposed pair rather than
   * a plain central difference is what keeps a silhouette from producing a
   * normal that faces halfway into the sky behind it. */
  vec2 dx = vec2(uTexel.x, 0.0);
  vec2 dy = vec2(0.0, uTexel.y);
  float zL = viewDist(texture2D(uDepth, vUv - dx).x);
  float zR = viewDist(texture2D(uDepth, vUv + dx).x);
  float zD = viewDist(texture2D(uDepth, vUv - dy).x);
  float zU = viewDist(texture2D(uDepth, vUv + dy).x);
  vec3 hd = abs(zL - z0) < abs(zR - z0) ? (P - viewPos(vUv - dx, zL)) : (viewPos(vUv + dx, zR) - P);
  vec3 vd = abs(zD - z0) < abs(zU - z0) ? (P - viewPos(vUv - dy, zD)) : (viewPos(vUv + dy, zU) - P);
  vec3 N = normalize(cross(hd, vd));
  if (N.z < 0.0) N = -N;

  // The sampling disc, in uv. Floored at a texel and a half so it never
  // degenerates to sampling itself, capped so a body against the lens cannot
  // ask for a screen-wide gather.
  vec2 rUv = clamp(0.5 * uRadius * uProj / z0, uTexel * 1.5, vec2(0.055));

  // Interleaved gradient noise: no texture, no time, and therefore no
  // crawling — this world has no temporal filter to clean up after it.
  float rot = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;

  float r2 = uRadius * uRadius;
  float sum = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    float a = (float(i) + 0.5) / float(SAMPLES);
    float ang = a * 6.2831853 * 5.0 + rot;
    vec2 suv = vUv + vec2(cos(ang), sin(ang)) * a * rUv;
    vec3 Q = viewPos(suv, viewDist(texture2D(uDepth, suv).x));
    vec3 v = Q - P;
    float vv = dot(v, v);
    float vn = dot(v, N);
    // McGuire's falloff. Cubed, so a sample leaving the radius leaves
    // smoothly and nothing rings around a silhouette.
    float f = max(r2 - vv, 0.0);
    sum += f * f * f * max((vn - 0.02) / (vv + 0.015), 0.0);
  }
  float ao = 1.0 - sum * uIntensity * (5.0 / (float(SAMPLES) * r2 * r2 * r2));
  gl_FragColor = vec4(clamp(ao, 0.0, 1.0), packDepth(clamp(z0 / uRange, 0.0, 1.0)));
}
`;

const AO_BLUR = /* glsl */ `
precision highp float;
uniform sampler2D uAO;
uniform vec2 uStep;     // one texel along the blur axis
uniform float uRange;
varying vec2 vUv;

float unpackDepth(vec3 p) { return dot(p, vec3(1.0, 1.0 / 255.0, 1.0 / 65025.0)); }

void main() {
  vec4 c0 = texture2D(uAO, vUv);
  float z0 = unpackDepth(c0.gba) * uRange;
  // Seven binomial taps on integer texels — the buffer is point-sampled
  // because the packed depth in GBA cannot survive interpolation.
  float acc = c0.r * 0.3125;
  float wsum = 0.3125;
  for (int i = 1; i <= 3; i++) {
    float w = i == 1 ? 0.234375 : (i == 2 ? 0.09375 : 0.015625);
    for (int s = 0; s < 2; s++) {
      vec2 uv = vUv + uStep * float(i) * (s == 0 ? 1.0 : -1.0);
      vec4 c = texture2D(uAO, uv);
      float z = unpackDepth(c.gba) * uRange;
      // Tolerance grows with distance: a metre of depth difference is an edge
      // at two metres and is the same surface at four hundred.
      float k = w * max(0.0, 1.0 - abs(z - z0) / (0.6 + 0.05 * z0));
      acc += c.r * k;
      wsum += k;
    }
  }
  gl_FragColor = vec4(acc / max(wsum, 1e-4), c0.gba);
}
`;

/* ---- bloom ------------------------------------------------------------ */

const BLOOM_PREFILTER = /* glsl */ `
precision highp float;
uniform sampler2D uScene;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
${LUMA}

void main() {
  vec3 a = texture2D(uScene, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture2D(uScene, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  vec3 c = texture2D(uScene, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  vec3 d = texture2D(uScene, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  /* Karis: weight each tap by 1/(1+luma) before averaging. One 26× sun texel
   * next to three 0.4× sky texels averages to 6.7 without this, and a single
   * sub-pixel highlight becomes a lozenge that flickers as the camera moves. */
  float wa = 1.0 / (1.0 + dot(a, LUMA));
  float wb = 1.0 / (1.0 + dot(b, LUMA));
  float wc = 1.0 / (1.0 + dot(c, LUMA));
  float wd = 1.0 / (1.0 + dot(d, LUMA));
  vec3 col = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);

  float l = dot(col, LUMA);
  // Soft knee, so a lamp drifting across the threshold brightens rather than
  // switching on.
  float s = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  s = s * s / (4.0 * uKnee + 1e-5);
  gl_FragColor = vec4(col * max(s, l - uThreshold) / max(l, 1e-5), 1.0);
}
`;

const BLOOM_DOWN = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
varying vec2 vUv;
vec3 T(vec2 o) { return texture2D(uSrc, vUv + o * uTexel).rgb; }
void main() {
  // The thirteen-tap kernel from Jimenez's SIGGRAPH course: a plain box halves
  // into visible steps once you are four levels deep.
  vec3 a = T(vec2(-2.0,  2.0)); vec3 b = T(vec2(0.0,  2.0)); vec3 c = T(vec2(2.0,  2.0));
  vec3 d = T(vec2(-2.0,  0.0)); vec3 e = T(vec2(0.0,  0.0)); vec3 f = T(vec2(2.0,  0.0));
  vec3 g = T(vec2(-2.0, -2.0)); vec3 h = T(vec2(0.0, -2.0)); vec3 i = T(vec2(2.0, -2.0));
  vec3 j = T(vec2(-1.0,  1.0)); vec3 k = T(vec2(1.0,  1.0));
  vec3 l = T(vec2(-1.0, -1.0)); vec3 m = T(vec2(1.0, -1.0));
  vec3 r = e * 0.125
         + (a + c + g + i) * 0.03125
         + (b + d + f + h) * 0.0625
         + (j + k + l + m) * 0.125;
  gl_FragColor = vec4(r, 1.0);
}
`;

const BLOOM_UP = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uWeight;
varying vec2 vUv;
vec3 T(vec2 o) { return texture2D(uSrc, vUv + o * uTexel * uRadius).rgb; }
void main() {
  vec3 s = T(vec2(-1.0,  1.0)) + T(vec2(0.0,  1.0)) * 2.0 + T(vec2(1.0,  1.0))
         + T(vec2(-1.0,  0.0)) * 2.0 + T(vec2(0.0, 0.0)) * 4.0 + T(vec2(1.0, 0.0)) * 2.0
         + T(vec2(-1.0, -1.0)) + T(vec2(0.0, -1.0)) * 2.0 + T(vec2(1.0, -1.0));
  gl_FragColor = vec4(s * (uWeight / 16.0), 1.0);
}
`;

/* ---- god rays --------------------------------------------------------- */

const SHAFT_SRC = /* glsl */ `
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uDepth;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
${LUMA}
void main() {
  /* The occlusion mask, for free: the sky dome draws with depthWrite off, so
   * every sky pixel still holds the cleared 1.0 and everything else in the
   * world has written over it. Anything that is not sky blocks. */
  if (texture2D(uDepth, vUv).x < 0.999999) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec3 c = texture2D(uScene, vUv + uTexel * vec2(-1.0, -1.0)).rgb
         + texture2D(uScene, vUv + uTexel * vec2( 1.0, -1.0)).rgb
         + texture2D(uScene, vUv + uTexel * vec2(-1.0,  1.0)).rgb
         + texture2D(uScene, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  c *= 0.25;
  float l = dot(c, LUMA);
  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold * 2.5, l), 1.0);
}
`;

const SHAFT_BLUR = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSun;      // sun position, uv
uniform float uDensity;
uniform float uDecay;
varying vec2 vUv;
const int STEPS = 28;
void main() {
  vec2 delta = (uSun - vUv) * (uDensity / float(STEPS));
  vec2 uv = vUv;
  float w = 1.0;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    uv += delta;
    // Clamp-to-edge would smear the border pixel down the whole shaft; a sun
    // just off the side of the frame is exactly when that shows.
    vec2 g = step(vec2(0.0), uv) * step(uv, vec2(1.0));
    acc += texture2D(uSrc, uv).rgb * (w * g.x * g.y);
    w *= uDecay;
  }
  gl_FragColor = vec4(acc / float(STEPS), 1.0);
}
`;

/* ---- the grade -------------------------------------------------------- */

const GRADE = /* glsl */ `
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uGlow;
uniform sampler2D uAO;
uniform sampler2D uShafts;
uniform float uGlowStrength;
uniform float uAOStrength;
uniform float uShaftStrength;
uniform vec3 uShaftTint;
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform float uVignette;
uniform float uLift;
uniform float uDither;
uniform float uCA;
uniform float uNight;
uniform float uTime;
varying vec2 vUv;
${LUMA}

// ACES, Narkowicz's fit. Cheap, and it keeps the gold from going to paper
// white the moment you look near the sun — which, in this world, is often.
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 encodeSRGB(vec3 c) {
  c = max(c, 0.0);
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, c * 12.92, step(c, vec3(0.0031308)));
}

void main() {
  /* A whisper of chromatic aberration, radial, strongest at the corners.
   * At this strength you cannot see it as fringing; you see it as a lens. */
  vec2 d = vUv - 0.5;
  float r2 = dot(d, d);
  vec2 ca = d * r2 * uCA;
  vec3 col;
  col.r = texture2D(uScene, vUv + ca).r;
  col.g = texture2D(uScene, vUv).g;
  col.b = texture2D(uScene, vUv - ca).b;

  /* Occlusion, on linear radiance, before anything else touches it — and
   * masked off anything already brighter than white, so a lit window, a lamp
   * or the sun keeps every photon it wrote. The tint means an occluded corner
   * loses more red and green than blue: shadows here go violet, they do not
   * go grey. */
  float lum0 = dot(col, LUMA);
  float occ = (1.0 - texture2D(uAO, vUv).r) * uAOStrength * (1.0 - smoothstep(0.55, 2.6, lum0));
  col *= 1.0 - occ * vec3(0.88, 0.92, 0.72);

  col += texture2D(uGlow, vUv).rgb * uGlowStrength;
  col += texture2D(uShafts, vUv).rgb * uShaftTint * uShaftStrength;

  col *= uExposure;
  col = aces(col);
  // See the header: the sRGB encode at the bottom would have brightened the
  // whole world, and this is the half of the fix that puts the contrast back.
  col = pow(max(col, 0.0), vec3(uContrast));

  /* Grade: lift the shadows toward violet and pull the highlights toward
   * gold. This is the entire difference between "a sunset" and "that sunset"
   * — the reference has no neutral greys in it anywhere.
   *
   * At night the split swaps ends. The highlights are lit glass and sodium
   * and are carrying their own warmth already; pushing them further gold
   * turns a blue hour into a brown one. So the highlight tint goes neutral-
   * cool and the shadows go further toward indigo, which is what widens the
   * gap between a lamp and the dark it is standing in. */
  float luma = dot(col, LUMA);
  vec3 shadowTint = mix(vec3(0.94, 0.93, 1.10), vec3(0.84, 0.89, 1.18), uNight);
  vec3 highTint = mix(vec3(1.05, 1.00, 0.94), vec3(1.00, 0.99, 1.05), uNight);
  col = mix(col * shadowTint, col * highTint, smoothstep(0.15, 0.85, luma));

  /* And then lift the black itself off the floor, toward indigo. This is what
   * makes the zenith read as deep navy rather than as nothing: an ACES curve
   * with any contrast behind it puts the sky's own 0.026 of blue at four
   * thousandths, which is black in anybody's eyes.
   *
   * It is a small number that does a lot of work, because the sRGB encode
   * below is very steep down here — 0.0125 comes out at 28/255, and 0.045,
   * which is what this was before the encode existed to undo it, comes out at
   * 59 and turns the whole dark half of the frame milky. setShadowLift() is
   * the knob, if the navy wants to be deeper or the night wants more air. */
  vec3 liftTint = mix(vec3(0.64, 0.24, 1.0), vec3(0.36, 0.36, 1.0), uNight);
  col += liftTint * uLift * (1.0 - smoothstep(0.0, 0.35, luma));

  // Saturation lift; the ACES curve costs some on the way through, and the
  // night wants more of it back than the day does.
  col = mix(vec3(luma), col, uSaturation);

  // Vignette.
  col *= 1.0 - smoothstep(0.32, 0.95, length(d) * 1.35) * uVignette;

  col = encodeSRGB(col);

  // Dither, in display space where the eight bits actually are. A sky this
  // smooth bands without it, and at night it bands twice as visibly.
  float n = fract(sin(dot(gl_FragCoord.xy + uTime, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) * uDither;

  gl_FragColor = vec4(col, 1.0);
}
`;

/* -------------------------------------------------------------------------
 * The chain
 * ---------------------------------------------------------------------- */

export interface PostFxOptions {
  /**
   * MSAA on the HDR scene buffer. WebGL2 only, 0 to disable.
   *
   * Off by default and deliberately: a half-float 4× target at devicePixelRatio
   * 2 on a 1440p panel is roughly half a gigabyte of GPU memory, and this
   * world already asks for a lot. Turn it on if you have the headroom — the
   * glass slabs want it more than anything else in the frame does.
   */
  samples?: number;
}

export interface PostFx {
  /**
   * Render the scene through the chain and onto the screen.
   *
   * Unchanged from the previous signature but for `time` gaining a default;
   * everything else this pass now needs arrives through the setters, so
   * `world.ts` keeps working untouched — it just gets no god rays and a
   * daylight grade until it starts calling them.
   */
  render(scene: THREE.Scene, camera: THREE.Camera, time?: number): void;
  setSize(w: number, h: number): void;
  /** World-space unit vector toward the sun. Drives the god rays. */
  setSunDirection(dir: THREE.Vector3): void;
  /** 0 at night, 1 in full day. Re-tunes the whole grade. */
  setDaylight(v: number): void;
  /** Straight from `lighting.exposure`. ~0.62 by day, ~1.0 at night. */
  setExposure(v: number): void;
  /** Post-tonemap gamma. 1.45 by default; see the header before moving it. */
  setContrast(v: number): void;
  /** 0..1 multiplier on the occlusion. 0 turns SSAO off outright. */
  setAmbientOcclusion(v: number): void;
  /** 0..1 multiplier on the god rays, over and above the sun's own height. */
  setGodRays(v: number): void;
  /** Multiplier on the bloom. */
  setBloom(v: number): void;
  /** Multiplier on the violet lift under the blacks. 0 for a true black. */
  setShadowLift(v: number): void;
  dispose(): void;
}

const AO_RANGE = 3000;

export function buildPostFx(
  renderer: THREE.WebGLRenderer,
  tier: "low" | "high",
  options: PostFxOptions = {},
): PostFx {
  const high = tier === "high";
  const gl2 = renderer.capabilities.isWebGL2;
  // Without a depth texture there is no AO and no occlusion mask for the
  // shafts; the rest of the chain does not care.
  const hasDepth = gl2 || renderer.extensions.has("WEBGL_depth_texture");
  const wantAO = high && hasDepth;
  const wantShafts = hasDepth;

  renderer.toneMapping = THREE.NoToneMapping;

  /* ---- the screen quad ------------------------------------------------- */
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  // The mesh is handed a material per blit; constructing it without one makes
  // three invent a `MeshBasicMaterial` that nothing in the world would ever
  // dispose.
  const placeholder = new THREE.MeshBasicMaterial();
  const quad: THREE.Mesh<THREE.PlaneGeometry, THREE.Material> = new THREE.Mesh(quadGeo, placeholder);
  quad.frustumCulled = false;
  quadScene.add(quad);

  const size = new THREE.Vector2();
  renderer.getSize(size);
  const ratio = renderer.getPixelRatio();
  let w = Math.max(1, Math.floor(size.x * ratio));
  let h = Math.max(1, Math.floor(size.y * ratio));

  const rtOpts = {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  } as const;

  /* ---- targets --------------------------------------------------------- */
  const sceneRT = new THREE.WebGLRenderTarget(w, h, {
    ...rtOpts,
    depthBuffer: true,
  });
  if (gl2 && options.samples) sceneRT.samples = options.samples;
  if (hasDepth) {
    const depth = new THREE.DepthTexture(w, h);
    depth.type = gl2 ? THREE.UnsignedIntType : THREE.UnsignedShortType;
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    sceneRT.depthTexture = depth;
  }

  const aoDiv = 2;
  const mkAO = (linear: boolean) =>
    new THREE.WebGLRenderTarget(Math.max(1, w >> 1), Math.max(1, h >> 1), {
      type: THREE.UnsignedByteType,
      // The packed depth in GBA cannot survive interpolation, so every buffer
      // the blur reads is point sampled; only the last one, which nothing but
      // the grade touches, is allowed to be filtered.
      minFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
      magFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
  const aoRaw = wantAO ? mkAO(false) : null;
  const aoTmp = wantAO ? mkAO(false) : null;
  const aoOut = wantAO ? mkAO(true) : null;

  const LEVELS = high ? 5 : 3;
  const BLOOM_DIV = 4;
  const mips: THREE.WebGLRenderTarget[] = [];
  for (let i = 0; i < LEVELS; i++) {
    const div = BLOOM_DIV << i;
    mips.push(
      new THREE.WebGLRenderTarget(Math.max(1, Math.floor(w / div)), Math.max(1, Math.floor(h / div)), rtOpts),
    );
  }

  const SHAFT_DIV = 8;
  const shaftA = wantShafts
    ? new THREE.WebGLRenderTarget(Math.max(1, Math.floor(w / SHAFT_DIV)), Math.max(1, Math.floor(h / SHAFT_DIV)), rtOpts)
    : null;
  const shaftB = wantShafts
    ? new THREE.WebGLRenderTarget(Math.max(1, Math.floor(w / SHAFT_DIV)), Math.max(1, Math.floor(h / SHAFT_DIV)), rtOpts)
    : null;

  /* One pixel of nothing, so the grade can sample four textures whatever the
   * tier is doing. A branch per pixel to skip a texture that is not there is
   * more expensive than the texture. */
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  white.needsUpdate = true;
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  black.needsUpdate = true;

  /* ---- materials ------------------------------------------------------- */
  const mk = (name: string, frag: string, uniforms: Record<string, THREE.IUniform>) =>
    new THREE.RawShaderMaterial({
      name,
      vertexShader: VERT,
      fragmentShader: frag,
      uniforms,
      depthTest: false,
      depthWrite: false,
    });

  const aoMat = mk("EmpyreanAO", AO, {
    uDepth: { value: sceneRT.depthTexture ?? null },
    uTexel: { value: new THREE.Vector2(1, 1) },
    uClip: { value: new THREE.Vector2(1, 1) },
    uProj: { value: new THREE.Vector2(1, 1) },
    uNearFar: { value: new THREE.Vector2(0.35, 22000) },
    uRadius: { value: 1.15 },
    uIntensity: { value: 1.0 },
    uRange: { value: AO_RANGE },
  });

  const aoBlurMat = mk("EmpyreanAOBlur", AO_BLUR, {
    uAO: { value: null },
    uStep: { value: new THREE.Vector2() },
    uRange: { value: AO_RANGE },
  });

  const preMat = mk("EmpyreanBloomPrefilter", BLOOM_PREFILTER, {
    uScene: { value: sceneRT.texture },
    uTexel: { value: new THREE.Vector2() },
    // Above 1, so only things that genuinely exceed white bleed: the sun, the
    // lamps, the jets and the crowns of the towers. Set under 1 it also caught
    // the sky and the snow, and standing anywhere near a lit surface turned
    // the frame into fog.
    uThreshold: { value: 1.05 },
    uKnee: { value: 0.55 },
  });

  const downMat = mk("EmpyreanBloomDown", BLOOM_DOWN, {
    uSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
  });

  const upMat = mk("EmpyreanBloomUp", BLOOM_UP, {
    uSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uRadius: { value: 1.0 },
    // Each level hands 55% of itself to the one above. The series converges,
    // so a big soft source ends up about twice as bright as its own mip and a
    // single hot texel ends up about as bright as it started — which is the
    // difference between the sun blooming and every star blooming.
    uWeight: { value: 0.55 },
  });
  upMat.blending = THREE.AdditiveBlending;
  upMat.transparent = true;

  const shaftSrcMat = mk("EmpyreanShaftSource", SHAFT_SRC, {
    uScene: { value: sceneRT.texture },
    uDepth: { value: sceneRT.depthTexture ?? null },
    uTexel: { value: new THREE.Vector2() },
    uThreshold: { value: 1.2 },
  });

  const shaftBlurMat = mk("EmpyreanShaftBlur", SHAFT_BLUR, {
    uSrc: { value: shaftA ? shaftA.texture : null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uDensity: { value: 0.78 },
    uDecay: { value: 0.955 },
  });

  const gradeMat = mk("EmpyreanGrade", GRADE, {
    uScene: { value: sceneRT.texture },
    uGlow: { value: mips[0].texture },
    uAO: { value: aoOut ? aoOut.texture : white },
    uShafts: { value: shaftB ? shaftB.texture : black },
    uGlowStrength: { value: high ? 0.34 : 0.28 },
    uAOStrength: { value: wantAO ? 0.85 : 0 },
    uShaftStrength: { value: 0 },
    uShaftTint: { value: new THREE.Color(1.0, 0.78, 0.52) },
    uExposure: { value: 0.62 },
    uContrast: { value: 1.45 },
    uSaturation: { value: 1.24 },
    uVignette: { value: 0.42 },
    uLift: { value: 0.0125 },
    uDither: { value: 1 / 255 },
    uCA: { value: 0.010 },
    uNight: { value: 0 },
    uTime: { value: 0 },
  });

  /* ---- state ----------------------------------------------------------- */
  const sunDir = new THREE.Vector3(0, 1, 0);
  const sunClip = new THREE.Vector4();
  const sunUv = new THREE.Vector2(0.5, 0.5);
  let daylight = 1;
  let aoGain = 1;
  let rayGain = 1;
  let bloomGain = 1;
  let liftGain = 1;
  const baseGlow = high ? 0.34 : 0.28;

  const draw = (mat: THREE.Material, target: THREE.WebGLRenderTarget | null) => {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
  };

  const applyDaylight = () => {
    const night = 1 - daylight;
    gradeMat.uniforms.uNight.value = night;
    gradeMat.uniforms.uGlowStrength.value = baseGlow * (1 + night * 0.55) * bloomGain;
    gradeMat.uniforms.uSaturation.value = 1.24 + night * 0.1;
    gradeMat.uniforms.uVignette.value = 0.42 + night * 0.08;
    gradeMat.uniforms.uDither.value = (1 + night * 0.7) / 255;
    gradeMat.uniforms.uLift.value = (0.0125 - night * 0.0025) * liftGain;
    gradeMat.uniforms.uAOStrength.value = wantAO ? (0.85 - night * 0.2) * aoGain : 0;
  };
  applyDaylight();

  const setSizes = () => {
    sceneRT.setSize(w, h);
    if (aoRaw && aoTmp && aoOut) {
      const aw = Math.max(1, Math.floor(w / aoDiv));
      const ah = Math.max(1, Math.floor(h / aoDiv));
      aoRaw.setSize(aw, ah);
      aoTmp.setSize(aw, ah);
      aoOut.setSize(aw, ah);
      (aoMat.uniforms.uTexel.value as THREE.Vector2).set(1 / aw, 1 / ah);
    }
    for (let i = 0; i < LEVELS; i++) {
      const div = BLOOM_DIV << i;
      mips[i].setSize(Math.max(1, Math.floor(w / div)), Math.max(1, Math.floor(h / div)));
    }
    if (shaftA && shaftB) {
      const sw = Math.max(1, Math.floor(w / SHAFT_DIV));
      const sh = Math.max(1, Math.floor(h / SHAFT_DIV));
      shaftA.setSize(sw, sh);
      shaftB.setSize(sw, sh);
    }
    // The prefilter reads the full-res scene into a quarter-res target, so its
    // taps want to straddle the block it is standing in, not one texel of it.
    (preMat.uniforms.uTexel.value as THREE.Vector2).set(2 / w, 2 / h);
    (shaftSrcMat.uniforms.uTexel.value as THREE.Vector2).set(2 / w, 2 / h);
    // AO uniforms that depend on the depth texture identity, which setSize
    // does not change but a re-created target would.
    aoMat.uniforms.uDepth.value = sceneRT.depthTexture ?? null;
    shaftSrcMat.uniforms.uDepth.value = sceneRT.depthTexture ?? null;
  };
  setSizes();

  return {
    render(scene, camera, time = 0) {
      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;

      renderer.setRenderTarget(sceneRT);
      renderer.clear();
      renderer.render(scene, camera);

      /* ---- camera-dependent uniforms ---- */
      const e = camera.projectionMatrix.elements;
      const m00 = e[0];
      const m11 = e[5];
      const persp = camera as THREE.PerspectiveCamera;
      const near = persp.isPerspectiveCamera ? persp.near : 0.1;
      const far = persp.isPerspectiveCamera ? persp.far : 2000;

      /* ---- ambient occlusion ---- */
      if (aoRaw && aoTmp && aoOut) {
        (aoMat.uniforms.uClip.value as THREE.Vector2).set(1 / m00, 1 / m11);
        (aoMat.uniforms.uProj.value as THREE.Vector2).set(m00, m11);
        (aoMat.uniforms.uNearFar.value as THREE.Vector2).set(near, far);
        draw(aoMat, aoRaw);

        aoBlurMat.uniforms.uAO.value = aoRaw.texture;
        (aoBlurMat.uniforms.uStep.value as THREE.Vector2).set(1 / aoRaw.width, 0);
        draw(aoBlurMat, aoTmp);
        aoBlurMat.uniforms.uAO.value = aoTmp.texture;
        (aoBlurMat.uniforms.uStep.value as THREE.Vector2).set(0, 1 / aoRaw.height);
        draw(aoBlurMat, aoOut);
      }

      /* ---- bloom: prefilter, down the chain, tent back up ---- */
      draw(preMat, mips[0]);
      for (let i = 1; i < LEVELS; i++) {
        downMat.uniforms.uSrc.value = mips[i - 1].texture;
        (downMat.uniforms.uTexel.value as THREE.Vector2).set(
          1 / mips[i - 1].width,
          1 / mips[i - 1].height,
        );
        draw(downMat, mips[i]);
      }
      for (let i = LEVELS - 1; i > 0; i--) {
        upMat.uniforms.uSrc.value = mips[i].texture;
        (upMat.uniforms.uTexel.value as THREE.Vector2).set(1 / mips[i].width, 1 / mips[i].height);
        draw(upMat, mips[i - 1]);
      }

      /* ---- god rays ---- */
      let shaftStrength = 0;
      if (shaftA && shaftB) {
        // Where the sun is on screen, and whether it is on screen at all.
        sunClip
          .set(sunDir.x, sunDir.y, sunDir.z, 0)
          .applyMatrix4(camera.matrixWorldInverse)
          .applyMatrix4(camera.projectionMatrix);
        if (sunClip.w > 1e-6) {
          const nx = sunClip.x / sunClip.w;
          const ny = sunClip.y / sunClip.w;
          sunUv.set(nx * 0.5 + 0.5, ny * 0.5 + 0.5);
          // Off the side of the frame the source buffer has nothing to smear,
          // so fade rather than stop.
          const off = Math.max(Math.abs(nx), Math.abs(ny));
          const onScreen = 1 - THREE.MathUtils.smoothstep(off, 1.0, 1.9);
          /* And nothing at all once the sun is properly under the horizon.
           * The band is deliberately below zero: at the hour this world is
           * painted at the sun sits *on* the horizon, which is the single best
           * moment for shafts, and a threshold that starts at zero would have
           * switched them off exactly then. */
          const up = THREE.MathUtils.smoothstep(sunDir.y, -0.12, 0.01);
          shaftStrength = onScreen * up * rayGain * 0.85;
        }
        if (shaftStrength > 0.001) {
          draw(shaftSrcMat, shaftA);
          (shaftBlurMat.uniforms.uSun.value as THREE.Vector2).copy(sunUv);
          draw(shaftBlurMat, shaftB);
        }
      }
      gradeMat.uniforms.uShaftStrength.value = shaftStrength;

      gradeMat.uniforms.uTime.value = time;
      renderer.setRenderTarget(null);
      draw(gradeMat, null);

      renderer.autoClear = prevAutoClear;
    },

    setSize(nw, nh) {
      const r = renderer.getPixelRatio();
      w = Math.max(1, Math.floor(nw * r));
      h = Math.max(1, Math.floor(nh * r));
      setSizes();
    },

    setSunDirection(dir) {
      sunDir.copy(dir);
      if (sunDir.lengthSq() > 1e-8) sunDir.normalize();
    },

    setDaylight(v) {
      daylight = THREE.MathUtils.clamp(v, 0, 1);
      applyDaylight();
    },

    setExposure(v) {
      gradeMat.uniforms.uExposure.value = Math.max(0.01, v);
    },

    setContrast(v) {
      gradeMat.uniforms.uContrast.value = Math.max(0.2, v);
    },

    setAmbientOcclusion(v) {
      aoGain = THREE.MathUtils.clamp(v, 0, 2);
      applyDaylight();
    },

    setGodRays(v) {
      rayGain = THREE.MathUtils.clamp(v, 0, 3);
    },

    setBloom(v) {
      bloomGain = THREE.MathUtils.clamp(v, 0, 4);
      applyDaylight();
    },

    setShadowLift(v) {
      liftGain = THREE.MathUtils.clamp(v, 0, 4);
      applyDaylight();
    },

    dispose() {
      sceneRT.depthTexture?.dispose();
      sceneRT.dispose();
      aoRaw?.dispose();
      aoTmp?.dispose();
      aoOut?.dispose();
      for (const m of mips) m.dispose();
      shaftA?.dispose();
      shaftB?.dispose();
      white.dispose();
      black.dispose();
      aoMat.dispose();
      aoBlurMat.dispose();
      preMat.dispose();
      downMat.dispose();
      upMat.dispose();
      shaftSrcMat.dispose();
      shaftBlurMat.dispose();
      gradeMat.dispose();
      placeholder.dispose();
      quadGeo.dispose();
    },
  };
}
