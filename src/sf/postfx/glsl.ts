/**
 * GLSL building blocks shared by the pipeline's standalone passes.
 *
 * These are only for materials we own end-to-end (the internal render targets
 * of GTAO/SSR/volumetrics, the TAA resolve, the velocity buffer). Effects that
 * live inside a `postprocessing` EffectPass get `readDepth`/`getViewZ` from the
 * merged effect template instead, and must NOT declare globals of their own —
 * several effects share one fragment shader in that world, and two `const float
 * PI` declarations is a compile error that only shows up at the exact quality
 * tier where both effects happen to be enabled.
 */

/** Fullscreen-triangle vertex shader. Matches postprocessing's convention. */
export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

/**
 * Depth decode. Handles both a normal depth buffer and three's logarithmic one
 * — the game's canvas currently requests `logarithmicDepthBuffer: true`, and a
 * pipeline that assumes linear depth against a log buffer does not look
 * slightly wrong, it looks like the world is made of jelly.
 *
 * three writes `d = log2(w + 1) * FC * 0.5` with `FC = 2 / log2(far + 1)`, so
 * `w = exp2(2d / FC) - 1` recovers the clip-space w (which for a perspective
 * camera is exactly `-viewZ`).
 */
export const GLSL_DEPTH = /* glsl */ `
uniform sampler2D tDepth;
uniform float uNear;
uniform float uFar;
uniform float uLogFC;
uniform mat4 uInverseProjection;
uniform mat4 uCameraMatrixWorld;

float sfRawDepth(const in vec2 uv) {
  return texture2D(tDepth, uv).r;
}

/** Raw buffer value -> standard [0,1] window depth. */
float sfWindowDepth(const in float d) {
  if (uLogFC > 0.0) {
    float w = exp2(d / (uLogFC * 0.5)) - 1.0;
    float a = uFar / (uFar - uNear);
    float b = uFar * uNear / (uNear - uFar);
    return a + b / max(w, 1e-6);
  }
  return d;
}

/** Window depth -> view-space z (negative in front of the camera). */
float sfViewZ(const in float windowDepth) {
  float ndc = windowDepth * 2.0 - 1.0;
  return -(2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}

float sfSampleViewZ(const in vec2 uv) {
  return sfViewZ(sfWindowDepth(sfRawDepth(uv)));
}

/** True for pixels the geometry never wrote to (sky, empty space). */
bool sfIsSky(const in float windowDepth) {
  return windowDepth >= 0.99999;
}

vec3 sfViewPosition(const in vec2 uv, const in float viewZ) {
  vec4 clip = vec4(uv * 2.0 - 1.0, 0.5, 1.0);
  vec4 v = uInverseProjection * clip;
  vec3 ray = v.xyz / v.w;
  return ray * (viewZ / ray.z);
}

vec3 sfViewPositionAt(const in vec2 uv) {
  return sfViewPosition(uv, sfSampleViewZ(uv));
}

vec3 sfWorldFromView(const in vec3 viewPos) {
  return (uCameraMatrixWorld * vec4(viewPos, 1.0)).xyz;
}

vec3 sfWorldDirFromView(const in vec3 viewDir) {
  return (uCameraMatrixWorld * vec4(viewDir, 0.0)).xyz;
}
`;

/**
 * The same decode, but for shaders that live *inside* a merged EffectPass.
 *
 * `postprocessing`'s effect template already declares `depthBuffer` and a
 * `readDepth` helper — but that helper only handles logarithmic depth if the
 * material carries a `LOG_DEPTH` define, and effect defines get name-mangled
 * with a per-effect prefix on their way into the merged shader, so we can never
 * set it. Decoding ourselves is three lines and removes the dependency
 * entirely. Every uniform below is registered per-effect and therefore gets
 * prefixed, so two effects sharing one pass cannot collide.
 */
