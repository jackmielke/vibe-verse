/**
 * The HDR pipeline, and the reason the world stopped looking like coloured
 * shapes on a coloured plane.
 *
 *     scene ─▶ HDR half-float (MSAA + depth texture)
 *               ├─▶ linear depth ─▶ SSAO ─▶ bilateral blur
 *               ├─▶ bright prefilter ─▶ 5× downsample ─▶ tent upsample = bloom
 *               └─▶ composite (AO × bloom + CA + grain + vignette + AgX + dither)
 *                     └─▶ FXAA ─▶ screen
 *
 * Every pass is hand-written rather than pulled from `examples/jsm`, for one
 * reason that matters and one that is convenience. The one that matters: these
 * passes have to *agree*. Bloom that is added after tonemapping is a white
 * smear; AO applied after is grey paint. The whole chain is linear-light up to
 * a single AgX curve at the very end, and composing the postprocessing library
 * into that order costs more than writing it.
 *
 * ## Why each of these is here
 *
 * **AgX, not Reinhard or ACES.** Three's ACESFilmic is what the world shipped
 * with, and on a red desert under a K-class star it drives every bright pixel
 * to orange and then to white — the whole planet clips to the same colour. AgX
 * desaturates as it approaches white instead of hue-shifting, which is exactly
 * the failure mode of a world whose palette is eleven differently-coloured
 * suns.
 *
 * **Bloom is prefiltered and dual-filtered, not a blur.** A gaussian on the
 * whole frame is a haze. Thresholding with a soft knee, downsampling five
 * times with a 13-tap that kills fireflies, then tent-upsampling back gives a
 * response that falls off over a genuinely wide radius while staying tight at
 * the core — which is what makes a nacelle read as *emitting* rather than as
 * being painted a pale blue.
 *
 * **AO is reconstructed from depth alone.** No normal buffer, no second
 * geometry pass: the normal comes from the depth derivative, which is free and
 * good enough for a term that is then blurred. It is the cheapest way to buy
 * the thing that actually says "this object is sitting on that ground".
 *
 * **Grain and chromatic aberration are small on purpose.** Both are at the
 * level where turning them off is noticeable and turning them up is a
 * screensaver. The grain is doing real work: it dithers the gradients in the
 * sky and the planet's terminator, which would otherwise band visibly on an
 * 8-bit display.
 *
 * ## Cost
 *
 * At `ultra` this is roughly nine full-screen passes, most of them at half or
 * quarter resolution. `low` drops AO, halves the bloom chain and skips FXAA,
 * and is what a phone gets — see `configure`.
 */
import * as THREE from "three";
import type { Quality } from "../types";

const QUAD = new THREE.PlaneGeometry(2, 2);

const VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/* --- linear depth ---------------------------------------------------------- */

