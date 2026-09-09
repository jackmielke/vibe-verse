/**
 * The post pipeline. The scene is drawn once into a half-float target with a
 * real depth texture, and everything after that is screen space:
 *
 *   scene -> ambient occlusion (GTAO, from that depth, so the fern and fir
 *   cutouts stay clean) -> atmosphere (AO multiply, the far shadow tier,
 *   aerial perspective, low mist, exposure) -> bloom on what is brighter than
 *   white -> tone map and grade -> SMAA.
 *
 * Haze is done here rather than with scene.fog so it also reaches the sea and
 * anything else drawn by a shader that never read the fog uniforms. The far
 * shadow tier is the map of a zero-intensity light the sky owns: for pixels
 * outside the sharp near box it is projected and compared here, with a fade
 * across the box edge so there is no seam where one tier hands over to the
 * other. Everything the sky decides arrives through `atmosphere`.
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { Pass, FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { atmosphere, runFrameHooks } from "./light";

export interface Post {
  composer: EffectComposer;
  setSize(w: number, h: number): void;
  render(): void;
  dispose(): void;
}

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const ATMOS_FRAG = /* glsl */ `
precision highp float;
#include <packing>
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform sampler2D tAO;
uniform sampler2D tShadow;
uniform float uAO;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform mat4 uShadowMatrix;
uniform mat4 uNearMatrix;
uniform vec2 uShadowTexel;
uniform float uShadowNormalBias;
uniform float uShadowBias;
uniform float uFarShadow;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHazeColor;
uniform float uHazeDensity;
uniform float uHazeGlow;
uniform vec3 uMistColor;
uniform float uMistDensity;
uniform float uMistHeight;
uniform float uMistFalloff;
uniform float uExposure;
varying vec2 vUv;

float shadowDepth(vec2 uv) { return unpackRGBAToDepth(texture2D(tShadow, uv)); }

void main() {
  vec4 col = texture2D(tDiffuse, vUv);
  float depth = texture2D(tDepth, vUv).x;
  vec3 camPos = uCamWorld[3].xyz;
  if (depth >= 0.99999) {
    // Sky: the dome carries its own haze.
    gl_FragColor = vec4(col.rgb * uExposure, 1.0);
    return;
  }
  vec4 clip = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = uInvProj * clip;
  view /= view.w;
  vec3 world = (uCamWorld * view).xyz;
  vec3 ray = world - camPos;
  float dist = length(ray);
  vec3 dir = ray / max(dist, 1e-4);

  #ifdef USE_AO
  float ao = texture2D(tAO, vUv).r;
  col.rgb *= mix(1.0, ao, uAO);
  #endif

  #ifdef USE_FAR_SHADOW
  // Where the sharp tier does not reach, use the wide one. The mask fades
  // over the outer tenth of the near box so the hand-over has no edge.
  vec4 nc = uNearMatrix * vec4(world, 1.0);
  nc.xyz /= nc.w;
  float dn = max(abs(nc.x - 0.5), abs(nc.y - 0.5));
  float nearCover = 1.0 - smoothstep(0.40, 0.49, dn);
  nearCover *= step(0.0, nc.z) * step(nc.z, 1.0);
  float apply = 1.0 - nearCover;
  // Derivatives must be taken in uniform control flow.
  vec3 n = normalize(cross(dFdx(world), dFdy(world)));
  if (dot(n, -dir) < 0.0) n = -n;
  if (apply > 0.001) {
    vec3 pw = world + n * uShadowNormalBias;
    vec4 sc = uShadowMatrix * vec4(pw, 1.0);
    sc.xyz /= sc.w;
    float inFar = step(0.0, sc.x) * step(sc.x, 1.0) * step(0.0, sc.y) * step(sc.y, 1.0) * step(sc.z, 1.0);
    float z = sc.z + uShadowBias;
    float lit = 0.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        lit += step(z, shadowDepth(sc.xy + vec2(float(i), float(j)) * uShadowTexel));
      }
    }
    lit /= 9.0;
    col.rgb *= 1.0 - uFarShadow * (1.0 - lit) * apply * inFar;
  }
  #endif

  // Aerial perspective: brighter toward the sun, as the air scatters forward.
  float sunAmt = max(dot(dir, uSunDir), 0.0);
  vec3 inscatter = uHazeColor * (1.0 + uHazeGlow * (0.3 * pow(sunAmt, 8.0) + 0.7 * pow(sunAmt, 64.0)) * uSunColor);
  float t = exp(-uHazeDensity * dist);
  col.rgb = mix(inscatter, col.rgb, t);

  // Low mist: density falls off with height, integrated along the ray.
  if (uMistDensity > 0.0) {
    float k = uMistFalloff;
    float y0 = camPos.y - uMistHeight;
    float dy = world.y - camPos.y;
    float e = exp(-k * y0);
    float path = abs(dir.y) > 1e-3 ? (1.0 - exp(-k * dy)) / (k * dir.y) : dist;
    float amt = uMistDensity * e * max(path, 0.0);
    float tm = exp(-amt);
    vec3 mist = uMistColor * (1.0 + 0.25 * uHazeGlow * pow(sunAmt, 8.0));
    col.rgb = mix(mist, col.rgb, tm);
  }

  gl_FragColor = vec4(col.rgb * uExposure, 1.0);
}
`;

