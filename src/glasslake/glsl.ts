/**
 * The Glass Lake — the shader library. One file, because the whole world
 * is an argument for sharing exactly this code between two materials.
 *
 * The aurora is not a texture and not a sprite: it is a function of a ray.
 * `glAurora(ro, rd, ...)` marches a handful of horizontal slabs high in the
 * atmosphere and returns what a ray leaving `ro` in direction `rd` picks up
 * on the way out. The sky dome calls it with the view ray. The ice calls it
 * with the *reflected* view ray.
 *
 * That is the trick the world is built on. A planar reflection would mean
 * rendering the scene twice into a render target, at half resolution, with
 * a flipped camera and a clip plane — the usual cost, and a mirror that is
 * blurrier than the thing it mirrors. Here the ice asks the same question
 * the sky asked, from a different point, in the same direction the light
 * would actually have come from. The reflection is exact, costs one more
 * call to a function already compiled into the frame, and stays sharp at
 * grazing angles where a render-target mirror falls apart.
 *
 * Everything here is deliberately cheap: value noise rather than simplex,
 * a fixed step count with no early-out branch, no derivatives. It runs on a
 * phone, and it runs on a software rasteriser well enough to screenshot.
 */

/** Hash / value noise / fbm. Shared by the sky, the ice and the snow. */
export const GL_NOISE = /* glsl */ `
float glHash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

float glNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  // Quintic fade — cubic leaves visible grid creases in the curtains at the
  // low frequencies the aurora is built from.
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = glHash21(i);
  float b = glHash21(i + vec2(1.0, 0.0));
  float c = glHash21(i + vec2(0.0, 1.0));
  float d = glHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float glFbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += a * glNoise(p);
    p = rot * p * 2.02;
    a *= 0.5;
  }
  return v;
}
`;

/**
 * The aurora itself.
 *
 * `uEnergy` (0..1) is how many shards have been recovered. It does three
 * things at once, because one number that changes three things reads as a
 * world responding and three numbers read as a settings panel: the curtains
 * thicken, they climb higher up the dome, and the palette walks from a cold
 * lone green toward the full green→teal→violet→rose stack.
 */
