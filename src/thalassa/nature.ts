/**
 * Cypresses, olives and oaks, flowering shrubs, limestone boulders and
 * wildflowers. All instanced: a handful of draw calls for a thousand trees.
 *
 * The cypress is the painting's signature: tall dark flames standing in rows
 * along the paths and in twos and threes on the hills. Trees lean a little
 * in the wind, more at the top; that happens in the vertex shader.
 *
 * No backticks inside the GLSL: it is a template literal.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { makeRng, fbm2 } from "@/shared/proc/rng";
import { Ground, PATHS, groundType, heightAt, inTown, pathDist, sIsle, sMainland, slopeAt, ISLE_TOP, ISLE_STAIR, ACROPOLIS } from "./map";
import type { BuildCtx, FrameCtx, Part } from "./types";

const flat = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);

function paint(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number) => THREE.Color): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  const c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const col = fn(p.getX(i), p.getY(i), p.getZ(i));
    c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  return g;
}

function lumpy(g: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = fbm2(x * 2.1 + seed, z * 2.1 + y * 1.3, 2, 2, 0.5, seed) * amount;
    const l = Math.hypot(x, z) || 1;
    p.setXYZ(i, x + (x / l) * n, y + n * 0.3, z + (z / l) * n);
  }
  g.computeVertexNormals();
  return g;
}

/** A cypress one metre tall: a lumpy spindle on a sliver of trunk. */
function cypressGeometry(): THREE.BufferGeometry {
  const prof: THREE.Vector2[] = [];
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = 0.095 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.95 + 0.05)), 0.8) * (1 - t * 0.35);
    prof.push(new THREE.Vector2(Math.max(0.002, r), 0.04 + t * 0.96));
  }
  const crown = lumpy(new THREE.LatheGeometry(prof, 9), 0.018, 3);
  const dark = new THREE.Color("#244a22"), light = new THREE.Color("#4e7f33");
  paint(crown, (_x, y) => dark.clone().lerp(light, Math.min(1, y * 1.1)));
  const trunk = new THREE.CylinderGeometry(0.012, 0.016, 0.08, 5).translate(0, 0.04, 0);
  paint(trunk, () => new THREE.Color("#5a4330"));
  const g = mergeGeometries([flat(crown), flat(trunk)]);
  return g!;
}

/** A round tree about one metre tall: a few blobs of canopy on a crooked trunk. */
function roundTreeGeometry(seed: number, canopy: string, canopyLight: string, wide: number): THREE.BufferGeometry {
  const rng = makeRng(`tree-${seed}`);
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.035, 0.06, 0.5, 6).translate(0, 0.25, 0);
  trunk.rotateZ((rng.next() - 0.5) * 0.25);
  parts.push(flat(paint(trunk, () => new THREE.Color("#6a5038"))));
  const dark = new THREE.Color(canopy), light = new THREE.Color(canopyLight);
  const blobs = 4 + Math.floor(rng.next() * 3);
  for (let i = 0; i < blobs; i++) {
    const r = (0.2 + rng.next() * 0.12) * wide;
    const b = lumpy(new THREE.IcosahedronGeometry(r, 1), 0.05, seed + i);
    const a = (i / blobs) * Math.PI * 2;
    const d = i === 0 ? 0 : 0.18 * wide;
    b.translate(Math.cos(a) * d, 0.58 + rng.next() * 0.22 + (i === 0 ? 0.12 : 0), Math.sin(a) * d);
    b.scale(1, 0.82, 1);
    parts.push(flat(paint(b, (_x, y) => dark.clone().lerp(light, Math.min(1, Math.max(0, (y - 0.45) * 1.8))))));
  }
  return mergeGeometries(parts)!;
}

function bushGeometry(seed: number, a: string, b: string): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  for (let i = 0; i < 3; i++) {
    const g = lumpy(new THREE.IcosahedronGeometry(0.35 + i * 0.05, 1), 0.06, seed + i);
    g.translate((i - 1) * 0.3, 0.28, (i % 2) * 0.2 - 0.1);
    parts.push(flat(paint(g, (_x, y) => ca.clone().lerp(cb, Math.min(1, y * 1.3)))));
  }
  return mergeGeometries(parts)!;
}

function rockGeometry(seed: number): THREE.BufferGeometry {
  const g = lumpy(new THREE.IcosahedronGeometry(0.5, 1), 0.16, seed);
  g.scale(1.2, 0.7, 1);
  const a = new THREE.Color("#c9c0ae"), b = new THREE.Color("#ece5d6");
  return paint(flat(g), (_x, y) => a.clone().lerp(b, Math.min(1, Math.max(0, y + 0.4))));
}

