/**
 * Vibe Golf — post-processing and colour grade.
 *
 * Owns the final image. The chain is deliberately short, because this is a
 * bright, high-contrast 2D game and readability beats spectacle: the player
 * must parse solid / hazard / ball in a single glance on a phone.
 *
 *   scene ──► RenderPass ──► GlowPass ──► GradePass ──► AA ──► screen
 *              (HDR linear)   (¼-res,      (bloom composite,
 *                              threshold-   ACES, theme grade,
 *                              gated)       vignette, edge CA, grain)
 *
 * The composer's buffers are half-float and *linear* — three only applies
 * `renderer.toneMapping` / output colour space when it draws to the default
 * framebuffer, so everything stays scene-referred until the grade pass
 * tonemaps and encodes it. One consequence worth knowing: a custom
 * `ShaderMaterial` that writes finished sRGB values straight to `gl_FragColor`
 * used to sneak past tone mapping entirely; now it gets ACES + sRGB like every
 * lit material does. Write *linear* values from custom shaders (a
 * `THREE.Color` uniform is already linear) and it lands where you meant it to.
 *
 * `postprocessing@6.39` is installed but peer-deps three >= 0.168 and breaks
 * against the pinned 0.160 — three's own EffectComposer is what's used here.
 * UnrealBloomPass is deliberately *not* used either: its five-mip pyramid is
 * a dozen render-target switches, and on a tiler each switch is a tile flush.
 * The glow below is three draws at quarter resolution and composites for free
 * inside the grade pass.
 *
 * Tiering: 'low' is grade + FXAA only. 'medium' adds glow, aberration, grain
 * and the impact wobble. 'high' widens the glow and swaps FXAA for SMAA.
 *
 * ── Grade contract (do not regress these; a director panel caught all four) ──
 *  1. This is a *sunny* game. Exposure sits high enough that the sky reaches
 *     the top of the range and the fairway lands near mid-tone — never a
 *     dusk-blue wash with the grass crushed into the toe.
 *  2. The vignette is weighted to the TOP of the frame. The bottom third is
 *     the play area: the ball, its shadow and the lie live there and must stay
 *     legible, so the vignette is scaled to almost nothing below y≈0.2.
 *  3. Split tone carries the light direction the geometry cannot: warm gain +
 *     warm highlight tint against a cool shadow lift. That two-tone is what
 *     separates the four parallax tiers into distance instead of flat bands.
 *  4. Bloom is for emissives only. The threshold is above anything the sky
 *     gradient or a lit cloud can reach, and the bright pass fades to black
 *     inside the buffer border so the clamp-to-edge blur can never replicate a
 *     bright row into a band along the edge of frame.
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { Pass, FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
import type { CourseTheme, Hole, System, SystemFactory } from "../types";

// ---------------------------------------------------------------------------
// Grade presets
// ---------------------------------------------------------------------------

/**
 * One filmic look. `gain` acts in linear light before the tonemapper (it is a
 * white balance); `lift` and `hi` act after it, in display space, so they tint
 * shadows and highlights without dragging the midtones around. That split is
 * what keeps a strong grade from eating the value separation between the play
 * surface and the backdrop.
 */
interface Grade {
  exposure: number;
  gain: [number, number, number];
  lift: [number, number, number];
  hi: [number, number, number];
  contrast: number;
  saturation: number;
  /**
   * Midtone S-curve amount. Applied with the toe masked off, so it widens the
   * separation between the background tiers (which all live in the mids) and
   * opens the upper mids in the sky, without re-crushing the shadows.
   */
  scurve: number;
  /**
   * Hue-targeted lift on green-dominant pixels. The fairway is the subject of
   * this game and has to be the brightest, warmest surface on screen; this is
   * what guarantees it regardless of how the lighting lands.
   */
  green: number;
  vignette: number;
  aberration: number;
  grain: number;
  /** Glow strength and its linear-light threshold. */
  bloom: number;
  threshold: number;
}