const GRADE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform float uSaturation;
uniform vec3 uShadowTint;
uniform float uContrast;
uniform float uGrain;
uniform float uVignette;
uniform float uTime;
uniform vec2 uRes;
varying vec2 vUv;

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 c) {
  const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  c *= 1.0 / 0.6;
  c = inM * c;
  c = RRTAndODTFit(c);
  c = outM * c;
  return clamp(c, 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = pow(c, vec3(1.0 / 2.4)) * 1.055 - 0.055;
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.0031308))));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec3 c = aces(texture2D(tDiffuse, vUv).rgb);
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(lum), c, uSaturation);
  c += uShadowTint * (1.0 - smoothstep(0.0, 0.45, lum));
  c = (c - 0.5) * uContrast + 0.5;
  vec2 q = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  c *= 1.0 - uVignette * smoothstep(0.45, 1.25, length(q) * 1.6);
  c = toSRGB(clamp(c, 0.0, 1.0));
  float g = hash(floor(vUv * uRes) + fract(uTime) * vec2(71.0, 37.0)) - 0.5;
  c += g * uGrain * (1.0 - 0.6 * lum);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

/** Draws the scene into the shared half-float target that owns the depth texture. */
class ScenePass extends Pass {
  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    private target: THREE.WebGLRenderTarget,
  ) {
    super();
    this.needsSwap = false;
    this.clear = true;
  }
  render(renderer: THREE.WebGLRenderer) {
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);
  }
}

/**
 * A full-screen shader pass. The composer ping-pongs its two buffers and does
 * not reset them between frames, so a pass that reads its input has to take
 * the read buffer fresh on every render or it ends up sampling the buffer it
 * is writing into every other frame.
 */
class QuadPass extends Pass {
  readonly material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  constructor(
    material: THREE.ShaderMaterial,
    private readsInput: boolean,
  ) {
    super();
    this.material = material;
    this.quad = new FullScreenQuad(material);
    this.needsSwap = true;
  }
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    if (this.readsInput) this.material.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}

