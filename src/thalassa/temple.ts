/**
 * The sanctuary: a Doric temple on the cliff island, the stair that winds up
 * to it, the arched bridge from the peninsula, two golden guardians, and the
 * small temple and stoa of the upper town.
 *
 * The temples are painted the way they were, not the way they weathered:
 * marble columns, a blue and red frieze, a blue pediment with gold at the
 * corners and a terracotta roof.
 */
import * as THREE from "three";
import { makeRng } from "@/shared/proc/rng";
import { loadCharacterRig } from "@/lib/characterRig";
import { characterUrl } from "./assets";
import { ACROPOLIS, BRIDGE, ISLE, ISLE_LEDGE, ISLE_STAIR, ISLE_TOP, heightAt, isleRadius, sIsle } from "./map";
import { Batch, box, kit, roof } from "./kit";
import type { BuildCtx, Part } from "./types";

const flat = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);

const MARBLE = "#f3ecdc";
const MARBLE_SHADE = "#e6dcc6";
const FRIEZE_BLUE = "#2f5a92";
const FRIEZE_RED = "#b8452f";
const ROOF = "#c95a30";

interface TempleSpec {
  x: number; y: number; z: number;
  /** Rotation about y; the front (pronaos) faces local -x. */
  rot: number;
  cols: number; // across the front
  rows: number; // along the side
  spacing: number;
  colH: number;
  colR: number;
}