const SWAY_HEAD = /* glsl */ `
uniform float uTime;
`;
const SWAY = /* glsl */ `
#include <begin_vertex>
{
  vec4 root = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float k = max(0.0, position.y);
  float sway = sin(uTime * 1.3 + root.x * 0.13 + root.z * 0.07) * 0.5 + sin(uTime * 2.7 + root.x * 0.4) * 0.18;
  transformed.x += sway * k * k * 0.035;
  transformed.z += sway * k * k * 0.02;
}
`;

export function createNature(ctx: BuildCtx): Part {
  const rng = makeRng("thalassa-nature");
  const r = () => rng.next();
  const group = new THREE.Group();
  group.name = "nature";
  const lite = ctx.quality.tier !== "desktop";
  const uniforms = { uTime: { value: 0 } };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\n" + SWAY_HEAD).replace("#include <begin_vertex>", SWAY);
  };
  mat.customProgramCacheKey = () => "thalassa-sway";
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const flowerMat = new THREE.MeshStandardMaterial({ roughness: 0.8 });

  interface Kind { geo: THREE.BufferGeometry; mats: THREE.Matrix4[]; tints: THREE.Color[]; material: THREE.Material; shadow: boolean }
  const kinds: Record<string, Kind> = {
    cypress: { geo: cypressGeometry(), mats: [], tints: [], material: mat, shadow: true },
    olive: { geo: roundTreeGeometry(1, "#5f7f3c", "#a3b56a", 1.25), mats: [], tints: [], material: mat, shadow: true },
    oak: { geo: roundTreeGeometry(2, "#3f7a2c", "#78ad44", 1.0), mats: [], tints: [], material: mat, shadow: true },
    pine: { geo: roundTreeGeometry(3, "#2f6a34", "#5f9a46", 1.5), mats: [], tints: [], material: mat, shadow: true },
    bush: { geo: bushGeometry(4, "#3d7a2e", "#7fb34a"), mats: [], tints: [], material: mat, shadow: true },
    oleander: { geo: bushGeometry(5, "#3d7a2e", "#e46aa8"), mats: [], tints: [], material: mat, shadow: true },
    broom: { geo: bushGeometry(6, "#4a7a2e", "#f2cf3a"), mats: [], tints: [], material: mat, shadow: true },
    rock: { geo: rockGeometry(7), mats: [], tints: [], material: rockMat, shadow: true },
    rock2: { geo: rockGeometry(8), mats: [], tints: [], material: rockMat, shadow: true },
  };
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const place = (kind: string, x: number, z: number, scale: number, opts: { sx?: number; y?: number; tilt?: number; tint?: number; hue?: [number, number, number] } = {}) => {
    const y = opts.y ?? heightAt(x, z);
    q.setFromAxisAngle(up, r() * Math.PI * 2);
    if (opts.tilt) q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler((r() - 0.5) * opts.tilt, 0, (r() - 0.5) * opts.tilt)));
    const sx = opts.sx ?? 1;
    kinds[kind].mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y - 0.05, z), q.clone(), new THREE.Vector3(scale * sx, scale, scale * sx)));
    const t = opts.tint ?? 0.12;
    kinds[kind].tints.push(new THREE.Color(...(opts.hue ?? [1, 1, 1])).multiplyScalar(1 - t / 2 + r() * t));
  };
  const ok = (x: number, z: number, rad: number, slopeMax = 0.5) => {
    const h = heightAt(x, z);
    if (h < 1.4) return false;
    if (groundType(x, z, h) !== Ground.Grass) return false;
    if (slopeAt(x, z) > slopeMax) return false;
    if (pathDist(x, z) < 2.4) return false;
    return !ctx.colliders.blocked(x, z, rad, h + 0.5);
  };
  const tree = (kind: string, x: number, z: number, height: number) => {
    place(kind, x, z, height);
    const h = heightAt(x, z);
    ctx.colliders.circle(x, z, kind === "cypress" ? 0.45 : 0.35, h - 0.5, h + 4);
  };

  // Cypress avenues along the paths.
  for (const path of PATHS) {
    for (let i = 0; i < path.length - 1; i++) {
      const [ax, az] = path[i], [bx, bz] = path[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const nx = -(bz - az) / len, nz = (bx - ax) / len;
      for (let t = 4; t < len; t += 7 + r() * 4) {
        for (const side of [-1, 1]) {
          if (r() < 0.25) continue;
          const x = ax + (bx - ax) * (t / len) + nx * side * 3.4, z = az + (bz - az) * (t / len) + nz * side * 3.4;
          if (ok(x, z, 0.8, 0.6) || (groundType(x, z) === Ground.Grass && !ctx.colliders.blocked(x, z, 0.8, heightAt(x, z) + 0.5))) tree("cypress", x, z, 8 + r() * 5);
        }
      }
    }
  }
  // In the town's gaps and gardens.
  for (let i = 0; i < 4000; i++) {
    const x = -165 + r() * 215, z = -135 + r() * 205;
    if (!inTown(x, z)) continue;
    const h = heightAt(x, z);
    if (ctx.colliders.blocked(x, z, 1.6, h + 0.5)) continue;
    if (groundType(x, z, h) === Ground.Sea) continue;
    if (r() < 0.45) tree("cypress", x, z, 7 + r() * 5);
    else if (r() < 0.6) tree(r() < 0.5 ? "olive" : "oak", x, z, 4 + r() * 2);
    else place(r() < 0.4 ? "oleander" : "bush", x, z, 1 + r() * 0.8);
  }
  // Hills, meadows and the peninsula: groves and singles.
  const groves = lite ? 60 : 110;
  for (let gI = 0; gI < groves; gI++) {
    const gx = -225 + r() * 330, gz = -210 + r() * 320;
    const kind = r() < 0.35 ? "cypress" : r() < 0.6 ? "olive" : r() < 0.85 ? "oak" : "pine";
    const n = 2 + Math.floor(r() * 7);
    for (let i = 0; i < n; i++) {
      const x = gx + (r() - 0.5) * 22, z = gz + (r() - 0.5) * 22;
      if (inTown(x, z) || !ok(x, z, 1.4)) continue;
      const height = kind === "cypress" ? 8 + r() * 6 : kind === "pine" ? 6 + r() * 3 : 4.5 + r() * 2.5;
      tree(kind, x, z, height);
    }
  }
  // Across the inlet and on the far hills, sparser and bigger.
  for (let i = 0; i < (lite ? 120 : 260); i++) {
    const x = -400 + r() * 750, z = -380 + r() * 300;
    if (Math.abs(x) < 230 && z > -230) continue;
    const h = heightAt(x, z);
    if (h < 2 || h > 90 || slopeAt(x, z) > 0.7) continue;
    place(r() < 0.5 ? "cypress" : "oak", x, z, r() < 0.5 ? 10 + r() * 5 : 6 + r() * 3);
  }
  // The island: cypresses on the top, round the temple.
  for (let i = 0; i < 40; i++) {
    const a = r() * Math.PI * 2;
    const rr = 13 + r() * 8;
    // Keep the view from the stair head to the temple's face open.
    if (Math.abs(Math.atan2(Math.sin(a - ISLE_STAIR.a1), Math.cos(a - ISLE_STAIR.a1))) < 0.6) continue;
    const x = 152 + Math.cos(a) * rr, z = 22 + Math.sin(a) * rr;
    if (sIsle(x, z) < 11 || ctx.colliders.blocked(x, z, 1.8, ISLE_TOP + 0.5)) continue;
    tree("cypress", x, z, 6 + r() * 4);
  }
  // The upper town's square: a pair of olives.
  for (const [dx, dz] of [[10, 8], [-8, 14], [14, -6]]) {
    const x = ACROPOLIS.x + dx, z = ACROPOLIS.z + dz;
    if (!ctx.colliders.blocked(x, z, 1.5, heightAt(x, z) + 0.5)) tree("olive", x, z, 5);
  }
  // Shrubs everywhere green.
  for (let i = 0; i < (lite ? 500 : 1100); i++) {
    const x = -225 + r() * 340, z = -215 + r() * 330;
    if (!ok(x, z, 0.8, 0.65)) continue;
    const pick = r();
    place(pick < 0.15 ? "oleander" : pick < 0.3 ? "broom" : "bush", x, z, 0.9 + r() * 1.1);
  }
  // Boulders: along the cliffs, round the peninsula, scattered on the hills.
  for (let i = 0; i < (lite ? 350 : 700); i++) {
    const x = -230 + r() * 460, z = -230 + r() * 460;
    const h = heightAt(x, z);
    const sm = sMainland(x, z);
    const coast = h > -1.5 && h < 6 && (Math.abs(sm) < 6 || (sIsle(x, z) > -3 && sIsle(x, z) < 3));
    const hill = h > 8 && slopeAt(x, z) < 0.9 && !inTown(x, z) && r() < 0.35;
    if (!coast && !hill) continue;
    if (ctx.colliders.blocked(x, z, 1.5, h + 0.5)) continue;
    if (pathDist(x, z) < 2) continue;
    const s = coast ? 1.2 + r() * 2.8 : 0.6 + r() * 1.6;
    place(r() < 0.5 ? "rock" : "rock2", x, z, s, { tilt: 0.6, y: h - s * 0.15, tint: 0.2 });
    if (s > 1.4 && h > -0.5) ctx.colliders.circle(x, z, s * 0.5, h - 1, h + s * 0.5);
  }

  // The island's cliffs and the sea stacks: crags set into the face, and
  // scrub clinging to whatever ledge will hold it.
  for (let i = 0; i < (lite ? 160 : 300); i++) {
    const a = r() * Math.PI * 2;
    const rr = 10 + r() * 34;
    const x = 152 + Math.cos(a) * rr, z = 22 + Math.sin(a) * rr;
    const si = sIsle(x, z);
    const h = heightAt(x, z);
    if (si < -4 || h < -1 || h > ISLE_TOP - 1.5) continue;
    if (ctx.colliders.blocked(x, z, 1.2, h + 0.5)) continue;
    const steep = slopeAt(x, z);
    if (steep < 0.7 && h > 3 && r() < 0.6) {
      place(r() < 0.5 ? "bush" : "broom", x, z, 1 + r() * 1.2);
      continue;
    }
    if (r() < 0.4) continue;
    const s = 2.6 + r() * 3.6;
    place(r() < 0.5 ? "rock" : "rock2", x, z, s, { tilt: 0.9, y: h - s * 0.5, tint: 0.2, hue: [0.74, 0.68, 0.58] });
  }

  const meshes: THREE.InstancedMesh[] = [];
  for (const [name, k] of Object.entries(kinds)) {
    if (!k.mats.length) continue;
    const mesh = new THREE.InstancedMesh(k.geo, k.material, k.mats.length);
    k.mats.forEach((m, i) => { mesh.setMatrixAt(i, m); mesh.setColorAt(i, k.tints[i]); });
    mesh.castShadow = k.shadow;
    mesh.receiveShadow = true;
    mesh.name = `nature-${name}`;
    mesh.computeBoundingSphere();
    group.add(mesh);
    meshes.push(mesh);
  }

  // Wildflowers: drifts of poppies, daisies, chamomile and thyme.
  const flowerGeo = new THREE.IcosahedronGeometry(0.07, 0);
  const COLS = ["#e0332b", "#f7f2e6", "#f2c933", "#9a6bd0", "#f08ab8"];
  const fm: THREE.Matrix4[] = [];
  const fc: THREE.Color[] = [];
  const drifts = lite ? 90 : 220;
  for (let d = 0; d < drifts; d++) {
    const cx = -200 + r() * 300, cz = -160 + r() * 270;
    if (!ok(cx, cz, 0.3, 0.6)) continue;
    const col = new THREE.Color(COLS[Math.floor(r() * COLS.length)]);
    const n = 20 + Math.floor(r() * 40);
    for (let i = 0; i < n; i++) {
      const x = cx + (r() - 0.5) * 9, z = cz + (r() - 0.5) * 9;
      const h = heightAt(x, z);
      if (h < 1.4 || groundType(x, z, h) !== Ground.Grass) continue;
      fm.push(new THREE.Matrix4().makeTranslation(x, h + 0.25 + r() * 0.15, z));
      fc.push(col.clone().offsetHSL(0, 0, (r() - 0.5) * 0.1));
    }
  }
  const flowers = new THREE.InstancedMesh(flowerGeo, flowerMat, Math.max(1, fm.length));
  fm.forEach((m, i) => { flowers.setMatrixAt(i, m); flowers.setColorAt(i, fc[i]); });
  flowers.count = fm.length;
  flowers.name = "flowers";
  group.add(flowers);

  return {
    group,
    update(_dt: number, time: number, _ctx: FrameCtx) { uniforms.uTime.value = time; },
    dispose() {
      for (const k of Object.values(kinds)) k.geo.dispose();
      flowerGeo.dispose();
      mat.dispose();
      rockMat.dispose();
      flowerMat.dispose();
    },
  };
}
