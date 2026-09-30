/**
 * The skies of Venus, between the decks.
 *
 * Fifty-four kilometres up you are *inside* the cloud system, not on top of
 * it: the lower deck is a floor of sulfuric haze a few kilometres down and
 * the upper deck is a luminous ceiling a few kilometres up. The sun is a
 * bright patch in that ceiling at noon, and at dawn and dusk it slides into
 * the gap between the two and lights the underside of the ceiling from the
 * side. That gap is the most beautiful thing on the planet, so the whole
 * look is built around it.
 *
 * No backticks inside the GLSL: these are template literals.
 */

export const NOISE = /* glsl */ `
float vhash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = vhash(i);
  float b = vhash(i + vec2(1.0, 0.0));
  float c = vhash(i + vec2(0.0, 1.0));
  float d = vhash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float vfbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < OCTAVES; i++) {
    s += a * vnoise(p);
    p = m * p + 3.1;
    a *= 0.5;
  }
  return s;
}
`;

/** Shared across every sky material, so one write per frame moves them all. */
export interface SkyUniforms {
  uTime: { value: number };
  uSunDir: { value: import("three").Vector3 };
  uSunCol: { value: import("three").Color };
  uHorizon: { value: import("three").Color };
  uCeiling: { value: import("three").Color };
  uDeckTop: { value: import("three").Color };
  uDeckMid: { value: import("three").Color };
  uDeckLow: { value: import("three").Color };
  uNight: { value: number };
  uHeat: { value: number };
  uFlash: { value: number };
  uFlashPos: { value: import("three").Vector2 };
  uFogDensity: { value: number };
  [k: string]: { value: unknown };
}

const FOG = /* glsl */ `
// The colour of the sky in a direction. Fog fades everything toward exactly
// this, so the far edge of the cloud floor and ceiling dissolves into the
// dome instead of meeting it along a bright seam.
vec3 skyCol(vec3 d) {
  float band = exp(-abs(d.y) * 9.0);
  vec3 col = mix(uCeiling, uHorizon, band);
  col = mix(col, uDeckMid, smoothstep(0.0, -0.4, d.y));
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunCol * (pow(sd, 18.0) * 0.9 + pow(sd, 4.0) * 0.25);
  return col;
}
vec3 applyFog(vec3 col, vec3 wpos) {
  vec3 dv = wpos - cameraPosition;
  float dist = length(dv);
  float f = 1.0 - exp(-dist * uFogDensity);
  return mix(col, skyCol(dv / max(dist, 1e-3)), clamp(f, 0.0, 1.0));
}
`;

