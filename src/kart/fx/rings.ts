/**
 * Vibe Kart — expanding rings.
 *
 * Shockwaves, landing dust rings, water ripples and the pop of a boost pad are
 * all the same object: a flat annulus, pinned to a surface, that grows and
 * fades. They get their own batch rather than riding the particle pool because
 * they are *oriented* — a shockwave has to lie on the ground the explosion
 * happened on, and the particle batch is unconditionally camera-facing.
 *
 * The instance matrix is written once, at spawn, from a position and a surface
 * normal. Everything animated — the radius, the fade — is a function of age in
 * the vertex shader. So a frame in which nothing new detonates costs exactly
 * one uniform write and one draw call.
 */
import * as THREE from "three";
import { RING_FRAG, RING_VERT } from "./shaders";

export interface RingPoolOptions {
  name: string;
  capacity: number;
  atlas: THREE.Texture;
  grid: number;
  inset: number;
  additive: boolean;
  intensity: number;
  renderOrder: number;
}

/** Reusable temporaries — a shockwave must not allocate a Matrix4. */
const tmpNormal = new THREE.Vector3();
const tmpTangent = new THREE.Vector3();
const tmpBitangent = new THREE.Vector3();
const tmpMatrix = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);

export class RingPool {
  readonly mesh: THREE.InstancedMesh;
  readonly material: THREE.ShaderMaterial;
  readonly geometry: THREE.PlaneGeometry;
  readonly capacity: number;

  private cursor = 0;
  private time = 0;
  private dirty = false;

  private readonly param: Float32Array;
  private readonly color: Float32Array;
  private readonly tile: Float32Array;
  private readonly aParam: THREE.InstancedBufferAttribute;
  private readonly aColor: THREE.InstancedBufferAttribute;
  private readonly aTile: THREE.InstancedBufferAttribute;

  constructor(opts: RingPoolOptions) {
    const cap = (this.capacity = Math.max(4, Math.floor(opts.capacity)));

    // A unit quad; the shader scales it by the animated radius. Two triangles
    // is plenty — the ring's shape comes from the atlas, not the mesh, which
    // means the same batch also draws soft discs and scorch marks.
    const geo = new THREE.PlaneGeometry(1, 1, 1, 1);

    this.param = new Float32Array(cap * 4);
    this.color = new Float32Array(cap * 4);
    this.tile = new Float32Array(cap);
    for (let i = 0; i < cap; i++) this.param[i * 4] = -1e9;

    this.aParam = new THREE.InstancedBufferAttribute(this.param, 4).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.InstancedBufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage);
    this.aTile = new THREE.InstancedBufferAttribute(this.tile, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aParam", this.aParam);
    geo.setAttribute("aColor", this.aColor);
    geo.setAttribute("aTile", this.aTile);

    const mat = new THREE.ShaderMaterial({
      name: opts.name,
      uniforms: {
        uTime: { value: 0 },
        uGrid: { value: opts.grid },
        uInset: { value: opts.inset },
        uMap: { value: opts.atlas },
        uIntensity: { value: opts.intensity },
        uFogColor: { value: new THREE.Color(0x9fc6e0) },
        uFogDensity: { value: 0 },
      },
      defines: opts.additive ? { ADDITIVE: "" } : {},
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: true,
      // Ground rings sit millimetres above tarmac; without the offset they
      // stipple against it the moment the camera gets low.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
    });
    mat.userData.own = true;

    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.name = opts.name;
    mesh.frustumCulled = false;
    mesh.renderOrder = opts.renderOrder;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Park every slot at the origin with zero scale so an unspawned instance
    // cannot flash a full-size quad on the first frame.
    tmpMatrix.makeScale(0, 0, 0);
    for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, tmpMatrix);
    mesh.instanceMatrix.needsUpdate = true;

    this.geometry = geo;
    this.material = mat;
    this.mesh = mesh;
  }

  /**
   * Spawn a ring on the plane through `position` with normal `normal`.
   * Colour is linear; `alpha` is the peak the envelope decays from.
   */
  spawn(
    position: THREE.Vector3,
    normal: THREE.Vector3,
    r0: number,
    r1: number,
    life: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
    tile: number,
    /** Lift off the surface in metres — stops co-planar stipple on tarmac. */
    lift = 0.06,
  ): void {
    const i = this.cursor;
    this.cursor = (i + 1) % this.capacity;

    tmpNormal.copy(normal);
    if (tmpNormal.lengthSq() < 1e-6) tmpNormal.copy(UP);
    tmpNormal.normalize();
    // Any tangent will do; pick the one least parallel to the normal so the
    // cross product never degenerates on a vertical wall.
    tmpTangent.copy(Math.abs(tmpNormal.y) > 0.94 ? SIDE : UP).cross(tmpNormal).normalize();
    tmpBitangent.copy(tmpNormal).cross(tmpTangent).normalize();
    tmpMatrix.makeBasis(tmpTangent, tmpBitangent, tmpNormal);
    tmpMatrix.setPosition(
      position.x + tmpNormal.x * lift,
      position.y + tmpNormal.y * lift,
      position.z + tmpNormal.z * lift,
    );
    this.mesh.setMatrixAt(i, tmpMatrix);

    const i4 = i * 4;
    this.param[i4] = this.time;
    this.param[i4 + 1] = life;
    // The quad is 1×1, so a radius of R needs a scale of 2R.
    this.param[i4 + 2] = r0 * 2;
    this.param[i4 + 3] = r1 * 2;
    this.color[i4] = r;
    this.color[i4 + 1] = g;
    this.color[i4 + 2] = b;
    this.color[i4 + 3] = alpha;
    this.tile[i] = tile;
    this.dirty = true;
  }

  update(elapsed: number): void {
    this.time = elapsed;
    this.material.uniforms.uTime.value = elapsed;
    if (!this.dirty) return;
    // Ring spawns are rare (a handful a second at most) and the buffers are
    // tiny, so a whole-buffer upload beats the bookkeeping of a watermark.
    this.aParam.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.aTile.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.dirty = false;
  }

  setFog(color: THREE.Color, density: number): void {
    (this.material.uniforms.uFogColor.value as THREE.Color).copy(color);
    this.material.uniforms.uFogDensity.value = density;
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) this.param[i * 4] = -1e9;
    this.aParam.needsUpdate = true;
    this.cursor = 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
