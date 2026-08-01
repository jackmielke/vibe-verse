/**
 * Vibe Kart — the VFX shader kit.
 *
 * Three programs cover every effect in the game:
 *
 *   PARTICLE — an instanced billboard. The *entire* simulation lives here:
 *     position is `p0 + v0·(1-e^{-kt})/k + ½gt²` evaluated per vertex, so the
 *     CPU writes a particle's attributes exactly once, at spawn, and never
 *     touches it again. Four thousand particles therefore cost four thousand
 *     quads of vertex work and zero JavaScript.
 *
 *   RIBBON — a screen-facing strip with a per-vertex birth stamp. Skid marks
 *     and the star-power trail are the same geometry pipeline with different
 *     materials; both fade by age in the shader rather than by rewriting alpha.
 *
 *   RING — a ground-aligned expanding annulus. Its instance matrix is written
 *     once at spawn (orientation is fixed the moment a shockwave happens); the
 *     radius animation is a vertex-shader scale off the age.
 *
 * Notes for anyone extending these:
 *
 * · **Dead particles are degenerated, not culled.** There is no CPU-side
 *   compaction; an expired instance writes `gl_Position = vec4(2)` which lands
 *   outside the clip volume and is thrown away before rasterisation. A branch
 *   in the vertex shader is far cheaper than a buffer rewrite.
 *
 * · **Soft-particle depth fade is optional and compile-gated.** The screenshot
 *   harness runs on SwiftShader where a depth texture may not exist; the
 *   `SOFT_DEPTH` define is only set when a post stack hands us one, and
 *   everything degrades to a plain hard-edged sprite without it.
 *
 * · **Fog is computed by hand.** These are `ShaderMaterial`s, so none of the
 *   fog chunks apply, but a smoke plume that ignores the haze the rest of the
 *   world sits in is the single most obvious "this is a particle system" tell.
 */

/** Shared preamble: the exp2 fog and soft-depth helpers both programs use. */
const FOG_PARS = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogDensity;

float fogVisibility(float viewDepth) {
  float f = uFogDensity * viewDepth;
  return clamp(exp(-f * f), 0.0, 1.0);
}
`;

const SOFT_PARS = /* glsl */ `
#ifdef SOFT_DEPTH
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform vec2 uNearFar;
uniform float uSoftness;

/** Perspective depth buffer value -> positive view-space distance. */
float linearDepth(float d) {
  float n = uNearFar.x;
  float f = uNearFar.y;
  float z = d * 2.0 - 1.0;
  return (2.0 * n * f) / (f + n - z * (f - n));
}

/** 0 where the sprite is buried in geometry, 1 in free air. */
float softFade(float viewDepth) {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float scene = linearDepth(texture2D(uDepth, uv).x);
  return clamp((scene - viewDepth) / max(uSoftness, 0.001), 0.0, 1.0);
}
#endif
`;

// ---------------------------------------------------------------------------
// Particles
// ---------------------------------------------------------------------------

export const PARTICLE_VERT = /* glsl */ `
uniform float uTime;
uniform float uGrid;
uniform float uInset;
uniform float uMaxStretch;
uniform float uSizeScale;

attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aColor0;   // rgb + alpha at birth
attribute vec4 aColor1;   // rgb + alpha at death
attribute vec4 aParam;    // birth, life, size at birth, size at death
attribute vec4 aMisc;     // atlas tile, initial roll, spin rate, drag
attribute vec4 aExtra;    // gravity, stretch, flutter, seed

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vFog;
varying float vViewDepth;

${FOG_PARS}