export const HEADER = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uHorizon;
uniform vec3 uCeiling;
uniform vec3 uDeckTop;
uniform vec3 uDeckMid;
uniform vec3 uDeckLow;
uniform float uNight;
uniform float uHeat;
uniform float uFlash;
uniform vec2 uFlashPos;
uniform float uFogDensity;
`;

export const WORLD_VERT = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/* ------------------------------------------------------------- the dome */

export const SKY_FRAG = /* glsl */ `
${HEADER}
${FOG}
varying vec3 vW;
void main() {
  vec3 d = normalize(vW - cameraPosition);
  float band = exp(-abs(d.y) * 9.0);
  float sd = max(dot(d, uSunDir), 0.0);
  // The disc itself, only in the gap between the decks.
  float disk = smoothstep(0.9993, 0.9998, sd) * band * 2.0;
  gl_FragColor = vec4(skyCol(d) + uSunCol * disk * 6.0, 1.0);
}
`;

/* ----------------------------------------------------- the lower deck */

export const DECK_FRAG = /* glsl */ `
${HEADER}
${FOG}
varying vec3 vW;
float field(vec2 p) {
  vec2 q = p * 0.0011;
  vec2 warp = vec2(vfbm(q * 0.35 + vec2(uTime * 0.004, 0.0)), vfbm(q * 0.35 + vec2(5.2, 1.3 - uTime * 0.003)));
  float f = vfbm(q + warp * 2.2 + vec2(uTime * 0.0065, uTime * 0.0021));
  // Cells of billow: the lower deck is convective, so it comes in heaps.
  float cells = 1.0 - abs(vnoise(q * 0.9 + warp) * 2.0 - 1.0);
  f = f * 0.75 + cells * 0.35;
  return smoothstep(0.28, 0.95, f);
}
void main() {
  vec2 p = vW.xz;
  float h = field(p);
  float e = 40.0;
  float hx = field(p + vec2(e, 0.0));
  float hz = field(p + vec2(0.0, e));
  vec3 n = normalize(vec3((h - hx) * 7.0, 1.0, (h - hz) * 7.0));
  float lam = max(dot(n, uSunDir), 0.0);
  vec2 toward = normalize(uSunDir.xz + 1e-4) * 500.0 * (1.0 - clamp(uSunDir.y, 0.0, 1.0));
  float sh = smoothstep(0.1, -0.06, field(p + toward) - h - 0.04);
  vec3 base = mix(uDeckLow, uDeckMid, smoothstep(0.0, 0.5, h));
  base = mix(base, uDeckTop, smoothstep(0.4, 1.0, h));
  vec3 sky = mix(uCeiling, uHorizon, 0.4);
  vec3 col = base * sky * (0.35 + 0.35 * n.y + 0.3 * h);
  col += base * uSunCol * lam * mix(0.35, 1.0, sh) * 0.55;
  col += uSunCol * pow(1.0 - h, 3.0) * 0.08 * (1.0 - uNight);
  col += vec3(1.0, 0.35, 0.08) * uHeat * (0.2 + 0.8 * pow(1.0 - h, 2.0));
  float fl = uFlash * exp(-length(p - uFlashPos) * 0.0009) * (1.2 - h);
  col += vec3(0.8, 0.75, 1.0) * fl * 2.5;
  col = applyFog(col, vW);
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ------------------------------------------------------ the ceiling */

export const CEIL_FRAG = /* glsl */ `
${HEADER}
${FOG}
varying vec3 vW;
void main() {
  vec2 q = vW.xz * 0.00028;
  vec2 warp = vec2(vfbm(q * 0.7 + 2.0), vfbm(q * 0.7 + 7.1));
  float th = vfbm(q + warp * 1.3 + vec2(uTime * 0.005, -uTime * 0.002));
  // Streaks along the wind: Venus's upper clouds are combed into chevrons.
  float streak = vfbm(vec2(q.x * 0.9, q.y * 1.8) + uTime * 0.003);
  th = mix(th, streak, 0.2);
  vec3 d = normalize(vW - cameraPosition);
  float sd = max(dot(d, uSunDir), 0.0);
  float thin = 1.0 - smoothstep(0.25, 0.8, th);
  vec3 col = mix(uCeiling * 0.78, uCeiling * 1.12, thin);
  // Sun behind the ceiling: a bright patch, brighter where it is thin.
  col += uSunCol * pow(sd, 10.0) * (0.35 + thin * 1.1);
  // Low sun lights the underside from the side: this is the pink.
  float grazing = pow(1.0 - clamp(uSunDir.y, 0.0, 1.0), 3.0) * step(0.0, uSunDir.y + 0.12);
  col += uSunCol * grazing * pow(max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0), 3.0) * (0.25 + 0.4 * (1.0 - thin));
  col = applyFog(col, vW);
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ------------------------------------------ towers of cloud, billboarded */

export const PUFF_VERT = /* glsl */ `
attribute vec3 center;
attribute vec2 corner;
attribute vec2 size;
attribute float seed;
uniform float uDeckY;
varying vec2 vUv;
varying float vSeed;
varying vec3 vW;
varying float vFade;
void main() {
  vec3 c = center + vec3(0.0, uDeckY, 0.0);
  // A billboard seen from above is a cardboard cut-out; fade them out as
  // the view steepens.
  vec3 toC = normalize(c - cameraPosition);
  vFade = 1.0 - smoothstep(0.18, 0.42, -toC.y);
  vec4 mv = viewMatrix * vec4(c, 1.0);
  mv.xy += corner * size;
  vUv = corner * 0.5 + 0.5;
  vSeed = seed;
  vW = c + vec3(0.0, corner.y * size.y, 0.0);
  gl_Position = projectionMatrix * mv;
}
`;

export const PUFF_FRAG = /* glsl */ `
${HEADER}
${FOG}
varying vec2 vUv;
varying float vSeed;
varying vec3 vW;
varying float vFade;
void main() {
  if (vFade < 0.01) discard;
  vec2 p = vUv * 2.0 - 1.0;
  // A heap: round on top, flat where it meets the deck.
  float base = -0.35;
  float y = p.y - base;
  float shape = 1.0 - (p.x * p.x * 1.05 + (y > 0.0 ? y * y * 1.6 : y * y * 9.0));
  float n = vfbm(vUv * vec2(4.0, 2.4) + vSeed * 13.7 + uTime * 0.01);
  float a = smoothstep(0.0, 0.35, shape + (n - 0.5) * 0.9);
  if (a < 0.01) discard;
  float top = clamp(p.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uDeckMid * 0.8, uDeckTop * 1.12, smoothstep(0.05, 0.85, top + (n - 0.5) * 0.5));
  vec3 sky = mix(uCeiling, uHorizon, 0.5);
  col *= sky * 0.5 + 0.5;
  // Sunlit side.
  vec3 v = normalize(vW - cameraPosition);
  float toward = max(dot(normalize(vec3(v.x, 0.0, v.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + 1e-4)), 0.0);
  col += uSunCol * (0.12 + 0.25 * toward) * top * (1.0 - uNight) * 0.6;
  col += vec3(1.0, 0.35, 0.08) * uHeat * (1.0 - top) * 0.4;
  col = applyFog(col, vW);
  gl_FragColor = vec4(col, a * 0.85 * vFade);
}
`;

/* ------------------------------------------------ glass, for domes */

export const GLASS_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const GLASS_FRAG = /* glsl */ `
uniform vec3 uTint;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uCeiling;
uniform float uNight;
uniform float uGhost;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 v = normalize(cameraPosition - vW);
  vec3 n = normalize(vN);
  if (dot(n, v) < 0.0) n = -n;
  float fr = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 r = reflect(-v, n);
  float spec = pow(max(dot(r, uSunDir), 0.0), 120.0) * 3.0;
  // Hex frame lines, from the normal's direction: cheap geodesic look.
  vec3 a = abs(n);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(n.z, n.x);
  float gl = max(smoothstep(0.93, 0.99, abs(sin(lat * 10.0))), smoothstep(0.95, 0.995, abs(sin(lon * 9.0 + lat * 3.0))));
  vec3 refl = mix(uCeiling, uSunCol, 0.2) * (1.0 - uNight * 0.85);
  vec3 col = mix(uTint * 0.2, refl, fr) + uSunCol * spec;
  col += vec3(1.0, 0.85, 0.6) * gl * (0.16 + uNight * 0.12);
  // Warm light from inside the dome after dark, strongest at the rim.
  col += vec3(1.0, 0.7, 0.4) * uNight * fr * 0.8;
  float alpha = clamp(0.1 + fr * 0.7 + gl * 0.35 + spec, 0.0, 0.95);
  alpha *= mix(1.0, 0.45, uGhost);
  gl_FragColor = vec4(col, alpha);
}
`;

/* ---------------------------------------- envelopes: gores and glow */

export const ENVELOPE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uCeiling;
uniform vec3 uHorizon;
uniform float uNight;
varying vec3 vN;
varying vec3 vW;
varying vec2 vUv2;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  float lam = max(dot(n, uSunDir), 0.0);
  float wrap = max(dot(n, uSunDir) * 0.5 + 0.5, 0.0);
  float gore = smoothstep(0.0, 0.08, abs(fract(vUv2.x * 16.0) - 0.5));
  float seam = 1.0 - gore;
  float up = n.y * 0.5 + 0.5;
  vec3 amb = mix(uHorizon * 0.55, uCeiling, up);
  vec3 col = uColor * (amb * 0.75 + uSunCol * lam * 0.9);
  // Translucency: sun through the fabric from behind.
  float back = pow(max(dot(-v, uSunDir), 0.0), 3.0);
  col += uColor * uSunCol * back * 0.5 * wrap;
  col *= mix(1.0, 0.82, seam);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 2.5);
  col += amb * rim * 0.25;
  // At night the envelopes are paper lanterns: lit from inside, brightest
  // through the thin fabric at the rim, warmest underneath.
  vec3 lamp = mix(vec3(1.0, 0.62, 0.3), uColor * vec3(1.0, 0.8, 0.6), 0.35);
  col = mix(col, col * 0.35, uNight * 0.6);
  col += lamp * uNight * (0.35 + 0.9 * rim + 0.5 * (1.0 - up)) * mix(1.0, 0.8, seam);
  gl_FragColor = vec4(col, 1.0);
}
`;

export const ENVELOPE_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vW;
varying vec2 vUv2;
void main() {
  vUv2 = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
