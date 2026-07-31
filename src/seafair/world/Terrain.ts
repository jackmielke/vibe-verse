import * as THREE from "three";
import { makeNoise2D, canvasTexture, normalFromHeight } from "../core/Assets";
import type { QualityProfile } from "../core/Settings";

/**
 * The Genesee / Stan Sayres peninsula on the west shore of Lake Washington —
 * the real Seafair hydro pit location — plus the bluff rising toward Mount
 * Baker Ridge and, far to the west, the downtown plateau.
 *
 * Origin (0,0,0) is the shoreline at the pit gate. +X runs north along the
 * shore, -Z heads out into the lake, +Z climbs inland toward the city.
 */

export interface TerrainRig {
  mesh: THREE.Mesh;
  /** Ground height at (x, z). Below sea level means underwater. */
  height: (x: number, z: number) => number;
  /** Ground normal at (x, z). */
  normal: (x: number, z: number, out?: THREE.Vector3) => THREE.Vector3;
  /** True where the player can stand (above water, not too steep). */
  walkable: (x: number, z: number) => boolean;
  dispose: () => void;
}

const EXTENT = 2400;

export function createTerrain(scene: THREE.Scene, profile: QualityProfile): TerrainRig {
  const { fbm } = makeNoise2D(90210);

  /**
   * Shoreline shape. The peninsula is a flat spit at ~2.2m that drops sharply
   * into the lake to the west/south and climbs the bluff to the east.
   */
  const height = (x: number, z: number): number => {
    // Inland ramp: rises going +Z
    const inland = THREE.MathUtils.smoothstep(z, -20, 420);
    let h = -9 + inland * 11.2;

    // Flat park pad for the pits, roughly 260 x 150m
    const padX = THREE.MathUtils.smoothstep(1 - Math.abs(x) / 190, 0, 0.35);
    const padZ = THREE.MathUtils.smoothstep(1 - Math.abs(z - 60) / 110, 0, 0.4);
    h = THREE.MathUtils.lerp(h, 2.4, padX * padZ * 0.94);

    // Bluff climbing to Mount Baker Ridge
    const bluff = THREE.MathUtils.smoothstep(z, 380, 1050);
    h += bluff * 86;

    // Downtown plateau far to the west+north
    const dt = THREE.MathUtils.smoothstep(z, 1000, 1900);
    h += dt * 42;

    // Terrain detail
    const macro = fbm(x * 0.0016, z * 0.0016, 5) * 26;
    const meso = fbm(x * 0.011, z * 0.011, 4) * 3.4;
    const micro = fbm(x * 0.06, z * 0.06, 3) * 0.42;
    const detailMask = 1 - padX * padZ * 0.9;
    h += (macro * THREE.MathUtils.smoothstep(z, 120, 700) + meso + micro) * detailMask;

    // Carve the lake bed going -Z
    const lake = THREE.MathUtils.smoothstep(-z, 20, 700);
    h -= lake * 34;

    return h;
  };

  const normal = (x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 => {
    const e = 0.9;
    return out
      .set(height(x - e, z) - height(x + e, z), 2 * e, height(x, z - e) - height(x, z + e))
      .normalize();
  };

  const walkable = (x: number, z: number): boolean => {
    const h = height(x, z);
    if (h < 0.35) return false;
    const n = normal(x, z);
    return n.y > 0.66;
  };

  // --- geometry ---
  const segs = profile.tier === "low" ? 180 : profile.tier === "medium" ? 260 : 380;
  const geo = new THREE.PlaneGeometry(EXTENT * 2, EXTENT * 2, segs, segs);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;

  // Push vertices toward the origin logarithmically so the playable area gets
  // most of the triangles while the mesh still reaches the horizon.
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if (r > 1) {
      const warped = Math.pow(r / EXTENT, 1.9) * EXTENT;
      x *= warped / r;
      z *= warped / r;
      pos.setX(i, x);
      pos.setZ(i, z);
    }
    pos.setY(i, height(x, z));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();

  // --- material: blended grass / gravel / sand driven by height + slope ---
  const S = profile.textureSize;

  const albedo = canvasTexture(
    "terrain-albedo",
    S,
    (ctx, s) => {
      const { fbm: f } = makeNoise2D(4242);
      const img = ctx.createImageData(s, s);
      const d = img.data;
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const n = f((x / s) * 9, (y / s) * 9, 5) * 0.5 + 0.5;
          const n2 = f((x / s) * 34 + 5, (y / s) * 34, 3) * 0.5 + 0.5;
          // parched August grass — olive with straw-coloured patches
          const t = THREE.MathUtils.clamp(n * 0.75 + n2 * 0.25, 0, 1);
          const r = THREE.MathUtils.lerp(78, 150, t);
          const g = THREE.MathUtils.lerp(96, 143, t);
          const b = THREE.MathUtils.lerp(46, 78, t);
          const i = (y * s + x) * 4;
          d[i] = r;
          d[i + 1] = g;
          d[i + 2] = b;
          d[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    },
    { repeat: 90 },
  );

  const nrm = normalFromHeight(
    "terrain",
    Math.min(S, 512),
    (x, y) => {
      const { fbm: f } = makeNoise2D(4242);
      return f(x * 26, y * 26, 4) * 0.5 + 0.5;
    },
    2.6,
  );
  nrm.repeat.set(90, 90);

  const mat = new THREE.MeshStandardMaterial({
    map: albedo,
    normalMap: nrm,
    normalScale: new THREE.Vector2(0.85, 0.85),
    roughness: 0.94,
    metalness: 0,
    dithering: true,
  });

  // Slope-based rock/sand blending, injected into the standard material.
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vTerrainWorld;\nvarying vec3 vTerrainNormal;")
      .replace(
        "#include <worldpos_vertex>",
        "#include <worldpos_vertex>\nvTerrainWorld = (modelMatrix * vec4(position, 1.0)).xyz;\nvTerrainNormal = normalize(mat3(modelMatrix) * normal);",
      );

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vTerrainWorld;\nvarying vec3 vTerrainNormal;")
      .replace(
        "#include <map_fragment>",
        /* glsl */ `
        #include <map_fragment>
        float slope = 1.0 - clamp(vTerrainNormal.y, 0.0, 1.0);
        vec3 rock = vec3(0.34, 0.32, 0.30);
        vec3 sand = vec3(0.74, 0.68, 0.55);
        float rockAmt = smoothstep(0.28, 0.62, slope);
        float sandAmt = 1.0 - smoothstep(0.6, 4.2, vTerrainWorld.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, sand, sandAmt * 0.72);
        diffuseColor.rgb = mix(diffuseColor.rgb, rock, rockAmt);
        // wet darkening right at the waterline
        float wet = 1.0 - smoothstep(-0.4, 1.1, vTerrainWorld.y);
        diffuseColor.rgb *= mix(1.0, 0.52, wet);
        `,
      );
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = "terrain";
  scene.add(mesh);

  return {
    mesh,
    height,
    normal,
    walkable,
    dispose: () => {
      geo.dispose();
      mat.dispose();
      scene.remove(mesh);
    },
  };
}