export function buildPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, opts: { ssao?: boolean } = {}): Post {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const w = Math.max(1, size.x);
  const h = Math.max(1, size.y);

  const depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
  const sceneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthTexture, depthBuffer: true, stencilBuffer: false });
  sceneRT.texture.name = "beck.scene";

  const composer = new EffectComposer(renderer);
  composer.addPass(new ScenePass(scene, camera, sceneRT));

  let gtao: GTAOPass | null = null;
  if (opts.ssao !== false) {
    gtao = new GTAOPass(scene, camera, w, h);
    gtao.setGBuffer(depthTexture, undefined);
    gtao.output = GTAOPass.OUTPUT.Denoise;
    gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.2, thickness: 1.0, scale: 1.1, samples: 16, distanceFallOff: 1.0, screenSpaceRadius: false });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2.5, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 16 });
    composer.addPass(gtao);
  }

  const atmos = new QuadPass(
    new THREE.ShaderMaterial({
      name: "BeckAtmosphere",
      defines: { ...(gtao ? { USE_AO: 1 } : {}) },
      uniforms: {
        tDiffuse: { value: sceneRT.texture },
        tDepth: { value: depthTexture },
        tAO: { value: gtao ? gtao.pdRenderTarget.texture : null },
        tShadow: { value: null },
        uAO: { value: 1 },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uShadowMatrix: { value: new THREE.Matrix4() },
        uNearMatrix: { value: new THREE.Matrix4() },
        uShadowTexel: { value: new THREE.Vector2(1 / 4096, 1 / 4096) },
        uShadowNormalBias: { value: 0.3 },
        uShadowBias: { value: -0.0004 },
        uFarShadow: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uHazeColor: { value: new THREE.Color(0.6, 0.7, 0.8) },
        uHazeDensity: { value: 0 },
        uHazeGlow: { value: 0 },
        uMistColor: { value: new THREE.Color(0.7, 0.7, 0.7) },
        uMistDensity: { value: 0 },
        uMistHeight: { value: 0 },
        uMistFalloff: { value: 0.08 },
        uExposure: { value: 1 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: ATMOS_FRAG,
      depthTest: false,
      depthWrite: false,
    }),
    false,
  );
  composer.addPass(atmos);

  const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.2, 0.25, 1.1);
  composer.addPass(bloom);

  const grade = new QuadPass(
    new THREE.ShaderMaterial({
      name: "BeckGrade",
      uniforms: {
        tDiffuse: { value: null },
        uSaturation: { value: 1 },
        uShadowTint: { value: new THREE.Color(0, 0, 0) },
        uContrast: { value: 1.03 },
        uGrain: { value: 0.03 },
        uVignette: { value: 0.16 },
        uTime: { value: 0 },
        uRes: { value: new THREE.Vector2(w, h) },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: GRADE_FRAG,
      depthTest: false,
      depthWrite: false,
    }),
    true,
  );
  composer.addPass(grade);

  const smaa = new SMAAPass(w, h);
  composer.addPass(smaa);

  const au = atmos.material.uniforms;
  const gu = grade.material.uniforms;
  let farShadowOn = false;

  function syncAtmosphere() {
    const a = atmosphere;
    camera.updateMatrixWorld();
    (au.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (au.uCamWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
    (au.uSunDir.value as THREE.Vector3).copy(a.sunDir);
    (au.uSunColor.value as THREE.Color).copy(a.sunColor);
    (au.uHazeColor.value as THREE.Color).copy(a.hazeColor);
    au.uHazeDensity.value = a.hazeDensity;
    au.uHazeGlow.value = a.hazeGlow;
    (au.uMistColor.value as THREE.Color).copy(a.mistColor);
    au.uMistDensity.value = a.mistDensity;
    au.uMistHeight.value = a.mistHeight;
    au.uMistFalloff.value = a.mistFalloff;
    au.uExposure.value = a.exposure;
    au.uAO.value = a.ao;
    au.uFarShadow.value = a.farShadowStrength;
    bloom.strength = a.bloom;
    gu.uSaturation.value = a.saturation;
    (gu.uShadowTint.value as THREE.Color).copy(a.shadowTint);
    gu.uGrain.value = a.grain;
  }

  /** The far tier's map exists only after the renderer has drawn it once; wire it in when it appears. */
  function syncFarShadow() {
    const far = atmosphere.farLight;
    const near = atmosphere.nearLight;
    const map = far?.shadow.map;
    const on = !!(far && near && map && atmosphere.farShadowStrength > 0);
    if (on !== farShadowOn) {
      farShadowOn = on;
      if (on) atmos.material.defines.USE_FAR_SHADOW = 1;
      else delete atmos.material.defines.USE_FAR_SHADOW;
      atmos.material.needsUpdate = true;
    }
    if (!on || !far || !near || !map) return;
    au.tShadow.value = map.texture;
    // The frame hooks have just moved both lights; the renderer will compute
    // the same matrices when it draws the maps, so compute them here first.
    for (const l of [near, far]) {
      l.updateMatrixWorld();
      l.target.updateMatrixWorld();
      l.shadow.updateMatrices(l);
    }
    (au.uShadowMatrix.value as THREE.Matrix4).copy(far.shadow.matrix);
    (au.uNearMatrix.value as THREE.Matrix4).copy(near.shadow.matrix);
    const cam = far.shadow.camera;
    const texel = (cam.right - cam.left) / far.shadow.mapSize.x;
    (au.uShadowTexel.value as THREE.Vector2).set(1 / far.shadow.mapSize.x, 1 / far.shadow.mapSize.y);
    au.uShadowNormalBias.value = texel * 1.6;
    au.uShadowBias.value = -texel * 0.35 / (cam.far - cam.near);
  }

  function setSize(cw: number, ch: number) {
    const s = renderer.getDrawingBufferSize(new THREE.Vector2());
    const pw = Math.max(1, s.x);
    const ph = Math.max(1, s.y);
    composer.setSize(cw, ch);
    sceneRT.setSize(pw, ph);
    gtao?.setSize(pw, ph);
    bloom.setSize(pw, ph);
    smaa.setSize(pw, ph);
    (gu.uRes.value as THREE.Vector2).set(pw, ph);
  }

  return {
    composer,
    setSize,
    render() {
      runFrameHooks(camera);
      syncAtmosphere();
      syncFarShadow();
      gu.uTime.value = (performance.now() % 100000) / 1000;
      composer.render();
    },
    dispose() {
      gtao?.dispose();
      bloom.dispose();
      smaa.dispose();
      atmos.dispose();
      grade.dispose();
      sceneRT.dispose();
      depthTexture.dispose();
      composer.dispose();
    },
  };
}