const LINEARIZE = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDepth;
uniform float uNear, uFar;
void main(){
  float d = texture2D(tDepth, vUv).r;
  // Zero means "nothing here" — sky, and the far plane. Everything downstream
  // treats it as unoccluded rather than as infinitely close, which is the
  // difference between a haloed horizon and a clean one.
  if (d >= 1.0) { gl_FragColor = vec4(0.0); return; }
  float z = d * 2.0 - 1.0;
  float linear = (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
  gl_FragColor = vec4(linear, 0.0, 0.0, 1.0);
}
`;

/* --- SSAO ------------------------------------------------------------------ */

const AO = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDepth;      // linear view depth, 0 = sky
uniform vec2 uTexel;
uniform float uRadius, uBias, uIntensity, uAspect, uTanHalfFov;
uniform float uTime;

/* Reconstruct the view-space position of a pixel from its linear depth. The
   camera's tan(fov/2) and aspect are all that is needed, and doing it this way
   means the estimator is scale-free — the same code is correct for a scene
   measured in metres and one measured in kilometres. */
vec3 viewPos(vec2 uv, float z){
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * uAspect * uTanHalfFov * z, ndc.y * uTanHalfFov * z, -z);
}

void main(){
  float z = texture2D(tDepth, vUv).r;
  if (z <= 0.0) { gl_FragColor = vec4(1.0); return; }

  vec3 P = viewPos(vUv, z);

  // Normal from the depth derivative, picking the smaller of the forward and
  // backward difference on each axis so a silhouette edge does not produce a
  // normal that points along the screen.
  float zl = texture2D(tDepth, vUv - vec2(uTexel.x, 0.0)).r;
  float zr = texture2D(tDepth, vUv + vec2(uTexel.x, 0.0)).r;
  float zd = texture2D(tDepth, vUv - vec2(0.0, uTexel.y)).r;
  float zu = texture2D(tDepth, vUv + vec2(0.0, uTexel.y)).r;
  vec3 dx = abs(zr - z) < abs(z - zl)
    ? viewPos(vUv + vec2(uTexel.x, 0.0), zr) - P
    : P - viewPos(vUv - vec2(uTexel.x, 0.0), zl);
  vec3 dy = abs(zu - z) < abs(z - zd)
    ? viewPos(vUv + vec2(0.0, uTexel.y), zu) - P
    : P - viewPos(vUv - vec2(0.0, uTexel.y), zd);
  vec3 N = normalize(cross(dx, dy));

  // Interleaved-gradient noise: a per-pixel rotation that costs three ALU and
  // decorrelates the spiral so the blur has something to average.
  float rnd = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));

  // The radius is in world units but the *sample* pattern is in screen space,
  // so it has to shrink with distance or a far object samples the whole frame.
  float rPix = uRadius / max(z * uTanHalfFov, 0.0001);
  rPix = clamp(rPix, 2.0 * uTexel.y, 0.12);

  float occ = 0.0;
  const int N_SAMPLES = 12;
  for (int i = 0; i < N_SAMPLES; i++) {
    float fi = float(i) + rnd;
    float ang = fi * 2.39996323;               // golden angle
    float rad = sqrt(fi / float(N_SAMPLES)) * rPix;
    vec2 off = vec2(cos(ang), sin(ang)) * rad * vec2(1.0, uAspect);
    vec2 suv = vUv + off;
    float sz = texture2D(tDepth, suv).r;
    if (sz <= 0.0) continue;
    vec3 S = viewPos(suv, sz) - P;
    float len = length(S);
    float ndotS = dot(N, S / max(len, 0.0001));
    // Range check: a sample far in front of this pixel is a different surface,
    // not an occluder, and without this every silhouette grows a dark halo.
    float range = smoothstep(0.0, 1.0, uRadius / max(len, 0.0001));
    occ += max(0.0, ndotS - uBias) * range;
  }
  occ = occ / float(N_SAMPLES);
  gl_FragColor = vec4(clamp(1.0 - occ * uIntensity, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

/* Bilateral blur — separable, depth-aware, so the AO term does not bleed
   across a silhouette and darken the sky behind a pillar. */
const AO_BLUR = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tAO, tDepth;
uniform vec2 uDir;
void main(){
  float z0 = texture2D(tDepth, vUv).r;
  if (z0 <= 0.0) { gl_FragColor = vec4(1.0); return; }
  float sum = 0.0, wsum = 0.0;
  for (int i = -4; i <= 4; i++) {
    float fi = float(i);
    vec2 uv = vUv + uDir * fi;
    float z = texture2D(tDepth, uv).r;
    float wz = exp(-abs(z - z0) / max(z0 * 0.04, 0.0001));
    float wg = exp(-fi * fi / 8.0);
    float w = wz * wg;
    sum += texture2D(tAO, uv).r * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum / max(wsum, 0.0001), 0.0, 0.0, 1.0);
}
`;

/* --- bloom ----------------------------------------------------------------- */

const PREFILTER = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold, uKnee;
vec3 tap(vec2 uv){ return texture2D(tSrc, uv).rgb; }
void main(){
  // 4-tap box first: one bright pixel surviving the threshold alone flickers
  // as it crosses a subpixel boundary, and that flicker is amplified by every
  // downsample below it.
  vec3 c = (tap(vUv + uTexel * vec2(-1.0, -1.0)) + tap(vUv + uTexel * vec2(1.0, -1.0))
          + tap(vUv + uTexel * vec2(-1.0,  1.0)) + tap(vUv + uTexel * vec2(1.0,  1.0))) * 0.25;
  float br = max(c.r, max(c.g, c.b));
  // Soft knee: a hard threshold makes the bloom's edge visible as a contour
  // line across a smooth gradient like a planet's terminator.
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 0.0001);
  float w = max(soft, br - uThreshold) / max(br, 0.0001);
  gl_FragColor = vec4(c * w, 1.0);
}
`;

const DOWNSAMPLE = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
vec3 tap(vec2 o){ return texture2D(tSrc, vUv + o * uTexel).rgb; }
void main(){
  // Jimenez's 13-tap: five overlapping boxes, weighted so the chain stays
  // stable over five halvings. A naive bilinear halving pulses.
  vec3 a = tap(vec2(-2.0,  2.0)), b = tap(vec2(0.0,  2.0)), c = tap(vec2(2.0,  2.0));
  vec3 d = tap(vec2(-2.0,  0.0)), e = tap(vec2(0.0,  0.0)), f = tap(vec2(2.0,  0.0));
  vec3 g = tap(vec2(-2.0, -2.0)), h = tap(vec2(0.0, -2.0)), i = tap(vec2(2.0, -2.0));
  vec3 j = tap(vec2(-1.0,  1.0)), k = tap(vec2(1.0,  1.0));
  vec3 l = tap(vec2(-1.0, -1.0)), m = tap(vec2(1.0, -1.0));
  vec3 o = e * 0.125;
  o += (a + c + g + i) * 0.03125;
  o += (b + d + f + h) * 0.0625;
  o += (j + k + l + m) * 0.125;
  gl_FragColor = vec4(o, 1.0);
}
`;

