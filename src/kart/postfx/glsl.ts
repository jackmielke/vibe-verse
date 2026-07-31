/**
 * GLSL building blocks shared by every pass in the kart post stack.
 *
 * These chunks are concatenated into the fragment shaders of materials we own
 * end to end. Two rules govern what may live here:
 *
 *  · **GLSL ES 1.00 only.** three compiles ShaderMaterial without a `#version`
 *    directive, so `textureLod`, `mix(vec3, vec3, bvec3)` and dynamic loop
 *    bounds are all off the table. The screenshot harness runs on SwiftShader
 *    where a shader that fails to compile silently is a black frame, not a
 *    warning.
 *  · **No uniform declared twice.** Passes include different subsets, so each
 *    chunk owns its uniforms exclusively and the pass picks the chunks it
 *    needs. `PF_DEPTH` owns the camera uniforms; nothing else declares them.
 */

/**
 * Fullscreen-triangle vertex shader.
 *
 * The triangle is oversized and clipped rather than being a quad: a quad shades
 * the diagonal seam twice, and with fifteen fullscreen passes a frame that is
 * a measurable amount of a software rasteriser's budget.
 */
export const PF_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

/**
 * Depth decode and view/world reconstruction.
 *
 * The kart renderer uses a plain (non-logarithmic) depth buffer, so the stored
 * value is straight window depth and the standard hyperbolic inverse recovers
 * view z. `uPrevViewProjection` is the previous frame's viewProjection, which
 * is all camera-motion reprojection needs: transform the pixel to world space
 * with this frame's matrices, project it with last frame's, and the difference
 * is the screen-space velocity of a *static* world point.
 */
export const PF_DEPTH = /* glsl */ `
uniform sampler2D tDepth;
uniform float uNear;
uniform float uFar;
uniform mat4 uInverseProjection;
uniform mat4 uCameraMatrixWorld;
uniform mat4 uPrevViewProjection;

float pfRawDepth(const in vec2 uv) {
  return texture2D(tDepth, uv).x;
}

/** True for texels no geometry ever wrote — the sky dome writes depth, so this
 *  is only ever the clear value, but god rays still need to know. */
bool pfIsSky(const in float rawDepth) {
  return rawDepth >= 0.999995;
}

/** Window depth -> view-space z. Negative in front of the camera. */
float pfViewZ(const in float rawDepth) {
  float ndc = rawDepth * 2.0 - 1.0;
  return -(2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}

/** Positive distance along the view axis, in metres. */
float pfDepthMetres(const in vec2 uv) {
  return -pfViewZ(pfRawDepth(uv));
}

vec3 pfViewPosition(const in vec2 uv, const in float viewZ) {
  vec4 clip = vec4(uv * 2.0 - 1.0, 0.5, 1.0);
  vec4 v = uInverseProjection * clip;
  vec3 ray = v.xyz / v.w;
  return ray * (viewZ / ray.z);
}

vec3 pfViewPositionAt(const in vec2 uv) {
  return pfViewPosition(uv, pfViewZ(pfRawDepth(uv)));
}

/**
 * Screen-space velocity of the static world under 'uv', in UV units.
 *
 * Camera-only: a kart travelling with the chase camera is *not* static, so this
 * over-estimates its motion badly. Every consumer therefore masks the near
 * field, where the player's kart lives. That mask is the difference between
 * "the world streaks past" and "my kart is made of soup".
 */
vec2 pfCameraVelocity(const in vec2 uv, const in float rawDepth) {
  vec3 viewPos = pfViewPosition(uv, pfViewZ(rawDepth));
  vec4 world = uCameraMatrixWorld * vec4(viewPos, 1.0);
  vec4 prevClip = uPrevViewProjection * world;
  if (prevClip.w <= 1e-5) return vec2(0.0);
  vec2 prevUv = prevClip.xy / prevClip.w * 0.5 + 0.5;
  return uv - prevUv;
}
`;

