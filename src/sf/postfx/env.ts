/**
 * Shared per-frame uniforms for the whole post-processing chain.
 *
 * Every effect and pass in the pipeline needs the same handful of camera and
 * atmosphere values — the unjittered view-projection, last frame's
 * view-projection for reprojection, the sun, the sky colours the reflections
 * and volumetrics fall back to. Duplicating those into a dozen uniform maps and
 * updating them a dozen times a frame is how pipelines silently desynchronise:
 * one effect reprojects against a stale matrix, and you get ghosting that takes
 * a day to find.
 *
 * So there is exactly one set of `THREE.Uniform` objects. Effects reference the
 * same instances (uniform objects are just `{ value }` boxes — sharing them is
 * free and three uploads whatever is in the box at draw time), and `Pipeline`
 * is the only writer.
 */
import * as THREE from "three";
import { sunColor, sunDirection, sunIntensity, skyFillColor, fogColor } from "../sky/Sky";
import { clamp01 } from "../math/rng";

/* ------------------------------------------------------------------ *
 * The uniform block
 * ------------------------------------------------------------------ */

export const envUniforms = {
  /** Unjittered projection matrix actually used to render this frame's scene. */
  projectionMatrix: new THREE.Uniform(new THREE.Matrix4()),
  /** Inverse of the above — reconstructs a view ray from a UV. */
  inverseProjection: new THREE.Uniform(new THREE.Matrix4()),
  /** Camera world matrix (view → world). */
  cameraMatrixWorld: new THREE.Uniform(new THREE.Matrix4()),
  /** World → view. */
  viewMatrix: new THREE.Uniform(new THREE.Matrix4()),
  /** Unjittered world → clip for this frame. */
  viewProjection: new THREE.Uniform(new THREE.Matrix4()),
  /** Unjittered world → clip for the previous frame (reprojection). */
  prevViewProjection: new THREE.Uniform(new THREE.Matrix4()),
  cameraPosition: new THREE.Uniform(new THREE.Vector3()),

  near: new THREE.Uniform(0.15),
  far: new THREE.Uniform(9000),
  /**
   * `2 / log2(far + 1)` when the renderer uses a logarithmic depth buffer,
   * 0 otherwise. Depth reconstruction branches on this.
   */
  logDepthFC: new THREE.Uniform(0),

  /** Full-resolution render size in pixels. */
  resolution: new THREE.Uniform(new THREE.Vector2(1, 1)),
  texelSize: new THREE.Uniform(new THREE.Vector2(1, 1)),

  /** Monotonic frame counter — drives temporal jitter and noise rotation. */
  frameIndex: new THREE.Uniform(0),
  /** Seconds since load. */
  time: new THREE.Uniform(0),

  /* -------- atmosphere, straight out of sky/Sky.tsx -------- */

  /** World-space unit vector pointing *at* the sun. */
  sunDirection: new THREE.Uniform(new THREE.Vector3(0, 1, 0)),
  /** Sun colour premultiplied by intensity — radiance, not albedo. */
  sunRadiance: new THREE.Uniform(new THREE.Color(1, 1, 1)),
  skyZenith: new THREE.Uniform(new THREE.Color(0.3, 0.45, 0.7)),
  skyHorizon: new THREE.Uniform(new THREE.Color(0.7, 0.78, 0.85)),
  groundAlbedo: new THREE.Uniform(new THREE.Color(0.12, 0.115, 0.11)),
  /** 0..1 marine-layer thickness, mirrored from `frame.fogDensity`. */
  fogDensity: new THREE.Uniform(0.35),
  /** Wind direction * speed — drifts the fog banks so they are never static. */
  wind: new THREE.Uniform(new THREE.Vector2(0.82, 0.57)),
  /** 0 = full day, 1 = full night. Drives the neon grade and star-level noise. */
  nightFactor: new THREE.Uniform(0),
  /** Sun position in screen UV, `z` = 1 when the sun is in front of the camera. */
  sunScreen: new THREE.Uniform(new THREE.Vector3(0.5, 0.5, 0)),

  /* -------- the key light's shadow map, borrowed for volumetrics -------- */

  /** Three's packed-RGBA shadow depth map, or null before the first shadow render. */
  shadowMap: new THREE.Uniform<THREE.Texture | null>(null),
  /** World → shadow UV+depth, i.e. `light.shadow.matrix`. */
  shadowMatrix: new THREE.Uniform(new THREE.Matrix4()),
  /** Half-extent of the shadow ortho frustum, metres — used to fade shafts out. */
  shadowRadius: new THREE.Uniform(450),
  /** Shadow camera centre in world space. */
  shadowCenter: new THREE.Uniform(new THREE.Vector3()),
  /** 1 when a usable shadow map is bound. */
  shadowValid: new THREE.Uniform(0),

  /** Void-and-cluster blue-noise tile shared by every stochastic effect. */
  blueNoise: new THREE.Uniform<THREE.Texture | null>(null),
  blueNoiseTexel: new THREE.Uniform(new THREE.Vector2(1 / 64, 1 / 64)),
};

export type EnvUniforms = typeof envUniforms;

/* ------------------------------------------------------------------ *
 * Update
 * ------------------------------------------------------------------ */

