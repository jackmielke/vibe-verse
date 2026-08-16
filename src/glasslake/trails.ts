/**
 * Carve trails — the marks your skates leave, held in a texture.
 *
 * Two small render targets, ping-ponged. Each frame one fullscreen pass
 * reads the other target, multiplies it down a little (the cut healing over
 * as the lake refreezes) and stamps a capsule between last frame's position
 * and this one's. Stamping a *segment* rather than a dot is the whole
 * difference between a line and a dotted line: at 18 m/s and 60 fps the
 * skater moves a third of a metre per frame, and at 15 fps on a tired phone
 * it moves more than a metre — dots would be a trail of full stops.
 *
 * The texture covers a fixed square of the world centred on the origin, so
 * world → uv is a constant scale with no scrolling and no seams. The lake is
 * bounded; the trail buffer is exactly as big as the place you can skate.
 */
import * as THREE from "three";

export interface TrailsHandle {
  /** The live texture. Bind this into the ice material. */
  get texture(): THREE.Texture;
  /** Stamp the segment travelled since the last call, then age the buffer. */
  stamp(renderer: THREE.WebGLRenderer, from: THREE.Vector2, to: THREE.Vector2, width: number, strength: number, dt: number): void;
  clear(renderer: THREE.WebGLRenderer): void;
  dispose(): void;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uPrev;
uniform vec2 uFrom;
uniform vec2 uTo;
uniform float uWidth;
uniform float uStrength;
uniform float uDecay;
varying vec2 vUv;

// Distance from p to the segment ab — the capsule that makes the stroke.
float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-7), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  float prev = texture2D(uPrev, vUv).r * uDecay;
  float d = segDist(vUv, uFrom, uTo);
  // Hard core, soft shoulder: the blade cuts a narrow line and the ice
  // around it fogs.
  float cut = smoothstep(uWidth, uWidth * 0.25, d) * uStrength;
  float glow = smoothstep(uWidth * 2.0, 0.0, d) * uStrength * 0.4;
  // Combined with max, never added. Adding meant the shoulder piled onto
  // itself every frame the skater sat in one place — sixty stamps a second,
  // each one adding a third — and a metre-wide scratch flooded out into a
  // six-metre saturated runway. max is idempotent: stamping the same ice
  // twice leaves the same mark, which is what a mark is.
  gl_FragColor = vec4(vec3(max(prev, max(cut, glow))), 1.0);
}
`;

export function buildTrails(size: number, extent: number, fade: number): TrailsHandle {
  const options: THREE.RenderTargetOptions = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    // Half-float would be tidier, but this buffer holds a 0..1 mask and
    // nothing else — bytes are enough and are supported everywhere.
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
  };
  let a = new THREE.WebGLRenderTarget(size, size, options);
  let b = new THREE.WebGLRenderTarget(size, size, options);

  const material = new THREE.ShaderMaterial({
    name: "GlassLakeTrails",
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uPrev: { value: null },
      uFrom: { value: new THREE.Vector2(0.5, 0.5) },
      uTo: { value: new THREE.Vector2(0.5, 0.5) },
      uWidth: { value: 0.004 },
      uStrength: { value: 1 },
      uDecay: { value: 1 },
    },
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const worldToUv = (v: THREE.Vector2, out: THREE.Vector2) =>
    out.set(v.x / (2 * extent) + 0.5, v.y / (2 * extent) + 0.5);

  const from = new THREE.Vector2();
  const to = new THREE.Vector2();

  const run = (renderer: THREE.WebGLRenderer) => {
    const prevTarget = renderer.getRenderTarget();
    material.uniforms.uPrev.value = b.texture;
    renderer.setRenderTarget(a);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prevTarget);
    const swap = a;
    a = b;
    b = swap;
  };

  return {
    get texture() {
      return b.texture;
    },
    stamp(renderer, fromWorld, toWorld, width, strength, dt) {
      worldToUv(fromWorld, from);
      worldToUv(toWorld, to);
      (material.uniforms.uFrom.value as THREE.Vector2).copy(from);
      (material.uniforms.uTo.value as THREE.Vector2).copy(to);
      material.uniforms.uWidth.value = width / (2 * extent);
      material.uniforms.uStrength.value = strength;
      // Frame-rate independent fade: the same half-life whatever the fps.
      material.uniforms.uDecay.value = Math.pow(0.5, dt / fade);
      run(renderer);
    },
    clear(renderer) {
      const prevTarget = renderer.getRenderTarget();
      // Put the scene's clear colour back afterwards. Leaving black behind
      // here would repaint the sky's backdrop on the next frame, which is
      // invisible until the one frame where the dome has not drawn yet.
      const prevClear = new THREE.Color();
      renderer.getClearColor(prevClear);
      const prevAlpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 1);
      for (const target of [a, b]) {
        renderer.setRenderTarget(target);
        renderer.clear(true, false, false);
      }
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.setRenderTarget(prevTarget);
    },
    dispose() {
      a.dispose();
      b.dispose();
      quad.geometry.dispose();
      material.dispose();
    },
  };
}