/** Colour-space helpers. Everything before the composite is render-linear. */
export const PF_COLOR = /* glsl */ `
float pfLuma(const in vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

float pfMaxC(const in vec3 c) {
  return max(c.r, max(c.g, c.b));
}

/**
 * NaN and negative scrub.
 *
 * One NaN anywhere in the frame — a divide by a zero-length vector in a VFX
 * shader, a degenerate normal — propagates through the whole bloom pyramid on
 * the next downsample and takes the screen with it. 'notEqual(c, c)' is the
 * only reliable NaN test in ES 1.00 and it costs three comparisons.
 */
vec3 pfSanitize(const in vec3 c) {
  vec3 safe = max(c, vec3(0.0));
  return safe * (1.0 - vec3(notEqual(c, c)));
}

vec3 pfLinearToSrgb(const in vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, step(c, vec3(0.0031308)));
}

vec3 pfSrgbToLinear(const in vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((max(c, vec3(0.0)) + 0.055) / 1.055, vec3(2.4));
  return mix(hi, lo, step(c, vec3(0.04045)));
}

/**
 * ACES RRT+ODT fit — byte for byte what three's ACESFilmicToneMapping does.
 *
 * Matching it exactly is not pedantry: the engine falls back to its own
 * tonemap whenever the post override is uninstalled, and an image that jumps
 * a third of a stop when you toggle post-processing cannot be art-directed.
 */
vec3 pfACES(vec3 color) {
  mat3 inputMat = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );
  mat3 outputMat = mat3(
     1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602
  );
  color = inputMat * (color / 0.6);
  vec3 a = color * (color + 0.0245786) - 0.000090537;
  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  return clamp(outputMat * (a / b), 0.0, 1.0);
}
`;

/**
 * YCoCg and the Karis tone weight — the two transforms temporal reprojection
 * needs. Clipping history in YCoCg rather than RGB is what lets a saturated
 * red shell move across grey tarmac without either ghosting or fizzing: luma
 * and chroma get their own tolerance instead of sharing one box.
 */
export const PF_YCOCG = /* glsl */ `
vec3 pfRGBToYCoCg(const in vec3 c) {
  return vec3(
     0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
     0.5  * c.r             - 0.5  * c.b,
    -0.25 * c.r + 0.5 * c.g - 0.25 * c.b
  );
}

vec3 pfYCoCgToRGB(const in vec3 c) {
  float t = c.x - c.z;
  return vec3(t + c.y, c.x + c.z, t - c.y);
}

/** Weight HDR samples perceptually, so one 300-nit spark cannot dominate. */
vec3 pfToneWeight(const in vec3 c) { return c / (1.0 + pfLuma(c)); }
vec3 pfUnToneWeight(const in vec3 c) { return c / max(1e-4, 1.0 - pfLuma(c)); }
`;

/**
 * Noise.
 *
 * Interleaved gradient noise for anything that jitters a tap offset (it is
 * spatially well distributed and nearly free), a plain hash for grain, and a
 * value-noise for the speed-line streaks.
 */
export const PF_NOISE = /* glsl */ `
float pfHash12(const in vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float pfIGN(const in vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

/** IGN rotated by the golden ratio per frame, so error averages out over time. */
float pfIGNT(const in vec2 p, const in float frame) {
  return fract(pfIGN(p) + frame * 0.6180339887498949);
}
`;

/**
 * Golden-angle disk, used by AO, DOF and the god-ray march.
 *
 * A spiral of `count` points at angle `i * 2.399963` and radius `sqrt(i/count)`
 * is the cheapest way to get an even, ring-free disk distribution without a
 * lookup table. Rotating the whole spiral per pixel turns the residual pattern
 * into noise, which the blur that follows removes.
 */
export const PF_DISK = /* glsl */ `
vec2 pfDisk(const in float i, const in float count, const in float rotation) {
  float a = i * 2.3999632297286533 + rotation;
  float r = sqrt((i + 0.5) / count);
  return vec2(cos(a), sin(a)) * r;
}
`;
