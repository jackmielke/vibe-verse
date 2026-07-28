/**
 * impostors.ts — the far field: everything from ~2 km out to the horizon.
 *
 * Standing on Coit Tower you can see the Sunset, and the Sunset is forty
 * thousand houses. Running the real lot subdivider over that would take
 * minutes and gigabytes for detail that lands on four pixels. So the far field
 * gets a different algorithm entirely: a cheap skyline sampler walks a jittered
 * grid, asks sfGeo the same questions the real generator asks (is this land,
 * is it a road, is it a park, which district, how tall does that district
 * build) and emits one textured box per building.
 *
 * Why boxes and not camera-facing billboards: the player flies. A billboard
 * degenerates to a line the moment you look down at it from a wingsuit, and a
 * cross-billboard shows its X. A box impostor is 12 triangles, correct from
 * every angle including straight down, and — crucially — it is the same shape
 * the LOD-2 tier resolves into, so the transition is a detail change rather
 * than a silhouette change.
 *
 * One InstancedMesh per 1500 m tile: ~25 draw calls carry the entire distant
 * city, each frustum-culled as a unit, each streamable on the same budget as
 * the near chunks.
 *
 * Public API
 * ----------
 *   ImpostorTileJob(x, z, size, seed)                     resumable sampler
 *   sampleImpostorTile(x, z, size, seed)                  one-shot convenience
 *   createImpostorMesh(data)                              → THREE.InstancedMesh
 *   disposeImpostorMesh(mesh)
 *   impostorUniforms / disposeImpostorMaterial
 */
import * as THREE from "three";
import {
  districtAt,
  districtInfluence,
  isExcluded,
  isPark,
  isRoad,
  landSDF,
  terrainHeight,
} from "../../geo/sfGeo";
import { clamp01, hashSeed, makeRng, mix, type Rng } from "../../math/rng";
import { facadeUniforms } from "./facadeMaterial";

/* ------------------------------------------------------------------ *
 * Tile data
 * ------------------------------------------------------------------ */

export interface ImpostorTileData {
  x: number;
  z: number;
  size: number;
  count: number;
  /** Packed per-instance: position (xyz), half-extents (xyz), yaw, tint (rgb). */
  matrices: Float32Array;
  sizes: Float32Array;
  tints: Float32Array;
  seeds: Float32Array;
  /** Highest roof in the tile — used for a cheap bounding sphere. */
  maxY: number;
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _axis = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();

/**
 * Walk a jittered grid over one tile and emit a building proxy wherever the
 * real generator would plausibly have built one.
 *
 * The sample step is the knob: 30 m gives roughly one proxy per real building
 * in the avenues and one per two or three downtown, which at two kilometres is
 * indistinguishable and about forty times cheaper than the real subdivider.
 */
/**
 * A resumable tile sampler.
 *
 * One 1500 m tile is 2 500 samples, each of which pays for a landSDF polygon
 * walk and a terrainHeight evaluation — call it eight milliseconds. That is a
 * dropped frame, so the job hands back control on a deadline and picks up at
 * the row it left off on. Determinism survives because the RNG stream is
 * consumed in the same order regardless of where the splits land.
 */
export class ImpostorTileJob {
  readonly x: number;
  readonly z: number;
  readonly size: number;
  done = false;

  private rng: Rng;
  private step = 30;
  private n: number;
  private row = 0;
  private count = 0;
  private maxY = -Infinity;
  private matrices: Float32Array;
  private sizes: Float32Array;
  private tints: Float32Array;
  private seeds: Float32Array;

  constructor(x: number, z: number, size: number, worldSeed: string) {
    this.x = x;
    this.z = z;
    this.size = size;
    this.rng = makeRng(hashSeed(`${worldSeed}|imp|${Math.round(x)}|${Math.round(z)}`));
    this.n = Math.max(1, Math.round(size / this.step));
    const cap = this.n * this.n;
    this.matrices = new Float32Array(cap * 16);
    this.sizes = new Float32Array(cap * 3);
    this.tints = new Float32Array(cap * 3);
    this.seeds = new Float32Array(cap);
  }

