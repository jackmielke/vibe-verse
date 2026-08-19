/**
 * The final image.
 *
 *   scene ──▶ HDR buffer ──┬──▶ threshold (¼ res) ──▶ blur H ──▶ blur V ──┐
 *                          │                                              ▼
 *                          └───────────────────────────────────▶ grade ──▶ screen
 *
 * Hand-assembled rather than pulled from `EffectComposer` for the reason
 * `glasslake/postfx.ts` gives and this world needs twice over: every pass here
 * wants to run at a quarter resolution and the composer's are all full-size.
 *
 * The bloom is the load-bearing part. Every luminous thing in The Empyrean —
 * the sun on the horizon, the glass slabs, four hundred terrace lamps, the
 * jets — is written well above 1.0 by its own shader and is a flat colour
 * until something bleeds it. `renderer.toneMapping` is left at `NoToneMapping`
 * so the grade pass is the only place in the world where the mapping happens,
 * exactly once.
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
  // Four corner taps: this pass is also the downsample, and a single tap
  // turns the star field into a flickering mess the moment the camera moves.
  vec3 c = texture2D(uScene, vUv + uTexel * vec2(-1.0, -1.0)).rgb
         + texture2D(uScene, vUv + uTexel * vec2( 1.0, -1.0)).rgb
         + texture2D(uScene, vUv + uTexel * vec2(-1.0,  1.0)).rgb
         + texture2D(uScene, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  c *= 0.25;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
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
  // Nine-tap gaussian sampled between texels, so it costs five fetches.
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
uniform float uGlow2;
uniform float uExposure;
uniform float uTime;
varying vec2 vUv;

// ACES, Narkowicz's fit. Cheap, and it keeps the gold from going to paper
// white the moment you look near the sun — which, in this world, is often.
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  /* A whisper of chromatic aberration, radial, strongest at the corners.
   * At this strength you cannot see it as fringing; you see it as a lens. */
  vec2 d = vUv - 0.5;
  float r2 = dot(d, d);
  vec2 ca = d * r2 * 0.010;
  vec3 col;
  col.r = texture2D(uScene, vUv + ca).r;
  col.g = texture2D(uScene, vUv).g;
  col.b = texture2D(uScene, vUv - ca).b;

  col += texture2D(uGlow, vUv).rgb * uGlow2;
  col *= uExposure;
  col = aces(col);

  /* Grade: lift the shadows toward violet and pull the highlights toward
   * gold. This is the entire difference between "a sunset" and "that
   * sunset" — the reference has no neutral greys in it anywhere. */
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col * vec3(0.94, 0.93, 1.10), col * vec3(1.05, 1.00, 0.94), smoothstep(0.15, 0.85, luma));
  col += vec3(0.030, 0.012, 0.045) * (1.0 - smoothstep(0.0, 0.35, luma));

  // Gentle saturation lift; the ACES curve costs some on the way through.
  col = mix(vec3(luma), col, 1.24);

  // Vignette.
  col *= 1.0 - smoothstep(0.32, 0.95, length(d) * 1.35) * 0.42;

  // Dither. Eight bits across a sky this smooth is visible banding, and this
  // is a world made almost entirely of smooth sky.
  float n = fract(sin(dot(gl_FragCoord.xy + uTime, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) / 255.0;

  gl_FragColor = vec4(col, 1.0);
}
`;

export interface PostFx {
  /** Render the scene through the chain and onto the screen. */
  render(scene: THREE.Scene, camera: THREE.Camera, time: number): void;
  setSize(w: number, h: number): void;
  dispose(): void;
}

export function buildPostFx(renderer: THREE.WebGLRenderer, tier: "low" | "high"): PostFx {
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const quad = new THREE.Mesh(quadGeo);
  quadScene.add(quad);

  const size = new THREE.Vector2();
  renderer.getSize(size);
  const dpr = renderer.getPixelRatio();
  let w = Math.max(1, Math.floor(size.x * dpr));
  let h = Math.max(1, Math.floor(size.y * dpr));

  const rtOpts = {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  } as const;

  const sceneRT = new THREE.WebGLRenderTarget(w, h, rtOpts);
  const DIV = tier === "high" ? 4 : 6;
  const glowA = new THREE.WebGLRenderTarget(Math.max(1, w / DIV), Math.max(1, h / DIV), {
    ...rtOpts,
    depthBuffer: false,
  });
  const glowB = new THREE.WebGLRenderTarget(Math.max(1, w / DIV), Math.max(1, h / DIV), {
    ...rtOpts,
    depthBuffer: false,
  });

  const thresholdMat = new THREE.RawShaderMaterial({
    vertexShader: `precision highp float;\nattribute vec3 position;\nattribute vec2 uv;\nvarying vec2 vUv;\nvoid main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`,
    fragmentShader: THRESHOLD,
    uniforms: {
      uScene: { value: sceneRT.texture },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      // Above 1, so only things that genuinely exceed white bleed: the sun,
      // the lamps, the jets and the crowns of the towers. Set under 1 it also
      // caught the sky and the snow, and standing anywhere near a lit surface
      // turned the frame into fog.
      uThreshold: { value: 1.05 },
    },
    depthTest: false,
    depthWrite: false,
  });

  const mkBlur = (input: THREE.Texture) =>
    new THREE.RawShaderMaterial({
      vertexShader: `precision highp float;\nattribute vec3 position;\nattribute vec2 uv;\nvarying vec2 vUv;\nvoid main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`,
      fragmentShader: BLUR,
      uniforms: {
        uInput: { value: input },
        uDir: { value: new THREE.Vector2() },
      },
      depthTest: false,
      depthWrite: false,
    });
  const blurH = mkBlur(glowA.texture);
  const blurV = mkBlur(glowB.texture);

  const gradeMat = new THREE.RawShaderMaterial({
    vertexShader: `precision highp float;\nattribute vec3 position;\nattribute vec2 uv;\nvarying vec2 vUv;\nvoid main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`,
    fragmentShader: GRADE,
    uniforms: {
      uScene: { value: sceneRT.texture },
      uGlow: { value: glowA.texture },
      uGlow2: { value: tier === "high" ? 0.62 : 0.5 },
      uExposure: { value: 0.94 },
      uTime: { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
  });

  const draw = (mat: THREE.Material, target: THREE.WebGLRenderTarget | null) => {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
  };

  return {
    render(scene, camera, time) {
      renderer.setRenderTarget(sceneRT);
      renderer.clear();
      renderer.render(scene, camera);

      // Threshold ¼ → blur horizontally into B → blur vertically back into A,
      // so the grade always reads A whichever pass wrote it last.
      draw(thresholdMat, glowA);
      (blurH.uniforms.uDir.value as THREE.Vector2).set(1.35 / (w / DIV), 0);
      draw(blurH, glowB);
      (blurV.uniforms.uDir.value as THREE.Vector2).set(0, 1.35 / (h / DIV));
      draw(blurV, glowA);

      gradeMat.uniforms.uTime.value = time;
      draw(gradeMat, null);
    },
    setSize(nw, nh) {
      const ratio = renderer.getPixelRatio();
      w = Math.max(1, Math.floor(nw * ratio));
      h = Math.max(1, Math.floor(nh * ratio));
      sceneRT.setSize(w, h);
      glowA.setSize(Math.max(1, Math.floor(w / DIV)), Math.max(1, Math.floor(h / DIV)));
      glowB.setSize(Math.max(1, Math.floor(w / DIV)), Math.max(1, Math.floor(h / DIV)));
      (thresholdMat.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    },
    dispose() {
      sceneRT.dispose();
      glowA.dispose();
      glowB.dispose();
      thresholdMat.dispose();
      blurH.dispose();
      blurV.dispose();
      gradeMat.dispose();
      quadGeo.dispose();
    },
  };
}
