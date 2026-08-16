/**
 * The final image.
 *
 *   scene ──▶ HDR buffer ──┬──▶ threshold (¼ res) ──▶ blur H ──▶ blur V ──┐
 *                          │                                              ▼
 *                          └───────────────────────────────────▶ grade ──▶ screen
 *
 * Written out rather than assembled from `EffectComposer` for one reason:
 * every pass here wants to run at a quarter of the resolution, and the
 * composer's passes are all full-screen, full-size. Four small draws beat
 * two big ones on a phone by more than the plumbing costs to write.
 *
 * The chain tone maps and encodes exactly once, in the grade pass. Every
 * buffer before it is scene-linear: the sky and ice shaders write radiance,
 * the aurora is allowed to go well above 1.0, and the glow is the only
 * thing that knows what to do about that. `renderer.toneMapping` is left at
 * `NoToneMapping` so three never quietly does it a second time.
 */
import * as THREE from "three";

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const THRESHOLD = /* glsl */ `
precision highp float;
uniform sampler2D uScene;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  // Four taps at the corners of the source texel block: this pass is also
  // the downsample, and a single tap would alias the star field into a
  // flickering mess the moment the camera moves.
  vec3 c = texture2D(uScene, vUv + uTexel * vec2(-1.0, -1.0)).rgb
         + texture2D(uScene, vUv + uTexel * vec2( 1.0, -1.0)).rgb
         + texture2D(uScene, vUv + uTexel * vec2(-1.0,  1.0)).rgb
         + texture2D(uScene, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  c *= 0.25;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Soft knee, so a curtain that drifts across the threshold brightens
  // rather than switching on.
  float k = smoothstep(uThreshold, uThreshold * 2.0, luma);
  gl_FragColor = vec4(c * k, 1.0);
}
`;

const BLUR = /* glsl */ `
precision highp float;
uniform sampler2D uInput;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  // Nine-tap gaussian, sampled between texels so it costs five fetches.
  vec3 sum = texture2D(uInput, vUv).rgb * 0.2270270270;
  vec2 o1 = uDir * 1.3846153846;
  vec2 o2 = uDir * 3.2307692308;
  sum += (texture2D(uInput, vUv + o1).rgb + texture2D(uInput, vUv - o1).rgb) * 0.3162162162;
  sum += (texture2D(uInput, vUv + o2).rgb + texture2D(uInput, vUv - o2).rgb) * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}
`;

const GRADE = /* glsl */ `
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uGlow;
uniform float uGlowStrength;
uniform float uExposure;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform float uFlash;
varying vec2 vUv;

// ACES, Narkowicz's fit. Cheap, and it holds the aurora's greens together
// where Reinhard turns them into a flat mint wash.
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 col = texture2D(uScene, vUv).rgb;
  col += texture2D(uGlow, vUv).rgb * uGlowStrength;
  col *= uExposure * (1.0 + uFlash * 1.6);

  col = aces(col);

  // A cold night wants a cold shadow. Lift the blues in the darks only.
  col = mix(col, col * vec3(0.86, 0.95, 1.12), 0.5 * (1.0 - smoothstep(0.0, 0.5, col.g)));

  vec2 d = vUv - 0.5;
  col *= 1.0 - uVignette * dot(d, d) * 1.9;

  // Grain, on a night scene, is the difference between "dark" and "banded".
  float n = fract(sin(dot(vUv * 1024.0 + uTime, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) * uGrain;

  gl_FragColor = vec4(pow(max(col, 0.0), vec3(1.0 / 2.2)), 1.0);
}
`;

export interface PostFx {
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, time: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  /** 0..1 white bloom kick, for the moment a shard is taken. */
  setFlash(v: number): void;
  dispose(): void;
}

