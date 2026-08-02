/**
 * Vibe Kart — the sectorised instance field.
 *
 * One `InstancedMesh` per prop type would be one draw call for the whole
 * circuit, which sounds ideal until you remember that a mesh is culled as a
 * unit: a single instanced mesh wrapped around a two-kilometre lap is *never*
 * off screen, so every frame pays to transform every tree on the track,
 * including the ones two corners behind you. On the software rasteriser the
 * screenshot harness uses, that is the difference between a shot and a timeout.
 *
 * So the circuit is cut into sectors along the centreline and each prop type
 * gets one `InstancedMesh` per sector it actually occupies. Geometry and
 * material stay shared — the only per-sector cost is the instance matrix buffer,
 * which we were going to pay anyway — and `update()` toggles visibility with a
 * distance test plus a frustum test against the sector's bounding sphere.
 *
 * In practice a chase-camera frame draws four or five sectors, so the count
 * lands around 30–45 instanced draw calls for the entire trackside dressing.
 */
import * as THREE from "three";

export interface KindOptions {
  name: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Metres past the sector's own radius at which this kind stops drawing. */
  viewDistance: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  renderOrder?: number;
  /** Shadow material carrying the same vertex animation (see wind.ts). */
  customDepthMaterial?: THREE.Material;
  /** Per-instance tint. Only allocate the buffer for kinds that use it. */
  colored?: boolean;
}

interface Bucket {
  matrices: number[];
  colors: number[] | null;
  min: THREE.Vector3;
  max: THREE.Vector3;
}

interface Kind {
  opts: KindOptions;
  buckets: Map<number, Bucket>;
  meshes: THREE.InstancedMesh[];
  count: number;
}

export interface FieldStats {
  kinds: number;
  meshes: number;
  instances: number;
  triangles: number;
}

const SPHERE = new THREE.Sphere();
const TMP = new THREE.Vector3();

export class SceneryField {
  readonly root = new THREE.Group();
  private kinds: Kind[] = [];
  private sectorGroups = new Map<number, THREE.Group>();
  private built = false;

  constructor(name = "scenery/field") {
    this.root.name = name;
    // Sector groups get their bounds set by hand; three's automatic frustum
    // cull would use the InstancedMesh's own sphere, which we also want, so
    // both are left on and the distance test below does the coarse work.
    this.root.matrixAutoUpdate = false;
  }

  define(opts: KindOptions): number {
    this.kinds.push({ opts, buckets: new Map(), meshes: [], count: 0 });
    return this.kinds.length - 1;
  }

  /** Queue one instance of `kind` into `sector`. Matrices are copied, not held. */
  add(kind: number, sector: number, matrix: THREE.Matrix4, color?: THREE.Color): void {
    const k = this.kinds[kind];
    if (!k) return;
    let b = k.buckets.get(sector);
    if (!b) {
      b = {
        matrices: [],
        colors: k.opts.colored ? [] : null,
        min: new THREE.Vector3(Infinity, Infinity, Infinity),
        max: new THREE.Vector3(-Infinity, -Infinity, -Infinity),
      };
      k.buckets.set(sector, b);
    }
    const e = matrix.elements;
    for (let i = 0; i < 16; i++) b.matrices.push(e[i]);
    if (b.colors) b.colors.push(color ? color.r : 1, color ? color.g : 1, color ? color.b : 1);
    // Bounds from instance origins; the kind's own geometry radius is added at
    // build time so a tall tree at the sector edge is not clipped early.
    TMP.set(e[12], e[13], e[14]);
    b.min.min(TMP);
    b.max.max(TMP);
    k.count++;
  }

