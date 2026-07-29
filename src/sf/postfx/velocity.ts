/**
 * The velocity buffer.
 *
 * TAA and motion blur both need to know, for every pixel, where the thing under
 * it was last frame. Two sources feed that:
 *
 *  1. Camera motion, reconstructed analytically from depth. One fullscreen
 *     draw, no geometry, and it is *exact* for anything that did not move —
 *     which in an open-world city is the overwhelming majority of the screen.
 *  2. Object motion, rasterised for objects that explicitly opt in via
 *     `registerVelocityObject`. Vehicles, ragdolls, the player's own hands.
 *
 * The second pass has no depth attachment of its own; it depth-tests manually
 * against the scene depth texture. Attaching and clearing a second depth buffer
 * to draw a handful of cars would cost more than the compare.
 *
 * Encoding: RG holds `currentUv - previousUv` in UV units. Half-float, so a
 * sub-pixel velocity survives; an 8-bit velocity buffer quantises slow motion
 * to zero and TAA then refuses to reproject it.
 */
import * as THREE from "three";
import { Pass } from "postprocessing";
import { envUniforms } from "./env";
import { FULLSCREEN_VERT, GLSL_DEPTH } from "./glsl";
import { makeHdrTarget } from "./fullscreen";

/* ------------------------------------------------------------------ *
 * Dynamic-object registry
 * ------------------------------------------------------------------ */

interface VelocityEntry {
  object: THREE.Mesh;
  material: THREE.ShaderMaterial;
  prevMatrix: THREE.Matrix4;
  /** Frame index the prev matrix was last written on, to catch stale entries. */
  stamp: number;
}

const registry = new Map<THREE.Object3D, VelocityEntry>();

const objectVelocityVert = /* glsl */ `
uniform mat4 uPrevModelMatrix;
uniform mat4 uPrevViewProjection;
uniform mat4 uCurrViewProjection;
varying vec4 vCurrClip;
varying vec4 vPrevClip;
varying float vViewDepth;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec4 prevWorld = uPrevModelMatrix * vec4(position, 1.0);
  vCurrClip = uCurrViewProjection * world;
  vPrevClip = uPrevViewProjection * prevWorld;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const objectVelocityFrag = /* glsl */ `
precision highp float;
${GLSL_DEPTH}
uniform vec2 uResolution;
varying vec4 vCurrClip;
varying vec4 vPrevClip;
varying float vViewDepth;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;

  // Manual depth test. The scene was rendered with the same (possibly
  // logarithmic) projection, so compare in view-space metres where the
  // encoding does not matter. The tolerance is relative: 0.2% of the distance
  // plus 5 cm covers depth-buffer precision at both 2 m and 2 km.
  float sceneDepth = -sfSampleViewZ(uv);
  if (vViewDepth > sceneDepth * 1.002 + 0.05) discard;

  vec2 cur = vCurrClip.xy / vCurrClip.w * 0.5 + 0.5;
  vec2 prev = vPrevClip.xy / vPrevClip.w * 0.5 + 0.5;
  gl_FragColor = vec4(cur - prev, 0.0, 1.0);
}
`;

function makeObjectVelocityMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "SfObjectVelocity",
    vertexShader: objectVelocityVert,
    fragmentShader: objectVelocityFrag,
    uniforms: {
      uPrevModelMatrix: { value: new THREE.Matrix4() },
      uPrevViewProjection: envUniforms.prevViewProjection,
      uCurrViewProjection: envUniforms.viewProjection,
      uResolution: envUniforms.resolution,
      tDepth: { value: null as THREE.Texture | null },
      uNear: envUniforms.near,
      uFar: envUniforms.far,
      uLogFC: envUniforms.logDepthFC,
      uInverseProjection: envUniforms.inverseProjection,
      uCameraMatrixWorld: envUniforms.cameraMatrixWorld,
    },
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
  });
}

/**
 * Opt an object into per-object motion vectors.
 *
 * Only plain meshes: an `InstancedMesh` would need a previous-transform buffer
 * per instance, which is a per-system decision (traffic wants one, debris does
 * not) and does not belong in the post stack. Unregistered movers simply fall
 * back to camera velocity — they ghost slightly under fast motion instead of
 * being wrong.
 */
export function registerVelocityObject(object: THREE.Mesh): void {
  if (registry.has(object)) return;
  registry.set(object, {
    object,
    material: makeObjectVelocityMaterial(),
    prevMatrix: object.matrixWorld.clone(),
    stamp: -1,
  });
}

export function unregisterVelocityObject(object: THREE.Object3D): void {
  const entry = registry.get(object);
  if (!entry) return;
  entry.material.dispose();
  registry.delete(object);
}

export function clearVelocityObjects(): void {
  for (const entry of registry.values()) entry.material.dispose();
  registry.clear();
}

/* ------------------------------------------------------------------ *
 * The pass
 * ------------------------------------------------------------------ */

const cameraVelocityFrag = /* glsl */ `
precision highp float;
${GLSL_DEPTH}
uniform mat4 uPrevViewProjection;
varying vec2 vUv;