export const GLSL_EFFECT_DEPTH = /* glsl */ `
uniform float logFC;
uniform float camNear;
uniform float camFar;
uniform mat4 invProjection;
uniform mat4 camWorld;

float sfWinDepth(const in vec2 duv) {
  float d = texture2D(depthBuffer, duv).r;
  if (logFC > 0.0) {
    float w = exp2(d / (logFC * 0.5)) - 1.0;
    float a = camFar / (camFar - camNear);
    float b = camFar * camNear / (camNear - camFar);
    return a + b / max(w, 1e-6);
  }
  return d;
}

float sfVZ(const in float wd) {
  float ndc = wd * 2.0 - 1.0;
  return -(2.0 * camNear * camFar) / (camFar + camNear - ndc * (camFar - camNear));
}

/** Positive distance along the view axis, in metres. */
float sfDepthMetres(const in vec2 duv) {
  return -sfVZ(sfWinDepth(duv));
}

bool sfSkyAt(const in vec2 duv) {
  return sfWinDepth(duv) >= 0.99999;
}

vec3 sfVPos(const in vec2 duv, const in float vz) {
  vec4 c = vec4(duv * 2.0 - 1.0, 0.5, 1.0);
  vec4 v = invProjection * c;
  vec3 r = v.xyz / v.w;
  return r * (vz / r.z);
}
`;

/**
 * View-space normals reconstructed from depth.
 *
 * We deliberately do not render a normal G-buffer: a second full pass over a
 * city of a hundred thousand instanced facades to learn something the depth
 * buffer already implies is not a trade worth making. The four-tap
 * "closest neighbour" variant below picks the forward or backward difference
 * with the smaller depth delta on each axis, which keeps silhouettes crisp
 * instead of smearing a normal across a 60 m depth discontinuity.
 */
export const GLSL_NORMAL = /* glsl */ `
vec3 sfNormalFromDepth(const in vec2 uv, const in vec3 P, const in vec2 texel) {
  vec3 pL = sfViewPositionAt(uv - vec2(texel.x, 0.0));
  vec3 pR = sfViewPositionAt(uv + vec2(texel.x, 0.0));
  vec3 pD = sfViewPositionAt(uv - vec2(0.0, texel.y));
  vec3 pU = sfViewPositionAt(uv + vec2(0.0, texel.y));

  vec3 dx = abs(pR.z - P.z) < abs(P.z - pL.z) ? (pR - P) : (P - pL);
  vec3 dy = abs(pU.z - P.z) < abs(P.z - pD.z) ? (pU - P) : (P - pD);

  vec3 n = normalize(cross(dx, dy));
  // Reconstruction can flip depending on which differences were picked; the
  // normal must always face the camera.
  return dot(n, P) > 0.0 ? -n : n;
}
`;

/**
 * Noise. Interleaved gradient noise (Jimenez) is the right default for
 * temporally-accumulated sampling: it is nearly free, spatially blue-ish, and
 * rotating it by the golden ratio per frame makes the residual error average
 * out instead of beating against itself.
 */
export const GLSL_NOISE = /* glsl */ `
float sfIGN(const in vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

/** Temporally rotated IGN — feed it gl_FragCoord.xy and the frame index. */
float sfIGNT(const in vec2 p, const in float frameIndex) {
  return fract(sfIGN(p) + frameIndex * 0.6180339887498949);
}

float sfHash12(const in vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 sfHash22(const in vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float sfValueNoise3(const in vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  vec2 uv = (i.xy + vec2(37.0, 239.0) * i.z) + f.xy;
  vec2 rg = vec2(sfHash12(uv + 0.5), sfHash12(uv + vec2(37.0, 239.0) + 0.5));
  return mix(rg.x, rg.y, f.z);
}

float sfFbm3(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += sfValueNoise3(p) * a;
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}
`;

/**
 * Blue-noise dithering.
 *
 * Interleaved gradient noise is good; a real void-and-cluster tile is better
 * for the effects whose single sample per pixel is *structured* — a volumetric
 * ray offset especially, where IGN's residual diagonal pattern shows up as
 * faint corduroy inside a light shaft. Offsetting the tile value by the golden
 * ratio each frame decorrelates it temporally without ever repeating.
 */
export const GLSL_BLUE_NOISE = /* glsl */ `
uniform sampler2D tBlueNoise;
uniform vec2 uBlueNoiseTexel;

float sfBlueNoise(const in vec2 fragCoord, const in float frameIndex) {
  float v = texture2D(tBlueNoise, fragCoord * uBlueNoiseTexel).r;
  return fract(v + frameIndex * 0.6180339887498949);
}

vec2 sfBlueNoise2(const in vec2 fragCoord, const in float frameIndex) {
  vec2 v = texture2D(tBlueNoise, fragCoord * uBlueNoiseTexel).rg;
  return fract(v + frameIndex * vec2(0.7548776662466927, 0.5698402909980532));
}
`;