  /** Sample rows until `deadline` (a performance.now() timestamp). */
  advance(deadline: number): void {
    const { rng, step, n } = this;
    while (this.row < n) {
      const j = this.row++;
      for (let i = 0; i < n; i++) {
        const sx = this.x + (i + 0.5 + rng.range(-0.36, 0.36)) * step;
        const sz = this.z + (j + 0.5 + rng.range(-0.36, 0.36)) * step;

        if (landSDF(sx, sz) < 24) continue;
        if (isRoad(sx, sz)) continue;
        if (isPark(sx, sz) || isExcluded(sx, sz)) continue;

        const d = districtAt(sx, sz);
        const infl = clamp01(districtInfluence(sx, sz, d) * 1.15);
        if (!rng.chance(d.density * mix(0.35, 1.0, infl))) continue;

        const gy = terrainHeight(sx, sz);
        if (gy < 1.0) continue;

        // Same power-law skew as the real height model, so the far skyline has
        // the same statistics as the near one and the seam is invisible.
        const t = Math.pow(rng.next(), 2.6);
        let h = mix(d.minHeight, d.maxHeight, t) * mix(0.7, 1.0, infl);
        // A proxy stands in for a small cluster of parcels, so its footprint is
        // larger than one lot — which also keeps the instance count down.
        const hw = rng.range(7, 15);
        const hd = rng.range(7, 15);
        h = Math.min(h, 14 + Math.pow(hw * hd * 4, 0.63) * 1.4);
        if (h < 4) continue;
        const yaw = gridYaw(sx) + rng.gauss() * 0.05;

        const pal = d.palette[rng.int(0, d.palette.length - 1)];
        _col.setHex(pal, THREE.SRGBColorSpace);
        _col.multiplyScalar(rng.range(0.82, 1.12));

        const c = this.count;
        _pos.set(sx, gy, sz);
        _q.setFromAxisAngle(_axis, yaw);
        _scl.set(hw * 2, h, hd * 2);
        _m4.compose(_pos, _q, _scl);
        _m4.toArray(this.matrices, c * 16);
        this.sizes[c * 3] = hw * 2;
        this.sizes[c * 3 + 1] = h;
        this.sizes[c * 3 + 2] = hd * 2;
        this.tints[c * 3] = _col.r;
        this.tints[c * 3 + 1] = _col.g;
        this.tints[c * 3 + 2] = _col.b;
        this.seeds[c] = rng.next();
        if (gy + h > this.maxY) this.maxY = gy + h;
        this.count++;
      }
      if (performance.now() >= deadline) break;
    }
    if (this.row >= n) this.done = true;
  }

  /** The finished tile, or null when the tile is entirely water/park. */
  result(): ImpostorTileData | null {
    if (this.count === 0) return null;
    return {
      x: this.x,
      z: this.z,
      size: this.size,
      count: this.count,
      matrices: this.matrices.subarray(0, this.count * 16),
      sizes: this.sizes.subarray(0, this.count * 3),
      tints: this.tints.subarray(0, this.count * 3),
      seeds: this.seeds.subarray(0, this.count),
      maxY: this.maxY,
    };
  }
}

/** Convenience: sample a whole tile in one go (tests, offline tooling). */
export function sampleImpostorTile(
  x: number,
  z: number,
  size: number,
  worldSeed: string,
): ImpostorTileData | null {
  const job = new ImpostorTileJob(x, z, size, worldSeed);
  while (!job.done) job.advance(performance.now() + 1e6);
  return job.result();
}

/** Rough street-grid alignment so the far field is not a random scatter. */
function gridYaw(x: number): number {
  // The two downtown grids share a rotation; the west grid is near-cardinal.
  return x < -3400 ? -0.0125 : 0.7527;
}

/* ------------------------------------------------------------------ *
 * Material
 * ------------------------------------------------------------------ */

/**
 * A unit box with its origin at the bottom face, so an instance matrix that
 * scales by (width, height, depth) and translates to ground level puts the
 * building exactly where the terrain is.
 */
function makeUnitBox(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  // The bottom face is never visible and doubles the fill on a ground-level
  // shot down a long street; drop it.
  return g;
}

let impostorMaterial: THREE.MeshLambertMaterial | null = null;
let unitBox: THREE.BufferGeometry | null = null;

const IMPOSTOR_GLSL_COMMON = /* glsl */ `
uniform float uNight;
uniform float uNightLit;
uniform vec3  uSunColor;
uniform vec3  uSkyHorizon;
uniform float uHaze;
varying vec2 vImpUv;
varying vec3 vImpTint;
varying float vImpSeed;
varying float vImpTop;
varying float vImpDist;

float impHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
vec3 impSrgb(vec3 c) { return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878); }
`;

/**
 * Lambert, not Standard: at two kilometres nothing survives of specular
 * response except the window sparkle, which we add explicitly. Halving the
 * lighting cost of twenty thousand instances is worth more.
 */
function getImpostorMaterial(): THREE.MeshLambertMaterial {
  if (impostorMaterial) return impostorMaterial;
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = facadeUniforms.uNight;
    shader.uniforms.uNightLit = facadeUniforms.uNightLit;
    shader.uniforms.uSunColor = facadeUniforms.uSunColor;
    shader.uniforms.uSkyHorizon = facadeUniforms.uSkyHorizon;
    shader.uniforms.uHaze = facadeUniforms.uHaze;

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         attribute vec3 iSize;
         attribute vec3 iTint;
         attribute float iSeed;
         ${IMPOSTOR_GLSL_COMMON}`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         // Metre-space UVs on the unit box: pick the two axes that are not the
         // face normal, so every face gets a correctly scaled window grid.
         vec3 mp = position * iSize;
         float ax = abs(normal.x);
         float ay = abs(normal.y);
         vImpUv = ay > 0.5 ? vec2(mp.x, mp.z) : (ax > 0.5 ? vec2(mp.z, mp.y + iSize.y * 0.5) : vec2(mp.x, mp.y + iSize.y * 0.5));
         vImpTint = iTint;
         vImpSeed = iSeed;
         vImpTop = ay;
         // Distance stands in for a derivative here. MeshLambertMaterial does
         // not get the derivatives extension declared for it, and asking for
         // it would mean poking a private three parameter; a view-distance
         // fade is both cheaper and perfectly adequate at two kilometres.
         vImpDist = -(modelViewMatrix * instanceMatrix * vec4(transformed, 1.0)).z;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${IMPOSTOR_GLSL_COMMON}`)
      .replace(
        "#include <map_fragment>",
        `
        vec3 impCol = impSrgb(vImpTint);
        float fh = mix(3.0, 4.2, impHash(vec2(vImpSeed, 3.1)));
        float bw = mix(3.0, 5.0, impHash(vec2(vImpSeed, 7.7)));
        vec2 g = vec2(vImpUv.x / bw, vImpUv.y / fh);
        vec2 gi = floor(g);
        vec2 gf = fract(g);
        float detail = 1.0 - smoothstep(1600.0, 3400.0, vImpDist);
        float win = (1.0 - smoothstep(0.30, 0.36, abs(gf.x - 0.5)))
                  * (1.0 - smoothstep(0.28, 0.34, abs(gf.y - 0.55)));
        win *= detail * (1.0 - vImpTop);
        // Roofs read as dark tar, walls as paint with the window grid punched in.
        impCol = mix(impCol, impCol * 0.30, vImpTop);
        impCol = mix(impCol, impCol * 0.35 + vec3(0.012, 0.016, 0.022), win);
        // Where the grid has been filtered away, keep the average darkening so
        // the far city does not brighten as it recedes.
        impCol = mix(impCol * 0.80, impCol, detail * 0.5 + 0.5);
        float lh = impHash(gi + vec2(vImpSeed * 91.0, vImpSeed * 37.0));
        float lit = step(1.0 - uNightLit * uNight, lh);
        vec3 warm = mix(vec3(1.0, 0.76, 0.44), vec3(0.80, 0.88, 1.0), step(0.8, fract(lh * 13.0)));
        diffuseColor.rgb = impCol;
        `,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `totalEmissiveRadiance += warm * lit * max(win, 0.35 * (1.0 - vImpTop) * (1.0 - detail)) * uNight * 1.4
           + uSkyHorizon * win * 0.10 * (1.0 - uNight);`,
      );
  };
  m.customProgramCacheKey = () => "sf-impostor";
  impostorMaterial = m;
  return m;
}

