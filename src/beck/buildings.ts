/**
 * Five hundred and seven buildings, each on its real footprint. Height comes
 * from the data where it was measured (348 of them), floors otherwise, and
 * the footprint's size decides the rest: a small rectangle is a shed, a long
 * one is a house with a gable along its long axis, a squarer one gets a hip,
 * and the school is the one with the flat roof and the long walls. Materials
 * are the island's: painted lap siding in the greys and sages, cedar shingle
 * gone silver, board-and-batten on the outbuildings, asphalt shingle or
 * standing-seam metal on top, and every house gets windows, a door, a
 * chimney where the roof is old enough and a deck where the lot slopes.
 */
import * as THREE from "three";
import { centroid, mulberry32, orientedBox, ringArea, rings, type Building, type Neighbourhood } from "./geo";
import type { Ground } from "./terrain";
import { asphaltShingle, cedarShingle, disposeSurface, lapSiding, metalRoof, surfaceMaterial, type Surface } from "./textures";

export interface Buildings {
  group: THREE.Group;
  /** Footprint rings with their floor height, for keeping trees and the player out. */
  footprints: { ring: number[][]; y: number; h: number; cx: number; cz: number; r: number }[];
  dispose(): void;
}

const SIDING_COLOURS = ["#c9c3b4", "#9aa39a", "#b7b0a2", "#8d8f86", "#e6e2d8", "#6f7a70", "#a5977d", "#7b6a5a", "#d9d3c4", "#5f6a66", "#b8c0b0", "#8a5f4a"];

interface Kit {
  siding: { s: Surface; m: THREE.MeshStandardMaterial }[];
  shingle: { s: Surface; m: THREE.MeshStandardMaterial };
  shingleDark: { s: Surface; m: THREE.MeshStandardMaterial };
  metal: { s: Surface; m: THREE.MeshStandardMaterial };
  metalRed: { s: Surface; m: THREE.MeshStandardMaterial };
  cedar: { s: Surface; m: THREE.MeshStandardMaterial };
  cedarNew: { s: Surface; m: THREE.MeshStandardMaterial };
  trim: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  door: THREE.MeshStandardMaterial;
  brick: THREE.MeshStandardMaterial;
  deck: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  school: THREE.MeshStandardMaterial;
}

function kit(): Kit {
  const mk = (s: Surface, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) => ({ s, m: surfaceMaterial(s, { roughness: 0.85, ...opts }) });
  return {
    siding: SIDING_COLOURS.map((c) => mk(lapSiding(c))),
    shingle: mk(asphaltShingle("#4a4744")),
    shingleDark: mk(asphaltShingle("#33312f")),
    metal: mk(metalRoof("#4f5a52"), { roughness: 0.5, metalness: 0.3 }),
    metalRed: mk(metalRoof("#6e3a30"), { roughness: 0.5, metalness: 0.3 }),
    cedar: mk(cedarShingle(true)),
    cedarNew: mk(cedarShingle(false)),
    trim: new THREE.MeshStandardMaterial({ color: 0xf1efe8, roughness: 0.7 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x1c2630, roughness: 0.08, metalness: 0.0, envMapIntensity: 1.2, clearcoat: 1, clearcoatRoughness: 0.05 }),
    door: new THREE.MeshStandardMaterial({ color: 0x3d2c22, roughness: 0.7 }),
    brick: new THREE.MeshStandardMaterial({ color: 0x7a4a3c, roughness: 0.95 }),
    deck: new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.9 }),
    concrete: new THREE.MeshStandardMaterial({ color: 0xa8a49c, roughness: 0.95 }),
    school: new THREE.MeshStandardMaterial({ color: 0xb9ad9a, roughness: 0.9 }),
  };
}

type RoofKind = "gable" | "hip" | "flat" | "shed";

function buildingHeight(b: Building, area: number, rnd: () => number): { eave: number; floors: number } {
  if (b.h && b.h > 2.2) {
    // Measured height is to the ridge; the eave is lower on a pitched roof.
    const floors = Math.max(1, Math.min(3, Math.round((b.h - 1.5) / 3.1)));
    return { eave: Math.max(2.5, Math.min(b.h - 1.2, floors * 3.0 + 0.4)), floors };
  }
  if (b.fl && b.fl > 0) return { eave: b.fl * 3.0 + 0.4, floors: b.fl };
  if (area < 40) return { eave: 2.5, floors: 1 };
  if (area < 110) return { eave: 3.1, floors: 1 };
  const two = rnd() < 0.55;
  return { eave: two ? 6.2 : 3.4, floors: two ? 2 : 1 };
}