const GRADES: Record<CourseTheme, Grade> = {
  // Sunny tropical par 3. Warm key, cool sea-bounce shadow, fairway hottest.
  seaside: {
    exposure: 1.40, gain: [1.10, 1.015, 0.895], lift: [0.010, 0.026, 0.044], hi: [1.13, 1.05, 0.87],
    contrast: 1.05, saturation: 1.15, scurve: 0.34, green: 0.95,
    vignette: 0.20, aberration: 0.0014, grain: 0.011,
    bloom: 0.42, threshold: 2.85,
  },
  // Humid and deep — sunlight punching through the canopy, shade stays green.
  jungle: {
    exposure: 1.33, gain: [1.00, 1.05, 0.915], lift: [0.010, 0.028, 0.030], hi: [1.13, 1.06, 0.83],
    contrast: 1.07, saturation: 1.12, scurve: 0.36, green: 0.90,
    vignette: 0.22, aberration: 0.0014, grain: 0.012,
    bloom: 0.36, threshold: 2.95,
  },
  // Baked red rock: amber highlights, violet shade.
  canyon: {
    exposure: 1.40, gain: [1.14, 1.00, 0.875], lift: [0.030, 0.010, 0.040], hi: [1.17, 1.00, 0.79],
    contrast: 1.06, saturation: 1.12, scurve: 0.34, green: 0.45,
    vignette: 0.22, aberration: 0.0018, grain: 0.013,
    bloom: 0.42, threshold: 2.80,
  },
  // Magenta-and-cyan. The one place the grade is allowed to shout.
  neon: {
    exposure: 1.20, gain: [1.05, 0.94, 1.12], lift: [0.004, 0.030, 0.062], hi: [1.16, 0.88, 1.16],
    contrast: 1.10, saturation: 1.24, scurve: 0.30, green: 0.40,
    vignette: 0.30, aberration: 0.0030, grain: 0.018,
    bloom: 0.95, threshold: 1.95,
  },
  // Thin air: lifted blacks, low contrast, almost no vignette.
  sky: {
    exposure: 1.42, gain: [0.99, 1.005, 1.055], lift: [0.020, 0.030, 0.044], hi: [1.07, 1.05, 1.04],
    contrast: 0.99, saturation: 1.06, scurve: 0.26, green: 0.70,
    vignette: 0.14, aberration: 0.0010, grain: 0.010,
    bloom: 0.55, threshold: 2.60,
  },
  // Hot orange against blue-black; the strongest glow in the set.
  volcano: {
    exposure: 1.24, gain: [1.16, 0.96, 0.84], lift: [0.016, 0.004, 0.042], hi: [1.22, 0.93, 0.70],
    contrast: 1.10, saturation: 1.14, scurve: 0.34, green: 0.35,
    vignette: 0.28, aberration: 0.0026, grain: 0.016,
    bloom: 0.85, threshold: 2.05,
  },
  // Teal ice, crisp and slightly desaturated so the flag stays the only red.
  glacier: {
    exposure: 1.40, gain: [0.96, 1.01, 1.10], lift: [0.004, 0.020, 0.046], hi: [1.02, 1.04, 1.10],
    contrast: 1.05, saturation: 1.02, scurve: 0.30, green: 0.50,
    vignette: 0.18, aberration: 0.0016, grain: 0.011,
    bloom: 0.60, threshold: 2.55,
  },
};

const SCALARS = [
  "exposure", "contrast", "saturation", "scurve", "green",
  "vignette", "aberration", "grain", "bloom", "threshold",
] as const;
const VECTORS = ["gain", "lift", "hi"] as const;

function cloneGrade(g: Grade): Grade {
  return { ...g, gain: [...g.gain], lift: [...g.lift], hi: [...g.hi] };
}

/** In-place exponential approach of `cur` toward `to`. */
function approachGrade(cur: Grade, to: Grade, k: number): void {
  for (const key of SCALARS) cur[key] += (to[key] - cur[key]) * k;
  for (const key of VECTORS) {
    const a = cur[key];
    const b = to[key];
    for (let i = 0; i < 3; i++) a[i] += (b[i] - a[i]) * k;
  }
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * Soft-kneed bright pass. Nothing under `uThreshold` linear ever glows, and the
 * threshold is set above what the sky gradient, the horizon warm band or a lit
 * cloud can reach — only genuine emissives (powerups, the ball, lava, neon)
 * survive it.
 *
 * `uEdge` fades the bright pass to black inside the buffer border. The blur
 * below samples with clamp-to-edge, so without this a bright pixel touching the
 * frame edge gets its row/column replicated outward and lands as a flat band
 * hugging the top or side of the screen — which is exactly what a downsampled
 * pass "bleeding past the screen edge" looks like.
 */
const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uThreshold, uKnee, uEdge;
varying vec2 vUv;
void main() {
  vec3 c = max(texture2D(tDiffuse, vUv).rgb, vec3(0.0));
  float peak = max(c.r, max(c.g, c.b));
  vec2 e = min(vUv, 1.0 - vUv);
  float edge = smoothstep(0.0, uEdge, min(e.x, e.y));
  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + uKnee, peak) * edge, 1.0);
}`;

/** Separable 9-tap gaussian collapsed to 5 linear-filtered samples. */
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 s = texture2D(tDiffuse, vUv).rgb * 0.227027;
  s += (texture2D(tDiffuse, vUv + uDir * 1.3846154).rgb
      + texture2D(tDiffuse, vUv - uDir * 1.3846154).rgb) * 0.3162162;
  s += (texture2D(tDiffuse, vUv + uDir * 3.2307692).rgb
      + texture2D(tDiffuse, vUv - uDir * 3.2307692).rgb) * 0.0702703;
  gl_FragColor = vec4(s, 1.0);
}`;

