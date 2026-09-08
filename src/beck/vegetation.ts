/**
 * The trees, which on Bainbridge are most of what you see: Douglas fir and
 * western red cedar in the wood polygons, big-leaf maple and alder at the
 * edges, madrona leaning out over the water, and salal and sword fern under
 * all of it. Placement follows the land data (forest, tree rows, single
 * mapped trees, hedges) and keeps out of buildings, roads and lawns.
 */
import * as THREE from "three";
import { lines, mulberry32, pointInRing, ringBounds, rings, nearestOnLine, type Neighbourhood } from "./geo";
import type { Buildings } from "./buildings";
import type { Ground } from "./terrain";
import { bark, disposeSurface, fernCard, firFrond, surfaceMaterial } from "./textures";

export interface Vegetation {
  group: THREE.Group;
  trunks: { x: number; z: number; r: number }[];
  update(time: number, wind: number): void;
  dispose(): void;
}

type Species = "fir" | "cedar" | "maple" | "madrona";

const FROND_VERT = /* glsl */ `
uniform float uTime; uniform float uWind;
varying vec2 vUv; varying float vShade;
#include <common>
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec4 wp = instanceMatrix * vec4(position, 1.0);
  vec4 base = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float phase = base.x * 0.11 + base.z * 0.07;
  float sway = (sin(uTime * 1.1 + phase) * 0.6 + sin(uTime * 2.3 + phase * 1.7) * 0.4) * uWind;
  wp.x += sway * 0.12 * uv.y;
  wp.z += sway * 0.08 * uv.y;
  vec4 mvPosition = viewMatrix * modelMatrix * wp;
  vShade = 0.55 + 0.45 * uv.y;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

export function buildVegetation(data: Neighbourhood, ground: Ground, buildings: Buildings): Vegetation {
  const group = new THREE.Group();
  const rnd = mulberry32(7331);
  const trunks: Vegetation["trunks"] = [];

  // Keep-out: road ribbons and building footprints.
  const roadLines = data.roads.filter((r) => r.cls !== "footway" && r.cls !== "path").flatMap((r) => lines(r.g).map((l) => ({ l, w: r.cls === "service" ? 2.6 : r.cls === "track" ? 2 : 5.5 })));
  const blocked = (x: number, z: number, margin: number) => {
    for (const f of buildings.footprints) {
      if (Math.hypot(f.cx - x, f.cz - z) < f.r + margin) return true;
    }
    for (const r of roadLines) {
      const n = nearestOnLine(x, z, r.l);
      if (n.d < r.w + margin) return true;
    }
    return false;
  };

  // Where trees go.
  const spots: { x: number; z: number; sp: Species; k: number }[] = [];
  const forest = data.land.filter((l) => l.sub === "forest").flatMap((l) => rings(l.g));
  for (const ring of forest) {
    const b = ringBounds(ring);
    const area = (b.maxX - b.minX) * (b.maxZ - b.minZ);
    // One canopy tree per ~55 m2 of forest, which is a mature second-growth stand.
    const n = Math.min(2600, Math.floor(area / 55));
    for (let i = 0; i < n; i++) {
      const x = b.minX + rnd() * (b.maxX - b.minX);
      const z = b.minZ + rnd() * (b.maxZ - b.minZ);
      if (!pointInRing(x, z, ring) || blocked(x, z, 1.5)) continue;
      const r = rnd();
      spots.push({ x, z, sp: r < 0.55 ? "fir" : r < 0.8 ? "cedar" : r < 0.95 ? "maple" : "madrona", k: 0.7 + rnd() * 0.8 });
    }
  }
  // Mapped single trees and tree rows.
  for (const t of data.land) {
    if (t.sub !== "tree") continue;
    if (t.g.t === "pt") spots.push({ x: t.g.c[0], z: t.g.c[1], sp: rnd() < 0.5 ? "fir" : "maple", k: 0.9 + rnd() * 0.5 });
    else for (const l of lines(t.g)) for (let i = 0; i < l.length; i++) spots.push({ x: l[i][0], z: l[i][1], sp: "cedar", k: 0.7 + rnd() * 0.4 });
  }
  // Scattered yard trees in the residential land and along lot edges: the island is never open.
  const bboxA = data.bbox[0];
  const bboxB = data.bbox[1];
  for (let i = 0; i < 2600; i++) {
    const x = bboxA[0] + rnd() * (bboxB[0] - bboxA[0]);
    const z = bboxA[1] + rnd() * (bboxB[1] - bboxA[1]);
    if (ground.heightAt(x, z) < 1.5) continue;
    if (blocked(x, z, 4)) continue;
    let near = false;
    for (const s of spots) {
      if (Math.abs(s.x - x) < 7 && Math.abs(s.z - z) < 7) {
        near = true;
        break;
      }
    }
    if (near) continue;
    const r = rnd();
    spots.push({ x, z, sp: r < 0.5 ? "fir" : r < 0.75 ? "cedar" : "maple", k: 0.6 + rnd() * 0.9 });
  }

  // Geometry: a trunk cylinder, and frond cards arranged in whorls up a cone for conifers.
  const barkS = bark();
  const barkMat = surfaceMaterial(barkS, { roughness: 1 });
  const trunkGeo = new THREE.CylinderGeometry(0.35, 0.6, 1, 8, 1, true);
  trunkGeo.translate(0, 0.5, 0);
  const frondTex = firFrond();
  const frondMat = new THREE.ShaderMaterial({
    vertexShader: FROND_VERT,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D uMap; uniform vec3 uTint;
      varying vec2 vUv; varying float vShade;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        vec4 c = texture2D(uMap, vUv);
        if (c.a < 0.3) discard;
        vec3 col = c.rgb * uTint * (0.35 + 0.65 * vShade);
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }`,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uWind: { value: 0.5 }, uMap: { value: frondTex }, uTint: { value: new THREE.Color(0.95, 1.0, 0.9) } }]),
    side: THREE.DoubleSide,
    fog: true,
  });
  const frondMatCedar = frondMat.clone();
  (frondMatCedar.uniforms.uTint.value as THREE.Color).set(0.85, 0.95, 0.7);
  frondMatCedar.uniforms.uMap.value = frondTex;
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x5d8a3a, roughness: 0.9, side: THREE.DoubleSide });
  const madronaBark = new THREE.MeshStandardMaterial({ color: 0x9a4a2a, roughness: 0.6 });
  const fernTex = fernCard();
  const fernMat = new THREE.MeshStandardMaterial({ map: fernTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.95 });

  const frondGeo = new THREE.PlaneGeometry(1, 1);
  frondGeo.translate(0, 0.5, 0);
  const canopyGeo = new THREE.IcosahedronGeometry(1, 1);

  const trunkM: THREE.Matrix4[] = [];
  const firM: THREE.Matrix4[] = [];
  const cedarM: THREE.Matrix4[] = [];
  const leafM: THREE.Matrix4[] = [];
  const madM: THREE.Matrix4[] = [];
  const fernM: THREE.Matrix4[] = [];
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();

  for (const s of spots) {
    const y = ground.heightAt(s.x, s.z) - 0.2;
    if (s.sp === "fir" || s.sp === "cedar") {
      const h = (s.sp === "fir" ? 26 : 20) * s.k;
      const crownBase = s.sp === "fir" ? h * 0.35 : h * 0.12;
      const tr = (s.sp === "fir" ? 0.55 : 0.7) * s.k;
      m4.compose(v.set(s.x, y, s.z), q.identity(), sc.set(tr * 1.6, h * 0.92, tr * 1.6));
      trunkM.push(m4.clone());
      trunks.push({ x: s.x, z: s.z, r: tr });
      // Whorls of fronds: more and wider near the crown base, narrowing to the tip.
      const whorls = 9 + Math.floor(s.k * 6);
      for (let w = 0; w < whorls; w++) {
        const t = w / (whorls - 1);
        const yy = y + crownBase + (h - crownBase) * t;
        const reach = (s.sp === "fir" ? 4.2 : 3.4) * s.k * (1 - t * 0.85) + 0.6;
        const per = w < 2 ? 5 : 6;
        for (let a = 0; a < per; a++) {
          const ang = (a / per) * Math.PI * 2 + w * 0.7 + rnd() * 0.5;
          const droop = s.sp === "cedar" ? -0.45 : -0.2 + (1 - t) * -0.25;
          e.set(droop, ang, 0, "YXZ");
          q.setFromEuler(e);
          m4.compose(v.set(s.x, yy, s.z), q, sc.set(reach * 0.55, reach, 1));
          (s.sp === "fir" ? firM : cedarM).push(m4.clone());
        }
      }
      // Tip.
      e.set(0.15, rnd() * 6, 0, "YXZ");
      q.setFromEuler(e);
      m4.compose(v.set(s.x, y + h - 0.5, s.z), q, sc.set(0.6, 1.6, 1));
      (s.sp === "fir" ? firM : cedarM).push(m4.clone());
    } else if (s.sp === "maple") {
      const h = 14 * s.k;
      m4.compose(v.set(s.x, y, s.z), q.identity(), sc.set(0.9 * s.k, h * 0.5, 0.9 * s.k));
      trunkM.push(m4.clone());
      trunks.push({ x: s.x, z: s.z, r: 0.4 * s.k });
      for (let i = 0; i < 4; i++) {
        const r = (5 + rnd() * 3) * s.k;
        m4.compose(v.set(s.x + (rnd() - 0.5) * 5 * s.k, y + h * 0.5 + r * 0.6 + rnd() * 3, s.z + (rnd() - 0.5) * 5 * s.k), q.setFromEuler(e.set(rnd(), rnd(), rnd())), sc.set(r, r * 0.8, r));
        leafM.push(m4.clone());
      }
    } else {
      const h = 9 * s.k;
      e.set((rnd() - 0.5) * 0.5, rnd() * 6, (rnd() - 0.5) * 0.5);
      q.setFromEuler(e);
      m4.compose(v.set(s.x, y, s.z), q, sc.set(0.5 * s.k, h * 0.6, 0.5 * s.k));
      madM.push(m4.clone());
      trunks.push({ x: s.x, z: s.z, r: 0.3 });
      for (let i = 0; i < 3; i++) {
        const r = (3 + rnd() * 2) * s.k;
        m4.compose(v.set(s.x + (rnd() - 0.5) * 4, y + h * 0.6 + rnd() * 2, s.z + (rnd() - 0.5) * 4), q.setFromEuler(e.set(rnd(), rnd(), rnd())), sc.set(r, r * 0.7, r));
        leafM.push(m4.clone());
      }
    }
    // Understory around every forest tree.
    if (rnd() < 0.7) {
      for (let i = 0; i < 3; i++) {
        const fx = s.x + (rnd() - 0.5) * 6;
        const fz = s.z + (rnd() - 0.5) * 6;
        if (blocked(fx, fz, 0.5)) continue;
        const fy = ground.heightAt(fx, fz);
        const k = 0.8 + rnd() * 0.8;
        for (let c = 0; c < 2; c++) {
          e.set(0, rnd() * Math.PI, 0);
          q.setFromEuler(e);
          m4.compose(v.set(fx, fy, fz), q, sc.set(1.6 * k, 1.1 * k, 1));
          fernM.push(m4.clone());
        }
      }
    }
  }

  const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[], shadow: boolean) => {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
    list.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.count = list.length;
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };
  mk(trunkGeo, barkMat, trunkM, true);
  mk(frondGeo, frondMat, firM, true);
  mk(frondGeo, frondMatCedar, cedarM, true);
  mk(canopyGeo, leafMat, leafM, true);
  mk(trunkGeo, madronaBark, madM, true);
  mk(frondGeo, fernMat, fernM, false);

  return {
    group,
    trunks,
    update(time, wind) {
      frondMat.uniforms.uTime.value = time;
      frondMat.uniforms.uWind.value = wind;
      frondMatCedar.uniforms.uTime.value = time;
      frondMatCedar.uniforms.uWind.value = wind;
    },
    dispose() {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      barkMat.dispose();
      disposeSurface(barkS);
      frondMat.dispose();
      frondMatCedar.dispose();
      frondTex.dispose();
      leafMat.dispose();
      madronaBark.dispose();
      fernMat.dispose();
      fernTex.dispose();
    },
  };
}