export function buildPostFx(renderer: THREE.WebGLRenderer, quality: "low" | "high"): PostFx {
  // Half-float where it exists: the aurora peaks well above 1.0 and an
  // 8-bit buffer would clip it flat before the glow ever saw it.
  const half = renderer.capabilities.isWebGL2 || renderer.extensions.has("OES_texture_half_float");
  const type = half ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const common = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
    type,
  };
  const sceneTarget = new THREE.WebGLRenderTarget(1, 1, common);
  const glowA = new THREE.WebGLRenderTarget(1, 1, { ...common, depthBuffer: false });
  const glowB = new THREE.WebGLRenderTarget(1, 1, { ...common, depthBuffer: false });

  // The mesh is handed a material per blit; the one it is constructed with
  // is three's implicit default, which nothing would ever dispose.
  const placeholder = new THREE.MeshBasicMaterial();
  const quad: THREE.Mesh<THREE.PlaneGeometry, THREE.Material> = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    placeholder,
  );
  quad.frustumCulled = false;
  const fsScene = new THREE.Scene();
  fsScene.add(quad);
  const fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const mk = (name: string, frag: string, uniforms: Record<string, THREE.IUniform>) =>
    new THREE.ShaderMaterial({
      name,
      vertexShader: VERT,
      fragmentShader: frag,
      uniforms,
      depthTest: false,
      depthWrite: false,
    });

  const thresholdMat = mk("GlassLakeThreshold", THRESHOLD, {
    uScene: { value: null },
    uTexel: { value: new THREE.Vector2() },
    // High on purpose. The aurora is a large, bright, low-contrast source,
    // so a threshold anywhere near 1.0 puts most of the sky into the blur
    // and the veil comes back down over the whole frame — the mountains
    // wash out, the ice goes milky, and the finale ends up flatter than the
    // opening. Only the burning edges of the curtains and the shards
    // themselves should be over the line.
    uThreshold: { value: half ? 1.8 : 0.72 },
  });
  const blurMat = mk("GlassLakeBlur", BLUR, {
    uInput: { value: null },
    uDir: { value: new THREE.Vector2() },
  });
  const gradeMat = mk("GlassLakeGrade", GRADE, {
    uScene: { value: null },
    uGlow: { value: null },
    uGlowStrength: { value: quality === "high" ? 0.55 : 0.4 },
    uExposure: { value: 1.15 },
    uVignette: { value: 0.5 },
    // A night scene is nearly all shadow, and grain that is right for a lit
    // frame is a sandstorm here.
    uGrain: { value: 0.012 },
    uTime: { value: 0 },
    uFlash: { value: 0 },
  });

  let w = 1;
  let h = 1;

  const blit = (material: THREE.Material, target: THREE.WebGLRenderTarget | null) => {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(fsScene, fsCamera);
  };

  return {
    setSize(width, height, pixelRatio) {
      w = Math.max(1, Math.floor(width * pixelRatio));
      h = Math.max(1, Math.floor(height * pixelRatio));
      sceneTarget.setSize(w, h);
      const gw = Math.max(1, Math.floor(w / 4));
      const gh = Math.max(1, Math.floor(h / 4));
      glowA.setSize(gw, gh);
      glowB.setSize(gw, gh);
      (thresholdMat.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    },

    setFlash(v) {
      gradeMat.uniforms.uFlash.value = v;
    },

    render(r, scene, camera, time) {
      r.setRenderTarget(sceneTarget);
      r.clear();
      r.render(scene, camera);

      thresholdMat.uniforms.uScene.value = sceneTarget.texture;
      blit(thresholdMat, glowA);

      const gw = glowA.width;
      const gh = glowA.height;
      blurMat.uniforms.uInput.value = glowA.texture;
      (blurMat.uniforms.uDir.value as THREE.Vector2).set(1 / gw, 0);
      blit(blurMat, glowB);
      blurMat.uniforms.uInput.value = glowB.texture;
      (blurMat.uniforms.uDir.value as THREE.Vector2).set(0, 1 / gh);
      blit(blurMat, glowA);

      gradeMat.uniforms.uScene.value = sceneTarget.texture;
      gradeMat.uniforms.uGlow.value = glowA.texture;
      gradeMat.uniforms.uTime.value = time;
      blit(gradeMat, null);
    },

    dispose() {
      sceneTarget.dispose();
      glowA.dispose();
      glowB.dispose();
      quad.geometry.dispose();
      placeholder.dispose();
      thresholdMat.dispose();
      blurMat.dispose();
      gradeMat.dispose();
    },
  };
}
