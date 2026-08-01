/**
 * Render targets, capability probing and the fullscreen blitter.
 *
 * The screenshot harness runs on SwiftShader, so nothing here may *assume* a
 * capability: every optional format is probed against the real context and has
 * a working fallback. The two that actually matter are half-float colour
 * (without it the whole chain is LDR) and depth textures (without them AO, DOF,
 * god rays and motion blur all have to switch themselves off).
 */
import * as THREE from "three";

export interface PostFxCaps {
  /** RGBA16F targets can be rendered to *and* linearly filtered. */
  halfFloat: boolean;
  /** A DepthTexture can be attached to a render target and sampled. */
  depthTexture: boolean;
  /**
   * Scale applied to the bloom pyramid when the chain is 8-bit.
   *
   * Additive one-one blending into an RGBA8 target clamps at 1.0, so a wide
   * bloom saturates to flat white blocks halfway up the pyramid. Storing the
   * veil pre-divided and multiplying it back at composite time is a two-line
   * manual encode that buys back two stops of headroom — which is all an
   * arcade racer's sparks and sun need.
   */
  bloomEncode: number;
}

/**
 * Probe the live context.
 *
 * `extensions.has` rather than `extensions.get`: the latter warns to the
 * console for anything absent, and a capability probe that spams a warning for
 * every format it decided *not* to use is a probe nobody will keep.
 */
export function probeCaps(renderer: THREE.WebGLRenderer): PostFxCaps {
  const gl = renderer.getContext();
  const isWebGL2 =
    typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;

  // Colour-renderable half float. ES 3.0 makes RGBA16F texture-*filterable*
  // unconditionally but leaves colour-renderability to an extension, so on
  // WebGL1 both halves have to be present before we trust it.
  const halfFloat = isWebGL2
    ? renderer.extensions.has("EXT_color_buffer_half_float") ||
      renderer.extensions.has("EXT_color_buffer_float")
    : renderer.extensions.has("OES_texture_half_float") &&
      renderer.extensions.has("OES_texture_half_float_linear") &&
      renderer.extensions.has("EXT_color_buffer_half_float");

  const depthTexture = isWebGL2 || renderer.extensions.has("WEBGL_depth_texture");

  return { halfFloat, depthTexture, bloomEncode: halfFloat ? 1 : 0.25 };
}

export interface TargetOptions {
  /** Attach a depth buffer. The scene target needs one to depth-test at all. */
  depth?: boolean;
  /**
   * Attach a *sampleable* depth texture as well.
   *
   * Kept separate from `depth` on purpose: if the driver cannot give us a depth
   * texture the scene still has to depth-test, so it gets a plain renderbuffer
   * and the passes that wanted to read depth switch themselves off instead.
   */
  depthTexture?: boolean;
  /** Nearest filtering — for buffers that are only ever sampled 1:1. */
  nearest?: boolean;
  /** Force 8-bit even when half float is available (LDR stages after the grade). */
  ldr?: boolean;
}

/**
 * A colour target for the chain. Half float where the driver allows it, 8-bit
 * where it does not, never mipmapped, always clamped — a wrapped sample at the
 * frame edge shows up as a bright smear on the opposite side during bloom.
 */
export function makeTarget(
  width: number,
  height: number,
  name: string,
  caps: PostFxCaps,
  opts: TargetOptions = {},
): THREE.WebGLRenderTarget {
  const filter = opts.nearest ? THREE.NearestFilter : THREE.LinearFilter;
  const rt = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    minFilter: filter,
    magFilter: filter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    format: THREE.RGBAFormat,
    type: caps.halfFloat && !opts.ldr ? THREE.HalfFloatType : THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    depthBuffer: opts.depth === true,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.name = name;
  rt.texture.generateMipmaps = false;

  if (opts.depthTexture) {
    // 24-bit integer depth: universally available in ES 3.0, and at near=0.15 /
    // far=4000 it resolves to well under a millimetre at kart distance. A float
    // depth attachment would be nicer and is not worth the extension dance.
    const depth = new THREE.DepthTexture(Math.max(1, width), Math.max(1, height));
    depth.type = THREE.UnsignedIntType;
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    depth.generateMipmaps = false;
    depth.name = `${name}Depth`;
    rt.depthTexture = depth;
  }

  return rt;
}

/** Resize a target and its depth attachment together. */
export function resizeTarget(rt: THREE.WebGLRenderTarget, width: number, height: number): void {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  if (rt.width === w && rt.height === h) return;
  rt.setSize(w, h);
}

/** Free a target and any depth texture hanging off it. */
export function disposeTarget(rt: THREE.WebGLRenderTarget): void {
  rt.depthTexture?.dispose();
  rt.dispose();
}

