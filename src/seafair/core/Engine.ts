import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { Pass, FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { bus } from "./EventBus";
import type { QualityProfile } from "./Settings";
import { ATMOSPHERE_GLSL, atmosphere } from "../world/Sky";

/**
 * Owns the renderer, composer, clock and the fixed-step / variable-step loop.
 * World and system modules subscribe via `onUpdate`. Nothing else should call
 * renderer.render directly.
 *
 * Colour pipeline — the whole chain lives here and nowhere else:
 *
 *   scene (scene-linear HDR, half-float)
 *     -> AtmospherePass   aerial perspective + crepuscular rays, still linear
 *     -> GTAO             ambient occlusion
 *     -> UnrealBloom      linear-HDR highlights only
 *     -> GradePass        exposure -> AgX filmic -> look -> sRGB encode
 *     -> SMAA             edge AA, on display-referred pixels where it belongs
 *
 * three does *not* apply `renderer.toneMapping` when a material renders into a
 * render target, and EffectComposer never adds an OutputPass, so the tone map
 * and the sRGB encode have to be explicit in the grade. That is why
 * `renderer.toneMapping` is deliberately NoToneMapping below.
 */

/**
 * Screen-space atmosphere. Renders the scene into its own HDR target with a
 * depth texture, then composites:
 *
 *  - aerial perspective, evaluated per pixel from the same single-scattering
 *    model the sky dome uses, so a building 3 km out picks up exactly the air
 *    that is painted behind it — warm and bright toward the sun, blue away.
 *  - crepuscular rays, by marching the depth buffer toward the sun's screen
 *    position and counting unoccluded samples.
 */
class AtmospherePass extends Pass {
  readonly sceneRT: THREE.WebGLRenderTarget;
  private readonly fsQuad: FullScreenQuad;
  private readonly material: THREE.ShaderMaterial;
  private readonly invViewProj = new THREE.Matrix4();
  private readonly sunWorld = new THREE.Vector3();
  private readonly camFwd = new THREE.Vector3();

  constructor(
    private readonly rtScene: THREE.Scene,
    private readonly rtCamera: THREE.Camera,
    width: number,
    height: number,
    profile: QualityProfile,
  ) {
    super();
    this.needsSwap = false;

    const depth = new THREE.DepthTexture(width, height);
    depth.format = THREE.DepthFormat;
    depth.type = THREE.UnsignedIntType;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;

    this.sceneRT = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      depthTexture: depth,
      stencilBuffer: false,
    });

    const godrays = profile.volumetrics >= 1;
    const samples = profile.volumetrics >= 2 ? 48 : 24;

    this.material = new THREE.ShaderMaterial({
      defines: {
        GODRAYS: godrays ? "1" : "0",
        GODRAY_SAMPLES: String(samples),
      },
      uniforms: {
        tDiffuse: { value: null as THREE.Texture | null },
        tDepth: { value: depth as THREE.Texture },
        uInvViewProj: { value: new THREE.Matrix4() },
        uCameraPos: { value: new THREE.Vector3() },
        uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
        uSunOnScreen: { value: 0 },
        uGodRay: { value: profile.volumetrics >= 2 ? 0.5 : 0.42 },
        uAerialR: { value: atmosphere.aerialRayleigh },
        uAerialM: { value: atmosphere.aerialMie },
        uSunDirection: { value: new THREE.Vector3() },
        uSunTint: { value: new THREE.Vector3(1, 1, 1) },
        uRayleigh: { value: 1 },
        uMie: { value: 1 },
        uMieG: { value: 0.76 },
        uSkyLuminance: { value: 23 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform mat4 uInvViewProj;
        uniform vec3 uCameraPos;
        uniform vec2 uSunScreen;
        uniform float uSunOnScreen, uGodRay, uAerialR, uAerialM;
        varying vec2 vUv;

        ${ATMOSPHERE_GLSL}

        // Nothing writes depth behind the sky dome, so the cleared value is an
        // exact 1.0 and anything below it is real geometry.
        const float SKY_DEPTH = 0.999999;

        void main() {
          vec3 col = texture2D(tDiffuse, vUv).rgb;
          float d = texture2D(tDepth, vUv).x;

          if (d < SKY_DEPTH) {
            vec4 clip = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
            vec4 wp = uInvViewProj * clip;
            vec3 delta = wp.xyz / wp.w - uCameraPos;
            float dist = length(delta);
            vec3 rd = delta / max(dist, 1e-4);

            // Ground-level slab: the scene never climbs far enough for the
            // exponential density falloff to matter over these distances.
            vec3  tauR = BETA_R * uRayleigh * uAerialR * dist;
            float tauM = BETA_M * uMie * uAerialM * dist;

            float c = dot(rd, uSunDirection);
            vec3  inR = rayleighPhase(c) * (1.0 - exp(-tauR));
            float inM = hgPhase(c, uMieG) * (1.0 - exp(-tauM));

            vec3 Tr = exp(-(tauR + vec3(tauM)));
            vec3 inscatter = (inR + vec3(inM)) * uSkyLuminance * uSunTint;
            col = col * Tr + inscatter;
          }

          #if GODRAYS
          if (uSunOnScreen > 0.001) {
            vec2 delta = (uSunScreen - vUv) / float(GODRAY_SAMPLES);
            vec2 uv = vUv;
            float illum = 1.0;
            float acc = 0.0;
            // Dither the start so the ray steps do not band across flat sky.
            float j = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
            uv += delta * j;
            for (int i = 0; i < GODRAY_SAMPLES; i++) {
              uv += delta;
              float sd = texture2D(tDepth, clamp(uv, 0.0, 1.0)).x;
              acc += step(SKY_DEPTH, sd) * illum;
              illum *= 0.965;                        // exponential decay along the shaft
            }
            acc /= float(GODRAY_SAMPLES);
            // Shafts only read where the sun is actually being cut by something.
            float shaft = acc * acc;
            col += uSunTint * uSkyLuminance * 0.055 * uGodRay * shaft * uSunOnScreen;
          }
          #endif

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });

    this.fsQuad = new FullScreenQuad(this.material);
  }

  setSize(width: number, height: number): void {
    this.sceneRT.setSize(width, height);
  }

  private syncAtmosphere(): void {
    const u = this.material.uniforms;
    u.uSunDirection.value.copy(atmosphere.sunDirection);
    u.uSunTint.value.set(atmosphere.sunTint.r, atmosphere.sunTint.g, atmosphere.sunTint.b);
    u.uRayleigh.value = atmosphere.rayleigh;
    u.uMie.value = atmosphere.mie;
    u.uMieG.value = atmosphere.mieG;
    u.uSkyLuminance.value = atmosphere.skyLuminance;
    u.uAerialR.value = atmosphere.aerialRayleigh;
    u.uAerialM.value = atmosphere.aerialMie;

    const cam = this.rtCamera as THREE.PerspectiveCamera;
    this.invViewProj.multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);
    u.uInvViewProj.value.copy(this.invViewProj);
    u.uCameraPos.value.setFromMatrixPosition(cam.matrixWorld);

    cam.getWorldDirection(this.camFwd);
    const facing = this.camFwd.dot(atmosphere.sunDirection);
    if (facing <= 0.05) {
      u.uSunOnScreen.value = 0;
      return;
    }
    this.sunWorld.copy(u.uCameraPos.value).addScaledVector(atmosphere.sunDirection, 8000);
    this.sunWorld.project(cam);
    u.uSunScreen.value.set(this.sunWorld.x * 0.5 + 0.5, this.sunWorld.y * 0.5 + 0.5);
    // Fade the shafts out as the sun leaves the frame instead of popping.
    const off = Math.max(Math.abs(this.sunWorld.x), Math.abs(this.sunWorld.y));
    u.uSunOnScreen.value = THREE.MathUtils.smoothstep(off, 1.9, 0.75) * Math.min(1, facing * 4);
  }

  render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const prev = renderer.getRenderTarget();

    renderer.setRenderTarget(this.sceneRT);
    renderer.clear();
    renderer.render(this.rtScene, this.rtCamera);

    this.material.uniforms.tDiffuse.value = this.sceneRT.texture;
    this.syncAtmosphere();

    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);

    renderer.setRenderTarget(prev);
  }

  dispose(): void {
    this.sceneRT.dispose();
    this.material.dispose();
    this.fsQuad.dispose();
  }
}