void main() {
  float wd = sfWindowDepth(sfRawDepth(vUv));
  float viewZ = sfViewZ(wd);
  vec3 world = sfWorldFromView(sfViewPosition(vUv, viewZ));
  vec4 prevClip = uPrevViewProjection * vec4(world, 1.0);
  vec2 prevUv = prevClip.xy / prevClip.w * 0.5 + 0.5;
  // Sky reprojects too: at the far plane the reconstructed point is effectively
  // at infinity, so the result is pure rotation — which is exactly right, and
  // is why a panning shot of the bay does not smear the sky.
  gl_FragColor = vec4(vUv - prevUv, 0.0, 1.0);
}
`;

export class VelocityPass extends Pass {
  /** RG = screen-space motion in UV units, current minus previous. */
  readonly renderTarget: THREE.WebGLRenderTarget;

  private readonly cameraMaterial: THREE.ShaderMaterial;
  private sceneCamera: THREE.PerspectiveCamera;
  private depthTexture: THREE.Texture | null = null;

  constructor(sceneCamera: THREE.PerspectiveCamera) {
    super("SfVelocityPass");
    this.sceneCamera = sceneCamera;
    this.needsSwap = false;
    this.needsDepthTexture = true;

    this.renderTarget = makeHdrTarget(1, 1, "SfVelocity");
    // Nearest: velocity must never be interpolated across a silhouette. A
    // bilinear tap between a static wall and a car doing 30 m/s invents a
    // motion vector that points at nothing.
    this.renderTarget.texture.minFilter = THREE.NearestFilter;
    this.renderTarget.texture.magFilter = THREE.NearestFilter;

    this.cameraMaterial = new THREE.ShaderMaterial({
      name: "SfCameraVelocity",
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: cameraVelocityFrag,
      uniforms: {
        tDepth: { value: null as THREE.Texture | null },
        uNear: envUniforms.near,
        uFar: envUniforms.far,
        uLogFC: envUniforms.logDepthFC,
        uInverseProjection: envUniforms.inverseProjection,
        uCameraMatrixWorld: envUniforms.cameraMatrixWorld,
        uPrevViewProjection: envUniforms.prevViewProjection,
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.fullscreenMaterial = this.cameraMaterial;
  }

  /** The pipeline hands us the real scene camera; `Pass.camera` is a dummy. */
  setCamera(camera: THREE.PerspectiveCamera): void {
    this.sceneCamera = camera;
  }

  setDepthTexture(depthTexture: THREE.Texture): void {
    this.depthTexture = depthTexture;
    this.cameraMaterial.uniforms.tDepth.value = depthTexture;
    for (const entry of registry.values()) {
      entry.material.uniforms.tDepth.value = depthTexture;
    }
  }

  setSize(width: number, height: number): void {
    this.renderTarget.setSize(Math.max(1, width), Math.max(1, height));
  }

  render(renderer: THREE.WebGLRenderer): void {
    const camera = this.sceneCamera;

    // 1. Camera velocity everywhere.
    renderer.setRenderTarget(this.renderTarget);
    renderer.render(this.scene, this.camera);

    // 2. Overwrite with true object velocity where movers are registered.
    if (registry.size > 0) {
      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      for (const entry of registry.values()) {
        const obj = entry.object;
        if (!obj.visible || !obj.parent) continue;
        entry.material.uniforms.uPrevModelMatrix.value.copy(entry.prevMatrix);
        if (entry.material.uniforms.tDepth.value !== this.depthTexture) {
          entry.material.uniforms.tDepth.value = this.depthTexture;
        }
        // Borrow the mesh: swap in the velocity material, draw, swap back. The
        // object keeps its own world matrix, so no transform bookkeeping.
        const original = obj.material;
        obj.material = entry.material;
        renderer.render(obj, camera);
        obj.material = original;
      }
      renderer.autoClear = prevAutoClear;
    }

    // 3. Roll the history. Done after drawing so a mover registered mid-frame
    // starts with zero velocity rather than a garbage first-frame streak.
    for (const entry of registry.values()) {
      entry.prevMatrix.copy(entry.object.matrixWorld);
      entry.stamp = envUniforms.frameIndex.value;
    }
  }

  dispose(): void {
    this.renderTarget.dispose();
    this.cameraMaterial.dispose();
    super.dispose();
  }
}