// ---------------------------------------------------------------------------
// Blitter
// ---------------------------------------------------------------------------

/**
 * One triangle, one scene, one ortho camera — shared by every pass in the
 * module. Allocating a mesh per effect would multiply a trivial cost by
 * fifteen and, worse, make each pass's draw show up separately in the frame
 * profile as if it were geometry.
 */
export class Blitter {
  private readonly geometry: THREE.BufferGeometry;
  private readonly camera: THREE.OrthographicCamera;
  private readonly mesh: THREE.Mesh;
  private readonly scene: THREE.Scene;

  constructor() {
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    this.geometry.setAttribute(
      "uv",
      new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2),
    );
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mesh = new THREE.Mesh(this.geometry, null as unknown as THREE.Material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.scene = new THREE.Scene();
    // The blit scene must never inherit the world's fog or environment map:
    // three would try to bind them into our ShaderMaterials' programs.
    this.scene.add(this.mesh);
  }

  /**
   * Draw `material` over `target` (null = the canvas).
   *
   * Clearing is skipped deliberately — every material here writes all four
   * channels of every pixel, and the one pass that does not (the additive
   * bloom upsample) *wants* what is already there.
   */
  draw(
    renderer: THREE.WebGLRenderer,
    material: THREE.Material,
    target: THREE.WebGLRenderTarget | null,
  ): void {
    this.mesh.material = material;
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.autoClear = prevAutoClear;
  }

  dispose(): void {
    this.geometry.dispose();
    this.scene.clear();
  }
}

// ---------------------------------------------------------------------------
// Shared uniforms
// ---------------------------------------------------------------------------

/**
 * Uniform objects handed by reference to every material that needs them.
 *
 * three compares uniform *values*, not identity, so sharing the container means
 * the per-frame sync is one write instead of one write per material — and, more
 * importantly, it makes it impossible for two passes to disagree about which
 * frame's camera matrices they are using.
 */
export interface SharedUniforms {
  tDepth: { value: THREE.Texture | null };
  uNear: { value: number };
  uFar: { value: number };
  uInverseProjection: { value: THREE.Matrix4 };
  uCameraMatrixWorld: { value: THREE.Matrix4 };
  uPrevViewProjection: { value: THREE.Matrix4 };
  uTexel: { value: THREE.Vector2 };
  uAspect: { value: number };
  uTime: { value: number };
  uFrame: { value: number };
}

export function createSharedUniforms(): SharedUniforms {
  return {
    tDepth: { value: null },
    uNear: { value: 0.15 },
    uFar: { value: 4000 },
    uInverseProjection: { value: new THREE.Matrix4() },
    uCameraMatrixWorld: { value: new THREE.Matrix4() },
    uPrevViewProjection: { value: new THREE.Matrix4() },
    uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    uAspect: { value: 16 / 9 },
    uTime: { value: 0 },
    uFrame: { value: 0 },
  };
}

/** The depth uniform block, in the exact order `PF_DEPTH` declares it. */
export function depthUniforms(shared: SharedUniforms): Record<string, { value: unknown }> {
  return {
    tDepth: shared.tDepth,
    uNear: shared.uNear,
    uFar: shared.uFar,
    uInverseProjection: shared.uInverseProjection,
    uCameraMatrixWorld: shared.uCameraMatrixWorld,
    uPrevViewProjection: shared.uPrevViewProjection,
  };
}

/**
 * Standard flags for a fullscreen material: no depth interaction, no blending,
 * no tone mapping (we do our own, exactly once, at the end).
 */
export function fullscreenMaterial(
  name: string,
  fragmentShader: string,
  uniforms: Record<string, { value: unknown }>,
  vertexShader: string,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name,
    vertexShader,
    fragmentShader,
    uniforms: uniforms as unknown as { [k: string]: THREE.IUniform },
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
    fog: false,
    lights: false,
  });
}

/**
 * A 1×1 opaque black texture.
 *
 * A `sampler2D` uniform left at null is undefined behaviour in WebGL, not
 * "reads as black" — on several drivers it samples whatever texture was last
 * bound to that unit, which is how a disabled effect ends up showing a
 * postage-stamp of the bloom pyramid in the corner of the screen.
 */
export function makeBlackTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  t.name = "KartPostFxBlack";
  t.needsUpdate = true;
  return t;
}

/**
 * A 1×1 white texture — the "effect is off" binding for anything that
 * *multiplies* (AO, masks). Swapping the binding instead of recompiling with a
 * define means toggling AO from the options menu costs nothing; a define change
 * would stall the frame on a shader rebuild.
 */
export function makeWhiteTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.name = "KartPostFxWhite";
  t.needsUpdate = true;
  return t;
}