const GRADE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform vec3 uGain, uLift, uHi;
uniform float uExposure, uContrast, uSaturation, uSCurve, uGreen;
uniform float uVignette, uAberration, uGrain, uBloom;
uniform float uTime, uShock, uAspect;
uniform vec2 uShockAt;
varying vec2 vUv;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Matches three's ACESFilmicToneMapping exactly, so lit geometry is unchanged
// from the un-composed path apart from the grade itself.
vec3 acesFilmic(vec3 color) {
  const mat3 ACESIn = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOut = mat3(
    vec3( 1.60475, -0.10208, -0.00327),
    vec3(-0.53108,  1.10813, -0.07276),
    vec3(-0.07367, -0.00605,  1.07602));
  color = ACESIn * color;
  vec3 a = color * (color + 0.0245786) - 0.000090537;
  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  return clamp(ACESOut * (a / b), 0.0, 1.0);
}

vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(0.41666)) - 0.055, step(0.0031308, c));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = vUv;

  // Radius normalised so the corner is 1.0 at any aspect — the vignette and
  // the aberration ramp then frame a 430x932 phone like they do a laptop.
  vec2 c = (uv - 0.5) * 2.0;
  c.x *= uAspect;
  float r = length(c) / length(vec2(uAspect, 1.0));

  float shock = 0.0;
#ifdef SHOCK
  shock = uShock;
  if (shock > 0.001) {
    vec2 d = uv - uShockAt;
    d.x *= uAspect;
    float rr = length(d) + 1e-4;
    float wave = sin(rr * 24.0 - uTime * 26.0) * exp(-rr * 3.2) * shock * 0.0075;
    uv += (d / rr) * wave;
  }
#endif

  vec3 col;
#ifdef ABERRATION
  // Radial split ramped by r^2, so the centre of frame — where the ball lives
  // — stays perfectly registered. A hard impact widens it for a few frames.
  vec2 off = (uv - 0.5) * (uAberration * r * r * (1.0 + shock * 4.0));
  col.r = texture2D(tDiffuse, uv + off).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv - off).b;
#else
  col = texture2D(tDiffuse, uv).rgb;
#endif

#ifdef BLOOM
  col += texture2D(tBloom, uv).rgb * uBloom;
#endif

  // --- linear stage: exposure + white balance, then tonemap -----------------
  col = max(col, vec3(0.0)) * (uExposure / 0.6) * uGain;
  col = toSRGB(acesFilmic(col));

  // --- display stage --------------------------------------------------------
  float l = dot(col, LUMA);

  // Cool shadow lift against a warm highlight tint: the split-tone half of the
  // key/bounce read. It also pulls the deepest grass off the floor so the
  // bottom of frame keeps its texture instead of going to black.
  col += uLift * (1.0 - smoothstep(0.0, 0.62, l));
  col = mix(col, col * uHi, smoothstep(0.40, 1.0, l));

  // Fairway pop. Green-dominant pixels get brighter and swing yellow-green, so
  // the play surface is unambiguously the hottest, warmest thing on screen.
  col = clamp(col, 0.0, 1.0);
  float gw = clamp((col.g - max(col.r, col.b)) * 3.2, 0.0, 1.0);
  col = mix(col, col * vec3(1.20, 1.30, 0.84) + vec3(0.014, 0.042, 0.0), gw * uGreen);
  col = clamp(col, 0.0, 1.0);

  // Midtone S. Weighted off the toe so it widens the gap between the parallax
  // tiers and opens the upper sky without dragging the shadows down with it.
  vec3 s = col * col * (3.0 - 2.0 * col);
  col = mix(col, s, uSCurve * smoothstep(0.10, 0.38, dot(col, LUMA)));

  col = (col - 0.5) * uContrast + 0.5;
  l = dot(col, LUMA);
  col = mix(vec3(l), col, uSaturation);

  // Vignette, biased hard to the top of frame. vUv.y is 0 at the bottom of the
  // screen, which is the play area — the ball, its lie and the contact shadow
  // live there, so the falloff is scaled to ~8% before it can touch them.
  float top = mix(0.08, 1.0, smoothstep(0.18, 0.86, vUv.y));
  col *= 1.0 - uVignette * smoothstep(0.44, 1.06, r) * top;