void main() {
  float birth = aParam.x;
  float life = aParam.y;
  float age = uTime - birth;

  // Unborn or expired: collapse to a point outside the clip volume. Cheaper
  // than any form of CPU compaction and it costs one branch.
  if (age < 0.0 || age >= life) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    vUv = vec2(0.0);
    vColor = vec3(0.0);
    vFog = 0.0;
    vViewDepth = 0.0;
    return;
  }

  float u = age / life;
  float drag = max(aMisc.w, 0.0015);
  float gravity = aExtra.x;

  // Closed-form ballistics with linear drag. The exponential is the whole
  // trick: it means a spark that decelerates and a smoke puff that coasts are
  // the same instruction stream, and neither needs integrating on the CPU.
  float decay = exp(-drag * age);
  vec3 wp = aPos + aVel * ((1.0 - decay) / drag);
  wp.y += 0.5 * gravity * age * age;

  // Flutter — confetti, torn grass, anything with more surface than mass.
  float flutter = aExtra.z;
  if (flutter > 0.0) {
    float s = aExtra.w * 61.7;
    float ramp = min(age * 2.0, 1.0) * flutter;
    wp.x += sin(age * 4.3 + s) * ramp;
    wp.z += cos(age * 3.1 + s * 1.7) * ramp;
    wp.y += sin(age * 6.7 + s * 2.9) * ramp * 0.3;
  }

  vec4 mv = modelViewMatrix * vec4(wp, 1.0);
  vViewDepth = -mv.z;

  float size = mix(aParam.z, aParam.w, u) * uSizeScale;
  // A hard pop-in reads as a glitch at 60fps. Six percent of life is enough to
  // hide the birth frame and short enough that nothing looks like it inflates.
  size *= smoothstep(0.0, 0.06, u);

  // Instantaneous velocity in view space drives the streak axis. Gravity is
  // folded in so a falling ember streaks downward, not along its launch vector.
  vec3 vvel = (modelViewMatrix * vec4(aVel * decay + vec3(0.0, gravity * age, 0.0), 0.0)).xyz;
  float stretch = aExtra.y;
  float planar = length(vvel.xy);

  vec2 corner = position.xy;
  vec2 offset;
  if (stretch > 0.0 && planar > 0.02) {
    vec2 axisY = vvel.xy / planar;
    vec2 axisX = vec2(axisY.y, -axisY.x);
    float len = min(1.0 + stretch * planar, uMaxStretch);
    // Narrowing with sqrt(len) keeps the streak's area roughly constant, so a
    // fast spark gets brighter-looking and thinner instead of simply bigger.
    offset = axisX * corner.x * (size / sqrt(len)) + axisY * corner.y * (size * len);
  } else {
    float roll = aMisc.y + aMisc.z * age;
    float c = cos(roll);
    float s = sin(roll);
    offset = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c) * size;
  }
  mv.xy += offset;

  gl_Position = projectionMatrix * mv;

  // Atlas lookup. flipY on the canvas texture means cell row 0 (the top of the
  // page) lands at the top of V, hence the (grid-1-row) term.
  float tile = aMisc.x;
  float gx = mod(tile, uGrid);
  float gy = floor(tile / uGrid);
  vec2 cellUv = (position.xy + 0.5) * (1.0 - 2.0 * uInset) + uInset;
  vUv = (vec2(gx, uGrid - 1.0 - gy) + cellUv) / uGrid;

  vColor = mix(aColor0.rgb, aColor1.rgb, smoothstep(0.0, 1.0, u));
  // Quick in, long out — the envelope every soft body effect wants. Baked here
  // so the fragment shader stays a texture fetch and a multiply.
  vAlpha = mix(aColor0.a, aColor1.a, u)
         * smoothstep(0.0, 0.045, u)
         * (1.0 - smoothstep(0.58, 1.0, u));
  // There is already a soft fade against scene geometry; this is the same idea
  // against the near plane. A tyre-smoke puff grows to two and a half metres
  // and the chase camera drives straight through the plume, so without this a
  // single sprite lands on the lens as an opaque white ball. Deliberately
  // tight: the player's own drift sparks sit three or four metres back and
  // must not be touched.
  vAlpha *= smoothstep(0.3, 1.8, vViewDepth);
  vFog = fogVisibility(vViewDepth);
}
`;

export const PARTICLE_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uIntensity;

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vFog;
varying float vViewDepth;

${FOG_PARS}
${SOFT_PARS}

void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vAlpha;
  if (a < 0.004) discard;

  vec3 col = vColor * tex.rgb * uIntensity;

  #ifdef SOFT_DEPTH
    a *= softFade(vViewDepth);
  #endif

  #ifdef ADDITIVE
    // Additive light does not turn the colour of the haze, it simply stops
    // arriving through it.
    col *= vFog;
    a *= vFog;
  #else
    col = mix(uFogColor, col, vFog);
  #endif

  gl_FragColor = vec4(col, a);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Ribbons — skid marks and the star trail
// ---------------------------------------------------------------------------

export const RIBBON_VERT = /* glsl */ `
uniform float uTime;
uniform float uLife;