/* 3x3 tent, drawn with additive blending straight onto the level below.
 *
 * The first version sampled the destination as a second texture and added it
 * in the shader — which is a read and a write of the same attachment in one
 * pass, and undefined. In practice it fed back: every level accumulated its
 * own previous contents and the whole chain ran away, which showed up as
 * every planet in the game rendering as a white disc. Additive blending is
 * both correct and one texture fetch cheaper. */
const UPSAMPLE = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;
vec3 tap(vec2 o){ return texture2D(tSrc, vUv + o * uTexel * uRadius).rgb; }
void main(){
  vec3 s = tap(vec2(-1.0,  1.0)) + tap(vec2(0.0,  1.0)) * 2.0 + tap(vec2(1.0,  1.0));
  s += tap(vec2(-1.0, 0.0)) * 2.0 + tap(vec2(0.0, 0.0)) * 4.0 + tap(vec2(1.0, 0.0)) * 2.0;
  s += tap(vec2(-1.0, -1.0)) + tap(vec2(0.0, -1.0)) * 2.0 + tap(vec2(1.0, -1.0));
  gl_FragColor = vec4(s / 16.0, 1.0);
}
`;

/* --- composite ------------------------------------------------------------- */

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc, tBloom, tAO, tDepth;
uniform float uExposure, uBloom, uAO, uCA, uGrain, uVignette, uTime, uWarp;
uniform vec2 uTexel;

/* Atmospherics, done here rather than per-material.
 *
 * three's FogExp2 is a distance lerp toward one colour, evaluated in every
 * material that opts into it. That gets you haze and nothing else: no height
 * falloff, so the air is as thick at the top of a mountain as at its foot; and
 * no inscattering, so looking straight into the star through forty kilometres
 * of atmosphere looks exactly like looking away from it.
 *
 * The depth buffer is already here for the occlusion pass, so all three of the
 * things that make distance read can be done once, for every surface in the
 * frame, in the pass that is already running:
 *
 *   **Height falloff.** Density decays exponentially with altitude, which is
 *   what air does. It is the difference between distant hills sitting *in* the
 *   landscape and being painted over it.
 *
 *   **Inscattering.** The haze is not one colour — it takes the star's colour
 *   in the direction of the star, on a Henyey-Greenstein lobe. Looking toward
 *   a low sun through dust is the strongest depth cue a desert has, and it is
 *   free once the depth is in hand.
 *
 *   **Sky agreement.** Fog tends to the horizon colour, so the far terrain
 *   dissolves into the sky it meets instead of into a differently coloured
 *   wall. Pixels with no geometry are skipped entirely, so the sky dome and
 *   the stars come through untouched.
 */
uniform vec3 uFogColor, uSunColorV, uSunDirV, uViewUp;
uniform float uFogDensity, uFogHeight, uCamY, uInscatter, uAspectF, uTanHalfF;

vec3 viewPosF(vec2 uv, float z){
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * uAspectF * uTanHalfF * z, ndc.y * uTanHalfF * z, -z);
}

/* AgX, in full.
 *
 * Four matrices, not two. The short "minimal AgX" that does Rec.709 in and out
 * is what this shipped with first, and it is visibly wrong on saturated light:
 * Qo'noS under a K-class star came out cream instead of olive, because an
 * inset without the Rec.2020 transfer desaturates the wrong axis. Widening the
 * gamut to Rec.2020 *before* the log encode and bringing it back after is the
 * entire mechanism by which AgX desaturates toward white instead of rotating
 * hue — which is the only reason to prefer it to ACES here.
 *
 * The curve returns linear-light sRGB, so the composite encodes it at the end:
 * a ShaderMaterial writes gl_FragColor raw and three applies no output
 * conversion to it. */
const mat3 LIN_SRGB_TO_LIN_REC2020 = mat3(
  0.6274040, 0.0690970, 0.0163916,
  0.3292820, 0.9195400, 0.0880132,
  0.0433136, 0.0113612, 0.8955950);
const mat3 LIN_REC2020_TO_LIN_SRGB = mat3(
   1.6605000, -0.1245470, -0.0181626,
  -0.5876410,  1.1329000, -0.1005670,
  -0.0728499, -0.0083280,  1.1187300);
/* Column-major, as GLSL reads them. The canonical AgX matrices are published
   as rows that sum to one; written straight down the page they end up
   transposed, which mixes the wrong channels by a few percent. */
const mat3 AGX_INSET = mat3(
  0.8566271533, 0.1373189729, 0.1118982130,
  0.0951212405, 0.7612419906, 0.0767994186,
  0.0482516061, 0.1014390365, 0.8113023684);
const mat3 AGX_OUTSET = mat3(
   1.1271005818, -0.1413297635, -0.1413297635,
  -0.1106066431,  1.1578237022, -0.1106066431,
  -0.0164939387, -0.0164939387,  1.2519364066);

const float AGX_MIN_EV = -12.47393;
const float AGX_MAX_EV = 4.026069;

vec3 agxContrast(vec3 x){
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return  15.5 * x4 * x2
        - 40.14 * x4 * x
        + 31.96 * x4
        - 6.868 * x2 * x
        + 0.4298 * x2
        + 0.1191 * x
        - 0.00232;
}

/* The look.
 *
 * Base AgX is deliberately, famously flat — it is a *neutral* transform, and
 * nobody ships it neutral. Blender pairs it with a look, and this world needs
 * one badly: without it a cloud deck at linear (0.82, 0.67, 0.28) comes out of
 * the curve at sRGB (194, 185, 153), because the log encode compresses a 3:1
 * channel ratio into 0.05 of normalised range. That is not a bug in AgX and it
 * is not over-exposure — every planet in the game simply rendered as pale
 * cream, and no amount of turning the exposure down brought the colour back.
 *
 * The look is applied on the sigmoid's own output, in its own space, which is
 * where a slope/offset/power/saturation trim is actually defined. Doing the
 * same job with a saturation multiply in linear light afterwards is what the
 * first attempt did, and it re-introduces exactly the hue rotation AgX exists
 * to prevent.
 *
 * These numbers are Blender's "Punchy" with the power backed off a little:
 * a starfield needs its blacks to stay black. */
vec3 agxLook(vec3 val){
  const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
  float luma = dot(val, LW);
  const float slope = 1.0;
  const float power = 1.15;
  const float sat   = 1.45;
  val = pow(max(val * slope, 0.0), vec3(power));
  return luma + sat * (val - luma);
}

/** Linear-light sRGB in, linear-light sRGB out. */
vec3 agx(vec3 col){
  col = max(col, 0.0);
  col = LIN_SRGB_TO_LIN_REC2020 * col;
  col = AGX_INSET * col;
  col = max(col, 1e-10);
  col = clamp((log2(col) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0.0, 1.0);
  col = agxContrast(col);
  col = agxLook(col);
  col = AGX_OUTSET * col;
  // The curve's own output is display-encoded; undo that to get back to light.
  col = pow(max(col, 0.0), vec3(2.2));
  col = LIN_REC2020_TO_LIN_SRGB * col;
  return max(col, 0.0);
}

/** The sRGB transfer function. Nothing downstream of this applies it. */
vec3 encodeSRGB(vec3 c){
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main(){
  vec2 d = vUv - 0.5;
  float r2 = dot(d, d);

  // Chromatic aberration, radial and scaled by r² so the centre of the frame
  // is untouched. Warp pushes it hard — the only place it is allowed to be
  // visible as an effect rather than as a lens.
  float ca = (uCA + uWarp * 0.010) * r2;
  vec3 col;
  if (ca > 0.00001) {
    col.r = texture2D(tSrc, vUv - d * ca).r;
    col.g = texture2D(tSrc, vUv).g;
    col.b = texture2D(tSrc, vUv + d * ca).b;
  } else {
    col = texture2D(tSrc, vUv).rgb;
  }

  // Radial blur at warp: eight taps along the ray from centre. Cheap, and it
  // is the difference between "the stars are streaks" and "the ship is moving".
  if (uWarp > 0.01) {
    vec3 acc = col;
    for (int i = 1; i <= 6; i++) {
      float t = float(i) / 6.0 * uWarp * 0.10;
      acc += texture2D(tSrc, vUv - d * t).rgb;
    }
    col = acc / 7.0;
  }

  float ao = mix(1.0, texture2D(tAO, vUv).r, uAO);
  col *= ao;

  if (uFogDensity > 0.0) {
    float z = texture2D(tDepth, vUv).r;
    // Zero means sky. Fogging the sky toward the fog colour would flatten the
    // whole dome into one value and take the stars with it.
    if (z > 0.0) {
      vec3 P = viewPosF(vUv, z);
      float dist = length(P);
      // Altitude of this fragment, from the camera's own height plus however
      // far up the view-space "up" axis it sits.
      float worldY = uCamY + dot(P, uViewUp);
      float hFall = exp(-max(worldY, -20.0) / uFogHeight);
      float camFall = exp(-max(uCamY, -20.0) / uFogHeight);
      // Average the density along the ray rather than sampling it at one end,
      // or looking down from a ridge fogs the valley by the ridge's thin air.
      float density = uFogDensity * (hFall + camFall) * 0.5;
      float f = 1.0 - exp(-density * dist);

      // Henyey-Greenstein, g = 0.72: a tight forward lobe, which is what dust
      // and water droplets actually do.
      vec3 ray = normalize(P);
      float mu = dot(ray, uSunDirV);
      const float g = 0.72;
      float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) * 0.079577;
      vec3 haze = mix(uFogColor, uSunColorV, clamp(hg * uInscatter, 0.0, 0.85));

      col = mix(col, haze, clamp(f, 0.0, 1.0));
    }
  }
  col += texture2D(tBloom, vUv).rgb * uBloom;
  col *= uExposure;

  col = agx(col);

  // Vignette before the encode, so it behaves like less light rather than like
  // a grey overlay.
  col *= mix(1.0, smoothstep(0.98, 0.18, r2), uVignette);

  col = encodeSRGB(col);

  // Grain. Small, and it is doing real work: an 8-bit framebuffer bands
  // visibly across a planet's terminator and this dithers it away.
  float n = fract(sin(dot(vUv * 1024.0 + uTime, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) * uGrain;

  // Ordered dither, a quarter of an 8-bit step, for the same reason.
  float dz = fract(dot(gl_FragCoord.xy, vec2(0.75487, 0.56984)));
  col += (dz - 0.5) / 1024.0;

  gl_FragColor = vec4(col, 1.0);
}
`;