#ifdef GRAIN
  // Also breaks up banding in the big sky gradient, which is most of the frame.
  col += (hash12(gl_FragCoord.xy + uTime * 60.0) - 0.5) * uGrain;
#endif

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// ---------------------------------------------------------------------------
// Glow
// ---------------------------------------------------------------------------

/** Quarter-resolution downsample factor for the glow chain. */
const GLOW_DIV = 4;

/** Border, in ¼-res uv, over which the bright pass fades to black. */
const GLOW_EDGE = 0.035;

/**
 * Threshold + separable blur into a private half-float target. `needsSwap` is
 * false: this pass reads the composer's colour buffer and leaves it alone, and
 * the grade pass composites the result. Three draws (or five, on 'high'), all
 * at 1/16 the pixel count.
 */
class GlowPass extends Pass {
  readonly texture: THREE.Texture;
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  private bright: THREE.ShaderMaterial;
  private blur: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private iterations: number;

  constructor(width: number, height: number, iterations: number) {
    super();
    this.needsSwap = false;
    this.iterations = iterations;

    const opts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      // Explicit: the blur taps past the border and the grade samples the
      // result full-screen. Clamped + the bright pass's edge fade means the
      // border is guaranteed black rather than a replicated bright row.
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    };
    const w = Math.max(1, Math.floor(width / GLOW_DIV));
    const h = Math.max(1, Math.floor(height / GLOW_DIV));
    this.rtA = new THREE.WebGLRenderTarget(w, h, opts);
    this.rtB = new THREE.WebGLRenderTarget(w, h, opts);
    this.texture = this.rtA.texture;

    this.bright = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uThreshold: { value: 2.5 },
        uKnee: { value: 0.9 },
        uEdge: { value: GLOW_EDGE },
      },
      vertexShader: FS_VERT,
      fragmentShader: BRIGHT_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.blur = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: FS_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.bright);
  }

  set threshold(v: number) {
    this.bright.uniforms.uThreshold.value = v;
    this.bright.uniforms.uKnee.value = Math.max(0.25, v * 0.35);
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / GLOW_DIV));
    const h = Math.max(1, Math.floor(height / GLOW_DIV));
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const w = this.rtA.width;
    const h = this.rtA.height;

    this.quad.material = this.bright;
    this.bright.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.rtA);
    this.quad.render(renderer);

    this.quad.material = this.blur;
    const dir = this.blur.uniforms.uDir.value as THREE.Vector2;
    for (let i = 0; i < this.iterations; i++) {
      // Widen each iteration so two passes reach far without extra taps.
      const spread = 1 + i * 2;
      this.blur.uniforms.tDiffuse.value = this.rtA.texture;
      dir.set(spread / w, 0);
      renderer.setRenderTarget(this.rtB);
      this.quad.render(renderer);

      this.blur.uniforms.tDiffuse.value = this.rtB.texture;
      dir.set(0, spread / h);
      renderer.setRenderTarget(this.rtA);
      this.quad.render(renderer);
    }
  }

  dispose(): void {
    this.rtA.dispose();
    this.rtB.dispose();
    this.bright.dispose();
    this.blur.dispose();
    this.quad.dispose();
  }
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

