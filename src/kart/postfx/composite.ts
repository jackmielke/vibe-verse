/**
 * The composite: everything that has to happen in one place, in one pass.
 *
 * Chromatic aberration, the speed barrel, the stun wobble, the DOF lerp and the
 * bloom add all need to sample the scene at offsets or in HDR. Splitting them
 * across passes would mean each one samples a *differently* processed image and
 * would cost a full-resolution half-float round trip apiece. Doing them
 * together also settles the ordering argument once and for all.
 *
 * Order of operations, and the reason for each:
 *   1. UV work — barrel, stun wobble, shock band tear. These are properties of
 *      the *lens and the player's head*, so they must move the image before
 *      anything reads it.
 *   2. Scene sample with chromatic aberration. Dispersion happens in glass, so
 *      it acts on the scene, never on the graded result.
 *   3. Depth of field, lerped by a circle of confusion computed from the same
 *      uniforms the DOF pass used.
 *   4. Bloom and sun shafts, added in HDR — the only place adding light is
 *      physically meaningful.
 *   5. Exposure, then the ACES fit that matches the renderer's own tonemap
 *      exactly, so toggling post does not shift the image.
 *   6. The LUT grade, in display space, where a grade is authored.
 *   7. Speed lines, star rainbow, shock, stun, ink, flash — the game layer.
 *   8. Vignette and grain last, because they are the "it was photographed"
 *      pass and must sit on top of everything, including the ink.
 *
 * Output is sRGB-encoded and written straight out. Nothing downstream converts
 * it again: this material is a ShaderMaterial with no `<colorspace_fragment>`
 * include, so three leaves gl_FragColor alone, and `toneMapped: false` keeps it
 * from applying ACES a second time.
 */
import * as THREE from "three";
import { PF_COLOR, PF_DEPTH, PF_NOISE, PF_VERT } from "./glsl";
import { PF_COC } from "./dof";
import { PF_LUT } from "./lut";
import {
  Blitter,
  depthUniforms,
  fullscreenMaterial,
  makeBlackTexture,
  type SharedUniforms,
} from "./targets";

