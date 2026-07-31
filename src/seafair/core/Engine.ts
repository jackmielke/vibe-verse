import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { bus } from "./EventBus";
import type { QualityProfile } from "./Settings";

/**
 * Owns the renderer, composer, clock and the fixed-step / variable-step loop.
 * World and system modules subscribe via `onUpdate`. Nothing else should call
 * renderer.render directly.
 */

/** Filmic grade + grain + vignette + chromatic aberration, applied last. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uGrain: { value: 0.035 },
    uVignette: { value: 0.34 },
    uAberration: { value: 0.0016 },
    uExposure: { value: 1.0 },
    uSaturation: { value: 1.06 },
    uContrast: { value: 1.04 },
    uLift: { value: new THREE.Vector3(0.004, 0.008, 0.018) },
    uGain: { value: new THREE.Vector3(1.02, 1.0, 0.985) },
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
    uniform float uTime, uGrain, uVignette, uAberration, uExposure, uSaturation, uContrast, uDamage, uFlash;
    uniform vec3 uLift, uGain;
    varying vec2 vUv;

    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }

    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);

      // barrel-ish chromatic aberration, stronger at edges
      float ab = uAberration * (1.0 + r2 * 2.5);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ab).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ab).b;

      col *= uExposure;

      // lift/gain grade
      col = col * uGain + uLift;

      // contrast around 0.18 mid grey
      col = (col - 0.18) * uContrast + 0.18;

      // saturation
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);

      // vignette
      col *= 1.0 - uVignette * smoothstep(0.15, 0.85, r2 * 1.6);

      // damage tint — red pulse from the edges inward
      if (uDamage > 0.001) {
        float edge = smoothstep(0.06, 0.55, r2);
        col = mix(col, vec3(0.62, 0.03, 0.05), edge * uDamage * 0.85);
      }

      // muzzle / explosion flash
      col += uFlash;

      // film grain (luma-weighted so shadows stay clean)
      float g = hash(uv * vec2(1920.0, 1080.0) + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain * (0.35 + 0.65 * (1.0 - l));

      gl_FragColor = vec4(max(col, 0.0), 1.0);
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
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
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
    this.composer.passes.length = 0;

    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);

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
      const bloom = new UnrealBloomPass(
        new THREE.Vector2(w, h),
        this.profile.tier === "low" ? 0.32 : 0.46,
        0.72,
        0.86,
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
    this.composer.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