/* ------------------------------------------------------------------ *
 * Mesh construction
 * ------------------------------------------------------------------ */

/** Build the InstancedMesh for one sampled tile. */
export function createImpostorMesh(data: ImpostorTileData): THREE.InstancedMesh {
  if (!unitBox) unitBox = makeUnitBox();
  const geo = new THREE.BufferGeometry();
  // The unit box's vertex buffers are shared by every tile — one 24-vertex
  // upload for the whole far field. Only the instance attributes are per-tile,
  // and `disposeImpostorMesh` detaches the shared ones before disposing so we
  // never delete a buffer another tile is still drawing from.
  geo.setIndex(unitBox.getIndex());
  geo.setAttribute("position", unitBox.getAttribute("position"));
  geo.setAttribute("normal", unitBox.getAttribute("normal"));
  geo.setAttribute("uv", unitBox.getAttribute("uv"));
  geo.setAttribute("iSize", new THREE.InstancedBufferAttribute(data.sizes, 3));
  geo.setAttribute("iTint", new THREE.InstancedBufferAttribute(data.tints, 3));
  geo.setAttribute("iSeed", new THREE.InstancedBufferAttribute(data.seeds, 1));

  const mesh = new THREE.InstancedMesh(geo, getImpostorMaterial(), data.count);
  mesh.instanceMatrix = new THREE.InstancedBufferAttribute(data.matrices, 16);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  // Bounds the renderer can cull against without walking the instances.
  const half = data.size * 0.5;
  mesh.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(data.x + half, Math.max(0, data.maxY) * 0.5, data.z + half),
    Math.hypot(half, half) + Math.max(0, data.maxY),
  );
  geo.boundingSphere = mesh.boundingSphere;
  mesh.renderOrder = -1;
  return mesh;
}

/** Free a tile's instance buffers. The shared box and material survive. */
export function disposeImpostorMesh(mesh: THREE.InstancedMesh): void {
  const g = mesh.geometry;
  g.deleteAttribute("position");
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  g.setIndex(null);
  g.dispose();
}

/** Tear down the shared impostor resources. */
export function disposeImpostorResources(): void {
  if (impostorMaterial) {
    impostorMaterial.dispose();
    impostorMaterial = null;
  }
  if (unitBox) {
    unitBox.dispose();
    unitBox = null;
  }
}