attribute float aBirth;
attribute float aFade;

varying vec2 vUv;
varying float vAge;
varying float vFade;
varying float vFog;

${FOG_PARS}

void main() {
  vAge = (uTime - aBirth) / uLife;
  vUv = uv;
  vFade = aFade;

  // Retired segments fold away rather than being rebuilt on the CPU: the
  // ribbon is a ring buffer and its stale half must simply stop drawing.
  if (vAge < 0.0 || vAge > 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vFog = 0.0;
    return;
  }

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFog = fogVisibility(-mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

export const RIBBON_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uScroll;
uniform float uIntensity;

varying vec2 vUv;
varying float vAge;
varying float vFade;
varying float vFog;

${FOG_PARS}

void main() {
  if (vAge < 0.0 || vAge > 1.0) discard;

  vec4 tex = texture2D(uMap, vec2(vUv.x + uScroll, vUv.y));

  // Rubber does not evaporate uniformly: hold most of the opacity for the
  // first two thirds of the life and then let it go. Eight seconds of mark on
  // the tarmac is the difference between a track and a raced-on track.
  float fade = 1.0 - smoothstep(0.45, 1.0, vAge);
  float a = tex.a * uOpacity * vFade * fade;
  if (a < 0.004) discard;

  vec3 col = uColor * tex.rgb * uIntensity;

  #ifdef ADDITIVE
    col *= vFog;
    a *= vFog;
  #else
    col = mix(uFogColor, col, vFog);
  #endif

  gl_FragColor = vec4(col, a);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Rings — shockwaves, landing dust, water ripples
// ---------------------------------------------------------------------------

export const RING_VERT = /* glsl */ `
uniform float uTime;
uniform float uGrid;
uniform float uInset;

attribute vec4 aParam;   // birth, life, radius at birth, radius at death
attribute vec4 aColor;   // rgb + peak alpha
attribute float aTile;

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vFog;

${FOG_PARS}

void main() {
  float age = uTime - aParam.x;
  float life = aParam.y;
  if (age < 0.0 || age >= life) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    vUv = vec2(0.0);
    vColor = vec3(0.0);
    vFog = 0.0;
    return;
  }

  float u = age / life;
  // Ease-out cubic. A pressure front leaves fast and decelerates; a linear
  // expansion reads as an animated GIF.
  float eased = 1.0 - pow(1.0 - u, 3.0);
  float radius = mix(aParam.z, aParam.w, eased);

  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position * radius, 1.0);
  gl_Position = projectionMatrix * mv;

  float gx = mod(aTile, uGrid);
  float gy = floor(aTile / uGrid);
  vec2 cellUv = (position.xy + 0.5) * (1.0 - 2.0 * uInset) + uInset;
  vUv = (vec2(gx, uGrid - 1.0 - gy) + cellUv) / uGrid;

  vColor = aColor.rgb;
  // Bright the instant it appears, gone by the time it is wide — the opposite
  // envelope to a particle, and the reason a shockwave reads as a *snap*.
  vAlpha = aColor.a * (1.0 - smoothstep(0.0, 1.0, u)) * smoothstep(0.0, 0.05, u);
  // A blast ring expands to seven metres. When the detonation is next to the
  // chase camera the ring sweeps straight through the lens and floods the
  // whole frame with a flat white dome. Fade any part of the ring that gets
  // within arm's reach of the eye: the far side of the same ring is
  // untouched, so the shockwave still reads at normal viewing distance.
  vAlpha *= smoothstep(0.35, 2.2, length(mv.xyz));
  vFog = fogVisibility(-mv.z);
}
`;

export const RING_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uIntensity;

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vFog;

${FOG_PARS}

void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vAlpha;
  if (a < 0.004) discard;

  vec3 col = vColor * tex.rgb * uIntensity;

  #ifdef ADDITIVE
    col *= vFog;
    a *= vFog;
  #else
    col = mix(uFogColor, col, vFog);
  #endif

  gl_FragColor = vec4(col, a);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