  /** Realise every bucket as an InstancedMesh. Call once, after all placement. */
  build(): void {
    if (this.built) return;
    this.built = true;
    for (const k of this.kinds) {
      const geoRadius = k.opts.geometry.boundingSphere?.radius ?? 4;
      for (const [sector, b] of k.buckets) {
        const n = b.matrices.length / 16;
        if (n === 0) continue;
        const mesh = new THREE.InstancedMesh(k.opts.geometry, k.opts.material, n);
        mesh.name = `${k.opts.name}#${sector}`;
        mesh.instanceMatrix.set(b.matrices);
        mesh.instanceMatrix.needsUpdate = true;
        // Static dressing: tell the driver so it can park the buffer in VRAM.
        mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        if (b.colors) {
          mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(b.colors), 3);
          mesh.instanceColor.needsUpdate = true;
        }
        mesh.castShadow = !!k.opts.castShadow;
        mesh.receiveShadow = k.opts.receiveShadow !== false;
        if (k.opts.renderOrder !== undefined) mesh.renderOrder = k.opts.renderOrder;
        if (k.opts.customDepthMaterial) mesh.customDepthMaterial = k.opts.customDepthMaterial;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();

        // three computes an instanced bounding sphere lazily and expensively;
        // we already know the extent, so hand it over.
        const centre = b.min.clone().add(b.max).multiplyScalar(0.5);
        const radius = b.min.distanceTo(b.max) * 0.5 + geoRadius;
        mesh.boundingSphere = new THREE.Sphere(centre, radius);
        mesh.boundingBox = new THREE.Box3(
          b.min.clone().subScalar(geoRadius),
          b.max.clone().addScalar(geoRadius),
        );
        // Our own visibility pass is strictly better informed than three's, and
        // three's would recompute the instanced sphere on every frame.
        mesh.frustumCulled = false;

        this.groupFor(sector).add(mesh);
        k.meshes.push(mesh);
      }
      k.buckets.clear();
    }
  }

  private groupFor(sector: number): THREE.Group {
    let g = this.sectorGroups.get(sector);
    if (!g) {
      g = new THREE.Group();
      g.name = `sector${sector}`;
      g.matrixAutoUpdate = false;
      this.root.add(g);
      this.sectorGroups.set(sector, g);
    }
    return g;
  }

  /**
   * Visibility pass. Two tests, cheapest first: a squared-distance reject, then
   * a frustum test against the mesh's precomputed sphere. Roughly two hundred
   * comparisons a frame for a fully dressed circuit.
   */
  update(cameraPosition: THREE.Vector3, frustum: THREE.Frustum | null): void {
    for (const k of this.kinds) {
      const far = k.opts.viewDistance;
      for (const mesh of k.meshes) {
        const s = mesh.boundingSphere;
        if (!s) continue;
        const d = cameraPosition.distanceTo(s.center) - s.radius;
        if (d > far) {
          mesh.visible = false;
          continue;
        }
        if (frustum) {
          SPHERE.copy(s);
          mesh.visible = frustum.intersectsSphere(SPHERE);
        } else {
          mesh.visible = true;
        }
      }
    }
  }

  /** Show everything regardless of distance — used while posing scenic shots. */
  revealAll(): void {
    for (const k of this.kinds) for (const m of k.meshes) m.visible = true;
  }

  stats(): FieldStats {
    let meshes = 0;
    let instances = 0;
    let triangles = 0;
    for (const k of this.kinds) {
      meshes += k.meshes.length;
      instances += k.count;
      const idx = k.opts.geometry.getIndex();
      const pos = k.opts.geometry.getAttribute("position");
      const tris = (idx ? idx.count : pos ? pos.count : 0) / 3;
      triangles += tris * k.count;
    }
    return { kinds: this.kinds.length, meshes, instances, triangles: Math.round(triangles) };
  }

  /**
   * Geometries and materials are owned by the `Resources` pool, not by us —
   * several kinds deliberately share them. All that is freed here is the
   * per-mesh instance buffers.
   */
  dispose(): void {
    for (const k of this.kinds) {
      for (const m of k.meshes) {
        m.dispose();
        m.removeFromParent();
      }
      k.meshes.length = 0;
    }
    this.kinds.length = 0;
    this.sectorGroups.clear();
    this.root.removeFromParent();
    this.root.clear();
  }
}
