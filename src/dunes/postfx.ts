/**
 * The Dune Sea — the final image.
 *
 * Same three-stage shape as the Glass Lake's (threshold at quarter res,
 * separable blur, one grade that tone maps exactly once) and deliberately
 * not shared with it: the two worlds want opposite grades, and a knob
 * tuned for a sunset should never be able to cool down a night sky by
 * accident. The structure is the borrowed part; every constant is this
 * world's own.
 */
import * as THREE from "three";

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const THRESHOLD = /* glsl */ `
precision highp float;
uniform sampler2D uScene; uniform vec2 uTexel; uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uScene, vUv + uTexel * vec2(-1.0, -1.0)).rgb
         + texture2D(uScene, vUv + uTexel * vec2( 1.0, -1.0)).rgb
         + texture2D(uScene, vUv + uTexel * vec2(-1.0,  1.0)).rgb
         + texture2D(uScene, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  c *= 0.25;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold * 2.0, luma), 1.0);
}
`;

const BLUR = /* glsl */ `
precision highp float;
uniform sampler2D uInput; uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 sum = texture2D(uInput, vUv).rgb * 0.2270270270;
  vec2 o1 = uDir * 1.3846153846, o2 = uDir * 3.2307692308;
  sum += (texture2D(uInput, vUv + o1).rgb + texture2D(uInput, vUv - o1).rgb) * 0.3162162162;
  sum += (texture2D(uInput, vUv + o2).rgb + texture2D(uInput, vUv - o2).rgb) * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}
`;

const GRADE = /* glsl */ `
precision highp float;
uniform sampler2D uScene; uniform sampler2D uGlow;
uniform float uGlowStrength; uniform float uExposure; uniform float uVignette;
uniform float uGrain; uniform float uTime; uniform float uHeat;
varying vec2 vUv;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  // Heat shimmer: a slow vertical wobble that only touches the bottom half
  // of the frame, where the air is against hot sand. Two sine terms, not a
  // noise texture — anything stronger reads as a broken render.
  vec2 uv = vUv;
  float low = smoothstep(0.65, 0.15, vUv.y);
  uv.x += sin(vUv.y * 90.0 + uTime * 2.2) * 0.0013 * low * uHeat;

  vec3 col = texture2D(uScene, uv).rgb;
  col += texture2D(uGlow, uv).rgb * uGlowStrength;
  col *= uExposure;
  col = aces(col);

  // Warm the highlights, cool the shadows: the whole point of a desert
  // grade, and the thing that keeps lee faces blue instead of grey.
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col *= mix(vec3(0.88, 0.94, 1.14), vec3(1.06, 1.0, 0.94), smoothstep(0.15, 0.75, luma));

  vec2 d = vUv - 0.5;
  col *= 1.0 - uVignette * dot(d, d) * 1.8;

  float n = fract(sin(dot(vUv * 1024.0 + uTime, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) * uGrain;

  gl_FragColor = vec4(pow(max(col, 0.0), vec3(1.0 / 2.2)), 1.0);
}
`;

export interface DunePostFx {
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, time: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  /** 0..1 — how much the air shimmers. Falls off with the sun. */
  setHeat(v: number): void;
  dispose(): void;
}

export function buildPostFx(renderer: THREE.WebGLRenderer, quality: "low" | "high"): DunePostFx {
  const half = renderer.capabilities.isWebGL2 || renderer.extensions.has("OES_texture_half_float");
  const type = half ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const common = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type };
  const sceneTarget = new THREE.WebGLRenderTarget(1, 1, { ...common, depthBuffer: true });
  const glowA = new THREE.WebGLRenderTarget(1, 1, { ...common, depthBuffer: false });
  const glowB = new THREE.WebGLRenderTarget(1, 1, { ...common, depthBuffer: false });

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

  const thresholdMat = mk("DuneThreshold", THRESHOLD, {
    uScene: { value: null },
    uTexel: { value: new THREE.Vector2() },
    // Only the disc. This is a *bright* world — the sky fills the top half
    // of the frame at around 1.5, so a threshold of 2.2 put the entire sky
    // into the blur and the blur came back down over the sand as a flat
    // pale veil. The dunes were rendering correctly the whole time and you
    // could not see them through it.
    uThreshold: { value: half ? 4.5 : 1.4 },
  });
  const blurMat = mk("DuneBlur", BLUR, {
    uInput: { value: null },
    uDir: { value: new THREE.Vector2() },
  });
  const gradeMat = mk("DuneGrade", GRADE, {
    uScene: { value: null },
    uGlow: { value: null },
    uGlowStrength: { value: quality === "high" ? 0.45 : 0.32 },
    uExposure: { value: 1.05 },
    uVignette: { value: 0.42 },
    uGrain: { value: 0.014 },
    uTime: { value: 0 },
    uHeat: { value: 1 },
  });

  const blit = (material: THREE.Material, target: THREE.WebGLRenderTarget | null) => {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(fsScene, fsCamera);
  };

  return {
    setSize(width, height, pixelRatio) {
      const w = Math.max(1, Math.floor(width * pixelRatio));
      const h = Math.max(1, Math.floor(height * pixelRatio));
      sceneTarget.setSize(w, h);
      glowA.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
      glowB.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
      (thresholdMat.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    },
    setHeat(v) {
      gradeMat.uniforms.uHeat.value = v;
    },
    render(r, scene, camera, time) {
      r.setRenderTarget(sceneTarget);
      r.clear();
      r.render(scene, camera);

      thresholdMat.uniforms.uScene.value = sceneTarget.texture;
      blit(thresholdMat, glowA);
      blurMat.uniforms.uInput.value = glowA.texture;
      (blurMat.uniforms.uDir.value as THREE.Vector2).set(1 / glowA.width, 0);
      blit(blurMat, glowB);
      blurMat.uniforms.uInput.value = glowB.texture;
      (blurMat.uniforms.uDir.value as THREE.Vector2).set(0, 1 / glowA.height);
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