/* --- FXAA ------------------------------------------------------------------ */

const FXAA_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec3 mid = texture2D(tSrc, vUv).rgb;
  float lM = luma(mid);
  float lNW = luma(texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb);
  float lNE = luma(texture2D(tSrc, vUv + vec2( 1.0, -1.0) * uTexel).rgb);
  float lSW = luma(texture2D(tSrc, vUv + vec2(-1.0,  1.0) * uTexel).rgb);
  float lSE = luma(texture2D(tSrc, vUv + vec2( 1.0,  1.0) * uTexel).rgb);

  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.0312, lMax * 0.125)) { gl_FragColor = vec4(mid, 1.0); return; }

  vec2 dir = vec2(
    -((lNW + lNE) - (lSW + lSE)),
     ((lNW + lSW) - (lNE + lSE)));
  float scale = 1.0 / (min(abs(dir.x), abs(dir.y)) + max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125));
  dir = clamp(dir * scale, -8.0, 8.0) * uTexel;

  vec3 a = 0.5 * (texture2D(tSrc, vUv + dir * (1.0 / 3.0 - 0.5)).rgb
                + texture2D(tSrc, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture2D(tSrc, vUv + dir * -0.5).rgb
                           + texture2D(tSrc, vUv + dir *  0.5).rgb);
  float lB = luma(b);
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? a : b, 1.0);
}
`;

/* -------------------------------------------------------------------------- */

/** Debug views. `0` is the finished frame; the rest show one buffer raw. */
export type PostDebug = 0 | 1 | 2 | 3;

/** Aerial perspective. Absent means no atmosphere — which is right in orbit. */
export interface Atmosphere {
  color: THREE.Color | number;
  /** Per metre. 0.0015 is a clear day; 0.006 is Ferenginar. */
  density: number;
  /** Scale height in metres. Small values hug the ground. */
  height: number;
  /** Unit vector toward the star, world space. */
  sunDir: THREE.Vector3;
  sunColor: THREE.Color | number;
  /** How much the haze takes the star's colour on the forward lobe. */
  inscatter?: number;
}

export interface PostOptions {
  /** 1 = ambient occlusion, 2 = bloom, 3 = linear depth. */
  debug?: PostDebug;
  atmosphere?: Atmosphere | null;
  /** 0-1, drives radial blur and chromatic aberration during a jump. */
  warp?: number;
  /** Scene-wide exposure multiplier, applied before the tone curve. */
  exposure?: number;
  /** Turn AO off for the space scene, where nothing occludes anything. */
  ao?: boolean;
}

export interface Post {
  /** Which quality tier was chosen. */
  readonly quality: Quality;
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, opts?: PostOptions): void;
  setSize(w: number, h: number): void;
  /** False when the pipeline could not be built — the caller draws direct. */
  readonly ok: boolean;
  dispose(): void;
}

interface Tier {
  msaa: number;
  ao: boolean;
  aoScale: number;
  bloomLevels: number;
  fxaa: boolean;
  bloomScale: number;
}

/* No MSAA on any tier.
 *
 * A multisampled render target with a *depth texture* attachment does not
 * reliably resolve its depth on WebGL2 — the colour blits, the depth does not,
 * and the occlusion pass reads an empty buffer and returns 1.0 everywhere. It
 * fails completely silently: the frame looks fine, it is simply missing the
 * one term that grounds every object in it. FXAA is already doing the edge
 * work at the end of the chain, so this costs an edge quality nobody can see
 * and buys back the pass that matters. */
const TIERS: Record<Quality, Tier> = {
  low: { msaa: 0, ao: false, aoScale: 0.5, bloomLevels: 3, fxaa: false, bloomScale: 0.5 },
  medium: { msaa: 0, ao: true, aoScale: 0.5, bloomLevels: 4, fxaa: true, bloomScale: 0.5 },
  high: { msaa: 0, ao: true, aoScale: 0.75, bloomLevels: 5, fxaa: true, bloomScale: 0.5 },
  ultra: { msaa: 0, ao: true, aoScale: 1.0, bloomLevels: 6, fxaa: true, bloomScale: 0.5 },
};

export function createPost(renderer: THREE.WebGLRenderer, quality: Quality): Post {
  const tier = TIERS[quality] ?? TIERS.high;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const scene = new THREE.Scene();
  const whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const quad = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(QUAD, whiteMat);
  quad.frustumCulled = false;
  scene.add(quad);

  const owned: { dispose(): void }[] = [whiteMat];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x);
    return x;
  };

  let W = 1;
  let H = 1;

  function rt(w: number, h: number, opts: THREE.RenderTargetOptions = {}): THREE.WebGLRenderTarget {
    return keep(
      new THREE.WebGLRenderTarget(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        ...opts,
      }),
    );
  }

  const mat = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
    keep(new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false }));

  /* --- targets --- */
  const depthTex = keep(new THREE.DepthTexture(1, 1));
  depthTex.type = THREE.UnsignedIntType;
  depthTex.minFilter = THREE.NearestFilter;
  depthTex.magFilter = THREE.NearestFilter;

  const hdr = rt(1, 1, { depthBuffer: true, depthTexture: depthTex, samples: tier.msaa });
  const lin = rt(1, 1, { type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const aoA = rt(1, 1, { format: THREE.RedFormat });
  const aoB = rt(1, 1, { format: THREE.RedFormat });
  const white = rt(1, 1, { format: THREE.RedFormat });
  const ldr = rt(1, 1, { type: THREE.UnsignedByteType });
  const chain: THREE.WebGLRenderTarget[] = [];
  for (let i = 0; i < tier.bloomLevels; i++) chain.push(rt(1, 1));

  /* --- materials --- */
  const mLin = mat(LINEARIZE, {
    tDepth: { value: depthTex },
    uNear: { value: 0.1 },
    uFar: { value: 1000 },
  });
  const mAO = mat(AO, {
    tDepth: { value: lin.texture },
    uTexel: { value: new THREE.Vector2() },
    uRadius: { value: 1.4 },
    uBias: { value: 0.025 },
    uIntensity: { value: 2.8 },
    uAspect: { value: 1 },
    uTanHalfFov: { value: 0.5 },
    uTime: { value: 0 },
  });
  const mBlur = mat(AO_BLUR, {
    tAO: { value: null },
    tDepth: { value: lin.texture },
    uDir: { value: new THREE.Vector2() },
  });
  const mPre = mat(PREFILTER, {
    tSrc: { value: hdr.texture },
    uTexel: { value: new THREE.Vector2() },
    uThreshold: { value: 1.0 },
    uKnee: { value: 0.55 },
  });
  const mDown = mat(DOWNSAMPLE, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const mUp = mat(UPSAMPLE, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uRadius: { value: 1.0 },
  });
  mUp.blending = THREE.AdditiveBlending;
  mUp.transparent = true;
  const mComp = mat(COMPOSITE_FRAG, {
    tSrc: { value: hdr.texture },
    tBloom: { value: chain[0].texture },
    tAO: { value: white.texture },
    uExposure: { value: 1.0 },
    uBloom: { value: 0.045 },
    uAO: { value: 0.85 },
    uCA: { value: 0.0022 },
    uGrain: { value: 0.016 },
    uVignette: { value: 0.5 },
    uTime: { value: 0 },
    uWarp: { value: 0 },
    uTexel: { value: new THREE.Vector2() },
    tDepth: { value: lin.texture },
    uFogColor: { value: new THREE.Color(0x808080) },
    uSunColorV: { value: new THREE.Color(0xffffff) },
    uSunDirV: { value: new THREE.Vector3(0, 1, 0) },
    uViewUp: { value: new THREE.Vector3(0, 1, 0) },
    uFogDensity: { value: 0 },
    uFogHeight: { value: 120 },
    uCamY: { value: 0 },
    uInscatter: { value: 1 },
    uAspectF: { value: 1 },
    uTanHalfF: { value: 0.5 },
  });
  const mDebug = mat(
    `precision highp float; varying vec2 vUv; uniform sampler2D tSrc; uniform float uScale;
     void main(){ vec3 c = texture2D(tSrc, vUv).rgb * uScale; gl_FragColor = vec4(pow(clamp(c,0.0,1.0), vec3(1.0/2.2)), 1.0); }`,
    { tSrc: { value: null }, uScale: { value: 1 } },
  );
  const mFxaa = mat(FXAA_FRAG, { tSrc: { value: ldr.texture }, uTexel: { value: new THREE.Vector2() } });

  let ok = true;
  let t = 0;

  /** Draw the quad with `m` into `target`. `add` leaves what is already there
   *  alone, which is what the additive upsample needs. */
  function blit(m: THREE.Material, target: THREE.WebGLRenderTarget | null, add = false): void {
    quad.material = m;
    renderer.setRenderTarget(target);
    renderer.autoClear = !add;
    if (!add) renderer.clear(true, false, false);
    renderer.render(scene, cam);
    renderer.autoClear = true;
  }

  function setSize(w: number, h: number): void {
    W = Math.max(1, Math.round(w));
    H = Math.max(1, Math.round(h));
    hdr.setSize(W, H);
    ldr.setSize(W, H);
    const aw = Math.max(1, Math.round(W * tier.aoScale));
    const ah = Math.max(1, Math.round(H * tier.aoScale));
    lin.setSize(aw, ah);
    aoA.setSize(aw, ah);
    aoB.setSize(aw, ah);
    white.setSize(1, 1);
    for (let i = 0; i < chain.length; i++) {
      const s = Math.pow(0.5, i + 1) * (tier.bloomScale * 2);
      chain[i].setSize(Math.max(1, Math.round(W * s)), Math.max(1, Math.round(H * s)));
    }
    (mAO.uniforms.uTexel.value as THREE.Vector2).set(1 / aw, 1 / ah);
    (mComp.uniforms.uTexel.value as THREE.Vector2).set(1 / W, 1 / H);
    (mFxaa.uniforms.uTexel.value as THREE.Vector2).set(1 / W, 1 / H);

    // The AO term for a frame where AO is off. One white texel, sampled
    // everywhere — cheaper and simpler than a shader variant.
    const prev = renderer.getRenderTarget();
    quad.material = whiteMat;
    renderer.setRenderTarget(white);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prev);
  }

  function render(sceneIn: THREE.Scene, camera: THREE.PerspectiveCamera, opts: PostOptions = {}): void {
    if (!ok) {
      renderer.setRenderTarget(null);
      renderer.render(sceneIn, camera);
      return;
    }
    t += 1 / 60;
    const warp = opts.warp ?? 0;
    const wantAO = tier.ao && (opts.ao ?? true);
    const air = opts.atmosphere ?? null;
    // The linear-depth buffer feeds both occlusion and the haze, so it has to
    // be built if either wants it.
    const wantDepth = wantAO || !!air;

    try {
      /* 1 — the frame, in HDR */
      renderer.setRenderTarget(hdr);
      renderer.clear();
      renderer.render(sceneIn, camera);

      /* 2 — linear depth, then AO */
      if (wantDepth) {
        mLin.uniforms.uNear.value = camera.near;
        mLin.uniforms.uFar.value = camera.far;
        blit(mLin, lin);
      }
      if (wantAO) {
        mAO.uniforms.uAspect.value = camera.aspect;
        mAO.uniforms.uTanHalfFov.value = Math.tan(((camera.fov * Math.PI) / 180) / 2);
        mAO.uniforms.uTime.value = t;
        // The radius is in the scene's own units, and the two scenes are four
        // orders of magnitude apart — 1.4 m on a surface, 4 units in orbit.
        mAO.uniforms.uRadius.value = camera.far > 5000 ? 3.0 : 1.4;
        blit(mAO, aoA);

        const aw = aoA.width;
        const ah = aoA.height;
        mBlur.uniforms.tAO.value = aoA.texture;
        (mBlur.uniforms.uDir.value as THREE.Vector2).set(1 / aw, 0);
        blit(mBlur, aoB);
        mBlur.uniforms.tAO.value = aoB.texture;
        (mBlur.uniforms.uDir.value as THREE.Vector2).set(0, 1 / ah);
        blit(mBlur, aoA);
        mComp.uniforms.tAO.value = aoA.texture;
        mComp.uniforms.uAO.value = 1.0;
      } else {
        mComp.uniforms.tAO.value = white.texture;
        mComp.uniforms.uAO.value = 0.0;
      }

      /* 3 — bloom: prefilter, down, up */
      (mPre.uniforms.uTexel.value as THREE.Vector2).set(1 / W, 1 / H);
      blit(mPre, chain[0]);
      for (let i = 1; i < chain.length; i++) {
        mDown.uniforms.tSrc.value = chain[i - 1].texture;
        (mDown.uniforms.uTexel.value as THREE.Vector2).set(1 / chain[i - 1].width, 1 / chain[i - 1].height);
        blit(mDown, chain[i]);
      }
      for (let i = chain.length - 1; i > 0; i--) {
        mUp.uniforms.tSrc.value = chain[i].texture;
        (mUp.uniforms.uTexel.value as THREE.Vector2).set(1 / chain[i].width, 1 / chain[i].height);
        blit(mUp, chain[i - 1], true);
      }

      /* debug taps */
      if (opts.debug) {
        const src = opts.debug === 1 ? aoA.texture : opts.debug === 2 ? chain[0].texture : lin.texture;
        mDebug.uniforms.tSrc.value = src;
        mDebug.uniforms.uScale.value = opts.debug === 3 ? 0.01 : opts.debug === 2 ? 6 : 1;
        blit(mDebug, null);
        renderer.setRenderTarget(null);
        return;
      }

      /* 4 — composite */
      /* atmospherics */
      if (air) {
        (mComp.uniforms.uFogColor.value as THREE.Color).set(air.color);
        (mComp.uniforms.uSunColorV.value as THREE.Color).set(air.sunColor);
        // Into view space, because the haze is evaluated against a view-space
        // ray reconstructed from depth.
        (mComp.uniforms.uSunDirV.value as THREE.Vector3)
          .copy(air.sunDir)
          .transformDirection(camera.matrixWorldInverse)
          .normalize();
        (mComp.uniforms.uViewUp.value as THREE.Vector3)
          .set(0, 1, 0)
          .transformDirection(camera.matrixWorldInverse)
          .normalize();
        mComp.uniforms.uFogDensity.value = air.density;
        mComp.uniforms.uFogHeight.value = air.height;
        mComp.uniforms.uCamY.value = camera.position.y;
        mComp.uniforms.uInscatter.value = air.inscatter ?? 1;
        mComp.uniforms.uAspectF.value = camera.aspect;
        mComp.uniforms.uTanHalfF.value = Math.tan(((camera.fov * Math.PI) / 180) / 2);
      } else {
        mComp.uniforms.uFogDensity.value = 0;
      }

      mComp.uniforms.uExposure.value = opts.exposure ?? 1.0;
      mComp.uniforms.uWarp.value = warp;
      mComp.uniforms.uTime.value = t;
      mComp.uniforms.tBloom.value = chain[0].texture;
      blit(mComp, tier.fxaa ? ldr : null);

      /* 5 — FXAA */
      if (tier.fxaa) blit(mFxaa, null);

      renderer.setRenderTarget(null);
    } catch (err) {
      // A pipeline that throws must not take the world down with it. Fall back
      // to drawing straight to the canvas for the rest of the session.
      console.error("[SNW] post pipeline failed, falling back to direct render", err);
      ok = false;
      renderer.setRenderTarget(null);
      renderer.render(sceneIn, camera);
    }
  }

  return {
    quality,
    render,
    setSize,
    get ok() {
      return ok;
    },
    dispose() {
      for (const o of owned) {
        try {
          o.dispose();
        } catch {
          /* already gone */
        }
      }
      QUAD.dispose();
    },
  };
}