const compositeFrag = /* glsl */ `
precision highp float;
${PF_DEPTH}
${PF_COLOR}
${PF_NOISE}
${PF_COC}
${PF_LUT}

uniform sampler2D tImage;
uniform sampler2D tBloom;
uniform sampler2D tDof;
uniform sampler2D tGodRays;
uniform sampler2D tInk;

uniform float uBloomStrength;
uniform float uBloomBlend;
uniform vec3  uBloomTint;
uniform float uDofAmount;
uniform float uGodStrength;
uniform vec3  uGodTint;

uniform float uExposure;
uniform float uCa;
uniform float uBarrel;
uniform float uVignette;
uniform float uGrain;

uniform float uSpeedLines;
uniform vec2  uVanish;

uniform float uFlash;
uniform vec3  uFlashColor;
uniform float uInk;
uniform float uInkPhase;
uniform float uStun;
uniform float uShock;
uniform float uStar;

uniform vec2  uTexel;
uniform float uAspect;
uniform float uTime;
varying vec2 vUv;

/**
 * Chromatic aberration, at the edges only.
 *
 * A real lens is corrected on axis; the fringing in a photograph grows roughly
 * with the square of the field height. A constant offset across the whole frame
 * is the classic tell — it puts colour fringes on a kart dead centre, where no
 * lens has ever put them.
 */
vec3 sampleScene(const in vec2 uv) {
  vec2 fromCenter = uv - 0.5;
  float r2 = dot(fromCenter, fromCenter) * 4.0;
  float amount = uCa * r2 * r2 * 0.0075;
  if (amount < 1e-6) return pfSanitize(texture2D(tImage, uv).rgb);
  vec3 c;
  c.r = texture2D(tImage, uv - fromCenter * amount).r;
  c.g = texture2D(tImage, uv).g;
  c.b = texture2D(tImage, uv + fromCenter * amount).b;
  return pfSanitize(c);
}

/**
 * Radial speed streaks.
 *
 * Angular cells, one dashed streak per cell at a random offset, flying outward
 * from the vanishing point. Cells keep the streaks evenly distributed (pure
 * random angles clump), the per-cell random offset and length keep them from
 * looking like a wagon wheel, and the centre is masked out so the player's kart
 * never sits inside the effect.
 */
float speedLines(const in vec2 uv) {
  vec2 d = (uv - uVanish) * vec2(uAspect, 1.0);
  float r = length(d);
  if (r < 0.09) return 0.0;

  float a = atan(d.y, d.x) * 0.15915494327;
  float cell = floor(a * 84.0);
  float f = fract(a * 84.0);
  float n1 = pfHash12(vec2(cell, 3.0));
  float n2 = pfHash12(vec2(cell, 17.0));

  float w = 0.10 + n2 * 0.12;
  float t = (f - n1) / w;
  float line = exp(-t * t * 4.0);

  float len = 0.16 + n2 * 0.22;
  float head = fract(uTime * (1.1 + n2 * 1.1) + n1 * 1.7) * 1.55;
  float dash =
    smoothstep(head - len, head - len * 0.55, r) *
    (1.0 - smoothstep(head - len * 0.15, head, r));

  return line * dash * smoothstep(0.10, 0.44, r);
}

void main() {
  /* ---------- 1. lens and head ---------- */
  vec2 uv = vUv;
  vec2 fromCenter = uv - 0.5;
  {
    vec2 scaled = fromCenter * vec2(uAspect, 1.0);
    float r2 = dot(scaled, scaled);
    // Sampling inward stretches the image outward: the frame opens up as speed
    // rises, which is the oldest trick in the arcade-racer book and still the
    // best one. Kept small — past ~0.08 it reads as a fisheye gimmick.
    uv = 0.5 + fromCenter * (1.0 - uBarrel * r2);
  }

  if (uStun > 0.003) {
    // Two crossed low-frequency waves. Slow, big, and nauseating on purpose.
    uv += vec2(
      sin(uv.y * 11.0 + uTime * 6.5),
      cos(uv.x * 9.0 - uTime * 5.0)
    ) * uTexel * 10.0 * uStun;
  }

  if (uShock > 0.003) {
    // Horizontal band tear, quantised in time so it strobes rather than slides.
    vec2 key = vec2(floor(uv.y * 46.0), floor(uTime * 26.0));
    float band = step(0.62, pfHash12(key));
    uv.x += (pfHash12(key + 7.0) - 0.5) * 0.035 * uShock * band;
  }

  uv = clamp(uv, vec2(0.0), vec2(1.0));

  /* ---------- 2-3. scene, then defocus ---------- */
  vec3 scene = sampleScene(uv);

  if (uDofAmount > 0.003) {
    float coc = pfCoc(-pfViewZ(pfRawDepth(uv))) * uDofAmount;
    if (coc > 0.004) {
      vec4 blurred = texture2D(tDof, uv);
      // Un-premultiply: the DOF buffer stores colour × coc so that in-focus
      // pixels contribute nothing to their blurry neighbours.
      vec3 far = blurred.rgb / max(blurred.a, 1e-3);
      scene = mix(scene, far, clamp(coc, 0.0, 1.0));
    }
  }

  /* ---------- 4. HDR additions ---------- */
  vec3 bloom = pfSanitize(texture2D(tBloom, uv).rgb) * uBloomStrength * uBloomTint;
  vec3 shafts = pfSanitize(texture2D(tGodRays, uv).rgb) * uGodStrength * uGodTint;
  // The 'mix' is energy conservation: a bloomy highlight loses a little of its
  // core for exactly what its halo gains, which is why the veil reads as
  // scattering rather than as a layer pasted on top.
  vec3 color = mix(scene, bloom, clamp(uBloomBlend, 0.0, 0.5)) + bloom + shafts;

  /* ---------- 5-6. tonemap and grade ---------- */
  color = pfACES(max(color, vec3(0.0)) * uExposure);
  vec3 display = pfGrade(pfLinearToSrgb(color));

  /* ---------- 7. the game layer ---------- */
  if (uSpeedLines > 0.003) {
    display += vec3(1.0, 0.97, 0.9) * speedLines(uv) * uSpeedLines;
  }

  if (uStar > 0.003) {
    float rr = length(fromCenter * vec2(uAspect, 1.0));
    // Cosine palette — a full rainbow for three multiply-adds.
    vec3 rainbow = 0.5 + 0.5 * cos(6.2831853 * (uTime * 0.55 + rr * 1.3 + vec3(0.0, 0.33, 0.67)));
    float amount = uStar * (0.28 + 0.42 * smoothstep(0.12, 0.95, rr));
    display = mix(display, display * (0.55 + 0.9 * rainbow) + rainbow * 0.1, amount);
  }

  if (uShock > 0.003) {
    float l = pfLuma(display);
    display = mix(display, vec3(l) * vec3(0.8, 0.9, 1.25), uShock * 0.7);
    display += vec3(0.3, 0.45, 0.85) * uShock * (0.5 + 0.5 * sin(uTime * 47.0)) * 0.12;
  }

  if (uStun > 0.003) {
    // Pain is not colourful, and neither is being flattened by a shell.
    display = mix(display, vec3(pfLuma(display) * 0.94), uStun * 0.55);
  }

  if (uInk > 0.003) {
    // The splat lands fast, then sags. 'uInkPhase' runs 0..1 over the whole
    // event; the ×2.6 makes the landing occupy the first ~40% of it.
    float phase = clamp(uInkPhase * 2.6, 0.0, 1.0);
    vec2 iuv = (vUv - 0.5) / mix(1.35, 1.02, phase) + 0.5;
    iuv.y += uInkPhase * 0.085 + sin(iuv.x * 23.0) * 0.012 * uInkPhase;
    vec2 ink = texture2D(tInk, clamp(iuv, 0.0, 1.0)).rg;
    // Green is arrival time: the splat grows outward from the impact point
    // instead of fading up as a whole image.
    float reveal = smoothstep(ink.g, ink.g + 0.22, phase);
    float mask = clamp(ink.r * reveal * uInk, 0.0, 1.0);
    display = mix(display, vec3(0.03, 0.045, 0.08), mask * 0.96);
  }

  display = mix(display, uFlashColor, clamp(uFlash, 0.0, 1.0));

  /* ---------- 8. the photographed layer ---------- */
  {
    vec2 v = fromCenter * vec2(uAspect, 1.0);
    float r = length(v);
    // cos⁴ is the physical illumination falloff of a rectilinear lens; the
    // artistic term is a wider, softer bowl. Both are deliberately gentler
    // than a cinematic pipeline would use — a bright cartoon track wants its
    // corners *shaped*, not blacked out, and a heavy vignette is the fastest
    // way to make a sunny image look like a different, gloomier game.
    float natural = pow(cos(clamp(r * 0.78, 0.0, 1.4)), 4.0);
    float artistic = 1.0 - smoothstep(0.62, 1.35, r);
    display *= mix(1.0, mix(natural, artistic, 0.5), uVignette);
  }

  if (uGrain > 0.001) {
    // Real grain lives in the midtones — highlights are fully exposed and
    // shadows have no developed silver. A flat overlay reads as video noise.
    float l = pfLuma(display);
    float response = 4.0 * l * (1.0 - l);
    float n = pfHash12(gl_FragCoord.xy * 1.37 + fract(uTime) * 613.0) - 0.5;
    display += n * uGrain * 0.05 * (0.2 + response);
  }

  gl_FragColor = vec4(clamp(display, 0.0, 1.0), 1.0);
}
`;

