/**
 * A shared fullscreen-triangle blitter for the pipeline's internal render
 * targets.
 *
 * Effects that own private buffers (the AO pyramid, the SSR march, the bloom
 * mip chain) need to draw a screen-covering primitive several times a frame.
 * One triangle, one geometry, one camera, allocated once for the whole module:
 * a fullscreen *quad* wastes a quarter of the raster work on a diagonal seam
 * where both triangles are shaded, and allocating a mesh per effect multiplies
 * that by fifteen.
 */
import * as THREE from "three";

const geometry = new THREE.BufferGeometry();
// Oversized triangle: covers the [-1,1] NDC square with no diagonal.
geometry.setAttribute(
  "position",
  new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
);
geometry.setAttribute(
  "uv",
  new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2),
);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const mesh = new THREE.Mesh(geometry, null as unknown as THREE.Material);
mesh.frustumCulled = false;
mesh.matrixAutoUpdate = false;

const scene = new THREE.Scene();
scene.add(mesh);

/**
 * Draw `material` over `target` (or the screen when target is null).
 * Clearing is skipped: every fullscreen material we use writes every pixel, and
 * a clear on a big HDR target is not free.
 */
export function blit(
  renderer: THREE.WebGLRenderer,
  material: THREE.Material,
  target: THREE.WebGLRenderTarget | null,
): void {
  mesh.material = material;
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.autoClear = prevAutoClear;
}

/** Standard options for an HDR intermediate: half-float, clamped, no mips. */
export function makeHdrTarget(
  width: number,
  height: number,
  name: string,
  format: THREE.PixelFormat = THREE.RGBAFormat,
): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    format,
    // Half-float end to end. An 8-bit intermediate anywhere before the tonemap
    // is where bloom starts banding and volumetrics start posterising.
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  rt.texture.name = name;
  rt.texture.generateMipmaps = false;
  return rt;
}

/** A minimal copy material — used to move a private buffer into the chain. */
export function makeCopyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "SfCopy",
    uniforms: { tInput: { value: null as THREE.Texture | null }, uScale: { value: 1 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`,
    fragmentShader: `
      uniform sampler2D tInput;
      uniform float uScale;
      varying vec2 vUv;
      void main() { gl_FragColor = texture2D(tInput, vUv) * uScale; }
    `,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
  });
}
