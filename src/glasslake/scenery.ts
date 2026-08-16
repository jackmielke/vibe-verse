/**
 * Everything around the lake, and everything falling on it.
 *
 * The shore's whole job is to be a silhouette. There is no light down here
 * except the sky, so the pines and the ridge behind them are drawn as flat
 * near-black shapes that get *slightly* bluer with distance — which is not
 * a cheat, it is what aerial perspective does to a black object at night.
 * Nothing on the shore is lit, textured or shaded, and the horizon still
 * reads as three separate distances.
 */
import * as THREE from "three";

export interface SceneryHandle {
  group: THREE.Group;
  update(dt: number, time: number, camera: THREE.Camera, energy: number): void;
  dispose(): void;
}

/** Deterministic per-world randomness, so the shore is the same lake twice. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function buildScenery(lakeRadius: number, snowCount: number): SceneryHandle {
  const group = new THREE.Group();
  const owned: Array<THREE.BufferGeometry | THREE.Material | THREE.Texture> = [];
  const keep = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(x: T): T => {
    owned.push(x);
    return x;
  };
  const rand = rng(0x91a5);

  // ---- The far ridge --------------------------------------------------
  // Two rings of cones at different distances and tints. The far one is
  // lighter, and that single value is the entire sense of depth out there.
  const ridge = (radius: number, count: number, minH: number, maxH: number, color: string) => {
    // Four-sided cones, rotated freely and buried to their waists. A cone
    // sitting on the ground with its whole base showing is a pyramid, and a
    // ring of evenly spaced ones is a row of pyramids — which is what this
    // horizon was until the depth, tilt and spacing were all jittered.
    const geo = keep(new THREE.ConeGeometry(1, 1, 4, 1));
    const mat = keep(new THREE.MeshBasicMaterial({ color, fog: false }));
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (rand() - 0.5) * 1.4;
      const r = radius * (0.72 + rand() * 0.62);
      const height = minH + Math.pow(rand(), 1.7) * (maxH - minH);
      // Sunk by up to a third, so the peaks all start from different depths
      // and the ridge reads as one range rather than a set of tents.
      const sink = height * (0.12 + rand() * 0.3);
      pos.set(Math.cos(a) * r, height * 0.5 - sink, Math.sin(a) * r);
      scale.set(height * (0.9 + rand() * 1.5), height, height * (0.9 + rand() * 1.5));
      e.set((rand() - 0.5) * 0.16, rand() * Math.PI, (rand() - 0.5) * 0.16);
      q.setFromEuler(e);
      m.compose(pos, q, scale);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };

  // Far enough back that nothing looms. The near ring sat 70 m off the shore
  // and 80 m tall, which put a black wall across a third of the sky from the
  // middle of the lake — and the sky is the thing you came for.
  // Heights are picked against the aurora, not against realism: the arc sits
  // low in the sky, and a skyline that subtends more than about fifteen
  // degrees eats the thing everybody came to look at.
  ridge(lakeRadius * 7.0, 46, 120, 380, "#0a1322");
  ridge(lakeRadius * 4.6, 54, 60, 170, "#070e19");
  ridge(lakeRadius * 3.1, 60, 26, 78, "#04080f");

  // ---- The pines ------------------------------------------------------
  // A band just past the shore, thickest at the waterline. Two instanced
  // meshes — trunks and crowns — is two draw calls for six hundred trees.
  const treeCount = 620;
  const trunkGeo = keep(new THREE.CylinderGeometry(0.16, 0.28, 1, 5));
  const trunkMat = keep(new THREE.MeshBasicMaterial({ color: "#0a0a10", fog: false }));
  const crownGeo = keep(new THREE.ConeGeometry(1, 1, 7, 3));
  const crownMat = keep(new THREE.MeshBasicMaterial({ color: "#05090f", fog: false }));
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, treeCount);
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (let i = 0; i < treeCount; i++) {
      const a = rand() * Math.PI * 2;
      // Bias inward: a dense front rank at the shore thinning out behind.
      const depth = Math.pow(rand(), 0.6);
      const r = lakeRadius * (1.02 + depth * 0.85);
      const height = 7 + rand() * 16;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI);

      pos.set(x, height * 0.12, z);
      scale.set(1, height * 0.28, 1);
      m.compose(pos, q, scale);
      trunks.setMatrixAt(i, m);

      pos.set(x, height * 0.58, z);
      scale.set(height * (0.16 + rand() * 0.08), height * 0.86, height * (0.16 + rand() * 0.08));
      m.compose(pos, q, scale);
      crowns.setMatrixAt(i, m);
    }
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    trunks.frustumCulled = false;
    crowns.frustumCulled = false;
    group.add(trunks, crowns);
  }

  // ---- Snow -----------------------------------------------------------
  // A box of flakes that follows the camera and wraps. There is no such
  // thing as "all the snow in the world" — there is only snow near you.
  const SNOW_BOX = 90;
  const snowGeo = keep(new THREE.BufferGeometry());
  const snowPos = new Float32Array(snowCount * 3);
  const snowSeed = new Float32Array(snowCount);
  for (let i = 0; i < snowCount; i++) {
    snowPos[i * 3] = (rand() - 0.5) * SNOW_BOX * 2;
    snowPos[i * 3 + 1] = rand() * SNOW_BOX;
    snowPos[i * 3 + 2] = (rand() - 0.5) * SNOW_BOX * 2;
    snowSeed[i] = rand();
  }
  snowGeo.setAttribute("position", new THREE.BufferAttribute(snowPos, 3));
  snowGeo.setAttribute("aSeed", new THREE.BufferAttribute(snowSeed, 1));
  const snowMat = keep(
    new THREE.ShaderMaterial({
      name: "GlassLakeSnow",
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uOrigin: { value: new THREE.Vector3() },
        uBox: { value: SNOW_BOX },
        uSize: { value: 1 },
        uTint: { value: new THREE.Color("#bfe6ff") },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        uniform vec3 uOrigin;
        uniform float uBox;
        uniform float uSize;
        varying float vFade;
        void main() {
          vec3 p = position;
          // Fall, drift, and wrap around the camera in all three axes.
          p.y -= uTime * (1.2 + aSeed * 1.8);
          p.x += sin(uTime * 0.35 + aSeed * 24.0) * 2.4;
          p.z += cos(uTime * 0.28 + aSeed * 17.0) * 2.4;
          p += uOrigin;
          vec3 rel = p - uOrigin;
          p -= floor((rel + uBox * 0.5) / uBox) * uBox;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = -mv.z;
          vFade = smoothstep(0.0, 6.0, d) * smoothstep(uBox * 0.9, uBox * 0.35, d);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * (14.0 + aSeed * 16.0) / max(d, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform vec3 uTint;
        varying float vFade;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.05, length(d)) * vFade;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uTint * a, a);
        }
      `,
    }),
  );
  const snow = new THREE.Points(snowGeo, snowMat);
  snow.frustumCulled = false;
  group.add(snow);

  return {
    group,
    update(_dt, time, camera, energy) {
      snowMat.uniforms.uTime.value = time;
      (snowMat.uniforms.uOrigin.value as THREE.Vector3).copy(camera.position);
      // Snow catches the aurora, so it warms as the sky fills in.
      (snowMat.uniforms.uTint.value as THREE.Color)
        .set("#bfe6ff")
        .lerp(new THREE.Color("#d8c4ff"), energy * 0.6);
    },
    dispose() {
      owned.forEach((o) => o.dispose());
    },
  };
}