function roofKind(b: Building, box: { w: number; d: number }, area: number, rnd: () => number): RoofKind {
  const r = (b.roof || "").toLowerCase();
  if (r.includes("flat")) return "flat";
  if (r.includes("hip")) return "hip";
  if (r.includes("gable")) return "gable";
  if (r.includes("skillion") || r.includes("shed")) return "shed";
  if (area > 900) return "flat";
  const ratio = Math.max(box.w, box.d) / Math.max(0.1, Math.min(box.w, box.d));
  if (area < 30) return rnd() < 0.5 ? "shed" : "gable";
  if (ratio < 1.25) return rnd() < 0.6 ? "hip" : "gable";
  return rnd() < 0.8 ? "gable" : "hip";
}

/** Extrude a ring straight up between y0 and y1 with per-wall uv in metres. */
function walls(ring: number[][], y0: number, y1: number, metresPerTile = 2.4): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const norm: number[] = [];
  const idx: number[] = [];
  let v = 0;
  const ccw = ringArea(ring) > 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    // Outward normal: for a ring wound clockwise in x/z (which is counter-clockwise seen from above in three's -z-forward frame), swap.
    let nx = dz / len;
    let nz = -dx / len;
    if (ccw) {
      nx = -nx;
      nz = -nz;
    }
    const u1 = len / metresPerTile;
    const vv = (y1 - y0) / metresPerTile;
    pos.push(a[0], y0, a[1], b[0], y0, b[1], b[0], y1, b[1], a[0], y1, a[1]);
    uv.push(0, 0, u1, 0, u1, vv, 0, vv);
    for (let k = 0; k < 4; k++) norm.push(nx, 0, nz);
    if (ccw) idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
    else idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(norm, 3));
  g.setIndex(idx);
  return g;
}

function flatCap(ring: number[][], y: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(ring.map((p) => new THREE.Vector2(p[0], -p[1])));
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(Math.PI / 2);
  g.translate(0, y, 0);
  const n = g.getAttribute("normal");
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return g;
}

/**
 * A pitched roof over the oriented box of the footprint, with overhangs. For
 * non-rectangular footprints this is an honest approximation: the box covers
 * the whole footprint, and the wall extrusion fills the gaps below.
 */