/**
 * A cheap analytic stand-in for the sky, used when a screen-space ray escapes
 * the frame and when volumetric fog needs an ambient term. It is fed the same
 * zenith/horizon/sun values `sky/Sky.tsx` derives, so the fallback lands on a
 * colour continuous with the sky actually on screen instead of the usual SSR
 * tell: a reflection that goes flat grey at the edge of the frame.
 */
export const GLSL_SKY = /* glsl */ `
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uGroundAlbedo;
uniform vec3 uSunDirection;
uniform vec3 uSunRadiance;

vec3 sfEnvironment(const in vec3 dir) {
  float up = clamp(dir.y, -1.0, 1.0);
  // Sky half: horizon -> zenith with a compressed falloff so the gradient sits
  // where the eye expects it rather than halfway up the dome.
  vec3 sky = mix(uSkyHorizon, uSkyZenith, pow(clamp(up, 0.0, 1.0), 0.42));
  // Ground half: albedo lit by the horizon, never black.
  vec3 ground = mix(uSkyHorizon * 0.55, uGroundAlbedo, clamp(-up * 3.0, 0.0, 1.0));
  vec3 col = mix(ground, sky, smoothstep(-0.06, 0.06, up));

  // Sun lobe. Two exponents: a tight disc and a broad aureole, which is what
  // makes a reflection of the sun in wet asphalt read as the sun.
  float mu = max(dot(dir, uSunDirection), 0.0);
  col += uSunRadiance * (pow(mu, 2200.0) * 14.0 + pow(mu, 32.0) * 0.09);
  return col;
}
`;

/** Colour-space helpers used by TAA (YCoCg clipping) and the grade. */
export const GLSL_COLOR = /* glsl */ `
float sfLuminance(const in vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 sfRGBToYCoCg(const in vec3 c) {
  return vec3(
     0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
     0.5  * c.r             - 0.5  * c.b,
    -0.25 * c.r + 0.5 * c.g - 0.25 * c.b
  );
}

vec3 sfYCoCgToRGB(const in vec3 c) {
  float t = c.x - c.z;
  return vec3(t + c.y, c.x + c.z, t - c.y);
}

/** Tonemap/inverse pair used to weight TAA history perceptually (Karis). */
vec3 sfToneWeight(const in vec3 c) { return c / (1.0 + sfLuminance(c)); }
vec3 sfUnToneWeight(const in vec3 c) { return c / max(1e-4, 1.0 - sfLuminance(c)); }
`;

/** Henyey-Greenstein phase function — the shape of forward scattering in fog. */
export const GLSL_PHASE = /* glsl */ `
float sfHenyeyGreenstein(const in float cosTheta, const in float g) {
  float g2 = g * g;
  float denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (1.0 - g2) / (12.566370614 * max(denom * sqrt(max(denom, 1e-4)), 1e-4));
}
`;

/**
 * Sampling three's directional shadow map directly. three packs shadow depth
 * into RGBA8 (`packDepthToRGBA`), and because the shadow camera is orthographic
 * the logarithmic-depth path never kicks in — the stored value is plain NDC z
 * mapped to [0,1], so a straight compare is correct.
 */
export const GLSL_SHADOW = /* glsl */ `
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowValid;

float sfUnpackDepth(const in vec4 v) {
  return dot(v, vec4(1.0 / (256.0 * 256.0 * 256.0), 1.0 / (256.0 * 256.0), 1.0 / 256.0, 1.0) * (255.0 / 256.0));
}

/** 1 = lit, 0 = shadowed. Returns 1 outside the shadow frustum. */
float sfSunVisibility(const in vec3 worldPos, const in float bias) {
  if (uShadowValid < 0.5) return 1.0;
  vec4 sc = uShadowMatrix * vec4(worldPos, 1.0);
  sc.xyz /= sc.w;
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0 || sc.z < 0.0) return 1.0;
  float d = sfUnpackDepth(texture2D(uShadowMap, sc.xy));
  return step(sc.z - bias, d);
}
`;