export interface CompositeTextures {
  bloom: THREE.Texture | null;
  dof: THREE.Texture | null;
  godRays: THREE.Texture | null;
  ink: THREE.Texture | null;
}

export class CompositePass {
  readonly material: THREE.ShaderMaterial;
  private readonly black: THREE.DataTexture;

  constructor(
    shared: SharedUniforms,
    coc: { uFocusEnd: { value: number }; uFarEnd: { value: number }; uMaxCoc: { value: number } },
    lut: { texture: THREE.Texture; size: number },
  ) {
    this.black = makeBlackTexture();

    this.material = fullscreenMaterial(
      "KartComposite",
      compositeFrag,
      {
        ...depthUniforms(shared),
        ...coc,
        tImage: { value: null },
        tBloom: { value: this.black },
        tDof: { value: this.black },
        tGodRays: { value: this.black },
        tInk: { value: this.black },
        tLut: { value: lut.texture },
        uLutSize: { value: lut.size },
        uLutAmount: { value: 1 },

        uBloomStrength: { value: 1 },
        uBloomBlend: { value: 0.06 },
        // A hair warm. Scattering in the eye and in glass is wavelength
        // dependent, and a warm veil on a sunny track reads as sunlight
        // rather than as a bug.
        uBloomTint: { value: new THREE.Color(1.0, 0.94, 0.85) },
        uDofAmount: { value: 1 },
        uGodStrength: { value: 1 },
        uGodTint: { value: new THREE.Color(1.0, 0.92, 0.78) },

        uExposure: { value: 1 },
        uCa: { value: 0.55 },
        uBarrel: { value: 0 },
        uVignette: { value: 0.55 },
        uGrain: { value: 0.35 },

        uSpeedLines: { value: 0 },
        uVanish: { value: new THREE.Vector2(0.5, 0.5) },

        uFlash: { value: 0 },
        uFlashColor: { value: new THREE.Color(1, 1, 1) },
        uInk: { value: 0 },
        uInkPhase: { value: 0 },
        uStun: { value: 0 },
        uShock: { value: 0 },
        uStar: { value: 0 },

        uTexel: shared.uTexel,
        uAspect: shared.uAspect,
        uTime: shared.uTime,
      },
      PF_VERT,
    );
  }

  /**
   * Bind the optional inputs. A disabled effect gets the 1×1 black texture and
   * a zeroed amount — never a null sampler, which is undefined behaviour in
   * WebGL rather than the "reads as black" everyone assumes.
   */
  setTextures(tex: CompositeTextures): void {
    const u = this.material.uniforms;
    u.tBloom.value = tex.bloom ?? this.black;
    u.tDof.value = tex.dof ?? this.black;
    u.tGodRays.value = tex.godRays ?? this.black;
    u.tInk.value = tex.ink ?? this.black;
    if (!tex.bloom) u.uBloomStrength.value = 0;
    if (!tex.godRays) u.uGodStrength.value = 0;
    if (!tex.dof) u.uDofAmount.value = 0;
  }

  get uniforms(): { [key: string]: THREE.IUniform } {
    return this.material.uniforms;
  }

  render(
    renderer: THREE.WebGLRenderer,
    blitter: Blitter,
    image: THREE.Texture,
    target: THREE.WebGLRenderTarget | null,
  ): void {
    this.material.uniforms.tImage.value = image;
    blitter.draw(renderer, this.material, target);
  }

  dispose(): void {
    this.material.dispose();
    this.black.dispose();
  }
}