export const GL_AURORA = /* glsl */ `
// AURORA_STEPS is #defined per quality tier by glslLibrary() below — a GLSL
// ES 1.0 loop bound has to be a constant, so the tier is a different program
// rather than a uniform.
const int GL_AURORA_STEPS = AURORA_STEPS;

// Where the curtains live, in metres above the ice.
//
// These are picked from the elevation angle they produce, not from the
// atmospheric physics: the arc stands about five kilometres out, so a
// curtain from 1.4 km to 9 km up spans roughly fifteen to sixty degrees of
// sky. At the 240–1400 m they started at, the whole thing sat below the
// treeline and the mountains ate it.
const float GL_AURORA_LO = 1400.0;
const float GL_AURORA_HI = 9000.0;

vec3 glAuroraTint(float h, float energy) {
  // h is 0 at the base of the curtain, 1 at the top. Oxygen green low,
  // nitrogen violet high — the real thing, and it happens to be the ramp
  // that reads best against a blue-black sky.
  vec3 low = vec3(0.18, 1.00, 0.62);
  vec3 mid = vec3(0.20, 0.85, 0.95);
  vec3 high = mix(vec3(0.30, 0.45, 1.00), vec3(0.95, 0.35, 0.80), energy);
  vec3 c = mix(low, mid, smoothstep(0.0, 0.45, h));
  // The violet reaches further down the curtain as the shards come in, so
  // the finale changes colour rather than just level.
  return mix(c, high, smoothstep(0.35 - energy * 0.22, 1.0, h) * mix(0.35, 1.0, energy));
}

/**
 * The dither argument (0..1) offsets every sample along the ray by a
 * fraction of a step. Without it the slabs show up as concentric rings
 * wherever the curtain is dense — the classic raymarching banding, and the
 * one artifact that makes a volume look like a stack of decals. One hash of
 * the pixel coordinate turns the rings into fine noise that the glow pass
 * and the grain both hide.
 */
vec3 glAurora(vec3 ro, vec3 rd, float time, float energy, float dither) {
  // Rays heading down or along the horizon never reach the curtains. The
  // smoothstep is the horizon haze: without it the aurora ends on a hard
  // line exactly where the ice meets the sky, which looks like a bug.
  if (rd.y < 0.005) return vec3(0.0);
  float horizon = smoothstep(0.005, 0.16, rd.y);

  vec3 acc = vec3(0.0);
  // Front-to-back transmittance. Without it the march is pure emission and
  // the sum has no ceiling: wherever the curtains stacked up, everything
  // added together and came out of the tone mapper as flat white. A curtain
  // hides what is behind it, so the far side of a fold dims — which is both
  // free and the reason the folds read as fabric with a thickness.
  float trans = 1.0;
  float steps = float(GL_AURORA_STEPS);
  for (int i = 0; i < GL_AURORA_STEPS; i++) {
    float fi = (float(i) + dither) / steps;
    // Slabs are packed toward the base, where the curtain is brightest and
    // its structure is worth the samples.
    float h = mix(GL_AURORA_LO, GL_AURORA_HI, fi * fi);
    float t = (h - ro.y) / rd.y;
    if (t <= 0.0) continue;
    // Big features. The curtains want to be kilometres across so that the
    // sky reads as one weather system seen from underneath, rather than as
    // a texture with a repeat you can find.
    vec2 p = (ro.xz + rd.xz * t) * 0.00085;

    // The curtain: one slow fbm dragged sideways for the sheet, one sharp
    // ridged band across it for the vertical striations that make an aurora
    // read as folded fabric rather than fog.
    float sheet = glFbm(vec2(p.x * 0.7 + time * 0.021, p.y * 0.42 - time * 0.013));
    float fold = glFbm(vec2(p.x * 5.5 - time * 0.06, p.y * 1.1 + time * 0.02));
    // The threshold barely moves with energy. Dropping it opened curtain
    // everywhere, and a sky that is all curtain has no curtains in it — the
    // dark between the folds is what you are actually looking at.
    float band = smoothstep(0.50 - energy * 0.03, 0.78, sheet);
    // The folds are what make it fabric. Weighted hard, because a curtain
    // with an even interior is a cloud.
    band *= 0.28 + 1.35 * fold * fold;

    // The arc. A real aurora is not weather scattered evenly over the sky —
    // it is a curtain wall standing along a line, and you go outside and
    // look at it. Constraining the curtains to a band of world-Z gives that
    // wall for free: the higher slabs are reached further out, so one ray
    // crosses the wall at a slant and the thing has depth.
    //
    // It also walks toward you as the shards come in — the wall closes and
    // rears up overhead — which is the reward for finding all twelve, and
    // it is a change in the geometry of the sky rather than its brightness.
    float arcAt = mix(4.6, 2.8, energy);
    float arcWidth = mix(2.1, 2.3, energy);
    float arc = exp(-pow((p.y - arcAt) / arcWidth, 2.0));
    band *= mix(0.22, 1.0, arc);

    // Vertical shaping: fades in off the base, dies out at the top, and the
    // whole stack only climbs the sky as energy comes in.
    float reach = mix(0.62, 1.0, energy);
    float v = fi / reach;
    float shape = smoothstep(0.0, 0.22, v) * pow(max(1.0 - v, 0.0), 1.6);

    float density = band * shape;
    acc += glAuroraTint(fi, energy) * density * trans;
    trans *= exp(-density * 2.4);
  }

  // The accumulator is a sum over the steps, so it has to be normalised by
  // the step count — otherwise the low tier is a different brightness from
  // the high one, which is a quality setting you can see.
  // The scale then puts the curtains well above 1.0: this is a linear HDR
  // buffer, the aurora is the brightest thing in the world, and the glow
  // pass has nothing to find if the only light source tops out at white.
  // A quiet arc to arrive under, and a sky you cannot look away from once
  // every shard is back. Starting near the top of the range would have left
  // the twelve pickups nothing to say.
  //
  // The top of the range is deliberately close to the bottom. Tripling the
  // gain for the finale drove every curtain through the tone mapper's
  // shoulder and out the other side as flat white — the reward for finding
  // all twelve was *less* structure than the sky had at the start. What
  // grows instead is the geometry: the wall walks in, the curtains climb,
  // and the palette turns violet. All three of those survive being lit.
  float gain = mix(44.0, 60.0, energy) * horizon;
  return acc * gain / steps;
}

/** A per-pixel offset in 0..1 for the ray-march dither. */
float glDither(vec2 fragCoord) {
  return glHash21(fragCoord * 0.7371);
}

/** Stars, hashed into cells on the dome. Cheap, and they twinkle. */
vec3 glStars(vec3 rd, float time) {
  if (rd.y < 0.0) return vec3(0.0);
  vec2 uv = rd.xz / max(rd.y + 0.35, 0.001) * 1.6;
  vec2 cell = floor(uv * 22.0);
  float h = glHash21(cell);
  if (h < 0.972) return vec3(0.0);
  vec2 f = fract(uv * 22.0) - 0.5;
  float star = smoothstep(0.16, 0.0, length(f));
  float twinkle = 0.55 + 0.45 * sin(time * 2.0 + h * 90.0);
  // Blue-white to warm, so the field is not a sheet of identical dots.
  vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.9, 0.75), glHash21(cell + 7.3));
  return tint * star * twinkle * smoothstep(0.0, 0.35, rd.y) * 1.4;
}

/** The moon: a disc with a soft corona, sitting low behind the pines. */
vec3 glMoon(vec3 rd, vec3 dir) {
  float d = dot(rd, dir);
  float disc = smoothstep(0.99965, 0.99985, d);
  float corona = pow(max(d, 0.0), 1400.0) * 0.45 + pow(max(d, 0.0), 220.0) * 0.05;
  return vec3(0.85, 0.9, 1.0) * (disc * 2.4 + corona);
}
`;

/**
 * Assemble the library for a given quality tier.
 *
 * The step count is the one knob that matters: it is a loop bound, so it has
 * to be a compile-time constant in GLSL ES 1.0, which means a different
 * program per tier rather than a uniform.
 */
export function glslLibrary(auroraSteps: number): string {
  return `#define AURORA_STEPS ${Math.max(4, Math.round(auroraSteps))}\n${GL_NOISE}\n${GL_AURORA}`;
}