function temple(spec: TempleSpec, b: { marble: Batch; paint: Batch; roofs: Batch; stone: Batch }, ctx: BuildCtx) {
  const { x, y, z, rot, cols, rows, spacing, colH, colR } = spec;
  const c = Math.cos(rot), s = Math.sin(rot);
  const W = (rows - 1) * spacing; // along local x
  const D = (cols - 1) * spacing; // along local z
  const L = (lx: number, lz: number): [number, number] => [x + lx * c - lz * s, z + lx * s + lz * c];
  // Stylobate: three steps.
  const stepH = 0.42;
  for (let i = 0; i < 3; i++) {
    const pad = (3 - i) * 0.75 + colR + 0.5;
    b.marble.add(box(W + pad * 2, stepH + (i === 0 ? 2 : 0), D + pad * 2), i % 2 ? MARBLE : MARBLE_SHADE, x, y + stepH * (i + 0.5) - (i === 0 ? 1 : 0), z, -rot);
  }
  const floor = y + stepH * 3;
  // The steps are walkable: each ring a little higher.
  const hw0 = W / 2 + colR + 0.5, hd0 = D / 2 + colR + 0.5;
  ctx.surfaces.push((px, pz) => {
    const dx = px - x, dz = pz - z;
    const lx = Math.abs(dx * c + dz * s), lz = Math.abs(-dx * s + dz * c);
    for (let i = 2; i >= 0; i--) {
      const pad = (2 - i) * 0.75;
      if (lx < hw0 + pad && lz < hd0 + pad) return y + stepH * (i + 1);
    }
    return null;
  });
  // Columns: fluted (many sides), tapering, with a capital.
  const colGeo = () => new THREE.CylinderGeometry(colR * 0.82, colR, colH, 20, 1);
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    if (i === 0 || i === rows - 1 || j === 0 || j === cols - 1) ring.push([-W / 2 + i * spacing, -D / 2 + j * spacing]);
  }
  // Two more in antis at the front of the cella.
  for (const [lx, lz] of ring) {
    const [wx, wz] = L(lx, lz);
    b.marble.add(colGeo(), MARBLE, wx, floor + colH / 2, wz);
    b.marble.add(new THREE.CylinderGeometry(colR * 1.2, colR * 0.85, 0.35, 20), MARBLE, wx, floor + colH + 0.17, wz);
    b.marble.add(box(colR * 2.6, 0.3, colR * 2.6, 1), MARBLE, wx, floor + colH + 0.5, wz, -rot);
    ctx.colliders.circle(wx, wz, colR + 0.05, floor - 0.5, floor + colH);
  }
  const ent = floor + colH + 0.65;
  // Architrave, frieze, cornice.
  b.marble.add(box(W + colR * 2.6, 1.0, D + colR * 2.6), MARBLE, x, ent + 0.5, z, -rot);
  const fh = 0.95;
  const fy = ent + 1.0 + fh / 2;
  b.paint.add(box(W + colR * 2.4, fh, D + colR * 2.4), FRIEZE_RED, x, fy, z, -rot);
  // Triglyphs round the frieze.
  const tg = (lx: number, lz: number, along: "x" | "z") => {
    const [wx, wz] = L(lx, lz);
    b.paint.add(along === "x" ? box(0.55, fh + 0.02, 0.12) : box(0.12, fh + 0.02, 0.55), FRIEZE_BLUE, wx, fy, wz, -rot);
  };
  const ex = W / 2 + colR * 1.2 + 0.02, ez = D / 2 + colR * 1.2 + 0.02;
  for (let t = -W / 2; t <= W / 2 + 0.01; t += spacing / 2) { tg(t, ez, "x"); tg(t, -ez, "x"); }
  for (let t = -D / 2; t <= D / 2 + 0.01; t += spacing / 2) { tg(ex, t, "z"); tg(-ex, t, "z"); }
  b.marble.add(box(W + colR * 3.2, 0.42, D + colR * 3.2), MARBLE, x, fy + fh / 2 + 0.21, z, -rot);
  b.paint.add(box(W + colR * 3.25, 0.12, D + colR * 3.25), FRIEZE_BLUE, x, fy + fh / 2 + 0.06, z, -rot);
  const top = fy + fh / 2 + 0.42;
  // Roof and pediments: a gable along local x.
  const rw = W + colR * 3.4, rd = D + colR * 3.4;
  const rise = rd * 0.2;
  b.roofs.add(roof(rw, rd, rise, 0), ROOF, x, top, z, -rot);
  // Blue tympanum just inside each gable, with gold akroteria.
  for (const side of [-1, 1]) {
    const tri = new THREE.BufferGeometry();
    const hd = rd / 2 - 0.4;
    tri.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, -hd, 0, 0, hd, 0, rise - 0.3, 0], 3));
    tri.computeVertexNormals();
    const [tx, tz] = L(side * (rw / 2 - 0.25), 0);
    const g = flat(tri);
    // Both faces.
    const back = g.clone();
    const bp = back.attributes.position as THREE.BufferAttribute;
    const tmp = [bp.getX(0), bp.getY(0), bp.getZ(0)];
    bp.setXYZ(0, bp.getX(1), bp.getY(1), bp.getZ(1));
    bp.setXYZ(1, tmp[0], tmp[1], tmp[2]);
    back.computeVertexNormals();
    b.paint.add(g, FRIEZE_BLUE, tx, top + 0.15, tz, -rot);
    b.paint.add(back, FRIEZE_BLUE, tx, top + 0.15, tz, -rot);
    const [ax, az] = L(side * (rw / 2), 0);
    b.paint.add(new THREE.ConeGeometry(0.35, 0.9, 6), "#f0bf45", ax, top + rise + 0.4, az);
  }
  // The cella: walls with a door at the front.
  const cw = W - spacing * 2.2, cd = D - spacing * 1.4;
  const ch = colH + 0.6;
  for (const side of [-1, 1]) {
    const [sx, sz] = L(0, side * cd / 2);
    b.marble.add(box(cw, ch, 0.7), MARBLE_SHADE, sx, floor + ch / 2, sz, -rot);
    ctx.colliders.box(sx, sz, cw, 0.7, rot, floor - 0.5, floor + ch);
  }
  {
    const [bx, bz] = L(cw / 2, 0);
    b.marble.add(box(0.7, ch, cd), MARBLE_SHADE, bx, floor + ch / 2, bz, -rot);
    ctx.colliders.box(bx, bz, 0.7, cd, rot, floor - 0.5, floor + ch);
    // Front wall with a doorway 3 m wide.
    const seg = (cd - 3) / 2;
    for (const side of [-1, 1]) {
      const [fx, fz] = L(-cw / 2, side * (1.5 + seg / 2));
      b.marble.add(box(0.7, ch, seg), MARBLE_SHADE, fx, floor + ch / 2, fz, -rot);
      ctx.colliders.box(fx, fz, 0.7, seg, rot, floor - 0.5, floor + ch);
    }
    const [lx, lz] = L(-cw / 2, 0);
    b.marble.add(box(0.7, ch - 5.2, 3.2), MARBLE_SHADE, lx, floor + 5.2 + (ch - 5.2) / 2, lz, -rot);
  }
  // A flat ceiling inside, warm.
  b.paint.add(box(cw, 0.2, cd), "#7a4a2e", x, floor + ch + 0.1, z, -rot);
  return { floor, front: L(-W / 2 - 3, 0), inner: L(cw / 4, 0), top };
}