/**
 * Tone map + grade + lens artefacts, applied last before AA.
 *
 * AgX rather than ACES: the sun is in frame for most of this game and ACES'
 * RRT skews bright blues cyan and clips the solar halo to a flat white plate.
 * AgX keeps chromatic highlights rolling smoothly to white over ~6 stops,
 * which is what lets you look near the sun without the frame giving up. The
 * "punchy" look transform afterwards buys back the contrast and saturation
 * that the log-sigmoid costs.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uGrain: { value: 0.022 },
    uVignette: { value: 0.26 },
    uAberration: { value: 0.0009 },
    uExposure: { value: 1.0 },
    uSaturation: { value: 1.03 },
    uContrast: { value: 1.02 },
    uLookPower: { value: 1.18 },
    uLookSat: { value: 1.28 },
    uLift: { value: new THREE.Vector3(0.0, 0.002, 0.006) },
    uGain: { value: new THREE.Vector3(1.015, 1.0, 0.99) },
    uDamage: { value: 0 },
    uFlash: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uGrain, uVignette, uAberration, uExposure, uSaturation, uContrast;
    uniform float uLookPower, uLookSat, uDamage, uFlash;
    uniform vec3 uLift, uGain;
    varying vec2 vUv;

    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

    // --- AgX (Blender / Filament formulation, rec2020 working primaries) ---
    const mat3 SRGB_TO_REC2020 = mat3(
      vec3(0.6274, 0.0691, 0.0164),
      vec3(0.3293, 0.9195, 0.0880),
      vec3(0.0433, 0.0113, 0.8956));
    const mat3 REC2020_TO_SRGB = mat3(
      vec3( 1.6605, -0.1246, -0.0182),
      vec3(-0.5876,  1.1329, -0.1006),
      vec3(-0.0728, -0.0083,  1.1187));
    const mat3 AGX_INSET = mat3(
      vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
      vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
      vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
    const mat3 AGX_OUTSET = mat3(
      vec3( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
      vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
      vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));

    // Latitude of the log-encoded working range, in stops around 0.18.
    const float AGX_MIN_EV = -12.47393;
    const float AGX_MAX_EV = 4.026069;

    vec3 agxContrast(vec3 x) {
      vec3 x2 = x * x;
      vec3 x4 = x2 * x2;
      return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
           - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
    }

    vec3 agx(vec3 color) {
      color = SRGB_TO_REC2020 * max(color, 0.0);
      color = AGX_INSET * color;
      color = log2(max(color, 1e-10));
      color = clamp((color - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0.0, 1.0);
      color = agxContrast(color);

      // "Punchy" look: gamma down the mids, then re-saturate. Done here, in the
      // sigmoid's output space, so it cannot push anything back out of gamut.
      color = pow(max(color, 0.0), vec3(uLookPower));
      float l = dot(color, LUMA);
      color = l + (color - l) * uLookSat;

      color = AGX_OUTSET * color;
      color = pow(max(color, 0.0), vec3(2.2));
      color = REC2020_TO_SRGB * color;
      return clamp(color, 0.0, 1.0);
    }

    vec3 encodeSRGB(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055,
                 step(vec3(0.0031308), c));
    }

    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }

    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);

      // Lateral chromatic aberration, stronger at the edges. Kept small — on an
      // HDR buffer a wide split fringes the sun into a rainbow.
      float ab = uAberration * (1.0 + r2 * 2.5);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ab).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ab).b;

      col = agx(max(col, 0.0) * uExposure);

      // Display-referred trim.
      col = col * uGain + uLift;
      col = (col - 0.18) * uContrast + 0.18;
      float l = dot(col, LUMA);
      col = mix(vec3(l), col, uSaturation);

      col *= 1.0 - uVignette * smoothstep(0.15, 0.85, r2 * 1.6);

      if (uDamage > 0.001) {
        float edge = smoothstep(0.06, 0.55, r2);
        col = mix(col, vec3(0.62, 0.03, 0.05), edge * uDamage * 0.85);
      }

      col += uFlash;

      float g = hash(uv * vec2(1920.0, 1080.0) + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain * (0.35 + 0.65 * (1.0 - l));

      gl_FragColor = vec4(encodeSRGB(clamp(col, 0.0, 1.0)), 1.0);
    }
  `,
};

export interface EngineHooks {
  onUpdate?: (dt: number, elapsed: number) => void;
  onFixed?: (dt: number) => void;
  onResize?: (w: number, h: number) => void;
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly composer: EffectComposer;
  readonly clock = new THREE.Clock();
  readonly canvas: HTMLCanvasElement;

  profile: QualityProfile;
  gradePass!: ShaderPass;
  bloomPass?: UnrealBloomPass;
  gtaoPass?: GTAOPass;
  atmospherePass?: AtmospherePass;
  running = false;

  /** current adaptive resolution scale, 0.55..1 */
  renderScale = 1;

  private hooks: EngineHooks = {};
  private raf = 0;
  private accumulator = 0;
  private readonly fixedStep = 1 / 90;
  private frameTimes: number[] = [];
  private statTimer = 0;
  private adaptTimer = 0;

  constructor(container: HTMLElement, profile: QualityProfile) {
    this.profile = profile;

    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.display = "block";
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, profile.maxPixelRatio));
    this.renderer.setSize(container.clientWidth, container.clientHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // The grade pass tone maps and encodes. three would skip its own tone
    // mapping anyway while rendering into the composer's targets, so leaving it
    // on here would only mislead.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = profile.shadowMapSize > 0;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      78,
      container.clientWidth / container.clientHeight,
      0.08,
      profile.drawDistance,
    );
    this.camera.position.set(0, 1.7, 0);
    this.scene.add(this.camera);

    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio, profile.maxPixelRatio));
    this.buildPasses(container.clientWidth, container.clientHeight);

    this.onWindowResize = this.onWindowResize.bind(this);
    window.addEventListener("resize", this.onWindowResize);
    window.addEventListener("orientationchange", this.onWindowResize);
  }

  private buildPasses(w: number, h: number): void {
    this.atmospherePass?.dispose();
    this.composer.passes.length = 0;

    const atmos = new AtmospherePass(this.scene, this.camera, w, h, this.profile);
    this.atmospherePass = atmos;
    this.composer.addPass(atmos);

    if (this.profile.ssao) {
      const gtao = new GTAOPass(this.scene, this.camera, w, h);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.updateGtaoMaterial({
        radius: 0.4,
        distanceExponent: 1.2,
        thickness: 1.0,
        scale: 1.0,
        samples: this.profile.tier === "ultra" ? 16 : 8,
        screenSpaceRadius: false,
      });
      this.gtaoPass = gtao;
      this.composer.addPass(gtao);
    }

    if (this.profile.bloom) {
      // Must sit above the SKY, not merely above sunlit diffuse. Sky.ts
      // calibrates its horizon band at ~1.7 linear, so the old 1.25 threshold
      // put the entire horizon into bloom and smeared a blue-white veil across
      // the whole frame — which is what was draining chroma out of the ground
      // and making the lake read as a grey plate. 2.6 clears the horizon while
      // still catching the sun disc (~105), specular glints and emissives.
      const bloom = new UnrealBloomPass(
        new THREE.Vector2(w, h),
        this.profile.tier === "low" ? 0.16 : 0.22,
        0.6,
        2.6,
      );
      this.bloomPass = bloom;
      this.composer.addPass(bloom);
    }

    this.gradePass = new ShaderPass(GradeShader);
    this.gradePass.renderToScreen = false;
    this.composer.addPass(this.gradePass);

    const smaa = new SMAAPass(w, h);
    smaa.renderToScreen = true;
    this.composer.addPass(smaa);

    // Push the effective (pixel-ratio scaled) size into every pass we just made.
    this.composer.setSize(w, h);
  }

  setHooks(h: EngineHooks): void {
    this.hooks = h;
  }

  setProfile(profile: QualityProfile): void {
    this.profile = profile;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, profile.maxPixelRatio));
    this.renderer.shadowMap.enabled = profile.shadowMapSize > 0;
    this.camera.far = profile.drawDistance;
    this.camera.updateProjectionMatrix();
    const el = this.canvas.parentElement;
    if (el) this.buildPasses(el.clientWidth, el.clientHeight);
    this.onWindowResize();
  }

  setFov(fov: number): void {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  private onWindowResize(): void {
    const el = this.canvas.parentElement;
    if (!el) return;
    const w = el.clientWidth || window.innerWidth;
    const h = el.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.hooks.onResize?.(w, h);
  }

  /** Adaptive resolution: keeps frame time under budget on weak hardware. */
  private adapt(dt: number): void {
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    this.adaptTimer += dt;
    if (this.adaptTimer < 1.0 || this.frameTimes.length < 45) return;
    this.adaptTimer = 0;

    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const target = 1 / 58;
    const prev = this.renderScale;

    if (p90 > target * 1.22) this.renderScale = Math.max(0.55, this.renderScale - 0.08);
    else if (p90 < target * 0.78) this.renderScale = Math.min(1, this.renderScale + 0.05);

    if (Math.abs(prev - this.renderScale) > 0.001) {
      const base = Math.min(window.devicePixelRatio, this.profile.maxPixelRatio);
      this.renderer.setPixelRatio(base * this.renderScale);
      this.composer.setPixelRatio(base * this.renderScale);
      this.onWindowResize();
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(this.clock.getDelta(), 0.05);
      const elapsed = this.clock.elapsedTime;

      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= this.fixedStep && steps < 5) {
        this.hooks.onFixed?.(this.fixedStep);
        this.accumulator -= this.fixedStep;
        steps++;
      }

      this.hooks.onUpdate?.(dt, elapsed);

      this.gradePass.uniforms.uTime.value = elapsed;

      this.renderer.info.reset();
      this.composer.render(dt);

      this.adapt(dt);

      this.statTimer += dt;
      if (this.statTimer > 0.5) {
        this.statTimer = 0;
        const avg = this.frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, this.frameTimes.length);
        bus.emit("perf:stats", {
          fps: Math.round(1 / Math.max(avg, 1e-4)),
          ms: +(avg * 1000).toFixed(1),
          drawCalls: this.renderer.info.render.calls,
          triangles: this.renderer.info.render.triangles,
          tier: `${this.profile.tier}@${Math.round(this.renderScale * 100)}%`,
        });
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose(): void {
    this.stop();
    window.removeEventListener("resize", this.onWindowResize);
    window.removeEventListener("orientationchange", this.onWindowResize);
    this.atmospherePass?.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