const createPostFx: SystemFactory = async (ctx) => {
  const noop: System = { name: "postfx" };

  try {
    const q = ctx.quality;
    const wantBloom = q !== "low";
    const wantFancy = q !== "low";

    const size = ctx.renderer.getSize(new THREE.Vector2());
    const pr = ctx.renderer.getPixelRatio();

    const composer = new EffectComposer(ctx.renderer);
    composer.setPixelRatio(pr);
    composer.setSize(size.x, size.y);
    composer.addPass(new RenderPass(ctx.scene, ctx.camera));

    // --- Glow ----------------------------------------------------------------
    let glow: GlowPass | null = null;
    if (wantBloom) {
      glow = new GlowPass(size.x * pr, size.y * pr, q === "high" ? 2 : 1);
      composer.addPass(glow);
    }

    // --- Grade ---------------------------------------------------------------
    // The course fires `golf:hole` at boot stage 3, long before this system
    // exists, so seed from whatever is already loaded and snap to it — hole one
    // must open on its own grade, not fade in from a default.
    const first = ctx.services.course?.current?.theme;
    const seed = (first && GRADES[first]) || GRADES.seaside;
    const cur = cloneGrade(seed);
    let target = cloneGrade(seed);

    const defines: Record<string, string> = {};
    if (wantFancy) {
      defines.ABERRATION = "";
      defines.GRAIN = "";
      defines.SHOCK = "";
    }
    if (glow) defines.BLOOM = "";

    const gradePass = new ShaderPass({
      name: "GolfGradeShader",
      defines,
      uniforms: {
        tDiffuse: { value: null },
        tBloom: { value: glow ? glow.texture : null },
        uGain: { value: new THREE.Vector3(1, 1, 1) },
        uLift: { value: new THREE.Vector3(0, 0, 0) },
        uHi: { value: new THREE.Vector3(1, 1, 1) },
        uExposure: { value: 1 },
        uContrast: { value: 1 },
        uSaturation: { value: 1 },
        uSCurve: { value: 0.32 },
        uGreen: { value: 0.9 },
        uVignette: { value: 0.20 },
        uAberration: { value: 0.0014 },
        uGrain: { value: 0.011 },
        uBloom: { value: 0.42 },
        uTime: { value: 0 },
        uShock: { value: 0 },
        uAspect: { value: Math.max(0.01, size.x / Math.max(1, size.y)) },
        uShockAt: { value: new THREE.Vector2(0.5, 0.5) },
      },
      vertexShader: FS_VERT,
      fragmentShader: GRADE_FRAG,
    });
    composer.addPass(gradePass);
    const U = gradePass.uniforms;

    // --- Anti-aliasing -------------------------------------------------------
    // Extruded slabs are long, high-contrast diagonals; SMAA is worth its two
    // extra passes on desktop, FXAA is the right trade on a phone. MSAA is
    // deliberately not used — a 4x half-float multisample pair at DPR 2 costs
    // several hundred megabytes, which a golf game does not get to spend.
    let smaa: { setSize(w: number, h: number): void; dispose?: () => void } | null = null;
    let fxaa: ShaderPass | null = null;
    if (q === "high") {
      try {
        // Dynamic so SMAA's embedded lookup textures stay out of the main chunk.
        const mod = await import("three/examples/jsm/postprocessing/SMAAPass.js");
        const pass = new mod.SMAAPass(size.x * pr, size.y * pr);
        composer.addPass(pass);
        smaa = pass;
      } catch {
        smaa = null;
      }
    }
    if (!smaa) {
      fxaa = new ShaderPass(FXAAShader);
      fxaa.material.uniforms.resolution.value.set(1 / (size.x * pr), 1 / (size.y * pr));
      composer.addPass(fxaa);
    }

    // --- Theme cross-fade ----------------------------------------------------
    const offHole = ctx.on("golf:hole", (payload) => {
      const theme = (payload as { hole?: Hole } | undefined)?.hole?.theme as CourseTheme | undefined;
      if (theme && GRADES[theme]) target = cloneGrade(GRADES[theme]);
    });

    // --- Impact wobble -------------------------------------------------------
    let shock = 0;
    const shockAt = new THREE.Vector2(0.5, 0.5);

    /** Project a world point into 0..1 screen uv through the ortho frustum. */
    function worldToUv(x: number, y: number): void {
      const cam = ctx.camera;
      const w = cam.right - cam.left;
      const h = cam.top - cam.bottom;
      if (w <= 0 || h <= 0) return;
      shockAt.set(
        THREE.MathUtils.clamp((x - cam.position.x) / w + 0.5, 0, 1),
        THREE.MathUtils.clamp((y - cam.position.y) / h + 0.5, 0, 1),
      );
    }

    const offBounce = ctx.on("golf:bounce", (payload) => {
      if (!wantFancy) return;
      const p = payload as { at?: { x: number; y: number }; speed?: number } | undefined;
      const speed = p?.speed ?? 0;
      if (speed < 15) return; // only genuinely hard hits ring the frame
      const amt = Math.min(0.8, (speed - 15) / 30);
      if (amt <= shock) return;
      shock = amt;
      if (p?.at) worldToUv(p.at.x, p.at.y);
    });

    const offShake = ctx.on("golf:shake", (payload) => {
      if (!wantFancy) return;
      const amt = typeof payload === "number" ? payload : (payload as { amount?: number } | undefined)?.amount ?? 0;
      // vfx already translates the camera; postfx only adds the ripple, so the
      // two never compound into motion sickness.
      shock = Math.min(1, Math.max(shock, Math.abs(amt) * 0.45));
    });

    let bloomPulse = 0;
    const offHoled = ctx.on("golf:holed", () => {
      if (wantBloom) bloomPulse = 0.55;
    });

    // --- Frame ---------------------------------------------------------------
    let broken = false;

    function render(dt: number): void {
      if (broken) {
        ctx.renderer.render(ctx.scene, ctx.camera);
        return;
      }
      const step = Math.min(Math.max(dt, 0), 1 / 20);

      // ~0.5 s to settle onto a new theme; slow enough to read as a dissolve.
      approachGrade(cur, target, 1 - Math.exp(-step / 0.16));

      (U.uGain.value as THREE.Vector3).set(cur.gain[0], cur.gain[1], cur.gain[2]);
      (U.uLift.value as THREE.Vector3).set(cur.lift[0], cur.lift[1], cur.lift[2]);
      (U.uHi.value as THREE.Vector3).set(cur.hi[0], cur.hi[1], cur.hi[2]);
      // Tone mapping never ran on the buffer, so the renderer's exposure is
      // folded in here instead — anyone animating it still gets what they want.
      U.uExposure.value = cur.exposure * ctx.renderer.toneMappingExposure;
      U.uContrast.value = cur.contrast;
      U.uSaturation.value = cur.saturation;
      U.uSCurve.value = cur.scurve;
      U.uGreen.value = cur.green;
      U.uVignette.value = cur.vignette;
      U.uAberration.value = cur.aberration;
      U.uGrain.value = cur.grain;
      U.uTime.value = ctx.elapsed;

      shock *= Math.exp(-step * 6.5);
      if (shock < 0.002) shock = 0;
      U.uShock.value = shock;
      (U.uShockAt.value as THREE.Vector2).copy(shockAt);

      if (glow) {
        bloomPulse *= Math.exp(-step * 3.2);
        U.uBloom.value = cur.bloom + bloomPulse;
        glow.threshold = cur.threshold;
      }

      try {
        composer.render(step);
      } catch (err) {
        // Never leave the player staring at a black screen.
        console.error("[Vibe Golf] postfx render failed, falling back:", err);
        broken = true;
        ctx.emit("golf:postfx", null);
        ctx.renderer.render(ctx.scene, ctx.camera);
      }
    }

    // Prove the chain actually draws before handing the frame over. If the
    // driver rejects half-float targets or a shader fails to compile, we find
    // out here and the player keeps the plain renderer.
    composer.render(1 / 60);
    ctx.emit("golf:postfx", render);

    return {
      name: "postfx",
      resize(w, h) {
        try {
          const ratio = ctx.renderer.getPixelRatio();
          composer.setPixelRatio(ratio);
          composer.setSize(w, h);
          U.uAspect.value = Math.max(0.01, w / Math.max(1, h));
          fxaa?.material.uniforms.resolution.value.set(1 / (w * ratio), 1 / (h * ratio));
        } catch (err) {
          console.error("[Vibe Golf] postfx resize failed:", err);
        }
      },
      dispose() {
        offHole();
        offBounce();
        offShake();
        offHoled();
        ctx.emit("golf:postfx", null);
        try {
          glow?.dispose();
          smaa?.dispose?.();
          fxaa?.dispose?.();
          gradePass.dispose?.();
          composer.dispose?.();
        } catch {
          /* teardown is best-effort */
        }
      },
    } satisfies System;
  } catch (err) {
    // A missing addon or a shader compile error costs the grade, not the game.
    console.error("[Vibe Golf] postfx unavailable, rendering unprocessed:", err);
    return noop;
  }
};

export default createPostFx;