function pitchedRoof(box: { cx: number; cz: number; angle: number; w: number; d: number }, eave: number, kind: RoofKind, pitch: number, overhang: number): { roof: THREE.BufferGeometry; gables: THREE.BufferGeometry; ridge: number } {
  // Local frame: u along the long axis, v across.
  const long = Math.max(box.w, box.d) + overhang * 2;
  const short = Math.min(box.w, box.d) + overhang * 2;
  const angle = box.w >= box.d ? box.angle : box.angle + Math.PI / 2;
  const rise = (short / 2) * pitch;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const gpos: number[] = [];
  const gidx: number[] = [];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const P = (u: number, v: number, y: number) => [box.cx + u * c - v * s, y, box.cz + u * s + v * c];
  const push = (arr: number[], p: number[]) => arr.push(p[0], p[1], p[2]);
  const y0 = eave - overhang * pitch;
  const hl = long / 2;
  const hs = short / 2;
  if (kind === "hip") {
    const inset = Math.min(hl * 0.6, hs);
    const ridgeA = P(-(hl - inset), 0, y0 + rise);
    const ridgeB = P(hl - inset, 0, y0 + rise);
    const e = [P(-hl, -hs, y0), P(hl, -hs, y0), P(hl, hs, y0), P(-hl, hs, y0)];
    // Two long slopes and two hip ends.
    const quad = (a: number[], b: number[], cc: number[], d: number[], uvs: number[]) => {
      const base = pos.length / 3;
      [a, b, cc, d].forEach((p) => push(pos, p));
      uv.push(...uvs);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const tri = (a: number[], b: number[], cc: number[]) => {
      const base = pos.length / 3;
      [a, b, cc].forEach((p) => push(pos, p));
      uv.push(0, 0, long / 3, 0, long / 6, short / 3);
      idx.push(base, base + 1, base + 2);
    };
    quad(e[0], e[1], ridgeB, ridgeA, [0, 0, long / 3, 0, long / 3, hs / 3, 0, hs / 3]);
    quad(e[2], e[3], ridgeA, ridgeB, [0, 0, long / 3, 0, long / 3, hs / 3, 0, hs / 3]);
    tri(e[1], e[2], ridgeB);
    tri(e[3], e[0], ridgeA);
  } else if (kind === "shed") {
    const base = pos.length / 3;
    push(pos, P(-hl, -hs, y0));
    push(pos, P(hl, -hs, y0));
    push(pos, P(hl, hs, y0 + rise * 1.2));
    push(pos, P(-hl, hs, y0 + rise * 1.2));
    uv.push(0, 0, long / 3, 0, long / 3, short / 3, 0, short / 3);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    // Back wall up to the high edge.
    const gb = gpos.length / 3;
    [P(-hl + overhang, hs - overhang, eave), P(hl - overhang, hs - overhang, eave), P(hl - overhang, hs - overhang, y0 + rise * 1.2), P(-hl + overhang, hs - overhang, y0 + rise * 1.2)].forEach((p) => push(gpos, p));
    gidx.push(gb, gb + 2, gb + 1, gb, gb + 3, gb + 2);
  } else {
    const ridgeA = P(-hl, 0, y0 + rise);
    const ridgeB = P(hl, 0, y0 + rise);
    const quad = (a: number[], b: number[], cc: number[], d: number[]) => {
      const base = pos.length / 3;
      [a, b, cc, d].forEach((p) => push(pos, p));
      uv.push(0, 0, long / 3, 0, long / 3, hs / 3, 0, hs / 3);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    quad(P(-hl, -hs, y0), P(hl, -hs, y0), ridgeB, ridgeA);
    quad(P(hl, hs, y0), P(-hl, hs, y0), ridgeA, ridgeB);
    // Gable end walls (siding), inset to the wall line.
    for (const end of [-1, 1]) {
      const u = end * (hl - overhang);
      const gb = gpos.length / 3;
      push(gpos, P(u, -hs + overhang, eave));
      push(gpos, P(u, hs - overhang, eave));
      push(gpos, P(u, 0, eave + (hs - overhang) * pitch));
      if (end > 0) gidx.push(gb, gb + 1, gb + 2);
      else gidx.push(gb, gb + 2, gb + 1);
    }
  }
  const roof = new THREE.BufferGeometry();
  roof.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  roof.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  roof.setIndex(idx);
  roof.computeVertexNormals();
  // Make the roof double sided by normals pointing up: flip faces that point down.
  const n = roof.getAttribute("normal");
  const ix = roof.getIndex()!;
  for (let t = 0; t < ix.count; t += 3) {
    if (n.getY(ix.getX(t)) < 0) {
      const a = ix.getX(t + 1);
      ix.setX(t + 1, ix.getX(t + 2));
      ix.setX(t + 2, a);
    }
  }
  roof.computeVertexNormals();
  const gables = new THREE.BufferGeometry();
  gables.setAttribute("position", new THREE.Float32BufferAttribute(gpos, 3));
  gables.setIndex(gidx);
  gables.computeVertexNormals();
  const guv: number[] = [];
  for (let i = 0; i < gpos.length / 3; i++) guv.push(gpos[i * 3] / 2.4, gpos[i * 3 + 1] / 2.4);
  gables.setAttribute("uv", new THREE.Float32BufferAttribute(guv, 2));
  return { roof, gables, ridge: y0 + rise };
}

export function buildBuildings(data: Neighbourhood, ground: Ground): Buildings {
  const group = new THREE.Group();
  const K = kit();
  const rnd = mulberry32(2026);
  const footprints: Buildings["footprints"] = [];
  const winGeo = new THREE.BoxGeometry(1.1, 1.3, 0.08);
  const frameGeo = new THREE.BoxGeometry(1.26, 1.46, 0.06);
  const doorGeo = new THREE.BoxGeometry(0.95, 2.05, 0.08);
  const chimneyGeo = new THREE.BoxGeometry(0.7, 1, 0.7);
  const windows: THREE.Matrix4[] = [];
  const frames: THREE.Matrix4[] = [];
  const doors: THREE.Matrix4[] = [];
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);

  for (const b of data.buildings) {
    for (const ring of rings(b.g)) {
      if (ring.length < 4) continue;
      const area = Math.abs(ringArea(ring));
      if (area < 6) continue;
      const box = orientedBox(ring);
      const c = centroid(ring);
      // Floor: the highest ground under the footprint, so it never sinks; a plinth below.
      let top = -Infinity;
      let low = Infinity;
      for (const p of ring) {
        const h = ground.heightAt(p[0], p[1]);
        top = Math.max(top, h);
        low = Math.min(low, h);
      }
      const y = top + 0.15;
      const { eave, floors } = buildingHeight(b, area, rnd);
      const kind = roofKind(b, box, area, rnd);
      const isSchool = area > 900 || (b.name || "").toLowerCase().includes("school");
      const isShed = area < 40;
      const pitch = isShed ? 0.35 : kind === "hip" ? 0.5 : 0.55 + rnd() * 0.3;
      const overhang = isShed ? 0.3 : 0.55;

      // Walls, from below the low ground to the eave (the plinth hides the slope).
      const sidingPick = isSchool ? K.school : b.src === "osm" && rnd() < 0.3 ? K.cedar.m : K.siding[Math.floor(rnd() * K.siding.length)].m;
      const wallGeo = walls(ring, low - 0.6, kind === "flat" ? y + eave : y + eave);
      const wall = new THREE.Mesh(wallGeo, sidingPick);
      wall.castShadow = true;
      wall.receiveShadow = true;
      group.add(wall);
      // Foundation band.
      const plinth = new THREE.Mesh(walls(ring, low - 0.7, y + 0.35, 1), K.concrete);
      plinth.receiveShadow = true;
      group.add(plinth);

      let ridge = y + eave;
      if (kind === "flat") {
        const cap = new THREE.Mesh(flatCap(ring, y + eave + 0.05), K.shingleDark.m);
        cap.receiveShadow = true;
        group.add(cap);
        // Parapet.
        group.add(new THREE.Mesh(walls(ring, y + eave, y + eave + 0.5, 2.4), sidingPick));
      } else {
        const { roof, gables, ridge: r } = pitchedRoof(box, y + eave, kind, pitch, overhang);
        ridge = r;
        const roofMat = isShed ? (rnd() < 0.5 ? K.metal.m : K.shingleDark.m) : rnd() < 0.72 ? (rnd() < 0.5 ? K.shingle.m : K.shingleDark.m) : rnd() < 0.8 ? K.metal.m : K.metalRed.m;
        const roofMesh = new THREE.Mesh(roof, roofMat);
        roofMesh.castShadow = true;
        roofMesh.receiveShadow = true;
        group.add(roofMesh);
        if (gables.getAttribute("position").count > 0) {
          const gm = new THREE.Mesh(gables, sidingPick);
          gm.castShadow = true;
          group.add(gm);
        }
        // Fascia along the eaves (a thin box under the roof edge): keep it simple with a trim ring.
        const fascia = new THREE.Mesh(walls(ring, y + eave - 0.22, y + eave, 2.4), K.trim);
        group.add(fascia);
      }

      // Openings on each wall of a house: windows per floor spaced along the wall, one door on the longest wall.
      if (!isShed) {
        let longest = 0;
        let longestLen = 0;
        for (let i = 0; i < ring.length - 1; i++) {
          const l = Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]);
          if (l > longestLen) {
            longestLen = l;
            longest = i;
          }
        }
        const ccw = ringArea(ring) > 0;
        for (let i = 0; i < ring.length - 1; i++) {
          const a = ring[i];
          const bb = ring[i + 1];
          const dx = bb[0] - a[0];
          const dz = bb[1] - a[1];
          const len = Math.hypot(dx, dz);
          if (len < 2.4) continue;
          let nx = dz / len;
          let nz = -dx / len;
          if (ccw) {
            nx = -nx;
            nz = -nz;
          }
          const yaw = Math.atan2(nx, nz);
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
          const count = Math.max(1, Math.floor((len - 1.2) / (isSchool ? 2.2 : 3.1)));
          for (let f = 0; f < floors; f++) {
            const wy = y + 1.55 + f * 3.0;
            if (wy + 0.7 > y + eave) continue;
            for (let k = 0; k < count; k++) {
              const t = (k + 0.5) / count;
              if (i === longest && f === 0 && k === Math.floor(count / 2)) {
                const px = a[0] + dx * t + nx * 0.03;
                const pz = a[1] + dz * t + nz * 0.03;
                m4.compose(new THREE.Vector3(px, y + 1.03, pz), q, one);
                doors.push(m4.clone());
                continue;
              }
              if (rnd() < 0.18) continue;
              const px = a[0] + dx * t + nx * 0.03;
              const pz = a[1] + dz * t + nz * 0.03;
              m4.compose(new THREE.Vector3(px, wy, pz), q, one);
              windows.push(m4.clone());
              m4.compose(new THREE.Vector3(px - nx * 0.01, wy, pz - nz * 0.01), q, one);
              frames.push(m4.clone());
            }
          }
        }
        // Chimney on older, larger houses.
        if (area > 90 && rnd() < 0.45 && kind !== "flat") {
          const cx = box.cx + (rnd() - 0.5) * box.w * 0.4;
          const cz = box.cz + (rnd() - 0.5) * box.d * 0.4;
          const ch = new THREE.Mesh(chimneyGeo, K.brick);
          ch.scale.y = ridge - y + 1.2;
          ch.position.set(cx, y + ch.scale.y / 2, cz);
          ch.castShadow = true;
          group.add(ch);
        }
        // A deck on the downhill side where the lot drops away.
        if (top - low > 1.2 && area > 80 && rnd() < 0.7) {
          const dw = Math.min(6, box.w * 0.6);
          const dd = 3;
          const angle = box.w >= box.d ? box.angle : box.angle + Math.PI / 2;
          // Downhill direction: sample four sides.
          const dirs = [
            [Math.cos(angle), Math.sin(angle)],
            [-Math.cos(angle), -Math.sin(angle)],
            [-Math.sin(angle), Math.cos(angle)],
            [Math.sin(angle), -Math.cos(angle)],
          ];
          let best = dirs[0];
          let bestH = Infinity;
          const half = [Math.max(box.w, box.d) / 2, Math.max(box.w, box.d) / 2, Math.min(box.w, box.d) / 2, Math.min(box.w, box.d) / 2];
          dirs.forEach((d, i) => {
            const h = ground.heightAt(box.cx + d[0] * (half[i] + 3), box.cz + d[1] * (half[i] + 3));
            if (h < bestH) {
              bestH = h;
              best = d;
            }
          });
          const i = dirs.indexOf(best);
          const deck = new THREE.Mesh(new THREE.BoxGeometry(i < 2 ? dd : dw, 0.12, i < 2 ? dw : dd), K.deck);
          deck.position.set(box.cx + best[0] * (half[i] + dd / 2), y + 0.12, box.cz + best[1] * (half[i] + dd / 2));
          deck.rotation.y = -angle;
          deck.castShadow = true;
          group.add(deck);
          // Railing posts.
          const rail = new THREE.Mesh(new THREE.BoxGeometry(i < 2 ? 0.08 : dw, 0.9, i < 2 ? dw : 0.08), K.deck);
          rail.position.set(box.cx + best[0] * (half[i] + dd - 0.05), y + 0.6, box.cz + best[1] * (half[i] + dd - 0.05));
          rail.rotation.y = -angle;
          group.add(rail);
        }
      }
      footprints.push({ ring, y, h: eave, cx: c[0], cz: c[1], r: Math.max(box.w, box.d) / 2 + 1 });
    }
  }
  const winMesh = new THREE.InstancedMesh(winGeo, K.glass, Math.max(1, windows.length));
  windows.forEach((m, i) => winMesh.setMatrixAt(i, m));
  winMesh.count = windows.length;
  const frameMesh = new THREE.InstancedMesh(frameGeo, K.trim, Math.max(1, frames.length));
  frames.forEach((m, i) => frameMesh.setMatrixAt(i, m));
  frameMesh.count = frames.length;
  const doorMesh = new THREE.InstancedMesh(doorGeo, K.door, Math.max(1, doors.length));
  doors.forEach((m, i) => doorMesh.setMatrixAt(i, m));
  doorMesh.count = doors.length;
  group.add(winMesh, frameMesh, doorMesh);

  return {
    group,
    footprints,
    dispose() {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      for (const s of K.siding) {
        s.m.dispose();
        disposeSurface(s.s);
      }
      for (const s of [K.shingle, K.shingleDark, K.metal, K.metalRed, K.cedar, K.cedarNew]) {
        s.m.dispose();
        disposeSurface(s.s);
      }
      for (const m of [K.trim, K.glass, K.door, K.brick, K.deck, K.concrete, K.school]) m.dispose();
    },
  };
}