export function createSanctuary(ctx: BuildCtx): Part {
  const k = kit();
  const rng = makeRng("thalassa-sanctuary");
  const r = () => rng.next();
  const group = new THREE.Group();
  group.name = "sanctuary";
  const marble = new Batch(k.marble, "sanctuary-marble");
  const stone = new Batch(k.stone, "sanctuary-stone");
  const paint = new Batch(k.paint, "sanctuary-paint");
  const roofs = new Batch(k.roof, "sanctuary-roof");
  const leaf = new Batch(k.leaf, "sanctuary-leaf");
  const batches = { marble, paint, roofs, stone };
  let cancelled = false;
  const rigs: Array<{ dispose(): void }> = [];

  /* ---- the island temple ---- */
  const isle = temple({ x: ISLE.x + 1, y: ISLE_TOP, z: ISLE.z - 3, rot: 0, cols: 6, rows: 11, spacing: 2.5, colH: 6.8, colR: 0.55 }, batches, ctx);
  // A gold statue of the god inside, seen through the door.
  const godAt = isle.inner;

  /* ---- the winding stair ---- */
  {
    const st = ISLE_STAIR;
    const n = 64;
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const a0 = st.a0 + (st.a1 - st.a0) * t0, a1 = st.a0 + (st.a1 - st.a0) * t1;
      const am = (a0 + a1) / 2;
      const R = isleRadius(am);
      const rm = R - (st.inner + st.outer) / 2;
      const x = ISLE.x + Math.cos(am) * rm, z = ISLE.z + Math.sin(am) * rm;
      const y = ISLE_LEDGE + (ISLE_TOP - ISLE_LEDGE) * t1;
      const arc = Math.abs(a1 - a0) * rm + 0.05;
      const rot = am + Math.PI / 2;
      const below = y - 2.2;
      stone.add(box(arc, y - below, st.outer - st.inner + 0.4), i % 2 ? "#e4d4b0" : "#dccaa3", x, (y + below) / 2, z, -rot);
      // Balustrade on the outer edge.
      const ro = R - st.inner + 0.35;
      const ox = ISLE.x + Math.cos(am) * ro, oz = ISLE.z + Math.sin(am) * ro;
      marble.add(box(arc, 0.95, 0.35), MARBLE_SHADE, ox, y + 0.47, oz, -rot);
      if (i % 2 === 0) ctx.colliders.box(ox, oz, arc + 0.2, 0.35, rot, y - 1.2, y + 1);
    }
    // Two columns at the foot of the stair, a pair of torches.
    for (const off of [-1, 1]) {
      const a = st.a0 + 0.06;
      const R = isleRadius(a) - (st.inner + st.outer) / 2 + off * 2.6;
      const x = ISLE.x + Math.cos(a) * R, z = ISLE.z + Math.sin(a) * R;
      const y = heightAt(x, z);
      marble.add(new THREE.CylinderGeometry(0.4, 0.45, 4.2, 16), MARBLE, x, y + 2.1, z);
      paint.add(new THREE.CylinderGeometry(0.6, 0.3, 0.5, 10), "#c9a04a", x, y + 4.45, z);
      ctx.colliders.circle(x, z, 0.45, y - 0.5, y + 4);
    }
  }

  /* ---- the bridge ---- */
  {
    const { a, b, ya, yb, width } = BRIDGE;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
    const deckAt = (t: number) => ya + (yb - ya) * t + Math.sin(t * Math.PI) * 0.9;
    // The side profile: solid to below the water, with three arches cut out.
    const shape = new THREE.Shape();
    const ext = 3.5;
    shape.moveTo(-ext, -5);
    shape.lineTo(len + ext, -5);
    shape.lineTo(len + ext, deckAt(1));
    for (let i = 40; i >= 0; i--) {
      const t = i / 40;
      shape.lineTo(t * len, deckAt(t) - 0.1);
    }
    shape.lineTo(-ext, deckAt(0));
    shape.closePath();
    const spans = 3;
    const pier = 1.8;
    const span = (len - pier * (spans - 1)) / spans;
    for (let i = 0; i < spans; i++) {
      const x0 = i * (span + pier), x1 = x0 + span;
      const rad = span / 2;
      const spring = 2.6;
      const hole = new THREE.Path();
      hole.moveTo(x0, -5.5);
      hole.lineTo(x0, spring);
      hole.absarc((x0 + x1) / 2, spring, rad, Math.PI, 0, true);
      hole.lineTo(x1, -5.5);
      hole.closePath();
      shape.holes.push(hole);
    }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: 16 });
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.5, uv.getY(i) * 0.5);
    geo.translate(0, 0, -width / 2);
    const rot = Math.atan2(uz, ux);
    stone.add(geo, "#e2cfa4", a.x, 0, a.z, -rot);
    // Parapets, and the deck to walk on.
    for (const side of [-1, 1]) {
      const n = 12;
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n, tm = (t0 + t1) / 2;
        const px = a.x + ux * len * tm - uz * side * (width / 2 - 0.25), pz = a.z + uz * len * tm + ux * side * (width / 2 - 0.25);
        const y = deckAt(tm);
        marble.add(box(len / n + 0.06, 1.0, 0.5), MARBLE_SHADE, px, y + 0.4, pz, -rot);
        ctx.colliders.box(px, pz, len / n, 0.5, rot, y - 1, y + 1.2);
      }
    }
    ctx.surfaces.push((x, z) => {
      const dx = x - a.x, dz = z - a.z;
      const t = (dx * ux + dz * uz) / len, u = -dx * uz + dz * ux;
      if (t < -0.08 || t > 1.08 || Math.abs(u) > width / 2) return null;
      return deckAt(Math.max(0, Math.min(1, t)));
    });
  }

  /* ---- the upper town: a small temple and a stoa ---- */
  {
    const ay = ACROPOLIS.y;
    temple({ x: ACROPOLIS.x - 6, y: ay, z: ACROPOLIS.z - 9, rot: Math.atan2(-14, -30) + Math.PI, cols: 4, rows: 7, spacing: 2.3, colH: 5.2, colR: 0.45 }, batches, ctx);
    // A stoa along the square's west side: a colonnade under a lean-to roof.
    const sx = ACROPOLIS.x - 22, sz = ACROPOLIS.z + 8;
    const rot = Math.PI / 2 + 0.3;
    const c = Math.cos(rot), s = Math.sin(rot);
    const len = 26;
    const L = (lx: number, lz: number): [number, number] => [sx + lx * c - lz * s, sz + lx * s + lz * c];
    const y = heightAt(sx, sz);
    marble.add(box(len + 2, 0.5, 7), MARBLE_SHADE, sx, y + 0.1, sz, -rot);
    for (let i = 0; i <= 10; i++) {
      const [wx, wz] = L(-len / 2 + i * (len / 10), 3);
      marble.add(new THREE.CylinderGeometry(0.32, 0.38, 4.2, 14), MARBLE, wx, y + 2.45, wz);
      ctx.colliders.circle(wx, wz, 0.38, y - 0.5, y + 4.4);
    }
    const [bx, bz] = L(0, -3.2);
    stone.add(box(len + 1, 5.2, 0.8), "#e4cfa4", bx, y + 2.6, bz, -rot);
    ctx.colliders.box(bx, bz, len + 1, 0.8, rot, y - 0.5, y + 5.2);
    marble.add(box(len + 1, 0.6, 7.2), MARBLE, sx, y + 4.85, sz, -rot);
    const lean = roof(len + 1.5, 8, 1.6, 0);
    roofs.add(lean, ROOF, sx, y + 5.15, sz, -rot);
    // Painted wall inside the stoa: a band of blue.
    const [px, pz] = L(0, -2.75);
    paint.add(box(len, 1.0, 0.1), FRIEZE_BLUE, px, y + 3.6, pz, -rot);
  }

  /* ---- planting on the island top ---- */
  for (let i = 0; i < 14; i++) {
    const a = r() * Math.PI * 2;
    const rr = isleRadius(a) - 11.5 - r() * 2;
    const x = ISLE.x + Math.cos(a) * rr, z = ISLE.z + Math.sin(a) * rr;
    if (ctx.colliders.blocked(x, z, 1.2, ISLE_TOP + 0.5) || sIsle(x, z) < 10.8) continue;
    // Clipped shrubs in terracotta planters.
    paint.add(new THREE.CylinderGeometry(0.7, 0.55, 0.7, 12), "#c0643a", x, ISLE_TOP + 0.35, z);
    leaf.add(new THREE.IcosahedronGeometry(0.85, 1), "#4e8a36", x, ISLE_TOP + 1.25, z);
    ctx.colliders.circle(x, z, 0.75, ISLE_TOP - 0.5, ISLE_TOP + 1.5);
  }

  const built: THREE.Mesh[] = [];
  for (const bt of [marble, stone, paint, roofs, leaf]) {
    const m = bt.build();
    if (m) { group.add(m); built.push(m); }
  }

  /* ---- gold: guardians at the head of the stair, the god inside ---- */
  const gold = k.gold;
  const plinth = (x: number, z: number, y: number, h: number) => {
    const p = new THREE.Mesh(box(1.8, h, 1.8, 2), k.marble);
    p.geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Array(p.geometry.attributes.position.count * 3).fill(0.95), 3));
    p.position.set(x, y + h / 2, z);
    p.castShadow = true; p.receiveShadow = true;
    group.add(p);
    built.push(p);
    ctx.colliders.box(x, z, 1.8, 1.8, 0, y - 0.5, y + h);
  };
  const statue = (id: string, x: number, z: number, y: number, height: number, faceX: number, faceZ: number) => {
    const url = characterUrl(id);
    if (!url) return;
    loadCharacterRig({ url, id }, { height }).then((rig) => {
      if (cancelled) { rig.dispose(); return; }
      rig.object.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) { m.material = gold; m.castShadow = true; }
      });
      // A pose, held: a moment of the idle, then frozen.
      rig.update(0.4);
      const holder = new THREE.Group();
      holder.add(rig.object);
      holder.position.set(x, y, z);
      holder.rotation.y = Math.atan2(faceX - x, faceZ - z);
      group.add(holder);
      rigs.push(rig);
    }).catch(() => undefined);
  };
  {
    const top = ISLE_TOP;
    const a = ISLE_STAIR.a1 - 0.08;
    const R = isleRadius(a) - 13.5;
    for (const [off, id] of [[-0.24, "Knight_Golden_Male"], [0.24, "Knight_Golden_Female"]] as const) {
      const x = ISLE.x + Math.cos(a + off) * R, z = ISLE.z + Math.sin(a + off) * R;
      plinth(x, z, top, 1.6);
      statue(id, x, z, top + 1.6, 3.6, x + Math.cos(a) * 20, z + Math.sin(a) * 20);
    }
    const [gx, gz] = godAt;
    plinth(gx, gz, isle.floor, 1.2);
    statue("Knight_Golden_Male", gx, gz, isle.floor + 1.2, 4.6, gx - 30, gz);
  }

  return {
    group,
    dispose() {
      cancelled = true;
      for (const rg of rigs) rg.dispose();
      for (const m of built) m.geometry.dispose();
      k.dispose();
    },
  };
}