const scratchSun = new THREE.Vector3();
const scratchColor = new THREE.Color();
const scratchColor2 = new THREE.Color();
const scratchVec = new THREE.Vector3();

/**
 * Refresh the atmosphere half of the block. Cheap (a handful of trig calls),
 * called once per frame from the pipeline before anything renders.
 */
export function updateEnvAtmosphere(hour: number, fog: number): void {
  const dir = sunDirection(hour, scratchSun);
  envUniforms.sunDirection.value.copy(dir);

  const night = 1 - clamp01((dir.y + 0.14) / 0.2);
  envUniforms.nightFactor.value = night;

  // Radiance, not albedo: the volumetric integral and the SSR sky fallback both
  // want energy, and the sun's colour alone is meaningless without its
  // intensity — a deep orange sunset key at 3.4 units and the same hue at 0.4
  // are two completely different lighting situations.
  const c = sunColor(hour, scratchColor);
  const i = sunIntensity(hour) * (1 - fog * 0.45);
  envUniforms.sunRadiance.value.copy(c).multiplyScalar(i);

  // Zenith comes from the ambient fill, horizon from the aerial-perspective
  // colour, so a reflection that leaves the screen lands on something that
  // matches the sky the player can actually see.
  envUniforms.skyZenith.value.copy(skyFillColor(hour, scratchColor2)).multiplyScalar(1.35);
  envUniforms.skyHorizon.value.copy(fogColor(hour, fog, scratchColor2));
  envUniforms.fogDensity.value = fog;
}

/**
 * Refresh the camera half of the block from the *unjittered* projection.
 * Must be called before the jitter is applied, otherwise every reprojection in
 * the chain inherits a sub-pixel error that reads as shimmer.
 */
export function updateEnvCamera(
  camera: THREE.PerspectiveCamera,
  unjitteredProjection: THREE.Matrix4,
  width: number,
  height: number,
): void {
  envUniforms.projectionMatrix.value.copy(unjitteredProjection);
  envUniforms.inverseProjection.value.copy(unjitteredProjection).invert();
  envUniforms.cameraMatrixWorld.value.copy(camera.matrixWorld);
  envUniforms.viewMatrix.value.copy(camera.matrixWorldInverse);
  envUniforms.viewProjection.value
    .copy(unjitteredProjection)
    .multiply(camera.matrixWorldInverse);
  envUniforms.cameraPosition.value.setFromMatrixPosition(camera.matrixWorld);
  envUniforms.near.value = camera.near;
  envUniforms.far.value = camera.far;
  envUniforms.resolution.value.set(width, height);
  envUniforms.texelSize.value.set(1 / width, 1 / height);

  // Sun in screen space, for light shafts and the lens flare. Projecting the
  // direction (not a position) keeps it correct however far away the camera is.
  scratchVec
    .copy(envUniforms.sunDirection.value)
    .multiplyScalar(1e5)
    .add(envUniforms.cameraPosition.value)
    .applyMatrix4(envUniforms.viewProjection.value as THREE.Matrix4);
  // applyMatrix4 on a Vector3 already performs the perspective divide.
  const onScreen = envUniforms.sunDirection.value.dot(
    scratchSun.set(0, 0, -1).applyQuaternion(camera.quaternion),
  );
  envUniforms.sunScreen.value.set(
    scratchVec.x * 0.5 + 0.5,
    scratchVec.y * 0.5 + 0.5,
    onScreen > 0 ? 1 : 0,
  );
}

/** Snapshot this frame's view-projection so the next frame can reproject. */
export function rollEnvHistory(): void {
  envUniforms.prevViewProjection.value.copy(envUniforms.viewProjection.value);
  envUniforms.frameIndex.value = (envUniforms.frameIndex.value + 1) % 4096;
}

/**
 * Find the key light's shadow map and publish it.
 *
 * Volumetrics without occlusion are just tinted haze; the shafts *are* the
 * effect. Rather than render a second shadow map we borrow the one the sun
 * light already produced — read-only, and the light belongs to sky/Sky.tsx.
 */
let cachedKeyLight: THREE.DirectionalLight | null = null;

export function bindShadowMap(scene: THREE.Scene): void {
  // Cache the light. `scene.traverse` over a city of instanced facades is not
  // something to do sixty times a second to find one object that never moves in
  // the graph; re-scan only when the cached one is gone.
  if (!cachedKeyLight || !cachedKeyLight.parent) {
    cachedKeyLight = null;
    scene.traverse((o) => {
      if (cachedKeyLight) return;
      const l = o as THREE.DirectionalLight;
      if (l.isDirectionalLight && l.castShadow) cachedKeyLight = l;
    });
  }
  const dl = cachedKeyLight as THREE.DirectionalLight | null;
  if (!dl || !dl.shadow || !dl.shadow.map) {
    envUniforms.shadowValid.value = 0;
    envUniforms.shadowMap.value = null;
    return;
  }
  envUniforms.shadowMap.value = dl.shadow.map.texture;
  envUniforms.shadowMatrix.value.copy(dl.shadow.matrix);
  const cam = dl.shadow.camera as THREE.OrthographicCamera;
  envUniforms.shadowRadius.value = Math.max(1, cam.right);
  envUniforms.shadowCenter.value.copy(dl.target.position);
  envUniforms.shadowValid.value = 1;
}
