/**
 * Every road in the data, draped on the ground: chip-seal on the county roads
 * with a fog line and no kerb, gravel on the driveways (most of them), packed
 * dirt on the tracks and trails. Shoulders are a strip of gravel that fades
 * into the grass, which is what the edge of a Bainbridge road is.
 */
import * as THREE from "three";
import { lines, resample, roadWidth, type Neighbourhood } from "./geo";
import type { Ground } from "./terrain";
import { chipSeal, disposeSurface, gravel, surfaceMaterial, type Surface } from "./textures";

export interface Roads {
  group: THREE.Group;
  dispose(): void;
}

function ribbon(line: number[][], width: number, lift: number, ground: Ground, uScale: number, edgeDrop = 0): THREE.BufferGeometry {
  const pts = resample(line, 2);
  const n = pts.length;
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    // Average the tangent with the neighbour for smooth mitres.
    const q = pts[Math.min(n - 1, i + 1)];
    const r = pts[Math.max(0, i - 1)];
    let tx = q.x - r.x;
    let tz = q.z - r.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    const nx = -tz;
    const nz = tx;
    for (let side = 0; side < 2; side++) {
      const s = side === 0 ? -1 : 1;
      const x = p.x + nx * s * (width / 2);
      const z = p.z + nz * s * (width / 2);
      const y = ground.heightAt(x, z) + lift - edgeDrop;
      const k = (i * 2 + side) * 3;
      pos[k] = x;
      pos[k + 1] = y;
      pos[k + 2] = z;
      uv[(i * 2 + side) * 2] = side;
      uv[(i * 2 + side) * 2 + 1] = p.s / uScale;
    }
    if (i < n - 1) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function fogLines(line: number[][], width: number, ground: Ground): THREE.BufferGeometry {
  // Two white edge lines, 10 cm wide, 30 cm in from the edge.
  const pts = resample(line, 2);
  const pos: number[] = [];
  const idx: number[] = [];
  let v = 0;
  for (const side of [-1, 1]) {
    const start = v;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const nx = -p.tz;
      const nz = p.tx;
      const off = side * (width / 2 - 0.3);
      for (const e of [-0.05, 0.05]) {
        const x = p.x + nx * (off + e);
        const z = p.z + nz * (off + e);
        pos.push(x, ground.heightAt(x, z) + 0.035, z);
        v++;
      }
      if (i < pts.length - 1) {
        const a = start + i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export function buildRoads(data: Neighbourhood, ground: Ground): Roads {
  const group = new THREE.Group();
  const seal: Surface = chipSeal();
  const grav: Surface = gravel();
  const sealMat = surfaceMaterial(seal, { color: 0xd9d6d0, roughness: 0.95 });
  const gravMat = surfaceMaterial(grav, { roughness: 1 });
  const dirtMat = surfaceMaterial(grav, { color: 0x8a7a62, roughness: 1 });
  const shoulderMat = surfaceMaterial(grav, { color: 0xb9b2a4, transparent: true, opacity: 0.85, roughness: 1 });
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xe8e6dc, roughness: 0.8 });
  const sealGeos: THREE.BufferGeometry[] = [];
  const gravGeos: THREE.BufferGeometry[] = [];
  const dirtGeos: THREE.BufferGeometry[] = [];
  const shoulderGeos: THREE.BufferGeometry[] = [];
  const lineGeos: THREE.BufferGeometry[] = [];
  for (const r of data.roads) {
    const w = roadWidth(r.cls);
    for (const l of lines(r.g)) {
      if (l.length < 2) continue;
      if (r.cls === "secondary" || r.cls === "tertiary" || r.cls === "residential") {
        sealGeos.push(ribbon(l, w, 0.06, ground, 6));
        shoulderGeos.push(ribbon(l, w + 2.2, 0.03, ground, 6, 0.02));
        if (r.cls !== "residential") lineGeos.push(fogLines(l, w, ground));
      } else if (r.cls === "service") {
        gravGeos.push(ribbon(l, w, 0.05, ground, 3));
      } else {
        dirtGeos.push(ribbon(l, w, 0.04, ground, 3));
      }
    }
  }
  const add = (geos: THREE.BufferGeometry[], mat: THREE.Material, order: number) => {
    for (const g of geos) {
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      m.renderOrder = order;
      group.add(m);
    }
  };
  add(shoulderGeos, shoulderMat, 1);
  add(dirtGeos, dirtMat, 2);
  add(gravGeos, gravMat, 2);
  add(sealGeos, sealMat, 3);
  add(lineGeos, lineMat, 4);
  return {
    group,
    dispose() {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      sealMat.dispose();
      gravMat.dispose();
      dirtMat.dispose();
      shoulderMat.dispose();
      lineMat.dispose();
      disposeSurface(seal);
      disposeSurface(grav);
    },
  };
}
